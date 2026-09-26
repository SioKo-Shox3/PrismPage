import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

// 性能の計測用の設定。モック(VITE_MOCK=1)の dev server を 127.0.0.1:1420 で起動し、合成データを差し込んで
// フォルダ画面の表示・ページ送り・拡大の時間を実際の Chromium で測る。CI では走らせない。
// 実行: node node_modules/@playwright/test/cli.js test --config scripts/perf/playwright.config.ts
const root = fileURLToPath(new URL('../..', import.meta.url))

export default defineConfig({
  testDir: '.',
  testMatch: '*.perf.ts',
  outputDir: '../../.harness/playwright-output-perf',
  reporter: 'list',
  workers: 1,
  forbidOnly: true,
  timeout: 300_000,
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
    cwd: root,
    url: 'http://127.0.0.1:1420',
    env: { VITE_MOCK: '1' },
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
