import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { BookOpenText, ImageUpscale, Library, Settings2 } from 'lucide-react'

import { useLibraryStore } from '@/features/library/book-store'
import { useSettingsStore } from '@/features/settings/settings-store'
import { extractEpubPreview } from '@/lib/epub'
import {
  importEpubFromPath,
  isTauriRuntime,
  readBookBase64,
  takePendingOpenedEpubs,
} from '@/lib/tauri'

const navItems = [
  { label: 'ライブラリ', href: '/', icon: Library },
  { label: '読書設定', href: '/settings', icon: Settings2 },
]

function getPathKey(path: string) {
  return path.trim().replace(/\//g, '\\').toLowerCase()
}

function App() {
  const location = useLocation()
  const navigate = useNavigate()
  const books = useLibraryStore((state) => state.books)
  const upsertBook = useLibraryStore((state) => state.upsertBook)
  const preferredEngine = useSettingsStore((state) => state.preferredEngine)
  const [openedFileMessage, setOpenedFileMessage] = useState<string | null>(null)
  const [openedFileError, setOpenedFileError] = useState<string | null>(null)
  const processingPathsRef = useRef(new Set<string>())

  const completedBooks = books.filter((book) => (book.progressPercentage ?? 0) >= 99).length

  useEffect(() => {
    if (!isTauriRuntime) {
      return
    }

    let unlisten: (() => void) | undefined
    let cancelled = false

    async function openEpubPaths(paths: string[]) {
      const uniquePaths = new Map<string, string>()
      for (const path of paths) {
        if (path.toLowerCase().endsWith('.epub')) {
          uniquePaths.set(getPathKey(path), path)
        }
      }

      const epubPaths = [...uniquePaths.entries()]
      if (epubPaths.length === 0) {
        return
      }

      setOpenedFileError(null)

      for (const [normalizedKey, path] of epubPaths) {
        if (processingPathsRef.current.has(normalizedKey)) {
          continue
        }

        processingPathsRef.current.add(normalizedKey)
        try {
          const existingBook = useLibraryStore
            .getState()
            .books.find((book) => book.sourcePath && getPathKey(book.sourcePath) === normalizedKey)

          if (existingBook) {
            setOpenedFileMessage(`既に取り込み済みの EPUB を開きました: ${existingBook.title}`)
            await navigate({
              to: '/reader/$bookId',
              params: { bookId: existingBook.id },
            })
            continue
          }

          setOpenedFileMessage('EPUB を取り込んでいます...')
          const imported = await importEpubFromPath(path)
          const importedKey = getPathKey(imported.sourcePath)
          const duplicateBook = useLibraryStore
            .getState()
            .books.find((book) => book.sourcePath && getPathKey(book.sourcePath) === importedKey)

          if (duplicateBook) {
            setOpenedFileMessage(`既に取り込み済みの EPUB を開きました: ${duplicateBook.title}`)
            await navigate({
              to: '/reader/$bookId',
              params: { bookId: duplicateBook.id },
            })
            continue
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

          setOpenedFileMessage(`EPUB を取り込みました: ${preview.title || imported.fileName}`)
          await navigate({
            to: '/reader/$bookId',
            params: { bookId: imported.id },
          })
        } catch (error) {
          setOpenedFileError(
            error instanceof Error ? error.message : 'EPUB 起動ファイルの取り込みに失敗しました。',
          )
        } finally {
          processingPathsRef.current.delete(normalizedKey)
        }
      }
    }

    async function drainPendingOpenedEpubs() {
      try {
        const paths = await takePendingOpenedEpubs()
        if (!cancelled) {
          await openEpubPaths(paths)
        }
      } catch (error) {
        if (!cancelled) {
          setOpenedFileError(
            error instanceof Error ? error.message : 'EPUB 起動ファイルの確認に失敗しました。',
          )
        }
      }
    }

    void listen('epub-files-opened', () => {
      void drainPendingOpenedEpubs()
    })
      .then((dispose) => {
        if (cancelled) {
          dispose()
          return
        }

        unlisten = dispose
        void drainPendingOpenedEpubs()
      })
      .catch((error) => {
        if (!cancelled) {
          setOpenedFileError(
            error instanceof Error ? error.message : 'EPUB 起動イベントの監視に失敗しました。',
          )
        }
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [navigate, upsertBook])

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-panel">
          <span className="eyebrow">AI EPUB Viewer</span>
          <h1>PrismPage</h1>
          <p>
            画像重視の EPUB 読書体験に、AI 超解像の切り替えと導入支援を統合した
            Tauri ビューワー。
          </p>
        </div>

        <nav className="main-nav" aria-label="アプリケーションナビゲーション">
          {navItems.map((item) => {
            const Icon = item.icon
            const isActive = location.pathname === item.href

            return (
              <Link
                key={item.href}
                to={item.href}
                className={`nav-link${isActive ? ' is-active' : ''}`}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </Link>
            )
          })}
        </nav>

        <section className="status-card">
          <div className="status-card-header">
            <BookOpenText size={18} />
            <h2>ライブラリ状況</h2>
          </div>
          <dl>
            <div>
              <dt>登録冊数</dt>
              <dd>{books.length}</dd>
            </div>
            <div>
              <dt>読了済み</dt>
              <dd>{completedBooks}</dd>
            </div>
          </dl>
        </section>

        <section className="status-card">
          <div className="status-card-header">
            <ImageUpscale size={18} />
            <h2>AI 優先エンジン</h2>
          </div>
          <p className="status-card-value">
            {preferredEngine === 'waifu2x' ? 'waifu2x' : 'Real-ESRGAN'}
          </p>
          <p className="muted">設定画面からエンジン切り替えと導入支援を行えます。</p>
        </section>
      </aside>

      <main className="content-shell">
        {openedFileMessage ? (
          <div className="message-strip is-success">{openedFileMessage}</div>
        ) : null}
        {openedFileError ? <div className="message-strip is-error">{openedFileError}</div> : null}
        <Outlet />
      </main>
    </div>
  )
}

export default App
