/**
 * This entry file is for Rspack plugin.
 *
 * @module
 */

import { CloudflareTunnel } from './index'

/**
 * Rspack plugin
 *
 * @example
 * ```js
 * // rspack.config.js
 * import CloudflareTunnel from 'unplugin-cloudflare-tunnel/rspack'
 *
 * export default {
 *   plugins: [CloudflareTunnel()],
 * }
 * ```
 */
const rspack = CloudflareTunnel.rspack as typeof CloudflareTunnel.rspack
export default rspack
export { rspack as 'module.exports' }
