import { useEffect, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { open } from '@tauri-apps/plugin-dialog'

import { isTauriRuntime, listenOpenRequests, takePendingOpenPath } from '@/lib/tauri'

type OpenRequestPorts = {
  listen: (handler: () => void) => Promise<() => void>
  take: () => Promise<string | null>
  openPath: (path: string) => void
}

// 起動引数・2 つ目の起動・ドロップで要求された場所を受け取り続ける。待ち受けを始めてから 1 回
// 取り出すので、待ち受けの前に積まれた要求も取りこぼさない。戻り値で待ち受けをやめる。
export function watchOpenRequests({ listen, take, openPath }: OpenRequestPorts) {
  let disposed = false
  let unlisten: (() => void) | undefined

  const drain = () => {
    take().then(
      (path) => {
        if (!disposed && path) openPath(path)
      },
      () => {},
    )
  }

  listen(drain).then(
    (stop) => {
      if (disposed) {
        stop()
        return
      }
      unlisten = stop
      drain()
    },
    () => {},
  )

  return () => {
    disposed = true
    unlisten?.()
  }
}

// 場所の最後の名前(ビューアのルートの `bookId` に使う)。
function baseName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

// 場所をビューアで開く関数を返す。開いた本は `open_book` が履歴に残す。
export function useOpenPath() {
  const navigate = useNavigate()
  return (path: string) => {
    void navigate({ to: '/viewer/$bookId', params: { bookId: baseName(path) }, search: { path } })
  }
}

// アプリの外から要求された場所を、このウィンドウのビューアで開く。
export function useOpenRequests() {
  const openPath = useOpenPath()
  // 待ち受けは 1 回だけ張り、開くときは最新の描画の関数を使う。
  const openPathRef = useRef(openPath)
  useEffect(() => {
    openPathRef.current = openPath
  })
  useEffect(
    () =>
      // 外から要求が来るのはアプリ上だけ。
      isTauriRuntime
        ? watchOpenRequests({
            listen: listenOpenRequests,
            take: takePendingOpenPath,
            openPath: (path) => openPathRef.current(path),
          })
        : undefined,
    [],
  )
}

// 「ファイルを開く」ダイアログで本を選ばせ、選んだ場所を返す(取り消したら null)。
export async function pickBookFile() {
  const selected = await open({
    multiple: false,
    directory: false,
    title: 'ファイルを開く',
    filters: [
      {
        name: '本と画像',
        extensions: ['zip', 'cbz', 'epub', 'rar', 'cbr', 'pdf', 'jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'bmp'],
      },
    ],
  })
  return typeof selected === 'string' ? selected : null
}
