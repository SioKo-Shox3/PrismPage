import { describe, expect, it } from 'vitest'

import type { HistoryEntry } from '@/types/app'

import { groupByDay, lastReadLabel, pagePositionLabel, readingProgress, volumeLabel } from './reading-list'

function entry(itemId: number, lastReadAt: number): HistoryEntry {
  return {
    itemId,
    name: `${itemId}.cbz`,
    title: String(itemId),
    path: `C:\\${itemId}.cbz`,
    format: 'zip',
    folder: '漫画',
    folderPath: 'C:\\漫画',
    page: 0,
    pageCount: 10,
    lastReadAt,
    available: true,
    thumbId: null,
  }
}

const now = new Date(2026, 8, 25, 15, 0).getTime()

describe('巻の読み取り', () => {
  it('よくある書き方から巻を読み、読めない書名は null', () => {
    expect(volumeLabel('光の階段 第3巻')).toBe('第3巻')
    expect(volumeLabel('光の階段 ３巻')).toBe('第3巻')
    expect(volumeLabel('月刊 色見本 第12号')).toBe('第12号')
    expect(volumeLabel('物語 上巻')).toBe('上巻')
    expect(volumeLabel('Stairs of Light Vol.04')).toBe('第4巻')
    expect(volumeLabel('stairs_02')).toBe('第2巻')
    expect(volumeLabel('試し読み 光の階段')).toBeNull()
    // 年のような 4 桁の数字は巻にしない。
    expect(volumeLabel('画集 2019')).toBeNull()
  })
})

describe('ページ位置と進み具合', () => {
  it('1 始まりで示し、ページ数が分からなければ位置だけ', () => {
    expect(pagePositionLabel({ page: 11, pageCount: 40 })).toBe('12 / 40 ページ')
    expect(pagePositionLabel({ page: 4, pageCount: null })).toBe('5 ページ目')
    expect(readingProgress({ page: 9, pageCount: 10 })).toBe(1)
    expect(readingProgress({ page: 4, pageCount: null })).toBe(0)
  })
})

describe('最終閲覧と日付のまとまり', () => {
  it('相対表示は分・時間・昨日・日数、1 週間より前は日付', () => {
    expect(lastReadLabel(now - 10 * 1000, now)).toBe('たった今')
    expect(lastReadLabel(now - 15 * 60 * 1000, now)).toBe('15 分前')
    expect(lastReadLabel(now - 3 * 60 * 60 * 1000, now)).toBe('3 時間前')
    expect(lastReadLabel(new Date(2026, 8, 24, 23, 0).getTime(), now)).toBe('昨日')
    expect(lastReadLabel(new Date(2026, 8, 21, 9, 0).getTime(), now)).toBe('4 日前')
    expect(lastReadLabel(new Date(2026, 7, 1, 9, 0).getTime(), now)).toBe('8月1日(土)')
    expect(lastReadLabel(new Date(2025, 11, 31, 9, 0).getTime(), now)).toBe('2025年12月31日(水)')
  })

  it('新しい順の履歴を、順序を保ったまま日付ごとに分ける', () => {
    const entries = [
      entry(1, new Date(2026, 8, 25, 14, 0).getTime()),
      entry(2, new Date(2026, 8, 25, 0, 5).getTime()),
      entry(3, new Date(2026, 8, 24, 23, 59).getTime()),
      entry(4, new Date(2026, 8, 20, 12, 0).getTime()),
    ]
    const days = groupByDay(entries, now)
    expect(days.map((day) => [day.label, day.entries.map((item) => item.itemId)])).toEqual([
      ['今日', [1, 2]],
      ['昨日', [3]],
      ['9月20日(日)', [4]],
    ])
  })
})
