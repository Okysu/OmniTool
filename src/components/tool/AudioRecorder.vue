<script setup lang="ts">
/**
 * Microphone recording, drawn by the host.
 *
 * The permission prompt, the stream and the encoder all live here, on the main
 * thread: a plugin never asks for the microphone and never sees the stream. It
 * receives the finished recording as an ordinary workspace file, exactly like a
 * dropped one, so no tool needs to know it was recorded.
 *
 * Nothing is saved until the user listens back and confirms; cancelling
 * discards the audio and releases the device.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import * as vfs from '@/core/vfs'
import { pushToast } from '@/core/ui/toast'
import { extensionForMime, formatDuration, microphoneError, peakLevel, pickRecorderFormat, recordingName } from '@/lib/recording'
import { formatBytes } from '@/lib/format'

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ recorded: [id: string] }>()

/** Long recordings are fine, but not unbounded: the audio is held in memory until saved. */
const MAX_MS = 2 * 60 * 60 * 1000

type Phase = 'idle' | 'starting' | 'recording' | 'paused' | 'review'

const phase = ref<Phase>('idle')
const error = ref('')
const elapsed = ref(0)
const level = ref(0)
const bytes = ref(0)
const devices = ref<MediaDeviceInfo[]>([])
/** `default` rather than an empty string: Select items must carry a non-empty value. */
const deviceId = ref('default')
const previewUrl = ref('')

let stream: MediaStream | null = null
let recorder: MediaRecorder | null = null
let chunks: Blob[] = []
let audioContext: AudioContext | null = null
let analyser: AnalyserNode | null = null
let meterFrame = 0
let ticker: ReturnType<typeof setInterval> | null = null
let startedAt = 0
let accumulated = 0
let recorded: Blob | null = null

const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'
const format = computed(() => (supported ? pickRecorderFormat((type) => MediaRecorder.isTypeSupported(type)) : null))
const busy = computed(() => phase.value === 'recording' || phase.value === 'paused')

function stopMeter() {
  if (meterFrame) cancelAnimationFrame(meterFrame)
  meterFrame = 0
  level.value = 0
}

/** Releases the microphone: the browser's recording indicator must go away when we are done. */
function release() {
  stopMeter()
  if (ticker) clearInterval(ticker)
  ticker = null
  analyser = null
  void audioContext?.close().catch(() => {})
  audioContext = null
  for (const track of stream?.getTracks() ?? []) track.stop()
  stream = null
  if (recorder && recorder.state !== 'inactive') recorder.stop()
  recorder = null
}

function reset() {
  release()
  chunks = []
  recorded = null
  accumulated = 0
  elapsed.value = 0
  bytes.value = 0
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = ''
  phase.value = 'idle'
}

function meter() {
  if (!analyser) return
  const samples = new Uint8Array(analyser.fftSize)
  analyser.getByteTimeDomainData(samples)
  const peak = peakLevel(samples)
  // Fall back slowly so the bar reads like a VU meter instead of flickering.
  level.value = Math.max(peak, level.value * 0.82)
  meterFrame = requestAnimationFrame(meter)
}

async function listDevices() {
  try {
    devices.value = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
  } catch {
    devices.value = []
  }
}

async function start() {
  if (!supported) return
  error.value = ''
  phase.value = 'starting'
  try {
    const chosen = deviceId.value && deviceId.value !== 'default' ? { deviceId: { exact: deviceId.value } } : true
    stream = await navigator.mediaDevices.getUserMedia({ audio: chosen })
  } catch (err) {
    error.value = microphoneError(err)
    phase.value = 'idle'
    return
  }
  await listDevices()
  if (deviceId.value === 'default') deviceId.value = stream.getAudioTracks()[0]?.getSettings().deviceId || 'default'

  audioContext = new AudioContext()
  analyser = audioContext.createAnalyser()
  analyser.fftSize = 1024
  audioContext.createMediaStreamSource(stream).connect(analyser)
  meter()

  chunks = []
  bytes.value = 0
  accumulated = 0
  recorder = new MediaRecorder(stream, format.value?.mimeType ? { mimeType: format.value.mimeType } : undefined)
  recorder.ondataavailable = (event) => {
    if (event.data.size === 0) return
    chunks.push(event.data)
    bytes.value += event.data.size
  }
  recorder.onstop = () => {
    const type = recorder?.mimeType || format.value?.mimeType || 'audio/webm'
    recorded = new Blob(chunks, { type: type.split(';')[0] })
    if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
    previewUrl.value = URL.createObjectURL(recorded)
    phase.value = 'review'
    release()
  }
  recorder.start(1000)
  startedAt = Date.now()
  phase.value = 'recording'
  ticker = setInterval(() => {
    if (phase.value === 'recording') elapsed.value = accumulated + (Date.now() - startedAt)
    if (elapsed.value >= MAX_MS) {
      pushToast({ level: 'warn', message: `录音已达到 ${MAX_MS / 3600000} 小时上限，已自动停止` })
      stop()
    }
  }, 200)
}

function pause() {
  if (recorder?.state !== 'recording') return
  recorder.pause()
  accumulated += Date.now() - startedAt
  phase.value = 'paused'
}

function resume() {
  if (recorder?.state !== 'paused') return
  recorder.resume()
  startedAt = Date.now()
  phase.value = 'recording'
}

function stop() {
  if (!recorder || recorder.state === 'inactive') return
  if (phase.value === 'recording') accumulated += Date.now() - startedAt
  elapsed.value = accumulated
  stopMeter()
  recorder.stop()
}

async function save() {
  if (!recorded) return
  try {
    const name = recordingName(extensionForMime(recorded.type, format.value?.extension ?? 'webm'))
    const entry = await vfs.writeAll(name, recorded, recorded.type || 'audio/webm')
    emit('recorded', entry.id)
    pushToast({ level: 'success', message: `已保存 ${name}（${formatDuration(elapsed.value)}）` })
    open.value = false
  } catch (err) {
    error.value = `保存失败：${err instanceof Error ? err.message : String(err)}`
  }
}

watch(open, (value) => {
  if (value) {
    error.value = supported ? '' : '当前浏览器不支持录音（需要 MediaRecorder，且页面必须在 https 或 localhost 下打开）。'
    void listDevices()
  } else {
    reset()
  }
})

onBeforeUnmount(reset)
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md" data-audio-recorder>
      <DialogHeader>
        <DialogTitle>录音</DialogTitle>
        <DialogDescription>
          麦克风由 OmniTool 直接调用，录音保存在本机工作区后再交给工具；插件全程接触不到麦克风。
        </DialogDescription>
      </DialogHeader>

      <div v-if="error" class="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5">
        <Icon name="circle-alert" :size="15" class="mt-0.5 shrink-0 text-destructive" />
        <p class="text-xs leading-relaxed">{{ error }}</p>
      </div>

      <div v-if="devices.length > 1 || phase === 'idle'" class="space-y-1.5">
        <Label for="recorder-device" class="text-xs">麦克风</Label>
        <Select v-model="deviceId" :disabled="busy">
          <SelectTrigger id="recorder-device" class="w-full">
            <SelectValue placeholder="默认设备" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">默认设备</SelectItem>
            <SelectItem v-for="device in devices" :key="device.deviceId" :value="device.deviceId">
              {{ device.label || '麦克风' }}
            </SelectItem>
          </SelectContent>
        </Select>
        <p v-if="devices.length === 0" class="text-[11px] text-muted-foreground">开始录音后才能看到设备名称（浏览器在授权前不提供）。</p>
      </div>

      <!-- Level meter and clock -->
      <div class="rounded-xl border border-border bg-card p-4">
        <div class="flex items-center gap-3">
          <span
            class="flex size-9 shrink-0 items-center justify-center rounded-full transition-colors"
            :class="phase === 'recording' ? 'bg-destructive/15 text-destructive' : 'bg-muted text-muted-foreground'"
          >
            <Icon :name="phase === 'recording' ? 'waves' : phase === 'review' ? 'circle-check' : 'volume'" :size="17" :class="phase === 'recording' ? 'animate-pulse' : ''" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="font-mono text-lg tabular-nums" data-recorder-time>{{ formatDuration(elapsed) }}</p>
            <p class="text-[11px] text-muted-foreground">
              {{ phase === 'recording' ? '录音中' : phase === 'paused' ? '已暂停' : phase === 'review' ? '试听后保存' : phase === 'starting' ? '正在请求麦克风…' : '准备就绪' }}
              <template v-if="bytes"> · {{ formatBytes(bytes) }}</template>
              <template v-if="format"> · {{ format.label }}</template>
            </p>
          </div>
        </div>
        <div class="mt-3 h-2 overflow-hidden rounded-full bg-muted" role="presentation">
          <div
            class="h-full rounded-full transition-[width] duration-75"
            :class="level > 0.92 ? 'bg-destructive' : 'bg-primary'"
            :style="{ width: `${Math.round(level * 100)}%` }"
          />
        </div>
      </div>

      <audio v-if="previewUrl" :src="previewUrl" controls class="w-full" />

      <DialogFooter class="gap-2 sm:justify-between">
        <Button variant="ghost" size="sm" @click="open = false">取消</Button>
        <div class="flex gap-2">
          <Button v-if="phase === 'idle' || phase === 'starting'" size="sm" :disabled="!supported || phase === 'starting'" data-recorder-start @click="start">
            <Icon name="play" :size="14" />
            开始录音
          </Button>
          <template v-if="phase === 'recording' || phase === 'paused'">
            <Button variant="outline" size="sm" @click="phase === 'recording' ? pause() : resume()">
              <Icon :name="phase === 'recording' ? 'pause' : 'play'" :size="14" />
              {{ phase === 'recording' ? '暂停' : '继续' }}
            </Button>
            <Button size="sm" data-recorder-stop @click="stop">
              <Icon name="circle-check" :size="14" />
              完成
            </Button>
          </template>
          <template v-if="phase === 'review'">
            <Button variant="outline" size="sm" data-recorder-again @click="reset">
              <Icon name="refresh" :size="14" />
              重录
            </Button>
            <Button size="sm" data-recorder-save @click="save">
              <Icon name="check" :size="14" />
              保存并使用
            </Button>
          </template>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
