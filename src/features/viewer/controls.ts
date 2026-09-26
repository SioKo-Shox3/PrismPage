import type { Binding } from './spread'

// ビューアの入力(キー・クリック・ホイール・スワイプ・シーク)を動作に割り当てる純粋関数。
// 画面側はここで決まった動作を reducer の action や全画面の切り替えに変えるだけにする。

// 入力から決まる動作。
export type ViewerCommand =
  | 'next'
  | 'prev'
  | 'first'
  | 'last'
  | 'toggleSpread'
  | 'toggleBinding'
  | 'shift'
  | 'fullscreen'
  | 'escape'
  | 'toggleUi'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'

export interface KeyInput {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
}

// キーの割り当て。← / → は綴じ方向に合わせる(右綴じなら ← が次)。修飾キー付きは扱わない
// (Shift は Space の向きの反転にだけ使う)。
export function keyCommand(input: KeyInput, binding: Binding): ViewerCommand | null {
  if (input.altKey || input.ctrlKey || input.metaKey) return null
  switch (input.key) {
    case 'ArrowLeft':
      return binding === 'right' ? 'next' : 'prev'
    case 'ArrowRight':
      return binding === 'right' ? 'prev' : 'next'
    case ' ':
      return input.shiftKey ? 'prev' : 'next'
    case 'PageDown':
      return 'next'
    case 'PageUp':
      return 'prev'
    case 'Home':
      return 'first'
    case 'End':
      return 'last'
    case 'F11':
      return 'fullscreen'
    case 'Escape':
      return 'escape'
    // テンキーも同じ key を送る。'=' は US 配列で Shift なしに押せる '+' の位置。
    case '+':
    case '=':
      return 'zoomIn'
    case '-':
      return 'zoomOut'
    case '0':
      return 'zoomReset'
  }
  switch (input.key.toLowerCase()) {
    case 't':
      return 'toggleSpread'
    case 'b':
      return 'toggleBinding'
    case 'q':
      return 'shift'
    case 'f':
      return 'fullscreen'
    default:
      return null
  }
}

// クリックで次・前に割り当てる左右の領域の幅(画面幅に対する割合)。残りの中央は UI の表示切り替え。
export const CLICK_SIDE_RATIO = 1 / 3

// クリック位置(表示領域の左端からの距離)の割り当て。左右の領域は綴じ方向に合わせ、
// 右綴じなら左が次、左綴じなら右が次。拡大中はページ送りの領域を無くし、どこでも UI の出し入れにする。
export function clickCommand(
  x: number,
  width: number,
  binding: Binding,
  zoomed = false,
): 'next' | 'prev' | 'toggleUi' {
  if (zoomed || !(width > 0)) return 'toggleUi'
  const ratio = x / width
  if (ratio < CLICK_SIDE_RATIO) return binding === 'right' ? 'next' : 'prev'
  if (ratio > 1 - CLICK_SIDE_RATIO) return binding === 'right' ? 'prev' : 'next'
  return 'toggleUi'
}

// ホイールの間引き。1 回ページを送ったら WHEEL_COOLDOWN_MS の間は入力を捨て、
// それ以外は同じ向きの回転量を WHEEL_THRESHOLD まで溜めてから送る(タッチパッドの細かい入力を 1 回にまとめる)。
export const WHEEL_THRESHOLD = 40
export const WHEEL_COOLDOWN_MS = 250
// これより間の空いた入力は、溜めた回転量を捨ててから数える。
export const WHEEL_IDLE_RESET_MS = 200

export interface WheelGate {
  // 溜めている回転量(CSS px。正は下向き)。
  accumulated: number
  lastAt: number
  // この時刻までは入力を捨てる。
  lockedUntil: number
}

export const initialWheelGate: WheelGate = {
  accumulated: 0,
  lastAt: Number.NEGATIVE_INFINITY,
  lockedUntil: Number.NEGATIVE_INFINITY,
}

export interface WheelInput {
  deltaY: number
  // WheelEvent.deltaMode(0: px、1: 行、2: ページ)。
  deltaMode: number
  // ミリ秒の時刻。
  now: number
}

const LINE_HEIGHT_PX = 16
const PAGE_HEIGHT_PX = 800

// ホイールの回転量を CSS px にそろえる。
export function wheelPixels(input: WheelInput): number {
  if (input.deltaMode === 1) return input.deltaY * LINE_HEIGHT_PX
  if (input.deltaMode === 2) return input.deltaY * PAGE_HEIGHT_PX
  return input.deltaY
}

// ホイール 1 回分の入力を受け、次の間引き状態と送る向き(送らなければ null)を返す。
// 既定は下へ回すと次、`reversed` のときは上へ回すと次。
export function wheelStep(
  gate: WheelGate,
  input: WheelInput,
  reversed: boolean,
): { gate: WheelGate; command: 'next' | 'prev' | null } {
  const delta = wheelPixels(input)
  if (input.now < gate.lockedUntil || delta === 0) {
    return { gate: { ...gate, accumulated: 0, lastAt: input.now }, command: null }
  }
  const stale = input.now - gate.lastAt > WHEEL_IDLE_RESET_MS
  const sameDirection = Math.sign(gate.accumulated) === Math.sign(delta)
  const accumulated = (stale || !sameDirection ? 0 : gate.accumulated) + delta
  if (Math.abs(accumulated) < WHEEL_THRESHOLD) {
    return { gate: { ...gate, accumulated, lastAt: input.now }, command: null }
  }
  const down = accumulated > 0
  return {
    gate: { accumulated: 0, lastAt: input.now, lockedUntil: input.now + WHEEL_COOLDOWN_MS },
    command: down !== reversed ? 'next' : 'prev',
  }
}

// スワイプと見なす最小の横移動(CSS px)と、横移動が縦移動の何倍以上あるか。
export const SWIPE_MIN_DISTANCE = 50
export const SWIPE_AXIS_RATIO = 1.5
// これより長く触れていた操作はスワイプと見なさない(ミリ秒)。
export const SWIPE_MAX_DURATION_MS = 800

// タッチの移動量と時間から、次・前(スワイプでなければ null)を返す。紙をめくる向きに合わせ、
// 右綴じは右へ払うと次、左綴じは左へ払うと次。
export function swipeCommand(
  dx: number,
  dy: number,
  durationMs: number,
  binding: Binding,
): 'next' | 'prev' | null {
  if (durationMs > SWIPE_MAX_DURATION_MS) return null
  if (Math.abs(dx) < SWIPE_MIN_DISTANCE || Math.abs(dx) < Math.abs(dy) * SWIPE_AXIS_RATIO) return null
  const towardRight = dx > 0
  return towardRight === (binding === 'right') ? 'next' : 'prev'
}

// 進捗線の上の位置(左端 0〜右端 1)を見開き番号に変える。右綴じの進捗線は右から伸びるので左右を反転する。
export function seekSpreadIndex(ratio: number, spreadCount: number, binding: Binding): number {
  if (spreadCount <= 0) return -1
  const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0
  const progress = binding === 'right' ? 1 - clamped : clamped
  return Math.min(spreadCount - 1, Math.floor(progress * spreadCount))
}
