use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::prelude::{BASE64_STANDARD, Engine};
use tauri::{AppHandle, Manager};
use tempfile::tempdir;
use wait_timeout::ChildExt;
use walkdir::WalkDir;
use zip::ZipArchive;

use crate::app_error::{AppError, AppResult};
use crate::models::{
    EnhanceImageRequest, EnhanceImageResponse, EngineId, EngineRegistration, EngineRegistry,
    EngineStatus,
};
use crate::services::app_data_dir;
use crate::state::RegistryLock;

struct TimedOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

struct EngineDescriptor {
    id: EngineId,
    download_url: &'static str,
    executable_names: &'static [&'static str],
    notes: &'static [&'static str],
}

fn descriptor(engine_id: EngineId) -> EngineDescriptor {
    match engine_id {
        EngineId::Waifu2x => EngineDescriptor {
            id: engine_id,
            download_url: "https://github.com/nihui/waifu2x-ncnn-vulkan/releases",
            executable_names: &[
                #[cfg(target_os = "windows")]
                "waifu2x-ncnn-vulkan.exe",
                #[cfg(not(target_os = "windows"))]
                "waifu2x-ncnn-vulkan",
            ],
            notes: &[
                "ZIP 取込時は `models-cunet` を優先利用します。",
                "漫画・線画・スキャンの拡大を既定ケースとして想定します。",
            ],
        },
        EngineId::RealEsrgan => EngineDescriptor {
            id: engine_id,
            download_url: "https://github.com/xinntao/Real-ESRGAN/releases",
            executable_names: &[
                #[cfg(target_os = "windows")]
                "realesrgan-ncnn-vulkan.exe",
                #[cfg(not(target_os = "windows"))]
                "realesrgan-ncnn-vulkan",
            ],
            notes: &[
                "ZIP 取込時はアニメ向けモデルがあればそれを優先します。",
                "表紙・挿絵・写真混在 EPUB に向いています。",
            ],
        },
    }
}

fn registry_path(app: &AppHandle) -> AppResult<PathBuf> {
    let path = app_data_dir(app)?.join("engines");
    fs::create_dir_all(&path)?;
    Ok(path.join("registry.json"))
}

fn load_registry(app: &AppHandle) -> AppResult<EngineRegistry> {
    let path = registry_path(app)?;

    if !path.exists() {
        return Ok(EngineRegistry::default());
    }

    let content = fs::read_to_string(path)?;
    Ok(serde_json::from_str(&content)?)
}

fn save_registry(app: &AppHandle, registry: &EngineRegistry) -> AppResult<()> {
    let path = registry_path(app)?;
    fs::write(path, serde_json::to_vec_pretty(registry)?)?;
    Ok(())
}

fn tools_dir(app: &AppHandle, engine_id: EngineId) -> AppResult<PathBuf> {
    let path = app_data_dir(app)?
        .join("tools")
        .join(engine_id.as_str());
    fs::create_dir_all(&path)?;
    Ok(path)
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn find_executable(root: &Path, executable_names: &[&str]) -> Option<PathBuf> {
    WalkDir::new(root)
        .max_depth(4)
        .into_iter()
        .filter_map(Result::ok)
        .find(|entry| {
            entry.file_type().is_file()
                && executable_names.iter().any(|expected| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .eq_ignore_ascii_case(expected)
                })
        })
        .map(|entry| entry.into_path())
}

fn find_directory_named(root: &Path, directory_names: &[&str]) -> Option<PathBuf> {
    WalkDir::new(root)
        .max_depth(4)
        .into_iter()
        .filter_map(Result::ok)
        .find(|entry| {
            entry.file_type().is_dir()
                && directory_names.iter().any(|expected| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .eq_ignore_ascii_case(expected)
                })
        })
        .map(|entry| entry.into_path())
}

fn infer_registration(engine_id: EngineId, root: &Path) -> AppResult<EngineRegistration> {
    let descriptor = descriptor(engine_id);
    let executable_path = find_executable(root, descriptor.executable_names)
        .ok_or_else(|| AppError::Message(format!("{} の実行ファイルが見つかりません。", descriptor.id.label())))?;

    let (model_path, model_name) = match engine_id {
        EngineId::Waifu2x => {
            let model_path = find_directory_named(
                root,
                &["models-cunet", "models-upconv_7_anime_style_art_rgb", "models-upconv_7_photo"],
            )
            .ok_or_else(|| AppError::Message("waifu2x のモデルフォルダが見つかりません。".into()))?;
            let model_name = model_path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.to_string());

            (model_path, model_name)
        }
        EngineId::RealEsrgan => {
            let model_root = find_directory_named(root, &["models"]).unwrap_or_else(|| root.to_path_buf());
            let preferred_models = [
                "realesrgan-x4plus-anime",
                "realesr-animevideov3",
                "realesr-animevideov3-x2",
            ];

            let detected_model = preferred_models.iter().find(|name| {
                model_root.join(format!("{name}.bin")).is_file()
                    && model_root.join(format!("{name}.param")).is_file()
            });

            let model_name = detected_model
                .map(|name| (*name).to_string())
                .ok_or_else(|| {
                    AppError::Message("Real-ESRGAN のモデルファイルが見つかりません。".into())
                })?;

            (model_root, Some(model_name))
        }
    };

    Ok(EngineRegistration {
        executable_path: executable_path.to_string_lossy().to_string(),
        model_name,
        model_path: model_path.to_string_lossy().to_string(),
        registered_at: now_unix(),
        source: "manual".into(),
    })
}

fn run_healthcheck(registration: &EngineRegistration) -> AppResult<()> {
    let executable_path = PathBuf::from(&registration.executable_path);
    if !executable_path.is_file() {
        return Err(AppError::Message("AI エンジン実行ファイルが存在しません。".into()));
    }

    let model_path = PathBuf::from(&registration.model_path);
    if !model_path.exists() {
        return Err(AppError::Message("AI エンジンのモデルパスが存在しません。".into()));
    }

    let output = run_command_with_timeout(
        Command::new(&executable_path)
            .arg("-h")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
        Duration::from_secs(5),
        "AI エンジンのヘルスチェックがタイムアウトしました。",
    )?;

    if !output.status.success() && output.stdout.is_empty() && output.stderr.is_empty() {
        return Err(AppError::Message(
            "AI エンジンのヘルスチェック出力が空でした。".into(),
        ));
    }

    Ok(())
}

fn run_command_with_timeout(
    command: &mut Command,
    timeout: Duration,
    timeout_message: &str,
) -> AppResult<TimedOutput> {
    let mut child = command.spawn()?;
    let stdout_thread = child.stdout.take().map(|mut handle| {
        thread::spawn(move || {
            let mut buffer = Vec::new();
            let _ = handle.read_to_end(&mut buffer);
            buffer
        })
    });
    let stderr_thread = child.stderr.take().map(|mut handle| {
        thread::spawn(move || {
            let mut buffer = Vec::new();
            let _ = handle.read_to_end(&mut buffer);
            buffer
        })
    });
    let status = match child.wait_timeout(timeout)? {
        Some(status) => status,
        None => {
            child.kill()?;
            let _ = child.wait();
            if let Some(thread) = stdout_thread {
                let _ = thread.join();
            }
            if let Some(thread) = stderr_thread {
                let _ = thread.join();
            }
            return Err(AppError::Message(timeout_message.into()));
        }
    };

    let stdout = stdout_thread
        .map(|thread| thread.join().unwrap_or_default())
        .unwrap_or_default();
    let stderr = stderr_thread
        .map(|thread| thread.join().unwrap_or_default())
        .unwrap_or_default();

    Ok(TimedOutput { status, stdout, stderr })
}

fn build_status(engine_id: EngineId, registration: Option<&EngineRegistration>) -> EngineStatus {
    let descriptor = descriptor(engine_id);
    let mut warning = None;
    let mut configured = false;
    let mut ready = false;

    if let Some(entry) = registration {
        configured = true;
        if let Err(error) = run_healthcheck(entry) {
            warning = Some(error.to_string());
        } else {
            ready = true;
        }
    }

    EngineStatus {
        id: engine_id,
        label: descriptor.id.label().to_string(),
        configured,
        ready,
        executable_path: registration.map(|item| item.executable_path.clone()),
        model_path: registration.map(|item| item.model_path.clone()),
        model_name: registration.and_then(|item| item.model_name.clone()),
        warning,
        download_url: descriptor.download_url.to_string(),
        notes: descriptor.notes.iter().map(|note| (*note).to_string()).collect(),
    }
}

pub fn get_engine_statuses(app: &AppHandle) -> AppResult<Vec<EngineStatus>> {
    let registry = {
        let registry_lock = app.state::<RegistryLock>();
        let _guard = registry_lock
            .0
            .lock()
            .map_err(|_| AppError::Message("AI エンジン設定の排他制御に失敗しました。".into()))?;
        load_registry(app)?
    };

    Ok([EngineId::Waifu2x, EngineId::RealEsrgan]
        .into_iter()
        .map(|engine_id| build_status(engine_id, registry.engines.get(&engine_id)))
        .collect())
}

pub fn register_engine_directory(
    app: &AppHandle,
    engine_id: EngineId,
    directory_path: &str,
) -> AppResult<EngineStatus> {
    let registry_lock = app.state::<RegistryLock>();
    let _guard = registry_lock
        .0
        .lock()
        .map_err(|_| AppError::Message("AI エンジン設定の排他制御に失敗しました。".into()))?;
    let root = PathBuf::from(directory_path);

    if !root.is_dir() {
        return Err(AppError::Message("指定されたフォルダが見つかりません。".into()));
    }

    let mut registry = load_registry(app)?;
    let mut registration = infer_registration(engine_id, &root)?;
    registration.source = "directory".into();
    registry.engines.insert(engine_id, registration);
    save_registry(app, &registry)?;

    Ok(build_status(engine_id, registry.engines.get(&engine_id)))
}

pub fn import_engine_archive(
    app: &AppHandle,
    engine_id: EngineId,
    archive_path: &str,
) -> AppResult<EngineStatus> {
    let registry_lock = app.state::<RegistryLock>();
    let _guard = registry_lock
        .0
        .lock()
        .map_err(|_| AppError::Message("AI エンジン設定の排他制御に失敗しました。".into()))?;
    let archive_bytes = fs::read(archive_path)?;
    let mut archive = ZipArchive::new(Cursor::new(archive_bytes))?;
    let extraction_root = tools_dir(app, engine_id)?.join(now_unix().to_string());
    fs::create_dir_all(&extraction_root)?;

    for index in 0..archive.len() {
        let mut file = archive.by_index(index)?;
        let enclosed = file
            .enclosed_name()
            .ok_or_else(|| AppError::Message("ZIP 内に危険なパスが含まれています。".into()))?;

        let output_path = extraction_root.join(enclosed);
        if file.is_dir() {
            fs::create_dir_all(&output_path)?;
            continue;
        }

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let mut destination = fs::File::create(&output_path)?;
        std::io::copy(&mut file, &mut destination)?;
        destination.flush()?;
    }

    let result = (|| -> AppResult<EngineStatus> {
        let mut registry = load_registry(app)?;
        let mut registration = infer_registration(engine_id, &extraction_root)?;
        registration.source = "archive".into();
        registry.engines.insert(engine_id, registration);
        save_registry(app, &registry)?;
        Ok(build_status(engine_id, registry.engines.get(&engine_id)))
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(&extraction_root);
    }

    result
}

pub fn clear_engine_registration(
    app: &AppHandle,
    engine_id: EngineId,
) -> AppResult<Vec<EngineStatus>> {
    {
        let registry_lock = app.state::<RegistryLock>();
        let _guard = registry_lock
            .0
            .lock()
            .map_err(|_| AppError::Message("AI エンジン設定の排他制御に失敗しました。".into()))?;
        let mut registry = load_registry(app)?;
        registry.engines.remove(&engine_id);
        save_registry(app, &registry)?;
    }

    get_engine_statuses(app)
}

fn decode_data_url(data_url: &str) -> AppResult<Vec<u8>> {
    let (_, encoded) = data_url
        .split_once(',')
        .ok_or_else(|| AppError::Message("画像データ URL の形式が不正です。".into()))?;

    BASE64_STANDARD
        .decode(encoded)
        .map_err(|error| AppError::Message(format!("画像データの復号に失敗しました: {error}")))
}

pub fn enhance_image(app: &AppHandle, request: EnhanceImageRequest) -> AppResult<EnhanceImageResponse> {
    let registration = {
        let registry_lock = app.state::<RegistryLock>();
        let _guard = registry_lock
            .0
            .lock()
            .map_err(|_| AppError::Message("AI エンジン設定の排他制御に失敗しました。".into()))?;
        let registry = load_registry(app)?;
        registry
            .engines
            .get(&request.engine_id)
            .cloned()
            .ok_or_else(|| AppError::Message("選択した AI エンジンはまだ登録されていません。".into()))?
    };

    let temp_dir = tempdir()?;
    let input_path = temp_dir.path().join("input.png");
    let output_path = temp_dir.path().join("output.png");
    fs::write(&input_path, decode_data_url(&request.image_data_url)?)?;

    let mut command = Command::new(&registration.executable_path);
    command
        .current_dir(
            Path::new(&registration.executable_path)
                .parent()
                .unwrap_or_else(|| Path::new(".")),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let scale = request.scale.to_string();

    match request.engine_id {
        EngineId::Waifu2x => {
            command
                .arg("-i")
                .arg(input_path.to_string_lossy().as_ref())
                .arg("-o")
                .arg(output_path.to_string_lossy().as_ref())
                .arg("-s")
                .arg(&scale)
                .arg("-n")
                .arg("1")
                .arg("-m")
                .arg(registration.model_path.as_str())
                .arg("-f")
                .arg("png");
        }
        EngineId::RealEsrgan => {
            let model_name = registration
                .model_name
                .as_deref()
                .unwrap_or("realesrgan-x4plus-anime");
            command
                .arg("-i")
                .arg(input_path.to_string_lossy().as_ref())
                .arg("-o")
                .arg(output_path.to_string_lossy().as_ref())
                .arg("-s")
                .arg(&scale)
                .arg("-m")
                .arg(registration.model_path.as_str())
                .arg("-n")
                .arg(model_name)
                .arg("-f")
                .arg("png");
        }
    }

    let output = run_command_with_timeout(
        &mut command,
        Duration::from_secs(120),
        "AI エンジンの処理がタイムアウトしました。",
    )?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(AppError::Message(format!(
            "AI エンジンの処理に失敗しました。stderr: {stderr} stdout: {stdout}"
        )));
    }

    if !output_path.is_file() {
        return Err(AppError::Message(
            "AI エンジンが出力画像を生成しませんでした。".into(),
        ));
    }

    let enhanced_bytes = fs::read(output_path)?;
    Ok(EnhanceImageResponse {
        image_data_url: format!("data:image/png;base64,{}", BASE64_STANDARD.encode(enhanced_bytes)),
    })
}
