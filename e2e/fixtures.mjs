import { deflateSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'
import { PDFDocument, PDFName, PDFString, StandardFonts, concatTransformationMatrix, degrees, drawObject, popGraphicsState, pushGraphicsState } from 'pdf-lib'

/** Builds a real PNG so the image plugin has something meaningful to re-encode. */
function makePng(width, height, path, pixel = (x, y) => [(x * 255) / width, (y * 255) / height, (x ^ y) & 0xff]) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let p = 0
  for (let y = 0; y < height; y++) {
    raw[p++] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y)
      raw[p++] = r
      raw[p++] = g
      raw[p++] = b
    }
  }

  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  writeFileSync(path, png)
  return png.length
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c
  }
  return t
})()
function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return ~c
}

async function makePdf(path, pages, label) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([300, 400])
    page.drawText(`${label} - page ${i + 1}`, { x: 40, y: 340, size: 18, font })
  }
  writeFileSync(path, await doc.save())
}

const dir = new URL('./', import.meta.url).pathname
console.log('png bytes:', makePng(512, 512, dir + 'sample.png'))
// A scanner bed with two tilted photos, for scan-split.
{
  const photos = [
    { cx: 260, cy: 220, w: 320, h: 220, angle: (5 * Math.PI) / 180 },
    { cx: 700, cy: 520, w: 280, h: 300, angle: (-8 * Math.PI) / 180 },
  ]
  makePng(1000, 760, dir + 'scan-bed.png', (x, y) => {
    for (const p of photos) {
      const dx = x + 0.5 - p.cx
      const dy = y + 0.5 - p.cy
      const u = dx * Math.cos(p.angle) + dy * Math.sin(p.angle)
      const v = -dx * Math.sin(p.angle) + dy * Math.cos(p.angle)
      if (Math.abs(u) <= p.w / 2 && Math.abs(v) <= p.h / 2) return [40 + (x & 63), 110 + (y & 31), 160]
    }
    return [245, 245, 240]
  })
}
await makePdf(dir + 'a.pdf', 2, 'Document A')
await makePdf(dir + 'b.pdf', 3, 'Document B')

// PDF tools that need pdf.js in a real browser: a blank page between two
// written ones, a large title plus an embedded photo, and a one-line edit of a.pdf.
{
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage([300, 400]).drawText('first', { x: 40, y: 340, size: 18, font })
  doc.addPage([300, 400])
  doc.addPage([300, 400]).drawText('third', { x: 40, y: 340, size: 18, font })
  const image = await doc.embedPng(readFileSync(dir + 'sample.png'))
  const cover = doc.insertPage(0, [300, 400])
  cover.drawText('Quarterly Report 2026', { x: 20, y: 360, size: 24, font })
  cover.drawText('small print', { x: 20, y: 330, size: 9, font })
  cover.drawImage(image, { x: 50, y: 60, width: 200, height: 200 })
  writeFileSync(dir + 'mixed.pdf', await doc.save())
}
{
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage([300, 400]).drawText('Document A - page 1', { x: 40, y: 340, size: 18, font })
  doc.addPage([300, 400]).drawText('Document A - page 2 revised', { x: 40, y: 340, size: 18, font })
  writeFileSync(dir + 'a-revised.pdf', await doc.save())
}
// qpdf tools: a password-protected PDF (made with the same qpdf bundle the app
// ships) and one with a broken cross-reference table.
{
  const { buildSync } = await import('esbuild')
  const source = buildSync({
    entryPoints: [new URL('../scripts/entries/qpdf.mjs', import.meta.url).pathname], bundle: true, format: 'iife', globalName: 'QpdfWasm',
    platform: 'browser', external: ['fs', 'path', 'crypto', 'worker_threads', 'url', 'module'], write: false,
    define: { 'process.versions': '{}', fetch: 'qpdfInlineFetch' }, inject: [new URL('../scripts/entries/qpdf-inline-fetch.mjs', import.meta.url).pathname],
    footer: { js: 'globalThis.QpdfWasm=QpdfWasm;' },
  }).outputFiles[0].text
  ;(0, eval)(source)
  const q = await globalThis.QpdfWasm.createQpdf(readFileSync(new URL('../node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.wasm', import.meta.url)))
  q.FS.writeFile('/a.pdf', readFileSync(dir + 'a.pdf'))
  const { code, output } = q.run(['--encrypt', 'open-sesame', 'owner-pw', '256', '--', '/a.pdf', '/locked.pdf'])
  if (code !== 0) throw new Error(`qpdf fixture failed: ${output}`)
  writeFileSync(dir + 'locked.pdf', q.FS.readFile('/locked.pdf'))

  const plain = await PDFDocument.create()
  const font = await plain.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 2; i++) plain.addPage([300, 400]).drawText(`repair me ${i}`, { x: 40, y: 300, size: 16, font })
  const text = Buffer.from(await plain.save({ useObjectStreams: false })).toString('latin1')
  writeFileSync(dir + 'broken.pdf', Buffer.from(text.replace(/startxref\s+\d+/, 'startxref\n99999'), 'latin1'))
}

// Placement tools: a fillable form, and a page whose text runs sideways.
{
  const doc = await PDFDocument.create()
  const page = doc.addPage([300, 400])
  const form = doc.getForm()
  form.createTextField('name').addToPage(page, { x: 40, y: 300, width: 200, height: 24 })
  form.createCheckBox('agree').addToPage(page, { x: 40, y: 250, width: 16, height: 16 })
  writeFileSync(dir + 'form.pdf', await doc.save())
}
{
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage([300, 400]).drawText('An upright page of text', { x: 40, y: 340, size: 14, font })
  const sideways = doc.addPage([300, 400])
  for (let i = 0; i < 3; i++) sideways.drawText(`This line was scanned sideways ${i + 1}`, { x: 60 + i * 20, y: 40, size: 12, font, rotate: degrees(90) })
  writeFileSync(dir + 'sideways.pdf', await doc.save())
}
// Text in an embedded CJK font. pdf.js draws such glyphs only through the
// embedded font (remapped to Private Use Area code points), so a renderer that
// fails to register fonts shows boxes. The font is subset here with
// fonteditor-core: pdf-lib's own subsetting drops glyphs of this font.
{
  const fontPath = new URL('../public/vendor/fonts/NotoSansSC-Regular.ttf', import.meta.url).pathname
  try {
    const { default: fontEditor } = await import('fonteditor-core')
    const { default: fontkit } = await import('@pdf-lib/fontkit')
    const text = '动手学深度学习'
    const subset = fontEditor.Font.create(readFileSync(fontPath), { type: 'ttf', subset: [...new Set([...text].map((c) => c.codePointAt(0)))], hinting: false })
    const bytes = subset.write({ type: 'ttf', toBuffer: true })
    writeFileSync(dir + 'cjk-embedded.ttf', bytes)
    const doc = await PDFDocument.create()
    doc.registerFontkit(fontkit)
    const font = await doc.embedFont(bytes, { subset: false })
    doc.addPage([400, 200]).drawText(text, { x: 20, y: 110, size: 44, font })
    writeFileSync(dir + 'cjk-embedded.pdf', await doc.save())
  } catch (error) {
    console.log('skipping cjk-embedded.pdf:', error.message)
  }
}

// Chinese text in a *non-embedded* font (STSong-Light, UniGB-UCS2-H encoding),
// as older Chinese PDFs have: pdf.js can only decode it with the bundled CMaps.
{
  const doc = await PDFDocument.create()
  const page = doc.addPage([400, 200])
  const ctx = doc.context
  const descriptor = ctx.register(ctx.obj({ Type: 'FontDescriptor', FontName: 'STSong-Light', Flags: 6, FontBBox: [0, -200, 1000, 900], ItalicAngle: 0, Ascent: 880, Descent: -120, CapHeight: 880, StemV: 80 }))
  const cidFont = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'CIDFontType0', BaseFont: 'STSong-Light', CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('GB1'), Supplement: 4 }, FontDescriptor: descriptor }))
  const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'STSong-Light-UniGB-UCS2-H', Encoding: 'UniGB-UCS2-H', DescendantFonts: [cidFont] }))
  page.node.setFontDictionary(PDFName.of('F1'), font)
  const hex = [...'动手学深度学习'].map((c) => c.codePointAt(0).toString(16).padStart(4, '0')).join('')
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(`BT /F1 40 Tf 20 100 Td <${hex}> Tj ET`)))
  writeFileSync(dir + 'cjk-cmap.pdf', await doc.save())
}

// A page whose only content is a JPEG 2000 image (solid red), like many scans.
// pdf.js decodes JPX only with its OpenJPEG wasm from the bundled data pack.
try {
  const { execFileSync: run } = await import('node:child_process')
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', '-c:v', 'jpeg2000', '-pix_fmt', 'rgb24', dir + 'red.jp2'])
  const doc = await PDFDocument.create()
  const page = doc.addPage([200, 200])
  const image = doc.context.register(doc.context.stream(readFileSync(dir + 'red.jp2'), { Type: 'XObject', Subtype: 'Image', Width: 64, Height: 64, Filter: 'JPXDecode' }))
  const name = page.node.newXObject('Im', image)
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(200, 0, 0, 200, 0, 0), drawObject(name), popGraphicsState())
  writeFileSync(dir + 'jpx.pdf', await doc.save())
} catch (error) {
  console.log('skipping jpx.pdf (needs ffmpeg with the jpeg2000 encoder):', error.message)
}

// A short test video with an audio track, for the media suites. Uses the system
// ffmpeg because the browser-side one is the thing under test.
import { execFileSync } from 'node:child_process'
import { copyFileSync } from 'node:fs'
try {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', dir + 'clip.mp4',
  ])
  copyFileSync(dir + 'clip.mp4', dir + 'clip2.mp4')
  // Different size and no audio track: what concat must normalise and pad.
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=160x90:rate=24',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', dir + 'silent-small.mp4',
  ])
  // Ten-frame GIF and a TIFF: the image toolbox's ImageMagick engine cases.
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=120x80:rate=10', '-y', dir + 'anim.gif',
  ])
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=64x48', '-frames:v', '1', '-y', dir + 'scan.tiff',
  ])
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=4',
    '-c:a', 'aac', '-b:a', '96k', '-y', dir + 'tone.m4a',
  ])
} catch {
  console.warn('[fixtures] system ffmpeg not found; media checks will fail')
}
// Image batch 2: an SVG, a downscaled near-duplicate of sample.png, and a QR code to read back.
writeFileSync(dir + 'sample.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#16a34a"/><circle cx="32" cy="32" r="16" fill="#fff"/></svg>')
makePng(256, 256, dir + 'sample-small.png')
{
  const { prepareZXingModule, writeBarcode } = await import('zxing-wasm/full')
  await prepareZXingModule({ overrides: { wasmBinary: readFileSync(new URL('../node_modules/zxing-wasm/dist/full/zxing_full.wasm', import.meta.url)).buffer }, fireImmediately: true })
  const qr = await writeBarcode('OmniTool 扫码测试', { format: 'QRCode', scale: 6 })
  writeFileSync(dir + 'qr.png', new Uint8Array(await qr.image.arrayBuffer()))
}

// Documents batch: an email with an attachment, and a chapter of Markdown.
writeFileSync(dir + 'mail.eml', [
  'From: =?UTF-8?B?5byg5LiJ?= <zhang@example.com>', 'To: li@example.com', 'Subject: =?UTF-8?B?5rWL6K+V6YKu5Lu2?=', 'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"', '', '--b1', 'Content-Type: text/html; charset=utf-8', '', '<p>你好</p>', '--b1',
  'Content-Type: text/plain; name="note.txt"', 'Content-Disposition: attachment; filename="note.txt"', 'Content-Transfer-Encoding: base64', '', 'aGVsbG8=', '--b1--', '',
].join('\r\n'))
writeFileSync(dir + 'chapter.md', '# 第一章\n\n正文。\n\n# 第二章\n\n- 列表项\n\n| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |\n')

// Subtitles: UTF-8, and the same text in GBK as Chinese Windows tools save it.
{
  const srt = '1\n00:00:00,200 --> 00:00:02,500\n中文字幕 第一行\n\n2\n00:00:02,600 --> 00:00:03,000\nSecond line\n'
  writeFileSync(dir + 'sub.srt', srt)
  writeFileSync(dir + 'sub-gbk.srt', new Uint8Array([...new TextEncoder().encode('1\n00:00:00,200 --> 00:00:02,500\n'), 0xd6, 0xd0, 0xce, 0xc4, 0x0a]))
}

// A ZIP with folders and a Chinese name, for the archive toolbox.
const { zipSync, strToU8 } = await import('fflate')
writeFileSync(dir + 'bundle.zip', zipSync({ 'docs/readme.txt': strToU8('hello'), 'docs/图片/说明.md': strToU8('# 中文'), 'root.csv': strToU8('a,b\n1,2') }))

// Rendered by Chromium: text for OCR, and an object on a gradient for cutout / upscaling.
{
  const { chromium } = await import('playwright')
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 760, height: 260 } })
  await page.setContent(`<body style="margin:0;background:#fff;font-family:'Noto Sans CJK SC','Noto Sans CJK TC',sans-serif;padding:30px">
    <div style="font-size:44px;color:#111">本地离线识别 OCR 2026</div>
    <div style="font-size:36px;color:#333;margin-top:40px">Hello, OmniTool!</div></body>`)
  await page.screenshot({ path: dir + 'ocr.png' })
  await page.setViewportSize({ width: 160, height: 120 })
  await page.setContent(`<body style="margin:0;width:160px;height:120px;background:linear-gradient(135deg,#9ec9e8,#e8e1c9)">
    <div style="position:absolute;left:48px;top:24px;width:64px;height:72px;border-radius:50% 50% 40% 40%;background:radial-gradient(circle at 35% 30%,#ff9a6b,#c0392b)"></div></body>`)
  await page.screenshot({ path: dir + 'object.png' })
  // The same scene at twice the resolution: a true near-duplicate for similarity search.
  const retina = await browser.newPage({ viewport: { width: 160, height: 120 }, deviceScaleFactor: 2 })
  await retina.setContent(await page.content())
  await retina.screenshot({ path: dir + 'object-2x.png' })
  await browser.close()
}

console.log('fixtures written to', dir)
