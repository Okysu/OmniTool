<script setup lang="ts">
/** The navigation drawer for screens below `md`. */
import { watch } from 'vue'
import { useRoute } from 'vue-router'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import SideNav from './SideNav.vue'
import { mobileNavOpen } from '@/core/ui/nav'
import AppLogo from '@/components/common/AppLogo.vue'

const route = useRoute()

// Any navigation - including browser back - closes the drawer.
watch(() => route.fullPath, () => (mobileNavOpen.value = false))
</script>

<template>
  <Sheet v-model:open="mobileNavOpen">
    <SheetContent side="left" class="flex w-[85vw] max-w-80 flex-col gap-0 p-0">
      <SheetHeader class="border-b border-border px-4 py-3 text-left">
        <SheetTitle class="flex items-center gap-2 text-base">
          <AppLogo :size="28" />
          OmniTool
        </SheetTitle>
        <SheetDescription class="sr-only">工具与页面导航</SheetDescription>
      </SheetHeader>
      <div class="min-h-0 flex-1">
        <SideNav variant="sheet" @navigate="mobileNavOpen = false" />
      </div>
    </SheetContent>
  </Sheet>
</template>
