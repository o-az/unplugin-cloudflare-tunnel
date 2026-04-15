import 'dotenv/config'
import 'webpack-dev-server'
import webpack from 'webpack'
import HtmlWebpackPlugin from 'html-webpack-plugin'

import CloudflareTunnel from '../src/webpack.ts'

const apiToken = process.env.CLOUDFLARE_API_TOKEN
if (!apiToken) throw new Error('CLOUDFLARE_API_TOKEN is not set')

const tunnelDnsName = process.env.CLOUDFLARE_TUNNEL_DNS_NAME
if (!tunnelDnsName) throw new Error('CLOUDFLARE_TUNNEL_DNS_NAME is not set')

const cloudflareTunnelPlugin = CloudflareTunnel({
  apiToken,
  logLevel: 'fatal',
  tunnelName: 'dev-tunnel',
  ssl: `*.${tunnelDnsName}`,
  hostname: `dev.${tunnelDnsName}`,
  logFile: './logs/cloudflare-tunnel_webpack.log'
}) as unknown as webpack.WebpackPluginInstance

export default {
  name: 'unplugin-cloudflare-tunnel Webpack example',
  devServer: {
    port: 88_11
  },
  dotenv: true,
  entry: './main.mjs',
  mode: 'development',
  resolve: {
    extensions: ['.ts', '.js', '.mjs']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: {
          loader: 'ts-loader',
          options: {
            onlyCompileBundledFiles: true
          }
        },
        exclude: /node_modules/
      }
    ]
  },
  plugins: [
    new webpack.DefinePlugin({
      __VIA_TOOL__: JSON.stringify('webpack')
    }),
    new HtmlWebpackPlugin({
      template: './index.html'
    }),
    cloudflareTunnelPlugin
  ]
} satisfies webpack.Configuration
