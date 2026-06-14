import { getVersion } from '@tauri-apps/api/app'
import { openUrl } from '@tauri-apps/plugin-opener'
import { relaunch } from '@tauri-apps/plugin-process'
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater'

import { isTauriRuntime } from '@/lib/tauri'

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'latest'
  | 'downloading'
  | 'installing'
  | 'relaunching'
  | 'error'
  | 'unsupported'

export interface UpdateProgress {
  contentLength?: number
  downloaded: number
  finished: boolean
}

export const fallbackVersion = '0.1.2'
export const releasesPageUrl = 'https://github.com/SioKo-Shox3/PrismPage/releases/latest'
export const updateCheckTimeoutMs = 15_000
export const updateInstallTimeoutMs = 10 * 60_000

let startupUpdateCheckPromise: Promise<Update | null> | null = null

export function normalizeVersion(version: string) {
  return version.trim().replace(/^app-v/i, '').replace(/^v/i, '')
}

export function formatDate(date?: string) {
  if (!date) {
    return '日付未設定'
  }

  const parsed = new Date(date)
  if (Number.isNaN(parsed.getTime())) {
    return date
  }

  return new Intl.DateTimeFormat('ja-JP', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed)
}

export function formatBytes(bytes?: number) {
  if (!bytes || bytes <= 0) {
    return 'サイズ未取得'
  }

  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

export function getProgressPercentage(progress: UpdateProgress | null) {
  if (!progress?.contentLength) {
    return progress?.finished ? 100 : 0
  }

  return Math.min(100, Math.round((progress.downloaded / progress.contentLength) * 100))
}

export function describeUpdaterError(error: unknown, phase: string) {
  const rawMessage = error instanceof Error ? error.message : String(error)
  const message = rawMessage || '詳細不明のエラー'
  const normalized = message.toLowerCase()

  if (
    normalized.includes('signature') ||
    normalized.includes('minisign') ||
    normalized.includes('verify')
  ) {
    return `${phase}に失敗しました。更新ファイルの署名を検証できませんでした。公開鍵と release の署名が一致しているか確認してください。`
  }

  if (
    normalized.includes('asset') ||
    normalized.includes('artifact') ||
    normalized.includes('404') ||
    normalized.includes('not found')
  ) {
    return `${phase}に失敗しました。更新情報または現在の環境に合う配布ファイルが見つかりませんでした。`
  }

  if (
    normalized.includes('network') ||
    normalized.includes('fetch') ||
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('connection') ||
    normalized.includes('dns')
  ) {
    return `${phase}に失敗しました。ネットワーク接続または GitHub Releases への到達性を確認してください。`
  }

  if (normalized.includes('permission') || normalized.includes('not allowed')) {
    return `${phase}に失敗しました。アップデート機能に必要な Tauri 権限が許可されていません。`
  }

  return `${phase}に失敗しました。${message}`
}

export async function resolveCurrentVersion() {
  if (!isTauriRuntime) {
    return fallbackVersion
  }

  try {
    return await getVersion()
  } catch {
    return fallbackVersion
  }
}

export async function openExternalUrl(url: string) {
  try {
    if (isTauriRuntime) {
      await openUrl(url)
      return
    }
  } catch {
    // Fall through to the browser fallback below.
  }

  window.open(url, '_blank', 'noopener,noreferrer')
}

export function closeUpdateSilently(update: Update | null) {
  if (update) {
    void update.close().catch(() => undefined)
  }
}

export function checkStartupUpdateOnce() {
  startupUpdateCheckPromise ??= check({ timeout: updateCheckTimeoutMs })
  return startupUpdateCheckPromise
}

export function createProgressHandler(setProgress: (progress: UpdateProgress) => void) {
  let downloaded = 0
  let contentLength: number | undefined

  return (event: DownloadEvent) => {
    if (event.event === 'Started') {
      downloaded = 0
      contentLength = event.data.contentLength
      setProgress({ contentLength, downloaded, finished: false })
      return
    }

    if (event.event === 'Progress') {
      downloaded += event.data.chunkLength
      setProgress({ contentLength, downloaded, finished: false })
      return
    }

    setProgress({ contentLength, downloaded: contentLength ?? downloaded, finished: true })
  }
}

export async function downloadInstallAndRelaunch(
  update: Update,
  setPhase: (phase: UpdatePhase) => void,
  setMessage: (message: string | null) => void,
  setError: (error: string | null) => void,
  setProgress: (progress: UpdateProgress | null) => void,
) {
  try {
    setPhase('downloading')
    setMessage(`PrismPage ${normalizeVersion(update.version)} をダウンロードしています。`)
    setError(null)
    setProgress({ downloaded: 0, finished: false })

    await update.downloadAndInstall(createProgressHandler(setProgress), {
      timeout: updateInstallTimeoutMs,
    })

    setPhase('relaunching')
    setProgress(null)
    setMessage('アップデートをインストールしました。PrismPage を再起動します。')
    await relaunch()
  } catch (installError) {
    setPhase('error')
    setError(describeUpdaterError(installError, 'アップデートの適用'))
    setMessage(null)
  }
}
