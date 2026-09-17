<script setup lang="ts">
/**
 * The tool workbench: provide input, configure, run, inspect results.
 *
 * Two shapes of tool share this view:
 *   - Form tools declare `params`; the host renders the form in a side column.
 *   - Panel tools declare `setup(ui)` and draw their own panel. Those panels
 *     tend to hold wide things (a timeline, a canvas), so they get the main
 *     column and the side column shrinks to just the run control.
 *
 * Input is files, typed/pasted text, or both, per the tool's `input` field. Text
 * is written to the workspace as a file at run time, so every tool still
 * receives the same `FileRef[]` regardless of how the user supplied it.
 *
 * Parameter defaults are re-derived whenever the tool changes, so navigating
 * between tools never carries a stale form over.
 */
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import DropZone from '@/components/tool/DropZone.vue'
import ParamForm from '@/components/tool/ParamForm.vue'
import FileGrid from '@/components/tool/FileGrid.vue'
import HtmlPreview from '@/components/tool/HtmlPreview.vue'
import PluginPanel from '@/components/panel/PluginPanel.vue'
import Icon from '@/components/common/Icon.vue'
import Spinner from '@/components/common/Spinner.vue'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { findPlugin, findTool, registryState } from '@/core/plugin/registry'
import { defaultParams } from '@/core/plugin/params'
import { createPipeline, pipelines, stepIneligibility } from '@/core/pipelines'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { nanoid } from '@/lib/id'
import { cancel, enqueue, tasks } from '@/core/tasks/queue'
import { recordRecentTool, settings } from '@/core/settings'
import { pushToast } from '@/core/ui/toast'
import * as vfs from '@/core/vfs'
import { CATEGORY_LABEL, type ParamValues } from '@/core/types'
import { formatBytes } from '@/lib/format'

const props = defineProps<{ pluginId: string; toolId: string }>()
const router = useRouter()

const entry = computed(() => findTool(`${props.pluginId}/${props.toolId}`))
const plugin = computed(() => findPlugin(props.pluginId))

const selected = ref<string[]>([])
const params = ref<ParamValues>({})
const taskId = ref<string | null>(null)
const text = ref('')
const inputTab = ref<'files' | 'text'>('files')
const panelMeta = ref<{ runLabel?: string; runDisabled: boolean }>({ runDisabled: false })

const task = computed(() => (taskId.value ? tasks.find((t) => t.id === taskId.value) : undefined))
const running = computed(() => task.value?.status === 'running' || task.value?.status === 'queued')

const inputMode = computed(() => entry.value?.tool.input ?? 'files')
const hasPanel = computed(() => !!entry.value?.tool.hasSetup)
const usingText = computed(
  () => inputMode.value === 'text' || (inputMode.value === 'both' && inputTab.value === 'text'),
)

function defaults(): ParamValues {
  return entry.value ? defaultParams(entry.value.tool) : {}
}

watch(
  entry,
  (current) => {
    params.value = defaults()
    selected.value = []
    taskId.value = null
    text.value = ''
    panelMeta.value = { runDisabled: false }
    if (current) recordRecentTool(current.key)
    // Text-first tools open on the text tab; everything else on files.
    inputTab.value = current?.tool.input === 'text' ? 'text' : 'files'
  },
  { immediate: true },
)

const minFiles = computed(() => entry.value?.tool.minFiles ?? 1)

const inputReady = computed(() => {
  if (inputMode.value === 'none') return true
  if (usingText.value) return text.value.trim().length > 0
  return selected.value.length >= minFiles.value
})

const canRun = computed(() => !!entry.value && inputReady.value && !running.value && !panelMeta.value.runDisabled)

const pinned = computed(() => (entry.value ? settings.pinned.includes(entry.value.key) : false))
function togglePin() {
  if (!entry.value) return
  const key = entry.value.key
  settings.pinned = pinned.value ? settings.pinned.filter((k) => k !== key) : [...settings.pinned, key]
}

/** Form tools can be chained; the current parameter values go with them. */
const canChain = computed(() => !!entry.value && !stepIneligibility(entry.value.tool))

function addToPipeline(pipelineId: string | null) {
  if (!entry.value) return
  const step = { id: nanoid(8), toolKey: entry.value.key, params: { ...params.value } }
  const target = pipelineId ? pipelines.find((p) => p.id === pipelineId) : createPipeline({ name: `${entry.value.tool.name} 工作流` })
  if (!target) return
  if (pipelineId) target.steps.push(step)
  else target.steps.splice(0, target.steps.length, step)
  pushToast({ level: 'success', message: `已加入工作流「${target.name}」` })
  void router.push(`/flows/${target.id}/edit`)
}

async function run() {
  if (!entry.value || !canRun.value) return
  let inputs = selected.value

  if (usingText.value) {
    // Pasted text becomes a real workspace file, so the tool sees the same
    // FileRef it would for a dropped file - no second code path in plugins.
    try {
      const name = entry.value.tool.textFileName || 'input.txt'
      const file = await vfs.writeAll(name, new TextEncoder().encode(text.value), vfs.guessType(name) || 'text/plain')
      inputs = [file.id]
    } catch (error) {
      pushToast({ level: 'error', title: '无法写入文本', message: error instanceof Error ? error.message : String(error) })
      return
    }
  }

  taskId.value = enqueue(entry.value, inputs, { ...params.value }).id
}

function addFiles(ids: string[]) {
  selected.value = entry.value?.tool.multiple ? [...selected.value, ...ids] : ids.slice(-1)
}

/** Deselects only: the workspace file may be in use elsewhere (see DropZone). */
function removeInput(id: string) {
  selected.value = selected.value.filter((fileId) => fileId !== id)
}

async function removeOutput(id: string) {
  if (task.value) task.value.outputs = task.value.outputs.filter((fileId) => fileId !== id)
  await vfs.remove(id)
}

async function clearAll() {
  for (const id of [...selected.value, ...(task.value?.outputs ?? [])]) await vfs.remove(id)
  selected.value = []
  taskId.value = null
}

/** Single text output: show it inline with a copy button instead of making the user download it. */
const textResult = ref('')
const textResultIsHtml = ref(false)
/** HTML results open rendered; the source is one tab away. */
const resultView = ref<'rendered' | 'source'>('rendered')
const resultExpanded = ref(false)
const resultLines = computed(() => (textResult.value ? textResult.value.split('\n').length : 0))
const resultBytes = computed(() => new TextEncoder().encode(textResult.value).length)
watch(
  () => task.value?.status,
  async (status) => {
    textResult.value = ''
    resultExpanded.value = false
    const outputs = task.value?.outputs ?? []
    if (status !== 'done' || outputs.length !== 1) return
    const file = vfs.get(outputs[0])
    if (!file || file.size > 2 * 1024 * 1024) return
    // Match the MIME *subtype*: `…spreadsheetml.sheet` contains "xml" but is a zip.
    if (!/^text\/|[/+](json|xml|yaml|x-yaml|csv|markdown|x-subrip)$/.test(file.type) && !/\.(txt|md|json|ya?ml|csv|tsv|xml|html?|srt|vtt)$/i.test(file.name)) return
    textResultIsHtml.value = file.type === 'text/html' || /\.html?$/i.test(file.name)
    resultView.value = 'rendered'
    textResult.value = await (await vfs.blob(file.id)).text()
  },
)

async function copyResult() {
  await navigator.clipboard.writeText(textResult.value)
  pushToast({ level: 'success', message: '已复制到剪贴板' })
}

/** Ungranted capabilities the tool's plugin asked for, surfaced as a warning. */
const missingGrants = computed(() => {
  if (!plugin.value) return []
  return plugin.value.manifest.capabilities.filter((c) => !plugin.value!.grants.includes(c))
})

const textBytes = computed(() => new TextEncoder().encode(text.value).length)

const runLabel = computed(() => {
  if (running.value) return '处理中…'
  return panelMeta.value.runLabel || '开始处理'
})

const runHint = computed(() => {
  if (inputMode.value === 'none' || inputReady.value) return ''
  return usingText.value ? '请先输入内容' : `还需要至少 ${minFiles.value} 个输入文件`
})
</script>

<template>
  <div v-if="!registryState.ready" class="flex items-center gap-2 px-6 py-16 text-sm text-muted-foreground">
    <Spinner :size="16" />
    正在加载插件…
  </div>

  <div v-else-if="!entry" class="mx-auto max-w-lg px-6 py-20 text-center">
    <Icon name="circle-alert" :size="28" class="mx-auto text-muted-foreground" />
    <h1 class="mt-3 text-sm font-semibold">找不到这个工具</h1>
    <p class="mt-1 text-xs text-muted-foreground">
      它可能来自一个已被卸载或停用的插件（{{ props.pluginId }} / {{ props.toolId }}）。
    </p>
    <Button variant="outline" size="sm" class="mt-4" @click="router.push('/')">返回工具列表</Button>
  </div>

  <div v-else class="mx-auto px-4 py-6 sm:px-6 sm:py-8" :class="hasPanel ? 'max-w-6xl' : 'max-w-5xl'">
    <!-- Header -->
    <header class="mb-6 flex items-start gap-3">
      <span class="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Icon :name="entry.tool.icon ?? 'package'" :size="20" />
      </span>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <h1 class="text-lg font-semibold tracking-tight">{{ entry.tool.name }}</h1>
          <Badge variant="outline">{{ CATEGORY_LABEL[entry.tool.category] }}</Badge>
          <Badge v-if="entry.origin === 'builtin'" variant="secondary">内置</Badge>
          <Badge v-else-if="entry.origin === 'subscription'" variant="outline">订阅插件</Badge>
          <Badge v-else variant="outline">本地插件</Badge>
        </div>
        <p v-if="entry.tool.description" class="mt-1 text-xs leading-relaxed text-muted-foreground">
          {{ entry.tool.description }}
        </p>
        <p class="mt-1 text-[11px] text-muted-foreground">
          由 {{ entry.pluginName }} v{{ plugin?.manifest.version }} 提供
        </p>
      </div>
      <DropdownMenu v-if="canChain">
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon" title="加入工作流" aria-label="加入工作流">
            <Icon name="workflow" :size="16" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-60">
          <DropdownMenuLabel class="text-xs text-muted-foreground">以当前参数加入工作流</DropdownMenuLabel>
          <DropdownMenuItem @select="addToPipeline(null)">
            <Icon name="plus" :size="14" />
            新建工作流
          </DropdownMenuItem>
          <template v-if="pipelines.length">
            <DropdownMenuSeparator />
            <DropdownMenuItem v-for="pipeline in pipelines.slice(0, 12)" :key="pipeline.id" @select="addToPipeline(pipeline.id)">
              <Icon name="workflow" :size="14" />
              <span class="truncate">{{ pipeline.name }}</span>
            </DropdownMenuItem>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="ghost" size="icon" :title="pinned ? '取消置顶' : '置顶到侧边栏'" @click="togglePin">
        <Icon :name="pinned ? 'pin' : 'pin-off'" :size="16" :class="pinned ? 'text-primary' : ''" />
      </Button>
    </header>

    <div
      v-if="missingGrants.length"
      class="mb-5 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5"
    >
      <Icon name="shield-alert" :size="15" class="mt-0.5 shrink-0 text-warning" />
      <p class="text-xs leading-relaxed">
        该插件申请但未获授权的能力：<strong>{{ missingGrants.join('、') }}</strong>。
        相关功能会调用失败，可在
        <RouterLink to="/plugins" class="text-primary underline underline-offset-2">插件面板</RouterLink>
        中调整授权。
      </p>
    </div>

    <div class="grid gap-6" :class="hasPanel ? 'lg:grid-cols-[1fr_16rem]' : 'lg:grid-cols-[1fr_20rem]'">
      <section class="min-w-0 space-y-5">
        <!-- Input -->
        <div v-if="inputMode !== 'none'">
          <Tabs v-if="inputMode === 'both'" v-model="inputTab">
            <div class="mb-2 flex items-center gap-3">
              <h2 class="text-xs font-medium uppercase tracking-wider text-muted-foreground">输入</h2>
              <TabsList class="h-8">
                <TabsTrigger value="files" class="text-xs">
                  <Icon name="folder-open" :size="13" />
                  文件
                </TabsTrigger>
                <TabsTrigger value="text" class="text-xs">
                  <Icon name="type" :size="13" />
                  直接输入
                </TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="files">
              <DropZone
                :accept="entry.tool.accept ?? []"
                :multiple="entry.tool.multiple"
                :files="selected"
                @add="addFiles"
                @remove="removeInput"
              />
            </TabsContent>
            <TabsContent value="text">
              <Textarea
                v-model="text"
                :rows="20"
                placeholder="在这里粘贴或输入内容…"
                class="scroll-slim min-h-[22rem] resize-y font-mono text-xs"
              />
              <p class="mt-1.5 text-right text-[11px] tabular-nums text-muted-foreground">
                {{ text.length }} 字符 · {{ formatBytes(textBytes) }}
              </p>
            </TabsContent>
          </Tabs>

          <template v-else-if="inputMode === 'text'">
            <h2 class="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">输入内容</h2>
            <Textarea
              v-model="text"
              :rows="20"
              placeholder="在这里粘贴或输入内容…"
              class="scroll-slim min-h-[22rem] resize-y font-mono text-xs"
            />
          </template>

          <template v-else>
            <h2 class="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">输入文件</h2>
            <DropZone
              :accept="entry.tool.accept ?? []"
              :multiple="entry.tool.multiple"
              :files="selected"
              @add="addFiles"
              @remove="removeInput"
            />
          </template>
        </div>

        <!-- Plugin-drawn panel -->
        <div v-if="hasPanel" class="rounded-xl border border-border bg-card p-4">
          <PluginPanel v-model="params" :entry="entry" :inputs="selected" @meta="panelMeta = $event" />
        </div>

        <!-- Progress. `data-task-status` gives automation a stable terminal-state hook. -->
        <div v-if="task" class="rounded-xl border border-border bg-card p-4" :data-task-status="task.status">
          <div class="flex items-center gap-2">
            <Icon
              :name="running ? 'loader' : task.status === 'done' ? 'circle-check' : 'circle-alert'"
              :size="15"
              :class="[
                running ? 'animate-spin text-primary' : task.status === 'done' ? 'text-success' : 'text-destructive',
              ]"
            />
            <p class="min-w-0 flex-1 whitespace-pre-line break-words text-xs font-medium">
              {{
                running
                  ? task.label || '正在处理…'
                  : task.status === 'done'
                    ? task.summary || '处理完成'
                    : task.error || '处理失败'
              }}
            </p>
            <Button v-if="running" variant="ghost" size="sm" @click="cancel(task.id)">取消</Button>
            <span v-else-if="task.progress !== null" class="tabular-nums text-xs text-muted-foreground">
              {{ Math.round((task.progress ?? 0) * 100) }}%
            </span>
          </div>
          <Progress v-if="running" :model-value="task.progress === null ? null : task.progress * 100" class="mt-3" />
        </div>

        <!-- Inline text result -->
        <div v-if="textResult" class="rounded-xl border border-border bg-card">
          <div class="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
            <h2 class="text-xs font-medium uppercase tracking-wider text-muted-foreground">输出内容</h2>
            <span class="text-[11px] tabular-nums text-muted-foreground">
              {{ resultLines }} 行 · {{ formatBytes(resultBytes) }}
            </span>
            <Tabs v-if="textResultIsHtml" v-model="resultView" class="ml-auto">
              <TabsList class="h-7">
                <TabsTrigger value="rendered" class="px-2 text-xs">渲染预览</TabsTrigger>
                <TabsTrigger value="source" class="px-2 text-xs">源码</TabsTrigger>
              </TabsList>
            </Tabs>
            <div class="flex items-center gap-1" :class="textResultIsHtml ? '' : 'ml-auto'">
              <Button variant="ghost" size="xs" :aria-pressed="resultExpanded" @click="resultExpanded = !resultExpanded">
                <Icon :name="resultExpanded ? 'minimize' : 'maximize'" :size="12" />
                {{ resultExpanded ? '收起' : '展开' }}
              </Button>
              <Button variant="ghost" size="xs" @click="copyResult">
                <Icon name="copy" :size="12" />
                复制
              </Button>
            </div>
          </div>
          <HtmlPreview
            v-if="textResultIsHtml && resultView === 'rendered'"
            :html="textResult"
            class="rounded-b-xl"
            :class="resultExpanded ? 'h-[80vh]' : 'h-[28rem]'"
          />
          <pre
            v-else
            class="overflow-auto scroll-slim p-4 font-mono text-xs leading-relaxed"
            :class="resultExpanded ? 'max-h-[80vh]' : 'max-h-[28rem]'"
          >{{ textResult }}</pre>
        </div>

        <!-- Results -->
        <div v-if="task?.outputs.length">
          <h2 class="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">处理结果</h2>
          <FileGrid
            :ids="task.outputs"
            :zip-name="`${entry.tool.id}-results.zip`"
            empty-text="没有产生输出文件"
            @remove="removeOutput"
          >
            <template #actions>
              <Button variant="ghost" size="sm" @click="clearAll">
                <Icon name="trash" :size="14" />
                清理临时文件
              </Button>
            </template>
          </FileGrid>
        </div>
      </section>

      <!-- Side column: generated form, or just the run control for panel tools -->
      <aside class="lg:sticky lg:top-4 lg:self-start">
        <div class="flex flex-col overflow-hidden rounded-xl border border-border bg-card lg:max-h-[calc(100dvh-5rem)]">
          <template v-if="!hasPanel">
            <h2 class="shrink-0 px-4 pt-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">参数</h2>
            <div class="min-h-0 flex-1 overflow-y-auto scroll-slim px-4 py-4">
              <ParamForm v-if="entry.tool.params?.length" v-model="params" :params="entry.tool.params" />
              <p v-else class="text-xs text-muted-foreground">该工具无需配置参数。</p>
            </div>
          </template>

          <div class="shrink-0 px-4 py-3" :class="hasPanel ? '' : 'border-t border-border'">
            <Button class="w-full" :disabled="!canRun" @click="run">
              <Icon :name="running ? 'loader' : 'play'" :size="14" :class="running ? 'animate-spin' : ''" />
              {{ runLabel }}
            </Button>
            <p v-if="runHint" class="mt-2 text-center text-[11px] text-muted-foreground">{{ runHint }}</p>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>
