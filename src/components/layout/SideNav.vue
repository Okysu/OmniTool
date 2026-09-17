<script setup lang="ts">
/**
 * Tool navigation, shared by the desktop rail and the mobile drawer.
 *
 * Pins live in settings (they are a preference, not workspace state) and are
 * keyed by `pluginId/toolId` so they survive a plugin update but disappear
 * cleanly when a plugin is uninstalled.
 *
 * `variant="sheet"` is the touch layout: larger targets, no drag-to-reorder
 * (HTML5 drag events do not fire from touch), no collapse control, and the
 * app-level destinations that the top bar folds away on narrow screens.
 */
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import Icon from '@/components/common/Icon.vue'
import { Button } from '@/components/ui/button'
import { allTools, registryState, type ToolEntry } from '@/core/plugin/registry'
import { settings } from '@/core/settings'
import { CATEGORY_LABEL, type ToolCategory } from '@/core/types'

const props = withDefaults(defineProps<{ collapsed?: boolean; variant?: 'rail' | 'sheet' }>(), {
  collapsed: false,
  variant: 'rail',
})

const emit = defineEmits<{ toggleCollapse: []; navigate: [] }>()

const route = useRoute()
const sheet = computed(() => props.variant === 'sheet')
/** The sheet never collapses to icons; only the desktop rail does. */
const compact = computed(() => props.collapsed && !sheet.value)

const CATEGORY_ICON: Record<ToolCategory, string> = {
  pdf: 'file-text',
  media: 'video',
  image: 'image',
  document: 'file-json',
  ai: 'sparkles',
  archive: 'file-archive',
  other: 'package',
}

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
    icon: CATEGORY_ICON[category],
    tools: map.get(category)!,
  }))
})

const pinnedTools = computed(() =>
  settings.pinned.map((key) => allTools.value.find((entry) => entry.key === key)).filter((e): e is ToolEntry => !!e),
)

const expanded = ref(new Set<ToolCategory>(ORDER))
function toggleCategory(category: ToolCategory) {
  const next = new Set(expanded.value)
  if (next.has(category)) next.delete(category)
  else next.add(category)
  expanded.value = next
}

function isActive(entry: ToolEntry): boolean {
  return route.params.pluginId === entry.pluginId && route.params.toolId === entry.tool.id
}

const dragIndex = ref<number | null>(null)
const dropIndex = ref<number | null>(null)

function onDrop(index: number) {
  const from = dragIndex.value
  dragIndex.value = dropIndex.value = null
  if (from === null || from === index) return
  const next = [...settings.pinned]
  const [moved] = next.splice(from, 1)
  next.splice(index, 0, moved)
  settings.pinned = next
}

function unpin(key: string) {
  settings.pinned = settings.pinned.filter((k) => k !== key)
}

const itemClass = computed(() =>
  sheet.value
    ? 'flex items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] transition-colors'
    : 'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
)
const iconSize = computed(() => (sheet.value ? 18 : 15))

const APP_LINKS = [
  { to: '/', label: '全部工具', icon: 'layers' },
  { to: '/flows', label: '工作流', icon: 'workflow' },
  { to: '/files', label: '工作区文件', icon: 'folder-open' },
  { to: '/plugins', label: '插件与订阅', icon: 'puzzle' },
  { to: '/learn', label: '插件教程', icon: 'graduation-cap' },
  { to: '/settings', label: '设置', icon: 'settings' },
]
</script>

<template>
  <div class="flex h-full flex-col">
    <nav class="min-h-0 flex-1 space-y-4 overflow-y-auto scroll-slim py-3" :class="sheet ? 'px-3' : 'px-2'">
      <!-- App destinations, only in the drawer: the top bar folds these away on phones. -->
      <section v-if="sheet">
        <ul class="space-y-0.5">
          <li v-for="link in APP_LINKS" :key="link.to">
            <RouterLink
              :to="link.to"
              :class="[itemClass, (link.to === '/' ? route.path === '/' : route.path.startsWith(link.to)) ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-muted']"
              @click="emit('navigate')"
            >
              <Icon :name="link.icon" :size="iconSize" class="shrink-0" />
              <span class="truncate">{{ link.label }}</span>
            </RouterLink>
          </li>
        </ul>
      </section>

      <!-- Pinned -->
      <section v-if="pinnedTools.length > 0">
        <p v-if="!compact" class="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">置顶</p>
        <ul class="space-y-0.5">
          <li
            v-for="(entry, index) in pinnedTools"
            :key="entry.key"
            :draggable="!sheet"
            class="group/pin rounded-md transition-all duration-150"
            :class="[
              dropIndex === index && dragIndex !== index ? 'ring-1 ring-primary/50' : '',
              dragIndex === index ? 'opacity-40' : '',
            ]"
            @dragstart="dragIndex = index"
            @dragover.prevent="dropIndex = index"
            @drop.prevent="onDrop(index)"
            @dragend="dragIndex = dropIndex = null"
          >
            <RouterLink
              :to="`/t/${entry.pluginId}/${entry.tool.id}`"
              :class="[itemClass, isActive(entry) ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-muted']"
              :title="entry.tool.name"
              @click="emit('navigate')"
            >
              <Icon
                v-if="!compact && !sheet"
                name="grip-vertical"
                :size="12"
                class="shrink-0 cursor-grab text-muted-foreground/40 opacity-0 transition-opacity group-hover/pin:opacity-100"
              />
              <Icon :name="entry.tool.icon ?? 'package'" :size="iconSize" class="shrink-0" />
              <span v-if="!compact" class="truncate">{{ entry.tool.name }}</span>
              <button
                v-if="!compact"
                type="button"
                class="ml-auto shrink-0 transition-opacity hover:text-destructive"
                :class="sheet ? 'p-1 opacity-60' : 'opacity-0 group-hover/pin:opacity-100'"
                aria-label="取消置顶"
                @click.prevent.stop="unpin(entry.key)"
              >
                <Icon name="pin-off" :size="sheet ? 15 : 12" />
              </button>
            </RouterLink>
          </li>
        </ul>
      </section>

      <!-- Categories -->
      <section v-for="group in grouped" :key="group.category">
        <button
          v-if="!compact"
          type="button"
          class="flex w-full items-center gap-1.5 rounded-md px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
          :class="sheet ? 'py-2' : 'py-1'"
          @click="toggleCategory(group.category)"
        >
          <Icon
            name="chevron-right"
            :size="11"
            class="transition-transform duration-200"
            :class="expanded.has(group.category) ? 'rotate-90' : ''"
          />
          {{ group.label }}
          <span class="ml-auto tabular-nums opacity-60">{{ group.tools.length }}</span>
        </button>

        <ul v-show="compact || expanded.has(group.category)" class="mt-0.5 space-y-0.5">
          <li v-for="entry in group.tools" :key="entry.key">
            <RouterLink
              :to="`/t/${entry.pluginId}/${entry.tool.id}`"
              :class="[itemClass, isActive(entry) ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-muted']"
              :title="`${entry.tool.name} · ${entry.pluginName}`"
              @click="emit('navigate')"
            >
              <Icon :name="entry.tool.icon ?? group.icon" :size="iconSize" class="shrink-0" />
              <span v-if="!compact" class="truncate">{{ entry.tool.name }}</span>
            </RouterLink>
          </li>
        </ul>
      </section>

      <p v-if="registryState.ready && grouped.length === 0 && !compact" class="px-2 py-6 text-xs text-muted-foreground">
        还没有可用工具。前往「插件与订阅」导入一个。
      </p>
    </nav>

    <div v-if="!sheet" class="border-t border-border p-2">
      <RouterLink
        to="/plugins"
        class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted"
        title="插件与订阅"
      >
        <Icon name="puzzle" :size="15" class="shrink-0" />
        <span v-if="!compact" class="truncate">插件与订阅</span>
      </RouterLink>
      <Button
        variant="ghost"
        size="sm"
        class="mt-1 w-full justify-start gap-2 text-muted-foreground"
        :aria-label="compact ? '展开侧边栏' : '折叠侧边栏'"
        @click="emit('toggleCollapse')"
      >
        <Icon :name="compact ? 'panel-left' : 'panel-left-close'" :size="15" class="shrink-0" />
        <span v-if="!compact">折叠</span>
      </Button>
    </div>
  </div>
</template>
