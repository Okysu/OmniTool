/**
 * Microphone recording helpers, kept out of the component so they can be tested.
 *
 * The container is whatever the engine can actually produce: Chromium and
 * Firefox record Opus in WebM, Safari records AAC in MP4. Both are `audio/*`,
 * which is what every audio tool accepts, so a recording is an ordinary input
 * file - plugins never see the microphone, only the file the host hands them.
 */

export interface RecorderFormat {
  /** Passed to `MediaRecorder`; empty means "let the engine choose". */
  mimeType: string
  extension: string
  label: string
}

/** Most preferred first. */
const FORMATS: RecorderFormat[] = [
  { mimeType: 'audio/webm;codecs=opus', extension: 'webm', label: 'WebM / Opus' },
  { mimeType: 'audio/ogg;codecs=opus', extension: 'ogg', label: 'Ogg / Opus' },
  { mimeType: 'audio/webm', extension: 'webm', label: 'WebM' },
  { mimeType: 'audio/mp4;codecs=mp4a.40.2', extension: 'm4a', label: 'MP4 / AAC' },
  { mimeType: 'audio/mp4', extension: 'm4a', label: 'MP4' },
]

/** The first format this engine supports, or `null` when none of them is. */
export function pickRecorderFormat(isSupported: (type: string) => boolean): RecorderFormat | null {
  return FORMATS.find((format) => isSupported(format.mimeType)) ?? null
}

/** Extension for what `MediaRecorder` actually produced, which may differ from what was asked for. */
export function extensionForMime(mimeType: string, fallback = 'webm'): string {
  const base = mimeType.split(';')[0].trim().toLowerCase()
  const known: Record<string, string> = {
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/aac': 'aac',
    'audio/flac': 'flac',
  }
  return known[base] ?? fallback
}

/** `录音-20260920-153045.webm`: sortable, and unique per second. */
export function recordingName(extension: string, at = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  return `录音-${stamp}.${extension}`
}

/** `m:ss` under an hour, `h:mm:ss` beyond it. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const pad = (value: number) => String(value).padStart(2, '0')
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

/** Human explanation for a `getUserMedia` rejection. */
export function microphoneError(error: unknown): string {
  const name = (error as { name?: string } | null)?.name ?? ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return '浏览器拒绝了麦克风权限。请在地址栏的权限图标中允许使用麦克风，然后重试。'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '没有找到可用的麦克风设备。'
  if (name === 'NotReadableError') return '麦克风被其他程序占用，无法读取。'
  return `无法访问麦克风：${error instanceof Error ? error.message : String(error)}`
}

/** Peak level 0-1 of a byte time-domain buffer, for the level meter. */
export function peakLevel(samples: Uint8Array): number {
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const deviation = Math.abs(samples[i] - 128) / 128
    if (deviation > peak) peak = deviation
  }
  return Math.min(1, peak)
}
