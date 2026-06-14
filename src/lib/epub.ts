import ePub from 'epubjs'

const COVER_THUMBNAIL_MAX_EDGE = 360
const COVER_THUMBNAIL_MAX_DATA_URL_LENGTH = 140 * 1024
const COVER_THUMBNAIL_QUALITIES = [0.82, 0.72, 0.62, 0.52]

export function base64ToArrayBuffer(base64: string) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes.buffer
}

function loadImageFromBlob(blob: Blob) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob)
    const image = new Image()

    image.onload = () => {
      URL.revokeObjectURL(objectUrl)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('表紙画像の読み込みに失敗しました。'))
    }
    image.src = objectUrl
  })
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('表紙画像の変換に失敗しました。'))
    reader.readAsDataURL(blob)
  })
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', quality)
  })
}

async function createCoverThumbnailDataUrl(blob: Blob) {
  const image = await loadImageFromBlob(blob)
  const sourceWidth = image.naturalWidth || image.width
  const sourceHeight = image.naturalHeight || image.height

  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return undefined
  }

  const scale = Math.min(
    1,
    COVER_THUMBNAIL_MAX_EDGE / Math.max(sourceWidth, sourceHeight),
  )
  const thumbnailWidth = Math.max(1, Math.round(sourceWidth * scale))
  const thumbnailHeight = Math.max(1, Math.round(sourceHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = thumbnailWidth
  canvas.height = thumbnailHeight

  const context = canvas.getContext('2d')
  if (!context) {
    return undefined
  }

  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, thumbnailWidth, thumbnailHeight)
  context.drawImage(image, 0, 0, thumbnailWidth, thumbnailHeight)

  for (const quality of COVER_THUMBNAIL_QUALITIES) {
    const thumbnailBlob = await canvasToBlob(canvas, quality)
    if (!thumbnailBlob) {
      continue
    }

    const dataUrl = await blobToDataUrl(thumbnailBlob)
    if (dataUrl.length <= COVER_THUMBNAIL_MAX_DATA_URL_LENGTH) {
      return dataUrl
    }
  }

  return undefined
}

export async function extractEpubPreview(base64: string) {
  const book = ePub(base64ToArrayBuffer(base64))

  try {
    await book.ready

    const metadata = await book.loaded.metadata
    let coverDataUrl: string | undefined

    try {
      const coverUrl = await book.coverUrl()
      if (coverUrl) {
        const response = await fetch(coverUrl)
        if (response.ok) {
          coverDataUrl = await createCoverThumbnailDataUrl(await response.blob())
        }
      }
    } catch {
      coverDataUrl = undefined
    }

    return {
      author: metadata.creator,
      coverDataUrl,
      title: metadata.title,
    }
  } finally {
    book.destroy()
  }
}

export function flattenNavigation(
  items: Array<{ href: string; label: string; subitems?: Array<{ href: string; label: string }> }>,
): Array<{ href: string; label: string }> {
  return items.flatMap((item) => [
    { href: item.href, label: item.label },
    ...(item.subitems ? flattenNavigation(item.subitems) : []),
  ])
}
