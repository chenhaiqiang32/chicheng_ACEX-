/**
 * 与 @mlightcad/cad-html-plugin 的 unzipAcExPackageFiles 同逻辑：
 * fflate unzip + 路径安全校验（拒绝 .. / 绝对路径等）。
 * 前端单独实现，避免把整个 cad-html-plugin（含 three）打进浏览器包。
 */
import { unzipSync } from 'fflate'

function isSafeZipPath(path) {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    return false
  }
  const parts = path.split('/')
  return parts.every(
    (part) =>
      part.length > 0 &&
      part !== '.' &&
      part !== '..' &&
      /^[A-Za-z0-9._-]+$/.test(part)
  )
}

/**
 * @param {Uint8Array} bytes
 * @returns {{ path: string, bytes: Uint8Array }[]}
 */
export function unzipAcExPackageFiles(bytes) {
  const entries = unzipSync(bytes)
  const files = []
  for (const [path, data] of Object.entries(entries)) {
    if (!isSafeZipPath(path)) {
      throw new Error('Unsafe path in package archive')
    }
    files.push({ path, bytes: data })
  }
  return files
}
