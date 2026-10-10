#!/usr/bin/env node
/**
 * 本地 / 服务器环境对照诊断（不跑转换）。
 *
 * Usage:
 *   node scripts/diagnose.mjs
 *   node scripts/diagnose.mjs .cad-work/out/<jobId>/input.zip
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CAD_DATA = path.join(ROOT, 'cad-data')

function countFiles(dir, re, max = 8000) {
  let n = 0
  if (!existsSync(dir)) return 0
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name)
      if (ent.isDirectory()) walk(full)
      else if (!re || re.test(ent.name)) n++
      if (n >= max) return
    }
  }
  walk(dir)
  return n
}

function pkgVer(name) {
  try {
    const pkgPath = require.resolve(`${name}/package.json`)
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version
  } catch {
    try {
      // 部分包 exports 不暴露 package.json，从入口反推
      const entry = require.resolve(name)
      const root = path.resolve(path.dirname(entry), '..')
      return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
        .version
    } catch {
      return 'MISSING'
    }
  }
}

function chromeCandidates() {
  if (process.platform !== 'win32') {
    return [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium'
    ]
  }
  return [
    process.env.PLAYWRIGHT_CHROME_PATH,
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe')
  ].filter(Boolean)
}

async function inspectZip(zipPath) {
  const { unzipSync, strFromU8 } = await import('fflate')
  const raw = readFileSync(zipPath)
  const entries = unzipSync(new Uint8Array(raw))
  const mp = Object.keys(entries).find((k) => k.endsWith('drawing.acex.json'))
  if (!mp) return { error: 'no manifest' }
  const m = JSON.parse(strFromU8(entries[mp]))
  let line = 0
  let mesh = 0
  for (const c of Object.values(m.chunks || {})) {
    line += c.lineBatchCount || 0
    mesh += c.meshBatchCount || 0
  }
  const ve = m.meta?.viewExtents
  const maxAbs = ve
    ? Math.max(
        Math.abs(ve.minX),
        Math.abs(ve.minY),
        Math.abs(ve.maxX),
        Math.abs(ve.maxY)
      )
    : null
  return {
    zipMB: +(raw.length / 1e6).toFixed(2),
    chunks: Object.keys(m.chunks || {}).length,
    lineBatches: line,
    meshBatches: mesh,
    totalBatches: line + mesh,
    viewExtents: ve,
    astronomical: maxAbs != null && maxAbs > 1e12
  }
}

const fontsJson = path.join(CAD_DATA, 'fonts', 'fonts.json')
const foundChrome = chromeCandidates().find((p) => existsSync(p)) || null

const report = {
  hostname: os.hostname(),
  user: os.userInfo().username,
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  cwd: process.cwd(),
  fuwuRoot: ROOT,
  cli: pkgVer('@mlightcad/cad-simple-viewer-cli'),
  playwright: pkgVer('playwright'),
  chromePath: foundChrome,
  chromeEnv: process.env.PLAYWRIGHT_CHROME_PATH || null,
  cadData: {
    path: CAD_DATA,
    fontsJson: existsSync(fontsJson),
    fontsJsonBytes: existsSync(fontsJson) ? statSync(fontsJson).size : 0,
    fontFiles: countFiles(path.join(CAD_DATA, 'fonts'), /\.(ttf|otf|woff2?|shx)$/i),
    templateFiles: countFiles(path.join(CAD_DATA, 'templates'))
  },
  hints: []
}

if (report.cli !== '1.7.4') {
  report.hints.push(`CLI 版本是 ${report.cli}，本地对照基线为 1.7.4`)
}
if (!report.chromePath) {
  report.hints.push('未找到系统 Chrome/Edge — 易落到旧 Chromium → chunks~80')
}
if (report.cadData.fontFiles < 50) {
  report.hints.push(
    `fontFiles=${report.cadData.fontFiles} 偏少（本机完整约 100+），拷贝时可能漏了 cad-data/fonts`
  )
}
if (!report.cadData.fontsJson) {
  report.hints.push('缺少 cad-data/fonts/fonts.json')
}

console.log(JSON.stringify(report, null, 2))

const zipArg = process.argv[2]
if (zipArg) {
  const zipPath = path.resolve(zipArg)
  if (!existsSync(zipPath)) {
    console.error('zip not found:', zipPath)
    process.exitCode = 1
  } else {
    const stats = await inspectZip(zipPath)
    console.log('\n--- zip ---')
    console.log(JSON.stringify(stats, null, 2))
    if (stats.chunks != null && stats.chunks < 100 && stats.totalBatches < 500) {
      console.log(
        '\n判定参考: chunks~80/batches~402 ≈ 旧 Chromium 或不完整转换；chunks~308/batches~759 ≈ 正常系统 Chrome'
      )
    }
  }
}
