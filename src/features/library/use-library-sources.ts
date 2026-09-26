import { useCallback, useEffect, useState } from 'react'

import { hasCommandBackend, listSources } from '@/lib/tauri'
import type { LibrarySource } from '@/types/app'

// 登録フォルダの一覧を読み、追加・削除の後は `reload` で読み直す。
// command を呼べない環境(ブラウザでの素の dev server)では空の一覧のまま。
export function useLibrarySources() {
  const [sources, setSources] = useState<LibrarySource[] | null>(hasCommandBackend ? null : [])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!hasCommandBackend) return Promise.resolve()
    return listSources().then(
      (result) => {
        setSources(result)
        setError(null)
      },
      (loadError: unknown) => {
        setError(
          loadError instanceof Error && loadError.message
            ? loadError.message
            : '登録フォルダを読み込めませんでした。',
        )
      },
    )
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return { sources, error, reload: load }
}
