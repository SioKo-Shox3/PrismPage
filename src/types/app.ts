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
  jobId: string
  readerSessionId: string
  scale: number
}

export interface EnhanceBookImageResponse {
  cacheHit: boolean
  imageDataUrl: string
}

export interface ScanBookImagesRequest {
  bookId: string
  engineId: EngineId
  scale: number
}

export interface ScannedBookImage {
  assetPath: string
  imageHash: string
  mimeType: string
  spineIndex: number
  order: number
  cached: boolean
}

export interface ScanBookImagesResponse {
  bookId: string
  engineId: EngineId
  scale: number
  totalImages: number
  cachedImages: number
  images: ScannedBookImage[]
}

export interface EnhanceBookAssetImageRequest {
  bookId: string
  engineId: EngineId
  assetPath: string
  imageHash: string
  jobId: string
  readerSessionId: string
  scale: number
}

export interface EnhanceBookAssetImageResponse {
  imageHash: string
  cacheHit: boolean
}

export interface ReadEnhancedBookImageRequest {
  bookId: string
  engineId: EngineId
  imageHash: string
  scale: number
}
