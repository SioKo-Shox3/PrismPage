// 拡大表示の計算(拡大率とパン)の純粋関数。
// 拡大は合わせ方で決まった見開きの大きさ(拡大率 1)を基準にし、位置は「見開きの中心が表示領域の中心から
// どれだけずれているか」(CSS px)で持つ。拡大率 1 に戻ったら拡大していない状態(null)として扱う。

export interface Zoom {
  scale: number
  // 見開きの中心の、表示領域の中心からのずれ(CSS px。右・下が正)。
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

// 点(表示領域の中心からの位置、CSS px)。
export interface Point {
  x: number
  y: number
}

export const MIN_ZOOM = 1
export const MAX_ZOOM = 8
// +/- 1 回で変える倍率。
export const ZOOM_KEY_STEP = 1.25
// ダブルクリックで拡大するときの拡大率。
export const ZOOM_DOUBLE_CLICK_SCALE = 2
// Ctrl+ホイールの回転量 1px あたりの感度(下へ回すと縮小)。
export const ZOOM_WHEEL_SENSITIVITY = 0.002
// これより小さい拡大率の差は 1 と見なす(浮動小数の誤差で拡大が解けなくなるのを防ぐ)。
const SCALE_EPSILON = 1e-3

// はみ出した分だけ動かせるようにパンを収める。見開きが表示領域より小さい向きは中央に固定する。
export function clampPan(zoom: Zoom, content: Size, viewport: Size): Zoom {
  const limit = (length: number, view: number) => Math.max(0, (length * zoom.scale - view) / 2)
  const clamp = (value: number, max: number) => (max === 0 ? 0 : Math.min(max, Math.max(-max, value)))
  return {
    scale: zoom.scale,
    x: clamp(zoom.x, limit(content.width, viewport.width)),
    y: clamp(zoom.y, limit(content.height, viewport.height)),
  }
}

// `anchor` の下にある見開きの点を動かさずに、拡大率を `scale` にする。範囲外の拡大率は収め、
// 1 になったら null(拡大の解除)を返す。`current` が null のときは拡大率 1・ずれ `base` から始める。
export function zoomTo(
  current: Zoom | null,
  scale: number,
  anchor: Point,
  content: Size,
  viewport: Size,
  base: Point = { x: 0, y: 0 },
): Zoom | null {
  const from = current ?? { scale: 1, x: base.x, y: base.y }
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(scale) ? scale : from.scale))
  if (next - MIN_ZOOM < SCALE_EPSILON) return null
  const ratio = next / from.scale
  return clampPan(
    {
      scale: next,
      x: anchor.x - (anchor.x - from.x) * ratio,
      y: anchor.y - (anchor.y - from.y) * ratio,
    },
    content,
    viewport,
  )
}

// 今の拡大率に `factor` を掛ける(+/- と Ctrl+ホイール)。
export function zoomBy(
  current: Zoom | null,
  factor: number,
  anchor: Point,
  content: Size,
  viewport: Size,
  base?: Point,
): Zoom | null {
  return zoomTo(current, (current?.scale ?? 1) * factor, anchor, content, viewport, base)
}

// Ctrl+ホイールの回転量(CSS px。正は下向き)を倍率に変える。上へ回すと拡大する。
export function wheelZoomFactor(deltaPixels: number): number {
  return Math.exp(-deltaPixels * ZOOM_WHEEL_SENSITIVITY)
}

// ダブルクリック。拡大していなければその点を中心に拡大し、拡大中なら元に戻す。
export function toggleZoomAt(
  current: Zoom | null,
  anchor: Point,
  content: Size,
  viewport: Size,
  base?: Point,
): Zoom | null {
  if (current) return null
  return zoomTo(null, ZOOM_DOUBLE_CLICK_SCALE, anchor, content, viewport, base)
}

// ドラッグ・ホイールで見開きを (dx, dy) だけ動かす。
export function panBy(current: Zoom, dx: number, dy: number, content: Size, viewport: Size): Zoom {
  return clampPan({ ...current, x: current.x + dx, y: current.y + dy }, content, viewport)
}

// 幅に合わせて縦にスクロールしている表示の、見開きの中心のずれ(拡大率 1)。拡大を始める位置に使う。
export function offsetFromScroll(scrollTop: number, contentHeight: number, viewportHeight: number): number {
  if (contentHeight <= viewportHeight) return 0
  return contentHeight / 2 - viewportHeight / 2 - scrollTop
}

// 拡大を解いたとき、表示領域の中心にあった見開きの点が中心に来るスクロール位置(幅に合わせる表示用)。
export function scrollFromZoom(zoom: Zoom, contentHeight: number, viewportHeight: number): number {
  const center = contentHeight / 2 - zoom.y / zoom.scale
  const max = Math.max(0, contentHeight - viewportHeight)
  return Math.min(max, Math.max(0, center - viewportHeight / 2))
}
