<script setup lang="ts">
/**
 * Grid of workspace files with preview, per-file download and batch ZIP.
 *
 * Used both for a tool's results and for the whole workspace, so batch download
 * and cleanup behave identically in both places.
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import FilePreview from './FilePreview.vue'
import * as vfs from '@/core/vfs'
import { formatBytes } from '@/lib/format'
import { createZip, downloadBlob } from '@/lib/zip'
import { pushToast } from '@/core/ui/toast'

const props = withDefaults(defineProps<{ ids: string[]; zipName?: string; emptyText?: string }>(), {
  zipName: 'omnitool-results.zip',
  emptyText: '还没有文件',
})

const emit = defineEmits<{ remove: [id: string] }>()

const previewId = ref<string | null>(null)
const previewOpen = ref(false)
const zipping = ref(false)

const entries = computed(() => props.ids.map((id) => vfs.get(id)).filter((e): e is vfs.VfsEntry => Boolean(e)))
const totalSize = computed(() => entries.value.reduce((sum, entry) => sum + entry.size, 0))

/** Thumbnails for image entries, resolved lazily and revoked on unmount. */
const thumbnails = ref<Record<string, string>>({})

watch(
  entries,
  async (list) => {
    for (const entry of list) {
      if (!entry.type.startsWith('image/') || thumbnails.value[entry.id]) continue
      try {
        thumbnails.value = { ...thumbnails.value, [entry.id]: await vfs.objectUrl(entry.id) }
      } catch {
        /* the file may have been removed mid-render */
      }
    }
  },
  { immediate: true, deep: false },
)

onUnmounted(() => {
  thumbnails.value = {}
})

function iconFor(type: string): string {
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'music'
  if (type === 'application/pdf') return 'file-text'
  if (type.startsWith('text/') || type === 'application/json') return 'file-json'
  return 'package'
}

function preview(id: string) {
  previewId.value = id
  previewOpen.value = true
}

async function downloadOne(entry: vfs.VfsEntry) {
  downloadBlob(await vfs.blob(entry.id), entry.name)
}

async function downloadAll() {
  if (entries.value.length === 0) return
  zipping.value = true
  try {
    const parts = []
    for (const entry of entries.value) parts.push({ name: entry.name, blob: await vfs.blob(entry.id) })
    downloadBlob(await createZip(parts), props.zipName)
  } catch (error) {
    pushToast({ level: 'error', title: '打包失败', message: error instanceof Error ? error.message : String(error) })
  } finally {
    zipping.value = false
  }
}
</script>

<template>
  <div>
    <div v-if="entries.length" class="mb-3 flex flex-wrap items-center gap-2">
      <Badge variant="secondary">{{ entries.length }} 个文件</Badge>
      <Badge variant="outline">{{ formatBytes(totalSize) }}</Badge>
      <div class="ml-auto flex gap-2">
        <Button v-if="entries.length > 1" variant="outline" size="sm" :disabled="zipping" @click="downloadAll">
          <Icon :name="zipping ? 'loader' : 'download'" :size="14" :class="zipping ? 'animate-spin' : ''" />
          打包下载 ZIP
        </Button>
        <slot name="actions" />
      </div>
    </div>

    <ul v-if="entries.length" class="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
      <li
        v-for="entry in entries"
        :key="entry.id"
        class="group overflow-hidden rounded-xl border border-border bg-card transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
      >
        <button
          type="button"
          class="flex aspect-[16/9] w-full items-center justify-center overflow-hidden bg-muted/60"
          :aria-label="`预览 ${entry.name}`"
          @click="preview(entry.id)"
        >
          <img
            v-if="thumbnails[entry.id]"
            :src="thumbnails[entry.id]"
            :alt="entry.name"
            class="size-full object-contain transition-transform duration-300 group-hover:scale-[1.03]"
            loading="lazy"
          />
          <Icon v-else :name="iconFor(entry.type)" :size="26" class="text-muted-foreground" />
        </button>

        <div class="flex items-center gap-2 px-3 py-2">
          <div class="min-w-0 flex-1">
            <p class="truncate text-xs font-medium" :title="entry.name">{{ entry.name }}</p>
            <!-- Size only: the card is narrow, and a mime type truncates to noise.
                 The full type stays available in the tooltip and the preview. -->
            <p class="truncate text-[11px] tabular-nums text-muted-foreground" :title="entry.type">
              {{ formatBytes(entry.size) }}
            </p>
          </div>
          <Button variant="ghost" size="icon-sm" title="预览" aria-label="预览" @click="preview(entry.id)">
            <Icon name="eye" :size="14" />
          </Button>
          <Button variant="ghost" size="icon-sm" title="下载" aria-label="下载" @click="downloadOne(entry)">
            <Icon name="download" :size="14" />
          </Button>
          <Button variant="ghost" size="icon-sm" title="删除" aria-label="删除" @click="emit('remove', entry.id)">
            <Icon name="trash" :size="14" />
          </Button>
        </div>
      </li>
    </ul>

    <p v-else class="rounded-xl border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
      {{ emptyText }}
    </p>

    <FilePreview v-model:open="previewOpen" :file-id="previewId" />
  </div>
</template>
