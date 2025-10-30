import { defineConfig } from 'rollup'
import CloudflareTunnel from '#unplugin-cloudflare-tunnel/rollup'

export default defineConfig({
  plugins: [CloudflareTunnel()],
})
