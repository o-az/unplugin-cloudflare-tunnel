# unplugin-cloudflare-tunnel

[![Open on npmx.dev](https://npmx.dev/api/registry/badge/version/unplugin-cloudflare-tunnel)](https://npmx.dev/package/unplugin-cloudflare-tunnel)
[![pkg.pr.new](https://pkg.pr.new/badge/o-az/unplugin-cloudflare-tunnel)](https://pkg.pr.new/~/o-az/unplugin-cloudflare-tunnel)

A plugin that automatically creates and manages Cloudflare tunnels for local development.
Available for:

- [Vite](https://vite.dev),
- [Rspack](https://rspack.rs)
- [Webpack](https://webpack.js.org)
- [Astro](https://astro.build) <sup>soon</sup>
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

### Modes

The plugin supports two modes:

- **Quick mode**: temporary `trycloudflare.com` URL, no Cloudflare credentials required
- **Named mode**: persistent tunnel on your own hostname

Mode selection rules:

- `mode: 'quick'` → always quick mode
- `mode: 'named'` → always named mode, requires `hostname`
- if `mode` is omitted:
  - `hostname` provided → named mode
  - otherwise → quick mode

### Common options

- `mode?: 'quick' | 'named'`
- `protocol?: 'http2' | 'quic'` — defaults to `http2` for better local dev reliability
- `logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'fatal'`
- `port?: number`
- `logFile?: string`
- `debug?: boolean`
- `enabled?: boolean`

### Quick mode example

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import CloudflareTunnel from 'unplugin-cloudflare-tunnel/vite'

export default defineConfig({
  plugins: [
    CloudflareTunnel({
      mode: 'quick',
      protocol: 'http2',
    }),
  ],
})
```

### Named mode example

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import CloudflareTunnel from 'unplugin-cloudflare-tunnel/vite'

export default defineConfig({
  plugins: [
    CloudflareTunnel({
      mode: 'named',
      hostname: 'dev.example.com',
      apiToken: process.env.CLOUDFLARE_API_TOKEN,
      protocol: 'http2',
    }),
  ],
})
```

<details>
<summary>Vite</summary><br>

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import CloudflareTunnel from 'unplugin-cloudflare-tunnel/vite'

export default defineConfig({
  plugins: [
    CloudflareTunnel({
      mode: 'quick',
    }),
  ],
})
```

Example in [./example/vite.config.ts](../example/vite.config.ts): `bun --filter example dev:vite`

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

Example in [./example/rspack.config.ts](../example/rspack.config.ts): `bun --filter example dev:rspack`

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

Example in [./example/webpack.config.ts](../example/webpack.config.ts): `bun --filter example dev:webpack`

<br></details>

## Virtual Module: Access Tunnel URL

> [!NOTE]
> This feature is only available in Vite and Vite-based frameworks (i.e., Astro)

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

### Notes on modes

- Named-only options such as `hostname`, `apiToken`, `accountId`, `zoneId`, `tunnelName`, `dns`, `ssl`, and `cleanup` are only valid in named mode.
- Quick mode ignores Cloudflare account setup entirely and creates an ephemeral tunnel.
- `protocol` applies to both quick and named modes.

### Notes

- The virtual module is only available during development mode
- In production builds, the virtual module will not be available
- The URL is automatically updated if the port changes or tunnel restarts
