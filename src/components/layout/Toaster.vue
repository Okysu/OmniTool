<script setup lang="ts">
/**
 * Toast surface.
 *
 * Rendering is shadcn-vue's `sonner`; `@/core/ui/toast` remains the app-facing
 * API because the `ui.notify` capability publishes through it and plugin text
 * must stay plain data on the way in.
 */
import { Toaster } from '@/components/ui/sonner'
import 'vue-sonner/style.css'
</script>

<template>
  <Toaster
    position="bottom-left"
    :duration="4000"
    close-button
    rich-colors
    :toast-options="{ classes: { toast: 'text-sm' } }"
  />
</template>
