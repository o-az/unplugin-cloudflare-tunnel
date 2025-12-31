/**
 * This entry file is for webpack plugin.
 *
 * @module
 */

import { CloudflareTunnel } from '#index.ts'

/**
 * Webpack plugin
 *
 * @example
 * ```js
 * // webpack.config.js
 * import CloudflareTunnel from 'unplugin-cloudflare-tunnel/webpack'
 *
 * export default {
 *   plugins: [CloudflareTunnel()],
 * }
 * ```
 */
const webpack = CloudflareTunnel.webpack
export default webpack
export { webpack as 'module.exports' }
