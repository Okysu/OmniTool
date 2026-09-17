<script setup lang="ts">
/**
 * The OmniTool mark: a ring (the whole toolbox) with a block docked into it
 * (a plugin). Drawn in the theme's primary colour, so it follows accent and
 * dark-mode changes; `public/favicon.svg` is the same shape in fixed colours.
 */
withDefaults(defineProps<{ size?: number }>(), { size: 28 })
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 64 64" role="img" aria-label="OmniTool" class="shrink-0">
    <rect width="64" height="64" rx="15" fill="var(--primary)" />
    <circle cx="29" cy="29" r="13.5" fill="none" stroke="var(--primary-foreground)" stroke-width="7" />
    <rect x="34.5" y="34.5" width="18" height="18" rx="5" fill="var(--primary-foreground)" stroke="var(--primary)" stroke-width="4" />
  </svg>
</template>
