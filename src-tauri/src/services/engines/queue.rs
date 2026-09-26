//! 超解像ジョブの優先度付きキュー。ジョブは裏のスレッド 1 本で 1 つずつ実行する。
//! 優先度は 表示中 > 先読み > 一括。同じ優先度の中では要求された順に処理する。
//! ビューアからの要求(`request_pages`)は、その本の表示中・先読みの顔ぶれを置き換える。
//! 新しい顔ぶれに入らないジョブ(大きく移動した・別の本を開いた)は取り消し、実行中なら子プロセスを終わらせる。
//! 一括にも含まれるジョブを表示中でないまま実行しているときに表示中のページが要求されたら、
//! そのジョブを打ち切って一括の列の先頭へ積み直し(先読みにも残るなら先読みとして積み)、表示中のページを先に処理する。
//! 実行中のジョブの優先度は要求のたびに今の所属で付け直すので、表示中・先読みから外れた一括のジョブは一括として扱う。

use std::collections::HashMap;
use std::panic::{self, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};

use super::cache::EnhanceParams;

/// ジョブの優先度。値の小さいほうが先に処理される。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Priority {
    Visible = 0,
    Prefetch = 1,
    Batch = 2,
}

/// 1 ページ分の超解像の指示。`key` は `cache::cache_key(&params)` の値。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobSpec {
    pub book_id: String,
    pub index: usize,
    pub key: String,
    pub params: EnhanceParams,
}

impl JobSpec {
    fn same_target(&self, book_id: &str, index: usize, key: &str) -> bool {
        self.book_id == book_id && self.index == index && self.key == key
    }
}

/// ジョブの状態の変化。フロントへのイベントの元になる。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobState {
    Queued,
    Running,
    Done,
    Failed(String),
    Cancelled,
}

/// 実行の結果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobOutcome {
    Done,
    Failed(String),
    Cancelled,
}

/// ジョブを実際に処理するもの。本番はエンジンの子プロセスを起動し、テストは偽物を渡す。
/// `cancel` が立ったら処理を打ち切って `Cancelled` を返す。
pub trait JobExecutor: Send + Sync + 'static {
    fn run(&self, job: &JobSpec, cancel: &AtomicBool) -> JobOutcome;
}

/// 状態の変化の知らせ先。状態を変えたのと同じ排他の中から呼ぶので、知らせは起きた順に届く。
/// 中からキューを呼ばないこと(排他を取り直して止まる)。
pub type Notifier = Box<dyn Fn(&JobSpec, &JobState) + Send + Sync + 'static>;

struct Pending {
    spec: JobSpec,
    priority: Priority,
    /// 一括事前処理にも含まれるか。表示中・先読みから外れても一括の優先度で残す。
    batch: bool,
    seq: u64,
}

struct Running {
    spec: JobSpec,
    priority: Priority,
    batch: bool,
    seq: u64,
    cancel: Arc<AtomicBool>,
    /// 表示中のページに譲るために打ち切った。取り消しで終わったら一括のジョブとして積み直す。
    requeue: bool,
}

#[derive(Default)]
struct State {
    pending: Vec<Pending>,
    running: Option<Running>,
    next_seq: u64,
    /// 最後に受け付けた表示中・先読みの要求の受付番号。これ以前に取った番号の要求は古いので捨てる。
    last_view_ticket: u64,
    /// 本ごとの、最後に取り消した時点の番号。これ以前に取った番号の要求は、閉じた本への遅れた要求なので捨てる。
    cancelled_at: HashMap<String, u64>,
    shutdown: bool,
}

impl State {
    fn next_seq(&mut self) -> u64 {
        self.next_seq += 1;
        self.next_seq
    }

    fn cancelled_after(&self, book_id: &str, ticket: u64) -> bool {
        self.cancelled_at
            .get(book_id)
            .is_some_and(|cancelled| *cancelled >= ticket)
    }

    /// 同じページの実行中のジョブ(取り消し済みでないもの)。
    fn live_running(&mut self, book_id: &str, index: usize, key: &str) -> Option<&mut Running> {
        self.running.as_mut().filter(|running| {
            running.spec.same_target(book_id, index, key) && !running.cancel.load(Ordering::SeqCst)
        })
    }

    /// 最も先に処理するジョブを取り出す。
    fn take_next(&mut self) -> Option<Pending> {
        let position = self
            .pending
            .iter()
            .enumerate()
            .min_by_key(|(_, job)| (job.priority, job.seq))
            .map(|(position, _)| position)?;
        Some(self.pending.remove(position))
    }
}

struct Shared {
    state: Mutex<State>,
    wake: Condvar,
    executor: Box<dyn JobExecutor>,
    notify: Notifier,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// 超解像ジョブのキュー。作ると裏のスレッドが 1 本立ち、`shutdown` か落とすと止まる(実行中のジョブは取り消す)。
pub struct EnhanceQueue {
    shared: Arc<Shared>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl EnhanceQueue {
    pub fn start(executor: impl JobExecutor, notify: Notifier) -> Self {
        let shared = Arc::new(Shared {
            state: Mutex::new(State::default()),
            wake: Condvar::new(),
            executor: Box::new(executor),
            notify,
        });
        let worker_shared = shared.clone();
        let worker = thread::Builder::new()
            .name("enhance-queue".into())
            .spawn(move || work(&worker_shared))
            .ok();
        if worker.is_none() {
            log::error!("超解像キューのスレッドを起動できませんでした。");
        }
        Self {
            shared,
            worker: Mutex::new(worker),
        }
    }

    /// 待っているジョブを捨て、実行中のジョブを取り消して、裏のスレッドが終わるのを待つ(アプリの終了時)。
    pub fn shutdown(&self) {
        {
            let mut state = self.shared.lock();
            state.shutdown = true;
            state.pending.clear();
            if let Some(running) = &state.running {
                running.cancel.store(true, Ordering::SeqCst);
            }
        }
        self.shared.wake.notify_all();
        let worker = self
            .worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(worker) = worker {
            let _ = worker.join();
        }
    }

    /// 要求の受付番号を取る。要求の下調べ(ファイルの確認など)を始める前に取り、`request_pages` などに渡す。
    /// 下調べの間に本が閉じられた・新しい要求が来た場合、その要求は捨てられる。
    pub fn ticket(&self) -> u64 {
        self.shared.lock().next_seq()
    }

    /// 本の表示中・先読みのページを要求する(並びの順に処理する)。
    /// この本のほかのページと、ほかの本の表示中・先読みのジョブは取り消す(一括のジョブは一括の優先度で残す)。
    /// `ticket` より後に受け付けた要求があるか、本が取り消されていれば何もせず `false` を返す。
    pub fn request_pages(
        &self,
        ticket: u64,
        book_id: &str,
        key: &str,
        params: &EnhanceParams,
        visible: &[usize],
        prefetch: &[usize],
    ) -> bool {
        let wanted: Vec<(usize, Priority)> = visible
            .iter()
            .map(|index| (*index, Priority::Visible))
            .chain(prefetch.iter().map(|index| (*index, Priority::Prefetch)))
            .collect();
        let is_wanted = |spec: &JobSpec| {
            spec.book_id == book_id
                && spec.key == key
                && wanted.iter().any(|(index, _)| *index == spec.index)
        };

        let mut events = Vec::new();
        {
            let mut state = self.shared.lock();
            if state.shutdown
                || ticket <= state.last_view_ticket
                || state.cancelled_after(book_id, ticket)
            {
                return false;
            }
            state.last_view_ticket = ticket;

            // 要らなくなった表示中・先読みのジョブを外す(一括にも含まれるものは一括へ戻す)。
            let mut kept = Vec::with_capacity(state.pending.len());
            for mut job in std::mem::take(&mut state.pending) {
                if job.priority == Priority::Batch || is_wanted(&job.spec) {
                    kept.push(job);
                } else if job.batch {
                    job.priority = Priority::Batch;
                    kept.push(job);
                } else {
                    events.push((job.spec, JobState::Cancelled));
                }
            }
            state.pending = kept;

            // 実行中のジョブの優先度を、新しい顔ぶれでの所属に付け直す(前の要求での優先度を持ち越さない)。
            if let Some(running) = state
                .running
                .as_mut()
                .filter(|running| !running.cancel.load(Ordering::SeqCst))
            {
                let requested = wanted
                    .iter()
                    .find(|(index, _)| is_wanted(&running.spec) && *index == running.spec.index)
                    .map(|(_, priority)| *priority);
                match requested {
                    Some(priority) => running.priority = priority,
                    None if running.batch => running.priority = Priority::Batch,
                    None => running.cancel.store(true, Ordering::SeqCst),
                }
                if running.batch && running.priority != Priority::Visible && !visible.is_empty() {
                    // 表示中のページを待たせない。一括にも含まれるジョブは打ち切って積み直す
                    // (先読みにも残るページは、下で先読みのジョブとして積む)。
                    running.requeue = true;
                    running.cancel.store(true, Ordering::SeqCst);
                }
            }

            let mut seen = Vec::new();
            for (index, priority) in &wanted {
                if seen.contains(index) {
                    continue;
                }
                seen.push(*index);
                // 取り消し済みの実行は終わるのを待たず、新しいジョブとして積み直す。
                if state.live_running(book_id, *index, key).is_some() {
                    continue;
                }
                let seq = state.next_seq();
                if let Some(job) = state
                    .pending
                    .iter_mut()
                    .find(|job| job.spec.same_target(book_id, *index, key))
                {
                    job.priority = *priority;
                    job.seq = seq;
                    continue;
                }
                let spec = JobSpec {
                    book_id: book_id.to_string(),
                    index: *index,
                    key: key.to_string(),
                    params: params.clone(),
                };
                events.push((spec.clone(), JobState::Queued));
                state.pending.push(Pending {
                    spec,
                    priority: *priority,
                    batch: false,
                    seq,
                });
            }
            self.emit(&events);
        }
        self.shared.wake.notify_all();
        true
    }

    /// 一括事前処理のジョブを積む。すでに積まれているページは一括にも含める印だけを付ける。
    /// 本が `ticket` の後に取り消されていれば何もせず `false` を返す。
    pub fn enqueue_batch(
        &self,
        ticket: u64,
        book_id: &str,
        key: &str,
        params: &EnhanceParams,
        indices: &[usize],
    ) -> bool {
        let mut events = Vec::new();
        {
            let mut state = self.shared.lock();
            if state.shutdown || state.cancelled_after(book_id, ticket) {
                return false;
            }
            for index in indices {
                if let Some(running) = state.live_running(book_id, *index, key) {
                    running.batch = true;
                    continue;
                }
                if let Some(job) = state
                    .pending
                    .iter_mut()
                    .find(|job| job.spec.same_target(book_id, *index, key))
                {
                    job.batch = true;
                    continue;
                }
                let seq = state.next_seq();
                let spec = JobSpec {
                    book_id: book_id.to_string(),
                    index: *index,
                    key: key.to_string(),
                    params: params.clone(),
                };
                events.push((spec.clone(), JobState::Queued));
                state.pending.push(Pending {
                    spec,
                    priority: Priority::Batch,
                    batch: true,
                    seq,
                });
            }
            self.emit(&events);
        }
        self.shared.wake.notify_all();
        true
    }

    /// 本の一括事前処理をやめる。一括だけのジョブは取り消し(実行中なら子プロセスを終わらせる)、
    /// 表示中・先読みのジョブは一括の印だけを外して残す。
    pub fn cancel_batch(&self, book_id: &str) {
        let mut events = Vec::new();
        {
            let mut state = self.shared.lock();
            let mut kept = Vec::with_capacity(state.pending.len());
            for mut job in std::mem::take(&mut state.pending) {
                if job.spec.book_id != book_id {
                    kept.push(job);
                } else if job.priority == Priority::Batch {
                    events.push((job.spec, JobState::Cancelled));
                } else {
                    job.batch = false;
                    kept.push(job);
                }
            }
            state.pending = kept;
            if let Some(running) = state.running.as_mut() {
                if running.spec.book_id == book_id {
                    // 表示中のページに譲って打ち切ったジョブも、一括の列へは戻さない。
                    running.batch = false;
                    running.requeue = false;
                    if running.priority == Priority::Batch {
                        running.cancel.store(true, Ordering::SeqCst);
                    }
                }
            }
            self.emit(&events);
        }
    }

    /// 本のジョブをすべて取り消す(本を閉じたとき)。実行中なら子プロセスを終わらせる。
    /// これより前に取った受付番号の要求は、後から届いても受け付けない。
    pub fn cancel_book(&self, book_id: &str) {
        let mut events = Vec::new();
        {
            let mut state = self.shared.lock();
            let now = state.next_seq();
            state.cancelled_at.insert(book_id.to_string(), now);
            let (cancelled, kept): (Vec<Pending>, Vec<Pending>) =
                std::mem::take(&mut state.pending)
                    .into_iter()
                    .partition(|job| job.spec.book_id == book_id);
            state.pending = kept;
            events.extend(
                cancelled
                    .into_iter()
                    .map(|job| (job.spec, JobState::Cancelled)),
            );
            if let Some(running) = state.running.as_mut() {
                if running.spec.book_id == book_id {
                    running.requeue = false;
                    running.cancel.store(true, Ordering::SeqCst);
                }
            }
            self.emit(&events);
        }
    }

    /// 排他の中から呼ぶ。
    fn emit(&self, events: &[(JobSpec, JobState)]) {
        for (spec, state) in events {
            (self.shared.notify)(spec, state);
        }
    }

    /// 待っているジョブを処理する順に返す(テスト用)。
    #[cfg(test)]
    fn pending_order(&self) -> Vec<(usize, Priority)> {
        let state = self.shared.lock();
        let mut jobs: Vec<&Pending> = state.pending.iter().collect();
        jobs.sort_by_key(|job| (job.priority, job.seq));
        jobs.iter()
            .map(|job| (job.spec.index, job.priority))
            .collect()
    }
}

impl Drop for EnhanceQueue {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// 裏のスレッドの本体。ジョブを 1 つずつ取り出して実行する。
fn work(shared: &Shared) {
    loop {
        let (spec, cancel) = {
            let mut state = shared.lock();
            let job = loop {
                if state.shutdown {
                    return;
                }
                if let Some(job) = state.take_next() {
                    break job;
                }
                state = shared
                    .wake
                    .wait(state)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            };
            let cancel = Arc::new(AtomicBool::new(false));
            state.running = Some(Running {
                spec: job.spec.clone(),
                priority: job.priority,
                batch: job.batch,
                seq: job.seq,
                cancel: cancel.clone(),
                requeue: false,
            });
            (shared.notify)(&job.spec, &JobState::Running);
            (job.spec, cancel)
        };

        // 実行が panic してもキューを止めず、そのジョブの失敗として扱う。
        let outcome = panic::catch_unwind(AssertUnwindSafe(|| shared.executor.run(&spec, &cancel)))
            .unwrap_or_else(|_| JobOutcome::Failed("超解像の処理が異常終了しました。".into()));
        let state = match outcome {
            JobOutcome::Done => JobState::Done,
            JobOutcome::Failed(message) => JobState::Failed(message),
            JobOutcome::Cancelled => JobState::Cancelled,
        };
        let mut guard = shared.lock();
        let running = guard.running.take();
        if state == JobState::Cancelled && !guard.shutdown {
            if let Some(running) = running.filter(|running| running.requeue) {
                // 表示中のページに譲ったジョブ。元の順番のまま一括の列へ戻す。
                requeue_batch(&mut guard, running);
                (shared.notify)(&spec, &JobState::Queued);
                continue;
            }
        }
        (shared.notify)(&spec, &state);
        drop(guard);
    }
}

/// 打ち切ったジョブを一括の列へ戻す。同じページがもう積まれていれば一括の印を付けるだけにする。
fn requeue_batch(state: &mut State, running: Running) {
    if let Some(job) = state.pending.iter_mut().find(|job| {
        job.spec
            .same_target(&running.spec.book_id, running.spec.index, &running.spec.key)
    }) {
        job.batch = true;
        return;
    }
    state.pending.push(Pending {
        spec: running.spec,
        priority: Priority::Batch,
        batch: true,
        seq: running.seq,
    });
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::{self, Receiver, Sender};
    use std::time::Duration;

    use super::*;
    use crate::models::EngineId;

    const BOOK: &str = "0123456789abcdef";
    const OTHER: &str = "fedcba9876543210";
    const KEY: &str = "real-cugan-x2";
    const WAIT: Duration = Duration::from_secs(10);

    fn params() -> EnhanceParams {
        EnhanceParams {
            engine: EngineId::RealCugan,
            model: "models-se".into(),
            scale: 2,
            denoise: Some(-1),
        }
    }

    /// 始まったジョブを知らせ、`release` が届くか取り消されるまで終わらない偽の実行。
    struct GateExecutor {
        started: Mutex<Sender<(String, usize)>>,
        release: Mutex<Receiver<()>>,
        /// 取り消しに `release` が届くまで気づかない(子プロセスの終了を待つ間を再現する)。
        slow_cancel: bool,
    }

    impl JobExecutor for GateExecutor {
        fn run(&self, job: &JobSpec, cancel: &AtomicBool) -> JobOutcome {
            let _ = self
                .started
                .lock()
                .unwrap()
                .send((job.book_id.clone(), job.index));
            let release = self.release.lock().unwrap();
            loop {
                if !self.slow_cancel && cancel.load(Ordering::SeqCst) {
                    return JobOutcome::Cancelled;
                }
                if release.recv_timeout(Duration::from_millis(10)).is_ok() {
                    return if cancel.load(Ordering::SeqCst) {
                        JobOutcome::Cancelled
                    } else {
                        JobOutcome::Done
                    };
                }
            }
        }
    }

    struct Harness {
        queue: EnhanceQueue,
        started: Receiver<(String, usize)>,
        release: Sender<()>,
        events: Receiver<(String, usize, JobState)>,
        /// 受け取ったが、まだ待たれていないイベント(届く順は前後しうる)。
        seen: std::cell::RefCell<Vec<(String, usize, JobState)>>,
    }

    fn harness() -> Harness {
        harness_with(false)
    }

    fn harness_with(slow_cancel: bool) -> Harness {
        let (started_tx, started) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let (events_tx, events) = mpsc::channel();
        let events_tx = Mutex::new(events_tx);
        let queue = EnhanceQueue::start(
            GateExecutor {
                started: Mutex::new(started_tx),
                release: Mutex::new(release_rx),
                slow_cancel,
            },
            Box::new(move |spec, state| {
                let _ = events_tx.lock().unwrap().send((
                    spec.book_id.clone(),
                    spec.index,
                    state.clone(),
                ));
            }),
        );
        Harness {
            queue,
            started,
            release,
            events,
            seen: Default::default(),
        }
    }

    impl Harness {
        fn request(
            &self,
            book: &str,
            key: &str,
            params: &EnhanceParams,
            visible: &[usize],
            prefetch: &[usize],
        ) -> bool {
            let ticket = self.queue.ticket();
            self.queue
                .request_pages(ticket, book, key, params, visible, prefetch)
        }

        fn batch(&self, book: &str, key: &str, params: &EnhanceParams, indices: &[usize]) -> bool {
            let ticket = self.queue.ticket();
            self.queue.enqueue_batch(ticket, book, key, params, indices)
        }

        fn next_started(&self) -> (String, usize) {
            self.started.recv_timeout(WAIT).expect("ジョブが始まらない")
        }

        /// 条件に合うイベントが来るまで待つ(先に届いていればすぐ戻る)。
        fn wait_event(&self, book: &str, index: usize, state: JobState) {
            let target = (book.to_string(), index, state);
            let mut seen = self.seen.borrow_mut();
            if let Some(position) = seen.iter().position(|event| *event == target) {
                seen.remove(position);
                return;
            }
            loop {
                let event = self.events.recv_timeout(WAIT).expect("イベントが来ない");
                if event == target {
                    return;
                }
                seen.push(event);
            }
        }
    }

    #[test]
    fn runs_visible_then_prefetch_then_batch_one_at_a_time() {
        let h = harness();
        // 最初のジョブ(表示中の 3)を実行中にして、残りを積む。
        h.request(BOOK, KEY, &params(), &[3], &[]);
        assert_eq!(h.next_started(), (BOOK.into(), 3));
        h.batch(BOOK, KEY, &params(), &[11, 12]);
        h.request(BOOK, KEY, &params(), &[3, 4], &[5, 6]);
        assert_eq!(
            h.queue.pending_order(),
            vec![
                (4, Priority::Visible),
                (5, Priority::Prefetch),
                (6, Priority::Prefetch),
                (11, Priority::Batch),
                (12, Priority::Batch),
            ]
        );
        // 1 本ずつ: 実行中のジョブが終わるまで次は始まらない。
        assert!(h.started.recv_timeout(Duration::from_millis(200)).is_err());
        let mut order = Vec::new();
        for _ in 0..5 {
            h.release.send(()).unwrap();
            order.push(h.next_started().1);
        }
        assert_eq!(order, vec![4, 5, 6, 11, 12]);
        h.release.send(()).unwrap();
        h.wait_event(BOOK, 12, JobState::Done);
    }

    /// 一括のジョブを実行中に表示中のページが来たら、一括を打ち切って表示中を先に処理し、
    /// 打ち切ったページは取り消しにせず一括の列の先頭へ戻す。
    #[test]
    fn visible_pages_preempt_a_running_batch_job_and_it_is_requeued() {
        let h = harness();
        h.batch(BOOK, KEY, &params(), &[10, 11, 12]);
        assert_eq!(h.next_started(), (BOOK.into(), 10));

        h.request(BOOK, KEY, &params(), &[3], &[4]);
        // 打ち切った 10 は「積んだ」に戻る(取り消しの知らせは出さない)。
        h.wait_event(BOOK, 10, JobState::Queued);
        assert_eq!(h.next_started(), (BOOK.into(), 3));
        assert_eq!(
            h.queue.pending_order(),
            vec![
                (4, Priority::Prefetch),
                (10, Priority::Batch),
                (11, Priority::Batch),
                (12, Priority::Batch),
            ]
        );
        let mut order = Vec::new();
        for _ in 0..4 {
            h.release.send(()).unwrap();
            order.push(h.next_started().1);
        }
        assert_eq!(order, vec![4, 10, 11, 12]);
        h.release.send(()).unwrap();
        h.wait_event(BOOK, 12, JobState::Done);
        assert!(!h
            .seen
            .borrow()
            .contains(&(BOOK.into(), 10, JobState::Cancelled)));
    }

    /// 表示中のページがすべて処理済み(要求に表示中が無い)なら、一括の実行は続ける。
    #[test]
    fn prefetch_only_requests_do_not_preempt_the_batch() {
        let h = harness();
        h.batch(BOOK, KEY, &params(), &[10]);
        assert_eq!(h.next_started(), (BOOK.into(), 10));
        h.request(BOOK, KEY, &params(), &[], &[4]);
        h.release.send(()).unwrap();
        h.wait_event(BOOK, 10, JobState::Done);
        assert_eq!(h.next_started(), (BOOK.into(), 4));
    }

    /// 一括をやめると一括だけのジョブは取り消し、表示中・先読みのジョブは残す。
    #[test]
    fn cancelling_the_batch_keeps_view_jobs() {
        let h = harness();
        h.batch(BOOK, KEY, &params(), &[10, 11]);
        assert_eq!(h.next_started(), (BOOK.into(), 10));
        h.batch(OTHER, KEY, &params(), &[7]);
        // 5 は表示中にも一括にも入る。
        h.batch(BOOK, KEY, &params(), &[5]);
        h.request(BOOK, KEY, &params(), &[], &[5]);

        h.queue.cancel_batch(BOOK);
        h.wait_event(BOOK, 11, JobState::Cancelled);
        h.wait_event(BOOK, 10, JobState::Cancelled);
        // 実行中の 10 を打ち切ったので、残った先読みの 5 が始まる。
        assert_eq!(h.next_started(), (BOOK.into(), 5));
        assert_eq!(h.queue.pending_order(), vec![(7, Priority::Batch)]);
        // 5 は一括の印が外れたので、先読みから外れると一括へ戻らず取り消される。
        h.request(BOOK, KEY, &params(), &[], &[]);
        h.wait_event(BOOK, 5, JobState::Cancelled);
        assert_eq!(h.next_started(), (OTHER.into(), 7));
    }

    /// 表示中だった実行中のページが一括にも入ったあと先読みに下がり、別のページが表示中になったら、
    /// 実行中のページを打ち切って表示中を先に処理し、打ち切ったページは先読みとして処理し直す。
    #[test]
    fn a_running_batch_page_demoted_to_prefetch_yields_to_the_visible_page() {
        let h = harness();
        h.request(BOOK, KEY, &params(), &[10], &[]);
        assert_eq!(h.next_started(), (BOOK.into(), 10));
        h.batch(BOOK, KEY, &params(), &[10, 11]);

        // 未処理の 9 へ戻る。10 は先読みに残る。
        h.request(BOOK, KEY, &params(), &[9], &[10]);
        assert_eq!(h.next_started(), (BOOK.into(), 9));
        h.wait_event(BOOK, 10, JobState::Queued);
        assert_eq!(
            h.queue.pending_order(),
            vec![(10, Priority::Prefetch), (11, Priority::Batch)]
        );
        let mut order = Vec::new();
        for _ in 0..2 {
            h.release.send(()).unwrap();
            order.push(h.next_started().1);
        }
        assert_eq!(order, vec![10, 11]);
        h.release.send(()).unwrap();
        h.wait_event(BOOK, 11, JobState::Done);
    }

    /// 表示中として始めたページが一括にも入り、表示中・先読みから外れたら一括のジョブとして扱い、
    /// 一括をやめたら打ち切る。
    #[test]
    fn cancelling_the_batch_stops_a_running_page_that_left_the_view() {
        let h = harness();
        h.request(BOOK, KEY, &params(), &[10], &[]);
        assert_eq!(h.next_started(), (BOOK.into(), 10));
        h.batch(BOOK, KEY, &params(), &[10, 11]);

        // 処理済みのページへ移動して、表示中・先読みに未処理のページが無くなる。
        h.request(BOOK, KEY, &params(), &[], &[]);
        h.queue.cancel_batch(BOOK);
        h.wait_event(BOOK, 11, JobState::Cancelled);
        h.wait_event(BOOK, 10, JobState::Cancelled);
        assert!(h.queue.pending_order().is_empty());
        assert!(h.started.recv_timeout(Duration::from_millis(200)).is_err());
    }

    /// 表示中に譲って打ち切った一括のジョブは、打ち切りが終わる前に一括をやめたら戻さない。
    #[test]
    fn cancelling_the_batch_while_a_preempted_job_stops_does_not_requeue_it() {
        let h = harness_with(true);
        h.batch(BOOK, KEY, &params(), &[10]);
        assert_eq!(h.next_started(), (BOOK.into(), 10));
        h.request(BOOK, KEY, &params(), &[3], &[]);
        h.queue.cancel_batch(BOOK);
        h.release.send(()).unwrap();
        h.wait_event(BOOK, 10, JobState::Cancelled);
        assert_eq!(h.next_started(), (BOOK.into(), 3));
        assert!(h.queue.pending_order().is_empty());
        // 取り消しに気づかない偽の実行なので、終えてからキューを落とす。
        h.release.send(()).unwrap();
        h.wait_event(BOOK, 3, JobState::Done);
    }

    #[test]
    fn shutdown_cancels_the_running_job_and_stops_the_worker() {
        let h = harness();
        h.request(BOOK, KEY, &params(), &[0], &[1]);
        assert_eq!(h.next_started(), (BOOK.into(), 0));

        h.queue.shutdown();
        h.wait_event(BOOK, 0, JobState::Cancelled);
        assert!(h.queue.pending_order().is_empty());
        // 止まったあとに積んでも実行されない。
        h.request(BOOK, KEY, &params(), &[2], &[]);
        assert!(h.started.recv_timeout(Duration::from_millis(200)).is_err());
    }

    #[test]
    fn moving_far_cancels_pages_outside_the_new_window_and_the_running_job() {
        let h = harness();
        h.request(BOOK, KEY, &params(), &[0], &[1, 2, 3]);
        assert_eq!(h.next_started(), (BOOK.into(), 0));
        h.batch(BOOK, KEY, &params(), &[2]);

        // 大きく移動: 50 ページ目へ。実行中の 0 と先読みの 1・3 は取り消し、一括にも含まれる 2 は一括へ戻す。
        h.request(BOOK, KEY, &params(), &[50], &[51]);
        h.wait_event(BOOK, 0, JobState::Cancelled);
        assert_eq!(h.next_started(), (BOOK.into(), 50));
        assert_eq!(
            h.queue.pending_order(),
            vec![(51, Priority::Prefetch), (2, Priority::Batch)]
        );
    }

    #[test]
    fn small_moves_keep_the_running_job_and_reorder_the_rest() {
        let h = harness();
        h.request(BOOK, KEY, &params(), &[0], &[1, 2]);
        assert_eq!(h.next_started(), (BOOK.into(), 0));

        // 1 ページ進む: 実行中の 0 は先読みに残るので続け、1 が表示中に上がる。
        h.request(BOOK, KEY, &params(), &[1], &[0, 2, 3]);
        assert_eq!(
            h.queue.pending_order(),
            vec![
                (1, Priority::Visible),
                (2, Priority::Prefetch),
                (3, Priority::Prefetch)
            ]
        );
        h.release.send(()).unwrap();
        h.wait_event(BOOK, 0, JobState::Done);
        assert_eq!(h.next_started(), (BOOK.into(), 1));
    }

    #[test]
    fn closing_a_book_cancels_all_its_jobs_and_leaves_other_books() {
        let h = harness();
        h.batch(OTHER, KEY, &params(), &[7]);
        assert_eq!(h.next_started(), (OTHER.into(), 7));
        h.batch(BOOK, KEY, &params(), &[20, 21]);
        h.batch(OTHER, KEY, &params(), &[8]);

        h.queue.cancel_book(OTHER);
        h.wait_event(OTHER, 8, JobState::Cancelled);
        h.wait_event(OTHER, 7, JobState::Cancelled);
        assert_eq!(h.next_started(), (BOOK.into(), 20));
        assert_eq!(h.queue.pending_order(), vec![(21, Priority::Batch)]);
    }

    #[test]
    fn opening_another_book_cancels_the_previous_books_view_jobs() {
        let h = harness();
        h.request(OTHER, KEY, &params(), &[0], &[1]);
        assert_eq!(h.next_started(), (OTHER.into(), 0));

        h.request(BOOK, KEY, &params(), &[5], &[]);
        h.wait_event(OTHER, 1, JobState::Cancelled);
        h.wait_event(OTHER, 0, JobState::Cancelled);
        assert_eq!(h.next_started(), (BOOK.into(), 5));
    }

    #[test]
    fn duplicate_requests_are_not_queued_twice() {
        let h = harness();
        h.request(BOOK, KEY, &params(), &[0], &[]);
        assert_eq!(h.next_started(), (BOOK.into(), 0));
        h.request(BOOK, KEY, &params(), &[0, 1, 1], &[1]);
        h.batch(BOOK, KEY, &params(), &[0, 1]);
        assert_eq!(h.queue.pending_order(), vec![(1, Priority::Visible)]);
    }

    /// 取り消した実行中のページをすぐ要求し直すと、捨てずに積み直して処理する。
    #[test]
    fn re_requesting_a_cancelled_running_page_runs_it_again() {
        let h = harness_with(true);
        h.request(BOOK, KEY, &params(), &[0], &[]);
        assert_eq!(h.next_started(), (BOOK.into(), 0));

        // 0 の取り消しが終わる前に 0 へ戻る。
        h.request(BOOK, KEY, &params(), &[40], &[]);
        h.request(BOOK, KEY, &params(), &[0], &[]);
        h.release.send(()).unwrap();
        h.wait_event(BOOK, 0, JobState::Cancelled);
        assert_eq!(h.next_started(), (BOOK.into(), 0));
        h.release.send(()).unwrap();
        h.wait_event(BOOK, 0, JobState::Done);
    }

    /// 本を閉じる前に受付番号を取った要求は、閉じた後に届いても積まない。
    #[test]
    fn requests_that_started_before_closing_are_dropped() {
        let h = harness();
        let view = h.queue.ticket();
        let batch = h.queue.ticket();
        h.queue.cancel_book(BOOK);

        assert!(!h
            .queue
            .request_pages(view, BOOK, KEY, &params(), &[0], &[1]));
        assert!(!h.queue.enqueue_batch(batch, BOOK, KEY, &params(), &[2]));
        assert!(h.queue.pending_order().is_empty());
        assert!(h.started.recv_timeout(Duration::from_millis(200)).is_err());
        // 閉じた後に取った番号の要求は受け付ける。
        assert!(h.request(BOOK, KEY, &params(), &[3], &[]));
        assert_eq!(h.next_started(), (BOOK.into(), 3));
    }

    /// 後から取った番号の要求が先に届いたら、古い要求は顔ぶれを戻さない。
    #[test]
    fn older_view_requests_do_not_override_newer_ones() {
        let h = harness();
        let older = h.queue.ticket();
        let newer = h.queue.ticket();
        assert!(h
            .queue
            .request_pages(newer, BOOK, KEY, &params(), &[50], &[]));
        assert_eq!(h.next_started(), (BOOK.into(), 50));
        assert!(!h
            .queue
            .request_pages(older, BOOK, KEY, &params(), &[0], &[1]));
        assert!(h.queue.pending_order().is_empty());
    }

    /// 知らせはジョブごとに 積んだ → 始めた → 終えた の順に届く。
    #[test]
    fn events_arrive_in_the_order_they_happened() {
        let h = harness();
        h.request(BOOK, KEY, &params(), &[0, 1], &[2]);
        for _ in 0..3 {
            h.next_started();
            h.release.send(()).unwrap();
        }
        h.wait_event(BOOK, 2, JobState::Done);
        let events: Vec<_> = h.seen.borrow().clone();
        for index in 0..3 {
            let states: Vec<JobState> = events
                .iter()
                .filter(|(_, i, _)| *i == index)
                .map(|(_, _, state)| state.clone())
                .collect();
            let expected = if index == 2 {
                // 最後の Done は wait_event が取り出した。
                vec![JobState::Queued, JobState::Running]
            } else {
                vec![JobState::Queued, JobState::Running, JobState::Done]
            };
            assert_eq!(states, expected, "{index}");
        }
    }
}
