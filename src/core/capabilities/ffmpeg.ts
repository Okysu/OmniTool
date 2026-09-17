/**
 * Host-side FFmpeg (WebAssembly) runtime.
 *
 * ## Why this is a host capability rather than a plugin dependency
 *
 * `@ffmpeg/ffmpeg` spawns its own worker and fetches a ~32 MB core payload at
 * runtime. Inside the plugin sandbox (`connect-src 'none'`) neither is possible.
 * More practically: one shared instance means the core is loaded once for every
 * plugin instead of once per plugin, and the host can meter progress and
 * cancellation uniformly.
 *
 * ## Argument handling
 *
 * Plugins pass a real argv array. That is deliberate - a declarative wrapper
 * around a handful of blessed operations would cap the toolbox at whatever we
 * thought of, and ffmpeg's surface is the entire point of shipping it. The
 * containment that matters is elsewhere: ffmpeg runs in its own wasm heap with
 * no filesystem beyond the virtual one we populate, and it only ever sees the
 * files this invocation was handed. `$0`-style placeholders, not raw paths, are
 * what a plugin writes, so it cannot reference anything we did not mount.
 */
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { reactive } from 'vue'
import { settings } from '@/core/settings'

/**
 * Core locations, as **absolute** URLs.
 *
 * This is load-bearing, not tidiness. `@ffmpeg/ffmpeg` hands the core a
 * `mainScriptUrlOrBlob` built from `coreURL`, and the multi-thread core passes
 * that same string to each pthread worker, which resolves it with `import()`.
 * Those pthread workers are spawned classic (`new Worker(pthreadMainJs)` with no
 * `type: 'module'`), and a classic worker cannot resolve a *root-relative*
 * module specifier - it fails with "Failed to resolve module specifier".
 *
 * The failure is silent: the pthread never reports ready, so the main thread
 * waits for its thread pool forever. Audio-only jobs complete normally because
 * they never ask for a thread, which is what made this look like a codec issue
 * rather than a URL issue. An absolute URL resolves fine and the pool starts.
 */
const ORIGIN = typeof location === 'undefined' ? '' : location.origin
const CORE_ST = `${ORIGIN}/vendor/ffmpeg`
const CORE_MT = `${ORIGIN}/vendor/ffmpeg-mt`

export const ffmpegState = reactive({
  status: 'idle' as 'idle' | 'loading' | 'ready' | 'failed',
  /** Which core actually came up. */
  variant: null as 'mt' | 'st' | null,
  error: '',
  /** 0..1 while the core payload downloads. */
  loadProgress: 0,
})

let instance: FFmpeg | null = null
let bootPromise: Promise<FFmpeg> | null = null

/** Progress sink for the invocation currently holding the instance. */
let activeProgress: ((ratio: number, timeSeconds: number) => void) | null = null
let activeLog: ((line: string) => void) | null = null

/**
 * FFmpeg has one wasm heap and one virtual filesystem, so concurrent runs would
 * trample each other. Invocations queue behind this chain instead.
 */
let queue: Promise<unknown> = Promise.resolve()

async function boot(): Promise<FFmpeg> {
  if (bootPromise) return bootPromise

  bootPromise = (async () => {
    ffmpegState.status = 'loading'
    const ffmpeg = new FFmpeg()

    ffmpeg.on('log', ({ message }) => {
      activeLog?.(message)
    })
    ffmpeg.on('progress', ({ progress, time }) => {
      // ffmpeg reports a ratio that can overshoot on streams with no duration.
      activeProgress?.(Math.max(0, Math.min(1, progress)), time / 1_000_000)
    })

    // Multi-thread whenever the page is cross-origin isolated (vite.config.ts
    // sets the headers). The setting exists only as an escape hatch.
    const useMt =
      settings.ffmpegMultithread && typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
    const base = useMt ? CORE_MT : CORE_ST

    try {
      await ffmpeg.load({
        // Our own copy of the library's worker, served from `public/`. The
        // packaged one goes through Vite's transform in dev, which rewrites its
        // dynamic core import into a request Vite then aborts. See the comment
        // on the matching BUNDLE entry in scripts/vendor.mjs.
        classWorkerURL: `${ORIGIN}/vendor/ffmpeg/worker.js`,
        coreURL: `${base}/ffmpeg-core.js`,
        wasmURL: `${base}/ffmpeg-core.wasm`,
        ...(useMt ? { workerURL: `${base}/ffmpeg-core.worker.js` } : {}),
      })
    } catch (error) {
      ffmpegState.status = 'failed'
      ffmpegState.error =
        `FFmpeg 核心加载失败：${error instanceof Error ? error.message : String(error)}。` +
        '请确认已执行 `pnpm vendor`，且部署带上了 COOP/COEP 响应头。'
      bootPromise = null
      throw new Error(ffmpegState.error)
    }

    ffmpegState.status = 'ready'
    ffmpegState.variant = useMt ? 'mt' : 'st'
    ffmpegState.loadProgress = 1
    instance = ffmpeg
    return ffmpeg
  })()

  return bootPromise
}

/** Frees the wasm heap. The next run boots a fresh core. */
export function disposeFfmpeg(): void {
  instance?.terminate()
  instance = null
  bootPromise = null
  ffmpegState.status = 'idle'
  ffmpegState.variant = null
  ffmpegState.loadProgress = 0
}

export interface FfmpegRun {
  /**
   * argv with `$in0`, `$in1`, … standing for the mounted input files and
   * `$out0`, `$out1`, … for the declared outputs.
   */
  args: string[]
  /** VFS ids to mount, in `$inN` order. */
  inputs: string[]
  /**
   * Output filenames, in `$outN` order. The extension drives the muxer.
   *
   * A name containing `%` (e.g. `frame-%04d.jpg`) is treated as an image2
   * sequence: ffmpeg writes many files and every one of them is collected,
   * numbered into the declared pattern. That is the only way to express
   * frame extraction, where the count is not known before the run.
   */
  outputs: string[]
}

export interface FfmpegResult {
  /** Produced files as raw bytes, in `outputs` order. */
  files: Array<{ name: string; data: Uint8Array }>
  /** Tail of the ffmpeg log, for error reporting and probing. */
  log: string[]
}

export interface FfmpegHooks {
  readFile: (id: string) => Promise<Uint8Array>
  /**
   * The workspace name of an input, used only for its extension. Demuxer choice
   * depends on it: a PNG mounted as `in1.bin` is read by `png_pipe`, which
   * ignores `-loop 1`, so a looped still image yields one frame and filters that
   * wait for the next one hang.
   */
  nameOf?: (id: string) => string
  onProgress?: (ratio: number, timeSeconds: number) => void
  signal?: AbortSignal
}

/**
 * Size of the pthread pool the mt core pre-spawns (`pthreadPoolSize=32` in
 * ffmpeg-core.js). Keep in step if the core is upgraded.
 */
export const PTHREAD_POOL = 32

/**
 * Caps FFmpeg's thread usage so it fits the pre-spawned pthread pool.
 *
 * ## The deadlock this prevents
 *
 * Left alone, FFmpeg sizes its thread counts from the core count: libx264 takes
 * ~1.5 × cores frame threads and the H.264 decoder cores + 1. On a 28-core
 * machine that is 70+ threads against a pool of 32. Once the pool is empty,
 * Emscripten must spawn a fresh Worker for the next `pthread_create` - which it
 * can only do by yielding to the event loop of the thread running `exec`. That
 * thread is blocked inside `exec`. Nothing ever yields, and the job hangs with
 * no progress and no error.
 *
 * It only reproduces on machines with enough cores to overflow the pool, which
 * is why it presents as "works on some computers". Audio-only jobs never ask
 * for threads, which is why it looked codec-specific.
 *
 * ## The budget
 *
 * Every input decoder and output encoder gets its own `-threads N`, and the
 * filter graph gets one more share. N is the pool, minus headroom for FFmpeg's
 * own internal threads, divided across those consumers. A `-threads` the plugin
 * set itself is left alone.
 */
export function applyThreadBudget(args: string[], multithreaded: boolean, inputNames: readonly string[] = []): string[] {
  if (args.includes('-threads')) return args

  const inputCount = args.filter((_, i) => args[i - 1] === '-i').length
  const outputPositions = args
    .map((arg, i) => ({ arg, i }))
    .filter(({ arg, i }) => /^\$out\d+$/.test(arg) && args[i - 1] !== '-i')
    .map(({ i }) => i)

  // Half the pool, not the whole of it. `-threads N` is not a hard ceiling on
  // what a component spawns: x264 adds lookahead threads on top of N, frame-
  // threaded decoders add slice threads, and the scaler runs its own. Measured
  // on a 28-core machine: a budget of 8 per consumer still hung a 720p
  // upscale; 4 per consumer against half the pool completes reliably.
  const consumers = inputCount + outputPositions.length + 1
  const threads = multithreaded
    ? Math.max(1, Math.min(4, Math.floor(PTHREAD_POOL / 2 / consumers)))
    : 1

  const out: string[] = ['-filter_threads', String(threads), '-filter_complex_threads', String(threads)]
  args.forEach((arg, i) => {
    // `-threads` binds to the file that follows it, so it goes immediately
    // before each input's `-i` and before each output filename.
    if (arg === '-i') out.push('-threads', isStillImage(args[i + 1], inputNames) ? '1' : String(threads))
    else if (outputPositions.includes(i)) out.push('-threads', String(threads))
    out.push(arg)
  })
  return out
}

/**
 * Whether an `-i` argument is a still image. Such inputs always decode with one
 * thread: a single picture has nothing to decode in parallel, and a frame-
 * threaded decoder holds its frame back waiting for packets that never come.
 * Feeding a lockstep filter (`scale2ref`, measured: a logo watermark), that is a
 * cyclic wait and the job hangs forever under the multi-thread core, while the
 * same command completes in a second single-threaded.
 */
function isStillImage(arg: string | undefined, inputNames: readonly string[]): boolean {
  const index = /^\$in(\d+)$/.exec(arg ?? '')?.[1]
  const name = index === undefined ? '' : (inputNames[Number(index)] ?? '')
  return /\.(png|jpe?g|webp|bmp|tiff?|avif|qoi)$/i.test(name)
}

/** Filenames handed to the wasm FS. Never derived from plugin input. */
function mountName(index: number, kind: 'in' | 'out', hint: string): string {
  const extension = /\.([A-Za-z0-9]{1,8})$/.exec(hint)?.[1]?.toLowerCase() ?? 'bin'
  // An output sequence keeps its printf pattern, since ffmpeg's image2 muxer
  // needs it, but the prefix is still ours - a plugin cannot name a path we did
  // not mount. Inputs never do: a file literally named `a%03d.png` is one file.
  const pattern = kind === 'out' ? /%0?\d*d/.exec(hint)?.[0] : undefined
  return pattern ? `${kind}${index}_${pattern}.${extension}` : `${kind}${index}.${extension}`
}

/** Expands `frame-%04d.jpg` for the n-th produced file. */
function sequenceName(pattern: string, ordinal: number): string {
  return pattern.replace(/%0?(\d*)d/, (_, width: string) => String(ordinal).padStart(Number(width) || 1, '0'))
}

export async function runFfmpeg(
  run: FfmpegRun,
  hooks: FfmpegHooks,
  /** Probing runs legitimately produce nothing; everything else must. */
  options: { allowNoOutput?: boolean } = {},
): Promise<FfmpegResult> {
  if (run.outputs.length === 0 && !options.allowNoOutput) throw new Error('至少需要声明一个输出文件')
  if (run.args.length === 0) throw new Error('args 不能为空')

  const task = queue.then(async () => {
    const ffmpeg = await boot()
    const log: string[] = []
    const mountedInputs: string[] = []
    const mountedOutputs: string[] = []
    /** Sequence members discovered at read time, unmounted in `finally`. */
    const sequenceCleanup: string[] = []

    activeLog = (line) => {
      log.push(line)
      // Keep the tail bounded; a long transcode emits thousands of lines.
      if (log.length > 400) log.splice(0, log.length - 400)
    }
    activeProgress = (ratio, time) => hooks.onProgress?.(ratio, time)

    try {
      for (const [index, id] of run.inputs.entries()) {
        const name = mountName(index, 'in', hooks.nameOf?.(id) ?? id)
        await ffmpeg.writeFile(name, await hooks.readFile(id))
        mountedInputs.push(name)
      }
      for (const [index, hint] of run.outputs.entries()) {
        mountedOutputs.push(mountName(index, 'out', hint))
      }

      // Placeholders are resolved here, so an argv can only ever name files we
      // mounted ourselves - there is no path expression a plugin can smuggle in.
      const budgeted = applyThreadBudget(run.args, ffmpegState.variant === 'mt', run.inputs.map((id) => hooks.nameOf?.(id) ?? ''))
      const argv = budgeted.map((arg) =>
        String(arg).replace(/\$(in|out)(\d+)/g, (whole, kind: string, raw: string) => {
          const index = Number(raw)
          const table = kind === 'in' ? mountedInputs : mountedOutputs
          if (!Number.isInteger(index) || index < 0 || index >= table.length) {
            throw new Error(`未知的占位符 ${whole}`)
          }
          return table[index]
        }),
      )

      if (hooks.signal?.aborted) throw new Error('已取消')
      const onAbort = () => ffmpeg.terminate()
      hooks.signal?.addEventListener('abort', onAbort, { once: true })

      let code: number
      try {
        code = await ffmpeg.exec(argv)
      } finally {
        hooks.signal?.removeEventListener('abort', onAbort)
      }

      if (hooks.signal?.aborted) {
        // terminate() kills the instance; the next run boots a fresh core.
        instance = null
        bootPromise = null
        ffmpegState.status = 'idle'
        throw new Error('已取消')
      }
      if (code !== 0 && !options.allowNoOutput) {
        throw new Error(`FFmpeg 退出码 ${code}\n${log.slice(-12).join('\n')}`)
      }

      const files: Array<{ name: string; data: Uint8Array }> = []
      // A sequence output produced an unknown number of files, so ask the wasm
      // FS what actually landed rather than guessing.
      const produced = /%0?\d*d/.test(mountedOutputs.join(''))
        ? ((await ffmpeg.listDir('/')) as Array<{ name: string; isDir: boolean }>)
            .filter((entry) => !entry.isDir)
            .map((entry) => entry.name)
        : []

      for (const [index, name] of mountedOutputs.entries()) {
        const declared = run.outputs[index]

        if (/%0?\d*d/.test(name)) {
          const prefix = name.slice(0, name.indexOf('%'))
          const suffix = name.slice(name.lastIndexOf('.'))
          const matches = produced
            .filter((candidate) => candidate.startsWith(prefix) && candidate.endsWith(suffix))
            .sort()
          if (matches.length === 0) {
            throw new Error(`未产生任何输出文件\n${log.slice(-12).join('\n')}`)
          }
          for (const [ordinal, actual] of matches.entries()) {
            const data = (await ffmpeg.readFile(actual)) as Uint8Array
            if (data?.byteLength) files.push({ name: sequenceName(declared, ordinal + 1), data })
            sequenceCleanup.push(actual)
          }
          continue
        }

        const data = (await ffmpeg.readFile(name)) as Uint8Array
        if (!data || data.byteLength === 0) {
          throw new Error(`输出文件 ${declared} 为空\n${log.slice(-12).join('\n')}`)
        }
        files.push({ name: declared, data })
      }
      return { files, log: log.slice(-40) }
    } finally {
      activeLog = null
      activeProgress = null
      // Always unmount, or a long session leaks the whole workspace into the
      // wasm heap and the next run sees stale files.
      if (instance) {
        for (const name of [...mountedInputs, ...mountedOutputs, ...sequenceCleanup]) {
          await instance.deleteFile(name).catch(() => {})
        }
      }
    }
  })

  // Keep the chain alive even when a run fails, or every later run inherits the
  // rejection.
  queue = task.catch(() => {})
  return task
}

/**
 * Runs `ffmpeg -i <file>` purely to capture the stream summary it prints.
 *
 * ffmpeg always exits non-zero when given no output, so the interesting result
 * is the log rather than the exit code - hence `allowNoOutput`.
 */
export async function probeFfmpeg(id: string, hooks: FfmpegHooks): Promise<string[]> {
  const result = await runFfmpeg(
    { args: ['-hide_banner', '-i', '$in0'], inputs: [id], outputs: [] },
    hooks,
    { allowNoOutput: true },
  )
  return result.log
}
