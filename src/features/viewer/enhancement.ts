import type { EngineId, EngineStatus, EnhanceSettings } from '@/types/app'

// ビューアの AI 超解像の決め事。表示中の次に先回りで処理するページ数、使うエンジンと設定、上端バーの文言。

// 設定で選べる先読みのページ数(1 回の要求は Rust 側で表示中と合わせて 64 ページまで)。
export const PREFETCH_PAGE_OPTIONS = [0, 2, 4, 8, 12] as const

// エンジンごとに選べるモデルと倍率(Rust の `cache::supported_scales` と同じ表)。先頭のモデルが既定。
const modelScales: Record<EngineId, Array<[model: string, scales: number[]]>> = {
  'real-cugan': [
    ['models-se', [2, 3, 4]],
    ['models-pro', [2, 3]],
    ['models-nose', [2]],
  ],
  waifu2x: [
    ['models-cunet', [2, 4]],
    ['models-upconv_7_anime_style_art_rgb', [2, 4]],
    ['models-upconv_7_photo', [2, 4]],
  ],
  'real-esrgan': [
    ['realesr-animevideov3', [2, 3, 4]],
    ['realesr-animevideov3-x2', [2]],
    ['realesr-animevideov3-x3', [3]],
    ['realesr-animevideov3-x4', [4]],
    ['realesrgan-x4plus', [4]],
    ['realesrgan-x4plus-anime', [4]],
  ],
}

// エンジンが持つモデルの名前(先頭が既定)。
export function engineModels(engine: EngineId): string[] {
  return modelScales[engine].map(([model]) => model)
}

// エンジンとモデルの組で選べる倍率。対応表に無いモデルは空。
export function modelScaleOptions(engine: EngineId, model: string): number[] {
  return modelScales[engine].find(([name]) => name === model)?.[1] ?? []
}

// エンジンに使うモデル。設定で選んだモデル、登録したモデル、エンジンの既定のモデルの順に、対応表にあるものを使う。
export function effectiveModel(engine: EngineId, chosen: string | undefined, registered?: string) {
  const models = engineModels(engine)
  return [chosen, registered].find((model) => model !== undefined && models.includes(model)) ?? models[0]
}

// モデルで使う倍率。設定の倍率をモデルが持たなければ、そのモデルの最小の倍率にする。
export function effectiveScale(engine: EngineId, model: string, preferred: number) {
  const scales = modelScaleOptions(engine, model)
  return scales.includes(preferred) ? preferred : Math.min(...scales)
}

// 表示中のページ(`visible`)の次から `count` ページ。読む順はページ番号の順なので綴じ方向によらない。
export function prefetchPages(visible: readonly number[], pageCount: number, count: number) {
  if (visible.length === 0) return []
  const last = Math.max(...visible)
  const pages: number[] = []
  for (let index = last + 1; index < pageCount && pages.length < count; index += 1) {
    pages.push(index)
  }
  return pages
}

// 設定画面で選んだ AI の既定値。
export interface EnhanceDefaults {
  engine: EngineId
  models: Partial<Record<EngineId, string>>
  scale: number
}

// 使うエンジンと設定を決める。設定で選んだエンジンが使えればそれを、使えなければ使える最初のエンジンを使う。
// 使えるエンジンが無ければ null(設定画面への案内を出す)。モデルは `effectiveModel`、倍率は `effectiveScale` で決める。
export function resolveEnhanceSettings(
  statuses: readonly EngineStatus[],
  defaults: EnhanceDefaults,
): EnhanceSettings | null {
  const ready = statuses.filter((status) => status.ready)
  const status = ready.find((candidate) => candidate.id === defaults.engine) ?? ready[0]
  if (!status) return null

  const model = effectiveModel(status.id, defaults.models[status.id], status.modelName)
  const scale = effectiveScale(status.id, model, defaults.scale)
  return { engine: status.id, model, scale, denoise: defaultDenoise(status.id, model) }
}

// ノイズ除去の既定値。Real-CUGAN は控えめ(-1。ノイズ除去なしのモデルは 0)、waifu2x はなし(0)、
// Real-ESRGAN は指定しない。
function defaultDenoise(engine: EngineId, model: string): number | undefined {
  switch (engine) {
    case 'real-cugan':
      return model === 'models-nose' ? 0 : -1
    case 'waifu2x':
      return 0
    case 'real-esrgan':
      return undefined
  }
}

// 上端バーに出す処理の進み具合。
export interface EnhanceProgress {
  scale: number
  // 表示中のページ(処理を要求したもの)の数と、そのうち処理済みの数・失敗した数。
  visibleTotal: number
  visibleDone: number
  visibleFailed: number
  // 先読みのページの数と、そのうち処理済みの数。
  prefetchTotal: number
  prefetchDone: number
}

// 上端バーの文言。1 つ目は表示中のページの状態、2 つ目は先読みの状態(すべて済んだら null)。
export function enhanceStatusText(progress: EnhanceProgress): { current: string; ahead: string | null } {
  const label = `AI ${progress.scale}×`
  let current: string
  if (progress.visibleFailed > 0) {
    current = `${label} 処理できないページがあります`
  } else if (progress.visibleDone < progress.visibleTotal) {
    current = `${label} 処理中`
  } else {
    current = `${label} 適用中`
  }
  const ahead =
    progress.prefetchDone < progress.prefetchTotal
      ? `先の ${progress.prefetchTotal} ページを準備中 ${progress.prefetchDone}/${progress.prefetchTotal}`
      : null
  return { current, ahead }
}

// 一括事前処理の状態。`done` は処理済み(元から済んでいたページを含む)、`failed` は処理できなかったページの数。
export type BatchProgress =
  | { state: 'starting' }
  | { state: 'running' | 'stopped' | 'finished'; done: number; failed: number; total: number }
  | { state: 'error'; message: string }

// 一括事前処理の文言(上端バーに出す)。
export function batchStatusText(batch: BatchProgress): string {
  switch (batch.state) {
    case 'starting':
      return '全ページの事前処理を準備中'
    case 'error':
      return `全ページの事前処理を始められません: ${batch.message}`
    case 'running':
    case 'stopped':
    case 'finished': {
      const count = `${batch.done} / ${batch.total} ページ`
      const failed = batch.failed > 0 ? `(処理できないページ ${batch.failed})` : ''
      const label =
        batch.state === 'running' ? '全ページを事前処理中' : batch.state === 'stopped' ? '事前処理を中止' : '事前処理済み'
      return `${label} ${count}${failed}`
    }
  }
}
