import { describe, expect, it } from 'vitest'
import { applyThreadBudget, PTHREAD_POOL } from '@/core/capabilities/ffmpeg'

/** Every `-threads N` value the budget injected, in order. */
function threadCounts(args: string[]): number[] {
  return args.flatMap((arg, i) => (arg === '-threads' ? [Number(args[i + 1])] : []))
}

describe('applyThreadBudget', () => {
  it('puts -threads before every input and output, and caps filter threads', () => {
    const out = applyThreadBudget(['-i', '$in0', '-c:v', 'libx264', '$out0'], true)
    expect(out.slice(0, 4)).toEqual(['-filter_threads', out[1], '-filter_complex_threads', out[3]])
    // `-threads` binds to the next file, so it must sit immediately before each.
    expect(out[out.indexOf('-i') - 2]).toBe('-threads')
    expect(out[out.indexOf('$out0') - 2]).toBe('-threads')
  })

  it('keeps the total within half the pthread pool for a multi-input graph', () => {
    // The shape that hung: several decoders feeding filter_complex into an encoder.
    const args = ['-i', '$in0', '-i', '$in1', '-i', '$in2', '-filter_complex', 'concat=n=3', '$out0']
    const out = applyThreadBudget(args, true)
    const perConsumer = threadCounts(out)
    const consumers = 3 + 1 + 1 // inputs + outputs + filter graph
    expect(perConsumer).toHaveLength(4)
    expect(perConsumer.every((n) => n >= 1)).toBe(true)
    expect(perConsumer[0] * consumers).toBeLessThanOrEqual(PTHREAD_POOL / 2)
  })

  it('never exceeds 4 threads per consumer even for a trivial graph', () => {
    const out = applyThreadBudget(['-i', '$in0', '$out0'], true)
    expect(Math.max(...threadCounts(out))).toBeLessThanOrEqual(4)
  })

  it('uses a single thread on the single-thread core', () => {
    const out = applyThreadBudget(['-i', '$in0', '$out0'], false)
    expect(threadCounts(out)).toEqual([1, 1])
  })

  it('respects a plugin that set -threads itself', () => {
    const args = ['-threads', '2', '-i', '$in0', '$out0']
    expect(applyThreadBudget(args, true)).toEqual(args)
  })

  it('does not treat an input placeholder as an output', () => {
    // `$out0` from an earlier run can be fed back in as `-i $in1`; only bare
    // output placeholders count as outputs.
    const out = applyThreadBudget(['-i', '$in0', '-i', '$in1', '-lavfi', 'paletteuse', '$out0'], true)
    expect(threadCounts(out)).toHaveLength(3)
  })
})

describe('applyThreadBudget: still images', () => {
  it('decodes still-image inputs with one thread, videos with the budget', () => {
    // The shape that hung: a looped PNG logo into scale2ref beside a video.
    const args = ['-i', '$in0', '-loop', '1', '-i', '$in1', '-filter_complex', 'scale2ref', '$out0']
    const out = applyThreadBudget(args, true, ['clip.mp4', 'logo.png'])
    const inputThreads = out.flatMap((arg, i) => (arg === '-i' ? [Number(out[i - 1])] : []))
    expect(inputThreads[0]).toBeGreaterThan(1)
    expect(inputThreads[1]).toBe(1)
    expect(out.slice(out.indexOf('-loop'), out.indexOf('-loop') + 5)).toEqual(['-loop', '1', '-threads', '1', '-i'])
  })

  it('recognises common image extensions case-insensitively, and leaves animated GIFs to the budget', () => {
    const out = applyThreadBudget(['-i', '$in0', '-i', '$in1', '-i', '$in2', '$out0'], true, ['A.JPG', 'b.webp', 'c.gif'])
    const inputThreads = out.flatMap((arg, i) => (arg === '-i' ? [Number(out[i - 1])] : []))
    expect(inputThreads.slice(0, 2)).toEqual([1, 1])
    expect(inputThreads[2]).toBeGreaterThan(1)
  })
})
