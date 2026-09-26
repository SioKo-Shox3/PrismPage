import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LegacyLibraryDir } from '@/types/app'

import { LEGACY_STORAGE_KEY, LegacyDataSettings } from './legacy-data-settings'

const tauri = vi.hoisted(() => ({
  dir: null as LegacyLibraryDir | null,
  remove: vi.fn<() => Promise<void>>(),
}))

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  getLegacyLibraryDir: () => Promise.resolve(tauri.dir),
  deleteLegacyLibraryDir: tauri.remove,
}))

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open')
  }
})

beforeEach(() => {
  localStorage.clear()
  tauri.dir = { path: 'C:\\data\\library', fileCount: 3, totalBytes: 2 * 1024 * 1024 }
  tauri.remove.mockReset().mockImplementation(() => {
    tauri.dir = null
    return Promise.resolve()
  })
})

afterEach(() => {
  cleanup()
})

describe('旧バージョンのデータの削除', () => {
  it('対象の一覧を確認ダイアログに出し、削除するまで何も消さない', async () => {
    localStorage.setItem(LEGACY_STORAGE_KEY, '{"books":[]}')
    render(<LegacyDataSettings />)

    await screen.findByText('C:\\data\\library')
    fireEvent.click(screen.getByRole('button', { name: '旧バージョンのデータを削除' }))

    const dialog = screen.getByRole('dialog', { name: '旧バージョンのデータを削除' })
    expect(within(dialog).getByText('C:\\data\\library')).toBeTruthy()
    expect(within(dialog).getByText(LEGACY_STORAGE_KEY)).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }))
    expect(tauri.remove).not.toHaveBeenCalled()
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).not.toBeNull()
  })

  it('確認すると旧フォルダと旧キーだけを消し、今の設定のキーは残す', async () => {
    localStorage.setItem(LEGACY_STORAGE_KEY, '{"books":[]}')
    localStorage.setItem('prismpage-settings', '{"state":{},"version":5}')
    render(<LegacyDataSettings />)

    await screen.findByText('C:\\data\\library')
    fireEvent.click(screen.getByRole('button', { name: '旧バージョンのデータを削除' }))
    const dialog = screen.getByRole('dialog', { name: '旧バージョンのデータを削除' })
    fireEvent.click(within(dialog).getByRole('button', { name: '削除する' }))

    await screen.findByText('旧バージョンのデータは見つかりません。')
    expect(tauri.remove).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem('prismpage-settings')).not.toBeNull()
  })

  it('旧データが無ければ削除の操作を押せない', async () => {
    tauri.dir = null
    render(<LegacyDataSettings />)

    await screen.findByText('旧バージョンのデータは見つかりません。')
    expect((screen.getByRole('button', { name: '旧バージョンのデータを削除' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })
})
