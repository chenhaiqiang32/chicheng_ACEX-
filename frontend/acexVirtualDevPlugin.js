/**
 * 开发态虚拟 ACEX 目录：POST zip → 内存解压 → GET /acex-dev-virtual/{id}/...
 *
 * 故意不用 /acex-virtual/：该前缀会被 acex-sw.js 拦截；
 * Network HTTPS 证书未完全信任时，SW 内 fetch chunk 会失败 → 图元缺失。
 */
import { unzipSync } from 'fflate'

/** @type {Map<string, Map<string, Buffer>>} */
const packages = new Map()
const MAX_PACKAGES = 8

function isSafeZipPath(filePath) {
  if (
    !filePath ||
    filePath.startsWith('/') ||
    filePath.includes('\\') ||
    filePath.includes('\0')
  ) {
    return false
  }
  return filePath.split('/').every(
    (part) =>
      part.length > 0 &&
      part !== '.' &&
      part !== '..' &&
      /^[A-Za-z0-9._-]+$/.test(part)
  )
}

function contentTypeFor(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8'
  if (filePath.endsWith('.json')) return 'application/json'
  if (filePath.endsWith('.js')) return 'text/javascript'
  if (filePath.endsWith('.css')) return 'text/css'
  return 'application/octet-stream'
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function trimPackages() {
  while (packages.size > MAX_PACKAGES) {
    const oldest = packages.keys().next().value
    packages.delete(oldest)
  }
}

export function acexVirtualDevPlugin() {
  return {
    name: 'acex-virtual-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url || '').split('?')[0]

        if (req.method === 'POST' && url === '/__acex_virtual') {
          try {
            const id =
              String(req.headers['x-acex-package-id'] || '').trim() ||
              `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
            if (!/^[A-Za-z0-9._-]+$/.test(id)) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'invalid package id' }))
              return
            }

            const body = await readBody(req)
            if (!body.length) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'empty zip body' }))
              return
            }

            const entries = unzipSync(new Uint8Array(body))
            const files = new Map()
            for (const [filePath, data] of Object.entries(entries)) {
              if (!isSafeZipPath(filePath)) {
                res.statusCode = 400
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify({ error: `unsafe path: ${filePath}` }))
                return
              }
              files.set(filePath, Buffer.from(data))
            }

            if (!files.has('viewer.html') || !files.has('drawing.acex.json')) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(
                JSON.stringify({
                  error: 'not a multi ACEX package (need viewer.html + drawing.acex.json)'
                })
              )
              return
            }

            packages.set(id, files)
            trimPackages()

            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                id,
                files: files.size,
                viewerUrl: `/acex-dev-virtual/${id}/viewer.html`
              })
            )
          } catch (err) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                error: err instanceof Error ? err.message : String(err)
              })
            )
          }
          return
        }

        if (req.method === 'GET' && url.startsWith('/acex-dev-virtual/')) {
          const rest = url.slice('/acex-dev-virtual/'.length)
          const slash = rest.indexOf('/')
          if (slash <= 0) {
            next()
            return
          }
          const id = rest.slice(0, slash)
          const filePath = decodeURIComponent(rest.slice(slash + 1))
          const files = packages.get(id)
          const bytes = files?.get(filePath)
          if (!bytes) {
            next()
            return
          }

          res.statusCode = 200
          res.setHeader('Content-Type', contentTypeFor(filePath))
          res.setHeader(
            'Cache-Control',
            filePath.includes('chunks/')
              ? 'public, max-age=31536000, immutable'
              : 'no-cache'
          )
          // .gz 必须原样字节，禁止 Content-Encoding: gzip
          res.end(bytes)
          return
        }

        next()
      })
    }
  }
}
