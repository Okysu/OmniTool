/* eslint-disable */
/**
 * Sandbox frame bootstrap - runs inside the null-origin iframe.
 *
 * Its only job is to stand up the guest runtime on a Worker and relay messages
 * between `window.parent` (the host) and that Worker.
 *
 * Spawning a Worker from a blob URL inside an opaque origin is spec-legal but
 * historically patchy across engines, so the frame probes it with a handshake
 * and silently degrades to running the runtime on its own thread. Origin
 * isolation is identical in both tiers; only threading differs, and the tier
 * that actually came up is reported to the host as `isolation`.
 *
 * The two placeholder tokens below are substituted by the host (see
 * `buildFrameDocument` in ../host.ts) before this source is embedded into the
 * frame document: one receives the guest runtime source, the other the
 * handshake nonce. Do not mention those token names anywhere else in this file.
 */
;(function () {
  'use strict'

  var RUNTIME = __RUNTIME_SOURCE__
  var NONCE = __NONCE__
  var BOOT_TIMEOUT_MS = 2000

  var worker = null
  var inlineHandle = null
  var queue = []
  var ready = false

  function toHost(msg, transfer) {
    parent.postMessage(msg, '*', transfer || [])
  }

  /* ---------------------------------------------------------------------- */
  /* Transferable discovery                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Walks a relayed message for ArrayBuffers so a file chunk crossing
   * host -> frame -> worker is moved rather than copied twice.
   * Depth-limited; our protocol never nests payloads deeper than this.
   */
  function collectTransferables(value, depth, out) {
    depth = depth || 0
    out = out || []
    if (depth > 4 || !value || typeof value !== 'object') return out
    if (value instanceof ArrayBuffer) {
      out.push(value)
      return out
    }
    // Drawing surfaces must be *moved*: an OffscreenCanvas cannot be structured
    // cloned at all, so relaying one without listing it would throw.
    if (
      (typeof OffscreenCanvas !== 'undefined' && value instanceof OffscreenCanvas) ||
      (typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap) ||
      (typeof MessagePort !== 'undefined' && value instanceof MessagePort)
    ) {
      if (out.indexOf(value) === -1) out.push(value)
      return out
    }
    if (ArrayBuffer.isView(value)) {
      if (out.indexOf(value.buffer) === -1) out.push(value.buffer)
      return out
    }
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) collectTransferables(value[i], depth + 1, out)
      return out
    }
    for (var key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) collectTransferables(value[key], depth + 1, out)
    }
    return out
  }

  /* ---------------------------------------------------------------------- */
  /* Tier 1: Worker                                                          */
  /* ---------------------------------------------------------------------- */

  var WORKER_PREAMBLE =
    '\n;(function(){' +
    'var h = self.__OMNI_GUEST__(function(m, t){ self.postMessage(m, t || []); });' +
    'self.onmessage = function(e){ h(e.data); };' +
    'self.postMessage({ t: "__boot" });' +
    '})();'

  function tryWorker(onResult) {
    var url
    try {
      var blob = new Blob([RUNTIME, WORKER_PREAMBLE], { type: 'text/javascript' })
      url = URL.createObjectURL(blob)
      worker = new Worker(url)
    } catch (err) {
      if (url) URL.revokeObjectURL(url)
      onResult(false, String(err))
      return
    }

    var settled = false
    var timer = setTimeout(function () {
      finish(false, 'Worker 启动超时')
    }, BOOT_TIMEOUT_MS)

    function finish(ok, reason) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!ok && worker) {
        worker.terminate()
        worker = null
      }
      URL.revokeObjectURL(url)
      onResult(ok, reason)
    }

    worker.onerror = function (event) {
      // A blob-URL worker rejected by an opaque origin surfaces here.
      finish(false, (event && event.message) || 'Worker 启动失败')
    }
    worker.onmessage = function (event) {
      var data = event.data
      if (!settled) {
        if (data && data.t === '__boot') {
          worker.onerror = null
          finish(true, '')
        }
        return
      }
      toHost(data, collectTransferables(data))
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Tier 2: frame thread                                                    */
  /* ---------------------------------------------------------------------- */

  function startInline() {
    ;(0, eval)(RUNTIME)
    inlineHandle = self.__OMNI_GUEST__(function (msg, transfer) {
      toHost(msg, transfer)
    })
  }

  /* ---------------------------------------------------------------------- */
  /* Relay                                                                   */
  /* ---------------------------------------------------------------------- */

  function deliver(data) {
    if (worker) worker.postMessage(data, collectTransferables(data))
    else if (inlineHandle) inlineHandle(data)
  }

  window.addEventListener('message', function (event) {
    // The frame has exactly one legitimate peer.
    if (event.source !== parent) return
    if (!ready) queue.push(event.data)
    else deliver(event.data)
  })

  function announce(mode) {
    ready = true
    toHost({ t: 'ready', nonce: NONCE, isolation: mode })
    for (var i = 0; i < queue.length; i++) deliver(queue[i])
    queue.length = 0
  }

  tryWorker(function (ok) {
    if (ok) {
      announce('iframe-worker')
      return
    }
    try {
      startInline()
      announce('iframe')
    } catch (err) {
      toHost({ t: 'boot-error', nonce: NONCE, error: '沙盒运行时启动失败：' + String(err) })
    }
  })
})()
