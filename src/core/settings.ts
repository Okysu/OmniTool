/**
 * User preferences. Persisted to localStorage (small, synchronous, survives a
 * reload) - file bytes live in the VFS, plugin records in IndexedDB.
 */
import { reactive, watch } from 'vue'
import type { ModelSource } from '@/core/capabilities/model-source'

export type ThemeMode = 'light' | 'dark' | 'system'

export interface Settings {
  theme: ThemeMode
  /**
   * Primary colour, expressed in OKLCH so a single channel can be retargeted
   * without re-deriving a palette. `null` on either field means "keep the
   * shadcn-vue preset's own primary untouched".
   */
  accentHue: number | null
  accentChroma: number
  /** Corner radius in rem. */
  radius: number
  /** Raw CSS injected after every stylesheet. Advanced users only. */
  customCss: string
  /** Let plugins reach localhost / private ranges through `host.net.fetch`. */
  allowLocalNetwork: boolean
  /** Refresh remote plugin subscriptions on startup. */
  autoUpdateSubscriptions: boolean
  /** How many tool invocations may run at once. */
  concurrency: number
  /**
   * Use the multi-threaded FFmpeg core. On by default; the toggle is an escape
   * hatch for engines where the pthread pool misbehaves.
   */
  ffmpegMultithread: boolean
  /** Where model files are downloaded from; see core/capabilities/model-source.ts. */
  modelSource: ModelSource
  /** Endpoint used when `modelSource` is `custom`. */
  modelSourceUrl: string
  /** Tool ids the user pinned to the top of the sidebar. */
  pinned: string[]
  /** Most recently opened tool keys, newest first. Feeds the command palette. */
  recentTools: string[]
}

// v2: the token colour space changed from HSL triplets to OKLCH, so v1 blobs
// (which carry an HSL-era accent) are deliberately dropped rather than migrated.
const STORAGE_KEY = 'omnitool.settings.v2'
const THEME_KEY = 'omnitool.theme'

const DEFAULTS: Settings = {
  theme: 'system',
  // null = inherit the preset's primary. The panel only overrides once the user
  // actually moves the hue slider.
  accentHue: null,
  accentChroma: 0.15,
  radius: 0.45,
  customCss: '',
  allowLocalNetwork: false,
  autoUpdateSubscriptions: true,
  concurrency: 2,
  ffmpegMultithread: true,
  modelSource: 'official',
  modelSourceUrl: '',
  pinned: [],
  recentTools: [],
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) }
  } catch {
    return { ...DEFAULTS }
  }
}

export const settings = reactive<Settings>(load())

const RECENT_LIMIT = 8

export function recordRecentTool(key: string): void {
  settings.recentTools = [key, ...settings.recentTools.filter((k) => k !== key)].slice(0, RECENT_LIMIT)
}

export function resetAppearance(): void {
  settings.accentHue = DEFAULTS.accentHue
  settings.accentChroma = DEFAULTS.accentChroma
  settings.radius = DEFAULTS.radius
  settings.customCss = ''
}

/* -------------------------------------------------------------------------- */
/* Live application                                                           */
/* -------------------------------------------------------------------------- */

let themeStyle: HTMLStyleElement | null = null
let customStyle: HTMLStyleElement | null = null

function styleEl(id: string): HTMLStyleElement {
  let el = document.getElementById(id) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = id
    document.head.append(el)
  }
  return el
}

function applyTheme(): void {
  const dark =
    settings.theme === 'dark' ||
    (settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  try {
    localStorage.setItem(THEME_KEY, settings.theme)
  } catch {
    /* private mode */
  }
}

/**
 * Writes the user's appearance overrides.
 *
 * These land in OKLCH because `@theme inline` in styles/index.css consumes the
 * token with a bare `var()` - a value in any other notation would resolve to an
 * invalid colour and silently blank out every primary-tinted surface.
 *
 * Lightness is fixed per theme (matching the preset's own light/dark primaries);
 * only hue and chroma are user-steerable.
 */
function applyTokens(): void {
  themeStyle ??= styleEl('omnitool-theme')

  const rules: string[] = [`:root{--radius:${settings.radius}rem}`]

  if (settings.accentHue !== null) {
    const h = Math.round(settings.accentHue)
    const c = Math.max(0, Math.min(0.37, settings.accentChroma)).toFixed(3)
    const light = `oklch(0.53 ${c} ${h})`
    const dark = `oklch(0.72 ${c} ${h})`
    rules.push(
      `:root{--primary:${light};--ring:${light};--accent:${light};--sidebar-primary:${light};--sidebar-accent:${light}}`,
      `.dark{--primary:${dark};--ring:${dark};--accent:${dark};--sidebar-primary:${dark};--sidebar-accent:${dark}}`,
    )
  }

  themeStyle.textContent = rules.join('\n')
}

function applyCustomCss(): void {
  customStyle ??= styleEl('omnitool-custom')
  customStyle.textContent = settings.customCss
}

export function initSettings(): void {
  applyTheme()
  applyTokens()
  applyCustomCss()

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settings.theme === 'system') applyTheme()
  })

  watch(() => settings.theme, applyTheme)
  watch(() => [settings.accentHue, settings.accentChroma, settings.radius], applyTokens)
  watch(() => settings.customCss, applyCustomCss)
  watch(
    settings,
    () => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
      } catch {
        /* quota or private mode */
      }
    },
    { deep: true },
  )
}
