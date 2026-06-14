import {
  formatBytes,
  getProgressPercentage,
  type UpdateProgress,
} from '@/lib/updater'

export function UpdateProgressMeter({ progress }: { progress: UpdateProgress | null }) {
  if (!progress) {
    return null
  }

  const percentage = getProgressPercentage(progress)

  return (
    <div className="update-progress" aria-label="アップデートのダウンロード進捗">
      <div className="update-progress-track">
        <div style={{ width: `${percentage}%` }} />
      </div>
      <span>
        {progress.finished
          ? 'ダウンロード完了'
          : `${formatBytes(progress.downloaded)} / ${formatBytes(progress.contentLength)}`}
      </span>
    </div>
  )
}
