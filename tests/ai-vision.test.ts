/**
 * Pure helpers behind the face-blur and erase tools. The models themselves are
 * exercised in the browser by e2e/ai.mjs; decoding here follows OpenCV's
 * FaceDetectorYN and was checked against the real YuNet model.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { loadPlugin } from './harness/plugin'

type Box = { x: number; y: number; w: number; h: number; score?: number }
type Tensor = { data: Float32Array }
type Helpers = {
  decodeYunet: (outputs: Record<string, Tensor>, size: number, threshold: number) => Required<Box>[]
  suppressOverlaps: (boxes: Required<Box>[], iou: number) => Required<Box>[]
  tileStarts: (length: number, window: number) => number[]
  expandBox: (box: Box, ratio: number, width: number, height: number) => Box
  contextCrop: (bounds: Box, width: number, height: number) => Box
  maskBounds: (rgba: Uint8ClampedArray, width: number, height: number) => Box | null
  fixRedEye: (data: Uint8ClampedArray, width: number, height: number, cx: number, cy: number, radius: number, sensitivity: number) => number
  bestCrop: (saliency: Uint8ClampedArray, size: number, width: number, height: number, ratio: number, options?: { fit?: string; padding?: number }) => Box
}

let h: Helpers

beforeAll(() => {
  loadPlugin('src/plugins/builtin/ai-tools.js')
  h = globalThis as unknown as Helpers
})

/** Empty YuNet heads with one confident anchor planted on the stride-16 grid. */
function yunetOutputs(size: number, plant: { stride: number; col: number; row: number; box: number[]; cls: number; obj: number }) {
  const outputs: Record<string, Tensor> = {}
  for (const stride of [8, 16, 32]) {
    const n = (size / stride) ** 2
    outputs[`cls_${stride}`] = { data: new Float32Array(n) }
    outputs[`obj_${stride}`] = { data: new Float32Array(n) }
    outputs[`bbox_${stride}`] = { data: new Float32Array(n * 4) }
    outputs[`kps_${stride}`] = { data: new Float32Array(n * 10) }
  }
  const i = plant.row * (size / plant.stride) + plant.col
  outputs[`cls_${plant.stride}`].data[i] = plant.cls
  outputs[`obj_${plant.stride}`].data[i] = plant.obj
  outputs[`bbox_${plant.stride}`].data.set(plant.box, i * 4)
  return outputs
}

describe('face detection helpers', () => {
  it('decodes an anchor into a box centred on its grid cell offset', () => {
    const outputs = yunetOutputs(640, { stride: 16, col: 10, row: 5, box: [0.5, 0.25, Math.log(3), Math.log(4)], cls: 0.9, obj: 0.9 })
    const [face, ...rest] = h.decodeYunet(outputs, 640, 0.6)
    expect(rest).toHaveLength(0)
    // cx = (10 + 0.5) · 16 = 168, w = 3 · 16 = 48; cy = (5 + 0.25) · 16 = 84, h = 64.
    expect(face.x).toBeCloseTo(144)
    expect(face.y).toBeCloseTo(52)
    expect(face.w).toBeCloseTo(48)
    expect(face.h).toBeCloseTo(64)
    expect(face.score).toBeCloseTo(0.9)
    // Landmark offsets of 0 sit on the anchor's grid corner.
    expect((face as unknown as { landmarks: number[][] }).landmarks[0]).toEqual([160, 80])
  })

  it('scores as the geometric mean of class and objectness, clamped', () => {
    const weak = yunetOutputs(640, { stride: 8, col: 0, row: 0, box: [0, 0, 0, 0], cls: 0.9, obj: 0.25 })
    expect(h.decodeYunet(weak, 640, 0.5)).toHaveLength(0)
    const clamped = yunetOutputs(640, { stride: 32, col: 1, row: 1, box: [0, 0, 0, 0], cls: 1.4, obj: 1 })
    expect(h.decodeYunet(clamped, 640, 0.5)[0].score).toBe(1)
  })

  it('suppresses overlapping and contained duplicates, keeping the best', () => {
    const kept = h.suppressOverlaps([
      { x: 0, y: 0, w: 100, h: 100, score: 0.7 },
      { x: 5, y: 5, w: 100, h: 100, score: 0.9 },
      { x: 20, y: 20, w: 30, h: 30, score: 0.8 },
      { x: 300, y: 0, w: 40, h: 40, score: 0.6 },
    ], 0.3)
    expect(kept.map((b) => b.score)).toEqual([0.9, 0.6])
  })

  it('tiles cover the whole length with overlap', () => {
    expect(h.tileStarts(500, 640)).toEqual([0])
    const starts = h.tileStarts(2000, 640)
    expect(starts[0]).toBe(0)
    expect(starts[starts.length - 1]).toBe(1360)
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeLessThan(640)
  })

  it('expands a face box mostly upwards, inside the image', () => {
    expect(h.expandBox({ x: 100, y: 100, w: 100, h: 100 }, 0.5, 1000, 1000)).toEqual({ x: 75, y: 65, w: 150, h: 150 })
    const edge = h.expandBox({ x: 0, y: 10, w: 100, h: 100 }, 0.5, 120, 1000)
    expect(edge.x).toBe(0)
    expect(edge.y).toBe(0)
    expect(edge.x + edge.w).toBe(120)
  })
})

describe('inpainting helpers', () => {
  it('finds the painted bounds', () => {
    const rgba = new Uint8ClampedArray(10 * 8 * 4)
    for (const [x, y] of [[2, 3], [6, 5]]) rgba[(y * 10 + x) * 4 + 3] = 255
    expect(h.maskBounds(rgba, 10, 8)).toEqual({ x: 2, y: 3, w: 5, h: 3 })
    expect(h.maskBounds(new Uint8ClampedArray(16), 2, 2)).toBeNull()
  })

  it('gives the model context around the mask, clamped to the image', () => {
    const crop = h.contextCrop({ x: 1000, y: 800, w: 100, h: 60 }, 4000, 3000)
    expect(crop.w).toBe(356)
    expect(crop.h).toBe(356)
    // Centred on the mask.
    expect(crop.x + crop.w / 2).toBeCloseTo(1050, 0)
    const big = h.contextCrop({ x: 0, y: 0, w: 1500, h: 900 }, 1600, 1000)
    expect(big).toEqual({ x: 0, y: 0, w: 1600, h: 1000 })
  })
})

describe('red eye', () => {
  function eye(size: number, pupil: [number, number, number], ring: [number, number, number], pupilShare = 5) {
    const data = new Uint8ClampedArray(size * size * 4)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const inside = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) < size / pupilShare
        data.set([...(inside ? pupil : ring), 255], (y * size + x) * 4)
      }
    }
    return data
  }

  it('darkens a red pupil and leaves the skin around it alone', () => {
    const data = eye(40, [200, 40, 40], [175, 100, 85])
    expect(h.fixRedEye(data, 40, 40, 20, 20, 16, 5)).toBeGreaterThan(100)
    const centre = (20 * 40 + 20) * 4
    expect(data[centre]).toBeLessThanOrEqual(60)
    const skin = (20 * 40 + 6) * 4
    expect([...data.slice(skin, skin + 3)]).toEqual([175, 100, 85])
  })

  it('leaves normal eyes and reddish-brown skin untouched', () => {
    const brown = eye(40, [60, 40, 35], [170, 95, 80])
    const copy = brown.slice()
    expect(h.fixRedEye(brown, 40, 40, 20, 20, 16, 10)).toBe(0)
    expect(brown).toEqual(copy)
  })

  it('refuses a red region that fills the whole eye area', () => {
    const allRed = eye(40, [220, 30, 30], [220, 30, 30])
    expect(h.fixRedEye(allRed, 40, 40, 20, 20, 16, 5)).toBe(0)
  })
})

describe('smart crop', () => {
  /** A saliency map with one bright blob. */
  function blob(size: number, cx: number, cy: number, r: number) {
    const map = new Uint8ClampedArray(size * size)
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) map[y * size + x] = Math.hypot(x - cx, y - cy) < r ? 255 : 0
    return map
  }

  it('slides the largest crop towards the subject', () => {
    // Subject at 80% across a 1600×900 image; a square crop is 900×900.
    const crop = h.bestCrop(blob(320, 256, 160, 20), 320, 1600, 900, 1)
    expect([crop.w, crop.h]).toEqual([900, 900])
    expect(crop.x).toBe(700)
    expect(crop.x + crop.w / 2).toBeGreaterThan(800)
  })

  it('frames the subject tightly with padding in subject mode', () => {
    const crop = h.bestCrop(blob(320, 160, 160, 32), 320, 1000, 1000, 16 / 9, { fit: 'subject', padding: 0.1 })
    expect(crop.w / crop.h).toBeCloseTo(16 / 9, 1)
    // Blob ≈ 63 map px → 197 image px, plus 10% padding each side ≈ 236.
    expect(crop.h).toBeGreaterThanOrEqual(230)
    expect(crop.h).toBeLessThan(400)
    expect(Math.abs(crop.x + crop.w / 2 - 500)).toBeLessThan(5)
  })

  it('centres when nothing stands out', () => {
    expect(h.bestCrop(new Uint8ClampedArray(320 * 320), 320, 1200, 800, 1)).toEqual({ x: 200, y: 0, w: 800, h: 800 })
  })
})
