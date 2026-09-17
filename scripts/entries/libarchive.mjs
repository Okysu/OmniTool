/**
 * libarchive (BSD) in WebAssembly, for reading 7z, RAR v4/v5 and the other
 * formats the archive toolbox does not parse itself. Read-only by design.
 */
import { ArchiveReader } from 'libarchive-wasm/dist/ArchiveReader.js'
import libarchive from 'libarchive-wasm/dist/libarchive.js'
import { wrapLibarchiveWasm } from 'libarchive-wasm/dist/wrapLibarchiveWasm.js'

export { ArchiveReader }

export async function createLibarchive(wasmBinary) {
  return wrapLibarchiveWasm(await libarchive({ wasmBinary, locateFile: (name) => name }))
}
