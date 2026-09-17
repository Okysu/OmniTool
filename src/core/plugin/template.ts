/**
 * Starter templates for the plugin editor.
 *
 * Each one is small but complete and exercises a different part of the API, so
 * picking a template doubles as reading an example of that feature.
 */

export interface PluginTemplate {
  id: string
  name: string
  description: string
  code: string
}

const FORM = `definePlugin({
  id: 'example.json-tools',
  name: 'JSON 工具',
  version: '1.0.0',
  author: '你的名字',
  description: '格式化或压缩 JSON。',
  icon: 'file-json',

  // 只申请真正需要的能力：fs 读写文件。
  capabilities: ['fs'],

  tools: [
    {
      id: 'format',
      name: 'JSON 格式化',
      category: 'document',
      icon: 'file-json',
      accept: ['.json', 'application/json'],
      multiple: true,
      // 允许用户直接粘贴内容，而不必先存成文件。
      input: 'both',
      textFileName: 'input.json',

      // 参数表单由宿主渲染，风格与内置工具完全一致。
      params: [
        {
          key: 'mode', type: 'select', label: '模式', default: 'pretty',
          options: [
            { value: 'pretty', label: '格式化' },
            { value: 'minify', label: '压缩为单行' },
          ],
        },
        { key: 'indent', type: 'slider', label: '缩进', min: 1, max: 8, default: 2, when: { key: 'mode', equals: 'pretty' } },
      ],

      async run(ctx) {
        const outputs = []
        for (const [i, input] of ctx.inputs.entries()) {
          ctx.throwIfAborted()
          ctx.progress(i / ctx.inputs.length, input.name)

          const data = JSON.parse(await ctx.host.fs.readText(input.id))
          const text = ctx.params.mode === 'minify'
            ? JSON.stringify(data)
            : JSON.stringify(data, null, Number(ctx.params.indent))

          const out = await ctx.host.fs.writeAll(input.name.replace(/\\.json$/i, '') + '.out.json', text, 'application/json')
          outputs.push(out.id)
        }
        return { outputs, summary: '已处理 ' + outputs.length + ' 个文件' }
      },
    },
  ],
})
`

const PANEL = `definePlugin({
  id: 'example.image-annotate',
  name: '图片标注',
  version: '1.0.0',
  description: '在预览上拖拽画出矩形高亮，导出带标注的图片。',
  icon: 'pen-line',
  capabilities: ['fs'],

  tools: [
    {
      id: 'annotate',
      name: '矩形标注',
      category: 'image',
      icon: 'pen-line',
      accept: ['image/*'],

      /**
       * setup(ui) 让插件自己描述界面。
       * - ui.render() 声明组件树，宿主用真实的 shadcn 组件渲染
       * - bind 的值会在运行时作为 ctx.params 传给 run()
       * - canvas 节点给你一块真正的 OffscreenCanvas，直接绘制
       */
      async setup(ui) {
        const input = ui.inputs[0]
        if (!input) {
          ui.render({
            runDisabled: true,
            nodes: [{ type: 'alert', tone: 'info', text: '先拖入一张图片。' }],
          })
          return
        }

        ui.render({
          state: { color: '#ff3b30', width: 6, box: [] },
          runLabel: '导出标注图',
          nodes: [
            { type: 'canvas', id: 'stage', aspect: 16 / 9, interactive: true },
            {
              type: 'row', gap: 4, wrap: true,
              children: [
                { type: 'color', bind: 'color', label: '颜色' },
                { type: 'slider', bind: 'width', label: '线宽', min: 1, max: 30, suffix: 'px' },
              ],
            },
            { type: 'button', text: '清除', action: 'clear', icon: 'eraser' },
          ],
        })

        // 画布在渲染后才会交到插件手里。
        const canvas = await ui.canvas('stage')
        const g = canvas.getContext('2d')
        const bitmap = await createImageBitmap(await ui.host.fs.blob(input.id, input.type))

        // 把图片等比放进画布，记录映射关系以便把指针坐标换算回原图像素。
        const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height)
        const view = {
          x: (canvas.width - bitmap.width * scale) / 2,
          y: (canvas.height - bitmap.height * scale) / 2,
          scale,
        }

        let drag = null
        function draw() {
          g.clearRect(0, 0, canvas.width, canvas.height)
          g.drawImage(bitmap, view.x, view.y, bitmap.width * scale, bitmap.height * scale)
          const b = drag ?? ui.state.box
          if (b && b.length === 4) {
            g.strokeStyle = String(ui.state.color)
            g.lineWidth = Number(ui.state.width) * scale
            g.strokeRect(view.x + b[0] * scale, view.y + b[1] * scale, b[2] * scale, b[3] * scale)
          }
        }
        draw()

        const toImage = (p) => [(p.x - view.x) / scale, (p.y - view.y) / scale]

        ui.on('pointer', (_id, p) => {
          const [x, y] = toImage(p)
          if (p.type === 'down') drag = [x, y, 0, 0]
          else if (p.type === 'move' && drag && p.buttons) drag = [drag[0], drag[1], x - drag[0], y - drag[1]]
          else if (p.type === 'up' && drag) {
            ui.setState({ box: drag.map(Math.round) })
            drag = null
          }
          draw()
        })
        ui.on('change', draw)
        ui.on('action', (action) => {
          if (action === 'clear') ui.setState({ box: [] })
          draw()
        })
      },

      async run(ctx) {
        const input = ctx.inputs[0]
        const bitmap = await createImageBitmap(await ctx.host.fs.blob(input.id, input.type))
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const g = canvas.getContext('2d')
        g.drawImage(bitmap, 0, 0)

        const box = ctx.params.box
        if (Array.isArray(box) && box.length === 4) {
          g.strokeStyle = String(ctx.params.color)
          g.lineWidth = Number(ctx.params.width)
          g.strokeRect(box[0], box[1], box[2], box[3])
        }

        const blob = await canvas.convertToBlob({ type: 'image/png' })
        const out = await ctx.host.fs.writeAll('annotated.png', new Uint8Array(await blob.arrayBuffer()), 'image/png')
        return { outputs: [out.id], summary: '已导出标注图' }
      },
    },
  ],
})
`

const FFMPEG = `definePlugin({
  id: 'example.audio-loudness',
  name: '音频响度统一',
  version: '1.0.0',
  description: '把一批音频统一到相同响度，适合播客与课程录音。',
  icon: 'volume',

  // ffmpeg 在宿主本地运行（WASM），文件不会离开本机。
  capabilities: ['fs', 'ffmpeg'],

  tools: [
    {
      id: 'normalize',
      name: '响度统一',
      category: 'media',
      icon: 'waves',
      accept: ['audio/*', 'video/*'],
      multiple: true,
      params: [
        { key: 'target', type: 'slider', label: '目标响度', min: -30, max: -8, default: -16, suffix: ' LUFS' },
        {
          key: 'format', type: 'select', label: '输出格式', default: 'mp3',
          options: [{ value: 'mp3', label: 'MP3' }, { value: 'wav', label: 'WAV' }],
        },
      ],

      async run(ctx) {
        const outputs = []
        for (const [i, input] of ctx.inputs.entries()) {
          ctx.throwIfAborted()

          // $in0 / $out0 是占位符，宿主负责挂载文件；线程数也由宿主自动管理。
          const { files } = await ctx.host.ffmpeg.run({
            args: [
              '-i', '$in0', '-vn',
              '-af', 'loudnorm=I=' + ctx.params.target + ':TP=-1.5:LRA=11',
              ...(ctx.params.format === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '192k'] : ['-c:a', 'pcm_s16le']),
              '$out0',
            ],
            inputs: [input.id],
            outputs: [input.name.replace(/\\.[^.]+$/, '') + '.' + ctx.params.format],
            label: '处理 ' + input.name + '（' + (i + 1) + '/' + ctx.inputs.length + '）',
          })
          outputs.push(files[0].id)
        }
        return { outputs, summary: '已统一 ' + outputs.length + ' 个文件到 ' + ctx.params.target + ' LUFS' }
      },
    },
  ],
})
`

const SECRET = `definePlugin({
  id: 'example.translate',
  name: 'DeepL 翻译',
  version: '1.0.0',
  description: '用你自己的 DeepL API Key 翻译文本。',
  icon: 'type',

  // secret：凭据由用户在宿主弹窗里录入，插件永远读不到明文。
  // net：请求经宿主代理发出，且带凭据的请求只能发往用户批准的域名。
  capabilities: ['fs', 'net', 'secret'],

  tools: [
    {
      id: 'translate',
      name: '文本翻译',
      category: 'document',
      icon: 'type',
      input: 'text',
      params: [
        {
          key: 'target', type: 'select', label: '目标语言', default: 'ZH',
          options: [{ value: 'ZH', label: '中文' }, { value: 'EN-US', label: '英语' }, { value: 'JA', label: '日语' }],
        },
      ],

      async run(ctx) {
        // 首次运行会弹出宿主绘制的录入框；之后直接返回 true。
        const ok = await ctx.host.secret.request('apiKey', {
          label: 'DeepL API Key',
          hint: '在 deepl.com/account 获取',
          origins: ['https://api-free.deepl.com'],
        })
        if (!ok) throw new Error('需要 API Key 才能翻译')

        const text = await ctx.host.fs.readText(ctx.inputs[0].id)

        // {{secret:apiKey}} 由宿主在发送时替换，插件代码里始终只是占位符。
        const result = await ctx.host.net.fetchJSON('https://api-free.deepl.com/v2/translate', {
          method: 'POST',
          headers: {
            Authorization: 'DeepL-Auth-Key {{secret:apiKey}}',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text: [text], target_lang: ctx.params.target }),
        })

        const out = await ctx.host.fs.writeAll('translated.txt', result.translations[0].text, 'text/plain')
        return { outputs: [out.id], summary: '翻译完成' }
      },
    },
  ],
})
`

export const PLUGIN_TEMPLATES: PluginTemplate[] = [
  { id: 'form', name: '表单工具', description: '参数表单 + 文件/文本输入，最常见的形态', code: FORM },
  { id: 'panel', name: '自定义界面', description: 'setup(ui) 绘制界面 + 可交互画布', code: PANEL },
  { id: 'ffmpeg', name: '音视频处理', description: '调用本地 FFmpeg 批量处理', code: FFMPEG },
  { id: 'secret', name: '调用外部 API', description: '安全凭据 + 网络请求，明文不可读', code: SECRET },
]

/** Kept for callers that only need one example. */
export const STARTER_TEMPLATE = FORM
