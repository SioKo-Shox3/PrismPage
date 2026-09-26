import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useSettingsStore } from '@/features/settings/settings-store'
import {
  cancelBatchEnhancement,
  cancelEnhancement,
  enhancedPageUrl,
  getEngineStatuses,
  listenEnhanceStatus,
  pageUrl,
  requestEnhancement,
  startBatchEnhancement,
} from '@/lib/tauri'
import type { EnhanceSettings } from '@/types/app'

import { useEnhancedBooksStore } from './enhance-store'
import { prefetchPages, resolveEnhanceSettings, type BatchProgress, type EnhanceProgress } from './enhancement'

// ビューアの AI 超解像の状態。
export type EnhancementView =
  | { kind: 'off' }
  // 使えるエンジンを確かめている。
  | { kind: 'checking' }
  // 使えるエンジンが無い(設定画面への案内を出す)。
  | { kind: 'unregistered' }
  | { kind: 'error'; message: string }
  | { kind: 'active'; progress: EnhanceProgress }

type EngineCheck =
  | { kind: 'ready'; settings: EnhanceSettings }
  | { kind: 'unregistered' }
  | { kind: 'error'; message: string }

// 一括事前処理の要求の状態。`key` は処理結果の版、`total` は全ページ数。進み具合は `done`・`failed` から数える。
type BatchRun =
  | { kind: 'starting' }
  | { kind: 'running' | 'stopped'; key: string; total: number }
  | { kind: 'error'; message: string }

// 本の AI 超解像の ON/OFF(本ごとに覚える)と、ON のときの要求・差し替え。
// ON の間は表示中のページ(`visible`)と次の数ページを要求し直し、処理が終わったページの URL を
// `pageSrc` が超解像結果へ切り替える。OFF にしたとき・本を閉じたときは本のジョブを取り消す。
// ON の間は全ページの一括事前処理(`startBatch`)を裏で進められる。表示中のページは Rust 側で常に先に処理され、
// 中止(`stopBatch`)した後にもう一度始めると処理済みのページは飛ばす。
// `pageWidth` を渡すと、元画像はその幅で要求する(PDF のページを表示幅に合わせて画像化させる)。
export function useEnhancement(
  bookId: string | null,
  visible: readonly number[],
  pageCount: number,
  pageWidth: number | null = null,
) {
  const enabled = useEnhancedBooksStore((state) => bookId !== null && state.bookIds.includes(bookId))
  const setBookEnhanced = useEnhancedBooksStore((state) => state.setBookEnhanced)
  const preferred = useSettingsStore((state) => state.preferredEngine)
  const models = useSettingsStore((state) => state.enhanceModels)
  const preferredScale = useSettingsStore((state) => state.enhanceScale)
  const prefetchCount = useSettingsStore((state) => state.enhancePrefetchPages)

  // エンジンの確認は ON にするたびにやり直す(その間に登録されたエンジンを拾う)。
  const [checkRun, setCheckRun] = useState(0)
  const checkToken = `${preferred}\n${checkRun}`
  const [check, setCheck] = useState<{ token: string; result: EngineCheck } | null>(null)
  const engine = check?.token === checkToken ? check.result : null

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    getEngineStatuses().then(
      (statuses) => {
        if (cancelled) return
        const settings = resolveEnhanceSettings(statuses, {
          engine: preferred,
          models,
          scale: preferredScale,
        })
        setCheck({
          token: checkToken,
          result: settings ? { kind: 'ready', settings } : { kind: 'unregistered' },
        })
      },
      (error: unknown) => {
        if (!cancelled) setCheck({ token: checkToken, result: { kind: 'error', message: messageOf(error) } })
      },
    )
    return () => {
      cancelled = true
    }
  }, [enabled, preferred, models, preferredScale, checkToken])

  // 処理が終わったページ(`<key>/<index>`)と、その完了の通し番号、失敗したページの理由。
  // 通し番号は URL に載せ、キャッシュが消えて作り直したページを読み直させる。
  const [done, setDone] = useState<ReadonlyMap<string, number>>(() => new Map())
  const doneSerial = useRef(0)
  const [failed, setFailed] = useState<ReadonlyMap<string, string>>(() => new Map())

  // 状態のイベントを受ける。受け始めてから要求するので、要求の直後に終わったページも取りこぼさない。
  // 受け始められなかったときは完了を知る手段が無いので、要求せずにエラーを出す。
  const [listening, setListening] = useState<boolean | { error: string }>(false)
  useEffect(() => {
    if (!enabled || !bookId) return
    let disposed = false
    let unlisten: (() => void) | null = null
    listenEnhanceStatus((event) => {
      if (event.bookId !== bookId) return
      const id = `${event.key}/${event.index}`
      if (event.state === 'done') {
        doneSerial.current += 1
        const serial = doneSerial.current
        setDone((current) => new Map(current).set(id, serial))
      } else if (event.state === 'queued' || event.state === 'running') {
        // キャッシュから消えて処理し直すページ。終わるまで元画像に戻す。
        setDone((current) => withoutKey(current, id))
      }
      if (event.state === 'failed') {
        setFailed((current) => new Map(current).set(id, event.message ?? '処理に失敗しました。'))
      } else {
        setFailed((current) => withoutKey(current, id))
      }
    }).then(
      (stop) => {
        if (disposed) {
          stop()
          return
        }
        unlisten = stop
        setListening(true)
      },
      (error: unknown) => {
        if (!disposed) setListening({ error: `処理状況を受け取れません: ${messageOf(error)}` })
      },
    )
    return () => {
      disposed = true
      unlisten?.()
      setListening(false)
    }
  }, [enabled, bookId])

  // 一括事前処理。OFF にしたとき・本を閉じたときは、本のジョブと一緒に取り消されるので忘れる。
  const [batchRun, setBatchRun] = useState<BatchRun | null>(null)
  const batchToken = useRef(0)

  // OFF にしたとき・本を閉じたときは、本のジョブを取り消して実行中のエンジンを終わらせる。
  useEffect(() => {
    if (!enabled || !bookId) return
    return () => {
      batchToken.current += 1
      setBatchRun(null)
      void cancelEnhancement(bookId).catch(() => undefined)
    }
  }, [enabled, bookId])

  // 表示中と先読みのページを要求する。表示が変わるたびに要求し直し、外れたページは Rust 側が取り消す。
  const visibleKey = visible.join(',')
  const settings = engine?.kind === 'ready' ? engine.settings : null
  const [request, setRequest] = useState<{ key: string } | { error: string } | null>(null)
  useEffect(() => {
    if (!enabled || !bookId || !settings || listening !== true || visibleKey === '') return
    const pages = visibleKey.split(',').map(Number)
    const prefetch = prefetchPages(pages, pageCount, prefetchCount)
    // 要求より後に届いた完了は、要求の結果より新しいので残す。
    const serialAtRequest = doneSerial.current
    let cancelled = false
    requestEnhancement(bookId, pages, prefetch, settings).then(
      (result) => {
        if (cancelled) return
        setRequest({ key: result.key })
        const ready = new Set(result.ready)
        setDone((current) => {
          const next = new Map(current)
          for (const index of [...pages, ...prefetch]) {
            const id = `${result.key}/${index}`
            const serial = next.get(id)
            if (ready.has(index)) {
              if (serial === undefined) {
                doneSerial.current += 1
                next.set(id, doneSerial.current)
              }
            } else if (serial !== undefined && serial <= serialAtRequest) {
              // 処理済みだったが、キャッシュの整理で消えて処理し直すページ。
              next.delete(id)
            }
          }
          return sameEntries(current, next) ? current : next
        })
      },
      (error: unknown) => {
        if (!cancelled) setRequest({ error: messageOf(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [enabled, bookId, settings, listening, visibleKey, pageCount, prefetchCount])

  const key = request && 'key' in request ? request.key : null

  // 全ページの一括事前処理を始める(中止の後なら続きから)。処理済みで返ったページは差し替えに使う。
  const startBatch = useCallback(() => {
    if (!enabled || !bookId || !settings || listening !== true) return
    batchToken.current += 1
    const token = batchToken.current
    setBatchRun({ kind: 'starting' })
    startBatchEnhancement(bookId, settings).then(
      (result) => {
        if (batchToken.current !== token) return
        setDone((current) => {
          const next = new Map(current)
          for (const index of result.ready) {
            const id = `${result.key}/${index}`
            if (!next.has(id)) {
              doneSerial.current += 1
              next.set(id, doneSerial.current)
            }
          }
          return sameEntries(current, next) ? current : next
        })
        setBatchRun({ kind: 'running', key: result.key, total: result.total })
      },
      (error: unknown) => {
        if (batchToken.current === token) setBatchRun({ kind: 'error', message: messageOf(error) })
      },
    )
  }, [enabled, bookId, settings, listening])

  // 一括事前処理を中止する。表示中・先読みのページの処理は続ける。
  const stopBatch = useCallback(() => {
    if (!bookId || batchRun?.kind !== 'running') return
    batchToken.current += 1
    setBatchRun({ ...batchRun, kind: 'stopped' })
    void cancelBatchEnhancement(bookId).catch(() => undefined)
  }, [bookId, batchRun])

  const batch = useMemo((): BatchProgress | null => {
    if (!batchRun) return null
    if (batchRun.kind === 'starting') return { state: 'starting' }
    if (batchRun.kind === 'error') return { state: 'error', message: batchRun.message }
    const inBatch = (map: ReadonlyMap<string, unknown>) => {
      let count = 0
      for (let index = 0; index < batchRun.total; index += 1) {
        if (map.has(`${batchRun.key}/${index}`)) count += 1
      }
      return count
    }
    const doneCount = inBatch(done)
    const failedCount = inBatch(failed)
    const finished = doneCount + failedCount >= batchRun.total
    return {
      state: finished ? 'finished' : batchRun.kind,
      done: doneCount,
      failed: failedCount,
      total: batchRun.total,
    }
  }, [batchRun, done, failed])

  const view = useMemo((): EnhancementView => {
    if (!enabled) return { kind: 'off' }
    if (!engine) return { kind: 'checking' }
    if (engine.kind !== 'ready') return engine
    if (typeof listening === 'object') return { kind: 'error', message: listening.error }
    if (request && 'error' in request) return { kind: 'error', message: request.error }
    const ahead = prefetchPages(visible, pageCount, prefetchCount)
    const isDone = (index: number) => key !== null && done.has(`${key}/${index}`)
    return {
      kind: 'active',
      progress: {
        scale: engine.settings.scale,
        visibleTotal: visible.length,
        visibleDone: visible.filter(isDone).length,
        visibleFailed: key === null ? 0 : visible.filter((index) => failed.has(`${key}/${index}`)).length,
        prefetchTotal: ahead.length,
        prefetchDone: ahead.filter(isDone).length,
      },
    }
  }, [enabled, engine, listening, request, key, visible, pageCount, prefetchCount, done, failed])

  // ページ画像の URL。ON で処理が終わったページは超解像結果、それ以外は元画像。
  const pageSrc = useCallback(
    (index: number) => {
      if (!bookId) return ''
      if (enabled && key !== null) {
        const serial = done.get(`${key}/${index}`)
        if (serial !== undefined) return enhancedPageUrl(bookId, index, key, serial)
      }
      return pageUrl(bookId, index, pageWidth ?? undefined)
    },
    [bookId, enabled, key, done, pageWidth],
  )

  const toggle = useCallback(() => {
    if (!bookId) return
    if (!enabled) {
      setCheckRun((run) => run + 1)
      setRequest(null)
    }
    setBookEnhanced(bookId, !enabled)
  }, [bookId, enabled, setBookEnhanced])

  // 一括事前処理を始められるか(AI が ON でエンジンが決まり、状態の知らせを受けているとき)。
  const canBatch = enabled && settings !== null && listening === true

  return { enabled, toggle, view, pageSrc, batch, canBatch, startBatch, stopBatch }
}

function sameEntries<V>(a: ReadonlyMap<string, V>, b: ReadonlyMap<string, V>) {
  if (a.size !== b.size) return false
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false
  }
  return true
}

function withoutKey<V>(map: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> {
  if (!map.has(key)) return map
  const next = new Map(map)
  next.delete(key)
  return next
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
