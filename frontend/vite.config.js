import { defineConfig } from 'vite'
import mkcert from 'vite-plugin-mkcert'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { acexVirtualDevPlugin } from './acexVirtualDevPlugin.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 局域网 IPv4，写入证书 SAN，否则用 Network 地址访问时 SW 会报 SSL 错误 */
function localIPv4Hosts() {
  const hosts = []
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === 'IPv4' && !net.internal) hosts.push(net.address)
    }
  }
  return hosts
}

/** 本机转换服务（Vite 代理走 loopback，比网卡 IP 更稳） */
// 预览走 /acex-dev-virtual/，避免 SW 拦截导致 Network 图元缺失
const CONVERT_SERVER = 'http://127.0.0.1:8788'
// const CONVERT_SERVER = 'http://121.43.236.150:8788'
export default defineConfig({
  root: __dirname,
  publicDir: 'public',
  plugins: [
    acexVirtualDevPlugin(),
    mkcert({
      // GitHub 在国内常超时，用 coding 镜像拉取 mkcert
      source: 'coding',
      hosts: ['localhost', '127.0.0.1', ...localIPv4Hosts()]
    })
  ],
  server: {
    host: true,
    port: 5173,
    strictPort: false,
    proxy: {
      // 转换可能要数分钟，必须拉长超时，否则会一直卡住像「没反应」
      '/api': {
        target: CONVERT_SERVER,
        changeOrigin: true,
        timeout: 10 * 60 * 1000,
        proxyTimeout: 10 * 60 * 1000
      }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
