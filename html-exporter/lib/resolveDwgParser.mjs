/**
 * DWG 解析器选择（对齐 cad-viewer-nextjs-demo）
 * 1. DWG_PARSER=dwg|libredwg 强制
 * 2. 已安装 @mlightcad/dwg-converter → dwg
 * 3. 否则 → libredwg
 */
import { createRequire } from 'node:module'

/**
 * @returns {Promise<'dwg' | 'libredwg'>}
 */
export async function resolveDwgParser() {
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

/**
 * @returns {'black' | 'white' | 'space'}
 */
export function parseBackground(value) {
  if (value === 'white' || value === 'space') return value
  return 'black'
}
