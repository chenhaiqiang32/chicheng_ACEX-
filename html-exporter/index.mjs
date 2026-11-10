/**
 * ACEX 多文件包转换服务（预渲染版）
 *
 * 本目录可单独部署到 Windows（对齐 acex试用/fuwu）。
 * 服务器通过 @mlightcad/cad-html-exporter（Node，无浏览器）转成 ACEX multi zip；
 * 演示前端在同级 ../frontend/，不随本服务打包。
 *
 * POST /api/models/import
 * GET  /api/models/import/:jobId/status
 * GET  /api/models/:jobId/download?type=zip
 * GET  /api/health
 */
import cors from 'cors'
import express from 'express'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runExportToZip } from './lib/runExport.mjs'
import { getT3Health, maybeConvertTianzhengToT3 } from './lib/t3Convert.mjs'
import { parseBackground, resolveDwgParser } from './lib/resolveDwgParser.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const WORK = path.join(ROOT, '.cad-work')
const CAD_DATA = path.join(ROOT, 'cad-data')
const PORT = Number(process.env.PORT || 8787)
const FONTS_JSON = path.join(CAD_DATA, 'fonts', 'fonts.json')

/** @typedef {'pending'|'downloading'|'preprocessing'|'converting'|'ready'|'failed'} JobPhase */

/**
 * @typedef {object} ImportJob
 * @property {string} jobId
 * @property {JobPhase} phase
 * @property {string|null} fileId
 * @property {string|null} errorMessage
 * @property {string|null} zipPath
 * @property {string|null} zipName
 * @property {string|null} filename
 * @property {number|null} sourceFileSize
 * @property {number|null} convertedFileSize
 * @property {number} createdAt
 */

/** @type {Map<string, ImportJob>} */
const jobs = new Map()

/** 串行转换：同一进程内只跑一个任务（子进程导出） */
let convertChain = Promise.resolve()

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim())
}

function drawingNameFromUrl(urlString) {
  try {
    const pathname = new URL(urlString).pathname
    const base = path.basename(pathname)
    if (base && path.extname(base)) return decodeURIComponent(base)
  } catch {
    // fall through
  }
  return 'drawing.dwg'
}

function assertDrawingFilename(filename) {
  const ext = path.extname(filename).toLowerCase()
  if (ext !== '.dwg' && ext !== '.dxf') {
    throw new Error(
      `Unsupported drawing "${filename}". Only .dwg / .dxf are supported.`
    )
  }
}

/**
 * @param {ImportJob} job
 */
function publicStatus(job) {
  if (job.phase === 'ready' || job.phase === 'failed') return job.phase
  return null
}

/**
 * @param {string} url
 * @param {Record<string, string>|undefined} headers
 * @param {string|undefined} filenameHint
 */
async function downloadDrawing(url, headers, filenameHint) {
  const init = {}
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    const h = {}
    for (const [k, v] of Object.entries(headers)) {
      if (v == null) continue
      h[String(k)] = String(v)
    }
    if (Object.keys(h).length) init.headers = h
  }

  const response = await fetch(url, init)
  if (!response.ok) {
    throw new Error(
      `download failed (${response.status} ${response.statusText})`
    )
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  const fileId = createHash('md5').update(bytes).digest('hex')
  const filename = filenameHint?.trim() || drawingNameFromUrl(url)
  assertDrawingFilename(filename)
  return { bytes, filename, fileId }
}

/**
 * @param {ImportJob} job
 * @param {string} url
 * @param {string|undefined} filename
 * @param {Record<string, string>|undefined} headers
 * @param {'black'|'white'|'space'|undefined} background
 */
async function processImportJob(job, url, filename, headers, background) {
  const outDir = path.join(WORK, 'out', job.jobId)
  try {
    await mkdir(outDir, { recursive: true })

    job.phase = 'downloading'
    const drawing = await downloadDrawing(url, headers, filename)
    job.filename = drawing.filename
    job.fileId = drawing.fileId
    job.sourceFileSize = drawing.bytes.length

    const ext = path.extname(drawing.filename).toLowerCase() || '.dwg'
    const inputPath = path.join(outDir, `input${ext}`)
    await writeFile(inputPath, drawing.bytes)

    job.phase = 'preprocessing'
    const t3 = await maybeConvertTianzhengToT3(inputPath, outDir)
    console.log(
      `[import ${job.jobId}] t3 preprocess: converted=${t3.converted} skipped=${t3.skipped} reason=${t3.reason}` +
        (t3.detect
          ? ` matches=${t3.detect.matches.map((m) => m.signature).join(',') || '(none)'}`
          : '') +
        (t3.durationMs != null ? ` durationMs=${t3.durationMs}` : '')
    )

    job.phase = 'converting'
    const stem = path.basename(drawing.filename, path.extname(drawing.filename))
    const zipPath = path.join(outDir, `${stem || 'drawing'}.zip`)
    const logfile = path.join(outDir, 'convert.log')

    const result = await runExportToZip({
      inputPath: t3.inputPath,
      outputZip: zipPath,
      fontsDir: CAD_DATA,
      logfile,
      background
    })
    console.log(
      `[import ${job.jobId}] convert ok zip=${result.outputZip} ` +
        `parser=${result.dwgParser} durationMs=${result.durationMs} log=${logfile}`
    )

    job.zipPath = result.outputZip
    job.zipName = path.basename(result.outputZip)
    job.convertedFileSize = (await stat(result.outputZip)).size
    job.phase = 'ready'
    job.errorMessage = null
  } catch (err) {
    console.error(`[import ${job.jobId}]`, err)
    job.phase = 'failed'
    const msg = err instanceof Error ? err.message : String(err)
    if (/download failed/i.test(msg)) {
      job.errorMessage = msg
    } else if (
      /T3 conversion failed/i.test(msg) ||
      /t3conv\.exe not found/i.test(msg)
    ) {
      job.errorMessage = msg
    } else if (/conversion failed/i.test(msg)) {
      job.errorMessage = msg
    } else {
      job.errorMessage = `conversion failed: ${msg}`
    }
  }
}

/**
 * @param {ImportJob} job
 * @param {string} url
 * @param {string|undefined} filename
 * @param {Record<string, string>|undefined} headers
 * @param {'black'|'white'|'space'|undefined} background
 */
function enqueueImport(job, url, filename, headers, background) {
  convertChain = convertChain
    .then(() => processImportJob(job, url, filename, headers, background))
    .catch((err) => {
      console.error(`[import queue] unexpected:`, err)
    })
}

await mkdir(path.join(WORK, 'out'), { recursive: true })

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

app.get('/api/health', async (_req, res) => {
  const fonts = existsSync(FONTS_JSON)
  const t3 = getT3Health()
  let dwgParser = 'unknown'
  try {
    dwgParser = await resolveDwgParser()
  } catch {
    dwgParser = 'error'
  }
  res.json({
    ok: fonts,
    exporter: '@mlightcad/cad-html-exporter',
    browser: false,
    fonts,
    fontsMode: 'local',
    cadData: '/cad-data/',
    dwgParser,
    node: process.version,
    t3
  })
})

app.use(
  '/cad-data',
  express.static(CAD_DATA, {
    setHeaders(res, filePath) {
      const ext = path.extname(filePath).toLowerCase()
      if (ext === '.ttf') res.setHeader('Content-Type', 'font/ttf')
      else if (ext === '.otf') res.setHeader('Content-Type', 'font/otf')
      else if (ext === '.woff') res.setHeader('Content-Type', 'font/woff')
      else if (ext === '.woff2') res.setHeader('Content-Type', 'font/woff2')
      else if (ext === '.shx') {
        res.setHeader('Content-Type', 'application/octet-stream')
      }
      res.setHeader('Access-Control-Allow-Origin', '*')
    }
  })
)

/**
 * POST /api/models/import
 * Body: { url, filename?, headers?, background? }
 */
app.post('/api/models/import', (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : ''
  const filename =
    typeof req.body?.filename === 'string' ? req.body.filename.trim() : undefined
  const headers =
    req.body?.headers && typeof req.body.headers === 'object'
      ? req.body.headers
      : undefined
  const background = parseBackground(
    typeof req.body?.background === 'string' ? req.body.background : undefined
  )

  if (!url || !isHttpUrl(url)) {
    res.status(400).json({
      code: 400,
      message: 'url is required and must be http/https',
      data: null
    })
    return
  }

  try {
    if (filename) assertDrawingFilename(filename)
    else assertDrawingFilename(drawingNameFromUrl(url))
  } catch (err) {
    res.status(400).json({
      code: 400,
      message: err instanceof Error ? err.message : String(err),
      data: null
    })
    return
  }

  if (!existsSync(FONTS_JSON)) {
    res.status(503).json({
      code: 503,
      message: 'fonts not ready; run npm run sync:cad-data',
      data: null
    })
    return
  }

  const jobId = randomUUID()
  /** @type {ImportJob} */
  const job = {
    jobId,
    phase: 'pending',
    fileId: null,
    errorMessage: null,
    zipPath: null,
    zipName: null,
    filename: filename || null,
    sourceFileSize: null,
    convertedFileSize: null,
    createdAt: Date.now()
  }
  jobs.set(jobId, job)

  enqueueImport(job, url, filename, headers, background)

  res.status(202).json({
    code: 0,
    message: 'accepted',
    data: {
      jobId,
      status: 'pending'
    }
  })
})

app.get('/api/models/import/:jobId/status', (req, res) => {
  const job = jobs.get(req.params.jobId)
  if (!job) {
    res.status(404).json({
      code: 404,
      message: 'job not found',
      data: null
    })
    return
  }

  const status = publicStatus(job)
  res.json({
    code: 0,
    data: {
      jobId: job.jobId,
      status,
      fileId: status === 'ready' ? job.fileId : null,
      sourceFileSize: status === 'ready' ? job.sourceFileSize : null,
      convertedFileSize: status === 'ready' ? job.convertedFileSize : null,
      errorMessage: status === 'failed' ? job.errorMessage : null
    }
  })
})

/**
 * @param {ImportJob} job
 */
async function cleanupJobOutDir(job) {
  const outDir = path.join(WORK, 'out', job.jobId)
  job.zipPath = null
  job.zipName = null
  try {
    await rm(outDir, { recursive: true, force: true })
    console.log(`[import ${job.jobId}] cleaned ${outDir} after download`)
  } catch (err) {
    console.error(`[import ${job.jobId}] cleanup failed:`, err)
  }
}

app.get('/api/models/:jobId/download', async (req, res) => {
  const job = jobs.get(req.params.jobId)
  if (!job) {
    res.status(404).json({
      code: 404,
      message: 'job not found',
      data: null
    })
    return
  }

  if (job.phase !== 'ready' || !job.zipPath) {
    res.status(409).json({
      code: 409,
      message:
        job.phase === 'failed'
          ? job.errorMessage || 'conversion failed'
          : !job.zipPath
            ? 'zip already downloaded and removed'
            : 'job not ready',
      data: {
        jobId: job.jobId,
        status: publicStatus(job)
      }
    })
    return
  }

  const type = String(req.query.type || 'zip').toLowerCase()
  if (type !== 'zip') {
    res.status(400).json({
      code: 400,
      message: 'only type=zip is supported',
      data: null
    })
    return
  }

  if (!existsSync(job.zipPath)) {
    res.status(410).json({
      code: 410,
      message: 'zip file missing on server',
      data: null
    })
    return
  }

  try {
    const zipBytes = await readFile(job.zipPath)
    const baseName = path.basename(job.zipName || job.zipPath, '.zip')
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(baseName)}.zip"`
    )
    res.once('finish', () => {
      void cleanupJobOutDir(job)
    })
    res.send(Buffer.from(zipBytes))
  } catch (err) {
    console.error(err)
    res.status(500).json({
      code: 500,
      message: err instanceof Error ? err.message : String(err),
      data: null
    })
  }
})

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
  console.log(`ACEX html-exporter convert server`)
  console.log(`  Local:   http://localhost:${PORT}`)
  for (const url of lanAddresses(PORT)) {
    console.log(`  Network: ${url}`)
  }
  console.log(`  Engine:  @mlightcad/cad-html-exporter (Node, no browser)`)
  console.log(`  POST /api/models/import`)
  console.log(`  GET  /api/models/import/:jobId/status`)
  console.log(`  GET  /api/models/:jobId/download?type=zip`)
  console.log(`  GET  /cad-data/fonts/fonts.json`)
})
