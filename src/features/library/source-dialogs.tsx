import { useState } from 'react'
import type { FormEvent } from 'react'
import { open } from '@tauri-apps/plugin-dialog'

import { Button, Dialog, TextField } from '@/design'
import { addSource, isTauriRuntime, removeSource } from '@/lib/tauri'
import type { LibrarySource } from '@/types/app'

// 登録フォルダの追加・削除のダイアログ。設定画面とフォルダ画面の両方から使う。

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

export interface AddSourceDialogProps {
  open: boolean
  onClose: () => void
  onAdded: (source: LibrarySource) => void
}

// フォルダを登録するダイアログ。パスを入力するか、アプリ上では「参照」で OS のフォルダ選択から選ぶ。
export function AddSourceDialog({ open: isOpen, onClose, onAdded }: AddSourceDialogProps) {
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const close = () => {
    setPath('')
    setError(null)
    onClose()
  }

  const browse = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: '登録するフォルダを選択' })
      if (typeof selected === 'string') {
        setPath(selected)
        setError(null)
      }
    } catch (dialogError) {
      setError(messageOf(dialogError, 'フォルダ選択ダイアログを開けませんでした。'))
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (path.trim().length === 0) {
      setError('登録するフォルダのパスを入力してください。')
      return
    }
    setBusy(true)
    try {
      const source = await addSource(path.trim())
      setPath('')
      setError(null)
      onAdded(source)
    } catch (addError) {
      setError(messageOf(addError, 'フォルダを登録できませんでした。'))
    } finally {
      setBusy(false)
    }
  }

  const formId = 'add-source-form'

  return (
    <Dialog
      open={isOpen}
      title="フォルダを登録"
      onClose={close}
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            キャンセル
          </Button>
          <Button variant="primary" type="submit" form={formId} disabled={busy}>
            登録する
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(event) => void submit(event)}>
        <p>
          本や画像を入れたフォルダを登録すると、フォルダ画面から中を辿って読めます。フォルダの中身はコピーも変更もしません。
        </p>
        <TextField
          label="フォルダのパス"
          placeholder="C:\Users\name\Pictures\Comics"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          error={error ?? undefined}
          autoFocus
        />
        {isTauriRuntime ? (
          <Button size="sm" onClick={() => void browse()}>
            参照…
          </Button>
        ) : null}
      </form>
    </Dialog>
  )
}

export interface RemoveSourceDialogProps {
  source: LibrarySource | null
  onClose: () => void
  onRemoved: (source: LibrarySource) => void
}

// 登録フォルダを外す確認のダイアログ。`source` が null の間は閉じている。
export function RemoveSourceDialog({ source, onClose, onRemoved }: RemoveSourceDialogProps) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const close = () => {
    setError(null)
    onClose()
  }

  const confirm = async () => {
    if (!source) return
    setBusy(true)
    try {
      await removeSource(source.id)
      setError(null)
      onRemoved(source)
    } catch (removeError) {
      setError(messageOf(removeError, '登録を外せませんでした。'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={source !== null}
      title="登録を外す"
      onClose={close}
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            キャンセル
          </Button>
          <Button variant="primary" onClick={() => void confirm()} disabled={busy}>
            登録を外す
          </Button>
        </>
      }
    >
      {source ? (
        <>
          <p>
            「{source.name}」({source.displayPath})を登録から外します。フォルダとその中身は消えません。
          </p>
          {error ? <p role="alert">{error}</p> : null}
        </>
      ) : null}
    </Dialog>
  )
}
