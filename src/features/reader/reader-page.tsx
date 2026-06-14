import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react'
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
import {
  cancelEnhancementJobs,
  enhanceBookAssetImage,
  enhanceBookImage,
  getEngineStatuses,
  readBookAssetImage,
  readBookBase64,
  readEnhancedBookImage,
  scanBookImages,
} from '@/lib/tauri'
import type { EngineId, EngineStatus, ScannedBookImage } from '@/types/app'

const AUTO_ENHANCE_IDLE_DELAY_MS = 1500
const ENHANCED_IMAGE_MEMORY_CACHE_LIMIT = 8
const IMAGE_CLICK_NAVIGATION_DELAY_MS = 280
const READER_EDGE_REVEAL_PX = 72
const READER_SPREAD_MIN_HEIGHT = 650
const READER_SPREAD_MIN_RATIO = 1.25
const READER_SPREAD_MIN_WIDTH = 1100
const READER_WHEEL_THROTTLE_MS = 250
const XLINK_NS = 'http://www.w3.org/1999/xlink'

type ReaderImageElement = HTMLImageElement | SVGImageElement
type ReaderNavigationDirection = 'next' | 'prev'
type ReaderPageDirection = 'ltr' | 'rtl'
type ReaderMode = 'epub' | 'image-spread'
type ReaderSpreadMode = 'always' | 'none'

interface ZoomedImageState {
  bookId: string
  originalDataUrl: string
  imageHash: string
  enhancedDataUrl?: string
  caption: string
  readerSessionId: string
  sessionId: number
}

type AutoEnhanceTone = 'idle' | 'working' | 'ready' | 'warning' | 'error'

interface AutoEnhanceStatus {
  message: string
  tone: AutoEnhanceTone
}

interface OriginalImageInfo {
  dataUrl: string
  imageHash: string
}

interface AutoEnhanceSettings {
  autoEnhanceZoomedImage: boolean
  autoEnhanceVisibleImages: boolean
  engineReady: boolean
  enhancementEnabled: boolean
  precomputeBookImages: boolean
  preferredEngine: EngineId
  zoomEnhancementScale: number
}

interface BookEnhancementQueueItem {
  image: ScannedBookImage
  priority: 'visible' | 'precompute'
}

interface ReaderMetadataWithDirection {
  direction?: unknown
  pageProgressionDirection?: unknown
}

interface EpubLocationWithEdges extends EpubLocation {
  atEnd?: boolean
  atStart?: boolean
}

interface ReaderLayoutRendition extends EpubRendition {
  direction(dir: ReaderPageDirection): void
  getContents?(): unknown
  manager?: {
    resize?: (width: number, height: number) => void
  }
  resize(width: number, height: number): void
  spread(spread: ReaderSpreadMode, min?: number): void
}

interface ReaderContentLike {
  document?: unknown
}

function createClientId(prefix: string) {
  const cryptoApi = typeof window !== 'undefined' ? window.crypto : undefined
  const randomId =
    cryptoApi?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`

  return `${prefix}-${randomId}`
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('画像の取得に失敗しました。'))
    reader.readAsDataURL(blob)
  })
}

function isSvgImageElement(image: ReaderImageElement): image is SVGImageElement {
  return image.namespaceURI === 'http://www.w3.org/2000/svg' && image.localName === 'image'
}

function getImageSource(image: ReaderImageElement) {
  if (isSvgImageElement(image)) {
    return (
      image.href.baseVal ||
      image.getAttribute('href') ||
      image.getAttributeNS(XLINK_NS, 'href') ||
      image.getAttribute('xlink:href') ||
      ''
    )
  }

  return image.currentSrc || image.src
}

function setImageSource(image: ReaderImageElement, dataUrl: string) {
  if (isSvgImageElement(image)) {
    image.setAttribute('href', dataUrl)
    image.setAttributeNS(XLINK_NS, 'xlink:href', dataUrl)
    return
  }

  image.removeAttribute('srcset')
  image.src = dataUrl
}

function getImageCaption(image: ReaderImageElement) {
  if (isSvgImageElement(image)) {
    return image.getAttribute('aria-label') || image.getAttribute('title') || 'EPUB image'
  }

  return image.alt || 'EPUB image'
}

function getImageDataAttribute(image: ReaderImageElement, key: string) {
  return (image as ReaderImageElement & { dataset?: DOMStringMap }).dataset?.[key]
}

function setImageDataAttribute(image: ReaderImageElement, key: string, value: string) {
  const dataset = (image as ReaderImageElement & { dataset?: DOMStringMap }).dataset

  if (dataset) {
    dataset[key] = value
    return
  }

  image.setAttribute(`data-${key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)}`, value)
}

function getReaderImageElements(document: Document) {
  return Array.from(document.querySelectorAll('img, svg image')) as ReaderImageElement[]
}

function isDocument(value: unknown): value is Document {
  return (
    typeof Document !== 'undefined' &&
    value instanceof Document
  )
}

function getDocumentFromContent(value: unknown) {
  if (isDocument(value)) {
    return value
  }

  const document = (value as ReaderContentLike | null)?.document

  return isDocument(document) ? document : null
}

function getDocumentsFromContents(value: unknown) {
  if (!value) {
    return []
  }

  const values = Array.isArray(value) ? value : [value]
  const documents: Document[] = []

  for (const item of values) {
    const document = getDocumentFromContent(item)

    if (document && !documents.includes(document)) {
      documents.push(document)
    }
  }

  return documents
}

function isReaderDocumentConnected(document: Document) {
  const frameElement = document.defaultView?.frameElement

  return !frameElement || frameElement.isConnected
}

function isElementTarget(target: EventTarget | null): target is Element {
  return Boolean(target && typeof (target as Element).closest === 'function')
}

function isReaderInteractiveTarget(target: EventTarget | null) {
  if (!isElementTarget(target)) {
    return false
  }

  return Boolean(
    target.closest(
      [
        'a',
        'button',
        'input',
        'select',
        'textarea',
        'summary',
        '[contenteditable="true"]',
        '[role="button"]',
        '[role="link"]',
        '[role="menuitem"]',
        '.reader-topbar',
        '.reader-bottom-bar',
        '.reader-toc-panel',
        '.modal-backdrop',
      ].join(','),
    ),
  )
}

function getReaderImageFromTarget(target: EventTarget | null) {
  if (!isElementTarget(target)) {
    return null
  }

  return target.closest('img, svg image') as ReaderImageElement | null
}

function getReaderViewportSize(element: HTMLElement) {
  const width = Math.max(0, Math.round(element.clientWidth || window.innerWidth))
  const height = Math.max(0, Math.round(element.clientHeight || window.innerHeight))

  return { height, width }
}

function shouldUseReaderSpread(width: number, height: number) {
  return (
    width >= READER_SPREAD_MIN_WIDTH &&
    height >= READER_SPREAD_MIN_HEIGHT &&
    width / Math.max(height, 1) >= READER_SPREAD_MIN_RATIO
  )
}

function getReaderSpreadMode(element: HTMLElement): ReaderSpreadMode {
  const { height, width } = getReaderViewportSize(element)

  return shouldUseReaderSpread(width, height) ? 'always' : 'none'
}

function getImageSpreadPageCount(element: HTMLElement | null) {
  if (!element) {
    return 1
  }

  const { height, width } = getReaderViewportSize(element)

  return shouldUseReaderSpread(width, height) ? 2 : 1
}

function parseImageSpreadLocation(location?: string) {
  const match = location?.match(/^image-spread:(\d+)$/)

  if (!match) {
    return null
  }

  const index = Number.parseInt(match[1], 10)

  return Number.isFinite(index) && index >= 0 ? index : null
}

function getEpubInitialLocation(location?: string) {
  return parseImageSpreadLocation(location) === null ? location : undefined
}

function getImageSpreadLocation(index: number) {
  return `image-spread:${Math.max(0, index)}`
}

function getEpubSpineItemCount(epubBook: ReturnType<typeof ePub>) {
  const spineItems = (epubBook as unknown as {
    spine?: {
      spineItems?: unknown[]
      items?: unknown[]
    }
  }).spine

  return spineItems?.spineItems?.length ?? spineItems?.items?.length ?? 0
}

function shouldUseImageSpreadReader(images: ScannedBookImage[], epubBook: ReturnType<typeof ePub>) {
  if (images.length < 2) {
    return false
  }

  const spineItemCount = getEpubSpineItemCount(epubBook)

  if (spineItemCount <= 1) {
    return images.length >= 2
  }

  return images.length >= Math.max(4, Math.ceil(spineItemCount * 0.9))
}

function resizeReaderRenditionIfReady(
  rendition: ReaderLayoutRendition,
  width: number,
  height: number,
) {
  if (!rendition.manager?.resize) {
    return
  }

  rendition.resize(width, height)
}

function getReaderDirection(metadata: unknown): ReaderPageDirection {
  const direction = String(
    (metadata as ReaderMetadataWithDirection | null)?.direction ??
      (metadata as ReaderMetadataWithDirection | null)?.pageProgressionDirection ??
      '',
  ).toLowerCase()

  return direction === 'ltr' ? 'ltr' : 'rtl'
}

function getClickNavigationDirection(
  clientX: number,
  width: number,
  pageDirection: ReaderPageDirection,
): ReaderNavigationDirection {
  const clickedLeftSide = clientX < width / 2

  if (pageDirection === 'rtl') {
    return clickedLeftSide ? 'next' : 'prev'
  }

  return clickedLeftSide ? 'prev' : 'next'
}

function getReaderRelativePointFromDocumentEvent(
  event: MouseEvent,
  readerElement: HTMLElement | null,
) {
  if (!readerElement) {
    const document = event.view?.document

    return {
      x: event.clientX,
      y: event.clientY,
      height: event.view?.innerHeight || document?.documentElement.clientHeight || window.innerHeight,
      width: event.view?.innerWidth || document?.documentElement.clientWidth || window.innerWidth,
    }
  }

  const readerRect = readerElement.getBoundingClientRect()
  const frameElement = event.view?.frameElement
  const frameRect =
    frameElement instanceof Element ? frameElement.getBoundingClientRect() : null
  const parentClientX = frameRect ? frameRect.left + event.clientX : event.clientX

  return {
    x: parentClientX - readerRect.left,
    y: (frameRect ? frameRect.top + event.clientY : event.clientY) - readerRect.top,
    height: readerRect.height,
    width: readerRect.width,
  }
}

function isReaderPointNearEdge(point: { height: number; width: number; x: number; y: number }) {
  return (
    point.y <= READER_EDGE_REVEAL_PX ||
    point.height - point.y <= READER_EDGE_REVEAL_PX ||
    point.x <= READER_EDGE_REVEAL_PX ||
    point.width - point.x <= READER_EDGE_REVEAL_PX
  )
}

function isImageDominantPage(document: Document) {
  const images = getReaderImageElements(document).filter(isVisibleImage)

  if (images.length === 0) {
    return false
  }

  const view = document.defaultView
  const viewportWidth = view?.innerWidth || document.documentElement.clientWidth
  const viewportHeight = view?.innerHeight || document.documentElement.clientHeight
  const viewportArea = Math.max(viewportWidth * viewportHeight, 1)
  const bodyText = (document.body?.innerText ?? document.body?.textContent ?? '')
    .replace(/\s+/g, '')
    .trim()
  const hasLargeImage = images.some((image) => {
    const rect = image.getBoundingClientRect()
    const areaRatio = (rect.width * rect.height) / viewportArea

    return (
      areaRatio >= 0.35 ||
      (rect.width >= viewportWidth * 0.68 && rect.height >= viewportHeight * 0.52)
    )
  })

  return bodyText.length <= 120 || (hasLargeImage && bodyText.length <= 500)
}

function applyImagePageClass(document: Document) {
  const isImagePage = isImageDominantPage(document)

  document.documentElement.classList.toggle('prismpage-image-page', isImagePage)
  document.body?.classList.toggle('prismpage-image-page', isImagePage)
}

async function imageElementToBlob(image: ReaderImageElement) {
  const source = getImageSource(image)

  if (!source) {
    throw new Error('画像の参照先が見つかりません。')
  }

  const sourceUrl =
    source.startsWith('data:') || source.startsWith('blob:')
      ? source
      : new URL(source, image.ownerDocument.baseURI).toString()
  const response = await fetch(sourceUrl)

  if (!response.ok) {
    throw new Error('画像の取得に失敗しました。')
  }

  return response.blob()
}

function fallbackHashBytes(bytes: Uint8Array) {
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

  for (let index = 0; index < bytes.length; index += 1) {
    const slot = index % states.length
    const mixed = states[slot] ^ (bytes[index] + index + bytes.length)
    states[slot] = Math.imul(mixed, 0x45d9f3b) ^ (mixed >>> 16)
  }

  return states
    .map((state, index) =>
      ((state ^ Math.imul(bytes.length + index, 0x9e3779b1)) >>> 0)
        .toString(16)
        .slice(-8)
        .padStart(8, '0'),
    )
    .join('')
}

async function hashArrayBuffer(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)

  if (!window.crypto?.subtle) {
    return fallbackHashBytes(bytes)
  }

  try {
    const digest = await window.crypto.subtle.digest('SHA-256', buffer)

    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    return fallbackHashBytes(bytes)
  }
}

function buildEnhanceKey(imageHash: string, engineId: EngineId, scale: number) {
  return `${imageHash}:${engineId}:${scale}`
}

function isVisibleImage(image: ReaderImageElement) {
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
  image: ReaderImageElement,
  dataUrl: string,
  originalInfo: OriginalImageInfo,
  originalImageInfoMap: WeakMap<ReaderImageElement, OriginalImageInfo>,
  cacheKey?: string,
) {
  if (!image.isConnected) {
    return
  }

  originalImageInfoMap.set(image, originalInfo)
  setImageDataAttribute(image, 'prismpageEnhanced', 'true')
  if (cacheKey) {
    setImageDataAttribute(image, 'prismpageEnhancedKey', cacheKey)
  }
  setImageDataAttribute(image, 'prismpageOriginalHash', originalInfo.imageHash)
  setImageSource(image, dataUrl)
}

export function ReaderPage() {
  const { bookId } = useParams({ from: '/reader/$bookId' })
  const containerRef = useRef<HTMLDivElement | null>(null)
  const renditionRef = useRef<ReaderLayoutRendition | null>(null)
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
    precomputeBookImages,
    preferredEngine,
    zoomEnhancementScale,
  } = useSettingsStore()

  const [toc, setToc] = useState<Array<{ href: string; label: string }>>([])
  const [isTocOpen, setIsTocOpen] = useState(false)
  const [location, setLocation] = useState(book?.currentLocation)
  const [progress, setProgress] = useState(Math.round(book?.progressPercentage ?? 0))
  const [error, setError] = useState<string | null>(null)
  const [readerInitializing, setReaderInitializing] = useState(true)
  const [engineStatuses, setEngineStatuses] = useState<EngineStatus[]>([])
  const [zoomedImage, setZoomedImage] = useState<ZoomedImageState | null>(null)
  const [isEnhancing, setIsEnhancing] = useState(false)
  const [readerReady, setReaderReady] = useState(false)
  const [readerInteractionReady, setReaderInteractionReady] = useState(false)
  const [isReaderUiActive, setIsReaderUiActive] = useState(false)
  const [readerMode, setReaderMode] = useState<ReaderMode>('epub')
  const [readerDirection, setReaderDirection] = useState<ReaderPageDirection>('rtl')
  const [imageSpreadManifest, setImageSpreadManifest] = useState<ScannedBookImage[]>([])
  const [imageSpreadIndex, setImageSpreadIndex] = useState(0)
  const [imageSpreadPageCount, setImageSpreadPageCount] = useState(1)
  const [imageAssetDataUrls, setImageAssetDataUrls] = useState<Record<string, string>>({})
  const [enhancedImageSpreadDataUrls, setEnhancedImageSpreadDataUrls] = useState<Record<string, string>>({})
  const [imageSpreadLoadErrors, setImageSpreadLoadErrors] = useState<Record<string, string>>({})
  const [idleGenerationSnapshot, setIdleGenerationSnapshot] = useState(0)
  const [autoEnhanceStatus, setAutoEnhanceStatus] = useState<AutoEnhanceStatus>({
    message: '元画像を表示しています。',
    tone: 'idle',
  })
  const activeBookIdRef = useRef<string | undefined>(undefined)
  const readerInstanceIdRef = useRef(createClientId('reader'))
  const readerSessionRef = useRef(0)
  const currentReaderSessionIdRef = useRef<string | null>(null)
  const currentEnhancementGroupIdRef = useRef<string | null>(null)
  const currentReaderDocumentsRef = useRef(new Set<Document>())
  const currentRenderTokenRef = useRef(0)
  const documentActivityCleanupRef = useRef(new Map<Document, () => void>())
  const idleTimerRef = useRef<number | undefined>(undefined)
  const readerUiRevealTimerRef = useRef<number | undefined>(undefined)
  const idleGenerationRef = useRef(0)
  const lastReaderActivityAtRef = useRef(0)
  const lastReaderWheelAtRef = useRef(0)
  const pendingImageClickNavigationRef = useRef<number | undefined>(undefined)
  const readerDirectionRef = useRef<ReaderPageDirection>('rtl')
  const readerModeRef = useRef<ReaderMode>('epub')
  const imageSpreadManifestRef = useRef<ScannedBookImage[]>([])
  const imageSpreadIndexRef = useRef(0)
  const imageSpreadPageCountRef = useRef(1)
  const imageSpreadEnhancedCacheChecksRef = useRef(new Set<string>())
  const canNavigateReaderRef = useRef(false)
  const readerRelocationEdgesRef = useRef({ atEnd: false, atStart: true })
  const bookImageManifestRef = useRef<ScannedBookImage[]>([])
  const bookImageByHashRef = useRef(new Map<string, ScannedBookImage>())
  const bookImageCachedHashesRef = useRef(new Set<string>())
  const bookImageFailedHashesRef = useRef(new Set<string>())
  const bookImageQueuedHashesRef = useRef(new Set<string>())
  const bookImageQueueRef = useRef<BookEnhancementQueueItem[]>([])
  const bookImageProcessingRunIdRef = useRef<string | null>(null)
  const bookImageScanTokenRef = useRef(0)
  const processBookImageQueueRef = useRef<(runId: string) => void>(() => undefined)
  const inFlightEnhancementsRef = useRef(new Set<string>())
  const originalImageInfoRef = useRef(new WeakMap<ReaderImageElement, OriginalImageInfo>())
  const enhancedImageCacheRef = useRef(new Map<string, string>())
  const enhancedImageCacheOrderRef = useRef<string[]>([])
  const zoomedImageRef = useRef<ZoomedImageState | null>(null)
  const currentBookId = book?.id

  const visibleImageSpreadItems = useMemo(
    () => imageSpreadManifest.slice(imageSpreadIndex, imageSpreadIndex + imageSpreadPageCount),
    [imageSpreadIndex, imageSpreadManifest, imageSpreadPageCount],
  )

  const currentEngineStatus = useMemo(
    () => engineStatuses.find((status) => status.id === preferredEngine),
    [engineStatuses, preferredEngine],
  )

  const setReaderNavigationReady = useCallback((ready: boolean) => {
    canNavigateReaderRef.current = ready
    setReaderInteractionReady(ready)
  }, [])

  useEffect(() => {
    readerModeRef.current = readerMode
  }, [readerMode])

  useEffect(() => {
    imageSpreadManifestRef.current = imageSpreadManifest
  }, [imageSpreadManifest])

  useEffect(() => {
    imageSpreadIndexRef.current = imageSpreadIndex
  }, [imageSpreadIndex])

  useEffect(() => {
    imageSpreadPageCountRef.current = imageSpreadPageCount
  }, [imageSpreadPageCount])

  const autoEnhanceSettingsRef = useRef<AutoEnhanceSettings>({
    autoEnhanceZoomedImage,
    autoEnhanceVisibleImages,
    engineReady: Boolean(currentEngineStatus?.ready),
    enhancementEnabled,
    precomputeBookImages,
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
      'html.prismpage-image-page, body.prismpage-image-page': {
        background: 'transparent !important',
        height: '100% !important',
        margin: '0 !important',
        overflow: 'hidden !important',
        padding: '0 !important',
        width: '100% !important',
      },
      'html.prismpage-image-page body': {
        'align-items': 'center !important',
        display: 'flex !important',
        'justify-content': 'center !important',
        'min-height': '100vh !important',
        overflow: 'hidden !important',
      },
      'html.prismpage-image-page body > *': {
        'max-height': '100vh !important',
        'max-width': '100vw !important',
      },
      img: {
        cursor: 'zoom-in',
        margin: '0 auto',
        'max-height': '100vh',
        'object-fit': 'contain',
      },
      'html.prismpage-image-page img, html.prismpage-image-page svg': {
        display: 'block !important',
        height: 'auto !important',
        margin: 'auto !important',
        'max-height': '100vh !important',
        'max-width': '100vw !important',
        'object-fit': 'contain !important',
        width: 'auto !important',
      },
    })
  }, [fontScale, lineHeight])

  const buildReaderSessionId = useCallback((sessionId: number, targetBookId: string) => {
    return `${readerInstanceIdRef.current}:${targetBookId}:${sessionId}`
  }, [])

  const buildBookEnhancementRunId = useCallback(
    (readerSessionId: string, engineId: EngineId, scale: number) => {
      return `${readerSessionId}:book-enhance:${engineId}:x${scale}:${createClientId('run')}`
    },
    [],
  )

  const cancelEnhancementsForGroup = useCallback((enhancementGroupId: string | null) => {
    if (!enhancementGroupId) {
      return
    }

    void cancelEnhancementJobs(enhancementGroupId).catch(() => undefined)
  }, [])

  const isCurrentReaderSession = useCallback((sessionId: number, targetBookId: string) => {
    return readerSessionRef.current === sessionId && activeBookIdRef.current === targetBookId
  }, [])

  const isCurrentReaderSessionKey = useCallback(
    (sessionId: number, targetBookId: string, readerSessionId: string) => {
      return (
        isCurrentReaderSession(sessionId, targetBookId) &&
        currentReaderSessionIdRef.current === readerSessionId
      )
    },
    [isCurrentReaderSession],
  )

  const setAutoEnhanceStatusForSession = useCallback(
    (sessionId: number, targetBookId: string, status: AutoEnhanceStatus) => {
      if (isCurrentReaderSession(sessionId, targetBookId)) {
        setAutoEnhanceStatus(status)
      }
    },
    [isCurrentReaderSession],
  )

  const resetBookEnhancementState = useCallback(() => {
    bookImageManifestRef.current = []
    bookImageByHashRef.current = new Map<string, ScannedBookImage>()
    bookImageCachedHashesRef.current = new Set<string>()
    bookImageFailedHashesRef.current = new Set<string>()
    bookImageQueuedHashesRef.current = new Set<string>()
    bookImageQueueRef.current = []
    inFlightEnhancementsRef.current.clear()
    enhancedImageCacheRef.current.clear()
    enhancedImageCacheOrderRef.current = []
    bookImageScanTokenRef.current += 1
  }, [])

  const clearPendingImageClickNavigation = useCallback(() => {
    if (pendingImageClickNavigationRef.current !== undefined) {
      window.clearTimeout(pendingImageClickNavigationRef.current)
      pendingImageClickNavigationRef.current = undefined
    }
  }, [])

  const clearReaderUiRevealTimer = useCallback(() => {
    if (readerUiRevealTimerRef.current !== undefined) {
      window.clearTimeout(readerUiRevealTimerRef.current)
      readerUiRevealTimerRef.current = undefined
    }
  }, [])

  const revealReaderUiTemporarily = useCallback(
    (durationMs = 1400) => {
      clearReaderUiRevealTimer()
      setIsReaderUiActive(true)
      readerUiRevealTimerRef.current = window.setTimeout(() => {
        readerUiRevealTimerRef.current = undefined
        setIsReaderUiActive(false)
      }, durationMs)
    },
    [clearReaderUiRevealTimer],
  )

  const cleanupReaderDocuments = useCallback(() => {
    for (const cleanup of documentActivityCleanupRef.current.values()) {
      cleanup()
    }

    documentActivityCleanupRef.current.clear()
    currentReaderDocumentsRef.current.clear()
  }, [])

  const pruneReaderDocuments = useCallback(() => {
    for (const document of Array.from(currentReaderDocumentsRef.current)) {
      if (isReaderDocumentConnected(document)) {
        continue
      }

      documentActivityCleanupRef.current.get(document)?.()
      documentActivityCleanupRef.current.delete(document)
      currentReaderDocumentsRef.current.delete(document)
    }
  }, [])

  const getActiveReaderDocuments = useCallback(() => {
    pruneReaderDocuments()

    const documents = new Set<Document>()

    for (const document of currentReaderDocumentsRef.current) {
      if (isReaderDocumentConnected(document)) {
        documents.add(document)
      }
    }

    const rendition = renditionRef.current
    if (rendition?.getContents) {
      try {
        for (const document of getDocumentsFromContents(rendition.getContents())) {
          if (isReaderDocumentConnected(document)) {
            documents.add(document)
          }
        }
      } catch {
        // epub.js can briefly reject content reads while views are being replaced.
      }
    }

    return Array.from(documents)
  }, [pruneReaderDocuments])

  const rememberEnhancedImageDataUrl = useCallback((cacheKey: string, dataUrl: string) => {
    enhancedImageCacheRef.current.set(cacheKey, dataUrl)
    enhancedImageCacheOrderRef.current = [
      cacheKey,
      ...enhancedImageCacheOrderRef.current.filter((key) => key !== cacheKey),
    ].slice(0, ENHANCED_IMAGE_MEMORY_CACHE_LIMIT)

    for (const key of Array.from(enhancedImageCacheRef.current.keys())) {
      if (!enhancedImageCacheOrderRef.current.includes(key)) {
        enhancedImageCacheRef.current.delete(key)
      }
    }
  }, [])

  const prepareOriginalImageInfo = useCallback(async (image: ReaderImageElement) => {
    const existingInfo = originalImageInfoRef.current.get(image)

    if (existingInfo) {
      return existingInfo
    }

    const blob = await imageElementToBlob(image)
    const imageHash = await hashArrayBuffer(await blob.arrayBuffer())
    const dataUrl = await blobToDataUrl(blob)
    const originalInfo = { dataUrl, imageHash }
    originalImageInfoRef.current.set(image, originalInfo)
    setImageDataAttribute(image, 'prismpageOriginalHash', imageHash)

    return originalInfo
  }, [])

  const readEnhancedImageForDisplay = useCallback(
    async (targetBookId: string, engineId: EngineId, scale: number, imageHash: string) => {
      const cacheKey = buildEnhanceKey(imageHash, engineId, scale)
      const memoryCached = enhancedImageCacheRef.current.get(cacheKey)

      if (memoryCached) {
        bookImageCachedHashesRef.current.add(imageHash)
        return memoryCached
      }

      const dataUrl = await readEnhancedBookImage({
        bookId: targetBookId,
        engineId,
        imageHash,
        scale,
      })

      if (dataUrl) {
        rememberEnhancedImageDataUrl(cacheKey, dataUrl)
        bookImageCachedHashesRef.current.add(imageHash)
      }

      return dataUrl
    },
    [rememberEnhancedImageDataUrl],
  )

  const applyCachedEnhancedImageToImageSpreadHash = useCallback(
    async (
      targetBookId: string,
      engineId: EngineId,
      scale: number,
      imageHash: string,
    ) => {
      const settings = autoEnhanceSettingsRef.current

      if (readerModeRef.current !== 'image-spread' || !settings.autoEnhanceVisibleImages) {
        return false
      }

      const sessionId = readerSessionRef.current
      const readerSessionId = currentReaderSessionIdRef.current

      if (!readerSessionId || !isCurrentReaderSessionKey(sessionId, targetBookId, readerSessionId)) {
        return false
      }

      const dataUrl = await readEnhancedImageForDisplay(targetBookId, engineId, scale, imageHash)

      if (
        !dataUrl ||
        !isCurrentReaderSessionKey(sessionId, targetBookId, readerSessionId)
      ) {
        return false
      }

      setEnhancedImageSpreadDataUrls((current) => {
        if (current[imageHash] === dataUrl) {
          return current
        }

        return {
          ...current,
          [imageHash]: dataUrl,
        }
      })
      setImageSpreadLoadErrors((current) => {
        if (!current[imageHash]) {
          return current
        }

        const next = { ...current }
        delete next[imageHash]
        return next
      })
      setZoomedImage((current) =>
        current?.bookId === targetBookId && current.imageHash === imageHash
          ? { ...current, enhancedDataUrl: dataUrl }
          : current,
      )

      return true
    },
    [isCurrentReaderSessionKey, readEnhancedImageForDisplay],
  )

  const applyCachedEnhancedImageToVisibleHash = useCallback(
    async (
      targetBookId: string,
      engineId: EngineId,
      scale: number,
      imageHash: string,
      runId: string,
    ) => {
      const sessionId = readerSessionRef.current
      const readerSessionId = currentReaderSessionIdRef.current
      const documents = getActiveReaderDocuments()
      const renderToken = currentRenderTokenRef.current
      const settings = autoEnhanceSettingsRef.current

      if (
        !readerSessionId ||
        currentEnhancementGroupIdRef.current !== runId
      ) {
        return false
      }

      if (!settings.autoEnhanceVisibleImages) {
        return false
      }

      const spreadApplied = await applyCachedEnhancedImageToImageSpreadHash(
        targetBookId,
        engineId,
        scale,
        imageHash,
      )

      if (documents.length === 0) {
        return spreadApplied
      }

      const matches: Array<{ image: ReaderImageElement; originalInfo: OriginalImageInfo }> = []

      for (const document of documents) {
        for (const image of getReaderImageElements(document).filter(isVisibleImage)) {
          const originalInfo = await prepareOriginalImageInfo(image)

          if (
            !isCurrentReaderSessionKey(sessionId, targetBookId, readerSessionId) ||
            currentEnhancementGroupIdRef.current !== runId ||
            renderToken !== currentRenderTokenRef.current
          ) {
            return false
          }

          if (originalInfo.imageHash === imageHash) {
            matches.push({ image, originalInfo })
          }
        }
      }

      if (matches.length === 0) {
        return spreadApplied
      }

      const dataUrl = await readEnhancedImageForDisplay(targetBookId, engineId, scale, imageHash)

      if (
        !dataUrl ||
        !isCurrentReaderSessionKey(sessionId, targetBookId, readerSessionId) ||
        currentEnhancementGroupIdRef.current !== runId ||
        renderToken !== currentRenderTokenRef.current
      ) {
        return false
      }

      const cacheKey = buildEnhanceKey(imageHash, engineId, scale)
      let applied = false

      for (const { image, originalInfo } of matches) {
        if (!image.isConnected || getImageDataAttribute(image, 'prismpageEnhancedKey') === cacheKey) {
          continue
        }

        applyEnhancedImage(
          image,
          dataUrl,
          originalInfo,
          originalImageInfoRef.current,
          cacheKey,
        )
        applied = true
      }

      if (applied) {
        setZoomedImage((current) =>
          current?.bookId === targetBookId && current.imageHash === imageHash
            ? { ...current, enhancedDataUrl: dataUrl }
            : current,
        )
      }

      return applied || spreadApplied
    },
    [
      applyCachedEnhancedImageToImageSpreadHash,
      getActiveReaderDocuments,
      isCurrentReaderSessionKey,
      prepareOriginalImageInfo,
      readEnhancedImageForDisplay,
    ],
  )

  const enqueueBookImage = useCallback((image: ScannedBookImage, priority: 'visible' | 'precompute') => {
    const settings = autoEnhanceSettingsRef.current
    const cacheKey = buildEnhanceKey(image.imageHash, settings.preferredEngine, settings.zoomEnhancementScale)

    if (
      bookImageCachedHashesRef.current.has(image.imageHash) ||
      bookImageFailedHashesRef.current.has(image.imageHash) ||
      inFlightEnhancementsRef.current.has(cacheKey)
    ) {
      return false
    }

    if (bookImageQueuedHashesRef.current.has(image.imageHash)) {
      if (priority === 'visible') {
        bookImageQueueRef.current = bookImageQueueRef.current.filter(
          (item) => item.image.imageHash !== image.imageHash,
        )
        bookImageQueueRef.current.unshift({ image, priority })
        return true
      }

      return false
    }

    if (priority === 'visible') {
      bookImageQueueRef.current = bookImageQueueRef.current.filter(
        (item) => item.image.imageHash !== image.imageHash,
      )
      bookImageQueueRef.current.unshift({ image, priority })
    } else {
      bookImageQueueRef.current.push({ image, priority })
    }

    bookImageQueuedHashesRef.current.add(image.imageHash)
    return true
  }, [])

  const waitForReaderIdle = useCallback(async (runId: string) => {
    while (mountedRef.current && currentEnhancementGroupIdRef.current === runId) {
      const elapsedMs = Date.now() - lastReaderActivityAtRef.current
      const waitMs = AUTO_ENHANCE_IDLE_DELAY_MS - elapsedMs

      if (waitMs <= 0) {
        return true
      }

      await delay(waitMs)
    }

    return false
  }, [])

  const processBookImageQueue = useCallback(
    async (runId: string) => {
      const sessionId = readerSessionRef.current
      const targetBookId = activeBookIdRef.current
      const readerSessionId = currentReaderSessionIdRef.current

      if (!targetBookId || !readerSessionId || bookImageProcessingRunIdRef.current === runId) {
        return
      }

      const isCurrentRun = () =>
        mountedRef.current &&
        isCurrentReaderSessionKey(sessionId, targetBookId, readerSessionId) &&
        currentEnhancementGroupIdRef.current === runId

      if (!isCurrentRun()) {
        return
      }

      bookImageProcessingRunIdRef.current = runId

      try {
        while (bookImageQueueRef.current.length > 0 && isCurrentRun()) {
          const queueItem = bookImageQueueRef.current.shift()

          if (!queueItem) {
            continue
          }

          const { image, priority } = queueItem
          const settings = autoEnhanceSettingsRef.current
          bookImageQueuedHashesRef.current.delete(image.imageHash)

          if (!settings.enhancementEnabled) {
            setAutoEnhanceStatusForSession(sessionId, targetBookId, {
              message: 'AI 高精細化はオフです。',
              tone: 'idle',
            })
            break
          }

          if (!settings.engineReady) {
            setAutoEnhanceStatusForSession(sessionId, targetBookId, {
              message: 'AI エンジン未登録のため元画像で表示しています。',
              tone: 'warning',
            })
            break
          }

          if (priority === 'precompute' && !settings.precomputeBookImages) {
            continue
          }

          if (bookImageFailedHashesRef.current.has(image.imageHash)) {
            continue
          }

          const cacheKey = buildEnhanceKey(
            image.imageHash,
            settings.preferredEngine,
            settings.zoomEnhancementScale,
          )

          if (inFlightEnhancementsRef.current.has(cacheKey)) {
            continue
          }

          const isIdle = await waitForReaderIdle(runId)
          if (!isIdle || !isCurrentRun()) {
            break
          }

          inFlightEnhancementsRef.current.add(cacheKey)
          setAutoEnhanceStatusForSession(sessionId, targetBookId, {
            message: `バックグラウンド処理中 ${getEngineLabel(settings.preferredEngine)} x${settings.zoomEnhancementScale}`,
            tone: 'working',
          })

          try {
            const response = await enhanceBookAssetImage({
              bookId: targetBookId,
              engineId: settings.preferredEngine,
              assetPath: image.assetPath,
              imageHash: image.imageHash,
              jobId: createClientId('book-enhance'),
              readerSessionId: runId,
              scale: settings.zoomEnhancementScale,
            })

            if (!isCurrentRun()) {
              break
            }

            bookImageCachedHashesRef.current.add(response.imageHash)
            await applyCachedEnhancedImageToVisibleHash(
              targetBookId,
              settings.preferredEngine,
              settings.zoomEnhancementScale,
              response.imageHash,
              runId,
            )

            setAutoEnhanceStatusForSession(sessionId, targetBookId, {
              message: response.cacheHit ? 'キャッシュを確認しました。' : '1枚をキャッシュしました。',
              tone: 'ready',
            })
          } catch (enhanceError) {
            if (!isCurrentRun()) {
              break
            }

            bookImageFailedHashesRef.current.add(image.imageHash)
            setAutoEnhanceStatusForSession(sessionId, targetBookId, {
              message:
                enhanceError instanceof Error
                  ? `バックグラウンド処理をスキップしました: ${enhanceError.message}`
                  : 'バックグラウンド処理をスキップしました。元画像で表示しています。',
              tone: 'warning',
            })
          } finally {
            inFlightEnhancementsRef.current.delete(cacheKey)
          }
        }

        if (isCurrentRun() && bookImageQueueRef.current.length === 0) {
          const totalImages = bookImageManifestRef.current.length
          const cachedImages = bookImageCachedHashesRef.current.size
          setAutoEnhanceStatusForSession(sessionId, targetBookId, {
            message:
              totalImages > 0
                ? `元画像表示。キャッシュ ${Math.min(cachedImages, totalImages)}/${totalImages}`
                : '元画像を表示しています。',
            tone: cachedImages > 0 ? 'ready' : 'idle',
          })
        }
      } finally {
        if (bookImageProcessingRunIdRef.current === runId) {
          bookImageProcessingRunIdRef.current = null
        }
      }
    },
    [
      applyCachedEnhancedImageToVisibleHash,
      isCurrentReaderSessionKey,
      setAutoEnhanceStatusForSession,
      waitForReaderIdle,
    ],
  )

  useEffect(() => {
    processBookImageQueueRef.current = (runId: string) => {
      void processBookImageQueue(runId)
    }
  }, [processBookImageQueue])

  const refreshVisibleImages = useCallback(async () => {
    const sessionId = readerSessionRef.current
    const targetBookId = activeBookIdRef.current
    const readerSessionId = currentReaderSessionIdRef.current
    const runId = currentEnhancementGroupIdRef.current
    const documents = getActiveReaderDocuments()
    const renderToken = currentRenderTokenRef.current
    const settings = autoEnhanceSettingsRef.current

    if (!targetBookId || !readerSessionId || !runId || documents.length === 0) {
      return
    }

    if (!settings.enhancementEnabled) {
      setAutoEnhanceStatusForSession(sessionId, targetBookId, {
        message: 'AI 高精細化はオフです。',
        tone: 'idle',
      })
      return
    }

    if (!settings.engineReady) {
      setAutoEnhanceStatusForSession(sessionId, targetBookId, {
        message: 'AI エンジン未登録のため元画像で表示しています。',
        tone: 'warning',
      })
      return
    }

    const visibleImages = documents.flatMap((document) =>
      getReaderImageElements(document).filter(isVisibleImage),
    )

    if (visibleImages.length === 0) {
      setAutoEnhanceStatusForSession(sessionId, targetBookId, {
        message: '元画像を表示しています。',
        tone: 'idle',
      })
      return
    }

    let applied = false
    let queued = false

    for (const image of visibleImages) {
      const originalInfo = await prepareOriginalImageInfo(image)

      if (
        !isCurrentReaderSessionKey(sessionId, targetBookId, readerSessionId) ||
        currentEnhancementGroupIdRef.current !== runId ||
        renderToken !== currentRenderTokenRef.current
      ) {
        return
      }

      const cacheKey = buildEnhanceKey(
        originalInfo.imageHash,
        settings.preferredEngine,
        settings.zoomEnhancementScale,
      )

      if (getImageDataAttribute(image, 'prismpageEnhancedKey') === cacheKey) {
        continue
      }

      const cachedDataUrl = settings.autoEnhanceVisibleImages
        ? await readEnhancedImageForDisplay(
            targetBookId,
            settings.preferredEngine,
            settings.zoomEnhancementScale,
            originalInfo.imageHash,
          )
        : null

      if (
        !isCurrentReaderSessionKey(sessionId, targetBookId, readerSessionId) ||
        currentEnhancementGroupIdRef.current !== runId ||
        renderToken !== currentRenderTokenRef.current
      ) {
        return
      }

      if (cachedDataUrl) {
        if (settings.autoEnhanceVisibleImages) {
          applyEnhancedImage(
            image,
            cachedDataUrl,
            originalInfo,
            originalImageInfoRef.current,
            cacheKey,
          )
          applied = true
        }
        continue
      }

      const manifestImage = bookImageByHashRef.current.get(originalInfo.imageHash)
      if (
        manifestImage &&
        (settings.precomputeBookImages || settings.autoEnhanceVisibleImages) &&
        enqueueBookImage(manifestImage, 'visible')
      ) {
        queued = true
      }
    }

    if (queued) {
      setAutoEnhanceStatusForSession(sessionId, targetBookId, {
        message: '元画像表示。バックグラウンド処理を待機中。',
        tone: 'working',
      })
      processBookImageQueueRef.current(runId)
      return
    }

    if (applied) {
      setAutoEnhanceStatusForSession(sessionId, targetBookId, {
        message: 'キャッシュ済み画像を差し替えました。',
        tone: 'ready',
      })
      return
    }

    setAutoEnhanceStatusForSession(sessionId, targetBookId, {
      message: settings.autoEnhanceVisibleImages
        ? '元画像表示。キャッシュ待機中。'
        : '元画像のまま表示しています。',
      tone: 'idle',
    })
  }, [
    enqueueBookImage,
    getActiveReaderDocuments,
    isCurrentReaderSessionKey,
    prepareOriginalImageInfo,
    readEnhancedImageForDisplay,
    setAutoEnhanceStatusForSession,
  ])

  const startBookImageScan = useCallback(
    async (
      sessionId: number,
      targetBookId: string,
      readerSessionId: string,
      runId: string,
    ) => {
      const scanToken = ++bookImageScanTokenRef.current
      const settings = autoEnhanceSettingsRef.current

      if (!settings.enhancementEnabled) {
        setAutoEnhanceStatusForSession(sessionId, targetBookId, {
          message: 'AI 高精細化はオフです。',
          tone: 'idle',
        })
        return
      }

      if (!settings.engineReady) {
        setAutoEnhanceStatusForSession(sessionId, targetBookId, {
          message: 'AI エンジン未登録のため元画像で表示しています。',
          tone: 'warning',
        })
        return
      }

      setAutoEnhanceStatusForSession(sessionId, targetBookId, {
        message: '元画像表示。画像を確認中。',
        tone: 'working',
      })

      try {
        const response = await scanBookImages({
          bookId: targetBookId,
          engineId: settings.preferredEngine,
          scale: settings.zoomEnhancementScale,
        })

        if (
          scanToken !== bookImageScanTokenRef.current ||
          !isCurrentReaderSessionKey(sessionId, targetBookId, readerSessionId) ||
          currentEnhancementGroupIdRef.current !== runId
        ) {
          return
        }

        const images = [...response.images].sort((left, right) => {
          if (left.spineIndex !== right.spineIndex) {
            return left.spineIndex - right.spineIndex
          }

          return left.order - right.order
        })
        bookImageManifestRef.current = images
        bookImageByHashRef.current = new Map(images.map((image) => [image.imageHash, image]))
        bookImageCachedHashesRef.current = new Set(
          images.filter((image) => image.cached).map((image) => image.imageHash),
        )

        let queuedVisibleCount = 0
        if (readerModeRef.current === 'image-spread' && settings.autoEnhanceVisibleImages) {
          const visibleImages = images.slice(
            imageSpreadIndexRef.current,
            imageSpreadIndexRef.current + imageSpreadPageCountRef.current,
          )

          for (const image of visibleImages) {
            if (enqueueBookImage(image, 'visible')) {
              queuedVisibleCount += 1
            }
          }
        }

        await refreshVisibleImages()

        if (!settings.precomputeBookImages) {
          setAutoEnhanceStatusForSession(sessionId, targetBookId, {
            message: '元画像表示。開いたページだけ処理します。',
            tone: 'idle',
          })
          if (queuedVisibleCount > 0) {
            processBookImageQueueRef.current(runId)
          }
          return
        }

        let queuedCount = 0
        for (const image of images) {
          if (!image.cached && enqueueBookImage(image, 'precompute')) {
            queuedCount += 1
          }
        }

        setAutoEnhanceStatusForSession(sessionId, targetBookId, {
          message:
            images.length > 0
              ? `元画像表示。キャッシュ ${response.cachedImages}/${response.totalImages}`
              : '元画像を表示しています。',
          tone: queuedCount > 0 ? 'working' : 'ready',
        })

        if (queuedVisibleCount > 0 || queuedCount > 0) {
          processBookImageQueueRef.current(runId)
        }
      } catch {
        if (isCurrentReaderSessionKey(sessionId, targetBookId, readerSessionId)) {
          setAutoEnhanceStatusForSession(sessionId, targetBookId, {
            message: '元画像表示。バックグラウンド処理を開始できません。',
            tone: 'warning',
          })
        }
      }
    },
    [
      enqueueBookImage,
      isCurrentReaderSessionKey,
      refreshVisibleImages,
      setAutoEnhanceStatusForSession,
    ],
  )

  useEffect(() => {
    zoomedImageRef.current = zoomedImage
  }, [zoomedImage])

  const restartIdleAutoEnhanceTimer = useCallback(
    (status?: AutoEnhanceStatus) => {
      const sessionId = readerSessionRef.current
      const targetBookId = activeBookIdRef.current
      const readerSessionId = currentReaderSessionIdRef.current
      const runId = currentEnhancementGroupIdRef.current
      const activityGeneration = idleGenerationRef.current + 1

      idleGenerationRef.current = activityGeneration
      setIdleGenerationSnapshot(activityGeneration)
      lastReaderActivityAtRef.current = Date.now()

      if (idleTimerRef.current !== undefined) {
        window.clearTimeout(idleTimerRef.current)
        idleTimerRef.current = undefined
      }

      if (targetBookId && status) {
        setAutoEnhanceStatusForSession(sessionId, targetBookId, status)
      }

      if (!targetBookId || !readerSessionId || !runId) {
        return
      }

      idleTimerRef.current = window.setTimeout(() => {
        idleTimerRef.current = undefined

        if (
          idleGenerationRef.current !== activityGeneration ||
          !isCurrentReaderSessionKey(sessionId, targetBookId, readerSessionId) ||
          currentEnhancementGroupIdRef.current !== runId
        ) {
          return
        }

        void refreshVisibleImages()
        processBookImageQueueRef.current(runId)
      }, AUTO_ENHANCE_IDLE_DELAY_MS)
    },
    [isCurrentReaderSessionKey, refreshVisibleImages, setAutoEnhanceStatusForSession],
  )

  const handleReaderActivity = useCallback(() => {
    restartIdleAutoEnhanceTimer({
      message: '元画像表示。読書操作を優先中。',
      tone: 'idle',
    })
  }, [restartIdleAutoEnhanceTimer])

  const updateImageSpreadLocation = useCallback(
    (index: number, totalImages = imageSpreadManifestRef.current.length) => {
      if (!currentBookId || totalImages <= 0) {
        return
      }

      const nextLocation = getImageSpreadLocation(index)
      const visibleEnd = Math.min(index + imageSpreadPageCountRef.current, totalImages)
      const nextProgress = Math.round((visibleEnd / totalImages) * 100)

      setLocation(nextLocation)
      setProgress(nextProgress)
      patchBook(currentBookId, {
        currentLocation: nextLocation,
        lastOpenedAt: Date.now(),
        progressPercentage: nextProgress,
      })
    },
    [currentBookId, patchBook],
  )

  const navigateReaderPage = useCallback(
    (direction: ReaderNavigationDirection) => {
      if (!canNavigateReaderRef.current) {
        return false
      }

      if (readerModeRef.current === 'image-spread') {
        const totalImages = imageSpreadManifestRef.current.length

        if (totalImages <= 0) {
          return false
        }

        handleReaderActivity()
        const currentIndex = imageSpreadIndexRef.current
        const step = Math.max(1, imageSpreadPageCountRef.current)
        const nextIndex =
          direction === 'next'
            ? currentIndex + step < totalImages
              ? currentIndex + step
              : 0
            : Math.max(0, currentIndex - step)

        imageSpreadIndexRef.current = nextIndex
        setImageSpreadIndex(nextIndex)
        updateImageSpreadLocation(nextIndex, totalImages)

        return true
      }

      const rendition = renditionRef.current

      if (!rendition) {
        return false
      }

      handleReaderActivity()
      if (direction === 'next' && readerRelocationEdgesRef.current.atEnd) {
        void rendition.display(0)
      } else {
        void (direction === 'next' ? rendition.next() : rendition.prev())
      }

      return true
    },
    [handleReaderActivity, updateImageSpreadLocation],
  )

  const navigateReaderPageFromPoint = useCallback(
    (clientX: number, width: number) => {
      const navigationDirection = getClickNavigationDirection(
        clientX,
        width,
        readerDirectionRef.current,
      )

      return navigateReaderPage(navigationDirection)
    },
    [navigateReaderPage],
  )

  const scheduleImageClickNavigation = useCallback(
    (clientX: number, width: number) => {
      clearPendingImageClickNavigation()
      pendingImageClickNavigationRef.current = window.setTimeout(() => {
        pendingImageClickNavigationRef.current = undefined
        navigateReaderPageFromPoint(clientX, width)
      }, IMAGE_CLICK_NAVIGATION_DELAY_MS)
    },
    [clearPendingImageClickNavigation, navigateReaderPageFromPoint],
  )

  const navigateReaderPageByWheel = useCallback(
    (deltaY: number) => {
      if (Math.abs(deltaY) < 8) {
        return false
      }

      const now = Date.now()
      if (now - lastReaderWheelAtRef.current < READER_WHEEL_THROTTLE_MS) {
        return false
      }

      lastReaderWheelAtRef.current = now
      clearPendingImageClickNavigation()

      return navigateReaderPage(deltaY > 0 ? 'next' : 'prev')
    },
    [clearPendingImageClickNavigation, navigateReaderPage],
  )

  const handleReaderDocumentClick = useCallback(
    (event: MouseEvent) => {
      handleReaderActivity()

      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.detail > 1 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isReaderUiActive ||
        isTocOpen ||
        isReaderInteractiveTarget(event.target)
      ) {
        return
      }

      const selection = event.view?.getSelection()
      if (selection && !selection.isCollapsed) {
        return
      }

      const readerPoint = getReaderRelativePointFromDocumentEvent(event, containerRef.current)

      if (getReaderImageFromTarget(event.target)) {
        scheduleImageClickNavigation(readerPoint.x, readerPoint.width)
        return
      }

      clearPendingImageClickNavigation()
      navigateReaderPageFromPoint(readerPoint.x, readerPoint.width)
    },
    [
      clearPendingImageClickNavigation,
      handleReaderActivity,
      isReaderUiActive,
      isTocOpen,
      navigateReaderPageFromPoint,
      scheduleImageClickNavigation,
    ],
  )

  const handleReaderDocumentWheel = useCallback(
    (event: WheelEvent) => {
      handleReaderActivity()

      if (
        event.defaultPrevented ||
        isReaderInteractiveTarget(event.target) ||
        Math.abs(event.deltaY) <= Math.abs(event.deltaX)
      ) {
        return
      }

      if (navigateReaderPageByWheel(event.deltaY)) {
        event.preventDefault()
      }
    },
    [handleReaderActivity, navigateReaderPageByWheel],
  )

  const handleReaderDocumentPointerDown = useCallback(
    (event: PointerEvent) => {
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') {
        return
      }

      const readerPoint = getReaderRelativePointFromDocumentEvent(event, containerRef.current)

      revealReaderUiTemporarily(isReaderPointNearEdge(readerPoint) ? 1800 : 900)
    },
    [revealReaderUiTemporarily],
  )

  const handleReaderDocumentMouseMove = useCallback(
    (event: MouseEvent) => {
      const readerPoint = getReaderRelativePointFromDocumentEvent(event, containerRef.current)

      clearReaderUiRevealTimer()
      setIsReaderUiActive(isReaderPointNearEdge(readerPoint))
    },
    [clearReaderUiRevealTimer],
  )

  const handleReaderDocumentPointerMove = useCallback(
    (event: PointerEvent) => {
      const readerPoint = getReaderRelativePointFromDocumentEvent(event, containerRef.current)

      if (event.pointerType === 'mouse') {
        clearReaderUiRevealTimer()
        setIsReaderUiActive(isReaderPointNearEdge(readerPoint))
        return
      }

      if (isReaderPointNearEdge(readerPoint)) {
        revealReaderUiTemporarily(1400)
      }
    },
    [clearReaderUiRevealTimer, revealReaderUiTemporarily],
  )

  const handleReaderStageClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.detail > 1 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isReaderUiActive ||
        isTocOpen ||
        isReaderInteractiveTarget(event.target)
      ) {
        return
      }

      const selection = window.getSelection()
      if (selection && !selection.isCollapsed) {
        return
      }

      clearPendingImageClickNavigation()
      const rect = event.currentTarget.getBoundingClientRect()
      const readerX = event.clientX - rect.left

      if (getReaderImageFromTarget(event.target)) {
        scheduleImageClickNavigation(readerX, rect.width)
        return
      }

      navigateReaderPageFromPoint(readerX, rect.width)
    },
    [
      clearPendingImageClickNavigation,
      isReaderUiActive,
      isTocOpen,
      navigateReaderPageFromPoint,
      scheduleImageClickNavigation,
    ],
  )

  const handleReaderStageWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (
        event.defaultPrevented ||
        isReaderInteractiveTarget(event.target) ||
        Math.abs(event.deltaY) <= Math.abs(event.deltaX)
      ) {
        return
      }

      if (navigateReaderPageByWheel(event.deltaY)) {
        event.preventDefault()
      }
    },
    [navigateReaderPageByWheel],
  )

  const handleReaderEdgeZoneClick = useCallback(
    (event: ReactMouseEvent<HTMLSpanElement>) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.detail > 1 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        isTocOpen
      ) {
        return
      }

      const shell = event.currentTarget.closest('.reader-focus-shell')
      if (!(shell instanceof HTMLElement)) {
        return
      }

      const rect = shell.getBoundingClientRect()
      event.preventDefault()
      event.stopPropagation()
      clearPendingImageClickNavigation()
      navigateReaderPageFromPoint(event.clientX - rect.left, rect.width)
    },
    [clearPendingImageClickNavigation, isTocOpen, navigateReaderPageFromPoint],
  )

  const handleReaderEdgeZoneWheel = useCallback(
    (event: ReactWheelEvent<HTMLSpanElement>) => {
      if (
        event.defaultPrevented ||
        isTocOpen ||
        Math.abs(event.deltaY) <= Math.abs(event.deltaX)
      ) {
        return
      }

      if (navigateReaderPageByWheel(event.deltaY)) {
        event.preventDefault()
        event.stopPropagation()
      }
    },
    [isTocOpen, navigateReaderPageByWheel],
  )

  const isReaderPointerNearEdge = useCallback((event: {
    clientX: number
    clientY: number
    currentTarget: HTMLElement
  }) => {
    const rect = event.currentTarget.getBoundingClientRect()

    return (
      event.clientY - rect.top <= READER_EDGE_REVEAL_PX ||
      rect.bottom - event.clientY <= READER_EDGE_REVEAL_PX ||
      event.clientX - rect.left <= READER_EDGE_REVEAL_PX ||
      rect.right - event.clientX <= READER_EDGE_REVEAL_PX
    )
  }, [])

  const handleReaderShellMouseMove = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    clearReaderUiRevealTimer()
    setIsReaderUiActive(isReaderPointerNearEdge(event))
  }, [clearReaderUiRevealTimer, isReaderPointerNearEdge])

  const handleReaderShellPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType !== 'mouse' && isReaderPointerNearEdge(event)) {
      revealReaderUiTemporarily()
    }
  }, [isReaderPointerNearEdge, revealReaderUiTemporarily])

  const handleReaderShellPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const nearEdge =
      isReaderPointerNearEdge(event) || event.pointerType === 'touch' || event.pointerType === 'pen'

    if (nearEdge) {
      revealReaderUiTemporarily()
    }
  }, [isReaderPointerNearEdge, revealReaderUiTemporarily])

  const bindDocumentActivityListeners = useCallback(
    (document: Document) => {
      const view = document.defaultView
      const listenerOptions = { capture: true }
      const wheelListenerOptions = { capture: true, passive: false }

      document.addEventListener('click', handleReaderDocumentClick, listenerOptions)
      document.addEventListener('keydown', handleReaderActivity, listenerOptions)
      document.addEventListener('mousemove', handleReaderDocumentMouseMove, listenerOptions)
      document.addEventListener('pointerdown', handleReaderDocumentPointerDown, listenerOptions)
      document.addEventListener('pointermove', handleReaderDocumentPointerMove, listenerOptions)
      document.addEventListener('wheel', handleReaderDocumentWheel, wheelListenerOptions)
      view?.addEventListener('scroll', handleReaderActivity, listenerOptions)

      return () => {
        document.removeEventListener('click', handleReaderDocumentClick, listenerOptions)
        document.removeEventListener('keydown', handleReaderActivity, listenerOptions)
        document.removeEventListener('mousemove', handleReaderDocumentMouseMove, listenerOptions)
        document.removeEventListener('pointerdown', handleReaderDocumentPointerDown, listenerOptions)
        document.removeEventListener('pointermove', handleReaderDocumentPointerMove, listenerOptions)
        document.removeEventListener('wheel', handleReaderDocumentWheel, wheelListenerOptions)
        view?.removeEventListener('scroll', handleReaderActivity, listenerOptions)
      }
    },
    [
      handleReaderActivity,
      handleReaderDocumentClick,
      handleReaderDocumentMouseMove,
      handleReaderDocumentPointerDown,
      handleReaderDocumentPointerMove,
      handleReaderDocumentWheel,
    ],
  )

  const openZoomedImage = useCallback(async (image: ReaderImageElement) => {
    const sessionId = readerSessionRef.current
    const targetBookId = activeBookIdRef.current
    const readerSessionId = currentReaderSessionIdRef.current

    if (!targetBookId || !readerSessionId) {
      return
    }

    try {
      const originalInfo = await prepareOriginalImageInfo(image)

      if (!isCurrentReaderSessionKey(sessionId, targetBookId, readerSessionId)) {
        return
      }

      const settings = autoEnhanceSettingsRef.current
      const enhancedDataUrl = await readEnhancedImageForDisplay(
        targetBookId,
        settings.preferredEngine,
        settings.zoomEnhancementScale,
        originalInfo.imageHash,
      )

      if (!isCurrentReaderSessionKey(sessionId, targetBookId, readerSessionId)) {
        return
      }

      setZoomedImage({
        bookId: targetBookId,
        caption: getImageCaption(image),
        enhancedDataUrl: enhancedDataUrl ?? undefined,
        imageHash: originalInfo.imageHash,
        originalDataUrl: originalInfo.dataUrl,
        readerSessionId,
        sessionId,
      })
    } catch {
      if (isCurrentReaderSessionKey(sessionId, targetBookId, readerSessionId)) {
        setError('拡大画像の読み込みに失敗しました。')
      }
    }
  }, [isCurrentReaderSessionKey, prepareOriginalImageInfo, readEnhancedImageForDisplay])

  const registerReaderDocument = useCallback(
    (document: Document) => {
      pruneReaderDocuments()
      currentReaderDocumentsRef.current.add(document)

      if (!documentActivityCleanupRef.current.has(document)) {
        documentActivityCleanupRef.current.set(document, bindDocumentActivityListeners(document))
      }

      applyImagePageClass(document)

      const images = getReaderImageElements(document)

      for (const image of images) {
        if (getImageDataAttribute(image, 'prismpageClickBound') === 'true') {
          continue
        }

        setImageDataAttribute(image, 'prismpageClickBound', 'true')
        image.addEventListener('load', () => applyImagePageClass(document), {
          once: true,
        })
        image.addEventListener('dblclick', (event) => {
          event.preventDefault()
          event.stopPropagation()
          clearPendingImageClickNavigation()
          handleReaderActivity()
          void openZoomedImage(image)
        })
      }
    },
    [
      bindDocumentActivityListeners,
      clearPendingImageClickNavigation,
      handleReaderActivity,
      openZoomedImage,
      pruneReaderDocuments,
    ],
  )

  useEffect(() => {
    autoEnhanceSettingsRef.current = {
      autoEnhanceZoomedImage,
      autoEnhanceVisibleImages,
      engineReady: Boolean(currentEngineStatus?.ready),
      enhancementEnabled,
      precomputeBookImages,
      preferredEngine,
      zoomEnhancementScale,
    }
  }, [
    autoEnhanceVisibleImages,
    autoEnhanceZoomedImage,
    currentEngineStatus?.ready,
    enhancementEnabled,
    precomputeBookImages,
    preferredEngine,
    zoomEnhancementScale,
  ])

  useEffect(() => {
    if (!currentBookId || !readerReady) {
      return undefined
    }

    const sessionId = readerSessionRef.current
    const readerSessionId = currentReaderSessionIdRef.current

    if (!readerSessionId || !isCurrentReaderSession(sessionId, currentBookId)) {
      return undefined
    }

    const settings = autoEnhanceSettingsRef.current
    const runId = buildBookEnhancementRunId(
      readerSessionId,
      settings.preferredEngine,
      settings.zoomEnhancementScale,
    )

    currentEnhancementGroupIdRef.current = runId
    resetBookEnhancementState()
    setAutoEnhanceStatusForSession(sessionId, currentBookId, {
      message: settings.enhancementEnabled
        ? '元画像表示。バックグラウンド準備中。'
        : 'AI 高精細化はオフです。',
      tone: settings.enhancementEnabled ? 'working' : 'idle',
    })

    void startBookImageScan(sessionId, currentBookId, readerSessionId, runId)

    return () => {
      if (currentEnhancementGroupIdRef.current === runId) {
        currentEnhancementGroupIdRef.current = null
      }
      cancelEnhancementsForGroup(runId)
    }
  }, [
    currentBookId,
    currentEngineStatus?.ready,
    enhancementEnabled,
    precomputeBookImages,
    preferredEngine,
    readerReady,
    zoomEnhancementScale,
    buildBookEnhancementRunId,
    cancelEnhancementsForGroup,
    isCurrentReaderSession,
    resetBookEnhancementState,
    setAutoEnhanceStatusForSession,
    startBookImageScan,
  ])

  useEffect(() => {
    if (!currentBookId || !readerReady) {
      return
    }

    if (autoEnhanceVisibleImages) {
      void refreshVisibleImages()
      return
    }

    const sessionId = readerSessionRef.current
    setAutoEnhanceStatusForSession(sessionId, currentBookId, {
      message: '元画像のまま表示しています。',
      tone: 'idle',
    })
  }, [
    autoEnhanceVisibleImages,
    currentBookId,
    readerReady,
    refreshVisibleImages,
    setAutoEnhanceStatusForSession,
  ])

  useEffect(() => {
    if (!currentBookId || !readerReady || readerMode !== 'image-spread') {
      return
    }

    if (visibleImageSpreadItems.length === 0) {
      if (imageSpreadManifest.length > 0 && imageSpreadIndex !== 0) {
        imageSpreadIndexRef.current = 0
        window.queueMicrotask(() => {
          if (readerModeRef.current === 'image-spread') {
            setImageSpreadIndex(0)
          }
        })
      }
      return
    }

    const sessionId = readerSessionRef.current
    const readerSessionId = currentReaderSessionIdRef.current
    const settings = autoEnhanceSettingsRef.current
    const runId = currentEnhancementGroupIdRef.current

    currentRenderTokenRef.current += 1
    updateImageSpreadLocation(imageSpreadIndex, imageSpreadManifest.length)

    for (const image of visibleImageSpreadItems) {
      void (async () => {
        const isCurrentImageSpreadLoad = () =>
          Boolean(readerSessionId) &&
          isCurrentReaderSessionKey(sessionId, currentBookId, readerSessionId ?? '')

        const imageHash = image.imageHash
        const cacheKey = buildEnhanceKey(
          imageHash,
          settings.preferredEngine,
          settings.zoomEnhancementScale,
        )
        const shouldReadEnhanced =
          settings.enhancementEnabled &&
          settings.autoEnhanceVisibleImages &&
          !enhancedImageSpreadDataUrls[imageHash] &&
          !imageSpreadEnhancedCacheChecksRef.current.has(cacheKey)
        const shouldReadOriginal =
          !imageAssetDataUrls[imageHash] &&
          !imageSpreadLoadErrors[imageHash]

        if (shouldReadEnhanced) {
          imageSpreadEnhancedCacheChecksRef.current.add(cacheKey)
        }

        const enhancedDataUrlPromise = shouldReadEnhanced
          ? readEnhancedImageForDisplay(
              currentBookId,
              settings.preferredEngine,
              settings.zoomEnhancementScale,
              imageHash,
            ).catch(() => null)
          : Promise.resolve<string | null>(null)
        const originalImagePromise = shouldReadOriginal
          ? readBookAssetImage({
              bookId: currentBookId,
              assetPath: image.assetPath,
            })
              .then((original) => original.imageDataUrl)
              .catch((assetError) => {
                if (enhancedImageSpreadDataUrls[imageHash]) {
                  return null
                }

                throw assetError
              })
          : Promise.resolve<string | null>(null)

        const [enhancedResult, originalResult] = await Promise.allSettled([
          enhancedDataUrlPromise,
          originalImagePromise,
        ])

        if (!isCurrentImageSpreadLoad()) {
          return
        }

        const hasEnhancedDataUrl =
          enhancedResult.status === 'fulfilled' && Boolean(enhancedResult.value)
        const hasKnownEnhancedDataUrl =
          hasEnhancedDataUrl || Boolean(enhancedImageSpreadDataUrls[imageHash])

        if (enhancedResult.status === 'fulfilled' && enhancedResult.value) {
          const enhancedDataUrl = enhancedResult.value

          setEnhancedImageSpreadDataUrls((current) => ({
            ...current,
            [imageHash]: enhancedDataUrl,
          }))
          setImageSpreadLoadErrors((current) => {
            if (!current[imageHash]) {
              return current
            }

            const next = { ...current }
            delete next[imageHash]
            return next
          })
        }

        if (originalResult.status === 'fulfilled' && originalResult.value) {
          const originalDataUrl = originalResult.value

          setImageAssetDataUrls((current) => ({
            ...current,
            [imageHash]: originalDataUrl,
          }))
          setImageSpreadLoadErrors((current) => {
            if (!current[imageHash]) {
              return current
            }

            const next = { ...current }
            delete next[imageHash]
            return next
          })
        }

        if (originalResult.status === 'rejected' && !hasKnownEnhancedDataUrl) {
          setImageSpreadLoadErrors((current) => {
            if (current[imageHash]) {
              return current
            }

            const message =
              originalResult.reason instanceof Error
                ? originalResult.reason.message
                : '画像の読み込みに失敗しました。'

            return {
              ...current,
              [imageHash]: message,
            }
          })
        }

        if (
          !hasKnownEnhancedDataUrl &&
          runId &&
          settings.enhancementEnabled &&
          (settings.autoEnhanceVisibleImages || settings.precomputeBookImages) &&
          enqueueBookImage(image, 'visible')
        ) {
          processBookImageQueueRef.current(runId)
        }
      })()
    }

  }, [
    currentBookId,
    enqueueBookImage,
    enhancedImageSpreadDataUrls,
    imageAssetDataUrls,
    imageSpreadIndex,
    imageSpreadLoadErrors,
    imageSpreadManifest.length,
    isCurrentReaderSessionKey,
    readEnhancedImageForDisplay,
    readerMode,
    readerReady,
    updateImageSpreadLocation,
    visibleImageSpreadItems,
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
    const listenerOptions = { capture: true }

    window.addEventListener('click', handleReaderActivity, listenerOptions)
    window.addEventListener('keydown', handleReaderActivity, listenerOptions)
    window.addEventListener('scroll', handleReaderActivity, listenerOptions)

    return () => {
      window.removeEventListener('click', handleReaderActivity, listenerOptions)
      window.removeEventListener('keydown', handleReaderActivity, listenerOptions)
      window.removeEventListener('scroll', handleReaderActivity, listenerOptions)
    }
  }, [handleReaderActivity])

  useEffect(() => {
    if (!currentBookId || !containerRef.current) {
      return
    }

    let relocationHandler: ((locationInfo: EpubLocation) => void) | null = null
    let renderedHandler:
      | ((_section: unknown, contents: { document: Document }) => void)
      | null = null
    let resizeFrameId: number | undefined
    let resizeObserver: ResizeObserver | null = null
    let resizeFallbackHandler: (() => void) | null = null
    const initialLocation = useLibraryStore
      .getState()
      .books.find((entry) => entry.id === currentBookId)?.currentLocation

    mountedRef.current = true
    readerSessionRef.current += 1
    activeBookIdRef.current = currentBookId
    const sessionId = readerSessionRef.current
    const readerSessionId = buildReaderSessionId(sessionId, currentBookId)
    currentReaderSessionIdRef.current = readerSessionId
    currentEnhancementGroupIdRef.current = null
    const isActiveReader = () => isCurrentReaderSession(sessionId, currentBookId)
    setZoomedImage(null)
    setIsEnhancing(false)
    setReaderMode('epub')
    readerModeRef.current = 'epub'
    setReaderDirection('rtl')
    readerDirectionRef.current = 'rtl'
    setImageSpreadManifest([])
    imageSpreadManifestRef.current = []
    setImageAssetDataUrls({})
    setEnhancedImageSpreadDataUrls({})
    setImageSpreadLoadErrors({})
    imageSpreadEnhancedCacheChecksRef.current.clear()
    setImageSpreadIndex(0)
    imageSpreadIndexRef.current = 0
    setImageSpreadPageCount(getImageSpreadPageCount(containerRef.current))
    readerRelocationEdgesRef.current = { atEnd: false, atStart: true }
    cleanupReaderDocuments()
    currentRenderTokenRef.current += 1
    originalImageInfoRef.current = new WeakMap<ReaderImageElement, OriginalImageInfo>()
    resetBookEnhancementState()
    lastReaderActivityAtRef.current = Date.now()
    setReaderReady(false)
    setReaderNavigationReady(false)
    setReaderInitializing(true)

    const loadReader = async () => {
      try {
        if (!isActiveReader()) {
          return
        }

        setReaderInitializing(true)
        setReaderNavigationReady(false)
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

        const metadata = await epubBook.loaded.metadata
        if (!isActiveReader()) {
          epubBook.destroy()
          return
        }

        const readingDirection = getReaderDirection(metadata)
        readerDirectionRef.current = readingDirection
        setReaderDirection(readingDirection)

        const navigation = await epubBook.loaded.navigation
        if (!isActiveReader()) {
          epubBook.destroy()
          return
        }

        setToc(flattenNavigation(navigation.toc as EpubNavigationItem[]))

        let imageSpreadReaderEnabled = false
        try {
          const imageManifestResponse = await scanBookImages({
            bookId: currentBookId,
            engineId: preferredEngine,
            scale: zoomEnhancementScale,
          })

          if (!isActiveReader()) {
            epubBook.destroy()
            return
          }

          const images = [...imageManifestResponse.images].sort((left, right) => {
            if (left.spineIndex !== right.spineIndex) {
              return left.spineIndex - right.spineIndex
            }

            return left.order - right.order
          })

          if (shouldUseImageSpreadReader(images, epubBook)) {
            const initialImageIndex = Math.min(
              parseImageSpreadLocation(initialLocation) ?? 0,
              Math.max(images.length - 1, 0),
            )

            imageSpreadReaderEnabled = true
            readerModeRef.current = 'image-spread'
            setReaderMode('image-spread')
            setImageSpreadManifest(images)
            imageSpreadManifestRef.current = images
            setImageSpreadIndex(initialImageIndex)
            imageSpreadIndexRef.current = initialImageIndex
            setImageSpreadPageCount(getImageSpreadPageCount(containerRef.current))
            bookImageManifestRef.current = images
            bookImageByHashRef.current = new Map(images.map((image) => [image.imageHash, image]))
            bookImageCachedHashesRef.current = new Set(
              images.filter((image) => image.cached).map((image) => image.imageHash),
            )
            updateImageSpreadLocation(initialImageIndex, images.length)
            setReaderReady(true)
            setReaderNavigationReady(true)
            setReaderInitializing(false)
          }
        } catch {
          if (isActiveReader()) {
            setReaderMode('epub')
            readerModeRef.current = 'epub'
          }
        }

        try {
          const rendition = epubBook.renderTo(containerRef.current!, {
            defaultDirection: readingDirection,
            flow: 'paginated',
            height: '100%',
            minSpreadWidth: READER_SPREAD_MIN_WIDTH,
            spread: getReaderSpreadMode(containerRef.current!),
            width: '100%',
          }) as ReaderLayoutRendition

          if (!isActiveReader()) {
            rendition.destroy()
            epubBook.destroy()
            return
          }

          renditionRef.current = rendition
          rendition.direction(readingDirection)
          const syncReaderLayout = () => {
            const element = containerRef.current

            if (!element) {
              return
            }

            const { height, width } = getReaderViewportSize(element)
            if (width <= 0 || height <= 0) {
              return
            }

            rendition.spread(getReaderSpreadMode(element), READER_SPREAD_MIN_WIDTH)
            setImageSpreadPageCount(getImageSpreadPageCount(element))
            resizeReaderRenditionIfReady(rendition, width, height)

            for (const document of getActiveReaderDocuments()) {
              applyImagePageClass(document)
            }
          }
          const scheduleReaderLayoutSync = () => {
            if (resizeFrameId !== undefined) {
              window.cancelAnimationFrame(resizeFrameId)
            }

            resizeFrameId = window.requestAnimationFrame(() => {
              resizeFrameId = undefined
              syncReaderLayout()
            })
          }

          syncReaderLayout()
          if (typeof ResizeObserver !== 'undefined') {
            resizeObserver = new ResizeObserver(scheduleReaderLayoutSync)
            resizeObserver.observe(containerRef.current!)
          } else {
            resizeFallbackHandler = scheduleReaderLayoutSync
            window.addEventListener('resize', resizeFallbackHandler)
          }

          applyReaderTheme()

          relocationHandler = (locationInfo) => {
            pruneReaderDocuments()
            readerRelocationEdgesRef.current = {
              atEnd: Boolean((locationInfo as EpubLocationWithEdges).atEnd),
              atStart: Boolean((locationInfo as EpubLocationWithEdges).atStart),
            }

            if (readerModeRef.current !== 'epub') {
              handleReaderActivity()
              return
            }

            const nextLocation = locationInfo.start.cfi
            const nextProgress = Math.round((locationInfo.percentage ?? 0) * 100)

            setLocation(nextLocation)
            setProgress(nextProgress)

            patchBook(currentBookId, {
              currentLocation: nextLocation,
              lastOpenedAt: Date.now(),
              progressPercentage: nextProgress,
            })
            handleReaderActivity()
          }

          renderedHandler = (_section, contents) => {
            currentRenderTokenRef.current += 1
            pruneReaderDocuments()
            registerReaderDocument(contents.document)

            void refreshVisibleImages()
            restartIdleAutoEnhanceTimer()
          }

          rendition.on('relocated', relocationHandler)
          rendition.on('rendered', renderedHandler)
          await rendition.display(
            imageSpreadReaderEnabled ? undefined : getEpubInitialLocation(initialLocation),
          )
        } catch (fallbackError) {
          if (!imageSpreadReaderEnabled) {
            throw fallbackError
          }

          if (!isActiveReader()) {
            return
          }

          if (resizeFrameId !== undefined) {
            window.cancelAnimationFrame(resizeFrameId)
            resizeFrameId = undefined
          }
          resizeObserver?.disconnect()
          resizeObserver = null
          if (resizeFallbackHandler) {
            window.removeEventListener('resize', resizeFallbackHandler)
            resizeFallbackHandler = null
          }
          if (relocationHandler && renditionRef.current) {
            renditionRef.current.off('relocated', relocationHandler as (...args: never[]) => void)
          }
          if (renderedHandler && renditionRef.current) {
            renditionRef.current.off('rendered', renderedHandler as (...args: never[]) => void)
          }
          renditionRef.current?.destroy()
          renditionRef.current = null
          bookRef.current = null
          epubBook.destroy()
          cleanupReaderDocuments()
          currentRenderTokenRef.current += 1
          setReaderReady(true)
          setReaderNavigationReady(true)
          setReaderInitializing(false)
        }

        if (!isActiveReader()) {
          return
        }

        if (!imageSpreadReaderEnabled) {
          setReaderReady(true)
          setReaderNavigationReady(true)
          setReaderInitializing(false)
        }
      } catch (readerError) {
        if (isActiveReader()) {
          setReaderNavigationReady(false)
          setError(
            readerError instanceof Error
              ? readerError.message
              : 'EPUB の読み込みに失敗しました。',
          )
        }
      } finally {
        if (mountedRef.current && isActiveReader()) {
          setReaderInitializing(false)
        }
      }
    }

    void loadReader()

    return () => {
      mountedRef.current = false
      const endingEnhancementGroupId = currentEnhancementGroupIdRef.current
      readerSessionRef.current += 1
      activeBookIdRef.current = undefined
      currentReaderSessionIdRef.current = null
      currentEnhancementGroupIdRef.current = null
      setReaderNavigationReady(false)
      setZoomedImage(null)
      setIsEnhancing(false)
      if (idleTimerRef.current !== undefined) {
        window.clearTimeout(idleTimerRef.current)
        idleTimerRef.current = undefined
      }
      if (resizeFrameId !== undefined) {
        window.cancelAnimationFrame(resizeFrameId)
      }
      resizeObserver?.disconnect()
      if (resizeFallbackHandler) {
        window.removeEventListener('resize', resizeFallbackHandler)
      }
      clearPendingImageClickNavigation()
      clearReaderUiRevealTimer()
      idleGenerationRef.current += 1
      currentRenderTokenRef.current += 1
      cleanupReaderDocuments()
      cancelEnhancementsForGroup(endingEnhancementGroupId)
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
      setReaderInitializing(false)
      resetBookEnhancementState()
    }
    // Reader setup is expensive; progress saves and activity callbacks must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentBookId, preferredEngine, zoomEnhancementScale])

  useEffect(() => {
    applyReaderTheme()
  }, [applyReaderTheme])

  const handleEnhanceImage = useCallback(async (options?: {
    automatic?: boolean
    activityGeneration?: number
  }) => {
    if (!zoomedImage || !enhancementEnabled || !currentBookId) {
      return
    }

    const zoomedSessionId = zoomedImage.sessionId
    const zoomedBookId = zoomedImage.bookId
    const zoomedReaderSessionId = zoomedImage.readerSessionId
    const automaticGeneration = options?.activityGeneration
    const enhancementGroupId =
      currentEnhancementGroupIdRef.current ?? `${zoomedReaderSessionId}:manual:${createClientId('manual')}`
    const isSameZoomedImageSession = () =>
      currentBookId === zoomedBookId &&
      isCurrentReaderSessionKey(zoomedSessionId, zoomedBookId, zoomedReaderSessionId)
    const isCurrentZoomedImage = () =>
      isSameZoomedImageSession() &&
      (!options?.automatic || options.activityGeneration === idleGenerationRef.current)

    if (!enhancementGroupId || !isCurrentZoomedImage()) {
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
      const jobId = createClientId(options?.automatic ? 'auto-zoom-enhance' : 'manual-enhance')

      if (options?.automatic) {
        if (automaticGeneration === undefined) {
          return
        }

        setAutoEnhanceStatusForSession(zoomedSessionId, zoomedBookId, {
          message: '拡大画像をバックグラウンド処理中。',
          tone: 'working',
        })
      }

      const response = await enhanceBookImage({
        bookId: zoomedBookId,
        engineId: preferredEngine,
        imageDataUrl: requestImageDataUrl,
        imageHash: requestImageHash,
        jobId,
        readerSessionId: enhancementGroupId,
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

      rememberEnhancedImageDataUrl(cacheKey, response.imageDataUrl)
      bookImageCachedHashesRef.current.add(requestImageHash)
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
      if (options?.automatic) {
        setAutoEnhanceStatusForSession(zoomedSessionId, zoomedBookId, {
          message: response.cacheHit
            ? 'キャッシュ済みの拡大画像を適用しました。'
            : '拡大画像をキャッシュしました。',
          tone: 'ready',
        })
      }
    } catch (enhanceError) {
      if (isCurrentZoomedImage()) {
        if (options?.automatic) {
          setAutoEnhanceStatusForSession(zoomedSessionId, zoomedBookId, {
            message:
              enhanceError instanceof Error
                ? `拡大画像の処理をスキップしました: ${enhanceError.message}`
                : '拡大画像の処理をスキップしました。元画像で表示しています。',
            tone: 'warning',
          })
        } else {
          setError(
            enhanceError instanceof Error
              ? enhanceError.message
              : 'AI 高精細化に失敗しました。',
          )
        }
      }
    } finally {
      if (isSameZoomedImageSession()) {
        setIsEnhancing(false)
      }
    }
  }, [
    currentBookId,
    currentEngineStatus?.ready,
    enhancementEnabled,
    isCurrentReaderSessionKey,
    preferredEngine,
    rememberEnhancedImageDataUrl,
    setAutoEnhanceStatusForSession,
    zoomEnhancementScale,
    zoomedImage,
  ])

  useEffect(() => {
    if (
      !zoomedImage ||
      !autoEnhanceZoomedImage ||
      !enhancementEnabled ||
      !currentEngineStatus?.ready ||
      isEnhancing
    ) {
      return
    }

    if (zoomedImage.enhancedDataUrl) {
      return
    }

    const activityGeneration = idleGenerationRef.current
    const timerId = window.setTimeout(() => {
      if (activityGeneration !== idleGenerationRef.current) {
        return
      }

      void handleEnhanceImage({
        automatic: true,
        activityGeneration,
      })
    }, AUTO_ENHANCE_IDLE_DELAY_MS)

    return () => {
      window.clearTimeout(timerId)
    }
  }, [
    autoEnhanceZoomedImage,
    currentEngineStatus?.ready,
    enhancementEnabled,
    handleEnhanceImage,
    idleGenerationSnapshot,
    isEnhancing,
    zoomedImage,
  ])

  const openImageSpreadPage = useCallback((
    image: ScannedBookImage,
    originalDataUrl?: string,
    enhancedDataUrl?: string,
  ) => {
    const targetBookId = activeBookIdRef.current
    const readerSessionId = currentReaderSessionIdRef.current
    const zoomOriginalDataUrl = originalDataUrl ?? enhancedDataUrl

    if (!targetBookId || !readerSessionId || !zoomOriginalDataUrl) {
      return
    }

    setZoomedImage({
      bookId: targetBookId,
      caption: image.assetPath,
      enhancedDataUrl,
      imageHash: image.imageHash,
      originalDataUrl: zoomOriginalDataUrl,
      readerSessionId,
      sessionId: readerSessionRef.current,
    })
  }, [])

  const readerBlockingLoading = readerInitializing && !readerInteractionReady
  const toolbarDisabled = !readerInteractionReady
  const readerShellClassName = `reader-focus-shell${
    isReaderUiActive || isTocOpen ? ' is-reader-ui-active' : ''
  }`

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
      <section
        className={readerShellClassName}
        onFocusCapture={() => setIsReaderUiActive(true)}
        onMouseLeave={() => setIsReaderUiActive(false)}
        onMouseMove={handleReaderShellMouseMove}
        onPointerDown={handleReaderShellPointerDown}
        onPointerMove={handleReaderShellPointerMove}
      >
        <div className="reader-topbar">
          <Link to="/" className="reader-icon-button" aria-label="ライブラリへ戻る">
            <ArrowLeft size={19} />
          </Link>

          <div className="reader-topbar-spacer" aria-hidden="true" />

          <div className="reader-topbar-actions">
            <button
              type="button"
              className="reader-icon-button"
              aria-label="目次"
              onClick={() => {
                handleReaderActivity()
                setIsTocOpen((current) => !current)
              }}
            >
              <ListTree size={19} />
            </button>
            <Link to="/settings" className="reader-icon-button" aria-label="設定">
              <Settings2 size={19} />
            </Link>
          </div>
        </div>

        {error ? <div className="reader-floating-message is-error">{error}</div> : null}

        <div
          className={`reader-stage reader-stage--focus${
            readerMode === 'image-spread' ? ' is-image-spread-mode' : ''
          }`}
          onClick={handleReaderStageClick}
          onWheel={handleReaderStageWheel}
        >
          {readerBlockingLoading ? (
            <div className="reader-loading">
              <LoaderCircle size={34} className="animate-spin" />
              <span>読書画面を準備しています</span>
            </div>
          ) : null}
          {readerMode === 'image-spread' ? (
            <div className="image-spread-reader" aria-label="画像見開きビュー">
              <div className="image-spread-pages" data-direction={readerDirection}>
                {visibleImageSpreadItems.map((image) => {
                  const imageHash = image.imageHash
                  const originalDataUrl = imageAssetDataUrls[imageHash]
                  const enhancedDataUrl = enhancedImageSpreadDataUrls[imageHash]
                  const displayDataUrl = enhancedDataUrl ?? originalDataUrl
                  const loadError = imageSpreadLoadErrors[imageHash]

                  return (
                    <figure className="image-spread-page" key={`${image.assetPath}:${imageHash}`}>
                      {displayDataUrl ? (
                        <img
                          src={displayDataUrl}
                          alt={image.assetPath}
                          draggable={false}
                          onDoubleClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            clearPendingImageClickNavigation()
                            handleReaderActivity()
                            openImageSpreadPage(image, originalDataUrl, enhancedDataUrl)
                          }}
                        />
                      ) : (
                        <div className="image-spread-placeholder">
                          {loadError ? (
                            <span>{loadError}</span>
                          ) : (
                            <LoaderCircle size={28} className="animate-spin" />
                          )}
                        </div>
                      )}
                    </figure>
                  )
                })}
              </div>
            </div>
          ) : null}
          <div
            ref={containerRef}
            className={`epub-container${readerMode === 'image-spread' ? ' is-reader-fallback' : ''}`}
          />
        </div>

        <div className="reader-edge-hover-zones" aria-hidden="true">
          {['top', 'right', 'bottom', 'left'].map((edge) => (
            <span
              key={edge}
              className={`reader-edge-hover-zone is-${edge}`}
              onMouseEnter={() => {
                clearReaderUiRevealTimer()
                setIsReaderUiActive(true)
              }}
              onClick={handleReaderEdgeZoneClick}
              onPointerDown={() => revealReaderUiTemporarily(1400)}
              onWheel={handleReaderEdgeZoneWheel}
            />
          ))}
        </div>

        <div className="reader-bottom-bar">
          <button
            type="button"
            className="reader-icon-button"
            onClick={() => {
              handleReaderActivity()
              navigateReaderPage('prev')
            }}
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
            onClick={() => {
              handleReaderActivity()
              navigateReaderPage('next')
            }}
            disabled={toolbarDisabled}
            aria-label="次へ"
          >
            <ArrowRight size={20} />
          </button>
        </div>

        {autoEnhanceStatus.tone === 'error' ? (
          <div className={`reader-ai-status is-${autoEnhanceStatus.tone}`}>
            <ImageUpscale size={16} />
            <span>{autoEnhanceStatus.message}</span>
          </div>
        ) : null}

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
                        handleReaderActivity()
                        setIsTocOpen(false)
                        const rendition = renditionRef.current
                        if (!rendition) {
                          setError('目次ジャンプの準備がまだ完了していません。')
                          return
                        }

                        setReaderMode('epub')
                        readerModeRef.current = 'epub'
                        void rendition.display(item.href)
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
                  <li>- 元画像で読みながら、裏で高精細化します。</li>
                  <li>- 完了済みの画像はキャッシュから即表示します。</li>
                  <li>- 失敗時は元画像のまま読めます。</li>
                </ul>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}
