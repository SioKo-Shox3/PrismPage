import { describe, expect, it, vi } from 'vitest'

import { watchOpenRequests } from '@/app/open-requests'

// 待ち受けと取り出しを差し替えられる偽物。`pending` は Rust 側に積まれた場所を表す。
function fakePorts(initial: string | null) {
  let pending = initial
  let handler: (() => void) | undefined
  let resolveListen: ((stop: () => void) => void) | undefined
  const stop = vi.fn()
  const opened: string[] = []
  const take = vi.fn(async () => {
    const path = pending
    pending = null
    return path
  })
  const ports = {
    listen: (next: () => void) =>
      new Promise<() => void>((resolve) => {
        handler = next
        resolveListen = resolve
      }),
    take,
    openPath: (path: string) => opened.push(path),
  }
  return {
    ports,
    take,
    stop,
    opened,
    push(path: string) {
      pending = path
      handler?.()
    },
    listenReady() {
      resolveListen?.(stop)
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('外から要求された場所の受け取り', () => {
  it('待ち受けの前に積まれた要求を、待ち受けを張ってから取り出して開く', async () => {
    const fake = fakePorts('C:/本/巻1.cbz')
    watchOpenRequests(fake.ports)
    await settle()
    // 待ち受けが張られるまでは取り出さない(取り出した後の通知を逃さないため)。
    expect(fake.take).not.toHaveBeenCalled()

    fake.listenReady()
    await settle()
    expect(fake.opened).toEqual(['C:/本/巻1.cbz'])
  })

  it('待ち受けの後の要求は通知のたびに取り出して開き、空なら何もしない', async () => {
    const fake = fakePorts(null)
    watchOpenRequests(fake.ports)
    fake.listenReady()
    await settle()
    expect(fake.opened).toEqual([])

    fake.push('C:/本/巻2')
    await settle()
    fake.push('C:/本/巻3.epub')
    await settle()
    expect(fake.opened).toEqual(['C:/本/巻2', 'C:/本/巻3.epub'])
  })

  it('待ち受けが張られる前にやめたら、張られた待ち受けをすぐ外して取り出さない', async () => {
    const fake = fakePorts('C:/本/巻1.cbz')
    const dispose = watchOpenRequests(fake.ports)
    dispose()
    fake.listenReady()
    await settle()
    expect(fake.stop).toHaveBeenCalledOnce()
    expect(fake.take).not.toHaveBeenCalled()
    expect(fake.opened).toEqual([])
  })
})
