import { create } from 'zustand'

import { listenEngineInstallProgress } from '@/lib/tauri'
import type { EngineCandidate, EngineId, EngineInstallProgress, EngineStatus } from '@/types/app'

import { describeEngineFailure, type EngineFailure, type EngineOperation } from './engine-install'

// 設定画面の「AI エンジン」の操作の状態。導入は画面を離れても続くので、実行中の操作・進み具合・結果を
// 画面の外に持ち、戻った画面へそのまま引き継ぐ。

// 実行中の操作。導入・登録は登録簿を 1 本の排他で書くので、同時には 1 つだけ走らせる。
export interface EngineBusy {
  operation: EngineOperation
  engineId: EngineId | null
}

// 失敗の置き場所。エンジンの行に出すものと、一覧の上に出すもの(`'all'`)がある。
export type FailureSlot = EngineId | 'all'

// 操作が返す結果。一覧ごと置き換えるか、1 つのエンジンの状態だけ差し替える。
export interface EngineOperationResult {
  statuses?: EngineStatus[]
  status?: EngineStatus
  notice: string
}

interface EngineOperationState {
  statuses: EngineStatus[] | null
  // 操作の結果で状態が変わるたびに増える。画面が「状態が変わった」を知らせるのに使う。
  statusesRevision: number
  busy: EngineBusy | null
  progress: EngineInstallProgress | null
  failures: ReadonlyMap<FailureSlot, EngineFailure>
  notice: string | null
  candidates: EngineCandidate[] | null
}

const initialState: EngineOperationState = {
  statuses: null,
  statusesRevision: 0,
  busy: null,
  progress: null,
  failures: new Map(),
  notice: null,
  candidates: null,
}

export const useEngineOperations = create<EngineOperationState>(() => initialState)

// テスト用。状態を最初の形へ戻す。
export function resetEngineOperations() {
  useEngineOperations.setState(initialState, true)
}

function messageOf(error: unknown) {
  return error instanceof Error && error.message ? error.message : String(error)
}

export function setEngineFailure(slot: FailureSlot, failure: EngineFailure | null) {
  useEngineOperations.setState(({ failures }) => {
    if (!failure && !failures.has(slot)) return {}
    const next = new Map(failures)
    if (failure) next.set(slot, failure)
    else next.delete(slot)
    return { failures: next }
  })
}

export function setEngineProgress(progress: EngineInstallProgress | null) {
  useEngineOperations.setState({ progress })
}

export function setEngineCandidates(update: (current: EngineCandidate[] | null) => EngineCandidate[] | null) {
  useEngineOperations.setState(({ candidates }) => ({ candidates: update(candidates) }))
}

// 画面を開いたときの状態の読み込み。操作が走っている間や、読み込み中に操作の結果が届いたときは、
// 操作の結果のほうを残す。
export async function loadEngineStatuses(fetch: () => Promise<EngineStatus[]>) {
  const { busy, statusesRevision } = useEngineOperations.getState()
  if (busy) return
  try {
    const statuses = await fetch()
    const current = useEngineOperations.getState()
    if (current.busy || current.statusesRevision !== statusesRevision) return
    useEngineOperations.setState({ statuses })
  } catch (error) {
    const current = useEngineOperations.getState()
    if (current.busy || current.statusesRevision !== statusesRevision) return
    useEngineOperations.setState({
      statuses: current.statuses ?? [],
      failures: new Map([['all', describeEngineFailure('status', messageOf(error))]]),
    })
  }
}

// 操作を 1 つ走らせる。進み具合のイベントは操作の間だけ、その操作のエンジンのものを受ける。
// 成功したら状態を置き換えて知らせを出し、失敗したら原因と次の手を出す。`action` が null を返したら何もしない
// (ファイル選択を閉じたときなど)。
export async function runEngineOperation(
  operation: EngineOperation,
  engineId: EngineId | null,
  action: () => Promise<EngineOperationResult | null>,
) {
  if (useEngineOperations.getState().busy) return
  const slot: FailureSlot = engineId ?? 'all'
  useEngineOperations.setState({ busy: { operation, engineId }, progress: null, notice: null })
  setEngineFailure(slot, null)
  let unlisten: (() => void) | null = null
  try {
    if (engineId) {
      unlisten = await listenEngineInstallProgress((event) => {
        if (event.engineId === useEngineOperations.getState().busy?.engineId) setEngineProgress(event)
      }).catch(() => null)
    }
    const result = await action()
    if (!result) return
    useEngineOperations.setState(({ statuses, statusesRevision }) => {
      let next = statuses
      if (result.statuses) {
        next = result.statuses
      } else if (result.status) {
        const status = result.status
        const current = statuses ?? []
        next = current.some((entry) => entry.id === status.id)
          ? current.map((entry) => (entry.id === status.id ? status : entry))
          : [...current, status]
      }
      return next === statuses
        ? { notice: result.notice }
        : { statuses: next, statusesRevision: statusesRevision + 1, notice: result.notice }
    })
  } catch (error) {
    setEngineFailure(slot, describeEngineFailure(operation, messageOf(error), engineId))
  } finally {
    unlisten?.()
    useEngineOperations.setState({ busy: null, progress: null })
  }
}
