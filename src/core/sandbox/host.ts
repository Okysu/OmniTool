/**
 * Host side of the plugin sandbox.
 *
 * One `SandboxHost` owns one hidden, null-origin iframe running one plugin.
 * Nothing crosses the boundary except structured-cloneable protocol messages
 * defined in `@/core/types`.
 *
 * Layers of containment, outermost first:
 *   1. `sandbox="allow-scripts"` without `allow-same-origin` - the frame gets an
 *      opaque origin, so it cannot reach our DOM, cookies, localStorage,
 *      IndexedDB or OPFS even if it wanted to.
 *   2. A frame CSP of `default-src 'none'; connect-src 'none'` - no network, no
 *      subresources, no nested frames. `host.net.fetch` is the only way out.
 *   3. Capability grants checked in `@/core/capabilities` on every single call.
 *   4. File confinement: a plugin can read only the inputs of its currently
 *      running invocations plus the outputs it created itself.
 */
import frameSourceRaw from './guest/frame.js?raw'
import runtimeSourceRaw from './guest/runtime.js?raw'
import { dispatch, type CapabilityContext } from '@/core/capabilities'
import { releasePluginSessions } from '@/core/capabilities/onnx'
import { sandboxState } from './state'
import { nanoid } from '@/lib/id'
import type {
  Capability,
  FileRef,
  GuestToHost,
  HostToGuest,
  InvokeResult,
  IsolationMode,
  ParamValues,
  PluginDep,
  PluginManifest,
} from '@/core/types'

const BOOT_TIMEOUT_MS = 15_000

export interface SandboxOptions {
  pluginId: string
  pluginName: string
  /** Built-in plugins; skips the private-network guard, nothing else. */
  trusted: boolean
  grants: ReadonlySet<Capability>
  onLog?: (level: 'log' | 'warn' | 'error', args: string[]) => void
  /**
   * Dependencies the plugin may load on demand: the list from the *installed
   * record*, which the user reviewed. Never the manifest the sandbox reports at
   * boot - plugin code runs before that report and could forge it, turning
   * `loadDependency` into an unrestricted fetch.
   */
  dependencies?: readonly PluginDep[]
  /**
   * Fetches one declared dependency for `loadDependency()`. Injected rather than
   * imported because the loader itself depends on this module.
   */
  resolveDependency?: (dep: PluginDep) => Promise<{ code: string; global?: string; assets: Record<string, ArrayBuffer> }>
}

export type BootDep = { id: string; code: string; global?: string; assets?: Record<string, ArrayBuffer> }

/** Callbacks a UI session reports into. */
export interface UiSessionHandlers {
  onRender: (panel: unknown) => void
  onState: (patch: Record<string, unknown>) => void
  onReady: () => void
  onError: (message: string) => void
}

/** The host's handle on one open plugin panel. */
export interface UiSession {
  readonly id: string
  event: (kind: 'change' | 'action' | 'pointer', name: string, value: unknown, state: Record<string, unknown>) => void
  /** Transfers a canvas to the plugin. The host can no longer draw on it afterwards. */
  attachCanvas: (canvasId: string, canvas: OffscreenCanvas, width: number, height: number) => void
  close: () => void
}

export interface InvokeOptions {
  onProgress?: (value: number | null, label?: string) => void
  signal?: AbortSignal
}

interface PendingInvocation {
  resolve: (result: InvokeResult) => void
  reject: (error: Error) => void
  onProgress?: (value: number | null, label?: string) => void
  /** Cancels host-side work (ffmpeg, a model download) started by this call. */
  signal?: AbortSignal
  detach: () => void
}

export class SandboxHost {
  readonly pluginId: string
  private readonly options: SandboxOptions
  private readonly nonce = nanoid(12)

  private frame: HTMLIFrameElement | null = null
  private manifest: PluginManifest | null = null
  private isolation: IsolationMode | null = null
  private disposed = false

  private readyResolve: ((mode: IsolationMode) => void) | null = null
  private readyReject: ((error: Error) => void) | null = null
  private bootResolve: ((manifest: PluginManifest) => void) | null = null
  private bootReject: ((error: Error) => void) | null = null

  private readonly invocations = new Map<string, PendingInvocation>()
  private readonly uiSessions = new Map<string, UiSessionHandlers>()

  /** Reference-counted inputs of the invocations currently in flight. */
  private readonly inputRefs = new Map<string, number>()
  private readonly allowedInputs = new Set<string>()
  private readonly ownedOutputs = new Set<string>()

  private readonly onMessage = (event: MessageEvent) => this.receive(event)

  constructor(options: SandboxOptions) {
    this.options = options
    this.pluginId = options.pluginId
  }

  get isolationMode(): IsolationMode | null {
    return this.isolation
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Creates the frame, injects `deps` then `code`, and resolves with the
   * manifest the plugin registered.
   */
  async boot(code: string, deps: BootDep[] = []): Promise<PluginManifest> {
    if (this.frame) throw new Error('沙盒已启动')

    const frame = document.createElement('iframe')
    // No `allow-same-origin`: this is what makes the origin opaque.
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.setAttribute('aria-hidden', 'true')
    frame.setAttribute('title', `plugin sandbox: ${this.options.pluginId}`)
    frame.style.cssText =
      'position:absolute;width:0;height:0;border:0;opacity:0;pointer-events:none;left:-9999px;top:-9999px'
    frame.srcdoc = buildFrameDocument(this.nonce)

    window.addEventListener('message', this.onMessage)
    this.frame = frame

    const ready = new Promise<IsolationMode>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    const registered = new Promise<PluginManifest>((resolve, reject) => {
      this.bootResolve = resolve
      this.bootReject = reject
    })

    document.body.append(frame)

    const timer = setTimeout(() => {
      const error = new Error('沙盒启动超时')
      this.readyReject?.(error)
      this.bootReject?.(error)
    }, BOOT_TIMEOUT_MS)

    try {
      this.isolation = await ready
      const buffers = deps.flatMap((dep) => Object.values(dep.assets ?? {}))
      this.send({ t: 'init', nonce: this.nonce, pluginId: this.options.pluginId, code, deps }, buffers)
      this.manifest = await registered
      return this.manifest
    } catch (error) {
      this.dispose()
      throw error
    } finally {
      clearTimeout(timer)
      this.readyResolve = this.readyReject = null
      this.bootResolve = this.bootReject = null
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    window.removeEventListener('message', this.onMessage)
    for (const pending of this.invocations.values()) {
      pending.detach()
      pending.reject(new Error('插件已卸载'))
    }
    this.invocations.clear()
    this.uiSessions.clear()
    // Inference sessions live on the host, so disposing the frame is not enough
    // to free the model weights they pin.
    releasePluginSessions(this.options.pluginId)
    this.frame?.remove()
    this.frame = null
  }

  /* ------------------------------------------------------------------ */
  /* Invocation                                                         */
  /* ------------------------------------------------------------------ */

  invoke(toolId: string, inputs: FileRef[], params: ParamValues, options: InvokeOptions = {}): Promise<InvokeResult> {
    if (this.disposed || !this.frame) return Promise.reject(new Error('沙盒未就绪'))
    const id = nanoid(10)

    // Callers hand us reactive proxies and whatever a form produced. Neither is
    // structured-cloneable, and neither is something the guest should see the
    // shape of, so rebuild both as plain values at the boundary.
    const safeInputs = inputs.map(toPlainRef)
    const safeParams = toPlainParams(params)

    for (const input of safeInputs) this.retainInput(input.id)

    return new Promise<InvokeResult>((resolve, reject) => {
      const onAbort = () => this.send({ t: 'abort', id })
      options.signal?.addEventListener('abort', onAbort, { once: true })

      const detach = () => {
        options.signal?.removeEventListener('abort', onAbort)
        for (const input of safeInputs) this.releaseInput(input.id)
      }

      this.invocations.set(id, {
        resolve,
        reject,
        onProgress: options.onProgress,
        signal: options.signal,
        detach,
      })
      this.send({ t: 'invoke', id, toolId: String(toolId), inputs: safeInputs, params: safeParams })
    })
  }

  /**
   * Opens a panel session for a tool that declares `setup`.
   *
   * The session's inputs count as readable for as long as it is open, so the
   * plugin can preview or probe the files the user just dropped before any run
   * starts. They are released on `close`.
   */
  openUi(toolId: string, inputs: FileRef[], state: Record<string, unknown>, handlers: UiSessionHandlers): UiSession {
    const id = `ui-${nanoid(8)}`
    const safeInputs = inputs.map(toPlainRef)
    for (const input of safeInputs) this.retainInput(input.id)
    this.uiSessions.set(id, handlers)

    let closed = false
    this.send({ t: 'ui-open', id, toolId: String(toolId), inputs: safeInputs, state: plainState(state) })

    return {
      id,
      event: (kind, name, value, current) => {
        if (closed) return
        this.send({ t: 'ui-event', id, kind, name: String(name), value: plainValue(value), state: plainState(current) })
      },
      attachCanvas: (canvasId, canvas, width, height) => {
        if (closed) return
        this.send({ t: 'ui-canvas', id, canvasId, canvas, width, height }, [canvas])
      },
      close: () => {
        if (closed) return
        closed = true
        this.uiSessions.delete(id)
        for (const input of safeInputs) this.releaseInput(input.id)
        this.send({ t: 'ui-close', id })
      },
    }
  }

  private retainInput(id: string): void {
    this.inputRefs.set(id, (this.inputRefs.get(id) ?? 0) + 1)
    this.allowedInputs.add(id)
  }

  private releaseInput(id: string): void {
    const next = (this.inputRefs.get(id) ?? 1) - 1
    if (next <= 0) {
      this.inputRefs.delete(id)
      this.allowedInputs.delete(id)
    } else {
      this.inputRefs.set(id, next)
    }
  }

  /* ------------------------------------------------------------------ */
  /* Transport                                                          */
  /* ------------------------------------------------------------------ */

  private send(message: HostToGuest, transfer: Transferable[] = []): void {
    // The frame has an opaque origin, so '*' is the only valid target origin.
    // Confidentiality comes from holding the exact `contentWindow` reference.
    this.frame?.contentWindow?.postMessage(message, '*', transfer)
  }

  private receive(event: MessageEvent): void {
    if (!this.frame || event.source !== this.frame.contentWindow) return
    const message = event.data as GuestToHost
    if (!message || typeof message !== 'object') return

    switch (message.t) {
      case 'ready':
        if (message.nonce !== this.nonce) return
        // Recorded here rather than by the caller so manifest probes - which are
        // disposed immediately - still report the tier they achieved.
        sandboxState.isolation = message.isolation
        sandboxState.bootCount += 1
        this.readyResolve?.(message.isolation)
        break

      case 'registered':
        if (message.nonce !== this.nonce) return
        this.bootResolve?.(message.manifest)
        break

      case 'boot-error':
        if (message.nonce !== this.nonce) return
        this.bootReject?.(new Error(message.error))
        break

      case 'call':
        void this.handleCall(message.id, message.method, message.args, message.inv)
        break

      case 'progress': {
        const pending = this.invocations.get(message.id)
        pending?.onProgress?.(message.value, message.label)
        break
      }

      case 'done': {
        const pending = this.invocations.get(message.id)
        if (!pending) return
        this.invocations.delete(message.id)
        pending.detach()
        pending.resolve(message.value)
        break
      }

      case 'fail': {
        const pending = this.invocations.get(message.id)
        if (!pending) return
        this.invocations.delete(message.id)
        pending.detach()
        pending.reject(new Error(message.error))
        break
      }

      case 'log':
        this.options.onLog?.(message.level, message.args)
        break

      case 'ui-render':
        this.uiSessions.get(message.id)?.onRender(message.panel)
        break
      case 'ui-state':
        this.uiSessions.get(message.id)?.onState(message.patch ?? {})
        break
      case 'ui-ready':
        this.uiSessions.get(message.id)?.onReady()
        break
      case 'ui-error':
        this.uiSessions.get(message.id)?.onError(String(message.error))
        break
    }
  }

  /**
   * Builds the context for one host call.
   *
   * Progress and cancellation are looked up from the invocation the guest tagged
   * the call with, so a 40-minute transcode reports into its own task row and
   * stops when that row is cancelled - not when some other invocation is.
   */
  private capabilityContext(invocationId: string | null): CapabilityContext {
    const pending = invocationId ? this.invocations.get(invocationId) : undefined
    return {
      pluginId: this.options.pluginId,
      pluginName: this.options.pluginName,
      grants: this.options.grants,
      allowedInputs: this.allowedInputs,
      ownedOutputs: this.ownedOutputs,
      trusted: this.options.trusted,
      networkScope: this,
      onProgress: pending?.onProgress ? (ratio, label) => pending.onProgress?.(ratio, label) : undefined,
      signal: pending?.signal,
    }
  }

  /**
   * Serves a lazy dependency. Only ids in the installed record's manifest are
   * loadable - the list the user reviewed - so the call needs no capability: it
   * reaches nothing a boot-time dependency could not.
   */
  private async loadDependency(depId: string): Promise<{ code: string; global?: string; assets: Record<string, ArrayBuffer> }> {
    const dep = this.options.dependencies?.find((d) => d.id === depId)
    if (!dep) throw new Error(`依赖 ${depId} 未在插件清单的 deps 中声明`)
    if (!this.options.resolveDependency) throw new Error('当前环境不支持按需加载依赖')
    const { code, global, assets } = await this.options.resolveDependency(dep)
    return { code, global, assets }
  }

  private async handleCall(
    id: string,
    method: string,
    args: unknown[],
    invocationId: string | null,
  ): Promise<void> {
    try {
      if (method === 'deps.load') {
        const loaded = await this.loadDependency(String(args?.[0] ?? ''))
        this.send({ t: 'reply', id, ok: true, value: loaded }, Object.values(loaded.assets))
        return
      }
      const context = this.capabilityContext(typeof invocationId === 'string' ? invocationId : null)
      const { value, transfer } = await dispatch(context, String(method), args ?? [])
      this.send({ t: 'reply', id, ok: true, value }, transfer)
    } catch (error) {
      this.send({ t: 'reply', id, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Boundary normalisation                                                     */
/* -------------------------------------------------------------------------- */

function toPlainRef(ref: FileRef): FileRef {
  return { id: String(ref.id), name: String(ref.name), size: Number(ref.size), type: String(ref.type ?? '') }
}

/** Structured-clone-safe copy of a bound value (strings, numbers, booleans, number pairs). */
function plainValue(value: unknown): unknown {
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0))
  if (value && typeof value === 'object') {
    // Pointer events carry a flat record of numbers.
    const out: Record<string, number | string> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
      else if (typeof v === 'string') out[k] = v
    }
    return out
  }
  return null
}

function plainState(state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(state ?? {})) out[key] = plainValue(value)
  return out
}

/** Keeps only the primitive parameter values the schema can produce. */
function toPlainParams(params: ParamValues): ParamValues {
  const plain: ParamValues = {}
  for (const [key, value] of Object.entries(params ?? {})) {
    if (typeof value === 'string' || typeof value === 'boolean') plain[key] = value
    else if (typeof value === 'number') plain[key] = Number.isFinite(value) ? value : 0
    else if (Array.isArray(value)) plain[key] = value.map((v) => (Number.isFinite(Number(v)) ? Number(v) : 0)) as never
  }
  return plain
}

/* -------------------------------------------------------------------------- */
/* Frame document                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `default-src 'none'` is the important half: it removes `connect-src`,
 * `frame-src`, `img-src` and friends, so the plugin cannot exfiltrate anything
 * by any implicit channel. `'unsafe-eval'` is unavoidable - evaluating plugin
 * source is the entire point - but it buys the plugin nothing, because eval'd
 * code inherits exactly the same (empty) set of permissions.
 */
const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  'worker-src blob:',
  "connect-src 'none'",
  "img-src data: blob:",
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

function buildFrameDocument(nonce: string): string {
  // Global regexes, not string patterns: a string pattern replaces only the
  // first occurrence, which silently ships an unsubstituted placeholder if the
  // token ever appears twice. Function replacements because the runtime source
  // contains `$` sequences a string replacement would read as capture refs.
  const source = frameSourceRaw
    .replace(/__RUNTIME_SOURCE__/g, () => embed(runtimeSourceRaw))
    .replace(/__NONCE__/g, () => JSON.stringify(nonce))

  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">
<title>sandbox</title></head><body><script>${source}</script></body></html>`
}

/** JSON-encodes source for embedding in an inline script without breaking out. */
function embed(source: string): string {
  return JSON.stringify(source).replace(/<\//g, '<\\/')
}
