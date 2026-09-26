import { useEffect, useState } from 'react'
import { Database, ImageUpscale } from 'lucide-react'

import { Button, Dialog, ProgressLine } from '@/design'
import { useSettingsStore } from '@/features/settings/settings-store'
import {
  PREFETCH_PAGE_OPTIONS,
  effectiveModel,
  effectiveScale,
  engineModels,
  modelScaleOptions,
} from '@/features/viewer/enhancement'
import { engineOptions } from '@/lib/engines'
import { formatBytes } from '@/lib/format-bytes'
import { clearEnhanceCache, getEngineStatuses, getEnhanceCacheInfo, setEnhanceCacheLimit } from '@/lib/tauri'
import type { EngineStatus, EnhanceCacheInfo } from '@/types/app'

import styles from './ai-settings.module.css'

const mebibyte = 1024 * 1024
const gibibyte = 1024 * mebibyte

// 選べるキャッシュの上限。Rust の範囲(`minLimitBytes`〜`maxLimitBytes`)に入るものだけを出す。
const LIMIT_OPTIONS = [512 * mebibyte, gibibyte, 2 * gibibyte, 5 * gibibyte, 10 * gibibyte, 20 * gibibyte, 50 * gibibyte]

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

// 設定画面の「AI 超解像」。ビューアで AI を ON にしたときの既定のエンジン・モデル・倍率・先読み数と、
// 処理結果のキャッシュの使用量・上限・消去を置く。`engineRevision` が変わるとエンジンの状態を読み直す。
export function AiSettings({ engineRevision = 0 }: { engineRevision?: number }) {
  const preferredEngine = useSettingsStore((state) => state.preferredEngine)
  const enhanceModels = useSettingsStore((state) => state.enhanceModels)
  const enhanceScale = useSettingsStore((state) => state.enhanceScale)
  const prefetchPages = useSettingsStore((state) => state.enhancePrefetchPages)
  const enhanceNewBooks = useSettingsStore((state) => state.enhanceNewBooks)
  const setPreferredEngine = useSettingsStore((state) => state.setPreferredEngine)
  const setEnhanceModel = useSettingsStore((state) => state.setEnhanceModel)
  const setEnhanceScale = useSettingsStore((state) => state.setEnhanceScale)
  const setPrefetchPages = useSettingsStore((state) => state.setEnhancePrefetchPages)
  const setEnhanceNewBooks = useSettingsStore((state) => state.setEnhanceNewBooks)

  // 登録したモデルを既定のモデルの候補にするため、エンジンの状態を読む。読めなくても選べる。
  const [statuses, setStatuses] = useState<EngineStatus[]>([])
  useEffect(() => {
    let cancelled = false
    getEngineStatuses().then(
      (result) => {
        if (!cancelled) setStatuses(result)
      },
      () => undefined,
    )
    return () => {
      cancelled = true
    }
  }, [engineRevision])

  const registered = statuses.find((status) => status.id === preferredEngine)
  const model = effectiveModel(preferredEngine, enhanceModels[preferredEngine], registered?.modelName)
  const scales = modelScaleOptions(preferredEngine, model)
  const scale = effectiveScale(preferredEngine, model, enhanceScale)

  return (
    <section className="panel" aria-labelledby="ai-settings-heading">
      <div className="section-header">
        <ImageUpscale size={18} />
        <div>
          <h3 id="ai-settings-heading">ビューアでの処理</h3>
          <p>ビューアで AI を ON にしたときに使う設定です。処理した結果はキャッシュに残し、次に開いたときはすぐ表示します。</p>
        </div>
      </div>

      <div className="settings-compact-grid">
        <article className="setting-item">
          <div className="setting-item-header">
            <ImageUpscale size={18} />
            <div>
              <h4>既定の処理</h4>
              <p>選んだエンジンが使えないときは、登録済みの別のエンジンで処理します。</p>
            </div>
          </div>

          <div className={styles.field}>
            <span className={styles.label} id="ai-engine-label">
              エンジン
            </span>
            <div className="segmented-control" role="group" aria-labelledby="ai-engine-label">
              {engineOptions.map((engine) => {
                const status = statuses.find((candidate) => candidate.id === engine.id)
                return (
                  <button
                    key={engine.id}
                    type="button"
                    className="segmented-button"
                    onClick={() => setPreferredEngine(engine.id)}
                    disabled={preferredEngine === engine.id}
                    aria-pressed={preferredEngine === engine.id}
                    title={status && !status.ready ? `${engine.label}(未登録)` : engine.label}
                  >
                    {engine.label}
                  </button>
                )
              })}
            </div>
            {registered && !registered.ready ? (
              <p className={styles.note}>このエンジンはまだ使えません。下の「AI エンジン」から導入してください。</p>
            ) : null}
          </div>

          <label className="field-label">
            モデル
            <select value={model} onChange={(event) => setEnhanceModel(preferredEngine, event.target.value)}>
              {engineModels(preferredEngine).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>

          <div className={styles.field}>
            <span className={styles.label} id="ai-scale-label">
              倍率
            </span>
            <div className="segmented-control" role="group" aria-labelledby="ai-scale-label">
              {scales.map((value) => (
                <button
                  key={value}
                  type="button"
                  className="segmented-button"
                  onClick={() => setEnhanceScale(value)}
                  disabled={scale === value}
                  aria-pressed={scale === value}
                >
                  {value}×
                </button>
              ))}
            </div>
            <p className={styles.note}>このモデルが対応する倍率だけを表示しています。</p>
          </div>

          <label className="field-label">
            先読み
            <select value={prefetchPages} onChange={(event) => setPrefetchPages(Number(event.target.value))}>
              {PREFETCH_PAGE_OPTIONS.map((count) => (
                <option key={count} value={count}>
                  {count === 0 ? '表示中のページだけ' : `次の ${count} ページも処理する`}
                </option>
              ))}
            </select>
          </label>

          <div className={styles.field}>
            <label className={styles.toggle}>
              <input
                type="checkbox"
                checked={enhanceNewBooks}
                onChange={(event) => setEnhanceNewBooks(event.target.checked)}
              />
              初めて開く本でも AI をオンにする
            </label>
            <p className={styles.note}>ビューアでオン・オフを切り替えた本は、切り替えたとおりに開きます。</p>
          </div>
        </article>

        <EnhanceCacheSettings />
      </div>
    </section>
  )
}

function EnhanceCacheSettings() {
  const [info, setInfo] = useState<EnhanceCacheInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    let cancelled = false
    getEnhanceCacheInfo().then(
      (result) => {
        if (!cancelled) setInfo(result)
      },
      (reason: unknown) => {
        if (!cancelled) setError(`キャッシュの状態を読めません: ${messageOf(reason)}`)
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  const run = async (action: () => Promise<EnhanceCacheInfo>, failure: string) => {
    setBusy(true)
    setError(null)
    try {
      setInfo(await action())
    } catch (reason) {
      setError(`${failure}: ${messageOf(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  const limits = info
    ? LIMIT_OPTIONS.filter((bytes) => bytes >= info.minLimitBytes && bytes <= info.maxLimitBytes)
    : []
  // 保存されている上限が選択肢に無ければ、それも選択肢に並べる。
  if (info && !limits.includes(info.limitBytes)) {
    limits.push(info.limitBytes)
    limits.sort((a, b) => a - b)
  }

  return (
    <article className="setting-item">
      <div className="setting-item-header">
        <Database size={18} />
        <div>
          <h4>キャッシュ</h4>
          <p>上限を超えると、長く使っていない結果から消します。元の本の画像は変わりません。</p>
        </div>
      </div>

      {info ? (
        <div className={styles.usage}>
          <p className={styles.usageText}>
            <span className={styles.usageValue}>{formatBytes(info.usedBytes)}</span>
            <span> / {formatBytes(info.limitBytes)} 使用中</span>
            <span className={styles.usageCount}>{info.fileCount} ページ分</span>
          </p>
          <ProgressLine value={info.usedBytes / info.limitBytes} label="キャッシュの使用量" />
        </div>
      ) : error ? null : (
        <p className={styles.note}>使用量を調べています…</p>
      )}

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <label className="field-label">
        上限
        <select
          value={info?.limitBytes ?? ''}
          disabled={!info || busy}
          onChange={(event) =>
            void run(() => setEnhanceCacheLimit(Number(event.target.value)), '上限を変えられません')
          }
        >
          {limits.map((bytes) => (
            <option key={bytes} value={bytes}>
              {formatBytes(bytes)}
            </option>
          ))}
        </select>
      </label>

      <div>
        <Button onClick={() => setConfirming(true)} disabled={!info || busy || info.fileCount === 0}>
          キャッシュを消去
        </Button>
      </div>

      <Dialog
        open={confirming}
        title="キャッシュを消去しますか"
        onClose={() => setConfirming(false)}
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              やめる
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                setConfirming(false)
                void run(clearEnhanceCache, 'キャッシュを消去できません')
              }}
            >
              消去する
            </Button>
          </>
        }
      >
        <p>
          処理済みの {info?.fileCount ?? 0} ページ分({formatBytes(info?.usedBytes ?? 0)})を消します。
          次に AI を ON にしたページはもう一度処理します。
        </p>
      </Dialog>
    </article>
  )
}
