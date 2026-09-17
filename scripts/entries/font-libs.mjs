/**
 * Font tooling for the sandbox: fonteditor-core (TTF / OTF / WOFF / WOFF2 / EOT /
 * SVG reading and writing, subsetting) with its WOFF2 codec initialised from
 * bytes. The library's own initialiser takes a Node.js path whenever `window` is
 * missing - which is always true in a worker - so it is bypassed here and the
 * shared codec singleton is filled in directly.
 */
import { Font } from 'fonteditor-core'
import woff2 from '../../node_modules/fonteditor-core/woff2/index.js'
import createWoff2Module from '../../node_modules/fonteditor-core/woff2/woff2.js'

export { Font, woff2 }

export function initWoff2(wasmBinary) {
  if (woff2.isInited()) return Promise.resolve(woff2)
  return new Promise((resolve, reject) => {
    const module = createWoff2Module({ wasmBinary: new Uint8Array(wasmBinary), onAbort: reject })
    module.onRuntimeInitialized = () => {
      woff2.woff2Module = module
      resolve(woff2)
    }
  })
}
