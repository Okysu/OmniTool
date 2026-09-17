/**
 * Invocation queue.
 *
 * Every tool run - built-in or third-party - goes through here, so the task dock
 * shows one honest view of everything in flight, concurrency stays bounded, and
 * cancellation has a single implementation.
 */
import { computed, reactive } from 'vue'
import { nanoid } from '@/lib/id'
import * as vfs from '@/core/vfs'
import { findPlugin, getSandbox, type ToolEntry } from '@/core/plugin/registry'
import { pushToast } from '@/core/ui/toast'
import { settings } from '@/core/settings'
import type { FileRef, ParamValues } from '@/core/types'

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface Task {
  id: string
  toolKey: string
  toolName: string
  pluginId: string
  pluginName: string
  status: TaskStatus
  /** 0..1, or null for indeterminate. */
  progress: number | null
  label: string
  inputs: FileRef[]
  outputs: string[]
  summary: string
  error: string
  createdAt: number
  startedAt: number | null
  endedAt: number | null
}

export const tasks = reactive<Task[]>([])

const controllers = new Map<string, AbortController>()

export const activeCount = computed(() => tasks.filter((t) => t.status === 'running' || t.status === 'queued').length)
export const runningCount = computed(() => tasks.filter((t) => t.status === 'running').length)

/** Aggregate progress across running tasks, for the top-bar indicator. */
export const overallProgress = computed<number | null>(() => {
  const running = tasks.filter((t) => t.status === 'running')
  if (running.length === 0) return null
  const known = running.filter((t) => t.progress !== null)
  if (known.length === 0) return null
  return known.reduce((sum, t) => sum + (t.progress ?? 0), 0) / known.length
})

/* -------------------------------------------------------------------------- */
/* Enqueue                                                                    */
/* -------------------------------------------------------------------------- */

export function enqueue(entry: ToolEntry, inputIds: string[], params: ParamValues): Task {
  const inputs: FileRef[] = inputIds
    .map((id) => vfs.get(id))
    .filter((e): e is vfs.VfsEntry => Boolean(e))
    .map((e) => vfs.toRef(e))

  const task: Task = {
    id: nanoid(10),
    toolKey: entry.key,
    toolName: entry.tool.name,
    pluginId: entry.pluginId,
    pluginName: entry.pluginName,
    status: 'queued',
    progress: null,
    label: '',
    inputs,
    outputs: [],
    summary: '',
    error: '',
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
  }
  tasks.push(task)
  void pump(params, task.id)
  return task
}

/**
 * Params are held outside the reactive task so a plugin's parameter values never
 * end up rendered by accident, and so the task record stays cheap to clone.
 */
const paramsById = new Map<string, ParamValues>()

async function pump(params: ParamValues, taskId: string): Promise<void> {
  paramsById.set(taskId, params)
  await drain()
}

let draining = false

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    while (true) {
      const limit = Math.max(1, Math.min(8, settings.concurrency))
      if (runningCount.value >= limit) break
      const next = tasks.find((t) => t.status === 'queued')
      if (!next) break
      void run(next)
      // Yield so `status` flips to 'running' before the next scan.
      await Promise.resolve()
    }
  } finally {
    draining = false
  }
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

async function run(task: Task): Promise<void> {
  const record = findPlugin(task.pluginId)
  if (!record) {
    finish(task, 'failed', { error: '插件已卸载' })
    return
  }

  const controller = new AbortController()
  controllers.set(task.id, controller)
  task.status = 'running'
  task.startedAt = Date.now()
  task.label = '正在启动沙盒…'

  const toolId = task.toolKey.slice(task.pluginId.length + 1)
  const params = paramsById.get(task.id) ?? {}

  try {
    const sandbox = await getSandbox(record)
    if (controller.signal.aborted) throw new Error('已取消')
    task.label = ''

    const result = await sandbox.invoke(toolId, task.inputs, params, {
      signal: controller.signal,
      onProgress: (value, label) => {
        task.progress = value
        if (label !== undefined) task.label = label
      },
    })

    task.outputs = result.outputs
    finish(task, 'done', { summary: result.summary ?? '' })
    pushToast({
      level: 'success',
      title: task.toolName,
      message: result.summary || `已生成 ${result.outputs.length} 个文件`,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (controller.signal.aborted) {
      finish(task, 'cancelled', { error: '已取消' })
    } else {
      finish(task, 'failed', { error: message })
      pushToast({ level: 'error', title: `${task.toolName} 失败`, message })
    }
  } finally {
    controllers.delete(task.id)
    paramsById.delete(task.id)
    void drain()
  }
}

function finish(task: Task, status: TaskStatus, patch: Partial<Task>): void {
  task.status = status
  task.endedAt = Date.now()
  task.progress = status === 'done' ? 1 : task.progress
  task.label = ''
  Object.assign(task, patch)
}

/* -------------------------------------------------------------------------- */
/* Control                                                                    */
/* -------------------------------------------------------------------------- */

export function cancel(id: string): void {
  const task = tasks.find((t) => t.id === id)
  if (!task) return
  if (task.status === 'queued') {
    finish(task, 'cancelled', { error: '已取消' })
    paramsById.delete(id)
    return
  }
  controllers.get(id)?.abort()
}

export function clearFinished(): void {
  for (let i = tasks.length - 1; i >= 0; i--) {
    if (tasks[i].status !== 'running' && tasks[i].status !== 'queued') tasks.splice(i, 1)
  }
}

export function removeTask(id: string): void {
  const index = tasks.findIndex((t) => t.id === id)
  if (index === -1) return
  if (tasks[index].status === 'running' || tasks[index].status === 'queued') cancel(id)
  tasks.splice(index, 1)
}
