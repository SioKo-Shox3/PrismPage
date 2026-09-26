import {
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

import App from '@/App'
import { FavoritesPage } from '@/features/library/favorites-page'
import { FoldersPage } from '@/features/library/folders-page'
import { ContinueReadingPage, HistoryPage } from '@/features/library/reading-pages'
import { ShelvesPage } from '@/features/library/shelves-page'
import { SettingsPage } from '@/features/settings/settings-page'
import { ViewerPage } from '@/features/viewer/viewer-page'

const rootRoute = createRootRoute({
  component: App,
})

const continueReadingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: ContinueReadingPage,
})

const shelvesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/shelves',
  // `shelf` は表示中の本棚の ID(無ければ先頭の本棚)、`view` は並べ方(背表紙・表紙)。
  validateSearch: (search: Record<string, unknown>): { shelf?: number; view?: 'spines' | 'covers' } => ({
    ...(typeof search.shelf === 'number' && Number.isInteger(search.shelf) ? { shelf: search.shelf } : {}),
    ...(search.view === 'spines' || search.view === 'covers' ? { view: search.view } : {}),
  }),
  component: ShelvesPage,
})

const foldersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/folders',
  // `source` は表示中の登録フォルダの ID(無ければ登録フォルダの一覧)、`path` は登録フォルダからの相対パス。
  // `q` は検索語、`scope` が 'folder' なら表示中のフォルダの中だけを探す。
  validateSearch: (
    search: Record<string, unknown>,
  ): { source?: number; path?: string; q?: string; scope?: 'folder' } => ({
    ...(typeof search.source === 'number' && Number.isInteger(search.source)
      ? { source: search.source }
      : {}),
    ...(typeof search.path === 'string' && search.path.length > 0 ? { path: search.path } : {}),
    // 数だけの検索語(`?q=2`)は数として読まれるので文字列に戻す。
    ...(typeof search.q === 'string' && search.q.length > 0
      ? { q: search.q }
      : typeof search.q === 'number'
        ? { q: String(search.q) }
        : {}),
    ...(search.scope === 'folder' ? { scope: 'folder' as const } : {}),
  }),
  component: FoldersPage,
})

const favoritesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/favorites',
  component: FavoritesPage,
})

const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/history',
  component: HistoryPage,
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
})

const viewerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/viewer/$bookId',
  // `path` は開く本の場所(フォルダ・画像・アーカイブ・EPUB)。無ければ本 ID をそのまま渡す(モックの本)。
  // `start=first` は保存してある読書位置を使わず先頭から開く(次の巻・前の巻へ移るとき)。
  validateSearch: (search: Record<string, unknown>): { path?: string; start?: 'first' } => ({
    ...(typeof search.path === 'string' && search.path.length > 0 ? { path: search.path } : {}),
    ...(search.start === 'first' ? { start: 'first' as const } : {}),
  }),
  component: ViewerPage,
})

export const routeTree = rootRoute.addChildren([
  continueReadingRoute,
  shelvesRoute,
  foldersRoute,
  favoritesRoute,
  historyRoute,
  settingsRoute,
  viewerRoute,
])

export const router = createRouter({
  defaultPreload: 'intent',
  routeTree,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
