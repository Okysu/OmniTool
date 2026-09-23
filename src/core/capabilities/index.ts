/**
 * Host-side implementation of everything a plugin can reach through `host.*`.
 *
 * This module is the enforcement point. The sandbox is what stops a plugin from
 * reaching the DOM, cookies and storage; *this* is what stops it from reading a
 * file it was never given, fetching with the user's credentials, or calling a
 * capability the user did not grant.
 *
 * Every entry point re-validates its arguments. Arguments arrive from untrusted
 * code and carry no type guarantees whatsoever.
 */
import * as vfs from '@/core/vfs'
import { pushToast } from '@/core/ui/toast'
import { promptForSecret } from '@/core/ui/prompt'
import { settings } from '@/core/settings'
import { CAPABILITIES, type Capability } from '@/core/types'
import {
  hasSecret,
  kvRead as vaultKvRead,
  kvWrite as vaultKvWrite,
  listPluginSecrets,
  removeSecret,
  referencedSecrets,
  substituteSecrets,
} from './vault'
import { authorizeNetwork } from './network'
import { probeFfmpeg, runFfmpeg } from './ffmpeg'
import { disposeTensors, loadModel, releaseSession, runSession, sessionInfo, type ModelSpec, type TensorInput } from './onnx'

/** Ceiling on a single `net.fetch` response, to keep a plugin from OOMing the tab. */
const MAX_FETCH_BYTES = 64 * 1024 * 1024
/** Ceiling on one `kv` value, serialised. */
const MAX_KV_BYTES = 256 * 1024
/** Ceiling on how many files one invocation may produce. */
const MAX_OUTPUTS = 512

export interface CapabilityContext {
  pluginId: string
  pluginName: string
  grants: ReadonlySet<Capability>
  /** VFS ids handed to the current invocation. The only readable inputs. */
  allowedInputs: Set<string>
  /** VFS ids this plugin created during the current invocation. */
  ownedOutputs: Set<string>
  /** Trusted (built-in) plugins skip the local-network guard. */
  trusted: boolean
  /** Identity of the sandbox; approvals expire when it is replaced. */
  networkScope?: object
  /** Forwards long-running host work (ffmpeg, model downloads) to the task row. */
  onProgress?: (ratio: number | null, label: string) => void
  /** Aborts when the user cancels the invocation. */
  signal?: AbortSignal
}

export interface DispatchResult {
  value: unknown
  transfer: Transferable[]
}

type Handler = (ctx: CapabilityContext, args: unknown[]) => Promise<DispatchResult>

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

export async function dispatch(ctx: CapabilityContext, method: string, args: unknown[]): Promise<DispatchResult> {
  const handler = HANDLERS[method]
  if (!handler) throw new Error(`未知的宿主方法：${method}`)

  const capability = method.split('.')[0] as Capability
  if (!CAPABILITIES.includes(capability)) throw new Error(`未知能力：${capability}`)
  if (!ctx.grants.has(capability)) {
    throw new Error(`插件「${ctx.pluginName}」未被授予「${capability}」能力，调用 ${method} 被拒绝`)
  }
  return await handler(ctx, args)
}

/* -------------------------------------------------------------------------- */
/* Argument guards                                                            */
/* -------------------------------------------------------------------------- */

function str(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new TypeError(`${field} 必须是字符串`)
  return value
}

function num(value: unknown, field: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) throw new TypeError(`${field} 必须是数字`)
  return n
}

function bytes(value: unknown, field: string): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  throw new TypeError(`${field} 必须是 Uint8Array 或 ArrayBuffer`)
}

/** A plugin may only touch files it was handed or files it created. */
function assertReadable(ctx: CapabilityContext, id: string): void {
  if (!ctx.allowedInputs.has(id) && !ctx.ownedOutputs.has(id)) {
    throw new Error('无权访问该文件：它既不是本次调用的输入，也不是本插件的输出')
  }
}

function assertWritable(ctx: CapabilityContext, id: string): void {
  if (!ctx.ownedOutputs.has(id)) throw new Error('无权写入该文件：只能写入本插件创建的输出文件')
}

/* -------------------------------------------------------------------------- */
/* fs                                                                         */
/* -------------------------------------------------------------------------- */

const fsHandlers: Record<string, Handler> = {
  'fs.read': async (ctx, [rawId, rawOffset, rawLength]) => {
    const id = str(rawId, 'id')
    assertReadable(ctx, id)
    const buffer = await vfs.read(id, num(rawOffset, 'offset', 0), num(rawLength, 'length', -1))
    return { value: buffer, transfer: [buffer] }
  },

  'fs.create': async (ctx, [rawName, rawType]) => {
    if (ctx.ownedOutputs.size >= MAX_OUTPUTS) throw new Error(`单次调用最多创建 ${MAX_OUTPUTS} 个输出文件`)
    const entry = await vfs.create(str(rawName, 'name'), rawType === undefined ? '' : str(rawType, 'type'), ctx.pluginId)
    ctx.ownedOutputs.add(entry.id)
    return { value: vfs.toRef(entry), transfer: [] }
  },

  'fs.write': async (ctx, [rawId, rawData]) => {
    const id = str(rawId, 'id')
    assertWritable(ctx, id)
    await vfs.write(id, bytes(rawData, 'data'))
    return { value: null, transfer: [] }
  },

  'fs.close': async (ctx, [rawId]) => {
    const id = str(rawId, 'id')
    assertWritable(ctx, id)
    const entry = await vfs.close(id)
    return { value: vfs.toRef(entry), transfer: [] }
  },

  /**
   * Digest of a file the plugin can already read.
   *
   * This lives under `fs` rather than a namespace of its own because it confers
   * no privilege - it is derived from bytes the plugin could hash itself. It
   * exists at all because `crypto.subtle` is unavailable inside the sandbox:
   * an opaque-origin document is not a secure context, so WebCrypto's subtle
   * interface is simply absent there.
   */
  'fs.digest': async (ctx, [rawId, rawAlgorithm]) => {
    const id = str(rawId, 'id')
    assertReadable(ctx, id)
    const algorithm = str(rawAlgorithm ?? 'SHA-256', 'algorithm').toUpperCase()
    if (!['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'].includes(algorithm)) {
      throw new Error(`不支持的摘要算法：${algorithm}`)
    }
    const buffer = await vfs.read(id)
    const digest = await crypto.subtle.digest(algorithm, buffer)
    return {
      value: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''),
      transfer: [],
    }
  },

  /**
   * Deletes a file this plugin produced.
   *
   * Scoped to `ownedOutputs`, so a plugin can tidy up its own intermediates
   * (a GIF palette, a two-pass log) but can never delete the user's inputs or
   * another plugin's results.
   */
  'fs.remove': async (ctx, [rawId]) => {
    const id = str(rawId, 'id')
    assertWritable(ctx, id)
    await vfs.remove(id)
    ctx.ownedOutputs.delete(id)
    return { value: null, transfer: [] }
  },
}

/* -------------------------------------------------------------------------- */
/* ui                                                                         */
/* -------------------------------------------------------------------------- */

const uiHandlers: Record<string, Handler> = {
  'ui.notify': async (ctx, [rawMessage, rawLevel]) => {
    const level = str(rawLevel ?? 'info', 'level')
    pushToast({
      // Rendered as text, never as markup - this string is plugin-controlled.
      title: ctx.pluginName,
      message: str(rawMessage, 'message').slice(0, 500),
      level: level === 'error' || level === 'warn' || level === 'success' ? level : 'info',
    })
    return { value: null, transfer: [] }
  },
}

/* -------------------------------------------------------------------------- */
/* net                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Every request that uses a stored credential is announced - the user should
 * always be able to see a plugin spending their API key. A batch job sends
 * dozens of requests in a row, though, and one toast each would bury the
 * screen. Uses by the same plugin, origin and secrets within a short window
 * update a single toast with a running count instead.
 */
const SECRET_NOTICE_WINDOW_MS = 15_000
const secretNotices = new Map<string, { count: number; lastAt: number; toastId: string }>()

function announceSecretUse(pluginId: string, pluginName: string, origin: string, secrets: string[]): void {
  const key = `${pluginId}|${origin}|${[...secrets].sort().join(',')}`
  const now = Date.now()
  const previous = secretNotices.get(key)
  const current =
    previous && now - previous.lastAt < SECRET_NOTICE_WINDOW_MS
      ? { ...previous, count: previous.count + 1, lastAt: now }
      : { count: 1, lastAt: now, toastId: `secret-use-${key}-${now}` }
  secretNotices.set(key, current)
  pushToast({
    id: current.toastId,
    level: 'info',
    title: pluginName,
    message:
      current.count === 1
        ? `已向 ${origin} 发送请求并使用凭据：${secrets.join('、')}`
        : `已向 ${origin} 发送 ${current.count} 次请求并使用凭据：${secrets.join('、')}`,
  })
}

const netHandlers: Record<string, Handler> = {
  'net.fetch': async (ctx, [rawUrl, rawInit]) => {
    const url = new URL(str(rawUrl, 'url'))
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`不支持的协议：${url.protocol}`)
    }
    if (!ctx.trusted) {
      await authorizeNetwork(ctx.networkScope ?? ctx, ctx.pluginName, url, settings.allowLocalNetwork, ctx.signal)
    }

    const init = (rawInit ?? {}) as Record<string, unknown>

    /**
     * Resolves `{{secret:name}}` references against the vault.
     *
     * This is the only place a stored credential becomes plaintext, and it
     * happens *after* the destination is known: `substituteSecrets` refuses any
     * secret not bound to this exact origin, so a plugin cannot redirect a
     * credential to a host the user never approved. Requires the `secret` grant
     * on top of `net` - two separate approvals for two separate powers.
     */
    let usedSecrets: string[] = []
    async function resolve(text: string, field: string): Promise<string> {
      const names = referencedSecrets(text)
      if (names.length === 0) return text
      if (!ctx.grants.has('secret')) {
        throw new Error(`${field} 引用了凭据，但插件「${ctx.pluginName}」未被授予「secret」能力`)
      }
      const result = await substituteSecrets(text, ctx.pluginId, ctx.pluginName, url.origin)
      usedSecrets = [...new Set([...usedSecrets, ...result.used])]
      return result.text
    }

    const headers = new Headers()
    if (init.headers && typeof init.headers === 'object') {
      for (const [key, value] of Object.entries(init.headers as Record<string, unknown>)) {
        headers.set(String(key), await resolve(String(value), `请求头 ${key}`))
      }
    }

    let body: BodyInit | undefined
    if (init.body !== undefined && init.body !== null) {
      // Text bodies may carry placeholders (a JSON payload with an API key);
      // binary bodies are passed through untouched.
      body = typeof init.body === 'string' ? await resolve(init.body, '请求体') : (bytes(init.body, 'body') as BodyInit)
    }

    const response = await fetch(url, {
      method: typeof init.method === 'string' ? init.method : 'GET',
      headers,
      body,
      // Plugin traffic never carries the user's cookies or auth.
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      // Do not forward bodies or credentials across an unchecked redirect.
      redirect: 'error',
      mode: 'cors',
      signal: ctx.signal,
    })

    const declared = Number(response.headers.get('content-length') ?? '0')
    if (declared > MAX_FETCH_BYTES) throw new Error(`响应体超过 ${MAX_FETCH_BYTES} 字节上限`)
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > MAX_FETCH_BYTES) throw new Error(`响应体超过 ${MAX_FETCH_BYTES} 字节上限`)

    const outHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      outHeaders[key] = value
    })

    if (usedSecrets.length > 0) announceSecretUse(ctx.pluginId, ctx.pluginName, url.origin, usedSecrets)

    return {
      value: { status: response.status, ok: response.ok, headers: outHeaders, body: buffer },
      transfer: [buffer],
    }
  },
}

/* -------------------------------------------------------------------------- */
/* kv                                                                         */
/* -------------------------------------------------------------------------- */

const kvHandlers: Record<string, Handler> = {
  'kv.get': async (ctx, [rawKey]) => {
    const store = await vaultKvRead(ctx.pluginId)
    return { value: store[str(rawKey, 'key')] ?? null, transfer: [] }
  },
  'kv.set': async (ctx, [rawKey, value]) => {
    const serialised = JSON.stringify(value ?? null)
    if (serialised.length > MAX_KV_BYTES) throw new Error(`单个键值超过 ${MAX_KV_BYTES} 字节上限`)
    const store = await vaultKvRead(ctx.pluginId)
    store[str(rawKey, 'key')] = JSON.parse(serialised)
    await vaultKvWrite(ctx.pluginId, store)
    return { value: null, transfer: [] }
  },
  'kv.remove': async (ctx, [rawKey]) => {
    const store = await vaultKvRead(ctx.pluginId)
    delete store[str(rawKey, 'key')]
    await vaultKvWrite(ctx.pluginId, store)
    return { value: null, transfer: [] }
  },
  'kv.keys': async (ctx) => {
    return { value: Object.keys(await vaultKvRead(ctx.pluginId)), transfer: [] }
  },
}

/* -------------------------------------------------------------------------- */
/* secret                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Note what is missing from this table: there is no `secret.get`.
 *
 * A plugin can ask the user to store a credential, check whether one exists, and
 * reference it from a request - but there is no code path that returns the
 * plaintext to the sandbox. See `./vault.ts` for the reasoning.
 */
const secretHandlers: Record<string, Handler> = {
  'secret.request': async (ctx, [rawName, rawOptions]) => {
    const name = str(rawName, 'name')
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error('凭据名称只能包含字母、数字、. _ - 且不超过 64 字符')

    const options = (rawOptions ?? {}) as Record<string, unknown>
    const origins = Array.isArray(options.origins) ? options.origins.map(String) : []
    if (origins.length === 0) throw new Error('必须声明 origins：凭据只能发往你明确列出的域名')

    const already = await hasSecret(ctx.pluginId, name)
    if (already && options.force !== true) return { value: true, transfer: [] }

    const accepted = await promptForSecret({
      pluginId: ctx.pluginId,
      pluginName: ctx.pluginName,
      name,
      label: str(options.label ?? name, 'label').slice(0, 120),
      hint: options.hint === undefined ? undefined : String(options.hint).slice(0, 300),
      allowOrigins: origins,
      replacing: already,
    })
    return { value: accepted, transfer: [] }
  },

  'secret.has': async (ctx, [rawName]) => ({
    value: await hasSecret(ctx.pluginId, str(rawName, 'name')),
    transfer: [],
  }),

  'secret.list': async (ctx) => {
    const metas = await listPluginSecrets(ctx.pluginId)
    // Metadata only - never a value.
    return {
      value: metas.map((m) => ({ name: m.name, label: m.label, origins: m.allowOrigins, createdAt: m.createdAt })),
      transfer: [],
    }
  },

  'secret.remove': async (ctx, [rawName]) => {
    await removeSecret(ctx.pluginId, str(rawName, 'name'))
    return { value: null, transfer: [] }
  },
}

/* -------------------------------------------------------------------------- */
/* image                                                                      */
/* -------------------------------------------------------------------------- */

const CANDIDATE_ENCODERS = ['image/png', 'image/jpeg', 'image/webp', 'image/avif']
let encoderCache: string[] | null = null

/** Probes which mime types this browser's canvas can actually produce. */
async function detectEncoders(): Promise<string[]> {
  if (encoderCache) return encoderCache
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const supported: string[] = []
  for (const type of CANDIDATE_ENCODERS) {
    // toDataURL silently falls back to PNG for unsupported types.
    if (canvas.toDataURL(type).startsWith(`data:${type}`)) supported.push(type)
  }
  encoderCache = supported
  return supported
}

/**
 * Decodes a workspace image for drawing on the host.
 *
 * `createImageBitmap` cannot decode SVG in any thread; only an `<img>` element
 * can. That is also the safe way to rasterise untrusted SVG: in an image context
 * scripts never run and external resources are never fetched.
 */
async function decodeForCanvas(id: string): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  const blob = await vfs.blob(id)
  const entry = vfs.get(id)
  const svg = /svg/.test(blob.type || entry?.type || '') || /\.svgz?$/i.test(entry?.name ?? '')
  if (!svg) {
    const bitmap = await createImageBitmap(blob)
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
  }
  // Blob URLs need the right type for the browser to treat bytes as SVG.
  const url = URL.createObjectURL(new Blob([blob], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    // An SVG with neither size attributes nor viewBox reports 0×0; give it the CSS default.
    return { source: img, width: img.naturalWidth || 300, height: img.naturalHeight || 150, close: () => {} }
  } catch {
    throw new Error('无法解析该 SVG 文件')
  } finally {
    URL.revokeObjectURL(url)
  }
}

const imageHandlers: Record<string, Handler> = {
  'image.encoders': async () => ({ value: await detectEncoders(), transfer: [] }),

  'image.probe': async (ctx, [rawId]) => {
    const id = str(rawId, 'id')
    assertReadable(ctx, id)
    const image = await decodeForCanvas(id)
    const value = { width: image.width, height: image.height }
    image.close()
    return { value, transfer: [] }
  },

  'image.transcode': async (ctx, [rawId, rawOpts]) => {
    const id = str(rawId, 'id')
    assertReadable(ctx, id)
    const opts = (rawOpts ?? {}) as Record<string, unknown>
    const format = typeof opts.format === 'string' ? opts.format : 'image/webp'
    const quality = Math.max(0.01, Math.min(1, num(opts.quality, 'quality', 0.8)))
    const maxWidth = num(opts.maxWidth, 'maxWidth', 0)
    const maxHeight = num(opts.maxHeight, 'maxHeight', 0)
    // An exact output width, mainly for vector sources that rasterise crisply at any size.
    const exactWidth = Math.min(16384, num(opts.width, 'width', 0))

    const image = await decodeForCanvas(id)
    const scale = exactWidth > 0 ? exactWidth / image.width : fitScale(image.width, image.height, maxWidth, maxHeight)
    const width = Math.max(1, Math.round(image.width * scale))
    const height = Math.max(1, Math.round(image.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法获取 2D 绘图上下文')
    // JPEG has no alpha; compositing onto a background avoids black fringes.
    if (format === 'image/jpeg') {
      context.fillStyle = typeof opts.background === 'string' ? opts.background : '#ffffff'
      context.fillRect(0, 0, width, height)
    }
    context.imageSmoothingQuality = 'high'
    context.drawImage(image.source, 0, 0, width, height)
    image.close()

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, format, quality))
    if (!blob) throw new Error(`当前浏览器无法编码 ${format}`)
    const buffer = await blob.arrayBuffer()
    return { value: { width, height, type: blob.type, body: buffer }, transfer: [buffer] }
  },
}

function fitScale(width: number, height: number, maxWidth: number, maxHeight: number): number {
  const byWidth = maxWidth > 0 ? maxWidth / width : 1
  const byHeight = maxHeight > 0 ? maxHeight / height : 1
  return Math.min(1, byWidth, byHeight)
}

/* -------------------------------------------------------------------------- */
/* ffmpeg - reserved for iteration 2                                          */
/* -------------------------------------------------------------------------- */

const ffmpegHandlers: Record<string, Handler> = {
  'ffmpeg.run': async (ctx, [rawOptions]) => {
    const options = (rawOptions ?? {}) as Record<string, unknown>
    const args = Array.isArray(options.args) ? options.args.map(String) : []
    const inputs = Array.isArray(options.inputs) ? options.inputs.map(String) : []
    const outputs = Array.isArray(options.outputs) ? options.outputs.map(String) : []

    for (const id of inputs) assertReadable(ctx, id)
    if (outputs.length > 64) throw new Error('单次 ffmpeg 调用最多声明 64 个输出')

    const label = options.label === undefined ? '' : String(options.label).slice(0, 80)

    const result = await runFfmpeg(
      { args, inputs, outputs },
      {
        readFile: async (id) => new Uint8Array(await vfs.read(id)),
        nameOf: (id) => vfs.get(id)?.name ?? id,
        onProgress: (ratio) => ctx.onProgress?.(ratio, label || '正在转码'),
        signal: ctx.signal,
      },
    )

    // Outputs land in the VFS here rather than crossing the boundary as bytes,
    // so a 2 GB transcode never materialises in the sandbox heap.
    const refs = []
    for (const file of result.files) {
      const entry = await vfs.writeAll(file.name, file.data, '', ctx.pluginId)
      ctx.ownedOutputs.add(entry.id)
      refs.push(vfs.toRef(entry))
    }
    return { value: { files: refs, log: result.log }, transfer: [] }
  },

  'ffmpeg.probe': async (ctx, [rawId]) => {
    const id = str(rawId, 'id')
    assertReadable(ctx, id)
    const log = await probeFfmpeg(id, {
      readFile: async (fileId) => new Uint8Array(await vfs.read(fileId)),
      signal: ctx.signal,
    })
    return { value: { log, ...parseProbe(log) }, transfer: [] }
  },
}

/**
 * Pulls the handful of fields tools actually branch on out of ffmpeg's banner.
 *
 * Parsing human-readable log output is fragile by nature, so every field is
 * optional and the raw log is always returned alongside - a plugin that needs
 * something we did not parse can read it itself.
 */
function parseProbe(log: string[]): {
  durationSeconds: number | null
  width: number | null
  height: number | null
  videoCodec: string | null
  audioCodec: string | null
} {
  const text = log.join('\n')
  const duration = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(text)
  const size = /Stream #\d+:\d+.*?Video:.*?,\s*(\d{2,5})x(\d{2,5})/.exec(text)
  const video = /Stream #\d+:\d+.*?Video:\s*([A-Za-z0-9_]+)/.exec(text)
  const audio = /Stream #\d+:\d+.*?Audio:\s*([A-Za-z0-9_]+)/.exec(text)
  return {
    durationSeconds: duration
      ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
      : null,
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
    videoCodec: video ? video[1] : null,
    audioCodec: audio ? audio[1] : null,
  }
}

/* -------------------------------------------------------------------------- */
/* onnx                                                                       */
/* -------------------------------------------------------------------------- */

function modelSpec(raw: unknown): ModelSpec {
  const spec = (raw ?? {}) as Record<string, unknown>
  return {
    id: str(spec.id, 'model.id'),
    name: str(spec.name ?? spec.id, 'model.name'),
    url: str(spec.url, 'model.url'),
    sha256: str(spec.sha256, 'model.sha256'),
    bytes: num(spec.bytes, 'model.bytes', 0),
    license: spec.license === undefined ? undefined : String(spec.license),
  }
}

const onnxHandlers: Record<string, Handler> = {
  'onnx.load': async (ctx, [rawSpec]) => {
    const sessionId = await loadModel(modelSpec(rawSpec), {
      pluginId: ctx.pluginId,
      pluginName: ctx.pluginName,
      onProgress: (ratio, label) => ctx.onProgress?.(ratio, label),
    })
    return { value: sessionId, transfer: [] }
  },

  'onnx.info': async (ctx, [rawSession]) => ({
    value: sessionInfo(str(rawSession, 'sessionId'), ctx.pluginId),
    transfer: [],
  }),

  'onnx.run': async (ctx, [rawSession, rawFeeds, rawOptions]) => {
    const feeds: Record<string, TensorInput> = {}
    for (const [name, value] of Object.entries((rawFeeds ?? {}) as Record<string, unknown>)) {
      const tensor = (value ?? {}) as Record<string, unknown>
      if (typeof tensor.tensor === 'string') {
        feeds[name] = { tensor: tensor.tensor }
        continue
      }
      if (!ArrayBuffer.isView(tensor.data)) throw new TypeError(`输入 ${name} 的 data 必须是 TypedArray`)
      feeds[name] = {
        type: str(tensor.type ?? 'float32', `${name}.type`),
        dims: Array.isArray(tensor.dims) ? tensor.dims.map((d) => num(d, `${name}.dims`)) : [],
        data: tensor.data,
      }
    }

    const options = (rawOptions ?? {}) as Record<string, unknown>
    const keep = Array.isArray(options.keep) ? options.keep.map((name) => str(name, 'keep[]')) : []
    const fetches = Array.isArray(options.outputs) ? options.outputs.map((name) => str(name, 'outputs[]')) : []
    const outputs = await runSession(str(rawSession, 'sessionId'), ctx.pluginId, feeds, keep, fetches)

    const transfer: Transferable[] = []
    const value: Record<string, unknown> = {}
    for (const [name, tensor] of Object.entries(outputs)) {
      if (tensor.tensor !== undefined) {
        value[name] = { type: tensor.type, dims: [...tensor.dims], tensor: tensor.tensor }
        continue
      }
      value[name] = { type: tensor.type, dims: [...tensor.dims], data: tensor.data }
      if (tensor.data) transfer.push(tensor.data.buffer)
    }
    return { value, transfer }
  },

  'onnx.dispose': async (ctx, [rawTensors]) => {
    const ids = Array.isArray(rawTensors) ? rawTensors.filter((id): id is string => typeof id === 'string') : []
    disposeTensors(ids, ctx.pluginId)
    return { value: null, transfer: [] }
  },

  'onnx.release': async (ctx, [rawSession]) => {
    releaseSession(str(rawSession, 'sessionId'), ctx.pluginId)
    return { value: null, transfer: [] }
  },
}

const HANDLERS: Record<string, Handler> = {
  ...fsHandlers,
  ...uiHandlers,
  ...netHandlers,
  ...kvHandlers,
  ...secretHandlers,
  ...imageHandlers,
  ...ffmpegHandlers,
  ...onnxHandlers,
}

/** Every method name the host answers, for docs and the diagnostics panel. */
export const HOST_METHODS = Object.keys(HANDLERS).sort()
