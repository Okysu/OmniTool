/**
 * Saved-pipeline bookkeeping: flowchart layouts survive storage and import
 * (and garbage in untrusted files does not), pins share the sidebar list with
 * tools, and deleting a pipeline cleans up after it.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  PIN_PREFIX,
  createPipeline,
  deletePipeline,
  exportPipeline,
  importPipeline,
  isPinned,
  pipelineSession,
  pipelines,
  sanitize,
  setPinned,
} from '@/core/pipelines'
import { settings } from '@/core/settings'

beforeEach(() => {
  pipelines.splice(0, pipelines.length)
  settings.pinned = ['omnitool.image/resize']
})

describe('pipeline layout', () => {
  it('keeps positions for known nodes only and drops malformed ones', () => {
    const parsed = sanitize({
      name: 'x',
      steps: [{ id: 's1', toolKey: 'p/a', params: {} }],
      layout: {
        input: { x: 10.4, y: -20 },
        s1: { x: 300, y: 200 },
        output: { x: 'far', y: 0 },
        ghost: { x: 1, y: 1 },
        s2: { x: 1e9, y: 0 },
      },
    })
    expect(parsed?.layout).toEqual({ input: { x: 10, y: -20 }, s1: { x: 300, y: 200 } })
  })

  it('carries positions through export and import onto the new step ids', () => {
    const source = createPipeline({ name: '原始', steps: [{ id: '', toolKey: 'p/a', params: { q: 1 } }] })
    source.layout = { input: { x: 0, y: 0 }, [source.steps[0].id]: { x: 48, y: 480 }, output: { x: 600, y: 480 } }
    const copy = importPipeline(JSON.parse(exportPipeline(source)))
    expect(copy.id).not.toBe(source.id)
    expect(copy.steps[0].id).not.toBe(source.steps[0].id)
    expect(copy.layout).toEqual({ input: { x: 0, y: 0 }, [copy.steps[0].id]: { x: 48, y: 480 }, output: { x: 600, y: 480 } })
    expect(copy.steps[0].params).toEqual({ q: 1 })
  })

  it('starts templates and blank pipelines without a layout', () => {
    expect(createPipeline({ name: '  ' }).layout).toEqual({})
    expect(createPipeline().name).toBe('新工作流')
  })
})

describe('pinning and deletion', () => {
  it('pins workflows alongside tools and unpins on delete', () => {
    const pipeline = createPipeline({ name: '发布' })
    setPinned(pipeline.id, true)
    setPinned(pipeline.id, true)
    expect(settings.pinned).toEqual(['omnitool.image/resize', `${PIN_PREFIX}${pipeline.id}`])
    expect(isPinned(pipeline.id)).toBe(true)

    pipelineSession(pipeline.id).inputs.push('file-1')
    deletePipeline(pipeline.id)
    expect(pipelines.some((p) => p.id === pipeline.id)).toBe(false)
    expect(settings.pinned).toEqual(['omnitool.image/resize'])
    expect(pipelineSession(pipeline.id).inputs).toEqual([])
  })
})
