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

import type { ViteDevServer } from 'vite'
import { bin, install } from 'cloudflared'
import fs from 'node:fs/promises'
import { spawn, exec } from 'node:child_process'
import { z } from 'zod'
import { createUnplugin } from 'unplugin'
import type { UnpluginFactory, UnpluginInstance } from 'unplugin'

const INFO_LOG_REGEX = /^.*Z INF .*/

// Zod schemas for Cloudflare API responses
const CloudflareErrorSchema: z.ZodType<{
  code: number
  message: string
}> = z.object({
  code: z.number(),
  message: z.string(),
})

const CloudflareApiResponseSchema: z.ZodType<{
  success: boolean
  errors?: Array<{ code: number; message: string }>
  messages?: Array<string>
  result: unknown
}> = z.object({
  success: z.boolean(),
  errors: z.array(CloudflareErrorSchema).optional(),
  messages: z.array(z.string()).optional(),
  result: z.unknown(),
})

const AccountSchema: z.ZodType<{
  id: string
  name: string
}> = z.object({
  id: z.string(),
  name: z.string(),
})

const ZoneSchema: z.ZodType<{
  id: string
  name: string
}> = z.object({
  id: z.string(),
  name: z.string(),
})

const TunnelSchema: z.ZodType<{
  id: string
  name: string
  account_tag: string
  created_at: string
  connections?: Array<unknown>
}> = z.object({
  id: z.string(),
  name: z.string(),
  account_tag: z.string(),
  created_at: z.string(),
  connections: z.array(z.unknown()).optional(),
})

const DNSRecordSchema: z.ZodType<{
  id: string
  type: string
  name: string
  content: string
  proxied: boolean
  comment?: string | null
}> = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  content: z.string(),
  proxied: z.boolean(),
  comment: z.string().nullish(),
})

// Type definitions (exported for potential external use)
export type CloudflareApiResponse<T = unknown> = z.infer<
  typeof CloudflareApiResponseSchema
> & {
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
   * Log level for cloudflared process
   * @default undefined (uses cloudflared default)
   */
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'fatal'

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
   * 2. CLOUDFLARE_API_KEY environment variable
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
 * - Named tunnel mode: Provide `hostname` for a persistent tunnel with custom domain
 * - Quick tunnel mode: Omit `hostname` for a temporary tunnel with random trycloudflare.com URL
 */
export type CloudflareTunnelOptions = NamedTunnelOptions | QuickTunnelOptions

const unpluginFactory: UnpluginFactory<CloudflareTunnelOptions | undefined> = (
  options: CloudflareTunnelOptions = {},
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
      name: 'unplugin-cloudflare-tunnel',
      enforce: 'pre' as const,

      resolveId(id) {
        if (id === VIRTUAL_MODULE_ID_STUB) {
          return '\0' + VIRTUAL_MODULE_ID_STUB
        }
        return
      },

      load(id) {
        if (id === '\0' + VIRTUAL_MODULE_ID_STUB) {
          return 'export function getTunnelUrl() { return ""; }'
        }
        return
      },
    }
  }

  // ---------------------------------------------------------------------
  // Global state management for tunnel process across HMR restarts
  // ---------------------------------------------------------------------
  const GLOBAL_STATE = Symbol.for('unplugin-cloudflare-tunnel.state')

  type GlobalState = {
    child?: ReturnType<typeof spawn>
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
  let child: ReturnType<typeof spawn> | undefined = globalState.child

  // ---------------------------------------------------------------------
  // Virtual module to expose the tunnel URL at dev time
  // ---------------------------------------------------------------------
  const VIRTUAL_MODULE_ID = 'virtual:unplugin-cloudflare-tunnel'

  // ---------------------------------------------------------------------
  // Extract and validate options
  // ---------------------------------------------------------------------
  const isQuickMode = !('hostname' in options)

  // Validate that quick mode options don't include named-mode-only options
  if (isQuickMode) {
    const namedModeOptions = [
      'apiToken',
      'accountId',
      'zoneId',
      'tunnelName',
      'dns',
      'ssl',
      'cleanup',
    ]
    const invalidOptions = namedModeOptions.filter(opt => opt in options)
    if (invalidOptions.length > 0) {
      throw new Error(
        `[unplugin-cloudflare-tunnel] The following options are only supported in named tunnel mode (when hostname is provided): ${invalidOptions.join(', ')}. ` +
          `Either provide a hostname for named tunnel mode, or remove these options for quick tunnel mode.`,
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
  const { port: userProvidedPort, logFile, logLevel, debug = false } = options

  // Internal debug logger
  const debugLog = (...args: unknown[]) => {
    if (debug) {
      console.log('[cloudflare-tunnel:debug]', ...args)
    }
  }

  // Basic input validation
  if (!isQuickMode && (!hostname || typeof hostname !== 'string')) {
    throw new Error(
      '[unplugin-cloudflare-tunnel] hostname is required and must be a valid string in named tunnel mode',
    )
  }

  let tunnelUrl = hostname ? `https://${hostname}` : ''

  // Validate tunnel name
  if (
    tunnelName &&
    !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(tunnelName)
  ) {
    throw new Error(
      '[unplugin-cloudflare-tunnel] tunnelName must contain only letters, numbers, and hyphens. ' +
        'It cannot start or end with a hyphen.',
    )
  }

  if (
    userProvidedPort &&
    (typeof userProvidedPort !== 'number' ||
      userProvidedPort < 1 ||
      userProvidedPort > 65535)
  ) {
    throw new Error(
      '[unplugin-cloudflare-tunnel] port must be a valid number between 1 and 65535',
    )
  }

  if (
    logLevel &&
    !['debug', 'info', 'warn', 'error', 'fatal'].includes(logLevel)
  ) {
    throw new Error(
      '[unplugin-cloudflare-tunnel] logLevel must be one of: debug, info, warn, error, fatal',
    )
  }

  const effectiveLogLevel: 'debug' | 'info' | 'warn' | 'error' | 'fatal' =
    (logLevel as any) ?? (debug ? 'info' : 'warn')
  debugLog('Effective cloudflared log level:', effectiveLogLevel)

  if (dnsOption) {
    const isDnsWildcard = dnsOption.startsWith('*.')
    if (!isDnsWildcard && dnsOption !== hostname) {
      throw new Error(
        "[unplugin-cloudflare-tunnel] dns option must either be a wildcard (e.g., '*.example.com') or exactly match the hostname",
      )
    }
  }

  if (sslOption) {
    const isSslWildcard = sslOption.startsWith('*.')
    if (!isSslWildcard && sslOption !== hostname) {
      throw new Error(
        "[unplugin-cloudflare-tunnel] ssl option must either be a wildcard (e.g., '*.example.com') or exactly match the hostname",
      )
    }
  }

  // ---------------------------------------------------------------------
  // Helper functions (Cloudflare API, SSL tracking, DNS cleanup, etc.)
  // ---------------------------------------------------------------------

  const trackSslCertificate = (
    certificateId: string,
    hosts: string[],
    tunnelName: string,
    timestamp: string = new Date().toISOString(),
  ) => {
    const trackingKey = `ssl-cert-${certificateId}`
    globalState[trackingKey] = {
      id: certificateId,
      hosts,
      tunnelName,
      timestamp,
      pluginVersion: '1.0.0',
    }
    debugLog(
      `Tracking SSL certificate: ${certificateId} for hosts: ${hosts.join(', ')}`,
    )
  }

  const findMismatchedSslCertificates = async (
    apiToken: string,
    zoneId: string,
    currentTunnelName: string,
    currentHostname: string,
  ): Promise<Array<any>> => {
    try {
      const certPacks: any = await cf(
        apiToken,
        'GET',
        `/zones/${zoneId}/ssl/certificate_packs?status=all`,
        undefined,
        z.any(),
      )
      const allCerts: Array<any> = Array.isArray(certPacks)
        ? certPacks
        : certPacks.result || []

      const currentTunnelCerts = allCerts.filter(cert => {
        const certHosts = cert.hostnames || cert.hosts || []
        return certHosts.some((host: string) =>
          host.startsWith(`cf-tunnel-plugin-${currentTunnelName}--`),
        )
      })

      debugLog(
        `Found ${currentTunnelCerts.length} SSL certificates for current tunnel: ${currentTunnelName}`,
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
          currentHostname,
        })),
      )

      return mismatchedCerts
    } catch (error) {
      console.error(
        `[unplugin-cloudflare-tunnel] ❌ SSL certificate listing failed: ${(error as Error).message}`,
      )
      return []
    }
  }

  const cleanupMismatchedDnsRecords = async (
    apiToken: string,
    zoneId: string,
    dnsComment: string,
    currentHostname: string,
    tunnelId: string,
  ): Promise<{ found: Array<DNSRecord>; deleted: Array<DNSRecord> }> => {
    try {
      const pluginDnsRecords = await cf(
        apiToken,
        'GET',
        `/zones/${zoneId}/dns_records?comment=${dnsComment}&match=all`,
        undefined,
        z.array(DNSRecordSchema),
      )

      debugLog(
        `Found ${pluginDnsRecords.length} DNS records for current tunnel: ${dnsComment}`,
      )

      const expectedCnameContent = `${tunnelId}.cfargotunnel.com`
      const mismatchedRecords = pluginDnsRecords.filter(record => {
        if (
          record.name === currentHostname &&
          record.content === expectedCnameContent
        ) {
          return false
        }

        if (
          dnsOption &&
          record.name === dnsOption &&
          record.content === expectedCnameContent
        ) {
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
          comment: r.comment,
        })),
      )

      const deletedRecords: DNSRecord[] = []

      if (mismatchedRecords.length > 0) {
        console.log(
          `[unplugin-cloudflare-tunnel] 🧹 Cleaning up ${mismatchedRecords.length} mismatched DNS records from tunnel '${dnsComment}'...`,
        )

        for (const record of mismatchedRecords) {
          try {
            await cf(
              apiToken,
              'DELETE',
              `/zones/${zoneId}/dns_records/${record.id}`,
            )
            deletedRecords.push(record)
            console.log(
              `[unplugin-cloudflare-tunnel] ✅ Deleted mismatched DNS record: ${record.name} → ${record.content}`,
            )
          } catch (error) {
            console.error(
              `[unplugin-cloudflare-tunnel] ❌ Failed to delete DNS record ${record.name}: ${(error as Error).message}`,
            )
          }
        }
      }

      return {
        found: mismatchedRecords,
        deleted: deletedRecords,
      }
    } catch (error) {
      console.error(
        `[unplugin-cloudflare-tunnel] ❌ DNS cleanup failed: ${(error as Error).message}`,
      )
      return { found: [], deleted: [] }
    }
  }

  const cf = async <T>(
    apiToken: string,
    method: string,
    url: string,
    body?: unknown,
    resultSchema?: z.ZodSchema<T>,
  ): Promise<T> => {
    try {
      debugLog('→ CF API', method, url, body ? { body } : '')

      const response = await fetch(
        `https://api.cloudflare.com/client/v4${url}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'unplugin-cloudflare-tunnel/1.0.0',
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      )

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error')
        throw new Error(
          `[unplugin-cloudflare-tunnel] API request failed: ${response.status} ${response.statusText}. Response: ${errorText}`,
        )
      }

      const rawData = await response.json()
      debugLog('← CF API response', rawData)
      const apiResponse = CloudflareApiResponseSchema.parse(rawData)

      if (!apiResponse.success) {
        const errorMsg =
          apiResponse.errors
            ?.map(e => e.message || `Error ${e.code}`)
            .join(', ') || 'Unknown API error'
        throw new Error(
          `[unplugin-cloudflare-tunnel] Cloudflare API error: ${errorMsg}`,
        )
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
        if (error.message.includes('[unplugin-cloudflare-tunnel]')) {
          throw error
        }
        throw new Error(
          `[unplugin-cloudflare-tunnel] API request failed: ${error.message}`,
        )
      }
      throw new Error('[unplugin-cloudflare-tunnel] Unknown API error occurred')
    }
  }

  const retryWithBackoff = async <T>(
    fn: () => Promise<T>,
    maxRetries = 5,
    initialDelayMs = 1000,
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
            `[unplugin-cloudflare-tunnel] ❌ Edge certificate request failed after ${maxRetries} retries: ${message}`,
          )
          throw error
        }
        const delay = initialDelayMs * 2 ** (attempt - 1)
        console.error(
          `[unplugin-cloudflare-tunnel] ⚠️  Edge certificate request failed (attempt ${attempt}/${maxRetries}): ${message}`,
        )
        console.error(
          `[unplugin-cloudflare-tunnel] ⏳ Retrying in ${delay}ms...`,
        )
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  const spawnQuickTunnel = async (
    localTarget: string,
  ): Promise<{ child: ReturnType<typeof spawn>; url: string }> => {
    const cloudflaredArgs = ['tunnel']
    cloudflaredArgs.push('--loglevel', 'info')
    if (logFile) {
      cloudflaredArgs.push('--logfile', logFile)
    }
    cloudflaredArgs.push('--url', localTarget)

    debugLog('Spawning quick tunnel:', bin, cloudflaredArgs)
    const child = spawn(bin, cloudflaredArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true,
      shell: process.platform === 'win32',
    })

    console.log(
      `[unplugin-cloudflare-tunnel] Quick tunnel process spawned with PID: ${child.pid}`,
    )

    return new Promise((resolve, reject) => {
      let urlFound = false
      const timeout = setTimeout(() => {
        if (!urlFound) {
          reject(
            new Error('Quick tunnel URL not found in output within 30 seconds'),
          )
        }
      }, 30000)

      child.stdout?.on('data', data => {
        const output = data.toString()
        if (!globalState.shuttingDown || debug) {
          if (effectiveLogLevel === 'debug' || effectiveLogLevel === 'info') {
            console.log(`[cloudflared stdout] ${output.trim()}`)
          } else {
            for (const line of output.split('\n')) {
              if (!INFO_LOG_REGEX.test(line)) {
                console.log(`[cloudflared stdout] ${line.trim()}`)
              }
            }
          }
        }
      })

      child.stderr?.on('data', data => {
        const error = data.toString().trim()

        const urlMatch = error.match(
          /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/,
        )
        if (urlMatch && !urlFound) {
          urlFound = true
          clearTimeout(timeout)
          resolve({ child, url: urlMatch[0] })
        }

        if (
          error.includes('Failed to parse ICMP reply') ||
          error.includes('unknow ip version 0')
        ) {
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
              if (!INFO_LOG_REGEX.test(line)) {
                console.error(`[cloudflared stderr] ${line.trim()}`)
              }
            }
          }
        }
      })

      child.on('error', error => {
        clearTimeout(timeout)
        reject(
          new Error(`Failed to start quick tunnel process: ${error.message}`),
        )
      })

      child.on('exit', (code, signal) => {
        clearTimeout(timeout)
        if (!urlFound) {
          reject(
            new Error(
              `Quick tunnel process exited before URL was found (code: ${code}, signal: ${signal})`,
            ),
          )
        }
      })
    })
  }

  const killCloudflared = (signal: NodeJS.Signals = 'SIGTERM') => {
    if (!child || child.killed) return

    globalState.shuttingDown = true
    globalState.tunnelUrl = undefined

    try {
      console.log(
        `[unplugin-cloudflare-tunnel] 🛑 Terminating cloudflared process (PID: ${child.pid}) with ${signal}...`,
      )
      const killed = child.kill(signal)

      if (!killed && process.platform === 'win32') {
        exec(`taskkill /pid ${child.pid} /T /F`, () => {})
      }

      if (signal === 'SIGTERM') {
        setTimeout(() => {
          if (child && !child.killed) {
            console.log(
              '[unplugin-cloudflare-tunnel] 🛑 Force killing cloudflared process...',
            )
            if (process.platform === 'win32') {
              exec(`taskkill /pid ${child.pid} /T /F`, () => {})
            } else {
              child.kill('SIGKILL')
            }
          }
        }, 2000)
      }
    } catch (error) {
      console.log(
        `[unplugin-cloudflare-tunnel] Note: Error killing cloudflared: ${error}`,
      )
    }
  }

  let exitHandlersRegistered = globalState.exitHandlersRegistered ?? false

  const registerExitHandler = () => {
    if (exitHandlersRegistered) return
    exitHandlersRegistered = true
    globalState.exitHandlersRegistered = true

    const cleanup = () => killCloudflared('SIGTERM')

    process.once('exit', cleanup)
    process.once('beforeExit', cleanup)

    ;['SIGINT', 'SIGTERM', 'SIGQUIT', 'SIGHUP'].forEach(signal => {
      process.once(signal as NodeJS.Signals, () => {
        killCloudflared(signal as NodeJS.Signals)
        try {
          process.kill(process.pid, signal as NodeJS.Signals)
        } catch {
          process.exit(0)
        }
      })
    })

    process.once('uncaughtException', error => {
      console.error(
        '[unplugin-cloudflare-tunnel] Uncaught exception, cleaning up cloudflared...',
        error,
      )
      killCloudflared('SIGTERM')
    })

    process.once('unhandledRejection', reason => {
      console.error(
        '[unplugin-cloudflare-tunnel] Unhandled rejection, cleaning up cloudflared...',
        reason,
      )
      killCloudflared('SIGTERM')
    })
  }

  // ---------------------------------------------------------------------
  // Main server configuration logic (to be called from Vite's configureServer)
  // ---------------------------------------------------------------------
  const configureServer = async (server: ViteDevServer) => {
    const generateDnsComment = () => {
      return `unplugin-cloudflare-tunnel:${tunnelName}`
    }

    try {
      const { host: serverHost, port: detectedPort } = normalizeAddress(
        server.httpServer?.address(),
      )
      const port =
        userProvidedPort || detectedPort || server.config.server.port || 5173
      const newConfigHash = JSON.stringify({
        isQuickMode,
        hostname,
        port,
        tunnelName,
        dnsOption,
        sslOption,
      })

      if (
        globalState.child &&
        !globalState.child.killed &&
        globalState.configHash === newConfigHash
      ) {
        tunnelUrl = (await globalState.tunnelUrl) ?? ''
        console.log(
          '[unplugin-cloudflare-tunnel] Config unchanged – re-using existing tunnel',
        )
        globalState.shuttingDown = false
        registerExitHandler()
        return
      }

      if (globalState.child && !globalState.child.killed) {
        console.log(
          '[unplugin-cloudflare-tunnel] Config changed – terminating previous tunnel...',
        )
        try {
          globalState.child.kill('SIGTERM')
        } catch (_) {}
      }

      delete globalState.child
      delete globalState.configHash
      globalState.shuttingDown = false

      // Handle quick tunnel mode
      if (isQuickMode) {
        console.log(
          '[unplugin-cloudflare-tunnel] Starting quick tunnel mode...',
        )
        debugLog('Quick tunnel mode - no API token or hostname required')

        await ensureCloudflaredBinary(bin)

        const localTarget = getLocalTarget(serverHost, port)
        debugLog('← Quick tunnel connecting to local target', localTarget)

        try {
          const { child: quickChild, url } = await spawnQuickTunnel(localTarget)
          tunnelUrl = url
          child = quickChild

          globalState.child = child
          globalState.configHash = newConfigHash

          registerExitHandler()

          console.log(`🌐  Quick tunnel ready at: ${url}`)

          server.httpServer?.on('listening', async () => {
            try {
              const { host: actualServerHost, port: actualPort } =
                normalizeAddress(server.httpServer?.address())

              if (actualPort !== port) {
                console.log(
                  `[unplugin-cloudflare-tunnel] ⚠️  Port conflict detected - server is using port ${actualPort} instead of ${port}`,
                )
                console.log(
                  `[unplugin-cloudflare-tunnel] 🔄 Quick tunnel needs to be restarted for new port...`,
                )

                killCloudflared('SIGTERM')
                await new Promise(resolve => setTimeout(resolve, 1000))

                const newLocalTarget = getLocalTarget(
                  actualServerHost,
                  actualPort ?? port,
                )

                const { child: newChild, url: newUrl } =
                  await spawnQuickTunnel(newLocalTarget)
                tunnelUrl = newUrl
                child = newChild
                globalState.child = child

                console.log(
                  `🌐  Quick tunnel updated for port ${actualPort}: ${newUrl}`,
                )

                const updatedConfigHash = JSON.stringify({
                  isQuickMode,
                  hostname,
                  port: actualPort,
                  tunnelName,
                  dnsOption,
                  sslOption,
                })
                globalState.configHash = updatedConfigHash
              }
            } catch (error) {
              console.error(
                `[unplugin-cloudflare-tunnel] ❌ Failed to update quick tunnel for port change: ${(error as Error).message}`,
              )
            }
          })

          server.httpServer?.once('close', () => {
            killCloudflared('SIGTERM')
          })

          return
        } catch (error) {
          console.error(
            `[unplugin-cloudflare-tunnel] ❌ Quick tunnel setup failed: ${(error as Error).message}`,
          )
          throw error
        }
      }

      // Named tunnel mode logic
      console.log('[unplugin-cloudflare-tunnel] Starting named tunnel mode...')

      const apiToken = providedApiToken || process.env.CLOUDFLARE_API_KEY

      if (!apiToken) {
        throw new Error(
          '[unplugin-cloudflare-tunnel] API token is required. ' +
            "Provide it via 'apiToken' option or set the CLOUDFLARE_API_KEY environment variable. " +
            'Get your token at: https://dash.cloudflare.com/profile/api-tokens',
        )
      }

      console.log(
        `[unplugin-cloudflare-tunnel] Using port ${port}${userProvidedPort === port ? ' (user-provided)' : ' (from bundler config)'}`,
      )

      await ensureCloudflaredBinary(bin)

      const accounts = await cf(
        apiToken,
        'GET',
        '/accounts',
        undefined,
        z.array(AccountSchema),
      )
      const accountId = forcedAccount || accounts[0]?.id
      if (!accountId)
        throw new Error('Unable to determine Cloudflare account ID')

      const apexDomain = hostname!.split('.').slice(-2).join('.')
      const parentDomain = hostname!.split('.').slice(1).join('.')
      debugLog('← Apex domain', apexDomain)
      debugLog('← Parent domain', parentDomain)
      let zoneId: string | undefined = forcedZone
      if (!zoneId) {
        let zones: Zone[] = []
        try {
          zones = await cf(
            apiToken,
            'GET',
            `/zones?name=${parentDomain}`,
            undefined,
            z.array(ZoneSchema),
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
            z.array(ZoneSchema),
          )
        }
        zoneId = zones[0]?.id
      }
      if (!zoneId)
        throw new Error(`Zone ${apexDomain} not found in account ${accountId}`)

      const { autoCleanup = true } = cleanupConfig

      const tunnels = await cf(
        apiToken,
        'GET',
        `/accounts/${accountId}/cfd_tunnel?name=${tunnelName}`,
        undefined,
        z.array(TunnelSchema),
      )
      let tunnel = tunnels[0]

      if (!tunnel) {
        console.log(
          `[unplugin-cloudflare-tunnel] Creating tunnel '${tunnelName}'...`,
        )
        tunnel = await cf(
          apiToken,
          'POST',
          `/accounts/${accountId}/cfd_tunnel`,
          {
            name: tunnelName,
            config_src: 'cloudflare',
          },
          TunnelSchema,
        )
      }
      const tunnelId = tunnel.id as string

      if (autoCleanup) {
        console.log(
          `[unplugin-cloudflare-tunnel] 🧹 Running resource cleanup for tunnel '${tunnelName}'...`,
        )

        const dnsCleanup = await cleanupMismatchedDnsRecords(
          apiToken,
          zoneId,
          generateDnsComment(),
          hostname!,
          tunnelId,
        )
        if (dnsCleanup.found.length > 0) {
          console.log(
            `[unplugin-cloudflare-tunnel] 📊 DNS cleanup: ${dnsCleanup.found.length} mismatched, ${dnsCleanup.deleted.length} deleted`,
          )
        }

        const mismatchedSslCerts = await findMismatchedSslCertificates(
          apiToken,
          zoneId,
          tunnelName,
          hostname!,
        )
        if (mismatchedSslCerts.length > 0) {
          for (const cert of mismatchedSslCerts) {
            await cf(
              apiToken,
              'DELETE',
              `/zones/${zoneId}/ssl/certificate_packs/${cert.id}`,
            )
          }
          console.log(
            `[unplugin-cloudflare-tunnel] 📊 SSL cleanup: ${mismatchedSslCerts.length} deleted`,
          )
        }
      } else {
        debugLog('← Cleanup skipped', cleanupConfig)
      }

      const localTarget = getLocalTarget(serverHost, port)
      debugLog('← Connecting to local target', localTarget)

      await cf(
        apiToken,
        'PUT',
        `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
        {
          config: {
            ingress: [
              { hostname: hostname!, service: localTarget },
              { service: 'http_status:404' },
            ],
          },
        },
      )

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
            z.array(DNSRecordSchema),
          )
          if (existingWildcard.length === 0) {
            console.log(
              `[unplugin-cloudflare-tunnel] Creating ${type} record for ${dnsOption}...`,
            )
            await cf(
              apiToken,
              'POST',
              `/zones/${zoneId}/dns_records`,
              {
                type,
                name: dnsOption,
                content,
                proxied: true,
                comment: generateDnsComment(),
              },
              DNSRecordSchema,
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
          z.array(DNSRecordSchema),
        )
        if (existingWildcard.length === 0) {
          const existingDnsRecords = await cf(
            apiToken,
            'GET',
            `/zones/${zoneId}/dns_records?type=CNAME&name=${hostname!}`,
            undefined,
            z.array(DNSRecordSchema),
          )
          const existing = existingDnsRecords.length > 0

          if (!existing) {
            console.log(
              `[unplugin-cloudflare-tunnel] Creating DNS record for ${hostname}...`,
            )
            await cf(
              apiToken,
              'POST',
              `/zones/${zoneId}/dns_records`,
              {
                type: 'CNAME',
                name: hostname!,
                content: `${tunnelId}.cfargotunnel.com`,
                proxied: true,
                comment: generateDnsComment(),
              },
              DNSRecordSchema,
            )
          }
        }
      }

      const token = await cf(
        apiToken,
        'GET',
        `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`,
        undefined,
        z.string(),
      )

      try {
        const certListRaw: any = await cf(
          apiToken,
          'GET',
          `/zones/${zoneId}/ssl/certificate_packs?status=all`,
          undefined,
          z.any(),
        )
        const certPacks: Array<any> = Array.isArray(certListRaw)
          ? certListRaw
          : certListRaw.result || []

        const certContainingHost = (host: string) =>
          certPacks.filter(c =>
            (c.hostnames || c.hosts || []).includes(host),
          )?.[0]
        if (sslOption) {
          const isWildcard = sslOption.startsWith('*.')
          const certNeededHost = sslOption

          const matchingCert = certContainingHost(certNeededHost)

          if (!matchingCert) {
            console.log(
              `[unplugin-cloudflare-tunnel] Requesting ${isWildcard ? 'wildcard ' : ''}certificate for ${certNeededHost}...`,
            )
            const tagHostname = generateSslTagHostname()
            const certificateHosts = [certNeededHost, tagHostname]
            debugLog(`Adding tag hostname to certificate: ${tagHostname}`)

            const newCert: any = await retryWithBackoff(() =>
              cf(
                apiToken,
                'POST',
                `/zones/${zoneId}/ssl/certificate_packs/order`,
                {
                  hosts: certificateHosts,
                  certificate_authority: 'lets_encrypt',
                  type: 'advanced',
                  validation_method: isWildcard ? 'txt' : 'http',
                  validity_days: 90,
                  cloudflare_branding: false,
                },
              ),
            )

            if (newCert?.id) {
              trackSslCertificate(newCert.id, certificateHosts, tunnelName)
            }
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
              z.object({ status: z.string() }),
            )
            debugLog('← Total TLS', totalTls)
            const existingHostnameCert = certContainingHost(hostname!)
            if (totalTls.status !== 'on' && !existingHostnameCert) {
              console.log(
                `[unplugin-cloudflare-tunnel] Requesting edge certificate for ${hostname}...`,
              )
              const tagHostname = generateSslTagHostname()
              const certificateHosts = [hostname!, tagHostname]
              debugLog(`Adding tag hostname to certificate: ${tagHostname}`)

              const newCert: any = await retryWithBackoff(() =>
                cf(
                  apiToken,
                  'POST',
                  `/zones/${zoneId}/ssl/certificate_packs/order`,
                  {
                    hosts: certificateHosts,
                    certificate_authority: 'lets_encrypt',
                    type: 'advanced',
                    validation_method: 'txt',
                    validity_days: 90,
                    cloudflare_branding: false,
                  },
                ),
              )

              if (newCert?.id) {
                trackSslCertificate(newCert.id, certificateHosts, tunnelName)
              }
            } else {
              debugLog(
                '← Edge certificate already exists',
                existingHostnameCert,
              )
            }
          } else {
            debugLog(
              '← Edge certificate (wildcard) already exists',
              wildcardExists,
              wildcardDomain,
            )
          }
        }
      } catch (sslError) {
        console.error(
          `[unplugin-cloudflare-tunnel] ⚠️  SSL management error: ${(sslError as Error).message}`,
        )
        throw sslError
      }

      const cloudflaredArgs = ['tunnel']
      cloudflaredArgs.push('--loglevel', effectiveLogLevel)
      if (logFile) {
        cloudflaredArgs.push('--logfile', logFile)
      }

      debugLog('Spawning cloudflared', bin, cloudflaredArgs)
      cloudflaredArgs.push('run', '--token', token)
      child = spawn(bin, cloudflaredArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        windowsHide: true,
        shell: process.platform === 'win32',
      })
      console.log(
        `[unplugin-cloudflare-tunnel] Process spawned with PID: ${child.pid}`,
      )

      globalState.child = child
      globalState.configHash = newConfigHash

      registerExitHandler()

      let tunnelReady = false
      child.stdout?.on('data', data => {
        const output = data.toString()
        if (!globalState.shuttingDown || debug) {
          console.log(`[cloudflared stdout] ${output.trim()}`)
        }
        if (output.includes('Connection') && output.includes('registered')) {
          if (!tunnelReady) {
            tunnelReady = true
            console.log(`🌐  Cloudflare tunnel started for https://${hostname}`)
          }
        }
      })

      child.stderr?.on('data', data => {
        const error = data.toString().trim()

        if (
          error.includes('Failed to parse ICMP reply') ||
          error.includes('unknow ip version 0')
        ) {
          if (logLevel === 'debug') {
            console.log(`[cloudflared debug] ${error}`)
          }
          return
        }

        if (!globalState.shuttingDown || debug) {
          console.error(`[cloudflared stderr] ${error}`)
        }

        if (
          error.toLowerCase().includes('error') ||
          error.toLowerCase().includes('failed') ||
          error.toLowerCase().includes('fatal')
        ) {
          if (!globalState.shuttingDown || debug) {
            console.error(`[unplugin-cloudflare-tunnel] ⚠️  ${error}`)
          }
        }
      })

      child.on('error', error => {
        console.error(
          `[unplugin-cloudflare-tunnel] ❌ Failed to start tunnel process: ${error.message}`,
        )
        if (error.message.includes('ENOENT')) {
          console.error(
            `[unplugin-cloudflare-tunnel] Hint: cloudflared binary may not be installed correctly`,
          )
        }
      })

      child.on('exit', (code, signal) => {
        if (code !== 0 && code !== null) {
          console.error(
            `[unplugin-cloudflare-tunnel] ❌ Tunnel process exited with code ${code}`,
          )
          if (signal) {
            console.error(
              `[unplugin-cloudflare-tunnel] Process terminated by signal: ${signal}`,
            )
          }
        } else if (code === 0) {
          console.log(
            `[unplugin-cloudflare-tunnel] ✅ Tunnel process exited cleanly`,
          )
        }
      })

      setTimeout(() => {
        if (!tunnelReady) {
          console.log(`🌐  Cloudflare tunnel starting for https://${hostname}`)
        }
      }, 3000)

      server.httpServer?.once('close', () => {
        killCloudflared('SIGTERM')
      })

      server.httpServer?.on('listening', async () => {
        try {
          const { host: actualServerHost, port: actualPort } = normalizeAddress(
            server.httpServer?.address(),
          )

          if (actualPort !== port) {
            console.log(
              `[unplugin-cloudflare-tunnel] ⚠️  Port conflict detected - server is using port ${actualPort} instead of ${port}`,
            )
            console.log(
              `[unplugin-cloudflare-tunnel] 🔄 Updating tunnel configuration...`,
            )

            const newLocalTarget = getLocalTarget(
              actualServerHost,
              actualPort ?? port,
            )

            debugLog('← Updating local target to', newLocalTarget)

            await cf(
              apiToken,
              'PUT',
              `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
              {
                config: {
                  ingress: [
                    { hostname: hostname!, service: newLocalTarget },
                    { service: 'http_status:404' },
                  ],
                },
              },
            )

            console.log(
              `[unplugin-cloudflare-tunnel] ✅ Tunnel configuration updated to use port ${actualPort}`,
            )

            const updatedConfigHash = JSON.stringify({
              hostname,
              port: actualPort,
              tunnelName,
              dnsOption,
              sslOption,
            })
            globalState.configHash = updatedConfigHash
          }
        } catch (error) {
          console.error(
            `[unplugin-cloudflare-tunnel] ❌ Failed to update tunnel for port change: ${(error as Error).message}`,
          )
        }
      })
    } catch (error: any) {
      console.error(
        `[unplugin-cloudflare-tunnel] ❌ Setup failed: ${error.message}`,
      )

      if (error.message.includes('API token')) {
        console.error(
          `[unplugin-cloudflare-tunnel] 💡 Check your API token at: https://dash.cloudflare.com/profile/api-tokens`,
        )
        console.error(
          `[unplugin-cloudflare-tunnel] 💡 Required permissions: Zone:Zone:Read, Zone:DNS:Edit, Account:Cloudflare Tunnel:Edit`,
        )
      } else if (
        error.message.includes('Zone') &&
        error.message.includes('not found')
      ) {
        console.error(
          `[unplugin-cloudflare-tunnel] 💡 Make sure '${hostname}' domain is added to your Cloudflare account`,
        )
      } else if (error.message.includes('cloudflared')) {
        console.error(
          `[unplugin-cloudflare-tunnel] 💡 Try deleting node_modules and reinstalling to get a fresh cloudflared binary`,
        )
      }

      throw error
    }
  }

  // ---------------------------------------------------------------------
  // Return the unplugin factory object
  // ---------------------------------------------------------------------
  return {
    name: 'unplugin-cloudflare-tunnel',
    enforce: 'pre' as const,

    // Virtual module hooks
    resolveId(id) {
      if (id === VIRTUAL_MODULE_ID) {
        return '\0' + VIRTUAL_MODULE_ID
      }
      return
    },

    async load(id) {
      const url = await globalState.tunnelUrl
      if (id === '\0' + VIRTUAL_MODULE_ID) {
        return `export function getTunnelUrl() { return ${JSON.stringify(url || '')}; }`
      }
      return
    },

    // Vite-specific hooks
    vite: {
      config(config) {
        if (!config.server) {
          config.server = {}
        }

        if (isQuickMode) {
          config.server.allowedHosts = ['.trycloudflare.com']
          return
        }

        if (!config.server.allowedHosts) {
          config.server.allowedHosts = [hostname!]
          console.log(
            `[unplugin-cloudflare-tunnel] Configured Vite to allow requests from ${hostname}`,
          )
        } else if (Array.isArray(config.server.allowedHosts)) {
          if (!config.server.allowedHosts.includes(hostname!)) {
            config.server.allowedHosts.push(hostname!)
            console.log(
              `[unplugin-cloudflare-tunnel] Added ${hostname} to allowed hosts`,
            )
          }
        }
      },

      configureServer(server: ViteDevServer) {
        const configuredPromise = configureServer(server)
        globalState.tunnelUrl = configuredPromise
          .then(() => tunnelUrl)
          .catch(() => '')
        return async () => {
          await configuredPromise
        }
      },
    },

    closeBundle() {
      killCloudflared('SIGTERM')
      delete globalState.child
      delete globalState.configHash
      delete globalState.shuttingDown
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Utility functions                                                          */
/* -------------------------------------------------------------------------- */

function normalizeAddress(
  address: string | { address?: string; port?: number } | null | undefined,
): { host: string; port?: number } {
  if (address && typeof address === 'object') {
    return {
      host:
        'address' in address && address.address
          ? (address as any).address
          : 'localhost',
      port:
        'port' in address && typeof (address as any).port === 'number'
          ? (address as any).port
          : undefined,
    }
  }
  return { host: 'localhost' }
}

async function ensureCloudflaredBinary(binPath: string) {
  try {
    await fs.access(binPath)
  } catch {
    console.log('[unplugin-cloudflare-tunnel] Installing cloudflared binary...')
    await install(binPath)
  }
}

function getLocalTarget(host: string, port: number): string {
  const isIpv6 = host.includes(':')
  return `http://${isIpv6 ? `[${host}]` : host}:${port}`
}

export const CloudflareTunnel: UnpluginInstance<
  CloudflareTunnelOptions | undefined,
  false
> = createUnplugin(unpluginFactory)

export default CloudflareTunnel
