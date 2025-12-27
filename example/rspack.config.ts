import 'dotenv/config'
import rspack from '@rspack/core'
import { defineConfig } from '@rspack/cli'

import CloudflareTunnel from '../src/rspack.ts'

const apiToken = process.env.CLOUDFLARE_API_KEY
if (!apiToken) throw new Error('CLOUDFLARE_API_KEY is not set')

export default defineConfig({
  name: 'unplugin-cloudflare-tunnel Rspack example',
  devServer: {
    port: 88_22,
  },
  entry: './main.ts',
  mode: 'development',
  plugins: [
    new rspack.HtmlRspackPlugin({ template: './index.html' }),
    CloudflareTunnel({
      tunnelName: 'rspack-dev-tunnel',
      hostname: 'dev.sauce.wiki',
      ssl: '*.sauce.wiki',
      apiToken,
      port: 88_22,
      logFile: './logs/cloudflare-tunnel_rspack.log',
    }),
  ],
})
