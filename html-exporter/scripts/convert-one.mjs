#!/usr/bin/env node
/**
 * Child-process CAD → ACEX multi zip.
 * 对齐 cad-viewer-nextjs-demo/scripts/convert-drawing.mjs，输出改为 zip。
 *
 * Usage:
 *   node scripts/convert-one.mjs <input> <output.zip> <fontsDir> [background]
 *
 * background: black (default) | white | space
 */
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ensureNodeCanvas } from '../lib/ensureNodeCanvas.mjs'
import { parseBackground } from '../lib/resolveDwgParser.mjs'

/** @returns {Promise<'dwg' | 'libredwg'>} */
async function resolveDwgParser() {
  const forced = process.env.DWG_PARSER?.trim().toLowerCase()
  if (forced === 'dwg' || forced === 'libredwg') {
    if (forced === 'dwg') {
      try {
        createRequire(import.meta.url).resolve('@mlightcad/dwg-converter')
      } catch {
        throw new Error(
          'DWG_PARSER=dwg but @mlightcad/dwg-converter is not installed'
        )
      }
    }
    return forced
  }

  try {
    createRequire(import.meta.url).resolve('@mlightcad/dwg-converter')
    return 'dwg'
  } catch {
    return 'libredwg'
  }
}

async function main() {
  const [, , input, outputZip, fontsDir, backgroundArg] = process.argv
  if (!input || !outputZip || !fontsDir) {
    console.error(
      'Usage: convert-one.mjs <input> <output.zip> <fontsDir> [background]'
    )
    process.exit(2)
  }

  const background = parseBackground(backgroundArg)
  const dwgParser = await resolveDwgParser()
  const canvas = await ensureNodeCanvas()
  console.info(
    `[convert-one] dwgParser=${dwgParser} background=${background} canvas=${canvas.enabled ? canvas.reason : `off(${canvas.reason})`}`
  )

  const { exportFileToHtml } = await import('@mlightcad/cad-html-exporter')

  const absZip = path.resolve(outputZip)
  await mkdir(path.dirname(absZip), { recursive: true })
  await rm(absZip, { force: true })

  await exportFileToHtml(path.resolve(input), absZip, {
    exportFormat: 'multi',
    zipPackage: true,
    maxChunkBytes: 10 * 1024 * 1024,
    compressChunks: true,
    viewerMode: 'measure',
    exportInvisibleLayers: true,
    exportLayouts: true,
    background,
    initialView: 'fit',
    fontsDir: path.resolve(fontsDir),
    dwgParser,
    dwgLicenseKey:
      dwgParser === 'dwg' ? process.env.DWG_LICENSE_KEY : undefined
  })

  console.info(`[convert-one] wrote ${absZip}`)
}

main().catch((err) => {
  console.error('[convert-one]', err)
  process.exit(1)
})
