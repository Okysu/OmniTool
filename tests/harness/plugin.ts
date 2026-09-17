/**
 * Runs a built-in plugin's real `run()` in Node.
 *
 * The plugin source and its dependency bundles are evaluated exactly as the
 * sandbox evaluates them (classic scripts calling `definePlugin`), against an
 * in-memory `host`. This tests the shipped code path - parameter handling,
 * library glue, output naming - rather than re-implementations of it.
 *
 * Deliberately not a vm context: a separate realm would give the plugin its own
 * `Uint8Array`, and `instanceof` checks across realms silently fail. Vitest
 * already isolates each test file in its own worker, so globals do not leak.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildSync } from 'esbuild'

const ROOT = resolve(__dirname, '../..')

interface StoredFile {
  id: string
  name: string
  type: string
  bytes: Uint8Array
}

export interface OutputFile {
  name: string
  type: string
  bytes: Uint8Array
  text: string
}

export interface FfmpegCall {
  args: string[]
  inputs: string[]
  outputs: string[]
  label?: string
}

export interface ProbeResult {
  durationSeconds: number | null
  width: number | null
  height: number | null
  videoCodec: string | null
  audioCodec: string | null
}

export interface RunResult {
  summary: string
  outputs: OutputFile[]
  notifications: string[]
  /** Every `host.ffmpeg.run` call, in order, with input ids mapped back to file names. */
  ffmpeg: FfmpegCall[]
  /** Every `host.net.fetch` call that reached the network, in order. */
  requests: NetRequest[]
}

export interface RunOptions {
  /** Fake `host.ffmpeg.probe` result per input file name. */
  probe?: Record<string, Partial<ProbeResult>>
  /** Makes a matching `host.ffmpeg.run` call reject, to test cleanup paths. */
  fail?: (call: FfmpegCall) => boolean
  /** Answers `host.net.fetch`. Without it every request rejects like an offline network. */
  fetch?: (request: NetRequest) => FakeResponse | Promise<FakeResponse>
}

/** A request as it left the host: secret placeholders already substituted. */
export interface NetRequest {
  url: string
  method: string
  headers: Record<string, string>
  /** Text bodies as strings, binary bodies as bytes. */
  body: string | Uint8Array | undefined
  /** The body parsed as JSON, when it is JSON. */
  json: any
  /** Plaintext of a text body or the decoded bytes, for multipart assertions. */
  text: string
}

export interface FakeResponse {
  status?: number
  headers?: Record<string, string>
  /** Objects are sent as JSON. */
  body?: string | Uint8Array | object
}

/** What a fake panel session recorded. */
export interface PanelSession {
  renders: Array<{ nodes: unknown[]; state?: Record<string, unknown>; runLabel?: string; runDisabled?: boolean }>
  state: Record<string, unknown>
  /** Simulates the host reporting a bound value change. */
  change: (key: string, value: unknown) => Promise<void>
  action: (name: string) => Promise<void>
  last: () => PanelSession['renders'][number]
}

type Params = Record<string, unknown>

interface ToolDef {
  id: string
  params?: Array<{ key: string; type: string; default?: unknown; min?: number; options?: Array<{ value: string }> }>
  run: (ctx: unknown) => Promise<{ outputs: Array<string | { id: string }>; summary?: string } | string[]>
  setup?: (ui: unknown) => unknown
}

/**
 * Bundles a vendor entry to an IIFE in memory with the same options that
 * matter in scripts/vendor.mjs (format, global name, footer).
 */
/** Build tweaks some vendor bundles need; mirrors their entries in scripts/vendor.mjs. */
const BUNDLE_OPTIONS: Record<string, { define?: Record<string, string>; inject?: string[] }> = {
  'scripts/entries/qpdf.mjs': { define: { fetch: 'qpdfInlineFetch' }, inject: ['scripts/entries/qpdf-inline-fetch.mjs'] },
}

function bundle(entry: string, globalName: string, emscripten = false): string {
  const extra = BUNDLE_OPTIONS[entry] ?? {}
  const result = buildSync({
    entryPoints: [resolve(ROOT, entry)],
    bundle: true,
    format: 'iife',
    globalName,
    platform: 'browser',
    ...(emscripten ? { external: ['fs', 'path', 'crypto', 'worker_threads', 'url', 'module'] } : {}),
    define: { ...(emscripten ? { 'process.versions': '{}' } : {}), ...extra.define },
    ...(extra.inject ? { inject: extra.inject.map((file) => resolve(ROOT, file)) } : {}),
    footer: { js: `globalThis.${globalName}=${globalName};` },
    write: false,
    logLevel: 'silent',
  })
  return result.outputFiles[0].text
}

/**
 * Evaluates source exactly as the sandbox runtime does: indirect eval. This is
 * not the same as a classic script - strict-mode code keeps its top-level `var`s
 * local - and a harness that used `runInThisContext` once hid exactly that bug.
 */
const indirectEval = (source: string) => (0, eval)(source)

/** `raw` entries are plain scripts that set their own global, evaluated as-is like the sandbox does. */
const DEP_ENTRIES: Record<string, { entry: string; global: string; raw?: boolean; emscripten?: boolean }> = {
  'data-libs': { entry: 'scripts/entries/data-libs.mjs', global: 'DataLibs' },
  magick: { entry: 'node_modules/@imagemagick/magick-wasm/dist/index.js', global: 'MagickWasm' },
  fflate: { entry: 'node_modules/fflate/esm/browser.js', global: 'fflate' },
  'pdf-lib': { entry: 'node_modules/pdf-lib/es/index.js', global: 'PDFLib' },
  // Generated by `pnpm vendor`; tests needing it are skipped when it is absent.
  'cjk-font': { entry: 'public/vendor/fonts/fonts.js', global: 'OMNITOOL_FONTS', raw: true },
  zxing: { entry: 'node_modules/zxing-wasm/dist/es/full/index.js', global: 'ZXingWASM' },
  xlsx: { entry: 'node_modules/xlsx/dist/xlsx.full.min.js', global: 'XLSX', raw: true },
  fontkit: { entry: 'node_modules/@pdf-lib/fontkit/dist/fontkit.es.js', global: 'fontkit' },
  'postal-mime': { entry: 'node_modules/postal-mime/src/postal-mime.js', global: 'PostalMime' },
  qpdf: { entry: 'scripts/entries/qpdf.mjs', global: 'QpdfWasm', emscripten: true },
  libarchive: { entry: 'scripts/entries/libarchive.mjs', global: 'LibarchiveWasm', emscripten: true },
}

/** Binary assets a dependency declares, as the host would serve them. */
const DEP_ASSETS: Record<string, Record<string, string>> = {
  magick: { 'magick.wasm': 'node_modules/@imagemagick/magick-wasm/dist/x86/magick.wasm' },
  'cjk-font': { 'NotoSansSC-Regular.ttf': 'public/vendor/fonts/NotoSansSC-Regular.ttf' },
  zxing: { 'zxing_full.wasm': 'node_modules/zxing-wasm/dist/full/zxing_full.wasm' },
  qpdf: { 'qpdf.wasm': 'node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.wasm' },
  libarchive: { 'libarchive.wasm': 'node_modules/libarchive-wasm/dist/libarchive.wasm' },
}

export function loadPlugin(file: string, deps: string[] = []) {
  /** `host.kv`, shared by runs and panels of this plugin like the real per-plugin store. */
  const kvStore = new Map<string, unknown>()
  const kv = {
    get: async (key: string) => (kvStore.has(key) ? structuredClone(kvStore.get(key)) : null),
    set: async (key: string, value: unknown) => void kvStore.set(key, structuredClone(value)),
    remove: async (key: string) => void kvStore.delete(key),
    keys: async () => [...kvStore.keys()],
  }
  /**
   * `host.secret`, mirroring the vault's rules: `request` resolves at once for
   * an existing secret unless `force`, and a placeholder is only substituted
   * for an origin the secret is bound to - otherwise the request fails closed.
   * `secretAnswer` plays the user in the host dialog (`null` = cancel).
   */
  const secretStore = new Map<string, { label: string; origins: string[]; value: string; createdAt: number }>()
  let secretAnswer: (name: string, options: { origins: string[]; label?: string; hint?: string; force?: boolean }) => string | null = () => null
  const secretPrompts: Array<{ name: string; origins: string[]; label?: string; hint?: string; force?: boolean }> = []
  const secret = {
    request: async (name: string, options: { origins: string[]; label?: string; hint?: string; force?: boolean }) => {
      if (!options?.origins?.length) throw new Error('必须声明 origins：凭据只能发往你明确列出的域名')
      if (secretStore.has(name) && options.force !== true) return true
      secretPrompts.push({ name, ...options })
      const value = secretAnswer(name, options)
      if (value === null) return false
      secretStore.set(name, { label: options.label ?? name, origins: [...options.origins], value, createdAt: Date.now() })
      return true
    },
    has: async (name: string) => secretStore.has(name),
    list: async () => [...secretStore.entries()].map(([name, s]) => ({ name, label: s.label, origins: [...s.origins], createdAt: s.createdAt })),
    remove: async (name: string) => void secretStore.delete(name),
  }
  const substitute = (text: string, origin: string) =>
    text.replace(/\{\{secret:([A-Za-z0-9._-]+)\}\}/g, (_, name: string) => {
      const stored = secretStore.get(name)
      if (!stored) throw new Error(`插件引用了不存在的凭据「${name}」，请先通过 host.secret.request() 录入`)
      if (!stored.origins.includes(origin)) throw new Error(`已阻止：凭据「${name}」只允许发往 ${stored.origins.join('、')}，但本次请求的目标是 ${origin}`)
      return stored.value
    })

  /** Names passed to `host.fs.remove` in the most recent run, even one that threw. */
  let lastRemoved: string[] = []
  for (const dep of deps) {
    const spec = DEP_ENTRIES[dep]
    indirectEval(spec.raw ? readFileSync(resolve(ROOT, spec.entry), 'utf8') : bundle(spec.entry, spec.global, spec.emscripten))
    if (!(spec.global in globalThis)) throw new Error(`dependency ${dep} did not define global ${spec.global}`)
  }

  // Lazy dependencies, served the way the host does: evaluate the bundle once,
  // hand back its global and binary assets.
  const loaded = new Map<string, { exports: unknown; assets: Record<string, ArrayBuffer> }>()
  ;(globalThis as Record<string, unknown>).loadDependency = async (id: string) => {
    if (!loaded.has(id)) {
      const spec = DEP_ENTRIES[id]
      if (!spec) throw new Error(`依赖 ${id} 未在插件清单的 deps 中声明`)
      if (!(spec.global in globalThis)) indirectEval(spec.raw ? readFileSync(resolve(ROOT, spec.entry), 'utf8') : bundle(spec.entry, spec.global, spec.emscripten))
      const assets: Record<string, ArrayBuffer> = {}
      for (const [name, path] of Object.entries(DEP_ASSETS[id] ?? {})) {
        const bytes = readFileSync(resolve(ROOT, path))
        assets[name] = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      }
      loaded.set(id, { exports: (globalThis as Record<string, unknown>)[spec.global], assets })
    }
    return loaded.get(id)
  }

  let definition: { tools: ToolDef[] } | null = null
  ;(globalThis as Record<string, unknown>).definePlugin = (def: { tools: ToolDef[] }) => {
    definition = def
  }
  indirectEval(`${readFileSync(resolve(ROOT, file), 'utf8')}\n//# sourceURL=${file}`)
  if (!definition) throw new Error(`${file} did not call definePlugin()`)
  const plugin = definition as { tools: ToolDef[] }

  function defaults(tool: ToolDef): Params {
    const values: Params = {}
    for (const p of tool.params ?? []) {
      if (p.default !== undefined) values[p.key] = p.default
      else if (p.type === 'switch') values[p.key] = false
      else if (p.type === 'number' || p.type === 'slider') values[p.key] = p.min ?? 0
      else if (p.type === 'select') values[p.key] = p.options?.[0]?.value ?? ''
      else values[p.key] = ''
    }
    return values
  }

  async function run(
    toolId: string,
    inputs: Array<{ name: string; content: string | Uint8Array; type?: string }>,
    params: Params = {},
    options: RunOptions = {},
  ): Promise<RunResult> {
    const tool = plugin.tools.find((t) => t.id === toolId)
    if (!tool) throw new Error(`unknown tool ${toolId}`)

    const files = new Map<string, StoredFile>()
    const ffmpegCalls: FfmpegCall[] = []
    const removed: string[] = []
    lastRemoved = removed
    const open = new Map<string, Uint8Array[]>()
    const notifications: string[] = []
    let seq = 0
    const store = (name: string, type: string, bytes: Uint8Array) => {
      const id = `f${++seq}`
      files.set(id, { id, name, type, bytes })
      return { id, name, size: bytes.length, type }
    }
    const toBytes = (data: unknown) =>
      typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer)
    const get = (id: string) => {
      const file = files.get(id)
      if (!file) throw new Error(`no such file ${id}`)
      return file
    }

    const inputRefs = inputs.map((input) => store(input.name, input.type ?? '', toBytes(input.content)))
    const initial = new Set(files.keys())

    const requests: NetRequest[] = []
    const fetchImpl = async (rawUrl: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
      const url = new URL(rawUrl)
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(init.headers ?? {})) headers[key] = substitute(String(value), url.origin)
      const body = init.body === undefined ? undefined : typeof init.body === 'string' ? substitute(init.body, url.origin) : toBytes(init.body).slice()
      const text = typeof body === 'string' ? body : body ? new TextDecoder().decode(body) : ''
      let json: unknown
      try {
        json = typeof body === 'string' ? JSON.parse(body) : undefined
      } catch {
        json = undefined
      }
      const request = { url: rawUrl, method: init.method ?? 'GET', headers, body, json, text }
      if (!options.fetch) throw new Error('Failed to fetch')
      requests.push(request)
      const response = await options.fetch(request)
      const status = response.status ?? 200
      const payload = response.body === undefined ? new Uint8Array()
        : typeof response.body === 'string' ? new TextEncoder().encode(response.body)
        : response.body instanceof Uint8Array ? response.body
        : new TextEncoder().encode(JSON.stringify(response.body))
      return { status, ok: status >= 200 && status < 300, headers: response.headers ?? {}, body: payload }
    }

    const host = {
      net: {
        fetch: fetchImpl,
        fetchText: async (url: string, init?: never) => new TextDecoder().decode((await fetchImpl(url, init)).body),
        fetchJSON: async (url: string, init?: never) => JSON.parse(new TextDecoder().decode((await fetchImpl(url, init)).body)),
      },
      secret,
      fs: {
        read: async (id: string, offset = 0, length = -1) => {
          const bytes = get(id).bytes
          return bytes.slice(offset, length < 0 ? undefined : offset + length)
        },
        readAll: async (id: string) => get(id).bytes.slice(),
        readText: async (id: string) => new TextDecoder().decode(get(id).bytes),
        readJSON: async (id: string) => JSON.parse(new TextDecoder().decode(get(id).bytes)),
        blob: async (id: string, type?: string) => new Blob([get(id).bytes], { type }),
        create: async (name: string, type = '') => {
          const ref = store(name, type, new Uint8Array())
          open.set(ref.id, [])
          return ref
        },
        write: async (id: string, data: unknown) => void open.get(id)!.push(toBytes(data).slice()),
        writeTransfer: async (id: string, data: unknown) => void open.get(id)!.push(toBytes(data)),
        close: async (id: string) => {
          const chunks = open.get(id)!
          const total = chunks.reduce((n, c) => n + c.length, 0)
          const bytes = new Uint8Array(total)
          let offset = 0
          for (const chunk of chunks) {
            bytes.set(chunk, offset)
            offset += chunk.length
          }
          const file = get(id)
          file.bytes = bytes
          open.delete(id)
          return { id, name: file.name, size: total, type: file.type }
        },
        writeAll: async (name: string, data: unknown, type = '') => store(name, type, toBytes(data).slice()),
        remove: async (id: string) => {
          removed.push(get(id).name)
          files.delete(id)
        },
        digest: async (id: string, algorithm = 'SHA-256') =>
          createHash(algorithm.toLowerCase().replace('-', '')).update(get(id).bytes).digest('hex'),
      },
      ui: { notify: async (message: string) => void notifications.push(message) },
      kv,
      ffmpeg: {
        // Records the command and materialises each declared output as an empty
        // file, so plugin code after the call runs as it would for real.
        run: async (spec: { args: string[]; inputs: string[]; outputs: string[]; label?: string }) => {
          const call = { args: [...spec.args], inputs: spec.inputs.map((id) => get(id).name), outputs: [...spec.outputs], label: spec.label }
          ffmpegCalls.push(call)
          if (options.fail?.(call)) throw new Error('ffmpeg failed (injected)')
          const created = spec.outputs.map((name) => store(name.replace(/%0?\d*d/, '0001'), '', new Uint8Array(8)))
          return { files: created }
        },
        probe: async (id: string) => ({
          durationSeconds: 10, width: 1920, height: 1080, videoCodec: 'h264', audioCodec: 'aac',
          ...(options.probe?.[get(id).name] ?? {}),
        }),
      },
    }

    const controller = new AbortController()
    // Plugins may use the module-scope `host` facade as well as `ctx.host`.
    ;(globalThis as Record<string, unknown>).host = host
    const result = await tool.run({
      toolId,
      inputs: inputRefs,
      params: { ...defaults(tool), ...params },
      signal: controller.signal,
      throwIfAborted: () => {
        if (controller.signal.aborted) throw new Error('已取消')
      },
      progress: () => {},
      host,
    })

    const list = Array.isArray(result) ? result : result.outputs
    const outputs = list
      .map((ref) => get(typeof ref === 'string' ? ref : ref.id))
      .filter((file) => !initial.has(file.id))
      .map((file) => ({ name: file.name, type: file.type, bytes: file.bytes, text: new TextDecoder().decode(file.bytes) }))
    return { summary: Array.isArray(result) ? '' : (result.summary ?? ''), outputs, notifications, ffmpeg: ffmpegCalls, requests }
  }

  /**
   * Opens a tool's `setup(ui)` against a fake session that mirrors the guest
   * runtime: `render` merges state, `setState` patches it, and host-side changes
   * are dispatched to `ui.on` listeners with the merged state.
   */
  async function openPanel(
    toolId: string,
    inputs: Array<{ id?: string; name: string; size?: number; type?: string; content?: string | Uint8Array }>,
    initialState: Params = {},
  ): Promise<PanelSession> {
    const tool = plugin.tools.find((t) => t.id === toolId)
    if (!tool?.setup) throw new Error(`tool ${toolId} has no setup()`)
    const listeners: Record<string, Array<(name: string, value: unknown, state: Params) => unknown>> = { change: [], action: [], pointer: [], canvas: [] }
    const session: PanelSession = {
      renders: [],
      state: { ...initialState },
      change: async (key, value) => {
        session.state = { ...session.state, [key]: value }
        ui.state = session.state
        for (const fn of listeners.change) await fn(key, value, session.state)
      },
      action: async (name) => {
        for (const fn of listeners.action) await fn(name, null, session.state)
      },
      last: () => session.renders[session.renders.length - 1],
    }
    const refs = inputs.map(({ content: _content, ...input }, i) => ({ id: input.id ?? `in${i}`, size: 1000, type: '', ...input }))
    const contentOf = (id: string) => {
      const index = refs.findIndex((ref) => ref.id === id)
      const content = inputs[index]?.content
      if (content === undefined) throw new Error(`panel input ${id} has no content in this test`)
      return typeof content === 'string' ? new TextEncoder().encode(content) : content
    }
    const ui = {
      toolId,
      inputs: refs,
      host: {
        fs: {
          readAll: async (id: string) => contentOf(id).slice(),
          readText: async (id: string) => new TextDecoder().decode(contentOf(id)),
          blob: async (id: string, type?: string) => new Blob([contentOf(id)], { type }),
        },
        kv,
        secret,
        ui: { notify: async () => {} },
      },
      state: session.state,
      render(panel: PanelSession['renders'][number]) {
        if (panel.state) Object.assign(session.state, panel.state)
        session.renders.push(JSON.parse(JSON.stringify(panel)))
      },
      setState(patch: Params) {
        Object.assign(session.state, patch)
      },
      on(kind: string, fn: (name: string, value: unknown, state: Params) => unknown) {
        listeners[kind].push(fn)
      },
    }
    await tool.setup(ui)
    return session
  }

  return {
    run,
    openPanel,
    lastRemoved: () => lastRemoved,
    tools: plugin.tools,
    kv,
    /** The fake credential vault: seed it, script the user's answer, inspect prompts. */
    secrets: {
      set: (name: string, value: string, origins: string[]) => void secretStore.set(name, { label: name, origins, value, createdAt: Date.now() }),
      get: (name: string) => secretStore.get(name),
      answer: (fn: typeof secretAnswer) => void (secretAnswer = fn),
      prompts: secretPrompts,
    },
  }
}
