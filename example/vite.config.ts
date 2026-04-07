import { defineConfig, loadEnv } from 'vite'
import CloudflareTunnel from '../src/vite.ts'

export default defineConfig(config => {
  const env = loadEnv(config.mode, process.cwd(), '')

  const apiToken = env.CLOUDFLARE_API_TOKEN
  if (!apiToken) throw new Error('CLOUDFLARE_API_TOKEN is not set')

  const accountId = env.CLOUDFLARE_ACCOUNT_ID
  if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is not set')

  const tunnelDnsName = env.CLOUDFLARE_TUNNEL_DNS_NAME
  if (!tunnelDnsName) throw new Error('CLOUDFLARE_TUNNEL_DNS_NAME is not set')

  return {
    plugins: [
      CloudflareTunnel({
        apiToken,
        logLevel: 'fatal',
        tunnelName: 'dev-tunnel',
        ssl: `*.${tunnelDnsName}`,
        hostname: `dev.${tunnelDnsName}`,
        logFile: './logs/cloudflare-tunnel_vite.log',
      }),
    ],
    server: {
      port: 420_69,
    },
  }
})
