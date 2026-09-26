/// <reference types="vite/client" />

interface ImportMetaEnv {
  // '1' のときブラウザ確認用のモックで command に答える(`src/lib/tauri.ts`)。
  readonly VITE_MOCK?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
