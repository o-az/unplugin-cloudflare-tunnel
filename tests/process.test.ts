import { describe, expect, it, vi } from 'vitest'

import { createKillCloudflared } from '../src/index.ts'

function createFakeChild(options?: {
  pid?: number
  initialKilled?: boolean
  onKill?: (signal?: NodeJS.Signals) => boolean
}) {
  let exitListener: (() => void) | undefined
  const kill = vi.fn<(signal?: NodeJS.Signals) => boolean>(
    (signal?: NodeJS.Signals) => options?.onKill?.(signal) ?? true
  )

  return {
    pid: options?.pid ?? 1234,
    killed: options?.initialKilled ?? false,
    once(event: 'exit', listener: () => void) {
      if (event === 'exit') exitListener = listener
    },
    kill,
    emitExit() {
      exitListener?.()
    }
  }
}

describe('process cleanup', () => {
  it('resolves when the child is already gone and kill returns false', async () => {
    const child = createFakeChild({ onKill: () => false })
    const clearTunnelUrl = vi.fn<() => void>()
    const markShuttingDown = vi.fn<() => void>()

    const killCloudflared = createKillCloudflared({
      getChild: () => child,
      clearTunnelUrl,
      markShuttingDown,
      platform: 'linux'
    })

    await expect(killCloudflared('SIGTERM')).resolves.toBeUndefined()
    expect(clearTunnelUrl).toHaveBeenCalledTimes(1)
    expect(markShuttingDown).toHaveBeenCalledTimes(1)
  })

  it('escalates from SIGTERM to SIGKILL when the process does not exit', async () => {
    vi.useFakeTimers()

    const child = createFakeChild({
      onKill: vi.fn<(signal?: NodeJS.Signals) => boolean>(
        signal => signal === 'SIGTERM' || signal === 'SIGKILL'
      )
    })
    const clearTunnelUrl = vi.fn<() => void>()
    const markShuttingDown = vi.fn<() => void>()

    const killCloudflared = createKillCloudflared({
      getChild: () => child,
      clearTunnelUrl,
      markShuttingDown,
      platform: 'linux',
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout
    })

    const pending = killCloudflared('SIGTERM')
    vi.advanceTimersByTime(2000)
    child.emitExit()
    await expect(pending).resolves.toBeUndefined()

    const onKill = child.kill as ReturnType<typeof vi.fn>
    expect(onKill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(onKill).toHaveBeenNthCalledWith(2, 'SIGKILL')

    vi.useRealTimers()
  })
})
