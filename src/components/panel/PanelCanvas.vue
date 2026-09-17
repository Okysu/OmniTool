<script setup lang="ts">
/**
 * A drawing surface handed to a plugin.
 *
 * On mount the canvas is sized to its box (times devicePixelRatio, so plugins
 * draw crisp pixels) and its control is transferred into the sandbox as an
 * OffscreenCanvas. From then on only the plugin can draw it; the host keeps the
 * element purely for layout and to forward pointer input in canvas pixel space.
 *
 * The size is fixed at transfer time: a transferred canvas cannot be resized
 * from this side. A plugin that needs a different size re-renders the node.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{ canvasId: string; aspect?: number; height?: number; interactive?: boolean }>()

const emit = defineEmits<{
  ready: [canvas: OffscreenCanvas, width: number, height: number]
  pointer: [event: Record<string, number | string>]
}>()

const element = ref<HTMLCanvasElement | null>(null)
let frame = 0
let pendingMove: PointerEvent | null = null

onMounted(() => {
  const canvas = element.value
  if (!canvas || typeof canvas.transferControlToOffscreen !== 'function') return
  const box = canvas.getBoundingClientRect()
  const ratio = Math.min(2, window.devicePixelRatio || 1)
  canvas.width = Math.max(1, Math.round(box.width * ratio))
  canvas.height = Math.max(1, Math.round(box.height * ratio))
  emit('ready', canvas.transferControlToOffscreen(), canvas.width, canvas.height)
})

onBeforeUnmount(() => cancelAnimationFrame(frame))

function toCanvasSpace(event: PointerEvent): Record<string, number | string> {
  const canvas = element.value!
  const box = canvas.getBoundingClientRect()
  return {
    type: event.type.replace('pointer', ''),
    x: Math.round(((event.clientX - box.left) / box.width) * canvas.width),
    y: Math.round(((event.clientY - box.top) / box.height) * canvas.height),
    buttons: event.buttons,
  }
}

function onPointer(event: PointerEvent) {
  if (!props.interactive) return
  if (event.type === 'pointerdown') element.value?.setPointerCapture(event.pointerId)
  if (event.type !== 'pointermove') {
    emit('pointer', toCanvasSpace(event))
    return
  }
  // Coalesce moves to one per frame; a drag must not flood the sandbox.
  pendingMove = event
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    if (pendingMove) emit('pointer', toCanvasSpace(pendingMove))
    pendingMove = null
  })
}
</script>

<template>
  <canvas
    ref="element"
    class="block w-full rounded-lg border border-border bg-muted/40"
    :class="interactive ? 'cursor-crosshair touch-none' : ''"
    :style="height ? { height: `${height}px` } : { aspectRatio: String(aspect ?? 16 / 9) }"
    @pointerdown="onPointer"
    @pointermove="onPointer"
    @pointerup="onPointer"
  />
</template>
