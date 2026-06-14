import { useEffect, useRef, useState } from 'react'
import type { Update } from '@tauri-apps/plugin-updater'
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { CheckCircle2, Download, ExternalLink, Power, RefreshCw, Rocket } from 'lucide-react'

import { UpdateProgressMeter } from '@/features/settings/update-progress-meter'
import { isTauriRuntime } from '@/lib/tauri'
import {
  closeUpdateSilently,
  describeUpdaterError,
  downloadInstallAndRelaunch,
  fallbackVersion,
  formatDate,
  normalizeVersion,
  openExternalUrl,
  releasesPageUrl,
  resolveCurrentVersion,
  updateCheckTimeoutMs,
  type UpdatePhase,
  type UpdateProgress,
} from '@/lib/updater'

function UpdateSummary({ update }: { update: Update }) {
  return (
    <div className="update-checker-meta">
      <div>
        <span className="eyebrow">Current</span>
        <strong>{normalizeVersion(update.currentVersion)}</strong>
        <span className="muted">インストール中</span>
      </div>
      <div>
        <span className="eyebrow">Update</span>
        <strong>{normalizeVersion(update.version)}</strong>
        <span className="muted">{formatDate(update.date)}</span>
      </div>
      <div>
        <span className="eyebrow">Install</span>
        <strong>アプリ内</strong>
        <span className="muted">完了後に再起動</span>
      </div>
    </div>
  )
}

export function UpdateChecker() {
  const [currentVersion, setCurrentVersion] = useState(fallbackVersion)
  const [phase, setPhase] = useState<UpdatePhase>(isTauriRuntime ? 'idle' : 'unsupported')
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null)
  const [message, setMessage] = useState<string | null>(
    isTauriRuntime
      ? null
      : 'ブラウザプレビューではアプリ内アップデートを実行できません。Tauri アプリ上で確認してください。',
  )
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<UpdateProgress | null>(null)
  const updateRef = useRef<Update | null>(null)

  useEffect(() => {
    let mounted = true

    void resolveCurrentVersion().then((version) => {
      if (mounted) {
        setCurrentVersion(version)
      }
    })

    return () => {
      mounted = false
      closeUpdateSilently(updateRef.current)
      updateRef.current = null
    }
  }, [])

  function replaceUpdate(nextUpdate: Update | null) {
    if (updateRef.current && updateRef.current !== nextUpdate) {
      closeUpdateSilently(updateRef.current)
    }

    updateRef.current = nextUpdate
    setAvailableUpdate(nextUpdate)
  }

  async function handleCheckUpdate() {
    if (!isTauriRuntime) {
      setPhase('unsupported')
      setMessage('ブラウザプレビューではアプリ内アップデートを実行できません。')
      return
    }

    try {
      setPhase('checking')
      setMessage(null)
      setError(null)
      setProgress(null)
      replaceUpdate(null)

      const version = await resolveCurrentVersion()
      const nextUpdate = await check({ timeout: updateCheckTimeoutMs })

      setCurrentVersion(version)

      if (!nextUpdate) {
        setPhase('latest')
        setMessage(`利用中のバージョンは最新です。現在のバージョン: ${version}`)
        return
      }

      replaceUpdate(nextUpdate)
      setPhase('available')
      setMessage(`PrismPage ${normalizeVersion(nextUpdate.version)} を利用できます。`)
    } catch (checkError) {
      setPhase('error')
      setError(describeUpdaterError(checkError, 'アップデート確認'))
      setMessage(null)
    }
  }

  async function handleInstallUpdate() {
    if (!availableUpdate) {
      setPhase('error')
      setError('適用できるアップデート情報がありません。もう一度確認してください。')
      return
    }

    await downloadInstallAndRelaunch(
      availableUpdate,
      setPhase,
      setMessage,
      setError,
      setProgress,
    )
  }

  const checking = phase === 'checking'
  const installing = phase === 'downloading' || phase === 'installing' || phase === 'relaunching'
  const canInstall = availableUpdate && phase === 'available'

  return (
    <section className="panel update-checker">
      <div className="section-header">
        <Rocket size={18} />
        <div>
          <h2>アプリ更新</h2>
          <p>署名済みの更新情報を確認し、PrismPage 内でダウンロードと適用を行います。</p>
        </div>
      </div>

      <div className="update-checker-body">
        <div className="inline-actions">
          <button
            type="button"
            className="button"
            onClick={() => void handleCheckUpdate()}
            disabled={checking || installing || !isTauriRuntime}
            aria-busy={checking}
          >
            <RefreshCw size={16} />
            {checking ? '確認中...' : 'アップデートを確認'}
          </button>
          <span className="status-chip">現在: {currentVersion}</span>
          {canInstall ? (
            <button
              type="button"
              className="button"
              onClick={() => void handleInstallUpdate()}
              disabled={installing}
            >
              <Download size={16} />
              アップデート
            </button>
          ) : null}
          {phase === 'relaunching' ? (
            <button type="button" className="ghost-button" onClick={() => void relaunch()}>
              <Power size={16} />
              再起動
            </button>
          ) : null}
          <button
            type="button"
            className="ghost-button"
            onClick={() => void openExternalUrl(releasesPageUrl)}
          >
            <ExternalLink size={16} />
            Releases
          </button>
        </div>

        <p className="helper-text">
          更新が見つかった場合のみ適用ボタンを表示します。インストール完了後、PrismPage
          は自動で再起動します。
        </p>

        {message ? (
          <div className={`message-strip ${phase === 'available' ? 'is-success' : ''}`}>
            {phase === 'latest' ? <CheckCircle2 size={16} /> : null}
            <span>{message}</span>
          </div>
        ) : null}
        {error ? <div className="message-strip is-error">{error}</div> : null}

        <UpdateProgressMeter progress={progress} />

        {availableUpdate ? (
          <>
            <UpdateSummary update={availableUpdate} />
            {availableUpdate.body ? (
              <div className="update-release-notes">
                <span className="eyebrow">Release notes</span>
                <p>{availableUpdate.body}</p>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  )
}
