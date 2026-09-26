# PrismPage

PrismPage は **Tauri 2 + React + TypeScript** で作った、Windows 向けの画像重視ビューワーです。
漫画・画集・スキャン本を、フォルダを登録してサムネイルで辿り、全画面で読みます。
ページ画像は AI 超解像エンジン(外部の実行ファイル)で高解像度化して表示できます。

見た目は紙の本を思わせる「紙」テーマ(生成り色の地・明朝体の見出し・朱色のアクセント)と、
夜間用の暗色テーマ「墨」を持ちます。

## 主な機能

- **ライブラリ**
  - 読みかけ(ホーム): 続きから読む本の一覧(表紙・書名・進捗・最終閲覧)
  - 本棚: 自分で作るコレクション。1 冊を複数の本棚に入れられます。背表紙表示と表紙グリッド表示を切り替えられます
  - フォルダ: 登録したフォルダをサブフォルダへ辿って本を選びます(パンくずで戻る)
  - お気に入り・履歴
  - 並び替え(名前 / 更新日 / 最近読んだ)と絞り込み(未読 / 読みかけ / 読了)
  - 検索: 表示中のフォルダの中、または登録フォルダ全体から、書名とパスを大文字小文字・全角半角の違いを無視して探します
- **ビューア**
  - 単ページ / 見開き / 自動(ウィンドウが横長なら見開き)、右綴じ / 左綴じ、表紙の単独表示、見開きの組み合わせのずらし
  - 画面に合わせる / 幅に合わせる、拡大とドラッグでの移動
  - 前後のページを先読みしてページ送りで待たせません
  - 本ごとに読書位置と表示設定(見開き・綴じ方向・表紙単独)を記憶します
  - 最後のページの次に「読み終わりました」と、同じフォルダの次の巻への案内を出します
- **本を開く方法**: 一覧から選ぶ、ウィンドウへファイルやフォルダをドラッグ&ドロップする、「ファイルを開く…」、
  エクスプローラーの「プログラムから開く」。すでに起動しているときは今のウィンドウで開きます
- **AI 超解像**: ビューアの AI ボタンで本ごとに ON/OFF。表示中のページを最優先で処理し、先のページを先回りで処理します。
  本のメニューから全ページを裏で処理しておくこともできます(中止・再開できます)
- **更新確認**: 設定画面から GitHub Releases の公開済みの版を確かめて、アプリ内で更新できます

元のファイル(画像・アーカイブ・EPUB・PDF)はコピーも変更もしません。サムネイル・AI 超解像の結果・読書状態は
アプリのデータ領域にだけ保存します。

## 対応形式

| 種類 | 形式 |
|---|---|
| 画像 | JPEG(`.jpg` `.jpeg`)・PNG・WebP・AVIF・GIF・BMP |
| 画像フォルダ | 画像を直接含むフォルダを 1 冊として読みます |
| アーカイブ | ZIP / CBZ、RAR / CBR |
| 電子書籍 | 画像中心の EPUB(固定レイアウトの見開き指定と綴じ方向を反映)、PDF |

- ページは自然順(`2.jpg` が `10.jpg` より前)に並びます。アーカイブ内のサブフォルダは自然順で平坦化し、画像以外は無視します。
- 画像ファイルを直接開くと、そのファイルがあるフォルダを 1 冊として、そのページから開きます。
- 文章中心(リフロー)の EPUB と 7z には対応していません。

## 操作

ビューアの既定の操作です。ホイールでページを送る向きは設定画面の「操作」で変えられます。

| 操作 | 動作 |
|---|---|
| ← / → | 綴じ方向に合わせて次・前(右綴じなら ← が次) |
| Space / Shift+Space | 次 / 前 |
| PageDown / PageUp | 次 / 前 |
| Home / End | 最初 / 最後 |
| T | 単ページと見開きの切り替え |
| B | 綴じ方向の切り替え |
| Q | 見開きの組み合わせを 1 ページずらす |
| F・F11 | 全画面の切り替え |
| Esc | 全画面を解除。全画面でなければビューアを閉じて元の画面・元のスクロール位置へ戻る |
| + / - / 0 | 拡大 / 縮小 / 元の大きさ |
| クリック | 画面の左右 3 分の 1 で次・前(綴じ方向に合わせる)。中央で操作バーの表示切り替え |
| ホイール | 次・前 |
| Ctrl+ホイール・中央のダブルクリック | 拡大縮小。拡大中はドラッグで移動 |
| 左右へのスワイプ | 次・前 |

操作バーはマウスを動かすと現れ、操作が止まると隠れます。上端に戻る・書名・ページ・表示の切り替え・AI、
下端に進み具合の線とシークがあります。

## AI 超解像の導入

PrismPage は AI エンジンを同梱していません。次のエンジン(ncnn-vulkan 版)のどれかを設定画面から導入して使います。
動かすには Vulkan に対応した GPU とドライバが必要です。

| エンジン | 向いている画像 |
|---|---|
| Real-CUGAN | 漫画・イラスト |
| waifu2x | 漫画・線画 |
| Real-ESRGAN | 表紙・挿絵・写真の混ざった画像 |

### 手順

1. 左ナビの「設定」を開き、「AI 超解像」の区分の「AI エンジン」へ進みます。
2. 使うエンジンの「公式配布を取得」を押します。各エンジンの公式 GitHub Releases から Windows 向けの ZIP を取得し、
   アプリのデータ領域へ展開して登録します。
3. 導入が終わるとエンジンに状態が表示されます。「状態を確かめる」で実行ファイルとモデルを確かめ直せます。
4. 「ビューアでの処理」で既定のエンジン・モデル・倍率と、先回りで処理するページ数を選びます。モデルが対応しない倍率は選べません。
5. 本を開き、ビューア上端の AI ボタンで ON にします。処理の済んだページから差し替わり、処理の状況が AI ボタンの横に出ます。

ネットワークにつながらない場合や、手元にあるエンジンを使う場合は、公式配布の代わりに次の方法でも登録できます。

- **ZIP を取り込む**: 手元にある配布 ZIP を選んで、アプリのデータ領域へ展開して登録します
- **フォルダを登録**: PC 上に展開済みのエンジンのフォルダをそのまま参照して登録します(フォルダは変更しません)
- **PC 内のエンジンを探す**: よく置かれる場所からエンジンのフォルダを探し、見つかった候補を登録します
- **配布ページ**: エンジンの公式配布ページをブラウザで開きます

「登録を解除」で登録を外せます。AI 超解像の結果はキャッシュに残り、「ビューアでの処理」のキャッシュ欄で使用量の確認・上限の設定・消去ができます。

## インストールと配布

- GitHub Releases から Windows 向けのインストーラ(NSIS)を配布します。インストールはユーザー単位で、管理者権限は要りません。
- インストーラは対応する拡張子(`.jpg` `.jpeg` `.png` `.webp` `.avif` `.gif` `.bmp` `.zip` `.cbz` `.rar` `.cbr` `.epub` `.pdf`)の
  「プログラムから開く」の候補に PrismPage を加えます。既定のアプリは変えません。PrismPage を既定にしたいときは、
  Windows の「既定のアプリ」または「プログラムから開く」で選んでください。アンインストールすると、加えた登録だけを消します。
- アプリ内の更新確認は、GitHub Releases の公開済みの版を見ます(draft の Release は対象外です)。

## 開発

PowerShell 環境では `npm.ps1` ではなく `npm-cli.js` を直接呼びます。dev server は `127.0.0.1:1420` 固定です。

```powershell
# 依存の導入
node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" ci

# フロントエンド
node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run lint
node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run test
node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build

# Rust
cargo check --manifest-path src-tauri\Cargo.toml
cargo test --manifest-path src-tauri\Cargo.toml

# アプリの起動とインストーラの作成
node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" exec tauri dev
node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" exec tauri build -- --debug
```

版は `package.json`・`src-tauri/Cargo.toml`・`src-tauri/tauri.conf.json` の 3 か所でそろえます。
GitHub Actions の `release` workflow は `app-v<版>` のタグで Windows インストーラを作り、Release に上げます
(タグは `tauri.conf.json` の版と一致している必要があります)。アプリ内更新に使う署名付きのファイルは、
この workflow が署名鍵(`TAURI_SIGNING_PRIVATE_KEY`)を使って作ります。手元のビルドでは作りません。

```powershell
git tag app-v0.2.1
git push origin app-v0.2.1
```

## 構成

```text
src/
  app/                 アプリの骨格(ナビ・ルーター)
  features/library/    読みかけ・本棚・フォルダ・お気に入り・履歴・検索
  features/viewer/     ビューア(見開き計算・操作・拡大・先読み・AI 超解像の切り替え)
  features/settings/   設定画面(表示・操作・ライブラリ・AI 超解像・アプリ情報)
  lib/                 Tauri の command 呼び出し

src-tauri/
  src/commands/        フロントから呼ぶ Tauri の command
  src/services/        ページソース(フォルダ・ZIP・RAR・EPUB・PDF)、サムネイル、ライブラリ、AI エンジン
  pdfium/              同梱する PDFium と、そのライセンス・利用表明
  windows/hooks.nsh    インストーラで「プログラムから開く」へ登録するフック
```

## ライセンス

PrismPage 本体は [MIT License](LICENSE) です。

配布物には次の第三者のソフトウェアを含みます。インストーラはこの README と `LICENSE` をインストール先へ一緒に置きます。

- **PDFium**(PDF の表示): BSD 3 条項(一部 Apache License 2.0)。[bblanchon/pdfium-binaries](https://github.com/bblanchon/pdfium-binaries) の
  ビルドを同梱しています。ライセンス文と、取り込まれている第三者のライブラリ(FreeType・libjpeg-turbo・OpenJPEG・zlib など)の
  ライセンスはインストール先の `pdfium/LICENSE`・`pdfium/licenses/` に、FreeType と Independent JPEG Group の利用表明は
  `pdfium/NOTICE.txt` にあります。版と取得元は [src-tauri/pdfium/README.md](src-tauri/pdfium/README.md) にあります。
- **UnRAR**(RAR / CBR の読み出し): RAR / CBR の展開に、`unrar` クレートが同梱してビルドする UnRAR のソースを使っています。
  UnRAR のソースは RARLAB のフリーウェアのライセンスに従い、MIT ではありません(下に全文を載せます)。
  このため PrismPage の配布物は、OSI 準拠のオープンソースのソフトウェアだけでは構成されていません。
  PrismPage は RAR の展開だけを行い、RAR 形式の圧縮は行いません。

その他の Rust クレートと npm パッケージのライセンスは、それぞれの配布元の表示に従います。

### UnRAR のライセンス

```text
 ******    *****   ******   UnRAR - free utility for RAR archives
 **   **  **   **  **   **  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 ******   *******  ******    License for use and distribution of
 **   **  **   **  **   **   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
 **   **  **   **  **   **         FREE portable version
                                   ~~~~~~~~~~~~~~~~~~~~~

      The source code of UnRAR utility is freeware. This means:

   1. All copyrights to RAR and the utility UnRAR are exclusively
      owned by the author - Alexander Roshal.

   2. UnRAR source code may be used in any software to handle
      RAR archives without limitations free of charge, but cannot be
      used to develop RAR (WinRAR) compatible archiver and to
      re-create RAR compression algorithm, which is proprietary.
      Distribution of modified UnRAR source code in separate form
      or as a part of other software is permitted, provided that
      full text of this paragraph, starting from "UnRAR source code"
      words, is included in license, or in documentation if license
      is not available, and in source code comments of resulting package.

   3. The UnRAR utility may be freely distributed. It is allowed
      to distribute UnRAR inside of other software packages.

   4. THE RAR ARCHIVER AND THE UnRAR UTILITY ARE DISTRIBUTED "AS IS".
      NO WARRANTY OF ANY KIND IS EXPRESSED OR IMPLIED.  YOU USE AT
      YOUR OWN RISK. THE AUTHOR WILL NOT BE LIABLE FOR DATA LOSS,
      DAMAGES, LOSS OF PROFITS OR ANY OTHER KIND OF LOSS WHILE USING
      OR MISUSING THIS SOFTWARE.

   5. Installing and using the UnRAR utility signifies acceptance of
      these terms and conditions of the license.

   6. If you don't agree with terms of the license you must remove
      UnRAR files from your storage devices and cease to use the
      utility.

      Thank you for your interest in RAR and UnRAR.


                                            Alexander L. Roshal
```
