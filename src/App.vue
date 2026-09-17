<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import TopBar from '@/components/layout/TopBar.vue'
import SideBar from '@/components/layout/SideBar.vue'
import MobileNav from '@/components/layout/MobileNav.vue'
import TaskDock from '@/components/layout/TaskDock.vue'
import Toaster from '@/components/layout/Toaster.vue'
import CommandPalette from '@/components/layout/CommandPalette.vue'
import PromptHost from '@/components/layout/PromptHost.vue'
import { paletteOpen } from '@/core/ui/palette'
import { tasks } from '@/core/tasks/queue'

const route = useRoute()
/** Pages such as the tutorial bring their own full-screen layout. */
const standalone = computed(() => route.meta.layout === 'standalone')

function onKeydown(event: KeyboardEvent) {
  const isPaletteChord = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k'
  if (isPaletteChord) {
    event.preventDefault()
    paletteOpen.value = !paletteOpen.value
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div v-if="standalone" class="h-full overflow-hidden bg-background text-foreground">
    <RouterView />
    <Toaster />
    <PromptHost />
  </div>
  <div v-else class="flex h-full flex-col overflow-hidden bg-background text-foreground">
    <TopBar />
    <div class="flex min-h-0 flex-1">
      <SideBar />
      <main class="min-w-0 flex-1 overflow-y-auto scroll-slim">
        <RouterView v-slot="{ Component }">
          <Transition name="omni-view" mode="out-in">
            <component :is="Component" />
          </Transition>
        </RouterView>
        <!-- Room for the floating task queue at the end of every page. -->
        <div v-if="tasks.length" class="h-16" aria-hidden="true" />
      </main>
    </div>
    <TaskDock />
    <Toaster />
    <CommandPalette />
    <PromptHost />
    <MobileNav />
  </div>
</template>

<style>
.omni-view-enter-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s cubic-bezier(0.22, 1, 0.36, 1);
}
.omni-view-leave-active {
  transition: opacity 0.1s ease;
}
.omni-view-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.omni-view-leave-to {
  opacity: 0;
}
</style>
