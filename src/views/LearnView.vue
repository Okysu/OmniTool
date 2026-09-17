<script setup lang="ts">
/**
 * The plugin tutorial: explanation on the left, code and a live preview on the
 * right, in the spirit of Vue's interactive tutorial.
 *
 * "Live" means real: each edit (after a short pause) boots the code in a fresh
 * sandbox via `Playground`, renders the tool's generated form or its own panel
 * with the same components the app uses, and - for form tools - runs it on the
 * lesson's sample file. What you see is what the plugin does once installed.
 *
 * Edits are kept per lesson in localStorage, so leaving and coming back keeps
 * your work; 「重置」 returns to the starter, 「显示答案」 swaps in the solution.
 */
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import MarkdownIt from 'markdown-it'
import CodeEditor from '@/components/editor/CodeEditor.vue'
import DropZone from '@/components/tool/DropZone.vue'
import FileGrid from '@/components/tool/FileGrid.vue'
import ParamForm from '@/components/tool/ParamForm.vue'
import PluginPanel from '@/components/panel/PluginPanel.vue'
import Icon from '@/components/common/Icon.vue'
import AppLogo from '@/components/common/AppLogo.vue'
import Spinner from '@/components/common/Spinner.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LESSONS, type Lesson } from '@/core/learn/lessons'
import { PLAYGROUND_GRANTS, Playground } from '@/core/learn/playground'
import { defaultParams } from '@/core/plugin/params'
import type { ToolEntry } from '@/core/plugin/registry'
import { registryState } from '@/core/plugin/registry'
import { pushToast } from '@/core/ui/toast'
import * as vfs from '@/core/vfs'
import type { ParamValues } from '@/core/types'

const props = defineProps<{ lessonId?: string }>()
const router = useRouter()

const LAST_KEY = 'omnitool.learn.last'
const DRAFTS_KEY = 'omnitool.learn.drafts'
const RUN_DELAY_MS = 700

const lesson = computed<Lesson>(() => LESSONS.find((l) => l.id === props.lessonId) ?? LESSONS[0])
const index = computed(() => LESSONS.indexOf(lesson.value))
const previous = computed(() => LESSONS[index.value - 1])
const next = computed(() => LESSONS[index.value + 1])
const chapters = computed(() => {
  const groups: Array<{ name: string; lessons: Lesson[] }> = []
  for (const l of LESSONS) {
    const group = groups.find((g) => g.name === l.chapter)
    if (group) group.lessons.push(l)
    else groups.push({ name: l.chapter, lessons: [l] })
  }
  return groups
})

// Open the last lesson when arriving without one.
if (!props.lessonId) {
  let last = ''
  try {
    last = localStorage.getItem(LAST_KEY) ?? ''
  } catch {
    /* storage unavailable */
  }
  void router.replace(`/learn/${LESSONS.some((l) => l.id === last) ? last : LESSONS[0].id}`)
}

/* ------------------------------------------------------------------ prose */

const md = new MarkdownIt({ html: false, linkify: true, typographer: false })
const defaultLink = md.renderer.rules.link_open ?? ((tokens, i, options, _env, self) => self.renderToken(tokens, i, options))
md.renderer.rules.link_open = (tokens, i, options, env, self) => {
  const href = String(tokens[i].attrGet('href') ?? '')
  // External and static-file links open beside the tutorial; in-app hash links stay.
  if (!href.startsWith('#')) {
    tokens[i].attrSet('target', '_blank')
    tokens[i].attrSet('rel', 'noopener noreferrer')
  }
  return defaultLink(tokens, i, options, env, self)
}
const prose = computed(() => md.render(lesson.value.body))

/* ------------------------------------------------------------------ code */

function readDrafts(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function writeDraft(id: string, value: string | null) {
  try {
    const drafts = readDrafts()
    if (value === null) delete drafts[id]
    else drafts[id] = value
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts))
  } catch {
    /* storage unavailable */
  }
}

const code = ref('')
const edited = computed(() => code.value !== lesson.value.starter && code.value !== lesson.value.solution)

function reset() {
  code.value = lesson.value.starter
  writeDraft(lesson.value.id, null)
}

function showSolution() {
  code.value = lesson.value.solution
}

/* ---------------------------------------------------------------- preview */

const playground = new Playground()
const state = playground.state
const toolId = ref('')
const params = ref<ParamValues>({})
const inputs = ref<string[]>([])
const sampleIds = shallowRef<string[]>([])
const panelMeta = ref<{ runLabel?: string; runDisabled: boolean }>({ runDisabled: false })
const autoRun = ref(true)

const tools = computed(() => state.manifest?.tools ?? [])
const tool = computed(() => tools.value.find((t) => t.id === toolId.value) ?? tools.value[0])
const entry = computed<ToolEntry | null>(() =>
  tool.value && state.manifest
    ? { key: `${state.manifest.id}/${tool.value.id}`, pluginId: state.manifest.id, pluginName: state.manifest.name, origin: 'local', tool: tool.value }
    : null,
)
const panelSandbox = computed(() => ({ revision: state.revision, get: () => playground.sandbox() }))
const needsInput = computed(() => (tool.value?.input ?? 'files') !== 'none')
const ungranted = computed(() => (state.manifest?.capabilities ?? []).filter((c) => !PLAYGROUND_GRANTS.includes(c)))

let timer: ReturnType<typeof setTimeout> | undefined
/** Set when code is replaced programmatically (lesson switch) and booted directly. */
let skipNextEdit = false

watch(code, (value) => {
  if (skipNextEdit) {
    skipNextEdit = false
    return
  }
  if (value !== lesson.value.starter) writeDraft(lesson.value.id, value)
  clearTimeout(timer)
  timer = setTimeout(() => void boot(value), RUN_DELAY_MS)
})

async function boot(source: string) {
  cancelRun()
  await playground.load(source)
  if (state.status !== 'ready' || !state.manifest) {
    // A result from older code next to a load error would read as if the new code produced it.
    if (state.status === 'error') await clearResult()
    return
  }
  const first = state.manifest.tools.find((t) => t.id === toolId.value) ?? state.manifest.tools[0]
  toolId.value = first?.id ?? ''
  if (first) {
    // Keep what the user already set for params that still exist.
    const defaults = defaultParams(first)
    params.value = { ...defaults, ...Object.fromEntries(Object.entries(params.value).filter(([key]) => key in defaults)) }
  }
  panelMeta.value = { runDisabled: false }
  if (autoRun.value && first && !first.hasSetup) void run()
}

watch(toolId, (id, old) => {
  if (!old || id === old) return
  const t = tools.value.find((x) => x.id === id)
  params.value = t ? defaultParams(t) : {}
  clearResult()
  if (autoRun.value && t && !t.hasSetup) void run()
})

/* --------------------------------------------------------------- samples */

async function makeSample(l: Lesson): Promise<string[]> {
  if (l.sample === 'none') return []
  if (l.sample === 'image') {
    const canvas = new OffscreenCanvas(480, 320)
    const g = canvas.getContext('2d')!
    const sky = g.createLinearGradient(0, 0, 0, 320)
    sky.addColorStop(0, '#60a5fa')
    sky.addColorStop(1, '#fde68a')
    g.fillStyle = sky
    g.fillRect(0, 0, 480, 320)
    g.fillStyle = '#f97316'
    g.beginPath()
    g.arc(360, 110, 46, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = '#166534'
    g.beginPath()
    g.moveTo(0, 320)
    g.lineTo(0, 220)
    g.quadraticCurveTo(140, 140, 260, 230)
    g.quadraticCurveTo(380, 300, 480, 210)
    g.lineTo(480, 320)
    g.fill()
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return [(await vfs.writeAll(l.sampleName, blob, 'image/png')).id]
  }
  const type = l.sample === 'csv' ? 'text/csv' : vfs.guessType(l.sampleName) || 'text/plain'
  return [(await vfs.writeAll(l.sampleName, new TextEncoder().encode(l.sampleText), type)).id]
}

async function dropFiles(ids: string[]) {
  await Promise.all(ids.map((id) => vfs.remove(id)))
}


function addFiles(ids: string[]) {
  inputs.value = tool.value?.multiple ? [...inputs.value, ...ids] : ids.slice(-1)
}

async function removeInput(id: string) {
  inputs.value = inputs.value.filter((x) => x !== id)
  await vfs.remove(id)
}

/* ------------------------------------------------------------------- run */

const running = ref(false)
const progress = ref<{ value: number | null; label: string }>({ value: null, label: '' })
const result = ref<{ ok: boolean; summary: string; outputs: string[]; ms: number } | null>(null)
const textOutput = ref('')
let controller: AbortController | null = null

function cancelRun() {
  controller?.abort()
  controller = null
}

async function clearResult() {
  const old = result.value?.outputs ?? []
  result.value = null
  textOutput.value = ''
  await dropFiles(old)
}

const canRun = computed(() => {
  if (state.status !== 'ready' || !tool.value || running.value) return false
  if (panelMeta.value.runDisabled) return false
  if (needsInput.value && inputs.value.length < (tool.value.minFiles ?? 1)) return false
  return true
})

async function run() {
  if (!tool.value || state.status !== 'ready') return
  if (needsInput.value && inputs.value.length < (tool.value.minFiles ?? 1)) return
  cancelRun()
  const current = new AbortController()
  controller = current
  running.value = true
  progress.value = { value: null, label: '' }
  const started = performance.now()
  try {
    const sandbox = await playground.sandbox()
    const refs = inputs.value
      .map((id) => vfs.get(id))
      .filter((e): e is vfs.VfsEntry => Boolean(e))
      .map((e) => vfs.toRef(e))
    const outcome = await sandbox.invoke(tool.value.id, refs, { ...params.value }, {
      signal: current.signal,
      onProgress: (value, label) => {
        progress.value = { value, label: label ?? progress.value.label }
      },
    })
    if (current.signal.aborted) return
    await clearResult()
    result.value = { ok: true, summary: outcome.summary ?? `已生成 ${outcome.outputs.length} 个文件`, outputs: outcome.outputs, ms: performance.now() - started }
    await previewText(outcome.outputs)
  } catch (error) {
    if (current.signal.aborted) return
    await clearResult()
    result.value = { ok: false, summary: error instanceof Error ? error.message : String(error), outputs: [], ms: performance.now() - started }
  } finally {
    if (controller === current) {
      controller = null
      running.value = false
    }
  }
}

async function previewText(ids: string[]) {
  const file = ids.map((id) => vfs.get(id)).find((f) => f && f.size <= 64 * 1024 && (/^text\/|json|csv|xml|yaml/.test(f.type) || /\.(txt|json|csv|tsv|md)$/i.test(f.name)))
  textOutput.value = file ? await (await vfs.blob(file.id)).text() : ''
}

/* -------------------------------------------------------------------- AI */

async function copyForAi() {
  try {
    const docs = await (await fetch('/llms-full.txt')).text()
    const prompt = `${docs}\n\n---\n\n# My current plugin code\n\n\`\`\`js\n${code.value}\n\`\`\`\n`
    await navigator.clipboard.writeText(prompt)
    pushToast({ level: 'success', message: `已复制 OmniTool 插件文档与当前代码（${Math.round(prompt.length / 1024)} KB），可直接粘贴给 AI` })
  } catch (error) {
    pushToast({ level: 'error', title: '复制失败', message: error instanceof Error ? error.message : String(error) })
  }
}

// Registered last: with `immediate`, it runs during setup and uses everything declared above
// (on in-app navigation the registry is already ready, so it runs straight through).
watch(
  () => [lesson.value.id, registryState.ready] as const,
  async ([id, ready]) => {
    if (!ready) return
    try {
      localStorage.setItem(LAST_KEY, id)
    } catch {
      /* storage unavailable */
    }
    clearTimeout(timer)
    cancelRun()
    clearResult()
    await dropFiles(inputs.value)
    sampleIds.value = await makeSample(lesson.value)
    inputs.value = [...sampleIds.value]
    toolId.value = ''
    params.value = {}
    const initial = readDrafts()[id] ?? lesson.value.starter
    if (code.value !== initial) {
      skipNextEdit = true
      code.value = initial
    }
    void boot(initial)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  clearTimeout(timer)
  cancelRun()
  playground.dispose()
  void dropFiles([...inputs.value, ...(result.value?.outputs ?? [])])
})

function go(l: Lesson | undefined) {
  if (l) void router.push(`/learn/${l.id}`)
}
</script>

<template>
  <div class="flex h-dvh flex-col overflow-y-auto lg:overflow-hidden">
    <!-- Standalone header: the tutorial does not use the app's navigation. -->
    <header class="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card/80 px-3 backdrop-blur-xl sm:px-4">
      <RouterLink to="/" class="flex shrink-0 items-center gap-2 rounded-md transition-opacity hover:opacity-80" aria-label="返回 OmniTool">
        <AppLogo :size="26" />
        <span class="hidden text-sm font-semibold tracking-tight sm:inline">OmniTool</span>
      </RouterLink>
      <span class="hidden text-sm text-muted-foreground sm:inline">/</span>
      <span class="hidden shrink-0 text-sm font-medium md:inline">插件教程</span>
      <div class="mx-auto flex min-w-0 max-w-md flex-1 items-center gap-2">
        <Select :model-value="lesson.id" @update:model-value="router.push(`/learn/${$event}`)">
          <SelectTrigger class="h-8 min-w-0 flex-1 text-xs" aria-label="选择课程">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup v-for="chapter in chapters" :key="chapter.name">
              <SelectLabel class="text-[11px]">{{ chapter.name }}</SelectLabel>
              <SelectItem v-for="l in chapter.lessons" :key="l.id" :value="l.id" class="text-xs">
                {{ l.order }}. {{ l.title }}
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <span class="shrink-0 tabular-nums text-[11px] text-muted-foreground">{{ index + 1 }} / {{ LESSONS.length }}</span>
      </div>
      <Button variant="ghost" size="sm" class="hidden sm:inline-flex" title="复制插件文档与当前代码，交给 AI 助手" @click="copyForAi">
        <Icon name="sparkles" :size="13" />
        复制给 AI
      </Button>
      <Button variant="outline" size="sm" @click="router.push('/plugins/new')">
        <Icon name="file-code" :size="13" />
        <span class="hidden sm:inline">去编辑器</span>
      </Button>
    </header>

    <div class="flex min-h-0 flex-1 flex-col lg:flex-row">
    <!-- Lesson -->
    <article class="flex flex-col border-border lg:w-[40%] lg:min-w-[22rem] lg:border-r" data-learn-lesson>

      <div class="min-h-0 flex-1 overflow-y-auto scroll-slim px-4 py-5 sm:px-6">
        <p class="text-[11px] font-medium uppercase tracking-wider text-primary">{{ lesson.chapter }}</p>
        <h1 class="mt-1 text-xl font-semibold tracking-tight">{{ lesson.title }}</h1>
        <!-- eslint-disable-next-line vue/no-v-html -- first-party lesson Markdown, rendered with html: false -->
        <div class="lesson-prose mt-4" v-html="prose" />
      </div>

      <footer class="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3 sm:px-6">
        <Button variant="outline" size="sm" :disabled="code === lesson.solution" data-learn-solution @click="showSolution">
          <Icon name="eye" :size="13" />
          显示答案
        </Button>
        <Button variant="ghost" size="sm" :disabled="code === lesson.starter" @click="reset">
          <Icon name="refresh" :size="13" />
          重置
        </Button>
        <span class="ml-auto flex gap-2">
          <Button variant="ghost" size="sm" :disabled="!previous" @click="go(previous)">
            <Icon name="chevron-right" :size="13" class="rotate-180" />
            上一课
          </Button>
          <Button size="sm" :disabled="!next" data-learn-next @click="go(next)">
            下一课
            <Icon name="chevron-right" :size="13" />
          </Button>
        </span>
      </footer>
    </article>

    <!-- Code + preview -->
    <section class="flex min-w-0 flex-1 flex-col">
      <div class="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <Icon name="file-code" :size="14" class="text-muted-foreground" />
        <span class="text-xs font-medium">plugin.js</span>
        <Badge v-if="edited" variant="outline" class="text-[10px]">已修改</Badge>
      </div>
      <div class="h-[45vh] min-h-64 border-b border-border lg:h-auto lg:min-h-0 lg:flex-[1.1]">
        <CodeEditor v-model="code" class="h-full" />
      </div>

      <div class="min-h-0 overflow-y-auto scroll-slim lg:flex-1" data-learn-preview>
        <div class="flex items-center gap-2 border-b border-border px-3 py-1.5">
          <span class="text-xs font-medium">预览</span>
          <Badge v-if="state.status === 'booting'" variant="outline" class="gap-1 text-[10px]"><Spinner :size="10" /> 运行中</Badge>
          <Badge v-else-if="state.status === 'error'" variant="destructive" class="text-[10px]">加载失败</Badge>
          <Badge v-else-if="state.status === 'ready'" variant="success" class="text-[10px]" data-learn-ready>已运行</Badge>
          <label class="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <input v-model="autoRun" type="checkbox" class="accent-[var(--primary)]" />
            修改后自动运行
          </label>
        </div>

        <div class="space-y-4 p-4">
          <div v-if="state.status === 'error'" class="rounded-lg border border-destructive/30 bg-destructive/5 p-3" data-learn-error>
            <p class="whitespace-pre-wrap break-words font-mono text-xs text-destructive">{{ state.error }}</p>
          </div>

          <template v-if="state.manifest && entry">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-sm font-semibold">{{ state.manifest.name }}</span>
              <div v-if="tools.length > 1" class="flex flex-wrap gap-1">
                <Button
                  v-for="t in tools"
                  :key="t.id"
                  :variant="t.id === tool?.id ? 'secondary' : 'ghost'"
                  size="xs"
                  @click="toolId = t.id"
                >
                  {{ t.name }}
                </Button>
              </div>
              <span v-else class="text-xs text-muted-foreground">· {{ tool?.name }}</span>
            </div>
            <p v-if="ungranted.length" class="text-[11px] text-warning">
              教程预览不授予 {{ ungranted.join('、') }} 能力，相关调用会被宿主拒绝——这是有意的，第 11 课会讲原因。
            </p>

            <DropZone
              v-if="needsInput"
              :accept="tool?.accept ?? []"
              :multiple="tool?.multiple ?? false"
              :files="inputs"
              @add="addFiles"
              @remove="removeInput"
            />

            <PluginPanel
              v-if="tool?.hasSetup"
              :key="entry.key"
              v-model="params"
              :entry="entry"
              :inputs="inputs"
              :sandbox="panelSandbox"
              @meta="panelMeta = $event"
            />
            <ParamForm v-else-if="tool?.params?.length" v-model="params" :params="tool.params" />

            <div class="flex items-center gap-2">
              <Button size="sm" :disabled="!canRun" data-learn-run @click="run">
                <Icon :name="running ? 'loader' : 'play'" :size="13" :class="running ? 'animate-spin' : ''" />
                {{ running ? progress.label || '处理中…' : panelMeta.runLabel || '运行' }}
              </Button>
              <span v-if="running && progress.value !== null" class="tabular-nums text-[11px] text-muted-foreground">{{ Math.round(progress.value * 100) }}%</span>
            </div>
          </template>

          <div
            v-if="result"
            class="rounded-lg border p-3"
            :class="result.ok ? 'border-success/30 bg-success/5' : 'border-destructive/30 bg-destructive/5'"
            :data-learn-result="result.ok ? 'ok' : 'error'"
          >
            <p class="flex items-start gap-2 text-xs" :class="result.ok ? '' : 'text-destructive'">
              <Icon :name="result.ok ? 'circle-check' : 'circle-alert'" :size="14" :class="['mt-px shrink-0', result.ok ? 'text-success' : '']" />
              <span class="min-w-0 flex-1 whitespace-pre-wrap break-words">{{ result.summary }}</span>
              <span class="shrink-0 tabular-nums text-[10px] text-muted-foreground">{{ Math.round(result.ms) }} ms</span>
            </p>
          </div>
          <pre v-if="textOutput" class="max-h-56 overflow-auto scroll-slim rounded-lg bg-muted p-3 font-mono text-[11px] leading-relaxed">{{ textOutput }}</pre>
          <FileGrid v-if="result?.outputs.length" :ids="result.outputs" zip-name="learn-output.zip" empty-text="" />

          <details v-if="state.logs.length" class="rounded-lg border border-border">
            <summary class="cursor-pointer px-3 py-1.5 text-[11px] text-muted-foreground">控制台输出（{{ state.logs.length }}）</summary>
            <ul class="max-h-40 overflow-auto scroll-slim border-t border-border px-3 py-2 font-mono text-[11px]">
              <li v-for="(log, i) in state.logs" :key="i" :class="log.level === 'error' ? 'text-destructive' : log.level === 'warn' ? 'text-warning' : ''">
                {{ log.text }}
              </li>
            </ul>
          </details>
        </div>
      </div>
    </section>
    </div>
  </div>
</template>

<style scoped>
.lesson-prose {
  font-size: 0.875rem;
  line-height: 1.75;
}
.lesson-prose :deep(h2) {
  margin: 1.75rem 0 0.5rem;
  font-size: 1rem;
  font-weight: 600;
}
.lesson-prose :deep(h3) {
  margin: 1.25rem 0 0.5rem;
  font-size: 0.875rem;
  font-weight: 600;
}
.lesson-prose :deep(p),
.lesson-prose :deep(ul),
.lesson-prose :deep(ol),
.lesson-prose :deep(blockquote),
.lesson-prose :deep(pre),
.lesson-prose :deep(table) {
  margin: 0.75rem 0;
}
.lesson-prose :deep(ul) {
  list-style: disc;
  padding-left: 1.25rem;
}
.lesson-prose :deep(ol) {
  list-style: decimal;
  padding-left: 1.25rem;
}
.lesson-prose :deep(li) {
  margin: 0.25rem 0;
}
.lesson-prose :deep(code) {
  border-radius: 0.25rem;
  background: var(--muted);
  padding: 0.1rem 0.3rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8em;
}
.lesson-prose :deep(pre) {
  overflow-x: auto;
  border-radius: 0.5rem;
  background: var(--muted);
  padding: 0.75rem 1rem;
  font-size: 0.75rem;
  line-height: 1.6;
}
.lesson-prose :deep(pre code) {
  background: none;
  padding: 0;
  font-size: inherit;
}
.lesson-prose :deep(blockquote) {
  border-left: 3px solid var(--primary);
  padding-left: 0.75rem;
  color: var(--muted-foreground);
}
.lesson-prose :deep(a) {
  color: var(--primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.lesson-prose :deep(table) {
  display: block;
  overflow-x: auto;
  font-size: 0.75rem;
}
.lesson-prose :deep(th),
.lesson-prose :deep(td) {
  border: 1px solid var(--border);
  padding: 0.25rem 0.5rem;
  text-align: left;
}
.lesson-prose :deep(strong) {
  font-weight: 600;
}
</style>
