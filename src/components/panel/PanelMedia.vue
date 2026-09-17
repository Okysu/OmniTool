<script setup lang="ts">
/**
 * Visual media editor, driven entirely by panel state.
 *
 * A plugin describes which parts of its state the widget edits or previews, by
 * key, and the host does all the pixel and audio work:
 *
 *   range    [start, end] seconds          two-handle selection on the strip
 *   crop     [x, y, w, h] fractions (0–1)  draggable box over the frame; [] hides it
 *   cropAspect  number (px ratio, 0=free)  constrains the crop box
 *   markers  number[] seconds              "mark current frame" chips and ticks
 *   meta     ← [duration, width, height]   written by the widget once media loads
 *
 * The source may also be an image (e.g. a rendered PDF page): the box then
 * places something on it, and the player controls are simply not shown.
 *   effects  { rotate, flipH, … }          live preview of what the tool will render
 *
 * Crop fractions rather than pixels make one selection valid for a batch of
 * files at different resolutions (`crop=iw*w:ih*h:iw*x:ih*y` in ffmpeg).
 *
 * Previews are approximations with browser primitives - CSS transforms and
 * filters for the picture, a Web Audio gain stage for volume and fades,
 * `playbackRate` (pitch-preserving, like ffmpeg's `atempo`) for speed. The
 * export is always ffmpeg, so the panel says so instead of promising exactness.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import type { UiEffects, UiState, UiValue } from '@/core/ui/schema'
import * as vfs from '@/core/vfs'

const props = defineProps<{
  fileId: string
  state: UiState
  range?: string
  crop?: string
  cropAspect?: string
  markers?: string
  meta?: string
  effects?: UiEffects
  height?: number
}>()

const emit = defineEmits<{ change: [key: string, value: UiValue] }>()

/* ------------------------------------------------------------------------ */
/* Source                                                                   */
/* ------------------------------------------------------------------------ */

/** Waveform decode ceiling; above this the strip is omitted rather than risking the tab. */
const WAVEFORM_LIMIT = 200 * 1024 * 1024

const media = ref<HTMLVideoElement | HTMLAudioElement | null>(null)
const stage = ref<HTMLDivElement | null>(null)
const waveform = ref<HTMLCanvasElement | null>(null)
const url = ref('')
const duration = ref(0)
const natural = reactive({ width: 0, height: 0 })
const current = ref(0)
const playing = ref(false)
const playingSelection = ref(false)

const entry = computed(() => vfs.get(props.fileId))
const isImage = computed(() => {
  const file = entry.value
  return !!file && (file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(file.name))
})
const isVideo = computed(() => {
  const file = entry.value
  if (!file) return false
  return file.type.startsWith('video/') || (!file.type.startsWith('audio/') && /\.(mp4|mkv|mov|webm|avi|m4v|ts|flv)$/i.test(file.name))
})

watch(
  () => props.fileId,
  async (id) => {
    url.value = id && vfs.get(id) ? await vfs.objectUrl(id) : ''
    if (!isImage.value) void drawWaveform()
  },
  { immediate: true },
)

function onLoaded() {
  const el = media.value
  if (!el || !Number.isFinite(el.duration)) return
  duration.value = el.duration
  if (el instanceof HTMLVideoElement) {
    natural.width = el.videoWidth
    natural.height = el.videoHeight
  }
  if (props.meta) emit('change', props.meta, [round(el.duration), natural.width, natural.height])
  // An untouched selection means "all of it".
  if (props.range && rawRange.value.length < 2) emit('change', props.range, [0, round(el.duration)])
  measure()
}

function onImageLoaded(event: Event) {
  const img = event.target as HTMLImageElement
  natural.width = img.naturalWidth
  natural.height = img.naturalHeight
  if (props.meta) emit('change', props.meta, [0, natural.width, natural.height])
  measure()
}

/* ------------------------------------------------------------------------ */
/* Bound state helpers                                                      */
/* ------------------------------------------------------------------------ */

function numberAt(key: string | undefined): number[] {
  const value = key ? props.state[key] : undefined
  return Array.isArray(value) ? value : []
}

function effect(name: keyof UiEffects, fallback: number): number
function effect(name: keyof UiEffects, fallback: boolean): boolean
function effect(name: keyof UiEffects, fallback: number | boolean): number | boolean {
  const spec = props.effects?.[name]
  if (!spec) return fallback
  const value = props.state[spec.bind]
  if (typeof fallback === 'boolean') return Boolean(value)
  const n = Number(value)
  return Number.isFinite(n) ? n * (spec.scale ?? 1) : fallback
}

const rawRange = computed(() => numberAt(props.range))
const range = computed<[number, number]>(() => {
  if (!props.range) return [0, duration.value]
  const [start = 0, end = duration.value] = rawRange.value
  const max = duration.value || end
  return [Math.max(0, Math.min(start, max)), Math.max(start, Math.min(end || max, max))]
})

/* ------------------------------------------------------------------------ */
/* Stage geometry                                                           */
/* ------------------------------------------------------------------------ */

const stageWidth = ref(0)
const stageHeight = computed(() => Math.max(160, Math.min(props.height ?? 320, 640)))
let observer: ResizeObserver | null = null

function measure() {
  if (stage.value) stageWidth.value = stage.value.clientWidth
}

onMounted(() => {
  observer = new ResizeObserver(measure)
  if (stage.value) observer.observe(stage.value)
  measure()
})

const rotation = computed(() => ((Math.round(effect('rotate', 0) / 90) * 90) % 360 + 360) % 360)
const flipH = computed(() => effect('flipH', false))
const flipV = computed(() => effect('flipV', false))
const sideways = computed(() => rotation.value === 90 || rotation.value === 270)

/** Size of the untransformed video box, fitted so its rotated footprint fills the stage. */
const frame = computed(() => {
  const w = natural.width || 16
  const h = natural.height || 9
  const footW = sideways.value ? h : w
  const footH = sideways.value ? w : h
  const scale = Math.min(stageWidth.value / footW, stageHeight.value / footH) || 0
  return { width: w * scale, height: h * scale }
})

const frameStyle = computed(() => {
  const filters = []
  const brightness = effect('brightness', 0)
  const contrast = effect('contrast', 1)
  const saturation = effect('saturation', 1)
  const hue = effect('hue', 0)
  // ffmpeg's eq brightness is additive (-1..1); CSS brightness multiplies. Close enough to judge.
  if (brightness) filters.push(`brightness(${Math.max(0, 1 + brightness)})`)
  if (contrast !== 1) filters.push(`contrast(${Math.max(0, contrast)})`)
  if (saturation !== 1) filters.push(`saturate(${Math.max(0, saturation)})`)
  if (hue) filters.push(`hue-rotate(${hue}deg)`)
  return {
    width: `${frame.value.width}px`,
    height: `${frame.value.height}px`,
    transform: `translate(-50%, -50%) rotate(${rotation.value}deg) scale(${flipH.value ? -1 : 1}, ${flipV.value ? -1 : 1})`,
    filter: filters.join(' ') || undefined,
  }
})

/* ------------------------------------------------------------------------ */
/* Crop                                                                     */
/* ------------------------------------------------------------------------ */

type Box = [number, number, number, number]
const MIN_CROP = 0.02

/** Live box while dragging; committed to state on release so a drag is one change event. */
const draft = ref<Box | null>(null)

const committedCrop = computed<Box | null>(() => {
  const value = numberAt(props.crop)
  if (value.length !== 4) return null
  return clampBox(value as Box)
})
const cropBox = computed(() => draft.value ?? committedCrop.value)

const aspect = computed(() => {
  if (!props.cropAspect) return 0
  const n = Number(props.state[props.cropAspect])
  return Number.isFinite(n) && n > 0 ? n : 0
})

function clampBox([x, y, w, h]: Box): Box {
  w = Math.min(1, Math.max(MIN_CROP, w))
  h = Math.min(1, Math.max(MIN_CROP, h))
  return [Math.min(1 - w, Math.max(0, x)), Math.min(1 - h, Math.max(0, y)), w, h]
}

/** Largest box of the pixel ratio `ratio` centred on `box`'s centre that fits the frame. */
function fitAspect(box: Box, ratio: number): Box {
  if (!ratio || !natural.width || !natural.height) return box
  const cx = box[0] + box[2] / 2
  const cy = box[1] + box[3] / 2
  // Fraction-space ratio: w/h in fractions equals ratio * (H/W) in pixels.
  const fr = (ratio * natural.height) / natural.width
  let w = box[2]
  let h = w / fr
  if (h > box[3]) {
    h = box[3]
    w = h * fr
  }
  if (w > 1) (w = 1), (h = 1 / fr)
  if (h > 1) (h = 1), (w = fr)
  return clampBox([cx - w / 2, cy - h / 2, w, h])
}

watch(aspect, (ratio) => {
  const box = committedCrop.value
  if (props.crop && box && ratio) emit('change', props.crop, fitAspect([0, 0, 1, 1], ratio).map(round4))
})

type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const HANDLES: Exclude<Handle, 'move'>[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
let drag: { handle: Handle; start: Box; x: number; y: number } | null = null

/** Screen-space delta → fraction-space delta, undoing rotate and flip. */
function toLocal(dx: number, dy: number): [number, number] {
  const a = (-rotation.value * Math.PI) / 180
  let lx = dx * Math.cos(a) - dy * Math.sin(a)
  let ly = dx * Math.sin(a) + dy * Math.cos(a)
  if (flipH.value) lx = -lx
  if (flipV.value) ly = -ly
  return [lx / (frame.value.width || 1), ly / (frame.value.height || 1)]
}

function startDrag(handle: Handle, event: PointerEvent) {
  const box = cropBox.value
  if (!box) return
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  drag = { handle, start: [...box] as Box, x: event.clientX, y: event.clientY }
  draft.value = [...box] as Box
}

function moveDrag(event: PointerEvent) {
  if (!drag) return
  const [dx, dy] = toLocal(event.clientX - drag.x, event.clientY - drag.y)
  let [x, y, w, h] = drag.start
  const handle = drag.handle
  if (handle === 'move') {
    draft.value = clampBox([x + dx, y + dy, w, h])
    return
  }
  if (handle.includes('w')) (x += dx), (w -= dx)
  if (handle.includes('e')) w += dx
  if (handle.includes('n')) (y += dy), (h -= dy)
  if (handle.includes('s')) h += dy
  // Keep the opposite edge anchored when a size limit is hit.
  if (w < MIN_CROP) (x -= handle.includes('w') ? MIN_CROP - w : 0), (w = MIN_CROP)
  if (h < MIN_CROP) (y -= handle.includes('n') ? MIN_CROP - h : 0), (h = MIN_CROP)
  if (x < 0) (w += x), (x = 0)
  if (y < 0) (h += y), (y = 0)
  w = Math.min(w, 1 - x)
  h = Math.min(h, 1 - y)

  if (aspect.value && natural.width && natural.height) {
    const fr = (aspect.value * natural.height) / natural.width
    // Edge handles drive the other dimension; corners follow the wider change.
    if (handle === 'n' || handle === 's') w = h * fr
    else h = w / fr
    if (x + w > 1) (w = 1 - x), (h = w / fr)
    if (y + h > 1) (h = 1 - y), (w = h * fr)
    if (handle.includes('n')) y = drag.start[1] + drag.start[3] - h
    if (handle.includes('w')) x = drag.start[0] + drag.start[2] - w
  }
  draft.value = clampBox([x, y, w, h])
}

function endDrag() {
  if (!drag) return
  drag = null
  if (props.crop && draft.value) emit('change', props.crop, draft.value.map(round4))
  draft.value = null
}

function nudge(event: KeyboardEvent) {
  const box = committedCrop.value
  if (!props.crop || !box) return
  const step = (event.shiftKey ? 10 : 1) / Math.max(natural.width, natural.height, 100)
  const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
  const d = delta[event.key]
  if (!d) return
  event.preventDefault()
  emit('change', props.crop, clampBox([box[0] + d[0], box[1] + d[1], box[2], box[3]]).map(round4))
}

const cropPixels = computed(() => {
  const box = cropBox.value
  if (!box || !natural.width) return ''
  return `${Math.round(box[2] * natural.width)} × ${Math.round(box[3] * natural.height)}`
})

function handleStyle(handle: Exclude<Handle, 'move'>) {
  const left = handle.includes('w') ? '0%' : handle.includes('e') ? '100%' : '50%'
  const top = handle.includes('n') ? '0%' : handle.includes('s') ? '100%' : '50%'
  const cursor = { n: 'ns', s: 'ns', e: 'ew', w: 'ew', ne: 'nesw', sw: 'nesw', nw: 'nwse', se: 'nwse' }[handle]
  return { left, top, cursor: `${cursor}-resize` }
}

/* ------------------------------------------------------------------------ */
/* Playback and audio preview                                               */
/* ------------------------------------------------------------------------ */

const speed = computed(() => Math.min(16, Math.max(0.0625, effect('speed', 1))))
const volume = computed(() => Math.max(0, effect('volume', 1)))
const muted = computed(() => effect('mute', false))
const fadeIn = computed(() => Math.max(0, effect('fadeIn', 0)))
const fadeOut = computed(() => Math.max(0, effect('fadeOut', 0)))
const hasAudioEffects = computed(() => Boolean(props.effects?.volume || props.effects?.fadeIn || props.effects?.fadeOut))

watch(speed, (rate) => {
  if (media.value) media.value.playbackRate = rate
})

let audio: { context: AudioContext; gain: GainNode } | null = null
let raf = 0

/** Gain at media time `t`: volume shaped by fades measured from the selection's edges. */
function gainAt(t: number): number {
  if (muted.value) return 0
  const [start, end] = range.value
  let g = volume.value
  if (fadeIn.value > 0 && t < start + fadeIn.value) g *= Math.max(0, (t - start) / fadeIn.value)
  if (fadeOut.value > 0 && t > end - fadeOut.value) g *= Math.max(0, (end - t) / fadeOut.value)
  return g
}

function ensureAudioGraph() {
  const el = media.value
  // Only route through Web Audio when something needs it: it takes over the
  // element's output for good, and volume > 100% is impossible without it.
  if (audio || !el || !hasAudioEffects.value) return
  try {
    const context = new AudioContext()
    const source = context.createMediaElementSource(el)
    const gain = context.createGain()
    source.connect(gain).connect(context.destination)
    audio = { context, gain }
  } catch {
    audio = null
  }
}

function tick() {
  const el = media.value
  if (!el) return
  current.value = el.currentTime
  if (audio) audio.gain.gain.setTargetAtTime(gainAt(el.currentTime), audio.context.currentTime, 0.01)
  if (playingSelection.value && el.currentTime >= range.value[1]) {
    el.pause()
    playingSelection.value = false
  }
  if (!el.paused) raf = requestAnimationFrame(tick)
}

async function play(fromSelection = false) {
  const el = media.value
  if (!el) return
  ensureAudioGraph()
  await audio?.context.resume()
  el.muted = !audio && muted.value
  el.playbackRate = speed.value
  if (fromSelection) {
    el.currentTime = range.value[0]
    playingSelection.value = true
  }
  await el.play().catch(() => (playingSelection.value = false))
}

function togglePlay() {
  const el = media.value
  if (!el) return
  if (el.paused) void play()
  else el.pause()
}

function onPlay() {
  playing.value = true
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(tick)
}

function onPause() {
  playing.value = false
  playingSelection.value = false
  cancelAnimationFrame(raf)
  if (media.value) current.value = media.value.currentTime
}

function seek(seconds: number) {
  const el = media.value
  if (!el || !duration.value) return
  el.currentTime = Math.max(0, Math.min(duration.value, seconds))
  current.value = el.currentTime
}

function seekStrip(event: PointerEvent) {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
  seek(((event.clientX - box.left) / box.width) * duration.value)
}

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  observer?.disconnect()
  media.value?.pause()
  void audio?.context.close()
})

/* ------------------------------------------------------------------------ */
/* Range and markers                                                        */
/* ------------------------------------------------------------------------ */

function setRange(value: number[] | undefined) {
  if (!props.range || !value || value.length < 2) return
  const next = [round(Math.min(value[0], value[1])), round(Math.max(value[0], value[1]))]
  // Follow whichever handle moved, so the frame on screen is the cut point.
  if (Math.abs(next[0] - range.value[0]) > 0.01) seek(next[0])
  else if (Math.abs(next[1] - range.value[1]) > 0.01) seek(next[1])
  emit('change', props.range, next)
}

function markStart() {
  if (props.range) emit('change', props.range, [round(Math.min(current.value, range.value[1])), round(range.value[1])])
}

function markEnd() {
  if (props.range) emit('change', props.range, [round(range.value[0]), round(Math.max(current.value, range.value[0]))])
}

const MAX_MARKERS = 64
const markerList = computed(() => numberAt(props.markers))

function addMarker() {
  if (!props.markers) return
  const t = round(current.value)
  if (markerList.value.some((m) => Math.abs(m - t) < 0.05) || markerList.value.length >= MAX_MARKERS) return
  emit('change', props.markers, [...markerList.value, t].sort((a, b) => a - b))
}

function removeMarker(index: number) {
  if (props.markers) emit('change', props.markers, markerList.value.filter((_, i) => i !== index))
}

/* ------------------------------------------------------------------------ */
/* Strip drawing                                                            */
/* ------------------------------------------------------------------------ */

async function drawWaveform() {
  const canvas = waveform.value
  const file = entry.value
  if (!canvas || !file || file.size > WAVEFORM_LIMIT) return
  try {
    const bytes = await (await vfs.blob(file.id)).arrayBuffer()
    const context = new OfflineAudioContext(1, 1, 8000)
    const decoded = await context.decodeAudioData(bytes)
    const data = decoded.getChannelData(0)

    const ratio = Math.min(2, window.devicePixelRatio || 1)
    const width = Math.round(canvas.clientWidth * ratio)
    const height = Math.round(canvas.clientHeight * ratio)
    canvas.width = width
    canvas.height = height

    const g = canvas.getContext('2d')!
    g.clearRect(0, 0, width, height)
    g.fillStyle = getComputedStyle(canvas).color
    const step = Math.max(1, Math.floor(data.length / width))
    for (let x = 0; x < width; x++) {
      let peak = 0
      for (let i = x * step; i < Math.min(data.length, (x + 1) * step); i++) peak = Math.max(peak, Math.abs(data[i]))
      const bar = Math.max(1, peak * height)
      g.fillRect(x, (height - bar) / 2, 1, bar)
    }
  } catch {
    // No audio track, or a codec the browser cannot decode: the strip still
    // works for seeking and selection, just without the waveform.
  }
}

const pct = (seconds: number) => (duration.value > 0 ? `${(seconds / duration.value) * 100}%` : '0%')

/**
 * Gain envelope over the strip, in a 1000×100 viewBox. 100% volume sits at mid
 * height so boosts up to 200% stay visible.
 */
const envelope = computed(() => {
  if (!hasAudioEffects.value || duration.value <= 0) return ''
  const [start, end] = range.value
  const x = (t: number) => ((t / duration.value) * 1000).toFixed(1)
  const y = (g: number) => (100 - Math.min(2, g) * 50).toFixed(1)
  const points: Array<[number, number]> = [[start, gainAt(start)]]
  if (fadeIn.value > 0) points.push([Math.min(end, start + fadeIn.value), gainAt(Math.min(end, start + fadeIn.value))])
  if (fadeOut.value > 0) points.push([Math.max(start, end - fadeOut.value), gainAt(Math.max(start, end - fadeOut.value))])
  points.push([end, gainAt(end)])
  return points.map(([t, g]) => `${x(t)},${y(g)}`).join(' ')
})

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

function clock(seconds: number): string {
  if (!Number.isFinite(seconds)) return '--:--'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const ss = (seconds % 60).toFixed(2).padStart(5, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`
}

/** Shown only while an approximated effect is actually in play. */
const previewNote = computed(
  () =>
    effect('brightness', 0) !== 0 ||
    effect('contrast', 1) !== 1 ||
    effect('saturation', 1) !== 1 ||
    effect('hue', 0) !== 0 ||
    speed.value !== 1 ||
    volume.value !== 1 ||
    fadeIn.value > 0 ||
    fadeOut.value > 0,
)
</script>

<template>
  <div class="space-y-2.5">
    <!-- Stage: the video with its transforms, filters and crop box -->
    <div
      v-if="isVideo || isImage"
      ref="stage"
      class="relative w-full overflow-hidden rounded-lg border border-border bg-black"
      :style="{ height: `min(${stageHeight}px, 55vh)` }"
    >
      <div class="absolute left-1/2 top-1/2" :style="frameStyle">
        <img v-if="isImage" :src="url" alt="" class="block size-full select-none" draggable="false" @load="onImageLoaded" />
        <video
          v-else
          ref="media"
          :src="url"
          class="block size-full"
          preload="metadata"
          playsinline
          @loadedmetadata="onLoaded"
          @play="onPlay"
          @pause="onPause"
          @seeked="current = media?.currentTime ?? 0"
        />
        <div
          v-if="cropBox"
          class="absolute inset-0 touch-none"
          @pointermove="moveDrag"
          @pointerup="endDrag"
          @pointercancel="endDrag"
        >
          <!-- Shade outside the crop with one huge box-shadow. -->
          <div
            class="absolute cursor-move rounded-[1px] shadow-[0_0_0_9999px_rgba(0,0,0,0.55)] outline outline-2 outline-white/90 focus-visible:outline-primary"
            :style="{
              left: `${cropBox[0] * 100}%`,
              top: `${cropBox[1] * 100}%`,
              width: `${cropBox[2] * 100}%`,
              height: `${cropBox[3] * 100}%`,
            }"
            tabindex="0"
            role="group"
            :aria-label="isImage ? '选区，方向键微调，Shift 加速' : '裁切区域，方向键微调，Shift 加速'"
            @pointerdown.prevent="startDrag('move', $event)"
            @keydown="nudge"
          >
            <!-- Rule-of-thirds guides -->
            <div class="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3">
              <div v-for="n in 9" :key="n" class="border border-white/15" />
            </div>
            <button
              v-for="handle in HANDLES"
              :key="handle"
              type="button"
              tabindex="-1"
              :aria-label="`调整 ${handle}`"
              class="absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-black/40 bg-white shadow pointer-coarse:size-6"
              :style="handleStyle(handle)"
              @pointerdown.prevent.stop="startDrag(handle, $event)"
            />
          </div>
        </div>
      </div>
      <span
        v-if="cropBox && cropPixels"
        class="pointer-events-none absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white"
      >
        {{ cropPixels }}
      </span>
    </div>
    <audio
      v-else-if="!isImage"
      ref="media"
      :src="url"
      preload="metadata"
      class="hidden"
      @loadedmetadata="onLoaded"
      @play="onPlay"
      @pause="onPause"
      @seeked="current = media?.currentTime ?? 0"
    />

    <!-- Everything below is about time; an image has none. -->
    <template v-if="!isImage">
    <!-- Transport -->
    <div class="flex items-center gap-2">
      <Button variant="secondary" size="icon-sm" :aria-label="playing ? '暂停' : '播放'" @click="togglePlay">
        <Icon :name="playing ? 'pause' : 'play'" :size="14" />
      </Button>
      <span class="text-xs tabular-nums text-muted-foreground">{{ clock(current) }} / {{ clock(duration) }}</span>
      <span v-if="natural.width" class="hidden text-[11px] tabular-nums text-muted-foreground sm:inline">
        · {{ natural.width }}×{{ natural.height }}
      </span>
      <span v-if="speed !== 1" class="text-[11px] tabular-nums text-primary">{{ speed.toFixed(2) }}×</span>
      <span v-if="previewNote" class="ml-auto hidden text-[11px] text-muted-foreground md:inline">预览为近似效果，以导出结果为准</span>
    </div>

    <!-- Strip: waveform, selection, envelope, markers, playhead. Click to seek. -->
    <div
      class="relative h-14 cursor-pointer overflow-hidden rounded-md bg-muted"
      role="slider"
      aria-label="播放位置"
      :aria-valuemin="0"
      :aria-valuemax="Math.round(duration)"
      :aria-valuenow="Math.round(current)"
      @pointerdown="seekStrip"
    >
      <canvas ref="waveform" class="absolute inset-0 size-full text-muted-foreground/60" />
      <div
        v-if="props.range"
        class="absolute inset-y-0 bg-primary/15 ring-1 ring-primary/50 ring-inset"
        :style="{ left: pct(range[0]), width: pct(range[1] - range[0]) }"
      />
      <svg v-if="envelope" class="pointer-events-none absolute inset-0 size-full" viewBox="0 0 1000 100" preserveAspectRatio="none">
        <line x1="0" x2="1000" y1="50" y2="50" class="stroke-foreground/15" stroke-dasharray="6 6" vector-effect="non-scaling-stroke" />
        <polyline :points="envelope" fill="none" class="stroke-primary" stroke-width="2" vector-effect="non-scaling-stroke" />
      </svg>
      <div
        v-for="(marker, index) in markerList"
        :key="`${marker}-${index}`"
        class="absolute inset-y-0 w-0.5 bg-warning"
        :style="{ left: pct(marker) }"
      />
      <div class="pointer-events-none absolute inset-y-0 w-px bg-foreground/80" :style="{ left: pct(current) }" />
    </div>

    <template v-if="props.range">
      <Slider
        :min="0"
        :max="Math.max(0.01, duration)"
        :step="0.01"
        :model-value="[range[0], range[1]]"
        :min-steps-between-thumbs="1"
        class="py-1"
        @update:model-value="setRange"
      />
      <div class="flex flex-wrap items-center gap-2 text-xs">
        <span class="tabular-nums text-muted-foreground">
          {{ clock(range[0]) }} → {{ clock(range[1]) }}
          <span class="text-foreground">（{{ clock(range[1] - range[0]) }}）</span>
        </span>
        <div class="ml-auto flex flex-wrap gap-1.5">
          <Button variant="outline" size="xs" title="把起点设为当前播放位置" @click="markStart">
            <Icon name="chevron-right" :size="12" />
            设为起点
          </Button>
          <Button variant="outline" size="xs" title="把终点设为当前播放位置" @click="markEnd">设为终点</Button>
          <Button variant="secondary" size="xs" @click="play(true)">
            <Icon name="play" :size="12" />
            播放选区
          </Button>
        </div>
      </div>
    </template>

    <div v-if="props.markers" class="flex flex-wrap items-center gap-1.5">
      <Button variant="outline" size="xs" :disabled="markerList.length >= MAX_MARKERS" @click="addMarker">
        <Icon name="plus" :size="12" />
        标记当前帧
      </Button>
      <span v-if="markerList.length === 0" class="text-[11px] text-muted-foreground">播放或点击波形条定位，然后标记</span>
      <span
        v-for="(marker, index) in markerList"
        :key="`chip-${marker}-${index}`"
        class="inline-flex items-center gap-1 rounded-md border border-border bg-background py-0.5 pl-2 pr-0.5 text-[11px] tabular-nums"
      >
        <button type="button" class="hover:text-primary" :title="`跳转到 ${clock(marker)}`" @click="seek(marker)">
          {{ clock(marker) }}
        </button>
        <button
          type="button"
          class="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-destructive"
          :aria-label="`删除标记 ${clock(marker)}`"
          @click="removeMarker(index)"
        >
          <Icon name="x" :size="11" />
        </button>
      </span>
    </div>
    </template>
  </div>
</template>
