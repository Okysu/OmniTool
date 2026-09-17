<script setup lang="ts">
/**
 * Renders one node of a plugin-described panel, recursively.
 *
 * Everything a plugin can reach is enumerated here, and each branch maps to a
 * real shadcn-vue component - which is the whole point: a third-party panel
 * looks and behaves exactly like built-in UI because it *is* built-in UI.
 * Strings are only ever interpolated as text.
 */
import { computed } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import PanelCanvas from './PanelCanvas.vue'
import PanelMedia from './PanelMedia.vue'
import PanelReorder from './PanelReorder.vue'
import InlinePreview from './InlinePreview.vue'
import type { UiNode, UiState, UiValue } from '@/core/ui/schema'

const props = defineProps<{ node: UiNode; state: UiState }>()

const emit = defineEmits<{
  change: [key: string, value: UiValue]
  action: [name: string]
  pointer: [canvasId: string, event: Record<string, number | string>]
  canvas: [canvasId: string, canvas: OffscreenCanvas, width: number, height: number]
}>()

const visible = computed(() => {
  const when = props.node.when
  if (!when) return true
  const current = props.state[when.key]
  return Array.isArray(when.equals) ? when.equals.includes(current) : current === when.equals
})

function bound(key: string): UiValue | undefined {
  return props.state[key]
}

/**
 * Narrowed fields for use inside template arrow functions, where TypeScript
 * loses the `v-else-if` discrimination on `node`.
 */
const bindKey = computed(() => ('bind' in props.node ? props.node.bind : ''))
const canvasId = computed(() => (props.node.type === 'canvas' ? props.node.id : ''))

const ALIGN: Record<string, string> = {
  start: 'justify-start',
  center: 'justify-center',
  end: 'justify-end',
  between: 'justify-between',
}

const TEXT: Record<string, string> = {
  title: 'text-sm font-semibold tracking-tight',
  body: 'text-xs leading-relaxed',
  muted: 'text-[11px] leading-relaxed text-muted-foreground',
  mono: 'font-mono text-[11px] leading-relaxed break-all',
}

const ALERT_ICON: Record<string, string> = {
  info: 'info',
  success: 'circle-check',
  warning: 'alert-triangle',
  destructive: 'circle-alert',
}

/** Gap in Tailwind's 0.25rem scale, clamped to something sane. */
function gapStyle(gap: number | undefined) {
  return { gap: `${Math.max(0, Math.min(12, gap ?? 3)) * 0.25}rem` }
}
</script>

<template>
  <template v-if="visible">
    <!-- ----------------------------- layout ------------------------------ -->
    <div v-if="node.type === 'stack'" class="flex flex-col" :style="gapStyle(node.gap)">
      <PanelNode
        v-for="(child, index) in node.children"
        :key="index"
        :node="child"
        :state="state"
        @change="(k, v) => emit('change', k, v)"
        @action="(n) => emit('action', n)"
        @pointer="(id, e) => emit('pointer', id, e)"
        @canvas="(id, c, w, h) => emit('canvas', id, c, w, h)"
      />
    </div>

    <div
      v-else-if="node.type === 'row'"
      class="flex items-center"
      :class="[ALIGN[node.align ?? 'start'], node.wrap ? 'flex-wrap' : '']"
      :style="gapStyle(node.gap)"
    >
      <PanelNode
        v-for="(child, index) in node.children"
        :key="index"
        :node="child"
        :state="state"
        @change="(k, v) => emit('change', k, v)"
        @action="(n) => emit('action', n)"
        @pointer="(id, e) => emit('pointer', id, e)"
        @canvas="(id, c, w, h) => emit('canvas', id, c, w, h)"
      />
    </div>

    <section v-else-if="node.type === 'section'" class="space-y-3">
      <h3 v-if="node.title" class="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {{ node.title }}
      </h3>
      <PanelNode
        v-for="(child, index) in node.children"
        :key="index"
        :node="child"
        :state="state"
        @change="(k, v) => emit('change', k, v)"
        @action="(n) => emit('action', n)"
        @pointer="(id, e) => emit('pointer', id, e)"
        @canvas="(id, c, w, h) => emit('canvas', id, c, w, h)"
      />
    </section>

    <Separator v-else-if="node.type === 'separator'" />

    <!-- ------------------------------ text ------------------------------- -->
    <p v-else-if="node.type === 'text'" :class="TEXT[node.variant ?? 'body']">{{ node.text }}</p>

    <Badge v-else-if="node.type === 'badge'" :variant="node.tone ?? 'secondary'">{{ node.text }}</Badge>

    <Alert
      v-else-if="node.type === 'alert'"
      :variant="node.tone === 'destructive' ? 'destructive' : 'default'"
      :class="{
        'border-success/30 text-success': node.tone === 'success',
        'border-warning/40': node.tone === 'warning',
      }"
    >
      <Icon :name="ALERT_ICON[node.tone ?? 'info']" :size="15" />
      <AlertTitle v-if="node.title">{{ node.title }}</AlertTitle>
      <AlertDescription>{{ node.text }}</AlertDescription>
    </Alert>

    <dl v-else-if="node.type === 'facts'" class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
      <template v-for="(row, index) in node.rows" :key="index">
        <dt class="text-muted-foreground">{{ row.label }}</dt>
        <dd class="min-w-0 truncate font-medium tabular-nums" :title="row.value">{{ row.value }}</dd>
      </template>
    </dl>

    <!-- ---------------------------- controls ----------------------------- -->
    <div
      v-else-if="
        node.type === 'input' ||
        node.type === 'textarea' ||
        node.type === 'select' ||
        node.type === 'segmented' ||
        node.type === 'slider' ||
        node.type === 'switch' ||
        node.type === 'color'
      "
      class="space-y-1.5"
    >
      <div v-if="node.label" class="flex items-baseline gap-2">
        <Label :for="`panel-${node.bind}`" class="text-xs">{{ node.label }}</Label>
        <span v-if="node.type === 'slider'" class="ml-auto tabular-nums text-xs text-muted-foreground">
          {{ bound(node.bind) }}{{ node.suffix ?? '' }}
        </span>
      </div>

      <div v-if="node.type === 'input'" class="relative">
        <Input
          :id="`panel-${node.bind}`"
          :type="node.inputType ?? 'text'"
          :min="node.min"
          :max="node.max"
          :step="node.step"
          :placeholder="node.placeholder"
          :model-value="(bound(node.bind) as string | number) ?? ''"
          :class="node.suffix ? 'pr-10' : ''"
          @update:model-value="emit('change', node.bind, node.inputType === 'number' ? Number($event) : String($event))"
        />
        <span
          v-if="node.suffix"
          class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground"
        >
          {{ node.suffix }}
        </span>
      </div>

      <Textarea
        v-else-if="node.type === 'textarea'"
        :id="`panel-${node.bind}`"
        :rows="node.rows ?? 6"
        :placeholder="node.placeholder"
        :class="['scroll-slim', node.mono ? 'font-mono text-xs' : '']"
        :model-value="String(bound(node.bind) ?? '')"
        @update:model-value="emit('change', node.bind, String($event ?? ''))"
      />

      <Select
        v-else-if="node.type === 'select'"
        :model-value="String(bound(node.bind) ?? '')"
        @update:model-value="emit('change', node.bind, String($event ?? ''))"
      >
        <SelectTrigger :id="`panel-${node.bind}`" class="w-full">
          <SelectValue placeholder="请选择" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="option in node.options" :key="option.value" :value="option.value">
            {{ option.label }}
          </SelectItem>
        </SelectContent>
      </Select>

      <ToggleGroup
        v-else-if="node.type === 'segmented'"
        type="single"
        variant="outline"
        class="w-full"
        :model-value="String(bound(node.bind) ?? '')"
        @update:model-value="(v) => v && emit('change', bindKey, String(v))"
      >
        <ToggleGroupItem v-for="option in node.options" :key="option.value" :value="option.value" class="flex-1 text-xs">
          {{ option.label }}
        </ToggleGroupItem>
      </ToggleGroup>

      <Slider
        v-else-if="node.type === 'slider'"
        :id="`panel-${node.bind}`"
        :min="node.min"
        :max="node.max"
        :step="node.step ?? 1"
        :model-value="[Number(bound(node.bind) ?? node.min)]"
        class="py-1"
        @update:model-value="(v) => v?.length && emit('change', bindKey, v[0])"
      />

      <div v-else-if="node.type === 'switch'" class="flex items-center gap-2">
        <Switch
          :id="`panel-${node.bind}`"
          :model-value="Boolean(bound(node.bind))"
          @update:model-value="emit('change', node.bind, $event)"
        />
      </div>

      <div v-else-if="node.type === 'color'" class="flex items-center gap-2">
        <input
          :id="`panel-${node.bind}`"
          type="color"
          class="size-9 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-1"
          :value="String(bound(node.bind) ?? '#000000').slice(0, 7)"
          @input="emit('change', node.bind, ($event.target as HTMLInputElement).value)"
        />
        <Input
          class="font-mono"
          :model-value="String(bound(node.bind) ?? '')"
          @update:model-value="emit('change', node.bind, String($event))"
        />
      </div>

      <p v-if="node.hint" class="text-[11px] leading-relaxed text-muted-foreground">{{ node.hint }}</p>
    </div>

    <Button
      v-else-if="node.type === 'button'"
      :variant="node.variant ?? 'outline'"
      size="sm"
      :disabled="node.disabled || node.busy"
      @click="emit('action', node.action)"
    >
      <Icon v-if="node.busy" name="loader" :size="14" class="animate-spin" />
      <Icon v-else-if="node.icon" :name="node.icon" :size="14" />
      {{ node.text }}
    </Button>

    <!-- --------------------------- rich widgets -------------------------- -->
    <InlinePreview v-else-if="node.type === 'preview'" :file-id="node.fileId" :height="node.height" />

    <!-- `timeline` predates `media` and is exactly a media node editing a range. -->
    <PanelMedia
      v-else-if="node.type === 'timeline'"
      :file-id="node.fileId"
      :state="state"
      :range="node.bind"
      @change="(k, v) => emit('change', k, v)"
    />

    <PanelMedia
      v-else-if="node.type === 'media'"
      :file-id="node.fileId"
      :state="state"
      :range="node.range"
      :crop="node.crop"
      :crop-aspect="node.cropAspect"
      :markers="node.markers"
      :meta="node.meta"
      :effects="node.effects"
      :height="node.height"
      @change="(k, v) => emit('change', k, v)"
    />

    <PanelReorder
      v-else-if="node.type === 'reorder'"
      :items="node.items"
      :label="node.label"
      :model-value="(bound(node.bind) as number[] | undefined) ?? null"
      @update:model-value="emit('change', bindKey, $event)"
    />

    <PanelCanvas
      v-else-if="node.type === 'canvas'"
      :canvas-id="node.id"
      :aspect="node.aspect"
      :height="node.height"
      :interactive="node.interactive"
      @ready="(c, w, h) => emit('canvas', canvasId, c, w, h)"
      @pointer="(e) => emit('pointer', canvasId, e)"
    />
  </template>
</template>
