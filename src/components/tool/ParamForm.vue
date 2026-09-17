<script setup lang="ts">
/**
 * Renders a tool's parameter form from its declared schema.
 *
 * The host owns the form so a plugin never gets to draw UI: a manifest can
 * describe controls but cannot inject markup, styles or event handlers into the
 * app. Labels and hints are interpolated as text.
 */
import { computed } from 'vue'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import type { ParamSpec, ParamValues } from '@/core/types'

const props = defineProps<{ params: ParamSpec[] }>()
const model = defineModel<ParamValues>({ required: true })

/** Params whose `when` condition is satisfied by the current values. */
const visible = computed(() =>
  props.params.filter((param) => {
    if (!param.when) return true
    const current = model.value[param.when.key]
    const expected = param.when.equals
    return Array.isArray(expected) ? expected.includes(current) : current === expected
  }),
)

function update(key: string, value: string | number | boolean) {
  model.value = { ...model.value, [key]: value }
}

/** Reka's slider is multi-thumb, so its model is an array. */
function updateSlider(key: string, value: number[] | undefined) {
  if (value && value.length > 0) update(key, value[0])
}
</script>

<template>
  <div class="space-y-4">
    <div v-for="param in visible" :key="param.key" class="space-y-1.5">
      <div class="flex items-baseline gap-2">
        <Label :for="`param-${param.key}`" class="text-xs">{{ param.label }}</Label>
        <span v-if="param.type === 'slider'" class="ml-auto tabular-nums text-xs text-muted-foreground">
          {{ model[param.key] }}{{ param.suffix ?? '' }}
        </span>
      </div>

      <Select
        v-if="param.type === 'select'"
        :model-value="String(model[param.key] ?? '')"
        @update:model-value="update(param.key, String($event ?? ''))"
      >
        <SelectTrigger :id="`param-${param.key}`" class="w-full">
          <SelectValue placeholder="请选择" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="option in param.options" :key="option.value" :value="option.value">
            {{ option.label }}
          </SelectItem>
        </SelectContent>
      </Select>

      <Slider
        v-else-if="param.type === 'slider'"
        :id="`param-${param.key}`"
        :min="param.min"
        :max="param.max"
        :step="param.step ?? 1"
        :model-value="[Number(model[param.key] ?? param.min)]"
        class="py-1"
        @update:model-value="updateSlider(param.key, $event)"
      />

      <div v-else-if="param.type === 'switch'" class="flex items-center gap-2">
        <Switch
          :id="`param-${param.key}`"
          :model-value="Boolean(model[param.key])"
          @update:model-value="update(param.key, $event)"
        />
        <span class="text-xs text-muted-foreground">{{ model[param.key] ? '已开启' : '已关闭' }}</span>
      </div>

      <div v-else-if="param.type === 'number'" class="relative">
        <Input
          :id="`param-${param.key}`"
          type="number"
          :min="param.min"
          :max="param.max"
          :step="param.step ?? 1"
          :model-value="Number(model[param.key] ?? 0)"
          :class="param.suffix ? 'pr-10' : ''"
          @update:model-value="update(param.key, Number($event))"
        />
        <span
          v-if="param.suffix"
          class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground"
        >
          {{ param.suffix }}
        </span>
      </div>

      <Textarea
        v-else-if="param.type === 'textarea'"
        :id="`param-${param.key}`"
        :rows="param.rows ?? 4"
        :placeholder="param.placeholder"
        class="font-mono text-xs scroll-slim"
        :model-value="String(model[param.key] ?? '')"
        @update:model-value="update(param.key, String($event ?? ''))"
      />

      <Input
        v-else
        :id="`param-${param.key}`"
        type="text"
        :placeholder="param.placeholder"
        :model-value="String(model[param.key] ?? '')"
        @update:model-value="update(param.key, String($event ?? ''))"
      />

      <p v-if="param.hint" class="text-[11px] leading-relaxed text-muted-foreground">{{ param.hint }}</p>
    </div>
  </div>
</template>
