import { useEffect, useId, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { BookImage, ChevronRight, Folder, Search } from 'lucide-react'

import { Badge } from '@/design'
import { searchLibrary } from '@/lib/tauri'
import type { LibrarySearchHit, LibrarySearchResult } from '@/types/app'

import { CoverImage } from './folders-page'
import styles from './library-search.module.css'

// フォルダ画面の検索。検索欄と、登録フォルダ全体(または表示中のフォルダの中)の索引から探した結果の一覧。

// 入力を止めてから検索語として確定するまでの待ち(ミリ秒)。
const QUERY_DELAY_MS = 250
// 索引を作っている途中のとき、結果を読み直すまでの間隔(ミリ秒)。
const INDEXING_RETRY_MS = 1500

interface LibrarySearchFieldProps {
  query: string
  onQueryChange: (query: string) => void
  // 表示中のフォルダの中だけを探すか。フォルダを表示していないとき(登録フォルダの一覧)は切り替えを出さない。
  withinFolder?: boolean
  onWithinFolderChange?: (withinFolder: boolean) => void
}

// 検索欄。入力は手元に持ち、打ち終えてから少し待って検索語として渡す(打つたびに URL と検索を動かさない)。
export function LibrarySearchField({
  query,
  onQueryChange,
  withinFolder,
  onWithinFolderChange,
}: LibrarySearchFieldProps) {
  const id = useId()
  const [value, setValue] = useState(query)
  // 検索語が外から変わったとき(戻る・進む、別の画面からの遷移)は入力をそれに合わせる。
  // 合わせないと、消えた検索語が入力に残り、待ちの後にまた確定されてしまう。
  const [shownQuery, setShownQuery] = useState(query)
  if (shownQuery !== query) {
    setShownQuery(query)
    if (value.trim() !== query) setValue(query)
  }

  // 前後の空白は検索語に含めない(空白だけなら検索しない)。
  useEffect(() => {
    if (value.trim() === query) return
    const timer = window.setTimeout(() => onQueryChange(value.trim()), QUERY_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [value, query, onQueryChange])

  return (
    <div className={styles.bar} role="search">
      <label className={styles.field} htmlFor={`${id}-query`}>
        <Search size={16} aria-hidden="true" className={styles.icon} />
        <span className={styles.visuallyHidden}>書名・パスで探す</span>
        <input
          id={`${id}-query`}
          type="search"
          className={styles.input}
          placeholder="書名・パスで探す"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            // Enter はすぐに確定する。
            if (event.key === 'Enter') onQueryChange(value.trim())
          }}
        />
      </label>
      {onWithinFolderChange ? (
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={withinFolder ?? false}
            onChange={(event) => onWithinFolderChange(event.target.checked)}
          />
          このフォルダの中だけ
        </label>
      ) : null}
    </div>
  )
}

type SearchState =
  | { status: 'loading'; key: string }
  | { status: 'ready'; key: string; result: LibrarySearchResult }
  | { status: 'error'; key: string; message: string }

interface LibrarySearchResultsProps {
  query: string
  // 表示中のフォルダの中だけを探すときの場所。無ければ登録フォルダ全体。
  scope?: { sourceId: number; path: string }
  // 登録フォルダの顔ぶれを表す値。変わると(登録・登録の解除)同じ検索語でも探し直す。
  sourcesRevision?: string
}

// 検索結果。本は押すとビューアを開き、フォルダは押すとその中を表示する。
export function LibrarySearchResults({ query, scope, sourcesRevision }: LibrarySearchResultsProps) {
  const navigate = useNavigate()
  const key = `${query}\n${scope ? `${scope.sourceId}\n${scope.path}` : ''}`
  const [state, setState] = useState<SearchState>({ status: 'loading', key })
  const [attempt, setAttempt] = useState(0)
  const current = state.key === key ? state : { status: 'loading' as const, key }

  useEffect(() => {
    let cancelled = false
    let retry: number | undefined
    searchLibrary(query, scope).then(
      (result) => {
        if (cancelled) return
        setState({ status: 'ready', key, result })
        // 索引を作っている途中は、少し待って読み直す(作り終えた分から結果に加わる)。
        if (result.indexing) retry = window.setTimeout(() => setAttempt((count) => count + 1), INDEXING_RETRY_MS)
      },
      (error: unknown) => {
        if (cancelled) return
        setState({
          status: 'error',
          key,
          message: error instanceof Error && error.message ? error.message : '検索できませんでした。',
        })
      },
    )
    return () => {
      cancelled = true
      window.clearTimeout(retry)
    }
    // scope はオブジェクトなので、中身を表す key で読み直しを決める。登録フォルダが変わったときは
    // 今の結果を見せたまま探し直す(登録したフォルダの索引ができるまで、作っている途中として読み直し続ける)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt, sourcesRevision])

  const openBook = (hit: LibrarySearchHit) => {
    void navigate({
      to: '/viewer/$bookId',
      params: { bookId: hit.name },
      search: { path: hit.path },
    })
  }

  if (current.status === 'error') {
    return (
      <p className={styles.message} role="alert">
        {current.message}
      </p>
    )
  }
  if (current.status === 'loading') {
    return (
      <p className={styles.status} role="status">
        探しています…
      </p>
    )
  }

  const { hits, truncated, indexing } = current.result
  return (
    <section aria-label="検索結果" className={styles.results}>
      <p className={styles.status} role="status">
        {hits.length === 0
          ? `「${query}」に合う本・フォルダはありません。`
          : truncated
            ? `「${query}」に合う本・フォルダ(先頭の ${hits.length} 件)`
            : `「${query}」に合う本・フォルダ ${hits.length} 件`}
        {indexing ? ' 索引を作っている途中のため、まだ見つからないものがあります。' : ''}
      </p>
      {hits.length > 0 ? (
        <ul className={styles.list}>
          {hits.map((hit) => (
            <li key={`${hit.sourceId}\n${hit.path}`}>
              {hit.kind === 'folder' ? (
                <Link
                  to="/folders"
                  search={{ source: hit.sourceId, path: hit.folder ? `${hit.folder}/${hit.name}` : hit.name }}
                  className={styles.hit}
                >
                  <span className={styles.folderMark} aria-hidden="true">
                    <Folder size={20} />
                  </span>
                  <HitText hit={hit} />
                  <ChevronRight size={16} aria-hidden="true" className={styles.chevron} />
                </Link>
              ) : (
                <button
                  type="button"
                  className={styles.hit}
                  onClick={() => openBook(hit)}
                  disabled={!hit.openable}
                  title={hit.openable ? hit.name : `${hit.name}(まだ開けない形式です)`}
                >
                  <span className={styles.cover} aria-hidden="true">
                    <BookImage size={18} className={styles.coverIcon} />
                    {hit.thumbId ? <CoverImage thumbId={hit.thumbId} /> : null}
                  </span>
                  <HitText hit={hit} />
                  {hit.openable ? null : <Badge tone="warning">まだ開けない形式</Badge>}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

// 結果の 1 行の文字。書名と、登録フォルダからの場所(登録フォルダ名 › フォルダ › …)。
function HitText({ hit }: { hit: LibrarySearchHit }) {
  const place = [hit.sourceName, ...hit.folder.split('/').filter((segment) => segment.length > 0)].join(' › ')
  return (
    <span className={styles.text}>
      <span className={styles.title}>{hit.title}</span>
      <span className={styles.place}>{place}</span>
    </span>
  )
}
