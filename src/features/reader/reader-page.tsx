import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import ePub, { type EpubLocation, type EpubNavigationItem, type EpubRendition } from 'epubjs'
import {
  ArrowLeft,
  ArrowRight,
  BookOpenText,
  ImageUpscale,
  ListTree,
  LoaderCircle,
  ScanSearch,
} from 'lucide-react'

import { useLibraryStore } from '@/features/library/book-store'
import { useSettingsStore } from '@/features/settings/settings-store'
import { base64ToArrayBuffer, flattenNavigation } from '@/lib/epub'
import { getEngineLabel } from '@/lib/engines'
import { enhanceImage, getEngineStatuses, readBookBase64 } from '@/lib/tauri'
import type { EngineStatus } from '@/types/app'

interface ZoomedImageState {
  originalDataUrl: string
  enhancedDataUrl?: string
  caption: string
}

export function ReaderPage() {
  const { bookId } = useParams({ from: '/reader/$bookId' })
  const containerRef = useRef<HTMLDivElement | null>(null)
  const renditionRef = useRef<EpubRendition | null>(null)
  const bookRef = useRef<ReturnType<typeof ePub> | null>(null)
  const mountedRef = useRef(false)
  const book = useLibraryStore((state) => state.books.find((entry) => entry.id === bookId))
  const patchBook = useLibraryStore((state) => state.patchBook)
  const {
    autoEnhanceZoomedImage,
    enhancementEnabled,
    fontScale,
    lineHeight,
    preferredEngine,
    zoomEnhancementScale,
  } = useSettingsStore()

  const [toc, setToc] = useState<Array<{ href: string; label: string }>>([])
  const [location, setLocation] = useState(book?.currentLocation)
  const [progress, setProgress] = useState(Math.round(book?.progressPercentage ?? 0))
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [engineStatuses, setEngineStatuses] = useState<EngineStatus[]>([])
  const [zoomedImage, setZoomedImage] = useState<ZoomedImageState | null>(null)
  const [isEnhancing, setIsEnhancing] = useState(false)
  const [readerReady, setReaderReady] = useState(false)
  const initialLocationRef = useRef<string | undefined>(book?.currentLocation)
  const currentBookId = book?.id

  const currentEngineStatus = useMemo(
    () => engineStatuses.find((status) => status.id === preferredEngine),
    [engineStatuses, preferredEngine],
  )

  const applyReaderTheme = useCallback(() => {
    const rendition = renditionRef.current
    if (!rendition) {
      return
    }

    rendition.themes.default({
      body: {
        'font-size': `${fontScale}%`,
        'line-height': String(lineHeight),
      },
      img: {
        'border-radius': '14px',
        'box-shadow': '0 12px 40px rgba(15, 23, 42, 0.22)',
        cursor: 'zoom-in',
        margin: '0 auto',
      },
    })
  }, [fontScale, lineHeight])

  useEffect(() => {
    void getEngineStatuses()
      .then(setEngineStatuses)
      .catch((statusError) =>
        setError(
          statusError instanceof Error
            ? statusError.message
            : 'AI エンジン状態の取得に失敗しました。',
        ),
      )
  }, [])

  useEffect(() => {
    if (!currentBookId || !containerRef.current) {
      return
    }

    let relocationHandler: ((locationInfo: EpubLocation) => void) | null = null
    let renderedHandler:
      | ((_section: unknown, contents: { document: Document }) => void)
      | null = null

    mountedRef.current = true

    const loadReader = async () => {
      try {
        setLoading(true)
        setError(null)

        const base64 = await readBookBase64(currentBookId)
        const epubBook = ePub(base64ToArrayBuffer(base64))
        bookRef.current = epubBook

        await epubBook.ready

        const navigation = await epubBook.loaded.navigation
        setToc(flattenNavigation(navigation.toc as EpubNavigationItem[]))

        const rendition = epubBook.renderTo(containerRef.current!, {
          flow: 'paginated',
          height: '100%',
          width: '100%',
        })

        renditionRef.current = rendition
        setReaderReady(true)
        applyReaderTheme()

        relocationHandler = (locationInfo) => {
          const nextLocation = locationInfo.start.cfi
          const nextProgress = Math.round((locationInfo.percentage ?? 0) * 100)

          setLocation(nextLocation)
          setProgress(nextProgress)

          patchBook(currentBookId, {
            currentLocation: nextLocation,
            lastOpenedAt: Date.now(),
            progressPercentage: nextProgress,
          })
        }

        renderedHandler = (_section, contents) => {
          Array.from(contents.document.querySelectorAll('img')).forEach((image) => {
            image.addEventListener('click', async () => {
              try {
                const response = await fetch((image as HTMLImageElement).src)
                const blob = await response.blob()
                const dataUrl = await new Promise<string>((resolve, reject) => {
                  const reader = new FileReader()
                  reader.onloadend = () => resolve(reader.result as string)
                  reader.onerror = () => reject(new Error('画像の取得に失敗しました。'))
                  reader.readAsDataURL(blob)
                })

                setZoomedImage({
                  caption: (image as HTMLImageElement).alt || 'EPUB image',
                  originalDataUrl: dataUrl,
                })
              } catch {
                setError('拡大画像の読み込みに失敗しました。')
              }
            })
          })
        }

        rendition.on('relocated', relocationHandler)
        rendition.on('rendered', renderedHandler)
        await rendition.display(initialLocationRef.current)
      } catch (readerError) {
        setError(
          readerError instanceof Error
            ? readerError.message
            : 'EPUB の読み込みに失敗しました。',
        )
      } finally {
        if (mountedRef.current) {
          setLoading(false)
        }
      }
    }

    void loadReader()

    return () => {
      mountedRef.current = false
      if (relocationHandler && renditionRef.current) {
        renditionRef.current.off('relocated', relocationHandler as (...args: never[]) => void)
      }
      if (renderedHandler && renditionRef.current) {
        renditionRef.current.off('rendered', renderedHandler as (...args: never[]) => void)
      }
      renditionRef.current?.destroy()
      bookRef.current?.destroy()
      renditionRef.current = null
      bookRef.current = null
      setReaderReady(false)
    }
  }, [applyReaderTheme, currentBookId, patchBook])

  useEffect(() => {
    applyReaderTheme()
  }, [applyReaderTheme])

  const handleEnhanceImage = useCallback(async () => {
    if (!zoomedImage || !enhancementEnabled) {
      return
    }

    if (!currentEngineStatus?.ready) {
      setError('選択中の AI エンジンがまだ利用可能ではありません。設定画面から登録してください。')
      return
    }

    try {
      setIsEnhancing(true)
      setError(null)
      const requestImageDataUrl = zoomedImage.originalDataUrl
      const response = await enhanceImage({
        engineId: preferredEngine,
        imageDataUrl: requestImageDataUrl,
        scale: zoomEnhancementScale,
      })

      setZoomedImage((current) =>
        current && current.originalDataUrl === requestImageDataUrl
          ? {
              ...current,
              enhancedDataUrl: response.imageDataUrl,
            }
          : current,
      )
    } catch (enhanceError) {
      setError(
        enhanceError instanceof Error
          ? enhanceError.message
          : 'AI 高精細化に失敗しました。',
      )
    } finally {
      setIsEnhancing(false)
    }
  }, [
    currentEngineStatus?.ready,
    enhancementEnabled,
    preferredEngine,
    zoomEnhancementScale,
    zoomedImage,
  ])

  useEffect(() => {
    if (!zoomedImage || !autoEnhanceZoomedImage || !enhancementEnabled || !currentEngineStatus?.ready) {
      return
    }

    if (zoomedImage.enhancedDataUrl) {
      return
    }

    const timerId = window.setTimeout(() => {
      void handleEnhanceImage()
    }, 0)

    return () => {
      window.clearTimeout(timerId)
    }
  }, [
    autoEnhanceZoomedImage,
    currentEngineStatus?.ready,
    enhancementEnabled,
    handleEnhanceImage,
    zoomedImage,
  ])

  const toolbarDisabled = !readerReady || loading

  if (!book) {
    return (
      <div className="page">
        <div className="empty-state">
          <BookOpenText size={42} />
          <h3>書籍が見つかりません</h3>
          <p>ライブラリから読みたい EPUB を取り込み直してください。</p>
          <Link to="/" className="button">
            ライブラリへ戻る
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <span className="eyebrow">Reader</span>
          <h1>{book.title}</h1>
          <p>{book.author ?? '著者情報なし'}</p>
        </div>

        <div className="button-group">
          <Link to="/" className="ghost-button">
            ライブラリへ戻る
          </Link>
          <Link to="/settings" className="ghost-button">
            AI 設定
          </Link>
        </div>
      </header>

      {error ? <div className="message-strip is-error">{error}</div> : null}

      <div className="reader-layout">
        <aside className="reader-sidebar">
          <div className="reader-meta">
            <span className="eyebrow">Progress</span>
            <h1>{progress}%</h1>
            <p>位置 {location ? '保存済み' : '先頭から開始'}</p>
          </div>

          <section className="reader-sidebar-section">
            <div className="section-header">
              <ImageUpscale size={18} />
              <div>
                <h2>AI 状態</h2>
                <p>画像をクリックすると拡大モーダルから高精細化を実行できます。</p>
              </div>
            </div>
            <div className="book-meta">
              <span
                className={`status-chip ${
                  currentEngineStatus?.ready ? 'is-ready' : 'is-warning'
                }`}
              >
                {currentEngineStatus?.ready ? '利用可能' : '準備が必要'}
              </span>
              <span className="chip">{getEngineLabel(preferredEngine)}</span>
            </div>
          </section>

          <section className="reader-sidebar-section">
            <div className="section-header">
              <ListTree size={18} />
              <div>
                <h2>目次</h2>
                <p>EPUB のナビゲーションから章移動できます。</p>
              </div>
            </div>

            {toc.length === 0 ? (
              <div className="message-strip">目次の読み込み中です。</div>
            ) : (
              <ul className="toc-list">
                {toc.map((item) => (
                  <li key={`${item.href}-${item.label}`}>
                    <button
                      type="button"
                      className="toc-button"
                      onClick={() => void renditionRef.current?.display(item.href)}
                    >
                      {item.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>

        <section className="reader-canvas">
          <div className="reader-toolbar">
            <div className="toolbar-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => void renditionRef.current?.prev()}
                disabled={toolbarDisabled}
              >
                <ArrowLeft size={18} />
                前へ
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => void renditionRef.current?.next()}
                disabled={toolbarDisabled}
              >
                次へ
                <ArrowRight size={18} />
              </button>
            </div>

            <div className="toolbar-actions">
              <span className="chip">文字サイズ {fontScale}%</span>
              <span className="chip">行間 {lineHeight.toFixed(1)}</span>
              <span className="chip">AI x{zoomEnhancementScale}</span>
            </div>
          </div>

          <div className="reader-stage">
            {loading ? (
              <div className="empty-state">
                <LoaderCircle size={42} className="animate-spin" />
                <h3>EPUB を読み込んでいます</h3>
              </div>
            ) : null}
            <div ref={containerRef} className="epub-container" />
          </div>

          <div className="message-strip">
            EPUB 内の画像をクリックすると、拡大モーダルを開いて AI 超解像を実行できます。
          </div>
        </section>
      </div>

      {zoomedImage ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setZoomedImage(null)}>
          <section
            className="image-modal-card"
            role="dialog"
            aria-modal="true"
            aria-label="画像拡大プレビュー"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="image-modal-grid">
              <div className="image-preview-wrap">
                <img
                  src={zoomedImage.enhancedDataUrl ?? zoomedImage.originalDataUrl}
                  alt={zoomedImage.caption}
                />
              </div>

              <div className="field-stack">
                <div className="section-header">
                  <ScanSearch size={18} />
                  <div>
                    <h2>画像拡大と高精細化</h2>
                    <p>{zoomedImage.caption}</p>
                  </div>
                </div>

                <div className="book-meta">
                  <span className="chip">
                    表示中 {zoomedImage.enhancedDataUrl ? 'AI 強調後' : '元画像'}
                  </span>
                  <span className="chip">エンジン {getEngineLabel(preferredEngine)}</span>
                </div>

                {!currentEngineStatus?.ready ? (
                  <div className="message-strip is-error">
                    AI エンジンがまだ利用可能ではありません。設定画面から PC 上の既存エンジン
                    フォルダを登録してください。
                  </div>
                ) : null}

                <div className="modal-actions">
                  <button
                    type="button"
                    className="button"
                    onClick={() => void handleEnhanceImage()}
                    disabled={
                      isEnhancing ||
                      !enhancementEnabled ||
                      !currentEngineStatus?.ready ||
                      Boolean(zoomedImage.enhancedDataUrl)
                    }
                  >
                    {isEnhancing ? (
                      <>
                        <LoaderCircle size={18} className="animate-spin" />
                        AI 処理中...
                      </>
                    ) : (
                      <>
                        <ImageUpscale size={18} />
                        AI 高精細化を実行
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() =>
                      setZoomedImage((current) =>
                        current
                          ? {
                              ...current,
                              enhancedDataUrl: undefined,
                            }
                          : current,
                      )
                    }
                    disabled={!zoomedImage.enhancedDataUrl}
                  >
                    元画像に戻す
                  </button>
                  <button type="button" className="ghost-button" onClick={() => setZoomedImage(null)}>
                    閉じる
                  </button>
                </div>

                <ul className="note-list">
                  <li>- AI 処理は現在の画像だけに適用され、本文テキストには影響しません。</li>
                  <li>- 設定画面で既定エンジンや倍率、自動実行の有無を変更できます。</li>
                  <li>- 画像が大きいほど処理時間が伸びます。</li>
                </ul>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}
