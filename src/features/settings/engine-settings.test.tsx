import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  EngineCandidate,
  EngineId,
  EngineInstallOption,
  EngineInstallOptionsResponse,
  EngineInstallProgress,
  EngineStatus,
} from '@/types/app'

import { describeEngineFailure, installProgressView } from './engine-install'
import { resetEngineOperations } from './engine-operation-store'
import { EngineSettings } from './engine-settings'
import { defaultSettings, useSettingsStore } from './settings-store'

const tauri = vi.hoisted(() => ({
  statuses: [] as EngineStatus[],
  options: { options: [], warnings: [] } as EngineInstallOptionsResponse,
  candidates: [] as EngineCandidate[],
  install: vi.fn<(option: EngineInstallOption) => Promise<EngineStatus>>(),
  register: vi.fn<(engineId: EngineId, directoryPath: string) => Promise<EngineStatus>>(),
  clear: vi.fn<(engineId: EngineId) => Promise<EngineStatus[]>>(),
  handlers: new Set<(event: EngineInstallProgress) => void>(),
}))

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  getEngineStatuses: () => Promise.resolve(tauri.statuses),
  getEngineInstallOptions: () => Promise.resolve(tauri.options),
  detectEngineCandidates: () => Promise.resolve(tauri.candidates),
  installEngineFromRelease: tauri.install,
  registerEngineDirectory: tauri.register,
  clearEngineRegistration: tauri.clear,
  listenEngineInstallProgress: (handler: (event: EngineInstallProgress) => void) => {
    tauri.handlers.add(handler)
    return Promise.resolve(() => {
      tauri.handlers.delete(handler)
    })
  },
}))

function unregistered(id: EngineId): EngineStatus {
  return { id, label: id, configured: false, ready: false, downloadUrl: `https://github.com/${id}/releases`, notes: [] }
}

function registered(id: EngineId, overrides: Partial<EngineStatus> = {}): EngineStatus {
  return {
    ...unregistered(id),
    configured: true,
    ready: true,
    executablePath: `C:\\engines\\${id}\\${id}-ncnn-vulkan.exe`,
    modelPath: `C:\\engines\\${id}\\models`,
    source: 'アプリ内インストール',
    ...overrides,
  }
}

const waifuOption: EngineInstallOption = {
  engineId: 'waifu2x',
  label: 'waifu2x',
  releaseName: '20220728',
  releaseTag: '20220728',
  assetName: 'waifu2x-ncnn-vulkan-20220728-windows.zip',
  downloadUrl: 'https://github.com/nihui/waifu2x-ncnn-vulkan/releases/download/20220728/w.zip',
  size: 40 * 1024 * 1024,
}

function emit(event: EngineInstallProgress) {
  act(() => {
    for (const handler of tauri.handlers) handler(event)
  })
}

function engineRow(name: string) {
  return screen.getByRole('listitem', { name })
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open')
  }
})

beforeEach(() => {
  resetEngineOperations()
  useSettingsStore.setState({ ...defaultSettings, preferredEngine: 'real-cugan' })
  tauri.statuses = [registered('real-cugan'), unregistered('waifu2x'), unregistered('real-esrgan')]
  tauri.options = { options: [waifuOption], warnings: [] }
  tauri.candidates = []
  tauri.handlers.clear()
  tauri.install.mockReset()
  tauri.register.mockReset()
  tauri.clear.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('設定の AI エンジン', () => {
  it('エンジンごとの状態を出す', async () => {
    render(<EngineSettings />)
    const cugan = await screen.findByRole('listitem', { name: 'Real-CUGAN' })
    expect(within(cugan).getByText('使えます')).toBeTruthy()
    expect(within(cugan).getByText('既定')).toBeTruthy()
    expect(within(cugan).getByText('公式配布から導入')).toBeTruthy()
    expect(within(cugan).getByRole('button', { name: '登録を解除' })).toBeTruthy()
    const waifu = engineRow('waifu2x')
    expect(within(waifu).getByText('未登録')).toBeTruthy()
    expect(within(waifu).queryByRole('button', { name: '登録を解除' })).toBeNull()
  })

  it('公式配布を取得すると段階ごとの進み具合を出し、終わると使える状態にして状態の変化を知らせる', async () => {
    let finish: (status: EngineStatus) => void = () => undefined
    tauri.install.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    const onStatusesChange = vi.fn()
    render(<EngineSettings onStatusesChange={onStatusesChange} />)
    await screen.findByRole('listitem', { name: 'waifu2x' })

    fireEvent.click(within(engineRow('waifu2x')).getByRole('button', { name: '公式配布を取得' }))
    await vi.waitFor(() => expect(tauri.install).toHaveBeenCalledWith(waifuOption))
    const row = engineRow('waifu2x')
    // 取得中はほかのエンジンの操作も止める(登録簿は 1 つずつ書く)。
    expect(within(engineRow('Real-ESRGAN')).getByRole('button', { name: '公式配布を取得' })).toHaveProperty('disabled', true)

    emit({ engineId: 'waifu2x', stage: 'downloading', done: 10 * 1024 * 1024, total: 40 * 1024 * 1024 })
    expect(within(row).getByText('ダウンロードしています 10.0 MB / 40.0 MB')).toBeTruthy()
    expect(within(row).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25')
    // 別のエンジンの進み具合は出さない。
    emit({ engineId: 'real-esrgan', stage: 'extracting', done: 1, total: 2 })
    expect(within(row).getByText('ダウンロードしています 10.0 MB / 40.0 MB')).toBeTruthy()
    emit({ engineId: 'waifu2x', stage: 'extracting', done: 30, total: 120 })
    expect(within(row).getByText('展開しています 30 / 120 項目')).toBeTruthy()

    await act(async () => finish(registered('waifu2x')))
    expect(await within(row).findByText('使えます')).toBeTruthy()
    expect(within(row).queryByRole('progressbar')).toBeNull()
    expect(screen.getByText('waifu2x を導入しました(20220728)。')).toBeTruthy()
    expect(onStatusesChange).toHaveBeenCalledTimes(1)
  })

  it('導入中に画面を離れて戻っても、進み具合を出し続け、終わった結果を引き継ぐ', async () => {
    let finish: (status: EngineStatus) => void = () => undefined
    tauri.install.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    const first = render(<EngineSettings />)
    await screen.findByRole('listitem', { name: 'waifu2x' })
    fireEvent.click(within(engineRow('waifu2x')).getByRole('button', { name: '公式配布を取得' }))
    await vi.waitFor(() => expect(tauri.install).toHaveBeenCalled())
    emit({ engineId: 'waifu2x', stage: 'downloading', done: 10 * 1024 * 1024, total: 40 * 1024 * 1024 })
    first.unmount()

    // 画面の外でも進み具合は受け続ける。
    emit({ engineId: 'waifu2x', stage: 'extracting', done: 30, total: 120 })
    render(<EngineSettings />)
    const row = await screen.findByRole('listitem', { name: 'waifu2x' })
    expect(within(row).getByText('展開しています 30 / 120 項目')).toBeTruthy()
    expect(within(row).getByRole('button', { name: '取得しています…' })).toHaveProperty('disabled', true)

    await act(async () => finish(registered('waifu2x')))
    expect(await within(engineRow('waifu2x')).findByText('使えます')).toBeTruthy()
    expect(within(engineRow('waifu2x')).queryByRole('progressbar')).toBeNull()
  })

  it('導入に失敗したら、そのエンジンの行に原因と次の手を出す', async () => {
    tauri.install.mockRejectedValue(new Error('GitHub Releases API への接続に失敗しました: error sending request'))
    render(<EngineSettings />)
    await screen.findByRole('listitem', { name: 'waifu2x' })

    fireEvent.click(within(engineRow('waifu2x')).getByRole('button', { name: '公式配布を取得' }))
    const alert = await within(engineRow('waifu2x')).findByRole('alert')
    expect(alert.textContent).toContain('公式配布を導入できませんでした')
    expect(alert.textContent).toContain('原因GitHub Releases API への接続に失敗しました')
    expect(alert.textContent).toContain('次の手インターネットへの接続を確かめて')
    expect(within(engineRow('waifu2x')).getByText('未登録')).toBeTruthy()
  })

  it('公式配布が見つからなければ、取得を始めずに配布ページからの取り込みを案内する', async () => {
    tauri.options = {
      options: [],
      warnings: [{ engineId: 'waifu2x', label: 'waifu2x', message: 'waifu2x のインストール可能な Windows ZIP 配布 asset が見つかりませんでした。' }],
    }
    render(<EngineSettings />)
    await screen.findByRole('listitem', { name: 'waifu2x' })

    fireEvent.click(within(engineRow('waifu2x')).getByRole('button', { name: '公式配布を取得' }))
    const alert = await within(engineRow('waifu2x')).findByRole('alert')
    expect(alert.textContent).toContain('Windows ZIP 配布 asset が見つかりませんでした')
    expect(alert.textContent).toContain('「ZIP を取り込む」')
    expect(tauri.install).not.toHaveBeenCalled()
  })

  it('登録したが動かないエンジンは、理由と次の手を出す', async () => {
    tauri.statuses = [
      registered('real-cugan', { ready: false, warning: 'AI エンジンを起動できませんでした: Vulkan の初期化に失敗しました' }),
      unregistered('waifu2x'),
      unregistered('real-esrgan'),
    ]
    render(<EngineSettings />)
    const row = await screen.findByRole('listitem', { name: 'Real-CUGAN' })
    expect(within(row).getByText('動作を確かめられません')).toBeTruthy()
    const alert = within(row).getByRole('alert')
    expect(alert.textContent).toContain('Vulkan の初期化に失敗しました')
    expect(alert.textContent).toContain('GPU のドライバーを更新')
  })

  it('登録の解除は確かめてから行う', async () => {
    tauri.clear.mockResolvedValue([unregistered('real-cugan'), unregistered('waifu2x'), unregistered('real-esrgan')])
    render(<EngineSettings />)
    const row = await screen.findByRole('listitem', { name: 'Real-CUGAN' })

    fireEvent.click(within(row).getByRole('button', { name: '登録を解除' }))
    const dialog = screen.getByRole('dialog', { name: 'エンジンの登録を解除しますか' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }))
    expect(tauri.clear).not.toHaveBeenCalled()

    fireEvent.click(within(row).getByRole('button', { name: '登録を解除' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '解除する' }))
    await vi.waitFor(() => expect(tauri.clear).toHaveBeenCalledWith('real-cugan'))
    expect(await within(engineRow('Real-CUGAN')).findByText('未登録')).toBeTruthy()
  })

  it('PC 内のエンジンを探し、見つかった候補をそのフォルダで登録する', async () => {
    tauri.candidates = [
      {
        id: 'real-esrgan',
        label: 'Real-ESRGAN',
        directoryPath: 'C:\\Tools\\realesrgan',
        executablePath: 'C:\\Tools\\realesrgan\\realesrgan-ncnn-vulkan.exe',
        modelPath: 'C:\\Tools\\realesrgan\\models',
        source: 'detected',
      },
    ]
    tauri.register.mockResolvedValue(registered('real-esrgan', { source: '外部フォルダ' }))
    render(<EngineSettings />)
    await screen.findByRole('listitem', { name: 'Real-ESRGAN' })

    fireEvent.click(screen.getByRole('button', { name: 'PC 内のエンジンを探す' }))
    expect(await screen.findByText('1 件のエンジンが見つかりました。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '登録する' }))
    await vi.waitFor(() => expect(tauri.register).toHaveBeenCalledWith('real-esrgan', 'C:\\Tools\\realesrgan'))
    const row = engineRow('Real-ESRGAN')
    expect(await within(row).findByText('使えます')).toBeTruthy()
    expect(within(row).getByText('既存のフォルダ')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '登録する' })).toBeNull()
  })
})

describe('導入の文言', () => {
  it('ZIP の中身が足りないときは、操作に合った次の手を出す', () => {
    const cause = 'waifu2x の実行ファイルが見つかりません。'
    expect(describeEngineFailure('archive', cause).next).toContain('Windows 向けの配布物')
    expect(describeEngineFailure('directory', cause).next).toContain('フォルダを選んでください')
  })

  it('動作確認の失敗は、文言に「タイムアウト」「空」を含んでも GPU の案内にする', () => {
    for (const cause of ['AI エンジンのヘルスチェックがタイムアウトしました。', 'AI エンジンのヘルスチェック出力が空でした。']) {
      for (const operation of ['release', 'archive', 'directory', 'status'] as const) {
        expect(describeEngineFailure(operation, cause).next).toContain('GPU のドライバーを更新')
      }
    }
  })

  it('通信の失敗の案内は取得の操作にだけ出す', () => {
    expect(describeEngineFailure('release', 'HTTP 503').next).toContain('インターネットへの接続')
    expect(describeEngineFailure('directory', 'フォルダを登録できませんでした: 時間切れ').next).not.toContain('インターネット')
  })

  it('モデルが足りないときは、エンジンが探すフォルダの名前を示す', () => {
    const cugan = describeEngineFailure('archive', 'Real-CUGAN のモデルフォルダが見つかりません。', 'real-cugan').next
    expect(cugan).toContain('models-se')
    expect(cugan).not.toMatch(/と models フォルダ/)
    expect(describeEngineFailure('directory', 'waifu2x のモデルフォルダが見つかりません。', 'waifu2x').next).toContain('models-cunet')
    expect(describeEngineFailure('directory', 'Real-ESRGAN のモデルファイルが見つかりません。', 'real-esrgan').next).toContain('models フォルダ')
  })

  it('大きさの分からない段階は進捗線を不定にする', () => {
    expect(installProgressView({ engineId: 'waifu2x', stage: 'verifying', done: 0, total: 0 }).value).toBeNull()
    expect(installProgressView({ engineId: 'waifu2x', stage: 'downloading', done: 0, total: 0 }).value).toBeNull()
    expect(installProgressView({ engineId: 'waifu2x', stage: 'extracting', done: 60, total: 120 }).value).toBe(0.5)
  })
})
