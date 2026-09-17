/**
 * Saved pipelines and the glue between the runner and the app: the task queue
 * runs each step (so steps show in the task dock and respect concurrency), the
 * VFS holds every intermediate file.
 *
 * Pipelines are preferences-sized JSON and live in localStorage like settings.
 * They reference tools by key only, so a pipeline survives plugin updates and
 * simply reports a missing step if its plugin goes away.
 */
import { reactive, watch } from 'vue'
import { nanoid } from '@/lib/id'
import * as vfs from '@/core/vfs'
import { findTool } from '@/core/plugin/registry'
import { settings } from '@/core/settings'
import { cancel, enqueue, tasks } from '@/core/tasks/queue'
import type { ParamValues } from '@/core/types'
import { runPipeline, type PipelineStep, type RunProgress, type RunnerDeps } from './runner'

export type { PipelineStep, RunProgress } from './runner'
export { stepIneligibility, validatePipeline } from './runner'

export interface Pipeline {
  id: string
  name: string
  steps: PipelineStep[]
  /** Delete intermediate files once the whole pipeline succeeds. */
  cleanup: boolean
  /**
   * Flowchart positions the user dragged nodes to, keyed by step id or
   * `input` / `output`. Nodes without an entry take the automatic layout.
   */
  layout: Record<string, NodePosition>
  createdAt: number
  updatedAt: number
}

export interface NodePosition {
  x: number
  y: number
}

const STORAGE_KEY = 'omnitool.pipelines'
/** Bounds for stored node coordinates; anything outside is dropped as garbage. */
const MAX_COORD = 100_000
const MAX_PIPELINES = 200
const MAX_STEPS = 32

export const pipelines = reactive<Pipeline[]>(load())

function load(): Pipeline[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.map(sanitize).filter((p): p is Pipeline => !!p).slice(0, MAX_PIPELINES) : []
  } catch {
    return []
  }
}

/** Accepts only the expected shape; also used for imported JSON, which is untrusted. */
export function sanitize(value: unknown): Pipeline | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.steps)) return null
  const steps: PipelineStep[] = []
  for (const step of raw.steps.slice(0, MAX_STEPS)) {
    if (!step || typeof step !== 'object') continue
    const s = step as Record<string, unknown>
    if (typeof s.toolKey !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(s.toolKey)) continue
    const params: ParamValues = {}
    if (s.params && typeof s.params === 'object') {
      for (const [key, v] of Object.entries(s.params as Record<string, unknown>)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') params[key] = v
      }
    }
    steps.push({ id: typeof s.id === 'string' ? s.id : nanoid(8), toolKey: s.toolKey, params })
  }
  const now = Date.now()
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : nanoid(10),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : '未命名工作流',
    steps,
    cleanup: raw.cleanup !== false,
    layout: sanitizeLayout(raw.layout, new Set(['input', 'output', ...steps.map((step) => step.id)])),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
  }
}

function sanitizeLayout(value: unknown, keys: Set<string>): Record<string, NodePosition> {
  const layout: Record<string, NodePosition> = {}
  if (!value || typeof value !== 'object') return layout
  for (const [key, position] of Object.entries(value as Record<string, unknown>)) {
    if (!keys.has(key) || !position || typeof position !== 'object') continue
    const { x, y } = position as Record<string, unknown>
    if (typeof x === 'number' && typeof y === 'number' && Math.abs(x) <= MAX_COORD && Math.abs(y) <= MAX_COORD) {
      layout[key] = { x: Math.round(x), y: Math.round(y) }
    }
  }
  return layout
}

watch(
  pipelines,
  () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pipelines))
    } catch {
      /* storage full or unavailable: pipelines stay for this session */
    }
  },
  { deep: true },
)

export function createPipeline(
  seed: Partial<Pick<Pipeline, 'name' | 'steps' | 'cleanup'>> & { layout?: Record<string, NodePosition> } = {},
): Pipeline {
  const now = Date.now()
  const steps = (seed.steps ?? []).map((step) => ({ ...step, id: nanoid(8), params: { ...step.params } }))
  // Positions follow their step to its new id.
  const layout: Record<string, NodePosition> = {}
  for (const key of ['input', 'output']) if (seed.layout?.[key]) layout[key] = { ...seed.layout[key] }
  seed.steps?.forEach((step, index) => {
    const position = seed.layout?.[step.id]
    if (position) layout[steps[index].id] = { ...position }
  })
  const pipeline: Pipeline = {
    id: nanoid(10),
    name: seed.name?.trim() ? seed.name.trim().slice(0, 80) : '新工作流',
    steps,
    cleanup: seed.cleanup ?? true,
    layout,
    createdAt: now,
    updatedAt: now,
  }
  pipelines.unshift(pipeline)
  return pipelines[0]
}

export function importPipeline(json: unknown): Pipeline {
  const parsed = sanitize(json)
  if (!parsed) throw new Error('不是有效的工作流文件')
  return createPipeline(parsed)
}

export function deletePipeline(id: string): void {
  const index = pipelines.findIndex((p) => p.id === id)
  if (index !== -1) pipelines.splice(index, 1)
  setPinned(id, false)
  delete sessions[id]
}

export function exportPipeline(pipeline: Pipeline): string {
  const { name, steps, cleanup, layout } = pipeline
  return JSON.stringify(
    { format: 'omnitool-pipeline', version: 1, name, cleanup, layout, steps: steps.map(({ id, toolKey, params }) => ({ id, toolKey, params })) },
    null,
    2,
  )
}

/* -------------------------------------------------------------------------- */
/* Pinning                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Pinned workflows share the sidebar's pin list with tools, so they can be
 * ordered among them. A prefix keeps the two apart: tool keys are
 * `pluginId/toolId` and can never start with `flow:`.
 */
export const PIN_PREFIX = 'flow:'

export function isPinned(id: string): boolean {
  return settings.pinned.includes(PIN_PREFIX + id)
}

export function setPinned(id: string, pinned: boolean): void {
  const key = PIN_PREFIX + id
  const has = settings.pinned.includes(key)
  if (pinned && !has) settings.pinned = [...settings.pinned, key]
  else if (!pinned && has) settings.pinned = settings.pinned.filter((k) => k !== key)
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What the user is doing with a pipeline right now: the files or text they
 * gave it and the run they started. Kept per pipeline and outside any view,
 * so switching between the run page and the editor keeps both.
 */
export interface PipelineSession {
  inputs: string[]
  text: string
  inputTab: 'files' | 'text'
  runId: string | null
}

const sessions = reactive<Record<string, PipelineSession>>({})

export function pipelineSession(id: string): PipelineSession {
  if (!sessions[id]) sessions[id] = { inputs: [], text: '', inputTab: 'files', runId: null }
  return sessions[id]
}

/** Starting points built from built-in tools. Templates whose tools are missing are hidden. */
export const TEMPLATES: Array<{ id: string; name: string; description: string; steps: Array<Omit<PipelineStep, 'id'>> }> = [
  {
    id: 'publish-images',
    name: '图片发布：缩小 → 加水印 → 转 WebP',
    description: '把一批照片缩到一半、打上文字水印，再压成体积更小的 WebP。',
    steps: [
      { toolKey: 'omnitool.image/resize', params: { percent: 50 } },
      { toolKey: 'omnitool.image/watermark', params: { text: '© 我的名字' } },
      { toolKey: 'omnitool.image/convert', params: { format: 'image/webp', quality: 80 } },
    ],
  },
  {
    id: 'scan-to-text',
    name: '扫描件：增强 → 文字识别',
    description: '先把发灰的扫描 PDF 调清晰，再 OCR 出文字。',
    steps: [
      { toolKey: 'omnitool.pdf/enhance-scan', params: {} },
      { toolKey: 'omnitool.ai/ocr', params: {} },
    ],
  },
  {
    id: 'scan-to-searchable-pdf',
    name: '扫描件 → 可搜索 PDF',
    description: '增强扫描件后做文字识别，输出能搜索、能复制文字的 PDF。',
    steps: [
      { toolKey: 'omnitool.pdf/enhance-scan', params: {} },
      { toolKey: 'omnitool.ai/ocr', params: { output: 'pdf' } },
    ],
  },
  {
    id: 'pdf-replace-color',
    name: 'PDF 替换颜色',
    description: '逐页转成图片、替换指定颜色（在第 2 步设置），再合成 PDF。页面会变成图片。',
    steps: [
      { toolKey: 'omnitool.pdf/to-image', params: {} },
      { toolKey: 'omnitool.image/color-tools', params: { mode: 'replace' } },
      { toolKey: 'omnitool.image/to-pdf', params: {} },
    ],
  },
  {
    id: 'pdf-to-webp',
    name: 'PDF 逐页转 WebP 图片',
    description: '把 PDF 每页渲染成图片，再统一压缩为 WebP。',
    steps: [
      { toolKey: 'omnitool.pdf/to-image', params: {} },
      { toolKey: 'omnitool.image/convert', params: { format: 'image/webp' } },
    ],
  },
]

/* -------------------------------------------------------------------------- */
/* Running                                                                    */
/* -------------------------------------------------------------------------- */

export interface PipelineRun extends RunProgress {
  id: string
  pipelineId: string
  startedAt: number
}

export const runs = reactive<PipelineRun[]>([])
const controllers = new Map<string, AbortController>()

/** Resolves when a queued task reaches a terminal state. */
function settle(taskId: string): Promise<{ outputs: string[] }> {
  return new Promise((resolve, reject) => {
    const stop = watch(
      () => tasks.find((t) => t.id === taskId)?.status,
      (status) => {
        const task = tasks.find((t) => t.id === taskId)
        if (!task) {
          stop()
          reject(new Error('任务已被移除'))
        } else if (status === 'done') {
          stop()
          resolve({ outputs: [...task.outputs] })
        } else if (status === 'failed' || status === 'cancelled') {
          stop()
          reject(new Error(task.error || (status === 'cancelled' ? '已取消' : '处理失败')))
        }
      },
      { immediate: true },
    )
  })
}

const deps: RunnerDeps = {
  findTool: (key) => findTool(key),
  fileInfo: (id) => vfs.get(id),
  removeFile: (id) => vfs.remove(id),
  async invoke(step, inputIds, params, signal) {
    const entry = findTool(step.key)
    if (!entry) throw new Error(`找不到工具 ${step.key}`)
    const task = enqueue(entry, inputIds, params)
    const onAbort = () => cancel(task.id)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return { ...(await settle(task.id)), taskId: task.id }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  },
}

export function startPipeline(pipeline: Pipeline, inputIds: string[]): PipelineRun {
  const controller = new AbortController()
  const run: PipelineRun = reactive({
    id: nanoid(10),
    pipelineId: pipeline.id,
    startedAt: Date.now(),
    status: 'running',
    steps: pipeline.steps.map(() => ({ state: 'pending' as const, inputs: 0, outputs: 0, taskIds: [], note: '' })),
    outputs: [],
    error: '',
  })
  runs.unshift(run)
  controllers.set(run.id, controller)
  // Snapshot the steps: editing the pipeline mid-run must not change what runs.
  const steps = pipeline.steps.map((step) => ({ ...step, params: { ...step.params } }))
  void runPipeline(steps, inputIds, deps, {
    signal: controller.signal,
    cleanup: pipeline.cleanup,
    onUpdate: (progress) => Object.assign(run, { ...progress, steps: progress.steps.map((s) => ({ ...s, taskIds: [...s.taskIds] })), outputs: [...progress.outputs] }),
  }).finally(() => controllers.delete(run.id))
  return run
}

export function cancelPipeline(runId: string): void {
  controllers.get(runId)?.abort()
}
