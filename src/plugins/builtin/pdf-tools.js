/* eslint-disable */
/**
 * Built-in plugin: PDF toolbox.
 *
 * Injected dependencies do the work, all served from our own origin so the app
 * stays offline-capable:
 *   - pdf-lib  structural edits (merge, split, rotate, stamp, metadata, repair)
 *   - pdf.js   rendering and text extraction
 *   - qpdf     (wasm, lazy) encryption, decryption, linearisation, checks
 *
 * Honest limits, stated where a user would otherwise be surprised:
 *   - "Compress" re-encodes embedded raster images. It cannot restructure fonts
 *     the way Ghostscript does, so text-only PDFs barely move.
 *   - The qpdf build cannot run qpdf's own damaged-file recovery (it is compiled
 *     without C++ exception catching), so `repair` rebuilds with pdf-lib's
 *     tolerant parser and uses qpdf to verify the result.
 */
definePlugin({
  id: 'omnitool.pdf',
  name: 'PDF 工具箱',
  version: '3.0.0',
  author: 'OmniTool',
  description: '合并、拆分、重排、水印、转图片、清理、叠加、附件、小册子、书签、比较——文件不离开浏览器。',
  icon: 'file-text',
  capabilities: ['fs', 'ui'],

  deps: [
    { id: 'pdf-lib', url: '/vendor/pdf-lib.js', global: 'PDFLib' },
    { id: 'pdfjs', url: '/vendor/pdfjs.js', global: 'pdfjsLib' },
    { id: 'pdfjs-worker', url: '/vendor/pdfjs-worker.js', global: 'pdfjsWorker' },
    // Chinese text in stamps and form fields; loaded only when needed.
    { id: 'fontkit', url: '/vendor/fontkit.js', global: 'fontkit', lazy: true },
    { id: 'cjk-font', url: '/vendor/fonts/fonts.js', global: 'OMNITOOL_FONTS', lazy: true, assets: { 'NotoSansSC-Regular.ttf': { url: '/vendor/fonts/NotoSansSC-Regular.ttf' } } },
    { id: 'qpdf', url: '/vendor/qpdf/qpdf.js', global: 'QpdfWasm', lazy: true, assets: { 'qpdf.wasm': { url: '/vendor/qpdf/qpdf.wasm' } } },
  ],

  tools: [
    /* ------------------------------------------------------------------ */
    {
      id: 'merge',
      name: 'PDF 合并',
      category: 'pdf',
      icon: 'combine',
      description: '按拖入顺序把多个 PDF 合并为一个文件。',
      accept: ['application/pdf', '.pdf'],
      multiple: true,
      minFiles: 2,
      keywords: ['merge', 'combine', 'join', '合并', '拼接'],
      params: [
        { key: 'outputName', type: 'text', label: '输出文件名', default: 'merged.pdf' },
        { key: 'reverse', type: 'switch', label: '倒序合并', default: false },
        { key: 'outline', type: 'switch', label: '为每个文件建立书签', default: true },
      ],

      async run(ctx) {
        requirePdfLib()
        const order = ctx.params.reverse ? ctx.inputs.slice().reverse() : ctx.inputs
        const merged = await PDFLib.PDFDocument.create()
        let pageCount = 0

        for (const [index, ref] of order.entries()) {
          ctx.throwIfAborted()
          ctx.progress(index / order.length, `正在读取 ${ref.name}`)
          const source = await loadPdf(ref)
          const copied = await merged.copyPages(source, source.getPageIndices())
          for (const page of copied) merged.addPage(page)
          pageCount += copied.length
        }

        ctx.progress(0.95, '正在写出文件')
        const out = await host.fs.writeAll(ensurePdf(String(ctx.params.outputName || 'merged.pdf')), await merged.save(), 'application/pdf')
        ctx.progress(1)
        return { outputs: [out.id], summary: `已合并 ${order.length} 个文件，共 ${pageCount} 页` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'split',
      name: 'PDF 拆分与提取',
      category: 'pdf',
      icon: 'scissors',
      description: '按页码范围提取、每 N 页切一份，或逐页拆开。',
      accept: ['application/pdf', '.pdf'],
      multiple: true,
      keywords: ['split', 'extract', 'pages', '拆分', '提取', '页面', '分割'],
      params: [
        {
          key: 'mode', type: 'select', label: '拆分方式', default: 'ranges',
          options: [
            { value: 'ranges', label: '按页码范围' }, { value: 'every', label: '每 N 页一份' },
            { value: 'each', label: '每页一个文件' }, { value: 'half', label: '从中间对半分' },
          ],
        },
        { key: 'ranges', type: 'text', label: '页码范围', default: '1-', placeholder: '如 1-3,7,10-', hint: '页码从 1 开始，留空的结束页表示到最后一页。', when: { key: 'mode', equals: 'ranges' } },
        { key: 'chunk', type: 'number', label: '每份页数', default: 10, min: 1, when: { key: 'mode', equals: 'every' } },
        { key: 'separate', type: 'switch', label: '每个范围单独输出', default: false, when: { key: 'mode', equals: 'ranges' } },
      ],

      async run(ctx) {
        requirePdfLib()
        const outputs = []
        let totalPages = 0

        for (const [index, ref] of ctx.inputs.entries()) {
          ctx.throwIfAborted()
          ctx.progress(index / ctx.inputs.length, `正在处理 ${ref.name}`)

          const source = await loadPdf(ref)
          const total = source.getPageCount()
          const base = ref.name.replace(/\.pdf$/i, '')
          let groups

          if (ctx.params.mode === 'each') {
            groups = Array.from({ length: total }, (_, i) => [i])
          } else if (ctx.params.mode === 'every') {
            const size = Math.max(1, Number(ctx.params.chunk) || 1)
            groups = []
            for (let i = 0; i < total; i += size) groups.push(range(i, Math.min(i + size, total)))
          } else if (ctx.params.mode === 'half') {
            const mid = Math.ceil(total / 2)
            groups = [range(0, mid), range(mid, total)].filter((g) => g.length > 0)
          } else {
            const parsed = parseRanges(String(ctx.params.ranges || '1-'), total)
            if (parsed.length === 0) throw new Error(`${ref.name}：页码范围没有匹配到任何页面（共 ${total} 页）`)
            groups = ctx.params.separate ? parsed : [parsed.flat()]
          }

          for (const [groupIndex, pages] of groups.entries()) {
            if (pages.length === 0) continue
            const label = pages.length === 1 ? `p${pages[0] + 1}` : `${pages[0] + 1}-${pages[pages.length - 1] + 1}`
            const suffix = groups.length === 1 ? '-extracted' : `-${label}`
            const bytes = await extractPages(source, pages)
            outputs.push((await host.fs.writeAll(`${base}${suffix}.pdf`, bytes, 'application/pdf')).id)
            totalPages += pages.length
          }
        }

        ctx.progress(1)
        return { outputs, summary: `已提取 ${totalPages} 页，生成 ${outputs.length} 个文件` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'organize',
      name: '页面重排',
      category: 'pdf',
      icon: 'list-ordered',
      description: '按自定义顺序重排、删除页面或反转页序。',
      accept: ['application/pdf', '.pdf'],
      multiple: true,
      keywords: ['organize', 'reorder', 'remove', 'delete', 'reverse', '重排', '删除页面', '倒序'],
      params: [
        {
          key: 'mode', type: 'select', label: '操作', default: 'remove',
          options: [
            { value: 'remove', label: '删除指定页面' }, { value: 'keep', label: '只保留指定页面' },
            { value: 'order', label: '按指定顺序重排' }, { value: 'reverse', label: '反转页序' },
            { value: 'odd', label: '只保留奇数页' }, { value: 'even', label: '只保留偶数页' },
          ],
        },
        { key: 'pages', type: 'text', label: '页码', default: '', placeholder: '如 1,3,5-8', when: { key: 'mode', equals: ['remove', 'keep', 'order'] } },
      ],

      async run(ctx) {
        requirePdfLib()
        const outputs = []

        for (const [index, ref] of ctx.inputs.entries()) {
          ctx.throwIfAborted()
          ctx.progress(index / ctx.inputs.length, `正在处理 ${ref.name}`)

          const source = await loadPdf(ref)
          const total = source.getPageCount()
          const listed = String(ctx.params.pages || '').trim() ? parseRanges(String(ctx.params.pages), total).flat() : []
          let pages

          switch (ctx.params.mode) {
            case 'remove': {
              const drop = new Set(listed)
              pages = range(0, total).filter((i) => !drop.has(i))
              break
            }
            case 'keep':
              pages = listed
              break
            case 'order':
              pages = listed
              break
            case 'reverse':
              pages = range(0, total).reverse()
              break
            case 'odd':
              pages = range(0, total).filter((i) => i % 2 === 0)
              break
            default:
              pages = range(0, total).filter((i) => i % 2 === 1)
          }

          if (pages.length === 0) throw new Error(`${ref.name}：操作后没有剩余页面`)
          const bytes = await extractPages(source, pages)
          outputs.push((await host.fs.writeAll(`${ref.name.replace(/\.pdf$/i, '')}-organized.pdf`, bytes, 'application/pdf')).id)
        }

        ctx.progress(1)
        return { outputs, summary: `已重排 ${outputs.length} 个文件` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'rotate',
      name: '旋转页面',
      category: 'pdf',
      icon: 'refresh',
      description: '整体或按页码范围旋转页面。',
      accept: ['application/pdf', '.pdf'],
      multiple: true,
      keywords: ['rotate', '旋转', '横版', '竖版'],
      params: [
        {
          key: 'angle', type: 'select', label: '旋转角度', default: '90',
          options: [{ value: '90', label: '顺时针 90°' }, { value: '180', label: '180°' }, { value: '270', label: '逆时针 90°' }],
        },
        { key: 'pages', type: 'text', label: '应用页码', default: '', placeholder: '留空表示全部', hint: '如 1-3,7' },
      ],

      async run(ctx) {
        requirePdfLib()
        const outputs = []
        const angle = Number(ctx.params.angle) || 90

        for (const ref of ctx.inputs) {
          ctx.throwIfAborted()
          const doc = await loadPdf(ref)
          const total = doc.getPageCount()
          const target = String(ctx.params.pages || '').trim()
            ? new Set(parseRanges(String(ctx.params.pages), total).flat())
            : new Set(range(0, total))

          doc.getPages().forEach((page, index) => {
            if (!target.has(index)) return
            // Rotation is cumulative with whatever the page already carried.
            const current = page.getRotation().angle
            page.setRotation(PDFLib.degrees((current + angle) % 360))
          })

          outputs.push((await host.fs.writeAll(`${ref.name.replace(/\.pdf$/i, '')}-rotated.pdf`, await doc.save(), 'application/pdf')).id)
        }

        ctx.progress(1)
        return { outputs, summary: `已旋转 ${outputs.length} 个文件` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'watermark',
      name: 'PDF 水印与页码',
      category: 'pdf',
      icon: 'stamp',
      description: '叠加文字水印，或在页脚添加页码。',
      accept: ['application/pdf', '.pdf'],
      multiple: true,
      keywords: ['watermark', 'stamp', 'page number', '水印', '页码', '编号'],
      params: [
        { key: 'watermark', type: 'text', label: '水印文字', default: '', placeholder: '留空表示不加水印' },
        { key: 'size', type: 'number', label: '水印字号', default: 48, min: 6, max: 200, suffix: 'pt', when: { key: 'watermark', equals: undefined } },
        { key: 'opacity', type: 'slider', label: '水印不透明度', min: 5, max: 100, default: 15, suffix: '%' },
        { key: 'rotate', type: 'slider', label: '水印角度', min: -90, max: 90, default: 45, suffix: '°' },
        { key: 'pageNumbers', type: 'switch', label: '添加页码', default: false },
        {
          key: 'numberFormat', type: 'select', label: '页码格式', default: 'n',
          options: [{ value: 'n', label: '1' }, { value: 'n/total', label: '1 / 10' }, { value: 'page-n', label: '第 1 页' }],
          when: { key: 'pageNumbers', equals: true },
        },
        {
          key: 'numberPosition', type: 'select', label: '页码位置', default: 'bottom-center',
          options: [
            { value: 'bottom-center', label: '页脚居中' }, { value: 'bottom-right', label: '页脚右侧' },
            { value: 'bottom-left', label: '页脚左侧' }, { value: 'top-center', label: '页眉居中' },
          ],
          when: { key: 'pageNumbers', equals: true },
        },
        { key: 'startAt', type: 'number', label: '起始页码', default: 1, min: 1, when: { key: 'pageNumbers', equals: true } },
      ],

      async run(ctx) {
        requirePdfLib()
        const p = ctx.params
        const text = String(p.watermark || '').trim()
        if (!text && !p.pageNumbers) throw new Error('请至少填写水印文字或开启页码')

        const outputs = []
        for (const ref of ctx.inputs) {
          ctx.throwIfAborted()
          const doc = await loadPdf(ref)
          const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica)
          const pages = doc.getPages()

          pages.forEach((page, index) => {
            const { width, height } = page.getSize()

            if (text) {
              const size = Number(p.size) || 48
              const textWidth = font.widthOfTextAtSize(text, size)
              page.drawText(text, {
                x: width / 2 - textWidth / 2,
                y: height / 2,
                size,
                font,
                color: PDFLib.rgb(0.45, 0.45, 0.45),
                opacity: Number(p.opacity) / 100,
                rotate: PDFLib.degrees(Number(p.rotate) || 0),
              })
            }

            if (p.pageNumbers) {
              const n = index + (Number(p.startAt) || 1)
              const label =
                p.numberFormat === 'n/total' ? `${n} / ${pages.length}` : p.numberFormat === 'page-n' ? `Page ${n}` : String(n)
              const size = 10
              const labelWidth = font.widthOfTextAtSize(label, size)
              const x =
                p.numberPosition === 'bottom-left' ? 40 : p.numberPosition === 'bottom-right' ? width - 40 - labelWidth : width / 2 - labelWidth / 2
              const y = p.numberPosition === 'top-center' ? height - 30 : 24
              page.drawText(label, { x, y, size, font, color: PDFLib.rgb(0.35, 0.35, 0.35) })
            }
          })

          outputs.push((await host.fs.writeAll(`${ref.name.replace(/\.pdf$/i, '')}-stamped.pdf`, await doc.save(), 'application/pdf')).id)
        }

        ctx.progress(1)
        return { outputs, summary: `已处理 ${outputs.length} 个文件` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'nup',
      name: '多页合一 / 小册子',
      category: 'pdf',
      icon: 'layout-grid',
      description: '把多页拼到一页（N-up），用于省纸打印。',
      accept: ['application/pdf', '.pdf'],
      multiple: true,
      keywords: ['nup', 'n-up', 'booklet', 'imposition', '多页合一', '拼版', '小册子', '省纸'],
      params: [
        {
          key: 'perSheet', type: 'select', label: '每页容纳', default: '2',
          options: [{ value: '2', label: '2 页' }, { value: '4', label: '4 页' }, { value: '6', label: '6 页' }, { value: '9', label: '9 页' }],
        },
        {
          key: 'orientation', type: 'select', label: '纸张方向', default: 'auto',
          options: [{ value: 'auto', label: '自动' }, { value: 'portrait', label: '纵向' }, { value: 'landscape', label: '横向' }],
        },
        { key: 'gap', type: 'number', label: '间距', default: 8, min: 0, suffix: 'pt' },
      ],

      async run(ctx) {
        requirePdfLib()
        const outputs = []
        const perSheet = Number(ctx.params.perSheet) || 2
        const LAYOUT = { 2: [1, 2], 4: [2, 2], 6: [2, 3], 9: [3, 3] }
        const [cols, rows] = LAYOUT[perSheet] ?? [1, 2]
        const gap = Math.max(0, Number(ctx.params.gap) || 0)

        for (const [fileIndex, ref] of ctx.inputs.entries()) {
          ctx.throwIfAborted()
          ctx.progress(fileIndex / ctx.inputs.length, `正在拼版 ${ref.name}`)

          const source = await loadPdf(ref)
          const target = await PDFLib.PDFDocument.create()
          const total = source.getPageCount()
          const first = source.getPage(0).getSize()

          // Sheet orientation defaults to whatever makes the tiles least squashed.
          const landscape =
            ctx.params.orientation === 'landscape' ||
            (ctx.params.orientation === 'auto' && cols >= rows && perSheet === 2)
          const sheetW = landscape ? Math.max(first.width, first.height) : Math.min(first.width, first.height)
          const sheetH = landscape ? Math.min(first.width, first.height) : Math.max(first.width, first.height)

          const cellW = (sheetW - gap * (cols + 1)) / cols
          const cellH = (sheetH - gap * (rows + 1)) / rows

          for (let start = 0; start < total; start += perSheet) {
            const indices = range(start, Math.min(start + perSheet, total))
            const embedded = await target.embedPdf(source, indices)
            const sheet = target.addPage([sheetW, sheetH])

            embedded.forEach((page, slot) => {
              const col = slot % cols
              const row = Math.floor(slot / cols)
              const scale = Math.min(cellW / page.width, cellH / page.height)
              const w = page.width * scale
              const h = page.height * scale
              sheet.drawPage(page, {
                x: gap + col * (cellW + gap) + (cellW - w) / 2,
                // PDF's origin is bottom-left, so rows count up from the bottom.
                y: sheetH - gap - (row + 1) * cellH - row * gap + (cellH - h) / 2,
                width: w,
                height: h,
              })
            })
          }

          outputs.push((await host.fs.writeAll(`${ref.name.replace(/\.pdf$/i, '')}-${perSheet}up.pdf`, await target.save(), 'application/pdf')).id)
        }

        ctx.progress(1)
        return { outputs, summary: `已生成 ${outputs.length} 个拼版文件（每页 ${perSheet} 页）` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'to-image',
      name: 'PDF 转图片',
      category: 'pdf',
      icon: 'image',
      description: '把每页渲染为 PNG / JPEG / WebP，也可拼成一张长图。',
      accept: ['application/pdf', '.pdf'],
      multiple: true,
      keywords: ['render', 'png', 'jpg', 'image', 'screenshot', '转图片', '长图', '截图'],
      params: [
        { key: 'dpi', type: 'slider', label: '渲染精度', min: 72, max: 300, step: 6, default: 144, suffix: 'dpi', hint: '数值越高越清晰，也越慢越占内存。' },
        { key: 'pages', type: 'text', label: '页码范围', default: '1-', placeholder: '如 1-3,7' },
        { key: 'format', type: 'select', label: '输出格式', default: 'image/png', options: [{ value: 'image/png', label: 'PNG' }, { value: 'image/jpeg', label: 'JPEG' }, { value: 'image/webp', label: 'WebP' }] },
        { key: 'quality', type: 'slider', label: '质量', min: 1, max: 100, default: 90, suffix: '%' },
        { key: 'longImage', type: 'switch', label: '拼成一张长图', default: false, hint: '把所有页面纵向拼接为单张图片。' },
      ],

      async run(ctx) {
        requirePdfjs()
        const p = ctx.params
        const outputs = []
        const scale = Number(p.dpi) / 72

        for (const [fileIndex, ref] of ctx.inputs.entries()) {
          ctx.throwIfAborted()
          const bytes = await host.fs.readAll(ref.id)
          const loadingTask = pdfjsLib.getDocument({ ...workerFactories(),  data: bytes, useWorkerFetch: false, isEvalSupported: false })
          const doc = await loadingTask.promise
          const indices = parseRanges(String(p.pages || '1-'), doc.numPages).flat()
          if (indices.length === 0) throw new Error(`${ref.name}：页码范围没有匹配到任何页面`)

          const base = ref.name.replace(/\.pdf$/i, '')
          const canvases = []

          for (const [n, pageIndex] of indices.entries()) {
            ctx.throwIfAborted()
            ctx.progress((fileIndex + n / indices.length) / ctx.inputs.length, `渲染第 ${pageIndex + 1} 页`)

            const page = await doc.getPage(pageIndex + 1)
            const viewport = page.getViewport({ scale })
            const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
            const g = canvas.getContext('2d')
            // JPEG has no alpha; paint white so pages are not rendered on black.
            g.fillStyle = '#ffffff'
            g.fillRect(0, 0, canvas.width, canvas.height)
            await page.render({ canvasContext: g, viewport }).promise

            if (p.longImage) {
              canvases.push(canvas)
            } else {
              const blob = await canvas.convertToBlob({ type: String(p.format), quality: Number(p.quality) / 100 })
              const data = new Uint8Array(await blob.arrayBuffer())
              const name = `${base}-${String(pageIndex + 1).padStart(3, '0')}.${extensionFor(String(p.format))}`
              outputs.push((await host.fs.writeAll(name, data, String(p.format))).id)
            }
          }

          if (p.longImage && canvases.length > 0) {
            const width = Math.max(...canvases.map((c) => c.width))
            const height = canvases.reduce((sum, c) => sum + c.height, 0)
            const sheet = new OffscreenCanvas(width, height)
            const g = sheet.getContext('2d')
            g.fillStyle = '#ffffff'
            g.fillRect(0, 0, width, height)
            let y = 0
            for (const canvas of canvases) {
              g.drawImage(canvas, (width - canvas.width) / 2, y)
              y += canvas.height
            }
            const blob = await sheet.convertToBlob({ type: String(p.format), quality: Number(p.quality) / 100 })
            const data = new Uint8Array(await blob.arrayBuffer())
            outputs.push((await host.fs.writeAll(`${base}-long.${extensionFor(String(p.format))}`, data, String(p.format))).id)
          }

          await loadingTask.destroy()
        }

        ctx.progress(1)
        return { outputs, summary: `已渲染 ${outputs.length} 张图片` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'to-text',
      name: 'PDF 提取文本',
      category: 'pdf',
      icon: 'scan-text',
      description: '提取可选中的文字层，输出纯文本、Markdown 或 JSON。',
      accept: ['application/pdf', '.pdf'],
      multiple: true,
      keywords: ['text', 'extract', 'ocr', 'markdown', '提取文本', '文字', '转文本'],
      params: [
        { key: 'format', type: 'select', label: '输出格式', default: 'txt', options: [{ value: 'txt', label: '纯文本' }, { value: 'md', label: 'Markdown（按页分节）' }, { value: 'json', label: 'JSON（含坐标）' }] },
        { key: 'pages', type: 'text', label: '页码范围', default: '1-', placeholder: '如 1-3,7' },
        { key: 'pageBreaks', type: 'switch', label: '保留分页标记', default: true, when: { key: 'format', equals: 'txt' } },
      ],

      async run(ctx) {
        requirePdfjs()
        const outputs = []
        let emptyPages = 0

        for (const [fileIndex, ref] of ctx.inputs.entries()) {
          ctx.throwIfAborted()
          const bytes = await host.fs.readAll(ref.id)
          const loadingTask = pdfjsLib.getDocument({ ...workerFactories(),  data: bytes, useWorkerFetch: false, isEvalSupported: false })
          const doc = await loadingTask.promise
          const indices = parseRanges(String(ctx.params.pages || '1-'), doc.numPages).flat()

          const pages = []
          for (const [n, pageIndex] of indices.entries()) {
            ctx.throwIfAborted()
            ctx.progress((fileIndex + n / indices.length) / ctx.inputs.length, `提取第 ${pageIndex + 1} 页`)

            const page = await doc.getPage(pageIndex + 1)
            const content = await page.getTextContent()
            const items = content.items.filter((item) => 'str' in item)
            if (items.every((item) => !item.str.trim())) emptyPages++
            pages.push({ page: pageIndex + 1, items })
          }
          await loadingTask.destroy()

          const base = ref.name.replace(/\.pdf$/i, '')
          if (ctx.params.format === 'json') {
            const payload = pages.map((entry) => ({
              page: entry.page,
              items: entry.items.map((item) => ({ text: item.str, x: item.transform[4], y: item.transform[5], width: item.width, height: item.height })),
            }))
            outputs.push((await host.fs.writeAll(`${base}.json`, JSON.stringify(payload, null, 2), 'application/json')).id)
          } else if (ctx.params.format === 'md') {
            const body = pages.map((entry) => `## 第 ${entry.page} 页\n\n${joinLines(entry.items)}`).join('\n\n')
            outputs.push((await host.fs.writeAll(`${base}.md`, body, 'text/markdown')).id)
          } else {
            const separator = ctx.params.pageBreaks ? '\n\n--- 第 %d 页 ---\n\n' : '\n\n'
            const body = pages
              .map((entry) => (ctx.params.pageBreaks ? separator.replace('%d', String(entry.page)) : '') + joinLines(entry.items))
              .join('\n')
            outputs.push((await host.fs.writeAll(`${base}.txt`, body, 'text/plain')).id)
          }
        }

        ctx.progress(1)
        let summary = `已从 ${ctx.inputs.length} 个 PDF 提取文本`
        if (emptyPages > 0) summary += `；其中 ${emptyPages} 页没有文字层（大概率是扫描件，需要 OCR）`
        return { outputs, summary }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'compress',
      name: 'PDF 压缩',
      category: 'pdf',
      icon: 'gauge',
      description: '按目标 DPI 重新编码内嵌图片。对图文混排与扫描件效果显著。',
      accept: ['application/pdf', '.pdf'],
      multiple: true,
      keywords: ['compress', 'shrink', 'optimize', '压缩', '瘦身'],
      params: [
        { key: 'dpi', type: 'slider', label: '目标精度', min: 72, max: 200, step: 6, default: 110, suffix: 'dpi' },
        { key: 'quality', type: 'slider', label: 'JPEG 质量', min: 30, max: 95, default: 72, suffix: '%' },
        { key: 'grayscale', type: 'switch', label: '转为灰度', default: false, hint: '对扫描的文字稿可再减小一半左右。' },
      ],

      async run(ctx) {
        requirePdfjs()
        requirePdfLib()
        const outputs = []
        let before = 0
        let after = 0
        const scale = Number(ctx.params.dpi) / 72

        for (const [fileIndex, ref] of ctx.inputs.entries()) {
          ctx.throwIfAborted()
          const bytes = await host.fs.readAll(ref.id)
          const loadingTask = pdfjsLib.getDocument({ ...workerFactories(),  data: bytes, useWorkerFetch: false, isEvalSupported: false })
          const doc = await loadingTask.promise
          const target = await PDFLib.PDFDocument.create()

          for (let i = 1; i <= doc.numPages; i++) {
            ctx.throwIfAborted()
            ctx.progress((fileIndex + i / doc.numPages) / ctx.inputs.length, `压缩第 ${i} 页`)

            const page = await doc.getPage(i)
            const viewport = page.getViewport({ scale })
            const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
            const g = canvas.getContext('2d')
            g.fillStyle = '#ffffff'
            g.fillRect(0, 0, canvas.width, canvas.height)
            if (ctx.params.grayscale) g.filter = 'grayscale(1)'
            await page.render({ canvasContext: g, viewport }).promise

            const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: Number(ctx.params.quality) / 100 })
            const image = await target.embedJpg(new Uint8Array(await blob.arrayBuffer()))
            // Keep the original page box so print size is unchanged.
            const original = page.getViewport({ scale: 1 })
            const sheet = target.addPage([original.width, original.height])
            sheet.drawImage(image, { x: 0, y: 0, width: original.width, height: original.height })
          }
          await loadingTask.destroy()

          const saved = await target.save()
          before += ref.size
          after += saved.byteLength
          outputs.push((await host.fs.writeAll(`${ref.name.replace(/\.pdf$/i, '')}-compressed.pdf`, saved, 'application/pdf')).id)
        }

        ctx.progress(1)
        return {
          outputs,
          summary: `${outputs.length} 个 PDF：${bytesLabel(before)} → ${bytesLabel(after)}（${deltaLabel(before, after)}）。注意：文字层会被栅格化，不再可选中。`,
        }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'metadata',
      name: 'PDF 元数据',
      category: 'pdf',
      icon: 'info',
      description: '查看并改写标题、作者、关键词等信息，或一键清空。',
      accept: ['application/pdf', '.pdf'],
      multiple: true,
      keywords: ['metadata', 'title', 'author', 'properties', '元数据', '属性', '作者'],
      params: [
        {
          key: 'mode', type: 'select', label: '操作', default: 'inspect',
          options: [{ value: 'inspect', label: '仅查看（导出 JSON）' }, { value: 'set', label: '写入新值' }, { value: 'strip', label: '清空全部元数据' }],
        },
        { key: 'title', type: 'text', label: '标题', default: '', when: { key: 'mode', equals: 'set' } },
        { key: 'author', type: 'text', label: '作者', default: '', when: { key: 'mode', equals: 'set' } },
        { key: 'subject', type: 'text', label: '主题', default: '', when: { key: 'mode', equals: 'set' } },
        { key: 'keywords', type: 'text', label: '关键词', default: '', placeholder: '以逗号分隔', when: { key: 'mode', equals: 'set' } },
      ],

      async run(ctx) {
        requirePdfLib()
        const outputs = []
        const report = []

        for (const ref of ctx.inputs) {
          ctx.throwIfAborted()
          const doc = await loadPdf(ref)

          if (ctx.params.mode === 'inspect') {
            report.push({
              file: ref.name,
              pages: doc.getPageCount(),
              title: doc.getTitle() ?? null,
              author: doc.getAuthor() ?? null,
              subject: doc.getSubject() ?? null,
              keywords: doc.getKeywords() ?? null,
              producer: doc.getProducer() ?? null,
              creator: doc.getCreator() ?? null,
              creationDate: doc.getCreationDate()?.toISOString() ?? null,
              modificationDate: doc.getModificationDate()?.toISOString() ?? null,
            })
            continue
          }

          if (ctx.params.mode === 'strip') {
            doc.setTitle('')
            doc.setAuthor('')
            doc.setSubject('')
            doc.setKeywords([])
            doc.setProducer('')
            doc.setCreator('')
          } else {
            if (String(ctx.params.title)) doc.setTitle(String(ctx.params.title))
            if (String(ctx.params.author)) doc.setAuthor(String(ctx.params.author))
            if (String(ctx.params.subject)) doc.setSubject(String(ctx.params.subject))
            if (String(ctx.params.keywords)) doc.setKeywords(String(ctx.params.keywords).split(',').map((k) => k.trim()).filter(Boolean))
          }

          outputs.push((await host.fs.writeAll(`${ref.name.replace(/\.pdf$/i, '')}-meta.pdf`, await doc.save(), 'application/pdf')).id)
        }

        if (report.length > 0) {
          outputs.push((await host.fs.writeAll('pdf-metadata.json', JSON.stringify(report, null, 2), 'application/json')).id)
        }

        ctx.progress(1)
        return { outputs, summary: ctx.params.mode === 'inspect' ? `已读取 ${report.length} 个文件的元数据` : `已更新 ${outputs.length} 个文件` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'protect',
      name: 'PDF 加密 / 设置权限',
      category: 'pdf',
      icon: 'lock',
      description: '给 PDF 设置打开密码，或限制打印、修改、复制内容（AES-256 / AES-128 加密，qpdf 本地完成）。',
      accept: ['application/pdf', '.pdf'],
      multiple: true,
      keywords: ['encrypt', 'password', 'protect', 'permissions', 'restrict', 'aes', '加密', '设置密码', '密码保护', '禁止打印', '禁止复制', '权限'],
      params: [
        { key: 'userPassword', type: 'text', label: '打开密码', default: '', placeholder: '留空则任何人都能打开', hint: '留空时仍可只限制权限（打印、复制等）。' },
        { key: 'ownerPassword', type: 'text', label: '权限密码', default: '', placeholder: '留空自动生成随机密码', hint: '用来解除限制的密码。与打开密码相同时，打开者就拥有全部权限。' },
        {
          key: 'print', type: 'select', label: '打印', default: 'full',
          options: [{ value: 'full', label: '允许（高质量）' }, { value: 'low', label: '仅低分辨率' }, { value: 'none', label: '禁止' }],
        },
        {
          key: 'modify', type: 'select', label: '修改', default: 'none',
          options: [
            { value: 'all', label: '允许任何修改' },
            { value: 'annotate', label: '仅批注与填写表单' },
            { value: 'form', label: '仅填写表单' },
            { value: 'assembly', label: '仅调整页面（插入、删除、旋转）' },
            { value: 'none', label: '禁止' },
          ],
        },
        { key: 'extract', type: 'switch', label: '允许复制文字和图片', default: false },
        { key: 'strength', type: 'select', label: '加密方式', default: '256', options: [{ value: '256', label: 'AES-256（推荐）' }, { value: '128', label: 'AES-128（兼容很老的阅读器）' }] },
      ],

      async run(ctx) {
        const p = ctx.params
        const user = String(p.userPassword ?? '')
        let owner = String(p.ownerPassword ?? '')
        const generated = !owner
        if (generated) owner = randomPassword()
        if (!user && owner === user) throw new Error('请至少设置打开密码或权限密码')
        const q = await openQpdf()
        const outputs = []
        for (const [index, ref] of ctx.inputs.entries()) {
          ctx.throwIfAborted()
          ctx.progress(index / ctx.inputs.length, `加密 ${ref.name}`)
          const bits = p.strength === '128' ? ['128', '--use-aes=y'] : ['256']
          const out = runQpdfOnFile(q, await host.fs.readAll(ref.id), (input, output) => [
            '--encrypt', user, owner, ...bits,
            `--print=${['full', 'low', 'none'].includes(p.print) ? p.print : 'full'}`,
            `--modify=${['all', 'annotate', 'form', 'assembly', 'none'].includes(p.modify) ? p.modify : 'none'}`,
            `--extract=${p.extract ? 'y' : 'n'}`,
            '--accessibility=y',
            '--', input, output,
          ], ref.name)
          outputs.push((await host.fs.writeAll(`${ref.name.replace(/\.pdf$/i, '')}-protected.pdf`, out, 'application/pdf')).id)
        }
        ctx.progress(1)
        const note = generated ? '；权限密码为随机生成，限制无法再解除，请保留原文件' : ''
        return { outputs, summary: `已加密 ${outputs.length} 个 PDF${user ? '（需要密码才能打开）' : '（无需密码打开，仅限制权限）'}${note}` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'unlock',
      name: 'PDF 解除密码',
      category: 'pdf',
      icon: 'lock-open',
      description: '用已知的密码去掉 PDF 的打开密码和打印、复制、修改限制，输出不加密的副本。',
      accept: ['application/pdf', '.pdf'],
      multiple: true,
      keywords: ['unlock', 'decrypt', 'password', 'remove password', 'remove restrictions', '解密', '密码', '权限', '去除密码', '解除限制'],
      params: [
        { key: 'password', type: 'text', label: '密码', default: '', placeholder: '只有权限限制、没有打开密码时可留空', hint: '只在本机使用，不会上传或保存。' },
      ],

      async run(ctx) {
        const q = await openQpdf()
        const outputs = []
        const plain = []
        for (const [index, ref] of ctx.inputs.entries()) {
          ctx.throwIfAborted()
          ctx.progress(index / ctx.inputs.length, `解密 ${ref.name}`)
          const bytes = await host.fs.readAll(ref.id)
          if (!isEncryptedPdf(q, bytes)) plain.push(ref.name)
          const password = String(ctx.params.password ?? '')
          const out = runQpdfOnFile(q, bytes, (input, output) => ['--decrypt', `--password=${password}`, input, output], ref.name)
          outputs.push((await host.fs.writeAll(`${ref.name.replace(/\.pdf$/i, '')}-unlocked.pdf`, out, 'application/pdf')).id)
        }
        ctx.progress(1)
        const note = plain.length ? `（${plain.join('、')} 本来就没有加密）` : ''
        return { outputs, summary: `已解除 ${outputs.length} 个文件的密码与限制${note}` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'repair',
      name: 'PDF 修复',
      category: 'pdf',
      icon: 'wrench',
      description: '修复打不开或报错的 PDF：交叉引用表损坏、文件尾被截断、开头有多余数据等，重建后用 qpdf 校验。',
      accept: ['application/pdf', '.pdf'],
      multiple: true,
      keywords: ['repair', 'fix', 'corrupt', 'damaged', 'broken pdf', 'xref', '修复', '损坏', '打不开', '报错'],

      async run(ctx) {
        requirePdfLib()
        const q = await openQpdf()
        const outputs = []
        const notes = []
        for (const [index, ref] of ctx.inputs.entries()) {
          ctx.throwIfAborted()
          ctx.progress(index / ctx.inputs.length, `检查 ${ref.name}`)
          const bytes = await host.fs.readAll(ref.id)
          if (isEncryptedPdf(q, bytes)) throw new Error(`${ref.name} 已加密，请先用「PDF 解除密码」解密再修复`)
          const before = checkPdf(q, bytes)
          let doc
          try {
            // pdf-lib reads objects in file order and ignores the cross-reference table, which is
            // exactly what survives the common kinds of damage.
            doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false })
          } catch (err) {
            throw new Error(`${ref.name} 损坏过于严重，无法重建：${err && err.message ? err.message : err}`)
          }
          if (doc.getPageCount() === 0) throw new Error(`${ref.name} 中找不到任何页面，无法修复`)
          const rebuilt = await doc.save({ useObjectStreams: false })
          const after = checkPdf(q, rebuilt)
          if (!after.ok) throw new Error(`${ref.name} 重建后仍未通过校验：${after.detail}`)
          outputs.push((await host.fs.writeAll(`${ref.name.replace(/\.pdf$/i, '')}-repaired.pdf`, rebuilt, 'application/pdf')).id)
          notes.push(before.ok ? `${ref.name}：原文件未发现结构错误，已重新保存（${doc.getPageCount()} 页）` : `${ref.name}：已修复（${before.detail}），共 ${doc.getPageCount()} 页`)
        }
        ctx.progress(1)
        return { outputs, summary: notes.join('\n') }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'linearize',
      name: 'PDF 网页快速查看优化',
      category: 'pdf',
      icon: 'gauge',
      description: '线性化（Fast Web View）：放到网站上的大 PDF 不必下载完就能先显示第一页。可同时压缩对象流减小体积。',
      accept: ['application/pdf', '.pdf'],
      multiple: true,
      keywords: ['linearize', 'fast web view', 'web optimize', 'optimize', 'object streams', '线性化', '网页优化', '快速查看', '优化'],
      params: [
        { key: 'objectStreams', type: 'switch', label: '压缩对象流（体积更小）', default: true, hint: 'PDF 1.5 起支持；极老的阅读器可能不认。' },
      ],

      async run(ctx) {
        const q = await openQpdf()
        const outputs = []
        let saved = 0
        for (const [index, ref] of ctx.inputs.entries()) {
          ctx.throwIfAborted()
          ctx.progress(index / ctx.inputs.length, `优化 ${ref.name}`)
          const bytes = await host.fs.readAll(ref.id)
          if (isEncryptedPdf(q, bytes)) throw new Error(`${ref.name} 已加密，请先解除密码`)
          const out = runQpdfOnFile(q, bytes, (input, output) => [
            '--linearize', `--object-streams=${ctx.params.objectStreams ? 'generate' : 'preserve'}`, input, output,
          ], ref.name)
          saved += bytes.length - out.length
          outputs.push((await host.fs.writeAll(`${ref.name.replace(/\.pdf$/i, '')}-web.pdf`, out, 'application/pdf')).id)
        }
        ctx.progress(1)
        const delta = saved > 0 ? `，共减小 ${bytesLabel(saved)}` : ''
        return { outputs, summary: `已线性化 ${outputs.length} 个 PDF${delta}` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'sanitize',
      name: 'PDF 清理与扁平化',
      category: 'pdf',
      icon: 'eraser',
      description: '扁平化表单、移除注释 / 链接 / JavaScript / 附件 / 元数据，或解除表单字段只读。',
      accept: ['application/pdf', '.pdf'],
      multiple: true,
      keywords: ['flatten', 'sanitize', 'annotations', 'javascript', 'clean', 'forms', 'readonly', '扁平化', '清理', '注释', '脚本', '表单', '只读'],
      params: [
        { key: 'flatten', type: 'switch', label: '扁平化表单', default: true, hint: '把填写内容固定到页面上，字段不再可编辑。' },
        { key: 'annotations', type: 'switch', label: '移除注释与批注', default: false, hint: '高亮、便签、图章等；不影响正文。' },
        { key: 'links', type: 'switch', label: '移除链接', default: false },
        { key: 'javascript', type: 'switch', label: '移除 JavaScript 与自动动作', default: true, hint: '打开即执行的脚本、启动外部程序等动作。' },
        { key: 'attachments', type: 'switch', label: '移除附件', default: false },
        { key: 'metadata', type: 'switch', label: '清空元数据', default: false, hint: '标题、作者、创建软件与 XMP。' },
        { key: 'unlockFields', type: 'switch', label: '解除表单字段只读', default: false, hint: '与「扁平化表单」互斥，开启时不做扁平化。' },
      ],

      async run(ctx) {
        requirePdfLib()
        const p = ctx.params
        const outputs = []
        const totals = { fields: 0, annotations: 0, links: 0, scripts: 0, attachments: 0 }

        for (const [index, ref] of ctx.inputs.entries()) {
          ctx.throwIfAborted()
          ctx.progress(index / ctx.inputs.length, ref.name)
          const doc = await loadPdf(ref)
          const { PDFName } = PDFLib

          if (p.javascript) totals.scripts += removeScripts(doc)
          if (p.attachments) totals.attachments += removeAttachments(doc)

          // Forms first: flattening deletes widget objects, and the annotation
          // pass below then also drops the references it leaves behind.
          const form = doc.getForm()
          const fields = form.getFields()
          if (p.unlockFields) {
            for (const field of fields) field.disableReadOnly()
            totals.fields += fields.length
          } else if (p.flatten && fields.length) {
            form.flatten()
            totals.fields += fields.length
          }

          for (const page of doc.getPages()) {
            const annots = page.node.Annots()
            if (!annots) continue
            const kept = []
            for (let i = 0; i < annots.size(); i++) {
              const ref = annots.get(i)
              if (!doc.context.lookup(ref)) continue
              const kind = annotationKind(doc, ref)
              // Form widgets belong to the form, not to "annotations".
              const isMarkup = kind !== 'Widget' && kind !== 'Link' && kind !== 'FileAttachment'
              if (kind === 'Link' && p.links) totals.links++
              else if (kind === 'FileAttachment' && p.attachments) totals.attachments++
              else if (isMarkup && p.annotations) {
                // A Popup is the note window of another annotation, not one of its own.
                if (kind !== 'Popup') totals.annotations++
              } else kept.push(ref)
            }
            if (kept.length !== annots.size()) {
              if (kept.length === 0) page.node.delete(PDFName.of('Annots'))
              else page.node.set(PDFName.of('Annots'), doc.context.obj(kept))
            }
          }

          if (p.metadata) clearMetadata(doc)

          const saved = await doc.save({ useObjectStreams: true })
          outputs.push((await host.fs.writeAll(`${ref.name.replace(/\.pdf$/i, '')}-clean.pdf`, saved, 'application/pdf')).id)
        }

        ctx.progress(1)
        const parts = []
        if (totals.fields) parts.push(`${p.unlockFields ? '解锁' : '扁平化'} ${totals.fields} 个表单字段`)
        if (totals.annotations) parts.push(`移除 ${totals.annotations} 条注释`)
        if (totals.links) parts.push(`${totals.links} 个链接`)
        if (totals.scripts) parts.push(`${totals.scripts} 处脚本或自动动作`)
        if (totals.attachments) parts.push(`${totals.attachments} 个附件`)
        return { outputs, summary: `已处理 ${outputs.length} 个 PDF${parts.length ? `：${parts.join('，')}` : '（没有需要清理的内容）'}` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'inspect-security',
      name: 'PDF 安全检查',
      category: 'pdf',
      icon: 'shield-alert',
      description: '列出内嵌 JavaScript、自动执行动作、启动程序、外部链接、附件与表单，打开可疑文件前先看一眼。',
      accept: ['application/pdf', '.pdf'],
      multiple: true,
      keywords: ['javascript', 'security', 'malware', 'inspect', 'showjs', '安全', '脚本', '检查', '恶意'],

      async run(ctx) {
        requirePdfLib()
        const reports = []
        for (const ref of ctx.inputs) {
          ctx.throwIfAborted()
          const doc = await loadPdf(ref)
          reports.push({ file: ref.name, ...securityReport(doc) })
        }
        const out = await host.fs.writeAll('pdf-security.json', JSON.stringify(reports, null, 2), 'application/json')
        const risky = reports.filter((r) => r.risk !== 'none').length
        return { outputs: [out.id], summary: risky ? `${reports.length} 个文件中有 ${risky} 个包含脚本或自动动作，详见报告` : `已检查 ${reports.length} 个文件，未发现脚本或自动动作` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'remove-blanks',
      name: '删除空白页',
      category: 'pdf',
      icon: 'eraser',
      description: '删除空白页和几乎空白的扫描页。有文字的页面永远保留，只有一个字也不会被删。',
      accept: ['application/pdf', '.pdf'],
      multiple: true,
      keywords: ['blank', 'empty', 'remove', 'scan', '空白页', '删除', '扫描'],
      params: [
        { key: 'threshold', type: 'slider', label: '判定为空白的墨迹比例', min: 0, max: 3, step: 0.05, default: 0.1, suffix: '%', hint: '没有文字层、且墨迹占比低于此值的页面视为空白。扫描件噪点多时可调高到 0.5–1%。' },
        { key: 'whiteLevel', type: 'slider', label: '视为白色的亮度', min: 180, max: 254, default: 235, hint: '比这更暗的像素算作墨迹。' },
      ],

      async run(ctx) {
        requirePdfjs()
        requirePdfLib()
        const outputs = []
        let removed = 0

        for (const [fileIndex, ref] of ctx.inputs.entries()) {
          const bytes = await host.fs.readAll(ref.id)
          const loadingTask = pdfjsLib.getDocument({ ...workerFactories(),  data: bytes.slice(), useWorkerFetch: false, isEvalSupported: false })
          const doc = await loadingTask.promise
          const keep = []
          const blank = []

          for (let i = 1; i <= doc.numPages; i++) {
            ctx.throwIfAborted()
            ctx.progress((fileIndex + i / doc.numPages) / ctx.inputs.length, `检查第 ${i} 页`)
            const page = await doc.getPage(i)
            // Any real text means content, however little ink it uses: a page
            // reading just "Notes" is not blank. Scans have no text layer, so for
            // them the rendered ink decides.
            const text = await page.getTextContent()
            const hasText = text.items.some((item) => item.str && item.str.trim())
            const empty = !hasText && (await inkRatio(page, Number(ctx.params.whiteLevel))) * 100 < Number(ctx.params.threshold)
            if (empty) blank.push(i)
            else keep.push(i - 1)
          }
          await loadingTask.destroy()

          if (keep.length === 0) throw new Error(`${ref.name} 的所有页面都被判定为空白，请降低阈值`)
          removed += blank.length
          const source = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true })
          const name = `${ref.name.replace(/\.pdf$/i, '')}-no-blanks.pdf`
          outputs.push((await host.fs.writeAll(name, await extractPages(source, keep), 'application/pdf')).id)
          if (blank.length) await host.ui.notify(`${ref.name}：删除了第 ${blank.join('、')} 页`, 'info')
        }

        ctx.progress(1)
        return { outputs, summary: removed ? `共删除 ${removed} 个空白页` : '没有发现空白页' }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'extract-images',
      name: 'PDF 提取图片',
      category: 'pdf',
      icon: 'image-down',
      description: '导出 PDF 中嵌入的原始图片（而不是整页截图），自动去重。',
      accept: ['application/pdf', '.pdf'],
      multiple: true,
      keywords: ['extract', 'images', 'photos', '提取图片', '导出图片'],
      params: [
        { key: 'minSize', type: 'number', label: '忽略小于此尺寸的图片', default: 32, min: 1, suffix: 'px', hint: '过滤掉图标、分隔线等装饰性小图。' },
        { key: 'format', type: 'select', label: '输出格式', default: 'image/png', options: [{ value: 'image/png', label: 'PNG（无损）' }, { value: 'image/jpeg', label: 'JPEG' }, { value: 'image/webp', label: 'WebP' }] },
      ],

      async run(ctx) {
        requirePdfjs()
        const outputs = []
        const format = String(ctx.params.format)
        const minSize = Math.max(1, Number(ctx.params.minSize) || 1)

        for (const [fileIndex, ref] of ctx.inputs.entries()) {
          const bytes = await host.fs.readAll(ref.id)
          const loadingTask = pdfjsLib.getDocument({ ...workerFactories(),  data: bytes, useWorkerFetch: false, isEvalSupported: false })
          const doc = await loadingTask.promise
          const base = ref.name.replace(/\.pdf$/i, '')
          const seen = new Set()
          let count = 0

          for (let i = 1; i <= doc.numPages; i++) {
            ctx.throwIfAborted()
            ctx.progress((fileIndex + i / doc.numPages) / ctx.inputs.length, `扫描第 ${i} 页`)
            const page = await doc.getPage(i)
            const ops = await page.getOperatorList()
            for (let n = 0; n < ops.fnArray.length; n++) {
              const fn = ops.fnArray[n]
              if (fn !== pdfjsLib.OPS.paintImageXObject && fn !== pdfjsLib.OPS.paintInlineImageXObject) continue
              const arg = ops.argsArray[n][0]
              const image = typeof arg === 'string' ? await resolveObject(page, arg) : arg
              const key = typeof arg === 'string' ? arg : `inline-${i}-${n}`
              if (!image || seen.has(key) || image.width < minSize || image.height < minSize) continue
              seen.add(key)
              const canvas = imageToCanvas(image)
              if (!canvas) continue
              const blob = await canvas.convertToBlob({ type: format, quality: 0.92 })
              count++
              const name = `${base}-p${String(i).padStart(3, '0')}-${String(count).padStart(3, '0')}.${extensionFor(format)}`
              outputs.push((await host.fs.writeAll(name, new Uint8Array(await blob.arrayBuffer()), format)).id)
            }
            page.cleanup()
          }
          await loadingTask.destroy()
        }

        ctx.progress(1)
        if (outputs.length === 0) throw new Error('没有找到符合尺寸条件的嵌入图片（纯矢量或文字 PDF 不含图片）')
        return { outputs, summary: `已提取 ${outputs.length} 张图片` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'overlay',
      name: 'PDF 叠加',
      category: 'pdf',
      icon: 'layers',
      description: '把第二个 PDF（信纸、印章、背景）叠加到第一个 PDF 的每一页上方或下方。',
      accept: ['application/pdf', '.pdf'],
      multiple: true,
      minFiles: 2,
      keywords: ['overlay', 'underlay', 'letterhead', 'stamp', 'background', '叠加', '信纸', '背景', '印章'],
      params: [
        { key: 'position', type: 'select', label: '叠加位置', default: 'foreground', options: [{ value: 'foreground', label: '覆盖在内容上方' }, { value: 'background', label: '垫在内容下方（信纸 / 底纹）' }] },
        {
          key: 'mapping', type: 'select', label: '页面对应', default: 'first',
          options: [
            { value: 'first', label: '每页都用叠加文件的第 1 页' },
            { value: 'cycle', label: '逐页对应，叠加文件页数不足时循环' },
            { value: 'sequence', label: '逐页对应，超出部分不叠加' },
          ],
        },
        { key: 'pages', type: 'text', label: '应用到页码', default: '1-', placeholder: '如 1-3,7' },
        { key: 'opacity', type: 'slider', label: '不透明度', min: 5, max: 100, default: 100, suffix: '%' },
      ],

      async run(ctx) {
        requirePdfLib()
        const p = ctx.params
        const [baseRef, overlayRef] = ctx.inputs
        const base = await loadPdf(baseRef)
        const overlayBytes = await host.fs.readAll(overlayRef.id)
        const overlay = await PDFLib.PDFDocument.load(overlayBytes, { ignoreEncryption: true })
        const targets = new Set(parseRanges(String(p.pages || '1-'), base.getPageCount()).flat())
        const embedded = new Map()
        let applied = 0

        const pages = base.getPages()
        for (const [index, page] of pages.entries()) {
          if (!targets.has(index)) continue
          ctx.progress(index / pages.length, `第 ${index + 1} 页`)
          let source = 0
          if (p.mapping === 'cycle') source = index % overlay.getPageCount()
          else if (p.mapping === 'sequence') {
            if (index >= overlay.getPageCount()) continue
            source = index
          }
          if (!embedded.has(source)) embedded.set(source, (await base.embedPdf(overlayBytes, [source]))[0])
          const layer = embedded.get(source)
          const { width, height } = page.getSize()
          page.drawPage(layer, { x: 0, y: 0, width, height, opacity: Number(p.opacity) / 100 })
          if (p.position === 'background') moveLastContentToFront(page)
          applied++
        }

        const out = await host.fs.writeAll(`${baseRef.name.replace(/\.pdf$/i, '')}-overlay.pdf`, await base.save(), 'application/pdf')
        ctx.progress(1)
        return { outputs: [out.id], summary: `已在 ${applied} 页上叠加「${overlayRef.name}」` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'attachments',
      name: 'PDF 附件',
      category: 'pdf',
      icon: 'file-archive',
      description: '把任意文件作为附件嵌入 PDF，或导出 PDF 中已有的附件。',
      accept: [],
      multiple: true,
      keywords: ['attachment', 'embed', 'portfolio', '附件', '嵌入文件'],
      params: [
        {
          key: 'mode', type: 'select', label: '操作', default: 'add',
          options: [{ value: 'add', label: '添加附件（第 1 个文件为 PDF）' }, { value: 'portfolio', label: '制作 PDF 作品集（附件以文件列表展示）' }, { value: 'extract', label: '导出全部附件' }],
        },
        { key: 'description', type: 'text', label: '附件说明', default: '', when: { key: 'mode', equals: ['add', 'portfolio'] } },
      ],

      async run(ctx) {
        requirePdfLib()
        const [pdfRef, ...files] = ctx.inputs
        if (!pdfRef || !/\.pdf$/i.test(pdfRef.name) && pdfRef.type !== 'application/pdf') throw new Error('第 1 个文件必须是 PDF')

        if (ctx.params.mode === 'extract') {
          const outputs = []
          for (const ref of ctx.inputs.filter((r) => /\.pdf$/i.test(r.name) || r.type === 'application/pdf')) {
            const doc = await loadPdf(ref)
            for (const file of listAttachments(doc)) {
              const folder = ref.name.replace(/\.pdf$/i, '')
              outputs.push((await host.fs.writeAll(`${folder}/${file.name}`, file.data, file.type || '')).id)
            }
          }
          if (outputs.length === 0) throw new Error('这些 PDF 中没有附件')
          return { outputs, summary: `已导出 ${outputs.length} 个附件` }
        }

        if (files.length === 0) throw new Error('请在 PDF 之后再拖入要作为附件的文件')
        const doc = await loadPdf(pdfRef)
        for (const file of files) {
          ctx.throwIfAborted()
          await doc.attach(await host.fs.readAll(file.id), file.name, {
            mimeType: file.type || 'application/octet-stream',
            description: String(ctx.params.description || '') || undefined,
            creationDate: new Date(),
            modificationDate: new Date(),
          })
        }
        if (ctx.params.mode === 'portfolio') {
          // A Collection dictionary makes readers open the attachment list as the document's main view.
          doc.catalog.set(PDFLib.PDFName.of('Collection'), doc.context.obj({ Type: 'Collection', View: 'T' }))
          doc.catalog.set(PDFLib.PDFName.of('PageMode'), PDFLib.PDFName.of('UseAttachments'))
        }
        const suffix = ctx.params.mode === 'portfolio' ? '-portfolio' : '-attached'
        const out = await host.fs.writeAll(`${pdfRef.name.replace(/\.pdf$/i, '')}${suffix}.pdf`, await doc.save(), 'application/pdf')
        return { outputs: [out.id], summary: ctx.params.mode === 'portfolio' ? `已制作包含 ${files.length} 个文件的作品集` : `已嵌入 ${files.length} 个附件` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'booklet',
      name: 'PDF 小册子拼版',
      category: 'pdf',
      icon: 'layout-grid',
      description: '按骑马钉顺序重排并两页拼一张，双面打印后对折即成小册子。',
      accept: ['application/pdf', '.pdf'],
      multiple: true,
      keywords: ['booklet', 'imposition', 'saddle stitch', 'print', '小册子', '拼版', '骑马钉', '对折'],
      params: [
        { key: 'binding', type: 'select', label: '装订边', default: 'left', options: [{ value: 'left', label: '左侧装订（横排文字）' }, { value: 'right', label: '右侧装订（竖排 / 日漫）' }] },
        { key: 'creep', type: 'slider', label: '爬移补偿', min: 0, max: 5, step: 0.5, default: 0, suffix: 'mm', hint: '页数多时内页会向外突出，向装订线内移补偿。一般 0 即可。' },
      ],

      async run(ctx) {
        requirePdfLib()
        const outputs = []
        for (const ref of ctx.inputs) {
          ctx.throwIfAborted()
          const source = await loadPdf(ref)
          const bytes = await bookletImpose(source, { rightToLeft: ctx.params.binding === 'right', creepMm: Number(ctx.params.creep) || 0 })
          outputs.push((await host.fs.writeAll(`${ref.name.replace(/\.pdf$/i, '')}-booklet.pdf`, bytes, 'application/pdf')).id)
        }
        return { outputs, summary: `已生成 ${outputs.length} 份小册子（打印时选择「双面，沿短边翻转」）` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'page-layout',
      name: 'PDF 页面尺寸',
      category: 'pdf',
      icon: 'scaling',
      description: '统一缩放到 A4 / Letter 等纸张、裁掉页边、增加页边距，或把所有页面拼成一张长页。',
      accept: ['application/pdf', '.pdf'],
      multiple: true,
      keywords: ['resize', 'scale', 'a4', 'crop', 'margin', 'long page', '页面尺寸', '缩放', '裁边', '页边距', '长页'],
      params: [
        {
          key: 'mode', type: 'select', label: '操作', default: 'fit',
          options: [
            { value: 'fit', label: '缩放到标准纸张' }, { value: 'crop', label: '裁掉页边' },
            { value: 'margin', label: '增加页边距' }, { value: 'single', label: '拼成单张长页' },
          ],
        },
        {
          key: 'paper', type: 'select', label: '纸张', default: 'a4',
          options: [{ value: 'a4', label: 'A4' }, { value: 'a3', label: 'A3' }, { value: 'a5', label: 'A5' }, { value: 'letter', label: 'Letter' }, { value: 'legal', label: 'Legal' }],
          when: { key: 'mode', equals: 'fit' },
        },
        { key: 'orientation', type: 'select', label: '方向', default: 'auto', options: [{ value: 'auto', label: '跟随原页面' }, { value: 'portrait', label: '纵向' }, { value: 'landscape', label: '横向' }], when: { key: 'mode', equals: 'fit' } },
        { key: 'amount', type: 'number', label: '宽度', default: 10, min: 0, suffix: 'mm', when: { key: 'mode', equals: ['crop', 'margin'] }, hint: '四边相同。' },
      ],

      async run(ctx) {
        requirePdfLib()
        const p = ctx.params
        const outputs = []
        for (const ref of ctx.inputs) {
          ctx.throwIfAborted()
          const source = await loadPdf(ref)
          const bytes = await layoutPages(source, {
            mode: String(p.mode),
            paper: String(p.paper),
            orientation: String(p.orientation),
            amount: mm(Number(p.amount) || 0),
          })
          const suffix = { fit: `-${p.paper}`, crop: '-cropped', margin: '-margin', single: '-long' }[String(p.mode)] ?? ''
          outputs.push((await host.fs.writeAll(`${ref.name.replace(/\.pdf$/i, '')}${suffix}.pdf`, bytes, 'application/pdf')).id)
        }
        return { outputs, summary: `已处理 ${outputs.length} 个 PDF` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'bookmarks',
      name: 'PDF 目录书签',
      category: 'pdf',
      icon: 'list-ordered',
      description: '导出现有书签目录，或按「标题 页码」的文本为 PDF 生成多级书签。',
      accept: ['application/pdf', '.pdf'],
      multiple: false,
      keywords: ['bookmarks', 'outline', 'toc', 'table of contents', '书签', '目录', '大纲'],
      params: [
        { key: 'mode', type: 'select', label: '操作', default: 'read', options: [{ value: 'read', label: '导出书签目录' }, { value: 'write', label: '写入书签（替换原有）' }] },
        {
          key: 'outline', type: 'textarea', label: '书签', rows: 10, default: '第一章 概述 1\n  1.1 背景 2\n  1.2 目标 3\n第二章 设计 5',
          hint: '每行一个书签，行尾是页码；用两个空格或 Tab 缩进表示下一级。',
          when: { key: 'mode', equals: 'write' },
        },
      ],

      async run(ctx) {
        const ref = ctx.inputs[0]
        if (ctx.params.mode === 'write') {
          requirePdfLib()
          const doc = await loadPdf(ref)
          const items = parseOutlineText(String(ctx.params.outline || ''), doc.getPageCount())
          writeOutline(doc, items)
          const out = await host.fs.writeAll(`${ref.name.replace(/\.pdf$/i, '')}-bookmarked.pdf`, await doc.save(), 'application/pdf')
          return { outputs: [out.id], summary: `已写入 ${countOutline(items)} 个书签` }
        }

        requirePdfjs()
        const bytes = await host.fs.readAll(ref.id)
        const loadingTask = pdfjsLib.getDocument({ ...workerFactories(),  data: bytes, useWorkerFetch: false, isEvalSupported: false })
        const doc = await loadingTask.promise
        const outline = (await doc.getOutline()) || []
        const lines = []
        const walk = async (items, depth) => {
          for (const item of items) {
            const page = await outlinePage(doc, item.dest)
            lines.push(`${'  '.repeat(depth)}${item.title.trim()}${page ? ` ${page}` : ''}`)
            if (item.items && item.items.length) await walk(item.items, depth + 1)
          }
        }
        await walk(outline, 0)
        await loadingTask.destroy()
        if (lines.length === 0) throw new Error(`${ref.name} 没有书签`)
        // The same format `write` accepts, so a round trip is edit-and-paste.
        const out = await host.fs.writeAll(`${ref.name.replace(/\.pdf$/i, '')}-bookmarks.txt`, `${lines.join('\n')}\n`, 'text/plain')
        return { outputs: [out.id], summary: `已导出 ${lines.length} 个书签（可编辑后用「写入书签」写回）` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'auto-rename',
      name: 'PDF 按标题重命名',
      category: 'pdf',
      icon: 'pen-line',
      description: '读取第一页最醒目的标题（或文档属性中的标题）作为文件名，批量整理下载的论文与发票。',
      accept: ['application/pdf', '.pdf'],
      multiple: true,
      keywords: ['rename', 'title', 'organize', '重命名', '标题', '整理'],
      params: [
        { key: 'prefer', type: 'select', label: '标题来源', default: 'page', options: [{ value: 'page', label: '优先首页最大字号文字' }, { value: 'metadata', label: '优先文档属性标题' }] },
        { key: 'maxLength', type: 'number', label: '文件名最长', default: 80, min: 10, max: 180 },
      ],

      async run(ctx) {
        requirePdfjs()
        const outputs = []
        const renamed = []
        for (const ref of ctx.inputs) {
          ctx.throwIfAborted()
          const bytes = await host.fs.readAll(ref.id)
          const loadingTask = pdfjsLib.getDocument({ ...workerFactories(),  data: bytes.slice(), useWorkerFetch: false, isEvalSupported: false })
          const doc = await loadingTask.promise
          const metaTitle = String((await doc.getMetadata()).info?.Title || '').trim()
          const pageTitle = doc.numPages ? largestText(await (await doc.getPage(1)).getTextContent()) : ''
          await loadingTask.destroy()

          const candidates = ctx.params.prefer === 'metadata' ? [metaTitle, pageTitle] : [pageTitle, metaTitle]
          const title = candidates.map(cleanFileName).find((t) => t.length >= 2)
          const name = title ? `${title.slice(0, Number(ctx.params.maxLength) || 80).trim()}.pdf` : ref.name
          renamed.push(`${ref.name} → ${name}`)
          outputs.push((await host.fs.writeAll(name, bytes, 'application/pdf')).id)
        }
        return { outputs, summary: renamed.join('\n') }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'compare',
      name: 'PDF 文本比较',
      category: 'pdf',
      icon: 'split',
      description: '逐页比较两个 PDF 的文字内容，生成高亮差异报告。',
      accept: ['application/pdf', '.pdf'],
      multiple: true,
      minFiles: 2,
      keywords: ['compare', 'diff', 'difference', 'version', '比较', '对比', '差异', '版本'],
      params: [
        { key: 'ignoreWhitespace', type: 'switch', label: '忽略空白差异', default: true },
        { key: 'granularity', type: 'select', label: '比较粒度', default: 'line', options: [{ value: 'line', label: '按行' }, { value: 'word', label: '按词（中文按字）' }] },
      ],

      async run(ctx) {
        requirePdfjs()
        const [a, b] = ctx.inputs
        ctx.progress(0.1, `读取 ${a.name}`)
        const left = await pdfText(a)
        ctx.progress(0.4, `读取 ${b.name}`)
        const right = await pdfText(b)
        ctx.progress(0.7, '比较中')

        const tokenize = (text) => {
          const normalised = ctx.params.ignoreWhitespace ? text.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim() : text
          if (ctx.params.granularity === 'word') return normalised.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|\n/gu) ?? []
          return normalised.split('\n')
        }
        const diff = diffTokens(tokenize(left), tokenize(right))
        const stats = { added: 0, removed: 0, unchanged: 0 }
        for (const part of diff) stats[part.type] += part.tokens.length

        const html = diffReport(a.name, b.name, diff, stats, ctx.params.granularity === 'word')
        const out = await host.fs.writeAll('pdf-compare.html', html, 'text/html')
        ctx.progress(1)
        const same = stats.added === 0 && stats.removed === 0
        return { outputs: [out.id], summary: same ? '两个 PDF 的文字内容完全一致' : `新增 ${stats.added}，删除 ${stats.removed}（${ctx.params.granularity === 'word' ? '词' : '行'}）` }
      },
    },
    /* ------------------------------------------------------------------ */
    {
      id: 'stamp',
      name: 'PDF 添加图片 / 签名 / 文字',
      category: 'pdf',
      icon: 'pen-line',
      description: '在页面上拖框放置图片、印章、手写签名或文字（支持中文），可应用到指定页面。',
      accept: ['application/pdf', '.pdf', 'image/png', 'image/jpeg'],
      multiple: true,
      keywords: ['sign', 'signature', 'stamp', 'seal', 'add image', 'add text', '签名', '签字', '盖章', '印章', '加图片', '加文字'],

      async setup(ui) {
        const pdf = ui.inputs.find(isPdfFile)
        const image = ui.inputs.find(isImageRef)
        if (!pdf) {
          ui.render({ runDisabled: true, nodes: [{ type: 'alert', tone: 'info', title: '先拖入一个 PDF', text: '要盖章或放图片，就把 PNG / JPG 一起拖进来；也可以现场手写签名或输入文字。' }] })
          return
        }
        const preview = pagePreviewer(ui, pdf)
        const strokes = signatureStrokes(ui.toolId)
        let pad = null

        const build = async (state) => {
          const page = await preview.show(Math.round(Number(state.page) || 1))
          return {
            runLabel: '保存 PDF',
            runDisabled: state.kind === 'image' ? !image : state.kind === 'text' ? !String(state.text).trim() : strokes.length === 0,
            nodes: [
              {
                type: 'segmented', bind: 'kind', label: '内容',
                options: [{ value: 'draw', label: '手写签名' }, { value: 'text', label: '文字' }, { value: 'image', label: image ? `图片（${image.name}）` : '图片（请拖入 PNG / JPG）' }],
              },
              { type: 'canvas', id: 'pad', aspect: 3, interactive: true, when: { key: 'kind', equals: 'draw' } },
              {
                type: 'row', gap: 2, when: { key: 'kind', equals: 'draw' },
                children: [
                  { type: 'button', text: '清除签名', action: 'clear', variant: 'outline', icon: 'eraser' },
                  { type: 'text', variant: 'muted', text: '用鼠标或手指在上方书写。' },
                ],
              },
              { type: 'input', bind: 'text', label: '文字', when: { key: 'kind', equals: 'text' } },
              { type: 'color', bind: 'color', label: '颜色', when: { key: 'kind', equals: ['text', 'draw'] } },
              { type: 'media', fileId: page.fileId, crop: 'box', height: 420 },
              {
                type: 'row', gap: 4, wrap: true,
                children: [
                  { type: 'input', bind: 'page', label: '预览第几页', inputType: 'number', min: 1, max: page.count },
                  { type: 'segmented', bind: 'pages', label: '应用到', options: [{ value: 'current', label: '当前页' }, { value: 'all', label: '全部页' }, { value: 'custom', label: '指定页' }] },
                ],
              },
              { type: 'input', bind: 'range', label: '页码', placeholder: '如 1-3,7', when: { key: 'pages', equals: 'custom' } },
              { type: 'slider', bind: 'opacity', label: '不透明度', min: 10, max: 100, step: 5, suffix: '%' },
              { type: 'text', variant: 'muted', text: `拖动方框决定位置与大小；图片与签名按比例放进方框，文字按方框高度决定字号。共 ${page.count} 页。` },
            ],
          }
        }

        const render = async () => ui.render(await build({ ...STAMP_DEFAULTS, ...ui.state }))
        ui.render({ state: { ...STAMP_DEFAULTS, kind: image ? 'image' : 'draw', ...pickDefined(ui.state, STAMP_DEFAULTS) }, ...(await build({ ...STAMP_DEFAULTS, kind: image ? 'image' : 'draw', ...ui.state })) })

        ui.on('change', async (key) => {
          if (['page', 'kind', 'pages', 'text'].includes(key)) await render()
          if (key === 'color' && pad) redrawSignature(pad, strokes, String(ui.state.color))
        })
        ui.on('action', async (name) => {
          if (name !== 'clear') return
          strokes.length = 0
          if (pad) redrawSignature(pad, strokes, String(ui.state.color))
          await render()
        })
        ui.on('canvas', (id, canvas) => {
          if (id !== 'pad') return
          pad = canvas
          redrawSignature(pad, strokes, String(ui.state.color))
        })
        ui.on('pointer', async (id, event) => {
          if (id !== 'pad') return
          pad = await ui.canvas('pad')
          const wasEmpty = strokes.length === 0
          if (event.type === 'down') strokes.push({ w: pad.width, h: pad.height, points: [[event.x, event.y]] })
          else if (event.type === 'move' && event.buttons && strokes.length) strokes[strokes.length - 1].points.push([event.x, event.y])
          redrawSignature(pad, strokes, String(ui.state.color))
          if (wasEmpty && strokes.length) await render()
        })
      },

      async run(ctx) {
        const p = { ...STAMP_DEFAULTS, ...pickDefined(ctx.params, STAMP_DEFAULTS) }
        const pdfRef = ctx.inputs.find(isPdfFile)
        if (!pdfRef) throw new Error('请拖入 PDF')
        const doc = await loadPdf(pdfRef)
        const count = doc.getPageCount()
        const targets = p.pages === 'all' ? range(0, count) : p.pages === 'custom' ? parseRanges(String(p.range || ''), count).flat() : [Math.min(count, Math.max(1, Math.round(Number(p.page) || 1))) - 1]
        if (targets.length === 0) throw new Error('页码范围没有匹配到任何页面')
        const box = normaliseBox(p.box)
        const opacity = Math.min(1, Math.max(0.05, Number(p.opacity) / 100))
        const [r, g, b] = hexColor(p.color)

        let embedded = null
        let text = ''
        let font = null
        if (p.kind === 'image') {
          const imageRef = ctx.inputs.find(isImageRef)
          if (!imageRef) throw new Error('图片模式需要同时拖入一张 PNG 或 JPG')
          const bytes = await host.fs.readAll(imageRef.id)
          embedded = /png$/i.test(imageRef.type || imageRef.name) ? await doc.embedPng(bytes) : await doc.embedJpg(bytes)
        } else if (p.kind === 'draw') {
          const strokes = signatureStrokes(ctx.toolId)
          if (strokes.length === 0) throw new Error('请先在签名板上书写')
          embedded = await doc.embedPng(await signaturePng(strokes, [r, g, b]))
        } else {
          text = String(p.text || '').trim()
          if (!text) throw new Error('请输入文字')
          font = await embedCjkFont(doc)
        }

        for (const index of targets) {
          const page = doc.getPage(index)
          const rotation = ((page.getRotation().angle % 360) + 360) % 360
          const crop = page.getCropBox()
          const display = rotation % 180 ? { w: crop.height, h: crop.width } : { w: crop.width, h: crop.height }
          if (embedded) {
            const fitted = fitIntoBox(box, embedded.width / embedded.height, display)
            const region = displayBoxToPage(fitted, rotation, crop)
            page.drawImage(embedded, { ...drawPlacement(region, rotation, 'box'), opacity, rotate: PDFLib.degrees(rotation) })
          } else {
            const boxH = box[3] * display.h
            let size = boxH * 0.72
            const maxW = box[2] * display.w
            while (size > 4 && font.widthOfTextAtSize(text, size) > maxW) size *= 0.95
            const width = font.widthOfTextAtSize(text, size)
            // Vertically centred in the box; the text box is its advance width × font size.
            const textBox = [box[0], box[1] + (box[3] - size / display.h) / 2 - (size * 0.12) / display.h, width / display.w, size / display.h]
            const region = displayBoxToPage(textBox, rotation, crop)
            page.drawText(text, { ...drawPlacement(region, rotation, 'text'), size, font, color: PDFLib.rgb(r, g, b), opacity, rotate: PDFLib.degrees(rotation) })
          }
        }

        const out = await host.fs.writeAll(`${pdfRef.name.replace(/\.pdf$/i, '')}-signed.pdf`, await doc.save(), 'application/pdf')
        return { outputs: [out.id], summary: `已在 ${targets.length} 页上添加${{ image: '图片', draw: '签名', text: '文字' }[p.kind]}` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'redact',
      name: 'PDF 涂黑',
      category: 'pdf',
      icon: 'eraser',
      description: '框选或按关键词涂黑敏感信息。涂黑的页面会被栅格化，底层文字被真正移除，无法通过复制或编辑找回。',
      accept: ['application/pdf', '.pdf'],
      multiple: false,
      keywords: ['redact', 'blackout', 'censor', 'privacy', 'remove text', '涂黑', '打码', '脱敏', '隐私', '遮挡'],

      async setup(ui) {
        const pdf = ui.inputs.find(isPdfFile)
        if (!pdf) {
          ui.render({ runDisabled: true, nodes: [{ type: 'alert', tone: 'info', title: '先拖入一个 PDF', text: '可以在页面上框选区域，也可以输入关键词（如身份证号、手机号）自动找出并涂黑。' }] })
          return
        }
        const preview = pagePreviewer(ui, pdf)
        const build = async (state) => {
          const pageNumber = Math.round(Number(state.page) || 1)
          const areas = chunkAreas(state.areas)
          const page = await preview.show(pageNumber, areas.filter((a) => a.page === pageNumber))
          const pagesTouched = new Set(areas.map((a) => a.page)).size
          return {
            runLabel: '涂黑并保存',
            runDisabled: areas.length === 0 && !String(state.terms).trim() && !state.patterns,
            nodes: [
              { type: 'alert', tone: 'warning', title: '涂黑是不可逆的', text: '含涂黑区域的页面会转成图片：黑框下的文字被彻底删除，这些页面的文字也不再可选中。其他页面保持原样。' },
              { type: 'media', fileId: page.fileId, crop: 'box', height: 460 },
              {
                type: 'row', gap: 2, wrap: true,
                children: [
                  { type: 'button', text: '涂黑选区', action: 'add', variant: 'default', icon: 'plus' },
                  { type: 'button', text: '撤销上一个', action: 'undo', variant: 'outline', disabled: areas.length === 0 },
                  { type: 'button', text: '清空', action: 'clear', variant: 'ghost', disabled: areas.length === 0 },
                ],
              },
              { type: 'input', bind: 'page', label: '当前页', inputType: 'number', min: 1, max: page.count },
              { type: 'input', bind: 'terms', label: '同时涂黑这些关键词', placeholder: '用逗号分隔，如 张三, 13800138000', hint: '在所有页面的文字层中查找（扫描件没有文字层，请用框选）。' },
              { type: 'switch', bind: 'patterns', label: '自动识别手机号、身份证号、邮箱、银行卡号' },
              { type: 'slider', bind: 'dpi', label: '栅格化精度', min: 100, max: 300, step: 25, suffix: ' dpi' },
              { type: 'facts', rows: [{ label: '已框选', value: `${areas.length} 处，涉及 ${pagesTouched} 页` }, { label: '文件', value: `${page.count} 页` }] },
            ],
          }
        }
        const render = async () => ui.render(await build({ ...REDACT_DEFAULTS, ...ui.state }))
        ui.render({ state: { ...REDACT_DEFAULTS, ...pickDefined(ui.state, REDACT_DEFAULTS), _files: pdf.id }, ...(await build({ ...REDACT_DEFAULTS, ...ui.state })) })
        ui.on('change', async (key) => {
          if (['page', 'terms', 'patterns'].includes(key)) await render()
        })
        ui.on('action', async (name) => {
          const areas = Array.isArray(ui.state.areas) ? [...ui.state.areas] : []
          if (name === 'add') {
            const box = normaliseBox(ui.state.box)
            if (areas.length + 5 > 250) return
            areas.push(Math.round(Number(ui.state.page) || 1), ...box.map((v) => Math.round(v * 10000) / 10000))
          } else if (name === 'undo') {
            areas.splice(-5, 5)
          } else if (name === 'clear') {
            areas.length = 0
          }
          ui.setState({ areas })
          await render()
        })
      },

      async run(ctx) {
        requirePdfjs()
        requirePdfLib()
        const p = { ...REDACT_DEFAULTS, ...pickDefined(ctx.params, REDACT_DEFAULTS) }
        const ref = ctx.inputs.find(isPdfFile)
        const bytes = await host.fs.readAll(ref.id)
        const task = pdfjsLib.getDocument({ ...workerFactories(), data: bytes.slice() })
        const pdf = await task.promise
        const areas = chunkAreas(p.areas).map((a) => ({ ...a, box: normaliseBox(a.box) }))
        const terms = String(p.terms || '').split(/[,，]/).map((t) => t.trim()).filter(Boolean)
        const byPage = new Map()
        for (const area of areas) {
          if (area.page < 1 || area.page > pdf.numPages) continue
          if (!byPage.has(area.page)) byPage.set(area.page, [])
          byPage.get(area.page).push(area.box)
        }

        if (terms.length || p.patterns) {
          for (let n = 1; n <= pdf.numPages; n++) {
            ctx.throwIfAborted()
            ctx.progress((n / pdf.numPages) * 0.3, `查找第 ${n} 页`)
            const page = await pdf.getPage(n)
            const found = findTextBoxes(await page.getTextContent(), page.getViewport({ scale: 1 }), terms, !!p.patterns)
            if (found.length) byPage.set(n, [...(byPage.get(n) ?? []), ...found])
            page.cleanup()
          }
        }
        if (byPage.size === 0) {
          await task.destroy()
          throw new Error(terms.length || p.patterns ? '没有找到匹配的文字，也没有框选区域' : '请先框选要涂黑的区域')
        }

        const source = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true })
        const out = await PDFLib.PDFDocument.create()
        const scale = (Number(p.dpi) || 150) / 72
        let redacted = 0
        for (let n = 1; n <= pdf.numPages; n++) {
          ctx.throwIfAborted()
          const boxes = byPage.get(n)
          if (!boxes) {
            const [copied] = await out.copyPages(source, [n - 1])
            out.addPage(copied)
            continue
          }
          ctx.progress(0.3 + (n / pdf.numPages) * 0.7, `涂黑第 ${n} 页`)
          const page = await pdf.getPage(n)
          const viewport = page.getViewport({ scale })
          const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
          const g = canvas.getContext('2d')
          g.fillStyle = '#ffffff'
          g.fillRect(0, 0, canvas.width, canvas.height)
          await page.render({ canvasContext: g, viewport }).promise
          g.fillStyle = '#000000'
          for (const [x, y, w, h] of boxes) g.fillRect(Math.floor(x * canvas.width) - 1, Math.floor(y * canvas.height) - 1, Math.ceil(w * canvas.width) + 2, Math.ceil(h * canvas.height) + 2)
          redacted += boxes.length
          const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
          const image = await out.embedPng(png)
          const base = page.getViewport({ scale: 1 })
          // The rendered image already has the page rotation applied, so the new page is upright.
          out.addPage([base.width, base.height]).drawImage(image, { x: 0, y: 0, width: base.width, height: base.height })
          page.cleanup()
        }
        await task.destroy()
        // Metadata can repeat what was just removed (title, subject, keywords).
        for (const key of out.getInfoDict().keys()) out.getInfoDict().delete(key)
        const saved = await out.save()
        const file = await host.fs.writeAll(`${ref.name.replace(/\.pdf$/i, '')}-redacted.pdf`, saved, 'application/pdf')
        return { outputs: [file.id], summary: `已涂黑 ${redacted} 处，涉及 ${byPage.size} 页` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'enhance-scan',
      name: 'PDF 扫描件增强',
      category: 'pdf',
      icon: 'sliders',
      description: '调亮度、对比度，转灰度或黑白二值化，让发灰的扫描件更清晰、体积更小。页面会被重新栅格化。',
      accept: ['application/pdf', '.pdf'],
      multiple: true,
      keywords: ['scan', 'contrast', 'brightness', 'grayscale', 'binarize', 'clean scan', '扫描件', '对比度', '变清晰', '黑白', '去灰'],
      params: [
        { key: 'mode', type: 'select', label: '色彩', default: 'grayscale', options: [{ value: 'color', label: '保留彩色' }, { value: 'grayscale', label: '灰度' }, { value: 'bw', label: '黑白二值（文字稿最清晰、最小）' }] },
        { key: 'brightness', type: 'slider', label: '亮度', min: 50, max: 150, default: 105, suffix: '%' },
        { key: 'contrast', type: 'slider', label: '对比度', min: 50, max: 250, default: 140, suffix: '%' },
        { key: 'threshold', type: 'slider', label: '黑白阈值', min: 60, max: 220, default: 160, when: { key: 'mode', equals: 'bw' }, hint: '越高保留的笔画越多，也越容易带上底色噪点。' },
        { key: 'dpi', type: 'slider', label: '精度', min: 100, max: 300, step: 25, default: 200, suffix: 'dpi' },
        { key: 'pages', type: 'text', label: '页码范围', default: '1-', placeholder: '如 1-3,7' },
      ],

      async run(ctx) {
        requirePdfjs()
        requirePdfLib()
        const p = ctx.params
        const outputs = []
        for (const [fileIndex, ref] of ctx.inputs.entries()) {
          const bytes = await host.fs.readAll(ref.id)
          const task = pdfjsLib.getDocument({ ...workerFactories(), data: bytes.slice() })
          const pdf = await task.promise
          const selected = new Set(parseRanges(String(p.pages || '1-'), pdf.numPages).flat())
          const source = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true })
          const out = await PDFLib.PDFDocument.create()
          const scale = (Number(p.dpi) || 200) / 72
          for (let n = 1; n <= pdf.numPages; n++) {
            ctx.throwIfAborted()
            if (!selected.has(n - 1)) {
              const [copied] = await out.copyPages(source, [n - 1])
              out.addPage(copied)
              continue
            }
            ctx.progress((fileIndex + n / pdf.numPages) / ctx.inputs.length, `处理第 ${n} 页`)
            const page = await pdf.getPage(n)
            const viewport = page.getViewport({ scale })
            const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
            const g = canvas.getContext('2d', { willReadFrequently: true })
            g.fillStyle = '#ffffff'
            g.fillRect(0, 0, canvas.width, canvas.height)
            await page.render({ canvasContext: g, viewport }).promise
            const filtered = new OffscreenCanvas(canvas.width, canvas.height)
            const fg = filtered.getContext('2d', { willReadFrequently: true })
            fg.filter = `brightness(${Number(p.brightness) / 100}) contrast(${Number(p.contrast) / 100})${p.mode !== 'color' ? ' grayscale(1)' : ''}`
            fg.drawImage(canvas, 0, 0)
            let type = p.mode === 'color' ? 'image/jpeg' : 'image/jpeg'
            if (p.mode === 'bw') {
              const image = fg.getImageData(0, 0, filtered.width, filtered.height)
              const threshold = Number(p.threshold) || 160
              for (let i = 0; i < image.data.length; i += 4) {
                const v = image.data[i] < threshold ? 0 : 255
                image.data[i] = image.data[i + 1] = image.data[i + 2] = v
              }
              fg.putImageData(image, 0, 0)
              // Two colours compress far better losslessly than as JPEG.
              type = 'image/png'
            }
            const blob = await filtered.convertToBlob({ type, quality: 0.82 })
            const data = new Uint8Array(await blob.arrayBuffer())
            const embedded = type === 'image/png' ? await out.embedPng(data) : await out.embedJpg(data)
            const base = page.getViewport({ scale: 1 })
            out.addPage([base.width, base.height]).drawImage(embedded, { x: 0, y: 0, width: base.width, height: base.height })
            page.cleanup()
          }
          await task.destroy()
          const saved = await out.save({ useObjectStreams: true })
          outputs.push((await host.fs.writeAll(`${ref.name.replace(/\.pdf$/i, '')}-enhanced.pdf`, saved, 'application/pdf')).id)
        }
        ctx.progress(1)
        return { outputs, summary: `已增强 ${outputs.length} 个 PDF（处理过的页面文字不可选中）` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'fill-form',
      name: 'PDF 表单填写',
      category: 'pdf',
      icon: 'list-todo',
      description: '读取 PDF 中的表单字段，直接在面板里填写文本、勾选框与下拉项，可选择填完后锁定（扁平化）。支持中文。',
      accept: ['application/pdf', '.pdf'],
      multiple: false,
      keywords: ['form', 'fill', 'acroform', 'fields', '表单', '填写', '填表', '申请表'],

      async setup(ui) {
        const pdf = ui.inputs.find(isPdfFile)
        if (!pdf) {
          ui.render({ runDisabled: true, nodes: [{ type: 'alert', tone: 'info', title: '先拖入一个带表单的 PDF', text: '字段会列在这里，填好后导出。' }] })
          return
        }
        requirePdfLib()
        const doc = await PDFLib.PDFDocument.load(await ui.host.fs.readAll(pdf.id), { ignoreEncryption: true })
        const fields = describeFields(doc)
        if (fields.length === 0) {
          ui.render({ runDisabled: true, nodes: [{ type: 'alert', tone: 'warning', title: '这个 PDF 没有可填写的表单字段', text: '扫描件或普通 PDF 可以用「添加图片 / 签名 / 文字」在页面上直接写字。' }] })
          return
        }
        const state = { flatten: false }
        const nodes = fields.map((field, i) => {
          const key = `f${i}`
          state[key] = field.value
          const label = field.label
          if (field.kind === 'checkbox') return { type: 'switch', bind: key, label }
          if (field.kind === 'choice') return { type: 'select', bind: key, label, options: [{ value: '', label: '（不选）' }, ...field.options.map((o) => ({ value: o, label: o }))] }
          return { type: field.multiline ? 'textarea' : 'input', bind: key, label, rows: 3, hint: field.readOnly ? '该字段原本只读，填写后会解除只读。' : undefined }
        })
        ui.render({
          state: { ...state, ...pickDefined(ui.state, state) },
          runLabel: '保存填好的 PDF',
          nodes: [
            { type: 'text', variant: 'muted', text: `共 ${fields.length} 个字段。` },
            { type: 'section', title: '字段', children: nodes },
            { type: 'switch', bind: 'flatten', label: '填完后锁定（扁平化）', hint: '字段变成页面内容，别人无法再修改。' },
          ],
        })
      },

      async run(ctx) {
        const ref = ctx.inputs.find(isPdfFile)
        const doc = await loadPdf(ref)
        const form = doc.getForm()
        const fields = describeFields(doc)
        let filled = 0
        const needsCjk = fields.some((_, i) => /[^\x00-\x7f]/.test(String(ctx.params[`f${i}`] ?? '')))
        for (const [i, field] of fields.entries()) {
          const value = ctx.params[`f${i}`]
          if (value === undefined) continue
          const target = form.getField(field.name)
          if (target.isReadOnly && target.isReadOnly()) target.disableReadOnly()
          if (field.kind === 'checkbox') value ? target.check() : target.uncheck()
          else if (field.kind === 'choice') {
            if (value) target.select(String(value))
          } else target.setText(String(value))
          filled++
        }
        // Standard fonts cannot draw Chinese; field appearances need the bundled font.
        if (needsCjk) form.updateFieldAppearances(await embedCjkFont(doc))
        if (ctx.params.flatten) form.flatten()
        const out = await host.fs.writeAll(`${ref.name.replace(/\.pdf$/i, '')}-filled.pdf`, await doc.save(), 'application/pdf')
        return { outputs: [out.id], summary: `已填写 ${filled} 个字段${ctx.params.flatten ? '并锁定' : ''}` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'auto-rotate',
      name: 'PDF 自动摆正页面',
      category: 'pdf',
      icon: 'refresh',
      description: '根据文字方向找出横躺或倒置的页面并自动转正（需要文字层；纯扫描页请先 OCR）。',
      accept: ['application/pdf', '.pdf'],
      multiple: true,
      keywords: ['auto rotate', 'orientation', 'upright', 'fix rotation', '自动旋转', '摆正', '页面方向', '倒置'],

      async run(ctx) {
        requirePdfjs()
        const outputs = []
        const notes = []
        for (const ref of ctx.inputs) {
          const bytes = await host.fs.readAll(ref.id)
          const task = pdfjsLib.getDocument({ ...workerFactories(), data: bytes.slice() })
          const pdf = await task.promise
          const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true })
          let fixed = 0
          let unknown = 0
          for (let n = 1; n <= pdf.numPages; n++) {
            ctx.throwIfAborted()
            const page = await pdf.getPage(n)
            // Viewport transform includes the page's /Rotate, so the angle is as displayed.
            const angle = dominantTextAngle(await page.getTextContent(), page.getViewport({ scale: 1 }).transform)
            page.cleanup()
            if (angle === null) {
              unknown++
              continue
            }
            if (angle !== 0) {
              const target = doc.getPage(n - 1)
              target.setRotation(PDFLib.degrees((((target.getRotation().angle + angle) % 360) + 360) % 360))
              fixed++
            }
          }
          await task.destroy()
          outputs.push((await host.fs.writeAll(`${ref.name.replace(/\.pdf$/i, '')}-upright.pdf`, await doc.save(), 'application/pdf')).id)
          notes.push(`${ref.name}：转正 ${fixed} 页${unknown ? `，${unknown} 页没有文字层无法判断` : ''}`)
        }
        return { outputs, summary: notes.join('\n') }
      },
    },

  ],
})

/* ========================================================================== */
/* Helpers                                                                    */
/* ========================================================================== */

function requirePdfLib() {
  if (typeof PDFLib === 'undefined' || !PDFLib.PDFDocument) {
    throw new Error('依赖 pdf-lib 未能注入沙盒，请在插件面板中重新加载该插件')
  }
}

let pdfjsReady = false

/**
 * pdf.js creates scratch canvases (image decoding, soft masks, patterns) through
 * a factory that defaults to `document.createElement('canvas')`. The sandbox runs
 * pdf.js in a Worker with no `document`, so any page containing an image failed
 * with "reading 'createElement'" - text-only pages never needed a canvas. These
 * factories use OffscreenCanvas, and skip the SVG filters (transfer functions,
 * high-contrast mode) that only exist as DOM elements; pages still render, those
 * rare effects are simply not applied.
 */
class WorkerCanvasFactory {
  constructor({ enableHWA = false } = {}) {
    this.enableHWA = enableHWA
  }
  create(width, height) {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size')
    const canvas = new OffscreenCanvas(width, height)
    return { canvas, context: canvas.getContext('2d', { willReadFrequently: !this.enableHWA }) }
  }
  reset(pair, width, height) {
    if (!pair.canvas) throw new Error('Canvas is not specified')
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size')
    pair.canvas.width = width
    pair.canvas.height = height
  }
  destroy(pair) {
    if (!pair.canvas) throw new Error('Canvas is not specified')
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

function workerFactories() {
  return { useWorkerFetch: false, isEvalSupported: false, CanvasFactory: WorkerCanvasFactory, FilterFactory: WorkerFilterFactory }
}

function requirePdfjs() {
  if (typeof pdfjsLib === 'undefined' || !pdfjsLib.getDocument) {
    throw new Error('依赖 pdf.js 未能注入沙盒，请在插件面板中重新加载该插件')
  }
  if (pdfjsReady) return
  // pdf.js normally fetches its worker from a URL, which the sandbox has no
  // network to do. Its fallback looks for `globalThis.pdfjsWorker`, which the
  // injected worker bundle provides - so pdf.js runs its worker code inline on
  // this thread. It logs "Setting up fake worker" when it takes that path.
  // That is the intended route here, not a misconfiguration: this thread is
  // already the sandbox's own Worker, so the host UI stays free either way.
  if (typeof pdfjsWorker === 'undefined' || !pdfjsWorker.WorkerMessageHandler) {
    throw new Error('依赖 pdfjs-worker 未能注入沙盒，请在插件面板中重新加载该插件')
  }
  pdfjsLib.GlobalWorkerOptions.workerPort = null
  pdfjsLib.GlobalWorkerOptions.workerSrc = ''
  pdfjsReady = true
}

async function loadPdf(ref) {
  requirePdfLib()
  const bytes = await host.fs.readAll(ref.id)
  try {
    // Encrypted-but-openable PDFs are common; refusing them outright is worse
    // than letting pdf-lib work past an owner password it can already bypass.
    return await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true })
  } catch (err) {
    throw new Error(`${ref.name} 不是有效的 PDF 或已加密：${err && err.message ? err.message : err}`)
  }
}

async function extractPages(source, indices) {
  const target = await PDFLib.PDFDocument.create()
  const copied = await target.copyPages(source, indices)
  for (const page of copied) target.addPage(page)
  return await target.save()
}

function range(start, end) {
  const out = []
  for (let i = start; i < end; i++) out.push(i)
  return out
}

/**
 * Parses `1-3,7,10-` into arrays of zero-based page indices, one per range.
 * Out-of-bounds pages are clamped away rather than throwing, so `1-999` on a
 * 5-page document means "all of it".
 */
function parseRanges(spec, total) {
  const result = []

  for (const raw of String(spec).split(',')) {
    const part = raw.trim()
    if (!part) continue

    const match = /^(\d*)\s*-\s*(\d*)$/.exec(part)
    let start
    let end

    if (match) {
      start = match[1] ? parseInt(match[1], 10) : 1
      end = match[2] ? parseInt(match[2], 10) : total
    } else if (/^\d+$/.test(part)) {
      start = end = parseInt(part, 10)
    } else {
      throw new Error(`无法解析页码范围：${part}`)
    }

    if (start > end) [start, end] = [end, start]
    start = Math.max(1, start)
    end = Math.min(total, end)

    const pages = []
    for (let page = start; page <= end; page++) pages.push(page - 1)
    if (pages.length > 0) result.push(pages)
  }

  return result
}

/** Rebuilds visual lines from pdf.js text items using their y coordinates. */
function joinLines(items) {
  const lines = []
  let currentY = null
  let buffer = []

  for (const item of items) {
    const y = Math.round(item.transform[5])
    if (currentY === null || Math.abs(y - currentY) <= 2) {
      buffer.push(item.str)
      currentY = currentY ?? y
    } else {
      lines.push(buffer.join('').trimEnd())
      buffer = [item.str]
      currentY = y
    }
    if (item.hasEOL) {
      lines.push(buffer.join('').trimEnd())
      buffer = []
      currentY = null
    }
  }
  if (buffer.length) lines.push(buffer.join('').trimEnd())
  return lines.filter((line) => line.length > 0).join('\n')
}

function ensurePdf(name) {
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`
}

function extensionFor(type) {
  return { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[type] ?? 'png'
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
/* Structure: actions, scripts, attachments, metadata                         */
/* ========================================================================== */

/** Action types that run code, start programs, or send data somewhere. */
const DANGEROUS_ACTIONS = new Set(['JavaScript', 'Launch', 'ImportData', 'SubmitForm', 'RichMediaExecute'])

function nameOf(value) {
  return value && value.constructor && value.constructor.name === 'PDFName' ? value.toString().replace(/^\//, '') : value ? String(value).replace(/^\//, '') : ''
}

function annotationKind(doc, ref) {
  const annot = doc.context.lookup(ref)
  return annot && annot.get ? nameOf(annot.get(PDFLib.PDFName.of('Subtype'))) : ''
}

/** Every dictionary in the file: indirect objects, plus one level of direct `/A` `/AA` dicts. */
function* allDicts(doc) {
  const { PDFDict, PDFStream } = PDFLib
  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    const dict = object instanceof PDFDict ? object : object instanceof PDFStream ? object.dict : null
    if (dict) yield { ref, dict }
  }
}

function actionType(doc, value) {
  const action = value && doc.context.lookup(value)
  return action && action.get ? nameOf(action.get(PDFLib.PDFName.of('S'))) : ''
}

/** Text of a PDF string, hex string or stream. */
function objectText(doc, value) {
  const { PDFString, PDFHexString, PDFRawStream, decodePDFRawStream } = PDFLib
  const object = value && doc.context.lookup(value)
  if (object instanceof PDFString || object instanceof PDFHexString) return object.decodeText()
  if (object instanceof PDFRawStream) {
    try {
      return new TextDecoder('latin1').decode(decodePDFRawStream(object).decode())
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * Removes document-level JavaScript, dangerous actions (see DANGEROUS_ACTIONS)
 * wherever they hang - open action, page and annotation actions, additional
 * actions - and returns how many it removed. Plain navigation (links to pages
 * or URLs) is left alone; that is what `links` is for.
 */
function removeScripts(doc) {
  const { PDFName, PDFDict } = PDFLib
  let removed = 0
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)
  if (names && names.has(PDFName.of('JavaScript'))) {
    names.delete(PDFName.of('JavaScript'))
    removed++
  }
  for (const { dict } of allDicts(doc)) {
    if (dict.has(PDFName.of('AA'))) {
      dict.delete(PDFName.of('AA'))
      removed++
    }
    for (const key of ['A', 'OpenAction', 'Next']) {
      const value = dict.get(PDFName.of(key))
      if (value && DANGEROUS_ACTIONS.has(actionType(doc, value))) {
        dict.delete(PDFName.of(key))
        removed++
      }
    }
  }
  return removed
}

function removeAttachments(doc) {
  const { PDFName, PDFDict } = PDFLib
  let removed = 0
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)
  if (names && names.has(PDFName.of('EmbeddedFiles'))) {
    removed += listAttachments(doc).length
    names.delete(PDFName.of('EmbeddedFiles'))
  }
  // A portfolio's cover sheet is meaningless without its files.
  doc.catalog.delete(PDFName.of('Collection'))
  return removed
}

function clearMetadata(doc) {
  const { PDFName } = PDFLib
  const info = doc.getInfoDict()
  for (const key of info.keys()) info.delete(key)
  doc.catalog.delete(PDFName.of('Metadata'))
}

/** Embedded files from the EmbeddedFiles name tree and file-attachment annotations. */
function listAttachments(doc) {
  const { PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream } = PDFLib
  const files = []
  const seen = new Set()

  const readSpec = (specValue, fallbackName) => {
    const spec = doc.context.lookup(specValue)
    if (!(spec instanceof PDFDict)) return
    const ef = spec.lookupMaybe(PDFName.of('EF'), PDFDict)
    if (!ef) return
    const streamRef = ef.get(PDFName.of('UF')) || ef.get(PDFName.of('F'))
    const stream = doc.context.lookup(streamRef)
    if (!(stream instanceof PDFRawStream) || seen.has(streamRef)) return
    seen.add(streamRef)
    const name = objectText(doc, spec.get(PDFName.of('UF'))) || objectText(doc, spec.get(PDFName.of('F'))) || fallbackName || `attachment-${files.length + 1}`
    const subtype = nameOf(stream.dict.get(PDFName.of('Subtype'))).replace(/#([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    files.push({ name: name.split(/[\\/]/).pop(), type: subtype, data: decodePDFRawStream(stream).decode() })
  }

  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)
  if (names && names.has(PDFName.of('EmbeddedFiles'))) {
    walkNameTree(doc, names.get(PDFName.of('EmbeddedFiles')), (key, value) => readSpec(value, key))
  }
  for (const page of doc.getPages()) {
    const annots = page.node.Annots()
    if (!annots) continue
    for (let i = 0; i < annots.size(); i++) {
      if (annotationKind(doc, annots.get(i)) !== 'FileAttachment') continue
      readSpec(doc.context.lookup(annots.get(i)).get(PDFName.of('FS')))
    }
  }
  return files
}

/** Calls `visit(key, value)` for every leaf of a PDF name tree. */
function walkNameTree(doc, rootValue, visit) {
  const { PDFName, PDFDict, PDFArray } = PDFLib
  const walk = (nodeValue, depth) => {
    const node = doc.context.lookup(nodeValue)
    if (!(node instanceof PDFDict) || depth > 32) return
    const pairs = node.lookupMaybe(PDFName.of('Names'), PDFArray)
    if (pairs) for (let i = 0; i + 1 < pairs.size(); i += 2) visit(objectText(doc, pairs.get(i)), pairs.get(i + 1))
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray)
    if (kids) for (let i = 0; i < kids.size(); i++) walk(kids.get(i), depth + 1)
  }
  walk(rootValue, 0)
}

function securityReport(doc) {
  const { PDFName, PDFDict } = PDFLib
  const javascript = []
  const actions = []
  const links = new Set()

  const describe = (ref, key) => (ref ? `对象 ${ref.objectNumber} 的 /${key}` : `/${key}`)

  const inspect = (value, where) => {
    const action = value && doc.context.lookup(value)
    if (!(action instanceof PDFDict)) return
    const type = nameOf(action.get(PDFName.of('S')))
    if (type === 'JavaScript') javascript.push({ where, code: objectText(doc, action.get(PDFName.of('JS'))).slice(0, 2000) })
    else if (type === 'URI') links.add(objectText(doc, action.get(PDFName.of('URI'))))
    else if (type === 'Launch' || type === 'SubmitForm' || type === 'ImportData' || type === 'RichMediaExecute' || type === 'GoToR' || type === 'GoToE') {
      const target = objectText(doc, action.get(PDFName.of('F'))) || objectText(doc, doc.context.lookup(action.get(PDFName.of('F')))?.get?.(PDFName.of('F')))
      actions.push({ where, type, target: target || undefined })
    }
  }

  for (const { ref, dict } of allDicts(doc)) {
    for (const key of ['A', 'OpenAction', 'Next']) inspect(dict.get(PDFName.of(key)), describe(ref, key))
    const aa = dict.get(PDFName.of('AA')) && doc.context.lookup(dict.get(PDFName.of('AA')))
    if (aa instanceof PDFDict) for (const [trigger, value] of aa.entries()) inspect(value, `${describe(ref, 'AA')} ${trigger.toString()}`)
  }
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)
  const hasDocumentScripts = !!(names && names.has(PDFName.of('JavaScript')))
  if (hasDocumentScripts) {
    // Document-level scripts live in a name tree and run when the file opens.
    walkNameTree(doc, names.get(PDFName.of('JavaScript')), (key, value) => {
      const action = doc.context.lookup(value)
      if (action instanceof PDFDict) javascript.unshift({ where: `文档级脚本「${key}」`, code: objectText(doc, action.get(PDFName.of('JS'))).slice(0, 2000) })
    })
  }

  const form = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)
  const report = {
    pages: doc.getPageCount(),
    encrypted: doc.isEncrypted,
    javascript,
    documentLevelScripts: hasDocumentScripts,
    actions,
    links: [...links].filter(Boolean).slice(0, 200),
    attachments: listAttachments(doc).map((f) => ({ name: f.name, bytes: f.data.length })),
    form: { fields: doc.getForm().getFields().length, xfa: !!(form && form.has(PDFName.of('XFA'))) },
  }
  const high = javascript.length > 0 || hasDocumentScripts || actions.some((a) => a.type === 'Launch' || a.type === 'RichMediaExecute')
  const low = actions.length > 0 || report.attachments.length > 0 || report.form.xfa
  return { risk: high ? 'high' : low ? 'low' : 'none', ...report }
}

/* ========================================================================== */
/* Rendering-based checks                                                     */
/* ========================================================================== */

/**
 * Share of "inked" pixels on a page rendered ~200 px wide. A 3% border is
 * ignored: scanners leave dark edges on otherwise empty sheets.
 */
async function inkRatio(page, whiteLevel) {
  const base = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale: 200 / base.width })
  const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  const g = canvas.getContext('2d', { willReadFrequently: true })
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: g, viewport }).promise
  page.cleanup()

  const marginX = Math.floor(canvas.width * 0.03)
  const marginY = Math.floor(canvas.height * 0.03)
  const { data } = g.getImageData(marginX, marginY, canvas.width - marginX * 2, canvas.height - marginY * 2)
  let inked = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114 < whiteLevel) inked++
  }
  return inked / (data.length / 4)
}

/** pdf.js image objects arrive asynchronously; waits for one, or gives up. */
function resolveObject(page, id) {
  return new Promise((resolve) => {
    const store = id.startsWith('g_') ? page.commonObjs : page.objs
    const timer = setTimeout(() => resolve(null), 5000)
    try {
      store.get(id, (value) => {
        clearTimeout(timer)
        resolve(value)
      })
    } catch {
      clearTimeout(timer)
      resolve(null)
    }
  })
}

/** pdf.js image data (bitmap, or packed 1/24/32-bit pixels) → canvas. */
function imageToCanvas(image) {
  const canvas = new OffscreenCanvas(image.width, image.height)
  const g = canvas.getContext('2d')
  if (image.bitmap) {
    g.drawImage(image.bitmap, 0, 0)
    return canvas
  }
  if (!image.data) return null
  const { width, height, data, kind } = image
  const out = g.createImageData(width, height)
  const rgba = out.data
  if (kind === 1) {
    const rowBytes = (width + 7) >> 3
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1
        const o = (y * width + x) * 4
        rgba[o] = rgba[o + 1] = rgba[o + 2] = bit ? 255 : 0
        rgba[o + 3] = 255
      }
    }
  } else if (kind === 2) {
    for (let i = 0, o = 0; i < width * height; i++, o += 4) {
      rgba[o] = data[i * 3]
      rgba[o + 1] = data[i * 3 + 1]
      rgba[o + 2] = data[i * 3 + 2]
      rgba[o + 3] = 255
    }
  } else {
    rgba.set(data.subarray(0, rgba.length))
  }
  g.putImageData(out, 0, 0)
  return canvas
}

/* ========================================================================== */
/* Page geometry                                                              */
/* ========================================================================== */

const PAPERS = { a4: [595.28, 841.89], a3: [841.89, 1190.55], a5: [419.53, 595.28], letter: [612, 792], legal: [612, 1008] }

function mm(value) {
  return (value * 72) / 25.4
}

/**
 * Moves the content stream pdf-lib just appended to the front, so what was drawn
 * last paints first - underneath the page. pdf-lib wraps the original streams in
 * q/Q before appending, and its own stream saves and restores state, so the
 * reordering cannot leak a transform into the page.
 */
function moveLastContentToFront(page) {
  const contents = page.node.Contents()
  if (!contents || typeof contents.size !== 'function' || contents.size() < 2) return
  const last = contents.get(contents.size() - 1)
  contents.remove(contents.size() - 1)
  contents.insert(0, last)
}

/**
 * Saddle-stitch imposition. For 4k pages, sheet s (0-based) carries
 * front [4k-1-2s, 2s] and back [2s+1, 4k-2-2s]; pages past the end stay blank.
 * Right-to-left binding mirrors each spread.
 */
async function bookletImpose(source, { rightToLeft, creepMm }) {
  const doc = await PDFLib.PDFDocument.create()
  const count = source.getPageCount()
  const total = Math.ceil(count / 4) * 4
  const { width, height } = source.getPage(0).getSize()
  const embedded = await embedAll(doc, source)
  const sheets = total / 4
  const creep = mm(creepMm)

  const place = (sheet, index, side, shift) => {
    if (index >= count || !embedded[index]) return
    const page = embedded[index]
    const scale = Math.min(width / page.width, height / page.height)
    const w = page.width * scale
    const h = page.height * scale
    const x = (side === 'left' ? 0 : width) + (width - w) / 2 + (side === 'left' ? shift : -shift)
    sheet.drawPage(page, { x, y: (height - h) / 2, width: w, height: h })
  }

  for (let s = 0; s < sheets; s++) {
    // Inner sheets sit further from the fold edge once nested; pull them in.
    const shift = sheets > 1 ? (creep * s) / (sheets - 1) : 0
    const spreads = [
      [total - 1 - 2 * s, 2 * s],
      [2 * s + 1, total - 2 - 2 * s],
    ]
    for (const [left, right] of spreads) {
      const sheet = doc.addPage([width * 2, height])
      const [l, r] = rightToLeft ? [right, left] : [left, right]
      place(sheet, l, 'left', shift)
      place(sheet, r, 'right', shift)
    }
  }
  return doc.save()
}

async function layoutPages(source, { mode, paper, orientation, amount }) {
  if (mode === 'single') {
    const doc = await PDFLib.PDFDocument.create()
    const embedded = await embedAll(doc, source)
    // A blank page still takes its space in the stack.
    const pages = embedded.map((page, i) => page || { blank: true, ...source.getPage(i).getSize() })
    const width = Math.max(...pages.map((p) => p.width))
    const height = pages.reduce((sum, p) => sum + p.height, 0)
    if (height > 14400) {
      await host.ui.notify(`拼接后高度 ${Math.round(height / 72)} 英寸，超过 Acrobat 200 英寸的上限；浏览器和大多数阅读器仍可打开。`, 'warn')
    }
    const sheet = doc.addPage([width, height])
    let y = height
    for (const page of pages) {
      y -= page.height
      if (!page.blank) sheet.drawPage(page, { x: (width - page.width) / 2, y })
    }
    return doc.save()
  }

  // The other modes edit boxes in place, which keeps links, annotations and
  // form fields working - re-embedding pages would flatten them away.
  for (const page of source.getPages()) {
    const box = page.getMediaBox()
    if (mode === 'crop') {
      const crop = page.getCropBox()
      if (crop.width - amount * 2 < 36 || crop.height - amount * 2 < 36) throw new Error('裁边宽度过大，页面剩余不足 0.5 英寸')
      page.setCropBox(crop.x + amount, crop.y + amount, crop.width - amount * 2, crop.height - amount * 2)
    } else if (mode === 'margin') {
      setAllBoxes(page, box.x - amount, box.y - amount, box.width + amount * 2, box.height + amount * 2)
    } else {
      const rotated = page.getRotation().angle % 180 !== 0
      const shownW = rotated ? box.height : box.width
      const shownH = rotated ? box.width : box.height
      let [pw, ph] = PAPERS[paper] ?? PAPERS.a4
      const landscape = orientation === 'landscape' || (orientation === 'auto' && shownW > shownH)
      if (landscape) [pw, ph] = [ph, pw]
      // Work in the unrotated box: a /Rotate 90 page stores its paper sideways.
      const [tw, th] = rotated ? [ph, pw] : [pw, ph]
      const scale = Math.min(tw / box.width, th / box.height)
      page.scale(scale, scale)
      const x = box.x * scale - (tw - box.width * scale) / 2
      const y = box.y * scale - (th - box.height * scale) / 2
      setAllBoxes(page, x, y, tw, th)
    }
  }
  return source.save()
}

/**
 * Embeds every page of `source`, with `null` for pages that have no content
 * stream at all. Truly blank pages are common (inserted separators, scanner
 * output) and pdf-lib refuses to embed them.
 */
async function embedAll(doc, source) {
  const pages = source.getPages()
  const drawable = pages.filter((page) => page.node.Contents())
  const embedded = drawable.length ? await doc.embedPages(drawable) : []
  const byPage = new Map(drawable.map((page, i) => [page, embedded[i]]))
  return pages.map((page) => byPage.get(page) || null)
}

function setAllBoxes(page, x, y, width, height) {
  page.setMediaBox(x, y, width, height)
  page.setCropBox(x, y, width, height)
  page.setBleedBox(x, y, width, height)
  page.setTrimBox(x, y, width, height)
  page.setArtBox(x, y, width, height)
}

/* ========================================================================== */
/* Outline                                                                    */
/* ========================================================================== */

/**
 * "Title  12" lines → a tree. Two spaces or a tab per level; a missing page
 * number inherits the previous entry's page; a level can only go one deeper
 * than the line above.
 */
function parseOutlineText(text, pageCount) {
  const root = []
  const stack = [{ level: -1, children: root }]
  let lastPage = 1
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue
    const indent = raw.match(/^[ \t]*/)[0]
    let level = 0
    for (const ch of indent) level += ch === '\t' ? 2 : 1
    level = Math.floor(level / 2)
    const match = /^(.*?)[\s.·…]+(\d+)\s*$/.exec(raw.trim())
    const title = (match ? match[1] : raw.trim()).trim()
    if (!title) continue
    const page = match ? Math.min(Math.max(1, parseInt(match[2], 10)), pageCount) : lastPage
    lastPage = page
    while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop()
    const parent = stack[stack.length - 1]
    const node = { title, page, children: [], level: parent.level + 1 }
    parent.children.push(node)
    stack.push(node)
  }
  if (root.length === 0) throw new Error('书签文本为空')
  return root
}

function countOutline(items) {
  return items.reduce((sum, item) => sum + 1 + countOutline(item.children), 0)
}

function writeOutline(doc, items) {
  const { PDFName, PDFHexString, PDFNumber } = PDFLib
  const context = doc.context
  const pages = doc.getPages()

  const build = (list, parentRef) => {
    const refs = list.map(() => context.nextRef())
    let visible = list.length
    list.forEach((item, i) => {
      const dict = context.obj({ Title: PDFHexString.fromText(item.title), Parent: parentRef, Dest: [pages[item.page - 1].ref, 'Fit'] })
      if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1])
      if (i < list.length - 1) dict.set(PDFName.of('Next'), refs[i + 1])
      if (item.children.length) {
        const sub = build(item.children, refs[i])
        dict.set(PDFName.of('First'), sub.first)
        dict.set(PDFName.of('Last'), sub.last)
        dict.set(PDFName.of('Count'), PDFNumber.of(sub.visible))
        visible += sub.visible
      }
      context.assign(refs[i], dict)
    })
    return { first: refs[0], last: refs[refs.length - 1], visible }
  }

  const outlinesRef = context.nextRef()
  const top = build(items, outlinesRef)
  context.assign(outlinesRef, context.obj({ Type: 'Outlines', First: top.first, Last: top.last, Count: PDFNumber.of(top.visible) }))
  doc.catalog.set(PDFName.of('Outlines'), outlinesRef)
  doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'))
}

async function outlinePage(doc, dest) {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest
    if (!Array.isArray(explicit) || !explicit[0]) return null
    const target = explicit[0]
    return typeof target === 'number' ? target + 1 : (await doc.getPageIndex(target)) + 1
  } catch {
    return null
  }
}

/* ========================================================================== */
/* Text: titles and comparison                                                */
/* ========================================================================== */

/** The biggest-font run of text on a page, joined in reading order. */
function largestText(content) {
  const items = content.items.filter((item) => item.str && item.str.trim())
  if (items.length === 0) return ''
  const size = (item) => Math.hypot(item.transform[2], item.transform[3]) || item.height || 0
  const max = Math.max(...items.map(size))
  const title = items
    .filter((item) => size(item) >= max * 0.9)
    .map((item) => item.str)
    .join(' ')
  return title.replace(/\s+/g, ' ').trim().slice(0, 200)
}

function cleanFileName(text) {
  return String(text || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
}

async function pdfText(ref) {
  const bytes = await host.fs.readAll(ref.id)
  const loadingTask = pdfjsLib.getDocument({ ...workerFactories(),  data: bytes, useWorkerFetch: false, isEvalSupported: false })
  const doc = await loadingTask.promise
  const pages = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    pages.push(joinLines((await page.getTextContent()).items))
    page.cleanup()
  }
  await loadingTask.destroy()
  return pages.join('\n')
}

/** Largest edit distance examined before falling back to a coarse replace. */
const MAX_DIFF_DISTANCE = 4000

/**
 * Token diff: common prefix and suffix trimmed, then Myers' O(ND) algorithm on
 * the rest. Returns runs `{ type: 'unchanged' | 'added' | 'removed', tokens }`.
 */
function diffTokens(a, b) {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const parts = []
  const push = (type, token) => {
    const last = parts[parts.length - 1]
    if (last && last.type === type) last.tokens.push(token)
    else parts.push({ type, tokens: [token] })
  }
  for (let i = 0; i < start; i++) push('unchanged', a[i])
  for (const [type, token] of myers(a.slice(start, endA), b.slice(start, endB))) push(type, token)
  for (let i = endA; i < a.length; i++) push('unchanged', a[i])
  return parts
}

function myers(a, b) {
  const n = a.length
  const m = b.length
  if (n === 0) return b.map((t) => ['added', t])
  if (m === 0) return a.map((t) => ['removed', t])
  const max = Math.min(n + m, MAX_DIFF_DISTANCE)
  const offset = max + 1
  let v = new Int32Array(2 * max + 3)
  const trace = []

  for (let d = 0; d <= max; d++) {
    // Only diagonals -d..d are live, so keep just that window per step.
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) return backtrack(trace, a, b, d)
    }
  }
  // Too different to align usefully within budget: report a wholesale change.
  return [...a.map((t) => ['removed', t]), ...b.map((t) => ['added', t])]
}

function backtrack(trace, a, b, distance) {
  const ops = []
  let x = a.length
  let y = b.length
  for (let d = distance; d > 0; d--) {
    const window = trace[d]
    const at = (k) => window[k + d + 1]
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push(['unchanged', a[--x]])
      y--
    }
    if (x === prevX) ops.push(['added', b[--y]])
    else ops.push(['removed', a[--x]])
  }
  while (x > 0 && y > 0) {
    ops.push(['unchanged', a[--x]])
    y--
  }
  return ops.reverse()
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function diffReport(nameA, nameB, parts, stats, inline) {
  const body = inline
    ? `<p class="inline">${parts
        .map((part) => {
          const text = escapeHtml(part.tokens.join(part.tokens.some((t) => /^[\x21-\x7e]+$/.test(t)) ? ' ' : '')).replace(/\n/g, '<br>')
          return part.type === 'unchanged' ? text : `<span class="${part.type}">${text}</span>`
        })
        .join(' ')}</p>`
    : parts
        .map((part) => {
          if (part.type === 'unchanged' && part.tokens.length > 8) {
            const head = part.tokens.slice(0, 3)
            const tail = part.tokens.slice(-3)
            return [...head.map((t) => row('unchanged', t)), `<div class="skip">… 省略 ${part.tokens.length - 6} 行相同内容 …</div>`, ...tail.map((t) => row('unchanged', t))].join('')
          }
          return part.tokens.map((t) => row(part.type, t)).join('')
        })
        .join('')

  function row(type, text) {
    const mark = type === 'added' ? '+' : type === 'removed' ? '−' : ' '
    return `<div class="line ${type}"><span class="mark">${mark}</span>${escapeHtml(text) || '&nbsp;'}</div>`
  }

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PDF 文本比较</title>
<style>
:root{color-scheme:light dark}
body{margin:0;padding:1.5rem;font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#fff;color:#1a1a1f}
h1{font-size:1.2rem;margin:0 0 .25rem}.files{color:#666;margin:0 0 1rem}
.stats span{display:inline-block;margin-right:1rem;font-weight:600}.stats .a{color:#15803d}.stats .r{color:#b91c1c}
.diff{border:1px solid #e5e5e5;border-radius:8px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
.line{white-space:pre-wrap;padding:0 .75rem 0 0;display:flex}.mark{width:2rem;flex:none;text-align:center;color:#999;user-select:none}
.added{background:#dcfce7}.removed{background:#fee2e2;text-decoration:line-through;text-decoration-color:#b91c1c80}
.skip{color:#999;padding:.25rem 2rem;background:#fafafa}
.inline{white-space:normal;padding:1rem;margin:0;font-family:inherit;font-size:15px;line-height:1.9}.inline .added,.inline .removed{border-radius:3px;padding:0 2px}
@media (prefers-color-scheme:dark){body{background:#16161a;color:#e6e6e9}.diff{border-color:#333}.added{background:#14532d}.removed{background:#7f1d1d}.skip{background:#1f1f25}}
</style></head><body>
<h1>PDF 文本比较</h1>
<p class="files">原文件：${escapeHtml(nameA)} → 新文件：${escapeHtml(nameB)}</p>
<p class="stats"><span class="a">新增 ${stats.added}</span><span class="r">删除 ${stats.removed}</span><span>相同 ${stats.unchanged}</span></p>
<div class="diff">${body}</div>
</body></html>`
}

/* ========================================================================== */
/* Placement tools: stamp, redact, forms, orientation                        */
/* ========================================================================== */

const STAMP_DEFAULTS = { kind: 'draw', box: [0.58, 0.8, 0.32, 0.1], page: 1, pages: 'current', range: '', text: '', color: '#1e3a8a', opacity: 100 }
const REDACT_DEFAULTS = { box: [0.1, 0.1, 0.4, 0.05], page: 1, areas: [], terms: '', patterns: false, dpi: 150 }

function isPdfFile(input) {
  return input.type === 'application/pdf' || /\.pdf$/i.test(input.name)
}

function isImageRef(input) {
  return /^image\/(png|jpeg)$/.test(input.type || '') || /\.(png|jpe?g)$/i.test(input.name)
}

/** The keys of `defaults` that `state` actually has, so saved panel state survives a re-open. */
function pickDefined(state, defaults) {
  const out = {}
  for (const key of Object.keys(defaults)) if (state && state[key] !== undefined && state[key] !== null) out[key] = state[key]
  return out
}

function normaliseBox(box) {
  const [x = 0.6, y = 0.8, w = 0.3, h = 0.1] = Array.isArray(box) ? box.map(Number) : []
  const cw = Math.min(1, Math.max(0.005, w))
  const ch = Math.min(1, Math.max(0.005, h))
  return [Math.min(1 - cw, Math.max(0, x)), Math.min(1 - ch, Math.max(0, y)), cw, ch]
}

function hexColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''))
  const n = m ? parseInt(m[1], 16) : 0x1e3a8a
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** `[page, x, y, w, h, page, x, …]` → `[{ page, box }]`. */
function chunkAreas(flat) {
  const list = Array.isArray(flat) ? flat : []
  const areas = []
  for (let i = 0; i + 4 < list.length; i += 5) areas.push({ page: Math.round(list[i]), box: list.slice(i + 1, i + 5) })
  return areas
}

async function embedCjkFont(doc) {
  const { exports: fontkitModule } = await loadDependency('fontkit')
  const { exports: fonts, assets } = await loadDependency('cjk-font')
  const name = 'NotoSansSC-Regular.ttf'
  if (!fonts[name]?.available || !assets[name] || assets[name].byteLength < 1024) {
    throw new Error('内置中文字体未打包（构建时需要联网运行一次 pnpm vendor），暂时无法写入文字')
  }
  doc.registerFontkit(fontkitModule.default ?? fontkitModule)
  return doc.embedFont(new Uint8Array(assets[name]), { subset: true })
}

/**
 * Renders PDF pages to PNG previews for a panel's `media` node, one file per
 * page, reusing the last one and deleting superseded previews so the workspace
 * does not fill up while the user flips through pages.
 */
function pagePreviewer(ui, pdfRef) {
  let loading = null
  let current = null
  const load = () => {
    requirePdfjs()
    if (!loading) {
      loading = ui.host.fs.readAll(pdfRef.id).then((bytes) => pdfjsLib.getDocument({ ...workerFactories(), data: bytes }).promise)
    }
    return loading
  }
  return {
    async show(pageNumber, blackBoxes = []) {
      const pdf = await load()
      const n = Math.min(pdf.numPages, Math.max(1, pageNumber))
      const key = `${n}|${JSON.stringify(blackBoxes.map((b) => b.box))}`
      if (current && current.key === key) return { fileId: current.fileId, count: pdf.numPages }
      const page = await pdf.getPage(n)
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: Math.min(3, 1000 / Math.max(base.width, base.height)) })
      const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      const g = canvas.getContext('2d')
      g.fillStyle = '#ffffff'
      g.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: g, viewport }).promise
      page.cleanup()
      g.fillStyle = '#000000'
      for (const { box } of blackBoxes) {
        const [x, y, w, h] = normaliseBox(box)
        g.fillRect(x * canvas.width, y * canvas.height, w * canvas.width, h * canvas.height)
      }
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
      const file = await ui.host.fs.writeAll(`page-${n}-preview.png`, bytes, 'image/png')
      if (current) await ui.host.fs.remove(current.fileId).catch(() => {})
      current = { key, fileId: file.id }
      return { fileId: file.id, count: pdf.numPages }
    },
  }
}

/* ------------------------------ signatures -------------------------------- */

/** Strokes per tool, shared by the panel (drawing) and run (embedding) in this sandbox. */
const signatures = new Map()

function signatureStrokes(toolId) {
  if (!signatures.has(toolId)) signatures.set(toolId, [])
  return signatures.get(toolId)
}

function strokePath(g, points, scaleX, scaleY, offsetX = 0, offsetY = 0) {
  g.beginPath()
  const [x0, y0] = points[0]
  g.moveTo(x0 * scaleX - offsetX, y0 * scaleY - offsetY)
  if (points.length === 1) g.lineTo(x0 * scaleX - offsetX + 0.1, y0 * scaleY - offsetY)
  // Midpoint quadratics smooth the jitter of pointer sampling.
  for (let i = 1; i < points.length - 1; i++) {
    const [x1, y1] = points[i]
    const [x2, y2] = points[i + 1]
    g.quadraticCurveTo(x1 * scaleX - offsetX, y1 * scaleY - offsetY, ((x1 + x2) / 2) * scaleX - offsetX, ((y1 + y2) / 2) * scaleY - offsetY)
  }
  if (points.length > 1) {
    const [xl, yl] = points[points.length - 1]
    g.lineTo(xl * scaleX - offsetX, yl * scaleY - offsetY)
  }
  g.stroke()
}

function redrawSignature(canvas, strokes, color) {
  const g = canvas.getContext('2d')
  g.clearRect(0, 0, canvas.width, canvas.height)
  g.strokeStyle = 'rgba(0,0,0,0.12)'
  g.lineWidth = 1
  g.beginPath()
  g.moveTo(canvas.width * 0.06, canvas.height * 0.75)
  g.lineTo(canvas.width * 0.94, canvas.height * 0.75)
  g.stroke()
  g.strokeStyle = color || '#1e3a8a'
  g.lineCap = 'round'
  g.lineJoin = 'round'
  g.lineWidth = Math.max(2, canvas.width / 220)
  for (const stroke of strokes) strokePath(g, stroke.points, canvas.width / stroke.w, canvas.height / stroke.h)
}

/** The signature cropped to its ink, at print resolution, transparent background. */
async function signaturePng(strokes, [r, g, b]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const stroke of strokes) {
    for (const [x, y] of stroke.points) {
      const nx = x / stroke.w
      const ny = y / stroke.h
      minX = Math.min(minX, nx); maxX = Math.max(maxX, nx)
      minY = Math.min(minY, ny); maxY = Math.max(maxY, ny)
    }
  }
  const scale = 1600
  const pad = 0.02
  const width = Math.max(16, Math.ceil((maxX - minX + pad * 2) * scale))
  const height = Math.max(16, Math.ceil(((maxY - minY + pad * 2) * scale) / 3))
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.strokeStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(4, scale / 220)
  for (const stroke of strokes) {
    const normalised = stroke.points.map(([x, y]) => [x / stroke.w, y / stroke.h])
    strokePath(ctx, normalised, scale, scale / 3, (minX - pad) * scale, ((minY - pad) * scale) / 3)
  }
  return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
}

/* -------------------------- rotation-aware geometry ------------------------ */

/** Largest box of `aspect` (w/h in points) centred in `box` (display fractions). */
function fitIntoBox(box, aspect, display) {
  const [x, y, w, h] = box
  const bw = w * display.w
  const bh = h * display.h
  const scale = Math.min(bw / aspect, bh)
  const fw = (scale * aspect) / display.w
  const fh = scale / display.h
  return [x + (w - fw) / 2, y + (h - fh) / 2, fw, fh]
}

/**
 * A box in displayed-page fractions (origin top-left, y down, as the preview
 * shows it) → the region it covers in unrotated PDF user space (origin
 * bottom-left). pdf.js draws `/Rotate` clockwise, so the mapping per rotation is
 * the inverse of that turn.
 */
function displayBoxToPage([bx, by, bw, bh], rotation, crop) {
  const W = crop.width
  const H = crop.height
  const map = (u, v) => {
    if (rotation === 90) return [crop.x + v * W, crop.y + u * H]
    if (rotation === 180) return [crop.x + (1 - u) * W, crop.y + v * H]
    if (rotation === 270) return [crop.x + (1 - v) * W, crop.y + (1 - u) * H]
    return [crop.x + u * W, crop.y + (1 - v) * H]
  }
  const [ax, ay] = map(bx, by)
  const [cx, cy] = map(bx + bw, by + bh)
  return { x1: Math.min(ax, cx), y1: Math.min(ay, cy), x2: Math.max(ax, cx), y2: Math.max(ay, cy) }
}

/**
 * pdf-lib position and size for content rotated counter-clockwise by the page
 * rotation (so it reads upright in a viewer), filling `region`. Rotation pivots
 * on the drawn object's lower-left corner, hence the corner chosen per angle.
 */
function drawPlacement(region, rotation) {
  const w = region.x2 - region.x1
  const h = region.y2 - region.y1
  if (rotation === 90) return { x: region.x2, y: region.y1, width: h, height: w }
  if (rotation === 180) return { x: region.x2, y: region.y2, width: w, height: h }
  if (rotation === 270) return { x: region.x1, y: region.y2, width: h, height: w }
  return { x: region.x1, y: region.y1, width: w, height: h }
}

/* ----------------------------- text search -------------------------------- */

const SENSITIVE_PATTERNS = [
  /1[3-9]\d{9}/g, // mainland mobile numbers
  /\d{17}[\dXx]/g, // resident ID numbers
  /[\w.+-]+@[\w-]+(\.[\w-]+)+/g, // email addresses
  /\b\d{16,19}\b/g, // bank card numbers
]

/**
 * Boxes (display fractions) around each occurrence of the terms, within pdf.js
 * text items. Character positions inside an item are interpolated by index,
 * which is accurate for CJK and close enough for Latin at redaction margins.
 */
function findTextBoxes(content, viewport, terms, patterns) {
  const boxes = []
  for (const item of content.items) {
    if (!item.str) continue
    const m = pdfjsLib.Util.transform(viewport.transform, item.transform)
    const fontHeight = Math.hypot(m[2], m[3])
    const width = item.width * viewport.scale
    const x = m[4]
    const top = m[5] - fontHeight
    const hits = []
    for (const term of terms) {
      let from = 0
      while (term && (from = item.str.indexOf(term, from)) !== -1) {
        hits.push([from, term.length])
        from += term.length
      }
    }
    if (patterns) for (const re of SENSITIVE_PATTERNS) for (const match of item.str.matchAll(re)) hits.push([match.index, match[0].length])
    const perChar = width / Math.max(1, item.str.length)
    for (const [start, length] of hits) {
      boxes.push([
        Math.max(0, (x + start * perChar - 1) / viewport.width),
        Math.max(0, (top - fontHeight * 0.15) / viewport.height),
        Math.min(1, (length * perChar + 2) / viewport.width),
        Math.min(1, (fontHeight * 1.35) / viewport.height),
      ])
    }
  }
  return boxes
}

/* -------------------------------- forms ----------------------------------- */

function describeFields(doc) {
  const { PDFTextField, PDFCheckBox, PDFDropdown, PDFOptionList, PDFRadioGroup } = PDFLib
  const out = []
  for (const field of doc.getForm().getFields()) {
    const name = field.getName()
    const label = name.split('.').pop().replace(/\[\d+\]$/, '') || name
    const readOnly = field.isReadOnly()
    if (field instanceof PDFTextField) out.push({ name, label, kind: 'text', value: field.getText() ?? '', multiline: field.isMultiline(), readOnly })
    else if (field instanceof PDFCheckBox) out.push({ name, label, kind: 'checkbox', value: field.isChecked(), readOnly })
    else if (field instanceof PDFDropdown || field instanceof PDFOptionList) out.push({ name, label, kind: 'choice', value: field.getSelected()[0] ?? '', options: field.getOptions(), readOnly })
    else if (field instanceof PDFRadioGroup) out.push({ name, label, kind: 'choice', value: field.getSelected() ?? '', options: field.getOptions(), readOnly })
  }
  return out
}

/* ------------------------------ orientation -------------------------------- */

/**
 * Rotation (0 / 90 / 180 / 270, clockwise) to add to a page so its text reads
 * upright, from the length-weighted direction of its text items as displayed.
 * `null` when the page has too little text to judge.
 */
function dominantTextAngle(content, viewportTransform) {
  const weights = [0, 0, 0, 0]
  let total = 0
  for (const item of content.items) {
    const length = (item.str || '').trim().length
    if (!length) continue
    const m = pdfjsLib.Util.transform(viewportTransform, item.transform)
    const quadrant = ((Math.round(Math.atan2(m[1], m[0]) / (Math.PI / 2)) % 4) + 4) % 4
    weights[quadrant] += length
    total += length
  }
  if (total < 12) return null
  const quadrant = weights.indexOf(Math.max(...weights))
  // Text running clockwise by 90° (downwards) needs the page turned back by 90°.
  return (360 - quadrant * 90) % 360
}

/* ========================================================================== */
/* qpdf                                                                       */
/* ========================================================================== */

/** One qpdf instance per run; its in-memory file system is cleared after each command. */
async function openQpdf() {
  const { exports, assets } = await loadDependency('qpdf')
  if (!assets['qpdf.wasm']) throw new Error('qpdf.wasm 未随依赖下发')
  return exports.createQpdf(new Uint8Array(assets['qpdf.wasm']))
}

let qpdfSeq = 0

/**
 * Writes `bytes` into qpdf's memory file system, runs the command `build(input,
 * output)` returns and reads the output back. Exit code 3 means success with
 * warnings (a damaged but readable file); anything else fails with qpdf's message.
 */
function runQpdfOnFile(q, bytes, build, label) {
  const id = ++qpdfSeq
  const input = `/in-${id}.pdf`
  const output = `/out-${id}.pdf`
  q.FS.writeFile(input, bytes)
  try {
    const { code, output: message } = q.run(build(input, output))
    if (code !== 0 && code !== 3) throw new Error(qpdfError(label, message))
    return q.FS.readFile(output)
  } finally {
    for (const path of [input, output]) {
      try {
        q.FS.unlink(path)
      } catch (err) {
        /* not created */
      }
    }
  }
}

function qpdfError(label, message) {
  const text = String(message || '').replace(/\/(in|out)-\d+\.pdf:?\s*/g, '').trim()
  if (/invalid password/i.test(text)) return `${label} 的密码不正确`
  if (/not a PDF|can't find PDF header/i.test(text)) return `${label} 不是有效的 PDF`
  return `${label} 处理失败：${text || '未知错误'}`
}

function isEncryptedPdf(q, bytes) {
  const path = `/probe-${++qpdfSeq}.pdf`
  q.FS.writeFile(path, bytes)
  try {
    // `--is-encrypted` exits 0 for encrypted files and 2 otherwise. For a file that needs an open
    // password this build fails to open it instead (no exception catching), which also means encrypted.
    const { code, output } = q.run(['--is-encrypted', path])
    return code === 0 || /password/i.test(output)
  } finally {
    q.FS.unlink(path)
  }
}

/** `qpdf --check`: `{ ok, detail }` with the first problem it reports. */
function checkPdf(q, bytes) {
  const path = `/check-${++qpdfSeq}.pdf`
  q.FS.writeFile(path, bytes)
  try {
    const { code, output } = q.run(['--check', path])
    const problems = output
      .split('\n')
      .map((line) => line.replace(/\/check-\d+\.pdf:?\s*/g, '').trim())
      .filter((line) => line && !/^(checking|PDF Version|File is not|No syntax|errors that qpdf)/i.test(line))
    return { ok: code === 0 && problems.length === 0, detail: problems[0] || (code === 0 ? '' : '文件结构损坏') }
  } finally {
    q.FS.unlink(path)
  }
}

function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(18))
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '')
}
