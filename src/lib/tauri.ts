import { invoke } from '@tauri-apps/api/core'

import type {
  EnhanceBookAssetImageRequest,
  EnhanceBookAssetImageResponse,
  EnhanceBookImageRequest,
  EnhanceBookImageResponse,
  EnhanceImageRequest,
  EnhanceImageResponse,
  EngineCandidate,
  EngineId,
  EngineInstallOption,
  EngineInstallOptionsResponse,
  EngineStatus,
  ImportedBook,
  ReadBookAssetImageRequest,
  ReadBookAssetImageResponse,
  ReadEnhancedBookImageRequest,
  ScanBookImagesRequest,
  ScanBookImagesResponse,
} from '@/types/app'

export const isTauriRuntime =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export async function importEpubFromPath(path: string) {
  return invoke<ImportedBook>('import_epub_from_path', { path })
}

export async function readBookBase64(id: string) {
  return invoke<string>('read_book_base64', { id })
}

export async function readBookAssetImage(request: ReadBookAssetImageRequest) {
  return invoke<ReadBookAssetImageResponse>('read_book_asset_image', { request })
}

export async function getEngineStatuses() {
  return invoke<EngineStatus[]>('get_engine_statuses')
}

export async function detectEngineCandidates() {
  return invoke<EngineCandidate[]>('detect_engine_candidates')
}

export async function getEngineInstallOptions() {
  return invoke<EngineInstallOptionsResponse>('get_engine_install_options')
}

export async function registerEngineDirectory(engineId: EngineId, directoryPath: string) {
  return invoke<EngineStatus>('register_engine_directory', { engineId, directoryPath })
}

export async function importEngineArchive(engineId: EngineId, archivePath: string) {
  return invoke<EngineStatus>('import_engine_archive', { engineId, archivePath })
}

export async function installEngineFromRelease(option: EngineInstallOption) {
  return invoke<EngineStatus>('install_engine_from_release', { option })
}

export async function clearEngineRegistration(engineId: EngineId) {
  return invoke<EngineStatus[]>('clear_engine_registration', { engineId })
}

export async function enhanceImage(request: EnhanceImageRequest) {
  return invoke<EnhanceImageResponse>('enhance_image', { request })
}

export async function enhanceBookImage(request: EnhanceBookImageRequest) {
  return invoke<EnhanceBookImageResponse>('enhance_book_image', { request })
}

export async function scanBookImages(request: ScanBookImagesRequest) {
  return invoke<ScanBookImagesResponse>('scan_book_images', { request })
}

export async function enhanceBookAssetImage(request: EnhanceBookAssetImageRequest) {
  return invoke<EnhanceBookAssetImageResponse>('enhance_book_asset_image', { request })
}

export async function readEnhancedBookImage(request: ReadEnhancedBookImageRequest) {
  return invoke<string | null>('read_enhanced_book_image', { request })
}

export async function cancelEnhancementJobs(readerSessionId: string) {
  return invoke<void>('cancel_enhancement_jobs', { readerSessionId })
}

export async function takePendingOpenedEpubs() {
  return invoke<string[]>('take_pending_opened_epubs')
}
