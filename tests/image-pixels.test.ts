/**
 * Pixel algorithms of the image toolbox that run without a browser: seam
 * carving (content-aware resize) and the guided-filter denoiser.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { loadPlugin } from './harness/plugin'

type Image = { data: Uint8ClampedArray; width: number; height: number }
type Helpers = {
  carveSeams: (image: Image, count: number) => Image
  transpose: (image: Image) => Image
  denoiseGuided: (data: Uint8ClampedArray, width: number, height: number, r: number, eps: number, detail: number) => void
}

let h: Helpers

beforeAll(() => {
  loadPlugin('src/plugins/builtin/image-tools.js')
  h = globalThis as unknown as Helpers
})

/** Smooth horizontal gradient with a red square "subject". */
function scene(width: number, height: number, square: { x: number; y: number; size: number }): Image {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const inside = x >= square.x && x < square.x + square.size && y >= square.y && y < square.y + square.size
      data.set(inside ? [220, 20, 20, 255] : [100 + (x * 40) / width, 150, 200, 255], i)
    }
  }
  return { data, width, height }
}

const redPixels = (image: Image) => {
  let n = 0
  for (let i = 0; i < image.data.length; i += 4) if (image.data[i] > 200 && image.data[i + 1] < 50) n++
  return n
}

describe('seam carving', () => {
  it('narrows the image without removing the subject', () => {
    const input = scene(120, 60, { x: 50, y: 15, size: 20 })
    const out = h.carveSeams({ ...input, data: input.data.slice() }, 36)
    expect(out.width).toBe(84)
    expect(out.height).toBe(60)
    expect(out.data.length).toBe(84 * 60 * 4)
    expect(redPixels(out)).toBe(400)
  })

  it('removes rows through transposition', () => {
    const input = scene(60, 100, { x: 20, y: 40, size: 20 })
    const out = h.transpose(h.carveSeams(h.transpose(input), 30))
    expect([out.width, out.height]).toEqual([60, 70])
    expect(redPixels(out)).toBe(400)
  })

  it('transpose is its own inverse', () => {
    const input = scene(7, 5, { x: 1, y: 1, size: 2 })
    expect(h.transpose(h.transpose(input))).toEqual(input)
  })
})

describe('guided filter denoise', () => {
  it('flattens noise in smooth areas and keeps a hard edge', () => {
    const width = 80
    const height = 40
    const data = new Uint8ClampedArray(width * height * 4)
    let seed = 3
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 40
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const base = x < width / 2 ? 60 : 190
        data.set([base + noise(), base + noise(), base + noise(), 255], (y * width + x) * 4)
      }
    }
    const spread = (from: number, to: number) => {
      const values: number[] = []
      for (let y = 5; y < height - 5; y++) for (let x = from; x < to; x++) values.push(data[(y * width + x) * 4])
      const mean = values.reduce((a, b) => a + b, 0) / values.length
      return Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length)
    }
    const before = spread(5, 35)
    // The tool's default strength 4: eps = (4 · 7 / 255)².
    h.denoiseGuided(data, width, height, 3, ((4 * 7) / 255) ** 2, 0)
    expect(spread(5, 35)).toBeLessThan(before / 2.5)
    // The step between the halves survives: pixels right next to it keep their side's level.
    expect(data[(20 * width + width / 2 - 2) * 4]).toBeLessThan(90)
    expect(data[(20 * width + width / 2 + 1) * 4]).toBeGreaterThan(160)
  })
})
