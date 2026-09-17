import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CAPABILITIES, CATEGORY_LABEL, PLUGIN_API_VERSION } from '@/core/types'

/**
 * The guest runtime is plain JS injected into the sandbox, so it cannot import
 * the host's constants and keeps its own copies. A capability the host supports
 * but the runtime does not know makes every plugin declaring it fail to
 * register - which is how `secret`, `onnx` and `archive` were once unusable.
 */
const runtime = readFileSync(resolve(__dirname, '../src/core/sandbox/guest/runtime.js'), 'utf8')

function arrayLiteral(name: string): string[] {
  const match = new RegExp(`var ${name} = \\[([^\\]]*)\\]`).exec(runtime)
  if (!match) throw new Error(`${name} not found in runtime.js`)
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

describe('guest runtime manifest validation', () => {
  it('accepts exactly the host capabilities', () => {
    expect(arrayLiteral('VALID_CAPABILITIES').sort()).toEqual([...CAPABILITIES].sort())
  })

  it('stamps manifests with the current API version', () => {
    expect(runtime).toContain(`var API_VERSION = ${PLUGIN_API_VERSION}`)
  })

  it('accepts exactly the host tool categories', () => {
    expect(arrayLiteral('VALID_CATEGORIES').sort()).toEqual(Object.keys(CATEGORY_LABEL).sort())
  })
})
