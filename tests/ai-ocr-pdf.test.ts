/**
 * The invisible text layer of OCR's searchable-PDF output: text must be
 * extractable where the line was recognised, and not painted.
 */
import { existsSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import * as PDFLib from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { loadPlugin } from './harness/plugin'

type Line = { text: string; box: number[]; vertical?: boolean }
let placeHiddenLine: (page: PDFLib.PDFPage, font: PDFLib.PDFFont, line: Line, s: number, pageHeight: number, lib: typeof PDFLib) => void
const FONT = 'public/vendor/fonts/NotoSansSC-Regular.ttf'

beforeAll(() => {
  loadPlugin('src/plugins/builtin/ai-tools.js')
  placeHiddenLine = (globalThis as unknown as { placeHiddenLine: typeof placeHiddenLine }).placeHiddenLine
})

describe.skipIf(!existsSync(FONT))('searchable PDF text layer', () => {
  it('places recognised lines as invisible, extractable text at their boxes', async () => {
    const doc = await PDFLib.PDFDocument.create()
    doc.registerFontkit(fontkit)
    const font = await doc.embedFont(readFileSync(FONT), { subset: true })
    // A 1000 × 800 px scan at 0.5 pt per px → a 500 × 400 pt page.
    const page = doc.addPage([500, 400])
    placeHiddenLine(page, font, { text: '本地离线识别 OCR', box: [100, 100, 400, 60] }, 0.5, 400, PDFLib)
    placeHiddenLine(page, font, { text: 'Hello, OmniTool!', box: [100, 300, 300, 40] }, 0.5, 400, PDFLib)
    const bytes = await doc.save()

    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false, disableFontFace: true })
    const pdf = await task.promise
    const content = await (await pdf.getPage(1)).getTextContent()
    const items = content.items.filter((i): i is { str: string; transform: number[]; width: number } => 'str' in i && !!i.str.trim())
    await task.destroy()

    const cjk = items.find((i) => i.str.includes('本地离线识别'))!
    const latin = items.find((i) => i.str.includes('Hello'))!
    expect(cjk).toBeTruthy()
    expect(latin).toBeTruthy()
    // x at the box's left edge (100 px · 0.5), baseline 80% down the box (400 - 148 · 0.5).
    expect(cjk.transform[4]).toBeCloseTo(50, 0)
    expect(cjk.transform[5]).toBeCloseTo(400 - (100 + 60 * 0.8) * 0.5, 0)
    // Never wider than the recognised box.
    expect(cjk.width).toBeLessThanOrEqual(200.5)
    expect(latin.width).toBeLessThanOrEqual(150.5)
    // Painted with a fully transparent graphics state (inside an object stream, so read it via pdf-lib).
    const loaded = await PDFLib.PDFDocument.load(bytes)
    const states = loaded.getPage(0).node.Resources()!.lookup(PDFLib.PDFName.of('ExtGState'), PDFLib.PDFDict)
    const alphas = states.values().map((ref) => loaded.context.lookup(ref, PDFLib.PDFDict).get(PDFLib.PDFName.of('ca'))?.toString())
    expect(alphas).toContain('0')
  })
})
