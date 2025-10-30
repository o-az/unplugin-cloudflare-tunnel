import { defineConfig } from 'tsdown'
import pkg from '#package.json' with { type: 'json' }

export default defineConfig({
  dts: true,
  clean: true,
  format: 'esm',
  outDir: 'dist',
  target: 'esnext',
  entry: ['./src/*.ts'],
  tsconfig: './tsconfig.json',
  unused: {
    ignore: {
      peerDependencies: Object.keys(pkg.peerDependencies ?? {}),
    },
  },
})
