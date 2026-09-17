<script setup lang="ts">
/**
 * Appearance, security, behaviour and diagnostics.
 */
import { computed, onMounted, ref } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { resetAppearance, settings, type ThemeMode } from '@/core/settings'
import { disposeAllSandboxes, plugins } from '@/core/plugin/registry'
import { sandboxState } from '@/core/sandbox/state'
import { HOST_METHODS } from '@/core/capabilities'
import { vfsState } from '@/core/vfs'
import { disposeFfmpeg, ffmpegState } from '@/core/capabilities/ffmpeg'
import { cachedModels, deleteCachedModel, onnxState, refreshModelCache } from '@/core/capabilities/onnx'
import { MODEL_SOURCES, endpointProblem, modelEndpoint, type ModelSource } from '@/core/capabilities/model-source'
import { Input } from '@/components/ui/input'
import { PLUGIN_API_VERSION } from '@/core/types'
import { formatBytes } from '@/lib/format'
import { pushToast } from '@/core/ui/toast'

const THEME_OPTIONS = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

/**
 * `crossOriginIsolated` gates `SharedArrayBuffer`, which the multi-threaded
 * FFmpeg build needs. Read once here so the template stays free of globals.
 */
const coiLabel =
  typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
    ? '已启用（SharedArrayBuffer 可用）'
    : '未启用（FFmpeg 多线程将不可用）'

/** Reka's slider is multi-thumb, so its model is an array. */
function slider(value: number): number[] {
  return [value]
}

/** The accent override is opt-in: until the user moves the hue slider, the
 *  shadcn-vue preset's own primary is left completely untouched. */
const accentOverridden = computed(() => settings.accentHue !== null)
const accentHue = computed(() => settings.accentHue ?? 150)

function setAccentHue(value: number[] | undefined) {
  if (value?.length) settings.accentHue = value[0]
}

function setAccentChroma(value: number[] | undefined) {
  if (value?.length) settings.accentChroma = value[0]
}

/* ------------------------------------------------------------ models */

const modelsLoading = ref(true)
const modelTotal = computed(() => cachedModels.reduce((sum, model) => sum + model.bytes, 0))
const customProblem = computed(() => (settings.modelSource === 'custom' ? endpointProblem(settings.modelSourceUrl) : ''))
const effectiveEndpoint = computed(() => modelEndpoint(settings.modelSource, settings.modelSourceUrl))
const confirmDeleteAll = ref(false)
const testing = ref(false)

async function loadModels() {
  modelsLoading.value = true
  try {
    await refreshModelCache()
  } finally {
    modelsLoading.value = false
  }
}

async function removeModel(id: string, name: string) {
  await deleteCachedModel(id)
  pushToast({ level: 'success', message: `已删除模型「${name}」` })
}

async function removeAllModels() {
  confirmDeleteAll.value = false
  const count = cachedModels.length
  for (const model of [...cachedModels]) await deleteCachedModel(model.id)
  pushToast({ level: 'success', message: `已删除 ${count} 个模型` })
}

/** Fetches a 0.2 MB public model file's first bytes through the chosen source. */
async function testSource() {
  testing.value = true
  const url = `${effectiveEndpoint.value}/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx`
  const started = performance.now()
  try {
    const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', headers: { Range: 'bytes=0-1023' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    await response.arrayBuffer()
    pushToast({ level: 'success', message: `下载源可用（${Math.round(performance.now() - started)} ms）` })
  } catch (error) {
    pushToast({ level: 'error', title: '下载源不可用', message: `${new URL(url).host}：${error instanceof Error ? error.message : error}` })
  } finally {
    testing.value = false
  }
}

function formatDate(at: number) {
  return new Date(at).toLocaleString()
}

const quota = ref<{ usage: number; quota: number } | null>(null)
const persisted = ref<boolean | null>(null)
const showMethods = ref(false)
const confirmReset = ref(false)

onMounted(async () => {
  void loadModels()
  const estimate = await navigator.storage?.estimate?.().catch(() => null)
  if (estimate) quota.value = { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 }
  persisted.value = (await navigator.storage?.persisted?.().catch(() => null)) ?? null
})

const ISOLATION_LABEL: Record<string, string> = {
  'iframe-worker': '独立来源 iframe + Worker（完整隔离，计算不占用 UI 线程）',
  iframe: '独立来源 iframe（Worker 不可用，已降级为单线程）',
}

function reloadEngines() {
  disposeFfmpeg()
  pushToast({ level: 'success', message: 'FFmpeg 核心已卸载，下次调用时重新加载' })
}

function reloadSandboxes() {
  disposeAllSandboxes()
  pushToast({ level: 'success', message: '所有插件沙盒已重置，下次调用时重新启动' })
}

async function resetEverything() {
  confirmReset.value = false
  localStorage.clear()
  const databases = await indexedDB.databases?.().catch(() => [])
  for (const database of databases ?? []) if (database.name) indexedDB.deleteDatabase(database.name)
  try {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry('vfs', { recursive: true }).catch(() => {})
  } catch {
    /* OPFS unavailable */
  }
  location.reload()
}
</script>

<template>
  <div class="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
    <h1 class="mb-6 text-lg font-semibold tracking-tight">设置</h1>

    <!-- Appearance -->
    <section class="mb-6 rounded-xl border border-border bg-card p-5">
      <h2 class="mb-4 text-sm font-semibold">外观</h2>

      <div class="space-y-5">
        <div class="flex items-center gap-4">
          <div class="min-w-0 flex-1">
            <p class="text-xs font-medium">主题</p>
            <p class="text-[11px] text-muted-foreground">深色与浅色模式，或跟随系统设置。</p>
          </div>
          <Select
            :model-value="settings.theme"
            @update:model-value="settings.theme = $event as ThemeMode"
          >
            <SelectTrigger class="w-36 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="option in THEME_OPTIONS" :key="option.value" :value="option.value">
                {{ option.label }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <div class="mb-1.5 flex items-center gap-2">
            <p class="text-xs font-medium">主色调</p>
            <span v-if="!accentOverridden" class="text-[11px] text-muted-foreground">使用主题预设的配色</span>
            <span v-else class="ml-auto tabular-nums text-xs text-muted-foreground">色相 {{ accentHue }}°</span>
            <Button
              v-if="accentOverridden"
              variant="ghost"
              size="xs"
              class="ml-1"
              @click="settings.accentHue = null"
            >
              恢复预设
            </Button>
          </div>
          <Slider
            :model-value="slider(accentHue)"
            :min="0"
            :max="360"
            :step="1"
            class="py-1"
            @update:model-value="setAccentHue"
          />

          <div class="mt-3 flex items-baseline gap-2">
            <p class="text-xs font-medium">彩度</p>
            <span class="ml-auto tabular-nums text-xs text-muted-foreground">
              {{ settings.accentChroma.toFixed(2) }}
            </span>
          </div>
          <Slider
            :model-value="slider(settings.accentChroma)"
            :min="0"
            :max="0.37"
            :step="0.01"
            class="py-1"
            @update:model-value="setAccentChroma"
          />

          <div class="mt-3 flex gap-1.5">
            <span
              v-for="shade in [100, 80, 60, 40, 20, 10]"
              :key="shade"
              class="h-6 flex-1 rounded"
              :style="{ backgroundColor: `color-mix(in oklab, var(--primary) ${shade}%, transparent)` }"
            />
          </div>
        </div>

        <div>
          <div class="mb-1.5 flex items-baseline gap-2">
            <p class="text-xs font-medium">圆角半径</p>
            <span class="ml-auto tabular-nums text-xs text-muted-foreground">{{ settings.radius.toFixed(2) }}rem</span>
          </div>
          <Slider
            :model-value="slider(settings.radius)"
            :min="0"
            :max="1.5"
            :step="0.05"
            class="py-1"
            @update:model-value="(v) => v?.length && (settings.radius = v[0])"
          />
        </div>

        <div>
          <p class="mb-1.5 text-xs font-medium">自定义 CSS</p>
          <p class="mb-2 text-[11px] leading-relaxed text-muted-foreground">
            注入到所有样式表之后，可覆盖任意变量与选择器。仅影响你自己的浏览器。
          </p>
          <Textarea
            v-model="settings.customCss"
            :rows="5"
            placeholder=":root { --radius: 1rem }"
            class="text-[11px]"
          />
        </div>

        <Button variant="outline" size="sm" @click="resetAppearance">恢复默认外观</Button>
      </div>
    </section>

    <!-- Security -->
    <section class="mb-6 rounded-xl border border-border bg-card p-5">
      <h2 class="mb-4 text-sm font-semibold">安全</h2>

      <div class="space-y-4">
        <label class="flex items-start gap-3">
          <Switch v-model="settings.allowLocalNetwork" class="mt-0.5 shrink-0" />
          <span class="min-w-0 flex-1">
            <span class="block text-xs font-medium">允许插件访问本机与内网地址</span>
            <span class="block text-[11px] leading-relaxed text-muted-foreground">
              默认关闭。开启后，已获授权 <code class="font-mono">net</code> 能力的第三方插件可以请求
              localhost 与私有网段（如自建的转码服务）。内置插件不受此限制。
            </span>
          </span>
        </label>

        <label class="flex items-start gap-3">
          <Switch v-model="settings.autoUpdateSubscriptions" class="mt-0.5 shrink-0" />
          <span class="min-w-0 flex-1">
            <span class="block text-xs font-medium">启动时自动刷新订阅</span>
            <span class="block text-[11px] leading-relaxed text-muted-foreground">
              仅静默应用能力未变化的更新；申请新能力的更新始终需要你重新确认。
            </span>
          </span>
        </label>
      </div>
    </section>

    <!-- Behaviour -->
    <section class="mb-6 rounded-xl border border-border bg-card p-5">
      <h2 class="mb-4 text-sm font-semibold">运行</h2>

      <div class="mb-1.5 flex items-baseline gap-2">
        <p class="text-xs font-medium">并行任务数</p>
        <span class="ml-auto tabular-nums text-xs text-muted-foreground">{{ settings.concurrency }}</span>
      </div>
      <Slider
        :model-value="slider(settings.concurrency)"
        :min="1"
        :max="8"
        :step="1"
        class="py-1"
        @update:model-value="(v) => v?.length && (settings.concurrency = v[0])"
      />
      <p class="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
        同时运行的工具调用数量。音视频转码等重负载建议保持较低值。
      </p>

      <label class="mt-5 flex items-start gap-3">
        <Switch v-model="settings.ffmpegMultithread" class="mt-0.5 shrink-0" />
        <span class="min-w-0 flex-1">
          <span class="block text-xs font-medium">FFmpeg 多线程</span>
          <span class="block text-[11px] leading-relaxed text-muted-foreground">
            默认开启，转码速度显著更快，需要页面处于跨源隔离状态。
            若在某些浏览器上遇到转码无响应，可关掉本项回退到单线程核心。
          </span>
        </span>
      </label>

      <div class="mt-4 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" @click="reloadSandboxes">
          <Icon name="refresh" :size="13" />
          重置全部插件沙盒
        </Button>
        <Button variant="outline" size="sm" @click="reloadEngines">
          <Icon name="cpu" :size="13" />
          卸载 FFmpeg 核心
        </Button>
      </div>
    </section>

    <!-- Local models -->
    <section class="mb-6 rounded-xl border border-border bg-card p-5" data-settings-models>
      <h2 class="mb-1 text-sm font-semibold">本地模型</h2>
      <p class="mb-4 text-[11px] leading-relaxed text-muted-foreground">
        AI 工具的模型在首次使用时下载并缓存在本机。无论从哪个源下载，都会按插件声明的 SHA-256 校验，镜像无法替换模型内容。
      </p>

      <div class="space-y-1.5">
        <p class="text-xs font-medium">下载源</p>
        <Select :model-value="settings.modelSource" @update:model-value="settings.modelSource = $event as ModelSource">
          <SelectTrigger id="model-source" class="w-full sm:w-96">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="source in MODEL_SOURCES" :key="source.value" :value="source.value">{{ source.label }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div v-if="settings.modelSource === 'custom'" class="mt-3 space-y-1.5">
        <p class="text-xs font-medium">镜像地址</p>
        <Input v-model="settings.modelSourceUrl" placeholder="https://your-mirror.example.com" class="font-mono text-xs sm:w-96" />
        <p class="text-[11px] leading-relaxed" :class="customProblem ? 'text-destructive' : 'text-muted-foreground'">
          {{ customProblem || '需与 huggingface.co 保持相同的路径结构（/组织/仓库/resolve/版本/文件），并允许跨域请求。' }}
        </p>
      </div>
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" :disabled="testing || !!customProblem" @click="testSource">
          <Icon :name="testing ? 'loader' : 'gauge'" :size="13" :class="testing ? 'animate-spin' : ''" />
          测试连通性
        </Button>
        <span class="text-[11px] text-muted-foreground">当前生效：<code class="font-mono">{{ effectiveEndpoint }}</code></span>
      </div>

      <div class="mt-5 flex items-center gap-2">
        <p class="text-xs font-medium">已缓存的模型</p>
        <span class="text-[11px] tabular-nums text-muted-foreground">{{ cachedModels.length }} 个 · {{ formatBytes(modelTotal) }}</span>
        <Button variant="ghost" size="xs" class="ml-auto" @click="loadModels">
          <Icon name="refresh" :size="12" />
          刷新
        </Button>
        <Button v-if="cachedModels.length" variant="ghost" size="xs" class="text-destructive" @click="confirmDeleteAll = true">
          <Icon name="trash" :size="12" />
          全部删除
        </Button>
      </div>
      <p v-if="modelsLoading" class="mt-2 text-[11px] text-muted-foreground">正在读取…</p>
      <p v-else-if="cachedModels.length === 0" class="mt-2 text-[11px] text-muted-foreground">还没有下载任何模型。</p>
      <ul v-else class="mt-2 divide-y divide-border rounded-lg border border-border">
        <li v-for="model in cachedModels" :key="model.id" class="flex items-center gap-3 px-3 py-2" data-model-row>
          <Icon name="cpu" :size="14" class="shrink-0 text-primary" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-xs font-medium">{{ model.name }}</p>
            <p class="truncate text-[11px] text-muted-foreground" :title="model.url">
              {{ formatBytes(model.bytes) }} · {{ formatDate(model.cachedAt) }}<template v-if="model.license"> · {{ model.license }}</template>
            </p>
          </div>
          <Button variant="ghost" size="icon" class="size-7" :aria-label="`删除 ${model.name}`" @click="removeModel(model.id, model.name)">
            <Icon name="trash" :size="14" />
          </Button>
        </li>
      </ul>
      <p class="mt-2 text-[11px] leading-relaxed text-muted-foreground">删除后，下次使用对应工具时会重新确认并下载。</p>
    </section>

    <Dialog v-model:open="confirmDeleteAll">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>删除全部模型</DialogTitle>
          <DialogDescription>将释放 {{ formatBytes(modelTotal) }}。之后使用 AI 工具时需要重新下载。</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="confirmDeleteAll = false">取消</Button>
          <Button variant="destructive" @click="removeAllModels">全部删除</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Diagnostics -->
    <section class="mb-6 rounded-xl border border-border bg-card p-5">
      <h2 class="mb-4 text-sm font-semibold">诊断</h2>

      <dl class="space-y-2.5 text-xs">
        <div class="flex items-start gap-3">
          <dt class="w-28 shrink-0 text-muted-foreground">沙盒隔离</dt>
          <dd class="min-w-0 flex-1">
            <template v-if="sandboxState.isolation">
              {{ ISOLATION_LABEL[sandboxState.isolation] }}
            </template>
            <span v-else class="text-muted-foreground">尚未启动任何沙盒</span>
          </dd>
        </div>
        <div class="flex items-start gap-3">
          <dt class="w-28 shrink-0 text-muted-foreground">文件存储</dt>
          <dd class="min-w-0 flex-1">
            {{ vfsState.backing === 'opfs' ? 'OPFS（持久化到磁盘）' : '内存（刷新后丢失）' }}
            <p v-if="vfsState.degradedReason" class="mt-0.5 text-[11px] text-warning">{{ vfsState.degradedReason }}</p>
          </dd>
        </div>
        <div class="flex items-start gap-3">
          <dt class="w-28 shrink-0 text-muted-foreground">存储用量</dt>
          <dd class="min-w-0 flex-1">
            <template v-if="quota">
              {{ formatBytes(quota.usage) }} / {{ formatBytes(quota.quota) }}
              <Badge v-if="persisted" variant="success" class="ml-1">已持久化</Badge>
            </template>
            <span v-else class="text-muted-foreground">浏览器未提供用量信息</span>
          </dd>
        </div>
        <div class="flex items-start gap-3">
          <dt class="w-28 shrink-0 text-muted-foreground">跨源隔离</dt>
          <dd class="min-w-0 flex-1">
            {{ coiLabel }}
          </dd>
        </div>
        <div class="flex items-start gap-3">
          <dt class="w-28 shrink-0 text-muted-foreground">FFmpeg</dt>
          <dd class="min-w-0 flex-1">
            <template v-if="ffmpegState.status === 'ready'">
              已加载（{{ ffmpegState.variant === 'mt' ? '多线程核心' : '单线程核心' }}）
            </template>
            <template v-else-if="ffmpegState.status === 'failed'">
              <span class="text-destructive">{{ ffmpegState.error }}</span>
            </template>
            <span v-else class="text-muted-foreground">尚未加载（首次使用音视频工具时加载约 32MB）</span>
          </dd>
        </div>
        <div class="flex items-start gap-3">
          <dt class="w-28 shrink-0 text-muted-foreground">ONNX 运行时</dt>
          <dd class="min-w-0 flex-1">
            <template v-if="onnxState.status === 'ready'">可用（{{ onnxState.providers.join('、') }}）</template>
            <span v-else class="text-muted-foreground">尚未初始化</span>
          </dd>
        </div>
        <div class="flex items-start gap-3">
          <dt class="w-28 shrink-0 text-muted-foreground">Plugin API</dt>
          <dd class="min-w-0 flex-1">v{{ PLUGIN_API_VERSION }} · 已安装 {{ plugins.length }} 个插件</dd>
        </div>
      </dl>

      <button
        type="button"
        class="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        @click="showMethods = !showMethods"
      >
        <Icon name="chevron-right" :size="12" class="transition-transform" :class="showMethods ? 'rotate-90' : ''" />
        宿主 API 方法清单（{{ HOST_METHODS.length }}）
      </button>
      <ul v-if="showMethods" class="mt-2 grid grid-cols-2 gap-1 sm:grid-cols-3">
        <li v-for="method in HOST_METHODS" :key="method" class="rounded bg-muted px-2 py-1 font-mono text-[10px]">
          {{ method }}
        </li>
      </ul>
    </section>

    <!-- Danger zone -->
    <section class="rounded-xl border border-destructive/30 bg-destructive/5 p-5">
      <h2 class="mb-2 text-sm font-semibold text-destructive">危险操作</h2>
      <p class="mb-4 text-xs leading-relaxed text-muted-foreground">
        清空所有本地数据：工作区文件、已安装的插件与订阅、全部偏好设置。内置插件会在重载后自动恢复。
      </p>
      <Button variant="destructive" size="sm" @click="confirmReset = true">重置所有数据</Button>
    </section>

    <Dialog v-model:open="confirmReset">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重置所有数据</DialogTitle>
          <DialogDescription>
            这会删除工作区文件、已安装插件、订阅与全部设置，然后重新加载页面。
          </DialogDescription>
        </DialogHeader>
        <p class="text-xs text-muted-foreground">该操作不可撤销。建议先在「工作区文件」中下载需要保留的结果。</p>
        <DialogFooter>
          <Button variant="outline" size="sm" @click="confirmReset = false">取消</Button>
          <Button variant="destructive" size="sm" @click="resetEverything">确认重置</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
