/**
 * ACEX 转换服务：按 URL 异步导入 → 轮询状态 → 下载 zip
 *
 * POST /api/models/import
 * GET  /api/models/import/:jobId/status
 * GET  /api/models/:jobId/download?type=zip
 *
 * 本目录可单独拷贝到服务器部署（见 README.md）。
 */
import cors from 'cors'
import express from 'express'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runHeadless } from './lib/runHeadlessLocal.mjs'
import {
  getT3Health,
  maybeConvertTianzhengToT3
} from './lib/t3Convert.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const WORK = path.join(ROOT, '.cad-work')
const CAD_DATA = path.join(ROOT, 'cad-data')
const SCRIPT = path.join(ROOT, 'scripts', 'export-html-multi.scr')
const PORT = Number(process.env.PORT || 8788)
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
 * @property {number|null} sourceFileSize 源文件字节数
 * @property {number|null} convertedFileSize 转换后 zip 字节数
 * @property {number} createdAt
 */

/** @type {Map<string, ImportJob>} */
const jobs = new Map()

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
 * 轮询对外 status：ready / failed；转换中（pending|downloading|preprocessing|converting）返回 null
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
 */
async function processImportJob(job, url, filename, headers) {
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

    // 天正 DWG → T3 预处理（非天正跳过）；见 docs/tianzheng-t3.md
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
    const logfile = path.join(outDir, 'convert.log')
    const { outputDir, savedFiles } = await runHeadless({
      inputPath: t3.inputPath,
      scriptPath: SCRIPT,
      outputDir: outDir,
      mode: 'read',
      logfile
    })
    console.log(`[import ${job.jobId}] convert log: ${logfile}`)
    try {
      if (existsSync(logfile)) {
        const logText = await readFile(logfile, 'utf8')
        const fontLines = logText
          .split(/\r?\n/)
          .filter((line) =>
            /missedFonts|catalogMiss|drawing font|local cad-data miss|\[http \d+\]|requestfailed|WARN.*字体/i.test(
              line
            )
          )
        if (fontLines.length) {
          console.log(
            `[import ${job.jobId}] font diagnostics (${fontLines.length}):`
          )
          for (const line of fontLines.slice(0, 80)) {
            console.log(`  ${line}`)
          }
        }
      }
    } catch {
      // ignore log echo failures
    }

    const zipName =
      (savedFiles || []).find((f) => f.toLowerCase().endsWith('.zip')) ||
      (await readdir(outputDir)).find((f) => f.toLowerCase().endsWith('.zip'))

    if (!zipName) {
      throw new Error('conversion failed: CLI finished but no .zip was produced')
    }

    const zipPath = path.isAbsolute(zipName)
      ? zipName
      : path.join(outputDir, zipName)

    job.zipPath = zipPath
    job.zipName = path.basename(zipPath)
    job.convertedFileSize = (await stat(zipPath)).size
    // sanitize 已在 runHeadless 导出 zip 后执行；勿再跑第二次（MAD 非幂等会级联误删）
    job.phase = 'ready'
    job.errorMessage = null
  } catch (err) {
    console.error(`[import ${job.jobId}]`, err)
    job.phase = 'failed'
    const msg = err instanceof Error ? err.message : String(err)
    if (/download failed/i.test(msg)) {
      job.errorMessage = msg
    } else if (/T3 conversion failed/i.test(msg) || /t3conv\.exe not found/i.test(msg)) {
      job.errorMessage = msg
    } else if (/conversion failed/i.test(msg)) {
      job.errorMessage = msg
    } else {
      job.errorMessage = `conversion failed: ${msg}`
    }
  }
}

await mkdir(path.join(WORK, 'out'), { recursive: true })

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

app.get('/api/health', (_req, res) => {
  const script = existsSync(SCRIPT)
  const fonts = existsSync(FONTS_JSON)
  const t3 = getT3Health()
  res.json({
    ok: script && fonts,
    script,
    fonts,
    fontsMode: 'local',
    cadData: '/cad-data/',
    t3
  })
})

/** 自托管字体 / 模板（wiki: Self-Hosted Fonts and Templates） */
app.use(
  '/cad-data',
  express.static(CAD_DATA, {
    setHeaders(res, filePath) {
      const ext = path.extname(filePath).toLowerCase()
      if (ext === '.ttf') res.setHeader('Content-Type', 'font/ttf')
      else if (ext === '.otf') res.setHeader('Content-Type', 'font/otf')
      else if (ext === '.woff') res.setHeader('Content-Type', 'font/woff')
      else if (ext === '.woff2') res.setHeader('Content-Type', 'font/woff2')
      else if (ext === '.shx') res.setHeader('Content-Type', 'application/octet-stream')
      res.setHeader('Access-Control-Allow-Origin', '*')
    }
  })
)

/**
 * POST /api/models/import
 * Body JSON: { url, filename?, headers? }
 * 立即返回 jobId；后台下载并转换。
 */
app.post('/api/models/import', (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : ''
  const filename =
    typeof req.body?.filename === 'string' ? req.body.filename.trim() : undefined
  const headers =
    req.body?.headers && typeof req.body.headers === 'object'
      ? req.body.headers
      : undefined

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

  // 异步执行，不阻塞 202 响应
  void processImportJob(job, url, filename, headers)

  res.status(202).json({
    code: 0,
    message: 'accepted',
    data: {
      jobId,
      status: 'pending'
    }
  })
})

/**
 * GET /api/models/import/:jobId/status
 * status: ready | failed | null（转换中）
 */
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
 * 下载成功后删除该任务在 .cad-work/out 下的全部留存（源图纸 / zip / convert.log）
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

/**
 * GET /api/models/:jobId/download?type=zip
 * 转换成功后下载 multi ACEX zip（jobId 为 import 返回值）
 * 响应写完后删除 .cad-work/out/<jobId>（一次性下载，不可重复拉取）
 */
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
    // 响应刷出后再删盘：业务侧已拿到字节流；重复 download 将 409
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
  console.log(`ACEX convert server`)
  console.log(`  Local:   http://localhost:${PORT}`)
  for (const url of lanAddresses(PORT)) {
    console.log(`  Network: ${url}`)
  }
  console.log(`  POST /api/models/import`)
  console.log(`  GET  /api/models/import/:jobId/status`)
  console.log(`  GET  /api/models/:jobId/download?type=zip`)
  console.log(`  GET  /cad-data/fonts/fonts.json  (local fonts, no CDN)`)
})
