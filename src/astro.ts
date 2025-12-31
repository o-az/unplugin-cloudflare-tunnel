import unplugin, { type CloudflareTunnelOptions } from '#index.ts'

export default (options: CloudflareTunnelOptions): any => ({
  name: 'unplugin-cloudflare-tunnel',
  hooks: {
    'astro:config:setup': async (astro: any) => {
      astro.config.vite.plugins ||= []
      astro.config.vite.plugins.push(unplugin.vite(options))
    },
  },
})
