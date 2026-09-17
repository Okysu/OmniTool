<script setup lang="ts">
/**
 * Pipelines: chain form tools so one drop of files runs through several steps.
 *
 * This page is the library - the user's own workflows as cards. Creating one
 * asks for a name and a starting point (blank or a template) and then opens the
 * full-screen editor. A pinned workflow appears in the sidebar and opens as a
 * run page that works like any tool: give it files or text, press run.
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/common/Icon.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { findTool, registryState } from '@/core/plugin/registry'
import {
  TEMPLATES,
  createPipeline,
  deletePipeline,
  importPipeline,
  isPinned,
  pipelines,
  setPinned,
  validatePipeline,
  type Pipeline,
} from '@/core/pipelines'
import { promptForConfirmation } from '@/core/ui/prompt'
import { pushToast } from '@/core/ui/toast'

const router = useRouter()

const edit = (pipeline: Pipeline) => router.push(`/flows/${pipeline.id}/edit`)
const runPage = (pipeline: Pipeline) => router.push(`/flows/${pipeline.id}`)

const sorted = computed(() => [...pipelines].sort((a, b) => b.updatedAt - a.updatedAt))

/** Up to six tool icons along the card, so a workflow is recognisable at a glance. */
function chain(pipeline: Pipeline) {
  return pipeline.steps.slice(0, 6).map((step) => {
    const entry = findTool(step.toolKey)
    return { id: step.id, icon: entry?.tool.icon ?? 'package', name: entry?.tool.name ?? step.toolKey, missing: registryState.ready && !entry }
  })
}

// Before plugins register every tool looks missing; do not flash errors meanwhile.
const valid = (pipeline: Pipeline) => !registryState.ready || validatePipeline(pipeline.steps, findTool).length === 0

async function remove(pipeline: Pipeline) {
  const accepted = await promptForConfirmation({
    title: '删除工作流',
    message: `确定删除「${pipeline.name}」吗？`,
    detail: '已经生成的文件不会被删除。',
    confirmLabel: '删除',
    tone: 'destructive',
  })
  if (accepted) deletePipeline(pipeline.id)
}

function relativeTime(at: number) {
  const minutes = Math.round((Date.now() - at) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (minutes < 1440) return `${Math.round(minutes / 60)} 小时前`
  return new Date(at).toLocaleDateString()
}

/* ------------------------------------------------------------------ create */

const createOpen = ref(false)
const newName = ref('')
/** `null` = blank workflow. */
const templateId = ref<string | null>(null)
/** Once the user types a name, picking a template no longer overwrites it. */
const nameTouched = ref(false)

const templates = computed(() => TEMPLATES.filter((t) => t.steps.every((s) => findTool(s.toolKey))))

function openCreate() {
  newName.value = ''
  templateId.value = null
  nameTouched.value = false
  createOpen.value = true
}

function pickTemplate(id: string | null) {
  templateId.value = id
  if (!nameTouched.value) newName.value = id ? (TEMPLATES.find((t) => t.id === id)?.name ?? '') : ''
}

function confirmCreate() {
  const template = TEMPLATES.find((t) => t.id === templateId.value)
  const pipeline = createPipeline({
    name: newName.value.trim() || template?.name || '新工作流',
    steps: template ? template.steps.map((step) => ({ ...step, id: '' })) : [],
  })
  createOpen.value = false
  void edit(pipeline)
}

/* ------------------------------------------------------------------ import */

const importInput = ref<HTMLInputElement | null>(null)
async function importFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  ;(event.target as HTMLInputElement).value = ''
  if (!file) return
  try {
    const pipeline = importPipeline(JSON.parse(await file.text()))
    pushToast({ level: 'success', message: `已导入工作流「${pipeline.name}」` })
    void edit(pipeline)
  } catch (error) {
    pushToast({ level: 'error', title: '导入失败', message: error instanceof Error ? error.message : String(error) })
  }
}
</script>

<template>
  <div class="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
    <header class="mb-6 flex flex-wrap items-start gap-3">
      <span class="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Icon name="workflow" :size="20" />
      </span>
      <div class="min-w-0 flex-1">
        <h1 class="text-lg font-semibold tracking-tight">工作流</h1>
        <p class="mt-1 text-xs leading-relaxed text-muted-foreground">
          把多个工具串起来：上一步的输出自动交给下一步。只需拖入一次文件，全部在本机完成。置顶后，工作流会像普通工具一样出现在侧边栏。
        </p>
      </div>
      <div class="flex w-full justify-end gap-2 sm:w-auto">
        <input ref="importInput" type="file" accept=".json,application/json" class="hidden" @change="importFile" />
        <Button variant="outline" size="sm" @click="importInput?.click()">
          <Icon name="upload" :size="14" />
          导入
        </Button>
        <Button size="sm" data-pipeline-new @click="openCreate">
          <Icon name="plus" :size="14" />
          新建工作流
        </Button>
      </div>
    </header>

    <div v-if="sorted.length === 0" class="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-12 text-center">
      <Icon name="workflow" :size="28" class="text-muted-foreground" />
      <p class="mt-3 text-sm font-medium">还没有工作流</p>
      <p class="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
        例如：照片 → 缩小 → 加水印 → 转 WebP；扫描 PDF → 增强 → 文字识别。可以从模板开始。
      </p>
      <Button size="sm" class="mt-4" @click="openCreate">
        <Icon name="plus" :size="14" />
        新建工作流
      </Button>
    </div>

    <ul v-else class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <li
        v-for="pipeline in sorted"
        :key="pipeline.id"
        class="group relative flex flex-col rounded-xl border border-border bg-card transition-shadow hover:shadow-sm"
        data-pipeline-card
      >
        <button type="button" class="flex min-w-0 flex-1 flex-col gap-3 p-4 text-left" :title="`编辑「${pipeline.name}」`" @click="edit(pipeline)">
          <div class="flex w-full items-start gap-2 pr-8">
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold">{{ pipeline.name }}</p>
              <p class="mt-0.5 text-[11px] text-muted-foreground">
                {{ pipeline.steps.length }} 个步骤 · {{ relativeTime(pipeline.updatedAt) }}
                <span v-if="!valid(pipeline)" class="text-destructive"> · 需要修改</span>
              </p>
            </div>
          </div>
          <div v-if="pipeline.steps.length" class="flex flex-wrap items-center gap-1">
            <template v-for="(item, index) in chain(pipeline)" :key="item.id">
              <Icon v-if="index > 0" name="chevron-right" :size="11" class="text-muted-foreground/60" />
              <span
                class="flex size-7 items-center justify-center rounded-md"
                :class="item.missing ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'"
                :title="item.name"
              >
                <Icon :name="item.icon" :size="14" />
              </span>
            </template>
            <span v-if="pipeline.steps.length > 6" class="ml-1 text-[11px] text-muted-foreground">+{{ pipeline.steps.length - 6 }}</span>
          </div>
          <p v-else class="text-[11px] text-muted-foreground">还没有步骤</p>
        </button>

        <Button
          variant="ghost"
          size="icon"
          class="absolute right-2 top-2 size-8"
          :class="isPinned(pipeline.id) ? 'text-primary' : 'text-muted-foreground'"
          :title="isPinned(pipeline.id) ? '取消置顶' : '置顶到侧边栏，像工具一样直接使用'"
          :aria-label="isPinned(pipeline.id) ? '取消置顶' : '置顶到侧边栏'"
          :aria-pressed="isPinned(pipeline.id)"
          data-pipeline-pin
          @click="setPinned(pipeline.id, !isPinned(pipeline.id))"
        >
          <Icon :name="isPinned(pipeline.id) ? 'pin' : 'pin-off'" :size="15" />
        </Button>

        <div class="flex items-center gap-1 border-t border-border px-2 py-1.5">
          <Button variant="ghost" size="sm" :disabled="!valid(pipeline)" data-pipeline-open-run @click="runPage(pipeline)">
            <Icon name="play" :size="13" />
            运行
          </Button>
          <Button variant="ghost" size="sm" @click="edit(pipeline)">
            <Icon name="pen-line" :size="13" />
            编辑
          </Button>
          <Button variant="ghost" size="sm" class="ml-auto text-muted-foreground hover:text-destructive" aria-label="删除工作流" @click="remove(pipeline)">
            <Icon name="trash" :size="13" />
          </Button>
        </div>
      </li>
    </ul>

    <Dialog v-model:open="createOpen">
      <DialogContent class="max-h-[90dvh] overflow-y-auto scroll-slim sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>新建工作流</DialogTitle>
          <DialogDescription>起个名字，从空白开始或选择一个模板。创建后进入编辑器。</DialogDescription>
        </DialogHeader>
        <form class="space-y-4" @submit.prevent="confirmCreate">
          <div class="space-y-1.5">
            <Label for="new-pipeline-name" class="text-xs">名称</Label>
            <Input id="new-pipeline-name" v-model="newName" maxlength="80" placeholder="新工作流" autofocus @input="nameTouched = true" />
          </div>
          <div class="space-y-1.5">
            <p class="text-xs font-medium">起点</p>
            <div class="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="起点">
              <button
                type="button"
                role="radio"
                :aria-checked="templateId === null"
                class="rounded-lg border px-3 py-2.5 text-left transition-colors"
                :class="templateId === null ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted'"
                data-template="blank"
                @click="pickTemplate(null)"
              >
                <span class="flex items-center gap-1.5 text-sm font-medium"><Icon name="plus" :size="14" /> 空白工作流</span>
                <span class="mt-0.5 block text-[11px] leading-snug text-muted-foreground">从零开始逐个添加步骤。</span>
              </button>
              <button
                v-for="template in templates"
                :key="template.id"
                type="button"
                role="radio"
                :aria-checked="templateId === template.id"
                class="rounded-lg border px-3 py-2.5 text-left transition-colors"
                :class="templateId === template.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted'"
                :data-template="template.id"
                @click="pickTemplate(template.id)"
              >
                <span class="block text-sm font-medium">{{ template.name }}</span>
                <span class="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{{ template.description }}</span>
              </button>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" @click="createOpen = false">取消</Button>
            <Button type="submit" size="sm" data-pipeline-create>
              <Icon name="check" :size="14" />
              创建并编辑
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>
</template>
