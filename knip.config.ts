import type { KnipConfig } from 'knip'

export default {
  tags: ['@lintignore'],
  project: ['./src/**/*.ts'],
  treatConfigHintsAsErrors: true,
  ignoreDependencies: ['esbuild', 'webpack']
} as const satisfies KnipConfig
