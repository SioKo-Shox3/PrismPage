import {
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

import App from '@/App'
import { LibraryPage } from '@/features/library/library-page'
import { ReaderPage } from '@/features/reader/reader-page'
import { SettingsPage } from '@/features/settings/settings-page'

const rootRoute = createRootRoute({
  component: App,
})

const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: LibraryPage,
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
})

const readerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reader/$bookId',
  component: ReaderPage,
})

const routeTree = rootRoute.addChildren([libraryRoute, settingsRoute, readerRoute])

export const router = createRouter({
  defaultPreload: 'intent',
  routeTree,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
