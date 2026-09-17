<script setup lang="ts">
import type { ProgressRootProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { computed } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import {
  ProgressIndicator,
  ProgressRoot,
} from 'reka-ui'
import { cn } from '@/lib/utils'

/**
 * LOCAL MODIFICATION (re-apply after `shadcn-vue add progress --overwrite`):
 * upstream renders `modelValue: null` as an empty bar. We use `null` to mean
 * "indeterminate" - a plugin that reports no progress still needs to look alive -
 * so a null value switches to a sweeping indicator instead.
 */
const props = withDefaults(
  defineProps<ProgressRootProps & { class?: HTMLAttributes['class'] }>(),
  {
    modelValue: 0,
  },
)

const delegatedProps = reactiveOmit(props, 'class')

const indeterminate = computed(() => props.modelValue === null || props.modelValue === undefined)
</script>

<template>
  <ProgressRoot
    data-slot="progress"
    v-bind="delegatedProps"
    :class="
      cn(
        'bg-muted h-1.5 rounded-full relative flex w-full items-center overflow-x-hidden',
        props.class,
      )
    "
  >
    <ProgressIndicator
      v-if="!indeterminate"
      data-slot="progress-indicator"
      class="bg-primary size-full flex-1 transition-all"
      :style="`transform: translateX(-${100 - (props.modelValue ?? 0)}%);`"
    />
    <div
      v-else
      data-slot="progress-indicator"
      class="omni-sweep bg-primary h-full w-1/3 rounded-full"
    />
  </ProgressRoot>
</template>

<style scoped>
@keyframes omni-progress-sweep {
  0% {
    transform: translateX(-110%);
  }
  100% {
    transform: translateX(320%);
  }
}
.omni-sweep {
  animation: omni-progress-sweep 1.4s cubic-bezier(0.45, 0, 0.55, 1) infinite;
}
</style>
