import 'dotenv/config'
import rspack from '@rspack/core'
import { defineConfig } from '@rspack/cli'

import CloudflareTunnel from '../src/rspack.ts'

const apiToken = process.env.CLOUDFLARE_API_TOKEN
if (!apiToken) throw new Error('CLOUDFLARE_API_TOKEN is not set')

const tunnelDnsName = process.env.CLOUDFLARE_TUNNEL_DNS_NAME
if (!tunnelDnsName) throw new Error('CLOUDFLARE_TUNNEL_DNS_NAME is not set')

export default defineConfig({
  name: 'unplugin-cloudflare-tunnel Rspack example',
  devServer: {
    port: 420_69
  },
  entry: './main.mjs',
  mode: 'development',
  plugins: [
    new rspack.DefinePlugin({
      __VIA_TOOL__: JSON.stringify('rspack')
    }),
    new rspack.HtmlRspackPlugin({ template: './index.html' }),
    CloudflareTunnel({
      apiToken,
      logLevel: 'fatal',
      tunnelName: 'dev-tunnel',
      ssl: `*.${tunnelDnsName}`,
      hostname: `dev.${tunnelDnsName}`,
      logFile: './logs/cloudflare-tunnel_rspack.log'
    })
  ]
})
