<script setup lang="ts">
/**
 * A workflow used like a tool: give it files (or text, when the first step
 * takes text) and run. This is where a pinned workflow opens from the sidebar;
 * the steps and their parameters are fixed here and changed in the editor.
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/common/Icon.vue'
import PipelineRunPanel from '@/components/pipeline/PipelineRunPanel.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { findTool, registryState } from '@/core/plugin/registry'
import { defaultParams } from '@/core/plugin/params'
import { isPinned, pipelines, setPinned, type PipelineStep } from '@/core/pipelines'
import Spinner from '@/components/common/Spinner.vue'

const props = defineProps<{ id: string }>()
const router = useRouter()

const pipeline = computed(() => pipelines.find((p) => p.id === props.id))

const chainText = computed(() =>
  (pipeline.value?.steps ?? []).map((step) => findTool(step.toolKey)?.tool.name ?? step.toolKey).join(' → '),
)

/** Parameters the user changed from the tool's defaults, as `label: value`. */
function customised(step: PipelineStep): string {
  const entry = findTool(step.toolKey)
  if (!entry?.tool.params) return ''
  const defaults = defaultParams(entry.tool)
  return entry.tool.params
    .filter((param) => step.params[param.key] !== undefined && step.params[param.key] !== defaults[param.key])
    .map((param) => {
      const raw = step.params[param.key]
      const value = param.type === 'select' ? (param.options.find((o) => o.value === raw)?.label ?? String(raw)) : param.type === 'switch' ? (raw ? '开' : '关') : String(raw)
      return `${param.label}：${value}`
    })
    .join(' · ')
}
</script>

<template>
  <div v-if="!pipeline" class="mx-auto max-w-lg px-6 py-20 text-center">
    <Icon name="circle-alert" :size="28" class="mx-auto text-muted-foreground" />
    <h1 class="mt-3 text-sm font-semibold">找不到这个工作流</h1>
    <p class="mt-1 text-xs text-muted-foreground">它可能已被删除。</p>
    <Button variant="outline" size="sm" class="mt-4" @click="router.push('/flows')">返回工作流列表</Button>
  </div>

  <div v-else class="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8" data-pipeline-run-page>
    <header class="mb-6 flex items-start gap-3">
      <span class="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Icon name="workflow" :size="20" />
      </span>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <h1 class="text-lg font-semibold tracking-tight">{{ pipeline.name }}</h1>
          <Badge variant="outline">工作流</Badge>
        </div>
        <p class="mt-1 text-xs leading-relaxed text-muted-foreground">
          {{ pipeline.steps.length }} 个步骤<template v-if="chainText">：{{ chainText }}</template>
        </p>
      </div>
      <Button variant="ghost" size="icon" title="编辑工作流" aria-label="编辑工作流" @click="router.push(`/flows/${pipeline.id}/edit`)">
        <Icon name="pen-line" :size="16" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        :title="isPinned(pipeline.id) ? '取消置顶' : '置顶到侧边栏'"
        :aria-label="isPinned(pipeline.id) ? '取消置顶' : '置顶到侧边栏'"
        :aria-pressed="isPinned(pipeline.id)"
        data-pipeline-pin
        @click="setPinned(pipeline.id, !isPinned(pipeline.id))"
      >
        <Icon :name="isPinned(pipeline.id) ? 'pin' : 'pin-off'" :size="16" :class="isPinned(pipeline.id) ? 'text-primary' : ''" />
      </Button>
    </header>

    <div v-if="!registryState.ready" class="flex items-center gap-2 py-10 text-sm text-muted-foreground">
      <Spinner :size="16" />
      正在加载插件…
    </div>

    <div v-else class="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <section class="min-w-0">
        <h2 class="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">输入</h2>
        <PipelineRunPanel :pipeline="pipeline" />
      </section>

      <aside class="lg:sticky lg:top-4 lg:self-start">
        <div class="rounded-xl border border-border bg-card p-4">
          <h2 class="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">步骤</h2>
          <ol class="space-y-2.5">
            <li v-for="(step, index) in pipeline.steps" :key="step.id" class="flex items-start gap-2">
              <span class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium tabular-nums">{{ index + 1 }}</span>
              <div class="min-w-0 flex-1">
                <p class="flex items-center gap-1.5 text-xs font-medium">
                  <Icon :name="findTool(step.toolKey)?.tool.icon ?? 'package'" :size="13" class="shrink-0 text-primary" />
                  <span class="truncate">{{ findTool(step.toolKey)?.tool.name ?? step.toolKey }}</span>
                </p>
                <p v-if="customised(step)" class="mt-0.5 text-[11px] leading-snug text-muted-foreground">{{ customised(step) }}</p>
              </div>
            </li>
          </ol>
          <p class="mt-3 border-t border-border pt-3 text-[11px] text-muted-foreground">
            {{ pipeline.cleanup ? '完成后删除中间文件，只保留最终结果。' : '保留每一步的中间文件。' }}
          </p>
          <Button variant="outline" size="sm" class="mt-3 w-full" @click="router.push(`/flows/${pipeline.id}/edit`)">
            <Icon name="pen-line" :size="13" />
            修改步骤与参数
          </Button>
        </div>
      </aside>
    </div>
  </div>
</template>
