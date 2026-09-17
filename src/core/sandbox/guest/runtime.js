/* eslint-disable */
/**
 * Guest runtime - runs INSIDE the sandbox (null origin).
 *
 * This file is injected as source text, never imported, so it must stay a
 * dependency-free classic script. It is used in both isolation tiers:
 *
 *   iframe-worker : evaluated inside a Worker spawned by the sandbox frame.
 *   iframe        : evaluated on the sandbox frame's own thread as a fallback.
 *
 * The only difference is the `send` function handed to `__OMNI_GUEST__`, so the
 * plugin-visible API is identical in both tiers.
 *
 * Trust model: everything here is reachable by untrusted plugin code. Nothing in
 * this file is a security control - it is ergonomics. The real boundaries are
 * the opaque origin, the sandbox CSP, and host-side capability checks.
 */
self.__OMNI_GUEST__ = function (send) {
  'use strict'

  /** Pending host calls, keyed by call id. */
  var calls = new Map()
  var callSeq = 0
  /** In-flight tool invocations, keyed by invocation id. */
  var invocations = new Map()
  /** The registered plugin: { manifest, runners: Map<toolId, fn> }. */
  var plugin = null
  var booted = false

  /* ---------------------------------------------------------------------- */
  /* RPC into the host                                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * `inv` tags the call with the invocation that made it, so the host can route
   * ffmpeg/model-download progress to the right task row and hand the call the
   * right AbortSignal. Calls made at module scope carry no invocation.
   */
  function rpc(method, args, transfer, inv) {
    var id = 'c' + ++callSeq
    return new Promise(function (resolve, reject) {
      calls.set(id, { resolve: resolve, reject: reject })
      try {
        send({ t: 'call', id: id, method: method, args: args, inv: inv || null }, transfer)
      } catch (err) {
        calls.delete(id)
        reject(err)
      }
    })
  }

  function settle(msg) {
    var pending = calls.get(msg.id)
    if (!pending) return
    calls.delete(msg.id)
    if (msg.ok) pending.resolve(msg.value)
    else pending.reject(new Error(msg.error))
  }

  /* ---------------------------------------------------------------------- */
  /* Host facade                                                             */
  /* ---------------------------------------------------------------------- */

  function toBytes(data) {
    if (data instanceof Uint8Array) return data
    if (data instanceof ArrayBuffer) return new Uint8Array(data)
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    if (typeof data === 'string') return new TextEncoder().encode(data)
    throw new TypeError('期望 Uint8Array / ArrayBuffer / string')
  }

  /**
   * Builds the `host` facade. `invoke` is the only thing that differs between
   * the module-scope `host` global and the per-invocation `ctx.host`, so the
   * surface is defined exactly once.
   */
  function createHost(inv) {
    function call(method, args, transfer) {
      return rpc(method, args, transfer, inv)
    }

    var host = {
      /** Capability: fs */
      fs: {
        /** Reads a byte range. `length < 0` reads to the end of the file. */
        read: function (id, offset, length) {
          return call('fs.read', [id, offset || 0, length === undefined ? -1 : length]).then(function (buf) {
            return new Uint8Array(buf)
          })
        },
        readAll: function (id) {
          return host.fs.read(id, 0, -1)
        },
        readText: function (id) {
          return host.fs.readAll(id).then(function (bytes) {
            return new TextDecoder().decode(bytes)
          })
        },
        readJSON: function (id) {
          return host.fs.readText(id).then(JSON.parse)
        },
        /** Creates an empty output file and opens it for writing. */
        create: function (name, type) {
          return call('fs.create', [name, type || ''])
        },
        /** Appends a chunk. The data is copied; the caller keeps ownership. */
        write: function (id, data) {
          var bytes = toBytes(data)
          return call('fs.write', [id, bytes])
        },
        /**
         * Appends a chunk by transferring its buffer - faster for large writes,
         * but `data` becomes detached and unusable afterwards.
         */
        writeTransfer: function (id, data) {
          var bytes = toBytes(data)
          return call('fs.write', [id, bytes], [bytes.buffer])
        },
        /** Finalises an output file and resolves to its FileRef. */
        close: function (id) {
          return call('fs.close', [id])
        },
        /**
         * Deletes a file this plugin created. Use it for intermediates you do
         * not want to hand back to the user. Inputs cannot be deleted.
         */
        remove: function (id) {
          return call('fs.remove', [id])
        },
        /**
         * Lowercase hex digest of a file. `algorithm` is one of SHA-1, SHA-256
         * (default), SHA-384, SHA-512.
         *
         * Needed because `crypto.subtle` does not exist in here: the sandbox is
         * an opaque origin, which is not a secure context.
         */
        digest: function (id, algorithm) {
          return call('fs.digest', [id, algorithm || 'SHA-256'])
        },
        /** create + write + close in one call. Resolves to the FileRef. */
        writeAll: function (name, data, type) {
          return host.fs.create(name, type).then(function (ref) {
            return host.fs.writeTransfer(ref.id, toBytes(data).slice()).then(function () {
              return host.fs.close(ref.id)
            })
          })
        },
        /** Blob for an input file, for APIs that want one (createImageBitmap). */
        blob: function (id, type) {
          return host.fs.readAll(id).then(function (bytes) {
            return new Blob([bytes], { type: type || '' })
          })
        },
      },

      /** Capability: ui */
      ui: {
        notify: function (message, level) {
          return call('ui.notify', [String(message), level || 'info'])
        },
      },

      /** Capability: net - the only way out of the sandbox. */
      net: {
        /** Resolves to { status, ok, headers, body: Uint8Array }. */
        fetch: function (url, init) {
          return call('net.fetch', [String(url), init || {}]).then(function (res) {
            res.body = new Uint8Array(res.body)
            return res
          })
        },
        fetchText: function (url, init) {
          return host.net.fetch(url, init).then(function (res) {
            return new TextDecoder().decode(res.body)
          })
        },
        fetchJSON: function (url, init) {
          return host.net.fetchText(url, init).then(JSON.parse)
        },
      },

      /** Capability: kv - a private namespace per plugin. */
      kv: {
        get: function (key) {
          return call('kv.get', [String(key)])
        },
        set: function (key, value) {
          return call('kv.set', [String(key), value])
        },
        remove: function (key) {
          return call('kv.remove', [String(key)])
        },
        keys: function () {
          return call('kv.keys', [])
        },
      },

      /** Capability: image - host-side Canvas decode/encode. */
      image: {
        /** Resolves to { width, height } without decoding pixels into the guest. */
        probe: function (id) {
          return call('image.probe', [id])
        },
        /**
         * Decodes, optionally resizes and re-encodes on the host. Also decodes SVG,
         * which no worker can.
         * opts: { format, quality, maxWidth, maxHeight, width, background }
         */
        transcode: function (id, opts) {
          return call('image.transcode', [id, opts || {}])
        },
        /** Which output mime types this browser can actually encode. */
        encoders: function () {
          return call('image.encoders', [])
        },
      },

      /** Capability: secret - write-only; there is no way to read a value back. */
      secret: {
        /**
         * Asks the user to enter a credential. `options.origins` is mandatory and
         * is the exact set of origins the value may later be sent to.
         * Resolves true if the user saved one.
         */
        request: function (name, options) {
          return call('secret.request', [name, options || {}])
        },
        has: function (name) {
          return call('secret.has', [name])
        },
        /** Metadata for this plugin's credentials. Never includes values. */
        list: function () {
          return call('secret.list', [])
        },
        remove: function (name) {
          return call('secret.remove', [name])
        },
      },

      /** Capability: ffmpeg - full argv against a local FFmpeg (WASM) build. */
      ffmpeg: {
        /**
         * options: { args, inputs, outputs, label }
         * `args` uses $in0/$in1 for inputs and $out0/$out1 for outputs.
         * Resolves to { files: FileRef[], log: string[] }; outputs are already in
         * the workspace, so large results never cross into the sandbox.
         */
        run: function (options) {
          return call('ffmpeg.run', [options || {}])
        },
        /** Resolves to { durationSeconds, width, height, videoCodec, audioCodec, log }. */
        probe: function (id) {
          return call('ffmpeg.probe', [id])
        },
      },

      /** Capability: onnx - local model inference. */
      onnx: {
        /**
         * spec: { id, name, url, sha256, bytes, license }
         * Downloads and caches on first use, after the user approves. Resolves to
         * a session id.
         */
        load: function (spec) {
          return call('onnx.load', [spec])
        },
        /** Resolves to { inputs: string[], outputs: string[] }. */
        info: function (sessionId) {
          return call('onnx.info', [sessionId])
        },
        /**
         * feeds: { name: { type, dims, data } } where data is a TypedArray, or
         * { tensor } - a handle from an earlier run.
         * options.keep: output names to keep in the runtime; those resolve to
         * { type, dims, tensor } instead of carrying data. Free with dispose().
         * options.outputs: compute only these outputs (default: all).
         */
        run: function (sessionId, feeds, options) {
          return call('onnx.run', [sessionId, feeds, options || {}])
        },
        /** Frees tensors kept by run({ keep }). */
        dispose: function (tensors) {
          return call('onnx.dispose', [tensors || []])
        },
        release: function (sessionId) {
          return call('onnx.release', [sessionId])
        },
      },
    }

    return host
  }

  /** Module-scope facade, for plugin code that runs outside an invocation. */
  var host = createHost(null)

  /* ---------------------------------------------------------------------- */
  /* Environment hardening                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * The sandbox CSP (`connect-src 'none'`) already blocks these. Replacing them
   * with throwing stubs turns a silent CSP violation into an actionable error
   * that names the supported route.
   */
  function denyNetwork() {
    var blocked = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'sendBeacon']
    blocked.forEach(function (name) {
      if (!(name in self)) return
      try {
        Object.defineProperty(self, name, {
          configurable: false,
          writable: false,
          value: function () {
            throw new Error(
              '沙盒内禁止直接发起网络请求（' + name + '）。请声明 net 能力并使用 host.net.fetch()。',
            )
          },
        })
      } catch (_) {
        /* already non-configurable in this tier */
      }
    })
  }

  function forwardConsole() {
    var levels = ['log', 'warn', 'error']
    levels.forEach(function (level) {
      var original = console[level] ? console[level].bind(console) : function () {}
      console[level] = function () {
        var args = []
        for (var i = 0; i < arguments.length; i++) args.push(stringify(arguments[i]))
        try {
          send({ t: 'log', level: level, args: args })
        } catch (_) {}
        original.apply(null, arguments)
      }
    })
  }

  function stringify(value) {
    if (typeof value === 'string') return value
    if (value instanceof Error) return value.name + ': ' + value.message
    try {
      return JSON.stringify(value)
    } catch (_) {
      return String(value)
    }
  }

  function errorText(err) {
    if (!err) return '未知错误'
    if (err instanceof Error) return err.message || String(err)
    return stringify(err)
  }

  /* ---------------------------------------------------------------------- */
  /* Manifest validation                                                     */
  /* ---------------------------------------------------------------------- */

  // Must match CAPABILITIES / ToolCategory in src/core/types.ts (tests/runtime-manifest.test.ts checks).
  var API_VERSION = 2
  var VALID_CAPABILITIES = ['fs', 'ui', 'net', 'kv', 'secret', 'image', 'ffmpeg', 'onnx']
  var VALID_CATEGORIES = ['pdf', 'media', 'image', 'document', 'ai', 'archive', 'other']
  var ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/i

  function assert(condition, message) {
    if (!condition) throw new Error(message)
  }

  /**
   * Splits an author-supplied definition into a structured-cloneable manifest
   * and a map of `run` functions that never leave the sandbox.
   */
  function normalize(definition) {
    assert(definition && typeof definition === 'object', 'definePlugin() 需要一个对象参数')
    assert(ID_RE.test(String(definition.id || '')), 'plugin.id 必须匹配 ' + ID_RE)
    assert(definition.name, 'plugin.name 不能为空')

    var caps = (definition.capabilities || []).map(String)
    caps.forEach(function (c) {
      assert(VALID_CAPABILITIES.indexOf(c) !== -1, '未知能力：' + c)
    })

    var deps = (definition.deps || []).map(function (d) {
      assert(d && d.url, 'deps[].url 不能为空')
      var assets
      if (d.assets && typeof d.assets === 'object') {
        assets = {}
        Object.keys(d.assets).forEach(function (name) {
          var asset = d.assets[name]
          // A bare string is shorthand for `{ url }`.
          var url = typeof asset === 'string' ? asset : asset && asset.url
          assert(url, 'deps[].assets.' + name + ' 缺少 url')
          assets[name] = { url: String(url) }
          if (asset && asset.integrity) assets[name].integrity = String(asset.integrity)
        })
      }
      var out = { id: String(d.id || d.url), url: String(d.url) }
      if (d.global) out.global = String(d.global)
      if (d.integrity) out.integrity = String(d.integrity)
      if (d.lazy) out.lazy = true
      if (assets) out.assets = assets
      return out
    })

    assert(Array.isArray(definition.tools) && definition.tools.length > 0, 'plugin.tools 至少需要一个工具')

    var runners = new Map()
    var setups = new Map()
    var tools = definition.tools.map(function (tool) {
      assert(ID_RE.test(String(tool.id || '')), 'tool.id 必须匹配 ' + ID_RE + '（收到 ' + tool.id + '）')
      assert(tool.name, 'tool.name 不能为空：' + tool.id)
      assert(typeof tool.run === 'function', 'tool.run 必须是函数：' + tool.id)
      assert(tool.setup === undefined || typeof tool.setup === 'function', 'tool.setup 必须是函数：' + tool.id)
      if (typeof tool.setup === 'function') setups.set(tool.id, tool.setup)
      assert(VALID_CATEGORIES.indexOf(String(tool.category)) !== -1, '未知分类：' + tool.category)
      assert(!runners.has(tool.id), '工具 id 重复：' + tool.id)
      runners.set(tool.id, tool.run)
      return {
        id: String(tool.id),
        name: String(tool.name),
        description: tool.description ? String(tool.description) : undefined,
        category: String(tool.category),
        icon: tool.icon ? String(tool.icon) : undefined,
        accept: Array.isArray(tool.accept) ? tool.accept.map(String) : undefined,
        multiple: !!tool.multiple,
        minFiles: typeof tool.minFiles === 'number' ? tool.minFiles : tool.input === 'none' ? 0 : 1,
        hasSetup: typeof tool.setup === 'function',
        input: ['files', 'text', 'both', 'none'].indexOf(tool.input) !== -1 ? tool.input : 'files',
        textFileName: tool.textFileName ? String(tool.textFileName) : undefined,
        params: normalizeParams(tool.params),
        keywords: Array.isArray(tool.keywords) ? tool.keywords.map(String) : undefined,
      }
    })

    var manifest = {
      id: String(definition.id),
      name: String(definition.name),
      version: String(definition.version || '0.0.0'),
      description: definition.description ? String(definition.description) : undefined,
      author: definition.author ? String(definition.author) : undefined,
      homepage: definition.homepage ? String(definition.homepage) : undefined,
      icon: definition.icon ? String(definition.icon) : undefined,
      apiVersion: API_VERSION,
      capabilities: caps,
      deps: deps.length ? deps : undefined,
      tools: tools,
    }
    return { manifest: manifest, runners: runners, setups: setups }
  }

  var PARAM_TYPES = ['text', 'textarea', 'number', 'slider', 'switch', 'select']

  function normalizeParams(params) {
    if (!Array.isArray(params)) return undefined
    return params.map(function (p) {
      assert(p && p.key, 'param.key 不能为空')
      assert(PARAM_TYPES.indexOf(String(p.type)) !== -1, '未知参数类型：' + p.type)
      var out = { key: String(p.key), label: String(p.label || p.key), type: String(p.type) }
      if (p.hint) out.hint = String(p.hint)
      if (p.placeholder) out.placeholder = String(p.placeholder)
      if (p.suffix) out.suffix = String(p.suffix)
      if (p.rows) out.rows = Number(p.rows)
      if (p.default !== undefined) out.default = p.default
      if (typeof p.min === 'number') out.min = p.min
      if (typeof p.max === 'number') out.max = p.max
      if (typeof p.step === 'number') out.step = p.step
      if (p.when && p.when.key) out.when = { key: String(p.when.key), equals: p.when.equals }
      if (p.type === 'select') {
        assert(Array.isArray(p.options) && p.options.length, 'select 参数需要 options：' + p.key)
        out.options = p.options.map(function (o) {
          return { value: String(o.value), label: String(o.label === undefined ? o.value : o.label) }
        })
      }
      if (p.type === 'slider') {
        assert(typeof p.min === 'number' && typeof p.max === 'number', 'slider 参数需要 min/max：' + p.key)
      }
      return out
    })
  }

  /* ---------------------------------------------------------------------- */
  /* Dependencies                                                            */
  /* ---------------------------------------------------------------------- */

  /** Loaded dependencies by id: `{ exports, assets }`, or a pending promise. */
  var dependencies = new Map()

  function evaluateDependency(dep) {
    try {
      ;(0, eval)(dep.code)
    } catch (err) {
      throw new Error('依赖 ' + dep.id + ' 加载失败：' + errorText(err))
    }
    // Indirect eval of strict-mode code keeps top-level `var`s local, so an
    // IIFE bundle starting with "use strict" silently defines nothing.
    if (dep.global && !(dep.global in globalThis)) {
      throw new Error(
        '依赖 ' + dep.id + ' 执行后没有定义全局变量 ' + dep.global +
          '。若该文件以 "use strict" 开头，请在末尾显式赋值：globalThis.' + dep.global + ' = ' + dep.global,
      )
    }
    var loaded = { exports: dep.global ? globalThis[dep.global] : undefined, assets: dep.assets || {} }
    dependencies.set(dep.id, loaded)
    return loaded
  }

  /**
   * Loads a dependency declared with `lazy: true` (or returns an eager one).
   * Resolves to `{ exports, assets }`: the global the script defined, and its
   * binary assets as ArrayBuffers - e.g. a WebAssembly module to instantiate.
   * Concurrent calls share one load.
   */
  function loadDependency(id) {
    var known = dependencies.get(id)
    if (known) return Promise.resolve(known)
    var pending = rpc('deps.load', [String(id)], [], null).then(function (dep) {
      return evaluateDependency({ id: String(id), code: dep.code, global: dep.global, assets: dep.assets })
    })
    // A failed load must not stick: the next call retries.
    dependencies.set(id, pending)
    pending.catch(function () {
      if (dependencies.get(id) === pending) dependencies.delete(id)
    })
    return pending
  }

  /* ---------------------------------------------------------------------- */
  /* Boot                                                                    */
  /* ---------------------------------------------------------------------- */

  function boot(msg) {
    var registered = null
    self.definePlugin = function (definition) {
      if (registered) throw new Error('definePlugin() 只能调用一次')
      registered = normalize(definition)
      return registered.manifest
    }
    self.host = host
    self.loadDependency = loadDependency

    try {
      // Eager dependencies first, so the plugin body can reference their globals.
      for (var i = 0; i < msg.deps.length; i++) evaluateDependency(msg.deps[i])
      ;(0, eval)(msg.code)
      if (!registered) throw new Error('插件代码没有调用 definePlugin()')
      assert(
        registered.manifest.id === msg.pluginId || !msg.pluginId,
        '插件 id 与安装记录不一致：期望 ' + msg.pluginId + '，实际 ' + registered.manifest.id,
      )
      plugin = registered
      booted = true
      send({ t: 'registered', nonce: msg.nonce, manifest: registered.manifest })
    } catch (err) {
      send({ t: 'boot-error', nonce: msg.nonce, error: errorText(err) })
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Invocation                                                              */
  /* ---------------------------------------------------------------------- */

  function invoke(msg) {
    if (!booted || !plugin) {
      send({ t: 'fail', id: msg.id, error: '插件尚未就绪' })
      return
    }
    var run = plugin.runners.get(msg.toolId)
    if (!run) {
      send({ t: 'fail', id: msg.id, error: '未知工具：' + msg.toolId })
      return
    }

    var controller = new AbortController()
    invocations.set(msg.id, controller)

    var lastSent = 0
    var ctx = {
      toolId: msg.toolId,
      inputs: msg.inputs,
      params: msg.params,
      signal: controller.signal,
      // Calls made through ctx.host are tagged with this invocation, so ffmpeg
      // and model-download progress reach this task's row rather than a guess.
      host: createHost(msg.id),
      /**
       * Reports progress. `value` is 0..1, or null for an indeterminate spinner.
       * Throttled to ~20 messages/second so a tight loop cannot flood the host.
       */
      progress: function (value, label) {
        var now = Date.now()
        var terminal = value === null || value >= 1
        if (!terminal && now - lastSent < 50) return
        lastSent = now
        send({
          t: 'progress',
          id: msg.id,
          value: value === null || value === undefined ? null : Math.max(0, Math.min(1, Number(value))),
          label: label ? String(label) : undefined,
        })
      },
      /** Throws if the user cancelled. Call it between expensive steps. */
      throwIfAborted: function () {
        if (controller.signal.aborted) throw new Error('已取消')
      },
    }

    Promise.resolve()
      .then(function () {
        return run(ctx)
      })
      .then(function (result) {
        if (controller.signal.aborted) throw new Error('已取消')
        send({ t: 'done', id: msg.id, value: normalizeResult(result) })
      })
      .catch(function (err) {
        send({ t: 'fail', id: msg.id, error: errorText(err) })
      })
      .then(function () {
        invocations.delete(msg.id)
      })
  }

  function normalizeResult(result) {
    if (!result) return { outputs: [] }
    if (Array.isArray(result)) return { outputs: result.map(refId) }
    var outputs = Array.isArray(result.outputs) ? result.outputs.map(refId) : []
    return { outputs: outputs, summary: result.summary ? String(result.summary) : undefined }
  }

  /** Accepts either a FileRef or a bare id, so both styles read naturally. */
  function refId(value) {
    return String(value && typeof value === 'object' ? value.id : value)
  }

  /* ---------------------------------------------------------------------- */
  /* UI sessions                                                             */
  /* ---------------------------------------------------------------------- */

  /** Open panels, keyed by session id. */
  var uiSessions = new Map()

  /**
   * The object a tool's `setup(ui)` receives.
   *
   * A plugin describes its panel with `ui.render(tree)` and reacts through
   * `ui.on('change' | 'action' | 'pointer' | 'canvas', fn)`. Bound values live in
   * `ui.state`, which the host also merges into `ctx.params` when the tool
   * runs - so `run` needs no knowledge of the panel at all.
   */
  function createUi(msg) {
    var listeners = { change: [], action: [], pointer: [], canvas: [] }
    var canvases = new Map()
    var canvasWaiters = new Map()

    var ui = {
      toolId: msg.toolId,
      inputs: msg.inputs,
      state: msg.state || {},
      host: createHost(null),

      /** Replaces the panel. `panel` is { nodes, state?, runLabel?, runDisabled? }. */
      render: function (panel) {
        if (panel && panel.state) Object.assign(ui.state, panel.state)
        send({ t: 'ui-render', id: msg.id, panel: panel })
      },

      /** Updates bound values without resending the tree. */
      setState: function (patch) {
        Object.assign(ui.state, patch || {})
        send({ t: 'ui-state', id: msg.id, patch: patch || {} })
      },

      on: function (kind, fn) {
        if (!listeners[kind]) throw new Error('未知的 UI 事件：' + kind)
        listeners[kind].push(fn)
        return function off() {
          var index = listeners[kind].indexOf(fn)
          if (index !== -1) listeners[kind].splice(index, 1)
        }
      },

      /**
       * Resolves to the OffscreenCanvas behind a rendered `canvas` node. It
       * arrives once the host has laid the node out, so await it after render.
       */
      canvas: function (canvasId) {
        if (canvases.has(canvasId)) return Promise.resolve(canvases.get(canvasId))
        return new Promise(function (resolve) {
          var waiting = canvasWaiters.get(canvasId) || []
          waiting.push(resolve)
          canvasWaiters.set(canvasId, waiting)
        })
      },
    }

    return {
      ui: ui,
      dispatch: function (event) {
        ui.state = event.state || ui.state
        var list = listeners[event.kind] || []
        for (var i = 0; i < list.length; i++) {
          try {
            var result = list[i](event.name, event.value, ui.state)
            if (result && typeof result.catch === 'function') {
              result.catch(function (err) {
                send({ t: 'ui-error', id: msg.id, error: errorText(err) })
              })
            }
          } catch (err) {
            send({ t: 'ui-error', id: msg.id, error: errorText(err) })
          }
        }
      },
      attachCanvas: function (event) {
        canvases.set(event.canvasId, event.canvas)
        var waiting = canvasWaiters.get(event.canvasId) || []
        canvasWaiters.delete(event.canvasId)
        for (var i = 0; i < waiting.length; i++) waiting[i](event.canvas)
        // A canvas node that is re-mounted (e.g. shown again by `when`) arrives as a
        // fresh surface; listeners repaint it.
        var list = listeners.canvas
        for (var j = 0; j < list.length; j++) {
          try {
            var result = list[j](event.canvasId, event.canvas, ui.state)
            if (result && typeof result.catch === 'function') {
              result.catch(function (err) {
                send({ t: 'ui-error', id: msg.id, error: errorText(err) })
              })
            }
          } catch (err) {
            send({ t: 'ui-error', id: msg.id, error: errorText(err) })
          }
        }
      },
    }
  }

  function openUi(msg) {
    if (!booted || !plugin) {
      send({ t: 'ui-error', id: msg.id, error: '插件尚未就绪' })
      return
    }
    var setup = plugin.setups.get(msg.toolId)
    if (!setup) {
      send({ t: 'ui-error', id: msg.id, error: '该工具没有定义 setup()' })
      return
    }
    var session = createUi(msg)
    uiSessions.set(msg.id, session)

    Promise.resolve()
      .then(function () {
        return setup(session.ui)
      })
      .then(function () {
        send({ t: 'ui-ready', id: msg.id })
      })
      .catch(function (err) {
        send({ t: 'ui-error', id: msg.id, error: errorText(err) })
      })
  }

  /* ---------------------------------------------------------------------- */
  /* Message pump                                                            */
  /* ---------------------------------------------------------------------- */

  denyNetwork()
  forwardConsole()

  return function handle(msg) {
    if (!msg || typeof msg !== 'object') return
    switch (msg.t) {
      case 'init':
        boot(msg)
        break
      case 'invoke':
        invoke(msg)
        break
      case 'reply':
        settle(msg)
        break
      case 'abort': {
        var controller = invocations.get(msg.id)
        if (controller) controller.abort()
        break
      }
      case 'ui-open':
        openUi(msg)
        break
      case 'ui-event': {
        var target = uiSessions.get(msg.id)
        if (target) target.dispatch(msg)
        break
      }
      case 'ui-canvas': {
        var owner = uiSessions.get(msg.id)
        if (owner) owner.attachCanvas(msg)
        break
      }
      case 'ui-close':
        uiSessions.delete(msg.id)
        break
    }
  }
}
