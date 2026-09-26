import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { routeTree } from '@/app/router'

// jsdom は scrollIntoView を持たない。ハッシュ付き URL で router がスクロールを試みるので空の実装を置く。
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {}
})

afterEach(cleanup)

async function renderAt(url: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [url] }),
  })
  await router.load()
  render(<RouterProvider router={router} />)
  const nav = await screen.findByRole('navigation', { name: 'アプリケーションナビゲーション' })
  return Array.from(nav.querySelectorAll('[aria-current="page"]')).map((el) => el.textContent)
}

describe('左ナビの選択表示', () => {
  it.each([
    ['/', ['読みかけ']],
    ['/shelves', ['本棚']],
    ['/settings', ['設定']],
    ['/settings#ai-engines', ['AI 超解像']],
  ])('%s では 1 項目だけが選択される', async (url, expected) => {
    expect(await renderAt(url)).toEqual(expected)
  })
})
