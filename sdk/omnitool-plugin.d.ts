/**
 * OmniTool Plugin API — type declarations (API v2).
 *
 * These power autocompletion, hover docs and type checking in the built-in
 * plugin editor. They are also usable as-is in your own IDE: reference this file
 * from a `jsconfig.json` or with `/// <reference path="omnitool-plugin.d.ts" />`.
 *
 * Plugins are plain JavaScript; no build step is needed.
 */

/* ========================================================================== */
/* Entry point                                                                */
/* ========================================================================== */

/**
 * Registers your plugin. Call it exactly once, at the top level of the file.
 *
 * @example
 * definePlugin({
 *   id: 'com.example.hello',
 *   name: '示例插件',
 *   version: '1.0.0',
 *   capabilities: ['fs'],
 *   tools: [{ id: 'copy', name: '复制', category: 'other', async run(ctx) { … } }],
 * })
 */
declare function definePlugin(definition: OmniPlugin.PluginDefinition): void

/**
 * The host API, also available per-invocation as `ctx.host` and per-panel as
 * `ui.host`. Every namespace requires the matching capability; calling one you
 * were not granted rejects with an error.
 */
declare const host: OmniPlugin.Host

/**
 * Loads a dependency declared with `lazy: true` (or returns an already loaded
 * one). Only dependencies listed in your manifest can be loaded.
 *
 * @example
 * const { exports: zip } = await loadDependency('fflate')
 */
declare function loadDependency(id: string): Promise<{ exports: any; assets: Record<string, ArrayBuffer> }>

declare namespace OmniPlugin {
  /* ======================================================================== */
  /* Manifest                                                                 */
  /* ======================================================================== */

  /**
   * - `fs`      read the invocation's inputs, write outputs
   * - `ui`      toasts
   * - `net`     outbound HTTP via the host (high risk: data can leave the machine)
   * - `kv`      private, encrypted-at-rest key/value storage
   * - `secret`  ask the user for a credential you can use but never read back
   * - `image`   host-side canvas decode/encode
   * - `ffmpeg`  local FFmpeg (WASM)
   * - `onnx`    local model inference
   */
  type Capability = 'fs' | 'ui' | 'net' | 'kv' | 'secret' | 'image' | 'ffmpeg' | 'onnx'

  type Category = 'pdf' | 'media' | 'image' | 'document' | 'ai' | 'archive' | 'other'

  interface PluginDefinition {
    /** Globally unique. Reverse-DNS recommended, e.g. `com.you.tools`. `/^[a-z0-9][a-z0-9._-]{1,63}$/i` */
    id: string
    name: string
    /** Semver. */
    version?: string
    description?: string
    author?: string
    homepage?: string
    /** A Lucide icon name in kebab-case, e.g. `file-json`. */
    icon?: string
    /** Request only what you use. The user can decline any of these individually. */
    capabilities?: Capability[]
    /**
     * External scripts injected before your code. The sandbox has no network, so
     * the host fetches, verifies and caches them for you. They run with your
     * plugin's permissions.
     */
    deps?: Dependency[]
    tools: ToolDefinition[]
  }

  interface Dependency {
    id: string
    /** Absolute URL, or a same-origin path like `/vendor/pdf-lib.js`. */
    url: string
    /** The global the script defines, e.g. `PDFLib`. Informational. */
    global?: string
    /** Subresource Integrity hash, e.g. `sha384-…`. Verified on every load. */
    integrity?: string
    /** Not injected at boot; load it when needed with `loadDependency(id)`. */
    lazy?: boolean
    /** Binary files delivered with the dependency (e.g. a `.wasm`), by name. */
    assets?: Record<string, { url: string; integrity?: string }>
  }

  interface ToolDefinition {
    /** Unique within the plugin. */
    id: string
    name: string
    category: Category
    description?: string
    icon?: string
    /** File picker filter, e.g. `['image/*', '.heic']`. */
    accept?: string[]
    /** Accept several input files. Default `false`. */
    multiple?: boolean
    /** Inputs required before the run button enables. Default `1` (`0` when `input` is `'none'`). */
    minFiles?: number
    /**
     * How the user supplies input:
     * - `'files'` (default) drop zone
     * - `'text'` a text box; the text reaches you as a file named `textFileName`
     * - `'both'` tabs for either
     * - `'none'` no input (generators)
     */
    input?: 'files' | 'text' | 'both' | 'none'
    /** Name given to pasted text. Its extension is what format sniffing sees. Default `input.txt`. */
    textFileName?: string
    /** Search keywords for the command palette. */
    keywords?: string[]
    /** A generated form. Ignored when `setup` is defined. */
    params?: ParamSpec[]
    /**
     * Draw your own panel instead of a generated form. Called when the tool
     * opens and again whenever the selected inputs change. Whatever you bind in
     * the panel arrives as `ctx.params` in `run`.
     */
    setup?(ui: UiContext): void | Promise<void>
    /** Does the work. */
    run(ctx: RunContext): Promise<RunResult | string[] | void> | RunResult | string[] | void
  }

  /* ======================================================================== */
  /* Generated form                                                           */
  /* ======================================================================== */

  interface ParamBase {
    key: string
    label: string
    hint?: string
    /** Show only when another param equals this value (or one of these values). */
    when?: { key: string; equals: unknown }
  }

  type ParamSpec =
    | (ParamBase & { type: 'text'; default?: string; placeholder?: string })
    | (ParamBase & { type: 'textarea'; default?: string; placeholder?: string; rows?: number })
    | (ParamBase & { type: 'number'; default?: number; min?: number; max?: number; step?: number; suffix?: string })
    | (ParamBase & { type: 'slider'; default?: number; min: number; max: number; step?: number; suffix?: string })
    | (ParamBase & { type: 'switch'; default?: boolean })
    | (ParamBase & { type: 'select'; default?: string; options: Array<{ value: string; label: string }> })

  /* ======================================================================== */
  /* Running                                                                  */
  /* ======================================================================== */

  /** A handle to a file. Only `id` is a capability; the rest is metadata. */
  interface FileRef {
    id: string
    name: string
    size: number
    type: string
  }

  type ParamValue = string | number | boolean | number[]

  interface RunContext {
    toolId: string
    inputs: FileRef[]
    /** Form values, or the bound state of your `setup` panel. */
    params: Record<string, ParamValue>
    /** Aborts when the user cancels. */
    signal: AbortSignal
    /** Throws if cancelled. Call between expensive steps. */
    throwIfAborted(): void
    /**
     * Reports progress. `value` in 0..1, or `null` for indeterminate.
     * Throttled to ~20 messages per second.
     */
    progress(value: number | null, label?: string): void
    /** Like the global `host`, but host-side progress (ffmpeg, downloads) reports into this task. Prefer it inside `run`. */
    host: Host
  }

  interface RunResult {
    /** File ids (or FileRefs) of what you produced, in display order. */
    outputs: Array<string | FileRef>
    /** One line shown on the result card. Be specific: "657 KB → 6 KB (-99%)". */
    summary?: string
  }

  /* ======================================================================== */
  /* Panels                                                                   */
  /* ======================================================================== */

  interface UiContext {
    toolId: string
    /** The files currently selected in the tool view. */
    inputs: FileRef[]
    /** Current bound values. Kept in sync as the user edits the panel. */
    state: Record<string, ParamValue>
    host: Host
    /** Replaces the whole panel. */
    render(panel: UiPanel): void
    /** Updates bound values without resending the tree. */
    setState(patch: Record<string, ParamValue>): void
    /** A bound control changed. */
    on(event: 'change', handler: (key: string, value: ParamValue, state: Record<string, ParamValue>) => void): () => void
    /** A `button` node was clicked. */
    on(event: 'action', handler: (action: string, value: null, state: Record<string, ParamValue>) => void): () => void
    /** Pointer input on an `interactive` canvas, in canvas pixel coordinates. */
    on(event: 'pointer', handler: (canvasId: string, event: PointerInfo, state: Record<string, ParamValue>) => void): () => void
    /** A `canvas` node's surface was attached - on first render and again whenever the node is re-mounted. Repaint it here. */
    on(event: 'canvas', handler: (canvasId: string, canvas: OffscreenCanvas, state: Record<string, ParamValue>) => void): () => void
    /**
     * The drawing surface behind a rendered `canvas` node. Await it after
     * `render`. You draw it directly; nothing is copied back.
     */
    canvas(canvasId: string): Promise<OffscreenCanvas>
  }

  interface PointerInfo {
    type: 'down' | 'move' | 'up'
    x: number
    y: number
    buttons: number
  }

  interface UiPanel {
    nodes: UiNode[]
    /** Initial or updated bound values. */
    state?: Record<string, ParamValue>
    /** Overrides the run button's label, e.g. "导出片段". */
    runLabel?: string
    /** Disables the run button, e.g. until inputs are valid. */
    runDisabled?: boolean
  }

  interface NodeBase {
    when?: { key: string; equals: unknown }
  }

  type Tone = 'info' | 'success' | 'warning' | 'destructive'

  /** A state key, or `{ bind, scale }` where the stored number times `scale` is the effect's unit. */
  type EffectBinding = string | { bind: string; scale?: number }

  /**
   * Units: `rotate` degrees (multiples of 90) · `flipH`/`flipV`/`mute` boolean ·
   * `brightness` -1..1 (additive, like ffmpeg `eq`) · `contrast`/`saturation`/`speed`/`volume`
   * multipliers where 1 is unchanged · `hue` degrees · `fadeIn`/`fadeOut` seconds from the range edges.
   * Previews are approximate (CSS filters, Web Audio); the export is whatever your command does.
   */
  interface MediaEffects {
    rotate?: EffectBinding
    flipH?: EffectBinding
    flipV?: EffectBinding
    brightness?: EffectBinding
    contrast?: EffectBinding
    saturation?: EffectBinding
    hue?: EffectBinding
    speed?: EffectBinding
    volume?: EffectBinding
    mute?: EffectBinding
    fadeIn?: EffectBinding
    fadeOut?: EffectBinding
  }

  type UiNode =
    | (NodeBase & { type: 'stack'; gap?: number; children: UiNode[] })
    | (NodeBase & { type: 'row'; gap?: number; align?: 'start' | 'center' | 'end' | 'between'; wrap?: boolean; children: UiNode[] })
    | (NodeBase & { type: 'section'; title?: string; children: UiNode[] })
    | (NodeBase & { type: 'separator' })
    | (NodeBase & { type: 'text'; text: string; variant?: 'title' | 'body' | 'muted' | 'mono' })
    | (NodeBase & { type: 'badge'; text: string; tone?: 'default' | 'secondary' | 'outline' | 'success' | 'warning' | 'destructive' })
    | (NodeBase & { type: 'alert'; text: string; title?: string; tone?: Tone })
    | (NodeBase & { type: 'facts'; rows: Array<{ label: string; value: string }> })
    | (NodeBase & { type: 'input'; bind: string; label?: string; hint?: string; placeholder?: string; inputType?: 'text' | 'number'; min?: number; max?: number; step?: number; suffix?: string })
    | (NodeBase & { type: 'textarea'; bind: string; label?: string; hint?: string; placeholder?: string; rows?: number; mono?: boolean })
    | (NodeBase & { type: 'select'; bind: string; label?: string; hint?: string; options: Array<{ value: string; label: string }> })
    | (NodeBase & { type: 'segmented'; bind: string; label?: string; hint?: string; options: Array<{ value: string; label: string }> })
    | (NodeBase & { type: 'slider'; bind: string; min: number; max: number; label?: string; hint?: string; step?: number; suffix?: string })
    | (NodeBase & { type: 'switch'; bind: string; label?: string; hint?: string })
    | (NodeBase & { type: 'color'; bind: string; label?: string; hint?: string })
    | (NodeBase & { type: 'button'; text: string; action: string; variant?: 'default' | 'outline' | 'secondary' | 'ghost' | 'destructive'; icon?: string; disabled?: boolean; busy?: boolean })
    /** Inline preview of a file: image, video, audio, PDF or text. */
    | (NodeBase & { type: 'preview'; fileId: string; height?: number })
    /** Media scrubber. Binds `[startSeconds, endSeconds]`. Same as `media` with only `range`. */
    | (NodeBase & { type: 'timeline'; fileId: string; bind: string; duration?: number })
    /**
     * Visual media editor. Every field except `fileId` names a state key:
     * - `range`: `[start, end]` seconds, edited with a two-handle strip
     * - `crop`: `[x, y, w, h]` as fractions of the source frame; `[]` hides the box
     * - `cropAspect`: pixel ratio w/h the crop box keeps, `0` for free
     * - `markers`: seconds, added with "mark current frame"
     * - `meta`: written by the widget as `[duration, width, height]` once media loads
     * - `effects`: live previews of what your ffmpeg command will do
     */
    | (NodeBase & {
        type: 'media'
        fileId: string
        range?: string
        crop?: string
        cropAspect?: string
        markers?: string
        meta?: string
        effects?: MediaEffects
        height?: number
      })
    /** Reorderable list. Binds a permutation of item indices, e.g. `[2, 0, 1]`. */
    | (NodeBase & { type: 'reorder'; bind: string; label?: string; items: Array<{ label: string; detail?: string }> })
    /** A surface you paint via `ui.canvas(id)`. Set `interactive` to receive pointer events. */
    | (NodeBase & { type: 'canvas'; id: string; aspect?: number; height?: number; interactive?: boolean })

  /* ======================================================================== */
  /* Host API                                                                 */
  /* ======================================================================== */

  interface Host {
    /** Capability `fs`. You can read only this invocation's inputs and files you created. */
    fs: {
      /** Reads bytes. `length < 0` reads to the end. */
      read(id: string, offset?: number, length?: number): Promise<Uint8Array>
      readAll(id: string): Promise<Uint8Array>
      readText(id: string): Promise<string>
      readJSON<T = unknown>(id: string): Promise<T>
      blob(id: string, type?: string): Promise<Blob>
      /** Creates an output file open for writing. */
      create(name: string, type?: string): Promise<FileRef>
      /** Appends a chunk (copied). */
      write(id: string, data: Uint8Array | ArrayBuffer | string): Promise<void>
      /** Appends a chunk by transferring its buffer. Faster; `data` is unusable afterwards. */
      writeTransfer(id: string, data: Uint8Array | ArrayBuffer): Promise<void>
      close(id: string): Promise<FileRef>
      /** create + write + close. */
      writeAll(name: string, data: Uint8Array | ArrayBuffer | string, type?: string): Promise<FileRef>
      /** Deletes a file you created (e.g. an intermediate). Inputs cannot be deleted. */
      remove(id: string): Promise<void>
      /**
       * Hex digest of a readable file. Use this instead of `crypto.subtle`,
       * which does not exist inside the sandbox (an opaque origin is not a secure context).
       */
      digest(id: string, algorithm?: 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512'): Promise<string>
    }

    /** Capability `ui`. */
    ui: {
      notify(message: string, level?: 'info' | 'success' | 'warn' | 'error'): Promise<void>
    }

    /**
     * Capability `net`. Requests never carry the user's cookies.
     * Put `{{secret:name}}` in a header or text body to use a stored credential
     * (also requires `secret`); it is only substituted for origins the user approved.
     */
    net: {
      fetch(url: string, init?: FetchInit): Promise<FetchResponse>
      fetchText(url: string, init?: FetchInit): Promise<string>
      fetchJSON<T = unknown>(url: string, init?: FetchInit): Promise<T>
    }

    /** Capability `kv`. Private to your plugin; encrypted at rest. For preferences, not credentials. */
    kv: {
      get<T = unknown>(key: string): Promise<T | null>
      /** Max 256 KB per value, JSON-serialisable. */
      set(key: string, value: unknown): Promise<void>
      remove(key: string): Promise<void>
      keys(): Promise<string[]>
    }

    /**
     * Capability `secret`. Write-only by design: there is no way to read a value back.
     *
     * @example
     * await host.secret.request('apiKey', { label: 'DeepL API Key', origins: ['https://api.deepl.com'] })
     * await host.net.fetch('https://api.deepl.com/v2/translate', {
     *   method: 'POST',
     *   headers: { Authorization: 'DeepL-Auth-Key {{secret:apiKey}}' },
     *   body: JSON.stringify({ text: ['hello'], target_lang: 'ZH' }),
     * })
     */
    secret: {
      /**
       * Asks the user to enter a credential in a host-drawn dialog. Resolves
       * `true` if one is stored (immediately, if it already exists and `force`
       * is not set).
       */
      request(name: string, options: { origins: string[]; label?: string; hint?: string; force?: boolean }): Promise<boolean>
      has(name: string): Promise<boolean>
      /** Metadata only. */
      list(): Promise<Array<{ name: string; label: string; origins: string[]; createdAt: number }>>
      remove(name: string): Promise<void>
    }

    /**
     * Capability `image`. Prefer OffscreenCanvas inside the sandbox; this is a fallback -
     * and the only way to rasterise SVG, which workers cannot decode.
     */
    image: {
      probe(id: string): Promise<{ width: number; height: number }>
      transcode(
        id: string,
        /** `width`: exact output width (height follows the aspect ratio); ideal for SVG. */
        options?: { format?: string; quality?: number; maxWidth?: number; maxHeight?: number; width?: number; background?: string },
      ): Promise<{ width: number; height: number; type: string; body: ArrayBuffer }>
      encoders(): Promise<string[]>
    }

    /** Capability `ffmpeg`. Runs locally; outputs land in the workspace, not in your heap. */
    ffmpeg: {
      /**
       * Runs FFmpeg. Refer to inputs as `$in0`, `$in1`… and outputs as `$out0`…
       * An output name containing `%04d` is an image sequence; every frame is collected.
       * Thread counts are managed for you.
       *
       * @example
       * const { files } = await ctx.host.ffmpeg.run({
       *   args: ['-i', '$in0', '-vn', '-c:a', 'libmp3lame', '$out0'],
       *   inputs: [ctx.inputs[0].id],
       *   outputs: ['audio.mp3'],
       * })
       */
      run(options: { args: string[]; inputs: string[]; outputs: string[]; label?: string }): Promise<{ files: FileRef[]; log: string[] }>
      probe(id: string): Promise<{
        durationSeconds: number | null
        width: number | null
        height: number | null
        videoCodec: string | null
        audioCodec: string | null
        log: string[]
      }>
    }

    /** Capability `onnx`. Models are downloaded once, after the user approves, and verified by SHA-256. */
    onnx: {
      load(model: ModelSpec): Promise<string>
      info(sessionId: string): Promise<{ inputs: string[]; outputs: string[] }>
      /**
       * Runs a session. Outputs named in `options.keep` stay inside the runtime and
       * come back as `{ type, dims, tensor }` handles that can be fed to later runs
       * without copying - for a decoder's KV cache, say. Free them with `dispose`.
       * `options.outputs` limits which outputs are computed and returned.
       */
      run(sessionId: string, feeds: Record<string, Tensor | TensorHandle>, options?: { keep?: string[]; outputs?: string[] }): Promise<Record<string, Tensor | TensorHandle>>
      /** Frees tensors kept by `run`. Handles of other plugins are ignored. */
      dispose(tensors: string[]): Promise<void>
      release(sessionId: string): Promise<void>
    }
  }

  interface FetchInit {
    method?: string
    headers?: Record<string, string>
    body?: string | Uint8Array | ArrayBuffer
  }

  interface FetchResponse {
    status: number
    ok: boolean
    headers: Record<string, string>
    body: Uint8Array
  }

  interface ModelSpec {
    id: string
    name: string
    url: string
    /** Lowercase hex SHA-256 of the model file. Required. */
    sha256: string
    /** Approximate size, shown in the approval dialog. */
    bytes: number
    license?: string
  }

  interface TensorHandle {
    type: string
    dims: number[]
    /** Opaque id of a tensor kept in the runtime. */
    tensor: string
  }

  interface Tensor {
    /** e.g. `float32`, `int64`, `uint8`. */
    type: string
    dims: number[]
    data: Float32Array | Int32Array | BigInt64Array | Uint8Array | Float64Array
  }
}
