//! エンジンの実行ファイル(外部バイナリ)の起動。時間切れで子プロセスを終わらせ、stdout/stderr は別スレッドで最後まで読む。

use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use wait_timeout::ChildExt;

use crate::app_error::{AppError, AppResult};
use crate::models::EngineRegistration;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const HEALTHCHECK_TIMEOUT: Duration = Duration::from_secs(5);
/// 取り消しの指示を確かめる間隔。
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(50);

pub(super) struct TimedOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

pub(super) fn hide_command_window(command: &mut Command) -> &mut Command {
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
}

/// パイプを別スレッドで最後まで読み、読み終えたら中身を送る。
fn spawn_reader(mut handle: impl Read + Send + 'static) -> Receiver<Vec<u8>> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = handle.read_to_end(&mut buffer);
        let _ = sender.send(buffer);
    });
    receiver
}

/// 子プロセスとそこから起動された孫プロセスをまとめて終わらせるための Windows のジョブ。
/// 落とす(ハンドルを閉じる)と、中に残ったプロセスもすべて終わる(`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`)。
/// 子は停止した状態で起動し(`CREATE_SUSPENDED`)、ジョブに入れてから動かすので、孫は必ずジョブに入る。
#[cfg(target_os = "windows")]
mod job {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    type Handle = *mut c_void;

    pub(super) const CREATE_SUSPENDED: u32 = 0x0000_0004;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const TH32CS_SNAPTHREAD: u32 = 0x0000_0004;
    const THREAD_SUSPEND_RESUME: u32 = 0x0002;
    const INVALID_HANDLE_VALUE: Handle = -1_isize as Handle;
    /// `JobObjectExtendedLimitInformation`
    const EXTENDED_LIMIT_INFORMATION: i32 = 9;

    /// `JOBOBJECT_BASIC_LIMIT_INFORMATION`
    #[repr(C)]
    #[derive(Default)]
    struct BasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    /// `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`(`IoInfo` は `IO_COUNTERS` の 6 つの 64 ビット値)
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimitInformation {
        basic: BasicLimitInformation,
        io_info: [u64; 6],
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    /// `THREADENTRY32`
    #[repr(C)]
    #[derive(Default)]
    struct ThreadEntry32 {
        size: u32,
        usage: u32,
        thread_id: u32,
        owner_process_id: u32,
        base_priority: i32,
        delta_priority: i32,
        flags: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, info: *const c_void, length: u32)
            -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn TerminateJobObject(job: Handle, exit_code: u32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> Handle;
        fn Thread32First(snapshot: Handle, entry: *mut ThreadEntry32) -> i32;
        fn Thread32Next(snapshot: Handle, entry: *mut ThreadEntry32) -> i32;
        fn OpenThread(access: u32, inherit: i32, thread_id: u32) -> Handle;
        fn ResumeThread(thread: Handle) -> u32;
    }

    /// 停止した状態で起動した子のスレッドを動かす。1 本も動かせなければ `false`。
    pub(super) fn resume(child: &Child) -> bool {
        let process_id = child.id();
        // SAFETY: スナップショットとスレッドのハンドルは、ここで開いてここで閉じる。
        // `entry` は `size` を設定した有効な `THREADENTRY32`。
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return false;
            }
            let mut resumed = false;
            let mut entry = ThreadEntry32 {
                size: std::mem::size_of::<ThreadEntry32>() as u32,
                ..Default::default()
            };
            let mut more = Thread32First(snapshot, &mut entry) != 0;
            while more {
                if entry.owner_process_id == process_id {
                    let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.thread_id);
                    if !thread.is_null() {
                        resumed |= ResumeThread(thread) != u32::MAX;
                        CloseHandle(thread);
                    }
                }
                entry.size = std::mem::size_of::<ThreadEntry32>() as u32;
                more = Thread32Next(snapshot, &mut entry) != 0;
            }
            CloseHandle(snapshot);
            resumed
        }
    }

    pub(super) struct Job(Handle);

    impl Job {
        /// ジョブを作って子を入れる。できなければ `None`(呼び出し側は子を動かさずに終わらせる)。
        pub(super) fn attach(child: &Child) -> Option<Self> {
            // SAFETY: 引数はすべて有効なポインタか null。戻り値のハンドルは `Job` が持ち、落とすときに閉じる。
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
                if handle.is_null() {
                    return None;
                }
                let job = Self(handle);
                let mut info = ExtendedLimitInformation::default();
                info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let configured = SetInformationJobObject(
                    job.0,
                    EXTENDED_LIMIT_INFORMATION,
                    (&info as *const ExtendedLimitInformation).cast(),
                    std::mem::size_of::<ExtendedLimitInformation>() as u32,
                ) != 0;
                let assigned =
                    configured && AssignProcessToJobObject(job.0, child.as_raw_handle()) != 0;
                assigned.then_some(job)
            }
        }

        /// 中のプロセスをすべて終わらせる。
        pub(super) fn terminate(&self) {
            // SAFETY: `self.0` は `attach` で作った有効なジョブのハンドル。
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: `self.0` は有効なハンドルで、ここで 1 回だけ閉じる。
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// 子プロセスを終わらせる(ジョブに入っていれば孫プロセスごと)。
fn kill_tree(child: &mut Child, #[allow(unused_variables)] job: &ChildJob) {
    #[cfg(target_os = "windows")]
    if let Some(job) = job {
        job.terminate();
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(target_os = "windows")]
type ChildJob = Option<job::Job>;
#[cfg(not(target_os = "windows"))]
type ChildJob = ();

/// 停止した状態で起動した子をジョブに入れてから動かす。できなければ子を終わらせてエラーにする
/// (孫プロセスを終わらせられないまま動かさない)。
fn start_in_job(child: &mut Child) -> AppResult<ChildJob> {
    #[cfg(target_os = "windows")]
    {
        let fail = |child: &mut Child| {
            let _ = child.kill();
            let _ = child.wait();
            AppError::Message(
                "AI エンジンを起動できませんでした(子プロセスをまとめて管理できません)。".into(),
            )
        };
        let Some(job) = job::Job::attach(child) else {
            return Err(fail(child));
        };
        if !job::resume(child) {
            job.terminate();
            return Err(fail(child));
        }
        Ok(Some(job))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = child;
        Ok(())
    }
}

/// コマンドを起動し、`timeout` を過ぎたら終わらせて `AppError::Timeout` を返す。
pub(super) fn run_command_with_timeout(
    command: &mut Command,
    timeout: Duration,
    timeout_message: &str,
) -> AppResult<TimedOutput> {
    let never = AtomicBool::new(false);
    run_command_cancellable(command, timeout, timeout_message, &never)?
        .ok_or_else(|| AppError::Internal("取り消していない実行が取り消されました。".into()))
}

/// コマンドを起動し、`timeout` を過ぎたら終わらせて `AppError::Timeout` を返す。
/// `cancel` が立ったら子プロセスを孫ごと終わらせて `Ok(None)` を返す(確かめる間隔は `CANCEL_POLL_INTERVAL`)。
/// パイプが詰まって子が止まらないよう、stdout/stderr は起動直後から別スレッドで読み切る。
/// 子が終わっても孫プロセスがパイプを握っていると読み取りが終わらないので、読み切りを待つのも同じ期限までにし、
/// その間も取り消しを確かめる。期限を過ぎた・取り消した読み取りスレッドは待たずに手放す(パイプが閉じれば自分で終わる)。
pub(super) fn run_command_cancellable(
    command: &mut Command,
    timeout: Duration,
    timeout_message: &str,
    cancel: &AtomicBool,
) -> AppResult<Option<TimedOutput>> {
    let deadline = Instant::now() + timeout;
    if cancel.load(Ordering::SeqCst) {
        return Ok(None);
    }
    // 子は止めた状態で起動し、ジョブに入れてから動かす(ウィンドウを出さない指定もここで付け直す)。
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW | job::CREATE_SUSPENDED);
    let mut child = command.spawn()?;
    // 関数を抜けるとき(成否・取り消しに関わらず)ジョブが落ち、残った孫プロセスも終わる。
    let job = start_in_job(&mut child)?;
    let stdout_reader = child.stdout.take().map(spawn_reader);
    let stderr_reader = child.stderr.take().map(spawn_reader);
    let status = loop {
        if cancel.load(Ordering::SeqCst) {
            kill_tree(&mut child, &job);
            return Ok(None);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            kill_tree(&mut child, &job);
            return Err(AppError::Timeout(timeout_message.into()));
        }
        if let Some(status) = child.wait_timeout(remaining.min(CANCEL_POLL_INTERVAL))? {
            break status;
        }
    };

    // 読み切りを待つ。取り消されたら `Ok(None)`。
    let collect = |reader: Option<Receiver<Vec<u8>>>| -> AppResult<Option<Vec<u8>>> {
        let Some(reader) = reader else {
            return Ok(Some(Vec::new()));
        };
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Ok(None);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(AppError::Timeout(timeout_message.into()));
            }
            match reader.recv_timeout(remaining.min(CANCEL_POLL_INTERVAL)) {
                Ok(buffer) => return Ok(Some(buffer)),
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => return Ok(Some(Vec::new())),
            }
        }
    };
    let Some(stdout) = collect(stdout_reader)? else {
        return Ok(None);
    };
    let Some(stderr) = collect(stderr_reader)? else {
        return Ok(None);
    };
    drop(job);

    Ok(Some(TimedOutput {
        status,
        stdout,
        stderr,
    }))
}

/// 登録された実行ファイルを `-h` で起動し、応答があるかを確かめる。
pub(super) fn run_healthcheck(registration: &EngineRegistration) -> AppResult<()> {
    let executable_path = PathBuf::from(&registration.executable_path);
    if !executable_path.is_file() {
        return Err(AppError::Message(
            "AI エンジン実行ファイルが存在しません。".into(),
        ));
    }

    let model_path = PathBuf::from(&registration.model_path);
    if !model_path.exists() {
        return Err(AppError::Message(
            "AI エンジンのモデルパスが存在しません。".into(),
        ));
    }

    let mut command = Command::new(&executable_path);
    hide_command_window(&mut command)
        .arg("-h")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = run_command_with_timeout(
        &mut command,
        HEALTHCHECK_TIMEOUT,
        "AI エンジンのヘルスチェックがタイムアウトしました。",
    )?;

    if !output.status.success() && output.stdout.is_empty() && output.stderr.is_empty() {
        return Err(AppError::Message(
            "AI エンジンのヘルスチェック出力が空でした。".into(),
        ));
    }

    Ok(())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    fn cmd(script: &str) -> Command {
        let mut command = Command::new("cmd");
        hide_command_window(&mut command)
            .args(["/D", "/C", script])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    #[test]
    fn captures_stdout_and_stderr() {
        let output = run_command_with_timeout(
            &mut cmd("echo out& echo err 1>&2& exit 3"),
            Duration::from_secs(20),
            "時間切れ",
        )
        .unwrap();
        assert_eq!(output.status.code(), Some(3));
        assert!(String::from_utf8_lossy(&output.stdout).contains("out"));
        assert!(String::from_utf8_lossy(&output.stderr).contains("err"));
    }

    /// 時間切れでは待ち続けずに Timeout を返す。孫プロセス(ping)がパイプを握っていても戻る。
    #[test]
    fn times_out_without_waiting_for_pipes() {
        let started = Instant::now();
        let result = run_command_with_timeout(
            &mut cmd("ping -n 30 127.0.0.1"),
            Duration::from_millis(500),
            "時間切れ",
        );
        assert!(matches!(result, Err(AppError::Timeout(_))));
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    /// 子がすぐ終わっても、残った孫プロセス(start /b の ping)がパイプを握っている間は期限までしか待たない。
    #[test]
    fn times_out_when_grandchild_holds_pipes() {
        let started = Instant::now();
        let result = run_command_with_timeout(
            &mut cmd("start /b ping -n 30 127.0.0.1 & exit 0"),
            Duration::from_millis(1500),
            "時間切れ",
        );
        assert!(
            matches!(result, Err(AppError::Timeout(_))),
            "{:?}",
            result.err()
        );
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    /// 取り消しの指示が立つと、期限を待たずに子プロセスを終わらせて `None` を返す。
    #[test]
    fn cancel_kills_the_child() {
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        let setter = thread::spawn(move || {
            thread::sleep(Duration::from_millis(300));
            flag.store(true, Ordering::SeqCst);
        });
        let started = Instant::now();
        let result = run_command_cancellable(
            &mut cmd("ping -n 30 127.0.0.1"),
            Duration::from_secs(60),
            "時間切れ",
            &cancel,
        );
        setter.join().unwrap();
        assert!(matches!(result, Ok(None)), "{:?}", result.err());
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    /// 取り消すと、子から起動された孫プロセスも終わる(孫が後で書くはずの印が現れない)。
    #[test]
    fn cancel_kills_grandchildren() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("marker.txt");
        // 孫: 2 秒ほど待ってから印を書く。
        std::fs::write(
            dir.path().join("child.cmd"),
            "@echo off
ping -n 3 127.0.0.1 > nul
echo late > marker.txt
",
        )
        .unwrap();
        let mut command = cmd("start /b child.cmd & ping -n 30 127.0.0.1 > nul");
        command.current_dir(dir.path());
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        let setter = thread::spawn(move || {
            thread::sleep(Duration::from_millis(500));
            flag.store(true, Ordering::SeqCst);
        });
        let result =
            run_command_cancellable(&mut command, Duration::from_secs(60), "時間切れ", &cancel);
        setter.join().unwrap();
        assert!(matches!(result, Ok(None)), "{:?}", result.err());
        // 孫が生きていれば 2 秒ほどで印を書く。
        thread::sleep(Duration::from_secs(4));
        assert!(!marker.exists());
    }

    /// 子が終わったあと、孫がパイプを握って読み切りを待っている間も取り消しが効く。
    #[test]
    fn cancel_works_while_waiting_for_pipes() {
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        let setter = thread::spawn(move || {
            thread::sleep(Duration::from_millis(500));
            flag.store(true, Ordering::SeqCst);
        });
        let started = Instant::now();
        let result = run_command_cancellable(
            &mut cmd("start /b ping -n 30 127.0.0.1 & exit 0"),
            Duration::from_secs(60),
            "時間切れ",
            &cancel,
        );
        setter.join().unwrap();
        assert!(matches!(result, Ok(None)), "{:?}", result.err());
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn healthcheck_rejects_missing_executable() {
        let dir = tempfile::tempdir().unwrap();
        let registration = EngineRegistration {
            executable_path: dir.path().join("none.exe").to_string_lossy().to_string(),
            model_name: None,
            model_path: dir.path().to_string_lossy().to_string(),
            registered_at: 0,
            source: "manual".into(),
        };
        assert!(run_healthcheck(&registration).is_err());
    }
}
