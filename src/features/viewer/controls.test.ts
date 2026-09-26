import { describe, expect, it } from 'vitest'

import {
  WHEEL_COOLDOWN_MS,
  WHEEL_IDLE_RESET_MS,
  clickCommand,
  initialWheelGate,
  keyCommand,
  seekSpreadIndex,
  swipeCommand,
  wheelStep,
  type KeyInput,
  type WheelGate,
} from './controls'

function key(value: string, modifiers: Partial<KeyInput> = {}): KeyInput {
  return { key: value, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...modifiers }
}

describe('キーの割り当て', () => {
  it('← / → は綴じ方向に追従する(右綴じは ← が次、左綴じは → が次)', () => {
    expect(keyCommand(key('ArrowLeft'), 'right')).toBe('next')
    expect(keyCommand(key('ArrowRight'), 'right')).toBe('prev')
    expect(keyCommand(key('ArrowLeft'), 'left')).toBe('prev')
    expect(keyCommand(key('ArrowRight'), 'left')).toBe('next')
  })

  it.each([
    [key(' '), 'next'],
    [key(' ', { shiftKey: true }), 'prev'],
    [key('PageDown'), 'next'],
    [key('PageUp'), 'prev'],
    [key('Home'), 'first'],
    [key('End'), 'last'],
    [key('t'), 'toggleSpread'],
    [key('T', { shiftKey: true }), 'toggleSpread'],
    [key('b'), 'toggleBinding'],
    [key('q'), 'shift'],
    [key('f'), 'fullscreen'],
    [key('F11'), 'fullscreen'],
    [key('Escape'), 'escape'],
    [key('+'), 'zoomIn'],
    [key('+', { shiftKey: true }), 'zoomIn'],
    [key('='), 'zoomIn'],
    [key('-'), 'zoomOut'],
    [key('0'), 'zoomReset'],
  ] as const)('%o は %s', (input, expected) => {
    // 綴じ方向に依らない割り当ては両方で同じになる。
    expect(keyCommand(input, 'right')).toBe(expected)
    expect(keyCommand(input, 'left')).toBe(expected)
  })

  it('Ctrl・Alt・Meta 付きと割り当ての無いキーは扱わない', () => {
    expect(keyCommand(key('ArrowLeft', { ctrlKey: true }), 'right')).toBeNull()
    expect(keyCommand(key('f', { altKey: true }), 'right')).toBeNull()
    expect(keyCommand(key(' ', { metaKey: true }), 'right')).toBeNull()
    expect(keyCommand(key('x'), 'right')).toBeNull()
    expect(keyCommand(key('Enter'), 'right')).toBeNull()
    // Ctrl++ / Ctrl+- はビューアの拡大に使わない(WebView の拡大と取り合わない)。
    expect(keyCommand(key('+', { ctrlKey: true }), 'right')).toBeNull()
    expect(keyCommand(key('0', { ctrlKey: true }), 'right')).toBeNull()
  })
})

describe('クリックの割り当て', () => {
  it('右綴じは左の領域が次・右の領域が前、中央は UI の表示切り替え', () => {
    expect(clickCommand(100, 1200, 'right')).toBe('next')
    expect(clickCommand(1100, 1200, 'right')).toBe('prev')
    expect(clickCommand(600, 1200, 'right')).toBe('toggleUi')
  })

  it('左綴じは左右が入れ替わる', () => {
    expect(clickCommand(100, 1200, 'left')).toBe('prev')
    expect(clickCommand(1100, 1200, 'left')).toBe('next')
    expect(clickCommand(600, 1200, 'left')).toBe('toggleUi')
  })

  it('拡大中はページ送りの領域が無く、どこをクリックしても UI の表示切り替えになる', () => {
    for (const x of [100, 600, 1100]) {
      expect(clickCommand(x, 1200, 'right', true)).toBe('toggleUi')
      expect(clickCommand(x, 1200, 'left', true)).toBe('toggleUi')
    }
  })

  it('幅が分からないときは UI の表示切り替えだけにする', () => {
    expect(clickCommand(10, 0, 'right')).toBe('toggleUi')
  })
})

describe('ホイール', () => {
  function run(events: { deltaY: number; now: number; deltaMode?: number }[], reversed = false) {
    let gate: WheelGate = initialWheelGate
    const commands: (string | null)[] = []
    for (const event of events) {
      const result = wheelStep(gate, { deltaMode: 0, ...event }, reversed)
      gate = result.gate
      commands.push(result.command)
    }
    return commands
  }

  it('下へ回すと次、上へ回すと前。反転の設定で逆になる', () => {
    expect(run([{ deltaY: 100, now: 0 }])).toEqual(['next'])
    expect(run([{ deltaY: -100, now: 0 }])).toEqual(['prev'])
    expect(run([{ deltaY: 100, now: 0 }], true)).toEqual(['prev'])
    expect(run([{ deltaY: -100, now: 0 }], true)).toEqual(['next'])
  })

  it('1 回送ったあとの連続した入力は間引く', () => {
    expect(
      run([
        { deltaY: 100, now: 0 },
        { deltaY: 100, now: 50 },
        { deltaY: 100, now: WHEEL_COOLDOWN_MS - 1 },
        { deltaY: 100, now: WHEEL_COOLDOWN_MS + 10 },
      ]),
    ).toEqual(['next', null, null, 'next'])
  })

  it('タッチパッドの細かい入力は溜めてから 1 回だけ送る', () => {
    expect(
      run([
        { deltaY: 15, now: 0 },
        { deltaY: 15, now: 16 },
        { deltaY: 15, now: 32 },
      ]),
    ).toEqual([null, null, 'next'])
  })

  it('間の空いた入力や向きの変わった入力は溜めた量を捨てる', () => {
    expect(
      run([
        { deltaY: 30, now: 0 },
        { deltaY: 30, now: WHEEL_IDLE_RESET_MS + 1 },
      ]),
    ).toEqual([null, null])
    expect(
      run([
        { deltaY: 30, now: 0 },
        { deltaY: -30, now: 10 },
      ]),
    ).toEqual([null, null])
  })

  it('行単位の入力も px に換算して数える', () => {
    expect(run([{ deltaY: 3, deltaMode: 1, now: 0 }])).toEqual(['next'])
  })
})

describe('スワイプ', () => {
  it('右綴じは右へ払うと次、左へ払うと前', () => {
    expect(swipeCommand(120, 10, 200, 'right')).toBe('next')
    expect(swipeCommand(-120, 10, 200, 'right')).toBe('prev')
  })

  it('左綴じは左へ払うと次', () => {
    expect(swipeCommand(-120, 10, 200, 'left')).toBe('next')
    expect(swipeCommand(120, 10, 200, 'left')).toBe('prev')
  })

  it('短い移動・縦方向の移動・長く触れていた操作はスワイプにしない', () => {
    expect(swipeCommand(30, 0, 200, 'right')).toBeNull()
    expect(swipeCommand(120, 100, 200, 'right')).toBeNull()
    expect(swipeCommand(120, 0, 2000, 'right')).toBeNull()
  })
})

describe('シーク', () => {
  it('左綴じは左端が先頭、右端が最後', () => {
    expect(seekSpreadIndex(0, 10, 'left')).toBe(0)
    expect(seekSpreadIndex(0.55, 10, 'left')).toBe(5)
    expect(seekSpreadIndex(1, 10, 'left')).toBe(9)
  })

  it('右綴じは右端が先頭、左端が最後', () => {
    expect(seekSpreadIndex(1, 10, 'right')).toBe(0)
    expect(seekSpreadIndex(0, 10, 'right')).toBe(9)
  })

  it('線の外は端に収め、見開きが無ければ -1', () => {
    expect(seekSpreadIndex(-0.5, 10, 'left')).toBe(0)
    expect(seekSpreadIndex(3, 10, 'left')).toBe(9)
    expect(seekSpreadIndex(Number.NaN, 10, 'left')).toBe(0)
    expect(seekSpreadIndex(0.5, 0, 'left')).toBe(-1)
  })
})
