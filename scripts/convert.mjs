#!/usr/bin/env node
/**
 * 方式二：服务端 / CI 批量转换
 * 使用 @mlightcad/cad-simple-viewer-cli 无头导出 multi ACEX zip
 *
 * Usage:
 *   node scripts/convert.mjs <drawing.dwg|dxf|dir> [outputDir]
 *   npm run convert -- ./drawings ./out
 */
import { runHeadless } from '@mlightcad/cad-simple-viewer-cli'
import { existsSync } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(__dirname, 'export-html-multi.scr')
const DRAWING_EXT = new Set(['.dwg', '.dxf'])

async function collectDrawings(inputPath) {
  const info = await stat(inputPath)
  if (info.isFile()) {
    const ext = path.extname(inputPath).toLowerCase()
    if (!DRAWING_EXT.has(ext)) {
      throw new Error(`Not a DWG/DXF: ${inputPath}`)
    }
    return [path.resolve(inputPath)]
  }

  const out = []
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (DRAWING_EXT.has(path.extname(entry.name).toLowerCase())) {
        out.push(full)
      }
    }
  }
  await walk(inputPath)
  return out
}

async function convertOne(inputPath, outputDir) {
  console.log(`\n=== Converting: ${inputPath} ===`)
  const { outputDir: out, savedFiles } = await runHeadless({
    inputPath,
    scriptPath: SCRIPT,
    outputDir,
    mode: 'read'
  })
  console.log(`OK → ${out}`)
  for (const f of savedFiles ?? []) console.log(`  - ${f}`)
  return savedFiles
}

async function main() {
  const input = process.argv[2]
  const outputDir = path.resolve(process.argv[3] ?? './out')

  if (!input || !existsSync(input)) {
    console.error('Usage: node scripts/convert.mjs <drawing|dir> [outputDir]')
    process.exitCode = 1
    return
  }
  if (!existsSync(SCRIPT)) {
    console.error(`Missing script: ${SCRIPT}`)
    process.exitCode = 1
    return
  }

  await mkdir(outputDir, { recursive: true })
  const drawings = await collectDrawings(path.resolve(input))
  if (!drawings.length) {
    console.error('No .dwg/.dxf found')
    process.exitCode = 1
    return
  }

  console.log(`Found ${drawings.length} drawing(s). Output: ${outputDir}`)
  let failed = 0
  for (const drawing of drawings) {
    try {
      await convertOne(drawing, outputDir)
    } catch (err) {
      failed++
      console.error(err instanceof Error ? err.message : String(err))
    }
  }

  console.log(`\nDone. success=${drawings.length - failed} failed=${failed}`)
  if (failed) process.exitCode = 1
}

await main()
