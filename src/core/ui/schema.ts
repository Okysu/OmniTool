/**
 * The declarative UI tree a plugin can publish.
 *
 * ## Why a tree instead of DOM access
 *
 * A plugin that could write DOM would have to reimplement every control to look
 * like the rest of the app, and would drift out of step the moment we restyled
 * anything. Here the plugin describes *what* it wants and the host renders it
 * with the same shadcn-vue components the built-in UI uses - so a third-party
 * tool is visually indistinguishable from a built-in one, for free, forever.
 *
 * It is also the cheaper security answer: no markup, no styles and no event
 * handlers ever cross the boundary, only this data. Nothing here can inject
 * script, and every string is rendered as text.
 *
 * ## The escape hatch
 *
 * Declarative trees cannot express pixel-level interaction - a video scrubber,
 * a crop rectangle, a waveform. For those, `canvas` hands the plugin a real
 * `OffscreenCanvas`, transferred into the sandbox, that it paints directly
 * while still being unable to touch anything else on the page.
 */

/** Two-way bound value types. */
export type UiValue = string | number | boolean | number[]

export type UiState = Record<string, UiValue>

/**
 * Previewed effects of a `media` node, each naming the state key that holds
 * it. `scale` converts the stored number to the effect's unit, so a plugin can
 * keep a 0–400 "%" slider and still preview `volume` (1 = unchanged) with
 * `{ bind: 'volume', scale: 0.01 }`.
 *
 * Units: rotate degrees (multiples of 90) · flipH/flipV/mute boolean ·
 * brightness -1..1 (additive, like ffmpeg eq) · contrast/saturation/speed/volume
 * multipliers (1 = unchanged) · hue degrees · fadeIn/fadeOut seconds.
 */
export const EFFECT_NAMES = [
  'rotate', 'flipH', 'flipV', 'brightness', 'contrast', 'saturation', 'hue',
  'speed', 'volume', 'mute', 'fadeIn', 'fadeOut',
] as const
export type UiEffectName = (typeof EFFECT_NAMES)[number]
export type UiEffects = Partial<Record<UiEffectName, { bind: string; scale?: number }>>

interface NodeBase {
  /** Hidden when the bound predicate fails. Same shape as a param's `when`. */
  when?: { key: string; equals: unknown | unknown[] }
}

export type UiNode =
  /* ----------------------------- layout ----------------------------- */
  | (NodeBase & { type: 'stack'; gap?: number; children: UiNode[] })
  | (NodeBase & { type: 'row'; gap?: number; align?: 'start' | 'center' | 'end' | 'between'; wrap?: boolean; children: UiNode[] })
  | (NodeBase & { type: 'section'; title?: string; children: UiNode[] })
  | (NodeBase & { type: 'separator' })

  /* ------------------------------ text ------------------------------ */
  | (NodeBase & { type: 'text'; text: string; variant?: 'title' | 'body' | 'muted' | 'mono' })
  | (NodeBase & { type: 'badge'; text: string; tone?: 'default' | 'secondary' | 'outline' | 'success' | 'warning' | 'destructive' })
  | (NodeBase & { type: 'alert'; title?: string; text: string; tone?: 'info' | 'success' | 'warning' | 'destructive' })

  /* ---------------------------- controls ---------------------------- */
  | (NodeBase & { type: 'input'; bind: string; label?: string; hint?: string; placeholder?: string; inputType?: 'text' | 'number'; min?: number; max?: number; step?: number; suffix?: string })
  | (NodeBase & { type: 'textarea'; bind: string; label?: string; hint?: string; placeholder?: string; rows?: number; mono?: boolean })
  | (NodeBase & { type: 'select'; bind: string; label?: string; hint?: string; options: Array<{ value: string; label: string }> })
  | (NodeBase & { type: 'segmented'; bind: string; label?: string; hint?: string; options: Array<{ value: string; label: string }> })
  | (NodeBase & { type: 'slider'; bind: string; label?: string; hint?: string; min: number; max: number; step?: number; suffix?: string })
  | (NodeBase & { type: 'switch'; bind: string; label?: string; hint?: string })
  | (NodeBase & { type: 'color'; bind: string; label?: string; hint?: string })
  | (NodeBase & { type: 'button'; text: string; action: string; variant?: 'default' | 'outline' | 'secondary' | 'ghost' | 'destructive'; icon?: string; disabled?: boolean; busy?: boolean })

  /* --------------------------- rich widgets ------------------------- */
  /** Inline preview of a workspace file: image, video, audio, PDF or text. */
  | (NodeBase & { type: 'preview'; fileId: string; height?: number })
  /**
   * Media scrubber bound to a `[start, end]` pair of seconds. The host owns
   * playback and the handles; the plugin just reads the range.
   */
  | (NodeBase & { type: 'timeline'; fileId: string; bind: string; duration?: number })
  /**
   * Full media editor: player, strip, and whichever editors the plugin binds -
   * `range` ([start, end] s), `crop` ([x, y, w, h] fractions, [] hides the box),
   * `cropAspect` (px ratio, 0 = free), `markers` (seconds), `meta` (the widget
   * writes [duration, width, height]) - plus live `effects` previews.
   */
  | (NodeBase & {
      type: 'media'
      fileId: string
      range?: string
      crop?: string
      cropAspect?: string
      markers?: string
      meta?: string
      effects?: UiEffects
      height?: number
    })
  /** Reorderable list bound to a permutation of item indices. */
  | (NodeBase & { type: 'reorder'; bind: string; label?: string; items: Array<{ label: string; detail?: string }> })
  /**
   * A drawing surface. On first render the host transfers an `OffscreenCanvas`
   * to the plugin, which paints it directly - no pixels cross back.
   */
  | (NodeBase & { type: 'canvas'; id: string; aspect?: number; height?: number; interactive?: boolean })
  /** Key/value readout, for probe results and summaries. */
  | (NodeBase & { type: 'facts'; rows: Array<{ label: string; value: string }> })
  /** Monospaced, scrollable text with a copy button drawn by the host (plugins cannot reach the clipboard). */
  | (NodeBase & { type: 'code'; text: string; label?: string; height?: number; wrap?: boolean })

export interface UiPanel {
  /** Rendered above the run button in the tool's parameter column. */
  nodes: UiNode[]
  /** Initial/updated values for bound controls. */
  state?: UiState
  /** Replaces the run button's label while the plugin is driving. */
  runLabel?: string
  /** Disables the run button, e.g. until the plugin validates its inputs. */
  runDisabled?: boolean
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

const LAYOUT = new Set(['stack', 'row', 'section'])
const LEAF = new Set([
  'separator', 'text', 'badge', 'alert', 'input', 'textarea', 'select', 'segmented',
  'slider', 'switch', 'color', 'button', 'preview', 'timeline', 'media', 'reorder', 'canvas', 'facts', 'code',
])
/** `code` holds generated output (decoded tokens, diffs, type definitions), so it gets a larger bound. */
const MAX_CODE_TEXT = 200_000

/** Depth cap: a cyclic or absurdly nested tree must not be able to hang render. */
const MAX_DEPTH = 12
const MAX_NODES = 400
/** Longest numeric array in state: marker lists and clip orders, not bulk data. */
const MAX_ARRAY = 256

/**
 * Normalises an untrusted tree into one the renderer can walk without further
 * checks. Unknown node types are dropped rather than throwing, so one bad node
 * cannot blank a plugin's whole panel.
 */
export function sanitizePanel(raw: unknown): UiPanel {
  const input = (raw ?? {}) as Record<string, unknown>
  let budget = MAX_NODES

  function walk(node: unknown, depth: number): UiNode | null {
    if (budget <= 0 || depth > MAX_DEPTH) return null
    if (!node || typeof node !== 'object') return null
    const source = node as Record<string, unknown>
    const type = String(source.type ?? '')
    if (!LAYOUT.has(type) && !LEAF.has(type)) return null
    budget--

    const out: Record<string, unknown> = { type }

    if (source.when && typeof source.when === 'object') {
      const when = source.when as Record<string, unknown>
      if (typeof when.key === 'string') out.when = { key: when.key, equals: when.equals }
    }

    // Copy only the fields the schema declares, coercing each. Anything else a
    // plugin attaches is discarded rather than reaching a component as props.
    for (const key of ['text', 'title', 'hint', 'label', 'placeholder', 'bind', 'id', 'fileId', 'action', 'icon', 'suffix', 'variant', 'tone', 'align', 'inputType', 'range', 'crop', 'cropAspect', 'markers', 'meta']) {
      if (typeof source[key] === 'string') out[key] = (source[key] as string).slice(0, 2000)
    }
    for (const key of ['gap', 'rows', 'min', 'max', 'step', 'height', 'aspect', 'duration']) {
      if (typeof source[key] === 'number' && Number.isFinite(source[key] as number)) out[key] = source[key]
    }
    for (const key of ['wrap', 'mono', 'disabled', 'busy', 'interactive']) {
      if (typeof source[key] === 'boolean') out[key] = source[key]
    }
    if (type === 'code') out.text = typeof source.text === 'string' ? source.text.slice(0, MAX_CODE_TEXT) : ''

    if (Array.isArray(source.options)) {
      out.options = source.options.slice(0, 200).map((option) => {
        const o = (option ?? {}) as Record<string, unknown>
        return { value: String(o.value ?? ''), label: String(o.label ?? o.value ?? '').slice(0, 200) }
      })
    }
    if (Array.isArray(source.rows) && type === 'facts') {
      out.rows = source.rows.slice(0, 100).map((row) => {
        const r = (row ?? {}) as Record<string, unknown>
        return { label: String(r.label ?? '').slice(0, 200), value: String(r.value ?? '').slice(0, 500) }
      })
    }

    if (type === 'media' && source.effects && typeof source.effects === 'object') {
      const effects: Record<string, { bind: string; scale?: number }> = {}
      for (const name of EFFECT_NAMES) {
        const spec = (source.effects as Record<string, unknown>)[name]
        // A bare string is shorthand for `{ bind }`.
        const bind = typeof spec === 'string' ? spec : (spec as { bind?: unknown } | null)?.bind
        if (typeof bind !== 'string' || !bind) continue
        const scale = (spec as { scale?: unknown })?.scale
        effects[name] = typeof scale === 'number' && Number.isFinite(scale) ? { bind: bind.slice(0, 200), scale } : { bind: bind.slice(0, 200) }
      }
      out.effects = effects
    }
    if (type === 'reorder') {
      out.items = (Array.isArray(source.items) ? source.items : []).slice(0, MAX_ARRAY).map((item) => {
        const i = (item ?? {}) as Record<string, unknown>
        return {
          label: String(i.label ?? '').slice(0, 200),
          ...(i.detail !== undefined ? { detail: String(i.detail).slice(0, 200) } : {}),
        }
      })
    }

    if (LAYOUT.has(type)) {
      const children = Array.isArray(source.children) ? source.children : []
      out.children = children.map((child) => walk(child, depth + 1)).filter(Boolean)
    }

    return out as unknown as UiNode
  }

  const nodes = (Array.isArray(input.nodes) ? input.nodes : [])
    .map((node) => walk(node, 0))
    .filter((node): node is UiNode => node !== null)

  return {
    nodes,
    state: sanitizeState(input.state),
    runLabel: typeof input.runLabel === 'string' ? input.runLabel.slice(0, 40) : undefined,
    runDisabled: input.runDisabled === true,
  }
}

export function sanitizeState(raw: unknown): UiState {
  const out: UiState = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, 200)) {
    if (typeof value === 'string') out[key] = value.slice(0, 20000)
    else if (typeof value === 'boolean') out[key] = value
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    else if (Array.isArray(value) && value.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      out[key] = value.slice(0, MAX_ARRAY) as number[]
    }
  }
  return out
}

/** Collects every `canvas` node id in a panel, for surface allocation. */
export function canvasIds(nodes: UiNode[]): string[] {
  const ids: string[] = []
  const walk = (list: UiNode[]) => {
    for (const node of list) {
      if (node.type === 'canvas') ids.push(node.id)
      else if ('children' in node) walk(node.children)
    }
  }
  walk(nodes)
  return ids
}
