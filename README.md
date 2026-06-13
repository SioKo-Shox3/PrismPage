# PrismPage

PrismPage は **Tauri 2 + React + TypeScript** で構築した、Windows PC 向けの画像重視 EPUB 電子書籍ビューワーです。

漫画・画集・スキャン系 EPUB を主対象にしつつ、読書位置の保存、画像拡大、AI 超解像エンジンの切り替えと導入支援をひとつのデスクトップアプリにまとめています。

## 現在の実装範囲

- ローカル EPUB の取り込み
- 本棚表示
- EPUB 読書画面
- 目次ジャンプ
- 読書位置の保存
- テーマ切り替え（Dark / Light / Sepia）
- 本文サイズ・行間の調整
- EPUB 内画像の拡大表示
- `.epub` ファイルの関連付け候補としての登録
- GitHub Releases の公開済み配布を対象にした手動アップデート確認
- `Real-CUGAN` / `waifu2x` / `Real-ESRGAN` の切り替え
- AI エンジンの公式配布取得 / 既存フォルダ登録 / 候補検索 / ZIP 取込 / 状態確認 / 登録解除

## 利用想定と配布

PrismPage は Windows PC にインストールして使うデスクトップアプリとして整備しています。

- `.epub` の関連付け候補として登録されます。既定の EPUB アプリとして使う場合は、Windows の「既定のアプリ」または「プログラムから開く」から PrismPage をユーザーが選択してください。
- PrismPage v0.1.0 beta は、GitHub Actions で Windows 向け NSIS インストーラを作成し、GitHub Releases から配布する想定です。
- アプリ内の手動アップデート確認は、GitHub Releases の公開済み配布版を確認します。draft の Release は表示されません。

## AI 超解像について

PrismPage は AI エンジンをアプリ本体に固定同梱せず、設定画面から**公式配布 ZIP を取得してアプリ内へインストール**できます。既に PC 上へ配置済みのエンジンフォルダを参照登録する使い方も残しています。

アプリ内インストールでは、各エンジンの公式 GitHub Releases から Windows 向け ZIP を取得し、PrismPage の app data 配下へ展開して登録します。

- **Real-CUGAN**
  - 漫画・イラスト向け
- **waifu2x**
  - 漫画・線画向け
- **Real-ESRGAN**
  - 表紙・挿絵・写真混在向け

設定画面から以下を行えます。

- 優先エンジンの切り替え
- 公式配布 ZIP を取得してアプリ内へインストールする
- 公式配布ページを開く
- PC 上の既存エンジンフォルダを直接登録する
- PC 上の既定候補や `tools` 配下などから登録候補を検索する
- ZIP アーカイブをアプリへ取り込む
- エンジンの状態確認と登録解除

ZIP 取込は手動導入向けの互換機能として残していますが、推奨は設定画面から公式配布を取得してアプリ内へインストールする使い方です。

## 開発コマンド

PowerShell 環境では `npm.ps1` ではなく `npm-cli.js` を直接呼んでいます。

### フロントエンド

```powershell
node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run lint
node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build
```

### Tauri

```powershell
node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" exec tauri dev
node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" exec tauri build -- --debug
```

### Rust 側チェック

```powershell
cargo check --manifest-path src-tauri\Cargo.toml
```

### Release ビルド

GitHub Actions の `release` workflow は `app-v*` タグで Windows NSIS インストーラを作成します。v0.1.0 beta の例:

```powershell
git tag app-v0.1.0
git push origin app-v0.1.0
```

## 構成

```text
src/
  app/                   ルーターとアプリ骨格
  features/library/      本棚と EPUB 取込
  features/reader/       epub.js ベースの読書画面
  features/settings/     読書設定とテーマ
  features/ai-installer/ AI エンジン導入支援 UI
  lib/                   Tauri 呼び出しと EPUB 補助

src-tauri/
  src/commands/          フロントから呼ぶ Tauri commands
  src/services/          EPUB 取込、AI エンジン登録、ZIP 展開、画像処理
```
