import { describe, expect, it } from 'vitest'
import { canvasIds, sanitizePanel, sanitizeState } from '@/core/ui/schema'

describe('sanitizePanel', () => {
  it('keeps declared fields and drops everything else', () => {
    const panel = sanitizePanel({
      nodes: [{ type: 'button', text: 'Go', action: 'run', onclick: 'alert(1)', style: 'position:fixed', innerHTML: '<img>' }],
    })
    expect(panel.nodes[0]).toEqual({ type: 'button', text: 'Go', action: 'run' })
  })

  it('drops unknown node types without failing the whole panel', () => {
    const panel = sanitizePanel({
      nodes: [{ type: 'script', text: 'x' }, { type: 'text', text: 'ok' }, { type: 'iframe', src: 'https://x' }],
    })
    expect(panel.nodes).toEqual([{ type: 'text', text: 'ok' }])
  })

  it('coerces wrong types away instead of passing them through', () => {
    const panel = sanitizePanel({ nodes: [{ type: 'slider', bind: 'q', min: '0', max: 100, step: NaN }] })
    expect(panel.nodes[0]).toEqual({ type: 'slider', bind: 'q', max: 100 })
  })

  it('caps nesting depth so a deep tree cannot hang the renderer', () => {
    let node: Record<string, unknown> = { type: 'text', text: 'leaf' }
    for (let i = 0; i < 50; i++) node = { type: 'stack', children: [node] }
    const panel = sanitizePanel({ nodes: [node] })
    let depth = 0
    let cursor = panel.nodes[0] as { children?: unknown[] } | undefined
    while (cursor?.children?.length) {
      depth++
      cursor = cursor.children[0] as { children?: unknown[] }
    }
    expect(depth).toBeLessThanOrEqual(12)
  })

  it('caps total node count', () => {
    const panel = sanitizePanel({ nodes: Array.from({ length: 5000 }, () => ({ type: 'separator' })) })
    expect(panel.nodes.length).toBeLessThanOrEqual(400)
  })

  it('bounds long strings', () => {
    const panel = sanitizePanel({ nodes: [{ type: 'text', text: 'x'.repeat(100_000) }] })
    expect((panel.nodes[0] as { text: string }).text.length).toBe(2000)
  })

  it('finds canvas ids at any depth', () => {
    const panel = sanitizePanel({
      nodes: [{ type: 'row', children: [{ type: 'stack', children: [{ type: 'canvas', id: 'stage' }] }] }, { type: 'canvas', id: 'mini' }],
    })
    expect(canvasIds(panel.nodes)).toEqual(['stage', 'mini'])
  })
})

describe('sanitizeState', () => {
  it('keeps primitives and numeric pairs only', () => {
    expect(
      sanitizeState({ s: 'x', n: 1, b: true, range: [1.5, 3], bad: { nested: 1 }, inf: Infinity, mixed: [1, 'a'] }),
    ).toEqual({ s: 'x', n: 1, b: true, range: [1.5, 3] })
  })
})

describe('media and reorder nodes', () => {
  it('keeps declared media bindings and normalises effects', () => {
    const panel = sanitizePanel({
      nodes: [
        {
          type: 'media', fileId: 'f1', range: 'range', crop: 'crop', cropAspect: 'aspect', markers: 'marks', meta: 'meta', height: 300,
          effects: { rotate: 'rot', volume: { bind: 'vol', scale: 0.01 }, bogus: 'x', speed: { bind: 7 }, hue: { bind: 'hue', scale: 'big' } },
          onclick: 'alert(1)',
        },
      ],
    })
    expect(panel.nodes[0]).toEqual({
      type: 'media', fileId: 'f1', range: 'range', crop: 'crop', cropAspect: 'aspect', markers: 'marks', meta: 'meta', height: 300,
      effects: { rotate: { bind: 'rot' }, volume: { bind: 'vol', scale: 0.01 }, hue: { bind: 'hue' } },
    })
  })

  it('bounds reorder items and coerces their text', () => {
    const items = Array.from({ length: 300 }, (_, i) => ({ label: i, detail: i % 2 ? 'odd' : undefined, extra: true }))
    const node = sanitizePanel({ nodes: [{ type: 'reorder', bind: 'order', items }] }).nodes[0] as { items: Array<Record<string, unknown>> }
    expect(node.items).toHaveLength(256)
    expect(node.items[0]).toEqual({ label: '0' })
    expect(node.items[1]).toEqual({ label: '1', detail: 'odd' })
  })

  it('allows marker-sized numeric arrays in state, but not unbounded ones', () => {
    const state = sanitizeState({ markers: Array.from({ length: 1000 }, (_, i) => i), crop: [0.1, 0.2, 0.3, 0.4], bad: [1, 'x'] })
    expect((state.markers as number[]).length).toBe(256)
    expect(state.crop).toEqual([0.1, 0.2, 0.3, 0.4])
    expect(state.bad).toBeUndefined()
  })
})
