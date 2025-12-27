#!/usr/bin/env bun

import * as Bun from 'bun'
import NodeUtil from 'node:util'
import NodeProcess from 'node:process'
import pkgJson from '#package.json' with { type: 'json' }

const { values, positionals: _ } = NodeUtil.parseArgs({
  args: Bun.argv.slice(2),
  tokens: true,
  strict: true,
  allowNegative: true,
  allowPositionals: true,
  options: {
    'dry-run': {
      type: 'boolean',
      default: false,
      multiple: false,
    },
    registry: {
      type: 'string',
      multiple: true,
      default: ['https://registry.npmjs.org'],
    },
    'npm-token': {
      type: 'string',
      multiple: false,
    },
  },
})

const NPM_TOKEN =
  values['npm-token'] ||
  Bun.env.NPM_TOKEN ||
  Bun.env.NODE_AUTH_TOKEN ||
  Bun.env.NPM_CONFIG_TOKEN

if (!NPM_TOKEN) {
  console.warn('NPM_TOKEN is not set')
  NodeProcess.exit(1)
}

async function build() {
  const { stderr, stdout, exitCode } = await Bun.$ /* sh */`bun run build`.env({
    ...Bun.env,
    NODE_ENV: 'production',
    NODE_AUTH_TOKEN: NPM_TOKEN,
    NPM_CONFIG_TOKEN: NPM_TOKEN,
  })

  if (exitCode !== 0) {
    console.error(`Non-zero exit code: ${exitCode}`, stderr.toString())
    NodeProcess.exit(1)
  }

  console.info(stdout.toString())
  console.info('Build completed')
}

async function pack() {
  const { stderr, stdout, exitCode } = await Bun.$ /* sh */`bun pm pack`.env({
    ...Bun.env,
    NODE_ENV: 'production',
    NODE_AUTH_TOKEN: NPM_TOKEN,
    NPM_CONFIG_TOKEN: NPM_TOKEN,
  })

  if (exitCode !== 0) {
    console.error(`Non-zero exit code: ${exitCode}`, stderr.toString())
    NodeProcess.exit(1)
  }

  console.info(stdout.toString())
  console.info('Pack completed')
}

async function publish(registry: string) {
  console.info(`\n\nPublishing to registry: ${registry}\n\n`)

  const packedFile = `./${pkgJson.name}-${pkgJson.version}.tgz`

  const isPrerelease =
    pkgJson.version.includes('alpha') ||
    pkgJson.version.includes('beta') ||
    pkgJson.version.includes('rc')

  const { stderr, stdout, exitCode } = await Bun.$ /* sh */`
    npm publish ${packedFile} \
      --access="public" \
      --verbose \
      --no-git-checks \
      --registry="${registry}" \
      ${Bun.env.PROVENANCE === 'true' ? '--provenance' : ''} \
      ${values['dry-run'] ? '--dry-run' : ''} \
      ${isPrerelease ? '--tag=next' : ''}`
    .env({
      ...Bun.env,
      NODE_ENV: 'production',
      NODE_AUTH_TOKEN: NPM_TOKEN,
      NPM_CONFIG_TOKEN: NPM_TOKEN,
      NPM_TOKEN,
    })
    .nothrow()

  if (exitCode !== 0) {
    console.error(`Non-zero exit code: ${exitCode}`, stderr.toString())
    NodeProcess.exit(1)
  }

  console.info(stdout.toString())
  console.info('Published successfully')
}

build()
  .then(() => pack())
  .then(async () => {
    for (const registry of values.registry) await publish(registry)
  })
  .catch(error => {
    console.error(error)
    if (error instanceof Error) {
      console.info(error.stack)
      console.info(error.message)
      console.info(error.name)
      console.info(error.cause)
    }

    NodeProcess.exit(1)
  })
