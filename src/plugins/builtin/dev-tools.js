/* eslint-disable */
/**
 * Developer toolkit: timestamps, number bases, Base64, JWT, hashes, URLs, IDs,
 * regular expressions, diffs, cron, hex dumps, naming styles, escaping, JSON to
 * types, file permissions and colours.
 *
 * Most tools are live panels - the answer updates as you type - with a `code`
 * node for anything worth copying. `run()` exports the same result as a file,
 * so each tool also works in batch and in workflows where that makes sense.
 *
 * `crypto.subtle` does not exist in the sandbox (an opaque origin is not a
 * secure context), so the hashes HMAC and MD5 need are implemented here and
 * checked against Node's crypto in the unit tests. Whole-file SHA digests go
 * through `host.fs.digest`, which is faster.
 *
 * Tools are pushed onto `TOOLS` section by section; `definePlugin` is at the end.
 */

const TOOLS = []

/* ========================================================================== */
/* Shared helpers                                                             */
/* ========================================================================== */

const utf8 = new TextEncoder()
const utf8Decoder = new TextDecoder()

/**
 * A live panel: draws once with the saved state, then redraws on every change.
 * State is only sent on the first draw - resending it would overwrite keystrokes
 * that arrived while the redraw was on its way.
 */
function livePanel(ui, defaults, render, onAction) {
  const state = { ...defaults }
  for (const key of Object.keys(defaults)) {
    if (ui.state[key] !== undefined && typeof ui.state[key] === typeof defaults[key]) state[key] = ui.state[key]
  }
  const draw = (current, withState) => {
    let panel
    try {
      panel = render(current)
    } catch (error) {
      panel = { nodes: [{ type: 'alert', tone: 'destructive', text: String((error && error.message) || error) }] }
    }
    ui.render({ runLabel: '导出为文件', ...panel, ...(withState ? { state: current } : {}) })
  }
  draw(state, true)
  ui.on('change', (_key, _value, current) => draw(current, false))
  ui.on('action', (name, _value, current) => {
    const patch = onAction ? onAction(name, current) : null
    if (patch) {
      ui.setState(patch)
      draw({ ...current, ...patch }, false)
    }
  })
}

async function writeText(name, text, type = 'text/plain') {
  return (await host.fs.writeAll(name, text.endsWith('\n') ? text : `${text}\n`, type)).id
}

function toHex(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0')
  return out
}

function fromHex(text) {
  const clean = String(text).replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '')
  if (clean.length % 2) throw new Error('十六进制字符数必须是偶数')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16)
  return out
}

function concatBytes(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/* ------------------------------- Base64 ---------------------------------- */

function bytesToBase64(bytes, { url = false, pad = true } = {}) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  let out = btoa(binary)
  if (url) out = out.replace(/\+/g, '-').replace(/\//g, '_')
  if (!pad) out = out.replace(/=+$/, '')
  return out
}

/** Standard or URL-safe, padded or not, with whitespace and line breaks ignored. */
function base64ToBytes(text) {
  let clean = String(text).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('不是有效的 Base64：包含 Base64 字母表以外的字符')
  clean = clean.replace(/=+$/, '')
  if (clean.length % 4 === 1) throw new Error('不是有效的 Base64：长度不正确')
  clean += '='.repeat((4 - (clean.length % 4)) % 4)
  const binary = atob(clean)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function wrapLines(text, width) {
  if (!width) return text
  const lines = []
  for (let i = 0; i < text.length; i += width) lines.push(text.slice(i, i + width))
  return lines.join('\n')
}

/** Strict UTF-8 decode, or null when the bytes are not text. */
function decodeUtf8(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    // Control characters other than whitespace mean binary data that happens to be valid UTF-8.
    return /[\x00-\x08\x0e-\x1f]/.test(text) ? null : text
  } catch (error) {
    return null
  }
}

/** File type from magic bytes, for naming decoded binary output. */
function sniffType(bytes) {
  const b = bytes
  const starts = (...sig) => sig.every((v, i) => b[i] === v)
  if (starts(0x89, 0x50, 0x4e, 0x47)) return { ext: 'png', type: 'image/png', label: 'PNG 图片' }
  if (starts(0xff, 0xd8, 0xff)) return { ext: 'jpg', type: 'image/jpeg', label: 'JPEG 图片' }
  if (starts(0x47, 0x49, 0x46, 0x38)) return { ext: 'gif', type: 'image/gif', label: 'GIF 图片' }
  if (starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { ext: 'webp', type: 'image/webp', label: 'WebP 图片' }
  if (starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45) return { ext: 'wav', type: 'audio/wav', label: 'WAV 音频' }
  if (starts(0x25, 0x50, 0x44, 0x46)) return { ext: 'pdf', type: 'application/pdf', label: 'PDF 文档' }
  if (starts(0x50, 0x4b, 0x03, 0x04)) return { ext: 'zip', type: 'application/zip', label: 'ZIP 压缩包（含 Office 文档）' }
  if (starts(0x1f, 0x8b)) return { ext: 'gz', type: 'application/gzip', label: 'GZIP 数据' }
  if (starts(0x49, 0x44, 0x33) || starts(0xff, 0xfb)) return { ext: 'mp3', type: 'audio/mpeg', label: 'MP3 音频' }
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return { ext: 'mp4', type: 'video/mp4', label: 'MP4 / M4A 媒体' }
  if (starts(0x7f, 0x45, 0x4c, 0x46)) return { ext: 'elf', type: 'application/octet-stream', label: 'ELF 可执行文件' }
  if (starts(0x4d, 0x5a)) return { ext: 'exe', type: 'application/octet-stream', label: 'Windows 可执行文件' }
  if (starts(0x00, 0x61, 0x73, 0x6d)) return { ext: 'wasm', type: 'application/wasm', label: 'WebAssembly 模块' }
  if (starts(0x3c, 0x3f, 0x78, 0x6d, 0x6c) || starts(0x3c, 0x73, 0x76, 0x67)) return { ext: 'svg', type: 'image/svg+xml', label: 'XML / SVG' }
  return { ext: 'bin', type: 'application/octet-stream', label: '二进制数据' }
}

/* ------------------------------- Hashes ---------------------------------- */

/**
 * Merkle-Damgård hashes as incremental `{ update(bytes), digest() }` objects,
 * so files can be hashed chunk by chunk.
 */
function createHash(name) {
  switch (String(name).toLowerCase().replace('-', '')) {
    case 'md5':
      return blockHasher(64, true, md5Compress, () => Uint32Array.of(0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476), 16)
    case 'sha1':
      return blockHasher(64, false, sha1Compress, () => Uint32Array.of(0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0), 20)
    case 'sha256':
      return blockHasher(64, false, sha256Compress, () => Uint32Array.from(SHA256_INIT), 32)
    case 'sha384':
      return sha512Hasher(SHA384_INIT, 48)
    case 'sha512':
      return sha512Hasher(SHA512_INIT, 64)
    default:
      throw new Error(`不支持的哈希算法：${name}`)
  }
}

function hashBytes(name, bytes) {
  const h = createHash(name)
  h.update(bytes)
  return h.digest()
}

function blockHasher(blockSize, littleEndian, compress, init, outBytes) {
  const state = init()
  const block = new Uint8Array(blockSize)
  const view = new DataView(block.buffer)
  const words = new Uint32Array(80)
  let fill = 0
  let length = 0
  const process = () => {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(i * 4, littleEndian)
    compress(state, words)
    fill = 0
  }
  return {
    blockSize,
    update(data) {
      length += data.length
      for (let i = 0; i < data.length; i++) {
        block[fill++] = data[i]
        if (fill === blockSize) process()
      }
      return this
    },
    digest() {
      const bits = length * 8
      block[fill++] = 0x80
      if (fill > blockSize - 8) {
        block.fill(0, fill)
        process()
      }
      block.fill(0, fill)
      const high = Math.floor(bits / 2 ** 32)
      const low = bits >>> 0
      if (littleEndian) {
        view.setUint32(blockSize - 8, low, true)
        view.setUint32(blockSize - 4, high, true)
      } else {
        view.setUint32(blockSize - 8, high, false)
        view.setUint32(blockSize - 4, low, false)
      }
      process()
      const out = new Uint8Array(outBytes)
      const outView = new DataView(out.buffer)
      for (let i = 0; i < outBytes / 4; i++) outView.setUint32(i * 4, state[i], littleEndian)
      return out
    },
  }
}

const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21]
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0)

function md5Compress(state, x) {
  let [a, b, c, d] = state
  for (let i = 0; i < 64; i++) {
    let f
    let g
    if (i < 16) { f = (b & c) | (~b & d); g = i }
    else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16 }
    else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16 }
    else { f = c ^ (b | ~d); g = (7 * i) % 16 }
    const next = d
    d = c
    c = b
    const sum = (a + f + MD5_K[i] + x[g]) >>> 0
    b = (b + ((sum << MD5_S[i]) | (sum >>> (32 - MD5_S[i])))) >>> 0
    a = next
  }
  state[0] = (state[0] + a) >>> 0
  state[1] = (state[1] + b) >>> 0
  state[2] = (state[2] + c) >>> 0
  state[3] = (state[3] + d) >>> 0
}

function sha1Compress(state, w) {
  for (let i = 16; i < 80; i++) {
    const v = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]
    w[i] = (v << 1) | (v >>> 31)
  }
  let [a, b, c, d, e] = state
  for (let i = 0; i < 80; i++) {
    const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d
    const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6
    const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0
    e = d
    d = c
    c = (b << 30) | (b >>> 2)
    b = a
    a = t
  }
  state[0] = (state[0] + a) >>> 0
  state[1] = (state[1] + b) >>> 0
  state[2] = (state[2] + c) >>> 0
  state[3] = (state[3] + d) >>> 0
  state[4] = (state[4] + e) >>> 0
}

const SHA256_INIT = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

function sha256Compress(state, w) {
  for (let i = 16; i < 64; i++) {
    const s15 = w[i - 15]
    const s2 = w[i - 2]
    const r1 = ((s15 >>> 7) | (s15 << 25)) ^ ((s15 >>> 18) | (s15 << 14)) ^ (s15 >>> 3)
    const r2 = ((s2 >>> 17) | (s2 << 15)) ^ ((s2 >>> 19) | (s2 << 13)) ^ (s2 >>> 10)
    w[i] = (r1 + w[i - 7] + r2 + w[i - 16]) >>> 0
  }
  let [a, b, c, d, e, f, g, h] = state
  for (let i = 0; i < 64; i++) {
    const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
    const t1 = (h + s1 + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) >>> 0
    const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
    const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
    h = g
    g = f
    f = e
    e = (d + t1) >>> 0
    d = c
    c = b
    b = a
    a = (t1 + t2) >>> 0
  }
  const add = [a, b, c, d, e, f, g, h]
  for (let i = 0; i < 8; i++) state[i] = (state[i] + add[i]) >>> 0
}

const SHA512_K = [
  '428a2f98d728ae22', '7137449123ef65cd', 'b5c0fbcfec4d3b2f', 'e9b5dba58189dbbc', '3956c25bf348b538', '59f111f1b605d019', '923f82a4af194f9b', 'ab1c5ed5da6d8118',
  'd807aa98a3030242', '12835b0145706fbe', '243185be4ee4b28c', '550c7dc3d5ffb4e2', '72be5d74f27b896f', '80deb1fe3b1696b1', '9bdc06a725c71235', 'c19bf174cf692694',
  'e49b69c19ef14ad2', 'efbe4786384f25e3', '0fc19dc68b8cd5b5', '240ca1cc77ac9c65', '2de92c6f592b0275', '4a7484aa6ea6e483', '5cb0a9dcbd41fbd4', '76f988da831153b5',
  '983e5152ee66dfab', 'a831c66d2db43210', 'b00327c898fb213f', 'bf597fc7beef0ee4', 'c6e00bf33da88fc2', 'd5a79147930aa725', '06ca6351e003826f', '142929670a0e6e70',
  '27b70a8546d22ffc', '2e1b21385c26c926', '4d2c6dfc5ac42aed', '53380d139d95b3df', '650a73548baf63de', '766a0abb3c77b2a8', '81c2c92e47edaee6', '92722c851482353b',
  'a2bfe8a14cf10364', 'a81a664bbc423001', 'c24b8b70d0f89791', 'c76c51a30654be30', 'd192e819d6ef5218', 'd69906245565a910', 'f40e35855771202a', '106aa07032bbd1b8',
  '19a4c116b8d2d0c8', '1e376c085141ab53', '2748774cdf8eeb99', '34b0bcb5e19b48a8', '391c0cb3c5c95a63', '4ed8aa4ae3418acb', '5b9cca4f7763e373', '682e6ff3d6b2b8a3',
  '748f82ee5defb2fc', '78a5636f43172f60', '84c87814a1f0ab72', '8cc702081a6439ec', '90befffa23631e28', 'a4506cebde82bde9', 'bef9a3f7b2c67915', 'c67178f2e372532b',
  'ca273eceea26619c', 'd186b8c721c0c207', 'eada7dd6cde0eb1e', 'f57d4f7fee6ed178', '06f067aa72176fba', '0a637dc5a2c898a6', '113f9804bef90dae', '1b710b35131c471b',
  '28db77f523047d84', '32caab7b40c72493', '3c9ebe0a15c9bebc', '431d67c49c100d4c', '4cc5d4becb3e42b6', '597f299cfc657e2a', '5fcb6fab3ad6faec', '6c44198c4a475817',
].map((hex) => BigInt(`0x${hex}`))
const SHA512_INIT = ['6a09e667f3bcc908', 'bb67ae8584caa73b', '3c6ef372fe94f82b', 'a54ff53a5f1d36f1', '510e527fade682d1', '9b05688c2b3e6c1f', '1f83d9abfb41bd6b', '5be0cd19137e2179'].map((hex) => BigInt(`0x${hex}`))
const SHA384_INIT = ['cbbb9d5dc1059ed8', '629a292a367cd507', '9159015a3070dd17', '152fecd8f70e5939', '67332667ffc00b31', '8eb44a8768581511', 'db0c2e0d64f98fa7', '47b5481dbefa4fa4'].map((hex) => BigInt(`0x${hex}`))

/** SHA-512 family with BigInt words. Slower than the 32-bit hashes, but only used for HMAC and small inputs. */
function sha512Hasher(init, outBytes) {
  const MASK = (1n << 64n) - 1n
  const rotr = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & MASK
  const state = [...init]
  const block = new Uint8Array(128)
  const view = new DataView(block.buffer)
  const w = new Array(80)
  let fill = 0
  let length = 0
  const process = () => {
    for (let i = 0; i < 16; i++) w[i] = view.getBigUint64(i * 8, false)
    for (let i = 16; i < 80; i++) {
      const s1 = rotr(w[i - 2], 19) ^ rotr(w[i - 2], 61) ^ (w[i - 2] >> 6n)
      const s0 = rotr(w[i - 15], 1) ^ rotr(w[i - 15], 8) ^ (w[i - 15] >> 7n)
      w[i] = (s1 + w[i - 7] + s0 + w[i - 16]) & MASK
    }
    let [a, b, c, d, e, f, g, h] = state
    for (let i = 0; i < 80; i++) {
      const t1 = (h + (rotr(e, 14) ^ rotr(e, 18) ^ rotr(e, 41)) + ((e & f) ^ (~e & MASK & g)) + SHA512_K[i] + w[i]) & MASK
      const t2 = ((rotr(a, 28) ^ rotr(a, 34) ^ rotr(a, 39)) + ((a & b) ^ (a & c) ^ (b & c))) & MASK
      h = g
      g = f
      f = e
      e = (d + t1) & MASK
      d = c
      c = b
      b = a
      a = (t1 + t2) & MASK
    }
    const add = [a, b, c, d, e, f, g, h]
    for (let i = 0; i < 8; i++) state[i] = (state[i] + add[i]) & MASK
    fill = 0
  }
  return {
    blockSize: 128,
    update(data) {
      length += data.length
      for (let i = 0; i < data.length; i++) {
        block[fill++] = data[i]
        if (fill === 128) process()
      }
      return this
    },
    digest() {
      const bits = BigInt(length) * 8n
      block[fill++] = 0x80
      if (fill > 112) {
        block.fill(0, fill)
        process()
      }
      block.fill(0, fill)
      view.setBigUint64(112, bits >> 64n, false)
      view.setBigUint64(120, bits & MASK, false)
      process()
      const out = new Uint8Array(64)
      const outView = new DataView(out.buffer)
      for (let i = 0; i < 8; i++) outView.setBigUint64(i * 8, state[i], false)
      return out.slice(0, outBytes)
    },
  }
}

/** HMAC over any hash above; `key` and `message` are bytes. */
function hmac(name, key, message) {
  const probe = createHash(name)
  const size = probe.blockSize
  let k = key.length > size ? hashBytes(name, key) : key
  const padded = new Uint8Array(size)
  padded.set(k)
  const inner = new Uint8Array(size)
  const outer = new Uint8Array(size)
  for (let i = 0; i < size; i++) {
    inner[i] = padded[i] ^ 0x36
    outer[i] = padded[i] ^ 0x5c
  }
  const innerHash = createHash(name).update(inner).update(message).digest()
  return createHash(name).update(outer).update(innerHash).digest()
}

/** Constant-time comparison, so verification does not leak where a signature differs. */
function equalBytes(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32Hasher() {
  let crc = -1
  return {
    update(data) {
      for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
      return this
    },
    digest() {
      const value = (crc ^ -1) >>> 0
      return Uint8Array.of(value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
    },
  }
}

/* ------------------------------ Time ------------------------------------- */

const ZONES = [
  ['local', '本机时区'], ['UTC', 'UTC'], ['Asia/Shanghai', '北京 / 上海（UTC+8）'], ['Asia/Hong_Kong', '香港'], ['Asia/Taipei', '台北'],
  ['Asia/Tokyo', '东京'], ['Asia/Seoul', '首尔'], ['Asia/Singapore', '新加坡'], ['Asia/Kolkata', '印度'], ['Asia/Dubai', '迪拜'],
  ['Europe/London', '伦敦'], ['Europe/Paris', '巴黎'], ['Europe/Berlin', '柏林'], ['Europe/Moscow', '莫斯科'],
  ['America/New_York', '纽约'], ['America/Chicago', '芝加哥'], ['America/Denver', '丹佛'], ['America/Los_Angeles', '洛杉矶'], ['America/Sao_Paulo', '圣保罗'],
  ['Australia/Sydney', '悉尼'], ['Pacific/Auckland', '奥克兰'],
].map(([value, label]) => ({ value, label }))

/**
 * A timestamp or date string → `{ ms, kind }`. Numbers are read by magnitude:
 * up to 11 digits seconds, 13 milliseconds, 16 microseconds, 19 nanoseconds.
 * Strings without a zone are taken in `zone`.
 */
function parseInstant(input, zone = 'local') {
  const text = String(input).trim()
  if (!text) return null
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    const digits = text.replace(/^-/, '').split('.')[0].length
    const value = Number(text)
    if (digits <= 11) return { ms: value * 1000, kind: '秒' }
    if (digits <= 14) return { ms: value, kind: '毫秒' }
    if (digits <= 17) return { ms: value / 1000, kind: '微秒' }
    return { ms: Number(BigInt(text.split('.')[0]) / 1000000n), kind: '纳秒' }
  }
  const local = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(text)
  if (local) {
    const [, y, mo, d, h = '0', mi = '0', sec = '0', frac = '0'] = local
    const fields = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec), Number(frac.padEnd(3, '0'))]
    if (zone === 'local') return { ms: new Date(...fields).getTime(), kind: '日期时间（本机时区）' }
    const guess = Date.UTC(...fields)
    return { ms: guess - zoneOffsetMs(guess, zone), kind: `日期时间（${zone}）` }
  }
  const parsed = Date.parse(text)
  if (Number.isNaN(parsed)) throw new Error('无法识别：请输入 Unix 时间戳（秒 / 毫秒 / 微秒 / 纳秒）或日期，如 2024-05-01 12:30:00、2024-05-01T04:30:00Z')
  return { ms: parsed, kind: '日期字符串' }
}

/** Offset of `zone` from UTC at an instant, in milliseconds (positive east of UTC). */
function zoneOffsetMs(ms, zone) {
  if (zone === 'local') return -new Date(ms).getTimezoneOffset() * 60000
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]))
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
  return asUtc - Math.floor(ms / 1000) * 1000
}

function formatInZone(ms, zone) {
  const offset = zoneOffsetMs(ms, zone)
  const d = new Date(ms + offset)
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset) / 60000
  const stamp = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`
  return { text: `${stamp} ${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`, weekday: '日一二三四五六'[d.getUTCDay()], date: d }
}

function relativeTime(ms, now = Date.now()) {
  const diff = ms - now
  const abs = Math.abs(diff)
  const units = [[31536000000, '年'], [2592000000, '个月'], [86400000, '天'], [3600000, '小时'], [60000, '分钟'], [1000, '秒']]
  for (const [size, label] of units) {
    if (abs >= size) return `${Math.floor(abs / size)} ${label}${diff < 0 ? '前' : '后'}`
  }
  return '现在'
}

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1)
  return { year: d.getUTCFullYear(), week: Math.ceil(((d - yearStart) / 86400000 + 1) / 7) }
}

/* ========================================================================== */
/* Timestamps                                                                 */
/* ========================================================================== */

function describeInstant(value, zone) {
  const parsed = String(value).trim() ? parseInstant(value, zone) : { ms: Date.now(), kind: '当前时间' }
  if (!Number.isFinite(parsed.ms) || Math.abs(parsed.ms) > 8.64e15) throw new Error('超出可表示的时间范围')
  const ms = Math.round(parsed.ms)
  const inZone = formatInZone(ms, zone)
  const week = isoWeek(inZone.date)
  const startOfYear = Date.UTC(inZone.date.getUTCFullYear(), 0, 1)
  const dayOfYear = Math.floor((Date.UTC(inZone.date.getUTCFullYear(), inZone.date.getUTCMonth(), inZone.date.getUTCDate()) - startOfYear) / 86400000) + 1
  return [
    { label: '识别为', value: parsed.kind },
    { label: 'Unix 秒', value: String(Math.floor(ms / 1000)) },
    { label: 'Unix 毫秒', value: String(ms) },
    { label: 'ISO 8601（UTC）', value: new Date(ms).toISOString() },
    { label: zone === 'local' ? '本机时区' : zone, value: inZone.text },
    { label: 'RFC 2822', value: new Date(ms).toUTCString() },
    { label: '相对现在', value: relativeTime(ms) },
    { label: '星期', value: `星期${inZone.weekday}` },
    { label: 'ISO 周', value: `${week.year} 年第 ${week.week} 周` },
    { label: '当年第几天', value: `第 ${dayOfYear} 天` },
  ]
}

TOOLS.push({
  id: 'timestamp',
  name: '时间戳转换',
  category: 'dev',
  icon: 'clock',
  description: 'Unix 时间戳（自动识别秒 / 毫秒 / 微秒 / 纳秒）与日期互转，查看任意时区时间、ISO 8601、RFC 2822、ISO 周与相对时间。',
  input: 'none',
  keywords: ['timestamp', 'unix time', 'epoch', 'date', 'iso 8601', 'timezone', '时间戳', '时区', '日期转换', '毫秒'],
  setup(ui) {
    livePanel(ui, { value: '', zone: 'local' }, (s) => {
      const rows = describeInstant(s.value, s.zone)
      return {
        nodes: [
          { type: 'text', variant: 'body', text: '时间戳或日期' },
          {
            type: 'row', gap: 2,
            children: [
              { type: 'input', bind: 'value', placeholder: '1700000000、1700000000123 或 2024-05-01 12:30:00；留空显示当前时间' },
              { type: 'button', text: '现在', action: 'now', variant: 'outline', icon: 'clock' },
            ],
          },
          { type: 'select', bind: 'zone', label: '时区', hint: '没有写时区的日期按此时区理解。', options: ZONES },
          { type: 'facts', rows },
          { type: 'code', label: '全部结果', text: rows.map((r) => `${r.label}: ${r.value}`).join('\n'), height: 14 },
        ],
      }
    }, (action) => (action === 'now' ? { value: String(Math.floor(Date.now() / 1000)) } : null))
  },
  async run(ctx) {
    const rows = describeInstant(ctx.params.value ?? '', String(ctx.params.zone || 'local'))
    return { outputs: [await writeText('timestamp.txt', rows.map((r) => `${r.label}: ${r.value}`).join('\n'))], summary: `${rows[1].value} · ${rows[3].value}` }
  },
})

/* ========================================================================== */
/* Number bases                                                               */
/* ========================================================================== */

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz'

/** An integer in any base 2-36 (prefixes 0x / 0o / 0b when `base` is auto) as BigInt, arbitrarily large. */
function parseInteger(input, base) {
  let text = String(input).trim().replace(/[\s_,']/g, '').toLowerCase()
  let negative = false
  if (text.startsWith('-')) {
    negative = true
    text = text.slice(1)
  } else if (text.startsWith('+')) text = text.slice(1)
  let radix = base === 'auto' ? 10 : Number(base)
  if (base === 'auto') {
    if (/^0x/.test(text)) { radix = 16; text = text.slice(2) }
    else if (/^0b/.test(text)) { radix = 2; text = text.slice(2) }
    else if (/^0o/.test(text)) { radix = 8; text = text.slice(2) }
  } else if ((radix === 16 && /^0x/.test(text)) || (radix === 2 && /^0b/.test(text)) || (radix === 8 && /^0o/.test(text))) {
    text = text.slice(2)
  }
  if (!text) throw new Error('请输入数字')
  let value = 0n
  const big = BigInt(radix)
  for (const ch of text) {
    const digit = DIGITS.indexOf(ch)
    if (digit < 0 || digit >= radix) throw new Error(`「${ch}」不是 ${radix} 进制的数字`)
    value = value * big + BigInt(digit)
  }
  return { value: negative ? -value : value, radix }
}

function groupDigits(text, size) {
  const out = []
  for (let end = text.length; end > 0; end -= size) out.unshift(text.slice(Math.max(0, end - size), end))
  return out.join(' ')
}

function describeNumber(input, base, width) {
  const text = String(input).trim()
  if (!text) return { rows: [], note: '' }
  // Decimal with a fraction or exponent: show its IEEE 754 encodings instead.
  if ((base === 'auto' || base === '10') && /^[+-]?(\d+\.\d*|\.\d+|\d+(\.\d*)?e[+-]?\d+)$/i.test(text.replace(/[\s_]/g, ''))) {
    const value = Number(text.replace(/[\s_]/g, ''))
    const rows = [{ label: '十进制', value: String(value) }]
    for (const [bits, label] of [[32, 'float32'], [64, 'float64']]) {
      const view = new DataView(new ArrayBuffer(8))
      if (bits === 32) view.setFloat32(0, value)
      else view.setFloat64(0, value)
      const bytes = new Uint8Array(view.buffer, 0, bits / 8)
      const binary = [...bytes].map((b) => b.toString(2).padStart(8, '0')).join('')
      const expBits = bits === 32 ? 8 : 11
      rows.push({ label: `${label} 十六进制`, value: `0x${toHex(bytes)}` })
      rows.push({ label: `${label} 位`, value: `${binary[0]} ${binary.slice(1, 1 + expBits)} ${binary.slice(1 + expBits)}` })
      if (bits === 32) rows.push({ label: 'float32 实际存储值', value: String(view.getFloat32(0)) })
    }
    return { rows, note: '符号位 · 指数 · 尾数' }
  }
  const { value } = parseInteger(text, base)
  const abs = value < 0n ? -value : value
  const rows = [
    { label: '二进制', value: `${value < 0n ? '-' : ''}${groupDigits(abs.toString(2), 4)}` },
    { label: '八进制', value: `${value < 0n ? '-' : ''}${abs.toString(8)}` },
    { label: '十进制', value: value.toString() },
    { label: '十六进制', value: `${value < 0n ? '-' : ''}${abs.toString(16).toUpperCase()}` },
    { label: '三十六进制', value: `${value < 0n ? '-' : ''}${abs.toString(36)}` },
    { label: '位长度', value: `${abs.toString(2).length} 位` },
  ]
  const bits = Number(width)
  if (bits) {
    const mod = 1n << BigInt(bits)
    const unsigned = ((value % mod) + mod) % mod
    const signed = unsigned >= mod / 2n ? unsigned - mod : unsigned
    const fits = value >= -(mod / 2n) && value < mod
    const hex = unsigned.toString(16).padStart(bits / 4, '0').toUpperCase()
    const bytes = hex.match(/../g)
    rows.push(
      { label: `${bits} 位无符号`, value: unsigned.toString() },
      { label: `${bits} 位有符号（补码）`, value: signed.toString() },
      { label: `${bits} 位二进制`, value: groupDigits(unsigned.toString(2).padStart(bits, '0'), 4) },
      { label: '字节（大端）', value: bytes.join(' ') },
      { label: '字节（小端）', value: [...bytes].reverse().join(' ') },
    )
    if (!fits) rows.push({ label: '注意', value: `超出 ${bits} 位范围，已按低 ${bits} 位截断` })
  }
  if (value >= 0n && value <= 0x10ffffn && !(value >= 0xd800n && value <= 0xdfffn)) {
    rows.push({ label: 'Unicode 字符', value: `U+${value.toString(16).toUpperCase().padStart(4, '0')} ${value >= 32n ? String.fromCodePoint(Number(value)) : '（控制字符）'}` })
  }
  return { rows, note: '' }
}

TOOLS.push({
  id: 'radix',
  name: '进制转换',
  category: 'dev',
  icon: 'binary',
  description: '二、八、十、十六及任意进制互转，任意大整数；按 8 / 16 / 32 / 64 位查看补码与大小端字节，小数显示 IEEE 754 浮点编码。',
  input: 'none',
  keywords: ['binary', 'hex', 'octal', 'radix', 'base convert', 'two\'s complement', 'endian', 'ieee 754', '进制', '二进制', '十六进制', '补码', '大小端', '浮点'],
  setup(ui) {
    livePanel(ui, { value: '255', base: 'auto', width: '32' }, (s) => {
      const { rows, note } = describeNumber(s.value, s.base, s.width)
      return {
        nodes: [
          { type: 'input', bind: 'value', label: '数值', placeholder: '如 255、0xFF、0b1010、-42、3.14', hint: '可以带 0x / 0b / 0o 前缀；下划线、空格与逗号分隔符会被忽略。' },
          {
            type: 'row', gap: 3, wrap: true,
            children: [
              { type: 'select', bind: 'base', label: '输入进制', options: [{ value: 'auto', label: '自动（按前缀）' }, ...[2, 8, 10, 16, 32, 36].map((b) => ({ value: String(b), label: `${b} 进制` }))] },
              { type: 'select', bind: 'width', label: '位宽', options: [{ value: '0', label: '不限' }, ...['8', '16', '32', '64', '128'].map((w) => ({ value: w, label: `${w} 位` }))] },
            ],
          },
          ...(rows.length ? [{ type: 'facts', rows }, ...(note ? [{ type: 'text', variant: 'muted', text: note }] : []), { type: 'code', label: '全部结果', text: rows.map((r) => `${r.label}: ${r.value}`).join('\n'), height: 14 }] : []),
        ],
      }
    })
  },
  async run(ctx) {
    const { rows } = describeNumber(ctx.params.value ?? '', String(ctx.params.base || 'auto'), String(ctx.params.width ?? '32'))
    if (!rows.length) throw new Error('请输入数字')
    return { outputs: [await writeText('radix.txt', rows.map((r) => `${r.label}: ${r.value}`).join('\n'))], summary: rows.slice(0, 4).map((r) => `${r.label} ${r.value}`).join(' · ') }
  },
})

/* ========================================================================== */
/* Base64                                                                     */
/* ========================================================================== */

const BASE64_LIKE = /^[A-Za-z0-9+/\-_\s]+={0,2}\s*$/

/**
 * Whether text should be decoded when the mode is automatic. Plain words are in
 * the Base64 alphabet too ("test", "password"), so the decoded bytes must also
 * make sense: readable text or a recognisable file.
 */
function plausibleBase64(text) {
  const compact = text.replace(/\s+/g, '')
  if (compact.length < 8 || !BASE64_LIKE.test(text) || compact.replace(/=+$/, '').length % 4 === 1) return false
  let bytes
  try {
    bytes = base64ToBytes(compact)
  } catch (error) {
    return false
  }
  return decodeUtf8(bytes) !== null || sniffType(bytes).ext !== 'bin'
}

TOOLS.push({
  id: 'base64',
  name: 'Base64 编解码',
  category: 'dev',
  icon: 'code',
  description: '文本与任意文件的 Base64 编码 / 解码：标准与 URL 安全字母表、可选填充与 MIME 换行、Data URI；解码出的二进制按文件头识别类型（图片、PDF、压缩包等）。',
  accept: ['*/*'],
  multiple: true,
  input: 'both',
  textFileName: 'input.txt',
  keywords: ['base64', 'base64url', 'data uri', 'encode', 'decode', '编码', '解码', 'base64 图片'],
  params: [
    { key: 'mode', type: 'select', label: '操作', default: 'auto', options: [{ value: 'auto', label: '自动判断' }, { value: 'encode', label: '编码' }, { value: 'decode', label: '解码' }], hint: '自动：内容本身是 Base64 或 Data URI 时解码，否则编码。' },
    { key: 'variant', type: 'select', label: '字母表', default: 'standard', options: [{ value: 'standard', label: '标准（+ /）' }, { value: 'url', label: 'URL 安全（- _）' }] },
    { key: 'pad', type: 'switch', label: '保留 = 填充', default: true },
    { key: 'wrap', type: 'select', label: '换行', default: '0', options: [{ value: '0', label: '不换行' }, { value: '64', label: '每 64 字符（PEM）' }, { value: '76', label: '每 76 字符（MIME）' }] },
    { key: 'dataUri', type: 'switch', label: '编码为 Data URI', default: false, hint: '按文件类型加上 data:…;base64, 前缀，可直接用在 HTML / CSS 里。' },
  ],
  async run(ctx) {
    const p = ctx.params
    const outputs = []
    const notes = []
    for (const input of ctx.inputs) {
      ctx.throwIfAborted()
      const bytes = await host.fs.readAll(input.id)
      const base = input.name.replace(/\.[^.]+$/, '')
      const text = bytes.length <= 64 * 1024 * 1024 ? decodeUtf8(bytes) : null
      const trimmed = text === null ? '' : text.trim()
      const dataUri = /^data:([^,]*?)(;base64)?,/i.exec(trimmed)
      const decode = p.mode === 'decode' || (p.mode === 'auto' && (Boolean(dataUri) || plausibleBase64(trimmed)))
      if (!decode) {
        let encoded = bytesToBase64(bytes, { url: p.variant === 'url', pad: p.pad !== false })
        if (p.dataUri) encoded = `data:${input.type || sniffType(bytes).type};base64,${encoded}`
        else encoded = wrapLines(encoded, Number(p.wrap) || 0)
        outputs.push(await writeText(`${base}.base64.txt`, encoded))
        notes.push(`${input.name} 编码为 ${encoded.length} 字符`)
        continue
      }
      if (text === null) throw new Error(`${input.name} 不是文本，无法作为 Base64 解码`)
      let decoded
      let declaredType = ''
      if (dataUri) {
        declaredType = dataUri[1].split(';')[0]
        const body = trimmed.slice(dataUri[0].length)
        decoded = dataUri[2] ? base64ToBytes(body) : utf8.encode(decodeURIComponent(body))
      } else {
        decoded = base64ToBytes(trimmed)
      }
      const asText = decodeUtf8(decoded)
      if (asText !== null && !declaredType.startsWith('image/')) {
        outputs.push(await writeText(`${base}.decoded.txt`, asText))
        notes.push(`${input.name} 解码为 ${decoded.length} 字节文本`)
      } else {
        const sniffed = sniffType(decoded)
        const type = declaredType || sniffed.type
        const out = await host.fs.writeAll(`${base}.decoded.${sniffed.ext}`, decoded, type)
        outputs.push(out.id)
        notes.push(`${input.name} 解码为 ${decoded.length} 字节（${sniffed.label}）`)
      }
    }
    return { outputs, summary: notes.join('；') }
  },
})

/* ========================================================================== */
/* JWT                                                                        */
/* ========================================================================== */

const JWT_HMAC = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' }

function base64UrlJson(segment, what) {
  let bytes
  try {
    bytes = base64ToBytes(segment)
  } catch (error) {
    throw new Error(`${what}不是有效的 Base64URL`)
  }
  const text = decodeUtf8(bytes)
  if (text === null) throw new Error(`${what}不是 UTF-8 文本`)
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${what}不是 JSON：${error.message}`)
  }
}

function secretBytes(secret, encoding) {
  if (encoding === 'base64') return base64ToBytes(secret)
  if (encoding === 'hex') return fromHex(secret)
  return utf8.encode(secret)
}

/** Parses a compact JWS and, for HMAC algorithms with a secret, checks the signature. */
function inspectJwt(token, { secret = '', encoding = 'utf8', now = Date.now() } = {}) {
  const compact = String(token).trim().replace(/^Bearer\s+/i, '')
  const parts = compact.split('.')
  if (parts.length === 5) throw new Error('这是 JWE（加密的令牌），没有密钥无法查看内容')
  if (parts.length !== 3) throw new Error(`JWT 应由 3 段组成（header.payload.signature），这里有 ${parts.length} 段`)
  const header = base64UrlJson(parts[0], '头部')
  const payload = base64UrlJson(parts[1], '载荷')
  const alg = String(header.alg || '')
  const claims = []
  const seconds = now / 1000
  const time = (value) => (typeof value === 'number' ? `${new Date(value * 1000).toISOString()}（${relativeTime(value * 1000, now)}）` : String(value))
  if (payload.iat !== undefined) claims.push({ label: '签发时间 iat', value: time(payload.iat) })
  if (payload.nbf !== undefined) claims.push({ label: '生效时间 nbf', value: time(payload.nbf) })
  if (payload.exp !== undefined) claims.push({ label: '过期时间 exp', value: time(payload.exp) })
  for (const [key, label] of [['iss', '签发者 iss'], ['sub', '主体 sub'], ['aud', '受众 aud'], ['jti', '编号 jti']]) {
    if (payload[key] !== undefined) claims.push({ label, value: Array.isArray(payload[key]) ? payload[key].join(', ') : String(payload[key]) })
  }
  const problems = []
  if (typeof payload.exp === 'number' && payload.exp <= seconds) problems.push('已过期')
  if (typeof payload.nbf === 'number' && payload.nbf > seconds) problems.push('尚未生效')
  let signature = { state: 'unchecked', text: '' }
  if (alg === 'none') {
    signature = { state: 'invalid', text: 'alg 为 none：未签名的令牌，任何人都能伪造' }
  } else if (JWT_HMAC[alg]) {
    if (secret) {
      const expected = hmac(JWT_HMAC[alg], secretBytes(secret, encoding), utf8.encode(`${parts[0]}.${parts[1]}`))
      let actual
      try {
        actual = base64ToBytes(parts[2])
      } catch (error) {
        actual = new Uint8Array(0)
      }
      signature = equalBytes(expected, actual) ? { state: 'valid', text: `${alg} 签名有效` } : { state: 'invalid', text: `${alg} 签名无效：密钥不对，或令牌被改动过` }
    } else {
      signature = { state: 'unchecked', text: `输入密钥即可验证 ${alg} 签名` }
    }
  } else {
    signature = { state: 'unchecked', text: `${alg || '未知算法'} 使用公钥签名，暂不支持在此验证` }
  }
  return { header, payload, alg, claims, problems, signature }
}

function signJwt(payloadText, { alg = 'HS256', secret = '', encoding = 'utf8', extraHeader = {} } = {}) {
  let payload
  try {
    payload = JSON.parse(payloadText)
  } catch (error) {
    throw new Error(`载荷不是有效的 JSON：${error.message}`)
  }
  const header = { alg, typ: 'JWT', ...extraHeader }
  const encode = (value) => bytesToBase64(utf8.encode(JSON.stringify(value)), { url: true, pad: false })
  const signingInput = `${encode(header)}.${encode(payload)}`
  if (alg === 'none') return `${signingInput}.`
  if (!JWT_HMAC[alg]) throw new Error(`不支持的签名算法：${alg}`)
  if (!secret) throw new Error('请输入签名密钥')
  return `${signingInput}.${bytesToBase64(hmac(JWT_HMAC[alg], secretBytes(secret, encoding), utf8.encode(signingInput)), { url: true, pad: false })}`
}

const JWT_SAMPLE_PAYLOAD = '{\n  "sub": "1234567890",\n  "name": "OmniTool",\n  "admin": true\n}'

TOOLS.push({
  id: 'jwt',
  name: 'JWT 解析与签名',
  category: 'dev',
  icon: 'key',
  description: '解析 JWT 的头部与载荷，显示签发 / 生效 / 过期时间与状态；用密钥验证或生成 HS256 / HS384 / HS512 签名。全部在本机计算，令牌与密钥不会离开浏览器。',
  input: 'none',
  keywords: ['jwt', 'json web token', 'bearer', 'hs256', 'decode token', 'jws', '令牌', '解析 token', '签名验证'],
  setup(ui) {
    livePanel(ui, { mode: 'decode', token: '', secret: '', encoding: 'utf8', alg: 'HS256', payload: JWT_SAMPLE_PAYLOAD }, (s) => {
      const encodingNode = { type: 'select', bind: 'encoding', label: '密钥格式', options: [{ value: 'utf8', label: '文本' }, { value: 'base64', label: 'Base64' }, { value: 'hex', label: '十六进制' }] }
      const head = [
        { type: 'segmented', bind: 'mode', options: [{ value: 'decode', label: '解析与验证' }, { value: 'encode', label: '生成' }] },
      ]
      if (s.mode === 'encode') {
        let token = ''
        let error = ''
        try {
          token = signJwt(s.payload, { alg: s.alg, secret: s.secret, encoding: s.encoding })
        } catch (e) {
          error = e.message
        }
        return {
          nodes: [
            ...head,
            { type: 'textarea', bind: 'payload', label: '载荷（JSON）', rows: 8, mono: true },
            { type: 'row', gap: 2, wrap: true, children: [{ type: 'button', text: '加入 iat / exp（1 小时）', action: 'stamp', variant: 'outline', icon: 'clock' }] },
            { type: 'row', gap: 3, wrap: true, children: [{ type: 'select', bind: 'alg', label: '算法', options: ['HS256', 'HS384', 'HS512', 'none'].map((v) => ({ value: v, label: v })) }, encodingNode] },
            { type: 'input', bind: 'secret', label: '密钥', placeholder: '签名用的共享密钥' },
            error ? { type: 'alert', tone: 'warning', text: error } : { type: 'code', label: '令牌', text: token, wrap: true, height: 10 },
          ],
        }
      }
      const nodes = [...head, { type: 'textarea', bind: 'token', label: '令牌', rows: 4, mono: true, placeholder: 'eyJhbGciOi…（可以带 Bearer 前缀）' }]
      if (!s.token.trim()) return { nodes: [...nodes, { type: 'text', variant: 'muted', text: '粘贴一个 JWT 查看内容。' }] }
      const info = inspectJwt(s.token, { secret: s.secret, encoding: s.encoding })
      const tone = info.signature.state === 'valid' ? 'success' : info.signature.state === 'invalid' ? 'destructive' : 'info'
      return {
        nodes: [
          ...nodes,
          ...(info.problems.length ? [{ type: 'alert', tone: 'warning', title: info.problems.join('，'), text: '按当前时间判断。' }] : []),
          { type: 'facts', rows: [{ label: '算法 alg', value: info.alg || '—' }, { label: '类型 typ', value: String(info.header.typ ?? '—') }, ...(info.header.kid ? [{ label: '密钥编号 kid', value: String(info.header.kid) }] : []), ...info.claims] },
          { type: 'code', label: '头部', text: JSON.stringify(info.header, null, 2), height: 10 },
          { type: 'code', label: '载荷', text: JSON.stringify(info.payload, null, 2), height: 18 },
          { type: 'section', title: '验证签名', children: [
            { type: 'row', gap: 3, wrap: true, children: [{ type: 'input', bind: 'secret', label: '密钥', placeholder: 'HS256 / HS384 / HS512 的共享密钥' }, encodingNode] },
            { type: 'alert', tone, text: info.signature.text },
          ] },
        ],
      }
    }, (action, s) => {
      if (action !== 'stamp') return null
      let payload = {}
      try {
        payload = JSON.parse(s.payload)
      } catch (error) {
        return null
      }
      const now = Math.floor(Date.now() / 1000)
      return { payload: JSON.stringify({ ...payload, iat: now, exp: now + 3600 }, null, 2) }
    })
  },
  async run(ctx) {
    const p = ctx.params
    if (p.mode === 'encode') {
      const token = signJwt(String(p.payload ?? ''), { alg: String(p.alg || 'HS256'), secret: String(p.secret ?? ''), encoding: String(p.encoding || 'utf8') })
      return { outputs: [await writeText('token.jwt.txt', token)], summary: `已生成 ${p.alg} 令牌（${token.length} 字符）` }
    }
    const info = inspectJwt(String(p.token ?? ''), { secret: String(p.secret ?? ''), encoding: String(p.encoding || 'utf8') })
    const report = { header: info.header, payload: info.payload, status: info.problems, signature: info.signature.text }
    return { outputs: [await writeText('jwt.json', JSON.stringify(report, null, 2), 'application/json')], summary: [info.alg, ...info.problems, info.signature.text].filter(Boolean).join(' · ') }
  },
})

/* ========================================================================== */
/* Hashes and checksums                                                       */
/* ========================================================================== */

const HASH_CHOICES = [
  { key: 'md5', label: 'MD5', subtle: null },
  { key: 'sha1', label: 'SHA-1', subtle: 'SHA-1' },
  { key: 'sha256', label: 'SHA-256', subtle: 'SHA-256' },
  { key: 'sha512', label: 'SHA-512', subtle: 'SHA-512' },
  { key: 'crc32', label: 'CRC32', subtle: null },
]
const HASH_CHUNK = 4 * 1024 * 1024

/** Streams a workspace file through incremental hashers (MD5, CRC32, HMAC). */
async function hashFile(ctx, input, makers, onProgress) {
  const hashers = makers.map((make) => make())
  for (let offset = 0; offset < input.size || offset === 0; offset += HASH_CHUNK) {
    ctx.throwIfAborted()
    const chunk = await host.fs.read(input.id, offset, HASH_CHUNK)
    for (const h of hashers) h.update(chunk)
    onProgress(Math.min(1, (offset + chunk.length) / Math.max(1, input.size)))
    if (chunk.length < HASH_CHUNK) break
  }
  return hashers.map((h) => h.digest())
}

/** Incremental HMAC: the inner hash streams the file, the outer one wraps it at the end. */
function hmacHasher(name, key) {
  const size = createHash(name).blockSize
  const k = key.length > size ? hashBytes(name, key) : key
  const padded = new Uint8Array(size)
  padded.set(k)
  const inner = createHash(name).update(padded.map((b) => b ^ 0x36))
  return {
    update(data) {
      inner.update(data)
      return this
    },
    digest() {
      return createHash(name).update(padded.map((b) => b ^ 0x5c)).update(inner.digest()).digest()
    },
  }
}

function formatDigest(bytes, format) {
  if (format === 'base64') return bytesToBase64(bytes)
  const hex = toHex(bytes)
  return format === 'upper' ? hex.toUpperCase() : hex
}

TOOLS.push({
  id: 'hash',
  name: '哈希与校验和',
  category: 'dev',
  icon: 'fingerprint',
  description: '计算文件或文本的 MD5、SHA-1、SHA-256、SHA-512、CRC32，支持 HMAC 密钥，输出 sha256sum 兼容的校验文件，并可与期望值比对。',
  accept: ['*/*'],
  multiple: true,
  input: 'both',
  textFileName: 'input.txt',
  keywords: ['hash', 'checksum', 'md5', 'sha1', 'sha256', 'sha512', 'crc32', 'hmac', 'sha256sum', '哈希', '校验', '摘要', '文件指纹'],
  params: [
    ...HASH_CHOICES.map((c) => ({ key: c.key, type: 'switch', label: c.label, default: c.key === 'sha256' })),
    { key: 'format', type: 'select', label: '输出格式', default: 'lower', options: [{ value: 'lower', label: '十六进制（小写）' }, { value: 'upper', label: '十六进制（大写）' }, { value: 'base64', label: 'Base64' }] },
    { key: 'hmacKey', type: 'text', label: 'HMAC 密钥', default: '', placeholder: '留空则计算普通哈希', hint: '填写后 MD5 / SHA 计算 HMAC；CRC32 不参与。' },
    { key: 'expected', type: 'text', label: '期望值', default: '', placeholder: '粘贴下载页给出的校验值', hint: '与任一结果一致即通过，不区分大小写。' },
  ],
  async run(ctx) {
    const p = ctx.params
    const key = String(p.hmacKey ?? '')
    const chosen = HASH_CHOICES.filter((c) => p[c.key] && !(key && c.key === 'crc32'))
    if (!chosen.length) throw new Error(key ? '请至少选择一种 MD5 / SHA 算法' : '请至少选择一种算法')
    const format = String(p.format || 'lower')
    const lines = new Map(chosen.map((c) => [c.key, []]))
    const all = []
    for (const [index, input] of ctx.inputs.entries()) {
      const results = new Map()
      // SHA without a key: the host digests the file natively.
      for (const c of chosen) {
        if (!key && c.subtle) results.set(c.key, formatDigest(fromHex(await host.fs.digest(input.id, c.subtle)), format))
      }
      const streamed = chosen.filter((c) => !results.has(c.key))
      if (streamed.length) {
        const makers = streamed.map((c) => (c.key === 'crc32' ? crc32Hasher : key ? () => hmacHasher(c.key, utf8.encode(key)) : () => createHash(c.key)))
        const digests = await hashFile(ctx, input, makers, (f) => ctx.progress((index + f) / ctx.inputs.length, `计算 ${input.name}`))
        streamed.forEach((c, i) => results.set(c.key, formatDigest(digests[i], format)))
      }
      for (const c of chosen) {
        lines.get(c.key).push(`${results.get(c.key)}  ${input.name}`)
        all.push({ file: input.name, algorithm: `${key ? 'HMAC-' : ''}${c.label}`, value: results.get(c.key) })
      }
    }
    const text = chosen.map((c) => `# ${key ? 'HMAC-' : ''}${c.label}\n${lines.get(c.key).join('\n')}`).join('\n\n')
    const outputs = [await writeText(chosen.length === 1 ? `${chosen[0].key}sum.txt` : 'checksums.txt', text)]
    const expected = String(p.expected ?? '').trim().toLowerCase()
    let verdict = ''
    if (expected) {
      const hit = all.find((r) => r.value.toLowerCase() === expected)
      verdict = hit ? `✓ 与期望值一致（${hit.file} · ${hit.algorithm}）` : '✗ 没有任何结果与期望值一致'
    }
    const first = all[0]
    return { outputs, summary: [verdict, ctx.inputs.length === 1 && chosen.length === 1 ? `${first.algorithm}: ${first.value}` : `${ctx.inputs.length} 个文件 · ${chosen.map((c) => c.label).join('、')}`].filter(Boolean).join('；') }
  },
})

/* ========================================================================== */
/* URLs                                                                       */
/* ========================================================================== */

/** Decodes percent escapes, leaving malformed ones as they are instead of throwing. */
function safeDecode(text, plusAsSpace) {
  const source = plusAsSpace ? text.replace(/\+/g, ' ') : text
  try {
    return decodeURIComponent(source)
  } catch (error) {
    return source.replace(/(%[0-9a-f]{2})+/gi, (run) => {
      try {
        return decodeURIComponent(run)
      } catch (inner) {
        return run
      }
    })
  }
}

function describeUrl(text) {
  let raw = text.trim()
  let assumed = false
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    raw = `https://${raw}`
    assumed = true
  }
  const url = new URL(raw)
  const rows = [
    { label: '协议', value: url.protocol.replace(/:$/, '') + (assumed ? '（未写协议，按 https 解析）' : '') },
    ...(url.username ? [{ label: '用户名', value: safeDecode(url.username) }, { label: '密码', value: url.password ? '•'.repeat(8) : '—' }] : []),
    { label: '主机', value: url.hostname || '—' },
    { label: '端口', value: url.port || '（默认）' },
    { label: '路径', value: safeDecode(url.pathname) },
    { label: '查询', value: url.search ? safeDecode(url.search) : '—' },
    { label: '片段', value: url.hash ? safeDecode(url.hash) : '—' },
    { label: '来源 origin', value: url.origin },
  ]
  const params = {}
  const paramRows = []
  for (const [k, v] of url.searchParams) {
    paramRows.push({ label: k, value: v })
    params[k] = k in params ? [].concat(params[k], v) : v
  }
  return { rows, paramRows, params, href: url.href }
}

function transformUrlText(text, mode, component, plus) {
  return text.split('\n').map((line) => {
    if (mode === 'decode') return safeDecode(line, plus)
    if (component === 'uri') return encodeURI(line)
    const encoded = encodeURIComponent(line)
    return component === 'form' ? encoded.replace(/%20/g, '+') : encoded
  }).join('\n')
}

TOOLS.push({
  id: 'url',
  name: 'URL 解析与编解码',
  category: 'dev',
  icon: 'link',
  description: '拆解 URL 的协议、主机、端口、路径、查询参数与片段；按组件、整条 URI 或表单格式进行百分号编码与解码，逐行处理。',
  input: 'none',
  keywords: ['url', 'uri', 'query string', 'percent encoding', 'urlencode', 'urldecode', 'parse url', '网址', '链接解析', '编码', '查询参数'],
  setup(ui) {
    livePanel(ui, { mode: 'parse', text: 'https://example.com:8080/文档/页面?q=开源%20工具&tag=a&tag=b#section', component: 'component', plus: true }, (s) => {
      const nodes = [
        { type: 'segmented', bind: 'mode', options: [{ value: 'parse', label: '解析' }, { value: 'encode', label: '编码' }, { value: 'decode', label: '解码' }] },
        { type: 'textarea', bind: 'text', label: s.mode === 'parse' ? 'URL' : '文本（逐行处理）', rows: 4, mono: true },
      ]
      if (s.mode === 'parse') {
        if (!s.text.trim()) return { nodes }
        let info
        try {
          info = describeUrl(s.text)
        } catch (error) {
          return { nodes: [...nodes, { type: 'alert', tone: 'destructive', text: '不是有效的 URL' }] }
        }
        return {
          nodes: [
            ...nodes,
            { type: 'facts', rows: info.rows },
            ...(info.paramRows.length ? [{ type: 'section', title: `查询参数（${info.paramRows.length}）`, children: [{ type: 'facts', rows: info.paramRows }] }] : []),
            { type: 'code', label: '查询参数 JSON', text: JSON.stringify(info.params, null, 2), height: 10 },
            { type: 'code', label: '规范化后的 URL', text: info.href, wrap: true, height: 6 },
          ],
        }
      }
      return {
        nodes: [
          ...nodes,
          s.mode === 'encode'
            ? { type: 'select', bind: 'component', label: '编码方式', options: [{ value: 'component', label: '组件（encodeURIComponent，用于参数值）' }, { value: 'uri', label: '整条 URI（encodeURI，保留 : / ? & 等）' }, { value: 'form', label: '表单（空格编码为 +）' }] }
            : { type: 'switch', bind: 'plus', label: '把 + 当作空格', hint: '表单提交的数据需要开启。' },
          { type: 'code', label: s.mode === 'encode' ? '编码结果' : '解码结果', text: transformUrlText(s.text, s.mode, s.component, s.plus), wrap: true, height: 14 },
        ],
      }
    })
  },
  async run(ctx) {
    const p = ctx.params
    const text = String(p.text ?? '')
    if (p.mode === 'parse') {
      const info = describeUrl(text)
      return { outputs: [await writeText('url.json', JSON.stringify({ href: info.href, parts: Object.fromEntries(info.rows.map((r) => [r.label, r.value])), query: info.params }, null, 2), 'application/json')], summary: info.href }
    }
    const result = transformUrlText(text, String(p.mode), String(p.component || 'component'), p.plus !== false)
    return { outputs: [await writeText(p.mode === 'encode' ? 'encoded.txt' : 'decoded.txt', result)], summary: result.slice(0, 200) }
  },
})

/* ========================================================================== */
/* IDs and secrets                                                            */
/* ========================================================================== */

function randomBytes(n) {
  if (typeof crypto === 'undefined' || !crypto.getRandomValues) throw new Error('当前环境没有安全随机数源')
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)))
  return out
}

/** Uniform picks from an alphabet by rejection sampling, so no character is favoured. */
function randomString(alphabet, length) {
  const mask = (2 << Math.floor(Math.log2(alphabet.length - 1 || 1))) - 1
  let out = ''
  while (out.length < length) {
    for (const byte of randomBytes(Math.ceil(length * 1.6) + 8)) {
      const index = byte & mask
      if (index < alphabet.length) out += alphabet[index]
      if (out.length === length) break
    }
  }
  return out
}

function formatUuid(bytes) {
  const hex = toHex(bytes)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function uuidV4() {
  const b = randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  return formatUuid(b)
}

/** Time-ordered UUID (RFC 9562): 48-bit Unix milliseconds, then random bits. */
function uuidV7(now = Date.now()) {
  const b = randomBytes(16)
  let ms = now
  for (let i = 5; i >= 0; i--) {
    b[i] = ms % 256
    ms = Math.floor(ms / 256)
  }
  b[6] = (b[6] & 0x0f) | 0x70
  b[8] = (b[8] & 0x3f) | 0x80
  return formatUuid(b)
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function ulid(now = Date.now()) {
  let time = ''
  let ms = now
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[ms % 32] + time
    ms = Math.floor(ms / 32)
  }
  return time + randomString(CROCKFORD, 16)
}

const NANOID_ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict'
const PASSWORD_SETS = { lower: 'abcdefghijkmnopqrstuvwxyz', upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ', digits: '23456789', symbols: '!@#$%^&*-_=+?' }

function generateIds(s) {
  const count = Math.max(1, Math.min(1000, Math.round(Number(s.count) || 1)))
  const length = Math.max(4, Math.min(256, Math.round(Number(s.length) || 21)))
  const list = []
  let bits = 0
  for (let i = 0; i < count; i++) {
    let id
    switch (s.kind) {
      case 'uuid7': id = uuidV7(); bits = 74; break
      case 'ulid': id = ulid(); bits = 80; break
      case 'nanoid': id = randomString(NANOID_ALPHABET, length); bits = Math.floor(length * 6); break
      case 'hex': id = toHex(randomBytes(length)); bits = length * 8; break
      case 'base64': id = bytesToBase64(randomBytes(length), { url: true, pad: false }); bits = length * 8; break
      case 'password': {
        const alphabet = PASSWORD_SETS.lower + PASSWORD_SETS.upper + PASSWORD_SETS.digits + (s.symbols ? PASSWORD_SETS.symbols : '')
        // Regenerate until every enabled class is present.
        do id = randomString(alphabet, length)
        while (!(/[a-z]/.test(id) && /[A-Z]/.test(id) && /[0-9]/.test(id) && (!s.symbols || /[!@#$%^&*\-_=+?]/.test(id))))
        bits = Math.floor(length * Math.log2(alphabet.length))
        break
      }
      default: id = uuidV4(); bits = 122
    }
    if (s.kind === 'uuid4' || s.kind === 'uuid7') {
      if (!s.hyphens) id = id.replace(/-/g, '')
      if (s.upper) id = id.toUpperCase()
    }
    list.push(id)
  }
  return { list, bits }
}

TOOLS.push({
  id: 'uuid',
  name: 'UUID / ID 与密码生成',
  category: 'dev',
  icon: 'hash',
  description: '批量生成 UUID v4 / v7、ULID、NanoID、随机十六进制或 Base64 密钥与强密码，使用浏览器安全随机数，并显示熵值。',
  input: 'none',
  keywords: ['uuid', 'guid', 'uuid v7', 'ulid', 'nanoid', 'random', 'password generator', 'secret key', '唯一标识', '随机密码', '密钥生成'],
  setup(ui) {
    livePanel(ui, { kind: 'uuid4', count: 5, length: 21, upper: false, hyphens: true, symbols: true, seed: 0 }, (s) => {
      const { list, bits } = generateIds(s)
      const usesLength = ['nanoid', 'hex', 'base64', 'password'].includes(s.kind)
      return {
        nodes: [
          { type: 'select', bind: 'kind', label: '类型', options: [
            { value: 'uuid4', label: 'UUID v4（随机）' }, { value: 'uuid7', label: 'UUID v7（按时间排序）' }, { value: 'ulid', label: 'ULID' },
            { value: 'nanoid', label: 'NanoID' }, { value: 'hex', label: '随机十六进制（字节数）' }, { value: 'base64', label: '随机 Base64URL（字节数）' }, { value: 'password', label: '强密码' },
          ] },
          { type: 'slider', bind: 'count', label: '数量', min: 1, max: 100, step: 1 },
          { type: 'slider', bind: 'length', label: s.kind === 'hex' || s.kind === 'base64' ? '字节数' : '长度', min: 8, max: 128, step: 1, when: { key: 'kind', equals: ['nanoid', 'hex', 'base64', 'password'] } },
          { type: 'row', gap: 4, wrap: true, children: [
            { type: 'switch', bind: 'hyphens', label: '保留连字符', when: { key: 'kind', equals: ['uuid4', 'uuid7'] } },
            { type: 'switch', bind: 'upper', label: '大写', when: { key: 'kind', equals: ['uuid4', 'uuid7'] } },
            { type: 'switch', bind: 'symbols', label: '包含符号', when: { key: 'kind', equals: 'password' } },
          ] },
          { type: 'button', text: '重新生成', action: 'regenerate', variant: 'outline', icon: 'refresh' },
          { type: 'text', variant: 'muted', text: `每个约 ${bits} 位随机熵${usesLength || s.kind === 'uuid4' ? '' : '（其余为时间戳）'}。` },
          { type: 'code', label: `${list.length} 个`, text: list.join('\n'), height: 18 },
        ],
      }
    }, (action, s) => (action === 'regenerate' ? { seed: (Number(s.seed) || 0) + 1 } : null))
  },
  async run(ctx) {
    const { list } = generateIds(ctx.params)
    return { outputs: [await writeText('ids.txt', list.join('\n'))], summary: `已生成 ${list.length} 个` }
  },
})

/* ========================================================================== */
/* Regular expressions                                                        */
/* ========================================================================== */

const REGEX_FLAGS = { g: '全局', i: '忽略大小写', m: '多行', s: '. 匹配换行', u: 'Unicode', v: 'Unicode 集合', y: '粘连', d: '匹配下标' }
const MAX_MATCHES = 1000

function runRegex(pattern, flags, text, replacement) {
  const invalid = [...flags].find((f) => !REGEX_FLAGS[f])
  if (invalid) throw new Error(`不支持的标志：${invalid}`)
  const re = new RegExp(pattern, flags)
  const matches = []
  if (re.global || re.sticky) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) && matches.length < MAX_MATCHES) {
      matches.push(m)
      // An empty match would otherwise loop forever at the same position.
      if (m[0] === '') re.lastIndex += 1
    }
  } else {
    const m = re.exec(text)
    if (m) matches.push(m)
  }
  const lines = matches.map((m, i) => {
    const parts = [`#${i + 1}  [${m.index}–${m.index + m[0].length}]  ${JSON.stringify(m[0])}`]
    for (let g = 1; g < m.length; g++) parts.push(`    $${g} = ${m[g] === undefined ? '（未参与匹配）' : JSON.stringify(m[g])}`)
    for (const [name, value] of Object.entries(m.groups || {})) parts.push(`    <${name}> = ${value === undefined ? '（未参与匹配）' : JSON.stringify(value)}`)
    return parts.join('\n')
  })
  const groups = new RegExp(`${pattern}|`, flags.replace(/[gy]/g, '')).exec('').length - 1
  const replaced = replacement === null ? null : text.replace(new RegExp(pattern, flags), replacement)
  return { count: matches.length, capped: matches.length >= MAX_MATCHES, groups, report: lines.join('\n'), replaced }
}

TOOLS.push({
  id: 'regex',
  name: '正则表达式测试',
  category: 'dev',
  icon: 'regex',
  description: '实时测试 JavaScript 正则表达式：列出每处匹配的位置、捕获组与命名组，预览替换结果。',
  input: 'none',
  keywords: ['regex', 'regexp', 'regular expression', 'pattern', 'match', 'replace', 'capture group', '正则', '正则表达式', '匹配', '替换'],
  setup(ui) {
    livePanel(ui, {
      pattern: '(?<user>[\\w.]+)@(?<domain>[\\w-]+\\.[a-z]{2,})',
      flags: 'gi',
      text: '联系 alice@example.com 或 Bob.Smith@omnitool.dev，\n无效：foo@bar',
      replace: '<$<user> at $<domain>>',
      showReplace: true,
    }, (s) => {
      const nodes = [
        { type: 'row', gap: 2, children: [
          { type: 'input', bind: 'pattern', label: '正则表达式', placeholder: '不需要写两侧的 /' },
          { type: 'input', bind: 'flags', label: '标志', placeholder: 'gimsuyd' },
        ] },
        { type: 'textarea', bind: 'text', label: '测试文本', rows: 6, mono: true },
        { type: 'switch', bind: 'showReplace', label: '预览替换' },
        { type: 'input', bind: 'replace', label: '替换为', placeholder: '$1、$<name>、$& 引用匹配内容', when: { key: 'showReplace', equals: true } },
      ]
      if (!s.pattern) return { nodes }
      let result
      try {
        result = runRegex(s.pattern, s.flags, s.text, s.showReplace ? s.replace : null)
      } catch (error) {
        return { nodes: [...nodes, { type: 'alert', tone: 'destructive', title: '表达式无效', text: error.message }] }
      }
      return {
        nodes: [
          ...nodes,
          { type: 'facts', rows: [
            { label: '匹配', value: `${result.count}${result.capped ? '+' : ''} 处` },
            { label: '捕获组', value: String(result.groups) },
            { label: '标志', value: [...s.flags].map((f) => REGEX_FLAGS[f]).join('、') || '无' },
          ] },
          { type: 'code', label: '匹配详情', text: result.report || '没有匹配', height: 16 },
          ...(result.replaced !== null ? [{ type: 'code', label: '替换结果', text: result.replaced, wrap: true, height: 12 }] : []),
        ],
      }
    })
  },
  async run(ctx) {
    const p = ctx.params
    const result = runRegex(String(p.pattern ?? ''), String(p.flags ?? ''), String(p.text ?? ''), p.showReplace ? String(p.replace ?? '') : null)
    const body = `${result.report || '没有匹配'}${result.replaced !== null ? `\n\n--- 替换结果 ---\n${result.replaced}` : ''}`
    return { outputs: [await writeText('regex.txt', body)], summary: `${result.count} 处匹配` }
  },
})

/* ========================================================================== */
/* Text diff                                                                  */
/* ========================================================================== */

/**
 * Line diff with Myers' O(ND) algorithm, as a list of `[op, line]` where op is
 * ' ', '-' or '+'. `normalise` maps a line to the key compared (whitespace or
 * case folding); the original line is what gets printed.
 */
function diffLines(a, b, normalise = (line) => line) {
  const A = a.map(normalise)
  const B = b.map(normalise)
  const n = A.length
  const m = B.length
  const max = n + m
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace = []
  let done = false
  for (let d = 0; d <= max && !done; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && A[x] === B[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        done = true
        break
      }
    }
    // Each step keeps a copy of the frontier; bound the total instead of exhausting memory.
    if ((d + 1) * v.length > 40_000_000) throw new Error('两段文本差异过多，超出可计算范围；请缩小比较范围')
  }
  const ops = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d]
    const k = x - y
    const prevK = k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1]) ? k + 1 : k - 1
    const prevX = vd[offset + prevK]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x--
      y--
      ops.push([' ', a[x]])
    }
    if (d > 0) {
      if (x === prevX) ops.push(['+', b[--y]])
      else ops.push(['-', a[--x]])
    }
  }
  return ops.reverse()
}

/** Unified diff with `context` lines around each change. */
function unifiedDiff(ops, context = 3, names = ['原文', '修改后']) {
  const hunks = []
  let aLine = 1
  let bLine = 1
  const annotated = ops.map(([op, line]) => {
    const entry = { op, line, a: aLine, b: bLine }
    if (op !== '+') aLine++
    if (op !== '-') bLine++
    return entry
  })
  let i = 0
  while (i < annotated.length) {
    if (annotated[i].op === ' ') {
      i++
      continue
    }
    const start = Math.max(0, i - context)
    let end = i
    while (end < annotated.length) {
      if (annotated[end].op !== ' ') {
        end++
        continue
      }
      let run = 0
      while (end + run < annotated.length && annotated[end + run].op === ' ') run++
      if (end + run >= annotated.length || run > context * 2) {
        end = Math.min(annotated.length, end + context)
        break
      }
      end += run
    }
    const slice = annotated.slice(start, end)
    const aCount = slice.filter((e) => e.op !== '+').length
    const bCount = slice.filter((e) => e.op !== '-').length
    hunks.push(`@@ -${slice[0].a},${aCount} +${slice[0].b},${bCount} @@\n${slice.map((e) => `${e.op}${e.line}`).join('\n')}`)
    i = end
  }
  return hunks.length ? `--- ${names[0]}\n+++ ${names[1]}\n${hunks.join('\n')}` : ''
}

function compareTexts(left, right, { ignoreWhitespace = false, ignoreCase = false } = {}, names = ['原文', '修改后']) {
  const normalise = (line) => {
    let out = ignoreWhitespace ? line.replace(/\s+/g, ' ').trim() : line
    if (ignoreCase) out = out.toLowerCase()
    return out
  }
  const ops = diffLines(left.split(/\r?\n/), right.split(/\r?\n/), normalise)
  const added = ops.filter(([op]) => op === '+').length
  const removed = ops.filter(([op]) => op === '-').length
  return { ops, added, removed, unified: unifiedDiff(ops, 3, names) }
}

TOOLS.push({
  id: 'diff',
  name: '文本对比',
  category: 'dev',
  icon: 'diff',
  description: '逐行比较两段文本或两个文件，输出统一差异格式（unified diff），可忽略空白与大小写。',
  accept: ['text/*', '.txt', '.md', '.json', '.yaml', '.yml', '.xml', '.csv', '.js', '.ts', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.css', '.html', '.sql', '.sh', '.ini', '.toml', '.env', '.log'],
  multiple: true,
  minFiles: 0,
  keywords: ['diff', 'compare', 'text compare', 'unified diff', 'patch', '文本对比', '差异', '比较', '找不同'],
  setup(ui) {
    livePanel(ui, { left: '', right: '', ignoreWhitespace: false, ignoreCase: false, fromFiles: false }, (s) => {
      const texts = ui.inputs.length >= 2
      const nodes = [
        ...(texts ? [{ type: 'alert', tone: 'info', text: `将比较前两个文件：${ui.inputs[0].name} ↔ ${ui.inputs[1].name}（点「导出为文件」得到差异）。也可以清空文件，直接在下方粘贴。` }] : []),
        { type: 'row', gap: 3, wrap: true, children: [
          { type: 'textarea', bind: 'left', label: '原文', rows: 10, mono: true },
          { type: 'textarea', bind: 'right', label: '修改后', rows: 10, mono: true },
        ] },
        { type: 'row', gap: 4, wrap: true, children: [
          { type: 'switch', bind: 'ignoreWhitespace', label: '忽略空白差异' },
          { type: 'switch', bind: 'ignoreCase', label: '忽略大小写' },
        ] },
      ]
      if (!s.left && !s.right) return { nodes, runDisabled: !texts }
      const result = compareTexts(s.left, s.right, s)
      return {
        nodes: [
          ...nodes,
          { type: 'facts', rows: [{ label: '新增', value: `${result.added} 行` }, { label: '删除', value: `${result.removed} 行` }] },
          { type: 'code', label: '差异', text: result.unified || '两段文本相同', height: 22 },
        ],
      }
    })
  },
  async run(ctx) {
    const p = ctx.params
    let left = String(p.left ?? '')
    let right = String(p.right ?? '')
    let names = ['原文', '修改后']
    if (ctx.inputs.length >= 2) {
      left = await host.fs.readText(ctx.inputs[0].id)
      right = await host.fs.readText(ctx.inputs[1].id)
      names = [ctx.inputs[0].name, ctx.inputs[1].name]
    }
    const result = compareTexts(left, right, p, names)
    return { outputs: [await writeText('changes.diff', result.unified || '# 两段文本相同', 'text/x-diff')], summary: `+${result.added} −${result.removed}` }
  },
})

/* ========================================================================== */
/* Cron                                                                       */
/* ========================================================================== */

const CRON_MACROS = { '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *' }
const CRON_FIELDS = [
  { name: '秒', min: 0, max: 59 },
  { name: '分钟', min: 0, max: 59 },
  { name: '小时', min: 0, max: 23 },
  { name: '日', min: 1, max: 31 },
  { name: '月', min: 1, max: 12, names: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] },
  { name: '星期', min: 0, max: 7, names: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] },
]

function parseCronField(text, field) {
  const values = new Set()
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) throw new Error(`${field.name}字段的步长「${stepText}」无效`)
    const value = (token) => {
      const upper = token.toUpperCase()
      const named = field.names ? field.names.indexOf(upper) : -1
      const n = named >= 0 ? named + (field.name === '月' ? 1 : 0) : Number(token)
      if (!Number.isInteger(n) || n < field.min || n > field.max) throw new Error(`${field.name}字段的值「${token}」超出范围 ${field.min}–${field.max}`)
      return n
    }
    let start = field.min
    let end = field.max
    if (range !== '*' && range !== '?') {
      const [a, b] = range.split('-')
      start = value(a)
      end = b === undefined ? (stepText === undefined ? start : field.max) : value(b)
      if (end < start) throw new Error(`${field.name}字段的范围「${range}」起点大于终点`)
    }
    for (let n = start; n <= end; n += step) values.add(field.name === '星期' && n === 7 ? 0 : n)
  }
  return values
}

/** Five fields (minute first), six (seconds first), or an @macro. Day-of-month and weekday OR together, as in Vixie cron. */
function parseCron(expression) {
  const text = String(expression).trim()
  const expanded = CRON_MACROS[text.toLowerCase()] ?? text
  const parts = expanded.split(/\s+/)
  if (parts.length !== 5 && parts.length !== 6) throw new Error(`应有 5 个字段（分 时 日 月 周）或 6 个字段（秒 分 时 日 月 周），这里有 ${parts.length} 个`)
  const withSeconds = parts.length === 6 ? parts : ['0', ...parts]
  const sets = withSeconds.map((part, i) => parseCronField(part, CRON_FIELDS[i]))
  return { seconds: parts.length === 6, sets, restrictedDay: withSeconds[3] !== '*' && withSeconds[3] !== '?', restrictedWeekday: withSeconds[5] !== '*' && withSeconds[5] !== '?', fields: withSeconds }
}

function cronMatchesDay(cron, date) {
  const dom = cron.sets[3].has(date.getDate())
  const dow = cron.sets[5].has(date.getDay())
  if (cron.restrictedDay && cron.restrictedWeekday) return dom || dow
  return dom && dow
}

/** The next `count` run times after `from`, in the browser's local time. */
function nextCronRuns(cron, count = 10, from = new Date()) {
  const runs = []
  const d = new Date(from.getTime())
  d.setMilliseconds(0)
  d.setSeconds(d.getSeconds() + 1)
  const limit = from.getTime() + 5 * 366 * 86400000
  while (runs.length < count && d.getTime() <= limit) {
    if (!cron.sets[4].has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1)
      d.setHours(0, 0, 0)
      continue
    }
    if (!cronMatchesDay(cron, d)) {
      d.setDate(d.getDate() + 1)
      d.setHours(0, 0, 0)
      continue
    }
    if (!cron.sets[2].has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0)
      continue
    }
    if (!cron.sets[1].has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0)
      continue
    }
    if (!cron.sets[0].has(d.getSeconds())) {
      d.setSeconds(d.getSeconds() + 1)
      continue
    }
    runs.push(new Date(d.getTime()))
    d.setSeconds(d.getSeconds() + 1)
  }
  return runs
}

function describeCron(cron) {
  const [sec, min, hour, dom, month, dow] = cron.fields
  const list = (set, format = String) => [...set].sort((a, b) => a - b).map(format).join('、')
  const bits = []
  if (month !== '*') bits.push(`${list(cron.sets[4])} 月`)
  if (cron.restrictedDay && cron.restrictedWeekday) bits.push(`每月 ${list(cron.sets[3])} 日或每周${list(cron.sets[5], (d) => '日一二三四五六'[d])}`)
  else if (cron.restrictedDay) bits.push(`每月 ${list(cron.sets[3])} 日`)
  else if (cron.restrictedWeekday) bits.push(`每周${list(cron.sets[5], (d) => '日一二三四五六'[d])}`)
  else bits.push('每天')
  const step = (text) => /^\*\/(\d+)$/.exec(text)
  if (hour === '*' && min === '*') bits.push('每分钟')
  else if (hour === '*' && step(min)) bits.push(`每 ${step(min)[1]} 分钟`)
  else if (hour === '*') bits.push(`每小时的第 ${list(cron.sets[1])} 分`)
  else if (step(hour)) bits.push(`每 ${step(hour)[1]} 小时的第 ${list(cron.sets[1])} 分`)
  else if (cron.sets[2].size * cron.sets[1].size <= 6) bits.push([...cron.sets[2]].sort((a, b) => a - b).flatMap((h) => [...cron.sets[1]].sort((a, b) => a - b).map((m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)).join('、'))
  else bits.push(`${list(cron.sets[2])} 点的第 ${list(cron.sets[1])} 分`)
  if (cron.seconds && sec !== '0') bits.push(`第 ${list(cron.sets[0])} 秒`)
  return bits.join('，')
}

TOOLS.push({
  id: 'cron',
  name: 'Cron 表达式解析',
  category: 'dev',
  icon: 'calendar-clock',
  description: '把 Cron 表达式翻译成中文说明，并列出接下来的执行时间；支持 5 段、带秒的 6 段、范围 / 列表 / 步长、月份与星期英文缩写和 @daily 等宏。',
  input: 'none',
  keywords: ['cron', 'crontab', 'schedule', 'quartz', 'next run', '定时任务', '计划任务', 'cron 表达式'],
  setup(ui) {
    livePanel(ui, { expression: '30 9 * * 1-5', count: 10 }, (s) => {
      const nodes = [
        { type: 'input', bind: 'expression', label: '表达式', placeholder: '分 时 日 月 周，如 */15 9-18 * * MON-FRI' },
        { type: 'slider', bind: 'count', label: '列出次数', min: 1, max: 50, step: 1 },
      ]
      if (!s.expression.trim()) return { nodes }
      let cron
      try {
        cron = parseCron(s.expression)
      } catch (error) {
        return { nodes: [...nodes, { type: 'alert', tone: 'destructive', title: '表达式无效', text: error.message }] }
      }
      const runs = nextCronRuns(cron, s.count)
      return {
        nodes: [
          ...nodes,
          { type: 'alert', tone: 'info', title: describeCron(cron), text: `按本机时区（${Intl.DateTimeFormat().resolvedOptions().timeZone}）计算。` },
          { type: 'facts', rows: CRON_FIELDS.map((f, i) => ({ label: f.name, value: `${cron.fields[i]} → ${[...cron.sets[i]].sort((a, b) => a - b).join(',')}` })).slice(cron.seconds ? 0 : 1) },
          { type: 'code', label: '接下来的执行时间', text: runs.length ? runs.map((d) => `${formatInZone(d.getTime(), 'local').text.slice(0, 19)}  星期${'日一二三四五六'[d.getDay()]}`).join('\n') : '五年内不会执行', height: 16 },
        ],
      }
    })
  },
  async run(ctx) {
    const cron = parseCron(String(ctx.params.expression ?? ''))
    const runs = nextCronRuns(cron, Number(ctx.params.count) || 10)
    const text = `${describeCron(cron)}\n\n${runs.map((d) => formatInZone(d.getTime(), 'local').text).join('\n')}`
    return { outputs: [await writeText('cron.txt', text)], summary: describeCron(cron) }
  },
})

/* ========================================================================== */
/* Hex dump                                                                   */
/* ========================================================================== */

const DUMP_LIMIT = 4 * 1024 * 1024

/** `hexdump -C` layout: offset, bytes in pairs of groups, printable ASCII. */
function hexDump(bytes, { width = 16, start = 0, upper = false } = {}) {
  const lines = []
  const half = width / 2
  for (let i = 0; i < bytes.length; i += width) {
    const row = bytes.subarray(i, i + width)
    let hex = ''
    for (let j = 0; j < width; j++) {
      hex += j < row.length ? row[j].toString(16).padStart(2, '0') : '  '
      hex += j === half - 1 ? '  ' : ' '
    }
    const ascii = [...row].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')
    const line = `${(start + i).toString(16).padStart(8, '0')}  ${hex} |${ascii}|`
    lines.push(upper ? line.replace(/^([0-9a-f]+)(\s+)([0-9a-f ]+)/, (_, o, sp, h) => o.toUpperCase() + sp + h.toUpperCase()) : line)
  }
  return lines.join('\n')
}

/** Bytes back from a hex dump (hexdump -C, xxd, or bare hex); offsets and ASCII columns are ignored. */
function parseHexDump(text) {
  const chunks = []
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw.replace(/\|.*\|\s*$/, '')
    if (/^\s*[0-9a-f]{6,}[:\s]\s/i.test(line)) line = line.replace(/^\s*[0-9a-f]+:?/i, '')
    // xxd appends its ASCII column after two spaces; hex groups never contain double spaces followed by non-hex.
    line = line.replace(/\s{2,}(?=[^0-9a-f\s]).*$/i, '')
    chunks.push(line)
  }
  return fromHex(chunks.join(' '))
}

TOOLS.push({
  id: 'hexdump',
  name: '十六进制查看',
  category: 'dev',
  icon: 'binary',
  description: '以 hexdump -C 格式查看任意文件的字节与 ASCII，按文件头识别类型；也能把十六进制文本（含 xxd / hexdump 输出）还原成二进制文件。',
  accept: ['*/*'],
  multiple: true,
  input: 'both',
  textFileName: 'hex.txt',
  keywords: ['hex', 'hexdump', 'xxd', 'binary', 'bytes', 'magic number', 'file signature', '十六进制', '二进制查看', '字节', '文件头'],
  params: [
    { key: 'mode', type: 'select', label: '操作', default: 'dump', options: [{ value: 'dump', label: '查看文件字节' }, { value: 'reverse', label: '十六进制文本还原为文件' }] },
    { key: 'offset', type: 'number', label: '起始偏移', default: 0, min: 0, suffix: '字节', when: { key: 'mode', equals: 'dump' } },
    { key: 'length', type: 'number', label: '长度', default: 4096, min: 0, suffix: '字节', hint: '0 表示到文件末尾（最多 4 MB）。', when: { key: 'mode', equals: 'dump' } },
    { key: 'width', type: 'select', label: '每行字节', default: '16', options: ['8', '16', '32'].map((v) => ({ value: v, label: v })), when: { key: 'mode', equals: 'dump' } },
    { key: 'upper', type: 'switch', label: '大写字母', default: false, when: { key: 'mode', equals: 'dump' } },
  ],
  async run(ctx) {
    const p = ctx.params
    const outputs = []
    const notes = []
    for (const input of ctx.inputs) {
      const base = input.name.replace(/\.[^.]+$/, '')
      if (p.mode === 'reverse') {
        const bytes = parseHexDump(await host.fs.readText(input.id))
        const kind = sniffType(bytes)
        outputs.push((await host.fs.writeAll(`${base}.${kind.ext}`, bytes, kind.type)).id)
        notes.push(`${input.name} → ${bytes.length} 字节（${kind.label}）`)
        continue
      }
      const start = Math.max(0, Math.floor(Number(p.offset) || 0))
      const wanted = Math.floor(Number(p.length) || 0)
      const length = Math.min(DUMP_LIMIT, wanted > 0 ? wanted : input.size - start)
      const bytes = await host.fs.read(input.id, start, length)
      const head = start === 0 ? bytes : await host.fs.read(input.id, 0, 16)
      const kind = sniffType(head)
      const header = `# ${input.name} · ${input.size} 字节 · ${kind.label}\n# 偏移 0x${start.toString(16)} 起 ${bytes.length} 字节${start + bytes.length < input.size ? '（未到文件末尾）' : ''}\n`
      outputs.push(await writeText(`${base}.hex.txt`, header + hexDump(bytes, { width: Number(p.width) || 16, start, upper: Boolean(p.upper) })))
      notes.push(`${input.name}：${kind.label}，${bytes.length} 字节`)
    }
    return { outputs, summary: notes.join('；') }
  },
})

/* ========================================================================== */
/* Naming styles                                                              */
/* ========================================================================== */

/** Words of an identifier or phrase: splits on separators, case changes and letter/digit boundaries, keeping acronyms whole. */
function splitWords(text) {
  return String(text)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

const NAMING_STYLES = [
  { id: 'camel', label: 'camelCase', make: (w) => w.map((x, i) => (i ? cap(x) : x.toLowerCase())).join('') },
  { id: 'pascal', label: 'PascalCase', make: (w) => w.map(cap).join('') },
  { id: 'snake', label: 'snake_case', make: (w) => w.map((x) => x.toLowerCase()).join('_') },
  { id: 'constant', label: 'CONSTANT_CASE', make: (w) => w.map((x) => x.toUpperCase()).join('_') },
  { id: 'kebab', label: 'kebab-case', make: (w) => w.map((x) => x.toLowerCase()).join('-') },
  { id: 'train', label: 'Train-Case', make: (w) => w.map(cap).join('-') },
  { id: 'dot', label: 'dot.case', make: (w) => w.map((x) => x.toLowerCase()).join('.') },
  { id: 'path', label: 'path/case', make: (w) => w.map((x) => x.toLowerCase()).join('/') },
  { id: 'title', label: 'Title Case', make: (w) => w.map(cap).join(' ') },
  { id: 'lower', label: 'lower words', make: (w) => w.map((x) => x.toLowerCase()).join(' ') },
]

function cap(word) {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
}

function convertNaming(text, style) {
  const lines = String(text).split(/\r?\n/)
  const one = (id) => lines.map((line) => (line.trim() ? NAMING_STYLES.find((s) => s.id === id).make(splitWords(line)) : '')).join('\n')
  if (style !== 'all') return one(style)
  return NAMING_STYLES.map((s) => `# ${s.label}\n${one(s.id)}`).join('\n\n')
}

TOOLS.push({
  id: 'naming',
  name: '命名风格转换',
  category: 'dev',
  icon: 'case-sensitive',
  description: '在 camelCase、PascalCase、snake_case、CONSTANT_CASE、kebab-case、dot.case 等命名风格之间批量转换，逐行处理，正确拆分 XMLHttpRequest 这类缩写。',
  input: 'none',
  keywords: ['camelcase', 'snake case', 'kebab case', 'pascal case', 'naming convention', 'identifier', '命名', '驼峰', '下划线', '变量名'],
  setup(ui) {
    livePanel(ui, { text: 'user profile id\nXMLHttpRequest\nget_http_response_code\nmax-retry-count', style: 'all' }, (s) => ({
      nodes: [
        { type: 'textarea', bind: 'text', label: '名称（每行一个）', rows: 6, mono: true },
        { type: 'select', bind: 'style', label: '转换为', options: [{ value: 'all', label: '全部风格' }, ...NAMING_STYLES.map((n) => ({ value: n.id, label: n.label }))] },
        { type: 'code', label: '结果', text: convertNaming(s.text, s.style), height: 22 },
      ],
    }))
  },
  async run(ctx) {
    const text = convertNaming(String(ctx.params.text ?? ''), String(ctx.params.style || 'all'))
    return { outputs: [await writeText('names.txt', text)], summary: text.split('\n')[ctx.params.style === 'all' ? 1 : 0] }
  },
})

/* ========================================================================== */
/* Escaping                                                                   */
/* ========================================================================== */

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', times: '×', divide: '÷', yen: '¥', euro: '€', pound: '£', deg: '°', plusmn: '±', para: '¶', sect: '§', bull: '•' }

/** C-style backslash escapes as JavaScript and JSON read them. */
function unescapeBackslashes(text) {
  return text.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|U[0-9a-fA-F]{8}|[0-7]{1,3}|.)/gs, (_, seq) => {
    if (seq[0] === 'u' && seq[1] === '{') return String.fromCodePoint(parseInt(seq.slice(2, -1), 16))
    if (seq[0] === 'u' || seq[0] === 'x' || seq[0] === 'U') return String.fromCodePoint(parseInt(seq.slice(1), 16))
    if (/^[0-7]+$/.test(seq)) return String.fromCharCode(parseInt(seq, 8))
    return { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' }[seq] ?? seq
  })
}

const ESCAPERS = {
  json: {
    label: 'JSON 字符串',
    escape: (t) => JSON.stringify(t).slice(1, -1),
    unescape: (t) => {
      try {
        return JSON.parse(`"${t.replace(/^"|"$/g, '')}"`)
      } catch (error) {
        throw new Error(`不是有效的 JSON 字符串内容：${error.message}`)
      }
    },
  },
  js: {
    label: 'JavaScript 字符串',
    escape: (t) => JSON.stringify(t).slice(1, -1).replace(/'/g, "\\'").replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`),
    unescape: (t) => unescapeBackslashes(t.replace(/^(['"`])([\s\S]*)\1$/, '$2')),
  },
  html: {
    label: 'HTML 实体',
    escape: (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    unescape: (t) => t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, code) => {
      if (code[0] === '#') {
        const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))
        return n <= 0x10ffff ? String.fromCodePoint(n) : whole
      }
      return HTML_ENTITIES[code.toLowerCase()] ?? whole
    }),
  },
  unicode: {
    label: 'Unicode 转义（\\uXXXX）',
    escape: (t) => [...t].map((c) => {
      const code = c.codePointAt(0)
      if (code < 0x80) return c
      if (code <= 0xffff) return `\\u${code.toString(16).padStart(4, '0')}`
      const high = Math.floor((code - 0x10000) / 0x400) + 0xd800
      const low = ((code - 0x10000) % 0x400) + 0xdc00
      return `\\u${high.toString(16)}\\u${low.toString(16)}`
    }).join(''),
    unescape: (t) => t.replace(/\\u\{([0-9a-f]+)\}|\\U([0-9a-f]{8})|(?:\\u[0-9a-f]{4})+/gi, (whole, braced, long) => {
      if (braced) return String.fromCodePoint(parseInt(braced, 16))
      if (long) return String.fromCodePoint(parseInt(long, 16))
      return String.fromCharCode(...whole.match(/[0-9a-f]{4}/gi).map((h) => parseInt(h, 16)))
    }),
  },
  sql: {
    label: 'SQL 字符串（单引号）',
    escape: (t) => t.replace(/'/g, "''"),
    unescape: (t) => t.replace(/^'([\s\S]*)'$/, '$1').replace(/''/g, "'"),
  },
  shell: {
    label: 'Shell 单引号参数',
    escape: (t) => `'${t.replace(/'/g, `'\\''`)}'`,
    unescape: (t) => t.trim().replace(/'\\''/g, "'").replace(/^'([\s\S]*)'$/, '$1'),
  },
  regex: {
    label: '正则表达式字面量',
    escape: (t) => t.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&'),
    unescape: (t) => t.replace(/\\([^a-zA-Z0-9])/g, '$1'),
  },
  csv: {
    label: 'CSV 字段',
    escape: (t) => (/[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t),
    unescape: (t) => t.replace(/^"([\s\S]*)"$/, '$1').replace(/""/g, '"'),
  },
}

TOOLS.push({
  id: 'escape',
  name: '字符串转义',
  category: 'dev',
  icon: 'braces',
  description: '在 JSON、JavaScript、HTML 实体、Unicode、SQL、Shell、正则表达式与 CSV 的转义格式之间转义与反转义。',
  input: 'none',
  keywords: ['escape', 'unescape', 'html entities', 'json string', 'unicode escape', 'shell quote', 'sql escape', '转义', '反转义', 'html 实体'],
  setup(ui) {
    livePanel(ui, { text: '他说："Hello <World>" & 路径 C:\\temp\n换行', format: 'json', direction: 'escape' }, (s) => {
      const escaper = ESCAPERS[s.format] || ESCAPERS.json
      let result = ''
      let error = ''
      try {
        result = escaper[s.direction === 'unescape' ? 'unescape' : 'escape'](s.text)
      } catch (e) {
        error = e.message
      }
      return {
        nodes: [
          { type: 'row', gap: 3, wrap: true, children: [
            { type: 'select', bind: 'format', label: '格式', options: Object.entries(ESCAPERS).map(([value, e]) => ({ value, label: e.label })) },
            { type: 'segmented', bind: 'direction', label: '方向', options: [{ value: 'escape', label: '转义' }, { value: 'unescape', label: '反转义' }] },
          ] },
          { type: 'textarea', bind: 'text', label: '输入', rows: 6, mono: true },
          error ? { type: 'alert', tone: 'destructive', text: error } : { type: 'code', label: '结果', text: result, wrap: true, height: 16 },
        ],
      }
    })
  },
  async run(ctx) {
    const escaper = ESCAPERS[ctx.params.format] || ESCAPERS.json
    const result = escaper[ctx.params.direction === 'unescape' ? 'unescape' : 'escape'](String(ctx.params.text ?? ''))
    return { outputs: [await writeText('escaped.txt', result)], summary: `${escaper.label} · ${ctx.params.direction === 'unescape' ? '反转义' : '转义'}` }
  },
})

/* ========================================================================== */
/* JSON to types                                                              */
/* ========================================================================== */

/**
 * A structural type inferred from sample JSON. Arrays merge their elements, so
 * a field missing from some objects becomes optional and a field that is
 * sometimes null becomes nullable.
 *   { kind: 'string' | 'integer' | 'number' | 'boolean' | 'null' | 'any' }
 *   { kind: 'array', item }
 *   { kind: 'object', fields: Map<name, { type, optional }> }
 */
function inferType(value) {
  if (value === null) return { kind: 'null' }
  if (Array.isArray(value)) return { kind: 'array', item: value.length ? value.map(inferType).reduce(mergeTypes) : { kind: 'any' } }
  if (typeof value === 'object') {
    const fields = new Map()
    for (const [key, v] of Object.entries(value)) fields.set(key, { type: inferType(v), optional: false })
    return { kind: 'object', fields }
  }
  if (typeof value === 'number') return { kind: Number.isInteger(value) ? 'integer' : 'number' }
  return { kind: typeof value === 'boolean' ? 'boolean' : 'string' }
}

function mergeTypes(a, b) {
  if (a.kind === 'null' && b.kind !== 'null') return { ...b, nullable: true }
  if (b.kind === 'null' && a.kind !== 'null') return { ...a, nullable: true }
  const nullable = Boolean(a.nullable || b.nullable)
  if (a.kind === b.kind) {
    if (a.kind === 'array') return { kind: 'array', item: mergeTypes(a.item, b.item), nullable }
    if (a.kind === 'object') {
      const fields = new Map()
      for (const name of new Set([...a.fields.keys(), ...b.fields.keys()])) {
        const fa = a.fields.get(name)
        const fb = b.fields.get(name)
        fields.set(name, fa && fb ? { type: mergeTypes(fa.type, fb.type), optional: fa.optional || fb.optional } : { type: (fa || fb).type, optional: true })
      }
      return { kind: 'object', fields, nullable }
    }
    return { ...a, nullable }
  }
  if ((a.kind === 'integer' && b.kind === 'number') || (a.kind === 'number' && b.kind === 'integer')) return { kind: 'number', nullable }
  return { kind: 'any', nullable }
}

function pascal(name) {
  const words = splitWords(name)
  const out = words.map(cap).join('')
  return /^[A-Za-z_]/.test(out) ? out : `T${out}`
}

function singular(name) {
  if (/ies$/i.test(name)) return name.replace(/ies$/i, 'y')
  if (/(ss|us)$/i.test(name)) return name
  return name.replace(/s$/i, '')
}

/** Walks the tree, naming every object type, and hands each to `emit` once, children first. */
function collectStructs(root, rootName) {
  const structs = []
  const used = new Set()
  const visit = (type, name) => {
    if (type.kind === 'array') return visit(type.item, singular(name) === name ? `${name}Item` : singular(name))
    if (type.kind !== 'object') return
    let unique = pascal(name) || 'Item'
    for (let n = 2; used.has(unique); n++) unique = `${pascal(name)}${n}`
    used.add(unique)
    type.name = unique
    for (const [field, info] of type.fields) visit(info.type, field)
    structs.push(type)
  }
  visit(root, rootName)
  return structs
}

const TYPE_TARGETS = {
  typescript: {
    label: 'TypeScript',
    render(root, rootName) {
      const ref = (t) => {
        const base = t.kind === 'object' ? t.name : t.kind === 'array' ? `${wrap(ref(t.item))}[]` : { string: 'string', integer: 'number', number: 'number', boolean: 'boolean', null: 'unknown', any: 'unknown' }[t.kind]
        return t.nullable && base !== 'unknown' ? `${base} | null` : base
      }
      const wrap = (s) => (s.includes('|') ? `(${s})` : s)
      const key = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k))
      const structs = collectStructs(root, rootName)
      const blocks = structs.map((s) => `export interface ${s.name} {\n${[...s.fields].map(([k, f]) => `  ${key(k)}${f.optional ? '?' : ''}: ${ref(f.type)}`).join('\n')}\n}`)
      if (root.kind !== 'object') blocks.push(`export type ${pascal(rootName)} = ${ref(root)}`)
      return blocks.join('\n\n')
    },
  },
  go: {
    label: 'Go struct',
    render(root, rootName) {
      const ref = (t, optional) => {
        let base = t.kind === 'object' ? t.name : t.kind === 'array' ? `[]${ref(t.item, false)}` : { string: 'string', integer: 'int64', number: 'float64', boolean: 'bool', null: 'interface{}', any: 'interface{}' }[t.kind]
        if ((t.nullable || optional) && t.kind !== 'array' && !base.startsWith('interface')) base = `*${base}`
        return base
      }
      const structs = collectStructs(root, rootName)
      const blocks = structs.map((s) => {
        const rows = [...s.fields].map(([k, f]) => [pascal(k).replace(/Id$/, 'ID').replace(/Url$/, 'URL'), ref(f.type, f.optional), `\`json:"${k}${f.optional ? ',omitempty' : ''}"\``])
        const w0 = Math.max(0, ...rows.map((r) => r[0].length))
        const w1 = Math.max(0, ...rows.map((r) => r[1].length))
        return `type ${s.name} struct {\n${rows.map((r) => `\t${r[0].padEnd(w0)} ${r[1].padEnd(w1)} ${r[2]}`).join('\n')}\n}`
      })
      if (root.kind !== 'object') blocks.push(`type ${pascal(rootName)} ${ref(root, false)}`)
      return blocks.join('\n\n')
    },
  },
  rust: {
    label: 'Rust（serde）',
    render(root, rootName) {
      const ref = (t) => {
        const base = t.kind === 'object' ? t.name : t.kind === 'array' ? `Vec<${ref(t.item)}>` : { string: 'String', integer: 'i64', number: 'f64', boolean: 'bool', null: 'serde_json::Value', any: 'serde_json::Value' }[t.kind]
        return t.nullable || t.kind === 'null' ? `Option<${base}>` : base
      }
      const snake = (k) => {
        const s = splitWords(k).map((w) => w.toLowerCase()).join('_') || 'field'
        return ['type', 'match', 'ref', 'fn', 'mod', 'use', 'impl', 'self', 'struct', 'enum', 'loop', 'move', 'box'].includes(s) ? `r#${s}` : /^\d/.test(s) ? `_${s}` : s
      }
      const structs = collectStructs(root, rootName)
      return structs.map((s) => `#[derive(Debug, Clone, Serialize, Deserialize)]\npub struct ${s.name} {\n${[...s.fields].map(([k, f]) => {
        const name = snake(k)
        const attrs = []
        if (name.replace(/^r#/, '') !== k) attrs.push(`rename = "${k}"`)
        let type = ref(f.type)
        if (f.optional) {
          if (!type.startsWith('Option<')) type = `Option<${type}>`
          attrs.push('default', 'skip_serializing_if = "Option::is_none"')
        }
        return `${attrs.length ? `    #[serde(${attrs.join(', ')})]\n` : ''}    pub ${name}: ${type},`
      }).join('\n')}\n}`).join('\n\n') + (structs.length ? '' : `pub type ${pascal(rootName)} = ${ref(root)};`)
    },
  },
  python: {
    label: 'Python（dataclass）',
    render(root, rootName) {
      const ref = (t) => {
        const base = t.kind === 'object' ? t.name : t.kind === 'array' ? `list[${ref(t.item)}]` : { string: 'str', integer: 'int', number: 'float', boolean: 'bool', null: 'Any', any: 'Any' }[t.kind]
        return t.nullable || t.kind === 'null' ? `Optional[${base}]` : base
      }
      const ident = (k) => {
        const s = splitWords(k).map((w) => w.toLowerCase()).join('_') || 'field'
        return /^\d/.test(s) || ['class', 'def', 'from', 'import', 'global', 'lambda', 'pass', 'return', 'yield', 'in', 'is', 'not', 'or', 'and', 'if', 'else', 'for', 'while', 'with', 'try', 'except', 'raise', 'None', 'True', 'False'].includes(s) ? `${s}_` : s
      }
      const structs = collectStructs(root, rootName)
      const classes = structs.map((s) => {
        const fields = [...s.fields].sort((a, b) => Number(a[1].optional) - Number(b[1].optional))
        return `@dataclass\nclass ${s.name}:\n${fields.map(([k, f]) => {
          const type = f.optional && !ref(f.type).startsWith('Optional[') ? `Optional[${ref(f.type)}]` : ref(f.type)
          return `    ${ident(k)}: ${type}${f.optional ? ' = None' : ''}${ident(k) !== k ? `  # JSON: ${JSON.stringify(k)}` : ''}`
        }).join('\n') || '    pass'}`
      })
      return `from __future__ import annotations\n\nfrom dataclasses import dataclass\nfrom typing import Any, Optional\n\n\n${classes.join('\n\n\n')}${root.kind !== 'object' ? `\n\n${pascal(rootName)} = ${ref(root)}` : ''}`
    },
  },
  schema: {
    label: 'JSON Schema',
    render(root, rootName) {
      const node = (t) => {
        let out
        if (t.kind === 'object') {
          const required = [...t.fields].filter(([, f]) => !f.optional).map(([k]) => k)
          out = { type: 'object', properties: Object.fromEntries([...t.fields].map(([k, f]) => [k, node(f.type)])), ...(required.length ? { required } : {}), additionalProperties: false }
        } else if (t.kind === 'array') out = { type: 'array', items: node(t.item) }
        else if (t.kind === 'any' || t.kind === 'null') out = {}
        else out = { type: t.kind }
        if (t.nullable && out.type) out.type = [out.type, 'null']
        return out
      }
      return JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', title: pascal(rootName), ...node(root) }, null, 2)
    },
  },
}

function jsonToTypes(text, target, rootName) {
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new Error(`不是有效的 JSON：${error.message}`)
  }
  return (TYPE_TARGETS[target] || TYPE_TARGETS.typescript).render(inferType(data), rootName || 'Root')
}

const TYPES_SAMPLE = JSON.stringify({ id: 42, userName: 'ada', email: 'ada@example.com', score: 9.5, active: true, tags: ['admin', 'dev'], address: { city: 'Shanghai', zipCode: null }, orders: [{ id: 1, total: 99.9, note: 'gift' }, { id: 2, total: 12 }] }, null, 2)

TOOLS.push({
  id: 'json-types',
  name: 'JSON 转类型定义',
  category: 'dev',
  icon: 'file-json',
  description: '由示例 JSON 推断结构，生成 TypeScript 接口、Go 结构体、Rust serde 结构体、Python dataclass 或 JSON Schema；合并数组元素，识别可选与可空字段。',
  accept: ['.json', 'application/json'],
  multiple: false,
  minFiles: 0,
  keywords: ['json to typescript', 'json to go', 'json to rust', 'quicktype', 'json schema', 'interface', 'struct', 'dataclass', '类型定义', 'json 转结构体', '接口生成'],
  setup(ui) {
    livePanel(ui, { json: TYPES_SAMPLE, target: 'typescript', root: 'Root' }, (s) => {
      let output = ''
      let error = ''
      try {
        output = jsonToTypes(s.json, s.target, s.root)
      } catch (e) {
        error = e.message
      }
      return {
        nodes: [
          ...(ui.inputs.length ? [{ type: 'alert', tone: 'info', text: `点「导出为文件」将转换 ${ui.inputs[0].name}；下方可粘贴 JSON 试看效果。` }] : []),
          { type: 'row', gap: 3, wrap: true, children: [
            { type: 'select', bind: 'target', label: '生成', options: Object.entries(TYPE_TARGETS).map(([value, t]) => ({ value, label: t.label })) },
            { type: 'input', bind: 'root', label: '根类型名', placeholder: 'Root' },
          ] },
          { type: 'row', gap: 3, wrap: true, align: 'start', children: [
            { type: 'textarea', bind: 'json', label: 'JSON', rows: 22, mono: true },
            error ? { type: 'alert', tone: 'destructive', text: error } : { type: 'code', label: TYPE_TARGETS[s.target]?.label ?? '结果', text: output, height: 30 },
          ] },
        ],
      }
    })
  },
  async run(ctx) {
    const p = ctx.params
    const text = ctx.inputs.length ? await host.fs.readText(ctx.inputs[0].id) : String(p.json ?? '')
    const root = String(p.root || (ctx.inputs.length ? pascal(ctx.inputs[0].name.replace(/\.[^.]+$/, '')) : 'Root'))
    const output = jsonToTypes(text, String(p.target || 'typescript'), root)
    const ext = { typescript: 'ts', go: 'go', rust: 'rs', python: 'py', schema: 'schema.json' }[p.target] || 'ts'
    return { outputs: [await writeText(`${root}.${ext}`, output)], summary: `已生成 ${(TYPE_TARGETS[p.target] || TYPE_TARGETS.typescript).label}` }
  },
})

/* ========================================================================== */
/* Unix permissions                                                           */
/* ========================================================================== */

const PERMISSION_BITS = [
  ['ur', 0o400], ['uw', 0o200], ['ux', 0o100], ['gr', 0o040], ['gw', 0o020], ['gx', 0o010], ['or', 0o004], ['ow', 0o002], ['ox', 0o001],
  ['setuid', 0o4000], ['setgid', 0o2000], ['sticky', 0o1000],
]

function modeFromSwitches(s) {
  return PERMISSION_BITS.reduce((mode, [key, bit]) => (s[key] ? mode | bit : mode), 0)
}

function switchesFromMode(mode) {
  return Object.fromEntries(PERMISSION_BITS.map(([key, bit]) => [key, (mode & bit) !== 0]))
}

/** Octal (`755`, `0644`, `4755`) or symbolic (`rwxr-xr-x`, `-rw-r--r--`) to a mode number. */
function parseMode(text) {
  const value = String(text).trim()
  if (/^0?[0-7]{3,4}$/.test(value)) return parseInt(value, 8)
  const symbolic = value.replace(/^[-dlbcps]/, (c) => (value.length === 10 ? '' : c))
  if (/^[r-][w-][xsS-][r-][w-][xsS-][r-][w-][xtT-]$/.test(symbolic)) {
    let mode = 0
    const chars = [...symbolic]
    ;[0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001].forEach((bit, i) => {
      if (chars[i] !== '-' && chars[i] !== 'S' && chars[i] !== 'T') mode |= bit
    })
    if (/[sS]/.test(chars[2])) mode |= 0o4000
    if (/[sS]/.test(chars[5])) mode |= 0o2000
    if (/[tT]/.test(chars[8])) mode |= 0o1000
    return mode
  }
  throw new Error('请输入八进制（如 755、0644）或符号形式（如 rwxr-xr-x）')
}

function describeMode(mode) {
  const triad = (shift, special, specialChar) => {
    const r = mode & (0o4 << shift) ? 'r' : '-'
    const w = mode & (0o2 << shift) ? 'w' : '-'
    const x = mode & (0o1 << shift)
    const s = mode & special
    return r + w + (s ? (x ? specialChar : specialChar.toUpperCase()) : x ? 'x' : '-')
  }
  const symbolic = triad(6, 0o4000, 's') + triad(3, 0o2000, 's') + triad(0, 0o1000, 't')
  const words = (shift) => ['读', '写', '执行'].filter((_, i) => mode & ((0o4 >> i) << shift)).join('、') || '无权限'
  const octal = (mode & 0o7000 ? mode.toString(8).padStart(4, '0') : mode.toString(8).padStart(3, '0'))
  const who = (shift, letter) => {
    const bits = ['r', 'w', 'x'].filter((_, i) => mode & ((0o4 >> i) << shift)).join('')
    return `${letter}=${bits}`
  }
  return {
    octal,
    symbolic,
    rows: [
      { label: '八进制', value: octal },
      { label: '符号表示', value: `-${symbolic}` },
      { label: '所有者', value: words(6) },
      { label: '所属组', value: words(3) },
      { label: '其他人', value: words(0) },
      ...(mode & 0o7000 ? [{ label: '特殊位', value: [mode & 0o4000 && 'setuid', mode & 0o2000 && 'setgid', mode & 0o1000 && 'sticky'].filter(Boolean).join('、') }] : []),
    ],
    commands: [`chmod ${octal} 文件名`, `chmod ${who(6, 'u')},${who(3, 'g')},${who(0, 'o')} 文件名`],
  }
}

TOOLS.push({
  id: 'chmod',
  name: 'Unix 权限计算',
  category: 'dev',
  icon: 'shield',
  description: '勾选读 / 写 / 执行即可得到 chmod 八进制与符号表示，也能反向解析 755、rwxr-xr-x；支持 setuid、setgid 与粘滞位。',
  input: 'none',
  keywords: ['chmod', 'permission', 'unix', 'linux', 'octal', 'rwx', 'umask', '权限', '文件权限', '755', '644'],
  setup(ui) {
    const initial = { mode: typeof ui.state.mode === 'string' ? ui.state.mode : '755' }
    let state
    try {
      state = { ...initial, ...switchesFromMode(parseMode(initial.mode)) }
    } catch (error) {
      state = { mode: '755', ...switchesFromMode(0o755) }
    }
    const triadRow = (title, prefix) => ({ type: 'row', gap: 4, wrap: true, children: [
      { type: 'text', variant: 'body', text: title },
      { type: 'switch', bind: `${prefix}r`, label: '读' },
      { type: 'switch', bind: `${prefix}w`, label: '写' },
      { type: 'switch', bind: `${prefix}x`, label: '执行' },
    ] })
    const draw = (s, withState) => {
      let info = null
      let error = ''
      try {
        info = describeMode(parseMode(s.mode))
      } catch (e) {
        error = e.message
      }
      ui.render({
        runLabel: '导出为文件',
        ...(withState ? { state: s } : {}),
        nodes: [
          { type: 'input', bind: 'mode', label: '权限', placeholder: '755、0644、rwxr-xr-x' },
          triadRow('所有者', 'u'),
          triadRow('所属组', 'g'),
          triadRow('其他人', 'o'),
          { type: 'row', gap: 4, wrap: true, children: [
            { type: 'switch', bind: 'setuid', label: 'setuid' },
            { type: 'switch', bind: 'setgid', label: 'setgid' },
            { type: 'switch', bind: 'sticky', label: '粘滞位' },
          ] },
          error ? { type: 'alert', tone: 'destructive', text: error } : { type: 'facts', rows: info.rows },
          ...(info ? [{ type: 'code', label: '命令', text: info.commands.join('\n'), height: 6 }] : []),
        ],
      })
    }
    draw(state, true)
    ui.on('change', (key, _value, current) => {
      let patch = {}
      if (key === 'mode') {
        try {
          patch = switchesFromMode(parseMode(current.mode))
        } catch (error) {
          patch = {}
        }
      } else {
        const mode = modeFromSwitches(current)
        patch = { mode: mode & 0o7000 ? mode.toString(8).padStart(4, '0') : mode.toString(8).padStart(3, '0') }
      }
      ui.setState(patch)
      draw({ ...current, ...patch }, false)
    })
  },
  async run(ctx) {
    const info = describeMode(parseMode(String(ctx.params.mode ?? '')))
    return { outputs: [await writeText('chmod.txt', `${info.rows.map((r) => `${r.label}: ${r.value}`).join('\n')}\n\n${info.commands.join('\n')}`)], summary: `${info.octal} · -${info.symbolic}` }
  },
})

/* ========================================================================== */
/* Colours                                                                    */
/* ========================================================================== */

const NAMED_COLORS = { black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', lime: '00ff00', blue: '0000ff', yellow: 'ffff00', cyan: '00ffff', aqua: '00ffff', magenta: 'ff00ff', fuchsia: 'ff00ff', gray: '808080', grey: '808080', silver: 'c0c0c0', maroon: '800000', olive: '808000', purple: '800080', teal: '008080', navy: '000080', orange: 'ffa500', pink: 'ffc0cb', brown: 'a52a2a', gold: 'ffd700', indigo: '4b0082', violet: 'ee82ee', coral: 'ff7f50', salmon: 'fa8072', tomato: 'ff6347', crimson: 'dc143c', skyblue: '87ceeb', transparent: '00000000' }

/** Any common CSS colour syntax → `{ r, g, b, a }` with channels 0-255 and alpha 0-1. */
function parseColor(input) {
  const text = String(input).trim().toLowerCase()
  const hex = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(NAMED_COLORS[text] ? NAMED_COLORS[text] : text)
  if (hex) {
    let h = hex[1]
    if (h.length <= 4) h = [...h].map((c) => c + c).join('')
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 }
  }
  const fn = /^(rgba?|hsla?|hsv|oklch)\(\s*([^)]*)\)$/.exec(text)
  if (!fn) throw new Error('无法识别的颜色：支持 #RGB / #RRGGBB / #RRGGBBAA、rgb()、hsl()、hsv()、oklch() 与常见颜色名')
  const parts = fn[2].replace(/\//g, ' ').split(/[\s,]+/).filter(Boolean)
  const num = (value, scale = 1) => (value.endsWith('%') ? (parseFloat(value) / 100) * scale : parseFloat(value))
  const alpha = parts[3] === undefined ? 1 : num(parts[3], 1)
  if (fn[1].startsWith('rgb')) return { r: clamp255(num(parts[0], 255)), g: clamp255(num(parts[1], 255)), b: clamp255(num(parts[2], 255)), a: alpha }
  if (fn[1] === 'oklch') {
    const [r, g, b] = oklchToRgb(num(parts[0], 1), num(parts[1], 0.4), parseFloat(parts[2]))
    return { r, g, b, a: alpha }
  }
  const h = parseFloat(parts[0])
  const s = num(parts[1], 1) > 1 ? num(parts[1], 1) / 100 : num(parts[1], 1)
  const l = num(parts[2], 1) > 1 ? num(parts[2], 1) / 100 : num(parts[2], 1)
  const [r, g, b] = fn[1] === 'hsv' ? hsvToRgb(h, s, l) : hslToRgb(h, s, l)
  return { r, g, b, a: alpha }
}

function clamp255(v) {
  return Math.max(0, Math.min(255, Math.round(v)))
}

function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return [f(0), f(8), f(4)].map((v) => clamp255(v * 255))
}

function hsvToRgb(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
  }
  return [f(5), f(3), f(1)].map((x) => clamp255(x * 255))
}

function rgbToHsl({ r, g, b }) {
  const [R, G, B] = [r, g, b].map((v) => v / 255)
  const max = Math.max(R, G, B)
  const min = Math.min(R, G, B)
  const l = (max + min) / 2
  const d = max - min
  let h = 0
  if (d) h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0
  return { h: (h * 60 + 360) % 360, s, l, v: max, sv: max ? d / max : 0 }
}

const toLinear = (c) => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
const fromLinear = (v) => clamp255(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055))

/** sRGB → OKLCH via OKLab (Björn Ottosson's matrices). */
function rgbToOklch({ r, g, b }) {
  const [R, G, B] = [r, g, b].map(toLinear)
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return { l: L, c: Math.hypot(A, Bb), h: (Math.atan2(Bb, A) * 180 / Math.PI + 360) % 360 }
}

function oklchToRgb(L, C, H) {
  const a = C * Math.cos((H * Math.PI) / 180)
  const b = C * Math.sin((H * Math.PI) / 180)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]
}

function contrastRatio(a, b) {
  const lum = ({ r, g, b: bl }) => 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(bl)
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

function describeColor(input) {
  const c = parseColor(input)
  const hex = `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
  const hsl = rgbToHsl(c)
  const ok = rgbToOklch(c)
  const k = 1 - Math.max(c.r, c.g, c.b) / 255
  const cmyk = k === 1 ? [0, 0, 0, 100] : [c.r, c.g, c.b].map((v) => Math.round(((1 - v / 255 - k) / (1 - k)) * 100)).concat(Math.round(k * 100))
  const alpha = c.a < 1 ? ` / ${Number(c.a.toFixed(3))}` : ''
  const grade = (ratio) => `${ratio.toFixed(2)} : 1（${ratio >= 7 ? 'AAA' : ratio >= 4.5 ? 'AA' : ratio >= 3 ? '仅大字号 AA' : '不达标'}）`
  const rows = [
    { label: 'HEX', value: c.a < 1 ? `${hex}${Math.round(c.a * 255).toString(16).padStart(2, '0')}` : hex },
    { label: 'RGB', value: `rgb(${c.r} ${c.g} ${c.b}${alpha})` },
    { label: 'HSL', value: `hsl(${Math.round(hsl.h)} ${Math.round(hsl.s * 100)}% ${Math.round(hsl.l * 100)}%${alpha})` },
    { label: 'HSV', value: `hsv(${Math.round(hsl.h)} ${Math.round(hsl.sv * 100)}% ${Math.round(hsl.v * 100)}%)` },
    { label: 'OKLCH', value: `oklch(${(ok.l * 100).toFixed(1)}% ${ok.c.toFixed(3)} ${ok.c < 0.0005 ? 0 : ok.h.toFixed(1)}${alpha})` },
    { label: 'CMYK', value: `${cmyk.map((v) => `${v}%`).join(' ')}` },
    { label: '与白色对比度', value: grade(contrastRatio(c, { r: 255, g: 255, b: 255 })) },
    { label: '与黑色对比度', value: grade(contrastRatio(c, { r: 0, g: 0, b: 0 })) },
  ]
  return { hex, rows }
}

TOOLS.push({
  id: 'color',
  name: '颜色格式转换',
  category: 'dev',
  icon: 'palette',
  description: '在 HEX、RGB、HSL、HSV、OKLCH、CMYK 之间转换颜色，并给出与黑白背景的 WCAG 对比度等级。',
  input: 'none',
  keywords: ['color', 'colour', 'hex', 'rgb', 'hsl', 'oklch', 'cmyk', 'contrast', 'wcag', '颜色', '色值', '颜色转换', '对比度'],
  setup(ui) {
    const initialValue = typeof ui.state.value === 'string' ? ui.state.value : '#16a34a'
    const draw = (s, withState) => {
      let info = null
      let error = ''
      try {
        info = describeColor(s.value)
      } catch (e) {
        error = e.message
      }
      ui.render({
        runLabel: '导出为文件',
        ...(withState ? { state: s } : {}),
        nodes: [
          { type: 'row', gap: 3, children: [
            { type: 'input', bind: 'value', label: '颜色', placeholder: '#16a34a、rgb(22 163 74)、hsl(142 76% 36%)、oklch(62% 0.18 145)、tomato' },
            { type: 'color', bind: 'picker', label: '取色' },
          ] },
          error ? { type: 'alert', tone: 'destructive', text: error } : { type: 'facts', rows: info.rows },
          ...(info ? [{ type: 'code', label: 'CSS', text: info.rows.slice(0, 5).map((r) => r.value).join('\n'), height: 8 }] : []),
        ],
      })
    }
    let initialPicker = '#16a34a'
    try {
      initialPicker = describeColor(initialValue).hex
    } catch (error) {
      /* keep the default swatch */
    }
    draw({ value: initialValue, picker: initialPicker }, true)
    ui.on('change', (key, value, current) => {
      let patch = {}
      if (key === 'picker') patch = { value: String(value) }
      else {
        try {
          patch = { picker: describeColor(current.value).hex }
        } catch (error) {
          patch = {}
        }
      }
      ui.setState(patch)
      draw({ ...current, ...patch }, false)
    })
  },
  async run(ctx) {
    const info = describeColor(String(ctx.params.value ?? ''))
    return { outputs: [await writeText('color.txt', info.rows.map((r) => `${r.label}: ${r.value}`).join('\n'))], summary: info.rows.slice(0, 3).map((r) => r.value).join(' · ') }
  },
})

/* ========================================================================== */

definePlugin({
  id: 'omnitool.dev',
  name: '开发者工具箱',
  version: '1.0.0',
  author: 'OmniTool',
  description: '时间戳、进制、Base64、JWT、哈希、URL、UUID、正则、文本对比、Cron、十六进制、命名风格、转义、JSON 转类型、chmod 与颜色——全部离线计算。',
  icon: 'terminal',
  capabilities: ['fs', 'ui'],
  tools: TOOLS,
})
