import type { Binding } from './spread'

// 下端中央のページ移動スライダーの位置計算。スライダーは見開き単位で動き、
// 右綴じは右端が先頭(右から左へ進む)、左綴じは左端が先頭。
// 位置(ratio)はつまみの中心の、スライダーの左端からの割合(0〜1)。

// 見開きの番号から、つまみの位置を求める。見開きが 1 つ以下なら先頭の端に置く。
export function sliderRatio(spreadIndex: number, spreadCount: number, binding: Binding): number {
  const progress = spreadCount > 1 ? Math.min(1, Math.max(0, spreadIndex / (spreadCount - 1))) : 0
  return binding === 'right' ? 1 - progress : progress
}

// スライダー上の位置から、いちばん近い見開きの番号を求める。範囲外は端に収め、見開きが無ければ -1。
export function sliderIndexAt(ratio: number, spreadCount: number, binding: Binding): number {
  if (spreadCount <= 0) return -1
  const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0
  const progress = binding === 'right' ? 1 - clamped : clamped
  return Math.round(progress * (spreadCount - 1))
}

// フォーカス中のキーで動かした先の見開き。← / → は綴じ方向に合わせ(右綴じは ← が次)、
// Home は先頭、End は最後。関係の無いキーは null。
export function sliderKeyIndex(key: string, spreadIndex: number, spreadCount: number, binding: Binding): number | null {
  if (spreadCount <= 0) return null
  const last = spreadCount - 1
  const forward = binding === 'right' ? 'ArrowLeft' : 'ArrowRight'
  const backward = binding === 'right' ? 'ArrowRight' : 'ArrowLeft'
  switch (key) {
    case forward:
      return Math.min(last, spreadIndex + 1)
    case backward:
      return Math.max(0, spreadIndex - 1)
    case 'Home':
      return 0
    case 'End':
      return last
    default:
      return null
  }
}

// 左右の端に出す文字。先頭の側に現在のページ、終わりの側に総ページ。
export function sliderEnds(binding: Binding, current: string, total: string): { left: string; right: string } {
  return binding === 'right' ? { left: total, right: current } : { left: current, right: total }
}
