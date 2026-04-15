import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import webpack from 'webpack'
import { afterEach, describe, expect, it, vi } from 'vitest'

import CloudflareTunnel from '../src/webpack.ts'

const tempDirs: string[] = []

async function makeFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'unplugin-cloudflare-tunnel-'))
  tempDirs.push(dir)

  await writeFile(
    path.join(dir, 'entry.js'),
    "import { getTunnelUrl } from 'virtual:unplugin-cloudflare-tunnel'; console.log(getTunnelUrl());"
  )

  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe('webpack', () => {
  it('resolves the virtual module without hitting UnhandledSchemeError', async () => {
    const context = await makeFixture()
    const outputPath = path.join(context, 'dist')
    const emitWarningSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})

    const config: webpack.Configuration = {
      context: process.cwd(),
      mode: 'development',
      target: 'web',
      entry: path.join(context, 'entry.js'),
      output: {
        path: outputPath,
        filename: 'main.js'
      },
      plugins: [CloudflareTunnel() as unknown as webpack.WebpackPluginInstance]
    }

    const stats = await new Promise<webpack.Stats>((resolve, reject) => {
      const compiler = webpack(config)
      compiler.run((error, result) => {
        compiler.close(closeError => {
          if (error || closeError) reject(error ?? closeError)
          else if (!result) reject(new Error('Webpack did not return stats'))
          else resolve(result)
        })
      })
    })

    const info = stats.toJson({ all: false, errors: true })
    expect(info.errors).toEqual([])

    const bundle = await readFile(path.join(outputPath, 'main.js'), 'utf8')
    expect(bundle).toContain('function getTunnelUrl()')
    expect(bundle).not.toContain('UnhandledSchemeError')

    emitWarningSpy.mockRestore()
  })
})
