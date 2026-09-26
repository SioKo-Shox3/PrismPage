import { describe, expect, it } from 'vitest'

import { LIST_ORDER_VERSION, defaultListOrder, migrateListOrder, orderFolders, orderItems, readStatus, type OrderableItem } from './list-order'

function book(name: string, values: Partial<OrderableItem> = {}): OrderableItem {
  return { name, modifiedAt: null, page: null, pageCount: null, lastReadAt: null, ...values }
}

const unread = book('第10巻.cbz', { modifiedAt: 300 })
const reading = book('第2巻.cbz', { modifiedAt: 100, page: 3, pageCount: 10, lastReadAt: 2000 })
const finished = book('第1巻.cbz', { modifiedAt: 200, page: 9, pageCount: 10, lastReadAt: 1000 })
// ページ数の分からない本は、どこまで進んでも読みかけ。
const unknownLength = book('ｂ画集', { page: 40, pageCount: null, lastReadAt: 1500 })
const books = [unread, reading, finished, unknownLength]

const names = (items: OrderableItem[]) => items.map((item) => item.name)

describe('読書の状態', () => {
  it('開いたことが無ければ未読、最後のページまで進めば読了、それ以外は読みかけ', () => {
    expect(readStatus(unread)).toBe('unread')
    expect(readStatus(reading)).toBe('reading')
    expect(readStatus(finished)).toBe('finished')
    expect(readStatus(unknownLength)).toBe('reading')
    // 最初のページで閉じた本も開いたことがあるので読みかけ。
    expect(readStatus(book('x', { page: 0, pageCount: 10, lastReadAt: 1 }))).toBe('reading')
  })
})

describe('並び替え', () => {
  it('名前は数を数として比べ、全角半角・大文字小文字を区別しない', () => {
    expect(names(orderItems(books, 'name'))).toEqual(['ｂ画集', '第1巻.cbz', '第2巻.cbz', '第10巻.cbz'])
    expect(names(orderItems([book('B'), book('a'), book('Ｃ')], 'name'))).toEqual(['a', 'B', 'Ｃ'])
  })

  it('更新日は新しい順で、更新日の分からない本は後ろ', () => {
    expect(names(orderItems(books, 'modified'))).toEqual(['第10巻.cbz', '第1巻.cbz', '第2巻.cbz', 'ｂ画集'])
  })

  it('最近読んだは最終閲覧の新しい順で、読んだことの無い本は名前順で後ろ', () => {
    const more = [...books, book('第3巻.cbz')]
    expect(names(orderItems(more, 'recent'))).toEqual([
      '第2巻.cbz',
      'ｂ画集',
      '第1巻.cbz',
      '第3巻.cbz',
      '第10巻.cbz',
    ])
  })

  it('元の配列を変えない', () => {
    const before = [...books]
    orderItems(books, 'modified', 'reading')
    expect(books).toEqual(before)
  })

  it('フォルダは最近読んだの指定では名前順、更新日の指定では新しい順', () => {
    const folders = [
      { name: 'b 外伝', modifiedAt: 30 },
      { name: 'a 本編', modifiedAt: 10 },
    ]
    expect(orderFolders(folders, 'name')).toEqual([folders[1], folders[0]])
    expect(orderFolders(folders, 'recent')).toEqual([folders[1], folders[0]])
    expect(orderFolders(folders, 'modified')).toEqual([folders[0], folders[1]])
  })
})

describe('絞り込み', () => {
  it('未読・読みかけ・読了で本を絞り、並び順は保つ', () => {
    expect(names(orderItems(books, 'name', 'unread'))).toEqual(['第10巻.cbz'])
    expect(names(orderItems(books, 'recent', 'reading'))).toEqual(['第2巻.cbz', 'ｂ画集'])
    expect(names(orderItems(books, 'name', 'finished'))).toEqual(['第1巻.cbz'])
    expect(orderItems(books, 'name', 'all')).toHaveLength(books.length)
  })
})

describe('並び順の保存形式', () => {
  it('同じ版は画面ごとの並び順を読み、知らない値は既定値にする', () => {
    expect(migrateListOrder({ sorts: { folders: 'recent', shelves: 'modified' } }, LIST_ORDER_VERSION)).toEqual({
      sorts: { folders: 'recent', shelves: 'modified' },
    })
    expect(migrateListOrder({ sorts: { folders: 'size', shelves: 3 } }, LIST_ORDER_VERSION)).toEqual(defaultListOrder)
  })

  it('版の違う保存は移行せず既定値に戻す', () => {
    expect(migrateListOrder({ sorts: { folders: 'recent', shelves: 'recent' } }, 0)).toEqual(defaultListOrder)
    expect(migrateListOrder({ sorts: { folders: 'recent' } }, LIST_ORDER_VERSION + 1)).toEqual(defaultListOrder)
    expect(migrateListOrder(null, LIST_ORDER_VERSION)).toEqual(defaultListOrder)
  })
})
