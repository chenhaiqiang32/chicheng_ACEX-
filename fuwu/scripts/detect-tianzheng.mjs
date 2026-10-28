#!/usr/bin/env node
/**
 * 检测 DWG 是否含天正自定义实体签名（不启 CAD、不跑 t3-conv）
 *
 * Usage:
 *   node scripts/detect-tianzheng.mjs <file.dwg|dir>
 */
import { detectTianzhengDwg, TIANZHENG_SIGNATURES } from '../lib/t3Convert.mjs'
import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

async function collect(inputPath) {
  const info = await stat(inputPath)
  if (info.isFile()) return [path.resolve(inputPath)]
  const out = []
  for (const entry of await readdir(inputPath, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (path.extname(entry.name).toLowerCase() === '.dwg') {
      out.push(path.join(inputPath, entry.name))
    }
  }
  return out
}

async function main() {
  const input = process.argv[2]
  if (!input || !existsSync(input)) {
    console.error('Usage: node scripts/detect-tianzheng.mjs <file.dwg|dir>')
    console.error('Signatures:', TIANZHENG_SIGNATURES.join(', '))
    process.exitCode = 1
    return
  }

  const files = await collect(path.resolve(input))
  if (!files.length) {
    console.error('No .dwg found')
    process.exitCode = 1
    return
  }

  let hit = 0
  for (const file of files) {
    const result = await detectTianzhengDwg(file)
    const tag = result.isTianzheng ? 'YES' : 'no '
    if (result.isTianzheng) hit++
    const detail = result.matches
      .map((m) => `${m.signature}(a=${m.ascii},u16=${m.utf16le})`)
      .join(', ')
    console.log(`${tag}  ${file}${detail ? `  ← ${detail}` : ''}`)
  }
  console.log(`\nTianzheng=${hit}/${files.length}`)
}

await main()
