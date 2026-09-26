import { useCallback, useEffect, useState } from 'react'
import { Archive } from 'lucide-react'

import { Button, Dialog } from '@/design'
import { formatBytes } from '@/lib/format-bytes'
import { deleteLegacyLibraryDir, getLegacyLibraryDir } from '@/lib/tauri'
import type { LegacyLibraryDir } from '@/types/app'

import styles from './legacy-data-settings.module.css'

// 旧版が本の一覧を保存していた localStorage のキー。今の版は読まない。
export const LEGACY_STORAGE_KEY = 'prismpage-library'

// 消す対象の 1 件。`detail` は利用者に見せる件数とおおよその大きさ。
interface LegacyTarget {
  id: 'library-dir' | 'storage-key'
  label: string
  location: string
  detail: string
}

function readLegacyStorage(): string | null {
  try {
    return localStorage.getItem(LEGACY_STORAGE_KEY)
  } catch {
    return null
  }
}

function toTargets(dir: LegacyLibraryDir | null, stored: string | null): LegacyTarget[] {
  const targets: LegacyTarget[] = []
  if (dir) {
    targets.push({
      id: 'library-dir',
      label: 'アプリのデータ領域の library フォルダ',
      location: dir.path,
      detail: `${dir.fileCount} 件・${formatBytes(dir.totalBytes)}`,
    })
  }
  if (stored !== null) {
    targets.push({
      id: 'storage-key',
      label: '画面の保存領域(localStorage)の本の一覧',
      location: LEGACY_STORAGE_KEY,
      // localStorage は UTF-16 で持つので 1 文字 2 バイトで見積もる。
      detail: formatBytes(stored.length * 2),
    })
  }
  return targets
}

function messageOf(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) return String(error.message)
  return String(error)
}

// 設定画面の「旧バージョンのデータ」。旧版が残した library フォルダと localStorage のキーだけを、
// 一覧を見せて確認を取ってから消す。今の版のデータベース・キャッシュ・設定には触れない。
export function LegacyDataSettings() {
  const [targets, setTargets] = useState<LegacyTarget[] | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  // 旧フォルダを読めなかったときはエラーを出し、localStorage 側の対象だけを並べる。
  const reload = useCallback(
    () =>
      getLegacyLibraryDir().then(
        (dir) => setTargets(toTargets(dir, readLegacyStorage())),
        (loadError: unknown) => {
          setError(messageOf(loadError))
          setTargets(toTargets(null, readLegacyStorage()))
        },
      ),
    [],
  )

  useEffect(() => {
    void reload()
  }, [reload])

  async function handleDelete() {
    setDeleting(true)
    setError(null)
    setMessage(null)
    try {
      if (targets?.some((target) => target.id === 'library-dir')) {
        await deleteLegacyLibraryDir()
      }
      if (targets?.some((target) => target.id === 'storage-key')) {
        localStorage.removeItem(LEGACY_STORAGE_KEY)
      }
      setMessage('旧バージョンのデータを削除しました。')
    } catch (deleteError) {
      setError(messageOf(deleteError))
    } finally {
      setDeleting(false)
      setConfirming(false)
      await reload()
    }
  }

  const found = targets !== null && targets.length > 0

  return (
    <section className="panel" aria-labelledby="legacy-data-heading">
      <div className="section-header">
        <Archive size={18} />
        <div>
          <h3 id="legacy-data-heading">旧バージョンのデータ</h3>
          <p>作り直す前の版が残したデータです。今の版は読まないので、消しても本棚や読書位置は変わりません。</p>
        </div>
      </div>

      {targets === null ? null : found ? (
        <TargetList targets={targets} />
      ) : (
        <p className={styles.empty}>旧バージョンのデータは見つかりません。</p>
      )}

      {error ? (
        <p className="message-strip is-error" role="alert">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="message-strip is-success" role="status">
          {message}
        </p>
      ) : null}

      <div>
        <Button onClick={() => setConfirming(true)} disabled={!found || deleting}>
          旧バージョンのデータを削除
        </Button>
      </div>

      <Dialog
        open={confirming}
        title="旧バージョンのデータを削除"
        onClose={() => {
          if (!deleting) setConfirming(false)
        }}
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={deleting}>
              やめる
            </Button>
            <Button variant="primary" onClick={() => void handleDelete()} disabled={deleting} aria-busy={deleting}>
              {deleting ? '削除中…' : '削除する'}
            </Button>
          </>
        }
      >
        <p className={styles.lead}>次のデータを削除します。元に戻せません。</p>
        {targets ? <TargetList targets={targets} /> : null}
      </Dialog>
    </section>
  )
}

function TargetList({ targets }: { targets: LegacyTarget[] }) {
  return (
    <ul className={styles.list} aria-label="削除する旧データ">
      {targets.map((target) => (
        <li key={target.id} className={styles.item}>
          <span className={styles.label}>{target.label}</span>
          <code className={styles.location}>{target.location}</code>
          <span className={styles.detail}>{target.detail}</span>
        </li>
      ))}
    </ul>
  )
}
