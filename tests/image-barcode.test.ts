import { beforeAll, describe, expect, it } from 'vitest'
import { loadPlugin } from './harness/plugin'

let plugin: ReturnType<typeof loadPlugin>

beforeAll(() => {
  plugin = loadPlugin('src/plugins/builtin/image-tools.js')
})

const text = (content: string) => ({ name: 'content.txt', content, type: 'text/plain' })

describe('barcode generation and reading', () => {
  it('round-trips a QR code with Chinese text through generate and read', async () => {
    const made = await plugin.run('barcode', [text('https://example.com/?q=本地工具')], { format: 'QRCode', ecLevel: 'H', scale: 6, output: 'png', perLine: false })
    expect(made.outputs[0].name).toBe('qrcode.png')
    const read = await plugin.run('barcode-read', [{ name: 'qrcode.png', content: made.outputs[0].bytes, type: 'image/png' }], { tryHarder: true, output: 'json' })
    const [result] = JSON.parse(read.outputs[0].text)
    expect(result).toMatchObject({ format: 'QRCode', text: 'https://example.com/?q=本地工具' })
  }, 30000)

  it('generates one code per line, named by index and content', async () => {
    const made = await plugin.run('barcode', [text('ABC-1\nABC-2\n\nABC 3\n')], { format: 'Code128', scale: 3, output: 'png', perLine: true })
    expect(made.outputs.map((o) => o.name)).toEqual(['001-ABC-1.png', '002-ABC-2.png', '003-ABC_3.png'])
    const read = await plugin.run('barcode-read', made.outputs.map((o) => ({ name: o.name, content: o.bytes, type: 'image/png' })), { tryHarder: true, output: 'text' })
    expect(read.outputs[0].text).toBe('001-ABC-1.png\tABC-1\n002-ABC-2.png\tABC-2\n003-ABC_3.png\tABC 3\n')
  }, 30000)

  it('writes SVG for print', async () => {
    const made = await plugin.run('barcode', [text('5901234123457')], { format: 'EAN13', scale: 4, output: 'svg' })
    expect(made.outputs[0].name).toBe('ean13.svg')
    expect(made.outputs[0].text).toMatch(/^<\?xml|^<svg/)
  })

  it('explains invalid EAN-13 input in plain words', async () => {
    await expect(plugin.run('barcode', [text('hello')], { format: 'EAN13', scale: 4, output: 'png' })).rejects.toThrow(/EAN-13 需要 12 或 13 位数字/)
  })

  it('reports when nothing is found', async () => {
    const blank = await plugin.run('barcode', [text('x')], { format: 'QRCode', scale: 2, output: 'svg' })
    await expect(plugin.run('barcode-read', [{ name: 'not-an-image.png', content: new TextEncoder().encode(blank.outputs[0].text), type: 'image/png' }], {})).rejects.toThrow()
  })
})
