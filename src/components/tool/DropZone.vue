<script setup lang="ts">
/**
 * File intake: drag-and-drop, click-to-browse, paste, or picking files already
 * in the workspace.
 *
 * Files are imported into the VFS immediately (streamed to OPFS, not held in the
 * heap) and the caller only ever sees ids. The VFS recognises content it already
 * holds, so dropping the same file twice does not store it twice.
 *
 * Removing a file from the list only deselects it: the same workspace file may
 * be selected in another tool or workflow. Deleting is done on the workspace page.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { Button } from '@/components/ui/button'
import WorkspacePicker from './WorkspacePicker.vue'
import * as vfs from '@/core/vfs'
import { pushToast } from '@/core/ui/toast'
import { matchesAccept } from '@/core/plugin/params'
import { formatBytes } from '@/lib/format'

const props = withDefaults(defineProps<{ accept?: string[]; multiple?: boolean; files?: string[] }>(), {
  accept: () => [],
  multiple: true,
  files: () => [],
})

const emit = defineEmits<{ add: [ids: string[]]; remove: [id: string] }>()

const dragging = ref(false)
const importing = ref(false)
const input = ref<HTMLInputElement | null>(null)
/** Nested dragenter/dragleave pairs fire constantly; count them instead of toggling. */
let dragDepth = 0

const acceptAttr = computed(() => (props.accept.length ? props.accept.join(',') : undefined))
const pasteChord = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl'

const entries = computed(() => props.files.map((id) => vfs.get(id)).filter((e): e is vfs.VfsEntry => Boolean(e)))

const pickerOpen = ref(false)
/** Workspace files this tool could take that are not selected yet. */
const available = computed(() => {
  const keys = new Set<string>()
  for (const entry of vfs.entries) {
    if (props.files.includes(entry.id) || vfs.isWriting(entry.id) || !matchesAccept(entry, props.accept)) continue
    keys.add(`${vfs.storageKey(entry)}|${entry.name}`)
  }
  return keys.size
})

function onPick(ids: string[]) {
  emit('add', props.multiple ? ids : ids.slice(0, 1))
}
const totalSize = computed(() => entries.value.reduce((sum, entry) => sum + entry.size, 0))

async function ingest(list: FileList | File[] | null) {
  if (!list) return
  const files = [...list]
  if (files.length === 0) return

  importing.value = true
  try {
    const accepted = props.multiple ? files : files.slice(0, 1)
    const ids: string[] = []
    let reused = 0
    for (const file of accepted) {
      if (!matchesAccept(file, props.accept)) {
        pushToast({ level: 'warn', message: `已跳过 ${file.name}：与该工具接受的类型不匹配` })
        continue
      }
      const known = new Set(vfs.entries.map((entry) => entry.id))
      let entry = await vfs.importFile(file)
      if (known.has(entry.id) || entry.storage) reused++
      // The same file again in one list (joining a clip with itself) is a real
      // second selection: give it its own entry over the same stored bytes.
      if (props.files.includes(entry.id) || ids.includes(entry.id)) entry = await vfs.alias(entry.id)
      ids.push(entry.id)
    }
    if (reused) pushToast({ level: 'info', message: `${reused} 个文件已在工作区中，直接复用，未重复占用空间` })
    if (ids.length) emit('add', ids)
  } catch (error) {
    pushToast({ level: 'error', title: '导入失败', message: error instanceof Error ? error.message : String(error) })
  } finally {
    importing.value = false
  }
}


function onDrop(event: DragEvent) {
  dragDepth = 0
  dragging.value = false
  void ingest(event.dataTransfer?.files ?? null)
}

function onPaste(event: ClipboardEvent) {
  const files = [...(event.clipboardData?.files ?? [])]
  if (files.length) void ingest(files)
}

onMounted(() => window.addEventListener('paste', onPaste))
onUnmounted(() => window.removeEventListener('paste', onPaste))
</script>

<template>
  <div>
    <div
      class="relative rounded-xl border-2 border-dashed p-8 text-center transition-all duration-200"
      :class="
        dragging
          ? 'scale-[1.01] border-primary bg-primary/10 shadow-[0_0_0_4px_color-mix(in_oklab,var(--primary)_18%,transparent)]'
          : 'border-border hover:border-primary/40 hover:bg-muted/50'
      "
      @dragenter.prevent="((dragDepth += 1), (dragging = true))"
      @dragover.prevent
      @dragleave.prevent="((dragDepth -= 1), dragDepth <= 0 && (dragging = false))"
      @drop.prevent="onDrop"
    >
      <input
        ref="input"
        type="file"
        class="sr-only"
        :accept="acceptAttr"
        :multiple="multiple"
        @change="ingest(($event.target as HTMLInputElement).files); ($event.target as HTMLInputElement).value = ''"
      />

      <div class="pointer-events-none flex max-w-full flex-col items-center gap-2">
        <span
          class="flex size-11 items-center justify-center rounded-full transition-colors duration-200"
          :class="dragging ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'"
        >
          <Icon :name="importing ? 'loader' : 'upload'" :size="19" :class="importing ? 'animate-spin' : ''" />
        </span>
        <p class="text-sm font-medium">
          {{ dragging ? '松开即可添加' : importing ? '正在导入…' : '拖拽文件到此处' }}
        </p>
        <!-- Centred flex items keep their one-line width; cap it so a long accept list wraps in narrow columns. -->
        <p class="max-w-full text-xs text-muted-foreground [overflow-wrap:anywhere]">
          也可以点击选择、或直接 {{ pasteChord }}+V 粘贴
          <template v-if="accept.length"> · 接受 {{ accept.join('、') }}</template>
        </p>
      </div>

      <div class="pointer-events-auto mt-4 flex flex-wrap justify-center gap-2">
        <Button variant="outline" size="sm" @click="input?.click()">
          <Icon name="folder-open" :size="14" />
          选择文件
        </Button>
        <Button variant="ghost" size="sm" :disabled="available === 0" data-pick-workspace :title="available ? '' : '工作区里没有这个工具能处理的其他文件'" @click="pickerOpen = true">
          <Icon name="layers" :size="14" />
          从工作区选择<span v-if="available" class="tabular-nums text-muted-foreground">（{{ available }}）</span>
        </Button>
      </div>
    </div>

    <WorkspacePicker v-model:open="pickerOpen" :accept="accept" :multiple="multiple" :selected="files" @pick="onPick" />

    <!-- Selected files -->
    <ul v-if="entries.length" class="mt-3 space-y-1.5">
      <li
        v-for="entry in entries"
        :key="entry.id"
        class="group flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2 transition-shadow hover:shadow-sm"
      >
        <Icon name="file-text" :size="15" class="shrink-0 text-muted-foreground" />
        <span class="min-w-0 flex-1 truncate text-sm">{{ entry.name }}</span>
        <span class="shrink-0 tabular-nums text-xs text-muted-foreground">{{ formatBytes(entry.size) }}</span>
        <button
          type="button"
          class="shrink-0 text-muted-foreground opacity-0 transition-all hover:text-destructive group-hover:opacity-100"
          aria-label="从列表中移除"
          title="从列表中移除（文件仍保留在工作区）"
          @click="emit('remove', entry.id)"
        >
          <Icon name="x" :size="14" />
        </button>
      </li>
    </ul>

    <p v-if="entries.length > 1" class="mt-2 text-right text-xs text-muted-foreground">
      共 {{ entries.length }} 个文件 · {{ formatBytes(totalSize) }}
    </p>
  </div>
</template>
