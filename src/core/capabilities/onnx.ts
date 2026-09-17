/**
 * Host-side ONNX Runtime Web.
 *
 * Inference runs entirely on the user's machine - the point of putting it here
 * rather than calling a cloud API. What crosses the network is the *model*, once,
 * and only after the user approves that specific download.
 *
 * ## Why a host capability
 *
 * onnxruntime-web fetches its own wasm payload and (for threads) spawns workers.
 * The plugin sandbox has neither network nor a way to serve those. Running ORT
 * here also means one runtime shared across plugins rather than one per plugin,
 * and a single place to cache multi-hundred-megabyte weights.
 *
 * ## Model trust
 *
 * A model is code-adjacent: it decides what the tool outputs. So a model is
 * identified by URL *and* SHA-256, the digest is verified on download and on
 * every cache load, and the user approves the download with the size and source
 * shown. A plugin can request a model; it cannot silently fetch one.
 */
import { reactive, shallowReactive } from 'vue'
import type { OnnxRequest, OnnxResponse } from './onnx.worker'
import OnnxWorker from './onnx.worker?worker'
import { promptForConfirmation } from '@/core/ui/prompt'
import { formatBytes } from '@/lib/format'
import { settings } from '@/core/settings'
import { resolveModelUrl } from './model-source'

const MODEL_DIR = 'models'
/** Refuse absurd downloads outright rather than filling the user's disk. */
const MAX_MODEL_BYTES = 2 * 1024 * 1024 * 1024

export const onnxState = reactive({
  status: 'idle' as 'idle' | 'ready' | 'failed',
  error: '',
  /** Execution providers actually available here, best first. */
  providers: [] as string[],
})

export interface ModelSpec {
  /** Stable id; also the cache filename. */
  id: string
  /** Human name shown in the approval dialog. */
  name: string
  url: string
  /** Lowercase hex SHA-256 of the model file. Required - see "Model trust". */
  sha256: string
  /** Approximate download size, shown before the user commits. */
  bytes: number
  /** Licence string shown alongside the source. */
  license?: string
}

export interface CachedModel {
  id: string
  name: string
  bytes: number
  cachedAt: number
  license?: string
  /** The canonical URL the plugin asked for. */
  url?: string
}

/** Written next to each cached model so the settings page can say what it is. */
interface ModelMeta {
  name: string
  license?: string
  url: string
  sha256: string
}

const META_SUFFIX = '.meta.json'

export const cachedModels = shallowReactive<CachedModel[]>([])

/* -------------------------------------------------------------------------- */
/* Runtime bootstrap                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The runtime lives in a dedicated worker (see onnx.worker.ts for why not ORT's
 * built-in proxy). Requests are plain messages with an id; typed arrays move by
 * transfer in both directions.
 */
let worker: Worker | null = null
let workerReady: Promise<void> | null = null
let requestSeq = 0
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

type Request = OnnxRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never

function send<T>(request: Request, transfer: Transferable[] = []): Promise<T> {
  const id = ++requestSeq
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    worker!.postMessage({ ...request, id }, transfer)
  })
}

function ensureWorker(): Promise<void> {
  if (workerReady) return workerReady
  worker = new OnnxWorker({ name: 'omnitool-onnx' })
  worker.addEventListener('message', (event: MessageEvent<OnnxResponse>) => {
    const entry = pending.get(event.data.id)
    if (!entry) return
    pending.delete(event.data.id)
    if (event.data.ok) entry.resolve(event.data.value)
    else entry.reject(new Error(event.data.error))
  })
  worker.addEventListener('error', (event) => {
    const error = new Error(`推理运行时崩溃：${event.message || '未知错误'}`)
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
    onnxState.status = 'failed'
    onnxState.error = error.message
    // Sessions died with the worker; the next load starts a fresh one.
    worker = null
    workerReady = null
    sessions.clear()
  })

  const numThreads =
    typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
      ? Math.max(1, Math.min(4, navigator.hardwareConcurrency ?? 2))
      : 1
  workerReady = send<{ gpu: boolean }>({
    t: 'init',
    // Absolute: the worker resolves relative paths against its own chunk URL.
    // Same-origin wasm keeps the app offline-capable and stops a CDN from
    // learning which tools the user runs.
    wasmPaths: new URL('/vendor/ort/', location.origin).href,
    numThreads,
  }).then(
    ({ gpu }) => {
      onnxState.providers = gpu ? ['webgpu', 'wasm'] : ['wasm']
      onnxState.status = 'ready'
    },
    (error: Error) => {
      onnxState.status = 'failed'
      onnxState.error = error.message
      workerReady = null
      throw error
    },
  )
  return workerReady
}

/* -------------------------------------------------------------------------- */
/* Model cache (OPFS)                                                         */
/* -------------------------------------------------------------------------- */

async function modelDir(): Promise<FileSystemDirectoryHandle | null> {
  if (!navigator.storage?.getDirectory) return null
  try {
    const root = await navigator.storage.getDirectory()
    return await root.getDirectoryHandle(MODEL_DIR, { create: true })
  } catch {
    return null
  }
}

export async function refreshModelCache(): Promise<void> {
  const dir = await modelDir()
  cachedModels.length = 0
  if (!dir) return
  // `entries()` is async-iterable on the directory handle.
  const files = new Map<string, File>()
  for await (const [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
    if (handle.kind === 'file') files.set(name, await (handle as FileSystemFileHandle).getFile())
  }
  const found: CachedModel[] = []
  for (const [name, file] of files) {
    if (name.endsWith(META_SUFFIX)) continue
    let meta: Partial<ModelMeta> = {}
    const metaFile = files.get(`${name}${META_SUFFIX}`)
    if (metaFile) {
      try {
        meta = JSON.parse(await metaFile.text())
      } catch {
        /* unreadable sidecar: show the id */
      }
    }
    found.push({ id: name, name: meta.name || name, bytes: file.size, cachedAt: file.lastModified, license: meta.license, url: meta.url })
  }
  cachedModels.splice(0, cachedModels.length, ...found.sort((a, b) => b.cachedAt - a.cachedAt))
}

export async function deleteCachedModel(id: string): Promise<void> {
  const dir = await modelDir()
  await dir?.removeEntry(id).catch(() => {})
  await dir?.removeEntry(`${id}${META_SUFFIX}`).catch(() => {})
  sessions.forEach((session, key) => {
    if (session.modelId === id) {
      void send({ t: 'release', session: session.handle }).catch(() => {})
      sessions.delete(key)
    }
  })
  await refreshModelCache()
}

async function readCached(spec: ModelSpec): Promise<Uint8Array | null> {
  const dir = await modelDir()
  if (!dir) return null
  try {
    const handle = await dir.getFileHandle(spec.id)
    const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer())
    // Verified on every load, not just on download: a cache entry is a file on
    // disk that other software can touch.
    if ((await sha256Hex(bytes)) !== spec.sha256.toLowerCase()) {
      await dir.removeEntry(spec.id).catch(() => {})
      return null
    }
    return bytes
  } catch {
    return null
  }
}

async function writeCached(spec: ModelSpec, bytes: Uint8Array): Promise<void> {
  const dir = await modelDir()
  if (!dir) return
  const handle = await dir.getFileHandle(spec.id, { create: true })
  const stream = await handle.createWritable()
  await stream.write(bytes)
  await stream.close()
  const meta: ModelMeta = { name: spec.name, license: spec.license, url: spec.url, sha256: spec.sha256 }
  const metaStream = await (await dir.getFileHandle(`${spec.id}${META_SUFFIX}`, { create: true })).createWritable()
  await metaStream.write(JSON.stringify(meta))
  await metaStream.close()
  await refreshModelCache()
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/* -------------------------------------------------------------------------- */
/* Download                                                                   */
/* -------------------------------------------------------------------------- */

async function fetchModel(
  spec: ModelSpec,
  onProgress?: (ratio: number | null, label: string) => void,
): Promise<Uint8Array> {
  if (spec.bytes > MAX_MODEL_BYTES) throw new Error(`模型体积超过上限（${formatBytes(MAX_MODEL_BYTES)}）`)

  const url = resolveModelUrl(spec.url, settings.modelSource, settings.modelSourceUrl)
  let response: Response
  try {
    response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' })
  } catch (error) {
    throw new Error(`无法连接 ${new URL(url).host}（${error instanceof Error ? error.message : error}）。可在「设置 → 本地模型」中切换下载源。`)
  }
  if (!response.ok) throw new Error(`模型下载失败：HTTP ${response.status}（${new URL(url).host}）。可在「设置 → 本地模型」中切换下载源。`)

  const total = Number(response.headers.get('content-length') ?? spec.bytes)
  const chunks: Uint8Array[] = []
  let received = 0

  const reader = response.body?.getReader()
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    return bytes
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.byteLength
    if (received > MAX_MODEL_BYTES) throw new Error('模型体积超过上限')
    onProgress?.(total > 0 ? received / total : null, `正在下载模型 ${formatBytes(received)} / ${formatBytes(total)}`)
  }

  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  const digest = await sha256Hex(bytes)
  if (digest !== spec.sha256.toLowerCase()) {
    throw new Error(`模型校验失败：期望 SHA-256 ${spec.sha256}，实际 ${digest}。已拒绝加载。`)
  }
  return bytes
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */

interface Session {
  modelId: string
  pluginId: string
  /** Handle of the session inside the runtime worker. */
  handle: number
  inputs: string[]
  outputs: string[]
}

const sessions = new Map<string, Session>()
let sessionSeq = 0

export interface LoadHooks {
  pluginName: string
  pluginId: string
  onProgress?: (ratio: number | null, label: string) => void
}

/**
 * Resolves a model to a live session, downloading and caching it on first use.
 *
 * The approval prompt appears only for an uncached model, so a repeat run of the
 * same tool is silent.
 */
export async function loadModel(spec: ModelSpec, hooks: LoadHooks): Promise<string> {

  // The id is the cache file name: keep it a plain name that cannot collide with the metadata sidecars.
  if (!/^[\w.-]{1,120}$/.test(spec.id) || spec.id.endsWith(META_SUFFIX) || spec.id.startsWith('.')) {
    throw new Error(`模型 id「${spec.id}」不合法：只能包含字母、数字、点、下划线和连字符`)
  }
  if (!/^[a-f0-9]{64}$/i.test(spec.sha256)) {
    throw new Error(`模型 ${spec.id} 缺少合法的 sha256，已拒绝加载`)
  }

  let bytes = await readCached(spec)

  if (!bytes) {
    const approved = await promptForConfirmation({
      title: '下载本地模型',
      message: `插件「${hooks.pluginName}」需要模型「${spec.name}」（约 ${formatBytes(spec.bytes)}）。`,
      detail:
        `来源：${resolveModelUrl(spec.url, settings.modelSource, settings.modelSourceUrl)}\n` +
        `校验：SHA-256 ${spec.sha256}\n` +
        (spec.license ? `许可：${spec.license}\n` : '') +
        '模型只下载一次并缓存在本机；推理全程离线，你的文件不会上传。',
      confirmLabel: '下载并缓存',
    })
    if (!approved) throw new Error('用户取消了模型下载')

    hooks.onProgress?.(null, '正在下载模型…')
    bytes = await fetchModel(spec, hooks.onProgress)
    await writeCached(spec, bytes)
  }

  hooks.onProgress?.(null, '正在初始化推理会话…')
  await ensureWorker()
  // The cached copy stays on this side; the worker gets its own buffer.
  const copy = bytes.slice().buffer
  const created = await send<{ session: number; inputs: string[]; outputs: string[] }>(
    { t: 'create', bytes: copy, preferGpu: true },
    [copy],
  )

  const id = `s${++sessionSeq}`
  sessions.set(id, { modelId: spec.id, pluginId: hooks.pluginId, handle: created.session, inputs: created.inputs, outputs: created.outputs })
  return id
}

export type TensorInput =
  | {
      /** ONNX element type, e.g. `float32`, `int64`, `uint8`. */
      type: string
      dims: number[]
      /** Raw values; typed arrays survive structured clone. */
      data: ArrayBufferView
    }
  | {
      /** A handle returned by an earlier run's `keep`. */
      tensor: string
    }

export interface TensorOutput {
  type: string
  dims: readonly number[]
  /** Present unless the output was kept, in which case `tensor` is its handle. */
  data?: ArrayBufferView
  tensor?: string
}

/**
 * Tensors kept inside the runtime worker between runs.
 *
 * An autoregressive decoder feeds its KV cache back every step. For Whisper
 * that is tens of megabytes per token; copying it sandbox → host → worker and
 * back would dominate inference. Kept outputs stay in the worker and the plugin
 * holds an opaque handle, scoped to it like sessions are.
 */
const keptTensors = new Map<string, { pluginId: string; handle: number }>()
let tensorSeq = 0
/** A plugin that forgets to dispose must not grow worker memory without bound. */
export const MAX_KEPT_TENSORS = 4096

export function sessionInfo(sessionId: string, pluginId: string): { inputs: string[]; outputs: string[] } {
  const session = requireSession(sessionId, pluginId)
  return { inputs: [...session.inputs], outputs: [...session.outputs] }
}

function requireSession(sessionId: string, pluginId: string): Session {
  const session = sessions.get(sessionId)
  // Sessions are keyed per plugin: one plugin cannot drive another's model.
  if (!session || session.pluginId !== pluginId) throw new Error(`未知的推理会话：${sessionId}`)
  return session
}

export async function runSession(
  sessionId: string,
  pluginId: string,
  feeds: Record<string, TensorInput>,
  keep: string[] = [],
  fetches: string[] = [],
): Promise<Record<string, TensorOutput>> {
  const session = requireSession(sessionId, pluginId)
  await ensureWorker()
  const transfer: Transferable[] = []
  const workerFeeds: Record<string, { type: string; dims: number[]; data: ArrayBufferView } | { tensor: number }> = {}
  for (const [name, input] of Object.entries(feeds)) {
    if ('tensor' in input) {
      const kept = keptTensors.get(input.tensor)
      // Handles are per plugin: another plugin's tensor reads as unknown.
      if (!kept || kept.pluginId !== pluginId) throw new Error(`未知的张量句柄：${input.tensor}`)
      workerFeeds[name] = { tensor: kept.handle }
      continue
    }
    workerFeeds[name] = input
    const buffer = input.data.buffer as ArrayBuffer
    if (!transfer.includes(buffer)) transfer.push(buffer)
  }
  const unknown = [...keep, ...fetches].filter((name) => !session.outputs.includes(name))
  if (unknown.length) throw new Error(`模型没有这些输出：${unknown.join('、')}`)
  let owned = 0
  for (const kept of keptTensors.values()) if (kept.pluginId === pluginId) owned++
  if (owned + keep.length > MAX_KEPT_TENSORS) throw new Error(`保留的张量过多（上限 ${MAX_KEPT_TENSORS}），请先调用 onnx.dispose 释放`)

  const raw = await send<Record<string, { type: string; dims: readonly number[]; data?: ArrayBufferView; tensor?: number }>>(
    { t: 'run', session: session.handle, feeds: workerFeeds, keep, fetches },
    transfer,
  )
  const outputs: Record<string, TensorOutput> = {}
  for (const [name, output] of Object.entries(raw)) {
    if (output.tensor === undefined) {
      outputs[name] = { type: output.type, dims: output.dims, data: output.data }
      continue
    }
    const id = `t${++tensorSeq}`
    keptTensors.set(id, { pluginId, handle: output.tensor })
    outputs[name] = { type: output.type, dims: output.dims, tensor: id }
  }
  return outputs
}

/** Frees kept tensors. Unknown or foreign handles are ignored. */
export function disposeTensors(ids: string[], pluginId: string): void {
  const handles: number[] = []
  for (const id of ids) {
    const kept = keptTensors.get(id)
    if (!kept || kept.pluginId !== pluginId) continue
    handles.push(kept.handle)
    keptTensors.delete(id)
  }
  if (handles.length && worker) void send({ t: 'dispose', tensors: handles }).catch(() => {})
}

export function releaseSession(sessionId: string, pluginId: string): void {
  const session = sessions.get(sessionId)
  if (!session || session.pluginId !== pluginId) return
  if (worker) void send({ t: 'release', session: session.handle }).catch(() => {})
  sessions.delete(sessionId)
}

/** Drops every session and kept tensor a plugin holds, e.g. when its sandbox is disposed. */
export function releasePluginSessions(pluginId: string): void {
  disposeTensors([...keptTensors.entries()].filter(([, kept]) => kept.pluginId === pluginId).map(([id]) => id), pluginId)
  for (const [id, session] of sessions) {
    if (session.pluginId !== pluginId) continue
    if (worker) void send({ t: 'release', session: session.handle }).catch(() => {})
    sessions.delete(id)
  }
}
