/**
 * Prepares `public/vendor/` — everything that must be served from our own origin.
 *
 * Two different jobs live here, for two different consumers:
 *
 * 1. **Sandbox dependencies** (`BUNDLE`). Plugins run with `connect-src 'none'`,
 *    so they cannot import anything; the host fetches a script and injects it as
 *    source text (see docs/design/02-plugin-api.md, "依赖"). That injection is a
 *    classic script, so ESM-only packages have to be flattened to an IIFE first.
 *    esbuild does that here, which is what lets an arbitrary npm package become
 *    a plugin dependency.
 *
 * 2. **Host runtime assets** (`COPY`). ffmpeg.wasm and onnxruntime-web load their
 *    own `.wasm` payloads at runtime. Serving them from our origin (instead of a
 *    CDN) is what keeps the app working offline and stops a third party from
 *    learning which tools the user runs.
 */
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendor = resolve(root, 'public/vendor')

/**
 * Bundled scripts.
 *
 * `global` entries become classic IIFEs for sandbox injection. `format: 'esm'`
 * entries are module workers we serve ourselves.
 */
const BUNDLE = [
  { entry: 'pdf-lib', global: 'PDFLib', out: 'pdf-lib.js' },
  { entry: 'pdfjs-dist/build/pdf.mjs', global: 'pdfjsLib', out: 'pdfjs.js' },
  { entry: 'pdfjs-dist/build/pdf.worker.mjs', global: 'pdfjsWorker', out: 'pdfjs-worker.js' },
  { entry: './scripts/entries/data-libs.mjs', global: 'DataLibs', out: 'data-libs.js' },
  /**
   * ImageMagick for the image toolbox's second engine: animated GIF / WebP /
   * APNG, EXIF and ICC profiles, HEIC / TIFF / PSD / JXL / RAW decoding. A lazy
   * dependency - its 14 MB module is only fetched when a tool needs it.
   */
  { entry: '@imagemagick/magick-wasm', global: 'MagickWasm', out: 'magick/magick.js' },
  { entry: 'fflate', global: 'fflate', out: 'fflate.js' },
  // Barcode reading and writing (QR, Code128, EAN, DataMatrix, PDF417, …); lazy, wasm as an asset.
  { entry: 'zxing-wasm/full', global: 'ZXingWASM', out: 'zxing/zxing.js' },
  // Documents: email (EML, MSG) and fonts (TTF / OTF / WOFF / WOFF2 conversion and subsetting).
  { entry: 'postal-mime', global: 'PostalMime', out: 'mail/postal-mime.js' },
  // iconv-lite underneath expects Node built-ins; `node: true` maps them to userland shims.
  { entry: '@kenjiuno/msgreader', global: 'MsgReaderLib', out: 'mail/msgreader.js', node: true },
  { entry: './scripts/entries/font-libs.mjs', global: 'FontLibs', out: 'fonts/font-libs.js' },
  // Font parsing and subsetting for pdf-lib, so PDFs can carry Chinese text.
  { entry: '@pdf-lib/fontkit', global: 'fontkit', out: 'fontkit.js' },
  /**
   * Emscripten modules (`emscripten: true`): qpdf for PDF encryption and
   * linearisation, libarchive for 7z / RAR. Their glue has a Node branch that
   * `require`s fs; it is never taken in a browser, so those imports stay
   * external and `process.versions` is defined away to pin the browser path.
   */
  {
    entry: './scripts/entries/qpdf.mjs', global: 'QpdfWasm', out: 'qpdf/qpdf.js', emscripten: true,
    // Its wasm loader calls `fetch`; see scripts/entries/qpdf-inline-fetch.mjs.
    define: { fetch: 'qpdfInlineFetch' }, inject: ['./scripts/entries/qpdf-inline-fetch.mjs'],
  },
  { entry: './scripts/entries/libarchive.mjs', global: 'LibarchiveWasm', out: 'libarchive/libarchive.js', emscripten: true },
  /**
   * ffmpeg's own worker, pre-bundled into `public/` on purpose.
   *
   * Left inside node_modules, Vite's dev server transforms it and rewrites the
   * `import(coreURL)` on line 19 into a `?import` request that it then aborts -
   * so ffmpeg never loads in dev. Served from `public/`, the worker is delivered
   * verbatim and the import reaches our core file untouched. `classWorkerURL`
   * in src/core/capabilities/ffmpeg.ts points here.
   */
  { entry: '@ffmpeg/ffmpeg/worker', format: 'esm', out: 'ffmpeg/worker.js' },
]

/**
 * Files copied verbatim, `from` relative to the repo root.
 *
 * The **ESM** ffmpeg cores, not the UMD ones. `@ffmpeg/ffmpeg` spawns a module
 * worker, where `importScripts` does not exist, so its loader falls through to
 * `import(coreURL)` - and a UMD bundle cannot satisfy that. Pointing at the ESM
 * build takes the path the library actually expects.
 */
const COPY_BASE = [
  { from: 'node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js', to: 'ffmpeg/ffmpeg-core.js' },
  { from: 'node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm', to: 'ffmpeg/ffmpeg-core.wasm' },
  { from: 'node_modules/@ffmpeg/core-mt/dist/esm/ffmpeg-core.js', to: 'ffmpeg-mt/ffmpeg-core.js' },
  { from: 'node_modules/@ffmpeg/core-mt/dist/esm/ffmpeg-core.wasm', to: 'ffmpeg-mt/ffmpeg-core.wasm' },
  { from: 'node_modules/@ffmpeg/core-mt/dist/esm/ffmpeg-core.worker.js', to: 'ffmpeg-mt/ffmpeg-core.worker.js' },
  // The wasm32 build. `x64/magick.wasm` needs Memory64, which Safari and older
  // Chromium lack; 4 GB of addressable memory is plenty for image work.
  { from: 'node_modules/@imagemagick/magick-wasm/dist/x86/magick.wasm', to: 'magick/magick.wasm' },
  { from: 'node_modules/zxing-wasm/dist/full/zxing_full.wasm', to: 'zxing/zxing_full.wasm' },
  { from: 'node_modules/fonteditor-core/woff2/woff2.wasm', to: 'fonts/woff2.wasm' },
  { from: 'node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.wasm', to: 'qpdf/qpdf.wasm' },
  { from: 'node_modules/libarchive-wasm/dist/libarchive.wasm', to: 'libarchive/libarchive.wasm' },
  // SheetJS's own browser build defines `XLSX` as a plain global; no bundling needed.
  { from: 'node_modules/xlsx/dist/xlsx.full.min.js', to: 'xlsx.js' },
  // Registers `self.ImageTracer` itself when loaded in a worker; no bundling needed.
  { from: 'node_modules/imagetracerjs/imagetracer_v1.2.6.js', to: 'imagetracer.js' },
]

/**
 * onnxruntime-web ships four wasm builds totalling ~82 MB. We serve only the two
 * we can actually reach:
 *   - `...threaded.wasm`       CPU, SIMD + threads. Needs cross-origin isolation,
 *                              which the app already sets up for ffmpeg.
 *   - `...threaded.jsep.wasm`  the same plus the WebGPU execution provider.
 * The `asyncify` and `jspi` builds exist for engines without those features and
 * would only add 40 MB of dead weight to the deployment.
 */
const ORT_WASM = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.jsep.wasm',
  // The Emscripten glue for each: with `wasmPaths` pointing here, ORT imports
  // these from the same directory, and its pthread workers start from them.
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.jsep.mjs',
]
const COPY = [
  ...COPY_BASE,
  ...ORT_WASM.map((name) => ({ from: `node_modules/onnxruntime-web/dist/${name}`, to: `ort/${name}` })),
]

/** Node modules Emscripten glue requires only on its (unreachable) Node path. */
const EMSCRIPTEN_NODE_BUILTINS = ['fs', 'path', 'crypto', 'worker_threads', 'url', 'module']

await mkdir(vendor, { recursive: true })

/* -------------------------------------------------------------------------- */

for (const target of BUNDLE) {
  const outfile = join(vendor, target.out)
  await build({
    entryPoints: [target.entry],
    outfile,
    bundle: true,
    format: target.format ?? 'iife',
    ...(target.global ? { globalName: target.global } : {}),
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    // The sandbox has no network, so anything left unresolved would fail at
    // runtime rather than at build time. Fail loudly here instead.
    external: target.emscripten ? EMSCRIPTEN_NODE_BUILTINS : [],
    define: {
      'process.env.NODE_ENV': '"production"',
      ...(target.node ? { global: 'globalThis' } : {}),
      ...(target.emscripten ? { 'process.versions': '{}' } : {}),
      ...target.define,
    },
    ...(target.node
      ? { alias: { buffer: 'buffer', string_decoder: 'string_decoder' }, inject: [resolve(root, 'scripts/entries/node-shims.mjs')] }
      : {}),
    ...(target.inject ? { inject: target.inject.map((file) => resolve(root, file)) } : {}),
    // The sandbox evaluates deps with indirect eval. If any bundled module has a
    // "use strict" directive, esbuild hoists it to the top of the file, and a
    // top-level `var X` in strict eval code stays local to that eval - the
    // global silently never appears. Publishing on globalThis works either way.
    ...(target.global ? { footer: { js: `globalThis.${target.global}=${target.global};` } } : {}),
    logLevel: 'warning',
  })
  const { size } = await stat(outfile)
  console.log(
    `[vendor] bundled ${target.entry} -> ${target.out} (${(size / 1024).toFixed(0)} KB` +
      `${target.global ? `, global: ${target.global}` : `, ${target.format}`})`,
  )
}

for (const entry of COPY) {
  const src = resolve(root, entry.from)
  try {
    await stat(src)
  } catch {
    console.error(`[vendor] missing ${entry.from} - run \`pnpm install\` first`)
    process.exit(1)
  }
  const dest = join(vendor, entry.to)
  await mkdir(dirname(dest), { recursive: true })
  await copyFile(src, dest)
  console.log(`[vendor] copied ${entry.to}`)
}

/**
 * The PP-OCRv4 recogniser's character table, one entry per line, extracted from
 * the model's `character` metadata (index i here is class i + 1; 0 is the CTC
 * blank and the last class is a space). ONNX Runtime Web does not expose model
 * metadata, so the AI plugin loads it as a lazy dependency instead.
 */
{
  const keys = (await readFile(resolve(root, 'scripts/assets/ppocr-keys-v1.txt'), 'utf8')).replace(/\n$/, '').split('\n')
  if (keys.length !== 6623) throw new Error(`[vendor] ppocr-keys-v1.txt has ${keys.length} entries, expected 6623`)
  const dest = join(vendor, 'ocr/ppocr-keys.js')
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, `globalThis.PPOCR_KEYS=${JSON.stringify(keys)};\n`)
  console.log('[vendor] wrote ocr/ppocr-keys.js')
}

/**
 * Downloads a file once, verifies it against a pinned SHA-256 and caches it under
 * node_modules/.cache. Resolves to the cached path, or null when offline without
 * a cache - the build still succeeds and the dependent tools report it missing.
 */
async function pinnedDownload({ url, sha256, ext, label }) {
  const cacheDir = resolve(root, 'node_modules/.cache/omnitool')
  const cached = join(cacheDir, `${sha256}.${ext}`)
  try {
    if (createHash('sha256').update(await readFile(cached)).digest('hex') === sha256) return cached
  } catch {
    /* not cached yet */
  }
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== sha256) throw new Error(`SHA-256 mismatch: ${actual}`)
    await mkdir(cacheDir, { recursive: true })
    await writeFile(cached, bytes)
    return cached
  } catch (error) {
    console.warn(`[vendor] ${label} unavailable (${error.message}); tools that need it will report it missing`)
    return null
  }
}

/**
 * One CJK font shared by every tool that renders text into a file: burned-in
 * subtitles and text watermarks (ffmpeg's libass / drawtext), Markdown → PDF,
 * searchable OCR PDFs and PDF text stamps (pdf-lib subsets it, so a PDF carries
 * only the glyphs it uses - a few KB, not 10 MB).
 *
 * Noto Sans SC Regular, SIL Open Font License 1.1. Too large for the repository,
 * so it is fetched by `pinnedDownload`.
 */
{
  const FONT = {
    url: 'https://fonts.gstatic.com/s/notosanssc/v40/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaG9_FnYw.ttf',
    sha256: '450625c8d46ab3df97b7904ded955ec2746d17ec76740cb1e91d1ba63a0f89af',
    name: 'NotoSansSC-Regular.ttf',
  }
  const cached = await pinnedDownload({ ...FONT, ext: 'ttf', label: 'CJK font' })
  const fontsDir = join(vendor, 'fonts')
  await mkdir(fontsDir, { recursive: true })
  if (cached) {
    await copyFile(cached, join(fontsDir, FONT.name))
    console.log(`[vendor] copied fonts/${FONT.name}`)
  }
  // The dependency script plugins declare to receive the font as an asset.
  await writeFile(
    join(fontsDir, 'fonts.js'),
    `globalThis.OMNITOOL_FONTS=${JSON.stringify({ [FONT.name]: { family: 'Noto Sans SC', license: 'OFL-1.1', available: !!cached } })};\n`,
  )
}

/**
 * Whisper's token table (MIT, OpenAI), for turning decoder output back into
 * text: token strings indexed by id, in GPT-2 byte-level form, plus the special
 * tokens by name. Taken from the same pinned commit as the ONNX models the AI
 * plugin downloads, so ids always match.
 */
{
  const TOKENIZER = {
    url: 'https://huggingface.co/onnx-community/whisper-base/resolve/1846881b6b3a3024392c1eea3ad983695bc23925/tokenizer.json',
    sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566',
  }
  const cached = await pinnedDownload({ ...TOKENIZER, ext: 'json', label: 'Whisper tokenizer' })
  let table = { available: false }
  if (cached) {
    const tokenizer = JSON.parse(await readFile(cached, 'utf8'))
    const tokens = []
    for (const [text, id] of Object.entries(tokenizer.model.vocab)) tokens[id] = text
    for (const added of tokenizer.added_tokens) tokens[added.id] = added.content
    if (tokens.length !== 51865 || tokens.includes(undefined)) throw new Error(`[vendor] unexpected Whisper vocabulary (${tokens.length} tokens)`)
    table = { available: true, tokens }
  }
  const dest = join(vendor, 'whisper/vocab.js')
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, `globalThis.WHISPER_VOCAB=${JSON.stringify(table)};\n`)
  console.log(`[vendor] wrote whisper/vocab.js${cached ? '' : ' (unavailable)'}`)
}

// A manifest so the host can assert at runtime that `pnpm vendor` actually ran,
// instead of failing deep inside a wasm loader with an opaque error.
await writeFile(
  join(vendor, 'manifest.json'),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), bundles: BUNDLE.map((b) => b.out) }, null, 2)}\n`,
)
console.log('[vendor] done')
