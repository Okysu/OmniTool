/**
 * The plugin registry: what is installed, what it may do, and the sandbox
 * instances backing it.
 *
 * Built-in tools are plugins too - same source format, same sandbox, same API.
 * They differ only in where the code comes from (bundled instead of fetched) and
 * in that their capability grants are pre-approved and they cannot be
 * uninstalled. Dogfooding the plugin API this way is the point: if a built-in
 * tool cannot be written against the public API, the API is incomplete.
 */
import { computed, reactive, shallowReactive, toRaw } from 'vue'
import { get as idbGet, set as idbSet } from 'idb-keyval'
import { SandboxHost } from '@/core/sandbox/host'
import { analyzeSource, type RiskReport } from './analyze'
import { probeManifest, resolveDep, resolveDeps, type ResolvedDep } from './loader'
import { BUILTIN_PLUGINS } from '@/plugins/builtin'
import { pushToast } from '@/core/ui/toast'
import type { Capability, PluginManifest, ToolManifest } from '@/core/types'

const STORE_KEY = 'omnitool.plugins.v1'

export type PluginOrigin = 'builtin' | 'local' | 'subscription'

export interface PluginRecord {
  id: string
  origin: PluginOrigin
  /** Where the code came from, for subscription plugins. */
  url?: string
  subscriptionId?: string
  code: string
  manifest: PluginManifest
  grants: Capability[]
  enabled: boolean
  installedAt: number
  updatedAt: number
}

export const plugins = shallowReactive<PluginRecord[]>([])

export const registryState = reactive({
  ready: false,
})

/* -------------------------------------------------------------------------- */
/* Derived views                                                              */
/* -------------------------------------------------------------------------- */

export interface ToolEntry {
  /** `${pluginId}/${toolId}` - stable across reloads, used in routes. */
  key: string
  pluginId: string
  pluginName: string
  origin: PluginOrigin
  tool: ToolManifest
}

export const allTools = computed<ToolEntry[]>(() =>
  plugins
    .filter((record) => record.enabled)
    .flatMap((record) =>
      record.manifest.tools.map((tool) => ({
        key: `${record.id}/${tool.id}`,
        pluginId: record.id,
        pluginName: record.manifest.name,
        origin: record.origin,
        tool,
      })),
    ),
)

export function findPlugin(id: string): PluginRecord | undefined {
  return plugins.find((record) => record.id === id)
}

export function findTool(key: string): ToolEntry | undefined {
  return allTools.value.find((entry) => entry.key === key)
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

async function persist(): Promise<void> {
  // Records are plain JSON by construction, but callers may hand them over
  // wrapped in Vue proxies (the review dialog keeps its candidate in a `ref`),
  // and IndexedDB refuses to clone a proxy. Store a detached snapshot - and
  // never fail quietly: a record that is not saved is uninstalled on reload.
  try {
    await idbSet(
      STORE_KEY,
      plugins.map((record) => JSON.parse(JSON.stringify(toRaw(record))) as PluginRecord),
    )
  } catch (error) {
    pushToast({
      level: 'error',
      title: '插件记录保存失败',
      message: `刷新页面后安装或授权变更可能丢失：${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

export async function initRegistry(): Promise<void> {
  if (registryState.ready) return
  const saved = ((await idbGet(STORE_KEY)) as PluginRecord[] | undefined) ?? []
  for (const record of saved) {
    // Built-ins are re-seeded below from the bundle, never from storage.
    if (record.origin === 'builtin') continue
    plugins.push(record)
  }
  await seedBuiltins(saved)
  registryState.ready = true
}

/**
 * Installs or refreshes the bundled plugins.
 *
 * Their manifests are read by booting each one in a throwaway sandbox, exactly
 * like a third-party plugin - so a mistake in a built-in manifest surfaces as a
 * visible install error rather than a silently broken tool.
 */
async function seedBuiltins(saved: PluginRecord[]): Promise<void> {
  for (const builtin of BUILTIN_PLUGINS) {
    const previous = saved.find((record) => record.id === builtin.id && record.origin === 'builtin')
    try {
      const { manifest } = await probeManifest(builtin.code, builtin.id)
      const record: PluginRecord = {
        id: manifest.id,
        origin: 'builtin',
        code: builtin.code,
        manifest,
        // Built-ins ship pre-approved; the user can still revoke in Settings.
        grants: previous ? previous.grants : [...manifest.capabilities],
        enabled: previous ? previous.enabled : true,
        installedAt: previous?.installedAt ?? Date.now(),
        updatedAt: Date.now(),
      }
      const index = plugins.findIndex((p) => p.id === record.id)
      if (index === -1) plugins.push(record)
      else plugins.splice(index, 1, record)
    } catch (error) {
      pushToast({
        level: 'error',
        title: '内置插件加载失败',
        message: `${builtin.id}: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  await persist()
}

/* -------------------------------------------------------------------------- */
/* Install                                                                    */
/* -------------------------------------------------------------------------- */

export interface InstallCandidate {
  code: string
  manifest: PluginManifest
  report: RiskReport
  deps: ResolvedDep[]
  origin: PluginOrigin
  url?: string
  subscriptionId?: string
  /** Present when this would replace an already-installed plugin. */
  existing?: PluginRecord
}

/**
 * Phase 1 of installing: evaluate the code in a zero-grant sandbox, read its
 * manifest, resolve its dependencies and produce a risk report - without
 * persisting anything. The UI shows this, the user decides, then `commitInstall`
 * runs.
 */
export async function prepareInstall(
  code: string,
  options: { origin: PluginOrigin; url?: string; subscriptionId?: string },
): Promise<InstallCandidate> {
  const { manifest, deps } = await probeManifest(code)
  const report = analyzeSource(code, manifest)
  return {
    code,
    manifest,
    report,
    deps,
    origin: options.origin,
    url: options.url,
    subscriptionId: options.subscriptionId,
    existing: findPlugin(manifest.id),
  }
}

/** Phase 2: persist the plugin with exactly the capabilities the user ticked. */
export async function commitInstall(proxied: InstallCandidate, grants: Capability[]): Promise<PluginRecord> {
  const candidate = toRaw(proxied)
  const existing = findPlugin(candidate.manifest.id)
  if (existing?.origin === 'builtin' && candidate.origin !== 'builtin') {
    throw new Error(`「${existing.manifest.name}」是内置插件，不能被同 id 的外部插件覆盖`)
  }

  // Only ever grant what the manifest asked for; the UI cannot widen this.
  const allowed = grants.filter((c) => candidate.manifest.capabilities.includes(c))

  const record: PluginRecord = {
    id: candidate.manifest.id,
    origin: candidate.origin,
    url: candidate.url,
    subscriptionId: candidate.subscriptionId,
    code: candidate.code,
    manifest: candidate.manifest,
    grants: allowed,
    enabled: true,
    installedAt: existing?.installedAt ?? Date.now(),
    updatedAt: Date.now(),
  }

  const index = plugins.findIndex((p) => p.id === record.id)
  if (index === -1) plugins.push(record)
  else plugins.splice(index, 1, record)

  disposeSandbox(record.id)
  await persist()
  return record
}

/* -------------------------------------------------------------------------- */
/* Mutations                                                                  */
/* -------------------------------------------------------------------------- */

export async function uninstall(id: string): Promise<void> {
  const record = findPlugin(id)
  if (!record) return
  if (record.origin === 'builtin') throw new Error('内置插件不可卸载，可在插件面板中停用')
  const index = plugins.indexOf(record)
  plugins.splice(index, 1)
  disposeSandbox(id)
  await persist()
}

export async function setEnabled(id: string, enabled: boolean): Promise<void> {
  const record = findPlugin(id)
  if (!record) return
  plugins.splice(plugins.indexOf(record), 1, { ...record, enabled, updatedAt: Date.now() })
  if (!enabled) disposeSandbox(id)
  await persist()
}

export async function setGrants(id: string, grants: Capability[]): Promise<void> {
  const record = findPlugin(id)
  if (!record) return
  const allowed = grants.filter((c) => record.manifest.capabilities.includes(c))
  plugins.splice(plugins.indexOf(record), 1, { ...record, grants: allowed, updatedAt: Date.now() })
  // Grants are captured when a sandbox boots, so a change needs a fresh one.
  disposeSandbox(id)
  await persist()
}

/* -------------------------------------------------------------------------- */
/* Sandbox pool                                                               */
/* -------------------------------------------------------------------------- */

const sandboxes = new Map<string, Promise<SandboxHost>>()

/**
 * Returns the running sandbox for a plugin, booting it on first use.
 *
 * Boot is lazy so that a hundred installed plugins cost nothing at startup, and
 * one sandbox is shared by all invocations of the same plugin so repeated runs
 * skip the ~50ms frame + dependency setup.
 */
export function getSandbox(record: PluginRecord): Promise<SandboxHost> {
  const running = sandboxes.get(record.id)
  if (running) return running

  const booting = (async () => {
    const host = new SandboxHost({
      pluginId: record.id,
      pluginName: record.manifest.name,
      trusted: record.origin === 'builtin',
      grants: new Set(record.grants),
      onLog: (level, args) => {
        const line = `[${record.manifest.name}] ${args.join(' ')}`
        if (level === 'error') console.error(line)
        else if (level === 'warn') console.warn(line)
        else console.info(line)
      },
      dependencies: record.manifest.deps ?? [],
      resolveDependency: resolveDep,
    })
    const deps = await resolveDeps(record.manifest.deps ?? [])
    await host.boot(
      record.code,
      deps.map((d) => ({ id: d.id, code: d.code, global: d.global, assets: d.assets })),
    )
    return host
  })()

  // A failed boot must not poison the pool - the next run should retry.
  booting.catch(() => sandboxes.delete(record.id))
  sandboxes.set(record.id, booting)
  return booting
}

export function disposeSandbox(id: string): void {
  const running = sandboxes.get(id)
  if (!running) return
  sandboxes.delete(id)
  void running.then((host) => host.dispose()).catch(() => {})
}

export function disposeAllSandboxes(): void {
  for (const id of [...sandboxes.keys()]) disposeSandbox(id)
}
