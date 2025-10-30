import { defineConfig } from 'rolldown'
import CloudflareTunnel from '#unplugin-cloudflare-tunnel/rolldown'

export default defineConfig({
  plugins: [CloudflareTunnel()],
})
