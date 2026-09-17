<script setup lang="ts">
/**
 * Desktop navigation rail (md and up). Phones get the same content in
 * `MobileNav`, a drawer opened from the top bar.
 */
import { ref, watch } from 'vue'
import SideNav from './SideNav.vue'

const COLLAPSE_KEY = 'omnitool.sidebar.collapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch {
    return false
  }
}

const collapsed = ref(readCollapsed())
watch(collapsed, (value) => {
  try {
    localStorage.setItem(COLLAPSE_KEY, value ? '1' : '0')
  } catch {
    /* private mode */
  }
})
</script>

<template>
  <aside
    class="relative hidden shrink-0 border-r border-border bg-card/40 transition-[width] duration-200 md:block"
    :class="collapsed ? 'w-14' : 'w-60'"
  >
    <SideNav :collapsed="collapsed" @toggle-collapse="collapsed = !collapsed" />
  </aside>
</template>
