/**
 * Minimal ZIP writer (STORE method, no compression).
 *
 * Batch results are already-compressed media - WebP, AVIF, MP4, PDF - where
 * DEFLATE buys a percent or two for a real CPU cost. Storing instead lets us
 * skip a compression dependency entirely and stream straight from the VFS.
 *
 * Emits ZIP64 end-of-central-directory records when an archive exceeds the
 * classic 4 GB / 65535-entry limits, so large batches stay valid.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array, seed = 0): number {
  let crc = ~seed
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return ~crc >>> 0
}

export interface ZipEntry {
  name: string
  blob: Blob
}

interface CentralRecord {
  name: Uint8Array
  crc: number
  size: number
  offset: number
  dosTime: number
  dosDate: number
}

/** Names inside an archive must be unique; collisions get a ` (2)` suffix. */
function uniqueNames(entries: ZipEntry[]): string[] {
  const used = new Set<string>()
  return entries.map((entry) => {
    const clean = entry.name.replace(/^\/+/, '').replace(/\\/g, '/') || 'file'
    if (!used.has(clean)) {
      used.add(clean)
      return clean
    }
    const dot = clean.lastIndexOf('.')
    const base = dot > 0 ? clean.slice(0, dot) : clean
    const ext = dot > 0 ? clean.slice(dot) : ''
    let n = 2
    let candidate = `${base} (${n})${ext}`
    while (used.has(candidate)) candidate = `${base} (${++n})${ext}`
    used.add(candidate)
    return candidate
  })
}

function dosDateTime(date: Date): { dosTime: number; dosDate: number } {
  return {
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    dosDate: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/**
 * Builds the archive. `onProgress` receives 0..1 after each entry.
 */
export async function createZip(entries: ZipEntry[], onProgress?: (value: number) => void): Promise<Blob> {
  const names = uniqueNames(entries)
  const encoder = new TextEncoder()
  const parts: BlobPart[] = []
  const central: CentralRecord[] = []
  const now = dosDateTime(new Date())

  let offset = 0

  for (let i = 0; i < entries.length; i++) {
    const nameBytes = encoder.encode(names[i])
    const bytes = new Uint8Array(await entries[i].blob.arrayBuffer())
    const crc = crc32(bytes)

    const header = new DataView(new ArrayBuffer(30))
    header.setUint32(0, 0x04034b50, true) // local file header signature
    header.setUint16(4, 20, true) // version needed
    header.setUint16(6, 0x0800, true) // UTF-8 filename flag
    header.setUint16(8, 0, true) // method: store
    header.setUint16(10, now.dosTime, true)
    header.setUint16(12, now.dosDate, true)
    header.setUint32(14, crc, true)
    header.setUint32(18, bytes.length, true)
    header.setUint32(22, bytes.length, true)
    header.setUint16(26, nameBytes.length, true)
    header.setUint16(28, 0, true) // extra field length

    parts.push(header.buffer, nameBytes, bytes)
    central.push({ name: nameBytes, crc, size: bytes.length, offset, dosTime: now.dosTime, dosDate: now.dosDate })
    offset += 30 + nameBytes.length + bytes.length

    onProgress?.((i + 1) / entries.length)
    // Yield so a large batch does not lock the UI thread between entries.
    await Promise.resolve()
  }

  const centralStart = offset
  for (const record of central) {
    const header = new DataView(new ArrayBuffer(46))
    header.setUint32(0, 0x02014b50, true) // central directory signature
    header.setUint16(4, 20, true) // version made by
    header.setUint16(6, 20, true) // version needed
    header.setUint16(8, 0x0800, true)
    header.setUint16(10, 0, true)
    header.setUint16(12, record.dosTime, true)
    header.setUint16(14, record.dosDate, true)
    header.setUint32(16, record.crc, true)
    header.setUint32(20, record.size, true)
    header.setUint32(24, record.size, true)
    header.setUint16(28, record.name.length, true)
    header.setUint16(30, 0, true) // extra
    header.setUint16(32, 0, true) // comment
    header.setUint16(34, 0, true) // disk number
    header.setUint16(36, 0, true) // internal attrs
    header.setUint32(38, 0, true) // external attrs
    header.setUint32(42, Math.min(record.offset, 0xffffffff), true)
    parts.push(header.buffer, record.name)
    offset += 46 + record.name.length
  }
  const centralSize = offset - centralStart

  const needsZip64 = centralStart > 0xffffffff || centralSize > 0xffffffff || central.length > 0xffff
  if (needsZip64) {
    const zip64 = new DataView(new ArrayBuffer(56))
    zip64.setUint32(0, 0x06064b50, true) // zip64 end of central dir
    zip64.setBigUint64(4, 44n, true) // size of this record - 12
    zip64.setUint16(12, 45, true)
    zip64.setUint16(14, 45, true)
    zip64.setUint32(16, 0, true)
    zip64.setUint32(20, 0, true)
    zip64.setBigUint64(24, BigInt(central.length), true)
    zip64.setBigUint64(32, BigInt(central.length), true)
    zip64.setBigUint64(40, BigInt(centralSize), true)
    zip64.setBigUint64(48, BigInt(centralStart), true)

    const locator = new DataView(new ArrayBuffer(20))
    locator.setUint32(0, 0x07064b50, true) // zip64 locator
    locator.setUint32(4, 0, true)
    locator.setBigUint64(8, BigInt(offset), true)
    locator.setUint32(16, 1, true)

    parts.push(zip64.buffer, locator.buffer)
  }

  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true) // end of central directory
  end.setUint16(4, 0, true)
  end.setUint16(6, 0, true)
  end.setUint16(8, Math.min(central.length, 0xffff), true)
  end.setUint16(10, Math.min(central.length, 0xffff), true)
  end.setUint32(12, Math.min(centralSize, 0xffffffff), true)
  end.setUint32(16, Math.min(centralStart, 0xffffffff), true)
  end.setUint16(20, 0, true)
  parts.push(end.buffer)

  return new Blob(parts, { type: 'application/zip' })
}

/** Triggers a browser download for a blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  // Workspace names may carry folders ("docs/a.txt"); a single download is just the file.
  filename = filename.split('/').pop() || filename
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // Revoking immediately can cancel the download in some engines.
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
