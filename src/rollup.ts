/**
 * This entry file is for Rollup plugin.
 *
 * @module
 */

import { CloudflareTunnel } from '#index.ts'

/**
 * Rollup plugin
 *
 * @example
 * ```ts
 * // rollup.config.js
 * import CloudflareTunnel from 'unplugin-cloudflare-tunnel/rollup'
 *
 * export default {
 *   plugins: [CloudflareTunnel()],
 * }
 * ```
 */
const rollup = CloudflareTunnel.rollup as typeof CloudflareTunnel.rollup
export default rollup
export { rollup as 'module.exports' }
