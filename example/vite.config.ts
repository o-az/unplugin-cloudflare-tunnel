import { defineConfig, loadEnv } from 'vite'
import CloudflareTunnel from '#unplugin-cloudflare-tunnel/vite'

export default defineConfig(config => {
  const env = loadEnv(config.mode, process.cwd(), '')

  const apiToken = env.CLOUDFLARE_API_KEY
  if (!apiToken) throw new Error('CLOUDFLARE_API_KEY is not set')

  const accountId = env.CLOUDFLARE_ACCOUNT_ID
  if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is not set')

  return {
    plugins: [
      CloudflareTunnel({
        tunnelName: 'dev-tunnel',
        hostname: 'dev.sauce.wiki',
        ssl: '*.sauce.wiki',
        apiToken,
        logLevel: 'fatal',
        logFile: './logs/cloudflare-tunnel_vite.log',
      }),
    ],
    server: {
      port: 420_69,
    },
  }
})
