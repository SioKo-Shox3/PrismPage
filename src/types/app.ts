export type EngineId = 'waifu2x' | 'real-esrgan'

export type ThemeMode = 'dark' | 'light' | 'sepia'

export interface BookRecord {
  id: string
  fileName: string
  sourcePath?: string
  storedPath: string
  size: number
  importedAt: number
  title: string
  author?: string
  coverDataUrl?: string
  currentLocation?: string
  progressPercentage?: number
  lastOpenedAt?: number
}

export interface ImportedBook {
  id: string
  fileName: string
  sourcePath: string
  storedPath: string
  size: number
}

export interface EngineStatus {
  id: EngineId
  label: string
  configured: boolean
  ready: boolean
  executablePath?: string
  modelPath?: string
  modelName?: string
  warning?: string
  downloadUrl: string
  notes: string[]
}

export interface EnhanceImageRequest {
  engineId: EngineId
  imageDataUrl: string
  scale: number
}

export interface EnhanceImageResponse {
  imageDataUrl: string
}
