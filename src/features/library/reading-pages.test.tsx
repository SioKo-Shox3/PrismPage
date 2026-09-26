import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { routeTree } from '@/app/router'
import { enqueueSave } from '@/lib/save-queue'
import type { HistoryEntry } from '@/types/app'

const history = vi.hoisted(() => ({
  entries: [] as HistoryEntry[],
  listContinueReading: vi.fn(),
  listHistory: vi.fn(),
  removeHistoryEntry: vi.fn(),
  clearHistory: vi.fn(),
}))

// 一覧の取得は `@/lib/tauri` の本物のラッパー(保存の完了を待つ)を通し、command の呼び出しだけを差し替える。
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  invoke: (command: string) => {
    if (command === 'list_continue_reading') return history.listContinueReading()
    if (command === 'list_history') return history.listHistory()
    return Promise.reject(new Error(`想定しない command: ${command}`))
  },
}))

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  hasCommandBackend: true,
  removeHistoryEntry: history.removeHistoryEntry,
  clearHistory: history.clearHistory,
  // ビューアへ移った先で本を開かない(ビューアの中身はこのテストの対象外)。
  openBook: () => new Promise(() => {}),
}))

function entry(itemId: number, title: string, page: number, available = true): HistoryEntry {
  return {
    itemId,
    name: `${title}.cbz`,
    title,
    path: `\\\\?\\C:\\蔵書\\漫画\\${title}.cbz`,
    format: 'zip',
    folder: '漫画',
    folderPath: 'C:\\蔵書\\漫画',
    page,
    pageCount: 20,
    lastReadAt: Date.now() - itemId * 60 * 60 * 1000,
    available,
    thumbId: available ? '0123456789abcdef' : null,
  }
}

beforeAll(() => {
  // 相対表示が日付の境目をまたがないよう、時計を昼に固定する(タイマーは本物のまま)。
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 8, 25, 12, 0))
  // jsdom の <dialog> には showModal / close が無い。
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false
  }
})

afterAll(() => {
  vi.useRealTimers()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function renderAt(path: string) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  await router.load()
  render(<RouterProvider router={router} />)
  return router
}

describe('読みかけ', () => {
  it('最終閲覧順に巻・形式・フォルダ・ページ位置を見せ、「続きを読む」で本の場所を渡して開く', async () => {
    history.listContinueReading.mockResolvedValue([
      entry(1, '光の階段 第2巻', 4),
      entry(2, '光の階段 第1巻', 9),
      entry(3, '手放した本', 0, false),
    ])
    const router = await renderAt('/')

    const list = await screen.findByRole('list', { name: '読みかけの本' })
    const items = within(list).getAllByRole('listitem')
    expect(items.map((item) => within(item).getByRole('heading').textContent)).toEqual([
      '光の階段 第2巻',
      '光の階段 第1巻',
      '手放した本',
    ])
    expect(within(items[0]).getByText('第2巻')).toBeTruthy()
    // 形式は表紙の仮の面にも書くので、2 か所に出る。
    expect(within(items[0]).getAllByText('CBZ')).toHaveLength(2)
    expect(within(items[0]).getByText('漫画')).toBeTruthy()
    expect(within(items[0]).getByText('5 / 20 ページ')).toBeTruthy()
    expect(within(items[0]).getByText('1 時間前')).toBeTruthy()
    expect(within(items[0]).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25')

    const missing = within(items[2]).getByRole('button', { name: /続きを読む/ }) as HTMLButtonElement
    expect(missing.disabled).toBe(true)
    expect(within(items[2]).getByText('見つかりません')).toBeTruthy()

    fireEvent.click(within(items[1]).getByRole('button', { name: /続きを読む/ }))
    await vi.waitFor(() => expect(router.state.location.pathname).toMatch(/^\/viewer\//))
    expect(router.state.location.search).toEqual({ path: entry(2, '光の階段 第1巻', 9).path })
  })
})

describe('保存の途中で戻ったとき', () => {
  it('ビューアの読書位置の保存が終わるまで一覧を読まず、終わってから保存後の位置を見せる', async () => {
    let finishSave = () => {}
    const delaySave = () =>
      enqueueSave(
        () =>
          new Promise<void>((resolve) => {
            finishSave = resolve
          }),
      )
    history.listContinueReading.mockResolvedValue([entry(1, '光の階段 第2巻', 8)])
    history.listHistory.mockResolvedValue([entry(1, '光の階段 第2巻', 8)])

    delaySave()
    await renderAt('/')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(history.listContinueReading).not.toHaveBeenCalled()
    finishSave()
    expect(await screen.findByText('9 / 20 ページ')).toBeTruthy()
    cleanup()

    delaySave()
    await renderAt('/history')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(history.listHistory).not.toHaveBeenCalled()
    finishSave()
    await vi.waitFor(() => expect(history.listHistory).toHaveBeenCalledTimes(1))
  })
})

describe('履歴', () => {
  it('1 冊ずつ消すと一覧を読み直し、すべて消すは確認してから消す', async () => {
    const entries = [entry(1, '光の階段 第2巻', 4), entry(2, '光の階段 第1巻', 19)]
    history.listHistory.mockResolvedValueOnce(entries).mockResolvedValueOnce([entries[1]])
    history.removeHistoryEntry.mockResolvedValue(undefined)
    history.clearHistory.mockResolvedValue(undefined)
    await renderAt('/history')

    fireEvent.click(await screen.findByRole('button', { name: '光の階段 第2巻 を履歴から消す' }))
    await vi.waitFor(() => expect(history.removeHistoryEntry).toHaveBeenCalledWith(1))
    await vi.waitFor(() =>
      expect(screen.queryByRole('button', { name: '光の階段 第2巻 を履歴から消す' })).toBeNull(),
    )

    history.listHistory.mockResolvedValueOnce([])
    fireEvent.click(screen.getByRole('button', { name: /履歴をすべて消す/ }))
    expect(history.clearHistory).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'すべて消す' }))
    await vi.waitFor(() => expect(history.clearHistory).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('履歴はありません。')).toBeTruthy()
  })
})
