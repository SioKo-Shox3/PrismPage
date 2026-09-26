import { useEffect, useRef, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Cpu } from 'lucide-react'

import { Badge, Button, Dialog, ProgressLine } from '@/design'
import { useSettingsStore } from '@/features/settings/settings-store'
import { engineOptions, getEngineLabel } from '@/lib/engines'
import {
  clearEngineRegistration,
  detectEngineCandidates,
  getEngineInstallOptions,
  getEngineStatuses,
  importEngineArchive,
  installEngineFromRelease,
  isTauriRuntime,
  registerEngineDirectory,
} from '@/lib/tauri'
import type { EngineCandidate, EngineId, EngineInstallProgress, EngineStatus } from '@/types/app'

import { describeEngineFailure, engineState, installProgressView, sourceText, type EngineFailure } from './engine-install'
import {
  loadEngineStatuses,
  runEngineOperation,
  setEngineCandidates,
  setEngineProgress,
  useEngineOperations,
  type EngineBusy,
} from './engine-operation-store'
import styles from './engine-settings.module.css'

export interface EngineSettingsProps {
  // 登録の状態が変わったとき(導入・登録・解除・確かめ直し)に呼ぶ。
  onStatusesChange?: (statuses: EngineStatus[]) => void
}

// 設定画面の「AI エンジン」。エンジンごとの状態と、導入(公式配布の取得・ZIP の取り込み・フォルダの登録・
// PC 内の候補の登録)、状態の確かめ直し、登録の解除を置く。導入中は進み具合を、失敗したら原因と次の手を出す。
// 操作の状態は画面の外(`engine-operation-store.ts`)に持つので、導入中に画面を離れて戻っても続きを出す。
export function EngineSettings({ onStatusesChange }: EngineSettingsProps) {
  const preferredEngine = useSettingsStore((state) => state.preferredEngine)
  const statuses = useEngineOperations((state) => state.statuses)
  const statusesRevision = useEngineOperations((state) => state.statusesRevision)
  const busy = useEngineOperations((state) => state.busy)
  const progress = useEngineOperations((state) => state.progress)
  const failures = useEngineOperations((state) => state.failures)
  const notice = useEngineOperations((state) => state.notice)
  const candidates = useEngineOperations((state) => state.candidates)
  const [confirmClear, setConfirmClear] = useState<EngineId | null>(null)

  // 状態は開くたびに読み直す。ヘルスチェック(実行ファイルの起動)を含むので少し待つことがある。
  // 操作が走っている間は読まず、操作の結果を待つ。
  useEffect(() => {
    void loadEngineStatuses(getEngineStatuses)
  }, [])

  // 画面を開いた後に操作の結果で状態が変わったら知らせる(開く前の変化は知らせない)。
  const seenRevision = useRef(statusesRevision)
  useEffect(() => {
    if (statusesRevision === seenRevision.current) return
    seenRevision.current = statusesRevision
    if (statuses) onStatusesChange?.(statuses)
  }, [statusesRevision, statuses, onStatusesChange])

  const installRelease = (engineId: EngineId) =>
    runEngineOperation('release', engineId, async () => {
      setEngineProgress({ engineId, stage: 'verifying', done: 0, total: 0 })
      const response = await getEngineInstallOptions()
      const option = response.options.find((entry) => entry.engineId === engineId)
      if (!option) {
        const warning = response.warnings.find((entry) => entry.engineId === engineId)
        throw new Error(warning?.message ?? `${getEngineLabel(engineId)} の公式配布が見つかりませんでした。`)
      }
      const status = await installEngineFromRelease(option)
      return { status, notice: `${getEngineLabel(engineId)} を導入しました(${option.releaseName})。` }
    })

  const importArchive = (engineId: EngineId) =>
    runEngineOperation('archive', engineId, async () => {
      const selected = await open({
        directory: false,
        multiple: false,
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
        title: `${getEngineLabel(engineId)} の配布 ZIP を選ぶ`,
      })
      if (typeof selected !== 'string') return null
      setEngineProgress({ engineId, stage: 'extracting', done: 0, total: 0 })
      const status = await importEngineArchive(engineId, selected)
      return { status, notice: `${getEngineLabel(engineId)} を ZIP から取り込みました。` }
    })

  const registerDirectory = (engineId: EngineId) =>
    runEngineOperation('directory', engineId, async () => {
      const selected = await open({
        directory: true,
        multiple: false,
        title: `${getEngineLabel(engineId)} のフォルダを選ぶ`,
      })
      if (typeof selected !== 'string') return null
      const status = await registerEngineDirectory(engineId, selected)
      return { status, notice: `${getEngineLabel(engineId)} のフォルダを登録しました。` }
    })

  const registerCandidate = (candidate: EngineCandidate) =>
    runEngineOperation('candidate', candidate.id, async () => {
      const status = await registerEngineDirectory(candidate.id, candidate.directoryPath)
      setEngineCandidates((current) => current?.filter((entry) => entry !== candidate) ?? null)
      return { status, notice: `${getEngineLabel(candidate.id)} を登録しました。` }
    })

  const detect = () =>
    runEngineOperation('detect', null, async () => {
      const found = await detectEngineCandidates()
      setEngineCandidates(() => found)
      return {
        notice:
          found.length > 0
            ? `${found.length} 件のエンジンが見つかりました。`
            : 'よく使われる置き場所にはエンジンが見つかりませんでした。',
      }
    })

  const recheck = () =>
    runEngineOperation('status', null, async () => ({ statuses: await getEngineStatuses(), notice: 'エンジンの状態を確かめました。' }))

  const clear = (engineId: EngineId) =>
    runEngineOperation('clear', engineId, async () => ({
      statuses: await clearEngineRegistration(engineId),
      notice: `${getEngineLabel(engineId)} の登録を解除しました。`,
    }))

  const openDownloadPage = async (url: string) => {
    if (isTauriRuntime) {
      try {
        await openUrl(url)
        return
      } catch {
        // 既定のブラウザで開けなければ、下の window.open で開く。
      }
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const allFailure = failures.get('all')

  return (
    <section className={`panel ${styles.section}`} aria-labelledby="engine-settings-heading">
      <div className="section-header">
        <Cpu size={18} />
        <div>
          <h3 id="engine-settings-heading">AI エンジン</h3>
          <p>
            {'超解像に使うエンジンを導入します。公式配布をそのまま取得するのがいちばん簡単です。' +
              'エンジンはアプリのデータ領域に置き、元の本には触れません。'}
          </p>
        </div>
      </div>

      <div className={styles.toolbar}>
        <Button onClick={() => void detect()} disabled={busy !== null}>
          {busy?.operation === 'detect' ? '探しています…' : 'PC 内のエンジンを探す'}
        </Button>
        <Button variant="ghost" onClick={() => void recheck()} disabled={busy !== null}>
          {busy?.operation === 'status' ? '確かめています…' : '状態を確かめる'}
        </Button>
        {notice ? (
          <p className={styles.notice} role="status">
            {notice}
          </p>
        ) : null}
      </div>

      {allFailure ? <FailureNote failure={allFailure} /> : null}

      {candidates && candidates.length > 0 ? (
        <div className={styles.candidates}>
          <h4 className={styles.subheading}>見つかったエンジン</h4>
          <ul className={styles.candidateList}>
            {candidates.map((candidate) => (
              <li key={`${candidate.id}-${candidate.executablePath}`} className={styles.candidate}>
                <div className={styles.candidateText}>
                  <span className={styles.candidateName}>{getEngineLabel(candidate.id)}</span>
                  <code className={styles.path}>{candidate.directoryPath}</code>
                </div>
                <Button size="sm" onClick={() => void registerCandidate(candidate)} disabled={busy !== null}>
                  登録する
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {statuses === null ? (
        <p className={styles.note}>エンジンの状態を確かめています…</p>
      ) : (
        <ul className={styles.engines}>
          {engineOptions.map((engine) => {
            const status = statuses.find((entry) => entry.id === engine.id)
            return (
              <EngineRow
                key={engine.id}
                engineId={engine.id}
                description={engine.description}
                status={status}
                preferred={preferredEngine === engine.id}
                busy={busy}
                progress={progress?.engineId === engine.id ? progress : null}
                failure={failures.get(engine.id) ?? null}
                onInstall={() => void installRelease(engine.id)}
                onImport={() => void importArchive(engine.id)}
                onRegister={() => void registerDirectory(engine.id)}
                onOpenPage={() => void openDownloadPage(status?.downloadUrl ?? '')}
                onClear={() => setConfirmClear(engine.id)}
              />
            )
          })}
        </ul>
      )}

      <Dialog
        open={confirmClear !== null}
        title="エンジンの登録を解除しますか"
        onClose={() => setConfirmClear(null)}
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmClear(null)}>
              やめる
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                const engineId = confirmClear
                setConfirmClear(null)
                if (engineId) void clear(engineId)
              }}
            >
              解除する
            </Button>
          </>
        }
      >
        <p>
          {confirmClear ? getEngineLabel(confirmClear) : ''} をこのアプリで使わなくなります。
          導入したファイルと処理済みの結果は残るので、あとで登録し直せます。
        </p>
      </Dialog>
    </section>
  )
}

interface EngineRowProps {
  engineId: EngineId
  description: string
  status: EngineStatus | undefined
  preferred: boolean
  busy: EngineBusy | null
  progress: EngineInstallProgress | null
  failure: EngineFailure | null
  onInstall: () => void
  onImport: () => void
  onRegister: () => void
  onOpenPage: () => void
  onClear: () => void
}

function EngineRow({
  engineId,
  description,
  status,
  preferred,
  busy,
  progress,
  failure,
  onInstall,
  onImport,
  onRegister,
  onOpenPage,
  onClear,
}: EngineRowProps) {
  const label = getEngineLabel(engineId)
  const state = status ? engineState(status) : null
  const source = sourceText(status?.source)
  const working = busy?.engineId === engineId
  const disabled = busy !== null
  const progressView = working && progress ? installProgressView(progress) : null

  return (
    <li className={styles.engine} aria-labelledby={`engine-${engineId}`}>
      <div className={styles.engineHead}>
        <h4 className={styles.engineName} id={`engine-${engineId}`}>
          {label}
        </h4>
        <span className={styles.engineKind}>{description}</span>
        <span className={styles.badges}>
          {preferred ? <Badge tone="accent">既定</Badge> : null}
          {state ? <Badge tone={state.tone}>{state.label}</Badge> : null}
        </span>
      </div>

      {status?.configured ? (
        <dl className={styles.facts}>
          {source ? (
            <>
              <dt>導入</dt>
              <dd>{source}</dd>
            </>
          ) : null}
          <dt>実行ファイル</dt>
          <dd>
            <code className={styles.path}>{status.executablePath ?? '—'}</code>
          </dd>
          <dt>モデル</dt>
          <dd>
            <code className={styles.path}>{status.modelPath ?? '—'}</code>
          </dd>
        </dl>
      ) : (
        <p className={styles.note}>まだ導入していません。「公式配布を取得」で、配布されている最新の版を入れます。</p>
      )}

      {status?.configured && status.warning && !failure ? (
        <FailureNote
          failure={{
            title: 'このエンジンは今は使えません',
            cause: status.warning,
            next: describeEngineFailure('status', status.warning, engineId).next,
          }}
        />
      ) : null}

      {working && busy.operation !== 'clear' ? (
        <div className={styles.progress}>
          <ProgressLine value={progressView?.value ?? null} label={`${label} の導入の進み具合`} />
          <p className={styles.progressText} role="status">
            {progressView?.text ?? '準備しています…'}
          </p>
        </div>
      ) : null}

      {failure ? <FailureNote failure={failure} /> : null}

      <div className={styles.actions}>
        <Button variant={status?.configured ? 'secondary' : 'primary'} onClick={onInstall} disabled={disabled}>
          {working && busy.operation === 'release'
            ? '取得しています…'
            : status?.configured
              ? '公式配布で入れ直す'
              : '公式配布を取得'}
        </Button>
        <Button onClick={onImport} disabled={disabled}>
          ZIP を取り込む
        </Button>
        <Button onClick={onRegister} disabled={disabled}>
          フォルダを登録
        </Button>
        <Button variant="ghost" onClick={onOpenPage} disabled={!status?.downloadUrl}>
          配布ページ
        </Button>
        {status?.configured ? (
          <Button variant="ghost" className={styles.clear} onClick={onClear} disabled={disabled}>
            {working && busy.operation === 'clear' ? '解除しています…' : '登録を解除'}
          </Button>
        ) : null}
      </div>
    </li>
  )
}

function FailureNote({ failure }: { failure: EngineFailure }) {
  return (
    <div className={styles.failure} role="alert">
      <p className={styles.failureTitle}>{failure.title}</p>
      <p>
        <span className={styles.failureLabel}>原因</span>
        {failure.cause}
      </p>
      <p>
        <span className={styles.failureLabel}>次の手</span>
        {failure.next}
      </p>
    </div>
  )
}
