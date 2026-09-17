import { createHash } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import YAML from 'yaml'
import Papa from 'papaparse'
import { XMLParser } from 'fast-xml-parser'
import { loadPlugin } from './harness/plugin'

let plugin: ReturnType<typeof loadPlugin>

beforeAll(() => {
  plugin = loadPlugin('src/plugins/builtin/data-tools.js', ['data-libs'])
})

type Input = { name: string; content: string | Uint8Array; type?: string }

async function one(tool: string, input: Input | Input[], params: Record<string, unknown> = {}) {
  const result = await plugin.run(tool, Array.isArray(input) ? input : [input], params)
  return result.outputs[0]
}

const convert = async (name: string, content: string, target: string, params: Record<string, unknown> = {}) =>
  one('convert', { name, content }, { target, ...params })

const csvRows = (text: string, delimiter = ',') => Papa.parse<string[]>(text, { delimiter, skipEmptyLines: true }).data

/* ------------------------------------------------------------------------ */

describe('convert: format detection for pasted text', () => {
  const cases: Array<[string, string, unknown]> = [
    ['JSON object', '{"a":1}', { a: 1 }],
    ['JSON array', '[1,2]', [1, 2]],
    ['YAML flow mapping (starts with { but is not JSON)', '{a: 1, b: [x, y]}', { a: 1, b: ['x', 'y'] }],
    ['YAML block', 'name: x\ntags:\n  - a\n  - b', { name: 'x', tags: ['a', 'b'] }],
    ['YAML whose value contains commas', 'title: a, b, c\nnote: d, e, f', { title: 'a, b, c', note: 'd, e, f' }],
    ['CSV', 'a,b\n1,2\n3,4', [{ a: '1', b: '2' }, { a: '3', b: '4' }]],
    ['TSV', 'a\tb\n1\t2', [{ a: '1', b: '2' }]],
    ['XML', '<r><x>1</x></r>', { r: { x: 1 } }],
  ]
  for (const [label, text, expected] of cases) {
    it(`detects ${label}`, async () => {
      const out = await convert('input.txt', text, 'json')
      expect(JSON.parse(out.text)).toEqual(expected)
    })
  }

  it('trusts the file extension over content sniffing', async () => {
    // Looks like CSV, but the extension says YAML: a plain scalar.
    const out = await convert('x.yaml', 'a,b', 'json')
    expect(JSON.parse(out.text)).toBe('a,b')
  })

  it('strips a UTF-8 BOM before parsing', async () => {
    const out = await convert('x.json', '\uFEFF{"k":"v"}', 'json')
    expect(JSON.parse(out.text)).toEqual({ k: 'v' })
  })
})

describe('convert: YAML', () => {
  it('resolves anchors, aliases and merge keys', async () => {
    const yaml = 'base: &b\n  host: localhost\n  port: 5432\ndev:\n  <<: *b\n  port: 6543\ncopy: *b'
    const data = JSON.parse((await convert('c.yaml', yaml, 'json')).text)
    expect(data.dev).toEqual({ host: 'localhost', port: 6543 })
    expect(data.copy).toEqual({ host: 'localhost', port: 5432 })
  })

  it('keeps block scalars (literal and folded) exactly', async () => {
    const yaml = 'literal: |\n  line 1\n  line 2\nfolded: >\n  a\n  b\n'
    const data = JSON.parse((await convert('s.yaml', yaml, 'json')).text)
    expect(data.literal).toBe('line 1\nline 2\n')
    expect(data.folded).toBe('a b\n')
  })

  it('turns a multi-document stream into an array', async () => {
    const data = JSON.parse((await convert('m.yaml', 'a: 1\n---\nb: 2\n---\n- 3', 'json')).text)
    expect(data).toEqual([{ a: 1 }, { b: 2 }, [3]])
  })

  it('keeps YAML 1.2 core types (yes/no stay strings, 0o17 is octal)', async () => {
    const data = JSON.parse((await convert('t.yaml', 'a: yes\nb: true\nc: 0o17\nd: ~\ne: "007"', 'json')).text)
    expect(data).toEqual({ a: 'yes', b: true, c: 15, d: null, e: '007' })
  })

  it('reports the line of a syntax error', async () => {
    await expect(convert('bad.yaml', 'a: 1\nb: [unclosed\nc: 2', 'json')).rejects.toThrow(/bad\.yaml 不是合法的 YAML（第 \d+ 行）/)
  })

  it('round-trips JSON → YAML → JSON with unicode, nesting and special strings', async () => {
    const data = { 名称: '中文', nested: { list: [1, 'two', null, true], empty: {} }, tricky: ['yes', '1.0', '#hash', 'a: b', '- dash', ''] }
    const yaml = (await convert('d.json', JSON.stringify(data), 'yaml')).text
    expect(YAML.parse(yaml)).toEqual(data)
    const back = JSON.parse((await convert('d.yaml', yaml, 'json')).text)
    expect(back).toEqual(data)
  })

  it('does not wrap long strings', async () => {
    const long = 'word '.repeat(60).trim()
    const yaml = (await convert('l.json', JSON.stringify({ long }), 'yaml')).text
    expect(yaml.trim().split('\n')).toHaveLength(1)
  })
})

describe('convert: JSON', () => {
  it('honours indent and sortKeys (deeply)', async () => {
    const out = await convert('x.json', '{"b":{"z":1,"a":2},"a":[{"d":1,"c":2}]}', 'json', { indent: 4, sortKeys: true })
    expect(out.text).toBe(JSON.stringify({ a: [{ c: 2, d: 1 }], b: { a: 2, z: 1 } }, null, 4))
    expect(Object.keys(JSON.parse(out.text))).toEqual(['a', 'b'])
  })

  it('names outputs after the input and gives them a type', async () => {
    const out = await convert('report.final.yaml', 'a: 1', 'json')
    expect(out.name).toBe('report.final.json')
    expect(out.type).toBe('application/json')
  })

  it('reports JSON errors with line and column', async () => {
    await expect(convert('bad.json', '{\n  "a": 1,\n  "b": oops\n}', 'yaml')).rejects.toThrow(/第 3 行第 8 列/)
  })

  const located: Array<[string, string, string]> = [
    ['trailing comma', '{"a":1,}', '第 1 行第 8 列'],
    ['single quotes', "{'a':1}", '第 1 行第 2 列'],
    ['unterminated string', '{"a":"x', '第 1 行第 8 列'],
    ['bad escape', '["\\q"]', '第 1 行第 4 列'],
    ['leading zero', '[01]', '第 1 行第 3 列'],
    ['trailing garbage', '{}\n\nx', '第 3 行第 1 列'],
    ['raw newline in string', '["a\nb"]', '第 1 行第 4 列'],
  ]
  for (const [label, source, where] of located) {
    it(`locates a ${label}`, async () => {
      await expect(convert('bad.json', source, 'yaml')).rejects.toThrow(where)
    })
  }
})

describe('convert: CSV / TSV', () => {
  it('parses quoted fields with commas, quotes and newlines', async () => {
    const csv = 'name,note\n"Smith, J","said ""hi""\nthen left"\nplain,x'
    const data = JSON.parse((await convert('q.csv', csv, 'json')).text)
    expect(data).toEqual([
      { name: 'Smith, J', note: 'said "hi"\nthen left' },
      { name: 'plain', note: 'x' },
    ])
  })

  it('handles CRLF line endings and trailing blank lines', async () => {
    const data = JSON.parse((await convert('w.csv', 'a,b\r\n1,2\r\n\r\n', 'json')).text)
    expect(data).toEqual([{ a: '1', b: '2' }])
  })

  it('fills missing cells in ragged rows instead of failing', async () => {
    const data = JSON.parse((await convert('r.csv', 'a,b,c\n1,2\n3,4,5', 'json')).text)
    expect(data[0]).toEqual({ a: '1', b: '2', c: '' })
  })

  it('rejects unbalanced quotes with a row number', async () => {
    await expect(convert('u.csv', 'a,b\n"open,2\n3,4', 'json')).rejects.toThrow(/引号不匹配/)
  })

  it('flattens nested objects into dotted columns, and unions keys across records', async () => {
    const data = [{ id: 1, user: { name: 'a', geo: { city: 'x' } } }, { id: 2, extra: true }]
    const rows = csvRows((await convert('n.json', JSON.stringify(data), 'csv')).text)
    expect(rows[0]).toEqual(['id', 'user.name', 'user.geo.city', 'extra'])
    expect(rows[1]).toEqual(['1', 'a', 'x', ''])
    expect(rows[2]).toEqual(['2', '', '', 'true'])
  })

  it('serialises nested values as JSON when flatten is off', async () => {
    const rows = csvRows((await convert('n.json', '[{"a":{"b":1},"l":[1,2]}]', 'csv', { flatten: false })).text)
    expect(rows[1]).toEqual(['{"b":1}', '[1,2]'])
  })

  it('wraps scalars and a single object into rows', async () => {
    expect(csvRows((await convert('s.json', '[1,"two"]', 'csv')).text)).toEqual([['value'], ['1'], ['two']])
    expect(csvRows((await convert('o.json', '{"a":1}', 'csv')).text)).toEqual([['a'], ['1']])
  })

  it('round-trips awkward cells through CSV', async () => {
    const data = [{ text: 'comma, "quote"\nnewline', emoji: '😀', lead: ' space ' }]
    const csv = (await convert('a.json', JSON.stringify(data), 'csv')).text
    expect(JSON.parse((await convert('a.csv', csv, 'json')).text)).toEqual(data)
  })

  it('writes TSV with tabs and the right type', async () => {
    const out = await convert('t.json', '[{"a":1,"b":2}]', 'tsv')
    expect(out.name).toBe('t.tsv')
    expect(out.text).toBe('a\tb\n1\t2')
  })
})

describe('convert: XML', () => {
  const parse = (xml: string) => {
    const tree = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', textNodeName: '#text' }).parse(xml)
    delete tree['?xml']
    return tree
  }

  it('maps attributes, repeated elements and mixed text', async () => {
    const xml = '<?xml version="1.0"?><lib><book id="1" lang="en">A</book><book id="2">B</book><meta/></lib>'
    const data = JSON.parse((await convert('b.xml', xml, 'json')).text)
    expect(data).toEqual({
      lib: {
        book: [
          // Attribute values stay strings: typing them would turn id="007" into 7.
          { '#text': 'A', '@id': '1', '@lang': 'en' },
          { '#text': 'B', '@id': '2' },
        ],
        meta: '',
      },
    })
    expect(data['?xml']).toBeUndefined()
  })

  it('decodes entities and CDATA', async () => {
    const data = JSON.parse((await convert('e.xml', '<r><a>1 &lt; 2 &amp; 3</a><b><![CDATA[<raw> & stuff]]></b></r>', 'json')).text)
    expect(data.r.a).toBe('1 < 2 & 3')
    expect(data.r.b).toBe('<raw> & stuff')
  })

  it('keeps leading zeros and hex-looking values as strings', async () => {
    const data = JSON.parse((await convert('z.xml', '<r><zip>007</zip><h>0x1F</h><n>42</n></r>', 'json')).text)
    expect(data.r).toEqual({ zip: '007', h: '0x1F', n: 42 })
  })

  it('reports malformed XML with a line number', async () => {
    await expect(convert('m.xml', '<r>\n<a></b>\n</r>', 'json')).rejects.toThrow(/m\.xml 不是合法的 XML（第 2 行）/)
  })

  it('wraps arrays in the root name as repeated <item> elements', async () => {
    const out = await convert('a.json', '[{"x":1},{"x":2}]', 'xml', { rootName: 'rows' })
    expect(out.text.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(parse(out.text)).toMatchObject({ rows: { item: [{ x: 1 }, { x: 2 }] } })
  })

  it('uses a single top-level key as the root, and wraps several keys', async () => {
    expect(parse((await convert('s.json', '{"config":{"a":1}}', 'xml')).text)).toMatchObject({ config: { a: 1 } })
    expect(parse((await convert('m.json', '{"a":1,"b":2}', 'xml', { rootName: 'doc' })).text)).toMatchObject({ doc: { a: 1, b: 2 } })
  })

  it('sanitises keys that are not valid XML names', async () => {
    const out = await convert('k.json', '{"root":{"first name":"x","1st":"y","ok-key":"z"}}', 'xml')
    const data = parse(out.text)
    expect(data.root).toEqual({ first_name: 'x', _1st: 'y', 'ok-key': 'z' })
  })

  it('escapes text content', async () => {
    const out = await convert('x.json', '{"r":{"a":"<b> & \\"c\\""}}', 'xml')
    expect(out.text).not.toContain('<b>')
    expect(parse(out.text).r.a).toBe('<b> & "c"')
  })

  it('round-trips XML → JSON → XML preserving attributes', async () => {
    const xml = '<cat><item sku="A1" qty="3">Pen</item><item sku="B2" qty="1">Ink</item></cat>'
    const json = (await convert('c.xml', xml, 'json')).text
    const back = parse((await convert('c.json', json, 'xml')).text)
    expect(back).toEqual(parse(xml))
  })
})

/* ------------------------------------------------------------------------ */

describe('json-format', () => {
  it('pretty-prints with the chosen indent', async () => {
    const out = await one('json-format', { name: 'a.json', content: '{"a":[1,2]}' }, { indent: 3 })
    expect(out.name).toBe('a.formatted.json')
    expect(out.text).toBe('{\n   "a": [\n      1,\n      2\n   ]\n}')
  })

  it('minifies', async () => {
    const out = await one('json-format', { name: 'a.json', content: '{\n  "a" : 1 ,\n "b":[ 1 ]\n}' }, { mode: 'minify' })
    expect(out.name).toBe('a.min.json')
    expect(out.text).toBe('{"a":1,"b":[1]}')
  })

  it('extracts a path with dots and indices', async () => {
    const doc = JSON.stringify({ data: { users: [{ name: 'a' }, { name: '张三' }] } })
    const out = await one('json-format', { name: 'a.json', content: doc }, { path: 'data.users[1].name', mode: 'minify' })
    expect(JSON.parse(out.text)).toBe('张三')
  })

  it('names the segment where a path breaks', async () => {
    await expect(one('json-format', { name: 'a.json', content: '{"a":{"b":1}}' }, { path: 'a.c.d' })).rejects.toThrow(/在「c」处中断/)
  })

  it('reports syntax errors with line and column', async () => {
    await expect(one('json-format', { name: 'a.json', content: '{\n"a": 1,\n}' })).rejects.toThrow(/第 3 行第 1 列/)
  })

  it('keeps large integers and unicode escapes as JSON does', async () => {
    const out = await one('json-format', { name: 'a.json', content: '{"s":"\\u4e2d","n":1e3}' }, { mode: 'minify' })
    expect(out.text).toBe('{"s":"中","n":1000}')
  })
})

/* ------------------------------------------------------------------------ */

describe('csv-tools', () => {
  it('merges files, aligning columns by name and appending new ones', async () => {
    const result = await plugin.run(
      'csv-tools',
      [
        { name: 'a.csv', content: 'id,name\n1,a\n2,b' },
        { name: 'b.csv', content: 'name,id,city\nc,3,x' },
      ],
      { mode: 'merge' },
    )
    expect(result.outputs).toHaveLength(1)
    expect(csvRows(result.outputs[0].text)).toEqual([
      ['id', 'name', 'city'],
      ['1', 'a', ''],
      ['2', 'b', ''],
      ['3', 'c', 'x'],
    ])
    expect(result.summary).toContain('3 行、3 列')
  })

  it('splits by row count, repeating the header in every part', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => `${i},v${i}`).join('\n')
    const result = await plugin.run('csv-tools', [{ name: 'big.csv', content: `id,v\n${rows}` }], { mode: 'split', chunk: 2 })
    expect(result.outputs.map((o) => o.name)).toEqual(['big-part1.csv', 'big-part2.csv', 'big-part3.csv'])
    for (const output of result.outputs) expect(csvRows(output.text)[0]).toEqual(['id', 'v'])
    expect(csvRows(result.outputs[2].text)).toEqual([['id', 'v'], ['4', 'v4']])
  })

  it('keeps the input dialect (semicolon) when splitting', async () => {
    const result = await plugin.run('csv-tools', [{ name: 'eu.csv', content: 'a;b\n1,5;2\n"x;y";4' }], { mode: 'split', chunk: 1 })
    // A decimal comma needs no quoting under `;`; the delimiter itself does.
    expect(result.outputs[0].text).toBe('a;b\n1,5;2')
    expect(result.outputs[1].text).toBe('a;b\n"x;y";4')
  })

  it('picks columns in the requested order and ignores unknown ones', async () => {
    const out = await one('csv-tools', { name: 'p.csv', content: 'a,b,c\n1,2,3' }, { mode: 'columns', columns: 'c, a, nope' })
    expect(csvRows(out.text)).toEqual([['c', 'a'], ['3', '1']])
  })

  it('lists available columns when none match', async () => {
    await expect(one('csv-tools', { name: 'p.csv', content: 'a,b\n1,2' }, { mode: 'columns', columns: 'x' })).rejects.toThrow(/可用列：a、b/)
  })

  it('dedupes whole rows only', async () => {
    const out = await one('csv-tools', { name: 'd.csv', content: 'a,b\n1,2\n1,2\n1,3\n"1,2",\n' }, { mode: 'dedupe' })
    expect(csvRows(out.text)).toEqual([['a', 'b'], ['1', '2'], ['1', '3'], ['1,2', '']])
  })

  it('computes per-column stats', async () => {
    const out = await one('csv-tools', { name: 's.csv', content: 'n,t\n1,x\n3,\n2,x' }, { mode: 'stats' })
    const stats = JSON.parse(out.text)
    expect(stats.rows).toBe(3)
    expect(stats.stats[0]).toMatchObject({ column: 'n', numeric: true, min: 1, max: 3, mean: 2, distinct: 3 })
    expect(stats.stats[1]).toMatchObject({ column: 't', numeric: false, empty: 1, distinct: 1 })
  })

  it('reads TSV via auto-detection and writes .tsv back', async () => {
    const out = await one('csv-tools', { name: 'x.tsv', content: 'a\tb\n1\t2\n1\t2' }, { mode: 'dedupe' })
    expect(out.name).toBe('x-deduped.tsv')
    expect(out.text).toBe('a\tb\n1\t2')
  })

  it('honours a forced delimiter', async () => {
    const out = await one('csv-tools', { name: 'p.csv', content: 'a|b\n1|2' }, { mode: 'columns', columns: 'b', delimiter: '|' })
    expect(out.text).toBe('b\n2')
  })
})

/* ------------------------------------------------------------------------ */

describe('text', () => {
  const text = async (content: string, params: Record<string, unknown>) => (await one('text', { name: 't.txt', content }, params)).text

  it('replaces literally, including regex metacharacters and $ in the replacement', async () => {
    expect(await text('a.b a.b axb', { operation: 'replace', find: 'a.b', replace: '$1' })).toBe('$1 $1 axb')
  })

  it('replaces with regex groups and case-insensitivity', async () => {
    expect(await text('John Smith\njane doe', { operation: 'replace', find: '(\\w+) (\\w+)', replace: '$2, $1', regex: true })).toBe('Smith, John\ndoe, jane')
    expect(await text('Foo foo FOO', { operation: 'replace', find: 'foo', replace: 'x', ignoreCase: true })).toBe('x x x')
  })

  it('reports an invalid regex', async () => {
    await expect(text('x', { operation: 'replace', find: '(', regex: true })).rejects.toThrow(/正则表达式无效/)
  })

  it('refuses an empty search', async () => {
    await expect(text('x', { operation: 'replace', find: '' })).rejects.toThrow(/查找内容不能为空/)
  })

  it('sorts naturally, numerically and descending', async () => {
    expect(await text('10\n9\n100', { operation: 'sort', numeric: true })).toBe('9\n10\n100')
    expect(await text('b\na\nc', { operation: 'sort', descending: true })).toBe('c\nb\na')
  })

  it('dedupes lines, optionally ignoring case, keeping first occurrences', async () => {
    expect(await text('A\na\nA\nb', { operation: 'dedupe' })).toBe('A\na\nb')
    expect(await text('A\na\nA\nb', { operation: 'dedupe', ignoreCase: true })).toBe('A\nb')
  })

  it('converts case including title and sentence case', async () => {
    expect(await text('hello wORLD', { operation: 'case', caseMode: 'upper' })).toBe('HELLO WORLD')
    expect(await text("don't stop", { operation: 'case', caseMode: 'title' })).toBe("Don't Stop")
    expect(await text('first. SECOND! third', { operation: 'case', caseMode: 'sentence' })).toBe('First. Second! Third')
  })

  it('trims lines, removes blank lines and numbers lines', async () => {
    expect(await text('  a  \n\tb\t', { operation: 'trim' })).toBe('a\nb')
    expect(await text('a\n\n   \nb\r\n\r\nc', { operation: 'blank' })).toBe('a\nb\nc')
    const numbered = await text(Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n'), { operation: 'numbering' })
    expect(numbered.split('\n')[0]).toBe(' 1  l0')
    expect(numbered.split('\n')[9]).toBe('10  l9')
  })

  it('counts words across CJK and Latin text', async () => {
    const out = await one('text', { name: 'c.txt', content: "中文测试 hello world, it's\n\nsecond" }, { operation: 'count' })
    expect(out.name).toBe('c-stats.json')
    const stats = JSON.parse(out.text)
    expect(stats).toMatchObject({ cjkCharacters: 4, words: 8, lines: 3, paragraphs: 2 })
    expect(stats.bytes).toBe(Buffer.byteLength("中文测试 hello world, it's\n\nsecond"))
  })

  it('counts emoji as single characters', async () => {
    const stats = JSON.parse((await one('text', { name: 'e.txt', content: '😀a' }, { operation: 'count' })).text)
    expect(stats.characters).toBe(2)
  })
})

/* ------------------------------------------------------------------------ */

describe('encode', () => {
  const binary = new Uint8Array(Array.from({ length: 256 }, (_, i) => i))

  it('hashes every file into one checksum list', async () => {
    const result = await plugin.run(
      'encode',
      [
        { name: 'a.txt', content: 'hello' },
        { name: 'b.bin', content: binary },
      ],
      { operation: 'hash', algorithm: 'SHA-512' },
    )
    expect(result.outputs).toHaveLength(1)
    expect(result.outputs[0].name).toBe('checksums-sha512.txt')
    const sha = (data: string | Uint8Array) => createHash('sha512').update(data).digest('hex')
    expect(result.outputs[0].text).toBe(`${sha('hello')}  a.txt\n${sha(binary)}  b.bin\n`)
  })

  it('round-trips arbitrary bytes through Base64 and Hex', async () => {
    const b64 = await one('encode', { name: 'b.bin', content: binary }, { operation: 'base64' })
    expect(b64.text).toBe(Buffer.from(binary).toString('base64'))
    const decoded = await one('encode', { name: 'b.b64.txt', content: b64.text }, { operation: 'base64-decode' })
    expect([...decoded.bytes]).toEqual([...binary])

    const hex = await one('encode', { name: 'b.bin', content: binary }, { operation: 'hex' })
    expect(hex.text).toBe(Buffer.from(binary).toString('hex'))
    const fromHex = await one('encode', { name: 'b.hex.txt', content: hex.text.toUpperCase() }, { operation: 'hex-decode' })
    expect([...fromHex.bytes]).toEqual([...binary])
  })

  it('accepts URL-safe, unpadded, wrapped and data-URI Base64', async () => {
    const payload = Buffer.from('ÿþ?>~ 中文')
    const urlSafe = payload.toString('base64url')
    const wrapped = payload.toString('base64').replace(/(.{4})/g, '$1\n')
    const dataUri = `data:text/plain;base64,${payload.toString('base64')}`
    for (const content of [urlSafe, wrapped, dataUri]) {
      const out = await one('encode', { name: 'x.txt', content }, { operation: 'base64-decode' })
      expect(Buffer.from(out.bytes).equals(payload)).toBe(true)
    }
  })

  it('rejects invalid Base64 and Hex', async () => {
    await expect(one('encode', { name: 'x', content: '###' }, { operation: 'base64-decode' })).rejects.toThrow(/Base64/)
    await expect(one('encode', { name: 'x', content: 'abc' }, { operation: 'hex-decode' })).rejects.toThrow(/Hex/)
    await expect(one('encode', { name: 'x', content: 'zz' }, { operation: 'hex-decode' })).rejects.toThrow(/Hex/)
  })

  it('accepts 0x prefixes and colon-separated hex', async () => {
    const out = await one('encode', { name: 'x', content: '0xDE:AD:be:ef' }, { operation: 'hex-decode' })
    expect([...out.bytes]).toEqual([0xde, 0xad, 0xbe, 0xef])
  })

  it('URL-encodes and decodes unicode and form-encoded plus signs', async () => {
    const enc = await one('encode', { name: 'u.txt', content: 'a b&c=中/?' }, { operation: 'url' })
    expect(enc.text).toBe(encodeURIComponent('a b&c=中/?'))
    const dec = await one('encode', { name: 'u.txt', content: 'a+b%20c%E4%B8%AD' }, { operation: 'url-decode' })
    expect(dec.text).toBe('a b c中')
    await expect(one('encode', { name: 'u.txt', content: '%E4%B8' }, { operation: 'url-decode' })).rejects.toThrow(/非法的 URL 编码/)
  })

  it('builds a data URI with the input type', async () => {
    const out = await one('encode', { name: 'p.png', content: new Uint8Array([137, 80]), type: 'image/png' }, { operation: 'dataurl' })
    expect(out.text).toBe('data:image/png;base64,iVA=')
  })

  it('encodes files larger than the fromCharCode argument limit', async () => {
    const big = new Uint8Array(300_000).map((_, i) => i & 0xff)
    const out = await one('encode', { name: 'big.bin', content: big }, { operation: 'base64' })
    expect(out.text).toBe(Buffer.from(big).toString('base64'))
  })
})
