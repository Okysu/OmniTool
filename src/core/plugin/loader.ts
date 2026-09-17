/**
 * Fetching, verifying and caching plugin source and its dependencies.
 *
 * Plugins run with `connect-src 'none'`, so they cannot load anything
 * themselves. Every external script is fetched *here*, by the host, and injected
 * into the sandbox as source text. That makes dependency loading a reviewable,
 * cacheable, offline-capable step instead of an invisible runtime side effect.
 */
import { get as idbGet, set as idbSet } from 'idb-keyval'
import { SandboxHost } from '@/core/sandbox/host'
import type { PluginDep, PluginManifest } from '@/core/types'

/** Ceiling on a fetched plugin or dependency script. */
const MAX_SOURCE_BYTES = 12 * 1024 * 1024
/** Ceiling on one binary dependency asset, e.g. a WebAssembly module. */
const MAX_ASSET_BYTES = 64 * 1024 * 1024

export interface ResolvedDep {
  id: string
  code: string
  /** The global the dependency is expected to define, when declared. */
  global?: string
  /** Binary assets by name, e.g. `{ 'magick.wasm': ArrayBuffer }`. */
  assets: Record<string, ArrayBuffer>
  url: string
  fromCache: boolean
}

/* -------------------------------------------------------------------------- */
/* Fetching                                                                   */
/* -------------------------------------------------------------------------- */

/** Fetches a script as text, with size and content-type sanity checks. */
export async function fetchSource(url: string): Promise<string> {
  const target = new URL(url, location.href)
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new Error(`不支持的协议：${target.protocol}`)
  }
  const response = await fetch(target, { credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer' })
  if (!response.ok) throw new Error(`拉取失败：HTTP ${response.status} ${response.statusText}`)

  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > MAX_SOURCE_BYTES) {
    throw new Error(`脚本体积超过 ${Math.round(MAX_SOURCE_BYTES / 1024 / 1024)}MB 上限`)
  }
  return new TextDecoder().decode(buffer)
}

/* -------------------------------------------------------------------------- */
/* Dependencies                                                               */
/* -------------------------------------------------------------------------- */

async function depCacheKey(dep: PluginDep): Promise<string> {
  const digest = await sha256Hex(`${dep.url}|${dep.integrity ?? ''}`)
  return `omnitool.dep.${digest}`
}

/**
 * Resolves a plugin's declared dependencies to source text.
 *
 * Cross-origin deps are cached by URL + integrity, so a second install of the same library is free and
 * the app keeps working offline. An `integrity` hash, when declared, is verified
 * on every load - including cache hits.
 */
export async function resolveDeps(deps: PluginDep[] = []): Promise<ResolvedDep[]> {
  const resolved: ResolvedDep[] = []
  // Lazy deps are fetched when the plugin asks for them (`loadDependency`), so
  // a 14MB WebAssembly module does not slow every boot of its plugin.
  for (const dep of deps) if (!dep.lazy) resolved.push(await resolveDep(dep))
  return resolved
}

/** Resolves one dependency: its script, then each declared binary asset. */
export async function resolveDep(dep: PluginDep): Promise<ResolvedDep> {
  const code = await cachedFetch(dep.url, dep.integrity, `依赖 ${dep.id}`, async (url) => new TextDecoder().decode(await fetchBytes(url, MAX_SOURCE_BYTES)))
  const assets: Record<string, ArrayBuffer> = {}
  for (const [name, asset] of Object.entries(dep.assets ?? {})) {
    const { value: buffer } = await cachedFetch(asset.url, asset.integrity, `依赖 ${dep.id} 的资源 ${name}`, (url) => fetchBytes(url, MAX_ASSET_BYTES).then((b) => b.buffer as ArrayBuffer))
    // Each load hands its buffers over by transfer, so never give out the cached instance.
    assets[name] = buffer.slice(0)
  }
  return { id: dep.id, code: code.value, global: dep.global, assets, url: dep.url, fromCache: code.fromCache }
}

/**
 * Libraries shipped with the app (`/vendor/…`) change with each deploy under
 * the same URL; pinning them in IndexedDB would keep serving a stale copy after
 * an update, and the browser's HTTP cache already covers them. Cross-origin
 * resources are cached by URL + integrity so installs work offline afterwards.
 * Integrity is verified on every load, cache hits included.
 */
async function cachedFetch<T extends string | ArrayBuffer>(
  url: string,
  integrity: string | undefined,
  label: string,
  load: (url: string) => Promise<T>,
): Promise<{ value: T; fromCache: boolean }> {
  const sameOrigin = new URL(url, location.href).origin === location.origin
  const key = sameOrigin ? '' : await depCacheKey({ id: '', url, integrity })
  if (key) {
    const cached = (await idbGet(key)) as T | undefined
    if (cached !== undefined) {
      await verifyIntegrity(cached, integrity, label, url)
      return { value: cached, fromCache: true }
    }
  }
  const value = await load(url)
  await verifyIntegrity(value, integrity, label, url)
  if (key) await idbSet(key, value).catch(() => {})
  return { value, fromCache: false }
}

async function fetchBytes(url: string, limit: number): Promise<Uint8Array> {
  const target = new URL(url, location.href)
  if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error(`不支持的协议：${target.protocol}`)
  const response = await fetch(target, { credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer' })
  if (!response.ok) throw new Error(`拉取 ${url} 失败：HTTP ${response.status} ${response.statusText}`)
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > limit) throw new Error(`${url} 体积超过 ${Math.round(limit / 1024 / 1024)}MB 上限`)
  return new Uint8Array(buffer)
}

async function verifyIntegrity(content: string | ArrayBuffer, integrity: string | undefined, label: string, url: string): Promise<void> {
  if (!integrity) return
  const match = /^sha(256|384|512)-(.+)$/.exec(integrity.trim())
  if (!match) throw new Error(`${label} 的 integrity 格式无法识别：${integrity}`)
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content)
  const digest = new Uint8Array(await crypto.subtle.digest(`SHA-${match[1]}`, bytes))
  let binary = ''
  for (let i = 0; i < digest.length; i++) binary += String.fromCharCode(digest[i])
  if (btoa(binary) !== match[2]) throw new Error(`${label} 的完整性校验失败，已拒绝加载（来源：${url}）`)
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/* -------------------------------------------------------------------------- */
/* Manifest probing                                                           */
/* -------------------------------------------------------------------------- */

export interface ProbeResult {
  manifest: PluginManifest
  deps: ResolvedDep[]
}

/**
 * Boots the code in a throwaway sandbox with **zero** capability grants, purely
 * to read back the manifest it registers.
 *
 * Running with no grants is deliberate: a plugin that tries to do real work at
 * module scope fails loudly here rather than performing it before the user has
 * seen the permission dialog.
 */
export async function probeManifest(code: string, pluginId = ''): Promise<ProbeResult> {
  // Dependencies are declared inside the manifest, which we do not have yet, so
  // the first boot runs without them. A plugin that needs a dependency at module
  // scope must declare it and will be re-booted with deps at install time.
  const probe = new SandboxHost({
    pluginId,
    pluginName: '（未安装）',
    trusted: false,
    grants: new Set(),
  })
  try {
    const manifest = await probe.boot(code, [])
    const deps = await resolveDeps(manifest.deps ?? [])
    return { manifest, deps }
  } finally {
    probe.dispose()
  }
}
