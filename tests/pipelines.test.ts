/**
 * Pipeline runner semantics with fake tools: input routing by `accept`,
 * per-file fan-out, defaults, failure and cancellation, intermediate cleanup.
 */
import { describe, expect, it } from 'vitest'
import { runPipeline, validatePipeline, type RunnerDeps, type StepTool } from '@/core/pipelines/runner'
import { matchesAccept } from '@/core/plugin/params'
import type { ParamValues, ToolManifest } from '@/core/types'

type Call = { key: string; inputs: string[]; params: ParamValues }

function world(tools: Array<Partial<ToolManifest> & { id: string; produce: (inputs: string[], params: ParamValues) => Array<{ name: string; type: string }> | Error }>) {
  const files = new Map<string, { name: string; type: string }>()
  let seq = 0
  const add = (name: string, type: string) => {
    const id = `f${++seq}`
    files.set(id, { name, type })
    return id
  }
  const calls: Call[] = []
  const removed: string[] = []
  const byKey = new Map(tools.map((t) => [`p/${t.id}`, t]))
  const deps: RunnerDeps = {
    findTool: (key) => {
      const t = byKey.get(key)
      return t ? ({ key, tool: { name: t.id, category: 'other', ...t } as ToolManifest } satisfies StepTool) : undefined
    },
    fileInfo: (id) => files.get(id),
    removeFile: async (id) => {
      removed.push(id)
      files.delete(id)
    },
    invoke: async (step, inputs, params, signal) => {
      calls.push({ key: step.key, inputs, params })
      await Promise.resolve()
      if (signal.aborted) throw new Error('已取消')
      const out = byKey.get(step.key)!.produce(inputs, params)
      if (out instanceof Error) throw out
      return { outputs: out.map((f) => add(f.name, f.type)), taskId: `task-${calls.length}` }
    },
  }
  return { deps, add, files, calls, removed }
}

const step = (id: string, params: ParamValues = {}) => ({ id, toolKey: `p/${id}`, params })
const run = (w: ReturnType<typeof world>, steps: ReturnType<typeof step>[], inputs: string[], extra: Partial<{ cleanup: boolean; signal: AbortSignal }> = {}) =>
  runPipeline(steps, inputs, w.deps, { signal: extra.signal ?? new AbortController().signal, cleanup: extra.cleanup ?? false })

describe('accept matching', () => {
  it('handles extensions, wildcards and exact types', () => {
    expect(matchesAccept({ name: 'a.PDF', type: '' }, ['.pdf'])).toBe(true)
    expect(matchesAccept({ name: 'a.png', type: 'image/png' }, ['image/*'])).toBe(true)
    expect(matchesAccept({ name: 'a.png', type: 'image/png' }, ['application/pdf'])).toBe(false)
    expect(matchesAccept({ name: 'x', type: 'text/plain' }, [])).toBe(true)
  })
})

describe('pipeline runner', () => {
  const tools = () =>
    world([
      { id: 'render', accept: ['application/pdf'], multiple: true, params: [{ key: 'dpi', type: 'number', label: '', default: 150 }], produce: (inputs) => inputs.flatMap((_, i) => [{ name: `p${i}-1.png`, type: 'image/png' }, { name: `p${i}-2.png`, type: 'image/png' }]) },
      { id: 'webp', accept: ['image/*'], multiple: false, params: [{ key: 'quality', type: 'slider', label: '', min: 1, max: 100, default: 80 }], produce: () => [{ name: 'out.webp', type: 'image/webp' }] },
      { id: 'panel', hasSetup: true, produce: () => [] },
      { id: 'broken', accept: ['image/*'], produce: () => new Error('boom') },
      { id: 'nothing', accept: ['image/*'], multiple: true, produce: () => [] },
    ])

  it('feeds outputs forward, fanning out single-file tools, with defaults under user params', async () => {
    const w = tools()
    const pdf = w.add('doc.pdf', 'application/pdf')
    const progress = await run(w, [step('render'), step('webp', { quality: 60 })], [pdf])
    expect(progress.status).toBe('done')
    expect(w.calls[0]).toEqual({ key: 'p/render', inputs: [pdf], params: { dpi: 150 } })
    // Two pages → two separate single-file invocations.
    expect(w.calls.slice(1).map((c) => c.inputs.length)).toEqual([1, 1])
    expect(w.calls[1].params).toEqual({ quality: 60 })
    expect(progress.outputs).toHaveLength(2)
    expect(progress.steps.map((s) => [s.state, s.inputs, s.outputs])).toEqual([['done', 1, 2], ['done', 2, 2]])
    expect(progress.steps[1].taskIds).toHaveLength(2)
  })

  it('skips files a step does not accept and says so', async () => {
    const w = tools()
    const png = w.add('a.png', 'image/png')
    const txt = w.add('a.txt', 'text/plain')
    const progress = await run(w, [step('webp')], [png, txt])
    expect(progress.status).toBe('done')
    expect(w.calls).toHaveLength(1)
    expect(progress.steps[0].note).toContain('跳过 1 个')
  })

  it('fails with the step name when nothing is accepted', async () => {
    const w = tools()
    const progress = await run(w, [step('render')], [w.add('a.png', 'image/png')])
    expect(progress.status).toBe('failed')
    expect(progress.error).toContain('第 1 步「render」')
    expect(w.calls).toHaveLength(0)
  })

  it('stops at a failing step and cancels the rest', async () => {
    const w = tools()
    const progress = await run(w, [step('broken'), step('webp')], [w.add('a.png', 'image/png')])
    expect(progress.status).toBe('failed')
    expect(progress.error).toBe('第 1 步「broken」失败：boom')
    expect(progress.steps.map((s) => s.state)).toEqual(['failed', 'cancelled'])
  })

  it('refuses an empty intermediate result', async () => {
    const w = tools()
    const progress = await run(w, [step('nothing'), step('webp')], [w.add('a.png', 'image/png')])
    expect(progress.status).toBe('failed')
    expect(progress.error).toContain('没有产生输出文件')
  })

  it('rejects panel tools and unknown tools before running anything', async () => {
    const w = tools()
    expect(validatePipeline([step('panel'), step('missing')], w.deps.findTool)).toEqual([
      '第 1 步「panel」：该工具需要在面板中交互操作，不能用于流水线',
      '第 2 步：找不到工具 p/missing（插件可能已卸载或停用）',
    ])
    expect(validatePipeline([], w.deps.findTool)).toEqual(['流水线至少需要一个步骤'])
    const progress = await run(w, [step('panel')], [w.add('a.png', 'image/png')])
    expect(progress.status).toBe('failed')
    expect(w.calls).toHaveLength(0)
  })

  it('removes intermediates on success when asked, never inputs or results', async () => {
    const w = tools()
    const pdf = w.add('doc.pdf', 'application/pdf')
    const progress = await run(w, [step('render'), step('webp')], [pdf], { cleanup: true })
    expect(w.removed).toHaveLength(2)
    expect(w.removed).not.toContain(pdf)
    for (const id of progress.outputs) expect(w.files.has(id)).toBe(true)
  })

  it('reports cancellation', async () => {
    const w = tools()
    const controller = new AbortController()
    controller.abort()
    const progress = await run(w, [step('webp')], [w.add('a.png', 'image/png')], { signal: controller.signal })
    expect(progress.status).toBe('cancelled')
    expect(progress.error).toBe('已取消')
  })
})
