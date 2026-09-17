/* eslint-disable */
/**
 * OmniTool extension: LLM toolkit for any OpenAI-compatible endpoint.
 *
 * Not built into the app. The file lives in the repository and is subscribed to
 * on demand (for example through jsDelivr), because every tool here sends data
 * to a model service - a cloud provider or a local server such as Ollama - and
 * OmniTool's own promise is that nothing leaves the machine by default.
 *
 * Design notes:
 *   - One plugin, so the endpoint and the API key are configured once for every
 *     tool ("AI 连接设置").
 *   - The API key is stored with the `secret` capability, bound to the
 *     endpoint's origin. The plugin never sees it; requests reference
 *     `{{secret:apiKey}}` and the host substitutes it for that origin only.
 *   - Everything talks the OpenAI REST dialect: /chat/completions (text and
 *     vision), /embeddings, /audio/transcriptions, /audio/speech,
 *     /images/generations. Providers differ in details (JSON mode, image
 *     response formats), so requests degrade gracefully instead of failing.
 */
const CONFIG_KEY = 'connection'
const SECRET_NAME = 'apiKey'

const LANGUAGES = ['简体中文', '繁體中文', 'English', '日本語', '한국어', 'Français', 'Deutsch', 'Español', 'Português', 'Русский', 'Italiano', 'Tiếng Việt', 'ภาษาไทย', 'Bahasa Indonesia', 'العربية']

const PRESETS = [
  { value: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', chatModel: 'gpt-4.1-mini', visionModel: 'gpt-4.1-mini', embedModel: 'text-embedding-3-small', sttModel: 'whisper-1', ttsModel: 'tts-1', imageModel: 'gpt-image-1', auth: true },
  { value: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', chatModel: 'deepseek-chat', visionModel: '', embedModel: '', sttModel: '', ttsModel: '', imageModel: '', auth: true },
  { value: 'dashscope', label: '阿里云百炼（通义千问）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', chatModel: 'qwen-plus', visionModel: 'qwen-vl-max', embedModel: 'text-embedding-v3', sttModel: '', ttsModel: '', imageModel: '', auth: true },
  { value: 'siliconflow', label: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', chatModel: 'Qwen/Qwen2.5-72B-Instruct', visionModel: 'Qwen/Qwen2.5-VL-72B-Instruct', embedModel: 'BAAI/bge-m3', sttModel: 'FunAudioLLM/SenseVoiceSmall', ttsModel: '', imageModel: '', auth: true },
  { value: 'zhipu', label: '智谱 BigModel', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', chatModel: 'glm-4-flash', visionModel: 'glm-4v-flash', embedModel: 'embedding-3', sttModel: '', ttsModel: '', imageModel: '', auth: true },
  { value: 'moonshot', label: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', chatModel: 'moonshot-v1-8k', visionModel: '', embedModel: '', sttModel: '', ttsModel: '', imageModel: '', auth: true },
  { value: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', chatModel: 'openai/gpt-4.1-mini', visionModel: 'openai/gpt-4.1-mini', embedModel: '', sttModel: '', ttsModel: '', imageModel: '', auth: true },
  { value: 'ollama', label: 'Ollama（本机）', baseUrl: 'http://localhost:11434/v1', chatModel: 'qwen2.5:7b', visionModel: 'qwen2.5vl:7b', embedModel: 'nomic-embed-text', sttModel: '', ttsModel: '', imageModel: '', auth: false },
  { value: 'lmstudio', label: 'LM Studio（本机）', baseUrl: 'http://localhost:1234/v1', chatModel: '', visionModel: '', embedModel: '', sttModel: '', ttsModel: '', imageModel: '', auth: false },
  { value: 'custom', label: '自定义', baseUrl: '', chatModel: '', visionModel: '', embedModel: '', sttModel: '', ttsModel: '', imageModel: '', auth: true },
]

const CONFIG_FIELDS = ['preset', 'baseUrl', 'chatModel', 'visionModel', 'embedModel', 'sttModel', 'ttsModel', 'imageModel', 'auth', 'concurrency', 'temperature', 'jsonMode']

definePlugin({
  id: 'omnitool.ext.ai',
  name: 'AI 扩展工具箱',
  version: '1.0.0',
  author: 'OmniTool',
  description: '连接任意 OpenAI 兼容接口（OpenAI、DeepSeek、通义千问、硅基流动、Ollama 等）的翻译、摘要、信息抽取、视觉理解、目标检测打标、语音转写与合成工具。文件会发送到你配置的模型服务。',
  homepage: 'https://github.com/Okysu/OmniTool/tree/main/extensions',
  icon: 'sparkles',
  capabilities: ['fs', 'ui', 'kv', 'net', 'secret', 'ffmpeg'],
  deps: [
    { id: 'data-libs', url: '/vendor/data-libs.js', global: 'DataLibs', lazy: true },
    { id: 'pdfjs', url: '/vendor/pdfjs.js', global: 'pdfjsLib', lazy: true },
    { id: 'pdfjs-worker', url: '/vendor/pdfjs-worker.js', global: 'pdfjsWorker', lazy: true },
  ],

  tools: [
    /* ================================================================== */
    /* Connection                                                         */
    /* ================================================================== */
    {
      id: 'settings',
      name: 'AI 连接设置',
      category: 'ai',
      icon: 'settings',
      description: '配置 OpenAI 兼容接口地址、各类模型与 API Key。所有 AI 扩展工具共用这里的设置。',
      input: 'none',
      keywords: ['openai', 'api key', 'ollama', 'deepseek', 'qwen', 'endpoint', '设置', '接口', '密钥', '模型'],

      async setup(ui) {
        const saved = (await ui.host.kv.get(CONFIG_KEY)) || {}
        const state = { ...presetConfig('openai'), ...saved, ...pickState(ui.state) }

        const draw = async (current) => {
          const keyStatus = await describeKey(ui.host, current)
          ui.render({
            runLabel: '保存并测试连接',
            nodes: [
              {
                type: 'alert', tone: 'warning', title: '数据会离开本机',
                text: '这些工具会把文件内容发送到你配置的模型服务。处理敏感文件时，建议使用本机运行的 Ollama / LM Studio。',
              },
              { type: 'select', bind: 'preset', label: '服务商', options: PRESETS.map((p) => ({ value: p.value, label: p.label })) },
              { type: 'input', bind: 'baseUrl', label: 'Base URL', placeholder: 'https://api.openai.com/v1', hint: '以 /v1 结尾的 OpenAI 兼容地址。本机地址需在「设置 → 安全」中允许插件访问本机与内网。' },
              {
                type: 'section', title: '模型',
                children: [
                  { type: 'input', bind: 'chatModel', label: '文本模型', placeholder: '如 gpt-4.1-mini、deepseek-chat、qwen2.5:7b' },
                  { type: 'input', bind: 'visionModel', label: '视觉模型', placeholder: '留空则使用文本模型', hint: '图片描述、目标检测、图片转文字等工具使用，需要支持图片输入。' },
                  { type: 'input', bind: 'embedModel', label: '向量模型', placeholder: '可选，如 text-embedding-3-small', hint: '「文档问答」用于检索相关段落；留空时按关键词检索。' },
                  { type: 'input', bind: 'sttModel', label: '语音转写模型', placeholder: '可选，如 whisper-1' },
                  { type: 'input', bind: 'ttsModel', label: '语音合成模型', placeholder: '可选，如 tts-1' },
                  { type: 'input', bind: 'imageModel', label: '图像生成模型', placeholder: '可选，如 gpt-image-1' },
                ],
              },
              {
                type: 'section', title: '请求',
                children: [
                  { type: 'switch', bind: 'auth', label: '需要 API Key', hint: '本机 Ollama、LM Studio 通常不需要。' },
                  { type: 'slider', bind: 'concurrency', label: '并发请求数', min: 1, max: 8, step: 1 },
                  { type: 'slider', bind: 'temperature', label: '温度', min: 0, max: 1.5, step: 0.1, hint: '越低越稳定，翻译与抽取建议 0–0.3。' },
                  { type: 'switch', bind: 'jsonMode', label: '使用 JSON 模式', hint: '请求结构化输出时发送 response_format；服务不支持时会自动退回。' },
                ],
              },
              { type: 'facts', rows: [{ label: 'API Key', value: keyStatus }] },
              {
                type: 'row', gap: 2, wrap: true,
                children: [
                  { type: 'button', text: '录入 / 更换 API Key', action: 'key', variant: 'outline', icon: 'key', disabled: !current.auth },
                  { type: 'button', text: '删除 API Key', action: 'forget', variant: 'ghost', icon: 'trash', disabled: !current.auth },
                ],
              },
            ],
            state: current,
          })
        }

        await draw(state)
        ui.on('change', async (key, value, current) => {
          if (key === 'preset') {
            const next = { ...current, ...presetConfig(String(value)) }
            ui.setState(next)
            await draw(next)
          } else if (key === 'auth' || key === 'baseUrl') {
            await draw(current)
          }
        })
        ui.on('action', async (name, _value, current) => {
          if (name === 'key') {
            const origin = originOf(current.baseUrl)
            if (!origin) {
              await ui.host.ui.notify('请先填写正确的 Base URL', 'warn')
              return
            }
            await ui.host.secret.request(SECRET_NAME, {
              label: `${presetLabel(current.preset)} API Key`,
              hint: `只会发往 ${origin}`,
              origins: [origin],
              force: true,
            })
          }
          if (name === 'forget') await ui.host.secret.remove(SECRET_NAME)
          await draw(current)
        })
      },

      async run(ctx) {
        const config = normaliseConfig(ctx.params)
        if (!originOf(config.baseUrl)) throw new Error('Base URL 不是有效的 http(s) 地址')
        if (!config.chatModel) throw new Error('请填写文本模型名称')
        await ctx.host.kv.set(CONFIG_KEY, config)
        if (config.auth) await ensureKey(ctx.host, config)
        ctx.progress(null, '测试连接')
        const started = Date.now()
        const reply = await chat(ctx, config, {
          messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
          maxTokens: 16,
          temperature: 0,
        })
        return { outputs: [], summary: `已保存。${config.chatModel} 响应正常（${Date.now() - started} ms）：${reply.trim().slice(0, 40)}` }
      },
    },

    /* ================================================================== */
    /* Text                                                               */
    /* ================================================================== */
    {
      id: 'translate',
      name: 'AI 翻译',
      category: 'ai',
      icon: 'type',
      description: '翻译文本、Markdown、字幕（SRT / VTT，保留时间轴）与 i18n JSON（只翻译值），保留格式与代码块，支持术语表与双语对照。',
      accept: ['.txt', '.md', '.markdown', '.srt', '.vtt', '.json', 'text/plain', 'text/markdown', 'application/json'],
      multiple: true,
      input: 'both',
      textFileName: 'input.md',
      keywords: ['translate', 'translation', 'subtitle', 'i18n', 'localization', '翻译', '字幕翻译', '本地化', '双语'],
      params: [
        { key: 'target', type: 'select', label: '译为', default: '简体中文', options: LANGUAGES.map((l) => ({ value: l, label: l })) },
        { key: 'style', type: 'select', label: '风格', default: 'natural', options: [
          { value: 'natural', label: '自然流畅' }, { value: 'formal', label: '正式书面' }, { value: 'technical', label: '技术文档（术语准确）' }, { value: 'casual', label: '口语化' },
        ] },
        { key: 'bilingual', type: 'switch', label: '双语对照', default: false, hint: '文本与 Markdown 按段落交替；字幕在原文下方加一行译文。' },
        { key: 'glossary', type: 'textarea', label: '术语表', default: '', rows: 3, placeholder: '每行一条：原文=译文\n如 OmniTool=OmniTool', hint: '模型会优先使用这些译法。' },
        { key: 'chunk', type: 'slider', label: '每次请求的字数上限', min: 500, max: 8000, step: 500, default: 2500, hint: '长文会按段落切分翻译。' },
      ],

      async run(ctx) {
        const config = await loadConfig(ctx.host)
        const p = ctx.params
        const outputs = []
        for (const [index, input] of ctx.inputs.entries()) {
          ctx.throwIfAborted()
          const text = await ctx.host.fs.readText(input.id)
          const kind = textKind(input.name, text)
          const report = (fraction, label) => ctx.progress((index + fraction) / ctx.inputs.length, `${label}：${input.name}`)
          let result
          if (kind === 'srt' || kind === 'vtt') result = await translateSubtitles(ctx, config, text, kind, p, report)
          else if (kind === 'json') result = await translateJsonValues(ctx, config, text, p, report)
          else result = await translateDocument(ctx, config, text, p, report)
          const name = withSuffix(input.name, `.${languageCode(p.target)}`)
          outputs.push((await ctx.host.fs.writeAll(name, result, mimeOf(name))).id)
        }
        ctx.progress(1)
        return { outputs, summary: `已翻译 ${outputs.length} 个文件为 ${p.target}` }
      },
    },

    {
      id: 'summarize',
      name: 'AI 摘要',
      category: 'ai',
      icon: 'file-text',
      description: '为长文、报告、网页存档或字幕生成摘要。超长文本先分段摘要再汇总，不受模型上下文长度限制。',
      accept: ['.txt', '.md', '.markdown', '.srt', '.vtt', '.html', '.json', '.csv', 'text/*'],
      multiple: true,
      input: 'both',
      keywords: ['summary', 'summarize', 'tldr', 'abstract', '摘要', '总结', '概括', '要点'],
      params: [
        { key: 'length', type: 'select', label: '篇幅', default: 'standard', options: [
          { value: 'short', label: '一句话' }, { value: 'standard', label: '标准（约 200 字）' }, { value: 'detailed', label: '详细（约 600 字）' },
        ] },
        { key: 'format', type: 'select', label: '形式', default: 'bullets', options: [
          { value: 'bullets', label: '要点列表' }, { value: 'paragraph', label: '段落' }, { value: 'report', label: '结构化报告（背景 / 要点 / 结论）' },
        ] },
        { key: 'language', type: 'select', label: '输出语言', default: 'same', options: [{ value: 'same', label: '与原文相同' }, ...LANGUAGES.map((l) => ({ value: l, label: l }))] },
      ],

      async run(ctx) {
        const config = await loadConfig(ctx.host)
        const p = ctx.params
        const outputs = []
        for (const [index, input] of ctx.inputs.entries()) {
          ctx.throwIfAborted()
          const text = plainText(input.name, await ctx.host.fs.readText(input.id))
          if (!text.trim()) throw new Error(`${input.name} 没有可以摘要的文字`)
          const instruction = summaryInstruction(p)
          const summary = await mapReduce(ctx, config, text, instruction, (f, l) => ctx.progress((index + f) / ctx.inputs.length, `${l}：${input.name}`))
          const name = withSuffix(input.name, '.摘要', '.md')
          outputs.push((await ctx.host.fs.writeAll(name, `${summary.trim()}\n`, 'text/markdown')).id)
        }
        ctx.progress(1)
        return { outputs, summary: `已为 ${outputs.length} 个文件生成摘要` }
      },
    },

    {
      id: 'rewrite',
      name: 'AI 润色改写',
      category: 'ai',
      icon: 'pen-line',
      description: '纠正错别字与语病、调整语气、精简或扩写，保留 Markdown 格式。',
      accept: ['.txt', '.md', '.markdown', 'text/plain', 'text/markdown'],
      multiple: true,
      input: 'both',
      textFileName: 'input.md',
      keywords: ['rewrite', 'polish', 'proofread', 'grammar', 'paraphrase', '润色', '改写', '纠错', '校对', '扩写', '精简'],
      params: [
        { key: 'mode', type: 'select', label: '方式', default: 'polish', options: [
          { value: 'polish', label: '润色纠错（尽量少改）' }, { value: 'formal', label: '改为正式书面' }, { value: 'casual', label: '改为轻松口语' },
          { value: 'concise', label: '精简（去掉冗余）' }, { value: 'expand', label: '扩写（补充细节）' }, { value: 'simple', label: '通俗易懂' },
        ] },
        { key: 'extra', type: 'textarea', label: '补充要求', default: '', rows: 2, placeholder: '如：面向技术管理者；保留所有数字' },
      ],

      async run(ctx) {
        const config = await loadConfig(ctx.host)
        const p = ctx.params
        const instruction = `${REWRITE_MODES[p.mode] || REWRITE_MODES.polish}${p.extra ? `\nAdditional requirements: ${p.extra}` : ''}\nKeep the original language, Markdown structure, links, numbers and code blocks. Output only the rewritten text.`
        const outputs = []
        for (const [index, input] of ctx.inputs.entries()) {
          ctx.throwIfAborted()
          const text = await ctx.host.fs.readText(input.id)
          const chunks = packBlocks(splitMarkdownBlocks(text), 3000)
          const done = await mapLimit(ctx, config, chunks, async (chunk) => {
            if (chunk.code) return chunk.text
            return (await chat(ctx, config, { messages: [{ role: 'system', content: instruction }, { role: 'user', content: chunk.text }] })).trim()
          }, (f) => ctx.progress((index + f) / ctx.inputs.length, `改写 ${input.name}`))
          const name = withSuffix(input.name, '.改写')
          outputs.push((await ctx.host.fs.writeAll(name, `${done.join('\n\n').trim()}\n`, mimeOf(name))).id)
        }
        ctx.progress(1)
        return { outputs, summary: `已改写 ${outputs.length} 个文件` }
      },
    },

    {
      id: 'extract',
      name: 'AI 信息抽取',
      category: 'ai',
      icon: 'file-json',
      description: '按你定义的字段，从合同、简历、发票、邮件等文本中抽取结构化数据，输出 JSON 与汇总 CSV。',
      accept: ['.txt', '.md', '.eml', '.html', '.json', '.csv', 'text/*'],
      multiple: true,
      input: 'both',
      keywords: ['extract', 'structured data', 'json', 'parse', 'invoice', 'resume', '抽取', '结构化', '提取字段', '发票', '简历'],
      params: [
        { key: 'fields', type: 'textarea', label: '字段', rows: 5, default: '姓名: 人名\n电话: 手机或座机号码\n金额: 数字，不含货币符号\n日期: YYYY-MM-DD', hint: '每行一个「字段名: 说明」。找不到的字段会是 null。' },
        { key: 'mode', type: 'select', label: '每个文件', default: 'one', options: [{ value: 'one', label: '抽取一条记录' }, { value: 'many', label: '抽取多条记录（如明细列表）' }] },
      ],

      async run(ctx) {
        const config = await loadConfig(ctx.host)
        const fields = parseFieldSpec(String(ctx.params.fields || ''))
        if (!fields.length) throw new Error('请至少定义一个字段')
        const many = ctx.params.mode === 'many'
        const schema = fields.map((f) => `- "${f.name}": ${f.hint || 'string'}`).join('\n')
        const rows = []
        const outputs = []
        await mapLimit(ctx, config, ctx.inputs, async (input) => {
          const text = plainText(input.name, await ctx.host.fs.readText(input.id)).slice(0, 60000)
          const data = await chatJson(ctx, config, {
            messages: [
              { role: 'system', content: 'You extract structured data from documents. Answer with JSON only. Use null for anything not present. Never invent values.' },
              { role: 'user', content: `Fields:\n${schema}\n\nReturn ${many ? '{"records": [ {…one object per item…} ]}' : 'one JSON object with exactly these keys'}.\n\nDocument (${input.name}):\n"""\n${text}\n"""` },
            ],
          })
          const records = many ? (Array.isArray(data?.records) ? data.records : Array.isArray(data) ? data : []) : [data]
          const clean = records.filter((r) => r && typeof r === 'object').map((r) => Object.fromEntries(fields.map((f) => [f.name, r[f.name] ?? null])))
          const out = await ctx.host.fs.writeAll(withSuffix(input.name, '.抽取', '.json'), `${JSON.stringify(many ? clean : clean[0] ?? null, null, 2)}\n`, 'application/json')
          outputs.push(out.id)
          for (const record of clean) rows.push({ 文件: input.name, ...record })
        }, (f) => ctx.progress(f, '抽取中'))
        if (rows.length) {
          const csv = toCsv(['文件', ...fields.map((f) => f.name)], rows)
          outputs.unshift((await ctx.host.fs.writeAll('抽取结果.csv', csv, 'text/csv')).id)
        }
        return { outputs, summary: `从 ${ctx.inputs.length} 个文件抽取了 ${rows.length} 条记录` }
      },
    },

    {
      id: 'classify',
      name: 'AI 文本分类',
      category: 'ai',
      icon: 'list-ordered',
      description: '按给定的类别给文件或每一行文本打标签（工单分流、评论情感、意图识别），输出 CSV。',
      accept: ['.txt', '.md', '.csv', 'text/*'],
      multiple: true,
      input: 'both',
      keywords: ['classify', 'classification', 'label', 'sentiment', 'intent', 'tag', '分类', '打标签', '情感分析', '意图'],
      params: [
        { key: 'labels', type: 'textarea', label: '类别', rows: 3, default: '正面\n负面\n中性', hint: '每行一个类别，可在类别后用冒号补充说明。' },
        { key: 'unit', type: 'select', label: '分类对象', default: 'file', options: [{ value: 'file', label: '每个文件' }, { value: 'line', label: '每一行（非空行）' }] },
        { key: 'multi', type: 'switch', label: '允许多个标签', default: false },
        { key: 'reason', type: 'switch', label: '附上简短理由', default: false },
      ],

      async run(ctx) {
        const config = await loadConfig(ctx.host)
        const labels = parseFieldSpec(String(ctx.params.labels || ''))
        if (labels.length < 2) throw new Error('请至少定义两个类别')
        const items = []
        for (const input of ctx.inputs) {
          const text = await ctx.host.fs.readText(input.id)
          if (ctx.params.unit === 'line') text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach((line, i) => items.push({ source: `${input.name}#${i + 1}`, text: line }))
          else items.push({ source: input.name, text: plainText(input.name, text).slice(0, 12000) })
        }
        if (!items.length) throw new Error('没有可分类的文本')
        const labelText = labels.map((l) => `- ${l.name}${l.hint ? `: ${l.hint}` : ''}`).join('\n')
        const batchSize = ctx.params.unit === 'line' ? 20 : 1
        const batches = chunkArray(items, batchSize)
        const results = await mapLimit(ctx, config, batches, async (batch) => {
          const data = await chatJson(ctx, config, {
            messages: [
              { role: 'system', content: `Classify each item into ${ctx.params.multi ? 'one or more' : 'exactly one'} of these labels:\n${labelText}\nUse the label names exactly. Answer with JSON only.` },
              { role: 'user', content: `Return {"results": [{"id": number, "labels": [string]${ctx.params.reason ? ', "reason": string' : ''}}]} for these items:\n${batch.map((item, i) => `[${i}] ${item.text}`).join('\n\n')}` },
            ],
          })
          const list = Array.isArray(data?.results) ? data.results : []
          return batch.map((item, i) => {
            const hit = list.find((r) => Number(r.id) === i) || list[i] || {}
            const chosen = (Array.isArray(hit.labels) ? hit.labels : [hit.label]).map(String).filter((l) => labels.some((x) => x.name === l))
            return { 来源: item.source, 文本: item.text.slice(0, 200), 类别: (ctx.params.multi ? chosen : chosen.slice(0, 1)).join('；'), ...(ctx.params.reason ? { 理由: hit.reason ?? '' } : {}) }
          })
        }, (f) => ctx.progress(f, '分类中'))
        const rows = results.flat()
        const columns = ['来源', '文本', '类别', ...(ctx.params.reason ? ['理由'] : [])]
        const out = await ctx.host.fs.writeAll('分类结果.csv', toCsv(columns, rows), 'text/csv')
        const counts = labels.map((l) => `${l.name} ${rows.filter((r) => r.类别.split('；').includes(l.name)).length}`).join('、')
        return { outputs: [out.id], summary: `已分类 ${rows.length} 条：${counts}` }
      },
    },

    {
      id: 'csv-ai',
      name: 'AI 表格逐行处理',
      category: 'ai',
      icon: 'table',
      description: '对 CSV 的每一行套用提示词模板（如「把 {{地址}} 规范成省市区」），把模型的回答写入新列。',
      accept: ['.csv', '.tsv', 'text/csv'],
      multiple: false,
      input: 'both',
      textFileName: 'input.csv',
      keywords: ['csv', 'spreadsheet', 'batch', 'enrich', 'column', '表格', '批量', '逐行', '新增列', '数据清洗'],
      params: [
        { key: 'template', type: 'textarea', label: '提示词模板', rows: 3, default: '用一句话概括这条评论的主要诉求：{{评论}}', hint: '用 {{列名}} 引用当前行的值。' },
        { key: 'column', type: 'text', label: '新列名称', default: 'AI 结果' },
        { key: 'limit', type: 'number', label: '最多处理行数', default: 500, min: 1, max: 10000 },
      ],

      async run(ctx) {
        const config = await loadConfig(ctx.host)
        const { exports: libs } = await loadDependency('data-libs')
        const text = await ctx.host.fs.readText(ctx.inputs[0].id)
        const parsed = libs.Papa.parse(text.replace(/^\uFEFF/, ''), { header: true, skipEmptyLines: true })
        const columns = parsed.meta.fields || []
        const template = String(ctx.params.template || '')
        const used = [...template.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1])
        const missing = used.filter((c) => !columns.includes(c))
        if (!used.length) throw new Error('模板里没有引用任何列，请用 {{列名}} 引用')
        if (missing.length) throw new Error(`CSV 中没有这些列：${missing.join('、')}（可用列：${columns.join('、')}）`)
        const rows = parsed.data.slice(0, Math.max(1, Number(ctx.params.limit) || 500))
        const column = String(ctx.params.column || 'AI 结果')
        const batches = chunkArray(rows.map((row, i) => ({ i, prompt: template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, c) => String(row[c] ?? '')) })), 10)
        const answers = await mapLimit(ctx, config, batches, async (batch) => {
          const data = await chatJson(ctx, config, {
            messages: [
              { role: 'system', content: 'Answer each numbered task independently and concisely. Answer with JSON only.' },
              { role: 'user', content: `Return {"answers": [string, …]} with exactly ${batch.length} answers in order.\n\n${batch.map((b, k) => `Task ${k + 1}: ${b.prompt}`).join('\n\n')}` },
            ],
          })
          const list = Array.isArray(data?.answers) ? data.answers : []
          if (list.length !== batch.length) {
            // A model that miscounts gets the batch one task at a time instead.
            return Promise.all(batch.map(async (b) => (await chat(ctx, config, { messages: [{ role: 'user', content: `${b.prompt}\n\nAnswer concisely.` }] })).trim()))
          }
          return list.map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        }, (f) => ctx.progress(f, `处理 ${rows.length} 行`))
        const flat = answers.flat()
        rows.forEach((row, i) => (row[column] = flat[i] ?? ''))
        const csv = `\uFEFF${libs.Papa.unparse({ fields: [...columns, column], data: rows })}`
        const out = await ctx.host.fs.writeAll(withSuffix(ctx.inputs[0].name, '.AI', '.csv'), csv, 'text/csv')
        return { outputs: [out.id], summary: `已处理 ${rows.length} 行${parsed.data.length > rows.length ? `（共 ${parsed.data.length} 行，按上限截断）` : ''}` }
      },
    },

    {
      id: 'meeting-notes',
      name: 'AI 会议纪要',
      category: 'ai',
      icon: 'list-todo',
      description: '从会议转写稿或字幕中整理出摘要、决议、待办（负责人 / 截止时间）与未决问题。',
      accept: ['.txt', '.md', '.srt', '.vtt', 'text/*'],
      multiple: true,
      input: 'both',
      keywords: ['meeting', 'minutes', 'action items', 'transcript', '会议纪要', '待办', '决议', '整理录音'],
      params: [
        { key: 'language', type: 'select', label: '输出语言', default: '简体中文', options: LANGUAGES.map((l) => ({ value: l, label: l })) },
      ],

      async run(ctx) {
        const config = await loadConfig(ctx.host)
        const outputs = []
        for (const [index, input] of ctx.inputs.entries()) {
          const text = plainText(input.name, await ctx.host.fs.readText(input.id))
          const instruction = `Write meeting minutes in ${ctx.params.language} as Markdown with these sections: 摘要 (3-5 sentences), 决议, 待办 (a table: 事项 | 负责人 | 截止时间, use "—" when unknown), 未决问题. Only include what the transcript supports.`
          const notes = await mapReduce(ctx, config, text, instruction, (f, l) => ctx.progress((index + f) / ctx.inputs.length, `${l}：${input.name}`))
          outputs.push((await ctx.host.fs.writeAll(withSuffix(input.name, '.纪要', '.md'), `${notes.trim()}\n`, 'text/markdown')).id)
        }
        return { outputs, summary: `已整理 ${outputs.length} 份会议纪要` }
      },
    },

    {
      id: 'doc-qa',
      name: 'AI 文档问答',
      category: 'ai',
      icon: 'search',
      description: '就一批文档提问，回答附带引用的原文段落。配置了向量模型时按语义检索，否则按关键词检索。',
      accept: ['.txt', '.md', '.markdown', '.srt', '.vtt', '.html', '.csv', '.json', 'text/*'],
      multiple: true,
      keywords: ['question answering', 'rag', 'search', 'citation', 'embeddings', '问答', '文档检索', '知识库', '引用'],
      params: [
        { key: 'question', type: 'textarea', label: '问题', rows: 2, default: '' },
        { key: 'topK', type: 'slider', label: '参考段落数', min: 3, max: 20, default: 8 },
      ],

      async run(ctx) {
        const config = await loadConfig(ctx.host)
        const question = String(ctx.params.question || '').trim()
        if (!question) throw new Error('请先填写问题')
        const passages = []
        for (const input of ctx.inputs) {
          const text = plainText(input.name, await ctx.host.fs.readText(input.id))
          splitPassages(text, 900, 150).forEach((passage, i) => passages.push({ source: input.name, index: i + 1, text: passage }))
        }
        if (!passages.length) throw new Error('文档中没有文字')
        const k = Math.min(passages.length, Math.max(1, Number(ctx.params.topK) || 8))
        let ranked
        if (config.embedModel) {
          ctx.progress(0.1, '计算段落向量')
          const vectors = await embed(ctx, config, [question, ...passages.map((p) => p.text)])
          const [q, ...rest] = vectors
          ranked = passages.map((p, i) => ({ ...p, score: cosine(q, rest[i]) })).sort((a, b) => b.score - a.score)
        } else {
          ranked = passages.map((p) => ({ ...p, score: keywordScore(question, p.text) })).sort((a, b) => b.score - a.score)
        }
        const chosen = ranked.slice(0, k)
        ctx.progress(0.6, '生成回答')
        const context = chosen.map((p, i) => `[${i + 1}] (${p.source} · 第 ${p.index} 段)\n${p.text}`).join('\n\n')
        const answer = await chat(ctx, config, {
          messages: [
            { role: 'system', content: 'Answer the question using only the numbered passages. Cite passages like [1][3] after the sentences they support. If the passages do not contain the answer, say so. Answer in the language of the question.' },
            { role: 'user', content: `Passages:\n${context}\n\nQuestion: ${question}` },
          ],
        })
        const report = `# ${question}\n\n${answer.trim()}\n\n## 引用段落\n\n${chosen.map((p, i) => `**[${i + 1}] ${p.source} · 第 ${p.index} 段**${config.embedModel ? `（相似度 ${p.score.toFixed(3)}）` : ''}\n\n> ${p.text.replace(/\n/g, '\n> ')}`).join('\n\n')}\n`
        const out = await ctx.host.fs.writeAll('文档问答.md', report, 'text/markdown')
        return { outputs: [out.id], summary: `基于 ${passages.length} 个段落中的 ${chosen.length} 个回答（${config.embedModel ? '语义检索' : '关键词检索'}）` }
      },
    },

    {
      id: 'custom-prompt',
      name: 'AI 自定义提示词',
      category: 'ai',
      icon: 'wand',
      description: '用你自己的提示词批量处理文件：{{content}} 代表文件内容，{{filename}} 代表文件名。',
      accept: ['.txt', '.md', '.markdown', '.json', '.csv', '.srt', '.vtt', '.html', '.xml', '.yaml', '.yml', 'text/*'],
      multiple: true,
      input: 'both',
      keywords: ['prompt', 'custom', 'batch', 'llm', 'chatgpt', '提示词', '自定义', '批量处理'],
      params: [
        { key: 'system', type: 'textarea', label: '系统提示词', rows: 2, default: '你是一个严谨的助手。' },
        { key: 'prompt', type: 'textarea', label: '用户提示词', rows: 4, default: '请把下面的内容整理成一份 FAQ：\n\n{{content}}' },
        { key: 'ext', type: 'select', label: '输出为', default: 'md', options: [{ value: 'md', label: 'Markdown' }, { value: 'txt', label: '纯文本' }, { value: 'json', label: 'JSON（要求模型只输出 JSON）' }, { value: 'html', label: 'HTML' }, { value: 'csv', label: 'CSV' }] },
      ],

      async run(ctx) {
        const config = await loadConfig(ctx.host)
        const template = String(ctx.params.prompt || '')
        if (!template.includes('{{content}}')) throw new Error('用户提示词里需要包含 {{content}}')
        const ext = String(ctx.params.ext || 'md')
        const outputs = []
        await mapLimit(ctx, config, ctx.inputs, async (input) => {
          const content = await ctx.host.fs.readText(input.id)
          const prompt = template.replaceAll('{{content}}', content).replaceAll('{{filename}}', input.name)
          const messages = [...(ctx.params.system ? [{ role: 'system', content: String(ctx.params.system) }] : []), { role: 'user', content: prompt }]
          let body
          if (ext === 'json') body = `${JSON.stringify(await chatJson(ctx, config, { messages }), null, 2)}\n`
          else body = `${stripFence(await chat(ctx, config, { messages })).trim()}\n`
          const name = withSuffix(input.name, '.AI', `.${ext}`)
          outputs.push((await ctx.host.fs.writeAll(name, body, mimeOf(name))).id)
        }, (f) => ctx.progress(f, '处理中'))
        return { outputs, summary: `已处理 ${outputs.length} 个文件` }
      },
    },

    /* ================================================================== */
    /* Vision                                                             */
    /* ================================================================== */
    {
      id: 'detect',
      name: 'AI 目标检测打标',
      category: 'ai',
      icon: 'crop',
      description: '用视觉大模型框出图片中的目标，坐标统一归一化后导出 COCO、YOLO、LabelMe 标注与带框预览图，可直接用于训练数据集。',
      accept: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'],
      multiple: true,
      keywords: ['object detection', 'bounding box', 'bbox', 'annotation', 'label', 'coco', 'yolo', 'labelme', 'vlm', 'grounding', '目标检测', '打标', '标注', '数据集', '框选'],
      params: [
        { key: 'labels', type: 'textarea', label: '要检测的类别', rows: 3, default: '', placeholder: '每行一个，如：\n猫\n狗\n车牌', hint: '留空则检测画面中所有显著物体。' },
        { key: 'coords', type: 'select', label: '模型坐标格式', default: 'auto', options: [
          { value: 'auto', label: '自动识别（推荐）' },
          { value: 'norm1000', label: '0–1000 归一化 [x1, y1, x2, y2]（Qwen2-VL 等）' },
          { value: 'norm1', label: '0–1 归一化 [x1, y1, x2, y2]' },
          { value: 'pixel', label: '像素坐标 [x1, y1, x2, y2]（Qwen2.5-VL 等）' },
          { value: 'gemini', label: '0–1000 归一化 [ymin, xmin, ymax, xmax]（Gemini）' },
        ], hint: '提示词会要求 0–1000 归一化坐标；模型自有习惯时可在这里指定。' },
        { key: 'format', type: 'select', label: '导出', default: 'all', options: [
          { value: 'all', label: '全部（预览图 + COCO + YOLO + LabelMe）' }, { value: 'preview', label: '只要带框预览图' }, { value: 'coco', label: 'COCO JSON' }, { value: 'yolo', label: 'YOLO TXT' }, { value: 'labelme', label: 'LabelMe JSON' },
        ] },
        { key: 'maxSide', type: 'slider', label: '发送图片的最长边', min: 512, max: 2048, step: 128, default: 1280, suffix: 'px', hint: '越大越准，也越贵、越慢。' },
      ],

      async run(ctx) {
        const config = await loadConfig(ctx.host)
        const model = config.visionModel || config.chatModel
        const labels = parseFieldSpec(String(ctx.params.labels || '')).map((l) => l.name)
        const format = String(ctx.params.format || 'all')
        const want = (kind) => format === 'all' || format === kind
        const images = []
        await mapLimit(ctx, config, ctx.inputs, async (input) => {
          const image = await encodeImage(ctx.host, input, Number(ctx.params.maxSide) || 1280)
          const prompt = detectionPrompt(labels)
          const reply = await chat(ctx, config, {
            model,
            json: true,
            temperature: 0,
            messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image.dataUrl } }, { type: 'text', text: prompt }] }],
          })
          const detections = parseDetections(reply, { mode: String(ctx.params.coords || 'auto'), sentWidth: image.sentWidth, sentHeight: image.sentHeight, labels })
          images.push({ input, image, detections })
        }, (f) => ctx.progress(f * 0.8, '检测中'))

        images.sort((a, b) => ctx.inputs.indexOf(a.input) - ctx.inputs.indexOf(b.input))
        const classes = labels.length ? [...labels] : []
        for (const item of images) for (const d of item.detections) if (!classes.includes(d.label)) classes.push(d.label)
        const outputs = []
        ctx.progress(0.85, '写出标注')
        for (const { input, image, detections } of images) {
          const stem = input.name.replace(/\.[^.]+$/, '')
          if (want('preview')) {
            const png = await drawDetections(image.bitmap, detections, classes)
            outputs.push((await ctx.host.fs.writeAll(`detections/preview/${stem}.png`, png, 'image/png')).id)
          }
          if (want('yolo')) {
            const lines = detections.map((d) => `${classes.indexOf(d.label)} ${round6((d.box[0] + d.box[2]) / 2)} ${round6((d.box[1] + d.box[3]) / 2)} ${round6(d.box[2] - d.box[0])} ${round6(d.box[3] - d.box[1])}`)
            outputs.push((await ctx.host.fs.writeAll(`detections/yolo/labels/${stem}.txt`, lines.join('\n') + (lines.length ? '\n' : ''), 'text/plain')).id)
          }
          if (want('labelme')) {
            const doc = toLabelMe(input.name, image.width, image.height, detections)
            outputs.push((await ctx.host.fs.writeAll(`detections/labelme/${stem}.json`, `${JSON.stringify(doc, null, 2)}\n`, 'application/json')).id)
          }
          image.bitmap.close()
        }
        if (want('yolo')) outputs.push((await ctx.host.fs.writeAll('detections/yolo/classes.txt', `${classes.join('\n')}\n`, 'text/plain')).id)
        if (want('coco')) outputs.push((await ctx.host.fs.writeAll('detections/coco.json', `${JSON.stringify(toCoco(images, classes), null, 2)}\n`, 'application/json')).id)
        const total = images.reduce((n, item) => n + item.detections.length, 0)
        return { outputs, summary: `在 ${images.length} 张图片中检测到 ${total} 个目标（${classes.length} 个类别）` }
      },
    },

    {
      id: 'caption',
      name: 'AI 图片描述',
      category: 'ai',
      icon: 'image',
      description: '为图片生成替代文本、详细描述、商品卖点或社交配文，批量导出 CSV，也可为每张图生成同名文本（训练数据集常用）。',
      accept: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'],
      multiple: true,
      keywords: ['caption', 'alt text', 'describe image', 'vlm', 'dataset', '图片描述', '配文', '替代文本', '看图说话'],
      params: [
        { key: 'style', type: 'select', label: '风格', default: 'alt', options: [
          { value: 'alt', label: '替代文本（一句话，无障碍）' }, { value: 'detailed', label: '详细描述' }, { value: 'product', label: '电商卖点' }, { value: 'social', label: '社交媒体配文' }, { value: 'tags', label: '训练用标签（逗号分隔）' },
        ] },
        { key: 'language', type: 'select', label: '语言', default: '简体中文', options: LANGUAGES.map((l) => ({ value: l, label: l })) },
        { key: 'sidecar', type: 'switch', label: '为每张图片生成同名 .txt', default: false },
      ],

      async run(ctx) {
        const config = await loadConfig(ctx.host)
        const rows = []
        const outputs = []
        await mapLimit(ctx, config, ctx.inputs, async (input) => {
          const image = await encodeImage(ctx.host, input, 1024)
          image.bitmap.close()
          const text = (await visionChat(ctx, config, image, `${CAPTION_STYLES[ctx.params.style] || CAPTION_STYLES.alt} Write in ${ctx.params.language}. Output only the text.`)).trim()
          rows.push({ 文件: input.name, 描述: text })
          if (ctx.params.sidecar) outputs.push((await ctx.host.fs.writeAll(input.name.replace(/\.[^.]+$/, '.txt'), `${text}\n`, 'text/plain')).id)
        }, (f) => ctx.progress(f, '描述中'))
        rows.sort((a, b) => ctx.inputs.findIndex((i) => i.name === a.文件) - ctx.inputs.findIndex((i) => i.name === b.文件))
        outputs.unshift((await ctx.host.fs.writeAll('图片描述.csv', toCsv(['文件', '描述'], rows), 'text/csv')).id)
        return { outputs, summary: `已描述 ${rows.length} 张图片` }
      },
    },

    {
      id: 'vision-ocr',
      name: 'AI 图片 / PDF 转 Markdown',
      category: 'ai',
      icon: 'scan-text',
      description: '用视觉大模型把截图、照片、扫描件和 PDF 页面转成 Markdown，保留标题、列表、表格与公式结构。',
      accept: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf', '.pdf'],
      multiple: true,
      keywords: ['ocr', 'document parsing', 'pdf to markdown', 'table', 'formula', 'vlm', '图片转文字', '文档解析', 'PDF 转 Markdown', '表格识别'],
      params: [
        { key: 'pages', type: 'text', label: 'PDF 页码', default: '1-', placeholder: '如 1-3,7', hint: '仅对 PDF 生效。' },
        { key: 'maxSide', type: 'slider', label: '清晰度（最长边）', min: 1024, max: 2560, step: 256, default: 1536, suffix: 'px' },
      ],

      async run(ctx) {
        const config = await loadConfig(ctx.host)
        const outputs = []
        for (const [index, input] of ctx.inputs.entries()) {
          ctx.throwIfAborted()
          const pages = isPdf(input) ? await renderPdfPages(ctx.host, input, String(ctx.params.pages || '1-'), 150) : [{ label: input.name, bitmap: await createImageBitmap(await ctx.host.fs.blob(input.id)) }]
          const parts = await mapLimit(ctx, config, pages, async (page) => {
            const image = await encodeBitmap(page.bitmap, Number(ctx.params.maxSide) || 1536)
            page.bitmap.close()
            const md = await visionChat(ctx, config, image, 'Transcribe this page into Markdown. Keep headings, lists, tables (as Markdown tables) and formulas (as LaTeX between $…$). Do not describe images; transcribe their text. Output only Markdown.')
            return stripFence(md).trim()
          }, (f) => ctx.progress((index + f) / ctx.inputs.length, `识别 ${input.name}`))
          const body = pages.length > 1 ? parts.map((part, i) => `<!-- ${pages[i].label} -->\n\n${part}`).join('\n\n---\n\n') : parts[0]
          outputs.push((await ctx.host.fs.writeAll(withSuffix(input.name, '', '.md'), `${body}\n`, 'text/markdown')).id)
        }
        return { outputs, summary: `已转换 ${outputs.length} 个文件` }
      },
    },

    {
      id: 'image-qa',
      name: 'AI 看图问答',
      category: 'ai',
      icon: 'eye',
      description: '对每张图片提同一个问题（这张发票的金额是多少？图中有没有安全隐患？），结果汇总成表格。',
      accept: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'],
      multiple: true,
      keywords: ['visual question answering', 'vqa', 'ask image', 'vlm', '看图问答', '图片提问', '视觉问答'],
      params: [{ key: 'question', type: 'textarea', label: '问题', rows: 2, default: '图中主要内容是什么？' }],

      async run(ctx) {
        const config = await loadConfig(ctx.host)
        const question = String(ctx.params.question || '').trim()
        if (!question) throw new Error('请先填写问题')
        const rows = []
        await mapLimit(ctx, config, ctx.inputs, async (input) => {
          const image = await encodeImage(ctx.host, input, 1280)
          image.bitmap.close()
          rows.push({ 文件: input.name, 回答: (await visionChat(ctx, config, image, `${question}\nAnswer in the language of the question, concisely.`)).trim() })
        }, (f) => ctx.progress(f, '提问中'))
        rows.sort((a, b) => ctx.inputs.findIndex((i) => i.name === a.文件) - ctx.inputs.findIndex((i) => i.name === b.文件))
        const md = `# ${question}\n\n| 文件 | 回答 |\n| --- | --- |\n${rows.map((r) => `| ${escapeCell(r.文件)} | ${escapeCell(r.回答)} |`).join('\n')}\n`
        const outputs = [(await ctx.host.fs.writeAll('看图问答.md', md, 'text/markdown')).id, (await ctx.host.fs.writeAll('看图问答.csv', toCsv(['文件', '回答'], rows), 'text/csv')).id]
        return { outputs, summary: `已回答 ${rows.length} 张图片` }
      },
    },

    {
      id: 'image-sort',
      name: 'AI 图片分类整理',
      category: 'ai',
      icon: 'layout-grid',
      description: '按你给的类别把照片分进不同文件夹（打包下载即是整理好的目录），或为每张图生成关键词标签。',
      accept: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'],
      multiple: true,
      keywords: ['image classification', 'sort photos', 'organize', 'tagging', 'folders', '图片分类', '照片整理', '归档', '标签'],
      params: [
        { key: 'mode', type: 'select', label: '方式', default: 'folders', options: [{ value: 'folders', label: '按类别分文件夹' }, { value: 'keywords', label: '生成关键词标签（CSV）' }] },
        { key: 'labels', type: 'textarea', label: '类别', rows: 3, default: '人物\n风景\n美食\n文档截图\n其他', when: { key: 'mode', equals: 'folders' } },
      ],

      async run(ctx) {
        const config = await loadConfig(ctx.host)
        const folders = ctx.params.mode !== 'keywords'
        const labels = parseFieldSpec(String(ctx.params.labels || '')).map((l) => l.name)
        if (folders && labels.length < 2) throw new Error('请至少定义两个类别')
        const rows = []
        const outputs = []
        await mapLimit(ctx, config, ctx.inputs, async (input) => {
          const image = await encodeImage(ctx.host, input, 768)
          image.bitmap.close()
          if (folders) {
            const data = await visionJson(ctx, config, image, `Classify this image into exactly one of: ${labels.join(', ')}. Return {"label": string}.`)
            const label = labels.includes(data?.label) ? data.label : labels[labels.length - 1]
            const bytes = await ctx.host.fs.readAll(input.id)
            outputs.push((await ctx.host.fs.writeAll(`${safeName(label)}/${input.name}`, bytes, input.type)).id)
            rows.push({ 文件: input.name, 类别: label })
          } else {
            const data = await visionJson(ctx, config, image, 'List 5-12 short keywords describing this image (subjects, scene, style, colors) in Simplified Chinese. Return {"keywords": [string]}.')
            rows.push({ 文件: input.name, 关键词: (Array.isArray(data?.keywords) ? data.keywords : []).join('、') })
          }
        }, (f) => ctx.progress(f, '分类中'))
        rows.sort((a, b) => ctx.inputs.findIndex((i) => i.name === a.文件) - ctx.inputs.findIndex((i) => i.name === b.文件))
        outputs.push((await ctx.host.fs.writeAll(folders ? '分类结果.csv' : '图片关键词.csv', toCsv(folders ? ['文件', '类别'] : ['文件', '关键词'], rows), 'text/csv')).id)
        const summary = folders ? labels.map((l) => `${l} ${rows.filter((r) => r.类别 === l).length}`).filter((s) => !s.endsWith(' 0')).join('、') : `${rows.length} 张图片已生成关键词`
        return { outputs, summary: folders ? `已整理 ${rows.length} 张：${summary}` : summary }
      },
    },

    {
      id: 'table-image',
      name: 'AI 表格 / 图表转数据',
      category: 'ai',
      icon: 'table',
      description: '把表格截图、拍照的报表或柱状图、折线图还原成 CSV 数据。',
      accept: ['image/png', 'image/jpeg', 'image/webp'],
      multiple: true,
      keywords: ['table extraction', 'chart to data', 'screenshot to csv', '表格识别', '图表转数据', '截图转表格'],

      async run(ctx) {
        const config = await loadConfig(ctx.host)
        const outputs = []
        let totalRows = 0
        await mapLimit(ctx, config, ctx.inputs, async (input) => {
          const image = await encodeImage(ctx.host, input, 1600)
          image.bitmap.close()
          const data = await visionJson(ctx, config, image, 'Extract the table or the data plotted in this chart. Return {"columns": [string], "rows": [[string|number]]}. For charts, use one row per data point and read values as precisely as the axes allow. Do not add commentary.')
          const columns = Array.isArray(data?.columns) ? data.columns.map(String) : []
          const rows = Array.isArray(data?.rows) ? data.rows.filter(Array.isArray) : []
          if (!columns.length) throw new Error(`${input.name} 中没有识别出表格或图表数据`)
          totalRows += rows.length
          const objects = rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? ''])))
          outputs.push((await ctx.host.fs.writeAll(withSuffix(input.name, '', '.csv'), toCsv(columns, objects), 'text/csv')).id)
        }, (f) => ctx.progress(f, '识别中'))
        return { outputs, summary: `已从 ${outputs.length} 张图片还原 ${totalRows} 行数据` }
      },
    },

    {
      id: 'screenshot-html',
      name: 'AI 截图转网页',
      category: 'ai',
      icon: 'file-code',
      description: '把界面截图或手绘草图还原成单文件 HTML + CSS，可直接预览。',
      accept: ['image/png', 'image/jpeg', 'image/webp'],
      multiple: false,
      keywords: ['screenshot to code', 'html', 'ui', 'sketch to html', 'frontend', '截图转代码', '草图转网页', '还原页面'],
      params: [{ key: 'notes', type: 'textarea', label: '补充要求', rows: 2, default: '', placeholder: '如：响应式布局；使用中文字体' }],

      async run(ctx) {
        const config = await loadConfig(ctx.host)
        const input = ctx.inputs[0]
        const image = await encodeImage(ctx.host, input, 1600)
        image.bitmap.close()
        ctx.progress(null, '生成页面')
        const html = stripFence(await visionChat(ctx, config, image, `Recreate this UI as a single self-contained HTML file with inline CSS (no external scripts, fonts or images; use placeholders for pictures). Match layout, spacing, colors and text closely.${ctx.params.notes ? ` ${ctx.params.notes}` : ''} Output only the HTML document.`, 8000)).trim()
        if (!/<html|<body|<div/i.test(html)) throw new Error('模型没有返回 HTML，请换一个视觉能力更强的模型重试')
        const out = await ctx.host.fs.writeAll(withSuffix(input.name, '', '.html'), html.startsWith('<!') ? html : `<!doctype html>\n${html}`, 'text/html')
        return { outputs: [out.id], summary: `已生成 ${Math.round(html.length / 1024)} KB 的 HTML` }
      },
    },

    {
      id: 'smart-rename',
      name: 'AI 智能命名',
      category: 'ai',
      icon: 'pen-line',
      description: '根据内容给图片和文档起描述性的文件名（输出重命名后的副本），告别 IMG_2034.jpg。',
      accept: ['image/png', 'image/jpeg', 'image/webp', '.txt', '.md', '.csv', '.json', 'text/*'],
      multiple: true,
      keywords: ['rename', 'file name', 'organize', 'descriptive names', '智能命名', '重命名', '起文件名'],
      params: [
        { key: 'language', type: 'select', label: '文件名语言', default: 'zh', options: [{ value: 'zh', label: '中文' }, { value: 'en', label: 'English（小写连字符）' }] },
        { key: 'date', type: 'switch', label: '在开头加上今天的日期', default: false },
      ],

      async run(ctx) {
        const config = await loadConfig(ctx.host)
        const english = ctx.params.language === 'en'
        const rule = english ? 'Return {"name": string}: 3-6 lowercase English words joined by hyphens, no extension.' : 'Return {"name": string}: a concise Chinese file name of 4-16 characters, no extension, no punctuation other than hyphens.'
        const taken = new Set()
        const results = []
        await mapLimit(ctx, config, ctx.inputs, async (input) => {
          let data
          if (/^image\//.test(input.type)) {
            const image = await encodeImage(ctx.host, input, 768)
            image.bitmap.close()
            data = await visionJson(ctx, config, image, `Suggest a descriptive file name for this image. ${rule}`)
          } else {
            const text = (await ctx.host.fs.readText(input.id)).slice(0, 6000)
            data = await chatJson(ctx, config, { messages: [{ role: 'user', content: `Suggest a descriptive file name for this document. ${rule}\n\n"""\n${text}\n"""` }] })
          }
          results.push({ input, name: String(data?.name || '') })
        }, (f) => ctx.progress(f, '命名中'))
        results.sort((a, b) => ctx.inputs.indexOf(a.input) - ctx.inputs.indexOf(b.input))
        const today = new Date().toISOString().slice(0, 10)
        const outputs = []
        const pairs = []
        for (const { input, name } of results) {
          const ext = (/\.[^.]+$/.exec(input.name) || [''])[0]
          let base = safeName(english ? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : name) || input.name.replace(/\.[^.]+$/, '')
          if (ctx.params.date) base = `${today}-${base}`
          let candidate = `${base}${ext}`
          for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base}-${n}${ext}`
          taken.add(candidate.toLowerCase())
          outputs.push((await ctx.host.fs.writeAll(candidate, await ctx.host.fs.readAll(input.id), input.type)).id)
          pairs.push(`${input.name} → ${candidate}`)
        }
        return { outputs, summary: pairs.slice(0, 8).join('\n') + (pairs.length > 8 ? `\n… 共 ${pairs.length} 个` : '') }
      },
    },

    /* ================================================================== */
    /* Audio and image generation                                         */
    /* ================================================================== */
    {
      id: 'transcribe',
      name: 'AI 云端语音转写',
      category: 'ai',
      icon: 'type',
      description: '通过 /audio/transcriptions 接口（Whisper、SenseVoice 等）把音视频转成字幕或文稿。视频会先在本机提取并压缩音轨，超长音频自动分段。',
      accept: ['audio/*', 'video/*', '.mp3', '.m4a', '.wav', '.flac', '.ogg', '.mp4', '.mkv', '.mov', '.webm'],
      multiple: true,
      keywords: ['speech to text', 'transcription', 'whisper api', 'subtitles', 'asr', '语音转文字', '云端转写', '字幕'],
      params: [
        { key: 'format', type: 'select', label: '输出', default: 'srt', options: [{ value: 'srt', label: 'SRT 字幕' }, { value: 'vtt', label: 'WebVTT 字幕' }, { value: 'text', label: '纯文本' }] },
        { key: 'language', type: 'text', label: '语言代码', default: '', placeholder: '如 zh、en；留空自动识别' },
        { key: 'prompt', type: 'text', label: '提示词', default: '', placeholder: '专有名词、人名，帮助识别', hint: '部分服务支持。' },
      ],

      async run(ctx) {
        const config = await loadConfig(ctx.host)
        if (!config.sttModel) throw new Error('请先在「AI 连接设置」中填写语音转写模型')
        const outputs = []
        for (const [index, input] of ctx.inputs.entries()) {
          ctx.throwIfAborted()
          const probe = await ctx.host.ffmpeg.probe(input.id)
          if (!probe.audioCodec) throw new Error(`${input.name} 没有音轨（只有画面），无法转写`)
          ctx.progress(index / ctx.inputs.length, `压缩音轨：${input.name}`)
          const segments = await prepareSpeech(ctx, input, probe.durationSeconds || 0)
          const pieces = []
          for (const [n, segment] of segments.entries()) {
            ctx.throwIfAborted()
            ctx.progress((index + (n + 0.5) / segments.length) / ctx.inputs.length, `转写第 ${n + 1}/${segments.length} 段：${input.name}`)
            const bytes = await ctx.host.fs.readAll(segment.id)
            const format = ctx.params.format === 'text' ? 'text' : 'srt'
            const body = await transcribeRequest(ctx, config, bytes, `${input.name.replace(/\.[^.]+$/, '')}-${n + 1}.mp3`, format, ctx.params)
            pieces.push({ offset: segment.offset, body })
            await ctx.host.fs.remove(segment.id).catch(() => {})
          }
          const merged = mergeTranscripts(pieces, String(ctx.params.format))
          const ext = ctx.params.format === 'text' ? 'txt' : String(ctx.params.format)
          const name = input.name.replace(/\.[^.]+$/, `.${ext}`)
          outputs.push((await ctx.host.fs.writeAll(name, merged, mimeOf(name))).id)
        }
        ctx.progress(1)
        return { outputs, summary: `已转写 ${outputs.length} 个文件` }
      },
    },

    {
      id: 'tts',
      name: 'AI 语音合成',
      category: 'ai',
      icon: 'volume',
      description: '通过 /audio/speech 接口把文本朗读成 MP3，长文自动分段合成后拼接。',
      accept: ['.txt', '.md', 'text/plain', 'text/markdown'],
      multiple: false,
      input: 'both',
      keywords: ['text to speech', 'tts', 'voice', 'read aloud', 'audiobook', '语音合成', '朗读', '配音', '有声书'],
      params: [
        { key: 'voice', type: 'text', label: '音色', default: 'alloy', hint: 'OpenAI：alloy、echo、fable、onyx、nova、shimmer；其他服务请查阅其文档。' },
        { key: 'speed', type: 'slider', label: '语速', min: 0.5, max: 2, step: 0.1, default: 1 },
      ],

      async run(ctx) {
        const config = await loadConfig(ctx.host)
        if (!config.ttsModel) throw new Error('请先在「AI 连接设置」中填写语音合成模型')
        const input = ctx.inputs[0]
        const text = plainText(input.name, await ctx.host.fs.readText(input.id)).trim()
        if (!text) throw new Error('没有可朗读的文字')
        const parts = splitSentences(text, 3500)
        const audio = []
        for (const [i, part] of parts.entries()) {
          ctx.throwIfAborted()
          ctx.progress(i / parts.length, `合成第 ${i + 1}/${parts.length} 段`)
          const res = await request(ctx, config, '/audio/speech', {
            json: { model: config.ttsModel, input: part, voice: String(ctx.params.voice || 'alloy'), response_format: 'mp3', speed: Number(ctx.params.speed) || 1 },
          })
          audio.push(res.body)
        }
        const out = await ctx.host.fs.writeAll(input.name.replace(/\.[^.]+$/, '.mp3'), concatBytes(audio), 'audio/mpeg')
        return { outputs: [out.id], summary: `已合成 ${parts.length} 段，${Math.round(text.length)} 字` }
      },
    },

    {
      id: 'image-gen',
      name: 'AI 图像生成',
      category: 'ai',
      icon: 'image-plus',
      description: '通过 /images/generations 接口按描述生成图片。',
      input: 'none',
      keywords: ['image generation', 'text to image', 'dall-e', 'gpt-image', 'flux', '文生图', '生成图片', 'AI 绘画'],
      params: [
        { key: 'prompt', type: 'textarea', label: '描述', rows: 4, default: '' },
        { key: 'size', type: 'select', label: '尺寸', default: '1024x1024', options: ['1024x1024', '1536x1024', '1024x1536', '512x512'].map((s) => ({ value: s, label: s })) },
        { key: 'n', type: 'slider', label: '数量', min: 1, max: 4, default: 1 },
      ],

      async run(ctx) {
        const config = await loadConfig(ctx.host)
        if (!config.imageModel) throw new Error('请先在「AI 连接设置」中填写图像生成模型')
        const prompt = String(ctx.params.prompt || '').trim()
        if (!prompt) throw new Error('请先填写图片描述')
        ctx.progress(null, '生成中')
        const payload = { model: config.imageModel, prompt, size: String(ctx.params.size), n: Number(ctx.params.n) || 1, response_format: 'b64_json' }
        let res = await request(ctx, config, '/images/generations', { json: payload, allowError: true })
        if (!res.ok && res.status === 400 && /response_format/i.test(res.text)) {
          delete payload.response_format
          res = await request(ctx, config, '/images/generations', { json: payload })
        } else if (!res.ok) {
          throw apiError(res, config)
        }
        const data = JSON.parse(res.text)
        const outputs = []
        for (const [i, item] of (data.data || []).entries()) {
          let bytes
          if (item.b64_json) bytes = base64ToBytes(item.b64_json)
          else if (item.url) bytes = (await ctx.host.net.fetch(item.url)).body
          else continue
          outputs.push((await ctx.host.fs.writeAll(`生成图片-${Date.now()}-${i + 1}.png`, bytes, 'image/png')).id)
        }
        if (!outputs.length) throw new Error('接口没有返回图片')
        return { outputs, summary: `已生成 ${outputs.length} 张图片` }
      },
    },
  ],
})

/* ========================================================================== */
/* Configuration                                                              */
/* ========================================================================== */

function presetConfig(value) {
  const preset = PRESETS.find((p) => p.value === value) || PRESETS[0]
  const { label, value: id, ...fields } = preset
  return { preset: id, concurrency: 2, temperature: 0.3, jsonMode: true, ...fields }
}

function presetLabel(value) {
  return (PRESETS.find((p) => p.value === value) || { label: 'API' }).label
}

function pickState(state) {
  const out = {}
  for (const key of CONFIG_FIELDS) if (state && state[key] !== undefined) out[key] = state[key]
  return out
}

function normaliseConfig(raw) {
  const cfg = { ...presetConfig('custom'), ...pickState(raw) }
  cfg.baseUrl = String(cfg.baseUrl || '').trim().replace(/\/+$/, '')
  for (const key of ['chatModel', 'visionModel', 'embedModel', 'sttModel', 'ttsModel', 'imageModel']) cfg[key] = String(cfg[key] || '').trim()
  cfg.auth = cfg.auth !== false
  cfg.jsonMode = cfg.jsonMode !== false
  cfg.concurrency = Math.min(8, Math.max(1, Math.round(Number(cfg.concurrency) || 2)))
  cfg.temperature = Math.min(2, Math.max(0, Number(cfg.temperature ?? 0.3)))
  return cfg
}

function originOf(url) {
  try {
    const parsed = new URL(String(url || '').trim())
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : ''
  } catch (err) {
    return ''
  }
}

async function loadConfig(host) {
  const saved = await host.kv.get(CONFIG_KEY)
  if (!saved || !saved.baseUrl || !saved.chatModel) throw new Error('还没有配置模型服务：请先打开「AI 连接设置」，选择服务商并保存')
  const config = normaliseConfig(saved)
  if (config.auth) await ensureKey(host, config)
  return config
}

/** Makes sure an API key is stored for the endpoint's origin, asking the user when it is not. */
async function ensureKey(host, config) {
  const origin = originOf(config.baseUrl)
  const stored = (await listSecrets(host)).find((s) => s.name === SECRET_NAME)
  if (stored && stored.origins.includes(origin)) return
  const accepted = await host.secret.request(SECRET_NAME, {
    label: `${presetLabel(config.preset)} API Key`,
    hint: stored ? `已保存的 Key 绑定在 ${stored.origins.join('、')}，当前接口是 ${origin}，需要重新录入` : `只会发往 ${origin}`,
    origins: [origin],
    force: Boolean(stored),
  })
  if (!accepted) throw new Error('没有录入 API Key。可以在「AI 连接设置」中录入，或关闭「需要 API Key」')
}

/**
 * `secret` is granted separately from `net`, and a user may decline it - fine for
 * keyless local servers. Say what to do instead of surfacing the host's refusal.
 */
async function listSecrets(host) {
  try {
    return await host.secret.list()
  } catch (err) {
    if (/未被授予/.test(String((err && err.message) || err))) throw new Error(SECRET_NOT_GRANTED)
    throw err
  }
}

const SECRET_NOT_GRANTED = '该服务需要 API Key，但插件未获得「凭据保管（secret）」授权：请在「插件与订阅」中为「AI 扩展工具箱」开启，或在「AI 连接设置」中关闭「需要 API Key」'

async function describeKey(host, config) {
  if (!config.auth) return '不需要'
  let secrets
  try {
    secrets = await listSecrets(host)
  } catch (err) {
    return '未授权「凭据保管」能力，无法保存 API Key'
  }
  const stored = secrets.find((s) => s.name === SECRET_NAME)
  if (!stored) return '未录入'
  const origin = originOf(config.baseUrl)
  return stored.origins.includes(origin) ? `已录入（仅发往 ${origin}）` : `已录入，但绑定在 ${stored.origins.join('、')}，与当前 Base URL 不符`
}

/* ========================================================================== */
/* HTTP                                                                       */
/* ========================================================================== */

/**
 * One request to the endpoint, retrying rate limits and transient server
 * errors with backoff. `json` sends a JSON body; `body` sends raw bytes with
 * the given `contentType`.
 */
async function request(ctx, config, path, { json, body, contentType, allowError = false, attempts = 4 } = {}) {
  const url = `${config.baseUrl}${path}`
  const headers = {}
  if (config.auth) headers.Authorization = `Bearer {{secret:${SECRET_NAME}}}`
  if (json !== undefined) headers['Content-Type'] = 'application/json'
  else if (contentType) headers['Content-Type'] = contentType
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    ctx.throwIfAborted()
    let res
    try {
      res = await ctx.host.net.fetch(url, { method: 'POST', headers, body: json !== undefined ? JSON.stringify(json) : body })
    } catch (err) {
      const message = String((err && err.message) || err)
      if (/本机|内网|凭据|secret|已阻止/.test(message)) throw err
      lastError = new Error(`无法连接 ${originOf(url)}：${message}。请检查地址与网络；如果是本机 Ollama，需要设置环境变量 OLLAMA_ORIGINS 允许浏览器访问`)
      if (attempt === attempts) throw lastError
      await sleep(ctx, 800 * attempt)
      continue
    }
    const text = decodeText(res.body)
    const wrapped = { ...res, text }
    if (res.ok || allowError) return wrapped
    if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
      const retryAfter = Number(res.headers['retry-after'])
      await sleep(ctx, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500 * 2 ** (attempt - 1))
      continue
    }
    throw apiError(wrapped, config)
  }
  throw lastError || new Error('请求失败')
}

function apiError(res, config) {
  let detail = ''
  try {
    const data = JSON.parse(res.text)
    detail = data.error?.message || data.message || data.detail || ''
  } catch (err) {
    detail = String(res.text || '').slice(0, 200)
  }
  const hint = {
    400: '请求参数不被接受（模型名、图片或参数可能不受支持）',
    401: 'API Key 无效或已过期，请在「AI 连接设置」中更换',
    403: '没有权限使用该模型或接口',
    404: `接口或模型不存在，请检查 Base URL（${config.baseUrl}）与模型名`,
    413: '内容过大，请减小文件或分段处理',
    429: '请求过于频繁或额度用尽，请稍后重试或降低并发数',
  }[res.status] || `服务返回错误 ${res.status}`
  return new Error(detail ? `${hint}：${detail}` : hint)
}

async function chat(ctx, config, { messages, model, json = false, temperature, maxTokens }) {
  const payload = { model: model || config.chatModel, messages, temperature: temperature ?? config.temperature, stream: false }
  if (maxTokens) payload.max_tokens = maxTokens
  if (json && config.jsonMode) payload.response_format = { type: 'json_object' }
  let res = await request(ctx, config, '/chat/completions', { json: payload, allowError: Boolean(payload.response_format) })
  if (!res.ok) {
    // Endpoints without JSON mode reject the whole request; the prompt still asks for JSON.
    if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 429) {
      delete payload.response_format
      res = await request(ctx, config, '/chat/completions', { json: payload })
    } else {
      throw apiError(res, config)
    }
  }
  let data
  try {
    data = JSON.parse(res.text)
  } catch (err) {
    throw new Error(`服务返回的不是 JSON：${res.text.slice(0, 120)}`)
  }
  const message = data.choices && data.choices[0] && data.choices[0].message
  if (!message) throw new Error(`服务没有返回回答：${res.text.slice(0, 160)}`)
  const content = Array.isArray(message.content) ? message.content.map((part) => part.text || '').join('') : String(message.content || '')
  // Reasoning models may inline their thinking; only the answer is wanted.
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

async function chatJson(ctx, config, options) {
  const text = await chat(ctx, config, { ...options, json: true })
  const data = parseJsonLoose(text)
  if (data === undefined) throw new Error(`模型没有返回有效的 JSON：${text.slice(0, 160)}`)
  return data
}

async function visionChat(ctx, config, image, prompt, maxTokens) {
  return chat(ctx, config, {
    model: config.visionModel || config.chatModel,
    maxTokens,
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image.dataUrl } }, { type: 'text', text: prompt }] }],
  })
}

async function visionJson(ctx, config, image, prompt) {
  const text = await chat(ctx, config, {
    model: config.visionModel || config.chatModel,
    json: true,
    temperature: 0,
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image.dataUrl } }, { type: 'text', text: `${prompt} Answer with JSON only.` }] }],
  })
  const data = parseJsonLoose(text)
  if (data === undefined) throw new Error(`模型没有返回有效的 JSON：${text.slice(0, 160)}`)
  return data
}

async function embed(ctx, config, inputs) {
  const vectors = []
  for (const batch of chunkArray(inputs, 64)) {
    const res = await request(ctx, config, '/embeddings', { json: { model: config.embedModel, input: batch } })
    const data = JSON.parse(res.text)
    const sorted = [...(data.data || [])].sort((a, b) => a.index - b.index)
    if (sorted.length !== batch.length) throw new Error('向量接口返回的数量与请求不符')
    vectors.push(...sorted.map((d) => d.embedding))
  }
  return vectors
}

/** Runs `fn` over items with the configured concurrency, keeping result order. */
async function mapLimit(ctx, config, items, fn, onProgress = () => {}) {
  const results = new Array(items.length)
  let next = 0
  let done = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      ctx.throwIfAborted()
      results[index] = await fn(items[index], index)
      done++
      onProgress(done / items.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length, config.concurrency || 2) }, worker))
  return results
}

function sleep(ctx, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    ctx.signal?.addEventListener?.('abort', () => {
      clearTimeout(timer)
      reject(new Error('已取消'))
    }, { once: true })
  })
}

/* ========================================================================== */
/* Text helpers                                                               */
/* ========================================================================== */

const REWRITE_MODES = {
  polish: 'Proofread the text: fix typos, grammar and awkward phrasing with as few changes as possible.',
  formal: 'Rewrite the text in a formal, professional written register.',
  casual: 'Rewrite the text in a relaxed, conversational tone.',
  concise: 'Make the text more concise: remove redundancy and filler while keeping every fact.',
  expand: 'Expand the text with relevant detail and smoother transitions, without inventing facts.',
  simple: 'Rewrite the text so a general reader understands it easily; explain jargon briefly.',
}

const CAPTION_STYLES = {
  alt: 'Write one concise sentence of alt text describing this image for a screen reader.',
  detailed: 'Describe this image in detail: subjects, actions, setting, composition, colors and any visible text.',
  product: 'Write persuasive product copy for the item in this image: 3-5 short selling points.',
  social: 'Write an engaging social media caption for this image, with 2-3 fitting hashtags.',
  tags: 'List comma-separated tags describing this image for a training dataset, most important first.',
}

function summaryInstruction(p) {
  const length = { short: 'one sentence', standard: 'about 200 characters or words', detailed: 'about 600 characters or words' }[p.length] || 'about 200 words'
  const format = { bullets: 'a Markdown bullet list', paragraph: 'a single paragraph', report: 'Markdown with the sections 背景, 要点, 结论' }[p.format] || 'a Markdown bullet list'
  const language = p.language && p.language !== 'same' ? p.language : 'the same language as the text'
  return `Summarize the text in ${length}, formatted as ${format}, written in ${language}. Only include information present in the text.`
}

/**
 * Summarises text that may exceed the model's context: chunks are summarised
 * first, then the partial summaries are combined with the final instruction.
 */
async function mapReduce(ctx, config, text, instruction, onProgress) {
  const LIMIT = 24000
  if (text.length <= LIMIT) {
    onProgress(0.3, '生成中')
    return chat(ctx, config, { messages: [{ role: 'system', content: instruction }, { role: 'user', content: text }] })
  }
  const chunks = splitPassages(text, 12000, 400)
  const partial = await mapLimit(ctx, config, chunks, (chunk, i) =>
    chat(ctx, config, { messages: [{ role: 'system', content: 'Summarize this part of a longer document in detail, keeping names, numbers, decisions and action items. Same language as the text.' }, { role: 'user', content: `Part ${i + 1}/${chunks.length}:\n${chunk}` }] }),
  (f) => onProgress(f * 0.8, `分段处理 ${chunks.length} 段`))
  onProgress(0.85, '汇总')
  return chat(ctx, config, { messages: [{ role: 'system', content: instruction }, { role: 'user', content: partial.map((s, i) => `Part ${i + 1}:\n${s}`).join('\n\n') }] })
}

function textKind(name, text) {
  if (/\.srt$/i.test(name)) return 'srt'
  if (/\.vtt$/i.test(name) || /^\uFEFF?WEBVTT/.test(text)) return 'vtt'
  if (/\.json$/i.test(name)) return 'json'
  return 'markdown'
}

/** Text worth reading from a file: subtitles lose their timings, HTML its tags. */
function plainText(name, text) {
  if (/\.(srt|vtt)$/i.test(name) || /^\uFEFF?WEBVTT/.test(text)) return parseSubtitles(text).map((c) => c.text).join('\n')
  if (/\.html?$/i.test(name)) return text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n')
  return text.replace(/^\uFEFF/, '')
}

/** Markdown split into blocks at blank lines, with fenced code kept whole and marked. */
function splitMarkdownBlocks(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let current = []
  let fence = null
  const flush = (code = false) => {
    if (current.length) blocks.push({ text: current.join('\n'), code })
    current = []
  }
  for (const line of lines) {
    const marker = /^\s*(```|~~~)/.exec(line)
    if (fence) {
      current.push(line)
      if (marker && line.trim().startsWith(fence)) {
        flush(true)
        fence = null
      }
      continue
    }
    if (marker) {
      flush()
      fence = marker[1]
      current.push(line)
      continue
    }
    if (line.trim() === '') flush()
    else current.push(line)
  }
  flush(Boolean(fence))
  return blocks
}

/** Groups consecutive prose blocks up to `limit` characters; code blocks stay on their own. */
function packBlocks(blocks, limit) {
  const chunks = []
  let prose = []
  let size = 0
  const flush = () => {
    if (prose.length) chunks.push({ text: prose.join('\n\n'), code: false, blocks: prose.length })
    prose = []
    size = 0
  }
  for (const block of blocks) {
    if (block.code) {
      flush()
      chunks.push({ text: block.text, code: true, blocks: 1 })
      continue
    }
    if (size && size + block.text.length > limit) flush()
    prose.push(block.text)
    size += block.text.length + 2
  }
  flush()
  return chunks
}

function translationInstruction(p) {
  const style = { natural: 'natural and fluent', formal: 'formal and polished', technical: 'precise, keeping technical terms accurate', casual: 'casual and conversational' }[p.style] || 'natural and fluent'
  const glossary = parseGlossary(String(p.glossary || ''))
  return [
    `You are a professional translator. Translate into ${p.target}, ${style}.`,
    'Preserve Markdown syntax, links, URLs, inline code, HTML tags, placeholders like {name} or %s, and numbers exactly.',
    glossary.length ? `Use this glossary:\n${glossary.map(([a, b]) => `${a} → ${b}`).join('\n')}` : '',
    'Output only the translation, with no explanations.',
  ].filter(Boolean).join('\n')
}

async function translateDocument(ctx, config, text, p, report) {
  const blocks = splitMarkdownBlocks(text)
  const chunks = packBlocks(blocks, Number(p.chunk) || 2500)
  const instruction = translationInstruction(p)
  const translated = await mapLimit(ctx, config, chunks, async (chunk) => {
    if (chunk.code) return { source: chunk.text, target: chunk.text, code: true }
    const target = (await chat(ctx, config, { messages: [{ role: 'system', content: instruction }, { role: 'user', content: chunk.text }] })).trim()
    return { source: chunk.text, target: stripFence(target, chunk.text), code: false }
  }, (f) => report(f, '翻译'))
  if (!p.bilingual) return `${translated.map((t) => t.target).join('\n\n')}\n`
  return `${translated.map((t) => (t.code ? t.source : pairParagraphs(t.source, t.target))).join('\n\n')}\n`
}

/** Interleaves source and translation paragraph by paragraph, falling back to whole chunks when counts differ. */
function pairParagraphs(source, target) {
  const a = source.split(/\n{2,}/)
  const b = target.split(/\n{2,}/)
  if (a.length !== b.length) return `${source}\n\n${target}`
  return a.map((para, i) => `${para}\n\n${b[i]}`).join('\n\n')
}

async function translateSubtitles(ctx, config, text, kind, p, report) {
  const cues = parseSubtitles(text)
  if (!cues.length) throw new Error('没有识别出字幕条目')
  const batches = chunkArray(cues, 40)
  const instruction = `${translationInstruction(p)}\nYou translate subtitle lines. Return {"lines": [string, …]} with exactly one translation per input line, in order. Keep each translation short enough for a subtitle.`
  const done = await mapLimit(ctx, config, batches, async (batch) => {
    const data = await chatJson(ctx, config, {
      messages: [{ role: 'system', content: instruction }, { role: 'user', content: JSON.stringify({ lines: batch.map((c) => c.text) }) }],
    })
    let lines = Array.isArray(data?.lines) ? data.lines.map(String) : []
    if (lines.length !== batch.length) {
      // Merged or split lines would shift every later subtitle; translate them one by one instead.
      lines = []
      for (const cue of batch) lines.push((await chat(ctx, config, { messages: [{ role: 'system', content: translationInstruction(p) }, { role: 'user', content: cue.text }] })).trim())
    }
    return lines
  }, (f) => report(f, '翻译字幕'))
  const translated = done.flat()
  const out = cues.map((cue, i) => ({ ...cue, text: p.bilingual ? `${cue.text}\n${translated[i]}` : translated[i] }))
  return kind === 'vtt' ? formatVtt(out) : formatSrt(out)
}

async function translateJsonValues(ctx, config, text, p, report) {
  let data
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (err) {
    throw new Error(`不是合法的 JSON：${err.message}`)
  }
  const entries = []
  collectStrings(data, [], entries)
  if (!entries.length) return `${JSON.stringify(data, null, 2)}\n`
  const instruction = `${translationInstruction(p)}\nYou translate UI strings from a localization file. Return {"strings": [string, …]} with exactly one translation per input, in order.`
  const batches = chunkArray(entries, 60)
  const done = await mapLimit(ctx, config, batches, async (batch) => {
    const result = await chatJson(ctx, config, { messages: [{ role: 'system', content: instruction }, { role: 'user', content: JSON.stringify({ strings: batch.map((e) => e.value) }) }] })
    const list = Array.isArray(result?.strings) ? result.strings.map(String) : []
    if (list.length !== batch.length) throw new Error('模型返回的条目数与原文不一致，请减小并发或换一个模型重试')
    return list
  }, (f) => report(f, '翻译 JSON'))
  const translated = done.flat()
  entries.forEach((entry, i) => setPath(data, entry.path, translated[i]))
  return `${JSON.stringify(data, null, 2)}\n`
}

function collectStrings(value, path, out) {
  if (typeof value === 'string') {
    if (value.trim()) out.push({ path, value })
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => collectStrings(item, [...path, i], out))
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) collectStrings(item, [...path, key], out)
  }
}

function setPath(root, path, value) {
  let node = root
  for (let i = 0; i < path.length - 1; i++) node = node[path[i]]
  node[path[path.length - 1]] = value
}

function parseGlossary(text) {
  return text.split(/\r?\n/).map((line) => line.split(/[=＝→]/)).filter((parts) => parts.length >= 2 && parts[0].trim()).map((parts) => [parts[0].trim(), parts.slice(1).join('=').trim()])
}

function parseFieldSpec(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = /^([^:：]+)[:：]\s*(.*)$/.exec(line)
    return match ? { name: match[1].trim(), hint: match[2].trim() } : { name: line, hint: '' }
  })
}

/* ------------------------------ subtitles -------------------------------- */

function parseSubtitles(text) {
  const blocks = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split(/\n{2,}/)
  const cues = []
  for (const block of blocks) {
    const lines = block.split('\n')
    const timeIndex = lines.findIndex((l) => /-->/.test(l))
    if (timeIndex === -1) continue
    const [start, end] = lines[timeIndex].split('-->').map((s) => s.trim().split(/\s+/)[0])
    const body = lines.slice(timeIndex + 1).join('\n').trim()
    if (!body) continue
    cues.push({ start: parseTimestamp(start), end: parseTimestamp(end), text: body })
  }
  return cues
}

function parseTimestamp(value) {
  const parts = String(value).replace(',', '.').split(':').map(Number)
  if (parts.some((n) => !Number.isFinite(n))) return 0
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]
}

function formatTimestamp(seconds, separator) {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`
}

function formatSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${formatTimestamp(c.start, ',')} --> ${formatTimestamp(c.end, ',')}\n${c.text}\n`).join('\n')
}

function formatVtt(cues) {
  return `WEBVTT\n\n${cues.map((c) => `${formatTimestamp(c.start, '.')} --> ${formatTimestamp(c.end, '.')}\n${c.text}\n`).join('\n')}`
}

/* ------------------------------ retrieval -------------------------------- */

/** Overlapping passages, cut at paragraph or sentence ends where possible. */
function splitPassages(text, size, overlap) {
  const clean = text.replace(/\r\n/g, '\n').trim()
  if (clean.length <= size) return clean ? [clean] : []
  const out = []
  let start = 0
  while (start < clean.length) {
    let end = Math.min(clean.length, start + size)
    if (end < clean.length) {
      const window = clean.slice(start, end)
      const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('。'), window.lastIndexOf('. '), window.lastIndexOf('\n'))
      if (cut > size * 0.5) end = start + cut + 1
    }
    out.push(clean.slice(start, end).trim())
    if (end >= clean.length) break
    start = Math.max(start + 1, end - overlap)
  }
  return out.filter(Boolean)
}

function splitSentences(text, limit) {
  const sentences = text.replace(/\s+\n/g, '\n').split(/(?<=[。！？!?；;.\n])/)
  const parts = []
  let current = ''
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > limit) {
      parts.push(current.trim())
      current = ''
    }
    if (sentence.length > limit) {
      for (let i = 0; i < sentence.length; i += limit) parts.push(sentence.slice(i, i + limit))
      continue
    }
    current += sentence
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

/** Term overlap with CJK bigrams, for retrieval without an embedding model. */
function keywordScore(query, text) {
  const terms = tokenize(query)
  if (!terms.length) return 0
  const haystack = new Map()
  for (const t of tokenize(text)) haystack.set(t, (haystack.get(t) || 0) + 1)
  let score = 0
  for (const t of new Set(terms)) if (haystack.has(t)) score += 1 + Math.log(haystack.get(t))
  return score / Math.sqrt(new Set(terms).size)
}

function tokenize(text) {
  const lower = String(text).toLowerCase()
  const words = lower.match(/[a-z0-9]{2,}/g) || []
  const cjk = lower.match(/[一-鿿]+/g) || []
  const grams = []
  for (const run of cjk) {
    if (run.length === 1) grams.push(run)
    for (let i = 0; i < run.length - 1; i++) grams.push(run.slice(i, i + 2))
  }
  return [...words, ...grams]
}

/* ========================================================================== */
/* Vision helpers                                                             */
/* ========================================================================== */

async function encodeImage(host, input, maxSide) {
  let bitmap
  try {
    bitmap = await createImageBitmap(await host.fs.blob(input.id, input.type))
  } catch (err) {
    throw new Error(`无法解码 ${input.name}：请先用「批量压缩 / 格式转换」转为 PNG 或 JPEG`)
  }
  return encodeBitmap(bitmap, maxSide)
}

/** A JPEG data URL of the bitmap scaled to `maxSide`, plus both sizes for coordinate conversion. */
async function encodeBitmap(bitmap, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const sentWidth = Math.max(1, Math.round(bitmap.width * scale))
  const sentHeight = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(sentWidth, sentHeight)
  const g = canvas.getContext('2d')
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, sentWidth, sentHeight)
  g.imageSmoothingQuality = 'high'
  g.drawImage(bitmap, 0, 0, sentWidth, sentHeight)
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
  const dataUrl = `data:image/jpeg;base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`
  return { bitmap, dataUrl, width: bitmap.width, height: bitmap.height, sentWidth, sentHeight }
}

function detectionPrompt(labels) {
  const target = labels.length ? `Detect every instance of these object classes: ${labels.join(', ')}. Use exactly these label names.` : 'Detect every clearly visible, salient object and give each a short lowercase label.'
  return `${target}
Return JSON only, in this shape: {"objects": [{"label": string, "box": [x1, y1, x2, y2]}]}.
Coordinates are integers normalized to 0-1000: x relative to image width, y relative to image height, origin at the top-left corner, (x1, y1) the top-left and (x2, y2) the bottom-right of a tight box.
List each instance separately. Return {"objects": []} if nothing matches.`
}

/**
 * Model output → detections with boxes normalised to 0-1 `[x1, y1, x2, y2]`.
 *
 * Vision models disagree on coordinates: Qwen2-VL and most prompts use 0-1000,
 * Qwen2.5-VL answers in pixels of the image it received, Gemini writes
 * `box_2d` as `[ymin, xmin, ymax, xmax]` in 0-1000, some use 0-1 floats. `mode`
 * forces one; `auto` recognises the key names and the value ranges.
 */
function parseDetections(text, { mode = 'auto', sentWidth, sentHeight, labels = [] }) {
  const data = parseJsonLoose(text)
  const list = Array.isArray(data) ? data : data && typeof data === 'object' ? data.objects || data.detections || data.results || data.boxes || data.items || [] : []
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== 'object') continue
    const label = String(item.label ?? item.name ?? item.class ?? item.category ?? item.object ?? 'object').trim()
    let geminiKey = false
    let values = null
    for (const key of ['box', 'bbox', 'bbox_2d', 'box_2d', 'bounding_box', 'coordinates', 'coords']) {
      if (Array.isArray(item[key]) && item[key].length >= 4) {
        values = item[key].slice(0, 4).map(Number)
        geminiKey = key === 'box_2d'
        break
      }
      if (item[key] && typeof item[key] === 'object' && !Array.isArray(item[key])) {
        values = objectBox(item[key])
        if (values) break
      }
    }
    if (!values) values = objectBox(item)
    if (!values || values.some((v) => !Number.isFinite(v))) continue

    let effective = mode
    if (mode === 'auto') {
      const max = Math.max(...values)
      if (geminiKey) effective = 'gemini'
      else if (max <= 1.0001) effective = 'norm1'
      else if (max > 1000) effective = 'pixel'
      else effective = 'norm1000'
    }
    let [x1, y1, x2, y2] = effective === 'gemini' ? [values[1], values[0], values[3], values[2]] : values
    const sx = effective === 'pixel' ? sentWidth : effective === 'norm1' ? 1 : 1000
    const sy = effective === 'pixel' ? sentHeight : effective === 'norm1' ? 1 : 1000
    x1 /= sx
    x2 /= sx
    y1 /= sy
    y2 /= sy
    const box = [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)].map((v) => Math.min(1, Math.max(0, v)))
    if (box[2] - box[0] < 0.002 || box[3] - box[1] < 0.002) continue
    const matched = labels.length ? labels.find((l) => l.toLowerCase() === label.toLowerCase()) : null
    if (labels.length && !matched) continue
    out.push({ label: matched || label, box })
  }
  return out
}

function objectBox(o) {
  const n = (k) => (o[k] === undefined ? NaN : Number(o[k]))
  if ([n('x1'), n('y1'), n('x2'), n('y2')].every(Number.isFinite)) return [n('x1'), n('y1'), n('x2'), n('y2')]
  if ([n('xmin'), n('ymin'), n('xmax'), n('ymax')].every(Number.isFinite)) return [n('xmin'), n('ymin'), n('xmax'), n('ymax')]
  if ([n('left'), n('top'), n('right'), n('bottom')].every(Number.isFinite)) return [n('left'), n('top'), n('right'), n('bottom')]
  if ([n('x'), n('y'), n('width'), n('height')].every(Number.isFinite)) return [n('x'), n('y'), n('x') + n('width'), n('y') + n('height')]
  return null
}

const BOX_COLORS = ['#ef4444', '#22c55e', '#3b82f6', '#f59e0b', '#a855f7', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#14b8a6']

async function drawDetections(bitmap, detections, classes) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const g = canvas.getContext('2d')
  g.drawImage(bitmap, 0, 0)
  const line = Math.max(2, Math.round(Math.max(bitmap.width, bitmap.height) / 400))
  const font = Math.max(12, Math.round(Math.max(bitmap.width, bitmap.height) / 60))
  g.font = `600 ${font}px system-ui, sans-serif`
  g.textBaseline = 'top'
  for (const d of detections) {
    const color = BOX_COLORS[Math.max(0, classes.indexOf(d.label)) % BOX_COLORS.length]
    const [x1, y1, x2, y2] = [d.box[0] * bitmap.width, d.box[1] * bitmap.height, d.box[2] * bitmap.width, d.box[3] * bitmap.height]
    g.strokeStyle = color
    g.lineWidth = line
    g.strokeRect(x1, y1, x2 - x1, y2 - y1)
    const tw = g.measureText(d.label).width + font * 0.6
    const ty = y1 - font * 1.3 >= 0 ? y1 - font * 1.3 : y1
    g.fillStyle = color
    g.fillRect(x1 - line / 2, ty, tw, font * 1.3)
    g.fillStyle = '#ffffff'
    g.fillText(d.label, x1 + font * 0.3, ty + font * 0.15)
  }
  return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
}

function toCoco(images, classes) {
  const annotations = []
  let id = 1
  images.forEach(({ image, detections }, index) => {
    for (const d of detections) {
      const x = d.box[0] * image.width
      const y = d.box[1] * image.height
      const w = (d.box[2] - d.box[0]) * image.width
      const h = (d.box[3] - d.box[1]) * image.height
      annotations.push({ id: id++, image_id: index + 1, category_id: classes.indexOf(d.label) + 1, bbox: [round2(x), round2(y), round2(w), round2(h)], area: round2(w * h), iscrowd: 0 })
    }
  })
  return {
    info: { description: 'OmniTool AI 目标检测打标', date_created: new Date().toISOString() },
    images: images.map(({ input, image }, index) => ({ id: index + 1, file_name: input.name, width: image.width, height: image.height })),
    categories: classes.map((name, i) => ({ id: i + 1, name, supercategory: 'object' })),
    annotations,
  }
}

function toLabelMe(fileName, width, height, detections) {
  return {
    version: '5.4.1',
    flags: {},
    shapes: detections.map((d) => ({
      label: d.label,
      points: [[round2(d.box[0] * width), round2(d.box[1] * height)], [round2(d.box[2] * width), round2(d.box[3] * height)]],
      group_id: null,
      description: '',
      shape_type: 'rectangle',
      flags: {},
    })),
    imagePath: fileName,
    imageData: null,
    imageHeight: height,
    imageWidth: width,
  }
}

/* ------------------------------- PDF pages ------------------------------- */

class WorkerCanvasFactory {
  create(width, height) {
    const canvas = new OffscreenCanvas(width, height)
    return { canvas, context: canvas.getContext('2d') }
  }
  reset(pair, width, height) {
    pair.canvas.width = width
    pair.canvas.height = height
  }
  destroy(pair) {
    pair.canvas.width = pair.canvas.height = 0
  }
}

class WorkerFilterFactory {
  addFilter() { return 'none' }
  addHCMFilter() { return 'none' }
  addAlphaFilter() { return 'none' }
  addLuminosityFilter() { return 'none' }
  addKnockoutFilter() { return 'none' }
  addHighlightHCMFilter() { return 'none' }
  addSelectionHCMFilter() { return 'none' }
  addSelectionFilter() { return 'none' }
  createSelectionStyle() { return null }
  destroy() {}
}

function isPdf(input) {
  return input.type === 'application/pdf' || /\.pdf$/i.test(input.name)
}

async function renderPdfPages(host, input, spec, dpi) {
  const { exports: pdfjs } = await loadDependency('pdfjs')
  await loadDependency('pdfjs-worker')
  pdfjs.GlobalWorkerOptions.workerSrc = ''
  const task = pdfjs.getDocument({ data: await host.fs.readAll(input.id), useWorkerFetch: false, isEvalSupported: false, CanvasFactory: WorkerCanvasFactory, FilterFactory: WorkerFilterFactory })
  const doc = await task.promise
  try {
    const pages = []
    for (const number of parsePageSpec(spec, doc.numPages)) {
      const page = await doc.getPage(number)
      const viewport = page.getViewport({ scale: dpi / 72 })
      const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      const g = canvas.getContext('2d')
      g.fillStyle = '#ffffff'
      g.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: g, viewport }).promise
      page.cleanup()
      pages.push({ label: `${input.name} 第 ${number} 页`, bitmap: await createImageBitmap(canvas) })
    }
    if (!pages.length) throw new Error(`${input.name}：页码范围没有匹配到任何页面`)
    return pages
  } finally {
    await task.destroy()
  }
}

function parsePageSpec(spec, total) {
  const pages = new Set()
  for (const raw of String(spec || '1-').split(',')) {
    const part = raw.trim()
    if (!part) continue
    const [a, b] = part.split('-')
    const start = Math.max(1, Number(a) || 1)
    const end = part.includes('-') ? Math.min(total, b ? Number(b) || total : total) : Math.min(total, start)
    for (let n = start; n <= end; n++) pages.add(n)
  }
  return [...pages].sort((x, y) => x - y)
}

/* ========================================================================== */
/* Audio helpers                                                              */
/* ========================================================================== */

/** Transcription APIs cap uploads (25 MB at OpenAI): compress to 32 kbps mono and cut 20-minute pieces. */
const SEGMENT_SECONDS = 1200

async function prepareSpeech(ctx, input, duration) {
  const args = ['-i', '$in0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k']
  if (duration > SEGMENT_SECONDS * 1.1) {
    const { files } = await ctx.host.ffmpeg.run({
      args: [...args, '-f', 'segment', '-segment_time', String(SEGMENT_SECONDS), '-reset_timestamps', '1', '-y', '$out0'],
      inputs: [input.id], outputs: ['speech-%03d.mp3'], label: `压缩并分段 ${input.name}`,
    })
    return files.map((file, i) => ({ id: file.id, offset: i * SEGMENT_SECONDS }))
  }
  const { files } = await ctx.host.ffmpeg.run({ args: [...args, '-y', '$out0'], inputs: [input.id], outputs: ['speech.mp3'], label: `压缩音轨 ${input.name}` })
  return [{ id: files[0].id, offset: 0 }]
}

async function transcribeRequest(ctx, config, bytes, fileName, format, params) {
  const fields = { model: config.sttModel, response_format: format }
  if (params.language) fields.language = String(params.language).trim()
  if (params.prompt) fields.prompt = String(params.prompt)
  const { body, contentType } = multipart(fields, { name: 'file', fileName, type: 'audio/mpeg', bytes })
  const res = await request(ctx, config, '/audio/transcriptions', { body, contentType })
  // Some servers answer `response_format: srt` with JSON `{ text }` anyway.
  const trimmed = res.text.trim()
  if (trimmed.startsWith('{')) {
    const data = parseJsonLoose(trimmed)
    if (data && Array.isArray(data.segments) && format === 'srt') return formatSrt(data.segments.map((s) => ({ start: s.start, end: s.end, text: String(s.text).trim() })))
    if (data && typeof data.text === 'string') return format === 'srt' ? `1\n00:00:00,000 --> 99:59:59,000\n${data.text.trim()}\n` : data.text
  }
  return res.text
}

function multipart(fields, file) {
  const boundary = `----omnitool${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
  const encoder = new TextEncoder()
  const chunks = []
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  chunks.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.fileName.replace(/"/g, '')}"\r\nContent-Type: ${file.type}\r\n\r\n`))
  chunks.push(file.bytes)
  chunks.push(encoder.encode(`\r\n--${boundary}--\r\n`))
  return { body: concatBytes(chunks), contentType: `multipart/form-data; boundary=${boundary}` }
}

function mergeTranscripts(pieces, format) {
  if (format === 'text') return `${pieces.map((p) => p.body.trim()).join('\n')}\n`
  const cues = []
  for (const piece of pieces) for (const cue of parseSubtitles(piece.body)) cues.push({ ...cue, start: cue.start + piece.offset, end: cue.end + piece.offset })
  return format === 'vtt' ? formatVtt(cues) : formatSrt(cues)
}

/* ========================================================================== */
/* Small utilities                                                            */
/* ========================================================================== */

/** The first JSON value in a model reply, tolerating code fences and prose around it. */
function parseJsonLoose(text) {
  const source = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '')
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source)
  const candidates = [fenced ? fenced[1] : null, source].filter(Boolean)
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate.trim())
    } catch (err) {
      /* try the next shape */
    }
    const start = candidate.search(/[[{]/)
    if (start === -1) continue
    const open = candidate[start]
    const close = open === '{' ? '}' : ']'
    let depth = 0
    let inString = false
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i]
      if (inString) {
        if (ch === '\\') i++
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === open) depth++
      else if (ch === close && --depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1))
        } catch (err) {
          break
        }
      }
    }
  }
  return undefined
}

/** Removes a code fence the model wrapped around its whole answer (unless the source itself was one). */
function stripFence(text, source = '') {
  const match = /^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/.exec(text)
  if (!match || /^\s*```/.test(source)) return text
  return match[1]
}

function toCsv(columns, rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return `\uFEFF${[columns.map(cell).join(','), ...rows.map((row) => columns.map((c) => cell(row[c])).join(','))].join('\r\n')}\r\n`
}

function escapeCell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\n+/g, '<br>')
}

function chunkArray(items, size) {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function withSuffix(name, suffix, ext) {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const extension = ext ?? (dot > 0 ? name.slice(dot) : '.txt')
  return `${base}${suffix}${extension}`
}

function safeName(text) {
  return String(text).replace(/[\\/:*?"<>| -]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
}

function languageCode(language) {
  return { 简体中文: 'zh-CN', 繁體中文: 'zh-TW', English: 'en', 日本語: 'ja', 한국어: 'ko', Français: 'fr', Deutsch: 'de', Español: 'es', Português: 'pt', Русский: 'ru', Italiano: 'it', 'Tiếng Việt': 'vi', ภาษาไทย: 'th', 'Bahasa Indonesia': 'id', العربية: 'ar' }[language] || 'translated'
}

function mimeOf(name) {
  const ext = (/\.([^.]+)$/.exec(name) || [])[1] || ''
  return { md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', srt: 'application/x-subrip', vtt: 'text/vtt', json: 'application/json', html: 'text/html', csv: 'text/csv' }[ext.toLowerCase()] || 'text/plain'
}

function decodeText(bytes) {
  try {
    return new TextDecoder().decode(bytes)
  } catch (err) {
    return ''
  }
}

function concatBytes(parts) {
  const total = parts.reduce((n, p) => n + p.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part instanceof Uint8Array ? part : new Uint8Array(part), offset)
    offset += part.byteLength
  }
  return out
}

function bytesToBase64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function base64ToBytes(text) {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function round2(value) {
  return Math.round(value * 100) / 100
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6
}
