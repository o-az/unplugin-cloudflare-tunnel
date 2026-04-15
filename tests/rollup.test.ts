import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { rollupBuild } from '@sxzz/test-utils'
import { afterEach, describe, expect, it } from 'vitest'

import CloudflareTunnel from '../src/rollup.ts'

const tempDirs: string[] = []

async function makeTempEntry(contents: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'unplugin-cloudflare-tunnel-'))
  tempDirs.push(dir)
  const entry = path.join(dir, 'entry.js')
  await writeFile(entry, contents)
  return entry
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

describe('rollup', () => {
  it('matches the basic fixture snapshot', async () => {
    const fixture = path.resolve(import.meta.dirname, 'fixtures/basic.js')
    const source = await readFile(fixture, 'utf8')
    const { snapshot } = await rollupBuild(fixture, [CloudflareTunnel()])

    expect({ source, snapshot }).toMatchSnapshot()
  })

  it('resolves the virtual module in normal builds', async () => {
    const entry = await makeTempEntry(
      "import { getTunnelUrl } from 'virtual:unplugin-cloudflare-tunnel'; export const tunnelUrl = getTunnelUrl();"
    )
    const { snapshot } = await rollupBuild(entry, [CloudflareTunnel()])

    expect(snapshot).toContain('const tunnelUrl = getTunnelUrl();')
    expect(snapshot).toContain('function getTunnelUrl() { return ""; }')
    expect(snapshot).not.toContain('virtual:unplugin-cloudflare-tunnel')
  })

  it('returns the stub virtual module when disabled', async () => {
    const entry = await makeTempEntry(
      "import { getTunnelUrl } from 'virtual:unplugin-cloudflare-tunnel'; export default getTunnelUrl();"
    )
    const { snapshot } = await rollupBuild(entry, [CloudflareTunnel({ enabled: false })])

    expect(snapshot).toContain('return "";')
  })
})
