/* eslint-disable */
/**
 * Built-in plugin: archives.
 *
 * ZIP, TAR, TAR.GZ and GZ, created and extracted inside the sandbox with fflate
 * (deflate/inflate) and a small TAR reader/writer here. 7z, RAR and
 * password-protected ZIPs are read with libarchive (wasm), loaded only when one
 * of those turns up. Nothing leaves the machine, which matters most for exactly
 * the files people zip up.
 *
 * Extraction treats every archive as hostile:
 *   - entry names are normalised (no absolute paths, no `..`), and the host
 *     normalises them again;
 *   - the declared uncompressed size is checked *before* inflating, so a zip
 *     bomb fails fast instead of exhausting memory;
 *   - names without the ZIP UTF-8 flag are decoded as UTF-8 when valid, else as
 *     GBK - the encoding Chinese Windows uses when it zips files.
 */
definePlugin({
  id: 'omnitool.archive',
  name: '压缩与归档',
  version: '1.0.0',
  author: 'OmniTool',
  description: '创建 ZIP / TAR / TAR.GZ / GZ，解压以上格式以及 7z、RAR 和带密码的 ZIP，保留目录结构，本地完成。',
  icon: 'file-archive',
  capabilities: ['fs', 'ui'],
  deps: [
    { id: 'fflate', url: '/vendor/fflate.js', global: 'fflate' },
    { id: 'libarchive', url: '/vendor/libarchive/libarchive.js', global: 'LibarchiveWasm', lazy: true, assets: { 'libarchive.wasm': { url: '/vendor/libarchive/libarchive.wasm' } } },
  ],

  tools: [
    /* ------------------------------------------------------------------ */
    {
      id: 'create',
      name: '创建压缩包',
      category: 'archive',
      icon: 'archive',
      description: '把多个文件打包成 ZIP、TAR 或 TAR.GZ；单个文件也可以直接 GZ 压缩。',
      accept: [],
      multiple: true,
      keywords: ['zip', 'tar', 'gz', 'gzip', 'tgz', 'compress', 'archive', '打包', '压缩包', '压缩'],
      params: [
        {
          key: 'format', type: 'select', label: '格式', default: 'zip',
          options: [
            { value: 'zip', label: 'ZIP（通用）' },
            { value: 'tar.gz', label: 'TAR.GZ（Linux / macOS 常用）' },
            { value: 'tar', label: 'TAR（不压缩）' },
            { value: 'gz', label: 'GZ（每个文件单独压缩）' },
          ],
        },
        { key: 'name', type: 'text', label: '压缩包名称', default: 'archive', when: { key: 'format', equals: ['zip', 'tar.gz', 'tar'] } },
        {
          key: 'level', type: 'slider', label: '压缩级别', min: 0, max: 9, default: 6,
          hint: '0 只打包不压缩（最快），9 体积最小。已压缩的图片、视频基本压不动。',
          when: { key: 'format', equals: ['zip', 'tar.gz', 'gz'] },
        },
      ],

      async run(ctx) {
        const { zipSync, gzipSync } = lib()
        const p = ctx.params
        const format = String(p.format)
        const level = clampLevel(p.level)
        if (ctx.inputs.length === 0) throw new Error('请先拖入要打包的文件')

        if (format === 'gz') {
          const outputs = []
          await eachInput(ctx, async (input, bytes) => {
            const packed = gzipSync(bytes, { level, filename: basename(input.name), mtime: Date.now() })
            outputs.push((await host.fs.writeAll(`${basename(input.name)}.gz`, packed, 'application/gzip')).id)
          })
          return { outputs, summary: `已压缩 ${outputs.length} 个文件为 GZ` }
        }

        const entries = []
        let total = 0
        await eachInput(ctx, async (input, bytes) => {
          entries.push({ name: input.name, bytes })
          total += bytes.length
        })
        const names = uniqueNames(entries.map((e) => safePath(e.name)))
        const base = String(p.name || 'archive').trim().replace(/\.(zip|tar|tgz|tar\.gz)$/i, '') || 'archive'

        ctx.progress(0.9, '正在写出压缩包')
        let packed
        let fileName
        let type
        if (format === 'zip') {
          const files = {}
          const now = new Date()
          entries.forEach((entry, i) => {
            // Already-compressed media gains nothing from deflate but costs time.
            files[names[i]] = [entry.bytes, { level: STORED.test(names[i]) ? 0 : level, mtime: now }]
          })
          packed = zipSync(files)
          fileName = `${base}.zip`
          type = 'application/zip'
        } else {
          const tar = writeTar(entries.map((entry, i) => ({ name: names[i], bytes: entry.bytes })))
          packed = format === 'tar.gz' ? gzipSync(tar, { level, filename: `${base}.tar` }) : tar
          fileName = format === 'tar.gz' ? `${base}.tar.gz` : `${base}.tar`
          type = format === 'tar.gz' ? 'application/gzip' : 'application/x-tar'
        }

        const out = await host.fs.writeAll(fileName, packed, type)
        ctx.progress(1)
        return { outputs: [out.id], summary: `已打包 ${entries.length} 个文件：${bytesLabel(total)} → ${bytesLabel(packed.length)}` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'extract',
      name: '解压缩',
      category: 'archive',
      icon: 'file-archive',
      description: '解压 ZIP / 7z / RAR / TAR / TAR.GZ / TGZ / GZ，自动识别格式，支持带密码的 ZIP 与 RAR，保留目录结构；也可以只查看文件列表。',
      accept: ['.zip', '.7z', '.rar', '.tar', '.gz', '.tgz', '.tar.gz', 'application/zip', 'application/gzip', 'application/x-tar', 'application/x-7z-compressed', 'application/vnd.rar', 'application/x-rar-compressed'],
      multiple: true,
      keywords: ['unzip', 'extract', 'untar', 'gunzip', 'tgz', '7z', '7zip', 'rar', 'unrar', '解压', '解压缩', '打开压缩包', '压缩包密码'],
      params: [
        { key: 'mode', type: 'select', label: '操作', default: 'extract', options: [{ value: 'extract', label: '解压全部文件' }, { value: 'list', label: '只列出文件清单' }] },
        { key: 'filter', type: 'text', label: '只解压匹配的文件', default: '', placeholder: '如 *.pdf 或 docs/*', hint: '留空解压全部；支持 * 和 ? 通配符，按完整路径匹配。', when: { key: 'mode', equals: 'extract' } },
        { key: 'prefix', type: 'switch', label: '放进以压缩包命名的文件夹', default: true, hint: '一次解压多个压缩包时避免同名文件互相覆盖。', when: { key: 'mode', equals: 'extract' } },
        { key: 'password', type: 'text', label: '解压密码', default: '', placeholder: '压缩包没有密码就留空', hint: '只在本机使用，不会保存。', when: { key: 'mode', equals: 'extract' } },
      ],

      async run(ctx) {
        const p = ctx.params
        const matcher = globMatcher(String(p.filter || ''))
        const outputs = []
        const listing = []
        let extracted = 0

        await eachInput(ctx, async (input, bytes) => {
          const archive = await openArchive(input.name, bytes, String(p.password || ''))
          const folder = archiveBaseName(input.name)

          if (p.mode === 'list') {
            listing.push({
              archive: input.name,
              format: archive.format,
              files: archive.entries.filter((e) => !e.directory).length,
              uncompressedBytes: archive.entries.reduce((sum, e) => sum + (e.size || 0), 0),
              entries: archive.entries.map((e) => ({ path: e.name, bytes: e.size, directory: e.directory || undefined, encrypted: e.encrypted || undefined })),
            })
            return
          }

          const wanted = archive.entries.filter((e) => !e.directory && matcher(e.name))
          const encrypted = wanted.filter((e) => e.encrypted)
          if (encrypted.length && !archive.decrypts) throw new Error(`${input.name} 中有 ${encrypted.length} 个加密文件，请填写解压密码`)

          const declared = wanted.reduce((sum, e) => sum + (e.size || 0), 0)
          if (declared > MAX_EXTRACT_BYTES) {
            throw new Error(`${input.name} 解压后约 ${bytesLabel(declared)}，超过单次 ${bytesLabel(MAX_EXTRACT_BYTES)} 的上限（可能是压缩炸弹），请用通配符只解压需要的文件`)
          }

          const files = await archive.read(wanted)
          for (const [index, entry] of wanted.entries()) {
            ctx.throwIfAborted()
            ctx.progress(index / wanted.length, entry.name)
            const data = files[index]
            const name = p.prefix ? `${folder}/${entry.name}` : entry.name
            outputs.push((await host.fs.writeAll(name, data, guessType(entry.name))).id)
            extracted++
          }
        })

        if (p.mode === 'list') {
          const out = await host.fs.writeAll('archive-listing.json', JSON.stringify(listing, null, 2), 'application/json')
          const count = listing.reduce((sum, a) => sum + a.files, 0)
          return { outputs: [out.id], summary: `${listing.length} 个压缩包，共 ${count} 个文件` }
        }
        if (extracted === 0) throw new Error(p.filter ? `没有与「${p.filter}」匹配的文件` : '压缩包里没有文件')
        return { outputs, summary: `已解压 ${extracted} 个文件` }
      },
    },
  ],
})

/* ========================================================================== */
/* Shared                                                                     */
/* ========================================================================== */

/** Ceiling on what one run may inflate. The workspace lives in the browser. */
const MAX_EXTRACT_BYTES = 2 * 1024 * 1024 * 1024

/** Extensions stored without deflate in ZIPs: they are compressed already. */
const STORED = /\.(jpe?g|png|gif|webp|avif|heic|mp4|mov|mkv|webm|mp3|m4a|aac|ogg|opus|flac|zip|gz|7z|rar|xz|bz2|zst|woff2?)$/i

function lib() {
  if (typeof fflate === 'undefined') throw new Error('依赖 fflate 未能注入沙盒，请在插件面板中重载该插件')
  return fflate
}

async function eachInput(ctx, fn) {
  for (let i = 0; i < ctx.inputs.length; i++) {
    ctx.throwIfAborted()
    ctx.progress(i / ctx.inputs.length, `正在读取 ${ctx.inputs[i].name}`)
    await fn(ctx.inputs[i], await host.fs.readAll(ctx.inputs[i].id))
  }
  ctx.progress(1)
}

function clampLevel(value) {
  const n = Math.round(Number(value))
  return Number.isFinite(n) ? Math.min(9, Math.max(0, n)) : 6
}

function basename(path) {
  return String(path).split('/').pop()
}

function archiveBaseName(name) {
  return basename(name).replace(/\.(tar\.gz|tgz|zip|7z|rar|tar|gz)$/i, '') || 'archive'
}

/** Relative, forward-slashed, no `.`/`..` segments. */
function safePath(name) {
  return String(name)
    .split(/[\\/]+/)
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/') || 'file'
}

/** `a.txt`, `a (2).txt`, … so two inputs with one name do not overwrite each other. */
function uniqueNames(names) {
  const seen = new Map()
  return names.map((name) => {
    const count = seen.get(name.toLowerCase()) ?? 0
    seen.set(name.toLowerCase(), count + 1)
    if (count === 0) return name
    const dot = name.lastIndexOf('.')
    // `.env`-style names have no extension to keep.
    return dot > name.lastIndexOf('/') + 1 ? `${name.slice(0, dot)} (${count + 1})${name.slice(dot)}` : `${name} (${count + 1})`
  })
}

function globMatcher(pattern) {
  const trimmed = pattern.trim()
  if (!trimmed) return () => true
  const source = trimmed
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((glob) => glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.'))
    .join('|')
  // A pattern without a slash matches the file name anywhere in the tree.
  const re = new RegExp(`^(?:${source})$`, 'i')
  return (path) => re.test(path) || (!trimmed.includes('/') && re.test(basename(path)))
}

const TYPES = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', xml: 'application/xml', html: 'text/html',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', zip: 'application/zip', gz: 'application/gzip',
}

function guessType(name) {
  return TYPES[basename(name).split('.').pop().toLowerCase()] || ''
}

function bytesLabel(value) {
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB']
  let n = value / 1024
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(1)} ${units[i]}`
}

/* ------------------------------ detection -------------------------------- */

/**
 * Opens an archive by content, not extension: `{ format, entries, read(list) }`.
 * Each entry: `{ name, size, directory, encrypted }`. `read` returns the data of
 * the given entries, in order.
 */
async function openArchive(fileName, bytes, password = '') {
  if (startsWith(bytes, SEVEN_ZIP_MAGIC)) return openWithLibarchive(fileName, bytes, '7z', password)
  if (startsWith(bytes, RAR_MAGIC)) return openWithLibarchive(fileName, bytes, 'rar', password)
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const zip = openZip(bytes)
    // fflate cannot decrypt; libarchive handles ZipCrypto and AES entries.
    if (password && zip.entries.some((e) => e.encrypted)) return openWithLibarchive(fileName, bytes, 'zip', password)
    return zip
  }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const inflated = lib().gunzipSync(bytes)
    if (isTar(inflated)) return openTar(inflated, 'tar.gz')
    // A plain .gz holds one file; its name is the archive name minus `.gz`.
    const inner = basename(fileName).replace(/\.gz$/i, '') || 'file'
    return {
      format: 'gz',
      entries: [{ name: inner, size: inflated.length }],
      read: () => [inflated],
    }
  }
  if (isTar(bytes)) return openTar(bytes, 'tar')
  throw new Error(`${fileName} 不是可识别的压缩包（支持 ZIP、7z、RAR、TAR、TAR.GZ、GZ）`)
}

/* ------------------------------ libarchive ------------------------------- */

const SEVEN_ZIP_MAGIC = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]
const RAR_MAGIC = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]

function startsWith(bytes, magic) {
  return magic.every((b, i) => bytes[i] === b)
}

let libarchiveModule = null

async function libarchiveLib() {
  if (!libarchiveModule) {
    libarchiveModule = loadDependency('libarchive').then(({ exports, assets }) => {
      const wasm = assets['libarchive.wasm']
      if (!wasm) throw new Error('libarchive.wasm 未随依赖下发')
      return exports.createLibarchive(new Uint8Array(wasm)).then((module) => ({ module, ArchiveReader: exports.ArchiveReader }))
    })
    libarchiveModule.catch(() => (libarchiveModule = null))
  }
  return libarchiveModule
}

/**
 * libarchive reads sequentially, so listing is one pass and reading is another
 * that keeps only the wanted entries. Each pass opens its own reader and frees
 * it, including when a wrong password throws halfway.
 */
async function openWithLibarchive(fileName, bytes, format, password) {
  const { module, ArchiveReader } = await libarchiveLib()
  const data = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const pass = (visit) => {
    const reader = new ArchiveReader(module, data, password || undefined)
    try {
      for (const entry of reader.entries()) visit(entry)
      return reader.hasEncryptedData()
    } catch (err) {
      const message = String(err && err.message ? err.message : err)
      if (/passphrase required/i.test(message)) throw new Error(`${fileName} 有密码保护，请填写解压密码`)
      if (/incorrect passphrase/i.test(message)) throw new Error(`${fileName} 的解压密码不正确`)
      throw new Error(`${fileName} 无法读取：${message}`)
    } finally {
      reader.free()
    }
  }

  const entries = []
  const encryptedHeaders = pass((entry) => {
    const type = entry.getFiletype()
    // Links are not materialised: a link could point outside the extraction folder.
    if (type !== 'File' && type !== 'Directory') return entry.skipData()
    const rawName = entry.getPathname()
    entries.push({ rawName, name: safePath(rawName), size: entry.getSize(), directory: type === 'Directory', encrypted: false })
    entry.skipData()
  })
  if (entries.length === 0 && encryptedHeaders) {
    throw new Error(`${fileName} 连文件名也加密了（RAR 的“加密文件名”选项），libarchive 目前无法打开这种压缩包，请用 7-Zip / WinRAR 解压`)
  }
  if (entries.length === 0) throw new Error(`${fileName} 是空的或已损坏，没有读到任何文件`)

  return {
    format,
    decrypts: true,
    entries,
    async read(list) {
      const wanted = new Map(list.map((e, i) => [e.rawName, i]))
      const out = new Array(list.length)
      pass((entry) => {
        const index = wanted.get(entry.getPathname())
        if (index === undefined || entry.getFiletype() !== 'File') return entry.skipData()
        const chunk = entry.readData()
        out[index] = chunk ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : new Uint8Array(0)
      })
      return out.map((d) => d ?? new Uint8Array(0))
    },
  }
}

/* --------------------------------- ZIP ----------------------------------- */

function openZip(bytes) {
  const { unzipSync } = lib()
  const flags = zipFlags(bytes)
  const entries = []
  // A filter that rejects everything reads the central directory only.
  unzipSync(bytes, {
    filter(file) {
      const meta = flags.get(file.name) ?? { utf8: true, encrypted: false }
      entries.push({
        rawName: file.name,
        name: safePath(meta.utf8 ? file.name : redecode(file.name)),
        size: file.originalSize,
        directory: file.name.endsWith('/'),
        encrypted: meta.encrypted,
      })
      return false
    },
  })
  return {
    format: 'zip',
    entries,
    read(list) {
      const wanted = new Set(list.map((e) => e.rawName))
      const files = unzipSync(bytes, { filter: (file) => wanted.has(file.name) })
      return list.map((e) => files[e.rawName])
    },
  }
}

/**
 * General-purpose flags per entry from the central directory: bit 0 marks
 * encryption, bit 11 marks a UTF-8 name. fflate decodes flagless names as
 * Latin-1, so the raw bytes are recoverable from its string.
 */
function zipFlags(bytes) {
  const out = new Map()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0) return out
  let offset = view.getUint32(end + 16, true)
  const count = view.getUint16(end + 10, true)
  for (let n = 0; n < count && offset + 46 <= bytes.length; n++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break
    const flags = view.getUint16(offset + 8, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const raw = bytes.subarray(offset + 46, offset + 46 + nameLength)
    const utf8 = (flags & 0x0800) !== 0
    // Key by the string fflate will produce for this entry.
    const key = utf8 ? new TextDecoder().decode(raw) : latin1(raw)
    out.set(key, { utf8, encrypted: (flags & 0x0001) !== 0 })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return out
}

function latin1(raw) {
  let s = ''
  for (let i = 0; i < raw.length; i++) s += String.fromCharCode(raw[i])
  return s
}

/** Re-reads a Latin-1-decoded name as UTF-8 if valid, otherwise as GBK. */
function redecode(name) {
  const raw = new Uint8Array(name.length)
  for (let i = 0; i < name.length; i++) raw[i] = name.charCodeAt(i) & 0xff
  if (raw.every((b) => b < 0x80)) return name
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    try {
      return new TextDecoder('gbk').decode(raw)
    } catch {
      return name
    }
  }
}

/* --------------------------------- TAR ----------------------------------- */

function isTar(bytes) {
  if (bytes.length < 512) return false
  const magic = latin1(bytes.subarray(257, 262))
  if (magic === 'ustar') return true
  // Pre-POSIX tar has no magic; accept it when the header checksum is right.
  return headerChecksumValid(bytes.subarray(0, 512))
}

function headerChecksumValid(header) {
  const stored = parseOctal(header.subarray(148, 156))
  if (!Number.isFinite(stored)) return false
  let sum = 0
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]
  return sum === stored && header[0] !== 0
}

function parseOctal(field) {
  const text = latin1(field).replace(/\0.*$/, '').trim()
  return text ? parseInt(text, 8) : NaN
}

function cString(field) {
  const end = field.indexOf(0)
  return new TextDecoder().decode(end < 0 ? field : field.subarray(0, end))
}

function openTar(bytes, format) {
  const entries = []
  let offset = 0
  let pax = {}
  let longName = null
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    if (!headerChecksumValid(header)) throw new Error('TAR 文件头校验失败，文件可能已损坏')
    const size = parseOctal(header.subarray(124, 136)) || 0
    const type = String.fromCharCode(header[156] || 48)
    const dataStart = offset + 512
    const data = bytes.subarray(dataStart, dataStart + size)
    offset = dataStart + Math.ceil(size / 512) * 512

    if (type === 'x') {
      pax = parsePax(data)
      continue
    }
    if (type === 'g') continue
    if (type === 'L') {
      longName = cString(data)
      continue
    }

    const prefix = cString(header.subarray(345, 500))
    const name = pax.path || longName || (prefix ? `${prefix}/${cString(header.subarray(0, 100))}` : cString(header.subarray(0, 100)))
    pax = {}
    longName = null
    // Only regular files carry data; links and devices are skipped on purpose.
    if (type === '0' || type === '\0' || type === '7') entries.push({ name: safePath(name), size, data })
    else if (type === '5') entries.push({ name: safePath(name), size: 0, directory: true })
  }
  return { format, entries, read: (list) => list.map((e) => e.data) }
}

/**
 * PAX records are "<length> <key>=<value>\n" where length counts *bytes*, so the
 * walk happens over bytes and only each record is decoded - slicing decoded text
 * by that length breaks every non-ASCII path.
 */
function parsePax(data) {
  const out = {}
  const decoder = new TextDecoder()
  let i = 0
  while (i < data.length) {
    const space = data.indexOf(0x20, i)
    if (space < 0) break
    const length = parseInt(latin1(data.subarray(i, space)), 10)
    if (!length || i + length > data.length) break
    const record = decoder.decode(data.subarray(space + 1, i + length - 1))
    const eq = record.indexOf('=')
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1)
    i += length
  }
  return out
}

/**
 * Writes a POSIX (ustar) tar. Names that do not fit ustar's 100 + 155 byte
 * fields, or are not ASCII, get a PAX `path` record so any modern tar restores
 * them exactly.
 */
function writeTar(files) {
  const encoder = new TextEncoder()
  const chunks = []
  const mtime = Math.floor(Date.now() / 1000)

  const header = (name, size, type) => {
    const block = new Uint8Array(512)
    const put = (text, at, length) => block.set(encoder.encode(text).subarray(0, length), at)
    const octal = (value, at, length) => put(value.toString(8).padStart(length - 1, '0'), at, length - 1)
    put(name, 0, 100)
    octal(0o644, 100, 8)
    octal(0, 108, 8)
    octal(0, 116, 8)
    octal(size, 124, 12)
    octal(mtime, 136, 12)
    block.fill(32, 148, 156)
    block[156] = type.charCodeAt(0)
    put('ustar', 257, 6)
    put('00', 263, 2)
    let sum = 0
    for (let i = 0; i < 512; i++) sum += block[i]
    put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
    return block
  }
  const pad = (size) => new Uint8Array((512 - (size % 512)) % 512)

  for (const file of files) {
    const nameBytes = encoder.encode(file.name)
    const ascii = nameBytes.length === file.name.length
    if (!ascii || nameBytes.length > 100) {
      const record = paxRecord('path', file.name)
      chunks.push(header(`PaxHeaders/${basename(file.name)}`.slice(0, 99).replace(/[^\x20-\x7e]/g, '_'), record.length, 'x'), record, pad(record.length))
    }
    const shortName = ascii ? file.name.slice(-100) : basename(file.name).replace(/[^\x20-\x7e]/g, '_').slice(-100)
    chunks.push(header(shortName, file.bytes.length, '0'), file.bytes, pad(file.bytes.length))
  }
  chunks.push(new Uint8Array(1024))

  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/** One PAX record: "<length> <key>=<value>\n", where length counts itself. */
function paxRecord(key, value) {
  const body = new TextEncoder().encode(` ${key}=${value}\n`)
  let length = body.length + 1
  while (String(length).length + body.length !== length) length = String(length).length + body.length
  return new TextEncoder().encode(`${length}${new TextDecoder().decode(body)}`)
}
