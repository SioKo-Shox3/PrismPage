//! 合成データでの性能の計測(P-03)。時間は環境に左右されるので通常の `cargo test` では走らせず、
//! `cargo test --release --manifest-path src-tauri\Cargo.toml perf_ -- --ignored --nocapture --test-threads=1`
//! で走らせて表示された値を読む。上限の確認は体感で待たされない目安(1 操作 100ms 前後)に余裕を持たせた値。

use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use image::codecs::jpeg::JpegEncoder;
use image::RgbImage;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::services::library;
use crate::services::source::{book_id_for_path, open_source, BookCache};
use crate::services::thumbs::Thumbs;

/// 模様の入った JPEG。単色より実際のページに近い大きさと復号の手間になる。
fn jpeg(width: u32, height: u32) -> Vec<u8> {
    let image = RgbImage::from_fn(width, height, |x, y| {
        let v = ((x / 7 + y / 5) % 256) as u8;
        image::Rgb([v, v.wrapping_mul(3), ((x ^ y) % 256) as u8])
    });
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, 85)
        .encode_image(&image)
        .unwrap();
    bytes
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn report(label: &str, duration: Duration) {
    println!("[perf] {label}: {:.1} ms", ms(duration));
}

/// 1,000 冊(画像フォルダ 500・ZIP 500)を直下に置いた登録フォルダの一覧と、1 画面分の表紙。
#[test]
#[ignore]
fn perf_library_of_1000_books() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    fs::create_dir(&root).unwrap();
    let cover = jpeg(1200, 1700);
    for index in 0..500 {
        let book = root.join(format!("画像フォルダ {index}"));
        fs::create_dir(&book).unwrap();
        for page in 0..3 {
            fs::write(book.join(format!("{page:03}.jpg")), &cover).unwrap();
        }
    }
    for index in 0..500 {
        let path = root.join(format!("アーカイブ {index}.zip"));
        let mut writer = ZipWriter::new(fs::File::create(&path).unwrap());
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        writer.start_file("001.jpg", options).unwrap();
        writer.write_all(&cover).unwrap();
        writer.finish().unwrap();
    }

    // 1 回目は OS のキャッシュが温まっていない場合を含む。2 回目は画面を開き直したとき。
    for round in 1..=2 {
        let started = Instant::now();
        let entries = library::list_entries(&root).unwrap();
        let elapsed = started.elapsed();
        assert_eq!(entries.len(), 1000);
        report(&format!("フォルダの一覧 1,000 冊({round} 回目)"), elapsed);
        assert!(elapsed < Duration::from_secs(2), "一覧に {elapsed:?} かかった");
    }

    // 1 画面分(40 冊)の表紙を、アプリと同じ同時実行数 2 で並行に要求する。
    let entries = library::list_entries(&root).unwrap();
    let thumbs = Arc::new(Thumbs::new(2));
    let cache_dir = dir.path().join("thumbs");
    let screen: Vec<_> = entries
        .iter()
        .take(40)
        .map(|entry| (entry.thumb_id.clone().unwrap(), entry.path.clone()))
        .collect();
    let request_all = |label: &str| {
        let started = Instant::now();
        let handles: Vec<_> = screen
            .iter()
            .cloned()
            .map(|(id, path)| {
                let thumbs = Arc::clone(&thumbs);
                let cache_dir = cache_dir.clone();
                std::thread::spawn(move || {
                    let requested = Instant::now();
                    thumbs
                        .get_or_create(&cache_dir, &id, Path::new(&path))
                        .unwrap();
                    requested.elapsed()
                })
            })
            .collect();
        let waits: Vec<_> = handles.into_iter().map(|handle| handle.join().unwrap()).collect();
        let total = started.elapsed();
        let first = waits.iter().min().copied().unwrap_or_default();
        report(&format!("表紙 40 冊・{label}(全部)"), total);
        report(&format!("表紙 40 冊・{label}(最初の 1 冊)"), first);
        total
    };
    let cold = request_all("初回の生成");
    let warm = request_all("キャッシュ済み");
    assert!(cold < Duration::from_secs(10), "表紙の生成に {cold:?} かかった");
    assert!(warm < Duration::from_millis(500), "キャッシュ済みの表紙に {warm:?} かかった");
}

/// 500 ページの ZIP を開き、先頭から最後まで 1 ページずつ読む(ページ送り 1 回ごとの Rust 側の手間)。
#[test]
#[ignore]
fn perf_zip_of_500_pages() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("500 ページ.zip");
    let page = jpeg(1400, 2000);
    let mut writer = ZipWriter::new(fs::File::create(&path).unwrap());
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    for index in 0..500 {
        writer.start_file(format!("{index:04}.jpg"), options).unwrap();
        writer.write_all(&page).unwrap();
    }
    writer.finish().unwrap();
    println!(
        "[perf] ZIP の大きさ: {:.1} MB(1 ページ {:.0} KB)",
        fs::metadata(&path).unwrap().len() as f64 / 1_048_576.0,
        page.len() as f64 / 1024.0
    );

    let cache = BookCache::new(8);
    let started = Instant::now();
    let opened = open_source(&path, &cache).unwrap();
    let open_elapsed = started.elapsed();
    assert_eq!(opened.book.pages.len(), 500);
    report("500 ページの ZIP を開く", open_elapsed);
    assert!(open_elapsed < Duration::from_secs(2), "開くのに {open_elapsed:?} かかった");

    let source = cache.get(&opened.book.book_id).unwrap();
    let mut slowest = Duration::ZERO;
    let started = Instant::now();
    for index in 0..500 {
        let read = Instant::now();
        let bytes = source.read_page(index).unwrap();
        slowest = slowest.max(read.elapsed());
        assert_eq!(bytes.len(), page.len());
    }
    let total = started.elapsed();
    report("500 ページを順に読む(合計)", total);
    report("1 ページの読み出し(平均)", total / 500);
    report("1 ページの読み出し(最長)", slowest);
    assert!(slowest < Duration::from_millis(100), "1 ページに {slowest:?} かかった");

    // 読み終えても保持するのは開いた本のハンドルだけで、読み出したページは残らない。
    assert_eq!(cache.len(), 1);
}

/// 長辺 12,000px の画像 1 枚のフォルダを開き、ページを読み、表紙を作る。
#[test]
#[ignore]
fn perf_image_with_12000px_long_edge() {
    let dir = tempfile::tempdir().unwrap();
    let book = dir.path().join("巨大な画像");
    fs::create_dir(&book).unwrap();
    let bytes = jpeg(8000, 12000);
    fs::write(book.join("001.jpg"), &bytes).unwrap();
    println!(
        "[perf] 8000×12000 の JPEG: {:.1} MB",
        bytes.len() as f64 / 1_048_576.0
    );

    let cache = BookCache::new(8);
    let started = Instant::now();
    let opened = open_source(&book, &cache).unwrap();
    report("巨大な画像のフォルダを開く", started.elapsed());
    assert_eq!(
        (opened.book.pages[0].width, opened.book.pages[0].height),
        (8000, 12000)
    );

    let source = cache.get(&opened.book.book_id).unwrap();
    let started = Instant::now();
    let read = source.read_page(0).unwrap();
    let read_elapsed = started.elapsed();
    assert_eq!(read.len(), bytes.len());
    report("巨大な画像のページを読む", read_elapsed);
    assert!(read_elapsed < Duration::from_millis(200), "読み出しに {read_elapsed:?} かかった");

    let thumbs = Thumbs::new(2);
    let cache_dir = dir.path().join("thumbs");
    let id = book_id_for_path(&fs::canonicalize(&book).unwrap());
    let started = Instant::now();
    thumbs.get_or_create(&cache_dir, &id, &book).unwrap();
    let thumb_elapsed = started.elapsed();
    report("巨大な画像の表紙を作る", thumb_elapsed);
    assert!(thumb_elapsed < Duration::from_secs(5), "表紙に {thumb_elapsed:?} かかった");
}

