import { useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { open } from '@tauri-apps/plugin-dialog'
import { BookImage, Import, LibraryBig, Sparkles } from 'lucide-react'

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
          <h1>画像重視の本棚</h1>
          <p>
            EPUB を取り込み、表紙と進捗を管理しながら、必要なページだけ高精細化できます。
          </p>
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
            <Sparkles size={18} />
            AI 設定
          </Link>
        </div>
      </header>

      <section className="hero-panel">
        <div className="field-stack">
          <span className="eyebrow">Overview</span>
          <h2>EPUB の閲覧と AI 超解像を一つのデスクトップ体験に統合</h2>
          <p>
            PrismPage は漫画・画集・スキャン系 EPUB に合わせて、表紙の管理、読書位置の保存、
            画像拡大、AI エンジン切り替えをひとつの UI にまとめます。
          </p>

          <div className="hero-grid">
            <div className="hero-stat">
              <span className="eyebrow">Books</span>
              <strong>{books.length}</strong>
              <span className="muted">登録済み</span>
            </div>
            <div className="hero-stat">
              <span className="eyebrow">Ready</span>
              <strong>{books.filter((book) => (book.progressPercentage ?? 0) > 0).length}</strong>
              <span className="muted">読書中</span>
            </div>
            <div className="hero-stat">
              <span className="eyebrow">Focus</span>
              <strong>AI</strong>
              <span className="muted">画像重視</span>
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="section-header">
            <LibraryBig size={18} />
            <div>
              <h2>この MVP の到達点</h2>
              <p>ライブラリ・読書画面・AI 設定・インストール支援を一通り操作できます。</p>
            </div>
          </div>
          <div className="info-list">
            <div className="hero-stat">
              <strong>1</strong>
              <span className="muted">ローカル EPUB 取込</span>
            </div>
            <div className="hero-stat">
              <strong>2</strong>
              <span className="muted">画像クリックで拡大表示</span>
            </div>
            <div className="hero-stat">
              <strong>3</strong>
              <span className="muted">waifu2x / Real-ESRGAN 切替</span>
            </div>
          </div>
        </div>
      </section>

      {error ? <div className="message-strip is-error">{error}</div> : null}

      <section className="panel">
        <div className="section-header">
          <BookImage size={18} />
          <div>
            <h2>ライブラリ</h2>
            <p>最新の読書位置順に並びます。表紙は初回取り込み時に EPUB から抽出します。</p>
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
