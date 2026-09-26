import path from 'node:path'
import { expect, test } from '@playwright/test'

// 全ルートを「紙」「墨」の両テーマで撮る。テーマは設定の既定値「システムに合わせる」を
// prefers-color-scheme の擬似で切り替えて決める(light → 紙、dark → 墨)。

const shotsDir = path.resolve('.harness', 'shots')

const routes = [
  { name: 'continue-reading', path: '/', withNav: true },
  { name: 'shelves', path: '/shelves', withNav: true },
  { name: 'folders', path: '/folders', withNav: true },
  { name: 'favorites', path: '/favorites', withNav: true },
  { name: 'history', path: '/history', withNav: true },
  { name: 'settings', path: '/settings', withNav: true },
  // ビューアは全画面表示で左ナビを出さない。
  { name: 'viewer', path: '/viewer/sample-manga', withNav: false },
]

// accent / onAccent は tokens.css の --color-accent / --color-on-accent を計算値の形で写したもの。
const themes = [
  { name: 'paper', colorScheme: 'light', accent: 'rgb(169, 59, 40)', onAccent: 'rgb(251, 248, 241)' },
  { name: 'ink', colorScheme: 'dark', accent: 'rgb(224, 120, 92)', onAccent: 'rgb(28, 26, 23)' },
] as const

for (const theme of themes) {
  test.describe(theme.name, () => {
    test.use({ colorScheme: theme.colorScheme })

    for (const route of routes) {
      test(route.name, async ({ page }) => {
        const pageErrors: string[] = []
        page.on('pageerror', (error) => pageErrors.push(error.message))

        await page.goto(route.path)
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme.name)
        await expect(page.getByRole('navigation', { name: 'アプリケーションナビゲーション' })).toHaveCount(
          route.withNav ? 1 : 0,
        )
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
        await page.waitForFunction('document.fonts.status === "loaded"')

        await page.screenshot({
          path: path.join(shotsDir, `${theme.name}-${route.name}.png`),
          fullPage: true,
        })
        expect(pageErrors).toEqual([])
      })
    }
  })
}

// ビューアの情報バー(上端のバーと下端中央のスライダー)を出した状態。ポインタを下端の帯に置いて出したままにする。
for (const theme of themes) {
  test(`${theme.name} viewer-bar`, async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.emulateMedia({ colorScheme: theme.colorScheme })

    await page.goto('/viewer/sample-manga')
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.name)
    const slider = page.getByRole('slider', { name: 'ページ移動' })
    await expect(slider).toBeVisible()
    await page.waitForFunction('document.fonts.status === "loaded"')

    const viewport = page.viewportSize()
    if (!viewport) throw new Error('画面の大きさが分かりません')
    await page.mouse.move(viewport.width / 2, viewport.height - 8)
    await slider.focus()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await expect(page.locator('[data-ui]')).toHaveAttribute('data-ui', 'visible')
    await expect(slider).toHaveAttribute('aria-valuenow', /^[2-9]/)
    await slider.blur()

    await page.screenshot({ path: path.join(shotsDir, `${theme.name}-viewer-bar.png`) })
    expect(pageErrors).toEqual([])
  })
}

// AI をオンにした情報バー。オンのボタンは朱の地で「AI オン」と出る。
for (const theme of themes) {
  test(`${theme.name} viewer-bar-ai-on`, async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.emulateMedia({ colorScheme: theme.colorScheme })

    await page.goto('/viewer/sample-manga')
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.name)
    await expect(page.getByRole('slider', { name: 'ページ移動' })).toBeVisible()
    await page.waitForFunction('document.fonts.status === "loaded"')

    const viewport = page.viewportSize()
    if (!viewport) throw new Error('画面の大きさが分かりません')
    await page.mouse.move(viewport.width / 2, 8)
    await expect(page.locator('[data-ui]')).toHaveAttribute('data-ui', 'visible')
    await page.getByRole('button', { name: 'AI オフ' }).click()
    const button = page.getByRole('button', { name: 'AI オン' })
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    // 押した直後のホバーの色ではなく、オンの地の色で撮る。
    await page.mouse.move(viewport.width / 2, 40)
    await expect(page.locator('[data-ui]')).toHaveAttribute('data-ui', 'visible')
    // 色の切り替えのトランジションが終わるまで待つ(朱の地と、その上の文字色)。
    await expect(button).toHaveCSS('background-color', theme.accent)
    await expect(button).toHaveCSS('color', theme.onAccent)

    await page.screenshot({ path: path.join(shotsDir, `${theme.name}-viewer-bar-ai-on.png`) })
    expect(pageErrors).toEqual([])
  })
}

// 最後の見開きの次に出す読み終わりの案内。End で最後の見開きへ動き、PageDown で次へ送る。
for (const theme of themes) {
  test(`${theme.name} viewer-finished`, async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.emulateMedia({ colorScheme: theme.colorScheme })

    await page.goto('/viewer/sample-manga')
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.name)
    await expect(page.getByRole('slider', { name: 'ページ移動' })).toHaveCount(1)
    await page.waitForFunction('document.fonts.status === "loaded"')

    await page.keyboard.press('End')
    await page.keyboard.press('PageDown')
    await expect(page.getByRole('heading', { name: '読み終わりました' })).toBeVisible()
    await expect(page.getByRole('button', { name: '最初から読む' })).toBeVisible()
    await expect(page.getByRole('button', { name: '閉じる' })).toBeVisible()

    await page.screenshot({ path: path.join(shotsDir, `${theme.name}-viewer-finished.png`) })
    expect(pageErrors).toEqual([])
  })
}

test('モックのサンプルの本と合成ページ画像が配信される', async ({ request }) => {
  const library = await request.get('/mock/library.json')
  expect(library.ok()).toBe(true)
  const body = (await library.json()) as { books: Array<{ pages: string[] }> }
  expect(body.books.length).toBeGreaterThan(0)

  const firstPage = await request.get(body.books[0].pages[0])
  expect(firstPage.ok()).toBe(true)
  expect(firstPage.headers()['content-type']).toContain('image/svg+xml')
})
