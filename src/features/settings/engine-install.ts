import type { EngineId, EngineInstallProgress, EngineStatus } from '@/types/app'

// 設定画面の「AI エンジン」の決め事。導入の進み具合の文言、失敗したときの次の手、状態の表示。

// エンジンを導入・登録する操作。失敗したときの次の手を操作ごとに変える。
export type EngineOperation = 'release' | 'archive' | 'directory' | 'candidate' | 'clear' | 'status' | 'detect'

const operationFailure: Record<EngineOperation, string> = {
  release: '公式配布を導入できませんでした',
  archive: 'ZIP を取り込めませんでした',
  directory: 'フォルダを登録できませんでした',
  candidate: '見つかったエンジンを登録できませんでした',
  clear: '登録を解除できませんでした',
  status: 'エンジンの状態を確かめられませんでした',
  detect: 'PC 内のエンジンを探せませんでした',
}

// 失敗の表示。`title` は何ができなかったか、`cause` は原因(Rust の文言)、`next` は次にできること。
export interface EngineFailure {
  title: string
  cause: string
  next: string
}

// 失敗の原因の文言から、利用者が次にできることを決める。当てはまる手が無ければ操作ごとの既定の手にする。
// `engineId` はモデルの置き場所の案内に使う(一覧全体の操作では null)。
export function describeEngineFailure(
  operation: EngineOperation,
  cause: string,
  engineId: EngineId | null = null,
): EngineFailure {
  return { title: operationFailure[operation], cause, next: nextStep(operation, cause, engineId) }
}

// 取得(ダウンロード)を伴う操作。通信・ダウンロード中断の案内はこれだけに出す。
const fetchingOperations: ReadonlySet<EngineOperation> = new Set(['release'])

// Rust の登録処理が探すモデルの置き場所(`registry.rs` の `build_engine_config`)。
const modelLocations: Record<EngineId, string> = {
  'real-cugan': 'models-se・models-pro・models-nose のいずれかのフォルダ',
  waifu2x: 'models-cunet・models-upconv_7_anime_style_art_rgb・models-upconv_7_photo のいずれかのフォルダ',
  'real-esrgan': 'models フォルダ(モデルの .param と .bin)',
}

function nextStep(operation: EngineOperation, cause: string, engineId: EngineId | null) {
  // 動作確認(ヘルスチェック・起動)の失敗は通信の失敗より先に見る。文言に「タイムアウト」や「空」を含むため。
  if (/起動できません|ヘルスチェック|Vulkan|GPU/i.test(cause)) {
    return 'GPU のドライバーを更新してから「状態を確かめる」を押してください。直らなければ別のエンジンを試してください。'
  }
  if (fetchingOperations.has(operation)) {
    if (/接続|HTTP|タイムアウト|時間切れ|timed out|error sending request/i.test(cause)) {
      return 'インターネットへの接続を確かめてから、もう一度「公式配布を取得」を押してください。つながらない環境では、配布ページから ZIP を落として「ZIP を取り込む」を使えます。'
    }
    if (/サイズが一致しません|空でした|上限サイズ/.test(cause)) {
      return 'ダウンロードが途中で切れた可能性があります。もう一度取得するか、配布ページから ZIP を落として取り込んでください。'
    }
    if (/見つかりませんでした|確認できませんでした/.test(cause)) {
      return '公式配布の形が変わった可能性があります。配布ページから Windows 向けの ZIP を落として「ZIP を取り込む」を使ってください。'
    }
  }
  if (/危険なパス|多すぎる|展開後のサイズ|同名/.test(cause)) {
    return 'この ZIP は安全に展開できません。配布ページから落とし直した ZIP を選んでください。'
  }
  if (/実行ファイル|モデル/.test(cause)) {
    const models = engineId ? modelLocations[engineId] : '対応するモデルフォルダ'
    return operation === 'archive'
      ? `ZIP の中に実行ファイル(*-ncnn-vulkan.exe)と ${models}があるか確かめてください。ソースコードの ZIP ではなく Windows 向けの配布物を選びます。`
      : `実行ファイル(*-ncnn-vulkan.exe)と ${models}が入っているフォルダを選んでください。`
  }
  if (/ZIP ファイルが見つかりません|フォルダが見つかりません/.test(cause)) {
    return '選んだ場所が移動・削除されていないか確かめて、もう一度選んでください。'
  }
  switch (operation) {
    case 'release':
      return 'もう一度取得するか、配布ページから ZIP を落として「ZIP を取り込む」を使ってください。'
    case 'archive':
      return 'Windows 向けの配布 ZIP を選び直してください。'
    case 'directory':
    case 'candidate':
      return 'エンジンを展開したフォルダを選び直してください。'
    case 'clear':
    case 'status':
    case 'detect':
      return 'しばらくしてからもう一度試してください。直らなければアプリを再起動してください。'
  }
}

const mebibyte = 1024 * 1024

// バイト数を「12.3 MB」の形にする(1024 進)。
export function formatMegabytes(bytes: number) {
  const value = bytes / mebibyte
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} MB`
}

// 導入の進み具合の文言と、進捗線の値(0〜1。長さの分からない段階は null)。
export function installProgressView(progress: EngineInstallProgress): { text: string; value: number | null } {
  switch (progress.stage) {
    case 'verifying':
      return { text: '公式配布を確かめています', value: null }
    case 'downloading':
      return progress.total > 0
        ? {
            text: `ダウンロードしています ${formatMegabytes(progress.done)} / ${formatMegabytes(progress.total)}`,
            value: progress.done / progress.total,
          }
        : { text: 'ダウンロードしています', value: null }
    case 'extracting':
      return progress.total > 0
        ? { text: `展開しています ${progress.done} / ${progress.total} 項目`, value: progress.done / progress.total }
        : { text: '展開しています', value: null }
    case 'registering':
      return { text: '登録して動作を確かめています', value: null }
  }
}

// エンジンの状態の表示。使える・登録したが動かない・未登録 の 3 つ。
export function engineState(status: EngineStatus): { label: string; tone: 'success' | 'warning' | 'neutral' } {
  if (status.ready) return { label: '使えます', tone: 'success' }
  if (status.configured) return { label: '動作を確かめられません', tone: 'warning' }
  return { label: '未登録', tone: 'neutral' }
}

// 登録の出どころ(Rust の `source_label` の文言)を画面の言い方にそろえる。知らない値はそのまま出す。
const sourceTexts: Record<string, string> = {
  アプリ内インストール: '公式配布から導入',
  'ZIP 取込': 'ZIP から取り込み',
  外部フォルダ: '既存のフォルダ',
}

export function sourceText(source: string | undefined) {
  if (!source) return null
  return sourceTexts[source] ?? source
}
