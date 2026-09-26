import { defineConfig, mergeConfig } from 'vitest/config'

import viteConfig from './vite.config'

// テストは vite.config.ts の解決設定(`@` の別名・React プラグイン)をそのまま使う。
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
    },
  }),
)
