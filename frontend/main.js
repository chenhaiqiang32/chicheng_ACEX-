/**
 * 前端打开 ACEX zip：
 * - 局域网 HTTP 无 Service Worker → 上传到服务端解压托管 /packages/{id}/
 * - localhost 安全上下文 → 仍可用 SW 虚拟目录（可选）
 */
import { unzipAcExPackageFiles } from './unzipAcEx.js'

const convertForm = document.getElementById('convert-form')
const convertStatus = document.getElementById('convert-status')
const convertBtn = document.getElementById('convert-btn')
const dwgInput = document.getElementById('dwg-input')

const openForm = document.getElementById('open-form')
const openStatus = document.getElementById('open-status')
const openBtn = document.getElementById('open-btn')
const zipInput = document.getElementById('zip-input')
const fileList = document.getElementById('file-list')

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
      // 兜底：已控制或超时
      setTimeout(resolve, 1500)
    })
  }
  return reg
}

/** 上传 zip → 服务端解压 → /packages/{id}/viewer.html（局域网可用） */
async function openViaServerPublish(zipBytes, label = 'package') {
  setStatus(openStatus, '正在上传到服务端并解压托管…')
  const body = new FormData()
  body.append(
    'file',
    new Blob([zipBytes], { type: 'application/zip' }),
    label.endsWith('.zip') ? label : `${label}.zip`
  )

  const res = await fetch('/api/publish-zip', { method: 'POST', body })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`)
  }

  if (Array.isArray(data.files)) {
    showFileList(data.files.map((path) => ({ path })))
  }

  const viewerUrl = data.packageUrl
  const shareUrl = new URL(viewerUrl, location.origin).href
  setStatus(
    openStatus,
    `已托管（${data.fileCount ?? '?'} 个文件）。局域网可分享：\n${shareUrl}`
  )
  window.open(viewerUrl, '_blank', 'noopener,noreferrer')
  return viewerUrl
}

/** localhost：SW 虚拟目录打开 */
async function openViaServiceWorker(zipBytes, label = 'package') {
  setStatus(openStatus, '正在解压…')
  const files = unzipAcExPackageFiles(new Uint8Array(zipBytes))
  const hasViewer = files.some((f) => f.path === 'viewer.html')
  const hasManifest = files.some((f) => f.path === 'drawing.acex.json')
  if (!hasViewer || !hasManifest) {
    throw new Error(
      '不是有效的 multi ACEX 包（需要 viewer.html 与 drawing.acex.json）'
    )
  }
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

/**
 * 优先服务端托管（局域网可分享）；仅在明确可用 SW 且失败时再回退。
 * 默认走服务端，保证 http://192.168.x.x 可访问。
 */
async function openAcExZip(zipBytes, label = 'package') {
  // 局域网场景：始终服务端托管，他人可直接打开同一 URL
  try {
    return await openViaServerPublish(zipBytes, label)
  } catch (serverErr) {
    if (!canUseServiceWorker()) {
      throw serverErr
    }
    setStatus(
      openStatus,
      `服务端托管失败，尝试本地 Service Worker：${serverErr.message}`
    )
    return openViaServiceWorker(zipBytes, label)
  }
}

convertForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const file = dwgInput.files?.[0]
  if (!file) return

  convertBtn.disabled = true
  setStatus(convertStatus, `正在上传并转换：${file.name}（可能需要数十秒）…`)

  try {
    const body = new FormData()
    body.append('file', file, file.name)

    // publish=1：转换同时解压到 /packages，返回可分享链接
    const res = await fetch('/api/convert?publish=1', {
      method: 'POST',
      body,
      headers: { Accept: 'application/zip' }
    })

    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try {
        const j = await res.json()
        msg = j.error || msg
      } catch {
        /* ignore */
      }
      throw new Error(msg)
    }

    const packageUrl = res.headers.get('X-Package-Url')
    const zipBuf = await res.arrayBuffer()
    const zipName =
      (
        res.headers.get('Content-Disposition') || ''
      ).match(/filename\*?=(?:UTF-8''|")?([^";]+)/i)?.[1] ||
      file.name.replace(/\.(dwg|dxf)$/i, '') + '.zip'

    const blob = new Blob([zipBuf], { type: 'application/zip' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = decodeURIComponent(zipName)
    a.click()
    URL.revokeObjectURL(a.href)

    if (packageUrl) {
      const shareUrl = new URL(packageUrl, location.origin).href
      setStatus(
        convertStatus,
        `转换成功。ZIP 已下载。\n局域网分享链接：\n${shareUrl}`
      )
      window.open(packageUrl, '_blank', 'noopener,noreferrer')
    } else {
      setStatus(
        convertStatus,
        `转换成功：${decodeURIComponent(zipName)}。正在托管打开…`
      )
      await openAcExZip(zipBuf, decodeURIComponent(zipName))
    }
  } catch (err) {
    setStatus(
      convertStatus,
      err instanceof Error ? err.message : String(err),
      true
    )
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
