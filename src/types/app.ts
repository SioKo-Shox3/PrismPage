export type EngineId = 'real-cugan' | 'waifu2x' | 'real-esrgan'

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
  source?: string
  warning?: string
  downloadUrl: string
  notes: string[]
}

export interface EngineCandidate {
  id: EngineId
  label: string
  directoryPath: string
  executablePath: string
  modelPath: string
  modelName?: string
  source: string
}

export interface EngineInstallOption {
  engineId: EngineId
  label: string
  releaseName: string
  releaseTag: string
  assetName: string
  downloadUrl: string
  size: number
}

export interface EngineInstallWarning {
  engineId: EngineId
  label: string
  message: string
}

export interface EngineInstallOptionsResponse {
  options: EngineInstallOption[]
  warnings: EngineInstallWarning[]
}

export interface EnhanceImageRequest {
  engineId: EngineId
  imageDataUrl: string
  scale: number
}

export interface EnhanceImageResponse {
  imageDataUrl: string
}

export interface EnhanceBookImageRequest {
  bookId: string
  engineId: EngineId
  imageDataUrl: string
  imageHash: string
  scale: number
}

export interface EnhanceBookImageResponse {
  cacheHit: boolean
  imageDataUrl: string
}
