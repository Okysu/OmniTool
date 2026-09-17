<script setup lang="ts">
/**
 * Input, run control, per-step progress and results for one pipeline.
 *
 * Shared by the editor and the pinned run page. Its state lives in the
 * pipeline's session (`core/pipelines`), not here, so both pages show the same
 * inputs and the same run. When the first step accepts text, the user may type
 * or paste instead of dropping files - the text becomes a workspace file named
 * the way that tool expects, exactly as on a tool page.
 */
import { computed } from 'vue'
import DropZone from '@/components/tool/DropZone.vue'
import FileGrid from '@/components/tool/FileGrid.vue'
import Icon from '@/components/common/Icon.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { findTool } from '@/core/plugin/registry'
import { cancelPipeline, pipelineSession, runs, startPipeline, validatePipeline, type Pipeline } from '@/core/pipelines'
import { pushToast } from '@/core/ui/toast'
import * as vfs from '@/core/vfs'
import { formatBytes } from '@/lib/format'

const props = defineProps<{ pipeline: Pipeline }>()

const session = computed(() => pipelineSession(props.pipeline.id))
const run = computed(() => (session.value.runId ? runs.find((r) => r.id === session.value.runId) : undefined))
const running = computed(() => run.value?.status === 'running')

const firstTool = computed(() => {
  const first = props.pipeline.steps[0]
  return first ? findTool(first.toolKey)?.tool : undefined
})
const inputMode = computed(() => {
  const mode = firstTool.value?.input
  return mode === 'text' || mode === 'both' ? mode : 'files'
})
const usingText = computed(() => inputMode.value === 'text' || (inputMode.value === 'both' && session.value.inputTab === 'text'))

const problems = computed(() => validatePipeline(props.pipeline.steps, findTool))
const inputReady = computed(() => (usingText.value ? session.value.text.trim().length > 0 : session.value.inputs.length > 0))
const canRun = computed(() => problems.value.length === 0 && inputReady.value && !running.value)
const textBytes = computed(() => new TextEncoder().encode(session.value.text).length)

async function start() {
  if (!canRun.value) return
  let inputs = [...session.value.inputs]
  if (usingText.value) {
    try {
      const name = firstTool.value?.textFileName || 'input.txt'
      const file = await vfs.writeAll(name, new TextEncoder().encode(session.value.text), vfs.guessType(name) || 'text/plain')
      inputs = [file.id]
    } catch (error) {
      pushToast({ level: 'error', title: '无法写入文本', message: error instanceof Error ? error.message : String(error) })
      return
    }
  }
  session.value.runId = startPipeline(props.pipeline, inputs).id
}

async function removeInput(id: string) {
  session.value.inputs = session.value.inputs.filter((fileId) => fileId !== id)
  await vfs.remove(id)
}

const STATE_ICON = { pending: 'circle', running: 'loader', done: 'circle-check', failed: 'circle-alert', cancelled: 'ban' } as const
const STATE_CLASS = {
  pending: 'text-muted-foreground',
  running: 'animate-spin text-primary',
  done: 'text-success',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground',
} as const

const stepName = (index: number) => {
  const step = props.pipeline.steps[index]
  return (step && findTool(step.toolKey)?.tool.name) || '步骤'
}
</script>

<template>
  <div class="space-y-3">
    <Tabs v-if="inputMode === 'both'" v-model="session.inputTab">
      <TabsList class="mb-2 h-8">
        <TabsTrigger value="files" class="text-xs"><Icon name="folder-open" :size="13" /> 文件</TabsTrigger>
        <TabsTrigger value="text" class="text-xs"><Icon name="type" :size="13" /> 直接输入</TabsTrigger>
      </TabsList>
      <TabsContent value="files">
        <DropZone :accept="firstTool?.accept ?? []" :multiple="true" :files="session.inputs" @add="session.inputs = [...session.inputs, ...$event]" @remove="removeInput" />
      </TabsContent>
      <TabsContent value="text">
        <Textarea v-model="session.text" :rows="10" placeholder="在这里粘贴或输入内容…" class="scroll-slim min-h-48 resize-y font-mono text-xs" data-pipeline-text />
        <p class="mt-1 text-right text-[11px] tabular-nums text-muted-foreground">{{ session.text.length }} 字符 · {{ formatBytes(textBytes) }}</p>
      </TabsContent>
    </Tabs>
    <template v-else-if="inputMode === 'text'">
      <Textarea v-model="session.text" :rows="10" placeholder="在这里粘贴或输入内容…" class="scroll-slim min-h-48 resize-y font-mono text-xs" data-pipeline-text />
    </template>
    <DropZone
      v-else
      :accept="firstTool?.accept ?? []"
      :multiple="true"
      :files="session.inputs"
      @add="session.inputs = [...session.inputs, ...$event]"
      @remove="removeInput"
    />

    <p v-for="problem in problems" :key="problem" class="text-xs text-destructive">{{ problem }}</p>
    <div class="flex gap-2">
      <Button class="flex-1" :disabled="!canRun" data-pipeline-run @click="start">
        <Icon :name="running ? 'loader' : 'play'" :size="14" :class="running ? 'animate-spin' : ''" />
        {{ running ? '运行中…' : `运行 ${pipeline.steps.length} 个步骤` }}
      </Button>
      <Button v-if="running && run" variant="outline" @click="cancelPipeline(run.id)">取消</Button>
    </div>

    <div v-if="run" class="rounded-xl border border-border bg-card p-4" :data-pipeline-status="run.status">
      <ol class="space-y-2">
        <li v-for="(state, index) in run.steps" :key="index" class="flex items-center gap-2 text-xs">
          <Icon :name="STATE_ICON[state.state]" :size="14" :class="STATE_CLASS[state.state]" />
          <span class="min-w-0 flex-1 truncate">{{ index + 1 }}. {{ stepName(index) }}</span>
          <span v-if="state.state !== 'pending'" class="tabular-nums text-muted-foreground">
            {{ state.inputs }} → {{ state.state === 'done' ? state.outputs : '…' }}
          </span>
          <Badge v-if="state.note" variant="outline" class="text-[10px]">{{ state.note }}</Badge>
        </li>
      </ol>
      <p v-if="run.status === 'done'" class="mt-3 text-xs font-medium text-success">完成，共得到 {{ run.outputs.length }} 个文件</p>
      <p v-else-if="run.error" class="mt-3 whitespace-pre-line text-xs text-destructive">{{ run.error }}</p>
    </div>

    <FileGrid v-if="run?.outputs.length" :ids="run.outputs" :zip-name="`${pipeline.name}.zip`" empty-text="没有输出文件" />
  </div>
</template>
