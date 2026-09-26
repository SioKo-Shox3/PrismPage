import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { routeTree } from '@/app/router'
import { enqueueSave } from '@/lib/save-queue'
import type { DirectoryListing, LibrarySearchHit, LibrarySearchResult, LibrarySource } from '@/types/app'

import { defaultListOrder, useListOrderStore } from './list-order'

const library = vi.hoisted(() => ({
  listDirectory: vi.fn<(sourceId: number, path?: string) => Promise<DirectoryListing>>(),
  searchLibrary:
    vi.fn<(query: string, scope?: { sourceId: number; path?: string }) => Promise<LibrarySearchResult>>(),
  // 登録フォルダの一覧(`listSources` が返す)と登録。
  sources: [] as LibrarySource[],
  addSource: vi.fn<(path: string) => Promise<LibrarySource>>(),
}))

// 一覧の取得は `@/lib/tauri` の本物のラッパー(保存の完了を待つ)を通し、command の呼び出しだけを差し替える。
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  invoke: (command: string, args: { sourceId: number; path: string | null }) =>
    command === 'list_directory'
      ? library.listDirectory(args.sourceId, args.path ?? undefined)
      : Promise.reject(new Error(`想定しない command: ${command}`)),
}))

const source: LibrarySource = {
  id: 1,
  path: '\\\\?\\C:\\蔵書',
  displayPath: 'C:\\蔵書',
  name: '蔵書',
  addedAt: 0,
}

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  hasCommandBackend: true,
  listSources: () => Promise.resolve(library.sources),
  addSource: library.addSource,
  searchLibrary: library.searchLibrary,
  // ビューアへ移った先で本を開かない(ビューアの中身はこのテストの対象外)。
  openBook: () => new Promise(() => {}),
}))

const listing: DirectoryListing = {
  sourceId: 1,
  path: '\\\\?\\C:\\蔵書\\漫画\\光の階段',
  segments: ['漫画', '光の階段'],
  entries: [
    {
      name: '外伝',
      title: '外伝',
      path: '\\\\?\\C:\\蔵書\\漫画\\光の階段\\外伝',
      kind: 'folder',
      format: null,
      openable: false,
      thumbId: null,
      modifiedAt: 400,
      page: null,
      pageCount: null,
      lastReadAt: null,
    },
    {
      name: '第1巻.cbz',
      title: '第1巻',
      path: '\\\\?\\C:\\蔵書\\漫画\\光の階段\\第1巻.cbz',
      kind: 'book',
      format: 'zip',
      openable: true,
      thumbId: '0123456789abcdef',
      modifiedAt: 100,
      page: 3,
      pageCount: 10,
      lastReadAt: 2000,
    },
    {
      name: '第2巻.cbz',
      title: '第2巻',
      path: '\\\\?\\C:\\蔵書\\漫画\\光の階段\\第2巻.cbz',
      kind: 'book',
      format: 'zip',
      openable: true,
      thumbId: null,
      modifiedAt: 200,
      page: 9,
      pageCount: 10,
      lastReadAt: 1000,
    },
    {
      name: '合本.rar',
      title: '合本',
      path: '\\\\?\\C:\\蔵書\\漫画\\光の階段\\合本.rar',
      kind: 'book',
      format: 'rar',
      openable: false,
      thumbId: null,
      modifiedAt: 300,
      page: null,
      pageCount: null,
      lastReadAt: null,
    },
  ],
}

beforeAll(() => {
  // jsdom の <dialog> には showModal / close が無い。
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false
  }
})

beforeEach(() => {
  library.sources = [source]
})

afterEach(() => {
  cleanup()
  library.listDirectory.mockReset()
  library.searchLibrary.mockReset()
  library.addSource.mockReset()
  localStorage.clear()
  useListOrderStore.setState({ sorts: { ...defaultListOrder.sorts } })
})

// 本の区画に並ぶ本の書名(表示順)。
function bookTitles() {
  const section = screen.getByRole('region', { name: '本' })
  return within(section)
    .getAllByRole('button')
    .map((button) => listing.entries.find((entry) => button.textContent?.includes(entry.title))?.title)
}

async function renderFolder() {
  library.listDirectory.mockResolvedValue(listing)
  return renderFolderRoute()
}

async function renderFolderRoute() {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({
      initialEntries: ['/folders?source=1&path=%E6%BC%AB%E7%94%BB%2F%E5%85%89%E3%81%AE%E9%9A%8E%E6%AE%B5'],
    }),
  })
  await router.load()
  render(<RouterProvider router={router} />)
  await screen.findByRole('button', { name: /第1巻/ })
  return router
}

describe('フォルダ画面', () => {
  it('登録フォルダからの相対パスで一覧を求め、パンくずで上のフォルダへ戻れる', async () => {
    const router = await renderFolder()
    expect(library.listDirectory).toHaveBeenCalledWith(1, '漫画/光の階段')

    const crumbs = within(screen.getByRole('navigation', { name: 'パンくず' }))
    expect(crumbs.getByText('光の階段').getAttribute('aria-current')).toBe('page')
    fireEvent.click(crumbs.getByRole('link', { name: '漫画' }))
    await vi.waitFor(() => expect(router.state.location.search).toEqual({ source: 1, path: '漫画' }))
  })

  it('サブフォルダはその中へ、開ける本はビューアへ本の場所を渡して移る', async () => {
    const router = await renderFolder()
    fireEvent.click(screen.getByRole('link', { name: /外伝/ }))
    await vi.waitFor(() =>
      expect(router.state.location.search).toEqual({ source: 1, path: '漫画/光の階段/外伝' }),
    )

    router.history.back()
    fireEvent.click(await screen.findByRole('button', { name: /第1巻/ }))
    await vi.waitFor(() => expect(router.state.location.pathname).toMatch(/^\/viewer\//))
    expect(router.state.location.search).toEqual({ path: listing.entries[1].path })
  })

  it('名前・更新日・最近読んだで本を並び替え、選んだ並び順はフォルダ画面の分として保存され読み戻される', async () => {
    await renderFolder()
    expect(bookTitles()).toEqual(['合本', '第1巻', '第2巻'])

    const sort = screen.getByRole('combobox', { name: '並び順' }) as HTMLSelectElement
    fireEvent.change(sort, { target: { value: 'modified' } })
    expect(bookTitles()).toEqual(['合本', '第2巻', '第1巻'])
    fireEvent.change(sort, { target: { value: 'recent' } })
    expect(bookTitles()).toEqual(['第1巻', '第2巻', '合本'])
    fireEvent.change(sort, { target: { value: 'modified' } })

    // 保存は画面ごと。本棚の並び順は変わらない。
    const stored = localStorage.getItem('prismpage-list-order') ?? 'null'
    const saved = JSON.parse(stored) as { state: { sorts: Record<string, string> } }
    expect(saved.state.sorts).toEqual({ folders: 'modified', shelves: 'name' })

    // 起動し直した(メモリ上は既定値で、保存から読み戻す)ときも同じ並び順で並ぶ。
    cleanup()
    useListOrderStore.setState({ sorts: { ...defaultListOrder.sorts } })
    localStorage.setItem('prismpage-list-order', stored)
    await useListOrderStore.persist.rehydrate()
    await renderFolder()
    expect((screen.getByRole('combobox', { name: '並び順' }) as HTMLSelectElement).value).toBe('modified')
    expect(bookTitles()).toEqual(['合本', '第2巻', '第1巻'])
  })

  it('未読・読みかけ・読了で本を絞り込み、フォルダは絞り込まない', async () => {
    await renderFolder()
    const filter = screen.getByRole('combobox', { name: '絞り込み' })
    fireEvent.change(filter, { target: { value: 'unread' } })
    expect(bookTitles()).toEqual(['合本'])
    fireEvent.change(filter, { target: { value: 'reading' } })
    expect(bookTitles()).toEqual(['第1巻'])
    expect(screen.getByRole('button', { name: /第1巻/ }).textContent).toContain('4 / 10 ページ')
    fireEvent.change(filter, { target: { value: 'finished' } })
    expect(bookTitles()).toEqual(['第2巻'])
    expect(screen.getByRole('button', { name: /第2巻/ }).textContent).toContain('読了')
    expect(screen.getByRole('link', { name: /外伝/ })).toBeTruthy()
  })

  it('まだ開けない形式の本は押せない', async () => {
    await renderFolder()
    const rar = screen.getByRole('button', { name: /合本/ }) as HTMLButtonElement
    expect(rar.disabled).toBe(true)
    expect(rar.textContent).toContain('まだ開けない形式')
  })

  it('表紙のサムネイルは画面に入ってから要求し、開けない本には要求しない', async () => {
    const observed: { element: Element; notify: (visible: boolean) => void }[] = []
    class FakeObserver {
      private callback: IntersectionObserverCallback
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback
      }
      observe(element: Element) {
        observed.push({
          element,
          notify: (visible) =>
            this.callback(
              [{ isIntersecting: visible, target: element } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver,
            ),
        })
      }
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    try {
      await renderFolder()
      const card = screen.getByRole('button', { name: /第1巻/ })
      expect(card.querySelector('img')).toBeNull()
      expect(observed).toHaveLength(1)

      act(() => observed[0].notify(false))
      expect(card.querySelector('img')).toBeNull()
      act(() => observed[0].notify(true))
      expect(card.querySelector('img')?.getAttribute('src')).toMatch(/thumb\/0123456789abcdef$/)
      expect(screen.getByRole('button', { name: /合本/ }).querySelector('img')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('ビューアの読書位置の保存が終わってから一覧を読み、読み終えた本を読了として絞り込める', async () => {
    let finishSave = () => {}
    enqueueSave(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve
        }),
    )
    // 保存が終わると、第1巻は最後のページ(0 始まりで 9)まで読んだ記録になる。
    const saved = listing.entries.map((entry) => (entry.name === '第1巻.cbz' ? { ...entry, page: 9 } : entry))
    library.listDirectory.mockImplementation(() => Promise.resolve({ ...listing, entries: saved }))
    const shown = renderFolderRoute()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(library.listDirectory).not.toHaveBeenCalled()
    finishSave()
    await shown
    fireEvent.change(screen.getByRole('combobox', { name: '絞り込み' }), { target: { value: 'finished' } })
    // 前に表示した一覧は読み直すまでの間だけ見せ、読み直した後は保存後の記録で絞り込む。
    await vi.waitFor(() => expect(bookTitles()).toEqual(['第1巻', '第2巻']))
    expect(library.listDirectory).toHaveBeenCalledTimes(1)
  })
})

function hit(overrides: Partial<LibrarySearchHit>): LibrarySearchHit {
  return {
    sourceId: 1,
    sourceName: '蔵書',
    name: '第1巻.cbz',
    title: '第1巻',
    path: '\\\\?\\C:\\蔵書\\漫画\\光の階段\\第1巻.cbz',
    folder: '漫画/光の階段',
    kind: 'book',
    format: 'zip',
    openable: true,
    thumbId: null,
    ...overrides,
  }
}

describe('大きなフォルダ', () => {
  it('1,000 冊のフォルダを描き、表紙は画面に入るまで 1 枚も要求しない', async ({ annotate }) => {
    const bookCount = 1000
    const entries = Array.from({ length: bookCount }, (_, index) => ({
      ...listing.entries[1],
      name: `第${index + 1}巻.cbz`,
      title: `第${index + 1}巻`,
      path: listing.entries[1].path.replace('第1巻', `第${index + 1}巻`),
      thumbId: index.toString(16).padStart(16, '0'),
    }))
    // 画面に入ったことを知らせない観察で、一覧を描いただけでは表紙を読まないことを確かめる。
    const observed: Element[] = []
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe(element: Element) {
          observed.push(element)
        }
        disconnect() {}
      },
    )
    try {
      library.listDirectory.mockResolvedValue({ ...listing, entries })
      const started = performance.now()
      await renderFolderRoute()
      await screen.findByRole('button', { name: new RegExp(`第${bookCount}巻`) })
      const elapsed = performance.now() - started
      await annotate(`[perf] 1,000 冊のフォルダ画面を描くまで: ${elapsed.toFixed(0)} ms`)

      const section = screen.getByRole('region', { name: '本' })
      expect(within(section).getAllByRole('button')).toHaveLength(bookCount)
      expect(observed).toHaveLength(bookCount)
      expect(section.querySelectorAll('img')).toHaveLength(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('フォルダ画面の検索', () => {
  it('打ち終えた語で登録フォルダ全体を探し、一覧の代わりに結果を見せ、本はビューアで開く', async () => {
    library.searchLibrary.mockResolvedValue({
      hits: [
        hit({ kind: 'folder', format: null, name: '光の階段', title: '光の階段', folder: '漫画', path: '\\\\?\\C:\\蔵書\\漫画\\光の階段' }),
        hit({}),
      ],
      truncated: false,
      indexing: false,
    })
    const router = await renderFolder()
    fireEvent.change(screen.getByRole('searchbox', { name: '書名・パスで探す' }), { target: { value: ' ＫＡＩ ' } })
    // 打つたびには探さず、少し待ってから前後の空白を除いた語で探す。
    expect(library.searchLibrary).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(library.searchLibrary).toHaveBeenCalledWith('ＫＡＩ', undefined))
    expect(router.state.location.search).toMatchObject({ q: 'ＫＡＩ' })

    const results = within(await screen.findByRole('region', { name: '検索結果' }))
    expect(results.getByRole('status').textContent).toContain('2 件')
    expect(screen.queryByRole('region', { name: '本' })).toBeNull()
    expect(results.getByRole('button', { name: /第1巻/ }).textContent).toContain('蔵書 › 漫画 › 光の階段')

    fireEvent.click(results.getByRole('button', { name: /第1巻/ }))
    await vi.waitFor(() => expect(router.state.location.pathname).toMatch(/^\/viewer\//))
    expect(router.state.location.search).toEqual({ path: hit({}).path })
  })

  it('「このフォルダの中だけ」で表示中のフォルダに絞って探し、フォルダの結果はその中を表示する', async () => {
    library.searchLibrary.mockResolvedValue({
      hits: [hit({ kind: 'folder', format: null, name: '外伝', title: '外伝', folder: '漫画/光の階段' })],
      truncated: false,
      indexing: true,
    })
    const router = await renderFolder()
    fireEvent.click(screen.getByRole('checkbox', { name: 'このフォルダの中だけ' }))
    fireEvent.change(screen.getByRole('searchbox', { name: '書名・パスで探す' }), { target: { value: '外伝' } })
    fireEvent.keyDown(screen.getByRole('searchbox', { name: '書名・パスで探す' }), { key: 'Enter' })
    await vi.waitFor(() =>
      expect(library.searchLibrary).toHaveBeenCalledWith('外伝', { sourceId: 1, path: '漫画/光の階段' }),
    )
    const results = within(await screen.findByRole('region', { name: '検索結果' }))
    // 索引を作っている途中はその旨を添える。
    expect(results.getByRole('status').textContent).toContain('索引を作っている途中')

    fireEvent.click(results.getByRole('link', { name: /外伝/ }))
    await vi.waitFor(() =>
      expect(router.state.location.search).toEqual({ source: 1, path: '漫画/光の階段/外伝' }),
    )
  })

  it('結果を見せている間にフォルダを登録すると同じ語で探し直し、索引ができるまで読み直す', async () => {
    const added: LibrarySource = { ...source, id: 2, path: 'D:/別の蔵書', displayPath: 'D:/別の蔵書', name: '別の蔵書' }
    const found = hit({ sourceId: 2, sourceName: '別の蔵書', path: 'D:/別の蔵書/第1巻.cbz', folder: '' })
    library.searchLibrary
      .mockResolvedValueOnce({ hits: [], truncated: false, indexing: false })
      .mockResolvedValueOnce({ hits: [], truncated: false, indexing: true })
      .mockResolvedValue({ hits: [found], truncated: false, indexing: false })
    library.addSource.mockImplementation((path) => {
      library.sources = [source, added]
      return Promise.resolve({ ...added, path })
    })
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/folders?q=%E7%AC%AC1%E5%B7%BB'] }),
    })
    await router.load()
    render(<RouterProvider router={router} />)
    const results = within(await screen.findByRole('region', { name: '検索結果' }))
    await vi.waitFor(() => expect(results.getByRole('status').textContent).toContain('ありません'))

    fireEvent.click(screen.getByRole('button', { name: 'フォルダを登録' }))
    const pathField = screen.getByRole('textbox', { name: 'フォルダのパス' })
    fireEvent.change(pathField, { target: { value: 'D:/別の蔵書' } })
    fireEvent.submit(pathField.closest('form')!)

    // 登録の後に同じ語で探し直し、索引を作っている途中なので間を置いて読み直す。
    await vi.waitFor(() => expect(library.searchLibrary).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(library.searchLibrary).toHaveBeenCalledTimes(3), { timeout: 3000 })
    expect(library.searchLibrary.mock.calls.every(([query]) => query === '第1巻')).toBe(true)
    await vi.waitFor(() => expect(results.getByRole('button', { name: /第1巻/ }).textContent).toContain('別の蔵書'))
  })

  it('検索語が外から消えると入力も空になり、消えた語で探し直さない', async () => {
    library.searchLibrary.mockResolvedValue({ hits: [hit({})], truncated: false, indexing: false })
    const router = await renderFolder()
    const field = screen.getByRole('searchbox', { name: '書名・パスで探す' }) as HTMLInputElement
    fireEvent.change(field, { target: { value: '第1巻' } })
    await vi.waitFor(() => expect(router.state.location.search).toMatchObject({ q: '第1巻' }))

    await router.navigate({ to: '/folders', search: (previous) => ({ ...previous, q: undefined }) })
    await vi.waitFor(() => expect(field.value).toBe(''))
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(router.state.location.search).not.toHaveProperty('q')
  })
})
