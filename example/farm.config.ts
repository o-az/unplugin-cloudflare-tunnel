import { defineConfig } from '@farmfe/core'
// must first build the package
// `bun --filter unplugin-cloudflare-tunnel build`
import CloudflareTunnel from '#unplugin-cloudflare-tunnel/farm'

export default defineConfig({
  server: {
    port: 88_33,
  },
  compilation: {
    input: {
      index: './main.ts',
    },
  },
  plugins: [CloudflareTunnel()],
})
