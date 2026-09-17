<script setup lang="ts">
/**
 * Plugin and subscription management.
 */
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/common/Icon.vue'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import Spinner from '@/components/common/Spinner.vue'
import InstallReview from '@/components/plugin/InstallReview.vue'
import {
  commitInstall,
  disposeSandbox,
  plugins,
  prepareInstall,
  registryState,
  setEnabled,
  setGrants,
  uninstall,
  type InstallCandidate,
  type PluginRecord,
} from '@/core/plugin/registry'
import {
  addSubscription,
  dismissReview,
  pendingReview,
  removeSubscription,
  subscriptions,
  subscriptionState,
  syncSubscription,
} from '@/core/plugin/subscription'
import { pushToast } from '@/core/ui/toast'
import { CAPABILITY_INFO, type Capability } from '@/core/types'
import { downloadBlob } from '@/lib/zip'
import { STARTER_TEMPLATE } from '@/core/plugin/template'

const router = useRouter()

/* ------------------------------ Import ---------------------------------- */

const importOpen = ref(false)
const importSource = ref('')
const importBusy = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

const reviewOpen = ref(false)
const candidate = ref<InstallCandidate | null>(null)

// Subscription refreshes can queue candidates from anywhere; show them here.
watch(pendingReview, (queue) => {
  if (!reviewOpen.value && queue.length > 0) {
    candidate.value = queue[0]
    reviewOpen.value = true
  }
})

async function prepareFromSource(code: string) {
  if (!code.trim()) return
  importBusy.value = true
  try {
    candidate.value = await prepareInstall(code, { origin: 'local' })
    importOpen.value = false
    reviewOpen.value = true
  } catch (error) {
    pushToast({
      level: 'error',
      title: '插件解析失败',
      message: error instanceof Error ? error.message : String(error),
      timeout: 10_000,
    })
  } finally {
    importBusy.value = false
  }
}

async function onPickFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  ;(event.target as HTMLInputElement).value = ''
  if (!file) return
  importSource.value = await file.text()
}

async function confirmInstall(grants: Capability[]) {
  if (!candidate.value) return
  const current = candidate.value
  try {
    const record = await commitInstall(current, grants)
    dismissReview(record.id)
    importSource.value = ''
    pushToast({ level: 'success', title: '已安装', message: `${record.manifest.name} v${record.manifest.version}` })
  } catch (error) {
    pushToast({ level: 'error', title: '安装失败', message: error instanceof Error ? error.message : String(error) })
  } finally {
    candidate.value = null
    // Another queued candidate takes the dialog's place, if any.
    if (pendingReview.length > 0) {
      candidate.value = pendingReview[0]
      reviewOpen.value = true
    }
  }
}

function cancelInstall() {
  if (candidate.value) dismissReview(candidate.value.manifest.id)
  candidate.value = null
}

/* ------------------------------ Records --------------------------------- */

const sorted = computed(() =>
  [...plugins].sort((a, b) => {
    if (a.origin !== b.origin) return a.origin === 'builtin' ? -1 : 1
    return a.manifest.name.localeCompare(b.manifest.name, 'zh')
  }),
)

const ORIGIN_LABEL = { builtin: '内置', local: '本地导入', subscription: '订阅' } as const

async function toggleGrant(record: PluginRecord, capability: Capability, value: boolean) {
  const next = value ? [...record.grants, capability] : record.grants.filter((c) => c !== capability)
  await setGrants(record.id, next)
}

function exportPlugin(record: PluginRecord) {
  downloadBlob(new Blob([record.code], { type: 'text/javascript' }), `${record.id}.js`)
}

const confirmUninstall = ref<PluginRecord | null>(null)

async function doUninstall() {
  const record = confirmUninstall.value
  confirmUninstall.value = null
  if (!record) return
  try {
    await uninstall(record.id)
    pushToast({ level: 'success', message: `已卸载 ${record.manifest.name}` })
  } catch (error) {
    pushToast({ level: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

/* --------------------------- Subscriptions ------------------------------ */

const subscriptionUrl = ref('')

async function onAddSubscription() {
  const url = subscriptionUrl.value.trim()
  if (!url) return
  try {
    const subscription = await addSubscription(url)
    subscriptionUrl.value = ''
    const outcome = await syncSubscription(subscription)
    const found = outcome.fresh.length + outcome.needsReview.length
    pushToast({
      level: outcome.errors.length ? 'warn' : 'success',
      title: '订阅已添加',
      message: `发现 ${found} 个待确认插件，已静默更新 ${outcome.updated.length} 个${
        outcome.errors.length ? `，${outcome.errors.length} 个条目失败` : ''
      }`,
    })
  } catch (error) {
    pushToast({ level: 'error', title: '订阅失败', message: error instanceof Error ? error.message : String(error) })
  }
}

async function refresh(id: string) {
  const subscription = subscriptions.find((s) => s.id === id)
  if (!subscription) return
  const outcome = await syncSubscription(subscription)
  pushToast({
    level: outcome.errors.length ? 'warn' : 'success',
    title: '订阅已刷新',
    message: `新增待确认 ${outcome.fresh.length + outcome.needsReview.length} 个，已更新 ${outcome.updated.length} 个`,
  })
}

async function dropSubscription(id: string, purge: boolean) {
  const orphans = await removeSubscription(id, purge)
  pushToast({
    level: 'success',
    message: purge ? `已移除订阅及其 ${orphans.length} 个插件` : `已移除订阅，保留了 ${orphans.length} 个已安装插件`,
  })
}

function formatTime(value: number | null): string {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未同步'
}
</script>

<template>
  <div class="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
    <header class="mb-6">
      <h1 class="text-lg font-semibold tracking-tight">插件与订阅</h1>
      <p class="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
        每个工具都是一个插件，运行在独立来源的沙盒中，只能使用你授权的能力。内置工具也走完全相同的路径。
      </p>
    </header>

    <!-- Entry points: two square tiles -->
    <section class="mb-8 flex flex-wrap gap-4">
      <button
        type="button"
        class="group flex aspect-square w-40 flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-card p-4 text-center transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
        @click="importOpen = true"
      >
        <span class="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
          <Icon name="upload" :size="22" />
        </span>
        <span>
          <span class="block text-sm font-semibold">导入插件</span>
          <span class="mt-0.5 block text-[11px] text-muted-foreground">文件或粘贴代码</span>
        </span>
      </button>

      <button
        type="button"
        class="group flex aspect-square w-40 flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-card p-4 text-center transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
        @click="router.push('/plugins/new')"
      >
        <span class="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
          <Icon name="file-code" :size="22" />
        </span>
        <span>
          <span class="block text-sm font-semibold">创建新插件</span>
          <span class="mt-0.5 block text-[11px] text-muted-foreground">在编辑器中编写</span>
        </span>
      </button>

      <button
        type="button"
        class="group flex aspect-square w-40 flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-card p-4 text-center transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
        @click="router.push('/learn')"
      >
        <span class="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
          <Icon name="graduation-cap" :size="22" />
        </span>
        <span>
          <span class="block text-sm font-semibold">插件教程</span>
          <span class="mt-0.5 block text-[11px] text-muted-foreground">边写边看，12 课学会</span>
        </span>
      </button>
    </section>

    <!-- Installed -->
    <section class="mb-8">
      <h2 class="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        已安装（{{ plugins.length }}）
      </h2>

      <div v-if="!registryState.ready" class="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Spinner :size="16" />
        正在加载…
      </div>

      <ul v-else class="space-y-3">
        <li v-for="record in sorted" :key="record.id" class="rounded-xl border border-border bg-card p-4">
          <div class="flex items-start gap-3">
            <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon :name="record.manifest.icon ?? 'puzzle'" :size="17" />
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-baseline gap-2">
                <h3 class="text-sm font-semibold">{{ record.manifest.name }}</h3>
                <span class="text-xs text-muted-foreground">v{{ record.manifest.version }}</span>
                <Badge :variant="record.origin === 'builtin' ? 'secondary' : 'outline'">
                  {{ ORIGIN_LABEL[record.origin] }}
                </Badge>
                <Badge v-if="!record.enabled" variant="warning">已停用</Badge>
              </div>
              <p v-if="record.manifest.description" class="mt-1 text-xs leading-relaxed text-muted-foreground">
                {{ record.manifest.description }}
              </p>
              <p class="mt-1 text-[11px] text-muted-foreground">
                {{ record.manifest.tools.length }} 个工具 ·
                <span class="font-mono">{{ record.id }}</span>
              </p>
            </div>

            <div class="flex shrink-0 items-center gap-1">
              <Switch
                :model-value="record.enabled"
                :aria-label="record.enabled ? '停用插件' : '启用插件'"
                @update:model-value="setEnabled(record.id, $event)"
              />
            </div>
          </div>

          <!-- Grants -->
          <div v-if="record.manifest.capabilities.length" class="mt-3 border-t border-border pt-3">
            <p class="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">能力授权</p>
            <div class="flex flex-wrap gap-x-4 gap-y-2">
              <label
                v-for="capability in record.manifest.capabilities"
                :key="capability"
                class="flex items-center gap-2"
                :title="CAPABILITY_INFO[capability].description"
              >
                <Switch
                  :model-value="record.grants.includes(capability)"
                  @update:model-value="toggleGrant(record, capability, $event)"
                />
                <span class="text-xs">{{ CAPABILITY_INFO[capability].label }}</span>
                <Badge v-if="CAPABILITY_INFO[capability].risk === 'high'" variant="destructive">高风险</Badge>
              </label>
            </div>
          </div>

          <div class="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
            <Button variant="outline" size="sm" @click="disposeSandbox(record.id)">
              <Icon name="refresh" :size="13" />
              重载沙盒
            </Button>
            <Button variant="outline" size="sm" @click="router.push(`/plugins/edit/${record.id}`)">
              <Icon name="file-code" :size="13" />
              {{ record.origin === 'builtin' ? '查看源码' : '编辑源码' }}
            </Button>
            <Button variant="outline" size="sm" @click="exportPlugin(record)">
              <Icon name="download" :size="13" />
              导出
            </Button>
            <Button
              v-if="record.origin !== 'builtin'"
              variant="ghost"
              size="sm"
              class="text-destructive"
              @click="confirmUninstall = record"
            >
              <Icon name="trash" :size="13" />
              卸载
            </Button>
          </div>
        </li>
      </ul>
    </section>

    <!-- Subscriptions -->
    <section>
      <h2 class="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">远程订阅</h2>

      <div class="mb-3 flex gap-2">
        <Input
          v-model="subscriptionUrl"
          placeholder="https://example.com/my-tools.json 或 .js"
          @keydown.enter="onAddSubscription"
        />
        <Button size="sm" class="shrink-0" @click="onAddSubscription">
          <Icon name="rss" :size="14" />
          添加
        </Button>
      </div>

      <ul v-if="subscriptions.length" class="space-y-2">
        <li
          v-for="subscription in subscriptions"
          :key="subscription.id"
          class="rounded-xl border border-border bg-card p-3.5"
        >
          <div class="flex items-start gap-3">
            <Icon name="rss" :size="16" class="mt-0.5 shrink-0 text-muted-foreground" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium">{{ subscription.name }}</p>
              <p class="truncate font-mono text-[11px] text-muted-foreground">{{ subscription.url }}</p>
              <p class="mt-0.5 text-[11px] text-muted-foreground">
                {{ subscription.pluginIds.length }} 个插件 · 上次同步 {{ formatTime(subscription.lastSyncedAt) }}
              </p>
              <p v-if="subscription.lastError" class="mt-1 whitespace-pre-line text-[11px] text-destructive">
                {{ subscription.lastError }}
              </p>
            </div>
            <div class="flex shrink-0 gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                title="刷新"
                :disabled="subscriptionState.syncing.includes(subscription.id)"
                @click="refresh(subscription.id)"
              >
                <Icon
                  name="refresh"
                  :size="14"
                  :class="subscriptionState.syncing.includes(subscription.id) ? 'animate-spin' : ''"
                />
              </Button>
              <Button variant="ghost" size="icon-sm" title="移除订阅（保留插件）" @click="dropSubscription(subscription.id, false)">
                <Icon name="x" :size="14" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                class="text-destructive"
                title="移除订阅并卸载其插件"
                @click="dropSubscription(subscription.id, true)"
              >
                <Icon name="trash" :size="14" />
              </Button>
            </div>
          </div>
        </li>
      </ul>

      <p v-else class="rounded-xl border border-dashed border-border py-8 text-center text-xs text-muted-foreground">
        还没有订阅。粘贴一个 JSON 索引或 .js 插件地址即可。
      </p>
    </section>

    <!-- Import dialog -->
    <Dialog v-model:open="importOpen">
      <DialogContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>导入自定义插件</DialogTitle>
          <DialogDescription>
            粘贴一段调用 definePlugin() 的 JavaScript，或从文件导入。代码会先在零权限沙盒中试运行以读取清单。
          </DialogDescription>
        </DialogHeader>

        <Textarea
          v-model="importSource"
          :rows="16"
          placeholder="definePlugin({ ... })"
          class="scroll-slim font-mono text-[11px]"
        />
        <input ref="fileInput" type="file" accept=".js,.mjs,text/javascript" class="sr-only" @change="onPickFile" />
        <div class="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" @click="fileInput?.click()">
            <Icon name="folder-open" :size="13" />
            从文件导入
          </Button>
          <Button variant="ghost" size="sm" @click="importSource = STARTER_TEMPLATE">
            <Icon name="wand" :size="13" />
            插入示例模板
          </Button>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" @click="importOpen = false">取消</Button>
          <Button size="sm" :disabled="importBusy || !importSource.trim()" @click="prepareFromSource(importSource)">
            <Icon :name="importBusy ? 'loader' : 'shield-check'" :size="14" :class="importBusy ? 'animate-spin' : ''" />
            解析并审查
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Uninstall confirmation -->
    <Dialog :open="!!confirmUninstall" @update:open="!$event && (confirmUninstall = null)">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>确认卸载</DialogTitle>
          <DialogDescription>
            将移除「{{ confirmUninstall?.manifest.name }}」及其提供的
            {{ confirmUninstall?.manifest.tools.length ?? 0 }} 个工具。已生成的文件不受影响。
          </DialogDescription>
        </DialogHeader>
        <p class="text-xs text-muted-foreground">该操作不可撤销，但你可以随时重新导入源码。</p>
        <DialogFooter>
          <Button variant="outline" size="sm" @click="confirmUninstall = null">取消</Button>
          <Button variant="destructive" size="sm" @click="doUninstall">卸载</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <InstallReview
      v-model:open="reviewOpen"
      :candidate="candidate"
      @confirm="confirmInstall"
      @cancel="cancelInstall"
    />
  </div>
</template>
