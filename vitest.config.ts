import { defineConfig, mergeConfig } from 'vitest/config'

import viteConfig from './vite.config'

// テストは vite.config.ts の解決設定(`@` の別名・React プラグイン)をそのまま使う。
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
      // 1,000 冊を描く画面のテストとその直後のテストは、手元でも 2 秒ほどかかり、
      // CI の Windows ランナーでは既定の 5 秒を超えることがある。
      testTimeout: 20_000,
    },
  }),
)
