import * as z from 'zod/mini'
import NodeFS from 'node:fs/promises'
import { install } from 'cloudflared'

export const CloudflareErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
})

export const CloudflareApiResponseSchema = z.object({
  success: z.boolean(),
  errors: z.optional(z.array(CloudflareErrorSchema)),
  messages: z.optional(z.array(z.string())),
  result: z.unknown(),
})

export const AccountSchema = z.object({
  id: z.string(),
  name: z.string(),
})

export const ZoneSchema = z.object({
  id: z.string(),
  name: z.string(),
})

export const TunnelSchema = z.object({
  id: z.string(),
  name: z.string(),
  account_tag: z.string(),
  created_at: z.string(),
  connections: z.optional(z.array(z.unknown())),
})

export const DNSRecordSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  content: z.string(),
  proxied: z.boolean(),
  comment: z.nullish(z.string()),
})

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
