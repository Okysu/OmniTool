/**
 * qpdf-backed PDF tools (protect, unlock, linearize) and pdf-lib repair, run
 * for real in Node with the same wasm the sandbox receives.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { loadPlugin } from './harness/plugin'

let plugin: ReturnType<typeof loadPlugin>

beforeAll(() => {
  plugin = loadPlugin('src/plugins/builtin/pdf-tools.js', ['pdf-lib'])
})

const asPdf = (name: string, bytes: Uint8Array) => ({ name, content: bytes, type: 'application/pdf' })
const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1')

async function samplePdf(pages = 3) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= pages; i++) doc.addPage([300, 400]).drawText(`page ${i}`, { x: 40, y: 300, font, size: 18 })
  return doc.save({ useObjectStreams: false })
}

describe('protect and unlock', () => {
  it('encrypts with AES-256 and a required open password', async () => {
    const { outputs, summary } = await plugin.run('protect', [asPdf('a.pdf', await samplePdf())], { userPassword: 'open-me', ownerPassword: 'boss' })
    expect(summary).toContain('需要密码才能打开')
    expect(outputs[0].name).toBe('a-protected.pdf')
    expect(latin1(outputs[0].bytes)).toMatch(/\/Encrypt/)
    expect(latin1(outputs[0].bytes)).toMatch(/\/V 5/)
    await expect(PDFDocument.load(outputs[0].bytes)).rejects.toThrow(/encrypted/i)

    await expect(plugin.run('unlock', [asPdf('a-protected.pdf', outputs[0].bytes)], { password: 'wrong' })).rejects.toThrow('密码不正确')
    const unlocked = await plugin.run('unlock', [asPdf('a-protected.pdf', outputs[0].bytes)], { password: 'open-me' })
    expect(latin1(unlocked.outputs[0].bytes)).not.toMatch(/\/Encrypt/)
    expect((await PDFDocument.load(unlocked.outputs[0].bytes)).getPageCount()).toBe(3)
  })

  it('restricts permissions without an open password, with a generated owner password', async () => {
    const { outputs, summary } = await plugin.run('protect', [asPdf('a.pdf', await samplePdf(1))], { print: 'none', modify: 'none', extract: false, strength: '128' })
    expect(summary).toContain('仅限制权限')
    expect(summary).toContain('随机生成')
    expect(latin1(outputs[0].bytes)).toMatch(/\/V 4/)
    // No open password: removing the restrictions needs none either.
    const unlocked = await plugin.run('unlock', [asPdf('r.pdf', outputs[0].bytes)], { password: '' })
    expect(latin1(unlocked.outputs[0].bytes)).not.toMatch(/\/Encrypt/)
  })

  it('notes when a file was not encrypted', async () => {
    const { summary } = await plugin.run('unlock', [asPdf('plain.pdf', await samplePdf(1))], { password: '' })
    expect(summary).toContain('本来就没有加密')
  })
})

describe('repair', () => {
  const damage = {
    'bad startxref': (t: string) => t.replace(/startxref\s+\d+/, 'startxref\n99999'),
    'wrong object offset': (t: string) => t.replace(/(\n)(\d{10}) 00000 n/, (_m, nl, off) => nl + String(Number(off) + 7).padStart(10, '0') + ' 00000 n'),
    'truncated before xref': (t: string) => t.slice(0, t.lastIndexOf('xref')),
    'junk before header': (t: string) => `GARBAGE\n${t}`,
  }
  for (const [name, corrupt] of Object.entries(damage)) {
    it(`rebuilds a PDF with ${name}`, async () => {
      const broken = Buffer.from(corrupt(latin1(await samplePdf())), 'latin1')
      const { outputs, summary } = await plugin.run('repair', [asPdf('broken.pdf', new Uint8Array(broken))])
      // qpdf itself tolerates a junk prefix, so that one reads as "nothing wrong, re-saved".
      expect(summary).toMatch(name === 'junk before header' ? /已重新保存（3 页）/ : /已修复.*共 3 页/)
      expect(latin1(outputs[0].bytes).startsWith('%PDF-')).toBe(true)
      const fixed = await PDFDocument.load(outputs[0].bytes)
      expect(fixed.getPageCount()).toBe(3)
    })
  }

  it('says when there was nothing to repair', async () => {
    const { summary } = await plugin.run('repair', [asPdf('ok.pdf', await samplePdf(2))])
    expect(summary).toContain('未发现结构错误')
  })

  it('refuses encrypted input with a pointer to unlock', async () => {
    const { outputs } = await plugin.run('protect', [asPdf('a.pdf', await samplePdf(1))], { userPassword: 'x', ownerPassword: 'y' })
    await expect(plugin.run('repair', [asPdf('e.pdf', outputs[0].bytes)])).rejects.toThrow('解除密码')
  })
})

describe('linearize', () => {
  it('writes a linearized file', async () => {
    const { outputs, summary } = await plugin.run('linearize', [asPdf('big.pdf', await samplePdf(4))], { objectStreams: true })
    expect(summary).toContain('已线性化 1 个 PDF')
    // The linearization dictionary is the first object in the file.
    expect(latin1(outputs[0].bytes).slice(0, 1024)).toMatch(/\/Linearized 1/)
    expect((await PDFDocument.load(outputs[0].bytes)).getPageCount()).toBe(4)
  })
})
