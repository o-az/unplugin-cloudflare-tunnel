import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'

import CloudflareTunnel from '../src/esbuild.ts'

const tempDirs: string[] = []

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'unplugin-cloudflare-tunnel-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe('esbuild', () => {
  it('resolves the virtual module in normal builds', async () => {
    const dir = await makeTempDir()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await build({
      absWorkingDir: dir,
      bundle: true,
      format: 'esm',
      write: false,
      stdin: {
        contents:
          "import { getTunnelUrl } from 'virtual:unplugin-cloudflare-tunnel'; export const tunnelUrl = getTunnelUrl();",
        resolveDir: dir,
        sourcefile: 'entry.js'
      },
      plugins: [CloudflareTunnel()]
    })

    const code = result.outputFiles[0]?.text ?? ''
    expect(code).toContain('var tunnelUrl = getTunnelUrl();')
    expect(code).toContain('function getTunnelUrl()')

    logSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('returns the stub virtual module when disabled', async () => {
    const dir = await makeTempDir()
    const result = await build({
      absWorkingDir: dir,
      bundle: true,
      format: 'esm',
      write: false,
      stdin: {
        contents:
          "import { getTunnelUrl } from 'virtual:unplugin-cloudflare-tunnel'; console.log(getTunnelUrl())",
        resolveDir: dir,
        sourcefile: 'entry.js'
      },
      plugins: [CloudflareTunnel({ enabled: false })]
    })

    const code = result.outputFiles[0]?.text ?? ''
    expect(code).toContain('return "";')
  })
})
