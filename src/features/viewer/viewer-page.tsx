import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import type {
  ImgHTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { Link, useNavigate, useParams, useRouter, useSearch } from '@tanstack/react-router'
import { ArrowLeft, ImageUpscale, Library } from 'lucide-react'

import { Button, ProgressLine } from '@/design'
import type { MenuAction, MenuBook } from '@/features/library/book-menu'
import { useBookMenu } from '@/features/library/use-book-menu'
import { useSettingsStore } from '@/features/settings/settings-store'
import { getAdjacentBooks, isPdfPath, openBook, pageUrl, pdfPageWidth } from '@/lib/tauri'
import type { AdjacentBook, AdjacentBooks, OpenedBook } from '@/types/app'

import { releaseBooks, startBookRequest } from './book-holds'
import { holdViewerFullscreen, toggleViewerFullscreen } from './fullscreen-session'
import {
  clickCommand,
  initialWheelGate,
  keyCommand,
  swipeCommand,
  wheelPixels,
  wheelStep,
  type ViewerCommand,
} from './controls'
import { batchStatusText, enhanceStatusText, type BatchProgress } from './enhancement'
import { sliderEnds, sliderIndexAt, sliderKeyIndex, sliderRatio } from './page-slider'
import { PagePreloader, acquireImage, releaseImage } from './preload'
import { useEnhancement, type EnhancementView } from './use-enhancement'
import { useBookPersistence } from './use-book-persistence'
import { buildSpreads, pageToSpreadIndex, usesTwoPages, type Binding, type Spread } from './spread'
import {
  UI_EDGE_BAND_PX,
  UI_HIDE_DELAY_MS,
  currentViewSettings,
  fitSpread,
  initialViewerState,
  preloadPages,
  uiHides,
  viewerReducer,
  type FitMode,
  type ViewerAction,
  type SlotBox,
  type ViewerState,
} from './viewer-state'
import {
  ZOOM_KEY_STEP,
  offsetFromScroll,
  panBy,
  scrollFromZoom,
  toggleZoomAt,
  wheelZoomFactor,
  zoomBy,
  type Point,
  type Zoom,
} from './zoom'
import styles from './viewer-page.module.css'

// ビューア画面。本を開き、紙色の地の中央に現在の見開きを出す。情報バーが出ている間は上端に文字のバー、
// 下端中央にページ移動のスライダーを出し、隠れている間は下端に細い進捗線だけを出す。
export function ViewerPage() {
  const { bookId } = useParams({ from: '/viewer/$bookId' })
  const { path, start } = useSearch({ from: '/viewer/$bookId' })
  const source = path ?? bookId
  const fromStart = start === 'first'

  // ビューアを開いている間はウィンドウを全画面にする(設定でオフならウィンドウのまま)。次の巻・前の巻へ
  // 移ってもこの画面は残るので、全画面のまま。閉じる(Esc・戻る・読み終わりの「閉じる」)と、全画面にしたのが
  // ビューアなら元に戻す。
  useEffect(() => holdViewerFullscreen(useSettingsStore.getState().viewerFullscreen), [])

  // 別の本へ移ったら状態を作り直す。
  return <Viewer key={`${source}
${fromStart}`} source={source} fromStart={fromStart} />
}

const fitLabels: Record<FitMode, string> = {
  screen: '画面に合わせる',
  width: '幅に合わせる',
}

function Viewer({ source, fromStart }: { source: string; fromStart: boolean }) {
  const [state, dispatch] = useReducer(viewerReducer, initialViewerState)
  const [stage, setStage] = useState<HTMLDivElement | null>(null)
  const [preloader] = useState(() => new PagePreloader())
  const { load, viewport, ui } = state

  // このビューアが持つ本(開いた本と、表紙のために Rust が開いた前後の巻)。応答を受けた時点で加え、
  // 閉じるときにまとめて手放す。手放した RAR/CBR は一時フォルダが消える。
  const heldBooks = useRef<string[]>([])
  // 閉じるとき(Esc・戻る・別の本へ移る)に持っている本を手放す。解放は最初の描画で登録するので、
  // 応答を受けてから表示に反映するまでの間に閉じても漏れない。
  useEffect(
    () => () => {
      const ids = heldBooks.current
      heldBooks.current = []
      releaseBooks(ids)
    },
    [],
  )

  useEffect(() => {
    let cancelled = false
    // 閉じた後に返った本は、応答の時点で手放す(`book-holds.ts`)。
    const settle = startBookRequest()
    // `openBook` は閉じたばかりの本の保存が終わってから開くので、保存した位置と表示設定を読む。
    openBook(source, { fromStart }).then(
      (book) => {
        settle([book.bookId], !cancelled)
        if (cancelled) return
        heldBooks.current.push(book.bookId)
        const settings = useSettingsStore.getState()
        dispatch({
          type: 'opened',
          book,
          defaults: {
            spreadMode: settings.defaultSpreadMode,
            binding: settings.defaultBinding,
            coverSingle: settings.defaultCoverSingle,
          },
        })
      },
      (error: unknown) => {
        settle([], false)
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error)
          dispatch({ type: 'failed', message })
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [source, fromStart])

  // 表示領域の大きさ。スクロールバーの幅はスタイルの scrollbar-gutter で常に確保している。
  useEffect(() => {
    if (!stage) return
    const observer = new ResizeObserver(() => {
      dispatch({ type: 'resized', width: stage.clientWidth, height: stage.clientHeight })
    })
    observer.observe(stage)
    return () => observer.disconnect()
  }, [stage])

  // 操作が止まったら UI を隠す。
  const hides = uiHides(ui)
  useEffect(() => {
    if (!hides) return
    const timer = window.setTimeout(() => dispatch({ type: 'hideUi' }), UI_HIDE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [hides, ui.activity])

  // ポインタが画面の上端・下端の帯にあるかを見る。帯の外で動かしても UI は出さないが、
  // 出ている間に動かしたら隠すまでの時間を数え直す。
  // タッチは指を置いた所でスワイプするので、帯に入ったと数えない。
  const onViewerPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') return
    const rect = event.currentTarget.getBoundingClientRect()
    const y = event.clientY - rect.top
    const inside = y < UI_EDGE_BAND_PX || y >= rect.height - UI_EDGE_BAND_PX
    if (inside !== ui.edge) dispatch({ type: 'edgeBand', inside })
    else if (hides) dispatch({ type: 'pointerActive' })
  }

  const book = load.status === 'ready' ? load.book : null
  const binding: Binding = load.status === 'ready' ? load.binding : 'right'

  // 同じフォルダで隣り合う本(前の巻・次の巻)。求められなければ無いものとして扱う。
  // 前後の巻は表紙を出すために Rust が開くので、このビューアが持つ本に数える。
  const [adjacent, setAdjacent] = useState<AdjacentBooks | null>(null)
  const openedBookId = book?.bookId
  useEffect(() => {
    if (!openedBookId) return
    let cancelled = false
    const settle = startBookRequest()
    getAdjacentBooks(openedBookId).then(
      (found) => {
        const ids = [found.previous?.bookId, found.next?.bookId].filter((id): id is string => id !== undefined)
        settle(ids, !cancelled)
        if (cancelled) return
        heldBooks.current.push(...ids)
        setAdjacent(found)
      },
      () => settle([], false),
    )
    return () => {
      cancelled = true
    }
  }, [openedBookId])

  // 読書位置と表示設定(見開き・綴じ方向・表紙単独)を本ごとに保存する。
  // 読み終わりの案内まで進んだら最後のページを保存し、読みかけの一覧から外れるようにする。
  const savedPage = book && state.finished ? book.pages.length - 1 : state.page
  useBookPersistence(book?.bookId ?? null, savedPage, currentViewSettings(state))
  const aspect = viewport.height > 0 ? viewport.width / viewport.height : Number.NaN

  const spreads = useMemo(
    () => (book ? buildSpreads(book.pages, { ...state.view, binding, viewportAspect: aspect }) : []),
    [book, state.view, binding, aspect],
  )
  const spreadIndex = pageToSpreadIndex(spreads, state.page)
  const spread = spreadIndex >= 0 && !state.finished ? spreads[spreadIndex] : undefined

  // 合わせ方で決まった見開きの大きさ(拡大率 1)。拡大はこれを基準にする。
  const slots = useMemo(
    () => (book && spread ? fitSpread(spread, book.pages, state.fit, viewport) : []),
    [book, spread, state.fit, viewport],
  )
  const content = useMemo(
    () => ({
      width: slots.reduce((sum, slot) => sum + slot.width, 0),
      height: slots.reduce((max, slot) => Math.max(max, slot.height), 0),
    }),
    [slots],
  )
  const { zoom } = state
  const zoomed = zoom !== null

  // 幅に合わせる表示で拡大を解いたときに戻すスクロール位置。
  const restoreScroll = useRef<number | null>(null)
  const applyZoom = useCallback(
    (next: Zoom | null) => {
      if (!next && zoom && state.fit === 'width') {
        restoreScroll.current = scrollFromZoom(zoom, content.height, viewport.height)
      }
      dispatch({ type: 'setZoom', zoom: next })
    },
    [zoom, state.fit, content.height, viewport.height],
  )
  // 拡大していない状態から拡大を始めるときの見開きのずれ。幅に合わせる表示は今のスクロール位置から求める。
  const zoomBase = useCallback(
    (): Point => ({
      x: 0,
      y: stage && state.fit === 'width' ? offsetFromScroll(stage.scrollTop, content.height, viewport.height) : 0,
    }),
    [stage, state.fit, content.height, viewport.height],
  )
  // 拡大中はスクロールを使わず位置を持つので、拡大の出入りでスクロール位置を付け替える。
  useLayoutEffect(() => {
    if (!stage) return
    if (zoomed) {
      setScrollTop(stage, 0)
    } else if (restoreScroll.current !== null) {
      setScrollTop(stage, restoreScroll.current)
      restoreScroll.current = null
    }
  }, [stage, zoomed])

  // 画面上の位置(clientX / clientY)を、表示領域の中心からの位置に変える。
  const anchorAt = useCallback(
    (clientX: number, clientY: number): Point => {
      if (!stage) return { x: 0, y: 0 }
      const rect = stage.getBoundingClientRect()
      return {
        x: clientX - rect.left - viewport.width / 2,
        y: clientY - rect.top - viewport.height / 2,
      }
    },
    [stage, viewport.width, viewport.height],
  )

  // AI 超解像。表示中の見開きのページと次の数ページを要求し、処理が終わったページから差し替える。
  const visiblePages = useMemo(() => spread?.pages ?? [], [spread])
  // PDF のページは表示領域の幅(装置の画素比を掛けた幅)で画像化させる。ほかの形式は元画像のまま。
  const pdfWidth = isPdfPath(source) ? pdfPageWidth(viewport.width, window.devicePixelRatio) : null
  const enhancement = useEnhancement(book?.bookId ?? null, visiblePages, book?.pages.length ?? 0, pdfWidth)
  const { pageSrc } = enhancement

  // 前後の見開きを先にデコードしておく。
  const preloadUrls = useMemo(
    () => (book && spreadIndex >= 0 ? preloadPages(spreads, spreadIndex).map(pageSrc) : []),
    [book, spreads, spreadIndex, pageSrc],
  )
  useEffect(() => {
    preloader.retain(preloadUrls)
  }, [preloader, preloadUrls])
  useEffect(() => () => preloader.clear(), [preloader])

  const wheelReversed = useSettingsStore((settings) => settings.wheelReversed)
  const navigate = useNavigate()
  const router = useRouter()
  // ビューアを閉じて本を開いた画面(フォルダなど)へ戻る。戻る先が無い(起動直後にビューアから
  // 始まった)ときは読みかけへ。
  const closeViewer = useCallback(() => {
    if (router.history.canGoBack()) {
      router.history.back()
    } else {
      void navigate({ to: '/' })
    }
  }, [router, navigate])
  const twoPages = usesTwoPages(state.view.mode, aspect)

  // キー・クリック・ホイール・スワイプで決まった動作を実行する。
  const runCommand = useCallback(
    (command: ViewerCommand) => {
      switch (command) {
        case 'next':
        case 'prev':
        case 'first':
        case 'last':
          dispatch({ type: command, spreads })
          return
        case 'toggleSpread':
          dispatch({ type: 'toggleSpread', twoPages })
          return
        case 'toggleBinding':
          dispatch({ type: 'toggleBinding' })
          return
        case 'shift':
          dispatch({ type: 'toggleShift' })
          return
        case 'toggleUi':
          dispatch({ type: 'toggleUi' })
          return
        case 'fullscreen':
          toggleViewerFullscreen()
          return
        case 'zoomIn':
        case 'zoomOut':
          applyZoom(
            zoomBy(
              zoom,
              command === 'zoomIn' ? ZOOM_KEY_STEP : 1 / ZOOM_KEY_STEP,
              { x: 0, y: 0 },
              content,
              viewport,
              zoomBase(),
            ),
          )
          return
        case 'zoomReset':
          applyZoom(null)
          return
        case 'escape':
          // 1 回で閉じる。全画面を戻すのは画面を離れたときの後始末(`holdViewerFullscreen`)に任せる。
          closeViewer()
          return
      }
    },
    [spreads, twoPages, closeViewer, applyZoom, zoom, content, viewport, zoomBase],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target, event.key)) return
      const command = keyCommand(event, binding)
      if (!command) return
      event.preventDefault()
      runCommand(command)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [binding, runCommand])

  // ホイール。Ctrl+ホイールは指した点を中心に拡大縮小し、拡大中のホイールは見開きを動かす。
  // それ以外で幅に合わせて縦にスクロールできる間はスクロールに任せ、端に着いてからページを送る。
  const wheelGate = useRef(initialWheelGate)
  useEffect(() => {
    if (!stage) return
    const onWheel = (event: WheelEvent) => {
      const input = { deltaY: event.deltaY, deltaMode: event.deltaMode, now: event.timeStamp }
      if (event.ctrlKey) {
        event.preventDefault()
        if (!book || state.finished || event.deltaY === 0) return
        const anchor = anchorAt(event.clientX, event.clientY)
        applyZoom(zoomBy(zoom, wheelZoomFactor(wheelPixels(input)), anchor, content, viewport, zoomBase()))
        return
      }
      if (zoom) {
        event.preventDefault()
        applyZoom(panBy(zoom, -event.deltaX, -wheelPixels(input), content, viewport))
        return
      }
      if (event.deltaY === 0) return
      if (state.fit === 'width' && canScrollFurther(stage, event.deltaY)) return
      event.preventDefault()
      const result = wheelStep(wheelGate.current, input, wheelReversed)
      wheelGate.current = result.gate
      if (result.command) runCommand(result.command)
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [
    stage,
    book,
    state.fit,
    state.finished,
    wheelReversed,
    runCommand,
    zoom,
    content,
    viewport,
    anchorAt,
    applyZoom,
    zoomBase,
  ])

  // タッチ・ペンのスワイプと、拡大中のドラッグでの移動。払った・動かしたあとに続くクリックは操作に数えない。
  const swipe = useRef<{ id: number; x: number; y: number; at: number } | null>(null)
  const drag = useRef<{ id: number; x: number; y: number; distance: number } | null>(null)
  const swiped = useRef(false)
  const onStagePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    swiped.current = false
    swipe.current = null
    drag.current = null
    if (zoomed) {
      if (event.button !== 0) return
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, distance: 0 }
      return
    }
    if (event.pointerType !== 'mouse') {
      swipe.current = { id: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp }
    }
  }
  const onStagePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.id !== event.pointerId || !zoom) return
    const dx = event.clientX - current.x
    const dy = event.clientY - current.y
    drag.current = {
      id: current.id,
      x: event.clientX,
      y: event.clientY,
      distance: current.distance + Math.hypot(dx, dy),
    }
    applyZoom(panBy(zoom, dx, dy, content, viewport))
  }
  const onStagePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const dragged = drag.current
    drag.current = null
    if (dragged && dragged.id === event.pointerId) {
      if (dragged.distance > DRAG_CLICK_TOLERANCE) swiped.current = true
      return
    }
    const start = swipe.current
    swipe.current = null
    if (!start || start.id !== event.pointerId) return
    const command = swipeCommand(
      event.clientX - start.x,
      event.clientY - start.y,
      event.timeStamp - start.at,
      binding,
    )
    if (command) {
      swiped.current = true
      runCommand(command)
    }
  }
  const onStageClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (swiped.current || !book) return
    const rect = event.currentTarget.getBoundingClientRect()
    runCommand(clickCommand(event.clientX - rect.left, rect.width, binding, zoomed))
  }
  // ダブルクリック。拡大中なら元に戻し、そうでなければ中央の領域(クリックが UI の出し入れになる所)で
  // 指した点を中心に拡大する。左右の領域はクリックを続けてページを送れるよう拡大しない。
  const onStageDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!book || state.finished) return
    if (zoom) {
      applyZoom(null)
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    if (clickCommand(event.clientX - rect.left, rect.width, binding) !== 'toggleUi') return
    applyZoom(toggleZoomAt(null, anchorAt(event.clientX, event.clientY), content, viewport, zoomBase()))
  }

  // 読み終わりの案内は情報バーとは別に出すので、情報バーの表示は UI の状態だけで決める。
  const uiHidden = !ui.visible

  // 前の巻・次の巻を先頭から開く。履歴は置き換え、Esc で本を開いた画面へ 1 回で戻れるようにする。
  const openAdjacent = (target: AdjacentBook) => {
    void navigate({
      to: '/viewer/$bookId',
      params: { bookId: target.bookId },
      search: { path: target.path, start: 'first' },
      replace: true,
    })
  }

  return (
    <div
      className={styles.viewer}
      data-ui={uiHidden ? 'hidden' : 'visible'}
      data-finished={state.finished ? '' : undefined}
      onPointerMove={onViewerPointerMove}
      onPointerLeave={() => dispatch({ type: 'edgeBand', inside: false })}
    >
      <div
        ref={setStage}
        className={styles.stage}
        data-fit={state.fit}
        data-zoomed={zoomed ? '' : undefined}
        aria-label="ページ"
        role="region"
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerUp}
        onPointerCancel={() => {
          drag.current = null
          swipe.current = null
        }}
        onClick={onStageClick}
        onDoubleClick={onStageDoubleClick}
      >
        {book && spread ? <SpreadView pageSrc={pageSrc} slots={slots} zoom={zoom} /> : null}
        {load.status === 'loading' ? <p className={styles.status}>読み込み中…</p> : null}
        {load.status === 'error' ? <p className={styles.status}>{load.message}</p> : null}
      </div>

      {book && state.finished ? (
        <FinishedPanel
          book={book}
          next={adjacent?.next ?? null}
          onOpen={openAdjacent}
          onRestart={() => dispatch({ type: 'first', spreads })}
          onClose={closeViewer}
        />
      ) : null}

      <TopBar
        state={state}
        dispatch={dispatch}
        title={book?.title ?? (load.status === 'error' ? '本を開けませんでした' : '読み込み中')}
        pageLabel={book ? pageLabel(book, spreads[spreadIndex], state.finished) : ''}
        adjacent={adjacent}
        onOpen={openAdjacent}
        menuBook={book ? { path: source, title: book.title } : null}
        enhancement={book ? enhancement : null}
      />

      <div className={styles.bottomBar} data-binding={binding}>
        {book && spreads.length > 0 ? (
          <PageSlider
            book={book}
            spreads={spreads}
            spreadIndex={spreadIndex}
            binding={binding}
            finished={state.finished}
            dispatch={dispatch}
          />
        ) : null}
        {/* 情報バーが隠れている間だけ出す進捗線。表示だけで、ドラッグでは動かさない。 */}
        <ProgressLine
          className={styles.progress}
          label="読書の進み具合"
          value={spreads.length === 0 ? 0 : state.finished ? 1 : (spreadIndex + 1) / spreads.length}
        />
      </div>
    </div>
  )
}

// 下端中央のページ移動スライダー。見開き単位で動き、右綴じは右端が先頭。左右の端に現在のページ
// (見開きなら先のページ)と総ページを出す。つまみのドラッグ中はつまみの上に行き先のページ番号を出し、
// 離した所の見開きへ移る。フォーカス中は ← / → / Home / End で動かせる。
function PageSlider({
  book,
  spreads,
  spreadIndex,
  binding,
  finished,
  dispatch,
}: {
  book: OpenedBook
  spreads: readonly Spread[]
  spreadIndex: number
  binding: Binding
  finished: boolean
  dispatch: (action: ViewerAction) => void
}) {
  // ドラッグ中のつまみの位置(スライダーの左端からの割合)。
  const [drag, setDrag] = useState<{ id: number; ratio: number } | null>(null)
  const total = book.pages.length
  const index = Math.max(0, spreadIndex)
  const current = (spreads[index]?.pages[0] ?? 0) + 1
  const dragIndex = drag ? sliderIndexAt(drag.ratio, spreads.length, binding) : -1
  const ratio = drag ? drag.ratio : sliderRatio(index, spreads.length, binding)
  const ends = sliderEnds(binding, String(current), String(total))

  const ratioAt = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const value = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0
    return Math.min(1, Math.max(0, value))
  }
  const seekTo = (target: number) => {
    const spread = spreads[target]
    if (spread) dispatch({ type: 'seek', page: spread.pages[0] })
  }
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrag({ id: event.pointerId, ratio: ratioAt(event) })
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || drag.id !== event.pointerId) return
    setDrag({ id: drag.id, ratio: ratioAt(event) })
  }
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || drag.id !== event.pointerId) return
    setDrag(null)
    seekTo(sliderIndexAt(ratioAt(event), spreads.length, binding))
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = sliderKeyIndex(event.key, index, spreads.length, binding)
    if (target === null) return
    // ページ送りのキー(ウィンドウで受ける)と二重に動かさない。
    event.preventDefault()
    event.stopPropagation()
    seekTo(target)
  }

  return (
    <div
      className={styles.slider}
      onPointerEnter={() => dispatch({ type: 'holdUi', held: true })}
      onPointerLeave={() => dispatch({ type: 'holdUi', held: false })}
    >
      <span className={styles.sliderEnd}>{ends.left}</span>
      <div
        className={styles.sliderTrack}
        role="slider"
        tabIndex={0}
        aria-label="ページ移動"
        aria-orientation="horizontal"
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={current}
        aria-valuetext={finished ? `読了 / ${total} ページ` : `${current} / ${total} ページ`}
        data-seeking={drag ? '' : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
        onKeyDown={onKeyDown}
      >
        <div className={styles.sliderRail} />
        <div
          className={styles.sliderFill}
          style={binding === 'right' ? { left: `${ratio * 100}%`, right: 0 } : { left: 0, right: `${(1 - ratio) * 100}%` }}
        />
        <div className={styles.sliderThumb} style={{ left: `${ratio * 100}%` }}>
          {drag ? <span className={styles.seekLabel}>{pageLabel(book, spreads[dragIndex], false)}</span> : null}
        </div>
      </div>
      <span className={styles.sliderEnd}>{ends.right}</span>
    </div>
  )
}

// 見開きを出す。拡大中は各ページを拡大率の大きさで描き(画像は原寸から縮小して描かれる)、
// 表示領域の中心からずらして置く。
function SpreadView({
  pageSrc,
  slots,
  zoom,
}: {
  pageSrc: (index: number) => string
  slots: SlotBox[]
  zoom: Zoom | null
}) {
  const scale = zoom?.scale ?? 1
  const style = zoom
    ? { transform: `translate(calc(-50% + ${zoom.x}px), calc(-50% + ${zoom.y}px))` }
    : undefined

  return (
    <div className={styles.spread} data-zoomed={zoom ? '' : undefined} style={style}>
      {slots.map((slot, index) =>
        slot.page === null ? (
          <div
            key={`blank-${index}`}
            className={styles.blank}
            style={{ width: Math.floor(slot.width * scale), height: Math.floor(slot.height * scale) }}
          />
        ) : (
          <PageImage
            key={slot.page}
            className={styles.page}
            src={pageSrc(slot.page)}
            alt={`${slot.page + 1} ページ`}
            width={Math.floor(slot.width * scale)}
            height={Math.floor(slot.height * scale)}
            draggable={false}
            decoding="async"
          />
        ),
      )}
    </div>
  )
}

// ページ画像。`src` が変わったら(超解像結果への差し替え)、新しい画像をデコードし終えてから切り替えるので、
// 差し替えの間も前の画像が出たままになる。新しい画像を読めなければ前の画像のまま。
function PageImage({ src, ...rest }: ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const [shown, setShown] = useState(src)
  useEffect(() => {
    if (src === shown) return
    let cancelled = false
    const image = acquireImage(src)
    const decoded = typeof image.decode === 'function' ? image.decode() : Promise.resolve()
    decoded.then(
      () => {
        if (!cancelled) setShown(src)
      },
      () => undefined,
    )
    return () => {
      cancelled = true
      releaseImage(image)
    }
  }, [src, shown])
  return <img src={shown} {...rest} />
}

// AI ボタンの横に出す処理の状態。エンジンが無ければ設定画面への案内。一括事前処理中はその進み具合も出す。
function EnhanceStatus({ view, batch }: { view: EnhancementView; batch: BatchProgress | null }) {
  switch (view.kind) {
    case 'off':
      return null
    case 'checking':
      return <span className={styles.aiStatus}>AI を準備中…</span>
    case 'unregistered':
      return (
        <span className={styles.aiStatus} role="status">
          AI エンジンが未登録です。
          <Link to="/settings" hash="ai-engines" className={styles.aiLink}>
            設定で登録する
          </Link>
        </span>
      )
    case 'error':
      return (
        <span className={styles.aiStatus} role="status" data-tone="error" title={view.message}>
          AI を使えません: {view.message}
        </span>
      )
    case 'active': {
      const { current, ahead } = enhanceStatusText(view.progress)
      return (
        <span className={styles.aiStatus} role="status">
          <span className={styles.aiCurrent}>{current}</span>
          {batch ? (
            <span className={styles.aiBatch} data-tone={batch.state === 'error' ? 'error' : undefined}>
              {batchStatusText(batch)}
            </span>
          ) : null}
          {ahead ? <span className={styles.aiAhead}>{ahead}</span> : null}
        </span>
      )
    }
  }
}

function TopBar({
  state,
  dispatch,
  title,
  pageLabel,
  adjacent,
  onOpen,
  menuBook,
  enhancement,
}: {
  state: ViewerState
  dispatch: (action: ViewerAction) => void
  title: string
  pageLabel: string
  adjacent: AdjacentBooks | null
  onOpen: (target: AdjacentBook) => void
  // 本棚・お気に入りのメニューで指す本(開いた場所)。本を開くまでは null。
  menuBook: MenuBook | null
  // AI 超解像の ON/OFF と状態、全ページの一括事前処理。本を開くまでは null。
  enhancement: {
    enabled: boolean
    toggle: () => void
    view: EnhancementView
    batch: BatchProgress | null
    canBatch: boolean
    startBatch: () => void
    stopBatch: () => void
  } | null
}) {
  const previous = adjacent?.previous ?? null
  const next = adjacent?.next ?? null
  const menu = useBookMenu()
  const menuOpen = menu.open
  // メニューを開いている間はバーを隠さない。
  useEffect(() => {
    if (menuOpen) dispatch({ type: 'holdUi', held: true })
    return () => {
      if (menuOpen) dispatch({ type: 'holdUi', held: false })
    }
  }, [menuOpen, dispatch])
  return (
    <header
      className={styles.topBar}
      onPointerEnter={() => dispatch({ type: 'holdUi', held: true })}
      onPointerLeave={() => dispatch({ type: 'holdUi', held: false })}
    >
      <Link to="/" className={styles.back} aria-label="戻る" title="戻る">
        <ArrowLeft size={18} aria-hidden="true" />
      </Link>
      <h1 className={styles.title}>{title}</h1>
      <span className={styles.pageNumber}>{pageLabel}</span>
      {enhancement ? <EnhanceStatus view={enhancement.view} batch={enhancement.batch} /> : null}
      <div className={styles.volumeGroup} role="group" aria-label="巻の移動">
        <Button
          size="sm"
          variant="ghost"
          disabled={!previous}
          title={previous ? `前の巻: ${previous.title}` : '前の巻はありません'}
          onClick={() => previous && onOpen(previous)}
        >
          前の巻
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!next}
          title={next ? `次の巻: ${next.title}` : '次の巻はありません'}
          onClick={() => next && onOpen(next)}
        >
          次の巻
        </Button>
      </div>
      <Button
        size="sm"
        variant={state.view.coverSingle ? 'secondary' : 'ghost'}
        aria-pressed={state.view.coverSingle}
        title="1 ページ目を単独で表示する"
        onClick={() => dispatch({ type: 'toggleCoverSingle' })}
      >
        表紙単独
      </Button>
      <div className={styles.fitGroup} role="group" aria-label="合わせ方">
        {(Object.keys(fitLabels) as FitMode[]).map((fit) => (
          <Button
            key={fit}
            size="sm"
            variant={state.fit === fit ? 'secondary' : 'ghost'}
            aria-pressed={state.fit === fit}
            onClick={() => dispatch({ type: 'setFit', fit })}
          >
            {fitLabels[fit]}
          </Button>
        ))}
      </div>
      <Button
        size="sm"
        // オンは朱の地(primary)で、オフは他の切り替えと同じ控えめな見た目で示す。
        variant={enhancement?.enabled ? 'primary' : 'ghost'}
        disabled={!enhancement}
        aria-pressed={enhancement?.enabled ?? false}
        title={enhancement?.enabled ? 'AI 超解像をオフにする' : 'この本を AI 超解像で高解像度にして表示する'}
        onClick={() => enhancement?.toggle()}
      >
        <ImageUpscale size={14} aria-hidden="true" />
        {enhancement?.enabled ? 'AI オン' : 'AI オフ'}
      </Button>
      <Button
        size="sm"
        variant={menu.open ? 'secondary' : 'ghost'}
        disabled={!menuBook}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        title="本棚・お気に入り・全ページの事前処理"
        onClick={(event) => {
          if (!menuBook) return
          if (menu.open) menu.close()
          else menu.openBelow(event.currentTarget, menuBook, enhancement ? batchActions(enhancement) : undefined)
        }}
      >
        <Library size={14} aria-hidden="true" />
        本棚
      </Button>
      {menu.menu}
    </header>
  )
}

// 本のメニューに足す一括事前処理の項目。処理中は中止、中止した後は再開(処理済みは飛ばす)。
function batchActions(enhancement: {
  batch: BatchProgress | null
  canBatch: boolean
  startBatch: () => void
  stopBatch: () => void
}): MenuAction[] {
  const { batch } = enhancement
  if (batch?.state === 'running' || batch?.state === 'starting') {
    return [{ label: '全ページの事前処理を中止', onSelect: enhancement.stopBatch, disabled: batch.state === 'starting' }]
  }
  return [
    {
      label: batch?.state === 'stopped' ? '全ページの事前処理を再開' : '全ページを事前処理',
      onSelect: enhancement.startBatch,
      disabled: !enhancement.canBatch,
      note: enhancement.canBatch ? undefined : 'AI をオンにすると使えます。',
    },
  ]
}

// 最後の見開きの次に出す読み終わりの案内。次の巻(あるときだけ)・この本の最初から・閉じる(Esc と同じ)を選べる。
function FinishedPanel({
  book,
  next,
  onOpen,
  onRestart,
  onClose,
}: {
  book: OpenedBook
  next: AdjacentBook | null
  onOpen: (target: AdjacentBook) => void
  onRestart: () => void
  onClose: () => void
}) {
  return (
    <section className={styles.finished} aria-labelledby="viewer-finished-heading">
      <div className={styles.finishedCard}>
        <h2 id="viewer-finished-heading" className={styles.finishedHeading}>
          読み終わりました
        </h2>
        <p className={styles.finishedTitle}>{book.title}</p>
        {next ? (
          <button type="button" className={styles.nextVolume} data-available="" onClick={() => onOpen(next)}>
            <img className={styles.nextCover} src={pageUrl(next.bookId, 0)} alt="" draggable={false} />
            <span className={styles.nextText}>
              <span className={styles.nextLabel}>次の巻を読む</span>
              <span className={styles.nextBookTitle}>{next.title}</span>
            </span>
          </button>
        ) : (
          <p className={styles.nextNote}>次の巻はありません</p>
        )}
        <div className={styles.finishedActions}>
          <Button onClick={onRestart}>最初から読む</Button>
          <Button variant="ghost" onClick={onClose}>
            閉じる
          </Button>
        </div>
      </div>
    </section>
  )
}

// 表示中のページ番号(1 始まり)と総ページ数。
function pageLabel(book: OpenedBook, spread: Spread | undefined, finished: boolean) {
  const total = book.pages.length
  if (finished) return `読了 / ${total}`
  if (!spread) return ''
  const first = Math.min(...spread.pages) + 1
  const last = Math.max(...spread.pages) + 1
  return first === last ? `${first} / ${total}` : `${first}–${last} / ${total}`
}

// 文字入力中や、ボタン・リンクの上の Space・Enter は、その部品の操作に任せる。
function isTypingTarget(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target.closest('input, textarea, select')) return true
  return (key === ' ' || key === 'Enter') && target.closest('button, a') !== null
}

// 押してから離すまでにこれより長く動かしたら、拡大中のドラッグと見なしてクリックに数えない(CSS px)。
const DRAG_CLICK_TOLERANCE = 4

function setScrollTop(element: HTMLElement, top: number) {
  element.scrollTop = top
}

// 表示領域を、ホイールの向きにまだスクロールできるか。
function canScrollFurther(element: HTMLElement, deltaY: number): boolean {
  if (deltaY > 0) return element.scrollTop + element.clientHeight < element.scrollHeight - 1
  return element.scrollTop > 0
}
