<script setup lang="ts">
/**
 * A pipeline drawn as a flowchart, for large screens.
 *
 *   [输入文件] ──▶ [步骤 1] ──▶ [步骤 2] ──▶ … ──▶ [结果]
 *
 * It edits the same `PipelineStep[]` the list editor does, so the two views
 * are interchangeable. The canvas pans (drag the background, or scroll) and
 * zooms (Ctrl/⌘ + scroll, the zoom buttons, or 「适应」); nodes lay out left
 * to right automatically, since a pipeline is a sequence. A connector's 「+」
 * inserts a step at that point; selecting a step opens its parameters in the
 * inspector beside the canvas. During a run, nodes take the step's state and
 * connectors show how many files passed along them.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '@/components/common/Icon.vue'
import ParamForm from '@/components/tool/ParamForm.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { findTool } from '@/core/plugin/registry'
import { defaultParams } from '@/core/plugin/params'
import { stepIneligibility, type PipelineRun, type PipelineStep } from '@/core/pipelines'
import { CATEGORY_LABEL, type ParamValues } from '@/core/types'

const props = defineProps<{
  steps: PipelineStep[]
  run?: PipelineRun
  inputCount: number
  cleanup: boolean
}>()

const emit = defineEmits<{
  /** Open the tool picker to insert a step at `index`. */
  insert: [index: number]
  remove: [index: number]
  move: [index: number, delta: number]
}>()

const NODE_W = 248
const NODE_H = 132
const GAP = 88
const PAD = 48

const selectedId = ref<string | null>(null)
const selectedIndex = computed(() => props.steps.findIndex((s) => s.id === selectedId.value))
const selected = computed(() => props.steps[selectedIndex.value])

watch(
  () => props.steps.map((s) => s.id).join('|'),
  () => {
    if (selectedId.value && selectedIndex.value === -1) selectedId.value = null
  },
)

/* ------------------------------------------------------------------ layout */

interface FlowNode {
  key: string
  kind: 'input' | 'step' | 'output'
  index: number
  x: number
  y: number
}

const nodes = computed<FlowNode[]>(() => {
  const list: FlowNode[] = [{ key: 'input', kind: 'input', index: -1, x: PAD, y: PAD }]
  props.steps.forEach((step, i) => list.push({ key: step.id, kind: 'step', index: i, x: PAD + (i + 1) * (NODE_W + GAP), y: PAD }))
  list.push({ key: 'output', kind: 'output', index: props.steps.length, x: PAD + (props.steps.length + 1) * (NODE_W + GAP), y: PAD })
  return list
})

const contentWidth = computed(() => PAD * 2 + nodes.value.length * NODE_W + (nodes.value.length - 1) * GAP)
const contentHeight = NODE_H + PAD * 2

/** Connector `i` runs into step `i` (or into the result node when `i === steps.length`). */
const edges = computed(() =>
  nodes.value.slice(1).map((to, i) => {
    const from = nodes.value[i]
    const x1 = from.x + NODE_W
    const y1 = from.y + NODE_H / 2
    const x2 = to.x
    const y2 = to.y + NODE_H / 2
    const bend = GAP * 0.5
    return {
      index: i,
      path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
      mid: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 },
      to,
    }
  }),
)

/* ------------------------------------------------------------- pan & zoom */

const viewport = ref<HTMLElement | null>(null)
const view = ref({ x: 0, y: 0, k: 1 })
const MIN_K = 0.35
const MAX_K = 1.6

/** Readable text matters more than seeing every node: fitting never shrinks below this; longer flows pan. */
const FIT_MIN_K = 0.75

function fit() {
  const el = viewport.value
  if (!el) return
  const { width, height } = el.getBoundingClientRect()
  const k = Math.min(1, Math.max(FIT_MIN_K, Math.min(width / contentWidth.value, height / contentHeight)))
  // Centre when everything fits; otherwise start at the input node and let the user pan.
  view.value = { k, x: Math.max(0, (width - contentWidth.value * k) / 2), y: Math.max(0, (height - contentHeight * k) / 2) }
}

function zoomAt(factor: number, cx?: number, cy?: number) {
  const el = viewport.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const px = cx ?? rect.width / 2
  const py = cy ?? rect.height / 2
  const k = Math.min(MAX_K, Math.max(MIN_K, view.value.k * factor))
  const ratio = k / view.value.k
  view.value = { k, x: px - (px - view.value.x) * ratio, y: py - (py - view.value.y) * ratio }
}

function onWheel(event: WheelEvent) {
  event.preventDefault()
  if (event.ctrlKey || event.metaKey) {
    const rect = viewport.value!.getBoundingClientRect()
    zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top)
  } else {
    // A mouse wheel scrolls vertically; along a left-to-right flow that should move sideways.
    const dx = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX || event.deltaY : event.deltaY
    view.value = { ...view.value, x: view.value.x - dx }
  }
}

let pan: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0 || (event.target as HTMLElement).closest('[data-flow-interactive]')) return
  pan = { x: event.clientX, y: event.clientY, vx: view.value.x, vy: view.value.y, moved: false }
  viewport.value?.setPointerCapture(event.pointerId)
}

function onPointerMove(event: PointerEvent) {
  if (!pan) return
  const dx = event.clientX - pan.x
  const dy = event.clientY - pan.y
  if (Math.hypot(dx, dy) > 3) pan.moved = true
  view.value = { ...view.value, x: pan.vx + dx, y: pan.vy + dy }
}

function onPointerUp() {
  // A click on empty canvas (no drag) clears the selection.
  if (pan && !pan.moved) selectedId.value = null
  pan = null
}

function onKeydown(event: KeyboardEvent) {
  if ((event.target as HTMLElement).closest('input, textarea, [role=combobox], [contenteditable]')) return
  if (event.key === 'Escape') selectedId.value = null
  if ((event.key === 'Delete' || event.key === 'Backspace') && selected.value) {
    event.preventDefault()
    emit('remove', selectedIndex.value)
  }
  if (event.key === '0' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    fit()
  }
}

let resizeObserver: ResizeObserver | null = null
onMounted(async () => {
  await nextTick()
  fit()
  resizeObserver = new ResizeObserver(() => fit())
  if (viewport.value) resizeObserver.observe(viewport.value)
})
onBeforeUnmount(() => resizeObserver?.disconnect())

// Re-fit when steps are added or removed, so the new node is on screen.
watch(() => props.steps.length, async () => {
  await nextTick()
  fit()
})

/* --------------------------------------------------------------- content */

function toolOf(step: PipelineStep) {
  return findTool(step.toolKey)
}

function problemOf(step: PipelineStep) {
  const entry = toolOf(step)
  return entry ? stepIneligibility(entry.tool) : '找不到这个工具'
}

function paramsOf(step: PipelineStep): ParamValues {
  const entry = toolOf(step)
  return entry ? { ...defaultParams(entry.tool), ...step.params } : step.params
}

/** The first few visible parameters as `label: value`, for the node face. */
function summaryOf(step: PipelineStep): Array<{ label: string; value: string }> {
  const entry = toolOf(step)
  if (!entry?.tool.params?.length) return []
  const values = paramsOf(step)
  return entry.tool.params
    .filter((param) => {
      if (!param.when) return true
      const current = values[param.when.key]
      return Array.isArray(param.when.equals) ? param.when.equals.includes(current) : current === param.when.equals
    })
    .slice(0, 3)
    .map((param) => {
      const raw = values[param.key]
      let value = String(raw ?? '')
      if (param.type === 'select') value = param.options.find((o) => o.value === raw)?.label ?? value
      if (param.type === 'switch') value = raw ? '开' : '关'
      if ((param.type === 'slider' || param.type === 'number') && param.suffix) value += param.suffix
      return { label: param.label, value: value || '—' }
    })
}

function acceptLabel(step: PipelineStep | undefined) {
  const accept = step ? toolOf(step)?.tool.accept : undefined
  if (!accept?.length) return '任意文件'
  const shown = accept.slice(0, 3).map((a) => a.replace(/^application\//, '').replace('/*', ''))
  return shown.join(' · ') + (accept.length > 3 ? ' …' : '')
}

const stepState = (index: number) => props.run?.steps[index]?.state

const NODE_TONE: Record<string, string> = {
  pending: 'border-border',
  running: 'border-primary ring-2 ring-primary/25',
  done: 'border-success/60',
  failed: 'border-destructive ring-2 ring-destructive/20',
  cancelled: 'border-border opacity-70',
}

function edgeState(index: number): 'idle' | 'active' | 'done' | 'failed' {
  const run = props.run
  if (!run) return 'idle'
  if (index === props.steps.length) return run.status === 'done' ? 'done' : run.status === 'failed' ? 'failed' : 'idle'
  const state = run.steps[index]?.state
  if (state === 'running') return 'active'
  if (state === 'done') return 'done'
  if (state === 'failed') return 'failed'
  return 'idle'
}

function edgeLabel(index: number): string {
  const run = props.run
  if (index === props.steps.length) return run?.status === 'done' ? `${run.outputs.length} 个文件` : ''
  const state = run?.steps[index]
  if (state && state.state !== 'pending') return `${state.inputs} 个文件`
  const entry = props.steps[index] ? toolOf(props.steps[index]) : undefined
  return entry && !entry.tool.multiple ? '逐个处理' : ''
}
</script>

<template>
  <div class="flex flex-col overflow-hidden rounded-xl border border-border bg-card lg:h-[clamp(24rem,56vh,40rem)] lg:flex-row" data-pipeline-flow>
    <!-- Canvas -->
    <div class="relative h-[24rem] min-w-0 flex-1 lg:h-auto">
      <div
        ref="viewport"
        class="flow-grid absolute inset-0 cursor-grab touch-none overflow-hidden outline-none active:cursor-grabbing"
        :style="{ '--grid': `${24 * view.k}px`, backgroundPosition: `${view.x}px ${view.y}px` }"
        tabindex="0"
        aria-label="工作流流程图"
        @wheel="onWheel"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @keydown="onKeydown"
      >
        <div
          class="absolute left-0 top-0 origin-top-left"
          :style="{ width: `${contentWidth}px`, height: `${contentHeight}px`, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }"
        >
          <!-- Connectors -->
          <svg class="pointer-events-none absolute inset-0 overflow-visible" :width="contentWidth" :height="contentHeight">
            <defs>
              <marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" class="fill-muted-foreground/60" />
              </marker>
            </defs>
            <path
              v-for="edge in edges"
              :key="edge.index"
              :d="edge.path"
              fill="none"
              stroke-width="2"
              marker-end="url(#flow-arrow)"
              :class="{
                'stroke-muted-foreground/40': edgeState(edge.index) === 'idle',
                'flow-active stroke-primary': edgeState(edge.index) === 'active',
                'stroke-success/70': edgeState(edge.index) === 'done',
                'stroke-destructive/70': edgeState(edge.index) === 'failed',
              }"
            />
          </svg>

          <!-- Connector controls: label + insert -->
          <div
            v-for="edge in edges"
            :key="`c${edge.index}`"
            class="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1"
            :style="{ left: `${edge.mid.x}px`, top: `${edge.mid.y}px` }"
          >
            <span v-if="edgeLabel(edge.index)" class="absolute -top-6 whitespace-nowrap rounded bg-card px-1.5 text-[10px] tabular-nums text-muted-foreground">
              {{ edgeLabel(edge.index) }}
            </span>
            <button
              type="button"
              class="flex size-6 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:border-primary hover:text-primary"
              :aria-label="`在第 ${edge.index + 1} 步前插入步骤`"
              :title="edge.index === steps.length ? '在末尾添加步骤' : `在这里插入步骤`"
              data-flow-interactive
              data-flow-insert
              @click="emit('insert', edge.index)"
            >
              <Icon name="plus" :size="13" />
            </button>
          </div>

          <!-- Nodes -->
          <template v-for="node in nodes" :key="node.key">
            <!-- Input -->
            <div
              v-if="node.kind === 'input'"
              class="absolute flex flex-col rounded-xl border border-dashed border-border bg-background/90 p-3 shadow-sm"
              :style="{ left: `${node.x}px`, top: `${node.y}px`, width: `${NODE_W}px`, height: `${NODE_H}px` }"
            >
              <div class="flex items-center gap-2">
                <span class="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Icon name="upload" :size="15" /></span>
                <div class="min-w-0">
                  <p class="text-sm font-semibold">输入文件</p>
                  <p class="text-[11px] text-muted-foreground">{{ inputCount ? `已选择 ${inputCount} 个` : '在下方拖入文件' }}</p>
                </div>
              </div>
              <p class="mt-auto truncate text-[11px] text-muted-foreground">接受：{{ acceptLabel(steps[0]) }}</p>
            </div>

            <!-- Step -->
            <div
              v-else-if="node.kind === 'step'"
              class="absolute flex cursor-pointer flex-col rounded-xl border bg-background p-3 text-left shadow-sm transition-shadow hover:shadow-md"
              :class="[
                NODE_TONE[stepState(node.index) ?? 'pending'],
                selectedId === steps[node.index].id ? 'ring-2 ring-primary/40' : '',
                problemOf(steps[node.index]) ? 'border-destructive/60' : '',
              ]"
              :style="{ left: `${node.x}px`, top: `${node.y}px`, width: `${NODE_W}px`, height: `${NODE_H}px` }"
              role="button"
              tabindex="0"
              :aria-pressed="selectedId === steps[node.index].id"
              data-flow-interactive
              data-flow-node
              @click="selectedId = steps[node.index].id"
              @keydown.enter="selectedId = steps[node.index].id"
            >
              <div class="flex items-center gap-2">
                <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon :name="toolOf(steps[node.index])?.tool.icon ?? 'package'" :size="15" />
                </span>
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-semibold">{{ toolOf(steps[node.index])?.tool.name ?? steps[node.index].toolKey }}</p>
                  <p class="truncate text-[11px] text-muted-foreground">
                    {{ node.index + 1 }} · {{ toolOf(steps[node.index]) ? CATEGORY_LABEL[toolOf(steps[node.index])!.tool.category] : '未知工具' }}
                  </p>
                </div>
                <Icon
                  v-if="stepState(node.index) && stepState(node.index) !== 'pending'"
                  :name="{ running: 'loader', done: 'circle-check', failed: 'circle-alert', cancelled: 'ban', pending: 'circle' }[stepState(node.index)!]"
                  :size="15"
                  :class="{
                    'animate-spin text-primary': stepState(node.index) === 'running',
                    'text-success': stepState(node.index) === 'done',
                    'text-destructive': stepState(node.index) === 'failed',
                    'text-muted-foreground': stepState(node.index) === 'cancelled',
                  }"
                />
              </div>
              <p v-if="problemOf(steps[node.index])" class="mt-2 line-clamp-2 text-[11px] text-destructive">{{ problemOf(steps[node.index]) }}</p>
              <dl v-else class="mt-2 space-y-0.5">
                <div v-for="row in summaryOf(steps[node.index])" :key="row.label" class="flex gap-2 text-[11px]">
                  <dt class="shrink-0 text-muted-foreground">{{ row.label }}</dt>
                  <dd class="min-w-0 truncate text-right font-medium" style="margin-left: auto">{{ row.value }}</dd>
                </div>
                <p v-if="!summaryOf(steps[node.index]).length" class="text-[11px] text-muted-foreground">无需参数</p>
              </dl>
            </div>

            <!-- Output -->
            <div
              v-else
              class="absolute flex flex-col rounded-xl border bg-background/90 p-3 shadow-sm"
              :class="run?.status === 'done' ? 'border-success/60' : run?.status === 'failed' ? 'border-destructive/60' : 'border-dashed border-border'"
              :style="{ left: `${node.x}px`, top: `${node.y}px`, width: `${NODE_W}px`, height: `${NODE_H}px` }"
            >
              <div class="flex items-center gap-2">
                <span class="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Icon name="download" :size="15" /></span>
                <div class="min-w-0">
                  <p class="text-sm font-semibold">结果</p>
                  <p class="text-[11px] text-muted-foreground">
                    {{ run?.status === 'done' ? `${run.outputs.length} 个文件` : run?.status === 'running' ? '处理中…' : run?.status === 'failed' ? '运行失败' : '运行后显示' }}
                  </p>
                </div>
              </div>
              <p class="mt-auto text-[11px] text-muted-foreground">{{ cleanup ? '完成后删除中间文件' : '保留中间文件' }}</p>
            </div>
          </template>
        </div>
      </div>

      <!-- Zoom controls -->
      <div class="absolute bottom-3 left-3 flex items-center gap-0.5 rounded-lg border border-border bg-card/95 p-0.5 shadow-sm backdrop-blur" data-flow-interactive>
        <Button variant="ghost" size="icon" class="size-7" aria-label="缩小" @click="zoomAt(1 / 1.2)"><Icon name="minimize" :size="13" /></Button>
        <span class="w-10 text-center text-[11px] tabular-nums text-muted-foreground">{{ Math.round(view.k * 100) }}%</span>
        <Button variant="ghost" size="icon" class="size-7" aria-label="放大" @click="zoomAt(1.2)"><Icon name="maximize" :size="13" /></Button>
        <Button variant="ghost" size="xs" class="h-7" title="适应画布（Ctrl/⌘ 0）" @click="fit">适应</Button>
      </div>
      <p class="pointer-events-none absolute bottom-3 right-3 hidden text-[10px] text-muted-foreground xl:block">
        拖动画布平移 · Ctrl/⌘ + 滚轮缩放 · Delete 删除选中步骤
      </p>
    </div>

    <!-- Inspector -->
    <aside class="flex max-h-[32rem] w-full shrink-0 flex-col border-t border-border lg:max-h-none lg:w-80 lg:border-l lg:border-t-0" data-flow-inspector>
      <template v-if="selected">
        <div class="flex items-center gap-2 border-b border-border px-4 py-3">
          <span class="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon :name="toolOf(selected)?.tool.icon ?? 'package'" :size="15" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold">{{ toolOf(selected)?.tool.name ?? selected.toolKey }}</p>
            <p class="truncate text-[11px] text-muted-foreground">第 {{ selectedIndex + 1 }} 步 · {{ toolOf(selected)?.pluginName }}</p>
          </div>
        </div>
        <div class="min-h-0 flex-1 space-y-3 overflow-y-auto scroll-slim px-4 py-4">
          <p v-if="toolOf(selected)?.tool.description" class="text-[11px] leading-relaxed text-muted-foreground">{{ toolOf(selected)!.tool.description }}</p>
          <div class="flex flex-wrap gap-1">
            <Badge variant="outline" class="text-[10px]">接受：{{ acceptLabel(selected) }}</Badge>
            <Badge variant="outline" class="text-[10px]">{{ toolOf(selected)?.tool.multiple ? '一次处理全部文件' : '逐个文件处理' }}</Badge>
          </div>
          <p v-if="problemOf(selected)" class="text-xs text-destructive">{{ problemOf(selected) }}</p>
          <ParamForm
            v-else-if="toolOf(selected)?.tool.params?.length"
            :model-value="paramsOf(selected)"
            :params="toolOf(selected)!.tool.params!"
            @update:model-value="selected.params = $event"
          />
          <p v-else class="text-xs text-muted-foreground">该工具无需配置参数。</p>
        </div>
        <div class="flex flex-wrap gap-2 border-t border-border px-4 py-3">
          <Button variant="outline" size="sm" :disabled="selectedIndex === 0" @click="emit('move', selectedIndex, -1)">
            <Icon name="chevron-right" :size="13" class="rotate-180" />
            前移
          </Button>
          <Button variant="outline" size="sm" :disabled="selectedIndex === steps.length - 1" @click="emit('move', selectedIndex, 1)">
            后移
            <Icon name="chevron-right" :size="13" />
          </Button>
          <Button variant="ghost" size="sm" class="ml-auto text-destructive" @click="emit('remove', selectedIndex)">
            <Icon name="trash" :size="13" />
            删除
          </Button>
        </div>
      </template>
      <div v-else class="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
        <Icon name="sliders" :size="20" class="text-muted-foreground" />
        <p class="text-xs font-medium">选择一个步骤</p>
        <p class="text-[11px] leading-relaxed text-muted-foreground">点击流程图中的步骤查看与修改参数；点击连线上的「+」插入新步骤。</p>
        <Button v-if="!steps.length" size="sm" class="mt-2" @click="emit('insert', 0)">
          <Icon name="plus" :size="13" />
          添加第一个步骤
        </Button>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.flow-grid {
  background-color: color-mix(in oklch, var(--muted) 35%, transparent);
  background-image: radial-gradient(circle, color-mix(in oklch, var(--muted-foreground) 28%, transparent) 1px, transparent 1.2px);
  background-size: var(--grid) var(--grid);
}
.flow-active {
  stroke-dasharray: 6 6;
  animation: flow-dash 0.6s linear infinite;
}
@keyframes flow-dash {
  to {
    stroke-dashoffset: -12;
  }
}
</style>
