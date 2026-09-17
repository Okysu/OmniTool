<script setup lang="ts">
/**
 * Reorderable list bound to a permutation of item indices.
 *
 * The bound value is `[2, 0, 1]`-style: position → original item index. A value
 * that is not a permutation of the current items (inputs were added or removed)
 * falls back to the natural order rather than showing a corrupt list.
 *
 * Mouse users can drag; every row also has up/down buttons, because HTML5 drag
 * events never fire from touch and keyboard users need a path too.
 */
import { computed, ref } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { Button } from '@/components/ui/button'

const props = defineProps<{ items: Array<{ label: string; detail?: string }>; modelValue: number[] | null; label?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: number[]] }>()

const order = computed(() => {
  const n = props.items.length
  const value = props.modelValue ?? []
  const valid = value.length === n && new Set(value).size === n && value.every((i) => Number.isInteger(i) && i >= 0 && i < n)
  return valid ? value : props.items.map((_, i) => i)
})

function move(from: number, to: number) {
  if (to < 0 || to >= order.value.length || from === to) return
  const next = [...order.value]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  emit('update:modelValue', next)
}

const dragFrom = ref<number | null>(null)
const dragOver = ref<number | null>(null)

function drop(position: number) {
  if (dragFrom.value !== null) move(dragFrom.value, position)
  dragFrom.value = dragOver.value = null
}
</script>

<template>
  <div class="space-y-1.5">
    <p v-if="label" class="text-xs font-medium">{{ label }}</p>
    <ol class="space-y-1">
      <li
        v-for="(itemIndex, position) in order"
        :key="itemIndex"
        draggable="true"
        class="flex items-center gap-2 rounded-lg border bg-background py-1.5 pl-2 pr-1 text-xs transition-colors"
        :class="[
          dragOver === position && dragFrom !== position ? 'border-primary/60 bg-primary/5' : 'border-border',
          dragFrom === position ? 'opacity-50' : '',
        ]"
        @dragstart="dragFrom = position"
        @dragover.prevent="dragOver = position"
        @drop.prevent="drop(position)"
        @dragend="dragFrom = dragOver = null"
      >
        <Icon name="grip-vertical" :size="13" class="shrink-0 cursor-grab text-muted-foreground/60" />
        <span class="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-medium tabular-nums">
          {{ position + 1 }}
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate font-medium">{{ items[itemIndex]?.label }}</span>
          <span v-if="items[itemIndex]?.detail" class="block truncate text-[11px] text-muted-foreground">
            {{ items[itemIndex].detail }}
          </span>
        </span>
        <Button variant="ghost" size="icon-xs" :disabled="position === 0" aria-label="上移" @click="move(position, position - 1)">
          <Icon name="arrow-up" :size="12" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          :disabled="position === order.length - 1"
          aria-label="下移"
          @click="move(position, position + 1)"
        >
          <Icon name="arrow-down" :size="12" />
        </Button>
      </li>
    </ol>
  </div>
</template>
