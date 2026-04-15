import 'dotenv/config'
import * as NodeHTTP from 'node:http'
import * as NodePath from 'node:path'
import NodeFS from 'node:fs/promises'
import { defineConfig, type Plugin } from 'rollup'

import CloudflareTunnel from '../src/rollup.ts'

const apiToken = process.env.CLOUDFLARE_API_TOKEN
if (!apiToken) throw new Error('CLOUDFLARE_API_TOKEN is not set')

const tunnelDnsName = process.env.CLOUDFLARE_TUNNEL_DNS_NAME
if (!tunnelDnsName) throw new Error('CLOUDFLARE_TUNNEL_DNS_NAME is not set')

export default defineConfig({
  input: './main.mjs',
  output: {
    dir: './dist',
    format: 'esm',
    sourcemap: true,
    entryFileNames: 'main.mjs'
  },
  plugins: [
    serveDist('rollup', 6_421),
    replaceViaTool('rollup'),
    CloudflareTunnel({
      apiToken,
      port: 6_421,
      logLevel: 'fatal',
      tunnelName: 'dev-tunnel',
      ssl: `*.${tunnelDnsName}`,
      hostname: `dev.${tunnelDnsName}`,
      logFile: './logs/cloudflare-tunnel_rollup.log'
    })
  ]
})

function serveDist(tool: string, port: number): Plugin {
  const distDir = NodePath.resolve('dist')
  const sourceHtml = NodePath.resolve('index.html')
  const mimeTypes: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8'
  }
  const isWatch = process.argv.includes('--watch')
  let server: NodeHTTP.Server | undefined

  const syncHtml = async () => {
    await NodeFS.mkdir(distDir, { recursive: true })
    await NodeFS.copyFile(sourceHtml, NodePath.join(distDir, 'index.html'))
  }

  return {
    name: 'serve-dist',
    async buildStart() {
      await syncHtml()

      if (!isWatch || server) return

      server = NodeHTTP.createServer(async (request, response) => {
        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
        const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
        const filePath = NodePath.resolve(distDir, `.${pathname}`)

        if (!filePath.startsWith(distDir)) {
          response.writeHead(403)
          response.end('Forbidden')
          return
        }

        try {
          const file = await NodeFS.readFile(filePath)
          response.writeHead(200, {
            'Content-Type': mimeTypes[NodePath.extname(filePath)] ?? 'application/octet-stream',
            'Cache-Control': 'no-cache'
          })
          response.end(file)
        } catch {
          response.writeHead(404)
          response.end('Not Found')
        }
      })

      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject)
        server!.listen(port, '127.0.0.1', () => resolve())
      })

      console.log(`Server is running at http://localhost:${port} (${tool})`)
    },
    async watchChange(id) {
      if (NodePath.resolve(id) === sourceHtml) {
        await syncHtml()
      }
    }
  }
}

function replaceViaTool(tool: string): Plugin {
  return {
    name: 'replace-via-tool',
    transform(code, id) {
      if (!id.endsWith('/main.mjs') && !id.endsWith('\\main.mjs')) return null

      return {
        code: code.replaceAll('__VIA_TOOL__', JSON.stringify(tool)),
        map: null
      }
    }
  }
}
