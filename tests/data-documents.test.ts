import { existsSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { strFromU8, unzipSync } from 'fflate'
import { XMLValidator } from 'fast-xml-parser'
import { loadPlugin } from './harness/plugin'

let plugin: ReturnType<typeof loadPlugin>

beforeAll(() => {
  plugin = loadPlugin('src/plugins/builtin/data-tools.js', ['data-libs'])
})

const fontVendored = existsSync('public/vendor/fonts/NotoSansSC-Regular.ttf')

describe('spreadsheet', () => {
  it('reads GBK CSV from Chinese Excel and writes a real xlsx', async () => {
    const gbk = new Uint8Array([...new TextEncoder().encode('id,'), 0xc3, 0xfb, 0xb3, 0xc6, 0x0a, 0x31, 0x2c, 0xc6, 0xbb, 0xb9, 0xfb, 0x0a]) // id,名称\n1,苹果
    const result = await plugin.run('spreadsheet', [{ name: 'fruits.csv', content: gbk, type: 'text/csv' }], { target: 'xlsx', merge: true })
    expect(result.outputs[0].name).toBe('fruits.xlsx')
    const book = XLSX.read(result.outputs[0].bytes, { type: 'array' })
    expect(XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]])).toEqual([{ id: 1, 名称: '苹果' }])
  })

  it('merges several CSV files into one workbook, one sheet each', async () => {
    const result = await plugin.run('spreadsheet', [{ name: 'a.csv', content: 'x\n1' }, { name: 'b.csv', content: 'y\n2' }], { target: 'xlsx', merge: true })
    expect(result.outputs.map((o) => o.name)).toEqual(['merged.xlsx'])
    expect(XLSX.read(result.outputs[0].bytes, { type: 'array' }).SheetNames).toEqual(['a', 'b'])
  })

  it('exports every sheet of a workbook, with a BOM for Windows Excel', async () => {
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['名称', '数量'], ['苹果', 3]]), '库存')
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['a'], [1]]), 'Other')
    const bytes = new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' }))
    const result = await plugin.run('spreadsheet', [{ name: 'stock.xlsx', content: bytes }], { target: 'csv', sheets: 'all', bom: true })
    expect(result.outputs.map((o) => o.name)).toEqual(['stock-库存.csv', 'stock-Other.csv'])
    // TextDecoder drops a BOM when decoding, so check the bytes.
    expect([...result.outputs[0].bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(result.outputs[0].text).toBe('名称,数量\n苹果,3')
  })

  it('renders a Markdown table, escaping pipes', async () => {
    const result = await plugin.run('spreadsheet', [{ name: 't.json', content: JSON.stringify([{ a: 'x|y', b: 2 }]) }], { target: 'markdown', sheets: 'first' })
    expect(result.outputs[0].text).toBe('| a | b |\n| --- | --- |\n| x\\|y | 2 |\n')
  })
})

describe('ebook', () => {
  it('builds a valid EPUB 3 container with chapters split at H1 and a cover', async () => {
    const markdown = '# 第一章\n\n正文一。<br>\n\n![图](x.png)\n\n# 第二章\n\n- 列表\n\n---\n\n正文二'
    const cover = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
    const result = await plugin.run('ebook', [{ name: 'novel.md', content: markdown }, { name: 'cover.jpg', content: cover, type: 'image/jpeg' }], { title: '小说', author: '作者', language: 'zh-CN', splitHeadings: true })
    const epub = result.outputs[0].bytes
    // `mimetype` first, stored: readers sniff these exact bytes at offset 30.
    expect(strFromU8(epub.subarray(30, 38))).toBe('mimetype')
    expect(strFromU8(epub.subarray(38, 58))).toBe('application/epub+zip')
    const files = unzipSync(epub)
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/nav.xhtml', 'OEBPS/chapter-001.xhtml', 'OEBPS/chapter-002.xhtml', 'OEBPS/cover.jpg']))
    for (const [name, data] of Object.entries(files)) {
      if (/\.(xhtml|opf|ncx|xml)$/.test(name)) expect(XMLValidator.validate(strFromU8(data)), name).toBe(true)
    }
    expect(strFromU8(files['OEBPS/nav.xhtml'])).toContain('第二章')
    expect(strFromU8(files['OEBPS/content.opf'])).toContain('<dc:creator>作者</dc:creator>')
    expect(result.summary).toBe('已生成 2 章的电子书')
  })

  it('treats plain text literally, one paragraph per blank-line block', async () => {
    const result = await plugin.run('ebook', [{ name: '日记.txt', content: '# 不是标题\n第一行\n\n*不是强调*' }], { splitHeadings: true })
    const chapter = strFromU8(unzipSync(result.outputs[0].bytes)['OEBPS/chapter-001.xhtml'])
    expect(chapter).toContain('# 不是标题')
    expect(chapter).toContain('*不是强调*')
    expect(chapter).not.toContain('<h1>')
  })
})

describe('email', () => {
  it('extracts headers, bodies and attachments from an EML', async () => {
    const eml = [
      'From: =?UTF-8?B?5byg5LiJ?= <zhang@example.com>',
      'To: li@example.com',
      'Subject: =?UTF-8?B?5rWL6K+V6YKu5Lu2?=',
      'Date: Mon, 1 Sep 2026 10:00:00 +0800',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      '--b1',
      'Content-Type: multipart/alternative; boundary="b2"',
      '',
      '--b2',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '你好',
      '--b2',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>你好<img src="https://tracker.invalid/p.gif"></p>',
      '--b2--',
      '--b1',
      'Content-Type: application/pdf; name="=?UTF-8?B?5ZCI5ZCMLnBkZg==?="',
      'Content-Disposition: attachment; filename="=?UTF-8?B?5ZCI5ZCMLnBkZg==?="',
      'Content-Transfer-Encoding: base64',
      '',
      'JVBERi0=',
      '--b1--',
      '',
    ].join('\r\n')
    const result = await plugin.run('email', [{ name: 'mail.eml', content: eml }])
    const files = Object.fromEntries(result.outputs.map((o) => [o.name, o]))
    expect(Object.keys(files).sort()).toEqual(['mail/attachments/合同.pdf', 'mail/headers.json', 'mail/message.html', 'mail/message.txt'])
    expect(JSON.parse(files['mail/headers.json'].text)).toMatchObject({ subject: '测试邮件', from: '张三 <zhang@example.com>', to: ['li@example.com'] })
    expect(files['mail/message.txt'].text.trim()).toBe('你好')
    expect(files['mail/message.html'].text).toContain('测试邮件')
    expect(files['mail/attachments/合同.pdf'].text).toBe('%PDF-')
    expect(result.summary).toBe('已解析 1 封邮件，导出 1 个附件')
  })
})

describe('chart', () => {
  const svgOf = async (csv: string, params: Record<string, unknown>) =>
    (await plugin.run('chart', [{ name: 'sales.csv', content: csv }], { png: false, width: 800, height: 400, ...params })).outputs[0].text

  it('draws grouped bars for every numeric series with a legend', async () => {
    const svg = await svgOf('月份,北京,上海\n1月,120,90\n2月,150,"1,200"\n3月,-30,80', { type: 'bar', title: '销量' })
    expect(XMLValidator.validate(svg)).toBe(true)
    // Bars only: legend swatches are 12 px wide.
    expect(svg.match(/<rect (?![^>]*width="12")[^>]*rx="2" fill="#/g)?.length).toBe(6)
    expect(svg).toContain('销量')
    expect(svg).toContain('>上海<')
  })

  it('draws a pie from the first numeric column with percentages', async () => {
    const svg = await svgOf('类别,占比\nA,1\nB,1\nC,2', { type: 'pie' })
    expect(svg).toContain('50.0%')
    expect(svg.match(/<path /g)?.length).toBe(3)
  })

  it('explains a table without numbers', async () => {
    await expect(svgOf('a,b\nx,y', { type: 'line' })).rejects.toThrow(/没有找到数值列/)
  })
})

describe.skipIf(!fontVendored)('markdown-pdf', () => {
  let pdfText: (bytes: Uint8Array) => Promise<{ pages: number; text: string; title: string }>

  beforeAll(async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    pdfText = async (bytes) => {
      const doc = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false, disableFontFace: true }).promise
      let text = ''
      for (let i = 1; i <= doc.numPages; i++) {
        const content = await (await doc.getPage(i)).getTextContent()
        text += content.items.map((item) => ('str' in item ? item.str : '')).join('')
      }
      const meta = await doc.getMetadata()
      return { pages: doc.numPages, text, title: String((meta.info as Record<string, unknown>).Title ?? '') }
    }
  })

  it('typesets every block type and keeps all the text', async () => {
    const markdown = [
      '# 季度报告',
      '',
      '这是一段**中文正文**，混合 English words 与数字 2026。',
      '',
      '## 列表',
      '',
      '1. 第一项',
      '2. 第二项',
      '   - 嵌套项',
      '- [x] 已完成任务',
      '',
      '> 引用的内容',
      '',
      '```js',
      'const answer = 42',
      '```',
      '',
      '| 名称 | 数量 |',
      '| --- | --- |',
      '| 苹果 | 3 |',
      '',
      '---',
      '',
      '结尾段落 END',
    ].join('\n')
    const result = await plugin.run('markdown-pdf', [{ name: 'report.md', content: markdown }], { paper: 'a4', fontSize: 10.5, pageNumbers: true, title: '' })
    expect(result.outputs[0].name).toBe('report.pdf')
    const { pages, text, title } = await pdfText(result.outputs[0].bytes)
    const squashed = text.replace(/\s+/g, '')
    for (const expected of ['季度报告', '这是一段中文正文，混合Englishwords与数字2026。', '第一项', '第二项', '嵌套项', '[x]已完成任务', '引用的内容', 'constanswer=42', '名称', '数量', '苹果', '结尾段落END', '1/1']) {
      expect(squashed, expected).toContain(expected)
    }
    expect(pages).toBe(1)
    expect(title).toBe('季度报告')
  }, 30000)

  it('flows long documents onto new pages and embeds only used glyphs', async () => {
    const markdown = Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 段：本地离线处理，文件不会离开浏览器。`).join('\n\n')
    const result = await plugin.run('markdown-pdf', [{ name: 'long.md', content: markdown }], { paper: 'a5', fontSize: 10, pageNumbers: true })
    const { pages, text } = await pdfText(result.outputs[0].bytes)
    expect(pages).toBeGreaterThan(3)
    expect(text.replace(/\s+/g, '')).toContain('第120段')
    // A subset of a 10 MB font: the whole document stays small.
    expect(result.outputs[0].bytes.length).toBeLessThan(200_000)
  }, 30000)

  it('embeds images supplied alongside the Markdown and marks missing ones', async () => {
    const png = await plugin.run('chart', [{ name: 'x.csv', content: 'a,b\nx,1' }], { png: false })
    expect(png.outputs.length).toBe(1)
    const tinyPng = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
    const result = await plugin.run('markdown-pdf', [
      { name: 'doc.md', content: '![图一](images/dot.png)\n\n![缺失](missing.png)' },
      { name: 'dot.png', content: tinyPng, type: 'image/png' },
    ], { paper: 'a4', fontSize: 10.5, pageNumbers: false })
    const { text } = await pdfText(result.outputs[0].bytes)
    expect(text).toContain('[图片：缺失]')
    expect(text).not.toContain('图一')
  }, 30000)
})
