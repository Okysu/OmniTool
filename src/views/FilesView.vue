<script setup lang="ts">
/**
 * The workspace: every file currently held by the VFS, whatever produced it.
 */
import { computed, ref } from 'vue'
import FileGrid from '@/components/tool/FileGrid.vue'
import Icon from '@/components/common/Icon.vue'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import * as vfs from '@/core/vfs'
import { formatBytes } from '@/lib/format'
import { pushToast } from '@/core/ui/toast'

type Filter = 'all' | 'inputs' | 'outputs'
const filter = ref<Filter>('all')
const confirmClear = ref(false)

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'inputs', label: '导入的文件' },
  { value: 'outputs', label: '处理结果' },
]

const visible = computed(() =>
  [...vfs.entries]
    .filter((entry) => {
      if (filter.value === 'inputs') return entry.producedBy === null
      if (filter.value === 'outputs') return entry.producedBy !== null
      return true
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((entry) => entry.id),
)

async function clearAll() {
  confirmClear.value = false
  const count = vfs.entries.length
  await vfs.clear()
  pushToast({ level: 'success', message: `已清理 ${count} 个临时文件` })
}
</script>

<template>
  <div class="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
    <header class="mb-5 flex flex-wrap items-start gap-3">
      <div class="min-w-0 flex-1">
        <h1 class="text-lg font-semibold tracking-tight">工作区文件</h1>
        <p class="mt-1 text-xs leading-relaxed text-muted-foreground">
          导入的文件与处理结果都保存在浏览器本地，从不上传。
        </p>
        <div class="mt-2 flex flex-wrap gap-2">
          <Badge variant="secondary">{{ vfs.entries.length }} 个文件</Badge>
          <Badge variant="outline">{{ formatBytes(vfs.usedBytes()) }}</Badge>
          <Badge variant="outline" class="gap-1">
            <Icon name="hard-drive" :size="11" />
            {{ vfs.vfsState.backing === 'opfs' ? 'OPFS 持久化' : '内存模式（刷新丢失）' }}
          </Badge>
        </div>
      </div>
      <Button v-if="vfs.entries.length" variant="outline" size="sm" @click="confirmClear = true">
        <Icon name="trash" :size="14" />
        一键清理
      </Button>
    </header>

    <div class="mb-4 inline-flex rounded-lg border border-border bg-card p-0.5">
      <button
        v-for="option in FILTERS"
        :key="option.value"
        type="button"
        class="rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
        :class="filter === option.value ? 'bg-primary text-primary-foreground' : 'hover:bg-muted hover:text-foreground'"
        @click="filter = option.value"
      >
        {{ option.label }}
      </button>
    </div>

    <FileGrid
      :ids="visible"
      zip-name="omnitool-workspace.zip"
      empty-text="工作区还是空的。打开任意工具并拖入文件即可开始。"
      @remove="vfs.remove"
    />

    <Dialog v-model:open="confirmClear">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>清理全部临时文件</DialogTitle>
          <DialogDescription>
            将删除工作区中的 {{ vfs.entries.length }} 个文件，共 {{ formatBytes(vfs.usedBytes()) }}。
          </DialogDescription>
        </DialogHeader>
        <p class="text-xs text-muted-foreground">该操作不可撤销。尚未下载的处理结果会一并丢失。</p>
        <DialogFooter>
          <Button variant="outline" size="sm" @click="confirmClear = false">取消</Button>
          <Button variant="destructive" size="sm" @click="clearAll">清理</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
