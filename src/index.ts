/**
 * @fileoverview Cloudflare Tunnel Unplugin
 *
 * A cross-bundler plugin that automatically creates and manages
 * Cloudflare tunnels for local development, providing instant HTTPS access
 * to your local dev server from anywhere on the internet.
 *
 * @author Cloudflare Tunnel Plugin Contributors
 * @version 1.0.0
 * @license MIT
 */

import { createUnplugin, type UnpluginFactory, type UnpluginInstance } from 'unplugin'
import * as z from 'zod/mini'
import NodeFS from 'node:fs/promises'
import * as NodeUtil from 'node:util'
import * as NodeModule from 'node:module'
import { bin, install } from 'cloudflared'
import type * as NodeHTTP from 'node:http'
import type * as NodeHTTPS from 'node:https'
import type * as NodeHTTP2 from 'node:http2'
import * as NodeChildProcess from 'node:child_process'
import type { Compiler as WebpackCompiler } from 'webpack'
import type { Compiler as RspackCompiler } from '@rspack/core'

const PLUGIN_NAME = 'unplugin-cloudflare-tunnel'

const INFO_LOG_REGEX = /^.*Z INF .*/

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50
}

function shouldLog(threshold: LogLevel, level: LogLevel) {
  return LOG_LEVEL_RANK[level] >= LOG_LEVEL_RANK[threshold]
}

function supportsColor() {
  if (!process.stdout.isTTY) return false
  if (process.env.NO_COLOR !== undefined) return false
  if (process.env.TERM === 'dumb') return false
  if (process.env.FORCE_COLOR === '0') return false
  return true
}

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m'
} as const

const ANSI_ESCAPE = String.fromCharCode(27)
const ANSI_STYLE_SEQUENCE_REGEX = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, 'g')

function stripAnsi(text: string) {
  return text.replace(ANSI_STYLE_SEQUENCE_REGEX, '')
}

function colorize(text: string, ansi: string) {
  if (!supportsColor()) return text
  return `${ansi}${text}${ANSI.reset}`
}

// Zod schemas for Cloudflare API responses
const CloudflareErrorSchema = z.object({
  code: z.number(),
  message: z.string()
})

const CloudflareApiResponseSchema = z.object({
  success: z.boolean(),
  errors: z.optional(z.array(CloudflareErrorSchema)),
  messages: z.optional(z.array(z.string())),
  result: z.unknown()
})

const AccountSchema = z.object({
  id: z.string(),
  name: z.string()
})

const ZoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  account: z.optional(
    z.object({
      id: z.string()
    })
  )
})

const TunnelSchema = z.object({
  id: z.string(),
  name: z.string(),
  account_tag: z.string(),
  created_at: z.string(),
  connections: z.optional(z.array(z.unknown()))
})

const DNSRecordSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  content: z.string(),
  proxied: z.boolean(),
  comment: z.nullish(z.string())
})

// Type definitions (exported for potential external use)
export type CloudflareApiResponse<T = unknown> = z.infer<typeof CloudflareApiResponseSchema> & {
  result: T
}
export type Account = z.infer<typeof AccountSchema>
export type Zone = z.infer<typeof ZoneSchema>
export type Tunnel = z.infer<typeof TunnelSchema>
export type DNSRecord = z.infer<typeof DNSRecordSchema>

/**
 * Base configuration options shared between named and quick tunnel modes
 */
interface BaseTunnelOptions {
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
   * Local port your dev server listens on
   * If not specified, will automatically use the bundler's configured port
   * @default undefined (auto-detect from bundler config)
   */
  port?: number

  /**
   * Path to write cloudflared logs to a file
   * Useful for debugging tunnel issues
   */
  logFile?: string

  /**
   * Log level for cloudflared output shown by the plugin.
   * The plugin still runs cloudflared with at least `info` internally so it can
   * detect tunnel readiness and print the tunnel URL.
   * @default undefined
   */
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'fatal'

  /**
   * Transport protocol used by cloudflared.
   * `http2` is the default because it is more reliable for local development
   * networks than QUIC.
   * @default 'http2'
   */
  protocol?: 'http2' | 'quic'

  /**
   * Enable additional verbose logging for easier debugging.
   * When true, the plugin will output extra information prefixed with
   * `[cloudflare-tunnel:debug]`.
   * @default false
   */
  debug?: boolean

  /**
   * Enable or disable the tunnel plugin. When set to `false` the plugin is
   * completely disabled — cloudflared will NOT be downloaded or started.
   * @default true
   */
  enabled?: boolean
}

/**
 * Configuration options for named tunnel mode (requires hostname and API token)
 */
interface NamedTunnelOptions extends BaseTunnelOptions {
  /**
   * Public hostname for the tunnel (e.g., "dev.example.com")
   * Must be a domain in your Cloudflare account
   */
  hostname: string

  /**
   * Cloudflare API token with required permissions:
   * - Zone:Zone:Read
   * - Zone:DNS:Edit
   * - Account:Cloudflare Tunnel:Edit
   *
   * Fallback priority:
   * 1. Provided apiToken option
   * 2. CLOUDFLARE_API_TOKEN environment variable
   */
  apiToken?: string

  /**
   * Cloudflare account ID
   * If omitted, uses the first account associated with the API token
   */
  accountId?: string

  /**
   * Cloudflare zone ID
   * If omitted, automatically resolved from the hostname
   */
  zoneId?: string

  /**
   * Name for the tunnel in your Cloudflare dashboard
   * Must contain only letters, numbers, and hyphens. Cannot start or end with a hyphen.
   * @default "dev-tunnel"
   */
  tunnelName?: string

  /**
   * Wildcard DNS domain to ensure exists (e.g., "*.example.com").
   * When provided the plugin will ensure both A and AAAA records exist.
   */
  dns?: string

  /**
   * Wildcard SSL domain to ensure exists (e.g., "*.example.com").
   * When provided the plugin will request/ensure a wildcard edge certificate.
   * If omitted the plugin will attempt to detect an existing wildcard certificate
   * or Total TLS; otherwise it will request a regular certificate for the provided hostname.
   */
  ssl?: string

  /**
   * Cleanup configuration for managing orphaned resources
   */
  cleanup?: {
    /**
     * Whether to automatically clean up orphaned DNS records on startup
     * @default true
     */
    autoCleanup?: boolean

    /**
     * Array of tunnel names to preserve during cleanup (in addition to current tunnel)
     * @default []
     */
    preserveTunnels?: Array<string>
  }
}

/**
 * Configuration options for quick tunnel mode (no hostname required, generates random URL)
 */
interface QuickTunnelOptions extends BaseTunnelOptions {
  // No additional options beyond base options
}

/**
 * Configuration options for the Cloudflare Tunnel plugin
 *
 * Two modes are supported:
 * - Named tunnel mode: set `mode: 'named'` or provide `hostname`
 * - Quick tunnel mode: set `mode: 'quick'` or omit `hostname`
 */
export type CloudflareTunnelOptions = NamedTunnelOptions | QuickTunnelOptions

const unpluginFactory: UnpluginFactory<CloudflareTunnelOptions | undefined> = (
  options: CloudflareTunnelOptions = {}
) => {
  // ---------------------------------------------------------------------
  // Early exit when plugin is explicitly disabled via the `enabled` option.
  // We still provide the virtual module so application code can import it
  // safely, however it will always return an empty string.
  // ---------------------------------------------------------------------
  const { enabled = true } = options as { enabled?: boolean }
  if (enabled === false) {
    const VIRTUAL_MODULE_ID_STUB = 'virtual:unplugin-cloudflare-tunnel'
    return {
      name: PLUGIN_NAME,
      enforce: 'pre' as const,

      resolveId(id) {
        if (id === VIRTUAL_MODULE_ID_STUB) {
          return id
        }
      },

      loadInclude(id) {
        return id === VIRTUAL_MODULE_ID_STUB
      },

      load(id) {
        if (id === VIRTUAL_MODULE_ID_STUB) {
          return 'export function getTunnelUrl() { return ""; }'
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Global state management for tunnel process across HMR restarts
  // ---------------------------------------------------------------------
  const GLOBAL_STATE = Symbol.for('unplugin-cloudflare-tunnel.state')

  type GlobalState = {
    child?: ReturnType<typeof NodeChildProcess.spawn>
    exitHandlersRegistered?: boolean
    configHash?: string
    shuttingDown?: boolean
    tunnelUrl: Promise<string> | undefined
    // Allow dynamic keys for SSL certificate tracking
    [key: string]: any
  }

  const globalState: GlobalState = (globalThis as any)[GLOBAL_STATE] ?? {}
  ;(globalThis as any)[GLOBAL_STATE] = globalState

  // Local reference, kept in sync with the global state
  let child: ReturnType<typeof NodeChildProcess.spawn> | undefined = globalState.child

  // ---------------------------------------------------------------------
  // Virtual module to expose the tunnel URL at dev time
  // ---------------------------------------------------------------------
  const VIRTUAL_MODULE_ID = 'virtual:unplugin-cloudflare-tunnel'

  // ---------------------------------------------------------------------
  // Extract and validate options
  // ---------------------------------------------------------------------
  const requestedMode = options.mode

  if (requestedMode && !['quick', 'named'].includes(requestedMode)) {
    throw new Error("[unplugin-cloudflare-tunnel] mode must be one of: 'quick', 'named'")
  }

  const hasHostname = 'hostname' in options && typeof options.hostname === 'string'
  const isQuickMode = requestedMode ? requestedMode === 'quick' : !hasHostname

  if (requestedMode === 'named' && !hasHostname) {
    throw new Error('[unplugin-cloudflare-tunnel] hostname is required when mode is set to named')
  }

  // Validate that quick mode options don't include named-mode-only options
  if (isQuickMode) {
    const namedModeOptions = [
      'apiToken',
      'accountId',
      'zoneId',
      'tunnelName',
      'dns',
      'ssl',
      'cleanup'
    ]
    const invalidOptions = namedModeOptions.filter(opt => opt in options)
    if (invalidOptions.length > 0) {
      throw new Error(
        `[unplugin-cloudflare-tunnel] The following options are only supported in named tunnel mode: ${invalidOptions.join(', ')}. ` +
          `Set mode to 'named' and provide a hostname, or remove these options for quick tunnel mode.`
      )
    }
  }

  // Extract options based on mode
  let providedApiToken: string | undefined
  let hostname: string | undefined
  let tunnelName: string
  let forcedAccount: string | undefined
  let forcedZone: string | undefined
  let dnsOption: string | undefined
  let sslOption: string | undefined
  let cleanupConfig: any

  if (isQuickMode) {
    tunnelName = 'quick-tunnel'
    cleanupConfig = {}
  } else {
    const namedOptions = options as NamedTunnelOptions
    providedApiToken = namedOptions.apiToken
    hostname = namedOptions.hostname
    forcedAccount = namedOptions.accountId
    forcedZone = namedOptions.zoneId
    tunnelName = namedOptions.tunnelName || 'dev-tunnel'
    dnsOption = namedOptions.dns
    sslOption = namedOptions.ssl
    cleanupConfig = namedOptions.cleanup || {}
  }

  // Extract common options
  const { port: userProvidedPort, logFile, logLevel, protocol = 'http2', debug = false } = options

  const effectivePluginLogLevel: LogLevel = (logLevel as LogLevel) ?? (debug ? 'debug' : 'info')

  const redactForDebug = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (value.startsWith('eyJ') && value.length > 40) {
        return '[REDACTED_TOKEN]'
      }
      return value
    }

    if (Array.isArray(value)) {
      return value.map(item => redactForDebug(item))
    }

    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => {
        if (/token|authorization|secret|password/i.test(key)) {
          return [key, '[REDACTED]']
        }
        return [key, redactForDebug(nestedValue)]
      })
      return Object.fromEntries(entries)
    }

    return value
  }

  const formatDebugValue = (value: unknown) => {
    const redactedValue = redactForDebug(value)
    if (typeof redactedValue === 'string') return redactedValue
    return NodeUtil.inspect(redactedValue, {
      depth: null,
      colors: supportsColor(),
      compact: false,
      breakLength: 120,
      sorted: true
    })
  }

  const pluginLog = {
    debug: (...args: unknown[]) => {
      if (debug || effectivePluginLogLevel === 'debug') {
        console.log('[cloudflare-tunnel:debug]', ...args.map(arg => formatDebugValue(arg)))
      }
    },
    info: (message: string) => {
      if (shouldLog(effectivePluginLogLevel, 'info')) {
        console.log(`[unplugin-cloudflare-tunnel] ${message}`)
      }
    },
    warn: (message: string) => {
      if (shouldLog(effectivePluginLogLevel, 'warn')) {
        console.warn(`[unplugin-cloudflare-tunnel] ${message}`)
      }
    },
    error: (message: string) => {
      if (shouldLog(effectivePluginLogLevel, 'error')) {
        console.error(`[unplugin-cloudflare-tunnel] ${message}`)
      }
    }
  }

  const debugLog = pluginLog.debug

  const makeLocalDisplay = (localTarget: string) => {
    if (!localTarget) return localTarget
    return localTarget
      .replace('http://[::1]:', 'http://localhost:')
      .replace('http://127.0.0.1:', 'http://localhost:')
  }

  const announceConnecting = () => {
    if (globalState.__tunnelConnectingAnnounced) return
    globalState.__tunnelConnectingAnnounced = true

    const message = isQuickMode
      ? 'cf tunnel connecting…'
      : hostname
        ? `cf tunnel connecting… (${hostname})`
        : 'cf tunnel connecting…'

    console.log('')
    console.log(colorize(message, ANSI.bold))
  }

  const announceTunnel = (params: { key: string; url: string; localTarget?: string }) => {
    if (!params.url) return
    if (globalState.__lastAnnouncedTunnelKey === params.key) return
    globalState.__lastAnnouncedTunnelKey = params.key

    const cols = process.stdout.columns ?? 80
    const maxWidth = Math.max(10, cols - 2)
    const headerText = 'unplugin-cloudflare-tunnel'
    const header = (() => {
      const left = colorize('[', ANSI.yellow)
      const right = colorize(']', ANSI.yellow)
      return `${left}${headerText}${right}`
    })()

    const urlLine = colorize(params.url, ANSI.blue + ANSI.bold)
    const localLine = params.localTarget ? makeLocalDisplay(params.localTarget) : ''

    const headerPlainLen = stripAnsi(header).length
    const contentPlainLen = Math.max(
      stripAnsi(urlLine).length,
      localLine.length,
      'Tunnel URL'.length,
      'Local'.length
    )
    const width = Math.min(90, maxWidth, Math.max(44, headerPlainLen, contentPlainLen + 4))

    const rule = '─'.repeat(width)

    const center = (text: string) => {
      const plainLen = stripAnsi(text).length
      const pad = Math.max(0, Math.floor((width - plainLen) / 2))
      return `${' '.repeat(pad)}${text}`
    }

    const isNarrow = cols < 70
    if (isNarrow) {
      const out: string[] = []
      out.push('')
      out.push(`${header} ${colorize('Tunnel URL', ANSI.bold)} ${urlLine}`)
      if (localLine) {
        out.push(`${header} ${colorize('Local', ANSI.dim + ANSI.bold)} ${localLine}`)
      }
      out.push('')
      console.log(out.join('\n'))
      return
    }

    const out: string[] = []
    out.push('')
    out.push(center(header))
    out.push(rule)
    out.push(center(colorize('Tunnel URL', ANSI.bold)))
    out.push(center(urlLine))
    if (localLine) {
      out.push('')
      out.push(center(colorize('Local', ANSI.dim + ANSI.bold)))
      out.push(center(localLine))
    }
    out.push(rule)
    out.push('')

    console.log(out.join('\n'))
  }

  // Basic input validation
  if (!isQuickMode && (!hostname || typeof hostname !== 'string')) {
    throw new Error(
      '[unplugin-cloudflare-tunnel] hostname is required and must be a valid string in named tunnel mode'
    )
  }

  let tunnelUrl = hostname ? `https://${hostname}` : ''

  // Validate tunnel name
  if (tunnelName && !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(tunnelName)) {
    throw new Error(
      '[unplugin-cloudflare-tunnel] tunnelName must contain only letters, numbers, and hyphens. ' +
        'It cannot start or end with a hyphen.'
    )
  }

  if (
    userProvidedPort &&
    (typeof userProvidedPort !== 'number' || userProvidedPort < 1 || userProvidedPort > 65535)
  ) {
    throw new Error('[unplugin-cloudflare-tunnel] port must be a valid number between 1 and 65535')
  }

  if (logLevel && !['debug', 'info', 'warn', 'error', 'fatal'].includes(logLevel)) {
    throw new Error(
      '[unplugin-cloudflare-tunnel] logLevel must be one of: debug, info, warn, error, fatal'
    )
  }

  const effectiveLogLevel: 'debug' | 'info' | 'warn' | 'error' | 'fatal' =
    (logLevel as any) ?? (debug ? 'info' : 'warn')
  const cloudflaredProcessLogLevel: 'debug' | 'info' =
    effectiveLogLevel === 'debug' ? 'debug' : 'info'
  debugLog('Effective cloudflared log level filter:', effectiveLogLevel)
  debugLog('Effective cloudflared process log level:', cloudflaredProcessLogLevel)
  debugLog('Effective cloudflared protocol:', protocol)

  if (dnsOption) {
    const isDnsWildcard = dnsOption.startsWith('*.')
    if (!isDnsWildcard && dnsOption !== hostname) {
      throw new Error(
        "[unplugin-cloudflare-tunnel] dns option must either be a wildcard (e.g., '*.example.com') or exactly match the hostname"
      )
    }
  }

  if (sslOption) {
    const isSslWildcard = sslOption.startsWith('*.')
    if (!isSslWildcard && sslOption !== hostname) {
      throw new Error(
        "[unplugin-cloudflare-tunnel] ssl option must either be a wildcard (e.g., '*.example.com') or exactly match the hostname"
      )
    }
  }

  if (!['http2', 'quic'].includes(protocol)) {
    throw new Error("[unplugin-cloudflare-tunnel] protocol must be one of: 'http2', 'quic'")
  }

  // ---------------------------------------------------------------------
  // Helper functions (Cloudflare API, SSL tracking, DNS cleanup, etc.)
  // ---------------------------------------------------------------------

  const trackSslCertificate = (
    certificateId: string,
    hosts: string[],
    tunnelName: string,
    timestamp: string = new Date().toISOString()
  ) => {
    const trackingKey = `ssl-cert-${certificateId}`
    globalState[trackingKey] = {
      id: certificateId,
      hosts,
      tunnelName,
      timestamp,
      pluginVersion: '1.0.0'
    }
    debugLog(`Tracking SSL certificate: ${certificateId} for hosts: ${hosts.join(', ')}`)
  }

  const findMismatchedSslCertificates = async (
    apiToken: string,
    zoneId: string,
    currentTunnelName: string,
    currentHostname: string
  ): Promise<Array<any>> => {
    try {
      const certPacks: any = await cf(
        apiToken,
        'GET',
        `/zones/${zoneId}/ssl/certificate_packs?status=all`,
        undefined,
        z.any()
      )
      const allCerts: Array<any> = Array.isArray(certPacks) ? certPacks : certPacks.result || []

      const currentTunnelCerts = allCerts.filter(cert => {
        const certHosts = cert.hostnames || cert.hosts || []
        return certHosts.some((host: string) =>
          host.startsWith(`cf-tunnel-plugin-${currentTunnelName}--`)
        )
      })

      debugLog(
        `Found ${currentTunnelCerts.length} SSL certificates for current tunnel: ${currentTunnelName}`
      )

      const mismatchedCerts = currentTunnelCerts.filter(cert => {
        const certHosts = cert.hostnames || cert.hosts || []
        const coversCurrentHostname = certHosts.some((host: string) => {
          if (host.startsWith('cf-tunnel-plugin-')) return false
          return (
            host === currentHostname ||
            (host.startsWith('*.') && currentHostname.endsWith(host.slice(1)))
          )
        })
        return !coversCurrentHostname
      })

      debugLog(
        `Found ${mismatchedCerts.length} mismatched SSL certificates`,
        mismatchedCerts.map(c => ({
          id: c.id,
          hosts: c.hostnames || c.hosts,
          currentHostname
        }))
      )

      return mismatchedCerts
    } catch (error) {
      console.error(
        `[unplugin-cloudflare-tunnel] ❌ SSL certificate listing failed: ${(error as Error).message}`
      )
      return []
    }
  }

  const cleanupMismatchedDnsRecords = async (
    apiToken: string,
    zoneId: string,
    dnsComment: string,
    currentHostname: string,
    tunnelId: string
  ): Promise<{ found: Array<DNSRecord>; deleted: Array<DNSRecord> }> => {
    try {
      const pluginDnsRecords = await cf(
        apiToken,
        'GET',
        `/zones/${zoneId}/dns_records?comment=${dnsComment}&match=all`,
        undefined,
        z.array(DNSRecordSchema)
      )

      debugLog(`Found ${pluginDnsRecords.length} DNS records for current tunnel: ${dnsComment}`)

      const expectedCnameContent = `${tunnelId}.cfargotunnel.com`
      const mismatchedRecords = pluginDnsRecords.filter(record => {
        if (record.name === currentHostname && record.content === expectedCnameContent) {
          return false
        }

        if (dnsOption && record.name === dnsOption && record.content === expectedCnameContent) {
          return false
        }

        return true
      })

      debugLog(
        `Found ${mismatchedRecords.length} mismatched DNS records`,
        mismatchedRecords.map(r => ({
          name: r.name,
          content: r.content,
          expected: expectedCnameContent,
          comment: r.comment
        }))
      )

      const deletedRecords: DNSRecord[] = []

      if (mismatchedRecords.length > 0) {
        console.log(
          `[unplugin-cloudflare-tunnel] 🧹 Cleaning up ${mismatchedRecords.length} mismatched DNS records from tunnel '${dnsComment}'...`
        )

        for (const record of mismatchedRecords) {
          try {
            await cf(apiToken, 'DELETE', `/zones/${zoneId}/dns_records/${record.id}`)
            deletedRecords.push(record)
            console.log(
              `[unplugin-cloudflare-tunnel] ✅ Deleted mismatched DNS record: ${record.name} → ${record.content}`
            )
          } catch (error) {
            console.error(
              `[unplugin-cloudflare-tunnel] ❌ Failed to delete DNS record ${record.name}: ${(error as Error).message}`
            )
          }
        }
      }

      return {
        found: mismatchedRecords,
        deleted: deletedRecords
      }
    } catch (error) {
      console.error(
        `[unplugin-cloudflare-tunnel] ❌ DNS cleanup failed: ${(error as Error).message}`
      )
      return { found: [], deleted: [] }
    }
  }

  const cf = async <T>(
    apiToken: string,
    method: string,
    url: string,
    body?: unknown,
    resultSchema?: z.ZodMiniType<T>
  ): Promise<T> => {
    try {
      debugLog('→ CF API', method, url, body ? { body } : '')

      const response = await fetch(`https://api.cloudflare.com/client/v4${url}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'unplugin-cloudflare-tunnel/1.0.0'
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error')
        throw new Error(
          `[unplugin-cloudflare-tunnel] API request failed: ${response.status} ${response.statusText}. Response: ${errorText}`
        )
      }

      const rawData = await response.json()
      debugLog('← CF API response', rawData)
      const apiResponse = CloudflareApiResponseSchema.parse(rawData)

      if (!apiResponse.success) {
        const errorMsg =
          apiResponse.errors?.map(e => e.message || `Error ${e.code}`).join(', ') ||
          'Unknown API error'
        throw new Error(`[unplugin-cloudflare-tunnel] Cloudflare API error: ${errorMsg}`)
      }

      if (resultSchema) {
        const parsed = resultSchema.parse(apiResponse.result)
        debugLog('← Parsed result', parsed)
        return parsed
      }

      debugLog('← Result (untyped)', apiResponse.result)
      return apiResponse.result as T
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('[unplugin-cloudflare-tunnel]')) throw error

        throw new Error(`[unplugin-cloudflare-tunnel] API request failed: ${error.message}`)
      }
      throw new Error('[unplugin-cloudflare-tunnel] Unknown API error occurred')
    }
  }

  const retryWithBackoff = async <T>(
    fn: () => Promise<T>,
    maxRetries = 5,
    initialDelayMs = 1000
  ): Promise<T> => {
    let attempt = 0
    while (true) {
      try {
        return await fn()
      } catch (error) {
        attempt += 1
        const message = error instanceof Error ? error.message : String(error)
        if (attempt > maxRetries) {
          console.error(
            `[unplugin-cloudflare-tunnel] ❌ Edge certificate request failed after ${maxRetries} retries: ${message}`
          )
          throw error
        }
        const delay = initialDelayMs * 2 ** (attempt - 1)
        console.error(
          `[unplugin-cloudflare-tunnel] ⚠️  Edge certificate request failed (attempt ${attempt}/${maxRetries}): ${message}`
        )
        console.error(`[unplugin-cloudflare-tunnel] ⏳ Retrying in ${delay}ms...`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  const spawnQuickTunnel = async (
    localTarget: string,
    protocol: 'http2' | 'quic'
  ): Promise<{
    child: ReturnType<typeof NodeChildProcess.spawn>
    url: string
  }> => {
    const cloudflaredArgs = ['tunnel']
    cloudflaredArgs.push('--loglevel', 'info')
    if (logFile) {
      cloudflaredArgs.push('--logfile', logFile)
    }
    cloudflaredArgs.push('--protocol', protocol)
    cloudflaredArgs.push('--url', localTarget)

    debugLog('Spawning quick tunnel:', bin, cloudflaredArgs)
    const child = NodeChildProcess.spawn(bin, cloudflaredArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true,
      shell: process.platform === 'win32'
    })

    debugLog(`[unplugin-cloudflare-tunnel] Quick tunnel process spawned with PID: ${child.pid}`)

    return new Promise((resolve, reject) => {
      let urlFound = false
      let settled = false

      const rejectOnce = (error: Error) => {
        if (settled) return
        settled = true
        reject(error)
      }

      const resolveOnce = (result: {
        child: ReturnType<typeof NodeChildProcess.spawn>
        url: string
      }) => {
        if (settled) return
        settled = true
        resolve(result)
      }

      const timeout = setTimeout(() => {
        if (!urlFound) {
          try {
            child.kill('SIGTERM')
          } catch {}
          rejectOnce(new Error('Quick tunnel URL not found in output within 30 seconds'))
        }
      }, 30000)

      child.stdout?.on('data', data => {
        const output = data.toString()
        if (!globalState.shuttingDown || debug) {
          if (effectiveLogLevel === 'debug' || effectiveLogLevel === 'info') {
            console.log(`[cloudflared stdout] ${output.trim()}`)
          } else {
            for (const line of output.split('\n')) {
              if (!INFO_LOG_REGEX.test(line)) console.log(`[cloudflared stdout] ${line.trim()}`)
            }
          }
        }
      })

      child.stderr?.on('data', data => {
        const error = data.toString().trim()

        const urlMatch = error.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/)
        if (urlMatch && !urlFound) {
          urlFound = true
          clearTimeout(timeout)
          resolveOnce({ child, url: urlMatch[0] })
        }

        if (error.includes('Failed to parse ICMP reply') || error.includes('unknow ip version 0')) {
          if (logLevel === 'debug') {
            console.log(`[cloudflared debug] ${error}`)
          }
          return
        }

        if (!globalState.shuttingDown || debug) {
          if (effectiveLogLevel === 'debug' || effectiveLogLevel === 'info') {
            console.error(`[cloudflared stderr] ${error}`)
          } else {
            for (const line of error.split('\n')) {
              if (!INFO_LOG_REGEX.test(line)) console.error(`[cloudflared stderr] ${line.trim()}`)
            }
          }
        }
      })

      child.on('error', error => {
        clearTimeout(timeout)
        rejectOnce(new Error(`Failed to start quick tunnel process: ${error.message}`))
      })

      child.on('exit', (code, signal) => {
        clearTimeout(timeout)
        if (!urlFound) {
          rejectOnce(
            new Error(
              `Quick tunnel process exited before URL was found (code: ${code}, signal: ${signal})`
            )
          )
        }
      })
    })
  }

  const killCloudflared = (signal: NodeJS.Signals = 'SIGTERM') => {
    if (!child || child.killed) return Promise.resolve()

    globalState.shuttingDown = true
    globalState.tunnelUrl = undefined

    const activeChild = child

    return new Promise<void>(resolve => {
      let settled = false
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined

      const settle = () => {
        if (settled) return
        settled = true
        if (forceKillTimer) clearTimeout(forceKillTimer)

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
          if (process.platform === 'win32') {
            NodeChildProcess.exec(`taskkill /pid ${activeChild.pid} /T /F`, () => settle())
          } else {
            settle()
          }
          return
        }

        if (signal === 'SIGTERM') {
          forceKillTimer = setTimeout(() => {
            if (settled) return

            debugLog('[unplugin-cloudflare-tunnel] Force killing cloudflared process...')
            if (process.platform === 'win32') {
              NodeChildProcess.exec(`taskkill /pid ${activeChild.pid} /T /F`, () => settle())
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

  let exitHandlersRegistered = globalState.exitHandlersRegistered ?? false

  const scheduleFatalExit = (code = 1) => {
    process.exitCode = code
    setImmediate(() => {
      process.exit(code)
    })
  }

  const registerExitHandler = () => {
    if (exitHandlersRegistered) return
    exitHandlersRegistered = true
    globalState.exitHandlersRegistered = true

    const cleanup = () => killCloudflared('SIGTERM')

    process.once('exit', cleanup)
    process.once('beforeExit', cleanup)

    ;['SIGINT', 'SIGTERM', 'SIGQUIT', 'SIGHUP'].forEach(signal => {
      process.once(signal as NodeJS.Signals, () => {
        void killCloudflared(signal as NodeJS.Signals)
        try {
          process.kill(process.pid, signal as NodeJS.Signals)
        } catch {
          process.exit(0)
        }
      })
    })

    process.once('uncaughtExceptionMonitor', error => {
      console.error(
        '[unplugin-cloudflare-tunnel] Uncaught exception, cleaning up cloudflared...',
        error
      )
      void killCloudflared('SIGTERM')
    })

    process.once('unhandledRejection', reason => {
      console.error(
        '[unplugin-cloudflare-tunnel] Unhandled rejection, cleaning up cloudflared...',
        reason
      )
      void killCloudflared('SIGTERM').finally(() => {
        scheduleFatalExit(1)
      })
    })
  }

  // ---------------------------------------------------------------------
  // Main server configuration logic (to be called from Vite's configureServer)
  // ---------------------------------------------------------------------
  type NodeServerLike =
    | NodeHTTP.Server
    | NodeHTTPS.Server
    | NodeHTTP2.Http2Server
    | NodeHTTP2.Http2SecureServer

  type CompatibleDevServer = {
    httpServer?: NodeServerLike | null
    config?: {
      server?: {
        port?: number | string
      }
    }
  }

  const configureServer = async (server: CompatibleDevServer) => {
    const generateDnsComment = () => {
      return `unplugin-cloudflare-tunnel:${tunnelName}`
    }

    const registerListeningHandler = (handler: () => Promise<void> | void) => {
      const httpServer = server.httpServer

      const invokeHandler = () => {
        try {
          const maybePromise = handler()
          if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
            ;(maybePromise as Promise<unknown>).catch(error => {
              console.error(
                `[unplugin-cloudflare-tunnel] ❌ Dev server listening hook failed: ${(error as Error).message}`
              )
            })
          }
        } catch (error) {
          console.error(
            `[unplugin-cloudflare-tunnel] ❌ Dev server listening hook failed: ${(error as Error).message}`
          )
        }
      }

      if (!httpServer) {
        invokeHandler()
        return
      }

      httpServer.on('listening', invokeHandler)

      if (httpServer.listening) invokeHandler()
    }

    try {
      const { host: serverHost, port: detectedPort } = normalizeAddress(
        server.httpServer?.address()
      )
      const configPortValue = server.config?.server?.port
      const resolvedConfigPort =
        typeof configPortValue === 'string' ? Number.parseInt(configPortValue, 10) : configPortValue
      const port =
        userProvidedPort ||
        detectedPort ||
        (typeof resolvedConfigPort === 'number' && !Number.isNaN(resolvedConfigPort)
          ? resolvedConfigPort
          : undefined) ||
        5173
      const originRequest = server.httpServer
        ? undefined
        : {
            httpHostHeader: `${serverHost}:${port}`
          }
      const newConfigHash = JSON.stringify({
        isQuickMode,
        hostname,
        port,
        tunnelName,
        dnsOption,
        sslOption,
        originRequest
      })

      if (
        globalState.child &&
        !globalState.child.killed &&
        globalState.configHash === newConfigHash
      ) {
        tunnelUrl = (await globalState.tunnelUrl) ?? ''
        debugLog('[unplugin-cloudflare-tunnel] Config unchanged – re-using existing tunnel')
        globalState.shuttingDown = false
        registerExitHandler()
        return
      }

      if (globalState.child && !globalState.child.killed) {
        debugLog('[unplugin-cloudflare-tunnel] Config changed – terminating previous tunnel...')
        try {
          globalState.child.kill('SIGTERM')
        } catch {}
      }

      delete globalState.child
      delete globalState.configHash
      globalState.shuttingDown = false

      // Handle quick tunnel mode
      if (isQuickMode) {
        debugLog('[unplugin-cloudflare-tunnel] Starting quick tunnel mode...')
        debugLog('Quick tunnel mode - no API token or hostname required')

        await ensureCloudflaredBinary(bin)

        const localTarget = getLocalTarget(serverHost, port)
        debugLog('← Quick tunnel connecting to local target', localTarget)

        try {
          const { child: quickChild, url } = await spawnQuickTunnel(localTarget, protocol)
          tunnelUrl = url
          child = quickChild

          globalState.child = child
          globalState.configHash = newConfigHash
          globalState.tunnelUrl = Promise.resolve(url)

          registerExitHandler()

          registerListeningHandler(() => {
            const { host: actualServerHost, port: actualPort } = normalizeAddress(
              server.httpServer?.address()
            )
            const actualLocalTarget = getLocalTarget(actualServerHost, actualPort ?? port)
            announceTunnel({
              key: `quick:${url}:${actualPort ?? port}`,
              url,
              localTarget: actualLocalTarget
            })
          })

          registerListeningHandler(async () => {
            try {
              const { host: actualServerHost, port: actualPort } = normalizeAddress(
                server.httpServer?.address()
              )

              if (server.httpServer && actualPort !== undefined && actualPort !== port) {
                pluginLog.warn(
                  `Port conflict detected - server is using port ${actualPort} instead of ${port}`
                )
                pluginLog.info('Restarting quick tunnel for the new port...')

                void killCloudflared('SIGTERM')
                await new Promise(resolve => setTimeout(resolve, 1000))

                const newLocalTarget = getLocalTarget(actualServerHost, actualPort ?? port)

                const { child: newChild, url: newUrl } = await spawnQuickTunnel(
                  newLocalTarget,
                  protocol
                )
                tunnelUrl = newUrl
                child = newChild
                globalState.child = child
                globalState.tunnelUrl = Promise.resolve(newUrl)

                announceTunnel({
                  key: `quick:${newUrl}:${actualPort ?? port}`,
                  url: newUrl,
                  localTarget: newLocalTarget
                })

                const updatedConfigHash = JSON.stringify({
                  isQuickMode,
                  hostname,
                  port: actualPort,
                  tunnelName,
                  dnsOption,
                  sslOption
                })
                globalState.configHash = updatedConfigHash
              }
            } catch (error) {
              console.error(
                `[unplugin-cloudflare-tunnel] ❌ Failed to update quick tunnel for port change: ${(error as Error).message}`
              )
            }
          })

          server.httpServer?.once('close', () => {
            void killCloudflared('SIGTERM')
          })

          return
        } catch (error) {
          console.error(
            `[unplugin-cloudflare-tunnel] ❌ Quick tunnel setup failed: ${(error as Error).message}`
          )
          throw error
        }
      }

      // Named tunnel mode logic
      debugLog('[unplugin-cloudflare-tunnel] Starting named tunnel mode...')

      const apiToken = providedApiToken || process.env.CLOUDFLARE_API_TOKEN

      if (!apiToken) {
        throw new Error(
          '[unplugin-cloudflare-tunnel] API token is required. ' +
            "Provide it via 'apiToken' option or set the CLOUDFLARE_API_TOKEN environment variable. " +
            'Get your token at: https://dash.cloudflare.com/profile/api-tokens'
        )
      }

      debugLog(
        `[unplugin-cloudflare-tunnel] Using port ${port}${userProvidedPort === port ? ' (user-provided)' : ' (from bundler config)'}`
      )

      await ensureCloudflaredBinary(bin)

      const apexDomain = hostname!.split('.').slice(-2).join('.')
      const parentDomain = hostname!.split('.').slice(1).join('.')
      debugLog('← Apex domain', apexDomain)
      debugLog('← Parent domain', parentDomain)
      let resolvedZone: Zone | undefined
      let zoneId: string | undefined = forcedZone
      if (!zoneId) {
        let zones: Zone[] = []
        try {
          zones = await cf(
            apiToken,
            'GET',
            `/zones?name=${parentDomain}`,
            undefined,
            z.array(ZoneSchema)
          )
        } catch (error) {
          debugLog('← Error fetching zone for parent domain', error)
        }
        if (zones.length === 0) {
          zones = await cf(
            apiToken,
            'GET',
            `/zones?name=${apexDomain}`,
            undefined,
            z.array(ZoneSchema)
          )
        }
        resolvedZone = zones[0]
        zoneId = resolvedZone?.id
      }

      let accountId = forcedAccount || resolvedZone?.account?.id
      if (!accountId) {
        const accounts = await cf(apiToken, 'GET', '/accounts', undefined, z.array(AccountSchema))
        accountId = accounts[0]?.id
      }
      if (!accountId) throw new Error('Unable to determine Cloudflare account ID')

      if (!zoneId) throw new Error(`Zone ${apexDomain} not found in account ${accountId}`)

      const { autoCleanup = true } = cleanupConfig

      const tunnels = await cf(
        apiToken,
        'GET',
        `/accounts/${accountId}/cfd_tunnel?name=${tunnelName}`,
        undefined,
        z.array(TunnelSchema)
      )
      let [tunnel] = tunnels

      if (!tunnel) {
        pluginLog.info(`Creating tunnel '${tunnelName}'...`)
        tunnel = await cf(
          apiToken,
          'POST',
          `/accounts/${accountId}/cfd_tunnel`,
          {
            name: tunnelName,
            config_src: 'cloudflare'
          },
          TunnelSchema
        )
      }
      const tunnelId = tunnel.id as string

      if (autoCleanup) {
        debugLog(
          `[unplugin-cloudflare-tunnel] Running resource cleanup for tunnel '${tunnelName}'...`
        )

        const dnsCleanup = await cleanupMismatchedDnsRecords(
          apiToken,
          zoneId,
          generateDnsComment(),
          hostname!,
          tunnelId
        )
        if (dnsCleanup.found.length > 0) {
          pluginLog.warn(
            `DNS cleanup: ${dnsCleanup.found.length} mismatched, ${dnsCleanup.deleted.length} deleted`
          )
        }

        const mismatchedSslCerts = await findMismatchedSslCertificates(
          apiToken,
          zoneId,
          tunnelName,
          hostname!
        )
        if (mismatchedSslCerts.length > 0) {
          for (const cert of mismatchedSslCerts)
            await cf(apiToken, 'DELETE', `/zones/${zoneId}/ssl/certificate_packs/${cert.id}`)

          pluginLog.warn(`SSL cleanup: ${mismatchedSslCerts.length} deleted`)
        }
      } else {
        debugLog('← Cleanup skipped', cleanupConfig)
      }

      const localTarget = getLocalTarget(serverHost, port)
      debugLog('← Connecting to local target', localTarget)

      await cf(apiToken, 'PUT', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
        config: {
          ingress: [
            {
              hostname: hostname!,
              service: localTarget,
              ...(originRequest ? { originRequest } : {})
            },
            { service: 'http_status:404' }
          ]
        }
      })

      const generateSslTagHostname = () => {
        return `cf-tunnel-plugin-${tunnelName}--${parentDomain}`
      }

      if (dnsOption) {
        const ensureDnsRecord = async (type: 'CNAME', content: string) => {
          const existingWildcard = await cf(
            apiToken,
            'GET',
            `/zones/${zoneId}/dns_records?type=${type}&name=${encodeURIComponent(dnsOption)}`,
            undefined,
            z.array(DNSRecordSchema)
          )
          if (existingWildcard.length === 0) {
            console.log(`[unplugin-cloudflare-tunnel] Creating ${type} record for ${dnsOption}...`)
            await cf(
              apiToken,
              'POST',
              `/zones/${zoneId}/dns_records`,
              {
                type,
                name: dnsOption,
                content,
                proxied: true,
                comment: generateDnsComment()
              },
              DNSRecordSchema
            )
          }
        }

        await ensureDnsRecord('CNAME', `${tunnelId}.cfargotunnel.com`)
      } else {
        const wildcardDns = `*.${parentDomain}`
        const existingWildcard = await cf(
          apiToken,
          'GET',
          `/zones/${zoneId}/dns_records?type=CNAME&name=${wildcardDns}`,
          undefined,
          z.array(DNSRecordSchema)
        )
        if (existingWildcard.length === 0) {
          const existingDnsRecords = await cf(
            apiToken,
            'GET',
            `/zones/${zoneId}/dns_records?type=CNAME&name=${hostname!}`,
            undefined,
            z.array(DNSRecordSchema)
          )
          const existingRecord = existingDnsRecords[0]
          const expectedContent = `${tunnelId}.cfargotunnel.com`

          if (!existingRecord) {
            console.log(`[unplugin-cloudflare-tunnel] Creating DNS record for ${hostname}...`)
            await cf(
              apiToken,
              'POST',
              `/zones/${zoneId}/dns_records`,
              {
                type: 'CNAME',
                name: hostname!,
                content: expectedContent,
                proxied: true,
                comment: generateDnsComment()
              },
              DNSRecordSchema
            )
          } else if (existingRecord.content !== expectedContent) {
            debugLog(`← DNS record for ${hostname} points to different tunnel, updating...`)
            pluginLog.info(
              `Updating DNS record for ${hostname} to point to tunnel '${tunnelName}'...`
            )
            await cf(
              apiToken,
              'PUT',
              `/zones/${zoneId}/dns_records/${existingRecord.id}`,
              {
                type: 'CNAME',
                name: hostname!,
                content: expectedContent,
                proxied: true,
                comment: generateDnsComment()
              },
              DNSRecordSchema
            )
          }
        }
      }

      const token = await cf(
        apiToken,
        'GET',
        `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`,
        undefined,
        z.string()
      )

      try {
        const certListRaw = await cf(
          apiToken,
          'GET',
          `/zones/${zoneId}/ssl/certificate_packs?status=all`,
          undefined,
          z.any()
        )
        const certPacks: Array<any> = Array.isArray(certListRaw)
          ? certListRaw
          : certListRaw.result || []

        const certContainingHost = (host: string) =>
          certPacks.filter(c => (c.hostnames || c.hosts || []).includes(host))?.[0]
        if (sslOption) {
          const isWildcard = sslOption.startsWith('*.')
          const certNeededHost = sslOption

          const matchingCert = certContainingHost(certNeededHost)

          if (!matchingCert) {
            console.log(
              `[unplugin-cloudflare-tunnel] Requesting ${isWildcard ? 'wildcard ' : ''}certificate for ${certNeededHost}...`
            )
            const tagHostname = generateSslTagHostname()
            const certificateHosts = [certNeededHost, tagHostname]
            debugLog(`Adding tag hostname to certificate: ${tagHostname}`)

            const newCert: any = await retryWithBackoff(() =>
              cf(apiToken, 'POST', `/zones/${zoneId}/ssl/certificate_packs/order`, {
                hosts: certificateHosts,
                certificate_authority: 'lets_encrypt',
                type: 'advanced',
                validation_method: isWildcard ? 'txt' : 'http',
                validity_days: 90,
                cloudflare_branding: false
              })
            )

            if (newCert?.id) trackSslCertificate(newCert.id, certificateHosts, tunnelName)
          } else {
            debugLog('← Edge certificate already exists', matchingCert)
          }
        } else {
          const wildcardDomain = `*.${parentDomain}`
          const wildcardExists = certContainingHost(wildcardDomain)
          if (!wildcardExists) {
            const totalTls = await cf(
              apiToken,
              'GET',
              `/zones/${zoneId}/acm/total_tls`,
              undefined,
              z.object({ status: z.string() })
            )
            debugLog('← Total TLS', totalTls)
            const existingHostnameCert = certContainingHost(hostname!)
            if (totalTls.status !== 'on' && !existingHostnameCert) {
              pluginLog.info(`Requesting edge certificate for ${hostname}...`)
              const tagHostname = generateSslTagHostname()
              const certificateHosts = [hostname!, tagHostname]
              debugLog(`Adding tag hostname to certificate: ${tagHostname}`)

              const newCert: any = await retryWithBackoff(() =>
                cf(apiToken, 'POST', `/zones/${zoneId}/ssl/certificate_packs/order`, {
                  hosts: certificateHosts,
                  certificate_authority: 'lets_encrypt',
                  type: 'advanced',
                  validation_method: 'txt',
                  validity_days: 90,
                  cloudflare_branding: false
                })
              )

              if (newCert?.id) {
                trackSslCertificate(newCert.id, certificateHosts, tunnelName)
              }
            } else {
              debugLog('← Edge certificate already exists', existingHostnameCert)
            }
          } else {
            debugLog('← Edge certificate (wildcard) already exists', wildcardExists, wildcardDomain)
          }
        }
      } catch (sslError) {
        console.error(
          `[unplugin-cloudflare-tunnel] ⚠️  SSL management error: ${(sslError as Error).message}`
        )
        throw sslError
      }

      let tunnelReady = false
      let localTargetForAnnouncement = localTarget
      let activeTunnelProtocol: 'quic' | 'http2' | undefined

      const announceNamedTunnelIfReady = () => {
        if (!tunnelReady) return
        announceTunnel({
          key: `named:${hostname}:${localTargetForAnnouncement}`,
          url: `https://${hostname}`,
          localTarget: localTargetForAnnouncement
        })
      }

      const logCloudflaredLines = (kind: 'stdout' | 'stderr', text: string) => {
        if (globalState.shuttingDown && !debug) return
        const isVerbose = effectiveLogLevel === 'debug' || effectiveLogLevel === 'info'
        const lines = text
          .split('\n')
          .map(l => l.trim())
          .filter(Boolean)

        if (isVerbose) {
          for (const line of lines) {
            const prefix = kind === 'stdout' ? '[cloudflared stdout]' : '[cloudflared stderr]'
            if (kind === 'stdout') console.log(`${prefix} ${line}`)
            else console.error(`${prefix} ${line}`)
          }
          return
        }

        for (const line of lines) {
          if (INFO_LOG_REGEX.test(line)) continue
          const prefix = kind === 'stdout' ? '[cloudflared stdout]' : '[cloudflared stderr]'
          if (kind === 'stdout') console.log(`${prefix} ${line}`)
          else console.error(`${prefix} ${line}`)
        }
      }

      const spawnNamedTunnelProcess = (protocol: 'quic' | 'http2') => {
        const cloudflaredArgs = ['tunnel']
        cloudflaredArgs.push('--loglevel', cloudflaredProcessLogLevel)
        if (logFile) cloudflaredArgs.push('--logfile', logFile)

        cloudflaredArgs.push('--protocol', protocol)

        debugLog('Spawning cloudflared', bin, cloudflaredArgs)
        const spawnedChild = NodeChildProcess.spawn(
          bin,
          [...cloudflaredArgs, 'run', '--token', token],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
            windowsHide: true,
            shell: process.platform === 'win32'
          }
        )

        child = spawnedChild
        globalState.child = spawnedChild
        globalState.configHash = newConfigHash

        debugLog(`[unplugin-cloudflare-tunnel] Process spawned with PID: ${spawnedChild.pid}`)

        const handleCloudflaredOutput = (kind: 'stdout' | 'stderr', text: string) => {
          if (text.includes('Failed to parse ICMP reply') || text.includes('unknow ip version 0')) {
            if (logLevel === 'debug') console.log(`[cloudflared debug] ${text.trim()}`)

            return
          }

          logCloudflaredLines(kind, text)

          if (/registered tunnel connection|connection.*registered/i.test(text)) {
            activeTunnelProtocol = protocol
            if (!tunnelReady) {
              tunnelReady = true
              pluginLog.info(
                `Tunnel connected for https://${hostname} via ${protocol.toUpperCase()}`
              )
            }
            announceNamedTunnelIfReady()
          }
        }

        spawnedChild.stdout?.on('data', data => {
          handleCloudflaredOutput('stdout', data.toString())
        })

        spawnedChild.stderr?.on('data', data => {
          handleCloudflaredOutput('stderr', data.toString())
        })

        spawnedChild.on('error', error => {
          console.error(
            `[unplugin-cloudflare-tunnel] ❌ Failed to start tunnel process: ${error.message}`
          )
          if (error.message.includes('ENOENT'))
            console.error(
              `[unplugin-cloudflare-tunnel] Hint: cloudflared binary may not be installed correctly`
            )
        })

        spawnedChild.on('exit', (code, signal) => {
          if (globalState.child !== spawnedChild) return

          if (code !== 0 && code !== null) {
            console.error(`[unplugin-cloudflare-tunnel] ❌ Tunnel process exited with code ${code}`)
            if (signal)
              console.error(`[unplugin-cloudflare-tunnel] Process terminated by signal: ${signal}`)
          } else if (code === 0)
            console.log(`[unplugin-cloudflare-tunnel] ✅ Tunnel process exited cleanly`)
        })
      }

      spawnNamedTunnelProcess(protocol)
      registerExitHandler()

      registerListeningHandler(() => {
        const { host: actualServerHost, port: actualPort } = normalizeAddress(
          server.httpServer?.address()
        )
        localTargetForAnnouncement = getLocalTarget(actualServerHost, actualPort ?? port)
        announceNamedTunnelIfReady()
      })

      server.httpServer?.once('close', () => {
        void killCloudflared('SIGTERM')
      })

      registerListeningHandler(async () => {
        try {
          const { host: actualServerHost, port: actualPort } = normalizeAddress(
            server.httpServer?.address()
          )

          if (server.httpServer && actualPort !== undefined && actualPort !== port) {
            pluginLog.warn(
              `Port conflict detected - server is using port ${actualPort} instead of ${port}`
            )
            pluginLog.info('Updating tunnel configuration...')

            const newLocalTarget = getLocalTarget(actualServerHost, actualPort ?? port)
            localTargetForAnnouncement = newLocalTarget

            debugLog('← Updating local target to', newLocalTarget)

            await cf(
              apiToken,
              'PUT',
              `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
              {
                config: {
                  ingress: [
                    {
                      hostname: hostname!,
                      service: newLocalTarget,
                      ...(originRequest
                        ? {
                            originRequest: {
                              httpHostHeader: `${actualServerHost}:${actualPort ?? port}`
                            }
                          }
                        : {})
                    },
                    { service: 'http_status:404' }
                  ]
                }
              }
            )

            pluginLog.info(`Tunnel configuration updated to use port ${actualPort}`)

            const updatedConfigHash = JSON.stringify({
              hostname,
              port: actualPort,
              tunnelName,
              dnsOption,
              sslOption,
              originRequest: server.httpServer
                ? undefined
                : {
                    httpHostHeader: `${actualServerHost}:${actualPort ?? port}`
                  }
            })
            globalState.configHash = updatedConfigHash
            if (tunnelReady && activeTunnelProtocol) {
              pluginLog.info(
                `Tunnel remains connected via ${activeTunnelProtocol.toUpperCase()} after port update`
              )
            }
            announceNamedTunnelIfReady()
          }
        } catch (error) {
          console.error(
            `[unplugin-cloudflare-tunnel] ❌ Failed to update tunnel for port change: ${(error as Error).message}`
          )
        }
      })
    } catch (error) {
      if (error instanceof Error) {
        console.error(`[unplugin-cloudflare-tunnel] ❌ Setup failed: ${(error as Error).message}`)

        if (error.message.includes('API token')) {
          console.error(
            `[unplugin-cloudflare-tunnel] 💡 Check your API token at: https://dash.cloudflare.com/profile/api-tokens`
          )
          console.error(
            `[unplugin-cloudflare-tunnel] 💡 Required permissions: Zone:Zone:Read, Zone:DNS:Edit, Account:Cloudflare Tunnel:Edit`
          )
        } else if (error.message.includes('Zone') && error.message.includes('not found')) {
          console.error(
            `[unplugin-cloudflare-tunnel] 💡 Make sure '${hostname}' domain is added to your Cloudflare account`
          )
        } else if (error.message.includes('cloudflared')) {
          console.error(
            `[unplugin-cloudflare-tunnel] 💡 Try deleting node_modules and reinstalling to get a fresh cloudflared binary`
          )
        }
      }

      throw error
    }
  }

  const ensureWebpackAllowedHosts = (
    devServerOptions: Record<string, any> | undefined,
    bundler: 'webpack' | 'rspack'
  ) => {
    if (!devServerOptions) return

    const hostToAllow = isQuickMode ? '.trycloudflare.com' : hostname
    if (!hostToAllow) return

    const label = bundler === 'webpack' ? 'Webpack' : 'Rspack'

    const normalizeArray = (values: Array<string>) => {
      const unique = Array.from(new Set(values.filter(Boolean)))
      devServerOptions.allowedHosts = unique
      return unique
    }

    let modified = false
    const current = devServerOptions.allowedHosts

    if (current === 'all') return

    if (typeof current === 'undefined' || current === 'auto') {
      normalizeArray(['localhost', hostToAllow])
      modified = true
    } else if (typeof current === 'string') {
      if (current !== hostToAllow) {
        normalizeArray([current, hostToAllow])
        modified = true
      }
    } else if (Array.isArray(current)) {
      if (!current.includes(hostToAllow)) {
        current.push(hostToAllow)
        modified = true
      }
    }

    if (modified) {
      debugLog(
        `[unplugin-cloudflare-tunnel] Configured ${label} devServer.allowedHosts to include ${hostToAllow}`
      )
    }
  }

  const ensureViteAllowedHosts = (serverConfig: Record<string, any>) => {
    const hostToAllow = isQuickMode ? '.trycloudflare.com' : hostname
    if (!hostToAllow) return

    const current = serverConfig.allowedHosts
    if (current === true) return

    if (typeof current === 'undefined') {
      serverConfig.allowedHosts = [hostToAllow]
    } else if (typeof current === 'string') {
      if (current !== hostToAllow) {
        serverConfig.allowedHosts = [current, hostToAllow]
      }
    } else if (Array.isArray(current)) {
      if (!current.includes(hostToAllow)) {
        current.push(hostToAllow)
      }
    }
  }

  const setupWebpackVirtualScheme = (compiler: WebpackCompiler) => {
    const plugins = (compiler.options.plugins ??= []) as Array<any>
    if (plugins.some(plugin => plugin?.__unpluginCloudflareTunnelVirtualSchemePlugin)) {
      return
    }

    const context =
      typeof compiler.options.context === 'string' && compiler.options.context.length > 0
        ? compiler.options.context
        : process.cwd()

    let VirtualUrlPlugin: any
    try {
      const requireFromContext = NodeModule.createRequire(`${context}/package.json`)
      VirtualUrlPlugin = requireFromContext('webpack/lib/schemes/VirtualUrlPlugin')
    } catch {
      return
    }

    const virtualSchemePlugin = new VirtualUrlPlugin(
      {
        'unplugin-cloudflare-tunnel': {
          type: '.js',
          async source() {
            const url = await globalState.tunnelUrl
            return `export function getTunnelUrl() { return ${JSON.stringify(url || '')}; }`
          }
        }
      },
      'virtual'
    )

    ;(virtualSchemePlugin as any).__unpluginCloudflareTunnelVirtualSchemePlugin = true
    plugins.unshift(virtualSchemePlugin)
    virtualSchemePlugin.apply(compiler)
  }

  const setupWebpackLikeDevServerIntegration = (
    compiler: WebpackCompiler | RspackCompiler,
    bundler: 'webpack' | 'rspack'
  ) => {
    const mode = compiler?.options?.mode ?? process.env.NODE_ENV
    if (mode === 'production') return

    const optionsContainer = compiler.options
    if (!optionsContainer.devServer) optionsContainer.devServer = {}

    const devServerOptions: Record<string, any> = optionsContainer.devServer

    ensureWebpackAllowedHosts(devServerOptions, bundler)

    let lastHttpServer: NodeServerLike | undefined
    let missingServerWarned = false

    const runConfiguration = (devServerInstance: any) => {
      if (!devServerInstance) {
        if (!missingServerWarned) {
          console.warn(
            `[unplugin-cloudflare-tunnel] ${bundler} dev server instance unavailable; skipping tunnel setup`
          )
          missingServerWarned = true
        }
        return
      }

      const httpServerCandidates: Array<NodeServerLike | undefined> = [
        devServerInstance.server,
        devServerInstance.httpServer,
        devServerInstance.listeningApp,
        devServerInstance.server?.server
      ]

      const httpServer = httpServerCandidates.find(candidate => candidate) as
        | NodeServerLike
        | undefined

      if (!httpServer) {
        if (!missingServerWarned) {
          console.warn(
            `[unplugin-cloudflare-tunnel] Unable to locate HTTP server from ${bundler} dev server; tunnel will not start`
          )
          missingServerWarned = true
        }
        return
      }

      if (lastHttpServer === httpServer) return
      lastHttpServer = httpServer

      httpServer.once('close', () => {
        if (lastHttpServer === httpServer) {
          lastHttpServer = undefined
        }
      })

      const portCandidate = devServerInstance.options?.port ?? devServerOptions?.port

      const adapter: CompatibleDevServer = {
        httpServer,
        config: {
          server: {
            port: portCandidate
          }
        }
      }

      const configuredPromise = configureServer(adapter)
      globalState.tunnelUrl = configuredPromise.then(() => tunnelUrl).catch(() => '')

      configuredPromise.catch(() => {})
    }

    const scheduleConfiguration = (devServerInstance: any) => {
      const httpServer: NodeServerLike | undefined =
        devServerInstance?.server ||
        devServerInstance?.httpServer ||
        devServerInstance?.listeningApp

      if (httpServer && typeof httpServer.once === 'function') {
        if (httpServer.listening) {
          runConfiguration(devServerInstance)
        } else {
          httpServer.once('listening', () => runConfiguration(devServerInstance))
        }
      } else {
        runConfiguration(devServerInstance)
      }
    }

    const originalSetupMiddlewares = devServerOptions.setupMiddlewares
    devServerOptions.setupMiddlewares = function (middlewares: any, devServer: any) {
      scheduleConfiguration(devServer)
      if (typeof originalSetupMiddlewares === 'function') {
        return originalSetupMiddlewares.call(this, middlewares, devServer)
      }
      return middlewares
    }

    const originalOnListening = devServerOptions.onListening
    devServerOptions.onListening = function (devServer: any) {
      scheduleConfiguration(devServer)
      if (typeof originalOnListening === 'function') {
        return originalOnListening.call(this, devServer)
      }
      return undefined
    }
  }

  // ---------------------------------------------------------------------
  // Return the unplugin factory object
  // ---------------------------------------------------------------------
  return {
    name: PLUGIN_NAME,
    enforce: 'pre' as const,

    // Virtual module hooks
    resolveId(id) {
      if (id === VIRTUAL_MODULE_ID) {
        debugLog('resolveId called for', id)
        return id
      }
    },

    loadInclude(id) {
      return id === VIRTUAL_MODULE_ID
    },

    async load(id) {
      if (id === VIRTUAL_MODULE_ID) {
        const url = await globalState.tunnelUrl
        return `export function getTunnelUrl() { return ${JSON.stringify(url || '')}; }`
      }
    },

    /**
     * #### Vite integration ####
     */
    vite: {
      config: config => {
        announceConnecting()

        if (!config.server) config.server = {}

        ensureViteAllowedHosts(config.server)

        if (!isQuickMode) {
          debugLog(
            `[unplugin-cloudflare-tunnel] Configured Vite to allow requests from ${hostname}`
          )
        }
      },

      configureServer: server => {
        const configuredPromise = configureServer(server)
        globalState.tunnelUrl = configuredPromise.then(() => tunnelUrl).catch(() => '')
        return async () => {
          await configuredPromise
        }
      }
    },
    esbuild: {
      config() {
        announceConnecting()

        if (typeof userProvidedPort === 'number' && !Number.isNaN(userProvidedPort)) {
          const configuredPromise = configureServer({
            config: {
              server: {
                port: userProvidedPort
              }
            }
          })
          globalState.tunnelUrl = configuredPromise.then(() => tunnelUrl).catch(() => '')
        } else {
          globalState.tunnelUrl = Promise.resolve('')
          console.warn(
            '[unplugin-cloudflare-tunnel] esbuild requires the plugin `port` option to enable tunnel startup'
          )
        }

        if (!isQuickMode) {
          debugLog(`[unplugin-cloudflare-tunnel] Configured esbuild tunnel target for ${hostname}`)
        }
      }
    },
    rspack: compiler => {
      setupWebpackLikeDevServerIntegration(compiler, 'rspack')
    },

    webpack: compiler => {
      setupWebpackVirtualScheme(compiler)
      setupWebpackLikeDevServerIntegration(compiler, 'webpack')
    },

    buildStart(this: any) {
      if (!this?.meta?.watchMode) return
      if (typeof userProvidedPort !== 'number' || Number.isNaN(userProvidedPort)) return
      if (globalState.tunnelUrl) return

      announceConnecting()

      const configuredPromise = configureServer({
        config: {
          server: {
            port: userProvidedPort
          }
        }
      })
      globalState.tunnelUrl = configuredPromise.then(() => tunnelUrl).catch(() => '')
    },

    closeBundle(this: any) {
      if (this?.meta?.watchMode) return
      void killCloudflared('SIGTERM')
      delete globalState.child
      delete globalState.configHash
      delete globalState.shuttingDown
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Utility functions                                                          */
/* -------------------------------------------------------------------------- */

function normalizeHost(host: string | undefined): string {
  if (!host || host === '0.0.0.0' || host === '::' || host === '::0') {
    return 'localhost'
  }
  return host
}

function normalizeAddress(
  address: string | { address?: string; port?: number } | null | undefined
): { host: string; port?: number } {
  if (address && typeof address === 'object') {
    return {
      host: normalizeHost(
        'address' in address && address.address ? (address as any).address : undefined
      ),
      port: 'port' in address && typeof address?.port === 'number' ? address?.port : undefined
    }
  }
  return { host: 'localhost' }
}

async function ensureCloudflaredBinary(binPath: string) {
  try {
    await NodeFS.access(binPath)
  } catch {
    console.log('[unplugin-cloudflare-tunnel] Installing cloudflared binary...')
    await install(binPath)
  }
}

function getLocalTarget(host: string, port: number): string {
  const isIpv6 = host.includes(':')
  return `http://${isIpv6 ? `[${host}]` : host}:${port}`
}

export const CloudflareTunnel: UnpluginInstance<CloudflareTunnelOptions | undefined, false> =
  createUnplugin(unpluginFactory)

export default CloudflareTunnel
