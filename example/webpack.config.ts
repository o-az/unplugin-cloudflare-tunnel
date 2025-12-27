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
  dotenv: true,
  entry: './main.ts',
  mode: 'development',
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: {
          loader: 'ts-loader',
          options: {
            onlyCompileBundledFiles: true,
          },
        },
        exclude: /node_modules/,
      },
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './index.html',
    }),
    CloudflareTunnel({
      tunnelName: 'dev-tunnel',
      hostname: 'dev.sauce.wiki',
      ssl: '*.sauce.wiki',
      apiToken,
      logLevel: 'fatal',
      logFile: './logs/cloudflare-tunnel_webpack.log',
    }),
  ],
} satisfies webpack.Configuration
