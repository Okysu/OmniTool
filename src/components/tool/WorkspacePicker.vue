<script setup lang="ts">
/**
 * Pick files already in the workspace instead of importing them again.
 *
 * Only files the tool accepts are listed (the same `accept` check a drop uses),
 * newest first, with search and an imported / results filter. Files still being
 * written by a running task, and files already selected, cannot be picked.
 */
import { computed, ref, watch } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import * as vfs from '@/core/vfs'
import { matchesAccept } from '@/core/plugin/params'
import { formatBytes } from '@/lib/format'

const props = withDefaults(defineProps<{ accept?: string[]; multiple?: boolean; selected?: string[] }>(), {
  accept: () => [],
  multiple: true,
  selected: () => [],
})
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ pick: [ids: string[]] }>()

type Source = 'all' | 'inputs' | 'outputs'
const query = ref('')
const source = ref<Source>('all')
const picked = ref<string[]>([])

/** Everything this tool could take, before search and the source filter. */
const eligible = computed(() => {
  // A file selected twice somewhere has two entries over the same bytes; offer it once.
  const seen = new Set<string>()
  return [...vfs.entries]
    .filter((entry) => !vfs.isWriting(entry.id) && matchesAccept(entry, props.accept))
    .sort((a, b) => b.createdAt - a.createdAt)
    .filter((entry) => {
      const key = `${vfs.storageKey(entry)}|${entry.name}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
})

const LIMIT = 200
const listed = computed(() => {
  const q = query.value.trim().toLowerCase()
  return eligible.value.filter((entry) => {
    if (source.value === 'inputs' && entry.producedBy !== null) return false
    if (source.value === 'outputs' && entry.producedBy === null) return false
    return !q || entry.name.toLowerCase().includes(q)
  })
})

watch(open, (value) => {
  if (!value) return
  query.value = ''
  source.value = 'all'
  picked.value = []
})

const thumbnails = ref<Record<string, string>>({})
watch(
  () => (open.value ? listed.value.slice(0, LIMIT) : []),
  async (list) => {
    for (const entry of list) {
      if (!entry.type.startsWith('image/') || thumbnails.value[entry.id]) continue
      try {
        thumbnails.value = { ...thumbnails.value, [entry.id]: await vfs.objectUrl(entry.id) }
      } catch {
        /* removed meanwhile */
      }
    }
  },
)

function toggle(id: string) {
  if (props.selected.includes(id)) return
  if (!props.multiple) {
    picked.value = [id]
    return
  }
  picked.value = picked.value.includes(id) ? picked.value.filter((x) => x !== id) : [...picked.value, id]
}

function confirm() {
  if (picked.value.length === 0) return
  emit('pick', [...picked.value])
  open.value = false
}

function iconFor(type: string): string {
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'music'
  if (type === 'application/pdf') return 'file-text'
  if (type.startsWith('text/') || type === 'application/json') return 'file-json'
  return 'package'
}

function when(at: number) {
  const minutes = Math.round((Date.now() - at) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (minutes < 1440) return `${Math.round(minutes / 60)} 小时前`
  return new Date(at).toLocaleDateString()
}

const SOURCES: Array<{ value: Source; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'inputs', label: '导入的文件' },
  { value: 'outputs', label: '处理结果' },
]
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="flex max-h-[85dvh] flex-col sm:max-w-2xl" data-workspace-picker>
      <DialogHeader>
        <DialogTitle>从工作区选择</DialogTitle>
        <DialogDescription>
          只列出这个工具能处理的文件<template v-if="accept.length">（{{ accept.slice(0, 6).join('、') }}{{ accept.length > 6 ? ' 等' : '' }}）</template>，不会重复占用空间。
        </DialogDescription>
      </DialogHeader>

      <div class="flex flex-wrap items-center gap-2">
        <Input v-model="query" placeholder="按文件名搜索…" class="h-8 min-w-40 flex-1 text-sm" aria-label="按文件名搜索" />
        <div class="inline-flex rounded-lg border border-border p-0.5">
          <button
            v-for="option in SOURCES"
            :key="option.value"
            type="button"
            class="rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
            :class="source === option.value ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'"
            :aria-pressed="source === option.value"
            @click="source = option.value"
          >
            {{ option.label }}
          </button>
        </div>
      </div>

      <div class="-mx-2 min-h-40 flex-1 overflow-y-auto scroll-slim px-2">
        <p v-if="eligible.length === 0" class="py-12 text-center text-xs text-muted-foreground">工作区里还没有这个工具能处理的文件。</p>
        <p v-else-if="listed.length === 0" class="py-12 text-center text-xs text-muted-foreground">没有匹配的文件</p>
        <ul v-else class="space-y-1" role="listbox" :aria-multiselectable="multiple">
          <li v-for="entry in listed.slice(0, LIMIT)" :key="entry.id">
            <button
              type="button"
              role="option"
              class="flex w-full items-center gap-3 rounded-lg border px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              :class="picked.includes(entry.id) ? 'border-primary bg-primary/5' : 'border-transparent hover:bg-muted'"
              :aria-selected="picked.includes(entry.id)"
              :disabled="selected.includes(entry.id)"
              :data-picker-file="entry.name"
              @click="toggle(entry.id)"
              @dblclick="!multiple && confirm()"
            >
              <span class="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground">
                <img v-if="thumbnails[entry.id]" :src="thumbnails[entry.id]" alt="" class="size-full object-cover" loading="lazy" />
                <Icon v-else :name="iconFor(entry.type)" :size="17" />
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm">{{ entry.name }}</span>
                <span class="block truncate text-[11px] text-muted-foreground">
                  {{ formatBytes(entry.size) }} · {{ when(entry.createdAt) }}
                </span>
              </span>
              <Badge v-if="selected.includes(entry.id)" variant="outline" class="shrink-0 text-[10px]">已在列表中</Badge>
              <Badge v-else variant="secondary" class="shrink-0 text-[10px]">{{ entry.producedBy === null ? '导入' : '结果' }}</Badge>
              <Icon :name="picked.includes(entry.id) ? 'circle-check' : 'circle'" :size="16" class="shrink-0" :class="picked.includes(entry.id) ? 'text-primary' : 'text-muted-foreground/40'" />
            </button>
          </li>
        </ul>
        <p v-if="listed.length > LIMIT" class="py-2 text-center text-[11px] text-muted-foreground">仅显示最近的 {{ LIMIT }} 个，请用搜索缩小范围</p>
      </div>

      <DialogFooter class="items-center gap-2 sm:justify-between">
        <span class="text-xs text-muted-foreground">{{ picked.length ? `已选 ${picked.length} 个` : `${eligible.length} 个可用文件` }}</span>
        <div class="flex gap-2">
          <Button variant="outline" size="sm" @click="open = false">取消</Button>
          <Button size="sm" :disabled="picked.length === 0" data-picker-confirm @click="confirm">
            <Icon name="check" :size="14" />
            添加{{ picked.length ? ` ${picked.length} 个` : '' }}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
