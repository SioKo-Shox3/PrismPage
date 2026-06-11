# AGENTS.md

## プロジェクト概要

- PrismPage は Tauri 2 + React + TypeScript で構築した、画像重視の EPUB ビューワーです。
- 主な対象は漫画、画集、スキャン系 EPUB です。読書位置保存、画像拡大、AI 超解像エンジンの登録と切り替えを扱います。
- UI 文言とREADMEは日本語中心です。ユーザー向け文言を追加・変更するときも日本語を基本にしてください。

## 作業環境

- Windows / PowerShell を前提にします。
- PowerShell では `npm.ps1` を直接使わず、README と同じく npm CLI を Node 経由で呼び出してください。
- Vite dev server は `127.0.0.1:1420` 固定です。`package.json` と `vite.config.ts` は `strictPort` を使っています。

## よく使うコマンド

```powershell
node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run lint
node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run build
cargo check --manifest-path src-tauri\Cargo.toml
```

Tauri を起動・ビルドするとき:

```powershell
node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" exec tauri dev
node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" exec tauri build -- --debug
```

## 構成の目安

- `src/app/router.tsx`: TanStack Router のルート定義。
- `src/App.tsx`: アプリシェル、サイドバー、ナビゲーション。
- `src/features/library/`: 本棚、EPUB 取り込み、Zustand の本棚ストア。
- `src/features/reader/`: epub.js ベースの読書画面。
- `src/features/settings/`: テーマ、表示設定、AI エンジン設定のストアと画面。
- `src/features/ai-installer/`: AI エンジン登録・状態確認 UI。
- `src/lib/tauri.ts`: フロントエンドから Tauri command を呼ぶ薄いラッパー。
- `src/types/app.ts`: フロントエンドで共有するアプリ型。
- `src-tauri/src/commands/`: Tauri command の公開層。
- `src-tauri/src/services/`: EPUB 取り込み、AI エンジン登録、ZIP 展開、画像処理などの実処理。
- `src-tauri/src/models.rs`: Rust 側のシリアライズ型。TypeScript 側の型と整合させてください。

## 実装ルール

- 既存の機能ディレクトリ単位を優先し、新しい共有化は重複や境界が明確になってから行ってください。
- フロントエンドから Rust へ渡すデータを変更するときは、`src/lib/tauri.ts`、`src/types/app.ts`、`src-tauri/src/models.rs`、該当 command/service をまとめて確認してください。
- Tauri command を追加したら、`src-tauri/src/lib.rs` の `tauri::generate_handler!` への登録を忘れないでください。
- Zustand の永続化キーは既存の `prismpage-library`、`prismpage-settings` との互換性を意識してください。
- EPUB や AI エンジン ZIP など、ローカルファイルを扱う変更では、パストラバーサル、存在確認、失敗時の後片付けを確認してください。
- AI エンジン実行は外部バイナリ呼び出しです。タイムアウト、標準出力・標準エラー、未登録状態のエラーメッセージを壊さないでください。
- UI は既存のCSS変数、パネル、ボタン、チップ、ステータス表示のパターンに合わせてください。lucide-react が入っているので、必要なアイコンはそこから使うのを優先してください。

## 検証方針

- TypeScript/React を変更したら、少なくとも `run lint` を実行してください。型やバンドルに関わる変更では `run build` も実行してください。
- Rust/Tauri 側を変更したら、`cargo check --manifest-path src-tauri\Cargo.toml` を実行してください。
- Tauri command のインターフェースやフロント・Rust の接続部を変えたら、フロントエンドの `run build` と Rust の `cargo check` の両方を実行してください。
- UI 表示や操作を変えたら、可能なら dev server を起動して `http://127.0.0.1:1420` をブラウザで確認してください。
- 検証できなかったコマンドがある場合は、理由と残るリスクを最終報告に書いてください。

## Git と変更範囲

- ユーザーの未コミット変更がある可能性を常に考慮し、依頼外の差分は戻さないでください。
- 生成物の `dist/`、`src-tauri/target/`、`src-tauri/gen/` は通常編集しません。
- 依存関係の追加や大きな設定変更は、必要性が明確な場合だけにしてください。

## Multi-Agent Workflow

- メインエージェントはオーケストレーターとして、フェーズ分解、設計判断、順序管理、統合、コミット境界、検証調整、最終受け入れを担当してください。
- substantial work（実質的な作業）では、メインエージェント自身が実装者になってはいけません。メインエージェントは作業分解、依頼文作成、サブエージェント結果の統合判断、検証調整、最終報告に徹してください。
- ファイル編集を伴う実装は、原則として実装担当サブエージェントに割り当ててください。メインエージェントが直接編集してよいのは、AGENTS.md などの運用ルール修正、軽微な計画メモ、サブエージェント成果物の衝突解消に必要な最小限の統合編集に限ります。
- メインエージェントが最小限の統合編集を行う場合も、その前後で実装レビュー担当サブエージェントのレビューを通し、レビュー未通過のまま次フェーズへ進めないでください。
- サブエージェントを待たずにメインエージェントが同じ実装範囲を先行実装することを禁止します。待機中は、非重複の調査、計画調整、検証準備、ユーザーへの状況共有だけを行ってください。
- 大規模作業を開始・再開するときは、最初に全体の作業計画を作成し、タスク単位へ分割してください。各タスクには目的、担当範囲、影響ファイル、受け入れ条件、検証方法、リスク、ロールバック、コミット境界を含めてください。
- タスクは原則として 1 つずつ進め、各タスクごとに「計画確認、実装、実装レビュー、検証、コミット可否判断」を完了してから次のタスクへ進んでください。
- タスクごとにコミットできる粒度を優先してください。複数タスクにまたがる差分が発生した場合は、統合前に差分を棚卸しし、可能な限りタスク単位でステージングとコミットを分けてください。
- 既に未コミット差分がある状態で大規模作業を再開する場合は、最初のタスクを「現状差分の棚卸しとタスク境界の再設定」にし、ユーザーや他エージェントの差分を戻さずに扱ってください。
- リポジトリ作業でフェーズ計画またはファイル編集が必要な場合は、計画、実装、レビューをサブエージェントに分担してください。
- 計画作成者と計画レビュワーは別エージェントにしてください。
- 実装者と実装レビュー担当は必ず別エージェントにしてください。
- 各フェーズは、計画レビュー、実装、実装レビュー、検証を通過してから次フェーズへ進めてください。
- 会話と将来のコミットメッセージは日本語を基本にしてください。
- フェーズ計画には、目標、影響ファイル、実装方針、検証方法、リスク、ロールバック、コミット境界を含めてください。
- PrismPage 固有のレビューでは、Tauri command 登録、TypeScript/Rust 型整合、Zustand 永続化キー、ローカルファイル安全性、AI エンジン実行時のエラー/タイムアウト、UI 日本語文言を確認してください。

## MCP Usage

- GitHub MCP / GitHub app は、Issue、PR、レビュー、Actions、CI、ブランチ情報が必要なときに使ってください。
- Context7 は、Tauri、React、TypeScript、TanStack Router、Zustand、epub.js、lucide-react などの最新ドキュメント確認に優先して使ってください。
- より広い調査やリリースノート確認が必要な場合は Web 検索を使い、公式ドキュメントやリポジトリなど一次情報を優先してください。
- MCP トークンや認証情報はリポジトリに書かないでください。

## Agent-Specific Instructions

- 生成物の `dist/`、`src-tauri/target/`、`src-tauri/gen/` は編集しないでください。
- 既存コマンドと Vite dev server の固定ポート `127.0.0.1:1420` を維持してください。
- substantial work（実質的な作業）では `Multi-Agent Workflow` に従ってください。
- ユーザーの未コミット変更や他エージェントの変更を戻さないでください。
- フロントエンドと Rust の接続部を扱うときは、`src/lib/tauri.ts`、`src/types/app.ts`、`src-tauri/src/models.rs`、`src-tauri/src/lib.rs` の整合を確認してください。
