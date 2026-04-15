import 'dotenv/config'
import { context } from 'esbuild'

import CloudflareTunnel from '../src/esbuild.ts'

const apiToken = process.env.CLOUDFLARE_API_TOKEN
if (!apiToken) throw new Error('CLOUDFLARE_API_TOKEN is not set')

const tunnelDnsName = process.env.CLOUDFLARE_TUNNEL_DNS_NAME
if (!tunnelDnsName) throw new Error('CLOUDFLARE_TUNNEL_DNS_NAME is not set')

const buildContext = await context({
  bundle: true,
  format: 'esm',
  sourcemap: true,
  outdir: './dist',
  allowOverwrite: true,
  outExtension: { '.js': '.mjs' },
  loader: { '.html': 'copy', '.mjs': 'js' },
  entryPoints: ['./index.html', './main.mjs'],
  define: {
    __VIA_TOOL__: JSON.stringify('esbuild')
  },
  plugins: [
    CloudflareTunnel({
      apiToken,
      port: 6_420,
      logLevel: 'fatal',
      tunnelName: 'dev-tunnel',
      ssl: `*.${tunnelDnsName}`,
      hostname: `dev.${tunnelDnsName}`,
      logFile: './logs/cloudflare-tunnel_esbuild.log'
    })
  ]
})

await buildContext.watch()
const serveResult = await buildContext.serve({
  port: 6_420,
  servedir: './dist'
})

console.log(`Server is running at http://localhost:${serveResult.port}`)
