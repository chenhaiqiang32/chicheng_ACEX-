/**
 * 将前端解压后的 ACEX 包以静态目录方式提供：
 *   /acex-virtual/{id}/viewer.html
 *   /acex-virtual/{id}/drawing.acex.json
 *   /acex-virtual/{id}/chunks/*.gz
 *
 * 文件由页面写入 Cache Storage；此处仅拦截 fetch 并原样返回字节。
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
      // 精确匹配页面 put 进去的 URL
      const cached = await caches.match(event.request, { ignoreSearch: true })
      if (cached) return cached

      // 兼容相对路径解析差异：去掉末尾多余斜杠再试
      const normalized = url.origin + url.pathname.replace(/\/+$/, '')
      const again = await caches.match(normalized)
      if (again) return again

      return new Response('ACEX package file not found in cache', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      })
    })()
  )
})
