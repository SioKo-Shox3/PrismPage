import type { HistoryEntry } from '@/types/app'

// 読みかけ・履歴の表示に使う純粋関数(巻・ページ位置・最終閲覧・日付ごとのまとまり)。

const dayMs = 24 * 60 * 60 * 1000

// 全角の数字を半角にする。
function toHalfWidthDigits(text: string) {
  return text.replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
}

// 書名から巻を読み取る(「第3巻」「3巻」「上巻」「Vol.3」「#3」、末尾の数字)。読み取れなければ null。
export function volumeLabel(title: string): string | null {
  const text = toHalfWidthDigits(title.normalize('NFKC'))
  const numbered = /第?\s*(\d+)\s*([巻号話集部])/.exec(text)
  if (numbered) return `第${Number(numbered[1])}${numbered[2]}`
  const named = /([上中下前後])\s*巻/.exec(text)
  if (named) return `${named[1]}巻`
  const latin = /(?:\bvol(?:ume)?\.?|#)\s*(\d+)/i.exec(text)
  if (latin) return `第${Number(latin[1])}巻`
  const trailing = /[\s_\-(（[]\s*(\d{1,3})\s*[)）\]]?$/.exec(text)
  if (trailing) return `第${Number(trailing[1])}巻`
  return null
}

// 本の形式の表示名。ZIP・RAR・EPUB・PDF は拡張子(CBZ・CBR を含む)をそのまま見せる。
export function bookFormatLabel(entry: Pick<HistoryEntry, 'format' | 'name'>) {
  if (entry.format === 'folder') return '画像フォルダ'
  const extension = /\.([^.]+)$/.exec(entry.name)?.[1]
  return extension ? extension.toUpperCase() : entry.format.toUpperCase()
}

// ページ位置(「12 / 40 ページ」)。ページ数が分からなければ位置だけ。
export function pagePositionLabel(entry: Pick<HistoryEntry, 'page' | 'pageCount'>) {
  const current = entry.page + 1
  return entry.pageCount ? `${Math.min(current, entry.pageCount)} / ${entry.pageCount} ページ` : `${current} ページ目`
}

// 進み具合(0〜1)。ページ数が分からなければ 0。
export function readingProgress(entry: Pick<HistoryEntry, 'page' | 'pageCount'>) {
  if (!entry.pageCount) return 0
  return Math.min(1, (entry.page + 1) / entry.pageCount)
}

function startOfDay(time: number) {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

// 何日前の日付か(今日は 0、昨日は 1)。夏時間の切り替えでずれないよう丸める。
function daysAgo(time: number, now: number) {
  return Math.round((startOfDay(now) - startOfDay(time)) / dayMs)
}

// 最終閲覧の相対表示(「たった今」「15 分前」「3 時間前」「昨日」「4 日前」、それより前は日付)。
export function lastReadLabel(time: number, now: number) {
  const elapsed = Math.max(0, now - time)
  if (elapsed < 60 * 1000) return 'たった今'
  if (elapsed < 60 * 60 * 1000) return `${Math.floor(elapsed / 60000)} 分前`
  const days = daysAgo(time, now)
  if (days <= 0) return `${Math.floor(elapsed / 3600000)} 時間前`
  if (days === 1) return '昨日'
  if (days < 7) return `${days} 日前`
  return dateLabel(time, now)
}

const weekdays = ['日', '月', '火', '水', '木', '金', '土']

// 日付の表示。今年なら年を省く。
function dateLabel(time: number, now: number) {
  const date = new Date(time)
  const day = `${date.getMonth() + 1}月${date.getDate()}日(${weekdays[date.getDay()]})`
  return date.getFullYear() === new Date(now).getFullYear() ? day : `${date.getFullYear()}年${day}`
}

export interface HistoryDay {
  key: string
  label: string
  entries: HistoryEntry[]
}

// 最終閲覧の新しい順に並んだ履歴を、日付ごとのまとまりに分ける(「今日」「昨日」、それより前は日付)。
export function groupByDay(entries: HistoryEntry[], now: number): HistoryDay[] {
  const days: HistoryDay[] = []
  for (const entry of entries) {
    const key = String(startOfDay(entry.lastReadAt))
    let day = days.at(-1)
    if (!day || day.key !== key) {
      const ago = daysAgo(entry.lastReadAt, now)
      const label = ago <= 0 ? '今日' : ago === 1 ? '昨日' : dateLabel(entry.lastReadAt, now)
      day = { key, label, entries: [] }
      days.push(day)
    }
    day.entries.push(entry)
  }
  return days
}
