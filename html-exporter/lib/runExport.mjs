/**
 * 调用 @mlightcad/cad-html-exporter（纯 Node，无浏览器）导出 ACEX multi zip。
 * 对齐官方预渲染路径：
 * https://github.com/mlightcad/cad-viewer-nextjs-demo
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseBackground, resolveDwgParser } from './resolveDwgParser.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONVERT_ONE = path.join(ROOT, 'scripts', 'convert-one.mjs')

/**
 * 在独立子进程中导出（官方建议一图一进程，避免主线程互相抢）。
 *
 * @param {object} opts
 * @param {string} opts.inputPath
 * @param {string} opts.outputZip
 * @param {string} opts.fontsDir
 * @param {string} [opts.logfile]
 * @param {'black'|'white'|'space'} [opts.background]
 * @returns {Promise<{ outputZip: string, dwgParser: string, durationMs: number }>}
 */
export async function runExportToZip(opts) {
  const inputPath = path.resolve(opts.inputPath)
  const outputZip = path.resolve(opts.outputZip)
  const fontsDir = path.resolve(opts.fontsDir)
  const background = parseBackground(opts.background)
  const logfile = opts.logfile
    ? path.resolve(opts.logfile)
    : path.join(path.dirname(outputZip), 'convert.log')

  if (!existsSync(inputPath)) {
    throw new Error(`Input drawing not found: ${inputPath}`)
  }
  if (!existsSync(path.join(fontsDir, 'fonts', 'fonts.json')) &&
      !existsSync(path.join(fontsDir, 'fonts.json'))) {
    throw new Error(
      `Missing fonts catalog under fontsDir=${fontsDir}. Run: npm run sync:cad-data`
    )
  }
  if (!existsSync(CONVERT_ONE)) {
    throw new Error(`Missing convert script: ${CONVERT_ONE}`)
  }

  await mkdir(path.dirname(outputZip), { recursive: true })
  await mkdir(path.dirname(logfile), { recursive: true })

  const dwgParser = await resolveDwgParser()
  const started = Date.now()
  const header =
    `=== convert start ${new Date().toISOString()} ===\n` +
    `input=${inputPath}\n` +
    `outputZip=${outputZip}\n` +
    `fontsDir=${fontsDir}\n` +
    `background=${background}\n` +
    `dwgParser=${dwgParser}\n` +
    `node=${process.version} platform=${process.platform}/${process.arch}\n`

  await writeFile(logfile, header, 'utf8')

  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [CONVERT_ONE, inputPath, outputZip, fontsDir, background],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
        windowsHide: true,
        cwd: ROOT
      }
    )

    let stdout = ''
    let stderr = ''
    const max = 500_000
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      if (stdout.length < max) stdout += text
      process.stdout.write(text)
    })
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      if (stderr.length < max) stderr += text
      process.stderr.write(text)
    })

    child.on('error', reject)
    child.on('close', async (code) => {
      const footer =
        `\n--- child stdout ---\n${stdout.slice(-8000)}\n` +
        `--- child stderr ---\n${stderr.slice(-8000)}\n` +
        `=== convert end code=${code} durationMs=${Date.now() - started} ===\n`
      try {
        await writeFile(logfile, footer, { flag: 'a', encoding: 'utf8' })
      } catch {
        // ignore
      }

      if (code === 0 && existsSync(outputZip)) {
        resolve()
        return
      }
      reject(
        new Error(
          `conversion failed: exporter exited with code ${code}` +
            (stderr.trim() ? ` (${stderr.trim().split(/\r?\n/).pop()})` : '')
        )
      )
    })
  })

  return {
    outputZip,
    dwgParser,
    durationMs: Date.now() - started
  }
}
