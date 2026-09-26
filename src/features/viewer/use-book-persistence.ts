import { useCallback, useEffect, useRef } from 'react'

import { enqueueSave } from '@/lib/save-queue'
import { saveReadingPosition, saveViewSettings } from '@/lib/tauri'
import type { ViewSettings } from '@/types/app'

// 読書位置を保存する間隔の下限。ページを続けて送る間は、この間隔ごとに最新の位置だけを保存する。
export const POSITION_SAVE_INTERVAL_MS = 800

// 開いている本の読書位置と表示設定を保存する。本を開いた直後の値(復元した値)は保存せず、
// 変わったときだけ保存する。読書位置は間引き、ビューアを閉じるときに残りを書き出す。
// `bookId` と `view` は本を開くまで null。
export function useBookPersistence(bookId: string | null, page: number, view: ViewSettings | null) {
  const pending = useRef<{ bookId: string; page: number; timer: number } | null>(null)
  const lastPage = useRef<{ bookId: string; page: number } | null>(null)
  const lastView = useRef<{ bookId: string; key: string } | null>(null)

  const flush = useCallback(() => {
    const current = pending.current
    if (!current) return
    window.clearTimeout(current.timer)
    pending.current = null
    enqueueSave(() => saveReadingPosition(current.bookId, current.page))
  }, [])

  useEffect(() => {
    if (!bookId) return
    const last = lastPage.current
    lastPage.current = { bookId, page }
    if (!last || last.bookId !== bookId || last.page === page) return
    if (pending.current && pending.current.bookId === bookId) {
      // 待っている保存の時刻は動かさず、保存する位置だけを最新にする。
      pending.current.page = page
      return
    }
    flush()
    const timer = window.setTimeout(flush, POSITION_SAVE_INTERVAL_MS)
    pending.current = { bookId, page, timer }
  }, [bookId, page, flush])

  const spreadMode = view?.spreadMode
  const binding = view?.binding
  const coverSingle = view?.coverSingle
  useEffect(() => {
    if (!bookId || spreadMode === undefined || binding === undefined || coverSingle === undefined) {
      return
    }
    const settings: ViewSettings = { spreadMode, binding, coverSingle }
    const key = JSON.stringify(settings)
    const last = lastView.current
    lastView.current = { bookId, key }
    if (!last || last.bookId !== bookId || last.key === key) return
    enqueueSave(() => saveViewSettings(bookId, settings))
  }, [bookId, spreadMode, binding, coverSingle])

  // ビューアを閉じるとき・ウィンドウを閉じるときに、待っている位置を書き出す。
  useEffect(() => {
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [flush])
}
