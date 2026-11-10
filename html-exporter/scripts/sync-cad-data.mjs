/**
 * 确保 `cad-data/` 存在（fonts / templates）。
 *
 * 优先级：
 * 1. 已有 fonts/fonts.json → 跳过
 * 2. 同级已知目录拷贝（cad-viewer-nextjs-demo / fuwu）
 * 3. jsDelivr CDN 下载
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const destRoot = resolve(root, 'cad-data')
const marker = join(destRoot, 'fonts', 'fonts.json')
const CDN = 'https://cdn.jsdelivr.net/gh/mlightcad/cad-data@main'

const SIBLING_CANDIDATES = [
  resolve(root, '..', '..', 'cad-viewer-nextjs-demo', 'cad-data'),
  resolve(root, '..', '..', '..', 'acex试用', 'fuwu', 'cad-data'),
  resolve(root, '..', 'cad-data')
]

const EXTRA_PATHS = ['templates/acad.dxf', 'templates/acadiso.dxf']

function alreadyPresent() {
  return existsSync(marker)
}

function log(msg) {
  console.log(`[sync-cad-data] ${msg}`)
}

function destFor(relPath) {
  const normalized = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized || normalized.includes('..')) {
    throw new Error(`Unsafe cad-data path: ${relPath}`)
  }
  const dest = resolve(destRoot, normalized)
  if (dest !== destRoot && !dest.startsWith(destRoot + sep)) {
    throw new Error(`Path escape: ${relPath}`)
  }
  return dest
}

function cdnUrl(relPath) {
  const encoded = relPath
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')
  return `${CDN}/${encoded}`
}

function tryCopySibling() {
  for (const src of SIBLING_CANDIDATES) {
    const srcMarker = join(src, 'fonts', 'fonts.json')
    if (!existsSync(srcMarker)) continue
    log(`copying from ${src}`)
    mkdirSync(destRoot, { recursive: true })
    cpSync(src, destRoot, { recursive: true, force: true })
    if (alreadyPresent()) {
      log('copied sibling cad-data')
      return true
    }
  }
  return false
}

async function download(relPath) {
  const url = cdnUrl(relPath)
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const dest = destFor(relPath)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, buf)
  log(`fetched ${relPath} (${buf.length} bytes)`)
}

async function mapPool(items, concurrency, worker) {
  const pending = [...items]
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (pending.length > 0) {
        const item = pending.shift()
        if (item === undefined) return
        await worker(item)
      }
    }
  )
  await Promise.all(runners)
}

async function downloadFromCdn() {
  mkdirSync(join(destRoot, 'fonts'), { recursive: true })
  await download('fonts/fonts.json')
  const catalog = JSON.parse(readFileSync(marker, 'utf8'))
  const files = Array.isArray(catalog)
    ? catalog.map((entry) => entry.file).filter(Boolean)
    : []
  const fontPaths = files.map((file) => `fonts/${file}`)
  await mapPool(fontPaths, 6, download)
  await mapPool(EXTRA_PATHS, 3, download)
}

if (alreadyPresent()) {
  log('cad-data already present, skipping')
  process.exit(0)
}

if (tryCopySibling()) {
  process.exit(0)
}

log('downloading fonts/templates from jsDelivr…')
try {
  await downloadFromCdn()
  log('done')
} catch (err) {
  console.error('[sync-cad-data] failed:', err)
  process.exitCode = 1
}
