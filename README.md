# PrismPage

PrismPage は **Tauri 2 + React + TypeScript** で構築した、画像重視の EPUB 電子書籍ビューワーです。  
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
- `waifu2x-ncnn-vulkan` / `Real-ESRGAN-ncnn-vulkan` の切り替え
- AI エンジンの ZIP 取込 / 展開済みフォルダ登録 / 状態確認 / 登録解除

## AI 超解像について

PrismPage は AI エンジンをアプリに固定同梱せず、**ユーザーが後から登録**できる構成です。

- **waifu2x-ncnn-vulkan**
  - 漫画・線画・スキャン向け
- **Real-ESRGAN-ncnn-vulkan**
  - 表紙・挿絵・写真混在向け

設定画面から以下を行えます。

- 優先エンジンの切り替え
- 公式配布ページを開く
- ZIP アーカイブをアプリへ取り込む
- 展開済みフォルダを直接登録する
- エンジンの状態確認と登録解除

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
