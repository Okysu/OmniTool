<script setup lang="ts">
import { computed } from 'vue'
import ToolCard from '@/components/tool/ToolCard.vue'
import Icon from '@/components/common/Icon.vue'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import Spinner from '@/components/common/Spinner.vue'
import { allTools, registryState, type ToolEntry } from '@/core/plugin/registry'
import { sandboxState } from '@/core/sandbox/state'
import { entries as vfsEntries, usedBytes, vfsState } from '@/core/vfs'
import { CATEGORY_LABEL, type ToolCategory } from '@/core/types'
import { formatBytes } from '@/lib/format'

const ORDER: ToolCategory[] = ['pdf', 'media', 'image', 'document', 'ai', 'archive', 'other']

const grouped = computed(() => {
  const map = new Map<ToolCategory, ToolEntry[]>()
  for (const entry of allTools.value) {
    const list = map.get(entry.tool.category) ?? []
    list.push(entry)
    map.set(entry.tool.category, list)
  }
  return ORDER.filter((category) => map.has(category)).map((category) => ({
    category,
    label: CATEGORY_LABEL[category],
    tools: map.get(category)!,
  }))
})

const storageNote = computed(() =>
  vfsState.backing === 'opfs'
    ? '文件保存在浏览器的私有存储中，刷新页面不会丢失。'
    : '当前浏览器不支持 OPFS，文件仅保存在内存中，刷新后会丢失。',
)
</script>

<template>
  <div class="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
    <!-- Hero -->
    <section class="mb-8">
      <h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">全能工具箱，全部在本地运行</h1>
      <p class="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        音视频转码、PDF 处理、图片压缩与格式转换——文件不会上传到任何服务器。
        每个工具都是一个运行在隔离沙盒中的插件，你也可以自己写一个。
      </p>

      <div class="mt-4 flex flex-wrap items-center gap-2">
        <Badge variant="success" class="gap-1">
          <Icon name="shield-check" :size="11" />
          纯本地处理
        </Badge>
        <Badge variant="outline" class="gap-1">
          <Icon name="hard-drive" :size="11" />
          {{ vfsState.backing === 'opfs' ? 'OPFS 持久化' : '内存模式' }}
        </Badge>
        <Badge v-if="sandboxState.isolation" variant="outline" class="gap-1">
          <Icon name="cpu" :size="11" />
          沙盒：{{ sandboxState.isolation === 'iframe-worker' ? '独立源 + Worker' : '独立源（单线程）' }}
        </Badge>
        <Badge v-if="vfsEntries.length" variant="outline" class="gap-1">
          <Icon name="folder-open" :size="11" />
          工作区 {{ vfsEntries.length }} 个文件 · {{ formatBytes(usedBytes()) }}
        </Badge>
      </div>
      <p class="mt-2 text-xs text-muted-foreground">{{ storageNote }}</p>
    </section>

    <!-- Loading -->
    <div v-if="!registryState.ready" class="flex items-center gap-2 py-16 text-sm text-muted-foreground">
      <Spinner :size="16" />
      正在加载插件…
    </div>

    <!-- Empty -->
    <div
      v-else-if="grouped.length === 0"
      class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border py-16 text-center"
    >
      <Icon name="puzzle" :size="28" class="text-muted-foreground" />
      <p class="text-sm font-medium">还没有启用任何工具</p>
      <p class="max-w-sm text-xs text-muted-foreground">
        内置插件可能加载失败，或者全部被停用。打开插件面板检查状态，或导入一个自定义插件。
      </p>
      <RouterLink to="/plugins">
        <Button size="sm">
          <Icon name="puzzle" :size="14" />
          前往插件面板
        </Button>
      </RouterLink>
    </div>

    <!-- Tool matrix -->
    <section v-for="group in grouped" v-else :key="group.category" class="mb-8">
      <div class="mb-3 flex items-baseline gap-2">
        <h2 class="text-sm font-semibold tracking-tight">{{ group.label }}</h2>
        <span class="tabular-nums text-xs text-muted-foreground">{{ group.tools.length }}</span>
      </div>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <ToolCard v-for="entry in group.tools" :key="entry.key" :entry="entry" />
      </div>
    </section>
  </div>
</template>
