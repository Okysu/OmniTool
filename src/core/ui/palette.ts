import { ref } from 'vue'

/** Global command-palette visibility, so any surface can open it. */
export const paletteOpen = ref(false)

export function openPalette(): void {
  paletteOpen.value = true
}
