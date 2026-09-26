//! エンジンの登録簿(`<アプリのデータ領域>/engines/registry.json`)と、フォルダからの登録内容の推定。
//! 登録簿の形式は作り直し前のものをそのまま読み書きする。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use std::{env, fs};

use walkdir::WalkDir;

use crate::app_error::{AppError, AppResult};
use crate::models::{EngineCandidate, EngineId, EngineRegistration, EngineRegistry};

pub(super) struct EngineDescriptor {
    pub id: EngineId,
    pub download_url: &'static str,
    pub executable_names: &'static [&'static str],
    pub notes: &'static [&'static str],
}

const REALESRGAN_ANIME_MODEL: &str = "realesr-animevideov3";
const REALESRGAN_ANIME_SCALE_MODELS: [&str; 3] = [
    "realesr-animevideov3-x2",
    "realesr-animevideov3-x3",
    "realesr-animevideov3-x4",
];
const REALESRGAN_FALLBACK_MODELS: [&str; 2] = ["realesrgan-x4plus-anime", "realesrgan-x4plus"];

pub(super) fn descriptor(engine_id: EngineId) -> EngineDescriptor {
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

pub(super) fn all_engine_ids() -> [EngineId; 3] {
    [EngineId::RealCugan, EngineId::Waifu2x, EngineId::RealEsrgan]
}

pub(super) fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// 登録簿を読む。無ければ空の登録簿を返す。
pub(super) fn load_registry(path: &Path) -> AppResult<EngineRegistry> {
    if !path.exists() {
        return Ok(EngineRegistry::default());
    }

    let content = fs::read_to_string(path)?;
    Ok(serde_json::from_str(&content)?)
}

/// 登録簿を書く。書きかけのファイルを残さないよう、同じフォルダの一時ファイルへ書いてから置き換える。
pub(super) fn save_registry(path: &Path, registry: &EngineRegistry) -> AppResult<()> {
    let directory = path
        .parent()
        .ok_or_else(|| AppError::Message("AI エンジン登録簿の保存先が不正です。".into()))?;
    fs::create_dir_all(directory)?;
    let mut temp = tempfile::NamedTempFile::new_in(directory)?;
    std::io::Write::write_all(&mut temp, &serde_json::to_vec_pretty(registry)?)?;
    temp.persist(path)
        .map_err(|error| AppError::from(error.error))?;
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

fn find_realesrgan_model(model_root: &Path) -> Option<String> {
    if has_realesrgan_anime_model(model_root) {
        return Some(REALESRGAN_ANIME_MODEL.to_string());
    }

    REALESRGAN_FALLBACK_MODELS
        .iter()
        .find(|model_name| model_pair_exists(model_root, model_name))
        .map(|model_name| (*model_name).to_string())
}

fn validate_model_directory(model_path: &Path, engine_label: &str) -> AppResult<()> {
    if !directory_has_model_pair(model_path) {
        return Err(AppError::Message(format!(
            "{engine_label} のモデルファイルが見つかりません。"
        )));
    }

    Ok(())
}

/// フォルダの中から実行ファイルとモデルを探し、登録内容を組み立てる。
pub(super) fn infer_registration(
    engine_id: EngineId,
    root: &Path,
) -> AppResult<EngineRegistration> {
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

pub(super) fn source_label(source: &str) -> String {
    match source {
        "legacy" => "既存登録".into(),
        "directory" => "外部フォルダ".into(),
        "archive" => "ZIP 取込".into(),
        "download" => "アプリ内インストール".into(),
        "manual" => "手動登録".into(),
        value => value.to_string(),
    }
}

/// よく使われる置き場所からエンジンのフォルダを探す(登録はしない)。
pub(super) fn detect_candidates() -> Vec<EngineCandidate> {
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

    candidates
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 作り直し前のアプリが書いた登録簿(`source` の無い古い項目を含む)をそのまま読めること。
    #[test]
    fn reads_existing_registry_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.json");
        fs::write(
            &path,
            r#"{
  "engines": {
    "real-cugan": {
      "executablePath": "C:\\tools\\realcugan\\realcugan-ncnn-vulkan.exe",
      "modelName": "models-se",
      "modelPath": "C:\\tools\\realcugan\\models-se",
      "registeredAt": 1700000000
    },
    "real-esrgan": {
      "executablePath": "C:\\tools\\esrgan\\realesrgan-ncnn-vulkan.exe",
      "modelName": "realesr-animevideov3",
      "modelPath": "C:\\tools\\esrgan\\models",
      "registeredAt": 1700000001,
      "source": "download"
    },
    "waifu2x": {
      "executablePath": "C:\\tools\\waifu2x\\waifu2x-ncnn-vulkan.exe",
      "modelName": null,
      "modelPath": "C:\\tools\\waifu2x\\models-cunet",
      "registeredAt": 1700000002,
      "source": "archive"
    }
  }
}"#,
        )
        .unwrap();

        let registry = load_registry(&path).unwrap();
        assert_eq!(registry.engines.len(), 3);
        let cugan = &registry.engines[&EngineId::RealCugan];
        assert_eq!(cugan.model_name.as_deref(), Some("models-se"));
        assert_eq!(cugan.source, "legacy");
        assert_eq!(registry.engines[&EngineId::RealEsrgan].source, "download");
        assert_eq!(registry.engines[&EngineId::Waifu2x].model_name, None);

        // 書き戻しても同じ内容で読める。
        save_registry(&path, &registry).unwrap();
        let reread = load_registry(&path).unwrap();
        assert_eq!(reread.engines.len(), 3);
        assert_eq!(
            reread.engines[&EngineId::RealCugan].registered_at,
            1700000000
        );
    }

    #[test]
    fn missing_registry_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let registry = load_registry(&dir.path().join("registry.json")).unwrap();
        assert!(registry.engines.is_empty());
    }
}
