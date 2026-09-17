/**
 * The subscribable LLM extension (extensions/ai-toolkit.js), run against a fake
 * OpenAI-compatible endpoint. What matters here is the contract with the host
 * and with providers: the API key only ever travels as a placeholder bound to
 * the endpoint's origin, formats survive translation, providers without JSON
 * mode still work, and every coordinate convention VLMs use lands in the same
 * normalised boxes.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadPlugin, type FakeResponse, type NetRequest } from './harness/plugin'

const FILE = 'extensions/ai-toolkit.js'
const OPENAI = { preset: 'openai', baseUrl: 'https://api.openai.com/v1', chatModel: 'gpt-test', visionModel: 'vl-test', auth: true, concurrency: 2, temperature: 0.2, jsonMode: true }
const OLLAMA = { preset: 'ollama', baseUrl: 'http://localhost:11434/v1', chatModel: 'qwen2.5:7b', visionModel: 'qwen2.5vl:7b', auth: false, concurrency: 1, temperature: 0.2, jsonMode: true }

type Plugin = ReturnType<typeof loadPlugin>
type Handler = (request: NetRequest) => FakeResponse | Promise<FakeResponse>

/** Wraps a chat reply the way /chat/completions does. */
const reply = (content: string): FakeResponse => ({ body: { choices: [{ message: { role: 'assistant', content } }] } })
const userText = (request: NetRequest) => {
  const last = request.json.messages[request.json.messages.length - 1]
  return Array.isArray(last.content) ? last.content.map((p: { text?: string }) => p.text ?? '').join('') : String(last.content)
}
const systemText = (request: NetRequest) => String(request.json.messages.find((m: { role: string }) => m.role === 'system')?.content ?? '')

async function configured(config: Record<string, unknown> = OPENAI): Promise<Plugin> {
  const plugin = loadPlugin(FILE, [])
  await plugin.kv.set('connection', config)
  if (config.auth) plugin.secrets.set('apiKey', 'sk-test', [new URL(String(config.baseUrl)).origin])
  return plugin
}

/* ------------------------------ image fakes ------------------------------ */

/** Node has no canvas; the tools only need sizes in and some bytes out. */
let bitmapSize = { width: 2000, height: 1000 }
beforeAll(() => {
  const g = globalThis as Record<string, unknown>
  g.createImageBitmap = async () => ({ ...bitmapSize, close() {} })
  g.OffscreenCanvas = class {
    constructor(public width: number, public height: number) {}
    getContext() {
      return new Proxy({ measureText: () => ({ width: 10 }) } as Record<string, unknown>, {
        get: (target, key) => (key in target ? target[key as string] : () => {}),
        set: () => true,
      })
    }
    async convertToBlob() {
      return new Blob([new Uint8Array([0xff, 0xd8, 0xff])])
    }
  }
})
beforeEach(() => {
  bitmapSize = { width: 2000, height: 1000 }
})

/* ------------------------------ connection ------------------------------- */

describe('AI 连接设置', () => {
  it('fills a preset and binds the API key to the endpoint origin', async () => {
    const plugin = loadPlugin(FILE, [])
    const panel = await plugin.openPanel('settings', [])
    expect(panel.state.baseUrl).toBe('https://api.openai.com/v1')

    await panel.change('preset', 'ollama')
    expect(panel.state).toMatchObject({ baseUrl: 'http://localhost:11434/v1', auth: false, chatModel: 'qwen2.5:7b' })

    await panel.change('preset', 'deepseek')
    plugin.secrets.answer(() => 'sk-deepseek')
    await panel.action('key')
    expect(plugin.secrets.prompts.at(-1)).toMatchObject({ name: 'apiKey', origins: ['https://api.deepseek.com'], force: true })
    expect(plugin.secrets.get('apiKey')?.origins).toEqual(['https://api.deepseek.com'])
    expect(JSON.stringify(panel.last().nodes)).toContain('已录入（仅发往 https://api.deepseek.com）')
  })

  it('saves, asks for the key once and tests the connection with it as a placeholder', async () => {
    const plugin = loadPlugin(FILE, [])
    plugin.secrets.answer(() => 'sk-live')
    const result = await plugin.run('settings', [], { ...OPENAI, baseUrl: 'https://api.openai.com/v1/' }, {
      fetch: () => reply('OK'),
    })
    expect(result.summary).toContain('gpt-test 响应正常')
    expect(result.requests[0].url).toBe('https://api.openai.com/v1/chat/completions')
    // The harness substitutes like the host; the plugin itself only ever wrote the placeholder.
    expect(result.requests[0].headers.Authorization).toBe('Bearer sk-live')
    expect(await plugin.kv.get('connection')).toMatchObject({ baseUrl: 'https://api.openai.com/v1', chatModel: 'gpt-test' })
    expect(plugin.secrets.prompts).toHaveLength(1)
  })

  it('re-asks for the key when the stored one is bound to another origin', async () => {
    const plugin = await configured()
    plugin.secrets.set('apiKey', 'sk-old', ['https://api.deepseek.com'])
    plugin.secrets.answer(() => null)
    await expect(plugin.run('rewrite', [{ name: 'a.md', content: 'hi' }], {}, { fetch: () => reply('x') })).rejects.toThrow('没有录入 API Key')
    expect(plugin.secrets.prompts[0]).toMatchObject({ origins: ['https://api.openai.com'], force: true })
  })

  it('sends no Authorization header to a keyless local endpoint', async () => {
    const plugin = await configured(OLLAMA)
    const result = await plugin.run('rewrite', [{ name: 'a.md', content: '你好' }], {}, { fetch: () => reply('您好') })
    expect(result.requests[0].url).toBe('http://localhost:11434/v1/chat/completions')
    expect(result.requests[0].headers.Authorization).toBeUndefined()
    expect(result.outputs[0].text).toBe('您好\n')
  })

  it('refuses to run before a connection is configured', async () => {
    const plugin = loadPlugin(FILE, [])
    await expect(plugin.run('summarize', [{ name: 'a.txt', content: 'x' }])).rejects.toThrow('AI 连接设置')
  })
})

/* ------------------------------ transport -------------------------------- */

describe('provider quirks', () => {
  it('retries without response_format when the provider rejects JSON mode', async () => {
    const plugin = await configured()
    const result = await plugin.run('extract', [{ name: 'a.txt', content: '张三 13800000000' }], { fields: '姓名: 人名\n电话: 号码' }, {
      fetch: (req) => (req.json.response_format ? { status: 400, body: { error: { message: 'response_format is not supported' } } } : reply('```json\n{"姓名":"张三","电话":"13800000000"}\n```')),
    })
    expect(result.requests).toHaveLength(2)
    expect(result.requests[1].json.response_format).toBeUndefined()
    expect(JSON.parse(result.outputs.find((o) => o.name.endsWith('.json'))!.text)).toEqual({ 姓名: '张三', 电话: '13800000000' })
  })

  it('backs off on 429 using Retry-After, then succeeds', async () => {
    const plugin = await configured()
    let calls = 0
    const result = await plugin.run('rewrite', [{ name: 'a.md', content: 'hello' }], {}, {
      fetch: () => (++calls === 1 ? { status: 429, headers: { 'retry-after': '0.01' }, body: { error: { message: 'slow down' } } } : reply('Hello.')),
    })
    expect(calls).toBe(2)
    expect(result.outputs[0].text).toBe('Hello.\n')
  })

  it('turns 401 into an actionable message', async () => {
    const plugin = await configured()
    await expect(plugin.run('rewrite', [{ name: 'a.md', content: 'hello' }], {}, {
      fetch: () => ({ status: 401, body: { error: { message: 'Incorrect API key provided' } } }),
    })).rejects.toThrow(/API Key 无效.*Incorrect API key/)
  })

  it('does not retry a request the host blocked', async () => {
    const plugin = await configured()
    let calls = 0
    await expect(plugin.run('rewrite', [{ name: 'a.md', content: 'hello' }], {}, {
      fetch: () => {
        calls++
        throw new Error('已阻止插件访问本机/内网地址。如确需放行，请在「设置 › 安全」中开启。')
      },
    })).rejects.toThrow('已阻止')
    expect(calls).toBe(1)
  })

  it('strips reasoning blocks from answers', async () => {
    const plugin = await configured()
    const result = await plugin.run('rewrite', [{ name: 'a.md', content: 'hello' }], {}, { fetch: () => reply('<think>the user wants…</think>\nHello!') })
    expect(result.outputs[0].text).toBe('Hello!\n')
  })

  it('parses JSON wrapped in prose, fences or think blocks', () => {
    const parse = (globalThis as unknown as { parseJsonLoose: (t: string) => unknown }).parseJsonLoose
    expect(parse('Sure! Here it is: {"a": [1, {"b": "}"}]} Hope that helps')).toEqual({ a: [1, { b: '}' }] })
    expect(parse('<think>{"no": 1}</think>```json\n[1,2]\n```')).toEqual([1, 2])
    expect(parse('no json here')).toBeUndefined()
  })
})

/* ------------------------------ translation ------------------------------ */

describe('AI 翻译', () => {
  it('keeps fenced code out of the request and applies the glossary', async () => {
    const plugin = await configured()
    const md = '# Title\n\nSome text.\n\n```js\nconst answer = 42 // do not translate\n```\n\nMore text.\n'
    const result = await plugin.run('translate', [{ name: 'doc.md', content: md }], { glossary: 'OmniTool=全能工具箱' }, {
      fetch: (req) => reply(userText(req).replace('# Title', '# 标题').replace('Some text.', '一些文字。').replace('More text.', '更多文字。')),
    })
    for (const req of result.requests) expect(userText(req)).not.toContain('const answer')
    expect(systemText(result.requests[0])).toContain('OmniTool → 全能工具箱')
    expect(result.outputs[0].name).toBe('doc.zh-CN.md')
    expect(result.outputs[0].text).toBe('# 标题\n\n一些文字。\n\n```js\nconst answer = 42 // do not translate\n```\n\n更多文字。\n')
  })

  it('interleaves paragraphs in bilingual mode', async () => {
    const plugin = await configured()
    const result = await plugin.run('translate', [{ name: 'a.txt', content: 'One.\n\nTwo.' }], { bilingual: true }, {
      fetch: () => reply('一。\n\n二。'),
    })
    expect(result.outputs[0].text).toBe('One.\n\n一。\n\nTwo.\n\n二。\n')
  })

  it('translates SRT cues in batches and keeps every timing', async () => {
    const plugin = await configured()
    const srt = '1\n00:00:01,000 --> 00:00:02,500\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nHow are you?\nFine.\n'
    const result = await plugin.run('translate', [{ name: 'movie.srt', content: srt }], { bilingual: true }, {
      fetch: (req) => {
        const { lines } = JSON.parse(userText(req))
        expect(lines).toEqual(['Hello', 'How are you?\nFine.'])
        return reply(JSON.stringify({ lines: ['你好', '你好吗？\n还行。'] }))
      },
    })
    expect(result.requests).toHaveLength(1)
    expect(result.outputs[0].name).toBe('movie.zh-CN.srt')
    expect(result.outputs[0].text).toBe('1\n00:00:01,000 --> 00:00:02,500\nHello\n你好\n\n2\n00:00:03,000 --> 00:00:04,000\nHow are you?\nFine.\n你好吗？\n还行。\n')
  })

  it('falls back to one cue at a time when the model merges lines', async () => {
    const plugin = await configured()
    const vtt = 'WEBVTT\n\n00:00.000 --> 00:01.000\nA\n\n00:01.000 --> 00:02.000\nB\n'
    const result = await plugin.run('translate', [{ name: 'a.vtt', content: vtt }], {}, {
      fetch: (req) => (req.json.response_format ? reply('{"lines": ["甲乙"]}') : reply(userText(req) === 'A' ? '甲' : '乙')),
    })
    expect(result.outputs[0].text).toBe('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n甲\n\n00:00:01.000 --> 00:00:02.000\n乙\n')
  })

  it('translates i18n JSON values and leaves keys and structure alone', async () => {
    const plugin = await configured()
    const source = { app: { title: 'Settings', empty: '' }, items: ['Save', 'Cancel'], count: 3 }
    const result = await plugin.run('translate', [{ name: 'en.json', content: JSON.stringify(source) }], { target: '日本語' }, {
      fetch: (req) => {
        const { strings } = JSON.parse(userText(req))
        expect(strings).toEqual(['Settings', 'Save', 'Cancel'])
        return reply(JSON.stringify({ strings: ['設定', '保存', 'キャンセル'] }))
      },
    })
    expect(result.outputs[0].name).toBe('en.ja.json')
    expect(JSON.parse(result.outputs[0].text)).toEqual({ app: { title: '設定', empty: '' }, items: ['保存', 'キャンセル'], count: 3 })
  })
})

/* ------------------------------ text tools ------------------------------- */

describe('text tools', () => {
  it('summarises long text map-reduce style', async () => {
    const plugin = await configured()
    const long = Array.from({ length: 60 }, (_, i) => `第 ${i} 段。${'内容'.repeat(300)}`).join('\n\n')
    const result = await plugin.run('summarize', [{ name: 'report.txt', content: long }], {}, {
      fetch: (req) => reply(userText(req).startsWith('Part 1:') ? '- 最终要点' : '部分摘要'),
    })
    expect(result.requests.length).toBeGreaterThan(2)
    expect(result.outputs[0]).toMatchObject({ name: 'report.摘要.md', text: '- 最终要点\n' })
  })

  it('extracts many records into JSON and a combined CSV', async () => {
    const plugin = await configured()
    const result = await plugin.run('extract', [{ name: 'inv.txt', content: '苹果 3 元；香蕉 "特价" 2 元' }], { fields: '商品: 名称\n单价: 数字', mode: 'many' }, {
      fetch: () => reply('{"records": [{"商品": "苹果", "单价": 3}, {"商品": "香蕉 \\"特价\\"", "单价": 2, "多余": 1}]}'),
    })
    const csv = result.outputs.find((o) => o.name === '抽取结果.csv')!
    // A BOM so Excel opens UTF-8 correctly (TextDecoder hides it from `.text`).
    expect([...csv.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(csv.text).toBe('文件,商品,单价\r\ninv.txt,苹果,3\r\ninv.txt,"香蕉 ""特价""",2\r\n')
    expect(JSON.parse(result.outputs.find((o) => o.name === 'inv.抽取.json')!.text)[1]).toEqual({ 商品: '香蕉 "特价"', 单价: 2 })
  })

  it('classifies lines in batches and drops labels outside the set', async () => {
    const plugin = await configured()
    const result = await plugin.run('classify', [{ name: 'reviews.txt', content: '很好用\n\n太慢了\n一般' }], { unit: 'line' }, {
      fetch: () => reply('{"results": [{"id": 0, "labels": ["正面"]}, {"id": 1, "labels": ["愤怒"]}, {"id": 2, "labels": ["中性"]}]}'),
    })
    expect(result.requests).toHaveLength(1)
    expect(result.outputs[0].text).toContain('reviews.txt#2,太慢了,\r\n')
    expect(result.summary).toBe('已分类 3 条：正面 1、负面 0、中性 1')
  })

  it('fills a new CSV column from a row template', async () => {
    const plugin = loadPlugin(FILE, ['data-libs'])
    await plugin.kv.set('connection', OLLAMA)
    const csv = '城市,人口\n北京,2189\n上海,2487\n'
    const result = await plugin.run('csv-ai', [{ name: 'cities.csv', content: csv }], { template: '{{城市}} 属于哪个国家？', column: '国家' }, {
      fetch: (req) => {
        expect(userText(req)).toContain('Task 2: 上海 属于哪个国家？')
        return reply('{"answers": ["中国", "中国"]}')
      },
    })
    expect(result.outputs[0].text).toBe('城市,人口,国家\r\n北京,2189,中国\r\n上海,2487,中国')
    await expect(plugin.run('csv-ai', [{ name: 'cities.csv', content: csv }], { template: '{{省份}}' }, { fetch: () => reply('') })).rejects.toThrow('CSV 中没有这些列：省份')
  })

  it('answers from the most similar passages when an embedding model is set', async () => {
    const plugin = await configured({ ...OPENAI, embedModel: 'embed-test' })
    const vec = (text: string) => (text.includes('退款') ? [1, 0] : [0, 1])
    const docs = [{ name: 'faq.md', content: '# 配送\n\n下单后三天内发货。' }, { name: 'policy.md', content: '退款会在七个工作日内原路退回。' }]
    const result = await plugin.run('doc-qa', docs, { question: '退款多久到账？', topK: 3 }, {
      fetch: (req) => {
        if (req.url.endsWith('/embeddings')) return { body: { data: req.json.input.map((t: string, index: number) => ({ index, embedding: vec(t) })) } }
        expect(userText(req)).toMatch(/\[1\] \(policy\.md/)
        return reply('七个工作日内原路退回 [1]。')
      },
    })
    expect(result.outputs[0].text).toContain('**[1] policy.md · 第 1 段**（相似度 1.000）')
    expect(result.summary).toContain('语义检索')
  })

  it('ranks passages by keyword overlap without embeddings, CJK included', () => {
    const score = (globalThis as unknown as { keywordScore: (q: string, t: string) => number }).keywordScore
    expect(score('退款多久到账', '退款会在七个工作日内到账')).toBeGreaterThan(score('退款多久到账', '下单后三天内发货'))
  })

  it('gives files unique, sanitised names', async () => {
    const plugin = await configured()
    const result = await plugin.run('smart-rename', [{ name: 'a.txt', content: 'x' }, { name: 'b.txt', content: 'y' }], {}, {
      fetch: () => reply('{"name": "会议/纪要"}'),
    })
    expect(result.outputs.map((o) => o.name)).toEqual(['会议纪要.txt', '会议纪要-2.txt'])
  })
})

/* ------------------------------- detection ------------------------------- */

describe('AI 目标检测打标', () => {
  const parse = (text: string, mode = 'auto', labels: string[] = []) =>
    (globalThis as unknown as { parseDetections: (t: string, o: object) => Array<{ label: string; box: number[] }> }).parseDetections(text, { mode, sentWidth: 1280, sentHeight: 640, labels })

  beforeAll(() => loadPlugin(FILE, []))

  it('normalises every coordinate convention to the same 0-1 box', () => {
    const expected = [0.25, 0.5, 0.5, 1]
    const close = (box: number[]) => box.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 6))
    close(parse('{"objects": [{"label": "cat", "box": [250, 500, 500, 1000]}]}')[0].box)
    close(parse('[{"label": "cat", "bbox_2d": [320, 320, 640, 640]}]', 'pixel')[0].box)
    close(parse('[{"label": "cat", "box_2d": [500, 250, 1000, 500]}]')[0].box)
    close(parse('{"detections": [{"name": "cat", "bbox": [0.25, 0.5, 0.5, 1.0]}]}')[0].box)
    close(parse('[{"class": "cat", "xmin": 500, "ymin": 500, "xmax": 250, "ymax": 1000}]')[0].box)
    close(parse('[{"label": "cat", "bbox": {"x": 0.25, "y": 0.5, "width": 0.25, "height": 0.5}}]')[0].box)
  })

  it('recognises pixel answers larger than 1000 automatically', () => {
    const [d] = parse('[{"label": "car", "box": [640, 0, 1280, 320]}]', 'auto')
    // max 1280 > 1000, so these are pixels of the 1280 × 640 image that was sent
    expect(d.box).toEqual([0.5, 0, 1, 0.5])
  })

  it('clamps, drops degenerate boxes and keeps only requested labels', () => {
    const out = parse('{"objects": [{"label": "Dog", "box": [-20, 100, 1200, 900]}, {"label": "cat", "box": [10, 10, 10, 500]}, {"label": "tree", "box": [0, 0, 100, 100]}]}', 'norm1000', ['dog', 'cat'])
    expect(out).toEqual([{ label: 'dog', box: [0, 0.1, 1, 0.9] }])
  })

  it('exports YOLO, COCO and LabelMe in the original image size', async () => {
    const plugin = await configured()
    bitmapSize = { width: 2000, height: 1000 }
    const result = await plugin.run('detect', [{ name: 'street.jpg', content: new Uint8Array([1]), type: 'image/jpeg' }], { labels: '车\n人' }, {
      fetch: (req) => {
        const content = req.json.messages[0].content
        expect(content[0].image_url.url).toMatch(/^data:image\/jpeg;base64,/)
        expect(content[1].text).toContain('normalized to 0-1000')
        expect(req.json.model).toBe('vl-test')
        return reply('{"objects": [{"label": "人", "box": [100, 200, 300, 600]}, {"label": "车", "box": [500, 500, 900, 1000]}]}')
      },
    })
    const byName = Object.fromEntries(result.outputs.map((o) => [o.name, o]))
    expect(Object.keys(byName).sort()).toEqual(['detections/coco.json', 'detections/labelme/street.json', 'detections/preview/street.png', 'detections/yolo/classes.txt', 'detections/yolo/labels/street.txt'])
    expect(byName['detections/yolo/classes.txt'].text).toBe('车\n人\n')
    expect(byName['detections/yolo/labels/street.txt'].text).toBe('1 0.2 0.4 0.2 0.4\n0 0.7 0.75 0.4 0.5\n')
    const coco = JSON.parse(byName['detections/coco.json'].text)
    expect(coco.images[0]).toMatchObject({ file_name: 'street.jpg', width: 2000, height: 1000 })
    expect(coco.categories.map((c: { name: string }) => c.name)).toEqual(['车', '人'])
    expect(coco.annotations[0]).toMatchObject({ image_id: 1, category_id: 2, bbox: [200, 200, 400, 400], area: 160000 })
    const labelme = JSON.parse(byName['detections/labelme/street.json'].text)
    expect(labelme.shapes[1]).toMatchObject({ label: '车', shape_type: 'rectangle', points: [[1000, 500], [1800, 1000]] })
    expect(result.summary).toBe('在 1 张图片中检测到 2 个目标（2 个类别）')
  })
})

/* -------------------------------- vision --------------------------------- */

describe('vision tools', () => {
  it('sorts images into label folders, falling back to the last label', async () => {
    const plugin = await configured()
    const inputs = ['a.jpg', 'b.jpg'].map((name) => ({ name, content: new Uint8Array([7]), type: 'image/jpeg' }))
    let n = 0
    const result = await plugin.run('image-sort', inputs, { labels: '猫\n其他' }, {
      fetch: () => reply(n++ === 0 ? '{"label": "猫"}' : '{"label": "恐龙"}'),
    })
    expect(result.outputs.map((o) => o.name).sort()).toEqual(['其他/b.jpg', '分类结果.csv', '猫/a.jpg'])
  })

  it('rebuilds a table from a chart as CSV', async () => {
    const plugin = await configured()
    const result = await plugin.run('table-image', [{ name: 'chart.png', content: new Uint8Array([1]), type: 'image/png' }], {}, {
      fetch: () => reply('{"columns": ["月份", "销量"], "rows": [["1月", 120], ["2月", 98.5]]}'),
    })
    expect(result.outputs[0]).toMatchObject({ name: 'chart.csv', text: '月份,销量\r\n1月,120\r\n2月,98.5\r\n' })
  })
})

/* ------------------------- audio and generation -------------------------- */

describe('speech and images', () => {
  it('compresses the audio track locally and uploads it as multipart', async () => {
    const plugin = await configured({ ...OPENAI, sttModel: 'whisper-1' })
    const result = await plugin.run('transcribe', [{ name: 'talk.mp4', content: new Uint8Array([0]), type: 'video/mp4' }], { language: 'zh' }, {
      fetch: (req) => {
        expect(req.headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/)
        expect(req.text).toContain('name="model"\r\n\r\nwhisper-1')
        expect(req.text).toContain('name="language"\r\n\r\nzh')
        expect(req.text).toContain('filename="talk-1.mp3"')
        return { body: '1\n00:00:00,000 --> 00:00:01,200\n大家好\n' }
      },
    })
    expect(result.ffmpeg[0].args).toEqual(expect.arrayContaining(['-vn', '-ac', '1', '-b:a', '32k']))
    expect(result.outputs[0]).toMatchObject({ name: 'talk.srt', text: '1\n00:00:00,000 --> 00:00:01,200\n大家好\n' })
  })

  it('shifts segment timestamps when merging long recordings', () => {
    const merge = (globalThis as unknown as { mergeTranscripts: (p: object[], f: string) => string }).mergeTranscripts
    const piece = (body: string, offset: number) => ({ body, offset })
    expect(merge([piece('1\n00:00:01,000 --> 00:00:02,000\nA\n', 0), piece('1\n00:00:01,000 --> 00:00:02,000\nB\n', 1200)], 'srt'))
      .toBe('1\n00:00:01,000 --> 00:00:02,000\nA\n\n2\n00:20:01,000 --> 00:20:02,000\nB\n')
  })

  it('refuses a video without an audio track before uploading anything', async () => {
    const plugin = await configured({ ...OPENAI, sttModel: 'whisper-1' })
    await expect(plugin.run('transcribe', [{ name: 'silent.mp4', content: new Uint8Array([0]) }], {}, {
      probe: { 'silent.mp4': { audioCodec: null } },
      fetch: () => reply(''),
    })).rejects.toThrow('没有音轨')
  })

  it('synthesises long text in pieces and concatenates the MP3 bytes', async () => {
    const plugin = await configured({ ...OPENAI, ttsModel: 'tts-1' })
    const text = `${'第一句话很长。'.repeat(400)}${'第二句。'.repeat(400)}`
    const result = await plugin.run('tts', [{ name: 'book.txt', content: text }], { voice: 'nova' }, {
      fetch: (req) => ({ body: new Uint8Array([req.json.input.length % 251]) }),
    })
    expect(result.requests.length).toBeGreaterThan(1)
    expect(result.requests.every((r) => r.json.voice === 'nova' && r.json.input.length <= 3500)).toBe(true)
    expect(result.outputs[0]).toMatchObject({ name: 'book.mp3', type: 'audio/mpeg' })
    expect(result.outputs[0].bytes.length).toBe(result.requests.length)
  })

  it('decodes generated images and retries without response_format', async () => {
    const plugin = await configured({ ...OPENAI, imageModel: 'img-test' })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
    const result = await plugin.run('image-gen', [], { prompt: '一只橘猫', n: 2 }, {
      fetch: (req) => (req.json.response_format
        ? { status: 400, body: { error: { message: "Unknown parameter: 'response_format'" } } }
        : { body: { data: [{ b64_json: png }, { b64_json: png }] } }),
    })
    expect(result.outputs).toHaveLength(2)
    expect([...result.outputs[0].bytes]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })
})
