<script setup lang="ts">
import { cn } from '@/lib/utils'

/** shadcn-vue ships no spinner; this is the one primitive we add ourselves. */
withDefaults(defineProps<{ size?: number; class?: string }>(), { size: 16 })
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    :class="cn('animate-spin', $props.class)"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity="0.2" stroke-width="3" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
  </svg>
</template>
