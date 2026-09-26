import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { BookImage, BookOpen, Trash2 } from 'lucide-react'

import { Badge, Button, Dialog, IconButton, ProgressLine } from '@/design'
import { clearHistory, listContinueReading, listHistory, removeHistoryEntry } from '@/lib/tauri'
import type { HistoryEntry } from '@/types/app'

import { useBookMenu } from './use-book-menu'
import { CoverImage } from './folders-page'
import {
  bookFormatLabel,
  groupByDay,
  lastReadLabel,
  pagePositionLabel,
  readingProgress,
  volumeLabel,
} from './reading-list'
import styles from './reading-pages.module.css'

// 読みかけ(ホーム)と履歴の画面。どちらも開いた本の記録を最終閲覧の新しい順に並べる。
// 履歴の削除は記録を消すだけで、本のファイルには触れない。

type LoadState =
  | { status: 'loading' }
  // `now` は読み込んだ時刻。最終閲覧の相対表示(「3 時間前」)の基準にする。
  | { status: 'ready'; entries: HistoryEntry[]; now: number }
  | { status: 'error'; message: string }

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

// 一覧を読み込む。`reload` で読み直す。
// 一覧の取得は読書位置の保存の列が空くのを待ってから読む(`@/lib/tauri` のラッパーが待つ)。
function useEntries(load: () => Promise<HistoryEntry[]>, fallback: string) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    let cancelled = false
    load().then(
      (entries) => {
        if (!cancelled) setState({ status: 'ready', entries, now: Date.now() })
      },
      (loadError: unknown) => {
        if (!cancelled) setState({ status: 'error', message: messageOf(loadError, fallback) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [load, fallback, generation])

  const reload = useCallback(() => setGeneration((value) => value + 1), [])
  return { state, reload }
}

// 本をビューアで開く。Esc で戻るとこの画面に戻る。
function useOpenEntry() {
  const navigate = useNavigate()
  return (entry: HistoryEntry) => {
    void navigate({
      to: '/viewer/$bookId',
      params: { bookId: entry.name },
      search: { path: entry.path },
    })
  }
}

// 表紙。サムネイルを読み込むまでと、本が見つからないときは形式を書いた仮の面を見せる。
function Cover({ entry, className }: { entry: HistoryEntry; className?: string }) {
  return (
    <span className={[styles.cover, className].filter(Boolean).join(' ')} aria-hidden="true">
      <BookImage size={22} className={styles.coverIcon} />
      <span className={styles.coverFormat}>{bookFormatLabel(entry)}</span>
      {entry.thumbId ? <CoverImage thumbId={entry.thumbId} /> : null}
    </span>
  )
}

// 巻・形式・フォルダの並び。
function EntryFacts({ entry }: { entry: HistoryEntry }) {
  const volume = volumeLabel(entry.title)
  return (
    <span className={styles.facts}>
      {volume ? <span className={styles.volume}>{volume}</span> : null}
      <span>{bookFormatLabel(entry)}</span>
      <span className={styles.folder} title={entry.folderPath}>
        {entry.folder}
      </span>
    </span>
  )
}

function MissingBadge() {
  return (
    <Badge tone="warning" className={styles.missing}>
      見つかりません
    </Badge>
  )
}

export function ContinueReadingPage() {
  const { state } = useEntries(listContinueReading, '読みかけの本を読み込めませんでした。')
  const open = useOpenEntry()
  const menu = useBookMenu()
  const now = state.status === 'ready' ? state.now : 0
  const entries = state.status === 'ready' ? state.entries : []

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>読みかけ</h1>
          {state.status === 'ready' && entries.length > 0 ? (
            <p className={styles.lead}>{entries.length} 冊・最後に読んだ順</p>
          ) : null}
        </div>
      </header>

      {state.status === 'error' ? (
        <p className={styles.message} role="alert">
          {state.message}
        </p>
      ) : null}

      {state.status === 'ready' && entries.length === 0 ? (
        <div className={styles.empty}>
          <p>読みかけの本はありません。</p>
          <p className={styles.muted}>
            <Link to="/folders" search={{}}>
              フォルダ
            </Link>
            から本を開くと、続きから読める本がここに並びます。
          </p>
        </div>
      ) : null}

      {entries.length > 0 ? (
        <ol className={styles.readingList} aria-label="読みかけの本">
          {entries.map((entry, index) => (
            <li
              key={entry.itemId}
              className={[styles.readingItem, index === 0 ? styles.featured : null]
                .filter(Boolean)
                .join(' ')}
              onContextMenu={(event) => menu.openAtPointer(event, entry)}
            >
              <button
                type="button"
                className={styles.coverButton}
                onClick={() => open(entry)}
                disabled={!entry.available}
                tabIndex={-1}
                aria-hidden="true"
              >
                <Cover entry={entry} />
              </button>
              <div className={styles.readingBody}>
                {index === 0 ? <p className={styles.eyebrow}>最後に読んだ本</p> : null}
                <h2 className={styles.bookTitle} title={entry.name}>
                  {entry.title}
                </h2>
                <EntryFacts entry={entry} />
                <div className={styles.progress}>
                  <ProgressLine
                    value={readingProgress(entry)}
                    label={`${entry.title} の進み具合`}
                    className={styles.progressLine}
                  />
                  <p className={styles.position}>
                    <span>{pagePositionLabel(entry)}</span>
                    <span className={styles.lastRead}>{lastReadLabel(entry.lastReadAt, now)}</span>
                  </p>
                </div>
                <div className={styles.actions}>
                  {entry.available ? null : <MissingBadge />}
                  <Button
                    variant={index === 0 ? 'primary' : 'secondary'}
                    size={index === 0 ? 'md' : 'sm'}
                    onClick={() => open(entry)}
                    disabled={!entry.available}
                    aria-label={`${entry.title} の続きを読む`}
                  >
                    <BookOpen size={14} aria-hidden="true" />
                    続きを読む
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      {menu.menu}
    </div>
  )
}

export function HistoryPage() {
  const { state, reload } = useEntries(listHistory, '履歴を読み込めませんでした。')
  const open = useOpenEntry()
  const menu = useBookMenu()
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const now = state.status === 'ready' ? state.now : 0
  const entries = state.status === 'ready' ? state.entries : []

  const remove = async (entry: HistoryEntry) => {
    setActionError(null)
    try {
      await removeHistoryEntry(entry.itemId)
    } catch (removeError) {
      setActionError(messageOf(removeError, '履歴から消せませんでした。'))
    }
    reload()
  }

  const clearAll = async () => {
    setBusy(true)
    setActionError(null)
    try {
      await clearHistory()
      setConfirmingClear(false)
    } catch (clearError) {
      setActionError(messageOf(clearError, '履歴を消せませんでした。'))
    } finally {
      setBusy(false)
      reload()
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>履歴</h1>
          {state.status === 'ready' && entries.length > 0 ? (
            <p className={styles.lead}>{entries.length} 冊・開いた日の新しい順</p>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setConfirmingClear(true)}
          disabled={entries.length === 0}
        >
          <Trash2 size={14} aria-hidden="true" />
          履歴をすべて消す
        </Button>
      </header>

      {state.status === 'error' ? (
        <p className={styles.message} role="alert">
          {state.message}
        </p>
      ) : null}
      {actionError && !confirmingClear ? (
        <p className={styles.message} role="alert">
          {actionError}
        </p>
      ) : null}

      {state.status === 'ready' && entries.length === 0 ? (
        <div className={styles.empty}>
          <p>履歴はありません。</p>
          <p className={styles.muted}>本を開くと、開いた日ごとにここへ並びます。</p>
        </div>
      ) : null}

      {groupByDay(entries, now).map((day) => (
        <section key={day.key} className={styles.day} aria-label={day.label}>
          <h2 className={styles.dayLabel}>{day.label}</h2>
          <ul className={styles.historyList}>
            {day.entries.map((entry) => (
              <li
                key={entry.itemId}
                className={styles.historyItem}
                onContextMenu={(event) => menu.openAtPointer(event, entry)}
              >
                <button
                  type="button"
                  className={styles.historyOpen}
                  onClick={() => open(entry)}
                  disabled={!entry.available}
                  title={entry.available ? entry.name : `${entry.name}(見つかりません)`}
                >
                  <Cover entry={entry} className={styles.historyCover} />
                  <span className={styles.historyBody}>
                    <span className={styles.historyTitle}>{entry.title}</span>
                    <EntryFacts entry={entry} />
                  </span>
                  <span className={styles.historyMeta}>
                    {entry.available ? null : <MissingBadge />}
                    <span>{pagePositionLabel(entry)}</span>
                    <span className={styles.lastRead}>{timeOfDay(entry.lastReadAt)}</span>
                  </span>
                </button>
                <IconButton
                  icon={Trash2}
                  size="sm"
                  label={`${entry.title} を履歴から消す`}
                  onClick={() => void remove(entry)}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}

      {menu.menu}

      <Dialog
        open={confirmingClear}
        title="履歴をすべて消す"
        onClose={() => {
          setConfirmingClear(false)
          setActionError(null)
        }}
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmingClear(false)}>
              キャンセル
            </Button>
            <Button variant="primary" onClick={() => void clearAll()} disabled={busy}>
              すべて消す
            </Button>
          </>
        }
      >
        <p>
          開いた本の記録 {entries.length} 件と、それぞれの読書位置を消します。本のファイルは消えません。
        </p>
        {actionError && confirmingClear ? <p role="alert">{actionError}</p> : null}
      </Dialog>
    </div>
  )
}

// 時刻(「14:05」)。
function timeOfDay(time: number) {
  const date = new Date(time)
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`
}
