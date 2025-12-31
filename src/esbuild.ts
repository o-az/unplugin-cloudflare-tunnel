/**
 * This entry file is for esbuild plugin.
 *
 * @module
 */

import { CloudflareTunnel } from '#index.ts'

/**
 * Esbuild plugin
 *
 * @example
 * ```ts
 * import { build } from 'esbuild'
 * import CloudflareTunnel from 'unplugin-cloudflare-tunnel/esbuild'
 * 
 * build({ plugins: [Starter()] })
```
 */
const esbuild = CloudflareTunnel.esbuild
export default esbuild
export { esbuild as 'module.exports' }
