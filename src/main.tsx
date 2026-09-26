import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'

import { router } from '@/app/router'
import { ThemeEffect } from '@/features/settings/theme-effect'

import '@/design/fonts'
import '@/design/tokens.css'
import '@/design/global.css'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeEffect />
    <RouterProvider router={router} />
  </StrictMode>,
)
