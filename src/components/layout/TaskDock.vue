<script setup lang="ts">
/**
 * Task queue as a floating window.
 *
 * An earlier floating version covered whatever sat in the corner, including a
 * tool's run button. This one avoids that by design rather than by padding:
 *
 *   - At rest it is a small pill (icon, counts, overall progress), not a panel.
 *     The list opens only when asked for and closes with Esc or a click outside.
 *   - It can be dragged anywhere; the position is kept relative to the nearest
 *     corners, so resizing the window never strands it off-screen.
 *   - It disappears when the queue is empty, and the main scroll area reserves
 *     room at its end (App.vue) so the last thing on a page is never under it.
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import Icon from '@/components/common/Icon.vue'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { cancel, clearFinished, overallProgress, removeTask, tasks, type Task } from '@/core/tasks/queue'
import { formatDuration } from '@/lib/format'

const open = ref(false)
const dismissed = ref(false)
const route = useRoute()

// Going somewhere else closes the list; the pill stays.
watch(() => route.fullPath, () => (open.value = false))
const root = ref<HTMLElement | null>(null)

const active = computed(() => tasks.filter((t) => t.status === 'running' || t.status === 'queued'))
const finished = computed(() => tasks.filter((t) => t.status !== 'running' && t.status !== 'queued'))
const failed = computed(() => tasks.filter((t) => t.status === 'failed').length)
const ordered = computed(() => [...active.value, ...finished.value])
const visible = computed(() => tasks.length > 0 && !dismissed.value)

// A new task always brings the window back, even if it was dismissed earlier.
watch(
  () => tasks.length,
  (next, previous) => {
    if (next > previous) dismissed.value = false
    if (next === 0) open.value = false
  },
)

const STATUS: Record<Task['status'], { icon: string; class: string }> = {
  queued: { icon: 'list-todo', class: 'text-muted-foreground' },
  running: { icon: 'loader', class: 'text-primary' },
  done: { icon: 'circle-check', class: 'text-success' },
  failed: { icon: 'circle-alert', class: 'text-destructive' },
  cancelled: { icon: 'ban', class: 'text-muted-foreground' },
}

function elapsed(task: Task): string {
  if (!task.startedAt) return ''
  return formatDuration((task.endedAt ?? Date.now()) - task.startedAt)
}

/* ---------------------------------------------------------------- position */

/** Distance from the right and bottom edges, in px. */
const MARGIN = 16
const STORAGE_KEY = 'omnitool.taskDock.position'
const offset = ref<{ right: number; bottom: number }>(loadOffset())

function loadOffset() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (saved && Number.isFinite(saved.right) && Number.isFinite(saved.bottom)) return { right: saved.right, bottom: saved.bottom }
  } catch {
    /* storage unavailable */
  }
  return { right: MARGIN, bottom: MARGIN }
}

function saveOffset() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(offset.value))
  } catch {
    /* storage unavailable */
  }
}

/** Keeps the whole window on screen, e.g. after a resize or when the list opens. */
function clamp() {
  const el = root.value
  if (!el) return
  const { width, height } = el.getBoundingClientRect()
  offset.value = {
    right: Math.min(Math.max(MARGIN / 2, offset.value.right), Math.max(MARGIN / 2, window.innerWidth - width - MARGIN / 2)),
    bottom: Math.min(Math.max(MARGIN / 2, offset.value.bottom), Math.max(MARGIN / 2, window.innerHeight - height - MARGIN / 2)),
  }
}

let drag: { x: number; y: number; right: number; bottom: number; moved: boolean } | null = null

function startDrag(event: PointerEvent) {
  if (event.button !== 0) return
  drag = { x: event.clientX, y: event.clientY, right: offset.value.right, bottom: offset.value.bottom, moved: false }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function moveDrag(event: PointerEvent) {
  if (!drag) return
  const dx = event.clientX - drag.x
  const dy = event.clientY - drag.y
  // A few pixels of jitter is still a click.
  if (!drag.moved && Math.hypot(dx, dy) < 4) return
  drag.moved = true
  offset.value = { right: drag.right - dx, bottom: drag.bottom - dy }
  clamp()
}

/** Returns true when the gesture was a drag, so the click handler can ignore it. */
function endDrag(): boolean {
  const moved = !!drag?.moved
  drag = null
  if (moved) saveOffset()
  return moved
}

function onPillUp() {
  if (!endDrag()) toggle()
}

async function toggle() {
  open.value = !open.value
  await nextTick()
  clamp()
}

/* ------------------------------------------------------------ dismissal */

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && open.value) open.value = false
}

function onPointerDownOutside(event: PointerEvent) {
  if (open.value && root.value && !root.value.contains(event.target as Node)) open.value = false
}

onMounted(() => {
  window.addEventListener('resize', clamp)
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('pointerdown', onPointerDownOutside, true)
})
onUnmounted(() => {
  window.removeEventListener('resize', clamp)
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('pointerdown', onPointerDownOutside, true)
})

watch(visible, async (shown) => {
  if (!shown) return
  await nextTick()
  clamp()
})

const pillLabel = computed(() => {
  if (active.value.length) return `${active.value.length} 个任务进行中`
  if (failed.value) return `${failed.value} 个任务失败`
  return `${finished.value.length} 个任务已完成`
})
</script>

<template>
  <Transition name="omni-dock">
    <section
      v-if="visible"
      ref="root"
      class="fixed z-40 flex flex-col items-end gap-2"
      :style="{ right: `${offset.right}px`, bottom: `${offset.bottom}px` }"
      aria-label="任务队列"
      data-task-dock
    >
      <!-- The list, above the pill -->
      <Transition name="omni-dock-panel">
        <div
          v-if="open"
          class="flex max-h-[min(28rem,70dvh)] w-[min(26rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-card/95 shadow-2xl backdrop-blur-xl"
          role="dialog"
          aria-label="任务列表"
        >
          <header
            class="flex cursor-grab touch-none select-none items-center gap-2 border-b border-border px-3 py-2 active:cursor-grabbing"
            @pointerdown="startDrag"
            @pointermove="moveDrag"
            @pointerup="endDrag"
          >
            <Icon name="grip-vertical" :size="13" class="shrink-0 text-muted-foreground" />
            <span class="text-xs font-semibold">任务队列</span>
            <span class="truncate tabular-nums text-[11px] text-muted-foreground">
              {{ active.length }} 进行中 · {{ finished.length }} 已结束
            </span>
            <span class="ml-auto flex items-center gap-0.5" @pointerdown.stop>
              <Button
                v-if="finished.length"
                variant="ghost"
                size="icon-sm"
                title="清除已结束的任务"
                aria-label="清除已结束的任务"
                @click="clearFinished"
              >
                <Icon name="trash" :size="13" />
              </Button>
              <Button variant="ghost" size="icon-sm" title="收起" aria-label="收起任务列表" @click="open = false">
                <Icon name="minimize" :size="13" />
              </Button>
              <Button
                v-if="!active.length"
                variant="ghost"
                size="icon-sm"
                title="关闭"
                aria-label="关闭任务队列"
                @click="dismissed = true"
              >
                <Icon name="x" :size="13" />
              </Button>
            </span>
          </header>

          <ul class="min-h-0 flex-1 divide-y divide-border overflow-y-auto scroll-slim">
            <li v-for="task in ordered" :key="task.id" class="px-3 py-2">
              <div class="flex items-center gap-2.5">
                <Icon
                  :name="STATUS[task.status].icon"
                  :size="14"
                  :class="['shrink-0', STATUS[task.status].class, task.status === 'running' ? 'animate-spin' : '']"
                />
                <div class="min-w-0 flex-1">
                  <p class="truncate text-xs font-medium">{{ task.toolName }}</p>
                  <p class="truncate text-[11px] text-muted-foreground" :title="task.label || task.summary || task.error">
                    {{ task.label || task.summary || task.error || `${task.inputs.length} 个输入文件` }}
                  </p>
                </div>
                <span class="shrink-0 tabular-nums text-[10px] text-muted-foreground">{{ elapsed(task) }}</span>
                <button
                  type="button"
                  class="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
                  :aria-label="task.status === 'running' || task.status === 'queued' ? '取消任务' : '移除记录'"
                  @click="task.status === 'running' || task.status === 'queued' ? cancel(task.id) : removeTask(task.id)"
                >
                  <Icon :name="task.status === 'running' || task.status === 'queued' ? 'ban' : 'x'" :size="12" />
                </button>
              </div>
              <Progress
                v-if="task.status === 'running'"
                :model-value="task.progress === null ? null : task.progress * 100"
                class="mt-1.5 h-1"
              />
            </li>
          </ul>
        </div>
      </Transition>

      <!-- The pill: click to open, drag to move -->
      <button
        type="button"
        class="flex h-10 cursor-grab touch-none select-none items-center gap-2 rounded-full border border-border bg-card/95 pl-3 pr-3.5 shadow-lg backdrop-blur-xl transition-shadow hover:shadow-xl active:cursor-grabbing"
        :aria-expanded="open"
        :aria-label="`任务队列：${pillLabel}`"
        :title="`${pillLabel}（拖动可移动位置）`"
        data-task-dock-toggle
        @pointerdown="startDrag"
        @pointermove="moveDrag"
        @pointerup="onPillUp"
        @keydown.enter.prevent="toggle"
        @keydown.space.prevent="toggle"
      >
        <Icon
          :name="active.length ? 'loader' : failed ? 'circle-alert' : 'circle-check'"
          :size="15"
          :class="['shrink-0', active.length ? 'animate-spin text-primary' : failed ? 'text-destructive' : 'text-success']"
        />
        <span class="text-xs font-medium tabular-nums">{{ active.length ? active.length : tasks.length }}</span>
        <Progress
          v-if="active.length"
          :model-value="overallProgress === null ? null : overallProgress * 100"
          class="h-1 w-12"
        />
      </button>
    </section>
  </Transition>
</template>

<style scoped>
.omni-dock-enter-active,
.omni-dock-leave-active,
.omni-dock-panel-enter-active,
.omni-dock-panel-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}
.omni-dock-enter-from,
.omni-dock-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.96);
}
.omni-dock-panel-enter-from,
.omni-dock-panel-leave-to {
  opacity: 0;
  transform: translateY(6px) scale(0.98);
  transform-origin: bottom right;
}
</style>
