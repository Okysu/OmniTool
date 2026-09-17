<script setup lang="ts">
/**
 * Install review dialog.
 *
 * Nothing is installed until the user confirms here. The dialog shows what the
 * plugin declares, what the static scan found, and - most importantly - lets the
 * user grant capabilities individually rather than all-or-nothing. A declined
 * capability means the corresponding `host.*` calls are rejected at runtime; the
 * plugin still installs and its other tools still work.
 */
import { computed, ref, watch } from 'vue'
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import Icon from '@/components/common/Icon.vue'
import { impliedCapabilities } from '@/core/plugin/analyze'
import { CAPABILITY_INFO, CATEGORY_LABEL, type Capability } from '@/core/types'
import type { InstallCandidate } from '@/core/plugin/registry'
import { formatBytes } from '@/lib/format'

const props = defineProps<{ candidate: InstallCandidate | null }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ confirm: [grants: Capability[]]; cancel: [] }>()

const granted = ref<Set<Capability>>(new Set())
const showSource = ref(false)

watch(
  () => props.candidate,
  (candidate) => {
    showSource.value = false
    if (!candidate) {
      granted.value = new Set()
      return
    }
    // Pre-tick what the code demonstrably uses, plus every low-risk capability.
    // High-risk ones the scan did not find stay off until the user opts in.
    const implied = new Set<Capability>(impliedCapabilities(candidate.report))
    const existing = candidate.existing?.grants ?? []
    granted.value = new Set(
      candidate.manifest.capabilities.filter(
        (c) => existing.includes(c) || implied.has(c) || CAPABILITY_INFO[c].risk === 'low',
      ),
    )
  },
  { immediate: true },
)

function toggle(capability: Capability, value: boolean) {
  const next = new Set(granted.value)
  if (value) next.add(capability)
  else next.delete(capability)
  granted.value = next
}

const RISK_BADGE = { low: 'secondary', medium: 'warning', high: 'destructive' } as const
const RISK_LABEL = { low: '低风险', medium: '需留意', high: '高风险' } as const

const title = computed(() => (props.candidate?.existing ? '更新插件' : '安装插件'))
const sourceLabel = computed(() => {
  const candidate = props.candidate
  if (!candidate) return ''
  if (candidate.origin === 'builtin') return '内置'
  return candidate.url ?? '本地粘贴的代码'
})
</script>

<template>
  <!-- Scroll variant: the review is long by design - identity, tool list, every
       requested capability, dependencies, scan findings and the source. -->
  <Dialog v-model:open="open" @update:open="!$event && emit('cancel')">
    <DialogScrollContent class="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription>请确认该插件申请的能力。未勾选的能力在运行时会被宿主拒绝。</DialogDescription>
      </DialogHeader>

      <div v-if="candidate" class="space-y-5">
        <!-- Identity -->
        <section class="rounded-lg border border-border bg-muted/40 p-3.5">
          <div class="flex items-start gap-3">
            <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon :name="candidate.manifest.icon ?? 'puzzle'" :size="17" />
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-baseline gap-2">
                <h3 class="text-sm font-semibold">{{ candidate.manifest.name }}</h3>
                <span class="text-xs text-muted-foreground">v{{ candidate.manifest.version }}</span>
                <Badge :variant="RISK_BADGE[candidate.report.level]">{{ RISK_LABEL[candidate.report.level] }}</Badge>
                <Badge v-if="candidate.existing" variant="outline">已安装 v{{ candidate.existing.manifest.version }}</Badge>
              </div>
              <p v-if="candidate.manifest.description" class="mt-1 text-xs leading-relaxed text-muted-foreground">
                {{ candidate.manifest.description }}
              </p>
              <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                <dt>标识</dt>
                <dd class="truncate font-mono">{{ candidate.manifest.id }}</dd>
                <dt v-if="candidate.manifest.author">作者</dt>
                <dd v-if="candidate.manifest.author" class="truncate">{{ candidate.manifest.author }}</dd>
                <dt>来源</dt>
                <dd class="truncate">{{ sourceLabel }}</dd>
                <dt>体积</dt>
                <dd>{{ formatBytes(candidate.report.sizeBytes) }}</dd>
              </dl>
            </div>
          </div>
        </section>

        <!-- Tools -->
        <section>
          <h4 class="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            将添加 {{ candidate.manifest.tools.length }} 个工具
          </h4>
          <ul class="space-y-1.5">
            <li
              v-for="tool in candidate.manifest.tools"
              :key="tool.id"
              class="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2"
            >
              <Icon :name="tool.icon ?? 'package'" :size="15" class="mt-0.5 shrink-0 text-muted-foreground" />
              <div class="min-w-0 flex-1">
                <p class="truncate text-xs font-medium">{{ tool.name }}</p>
                <p v-if="tool.description" class="truncate text-[11px] text-muted-foreground">{{ tool.description }}</p>
              </div>
              <Badge variant="outline">{{ CATEGORY_LABEL[tool.category] }}</Badge>
            </li>
          </ul>
        </section>

        <!-- Capabilities -->
        <section>
          <h4 class="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">能力授权</h4>
          <p v-if="candidate.manifest.capabilities.length === 0" class="text-xs text-muted-foreground">
            该插件未申请任何宿主能力。
          </p>
          <ul v-else class="space-y-1.5">
            <li
              v-for="capability in candidate.manifest.capabilities"
              :key="capability"
              class="flex items-start gap-3 rounded-lg border px-3 py-2.5"
              :class="
                CAPABILITY_INFO[capability].risk === 'high'
                  ? 'border-destructive/30 bg-destructive/5'
                  : 'border-border'
              "
            >
              <Switch
                :model-value="granted.has(capability)"
                class="mt-0.5 shrink-0"
                @update:model-value="toggle(capability, $event)"
              />
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="text-xs font-medium">{{ CAPABILITY_INFO[capability].label }}</span>
                  <Badge :variant="RISK_BADGE[CAPABILITY_INFO[capability].risk]">
                    {{ RISK_LABEL[CAPABILITY_INFO[capability].risk] }}
                  </Badge>
                  <code class="font-mono text-[10px] text-muted-foreground">{{ capability }}</code>
                </div>
                <p class="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                  {{ CAPABILITY_INFO[capability].description }}
                </p>
              </div>
            </li>
          </ul>
        </section>

        <!-- Dependencies -->
        <section v-if="candidate.deps.length">
          <h4 class="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">外部依赖</h4>
          <p class="mb-2 text-[11px] leading-relaxed text-muted-foreground">
            这些脚本会被注入沙盒并拥有与插件相同的权限。
          </p>
          <ul class="space-y-1">
            <li
              v-for="dep in candidate.deps"
              :key="dep.id"
              class="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5"
            >
              <Icon name="package" :size="13" class="shrink-0 text-muted-foreground" />
              <span class="shrink-0 text-xs font-medium">{{ dep.id }}</span>
              <span class="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">{{ dep.url }}</span>
              <Badge v-if="dep.fromCache" variant="outline">已缓存</Badge>
            </li>
          </ul>
        </section>

        <!-- Risk signals -->
        <section v-if="candidate.report.signals.length">
          <h4 class="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">静态扫描结果</h4>
          <ul class="space-y-1.5">
            <li
              v-for="signal in candidate.report.signals"
              :key="signal.id"
              class="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2"
            >
              <Icon
                :name="signal.level === 'high' ? 'shield-alert' : signal.level === 'medium' ? 'alert-triangle' : 'info'"
                :size="14"
                :class="[
                  'mt-0.5 shrink-0',
                  signal.level === 'high'
                    ? 'text-destructive'
                    : signal.level === 'medium'
                      ? 'text-warning'
                      : 'text-muted-foreground',
                ]"
              />
              <div class="min-w-0 flex-1">
                <p class="text-xs font-medium">
                  {{ signal.label }}
                  <span v-if="signal.hits" class="ml-1 font-normal text-muted-foreground">×{{ signal.hits }}</span>
                </p>
                <p class="text-[11px] leading-relaxed text-muted-foreground">{{ signal.detail }}</p>
              </div>
            </li>
          </ul>
          <p class="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            静态扫描只是提示，无法覆盖混淆代码。真正的边界是沙盒隔离与上面的能力授权。
          </p>
        </section>

        <!-- Source -->
        <section>
          <button
            type="button"
            class="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            @click="showSource = !showSource"
          >
            <Icon name="chevron-right" :size="12" class="transition-transform" :class="showSource ? 'rotate-90' : ''" />
            {{ showSource ? '隐藏源码' : '查看源码' }}
          </button>
          <pre
            v-if="showSource"
            class="mt-2 max-h-64 overflow-auto scroll-slim rounded-lg bg-muted p-3 text-[11px] leading-relaxed"
          >{{ candidate.code }}</pre>
        </section>
      </div>

      <DialogFooter>
        <Button variant="outline" size="sm" @click="((open = false), emit('cancel'))">取消</Button>
        <Button size="sm" @click="((open = false), emit('confirm', [...granted]))">
          <Icon name="check" :size="14" />
          {{ candidate?.existing ? '更新并授权' : '安装并授权' }}
        </Button>
      </DialogFooter>
    </DialogScrollContent>
  </Dialog>
</template>
