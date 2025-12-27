import { defineConfig } from 'rollup'
import CloudflareTunnel from '#unplugin-cloudflare-tunnel/rollup'

const apiToken = process.env.CLOUDFLARE_API_KEY
if (!apiToken) throw new Error('CLOUDFLARE_API_KEY is not set')

export default defineConfig({
  plugins: [
    CloudflareTunnel({
      tunnelName: 'rollup-dev-tunnel',
      hostname: 'dev.sauce.wiki',
      ssl: '*.sauce.wiki',
      apiToken,
      logLevel: 'debug',
      logFile: './logs/cloudflare-tunnel_rollup.log',
    }),
  ],
})
