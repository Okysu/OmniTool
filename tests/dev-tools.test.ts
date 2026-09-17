/**
 * The developer toolkit. The sandbox has no `crypto.subtle`, so the hashes,
 * HMAC and JWT signatures are implemented in the plugin; they are checked here
 * against Node's crypto. The rest covers each tool's parsing rules and the
 * files `run()` exports.
 */
import { createHash, createHmac } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadPlugin } from './harness/plugin'

type AnyFn = (...args: any[]) => any
let plugin: ReturnType<typeof loadPlugin>
const g = globalThis as unknown as Record<string, AnyFn>

beforeAll(() => {
  plugin = loadPlugin('src/plugins/builtin/dev-tools.js')
})

const text = (name: string, content: string) => ({ name, content, type: 'text/plain' })
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

describe('hashes', () => {
  const samples = [0, 3, 55, 56, 63, 64, 65, 111, 112, 119, 120, 1000].map((n) => new Uint8Array(Buffer.alloc(n, (n * 7) % 251)))

  it('match Node for every algorithm and padding boundary', () => {
    for (const algorithm of ['md5', 'sha1', 'sha256', 'sha384', 'sha512']) {
      for (const bytes of samples) expect(hex(g.hashBytes(algorithm, bytes)), `${algorithm} × ${bytes.length}`).toBe(createHash(algorithm).update(bytes).digest('hex'))
    }
  })

  it('hash incrementally across chunk boundaries', () => {
    const data = new Uint8Array(Buffer.alloc(300, 9))
    const h = g.createHash('sha256')
    h.update(data.subarray(0, 7)).update(data.subarray(7, 200)).update(data.subarray(200))
    expect(hex(h.digest())).toBe(createHash('sha256').update(data).digest('hex'))
  })

  it('compute HMAC with short and long keys', () => {
    for (const algorithm of ['md5', 'sha1', 'sha256', 'sha384', 'sha512']) {
      for (const key of [Buffer.from('k'), Buffer.alloc(300, 1)]) {
        expect(hex(g.hmac(algorithm, new Uint8Array(key), new Uint8Array(Buffer.from('message'))))).toBe(createHmac(algorithm, key).update('message').digest('hex'))
      }
    }
  })

  it('compute CRC32', () => {
    expect(hex(g.crc32Hasher().update(new Uint8Array(Buffer.from('123456789'))).digest())).toBe('cbf43926')
  })

  it('writes sha256sum-style files and checks an expected value', async () => {
    const sha = createHash('sha256').update('hello\n').digest('hex')
    const result = await plugin.run('hash', [text('a.txt', 'hello\n')], { md5: true, sha256: true, crc32: true, expected: sha.toUpperCase() })
    expect(result.outputs[0].text).toContain(`# SHA-256\n${sha}  a.txt`)
    expect(result.outputs[0].text).toContain(`# MD5\n${createHash('md5').update('hello\n').digest('hex')}  a.txt`)
    expect(result.summary).toContain('✓ 与期望值一致（a.txt · SHA-256）')

    const keyed = await plugin.run('hash', [text('a.txt', 'hello\n')], { sha256: true, crc32: true, hmacKey: 'secret', format: 'base64' })
    expect(keyed.outputs[0].text).toBe(`# HMAC-SHA-256\n${createHmac('sha256', 'secret').update('hello\n').digest('base64')}  a.txt\n`)
  })
})

describe('Base64', () => {
  it('encodes text and files with the chosen alphabet, padding and wrapping', async () => {
    const plain = await plugin.run('base64', [text('a.txt', '中文 ~~~???')], { mode: 'encode' })
    expect(plain.outputs[0].text.trim()).toBe(Buffer.from('中文 ~~~???').toString('base64'))
    const url = await plugin.run('base64', [text('a.txt', '中文 ~~~???')], { mode: 'encode', variant: 'url', pad: false })
    expect(url.outputs[0].text.trim()).toBe(Buffer.from('中文 ~~~???').toString('base64url'))
    const wrapped = await plugin.run('base64', [{ name: 'big.bin', content: new Uint8Array(200), type: 'application/octet-stream' }], { mode: 'encode', wrap: '76' })
    expect(wrapped.outputs[0].text.split('\n')[0]).toHaveLength(76)
    const uri = await plugin.run('base64', [{ name: 'x.png', content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), type: 'image/png' }], { mode: 'encode', dataUri: true })
    expect(uri.outputs[0].text.trim()).toBe('data:image/png;base64,iVBORw==')
  })

  it('decodes automatically only when the result makes sense', async () => {
    const decoded = await plugin.run('base64', [text('in.txt', Buffer.from('你好，OmniTool').toString('base64'))], {})
    expect(decoded.outputs[0]).toMatchObject({ name: 'in.decoded.txt', text: '你好，OmniTool\n' })
    // "password" is in the Base64 alphabet but decodes to nonsense: it gets encoded.
    const word = await plugin.run('base64', [text('in.txt', 'password')], {})
    expect(word.outputs[0].name).toBe('in.base64.txt')
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64')
    const image = await plugin.run('base64', [text('img.txt', `data:image/png;base64,${png}`)], {})
    expect(image.outputs[0]).toMatchObject({ name: 'img.decoded.png', type: 'image/png' })
    await expect(plugin.run('base64', [text('bad.txt', '%%%')], { mode: 'decode' })).rejects.toThrow('不是有效的 Base64')
  })
})

describe('JWT', () => {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const sign = (header: object, payload: object, secret: string, alg = 'sha256') => {
    const input = `${b64(header)}.${b64(payload)}`
    return `${input}.${createHmac(alg, secret).update(input).digest('base64url')}`
  }

  it('produces signatures Node agrees with', () => {
    const token = g.signJwt('{"sub":"42","name":"测试"}', { alg: 'HS384', secret: 's3cret' })
    expect(token).toBe(sign({ alg: 'HS384', typ: 'JWT' }, { sub: '42', name: '测试' }, 's3cret', 'sha384'))
  })

  it('reads claims, time state and signature validity', () => {
    const token = sign({ alg: 'HS256', typ: 'JWT', kid: 'k1' }, { sub: 'u', exp: 1000, iat: 900, aud: ['a', 'b'] }, 'key')
    const info = g.inspectJwt(`Bearer ${token}`, { secret: 'key', now: 2_000_000 })
    expect(info.problems).toEqual(['已过期'])
    expect(info.signature.state).toBe('valid')
    expect(info.claims.find((c: { label: string }) => c.label === '受众 aud').value).toBe('a, b')
    expect(g.inspectJwt(token, { secret: 'nope' }).signature.state).toBe('invalid')
    expect(g.inspectJwt(token, { secret: Buffer.from('key').toString('base64'), encoding: 'base64' }).signature.state).toBe('valid')
    expect(g.inspectJwt(`${b64({ alg: 'none' })}.${b64({})}.`).signature.text).toContain('未签名')
    expect(g.inspectJwt(`${b64({ alg: 'RS256' })}.${b64({})}.sig`).signature.text).toContain('公钥')
    expect(() => g.inspectJwt('a.b.c.d.e')).toThrow('JWE')
    expect(() => g.inspectJwt('abc')).toThrow('3 段')
  })

  it('shows the decoded payload in the panel and signs in encode mode', async () => {
    const token = sign({ alg: 'HS256' }, { hello: 'world' }, 'k')
    const panel = await plugin.openPanel('jwt', [])
    await panel.change('token', token)
    const codes = (panel.last().nodes as Array<{ type: string; label?: string; text?: string }>).filter((n) => n.type === 'code')
    expect(codes.find((n) => n.label === '载荷')?.text).toBe('{\n  "hello": "world"\n}')
    await panel.change('mode', 'encode')
    await panel.change('secret', 'k')
    await panel.action('stamp')
    expect(JSON.parse(String(panel.state.payload))).toHaveProperty('exp')
  })
})

describe('timestamps and numbers', () => {
  it('recognises the unit by magnitude and dates in a zone', () => {
    expect(g.parseInstant('1700000000')).toEqual({ ms: 1_700_000_000_000, kind: '秒' })
    expect(g.parseInstant('1700000000123').kind).toBe('毫秒')
    expect(g.parseInstant('1700000000123456').ms).toBeCloseTo(1_700_000_000_123.456)
    expect(g.parseInstant('1700000000123456789')).toEqual({ ms: 1_700_000_000_123, kind: '纳秒' })
    expect(new Date(g.parseInstant('2024-05-01 12:30:00', 'Asia/Shanghai').ms).toISOString()).toBe('2024-05-01T04:30:00.000Z')
    expect(new Date(g.parseInstant('2024-01-15T08:00:00-05:00', 'UTC').ms).toISOString()).toBe('2024-01-15T13:00:00.000Z')
    expect(() => g.parseInstant('yesterday-ish')).toThrow('无法识别')
  })

  it('exports every representation', async () => {
    const result = await plugin.run('timestamp', [], { value: '0', zone: 'America/New_York' })
    expect(result.outputs[0].text).toContain('America/New_York: 1969-12-31 19:00:00.000 -05:00')
    expect(result.outputs[0].text).toContain('ISO 周: 1970 年第 1 周')
  })

  it('converts bases, widths, big integers and floats', () => {
    const rows = (value: string, base = 'auto', width = '32') => Object.fromEntries(g.describeNumber(value, base, width).rows.map((r: { label: string; value: string }) => [r.label, r.value]))
    expect(rows('0xFF')).toMatchObject({ 十进制: '255', 二进制: '1111 1111', '32 位有符号（补码）': '255', '字节（小端）': 'FF 00 00 00' })
    expect(rows('-1', 'auto', '8')).toMatchObject({ '8 位无符号': '255', '8 位二进制': '1111 1111' })
    expect(rows('128', '10', '8')).toMatchObject({ '8 位有符号（补码）': '-128' })
    expect(rows('zz', '36', '0')).toMatchObject({ 十进制: '1295' })
    expect(rows('123456789012345678901234567890', 'auto', '0')['十六进制']).toBe(BigInt('123456789012345678901234567890').toString(16).toUpperCase())
    expect(rows('300', 'auto', '8')['注意']).toContain('超出 8 位')
    expect(rows('0.1')).toMatchObject({ 'float32 十六进制': '0x3dcccccd', 'float64 十六进制': '0x3fb999999999999a' })
    expect(() => g.describeNumber('129', '8', '0')).toThrow('「9」不是 8 进制的数字')
  })
})

describe('URLs and IDs', () => {
  it('parses repeated query parameters and tolerates bad escapes', () => {
    const info = g.describeUrl('example.com/a%20b?q=1&tag=x&tag=y#frag')
    expect(info.params).toEqual({ q: '1', tag: ['x', 'y'] })
    expect(info.rows[0].value).toContain('按 https 解析')
    expect(g.safeDecode('100%+sure%E4%BD%A0', true)).toBe('100% sure你')
    expect(g.transformUrlText('a b&c', 'encode', 'form', false)).toBe('a+b%26c')
  })

  it('generates well-formed identifiers', () => {
    const v4 = g.generateIds({ kind: 'uuid4', count: 20, hyphens: true }).list
    expect(v4.every((id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))).toBe(true)
    expect(new Set(v4).size).toBe(20)
    const v7 = g.uuidV7(1_700_000_000_000)
    expect(v7.slice(0, 13).replace('-', '')).toBe((1_700_000_000_000).toString(16).padStart(12, '0'))
    expect(v7[14]).toBe('7')
    expect(g.ulid(0).slice(0, 10)).toBe('0000000000')
    expect(g.generateIds({ kind: 'nanoid', count: 1, length: 30 }).list[0]).toMatch(/^[A-Za-z0-9_-]{30}$/)
    const password = g.generateIds({ kind: 'password', count: 50, length: 12, symbols: false }).list
    expect(password.every((p: string) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p) && !/[^A-Za-z0-9]/.test(p))).toBe(true)
  })
})

describe('text tools', () => {
  it('lists regex matches with groups and survives empty matches', () => {
    const result = g.runRegex('(?<word>\\w+)@(\\w+)', 'g', 'a@b c@d', '$<word>')
    expect(result.count).toBe(2)
    expect(result.groups).toBe(2)
    expect(result.report).toContain('<word> = "c"')
    expect(result.replaced).toBe('a c')
    expect(g.runRegex('x*', 'g', 'aaa', null).count).toBe(4)
    expect(() => g.runRegex('a', 'q', '', null)).toThrow('不支持的标志')
  })

  it('writes a unified diff and can ignore whitespace', () => {
    const diff = g.compareTexts('a\nb\nc', 'a\nB\nc\nd')
    expect(diff.unified).toBe('--- 原文\n+++ 修改后\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+d')
    expect(g.compareTexts('x  y', 'x y', { ignoreWhitespace: true }).unified).toBe('')
  })

  it('explains cron expressions and finds the next runs', () => {
    const weekdays = g.parseCron('30 9 * * MON-FRI')
    expect(g.describeCron(weekdays)).toBe('每周一、二、三、四、五，09:30')
    const runs = g.nextCronRuns(weekdays, 3, new Date(2024, 4, 3, 10, 0, 0))
    expect(runs.map((d: Date) => [d.getDate(), d.getHours(), d.getMinutes()])).toEqual([[6, 9, 30], [7, 9, 30], [8, 9, 30]])
    // Day of month and weekday OR together.
    const either = g.nextCronRuns(g.parseCron('0 0 13 * FRI'), 2, new Date(2024, 8, 1))
    expect(either.map((d: Date) => d.getDate())).toEqual([6, 13])
    expect(g.nextCronRuns(g.parseCron('*/20 * * * * *'), 3, new Date(2024, 0, 1, 0, 0, 0)).map((d: Date) => d.getSeconds())).toEqual([20, 40, 0])
    expect(g.describeCron(g.parseCron('@hourly'))).toBe('每天，每小时的第 0 分')
    expect(() => g.parseCron('61 * * * *')).toThrow('分钟字段的值「61」超出范围')
    expect(() => g.parseCron('* * *')).toThrow('5 个字段')
  })

  it('dumps bytes and reads dumps back', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 10, 0, 255])
    const result = await plugin.run('hexdump', [{ name: 'doc.pdf', content: bytes, type: 'application/pdf' }], { width: '8' })
    expect(result.summary).toBe('doc.pdf：PDF 文档，11 字节')
    expect(result.outputs[0].text).toContain('00000000  25 50 44 46  2d 31 2e 37  |%PDF-1.7|')
    const back = await plugin.run('hexdump', [text('dump.txt', result.outputs[0].text.split('\n').filter((l) => !l.startsWith('#')).join('\n'))], { mode: 'reverse' })
    expect([...back.outputs[0].bytes]).toEqual([...bytes])
    expect(hex(g.parseHexDump('00000000: 2550 4446 2d31  %PDF-1'))).toBe('255044462d31')
  })

  it('converts naming styles and escapes strings', () => {
    expect(g.convertNaming('XMLHttpRequest\nuser id 2', 'snake')).toBe('xml_http_request\nuser_id_2')
    expect(g.convertNaming('get-HTTP-response', 'pascal')).toBe('GetHttpResponse')
  })

  it('infers optional and nullable fields from sample JSON', () => {
    const ts = g.jsonToTypes('{"items":[{"id":1,"note":"x"},{"id":2.5,"note":null}],"meta":{}}', 'typescript', 'Page')
    expect(ts).toContain('export interface Item {\n  id: number\n  note: string | null\n}')
    expect(ts).toContain('items: Item[]')
    const go = g.jsonToTypes('[{"userId":1},{"userId":2,"url":"u"}]', 'go', 'Row')
    expect(go).toContain('UserID int64')
    expect(go).toContain('URL    *string `json:"url,omitempty"`')
    expect(() => g.jsonToTypes('{', 'go', 'x')).toThrow('不是有效的 JSON')
  })
})

describe('permissions and colours', () => {
  it('reads octal and symbolic modes and keeps the panel in sync', async () => {
    expect(g.describeMode(g.parseMode('rwsr-x--T')).octal).toBe('5750')
    expect(g.describeMode(g.parseMode('0644')).commands[1]).toBe('chmod u=rw,g=r,o=r 文件名')
    const panel = await plugin.openPanel('chmod', [])
    expect(panel.state).toMatchObject({ mode: '755', ur: true, gw: false })
    await panel.change('ow', true)
    expect(panel.state.mode).toBe('757')
    await panel.change('mode', '600')
    expect(panel.state).toMatchObject({ ur: true, uw: true, ux: false, gr: false })
  })

  it('converts between colour notations', () => {
    const rows = (value: string) => Object.fromEntries(g.describeColor(value).rows.map((r: { label: string; value: string }) => [r.label, r.value]))
    expect(rows('#16a34a')).toMatchObject({ RGB: 'rgb(22 163 74)', HSL: 'hsl(142 76% 36%)' })
    expect(rows('rgb(255 0 0 / 50%)').HEX).toBe('#ff000080')
    expect(rows('oklch(62.8% 0.2577 29.23)').HEX).toBe('#ff0000')
    expect(rows('white')['与黑色对比度']).toBe('21.00 : 1（AAA）')
    expect(() => g.describeColor('not-a-colour')).toThrow('无法识别的颜色')
  })
})

describe('panels', () => {
  it('fill in the current time and render copyable output', async () => {
    const panel = await plugin.openPanel('timestamp', [])
    await panel.action('now')
    expect(String(panel.state.value)).toMatch(/^\d{10}$/)
    const nodes = panel.last().nodes as Array<{ type: string }>
    expect(nodes.some((n) => n.type === 'code')).toBe(true)
    expect(nodes.some((n) => n.type === 'facts')).toBe(true)
  })

  it('reports errors inside the panel instead of failing it', async () => {
    const panel = await plugin.openPanel('regex', [], { pattern: '(' })
    expect(JSON.stringify(panel.last().nodes)).toContain('表达式无效')
  })
})
