import ePub from 'epubjs'

export function base64ToArrayBuffer(base64: string) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes.buffer
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('表紙画像の変換に失敗しました。'))
    reader.readAsDataURL(blob)
  })
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
          coverDataUrl = await blobToDataUrl(await response.blob())
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
