/**
 * Shared contracts between the host (Vue app, full privileges) and the guest
 * (plugin code, null-origin sandbox).
 *
 * Everything in this file must be structured-cloneable. Functions declared on a
 * plugin manifest live only inside the sandbox; the host receives the stripped
 * `PluginManifest` shape below.
 *
 * Changing anything here is a breaking Plugin API change - bump
 * `PLUGIN_API_VERSION` and record it in docs/design/plugin-api.md.
 */

export const PLUGIN_API_VERSION = 2

/* -------------------------------------------------------------------------- */
/* Capabilities                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The complete set of host powers a plugin can ask for. A plugin declares the
 * ones it needs; the user grants them at install time. Any `host.*` call whose
 * capability was not granted is rejected inside the host, not the sandbox.
 */
export const CAPABILITIES = ['fs', 'ui', 'net', 'kv', 'secret', 'image', 'ffmpeg', 'onnx'] as const
export type Capability = (typeof CAPABILITIES)[number]

export interface CapabilityInfo {
  id: Capability
  label: string
  /** Shown verbatim in the install review dialog. */
  description: string
  /** Drives the colour of the risk chip. */
  risk: 'low' | 'medium' | 'high'
}

export const CAPABILITY_INFO: Record<Capability, CapabilityInfo> = {
  fs: {
    id: 'fs',
    label: '文件读写',
    description: '读取你拖入的文件，并在工作区中创建输出文件。无法访问你的磁盘或其他工具的文件。',
    risk: 'low',
  },
  ui: {
    id: 'ui',
    label: '界面提示',
    description: '发送通知、上报处理进度。',
    risk: 'low',
  },
  net: {
    id: 'net',
    label: '网络请求',
    description: '通过宿主代理向外部地址发起请求。你的文件可能被上传到第三方服务器。',
    risk: 'high',
  },
  kv: {
    id: 'kv',
    label: '本地存储',
    description: '在插件私有的命名空间内持久化少量配置，内容在磁盘上加密保存。无法读取其他插件或宿主的数据。',
    risk: 'medium',
  },
  secret: {
    id: 'secret',
    label: '凭据保管',
    description:
      '请你录入 API 密钥等凭据并加密保管。插件只能请求使用、无法读回明文，且只能发往你在录入时指定的域名。',
    risk: 'medium',
  },
  image: {
    id: 'image',
    label: '图像编解码',
    description: '调用宿主的 Canvas 图像解码与编码能力。',
    risk: 'low',
  },
  ffmpeg: {
    id: 'ffmpeg',
    label: '音视频处理',
    description: '调用宿主内置的 FFmpeg (WASM) 实例处理音视频，全程在本地运行。',
    risk: 'low',
  },
  onnx: {
    id: 'onnx',
    label: '本地模型推理',
    description:
      '加载并运行 ONNX 模型（抠图、超分、OCR 等），全部在本机计算。首次使用某个模型时需要你确认下载。',
    risk: 'low',
  },
}

/* -------------------------------------------------------------------------- */
/* Parameter schema (host renders the form, guest only reads the values)       */
/* -------------------------------------------------------------------------- */

interface ParamBase {
  key: string
  label: string
  hint?: string
  /** Show this control only when another param has one of these values. */
  when?: { key: string; equals: unknown | unknown[] }
}

export type ParamSpec =
  | (ParamBase & { type: 'text'; default?: string; placeholder?: string })
  | (ParamBase & { type: 'textarea'; default?: string; placeholder?: string; rows?: number })
  | (ParamBase & { type: 'number'; default?: number; min?: number; max?: number; step?: number; suffix?: string })
  | (ParamBase & { type: 'slider'; default?: number; min: number; max: number; step?: number; suffix?: string })
  | (ParamBase & { type: 'switch'; default?: boolean })
  | (ParamBase & { type: 'select'; default?: string; options: Array<{ value: string; label: string }> })

export type ParamValues = Record<string, string | number | boolean | number[]>

/* -------------------------------------------------------------------------- */
/* Manifest                                                                    */
/* -------------------------------------------------------------------------- */

export type ToolCategory = 'pdf' | 'media' | 'image' | 'document' | 'ai' | 'archive' | 'other'

export const CATEGORY_LABEL: Record<ToolCategory, string> = {
  pdf: 'PDF 工具箱',
  media: '音视频工具箱',
  image: '图片工具箱',
  document: 'Office 与文本',
  ai: 'AI 增强',
  archive: '压缩与归档',
  other: '其他工具',
}

export interface ToolManifest {
  id: string
  /**
   * True when the tool defines `setup(ui)` and renders its own panel. The host
   * then shows that panel in place of the generated parameter form.
   */
  hasSetup?: boolean
  /**
   * How the tool takes input.
   *   - `files` (default): drop zone only
   *   - `text`: a text box only; the text is handed over as a workspace file
   *   - `both`: tabs for either
   * `none` is for generators that need no input at all.
   */
  input?: 'files' | 'text' | 'both' | 'none'
  /** Filename given to pasted text, which also drives format detection. */
  textFileName?: string
  name: string
  description?: string
  category: ToolCategory
  /** Lucide icon name; unknown names fall back to a generic glyph. */
  icon?: string
  /** `accept` attribute for the file picker, e.g. `['image/*', '.heic']`. */
  accept?: string[]
  /** Accept more than one input file. Default: false. */
  multiple?: boolean
  /** Minimum number of input files required before the tool can run. Default: 1. */
  minFiles?: number
  params?: ParamSpec[]
  /** Free-form keywords, used by the command palette. */
  keywords?: string[]
}

/** The manifest as declared by the plugin author (functions included). */
export interface PluginDefinition extends Omit<PluginManifest, 'apiVersion' | 'tools'> {
  tools: Array<ToolManifest & { run: (ctx: unknown) => unknown }>
}

/** The manifest as it reaches the host: serialisable, functions stripped. */
export interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  homepage?: string
  icon?: string
  apiVersion: number
  capabilities: Capability[]
  /** External scripts the host must fetch and inject before the plugin code. */
  deps?: PluginDep[]
  tools: ToolManifest[]
}

export interface PluginDep {
  id: string
  url: string
  /** Global the UMD bundle exposes, purely informational. */
  global?: string
  /** Optional SRI hash; when present the host verifies it before injecting. */
  integrity?: string
  /**
   * Fetched only when the plugin calls `loadDependency(id)`, instead of before
   * the plugin boots. For large libraries most tools of a plugin never touch.
   */
  lazy?: boolean
  /**
   * Binary files the library needs, e.g. a WebAssembly module, by name. The host
   * fetches and verifies them like the script and hands them over as
   * ArrayBuffers - the sandbox itself has no network.
   */
  assets?: Record<string, { url: string; integrity?: string }>
}

/* -------------------------------------------------------------------------- */
/* File handles                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What a plugin sees of a file. The bytes stay in the host-owned VFS; the plugin
 * only ever holds this descriptor and asks for ranges through `host.fs.read`.
 */
export interface FileRef {
  id: string
  name: string
  size: number
  type: string
}

/* -------------------------------------------------------------------------- */
/* Wire protocol                                                              */
/* -------------------------------------------------------------------------- */

export type HostToGuest =
  /** Boot the sandbox: inject deps, then the plugin source, then report back. */
  | { t: 'init'; nonce: string; pluginId: string; code: string; deps: Array<{ id: string; code: string; global?: string; assets?: Record<string, ArrayBuffer> }> }
  /** Run one tool invocation. */
  | { t: 'invoke'; id: string; toolId: string; inputs: FileRef[]; params: ParamValues }
  /** Resolution of a `call` the guest made into the host. */
  | { t: 'reply'; id: string; ok: true; value: unknown }
  | { t: 'reply'; id: string; ok: false; error: string }
  /** Cooperative cancellation - the guest sees `ctx.signal` abort. */
  | { t: 'abort'; id: string }
  /**
   * Opens (or re-opens, when inputs change) a UI session for a tool that
   * declares `setup`. `id` identifies the session, not an invocation.
   */
  | { t: 'ui-open'; id: string; toolId: string; inputs: FileRef[]; state: Record<string, unknown> }
  /** A user interaction on the rendered panel. */
  | {
      t: 'ui-event'
      id: string
      kind: 'change' | 'action' | 'pointer'
      /** Bound key for `change`, action name for `action`, canvas id for `pointer`. */
      name: string
      value: unknown
      /** The full bound state after the event, so the plugin never has to track deltas. */
      state: Record<string, unknown>
    }
  /**
   * Hands the plugin a drawing surface. `canvas` is an OffscreenCanvas
   * transferred out of the host DOM; after this the host can no longer draw on it.
   */
  | { t: 'ui-canvas'; id: string; canvasId: string; canvas: OffscreenCanvas; width: number; height: number }
  | { t: 'ui-close'; id: string }

export type GuestToHost =
  /** Sandbox booted. `isolation` reports which tier actually came up. */
  | { t: 'ready'; nonce: string; isolation: IsolationMode }
  /** Plugin source evaluated successfully. */
  | { t: 'registered'; nonce: string; manifest: PluginManifest }
  | { t: 'boot-error'; nonce: string; error: string }
  /**
   * Guest asks the host to do something on its behalf. `inv` names the
   * invocation the call belongs to, so host-side progress (ffmpeg, model
   * downloads) reaches the right task and the call inherits its cancellation.
   * Calls made at plugin module scope carry `null`.
   */
  | { t: 'call'; id: string; method: string; args: unknown[]; inv: string | null }
  | { t: 'progress'; id: string; value: number | null; label?: string }
  | { t: 'done'; id: string; value: InvokeResult }
  | { t: 'fail'; id: string; error: string }
  | { t: 'log'; level: 'log' | 'warn' | 'error'; args: string[] }
  /** Replaces the tool's panel. Validated by `sanitizePanel` on arrival. */
  | { t: 'ui-render'; id: string; panel: unknown }
  /** Merges values into the bound state without re-sending the tree. */
  | { t: 'ui-state'; id: string; patch: Record<string, unknown> }
  | { t: 'ui-ready'; id: string }
  | { t: 'ui-error'; id: string; error: string }

/** What a tool's `run()` resolves to. */
export interface InvokeResult {
  /** VFS ids of the produced files, in display order. */
  outputs: string[]
  /** One-line summary shown on the result card. */
  summary?: string
}

/**
 * Which isolation tier the sandbox actually achieved.
 *
 * - `iframe-worker` - the designed tier: null-origin document, plugin on a Worker.
 * - `iframe`        - the Worker could not start (blob workers blocked in an
 *                     opaque origin); plugin runs on the iframe's own thread.
 *                     Host UI stays responsive either way, but a long-running
 *                     plugin can no longer answer RPC promptly.
 *
 * Both tiers keep the same origin isolation; only the threading differs.
 */
export type IsolationMode = 'iframe-worker' | 'iframe'
