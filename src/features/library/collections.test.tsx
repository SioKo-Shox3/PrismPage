import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { routeTree } from '@/app/router'
import { mockInvoke } from '@/lib/tauri-mock'
import type { BookCollections, Shelf } from '@/types/app'

import { defaultListOrder, useListOrderStore } from './list-order'

// 本棚・お気に入りの command はブラウザ確認用のモック(Rust の command と同じ約束で答える)に答えさせる。
vi.mock('@/lib/tauri', async (importOriginal) => {
  const { mockInvoke: invoke } = await import('@/lib/tauri-mock')
  return {
    ...(await importOriginal<typeof import('@/lib/tauri')>()),
    hasCommandBackend: true,
    listDirectory: (sourceId: number, path?: string) => invoke('list_directory', { sourceId, path }),
    listSources: () => invoke('list_sources'),
    listShelves: () => invoke('list_shelves'),
    createShelf: (name: string) => invoke('create_shelf', { name }),
    renameShelf: (shelfId: number, name: string) => invoke('rename_shelf', { shelfId, name }),
    deleteShelf: (shelfId: number) => invoke('delete_shelf', { shelfId }),
    listShelfBooks: (shelfId: number) => invoke('list_shelf_books', { shelfId }),
    listFavorites: () => invoke('list_favorites'),
    getBookCollections: (path: string) => invoke('get_book_collections', { path }),
    addToShelf: (shelfId: number, path: string) => invoke('add_to_shelf', { shelfId, path }),
    removeFromShelf: (shelfId: number, path: string) => invoke('remove_from_shelf', { shelfId, path }),
    setFavorite: (path: string, favorite: boolean) => invoke('set_favorite', { path, favorite }),
    openBook: () => new Promise(() => {}),
  }
})

const artbookPath = '\\\\?\\C:\\PrismPageMock\\蔵書\\画集\\色見本帳'

beforeAll(() => {
  // jsdom の <dialog> には showModal / close が無い。
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false
  }
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  useListOrderStore.setState({ sorts: { ...defaultListOrder.sorts } })
})

async function renderAt(path: string) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  await router.load()
  render(<RouterProvider router={router} />)
  return router
}

async function shelfByName(name: string) {
  const shelves = await mockInvoke<Shelf[]>('list_shelves')
  return shelves.find((shelf) => shelf.name === name)
}

describe('本のメニュー', () => {
  it('フォルダの本を右クリックして、お気に入りを外し、本棚から外し、新しい本棚を作って入れられる', async () => {
    await renderAt('/folders?source=1&path=%22%E7%94%BB%E9%9B%86%22')

    const card = await screen.findByRole('button', { name: /^色見本帳/ })
    fireEvent.contextMenu(card, { clientX: 200, clientY: 200 })
    const menu = await screen.findByRole('menu', { name: '色見本帳 の本棚とお気に入り' })

    // 最初はお気に入りと「画集と資料」に入っている。
    fireEvent.click(await within(menu).findByRole('menuitemcheckbox', { name: 'お気に入りから外す' }))
    await within(menu).findByRole('menuitemcheckbox', { name: 'お気に入りに入れる' })
    const shelf = within(menu).getByRole('menuitemcheckbox', { name: /画集と資料/ })
    expect(shelf.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(shelf)
    await waitFor(() => expect(shelf.getAttribute('aria-checked')).toBe('false'))

    fireEvent.click(within(menu).getByRole('menuitem', { name: '新しい本棚を作って入れる…' }))
    fireEvent.change(within(menu).getByRole('textbox', { name: '新しい本棚の名前' }), {
      target: { value: '  試しの棚  ' },
    })
    fireEvent.click(within(menu).getByRole('button', { name: '作って入れる' }))
    const created = await within(menu).findByRole('menuitemcheckbox', { name: /試しの棚/ })
    expect(created.getAttribute('aria-checked')).toBe('true')

    const collections = await mockInvoke<BookCollections>('get_book_collections', { path: artbookPath })
    const newShelf = await shelfByName('試しの棚')
    expect(collections).toEqual({ favorite: false, shelfIds: [newShelf?.id] })

    // Esc で閉じる。
    fireEvent.keyDown(created, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })
})

describe('本棚', () => {
  it('見つからない本も棚に残して「見つかりません」と見せ、背表紙と表紙を切り替えられる', async () => {
    const shelf = await shelfByName('光の階段')
    await renderAt(`/shelves?shelf=${shelf?.id}`)

    const spines = await screen.findByRole('list', { name: '本(背表紙)' })
    const missing = within(spines).getByRole('button', { name: '手放した本 第1巻(見つかりません)' })
    expect(missing.getAttribute('aria-disabled')).toBe('true')
    // RAR は Rust と同じく開ける本として扱う。
    const rar = within(spines).getByRole('button', { name: '古い合本' })
    expect(rar.getAttribute('aria-disabled')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '表紙' }))
    const covers = await screen.findByRole('list', { name: '本(表紙)' })
    expect(within(covers).getAllByRole('listitem')).toHaveLength(shelf?.bookCount ?? -1)
    expect(within(covers).getByText('見つかりません')).toBeTruthy()
    expect(screen.queryByRole('list', { name: '本(背表紙)' })).toBeNull()
  })

  it('RAR・PDF の本も押すとビューアで開く', async () => {
    const pdfShelf = await shelfByName('画集と資料')
    const router = await renderAt(`/shelves?shelf=${pdfShelf?.id}&view=spines`)
    const spines = await screen.findByRole('list', { name: '本(背表紙)' })
    const pdf = within(spines).getByRole('button', { name: '資料集' })
    expect(pdf.getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(pdf)
    await waitFor(() => expect(router.state.location.pathname).toBe('/viewer/資料集.pdf'))
    cleanup()

    const rarShelf = await shelfByName('光の階段')
    const rarRouter = await renderAt(`/shelves?shelf=${rarShelf?.id}&view=spines`)
    const rarSpines = await screen.findByRole('list', { name: '本(背表紙)' })
    fireEvent.click(within(rarSpines).getByRole('button', { name: '古い合本' }))
    await waitFor(() => expect(rarRouter.state.location.pathname).toBe('/viewer/古い合本.rar'))
  })

  it('本棚の本を並び替えて絞り込み、並び順は本棚画面の分として覚える', async () => {
    const shelf = await shelfByName('光の階段')
    await renderAt(`/shelves?shelf=${shelf?.id}&view=spines`)
    const spines = await screen.findByRole('list', { name: '本(背表紙)' })
    const titles = () =>
      within(spines)
        .getAllByRole('button')
        .map((button) => button.querySelector('span')?.textContent)

    fireEvent.change(screen.getByRole('combobox', { name: '並び順' }), { target: { value: 'recent' } })
    // 最近読んだ順(読みかけ 2 時間前 → 3 日前 → 21 日前)、読んだことの無い本は後ろ。
    expect(titles()).toEqual(['試し読み 光の階段', '走査の練習帳', '手放した本 第1巻', '古い合本', '単話 光の階段 番外編'])
    expect(useListOrderStore.getState().sorts).toEqual({ folders: 'name', shelves: 'recent' })

    fireEvent.change(screen.getByRole('combobox', { name: '絞り込み' }), { target: { value: 'unread' } })
    expect(titles()).toEqual(['古い合本', '単話 光の階段 番外編'])
    fireEvent.change(screen.getByRole('combobox', { name: '絞り込み' }), { target: { value: 'finished' } })
    expect(screen.queryByRole('list', { name: '本(背表紙)' })).toBeNull()
    expect(screen.getByText('絞り込みに合う本はありません。')).toBeTruthy()
  })

  it('本棚を作り、名前を変え、消せる(消しても本の記録は残る)', async () => {
    await renderAt('/shelves')
    await screen.findByRole('navigation', { name: '本棚の一覧' })

    fireEvent.click(screen.getByRole('button', { name: '本棚を作る' }))
    fireEvent.change(await screen.findByRole('textbox', { name: '本棚の名前' }), { target: { value: '週末' } })
    fireEvent.click(screen.getByRole('button', { name: '作る' }))
    await screen.findByRole('heading', { level: 2, name: '週末' })

    fireEvent.click(screen.getByRole('button', { name: '週末 の名前を変える' }))
    const input = await screen.findByRole('textbox', { name: '本棚の名前' })
    expect((input as HTMLInputElement).value).toBe('週末')
    fireEvent.change(input, { target: { value: '連休' } })
    fireEvent.click(screen.getByRole('button', { name: '変える' }))
    await screen.findByRole('heading', { level: 2, name: '連休' })

    const tabs = screen.getByRole('navigation', { name: '本棚の一覧' })
    const shelf = await shelfByName('連休')
    await mockInvoke('add_to_shelf', { shelfId: shelf?.id, path: artbookPath })
    fireEvent.click(screen.getByRole('button', { name: '連休 を消す' }))
    fireEvent.click(await screen.findByRole('button', { name: '消す' }))
    await waitFor(() => expect(within(tabs).queryByRole('button', { name: /連休/ })).toBeNull())
    expect(await shelfByName('連休')).toBeUndefined()
    // 消した本棚に入っていた本も、別の本棚・記録からは消えない。
    const collections = await mockInvoke<BookCollections>('get_book_collections', { path: artbookPath })
    expect(collections.shelfIds.length).toBeGreaterThan(0)
  })
})
