import { beforeAll, describe, expect, it } from 'vitest'
import { loadPlugin } from './harness/plugin'

let plugin: ReturnType<typeof loadPlugin>

beforeAll(() => {
  plugin = loadPlugin('src/plugins/builtin/media-tools.js')
})

const clip = { name: 'clip.mp4', content: new Uint8Array(16), type: 'video/mp4' }
const tone = { name: 'tone.m4a', content: new Uint8Array(16), type: 'audio/mp4' }

const EVEN = 'pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p'
/** The value following `flag` in an ffmpeg argument list. */
const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

type Node = { type: string; [key: string]: unknown }
function findNodes(nodes: unknown[], type: string): Node[] {
  const out: Node[] = []
  const walk = (list: unknown[]) => {
    for (const node of list as Node[]) {
      if (node.type === type) out.push(node)
      if (Array.isArray(node.children)) walk(node.children)
    }
  }
  walk(nodes)
  return out
}

describe('video-edit', () => {
  it('crops before rotating and grading, in the order the preview draws', async () => {
    const result = await plugin.run('video-edit', [clip], {
      cropOn: true, crop: [0.125, 0, 0.75, 1], rotate: '90', flipH: true,
      brightness: 10, contrast: 120, saturation: 100, hue: 30, speed: 100, mute: false,
    })
    const vf = argAfter(result.ffmpeg[0].args, '-vf').split(',')
    expect(vf[0]).toBe('crop=trunc(iw*0.7500/2)*2:trunc(ih*1.0000/2)*2:trunc(iw*0.1250):trunc(ih*0.0000)')
    expect(vf.slice(1)).toEqual(['transpose=1', 'hflip', 'eq=brightness=0.100:contrast=1.200', 'hue=h=30', ...EVEN.split(',')])
  })

  it('ignores a stale crop box when cropping is off', async () => {
    const result = await plugin.run('video-edit', [clip], { cropOn: false, crop: [0.1, 0.1, 0.5, 0.5] })
    expect(argAfter(result.ffmpeg[0].args, '-vf')).toBe(EVEN)
  })

  it('trims with an input-side seek and keeps audio in step with speed', async () => {
    const result = await plugin.run('video-edit', [clip], { range: [2, 6], speed: 250 })
    const args = result.ffmpeg[0].args
    expect(args.slice(0, 5)).toEqual(['-ss', '2', '-to', '6', '-i'])
    expect(argAfter(args, '-vf')).toBe('setpts=PTS/2.5000,' + EVEN)
    expect(argAfter(args, '-af')).toBe('atempo=2.0,atempo=1.2500')
  })

  it('applies a range only to a single file, never to a batch', async () => {
    const result = await plugin.run('video-edit', [clip, { ...clip, name: 'b.mp4' }], { range: [2, 6] })
    for (const call of result.ffmpeg) expect(call.args[0]).toBe('-i')
  })

  it('reports output size from crop and rotation in the panel', async () => {
    const panel = await plugin.openPanel('video-edit', [{ name: 'clip.mp4' }])
    await panel.change('meta', [3, 320, 240])
    await panel.change('cropOn', true)
    await panel.change('crop', [0.125, 0, 0.75, 1])
    await panel.change('rotate', '90')
    const facts = findNodes(panel.last().nodes, 'facts')[0].rows as Array<{ label: string; value: string }>
    expect(facts.find((row) => row.label === '输出尺寸')?.value).toBe('240 × 240')
  })

  it('turns an aspect preset into a numeric ratio for the crop widget', async () => {
    const panel = await plugin.openPanel('video-edit', [{ name: 'clip.mp4' }])
    await panel.change('aspectPreset', '9:16')
    expect(panel.state.cropAspect).toBeCloseTo(9 / 16)
    await panel.change('cropOn', true)
    expect(panel.state.crop).toEqual([0.1, 0.1, 0.8, 0.8])
    await panel.change('cropOn', false)
    expect(panel.state.crop).toEqual([])
  })

  it('shows a batch notice and drops the range editor for several files', async () => {
    const panel = await plugin.openPanel('video-edit', [{ name: 'a.mp4' }, { name: 'b.mp4' }])
    const media = findNodes(panel.last().nodes, 'media')[0]
    expect(media.range).toBeUndefined()
    expect(findNodes(panel.last().nodes, 'alert')[0].text).toContain('2 个视频')
  })
})

describe('missing or mistyped parameters', () => {
  it('fall back to the panel defaults instead of reaching ffmpeg as NaN', async () => {
    const result = await plugin.run('audio-edit', [tone], { fadeIn: 2, volume: 'loud', speed: undefined })
    expect(argAfter(result.ffmpeg[0].args, '-af')).toBe('afade=t=in:st=0:d=2')
    expect(argAfter(result.ffmpeg[0].args, '-c:a')).toBe('libmp3lame')
  })

  it('coerce numbers and numeric strings to the default type', async () => {
    const result = await plugin.run('video-edit', [clip], { rotate: 270, contrast: '150' })
    expect(argAfter(result.ffmpeg[0].args, '-vf')).toBe('transpose=2,eq=contrast=1.500,' + EVEN)
  })
})

describe('panel state across input changes', () => {
  it('keeps preferences but resets per-file state when the files change', async () => {
    const first = await plugin.openPanel('video-edit', [{ id: 'a', name: 'a.mp4' }])
    await first.change('range', [1, 2])
    await first.change('saturation', 150)
    // The host re-opens the session with the previous state for the new file.
    const second = await plugin.openPanel('video-edit', [{ id: 'b', name: 'b.mp4' }], first.state)
    expect(second.state.range).toEqual([])
    expect(second.state.saturation).toBe(150)
    // Re-opening for the same file keeps its range.
    const again = await plugin.openPanel('video-edit', [{ id: 'b', name: 'b.mp4' }], { ...second.state, range: [3, 4] })
    expect(again.state.range).toEqual([3, 4])
  })
})

describe('audio-edit', () => {
  it('places fades in source time before tempo and silence removal', async () => {
    const result = await plugin.run('audio-edit', [tone], {
      range: [1, 9], fadeIn: 1.5, fadeOut: 2, volume: 150, speed: 50, removeSilence: true, normalize: true, format: 'mp3',
    })
    const args = result.ffmpeg[0].args
    expect(args.slice(0, 5)).toEqual(['-ss', '1', '-to', '9', '-i'])
    expect(argAfter(args, '-af').split(',')).toEqual([
      'afade=t=in:st=0:d=1.5',
      'afade=t=out:st=6.000:d=2',
      'loudnorm=I=-16:TP=-1.5:LRA=11',
      'volume=1.500',
      'atempo=0.5000',
      'silenceremove=start_periods=1:start_threshold=-50dB:stop_periods=-1:stop_threshold=-50dB:stop_duration=0.5',
    ])
  })

  it('probes the duration for a fade-out over a whole file', async () => {
    const result = await plugin.run('audio-edit', [tone], { fadeOut: 3 }, { probe: { 'tone.m4a': { durationSeconds: 42 } } })
    expect(argAfter(result.ffmpeg[0].args, '-af')).toBe('afade=t=out:st=39.000:d=3')
  })

  it('binds volume and speed previews with percent scaling', async () => {
    const panel = await plugin.openPanel('audio-edit', [{ name: 'tone.m4a' }])
    const media = findNodes(panel.last().nodes, 'media')[0]
    expect(media.effects).toMatchObject({ volume: { bind: 'volume', scale: 0.01 }, speed: { bind: 'speed', scale: 0.01 }, fadeIn: 'fadeIn' })
  })
})

describe('to-gif', () => {
  it('starts from the first five seconds of a long clip, but not after the user picks a range', async () => {
    const panel = await plugin.openPanel('to-gif', [{ name: 'clip.mp4' }])
    await panel.change('meta', [60, 1280, 720])
    expect(panel.state.range).toEqual([0, 5])
    await panel.change('range', [10, 12])
    await panel.change('meta', [60, 1280, 720])
    expect(panel.state.range).toEqual([10, 12])
  })

  it('removes the palette even when the second pass fails', async () => {
    const result = plugin.run('to-gif', [clip], { format: 'gif', range: [0, 2] }, { fail: (call) => call.outputs[0] === 'clip.gif' })
    await expect(result).rejects.toThrow(/ffmpeg failed/)
    expect(plugin.lastRemoved()).toEqual(['palette.png'])
  })

  it('crops before sampling and never upscales', async () => {
    const result = await plugin.run('to-gif', [clip], { format: 'webp', range: [1, 3], fps: 10, width: 480, cropOn: true, crop: [0, 0, 0.5, 0.5] })
    const args = result.ffmpeg[0].args
    expect(args.slice(0, 4)).toEqual(['-ss', '1', '-t', '2'])
    expect(argAfter(args, '-vf')).toBe("crop=trunc(iw*0.5000/2)*2:trunc(ih*0.5000/2)*2:trunc(iw*0.0000):trunc(ih*0.0000),fps=10,scale='min(480,iw)':-1:flags=lanczos")
  })
})

describe('frames', () => {
  it('exports one frame per marker with millisecond-distinct names', async () => {
    const result = await plugin.run('frames', [clip], { mode: 'marked', markers: [1.25, 1.5], format: 'png' })
    expect(result.ffmpeg.map((c) => c.outputs[0])).toEqual(['clip-00m01s250.png', 'clip-00m01s500.png'])
    expect(result.ffmpeg[0].args.slice(0, 2)).toEqual(['-ss', '1.25'])
  })

  it('refuses to run with no markers, and the panel disables the button', async () => {
    await expect(plugin.run('frames', [clip], { mode: 'marked', markers: [] })).rejects.toThrow(/标记至少一帧/)
    const panel = await plugin.openPanel('frames', [{ name: 'clip.mp4' }])
    expect(panel.last().runDisabled).toBe(true)
    await panel.change('markers', [2])
    expect(panel.last().runDisabled).toBe(false)
    expect(panel.last().runLabel).toBe('导出 1 帧')
  })

  it('samples evenly inside the selected range', async () => {
    const result = await plugin.run('frames', [clip], { mode: 'count', count: 4, range: [10, 20] })
    const args = result.ffmpeg[0].args
    expect(args.slice(0, 4)).toEqual(['-ss', '10', '-to', '20'])
    expect(argAfter(args, '-vf')).toBe('fps=0.400000')
  })

  it('still accepts the pre-panel single-frame parameters', async () => {
    const result = await plugin.run('frames', [clip], { mode: 'single', at: '00:01:02.5' })
    expect(result.ffmpeg[0].args.slice(0, 2)).toEqual(['-ss', '62.5'])
    expect(result.summary).toBe('已提取封面')
  })
})

describe('merge', () => {
  it('follows the panel order', async () => {
    const result = await plugin.run('merge', [clip, { ...clip, name: 'b.mp4' }, { ...clip, name: 'c.mp4' }], { order: [2, 0, 1] })
    expect(result.ffmpeg[0].inputs).toEqual(['c.mp4', 'clip.mp4', 'b.mp4'])
  })

  it('falls back to natural order when the stored order does not fit the inputs', async () => {
    const result = await plugin.run('merge', [clip, { ...clip, name: 'b.mp4' }], { order: [1, 1] })
    expect(result.ffmpeg[0].inputs).toEqual(['clip.mp4', 'b.mp4'])
  })

  it('normalises sizes to the first clip and pads silent clips with silence', async () => {
    const result = await plugin.run('merge', [clip, { ...clip, name: 'silent.mp4' }], {}, {
      probe: { 'clip.mp4': { width: 641, height: 361 }, 'silent.mp4': { width: 160, height: 90, audioCodec: null, durationSeconds: 2 } },
    })
    const graph = argAfter(result.ffmpeg[0].args, '-filter_complex')
    expect(graph).toContain('[1:v:0]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360')
    expect(graph).toContain('anullsrc=r=48000:cl=stereo,atrim=duration=2.000[a1]')
    expect(graph).toContain('[0:a:0]aresample=48000')
    expect(graph.endsWith('[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a];[v]' + EVEN + '[even]')).toBe(true)
  })

  it('joins audio-only inputs without a video stream', async () => {
    const result = await plugin.run('merge', [tone, { ...tone, name: 'b.m4a' }], { outputName: 'mix.mp3' })
    const args = result.ffmpeg[0].args
    expect(argAfter(args, '-filter_complex')).toContain('concat=n=2:v=0:a=1[a]')
    expect(argAfter(args, '-c:a')).toBe('libmp3lame')
  })

  it('refuses to concat video with audio-only files, and says what to do instead', async () => {
    await expect(plugin.run('merge', [clip, tone], {})).rejects.toThrow(/替换音轨/)
    const panel = await plugin.openPanel('merge', [{ name: 'clip.mp4', type: 'video/mp4' }, { name: 'tone.m4a', type: 'audio/mp4' }])
    expect(panel.last().runDisabled).toBe(true)
    await panel.change('mode', 'replace-audio')
    expect(panel.last().runDisabled).toBe(false)
  })
})

describe('compress-video', () => {
  it('warns when the target bitrate would be very low', async () => {
    const panel = await plugin.openPanel('compress-video', [{ name: 'clip.mp4', size: 50_000_000 }])
    await panel.change('meta', [600, 1920, 1080])
    await panel.change('mode', 'size')
    await panel.change('targetMB', 10)
    const alerts = findNodes(panel.last().nodes, 'alert')
    expect(alerts.some((a) => a.title === '码率很低')).toBe(true)
  })
})

/* ------------------------------------------------------------------ batch 2 */

import { existsSync } from 'node:fs'

const fontVendored = existsSync('public/vendor/fonts/NotoSansSC-Regular.ttf')
const logo = { name: 'logo.png', content: new Uint8Array(8), type: 'image/png' }

describe('video-effects', () => {
  it('pads a landscape clip to 9:16 at the source height with a blurred cover background', async () => {
    const result = await plugin.run('video-effects', [clip], { effect: 'blurpad', aspect: '9:16', blur: 30 }, { probe: { 'clip.mp4': { width: 1920, height: 1080 } } })
    const graph = argAfter(result.ffmpeg[0].args, '-filter_complex')
    expect(graph).toContain('[bg]scale=606:1080:force_original_aspect_ratio=increase,crop=606:1080,gblur=sigma=30[b]')
    expect(graph).toContain('[fg]scale=606:1080:force_original_aspect_ratio=decrease[f]')
    expect(result.ffmpeg[0].outputs[0]).toBe('clip-9x16.mp4')
  })

  it('pads a portrait clip to 16:9 at the source width', async () => {
    const result = await plugin.run('video-effects', [clip], { effect: 'blurpad', aspect: '16:9' }, { probe: { 'clip.mp4': { width: 1080, height: 1920 } } })
    expect(argAfter(result.ffmpeg[0].args, '-filter_complex')).toContain('scale=1080:606:')
  })

  it('reverses picture and, optionally, sound', async () => {
    const withAudio = await plugin.run('video-effects', [clip], { effect: 'reverse', reverseAudio: true })
    expect(argAfter(withAudio.ffmpeg[0].args, '-vf')).toBe('reverse,' + EVEN)
    expect(argAfter(withAudio.ffmpeg[0].args, '-af')).toBe('areverse')
    const silentReverse = await plugin.run('video-effects', [clip], { effect: 'reverse', reverseAudio: false })
    expect(silentReverse.ffmpeg[0].args).not.toContain('-af')
  })

  it('strips metadata by stream copy into the same container', async () => {
    const result = await plugin.run('video-effects', [{ ...clip, name: 'trip.mov' }], { effect: 'metadata' })
    const args = result.ffmpeg[0].args
    expect(args).toEqual(expect.arrayContaining(['-map_metadata', '-1', '-c', 'copy']))
    expect(result.ffmpeg[0].outputs[0]).toBe('trip-clean.mov')
  })

  it('maps stabilise and denoise strengths to filters', async () => {
    expect(argAfter((await plugin.run('video-effects', [clip], { effect: 'stabilize', strength: 'strong' })).ffmpeg[0].args, '-vf')).toBe('deshake=rx=32:ry=32:edge=mirror,' + EVEN)
    expect(argAfter((await plugin.run('video-effects', [clip], { effect: 'denoise', strength: 'light' })).ffmpeg[0].args, '-vf')).toBe('hqdn3d=2:1.5:3:3,' + EVEN)
  })
})

describe('audio-edit: pitch and denoise', () => {
  it('shifts pitch by resampling and compensates the tempo, after denoising first', async () => {
    const result = await plugin.run('audio-edit', [tone], { pitch: 12, denoise: true })
    expect(argAfter(result.ffmpeg[0].args, '-af').split(',')).toEqual(['afftdn=nf=-25', 'aresample=48000', 'asetrate=96000', 'aresample=48000', 'atempo=0.5000'])
  })
})

describe('audio-split', () => {
  it('cuts at the marked points in order, ignoring marks at the very ends', async () => {
    const result = await plugin.run('audio-split', [tone], { mode: 'marks', markers: [30, 10, 0.01, 60], meta: [60], format: 'wav' })
    expect(result.ffmpeg.map((c) => c.args.slice(0, 4))).toEqual([
      ['-ss', '0.000', '-to', '10.000'],
      ['-ss', '10.000', '-to', '30.000'],
      ['-ss', '30.000', '-to', '60.000'],
    ])
    expect(result.ffmpeg.map((c) => c.outputs[0])).toEqual(['tone-01.wav', 'tone-02.wav', 'tone-03.wav'])
  })

  it('splits into equal lengths using the probed duration', async () => {
    const result = await plugin.run('audio-split', [tone], { mode: 'length', length: 25 }, { probe: { 'tone.m4a': { durationSeconds: 60 } } })
    expect(result.ffmpeg).toHaveLength(3)
    expect(result.ffmpeg[2].args.slice(0, 4)).toEqual(['-ss', '50.000', '-to', '60.000'])
  })

  it('makes an iPhone ringtone of at most 40 seconds', async () => {
    const result = await plugin.run('audio-split', [tone], { mode: 'ringtone', range: [5, 90], fade: true })
    const args = result.ffmpeg[0].args
    expect(args.slice(0, 4)).toEqual(['-ss', '5', '-to', '45'])
    expect(args).toEqual(expect.arrayContaining(['-f', 'ipod']))
    expect(argAfter(args, '-af')).toBe('afade=t=in:st=0:d=1,afade=t=out:st=38.50:d=1.5')
    expect(result.ffmpeg[0].outputs[0]).toBe('tone.m4r')
  })

  it('disables export until a cut is marked', async () => {
    const panel = await plugin.openPanel('audio-split', [{ name: 'tone.m4a' }])
    expect(panel.last().runDisabled).toBe(true)
    await panel.change('meta', [60, 0, 0])
    await panel.change('markers', [20])
    expect(panel.last().runLabel).toBe('导出 2 段')
  })
})

describe('waveform', () => {
  it('draws a waveform with ffmpeg', async () => {
    const wave = await plugin.run('waveform', [tone], { kind: 'waveform', width: 800, height: 200, color: '#ff0000', split: true })
    expect(argAfter(wave.ffmpeg[0].args, '-filter_complex')).toBe('[0:a:0]showwavespic=s=800x200:colors=0xff0000:split_channels=1')
  })

  it('has ffmpeg only decode for a spectrogram, and bounds the PCM of long recordings', async () => {
    const g = globalThis as Record<string, unknown>
    const hadCanvas = 'OffscreenCanvas' in g
    // Node has no canvas; painting is covered end to end.
    if (!hadCanvas) {
      g.OffscreenCanvas = class {
        constructor(public width: number, public height: number) {}
        getContext() {
          return new Proxy({ createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), createLinearGradient: () => ({ addColorStop() {} }) } as Record<string, unknown>, {
            get: (target, key) => (key in target ? target[key as string] : () => {}),
            set: () => true,
          })
        }
        async convertToBlob() {
          return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])])
        }
      }
    }
    try {
      const short = await plugin.run('waveform', [tone], { kind: 'spectrum', rate: '44100' }, { probe: { 'tone.m4a': { durationSeconds: 60 } } })
      expect(short.ffmpeg).toHaveLength(1)
      expect(short.ffmpeg[0].args).toEqual(expect.arrayContaining(['-ac', '1', '-ar', '44100', '-f', 's16le']))
      expect(short.ffmpeg[0].args.join(' ')).not.toContain('showspectrumpic')
      expect(short.outputs.map((o) => o.name)).toEqual(['tone-spectrum.png'])
      expect(plugin.lastRemoved()).toContain('spectrum.pcm')

      // Three hours at 44.1 kHz would be ~950 MB of PCM; the rate steps down and the summary says so.
      const long = await plugin.run('waveform', [tone], { kind: 'spectrum', rate: '44100' }, { probe: { 'tone.m4a': { durationSeconds: 3 * 3600 } } })
      expect(argAfter(long.ffmpeg[0].args, '-ar')).toBe('16000')
      expect(long.summary).toContain('频率上限降为 8 kHz')
    } finally {
      if (!hadCanvas) delete g.OffscreenCanvas
    }
  })

  it('puts a tone in the right row on linear and logarithmic scales', async () => {
    const { exports: FFT } = await (globalThis as unknown as { loadDependency: (id: string) => Promise<{ exports: unknown }> }).loadDependency('fft')
    const matrix = (globalThis as unknown as { spectrogramMatrix: (o: object) => Promise<{ db: Float32Array; max: number; fftSize: number }> }).spectrogramMatrix
    const rate = 16000
    const samples = new Float32Array(rate * 4).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / rate))
    const read = async (offset: number, length: number, out: Float64Array) => {
      out.fill(0)
      for (let i = 0; i < length; i++) if (offset + i >= 0 && offset + i < samples.length) out[i] = samples[offset + i]
    }
    const width = 40
    const height = 200
    const peakRow = (db: Float32Array, x: number) => {
      let best = 0
      for (let y = 1; y < height; y++) if (db[y * width + x] > db[best * width + x]) best = y
      return best
    }
    const lin = await matrix({ FFT, read, totalSamples: samples.length, rate, width, height, scale: 'lin' })
    // 1 kHz of an 8 kHz range: row 175 counting from the top.
    expect(Math.abs(peakRow(lin.db, 20) - 175)).toBeLessThanOrEqual(1)
    // A 0.5-amplitude sine is about -6 dBFS.
    expect(lin.max).toBeGreaterThan(-8)
    expect(lin.max).toBeLessThan(-4)
    expect(lin.fftSize).toBe(512)

    const log = await matrix({ FFT, read, totalSamples: samples.length, rate, width, height, scale: 'log' })
    const t = Math.log(1000 / 20) / Math.log(8000 / 20)
    expect(Math.abs(peakRow(log.db, 20) - Math.round((1 - t) * height))).toBeLessThanOrEqual(3)
  })
})

describe('video-only inputs', () => {
  // A screen recording or silent WebM: FFmpeg would abort with "matches no streams".
  const silent = { name: 'screen.webm', content: new Uint8Array(16), type: 'video/webm' }
  const noAudio = { probe: { 'screen.webm': { audioCodec: null } } }

  it('explains instead of running FFmpeg on a file without audio', async () => {
    for (const [tool, params] of [['waveform', { kind: 'spectrum' }], ['extract-audio', {}], ['audio-edit', {}], ['audio-split', { mode: 'ringtone' }]] as const) {
      const run = plugin.run(tool, [silent], params, noAudio)
      await expect(run, tool).rejects.toThrow('screen.webm 没有音轨（只有画面）')
    }
    await expect(plugin.run('trim', [silent], { format: 'mp3', range: [0, 2] }, noAudio)).rejects.toThrow('没有音轨')
  })

  it('skips silent files in a batch and says so', async () => {
    const result = await plugin.run('waveform', [silent, tone], { kind: 'waveform' }, noAudio)
    expect(result.ffmpeg).toHaveLength(1)
    expect(result.ffmpeg[0].inputs).toEqual(['tone.m4a'])
    expect(result.summary).toContain('已跳过没有音轨的 screen.webm')
  })
})

describe('images-to-video', () => {
  const photo = (name: string) => ({ name, content: new Uint8Array(8), type: 'image/jpeg' })

  it('plays images in panel order, letterboxed to one size, with the music track', async () => {
    const result = await plugin.run('images-to-video', [photo('a.jpg'), photo('b.jpg'), { name: 'song.mp3', content: new Uint8Array(8), type: 'audio/mpeg' }], {
      order: [1, 0], seconds: 2, size: '1080x1920', fade: false, background: '#112233',
    })
    const call = result.ffmpeg[0]
    expect(call.inputs).toEqual(['b.jpg', 'a.jpg', 'song.mp3'])
    const graph = argAfter(call.args, '-filter_complex')
    expect(graph).toContain('[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x112233')
    expect(graph).toContain('[v0][v1]concat=n=2:v=1:a=0[v]')
    expect(call.args).toEqual(expect.arrayContaining(['-map', '2:a:0', '-shortest']))
    expect(result.summary).toContain('00:04.00')
  })

  it('converts a single GIF to APNG without looping options', async () => {
    const result = await plugin.run('images-to-video', [{ name: 'fun.gif', content: new Uint8Array(8), type: 'image/gif' }], { gifFormat: 'apng' })
    expect(result.ffmpeg[0].args).toEqual(['-i', '$in0', '-c:v', 'apng', '-plays', '0', '-f', 'apng', '-an', '-y', '$out0'])
    expect(result.ffmpeg[0].outputs[0]).toBe('fun.png')
  })
})

describe('watermark-video', () => {
  it('scales an image logo by box width and keeps its aspect ratio', async () => {
    const result = await plugin.run('watermark-video', [clip, logo], { kind: 'image', box: [0.1, 0.2, 0.3, 0.9], opacity: 50 })
    const graph = argAfter(result.ffmpeg[0].args, '-filter_complex')
    expect(graph).toContain('colorchannelmixer=aa=0.500')
    expect(graph).toContain('scale2ref=w=trunc(main_w*0.3000/2)*2:h=trunc(ow*ih/iw/2)*2')
    expect(graph).toContain('overlay=x=main_w*0.1000:y=main_h*0.2000')
    expect(result.ffmpeg[0].inputs).toEqual(['clip.mp4', 'logo.png'])
    // The still logo must loop, or overlay waits for frames that never come.
    expect(result.ffmpeg[0].args.slice(2, 5)).toEqual(['-loop', '1', '-i'])
    expect(graph).toContain(':shortest=1:')
  })

  it.skipIf(!fontVendored)('draws text from a file with the bundled font, then removes both scratch files', async () => {
    const result = await plugin.run('watermark-video', [clip], { kind: 'text', text: "it's: 100% \\ 中文", box: [0.5, 0.5, 0.4, 0.1], color: '#00ff00', opacity: 100 })
    const call = result.ffmpeg[0]
    expect(call.inputs).toEqual(['clip.mp4', 'NotoSansSC-Regular.ttf', 'watermark.txt'])
    expect(argAfter(call.args, '-vf')).toMatch(/^drawtext=fontfile=\$in1:textfile=\$in2:fontcolor=#00ff00@1\.00:.*fontsize=h\*0\.0800:x=w\*0\.5000:y=h\*0\.5000,format=yuv420p,pad=ceil\(iw\/2\)\*2:ceil\(ih\/2\)\*2,format=yuv420p$/)
    expect(plugin.lastRemoved().sort()).toEqual(['NotoSansSC-Regular.ttf', 'watermark.txt'])
  })

  it('refuses an image watermark without a logo', async () => {
    await expect(plugin.run('watermark-video', [clip], { kind: 'image' })).rejects.toThrow(/Logo/)
  })
})

describe('subtitles', () => {
  const srt = (name: string, content: string | Uint8Array) => ({ name, content, type: '' })

  it('converts with a time shift', async () => {
    const result = await plugin.run('subtitles', [srt('ep1.srt', '1\n00:00:01,000 --> 00:00:02,000\nhi\n')], { mode: 'convert', target: 'vtt', offset: -1500 })
    expect(result.ffmpeg[0].args).toEqual(['-itsoffset', '-1.5', '-i', '$in0', '-c:s', 'webvtt', '-y', '$out0'])
    expect(result.ffmpeg[0].outputs[0]).toBe('ep1-shifted.vtt')
  })

  it('re-encodes GBK subtitles to UTF-8 before handing them to ffmpeg', async () => {
    const gbk = new Uint8Array([0x31, 0x0a, 0xd6, 0xd0, 0xce, 0xc4]) // "1\n中文"
    const result = await plugin.run('subtitles', [srt('cn.srt', gbk)], { mode: 'convert', target: 'srt', offset: 0 })
    expect(result.ffmpeg[0].inputs).toEqual(['utf8-cn.srt'])
    expect(plugin.lastRemoved()).toEqual(['utf8-cn.srt'])
  })

  it('explains a missing subtitle track', async () => {
    const failing = plugin.run('subtitles', [clip], { mode: 'extract', target: 'srt', track: 2 }, { fail: () => true })
    await expect(failing).rejects.toThrow()
  })

  it('embeds soft subtitles with the right codec per container', async () => {
    const mp4 = await plugin.run('subtitles', [clip, srt('a.srt', 'x')], { mode: 'embed', container: 'mp4', language: 'eng' })
    expect(argAfter(mp4.ffmpeg[0].args, '-c:s')).toBe('mov_text')
    expect(mp4.ffmpeg[0].args).toEqual(expect.arrayContaining(['-metadata:s:s:0', 'language=eng']))
    const mkv = await plugin.run('subtitles', [clip, srt('styled.ass', 'x')], { mode: 'embed', container: 'mkv' })
    expect(argAfter(mkv.ffmpeg[0].args, '-c:s')).toBe('ass')
    expect(mkv.ffmpeg[0].outputs[0]).toBe('clip-subtitled.mkv')
  })

  it.skipIf(!fontVendored)('burns subtitles with the bundled font available to libass', async () => {
    const result = await plugin.run('subtitles', [clip, srt('a.srt', 'x')], { mode: 'burn', fontSize: 30, margin: 40 })
    const call = result.ffmpeg[0]
    expect(call.inputs).toEqual(['clip.mp4', 'a.srt', 'NotoSansSC-Regular.ttf'])
    expect(argAfter(call.args, '-vf')).toBe("subtitles=$in1:fontsdir=/:force_style='FontName=Noto Sans SC,FontSize=30,MarginV=40,Outline=2,Shadow=0'," + EVEN)
  })
})

describe('to-gif: APNG', () => {
  it('encodes APNG with ffmpeg and a .png name', async () => {
    const result = await plugin.run('to-gif', [clip], { format: 'apng', range: [0, 2], loop: true })
    expect(result.ffmpeg).toHaveLength(1)
    expect(result.ffmpeg[0].args).toEqual(expect.arrayContaining(['-c:v', 'apng', '-plays', '0', '-f', 'apng']))
    expect(result.ffmpeg[0].outputs[0]).toBe('clip.png')
  })
})

describe('odd-sized video encoding', () => {
  const webm = { name: 'odd.webm', content: new Uint8Array(16), type: 'video/webm' }
  it('pads the original dimensions for WebM to MP4, with or without resizing', async () => {
    const original = await plugin.run('convert-video', [webm], {})
    expect(argAfter(original.ffmpeg[0].args, '-vf')).toBe(EVEN)
    const scaled = await plugin.run('convert-video', [webm], { resolution: '1920' })
    expect(argAfter(scaled.ffmpeg[0].args, '-vf')).toBe('scale=1920:-2:flags=lanczos,' + EVEN)
  })
  it('does not filter stream-copy exports, even with a stale resolution', async () => {
    const result = await plugin.run('convert-video', [webm], { codec: 'copy', resolution: '1920', container: 'mkv', audio: 'copy' })
    expect(result.ffmpeg[0].args).not.toContain('-vf')
  })
  it('pads both compression passes when downscaling is disabled', async () => {
    const result = await plugin.run('compress-video', [webm], { mode: 'size', targetMB: 1, downscale: false }, {
      probe: { 'odd.webm': { durationSeconds: 14.16, width: 566, height: 447, audioCodec: null } },
    })
    expect(result.ffmpeg).toHaveLength(2)
    for (const call of result.ffmpeg) expect(argAfter(call.args, '-vf')).toBe(EVEN)
  })
})
