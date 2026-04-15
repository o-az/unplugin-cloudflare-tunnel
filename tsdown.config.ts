import { defineConfig } from 'tsdown'

import pkg from '#package.json' with { type: 'json' }

export default defineConfig({
  dts: true,
  clean: true,
  publint: true,
  outDir: 'dist',
  format: ['esm'],
  target: 'esnext',
  entry: ['./src/*.ts'],
  tsconfig: './tsconfig.json',
  attw: {
    enabled: true,
    profile: 'node16',
    ignoreRules: ['false-cjs', 'cjs-resolves-to-esm']
  },
  unused: {
    ignore: {
      peerDependencies: Object.keys(pkg.peerDependencies ?? {})
    }
  }
})
