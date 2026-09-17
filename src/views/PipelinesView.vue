<script setup lang="ts">
/**
 * Pipelines: chain form tools so one drop of files runs through several steps.
 *
 * The left column lists saved pipelines and templates; the main column edits
 * the selected one (steps, their parameters) and runs it. Each step runs as
 * ordinary queued tasks, so the task dock shows them like any other run.
 */
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import DropZone from '@/components/tool/DropZone.vue'
import FileGrid from '@/components/tool/FileGrid.vue'
import ParamForm from '@/components/tool/ParamForm.vue'
import PipelineFlow from '@/components/pipeline/PipelineFlow.vue'
import Icon from '@/components/common/Icon.vue'
import Spinner from '@/components/common/Spinner.vue'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { allTools, findTool, registryState, type ToolEntry } from '@/core/plugin/registry'
import { defaultParams } from '@/core/plugin/params'
import {
  TEMPLATES,
  cancelPipeline,
  createPipeline,
  deletePipeline,
  exportPipeline,
  importPipeline,
  pipelines,
  runs,
  startPipeline,
  stepIneligibility,
  validatePipeline,
  type Pipeline,
  type PipelineStep,
} from '@/core/pipelines'
import { pushToast } from '@/core/ui/toast'
import { CATEGORY_LABEL, type ParamValues, type ToolCategory } from '@/core/types'
import { downloadBlob } from '@/lib/zip'
import { nanoid } from '@/lib/id'

const props = defineProps<{ id?: string }>()
const router = useRouter()

const selected = computed<Pipeline | undefined>(() => pipelines.find((p) => p.id === props.id))

watch(
  () => (selected.value ? [selected.value.name, selected.value.cleanup, JSON.stringify(selected.value.steps)] : null),
  (now, before) => {
    if (selected.value && now && before) selected.value.updatedAt = Date.now()
  },
)

function open(pipeline: Pipeline) {
  void router.push(`/flows/${pipeline.id}`)
}

function create() {
  open(createPipeline())
}

const templates = computed(() => TEMPLATES.filter((t) => t.steps.every((s) => findTool(s.toolKey))))

function fromTemplate(template: (typeof TEMPLATES)[number]) {
  open(createPipeline({ name: template.name, steps: template.steps.map((step) => ({ ...step, id: '' })) }))
}

function remove(pipeline: Pipeline) {
  deletePipeline(pipeline.id)
  void router.push('/flows')
}

function exportSelected() {
  if (!selected.value) return
  const name = `${selected.value.name.replace(/[\\/:*?"<>|]+/g, '_')}.omnitool-flow.json`
  downloadBlob(new Blob([exportPipeline(selected.value)], { type: 'application/json' }), name)
}

const importInput = ref<HTMLInputElement | null>(null)
async function importFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  ;(event.target as HTMLInputElement).value = ''
  if (!file) return
  try {
    open(importPipeline(JSON.parse(await file.text())))
    pushToast({ level: 'success', message: `已导入工作流「${file.name}」` })
  } catch (error) {
    pushToast({ level: 'error', title: '导入失败', message: error instanceof Error ? error.message : String(error) })
  }
}

/* ------------------------------------------------------------------ steps */

const toolFor = (step: PipelineStep) => findTool(step.toolKey)

function stepProblem(step: PipelineStep): string {
  const entry = toolFor(step)
  if (!entry) return registryState.ready ? '找不到这个工具，插件可能已卸载或停用' : ''
  return stepIneligibility(entry.tool)
}

function paramsOf(step: PipelineStep): ParamValues {
  const entry = toolFor(step)
  return entry ? { ...defaultParams(entry.tool), ...step.params } : step.params
}

const expanded = ref<string | null>(null)

function move(index: number, delta: number) {
  const steps = selected.value?.steps
  if (!steps) return
  const target = index + delta
  if (target < 0 || target >= steps.length) return
  const [step] = steps.splice(index, 1)
  steps.splice(target, 0, step)
}

function removeStep(index: number) {
  selected.value?.steps.splice(index, 1)
}

const pickerOpen = ref(false)
const query = ref('')

const eligibleTools = computed(() => {
  const q = query.value.trim().toLowerCase()
  return allTools.value.filter((entry) => {
    if (stepIneligibility(entry.tool)) return false
    if (!q) return true
    const haystack = [entry.tool.name, entry.tool.description ?? '', ...(entry.tool.keywords ?? []), entry.pluginName].join(' ').toLowerCase()
    return haystack.includes(q)
  })
})

const groupedTools = computed(() => {
  const groups = new Map<ToolCategory, ToolEntry[]>()
  for (const entry of eligibleTools.value) {
    const list = groups.get(entry.tool.category) ?? []
    list.push(entry)
    groups.set(entry.tool.category, list)
  }
  return [...groups.entries()]
})

/** Where the picker inserts: a flowchart connector's position, or the end. */
const insertAt = ref<number | null>(null)

function openPicker(index: number | null = null) {
  insertAt.value = index
  pickerOpen.value = true
}

function addStep(entry: ToolEntry) {
  if (!selected.value) return
  const step = { id: nanoid(8), toolKey: entry.key, params: {} }
  const at = insertAt.value ?? selected.value.steps.length
  selected.value.steps.splice(Math.min(Math.max(0, at), selected.value.steps.length), 0, step)
  insertAt.value = null
  expanded.value = step.id
  pickerOpen.value = false
  query.value = ''
}

/* ------------------------------------------------------------------- view */

const VIEW_KEY = 'omnitool.pipelines.view'
function loadViewMode(): 'list' | 'flow' {
  try {
    return localStorage.getItem(VIEW_KEY) === 'flow' ? 'flow' : 'list'
  } catch {
    return 'list'
  }
}
const viewMode = ref<'list' | 'flow'>(loadViewMode())
watch(viewMode, (mode) => {
  try {
    localStorage.setItem(VIEW_KEY, mode)
  } catch {
    /* storage unavailable */
  }
})

/* -------------------------------------------------------------------- run */

const inputs = ref<string[]>([])
const runId = ref<string | null>(null)
const run = computed(() => (runId.value ? runs.find((r) => r.id === runId.value) : undefined))
const running = computed(() => run.value?.status === 'running')

watch(
  () => props.id,
  () => {
    inputs.value = []
    runId.value = null
    expanded.value = null
  },
)

const problems = computed(() => (selected.value ? validatePipeline(selected.value.steps, findTool) : []))
const firstAccept = computed(() => {
  const first = selected.value?.steps[0]
  return (first && toolFor(first)?.tool.accept) || []
})
const canRun = computed(() => !!selected.value && problems.value.length === 0 && inputs.value.length > 0 && !running.value)

function start() {
  if (!selected.value || !canRun.value) return
  runId.value = startPipeline(selected.value, [...inputs.value]).id
}

const STATE_ICON = { pending: 'circle', running: 'loader', done: 'circle-check', failed: 'circle-alert', cancelled: 'ban' } as const
const STATE_CLASS = {
  pending: 'text-muted-foreground',
  running: 'animate-spin text-primary',
  done: 'text-success',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground',
} as const

function relativeTime(at: number) {
  const minutes = Math.round((Date.now() - at) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (minutes < 1440) return `${Math.round(minutes / 60)} 小时前`
  return new Date(at).toLocaleDateString()
}
</script>

<template>
  <div class="mx-auto px-4 py-6 sm:px-6 sm:py-8" :class="viewMode === 'flow' ? 'max-w-[112rem]' : 'max-w-6xl'">
    <header class="mb-6 flex flex-wrap items-start gap-3">
      <span class="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Icon name="workflow" :size="20" />
      </span>
      <div class="min-w-0 flex-1">
        <h1 class="text-lg font-semibold tracking-tight">工作流</h1>
        <p class="mt-1 text-xs leading-relaxed text-muted-foreground">
          把多个工具串起来：上一步的输出自动交给下一步。只需拖入一次文件，全部在本机完成。
        </p>
      </div>
      <div class="flex gap-2">
        <input ref="importInput" type="file" accept=".json,application/json" class="hidden" @change="importFile" />
        <Button variant="outline" size="sm" @click="importInput?.click()">
          <Icon name="upload" :size="14" />
          导入
        </Button>
        <Button size="sm" @click="create">
          <Icon name="plus" :size="14" />
          新建工作流
        </Button>
      </div>
    </header>

    <div class="grid gap-6 lg:grid-cols-[16rem_1fr]">
      <!-- Saved pipelines and templates -->
      <aside class="space-y-5">
        <section>
          <h2 class="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">我的工作流</h2>
          <p v-if="pipelines.length === 0" class="text-xs text-muted-foreground">还没有工作流，新建一个或从模板开始。</p>
          <ul class="space-y-1">
            <li v-for="pipeline in pipelines" :key="pipeline.id">
              <button
                type="button"
                class="w-full rounded-lg border px-3 py-2 text-left transition-colors"
                :class="pipeline.id === props.id ? 'border-primary/40 bg-primary/5' : 'border-border bg-card hover:bg-muted'"
                @click="open(pipeline)"
              >
                <span class="block truncate text-sm font-medium">{{ pipeline.name }}</span>
                <span class="text-[11px] text-muted-foreground">{{ pipeline.steps.length }} 个步骤 · {{ relativeTime(pipeline.updatedAt) }}</span>
              </button>
            </li>
          </ul>
        </section>
        <section v-if="templates.length">
          <h2 class="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">模板</h2>
          <ul class="space-y-1">
            <li v-for="template in templates" :key="template.id">
              <button
                type="button"
                class="w-full rounded-lg border border-dashed border-border px-3 py-2 text-left transition-colors hover:bg-muted"
                :data-template="template.id"
                @click="fromTemplate(template)"
              >
                <span class="block text-sm">{{ template.name }}</span>
                <span class="text-[11px] leading-snug text-muted-foreground">{{ template.description }}</span>
              </button>
            </li>
          </ul>
        </section>
      </aside>

      <!-- Editor -->
      <section v-if="!selected" class="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-12 text-center">
        <Icon name="workflow" :size="28" class="text-muted-foreground" />
        <p class="mt-3 text-sm font-medium">{{ props.id ? '找不到这个工作流' : '选择或新建一个工作流' }}</p>
        <p class="mt-1 max-w-sm text-xs text-muted-foreground">
          例如：照片 → 缩小 → 加水印 → 转 WebP；扫描 PDF → 增强 → 文字识别。需要在面板里手动操作的工具（裁剪框、签名等）不能加入工作流。
        </p>
      </section>

      <section v-else class="min-w-0 space-y-5">
        <div class="flex flex-wrap items-end gap-2">
          <div class="min-w-48 flex-1 space-y-1.5">
            <Label for="pipeline-name" class="text-xs">名称</Label>
            <Input id="pipeline-name" v-model="selected.name" maxlength="80" />
          </div>
          <Button variant="outline" size="sm" :disabled="selected.steps.length === 0" @click="exportSelected">
            <Icon name="download" :size="14" />
            导出
          </Button>
          <Button variant="ghost" size="sm" class="text-destructive" @click="remove(selected)">
            <Icon name="trash" :size="14" />
            删除
          </Button>
        </div>

        <!-- Steps -->
        <div>
          <div class="mb-2 flex items-center gap-2">
            <h2 class="text-xs font-medium uppercase tracking-wider text-muted-foreground">步骤</h2>
            <div class="ml-auto flex rounded-lg border border-border p-0.5" role="group" aria-label="步骤视图">
              <Button
                :variant="viewMode === 'list' ? 'secondary' : 'ghost'"
                size="xs"
                :aria-pressed="viewMode === 'list'"
                data-pipeline-view="list"
                @click="viewMode = 'list'"
              >
                <Icon name="list-ordered" :size="12" />
                列表
              </Button>
              <Button
                :variant="viewMode === 'flow' ? 'secondary' : 'ghost'"
                size="xs"
                :aria-pressed="viewMode === 'flow'"
                data-pipeline-view="flow"
                @click="viewMode = 'flow'"
              >
                <Icon name="workflow" :size="12" />
                流程图
              </Button>
            </div>
          </div>
          <PipelineFlow
            v-if="viewMode === 'flow'"
            :steps="selected.steps"
            :run="run"
            :input-count="inputs.length"
            :cleanup="selected.cleanup"
            @insert="openPicker"
            @remove="removeStep"
            @move="move"
          />
          <ol v-else class="space-y-2">
            <li
              v-for="(step, index) in selected.steps"
              :key="step.id"
              class="rounded-xl border bg-card"
              :class="stepProblem(step) ? 'border-destructive/40' : 'border-border'"
              data-pipeline-step
            >
              <div class="flex items-center gap-2 px-3 py-2.5">
                <span class="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium tabular-nums">{{ index + 1 }}</span>
                <Icon :name="toolFor(step)?.tool.icon ?? 'package'" :size="15" class="shrink-0 text-primary" />
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-medium">{{ toolFor(step)?.tool.name ?? step.toolKey }}</p>
                  <p v-if="stepProblem(step)" class="text-[11px] text-destructive">{{ stepProblem(step) }}</p>
                  <p v-else class="truncate text-[11px] text-muted-foreground">{{ toolFor(step)?.pluginName }}</p>
                </div>
                <Button
                  v-if="toolFor(step)?.tool.params?.length"
                  variant="ghost"
                  size="xs"
                  :aria-expanded="expanded === step.id"
                  @click="expanded = expanded === step.id ? null : step.id"
                >
                  <Icon name="sliders" :size="12" />
                  参数
                </Button>
                <Button variant="ghost" size="icon" class="size-7" aria-label="上移" :disabled="index === 0" @click="move(index, -1)">
                  <Icon name="arrow-up" :size="14" />
                </Button>
                <Button variant="ghost" size="icon" class="size-7" aria-label="下移" :disabled="index === selected.steps.length - 1" @click="move(index, 1)">
                  <Icon name="arrow-down" :size="14" />
                </Button>
                <Button variant="ghost" size="icon" class="size-7" aria-label="删除步骤" @click="removeStep(index)">
                  <Icon name="x" :size="14" />
                </Button>
              </div>
              <div v-if="expanded === step.id && toolFor(step)?.tool.params?.length" class="border-t border-border px-4 py-4">
                <ParamForm :model-value="paramsOf(step)" :params="toolFor(step)!.tool.params!" @update:model-value="step.params = $event" />
              </div>
            </li>
          </ol>
          <Button v-if="viewMode === 'list'" variant="outline" size="sm" class="mt-2 w-full border-dashed" @click="openPicker()">
            <Icon name="plus" :size="14" />
            添加步骤
          </Button>
          <div class="mt-3 flex items-center gap-2">
            <Switch id="pipeline-cleanup" v-model="selected.cleanup" />
            <Label for="pipeline-cleanup" class="text-xs">完成后删除中间文件，只保留最终结果</Label>
          </div>
        </div>

        <!-- Run -->
        <div class="space-y-3">
          <h2 class="text-xs font-medium uppercase tracking-wider text-muted-foreground">运行</h2>
          <DropZone :accept="firstAccept" :multiple="true" :files="inputs" @add="inputs = [...inputs, ...$event]" @remove="inputs = inputs.filter((id) => id !== $event)" />
          <p v-for="problem in problems" :key="problem" class="text-xs text-destructive">{{ problem }}</p>
          <div class="flex gap-2">
            <Button class="flex-1" :disabled="!canRun" data-pipeline-run @click="start">
              <Icon :name="running ? 'loader' : 'play'" :size="14" :class="running ? 'animate-spin' : ''" />
              {{ running ? '运行中…' : `运行 ${selected.steps.length} 个步骤` }}
            </Button>
            <Button v-if="running && run" variant="outline" @click="cancelPipeline(run.id)">取消</Button>
          </div>

          <div v-if="run" class="rounded-xl border border-border bg-card p-4" :data-pipeline-status="run.status">
            <ol class="space-y-2">
              <li v-for="(state, index) in run.steps" :key="index" class="flex items-center gap-2 text-xs">
                <Icon :name="STATE_ICON[state.state]" :size="14" :class="STATE_CLASS[state.state]" />
                <span class="min-w-0 flex-1 truncate">
                  {{ index + 1 }}. {{ toolFor(selected.steps[index] ?? { id: '', toolKey: '', params: {} })?.tool.name ?? '步骤' }}
                </span>
                <span v-if="state.state !== 'pending'" class="tabular-nums text-muted-foreground">
                  {{ state.inputs }} → {{ state.state === 'done' ? state.outputs : '…' }}
                </span>
                <Badge v-if="state.note" variant="outline" class="text-[10px]">{{ state.note }}</Badge>
              </li>
            </ol>
            <p v-if="run.status === 'done'" class="mt-3 text-xs font-medium text-success">完成，共得到 {{ run.outputs.length }} 个文件</p>
            <p v-else-if="run.error" class="mt-3 whitespace-pre-line text-xs text-destructive">{{ run.error }}</p>
          </div>

          <FileGrid v-if="run?.outputs.length" :ids="run.outputs" :zip-name="`${selected.name}.zip`" empty-text="没有输出文件" />
        </div>
      </section>
    </div>

    <Dialog v-model:open="pickerOpen">
      <DialogContent class="max-h-[85dvh] overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{{ insertAt === null || insertAt >= (selected?.steps.length ?? 0) ? '添加步骤' : `在第 ${insertAt + 1} 步前插入` }}</DialogTitle>
          <DialogDescription>需要在面板中交互操作的工具不会列出。</DialogDescription>
        </DialogHeader>
        <Input v-model="query" placeholder="搜索工具…" autofocus />
        <div class="-mx-2 max-h-[55dvh] overflow-y-auto scroll-slim px-2">
          <p v-if="!registryState.ready" class="flex items-center gap-2 py-6 text-xs text-muted-foreground"><Spinner :size="14" /> 正在加载插件…</p>
          <p v-else-if="groupedTools.length === 0" class="py-6 text-center text-xs text-muted-foreground">没有匹配的工具</p>
          <section v-for="[category, entries] in groupedTools" :key="category" class="mb-3">
            <h3 class="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{{ CATEGORY_LABEL[category] }}</h3>
            <button
              v-for="entry in entries"
              :key="entry.key"
              type="button"
              class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
              :data-tool-key="entry.key"
              @click="addStep(entry)"
            >
              <Icon :name="entry.tool.icon ?? 'package'" :size="14" class="shrink-0 text-primary" />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm">{{ entry.tool.name }}</span>
                <span class="block truncate text-[11px] text-muted-foreground">{{ entry.tool.description }}</span>
              </span>
            </button>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
