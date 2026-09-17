/**
 * ONNX Runtime Web, owned by a dedicated worker.
 *
 * Why not ORT's own `env.wasm.proxy`: the proxy starts a worker from ORT's
 * script URL, and once Vite inlines ORT into the app chunk that URL *is the app*
 * - the worker boots the whole UI bundle and dies on `document`. A worker of our
 * own is a separate chunk containing only ORT and this file.
 *
 * The main thread keeps everything that needs the user or the network - the
 * approval prompt, the download, SHA-256 verification, the OPFS cache - and
 * sends verified model bytes here. This worker only creates sessions and runs
 * them, so a long inference never touches the UI thread.
 *
 * With multiple threads, Emscripten starts pthread workers from this same chunk
 * (named `em-pthread*`). Those must be left to ORT's glue code, so the message
 * handler below is only installed in the main instance.
 */
import * as ort from 'onnxruntime-web'

export type OnnxRequest =
  | { t: 'init'; id: number; wasmPaths: string; numThreads: number }
  | { t: 'create'; id: number; bytes: ArrayBuffer; preferGpu: boolean }
  | {
      t: 'run'
      id: number
      session: number
      /** A feed is either raw data or a tensor kept from an earlier run. */
      feeds: Record<string, { type: string; dims: number[]; data: ArrayBufferView } | { tensor: number }>
      /** Outputs to keep here and return as handles instead of data. */
      keep: string[]
      /** Outputs to compute; empty means all of them. */
      fetches: string[]
    }
  | { t: 'release'; id: number; session: number }
  | { t: 'dispose'; id: number; tensors: number[] }

export type OnnxResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string }

const scope = self as unknown as DedicatedWorkerGlobalScope

if (!scope.name?.startsWith('em-pthread')) {
  const sessions = new Map<number, ort.InferenceSession>()
  /** Outputs kept for reuse as later feeds, e.g. a decoder's KV cache. */
  const kept = new Map<number, ort.Tensor>()
  let seq = 0
  let gpuAvailable: Promise<boolean> | null = null

  /** WebGPU is used only when an adapter actually exists; asking ORT to try and fail poisons its wasm init. */
  const hasGpu = () =>
    (gpuAvailable ??= (async () => {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
      try {
        return !!(gpu && (await gpu.requestAdapter()))
      } catch {
        return false
      }
    })())

  const reply = (message: OnnxResponse, transfer: Transferable[] = []) => scope.postMessage(message, transfer)

  scope.addEventListener('message', async (event: MessageEvent<OnnxRequest>) => {
    const request = event.data
    try {
      switch (request.t) {
        case 'init': {
          ort.env.wasm.wasmPaths = request.wasmPaths
          ort.env.wasm.numThreads = request.numThreads
          ort.env.wasm.proxy = false
          ort.env.logLevel = 'error'
          reply({ id: request.id, ok: true, value: { gpu: await hasGpu() } })
          break
        }
        case 'create': {
          const providers = request.preferGpu && (await hasGpu()) ? ['webgpu', 'wasm'] : ['wasm']
          const session = await ort.InferenceSession.create(new Uint8Array(request.bytes), {
            executionProviders: providers,
            graphOptimizationLevel: 'all',
          })
          const handle = ++seq
          sessions.set(handle, session)
          reply({ id: request.id, ok: true, value: { session: handle, inputs: [...session.inputNames], outputs: [...session.outputNames], providers } })
          break
        }
        case 'run': {
          const session = sessions.get(request.session)
          if (!session) throw new Error(`未知的推理会话：${request.session}`)
          const tensors: Record<string, ort.Tensor> = {}
          for (const [name, input] of Object.entries(request.feeds)) {
            if (!session.inputNames.includes(name)) {
              throw new Error(`模型没有名为「${name}」的输入，可用输入：${session.inputNames.join('、')}`)
            }
            if ('tensor' in input) {
              const tensor = kept.get(input.tensor)
              if (!tensor) throw new Error(`张量句柄已失效：${input.tensor}`)
              tensors[name] = tensor
            } else {
              tensors[name] = new ort.Tensor(input.type as never, input.data as never, input.dims)
            }
          }
          const result = request.fetches.length ? await session.run(tensors, request.fetches) : await session.run(tensors)
          const outputs: Record<string, { type: string; dims: readonly number[]; data?: ArrayBufferView; tensor?: number }> = {}
          const transfer: Transferable[] = []
          for (const [name, tensor] of Object.entries(result)) {
            if (request.keep.includes(name)) {
              const handle = ++seq
              kept.set(handle, tensor)
              outputs[name] = { type: tensor.type, dims: tensor.dims, tensor: handle }
              continue
            }
            // GPU-located outputs must be downloaded before they can be posted.
            const data = (tensor.location === 'cpu' ? tensor.data : await tensor.getData()) as ArrayBufferView
            outputs[name] = { type: tensor.type, dims: tensor.dims, data }
            if (!transfer.includes(data.buffer as ArrayBuffer)) transfer.push(data.buffer as ArrayBuffer)
          }
          reply({ id: request.id, ok: true, value: outputs }, transfer)
          break
        }
        case 'dispose': {
          for (const handle of request.tensors) {
            kept.get(handle)?.dispose()
            kept.delete(handle)
          }
          reply({ id: request.id, ok: true, value: null })
          break
        }
        case 'release': {
          await sessions.get(request.session)?.release()
          sessions.delete(request.session)
          reply({ id: request.id, ok: true, value: null })
          break
        }
      }
    } catch (error) {
      reply({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })
}
