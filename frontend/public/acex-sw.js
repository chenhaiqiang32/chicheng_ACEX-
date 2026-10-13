/**
 * 将前端解压后的 ACEX 包以静态目录方式提供：
 *   /acex-virtual/{id}/viewer.html
 *   /acex-virtual/{id}/drawing.acex.json
 *   /acex-virtual/{id}/chunks/*.gz
 *
 * 优先命中 Cache Storage；未命中则回源（开发态 Vite 中间件可兜底）。
 */
const PREFIX = '/acex-virtual/'

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (!url.pathname.startsWith(PREFIX)) return

  event.respondWith(
    (async () => {
      const cached = await caches.match(event.request, { ignoreSearch: true })
      if (cached) return cached

      const normalized = url.origin + url.pathname.replace(/\/+$/, '')
      const again = await caches.match(normalized)
      if (again) return again

      // 缓存未命中：回源（勿直接 404，否则会挡住 Vite 虚拟目录）
      try {
        return await fetch(event.request)
      } catch {
        return new Response('ACEX package file not found in cache', {
          status: 404,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        })
      }
    })()
  )
})
