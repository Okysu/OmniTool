<script setup lang="ts">
/**
 * In-app preview for a workspace file.
 *
 * Everything is rendered from a blob URL of the local file - nothing is uploaded
 * and no remote viewer is involved.
 */
import { computed, ref, watch } from 'vue'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import Icon from '@/components/common/Icon.vue'
import HtmlPreview from '@/components/tool/HtmlPreview.vue'
import * as vfs from '@/core/vfs'
import { formatBytes } from '@/lib/format'
import { downloadBlob } from '@/lib/zip'

const props = defineProps<{ fileId: string | null }>()
const open = defineModel<boolean>('open', { default: false })

const url = ref('')
const text = ref('')
const loading = ref(false)
const error = ref('')

const entry = computed(() => (props.fileId ? vfs.get(props.fileId) : undefined))

type Kind = 'image' | 'video' | 'audio' | 'pdf' | 'html' | 'text' | 'binary'

const TEXT_TYPE = /^text\/|[/+](json|xml|yaml|x-yaml|csv|markdown|javascript|toml|x-subrip)$/
const TEXT_EXTENSION = /\.(txt|md|markdown|json|ya?ml|csv|tsv|xml|svg|toml|ini|log|srt|vtt|js|ts|css)$/i

const kind = computed<Kind>(() => {
  const type = entry.value?.type ?? ''
  const name = entry.value?.name ?? ''
  if (type === 'text/html' || /\.html?$/i.test(name)) return 'html'
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  if (type === 'application/pdf') return 'pdf'
  if (TEXT_TYPE.test(type) || TEXT_EXTENSION.test(name)) return 'text'
  return 'binary'
})

/** Refuse to inline megabytes of text into the DOM. */
const TEXT_PREVIEW_LIMIT = 256 * 1024
/** A rendered page is one srcdoc string, not DOM text nodes, so it can be larger. */
const HTML_PREVIEW_LIMIT = 8 * 1024 * 1024

/** HTML files toggle between the rendered page and its source. */
const htmlView = ref<'rendered' | 'source'>('rendered')

watch(
  () => [open.value, props.fileId] as const,
  async ([isOpen, id]) => {
    url.value = ''
    text.value = ''
    error.value = ''
    if (!isOpen || !id) return

    loading.value = true
    try {
      if (kind.value === 'html') {
        const blob = await vfs.blob(id)
        if (blob.size > HTML_PREVIEW_LIMIT) throw new Error(`文件过大（${formatBytes(blob.size)}），请下载后查看`)
        text.value = await blob.text()
        htmlView.value = 'rendered'
      } else if (kind.value === 'text') {
        const blob = await vfs.blob(id)
        text.value = await blob.slice(0, TEXT_PREVIEW_LIMIT).text()
        if (blob.size > TEXT_PREVIEW_LIMIT) text.value += '\n\n… 内容过长，已截断预览'
      } else if (kind.value !== 'binary') {
        url.value = await vfs.objectUrl(id)
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
    }
  },
  { immediate: true },
)

async function download() {
  if (!entry.value) return
  downloadBlob(await vfs.blob(entry.value.id), entry.value.name)
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent :class="kind === 'html' ? 'sm:max-w-5xl' : 'sm:max-w-3xl'">
      <DialogHeader>
        <DialogTitle class="truncate">{{ entry?.name }}</DialogTitle>
        <DialogDescription>
          {{ entry ? `${entry.type || '未知类型'} · ${formatBytes(entry.size)}` : '' }}
        </DialogDescription>
      </DialogHeader>

      <div class="flex min-h-40 items-center justify-center">
        <p v-if="loading" class="text-sm text-muted-foreground">正在加载预览…</p>
        <p v-else-if="error" class="text-sm text-destructive">{{ error }}</p>

        <img v-else-if="kind === 'image'" :src="url" :alt="entry?.name" class="max-h-[60vh] rounded-lg object-contain" />

        <video v-else-if="kind === 'video'" :src="url" controls class="max-h-[60vh] w-full rounded-lg bg-black" />

        <audio v-else-if="kind === 'audio'" :src="url" controls class="w-full" />

        <div v-else-if="kind === 'html'" class="w-full">
          <Tabs v-model="htmlView" class="mb-2">
            <TabsList>
              <TabsTrigger value="rendered">渲染预览</TabsTrigger>
              <TabsTrigger value="source">源码</TabsTrigger>
            </TabsList>
          </Tabs>
          <HtmlPreview v-if="htmlView === 'rendered'" :html="text" :title="entry?.name" class="h-[65vh] rounded-lg border border-border" />
          <pre
            v-else
            class="max-h-[65vh] w-full overflow-auto whitespace-pre-wrap break-words scroll-slim rounded-lg bg-muted p-3 text-xs leading-relaxed"
          >{{ text }}</pre>
        </div>

        <iframe v-else-if="kind === 'pdf'" :src="url" class="h-[65vh] w-full rounded-lg border border-border" title="PDF 预览" />

        <!-- 增加了 whitespace-pre-wrap 与 break-words，防止超长文本或无换行代码溢出 -->
        <pre
          v-else-if="kind === 'text'"
          class="max-h-[60vh] w-full overflow-auto whitespace-pre-wrap break-words scroll-slim rounded-lg bg-muted p-3 text-xs leading-relaxed"
        >{{ text }}</pre>

        <div v-else class="flex flex-col items-center gap-2 py-8 text-muted-foreground">
          <Icon name="package" :size="28" />
          <p class="text-sm">该类型无法在浏览器内预览，可直接下载查看。</p>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" size="sm" @click="open = false">关闭</Button>
        <Button size="sm" @click="download">
          <Icon name="download" :size="14" />
          下载
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>