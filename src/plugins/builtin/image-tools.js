/* eslint-disable */
/**
 * Built-in plugin: image toolbox.
 *
 * Every tool here runs the pixel work *inside* the sandbox - on OffscreenCanvas,
 * or on ImageMagick compiled to WebAssembly - so the host only ever moves bytes. That is the case this plugin exists to
 * prove: a sandboxed plugin can do real CPU work off the UI thread without the
 * host implementing the operation for it.
 *
 * Scope note: the reference toolboxes (SnapOtter in particular) publish dozens of
 * "JPG to PNG", "PNG to WebP" routes. Those are one operation with a preset, not
 * dozens of operations, so they live here as a format parameter on `convert`
 * rather than as separate tools. See docs/design/03-tool-matrix.md.
 */
definePlugin({
  id: 'omnitool.image',
  name: '图片工具箱',
  version: '3.0.0',
  author: 'OmniTool',
  description: '压缩、转换、缩放、裁剪、水印、调色、拼接、切图、动图与元数据——Canvas 与 ImageMagick 双引擎，全部在本地完成。',
  icon: 'image',
  capabilities: ['fs', 'ui', 'image'],
  deps: [
    { id: 'pdf-lib', url: '/vendor/pdf-lib.js', global: 'PDFLib' },
    // Loaded on first use only: most runs never leave the canvas engine.
    { id: 'magick', url: '/vendor/magick/magick.js', global: 'MagickWasm', lazy: true, assets: { 'magick.wasm': { url: '/vendor/magick/magick.wasm' } } },
    { id: 'zxing', url: '/vendor/zxing/zxing.js', global: 'ZXingWASM', lazy: true, assets: { 'zxing_full.wasm': { url: '/vendor/zxing/zxing_full.wasm' } } },
    { id: 'imagetracer', url: '/vendor/imagetracer.js', global: 'ImageTracer', lazy: true },
    // Consistent CJK text on canvas (captions, watermarks), whatever fonts the OS has.
    { id: 'cjk-font', url: '/vendor/fonts/fonts.js', global: 'OMNITOOL_FONTS', lazy: true, assets: { 'NotoSansSC-Regular.ttf': { url: '/vendor/fonts/NotoSansSC-Regular.ttf' } } },
  ],

  tools: [
    /* ------------------------------------------------------------------ */
    {
      id: 'convert',
      name: '批量压缩 / 格式转换',
      category: 'image',
      icon: 'image-down',
      description: '在 PNG / JPG / WebP / AVIF 之间互转，并按质量与尺寸上限重新编码。',
      accept: IMAGE_ACCEPT(),
      multiple: true,
      keywords: ['compress', 'convert', '压缩', '转换', 'webp', 'avif', 'png', 'jpg', 'jpeg'],
      params: [
        {
          key: 'format', type: 'select', label: '输出格式', default: 'image/webp',
          options: [
            { value: 'image/webp', label: 'WebP（体积最优，兼容性好）' },
            { value: 'image/jpeg', label: 'JPEG（无透明通道）' },
            { value: 'image/png', label: 'PNG（无损，体积大）' },
            { value: 'image/avif', label: 'AVIF（体积最小，编码较慢）' },
            { value: 'image/gif', label: 'GIF（动图）' },
            { value: 'image/tiff', label: 'TIFF' },
            { value: 'image/jxl', label: 'JPEG XL' },
            { value: 'keep', label: '保持原格式' },
          ],
        },
        { key: 'quality', type: 'slider', label: '质量', min: 1, max: 100, step: 1, default: 80, suffix: '%', hint: 'PNG 为无损格式，该项对其无效。' },
        { key: 'maxWidth', type: 'number', label: '最大宽度', default: 0, min: 0, step: 10, suffix: 'px', hint: '0 表示不限制。等比缩放，不会裁剪。' },
        { key: 'maxHeight', type: 'number', label: '最大高度', default: 0, min: 0, step: 10, suffix: 'px', hint: '0 表示不限制。' },
        { key: 'background', type: 'text', label: '透明区域填充色', default: '#ffffff', hint: '仅在输出 JPEG 时生效。', when: { key: 'format', equals: 'image/jpeg' } },
        { key: 'skipLarger', type: 'switch', label: '结果变大时保留原图', default: true, hint: '重新编码后体积反而增加时，输出原始文件。' },
        METADATA_PARAM(),
      ],

      async run(ctx) {
        const outputs = []
        let before = 0
        let after = 0
        let skipped = 0

        await eachInput(ctx, async (input, bytes) => {
          const p = ctx.params
          const targetType = resolveTarget(p.format, input)
          const quality = Number(p.quality) / 100
          const maxWidth = Number(p.maxWidth) || 0
          const maxHeight = Number(p.maxHeight) || 0
          let encoded

          if (await needsMagick(bytes, input, targetType, p.keepMetadata)) {
            const ops = maxWidth || maxHeight
              ? [{ resize: { width: maxWidth || 1e6, height: maxHeight || 1e6, mode: 'fit', noUpscale: true } }]
              : []
            encoded = await magickPipeline(bytes, { ops, type: targetType, quality, keepMetadata: !!p.keepMetadata, background: String(p.background || '#ffffff') })
          } else {
            await noteFirstFrame(ctx, input, bytes)
            const bitmap = await decode(bytes, typeOf(input))
            const size = fit(bitmap.width, bitmap.height, maxWidth, maxHeight)
            const canvas = draw(bitmap, size.width, size.height, {
              background: targetType === 'image/jpeg' ? String(p.background || '#ffffff') : null,
            })
            bitmap.close()
            encoded = await encode(canvas, targetType, quality)
          }

          before += input.size
          if (p.skipLarger && encoded.byteLength >= input.size && targetType === typeOf(input)) {
            skipped++
            after += input.size
            outputs.push((await host.fs.writeAll(input.name, bytes, input.type)).id)
            return
          }
          after += encoded.byteLength
          outputs.push((await host.fs.writeAll(rename(input.name, targetType), encoded, targetType)).id)
        })

        let summary = `${ctx.inputs.length} 张图片：${bytesLabel(before)} → ${bytesLabel(after)}（${deltaLabel(before, after)}）`
        if (skipped > 0) summary += `，其中 ${skipped} 张因体积未减小而保留原图`
        return { outputs, summary }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'resize',
      name: '尺寸调整',
      category: 'image',
      icon: 'scaling',
      description: '按像素或百分比缩放，支持留白、裁切与拉伸三种适配方式。',
      accept: IMAGE_ACCEPT(),
      multiple: true,
      keywords: ['resize', 'scale', '缩放', '尺寸', '分辨率'],
      params: [
        {
          key: 'mode', type: 'select', label: '缩放方式', default: 'percent',
          options: [
            { value: 'percent', label: '按百分比' },
            { value: 'fit', label: '适应尺寸（等比，不裁切）' },
            { value: 'cover', label: '填满尺寸（等比，裁切多余）' },
            { value: 'pad', label: '适应尺寸并留白' },
            { value: 'stretch', label: '拉伸到精确尺寸（变形）' },
          ],
        },
        { key: 'percent', type: 'slider', label: '缩放比例', min: 1, max: 400, step: 1, default: 50, suffix: '%', when: { key: 'mode', equals: 'percent' } },
        { key: 'width', type: 'number', label: '宽度', default: 1920, min: 1, suffix: 'px', when: { key: 'mode', equals: ['fit', 'cover', 'pad', 'stretch'] } },
        { key: 'height', type: 'number', label: '高度', default: 1080, min: 1, suffix: 'px', when: { key: 'mode', equals: ['fit', 'cover', 'pad', 'stretch'] } },
        { key: 'padColor', type: 'text', label: '留白颜色', default: '#00000000', hint: '支持 #rrggbb 或 #rrggbbaa。', when: { key: 'mode', equals: 'pad' } },
        { key: 'noUpscale', type: 'switch', label: '不放大小图', default: true, hint: '原图小于目标尺寸时保持原样。' },
        { key: 'format', type: 'select', label: '输出格式', default: 'keep', options: FORMAT_OPTIONS() },
        { key: 'quality', type: 'slider', label: '质量', min: 1, max: 100, default: 90, suffix: '%' },
        METADATA_PARAM(),
      ],

      async run(ctx) {
        const outputs = []
        const p = ctx.params

        await eachInput(ctx, async (input, bytes) => {
          const type = resolveTarget(p.format, input)

          if (await needsMagick(bytes, input, type, p.keepMetadata)) {
            const op = p.mode === 'percent'
              ? { scale: p.noUpscale ? Math.min(1, Number(p.percent) / 100) : Math.max(0.01, Number(p.percent) / 100) }
              : { resize: { width: Math.max(1, Number(p.width) || 1), height: Math.max(1, Number(p.height) || 1), mode: String(p.mode), noUpscale: !!p.noUpscale, pad: String(p.padColor || '#00000000') } }
            const encoded = await magickPipeline(bytes, { ops: [op], type, quality: Number(p.quality) / 100, keepMetadata: !!p.keepMetadata })
            const info = await magickInfo(encoded)
            outputs.push((await host.fs.writeAll(suffixName(input.name, `-${info.width}x${info.height}`, type), encoded, type)).id)
            return
          }

          await noteFirstFrame(ctx, input, bytes)
          const bitmap = await decode(bytes, typeOf(input))
          let canvas

          if (p.mode === 'percent') {
            const ratio = Math.max(0.01, Number(p.percent) / 100)
            const scale = p.noUpscale ? Math.min(1, ratio) : ratio
            canvas = draw(bitmap, Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)))
          } else {
            const targetW = Math.max(1, Number(p.width) || 1)
            const targetH = Math.max(1, Number(p.height) || 1)
            canvas = resizeTo(bitmap, targetW, targetH, String(p.mode), {
              noUpscale: !!p.noUpscale,
              padColor: String(p.padColor || '#00000000'),
            })
          }

          const encoded = await encode(canvas, type, Number(p.quality) / 100)
          outputs.push((await host.fs.writeAll(suffixName(input.name, `-${canvas.width}x${canvas.height}`, type), encoded, type)).id)
        })

        return { outputs, summary: `已调整 ${outputs.length} 张图片的尺寸` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'crop',
      name: '裁剪',
      category: 'image',
      icon: 'crop',
      description: '按矩形区域或固定宽高比裁剪，可选九宫格对齐位置。',
      accept: IMAGE_ACCEPT(),
      multiple: true,
      keywords: ['crop', '裁剪', '剪裁', 'aspect'],
      params: [
        {
          key: 'mode', type: 'select', label: '裁剪方式', default: 'aspect',
          options: [
            { value: 'aspect', label: '按宽高比' },
            { value: 'rect', label: '按精确区域' },
            { value: 'trim', label: '去除纯色边框' },
          ],
        },
        {
          key: 'aspect', type: 'select', label: '宽高比', default: '1:1',
          options: [
            { value: '1:1', label: '1:1 正方形' }, { value: '4:3', label: '4:3' }, { value: '3:4', label: '3:4' },
            { value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }, { value: '3:2', label: '3:2' },
            { value: '2:3', label: '2:3' }, { value: '21:9', label: '21:9' },
          ],
          when: { key: 'mode', equals: 'aspect' },
        },
        {
          key: 'gravity', type: 'select', label: '对齐位置', default: 'center',
          options: [
            { value: 'center', label: '居中' }, { value: 'top', label: '上' }, { value: 'bottom', label: '下' },
            { value: 'left', label: '左' }, { value: 'right', label: '右' },
            { value: 'top-left', label: '左上' }, { value: 'top-right', label: '右上' },
            { value: 'bottom-left', label: '左下' }, { value: 'bottom-right', label: '右下' },
          ],
          when: { key: 'mode', equals: 'aspect' },
        },
        { key: 'x', type: 'number', label: 'X 起点', default: 0, min: 0, suffix: 'px', when: { key: 'mode', equals: 'rect' } },
        { key: 'y', type: 'number', label: 'Y 起点', default: 0, min: 0, suffix: 'px', when: { key: 'mode', equals: 'rect' } },
        { key: 'w', type: 'number', label: '宽度', default: 512, min: 1, suffix: 'px', when: { key: 'mode', equals: 'rect' } },
        { key: 'h', type: 'number', label: '高度', default: 512, min: 1, suffix: 'px', when: { key: 'mode', equals: 'rect' } },
        { key: 'tolerance', type: 'slider', label: '颜色容差', min: 0, max: 60, default: 10, when: { key: 'mode', equals: 'trim' }, hint: '边框颜色与角落像素的最大差异。' },
        { key: 'format', type: 'select', label: '输出格式', default: 'keep', options: FORMAT_OPTIONS() },
        { key: 'quality', type: 'slider', label: '质量', min: 1, max: 100, default: 92, suffix: '%' },
        METADATA_PARAM(),
      ],

      async run(ctx) {
        const outputs = []
        const p = ctx.params

        await eachInput(ctx, async (input, bytes) => {
          // The first frame decides the rectangle - also for animations, whose
          // frames are coalesced to the same full size before cropping.
          const bitmap = await decode(bytes, typeOf(input))
          let rect

          if (p.mode === 'rect') {
            rect = clampRect({ x: Number(p.x) || 0, y: Number(p.y) || 0, w: Number(p.w) || 1, h: Number(p.h) || 1 }, bitmap.width, bitmap.height)
          } else if (p.mode === 'trim') {
            rect = detectTrim(bitmap, Number(p.tolerance) || 0)
          } else {
            const [aw, ah] = String(p.aspect).split(':').map(Number)
            rect = aspectRect(bitmap.width, bitmap.height, aw / ah, String(p.gravity))
          }

          const type = resolveTarget(p.format, input)
          let encoded
          if (await needsMagick(bytes, input, type, p.keepMetadata)) {
            bitmap.close()
            encoded = await magickPipeline(bytes, { ops: [{ crop: rect }], type, quality: Number(p.quality) / 100, keepMetadata: !!p.keepMetadata })
          } else {
            await noteFirstFrame(ctx, input, bytes)
            const canvas = new OffscreenCanvas(rect.w, rect.h)
            canvas.getContext('2d').drawImage(bitmap, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
            bitmap.close()
            encoded = await encode(canvas, type, Number(p.quality) / 100)
          }
          outputs.push((await host.fs.writeAll(suffixName(input.name, '-cropped', type), encoded, type)).id)
        })

        return { outputs, summary: `已裁剪 ${outputs.length} 张图片` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'transform',
      name: '旋转与翻转',
      category: 'image',
      icon: 'flip',
      description: '按 90° 步进旋转，或做水平/垂直镜像。',
      accept: IMAGE_ACCEPT(),
      multiple: true,
      keywords: ['rotate', 'flip', 'mirror', '旋转', '翻转', '镜像'],
      params: [
        {
          key: 'rotate', type: 'select', label: '旋转', default: '0',
          options: [{ value: '0', label: '不旋转' }, { value: '90', label: '顺时针 90°' }, { value: '180', label: '180°' }, { value: '270', label: '逆时针 90°' }],
        },
        { key: 'flipH', type: 'switch', label: '水平翻转', default: false },
        { key: 'flipV', type: 'switch', label: '垂直翻转', default: false },
        { key: 'format', type: 'select', label: '输出格式', default: 'keep', options: FORMAT_OPTIONS() },
        { key: 'quality', type: 'slider', label: '质量', min: 1, max: 100, default: 92, suffix: '%' },
        METADATA_PARAM(),
      ],

      async run(ctx) {
        const outputs = []
        const angle = Number(ctx.params.rotate) || 0

        await eachInput(ctx, async (input, bytes) => {
          const type = resolveTarget(ctx.params.format, input)
          if (await needsMagick(bytes, input, type, ctx.params.keepMetadata)) {
            // Same order as the canvas path below: rotate, then mirror.
            const ops = [{ rotate: angle }, { flipH: !!ctx.params.flipH }, { flipV: !!ctx.params.flipV }]
            const encoded = await magickPipeline(bytes, { ops, type, quality: Number(ctx.params.quality) / 100, keepMetadata: !!ctx.params.keepMetadata })
            outputs.push((await host.fs.writeAll(suffixName(input.name, '-transformed', type), encoded, type)).id)
            return
          }

          await noteFirstFrame(ctx, input, bytes)
          const bitmap = await decode(bytes, typeOf(input))
          const swap = angle === 90 || angle === 270
          const w = swap ? bitmap.height : bitmap.width
          const h = swap ? bitmap.width : bitmap.height

          const canvas = new OffscreenCanvas(w, h)
          const g = canvas.getContext('2d')
          g.translate(w / 2, h / 2)
          g.rotate((angle * Math.PI) / 180)
          g.scale(ctx.params.flipH ? -1 : 1, ctx.params.flipV ? -1 : 1)
          g.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2)
          bitmap.close()

          const encoded = await encode(canvas, type, Number(ctx.params.quality) / 100)
          outputs.push((await host.fs.writeAll(suffixName(input.name, '-transformed', type), encoded, type)).id)
        })

        return { outputs, summary: `已处理 ${outputs.length} 张图片` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'adjust',
      name: '调色与滤镜',
      category: 'image',
      icon: 'sliders',
      description: '亮度、对比度、饱和度、色相、模糊、锐化、像素化与灰度/反色。',
      accept: IMAGE_ACCEPT(),
      multiple: true,
      keywords: ['adjust', 'filter', 'brightness', 'contrast', 'blur', 'grayscale', '调色', '滤镜', '模糊', '灰度'],
      params: [
        { key: 'brightness', type: 'slider', label: '亮度', min: 0, max: 200, default: 100, suffix: '%' },
        { key: 'contrast', type: 'slider', label: '对比度', min: 0, max: 200, default: 100, suffix: '%' },
        { key: 'saturate', type: 'slider', label: '饱和度', min: 0, max: 300, default: 100, suffix: '%' },
        { key: 'hue', type: 'slider', label: '色相旋转', min: 0, max: 360, default: 0, suffix: '°' },
        { key: 'blur', type: 'slider', label: '高斯模糊', min: 0, max: 40, default: 0, suffix: 'px' },
        { key: 'sharpen', type: 'slider', label: '锐化', min: 0, max: 100, default: 0, suffix: '%' },
        { key: 'pixelate', type: 'slider', label: '像素化', min: 0, max: 64, default: 0, suffix: 'px', hint: '0 表示不处理。常用于打码。' },
        {
          key: 'preset', type: 'select', label: '整体效果', default: 'none',
          options: [
            { value: 'none', label: '无' }, { value: 'grayscale', label: '黑白' }, { value: 'sepia', label: '复古棕' },
            { value: 'invert', label: '反色' }, { value: 'protanopia', label: '色盲模拟：红色盲' },
            { value: 'deuteranopia', label: '色盲模拟：绿色盲' }, { value: 'tritanopia', label: '色盲模拟：蓝色盲' },
          ],
        },
        { key: 'format', type: 'select', label: '输出格式', default: 'keep', options: FORMAT_OPTIONS() },
        { key: 'quality', type: 'slider', label: '质量', min: 1, max: 100, default: 92, suffix: '%' },
      ],

      async run(ctx) {
        const outputs = []
        const p = ctx.params

        await eachInput(ctx, async (input, bytes) => {
          await noteFirstFrame(ctx, input, bytes)
          const bitmap = await decode(bytes, typeOf(input))
          let canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
          const g = canvas.getContext('2d')

          // Canvas filters cover the cheap colour work in one GPU-backed pass.
          const filters = []
          if (Number(p.brightness) !== 100) filters.push(`brightness(${Number(p.brightness) / 100})`)
          if (Number(p.contrast) !== 100) filters.push(`contrast(${Number(p.contrast) / 100})`)
          if (Number(p.saturate) !== 100) filters.push(`saturate(${Number(p.saturate) / 100})`)
          if (Number(p.hue) !== 0) filters.push(`hue-rotate(${Number(p.hue)}deg)`)
          if (Number(p.blur) > 0) filters.push(`blur(${Number(p.blur)}px)`)
          if (p.preset === 'grayscale') filters.push('grayscale(1)')
          if (p.preset === 'sepia') filters.push('sepia(1)')
          if (p.preset === 'invert') filters.push('invert(1)')
          if (filters.length) g.filter = filters.join(' ')
          g.drawImage(bitmap, 0, 0)
          g.filter = 'none'
          bitmap.close()

          if (Number(p.pixelate) > 0) canvas = pixelate(canvas, Number(p.pixelate))
          if (Number(p.sharpen) > 0) canvas = convolve(canvas, sharpenKernel(Number(p.sharpen) / 100))
          if (String(p.preset).endsWith('anopia')) canvas = simulateColorBlindness(canvas, String(p.preset))

          const type = resolveTarget(p.format, input)
          const encoded = await encode(canvas, type, Number(p.quality) / 100)
          outputs.push((await host.fs.writeAll(suffixName(input.name, '-adjusted', type), encoded, type)).id)
        })

        return { outputs, summary: `已处理 ${outputs.length} 张图片` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'watermark',
      name: '添加水印',
      category: 'image',
      icon: 'stamp',
      description: '叠加文字或 Logo 图片水印，可设置位置、透明度、角度与平铺。',
      accept: IMAGE_ACCEPT(),
      multiple: true,
      keywords: ['watermark', 'text', 'logo', '水印', '文字', '版权', 'logo水印'],
      params: [
        {
          key: 'mode', type: 'select', label: '水印类型', default: 'text',
          options: [{ value: 'text', label: '文字' }, { value: 'image', label: '图片 Logo（第一个文件作为 Logo）' }],
        },
        { key: 'text', type: 'text', label: '水印文字', default: '© OmniTool', placeholder: '© 你的名字', when: { key: 'mode', equals: 'text' } },
        { key: 'size', type: 'slider', label: '字号', min: 1, max: 20, default: 5, suffix: '%', hint: '相对图片短边的百分比。', when: { key: 'mode', equals: 'text' } },
        { key: 'color', type: 'text', label: '颜色', default: '#ffffff', when: { key: 'mode', equals: 'text' } },
        { key: 'logoSize', type: 'slider', label: 'Logo 宽度', min: 3, max: 60, default: 18, suffix: '%', hint: '相对每张图片的宽度，Logo 保持原比例。', when: { key: 'mode', equals: 'image' } },
        { key: 'opacity', type: 'slider', label: '不透明度', min: 5, max: 100, default: 45, suffix: '%' },
        {
          key: 'position', type: 'select', label: '位置', default: 'bottom-right',
          options: [
            { value: 'bottom-right', label: '右下' }, { value: 'bottom-left', label: '左下' },
            { value: 'top-right', label: '右上' }, { value: 'top-left', label: '左上' },
            { value: 'center', label: '居中' }, { value: 'tile', label: '平铺（防盗图）' },
          ],
        },
        { key: 'rotate', type: 'slider', label: '旋转角度', min: -90, max: 90, default: 0, suffix: '°' },
        { key: 'outline', type: 'switch', label: '描边', default: true, hint: '在浅色背景上保持可读。', when: { key: 'mode', equals: 'text' } },
        { key: 'format', type: 'select', label: '输出格式', default: 'keep', options: FORMAT_OPTIONS() },
        { key: 'quality', type: 'slider', label: '质量', min: 1, max: 100, default: 92, suffix: '%' },
      ],

      async run(ctx) {
        const outputs = []
        const p = ctx.params
        if (p.mode === 'image') return watermarkWithLogo(ctx)
        const text = String(p.text || '').trim()
        if (!text) throw new Error('水印文字不能为空')
        const family = await registerCjkFont()

        await eachInput(ctx, async (input, bytes) => {
          await noteFirstFrame(ctx, input, bytes)
          const bitmap = await decode(bytes, typeOf(input))
          const canvas = draw(bitmap, bitmap.width, bitmap.height)
          const g = canvas.getContext('2d')

          const fontSize = Math.max(8, Math.round((Math.min(canvas.width, canvas.height) * Number(p.size)) / 100))
          g.font = `600 ${fontSize}px ${family}, ui-sans-serif, system-ui, sans-serif`
          g.fillStyle = String(p.color || '#ffffff')
          g.globalAlpha = Number(p.opacity) / 100
          g.strokeStyle = 'rgba(0,0,0,0.55)'
          g.lineWidth = Math.max(1, fontSize / 14)
          g.textBaseline = 'middle'

          const metrics = g.measureText(text)
          const angle = (Number(p.rotate) * Math.PI) / 180

          if (p.position === 'tile') {
            const stepX = metrics.width + fontSize * 2.5
            const stepY = fontSize * 3.5
            g.save()
            g.rotate(angle)
            // Rotating the tiling grid leaves corners uncovered; overscan past
            // the canvas bounds so the pattern reaches every edge.
            const reach = Math.hypot(canvas.width, canvas.height)
            for (let y = -reach; y < reach; y += stepY) {
              for (let x = -reach; x < reach; x += stepX) {
                if (p.outline) g.strokeText(text, x, y)
                g.fillText(text, x, y)
              }
            }
            g.restore()
          } else {
            const pad = fontSize
            const spot = anchor(String(p.position), canvas.width, canvas.height, metrics.width, fontSize, pad)
            g.save()
            g.translate(spot.x, spot.y)
            g.rotate(angle)
            g.textAlign = spot.align
            if (p.outline) g.strokeText(text, 0, 0)
            g.fillText(text, 0, 0)
            g.restore()
          }
          g.globalAlpha = 1
          bitmap.close()

          const type = resolveTarget(p.format, input)
          const encoded = await encode(canvas, type, Number(p.quality) / 100)
          outputs.push((await host.fs.writeAll(suffixName(input.name, '-watermarked', type), encoded, type)).id)
        })

        return { outputs, summary: `已为 ${outputs.length} 张图片添加水印` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'frame',
      name: '边框与圆角',
      category: 'image',
      icon: 'shapes',
      description: '边距、圆角、圆形裁切与投影；渐变背景加窗口装饰，一键美化截图。',
      accept: IMAGE_ACCEPT(),
      multiple: true,
      keywords: ['border', 'frame', 'round', 'circle', 'shadow', 'beautify screenshot', 'mockup', '边框', '圆角', '圆形', '阴影', '截图美化', '窗口'],
      params: [
        { key: 'padding', type: 'slider', label: '边距', min: 0, max: 30, default: 4, suffix: '%', hint: '相对图片短边。' },
        {
          key: 'backdrop', type: 'select', label: '背景样式', default: 'solid',
          options: [
            { value: 'solid', label: '纯色（使用下方背景色）' }, { value: 'ocean', label: '海洋渐变' }, { value: 'sunset', label: '日落渐变' },
            { value: 'mint', label: '薄荷渐变' }, { value: 'violet', label: '紫罗兰渐变' }, { value: 'graphite', label: '石墨深色' },
          ],
        },
        { key: 'background', type: 'text', label: '背景色', default: '#ffffff', hint: '支持 #rrggbb / #rrggbbaa，或 transparent。', when: { key: 'backdrop', equals: 'solid' } },
        { key: 'chrome', type: 'select', label: '窗口装饰', default: 'none', options: [{ value: 'none', label: '无' }, { value: 'mac', label: 'macOS 窗口' }, { value: 'windows', label: 'Windows 窗口' }], hint: '在图片上方加标题栏，截图更像一个应用窗口。' },
        { key: 'radius', type: 'slider', label: '圆角半径', min: 0, max: 50, default: 8, suffix: '%' },
        { key: 'circle', type: 'switch', label: '裁成圆形', default: false, hint: '开启后忽略圆角设置，按短边裁成正圆。' },
        { key: 'shadow', type: 'slider', label: '投影强度', min: 0, max: 100, default: 25, suffix: '%' },
        { key: 'format', type: 'select', label: '输出格式', default: 'image/png', options: FORMAT_OPTIONS() },
        { key: 'quality', type: 'slider', label: '质量', min: 1, max: 100, default: 92, suffix: '%' },
      ],

      async run(ctx) {
        const outputs = []
        const p = ctx.params

        await eachInput(ctx, async (input, bytes) => {
          await noteFirstFrame(ctx, input, bytes)
          const bitmap = await decode(bytes, typeOf(input))
          const chrome = p.chrome === 'mac' || p.chrome === 'windows' ? String(p.chrome) : null
          const barHeight = chrome ? Math.max(20, Math.round(bitmap.width * 0.035)) : 0
          const inner = chrome ? bitmap : p.circle ? roundToCircle(bitmap) : roundCorners(bitmap, Number(p.radius) / 100)

          const pad = Math.round((Math.min(inner.width, inner.height) * Number(p.padding)) / 100)
          const canvas = new OffscreenCanvas(inner.width + pad * 2, inner.height + barHeight + pad * 2)
          const g = canvas.getContext('2d')

          const gradient = BACKDROPS[String(p.backdrop)]
          const background = String(p.background || 'transparent')
          if (gradient) {
            const fill = g.createLinearGradient(0, 0, canvas.width, canvas.height)
            fill.addColorStop(0, gradient[0])
            fill.addColorStop(1, gradient[1])
            g.fillStyle = fill
            g.fillRect(0, 0, canvas.width, canvas.height)
          } else if (background !== 'transparent') {
            g.fillStyle = background
            g.fillRect(0, 0, canvas.width, canvas.height)
          }
          const castShadow = () => {
            if (Number(p.shadow) <= 0) return
            g.shadowColor = `rgba(0,0,0,${(Number(p.shadow) / 100) * 0.5})`
            g.shadowBlur = Math.max(4, pad * 0.9)
            g.shadowOffsetY = Math.max(2, pad * 0.35)
          }

          if (chrome) {
            // One rounded window: title bar and screenshot share the outline and the shadow.
            const radius = Math.round(barHeight * 0.45)
            const windowPath = () => {
              g.beginPath()
              g.roundRect(pad, pad, inner.width, inner.height + barHeight, radius)
            }
            g.save()
            castShadow()
            g.fillStyle = '#e5e7eb'
            windowPath()
            g.fill()
            g.restore()
            g.save()
            windowPath()
            g.clip()
            g.fillStyle = chrome === 'mac' ? '#e5e7eb' : '#f3f4f6'
            g.fillRect(pad, pad, inner.width, barHeight)
            g.drawImage(inner, pad, pad + barHeight)
            g.restore()
            drawWindowControls(g, chrome, pad, pad, inner.width, barHeight)
          } else {
            castShadow()
            g.drawImage(inner, pad, pad)
          }
          bitmap.close()

          const type = String(p.format) === 'keep' ? 'image/png' : String(p.format)
          const encoded = await encode(canvas, type, Number(p.quality) / 100)
          outputs.push((await host.fs.writeAll(suffixName(input.name, '-framed', type), encoded, type)).id)
        })

        return { outputs, summary: `已处理 ${outputs.length} 张图片` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'collage',
      name: '拼图与拼接',
      category: 'image',
      icon: 'layout-grid',
      description: '把多张图片拼成横向长图、纵向长图或网格。',
      accept: IMAGE_ACCEPT(),
      multiple: true,
      minFiles: 2,
      keywords: ['collage', 'grid', 'stitch', 'merge', '拼图', '拼接', '长图', '九宫格'],
      params: [
        {
          key: 'layout', type: 'select', label: '排列方式', default: 'vertical',
          options: [
            { value: 'vertical', label: '纵向长图' }, { value: 'horizontal', label: '横向长图' }, { value: 'grid', label: '网格' },
          ],
        },
        { key: 'columns', type: 'number', label: '每行数量', default: 3, min: 1, max: 12, when: { key: 'layout', equals: 'grid' } },
        { key: 'gap', type: 'number', label: '间距', default: 8, min: 0, suffix: 'px' },
        { key: 'background', type: 'text', label: '背景色', default: '#ffffff' },
        { key: 'cellWidth', type: 'number', label: '单元宽度', default: 0, min: 0, suffix: 'px', hint: '0 表示按第一张图片的宽度对齐。' },
        { key: 'format', type: 'select', label: '输出格式', default: 'image/png', options: FORMAT_OPTIONS() },
        { key: 'quality', type: 'slider', label: '质量', min: 1, max: 100, default: 92, suffix: '%' },
      ],

      async run(ctx) {
        const p = ctx.params
        const gap = Math.max(0, Number(p.gap) || 0)
        const bitmaps = []

        for (let i = 0; i < ctx.inputs.length; i++) {
          ctx.throwIfAborted()
          ctx.progress((i / ctx.inputs.length) * 0.7, `正在读取 ${ctx.inputs[i].name}`)
          const bytes = await host.fs.readAll(ctx.inputs[i].id)
          await noteFirstFrame(ctx, ctx.inputs[i], bytes)
          bitmaps.push(await decode(bytes, typeOf(ctx.inputs[i])))
        }

        const cellW = Number(p.cellWidth) > 0 ? Number(p.cellWidth) : bitmaps[0].width
        // Scale every tile to a common width so rows line up regardless of the
        // sources' original sizes.
        const scaled = bitmaps.map((b) => ({ bitmap: b, w: cellW, h: Math.round((b.height * cellW) / b.width) }))

        const columns = p.layout === 'grid' ? Math.max(1, Number(p.columns) || 3) : p.layout === 'horizontal' ? scaled.length : 1
        const rows = []
        for (let i = 0; i < scaled.length; i += columns) rows.push(scaled.slice(i, i + columns))

        const width = columns * cellW + gap * (columns + 1)
        const rowHeights = rows.map((row) => Math.max(...row.map((cell) => cell.h)))
        const height = rowHeights.reduce((sum, h) => sum + h, 0) + gap * (rows.length + 1)

        ctx.progress(0.8, '正在合成')
        const canvas = new OffscreenCanvas(width, height)
        const g = canvas.getContext('2d')
        g.fillStyle = String(p.background || '#ffffff')
        g.fillRect(0, 0, width, height)

        let y = gap
        for (const [index, row] of rows.entries()) {
          let x = gap
          for (const cell of row) {
            g.drawImage(cell.bitmap, x, y, cell.w, cell.h)
            x += cell.w + gap
          }
          y += rowHeights[index] + gap
        }
        for (const cell of scaled) cell.bitmap.close()

        const type = String(p.format) === 'keep' ? 'image/png' : String(p.format)
        const encoded = await encode(canvas, type, Number(p.quality) / 100)
        const out = await host.fs.writeAll(`collage.${extensionFor(type)}`, encoded, type)
        ctx.progress(1)

        return { outputs: [out.id], summary: `已拼接 ${ctx.inputs.length} 张图片（${width}×${height}）` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'split',
      name: '切图',
      category: 'image',
      icon: 'grid',
      description: '把一张图切成 N×M 个小块，常用于九宫格。',
      accept: IMAGE_ACCEPT(),
      multiple: true,
      keywords: ['split', 'slice', 'tiles', '切图', '九宫格', '切片'],
      params: [
        { key: 'cols', type: 'number', label: '横向切分', default: 3, min: 1, max: 20 },
        { key: 'rows', type: 'number', label: '纵向切分', default: 3, min: 1, max: 20 },
        { key: 'format', type: 'select', label: '输出格式', default: 'keep', options: FORMAT_OPTIONS() },
        { key: 'quality', type: 'slider', label: '质量', min: 1, max: 100, default: 92, suffix: '%' },
      ],

      async run(ctx) {
        const outputs = []
        const cols = Math.max(1, Number(ctx.params.cols) || 1)
        const rows = Math.max(1, Number(ctx.params.rows) || 1)

        await eachInput(ctx, async (input, bytes) => {
          await noteFirstFrame(ctx, input, bytes)
          const bitmap = await decode(bytes, typeOf(input))
          const tileW = Math.floor(bitmap.width / cols)
          const tileH = Math.floor(bitmap.height / rows)
          const type = resolveTarget(ctx.params.format, input)

          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              ctx.throwIfAborted()
              const canvas = new OffscreenCanvas(tileW, tileH)
              canvas.getContext('2d').drawImage(bitmap, c * tileW, r * tileH, tileW, tileH, 0, 0, tileW, tileH)
              const encoded = await encode(canvas, type, Number(ctx.params.quality) / 100)
              const name = suffixName(input.name, `-r${r + 1}c${c + 1}`, type)
              outputs.push((await host.fs.writeAll(name, encoded, type)).id)
            }
          }
          bitmap.close()
        })

        return { outputs, summary: `已切出 ${outputs.length} 个切片（${cols}×${rows}）` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'favicon',
      name: '图标生成',
      category: 'image',
      icon: 'aperture',
      description: '从一张图生成 favicon 与各平台应用图标所需的全套尺寸。',
      accept: IMAGE_ACCEPT(),
      multiple: false,
      keywords: ['favicon', 'icon', 'appicon', '图标', '网站图标'],
      params: [
        { key: 'sizes', type: 'text', label: '尺寸列表', default: '16,32,48,64,128,180,192,256,512', hint: '以逗号分隔的像素值。' },
        { key: 'background', type: 'text', label: '背景色', default: 'transparent', hint: 'transparent 保留透明；iOS 图标建议填纯色。' },
        { key: 'radius', type: 'slider', label: '圆角', min: 0, max: 50, default: 0, suffix: '%' },
      ],

      async run(ctx) {
        const input = ctx.inputs[0]
        const bytes = await host.fs.readAll(input.id)
        await noteFirstFrame(ctx, input, bytes)
        const source = await decode(bytes, typeOf(input))
        const sizes = String(ctx.params.sizes)
          .split(',')
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => Number.isFinite(n) && n > 0 && n <= 2048)
        if (sizes.length === 0) throw new Error('尺寸列表为空或无效')

        const rounded = Number(ctx.params.radius) > 0 ? roundCorners(source, Number(ctx.params.radius) / 100) : source
        const outputs = []

        for (const [index, size] of sizes.entries()) {
          ctx.throwIfAborted()
          ctx.progress(index / sizes.length, `${size}×${size}`)
          const canvas = new OffscreenCanvas(size, size)
          const g = canvas.getContext('2d')
          const background = String(ctx.params.background || 'transparent')
          if (background !== 'transparent') {
            g.fillStyle = background
            g.fillRect(0, 0, size, size)
          }
          g.imageSmoothingQuality = 'high'
          g.drawImage(rounded, 0, 0, size, size)
          const encoded = await encode(canvas, 'image/png', 1)
          outputs.push((await host.fs.writeAll(`icon-${size}x${size}.png`, encoded, 'image/png')).id)
        }
        source.close?.()
        ctx.progress(1)

        return { outputs, summary: `已生成 ${outputs.length} 个尺寸的图标` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'to-pdf',
      name: '图片转 PDF',
      category: 'image',
      icon: 'file-text',
      description: '把多张图片按顺序合成一个 PDF，每张一页。',
      accept: IMAGE_ACCEPT(),
      multiple: true,
      keywords: ['pdf', 'image to pdf', '转 pdf', '图片转pdf'],
      params: [
        { key: 'outputName', type: 'text', label: '输出文件名', default: 'images.pdf' },
        {
          key: 'pageSize', type: 'select', label: '页面尺寸', default: 'auto',
          options: [
            { value: 'auto', label: '跟随图片尺寸' }, { value: 'a4', label: 'A4 纵向' },
            { value: 'a4-landscape', label: 'A4 横向' }, { value: 'letter', label: 'Letter 纵向' },
          ],
        },
        { key: 'margin', type: 'number', label: '页边距', default: 0, min: 0, suffix: 'pt', when: { key: 'pageSize', equals: ['a4', 'a4-landscape', 'letter'] } },
      ],

      async run(ctx) {
        if (typeof PDFLib === 'undefined') throw new Error('依赖 pdf-lib 未注入沙盒，请在插件面板中重载该插件')
        const doc = await PDFLib.PDFDocument.create()
        const PAGES = { a4: [595.28, 841.89], 'a4-landscape': [841.89, 595.28], letter: [612, 792] }

        for (const [index, input] of ctx.inputs.entries()) {
          ctx.throwIfAborted()
          ctx.progress(index / ctx.inputs.length, `正在嵌入 ${input.name}`)

          // pdf-lib embeds only JPEG and PNG, so anything else is re-encoded to
          // PNG first rather than rejected.
          let bytes = await host.fs.readAll(input.id)
          let type = typeOf(input)
          if (type !== 'image/jpeg' && type !== 'image/png') {
            const bitmap = await decode(bytes, type)
            bytes = await encode(draw(bitmap, bitmap.width, bitmap.height), 'image/png', 1)
            type = 'image/png'
          }

          const image = type === 'image/jpeg' ? await doc.embedJpg(bytes) : await doc.embedPng(bytes)
          if (ctx.params.pageSize === 'auto') {
            const page = doc.addPage([image.width, image.height])
            page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height })
          } else {
            const [pw, ph] = PAGES[String(ctx.params.pageSize)] ?? PAGES.a4
            const margin = Math.max(0, Number(ctx.params.margin) || 0)
            const page = doc.addPage([pw, ph])
            const scale = Math.min((pw - margin * 2) / image.width, (ph - margin * 2) / image.height)
            const w = image.width * scale
            const h = image.height * scale
            page.drawImage(image, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h })
          }
        }

        ctx.progress(0.95, '正在写出 PDF')
        const name = /\.pdf$/i.test(String(ctx.params.outputName)) ? String(ctx.params.outputName) : `${ctx.params.outputName}.pdf`
        const out = await host.fs.writeAll(name, await doc.save(), 'application/pdf')
        ctx.progress(1)

        return { outputs: [out.id], summary: `已合成 ${ctx.inputs.length} 页 PDF` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'barcode',
      name: '二维码与条码生成',
      category: 'image',
      icon: 'qr-code',
      description: '把文字或网址生成二维码、Code128、EAN-13、DataMatrix、PDF417 等，输出 PNG 或矢量 SVG；可逐行批量生成。',
      accept: ['.txt', '.csv', 'text/plain'],
      multiple: false,
      input: 'text',
      textFileName: 'content.txt',
      keywords: ['qr', 'qrcode', 'barcode', 'code128', 'ean13', 'datamatrix', 'pdf417', '二维码', '条码', '条形码', '生成'],
      params: [
        {
          key: 'format', type: 'select', label: '码制', default: 'QRCode',
          options: [
            { value: 'QRCode', label: '二维码 QR Code' }, { value: 'Code128', label: 'Code 128（通用条码）' },
            { value: 'EAN13', label: 'EAN-13（商品条码，12 或 13 位数字）' }, { value: 'EAN8', label: 'EAN-8' },
            { value: 'UPCA', label: 'UPC-A' }, { value: 'Code39', label: 'Code 39' },
            { value: 'DataMatrix', label: 'Data Matrix' }, { value: 'PDF417', label: 'PDF417' }, { value: 'Aztec', label: 'Aztec' },
          ],
        },
        { key: 'ecLevel', type: 'select', label: '容错级别', default: 'M', options: [{ value: 'L', label: 'L（7%）' }, { value: 'M', label: 'M（15%）' }, { value: 'Q', label: 'Q（25%）' }, { value: 'H', label: 'H（30%，可覆盖 Logo）' }], when: { key: 'format', equals: 'QRCode' } },
        { key: 'scale', type: 'slider', label: '模块大小', min: 2, max: 20, default: 8, suffix: 'px', hint: '每个黑白格子的像素数；印刷用建议 ≥ 6。' },
        { key: 'output', type: 'select', label: '输出', default: 'png', options: [{ value: 'png', label: 'PNG' }, { value: 'svg', label: 'SVG（矢量，适合印刷）' }] },
        { key: 'perLine', type: 'switch', label: '每行生成一个', default: false, hint: '批量：输入的每一行各生成一个码。' },
      ],

      async run(ctx) {
        const p = ctx.params
        const zxing = await barcodeLibrary()
        const text = (await host.fs.readText(ctx.inputs[0].id)).replace(/^\uFEFF/, '')
        const items = p.perLine ? text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [text.replace(/\r?\n$/, '')]
        if (items.length === 0 || !items[0]) throw new Error('请输入要编码的内容')
        if (items.length > 500) throw new Error('一次最多生成 500 个')

        const outputs = []
        for (const [index, item] of items.entries()) {
          ctx.throwIfAborted()
          ctx.progress(index / items.length, `生成第 ${index + 1} 个`)
          const result = await zxing.writeBarcode(item, {
            format: String(p.format),
            scale: Math.max(1, Math.round(Number(p.scale) || 8)),
            ...(p.format === 'QRCode' ? { ecLevel: String(p.ecLevel) } : {}),
          })
          if (result.error) throw new Error(`无法生成「${item.slice(0, 40)}」：${barcodeError(result.error, String(p.format))}`)
          const base = items.length === 1 ? String(p.format).toLowerCase() : `${String(index + 1).padStart(3, '0')}-${safeFileName(item).slice(0, 40)}`
          if (p.output === 'svg') {
            outputs.push((await host.fs.writeAll(`${base}.svg`, result.svg, 'image/svg+xml')).id)
          } else {
            outputs.push((await host.fs.writeAll(`${base}.png`, new Uint8Array(await result.image.arrayBuffer()), 'image/png')).id)
          }
        }
        ctx.progress(1)
        return { outputs, summary: `已生成 ${outputs.length} 个${p.format === 'QRCode' ? '二维码' : '条码'}` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'barcode-read',
      name: '识别二维码与条码',
      category: 'image',
      icon: 'scan-text',
      description: '从图片或截图中识别二维码、条码（可一次识别多个），输出内容、码制与位置。',
      accept: IMAGE_ACCEPT(),
      multiple: true,
      keywords: ['scan', 'decode', 'qr reader', 'barcode reader', '扫码', '识别二维码', '解码', '条码识别'],
      params: [
        { key: 'tryHarder', type: 'switch', label: '深度识别', default: true, hint: '更慢，但能识别模糊、倾斜、反色的码。' },
        { key: 'output', type: 'select', label: '输出', default: 'text', options: [{ value: 'text', label: '纯文本（每行一个结果）' }, { value: 'json', label: 'JSON（含码制与位置）' }] },
      ],

      async run(ctx) {
        const zxing = await barcodeLibrary()
        const report = []
        await eachInput(ctx, async (input, bytes) => {
          let source = bytes
          // zxing decodes PNG / JPEG / BMP / GIF itself; anything else goes through the engines first.
          if (!/^image\/(png|jpeg|bmp|gif)$/.test(typeOf(input))) {
            const bitmap = await decode(bytes, typeOf(input))
            source = await encode(draw(bitmap, bitmap.width, bitmap.height), 'image/png', 1)
            bitmap.close()
          }
          const found = await zxing.readBarcodes(source, { tryHarder: !!ctx.params.tryHarder, tryInvert: true, tryRotate: true, maxNumberOfSymbols: 64 })
          for (const r of found.filter((r) => r.isValid)) {
            report.push({ file: input.name, format: r.format, text: r.text, position: r.position })
          }
        })
        if (report.length === 0) throw new Error('没有识别到二维码或条码')
        const out = ctx.params.output === 'json'
          ? await host.fs.writeAll('barcodes.json', JSON.stringify(report, null, 2), 'application/json')
          : await host.fs.writeAll('barcodes.txt', `${report.map((r) => (ctx.inputs.length > 1 ? `${r.file}\t${r.text}` : r.text)).join('\n')}\n`, 'text/plain')
        return { outputs: [out.id], summary: `识别出 ${report.length} 个码` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'vectorize',
      name: '位图转矢量 SVG',
      category: 'image',
      icon: 'pen-line',
      description: '把 Logo、图标、手绘线稿描摹成可无限放大的 SVG。',
      accept: IMAGE_ACCEPT(),
      multiple: true,
      keywords: ['vectorize', 'trace', 'svg', 'potrace', 'logo', '矢量化', '转svg', '描摹'],
      params: [
        {
          key: 'preset', type: 'select', label: '风格', default: 'logo',
          options: [
            { value: 'logo', label: 'Logo / 图标（少量纯色）' }, { value: 'lineart', label: '黑白线稿' },
            { value: 'poster', label: '海报风（色块）' }, { value: 'detailed', label: '细节丰富（文件较大）' },
          ],
        },
        { key: 'colors', type: 'slider', label: '颜色数', min: 2, max: 64, default: 8, when: { key: 'preset', equals: ['logo', 'poster', 'detailed'] } },
        { key: 'maxSize', type: 'number', label: '描摹尺寸上限', default: 1024, min: 128, max: 4096, suffix: 'px', hint: '大图先缩小再描摹，速度快得多，SVG 仍可任意放大。' },
      ],

      async run(ctx) {
        const { exports: tracer } = await loadDependency('imagetracer')
        const p = ctx.params
        const outputs = []
        await eachInput(ctx, async (input, bytes) => {
          await noteFirstFrame(ctx, input, bytes)
          const bitmap = await decode(bytes, typeOf(input))
          const size = fit(bitmap.width, bitmap.height, Number(p.maxSize) || 1024, Number(p.maxSize) || 1024)
          const canvas = draw(bitmap, size.width, size.height)
          bitmap.close()
          const imageData = canvas.getContext('2d').getImageData(0, 0, size.width, size.height)
          const options = {
            logo: { numberofcolors: Number(p.colors), ltres: 1, qtres: 1, pathomit: 8, colorsampling: 2, blurradius: 0 },
            lineart: { numberofcolors: 2, colorquantcycles: 1, ltres: 0.5, qtres: 0.5, pathomit: 4, blurradius: 1 },
            poster: { numberofcolors: Number(p.colors), ltres: 2, qtres: 2, pathomit: 16, blurradius: 2, blurdelta: 20 },
            detailed: { numberofcolors: Number(p.colors), ltres: 0.5, qtres: 0.5, pathomit: 2, colorquantcycles: 5 },
          }[String(p.preset)]
          const svg = tracer.imagedataToSVG({ width: imageData.width, height: imageData.height, data: imageData.data }, { ...options, viewbox: true, roundcoords: 1, strokewidth: 0, linefilter: p.preset === 'lineart' })
          outputs.push((await host.fs.writeAll(`${input.name.replace(/\.[^.]+$/, '')}.svg`, svg, 'image/svg+xml')).id)
        })
        return { outputs, summary: `已描摹 ${outputs.length} 张图片为 SVG` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'svg-render',
      name: 'SVG 转图片',
      category: 'image',
      icon: 'image-down',
      description: '把 SVG 按指定宽度渲染为清晰的 PNG / WebP / JPEG，适合生成各尺寸图标。',
      accept: ['.svg', 'image/svg+xml'],
      multiple: true,
      keywords: ['svg', 'rasterize', 'svg to png', 'render', 'svg转png', '矢量转图片'],
      params: [
        { key: 'widths', type: 'text', label: '输出宽度', default: '512', placeholder: '如 512 或 16,32,64,128', hint: '多个宽度用逗号分隔，一次导出多种尺寸。' },
        { key: 'format', type: 'select', label: '格式', default: 'image/png', options: [{ value: 'image/png', label: 'PNG（透明）' }, { value: 'image/webp', label: 'WebP' }, { value: 'image/jpeg', label: 'JPEG（白底）' }] },
      ],

      async run(ctx) {
        const widths = String(ctx.params.widths).split(/[,\s]+/).map((v) => Math.round(Number(v))).filter((n) => n >= 1 && n <= 16384)
        if (widths.length === 0) throw new Error('请填写有效的输出宽度')
        const format = String(ctx.params.format)
        const outputs = []
        for (const input of ctx.inputs) {
          for (const width of widths) {
            ctx.throwIfAborted()
            // Workers cannot decode SVG; the host rasterises it in an <img>, where scripts never run.
            const result = await host.image.transcode(input.id, { format, width, quality: 0.95, background: '#ffffff' })
            const name = `${input.name.replace(/\.svgz?$/i, '')}${widths.length > 1 ? `-${width}` : ''}.${extensionFor(format)}`
            outputs.push((await host.fs.writeAll(name, new Uint8Array(result.body), result.type)).id)
          }
        }
        return { outputs, summary: `已渲染 ${outputs.length} 张图片` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'histogram',
      name: '直方图与曝光分析',
      category: 'image',
      icon: 'sliders',
      description: '绘制 RGB 与亮度直方图，统计过曝、欠曝像素比例，帮助判断照片曝光。',
      accept: IMAGE_ACCEPT(),
      multiple: true,
      keywords: ['histogram', 'exposure', 'levels', 'clipping', '直方图', '曝光', '过曝', '色阶'],
      params: [
        { key: 'mode', type: 'select', label: '显示', default: 'rgb', options: [{ value: 'rgb', label: 'RGB 叠加' }, { value: 'luma', label: '仅亮度' }] },
      ],

      async run(ctx) {
        const outputs = []
        const report = []
        await eachInput(ctx, async (input, bytes) => {
          const bitmap = await decode(bytes, typeOf(input))
          const size = fit(bitmap.width, bitmap.height, 1024, 1024)
          const { data } = draw(bitmap, size.width, size.height).getContext('2d').getImageData(0, 0, size.width, size.height)
          bitmap.close()
          const bins = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), l: new Uint32Array(256) }
          let pixels = 0
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] === 0) continue
            bins.r[data[i]]++
            bins.g[data[i + 1]]++
            bins.b[data[i + 2]]++
            bins.l[Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2])]++
            pixels++
          }
          const stats = histogramStats(bins.l, pixels)
          report.push({ file: input.name, pixels, ...stats })
          const chart = drawHistogram(bins, String(ctx.params.mode))
          outputs.push((await host.fs.writeAll(suffixName(input.name, '-histogram', 'image/png'), await encode(chart, 'image/png', 1), 'image/png')).id)
        })
        outputs.unshift((await host.fs.writeAll('histogram.json', JSON.stringify(report, null, 2), 'application/json')).id)
        const clipped = report.filter((r) => r.highlightsClipped > 1 || r.shadowsClipped > 1).length
        return { outputs, summary: `已分析 ${report.length} 张图片${clipped ? `，其中 ${clipped} 张有明显过曝或欠曝` : ''}` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'find-similar',
      name: '相似图片查找',
      category: 'image',
      icon: 'layers',
      description: '用感知哈希找出重复或近似的图片（改过尺寸、压缩、轻微调色也能识别），可只保留每组中最大的一张。',
      accept: IMAGE_ACCEPT(),
      multiple: true,
      minFiles: 2,
      keywords: ['duplicate', 'similar', 'phash', 'dedupe', '重复图片', '相似图片', '去重', '查重'],
      params: [
        { key: 'threshold', type: 'slider', label: '相似度', min: 70, max: 100, default: 90, suffix: '%', hint: '100% 只认几乎完全一样的图；越低越宽松。' },
        { key: 'keepBest', type: 'switch', label: '输出去重后的图片', default: false, hint: '每组保留分辨率最高的一张，连同未重复的图片一起输出。' },
      ],

      async run(ctx) {
        const items = []
        await eachInput(ctx, async (input, bytes) => {
          const bitmap = await decode(bytes, typeOf(input))
          items.push({ input, hash: perceptualHash(bitmap), pixels: bitmap.width * bitmap.height, width: bitmap.width, height: bitmap.height })
          bitmap.close()
        })
        const maxDistance = Math.round(64 * (1 - Number(ctx.params.threshold) / 100))
        // Union-find over pairs within the distance: similarity is transitive enough for grouping.
        const parent = items.map((_, i) => i)
        const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])))
        for (let i = 0; i < items.length; i++) {
          for (let j = i + 1; j < items.length; j++) {
            if (hamming(items[i].hash, items[j].hash) <= maxDistance) parent[find(i)] = find(j)
          }
        }
        const groups = new Map()
        items.forEach((item, i) => {
          const root = find(i)
          if (!groups.has(root)) groups.set(root, [])
          groups.get(root).push(item)
        })
        const duplicates = [...groups.values()].filter((g) => g.length > 1)
        const report = duplicates.map((group) => ({
          keep: group.reduce((a, b) => (b.pixels > a.pixels ? b : a)).input.name,
          files: group.map((g) => ({ name: g.input.name, size: `${g.width}×${g.height}`, bytes: g.input.size, similarity: `${Math.round((1 - hamming(group[0].hash, g.hash) / 64) * 100)}%` })),
        }))

        const outputs = [(await host.fs.writeAll('similar-images.json', JSON.stringify({ groups: report }, null, 2), 'application/json')).id]
        if (ctx.params.keepBest) {
          for (const group of groups.values()) {
            const best = group.reduce((a, b) => (b.pixels > a.pixels ? b : a)).input
            outputs.push((await host.fs.writeAll(`unique/${best.name}`, await host.fs.readAll(best.id), best.type)).id)
          }
        }
        const removable = duplicates.reduce((n, g) => n + g.length - 1, 0)
        return { outputs, summary: duplicates.length ? `找到 ${duplicates.length} 组相似图片，可去掉 ${removable} 张` : '没有发现相似的图片' }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'compare',
      name: '图片对比',
      category: 'image',
      icon: 'split',
      description: '比较两张图片：生成差异高亮图与左右并排图，并计算变化比例、PSNR 与结构相似度。',
      accept: IMAGE_ACCEPT(),
      multiple: true,
      minFiles: 2,
      keywords: ['compare', 'diff', 'difference', 'ssim', 'psnr', '对比', '差异', '找不同', '比较'],
      params: [
        { key: 'tolerance', type: 'slider', label: '差异阈值', min: 0, max: 100, default: 16, hint: '每个通道差值超过此值才算「变化」，用来忽略压缩噪点。' },
        { key: 'highlight', type: 'text', label: '高亮颜色', default: '#ff0033' },
      ],

      async run(ctx) {
        const [a, b] = ctx.inputs
        const bitmapA = await decode(await host.fs.readAll(a.id), typeOf(a))
        const bitmapB = await decode(await host.fs.readAll(b.id), typeOf(b))
        const size = fit(bitmapA.width, bitmapA.height, 2048, 2048)
        const pa = draw(bitmapA, size.width, size.height).getContext('2d').getImageData(0, 0, size.width, size.height)
        // The second image is compared at the first one's size.
        const pb = draw(bitmapB, size.width, size.height).getContext('2d').getImageData(0, 0, size.width, size.height)
        const sizesDiffer = bitmapA.width !== bitmapB.width || bitmapA.height !== bitmapB.height
        const metrics = compareImages(pa, pb, Number(ctx.params.tolerance) || 0)

        const diff = new OffscreenCanvas(size.width, size.height)
        const dg = diff.getContext('2d')
        const out = dg.createImageData(size.width, size.height)
        const [hr, hg, hb] = hexToRgb(String(ctx.params.highlight || '#ff0033'))
        for (let i = 0; i < out.data.length; i += 4) {
          const changed = metrics.mask[i / 4]
          // Unchanged areas are dimmed grey so the eye goes to what moved.
          const grey = (pa.data[i] * 0.3 + pa.data[i + 1] * 0.59 + pa.data[i + 2] * 0.11) * 0.35 + 150
          out.data[i] = changed ? hr : grey
          out.data[i + 1] = changed ? hg : grey
          out.data[i + 2] = changed ? hb : grey
          out.data[i + 3] = 255
        }
        dg.putImageData(out, 0, 0)

        const side = new OffscreenCanvas(size.width * 2 + 12, size.height)
        const sg = side.getContext('2d')
        sg.fillStyle = '#ffffff'
        sg.fillRect(0, 0, side.width, side.height)
        sg.drawImage(bitmapA, 0, 0, size.width, size.height)
        sg.drawImage(bitmapB, size.width + 12, 0, size.width, size.height)
        bitmapA.close()
        bitmapB.close()

        delete metrics.mask
        const report = { a: a.name, b: b.name, comparedAt: `${size.width}×${size.height}`, sizesDiffer, ...metrics }
        const outputs = [
          (await host.fs.writeAll('compare.json', JSON.stringify(report, null, 2), 'application/json')).id,
          (await host.fs.writeAll('compare-diff.png', await encode(diff, 'image/png', 1), 'image/png')).id,
          (await host.fs.writeAll('compare-side-by-side.png', await encode(side, 'image/png', 1), 'image/png')).id,
        ]
        return { outputs, summary: metrics.changedPercent === 0 ? '两张图片在阈值内完全一致' : `变化像素 ${metrics.changedPercent}%，SSIM ${metrics.ssim}，PSNR ${metrics.psnr} dB` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'sprite',
      name: '精灵图生成',
      category: 'image',
      icon: 'grid',
      description: '把多张小图打包成一张精灵图，同时生成 CSS 与坐标 JSON。',
      accept: IMAGE_ACCEPT(),
      multiple: true,
      minFiles: 2,
      keywords: ['sprite', 'spritesheet', 'css sprite', 'atlas', '精灵图', '雪碧图', '图集'],
      params: [
        { key: 'padding', type: 'number', label: '间距', default: 2, min: 0, max: 64, suffix: 'px' },
        { key: 'prefix', type: 'text', label: 'CSS 类名前缀', default: 'icon' },
        { key: 'retina', type: 'switch', label: '按 2 倍图输出 CSS', default: false, hint: 'CSS 尺寸减半，高分屏更清晰。' },
      ],

      async run(ctx) {
        const padding = Math.max(0, Number(ctx.params.padding) || 0)
        const images = []
        await eachInput(ctx, async (input, bytes) => {
          const bitmap = await decode(bytes, typeOf(input))
          images.push({ name: input.name.replace(/\.[^.]+$/, ''), bitmap, w: bitmap.width, h: bitmap.height })
        })
        const layout = shelfPack(images, padding)
        const sheet = new OffscreenCanvas(layout.width, layout.height)
        const g = sheet.getContext('2d')
        for (const item of layout.items) {
          g.drawImage(item.bitmap, item.x, item.y)
          item.bitmap.close()
        }

        const k = ctx.params.retina ? 2 : 1
        const prefix = String(ctx.params.prefix || 'icon').replace(/[^a-zA-Z0-9_-]/g, '') || 'icon'
        const css = [
          `.${prefix} { background-image: url(sprite.png); background-repeat: no-repeat; display: inline-block;${k === 2 ? ` background-size: ${layout.width / 2}px ${layout.height / 2}px;` : ''} }`,
          ...layout.items.map((item) => `.${prefix}-${cssIdent(item.name)} { width: ${item.w / k}px; height: ${item.h / k}px; background-position: -${item.x / k}px -${item.y / k}px; }`),
        ].join('\n')
        const map = Object.fromEntries(layout.items.map((i) => [i.name, { x: i.x, y: i.y, width: i.w, height: i.h }]))

        const outputs = [
          (await host.fs.writeAll('sprite.png', await encode(sheet, 'image/png', 1), 'image/png')).id,
          (await host.fs.writeAll('sprite.css', `${css}\n`, 'text/css')).id,
          (await host.fs.writeAll('sprite.json', JSON.stringify({ width: layout.width, height: layout.height, frames: map }, null, 2), 'application/json')).id,
        ]
        return { outputs, summary: `已打包 ${images.length} 张图片（${layout.width}×${layout.height}）` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'color-tools',
      name: '颜色替换与特效',
      category: 'image',
      icon: 'droplet',
      description: '替换指定颜色、双色调、暗角，或把透明区域填充为纯色。',
      accept: IMAGE_ACCEPT(),
      multiple: true,
      keywords: ['replace color', 'duotone', 'vignette', 'fill', 'recolor', '替换颜色', '换色', '双色调', '暗角', '填充背景'],
      params: [
        {
          key: 'mode', type: 'select', label: '效果', default: 'replace',
          options: [{ value: 'replace', label: '替换颜色' }, { value: 'duotone', label: '双色调' }, { value: 'vignette', label: '暗角' }, { value: 'fill', label: '透明区域填色' }],
        },
        { key: 'from', type: 'text', label: '要替换的颜色', default: '#ffffff', when: { key: 'mode', equals: 'replace' } },
        { key: 'to', type: 'text', label: '替换为', default: '#00000000', hint: '#rrggbbaa 可指定透明度，#00000000 即变透明（常用于去白底）。', when: { key: 'mode', equals: 'replace' } },
        { key: 'tolerance', type: 'slider', label: '容差', min: 0, max: 100, default: 12, when: { key: 'mode', equals: 'replace' } },
        { key: 'shadow', type: 'text', label: '暗部颜色', default: '#1e1b4b', when: { key: 'mode', equals: 'duotone' } },
        { key: 'light', type: 'text', label: '亮部颜色', default: '#f472b6', when: { key: 'mode', equals: 'duotone' } },
        { key: 'strength', type: 'slider', label: '强度', min: 0, max: 100, default: 55, suffix: '%', when: { key: 'mode', equals: 'vignette' } },
        { key: 'fill', type: 'text', label: '填充颜色', default: '#ffffff', when: { key: 'mode', equals: 'fill' } },
        { key: 'format', type: 'select', label: '输出格式', default: 'image/png', options: FORMAT_OPTIONS() },
      ],

      async run(ctx) {
        const p = ctx.params
        const outputs = []
        await eachInput(ctx, async (input, bytes) => {
          await noteFirstFrame(ctx, input, bytes)
          const bitmap = await decode(bytes, typeOf(input))
          const canvas = draw(bitmap, bitmap.width, bitmap.height)
          bitmap.close()
          const g = canvas.getContext('2d')
          const image = g.getImageData(0, 0, canvas.width, canvas.height)
          applyColorEffect(image, String(p.mode), p)
          g.putImageData(image, 0, 0)
          const type = resolveTarget(p.format, input)
          outputs.push((await host.fs.writeAll(suffixName(input.name, `-${p.mode}`, type), await encode(canvas, type, 0.92), type)).id)
        })
        return { outputs, summary: `已处理 ${outputs.length} 张图片` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'meme',
      name: '文字叠加 / 表情包',
      category: 'image',
      icon: 'type',
      description: '在图片上下方加粗描边大字，做表情包或配图标题；中文使用内置字体，显示一致。',
      accept: IMAGE_ACCEPT(),
      multiple: true,
      keywords: ['meme', 'caption', 'text overlay', '表情包', '配字', '加文字', '标题'],
      params: [
        { key: 'top', type: 'text', label: '顶部文字', default: '' },
        { key: 'bottom', type: 'text', label: '底部文字', default: '' },
        { key: 'size', type: 'slider', label: '字号', min: 3, max: 20, default: 9, suffix: '%', hint: '相对图片宽度。' },
        { key: 'color', type: 'text', label: '文字颜色', default: '#ffffff' },
        { key: 'stroke', type: 'text', label: '描边颜色', default: '#000000' },
        { key: 'band', type: 'switch', label: '文字放在图片外的色带上', default: false, hint: '不遮挡画面，适合配图标题。' },
      ],

      async run(ctx) {
        const p = ctx.params
        const top = String(p.top || '').trim()
        const bottom = String(p.bottom || '').trim()
        if (!top && !bottom) throw new Error('请至少填写顶部或底部文字')
        const family = await registerCjkFont()
        const outputs = []
        await eachInput(ctx, async (input, bytes) => {
          await noteFirstFrame(ctx, input, bytes)
          const bitmap = await decode(bytes, typeOf(input))
          const canvas = drawCaption(bitmap, { top, bottom, size: Number(p.size) / 100, color: String(p.color), stroke: String(p.stroke), band: !!p.band, family })
          bitmap.close()
          const type = typeOf(input) === 'image/png' ? 'image/png' : 'image/jpeg'
          outputs.push((await host.fs.writeAll(suffixName(input.name, '-caption', type), await encode(canvas, type, 0.92), type)).id)
        })
        return { outputs, summary: `已为 ${outputs.length} 张图片加上文字` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'animation',
      name: '动图处理',
      category: 'image',
      icon: 'film',
      description: 'GIF / 动态 WebP：变速、倒放、拆帧、格式互转、压缩、循环次数，或把多张图片合成动图。',
      accept: IMAGE_ACCEPT(),
      multiple: true,
      keywords: ['gif', 'apng', 'webp', 'animation', 'frames', 'reverse', '动图', '倒放', '变速', '拆帧', '合成动图', '表情包'],
      params: [
        {
          key: 'mode', type: 'select', label: '操作', default: 'optimize',
          options: [
            { value: 'optimize', label: '压缩动图（减色 / 抽帧 / 缩小）' },
            { value: 'speed', label: '调整播放速度' },
            { value: 'reverse', label: '倒放' },
            { value: 'convert', label: '转换动图格式' },
            { value: 'loop', label: '设置循环次数' },
            { value: 'extract', label: '拆分为单帧图片' },
            { value: 'compose', label: '多张图片合成动图' },
          ],
        },
        { key: 'speed', type: 'slider', label: '播放速度', min: 25, max: 400, step: 5, default: 200, suffix: '%', when: { key: 'mode', equals: 'speed' } },
        { key: 'colors', type: 'slider', label: '颜色数', min: 2, max: 256, default: 128, when: { key: 'mode', equals: 'optimize' }, hint: 'GIF 最多 256 色；减少颜色是缩小体积最有效的手段。' },
        { key: 'keepEvery', type: 'slider', label: '每 N 帧保留 1 帧', min: 1, max: 6, default: 1, when: { key: 'mode', equals: 'optimize' }, hint: '被丢弃帧的时长并入保留帧，总时长不变。' },
        { key: 'maxWidth', type: 'number', label: '最大宽度', default: 0, min: 0, suffix: 'px', when: { key: 'mode', equals: ['optimize', 'compose'] }, hint: '0 表示不缩放。' },
        { key: 'loops', type: 'number', label: '循环次数', default: 0, min: 0, max: 1000, when: { key: 'mode', equals: 'loop' }, hint: '0 表示无限循环。' },
        { key: 'delay', type: 'number', label: '每帧时长', default: 100, min: 20, max: 10000, suffix: 'ms', when: { key: 'mode', equals: 'compose' } },
        { key: 'every', type: 'number', label: '每 N 帧导出 1 张', default: 1, min: 1, when: { key: 'mode', equals: 'extract' } },
        {
          key: 'format', type: 'select', label: '输出格式', default: 'keep',
          options: [
            { value: 'keep', label: '保持原格式' }, { value: 'image/gif', label: 'GIF' },
            { value: 'image/webp', label: '动态 WebP（更小、支持半透明）' },
          ],
          when: { key: 'mode', equals: ['optimize', 'speed', 'reverse', 'convert', 'loop', 'compose'] },
        },
      ],

      async run(ctx) {
        const p = ctx.params
        const M = await magick()
        const outputs = []
        const mode = String(p.mode)

        if (mode === 'compose') {
          if (ctx.inputs.length < 2) throw new Error('合成动图至少需要两张图片')
          const type = p.format === 'keep' ? 'image/gif' : String(p.format)
          const collection = M.MagickImageCollection.create()
          try {
            let width = 0
            let height = 0
            for (const [index, input] of ctx.inputs.entries()) {
              ctx.throwIfAborted()
              ctx.progress((index / ctx.inputs.length) * 0.8, `读取 ${input.name}`)
              const frame = M.MagickImage.create(await host.fs.readAll(input.id))
              frame.autoOrient()
              if (index === 0) {
                const limit = Number(p.maxWidth) || 0
                if (limit && frame.width > limit) frame.resize(new M.MagickGeometry(limit, Math.round((frame.height * limit) / frame.width)))
                width = frame.width
                height = frame.height
              } else {
                // Every frame is fitted and centred on the first frame's canvas.
                frame.resize(new M.MagickGeometry(width, height))
                frame.extent(new M.MagickGeometry(width, height), M.Gravity.Center, new M.MagickColor('#00000000'))
              }
              frame.animationDelay = Math.max(2, Math.round(Number(p.delay) / 10))
              frame.animationIterations = 0
              collection.push(frame)
            }
            ctx.progress(0.9, '编码动图')
            if (type === 'image/gif') collection.optimize()
            const encoded = collection.write(MAGICK_WRITE[type], (data) => new Uint8Array(data))
            outputs.push((await host.fs.writeAll(`animation.${extensionFor(type)}`, encoded, type)).id)
          } finally {
            collection.dispose()
          }
          ctx.progress(1)
          return { outputs, summary: `已用 ${ctx.inputs.length} 张图片合成动图` }
        }

        let frameCount = 0
        await eachInput(ctx, async (input, bytes) => {
          const sourceType = typeOf(input)
          const type = p.format === 'keep' ? (ANIMATED_TYPES.has(sourceType) ? sourceType : 'image/gif') : String(p.format)
          const files = M.ImageMagick.readCollection(bytes, (images) => {
            images.coalesce()
            frameCount += images.length

            if (mode === 'extract') {
              const every = Math.max(1, Number(p.every) || 1)
              const frames = []
              images.forEach((image, index) => {
                if (index % every === 0) frames.push({ index, data: image.write(M.MagickFormat.Png, (data) => new Uint8Array(data)) })
              })
              return frames.map((frame) => ({
                name: suffixName(input.name, `-frame${String(frame.index + 1).padStart(4, '0')}`, 'image/png'),
                data: frame.data,
                type: 'image/png',
              }))
            }

            if (mode === 'speed') {
              const factor = Math.max(0.05, Number(p.speed) / 100)
              // Browsers treat delays under 2 ticks (20 ms) as 100 ms, so a
              // "faster" GIF would suddenly play slower; clamp instead.
              for (const image of images) image.animationDelay = Math.max(2, Math.round(image.animationDelay / factor))
            } else if (mode === 'reverse') {
              images.reverse()
            } else if (mode === 'loop') {
              for (const image of images) image.animationIterations = Math.max(0, Math.round(Number(p.loops) || 0))
            } else if (mode === 'optimize') {
              const keepEvery = Math.max(1, Number(p.keepEvery) || 1)
              if (keepEvery > 1) {
                for (let i = images.length - 1; i >= 0; i--) {
                  if (i % keepEvery === 0) continue
                  // Fold the dropped frame's time into the frame it follows.
                  const keeper = images[i - (i % keepEvery)]
                  keeper.animationDelay += images[i].animationDelay
                  images.splice(i, 1)[0].dispose()
                }
              }
              const limit = Number(p.maxWidth) || 0
              if (limit) {
                for (const image of images) {
                  if (image.width > limit) image.resize(new M.MagickGeometry(limit, Math.round((image.height * limit) / image.width)))
                }
              }
              const settings = new M.QuantizeSettings()
              settings.colors = Math.max(2, Math.min(256, Number(p.colors) || 256))
              images.quantize(settings)
            }

            for (const image of images) image.resetPage()
            if (type === 'image/gif') images.optimize()
            const suffix = { speed: '-speed', reverse: '-reversed', loop: '-loop', optimize: '-optimized', convert: '' }[mode] ?? ''
            return [{ name: suffixName(input.name, suffix, type), data: images.write(MAGICK_WRITE[type], (data) => new Uint8Array(data)), type }]
          })

          for (const file of files) outputs.push((await host.fs.writeAll(file.name, file.data, file.type)).id)
        })

        const summary = mode === 'extract' ? `已拆出 ${outputs.length} 帧` : `已处理 ${ctx.inputs.length} 个动图（共 ${frameCount} 帧）`
        return { outputs, summary }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'metadata',
      name: '图片元数据',
      category: 'image',
      icon: 'shield-check',
      description: '查看 EXIF、GPS、色彩配置等元数据，或在分享前一键清除（可保留 ICC 色彩）。',
      accept: IMAGE_ACCEPT(),
      multiple: true,
      keywords: ['exif', 'gps', 'metadata', 'icc', 'privacy', '元数据', '隐私', '定位', '去除信息'],
      params: [
        {
          key: 'mode', type: 'select', label: '操作', default: 'view',
          options: [{ value: 'view', label: '查看元数据' }, { value: 'strip', label: '清除元数据' }],
        },
        { key: 'keepIcc', type: 'switch', label: '保留 ICC 色彩配置文件', default: true, when: { key: 'mode', equals: 'strip' }, hint: '去掉它会让广色域照片颜色发灰；它不含个人信息。' },
        { key: 'autoOrient', type: 'switch', label: '按 EXIF 方向摆正像素', default: true, when: { key: 'mode', equals: 'strip' }, hint: '清除方向标记前先把图片转正，否则清除后可能显示为横躺。' },
      ],

      async run(ctx) {
        const p = ctx.params
        const M = await magick()
        const outputs = []
        const report = []
        const colorSpaces = invert(M.ColorSpace)
        const orientations = invert(M.Orientation)

        await eachInput(ctx, async (input, bytes) => {
          const type = typeOf(input)

          if (p.mode === 'strip') {
            const target = keepType(type, true)
            const encoded = M.ImageMagick.readCollection(bytes, (images) => {
              for (const image of images) {
                if (p.autoOrient) image.autoOrient()
                for (const name of [...image.profileNames]) {
                  if (name === 'icc' && p.keepIcc) continue
                  image.removeProfile(name)
                }
                // Text chunks and comments (PNG tEXt, JPEG COM) are not profiles.
                for (const attribute of [...image.attributeNames]) {
                  if (/^(comment|exif:|xmp:|iptc:|png:(tEXt|zTXt|iTXt)|photoshop:|dc:|tiff:(artist|copyright|make|model|software))/i.test(attribute)) image.removeAttribute(attribute)
                }
              }
              return images.write(MAGICK_WRITE[target], (data) => new Uint8Array(data))
            })
            outputs.push((await host.fs.writeAll(suffixName(input.name, '-clean', target), encoded, target)).id)
            return
          }

          report.push(
            M.ImageMagick.readCollection(bytes, (images) => {
              const image = images[0]
              const attributes = {}
              for (const name of image.attributeNames) {
                const value = image.getAttribute(name)
                if (value !== null && !/^(date:|signature$)/.test(name)) attributes[name] = value
              }
              const gps = Object.keys(attributes).filter((name) => /^exif:GPS/i.test(name))
              return {
                file: input.name,
                format: image.format,
                width: image.width,
                height: image.height,
                frames: images.length,
                depth: image.depth,
                colorSpace: colorSpaces[image.colorSpace] ?? image.colorSpace,
                hasAlpha: image.hasAlpha,
                orientation: orientations[image.orientation] ?? image.orientation,
                profiles: image.profileNames.map((name) => ({ name, bytes: image.getProfile(name)?.data.length ?? 0 })),
                containsLocation: gps.length > 0,
                attributes,
              }
            }),
          )
        })

        if (p.mode === 'strip') return { outputs, summary: `已清除 ${outputs.length} 张图片的元数据` }
        const out = await host.fs.writeAll('image-metadata.json', JSON.stringify(report, null, 2), 'application/json')
        const located = report.filter((r) => r.containsLocation).length
        return { outputs: [out.id], summary: `已读取 ${report.length} 张图片的元数据${located ? `，其中 ${located} 张含 GPS 定位` : ''}` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'scan-split',
      name: '扫描件拆分照片',
      category: 'image',
      icon: 'crop',
      description: '一次扫描了好几张照片或卡片？自动找出每一张，摆正并分别导出。',
      accept: IMAGE_ACCEPT(),
      multiple: true,
      keywords: ['scan', 'split photos', 'multi-crop', 'deskew', 'autosplit', '扫描', '拆分照片', '批量裁切', '老照片', '摆正'],
      params: [
        { key: 'sensitivity', type: 'slider', label: '灵敏度', min: 5, max: 80, default: 28, hint: '照片边缘和扫描底色接近（如白边照片）时调低；底色有噪点被误识别时调高。' },
        { key: 'minSize', type: 'slider', label: '最小照片面积', min: 1, max: 30, default: 3, suffix: '%', hint: '小于整张扫描面积这个比例的区域会被忽略。' },
        { key: 'deskew', type: 'switch', label: '自动摆正歪斜的照片', default: true },
        { key: 'inset', type: 'number', label: '向内收边', default: 4, min: 0, max: 100, suffix: 'px', hint: '裁掉照片边缘残留的扫描底色。' },
        { key: 'format', type: 'select', label: '输出格式', default: 'keep', options: FORMAT_OPTIONS() },
        { key: 'quality', type: 'slider', label: '质量', min: 1, max: 100, default: 92, suffix: '%' },
      ],

      async run(ctx) {
        const outputs = []
        const notes = []
        await eachInput(ctx, async (input, bytes) => {
          const bitmap = await decode(bytes, typeOf(input))
          const scale = Math.min(1, 800 / Math.max(bitmap.width, bitmap.height))
          const small = draw(bitmap, Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)))
          const pixels = small.getContext('2d').getImageData(0, 0, small.width, small.height)
          const found = detectPhotos(pixels.data, pixels.width, pixels.height, {
            threshold: Number(ctx.params.sensitivity) || 28,
            minArea: (Number(ctx.params.minSize) || 3) / 100,
          })
          if (found.length === 0) {
            notes.push(`${input.name}：没有找到照片`)
            bitmap.close()
            return
          }
          const type = resolveTarget(ctx.params.format, input)
          const inset = Math.max(0, Number(ctx.params.inset) || 0)
          for (const [index, rect] of found.entries()) {
            ctx.throwIfAborted()
            const angle = ctx.params.deskew && Math.abs(rect.angle) >= 0.004 ? rect.angle : 0
            // Without deskew the axis-aligned bounds of the tilted photo are kept whole.
            const box = angle === rect.angle ? rect : axisAlignedBounds(rect)
            const width = Math.max(1, Math.round(box.width / scale - inset * 2))
            const height = Math.max(1, Math.round(box.height / scale - inset * 2))
            const canvas = new OffscreenCanvas(width, height)
            const g = canvas.getContext('2d')
            g.imageSmoothingQuality = 'high'
            g.translate(width / 2, height / 2)
            g.rotate(-angle)
            g.drawImage(bitmap, -box.cx / scale, -box.cy / scale)
            const encoded = await encode(canvas, type, Number(ctx.params.quality) / 100)
            outputs.push((await host.fs.writeAll(suffixName(input.name, `-photo${index + 1}`, type), encoded, type)).id)
          }
          notes.push(`${input.name}：${found.length} 张`)
          bitmap.close()
        })
        return { outputs, summary: `已拆分出 ${outputs.length} 张照片（${notes.join('；')}）` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'seam-carve',
      name: '内容感知缩放',
      category: 'image',
      icon: 'scaling',
      description: '改变宽高比时不拉伸：逐条移除画面里最不显眼的像素缝（Seam Carving）。天空、海面、墙面等留白多的照片效果最好；满画面都是细节（如人群）时主体也会被挤压。',
      accept: IMAGE_ACCEPT(),
      multiple: true,
      keywords: ['seam carving', 'content aware scale', 'liquid rescale', 'retarget', '内容感知', '智能缩放', '不变形缩放', '改比例'],
      params: [
        { key: 'width', type: 'slider', label: '宽度', min: 50, max: 100, default: 75, suffix: '%' },
        { key: 'height', type: 'slider', label: '高度', min: 50, max: 100, default: 100, suffix: '%' },
        { key: 'format', type: 'select', label: '输出格式', default: 'keep', options: FORMAT_OPTIONS() },
        { key: 'quality', type: 'slider', label: '质量', min: 1, max: 100, default: 92, suffix: '%' },
      ],

      async run(ctx) {
        const outputs = []
        const notes = []
        const wr = Math.min(1, Math.max(0.5, Number(ctx.params.width) / 100 || 1))
        const hr = Math.min(1, Math.max(0.5, Number(ctx.params.height) / 100 || 1))
        if (wr === 1 && hr === 1) throw new Error('宽度和高度都是 100%，没有需要移除的像素')
        await eachInput(ctx, async (input, bytes) => {
          const bitmap = await decode(bytes, typeOf(input))
          // Seam carving is quadratic in the image side; very large photos are carved at 2 MP.
          const scale = Math.min(1, Math.sqrt(SEAM_MAX_PIXELS / (bitmap.width * bitmap.height)))
          if (scale < 1) notes.push(`${input.name} 较大，已先缩小到 ${Math.round(bitmap.width * scale)} 像素宽再处理`)
          const canvas = draw(bitmap, Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
          bitmap.close()
          const g = canvas.getContext('2d', { willReadFrequently: true })
          let image = { data: g.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height }
          const onSeam = (done, total) => {
            ctx.throwIfAborted()
            if (done % 20 === 0) ctx.progress(null, `${input.name}：移除第 ${done}/${total} 条像素缝`)
          }
          image = carveSeams(image, Math.round(image.width * (1 - wr)), onSeam)
          if (hr < 1) image = transpose(carveSeams(transpose(image), Math.round(image.height * (1 - hr)), onSeam))
          const out = new OffscreenCanvas(image.width, image.height)
          out.getContext('2d').putImageData(new ImageData(image.data, image.width, image.height), 0, 0)
          const type = resolveTarget(ctx.params.format, input)
          const encoded = await encode(out, type, Number(ctx.params.quality) / 100)
          outputs.push((await host.fs.writeAll(suffixName(input.name, `-${image.width}x${image.height}`, type), encoded, type)).id)
        })
        return { outputs, summary: `已处理 ${outputs.length} 张图片${notes.length ? `（${notes.join('；')}）` : ''}` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'denoise',
      name: '图片降噪',
      category: 'image',
      icon: 'waves',
      description: '去掉夜景、暗光照片里的颗粒噪点，同时保留边缘和细节（引导滤波，边缘保持平滑）。',
      accept: IMAGE_ACCEPT(),
      multiple: true,
      keywords: ['denoise', 'noise reduction', 'grain', 'smooth', 'night photo', '降噪', '去噪点', '噪点', '颗粒感', '磨皮'],
      params: [
        { key: 'strength', type: 'slider', label: '强度', min: 1, max: 10, default: 4, hint: '噪点越重越往上调；过高会像涂抹，细纹理变平。' },
        { key: 'detail', type: 'slider', label: '保留细节', min: 0, max: 100, default: 50, suffix: '%', hint: '把一部分原图细节加回来，避免塑料感。' },
        { key: 'format', type: 'select', label: '输出格式', default: 'keep', options: FORMAT_OPTIONS() },
        { key: 'quality', type: 'slider', label: '质量', min: 1, max: 100, default: 92, suffix: '%' },
      ],

      async run(ctx) {
        const outputs = []
        const strength = Math.min(10, Math.max(1, Number(ctx.params.strength) || 4))
        const detail = Math.min(1, Math.max(0, Number(ctx.params.detail) / 100))
        await eachInput(ctx, async (input, bytes) => {
          await noteFirstFrame(ctx, input, bytes)
          const bitmap = await decode(bytes, typeOf(input))
          const canvas = draw(bitmap, bitmap.width, bitmap.height)
          bitmap.close()
          const g = canvas.getContext('2d', { willReadFrequently: true })
          const image = g.getImageData(0, 0, canvas.width, canvas.height)
          // Radius grows with the image so the result looks the same at any resolution.
          const radius = Math.max(1, Math.round((Math.max(canvas.width, canvas.height) / 1000) * (1 + strength / 3)))
          // Differences below ~7 levels per strength step count as noise; real edges are far larger.
          const eps = ((strength * 7) / 255) ** 2
          denoiseGuided(image.data, canvas.width, canvas.height, radius, eps, detail)
          g.putImageData(image, 0, 0)
          const type = resolveTarget(ctx.params.format, input)
          const encoded = await encode(canvas, type, Number(ctx.params.quality) / 100)
          outputs.push((await host.fs.writeAll(suffixName(input.name, '-denoised', type), encoded, type)).id)
        })
        return { outputs, summary: `已降噪 ${outputs.length} 张图片` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'inspect',
      name: '图片信息与配色',
      category: 'image',
      icon: 'info',
      description: '输出尺寸、格式、体积、主色板与占位图（LQIP）。',
      accept: IMAGE_ACCEPT(),
      multiple: true,
      keywords: ['info', 'metadata', 'palette', 'lqip', '信息', '配色', '占位图'],
      params: [
        { key: 'colors', type: 'slider', label: '提取主色数量', min: 1, max: 12, default: 6 },
        { key: 'lqip', type: 'switch', label: '生成模糊占位图', default: true, hint: '输出一张 24px 宽的 WebP，可内联为 data URI。' },
      ],

      async run(ctx) {
        const outputs = []
        const report = []

        await eachInput(ctx, async (input, bytes) => {
          await noteFirstFrame(ctx, input, bytes)
          const bitmap = await decode(bytes, typeOf(input))
          const palette = extractPalette(bitmap, Number(ctx.params.colors) || 6)

          report.push({
            file: input.name,
            type: typeOf(input),
            bytes: input.size,
            width: bitmap.width,
            height: bitmap.height,
            megapixels: Number(((bitmap.width * bitmap.height) / 1e6).toFixed(2)),
            aspectRatio: simplifyRatio(bitmap.width, bitmap.height),
            palette,
          })

          if (ctx.params.lqip) {
            const scale = 24 / bitmap.width
            const tiny = draw(bitmap, 24, Math.max(1, Math.round(bitmap.height * scale)))
            const encoded = await encode(tiny, 'image/webp', 0.5)
            outputs.push((await host.fs.writeAll(suffixName(input.name, '-lqip', 'image/webp'), encoded, 'image/webp')).id)
          }
          bitmap.close()
        })

        const json = JSON.stringify(report, null, 2)
        outputs.unshift((await host.fs.writeAll('image-info.json', json, 'application/json')).id)

        return { outputs, summary: `已分析 ${report.length} 张图片` }
      },
    },
  ],
})

/* ========================================================================== */
/* Shared helpers                                                             */
/* ========================================================================== */

function FORMAT_OPTIONS() {
  return [
    { value: 'keep', label: '保持原格式' },
    { value: 'image/webp', label: 'WebP' },
    { value: 'image/jpeg', label: 'JPEG' },
    { value: 'image/png', label: 'PNG' },
    { value: 'image/avif', label: 'AVIF' },
    { value: 'image/gif', label: 'GIF' },
    { value: 'image/tiff', label: 'TIFF' },
    { value: 'image/jxl', label: 'JPEG XL' },
  ]
}

function METADATA_PARAM() {
  return {
    key: 'keepMetadata', type: 'switch', label: '保留 EXIF 元数据', default: false,
    hint: '默认去除 EXIF（含 GPS 定位）并按拍摄方向摆正；开启后改用 ImageMagick 引擎，保留 EXIF 与 ICC 色彩配置文件，速度较慢。',
  }
}

/** Iterates inputs with progress and cancellation handled once. */
async function eachInput(ctx, fn) {
  if (ctx.inputs.length === 0) throw new Error('请先拖入至少一张图片')
  for (let i = 0; i < ctx.inputs.length; i++) {
    ctx.throwIfAborted()
    ctx.progress(i / ctx.inputs.length, `正在处理 ${ctx.inputs[i].name}`)
    const bytes = await host.fs.readAll(ctx.inputs[i].id)
    await fn(ctx.inputs[i], bytes)
  }
  ctx.progress(1)
}

/* ========================================================================== */
/* Engines                                                                    */
/* ========================================================================== */
/*
 * Two engines, chosen per file:
 *
 *   Canvas   fast and GPU-backed. Applies EXIF orientation and drops metadata
 *            (GPS included), which is the right default for sharing. But it sees
 *            one frame, knows only the browser's codecs, and discards ICC.
 *   Magick   ImageMagick in WebAssembly, loaded on first use (~14 MB). Keeps
 *            every frame of a GIF / WebP / APNG, keeps ICC and optionally EXIF,
 *            reads HEIC / TIFF / PSD / JXL / RAW, writes GIF / TIFF / JXL.
 *
 * Tools stay written against canvas; `decode` and `encode` fall back to magick
 * for codecs the browser lacks, and the geometry tools (convert, resize, crop,
 * transform) switch to a whole-file magick pipeline when a frame or a profile
 * would otherwise be lost.
 */

const EXTENSION_TYPES = {
  png: 'image/png', apng: 'image/apng', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
  psd: 'image/vnd.adobe.photoshop', jxl: 'image/jxl', bmp: 'image/bmp', ico: 'image/x-icon', qoi: 'image/qoi',
  svg: 'image/svg+xml', dng: 'image/x-adobe-dng', cr2: 'image/x-canon-cr2', nef: 'image/x-nikon-nef',
}

/**
 * Accept list for every tool: `image/*` misses files OSes leave untyped (HEIC,
 * PSD, RAW). A function, not a const: the manifest literal reads it before this
 * part of the file has run.
 */
function IMAGE_ACCEPT() {
  return ['image/*', '.heic', '.heif', '.tif', '.tiff', '.psd', '.jxl', '.avif', '.qoi', '.dng', '.cr2', '.nef', '.apng']
}

/**
 * Formats magick can encode *in WebAssembly*. APNG is absent on purpose:
 * ImageMagick advertises it but delegates the encode to an external `ffmpeg`
 * binary, which does not exist here.
 */
const MAGICK_WRITE = {
  'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WEBP', 'image/avif': 'AVIF',
  'image/gif': 'GIF', 'image/tiff': 'TIFF', 'image/jxl': 'JXL', 'image/bmp': 'BMP', 'image/qoi': 'QOI',
}

/** Formats whose frames survive a magick round-trip. (APNG: see MAGICK_WRITE.) */
const ANIMATED_TYPES = new Set(['image/gif', 'image/webp'])

/** The browser decodes these itself; anything else goes through magick. */
const CANVAS_DECODE = new Set(['image/png', 'image/apng', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/x-icon', 'image/avif', 'image/svg+xml'])

/** MIME type from the declared type, falling back to the extension (HEIC etc. often arrive untyped). */
function typeOf(input) {
  const declared = String(input.type || '').toLowerCase()
  if (declared.startsWith('image/') && declared !== 'image/octet-stream') return declared === 'image/jpg' ? 'image/jpeg' : declared
  const extension = String(input.name || '').split('.').pop().toLowerCase()
  return EXTENSION_TYPES[extension] || declared || 'application/octet-stream'
}

/** The output type for "keep": formats nothing can write (HEIC, RAW, PSD) become JPEG or PNG. */
function keepType(type, hasAlpha) {
  if (MAGICK_WRITE[type]) return type
  if (type === 'image/apng') return 'image/png'
  return hasAlpha ? 'image/png' : 'image/jpeg'
}

function resolveTarget(format, input) {
  return format === 'keep' ? keepType(typeOf(input), true) : String(format)
}

let magickLoading = null

/** Loads and initialises ImageMagick once per sandbox. */
function magick() {
  if (!magickLoading) {
    magickLoading = loadDependency('magick')
      .then(async ({ exports, assets }) => {
        await exports.initializeImageMagick(new Uint8Array(assets['magick.wasm']))
        return exports
      })
      .catch((err) => {
        magickLoading = null
        throw new Error(`ImageMagick 引擎加载失败：${err && err.message ? err.message : err}`)
      })
  }
  return magickLoading
}

/**
 * Whether a file has more than one frame, from its container structure alone
 * (no decode): a second GIF graphic-control block, the WebP VP8X animation flag,
 * or an APNG `acTL` chunk.
 */
function isAnimated(bytes, type) {
  if (type === 'image/gif') {
    let controls = 0
    for (let i = 0; i < bytes.length - 2; i++) {
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04 && ++controls > 1) return true
    }
    return false
  }
  if (type === 'image/webp') {
    const tag = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
    return tag === 'VP8X' && (bytes[20] & 0x02) !== 0
  }
  if (type === 'image/png' || type === 'image/apng') {
    // acTL must precede the first IDAT, so the head of the file is enough.
    const head = bytes.subarray(0, Math.min(bytes.length, 1 << 16))
    for (let i = 8; i < head.length - 4; i++) {
      if (head[i] === 0x61 && head[i + 1] === 0x63 && head[i + 2] === 0x54 && head[i + 3] === 0x4c) return true
      if (head[i] === 0x49 && head[i + 1] === 0x44 && head[i + 2] === 0x41 && head[i + 3] === 0x54) return false
    }
  }
  return false
}

const encodeSupport = new Map()

/** Whether this browser's canvas can encode `type` (Chromium cannot do AVIF, none do GIF). */
async function canvasEncodes(type) {
  if (!encodeSupport.has(type)) {
    encodeSupport.set(
      type,
      new OffscreenCanvas(1, 1).convertToBlob({ type }).then((blob) => blob.type === type, () => false),
    )
  }
  return encodeSupport.get(type)
}

/**
 * Picks the engine for a geometry tool. Magick when a frame, a codec or a
 * profile would otherwise be lost; canvas for everything else.
 */
async function needsMagick(bytes, input, target, keepMetadata) {
  const type = typeOf(input)
  if (keepMetadata) return true
  if (!CANVAS_DECODE.has(type)) return true
  if (ANIMATED_TYPES.has(target) && isAnimated(bytes, type)) return true
  return !(await canvasEncodes(target))
}

/**
 * Warns once per run that a single-frame tool used only the first frame of an
 * animation, instead of silently flattening it.
 */
async function noteFirstFrame(ctx, input, bytes) {
  if (ctx.firstFrameNoted || !isAnimated(bytes, typeOf(input))) return
  ctx.firstFrameNoted = true
  const type = typeOf(input)
  const hint = type === 'image/png' || type === 'image/apng'
    ? 'APNG 动画暂无法在浏览器内重新编码。'
    : '要保留动画，请在「批量压缩 / 格式转换」「尺寸调整」「裁剪」「旋转与翻转」中输出 GIF 或 WebP，或使用「动图处理」。'
  await host.ui.notify(`${input.name} 是动图，结果只保留第一帧。${hint}`, 'warn')
}

async function decode(bytes, type) {
  if (CANVAS_DECODE.has(type) || !type) {
    try {
      return await createImageBitmap(new Blob([bytes], { type: type || '' }))
    } catch (err) {
      // Fall through: a mislabelled file may still be readable by magick.
    }
  }
  try {
    const M = await magick()
    const raster = M.ImageMagick.read(bytes, (image) => {
      image.autoOrient()
      image.depth = 8
      return image.write(M.MagickFormat.Rgba, (data) => ({ width: image.width, height: image.height, data: new Uint8ClampedArray(data) }))
    })
    return await createImageBitmap(new ImageData(raster.data, raster.width, raster.height))
  } catch (err) {
    throw new Error(`无法解码该图片（${type || '未知格式'}）：${err && err.message ? err.message : err}`)
  }
}

/** Draws a bitmap into a fresh canvas at the given size. */
function draw(bitmap, width, height, options) {
  const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height))
  const g = canvas.getContext('2d')
  if (options && options.background) {
    g.fillStyle = options.background
    g.fillRect(0, 0, canvas.width, canvas.height)
  }
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return canvas
}

async function encode(canvas, type, quality) {
  if (await canvasEncodes(type)) {
    const blob = await canvas.convertToBlob({ type, quality })
    // Canvas silently falls back to PNG for formats it cannot encode.
    if (blob.type === type) return new Uint8Array(await blob.arrayBuffer())
  }
  if (!MAGICK_WRITE[type]) throw new Error(`无法编码为 ${type}，请改选其他格式`)
  const M = await magick()
  const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
  const settings = new M.MagickReadSettings({ format: M.MagickFormat.Rgba, width: canvas.width, height: canvas.height })
  settings.depth = 8
  return M.ImageMagick.read(new Uint8Array(pixels.buffer), settings, (image) => {
    if (quality !== undefined) image.quality = Math.round(quality * 100)
    return image.write(MAGICK_WRITE[type], (data) => new Uint8Array(data))
  })
}

/**
 * Runs geometry operations over every frame of a file with ImageMagick and
 * encodes the result.
 *
 * ops: { resize: { width, height, mode: fit|cover|pad|stretch, noUpscale, pad } }
 *      { scale: ratio } · { crop: { x, y, w, h } } · { rotate: degrees }
 *      { flipH: true } · { flipV: true }
 *
 * Frames are coalesced first, so each one is a full picture and a crop or resize
 * means the same thing for all of them. EXIF orientation is always applied
 * (pixels match what the user saw); `keepMetadata` then decides whether EXIF,
 * XMP and IPTC survive. ICC profiles always survive: dropping one shifts colours.
 */
async function magickPipeline(bytes, { ops = [], type, quality, keepMetadata = false, background = '#ffffff' }) {
  const M = await magick()
  const format = MAGICK_WRITE[type]
  if (!format) throw new Error(`无法编码为 ${type}`)

  return M.ImageMagick.readCollection(bytes, (images) => {
    const animated = images.length > 1 && ANIMATED_TYPES.has(type)
    if (images.length > 1) images.coalesce()
    // A format without frames gets the first one, as canvas would.
    while (!animated && images.length > 1) images.pop().dispose()

    for (const image of images) {
      image.autoOrient()
      if (!keepMetadata) for (const profile of ['exif', 'xmp', 'iptc', '8bim']) image.removeProfile(profile)
      for (const op of ops) applyOp(M, image, op)
      if (type === 'image/jpeg' && image.hasAlpha) {
        image.backgroundColor = new M.MagickColor(background)
        image.alpha(M.AlphaAction.Remove)
      }
      if (quality !== undefined) image.quality = Math.round(quality * 100)
    }
    if (animated) {
      for (const image of images) image.resetPage()
      if (type === 'image/gif') images.optimize()
    }
    // `write` hands back a view into WebAssembly memory; copy it out.
    return images.write(format, (data) => new Uint8Array(data))
  })
}

function applyOp(M, image, op) {
  if (op.scale) {
    const width = Math.max(1, Math.round(image.width * op.scale))
    const height = Math.max(1, Math.round(image.height * op.scale))
    const geometry = new M.MagickGeometry(width, height)
    geometry.ignoreAspectRatio = true
    image.resize(geometry)
  } else if (op.resize) {
    const { width, height, mode, noUpscale, pad } = op.resize
    const geometry = new M.MagickGeometry(width, height)
    if (mode === 'stretch') geometry.ignoreAspectRatio = true
    if (mode === 'cover') geometry.fillArea = true
    if (noUpscale) geometry.greater = true
    image.resize(geometry)
    if (mode === 'cover') {
      image.crop(width, height, M.Gravity.Center)
      image.resetPage()
    }
    if (mode === 'pad') image.extent(new M.MagickGeometry(width, height), M.Gravity.Center, new M.MagickColor(pad || '#00000000'))
  } else if (op.crop) {
    image.crop(new M.MagickGeometry(op.crop.x, op.crop.y, op.crop.w, op.crop.h))
    image.resetPage()
  } else if (op.rotate) {
    image.rotate(op.rotate)
  } else if (op.flipH) {
    image.flop()
  } else if (op.flipV) {
    image.flip()
  }
}

/** Width, height and frame count without decoding pixel data twice. */
async function magickInfo(bytes) {
  const M = await magick()
  return M.ImageMagick.readCollection(bytes, (images) => ({ width: images[0].width, height: images[0].height, frames: images.length }))
}

function fit(width, height, maxWidth, maxHeight) {
  const byWidth = maxWidth > 0 ? maxWidth / width : 1
  const byHeight = maxHeight > 0 ? maxHeight / height : 1
  const scale = Math.min(1, byWidth, byHeight)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

function resizeTo(bitmap, targetW, targetH, mode, options) {
  if (mode === 'stretch') return draw(bitmap, targetW, targetH)

  const scale =
    mode === 'cover'
      ? Math.max(targetW / bitmap.width, targetH / bitmap.height)
      : Math.min(targetW / bitmap.width, targetH / bitmap.height)
  const effective = options.noUpscale ? Math.min(1, scale) : scale
  const w = Math.max(1, Math.round(bitmap.width * effective))
  const h = Math.max(1, Math.round(bitmap.height * effective))

  if (mode === 'fit') return draw(bitmap, w, h)

  // cover and pad both land on the exact target box; they differ in whether the
  // overflow is cropped or the shortfall is filled.
  const canvas = new OffscreenCanvas(targetW, targetH)
  const g = canvas.getContext('2d')
  if (mode === 'pad' && options.padColor && options.padColor !== 'transparent') {
    g.fillStyle = options.padColor
    g.fillRect(0, 0, targetW, targetH)
  }
  g.imageSmoothingQuality = 'high'
  g.drawImage(bitmap, (targetW - w) / 2, (targetH - h) / 2, w, h)
  return canvas
}

function clampRect(rect, width, height) {
  const x = Math.max(0, Math.min(Math.round(rect.x), width - 1))
  const y = Math.max(0, Math.min(Math.round(rect.y), height - 1))
  return { x, y, w: Math.max(1, Math.min(Math.round(rect.w), width - x)), h: Math.max(1, Math.min(Math.round(rect.h), height - y)) }
}

function aspectRect(width, height, ratio, gravity) {
  let w = width
  let h = Math.round(width / ratio)
  if (h > height) {
    h = height
    w = Math.round(height * ratio)
  }
  const spare = { x: width - w, y: height - h }
  const x = gravity.includes('left') ? 0 : gravity.includes('right') ? spare.x : Math.round(spare.x / 2)
  const y = gravity.includes('top') ? 0 : gravity.includes('bottom') ? spare.y : Math.round(spare.y / 2)
  return { x, y, w, h }
}

/** Finds the content box by walking in from the edges while pixels match the corner colour. */
function detectTrim(bitmap, tolerance) {
  const canvas = draw(bitmap, bitmap.width, bitmap.height)
  const g = canvas.getContext('2d')
  const { data, width, height } = g.getImageData(0, 0, canvas.width, canvas.height)
  const ref = [data[0], data[1], data[2], data[3]]

  const matches = (x, y) => {
    const i = (y * width + x) * 4
    return (
      Math.abs(data[i] - ref[0]) <= tolerance &&
      Math.abs(data[i + 1] - ref[1]) <= tolerance &&
      Math.abs(data[i + 2] - ref[2]) <= tolerance &&
      Math.abs(data[i + 3] - ref[3]) <= tolerance
    )
  }
  const rowUniform = (y) => {
    for (let x = 0; x < width; x++) if (!matches(x, y)) return false
    return true
  }
  const colUniform = (x) => {
    for (let y = 0; y < height; y++) if (!matches(x, y)) return false
    return true
  }

  let top = 0
  let bottom = height - 1
  let left = 0
  let right = width - 1
  while (top < bottom && rowUniform(top)) top++
  while (bottom > top && rowUniform(bottom)) bottom--
  while (left < right && colUniform(left)) left++
  while (right > left && colUniform(right)) right--

  return { x: left, y: top, w: Math.max(1, right - left + 1), h: Math.max(1, bottom - top + 1) }
}

function pixelate(canvas, block) {
  const small = new OffscreenCanvas(Math.max(1, Math.ceil(canvas.width / block)), Math.max(1, Math.ceil(canvas.height / block)))
  const sg = small.getContext('2d')
  sg.imageSmoothingEnabled = false
  sg.drawImage(canvas, 0, 0, small.width, small.height)

  const out = new OffscreenCanvas(canvas.width, canvas.height)
  const og = out.getContext('2d')
  og.imageSmoothingEnabled = false
  og.drawImage(small, 0, 0, canvas.width, canvas.height)
  return out
}

function sharpenKernel(amount) {
  const a = amount
  return [0, -a, 0, -a, 1 + 4 * a, -a, 0, -a, 0]
}

/** 3×3 convolution over the whole canvas. Edge pixels clamp to the border. */
function convolve(canvas, kernel) {
  const g = canvas.getContext('2d')
  const source = g.getImageData(0, 0, canvas.width, canvas.height)
  const out = new ImageData(canvas.width, canvas.height)
  const { width, height } = source

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0
      let gg = 0
      let b = 0
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const sx = Math.min(width - 1, Math.max(0, x + kx))
          const sy = Math.min(height - 1, Math.max(0, y + ky))
          const si = (sy * width + sx) * 4
          const weight = kernel[(ky + 1) * 3 + (kx + 1)]
          r += source.data[si] * weight
          gg += source.data[si + 1] * weight
          b += source.data[si + 2] * weight
        }
      }
      const di = (y * width + x) * 4
      out.data[di] = Math.max(0, Math.min(255, r))
      out.data[di + 1] = Math.max(0, Math.min(255, gg))
      out.data[di + 2] = Math.max(0, Math.min(255, b))
      out.data[di + 3] = source.data[di + 3]
    }
  }

  const result = new OffscreenCanvas(width, height)
  result.getContext('2d').putImageData(out, 0, 0)
  return result
}

/** Brettel-style LMS approximations, adequate for a design preview. */
function simulateColorBlindness(canvas, kind) {
  const MATRICES = {
    protanopia: [0.567, 0.433, 0, 0.558, 0.442, 0, 0, 0.242, 0.758],
    deuteranopia: [0.625, 0.375, 0, 0.7, 0.3, 0, 0, 0.3, 0.7],
    tritanopia: [0.95, 0.05, 0, 0, 0.433, 0.567, 0, 0.475, 0.525],
  }
  const m = MATRICES[kind]
  if (!m) return canvas

  const g = canvas.getContext('2d')
  const image = g.getImageData(0, 0, canvas.width, canvas.height)
  for (let i = 0; i < image.data.length; i += 4) {
    const r = image.data[i]
    const gg = image.data[i + 1]
    const b = image.data[i + 2]
    image.data[i] = Math.min(255, r * m[0] + gg * m[1] + b * m[2])
    image.data[i + 1] = Math.min(255, r * m[3] + gg * m[4] + b * m[5])
    image.data[i + 2] = Math.min(255, r * m[6] + gg * m[7] + b * m[8])
  }
  g.putImageData(image, 0, 0)
  return canvas
}

function roundCorners(bitmap, ratio) {
  if (ratio <= 0) return draw(bitmap, bitmap.width, bitmap.height)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const g = canvas.getContext('2d')
  const radius = Math.min(bitmap.width, bitmap.height) * ratio
  g.beginPath()
  g.roundRect(0, 0, bitmap.width, bitmap.height, radius)
  g.clip()
  g.drawImage(bitmap, 0, 0)
  return canvas
}

function roundToCircle(bitmap) {
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = new OffscreenCanvas(side, side)
  const g = canvas.getContext('2d')
  g.beginPath()
  g.arc(side / 2, side / 2, side / 2, 0, Math.PI * 2)
  g.clip()
  g.drawImage(bitmap, (side - bitmap.width) / 2, (side - bitmap.height) / 2)
  return canvas
}

function anchor(position, width, height, textWidth, fontSize, pad) {
  const right = { x: width - pad, align: 'right' }
  const left = { x: pad, align: 'left' }
  const centre = { x: width / 2, align: 'center' }
  const top = pad + fontSize / 2
  const bottom = height - pad - fontSize / 2

  if (position === 'center') return { x: centre.x, y: height / 2, align: centre.align }
  if (position === 'top-left') return { x: left.x, y: top, align: left.align }
  if (position === 'top-right') return { x: right.x, y: top, align: right.align }
  if (position === 'bottom-left') return { x: left.x, y: bottom, align: left.align }
  return { x: right.x, y: bottom, align: right.align }
}

/** Median-cut-ish palette: quantise to a coarse grid, then take the top buckets. */
function extractPalette(bitmap, count) {
  const canvas = draw(bitmap, Math.min(160, bitmap.width), Math.max(1, Math.round((Math.min(160, bitmap.width) * bitmap.height) / bitmap.width)))
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
  const buckets = new Map()

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 24) continue
    const key = `${data[i] >> 4}-${data[i + 1] >> 4}-${data[i + 2] >> 4}`
    const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 }
    bucket.r += data[i]
    bucket.g += data[i + 1]
    bucket.b += data[i + 2]
    bucket.n++
    buckets.set(key, bucket)
  }

  const total = [...buckets.values()].reduce((sum, b) => sum + b.n, 0) || 1
  return [...buckets.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, count)
    .map((b) => ({
      hex: hex(Math.round(b.r / b.n), Math.round(b.g / b.n), Math.round(b.b / b.n)),
      share: Number(((b.n / total) * 100).toFixed(1)),
    }))
}

function hex(r, g, b) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

function simplifyRatio(width, height) {
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b))
  const d = gcd(width, height) || 1
  return `${width / d}:${height / d}`
}

const EXTENSIONS = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/apng': 'png',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/tiff': 'tiff',
  'image/jxl': 'jxl',
  'image/bmp': 'bmp',
  'image/qoi': 'qoi',
}

/** `{ Name: 1 }` → `{ 1: 'Name' }`, for readable enum values in reports. */
function invert(table) {
  const out = {}
  for (const [name, value] of Object.entries(table)) if (!(value in out)) out[value] = name
  return out
}

function extensionFor(type) {
  return EXTENSIONS[type] ?? 'png'
}

function rename(name, type) {
  const extension = EXTENSIONS[type]
  const base = name.replace(/\.[^.]+$/, '')
  return extension ? `${base}.${extension}` : name
}

function suffixName(name, suffix, type) {
  const base = name.replace(/\.[^.]+$/, '')
  return `${base}${suffix}.${extensionFor(type)}`
}

function bytesLabel(value) {
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB']
  let n = value / 1024
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(1)} ${units[i]}`
}

function deltaLabel(before, after) {
  if (before <= 0) return '-'
  const pct = ((after - before) / before) * 100
  return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`
}

/* ========================================================================== */
/* Batch 2 helpers                                                            */
/* ========================================================================== */

let barcodeReady = null

/** zxing-wasm, initialised once with its WebAssembly module from the dependency assets. */
function barcodeLibrary() {
  if (!barcodeReady) {
    barcodeReady = loadDependency('zxing')
      .then(async ({ exports, assets }) => {
        await exports.prepareZXingModule({ overrides: { wasmBinary: assets['zxing_full.wasm'] }, fireImmediately: true })
        return exports
      })
      .catch((err) => {
        barcodeReady = null
        throw new Error(`条码引擎加载失败：${err && err.message ? err.message : err}`)
      })
  }
  return barcodeReady
}

function barcodeError(message, format) {
  if (/EAN13|EAN-13/.test(format)) return 'EAN-13 需要 12 或 13 位数字（第 13 位是校验位）'
  if (/EAN8/.test(format)) return 'EAN-8 需要 7 或 8 位数字'
  if (/UPCA/.test(format)) return 'UPC-A 需要 11 或 12 位数字'
  if (/Code39/.test(format) && /character|invalid/i.test(message)) return 'Code 39 只支持大写字母、数字和 - . $ / + % 空格'
  return message
}

function safeFileName(text) {
  return String(text).replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'code'
}

function cssIdent(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'item'
}

/** `#rgb`, `#rrggbb` or `#rrggbbaa` → [r, g, b, a], alpha 0–255. */
function hexToRgb(hex) {
  let h = String(hex).trim().replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = (i) => parseInt(h.slice(i, i + 2), 16)
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) return [0, 0, 0, 255]
  return [n(0), n(2), n(4), h.length === 8 ? n(6) : 255]
}

/* ---------------------------- histogram ---------------------------------- */

function histogramStats(luma, pixels) {
  if (!pixels) return { meanLuma: 0, medianLuma: 0, shadowsClipped: 0, highlightsClipped: 0 }
  let sum = 0
  let seen = 0
  let median = 0
  let p1 = 0
  let p99 = 255
  for (let v = 0; v < 256; v++) {
    sum += v * luma[v]
    const before = seen
    seen += luma[v]
    if (before < pixels * 0.01 && seen >= pixels * 0.01) p1 = v
    if (before < pixels * 0.5 && seen >= pixels * 0.5) median = v
    if (before < pixels * 0.99 && seen >= pixels * 0.99) p99 = v
  }
  let shadows = 0
  let highlights = 0
  for (let v = 0; v <= 4; v++) shadows += luma[v]
  for (let v = 251; v < 256; v++) highlights += luma[v]
  const pct = (n) => Number(((n / pixels) * 100).toFixed(2))
  return {
    meanLuma: Number((sum / pixels).toFixed(1)),
    medianLuma: median,
    range: [p1, p99],
    shadowsClipped: pct(shadows),
    highlightsClipped: pct(highlights),
    exposure: highlights / pixels > 0.02 ? '偏亮 / 过曝' : shadows / pixels > 0.05 ? '偏暗 / 欠曝' : '正常',
  }
}

function drawHistogram(bins, mode) {
  const width = 768
  const height = 320
  const canvas = new OffscreenCanvas(width, height)
  const g = canvas.getContext('2d')
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, width, height)
  g.strokeStyle = '#e5e5e5'
  for (let i = 1; i < 4; i++) {
    g.beginPath()
    g.moveTo((width * i) / 4, 0)
    g.lineTo((width * i) / 4, height)
    g.stroke()
  }
  const channels = mode === 'luma' ? [['l', 'rgba(60,60,60,0.85)']] : [['r', 'rgba(239,68,68,0.55)'], ['g', 'rgba(34,197,94,0.55)'], ['b', 'rgba(59,130,246,0.55)']]
  // Scale to the tallest interior bin: pure black / white spikes would flatten everything else.
  let peak = 1
  for (const [key] of channels) for (let v = 1; v < 255; v++) peak = Math.max(peak, bins[key][v])
  for (const [key, color] of channels) {
    g.fillStyle = color
    g.beginPath()
    g.moveTo(0, height)
    for (let v = 0; v < 256; v++) g.lineTo((v / 255) * width, height - Math.min(1, bins[key][v] / peak) * (height - 8))
    g.lineTo(width, height)
    g.closePath()
    g.fill()
  }
  return canvas
}

/* ------------------------- perceptual hashing ----------------------------- */

/**
 * pHash: 32×32 greyscale → DCT → the 8×8 lowest frequencies compared with their
 * median. Robust to resizing, recompression and small colour changes. Returns
 * 64 bits as two unsigned 32-bit words.
 */
function perceptualHash(bitmap) {
  const N = 32
  const canvas = draw(bitmap, N, N)
  const { data } = canvas.getContext('2d').getImageData(0, 0, N, N)
  const grey = new Float64Array(N * N)
  for (let i = 0; i < N * N; i++) grey[i] = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114
  const cos = []
  for (let u = 0; u < 8; u++) {
    cos.push(Float64Array.from({ length: N }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N))))
  }
  const coeffs = []
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let sum = 0
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) sum += grey[y * N + x] * cos[u][y] * cos[v][x]
      coeffs.push(sum)
    }
  }
  // Median of AC terms only: the DC term is overall brightness.
  const median = [...coeffs.slice(1)].sort((a, b) => a - b)[31]
  const words = new Uint32Array(2)
  coeffs.forEach((c, i) => {
    if (c > median) words[i >> 5] |= 1 << (i & 31)
  })
  return words
}

function hamming(a, b) {
  let bits = 0
  for (let i = 0; i < 2; i++) {
    let x = (a[i] ^ b[i]) >>> 0
    while (x) {
      x &= x - 1
      bits++
    }
  }
  return bits
}

/* ------------------------------ comparison -------------------------------- */

/** Changed-pixel mask and share, PSNR over RGB, and mean SSIM over 8×8 greyscale windows. */
function compareImages(a, b, tolerance) {
  const { width, height } = a
  const mask = new Uint8Array(width * height)
  let changed = 0
  let squared = 0
  for (let p = 0, i = 0; p < width * height; p++, i += 4) {
    const dr = a.data[i] - b.data[i]
    const dg = a.data[i + 1] - b.data[i + 1]
    const db = a.data[i + 2] - b.data[i + 2]
    squared += dr * dr + dg * dg + db * db
    if (Math.abs(dr) > tolerance || Math.abs(dg) > tolerance || Math.abs(db) > tolerance) {
      mask[p] = 1
      changed++
    }
  }
  const mse = squared / (width * height * 3)
  const grey = (d, i) => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114
  const C1 = (0.01 * 255) ** 2
  const C2 = (0.03 * 255) ** 2
  let ssim = 0
  let windows = 0
  for (let wy = 0; wy + 8 <= height; wy += 8) {
    for (let wx = 0; wx + 8 <= width; wx += 8) {
      let ma = 0, mb = 0, va = 0, vb = 0, cov = 0
      for (let y = wy; y < wy + 8; y++) {
        for (let x = wx; x < wx + 8; x++) {
          const i = (y * width + x) * 4
          ma += grey(a.data, i)
          mb += grey(b.data, i)
        }
      }
      ma /= 64
      mb /= 64
      for (let y = wy; y < wy + 8; y++) {
        for (let x = wx; x < wx + 8; x++) {
          const i = (y * width + x) * 4
          const da = grey(a.data, i) - ma
          const dbb = grey(b.data, i) - mb
          va += da * da
          vb += dbb * dbb
          cov += da * dbb
        }
      }
      va /= 63
      vb /= 63
      cov /= 63
      ssim += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2))
      windows++
    }
  }
  return {
    changedPercent: Number(((changed / (width * height)) * 100).toFixed(2)),
    meanSquaredError: Number(mse.toFixed(2)),
    psnr: mse === 0 ? null : Number((10 * Math.log10((255 * 255) / mse)).toFixed(2)),
    ssim: windows ? Number((ssim / windows).toFixed(4)) : 1,
    mask,
  }
}

/* ------------------------------- sprites ---------------------------------- */

/** Shelf packing: tallest first, rows filled left to right up to a near-square width. */
function shelfPack(images, padding) {
  const sorted = [...images].sort((a, b) => b.h - a.h)
  const area = sorted.reduce((sum, i) => sum + (i.w + padding) * (i.h + padding), 0)
  const maxWidth = Math.max(...sorted.map((i) => i.w))
  const limit = Math.max(maxWidth, Math.ceil(Math.sqrt(area) * 1.15))
  let x = 0
  let y = 0
  let row = 0
  let width = 0
  const items = []
  for (const image of sorted) {
    if (x > 0 && x + image.w > limit) {
      y += row + padding
      x = 0
      row = 0
    }
    items.push({ ...image, x, y })
    x += image.w + padding
    row = Math.max(row, image.h)
    width = Math.max(width, x - padding)
  }
  return { width, height: y + row, items }
}

/* ----------------------------- colour effects ----------------------------- */

function applyColorEffect(image, mode, p) {
  const { data, width, height } = image
  if (mode === 'replace') {
    const [fr, fg, fb] = hexToRgb(p.from)
    const [tr, tg, tb, ta] = hexToRgb(p.to)
    const max = (Math.max(0, Number(p.tolerance) || 0) / 100) * 441.7
    for (let i = 0; i < data.length; i += 4) {
      const distance = Math.hypot(data[i] - fr, data[i + 1] - fg, data[i + 2] - fb)
      if (distance > max) continue
      // Feather the outer quarter of the tolerance so anti-aliased edges blend.
      const t = max === 0 ? 1 : Math.min(1, (max - distance) / (max * 0.25))
      data[i] += (tr - data[i]) * t
      data[i + 1] += (tg - data[i + 1]) * t
      data[i + 2] += (tb - data[i + 2]) * t
      data[i + 3] += (Math.min(data[i + 3], ta) - data[i + 3]) * t
    }
  } else if (mode === 'duotone') {
    const dark = hexToRgb(p.shadow)
    const light = hexToRgb(p.light)
    for (let i = 0; i < data.length; i += 4) {
      const l = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255
      for (let c = 0; c < 3; c++) data[i + c] = dark[c] + (light[c] - dark[c]) * l
    }
  } else if (mode === 'vignette') {
    const strength = Math.max(0, Number(p.strength) || 0) / 100
    const cx = width / 2
    const cy = height / 2
    const reach = Math.hypot(cx, cy)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const d = Math.hypot(x - cx, y - cy) / reach
        const t = Math.min(1, Math.max(0, (d - 0.35) / 0.65))
        const k = 1 - strength * t * t * (3 - 2 * t)
        const i = (y * width + x) * 4
        data[i] *= k
        data[i + 1] *= k
        data[i + 2] *= k
      }
    }
  } else if (mode === 'fill') {
    const [r, g, b] = hexToRgb(p.fill)
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3] / 255
      data[i] = data[i] * a + r * (1 - a)
      data[i + 1] = data[i + 1] * a + g * (1 - a)
      data[i + 2] = data[i + 2] * a + b * (1 - a)
      data[i + 3] = 255
    }
  }
}

/* --------------------------------- text ----------------------------------- */

let cjkFamily = null

/**
 * Registers the bundled CJK font with this worker's FontFaceSet, so text drawn
 * on OffscreenCanvas looks the same on every machine instead of depending on
 * which Chinese fonts the OS happens to have. Falls back to system sans-serif.
 */
async function registerCjkFont() {
  if (cjkFamily) return cjkFamily
  try {
    const { exports: fonts, assets } = await loadDependency('cjk-font')
    const name = 'NotoSansSC-Regular.ttf'
    if (fonts[name]?.available && assets[name]?.byteLength > 1024 && typeof FontFace !== 'undefined' && self.fonts) {
      const face = new FontFace('OmniTool CJK', assets[name])
      await face.load()
      self.fonts.add(face)
      cjkFamily = '"OmniTool CJK"'
    }
  } catch {
    // Missing font: captions still render with the system font.
  }
  return cjkFamily || 'sans-serif'
}

/** Greedy wrap by measured width; CJK breaks between any characters, Latin between words. */
function wrapText(g, text, maxWidth) {
  const lines = []
  for (const paragraph of text.split(/\n/)) {
    const tokens = paragraph.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|\s+/gu) ?? ['']
    let line = ''
    for (const token of tokens) {
      const next = line + token
      if (line && g.measureText(next).width > maxWidth) {
        lines.push(line.trim())
        line = token.trimStart()
      } else {
        line = next
      }
    }
    lines.push(line.trim())
  }
  return lines.filter((l, i, all) => l || all.length === 1)
}

function drawCaption(bitmap, { top, bottom, size, color, stroke, band, family }) {
  const fontSize = Math.max(12, Math.round(bitmap.width * size))
  const lineHeight = Math.round(fontSize * 1.15)
  const pad = Math.round(fontSize * 0.35)
  const measure = new OffscreenCanvas(1, 1).getContext('2d')
  measure.font = `bold ${fontSize}px ${family}, Impact, sans-serif`
  const topLines = top ? wrapText(measure, top, bitmap.width * 0.92) : []
  const bottomLines = bottom ? wrapText(measure, bottom, bitmap.width * 0.92) : []
  const topBand = band && topLines.length ? topLines.length * lineHeight + pad * 2 : 0
  const bottomBand = band && bottomLines.length ? bottomLines.length * lineHeight + pad * 2 : 0

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height + topBand + bottomBand)
  const g = canvas.getContext('2d')
  if (band) {
    g.fillStyle = stroke
    g.fillRect(0, 0, canvas.width, canvas.height)
  }
  g.drawImage(bitmap, 0, topBand)
  g.font = measure.font
  g.textAlign = 'center'
  g.textBaseline = 'top'
  g.lineJoin = 'round'
  g.lineWidth = band ? 0 : Math.max(2, fontSize / 7)
  g.strokeStyle = stroke
  g.fillStyle = color
  const paint = (lines, startY) => {
    lines.forEach((line, i) => {
      const y = startY + i * lineHeight
      if (!band) g.strokeText(line, canvas.width / 2, y)
      g.fillText(line, canvas.width / 2, y)
    })
  }
  paint(topLines, pad)
  paint(bottomLines, canvas.height - bottomLines.length * lineHeight - pad)
  return canvas
}

/** Backdrops for screenshot beautification: two-stop diagonal gradients. */
const BACKDROPS = {
  ocean: ['#2563eb', '#06b6d4'],
  sunset: ['#f97316', '#db2777'],
  mint: ['#34d399', '#0ea5e9'],
  violet: ['#7c3aed', '#ec4899'],
  graphite: ['#374151', '#111827'],
}

/**
 * Image watermark: the first input is the logo, every other input receives it.
 * The logo keeps its aspect ratio; its width is a share of each target's width,
 * so one setting suits a batch of differently sized photos.
 */
async function watermarkWithLogo(ctx) {
  const p = ctx.params
  if (ctx.inputs.length < 2) throw new Error('图片水印需要至少两个文件：第一个是 Logo，其余是要加水印的图片')
  const [logoRef, ...targets] = ctx.inputs
  const logo = await decode(await host.fs.readAll(logoRef.id), typeOf(logoRef))
  const outputs = []
  try {
    for (const [index, input] of targets.entries()) {
      ctx.throwIfAborted()
      ctx.progress(index / targets.length, `正在处理 ${input.name}`)
      const bytes = await host.fs.readAll(input.id)
      await noteFirstFrame(ctx, input, bytes)
      const bitmap = await decode(bytes, typeOf(input))
      const canvas = draw(bitmap, bitmap.width, bitmap.height)
      bitmap.close()
      const g = canvas.getContext('2d')
      const w = Math.max(8, Math.round((canvas.width * Number(p.logoSize)) / 100))
      const h = Math.max(1, Math.round((w * logo.height) / logo.width))
      const angle = (Number(p.rotate) * Math.PI) / 180
      g.globalAlpha = Math.max(0.05, Number(p.opacity) / 100)
      g.imageSmoothingQuality = 'high'

      if (p.position === 'tile') {
        const reach = Math.hypot(canvas.width, canvas.height)
        g.save()
        g.rotate(angle)
        for (let y = -reach; y < reach; y += h * 2.4) {
          for (let x = -reach; x < reach; x += w * 1.9) g.drawImage(logo, x, y, w, h)
        }
        g.restore()
      } else {
        const pad = Math.round(Math.min(canvas.width, canvas.height) * 0.03)
        const cx = { left: pad + w / 2, right: canvas.width - pad - w / 2, center: canvas.width / 2 }
        const cy = { top: pad + h / 2, bottom: canvas.height - pad - h / 2, center: canvas.height / 2 }
        const [vertical, horizontal] = String(p.position) === 'center' ? ['center', 'center'] : String(p.position).split('-')
        g.save()
        g.translate(cx[horizontal] ?? cx.right, cy[vertical] ?? cy.bottom)
        g.rotate(angle)
        g.drawImage(logo, -w / 2, -h / 2, w, h)
        g.restore()
      }
      g.globalAlpha = 1

      const type = resolveTarget(p.format, input)
      outputs.push((await host.fs.writeAll(suffixName(input.name, '-watermarked', type), await encode(canvas, type, Number(p.quality) / 100), type)).id)
    }
  } finally {
    logo.close()
  }
  ctx.progress(1)
  return { outputs, summary: `已为 ${outputs.length} 张图片添加 Logo 水印` }
}

/** Title-bar controls: traffic lights on the left (macOS) or glyphs on the right (Windows). */
function drawWindowControls(g, style, x, y, width, height) {
  const cy = y + height / 2
  if (style === 'mac') {
    const r = height * 0.18
    ;['#ff5f57', '#febc2e', '#28c840'].forEach((color, i) => {
      g.fillStyle = color
      g.beginPath()
      g.arc(x + height * 0.6 + i * r * 3.2, cy, r, 0, Math.PI * 2)
      g.fill()
    })
    return
  }
  const size = height * 0.28
  const step = height * 1.1
  g.strokeStyle = '#374151'
  g.lineWidth = Math.max(1, height / 20)
  const right = x + width - step * 0.6
  g.beginPath()
  g.moveTo(right - size / 2, cy - size / 2)
  g.lineTo(right + size / 2, cy + size / 2)
  g.moveTo(right + size / 2, cy - size / 2)
  g.lineTo(right - size / 2, cy + size / 2)
  g.stroke()
  g.strokeRect(right - step - size / 2, cy - size / 2, size, size)
  g.beginPath()
  g.moveTo(right - step * 2 - size / 2, cy)
  g.lineTo(right - step * 2 + size / 2, cy)
  g.stroke()
}

/* ========================================================================== */
/* Scanned photo detection                                                    */
/* ========================================================================== */

/**
 * Finds photos lying on a scanner bed in RGBA pixels (a downscaled scan).
 * Returns rotated rectangles `{ cx, cy, width, height, angle }` in the same
 * pixel space, angle in radians within ±45°, in reading order.
 *
 *   1. The bed colour is the median of the border pixels.
 *   2. Pixels differing from it are foreground; a closing bridges pale areas
 *      inside a photo and holes are filled from the border.
 *   3. Each large connected component's minimum-area rectangle, from its
 *      convex hull by rotating calipers, is the photo.
 */
function detectPhotos(data, width, height, { threshold = 28, minArea = 0.03 } = {}) {
  const bed = borderMedian(data, width, height)
  let mask = new Uint8Array(width * height)
  for (let i = 0, p = 0; p < mask.length; i += 4, p++) {
    const diff = Math.max(Math.abs(data[i] - bed[0]), Math.abs(data[i + 1] - bed[1]), Math.abs(data[i + 2] - bed[2]))
    mask[p] = diff > threshold ? 1 : 0
  }
  const radius = Math.max(1, Math.round(Math.max(width, height) / 200))
  mask = boxMorph(boxMorph(mask, width, height, radius, true), width, height, radius, false)
  fillHoles(mask, width, height)

  const labels = new Int32Array(width * height)
  const photos = []
  const stack = []
  let next = 0
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue
    next++
    labels[start] = next
    stack.push(start)
    let area = 0
    // Extremes per row are enough for the convex hull.
    const rowMin = new Map()
    const rowMax = new Map()
    while (stack.length) {
      const p = stack.pop()
      area++
      const x = p % width
      const y = (p - x) / width
      if (!rowMin.has(y) || x < rowMin.get(y)) rowMin.set(y, x)
      if (!rowMax.has(y) || x > rowMax.get(y)) rowMax.set(y, x)
      if (x > 0 && mask[p - 1] && !labels[p - 1]) (labels[p - 1] = next), stack.push(p - 1)
      if (x < width - 1 && mask[p + 1] && !labels[p + 1]) (labels[p + 1] = next), stack.push(p + 1)
      if (y > 0 && mask[p - width] && !labels[p - width]) (labels[p - width] = next), stack.push(p - width)
      if (y < height - 1 && mask[p + width] && !labels[p + width]) (labels[p + width] = next), stack.push(p + width)
    }
    if (area < minArea * width * height) continue
    const points = []
    for (const [y, x] of rowMin) {
      // Pixel corners, so a one-pixel-wide row still has extent.
      points.push([x, y], [x, y + 1], [rowMax.get(y) + 1, y], [rowMax.get(y) + 1, y + 1])
    }
    const rect = minAreaRect(convexHull(points))
    // A component that barely fills its rectangle is clutter, not a photo.
    if (area < rect.width * rect.height * 0.6) continue
    photos.push(rect)
  }
  return readingOrder(photos)
}

function borderMedian(data, width, height) {
  const channels = [[], [], []]
  const step = Math.max(1, Math.floor((width + height) / 400))
  const sample = (x, y) => {
    const i = (y * width + x) * 4
    for (let c = 0; c < 3; c++) channels[c].push(data[i + c])
  }
  for (let x = 0; x < width; x += step) sample(x, 0), sample(x, height - 1)
  for (let y = 0; y < height; y += step) sample(0, y), sample(width - 1, y)
  return channels.map((values) => values.sort((a, b) => a - b)[values.length >> 1])
}

/** Square dilation (`grow`) or erosion by `radius`, separable via running counts. */
function boxMorph(mask, width, height, radius, grow) {
  const pass = (source, horizontal) => {
    const out = new Uint8Array(source.length)
    const outer = horizontal ? height : width
    const inner = horizontal ? width : height
    const at = (o, i) => (horizontal ? o * width + i : i * width + o)
    for (let o = 0; o < outer; o++) {
      let count = 0
      // Window [i - radius, i + radius]; out-of-range counts as background for
      // dilation and as foreground for erosion so edges are not eaten.
      for (let i = -radius; i <= radius; i++) count += i < 0 || i >= inner ? (grow ? 0 : 1) : source[at(o, i)]
      for (let i = 0; i < inner; i++) {
        out[at(o, i)] = grow ? (count > 0 ? 1 : 0) : count === radius * 2 + 1 ? 1 : 0
        const leaving = i - radius
        const entering = i + radius + 1
        count -= leaving < 0 ? (grow ? 0 : 1) : source[at(o, leaving)]
        count += entering >= inner ? (grow ? 0 : 1) : source[at(o, entering)]
      }
    }
    return out
  }
  return pass(pass(mask, true), false)
}

/** Sets background pixels not reachable from the border (holes) to foreground. */
function fillHoles(mask, width, height) {
  const outside = new Uint8Array(mask.length)
  const stack = []
  const push = (p) => {
    if (!mask[p] && !outside[p]) (outside[p] = 1), stack.push(p)
  }
  for (let x = 0; x < width; x++) push(x), push((height - 1) * width + x)
  for (let y = 0; y < height; y++) push(y * width), push(y * width + width - 1)
  while (stack.length) {
    const p = stack.pop()
    const x = p % width
    if (x > 0) push(p - 1)
    if (x < width - 1) push(p + 1)
    if (p >= width) push(p - width)
    if (p < mask.length - width) push(p + width)
  }
  for (let p = 0; p < mask.length; p++) if (!outside[p]) mask[p] = 1
}

/** Andrew's monotone chain; counter-clockwise in y-down space is irrelevant here. */
function convexHull(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

/** Minimum-area enclosing rectangle of a convex polygon: one side lies on a hull edge. */
function minAreaRect(hull) {
  let best = null
  for (let i = 0; i < hull.length; i++) {
    const [x1, y1] = hull[i]
    const [x2, y2] = hull[(i + 1) % hull.length]
    const theta = Math.atan2(y2 - y1, x2 - x1)
    const cos = Math.cos(theta)
    const sin = Math.sin(theta)
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
    for (const [x, y] of hull) {
      const u = x * cos + y * sin
      const v = -x * sin + y * cos
      if (u < minU) minU = u
      if (u > maxU) maxU = u
      if (v < minV) minV = v
      if (v > maxV) maxV = v
    }
    const area = (maxU - minU) * (maxV - minV)
    if (!best || area < best.area - 1e-9) best = { area, theta, minU, maxU, minV, maxV }
  }
  if (!best) return { cx: 0, cy: 0, width: 0, height: 0, angle: 0 }
  const u = (best.minU + best.maxU) / 2
  const v = (best.minV + best.maxV) / 2
  const cos = Math.cos(best.theta)
  const sin = Math.sin(best.theta)
  let width = best.maxU - best.minU
  let height = best.maxV - best.minV
  // Fold the angle into ±45°; a quarter turn swaps the sides.
  let angle = best.theta
  while (angle > Math.PI / 4) (angle -= Math.PI / 2), ([width, height] = [height, width])
  while (angle <= -Math.PI / 4) (angle += Math.PI / 2), ([width, height] = [height, width])
  return { cx: u * cos - v * sin, cy: u * sin + v * cos, width, height, angle }
}

function axisAlignedBounds(rect) {
  const cos = Math.abs(Math.cos(rect.angle))
  const sin = Math.abs(Math.sin(rect.angle))
  return { cx: rect.cx, cy: rect.cy, width: rect.width * cos + rect.height * sin, height: rect.width * sin + rect.height * cos, angle: 0 }
}

/** Rows top to bottom (photos whose centres overlap vertically share a row), then left to right. */
function readingOrder(rects) {
  const sorted = [...rects].sort((a, b) => a.cy - b.cy)
  const rows = []
  for (const rect of sorted) {
    const row = rows[rows.length - 1]
    if (row && Math.abs(rect.cy - row[0].cy) < Math.min(rect.height, row[0].height) / 2) row.push(rect)
    else rows.push([rect])
  }
  return rows.flatMap((row) => row.sort((a, b) => a.cx - b.cx))
}

/* ========================================================================== */
/* Seam carving                                                               */
/* ========================================================================== */

const SEAM_MAX_PIXELS = 2_000_000

/** RGBA image with rows and columns swapped, so vertical-seam code also removes rows. */
function transpose({ data, width, height }) {
  const out = new Uint8ClampedArray(data.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4
      const to = (x * height + y) * 4
      out[to] = data[from]
      out[to + 1] = data[from + 1]
      out[to + 2] = data[from + 2]
      out[to + 3] = data[from + 3]
    }
  }
  return { data: out, width: height, height: width }
}

/**
 * Removes `count` vertical seams of least energy (Avidan & Shamir). Energy is
 * the gradient magnitude of luminance; each seam is found by dynamic
 * programming over 8-connected paths, then deleted row by row.
 */
function carveSeams(image, count, onSeam = () => {}) {
  let { data, width, height } = image
  count = Math.max(0, Math.min(count, width - 1))
  let luma = new Float32Array(width * height)
  for (let i = 0, p = 0; p < luma.length; i += 4, p++) luma[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
  const cost = new Float32Array(width * height)
  const seam = new Int32Array(height)

  for (let n = 0; n < count; n++) {
    onSeam(n, count)
    const w = width
    const at = (x, y) => luma[y * w + Math.min(w - 1, Math.max(0, x))]
    for (let y = 0; y < height; y++) {
      const up = Math.max(0, y - 1)
      const down = Math.min(height - 1, y + 1)
      for (let x = 0; x < w; x++) {
        const energy = Math.abs(at(x + 1, y) - at(x - 1, y)) + Math.abs(luma[down * w + x] - luma[up * w + x])
        if (y === 0) {
          cost[x] = energy
          continue
        }
        const row = (y - 1) * w
        let best = cost[row + x]
        if (x > 0 && cost[row + x - 1] < best) best = cost[row + x - 1]
        if (x < w - 1 && cost[row + x + 1] < best) best = cost[row + x + 1]
        cost[y * w + x] = energy + best
      }
    }
    // Trace back from the cheapest bottom cell.
    let x = 0
    const last = (height - 1) * w
    for (let i = 1; i < w; i++) if (cost[last + i] < cost[last + x]) x = i
    seam[height - 1] = x
    for (let y = height - 2; y >= 0; y--) {
      const row = y * w
      let next = x
      if (x > 0 && cost[row + x - 1] < cost[row + next]) next = x - 1
      if (x < w - 1 && cost[row + x + 1] < cost[row + next]) next = x + 1
      x = next
      seam[y] = x
    }
    // Delete the seam from pixels and luminance, compacting in place.
    const nextData = new Uint8ClampedArray((w - 1) * height * 4)
    const nextLuma = new Float32Array((w - 1) * height)
    for (let y = 0; y < height; y++) {
      const cut = seam[y]
      const src = y * w
      const dst = y * (w - 1)
      nextData.set(data.subarray(src * 4, (src + cut) * 4), dst * 4)
      nextData.set(data.subarray((src + cut + 1) * 4, (src + w) * 4), (dst + cut) * 4)
      nextLuma.set(luma.subarray(src, src + cut), dst)
      nextLuma.set(luma.subarray(src + cut + 1, src + w), dst + cut)
    }
    data = nextData
    luma = nextLuma
    width = w - 1
  }
  return { data, width, height }
}

/* ========================================================================== */
/* Guided filter denoise                                                      */
/* ========================================================================== */

/** Mean over a (2r+1)² box with edge clamping, via a summed-area table. */
function boxMean(src, width, height, r) {
  const sums = new Float64Array((width + 1) * (height + 1))
  for (let y = 0; y < height; y++) {
    let row = 0
    for (let x = 0; x < width; x++) {
      row += src[y * width + x]
      sums[(y + 1) * (width + 1) + x + 1] = sums[y * (width + 1) + x + 1] + row
    }
  }
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - r)
    const y1 = Math.min(height, y + r + 1)
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - r)
      const x1 = Math.min(width, x + r + 1)
      const total = sums[y1 * (width + 1) + x1] - sums[y0 * (width + 1) + x1] - sums[y1 * (width + 1) + x0] + sums[y0 * (width + 1) + x0]
      out[y * width + x] = total / ((y1 - y0) * (x1 - x0))
    }
  }
  return out
}

/**
 * Self-guided filter (He, Sun & Tang) on each RGB channel in place: flat areas
 * are averaged, edges (local variance well above `eps`) pass through. `detail`
 * blends some of the original back in.
 */
function denoiseGuided(data, width, height, r, eps, detail) {
  const plane = width * height
  const channel = new Float32Array(plane)
  const square = new Float32Array(plane)
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < plane; i++) {
      const v = data[i * 4 + c] / 255
      channel[i] = v
      square[i] = v * v
    }
    const mean = boxMean(channel, width, height, r)
    const meanSquare = boxMean(square, width, height, r)
    const a = new Float32Array(plane)
    const b = new Float32Array(plane)
    for (let i = 0; i < plane; i++) {
      const variance = meanSquare[i] - mean[i] * mean[i]
      a[i] = variance / (variance + eps)
      b[i] = mean[i] - a[i] * mean[i]
    }
    const meanA = boxMean(a, width, height, r)
    const meanB = boxMean(b, width, height, r)
    for (let i = 0; i < plane; i++) {
      const filtered = meanA[i] * channel[i] + meanB[i]
      data[i * 4 + c] = Math.round((filtered * (1 - detail) + channel[i] * detail) * 255)
    }
  }
}
