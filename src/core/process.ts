import * as NodeChildProcess from 'node:child_process'

export type ManagedChildProcess = {
  pid?: number
  killed?: boolean
  once(event: 'exit', listener: () => void): void
  kill(signal?: NodeJS.Signals): boolean
}

export function createKillCloudflared(params: {
  getChild: () => ManagedChildProcess | undefined
  clearTunnelUrl: () => void
  markShuttingDown: () => void
  debugLog?: (...args: Array<any>) => void
  platform?: NodeJS.Platform
  exec?: typeof NodeChildProcess.exec
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}) {
  const {
    getChild,
    clearTunnelUrl,
    markShuttingDown,
    debugLog = () => {},
    platform = process.platform,
    exec = NodeChildProcess.exec,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout
  } = params

  return (signal: NodeJS.Signals = 'SIGTERM') => {
    const child = getChild()
    if (!child || child.killed) return Promise.resolve()

    markShuttingDown()
    clearTunnelUrl()

    const activeChild = child

    return new Promise<void>(resolve => {
      let settled = false
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined

      const settle = () => {
        if (settled) return
        settled = true
        if (forceKillTimer) clearTimeoutFn(forceKillTimer)
        resolve()
      }

      activeChild.once('exit', () => {
        settle()
      })

      try {
        debugLog(
          `[unplugin-cloudflare-tunnel] Terminating cloudflared process (PID: ${activeChild.pid}) with ${signal}...`
        )
        const killed = activeChild.kill(signal)

        if (!killed) {
          if (platform === 'win32') {
            exec(`taskkill /pid ${activeChild.pid} /T /F`, () => settle())
          } else {
            settle()
          }
          return
        }

        if (signal === 'SIGTERM') {
          forceKillTimer = setTimeoutFn(() => {
            if (settled) return

            debugLog('[unplugin-cloudflare-tunnel] Force killing cloudflared process...')
            if (platform === 'win32') {
              exec(`taskkill /pid ${activeChild.pid} /T /F`, () => settle())
            } else {
              try {
                const forceKilled = activeChild.kill('SIGKILL')
                if (!forceKilled) settle()
              } catch {
                settle()
              }
            }
          }, 2000)
        }
      } catch (error) {
        debugLog(
          `[unplugin-cloudflare-tunnel] Note: Error killing cloudflared: ${error instanceof Error ? error.message : String(error)}`
        )
        settle()
      }
    })
  }
}
