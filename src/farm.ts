/**
 * This entry file is for Farm plugin.
 *
 * @module
 */

import { CloudflareTunnel } from './index'

/**
 * Farm plugin
 *
 * @example
 * ```ts
 * // farm.config.js
 * import CloudflareTunnel from 'unplugin-cloudflare-tunnel/farm'
 *
 * export default {
 *   plugins: [CloudflareTunnel()],
 * }
 * ```
 */
const farm = CloudflareTunnel.farm as typeof CloudflareTunnel.farm
export default farm
export { farm as 'module.exports' }
