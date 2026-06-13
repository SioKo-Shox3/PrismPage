use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::{env, fs};

use base64::prelude::{Engine, BASE64_STANDARD};
use reqwest::blocking::Client;
use reqwest::{StatusCode, Url};
use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tempfile::tempdir;
use uuid::Uuid;
use wait_timeout::ChildExt;
use walkdir::WalkDir;
use zip::ZipArchive;

use crate::app_error::{AppError, AppResult};
use crate::models::{
    EngineCandidate, EngineId, EngineInstallOption, EngineInstallOptionsResponse,
    EngineInstallWarning, EngineRegistration, EngineRegistry, EngineStatus,
    EnhanceBookImageRequest, EnhanceBookImageResponse, EnhanceImageRequest, EnhanceImageResponse,
};
use crate::services::app_data_dir;
use crate::state::{EnhancementLock, RegistryLock};

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

struct ReleaseDescriptor {
    owner: &'static str,
    repo: &'static str,
    asset_keywords: &'static [&'static str],
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    name: Option<String>,
    draft: bool,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    size: u64,
    browser_download_url: String,
}

const REALESRGAN_ANIME_MODEL: &str = "realesr-animevideov3";
const REALESRGAN_ANIME_SCALE_MODELS: [&str; 3] = [
    "realesr-animevideov3-x2",
    "realesr-animevideov3-x3",
    "realesr-animevideov3-x4",
];
const REALESRGAN_FALLBACK_MODELS: [&str; 2] = ["realesrgan-x4plus-anime", "realesrgan-x4plus"];
const MAX_RELEASE_ARCHIVE_BYTES: u64 = 1024 * 1024 * 1024;

fn descriptor(engine_id: EngineId) -> EngineDescriptor {
    match engine_id {
        EngineId::RealCugan => EngineDescriptor {
            id: engine_id,
            download_url: "https://github.com/nihui/realcugan-ncnn-vulkan/releases",
            executable_names: &[
                #[cfg(target_os = "windows")]
                "realcugan-ncnn-vulkan.exe",
                #[cfg(not(target_os = "windows"))]
                "realcugan-ncnn-vulkan",
            ],
            notes: &[
                "公式配布 ZIP をアプリ内へインストールできます。",
                "漫画・イラストの拡大では `models-se` を優先利用します。",
            ],
        },
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

fn release_descriptor(engine_id: EngineId) -> ReleaseDescriptor {
    match engine_id {
        EngineId::RealCugan => ReleaseDescriptor {
            owner: "nihui",
            repo: "realcugan-ncnn-vulkan",
            asset_keywords: &["realcugan-ncnn-vulkan"],
        },
        EngineId::Waifu2x => ReleaseDescriptor {
            owner: "nihui",
            repo: "waifu2x-ncnn-vulkan",
            asset_keywords: &["waifu2x-ncnn-vulkan"],
        },
        EngineId::RealEsrgan => ReleaseDescriptor {
            owner: "xinntao",
            repo: "Real-ESRGAN",
            asset_keywords: &["realesrgan-ncnn-vulkan"],
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
    let path = app_data_dir(app)?.join("tools").join(engine_id.as_str());
    fs::create_dir_all(&path)?;
    Ok(path)
}

fn create_unique_extraction_root(app: &AppHandle, engine_id: EngineId) -> AppResult<PathBuf> {
    let base_dir = tools_dir(app, engine_id)?;

    for _ in 0..16 {
        let candidate = base_dir.join(format!("{}-{}", now_unix(), Uuid::new_v4()));
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }

    Err(AppError::Message(
        "AI エンジン ZIP の一時展開先を作成できませんでした。".into(),
    ))
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn all_engine_ids() -> [EngineId; 3] {
    [EngineId::RealCugan, EngineId::Waifu2x, EngineId::RealEsrgan]
}

fn github_client(timeout: Duration) -> AppResult<Client> {
    Ok(Client::builder()
        .timeout(timeout)
        .user_agent("PrismPage")
        .build()?)
}

fn github_releases_api_url(descriptor: &ReleaseDescriptor) -> String {
    format!(
        "https://api.github.com/repos/{}/{}/releases?per_page=30",
        descriptor.owner, descriptor.repo
    )
}

fn ensure_success_status(status: StatusCode, context: &str) -> AppResult<()> {
    if status.is_success() {
        return Ok(());
    }

    Err(AppError::Message(format!(
        "{context} がエラーを返しました。（HTTP {status}）"
    )))
}

fn fetch_releases(
    client: &Client,
    descriptor: &ReleaseDescriptor,
) -> AppResult<Vec<GitHubRelease>> {
    let url = github_releases_api_url(descriptor);
    let response = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .map_err(|error| {
            AppError::Message(format!(
                "GitHub Releases API への接続に失敗しました: {error}"
            ))
        })?;

    let status = response.status();
    ensure_success_status(status, "GitHub Releases API")?;

    response.json::<Vec<GitHubRelease>>().map_err(|error| {
        AppError::Message(format!(
            "GitHub Releases API の応答を読み取れませんでした: {error}"
        ))
    })
}

fn is_windows_zip_asset(asset_name: &str, keywords: &[&str]) -> bool {
    let lower_name = asset_name.to_ascii_lowercase();
    lower_name.ends_with(".zip")
        && (lower_name.contains("windows")
            || lower_name.contains("win64")
            || lower_name.contains("win32"))
        && keywords
            .iter()
            .all(|keyword| lower_name.contains(&keyword.to_ascii_lowercase()))
}

fn release_asset_option(
    engine_id: EngineId,
    release: &GitHubRelease,
    asset: &GitHubAsset,
) -> EngineInstallOption {
    EngineInstallOption {
        engine_id,
        label: engine_id.label().to_string(),
        release_name: release
            .name
            .as_deref()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or(&release.tag_name)
            .to_string(),
        release_tag: release.tag_name.clone(),
        asset_name: asset.name.clone(),
        download_url: asset.browser_download_url.clone(),
        size: asset.size,
    }
}

fn windows_asset_priority(asset_name: &str) -> u8 {
    let lower_name = asset_name.to_ascii_lowercase();

    if lower_name.contains("win64") || lower_name.contains("x64") {
        0
    } else if lower_name.contains("windows") {
        1
    } else if lower_name.contains("win32") || lower_name.contains("x86") {
        2
    } else {
        3
    }
}

fn find_release_assets(
    client: &Client,
    engine_id: EngineId,
) -> AppResult<Vec<EngineInstallOption>> {
    let descriptor = release_descriptor(engine_id);
    let releases = fetch_releases(client, &descriptor)?;
    let mut options = Vec::new();

    for release in releases.iter().filter(|release| !release.draft) {
        let mut assets = release
            .assets
            .iter()
            .filter(|asset| {
                is_windows_zip_asset(&asset.name, descriptor.asset_keywords)
                    && asset.size > 0
                    && asset.size <= MAX_RELEASE_ARCHIVE_BYTES
            })
            .collect::<Vec<_>>();
        assets.sort_by_key(|asset| windows_asset_priority(&asset.name));

        for asset in assets {
            options.push(release_asset_option(engine_id, release, asset));
        }
    }

    if options.is_empty() {
        Err(AppError::Message(format!(
            "{} のインストール可能な Windows ZIP 配布 asset が見つかりませんでした。",
            engine_id.label()
        )))
    } else {
        Ok(options)
    }
}

fn validate_release_option(option: &EngineInstallOption) -> AppResult<()> {
    let descriptor = release_descriptor(option.engine_id);
    let engine_label = option.engine_id.label();

    if !is_windows_zip_asset(&option.asset_name, descriptor.asset_keywords) {
        return Err(AppError::Message(format!(
            "{} の Windows ZIP asset として扱えないファイル名です。",
            engine_label
        )));
    }

    let url = Url::parse(&option.download_url).map_err(|error| {
        AppError::Message(format!(
            "公式配布 ZIP の URL を読み取れませんでした: {error}"
        ))
    })?;

    if url.scheme() != "https" || url.host_str() != Some("github.com") {
        return Err(AppError::Message(
            "公式配布 ZIP は GitHub の HTTPS URL を指定してください。".into(),
        ));
    }

    let path = url.path().to_ascii_lowercase();
    let expected_prefix = format!(
        "/{}/{}/releases/download/",
        descriptor.owner.to_ascii_lowercase(),
        descriptor.repo.to_ascii_lowercase()
    );

    if !path.starts_with(&expected_prefix) || !path.ends_with(".zip") {
        return Err(AppError::Message(format!(
            "{} の公式 GitHub Releases asset URL ではありません。",
            engine_label
        )));
    }

    Ok(())
}

fn ensure_release_archive_size(engine_label: &str, size: u64) -> AppResult<()> {
    if size == 0 {
        return Err(AppError::Message(format!(
            "{engine_label} の公式配布 ZIP はサイズ情報が 0 bytes のためインストールできません。"
        )));
    }

    if size > MAX_RELEASE_ARCHIVE_BYTES {
        return Err(AppError::Message(format!(
            "{engine_label} の公式配布 ZIP は上限サイズ 1GB を超えています。（{} bytes）",
            size
        )));
    }

    Ok(())
}

fn verify_release_option(
    client: &Client,
    option: &EngineInstallOption,
) -> AppResult<EngineInstallOption> {
    validate_release_option(option)?;

    let descriptor = release_descriptor(option.engine_id);
    let releases = fetch_releases(client, &descriptor)?;
    let release = releases
        .iter()
        .find(|release| !release.draft && release.tag_name == option.release_tag)
        .ok_or_else(|| {
            AppError::Message(format!(
                "{} の指定リリースが公式 GitHub Releases API で確認できませんでした。",
                option.engine_id.label()
            ))
        })?;

    let asset = release
        .assets
        .iter()
        .find(|asset| {
            asset.name == option.asset_name
                && asset.browser_download_url == option.download_url
                && is_windows_zip_asset(&asset.name, descriptor.asset_keywords)
        })
        .ok_or_else(|| {
            AppError::Message(format!(
                "{} の指定 asset が公式 GitHub Releases API で確認できませんでした。",
                option.engine_id.label()
            ))
        })?;

    ensure_release_archive_size(option.engine_id.label(), asset.size)?;
    let verified_option = release_asset_option(option.engine_id, release, asset);
    validate_release_option(&verified_option)?;
    Ok(verified_option)
}

fn copy_response_with_limit(
    response: &mut impl Read,
    output: &mut fs::File,
    engine_label: &str,
) -> AppResult<u64> {
    let mut downloaded_size = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];

    loop {
        let read_size = response.read(&mut buffer)?;
        if read_size == 0 {
            break;
        }

        downloaded_size = downloaded_size
            .checked_add(read_size as u64)
            .ok_or_else(|| AppError::Message("ZIP サイズの計算が上限を超えました。".into()))?;

        if downloaded_size > MAX_RELEASE_ARCHIVE_BYTES {
            return Err(AppError::Message(format!(
                "{engine_label} の公式配布 ZIP はダウンロード中に上限サイズ 1GB を超えました。"
            )));
        }

        output.write_all(&buffer[..read_size])?;
    }

    Ok(downloaded_size)
}

fn download_release_archive(
    client: &Client,
    option: &EngineInstallOption,
    output_path: &Path,
) -> AppResult<()> {
    validate_release_option(option)?;
    let engine_label = option.engine_id.label();
    ensure_release_archive_size(engine_label, option.size)?;

    let mut response = client
        .get(&option.download_url)
        .header("Accept", "application/octet-stream")
        .send()
        .map_err(|error| {
            AppError::Message(format!(
                "{} のダウンロード開始に失敗しました: {error}",
                engine_label
            ))
        })?;

    ensure_success_status(response.status(), "公式配布 ZIP のダウンロード")?;

    if let Some(content_length) = response.content_length() {
        if content_length > MAX_RELEASE_ARCHIVE_BYTES {
            return Err(AppError::Message(format!(
                "{engine_label} の公式配布 ZIP は Content-Length が上限サイズ 1GB を超えています。（{} bytes）",
                content_length
            )));
        }
    }

    let mut output = fs::File::create(output_path)?;
    let downloaded_size = copy_response_with_limit(&mut response, &mut output, engine_label)?;
    output.flush()?;

    if downloaded_size == 0 {
        return Err(AppError::Message(
            "ダウンロードした ZIP ファイルが空でした。".into(),
        ));
    }

    if downloaded_size != option.size {
        return Err(AppError::Message(format!(
            "ダウンロードした ZIP サイズが一致しません。（期待値: {} bytes / 実際: {} bytes）",
            option.size, downloaded_size
        )));
    }

    Ok(())
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
    for expected in directory_names {
        let detected = WalkDir::new(root)
            .max_depth(4)
            .into_iter()
            .filter_map(Result::ok)
            .find(|entry| {
                entry.file_type().is_dir()
                    && entry
                        .file_name()
                        .to_string_lossy()
                        .eq_ignore_ascii_case(expected)
            })
            .map(|entry| entry.into_path());

        if detected.is_some() {
            return detected;
        }
    }

    None
}

fn directory_has_model_pair(directory: &Path) -> bool {
    let Ok(entries) = fs::read_dir(directory) else {
        return false;
    };

    entries.filter_map(Result::ok).any(|entry| {
        let path = entry.path();
        path.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("bin"))
            && path.with_extension("param").is_file()
    })
}

fn model_pair_exists(model_root: &Path, model_name: &str) -> bool {
    model_root.join(format!("{model_name}.bin")).is_file()
        && model_root.join(format!("{model_name}.param")).is_file()
}

fn has_realesrgan_anime_model(model_root: &Path) -> bool {
    model_pair_exists(model_root, REALESRGAN_ANIME_MODEL)
        || REALESRGAN_ANIME_SCALE_MODELS
            .iter()
            .any(|model_name| model_pair_exists(model_root, model_name))
}

fn normalize_realesrgan_model_name(model_name: &str) -> &str {
    if REALESRGAN_ANIME_SCALE_MODELS
        .iter()
        .any(|scale_model| model_name.eq_ignore_ascii_case(scale_model))
    {
        REALESRGAN_ANIME_MODEL
    } else {
        model_name
    }
}

fn find_realesrgan_model(model_root: &Path) -> Option<String> {
    if has_realesrgan_anime_model(model_root) {
        return Some(REALESRGAN_ANIME_MODEL.to_string());
    }

    REALESRGAN_FALLBACK_MODELS
        .iter()
        .find(|model_name| model_pair_exists(model_root, model_name))
        .map(|model_name| (*model_name).to_string())
}

fn canonicalize_existing_dir(path: &Path, error_message: &str) -> AppResult<PathBuf> {
    if !path.is_dir() {
        return Err(AppError::Message(error_message.into()));
    }

    Ok(fs::canonicalize(path)?)
}

fn candidate_root_priority(root: &Path) -> u8 {
    if root.join("tools").is_dir() {
        return 0;
    }

    if root
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("tools"))
    {
        return 1;
    }

    2
}

fn validate_model_directory(model_path: &Path, engine_label: &str) -> AppResult<()> {
    if !directory_has_model_pair(model_path) {
        return Err(AppError::Message(format!(
            "{engine_label} のモデルファイルが見つかりません。"
        )));
    }

    Ok(())
}

fn is_realesrgan_anime_model_name(model_name: &str) -> bool {
    model_name.eq_ignore_ascii_case(REALESRGAN_ANIME_MODEL)
        || REALESRGAN_ANIME_SCALE_MODELS
            .iter()
            .any(|scale_model| model_name.eq_ignore_ascii_case(scale_model))
}

fn realesrgan_anime_scale_file_exists(model_root: &Path, scale: u8) -> bool {
    model_pair_exists(model_root, &format!("{REALESRGAN_ANIME_MODEL}-x{scale}"))
        || model_pair_exists(model_root, REALESRGAN_ANIME_MODEL)
}

fn find_realesrgan_fallback_model(model_root: &Path) -> Option<String> {
    REALESRGAN_FALLBACK_MODELS
        .iter()
        .find(|model_name| model_pair_exists(model_root, model_name))
        .map(|model_name| (*model_name).to_string())
}

fn ensure_realesrgan_model_available(
    registration: &EngineRegistration,
    scale: u8,
) -> AppResult<String> {
    let model_root = Path::new(&registration.model_path);

    if let Some(model_name) = registration.model_name.as_deref() {
        let normalized = normalize_realesrgan_model_name(model_name);
        if is_realesrgan_anime_model_name(normalized)
            && realesrgan_anime_scale_file_exists(model_root, scale)
        {
            return Ok(REALESRGAN_ANIME_MODEL.to_string());
        }

        if model_pair_exists(model_root, normalized) {
            return Ok(normalized.to_string());
        }
    }

    if realesrgan_anime_scale_file_exists(model_root, scale) {
        return Ok(REALESRGAN_ANIME_MODEL.to_string());
    }

    find_realesrgan_fallback_model(model_root)
        .ok_or_else(|| AppError::Message("Real-ESRGAN のモデルファイルが見つかりません。".into()))
}

fn infer_registration(engine_id: EngineId, root: &Path) -> AppResult<EngineRegistration> {
    let descriptor = descriptor(engine_id);
    let executable_path = find_executable(root, descriptor.executable_names).ok_or_else(|| {
        AppError::Message(format!(
            "{} の実行ファイルが見つかりません。",
            descriptor.id.label()
        ))
    })?;

    let (model_path, model_name) = match engine_id {
        EngineId::RealCugan => {
            let model_path =
                find_directory_named(root, &["models-se", "models-pro", "models-nose"])
                    .ok_or_else(|| {
                        AppError::Message("Real-CUGAN のモデルフォルダが見つかりません。".into())
                    })?;
            validate_model_directory(&model_path, "Real-CUGAN")?;
            let model_name = model_path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.to_string());

            (model_path, model_name)
        }
        EngineId::Waifu2x => {
            let model_path = find_directory_named(
                root,
                &[
                    "models-cunet",
                    "models-upconv_7_anime_style_art_rgb",
                    "models-upconv_7_photo",
                ],
            )
            .ok_or_else(|| {
                AppError::Message("waifu2x のモデルフォルダが見つかりません。".into())
            })?;
            validate_model_directory(&model_path, "waifu2x")?;
            let model_name = model_path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.to_string());

            (model_path, model_name)
        }
        EngineId::RealEsrgan => {
            let model_root =
                find_directory_named(root, &["models"]).unwrap_or_else(|| root.to_path_buf());
            let model_name = find_realesrgan_model(&model_root).ok_or_else(|| {
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

fn candidate_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();

    for var_name in ["PRISMPAGE_ENGINE_PATHS"] {
        if let Some(value) = env::var_os(var_name) {
            roots.extend(env::split_paths(&value));
        }
    }

    if let Some(home) = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME")) {
        let downloads = PathBuf::from(home).join("Downloads");
        if downloads.is_dir() {
            roots.extend(
                WalkDir::new(&downloads)
                    .max_depth(3)
                    .into_iter()
                    .filter_map(Result::ok)
                    .filter(|entry| entry.file_type().is_dir())
                    .filter(|entry| {
                        let file_name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                        file_name.contains("realcugan")
                            || file_name.contains("real-cugan")
                            || file_name.contains("waifu2x")
                            || file_name.contains("realesrgan")
                            || file_name.contains("real-esrgan")
                            || entry.path().join("tools").is_dir()
                    })
                    .map(|entry| entry.into_path()),
            );
        }
    }

    for var_name in ["LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"] {
        if let Some(value) = env::var_os(var_name) {
            let root = PathBuf::from(value);
            for candidate in [
                "Real-CUGAN",
                "realcugan-ncnn-vulkan",
                "waifu2x",
                "waifu2x-ncnn-vulkan",
                "Real-ESRGAN",
                "realesrgan-ncnn-vulkan",
            ] {
                let path = root.join(candidate);
                if path.is_dir() {
                    roots.push(path);
                }
            }
        }
    }

    let mut deduped = Vec::new();
    for root in roots {
        if !root.is_dir() {
            continue;
        }

        let canonical = fs::canonicalize(&root).unwrap_or(root);
        if !deduped
            .iter()
            .any(|existing: &PathBuf| existing == &canonical)
        {
            deduped.push(canonical);
        }
    }

    deduped.sort_by_key(|root| candidate_root_priority(root));
    deduped
}

fn candidate_source(root: &Path) -> String {
    if root.join("tools").is_dir() {
        "既存ツール候補".into()
    } else {
        "PC 内の検出候補".into()
    }
}

fn source_label(source: &str) -> String {
    match source {
        "legacy" => "既存登録".into(),
        "directory" => "外部フォルダ".into(),
        "archive" => "ZIP 取込".into(),
        "download" => "アプリ内インストール".into(),
        "manual" => "手動登録".into(),
        value => value.to_string(),
    }
}

pub fn detect_engine_candidates() -> AppResult<Vec<EngineCandidate>> {
    let mut candidates = Vec::new();

    for root in candidate_roots() {
        for engine_id in [EngineId::RealCugan, EngineId::RealEsrgan, EngineId::Waifu2x] {
            let Ok(registration) = infer_registration(engine_id, &root) else {
                continue;
            };

            if candidates.iter().any(|candidate: &EngineCandidate| {
                candidate.id == engine_id
                    && candidate
                        .executable_path
                        .eq_ignore_ascii_case(&registration.executable_path)
            }) {
                continue;
            }

            candidates.push(EngineCandidate {
                id: engine_id,
                label: engine_id.label().to_string(),
                directory_path: root.to_string_lossy().to_string(),
                executable_path: registration.executable_path,
                model_path: registration.model_path,
                model_name: registration.model_name,
                source: candidate_source(&root),
            });
        }
    }

    Ok(candidates)
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

    Ok(TimedOutput {
        status,
        stdout,
        stderr,
    })
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
        source: registration.map(|item| source_label(&item.source)),
        warning,
        download_url: descriptor.download_url.to_string(),
        notes: descriptor
            .notes
            .iter()
            .map(|note| (*note).to_string())
            .collect(),
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

    Ok(all_engine_ids()
        .into_iter()
        .map(|engine_id| build_status(engine_id, registry.engines.get(&engine_id)))
        .collect())
}

pub fn get_engine_install_options() -> AppResult<EngineInstallOptionsResponse> {
    let client = github_client(Duration::from_secs(45))?;
    let mut options = Vec::new();
    let mut warnings = Vec::new();

    for engine_id in all_engine_ids() {
        match find_release_assets(&client, engine_id) {
            Ok(mut engine_options) => options.append(&mut engine_options),
            Err(error) => warnings.push(EngineInstallWarning {
                engine_id,
                label: engine_id.label().to_string(),
                message: error.to_string(),
            }),
        }
    }

    Ok(EngineInstallOptionsResponse { options, warnings })
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
    let root = canonicalize_existing_dir(
        Path::new(directory_path),
        "指定されたフォルダが見つかりません。",
    )?;

    let mut registry = load_registry(app)?;
    let mut registration = infer_registration(engine_id, &root)?;
    registration.source = "directory".into();
    registry.engines.insert(engine_id, registration);
    save_registry(app, &registry)?;

    Ok(build_status(engine_id, registry.engines.get(&engine_id)))
}

fn install_archive_from_path(
    app: &AppHandle,
    engine_id: EngineId,
    archive_path: &Path,
    source: &str,
) -> AppResult<EngineStatus> {
    let extraction_root = create_unique_extraction_root(app, engine_id)?;

    let result = (|| -> AppResult<EngineStatus> {
        let archive_file = fs::File::open(archive_path)?;
        let mut archive = ZipArchive::new(archive_file)?;

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

        let mut registry = load_registry(app)?;
        let mut registration = infer_registration(engine_id, &extraction_root)?;
        registration.source = source.into();
        registry.engines.insert(engine_id, registration);
        save_registry(app, &registry)?;
        Ok(build_status(engine_id, registry.engines.get(&engine_id)))
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(&extraction_root);
    }

    result
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
    let archive_path = Path::new(archive_path);
    if !archive_path.is_file() {
        return Err(AppError::Message(
            "指定された ZIP ファイルが見つかりません。".into(),
        ));
    }

    install_archive_from_path(app, engine_id, archive_path, "archive")
}

pub fn install_engine_from_release(
    app: &AppHandle,
    option: EngineInstallOption,
) -> AppResult<EngineStatus> {
    let client = github_client(Duration::from_secs(15 * 60))?;
    let verified_option = verify_release_option(&client, &option)?;
    let downloads_root = tools_dir(app, verified_option.engine_id)?.join("_downloads");
    fs::create_dir_all(&downloads_root)?;
    let temp_dir = tempfile::Builder::new()
        .prefix("release-")
        .tempdir_in(downloads_root)?;
    let archive_path = temp_dir.path().join("engine.zip");
    download_release_archive(&client, &verified_option, &archive_path)?;

    let registry_lock = app.state::<RegistryLock>();
    let _guard = registry_lock
        .0
        .lock()
        .map_err(|_| AppError::Message("AI エンジン設定の排他制御に失敗しました。".into()))?;

    install_archive_from_path(app, verified_option.engine_id, &archive_path, "download")
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

fn encode_png_data_url(bytes: &[u8]) -> String {
    format!("data:image/png;base64,{}", BASE64_STANDARD.encode(bytes))
}

fn load_engine_registration(app: &AppHandle, engine_id: EngineId) -> AppResult<EngineRegistration> {
    let registry_lock = app.state::<RegistryLock>();
    let _guard = registry_lock
        .0
        .lock()
        .map_err(|_| AppError::Message("AI エンジン設定の排他制御に失敗しました。".into()))?;
    let registry = load_registry(app)?;
    registry.engines.get(&engine_id).cloned().ok_or_else(|| {
        AppError::Message("選択した AI エンジンはまだ登録されていません。".into())
    })
}

fn run_enhancement_command(
    app: &AppHandle,
    engine_id: EngineId,
    scale: u8,
    image_data_url: &str,
) -> AppResult<Vec<u8>> {
    let registration = load_engine_registration(app, engine_id)?;

    let temp_dir = tempdir()?;
    let input_path = temp_dir.path().join("input.png");
    let output_path = temp_dir.path().join("output.png");
    fs::write(&input_path, decode_data_url(image_data_url)?)?;

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

    let scale_arg = scale.to_string();

    match engine_id {
        EngineId::RealCugan => {
            command
                .arg("-i")
                .arg(input_path.to_string_lossy().as_ref())
                .arg("-o")
                .arg(output_path.to_string_lossy().as_ref())
                .arg("-s")
                .arg(&scale_arg)
                .arg("-n")
                .arg("0")
                .arg("-m")
                .arg(registration.model_path.as_str())
                .arg("-t")
                .arg("0")
                .arg("-f")
                .arg("png");
        }
        EngineId::Waifu2x => {
            command
                .arg("-i")
                .arg(input_path.to_string_lossy().as_ref())
                .arg("-o")
                .arg(output_path.to_string_lossy().as_ref())
                .arg("-s")
                .arg(&scale_arg)
                .arg("-n")
                .arg("1")
                .arg("-m")
                .arg(registration.model_path.as_str())
                .arg("-f")
                .arg("png");
        }
        EngineId::RealEsrgan => {
            let model_name = ensure_realesrgan_model_available(&registration, scale)?;
            command
                .arg("-i")
                .arg(input_path.to_string_lossy().as_ref())
                .arg("-o")
                .arg(output_path.to_string_lossy().as_ref())
                .arg("-s")
                .arg(&scale_arg)
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
    Ok(enhanced_bytes)
}

fn normalize_book_id(book_id: &str) -> AppResult<String> {
    Uuid::parse_str(book_id)
        .map(|id| id.to_string())
        .map_err(|_| AppError::Message("書籍 ID の形式が不正です。".into()))
}

fn normalize_image_hash(image_hash: &str) -> AppResult<String> {
    let normalized = image_hash.trim().to_ascii_lowercase();

    if normalized.len() != 64
        || !normalized
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(AppError::Message(
            "画像キャッシュキーは 64 桁の hex 文字列で指定してください。".into(),
        ));
    }

    Ok(normalized)
}

fn enhanced_image_cache_path(
    app: &AppHandle,
    book_id: &str,
    engine_id: EngineId,
    scale: u8,
    image_hash: &str,
) -> AppResult<PathBuf> {
    let book_id = normalize_book_id(book_id)?;
    let image_hash = normalize_image_hash(image_hash)?;
    let cache_dir = app_data_dir(app)?
        .join("enhanced-images")
        .join(book_id)
        .join(engine_id.as_str())
        .join(scale.to_string());

    fs::create_dir_all(&cache_dir)?;
    Ok(cache_dir.join(format!("{image_hash}.png")))
}

pub fn enhance_image(
    app: &AppHandle,
    request: EnhanceImageRequest,
) -> AppResult<EnhanceImageResponse> {
    let enhanced_bytes = run_enhancement_command(
        app,
        request.engine_id,
        request.scale,
        &request.image_data_url,
    )?;

    Ok(EnhanceImageResponse {
        image_data_url: encode_png_data_url(&enhanced_bytes),
    })
}

pub fn enhance_book_image(
    app: &AppHandle,
    request: EnhanceBookImageRequest,
) -> AppResult<EnhanceBookImageResponse> {
    let cache_path = enhanced_image_cache_path(
        app,
        &request.book_id,
        request.engine_id,
        request.scale,
        &request.image_hash,
    )?;
    decode_data_url(&request.image_data_url)?;

    let enhancement_lock = app.state::<EnhancementLock>();
    let _guard = enhancement_lock
        .0
        .lock()
        .map_err(|_| AppError::Message("AI 画像キャッシュの排他制御に失敗しました。".into()))?;

    if cache_path.is_file() {
        let cached_bytes = fs::read(cache_path)?;
        return Ok(EnhanceBookImageResponse {
            cache_hit: true,
            image_data_url: encode_png_data_url(&cached_bytes),
        });
    }

    let enhanced_bytes = run_enhancement_command(
        app,
        request.engine_id,
        request.scale,
        &request.image_data_url,
    )?;

    fs::write(&cache_path, &enhanced_bytes)?;

    Ok(EnhanceBookImageResponse {
        cache_hit: false,
        image_data_url: encode_png_data_url(&enhanced_bytes),
    })
}
