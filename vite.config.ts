import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

/**
 * Cross-origin isolation headers.
 *
 * `@ffmpeg/ffmpeg` multi-thread builds need `SharedArrayBuffer`, which requires
 * the document to be cross-origin isolated. We enable it from day one so that
 * turning ffmpeg on in a later iteration is not a breaking infra change.
 *
 * COEP `credentialless` (instead of `require-corp`) keeps plain <img>/<script>
 * loads from third-party origins working without CORP headers, which matters for
 * remotely subscribed plugin assets.
 */
const crossOriginIsolation = {
  name: 'cross-origin-isolation',
  configureServer(server: any) {
    server.middlewares.use((_req: any, res: any, next: any) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
      next()
    })
  },
  configurePreviewServer(server: any) {
    server.middlewares.use((_req: any, res: any, next: any) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
      next()
    })
  },
}

export default defineConfig({
  plugins: [vue(), tailwindcss(), crossOriginIsolation],
  optimizeDeps: {
    /**
     * `@ffmpeg/ffmpeg` starts its worker with
     * `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })`.
     * Vite's dependency pre-bundler rewrites that URL to a file it then serves
     * without a JS media type, so the browser refuses it:
     *   "Loading the Worker from ...?worker_file&type=module was blocked
     *    because of a disallowed MIME type ("")"  (NS_ERROR_CORRUPTED_CONTENT)
     * Excluding the package leaves the worker URL intact in dev. Production
     * builds were never affected - Rollup handles the pattern correctly.
     */
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util', 'onnxruntime-web'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
  },
  /**
   * Module workers. The ONNX runtime worker bundles onnxruntime-web, which is ESM
   * (`import.meta.url`) and starts its pthread workers as module workers from its
   * own chunk - an IIFE worker chunk can do neither.
   */
  worker: {
    format: 'es',
  },
})
