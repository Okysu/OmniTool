/**
 * Pipeline execution, independent of the task queue and the VFS so it can be
 * tested on its own; `index.ts` wires it to the real ones.
 *
 * A pipeline is a list of tool invocations. Each step receives the previous
 * step's outputs (the first step receives the user's files), keeps only the
 * files its tool accepts, and runs:
 *
 *   - once with every file, when the tool takes multiple inputs;
 *   - once per file otherwise, as separate queued tasks (so they run with the
 *     queue's normal concurrency and show up individually in the task dock).
 *
 * Only form tools qualify. A tool with its own panel (`setup`) takes input the
 * user gives interactively - a crop box, a signature - which a pipeline cannot
 * supply, so such steps are refused rather than run with meaningless state.
 */
import type { ParamValues, ToolManifest } from '@/core/types'
import { defaultParams, matchesAccept } from '@/core/plugin/params'

export interface PipelineStep {
  id: string
  /** `${pluginId}/${toolId}`. */
  toolKey: string
  /** Values the user set; defaults fill in the rest at run time. */
  params: ParamValues
}

export interface StepTool {
  key: string
  tool: ToolManifest
}

export interface RunnerDeps {
  findTool: (key: string) => StepTool | undefined
  fileInfo: (id: string) => { name: string; type: string } | undefined
  /** Runs one invocation to completion; rejects on failure or cancellation. */
  invoke: (tool: StepTool, inputIds: string[], params: ParamValues, signal: AbortSignal) => Promise<{ outputs: string[]; taskId?: string }>
  removeFile: (id: string) => Promise<void>
}

export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

export interface RunProgress {
  status: 'running' | 'done' | 'failed' | 'cancelled'
  steps: Array<{ state: StepState; inputs: number; outputs: number; taskIds: string[]; note: string }>
  outputs: string[]
  error: string
}

/** Why a tool cannot be a pipeline step, or '' when it can. */
export function stepIneligibility(tool: ToolManifest): string {
  if (tool.hasSetup) return '该工具需要在面板中交互操作，不能用于流水线'
  if (tool.input === 'none') return '该工具不接收文件，不能用于流水线'
  return ''
}

/** Static problems with a pipeline, one message per offending step. */
export function validatePipeline(steps: PipelineStep[], findTool: RunnerDeps['findTool']): string[] {
  if (steps.length === 0) return ['流水线至少需要一个步骤']
  const problems: string[] = []
  steps.forEach((step, index) => {
    const entry = findTool(step.toolKey)
    if (!entry) problems.push(`第 ${index + 1} 步：找不到工具 ${step.toolKey}（插件可能已卸载或停用）`)
    else {
      const reason = stepIneligibility(entry.tool)
      if (reason) problems.push(`第 ${index + 1} 步「${entry.tool.name}」：${reason}`)
    }
  })
  return problems
}

export async function runPipeline(
  steps: PipelineStep[],
  inputIds: string[],
  deps: RunnerDeps,
  options: { signal: AbortSignal; cleanup: boolean; onUpdate?: (progress: RunProgress) => void },
): Promise<RunProgress> {
  const progress: RunProgress = {
    status: 'running',
    steps: steps.map(() => ({ state: 'pending', inputs: 0, outputs: 0, taskIds: [], note: '' })),
    outputs: [],
    error: '',
  }
  const update = () => options.onUpdate?.(progress)
  const intermediates: string[] = []
  let current = [...inputIds]

  const problems = validatePipeline(steps, deps.findTool)
  if (problems.length) {
    progress.status = 'failed'
    progress.error = problems.join('\n')
    update()
    return progress
  }
  update()

  for (const [index, step] of steps.entries()) {
    const state = progress.steps[index]
    const entry = deps.findTool(step.toolKey)!
    const label = `第 ${index + 1} 步「${entry.tool.name}」`
    try {
      if (options.signal.aborted) throw new DOMException('已取消', 'AbortError')
      const accepted = current.filter((id) => {
        const info = deps.fileInfo(id)
        return !!info && matchesAccept(info, entry.tool.accept)
      })
      const skipped = current.length - accepted.length
      state.inputs = accepted.length
      state.state = 'running'
      if (skipped) state.note = `跳过 ${skipped} 个不支持的文件`
      update()

      const minimum = entry.tool.minFiles ?? 1
      if (accepted.length === 0) throw new Error(`${label}没有可处理的文件：上一步的输出类型不在它接受的范围内`)
      if (accepted.length < minimum) throw new Error(`${label}至少需要 ${minimum} 个文件，只收到 ${accepted.length} 个`)

      const params = { ...defaultParams(entry.tool), ...step.params }
      const batches = entry.tool.multiple ? [accepted] : accepted.map((id) => [id])
      const results = await Promise.all(
        batches.map(async (batch) => {
          const result = await deps.invoke(entry, batch, { ...params }, options.signal)
          if (result.taskId) {
            state.taskIds.push(result.taskId)
            update()
          }
          return result.outputs
        }),
      )
      const outputs = results.flat()
      state.outputs = outputs.length
      state.state = 'done'
      update()
      if (index < steps.length - 1) {
        if (outputs.length === 0) throw new Error(`${label}没有产生输出文件，后续步骤无法继续`)
        intermediates.push(...outputs)
      }
      current = outputs
    } catch (error) {
      const cancelled = options.signal.aborted
      state.state = cancelled ? 'cancelled' : 'failed'
      for (const later of progress.steps.slice(index + 1)) later.state = 'cancelled'
      progress.status = cancelled ? 'cancelled' : 'failed'
      progress.error = cancelled ? '已取消' : error instanceof Error ? error.message : String(error)
      if (!cancelled && !progress.error.startsWith(label)) progress.error = `${label}失败：${progress.error}`
      update()
      return progress
    }
  }

  progress.outputs = current
  progress.status = 'done'
  if (options.cleanup) {
    const keep = new Set([...inputIds, ...current])
    for (const id of intermediates) if (!keep.has(id)) await deps.removeFile(id).catch(() => {})
  }
  update()
  return progress
}
