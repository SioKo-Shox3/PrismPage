import { useEffect, useRef, useState } from 'react'
import type { Update } from '@tauri-apps/plugin-updater'
import { Download } from 'lucide-react'

import { UpdateProgressMeter } from '@/features/settings/update-progress-meter'
import { isTauriRuntime } from '@/lib/tauri'
import {
  checkStartupUpdateOnce,
  closeUpdateSilently,
  downloadInstallAndRelaunch,
  normalizeVersion,
  type UpdatePhase,
  type UpdateProgress,
} from '@/lib/updater'

interface StartupUpdateNoticeProps {
  onVisibleChange: (visible: boolean) => void
}

export function StartupUpdateNotice({ onVisibleChange }: StartupUpdateNoticeProps) {
  const [phase, setPhase] = useState<UpdatePhase>('idle')
  const [update, setUpdate] = useState<Update | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<UpdateProgress | null>(null)
  const updateRef = useRef<Update | null>(null)

  useEffect(() => {
    if (!isTauriRuntime) {
      return undefined
    }

    let cancelled = false

    void checkStartupUpdateOnce()
      .then((availableUpdate) => {
        if (cancelled || !availableUpdate) {
          return
        }

        updateRef.current = availableUpdate
        setUpdate(availableUpdate)
        setPhase('available')
        setMessage(`PrismPage ${normalizeVersion(availableUpdate.version)} を利用できます。`)
      })
      .catch(() => {
        if (!cancelled) {
          setPhase('idle')
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    onVisibleChange(Boolean(update && phase !== 'idle'))
  }, [onVisibleChange, phase, update])

  if (!update || phase === 'idle') {
    return null
  }

  const isBusy = phase === 'downloading' || phase === 'installing' || phase === 'relaunching'

  return (
    <div className={`message-strip update-toast-card${error ? ' is-error' : ' is-success'}`}>
      <div className="update-toast-copy">
        <strong>{error ? 'アップデートに失敗しました' : 'アップデートがあります'}</strong>
        <span>{error ?? message}</span>
      </div>
      <UpdateProgressMeter progress={progress} />
      <div className="inline-actions update-toast-actions">
        {phase === 'available' || phase === 'error' ? (
          <button
            type="button"
            className="ghost-button"
            onClick={() => {
              closeUpdateSilently(updateRef.current)
              updateRef.current = null
              setUpdate(null)
              setPhase('idle')
              setError(null)
              setMessage(null)
              setProgress(null)
            }}
          >
            あとで
          </button>
        ) : null}
        {phase === 'available' ? (
          <button
            type="button"
            className="button"
            onClick={() =>
              void downloadInstallAndRelaunch(
                update,
                setPhase,
                setMessage,
                setError,
                setProgress,
              )
            }
          >
            <Download size={16} />
            アップデート
          </button>
        ) : null}
        {phase === 'relaunching' || isBusy ? (
          <span className="status-chip">処理中</span>
        ) : null}
      </div>
    </div>
  )
}
