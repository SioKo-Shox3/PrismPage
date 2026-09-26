//! 超解像の設定(エンジン・モデル・倍率・ノイズ除去)の検証と、結果のキャッシュのキー・置き場所。
//! キーは `prism` スキームの `/page/<bookId>/<index>/enhanced/<key>` にそのまま載る形(小文字英数字と `-`、64 文字以内)。

// 倍率・ノイズ除去の一覧は A-04 の設定画面から使う。それまではテストだけが呼ぶ。
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use crate::app_error::{AppError, AppResult};
use crate::models::{EngineId, PageInfo};

/// キャッシュの置き場所(アプリのデータ領域の下)。
pub const ENHANCED_CACHE_DIR: &str = "enhanced";

/// 1 回の超解像の設定。`denoise` はエンジンの `-n` に渡す値で、ノイズ除去の指定が無いエンジン(Real-ESRGAN)は `None`。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct EnhanceParams {
    pub engine: EngineId,
    pub model: String,
    pub scale: u8,
    pub denoise: Option<i8>,
}

/// エンジンとモデルの組で選べる倍率。未知のモデルはエラーにする(選べない値を見せないため)。
pub fn supported_scales(engine: EngineId, model: &str) -> AppResult<&'static [u8]> {
    let scales: &'static [u8] = match (engine, model) {
        // models-se は up2x/up3x/up4x、models-pro は up2x/up3x、models-nose は up2x だけを持つ。
        (EngineId::RealCugan, "models-se") => &[2, 3, 4],
        (EngineId::RealCugan, "models-pro") => &[2, 3],
        (EngineId::RealCugan, "models-nose") => &[2],
        // waifu2x は 2 倍のモデルを繰り返し当てて 4 倍にする。
        (
            EngineId::Waifu2x,
            "models-cunet" | "models-upconv_7_anime_style_art_rgb" | "models-upconv_7_photo",
        ) => &[2, 4],
        (EngineId::RealEsrgan, "realesr-animevideov3") => &[2, 3, 4],
        (EngineId::RealEsrgan, "realesr-animevideov3-x2") => &[2],
        (EngineId::RealEsrgan, "realesr-animevideov3-x3") => &[3],
        (EngineId::RealEsrgan, "realesr-animevideov3-x4") => &[4],
        (EngineId::RealEsrgan, "realesrgan-x4plus" | "realesrgan-x4plus-anime") => &[4],
        _ => return Err(unknown_model(engine, model)),
    };
    Ok(scales)
}

/// エンジン・モデル・倍率の組で選べるノイズ除去の値。空ならノイズ除去を指定しない(`None` だけを受け付ける)。
pub fn supported_denoise_levels(
    engine: EngineId,
    model: &str,
    scale: u8,
) -> AppResult<&'static [i8]> {
    validate_scale(engine, model, scale)?;
    let levels: &'static [i8] = match (engine, model, scale) {
        // Real-CUGAN の -1 は conservative、0 はノイズ除去なし。3・4 倍と pro は denoise1x/2x を持たない。
        (EngineId::RealCugan, "models-se", 2) => &[-1, 0, 1, 2, 3],
        (EngineId::RealCugan, "models-se" | "models-pro", _) => &[-1, 0, 3],
        // models-nose(no-denoise だけ)。validate_scale を通った Real-CUGAN のモデルは上の 2 つとこれだけ。
        (EngineId::RealCugan, _, _) => &[0],
        (EngineId::Waifu2x, _, _) => &[-1, 0, 1, 2, 3],
        (EngineId::RealEsrgan, _, _) => &[],
    };
    Ok(levels)
}

fn unknown_model(engine: EngineId, model: &str) -> AppError {
    AppError::Message(format!(
        "{} のモデル「{model}」には対応していません。",
        engine.label()
    ))
}

fn validate_scale(engine: EngineId, model: &str, scale: u8) -> AppResult<()> {
    if supported_scales(engine, model)?.contains(&scale) {
        Ok(())
    } else {
        Err(AppError::Message(format!(
            "{} のモデル「{model}」は {scale} 倍に対応していません。",
            engine.label()
        )))
    }
}

/// 設定全体を検証する。対応しない倍率・ノイズ除去の値は拒否する。
pub fn validate_params(params: &EnhanceParams) -> AppResult<()> {
    let levels = supported_denoise_levels(params.engine, &params.model, params.scale)?;
    let accepted = match params.denoise {
        None => levels.is_empty(),
        Some(level) => levels.contains(&level),
    };
    if accepted {
        Ok(())
    } else {
        Err(AppError::Message(format!(
            "{} のモデル「{}」の {} 倍では、そのノイズ除去の指定は使えません。",
            params.engine.label(),
            params.model,
            params.scale
        )))
    }
}

/// 32 ビット FNV-1a。キーに入れるモデル名の要約に使う(Rust の既定のハッシュは版をまたいで安定しないため自前で持つ)。
fn fnv1a32(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0x811c_9dc5_u32, |hash, byte| {
        (hash ^ u32::from(*byte)).wrapping_mul(0x0100_0193)
    })
}

/// 設定からキャッシュのキーを作る。検証を通らない設定には作らない。
/// 形は `<engine>-<モデル名の要約>-<モデル名のハッシュ>-x<倍率>-<ノイズ除去>`。モデル名は大文字や `_` を含みうるので、
/// 読める要約(小文字英数字だけ、16 文字まで)に元の名前のハッシュを添えて、別のモデルが同じキーにならないようにする。
pub fn cache_key(params: &EnhanceParams) -> AppResult<String> {
    validate_params(params)?;
    let slug: String = params
        .model
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .take(16)
        .collect();
    let denoise = match params.denoise {
        None => "dnone".to_string(),
        Some(level) if level < 0 => format!("dm{}", level.unsigned_abs()),
        Some(level) => format!("d{level}"),
    };
    Ok(format!(
        "{}-{}-{:08x}-x{}-{}",
        params.engine.as_str(),
        slug,
        fnv1a32(params.model.as_bytes()),
        params.scale,
        denoise
    ))
}

fn is_book_id(value: &str) -> bool {
    value.len() == 16
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// ページの中身の目印。本 ID は本の場所から作るので、本の中身が変わる(画像を足す・差し替える)と
/// 同じページ番号が別の画像を指しうる。ページの名前・寸法と、ページソースが返す中身の目印
/// (`PageSource::page_revision`。ZIP は CRC-32 とサイズ、フォルダはサイズと更新日時)の要約を
/// 置き場所に含め、別の画像の結果を返さない。
fn page_tag(page: &PageInfo, revision: Option<u64>) -> String {
    let revision = revision
        .map(|value| format!("{value:016x}"))
        .unwrap_or_default();
    let identity = format!(
        "{}\u{0}{}x{}\u{0}{revision}",
        page.name, page.width, page.height
    );
    format!("{:08x}", fnv1a32(identity.as_bytes()))
}

/// 1 ページ分の結果の置き場所 `<cache_root>/<bookId>/<index>-<ページの目印>/<key>.png`。
/// 本 ID とキーの形を確かめ、キャッシュの外を指すパスを作らない。
pub fn cache_entry_path(
    cache_root: &Path,
    book_id: &str,
    index: usize,
    page: &PageInfo,
    revision: Option<u64>,
    key: &str,
) -> AppResult<PathBuf> {
    if !is_book_id(book_id) || !is_key(key) {
        return Err(AppError::Message(
            "超解像キャッシュの指定が不正です。".into(),
        ));
    }
    Ok(cache_root
        .join(book_id)
        .join(format!("{index}-{}", page_tag(page, revision)))
        .join(format!("{key}.png")))
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    fn page(name: &str, width: u32, height: u32) -> PageInfo {
        PageInfo {
            name: name.into(),
            width,
            height,
            spread: None,
        }
    }

    fn params(engine: EngineId, model: &str, scale: u8, denoise: Option<i8>) -> EnhanceParams {
        EnhanceParams {
            engine,
            model: model.into(),
            scale,
            denoise,
        }
    }

    #[test]
    fn key_changes_with_every_field() {
        let base = params(EngineId::RealCugan, "models-se", 2, Some(-1));
        let variants = [
            base.clone(),
            params(EngineId::RealCugan, "models-pro", 2, Some(-1)),
            params(EngineId::RealCugan, "models-se", 3, Some(-1)),
            params(EngineId::RealCugan, "models-se", 2, Some(0)),
            params(EngineId::RealCugan, "models-se", 2, Some(3)),
            params(EngineId::Waifu2x, "models-cunet", 2, Some(-1)),
            params(EngineId::RealEsrgan, "realesr-animevideov3", 2, None),
        ];
        let keys: HashSet<String> = variants.iter().map(|p| cache_key(p).unwrap()).collect();
        assert_eq!(keys.len(), variants.len());
        // 同じ設定からは同じキー。
        assert_eq!(cache_key(&base).unwrap(), cache_key(&base.clone()).unwrap());
    }

    #[test]
    fn key_fits_the_uri_scheme() {
        for p in [
            params(
                EngineId::Waifu2x,
                "models-upconv_7_anime_style_art_rgb",
                4,
                Some(-1),
            ),
            params(EngineId::RealEsrgan, "realesrgan-x4plus-anime", 4, None),
            params(EngineId::RealCugan, "models-se", 4, Some(3)),
        ] {
            let key = cache_key(&p).unwrap();
            assert!(is_key(&key), "{key}");
        }
        assert_eq!(
            cache_key(&params(EngineId::RealCugan, "models-se", 2, Some(-1))).unwrap(),
            format!("real-cugan-modelsse-{:08x}-x2-dm1", fnv1a32(b"models-se"))
        );
    }

    #[test]
    fn scales_follow_engine_and_model() {
        assert_eq!(
            supported_scales(EngineId::RealCugan, "models-se").unwrap(),
            &[2, 3, 4]
        );
        assert_eq!(
            supported_scales(EngineId::RealCugan, "models-pro").unwrap(),
            &[2, 3]
        );
        assert_eq!(
            supported_scales(EngineId::Waifu2x, "models-cunet").unwrap(),
            &[2, 4]
        );
        assert_eq!(
            supported_scales(EngineId::RealEsrgan, "realesrgan-x4plus").unwrap(),
            &[4]
        );
        assert!(supported_scales(EngineId::RealEsrgan, "models-se").is_err());
        assert!(supported_scales(EngineId::RealCugan, "../models-se").is_err());
    }

    #[test]
    fn rejects_unsupported_scale_and_denoise() {
        for bad in [
            params(EngineId::RealCugan, "models-pro", 4, Some(-1)),
            params(EngineId::RealCugan, "models-se", 3, Some(1)),
            params(EngineId::RealCugan, "models-se", 1, Some(0)),
            params(EngineId::RealCugan, "models-se", 2, None),
            params(EngineId::Waifu2x, "models-cunet", 3, Some(0)),
            params(EngineId::RealEsrgan, "realesrgan-x4plus", 2, None),
            params(EngineId::RealEsrgan, "realesr-animevideov3", 2, Some(0)),
            params(EngineId::RealEsrgan, "unknown", 4, None),
        ] {
            assert!(validate_params(&bad).is_err(), "{bad:?}");
            assert!(cache_key(&bad).is_err(), "{bad:?}");
        }
        assert!(validate_params(&params(EngineId::RealCugan, "models-se", 4, Some(3))).is_ok());
    }

    #[test]
    fn entry_path_stays_inside_cache_root() {
        let root = Path::new("cache");
        let key = cache_key(&params(EngineId::RealCugan, "models-se", 2, Some(0))).unwrap();
        let page = page("001.png", 800, 1200);
        let path = cache_entry_path(root, "0123456789abcdef", 12, &page, Some(7), &key).unwrap();
        assert_eq!(
            path,
            root.join("0123456789abcdef")
                .join(format!("12-{}", page_tag(&page, Some(7))))
                .join(format!("{key}.png"))
        );
        assert!(cache_entry_path(root, "../../etc", 0, &page, None, &key).is_err());
        assert!(cache_entry_path(root, "0123456789abcdef", 0, &page, None, "../x").is_err());
        assert!(cache_entry_path(root, "0123456789abcdef", 0, &page, None, "").is_err());
    }

    /// 本の中身が変わって同じ番号が別の画像を指すと、置き場所も変わる(前の結果を返さない)。
    #[test]
    fn entry_path_changes_when_the_page_changes() {
        let root = Path::new("cache");
        let key = cache_key(&params(EngineId::RealCugan, "models-se", 2, Some(0))).unwrap();
        let path = |page: &PageInfo, revision: Option<u64>| {
            cache_entry_path(root, "0123456789abcdef", 0, page, revision, &key).unwrap()
        };
        let original = path(&page("001.png", 800, 1200), Some(1));
        assert_eq!(original, path(&page("001.png", 800, 1200), Some(1)));
        assert_ne!(original, path(&page("000.png", 800, 1200), Some(1)));
        assert_ne!(original, path(&page("001.png", 800, 1201), Some(1)));
        // 同じ名前・寸法のまま中身だけが差し替えられた。
        assert_ne!(original, path(&page("001.png", 800, 1200), Some(2)));
        assert_ne!(original, path(&page("001.png", 800, 1200), None));
    }
}
