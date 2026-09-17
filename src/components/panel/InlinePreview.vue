<script setup lang="ts">
/** Inline, read-only preview of a workspace file, rendered from a local blob URL. */
import { computed, ref, watch } from 'vue'
import Icon from '@/components/common/Icon.vue'
import * as vfs from '@/core/vfs'

const props = defineProps<{ fileId: string; height?: number }>()

const url = ref('')
const text = ref('')
const entry = computed(() => vfs.get(props.fileId))

const kind = computed(() => {
  const type = entry.value?.type ?? ''
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  if (type === 'application/pdf') return 'pdf'
  if (type.startsWith('text/') || type === 'application/json') return 'text'
  return 'other'
})

watch(
  () => props.fileId,
  async (id) => {
    url.value = ''
    text.value = ''
    if (!id || !vfs.get(id)) return
    if (kind.value === 'text') {
      text.value = await (await vfs.blob(id)).slice(0, 64 * 1024).text()
    } else if (kind.value !== 'other') {
      url.value = await vfs.objectUrl(id)
    }
  },
  { immediate: true },
)

const boxStyle = computed(() => ({ maxHeight: `${props.height ?? 320}px` }))
</script>

<template>
  <div class="overflow-hidden rounded-lg border border-border bg-muted/40">
    <p v-if="!entry" class="px-3 py-6 text-center text-xs text-muted-foreground">文件已不在工作区</p>
    <img v-else-if="kind === 'image' && url" :src="url" :alt="entry.name" class="mx-auto block object-contain" :style="boxStyle" />
    <video v-else-if="kind === 'video' && url" :src="url" controls class="block w-full bg-black" :style="boxStyle" />
    <audio v-else-if="kind === 'audio' && url" :src="url" controls class="block w-full p-2" />
    <iframe v-else-if="kind === 'pdf' && url" :src="url" class="block w-full" :style="{ height: `${height ?? 320}px` }" title="PDF 预览" />
    <pre v-else-if="kind === 'text'" class="overflow-auto scroll-slim p-3 text-[11px] leading-relaxed" :style="boxStyle">{{ text }}</pre>
    <div v-else class="flex items-center justify-center gap-2 px-3 py-6 text-xs text-muted-foreground">
      <Icon name="package" :size="16" />
      {{ entry.name }}
    </div>
  </div>
</template>
