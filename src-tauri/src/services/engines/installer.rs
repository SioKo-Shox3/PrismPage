//! エンジンの取得と展開。公式 GitHub Releases からの ZIP 取得と、ZIP の安全な展開(パス検証・上限)を扱う。

use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::{StatusCode, Url};
use serde::Deserialize;
use uuid::Uuid;

use crate::app_error::{AppError, AppResult};
use crate::models::{EngineId, EngineInstallOption};
use crate::services::source::zip_archive::{open_checked_archive, ZipLimits};

use super::registry::now_unix;

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

const MAX_RELEASE_ARCHIVE_BYTES: u64 = 1024 * 1024 * 1024;

/// ZIP 展開の上限。展開後の合計サイズとエントリ数で、ZIP 爆弾や異常な配布物を止める。
#[derive(Debug, Clone, Copy)]
pub(super) struct ExtractLimits {
    pub max_total_bytes: u64,
    pub max_entries: usize,
}

/// 公式配布(数十〜数百 MB・数百ファイル)に十分な余裕を持たせた既定の上限。
pub(super) const DEFAULT_EXTRACT_LIMITS: ExtractLimits = ExtractLimits {
    max_total_bytes: 4 * 1024 * 1024 * 1024,
    max_entries: 20_000,
};

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

/// `tools_root` の下にエンジンごとの展開先を、既存と重ならない名前で作る。
pub(super) fn create_unique_extraction_root(tools_root: &Path) -> AppResult<PathBuf> {
    fs::create_dir_all(tools_root)?;

    for _ in 0..16 {
        let candidate = tools_root.join(format!("{}-{}", now_unix(), Uuid::new_v4()));
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

/// ZIP を `destination`(空のフォルダ)へ展開する。ZIP の外を指すパスは拒み、
/// エントリ数と展開後の合計サイズが上限を超えたら止める。合計サイズは宣言値ではなく実際に書いた量で数える。
/// 失敗時の後片付け(展開先の削除)は呼び出し側が行う。
/// `on_progress` は項目を 1 つ書き終えるたびに(書き終えた数, 全体の数)で呼ぶ。
pub(super) fn extract_archive(
    archive_path: &Path,
    destination: &Path,
    limits: ExtractLimits,
    on_progress: &mut dyn FnMut(u64, u64),
) -> AppResult<()> {
    // zip クレートは同名のエントリを 1 件にまとめるため、件数は中央ディレクトリの記録をたどって数える
    // (同名のエントリを持つ ZIP はそれだけで拒む)。
    let mut archive = open_checked_archive(
        archive_path,
        ZipLimits {
            max_entries: limits.max_entries,
            max_page_bytes: limits.max_total_bytes,
        },
    )?;

    let mut written_total = 0_u64;
    let entry_count = archive.len() as u64;
    on_progress(0, entry_count);

    for index in 0..archive.len() {
        let mut file = archive.by_index(index)?;
        let enclosed = file
            .enclosed_name()
            .ok_or_else(|| AppError::Message("ZIP 内に危険なパスが含まれています。".into()))?;

        let output_path = destination.join(enclosed);
        if file.is_dir() {
            fs::create_dir_all(&output_path)?;
            on_progress(index as u64 + 1, entry_count);
            continue;
        }

        if file.size() > limits.max_total_bytes - written_total {
            return Err(extracted_size_error(limits));
        }

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let remaining = limits.max_total_bytes - written_total;
        let mut destination_file = fs::File::create(&output_path)?;
        // 宣言サイズを偽った ZIP でも上限を超えて書かないよう、残り枠 + 1 バイトまでで読むのを打ち切る。
        let copied = std::io::copy(
            &mut (&mut file).take(remaining.saturating_add(1)),
            &mut destination_file,
        )?;
        destination_file.flush()?;

        if copied > remaining {
            return Err(extracted_size_error(limits));
        }
        written_total += copied;
        on_progress(index as u64 + 1, entry_count);
    }

    Ok(())
}

fn extracted_size_error(limits: ExtractLimits) -> AppError {
    AppError::Message(format!(
        "AI エンジン ZIP の展開後のサイズが上限({} MB)を超えています。",
        limits.max_total_bytes / (1024 * 1024)
    ))
}

pub(super) fn github_client(timeout: Duration) -> AppResult<Client> {
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

/// 公式リリースから、インストールできる Windows 向け ZIP の一覧を作る。
pub(super) fn find_release_assets(
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

/// フロントから渡された選択肢を、公式 API の内容と突き合わせて確かめ直す。
pub(super) fn verify_release_option(
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

/// ダウンロードの進み具合を知らせる間隔(バイト数)。
const DOWNLOAD_PROGRESS_STEP: u64 = 512 * 1024;

fn copy_response_with_limit(
    response: &mut impl Read,
    output: &mut fs::File,
    engine_label: &str,
    on_progress: &mut dyn FnMut(u64),
) -> AppResult<u64> {
    let mut reported = 0_u64;
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
        if downloaded_size - reported >= DOWNLOAD_PROGRESS_STEP {
            reported = downloaded_size;
            on_progress(downloaded_size);
        }
    }

    on_progress(downloaded_size);
    Ok(downloaded_size)
}

/// 確かめ済みの選択肢の ZIP を `output_path` へ落とす。サイズが公式 API の値と一致しなければ失敗にする。
/// `on_progress` は落としたバイト数で、およそ 512 KB ごとと終わりに呼ぶ。
pub(super) fn download_release_archive(
    client: &Client,
    option: &EngineInstallOption,
    output_path: &Path,
    on_progress: &mut dyn FnMut(u64),
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
    let downloaded_size = copy_response_with_limit(&mut response, &mut output, engine_label, on_progress)?;
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

#[cfg(test)]
mod tests {
    use zip::write::SimpleFileOptions;
    use zip::{ZipArchive, ZipWriter};

    use super::*;

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let mut writer = ZipWriter::new(fs::File::create(path).unwrap());
        for (name, data) in entries {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(data).unwrap();
        }
        writer.finish().unwrap();
    }

    fn limits(max_total_bytes: u64, max_entries: usize) -> ExtractLimits {
        ExtractLimits {
            max_total_bytes,
            max_entries,
        }
    }

    #[test]
    fn extracts_within_limits() {
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("engine.zip");
        write_zip(
            &zip_path,
            &[("tool/a.exe", b"12345"), ("tool/models/b.bin", b"67890")],
        );
        let out = dir.path().join("out");
        fs::create_dir(&out).unwrap();

        let mut progress = Vec::new();
        extract_archive(&zip_path, &out, limits(10, 2), &mut |done, total| {
            progress.push((done, total))
        })
        .unwrap();
        assert_eq!(progress, vec![(0, 2), (1, 2), (2, 2)]);
        assert_eq!(fs::read(out.join("tool/a.exe")).unwrap(), b"12345");
        assert_eq!(fs::read(out.join("tool/models/b.bin")).unwrap(), b"67890");
    }

    #[test]
    fn rejects_too_many_entries() {
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("engine.zip");
        write_zip(&zip_path, &[("a", b"1"), ("b", b"2"), ("c", b"3")]);
        let out = dir.path().join("out");
        fs::create_dir(&out).unwrap();

        let error = extract_archive(&zip_path, &out, limits(1024, 2), &mut |_, _| {}).unwrap_err();
        assert!(error.to_string().contains("多すぎる"), "{error}");
        assert_eq!(fs::read_dir(&out).unwrap().count(), 0);
    }

    #[test]
    fn rejects_total_size_over_limit() {
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("engine.zip");
        write_zip(&zip_path, &[("a", &[0_u8; 600]), ("b", &[0_u8; 600])]);
        let out = dir.path().join("out");
        fs::create_dir(&out).unwrap();

        let error = extract_archive(&zip_path, &out, limits(1000, 10), &mut |_, _| {}).unwrap_err();
        assert!(error.to_string().contains("展開後のサイズ"), "{error}");
        assert!(!out.join("b").exists());
    }

    /// 中央ディレクトリの宣言サイズを小さく偽った ZIP でも、実際に書いた量で上限を止める。
    #[test]
    fn rejects_size_that_lies_in_header() {
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("engine.zip");
        write_zip(&zip_path, &[("a", &[7_u8; 5000])]);

        // 格納(無圧縮)ではなく deflate なので、中央ディレクトリの非圧縮サイズ(オフセット 24)を 1 に書き換える。
        let mut bytes = fs::read(&zip_path).unwrap();
        let cd = bytes
            .windows(4)
            .rposition(|window| window == [0x50, 0x4b, 0x01, 0x02])
            .unwrap();
        bytes[cd + 24..cd + 28].copy_from_slice(&1_u32.to_le_bytes());
        let local_size = 22;
        bytes[local_size..local_size + 4].copy_from_slice(&1_u32.to_le_bytes());
        fs::write(&zip_path, &bytes).unwrap();

        let out = dir.path().join("out");
        fs::create_dir(&out).unwrap();
        let result = extract_archive(&zip_path, &out, limits(1000, 10), &mut |_, _| {});
        let error = result.unwrap_err();
        assert!(error.to_string().contains("展開後のサイズ"), "{error}");
        let written = fs::metadata(out.join("a")).map(|m| m.len()).unwrap_or(0);
        assert!(written <= 1001, "上限を超えて書いた: {written}");
    }

    /// 同名のエントリで件数を少なく見せる ZIP も、記録の数で上限を数えて拒む。
    #[test]
    fn rejects_duplicate_names_that_hide_entries() {
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("engine.zip");
        write_zip(&zip_path, &[("dupname1", b"1"), ("dupname2", b"2")]);
        // 2 つ目の名前を 1 つ目と同じバイト列に書き換える(名前は CRC に含まれない)。
        let bytes = fs::read(&zip_path).unwrap();
        let replaced = bytes
            .windows(8)
            .enumerate()
            .filter(|(_, window)| *window == b"dupname2")
            .map(|(at, _)| at)
            .collect::<Vec<_>>();
        assert_eq!(replaced.len(), 2);
        let mut bytes = bytes;
        for at in replaced {
            bytes[at + 7] = b'1';
        }
        fs::write(&zip_path, &bytes).unwrap();
        // 前提: zip クレートからは 1 件に見える。
        assert_eq!(
            ZipArchive::new(fs::File::open(&zip_path).unwrap())
                .unwrap()
                .len(),
            1
        );

        for max_entries in [1, 10] {
            let out = dir.path().join(format!("out{max_entries}"));
            fs::create_dir(&out).unwrap();
            assert!(extract_archive(&zip_path, &out, limits(1024, max_entries), &mut |_, _| {}).is_err());
            assert_eq!(fs::read_dir(&out).unwrap().count(), 0);
        }
    }

    #[test]
    fn rejects_path_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("engine.zip");
        write_zip(&zip_path, &[("../escape.txt", b"x")]);
        let out = dir.path().join("out");
        fs::create_dir(&out).unwrap();

        assert!(extract_archive(&zip_path, &out, DEFAULT_EXTRACT_LIMITS, &mut |_, _| {}).is_err());
        assert!(!dir.path().join("escape.txt").exists());
    }

    #[test]
    fn release_url_must_be_official_github_asset() {
        let mut option = EngineInstallOption {
            engine_id: EngineId::RealCugan,
            label: String::new(),
            release_name: "v1".into(),
            release_tag: "v1".into(),
            asset_name: "realcugan-ncnn-vulkan-20220728-windows.zip".into(),
            download_url: "https://github.com/nihui/realcugan-ncnn-vulkan/releases/download/v1/realcugan-ncnn-vulkan-20220728-windows.zip".into(),
            size: 1,
        };
        assert!(validate_release_option(&option).is_ok());

        option.download_url =
            "https://example.com/nihui/realcugan-ncnn-vulkan/releases/download/v1/x.zip".into();
        assert!(validate_release_option(&option).is_err());
        option.download_url =
            "https://github.com/someone/realcugan-ncnn-vulkan/releases/download/v1/x.zip".into();
        assert!(validate_release_option(&option).is_err());
    }
}
