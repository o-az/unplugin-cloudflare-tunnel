import { defineConfig } from 'vite'
import CloudflareTunnel from '#unplugin-cloudflare-tunnel/vite'

export default defineConfig({
  plugins: [CloudflareTunnel()],
  server: {
    port: 5176,
  },
})
