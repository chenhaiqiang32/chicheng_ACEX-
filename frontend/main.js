/**
 * 前端 Demo：
 * 1) URL 导入转换：import → 轮询 status → download zip
 * 2) 打开 zip：上传到服务端解压托管 /packages/{id}/
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

async function openAcExZip(zipBytes, label = 'package') {
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
      `转换成功：${zipName}\nfileId=${result.fileId || '-'}\n正在托管打开…`
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
