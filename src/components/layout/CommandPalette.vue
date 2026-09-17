<script setup lang="ts">
/**
 * Command palette (Cmd/Ctrl+K).
 *
 * With no query it is a map of everything installed: pinned and recent tools
 * first, then every tool grouped by category exactly as the registry currently
 * holds it - so a freshly installed plugin shows up here the moment it registers.
 * With a query it collapses into one ranked list across tools and actions.
 *
 * Built on shadcn-vue's `command`, so keyboard navigation, focus management and
 * ARIA come from the primitive. The one deviation: `CommandInput` writes into
 * the Command context's own substring filter, which would hide subsequence
 * matches (`pdfm` → "PDF 合并"). We compose reka's `ListboxFilter` directly
 * instead and leave the built-in filter dormant.
 */
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ListboxFilter } from 'reka-ui'
import Icon from '@/components/common/Icon.vue'
import { Badge } from '@/components/ui/badge'
import { CommandDialog, CommandGroup, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command'
import { InputGroup, InputGroupAddon } from '@/components/ui/input-group'
import { paletteOpen } from '@/core/ui/palette'
import { allTools, type ToolEntry } from '@/core/plugin/registry'
import { settings, type ThemeMode } from '@/core/settings'
import { PIN_PREFIX, pipelines, type Pipeline } from '@/core/pipelines'
import { CATEGORY_LABEL, type ToolCategory } from '@/core/types'

const router = useRouter()
const query = ref('')

interface Command {
  id: string
  title: string
  subtitle: string
  icon: string
  haystack: string
  badge?: string
  run: () => void
}

const CATEGORY_ORDER: ToolCategory[] = ['pdf', 'media', 'image', 'document', 'dev', 'ai', 'archive', 'other']

function toolCommand(entry: ToolEntry): Command {
  return {
    id: `tool:${entry.key}`,
    title: entry.tool.name,
    // The plugin name alone: the category is already the group heading, and
    // repeating it produced "图片工具箱 · 图片工具箱" for every built-in.
    subtitle: entry.tool.description || entry.pluginName,
    icon: entry.tool.icon ?? 'package',
    badge: entry.origin === 'builtin' ? undefined : entry.origin === 'subscription' ? '订阅' : '本地',
    haystack: [entry.tool.name, entry.tool.description, entry.pluginName, CATEGORY_LABEL[entry.tool.category], ...(entry.tool.keywords ?? [])]
      .filter(Boolean)
      .join(' '),
    run: () => router.push(`/t/${entry.pluginId}/${entry.tool.id}`),
  }
}

function pipelineCommand(pipeline: Pipeline): Command {
  const chain = pipeline.steps.map((step) => allTools.value.find((e) => e.key === step.toolKey)?.tool.name ?? step.toolKey)
  return {
    id: `flow:${pipeline.id}`,
    title: pipeline.name,
    subtitle: chain.length ? chain.join(' → ') : '还没有步骤',
    icon: 'workflow',
    badge: '工作流',
    haystack: ['工作流 workflow', pipeline.name, ...chain].join(' '),
    run: () => router.push(`/flows/${pipeline.id}`),
  }
}

const THEME_NEXT: Record<ThemeMode, ThemeMode> = { system: 'light', light: 'dark', dark: 'system' }
const THEME_LABEL: Record<ThemeMode, string> = { system: '跟随系统', light: '浅色', dark: '深色' }

const actions = computed<Command[]>(() => [
  { id: 'nav:home', title: '全部工具', subtitle: '回到首页', icon: 'layers', haystack: 'home 首页 全部工具 tools', run: () => router.push('/') },
  { id: 'nav:flows', title: '工作流', subtitle: '把多个工具串成流水线', icon: 'workflow', haystack: 'workflow pipeline automate flow 工作流 流水线 自动化 批处理 串联', run: () => router.push('/flows') },
  { id: 'nav:files', title: '工作区文件', subtitle: '查看、下载与清理临时文件', icon: 'folder-open', haystack: 'files 文件 工作区 清理 workspace', run: () => router.push('/files') },
  { id: 'nav:plugins', title: '插件与订阅', subtitle: '安装、授权、更新', icon: 'puzzle', haystack: 'plugins 插件 订阅 subscription install', run: () => router.push('/plugins') },
  { id: 'nav:learn', title: '插件教程', subtitle: '边改代码边看效果，学会写插件', icon: 'graduation-cap', haystack: 'learn tutorial docs guide plugin api 教程 文档 学习 插件开发 写插件 ai llms', run: () => router.push('/learn') },
  { id: 'act:new-plugin', title: '创建新插件', subtitle: '打开插件编辑器', icon: 'file-code', haystack: 'new plugin editor 新建 创建 插件 编辑器', run: () => router.push('/plugins/new') },
  {
    id: 'act:theme',
    title: `切换主题：${THEME_LABEL[THEME_NEXT[settings.theme]]}`,
    subtitle: `当前：${THEME_LABEL[settings.theme]}`,
    icon: settings.theme === 'dark' ? 'moon' : settings.theme === 'light' ? 'sun' : 'monitor',
    haystack: 'theme dark light 主题 深色 浅色 暗色',
    run: () => (settings.theme = THEME_NEXT[settings.theme]),
  },
  { id: 'nav:settings', title: '设置', subtitle: '外观、安全、运行与诊断', icon: 'settings', haystack: 'settings 设置 外观 安全 诊断 模型', run: () => router.push('/settings') },
])

/**
 * Subsequence score: every query character must appear in order. Consecutive
 * matches and matches at word boundaries score higher, so exact prefixes win.
 */
function score(haystack: string, needle: string): number {
  const text = haystack.toLowerCase()
  const term = needle.toLowerCase().replace(/\s+/g, '')
  let index = 0
  let total = 0
  let streak = 0
  for (const char of term) {
    const found = text.indexOf(char, index)
    if (found === -1) return 0
    const atBoundary = found === 0 || /[\s·./_-]/.test(text[found - 1])
    streak = found === index ? streak + 1 : 0
    total += 1 + streak * 2 + (atBoundary ? 3 : 0)
    index = found + 1
  }
  return total / (1 + index * 0.02)
}

interface Group {
  name: string
  items: Command[]
}

const groups = computed<Group[]>(() => {
  const term = query.value.trim()
  const tools = allTools.value

  if (term) {
    const ranked = [...tools.map(toolCommand), ...pipelines.map(pipelineCommand), ...actions.value]
      .map((command) => ({ command, value: score(`${command.title} ${command.haystack}`, term) }))
      .filter((row) => row.value > 0)
      .sort((a, b) => b.value - a.value)
      .map((row) => row.command)
    return ranked.length ? [{ name: `匹配结果（${ranked.length}）`, items: ranked }] : []
  }

  const byKey = new Map(tools.map((entry) => [entry.key, entry]))
  const pinned = settings.pinned.flatMap((key): Command[] => {
    if (key.startsWith(PIN_PREFIX)) {
      const pipeline = pipelines.find((p) => p.id === key.slice(PIN_PREFIX.length))
      return pipeline ? [pipelineCommand(pipeline)] : []
    }
    const entry = byKey.get(key)
    return entry ? [toolCommand(entry)] : []
  })
  const recent = settings.recentTools
    .map((key) => byKey.get(key))
    .filter((e): e is ToolEntry => !!e && !settings.pinned.includes(e.key))
    .slice(0, 5)

  const out: Group[] = []
  if (pinned.length) out.push({ name: '置顶', items: pinned })
  if (recent.length) out.push({ name: '最近使用', items: recent.map(toolCommand) })
  for (const category of CATEGORY_ORDER) {
    const inCategory = tools.filter((entry) => entry.tool.category === category)
    if (inCategory.length) out.push({ name: `${CATEGORY_LABEL[category]}（${inCategory.length}）`, items: inCategory.map(toolCommand) })
  }
  out.push({ name: '操作', items: actions.value })
  return out
})

const totalTools = computed(() => allTools.value.length)

watch(paletteOpen, (open) => {
  if (open) query.value = ''
})

function accept(command: Command) {
  paletteOpen.value = false
  command.run()
}
</script>

<template>
  <CommandDialog
    v-model:open="paletteOpen"
    class="top-[10vh] gap-0 max-w-[calc(100%-1.5rem)] sm:max-w-2xl"
    title="命令面板"
    description="搜索工具与操作"
  >
    <div class="border-b border-border p-2">
      <InputGroup class="h-11! rounded-lg! border-0! bg-transparent! shadow-none! *:data-[slot=input-group-addon]:pl-2!">
        <ListboxFilter
          v-model="query"
          auto-focus
          :placeholder="`搜索 ${totalTools} 个工具与操作…`"
          class="w-full text-base outline-hidden sm:text-sm"
        />
        <InputGroupAddon>
          <Icon name="search" :size="17" class="shrink-0 opacity-60" />
        </InputGroupAddon>
      </InputGroup>
    </div>

    <CommandList class="max-h-[min(62vh,36rem)] scroll-slim px-1.5 pb-1.5">
      <p v-if="groups.length === 0" class="py-12 text-center text-sm text-muted-foreground">
        没有匹配「{{ query }}」的工具或操作
      </p>

      <template v-for="(group, index) in groups" :key="group.name">
        <CommandSeparator v-if="index > 0 && !query" class="my-1" />
        <CommandGroup :heading="group.name">
          <CommandItem
            v-for="command in group.items"
            :key="`${group.name}:${command.id}`"
            :value="`${group.name}:${command.id}`"
            class="gap-3 py-2"
            @select="accept(command)"
          >
            <span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Icon :name="command.icon" :size="16" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-1.5">
                <span class="truncate text-sm font-medium">{{ command.title }}</span>
                <Badge v-if="command.badge" variant="outline" class="h-4 px-1.5 text-[10px]">{{ command.badge }}</Badge>
              </span>
              <span class="block truncate text-xs text-muted-foreground">{{ command.subtitle }}</span>
            </span>
          </CommandItem>
        </CommandGroup>
      </template>
    </CommandList>

    <footer class="hidden items-center gap-4 border-t border-border px-4 py-2 text-[11px] text-muted-foreground sm:flex">
      <span><kbd class="rounded border border-border px-1 font-mono">↑</kbd> <kbd class="rounded border border-border px-1 font-mono">↓</kbd> 选择</span>
      <span><kbd class="rounded border border-border px-1 font-mono">↵</kbd> 打开</span>
      <span><kbd class="rounded border border-border px-1 font-mono">Esc</kbd> 关闭</span>
      <span class="ml-auto tabular-nums">{{ totalTools }} 个工具</span>
    </footer>
  </CommandDialog>
</template>
