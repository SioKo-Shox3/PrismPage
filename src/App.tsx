import { useState } from 'react'
import { Link, Outlet, useLocation } from '@tanstack/react-router'
import type { LucideIcon } from 'lucide-react'
import {
  BookOpen,
  FileInput,
  FolderTree,
  History,
  ImageUpscale,
  Library,
  Settings2,
  Star,
} from 'lucide-react'

import { pickBookFile, useOpenPath, useOpenRequests } from '@/app/open-requests'
import prismLogo from '@/assets/prismpage-logo.svg?no-inline'
import { StartupUpdateNotice } from '@/features/settings/startup-update-notice'
import { isTauriRuntime } from '@/lib/tauri'

import styles from './App.module.css'

type NavItem = {
  label: string
  to: string
  hash?: string
  icon: LucideIcon
}

// 左ナビの並び(spec 3.1)。null は区切り線。
const navItems: (NavItem | null)[] = [
  { label: '読みかけ', to: '/', icon: BookOpen },
  { label: '本棚', to: '/shelves', icon: Library },
  { label: 'フォルダ', to: '/folders', icon: FolderTree },
  { label: 'お気に入り', to: '/favorites', icon: Star },
  { label: '履歴', to: '/history', icon: History },
  null,
  { label: 'AI 超解像', to: '/settings', hash: 'ai-engines', icon: ImageUpscale },
  { label: '設定', to: '/settings', icon: Settings2 },
]

function App() {
  const location = useLocation()
  const [startupUpdateVisible, setStartupUpdateVisible] = useState(false)
  const isViewerRoute = location.pathname.startsWith('/viewer/')
  const openPath = useOpenPath()
  useOpenRequests()

  const openFile = async () => {
    try {
      const path = await pickBookFile()
      if (path) openPath(path)
    } catch (error) {
      console.error('ファイルを開くダイアログを出せませんでした', error)
    }
  }

  return (
    <div className={isViewerRoute ? styles.viewerShell : styles.shell}>
      {!isViewerRoute ? (
        <aside className={styles.sidebar}>
          <div className={styles.brand}>
            <img src={prismLogo} alt="" className={styles.brandLogo} />
            <span className={styles.brandName}>PrismPage</span>
          </div>

          <nav className={styles.nav} aria-label="アプリケーションナビゲーション">
            {navItems.map((item, index) => {
              if (!item) {
                return <hr key={`separator-${index}`} className={styles.navSeparator} />
              }

              const Icon = item.icon

              return (
                <Link
                  key={`${item.to}#${item.hash ?? ''}`}
                  to={item.to}
                  hash={item.hash}
                  className={styles.navLink}
                  // 「設定」と「AI 超解像」は同じパスでハッシュだけが違うので、ハッシュまで一致したときだけ選択表示にする。
                  // 検索パラメータは見ない(フォルダ画面は登録フォルダの中を辿っても「フォルダ」を選択表示にする)。
                  // 選択中の aria-current は Link が付ける。
                  activeOptions={{ exact: true, includeHash: true, includeSearch: false }}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span>{item.label}</span>
                </Link>
              )
            })}
          </nav>

          {/* OS のファイル選択はアプリ上でだけ出せる。 */}
          {isTauriRuntime ? (
            <button type="button" className={`${styles.navLink} ${styles.openFile}`} onClick={() => void openFile()}>
              <FileInput size={16} aria-hidden="true" />
              <span>ファイルを開く…</span>
            </button>
          ) : null}
        </aside>
      ) : null}

      <main className={styles.content}>
        <div className={styles.noticeStack} hidden={!startupUpdateVisible}>
          <StartupUpdateNotice onVisibleChange={setStartupUpdateVisible} />
        </div>
        <Outlet />
      </main>
    </div>
  )
}

export default App
