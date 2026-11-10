#!/usr/bin/env node
/**
 * 批量 CLI 转换：DWG/DXF → ACEX multi zip
 * （天正预处理与 HTTP 服务同一套逻辑）
 *
 * Usage:
 *   node scripts/convert.mjs <drawing.dwg|dxf|dir> [outputDir]
 *   npm run convert -- ./drawings ./out
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { maybeConvertTianzhengToT3 } from '../lib/t3Convert.mjs'
import { runExportToZip } from '../lib/runExport.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CAD_DATA = path.join(ROOT, 'cad-data')
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
  const stem = path.basename(inputPath, path.extname(inputPath))
  const workDir = path.join(outputDir, '.work', stem)
  await mkdir(workDir, { recursive: true })

  const t3 = await maybeConvertTianzhengToT3(inputPath, workDir)
  console.log(
    `T3: converted=${t3.converted} skipped=${t3.skipped} reason=${t3.reason}` +
      (t3.detect
        ? ` matches=${t3.detect.matches.map((m) => m.signature).join(',') || '(none)'}`
        : '')
  )

  const zipPath = path.join(outputDir, `${stem}.zip`)
  const result = await runExportToZip({
    inputPath: t3.inputPath,
    outputZip: zipPath,
    fontsDir: CAD_DATA,
    logfile: path.join(workDir, 'convert.log')
  })
  console.log(`OK → ${result.outputZip} (${result.durationMs}ms, parser=${result.dwgParser})`)
  return result
}

async function main() {
  const input = process.argv[2]
  const outputDir = path.resolve(process.argv[3] ?? './out')

  if (!input || !existsSync(input)) {
    console.error('Usage: node scripts/convert.mjs <drawing|dir> [outputDir]')
    process.exitCode = 1
    return
  }

  const fontsJson = path.join(CAD_DATA, 'fonts', 'fonts.json')
  if (!existsSync(fontsJson)) {
    console.error(`Missing ${fontsJson}. Run: npm run sync:cad-data`)
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
