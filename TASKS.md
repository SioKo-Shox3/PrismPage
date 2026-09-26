# TASKS — PrismPage

M2 ループが消化する機能一覧。M1(対話設計)でユーザーと合意してから書く。1タスク = 1反復で閉じる大きさ
(計画→実装→検証→コミットが1回で終わる)。閉じないと分かったら分割して行を増やす。
`status` は `todo | doing | done | blocked`。`done` へのフリップは検証出力を開いた後でしか許されない(verify-gate)。

仕様・確定した設計判断・マイルストーンは `docs/rebuild/spec.md`。作業ブランチは `refactor/rebuild`(main へ直接コミットしない)。
UI を変えるタスクは `run shots`(B-04 で導入)で撮ったスクリーンショットを開いて確認してから done にする。

# MS1 基盤

## B-01: 旧 UI を撤去し、新しいシェルと画面の骨組みを置く
- status: done
- done-when: 旧リーダー(`src/features/reader/`)・旧本棚画面・`src/lib/epub.ts`・epub.js の型定義が削除され、`package.json` から `epubjs`・`clsx`・`tailwind-merge`・`tailwindcss`・`@tailwindcss/vite` が外れている。ルートが「読みかけ(/)・本棚・フォルダ・お気に入り・履歴・設定・ビューア」の 7 つになり、左ナビ(spec 3.1)から各画面へ移れる(中身は空の見出しだけでよい)。設定画面には既存の AI エンジン管理と更新確認がそのまま表示される。未使用アセット(`hero.png`・`react.svg`・`vite.svg`・`public/icons.svg`)と未使用 CSS が消えている。
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run lint`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- paths: src/**, index.html, package.json, package-lock.json, vite.config.ts, public/**, eslint.config.js
- notes: Rust 側の旧 command はまだ消さない(B-05)。`src/lib/tauri.ts` から旧リーダー専用のラッパーを外すのは可。ロゴ PNG(1.8MB)は小さい SVG に置き換える。

## B-02: デザイントークン・書体・基本部品と「紙」「墨」テーマ
- status: done
- done-when: `src/design/` に CSS 変数のトークン(「紙」「墨」の 2 テーマ。色・余白・角丸・文字サイズ・影)、`@fontsource` で同梱した Shippori Mincho と Zen Kaku Gothic New、基本部品(Button・IconButton・TextField・Badge・ProgressLine・Dialog・Toast)が CSS Modules で揃っている。設定ストアを `prismpage-settings` version 2 に上げ(旧形式は既定値に置き換える)、テーマ「紙・墨・システムに合わせる」を切り替えられる。シェルと左ナビがトークンだけで描かれている(色の直書きが無い)。
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run lint`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- paths: src/**, package.json, package-lock.json
- notes: C 案の値の出発点 — 地 #F5F1E8、墨 #22201C、補助 #6F6A60、罫 #D9D2C3、朱 #A93B28。「墨」テーマは同じ構成の暗色版(地は暗い墨色、朱は明度を上げてコントラスト 4.5:1 を満たす)。アイコンは lucide-react。

## B-03: Vitest の導入と CI の拡充
- status: done
- done-when: `run test` で Vitest が走り、設定ストアの旧形式→既定値の移行など実テストが 1 件以上ある。CI(`.github/workflows/ci.yml`)に `cargo test` と `run test` が加わっている。
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run test`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run lint`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- paths: src/**, package.json, package-lock.json, vite.config.ts, vitest.config.ts, tsconfig*.json, .github/workflows/ci.yml

## B-04: ブラウザ用モックとスクリーンショット
- status: done
- done-when: `src/lib/tauri.ts` の背後にモック実装があり、`VITE_MOCK=1` のとき Tauri 無しのブラウザで全ルートが表示される(サンプルの本・合成したページ画像を `public/mock/` に置く。著作物は使わない)。`run shots` が Playwright で全ルートを「紙」「墨」両テーマで撮り、`.harness/shots/` に PNG を出力する。撮った画像を開いて、新シェルが崩れていないことを確かめている。
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run shots`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run lint`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- paths: src/**, public/mock/**, scripts/**, package.json, package-lock.json, vite.config.ts, playwright.config.ts, tsconfig*.json
- notes: モックは本番ビルドに入らないようにする(動的 import か define で除去)。`run shots` は dev server を 127.0.0.1:1420 で起動して撮る。ブラウザの取得(`playwright install chromium`)は初回だけ。CI では撮らない。

## B-05: Rust の整理(エラー型・async 化・不要 command の削除・分割)
- status: done
- done-when: command の戻り値が `AppError { code, message }`(serde でフロントへ渡る)になり、TS 側に対応する型と判別処理がある。重い処理を含む command がすべて async になっている。旧取り込み・旧リーダー用の command(`import_epub_from_path`・`read_book_base64`・`read_book_asset_image`・`scan_book_images`・`enhance_book_image`・`enhance_book_asset_image`・`read_enhanced_book_image`・`enhance_image`・`take_pending_opened_epubs` のうち不要になったもの)が削除され、`generate_handler!` と `src/lib/tauri.ts` が一致している。`services/library.rs` の EPUB 解析とパス正規化は `services/source/` 配下へ移してテストごと残す。重複関数(`normalize_book_id`・タイムアウト付き実行の 2 重実装)が 1 つになっている。
- verify: `cargo check --manifest-path src-tauri\Cargo.toml`
- verify: `cargo test --manifest-path src-tauri\Cargo.toml`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- paths: src-tauri/src/**, src-tauri/Cargo.toml, src-tauri/Cargo.lock, src/lib/**, src/types/**
- notes: 危険地帯(フロントと Rust の契約)。AI エンジンの登録・導入・状態確認の command は残す(A-01 で作り直す)。起動引数の処理は L-08 で広げるので、ここでは壊さないことだけ確認する。

## B-06: SQLite の導入とスキーマ
- status: done
- done-when: `services/store/` が app data 配下に SQLite(rusqlite、bundled)を開き、version 付きのスキーマ移行で `sources`(登録フォルダ)・`items`(本: 正規化した絶対パス・種類・書名・ページ数・更新日時・サイズ)・`reading_state`(本ごとのページ位置・最終閲覧)・`view_settings`(本ごとの見開き・綴じ方向・表紙単独)・`shelves`・`shelf_items`・`favorites` を作る。移行を 2 回流しても壊れない、未知の将来 version では開くのを拒否する、をテストで確かめている。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml store`
- verify: `cargo check --manifest-path src-tauri\Cargo.toml`
- paths: src-tauri/src/**, src-tauri/Cargo.toml, src-tauri/Cargo.lock
- notes: 危険地帯(永続化の形式)。旧 `library/` フォルダと localStorage の旧キーは読まない・消さない(削除は P-01 の明示操作)。

# MS2 ページソース

## S-01: ページソースの抽象とフォルダ・単一画像
- status: done
- done-when: `services/source/` に `PageSource`(ページ一覧・ページのバイト列・ページ寸法)があり、フォルダ実装が自然順(`2.jpg` < `10.jpg`)・画像以外の除外・画像ヘッダからの寸法取得を行う。画像ファイルを指定すると親フォルダを 1 冊として開き、開始ページをその画像にする。`open_book(path)` command が本 ID とページ一覧(名前・幅・高さ)を返し、開いた本はハンドルとしてキャッシュされる。テストが一時ディレクトリの合成画像で上記を確かめている。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml source`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- paths: src-tauri/src/**, src-tauri/Cargo.toml, src-tauri/Cargo.lock, src-tauri/tests/**, src/lib/**, src/types/**
- notes: 元ファイルは読むだけ。対応拡張子は jpg/jpeg/png/webp/avif/gif/bmp(大文字小文字を区別しない)。

## S-02: ZIP/CBZ ソース
- status: done
- done-when: ZIP/CBZ を開いたままのハンドルでページを読み出せる(1 ページごとに開き直さない)。サブフォルダは自然順で平坦化し、同じ画像が複数あっても間引かない。`..`・絶対パス・ドライブ文字を含むエントリは無視し、1 エントリの読み込みサイズ・エントリ数に上限がある。これらをテストで確かめている(テスト内で ZIP を生成する)。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml source`
- paths: src-tauri/src/**, src-tauri/tests/**, src-tauri/Cargo.toml, src-tauri/Cargo.lock
- notes: 危険地帯(アーカイブのパス)。区切りで評価者を通す。

## S-02b: ZIP の同名判定を zip クレートの件数との突き合わせで閉じる
- status: done
- done-when: `zip_archive.rs` の `scan_central_directory` が数えた中央ディレクトリの記録数と `ZipArchive::len()` が一致しないアーカイブは `unsupported_format` で開かない。zip クレートは復号後の名前(UTF-8 フラグ無しは CP437 で復号、Unicode Path 拡張フィールド 0x7075 があればその名前)をキーに同名をまとめるため、生バイトの比較だけでは「生バイトは違うが復号後の名前が同じ」エントリでページが黙って欠ける。この 2 形(UTF-8 フラグ付き `é` と フラグ無し CP437 の 0x82、および 0x7075 で名前を上書きしたエントリ)をテスト内で ZIP を加工して作り、どちらも開かないことをテストで確かめている。既存の同名テストと上限テストは通ったまま。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml source`
- verify: `cargo check --manifest-path src-tauri\Cargo.toml`
- paths: src-tauri/src/services/source/**
- notes: 危険地帯(アーカイブのパス)。生バイトの同名検出は残してよい(エラー文に名前を出せる)。突き合わせは件数の比較だけにし、中央ディレクトリの自前解析をこれ以上広げない。

## S-03: prism URI スキームでのページ配信と CSP
- status: done
- done-when: 非同期のカスタム URI スキーム `prism` が、開いた本の ID とページ番号(および後で使うサムネイル・超解像のバリアント)だけを受け付けてバイト列と Content-Type を返す。任意パス・未知の ID・範囲外の番号は 4xx になる(テストあり)。`tauri.conf.json` の CSP が有効(`default-src 'self'`、画像は self と prism スキームのみ)で、フロントに `pageUrl(bookId, index)` がある。モックでも同じ関数で合成画像を返す。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml protocol`
- verify: `cargo check --manifest-path src-tauri\Cargo.toml`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- paths: src-tauri/src/**, src-tauri/tauri.conf.json, src-tauri/capabilities/**, src/lib/**, src/types/**
- notes: 危険地帯(URI スキーム・CSP)。Windows では `http://prism.localhost/...` 形式で届く点を CSP に反映する。評価者を通す。

## S-04: EPUB(画像中心)ソース
- status: done
- done-when: EPUB の spine 順に各項目の画像(`img`・SVG の `image`)をページにし、固定レイアウトの `page-spread-left/right`・`page-progression-direction` をページ情報と本の情報に載せる。画像を含まない項目が多数を占める EPUB はエラーコード `unsupported_text_epub` を返す。EPUB 内パスの検証は既存テストを引き継ぎ、ハッシュでの重複除去はしない。テストはテスト内で生成した EPUB で行う。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml source`
- paths: src-tauri/src/**, src-tauri/tests/**
- notes: 危険地帯(EPUB 内パス)。区切りで評価者を通す。

## S-04b: EPUB の見開き指定・綴じ方向・文章中心エラーをフロントの型に足す
- status: done
- done-when: `src/types/error.ts` の `AppErrorCode` に `unsupported_text_epub` があり、`src/types/app.ts` の `PageInfo` に `spread?: 'left' | 'right'`、`OpenedBook` に `pageProgression?: 'ltr' | 'rtl'` がある(Rust の `models.rs` と一致。指定の無いときはキー自体が無い)。モックの本の少なくとも 1 冊が `pageProgression: 'rtl'` を返す。
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run test`
- paths: src/types/**, src/lib/**
- notes: S-04 で Rust 側だけ先に足した(S-04 の paths が src-tauri のみだったため)。V-01 の見開き計算より前に閉じる。

## S-04c: spine に直接並ぶ SVG 文書の画像をページにする
- status: done
- done-when: `epub.rs` が spine の項目のうち `media-type` が `image/svg+xml` の SVG 文書も XHTML と同じく `read_document` → `item_image_paths` にかけ、中の `<image href|xlink:href>` をページにする。spine が `p.svg` を参照し、その SVG の `<image href="p.png"/>` が同梱の PNG を指す EPUB をテスト内で生成し、`no_pages` ではなく 1 ページ(`p.png`)で開けることをテストで確かめている。SVG 文書の中の画像パスも既存の EPUB 内パス検証(`..`・絶対パスの拒否)を通る。既存の EPUB テストは通ったまま。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml source`
- verify: `cargo check --manifest-path src-tauri\Cargo.toml`
- paths: src-tauri/src/services/source/**
- notes: 反復 11 の評価指摘 1(EPUB 3.3 の SVG content document)。危険地帯(EPUB 内パス)。文章中心判定の分母にも SVG 文書を数える。

# MS3 ビューア

## V-01: 見開き計算(純粋関数)
- status: done
- done-when: `src/features/viewer/spread.ts` が、ページ(幅・高さ・見開き指定)・綴じ方向・表示モード(単/見開き/自動)・表紙単独・ずらし・ウィンドウの縦横比から見開きの列を返す。横長ページは単独、表紙単独、EPUB の左右指定、1 ページずらし、奇数ページ末尾、全ページ横長、の各場合を Vitest で確かめている。ページ番号から見開き番号への変換と逆変換がある。
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run test`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run lint`
- paths: src/features/viewer/**
- notes: UI からは独立させる(React に依存しない)。

## V-02: ビューアの表示・先読み・読み終わり
- status: done
- done-when: ビューア画面が本を開き、現在の見開きを `pageUrl` の画像で C 案のレイアウト(紙色の地・中央に見開き・上端の文字バー・下端の細い進捗線)で表示する。右綴じは右ページが先。画面に合わせる/幅に合わせるを切り替えられる。前後 2 見開きを `decode()` で先読みする。最後の見開きの次は先頭に戻らず「読み終わりました」と次の巻の案内(V-06 までは案内の枠だけ)を出す。UI はマウス移動で現れ、操作が 2.5 秒止まると隠れる。
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run lint`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run shots`
- paths: src/**
- notes: ビューアの状態は reducer(状態機械)で持ち、ref の迷路を作らない。読み込んだ画像の状態を際限なく溜めない。

## V-03: ビューアの操作(キー・クリック・ホイール・スワイプ・シーク)
- status: done
- done-when: spec 3.3 の操作表どおりに動く(← / → は綴じ方向に追従、Space・PageUp/Down・Home/End・T・B・Q・F/F11・Esc)。クリックは左右の領域で次・前、中央で UI 表示切り替え。ホイールは間引き付きで方向反転の設定に従う。スワイプで次・前。下端の進捗線をドラッグしてシークでき、ドラッグ中はページ番号を表示する。キーと動作の割り当ては純粋関数で Vitest のテストがある。
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run test`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run lint`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- paths: src/**

## V-04: 拡大表示
- status: done
- done-when: Ctrl+ホイール・中央 1/3 のダブルクリック・+/- で拡大縮小し、拡大中はドラッグで移動、0 で元に戻る。左右の領域のダブルクリックは拡大せず 2 回のページ送りになる(クリックでのページ送りを遅らせない)。拡大中はページ送りのクリック領域が無効になる。拡大率とパンの計算は純粋関数でテストがある。
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run test`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- paths: src/**

## V-05: 読書位置と本ごとの表示設定の保存
- status: done
- done-when: ページを送ると読書位置が SQLite の `reading_state` に保存され(連続操作は間引く)、同じ本を開き直すとその見開きから始まる。見開き・綴じ方向・表紙単独を変えると `view_settings` に保存され、次に開いたときに復元される(未設定なら設定画面の既定値)。保存・復元の command とテストがある。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml store`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- paths: src/**, src-tauri/src/**
- notes: 本の識別は正規化した絶対パス。EPUB の綴じ方向指定がある本は、ユーザーが変えるまでそれを既定にする。

## V-06: 次の巻・前の巻
- status: done
- done-when: 同じフォルダ内で自然順に隣り合う本(同じ種類)を次・前の巻として求める command がある(テストあり)。読み終わりの案内に次の巻の表紙と書名が出て、選ぶとその本の先頭から開く。ビューアのメニューからも前後の巻へ移れる。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- paths: src/**, src-tauri/src/**

# MS4 ライブラリ

## L-01: 登録フォルダとディレクトリ一覧(Rust)
- status: done
- done-when: 登録フォルダの追加・削除・一覧の command があり(`sources` テーブル)、登録フォルダ配下のディレクトリを async で読んで各項目を「フォルダ / 本(画像フォルダ・ZIP・CBZ・EPUB・RAR・CBR・PDF)」に分類し自然順で返す。登録フォルダの外を指すパス(`..`・シンボリックリンク経由を含む)は拒否する。分類・並び順・範囲外の拒否をテストで確かめている。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml library`
- verify: `cargo check --manifest-path src-tauri\Cargo.toml`
- paths: src-tauri/src/**, src/lib/**, src/types/**
- notes: 危険地帯(ローカルファイルの範囲)。RAR・PDF は F-01・F-02 まで「まだ開けない形式」として返す。

## L-02: フォルダ画面
- status: done
- done-when: 設定とフォルダ画面から登録フォルダを追加・削除できる(ダイアログ)。フォルダ画面は登録フォルダ → サブフォルダ → 本をパンくず付きで辿れ、本は表紙グリッド(L-03 まではプレースホルダ)で並ぶ。本を選ぶとビューアが開き、Esc で元のフォルダとスクロール位置へ戻る。まだ開けない形式は選べない表示になる。
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run lint`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run shots`
- paths: src/**

## L-03: 表紙サムネイル
- status: done
- done-when: Rust 側が本の 1 ページ目から長辺 320px のサムネイルを生成して app data のキャッシュに保存し、`prism` スキームで返す。元ファイルの更新日時・サイズが変わったら作り直す。生成は同時実行数を制限した裏の処理で、一覧は画面に入った項目から順に要求する。生成とキャッシュ判定のテストがある。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml thumbs`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- paths: src/**, src-tauri/src/**, src-tauri/Cargo.toml, src-tauri/Cargo.lock

## L-03b: AVIF の表紙
- status: done
- done-when: 先頭ページが AVIF の画像フォルダ・CBZ・EPUB でも、フォルダ画面と読みかけの表紙に 1 ページ目が表示される。Rust 側は `image` で復号できない形式(AVIF)のとき、`/thumb/<ID>` が表紙ページの元のバイト列をページ配信と同じ Content-Type(`image/avif`)で返す(サムネイルのキャッシュには書かない)。フロントは同じ `<img>` を表紙の枠に合わせて縮めて表示する(WebView2 が復号する)。AVIF の先頭ページで `/thumb/<ID>` が `image/avif` と元のバイト列を返すテストと、JPEG・PNG の先頭ページは従来どおり JPEG のサムネイルになるテストがある。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml thumbs`
- verify: `cargo check --manifest-path src-tauri\Cargo.toml`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- paths: src-tauri/src/**, src/features/library/**
- notes: L-03 の評価指摘。`image` の `avif-native`(C の dav1d)は Windows のビルドと CI に meson・ninja・nasm・pkg-config を足すので使わない。依存は増やさない。元のバイト列は 1 ページの上限(`MAX_PAGE_BYTES`)の内側で返す。AVIF の表紙は元の大きさで復号されるので、表紙が AVIF の本が多いフォルダでは重くなりうる(P-03 で見る)。

## L-04: 読みかけ(ホーム)と履歴
- status: done
- done-when: ホームに読みかけの本(表紙・書名・巻・形式・フォルダ・ページ位置・最終閲覧・進捗線・「続きを読む」)が最終閲覧順で並ぶ(C 案のライブラリ画面の構成)。履歴画面に開いた本が日付順で並び、個別削除と全消去ができる(元ファイルには触れない)。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml store`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run shots`
- paths: src/**, src-tauri/src/**

## L-05: 本棚とお気に入り
- status: done
- done-when: 本棚を作成・名前変更・削除でき、本を複数の本棚へ入れる・外すことができる(一覧の右クリックメニューとビューアのメニュー)。本棚画面は背表紙表示と表紙グリッド表示を切り替えられる。お気に入りの付け外しとお気に入り画面がある。元ファイルが見つからない本は「見つかりません」と表示し、本棚からは自動で消さない。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml store`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run shots`
- paths: src/**, src-tauri/src/**

## L-06: 並び替えと絞り込み
- status: done
- done-when: フォルダ・本棚の一覧を名前 / 更新日 / 最近読んだ で並び替え、未読 / 読みかけ / 読了で絞り込める。選んだ並び順は画面ごとに記憶される。
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run test`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- paths: src/**, src-tauri/src/**

## L-07: 検索
- status: done
- done-when: 登録フォルダ全体の書名・パスの索引を裏で作り(登録・起動時に差分更新)、検索欄から大文字小文字・全角半角を無視した部分一致で探せる。表示中のフォルダ内だけを探す切り替えがある。索引の作成と検索のテストがある。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml library`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- paths: src/**, src-tauri/src/**

## L-07b: 読書状態を含む一覧の取得を、保存の完了待ちに 1 か所でそろえる
- status: done
- done-when: 読書位置・表示設定の保存キュー(今の `src/features/viewer/use-book-persistence.ts` の `whenSavesSettled` と保存の直列化)が `src/lib/` 側へ移り、読書状態を返す command(`list_directory`・`list_continue_reading`・`list_history`・`list_shelf_books`・`list_favorites`・検索・`open_book` ほか該当するもの)の `src/lib/tauri.ts` のラッパーが呼び出し前に必ず保存の完了を待つ。各画面(`reading-pages.tsx`・`folders-page.tsx`・`shelves-page.tsx`・`favorites-page.tsx`・`viewer-page.tsx`・検索画面)から個別の `whenSavesSettled()` 呼び出しが消えている。保存を遅らせたモックで、ラッパー経由の一覧取得が保存の完了後に走ることを 1 つのテストで確かめている(画面ごとのテストは今あるものが通ったまま)。
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run test`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run lint`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- paths: src/**
- notes: L-04(読みかけ・履歴)と L-06(フォルダ)で、一覧が保存の完了を待たずに読んで古い読書状態を出す差し戻しが 2 回続いた(本棚・お気に入りは待っていた)。画面ごとの待ち忘れを構造で防ぐ。lib が features に依存しない向きにする。

## L-07c: 検索を索引の更新と登録の変更に追従させる
- status: done
- done-when: (1) 起動時・登録時の走査で、走査予定の登録フォルダを走査の開始前にすべて「更新待ち」として記録し(`commands/search.rs` の `begin_scan` を各フォルダの走査直前だけでなく予定の確定時に)、先に走るフォルダ A の走査中に後のフォルダ B に絞って検索しても `indexing=true` が返る。A の走査中に B を検索する回帰テストがある。(2) フォルダ画面で検索結果を表示したまま登録フォルダを足す・外すと、検索語と範囲が同じでも検索をやり直し、索引が完成するまで追従する(`library-search.tsx` の再検索の条件に登録の変更を含める)。登録後に応答が 0 件から 1 件に変わると再検索で結果に出る部品テストがある。(3) 親から渡る `query` が変わると入力欄の値もそれに合わせ、消した検索語が 250ms 後に戻らない。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml library`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run test`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- paths: src/**, src-tauri/src/**
- notes: 反復 7(L-07)の評価指摘 1・2 と non-blocking 1。次の L-07b は paths が src/** だけで Rust 側の (1) を直せないため別タスクにした。L-07b の反復で (2)(3) が直っていれば、この反復は (1) だけを行い、(2)(3) は既存テストで確かめて閉じる。

## L-08: 本を開く導線(ドラッグ&ドロップ・ファイルを開く・関連付け)
- status: done
- done-when: ウィンドウへファイル・フォルダをドロップするとビューアで開く。「ファイルを開く」ダイアログがある。起動引数と 2 つ目の起動の引数(画像・フォルダ・ZIP・CBZ・EPUB・RAR・CBR・PDF)を正規化して既存ウィンドウのビューアで開く(フロントの待ち受け前に届いた分も取りこぼさない)。開いた本は履歴に入る。(ここまで dc49218 で実装済み。)ファイル関連付けは「プログラムから開く」にだけ登録し、既定のアプリは変えない: `tauri.conf.json` の `bundle.fileAssociations` から `epub` を外し、`bundle.windows.nsis.installerHooks` で指定した `src-tauri/windows/hooks.nsh` が、インストール時に対応拡張子(jpg・jpeg・png・webp・avif・gif・bmp・zip・cbz・rar・cbr・epub・pdf)の `Software\Classes\.<ext>\OpenWithProgids` に PrismPage のクラスを、`Software\Classes\Applications\<exe 名>\SupportedTypes` に各拡張子を書き、クラスの `shell\open\command` が `"<exe>" "%1"` を指す。各拡張子の既定値(`Software\Classes\.<ext>` の `(既定)`)には触れない。アンインストール時に書いた値だけを消す。`installMode` と同じ登録先(currentUser なら HKCU)に書く。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml`
- verify: `cargo check --manifest-path src-tauri\Cargo.toml`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- paths: src/**, src-tauri/src/**, src-tauri/tauri.conf.json, src-tauri/windows/**
- notes: 危険地帯(起動引数)。評価者を通す。関連付けの方式はユーザー決定(2026-09-26、blocked/L-08.md の選択肢 1)。Tauri の `fileAssociations` は Windows で既定を上書きし「既定にしない」指定を持たないため使わない。インストーラーを実際に作って動かす確認は P-02(配布設定)で行い、ここでは hooks.nsh の内容と tauri.conf.json の指定を目視と `cargo check`/build で確かめる。hooks.nsh の各行が何を書き・何を消すかを日本語のコメントで書く。

# MS5 AI 超解像

## A-01: エンジン層の整理
- status: done
- done-when: `services/engines.rs` が registry / installer / runner / cache に分かれている。キャッシュのキーにエンジン・モデル・倍率・ノイズ除去が入り、エンジンとモデルごとに選べる倍率を返す関数がある(対応しない倍率は拒否)。既存の `engines/registry.json` をそのまま読める。キャッシュキー・倍率の検証・ZIP 展開の上限(合計サイズ・エントリ数)のテストがある。状態確認の実行ファイル起動にタイムアウトと stdout/stderr の読み切りが残っている。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml engines`
- verify: `cargo check --manifest-path src-tauri\Cargo.toml`
- paths: src-tauri/src/**, src-tauri/Cargo.toml, src-tauri/Cargo.lock
- notes: 危険地帯(外部バイナリ実行・エンジン取得)。評価者を通す。

## A-02: その場処理のキュー(Rust)
- status: done
- done-when: 優先度付きキュー(表示中 > 先読み > 一括)で超解像ジョブを 1 本ずつ実行し、本を閉じる・大きく移動するとそのジョブ群をキャンセルして子プロセスを終了する。処理済みのページは `prism` スキームのバリアント指定で返り、未処理なら元画像を返す。処理状況はイベントでフロントへ流れる。キューの順序とキャンセルのテストがある(実エンジンの代わりにテスト用の偽実行ファイルか関数を使う)。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml engines`
- verify: `cargo check --manifest-path src-tauri\Cargo.toml`
- paths: src-tauri/src/**
- notes: 危険地帯(外部バイナリ実行)。評価者を通す。

## A-03: ビューアの AI 切り替えと状態表示
- status: done
- done-when: ビューアの AI ボタンで本ごとに ON/OFF でき(記憶される)、ON のとき表示中と次の数ページ(既定 4)を要求し、処理が終わったページをちらつかずに差し替える。状態(「AI 2× 適用中」「先の 4 ページを準備中 2/4」)を上端バーに出す。エンジン未登録なら設定画面への案内を出す。
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run lint`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run shots`
- paths: src/**

## A-04: AI の既定値とキャッシュ管理
- status: done
- done-when: 設定の AI 超解像画面(C 案のデザイン)で、既定のエンジン・モデル・倍率(選べる値だけ)・先読みページ数を選べる。キャッシュの使用量表示・上限設定・消去ボタンがあり、上限を超えたら古いものから消える(Rust 側のテストあり)。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml engines`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run shots`
- paths: src/**, src-tauri/src/**

## A-05: エンジン管理画面の作り直し
- status: done
- done-when: B-01 で仮置きした旧エンジン管理画面が C 案のデザインで作り直され、エンジンの導入(公式配布の取得・ZIP 取り込み・フォルダ登録・候補検索)、状態確認、登録解除ができる。導入中は進捗を表示し、失敗時は原因と次の手を日本語で示す。旧 `engine-manager.tsx` と旧 CSS が消えている。
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run lint`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run shots`
- verify: `cargo check --manifest-path src-tauri\Cargo.toml`
- paths: src/**, src-tauri/src/**

## A-06: 一括事前処理
- status: done
- done-when: 本のメニューから「全ページを事前処理」を始められ、裏で順に処理して進捗(n / 全ページ)を表示し、中止・再開(処理済みは飛ばす)ができる。表示中のページの処理が常に優先される。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml engines`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- paths: src/**, src-tauri/src/**

# MS6 追加形式

## F-01: RAR/CBR
- status: done
- done-when: 最初に RAR 読み出しライブラリのライセンスが本体(MIT)の配布と両立するかを確認し、結果を `docs/rebuild/spec.md` のリスク欄に書く(両立しなければ実装せず blocked にしてユーザーへ戻す)。両立するなら RAR/CBR を開いた時点で一時領域へ展開してページソースとして読み、閉じたら片付ける。一時領域の後片付け・パス検証のテストがある。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml source`
- verify: `cargo check --manifest-path src-tauri\Cargo.toml`
- paths: src-tauri/src/**, src-tauri/tests/**, src-tauri/Cargo.toml, src-tauri/Cargo.lock, docs/rebuild/spec.md
- notes: 危険地帯(アーカイブのパス)。評価者を通す。テスト用 RAR を自作できない場合は実ファイルでの確認をユーザーに依頼すると PROGRESS.md に書く。

## L-08b: アンインストール時は hooks.nsh が書いた値だけを消す
- status: done
- done-when: `src-tauri/windows/hooks.nsh` の `NSIS_HOOK_PREUNINSTALL` が `DeleteRegKey`(配下ごと)を使わず、インストール時に書いた値だけを `DeleteRegValue` で個別に消す: 各拡張子の `OpenWithProgids` の `PrismPage.Book`、`Applications\<exe>.exe\SupportedTypes` の 13 個の拡張子の値、`FriendlyAppName`、`Applications\<exe>.exe\shell\open\command` と `PrismPage.Book\shell\open\command` の `(既定)`、`PrismPage.Book` の `(既定)` と `DefaultIcon` の `(既定)`。そのあと、空になったキーだけを末端から `DeleteRegKey /ifempty` で片付ける(他のアプリやユーザーが足した値・子キーがあれば残る)。`makensis` でフックを展開した結果(または hooks.nsh の目視)で、無条件の `DeleteRegKey` が無いことを確かめている。
- verify: `cargo check --manifest-path src-tauri\Cargo.toml`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- paths: src-tauri/windows/**
- notes: 反復 1(L-08、3 回目の起動)の評価指摘。`Applications\<exe>.exe` はユーザーが「プログラムから開く → 参照」で exe を選ぶと Windows が作ることもあるため、配下ごと消さない。

## F-01c: RAR のリンクのエントリを展開せず、本を閉じたら一時領域を片付ける
- status: done
- done-when: (1) RAR の展開前にエントリのリンク種別(unrar の `RedirType` など)を見て、ハードリンク・シンボリックリンク・ジャンクション・ファイル参照のエントリは展開せず一覧から外す。展開は必ず一時領域の中へ行い、アーカイブの外や作業ディレクトリ(cwd)のファイルへのリンク作成・属性変更が起きない。アーカイブ外の画像を指すハードリンクのエントリを含む RAR で、参照先の内容・属性・更新日時が変わらないことを確かめるテストがある(テスト用 RAR を作れない場合は、リンク種別を判定する関数の単体テストと、展開前に判定が呼ばれることのテストにし、実ファイルでの確認をユーザーに依頼すると PROGRESS.md に書く)。(2) ビューアを閉じる(Esc・戻る・別の本を開く)と、その本の RAR ソースが `BookCache` から外れて一時領域が消える。閉じる通知の command(または既存の経路)とキャッシュの解放をつなぎ、実際の終了経路で一時フォルダが消えるテストがある。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml source`
- verify: `cargo check --manifest-path src-tauri\Cargo.toml`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- paths: src-tauri/src/**, src-tauri/tests/**, src/**
- notes: 反復 20(F-01)の評価指摘 1・2。危険地帯(アーカイブのパス・元ファイルは読み取り専用)。評価者を通す。前の反復で直っていれば、既存テストで確かめて閉じる。

## F-01d: 読み込み途中で閉じたビューアの本も解放する
- status: done
- done-when: ビューアが `openBook`(および表紙のための前後の巻の取得)を要求したあと、応答が返る前に閉じられた(Esc・戻る・別の本へ移る)場合も、遅れて返った本 ID を `close_books` で解放する。開く要求ごとに持ち主(どのビューアの表示か)を追い、閉じた後に完了した要求の本だけを解放する。閉じた直後に同じ本を開き直した新しいビューアの本は解放しない(新しい要求の結果を消さない)。`openBook` を保留 → Esc → 成功応答、前後の巻の取得を保留 → Esc → 成功応答、閉じた直後に同じ本を開き直す、の 3 つを遅延応答のモックで確かめる回帰テストがある。
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run test`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- verify: `cargo test --manifest-path src-tauri\Cargo.toml source`
- paths: src/**, src-tauri/src/**
- notes: 反復 2(F-01c、3 回目の起動)の評価指摘。危険地帯(一時領域の後片付け)。Rust 側は返答前にキャッシュへ格納するので、フロントが捨てた応答の本は解放されずに残る。

## F-01b: 本棚・お気に入りでも RAR/CBR を開けるようにする
- status: done
- done-when: 本棚・お気に入りの一覧(`collection-views.tsx` の開ける判定)が RAR を開けない形式として扱わず、Rust の `BookFormat::is_openable` と同じく PDF だけを開けない形式にする。モック(`tauri-mock.ts`)の RAR の `openable` も合わせる。
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run test`
- paths: src/**
- notes: F-01 で Rust は RAR を開けるようにしたが、フロントの本棚・お気に入りには「RAR・PDF は開けない」が直書きで残っている(F-01 の変更範囲の外)。

## F-02: PDF
- status: done
- done-when: PDFium の DLL をアプリに同梱し(ライセンス表記を含む)、PDF のページ寸法を返し、要求された大きさでページを画像化してキャッシュする。見開き計算に PDF のページ寸法が使われる。テスト内で生成した PDF でページ数・寸法・画像化を確かめている。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml source`
- verify: `cargo check --manifest-path src-tauri\Cargo.toml`
- paths: src-tauri/**, docs/rebuild/spec.md
- notes: `src-tauri/target/` と `src-tauri/gen/` は編集しない。

## F-02b: フロントでも PDF を開けるようにする
- status: done
- done-when: 本棚・お気に入りの開ける判定(`collection-views.tsx` の `canOpen`)が PDF を開けない形式として扱わない(Rust の `BookFormat::is_openable` はすべて真)。フォルダ一覧・形式の表示名の「まだ開けない形式(PDF)」の文言とモック(`tauri-mock.ts`)の PDF の `openable` も合わせる。ビューアは PDF のページを表示幅(装置の画素比を掛けた幅)に合わせて `prism` の `/page/<bookId>/<index>/width/<px>` で要求する(`src/lib/tauri.ts` の URL 組み立て)。
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run test`
- paths: src/**
- notes: F-02 で Rust は PDF を開けるようにし、幅を指定したページの要求を足したが、フロントの判定と URL は変更範囲の外だった。

## F-02c: 同梱した PDFium の第三者ライブラリへの利用表明を添える
- status: done
- done-when: `src-tauri/pdfium/NOTICE.txt`(日本語と、ライセンスが求める英語の定型文の両方)に、PrismPage が PDFium を通じて FreeType(FTL の求める "Portions of this software are copyright © <year> The FreeType Project (www.freetype.org). All rights reserved." の表明)と libjpeg-turbo/IJG("This software is based in part on the work of the Independent JPEG Group." の表明)を使っていることを書き、`src-tauri/pdfium/licenses/` の他のライセンスで同様に表明・告知を求めるものがあればそれも載せる。`tauri.conf.json` の `bundle.resources` で NOTICE.txt がインストール先の `pdfium/` に同梱される。`docs/rebuild/spec.md` のリスク欄の「著作権表示とライセンス文を添えることだけ」を、利用表明が要ることを含む記述に直す。同梱設定を確かめる既存のテストが NOTICE.txt も対象にしている。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml source`
- verify: `cargo check --manifest-path src-tauri\Cargo.toml`
- paths: src-tauri/pdfium/**, src-tauri/tauri.conf.json, src-tauri/src/**, docs/rebuild/spec.md
- notes: 反復 6(F-02、3 回目の起動)の評価指摘。根拠は `src-tauri/pdfium/licenses/freetype.txt` の 116 行付近と `licenses/libjpeg_turbo.md` の 58 行付近。F-02b は paths が src/** だけで直せないため別タスクにした。README の「ライセンス」節への記載は P-02 で行う。

## F-02d: FreeType の利用表明の年を同梱版の出典で確かめる
- status: done
- done-when: 同梱した PDFium(Chromium 7881)が取り込んでいる FreeType の版を、PDFium の FreeType 更新コミット(例: https://pdfium.googlesource.com/pdfium/+/d904fdadcedf000b196b2392d50537a8d1848b9b)または `third_party/freetype` の README・`freetype.h` の著作権表示から確かめ、その版の著作権年を `src-tauri/pdfium/NOTICE.txt` の FTL の表明に使っている(今の `2026` と違えば直す)。確かめた出典(URL・版・年)を `src-tauri/pdfium/README.md` に書いている。NOTICE.txt の説明文は日本語にし、英語はライセンスが求める定型文と名前の一覧だけにする。同梱設定のテストは通ったまま。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml source`
- paths: src-tauri/pdfium/**
- notes: 反復 8(F-02c、3 回目の起動)の評価指摘と non-blocking。P-01 は paths が src/**・src-tauri/src/** で直せないため別タスクにした。出典を確かめられない場合は推定で書かず、確かめられなかったことと理由を PROGRESS.md に書いてユーザーに確認を求める。

# MS7 仕上げ

## P-01a: dev server の監視から src-tauri/ を外し、run shots の初回の読み込みを速くする
- status: done
- done-when: `vite.config.ts` の `server.watch.ignored` に `**/src-tauri/**` を入れ(127.0.0.1:1420・strictPort は変えない)、`run shots` が 15 件すべて通る。
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run shots`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- paths: vite.config.ts
- notes: 反復 9(P-01)で見つけた。dev server の監視が `src-tauri/target`(約 3 万ファイル)を走査するあいだ最初の読み込みが止まり、`/` の読み込みが約 35 秒かかって `run shots` の 1 本目(paper/continue-reading)が 30 秒の制限を超える(変更前の HEAD でも同じ)。一時設定で `src-tauri/**` を監視から外すと 1 秒未満になった。これが済んだら P-01 の `run shots` を再実行して閉じる。

## P-01: 設定画面の整理と旧データの削除
- status: done
- done-when: 設定画面が spec 3.6 の区分(表示・操作・ライブラリ・AI・アプリ情報)で C 案のデザインになっている。「旧バージョンのデータを削除」が確認ダイアログ付きで、app data の旧 `library/` フォルダと localStorage の旧キー(`prismpage-library`)だけを消す(対象の一覧を表示してから消す)。
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run shots`
- verify: `cargo check --manifest-path src-tauri\Cargo.toml`
- paths: src/**, src-tauri/src/**

## P-02: README と配布設定
- status: done
- done-when: README が新しい機能・対応形式・操作表・AI 超解像の導入手順に書き直されている。`package.json`・`Cargo.toml`・`tauri.conf.json` の版がそろっている。`tauri build -- --debug` が通る。
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" exec tauri build -- --debug`
- paths: README.md, package.json, package-lock.json, src-tauri/Cargo.toml, src-tauri/Cargo.lock, src-tauri/tauri.conf.json, .github/workflows/**

## P-03: 性能と安定性
- status: done
- done-when: 合成データ(1,000 冊の登録フォルダ、500 ページの ZIP、長辺 12,000px の画像)で、フォルダ画面の表示・ページ送り・拡大がそれぞれ体感で待たされない(計測値を PROGRESS.md に記録)。ビューアで 500 ページ送ったあとも保持する画像・状態が増え続けない。見つかった問題を直すか、別タスクとして追記している。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run test`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- paths: src/**, src-tauri/src/**, scripts/**, TASKS.md

# MS8 ビューアの手直し(0.2.0 の実機確認から)

## V-07: 情報バーを中央クリックと上下の端の帯でだけ出す
- status: done
- done-when: ビューアの上でポインタを動かしただけでは情報バーが出ない。ポインタが画面の上端・下端の帯(高さ 64px。定数にする)に入ると出て、帯と情報バーの上にある間は隠れず、帯から出て 2.5 秒操作が無いと隠れる。中央クリックは今までどおり出し入れを切り替え、中央クリックで出したバーはもう一度の中央クリックか、ページ送りまで出たままにする。クリック・ホイール・キー・スワイプでのページ送りでは出ない(帯の中にポインタがある間を除く)。拡大中のクリックの扱い(どこでも出し入れ)は変えない。これらを jsdom と仮想時計のテストで確かめ(中央付近でポインタを動かしても `data-ui="hidden"` のまま、上端の帯に入ると出る、帯から出て 2.5 秒で隠れる、左右クリックとホイールで送っても出ない、中央クリックで出して送ると隠れる)、`run shots` の画面を開いて崩れていないことを見ている。
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run test`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run lint`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run shots`
- paths: src/features/viewer/**, docs/rebuild/spec.md
- notes: ユーザー決定(2026-09-26)。マウスのクリックでページを送る読み方で、マウスを動かすたびにバーが出るのを止める。spec 3.3 は更新済み。

## V-08: 下端中央のページ移動スライダー
- status: done
- done-when: 情報バーが出ている間、下端中央(幅は画面の 60%、最大 720px ほど)につまみ付きのスライダーが出る。左右の端に現在のページ(見開きなら先のページ)と総ページを出し、つまみのドラッグ中はつまみの上に行き先のページ番号を出し、離した所の見開きへ移る。右綴じは右が先頭(右から左へ進む)。`role="slider"` と `aria-valuemin`・`aria-valuemax`・`aria-valuenow`・`aria-valuetext` を持ち、フォーカス中の ← / → / Home / End で動かせる(綴じ方向に合わせる)。情報バーが隠れている間は今の細い進捗線だけを出し、進捗線はドラッグで動かさない(表示のみ)。スライダーの位置計算は純粋関数にしてテストがあり(右綴じ・左綴じ、端、見開き)、ドラッグで移るテストがある。紙・墨の `run shots` にバーを出した状態のビューアを 1 枚ずつ足し、開いて見ている。
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run test`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run lint`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run shots`
- paths: src/features/viewer/**, src/design/**, scripts/shots/**
- notes: ユーザー決定(2026-09-26)。手本は TsubameViewer の下端中央のスライダー。行き先の縮小画像は出さない。

## V-08b: スライダーの下地を不透明にし、両端のページ番号を読みやすくする
- status: done
- done-when: スライダーの下地が上端の情報バーと同じ不透明な面(トークンの色)になり、下のページの文字や絵が透けない。両端の現在のページ・総ページの数字が本文と同じ文字サイズ以上で、紙・墨の両テーマで背景との対比が 4.5:1 以上ある(色はトークンだけで描く)。紙・墨の `viewer-bar` のスクリーンショットを開き、ページ下端の文字がスライダーに透けていないこと、数字が読めることを確かめている。
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run lint`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run shots`
- paths: src/features/viewer/**, src/design/**
- notes: V-08 のスクリーンショット(`.harness/shots/paper-viewer-bar.png`・`ink-viewer-bar.png`)で、半透明の下地にページ下端の文字が透け、両端の数字が薄く小さかった。

## V-09: 「読み終わりました」の案内の文言とボタンを見直す
- status: done
- done-when: 本として開いた本で最後の見開きの次に出す案内が、見出し「読み終わりました」・書名と、ボタン「次の巻を読む」(次の巻があるときだけ。先頭から開く)・「最初から読む」(この本の最初の見開きへ)・「閉じる」(ビューアを閉じて開いた元の画面へ戻る。Esc と同じ)を持つ。次の巻が無いときは「次の巻はありません」とだけ添える。案内から前へ送ると最後の見開きに戻る(今と同じ)。各ボタンの動きのテストがある。紙・墨の `run shots` で案内の画面を開いて見ている。
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run test`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run lint`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run shots`
- paths: src/features/viewer/**, scripts/shots/**
- notes: ユーザー決定(2026-09-26): 本の終わりは案内を残し、文言とボタンだけ見直す。

## V-10: 画像ファイルを直接開いたときは端で最初・最後へ回る
- status: done
- done-when: `open_book` が画像ファイルを指定されて親フォルダを開いたとき、結果の `OpenedBook` に開き方 `openMode: 'image'` を載せる(フォルダ・アーカイブ・EPUB・PDF を指定したときは `'book'`)。Rust の `models.rs`・`src/types/app.ts`・`src/lib/tauri.ts`・モックを一組で変え、`cargo test` に画像ファイル指定で `'image'`、フォルダ指定で `'book'` になるテストがある。ビューアは `openMode` が `'image'` のとき、最後の見開きの次は最初の見開き、最初の見開きの前は最後の見開きへ移り、「読み終わりました」の案内を出さない(スライダー・Home / End は今までどおり)。読書位置の保存は今までどおり。`'book'` のときの動きは変えない。ビューアの両方の開き方のテストがある。
- verify: `cargo test --manifest-path src-tauri\Cargo.toml`
- verify: `cargo check --manifest-path src-tauri\Cargo.toml`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run test`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- paths: src-tauri/src/**, src/**
- notes: ユーザー決定(2026-09-26)。危険地帯(フロントと Rust の契約)。評価者を通す。読みかけ・履歴から開き直したときはフォルダを開くので `'book'` になる。

# MS9 AI 超解像の分かりやすさ(0.2.2 の実機確認から)

## V-11: AI ボタンを「AI オン」「AI オフ」と文字で示し、オンのときは朱の地にする
- status: done
- done-when: ビューアの情報バーの AI ボタンの文字が、本の AI がオンのとき「AI オン」、オフのとき「AI オフ」になる(アイコンはそのまま)。オンのときは朱の地(`--color-accent` とその上の文字色のトークン。紙・墨とも対比 4.5:1 以上)、オフのときは今の控えめな見た目にする。`aria-pressed` は今までどおりで、`title` はオン・オフに合わせて「AI 超解像をオフにする」「この本を AI 超解像で高解像度にして表示する」にする。ボタンを押すと文字と `aria-pressed` が切り替わるテストがある。紙・墨の `run shots` に AI をオンにした情報バーの画面を 1 枚ずつ足し、開いて見ている。
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run test`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run lint`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run shots`
- paths: src/features/viewer/**, src/design/**, src/lib/tauri-mock.ts, scripts/shots/**
- notes: ユーザー決定(2026-09-26)。spec 3.5 は更新済み。

## A-07: 「初めて開く本でも AI をオンにする」の設定
- status: done
- done-when: 設定ストア `prismpage-settings` に `enhanceNewBooks: boolean`(既定 false)を足して version を 5 から 6 に上げ、version 2〜5 の保存は各項目を引き継いで新しい項目を既定値で補う(1 以前と未知の版は今の規則どおり既定値)。設定画面の「AI 超解像」に「初めて開く本でも AI をオンにする」の切り替えがある。本ごとの記録 `prismpage-enhanced-books` を、オンにした本だけでなく利用者が切り替えた本のオン・オフを覚える形(例: 本 ID → 真偽、古く切り替えた順に 500 冊まで)に変えて version を 1 から 2 に上げ、version 1 の `bookIds` はすべて「オン」の記録として引き継ぐ。記録の無い本はこの設定に従い、記録のある本は記録に従う(設定がオンでも、オフに切り替えた本はオフのまま)。テストが、設定の 5→6 の移行、本ごとの記録の 1→2 の移行、記録の無い本が設定に従うこと、オフの記録が設定より優先されることを確かめている。
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run test`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run lint`
- verify: `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build`
- paths: src/features/settings/**, src/features/viewer/**, src/lib/**
- notes: ユーザー決定(2026-09-26)。危険地帯(永続化の形式)。評価者を通す。
