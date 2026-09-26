import { useCallback, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'

import { BookMenu, type MenuAction, type MenuBook, type MenuState } from './book-menu'

// メニューの開閉。`onChanged` は本棚・お気に入りを変えたあとに呼ぶ(一覧の読み直しに使う)。
export function useBookMenu(onChanged?: () => void) {
  const [state, setState] = useState<MenuState | null>(null)

  // 右クリック(またはメニューキー)の位置で開く。キーボードから開いたときは要素の左下に出す。
  const openAtPointer = useCallback((event: ReactMouseEvent<HTMLElement>, book: MenuBook) => {
    event.preventDefault()
    if (event.clientX === 0 && event.clientY === 0) {
      const rect = event.currentTarget.getBoundingClientRect()
      setState({ book, x: rect.left, y: rect.bottom })
      return
    }
    setState({ book, x: event.clientX, y: event.clientY })
  }, [])

  // ボタンの下に開く。`actions` は本棚・お気に入りの上に足す操作。
  const openBelow = useCallback((element: HTMLElement, book: MenuBook, actions?: MenuAction[]) => {
    const rect = element.getBoundingClientRect()
    setState({ book, x: rect.left, y: rect.bottom + 4, anchor: element, actions })
  }, [])

  const close = useCallback(() => setState(null), [])

  const menu = state ? (
    <BookMenu key={`${state.book.path}\n${state.x}\n${state.y}`} {...state} onClose={close} onChanged={onChanged} />
  ) : null

  return { open: state !== null, openAtPointer, openBelow, close, menu }
}
