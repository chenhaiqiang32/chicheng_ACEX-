/**
 * 转换后清洗 ACEX multi 包：剔除相对主簇离群的 batch（垃圾坐标），
 * 并重写 meta.viewExtents / meta.extents，避免 Fit 时被撑到亚像素空白。
 *
 * 算法与先前 viewer runtime 方案 B 一致：按 batch 中心做 MAD 过滤。
 */
import { gunzipSync, gzipSync, strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

const ACEC_CHUNK_MAGIC = 0x43454341
const ACEX_SNAPSHOT_VERSION = 4

const F_LINE_INDICES = 1
const F_LINE_PATTERN = 2
const F_LINE_DISTANCES = 4
const F_LINE_WIDTH = 8
const F_LINE_RENDER_ORDER = 16
const F_LINE_EXCLUDE_OSNAP = 32

const F_MESH_INDICES = 1
const F_MESH_HATCH = 2
const F_MESH_GRADIENT_FILL = 4
const F_MESH_GRADIENT_POS = 8
const F_MESH_SIDE = 16
const F_MESH_POINTS = 32
const F_MESH_RENDER_ORDER = 64
const F_MESH_TEXTURE = 128

/** MAD 阈值倍数；配合中位对角线下限，与 runtime 补丁一致 */
const MAD_SIGMA = 1.4826
const MAD_K = 8
const DIAG_FLOOR_K = 100

class AcExBinaryWriter {
  constructor() {
    this.chunks = []
    this.length = 0
  }
  writeU8(value) {
    this.chunks.push(Uint8Array.of(value & 0xff))
    this.length += 1
  }
  writeU32(value) {
    const chunk = new Uint8Array(4)
    new DataView(chunk.buffer).setUint32(0, value >>> 0, true)
    this.chunks.push(chunk)
    this.length += 4
  }
  writeI32(value) {
    const chunk = new Uint8Array(4)
    new DataView(chunk.buffer).setInt32(0, value | 0, true)
    this.chunks.push(chunk)
    this.length += 4
  }
  writeF32(value) {
    const chunk = new Uint8Array(4)
    new DataView(chunk.buffer).setFloat32(0, value, true)
    this.chunks.push(chunk)
    this.length += 4
  }
  writeF64(value) {
    const chunk = new Uint8Array(8)
    new DataView(chunk.buffer).setFloat64(0, value, true)
    this.chunks.push(chunk)
    this.length += 8
  }
  writeBytes(bytes) {
    this.chunks.push(bytes)
    this.length += bytes.length
  }
  writeString(value) {
    const bytes = strToU8(value)
    this.writeU32(bytes.length)
    this.writeBytes(bytes)
  }
  writeJson(value) {
    this.writeString(JSON.stringify(value))
  }
  alignTo(alignment) {
    const remainder = this.length % alignment
    if (remainder === 0) return
    const pad = alignment - remainder
    for (let i = 0; i < pad; i++) this.writeU8(0)
  }
  writeFloat32Array(array) {
    this.alignTo(4)
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
    this.writeU32(bytes.length)
    this.writeBytes(bytes)
  }
  writeUint32Array(array) {
    this.alignTo(4)
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
    this.writeU32(bytes.length)
    this.writeBytes(bytes)
  }
  toUint8Array() {
    const result = new Uint8Array(this.length)
    let offset = 0
    for (const chunk of this.chunks) {
      result.set(chunk, offset)
      offset += chunk.length
    }
    return result
  }
}

class AcExBinaryReader {
  constructor(bytes) {
    this.bytes = bytes
    this.offset = 0
  }
  ensureAvailable(byteCount) {
    if (this.offset + byteCount > this.bytes.length) {
      throw new Error('Unexpected end of binary buffer')
    }
  }
  readU8() {
    this.ensureAvailable(1)
    return this.bytes[this.offset++]
  }
  readU32() {
    this.ensureAvailable(4)
    const view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      4
    )
    const value = view.getUint32(0, true)
    this.offset += 4
    return value
  }
  readI32() {
    this.ensureAvailable(4)
    const view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      4
    )
    const value = view.getInt32(0, true)
    this.offset += 4
    return value
  }
  readF32() {
    this.ensureAvailable(4)
    const view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      4
    )
    const value = view.getFloat32(0, true)
    this.offset += 4
    return value
  }
  readF64() {
    this.ensureAvailable(8)
    const view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      8
    )
    const value = view.getFloat64(0, true)
    this.offset += 8
    return value
  }
  readBytes(length) {
    this.ensureAvailable(length)
    const slice = this.bytes.subarray(this.offset, this.offset + length)
    this.offset += length
    return slice
  }
  readString() {
    const length = this.readU32()
    if (length === 0) return ''
    return strFromU8(this.readBytes(length))
  }
  readJson() {
    return JSON.parse(this.readString())
  }
  alignTo(alignment) {
    const remainder = this.offset % alignment
    if (remainder === 0) return
    const pad = alignment - remainder
    this.ensureAvailable(pad)
    this.offset += pad
  }
  readFloat32Array() {
    this.alignTo(4)
    const byteLength = this.readU32()
    if (byteLength === 0) return new Float32Array(0)
    const bytes = this.readBytes(byteLength)
    if (bytes.byteOffset % 4 === 0) {
      return new Float32Array(bytes.buffer, bytes.byteOffset, byteLength / 4)
    }
    const copy = new ArrayBuffer(byteLength)
    new Uint8Array(copy).set(bytes)
    return new Float32Array(copy)
  }
  readUint32Array() {
    this.alignTo(4)
    const byteLength = this.readU32()
    if (byteLength === 0) return new Uint32Array(0)
    const bytes = this.readBytes(byteLength)
    if (bytes.byteOffset % 4 === 0) {
      return new Uint32Array(bytes.buffer, bytes.byteOffset, byteLength / 4)
    }
    const copy = new ArrayBuffer(byteLength)
    new Uint8Array(copy).set(bytes)
    return new Uint32Array(copy)
  }
}

function writeLineBatch(writer, batch) {
  writer.writeString(batch.layer)
  writer.writeU32(batch.color >>> 0)
  writer.writeF64(batch.offset[0])
  writer.writeF64(batch.offset[1])
  writer.writeF64(batch.offset[2])
  writer.writeFloat32Array(batch.positions)
  let flags = 0
  if (batch.indices?.length) flags |= F_LINE_INDICES
  if (batch.linePattern) flags |= F_LINE_PATTERN
  if (batch.lineDistances?.length) flags |= F_LINE_DISTANCES
  if (batch.lineWidth != null && batch.lineWidth > 0) flags |= F_LINE_WIDTH
  if (batch.renderOrder != null && batch.renderOrder !== 0) {
    flags |= F_LINE_RENDER_ORDER
  }
  if (batch.excludeFromOsnap) flags |= F_LINE_EXCLUDE_OSNAP
  writer.writeU8(flags)
  if (flags & F_LINE_INDICES) writer.writeUint32Array(batch.indices)
  if (flags & F_LINE_PATTERN) writer.writeJson(batch.linePattern)
  if (flags & F_LINE_DISTANCES) writer.writeFloat32Array(batch.lineDistances)
  if (flags & F_LINE_WIDTH) writer.writeF32(batch.lineWidth)
  if (flags & F_LINE_RENDER_ORDER) writer.writeI32(batch.renderOrder)
}

function readLineBatch(reader) {
  const layer = reader.readString()
  const color = reader.readU32()
  const offset = [reader.readF64(), reader.readF64(), reader.readF64()]
  const positions = reader.readFloat32Array()
  const flags = reader.readU8()
  const batch = { layer, color, offset, positions }
  if (flags & F_LINE_INDICES) batch.indices = reader.readUint32Array()
  if (flags & F_LINE_PATTERN) batch.linePattern = reader.readJson()
  if (flags & F_LINE_DISTANCES) batch.lineDistances = reader.readFloat32Array()
  if (flags & F_LINE_WIDTH) batch.lineWidth = reader.readF32()
  if (flags & F_LINE_RENDER_ORDER) batch.renderOrder = reader.readI32()
  if (flags & F_LINE_EXCLUDE_OSNAP) batch.excludeFromOsnap = true
  return batch
}

function writeMeshBatch(writer, batch) {
  writer.writeString(batch.layer)
  writer.writeU32(batch.color >>> 0)
  writer.writeF64(batch.offset[0])
  writer.writeF64(batch.offset[1])
  writer.writeF64(batch.offset[2])
  writer.writeFloat32Array(batch.positions)
  let flags = 0
  if (batch.indices?.length) flags |= F_MESH_INDICES
  if (batch.hatchPattern) flags |= F_MESH_HATCH
  if (batch.gradientFill) flags |= F_MESH_GRADIENT_FILL
  if (batch.gradientPositions?.length) flags |= F_MESH_GRADIENT_POS
  if (batch.side != null) flags |= F_MESH_SIDE
  if (batch.points) flags |= F_MESH_POINTS
  if (batch.renderOrder != null && batch.renderOrder !== 0) {
    flags |= F_MESH_RENDER_ORDER
  }
  if (batch.texture?.bytes?.length && batch.uvs?.length >= 2) {
    flags |= F_MESH_TEXTURE
  }
  writer.writeU8(flags)
  if (flags & F_MESH_INDICES) writer.writeUint32Array(batch.indices)
  if (flags & F_MESH_HATCH) writer.writeJson(batch.hatchPattern)
  if (flags & F_MESH_GRADIENT_FILL) writer.writeJson(batch.gradientFill)
  if (flags & F_MESH_GRADIENT_POS) {
    writer.writeFloat32Array(batch.gradientPositions)
  }
  if (flags & F_MESH_SIDE) writer.writeU8(batch.side)
  if (flags & F_MESH_RENDER_ORDER) writer.writeI32(batch.renderOrder)
  if (flags & F_MESH_TEXTURE) {
    writer.writeFloat32Array(batch.uvs)
    writer.writeString(batch.texture.mimeType || 'image/png')
    writer.writeU32(batch.texture.bytes.byteLength)
    writer.writeBytes(batch.texture.bytes)
  }
}

function readMeshBatch(reader) {
  const layer = reader.readString()
  const color = reader.readU32()
  const offset = [reader.readF64(), reader.readF64(), reader.readF64()]
  const positions = reader.readFloat32Array()
  const flags = reader.readU8()
  const batch = { layer, color, offset, positions }
  if (flags & F_MESH_INDICES) batch.indices = reader.readUint32Array()
  if (flags & F_MESH_HATCH) batch.hatchPattern = reader.readJson()
  if (flags & F_MESH_GRADIENT_FILL) batch.gradientFill = reader.readJson()
  if (flags & F_MESH_GRADIENT_POS) {
    batch.gradientPositions = reader.readFloat32Array()
  }
  if (flags & F_MESH_SIDE) batch.side = reader.readU8()
  if (flags & F_MESH_POINTS) batch.points = true
  if (flags & F_MESH_RENDER_ORDER) batch.renderOrder = reader.readI32()
  if (flags & F_MESH_TEXTURE) {
    batch.uvs = reader.readFloat32Array()
    const mimeType = reader.readString() || 'image/png'
    const byteLength = reader.readU32()
    batch.texture = { mimeType, bytes: reader.readBytes(byteLength) }
  }
  return batch
}

function encodeChunkBinary(chunk) {
  const writer = new AcExBinaryWriter()
  writer.writeU32(ACEC_CHUNK_MAGIC)
  writer.writeU8(ACEX_SNAPSHOT_VERSION)
  writer.writeU8(0)
  writer.writeU8(0)
  writer.writeU8(0)
  writer.writeString(chunk.layoutBtrId)
  writer.writeU32(chunk.lineBatches.length)
  for (const batch of chunk.lineBatches) writeLineBatch(writer, batch)
  writer.writeU32(chunk.meshBatches.length)
  for (const batch of chunk.meshBatches) writeMeshBatch(writer, batch)
  return writer.toUint8Array()
}

function decodeChunkBinary(bytes) {
  const reader = new AcExBinaryReader(bytes)
  const magic = reader.readU32()
  if (magic !== ACEC_CHUNK_MAGIC) throw new Error('Invalid chunk magic')
  const version = reader.readU8()
  reader.readU8()
  reader.readU8()
  reader.readU8()
  if (version !== ACEX_SNAPSHOT_VERSION) {
    throw new Error(`Unsupported chunk version: ${version}`)
  }
  const layoutBtrId = reader.readString()
  const lineCount = reader.readU32()
  const lineBatches = []
  for (let i = 0; i < lineCount; i++) lineBatches.push(readLineBatch(reader))
  const meshCount = reader.readU32()
  const meshBatches = []
  for (let i = 0; i < meshCount; i++) meshBatches.push(readMeshBatch(reader))
  return { version, layoutBtrId, lineBatches, meshBatches }
}

function encodeChunkGzip(chunk) {
  const uncompressed = encodeChunkBinary(chunk)
  return { uncompressed, compressed: gzipSync(uncompressed) }
}

function decodeChunkGzip(compressed) {
  return decodeChunkBinary(gunzipSync(compressed))
}

function batchBox(batch) {
  const positions = batch.positions
  if (!positions || positions.length < 3) return null
  const ox = batch.offset[0]
  const oy = batch.offset[1]
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i] + ox
    const y = positions[i + 1] + oy
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  if (!Number.isFinite(minX)) return null
  return { minX, minY, maxX, maxY }
}

function medianOf(values) {
  if (!values.length) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** 绝对坐标上限：超过则视为垃圾（CAD 厂区图通常 < 1e8） */
const ABS_COORD_LIMIT = 1e12

function isSaneBox(box) {
  if (!box) return false
  const vals = [box.minX, box.minY, box.maxX, box.maxY]
  if (!vals.every((v) => Number.isFinite(v))) return false
  if (vals.some((v) => Math.abs(v) > ABS_COORD_LIMIT)) return false
  const w = box.maxX - box.minX
  const h = box.maxY - box.minY
  if (!(w >= 0) || !(h >= 0)) return false
  if (w > ABS_COORD_LIMIT || h > ABS_COORD_LIMIT) return false
  return true
}

function isAstronomicalExtents(ext) {
  if (!ext) return false
  return !isSaneBox(ext)
}

/**
 * @param {{ box: {minX:number,minY:number,maxX:number,maxY:number} }[]} items
 * @returns {Set<number>} indices kept
 */
function selectInlierIndices(items) {
  const kept = new Set(items.map((_, i) => i))
  if (items.length < 3) return kept

  // 先丢掉绝对坐标爆炸的 batch（1.7.1 偶发 1e+60~1e+75）
  const sane = []
  for (let i = 0; i < items.length; i++) {
    if (isSaneBox(items[i].box)) sane.push(i)
  }
  if (sane.length >= Math.max(3, Math.ceil(items.length * 0.5))) {
    // 在 sane 子集上再做 MAD
    const sub = sane.map((i) => items[i])
    const centersX = sub.map((it) => (it.box.minX + it.box.maxX) / 2)
    const centersY = sub.map((it) => (it.box.minY + it.box.maxY) / 2)
    const diags = sub.map((it) =>
      Math.hypot(it.box.maxX - it.box.minX, it.box.maxY - it.box.minY)
    )
    const medCx = medianOf(centersX)
    const medCy = medianOf(centersY)
    const medDiag = medianOf(diags)
    const madX = medianOf(centersX.map((x) => Math.abs(x - medCx)))
    const madY = medianOf(centersY.map((y) => Math.abs(y - medCy)))
    const threshX = Math.max(madX * MAD_SIGMA * MAD_K, medDiag * DIAG_FLOOR_K, 1e-6)
    const threshY = Math.max(madY * MAD_SIGMA * MAD_K, medDiag * DIAG_FLOOR_K, 1e-6)

    const filtered = []
    for (let si = 0; si < sane.length; si++) {
      const cx = centersX[si]
      const cy = centersY[si]
      if (Math.abs(cx - medCx) <= threshX && Math.abs(cy - medCy) <= threshY) {
        filtered.push(sane[si])
      }
    }
    if (filtered.length >= Math.max(3, Math.ceil(items.length * 0.5))) {
      return new Set(filtered)
    }
    return new Set(sane)
  }

  if (sane.length > 0) return new Set(sane)

  const centersX = items.map((it) => (it.box.minX + it.box.maxX) / 2)
  const centersY = items.map((it) => (it.box.minY + it.box.maxY) / 2)
  const diags = items.map((it) =>
    Math.hypot(it.box.maxX - it.box.minX, it.box.maxY - it.box.minY)
  )
  const medCx = medianOf(centersX)
  const medCy = medianOf(centersY)
  const medDiag = medianOf(diags)
  const madX = medianOf(centersX.map((x) => Math.abs(x - medCx)))
  const madY = medianOf(centersY.map((y) => Math.abs(y - medCy)))
  const threshX = Math.max(madX * MAD_SIGMA * MAD_K, medDiag * DIAG_FLOOR_K, 1e-6)
  const threshY = Math.max(madY * MAD_SIGMA * MAD_K, medDiag * DIAG_FLOOR_K, 1e-6)

  const filtered = []
  for (let i = 0; i < items.length; i++) {
    const cx = centersX[i]
    const cy = centersY[i]
    if (Math.abs(cx - medCx) <= threshX && Math.abs(cy - medCy) <= threshY) {
      filtered.push(i)
    }
  }
  if (filtered.length >= Math.max(3, Math.ceil(items.length * 0.5))) {
    return new Set(filtered)
  }
  return kept
}

function unionBoxes(boxes) {
  if (!boxes.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const b of boxes) {
    if (b.minX < minX) minX = b.minX
    if (b.minY < minY) minY = b.minY
    if (b.maxX > maxX) maxX = b.maxX
    if (b.maxY > maxY) maxY = b.maxY
  }
  return { minX, minY, maxX, maxY }
}

function isSafeZipPath(p) {
  if (!p || p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false
  return p.split('/').every(
    (part) =>
      part.length > 0 &&
      part !== '.' &&
      part !== '..' &&
      /^[A-Za-z0-9._-]+$/.test(part)
  )
}

/**
 * @param {Uint8Array|Buffer} zipBytes
 * @returns {{ bytes: Uint8Array, changed: boolean, removedBatches: number, viewExtents: object|null, layers: string[] }}
 */
export function sanitizeAcexZipBytes(zipBytes) {
  const entries = unzipSync(new Uint8Array(zipBytes))
  const manifestPath = Object.keys(entries).find((p) => p.endsWith('drawing.acex.json'))
  if (!manifestPath) {
    return {
      bytes: new Uint8Array(zipBytes),
      changed: false,
      removedBatches: 0,
      viewExtents: null,
      layers: []
    }
  }

  const manifest = JSON.parse(strFromU8(entries[manifestPath]))
  if (!manifest.chunks || typeof manifest.chunks !== 'object') {
    return {
      bytes: new Uint8Array(zipBytes),
      changed: false,
      removedBatches: 0,
      viewExtents: manifest.meta?.viewExtents ?? null,
      layers: []
    }
  }

  /** @type {Map<string, { href: string, metaKey: string, chunk: any, items: {kind:'line'|'mesh', index:number, batch:any, box:any}[] }[]>} */
  const byLayout = new Map()
  let totalRemoved = 0
  /** @type {string[]} */
  const removedLayers = []

  for (const [metaKey, meta] of Object.entries(manifest.chunks)) {
    const href = meta.href
    if (!href || !entries[href]) continue
    const chunk = decodeChunkGzip(entries[href])
    const items = []
    chunk.lineBatches.forEach((batch, index) => {
      const box = batchBox(batch)
      if (box) items.push({ kind: 'line', index, batch, box })
    })
    chunk.meshBatches.forEach((batch, index) => {
      const box = batchBox(batch)
      if (box) items.push({ kind: 'mesh', index, batch, box })
    })
    const layoutId = chunk.layoutBtrId || meta.layoutBtrId || '_'
    if (!byLayout.has(layoutId)) byLayout.set(layoutId, [])
    byLayout.get(layoutId).push({ href, metaKey, chunk, meta, items })
  }

  /** @type {Map<string, {minX:number,minY:number,maxX:number,maxY:number}|null>} */
  const layoutExtents = new Map()
  let anyChunkRewritten = false

  for (const [layoutId, group] of byLayout) {
    const allItems = group.flatMap((g) => g.items)
    const inliers = selectInlierIndices(allItems)
    const outlierItems = allItems.filter((_, i) => !inliers.has(i))
    for (const o of outlierItems) {
      if (!removedLayers.includes(o.batch.layer)) removedLayers.push(o.batch.layer)
    }

    // Map global item index → keep?
    let cursor = 0
    const keptBoxes = []
    for (const g of group) {
      const dropLine = new Set()
      const dropMesh = new Set()
      for (const item of g.items) {
        const globalIndex = cursor++
        if (!inliers.has(globalIndex)) {
          if (item.kind === 'line') dropLine.add(item.index)
          else dropMesh.add(item.index)
        } else if (isSaneBox(item.box)) {
          keptBoxes.push(item.box)
        }
      }

      if (dropLine.size === 0 && dropMesh.size === 0) {
        // 无剔除时仍收集 box，供 extents 重算
        continue
      }

      g.chunk.lineBatches = g.chunk.lineBatches.filter((_, i) => !dropLine.has(i))
      g.chunk.meshBatches = g.chunk.meshBatches.filter((_, i) => !dropMesh.has(i))
      totalRemoved += dropLine.size + dropMesh.size

      const { uncompressed, compressed } = encodeChunkGzip(g.chunk)
      entries[g.href] = compressed
      g.meta.byteLength = uncompressed.byteLength
      g.meta.compressedByteLength = compressed.byteLength
      g.meta.lineBatchCount = g.chunk.lineBatches.length
      g.meta.meshBatchCount = g.chunk.meshBatches.length
      anyChunkRewritten = true
    }

    // 纸空间 viewport 图框也参与 Fit 范围（与官方 computeLayoutViewExtents 一致）
    const layoutMeta = Array.isArray(manifest.layouts)
      ? manifest.layouts.find((l) => l && l.btrId === layoutId)
      : null
    if (layoutMeta?.viewports?.length) {
      for (const vp of layoutMeta.viewports) {
        if (vp?.paper && isSaneBox(vp.paper)) {
          keptBoxes.push(vp.paper)
        }
      }
    }

    layoutExtents.set(layoutId, unionBoxes(keptBoxes))
  }

  // 无几何 chunk 的布局（仅 viewport）也写入 extents
  if (Array.isArray(manifest.layouts)) {
    for (const layout of manifest.layouts) {
      if (!layout?.btrId || layoutExtents.has(layout.btrId)) continue
      const boxes = []
      for (const vp of layout.viewports || []) {
        if (vp?.paper && isSaneBox(vp.paper)) boxes.push(vp.paper)
      }
      if (boxes.length) layoutExtents.set(layout.btrId, unionBoxes(boxes))
    }
  }

  const activeId = manifest.activeLayoutBtrId
  let robust =
    (activeId && layoutExtents.get(activeId)) ||
    [...layoutExtents.values()].find((e) => e) ||
    null

  // Fallback: union all layout extents
  if (!robust) {
    robust = unionBoxes([...layoutExtents.values()].filter(Boolean))
  }

  let metaChanged = false
  if (robust && manifest.meta) {
    const prev = manifest.meta.viewExtents
    const same =
      prev &&
      prev.minX === robust.minX &&
      prev.minY === robust.minY &&
      prev.maxX === robust.maxX &&
      prev.maxY === robust.maxY
    const prevW = prev ? prev.maxX - prev.minX : 0
    const prevH = prev ? prev.maxY - prev.minY : 0
    const robW = robust.maxX - robust.minX
    const robH = robust.maxY - robust.minY
    const inflated =
      isAstronomicalExtents(prev) ||
      isAstronomicalExtents(manifest.meta.extents) ||
      (robW > 0 && Number.isFinite(prevW) && prevW / robW > 10) ||
      (robH > 0 && Number.isFinite(prevH) && prevH / robH > 10)
    if (!same || inflated || anyChunkRewritten) {
      manifest.meta.viewExtents = { ...robust }
      // extents 也可能被垃圾坐标污染，一并纠正
      manifest.meta.extents = { ...robust }
      metaChanged = true
    }
  }

  const changed = anyChunkRewritten || metaChanged
  if (changed) {
    entries[manifestPath] = strToU8(JSON.stringify(manifest))
  }

  const outEntries = {}
  for (const [path, data] of Object.entries(entries)) {
    if (!isSafeZipPath(path)) {
      throw new Error(`Unsafe path in ACEX package: ${path}`)
    }
    outEntries[path] = data
  }

  return {
    bytes: zipSync(outEntries, { level: 6 }),
    changed,
    removedBatches: totalRemoved,
    viewExtents: robust,
    layers: removedLayers
  }
}

/**
 * 就地清洗磁盘上的 multi zip；非 zip / 无需清洗时原样返回。
 * @param {string} zipPath
 * @param {{ appendLog?: (line: string) => Promise<void> }} [opts]
 */
export async function sanitizeAcexZipFile(zipPath, opts = {}) {
  const { readFile, writeFile } = await import('node:fs/promises')
  const raw = await readFile(zipPath)
  if (raw.length < 4 || raw[0] !== 0x50 || raw[1] !== 0x4b) {
    return { changed: false, removedBatches: 0 }
  }
  const result = sanitizeAcexZipBytes(raw)
  if (result.changed) {
    await writeFile(zipPath, result.bytes)
    const ve = result.viewExtents
    const size =
      ve &&
      `${(ve.maxX - ve.minX).toFixed(2)}×${(ve.maxY - ve.minY).toFixed(2)}`
    const msg = `[convert] sanitized outliers removedBatches=${result.removedBatches} layers=${result.layers.join(',') || '-'} viewExtents=${size || '-'}`
    console.warn(msg)
    if (opts.appendLog) await opts.appendLog(msg)
  }
  return result
}
