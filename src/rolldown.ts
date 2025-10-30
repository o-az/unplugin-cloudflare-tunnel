/**
 * This entry file is for Rolldown plugin.
 *
 * @module
 */

import { CloudflareTunnel } from './index'

/**
 * Rolldown plugin
 *
 * @example
 * ```ts
 * // rolldown.config.js
 * import CloudflareTunnel from 'unplugin-cloudflare-tunnel/rolldown'
 *
 * export default {
 *   plugins: [CloudflareTunnel()],
 * }
 * ```
 */
const rolldown = CloudflareTunnel.rolldown as typeof CloudflareTunnel.rolldown
export default rolldown
export { rolldown as 'module.exports' }
