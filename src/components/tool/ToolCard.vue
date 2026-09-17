<script setup lang="ts">
import { computed } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { Badge } from '@/components/ui/badge'
import { settings } from '@/core/settings'
import type { ToolEntry } from '@/core/plugin/registry'

const props = defineProps<{ entry: ToolEntry }>()

const pinned = computed(() => settings.pinned.includes(props.entry.key))

function togglePin(event: Event) {
  event.preventDefault()
  event.stopPropagation()
  settings.pinned = pinned.value
    ? settings.pinned.filter((key) => key !== props.entry.key)
    : [...settings.pinned, props.entry.key]
}
</script>

<template>
  <RouterLink
    :to="`/t/${entry.pluginId}/${entry.tool.id}`"
    class="group relative flex flex-col gap-2 rounded-xl border border-border bg-card p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
  >
    <div class="flex items-start gap-3">
      <span
        class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors duration-200 group-hover:bg-primary group-hover:text-primary-foreground"
      >
        <Icon :name="entry.tool.icon ?? 'package'" :size="17" />
      </span>
      <div class="min-w-0 flex-1">
        <h3 class="truncate text-sm font-semibold tracking-tight">{{ entry.tool.name }}</h3>
        <p class="truncate text-[11px] text-muted-foreground">{{ entry.pluginName }}</p>
      </div>
      <button
        type="button"
        class="shrink-0 rounded p-1 transition-all duration-200"
        :class="
          pinned
            ? 'text-primary opacity-100'
            : 'text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100'
        "
        :aria-label="pinned ? '取消置顶' : '置顶到侧边栏'"
        :title="pinned ? '取消置顶' : '置顶到侧边栏'"
        @click="togglePin"
      >
        <Icon :name="pinned ? 'pin' : 'pin-off'" :size="13" />
      </button>
    </div>

    <p v-if="entry.tool.description" class="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
      {{ entry.tool.description }}
    </p>

    <div class="mt-auto flex items-center gap-1.5 pt-1">
      <Badge v-if="entry.origin === 'builtin'" variant="secondary">内置</Badge>
      <Badge v-else-if="entry.origin === 'subscription'" variant="outline">订阅</Badge>
      <Badge v-else variant="outline">本地</Badge>
      <Badge v-if="entry.tool.multiple" variant="outline">支持批量</Badge>
      <Icon
        name="chevron-right"
        :size="14"
        class="ml-auto text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-primary"
      />
    </div>
  </RouterLink>
</template>
