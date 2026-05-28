import { Link, Outlet, useLocation } from '@tanstack/react-router'
import { BookOpenText, ImageUpscale, Library, Settings2 } from 'lucide-react'

import { useLibraryStore } from '@/features/library/book-store'
import { useSettingsStore } from '@/features/settings/settings-store'

const navItems = [
  { label: 'ライブラリ', href: '/', icon: Library },
  { label: '読書設定', href: '/settings', icon: Settings2 },
]

function App() {
  const location = useLocation()
  const books = useLibraryStore((state) => state.books)
  const preferredEngine = useSettingsStore((state) => state.preferredEngine)

  const completedBooks = books.filter((book) => (book.progressPercentage ?? 0) >= 99).length

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
        <Outlet />
      </main>
    </div>
  )
}

export default App
