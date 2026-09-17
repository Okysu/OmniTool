/**
 * Host-owned virtual file system.
 *
 * Plugins never hold file bytes. They receive a `FileRef` (an opaque id plus
 * name/size/type) and pull ranges through `host.fs.read`, so a 2 GB video is
 * never cloned across the sandbox boundary and a plugin can only touch files
 * that were explicitly handed to the running invocation.
 *
 * Storage tiers, picked once at startup:
 *   1. OPFS   - bytes live on disk, survive a reload, no heap pressure.
 *   2. memory - Blob parts in a Map; used when OPFS or writable streams are
 *      unavailable (Safari main thread, private windows, older browsers).
 */
import { reactive } from 'vue'
import { del as idbDel, get as idbGet, set as idbSet } from 'idb-keyval'
import { nanoid } from '@/lib/id'
import type { FileRef } from '@/core/types'

export type VfsBacking = 'opfs' | 'memory'

export interface VfsEntry {
  id: string
  name: string
  size: number
  type: string
  createdAt: number
  /** Which invocation produced this file; `null` for user-supplied inputs. */
  producedBy: string | null
}

const META_KEY = 'omnitool.vfs.meta.v1'
const DIR_NAME = 'vfs'

/**
 * Reactive index of everything currently in the VFS, oldest first.
 *
 * Deeply reactive on purpose: `size` is mutated in place while an output file is
 * being streamed, and the result list renders it live.
 */
export const entries = reactive<VfsEntry[]>([])

export const vfsState = reactive({
  backing: 'memory' as VfsBacking,
  ready: false,
  /** Reason OPFS was rejected, surfaced in Settings > Diagnostics. */
  degradedReason: '' as string,
})

/* -------------------------------------------------------------------------- */
/* Backing store                                                              */
/* -------------------------------------------------------------------------- */

let opfsDir: FileSystemDirectoryHandle | null = null
const memoryBlobs = new Map<string, Blob>()
/** Open write streams, keyed by entry id. */
const writers = new Map<string, { chunks: BlobPart[]; stream?: FileSystemWritableFileStream }>()
const urlCache = new Map<string, string>()

async function probeOpfs(): Promise<FileSystemDirectoryHandle | null> {
  if (!navigator.storage?.getDirectory) {
    vfsState.degradedReason = '当前浏览器不支持 OPFS (navigator.storage.getDirectory)'
    return null
  }
  try {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle(DIR_NAME, { create: true })
    // Writable streams are the part Safari lacks on the main thread; probe for
    // them rather than sniffing the user agent.
    const probe = await dir.getFileHandle('.probe', { create: true })
    if (typeof (probe as { createWritable?: unknown }).createWritable !== 'function') {
      vfsState.degradedReason = '当前浏览器的 OPFS 不支持主线程写入流 (createWritable)'
      await dir.removeEntry('.probe').catch(() => {})
      return null
    }
    const w = await probe.createWritable()
    await w.write(new Uint8Array([1]))
    await w.close()
    await dir.removeEntry('.probe').catch(() => {})
    return dir
  } catch (err) {
    vfsState.degradedReason = `OPFS 初始化失败：${String(err)}`
    return null
  }
}

/** Boots the VFS and restores metadata from a previous session. */
export async function initVfs(): Promise<void> {
  if (vfsState.ready) return
  opfsDir = await probeOpfs()
  vfsState.backing = opfsDir ? 'opfs' : 'memory'

  if (opfsDir) {
    const saved = ((await idbGet(META_KEY)) as VfsEntry[] | undefined) ?? []
    // Drop metadata whose bytes are gone (storage eviction, manual clear).
    for (const entry of saved) {
      try {
        await opfsDir.getFileHandle(entry.id)
        entries.push(entry)
      } catch {
        /* orphaned metadata */
      }
    }
    await persistMeta()
  }
  vfsState.ready = true
}

async function persistMeta(): Promise<void> {
  if (vfsState.backing !== 'opfs') return
  await idbSet(
    META_KEY,
    entries.map((e) => ({ ...e })),
  ).catch(() => {})
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export function get(id: string): VfsEntry | undefined {
  return entries.find((e) => e.id === id)
}

export function toRef(entry: VfsEntry): FileRef {
  return { id: entry.id, name: entry.name, size: entry.size, type: entry.type }
}

export async function blob(id: string): Promise<Blob> {
  const entry = get(id)
  if (!entry) throw new Error(`文件不存在：${id}`)
  if (opfsDir) {
    const handle = await opfsDir.getFileHandle(entry.id)
    const file = await handle.getFile()
    return file.slice(0, file.size, entry.type || file.type)
  }
  const b = memoryBlobs.get(id)
  if (!b) throw new Error(`文件内容不存在：${id}`)
  return b
}

/**
 * Reads a byte range. `length < 0` means "to the end of the file".
 * Returns a fresh ArrayBuffer so the caller can transfer it without detaching
 * anything the VFS still owns.
 */
export async function read(id: string, offset = 0, length = -1): Promise<ArrayBuffer> {
  const b = await blob(id)
  const start = Math.max(0, Math.min(offset, b.size))
  const end = length < 0 ? b.size : Math.min(start + length, b.size)
  return await b.slice(start, end).arrayBuffer()
}

/** Stable object URL for previews. Revoked by `remove`/`clear`. */
export async function objectUrl(id: string): Promise<string> {
  const cached = urlCache.get(id)
  if (cached) return cached
  const url = URL.createObjectURL(await blob(id))
  urlCache.set(id, url)
  return url
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

export async function importFile(file: File): Promise<VfsEntry> {
  const entry: VfsEntry = {
    id: nanoid(),
    name: file.name,
    size: file.size,
    type: file.type || guessType(file.name),
    createdAt: Date.now(),
    producedBy: null,
  }
  if (opfsDir) {
    const handle = await opfsDir.getFileHandle(entry.id, { create: true })
    const stream = await handle.createWritable()
    await file.stream().pipeTo(stream)
  } else {
    memoryBlobs.set(entry.id, file)
  }
  entries.push(entry)
  await persistMeta()
  return entry
}

/** Creates an empty file and opens it for writing. */
export async function create(name: string, type = '', producedBy: string | null = null): Promise<VfsEntry> {
  const entry: VfsEntry = {
    id: nanoid(),
    name: sanitizeName(name),
    size: 0,
    type: type || guessType(name),
    createdAt: Date.now(),
    producedBy,
  }
  if (opfsDir) {
    const handle = await opfsDir.getFileHandle(entry.id, { create: true })
    writers.set(entry.id, { chunks: [], stream: await handle.createWritable() })
  } else {
    writers.set(entry.id, { chunks: [] })
  }
  entries.push(entry)
  return entry
}

export async function write(id: string, chunk: ArrayBuffer | Uint8Array): Promise<void> {
  const w = writers.get(id)
  if (!w) throw new Error(`文件未打开写入：${id}`)
  const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
  if (w.stream) {
    await w.stream.write(bytes)
  } else {
    w.chunks.push(bytes)
  }
  const entry = get(id)
  if (entry) entry.size += bytes.byteLength
}

export async function close(id: string): Promise<VfsEntry> {
  const w = writers.get(id)
  if (!w) throw new Error(`文件未打开写入：${id}`)
  const entry = get(id)!
  if (w.stream) {
    await w.stream.close()
  } else {
    memoryBlobs.set(id, new Blob(w.chunks, { type: entry.type }))
  }
  writers.delete(id)
  await persistMeta()
  return entry
}

/** Convenience for callers that already hold the complete bytes. */
export async function writeAll(
  name: string,
  data: ArrayBuffer | Uint8Array | Blob,
  type = '',
  producedBy: string | null = null,
): Promise<VfsEntry> {
  const entry = await create(name, type, producedBy)
  const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data
  await write(entry.id, bytes)
  return await close(entry.id)
}

/* -------------------------------------------------------------------------- */
/* Removal                                                                    */
/* -------------------------------------------------------------------------- */

export async function remove(id: string): Promise<void> {
  const idx = entries.findIndex((e) => e.id === id)
  if (idx === -1) return
  entries.splice(idx, 1)
  revokeUrl(id)
  memoryBlobs.delete(id)
  const w = writers.get(id)
  if (w?.stream) await w.stream.abort().catch(() => {})
  writers.delete(id)
  if (opfsDir) await opfsDir.removeEntry(id).catch(() => {})
  await persistMeta()
}

export async function clear(): Promise<void> {
  const ids = entries.map((e) => e.id)
  for (const id of ids) await remove(id)
  await idbDel(META_KEY).catch(() => {})
}

/** Total bytes currently held. */
export function usedBytes(): number {
  return entries.reduce((sum, e) => sum + e.size, 0)
}

function revokeUrl(id: string): void {
  const url = urlCache.get(id)
  if (url) {
    URL.revokeObjectURL(url)
    urlCache.delete(id)
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Normalises an untrusted, plugin-chosen name into a safe relative path.
 *
 * Folders are allowed - extracting an archive should survive "download as ZIP"
 * - but every segment is cleaned: control characters removed, and empty, `.`
 * and `..` segments dropped, so no name can climb out of the archive it is
 * later written into. Storage is keyed by id, never by name.
 */
export function sanitizeName(name: string): string {
  const segments = String(name)
    .split(/[\\/]+/)
    .map((segment) => segment.replace(/[\x00-\x1f\x7f]/g, '').trim())
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
  const joined = segments.join('/')
  if (joined.length <= 240) return joined || 'output.bin'
  // Keep the file name when shortening: its extension decides the type.
  const file = segments[segments.length - 1].slice(-180)
  return `${joined.slice(0, 239 - file.length)}/${file}`.replace(/^\/+/, '')
}

const EXT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  json: 'application/json',
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  zip: 'application/zip',
}

export function guessType(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return EXT_TYPES[ext] ?? ''
}
