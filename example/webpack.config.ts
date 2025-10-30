import 'webpack-dev-server'
import type webpack from 'webpack'
import HtmlWebpackPlugin from 'html-webpack-plugin'

import CloudflareTunnel from '#unplugin-cloudflare-tunnel/webpack'

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
    CloudflareTunnel(),
  ],
} satisfies webpack.Configuration
