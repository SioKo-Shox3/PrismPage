import { useEffect, useMemo, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  AlertCircle,
  CheckCircle2,
  FolderSearch,
  HardDrive,
  PackagePlus,
  RefreshCw,
  Search,
} from 'lucide-react'

import {
  clearEngineRegistration,
  detectEngineCandidates,
  getEngineStatuses,
  importEngineArchive,
  isTauriRuntime,
  registerEngineDirectory,
} from '@/lib/tauri'
import { engineOptions, getEngineDescription, getEngineLabel } from '@/lib/engines'
import type { EngineCandidate, EngineId, EngineStatus } from '@/types/app'

interface EngineManagerProps {
  preferredEngine: EngineId
  onPreferredEngineChange: (engineId: EngineId) => void
}

const engineOrder: EngineId[] = engineOptions.map((engine) => engine.id)
const tauriUnavailableMessage =
  'AI エンジンの検索・登録は Tauri アプリとして起動したときに利用できます。'

function upsertEngineStatus(statuses: EngineStatus[], status: EngineStatus) {
  if (statuses.some((entry) => entry.id === status.id)) {
    return statuses.map((entry) => (entry.id === status.id ? status : entry))
  }

  return [...statuses, status]
}

export function EngineManager({
  preferredEngine,
  onPreferredEngineChange,
}: EngineManagerProps) {
  const [statuses, setStatuses] = useState<EngineStatus[]>([])
  const [busyEngine, setBusyEngine] = useState<EngineId | null>(null)
  const [candidates, setCandidates] = useState<EngineCandidate[]>([])
  const [isDetecting, setIsDetecting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function ensureTauriRuntime() {
    if (isTauriRuntime) {
      return true
    }

    setMessage(null)
    setError(tauriUnavailableMessage)
    return false
  }

  async function refreshStatuses() {
    if (!ensureTauriRuntime()) {
      setStatuses([])
      return
    }

    try {
      setMessage(null)
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
      if (!isTauriRuntime) {
        if (!cancelled) {
          setError(tauriUnavailableMessage)
        }
        return
      }

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
    if (!ensureTauriRuntime()) {
      return
    }

    let selectedPath: string | string[] | null

    try {
      selectedPath = await open({
        directory: true,
        multiple: false,
        title: 'PC 上の AI エンジンまたは RAIV フォルダを選択',
      })
    } catch (dialogError) {
      setError(
        dialogError instanceof Error
          ? dialogError.message
          : 'フォルダ選択ダイアログを開けませんでした。',
      )
      return
    }

    if (typeof selectedPath !== 'string') {
      return
    }

    try {
      setBusyEngine(engineId)
      setMessage(null)
      setError(null)
      const status = await registerEngineDirectory(engineId, selectedPath)
      setStatuses((current) => upsertEngineStatus(current, status))
      setMessage(`${getEngineLabel(status.id)} の外部フォルダ登録が完了しました。`)
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

  async function handleDetectCandidates() {
    if (!ensureTauriRuntime()) {
      return
    }

    try {
      setIsDetecting(true)
      setMessage(null)
      setError(null)
      const nextCandidates = await detectEngineCandidates()
      setCandidates(nextCandidates)
      setMessage(
        nextCandidates.length > 0
          ? `${nextCandidates.length} 件の AI エンジン候補を見つけました。`
          : 'PC 内の既定候補から AI エンジンは見つかりませんでした。RAIV フォルダを手動指定してください。',
      )
    } catch (detectError) {
      setError(
        detectError instanceof Error
          ? detectError.message
          : 'AI エンジン候補の検索に失敗しました。',
      )
    } finally {
      setIsDetecting(false)
    }
  }

  async function handleCandidateRegister(candidate: EngineCandidate) {
    if (!ensureTauriRuntime()) {
      return
    }

    try {
      setBusyEngine(candidate.id)
      setMessage(null)
      setError(null)
      const status = await registerEngineDirectory(candidate.id, candidate.directoryPath)
      setStatuses((current) => upsertEngineStatus(current, status))
      onPreferredEngineChange(status.id)
      setMessage(`${getEngineLabel(status.id)} を PC 上の既存フォルダ参照として登録しました。`)
    } catch (registerError) {
      setError(
        registerError instanceof Error
          ? registerError.message
          : '検出候補の登録に失敗しました。',
      )
    } finally {
      setBusyEngine(null)
    }
  }

  async function handleArchiveImport(engineId: EngineId) {
    if (!ensureTauriRuntime()) {
      return
    }

    let selectedPath: string | string[] | null

    try {
      selectedPath = await open({
        directory: false,
        filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
        multiple: false,
        title: 'AI エンジンの ZIP アーカイブを選択',
      })
    } catch (dialogError) {
      setError(
        dialogError instanceof Error
          ? dialogError.message
          : 'ZIP 選択ダイアログを開けませんでした。',
      )
      return
    }

    if (typeof selectedPath !== 'string') {
      return
    }

    try {
      setBusyEngine(engineId)
      setMessage(null)
      setError(null)
      const status = await importEngineArchive(engineId, selectedPath)
      setStatuses((current) => upsertEngineStatus(current, status))
      setMessage(`${getEngineLabel(status.id)} の ZIP 取込が完了しました。`)
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
    if (!ensureTauriRuntime()) {
      return
    }

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

  async function handleOpenDownloadUrl(url: string) {
    if (!isTauriRuntime) {
      window.open(url, '_blank', 'noopener,noreferrer')
      return
    }

    try {
      await openUrl(url)
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  }

  return (
    <section className="panel">
      <div className="section-header">
        <PackagePlus size={18} />
        <div>
          <h2>AI エンジン管理</h2>
          <p>
            PC 上にある RAIV / Real-CUGAN / waifu2x / Real-ESRGAN を登録して使います。
            モデルはアプリ内へコピーせず、既存フォルダを参照します。
          </p>
        </div>
      </div>

      <div className="inline-actions">
        <button
          type="button"
          className="button"
          onClick={() => void handleDetectCandidates()}
          disabled={isDetecting}
        >
          <Search size={16} />
          {isDetecting ? '検索中...' : 'PC 内の候補を検索'}
        </button>
        <button type="button" className="ghost-button" onClick={() => void refreshStatuses()}>
          <RefreshCw size={16} />
          状態を再読込
        </button>
      </div>

      {message ? <div className="message-strip is-success">{message}</div> : null}
      {error ? <div className="message-strip is-error">{error}</div> : null}

      {candidates.length > 0 ? (
        <div className="candidate-list">
          {candidates.map((candidate) => (
            <article
              key={`${candidate.id}-${candidate.executablePath}`}
              className="candidate-card"
            >
              <div className="engine-card-header">
                <HardDrive size={18} />
                <div>
                  <h3>{getEngineLabel(candidate.id)}</h3>
                  <p>{candidate.source}</p>
                </div>
              </div>

              <div className="field-stack">
                <span className="helper-text">候補フォルダ</span>
                <code>{candidate.directoryPath}</code>
                <span className="helper-text">実行ファイル</span>
                <code>{candidate.executablePath}</code>
                <span className="helper-text">モデル</span>
                <code>
                  {candidate.modelName
                    ? `${candidate.modelName} / ${candidate.modelPath}`
                    : candidate.modelPath}
                </code>
              </div>

              <button
                type="button"
                className="button"
                onClick={() => void handleCandidateRegister(candidate)}
                disabled={busyEngine === candidate.id}
              >
                この候補を登録
              </button>
            </article>
          ))}
        </div>
      ) : null}

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
                  <h3>{getEngineLabel(status.id)}</h3>
                  <p>{getEngineDescription(status.id)}</p>
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
                {status.source ? <span className="chip">{status.source}</span> : null}
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
                  ZIP 取込（互換）
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => void handleDirectoryImport(status.id)}
                  disabled={isBusy}
                >
                  <FolderSearch size={16} />
                  PC 上のフォルダを指定
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => void handleOpenDownloadUrl(status.downloadUrl)}
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
