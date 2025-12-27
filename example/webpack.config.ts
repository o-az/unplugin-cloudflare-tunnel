import 'dotenv/config'
import 'webpack-dev-server'
import type webpack from 'webpack'
import HtmlWebpackPlugin from 'html-webpack-plugin'

import CloudflareTunnel from '../src/webpack.ts'

const apiToken = process.env.CLOUDFLARE_API_KEY
if (!apiToken) throw new Error('CLOUDFLARE_API_KEY is not set')

export default {
  name: 'unplugin-cloudflare-tunnel Webpack example',
  devServer: {
    port: 88_11,
  },
  entry: './main.ts',
  mode: 'development',
  plugins: [
    new HtmlWebpackPlugin({
      template: './index.html',
    }),
    CloudflareTunnel({
      apiToken,
      hostname: 'dev.sauce.wiki',
      ssl: '*.sauce.wiki',
      logFile: './logs/cloudflare-tunnel_webpack.log',
    }),
  ],
} satisfies webpack.Configuration
