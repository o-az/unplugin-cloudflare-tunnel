/**
 * This entry file is for Vite plugin.
 *
 * @module
 */

import { CloudflareTunnel } from '#index.ts'

/**
 * Vite plugin
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import CloudflareTunnel from 'unplugin-cloudflare-tunnel/vite'
 *
 * export default defineConfig({
 *   plugins: [CloudflareTunnel()],
 * })
 * ```
 */
const vite = CloudflareTunnel.vite
export default vite
export { vite as 'module.exports' }
