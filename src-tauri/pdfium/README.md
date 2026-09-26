# PDFium(同梱ライブラリ)

PDF のページ寸法の取得と画像化に使う PDFium の Windows x64 向けビルド。
アプリのリソースとしてインストール先の `pdfium/` に置かれ、起動時にそこから読み込む。

- 配布元: https://github.com/bblanchon/pdfium-binaries/releases/tag/chromium/7881
- ファイル: `pdfium-win-x64.tgz`(sha256 `73cc0de638ac2095e7445bf56a38200a5b7c7ca0e9f4ba144598f2457377ac08`)
- 版: Chromium 7881(`VERSION`)。Rust 側の `pdfium-render` の既定の対象(`pdfium_7881`)と合わせている
- `pdfium.dll` の sha256: `79d4676b656cfb1abcea88f9ade3b4b0826c5200382db5f4ec72a636c598c118`

## ライセンス

- PDFium 本体: `licenses/pdfium.txt`(BSD 3 条項・Apache 2.0)
- ビルドの配布物: `LICENSE`(MIT、Benoit Blanchon)
- PDFium が取り込む第三者のライブラリ: `licenses/` の各ファイル
- 利用表明: `NOTICE.txt`(FreeType と libjpeg-turbo/IJG のライセンスが求める英語の定型文)

### FreeType の著作権年の出典

`NOTICE.txt` の FreeType の年(2026)は、同梱した版が取り込む FreeType の著作権表示から取っている。

- PDFium の `chromium/7881` ブランチの `third_party/freetype/README.pdfium`: `Version: VER-2-14-3-58`、`Revision: b08a2eb0dd37f4a6c886fa5b0ecf5b3e1d27aac7`
  (https://pdfium.googlesource.com/pdfium/+/refs/heads/chromium/7881/third_party/freetype/README.pdfium 。`DEPS` の `freetype_revision` も同じ値)
- その版の `include/freetype/freetype.h`: `Copyright (C) 1996-2026`、`FREETYPE_MAJOR 2`・`FREETYPE_MINOR 14`・`FREETYPE_PATCH 3`
  (https://chromium.googlesource.com/chromium/src/third_party/freetype2/+/b08a2eb0dd37f4a6c886fa5b0ecf5b3e1d27aac7/include/freetype/freetype.h)

これらはアプリと一緒にインストール先の `pdfium/` へ置く(`tauri.conf.json` の `bundle.resources`)。

## 版を上げるとき

1. 上の配布元から新しい `pdfium-win-x64.tgz` を取り、`bin/pdfium.dll`・`LICENSE`・`VERSION`・`licenses/` をここへ置き換える。
2. `NOTICE.txt` の FreeType の年を、新しい版が取り込む FreeType の著作権の年に合わせ、`licenses/` に増減したライブラリがあれば一覧と表明を直す。
3. `Cargo.toml` の `pdfium-render` がその版に対応しているか(`pdfium_<版>` の機能)を確かめる。
4. `cargo test --manifest-path src-tauri\Cargo.toml pdf` を通す。
