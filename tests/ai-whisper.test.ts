/**
 * Whisper pre- and post-processing. The model run itself is covered in the
 * browser by e2e/ai.mjs (it transcribes a real speech sample).
 */
import { existsSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadPlugin } from './harness/plugin'

type Segment = { start: number; end: number; text: string }
type Helpers = {
  T: Record<string, number>
  logMel: (samples: Float32Array) => Float32Array
  melFilterBank: () => Float32Array
  applyTimestampRules: (logits: Float32Array, tokens: number[]) => void
  segmentTokens: (tokens: number[], windowSeconds: number) => { windowSegments: Array<{ start: number; end: number; tokens: number[] }>; advance: number }
  splitCues: (segments: Segment[], maxChars: number) => Segment[]
  toSrt: (cues: Segment[]) => string
  toVtt: (cues: Segment[]) => string
  isRepeating: (tokens: number[]) => boolean
  whisperTokenizer: (tokens: string[]) => { decode: (ids: number[]) => string; languages: Map<string, number> }
}

let h: Helpers
const VOCAB = 'public/vendor/whisper/vocab.js'

beforeAll(() => {
  loadPlugin('src/plugins/builtin/ai-tools.js')
  h = globalThis as unknown as Helpers
  // The plugin's `const T` stays local to its eval; these are Whisper's multilingual ids.
  h.T = { eot: 50257, sot: 50258, translate: 50358, transcribe: 50359, noSpeech: 50362, noTimestamps: 50363, timestampBegin: 50364 }
})

const ts = (seconds: number) => h.T.timestampBegin + Math.round(seconds / 0.02)

describe('log-mel features', () => {
  it('builds 80 triangular slaney filters over 201 FFT bins', () => {
    const filters = h.melFilterBank()
    expect(filters.length).toBe(80 * 201)
    for (let m = 0; m < 80; m++) {
      const row = filters.subarray(m * 201, (m + 1) * 201)
      const peak = row.indexOf(Math.max(...row))
      // Rises to one peak and falls again.
      for (let k = 1; k <= peak; k++) expect(row[k]).toBeGreaterThanOrEqual(row[k - 1])
      for (let k = peak + 1; k < 201; k++) expect(row[k]).toBeLessThanOrEqual(row[k - 1])
    }
  })

  it('maps silence to the floor value and a tone to its mel band', () => {
    const silent = h.logMel(new Float32Array(16000))
    expect(silent.length).toBe(80 * 3000)
    expect(silent[0]).toBeCloseTo(-1.5)

    const tone = new Float32Array(16000 * 2)
    for (let i = 0; i < tone.length; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 16000)
    const mel = h.logMel(tone)
    const frame = 50
    const column = Array.from({ length: 80 }, (_, m) => mel[m * 3000 + frame])
    const band = column.indexOf(Math.max(...column))
    // 1 kHz on the slaney scale sits at mel 15, i.e. filter ~ 15 / (mel(8000) / 81) ≈ 27.
    expect(band).toBeGreaterThanOrEqual(26)
    expect(band).toBeLessThanOrEqual(28)
    // Padding after the audio falls back to the floor (max - 8).
    expect(mel[3000 - 1]).toBeCloseTo(Math.max(...column) - 2, 1)
  })
})

describe('timestamp rules', () => {
  const logits = () => new Float32Array(51865)

  it('starts with a timestamp no later than one second', () => {
    const l = logits()
    h.applyTimestampRules(l, [])
    expect(l[1000]).toBe(-Infinity)
    expect(l[ts(0)]).toBe(0)
    expect(l[ts(1)]).toBe(0)
    expect(l[ts(1.02)]).toBe(-Infinity)
  })

  it('closes a text run with a timestamp later than the opening one', () => {
    const l = logits()
    h.applyTimestampRules(l, [ts(2), 1000])
    expect(l[ts(2)]).toBe(-Infinity)
    expect(l[ts(2.02)]).toBeGreaterThan(-Infinity)
    const pair = logits()
    h.applyTimestampRules(pair, [ts(2), 1000, ts(3)])
    // After a lone closing timestamp only another timestamp (the next opening) or the end may follow.
    expect(pair[1000]).toBe(-Infinity)
    expect(pair[ts(3)]).toBeGreaterThan(-Infinity)
    const both = logits()
    h.applyTimestampRules(both, [ts(2), 1000, ts(3), ts(3)])
    expect(both[ts(4)]).toBe(-Infinity)
    expect(both[1000]).toBeGreaterThan(-Infinity)
  })

  it('never samples suppressed control tokens', () => {
    const l = logits()
    h.applyTimestampRules(l, [ts(0), 1000])
    for (const id of [h.T.sot, h.T.translate, h.T.transcribe, h.T.noSpeech, h.T.noTimestamps]) expect(l[id]).toBe(-Infinity)
  })
})

describe('segmentation', () => {
  it('cuts complete pairs and re-decodes an unfinished sentence', () => {
    const tokens = [ts(0), 100, 101, ts(2.5), ts(2.5), 102, ts(5), ts(6), 103]
    const { windowSegments, advance } = h.segmentTokens(tokens, 30)
    expect(windowSegments).toEqual([
      { start: 0, end: 2.5, tokens: [100, 101] },
      { start: 2.5, end: 5, tokens: [102] },
    ])
    expect(advance).toBeCloseTo(5)
  })

  it('advances a whole window after a single closing timestamp', () => {
    const { windowSegments, advance } = h.segmentTokens([ts(0), 100, ts(4), ts(4), 101, ts(9)], 30)
    expect(windowSegments.map((s) => s.tokens)).toEqual([[100], [101]])
    expect(advance).toBe(30)
  })

  it('treats a window without pairs as one segment', () => {
    const { windowSegments, advance } = h.segmentTokens([ts(1), 100, 101], 12)
    expect(windowSegments).toEqual([{ start: 1, end: 12, tokens: [100, 101] }])
    expect(advance).toBe(12)
  })

  it('detects decoding loops', () => {
    expect(h.isRepeating([1, 2, 1, 2, 1, 2, 1, 2])).toBe(true)
    expect(h.isRepeating([1, 2, 3, 4, 5, 6, 7, 8])).toBe(false)
  })
})

describe('subtitle output', () => {
  it('splits long segments at punctuation with proportional times', () => {
    const cues = h.splitCues([{ start: 10, end: 20, text: '今天我们来聊一聊本地优先的软件，它把数据留在你自己的设备上。然后再同步。' }], 16)
    expect(cues.length).toBeGreaterThan(1)
    expect(cues.every((c) => c.text.length <= 17)).toBe(true)
    expect(cues[0].text.endsWith('，')).toBe(true)
    expect(cues[0].start).toBe(10)
    expect(cues[cues.length - 1].end).toBeCloseTo(20)
    expect(cues.map((c) => c.text).join('')).toBe('今天我们来聊一聊本地优先的软件，它把数据留在你自己的设备上。然后再同步。')
  })

  it('formats SRT and WebVTT', () => {
    const cues = [{ start: 0, end: 2.5, text: 'Hello' }, { start: 3661.2, end: 3662, text: '世界' }]
    expect(h.toSrt(cues)).toBe('1\n00:00:00,000 --> 00:00:02,500\nHello\n\n2\n01:01:01,200 --> 01:01:02,000\n世界\n')
    expect(h.toVtt(cues)).toBe('WEBVTT\n\n00:00:00.000 --> 00:00:02.500\nHello\n\n01:01:01.200 --> 01:01:02.000\n世界\n')
  })

  it.skipIf(!existsSync(VOCAB))('decodes byte-level tokens, including split UTF-8', () => {
    ;(0, eval)(readFileSync(VOCAB, 'utf8'))
    const vocab = (globalThis as unknown as { WHISPER_VOCAB: { tokens: string[] } }).WHISPER_VOCAB.tokens
    const tokenizer = h.whisperTokenizer(vocab)
    const encode = (text: string) => {
      // Greedy longest match over the byte-level vocabulary; enough to round-trip a test string.
      const index = new Map(vocab.map((t, i) => [t, i]))
      const table: string[] = []
      const printable = [...Array(94).keys()].map((i) => i + 33).concat([...Array(12).keys()].map((i) => i + 161), [...Array(82).keys()].map((i) => i + 174))
      let extra = 0
      for (let b = 0; b < 256; b++) table[b] = String.fromCharCode(printable.includes(b) ? b : 256 + extra++)
      const mapped = [...new TextEncoder().encode(text)].map((b) => table[b]).join('')
      const ids: number[] = []
      for (let i = 0; i < mapped.length; ) {
        let j = mapped.length
        while (j > i && !index.has(mapped.slice(i, j))) j--
        ids.push(index.get(mapped.slice(i, j))!)
        i = j
      }
      return ids
    }
    const text = ' 你好，world! Ünïcödé'
    expect(tokenizer.decode([...encode(text), h.T.eot])).toBe(text)
    expect(tokenizer.languages.get('zh')).toBe(50260)
  })
})
