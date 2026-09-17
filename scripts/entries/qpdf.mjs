/**
 * qpdf (Apache-2.0) compiled to WebAssembly: encryption, decryption, permission
 * changes, linearisation and structural checks - what pdf-lib cannot do.
 *
 * Two quirks of this build are handled here, so plugins see a plain API:
 *
 *   - It has no `wasmBinary` option and always fetches `qpdf.wasm`. The bundle
 *     is built with its `fetch` rewritten to `qpdfInlineFetch`
 *     (scripts/entries/qpdf-inline-fetch.mjs), which serves only the bytes
 *     passed to `createQpdf`.
 *   - It ignores `print` / `printErr` and binds `console.log` / `console.error`
 *     when it starts. Those are swapped for forwarding functions at that moment,
 *     which is how each `run` collects qpdf's messages.
 *
 * It is also built without C++ exception catching, so qpdf's own damaged-file
 * recovery does not work; the PDF toolbox repairs with pdf-lib instead and uses
 * qpdf only to check the result.
 */
import Module from '@neslinesli93/qpdf-wasm'
import { QPDF_WASM_URL, setInlineWasm } from './qpdf-inline-fetch.mjs'

let pending = Promise.resolve()

export function createQpdf(wasmBinary) {
  // Serialised, so the swapped console is never restored underneath another instantiation.
  const run = pending.then(async () => {
    const lines = []
    const saved = { log: console.log, error: console.error, warn: console.warn }
    const collect = (...parts) => lines.push(parts.join(' '))
    setInlineWasm(wasmBinary)
    console.log = collect
    console.error = collect
    console.warn = collect
    let mod
    try {
      mod = await Module({ noInitialRun: true, locateFile: () => QPDF_WASM_URL })
    } finally {
      setInlineWasm(null)
      console.log = saved.log
      console.error = saved.error
      console.warn = saved.warn
    }
    return {
      FS: mod.FS,
      /** Runs one qpdf command line. Exit codes: 0 ok, 2 error, 3 succeeded with warnings. */
      run(args) {
        lines.length = 0
        let code
        try {
          code = mod.callMain([...args])
        } catch (error) {
          code = typeof error?.status === 'number' ? error.status : 2
          if (!lines.length) lines.push(String(error?.message ?? error))
        }
        return { code, output: lines.join('\n').replace(/this\.program: /g, '') }
      },
    }
  })
  pending = run.catch(() => {})
  return run
}
