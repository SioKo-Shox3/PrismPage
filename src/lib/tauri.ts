import { invoke } from '@tauri-apps/api/core'

import type {
  EnhanceImageRequest,
  EnhanceImageResponse,
  EngineCandidate,
  EngineId,
  EngineStatus,
  ImportedBook,
} from '@/types/app'

export const isTauriRuntime =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export async function importEpubFromPath(path: string) {
  return invoke<ImportedBook>('import_epub_from_path', { path })
}

export async function readBookBase64(id: string) {
  return invoke<string>('read_book_base64', { id })
}

export async function getEngineStatuses() {
  return invoke<EngineStatus[]>('get_engine_statuses')
}

export async function detectEngineCandidates() {
  return invoke<EngineCandidate[]>('detect_engine_candidates')
}

export async function registerEngineDirectory(engineId: EngineId, directoryPath: string) {
  return invoke<EngineStatus>('register_engine_directory', { engineId, directoryPath })
}

export async function importEngineArchive(engineId: EngineId, archivePath: string) {
  return invoke<EngineStatus>('import_engine_archive', { engineId, archivePath })
}

export async function clearEngineRegistration(engineId: EngineId) {
  return invoke<EngineStatus[]>('clear_engine_registration', { engineId })
}

export async function enhanceImage(request: EnhanceImageRequest) {
  return invoke<EnhanceImageResponse>('enhance_image', { request })
}

export async function takePendingOpenedEpubs() {
  return invoke<string[]>('take_pending_opened_epubs')
}
