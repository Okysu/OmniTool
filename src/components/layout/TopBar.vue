<script setup lang="ts">
/**
 * Top bar, collapsing by width:
 *
 *   < md   drawer toggle · logo ········· search icon · task pill · overflow menu
 *   md–lg  logo ········· search box ········ task pill · overflow menu
 *   ≥ lg   logo ········· search box ········ task pill · four icon buttons
 *
 * From md up it keeps the centred three-column grid. On phones the search box
 * becomes an icon and navigation moves into the drawer, since the rail is hidden.
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/common/Icon.vue'
import AppLogo from '@/components/common/AppLogo.vue'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { openPalette } from '@/core/ui/palette'
import { mobileNavOpen } from '@/core/ui/nav'
import { settings, type ThemeMode } from '@/core/settings'
import { activeCount, overallProgress, runningCount } from '@/core/tasks/queue'

const router = useRouter()

const THEME_ORDER: ThemeMode[] = ['system', 'light', 'dark']
const THEME_ICON: Record<ThemeMode, string> = { system: 'monitor', light: 'sun', dark: 'moon' }
const THEME_LABEL: Record<ThemeMode, string> = { system: '跟随系统', light: '浅色', dark: '深色' }

function cycleTheme() {
  settings.theme = THEME_ORDER[(THEME_ORDER.indexOf(settings.theme) + 1) % THEME_ORDER.length]
}

const isMac = computed(() => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent))

const LINKS = [
  { to: '/flows', label: '工作流', icon: 'workflow' },
  { to: '/files', label: '工作区文件', icon: 'folder-open' },
  { to: '/plugins', label: '插件与订阅', icon: 'puzzle' },
  { to: '/learn', label: '插件教程', icon: 'graduation-cap' },
  { to: '/settings', label: '设置', icon: 'settings' },
]
</script>

<template>
  <header
    class="relative z-30 flex h-14 shrink-0 items-center gap-1 border-b border-border bg-card/80 px-2 backdrop-blur-xl sm:px-4 md:grid md:grid-cols-[1fr_auto_1fr] md:gap-2"
  >
    <!-- Left: drawer toggle (phones) + logo -->
    <div class="flex min-w-0 items-center gap-1 md:justify-self-start">
      <Button variant="ghost" size="icon" class="md:hidden" aria-label="打开导航" @click="mobileNavOpen = true">
        <Icon name="layout-grid" :size="18" />
      </Button>
      <RouterLink
        to="/"
        class="flex items-center gap-2 rounded-md px-1 py-1 transition-opacity hover:opacity-80"
        aria-label="返回首页"
      >
        <AppLogo :size="28" />
        <span class="text-sm font-semibold tracking-tight">OmniTool</span>
      </RouterLink>
    </div>

    <!-- Centre: search box from md up -->
    <button
      type="button"
      class="hidden h-9 w-[clamp(14rem,34vw,28rem)] items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm text-muted-foreground shadow-sm transition-all duration-200 hover:border-primary/40 hover:shadow md:flex"
      @click="openPalette"
    >
      <Icon name="search" :size="14" />
      <span class="truncate">搜索工具、文件与操作…</span>
      <kbd class="ml-auto hidden shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] lg:block">
        {{ isMac ? '⌘' : 'Ctrl' }} K
      </kbd>
    </button>

    <!-- Right -->
    <div class="ml-auto flex shrink-0 items-center gap-1 md:ml-0 md:justify-self-end">
      <Button variant="ghost" size="icon" class="md:hidden" aria-label="搜索" @click="openPalette">
        <Icon name="search" :size="18" />
      </Button>

      <button
        v-if="activeCount > 0"
        type="button"
        class="flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-2.5 text-xs shadow-sm transition-colors hover:bg-muted"
        :title="`${runningCount} 个任务进行中`"
        @click="router.push('/files')"
      >
        <Icon name="loader" :size="13" class="animate-spin text-primary" />
        <span class="tabular-nums">{{ activeCount }}</span>
        <Progress
          :model-value="overallProgress === null ? null : overallProgress * 100"
          class="hidden h-1 w-12 sm:flex"
        />
      </button>

      <!-- Wide screens: individual buttons -->
      <div class="hidden items-center gap-0.5 lg:flex">
        <Button
          v-for="link in LINKS.slice(0, 3)"
          :key="link.to"
          variant="ghost"
          size="icon"
          :aria-label="link.label"
          :title="link.label"
          @click="router.push(link.to)"
        >
          <Icon :name="link.icon" :size="16" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          :aria-label="`主题：${THEME_LABEL[settings.theme]}`"
          :title="`主题：${THEME_LABEL[settings.theme]}`"
          @click="cycleTheme"
        >
          <Icon :name="THEME_ICON[settings.theme]" :size="16" />
        </Button>
        <Button variant="ghost" size="icon" aria-label="设置" title="设置" @click="router.push('/settings')">
          <Icon name="settings" :size="16" />
        </Button>
      </div>

      <!-- Narrower screens: one overflow menu -->
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon" class="lg:hidden" aria-label="更多">
            <Icon name="sliders" :size="17" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-52">
          <DropdownMenuItem v-for="link in LINKS" :key="link.to" @select="router.push(link.to)">
            <Icon :name="link.icon" :size="15" />
            {{ link.label }}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel class="text-xs text-muted-foreground">主题</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            :model-value="settings.theme"
            @update:model-value="settings.theme = $event as ThemeMode"
          >
            <DropdownMenuRadioItem v-for="mode in THEME_ORDER" :key="mode" :value="mode">
              <Icon :name="THEME_ICON[mode]" :size="15" />
              {{ THEME_LABEL[mode] }}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </header>
</template>
