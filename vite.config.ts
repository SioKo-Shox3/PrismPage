import fs from 'node:fs'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

// `public/mock/`(ブラウザ確認用のサンプルの本と合成ページ画像)は、VITE_MOCK=1 以外のビルドでは
// dist から取り除く。public/ は丸ごと複製されるため、書き出し後に mock/ だけを消す。
function excludeMockAssets(): Plugin {
  let mockDir: string | null = null

  return {
    name: 'prismpage-exclude-mock-assets',
    apply: 'build',
    configResolved(config) {
      const env = loadEnv(config.mode, config.envDir || config.root, 'VITE_')
      const mockEnabled = (process.env.VITE_MOCK ?? env.VITE_MOCK) === '1'
      mockDir = mockEnabled ? null : path.resolve(config.root, config.build.outDir, 'mock')
    },
    closeBundle() {
      if (mockDir) {
        fs.rmSync(mockDir, { recursive: true, force: true })
      }
    },
  }
}

export default defineConfig({
  clearScreen: false,
  plugins: [react(), excludeMockAssets()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    // src-tauri/target は数万ファイルあり、監視の走査が終わるまで最初の読み込みが止まる。
    // Rust 側の変更は Tauri CLI が見るので、dev server の監視からは外す。
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
})
