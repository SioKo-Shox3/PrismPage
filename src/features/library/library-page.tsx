import { useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { open } from '@tauri-apps/plugin-dialog'
import { BookImage, Import, LibraryBig, Settings2 } from 'lucide-react'

import { useLibraryStore } from '@/features/library/book-store'
import { extractEpubPreview } from '@/lib/epub'
import { importEpubFromPath, readBookBase64 } from '@/lib/tauri'

function getPathKey(path: string) {
  return path.trim().replace(/\//g, '\\').toLowerCase()
}

export function LibraryPage() {
  const books = useLibraryStore((state) => state.books)
  const upsertBook = useLibraryStore((state) => state.upsertBook)
  const [isImporting, setIsImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sortedBooks = useMemo(
    () =>
      [...books].sort(
        (left, right) =>
          (right.lastOpenedAt ?? right.importedAt) - (left.lastOpenedAt ?? left.importedAt),
      ),
    [books],
  )

  async function handleImportBook() {
    const selectedPath = await open({
      directory: false,
      filters: [{ name: 'EPUB', extensions: ['epub'] }],
      multiple: false,
      title: 'EPUB ファイルを選択',
    })

    if (typeof selectedPath !== 'string') {
      return
    }

    try {
      setIsImporting(true)
      setError(null)

      const selectedPathKey = getPathKey(selectedPath)
      const existingBook = useLibraryStore
        .getState()
        .books.find((book) => book.sourcePath && getPathKey(book.sourcePath) === selectedPathKey)

      if (existingBook) {
        setError(`既に取り込み済みの EPUB です: ${existingBook.title}`)
        return
      }

      const imported = await importEpubFromPath(selectedPath)
      const importedPathKey = getPathKey(imported.sourcePath)
      const duplicateBook = useLibraryStore
        .getState()
        .books.find((book) => book.sourcePath && getPathKey(book.sourcePath) === importedPathKey)

      if (duplicateBook) {
        setError(`既に取り込み済みの EPUB です: ${duplicateBook.title}`)
        return
      }

      const base64 = await readBookBase64(imported.id)
      const preview = await extractEpubPreview(base64)

      upsertBook({
        author: preview.author,
        coverDataUrl: preview.coverDataUrl,
        fileName: imported.fileName,
        id: imported.id,
        importedAt: Date.now(),
        size: imported.size,
        sourcePath: imported.sourcePath,
        storedPath: imported.storedPath,
        title: preview.title || imported.fileName.replace(/\.epub$/i, ''),
      })
    } catch (importError) {
      setError(
        importError instanceof Error
          ? importError.message
          : 'EPUB の取り込みに失敗しました。',
      )
    } finally {
      setIsImporting(false)
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <span className="eyebrow">Library</span>
          <h1>本棚</h1>
          <p>EPUB を追加すると表紙と読書位置を保存します。読書中の画像は設定中の AI エンジンで自動処理します。</p>
        </div>

        <div className="button-group">
          <button
            type="button"
            className="button"
            onClick={() => void handleImportBook()}
            disabled={isImporting}
          >
            <Import size={18} />
            {isImporting ? '取り込み中...' : 'EPUB を追加'}
          </button>
          <Link to="/settings" className="ghost-button">
            <Settings2 size={18} />
            設定
          </Link>
        </div>
      </header>

      {error ? <div className="message-strip is-error">{error}</div> : null}

      <section className="panel">
        <div className="section-header">
            <BookImage size={18} />
            <div>
            <h2>登録済み EPUB</h2>
            <p>{books.length} 冊。最近開いた順に並びます。</p>
            </div>
          </div>

        {sortedBooks.length === 0 ? (
          <div className="empty-state">
            <LibraryBig size={42} />
            <h3>まだ本がありません</h3>
            <p>「EPUB を追加」からローカルファイルを取り込んで、本棚を作り始めてください。</p>
          </div>
        ) : (
          <div className="book-grid">
            {sortedBooks.map((book) => (
              <article key={book.id} className="book-card">
                <div className="book-cover">
                  {book.coverDataUrl ? (
                    <img src={book.coverDataUrl} alt={`${book.title} の表紙`} />
                  ) : (
                    <div className="book-cover-placeholder">
                      <BookImage size={36} />
                      <span>{book.fileName}</span>
                    </div>
                  )}
                </div>

                <div className="field-stack">
                  <h3>{book.title}</h3>
                  <p>{book.author ?? '著者情報なし'}</p>
                  <div className="book-meta">
                    <span className="chip">
                      進捗 {Math.round(book.progressPercentage ?? 0)}%
                    </span>
                    <span className="chip">{(book.size / 1024 / 1024).toFixed(1)} MB</span>
                  </div>
                </div>

                <Link to="/reader/$bookId" params={{ bookId: book.id }} className="button">
                  読書を開く
                </Link>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
