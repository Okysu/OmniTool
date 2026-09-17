/**
 * Placement geometry, form filling and orientation detection for the PDF
 * stamp / redact / fill-form / auto-rotate tools. Geometry is checked against
 * real pdf.js viewports, the same transform the in-app page preview uses.
 */
import { existsSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDict, PDFDocument, PDFName, StandardFonts, degrees } from 'pdf-lib'
import { loadPlugin } from './harness/plugin'

type Box = [number, number, number, number]
type Region = { x1: number; y1: number; x2: number; y2: number }
type Helpers = {
  displayBoxToPage: (box: Box, rotation: number, crop: { x: number; y: number; width: number; height: number }) => Region
  drawPlacement: (region: Region, rotation: number) => { x: number; y: number; width: number; height: number }
  fitIntoBox: (box: Box, aspect: number, display: { w: number; h: number }) => Box
  normaliseBox: (box: unknown) => Box
  chunkAreas: (flat: number[]) => Array<{ page: number; box: number[] }>
  hexColor: (hex: string) => number[]
  findTextBoxes: (content: unknown, viewport: unknown, terms: string[], patterns: boolean) => Box[]
  dominantTextAngle: (content: unknown, transform: number[]) => number | null
}

let plugin: ReturnType<typeof loadPlugin>
let h: Helpers
let pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.mjs')
const hasFont = existsSync('public/vendor/fonts/NotoSansSC-Regular.ttf')

beforeAll(async () => {
  plugin = loadPlugin('src/plugins/builtin/pdf-tools.js', ['pdf-lib'])
  // The plugin file is a sloppy-mode script, so its function declarations are globals.
  h = globalThis as unknown as Helpers
  pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  ;(globalThis as Record<string, unknown>).pdfjsLib = pdfjs
})

const asPdf = (name: string, bytes: Uint8Array) => ({ name, content: bytes, type: 'application/pdf' })
const close = (a: number, b: number, eps = 0.01) => Math.abs(a - b) < eps

async function openWithPdfjs(bytes: Uint8Array) {
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false, disableFontFace: true })
  const doc = await task.promise
  return Object.assign(doc, { destroy: () => task.destroy() })
}

/** A page for each rotation, with a crop box offset from the media box origin. */
async function rotatedPages() {
  const doc = await PDFDocument.create()
  for (const rotation of [0, 90, 180, 270]) {
    const page = doc.addPage([400, 600])
    page.setCropBox(20, 30, 300, 500)
    page.setRotation(degrees(rotation))
  }
  return doc.save()
}

describe('display box → page space', () => {
  it('matches the pdf.js viewport for every rotation and a cropped page', async () => {
    const pdf = await openWithPdfjs(await rotatedPages())
    for (let n = 1; n <= 4; n++) {
      const page = await pdf.getPage(n)
      const viewport = page.getViewport({ scale: 1 })
      const rotation = (n - 1) * 90
      const box: Box = [0.1, 0.2, 0.3, 0.15]
      const region = h.displayBoxToPage(box, rotation, { x: 20, y: 30, width: 300, height: 500 })
      // Every corner of the region lands on a corner of the displayed box.
      const corners = [
        [region.x1, region.y1], [region.x2, region.y1], [region.x1, region.y2], [region.x2, region.y2],
      ].map(([x, y]) => {
        const [vx, vy] = viewport.convertToViewportPoint(x, y)
        return [vx / viewport.width, vy / viewport.height]
      })
      const xs = corners.map((c) => c[0])
      const ys = corners.map((c) => c[1])
      expect(close(Math.min(...xs), 0.1), `rotation ${rotation} left`).toBe(true)
      expect(close(Math.max(...xs), 0.4), `rotation ${rotation} right`).toBe(true)
      expect(close(Math.min(...ys), 0.2), `rotation ${rotation} top`).toBe(true)
      expect(close(Math.max(...ys), 0.35), `rotation ${rotation} bottom`).toBe(true)
    }
    await pdf.destroy()
  })

  it('draws rotated content that fills the region and reads upright', async () => {
    const pdf = await openWithPdfjs(await rotatedPages())
    for (let n = 1; n <= 4; n++) {
      const rotation = (n - 1) * 90
      const viewport = (await pdf.getPage(n)).getViewport({ scale: 1 })
      const region = h.displayBoxToPage([0.2, 0.1, 0.5, 0.2], rotation, { x: 20, y: 30, width: 300, height: 500 })
      const { x, y, width, height } = h.drawPlacement(region, rotation)
      // pdf-lib: translate(x, y) · rotate(θ, counter-clockwise) · scale(width, height) on the unit square.
      const t = (rotation * Math.PI) / 180
      const at = (s: number, u: number) => [x + Math.cos(t) * s * width - Math.sin(t) * u * height, y + Math.sin(t) * s * width + Math.cos(t) * u * height]
      const pts = [at(0, 0), at(1, 0), at(0, 1), at(1, 1)]
      expect(close(Math.min(...pts.map((p) => p[0])), region.x1, 1e-6)).toBe(true)
      expect(close(Math.max(...pts.map((p) => p[0])), region.x2, 1e-6)).toBe(true)
      expect(close(Math.min(...pts.map((p) => p[1])), region.y1, 1e-6)).toBe(true)
      expect(close(Math.max(...pts.map((p) => p[1])), region.y2, 1e-6)).toBe(true)
      // Upright on screen: the content's origin is bottom-left and its x axis points right.
      const [ox, oy] = viewport.convertToViewportPoint(...(at(0, 0) as [number, number]))
      const [rx, ry] = viewport.convertToViewportPoint(...(at(1, 0) as [number, number]))
      const [ux, uy] = viewport.convertToViewportPoint(...(at(0, 1) as [number, number]))
      expect(rx > ox && close(ry, oy), `rotation ${rotation} x axis`).toBe(true)
      expect(uy < oy && close(ux, ox), `rotation ${rotation} y axis`).toBe(true)
    }
    await pdf.destroy()
  })

  it('fits content into the box by aspect ratio, centred', () => {
    const fitted = h.fitIntoBox([0.1, 0.1, 0.4, 0.2], 1, { w: 500, h: 500 })
    expect(fitted.map((v) => Math.round(v * 1000) / 1000)).toEqual([0.2, 0.1, 0.2, 0.2])
  })

  it('normalises boxes, areas and colours from untrusted state', () => {
    expect(h.normaliseBox([0.9, -1, 0.5, 2])).toEqual([0.5, 0, 0.5, 1])
    expect(h.normaliseBox('x')).toEqual([0.6, 0.8, 0.3, 0.1])
    expect(h.chunkAreas([1, 0.1, 0.1, 0.2, 0.2, 3, 0, 0, 1, 1, 9])).toEqual([
      { page: 1, box: [0.1, 0.1, 0.2, 0.2] },
      { page: 3, box: [0, 0, 1, 1] },
    ])
    expect(h.hexColor('#ff0000')).toEqual([1, 0, 0])
  })
})

describe('stamp', () => {
  it('places an image and text on a rotated page', async () => {
    const doc = await PDFDocument.create()
    doc.addPage([400, 600]).setRotation(degrees(90))
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
    const pdf = await doc.save()
    const { outputs, summary } = await plugin.run('stamp', [asPdf('a.pdf', pdf), { name: 'seal.png', content: new Uint8Array(png), type: 'image/png' }], { kind: 'image', box: [0.1, 0.1, 0.2, 0.2], page: 1 })
    expect(summary).toContain('图片')
    const out = await PDFDocument.load(outputs[0].bytes)
    expect(out.getPage(0).getRotation().angle).toBe(90)
    expect(outputs[0].bytes.length).toBeGreaterThan(pdf.length)
  })

  it.skipIf(!hasFont)('writes Chinese text to a page range', async () => {
    const doc = await PDFDocument.create()
    for (let i = 0; i < 3; i++) doc.addPage([400, 600])
    const { outputs } = await plugin.run('stamp', [asPdf('a.pdf', await doc.save())], { kind: 'text', text: '已审核 OK', pages: 'custom', range: '2-3' })
    const pdf = await openWithPdfjs(outputs[0].bytes)
    const texts = []
    for (let n = 1; n <= 3; n++) texts.push((await (await pdf.getPage(n)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(''))
    expect(texts[0]).toBe('')
    expect(texts[1]).toContain('已审核')
    expect(texts[2]).toContain('OK')
    await pdf.destroy()
  })

  it('refuses a signature before anything is drawn', async () => {
    const doc = await PDFDocument.create()
    doc.addPage()
    await expect(plugin.run('stamp', [asPdf('a.pdf', await doc.save())], { kind: 'draw' })).rejects.toThrow('签名板')
  })
})

describe('fill-form', () => {
  async function formPdf() {
    const doc = await PDFDocument.create()
    const page = doc.addPage([400, 400])
    const form = doc.getForm()
    form.createTextField('applicant.name').addToPage(page, { x: 20, y: 300, width: 200, height: 24 })
    form.createCheckBox('agree').addToPage(page, { x: 20, y: 250, width: 16, height: 16 })
    const choice = form.createDropdown('city')
    choice.addOptions(['Beijing', 'Shanghai'])
    choice.addToPage(page, { x: 20, y: 200, width: 120, height: 24 })
    const locked = form.createTextField('ref')
    locked.setText('R-1')
    locked.enableReadOnly()
    locked.addToPage(page, { x: 20, y: 150, width: 120, height: 24 })
    return doc.save()
  }

  it('fills text, checkbox and choice fields', async () => {
    const { outputs, summary } = await plugin.run('fill-form', [asPdf('form.pdf', await formPdf())], { f0: 'Ada Lovelace', f1: true, f2: 'Shanghai', f3: 'R-2' })
    expect(summary).toContain('4')
    const form = (await PDFDocument.load(outputs[0].bytes)).getForm()
    expect(form.getTextField('applicant.name').getText()).toBe('Ada Lovelace')
    expect(form.getCheckBox('agree').isChecked()).toBe(true)
    expect(form.getDropdown('city').getSelected()).toEqual(['Shanghai'])
    expect(form.getTextField('ref').getText()).toBe('R-2')
  })

  it.skipIf(!hasFont)('fills Chinese values and flattens', async () => {
    const { outputs } = await plugin.run('fill-form', [asPdf('form.pdf', await formPdf())], { f0: '张三', flatten: true })
    const out = await PDFDocument.load(outputs[0].bytes)
    expect(out.getForm().getFields()).toHaveLength(0)
    const pdf = await openWithPdfjs(outputs[0].bytes)
    const text = (await (await pdf.getPage(1)).getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join('')
    expect(text).toContain('张三')
    await pdf.destroy()
  })
})

describe('portfolio', () => {
  it('marks the catalog as a collection opening on attachments', async () => {
    const doc = await PDFDocument.create()
    doc.addPage()
    const { outputs } = await plugin.run('attachments', [asPdf('cover.pdf', await doc.save()), { name: 'notes.txt', content: 'hello', type: 'text/plain' }], { mode: 'portfolio' })
    expect(outputs[0].name).toBe('cover-portfolio.pdf')
    // The catalog lives in an object stream, so inspect it through pdf-lib rather than the raw bytes.
    const out = await PDFDocument.load(outputs[0].bytes)
    const collection = out.catalog.lookup(PDFName.of('Collection'), PDFDict)
    expect(collection.get(PDFName.of('View'))).toBe(PDFName.of('T'))
    expect(out.catalog.get(PDFName.of('PageMode'))).toBe(PDFName.of('UseAttachments'))
  })
})

describe('text search and orientation', () => {
  async function textPdf(rotate: number) {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const page = doc.addPage([600, 600])
    const lines = ['Contact: ada@example.com', 'Phone 13800138000', 'Quarterly report for the board']
    lines.forEach((line, i) => page.drawText(line, { x: 300, y: 300 - i * 20, size: 12, font, rotate: degrees(rotate) }))
    return doc.save()
  }

  it('boxes search terms and sensitive patterns', async () => {
    const pdf = await openWithPdfjs(await textPdf(0))
    const page = await pdf.getPage(1)
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()
    expect(h.findTextBoxes(content, viewport, ['report'], false)).toHaveLength(1)
    const boxes = h.findTextBoxes(content, viewport, [], true)
    expect(boxes).toHaveLength(2)
    // The e-mail sits on the first line, left edge at x = 300 + "Contact: " width.
    const [x, y, w, hgt] = boxes[0]
    expect(x).toBeGreaterThan(0.5)
    expect(x + w).toBeLessThan(1)
    expect(y).toBeLessThan(0.5)
    expect(y + hgt).toBeGreaterThan(0.48)
    await pdf.destroy()
  })

  it('reports the rotation that makes text upright', async () => {
    for (const [drawn, expected] of [[0, 0], [90, 90], [180, 180], [270, 270]]) {
      const pdf = await openWithPdfjs(await textPdf(drawn))
      const page = await pdf.getPage(1)
      const angle = h.dominantTextAngle(await page.getTextContent(), page.getViewport({ scale: 1 }).transform)
      expect(angle, `text drawn at ${drawn}°`).toBe(expected)
      await pdf.destroy()
    }
  })

  it('declines to guess on pages without text', async () => {
    const doc = await PDFDocument.create()
    doc.addPage()
    const pdf = await openWithPdfjs(await doc.save())
    const page = await pdf.getPage(1)
    expect(h.dominantTextAngle(await page.getTextContent(), page.getViewport({ scale: 1 }).transform)).toBeNull()
    await pdf.destroy()
  })
})
