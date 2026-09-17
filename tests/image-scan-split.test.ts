/**
 * Scanner photo detection (`scan-split`): synthetic scans with tilted photos
 * on a light bed, checked for count, order, size and skew angle.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { loadPlugin } from './harness/plugin'

type Rect = { cx: number; cy: number; width: number; height: number; angle: number }
type Helpers = {
  detectPhotos: (data: Uint8ClampedArray, width: number, height: number, opts?: { threshold?: number; minArea?: number }) => Rect[]
  minAreaRect: (hull: number[][]) => Rect
  convexHull: (points: number[][]) => number[][]
}

let h: Helpers

beforeAll(() => {
  loadPlugin('src/plugins/builtin/image-tools.js')
  h = globalThis as unknown as Helpers
})

/** A scan: near-white noisy bed with photos drawn as rotated rectangles with a pale border and dark content. */
function scan(width: number, height: number, photos: Rect[], seed = 7, borderTone = 212) {
  const data = new Uint8ClampedArray(width * height * 4)
  let state = seed
  const noise = () => ((state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 10 - 5
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      let value = [246, 246, 242]
      for (const p of photos) {
        const dx = x + 0.5 - p.cx
        const dy = y + 0.5 - p.cy
        const u = dx * Math.cos(p.angle) + dy * Math.sin(p.angle)
        const v = -dx * Math.sin(p.angle) + dy * Math.cos(p.angle)
        if (Math.abs(u) <= p.width / 2 && Math.abs(v) <= p.height / 2) {
          // White photo border 6 px wide, which the closing must bridge.
          const border = Math.abs(u) > p.width / 2 - 6 || Math.abs(v) > p.height / 2 - 6
          value = border ? [borderTone, borderTone, borderTone - 4] : [60 + ((u + v) & 63), 90, 120]
          // A white patch inside the photo (sky), which hole filling must keep.
          if (!border && Math.abs(u) < p.width / 6 && Math.abs(v) < p.height / 6) value = [247, 247, 243]
        }
      }
      data[i] = value[0] + noise()
      data[i + 1] = value[1] + noise()
      data[i + 2] = value[2] + noise()
      data[i + 3] = 255
    }
  }
  return data
}

const deg = (d: number) => (d * Math.PI) / 180

describe('scan-split detection', () => {
  it('finds tilted photos in reading order with their size and angle', () => {
    const photos: Rect[] = [
      { cx: 150, cy: 120, width: 200, height: 140, angle: deg(4) },
      { cx: 450, cy: 130, width: 180, height: 150, angle: deg(-7) },
      { cx: 300, cy: 380, width: 260, height: 170, angle: deg(0) },
    ]
    const found = h.detectPhotos(scan(600, 520, photos), 600, 520)
    expect(found).toHaveLength(3)
    found.forEach((rect, i) => {
      const expected = photos[i]
      expect(Math.abs(rect.cx - expected.cx), `photo ${i} cx`).toBeLessThan(3)
      expect(Math.abs(rect.cy - expected.cy), `photo ${i} cy`).toBeLessThan(3)
      // The closing can round corners by a pixel or two, never more.
      expect(Math.abs(rect.width - expected.width), `photo ${i} width`).toBeLessThan(5)
      expect(Math.abs(rect.height - expected.height), `photo ${i} height`).toBeLessThan(5)
      expect(Math.abs(rect.angle - expected.angle), `photo ${i} angle`).toBeLessThan(deg(1))
    })
  })

  it('needs a lower sensitivity to include a near-white photo border', () => {
    const photos: Rect[] = [{ cx: 200, cy: 150, width: 240, height: 180, angle: deg(3) }]
    const data = scan(400, 300, photos, 11, 226)
    const [strict] = h.detectPhotos(data, 400, 300)
    const [loose] = h.detectPhotos(data, 400, 300, { threshold: 12 })
    expect(strict.width).toBeLessThan(234)
    expect(Math.abs(loose.width - 240)).toBeLessThan(5)
    expect(Math.abs(loose.height - 180)).toBeLessThan(5)
  })

  it('ignores specks below the minimum area and an empty bed', () => {
    const photos: Rect[] = [
      { cx: 200, cy: 200, width: 220, height: 160, angle: 0 },
      { cx: 450, cy: 60, width: 14, height: 14, angle: 0 },
    ]
    expect(h.detectPhotos(scan(520, 400, photos), 520, 400)).toHaveLength(1)
    expect(h.detectPhotos(scan(300, 200, []), 300, 200)).toHaveLength(0)
  })

  it('folds quarter turns so width and height stay the photo’s own', () => {
    const rect = h.minAreaRect(h.convexHull([[0, 0], [0, 100], [40, 100], [40, 0]]))
    expect(Math.abs(rect.angle)).toBeLessThan(1e-9)
    expect([rect.width, rect.height]).toEqual([40, 100])
    expect([rect.cx, rect.cy]).toEqual([20, 50])
  })
})
