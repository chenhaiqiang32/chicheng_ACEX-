/**
 * Node 下为 OLE/EMF 栅格化补齐 Canvas 能力。
 *
 * @mlightcad/emf-converter 只认 OffscreenCanvas / document.createElement('canvas')。
 * 纯 Node 两者都没有时，Excel OLE2FRAME 预览（WMF/EMF）会栅格化失败，
 * 导出结果里表格只剩透明占位框。
 *
 * 用 @napi-rs/canvas 注入 OffscreenCanvas + createImageBitmap（可选）。
 *
 * @returns {Promise<{ enabled: boolean, reason?: string }>}
 */
let ensured = null

export async function ensureNodeCanvas() {
  if (ensured) return ensured

  if (typeof globalThis.OffscreenCanvas === 'function') {
    ensured = { enabled: true, reason: 'native_offscreencanvas' }
    return ensured
  }

  let canvasMod
  try {
    canvasMod = await import('@napi-rs/canvas')
  } catch (err) {
    ensured = {
      enabled: false,
      reason: `napi_canvas_missing: ${err instanceof Error ? err.message : String(err)}`
    }
    return ensured
  }

  const { createCanvas, loadImage, GlobalFonts } = canvasMod

  // Register common CJK faces from Windows fonts when present (Excel OLE text).
  try {
    const windir = process.env.WINDIR || 'C:\\Windows'
    const fontDir = `${windir}\\Fonts`
    const candidates = [
      ['simsun.ttc', 'SimSun'],
      ['simsunb.ttf', 'SimSun'],
      ['msyh.ttc', 'Microsoft YaHei'],
      ['msyhbd.ttc', 'Microsoft YaHei'],
      ['simhei.ttf', 'SimHei'],
      ['simkai.ttf', 'KaiTi']
    ]
    for (const [file, family] of candidates) {
      try {
        GlobalFonts.registerFromPath(`${fontDir}\\${file}`, family)
      } catch {
        // ignore missing faces
      }
    }
  } catch {
    // non-Windows or font register failed — continue with defaults
  }

  class NodeOffscreenCanvas {
    /** @param {number} width @param {number} height */
    constructor(width, height) {
      this._canvas = createCanvas(Math.max(1, width | 0), Math.max(1, height | 0))
    }

    get width() {
      return this._canvas.width
    }

    set width(value) {
      this._canvas.width = Math.max(1, value | 0)
    }

    get height() {
      return this._canvas.height
    }

    set height(value) {
      this._canvas.height = Math.max(1, value | 0)
    }

    /**
     * @param {string} type
     * @param {unknown} [attrs]
     */
    getContext(type, attrs) {
      return this._canvas.getContext(type, attrs)
    }

    /**
     * @param {{ type?: string, quality?: number }} [options]
     * @returns {Promise<Blob>}
     */
    async convertToBlob(options = {}) {
      const type = options.type || 'image/png'
      /** @type {Buffer} */
      let buffer
      if (type === 'image/jpeg' || type === 'image/jpg') {
        buffer = this._canvas.toBuffer('image/jpeg', {
          quality: options.quality ?? 0.92
        })
      } else {
        buffer = this._canvas.toBuffer('image/png')
      }
      return new Blob([buffer], { type })
    }
  }

  globalThis.OffscreenCanvas = NodeOffscreenCanvas

  if (typeof globalThis.createImageBitmap !== 'function') {
    globalThis.createImageBitmap = async (source) => {
      let input = source
      if (source instanceof Blob) {
        input = Buffer.from(await source.arrayBuffer())
      } else if (source instanceof ArrayBuffer) {
        input = Buffer.from(source)
      } else if (ArrayBuffer.isView(source)) {
        input = Buffer.from(source.buffer, source.byteOffset, source.byteLength)
      }
      const image = await loadImage(input)
      // Wrapping into a canvas so drawImage receives a Canvas-compatible source.
      const c = createCanvas(image.width, image.height)
      const ctx = c.getContext('2d')
      ctx.drawImage(image, 0, 0)
      return c
    }
  }

  ensured = { enabled: true, reason: 'napi_rs_canvas' }
  return ensured
}
