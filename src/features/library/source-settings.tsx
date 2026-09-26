import { useState } from 'react'
import { FolderTree, Trash2 } from 'lucide-react'

import { Button, IconButton } from '@/design'
import type { LibrarySource } from '@/types/app'

import { AddSourceDialog, RemoveSourceDialog } from './source-dialogs'
import { useLibrarySources } from './use-library-sources'
import styles from './source-settings.module.css'

// 設定画面の「ライブラリ」。登録フォルダの一覧と、追加・削除のダイアログを開く操作を置く。
export function LibrarySourceSettings() {
  const { sources, error, reload } = useLibrarySources()
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<LibrarySource | null>(null)

  return (
    <section className="panel" aria-labelledby="library-sources-heading">
      <div className="section-header">
        <FolderTree size={18} />
        <div>
          <h3 id="library-sources-heading">登録フォルダ</h3>
          <p>本を読むフォルダを登録します。フォルダの中身はコピーも変更もしません。</p>
        </div>
      </div>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      {sources && sources.length > 0 ? (
        <ul className={styles.list} aria-label="登録フォルダ">
          {sources.map((source) => (
            <li key={source.id} className={styles.item}>
              <span className={styles.text}>
                <span className={styles.name}>{source.name}</span>
                <span className={styles.path}>{source.displayPath}</span>
              </span>
              <IconButton
                icon={Trash2}
                label={`「${source.name}」の登録を外す`}
                size="sm"
                onClick={() => setRemoving(source)}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {sources && sources.length === 0 ? (
        <p className={styles.empty}>まだフォルダが登録されていません。</p>
      ) : null}

      <div>
        <Button onClick={() => setAdding(true)}>フォルダを登録</Button>
      </div>

      <AddSourceDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={() => {
          setAdding(false)
          void reload()
        }}
      />
      <RemoveSourceDialog
        source={removing}
        onClose={() => setRemoving(null)}
        onRemoved={() => {
          setRemoving(null)
          void reload()
        }}
      />
    </section>
  )
}
