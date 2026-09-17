/* eslint-disable */
/**
 * Built-in plugin: local AI tools, on the host's ONNX Runtime capability.
 *
 * Every model runs on this machine. What crosses the network is each model
 * file, once, after the user approves a dialog showing its size, source and
 * licence; the host verifies its SHA-256 on download and on every later load.
 * Models were chosen for permissive licences as much as for quality:
 *
 *   U²-Netp          Apache-2.0   4.6 MB   fast salient-object cutout
 *   IS-Net general   MIT          176 MB   high-quality cutout (imgly export)
 *   PP-OCRv4 det/rec Apache-2.0   16 MB    Chinese + English OCR (RapidOCR export)
 *   Swin2SR light x2 Apache-2.0   8 MB     super-resolution (Xenova export)
 *   YuNet 2023mar    MIT          0.2 MB   face detection (OpenCV Zoo)
 *   MI-GAN pipeline  MIT          28 MB    fast inpainting, any size (Picsart)
 *   LaMa             Apache-2.0   208 MB   high-quality inpainting at 512² (Carve export)
 *   Whisper base/small MIT        77/249 MB speech recognition, int8 (onnx-community export)
 *
 * (RMBG-1.4 is sharper than U²-Netp but non-commercial; APISR is GPL-3.0. Neither
 * is shipped as a default for that reason.)
 *
 * Pre- and post-processing here was validated against the models directly: the
 * normalisation constants, DB box thresholds and CTC decoding follow what each
 * model was trained with, not guesses.
 */
definePlugin({
  id: 'omnitool.ai',
  name: 'AI 工具箱',
  version: '1.0.0',
  author: 'OmniTool',
  description: '本地运行的抠图、图片放大、文字识别（OCR）、语音转字幕、人脸打码与 AI 消除。模型首次使用时下载并校验，之后完全离线。',
  icon: 'sparkles',
  capabilities: ['fs', 'ui', 'onnx', 'ffmpeg'],
  deps: [
    { id: 'ocr-keys', url: '/vendor/ocr/ppocr-keys.js', global: 'PPOCR_KEYS', lazy: true },
    { id: 'pdfjs', url: '/vendor/pdfjs.js', global: 'pdfjsLib', lazy: true },
    { id: 'pdfjs-worker', url: '/vendor/pdfjs-worker.js', global: 'pdfjsWorker', lazy: true },
    { id: 'pdfjs-data', url: '/vendor/pdfjs-data/index.js', global: 'PDFJS_DATA', lazy: true, assets: { 'pack.bin': { url: '/vendor/pdfjs-data/pack.bin' } } },
    { id: 'whisper-vocab', url: '/vendor/whisper/vocab.js', global: 'WHISPER_VOCAB', lazy: true },
    // Searchable PDFs from OCR: page image plus an invisible text layer in a Chinese-capable font.
    { id: 'pdf-lib', url: '/vendor/pdf-lib.js', global: 'PDFLib', lazy: true },
    { id: 'fontkit', url: '/vendor/fontkit.js', global: 'fontkit', lazy: true },
    { id: 'cjk-font', url: '/vendor/fonts/fonts.js', global: 'OMNITOOL_FONTS', lazy: true, assets: { 'NotoSansSC-Regular.ttf': { url: '/vendor/fonts/NotoSansSC-Regular.ttf' } } },
  ],

  tools: [
    /* ------------------------------------------------------------------ */
    {
      id: 'remove-background',
      name: '智能抠图',
      category: 'ai',
      icon: 'wand',
      description: '自动识别主体并去除背景，输出透明 PNG、换纯色背景或黑白蒙版。',
      accept: ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/bmp', 'image/gif'],
      multiple: true,
      keywords: ['remove background', 'cutout', 'matting', 'transparent', '抠图', '去背景', '透明背景', '证件照'],
      params: [
        {
          key: 'model', type: 'select', label: '模型', default: 'fast',
          options: [
            { value: 'fast', label: '快速（U²-Netp，4.6 MB）' },
            { value: 'quality', label: '精细（IS-Net，176 MB，边缘更准）' },
          ],
        },
        {
          key: 'output', type: 'select', label: '输出', default: 'transparent',
          options: [
            { value: 'transparent', label: '透明背景 PNG' },
            { value: 'color', label: '替换为纯色背景' },
            { value: 'mask', label: '黑白蒙版' },
          ],
        },
        { key: 'background', type: 'text', label: '背景颜色', default: '#ffffff', when: { key: 'output', equals: 'color' }, hint: '证件照常用 #ffffff、#438edb、#d9001b。' },
        { key: 'threshold', type: 'slider', label: '边缘硬度', min: 0, max: 100, default: 0, suffix: '%', hint: '0 保留柔和的半透明边缘（发丝）；调高会让边缘更干净利落。' },
      ],

      async run(ctx) {
        const p = ctx.params
        const spec = p.model === 'quality' ? MODELS.isnet : MODELS.u2netp
        const session = await openSession(ctx, spec)
        const outputs = []

        for (const [index, input] of ctx.inputs.entries()) {
          ctx.throwIfAborted()
          ctx.progress(index / ctx.inputs.length, `识别主体：${input.name}`)
          const bitmap = await decodeImage(input)
          const size = spec.id === MODELS.isnet.id ? 1024 : 320
          const pixels = rgbaAt(bitmap, size, size)

          let tensor
          if (spec.id === MODELS.isnet.id) {
            tensor = toCHW(pixels, size, size, (v) => v / 255 - 0.5)
          } else {
            // U²-Net was trained on images scaled by their brightest channel, then ImageNet-normalised.
            let max = 1e-6
            for (let i = 0; i < pixels.length; i += 4) max = Math.max(max, pixels[i], pixels[i + 1], pixels[i + 2])
            tensor = toCHW(pixels, size, size, (v, c) => (v / max - IMAGENET_MEAN[c]) / IMAGENET_STD[c])
          }

          const result = await runModel(session, spec, { [spec.input]: { type: 'float32', dims: [1, 3, size, size], data: tensor } })
          const prediction = result[spec.output].data
          const alpha = maskToAlpha(prediction, spec.id === MODELS.u2netp.id, Number(p.threshold) / 100)
          const canvas = composeCutout(bitmap, alpha, size, String(p.output), String(p.background || '#ffffff'))
          bitmap.close()

          const type = p.output === 'color' ? 'image/jpeg' : 'image/png'
          const blob = await canvas.convertToBlob({ type, quality: 0.95 })
          const suffix = { transparent: '-cutout', color: '-bg', mask: '-mask' }[String(p.output)] ?? '-cutout'
          outputs.push((await host.fs.writeAll(renameWith(input.name, suffix, type), new Uint8Array(await blob.arrayBuffer()), type)).id)
        }

        ctx.progress(1)
        return { outputs, summary: `已处理 ${outputs.length} 张图片` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'upscale',
      name: 'AI 图片放大',
      category: 'ai',
      icon: 'zoom-in',
      description: '用超分辨率模型把图片放大 2 倍或 4 倍，补出细节而不是简单插值。',
      accept: ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/bmp'],
      multiple: true,
      keywords: ['upscale', 'super resolution', 'enhance', 'enlarge', '放大', '超分', '高清', '修复'],
      params: [
        { key: 'scale', type: 'select', label: '倍数', default: '2', options: [{ value: '2', label: '2 倍' }, { value: '4', label: '4 倍（两次 2 倍，耗时约 5 倍）' }] },
        { key: 'format', type: 'select', label: '输出格式', default: 'image/png', options: [{ value: 'image/png', label: 'PNG（无损）' }, { value: 'image/webp', label: 'WebP' }, { value: 'image/jpeg', label: 'JPEG' }] },
      ],

      async run(ctx) {
        const passes = ctx.params.scale === '4' ? 2 : 1
        const session = await openSession(ctx, MODELS.swin2sr)
        const outputs = []

        for (const [index, input] of ctx.inputs.entries()) {
          ctx.throwIfAborted()
          const bitmap = await decodeImage(input)
          const pixelCount = bitmap.width * bitmap.height * (passes === 2 ? 5 : 1)
          if (pixelCount > MAX_UPSCALE_PIXELS) {
            bitmap.close()
            throw new Error(`${input.name}（${bitmap.width}×${bitmap.height}）太大，放大会非常慢。请先缩小到约 ${Math.round(Math.sqrt(MAX_UPSCALE_PIXELS / (passes === 2 ? 5 : 1)))} 像素见方以内。`)
          }

          let width = bitmap.width
          let height = bitmap.height
          let rgba = rgbaAt(bitmap, width, height)
          const hasAlpha = rgba.some((_, i) => i % 4 === 3 && rgba[i] < 255)

          for (let pass = 0; pass < passes; pass++) {
            const label = `${input.name}（${index + 1}/${ctx.inputs.length}${passes > 1 ? `，第 ${pass + 1}/2 遍` : ''}）`
            rgba = await upscaleTiled(ctx, session, rgba, width, height, (done) => {
              ctx.progress((index + (pass + done) / passes) / ctx.inputs.length, `放大 ${label}`)
            })
            width *= 2
            height *= 2
          }

          const canvas = new OffscreenCanvas(width, height)
          const g = canvas.getContext('2d')
          g.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer), width, height), 0, 0)
          if (hasAlpha) {
            // The model sees RGB only; carry transparency over with a smooth resize.
            const mask = new OffscreenCanvas(width, height)
            const mg = mask.getContext('2d')
            mg.imageSmoothingQuality = 'high'
            mg.drawImage(bitmap, 0, 0, width, height)
            g.globalCompositeOperation = 'destination-in'
            g.drawImage(mask, 0, 0)
          }
          bitmap.close()

          const type = String(ctx.params.format)
          const blob = await canvas.convertToBlob({ type, quality: 0.95 })
          outputs.push((await host.fs.writeAll(renameWith(input.name, `-x${2 ** passes}`, type), new Uint8Array(await blob.arrayBuffer()), type)).id)
        }

        ctx.progress(1)
        return { outputs, summary: `已放大 ${outputs.length} 张图片（×${2 ** passes}）` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'ocr',
      name: '文字识别 OCR',
      category: 'ai',
      icon: 'scan-text',
      description: '识别图片或扫描版 PDF 中的中英文文字，输出纯文本、带坐标的 JSON，或标注框预览图。',
      accept: ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'application/pdf', '.pdf'],
      multiple: true,
      keywords: ['ocr', 'text recognition', 'scan', 'pdf ocr', '文字识别', '图片转文字', '扫描件', '提取文字'],
      params: [
        {
          key: 'output', type: 'select', label: '输出', default: 'text',
          options: [
            { value: 'text', label: '纯文本' },
            { value: 'json', label: 'JSON（每行文字、坐标与置信度）' },
            { value: 'preview', label: '文本 + 标注框预览图' },
            { value: 'pdf', label: '可搜索 PDF（原图 + 可选中、可搜索的隐藏文字层）' },
          ],
        },
        {
          key: 'detail', type: 'select', label: '检测精度', default: 'standard',
          options: [
            { value: 'standard', label: '标准（长边缩放到 960 像素）' },
            { value: 'high', label: '高（长边 1600 像素，适合小字密集的整页扫描）' },
          ],
        },
        { key: 'minConfidence', type: 'slider', label: '最低置信度', min: 0, max: 95, default: 50, suffix: '%', hint: '低于此值的识别结果会被丢弃。' },
        { key: 'pages', type: 'text', label: 'PDF 页码', default: '1-', placeholder: '如 1-3,7', hint: '仅对 PDF 生效。' },
        { key: 'dpi', type: 'slider', label: 'PDF 渲染精度', min: 100, max: 300, step: 10, default: 200, suffix: 'dpi' },
      ],

      async run(ctx) {
        const p = ctx.params
        ctx.progress(0, '加载文字识别模型')
        const det = await openSession(ctx, MODELS.det)
        const rec = await openSession(ctx, MODELS.rec)
        const { exports: keys } = await loadDependency('ocr-keys')
        const outputs = []
        const report = []
        let lineCount = 0

        for (const [index, input] of ctx.inputs.entries()) {
          ctx.throwIfAborted()
          const dpi = Number(p.dpi) || 200
          const pages = isPdf(input) ? await renderPdfPages(ctx, input, String(p.pages || '1-'), dpi) : [{ label: input.name, bitmap: await decodeImage(input) }]
          const fileReport = { file: input.name, pages: [] }
          const searchable = p.output === 'pdf' ? await searchablePdf() : null

          for (const [pageIndex, page] of pages.entries()) {
            ctx.throwIfAborted()
            const base = index + pageIndex / pages.length
            ctx.progress(base / ctx.inputs.length, `检测文字区域：${page.label}`)
            const boxes = await detectText(det, page.bitmap, p.detail === 'high' ? 1600 : 960)

            const lines = []
            for (const [n, box] of boxes.entries()) {
              ctx.throwIfAborted()
              if (n % 4 === 0) ctx.progress((base + (n / boxes.length) / pages.length) / ctx.inputs.length, `识别第 ${n + 1}/${boxes.length} 行：${page.label}`)
              const line = await recognizeLine(rec, keys, page.bitmap, box)
              if (line.text.trim() && line.confidence * 100 >= Number(p.minConfidence)) lines.push({ ...line, box: box.map(Math.round) })
            }
            lineCount += lines.length
            fileReport.pages.push({ page: page.number ?? 1, width: page.bitmap.width, height: page.bitmap.height, text: joinReadingOrder(lines), lines })

            if (searchable) {
              // Rendered PDF pages map back to their original size; images are taken as 96 dpi.
              await searchable.addPage(page.bitmap, lines, isPdf(input) ? 72 / dpi : 0.75)
            }
            if (p.output === 'preview') {
              const blob = await drawBoxes(page.bitmap, lines).convertToBlob({ type: 'image/png' })
              const name = renameWith(input.name, page.number ? `-p${page.number}-ocr` : '-ocr', 'image/png')
              outputs.push((await host.fs.writeAll(name, new Uint8Array(await blob.arrayBuffer()), 'image/png')).id)
            }
            page.bitmap.close()
          }
          report.push(fileReport)
          if (searchable) {
            const name = renameWith(input.name, '-ocr', 'text/plain').replace(/\.txt$/, '.pdf')
            outputs.push((await host.fs.writeAll(name, await searchable.save(), 'application/pdf')).id)
          }
        }

        if (p.output === 'pdf') {
          ctx.progress(1)
          return { outputs, summary: lineCount ? `已生成 ${outputs.length} 个可搜索 PDF，识别出 ${lineCount} 行文字` : `已生成 ${outputs.length} 个 PDF，但没有识别到文字` }
        }
        if (p.output === 'json') {
          outputs.unshift((await host.fs.writeAll('ocr.json', JSON.stringify(report, null, 2), 'application/json')).id)
        } else {
          const text = report
            .map((file) => {
              const body = file.pages.map((page) => (file.pages.length > 1 ? `--- 第 ${page.page} 页 ---\n${page.text}` : page.text)).join('\n\n')
              return report.length > 1 ? `===== ${file.file} =====\n${body}` : body
            })
            .join('\n\n')
          const name = ctx.inputs.length === 1 ? renameWith(ctx.inputs[0].name, '', 'text/plain') : 'ocr.txt'
          outputs.unshift((await host.fs.writeAll(name, `${text.trim()}\n`, 'text/plain')).id)
        }

        ctx.progress(1)
        return { outputs, summary: lineCount ? `识别出 ${lineCount} 行文字` : '没有识别到文字' }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'transcribe',
      name: 'AI 语音转字幕',
      category: 'ai',
      icon: 'type',
      description: '用 Whisper 在本机把视频或音频里的语音转成带时间轴的字幕（SRT / VTT）或文稿，支持中英日韩等近百种语言，也可直接译成英文。',
      accept: ['video/*', 'audio/*', '.mp4', '.mkv', '.mov', '.webm', '.mp3', '.m4a', '.wav', '.flac', '.ogg', '.aac'],
      multiple: true,
      keywords: ['whisper', 'speech to text', 'transcribe', 'subtitles', 'captions', 'asr', '语音识别', '语音转文字', '自动字幕', '生成字幕', '听写', '会议记录'],
      params: [
        {
          key: 'model', type: 'select', label: '模型', default: 'base',
          options: [
            { value: 'base', label: '标准（Whisper base，77 MB）' },
            { value: 'small', label: '精准（Whisper small，249 MB，约慢 3 倍）' },
          ],
        },
        {
          key: 'language', type: 'select', label: '语言', default: 'auto',
          options: [
            { value: 'auto', label: '自动检测' }, { value: 'zh', label: '中文' }, { value: 'en', label: '英语' }, { value: 'ja', label: '日语' },
            { value: 'ko', label: '韩语' }, { value: 'yue', label: '粤语' }, { value: 'fr', label: '法语' }, { value: 'de', label: '德语' },
            { value: 'es', label: '西班牙语' }, { value: 'ru', label: '俄语' }, { value: 'pt', label: '葡萄牙语' }, { value: 'it', label: '意大利语' },
            { value: 'vi', label: '越南语' }, { value: 'th', label: '泰语' }, { value: 'id', label: '印尼语' }, { value: 'ar', label: '阿拉伯语' },
          ],
        },
        { key: 'task', type: 'select', label: '任务', default: 'transcribe', options: [{ value: 'transcribe', label: '按原语言转写' }, { value: 'translate', label: '翻译成英文' }] },
        {
          key: 'format', type: 'select', label: '输出', default: 'srt',
          options: [{ value: 'srt', label: 'SRT 字幕' }, { value: 'vtt', label: 'WebVTT 字幕' }, { value: 'txt', label: '纯文本文稿' }, { value: 'all', label: '以上全部' }],
        },
        { key: 'maxChars', type: 'number', label: '每条字幕最多字数', default: 42, min: 10, max: 200, hint: '较长的句子会按标点拆成多条，时间按字数分配。' },
      ],

      async run(ctx) {
        const p = ctx.params
        const { exports: vocab } = await loadDependency('whisper-vocab')
        if (!vocab.available) throw new Error('Whisper 词表未打包（构建时需要联网运行一次 pnpm vendor）')
        const specs = p.model === 'small' ? WHISPER.small : WHISPER.base
        ctx.progress(0, '加载语音识别模型')
        const encoder = await openSession(ctx, specs.encoder)
        const decoder = await openSession(ctx, specs.decoder)
        const tokenizer = whisperTokenizer(vocab.tokens)
        const outputs = []
        const notes = []

        for (const [index, input] of ctx.inputs.entries()) {
          ctx.throwIfAborted()
          const span = (fraction) => (index + fraction) / ctx.inputs.length
          ctx.progress(span(0), `提取音频：${input.name}`)
          const pcm = await decodePcm(input)
          if (pcm.length < WHISPER_RATE * 0.2) {
            notes.push(`${input.name}：没有音轨`)
            continue
          }
          const result = await transcribePcm(ctx, { encoder, decoder, layers: specs.layers, tokenizer }, pcm, {
            language: String(p.language || 'auto'),
            task: p.task === 'translate' ? 'translate' : 'transcribe',
            onProgress: (fraction, label) => ctx.progress(span(fraction), `${label}：${input.name}`),
          })
          const cues = splitCues(result.segments, Math.max(10, Number(p.maxChars) || 42))
          const base = input.name.replace(/\.[^.]+$/, '')
          const formats = p.format === 'all' ? ['srt', 'vtt', 'txt'] : [String(p.format || 'srt')]
          for (const format of formats) {
            const body = format === 'vtt' ? toVtt(cues) : format === 'txt' ? toTranscript(result.segments) : toSrt(cues)
            const type = format === 'vtt' ? 'text/vtt' : format === 'txt' ? 'text/plain' : 'application/x-subrip'
            outputs.push((await host.fs.writeAll(`${base}.${format}`, body, type)).id)
          }
          notes.push(`${input.name}：${cues.length} 条${result.language ? `（${result.language}）` : ''}`)
        }
        ctx.progress(1)
        if (outputs.length === 0) throw new Error(ctx.inputs.length === 1 ? `${ctx.inputs[0].name} 没有音轨（只有画面），无法生成字幕` : '所选文件都没有音轨（只有画面），无法生成字幕')
        return { outputs, summary: `已生成字幕 · ${notes.join('；')}` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'face-blur',
      name: 'AI 人脸打码',
      category: 'ai',
      icon: 'shield-check',
      description: '自动找出照片里的所有人脸并打马赛克、模糊或涂黑，适合发布合影、街拍前保护隐私。',
      accept: ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/bmp'],
      multiple: true,
      keywords: ['face blur', 'anonymize', 'privacy', 'pixelate faces', 'censor', '人脸打码', '马赛克', '隐私', '模糊人脸', '合影'],
      params: [
        {
          key: 'effect', type: 'select', label: '效果', default: 'mosaic',
          options: [{ value: 'mosaic', label: '马赛克' }, { value: 'blur', label: '高斯模糊' }, { value: 'fill', label: '纯色遮挡' }],
        },
        { key: 'strength', type: 'slider', label: '强度', min: 1, max: 10, default: 6 },
        { key: 'color', type: 'text', label: '遮挡颜色', default: '#000000', when: { key: 'effect', equals: 'fill' } },
        { key: 'shape', type: 'select', label: '形状', default: 'ellipse', options: [{ value: 'ellipse', label: '椭圆' }, { value: 'rect', label: '矩形' }] },
        { key: 'expand', type: 'slider', label: '范围外扩', min: 0, max: 80, default: 25, suffix: '%', hint: '把头发、耳朵一起盖住。' },
        { key: 'confidence', type: 'slider', label: '检测灵敏度', min: 30, max: 90, default: 55, suffix: '%', hint: '漏掉侧脸或小脸时调低；把非人脸误判为人脸时调高。' },
      ],

      async run(ctx) {
        const p = ctx.params
        ctx.progress(0, '加载人脸检测模型')
        const session = await openSession(ctx, MODELS.yunet)
        const outputs = []
        let total = 0
        const empty = []
        for (const [index, input] of ctx.inputs.entries()) {
          ctx.throwIfAborted()
          ctx.progress(index / ctx.inputs.length, `检测人脸：${input.name}`)
          const bitmap = await decodeImage(input)
          const faces = await detectFaces(ctx, session, bitmap, Number(p.confidence) / 100)
          if (faces.length === 0) empty.push(input.name)
          total += faces.length
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
          const g = canvas.getContext('2d')
          g.drawImage(bitmap, 0, 0)
          for (const face of faces) {
            obscureRegion(g, bitmap, expandBox(face, Number(p.expand) / 100, bitmap.width, bitmap.height), {
              effect: String(p.effect), strength: Number(p.strength) || 6, shape: String(p.shape), color: String(p.color || '#000000'),
            })
          }
          bitmap.close()
          const type = input.type === 'image/png' ? 'image/png' : input.type === 'image/webp' ? 'image/webp' : 'image/jpeg'
          const blob = await canvas.convertToBlob({ type, quality: 0.92 })
          outputs.push((await host.fs.writeAll(renameWith(input.name, '-anonymized', type), new Uint8Array(await blob.arrayBuffer()), type)).id)
        }
        ctx.progress(1)
        if (empty.length) await host.ui.notify(`未在 ${empty.join('、')} 中检测到人脸，可调低检测灵敏度后重试`)
        return { outputs, summary: `已处理 ${outputs.length} 张图片，共遮挡 ${total} 张人脸` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'red-eye',
      name: 'AI 去红眼',
      category: 'ai',
      icon: 'eye',
      description: '自动定位每张脸的眼睛，只修正瞳孔里的闪光灯红色，不碰嘴唇、衣服等其他红色。',
      accept: ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/bmp'],
      multiple: true,
      keywords: ['red eye', 'redeye', 'flash', 'eyes', '红眼', '去红眼', '闪光灯', '眼睛'],
      params: [
        { key: 'sensitivity', type: 'slider', label: '红色判定', min: 1, max: 10, default: 5, hint: '有残留红色时调高；眼周皮肤被变暗时调低。' },
      ],

      async run(ctx) {
        ctx.progress(0, '加载人脸检测模型')
        const session = await openSession(ctx, MODELS.yunet)
        const outputs = []
        let eyes = 0
        let faces = 0
        for (const [index, input] of ctx.inputs.entries()) {
          ctx.throwIfAborted()
          ctx.progress(index / ctx.inputs.length, `定位眼睛：${input.name}`)
          const bitmap = await decodeImage(input)
          const found = await detectFaces(ctx, session, bitmap, 0.5)
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
          const g = canvas.getContext('2d', { willReadFrequently: true })
          g.drawImage(bitmap, 0, 0)
          bitmap.close()
          faces += found.length
          for (const face of found) {
            const spacing = Math.hypot(face.landmarks[0][0] - face.landmarks[1][0], face.landmarks[0][1] - face.landmarks[1][1])
            // A pupil with its glare is roughly a fifth of the distance between the eyes across.
            const radius = Math.max(3, Math.round(Math.max(spacing, face.w * 0.4) * 0.2))
            for (const [ex, ey] of face.landmarks.slice(0, 2)) {
              const x = Math.max(0, Math.round(ex - radius))
              const y = Math.max(0, Math.round(ey - radius))
              const w = Math.min(canvas.width, Math.round(ex + radius)) - x
              const h = Math.min(canvas.height, Math.round(ey + radius)) - y
              if (w <= 0 || h <= 0) continue
              const patch = g.getImageData(x, y, w, h)
              if (fixRedEye(patch.data, w, h, ex - x, ey - y, radius, Number(ctx.params.sensitivity) || 5) > 0) eyes++
              g.putImageData(patch, x, y)
            }
          }
          const type = input.type === 'image/png' ? 'image/png' : input.type === 'image/webp' ? 'image/webp' : 'image/jpeg'
          const blob = await canvas.convertToBlob({ type, quality: 0.95 })
          outputs.push((await host.fs.writeAll(renameWith(input.name, '-redeye', type), new Uint8Array(await blob.arrayBuffer()), type)).id)
        }
        ctx.progress(1)
        return { outputs, summary: faces ? `检测到 ${faces} 张脸，修正了 ${eyes} 只红眼` : '没有检测到人脸，图片未修改' }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'smart-crop',
      name: 'AI 智能裁剪',
      category: 'ai',
      icon: 'crop',
      description: '识别画面主体，自动裁成 1:1、4:5、16:9 等比例，主体不被切掉——适合批量做头像、封面和商品主图。',
      accept: ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/bmp'],
      multiple: true,
      keywords: ['smart crop', 'auto crop', 'subject', 'thumbnail', 'saliency', 'aspect ratio', '智能裁剪', '自动裁剪', '主体', '封面', '头像', '比例'],
      params: [
        {
          key: 'ratio', type: 'select', label: '比例', default: '1:1',
          options: ['1:1', '4:5', '3:4', '2:3', '9:16', '4:3', '3:2', '16:9', '21:9'].map((value) => ({ value, label: value })),
        },
        {
          key: 'fit', type: 'select', label: '取景', default: 'largest',
          options: [{ value: 'largest', label: '尽量保留画面（最大裁剪框）' }, { value: 'subject', label: '贴近主体（放大主体）' }],
        },
        { key: 'padding', type: 'slider', label: '主体留白', min: 0, max: 50, default: 15, suffix: '%', when: { key: 'fit', equals: 'subject' } },
      ],

      async run(ctx) {
        const p = ctx.params
        const [rw, rh] = String(p.ratio || '1:1').split(':').map(Number)
        const ratio = rw > 0 && rh > 0 ? rw / rh : 1
        ctx.progress(0, '加载主体识别模型')
        const session = await openSession(ctx, MODELS.u2netp)
        const outputs = []
        for (const [index, input] of ctx.inputs.entries()) {
          ctx.throwIfAborted()
          ctx.progress(index / ctx.inputs.length, `识别主体：${input.name}`)
          const bitmap = await decodeImage(input)
          const size = 320
          const pixels = rgbaAt(bitmap, size, size)
          let max = 1e-6
          for (let i = 0; i < pixels.length; i += 4) max = Math.max(max, pixels[i], pixels[i + 1], pixels[i + 2])
          const tensor = toCHW(pixels, size, size, (v, c) => (v / max - IMAGENET_MEAN[c]) / IMAGENET_STD[c])
          const result = await runModel(session, MODELS.u2netp, { [MODELS.u2netp.input]: { type: 'float32', dims: [1, 3, size, size], data: tensor } })
          const saliency = maskToAlpha(result[MODELS.u2netp.output].data, true, 0)
          const crop = bestCrop(saliency, size, bitmap.width, bitmap.height, ratio, { fit: String(p.fit), padding: Number(p.padding) / 100 })
          const canvas = new OffscreenCanvas(crop.w, crop.h)
          const g = canvas.getContext('2d')
          g.imageSmoothingQuality = 'high'
          g.drawImage(bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h)
          bitmap.close()
          const type = input.type === 'image/png' ? 'image/png' : input.type === 'image/webp' ? 'image/webp' : 'image/jpeg'
          const blob = await canvas.convertToBlob({ type, quality: 0.95 })
          outputs.push((await host.fs.writeAll(renameWith(input.name, `-${rw}x${rh}`, type), new Uint8Array(await blob.arrayBuffer()), type)).id)
        }
        ctx.progress(1)
        return { outputs, summary: `已按 ${p.ratio} 裁剪 ${outputs.length} 张图片` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'erase',
      name: 'AI 消除',
      category: 'ai',
      icon: 'eraser',
      description: '用画笔涂抹路人、水印、杂物或文字，AI 根据周围画面自动补全，不留痕迹。',
      accept: ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/bmp'],
      multiple: false,
      keywords: ['inpaint', 'object removal', 'magic eraser', 'remove watermark', 'cleanup', '消除', '去水印', '去路人', '去杂物', '修复'],

      async setup(ui) {
        const input = ui.inputs[0]
        if (!input) {
          ui.render({ runDisabled: true, nodes: [{ type: 'alert', tone: 'info', title: '先拖入一张图片', text: '然后在图上涂抹想去掉的东西。' }] })
          return
        }
        const bitmap = await createImageBitmap(new Blob([await ui.host.fs.readAll(input.id)], { type: input.type || '' }))
        const strokes = eraseStrokes(input.id)
        let surface = null
        const aspect = bitmap.width / bitmap.height

        const paint = () => {
          if (!surface) return
          const g = surface.getContext('2d')
          g.globalCompositeOperation = 'source-over'
          g.clearRect(0, 0, surface.width, surface.height)
          g.drawImage(bitmap, 0, 0, surface.width, surface.height)
          const overlay = new OffscreenCanvas(surface.width, surface.height)
          drawStrokes(overlay.getContext('2d'), strokes, surface.width, surface.height, '#ff2d55')
          g.globalAlpha = 0.5
          g.drawImage(overlay, 0, 0)
          g.globalAlpha = 1
        }
        const build = (state) => ({
          runLabel: '开始消除',
          runDisabled: strokes.length === 0,
          nodes: [
            { type: 'canvas', id: 'paint', aspect: Math.min(3, Math.max(0.4, aspect)), interactive: true },
            {
              type: 'row', gap: 2, wrap: true,
              children: [
                { type: 'button', text: '撤销', action: 'undo', variant: 'outline', disabled: strokes.length === 0 },
                { type: 'button', text: '清除涂抹', action: 'clear', variant: 'ghost', icon: 'trash', disabled: strokes.length === 0 },
                { type: 'text', variant: 'muted', text: strokes.length ? `已涂抹 ${strokes.length} 笔` : '在图上涂抹要去掉的区域，盖住整个物体（含影子）效果最好。' },
              ],
            },
            { type: 'slider', bind: 'brush', label: '画笔大小', min: 1, max: 12, step: 0.5, suffix: '%' },
            {
              type: 'segmented', bind: 'model', label: '模型',
              options: [{ value: 'fast', label: '快速（MI-GAN 28 MB）' }, { value: 'quality', label: '精细（LaMa 208 MB）' }],
            },
            { type: 'text', variant: 'muted', text: `${bitmap.width} × ${bitmap.height} 像素。大面积背景（天空、墙面、草地）两种模型都好；结构复杂的背景用精细模型。` },
          ],
        })
        const render = () => ui.render(build(ui.state))
        ui.render({ state: { brush: 4, model: 'fast', ...pickDefined(ui.state, { brush: 4, model: 'fast' }) }, ...build(ui.state) })

        ui.on('canvas', (id, canvas) => {
          if (id !== 'paint') return
          surface = canvas
          paint()
        })
        ui.on('action', (name) => {
          if (name === 'undo') strokes.pop()
          if (name === 'clear') strokes.length = 0
          paint()
          render()
        })
        ui.on('pointer', async (id, event) => {
          if (id !== 'paint') return
          surface = await ui.canvas('paint')
          const x = event.x / surface.width
          const y = event.y / surface.height
          const wasEmpty = strokes.length === 0
          if (event.type === 'down') {
            strokes.push({ radius: (Number(ui.state.brush) || 4) / 200, points: [[x, y]] })
          } else if (event.type === 'move' && event.buttons && strokes.length) {
            strokes[strokes.length - 1].points.push([x, y])
          } else if (event.type === 'up') {
            render()
            return
          } else {
            return
          }
          paint()
          if (wasEmpty) render()
        })
      },

      async run(ctx) {
        const input = ctx.inputs[0]
        const strokes = eraseStrokes(input.id)
        if (strokes.length === 0) throw new Error('请先在图片上涂抹要消除的区域')
        const quality = ctx.params.model === 'quality'
        ctx.progress(0, '加载消除模型')
        const spec = quality ? MODELS.lama : MODELS.migan
        const session = await openSession(ctx, spec)
        const bitmap = await decodeImage(input)
        const { width, height } = bitmap

        // Full-resolution mask; the stroke radius is relative to the image's long side.
        const mask = new OffscreenCanvas(width, height)
        drawStrokes(mask.getContext('2d'), strokes, width, height, '#ffffff')
        const alpha = mask.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data
        const bounds = maskBounds(alpha, width, height)
        if (!bounds) throw new Error('涂抹区域为空')
        const crop = contextCrop(bounds, width, height)

        ctx.progress(0.2, '补全画面')
        const side = quality ? 512 : Math.min(1024, Math.max(crop.w, crop.h))
        const scale = quality ? null : side / Math.max(crop.w, crop.h)
        const inW = quality ? 512 : Math.max(8, Math.round(crop.w * scale))
        const inH = quality ? 512 : Math.max(8, Math.round(crop.h * scale))
        const pixels = rgbaFrom(bitmap, crop, inW, inH)
        const holes = rgbaFrom(mask, crop, inW, inH)
        const plane = inW * inH
        let result
        if (quality) {
          const image = toCHW(pixels, inW, inH, (v) => v / 255)
          const hole = new Float32Array(plane)
          for (let i = 0; i < plane; i++) hole[i] = holes[i * 4 + 3] > 0 ? 1 : 0
          const out = await runModel(session, spec, {
            image: { type: 'float32', dims: [1, 3, inH, inW], data: image },
            mask: { type: 'float32', dims: [1, 1, inH, inW], data: hole },
          })
          result = planarToRgba(out.output.data, inW, inH, (v) => v)
        } else {
          const image = new Uint8Array(3 * plane)
          const keep = new Uint8Array(plane)
          for (let i = 0; i < plane; i++) {
            image[i] = pixels[i * 4]
            image[plane + i] = pixels[i * 4 + 1]
            image[2 * plane + i] = pixels[i * 4 + 2]
            // MI-GAN's pipeline fills where the mask is 0 and keeps where it is 255.
            keep[i] = holes[i * 4 + 3] > 0 ? 0 : 255
          }
          const out = await runModel(session, spec, {
            image: { type: 'uint8', dims: [1, 3, inH, inW], data: image },
            mask: { type: 'uint8', dims: [1, 1, inH, inW], data: keep },
          })
          result = planarToRgba(out.result.data, inW, inH, (v) => v)
        }
        ctx.progress(0.85, '合成')

        const patch = new OffscreenCanvas(inW, inH)
        patch.getContext('2d').putImageData(new ImageData(result, inW, inH), 0, 0)
        // Only masked pixels change: the patch is cut by a slightly feathered copy of the mask.
        const cut = new OffscreenCanvas(crop.w, crop.h)
        const cg = cut.getContext('2d')
        cg.imageSmoothingQuality = 'high'
        cg.drawImage(patch, 0, 0, crop.w, crop.h)
        cg.globalCompositeOperation = 'destination-in'
        cg.filter = `blur(${Math.max(1, Math.round(Math.max(width, height) / 800))}px)`
        cg.drawImage(mask, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h)
        const canvas = new OffscreenCanvas(width, height)
        const g = canvas.getContext('2d')
        g.drawImage(bitmap, 0, 0)
        g.drawImage(cut, crop.x, crop.y)
        bitmap.close()

        const type = input.type === 'image/png' ? 'image/png' : input.type === 'image/webp' ? 'image/webp' : 'image/jpeg'
        const blob = await canvas.convertToBlob({ type, quality: 0.95 })
        const out = await host.fs.writeAll(renameWith(input.name, '-erased', type), new Uint8Array(await blob.arrayBuffer()), type)
        ctx.progress(1)
        return { outputs: [out.id], summary: `已消除 ${strokes.length} 处涂抹区域（${quality ? 'LaMa' : 'MI-GAN'}）` }
      },
    },
  ],
})

/* ========================================================================== */
/* Models                                                                     */
/* ========================================================================== */

const HF = 'https://huggingface.co'

const MODELS = {
  u2netp: {
    id: 'u2netp', name: 'U²-Netp 抠图模型', license: 'Apache-2.0',
    url: `${HF}/BritishWerewolf/U-2-Netp/resolve/main/onnx/model.onnx`,
    sha256: '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8', bytes: 4574861,
    input: 'input.1', output: null,
  },
  isnet: {
    id: 'isnet-general', name: 'IS-Net 通用抠图模型', license: 'MIT',
    url: `${HF}/imgly/isnet-general-onnx/resolve/main/onnx/model.onnx`,
    sha256: 'cc2c9f5c1751b9737cb81e708ff0c5e9542c2205daed22418a4fd2ab5d4c481a', bytes: 176149806,
    input: 'input', output: 'output',
  },
  det: {
    id: 'ppocrv4-det', name: 'PP-OCRv4 文字检测模型', license: 'Apache-2.0',
    url: `${HF}/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx`,
    sha256: 'd2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9', bytes: 4745517,
    input: 'x', output: null,
  },
  rec: {
    id: 'ppocrv4-rec', name: 'PP-OCRv4 中英文识别模型', license: 'Apache-2.0',
    url: `${HF}/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx`,
    sha256: '48fc40f24f6d2a207a2b1091d3437eb3cc3eb6b676dc3ef9c37384005483683b', bytes: 10857958,
    input: 'x', output: null,
  },
  yunet: {
    id: 'yunet-2023mar', name: 'YuNet 人脸检测模型', license: 'MIT',
    url: `${HF}/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx`,
    sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4', bytes: 232589,
    input: 'input', output: 'cls_8',
  },
  migan: {
    id: 'migan-pipeline-v2', name: 'MI-GAN 图像补全模型', license: 'MIT',
    url: `${HF}/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx`,
    sha256: '6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b', bytes: 28079181,
    input: 'image', output: 'result',
  },
  lama: {
    id: 'lama-fp32', name: 'LaMa 图像补全模型', license: 'Apache-2.0',
    url: `${HF}/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx`,
    sha256: '1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6', bytes: 208044816,
    input: 'image', output: 'output',
  },
  swin2sr: {
    id: 'swin2sr-lightweight-x2', name: 'Swin2SR 轻量超分模型（×2）', license: 'Apache-2.0',
    url: `${HF}/Xenova/swin2SR-lightweight-x2-64/resolve/main/onnx/model.onnx`,
    sha256: 'c2abbfe0cc8e685b5e11964970f8ebe3d24072e904fd5545a30ac31ec1e110db', bytes: 8078888,
    input: 'pixel_values', output: 'reconstruction',
  },
}

/** Whisper exports pinned to one commit, so the vendored token table always matches. */
const WHISPER_BASE = `${HF}/onnx-community/whisper-base/resolve/1846881b6b3a3024392c1eea3ad983695bc23925/onnx`
const WHISPER_SMALL = `${HF}/onnx-community/whisper-small/resolve/main/onnx`
const WHISPER = {
  base: {
    layers: 6,
    encoder: {
      id: 'whisper-base-encoder-q8', name: 'Whisper base 编码器', license: 'MIT', url: `${WHISPER_BASE}/encoder_model_quantized.onnx`,
      sha256: '5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46', bytes: 23201314, input: 'input_features', output: 'last_hidden_state',
    },
    decoder: {
      id: 'whisper-base-decoder-q8', name: 'Whisper base 解码器', license: 'MIT', url: `${WHISPER_BASE}/decoder_model_merged_quantized.onnx`,
      sha256: 'fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b', bytes: 53693315, input: 'input_ids', output: 'logits',
    },
  },
  small: {
    layers: 12,
    encoder: {
      id: 'whisper-small-encoder-q8', name: 'Whisper small 编码器', license: 'MIT', url: `${WHISPER_SMALL}/encoder_model_quantized.onnx`,
      sha256: 'a43a83f3c5361cd591cfa7c36f14b43cf7cb22f47a415cc14a8d557be800fa92', bytes: 92326160, input: 'input_features', output: 'last_hidden_state',
    },
    decoder: {
      id: 'whisper-small-decoder-q8', name: 'Whisper small 解码器', license: 'MIT', url: `${WHISPER_SMALL}/decoder_model_merged_quantized.onnx`,
      sha256: 'ec07c3cbb64172c39791e26ee870a65ac22b458c36722bfe2776b3dbf741e0c9', bytes: 156750845, input: 'input_ids', output: 'logits',
    },
  },
}

const IMAGENET_MEAN = [0.485, 0.456, 0.406]
const IMAGENET_STD = [0.229, 0.224, 0.225]
const MAX_UPSCALE_PIXELS = 1600 * 1600

/** Session ids by model id, reused across runs of this sandbox. */
const sessions = new Map()

/**
 * Loads a model once per sandbox. The first load of a model shows the host's
 * download dialog; later loads come from the verified cache. Output names that
 * are not fixed across exports (`output: null`) are read from the session.
 */
async function openSession(ctx, spec) {
  if (!sessions.has(spec.id)) {
    const loading = ctx.host.onnx.load({ id: spec.id, name: spec.name, url: spec.url, sha256: spec.sha256, bytes: spec.bytes, license: spec.license })
    sessions.set(spec.id, loading)
    loading.catch(() => sessions.delete(spec.id))
  }
  const sessionId = await sessions.get(spec.id)
  if (!spec.output || !spec.inputName) {
    const info = await ctx.host.onnx.info(sessionId)
    spec.inputName = info.inputs[0]
    spec.output = spec.output || info.outputs[0]
  }
  return sessionId
}

async function runModel(sessionId, spec, feeds) {
  // Feed under the session's real input name when it differs from the documented one.
  if (spec.inputName && !(spec.inputName in feeds)) {
    const [only] = Object.values(feeds)
    feeds = { [spec.inputName]: only }
  }
  try {
    return await host.onnx.run(sessionId, feeds)
  } catch (err) {
    // The host drops sessions when the sandbox restarts; forget ours so the next run reloads.
    if (/session/i.test(String(err && err.message))) sessions.delete(spec.id)
    throw err
  }
}

/* ========================================================================== */
/* Pixels                                                                     */
/* ========================================================================== */

function isPdf(input) {
  return input.type === 'application/pdf' || /\.pdf$/i.test(input.name)
}

async function decodeImage(input) {
  const bytes = await host.fs.readAll(input.id)
  try {
    return await createImageBitmap(new Blob([bytes], { type: input.type || '' }))
  } catch (err) {
    throw new Error(`无法解码 ${input.name}：浏览器不支持该格式，可先用「批量压缩 / 格式转换」转为 PNG 或 JPEG`)
  }
}

/** RGBA pixels of a bitmap drawn at `width × height`. */
function rgbaAt(bitmap, width, height) {
  const canvas = new OffscreenCanvas(width, height)
  const g = canvas.getContext('2d', { willReadFrequently: true })
  g.imageSmoothingQuality = 'high'
  g.drawImage(bitmap, 0, 0, width, height)
  return new Uint8Array(g.getImageData(0, 0, width, height).data.buffer)
}

/** RGBA → planar float32 CHW, each channel value mapped by `normalise(value, channel)`. */
function toCHW(rgba, width, height, normalise) {
  const plane = width * height
  const out = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i++) {
    out[i] = normalise(rgba[i * 4], 0)
    out[plane + i] = normalise(rgba[i * 4 + 1], 1)
    out[2 * plane + i] = normalise(rgba[i * 4 + 2], 2)
  }
  return out
}

function renameWith(name, suffix, type) {
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'text/plain': 'txt' }[type] ?? 'bin'
  return `${name.replace(/\.[^.]+$/, '')}${suffix}.${extension}`
}

/* ========================================================================== */
/* Background removal                                                         */
/* ========================================================================== */

/**
 * Model output → 0–255 alpha at model resolution. U²-Net's raw output is
 * min-max stretched (as rembg does); IS-Net already emits a 0–1 mask.
 * `hardness` pushes the soft edge towards a binary one.
 */
function maskToAlpha(prediction, stretch, hardness) {
  let lo = 0
  let hi = 1
  if (stretch) {
    lo = Infinity
    hi = -Infinity
    for (const v of prediction) {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }
  const span = hi - lo || 1
  const alpha = new Uint8ClampedArray(prediction.length)
  const edge = Math.max(0.001, 0.5 * (1 - hardness))
  for (let i = 0; i < prediction.length; i++) {
    let v = (prediction[i] - lo) / span
    if (hardness > 0) v = Math.min(1, Math.max(0, (v - (0.5 - edge)) / (2 * edge)))
    alpha[i] = v * 255
  }
  return alpha
}

function composeCutout(bitmap, alpha, size, mode, background) {
  // The mask is scaled up by the browser, which interpolates smoothly - far better
  // edges than thresholding at model resolution.
  const maskCanvas = new OffscreenCanvas(size, size)
  const maskData = new ImageData(size, size)
  for (let i = 0; i < alpha.length; i++) {
    maskData.data[i * 4] = maskData.data[i * 4 + 1] = maskData.data[i * 4 + 2] = 255
    maskData.data[i * 4 + 3] = alpha[i]
  }
  maskCanvas.getContext('2d').putImageData(maskData, 0, 0)

  const { width, height } = bitmap
  const canvas = new OffscreenCanvas(width, height)
  const g = canvas.getContext('2d')
  g.imageSmoothingQuality = 'high'

  if (mode === 'mask') {
    g.fillStyle = '#000000'
    g.fillRect(0, 0, width, height)
    g.drawImage(maskCanvas, 0, 0, width, height)
    return canvas
  }

  const cutout = new OffscreenCanvas(width, height)
  const cg = cutout.getContext('2d')
  cg.drawImage(bitmap, 0, 0)
  cg.globalCompositeOperation = 'destination-in'
  cg.imageSmoothingQuality = 'high'
  cg.drawImage(maskCanvas, 0, 0, width, height)

  if (mode === 'color') {
    g.fillStyle = background
    g.fillRect(0, 0, width, height)
  }
  g.drawImage(cutout, 0, 0)
  return canvas
}

/* ========================================================================== */
/* Super-resolution                                                           */
/* ========================================================================== */

const TILE = 128
const TILE_CONTEXT = 12

/**
 * ×2 super-resolution in overlapping tiles. Each tile is enlarged with some
 * surrounding context and only its centre is kept, so tile seams disappear;
 * tiles are padded to Swin2SR's window size (8) by repeating edge pixels.
 */
async function upscaleTiled(ctx, sessionId, rgba, width, height, onProgress) {
  const out = new Uint8Array(width * 2 * height * 2 * 4)
  const total = Math.ceil(width / TILE) * Math.ceil(height / TILE)
  let done = 0

  for (let ty = 0; ty < height; ty += TILE) {
    for (let tx = 0; tx < width; tx += TILE) {
      ctx.throwIfAborted()
      const x0 = Math.max(0, tx - TILE_CONTEXT)
      const y0 = Math.max(0, ty - TILE_CONTEXT)
      const x1 = Math.min(width, tx + TILE + TILE_CONTEXT)
      const y1 = Math.min(height, ty + TILE + TILE_CONTEXT)
      const pw = Math.ceil((x1 - x0) / 8) * 8
      const ph = Math.ceil((y1 - y0) / 8) * 8

      const plane = pw * ph
      const tensor = new Float32Array(3 * plane)
      for (let y = 0; y < ph; y++) {
        const sy = Math.min(y1 - 1, y0 + y)
        for (let x = 0; x < pw; x++) {
          const sx = Math.min(x1 - 1, x0 + x)
          const s = (sy * width + sx) * 4
          const d = y * pw + x
          tensor[d] = rgba[s] / 255
          tensor[plane + d] = rgba[s + 1] / 255
          tensor[2 * plane + d] = rgba[s + 2] / 255
        }
      }

      const result = await runModel(sessionId, MODELS.swin2sr, { pixel_values: { type: 'float32', dims: [1, 3, ph, pw], data: tensor } })
      const recon = result[MODELS.swin2sr.output]
      const ow = recon.dims[3]
      const outPlane = recon.dims[2] * ow
      const keepW = Math.min(TILE, width - tx) * 2
      const keepH = Math.min(TILE, height - ty) * 2
      const offX = (tx - x0) * 2
      const offY = (ty - y0) * 2

      for (let y = 0; y < keepH; y++) {
        for (let x = 0; x < keepW; x++) {
          const s = (offY + y) * ow + offX + x
          const d = ((ty * 2 + y) * width * 2 + tx * 2 + x) * 4
          out[d] = clampByte(recon.data[s] * 255)
          out[d + 1] = clampByte(recon.data[outPlane + s] * 255)
          out[d + 2] = clampByte(recon.data[2 * outPlane + s] * 255)
          out[d + 3] = 255
        }
      }
      onProgress(++done / total)
    }
  }
  return out
}

function clampByte(value) {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value)
}

/* ========================================================================== */
/* OCR                                                                        */
/* ========================================================================== */

const DET_THRESHOLD = 0.3
const DET_BOX_THRESHOLD = 0.5
const DET_UNCLIP = 1.6
const REC_HEIGHT = 48

/**
 * DB text detection: probability map → connected regions → boxes, scored by
 * mean probability and "unclipped" outwards (DB predicts shrunk text kernels).
 * Boxes are axis-aligned, which fits horizontal documents and screenshots.
 * Returns `[x, y, w, h]` in bitmap pixels, in reading order.
 */
async function detectText(sessionId, bitmap, limit) {
  const scale = Math.min(1, limit / Math.max(bitmap.width, bitmap.height))
  const dw = Math.max(32, Math.round((bitmap.width * scale) / 32) * 32)
  const dh = Math.max(32, Math.round((bitmap.height * scale) / 32) * 32)
  const tensor = toCHW(rgbaAt(bitmap, dw, dh), dw, dh, (v, c) => (v / 255 - IMAGENET_MEAN[c]) / IMAGENET_STD[c])
  const result = await runModel(sessionId, MODELS.det, { x: { type: 'float32', dims: [1, 3, dh, dw], data: tensor } })
  const prob = result[MODELS.det.output].data

  const labels = new Int32Array(dw * dh)
  const boxes = []
  const stack = []
  let next = 0
  for (let start = 0; start < prob.length; start++) {
    if (prob[start] <= DET_THRESHOLD || labels[start]) continue
    labels[start] = ++next
    stack.push(start)
    let minX = dw
    let minY = dh
    let maxX = 0
    let maxY = 0
    let sum = 0
    let count = 0
    while (stack.length) {
      const i = stack.pop()
      const x = i % dw
      const y = (i - x) / dw
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      sum += prob[i]
      count++
      if (x > 0 && !labels[i - 1] && prob[i - 1] > DET_THRESHOLD) (labels[i - 1] = next), stack.push(i - 1)
      if (x < dw - 1 && !labels[i + 1] && prob[i + 1] > DET_THRESHOLD) (labels[i + 1] = next), stack.push(i + 1)
      if (y > 0 && !labels[i - dw] && prob[i - dw] > DET_THRESHOLD) (labels[i - dw] = next), stack.push(i - dw)
      if (y < dh - 1 && !labels[i + dw] && prob[i + dw] > DET_THRESHOLD) (labels[i + dw] = next), stack.push(i + dw)
    }
    const w = maxX - minX + 1
    const h = maxY - minY + 1
    if (Math.min(w, h) < 3 || sum / count < DET_BOX_THRESHOLD) continue
    // Offset = area × ratio / perimeter, the polygon unclip of DBNet for a rectangle.
    const d = (w * h * DET_UNCLIP) / (2 * (w + h))
    const sx = bitmap.width / dw
    const sy = bitmap.height / dh
    const x = Math.max(0, (minX - d) * sx)
    const y = Math.max(0, (minY - d) * sy)
    boxes.push([x, y, Math.min(bitmap.width, (maxX + 1 + d) * sx) - x, Math.min(bitmap.height, (maxY + 1 + d) * sy) - y])
  }
  return sortReadingOrder(boxes)
}

/** Top-to-bottom rows (boxes whose vertical centres are close), left-to-right within a row. */
function sortReadingOrder(boxes) {
  const sorted = [...boxes].sort((a, b) => a[1] + a[3] / 2 - (b[1] + b[3] / 2))
  const rows = []
  for (const box of sorted) {
    const centre = box[1] + box[3] / 2
    const row = rows.find((r) => Math.abs(r.centre - centre) < Math.min(r.height, box[3]) * 0.5)
    if (row) row.boxes.push(box)
    else rows.push({ centre, height: box[3], boxes: [box] })
  }
  return rows.flatMap((row) => row.boxes.sort((a, b) => a[0] - b[0]))
}

/**
 * CRNN/SVTR recognition with greedy CTC decoding: class 0 is blank, the last
 * class is a space, class i is `keys[i - 1]`. Tall crops are rotated first:
 * vertical text reads top-to-bottom.
 */
async function recognizeLine(sessionId, keys, bitmap, [x, y, w, h]) {
  const cw = Math.max(1, Math.round(w))
  const ch = Math.max(1, Math.round(h))
  const vertical = ch >= cw * 1.5
  const crop = new OffscreenCanvas(vertical ? ch : cw, vertical ? cw : ch)
  const cg = crop.getContext('2d')
  if (vertical) {
    cg.translate(0, cw)
    cg.rotate(-Math.PI / 2)
  }
  cg.drawImage(bitmap, Math.round(x), Math.round(y), cw, ch, 0, 0, cw, ch)

  const width = Math.max(16, Math.min(2400, Math.ceil((REC_HEIGHT * crop.width) / crop.height)))
  const tensor = toCHW(rgbaAt(crop, width, REC_HEIGHT), width, REC_HEIGHT, (v) => v / 127.5 - 1)
  const result = await runModel(sessionId, MODELS.rec, { x: { type: 'float32', dims: [1, 3, REC_HEIGHT, width], data: tensor } })
  const output = result[MODELS.rec.output]
  return { ...ctcDecode(output.data, output.dims[1], output.dims[2], keys), vertical }
}

function ctcDecode(data, steps, classes, keys) {
  let text = ''
  let last = -1
  let confidence = 0
  let kept = 0
  for (let t = 0; t < steps; t++) {
    let best = 0
    let bestValue = -Infinity
    const row = t * classes
    for (let c = 0; c < classes; c++) {
      if (data[row + c] > bestValue) {
        bestValue = data[row + c]
        best = c
      }
    }
    if (best !== 0 && best !== last) {
      text += best === classes - 1 ? ' ' : keys[best - 1] ?? ''
      confidence += bestValue
      kept++
    }
    last = best
  }
  return { text: text.trim(), confidence: kept ? confidence / kept : 0 }
}

/** Lines on the same visual row are joined with a space; rows with newlines. */
function joinReadingOrder(lines) {
  const out = []
  let rowCentre = null
  let rowHeight = 0
  for (const line of lines) {
    const centre = line.box[1] + line.box[3] / 2
    if (rowCentre !== null && Math.abs(centre - rowCentre) < Math.min(rowHeight, line.box[3]) * 0.5) {
      out[out.length - 1] += ` ${line.text}`
    } else {
      out.push(line.text)
      rowCentre = centre
      rowHeight = line.box[3]
    }
  }
  return out.join('\n')
}

function drawBoxes(bitmap, lines) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const g = canvas.getContext('2d')
  g.drawImage(bitmap, 0, 0)
  g.lineWidth = Math.max(2, Math.round(bitmap.width / 600))
  const fontSize = Math.max(12, Math.round(bitmap.width / 70))
  g.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`
  for (const line of lines) {
    const [x, y, w, h] = line.box
    g.strokeStyle = line.confidence > 0.85 ? 'rgba(22,163,74,.9)' : 'rgba(234,88,12,.9)'
    g.strokeRect(x, y, w, h)
    g.fillStyle = 'rgba(0,0,0,.6)'
    const label = `${Math.round(line.confidence * 100)}%`
    g.fillRect(x, Math.max(0, y - fontSize - 4), g.measureText(label).width + 8, fontSize + 4)
    g.fillStyle = '#fff'
    g.fillText(label, x + 4, Math.max(fontSize, y - 4))
  }
  return canvas
}

/* ========================================================================== */
/* PDF input                                                                  */
/* ========================================================================== */

class WorkerCanvasFactory {
  constructor({ enableHWA = false } = {}) {
    this.enableHWA = enableHWA
  }
  create(width, height) {
    const canvas = new OffscreenCanvas(width, height)
    return { canvas, context: canvas.getContext('2d', { willReadFrequently: !this.enableHWA }) }
  }
  reset(pair, width, height) {
    pair.canvas.width = width
    pair.canvas.height = height
  }
  destroy(pair) {
    pair.canvas.width = pair.canvas.height = 0
    pair.canvas = null
    pair.context = null
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

/**
 * What pdf.js gets as `ownerDocument`. It registers every font embedded in the
 * PDF through `ownerDocument.fonts`, defaulting to `globalThis.document` - which
 * a Worker does not have. Without it pdf.js skipped the Font Loading API, its
 * CSS fallback threw, and glyphs (remapped to Private Use Area code points that
 * only the embedded font can draw) came out as missing-glyph boxes: rendered
 * pages showed boxes for all embedded-font text, CJK most visibly. A Worker has
 * its own FontFaceSet, and it is the one OffscreenCanvas text in this thread
 * draws from.
 */
function workerOwnerDocument() {
  return { fonts: self.fonts }
}

/**
 * Serves pdf.js the data it would otherwise fetch by URL - CMaps for text in
 * non-embedded CJK fonts, standard font programs, and the wasm decoders for
 * JPEG 2000 and JBIG2 images - from the `pdfjs-data` pack (scripts/vendor.mjs).
 * The sandbox has no network, so without this such text was missing and such
 * images (common in scanned PDFs) rendered blank. The pack is a lazy
 * dependency: it loads the first time a document actually needs it.
 */
class SandboxPdfDataFactory {
  async fetch({ kind, filename }) {
    const dir = { cMapUrl: 'cmaps/', standardFontDataUrl: 'standard_fonts/', wasmUrl: 'wasm/' }[kind]
    if (!dir) throw new Error(`Not implemented: ${kind}`)
    const { exports: data, assets } = await loadDependency('pdfjs-data')
    const entry = data.files[dir + filename]
    if (!entry) throw new Error(`pdf.js 资源不存在：${dir}${filename}`)
    return new Uint8Array(assets['pack.bin'], entry[0], entry[1]).slice()
  }
}

/** pdf.js only checks these prefixes are set; `SandboxPdfDataFactory` resolves them. */
function pdfDataOptions() {
  return {
    BinaryDataFactory: SandboxPdfDataFactory,
    cMapUrl: 'pdfjs-data:/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'pdfjs-data:/standard_fonts/',
    wasmUrl: 'pdfjs-data:/wasm/',
  }
}

/** Renders the selected pages of a PDF to bitmaps, loading pdf.js on first use. */
async function renderPdfPages(ctx, input, spec, dpi) {
  const { exports: pdfjs } = await loadDependency('pdfjs')
  await loadDependency('pdfjs-worker')
  pdfjs.GlobalWorkerOptions.workerSrc = ''
  const bytes = await host.fs.readAll(input.id)
  const task = pdfjs.getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false, CanvasFactory: WorkerCanvasFactory, FilterFactory: WorkerFilterFactory, ownerDocument: workerOwnerDocument(), ...pdfDataOptions() })
  const doc = await task.promise
  try {
    const numbers = parsePages(spec, doc.numPages)
    if (numbers.length === 0) throw new Error(`${input.name}：页码范围没有匹配到任何页面`)
    const pages = []
    for (const number of numbers) {
      ctx.throwIfAborted()
      ctx.progress(null, `渲染 ${input.name} 第 ${number} 页`)
      const page = await doc.getPage(number)
      const viewport = page.getViewport({ scale: dpi / 72 })
      const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      const g = canvas.getContext('2d')
      g.fillStyle = '#ffffff'
      g.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: g, viewport }).promise
      page.cleanup()
      pages.push({ number, label: `${input.name} 第 ${number} 页`, bitmap: await createImageBitmap(canvas) })
    }
    return pages
  } finally {
    await task.destroy()
  }
}

function parsePages(spec, total) {
  const pages = []
  for (const raw of String(spec).split(',')) {
    const part = raw.trim()
    if (!part) continue
    const match = /^(\d*)\s*-\s*(\d*)$/.exec(part)
    let [start, end] = match ? [match[1] ? +match[1] : 1, match[2] ? +match[2] : total] : /^\d+$/.test(part) ? [+part, +part] : [NaN, NaN]
    if (!Number.isFinite(start)) throw new Error(`无法解析页码范围：${part}`)
    if (start > end) [start, end] = [end, start]
    for (let n = Math.max(1, start); n <= Math.min(total, end); n++) if (!pages.includes(n)) pages.push(n)
  }
  return pages
}

/* ========================================================================== */
/* Faces                                                                      */
/* ========================================================================== */

const YUNET_SIZE = 640
const YUNET_STRIDES = [8, 16, 32]

/**
 * Faces in a bitmap as `{ x, y, w, h, score }` in bitmap pixels.
 *
 * YuNet takes a fixed 640² input. One pass sees the whole image letterboxed;
 * for large images a second pass tiles a ~1920 px copy in overlapping 640²
 * windows, which is what finds the small faces at the back of a group photo.
 */
async function detectFaces(ctx, session, bitmap, threshold) {
  const { width, height } = bitmap
  const found = []
  const pass = async (sx, sy, sw, sh, scale) => {
    ctx.throwIfAborted()
    const canvas = new OffscreenCanvas(YUNET_SIZE, YUNET_SIZE)
    const g = canvas.getContext('2d', { willReadFrequently: true })
    g.fillStyle = '#000'
    g.fillRect(0, 0, YUNET_SIZE, YUNET_SIZE)
    g.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw * scale, sh * scale)
    const rgba = g.getImageData(0, 0, YUNET_SIZE, YUNET_SIZE).data
    const plane = YUNET_SIZE * YUNET_SIZE
    const input = new Float32Array(3 * plane)
    // OpenCV feeds BGR, unnormalised.
    for (let i = 0; i < plane; i++) {
      input[i] = rgba[i * 4 + 2]
      input[plane + i] = rgba[i * 4 + 1]
      input[2 * plane + i] = rgba[i * 4]
    }
    const outputs = await runModel(session, MODELS.yunet, { input: { type: 'float32', dims: [1, 3, YUNET_SIZE, YUNET_SIZE], data: input } })
    for (const face of decodeYunet(outputs, YUNET_SIZE, threshold)) {
      found.push({
        x: sx + face.x / scale, y: sy + face.y / scale, w: face.w / scale, h: face.h / scale, score: face.score,
        landmarks: face.landmarks.map(([lx, ly]) => [sx + lx / scale, sy + ly / scale]),
      })
    }
  }

  const fit = YUNET_SIZE / Math.max(width, height)
  await pass(0, 0, width, height, Math.min(1, fit) === 1 ? Math.min(fit, 2) : fit)
  if (Math.max(width, height) > YUNET_SIZE * 1.5) {
    const scale = Math.min(1, 1920 / Math.max(width, height))
    const window = YUNET_SIZE / scale
    for (const y of tileStarts(height, window)) {
      for (const x of tileStarts(width, window)) await pass(x, y, Math.min(window, width - x), Math.min(window, height - y), scale)
    }
  }
  return suppressOverlaps(found, 0.3)
}

/** Tile origins covering `length` with windows of `window`, overlapping by a fifth. */
function tileStarts(length, window) {
  if (length <= window) return [0]
  const stride = window * 0.8
  const starts = []
  for (let at = 0; at + window < length; at += stride) starts.push(Math.round(at))
  starts.push(Math.round(length - window))
  return starts
}

/** YuNet's anchor-free heads → boxes in input pixels (as OpenCV's FaceDetectorYN decodes them). */
function decodeYunet(outputs, size, threshold) {
  const faces = []
  for (const stride of YUNET_STRIDES) {
    const cols = size / stride
    const cls = outputs[`cls_${stride}`].data
    const obj = outputs[`obj_${stride}`].data
    const box = outputs[`bbox_${stride}`].data
    const kps = outputs[`kps_${stride}`]?.data
    for (let i = 0; i < cls.length; i++) {
      const score = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])))
      if (score < threshold) continue
      const col = i % cols
      const row = (i - col) / cols
      const cx = (col + box[i * 4]) * stride
      const cy = (row + box[i * 4 + 1]) * stride
      const w = Math.exp(box[i * 4 + 2]) * stride
      const h = Math.exp(box[i * 4 + 3]) * stride
      // Five landmarks: right eye, left eye, nose tip, right and left mouth corners (as seen in the image).
      const landmarks = kps ? [0, 1, 2, 3, 4].map((n) => [(kps[i * 10 + n * 2] + col) * stride, (kps[i * 10 + n * 2 + 1] + row) * stride]) : []
      faces.push({ x: cx - w / 2, y: cy - h / 2, w, h, score, landmarks })
    }
  }
  return faces
}

/** Greedy NMS by score; a box mostly inside a kept one also goes (tile seams). */
function suppressOverlaps(boxes, iouLimit) {
  const kept = []
  for (const box of [...boxes].sort((a, b) => b.score - a.score)) {
    const clash = kept.some((k) => {
      const ix = Math.max(0, Math.min(k.x + k.w, box.x + box.w) - Math.max(k.x, box.x))
      const iy = Math.max(0, Math.min(k.y + k.h, box.y + box.h) - Math.max(k.y, box.y))
      const inter = ix * iy
      const smaller = Math.min(k.w * k.h, box.w * box.h)
      return inter / (k.w * k.h + box.w * box.h - inter) > iouLimit || inter / smaller > 0.7
    })
    if (!clash) kept.push(box)
  }
  return kept
}

function expandBox(box, ratio, width, height) {
  const dw = box.w * ratio
  const dh = box.h * ratio
  const x = Math.max(0, box.x - dw / 2)
  const y = Math.max(0, box.y - dh * 0.7)
  return { x, y, w: Math.min(width, box.x + box.w + dw / 2) - x, h: Math.min(height, box.y + box.h + dh * 0.3) - y }
}

function obscureRegion(g, source, box, { effect, strength, shape, color }) {
  const x = Math.round(box.x)
  const y = Math.round(box.y)
  const w = Math.max(1, Math.round(box.w))
  const h = Math.max(1, Math.round(box.h))
  g.save()
  g.beginPath()
  if (shape === 'rect') g.rect(x, y, w, h)
  else g.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
  g.clip()
  if (effect === 'fill') {
    g.fillStyle = color
    g.fillRect(x, y, w, h)
  } else if (effect === 'blur') {
    const radius = Math.max(2, (Math.max(w, h) * strength) / 60)
    // Blur a margin around the face too, so the edge does not pull in sharp detail.
    const m = Math.ceil(radius * 2)
    g.filter = `blur(${radius}px)`
    g.drawImage(source, x - m, y - m, w + 2 * m, h + 2 * m, x - m, y - m, w + 2 * m, h + 2 * m)
    g.filter = 'none'
  } else {
    // Mosaic: 14 cells across at strength 1, 4 at strength 10.
    const cells = Math.max(3, 15 - strength)
    const cw = Math.max(1, Math.round(cells * Math.min(1, w / h)))
    const ch = Math.max(1, Math.round(cells * Math.min(1, h / w)))
    const tiny = new OffscreenCanvas(cw, ch)
    tiny.getContext('2d').drawImage(source, x, y, w, h, 0, 0, cw, ch)
    g.imageSmoothingEnabled = false
    g.drawImage(tiny, x, y, w, h)
  }
  g.restore()
}

/* ========================================================================== */
/* Inpainting                                                                 */
/* ========================================================================== */

/** Brush strokes per input file, shared by the painting panel and run in this sandbox. */
const erasePaint = new Map()

function eraseStrokes(fileId) {
  if (!erasePaint.has(fileId)) {
    // A new image starts clean; older paintings are dropped.
    erasePaint.clear()
    erasePaint.set(fileId, [])
  }
  return erasePaint.get(fileId)
}

/** Strokes in fractions of the image; radius is relative to the long side. */
function drawStrokes(g, strokes, width, height, color) {
  g.strokeStyle = color
  g.fillStyle = color
  g.lineCap = 'round'
  g.lineJoin = 'round'
  for (const stroke of strokes) {
    const r = stroke.radius * Math.max(width, height)
    const [x0, y0] = stroke.points[0]
    g.beginPath()
    g.arc(x0 * width, y0 * height, r, 0, Math.PI * 2)
    g.fill()
    if (stroke.points.length < 2) continue
    g.lineWidth = r * 2
    g.beginPath()
    g.moveTo(x0 * width, y0 * height)
    for (const [x, y] of stroke.points.slice(1)) g.lineTo(x * width, y * height)
    g.stroke()
  }
}

function maskBounds(rgba, width, height) {
  let minX = width, minY = height, maxX = -1, maxY = -1
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      if (rgba[(row + x) * 4 + 3] === 0) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/**
 * The region handed to the model: the mask plus as much surrounding context
 * again (at least 128 px), squared up where the image allows. Inpainting models
 * copy texture from what they can see, so too tight a crop starves them.
 */
function contextCrop(bounds, width, height) {
  const extent = Math.max(bounds.w, bounds.h)
  const size = Math.min(Math.max(extent * 2, extent + 256), extent + 512)
  const w = Math.min(width, size)
  const h = Math.min(height, size)
  const cx = bounds.x + bounds.w / 2
  const cy = bounds.y + bounds.h / 2
  const x = Math.round(Math.min(width - w, Math.max(0, cx - w / 2)))
  const y = Math.round(Math.min(height - h, Math.max(0, cy - h / 2)))
  return { x, y, w: Math.round(w), h: Math.round(h) }
}

function rgbaFrom(source, crop, width, height) {
  const canvas = new OffscreenCanvas(width, height)
  const g = canvas.getContext('2d', { willReadFrequently: true })
  g.imageSmoothingQuality = 'high'
  g.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, width, height)
  return g.getImageData(0, 0, width, height).data
}

function planarToRgba(data, width, height, map) {
  const plane = width * height
  const out = new Uint8ClampedArray(plane * 4)
  for (let i = 0; i < plane; i++) {
    out[i * 4] = map(data[i])
    out[i * 4 + 1] = map(data[plane + i])
    out[i * 4 + 2] = map(data[2 * plane + i])
    out[i * 4 + 3] = 255
  }
  return out
}

function pickDefined(state, defaults) {
  const out = {}
  for (const key of Object.keys(defaults)) if (state && state[key] !== undefined && state[key] !== null) out[key] = state[key]
  return out
}

/* ========================================================================== */
/* Speech recognition (Whisper)                                               */
/* ========================================================================== */
/*
 * The pipeline follows OpenAI's reference implementation:
 *
 *   audio → 16 kHz mono (host ffmpeg) → 30 s windows → 80-bin log-mel
 *   → encoder → greedy decoding with timestamp rules → segments.
 *
 * The decoder is the merged export: the first step computes the cross-attention
 * cache from the encoder output, later steps reuse it. Every cache tensor stays
 * inside the ONNX runtime as a kept handle; only the logits cross over.
 */

const WHISPER_RATE = 16000
const WHISPER_WINDOW = 30 * WHISPER_RATE
const WHISPER_FRAMES = 3000
const N_FFT = 400
const HOP = 160
const N_MELS = 80
const T = {
  eot: 50257, sot: 50258, firstLanguage: 50259, lastLanguage: 50357, translate: 50358, transcribe: 50359,
  sotLm: 50360, sotPrev: 50361, noSpeech: 50362, noTimestamps: 50363, timestampBegin: 50364,
}
const VOCAB_SIZE = 51865
/** Timestamp tokens are 20 ms apart; audio frames of the encoder are too. */
const SECONDS_PER_TIMESTAMP = 0.02
const MAX_TOKENS_PER_WINDOW = 224
const MAX_INITIAL_TIMESTAMP = 50
/** From the model's generation config: tokens that are never sampled (symbols that confuse subtitles). */
const WHISPER_SUPPRESS = [1, 2, 7, 8, 9, 10, 14, 25, 26, 27, 28, 29, 31, 58, 59, 60, 61, 62, 63, 90, 91, 92, 93, 359, 503, 522, 542, 873, 893, 902, 918, 922, 931, 1350, 1853, 1982, 2460, 2627, 3246, 3253, 3268, 3536, 3846, 3961, 4183, 4667, 6585, 6647, 7273, 9061, 9383, 10428, 10929, 11938, 12033, 12331, 12562, 13793, 14157, 14635, 15265, 15618, 16553, 16604, 18362, 18956, 20075, 21675, 22520, 26130, 26161, 26435, 28279, 29464, 31650, 32302, 32470, 36865, 42863, 47425, 49870, 50254, 50258, 50358, 50359, 50360, 50361, 50362, 50363]

async function decodePcm(input) {
  // Video-only files have nothing to transcribe; report them instead of failing inside FFmpeg.
  if (!(await host.ffmpeg.probe(input.id)).audioCodec) return new Float32Array(0)
  const result = await host.ffmpeg.run({
    args: ['-i', '$in0', '-vn', '-ac', '1', '-ar', String(WHISPER_RATE), '-f', 'f32le', '-c:a', 'pcm_f32le', '-y', '$out0'],
    inputs: [input.id], outputs: ['speech.f32'], label: `提取音频 ${input.name}`,
  })
  const file = result.files[0]
  try {
    const bytes = await host.fs.readAll(file.id)
    return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4))
  } finally {
    await host.fs.remove(file.id).catch(() => {})
  }
}

/** Slaney-style mel filter bank as librosa builds it (htk=false, norm='slaney'), [N_MELS × (N_FFT/2+1)]. */
function melFilterBank() {
  const bins = N_FFT / 2 + 1
  const toMel = (f) => (f < 1000 ? f / (200 / 3) : 15 + Math.log(f / 1000) / (Math.log(6.4) / 27))
  const toHz = (m) => (m < 15 ? m * (200 / 3) : 1000 * Math.exp((Math.log(6.4) / 27) * (m - 15)))
  const top = toMel(WHISPER_RATE / 2)
  const points = Array.from({ length: N_MELS + 2 }, (_, i) => toHz((top * i) / (N_MELS + 1)))
  const filters = new Float32Array(N_MELS * bins)
  for (let m = 0; m < N_MELS; m++) {
    const enorm = 2 / (points[m + 2] - points[m])
    for (let k = 0; k < bins; k++) {
      const f = (k * WHISPER_RATE) / N_FFT
      const lower = (f - points[m]) / (points[m + 1] - points[m])
      const upper = (points[m + 2] - f) / (points[m + 2] - points[m + 1])
      filters[m * bins + k] = Math.max(0, Math.min(lower, upper)) * enorm
    }
  }
  return filters
}

let melCache = null

/** 30 s of samples (zero-padded) → Whisper's normalised log-mel features [80 × 3000]. */
function logMel(samples) {
  if (!melCache) {
    const window = new Float32Array(N_FFT)
    for (let n = 0; n < N_FFT; n++) window[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT)
    const bins = N_FFT / 2 + 1
    const cos = new Float32Array(bins * N_FFT)
    const sin = new Float32Array(bins * N_FFT)
    for (let k = 0; k < bins; k++) {
      for (let n = 0; n < N_FFT; n++) {
        cos[k * N_FFT + n] = Math.cos((2 * Math.PI * k * n) / N_FFT)
        sin[k * N_FFT + n] = Math.sin((2 * Math.PI * k * n) / N_FFT)
      }
    }
    melCache = { window, cos, sin, filters: melFilterBank() }
  }
  const { window, cos, sin, filters } = melCache
  const bins = N_FFT / 2 + 1
  const audio = new Float32Array(WHISPER_WINDOW)
  audio.set(samples.subarray(0, WHISPER_WINDOW))
  // centre=True with reflect padding, as torch.stft does.
  const pad = N_FFT / 2
  const at = (i) => (i < 0 ? audio[-i] : i >= WHISPER_WINDOW ? audio[2 * (WHISPER_WINDOW - 1) - i] : audio[i])
  const mel = new Float32Array(N_MELS * WHISPER_FRAMES)
  const frame = new Float32Array(N_FFT)
  const power = new Float32Array(bins)
  let max = -Infinity
  for (let t = 0; t < WHISPER_FRAMES; t++) {
    const start = t * HOP - pad
    for (let n = 0; n < N_FFT; n++) frame[n] = at(start + n) * window[n]
    for (let k = 0; k < bins; k++) {
      let re = 0
      let im = 0
      const row = k * N_FFT
      for (let n = 0; n < N_FFT; n++) {
        re += frame[n] * cos[row + n]
        im -= frame[n] * sin[row + n]
      }
      power[k] = re * re + im * im
    }
    for (let m = 0; m < N_MELS; m++) {
      let sum = 0
      const row = m * bins
      for (let k = 0; k < bins; k++) sum += filters[row + k] * power[k]
      const value = Math.log10(Math.max(sum, 1e-10))
      mel[m * WHISPER_FRAMES + t] = value
      if (value > max) max = value
    }
  }
  for (let i = 0; i < mel.length; i++) mel[i] = (Math.max(mel[i], max - 8) + 4) / 4
  return mel
}

/** GPT-2 byte-level BPE, decode direction only. */
function whisperTokenizer(tokens) {
  const byteOf = new Map()
  const printable = []
  for (let b = 33; b <= 126; b++) printable.push(b)
  for (let b = 161; b <= 172; b++) printable.push(b)
  for (let b = 174; b <= 255; b++) printable.push(b)
  let extra = 0
  for (let b = 0; b < 256; b++) byteOf.set(String.fromCharCode(printable.includes(b) ? b : 256 + extra++), b)
  const languages = new Map()
  for (let id = T.firstLanguage; id <= T.lastLanguage; id++) languages.set(tokens[id].slice(2, -2), id)
  return {
    languages,
    languageOf: (id) => tokens[id].slice(2, -2),
    decode(ids) {
      const bytes = []
      for (const id of ids) {
        if (id >= T.eot) continue
        for (const char of tokens[id]) bytes.push(byteOf.get(char) ?? 63)
      }
      return new TextDecoder().decode(new Uint8Array(bytes))
    },
  }
}

/**
 * Transcribes mono 16 kHz samples. Returns `{ language, segments: [{ start, end, text }] }`
 * with times in seconds.
 */
async function transcribePcm(ctx, models, pcm, { language, task, onProgress = () => {} }) {
  const { tokenizer } = models
  const segments = []
  let seek = 0
  let detected = language !== 'auto' && tokenizer.languages.has(language) ? language : null
  const total = pcm.length

  while (seek < total) {
    ctx.throwIfAborted()
    const offset = seek / WHISPER_RATE
    onProgress(seek / total, `识别 ${formatClock(offset)} / ${formatClock(total / WHISPER_RATE)}`)
    const window = pcm.subarray(seek, Math.min(total, seek + WHISPER_WINDOW))
    const windowSeconds = window.length / WHISPER_RATE
    const features = logMel(window)
    const encoded = await host.onnx.run(models.encoder, { input_features: { type: 'float32', dims: [1, N_MELS, WHISPER_FRAMES], data: features } }, { keep: ['last_hidden_state'] })
    const hidden = encoded.last_hidden_state
    let result
    try {
      if (!detected) detected = await detectLanguage(models, hidden)
      const prompt = [T.sot, tokenizer.languages.get(detected), task === 'translate' ? T.translate : T.transcribe]
      result = await decodeWindow(ctx, models, hidden, prompt)
    } finally {
      await host.onnx.dispose([hidden.tensor])
    }

    const { tokens, noSpeech, avgLogprob } = result
    // Silence: Whisper's own heuristic, a confident no-speech token and a weak transcript.
    if (noSpeech > 0.6 && avgLogprob < -1) {
      seek += window.length
      continue
    }
    const { windowSegments, advance } = segmentTokens(tokens, windowSeconds)
    for (const segment of windowSegments) {
      const text = tokenizer.decode(segment.tokens).trim()
      if (!text) continue
      segments.push({ start: offset + segment.start, end: offset + Math.min(segment.end, windowSeconds), text })
    }
    // Always move forward, even if the model emitted a timestamp at 0.
    seek += Math.max(HOP * 2 * 10, Math.min(window.length, Math.round(advance * WHISPER_RATE)))
  }
  onProgress(1, '识别完成')
  return { language: detected, segments }
}

async function detectLanguage(models, hidden) {
  const out = await decoderStep(models, hidden, [T.sot], null)
  await host.onnx.dispose(out.kept)
  const logits = out.logits
  let best = T.firstLanguage
  for (let id = T.firstLanguage; id <= T.lastLanguage; id++) if (logits[id] > logits[best]) best = id
  return models.tokenizer.languageOf(best)
}

/**
 * One decoder call. With `cache === null` the prompt is processed from scratch
 * (the cross-attention cache is computed); otherwise only the newest token is
 * fed with the kept self- and cross-attention caches. Returns the last
 * position's logits and the new cache handles.
 */
async function decoderStep(models, hidden, ids, cache) {
  const { decoder, layers } = models
  const feeds = {
    input_ids: { type: 'int64', dims: [1, ids.length], data: BigInt64Array.from(ids, (id) => BigInt(id)) },
    encoder_hidden_states: { tensor: hidden.tensor },
    use_cache_branch: { type: 'bool', dims: [1], data: new Uint8Array([cache ? 1 : 0]) },
  }
  const keep = []
  for (let layer = 0; layer < layers; layer++) {
    for (const part of ['decoder', 'encoder']) {
      for (const kind of ['key', 'value']) {
        const name = `past_key_values.${layer}.${part}.${kind}`
        feeds[name] = cache ? { tensor: cache[name] } : { type: 'float32', dims: [1, hidden.dims[2] / 64, 0, 64], data: new Float32Array(0) }
        // The cross-attention cache only comes out of the first call; later ones reuse it.
        if (part === 'decoder' || !cache) keep.push(`present.${layer}.${part}.${kind}`)
      }
    }
  }
  const out = await host.onnx.run(decoder, feeds, { keep, outputs: ['logits', ...keep] })
  const next = {}
  for (let layer = 0; layer < layers; layer++) {
    for (const part of ['decoder', 'encoder']) {
      for (const kind of ['key', 'value']) {
        const present = out[`present.${layer}.${part}.${kind}`]
        next[`past_key_values.${layer}.${part}.${kind}`] = present ? present.tensor : cache[`past_key_values.${layer}.${part}.${kind}`]
      }
    }
  }
  const [, length, vocab] = out.logits.dims
  return {
    logits: out.logits.data.subarray((length - 1) * vocab, length * vocab),
    firstLogits: out.logits.data.subarray(0, vocab),
    cache: next,
    kept: keep.map((name) => out[name].tensor),
  }
}

/** Greedy decoding of one window. `tokens` excludes the prompt and the end token. */
async function decodeWindow(ctx, models, hidden, prompt) {
  let step = await decoderStep(models, hidden, prompt, null)
  const crossCache = step.kept.filter((_, i) => i % 4 >= 2)
  let selfCache = step.kept.filter((_, i) => i % 4 < 2)
  const noSpeech = softmaxAt(step.firstLogits, T.noSpeech)
  const tokens = []
  let logprobSum = 0
  try {
    while (tokens.length < MAX_TOKENS_PER_WINDOW) {
      ctx.throwIfAborted()
      const logits = Float32Array.from(step.logits)
      applyTimestampRules(logits, tokens)
      const { token, logprob } = pickToken(logits)
      if (token === T.eot) break
      tokens.push(token)
      logprobSum += logprob
      if (isRepeating(tokens)) break
      const previous = selfCache
      step = await decoderStep(models, hidden, [token], step.cache)
      selfCache = step.kept
      await host.onnx.dispose(previous)
    }
  } finally {
    await host.onnx.dispose([...selfCache, ...crossCache])
  }
  return { tokens, noSpeech, avgLogprob: tokens.length ? logprobSum / tokens.length : 0 }
}

/** OpenAI's SuppressTokens, SuppressBlank and ApplyTimestampRules, in place. */
function applyTimestampRules(logits, tokens) {
  for (const id of WHISPER_SUPPRESS) logits[id] = -Infinity
  if (tokens.length === 0) {
    logits[220] = -Infinity
    logits[T.eot] = -Infinity
  }
  const isTimestamp = (id) => id >= T.timestampBegin
  const last = tokens.length >= 1 && isTimestamp(tokens[tokens.length - 1])
  const penultimate = tokens.length < 2 || isTimestamp(tokens[tokens.length - 2])
  if (last) {
    // Timestamps come in pairs, except directly before the end.
    if (penultimate) logits.fill(-Infinity, T.timestampBegin)
    else logits.fill(-Infinity, 0, T.eot)
  }
  const stamps = tokens.filter(isTimestamp)
  if (stamps.length) {
    // Time never goes backwards; after a completed pair it must move forward.
    const floor = last && !penultimate ? stamps[stamps.length - 1] : stamps[stamps.length - 1] + 1
    logits.fill(-Infinity, T.timestampBegin, floor)
  }
  if (tokens.length === 0) {
    logits.fill(-Infinity, 0, T.timestampBegin)
    logits.fill(-Infinity, T.timestampBegin + MAX_INITIAL_TIMESTAMP + 1)
  }
  // If all timestamps together are likelier than any single text token, take a timestamp.
  const logprobs = logSoftmax(logits)
  let timestampMass = -Infinity
  let maxText = -Infinity
  for (let i = 0; i < logprobs.length; i++) {
    if (i >= T.timestampBegin) timestampMass = logAddExp(timestampMass, logprobs[i])
    else if (logprobs[i] > maxText) maxText = logprobs[i]
  }
  if (timestampMass > maxText) logits.fill(-Infinity, 0, T.timestampBegin)
}

function logSoftmax(logits) {
  let max = -Infinity
  for (const v of logits) if (v > max) max = v
  let sum = 0
  for (const v of logits) if (v !== -Infinity) sum += Math.exp(v - max)
  const norm = max + Math.log(sum)
  return logits.map((v) => v - norm)
}

function logAddExp(a, b) {
  if (a === -Infinity) return b
  if (b === -Infinity) return a
  const hi = Math.max(a, b)
  return hi + Math.log(Math.exp(a - hi) + Math.exp(b - hi))
}

function softmaxAt(logits, index) {
  return Math.exp(logSoftmax(Float32Array.from(logits))[index])
}

function pickToken(logits) {
  let token = 0
  for (let i = 1; i < logits.length; i++) if (logits[i] > logits[token]) token = i
  return { token, logprob: logSoftmax(logits)[token] }
}

/** Greedy decoding can loop on a phrase; stop when the tail repeats itself four times. */
function isRepeating(tokens) {
  for (let size = 1; size <= 12; size++) {
    if (tokens.length < size * 4) break
    const tail = tokens.slice(-size)
    let repeats = 1
    for (let k = 2; k <= 4; k++) {
      const chunk = tokens.slice(-size * k, -size * (k - 1))
      if (chunk.every((t, i) => t === tail[i])) repeats++
      else break
    }
    if (repeats === 4 && tail.some((t) => t < T.eot)) return true
  }
  return false
}

/**
 * Tokens of one window → timed segments, and how far to advance, as the
 * reference `transcribe()` does: complete `<|a|> text <|b|>` pairs become
 * segments; an unfinished last sentence is re-decoded in the next window.
 */
function segmentTokens(tokens, windowSeconds) {
  const isTimestamp = (id) => id >= T.timestampBegin
  const time = (id) => (id - T.timestampBegin) * SECONDS_PER_TIMESTAMP
  const singleEnding = tokens.length >= 2 && !isTimestamp(tokens[tokens.length - 2]) && isTimestamp(tokens[tokens.length - 1])
  const boundaries = []
  for (let i = 1; i < tokens.length; i++) if (isTimestamp(tokens[i - 1]) && isTimestamp(tokens[i])) boundaries.push(i)
  if (boundaries.length === 0) {
    const stamps = tokens.filter(isTimestamp)
    const start = tokens.length && isTimestamp(tokens[0]) ? time(tokens[0]) : 0
    // An unclosed run (the window ran out of tokens) lasts to the window's end.
    const last = stamps.length ? time(stamps[stamps.length - 1]) : 0
    const end = last > start ? last : windowSeconds
    return { windowSegments: [{ start, end, tokens: tokens.filter((t) => !isTimestamp(t)) }], advance: windowSeconds }
  }
  if (singleEnding) boundaries.push(tokens.length)
  const windowSegments = []
  let from = 0
  for (const to of boundaries) {
    const slice = tokens.slice(from, to)
    if (slice.length >= 2 && isTimestamp(slice[0]) && isTimestamp(slice[slice.length - 1])) {
      windowSegments.push({ start: time(slice[0]), end: time(slice[slice.length - 1]), tokens: slice.filter((t) => !isTimestamp(t)) })
    }
    from = to
  }
  const advance = singleEnding ? windowSeconds : time(tokens[boundaries[boundaries.length - 1] - 1])
  return { windowSegments, advance }
}

/** Long segments → cues of at most `maxChars`, split at punctuation, times shared out by length. */
function splitCues(segments, maxChars) {
  const cues = []
  for (const segment of segments) {
    const pieces = []
    let rest = segment.text
    while (rest.length > maxChars) {
      const window = rest.slice(0, maxChars + 1)
      let cut = Math.max(...['。', '！', '？', '，', '、', '；', '. ', '! ', '? ', ', ', '; '].map((mark) => window.lastIndexOf(mark) + mark.trimEnd().length))
      if (cut < maxChars * 0.4) cut = window.lastIndexOf(' ') > maxChars * 0.4 ? window.lastIndexOf(' ') : maxChars
      pieces.push(rest.slice(0, cut).trim())
      rest = rest.slice(cut).trim()
    }
    if (rest) pieces.push(rest)
    const chars = pieces.reduce((n, piece) => n + piece.length, 0) || 1
    let at = segment.start
    for (const piece of pieces) {
      const duration = ((segment.end - segment.start) * piece.length) / chars
      cues.push({ start: at, end: at + duration, text: piece })
      at += duration
    }
  }
  return cues
}

function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function cueTime(seconds, separator) {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`
}

function toSrt(cues) {
  return cues.map((cue, i) => `${i + 1}\n${cueTime(cue.start, ',')} --> ${cueTime(cue.end, ',')}\n${cue.text}\n`).join('\n')
}

function toVtt(cues) {
  return `WEBVTT\n\n${cues.map((cue) => `${cueTime(cue.start, '.')} --> ${cueTime(cue.end, '.')}\n${cue.text}\n`).join('\n')}`
}

function toTranscript(segments) {
  return `${segments.map((segment) => `[${formatClock(segment.start)}] ${segment.text}`).join('\n')}\n`
}

/* ========================================================================== */
/* Red eye and smart crop                                                     */
/* ========================================================================== */

/**
 * Corrects flash red-eye in an RGBA patch around one eye, in place. Returns the
 * number of pixels changed (0 when the eye is not red).
 *
 * Skin around the eye can be reddish too, so a pixel alone proves nothing.
 * Candidates must be strongly red against *both* green and blue, and only the
 * connected red blob covering the pupil centre is corrected - and only if it
 * is pupil-sized, not a whole reddish region. Correction takes red down to the
 * other channels' level with a soft edge.
 */
function fixRedEye(data, width, height, cx, cy, radius, sensitivity) {
  const factor = 2.1 - sensitivity * 0.06
  // Flash red-eye is bright and saturated; dark reddish shadows have high ratios but a small margin.
  const margin = 75 - sensitivity * 3
  const isRed = (i) => {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    return r > 140 && r - Math.max(g, b) > margin && r > g * factor && r > b * (factor - 0.3)
  }
  const inCircle = (x, y) => Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= radius
  // Seed from red pixels near the pupil centre.
  const seen = new Uint8Array(width * height)
  const stack = []
  const core = radius * 0.45
  for (let y = Math.max(0, Math.floor(cy - core)); y <= Math.min(height - 1, Math.ceil(cy + core)); y++) {
    for (let x = Math.max(0, Math.floor(cx - core)); x <= Math.min(width - 1, Math.ceil(cx + core)); x++) {
      const p = y * width + x
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= core && isRed(p * 4) && !seen[p]) {
        seen[p] = 1
        stack.push(p)
      }
    }
  }
  const blob = []
  while (stack.length) {
    const p = stack.pop()
    blob.push(p)
    const x = p % width
    const y = (p - x) / width
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height || !inCircle(nx, ny)) continue
      const q = ny * width + nx
      if (seen[q] || !isRed(q * 4)) continue
      seen[q] = 1
      stack.push(q)
    }
  }
  const circleArea = Math.PI * radius * radius
  // Too small is a speck; filling most of the circle means red skin or a red frame, not a pupil.
  if (blob.length < Math.max(6, circleArea * 0.03) || blob.length > circleArea * 0.6) return 0
  for (const p of blob) {
    const i = p * 4
    const others = (data[i + 1] + data[i + 2]) / 2
    // Neighbours outside the blob soften the edge.
    const x = p % width
    const y = (p - x) / width
    let inside = 0
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) if (nx >= 0 && ny >= 0 && nx < width && ny < height && seen[ny * width + nx]) inside++
    const weight = 0.6 + inside * 0.1
    data[i] = Math.round(data[i] + (others - data[i]) * weight)
  }
  return blob.length
}

/**
 * The crop of `ratio` (w/h) for a `width × height` image that best frames the
 * salient region of a `size²` saliency map (0-255).
 *
 *   largest  the biggest crop of that ratio, slid to hold the most saliency;
 *   subject  the saliency bounding box plus `padding`, grown to the ratio.
 */
function bestCrop(saliency, size, width, height, ratio, { fit = 'largest', padding = 0.15 } = {}) {
  // Saliency mass per image column and row, resampled to image pixels.
  const sx = size / width
  const sy = size / height
  let minX = size, minY = size, maxX = -1, maxY = -1
  let total = 0, cxSum = 0, cySum = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = saliency[y * size + x]
      if (v < 128) continue
      total += v
      cxSum += v * x
      cySum += v * y
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  const clampCrop = (w, h, centreX, centreY) => {
    w = Math.max(1, Math.min(width, Math.round(w)))
    h = Math.max(1, Math.min(height, Math.round(h)))
    const x = Math.round(Math.min(width - w, Math.max(0, centreX - w / 2)))
    const y = Math.round(Math.min(height - h, Math.max(0, centreY - h / 2)))
    return { x, y, w, h }
  }
  const largest = () => (width / height > ratio ? [height * ratio, height] : [width, width / ratio])
  if (total === 0) {
    const [w, h] = largest()
    return clampCrop(w, h, width / 2, height / 2)
  }
  const centreX = (cxSum / total + 0.5) / sx
  const centreY = (cySum / total + 0.5) / sy

  if (fit === 'subject') {
    const bw = ((maxX - minX + 1) / sx) * (1 + padding * 2)
    const bh = ((maxY - minY + 1) / sy) * (1 + padding * 2)
    let w = Math.max(bw, bh * ratio)
    let h = w / ratio
    const [lw, lh] = largest()
    if (w > lw) [w, h] = [lw, lh]
    const bx = ((minX + maxX + 1) / 2) / sx
    const by = ((minY + maxY + 1) / 2) / sy
    return clampCrop(w, h, bx, by)
  }
  const [w, h] = largest()
  return clampCrop(w, h, centreX, centreY)
}

/* ========================================================================== */
/* Searchable PDF                                                             */
/* ========================================================================== */

/**
 * A PDF builder for OCR output: each page is the scanned image, with every
 * recognised line drawn over it as fully transparent text. Viewers can then
 * search and select the text while showing the original pixels.
 */
async function searchablePdf() {
  const { exports: PDFLib } = await loadDependency('pdf-lib')
  const { exports: fontkitModule } = await loadDependency('fontkit')
  const { exports: fonts, assets } = await loadDependency('cjk-font')
  const fontName = 'NotoSansSC-Regular.ttf'
  if (!fonts[fontName]?.available || !assets[fontName] || assets[fontName].byteLength < 1024) {
    throw new Error('内置中文字体未打包（构建时需要联网运行一次 pnpm vendor），无法生成可搜索 PDF')
  }
  const doc = await PDFLib.PDFDocument.create()
  doc.registerFontkit(fontkitModule.default ?? fontkitModule)
  const font = await doc.embedFont(new Uint8Array(assets[fontName]), { subset: true })

  return {
    async addPage(bitmap, lines, pointsPerPixel) {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const g = canvas.getContext('2d')
      g.fillStyle = '#ffffff'
      g.fillRect(0, 0, canvas.width, canvas.height)
      g.drawImage(bitmap, 0, 0)
      const jpeg = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })).arrayBuffer())
      const width = bitmap.width * pointsPerPixel
      const height = bitmap.height * pointsPerPixel
      const page = doc.addPage([width, height])
      page.drawImage(await doc.embedJpg(jpeg), { x: 0, y: 0, width, height })
      for (const line of lines) placeHiddenLine(page, font, line, pointsPerPixel, height, PDFLib)
    },
    save: () => doc.save(),
  }
}

/** Sizes a line so it spans its box, then draws it invisible (opacity 0) at the box's baseline. */
function placeHiddenLine(page, font, line, s, pageHeight, PDFLib) {
  const text = line.text.replace(/\s+/g, ' ').trim()
  if (!text) return
  const [x, y, w, h] = line.box
  const along = (line.vertical ? h : w) * s
  const across = (line.vertical ? w : h) * s
  const unitWidth = font.widthOfTextAtSize(text, 1) || 1
  const size = Math.max(1, Math.min(across * 0.9, along / unitWidth))
  if (line.vertical) {
    page.drawText(text, { x: (x + w / 2) * s - size * 0.35, y: pageHeight - y * s, size, font, opacity: 0, rotate: PDFLib.degrees(-90) })
  } else {
    page.drawText(text, { x: x * s, y: pageHeight - (y + h * 0.8) * s, size, font, opacity: 0 })
  }
}
