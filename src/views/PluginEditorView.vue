<script setup lang="ts">
/**
 * Plugin editor: write, validate and install a plugin without leaving the app.
 *
 * Validation runs the code exactly the way installation will - in a zero-grant
 * sandbox - so "valid here" means "installs". It re-runs after a short idle
 * pause rather than on every keystroke, since each pass boots a sandbox.
 *
 * New drafts autosave locally, so closing the tab does not lose work.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import CodeEditor from '@/components/editor/CodeEditor.vue'
import InstallReview from '@/components/plugin/InstallReview.vue'
import Icon from '@/components/common/Icon.vue'
import Spinner from '@/components/common/Spinner.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  commitInstall,
  findPlugin,
  prepareInstall,
  registryState,
  type InstallCandidate,
} from '@/core/plugin/registry'
import { PLUGIN_TEMPLATES } from '@/core/plugin/template'
import { pushToast } from '@/core/ui/toast'
import { CAPABILITY_INFO, CATEGORY_LABEL, type Capability } from '@/core/types'
import { downloadBlob } from '@/lib/zip'

const route = useRoute()
const router = useRouter()

const DRAFT_KEY = 'omnitool.editor.draft.v1'
const VALIDATE_DELAY_MS = 1200

const editingId = computed(() => (typeof route.params.pluginId === 'string' ? route.params.pluginId : ''))
const record = computed(() => (editingId.value ? findPlugin(editingId.value) : undefined))
const readOnly = computed(() => record.value?.origin === 'builtin')

const code = ref('')
const problems = ref({ errors: 0, warnings: 0 })
const validating = ref(false)
const candidate = ref<InstallCandidate | null>(null)
const validationError = ref('')
const reviewOpen = ref(false)
const saving = ref(false)

/* ------------------------------ loading ---------------------------------- */

function initialCode(): string {
  if (record.value) return record.value.code
  const template = PLUGIN_TEMPLATES.find((t) => t.id === route.query.template) ?? PLUGIN_TEMPLATES[0]
  if (!route.query.template) {
    try {
      const draft = localStorage.getItem(DRAFT_KEY)
      if (draft) return draft
    } catch {
      /* private mode */
    }
  }
  return template.code
}

watch(
  () => [registryState.ready, editingId.value, route.query.template],
  ([ready]) => {
    if (!ready) return
    code.value = initialCode()
  },
  { immediate: true },
)

/* ----------------------------- validation -------------------------------- */

let timer: ReturnType<typeof setTimeout> | undefined
let generation = 0

async function validate() {
  const current = ++generation
  validating.value = true
  try {
    const result = await prepareInstall(code.value, { origin: 'local' })
    if (current !== generation) return
    candidate.value = result
    validationError.value = ''
  } catch (error) {
    if (current !== generation) return
    candidate.value = null
    validationError.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (current === generation) validating.value = false
  }
}

watch(code, (value) => {
  if (!editingId.value) {
    try {
      localStorage.setItem(DRAFT_KEY, value)
    } catch {
      /* quota or private mode */
    }
  }
  clearTimeout(timer)
  timer = setTimeout(validate, VALIDATE_DELAY_MS)
})

onBeforeUnmount(() => clearTimeout(timer))

/* ------------------------------- actions --------------------------------- */

async function save() {
  if (readOnly.value) return
  saving.value = true
  clearTimeout(timer)
  await validate()
  saving.value = false
  if (!candidate.value) {
    pushToast({ level: 'error', title: '无法保存', message: validationError.value || '插件代码未通过校验' })
    return
  }
  reviewOpen.value = true
}

async function confirmInstall(grants: Capability[]) {
  if (!candidate.value) return
  try {
    const installed = await commitInstall(candidate.value, grants)
    if (!editingId.value) {
      try {
        localStorage.removeItem(DRAFT_KEY)
      } catch {
        /* ignore */
      }
    }
    pushToast({ level: 'success', title: '已安装', message: `${installed.manifest.name} v${installed.manifest.version}` })
    const firstTool = installed.manifest.tools[0]
    if (firstTool) await router.push(`/t/${installed.id}/${firstTool.id}`)
  } catch (error) {
    pushToast({ level: 'error', title: '安装失败', message: error instanceof Error ? error.message : String(error) })
  }
}

function useTemplate(id: string) {
  const template = PLUGIN_TEMPLATES.find((t) => t.id === id)
  if (template) code.value = template.code
}

function exportSource() {
  const name = candidate.value?.manifest.id ?? record.value?.id ?? 'plugin'
  downloadBlob(new Blob([code.value], { type: 'text/javascript' }), `${name}.js`)
}

const title = computed(() => {
  if (readOnly.value) return `查看源码 · ${record.value?.manifest.name}`
  if (record.value) return `编辑插件 · ${record.value.manifest.name}`
  return candidate.value ? `新插件 · ${candidate.value.manifest.name}` : '新插件'
})

const RISK_BADGE = { low: 'secondary', medium: 'warning', high: 'destructive' } as const
const RISK_LABEL = { low: '低风险', medium: '需留意', high: '高风险' } as const
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Toolbar -->
    <header class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card/60 px-4 py-2">
      <Button variant="ghost" size="icon-sm" aria-label="返回插件列表" @click="router.push('/plugins')">
        <Icon name="chevron-right" :size="15" class="rotate-180" />
      </Button>
      <h1 class="min-w-0 truncate text-sm font-semibold">{{ title }}</h1>
      <Badge v-if="readOnly" variant="secondary">内置 · 只读</Badge>

      <div class="ml-auto flex flex-wrap items-center gap-2">
        <span class="flex items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
          <span :class="problems.errors ? 'text-destructive' : ''">
            <Icon name="circle-alert" :size="12" class="inline" /> {{ problems.errors }}
          </span>
          <span :class="problems.warnings ? 'text-warning' : ''">
            <Icon name="alert-triangle" :size="12" class="inline" /> {{ problems.warnings }}
          </span>
        </span>

        <DropdownMenu v-if="!record">
          <DropdownMenuTrigger as-child>
            <Button variant="outline" size="sm">
              <Icon name="wand" :size="13" />
              模板
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-72">
            <DropdownMenuLabel>从模板开始（会替换当前代码）</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              v-for="template in PLUGIN_TEMPLATES"
              :key="template.id"
              class="flex-col items-start gap-0.5"
              @select="useTemplate(template.id)"
            >
              <span class="text-sm font-medium">{{ template.name }}</span>
              <span class="text-[11px] text-muted-foreground">{{ template.description }}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button variant="outline" size="sm" @click="exportSource">
          <Icon name="download" :size="13" />
          导出
        </Button>
        <Button v-if="!readOnly" size="sm" :disabled="saving" @click="save">
          <Icon :name="saving ? 'loader' : 'shield-check'" :size="13" :class="saving ? 'animate-spin' : ''" />
          {{ record ? '保存并更新' : '保存并安装' }}
        </Button>
      </div>
    </header>

    <div class="flex min-h-0 flex-1 flex-col lg:flex-row">
      <!-- Editor -->
      <div class="min-h-[60vh] min-w-0 flex-1 lg:min-h-0">
        <CodeEditor
          v-if="registryState.ready"
          v-model="code"
          :read-only="readOnly"
          @problems="problems = $event"
          @save="save"
        />
      </div>

      <!-- Live manifest -->
      <aside class="w-full shrink-0 overflow-y-auto scroll-slim border-t border-border bg-card/40 p-4 lg:w-80 lg:border-t-0 lg:border-l">
        <div class="mb-3 flex items-center gap-2">
          <h2 class="text-xs font-medium uppercase tracking-wider text-muted-foreground">插件清单</h2>
          <Spinner v-if="validating" :size="12" class="text-muted-foreground" />
        </div>

        <div v-if="validationError" class="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          <p class="mb-1 flex items-center gap-1.5 text-xs font-medium text-destructive">
            <Icon name="circle-alert" :size="13" />
            无法注册
          </p>
          <p class="break-words font-mono text-[11px] leading-relaxed text-destructive">{{ validationError }}</p>
        </div>

        <template v-else-if="candidate">
          <div class="space-y-4">
            <section>
              <p class="text-sm font-semibold">{{ candidate.manifest.name }}</p>
              <p class="font-mono text-[11px] text-muted-foreground">
                {{ candidate.manifest.id }} · v{{ candidate.manifest.version }}
              </p>
              <p v-if="candidate.manifest.description" class="mt-1 text-xs leading-relaxed text-muted-foreground">
                {{ candidate.manifest.description }}
              </p>
            </section>

            <section>
              <h3 class="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                工具（{{ candidate.manifest.tools.length }}）
              </h3>
              <ul class="space-y-1">
                <li
                  v-for="tool in candidate.manifest.tools"
                  :key="tool.id"
                  class="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5"
                >
                  <Icon :name="tool.icon ?? 'package'" :size="13" class="shrink-0 text-muted-foreground" />
                  <span class="min-w-0 flex-1 truncate text-xs">{{ tool.name }}</span>
                  <Badge v-if="tool.hasSetup" variant="outline">界面</Badge>
                  <Badge variant="secondary">{{ CATEGORY_LABEL[tool.category] }}</Badge>
                </li>
              </ul>
            </section>

            <section>
              <h3 class="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">申请的能力</h3>
              <p v-if="!candidate.manifest.capabilities.length" class="text-xs text-muted-foreground">无</p>
              <div v-else class="flex flex-wrap gap-1.5">
                <Badge
                  v-for="capability in candidate.manifest.capabilities"
                  :key="capability"
                  :variant="CAPABILITY_INFO[capability].risk === 'high' ? 'destructive' : 'outline'"
                >
                  {{ CAPABILITY_INFO[capability].label }}
                </Badge>
              </div>
            </section>

            <section v-if="candidate.report.signals.length">
              <h3 class="mb-1.5 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                静态扫描
                <Badge :variant="RISK_BADGE[candidate.report.level]">{{ RISK_LABEL[candidate.report.level] }}</Badge>
              </h3>
              <ul class="space-y-1.5">
                <li v-for="signal in candidate.report.signals" :key="signal.id" class="text-[11px] leading-relaxed">
                  <span class="font-medium">{{ signal.label }}</span>
                  <span class="text-muted-foreground"> — {{ signal.detail }}</span>
                </li>
              </ul>
            </section>

            <section v-if="candidate.report.undeclared.length" class="rounded-lg border border-warning/40 bg-warning/10 p-2.5">
              <p class="text-[11px] leading-relaxed">
                代码用到了未声明的能力：<strong>{{ candidate.report.undeclared.join('、') }}</strong>。
                不加进 <code class="font-mono">capabilities</code>，运行时这些调用会被拒绝。
              </p>
            </section>
          </div>
        </template>

        <p v-else class="text-xs text-muted-foreground">停止输入片刻后会自动校验。</p>

        <div class="mt-6 border-t border-border pt-4 text-[11px] leading-relaxed text-muted-foreground">
          <p class="mb-1 font-medium text-foreground">提示</p>
          <p>输入 <code class="font-mono">host.</code>、<code class="font-mono">ctx.</code> 或 <code class="font-mono">ui.</code> 查看补全；悬停查看文档。</p>
          <p class="mt-1"><kbd class="rounded border border-border px-1 font-mono">Ctrl/⌘ S</kbd> 保存并安装。</p>
        </div>
      </aside>
    </div>

    <InstallReview v-model:open="reviewOpen" :candidate="candidate" @confirm="confirmInstall" />
  </div>
</template>
