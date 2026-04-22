import { CloudflareTunnel as unplugin } from '#index.ts'
import type { CloudflareTunnelOptions } from '#core/options.ts'

export default (options: CloudflareTunnelOptions): any => ({
  name: 'unplugin-cloudflare-tunnel',
  hooks: {
    'astro:config:setup': async (astro: any) => {
      astro.config.vite ||= {}
      astro.config.vite.plugins ||= []
      astro.config.vite.plugins.push(unplugin.vite(options))
    }
  }
})
