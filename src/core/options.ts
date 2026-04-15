export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

/**
 * Base configuration options shared between named and quick tunnel modes
 */
export interface BaseTunnelOptions {
  /**
   * Tunnel mode.
   * - `quick`: temporary `trycloudflare.com` URL, no hostname required
   * - `named`: persistent tunnel using your configured hostname
   *
   * When omitted, the plugin uses named mode if `hostname` is provided,
   * otherwise it uses quick mode.
   */
  mode?: 'quick' | 'named'

  /**
   * Local port your dev server listens on.
   * If not specified, the plugin tries to detect it from the bundler.
   */
  port?: number

  /**
   * Path to write cloudflared logs to a file.
   */
  logFile?: string

  /**
   * Log level for cloudflared output shown by the plugin.
   */
  logLevel?: LogLevel

  /**
   * Transport protocol used by cloudflared.
   * @default 'http2'
   */
  protocol?: 'http2' | 'quic'

  /**
   * Enable extra plugin debug logging.
   * @default false
   */
  debug?: boolean

  /**
   * Disable the plugin entirely.
   * @default true
   */
  enabled?: boolean
}

/**
 * Configuration options for named tunnel mode (requires hostname and API token)
 */
export interface NamedTunnelOptions extends BaseTunnelOptions {
  hostname: string
  apiToken?: string
  accountId?: string
  zoneId?: string
  tunnelName?: string
  dns?: string
  ssl?: string
  cleanup?: {
    autoCleanup?: boolean
    preserveTunnels?: Array<string>
  }
}

/**
 * Configuration options for quick tunnel mode (no hostname required)
 */
export interface QuickTunnelOptions extends BaseTunnelOptions {}

export type CloudflareTunnelOptions = NamedTunnelOptions | QuickTunnelOptions
