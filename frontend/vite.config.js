import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 已迁移的 ACEX 转换服务 */
const CONVERT_SERVER = 'http://192.168.5.90:8787'

export default defineConfig({
  root: __dirname,
  publicDir: 'public',
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
      },
      '/packages': {
        target: CONVERT_SERVER,
        changeOrigin: true,
        timeout: 60 * 1000,
        proxyTimeout: 60 * 1000
      }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
