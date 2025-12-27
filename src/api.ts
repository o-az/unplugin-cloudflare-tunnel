import { z } from 'zod'
import NodeFS from 'node:fs/promises'
import { install } from 'cloudflared'

// Zod schemas for Cloudflare API responses
export const CloudflareErrorSchema: z.ZodType<{
  code: number
  message: string
}> = z.object({
  code: z.number(),
  message: z.string(),
})

export const CloudflareApiResponseSchema: z.ZodType<{
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

export const AccountSchema: z.ZodType<{
  id: string
  name: string
}> = z.object({
  id: z.string(),
  name: z.string(),
})

export const ZoneSchema: z.ZodType<{
  id: string
  name: string
}> = z.object({
  id: z.string(),
  name: z.string(),
})

export const TunnelSchema: z.ZodType<{
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

export const DNSRecordSchema: z.ZodType<{
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

/* -------------------------------------------------------------------------- */
/* Utility functions                                                          */
/* -------------------------------------------------------------------------- */

export function normalizeAddress(
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

export async function ensureCloudflaredBinary(binPath: string) {
  try {
    await NodeFS.access(binPath)
  } catch {
    console.log('[unplugin-cloudflare-tunnel] Installing cloudflared binary...')
    await install(binPath)
  }
}

export function getLocalTarget(host: string, port: number): string {
  const isIpv6 = host.includes(':')
  return `http://${isIpv6 ? `[${host}]` : host}:${port}`
}
