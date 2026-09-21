import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: __dirname,
  publicDir: 'public',
  server: {
    host: true,
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': 'http://localhost:8787',
      '/packages': 'http://localhost:8787'
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
