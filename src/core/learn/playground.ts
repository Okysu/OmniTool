/**
 * Runs tutorial code for real, without installing it.
 *
 * Each edit boots the code in a fresh sandbox - the same `SandboxHost` installed
 * plugins use, with the same isolation - so what the tutorial shows is exactly
 * what the plugin would do once installed. The previous sandbox is disposed
 * first, and a late boot of stale code never replaces a newer one.
 *
 * Grants are fixed and modest: files, panels, the image helper, plugin storage
 * and local FFmpeg. Network, credentials and model downloads are never granted, whatever the code
 * declares; lessons explain those capabilities instead of exercising them.
 */
import { reactive } from 'vue'
import { SandboxHost } from '@/core/sandbox/host'
import { probeManifest, resolveDep } from '@/core/plugin/loader'
import { findPlugin } from '@/core/plugin/registry'
import type { Capability, PluginManifest } from '@/core/types'

export const PLAYGROUND_GRANTS: Capability[] = ['fs', 'ui', 'image', 'kv', 'ffmpeg']

export interface PlaygroundLog {
  level: 'log' | 'warn' | 'error'
  text: string
  at: number
}

export class Playground {
  readonly state = reactive({
    status: 'idle' as 'idle' | 'booting' | 'ready' | 'error',
    error: '',
    manifest: null as PluginManifest | null,
    revision: 0,
    logs: [] as PlaygroundLog[],
  })

  private host: SandboxHost | null = null
  private booting: Promise<SandboxHost> | null = null
  private generation = 0

  /** Boots `code`; resolves once the manifest is known (or the error is recorded). */
  async load(code: string): Promise<void> {
    const current = ++this.generation
    this.dispose(false)
    this.state.status = 'booting'
    this.state.error = ''
    this.state.logs = []

    const boot = (async () => {
      const { manifest, deps } = await probeManifest(code)
      // Storage, sessions and retained files are keyed by plugin id; tutorial code must never share them.
      if (findPlugin(manifest.id)) throw new Error(`插件 id「${manifest.id}」已被已安装的插件使用，教程里请换一个 id（例如 learn.${manifest.id.split('.').pop()}）`)
      const host = new SandboxHost({
        pluginId: manifest.id,
        pluginName: manifest.name,
        trusted: false,
        grants: new Set(PLAYGROUND_GRANTS.filter((c) => manifest.capabilities.includes(c))),
        onLog: (level, args) => this.log(level, args.join(' ')),
        dependencies: manifest.deps ?? [],
        resolveDependency: resolveDep,
      })
      await host.boot(code, deps.map((d) => ({ id: d.id, code: d.code, global: d.global, assets: d.assets })))
      return { host, manifest }
    })()

    this.booting = boot.then((r) => r.host)
    try {
      const { host, manifest } = await boot
      if (current !== this.generation) {
        host.dispose()
        return
      }
      this.host = host
      this.state.manifest = manifest
      this.state.status = 'ready'
      this.state.revision++
    } catch (error) {
      if (current !== this.generation) return
      this.state.status = 'error'
      this.state.error = error instanceof Error ? error.message : String(error)
      this.state.manifest = null
    }
  }

  /** The sandbox of the latest successful boot. */
  sandbox(): Promise<SandboxHost> {
    if (this.host) return Promise.resolve(this.host)
    if (this.booting) return this.booting
    return Promise.reject(new Error('代码尚未运行'))
  }

  log(level: PlaygroundLog['level'], text: string): void {
    this.state.logs.push({ level, text, at: Date.now() })
    if (this.state.logs.length > 200) this.state.logs.splice(0, this.state.logs.length - 200)
  }

  dispose(final = true): void {
    if (final) this.generation++
    this.host?.dispose()
    this.host = null
    this.booting = null
  }
}
