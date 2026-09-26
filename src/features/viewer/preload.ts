// ページ画像の先読み。保持するのは直近に指定された URL の分だけで、外れた画像は手放す。

// 文書に入れずに読み込む画像要素の使い回し。Chromium は文書に入れずに src を与えた <img> を
// 表示域の変化の通知先として文書の寿命まで握り続けるため、作った要素は捨てずに次の読み込みに使う。
// 要素の数は同時に読み込む数の最大で止まる。
const spareImages: HTMLImageElement[] = []

// `src` を読み込む画像要素を取り出す。使い終わったら `releaseImage` で返す。
export function acquireImage(src: string): HTMLImageElement {
  const image = spareImages.pop() ?? new Image()
  image.decoding = 'async'
  image.src = src
  return image
}

// 読み込みを止めて(待っている decode は失敗で終わる)、要素を使い回しに戻す。
export function releaseImage(image: HTMLImageElement) {
  image.removeAttribute('src')
  spareImages.push(image)
}

export class PagePreloader {
  private readonly images = new Map<string, HTMLImageElement>()

  // `urls` だけを保持する。新しい URL は読み込んでデコードまで進め、外れた URL は読み込みを止めて手放す。
  retain(urls: readonly string[]) {
    const wanted = new Set(urls)
    for (const [url, image] of this.images) {
      if (!wanted.has(url)) {
        releaseImage(image)
        this.images.delete(url)
      }
    }
    for (const url of wanted) {
      if (this.images.has(url)) continue
      const image = acquireImage(url)
      this.images.set(url, image)
      // 失敗は表示側の <img> が扱うので、先読みでは握りつぶす。
      image.decode().catch(() => undefined)
    }
  }

  clear() {
    this.retain([])
  }
}
