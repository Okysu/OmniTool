/**
 * Remote plugin subscriptions.
 *
 * A subscription is a URL that yields either a single plugin script, or a JSON
 * index listing several. Refreshing re-fetches everything it points at.
 *
 * Update policy - the part that matters:
 *   - A refreshed plugin whose capability set is unchanged is applied silently,
 *     keeping the grants the user already gave.
 *   - A refreshed plugin that asks for *new* capabilities is held back and
 *     surfaced for review. A subscription can never widen its own permissions.
 */
import { reactive, shallowReactive } from 'vue'
import { get as idbGet, set as idbSet } from 'idb-keyval'
import { nanoid } from '@/lib/id'
import { fetchSource } from './loader'
import { commitInstall, findPlugin, plugins, prepareInstall, uninstall, type InstallCandidate } from './registry'
import type { Capability } from '@/core/types'

const STORE_KEY = 'omnitool.subscriptions.v1'
/** Hard cap on entries in one subscription index. */
const MAX_ENTRIES = 100

export interface Subscription {
  id: string
  url: string
  name: string
  description?: string
  addedAt: number
  lastSyncedAt: number | null
  lastError: string | null
  /** Plugin ids currently provided by this subscription. */
  pluginIds: string[]
}

export const subscriptions = shallowReactive<Subscription[]>([])

export const subscriptionState = reactive({
  ready: false,
  syncing: [] as string[],
})

/** Refreshed plugins that requested new capabilities and await user review. */
export const pendingReview = shallowReactive<InstallCandidate[]>([])

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

async function persist(): Promise<void> {
  await idbSet(
    STORE_KEY,
    subscriptions.map((s) => ({ ...s })),
  ).catch(() => {})
}

export async function initSubscriptions(): Promise<void> {
  if (subscriptionState.ready) return
  const saved = ((await idbGet(STORE_KEY)) as Subscription[] | undefined) ?? []
  subscriptions.push(...saved)
  subscriptionState.ready = true
}

/* -------------------------------------------------------------------------- */
/* Index parsing                                                              */
/* -------------------------------------------------------------------------- */

interface IndexEntry {
  id?: string
  name?: string
  /** Absolute or relative to the index URL. */
  url?: string
  /** Inline source, for single-file subscriptions. */
  code?: string
}

interface ParsedIndex {
  name: string
  description?: string
  entries: IndexEntry[]
}

/**
 * Accepts either a JSON index or a bare plugin script, so a user can paste
 * `https://example.com/my-tool.js` and it just works.
 */
function parseIndex(url: string, body: string): ParsedIndex {
  const trimmed = body.trimStart()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return { name: filenameOf(url), entries: [{ url, code: body }] }
  }
  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    // Looked like JSON but is not - treat it as a script rather than failing.
    return { name: filenameOf(url), entries: [{ url, code: body }] }
  }

  const list = Array.isArray(data) ? data : (data as { plugins?: unknown }).plugins
  if (!Array.isArray(list)) throw new Error('订阅格式无法识别：期望 { plugins: [...] } 或一段插件脚本')
  if (list.length > MAX_ENTRIES) throw new Error(`订阅条目超过 ${MAX_ENTRIES} 个上限`)

  const meta = Array.isArray(data) ? {} : (data as Record<string, unknown>)
  return {
    name: typeof meta.name === 'string' ? meta.name : filenameOf(url),
    description: typeof meta.description === 'string' ? meta.description : undefined,
    entries: list.map((raw) => {
      const entry = raw as Record<string, unknown>
      return {
        id: typeof entry.id === 'string' ? entry.id : undefined,
        name: typeof entry.name === 'string' ? entry.name : undefined,
        url: typeof entry.url === 'string' ? new URL(entry.url, url).href : undefined,
        code: typeof entry.code === 'string' ? entry.code : undefined,
      }
    }),
  }
}

function filenameOf(url: string): string {
  try {
    const path = new URL(url).pathname
    return path.split('/').filter(Boolean).pop() || new URL(url).hostname
  } catch {
    return url
  }
}

/* -------------------------------------------------------------------------- */
/* Sync                                                                       */
/* -------------------------------------------------------------------------- */

export interface SyncOutcome {
  /** Newly-seen plugins the user has not reviewed yet. */
  fresh: InstallCandidate[]
  /** Updates applied silently because the capability set did not change. */
  updated: string[]
  /** Updates held back because they asked for new capabilities. */
  needsReview: InstallCandidate[]
  errors: string[]
}

/**
 * Fetches a subscription and works out what changed.
 *
 * Nothing in `fresh` or `needsReview` is installed - those need an explicit
 * `commitInstall` from the review dialog.
 */
export async function syncSubscription(subscription: Subscription): Promise<SyncOutcome> {
  const outcome: SyncOutcome = { fresh: [], updated: [], needsReview: [], errors: [] }
  if (subscriptionState.syncing.includes(subscription.id)) return outcome
  subscriptionState.syncing.push(subscription.id)

  try {
    const index = parseIndex(subscription.url, await fetchSource(subscription.url))
    const seen: string[] = []

    for (const entry of index.entries) {
      try {
        const code = entry.code ?? (entry.url ? await fetchSource(entry.url) : null)
        if (code === null) throw new Error('条目既没有 url 也没有 code')

        const candidate = await prepareInstall(code, {
          origin: 'subscription',
          url: entry.url,
          subscriptionId: subscription.id,
        })
        seen.push(candidate.manifest.id)

        const existing = findPlugin(candidate.manifest.id)
        if (!existing) {
          outcome.fresh.push(candidate)
          continue
        }
        if (existing.origin === 'builtin') {
          throw new Error(`与内置插件 id 冲突：${candidate.manifest.id}`)
        }

        const wants = candidate.manifest.capabilities
        const known = new Set(existing.manifest.capabilities)
        const widened = wants.filter((c) => !known.has(c))

        if (widened.length > 0) {
          outcome.needsReview.push(candidate)
        } else if (existing.code !== candidate.code) {
          // Carry the user's existing grants forward, intersected with the new
          // manifest in case the update dropped a capability.
          await commitInstall(candidate, existing.grants as Capability[])
          outcome.updated.push(candidate.manifest.id)
        }
      } catch (error) {
        outcome.errors.push(`${entry.name ?? entry.url ?? entry.id ?? '(未命名条目)'}: ${describe(error)}`)
      }
    }

    // Plugins the subscription no longer lists stay installed but are marked as
    // orphaned by clearing them from `pluginIds`; the UI offers to remove them.
    update(subscription.id, {
      name: index.name,
      description: index.description,
      pluginIds: seen,
      lastSyncedAt: Date.now(),
      lastError: outcome.errors.length ? outcome.errors.join('\n') : null,
    })
  } catch (error) {
    outcome.errors.push(describe(error))
    update(subscription.id, { lastSyncedAt: Date.now(), lastError: describe(error) })
  } finally {
    const index = subscriptionState.syncing.indexOf(subscription.id)
    if (index !== -1) subscriptionState.syncing.splice(index, 1)
    await persist()
  }

  for (const candidate of [...outcome.needsReview, ...outcome.fresh]) {
    if (!pendingReview.some((c) => c.manifest.id === candidate.manifest.id)) pendingReview.push(candidate)
  }
  return outcome
}

function update(id: string, patch: Partial<Subscription>): void {
  const index = subscriptions.findIndex((s) => s.id === id)
  if (index === -1) return
  subscriptions.splice(index, 1, { ...subscriptions[index], ...patch })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* -------------------------------------------------------------------------- */
/* Mutations                                                                  */
/* -------------------------------------------------------------------------- */

export async function addSubscription(url: string): Promise<Subscription> {
  const normalized = new URL(url, location.href).href
  const existing = subscriptions.find((s) => s.url === normalized)
  if (existing) return existing

  const subscription: Subscription = {
    id: nanoid(10),
    url: normalized,
    name: filenameOf(normalized),
    addedAt: Date.now(),
    lastSyncedAt: null,
    lastError: null,
    pluginIds: [],
  }
  subscriptions.push(subscription)
  await persist()
  return subscription
}

/** Removes a subscription. Its plugins stay installed unless `purge` is set. */
export async function removeSubscription(id: string, purge = false): Promise<string[]> {
  const index = subscriptions.findIndex((s) => s.id === id)
  if (index === -1) return []
  const [removed] = subscriptions.splice(index, 1)
  await persist()

  const orphans = plugins.filter((p) => p.subscriptionId === removed.id).map((p) => p.id)
  if (purge) {
    for (const pluginId of orphans) await uninstall(pluginId)
  }
  return orphans
}

export function dismissReview(pluginId: string): void {
  const index = pendingReview.findIndex((c) => c.manifest.id === pluginId)
  if (index !== -1) pendingReview.splice(index, 1)
}

export async function syncAll(): Promise<void> {
  for (const subscription of [...subscriptions]) await syncSubscription(subscription)
}
