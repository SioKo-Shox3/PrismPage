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
  Settings2,
  X,
} from 'lucide-react'

import { useLibraryStore } from '@/features/library/book-store'
import { useSettingsStore } from '@/features/settings/settings-store'
import { base64ToArrayBuffer, flattenNavigation } from '@/lib/epub'
import { getEngineLabel } from '@/lib/engines'
import { enhanceBookImage, getEngineStatuses, readBookBase64 } from '@/lib/tauri'
import type { EngineId, EngineStatus } from '@/types/app'

interface ZoomedImageState {
  bookId: string
  originalDataUrl: string
  imageHash: string
  enhancedDataUrl?: string
  caption: string
  sessionId: number
}

type AutoEnhanceTone = 'idle' | 'working' | 'ready' | 'warning' | 'error'

interface AutoEnhanceStatus {
  message: string
  tone: AutoEnhanceTone
}

interface AutoEnhanceQueueItem {
  bookId: string
  dataUrl: string
  document: Document
  image: HTMLImageElement
  imageHash: string
  originalInfo: OriginalImageInfo
  renderToken: number
  sessionId: number
}

interface OriginalImageInfo {
  dataUrl: string
  imageHash: string
}

interface AutoEnhanceSettings {
  autoEnhanceVisibleImages: boolean
  engineReady: boolean
  enhancementEnabled: boolean
  preferredEngine: EngineId
  zoomEnhancementScale: number
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('画像の取得に失敗しました。'))
    reader.readAsDataURL(blob)
  })
}

async function imageElementToDataUrl(image: HTMLImageElement) {
  const source = image.currentSrc || image.src

  if (!source) {
    throw new Error('画像の参照先が見つかりません。')
  }

  if (source.startsWith('data:')) {
    return source
  }

  const response = await fetch(source)

  if (!response.ok) {
    throw new Error('画像の取得に失敗しました。')
  }

  return blobToDataUrl(await response.blob())
}

function fallbackHash(value: string) {
  const states = [
    0x811c9dc5,
    0x85ebca6b,
    0xc2b2ae35,
    0x27d4eb2f,
    0x165667b1,
    0xd3a2646c,
    0xfd7046c5,
    0xb55a4f09,
  ]

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    const slot = index % states.length
    const mixed = states[slot] ^ (code + index + value.length)
    states[slot] = Math.imul(mixed, 0x45d9f3b) ^ (mixed >>> 16)
  }

  return states
    .map((state, index) =>
      ((state ^ Math.imul(value.length + index, 0x9e3779b1)) >>> 0)
        .toString(16)
        .slice(-8)
        .padStart(8, '0'),
    )
    .join('')
}

async function hashDataUrl(dataUrl: string) {
  if (!window.crypto?.subtle) {
    return fallbackHash(dataUrl)
  }

  try {
    const digest = await window.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(dataUrl),
    )

    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    return fallbackHash(dataUrl)
  }
}

function buildEnhanceKey(imageHash: string, engineId: EngineId, scale: number) {
  return `${imageHash}:${engineId}:${scale}`
}

function isVisibleImage(image: HTMLImageElement) {
  const view = image.ownerDocument.defaultView

  if (!view || !image.isConnected) {
    return false
  }

  const rect = image.getBoundingClientRect()
  const viewportWidth = view.innerWidth || image.ownerDocument.documentElement.clientWidth
  const viewportHeight = view.innerHeight || image.ownerDocument.documentElement.clientHeight

  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < viewportWidth &&
    rect.top < viewportHeight
  )
}

function applyEnhancedImage(
  image: HTMLImageElement,
  dataUrl: string,
  originalInfo: OriginalImageInfo,
  originalImageInfoMap: WeakMap<HTMLImageElement, OriginalImageInfo>,
  cacheKey?: string,
) {
  if (!image.isConnected) {
    return
  }

  originalImageInfoMap.set(image, originalInfo)
  image.dataset.prismpageEnhanced = 'true'
  if (cacheKey) {
    image.dataset.prismpageEnhancedKey = cacheKey
  }
  image.dataset.prismpageOriginalHash = originalInfo.imageHash
  image.removeAttribute('srcset')
  image.src = dataUrl
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
    autoEnhanceVisibleImages,
    autoEnhanceZoomedImage,
    enhancementEnabled,
    fontScale,
    lineHeight,
    preferredEngine,
    zoomEnhancementScale,
  } = useSettingsStore()

  const [toc, setToc] = useState<Array<{ href: string; label: string }>>([])
  const [isTocOpen, setIsTocOpen] = useState(false)
  const [location, setLocation] = useState(book?.currentLocation)
  const [progress, setProgress] = useState(Math.round(book?.progressPercentage ?? 0))
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [engineStatuses, setEngineStatuses] = useState<EngineStatus[]>([])
  const [zoomedImage, setZoomedImage] = useState<ZoomedImageState | null>(null)
  const [isEnhancing, setIsEnhancing] = useState(false)
  const [readerReady, setReaderReady] = useState(false)
  const [autoEnhanceStatus, setAutoEnhanceStatus] = useState<AutoEnhanceStatus>({
    message: 'AI 自動適用を準備しています。',
    tone: 'idle',
  })
  const initialLocationRef = useRef<string | undefined>(book?.currentLocation)
  const autoQueueRef = useRef<AutoEnhanceQueueItem[]>([])
  const autoProcessingRef = useRef(false)
  const autoProcessingSessionRef = useRef<number | null>(null)
  const activeBookIdRef = useRef<string | undefined>(undefined)
  const readerSessionRef = useRef(0)
  const currentReaderDocumentRef = useRef<Document | null>(null)
  const currentRenderTokenRef = useRef(0)
  const inFlightEnhancementsRef = useRef(new Set<string>())
  const originalImageInfoRef = useRef(new WeakMap<HTMLImageElement, OriginalImageInfo>())
  const processedEnhancementsRef = useRef(new Set<string>())
  const enhancedImageCacheRef = useRef(new Map<string, string>())
  const currentBookId = book?.id

  const currentEngineStatus = useMemo(
    () => engineStatuses.find((status) => status.id === preferredEngine),
    [engineStatuses, preferredEngine],
  )

  const autoEnhanceSettingsRef = useRef<AutoEnhanceSettings>({
    autoEnhanceVisibleImages,
    engineReady: Boolean(currentEngineStatus?.ready),
    enhancementEnabled,
    preferredEngine,
    zoomEnhancementScale,
  })

  const applyReaderTheme = useCallback(() => {
    const rendition = renditionRef.current
    if (!rendition) {
      return
    }

    rendition.themes.default({
      body: {
        'background-color': 'transparent',
        'font-size': `${fontScale}%`,
        'line-height': String(lineHeight),
        margin: '0',
      },
      img: {
        cursor: 'zoom-in',
        margin: '0 auto',
        'max-height': '100vh',
        'object-fit': 'contain',
      },
    })
  }, [fontScale, lineHeight])

  const isCurrentReaderSession = useCallback((sessionId: number, bookId: string) => {
    return readerSessionRef.current === sessionId && activeBookIdRef.current === bookId
  }, [])

  const setAutoEnhanceStatusForSession = useCallback(
    (sessionId: number, bookId: string, status: AutoEnhanceStatus) => {
      if (isCurrentReaderSession(sessionId, bookId)) {
        setAutoEnhanceStatus(status)
      }
    },
    [isCurrentReaderSession],
  )

  const cleanupQueueForDocument = useCallback((document: Document | null) => {
    if (!document) {
      autoQueueRef.current = []
      return
    }

    const renderToken = currentRenderTokenRef.current
    const sessionId = readerSessionRef.current
    const bookId = activeBookIdRef.current
    autoQueueRef.current = autoQueueRef.current.filter(
      (item) =>
        item.sessionId === sessionId &&
        item.bookId === bookId &&
        item.document === document &&
        item.renderToken === renderToken &&
        item.image.isConnected &&
        isVisibleImage(item.image),
    )
  }, [])

  const prepareOriginalImageInfo = useCallback(async (image: HTMLImageElement) => {
    const existingInfo = originalImageInfoRef.current.get(image)

    if (existingInfo) {
      return existingInfo
    }

    const dataUrl = await imageElementToDataUrl(image)
    const imageHash = await hashDataUrl(dataUrl)
    const originalInfo = { dataUrl, imageHash }
    originalImageInfoRef.current.set(image, originalInfo)
    image.dataset.prismpageOriginalHash = imageHash

    return originalInfo
  }, [])

  const processAutoEnhanceQueue = useCallback(async () => {
    const sessionId = readerSessionRef.current
    const bookId = activeBookIdRef.current

    if (!bookId) {
      return
    }

    if (autoProcessingRef.current) {
      if (autoProcessingSessionRef.current === sessionId) {
        return
      }

      autoProcessingRef.current = false
      autoProcessingSessionRef.current = null
    }

    const isCurrentSession = () => isCurrentReaderSession(sessionId, bookId)
    const discardSessionQueue = () => {
      autoQueueRef.current = autoQueueRef.current.filter(
        (item) => item.sessionId !== sessionId || item.bookId !== bookId,
      )
    }

    if (!isCurrentSession()) {
      discardSessionQueue()
      return
    }

    const initialSettings = autoEnhanceSettingsRef.current
    if (!initialSettings.enhancementEnabled || !initialSettings.autoEnhanceVisibleImages) {
      return
    }

    if (!initialSettings.engineReady) {
      setAutoEnhanceStatusForSession(sessionId, bookId, {
        message: 'AI エンジン未登録のため元画像で表示しています。',
        tone: 'warning',
      })
      return
    }

    autoProcessingRef.current = true
    autoProcessingSessionRef.current = sessionId

    try {
      while (autoQueueRef.current.length > 0) {
        if (!isCurrentSession()) {
          discardSessionQueue()
          break
        }

        const item = autoQueueRef.current.shift()
        const settings = autoEnhanceSettingsRef.current

        if (!item || !mountedRef.current) {
          continue
        }

        if (item.sessionId !== sessionId || item.bookId !== bookId) {
          continue
        }

        if (
          item.document !== currentReaderDocumentRef.current ||
          item.renderToken !== currentRenderTokenRef.current ||
          !isVisibleImage(item.image)
        ) {
          continue
        }

        if (!settings.enhancementEnabled || !settings.autoEnhanceVisibleImages) {
          break
        }

        if (!settings.engineReady) {
          setAutoEnhanceStatusForSession(sessionId, bookId, {
            message: 'AI エンジン未登録のため元画像で表示しています。',
            tone: 'warning',
          })
          break
        }

        const cacheKey = buildEnhanceKey(
          item.imageHash,
          settings.preferredEngine,
          settings.zoomEnhancementScale,
        )
        const cachedDataUrl = enhancedImageCacheRef.current.get(cacheKey)

        if (cachedDataUrl) {
          if (!isCurrentSession()) {
            discardSessionQueue()
            break
          }

          applyEnhancedImage(
            item.image,
            cachedDataUrl,
            item.originalInfo,
            originalImageInfoRef.current,
            cacheKey,
          )
          setAutoEnhanceStatusForSession(sessionId, bookId, {
            message: 'AI 高精細化済みの画像を適用しました。',
            tone: 'ready',
          })
          continue
        }

        if (
          processedEnhancementsRef.current.has(cacheKey) ||
          inFlightEnhancementsRef.current.has(cacheKey)
        ) {
          continue
        }

        inFlightEnhancementsRef.current.add(cacheKey)
        setAutoEnhanceStatusForSession(sessionId, bookId, {
          message: `AI 高精細化中: ${getEngineLabel(settings.preferredEngine)} x${settings.zoomEnhancementScale}`,
          tone: 'working',
        })

        try {
          if (!isCurrentSession()) {
            discardSessionQueue()
            break
          }

          const response = await enhanceBookImage({
            bookId,
            engineId: settings.preferredEngine,
            imageDataUrl: item.dataUrl,
            imageHash: item.imageHash,
            scale: settings.zoomEnhancementScale,
          })

          if (!isCurrentSession()) {
            discardSessionQueue()
            break
          }

          enhancedImageCacheRef.current.set(cacheKey, response.imageDataUrl)
          processedEnhancementsRef.current.add(cacheKey)
          if (
            isCurrentSession() &&
            item.document === currentReaderDocumentRef.current &&
            item.renderToken === currentRenderTokenRef.current &&
            isVisibleImage(item.image)
          ) {
            applyEnhancedImage(
              item.image,
              response.imageDataUrl,
              item.originalInfo,
              originalImageInfoRef.current,
              cacheKey,
            )
          }
          setAutoEnhanceStatusForSession(sessionId, bookId, {
            message: response.cacheHit
              ? 'キャッシュ済みの高精細画像を適用しました。'
              : '表示中の画像へ AI 高精細化を適用しました。',
            tone: 'ready',
          })
        } catch (enhanceError) {
          if (!isCurrentSession()) {
            discardSessionQueue()
            break
          }

          processedEnhancementsRef.current.add(cacheKey)
          setAutoEnhanceStatusForSession(sessionId, bookId, {
            message:
              enhanceError instanceof Error
                ? `AI 自動適用をスキップしました: ${enhanceError.message}`
                : 'AI 自動適用をスキップしました。元画像で表示しています。',
            tone: 'warning',
          })
        } finally {
          inFlightEnhancementsRef.current.delete(cacheKey)
        }
      }
    } finally {
      if (autoProcessingSessionRef.current === sessionId) {
        autoProcessingRef.current = false
        autoProcessingSessionRef.current = null
      }
    }
  }, [isCurrentReaderSession, setAutoEnhanceStatusForSession])

  const enqueueVisibleImages = useCallback(
    (document: Document) => {
      const sessionId = readerSessionRef.current
      const bookId = activeBookIdRef.current

      if (!bookId) {
        return
      }

      const isCurrentSession = () => isCurrentReaderSession(sessionId, bookId)
      const settings = autoEnhanceSettingsRef.current

      if (!settings.enhancementEnabled) {
        setAutoEnhanceStatusForSession(sessionId, bookId, {
          message: 'AI 高精細化はオフです。',
          tone: 'idle',
        })
        return
      }

      if (!settings.autoEnhanceVisibleImages) {
        setAutoEnhanceStatusForSession(sessionId, bookId, {
          message: '表示画像の自動高精細化はオフです。',
          tone: 'idle',
        })
        return
      }

      if (!settings.engineReady) {
        setAutoEnhanceStatusForSession(sessionId, bookId, {
          message: 'AI エンジン未登録のため元画像で表示しています。',
          tone: 'warning',
        })
        return
      }

      const images = (Array.from(document.querySelectorAll('img')) as HTMLImageElement[]).filter(
        isVisibleImage,
      )

      if (images.length === 0) {
        setAutoEnhanceStatusForSession(sessionId, bookId, {
          message: '表示中の画像を待機しています。',
          tone: 'idle',
        })
        return
      }

      const renderToken = currentRenderTokenRef.current

      for (const image of images) {
        if (image.dataset.prismpageQueuePending === 'true') {
          continue
        }

        image.dataset.prismpageQueuePending = 'true'

        void prepareOriginalImageInfo(image)
          .then((originalInfo) => {
            delete image.dataset.prismpageQueuePending

            if (
              !isCurrentSession() ||
              document !== currentReaderDocumentRef.current ||
              renderToken !== currentRenderTokenRef.current ||
              !isVisibleImage(image)
            ) {
              return
            }

            const latestSettings = autoEnhanceSettingsRef.current
            const cacheKey = buildEnhanceKey(
              originalInfo.imageHash,
              latestSettings.preferredEngine,
              latestSettings.zoomEnhancementScale,
            )
            const cachedDataUrl = enhancedImageCacheRef.current.get(cacheKey)

            if (image.dataset.prismpageEnhancedKey === cacheKey) {
              return
            }

            if (cachedDataUrl) {
              applyEnhancedImage(
                image,
                cachedDataUrl,
                originalInfo,
                originalImageInfoRef.current,
                cacheKey,
              )
              return
            }

            const alreadyQueued = autoQueueRef.current.some(
              (item) => item.image === image && item.renderToken === renderToken,
            )

            if (
              alreadyQueued ||
              processedEnhancementsRef.current.has(cacheKey) ||
              inFlightEnhancementsRef.current.has(cacheKey)
            ) {
              return
            }

            image.dataset.prismpageQueuedKey = cacheKey
            autoQueueRef.current.push({
              bookId,
              dataUrl: originalInfo.dataUrl,
              document,
              image,
              imageHash: originalInfo.imageHash,
              originalInfo,
              renderToken,
              sessionId,
            })
            setAutoEnhanceStatusForSession(sessionId, bookId, {
              message: '表示画像を AI 高精細化キューへ追加しました。',
              tone: 'working',
            })
            void processAutoEnhanceQueue()
          })
          .catch(() => {
            delete image.dataset.prismpageQueuePending
          })
      }
    },
    [
      isCurrentReaderSession,
      prepareOriginalImageInfo,
      processAutoEnhanceQueue,
      setAutoEnhanceStatusForSession,
    ],
  )

  const openZoomedImage = useCallback(async (image: HTMLImageElement) => {
    const sessionId = readerSessionRef.current
    const bookId = activeBookIdRef.current

    if (!bookId) {
      return
    }

    try {
      const originalInfo = await prepareOriginalImageInfo(image)

      if (!isCurrentReaderSession(sessionId, bookId)) {
        return
      }

      const settings = autoEnhanceSettingsRef.current
      const cacheKey = buildEnhanceKey(
        originalInfo.imageHash,
        settings.preferredEngine,
        settings.zoomEnhancementScale,
      )

      setZoomedImage({
        bookId,
        caption: image.alt || 'EPUB image',
        enhancedDataUrl: enhancedImageCacheRef.current.get(cacheKey),
        imageHash: originalInfo.imageHash,
        originalDataUrl: originalInfo.dataUrl,
        sessionId,
      })
    } catch {
      if (isCurrentReaderSession(sessionId, bookId)) {
        setError('拡大画像の読み込みに失敗しました。')
      }
    }
  }, [isCurrentReaderSession, prepareOriginalImageInfo])

  const rescanCurrentDocument = useCallback(() => {
    const sessionId = readerSessionRef.current
    const bookId = activeBookIdRef.current
    const document = currentReaderDocumentRef.current

    cleanupQueueForDocument(document)

    if (document) {
      enqueueVisibleImages(document)
      return
    }

    if (bookId) {
      setAutoEnhanceStatusForSession(sessionId, bookId, {
        message: '表示画像を待機しています。',
        tone: 'idle',
      })
    }
  }, [cleanupQueueForDocument, enqueueVisibleImages, setAutoEnhanceStatusForSession])

  useEffect(() => {
    const sessionId = readerSessionRef.current
    const bookId = activeBookIdRef.current

    if (!bookId) {
      return undefined
    }

    autoEnhanceSettingsRef.current = {
      autoEnhanceVisibleImages,
      engineReady: Boolean(currentEngineStatus?.ready),
      enhancementEnabled,
      preferredEngine,
      zoomEnhancementScale,
    }

    let statusTimerId: number | undefined
    const scheduleStatus = (status: AutoEnhanceStatus) => {
      statusTimerId = window.setTimeout(() => {
        setAutoEnhanceStatusForSession(sessionId, bookId, status)
      }, 0)
    }

    if (!enhancementEnabled) {
      scheduleStatus({
        message: 'AI 高精細化はオフです。',
        tone: 'idle',
      })
      return () => {
        window.clearTimeout(statusTimerId)
      }
    }

    if (!autoEnhanceVisibleImages) {
      scheduleStatus({
        message: '表示画像の自動高精細化はオフです。',
        tone: 'idle',
      })
      return () => {
        window.clearTimeout(statusTimerId)
      }
    }

    if (!currentEngineStatus?.ready) {
      scheduleStatus({
        message: 'AI エンジン未登録のため元画像で表示しています。',
        tone: 'warning',
      })
      return () => {
        window.clearTimeout(statusTimerId)
      }
    }

    const rescanTimerId = window.setTimeout(() => {
      setAutoEnhanceStatusForSession(sessionId, bookId, {
        message: 'AI 自動適用を待機しています。',
        tone: 'idle',
      })
      if (isCurrentReaderSession(sessionId, bookId)) {
        rescanCurrentDocument()
        void processAutoEnhanceQueue()
      }
    }, 0)

    return () => {
      window.clearTimeout(rescanTimerId)
    }
  }, [
    autoEnhanceVisibleImages,
    currentEngineStatus?.ready,
    enhancementEnabled,
    isCurrentReaderSession,
    preferredEngine,
    processAutoEnhanceQueue,
    rescanCurrentDocument,
    setAutoEnhanceStatusForSession,
    zoomEnhancementScale,
  ])

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
    readerSessionRef.current += 1
    activeBookIdRef.current = currentBookId
    const sessionId = readerSessionRef.current
    const isActiveReader = () => isCurrentReaderSession(sessionId, currentBookId)
    setZoomedImage(null)
    setIsEnhancing(false)
    autoQueueRef.current = []
    autoProcessingRef.current = false
    autoProcessingSessionRef.current = null
    currentReaderDocumentRef.current = null
    currentRenderTokenRef.current += 1
    inFlightEnhancementsRef.current.clear()
    originalImageInfoRef.current = new WeakMap<HTMLImageElement, OriginalImageInfo>()
    processedEnhancementsRef.current.clear()
    enhancedImageCacheRef.current.clear()
    const inFlightEnhancements = inFlightEnhancementsRef.current

    const loadReader = async () => {
      try {
        if (!isActiveReader()) {
          return
        }

        setLoading(true)
        setError(null)

        const base64 = await readBookBase64(currentBookId)
        if (!isActiveReader()) {
          return
        }

        const epubBook = ePub(base64ToArrayBuffer(base64))
        bookRef.current = epubBook

        await epubBook.ready
        if (!isActiveReader()) {
          epubBook.destroy()
          return
        }

        const navigation = await epubBook.loaded.navigation
        if (!isActiveReader()) {
          epubBook.destroy()
          return
        }

        setToc(flattenNavigation(navigation.toc as EpubNavigationItem[]))

        const rendition = epubBook.renderTo(containerRef.current!, {
          flow: 'paginated',
          height: '100%',
          width: '100%',
        })

        if (!isActiveReader()) {
          rendition.destroy()
          epubBook.destroy()
          return
        }

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
          cleanupQueueForDocument(currentReaderDocumentRef.current)
        }

        renderedHandler = (_section, contents) => {
          currentRenderTokenRef.current += 1
          currentReaderDocumentRef.current = contents.document
          cleanupQueueForDocument(contents.document)

          const images = Array.from(contents.document.querySelectorAll('img')) as HTMLImageElement[]

          for (const image of images) {
            if (image.dataset.prismpageClickBound === 'true') {
              continue
            }

            image.dataset.prismpageClickBound = 'true'
            image.addEventListener('click', () => {
              void openZoomedImage(image)
            })
          }

          enqueueVisibleImages(contents.document)
        }

        rendition.on('relocated', relocationHandler)
        rendition.on('rendered', renderedHandler)
        await rendition.display(initialLocationRef.current)
      } catch (readerError) {
        if (isActiveReader()) {
          setError(
            readerError instanceof Error
              ? readerError.message
              : 'EPUB の読み込みに失敗しました。',
          )
        }
      } finally {
        if (mountedRef.current && isActiveReader()) {
          setLoading(false)
        }
      }
    }

    void loadReader()

    return () => {
      mountedRef.current = false
      readerSessionRef.current += 1
      activeBookIdRef.current = undefined
      setZoomedImage(null)
      setIsEnhancing(false)
      autoQueueRef.current = []
      autoProcessingRef.current = false
      autoProcessingSessionRef.current = null
      currentReaderDocumentRef.current = null
      currentRenderTokenRef.current += 1
      inFlightEnhancements.clear()
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
  }, [
    applyReaderTheme,
    cleanupQueueForDocument,
    currentBookId,
    enqueueVisibleImages,
    isCurrentReaderSession,
    openZoomedImage,
    patchBook,
  ])

  useEffect(() => {
    applyReaderTheme()
  }, [applyReaderTheme])

  const handleEnhanceImage = useCallback(async () => {
    if (!zoomedImage || !enhancementEnabled || !currentBookId) {
      return
    }

    const zoomedSessionId = zoomedImage.sessionId
    const zoomedBookId = zoomedImage.bookId
    const isCurrentZoomedImage = () =>
      currentBookId === zoomedBookId && isCurrentReaderSession(zoomedSessionId, zoomedBookId)

    if (!isCurrentZoomedImage()) {
      setZoomedImage(null)
      return
    }

    if (!currentEngineStatus?.ready) {
      if (isCurrentZoomedImage()) {
        setError('選択中の AI エンジンがまだ利用可能ではありません。設定画面から登録してください。')
      }
      return
    }

    try {
      setIsEnhancing(true)
      setError(null)
      const requestImageDataUrl = zoomedImage.originalDataUrl
      const requestImageHash = zoomedImage.imageHash
      const response = await enhanceBookImage({
        bookId: zoomedBookId,
        engineId: preferredEngine,
        imageDataUrl: requestImageDataUrl,
        imageHash: requestImageHash,
        scale: zoomEnhancementScale,
      })

      if (!isCurrentZoomedImage()) {
        return
      }

      const cacheKey = buildEnhanceKey(
        requestImageHash,
        preferredEngine,
        zoomEnhancementScale,
      )

      enhancedImageCacheRef.current.set(cacheKey, response.imageDataUrl)
      processedEnhancementsRef.current.add(cacheKey)
      setZoomedImage((current) =>
        current &&
        current.bookId === zoomedBookId &&
        current.sessionId === zoomedSessionId &&
        current.originalDataUrl === requestImageDataUrl &&
        current.imageHash === requestImageHash
          ? {
              ...current,
              enhancedDataUrl: response.imageDataUrl,
            }
          : current,
      )
    } catch (enhanceError) {
      if (isCurrentZoomedImage()) {
        setError(
          enhanceError instanceof Error
            ? enhanceError.message
            : 'AI 高精細化に失敗しました。',
        )
      }
    } finally {
      if (isCurrentZoomedImage()) {
        setIsEnhancing(false)
      }
    }
  }, [
    currentBookId,
    currentEngineStatus?.ready,
    enhancementEnabled,
    isCurrentReaderSession,
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
      <div className="reader-page">
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
    <div className="reader-page">
      <section className="reader-focus-shell">
        <div className="reader-topbar">
          <Link to="/" className="reader-icon-button" aria-label="ライブラリへ戻る">
            <ArrowLeft size={19} />
          </Link>

          <div className="reader-title-strip">
            <strong>{book.title}</strong>
            <span>{book.author ?? '著者情報なし'}</span>
          </div>

          <div className="reader-topbar-actions">
            <button
              type="button"
              className="reader-icon-button"
              aria-label="目次"
              onClick={() => setIsTocOpen((current) => !current)}
            >
              <ListTree size={19} />
            </button>
            <Link to="/settings" className="reader-icon-button" aria-label="設定">
              <Settings2 size={19} />
            </Link>
          </div>
        </div>

        {error ? <div className="reader-floating-message is-error">{error}</div> : null}

        <div className="reader-stage reader-stage--focus">
          {loading ? (
            <div className="reader-loading">
              <LoaderCircle size={34} className="animate-spin" />
              <span>EPUB を読み込んでいます</span>
            </div>
          ) : null}
          <div ref={containerRef} className="epub-container" />
        </div>

        <div className="reader-bottom-bar">
          <button
            type="button"
            className="reader-icon-button"
            onClick={() => void renditionRef.current?.prev()}
            disabled={toolbarDisabled}
            aria-label="前へ"
          >
            <ArrowLeft size={20} />
          </button>

          <div className="reader-progress">
            <span>{progress}%</span>
            <div className="reader-progress-track" aria-hidden="true">
              <div style={{ width: `${progress}%` }} />
            </div>
            <small>{location ? '位置を保存済み' : '先頭から開始'}</small>
          </div>

          <button
            type="button"
            className="reader-icon-button"
            onClick={() => void renditionRef.current?.next()}
            disabled={toolbarDisabled}
            aria-label="次へ"
          >
            <ArrowRight size={20} />
          </button>
        </div>

        <div className={`reader-ai-status is-${autoEnhanceStatus.tone}`}>
          <ImageUpscale size={16} />
          <span>{autoEnhanceStatus.message}</span>
        </div>

        {isTocOpen ? (
          <aside className="reader-toc-panel" aria-label="目次">
            <div className="reader-toc-header">
              <div>
                <span className="eyebrow">TOC</span>
                <h2>目次</h2>
              </div>
              <button
                type="button"
                className="reader-icon-button"
                aria-label="目次を閉じる"
                onClick={() => setIsTocOpen(false)}
              >
                <X size={18} />
              </button>
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
                      onClick={() => {
                        setIsTocOpen(false)
                        void renditionRef.current?.display(item.href)
                      }}
                    >
                      {item.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        ) : null}
      </section>

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
                    <h2>画像プレビュー</h2>
                    <p>{zoomedImage.caption}</p>
                  </div>
                </div>

                <div className="book-meta">
                  <span className="chip">
                    表示中 {zoomedImage.enhancedDataUrl ? 'AI 適用後' : '元画像'}
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
                        高精細化を再実行
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
                  <li>- 読書中の表示画像は設定中の AI エンジンで自動処理します。</li>
                  <li>- 失敗時は元画像のまま読めます。</li>
                  <li>- 高精細画像は書籍・エンジン・倍率ごとにキャッシュします。</li>
                </ul>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}
