/**
 * 基于 @mlightcad/cad-simple-viewer-cli 的 runHeadless，
 * 通过 baseUrl './cad-data/' 加载本机 fuwu/cad-data（字体/模板），不走 CDN。
 *
 * 目录结构与官方一致：fonts/、templates/、fonts/fonts.json
 * 参考：https://github.com/mlightcad/cad-viewer/wiki/Self-Hosted-Fonts-and-Templates
 *
 * 调试：默认写 convert.log；设 CONVERT_DEBUG=0 可关闭详细控制台输出。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { sanitizeAcexZipFile } from './sanitizeAcexOutliers.mjs'

const require = createRequire(import.meta.url)
const CLI_ROOT = path.resolve(
  path.dirname(require.resolve('@mlightcad/cad-simple-viewer-cli')),
  '..'
)
const RUNNER_DIR = path.join(CLI_ROOT, 'dist-runner')

const FUWU_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CAD_DATA = path.join(FUWU_ROOT, 'cad-data')

/** CLI baseUrl：相对 runner 页路径，静态服务已挂 /cad-data/ → 本地 CAD_DATA */
const LOCAL_CAD_DATA_BASE_URL = './cad-data/'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.shx': 'application/octet-stream',
  '.dwg': 'application/octet-stream',
  '.dxf': 'application/octet-stream'
}

const DEBUG_ENABLED = process.env.CONVERT_DEBUG !== '0'

function assertCadData() {
  const fontsJson = path.join(CAD_DATA, 'fonts', 'fonts.json')
  if (!existsSync(fontsJson)) {
    throw new Error(
      `Missing local cad-data fonts catalog: ${fontsJson}. Deploy fuwu/cad-data with the convert server.`
    )
  }
}

function contentTypeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

function resolveUnderRoot(root, relativeUrlPath) {
  const relative =
    relativeUrlPath === '/' ? 'index.html' : relativeUrlPath.replace(/^\//, '')
  const rootResolved = path.resolve(root)
  const filePath = path.resolve(rootResolved, decodeURIComponent(relative))
  const prefix = rootResolved.endsWith(path.sep)
    ? rootResolved
    : rootResolved + path.sep
  if (filePath !== rootResolved && !filePath.startsWith(prefix)) return null
  return filePath
}

async function readRequestBody(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/**
 * 静态服务：runner + 本地 cad-data + CLI 1.7.5 图纸挂载 / 导出落盘
 * （runCadScript 第二参改为 URL fetch，导出经 POST /__cli_save__/）
 */
function startStaticServer(runnerRoot, cadDataRoot, opts = {}) {
  const idleTimeoutMs = Number(opts.idleTimeoutMs) > 0 ? Number(opts.idleTimeoutMs) : 600_000

  /** 拉长 CLI runner 内 waitUntilIdle 超时（npm 包写死 120s，云主机 GPU 慢会提前截断图元） */
  function patchRunnerJs(filePath, body) {
    const base = path.basename(filePath)
    if (!/^index-.*\.js$/i.test(base) && !/viewer-runtime/i.test(base)) {
      return body
    }
    let text = body.toString('utf8')
    const before = text
    // CLI / 转换：常量 12e4（120s）→ 自定义毫秒
    // 1.7.5: Boe / pDe；1.7.4: Tre / XRe；1.7.3: Qie / K3e；1.7.1: rge / fke
    text = text.replace(/\bBoe=12e4\b/g, `Boe=${idleTimeoutMs}`)
    text = text.replace(/\bpDe=12e4\b/g, `pDe=${idleTimeoutMs}`)
    text = text.replace(/\bTre=12e4\b/g, `Tre=${idleTimeoutMs}`)
    text = text.replace(/\bXRe=12e4\b/g, `XRe=${idleTimeoutMs}`)
    text = text.replace(/\bQie=12e4\b/g, `Qie=${idleTimeoutMs}`)
    text = text.replace(/\bK3e=12e4\b/g, `K3e=${idleTimeoutMs}`)
    text = text.replace(/const rge=12e4\b/g, `const rge=${idleTimeoutMs}`)
    text = text.replace(/const fke=12e4\b/g, `const fke=${idleTimeoutMs}`)
    text = text.replace(/timeOut=e\.timeOut\?\?12e4/g, `timeOut=e.timeOut??${idleTimeoutMs}`)
    // View：waitUntilIdle(t|e=6e4) 默认 60s
    text = text.replace(/waitUntilIdle\(t=6e4\)/g, `waitUntilIdle(t=${idleTimeoutMs})`)
    text = text.replace(/waitUntilIdle\(e=6e4\)/g, `waitUntilIdle(e=${idleTimeoutMs})`)
    if (text !== before) {
      console.log(
        `[convert] patched runner idle timeout → ${idleTimeoutMs}ms in ${base}`
      )
    }
    return Buffer.from(text, 'utf8')
  }

  return new Promise((resolve, reject) => {
    /** @type {Map<string, string>} */
    const mountedInputs = new Map()
    let saveDir = null
    /** @type {string[]} */
    let savedFiles = []
    let mountSeq = 0

    const server = createServer((req, res) => {
      void handleRequest(req, res)
    })

    async function handleRequest(req, res) {
      try {
        const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')

        if (req.method === 'POST' && urlPath.startsWith('/__cli_save__/')) {
          if (!saveDir) {
            res.writeHead(500)
            res.end('Save directory not configured')
            return
          }
          const fileName = path.basename(urlPath.slice('/__cli_save__/'.length))
          if (!fileName) {
            res.writeHead(400)
            res.end('Missing file name')
            return
          }
          const body = await readRequestBody(req)
          const dest = uniqueOutputPath(saveDir, fileName)
          await writeFile(dest, body)
          savedFiles.push(dest)
          res.writeHead(204)
          res.end()
          return
        }

        if (urlPath.startsWith('/__cli_input__/')) {
          const absolute = mountedInputs.get(urlPath)
          if (!absolute || !existsSync(absolute)) {
            res.writeHead(404)
            res.end()
            return
          }
          const body = await readFile(absolute)
          res.setHeader('Content-Type', contentTypeFor(absolute))
          res.setHeader('Content-Length', String(body.byteLength))
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.writeHead(200)
          res.end(body)
          return
        }

        let filePath = null
        if (urlPath.startsWith('/cad-data/')) {
          filePath = resolveUnderRoot(
            cadDataRoot,
            urlPath.slice('/cad-data/'.length)
          )
        } else {
          filePath = resolveUnderRoot(
            runnerRoot,
            urlPath === '/' ? 'index.html' : urlPath
          )
        }

        if (!filePath || !existsSync(filePath)) {
          res.writeHead(404)
          res.end()
          return
        }

        res.setHeader('Content-Type', contentTypeFor(filePath))
        res.setHeader('Access-Control-Allow-Origin', '*')
        const body = await readFile(filePath)
        const out =
          path.extname(filePath).toLowerCase() === '.js'
            ? patchRunnerJs(filePath, body)
            : body
        res.writeHead(200)
        res.end(out)
      } catch (error) {
        res.writeHead(500)
        res.end(String(error))
      }
    }

    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to start static server for CLI runner.'))
        return
      }
      const baseUrl = `http://127.0.0.1:${address.port}`
      resolve({
        url: baseUrl,
        idleTimeoutMs,
        mountInput: (absolutePath) => {
          const token = String(++mountSeq)
          const urlPath = `/__cli_input__/${token}`
          mountedInputs.set(urlPath, absolutePath)
          return `${baseUrl}${urlPath}`
        },
        setSaveDir: (dir) => {
          saveDir = dir
        },
        takeSavedFiles: () => {
          const files = savedFiles
          savedFiles = []
          return files
        },
        resetSavedFiles: () => {
          savedFiles = []
        },
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((err) => (err ? closeReject(err) : closeResolve()))
          })
      })
    })
  })
}

async function appendLog(logfile, line) {
  if (!logfile) return
  await mkdir(path.dirname(path.resolve(logfile)), { recursive: true })
  await writeFile(logfile, `${line}\n`, { flag: 'a', encoding: 'utf8' })
}

/** 同时写文件日志 + 控制台（便于服务器对照本地） */
async function dbg(logfile, line, level = 'log') {
  const msg = line.startsWith('[') ? line : `[convert] ${line}`
  if (DEBUG_ENABLED) {
    if (level === 'warn') console.warn(msg)
    else if (level === 'error') console.error(msg)
    else console.log(msg)
  }
  await appendLog(logfile, msg)
}

function uniqueOutputPath(outputDir, fileName) {
  const base = path.basename(fileName)
  let candidate = path.join(outputDir, base)
  if (!existsSync(candidate)) return candidate
  const ext = path.extname(base)
  const stem = path.basename(base, ext)
  let index = 2
  while (existsSync(candidate)) {
    candidate = path.join(outputDir, `${stem}-${index}${ext}`)
    index++
  }
  return candidate
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value.trim())
}

function drawingNameFromUrl(urlString) {
  try {
    const pathname = new URL(urlString).pathname
    const base = path.basename(pathname)
    if (base && path.extname(base)) return base
  } catch {
    // fall through
  }
  return 'drawing.dwg'
}

/**
 * CLI 1.7.5：图纸以本地绝对路径挂载给 runner fetch（远程 URL 先落到 outputDir，避免 CORS）。
 * @param {string} inputPath
 * @param {{ headers?: Record<string, string>, filename?: string, stagingDir?: string }} [opts]
 * @returns {Promise<{ label: string, fileName: string, absolutePath: string, bytes: number }>}
 */
async function loadDrawingInput(inputPath, opts = {}) {
  if (isHttpUrl(inputPath)) {
    const fileName = opts.filename?.trim() || drawingNameFromUrl(inputPath)
    const ext = path.extname(fileName).toLowerCase()
    if (ext !== '.dxf' && ext !== '.dwg') {
      throw new Error(
        `Unsupported remote drawing "${fileName}". URL path must end with .dxf or .dwg.`
      )
    }
    const init = {}
    if (opts.headers && typeof opts.headers === 'object') {
      const headers = {}
      for (const [k, v] of Object.entries(opts.headers)) {
        if (v == null) continue
        headers[String(k)] = String(v)
      }
      if (Object.keys(headers).length) init.headers = headers
    }
    const response = await fetch(inputPath, init)
    if (!response.ok) {
      throw new Error(
        `Failed to download drawing (${response.status} ${response.statusText}): ${inputPath}`
      )
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    const stagingDir = opts.stagingDir
      ? path.resolve(opts.stagingDir)
      : process.cwd()
    await mkdir(stagingDir, { recursive: true })
    const absolutePath = path.join(stagingDir, `_cli_input_${fileName}`)
    await writeFile(absolutePath, bytes)
    return {
      label: inputPath,
      fileName,
      absolutePath,
      bytes: bytes.byteLength
    }
  }

  const absoluteInput = path.resolve(inputPath)
  const ext = path.extname(absoluteInput).toLowerCase()
  if (ext !== '.dxf' && ext !== '.dwg') {
    throw new Error(`Unsupported file type "${ext}". Only .dxf and .dwg are supported.`)
  }
  if (!existsSync(absoluteInput)) {
    throw new Error(`Input drawing not found: ${absoluteInput}`)
  }
  return {
    label: absoluteInput,
    fileName: path.basename(absoluteInput),
    absolutePath: absoluteInput,
    bytes: statSync(absoluteInput).size
  }
}

function countFilesRecursive(dir, extFilter = null, max = 5000) {
  let count = 0
  if (!existsSync(dir)) return 0
  const walk = (d) => {
    if (count >= max) return
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const full = path.join(d, ent.name)
      if (ent.isDirectory()) walk(full)
      else if (!extFilter || extFilter.test(ent.name)) count++
      if (count >= max) return
    }
  }
  walk(dir)
  return count
}

function inspectCadData() {
  const fontsDir = path.join(CAD_DATA, 'fonts')
  const fontsJson = path.join(fontsDir, 'fonts.json')
  const templatesDir = path.join(CAD_DATA, 'templates')
  let catalogCount = null
  if (existsSync(fontsJson)) {
    try {
      const catalog = JSON.parse(readFileSync(fontsJson, 'utf8'))
      catalogCount = Array.isArray(catalog)
        ? catalog.length
        : catalog && typeof catalog === 'object'
          ? Object.keys(catalog).length
          : null
    } catch {
      catalogCount = 'parse-error'
    }
  }
  return {
    cadData: CAD_DATA,
    fontsJson: existsSync(fontsJson),
    fontsJsonBytes: existsSync(fontsJson) ? statSync(fontsJson).size : 0,
    catalogEntries: catalogCount,
    fontFiles: countFilesRecursive(fontsDir, /\.(ttf|otf|woff2?|shx)$/i),
    templateFiles: countFilesRecursive(templatesDir),
    templatesDirExists: existsSync(templatesDir)
  }
}

function packageVersions() {
  const out = {}
  try {
    // 1.7.5+ package exports 不暴露 package.json，从入口反推
    const entry = require.resolve('@mlightcad/cad-simple-viewer-cli')
    const root = path.resolve(path.dirname(entry), '..')
    out.cli = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
      .version
  } catch {
    out.cli = '?'
  }
  try {
    out.playwright = require('playwright/package.json').version
  } catch {
    out.playwright = '?'
  }
  return out
}

/**
 * 解析 zip 内 ACEX 包统计，便于对照「图元丢失」是 batch 少还是 extents 爆炸。
 */
async function inspectAcexZip(zipPath) {
  try {
    const { unzipSync, strFromU8 } = await import('fflate')
    const raw = await readFile(zipPath)
    if (raw.length < 4 || raw[0] !== 0x50 || raw[1] !== 0x4b) {
      return { error: 'not-a-zip', bytes: raw.length }
    }
    const entries = unzipSync(new Uint8Array(raw))
    const keys = Object.keys(entries)
    const mp = keys.find((p) => p.endsWith('drawing.acex.json'))
    if (!mp) return { error: 'no-manifest', bytes: raw.length, files: keys.length }
    const manifest = JSON.parse(strFromU8(entries[mp]))
    let line = 0
    let mesh = 0
    for (const c of Object.values(manifest.chunks || {})) {
      line += c.lineBatchCount || 0
      mesh += c.meshBatchCount || 0
    }
    const ve = manifest.meta?.viewExtents
    const ext = manifest.meta?.extents
    const span = (b) =>
      b && Number.isFinite(b.maxX) && Number.isFinite(b.minX)
        ? {
            w: b.maxX - b.minX,
            h: b.maxY - b.minY,
            maxAbs: Math.max(
              Math.abs(b.minX),
              Math.abs(b.minY),
              Math.abs(b.maxX),
              Math.abs(b.maxY)
            )
          }
        : null
    const veSpan = span(ve)
    const astronomical = !!(veSpan && veSpan.maxAbs > 1e12)
    return {
      bytes: raw.length,
      files: keys.length,
      chunks: Object.keys(manifest.chunks || {}).length,
      lineBatches: line,
      meshBatches: mesh,
      totalBatches: line + mesh,
      layers: Array.isArray(manifest.layers) ? manifest.layers.length : 0,
      layouts: Array.isArray(manifest.layouts)
        ? manifest.layouts.map((l) => l?.name).filter(Boolean)
        : [],
      viewExtents: ve,
      extents: ext,
      viewSpan: veSpan,
      astronomicalExtents: astronomical
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 解析本机 Chrome / Edge 可执行文件路径（不依赖 Playwright 自带 Chromium）。
 * 可通过 PLAYWRIGHT_CHROME_PATH 强制指定。
 */
function resolveSystemChromePath() {
  const fromEnv = process.env.PLAYWRIGHT_CHROME_PATH?.trim()
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(`PLAYWRIGHT_CHROME_PATH not found: ${fromEnv}`)
    }
    return fromEnv
  }

  const candidates =
    process.platform === 'win32'
      ? [
          path.join(
            process.env['PROGRAMFILES'] || 'C:\\Program Files',
            'Google',
            'Chrome',
            'Application',
            'chrome.exe'
          ),
          path.join(
            process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
            'Google',
            'Chrome',
            'Application',
            'chrome.exe'
          ),
          path.join(
            process.env.LOCALAPPDATA || '',
            'Google',
            'Chrome',
            'Application',
            'chrome.exe'
          ),
          path.join(
            process.env['PROGRAMFILES'] || 'C:\\Program Files',
            'Microsoft',
            'Edge',
            'Application',
            'msedge.exe'
          ),
          path.join(
            process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
            'Microsoft',
            'Edge',
            'Application',
            'msedge.exe'
          )
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
          ]
        : [
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            '/snap/bin/chromium'
          ]

  for (const p of candidates) {
    if (p && existsSync(p)) return p
  }
  return null
}

/** 云主机（如阿里云 iZ*）无独显时 WebGL 易 GPU stall，默认走 SwiftShader */
function shouldUseSwiftShader() {
  const env = process.env.CONVERT_USE_SWIFTSHADER?.trim().toLowerCase()
  if (env === '1' || env === 'true' || env === 'yes') return true
  if (env === '0' || env === 'false' || env === 'no') return false
  const host = os.hostname()
  // 阿里云 / 常见云主机名
  return /^iZ/i.test(host) || /aliyun|ecs|tencent|huawei|azure|aws/i.test(host)
}

function idleTimeoutMsFromEnv() {
  const n = Number(process.env.CONVERT_IDLE_TIMEOUT_MS)
  // 默认 10 分钟；云主机几何转换常超过官方 120s
  return Number.isFinite(n) && n >= 60_000 ? Math.floor(n) : 600_000
}

/** Windows 服务 / 无桌面会话下更稳的 headless 参数 */
function chromeLaunchArgs() {
  const defaults = [
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--font-render-hinting=none',
    '--ignore-gpu-blocklist',
    '--enable-webgl'
  ]
  // 服务器以服务账号跑时常需关闭沙箱；可用 CONVERT_CHROME_NO_SANDBOX=0 关闭此行为
  if (process.env.CONVERT_CHROME_NO_SANDBOX !== '0') {
    defaults.push('--no-sandbox', '--disable-setuid-sandbox')
  }
  if (shouldUseSwiftShader()) {
    // 软渲染 WebGL：云主机虚拟 GPU 上比原生 GL 更稳，避免 ReadPixels stall 后超时截断
    defaults.push(
      '--use-angle=swiftshader',
      '--use-gl=angle',
      '--enable-unsafe-swiftshader'
    )
  }
  const extra = process.env.CONVERT_CHROME_ARGS?.trim()
  if (extra) {
    defaults.push(...extra.split(/\s+/).filter(Boolean))
  }
  return defaults
}

/**
 * 强制使用系统 Chrome（或 Edge）启动 headless。
 * 1.7.1 + Playwright 自带 Chromium 会导致图元大量缺失，因此默认禁止回退 bundled Chromium。
 * @see https://github.com/mlightcad/cad-viewer/issues/667
 */
async function launchBrowser() {
  const envChannel = process.env.PLAYWRIGHT_BROWSER_CHANNEL?.trim().toLowerCase()
  const args = chromeLaunchArgs()

  if (envChannel === 'chromium' || envChannel === 'bundled') {
    const browser = await chromium.launch({ headless: true, args })
    return { browser, channel: 'chromium', executablePath: null, args }
  }

  const chromePath = resolveSystemChromePath()
  if (chromePath) {
    const browser = await chromium.launch({
      headless: true,
      executablePath: chromePath,
      args
    })
    return {
      browser,
      channel: path.basename(chromePath).toLowerCase().includes('msedge')
        ? 'msedge'
        : 'chrome',
      executablePath: chromePath,
      args
    }
  }

  const channel =
    envChannel && envChannel !== 'chromium' && envChannel !== 'bundled'
      ? envChannel
      : 'chrome'
  try {
    const browser = await chromium.launch({
      headless: true,
      channel,
      args
    })
    return { browser, channel, executablePath: null, args }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Failed to launch system Chrome/Edge. Install Google Chrome on the server, ` +
        `or set PLAYWRIGHT_CHROME_PATH to chrome.exe. (${msg})`
    )
  }
}

/**
 * @param {object} options
 * @param {string} [options.inputPath] 本地路径或 http(s) 图纸地址
 * @param {string} options.scriptPath
 * @param {string} [options.outputDir]
 * @param {'read'|'write'} [options.mode]
 * @param {'extents'|'saved'} [options.openViewMode]
 * @param {boolean} [options.drawNoPlotLayers]
 * @param {number} [options.circleSides]
 * @param {string} [options.locale]
 * @param {string} [options.logfile]
 * @param {string} [options.filename]
 * @param {Record<string, string>} [options.headers]
 */
export async function runHeadless(options) {
  assertCadData()

  const absoluteScript = path.resolve(options.scriptPath)
  if (!existsSync(absoluteScript)) {
    throw new Error(`Script not found: ${absoluteScript}`)
  }

  const outputDirPreview = path.resolve(
    options.outputDir ??
      (options.inputPath && !isHttpUrl(options.inputPath)
        ? path.dirname(path.resolve(options.inputPath))
        : process.cwd())
  )
  await mkdir(outputDirPreview, { recursive: true })

  let absoluteInput
  let fileName = null
  /** @type {string|null} */
  let mountPath = null
  let inputBytes = 0
  if (options.inputPath) {
    const drawing = await loadDrawingInput(options.inputPath, {
      headers: options.headers,
      filename: options.filename,
      stagingDir: outputDirPreview
    })
    absoluteInput = drawing.label
    fileName = drawing.fileName
    mountPath = drawing.absolutePath
    inputBytes = drawing.bytes
  }

  const outputDir = outputDirPreview

  if (!existsSync(path.join(RUNNER_DIR, 'index.html'))) {
    throw new Error(
      'CLI runner is not built. Reinstall @mlightcad/cad-simple-viewer-cli.'
    )
  }

  const scriptText = await readFile(absoluteScript, 'utf8')
  const mode = options.mode ?? (absoluteInput ? 'read' : 'write')
  const openViewMode =
    options.openViewMode ?? (mode === 'write' ? 'saved' : 'extents')
  const drawNoPlotLayers = options.drawNoPlotLayers
  const circleSides = options.circleSides
  // 默认在输出目录写 convert.log，方便服务器对照
  const logfile = path.resolve(
    options.logfile || path.join(outputDir, 'convert.log')
  )
  const t0 = Date.now()
  const versions = packageVersions()
  const cadInfo = inspectCadData()

  await dbg(logfile, `=== convert start ${new Date().toISOString()} ===`)
  await dbg(
    logfile,
    `env node=${process.version} platform=${process.platform}/${process.arch} ` +
      `cwd=${process.cwd()} user=${os.userInfo().username} hostname=${os.hostname()}`
  )
  await dbg(
    logfile,
    `pkg cli=${versions.cli} playwright=${versions.playwright} runner=${RUNNER_DIR}`
  )
  await dbg(
    logfile,
    `cad-data fontsJson=${cadInfo.fontsJson} catalog=${cadInfo.catalogEntries} ` +
      `fontFiles=${cadInfo.fontFiles} templates=${cadInfo.templateFiles} path=${cadInfo.cadData}`
  )
  await dbg(
    logfile,
    `input=${absoluteInput ?? '(blank)'} file=${fileName ?? '-'} ` +
      `bytes=${inputBytes} mount=${mountPath ?? '-'} ` +
      `script=${absoluteScript} output=${outputDir} ` +
      `openViewMode=${openViewMode} drawNoPlotLayers=${drawNoPlotLayers ?? '(default)'} ` +
      `circleSides=${circleSides ?? '(default)'}`
  )
  if (!cadInfo.fontsJson || cadInfo.fontFiles < 5) {
    await dbg(
      logfile,
      `WARN cad-data 字体目录疑似不完整（fontFiles=${cadInfo.fontFiles}）。` +
        `拷贝 fuwu 到服务器时必须带完整 cad-data/fonts/，否则文字/图元会缺失。`,
      'warn'
    )
  }

  const idleTimeoutMs = idleTimeoutMsFromEnv()
  const useSwift = shouldUseSwiftShader()
  await dbg(
    logfile,
    `idleTimeoutMs=${idleTimeoutMs} swiftShader=${useSwift} ` +
      `(set CONVERT_IDLE_TIMEOUT_MS / CONVERT_USE_SWIFTSHADER to override)`
  )

  const server = await startStaticServer(RUNNER_DIR, CAD_DATA, { idleTimeoutMs })
  const localCadDataBaseUrl = LOCAL_CAD_DATA_BASE_URL
  server.setSaveDir(outputDir)
  server.resetSavedFiles()
  /** @type {string|null} */
  let drawingUrl = null
  if (mountPath) {
    drawingUrl = server.mountInput(mountPath)
  }

  const { browser, channel, executablePath, args } = await launchBrowser()
  let browserVersion = '?'
  try {
    browserVersion = browser.version()
  } catch {
    // ignore
  }
  await dbg(
    logfile,
    `browser channel=${channel} executablePath=${executablePath || '(playwright-channel)'} ` +
      `version=${browserVersion} args=${JSON.stringify(args)}`
  )
  console.log(
    `[convert] using system browser: ${channel}${executablePath ? ` @ ${executablePath}` : ''} (v${browserVersion})`
  )

  /** @type {string[]} */
  const savedFiles = []
  let cadDataMisses = 0
  /** @type {string[]} */
  const missSamples = []
  /** @type {string[]} */
  const pageMessages = []

  try {
    const context = await browser.newContext({ acceptDownloads: true })
    const page = await context.newPage()

    page.on('console', (msg) => {
      const text = msg.text()
      const type = msg.type()
      const line = `[page.${type}] ${text}`
      if (
        /timed out|font|idle|error|warn|missing|fail|geometry|export/i.test(
          text
        ) ||
        type === 'error' ||
        type === 'warning'
      ) {
        pageMessages.push(line)
        if (DEBUG_ENABLED) {
          if (type === 'error') console.error(`[convert] ${line}`)
          else console.warn(`[convert] ${line}`)
        }
      }
    })
    page.on('pageerror', (err) => {
      const line = `[pageerror] ${err instanceof Error ? err.message : String(err)}`
      pageMessages.push(line)
      console.error(`[convert] ${line}`)
    })
    page.on('response', (res) => {
      try {
        const u = res.url()
        if (!/\/cad-data\//i.test(u)) return
        if (res.status() < 400) return
        cadDataMisses++
        if (missSamples.length < 20) missSamples.push(`${res.status()} ${u}`)
        console.warn(`[convert] local cad-data miss: ${res.status()} ${u}`)
        void appendLog(logfile, `[convert] local cad-data miss: ${res.status()} ${u}`)
      } catch {
        // ignore
      }
    })

    await dbg(
      logfile,
      `goto ${server.url}/index.html baseUrl=${localCadDataBaseUrl} drawingUrl=${drawingUrl ?? '(blank)'}`
    )
    await page.goto(`${server.url}/index.html`, { waitUntil: 'networkidle' })

    const tScript = Date.now()
    try {
      await page.evaluate(
        async ({
          name,
          drawingUrl: url,
          script,
          locale,
          mode: openMode,
          startBlank,
          openViewMode: viewMode,
          drawNoPlotLayers: noPlot,
          circleSides: sides,
          baseUrl,
          saveBaseUrl
        }) => {
          return window.runCadScript(name, url, script, {
            locale,
            mode: openMode,
            startBlank,
            openViewMode: viewMode,
            drawNoPlotLayers: noPlot,
            circleSides: sides,
            baseUrl,
            saveBaseUrl
          })
        },
        {
          name: fileName,
          drawingUrl,
          script: scriptText,
          locale: options.locale,
          mode,
          startBlank: !absoluteInput,
          openViewMode,
          drawNoPlotLayers,
          circleSides,
          baseUrl: localCadDataBaseUrl,
          saveBaseUrl: `${server.url}/__cli_save__/`
        }
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await dbg(logfile, `script failed: ${message}`, 'error')
      for (const m of pageMessages.slice(-30)) await appendLog(logfile, m)
      throw error
    }

    const exported = server.takeSavedFiles()
    await dbg(
      logfile,
      `script done in ${Date.now() - tScript}ms files=${exported.length}`
    )
    const idleTimedOut = pageMessages.some((m) =>
      /Timed out waiting for (scene idle|deferred geometry)/i.test(m)
    )
    if (idleTimedOut) {
      await dbg(
        logfile,
        `WARN 场景空闲/延迟几何超时 → 导出不完整（当前 batches 会偏少）。` +
          `已尝试 idleTimeoutMs=${idleTimeoutMs} swiftShader=${useSwift}；` +
          `若仍超时可增大 CONVERT_IDLE_TIMEOUT_MS（毫秒）或强制 CONVERT_USE_SWIFTSHADER=1`,
        'warn'
      )
    }

    for (const dest of exported) {
      if (dest.toLowerCase().endsWith('.zip')) {
        const before = await inspectAcexZip(dest)
        await dbg(logfile, `zip BEFORE sanitize ${JSON.stringify(before)}`)
        if (before.astronomicalExtents) {
          await dbg(
            logfile,
            `WARN viewExtents 天文数字（Fit 后图元会像「全丢」），将执行 sanitize`,
            'warn'
          )
        }

        const sanitizeResult = await sanitizeAcexZipFile(dest, {
          appendLog: (line) => appendLog(logfile, line)
        })
        await dbg(
          logfile,
          `sanitize changed=${sanitizeResult.changed} removedBatches=${sanitizeResult.removedBatches ?? 0} ` +
            `layers=${(sanitizeResult.layers || []).join(',') || '-'}`
        )

        const after = await inspectAcexZip(dest)
        await dbg(logfile, `zip AFTER sanitize ${JSON.stringify(after)}`)
        if (after.astronomicalExtents) {
          await dbg(
            logfile,
            `ERROR sanitize 后 viewExtents 仍异常，请检查 sanitizeAcexOutliers`,
            'error'
          )
        }
        if (
          typeof after.totalBatches === 'number' &&
          after.totalBatches < 20 &&
          inputBytes > 500_000
        ) {
          await dbg(
            logfile,
            `WARN 大图纸但 totalBatches=${after.totalBatches} 过少，疑似转换不完整 ` +
              `(fontMisses=${cadDataMisses} pageMsgs=${pageMessages.length})`,
            'warn'
          )
        }
      }

      savedFiles.push(dest)
      await dbg(logfile, `saved ${dest}`)
    }

    if (pageMessages.length) {
      await dbg(logfile, `page messages (${pageMessages.length}):`)
      for (const m of pageMessages.slice(-50)) await appendLog(logfile, `  ${m}`)
    }
    if (cadDataMisses > 0) {
      await dbg(
        logfile,
        `cad-data misses=${cadDataMisses} samples=${JSON.stringify(missSamples)}`,
        'warn'
      )
      console.warn(
        `[convert] ${cadDataMisses} cad-data asset(s) missing locally`
      )
    }

    await dbg(
      logfile,
      `=== convert done in ${Date.now() - t0}ms saved=${savedFiles.length} ` +
        `localMisses=${cadDataMisses} log=${logfile} ===`
    )
    return { outputDir, savedFiles, logfile }
  } finally {
    await browser.close()
    await server.close()
  }
}
