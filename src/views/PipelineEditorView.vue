<script setup lang="ts">
/**
 * The workflow editor, as a full-screen page of its own (no app sidebar or top
 * bar, like the tutorial): the flowchart needs the room, and editing is a
 * focused task you leave through the header.
 *
 *   ┌ header: 工作流 / name · list|flow · pin · run page · export · delete ┐
 *   │ steps (list or flowchart)                    │ run: input, progress │
 *
 * Both step views edit the same `PipelineStep[]`. The run column is the same
 * panel the pinned run page uses, sharing its session.
 */
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppLogo from '@/components/common/AppLogo.vue'
import Icon from '@/components/common/Icon.vue'
import Spinner from '@/components/common/Spinner.vue'
import ParamForm from '@/components/tool/ParamForm.vue'
import PipelineFlow from '@/components/pipeline/PipelineFlow.vue'
import PipelineRunPanel from '@/components/pipeline/PipelineRunPanel.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { allTools, findTool, registryState, type ToolEntry } from '@/core/plugin/registry'
import { defaultParams } from '@/core/plugin/params'
import {
  deletePipeline,
  exportPipeline,
  isPinned,
  pipelineSession,
  pipelines,
  runs,
  setPinned,
  stepIneligibility,
  type Pipeline,
  type PipelineStep,
} from '@/core/pipelines'
import { promptForConfirmation } from '@/core/ui/prompt'
import { CATEGORY_LABEL, type ParamValues, type ToolCategory } from '@/core/types'
import { downloadBlob } from '@/lib/zip'
import { nanoid } from '@/lib/id'

const props = defineProps<{ id: string }>()
const router = useRouter()

const pipeline = computed<Pipeline | undefined>(() => pipelines.find((p) => p.id === props.id))
const session = computed(() => pipelineSession(props.id))
const run = computed(() => (session.value.runId ? runs.find((r) => r.id === session.value.runId) : undefined))

watch(
  () => (pipeline.value ? [pipeline.value.name, pipeline.value.cleanup, JSON.stringify(pipeline.value.steps), JSON.stringify(pipeline.value.layout)] : null),
  (now, before) => {
    if (pipeline.value && now && before) pipeline.value.updatedAt = Date.now()
  },
)

function exportPipelineFile() {
  if (!pipeline.value) return
  const name = `${pipeline.value.name.replace(/[\\/:*?"<>|]+/g, '_')}.omnitool-flow.json`
  downloadBlob(new Blob([exportPipeline(pipeline.value)], { type: 'application/json' }), name)
}

async function remove() {
  if (!pipeline.value) return
  const accepted = await promptForConfirmation({
    title: '删除工作流',
    message: `确定删除「${pipeline.value.name}」吗？`,
    detail: '已经生成的文件不会被删除。',
    confirmLabel: '删除',
    tone: 'destructive',
  })
  if (!accepted) return
  deletePipeline(props.id)
  void router.push('/flows')
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
  const steps = pipeline.value?.steps
  if (!steps) return
  const target = index + delta
  if (target < 0 || target >= steps.length) return
  const [step] = steps.splice(index, 1)
  steps.splice(target, 0, step)
}

function removeStep(index: number) {
  const steps = pipeline.value?.steps
  if (!steps) return
  const [removed] = steps.splice(index, 1)
  if (removed && pipeline.value) delete pipeline.value.layout[removed.id]
}

const pickerOpen = ref(false)
const query = ref('')

const groupedTools = computed(() => {
  const q = query.value.trim().toLowerCase()
  const groups = new Map<ToolCategory, ToolEntry[]>()
  for (const entry of allTools.value) {
    if (stepIneligibility(entry.tool)) continue
    const haystack = [entry.tool.name, entry.tool.description ?? '', ...(entry.tool.keywords ?? []), entry.pluginName].join(' ').toLowerCase()
    if (q && !haystack.includes(q)) continue
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
  if (!pipeline.value) return
  const step = { id: nanoid(8), toolKey: entry.key, params: {} }
  const { steps, layout } = pipeline.value
  const at = Math.min(Math.max(0, insertAt.value ?? steps.length), steps.length)
  // In a hand-arranged flowchart the automatic slot would land on top of other
  // nodes; place the new step just below the connector it was inserted into.
  const before = layout[at === 0 ? 'input' : steps[at - 1].id]
  const after = layout[at === steps.length ? 'output' : steps[at].id]
  if (before && after) {
    const snap = (v: number) => Math.round(v / 12) * 12
    layout[step.id] = { x: snap((before.x + after.x) / 2), y: snap(Math.max(before.y, after.y) + 180) }
  }
  steps.splice(at, 0, step)
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

watch(
  () => props.id,
  () => (expanded.value = null),
)
</script>

<template>
  <div class="flex h-dvh flex-col overflow-y-auto lg:overflow-hidden" data-pipeline-editor>
    <!-- Standalone header: the editor does not use the app's navigation. -->
    <header class="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card/80 px-3 py-1.5 backdrop-blur-xl sm:px-4">
      <RouterLink to="/" class="flex shrink-0 items-center gap-2 rounded-md transition-opacity hover:opacity-80" aria-label="返回 OmniTool">
        <AppLogo :size="26" />
      </RouterLink>
      <span class="text-sm text-muted-foreground">/</span>
      <RouterLink to="/flows" class="shrink-0 rounded-md px-1 text-sm font-medium transition-colors hover:text-primary" data-pipeline-back>工作流</RouterLink>
      <template v-if="pipeline">
        <span class="text-sm text-muted-foreground">/</span>
        <Input
          id="pipeline-name"
          v-model="pipeline.name"
          maxlength="80"
          aria-label="工作流名称"
          class="h-8 w-44 min-w-0 text-sm font-medium sm:w-64"
        />
        <div class="flex rounded-lg border border-border p-0.5" role="group" aria-label="步骤视图">
          <Button :variant="viewMode === 'list' ? 'secondary' : 'ghost'" size="xs" :aria-pressed="viewMode === 'list'" data-pipeline-view="list" @click="viewMode = 'list'">
            <Icon name="list-ordered" :size="12" />
            列表
          </Button>
          <Button :variant="viewMode === 'flow' ? 'secondary' : 'ghost'" size="xs" :aria-pressed="viewMode === 'flow'" data-pipeline-view="flow" @click="viewMode = 'flow'">
            <Icon name="workflow" :size="12" />
            流程图
          </Button>
        </div>
        <span class="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            :class="isPinned(pipeline.id) ? 'text-primary' : ''"
            :aria-pressed="isPinned(pipeline.id)"
            :title="isPinned(pipeline.id) ? '取消置顶' : '置顶到侧边栏，像工具一样直接使用'"
            data-pipeline-pin
            @click="setPinned(pipeline.id, !isPinned(pipeline.id))"
          >
            <Icon :name="isPinned(pipeline.id) ? 'pin' : 'pin-off'" :size="14" />
            <span class="hidden md:inline">{{ isPinned(pipeline.id) ? '已置顶' : '置顶' }}</span>
          </Button>
          <Button variant="ghost" size="sm" title="打开运行页" @click="router.push(`/flows/${pipeline.id}`)">
            <Icon name="play" :size="14" />
            <span class="hidden md:inline">运行页</span>
          </Button>
          <Button variant="ghost" size="sm" :disabled="pipeline.steps.length === 0" title="导出为 JSON 文件" @click="exportPipelineFile">
            <Icon name="download" :size="14" />
            <span class="hidden md:inline">导出</span>
          </Button>
          <Button variant="ghost" size="sm" class="text-destructive" title="删除工作流" @click="remove">
            <Icon name="trash" :size="14" />
            <span class="hidden md:inline">删除</span>
          </Button>
        </span>
      </template>
    </header>

    <div v-if="!pipeline" class="mx-auto flex max-w-md flex-1 flex-col items-center justify-center px-6 py-20 text-center">
      <Icon name="circle-alert" :size="28" class="text-muted-foreground" />
      <p class="mt-3 text-sm font-medium">找不到这个工作流</p>
      <p class="mt-1 text-xs text-muted-foreground">它可能已被删除。</p>
      <Button variant="outline" size="sm" class="mt-4" @click="router.push('/flows')">返回工作流列表</Button>
    </div>

    <div v-else class="flex min-h-0 flex-1 flex-col lg:flex-row">
      <!-- Steps -->
      <main class="min-w-0 flex-1 lg:overflow-y-auto scroll-slim" :class="viewMode === 'flow' ? 'p-3' : 'px-4 py-5 sm:px-6'">
        <PipelineFlow
          v-if="viewMode === 'flow'"
          fill
          :steps="pipeline.steps"
          :run="run"
          :input-count="session.inputs.length"
          :cleanup="pipeline.cleanup"
          :layout="pipeline.layout"
          @insert="openPicker"
          @remove="removeStep"
          @move="move"
          @layout="pipeline.layout = $event"
        />
        <div v-else class="mx-auto max-w-3xl">
          <h2 class="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">步骤</h2>
          <ol class="space-y-2">
            <li
              v-for="(step, index) in pipeline.steps"
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
                <Button variant="ghost" size="icon" class="size-7" aria-label="下移" :disabled="index === pipeline.steps.length - 1" @click="move(index, 1)">
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
          <Button variant="outline" size="sm" class="mt-2 w-full border-dashed" @click="openPicker()">
            <Icon name="plus" :size="14" />
            添加步骤
          </Button>
        </div>
      </main>

      <!-- Run -->
      <aside class="shrink-0 border-t border-border px-4 py-4 lg:w-[24rem] lg:overflow-y-auto lg:border-l lg:border-t-0 scroll-slim" data-pipeline-run-column>
        <h2 class="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">运行</h2>
        <div class="mb-3 flex items-center gap-2">
          <Switch id="pipeline-cleanup" v-model="pipeline.cleanup" />
          <Label for="pipeline-cleanup" class="text-xs">完成后删除中间文件，只保留最终结果</Label>
        </div>
        <PipelineRunPanel :pipeline="pipeline" />
      </aside>
    </div>

    <Dialog v-model:open="pickerOpen">
      <DialogContent class="max-h-[85dvh] overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{{ insertAt === null || insertAt >= (pipeline?.steps.length ?? 0) ? '添加步骤' : `在第 ${insertAt + 1} 步前插入` }}</DialogTitle>
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
