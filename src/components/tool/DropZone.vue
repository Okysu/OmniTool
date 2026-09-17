<script setup lang="ts">
/**
 * File intake: drag-and-drop, click-to-browse and paste.
 *
 * Files are imported into the VFS immediately (streamed to OPFS, not held in the
 * heap) and the caller only ever sees ids.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { Button } from '@/components/ui/button'
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
const totalSize = computed(() => entries.value.reduce((sum, entry) => sum + entry.size, 0))

async function ingest(list: FileList | File[] | null) {
  if (!list) return
  const files = [...list]
  if (files.length === 0) return

  importing.value = true
  try {
    const accepted = props.multiple ? files : files.slice(0, 1)
    const ids: string[] = []
    for (const file of accepted) {
      if (!matchesAccept(file, props.accept)) {
        pushToast({ level: 'warn', message: `已跳过 ${file.name}：与该工具接受的类型不匹配` })
        continue
      }
      ids.push((await vfs.importFile(file)).id)
    }
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

      <div class="pointer-events-none flex flex-col items-center gap-2">
        <span
          class="flex size-11 items-center justify-center rounded-full transition-colors duration-200"
          :class="dragging ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'"
        >
          <Icon :name="importing ? 'loader' : 'upload'" :size="19" :class="importing ? 'animate-spin' : ''" />
        </span>
        <p class="text-sm font-medium">
          {{ dragging ? '松开即可添加' : importing ? '正在导入…' : '拖拽文件到此处' }}
        </p>
        <p class="text-xs text-muted-foreground">
          也可以点击选择、或直接 {{ pasteChord }}+V 粘贴
          <template v-if="accept.length"> · 接受 {{ accept.join('、') }}</template>
        </p>
      </div>

      <Button variant="outline" size="sm" class="pointer-events-auto mt-4" @click="input?.click()">
        <Icon name="folder-open" :size="14" />
        选择文件
      </Button>
    </div>

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
          aria-label="移除"
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
