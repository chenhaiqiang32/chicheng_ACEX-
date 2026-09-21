/**
 * ACEX 转换服务：上传 DWG/DXF → CLI 无头导出 multi zip → 返回 zip
 * 同时可静态托管已解压的包（可选发布目录）。
 */
import { runHeadless } from '@mlightcad/cad-simple-viewer-cli'
import { unzipSync } from 'fflate'
import cors from 'cors'
import express from 'express'
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const WORK = path.join(ROOT, '.cad-work')
const PUBLISH = path.join(ROOT, 'published')
const SCRIPT = path.join(ROOT, 'scripts', 'export-html-multi.scr')
const PORT = Number(process.env.PORT || 8787)

function isSafeZipPath(p) {
  if (!p || p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false
  return p.split('/').every(
    (part) =>
      part.length > 0 &&
      part !== '.' &&
      part !== '..' &&
      /^[A-Za-z0-9._-]+$/.test(part)
  )
}

/** 与 cad-html-plugin 的 unzipAcExPackageFiles 同语义 */
function unzipAcExPackageFiles(bytes) {
  const entries = unzipSync(bytes)
  const files = []
  for (const [filePath, data] of Object.entries(entries)) {
    if (!isSafeZipPath(filePath)) {
      throw new Error('Unsafe path in package archive')
    }
    files.push({ path: filePath, bytes: data })
  }
  return files
}

const upload = multer({
  dest: path.join(WORK, 'uploads'),
  limits: { fileSize: 200 * 1024 * 1024 }
})

function drawingFilter(_req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase()
  if (ext === '.dwg' || ext === '.dxf') cb(null, true)
  else cb(new Error('Only .dwg / .dxf allowed'))
}

function zipFilter(_req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase()
  const ok =
    ext === '.zip' ||
    file.mimetype === 'application/zip' ||
    file.mimetype === 'application/x-zip-compressed'
  if (ok) cb(null, true)
  else cb(new Error('Only .zip allowed'))
}

async function publishZipBytes(zipBytes, jobId = randomUUID()) {
  const target = path.join(PUBLISH, jobId)
  const files = unzipAcExPackageFiles(new Uint8Array(zipBytes))
  const hasViewer = files.some((f) => f.path === 'viewer.html')
  const hasManifest = files.some((f) => f.path === 'drawing.acex.json')
  if (!hasViewer || !hasManifest) {
    throw new Error('Invalid multi ACEX package (need viewer.html + drawing.acex.json)')
  }
  for (const file of files) {
    const dest = path.join(target, file.path)
    await mkdir(path.dirname(dest), { recursive: true })
    await writeFile(dest, file.bytes)
  }
  return {
    jobId,
    packageUrl: `/packages/${jobId}/viewer.html`,
    fileCount: files.length,
    files: files.map((f) => f.path)
  }
}

await mkdir(path.join(WORK, 'uploads'), { recursive: true })
await mkdir(path.join(WORK, 'out'), { recursive: true })
await mkdir(PUBLISH, { recursive: true })

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, script: existsSync(SCRIPT) })
})

/**
 * POST /api/convert
 * multipart field: file (dwg/dxf)
 * ?publish=1 时额外解压到 /published/{id}/
 */
app.post('/api/convert', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'Missing file field "file"' })
    return
  }

  try {
    await new Promise((resolve, reject) => {
      drawingFilter(req, req.file, (err) => (err ? reject(err) : resolve()))
    })
  } catch (err) {
    await rm(req.file.path, { force: true })
    res.status(400).json({ error: err.message })
    return
  }

  const jobId = randomUUID()
  const outDir = path.join(WORK, 'out', jobId)
  const publish = String(req.query.publish ?? req.body?.publish ?? '') === '1'
  const wantJson =
    req.query.format === 'json' ||
    (req.get('accept') || '').includes('application/json')

  try {
    await mkdir(outDir, { recursive: true })

    const ext = path.extname(req.file.originalname).toLowerCase() || '.dwg'
    const inputPath = path.join(outDir, `input${ext}`)
    await writeFile(inputPath, await readFile(req.file.path))
    await rm(req.file.path, { force: true })

    const { outputDir, savedFiles } = await runHeadless({
      inputPath,
      scriptPath: SCRIPT,
      outputDir: outDir,
      mode: 'read'
    })

    const zipName =
      (savedFiles || []).find((f) => f.toLowerCase().endsWith('.zip')) ||
      (await readdir(outputDir)).find((f) => f.toLowerCase().endsWith('.zip'))

    if (!zipName) {
      throw new Error('CLI finished but no .zip was produced')
    }

    const zipPath = path.isAbsolute(zipName)
      ? zipName
      : path.join(outputDir, zipName)
    const zipBytes = await readFile(zipPath)
    const baseName = path.basename(zipName, '.zip')

    let packageUrl = null
    if (publish) {
      const published = await publishZipBytes(zipBytes, jobId)
      packageUrl = published.packageUrl
    }

    if (wantJson) {
      res.json({
        jobId,
        zipName: path.basename(zipName),
        baseName,
        packageUrl,
        size: zipBytes.byteLength
      })
      return
    }

    if (packageUrl) {
      res.setHeader('X-Package-Url', packageUrl)
    }
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(baseName)}.zip"`
    )
    res.send(Buffer.from(zipBytes))
  } catch (err) {
    console.error(err)
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err)
    })
  }
})

/**
 * POST /api/publish-zip
 * 局域网场景：前端上传 multi zip，服务端解压后静态托管
 */
app.post('/api/publish-zip', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'Missing file field "file"' })
    return
  }

  try {
    await new Promise((resolve, reject) => {
      zipFilter(req, req.file, (err) => (err ? reject(err) : resolve()))
    })
  } catch (err) {
    await rm(req.file.path, { force: true })
    res.status(400).json({ error: err.message })
    return
  }

  try {
    const zipBytes = await readFile(req.file.path)
    await rm(req.file.path, { force: true })
    const published = await publishZipBytes(zipBytes)
    res.json(published)
  } catch (err) {
    console.error(err)
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err)
    })
  }
})

app.use(
  '/packages',
  express.static(PUBLISH, {
    setHeaders(res, filePath) {
      if (/\.(acex|osnap)\.gz$/i.test(filePath)) {
        res.setHeader('Content-Type', 'application/octet-stream')
        res.removeHeader('Content-Encoding')
        res.setHeader(
          'Cache-Control',
          'public, max-age=31536000, immutable'
        )
      } else if (/\.acex\.json$/i.test(filePath)) {
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-cache')
      }
    }
  })
)

const dist = path.join(ROOT, 'frontend', 'dist')
if (existsSync(dist)) {
  app.use(express.static(dist))
}

function lanAddresses(port) {
  const nets = networkInterfaces()
  const urls = []
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) {
        urls.push(`http://${net.address}:${port}`)
      }
    }
  }
  return urls
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ACEX convert server`)
  console.log(`  Local:   http://localhost:${PORT}`)
  for (const url of lanAddresses(PORT)) {
    console.log(`  Network: ${url}`)
  }
  console.log(`  POST /api/convert      (multipart field: file, ?publish=1)`)
  console.log(`  POST /api/publish-zip  (multipart field: file)`)
  console.log(`  GET  /packages/:id/viewer.html`)
})
