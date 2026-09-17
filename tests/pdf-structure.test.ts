/**
 * Structural PDF tools (pdf-lib only), run for real in Node. Tools that render
 * or read text through pdf.js are covered in the browser by e2e/tools.mjs.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFString,
  decodePDFRawStream,
  rgb,
} from 'pdf-lib'
import { loadPlugin } from './harness/plugin'

let plugin: ReturnType<typeof loadPlugin>

beforeAll(() => {
  plugin = loadPlugin('src/plugins/builtin/pdf-tools.js', ['pdf-lib'])
})

const asInput = (name: string, bytes: Uint8Array) => ({ name, content: bytes, type: 'application/pdf' })

/** Pages whose content is a rectangle `10 × page number` wide, so order is recoverable. */
async function numberedPdf(count: number, size: [number, number] = [300, 400]) {
  const doc = await PDFDocument.create()
  for (let i = 1; i <= count; i++) {
    const page = doc.addPage(size)
    page.drawRectangle({ x: 5, y: 5, width: i * 10, height: 5, color: rgb(0, 0, 0) })
  }
  return doc.save()
}

/** A document carrying every kind of thing `sanitize` removes. */
async function riskyPdf() {
  const doc = await PDFDocument.create()
  const page = doc.addPage([300, 400])
  doc.setTitle('Secret title')
  doc.setAuthor('Someone')

  const form = doc.getForm()
  const field = form.createTextField('name')
  field.setText('Ada')
  field.addToPage(page, { x: 10, y: 300, width: 120, height: 20 })

  const context = doc.context
  const link = context.register(context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 50, 20], A: { S: 'URI', URI: PDFString.of('https://example.com/track') } }))
  const note = context.register(context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [60, 0, 80, 20], Contents: PDFString.of('note') }))
  page.node.addAnnot(link)
  page.node.addAnnot(note)

  const script = context.register(context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert("hi")') }))
  const jsTree = context.obj({ Names: [PDFHexString.fromText('init'), script] })
  context.obj({})
  doc.catalog.set(PDFName.of('Names'), context.obj({ JavaScript: jsTree }))
  doc.catalog.set(PDFName.of('OpenAction'), context.register(context.obj({ S: 'Launch', F: PDFString.of('calc.exe') })))

  await doc.attach(new TextEncoder().encode('payload'), 'a.txt', { mimeType: 'text/plain' })
  return doc.save()
}

function annotationKinds(doc: PDFDocument) {
  const annots = doc.getPage(0).node.Annots()
  if (!annots) return []
  return Array.from({ length: annots.size() }, (_, i) => (doc.context.lookup(annots.get(i)) as PDFDict).get(PDFName.of('Subtype'))!.toString())
}

describe('sanitize', () => {
  it('removes scripts, dangerous actions, links, notes, attachments and metadata, and flattens the form', async () => {
    const result = await plugin.run('sanitize', [asInput('risky.pdf', await riskyPdf())], {
      flatten: true, annotations: true, links: true, javascript: true, attachments: true, metadata: true, unlockFields: false,
    })
    expect(result.outputs[0].name).toBe('risky-clean.pdf')
    const doc = await PDFDocument.load(result.outputs[0].bytes)
    expect(doc.getForm().getFields()).toHaveLength(0)
    expect(annotationKinds(doc)).toEqual([])
    expect(doc.catalog.has(PDFName.of('OpenAction'))).toBe(false)
    const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)
    expect(names?.has(PDFName.of('JavaScript'))).toBeFalsy()
    expect(names?.has(PDFName.of('EmbeddedFiles'))).toBeFalsy()
    expect(doc.getTitle()).toBeUndefined()
    expect(doc.getAuthor()).toBeUndefined()
    expect(result.summary).toMatch(/扁平化 1 个表单字段/)
  })

  it('leaves what was not asked for', async () => {
    const result = await plugin.run('sanitize', [asInput('risky.pdf', await riskyPdf())], {
      flatten: false, annotations: false, links: false, javascript: true, attachments: false, metadata: false, unlockFields: false,
    })
    const doc = await PDFDocument.load(result.outputs[0].bytes)
    expect(annotationKinds(doc)).toEqual(['/Widget', '/Link', '/Text'])
    expect(doc.getForm().getFields()).toHaveLength(1)
    expect(doc.getTitle()).toBe('Secret title')
  })

  it('unlocks read-only fields instead of flattening', async () => {
    const source = await PDFDocument.create()
    const page = source.addPage()
    const field = source.getForm().createTextField('locked')
    field.addToPage(page, { x: 10, y: 10 })
    field.enableReadOnly()
    const result = await plugin.run('sanitize', [asInput('form.pdf', await source.save())], { flatten: true, unlockFields: true, javascript: false })
    const doc = await PDFDocument.load(result.outputs[0].bytes)
    expect(doc.getForm().getTextField('locked').isReadOnly()).toBe(false)
  })
})

describe('inspect-security', () => {
  it('reports scripts, launch actions, links and attachments', async () => {
    const result = await plugin.run('inspect-security', [asInput('risky.pdf', await riskyPdf())])
    const [report] = JSON.parse(result.outputs[0].text)
    expect(report.risk).toBe('high')
    expect(report.documentLevelScripts).toBe(true)
    expect(report.javascript.map((j: { code: string }) => j.code)).toContain('app.alert("hi")')
    expect(report.actions).toContainEqual(expect.objectContaining({ type: 'Launch', target: 'calc.exe' }))
    expect(report.links).toContain('https://example.com/track')
    expect(report.attachments).toEqual([{ name: 'a.txt', bytes: 7 }])
    expect(report.form.fields).toBe(1)
  })

  it('calls a plain document clean', async () => {
    const result = await plugin.run('inspect-security', [asInput('plain.pdf', await numberedPdf(2))])
    expect(JSON.parse(result.outputs[0].text)[0].risk).toBe('none')
    expect(result.summary).toMatch(/未发现/)
  })
})

describe('attachments', () => {
  it('round-trips files through add and extract', async () => {
    const added = await plugin.run('attachments', [
      asInput('doc.pdf', await numberedPdf(1)),
      { name: '数据.csv', content: 'a,b\n1,2', type: 'text/csv' },
      { name: 'img.bin', content: new Uint8Array([1, 2, 3]) },
    ], { mode: 'add', description: '附件说明' })
    expect(added.summary).toBe('已嵌入 2 个附件')

    const extracted = await plugin.run('attachments', [asInput('doc-attached.pdf', added.outputs[0].bytes)], { mode: 'extract' })
    const files = Object.fromEntries(extracted.outputs.map((o) => [o.name, o]))
    expect(Object.keys(files).sort()).toEqual(['doc-attached/img.bin', 'doc-attached/数据.csv'])
    expect(files['doc-attached/数据.csv'].text).toBe('a,b\n1,2')
    expect(Array.from(files['doc-attached/img.bin'].bytes)).toEqual([1, 2, 3])
  })

  it('explains an empty extraction', async () => {
    await expect(plugin.run('attachments', [asInput('x.pdf', await numberedPdf(1))], { mode: 'extract' })).rejects.toThrow(/没有附件/)
  })
})

/** Decoded operators of every content stream of a page, in paint order. */
function contentStreams(doc: PDFDocument, index: number): string[] {
  const contents = doc.getPage(index).node.Contents()
  const refs = contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, i) => contents.get(i)) : [contents]
  return refs.map((ref) => {
    const stream = doc.context.lookup(ref as PDFRef) as PDFRawStream
    return new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode())
  })
}

describe('overlay', () => {
  it('draws the overlay last in the foreground and first in the background', async () => {
    const base = await numberedPdf(2)
    const layer = await numberedPdf(1)
    for (const [position, expectFirst] of [['foreground', false], ['background', true]] as const) {
      const result = await plugin.run('overlay', [asInput('base.pdf', base), asInput('letterhead.pdf', layer)], { position, mapping: 'first', pages: '1-', opacity: 100 })
      const doc = await PDFDocument.load(result.outputs[0].bytes)
      for (const page of [0, 1]) {
        const streams = contentStreams(doc, page)
        const drawIndex = streams.findIndex((s) => /\/EmbeddedPdfPage-\w+ Do/.test(s))
        expect(drawIndex, `${position} p${page + 1}`).toBe(expectFirst ? 0 : streams.length - 1)
      }
      expect(result.summary).toMatch(/已在 2 页上叠加/)
    }
  })

  it('applies only to the requested pages and respects sequence mapping', async () => {
    const result = await plugin.run('overlay', [asInput('base.pdf', await numberedPdf(3)), asInput('two.pdf', await numberedPdf(2))], { position: 'foreground', mapping: 'sequence', pages: '2-3', opacity: 50 })
    expect(result.summary).toMatch(/已在 1 页上叠加/)
  })
})

/**
 * For an imposed sheet: which source page (by its rectangle width / 10) sits on
 * the left and right. Reads each placed form XObject's content.
 */
function sheetOrder(doc: PDFDocument, index: number): number[] {
  const page = doc.getPage(index)
  const xobjects = page.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict)
  const ops = contentStreams(doc, index).join('\n')
  // Each placement is `q`, a translate `cm`, maybe a scale, then `/Name Do`.
  const placed = [...ops.matchAll(/q\n1 0 0 1 ([\d.]+) [\d.]+ cm[^Q]*?\/(\S+) Do/g)].map((m) => ({ x: Number(m[1]), name: m[2] }))
  return placed
    .sort((a, b) => a.x - b.x)
    .map(({ name }) => {
      const form = doc.context.lookup(xobjects.get(PDFName.of(name))) as PDFRawStream
      const content = new TextDecoder('latin1').decode(decodePDFRawStream(form).decode())
      // drawRectangle emits a path (`0 5 l`, `<width> 5 l`, …): its widest point is the width.
      return Math.max(...[...content.matchAll(/(?<=\n)([\d.]+) 5 l(?=\n)/g)].map((m) => Number(m[1]))) / 10
    })
}

describe('booklet', () => {
  it('imposes 8 pages in saddle-stitch order', async () => {
    const result = await plugin.run('booklet', [asInput('zine.pdf', await numberedPdf(8))], { binding: 'left', creep: 0 })
    const doc = await PDFDocument.load(result.outputs[0].bytes)
    expect(doc.getPageCount()).toBe(4)
    expect(doc.getPage(0).getSize()).toEqual({ width: 600, height: 400 })
    expect([0, 1, 2, 3].map((i) => sheetOrder(doc, i))).toEqual([[8, 1], [2, 7], [6, 3], [4, 5]])
  })

  it('pads to a multiple of four with blanks and mirrors for right-to-left binding', async () => {
    const result = await plugin.run('booklet', [asInput('manga.pdf', await numberedPdf(5))], { binding: 'right', creep: 0 })
    const doc = await PDFDocument.load(result.outputs[0].bytes)
    expect(doc.getPageCount()).toBe(4)
    // Pages 6-8 do not exist: the outer front spread has only page 1, on the left.
    expect(sheetOrder(doc, 0)).toEqual([1])
    expect(sheetOrder(doc, 1)).toEqual([2])
    expect(sheetOrder(doc, 3)).toEqual([5, 4])
  })
})

describe('page-layout', () => {
  it('scales pages onto A4, centring them and keeping orientation', async () => {
    const result = await plugin.run('page-layout', [asInput('letter.pdf', await numberedPdf(2, [612, 792]))], { mode: 'fit', paper: 'a4', orientation: 'auto', amount: 10 })
    const doc = await PDFDocument.load(result.outputs[0].bytes)
    const box = doc.getPage(0).getMediaBox()
    expect(box.width).toBeCloseTo(595.28, 1)
    expect(box.height).toBeCloseTo(841.89, 1)
    const landscape = await plugin.run('page-layout', [asInput('wide.pdf', await numberedPdf(1, [800, 400]))], { mode: 'fit', paper: 'a4', orientation: 'auto', amount: 10 })
    const wide = (await PDFDocument.load(landscape.outputs[0].bytes)).getPage(0).getMediaBox()
    expect(wide.width).toBeGreaterThan(wide.height)
  })

  it('crops and adds margins by millimetres', async () => {
    const pts = (10 * 72) / 25.4
    const cropped = await PDFDocument.load((await plugin.run('page-layout', [asInput('a.pdf', await numberedPdf(1))], { mode: 'crop', amount: 10 })).outputs[0].bytes)
    expect(cropped.getPage(0).getCropBox().width).toBeCloseTo(300 - pts * 2, 3)
    const padded = await PDFDocument.load((await plugin.run('page-layout', [asInput('a.pdf', await numberedPdf(1))], { mode: 'margin', amount: 10 })).outputs[0].bytes)
    expect(padded.getPage(0).getMediaBox()).toMatchObject({ x: expect.closeTo(-pts, 3), width: expect.closeTo(300 + pts * 2, 3) })
  })

  it('refuses a crop that would leave nothing', async () => {
    await expect(plugin.run('page-layout', [asInput('a.pdf', await numberedPdf(1))], { mode: 'crop', amount: 200 })).rejects.toThrow(/裁边宽度过大/)
  })

  it('stacks every page into one long page', async () => {
    const source = await PDFDocument.create()
    source.addPage([300, 400])
    source.addPage([500, 200])
    const result = await plugin.run('page-layout', [asInput('a.pdf', await source.save())], { mode: 'single' })
    const doc = await PDFDocument.load(result.outputs[0].bytes)
    expect(doc.getPageCount()).toBe(1)
    expect(doc.getPage(0).getSize()).toEqual({ width: 500, height: 600 })
  })
})

/** Titles of an outline as indented lines, walking First/Next. */
function outlineLines(doc: PDFDocument): string[] {
  const lines: string[] = []
  const walk = (ref: unknown, depth: number) => {
    let current = ref
    while (current) {
      const item = doc.context.lookup(current as PDFRef) as PDFDict
      const title = (item.lookup(PDFName.of('Title')) as PDFHexString).decodeText()
      const dest = item.lookup(PDFName.of('Dest'), PDFArray)
      const pageIndex = doc.getPages().findIndex((p) => p.ref === dest.get(0))
      lines.push(`${'  '.repeat(depth)}${title} ${pageIndex + 1}`)
      if (item.has(PDFName.of('First'))) walk(item.get(PDFName.of('First')), depth + 1)
      current = item.get(PDFName.of('Next'))
    }
  }
  const outlines = doc.catalog.lookup(PDFName.of('Outlines'), PDFDict)
  walk(outlines.get(PDFName.of('First')), 0)
  return lines
}

describe('bookmarks: write', () => {
  it('builds a nested outline from indented "title page" lines', async () => {
    const text = '第一章 概述 1\n  1.1 背景 ...... 2\n\t1.2 目标\n    1.2.1 细节 3\n第二章 设计 5\n附录 99'
    const result = await plugin.run('bookmarks', [asInput('book.pdf', await numberedPdf(6))], { mode: 'write', outline: text })
    expect(result.summary).toBe('已写入 6 个书签')
    const doc = await PDFDocument.load(result.outputs[0].bytes)
    expect(outlineLines(doc)).toEqual([
      '第一章 概述 1',
      '  1.1 背景 2',
      '  1.2 目标 2',
      '    1.2.1 细节 3',
      '第二章 设计 5',
      '附录 6',
    ])
    expect(doc.catalog.get(PDFName.of('PageMode'))?.toString()).toBe('/UseOutlines')
  })

  it('rejects empty outline text', async () => {
    await expect(plugin.run('bookmarks', [asInput('book.pdf', await numberedPdf(1))], { mode: 'write', outline: '  \n' })).rejects.toThrow(/书签文本为空/)
  })
})
