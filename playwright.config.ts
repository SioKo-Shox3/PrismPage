import { defineConfig, devices } from '@playwright/test'

// `run shots` 用の設定。モック(VITE_MOCK=1)の dev server を 127.0.0.1:1420 で起動し、
// 全ルートを「紙」「墨」の両テーマで撮って `.harness/shots/` に PNG を書き出す。CI では走らせない。
export default defineConfig({
  testDir: './scripts/shots',
  testMatch: '*.shots.ts',
  outputDir: '.harness/playwright-output',
  reporter: 'list',
  workers: 1,
  forbidOnly: true,
  use: {
    baseURL: 'http://127.0.0.1:1420',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 1420 --strictPort',
    url: 'http://127.0.0.1:1420',
    env: { VITE_MOCK: '1' },
    // モック無しの dev server を誤って使わないよう、既存のサーバーは再利用しない。
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
