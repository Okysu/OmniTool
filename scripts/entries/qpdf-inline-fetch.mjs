/**
 * Stands in for `fetch` inside the qpdf bundle (esbuild `define` + `inject`).
 *
 * The qpdf build always fetches its wasm. In a plugin sandbox the real `fetch`
 * is locked away, and it should stay that way, so the bundle's references are
 * rewritten to this function, which can only hand back the wasm bytes the
 * plugin received as a dependency asset.
 */
export const QPDF_WASM_URL = 'omnitool-inline:qpdf.wasm'

let wasm = null

export function setInlineWasm(bytes) {
  wasm = bytes
}

export async function qpdfInlineFetch(url) {
  if (String(url) === QPDF_WASM_URL && wasm) return new Response(wasm, { headers: { 'Content-Type': 'application/wasm' } })
  throw new Error(`qpdf 不允许访问网络：${url}`)
}
