//! 画像の先頭だけを読んで寸法(幅, 高さ)を得る。フォルダ内のファイルにもアーカイブ内の
//! エントリ(シークできない展開ストリーム)にも使えるよう、`Read` から少しずつ読み足す。

use std::io::Read;

/// 最初に読む量。JPEG は EXIF のサムネイルの後ろに寸法があるので足りなければ倍々で読み足す。
const INITIAL_READ: usize = 64 * 1024;

/// `reader` の先頭から寸法を読む。`limit` バイトまで読んでも決まらなければ `None`。
/// 幅・高さのどちらかが 0 の画像も表示できないので `None` にする。
pub fn read_dimensions<R: Read>(reader: R, limit: u64) -> Option<(u32, u32)> {
    let mut reader = reader.take(limit);
    let mut buffer = Vec::new();
    let mut target = INITIAL_READ;
    loop {
        let wanted = target.saturating_sub(buffer.len()) as u64;
        let read = (&mut reader).take(wanted).read_to_end(&mut buffer).ok()?;
        if let Some(size) = dimensions_from_header(&buffer) {
            return Some(size);
        }
        if (read as u64) < wanted {
            // 終端(または上限)まで読んだのに決まらない。
            return None;
        }
        target = target.saturating_mul(2);
    }
}

/// 読んだ先頭部分から寸法を得る。足りなければ `None`。
pub fn dimensions_from_header(header: &[u8]) -> Option<(u32, u32)> {
    let (width, height) = if header.starts_with(b"BM") {
        bmp_dimensions(header)?
    } else {
        let size = imagesize::blob_size(header).ok()?;
        (
            u32::try_from(size.width).ok()?,
            u32::try_from(size.height).ok()?,
        )
    };
    (width > 0 && height > 0).then_some((width, height))
}

/// BMP の寸法。imagesize は高さを符号なしで読むため、上から下へ並ぶ BMP(高さが負)を
/// 巨大な値と取り違える。情報ヘッダの版ごとに自分で読む。
fn bmp_dimensions(header: &[u8]) -> Option<(u32, u32)> {
    let info_size = u32::from_le_bytes(header.get(14..18)?.try_into().ok()?);
    if info_size == 12 {
        // BITMAPCOREHEADER: 幅・高さとも符号なし 16bit。
        let width = u16::from_le_bytes(header.get(18..20)?.try_into().ok()?);
        let height = u16::from_le_bytes(header.get(20..22)?.try_into().ok()?);
        return Some((u32::from(width), u32::from(height)));
    }
    if info_size < 16 {
        return None;
    }
    // BITMAPINFOHEADER 以降: 幅・高さとも符号付き 32bit。高さが負なら上から下へ並ぶ。
    let width = i32::from_le_bytes(header.get(18..22)?.try_into().ok()?);
    let height = i32::from_le_bytes(header.get(22..26)?.try_into().ok()?);
    let width = u32::try_from(width).ok()?;
    Some((width, height.unsigned_abs()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::source::test_images;

    #[test]
    fn reads_common_formats() {
        assert_eq!(
            read_dimensions(&test_images::png(700, 1000)[..], u64::MAX),
            Some((700, 1000))
        );
        assert_eq!(
            read_dimensions(&test_images::jpeg(1600, 1000)[..], u64::MAX),
            Some((1600, 1000))
        );
        assert_eq!(
            read_dimensions(&test_images::gif(640, 960)[..], u64::MAX),
            Some((640, 960))
        );
    }

    #[test]
    fn top_down_bmp_uses_the_absolute_height() {
        assert_eq!(
            read_dimensions(&test_images::bmp(1, -2)[..], u64::MAX),
            Some((1, 2))
        );
        assert_eq!(
            read_dimensions(&test_images::bmp(3, 5)[..], u64::MAX),
            Some((3, 5))
        );
        assert_eq!(
            read_dimensions(&test_images::bmp(-3, 5)[..], u64::MAX),
            None
        );
    }

    #[test]
    fn reads_past_the_first_chunk_when_the_size_is_far_from_the_start() {
        // SOF の手前に 200KiB の APP1 相当の区間を置いた JPEG。
        let mut bytes = vec![0xff, 0xd8];
        for _ in 0..4 {
            bytes.extend_from_slice(&[0xff, 0xe1, 0xc8, 0x00]);
            bytes.extend(std::iter::repeat(0u8).take(0xc800 - 2));
        }
        bytes.extend_from_slice(&test_images::jpeg(320, 240)[2..]);
        assert!(bytes.len() > 2 * INITIAL_READ);

        assert_eq!(read_dimensions(&bytes[..], u64::MAX), Some((320, 240)));
        // 上限までに寸法が現れなければ諦める。
        assert_eq!(read_dimensions(&bytes[..], INITIAL_READ as u64), None);
    }

    #[test]
    fn broken_or_truncated_headers_have_no_size() {
        assert_eq!(read_dimensions(&b"not really a png"[..], u64::MAX), None);
        assert_eq!(
            read_dimensions(&test_images::png(10, 10)[..12], u64::MAX),
            None
        );
        assert_eq!(
            read_dimensions(&test_images::png(0, 10)[..], u64::MAX),
            None
        );
    }
}
