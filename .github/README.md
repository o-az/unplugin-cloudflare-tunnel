# unplugin-cloudflare-tunnel

[![NPM version](https://img.shields.io/npm/v/unplugin-cloudflare-tunnel?color=a1b858&label=)](https://npm.im/unplugin-cloudflare-tunnel)
[![pkg.pr.new](https://pkg.pr.new/badge/o-az/unplugin-cloudflare-tunnel)](https://pkg.pr.new/~/o-az/unplugin-cloudflare-tunnel)

A plugin that automatically creates and manages Cloudflare tunnels for local development.
Available for:

- [Vite](https://vite.dev),
- [Astro](https://astro.build) <sup>soon</sup>
- [Rspack](https://rspack.rs) <sup>soon</sup>
- [Webpack](https://webpack.js.org) <sup>soon</sup>
- [Farm](https://farmfe.org) <sup>soon</sup>
- [esbuild](https://esbuild.github.io) <sup>soon</sup>
- [Rollup](https://rollupjs.org) <sup>soon</sup>
- [Rolldown](https://rolldown.rs) <sup>soon</sup>

> [!NOTE]
> This is under active development.
> If you have any suggestions, I'm all ears, please open an issue.

## Install

unplugin-cloudflare-tunnel

```bash
npm add unplugin-cloudflare-tunnel
```

## Usage

<details>
<summary>Vite</summary><br>

```ts
// vite.config.ts
import CloudflareTunnel from 'unplugin-cloudflare-tunnel/vite'

export default defineConfig({
  plugins: [
    CloudflareTunnel(),
  ],
})
```

Example in [./example/vite.config.ts](./example/vite.config.ts): `bun --filter example dev:vite`

<br></details>

<details>
<summary>Astro</summary><br>

```ts
// astro.config.ts
import CloudflareTunnel from 'unplugin-cloudflare-tunnel/astro'

export default defineConfig({
  integrations: [
    CloudflareTunnel(),
  ],
})
```

<br></details>

<details>
<summary>Rspack</summary><br>

```ts
// rspack.config.mjs
import CloudflareTunnel from 'unplugin-cloudflare-tunnel/rspack'

export default {
  /* ... */
  plugins: [
    CloudflareTunnel(),
  ]
}
```

Example in [./example/rspack.config.ts](./example/rspack.config.ts): `bun --filter example dev:rspack`

<br></details>

<details>
<summary>Webpack</summary><br>

```ts
// webpack.config.js
module.exports = {
  /* ... */
  plugins: [
    require('unplugin-cloudflare-tunnel/webpack')({
      CloudflareTunnel(),
  ]
}
```

Example in [./example/webpack.config.ts](./example/webpack.config.ts): `bun --filter example dev:webpack`

<br></details>

<details>
<summary>Rolldown</summary><br>

```ts
// rolldown.config.ts
import CloudflareTunnel from 'unplugin-cloudflare-tunnel/rolldown'

export default defineConfig({
  plugins: [
    CloudflareTunnel(),
  ],
})
```

<br></details>

<details>
<summary>Rollup</summary><br>

```ts
// rollup.config.js
import CloudflareTunnel from 'unplugin-cloudflare-tunnel/rollup'

export default {
  plugins: [
    Caddy({
      options: {
        host: 'localhost',
        domains: ['rollup-example.localhost'],
      }
    }),
  ],
}
```

<br></details>

<details>
<summary>esbuild</summary><br>

```ts
// esbuild.config.js
import { build } from 'esbuild'
import CloudflareTunnel from 'unplugin-cloudflare-tunnel/esbuild'

build({
  plugins: [CloudflareTunnel()]
})
```

<br></details>

<details>
<summary>Farm</summary><br>

```ts
// farm.config.ts
import { defineConfig } from '@farmfe/core'
import CloudflareTunnel from 'unplugin-cloudflare-tunnel/farm'

export default defineConfig({
  plugins: [
    CloudflareTunnel(),
  ]
})
```

Example in [./example/farm.config.ts](./example/farm.config.ts): `bun --filter example dev:farm`

<br></details>

## Virtual Module: Access Tunnel URL

The plugin provides a virtual module that allows you to access the tunnel URL in your application code during development. This is useful for:

- Displaying the tunnel URL in your UI
- Sharing the URL with users
- Debugging and logging
- Building features that need the public URL

### Usage

```typescript
import { getTunnelUrl } from 'virtual:unplugin-cloudflare-tunnel'

// Get the current tunnel URL
const tunnelUrl = getTunnelUrl()
console.log('Public tunnel URL:', tunnelUrl)

// Example: Copy tunnel URL to clipboard
const shareButton = document.getElementById('share')
shareButton.onclick = () => {
  navigator.clipboard.writeText(getTunnelUrl())
  alert('Tunnel URL copied!')
}
```

### TypeScript Support

To get TypeScript support for the virtual module, add a reference to the types:

```typescript
// In your tsconfig.json or a .d.ts file
/// <reference types="unplugin-cloudflare-tunnel/virtual" />
```

Or create a `virtual.d.ts` file in your project:

```typescript
/// <reference types="unplugin-cloudflare-tunnel/virtual" />
```

### Return Value

- **Quick tunnel mode**: Returns a random URL like `https://abc-123.trycloudflare.com`
- **Named tunnel mode**: Returns your custom domain URL like `https://dev.example.com`
- **Plugin disabled**: Returns an empty string `""`

### Notes

- The virtual module is only available during development mode
- In production builds, the virtual module will not be available
- The URL is automatically updated if the port changes or tunnel restarts
