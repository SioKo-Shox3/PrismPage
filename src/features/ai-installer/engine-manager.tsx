import { useEffect, useMemo, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import { AlertCircle, CheckCircle2, FolderSearch, PackagePlus, RefreshCw } from 'lucide-react'

import {
  clearEngineRegistration,
  getEngineStatuses,
  importEngineArchive,
  registerEngineDirectory,
} from '@/lib/tauri'
import type { EngineId, EngineStatus } from '@/types/app'

interface EngineManagerProps {
  preferredEngine: EngineId
  onPreferredEngineChange: (engineId: EngineId) => void
}

const engineOrder: EngineId[] = ['waifu2x', 'real-esrgan']

export function EngineManager({
  preferredEngine,
  onPreferredEngineChange,
}: EngineManagerProps) {
  const [statuses, setStatuses] = useState<EngineStatus[]>([])
  const [busyEngine, setBusyEngine] = useState<EngineId | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function refreshStatuses() {
    try {
      setError(null)
      setStatuses(await getEngineStatuses())
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : 'AI エンジン状態の取得に失敗しました。',
      )
    }
  }

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const nextStatuses = await getEngineStatuses()
        if (!cancelled) {
          setError(null)
          setStatuses(nextStatuses)
        }
      } catch (refreshError) {
        if (!cancelled) {
          setError(
            refreshError instanceof Error
              ? refreshError.message
              : 'AI エンジン状態の取得に失敗しました。',
          )
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  const orderedStatuses = useMemo(
    () =>
      engineOrder
        .map((id) => statuses.find((status) => status.id === id))
        .filter((status): status is EngineStatus => Boolean(status)),
    [statuses],
  )

  async function handleDirectoryImport(engineId: EngineId) {
    const selectedPath = await open({
      directory: true,
      multiple: false,
      title: 'AI エンジンの展開済みフォルダを選択',
    })

    if (typeof selectedPath !== 'string') {
      return
    }

    try {
      setBusyEngine(engineId)
      setMessage(null)
      setError(null)
      const status = await registerEngineDirectory(engineId, selectedPath)
      setStatuses((current) =>
        current.map((entry) => (entry.id === status.id ? status : entry)),
      )
      setMessage(`${status.label} のフォルダ登録が完了しました。`)
    } catch (registerError) {
      setError(
        registerError instanceof Error
          ? registerError.message
          : 'フォルダの登録に失敗しました。',
      )
    } finally {
      setBusyEngine(null)
    }
  }

  async function handleArchiveImport(engineId: EngineId) {
    const selectedPath = await open({
      directory: false,
      filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
      multiple: false,
      title: 'AI エンジンの ZIP アーカイブを選択',
    })

    if (typeof selectedPath !== 'string') {
      return
    }

    try {
      setBusyEngine(engineId)
      setMessage(null)
      setError(null)
      const status = await importEngineArchive(engineId, selectedPath)
      setStatuses((current) =>
        current.map((entry) => (entry.id === status.id ? status : entry)),
      )
      setMessage(`${status.label} の ZIP インポートが完了しました。`)
    } catch (archiveError) {
      setError(
        archiveError instanceof Error
          ? archiveError.message
          : 'ZIP のインポートに失敗しました。',
      )
    } finally {
      setBusyEngine(null)
    }
  }

  async function handleClear(engineId: EngineId) {
    try {
      setBusyEngine(engineId)
      setMessage(null)
      setError(null)
      const nextStatuses = await clearEngineRegistration(engineId)
      setStatuses(nextStatuses)
      setMessage('登録済みエンジン設定を解除しました。')
    } catch (clearError) {
      setError(
        clearError instanceof Error
          ? clearError.message
          : 'エンジン設定の解除に失敗しました。',
      )
    } finally {
      setBusyEngine(null)
    }
  }

  return (
    <section className="panel">
      <div className="section-header">
        <PackagePlus size={18} />
        <div>
          <h2>AI エンジン管理</h2>
          <p>
            waifu2x と Real-ESRGAN のどちらも登録可能です。ZIP を直接取り込むか、
            展開済みフォルダを指定してください。
          </p>
        </div>
      </div>

      <div className="inline-actions">
        <button type="button" className="ghost-button" onClick={() => void refreshStatuses()}>
          <RefreshCw size={16} />
          状態を再読込
        </button>
      </div>

      {message ? <div className="message-strip is-success">{message}</div> : null}
      {error ? <div className="message-strip is-error">{error}</div> : null}

      <div className="engine-grid">
        {orderedStatuses.map((status) => {
          const isBusy = busyEngine === status.id

          return (
            <article key={status.id} className="engine-card">
              <div className="engine-card-header">
                {status.ready ? (
                  <CheckCircle2 size={18} className="text-emerald-400" />
                ) : (
                  <AlertCircle size={18} className="text-amber-300" />
                )}
                <div>
                  <h3>{status.label}</h3>
                  <p>{status.id === 'waifu2x' ? '漫画・線画向け' : '表紙・挿絵混在向け'}</p>
                </div>
              </div>

              <div className="book-meta">
                <span
                  className={`status-chip ${
                    status.ready
                      ? 'is-ready'
                      : status.configured
                        ? 'is-warning'
                        : 'is-error'
                  }`}
                >
                  {status.ready
                    ? '利用可能'
                    : status.configured
                      ? '要確認'
                      : '未登録'}
                </span>
                <span className="chip">
                  {preferredEngine === status.id ? '優先エンジン' : '任意選択'}
                </span>
              </div>

              <div className="field-stack">
                <span className="helper-text">実行ファイル</span>
                <code>{status.executablePath ?? '未設定'}</code>
                <span className="helper-text">モデルパス</span>
                <code>{status.modelPath ?? '未設定'}</code>
              </div>

              {status.warning ? <div className="message-strip is-error">{status.warning}</div> : null}

              <ul className="note-list">
                {status.notes.map((note) => (
                  <li key={note}>- {note}</li>
                ))}
              </ul>

              <div className="engine-card-actions">
                <button
                  type="button"
                  className="button"
                  onClick={() => onPreferredEngineChange(status.id)}
                  disabled={preferredEngine === status.id}
                >
                  優先エンジンにする
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => void handleArchiveImport(status.id)}
                  disabled={isBusy}
                >
                  <PackagePlus size={16} />
                  ZIP を取り込む
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => void handleDirectoryImport(status.id)}
                  disabled={isBusy}
                >
                  <FolderSearch size={16} />
                  フォルダを指定
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => void openUrl(status.downloadUrl)}
                >
                  公式配布ページ
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => void handleClear(status.id)}
                  disabled={!status.configured || isBusy}
                >
                  登録解除
                </button>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
