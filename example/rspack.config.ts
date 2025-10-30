import rspack from '@rspack/core'
import { defineConfig } from '@rspack/cli'

import CloudflareTunnel from '#unplugin-cloudflare-tunnel/rspack'

export default defineConfig({
  name: 'unplugin-cloudflare-tunnel Rspack example',
  devServer: {
    port: 88_22,
  },
  entry: './main.ts',
  mode: 'development',
  plugins: [
    new rspack.HtmlRspackPlugin({ template: './index.html' }),
    CloudflareTunnel(),
  ],
})
