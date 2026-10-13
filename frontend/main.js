/**
 * 前端 Demo：
 * 1) URL 导入转换：import → 轮询 status → download zip
 * 2) 打开 zip：浏览器本地解压 + Service Worker 虚拟目录（不落盘 published）
 * 3) 打开 JSON：服务端已解压时，用 drawing.acex.json 地址打开同目录 viewer.html
 */
import { unzipAcExPackageFiles } from './unzipAcEx.js'

const convertForm = document.getElementById('convert-form')
const convertStatus = document.getElementById('convert-status')
const convertBtn = document.getElementById('convert-btn')
const dwgUrl = document.getElementById('dwg-url')
const dwgFilename = document.getElementById('dwg-filename')

const openForm = document.getElementById('open-form')
const openStatus = document.getElementById('open-status')
const openBtn = document.getElementById('open-btn')
const zipInput = document.getElementById('zip-input')
const fileList = document.getElementById('file-list')

const jsonOpenForm = document.getElementById('json-open-form')
const jsonOpenStatus = document.getElementById('json-open-status')
const jsonOpenBtn = document.getElementById('json-open-btn')
const jsonUrlInput = document.getElementById('json-url')

const POLL_MS = 1500

function setStatus(el, text, isError = false) {
  el.textContent = text
  el.classList.toggle('error', isError)
}

function canUseServiceWorker() {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    window.isSecureContext
  )
}

function contentTypeFor(path) {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8'
  if (path.endsWith('.json')) return 'application/json'
  if (path.endsWith('.js')) return 'text/javascript'
  if (path.endsWith('.css')) return 'text/css'
  return 'application/octet-stream'
}

function showFileList(files) {
  fileList.hidden = false
  fileList.innerHTML = files
    .slice(0, 40)
    .map((f) => {
      const size = f.bytes?.byteLength ?? f.size ?? ''
      const sizeText = size === '' ? '' : ` <small>(${size} B)</small>`
      return `<li>${f.path}${sizeText}</li>`
    })
    .join('')
  if (files.length > 40) {
    fileList.innerHTML += `<li>… 共 ${files.length} 个文件</li>`
  }
}

async function ensureServiceWorker() {
  const reg = await navigator.serviceWorker.register('/acex-sw.js', {
    scope: '/'
  })
  await navigator.serviceWorker.ready
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => {
      const onChange = () => {
        navigator.serviceWorker.removeEventListener('controllerchange', onChange)
        resolve()
      }
      navigator.serviceWorker.addEventListener('controllerchange', onChange)
      reg.waiting?.postMessage({ type: 'SKIP_WAITING' })
      setTimeout(resolve, 1500)
    })
  }
  return reg
}

function assertAcExPackage(files) {
  const hasViewer = files.some((f) => f.path === 'viewer.html')
  const hasManifest = files.some((f) => f.path === 'drawing.acex.json')
  if (!hasViewer || !hasManifest) {
    throw new Error(
      '不是有效的 multi ACEX 包（需要 viewer.html 与 drawing.acex.json）'
    )
  }
}

/** 开发态卸载 SW，避免拦截 chunk 导致 Network 预览图元缺失 */
async function disableServiceWorkerInDev() {
  if (!import.meta.env.DEV || !('serviceWorker' in navigator)) return
  const regs = await navigator.serviceWorker.getRegistrations()
  await Promise.all(regs.map((reg) => reg.unregister()))
  if ('caches' in window) {
    const keys = await caches.keys()
    await Promise.all(
      keys.filter((k) => k.startsWith('acex-virtual-')).map((k) => caches.delete(k))
    )
  }
}

/**
 * 开发态：把 zip 交给 Vite 中间件解压托管。
 * 使用 /acex-dev-virtual/（不被 acex-sw.js 拦截），避免 Network HTTPS 下 SW 丢 chunk。
 */
async function openViaDevServer(zipBytes, label = 'package') {
  await disableServiceWorkerInDev()

  setStatus(openStatus, '正在解压…')
  const bytes =
    zipBytes instanceof Uint8Array ? zipBytes : new Uint8Array(zipBytes)
  const files = unzipAcExPackageFiles(bytes)
  assertAcExPackage(files)
  showFileList(files)

  const chunkCount = files.filter((f) => f.path.startsWith('chunks/')).length
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  setStatus(
    openStatus,
    `上传到开发服务器虚拟目录（${files.length} 文件 / ${chunkCount} chunks）…`
  )
  const res = await fetch('/__acex_virtual', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/zip',
      'X-Acex-Package-Id': id
    },
    body: bytes
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(json.error || `虚拟目录上传失败 HTTP ${res.status}`)
  }
  if (json.files != null && json.files !== files.length) {
    throw new Error(
      `虚拟目录文件数不一致：本地 ${files.length}，服务器 ${json.files}`
    )
  }

  const viewerUrl = json.viewerUrl || `/acex-dev-virtual/${id}/viewer.html`
  setStatus(
    openStatus,
    `解压完成（${files.length} 个文件，${chunkCount} chunks，来源：${label}）。正在打开查看器…`
  )
  window.open(viewerUrl, '_blank', 'noopener,noreferrer')
  return viewerUrl
}

/** 浏览器本地解压 + Service Worker 虚拟目录打开（不上传、不写 published） */
async function openViaServiceWorker(zipBytes, label = 'package') {
  setStatus(openStatus, '正在解压…')
  const files = unzipAcExPackageFiles(new Uint8Array(zipBytes))
  assertAcExPackage(files)
  showFileList(files)

  setStatus(openStatus, '注册 Service Worker 并写入缓存…')
  await ensureServiceWorker()

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const cache = await caches.open(`acex-virtual-${id}`)
  const base = `/acex-virtual/${id}/`

  await Promise.all(
    files.map((file) => {
      const url = new URL(base + file.path, location.origin).href
      const headers = {
        'Content-Type': contentTypeFor(file.path),
        'Cache-Control': file.path.includes('chunks/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache'
      }
      return cache.put(
        url,
        new Response(file.bytes.slice().buffer, { headers })
      )
    })
  )

  const viewerUrl = `${base}viewer.html`
  setStatus(
    openStatus,
    `解压完成（${files.length} 个文件，来源：${label}）。正在打开查看器…`
  )
  window.open(viewerUrl, '_blank', 'noopener,noreferrer')
  return viewerUrl
}

async function openAcExZip(zipBytes, label = 'package') {
  // 开发环境优先走 Vite 虚拟目录，避免 Network HTTPS 下 SW 因证书失败导致「打不开」
  if (import.meta.env.DEV) {
    return openViaDevServer(zipBytes, label)
  }
  if (!canUseServiceWorker()) {
    throw new Error(
      '当前环境无法使用 Service Worker（需 https 或 localhost），无法在浏览器内打开 zip'
    )
  }
  return openViaServiceWorker(zipBytes, label)
}

/**
 * 由 drawing.acex.json URL 推导同目录 viewer.html
 * @param {string} manifestHref
 */
function viewerUrlFromManifest(manifestHref) {
  const url = new URL(manifestHref, location.href)
  const path = url.pathname
  if (/drawing\.acex\.json$/i.test(path)) {
    url.pathname = path.replace(/drawing\.acex\.json$/i, 'viewer.html')
  } else if (/\.json$/i.test(path)) {
    url.pathname = path.replace(/[^/]+\.json$/i, 'viewer.html')
  } else {
    const base = path.endsWith('/') ? path : path.replace(/[^/]+$/, '')
    url.pathname = `${base}viewer.html`
  }
  url.search = ''
  url.hash = ''
  return url.href
}

/**
 * 校验并打开服务端托管的 ACEX 包（JSON 地址入口）
 * @param {string} rawUrl
 */
async function openViaManifestUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim()
  if (!trimmed) throw new Error('请填写 drawing.acex.json 地址')

  let manifestUrl
  try {
    manifestUrl = new URL(trimmed, location.href)
  } catch {
    throw new Error('无效的 JSON URL')
  }
  if (!/^https?:$/i.test(manifestUrl.protocol)) {
    throw new Error('仅支持 http/https 的 drawing.acex.json 地址')
  }
  if (!/\.json($|\?)/i.test(manifestUrl.pathname + manifestUrl.search)) {
    throw new Error('地址应指向 drawing.acex.json（或其它 .json 清单）')
  }

  const manifestHref = manifestUrl.href
  setStatus(jsonOpenStatus, `正在校验清单：${manifestHref}`)

  let chunkHint = ''
  try {
    const res = await fetch(manifestHref, { method: 'GET', mode: 'cors' })
    if (!res.ok) {
      throw new Error(`清单不可访问 HTTP ${res.status}`)
    }
    const manifest = await res.json()
    if (!manifest || typeof manifest !== 'object') {
      throw new Error('清单不是有效 JSON 对象')
    }
    if (!manifest.chunks || typeof manifest.chunks !== 'object') {
      throw new Error('不是 ACEX 清单（缺少 chunks）')
    }
    const chunkCount = Object.keys(manifest.chunks).length
    const osnapCount =
      manifest.osnapChunks && typeof manifest.osnapChunks === 'object'
        ? Object.keys(manifest.osnapChunks).length
        : 0
    chunkHint = `chunks=${chunkCount}` + (osnapCount ? `，osnap=${osnapCount}` : '')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // CORS 失败时仍尝试打开同目录 viewer（同源托管时 viewer 内 fetch 不受本页 CORS 限制）
    if (/Failed to fetch|NetworkError|CORS|TypeError/i.test(msg)) {
      setStatus(
        jsonOpenStatus,
        `本页无法预检清单（可能跨域）：${msg}\n仍尝试打开同目录 viewer.html…`
      )
    } else {
      throw err
    }
  }

  const viewerHref = viewerUrlFromManifest(manifestHref)
  try {
    const probe = await fetch(viewerHref, { method: 'HEAD', mode: 'cors' })
    if (probe.status === 404) {
      throw new Error(
        `同目录未找到 viewer.html：${viewerHref}\n请确认服务端已解压完整 multi 包`
      )
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/同目录未找到 viewer\.html/.test(msg)) throw err
    // HEAD 被拒 / CORS：继续打开，由新窗口自行加载
  }

  setStatus(
    jsonOpenStatus,
    `清单就绪${chunkHint ? `（${chunkHint}）` : ''}。\n打开：${viewerHref}`
  )
  window.open(viewerHref, '_blank', 'noopener,noreferrer')
  return viewerHref
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 提交 URL 导入，返回 jobId
 * @returns {Promise<{ jobId: string }>}
 */
async function submitImport(url, filename) {
  const body = { url }
  if (filename) body.filename = filename

  const res = await fetch('/api/models/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(json.message || json.error || `HTTP ${res.status}`)
  }
  const jobId = json.data?.jobId
  if (!jobId) throw new Error('导入接口未返回 jobId')
  return { jobId }
}

/**
 * 轮询直到 ready / failed
 * status === null 表示转换中
 */
async function pollUntilDone(jobId, onProgress) {
  for (;;) {
    const res = await fetch(`/api/models/import/${jobId}/status`)
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(json.message || `status HTTP ${res.status}`)
    }
    const data = json.data || {}
    const status = data.status

    if (status === 'ready') return data
    if (status === 'failed') {
      throw new Error(data.errorMessage || 'conversion failed')
    }

    // status === null → 转换中
    onProgress?.(data)
    await sleep(POLL_MS)
  }
}

async function downloadZip(jobId) {
  const res = await fetch(`/api/models/${jobId}/download?type=zip`)
  if (!res.ok) {
    let msg = `download HTTP ${res.status}`
    try {
      const j = await res.json()
      msg = j.message || msg
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }

  const zipBuf = await res.arrayBuffer()
  const zipName =
    (
      res.headers.get('Content-Disposition') || ''
    ).match(/filename\*?=(?:UTF-8''|")?([^";]+)/i)?.[1] || `${jobId}.zip`

  return { zipBuf, zipName: decodeURIComponent(zipName) }
}

function triggerDownload(zipBuf, zipName) {
  const blob = new Blob([zipBuf], { type: 'application/zip' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = zipName
  a.click()
  URL.revokeObjectURL(a.href)
}

// 开发态尽早清掉旧 SW，防止 Network 地址下 chunk 被 SW 吃掉
void disableServiceWorkerInDev()

convertForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const url = dwgUrl.value.trim()
  if (!url) return
  const filename = dwgFilename.value.trim() || undefined

  convertBtn.disabled = true
  setStatus(convertStatus, `正在提交导入：${filename || url}…`)

  try {
    const { jobId } = await submitImport(url, filename)
    setStatus(
      convertStatus,
      `已受理 jobId=${jobId}\n正在轮询转换状态（转换中 status=null）…`
    )

    const started = Date.now()
    const result = await pollUntilDone(jobId, () => {
      const sec = Math.round((Date.now() - started) / 1000)
      setStatus(
        convertStatus,
        `jobId=${jobId}\n转换中（status=null）… 已等待 ${sec}s`
      )
    })

    setStatus(
      convertStatus,
      `转换成功（ready）。fileId=${result.fileId || '-'}\n正在下载 zip…`
    )

    const { zipBuf, zipName } = await downloadZip(jobId)
    triggerDownload(zipBuf, zipName)

    setStatus(
      convertStatus,
      `转换成功：${zipName}\nfileId=${result.fileId || '-'}\n正在本地打开…`
    )
    await openAcExZip(zipBuf, zipName)
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    const msg =
      raw === 'Failed to fetch' || /NetworkError|ECONNREFUSED|proxy/i.test(raw)
        ? `无法连接转换服务，请确认远程代理目标可达：${raw}`
        : raw
    setStatus(convertStatus, msg, true)
  } finally {
    convertBtn.disabled = false
  }
})

openForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const file = zipInput.files?.[0]
  if (!file) return

  openBtn.disabled = true
  try {
    const buf = await file.arrayBuffer()
    await openAcExZip(buf, file.name)
  } catch (err) {
    setStatus(openStatus, err instanceof Error ? err.message : String(err), true)
  } finally {
    openBtn.disabled = false
  }
})

jsonOpenForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const url = jsonUrlInput.value.trim()
  if (!url) return

  jsonOpenBtn.disabled = true
  try {
    await openViaManifestUrl(url)
  } catch (err) {
    setStatus(
      jsonOpenStatus,
      err instanceof Error ? err.message : String(err),
      true
    )
  } finally {
    jsonOpenBtn.disabled = false
  }
})
