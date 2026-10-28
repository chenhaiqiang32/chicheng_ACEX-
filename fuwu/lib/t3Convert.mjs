/**
 * 天正 DWG 检测 + T3 预处理（调用本机 t3-conv）
 *
 * 流程对齐：
 * https://github.com/mlightcad/cad-viewer/wiki/Supporting-Tianzheng-DWG-Drawings
 * 转换工具：https://github.com/housyty/t3-conv
 *
 * 环境变量：
 *   T3_MODE=auto|always|off     默认 off（关闭天正预处理，直接走 ACEX）
 *   T3CONV_EXE                  t3conv.exe 绝对路径（推荐）
 *   T3CONV_TIMEOUT_SECONDS      1..900，默认 600
 *   T3CONV_TANGENT_ROOT / T3CONV_AUTOCAD_ROOT  传给子进程（可选，也可写在 t3conv.ini）
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** @typedef {'auto'|'always'|'off'} T3Mode */

/**
 * 天正自定义实体 / 应用签名（ASCII 与 UTF-16LE 都会扫）
 * 仅命中 AcDbProxyEntity 不够（其它厂商也有代理），故不单独列入。
 */
export const TIANZHENG_SIGNATURES = Object.freeze([
  'TCH_',
  'TArch',
  'TDbWall',
  'TDbDoor',
  'TDbWindow',
  'TDbColumn',
  'TDb',
  'Tangent',
  'TANGENT'
])

/** @type {Promise<void>} */
let t3QueueTail = Promise.resolve()

/**
 * @returns {T3Mode}
 */
export function getT3Mode() {
  const raw = String(process.env.T3_MODE || 'off').trim().toLowerCase()
  if (raw === 'always' || raw === 'off' || raw === 'auto') return raw
  return 'off'
}

/**
 * 解析 t3conv.exe 路径：T3CONV_EXE > 常见部署路径
 * @returns {string|null}
 */
export function resolveT3convExe() {
  const fromEnv = String(process.env.T3CONV_EXE || '').trim()
  if (fromEnv) return path.resolve(fromEnv)

  const candidates = [
    'D:\\chenhaiqiang\\tianzheng\\t3-conv\\t3conv.exe',
    'D:\\work\\tianzheng\\t3-conv\\t3conv.exe',
    'D:\\work\\t3-conv\\t3conv.exe',
    path.join(process.cwd(), 't3-conv', 't3conv.exe'),
    path.join(process.cwd(), '..', 't3-conv', 't3conv.exe')
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/**
 * @returns {number}
 */
export function getT3TimeoutSeconds() {
  const n = Number(process.env.T3CONV_TIMEOUT_SECONDS || 600)
  if (!Number.isFinite(n) || n < 1) return 600
  if (n > 900) return 900
  return Math.floor(n)
}

/**
 * @returns {{ mode: T3Mode, exe: string|null, exeExists: boolean, timeoutSeconds: number, platform: string, ready: boolean }}
 */
export function getT3Health() {
  const mode = getT3Mode()
  const exe = resolveT3convExe()
  const exeExists = Boolean(exe && existsSync(exe))
  const platform = process.platform
  const ready =
    mode === 'off' ||
    (platform === 'win32' && exeExists && (mode === 'auto' || mode === 'always'))
  return {
    mode,
    exe,
    exeExists,
    timeoutSeconds: getT3TimeoutSeconds(),
    platform,
    ready
  }
}

/**
 * 在 buffer 中查找 needle 的 ASCII 与 UTF-16LE 出现次数
 * @param {Buffer} buf
 * @param {string} needle
 * @returns {{ ascii: number, utf16le: number }}
 */
function countSignature(buf, needle) {
  const ascii = Buffer.from(needle, 'ascii')
  const utf16 = Buffer.alloc(needle.length * 2)
  for (let i = 0; i < needle.length; i++) {
    utf16[i * 2] = needle.charCodeAt(i) & 0xff
    utf16[i * 2 + 1] = 0
  }
  return {
    ascii: countBuffer(buf, ascii),
    utf16le: countBuffer(buf, utf16)
  }
}

/**
 * @param {Buffer} hay
 * @param {Buffer} needle
 */
function countBuffer(hay, needle) {
  if (!needle.length || hay.length < needle.length) return 0
  let count = 0
  let i = 0
  while (i <= hay.length - needle.length) {
    const idx = hay.indexOf(needle, i)
    if (idx < 0) break
    count++
    i = idx + needle.length
  }
  return count
}

/**
 * 检测 DWG 是否含天正自定义实体 / 应用签名
 * @param {string|Buffer} fileOrBuffer 文件路径或已读入的 Buffer
 * @returns {Promise<{ isTianzheng: boolean, matches: Array<{ signature: string, ascii: number, utf16le: number }> }>}
 */
export async function detectTianzhengDwg(fileOrBuffer) {
  const buf = Buffer.isBuffer(fileOrBuffer)
    ? fileOrBuffer
    : await readFile(fileOrBuffer)

  /** @type {Array<{ signature: string, ascii: number, utf16le: number }>} */
  const matches = []
  for (const signature of TIANZHENG_SIGNATURES) {
    const { ascii, utf16le } = countSignature(buf, signature)
    if (ascii > 0 || utf16le > 0) {
      matches.push({ signature, ascii, utf16le })
    }
  }

  return {
    isTianzheng: matches.length > 0,
    matches
  }
}

/**
 * 串行队列：同时只跑一个 t3conv（复用热宿主，避免全局互斥空等）
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function enqueueT3(fn) {
  const run = t3QueueTail.then(fn, fn)
  t3QueueTail = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/**
 * 调用 t3conv.exe 将源 DWG 转为 T3 DWG（绝对路径）
 * @param {{ sourcePath: string, targetPath: string, logPath?: string, timeoutSeconds?: number }} opts
 * @returns {Promise<{ targetPath: string, durationMs: number, logTail: string }>}
 */
export function runT3conv(opts) {
  return enqueueT3(() => runT3convUnlocked(opts))
}

/**
 * @param {{ sourcePath: string, targetPath: string, logPath?: string, timeoutSeconds?: number }} opts
 */
async function runT3convUnlocked(opts) {
  if (process.platform !== 'win32') {
    throw new Error(
      'T3 conversion requires Windows (t3-conv + Tianzheng TArch + AutoCAD)'
    )
  }

  const exe = resolveT3convExe()
  if (!exe || !existsSync(exe)) {
    throw new Error(
      't3conv.exe not found. Set T3CONV_EXE to an absolute path under an ASCII-only directory (e.g. D:\\work\\tianzheng\\t3-conv\\t3conv.exe)'
    )
  }

  const sourcePath = path.resolve(opts.sourcePath)
  const targetPath = path.resolve(opts.targetPath)
  const logPath = opts.logPath
    ? path.resolve(opts.logPath)
    : path.join(path.dirname(targetPath), 't3conv.log')
  const timeoutSeconds = opts.timeoutSeconds ?? getT3TimeoutSeconds()

  if (!path.isAbsolute(sourcePath) || !path.isAbsolute(targetPath)) {
    throw new Error('t3-conv requires absolute source/target paths')
  }
  if (!existsSync(sourcePath)) {
    throw new Error(`T3 source missing: ${sourcePath}`)
  }

  const args = [
    '-s',
    sourcePath,
    '-o',
    targetPath,
    '--log',
    logPath,
    '--timeout-seconds',
    String(timeoutSeconds)
  ]

  const started = Date.now()
  const { code, stdout, stderr } = await spawnT3conv(exe, args, timeoutSeconds)
  const durationMs = Date.now() - started

  let logTail = ''
  try {
    if (existsSync(logPath)) {
      const text = await readFile(logPath, 'utf8')
      logTail = text.slice(-4000)
    }
  } catch {
    // ignore
  }

  const ok =
    code === 0 && existsSync(targetPath) && (await fileSize(targetPath)) > 0

  if (!ok) {
    const detail =
      extractLogError(logTail) ||
      stderr.trim() ||
      stdout.trim() ||
      `exitCode=${code}`
    throw new Error(`T3 conversion failed: ${detail}`)
  }

  return { targetPath, durationMs, logTail }
}

/**
 * @param {string} exe
 * @param {string[]} args
 * @param {number} timeoutSeconds
 */
function spawnT3conv(exe, args, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
    const child = spawn(exe, args, {
      windowsHide: true,
      // 继承调用方环境，便于 T3CONV_TANGENT_ROOT / T3CONV_AUTOCAD_ROOT
      env: { ...process.env },
      cwd: path.dirname(exe)
    })

    let stdout = ''
    let stderr = ''
    const maxCapture = 200_000
    child.stdout.on('data', (chunk) => {
      if (stdout.length < maxCapture) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < maxCapture) stderr += chunk.toString('utf8')
    })

    // 比工具自身 timeout 略宽裕，避免 Node 抢先杀进程留下无主 acad
    const killTimer = setTimeout(
      () => {
        try {
          child.kill()
        } catch {
          // ignore
        }
        reject(
          new Error(
            `T3 conversion timed out after ${timeoutSeconds + 60}s (Node watchdog)`
          )
        )
      },
      (timeoutSeconds + 60) * 1000
    )

    child.on('error', (err) => {
      clearTimeout(killTimer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(killTimer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

/**
 * @param {string} filePath
 */
async function fileSize(filePath) {
  const buf = await readFile(filePath)
  return buf.length
}

/**
 * @param {string} logText
 */
function extractLogError(logText) {
  if (!logText) return ''
  const lines = logText.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    const m = line.match(/^error=(.+)$/i)
    if (m) return m[1].trim()
    if (/status=failure/i.test(line)) {
      for (let j = i; j < Math.min(lines.length, i + 8); j++) {
        const em = lines[j].match(/^error=(.+)$/i)
        if (em) return em[1].trim()
      }
      return 'status=failure'
    }
  }
  return ''
}

/**
 * 预处理：按需把 DWG 转为 T3，返回最终应送给 ACEX 的路径
 *
 * - DXF / T3_MODE=off → 跳过，直接用原图走 ACEX（不报失败）
 * - auto：仅检测到天正签名时转换；转换失败则回退原图继续 ACEX
 * - always：所有 DWG 都转换；转换失败同样回退原图
 *
 * @param {string} inputPath 已落盘的图纸路径
 * @param {string} workDir 任务工作目录（写 input_t3.dwg / t3conv.log）
 * @returns {Promise<{
 *   inputPath: string,
 *   converted: boolean,
 *   skipped: boolean,
 *   reason: string,
 *   detect: { isTianzheng: boolean, matches: Array<{ signature: string, ascii: number, utf16le: number }> } | null,
 *   durationMs: number | null
 * }>}
 */
export async function maybeConvertTianzhengToT3(inputPath, workDir) {
  const ext = path.extname(inputPath).toLowerCase()
  const mode = getT3Mode()

  if (ext !== '.dwg') {
    return {
      inputPath,
      converted: false,
      skipped: true,
      reason: 'not_dwg',
      detect: null,
      durationMs: null
    }
  }

  // off：不调用 t3-conv，原图直接交给后续 ACEX
  if (mode === 'off') {
    return {
      inputPath,
      converted: false,
      skipped: true,
      reason: 't3_mode_off',
      detect: null,
      durationMs: null
    }
  }

  const detect = await detectTianzhengDwg(inputPath)
  const needConvert = mode === 'always' || detect.isTianzheng

  if (!needConvert) {
    return {
      inputPath,
      converted: false,
      skipped: true,
      reason: 'no_tianzheng_signature',
      detect,
      durationMs: null
    }
  }

  if (process.platform !== 'win32') {
    console.warn(
      `[t3] Tianzheng detected but platform=${process.platform}; falling back to original DWG (mode=${mode})`
    )
    return {
      inputPath,
      converted: false,
      skipped: true,
      reason: 't3_unsupported_platform',
      detect,
      durationMs: null
    }
  }

  const targetPath = path.join(workDir, 'input_t3.dwg')
  const logPath = path.join(workDir, 't3conv.log')
  // 便于排障：把检测结果落到任务目录
  try {
    await writeFile(
      path.join(workDir, 't3-detect.json'),
      JSON.stringify(
        { mode, detect, hostname: os.hostname(), at: new Date().toISOString() },
        null,
        2
      ),
      'utf8'
    )
  } catch {
    // ignore
  }

  try {
    const { durationMs } = await runT3conv({
      sourcePath: inputPath,
      targetPath,
      logPath
    })

    return {
      inputPath: targetPath,
      converted: true,
      skipped: false,
      reason: mode === 'always' ? 't3_mode_always' : 'tianzheng_signature',
      detect,
      durationMs
    }
  } catch (err) {
    // 天正预处理失败不阻断整单：回退原图继续 ACEX（天正实体可能缺失）
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[t3] conversion failed, falling back to original DWG: ${msg}`)
    return {
      inputPath,
      converted: false,
      skipped: true,
      reason: 't3_failed_fallback',
      detect,
      durationMs: null
    }
  }
}
