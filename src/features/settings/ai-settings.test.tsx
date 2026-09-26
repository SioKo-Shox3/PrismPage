import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EngineStatus, EnhanceCacheInfo } from '@/types/app'

import { AiSettings } from './ai-settings'
import { defaultSettings, useSettingsStore } from './settings-store'

const MiB = 1024 * 1024

const tauri = vi.hoisted(() => ({
  info: null as unknown as EnhanceCacheInfo,
  setLimit: vi.fn<(limitBytes: number) => Promise<EnhanceCacheInfo>>(),
  clear: vi.fn<() => Promise<EnhanceCacheInfo>>(),
}))

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  getEngineStatuses: () =>
    Promise.resolve([
      { id: 'real-cugan', label: 'Real-CUGAN', configured: true, ready: true, modelName: 'models-se', downloadUrl: '', notes: [] },
    ] satisfies EngineStatus[]),
  getEnhanceCacheInfo: () => Promise.resolve(tauri.info),
  setEnhanceCacheLimit: tauri.setLimit,
  clearEnhanceCache: tauri.clear,
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
  useSettingsStore.setState({ ...defaultSettings, preferredEngine: 'real-cugan' })
  tauri.info = { usedBytes: 700 * MiB, fileCount: 120, limitBytes: 2048 * MiB, minLimitBytes: 256 * MiB, maxLimitBytes: 1024 * 1024 * MiB }
  tauri.setLimit.mockReset().mockImplementation((limitBytes) =>
    Promise.resolve({ ...tauri.info, limitBytes, usedBytes: Math.min(tauri.info.usedBytes, limitBytes) }),
  )
  tauri.clear.mockReset().mockImplementation(() => Promise.resolve({ ...tauri.info, usedBytes: 0, fileCount: 0 }))
})

afterEach(() => {
  cleanup()
})

function scaleButtons() {
  return within(screen.getByRole('group', { name: '倍率' }))
    .getAllByRole('button')
    .map((button) => button.textContent)
}

describe('設定の AI 超解像', () => {
  it('モデルが対応する倍率だけを出し、持たない倍率を選んでいたらモデルの最小の倍率を選んだ表示にする', async () => {
    useSettingsStore.setState({ enhanceScale: 4 })
    render(<AiSettings />)
    expect(await screen.findByText('700 MB')).toBeTruthy()

    expect(scaleButtons()).toEqual(['2×', '3×', '4×'])
    fireEvent.change(screen.getByLabelText('モデル'), { target: { value: 'models-pro' } })
    expect(useSettingsStore.getState().enhanceModels).toEqual({ 'real-cugan': 'models-pro' })
    expect(scaleButtons()).toEqual(['2×', '3×'])
    expect(screen.getByRole('button', { name: '2×' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: '3×' }))
    expect(useSettingsStore.getState().enhanceScale).toBe(3)

    fireEvent.click(screen.getByRole('button', { name: 'waifu2x' }))
    expect(scaleButtons()).toEqual(['2×', '4×'])

    fireEvent.change(screen.getByLabelText('先読み'), { target: { value: '8' } })
    expect(useSettingsStore.getState().enhancePrefetchPages).toBe(8)

    const newBooks = screen.getByRole('checkbox', { name: '初めて開く本でも AI をオンにする' }) as HTMLInputElement
    expect(newBooks.checked).toBe(false)
    fireEvent.click(newBooks)
    expect(useSettingsStore.getState().enhanceNewBooks).toBe(true)
    expect(newBooks.checked).toBe(true)
  })

  it('キャッシュの上限を変えると Rust に渡し、消去は確認してから行って使用量を更新する', async () => {
    render(<AiSettings />)
    expect(await screen.findByText('700 MB')).toBeTruthy()
    expect(screen.getByText('/ 2 GB 使用中')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('上限'), { target: { value: String(512 * MiB) } })
    expect(tauri.setLimit).toHaveBeenCalledWith(512 * MiB)
    expect(await screen.findByText('/ 512 MB 使用中')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'キャッシュを消去' }))
    expect(tauri.clear).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '消去する' }))
    expect(tauri.clear).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('0 MB')).toBeTruthy()
  })
})
