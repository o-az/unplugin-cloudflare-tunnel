import { build } from 'esbuild'
import CloudflareTunnel from '#unplugin-cloudflare-tunnel/esbuild'

build({
  plugins: [CloudflareTunnel()],
})
