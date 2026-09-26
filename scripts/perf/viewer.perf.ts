import { expect, test, type Page } from '@playwright/test'

// 合成データでの性能の計測(P-03)。値は標準出力に `[perf]` で出す。上限の確認は、体感で待たされない
// 目安(1 操作 100ms 前後)に余裕を持たせた値で、極端な悪化だけを落とす。
// - 1,000 冊のフォルダ: モックの `prismpage-mock-perf` フラグで出る「負荷試験」フォルダ。
// - 500 ページの本: 1400×2000 の JPEG を 500 ページに並べた `perf-long`。
// - 長辺 12,000px の画像: 8000×12000 の JPEG を 6 ページに並べた `perf-huge`。

const LONG_PAGES = 500
const HUGE_PAGES = 6

interface Jpegs {
  page: Buffer
  huge: Buffer
}

// 模様の入った JPEG をブラウザの canvas で作る。
async function makeJpegs(page: Page): Promise<Jpegs> {
  const encoded = await page.evaluate(async () => {
    const draw = async (width: number, height: number) => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')!
      const gradient = context.createLinearGradient(0, 0, width, height)
      gradient.addColorStop(0, '#f5f1e8')
      gradient.addColorStop(1, '#22201c')
      context.fillStyle = gradient
      context.fillRect(0, 0, width, height)
      for (let index = 0; index < 400; index += 1) {
        context.fillStyle = `hsl(${(index * 37) % 360} 60% 50% / 0.5)`
        context.fillRect((index * 97) % width, (index * 193) % height, width / 12, height / 40)
      }
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), 'image/jpeg', 0.85))
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let binary = ''
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
      }
      return btoa(binary)
    }
    return { page: await draw(1400, 2000), huge: await draw(8000, 12000) }
  })
  return { page: Buffer.from(encoded.page, 'base64'), huge: Buffer.from(encoded.huge, 'base64') }
}

function pageUrls(id: string, count: number) {
  return Array.from({ length: count }, (_, index) => `/mock/books/${id}/${String(index + 1).padStart(3, '0')}.svg`)
}

// library.json に計測用の本を足し、そのページの要求に合成 JPEG を返す。フォルダ画面の計測用フラグも立てる。
async function installFixtures(page: Page, jpegs: Jpegs) {
  await page.route('**/mock/library.json', async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as { books: unknown[] }
    body.books.push(
      {
        id: 'perf-long',
        title: '計測用 500 ページ',
        kind: 'archive',
        direction: 'rtl',
        pageCount: LONG_PAGES,
        cover: pageUrls('perf-long', 1)[0],
        pages: pageUrls('perf-long', LONG_PAGES),
        pageSize: { width: 1400, height: 2000 },
      },
      {
        id: 'perf-huge',
        title: '計測用 長辺 12,000px',
        kind: 'archive',
        direction: 'rtl',
        pageCount: HUGE_PAGES,
        cover: pageUrls('perf-huge', 1)[0],
        pages: pageUrls('perf-huge', HUGE_PAGES),
        pageSize: { width: 8000, height: 12000 },
      },
    )
    await route.fulfill({ response, json: body })
  })
  await page.route('**/mock/books/perf-long/*', (route) =>
    route.fulfill({ body: jpegs.page, contentType: 'image/jpeg' }),
  )
  await page.route('**/mock/books/perf-huge/*', (route) =>
    route.fulfill({ body: jpegs.huge, contentType: 'image/jpeg' }),
  )
  await page.addInitScript(() => localStorage.setItem('prismpage-mock-perf', '1'))
}

function summary(label: string, samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  const average = samples.reduce((sum, value) => sum + value, 0) / samples.length
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
  console.log(
    `[perf] ${label}: ${samples.length} 回、平均 ${average.toFixed(1)} ms、95% ${p95.toFixed(1)} ms、最長 ${sorted[sorted.length - 1].toFixed(1)} ms`,
  )
  return { average, p95, max: sorted[sorted.length - 1] }
}

// ページ上で 1 回操作し、表示中のページ画像が読み込み済みになって描画が 2 フレーム進むまでの時間を返す。
// ページ送りはページ番号の表示が変わるまで、拡大・縮小は画像の表示幅が変わってデコードを終えるまで待つ。
// `width` は操作後の最初の画像の表示幅(CSS px)。
async function timeAction(page: Page, action: 'next' | 'zoomIn' | 'zoomOut') {
  return page.evaluate(
    async ({ action }) => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
      const label = () => document.querySelector('[class*="pageNumber"]')?.textContent ?? ''
      const images = () => [...document.querySelectorAll<HTMLImageElement>('img[alt$=" ページ"]')]
      const width = () => images()[0]?.getBoundingClientRect().width ?? 0
      const before = label()
      const widthBefore = width()
      const key = action === 'next' ? 'PageDown' : action === 'zoomIn' ? '+' : '-'
      const started = performance.now()
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      for (;;) {
        await frame()
        const shown = images()
        const ready = shown.length > 0 && shown.every((image) => image.complete && image.naturalWidth > 0)
        const changed = action === 'next' ? label() !== before : Math.abs(width() - widthBefore) > 0.5
        if (ready && changed) break
        if (performance.now() - started > 10_000) throw new Error(`操作が 10 秒で終わらない: ${before}`)
      }
      await Promise.all(images().map((image) => image.decode()))
      await frame()
      return { elapsed: performance.now() - started, label: label(), width: width() }
    },
    { action },
  )
}

async function heap(page: Page) {
  const session = await page.context().newCDPSession(page)
  await session.send('HeapProfiler.collectGarbage')
  await session.send('Performance.enable')
  const { metrics } = await session.send('Performance.getMetrics')
  await session.detach()
  const value = (name: string) => metrics.find((metric) => metric.name === name)?.value ?? 0
  return { heapMb: value('JSHeapUsedSize') / 1_048_576, nodes: value('Nodes') }
}

test('合成データでフォルダ画面・ページ送り・拡大を測る', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto('about:blank')
  const jpegs = await makeJpegs(page)
  console.log(
    `[perf] 合成 JPEG: 1400×2000 ${(jpegs.page.length / 1024).toFixed(0)} KB、8000×12000 ${(jpegs.huge.length / 1_048_576).toFixed(1)} MB`,
  )
  await installFixtures(page, jpegs)

  // 1,000 冊のフォルダ: 登録フォルダの画面から「負荷試験」へ移り、1,000 冊のカードが描かれるまで。
  await page.goto('/folders?source=1')
  await expect(page.getByRole('link', { name: /負荷試験/ })).toBeVisible()
  const folderSamples: number[] = []
  for (let round = 0; round < 3; round += 1) {
    const elapsed = await page.evaluate(async () => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
      const link = [...document.querySelectorAll('a')].find((anchor) => anchor.textContent?.includes('負荷試験'))!
      const started = performance.now()
      link.click()
      for (;;) {
        await frame()
        if (document.querySelectorAll('section[aria-label="本"] li').length === 1000) break
        if (performance.now() - started > 10_000) throw new Error('1,000 冊のカードが 10 秒で揃わない')
      }
      await frame()
      return performance.now() - started
    })
    folderSamples.push(elapsed)
    await page.goBack()
    await expect(page.getByRole('link', { name: /負荷試験/ })).toBeVisible()
  }
  const folder = summary('1,000 冊のフォルダ画面を描くまで', folderSamples)
  expect(folder.max).toBeLessThan(2000)

  // フォルダ画面のスクロール: 最後まで流したときの 1 フレームの間隔。
  await page.getByRole('link', { name: /負荷試験/ }).click()
  await expect(page.locator('section[aria-label="本"] li')).toHaveCount(1000)
  const scrollFrames = await page.evaluate(async () => {
    const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
    const scroller = (() => {
      let element: HTMLElement | null = document.querySelector('section[aria-label="本"]')
      while (element && element.scrollHeight <= element.clientHeight + 1) element = element.parentElement
      return element ?? document.scrollingElement!
    })() as HTMLElement
    const gaps: number[] = []
    let last = await frame()
    for (let step = 0; step < 120; step += 1) {
      scroller.scrollTop += scroller.scrollHeight / 120
      const now = await frame()
      gaps.push(now - last)
      last = now
    }
    return gaps
  })
  const scroll = summary('1,000 冊のフォルダ画面のスクロール(1 フレームの間隔)', scrollFrames)
  expect(scroll.p95).toBeLessThan(200)

  // 500 ページの本: 先頭から最後まで送る。1 回ごとに、次の見開きの画像が出るまで。
  await page.goto('/viewer/perf-long')
  await expect(page.getByText(new RegExp(`^1(–\\d+)? / ${LONG_PAGES}$`))).toBeVisible()
  const turnSamples: number[] = []
  let label = ''
  let early = { heapMb: 0, nodes: 0 }
  while (!label.startsWith(`${LONG_PAGES} `) && !label.endsWith(`${LONG_PAGES} / ${LONG_PAGES}`)) {
    const result = await timeAction(page, 'next')
    turnSamples.push(result.elapsed)
    label = result.label
    if (turnSamples.length === 20) early = await heap(page)
    if (turnSamples.length > LONG_PAGES) throw new Error(`最後のページに着かない: ${label}`)
  }
  const late = await heap(page)
  console.log(`[perf] ページ送り: ${turnSamples.length} 回で ${label} に着いた`)
  const turn = summary('500 ページの本のページ送り', turnSamples)
  console.log(
    `[perf] 20 回送った後: JS ヒープ ${early.heapMb.toFixed(1)} MB・DOM ノード ${early.nodes} / 最後まで送った後: JS ヒープ ${late.heapMb.toFixed(1)} MB・DOM ノード ${late.nodes}`,
  )
  expect(turn.p95).toBeLessThan(300)
  // 送り続けても DOM と JS ヒープが増え続けない(揺れの分だけ余裕を見る)。
  expect(late.nodes).toBeLessThan(early.nodes * 1.2 + 50)
  expect(late.heapMb).toBeLessThan(early.heapMb * 1.5 + 5)

  // 長辺 12,000px の本: 開いて最初の見開きが出るまで、拡大の 1 段ごと、ページ送り。
  const openStarted = Date.now()
  await page.goto('/viewer/perf-huge')
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll<HTMLImageElement>('img[alt$=" ページ"]')]
    return images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0)
  })
  console.log(`[perf] 長辺 12,000px の本を開いて最初の見開きが出るまで(アプリの読み込みを含む): ${Date.now() - openStarted} ms`)

  // + を 10 回で上限の 8 倍に届く(1.25 倍ずつ、10 回目は上限で止まる)。
  const baseWidth = await page.evaluate(
    () => document.querySelector('img[alt$=" ページ"]')!.getBoundingClientRect().width,
  )
  const zoomIn: number[] = []
  let zoomedWidth = baseWidth
  for (let step = 0; step < 10; step += 1) {
    const result = await timeAction(page, 'zoomIn')
    zoomIn.push(result.elapsed)
    zoomedWidth = result.width
  }
  console.log(`[perf] 拡大の後の画像の表示幅: ${baseWidth.toFixed(0)} → ${zoomedWidth.toFixed(0)} px(${(zoomedWidth / baseWidth).toFixed(2)} 倍)`)
  expect(zoomedWidth / baseWidth).toBeCloseTo(8, 1)
  const zoomOut: number[] = []
  for (let step = 0; step < 10; step += 1) zoomOut.push((await timeAction(page, 'zoomOut')).elapsed)
  const zoomInSummary = summary('長辺 12,000px の拡大(+ 1 回ごと、8 倍まで)', zoomIn)
  summary('長辺 12,000px の縮小(- 1 回ごと)', zoomOut)
  expect(zoomInSummary.p95).toBeLessThan(500)

  const hugeTurns: number[] = []
  for (let step = 0; step < 2; step += 1) hugeTurns.push((await timeAction(page, 'next')).elapsed)
  summary('長辺 12,000px の本のページ送り(先読み済み)', hugeTurns)

  expect(pageErrors).toEqual([])
})
