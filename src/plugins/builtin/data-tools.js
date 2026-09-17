/* eslint-disable */
/**
 * Built-in plugin: structured data and text.
 *
 * Parsing is delegated to spec-complete libraries injected as `DataLibs`
 * (markdown-it, yaml, papaparse, fast-xml-parser). An earlier version carried
 * hand-written subsets of each format; they handled the common case and silently
 * mangled the rest - nested lists, setext headings, footnotes, YAML anchors,
 * quoted newlines in CSV. Format conversion is exactly where "mostly right" is
 * wrong, so the parsers are now the real ones and this file is only glue.
 *
 * Everything runs inside the sandbox Worker, which has no DOM: all four
 * libraries were chosen partly because none of them needs one.
 */
definePlugin({
  id: 'omnitool.data',
  name: '数据与文本工具箱',
  version: '3.0.0',
  author: 'OmniTool',
  description: 'JSON / YAML / CSV / XML / Excel 互转，Markdown 转 HTML / PDF / EPUB，邮件解析、字体转换、图表、编码与文本处理。',
  icon: 'file-json',
  capabilities: ['fs', 'ui', 'image'],
  deps: [
    { id: 'data-libs', url: '/vendor/data-libs.js', global: 'DataLibs' },
    // Everything below loads only when a tool needs it.
    { id: 'xlsx', url: '/vendor/xlsx.js', global: 'XLSX', lazy: true },
    { id: 'fflate', url: '/vendor/fflate.js', global: 'fflate', lazy: true },
    { id: 'pdf-lib', url: '/vendor/pdf-lib.js', global: 'PDFLib', lazy: true },
    { id: 'fontkit', url: '/vendor/fontkit.js', global: 'fontkit', lazy: true },
    { id: 'cjk-font', url: '/vendor/fonts/fonts.js', global: 'OMNITOOL_FONTS', lazy: true, assets: { 'NotoSansSC-Regular.ttf': { url: '/vendor/fonts/NotoSansSC-Regular.ttf' } } },
    { id: 'font-libs', url: '/vendor/fonts/font-libs.js', global: 'FontLibs', lazy: true, assets: { 'woff2.wasm': { url: '/vendor/fonts/woff2.wasm' } } },
    { id: 'postal-mime', url: '/vendor/mail/postal-mime.js', global: 'PostalMime', lazy: true },
    { id: 'msgreader', url: '/vendor/mail/msgreader.js', global: 'MsgReaderLib', lazy: true },
  ],

  tools: [
    /* ------------------------------------------------------------------ */
    {
      id: 'convert',
      name: '结构化数据互转',
      category: 'document',
      icon: 'arrow-down-up',
      description: '在 JSON、YAML、CSV、TSV、XML 之间互转，自动识别输入格式。',
      accept: ['.json', '.yaml', '.yml', '.csv', '.tsv', '.xml', 'application/json', 'text/csv'],
      multiple: true,
      input: 'both',
      // Pasted text is sniffed by content, so the neutral extension is deliberate.
      textFileName: 'input.txt',
      keywords: ['json', 'yaml', 'csv', 'xml', 'tsv', 'convert', '互转', '转换', '数据'],
      params: [
        {
          key: 'target', type: 'select', label: '输出格式', default: 'json',
          options: [
            { value: 'json', label: 'JSON' }, { value: 'yaml', label: 'YAML' },
            { value: 'csv', label: 'CSV' }, { value: 'tsv', label: 'TSV' }, { value: 'xml', label: 'XML' },
          ],
        },
        { key: 'indent', type: 'slider', label: '缩进空格', min: 0, max: 8, default: 2, when: { key: 'target', equals: ['json', 'xml', 'yaml'] } },
        { key: 'sortKeys', type: 'switch', label: '按键名排序', default: false },
        { key: 'rootName', type: 'text', label: 'XML 根节点名', default: 'root', when: { key: 'target', equals: 'xml' } },
        {
          key: 'flatten', type: 'switch', label: '展开嵌套对象为列', default: true,
          hint: '如 user.name 这样用点号连接的列名；关闭则把嵌套值写成 JSON 字符串。',
          when: { key: 'target', equals: ['csv', 'tsv'] },
        },
      ],

      async run(ctx) {
        const outputs = []

        await eachText(ctx, async (input, text) => {
          let data = parseAny(text, input.name)
          if (ctx.params.sortKeys) data = sortDeep(data)
          const out = serialise(data, String(ctx.params.target), {
            indent: Number(ctx.params.indent) || 0,
            rootName: String(ctx.params.rootName || 'root'),
            flatten: ctx.params.flatten !== false,
          })
          outputs.push((await ctx.host.fs.writeAll(`${baseName(input.name)}.${out.extension}`, out.body, out.type)).id)
        })

        return { outputs, summary: `已转换 ${outputs.length} 个文件为 ${String(ctx.params.target).toUpperCase()}` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'json-format',
      name: 'JSON 格式化',
      category: 'document',
      icon: 'file-json',
      description: '美化或压缩 JSON，可排序键名、按路径提取片段。',
      accept: ['.json', 'application/json'],
      multiple: true,
      input: 'both',
      textFileName: 'input.json',
      keywords: ['json', 'format', 'pretty', 'minify', '格式化', '美化', '压缩'],
      params: [
        { key: 'mode', type: 'select', label: '模式', default: 'pretty', options: [{ value: 'pretty', label: '格式化（缩进）' }, { value: 'minify', label: '压缩（单行）' }] },
        { key: 'indent', type: 'slider', label: '缩进空格', min: 1, max: 8, default: 2, when: { key: 'mode', equals: 'pretty' } },
        { key: 'sortKeys', type: 'switch', label: '按键名排序', default: false },
        { key: 'path', type: 'text', label: '提取路径', default: '', placeholder: '如 data.items 或 users[0].name', hint: '留空表示保留整个文档。' },
      ],

      async run(ctx) {
        const outputs = []

        await eachText(ctx, async (input, text) => {
          let data = parseJson(text, input.name)
          if (String(ctx.params.path).trim()) data = pickPath(data, String(ctx.params.path).trim())
          if (ctx.params.sortKeys) data = sortDeep(data)

          const body = ctx.params.mode === 'minify' ? JSON.stringify(data) : JSON.stringify(data, null, Number(ctx.params.indent))
          const suffix = ctx.params.mode === 'minify' ? '.min.json' : '.formatted.json'
          outputs.push((await ctx.host.fs.writeAll(baseName(input.name) + suffix, body, 'application/json')).id)
        })

        return { outputs, summary: `已处理 ${outputs.length} 个 JSON 文件` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'csv-tools',
      name: 'CSV 处理',
      category: 'document',
      icon: 'table',
      description: '合并、按行数拆分、筛选列、去重与统计。',
      accept: ['.csv', '.tsv', 'text/csv'],
      multiple: true,
      input: 'both',
      textFileName: 'input.csv',
      keywords: ['csv', 'split', 'merge', 'filter', 'dedupe', '拆分', '合并', '去重', '表格'],
      params: [
        {
          key: 'mode', type: 'select', label: '操作', default: 'merge',
          options: [
            { value: 'merge', label: '合并多个 CSV' }, { value: 'split', label: '按行数拆分' },
            { value: 'columns', label: '筛选列' }, { value: 'dedupe', label: '按整行去重' },
            { value: 'stats', label: '统计概览' },
          ],
        },
        { key: 'chunk', type: 'number', label: '每份行数', default: 1000, min: 1, when: { key: 'mode', equals: 'split' } },
        { key: 'columns', type: 'text', label: '保留列', default: '', placeholder: '以逗号分隔的列名', when: { key: 'mode', equals: 'columns' } },
        { key: 'delimiter', type: 'select', label: '分隔符', default: 'auto', options: [{ value: 'auto', label: '自动识别' }, { value: ',', label: '逗号' }, { value: '\t', label: '制表符' }, { value: ';', label: '分号' }, { value: '|', label: '竖线' }] },
      ],

      async run(ctx) {
        const outputs = []
        const mode = String(ctx.params.mode)
        const forced = ctx.params.delimiter === 'auto' ? '' : String(ctx.params.delimiter)

        if (mode === 'merge') {
          let header = null
          const rows = []
          await eachText(ctx, async (input, text) => {
            const table = parseCsv(text, forced, input.name).rows
            if (table.length === 0) return
            if (!header) header = table[0].slice()
            // Align every file to one header; columns a later file adds are
            // appended, so nothing is silently dropped.
            for (const name of table[0]) if (!header.includes(name)) header.push(name)
            const map = table[0].map((name) => header.indexOf(name))
            for (const row of table.slice(1)) {
              const aligned = new Array(header.length).fill('')
              row.forEach((cell, i) => {
                if (map[i] >= 0) aligned[map[i]] = cell
              })
              rows.push(aligned)
            }
          })
          if (!header) throw new Error('没有可合并的内容')
          for (const row of rows) while (row.length < header.length) row.push('')
          outputs.push((await ctx.host.fs.writeAll('merged.csv', unparseCsv([header, ...rows], ','), 'text/csv')).id)
          return { outputs, summary: `已合并 ${ctx.inputs.length} 个文件，共 ${rows.length} 行、${header.length} 列` }
        }

        let totalRows = 0
        await eachText(ctx, async (input, text) => {
          const parsed = parseCsv(text, forced, input.name)
          const table = parsed.rows
          if (table.length === 0) throw new Error(`${input.name} 是空文件`)
          const [header, ...rows] = table
          const delimiter = parsed.delimiter
          const base = baseName(input.name)
          const extension = delimiter === '\t' ? 'tsv' : 'csv'
          totalRows += rows.length

          if (mode === 'split') {
            const size = Math.max(1, Number(ctx.params.chunk) || 1)
            for (let i = 0; i < rows.length; i += size) {
              const part = unparseCsv([header, ...rows.slice(i, i + size)], delimiter)
              outputs.push((await ctx.host.fs.writeAll(`${base}-part${Math.floor(i / size) + 1}.${extension}`, part, 'text/csv')).id)
            }
          } else if (mode === 'columns') {
            const wanted = String(ctx.params.columns).split(',').map((c) => c.trim()).filter(Boolean)
            const indices = wanted.map((name) => header.indexOf(name))
            if (indices.every((i) => i < 0)) throw new Error(`${input.name}：没有匹配到任何列（可用列：${header.join('、')}）`)
            const kept = indices.filter((i) => i >= 0)
            const picked = [kept.map((i) => header[i]), ...rows.map((row) => kept.map((i) => row[i] ?? ''))]
            outputs.push((await ctx.host.fs.writeAll(`${base}-columns.${extension}`, unparseCsv(picked, delimiter), 'text/csv')).id)
          } else if (mode === 'dedupe') {
            const seen = new Set()
            const unique = rows.filter((row) => {
              const key = JSON.stringify(row)
              if (seen.has(key)) return false
              seen.add(key)
              return true
            })
            outputs.push((await ctx.host.fs.writeAll(`${base}-deduped.${extension}`, unparseCsv([header, ...unique], delimiter), 'text/csv')).id)
          } else {
            const stats = header.map((name, i) => {
              const values = rows.map((row) => row[i] ?? '')
              const nonEmpty = values.filter((v) => v !== '')
              const numbers = nonEmpty.map(Number).filter((n) => Number.isFinite(n))
              return {
                column: name,
                rows: values.length,
                empty: values.length - nonEmpty.length,
                distinct: new Set(nonEmpty).size,
                numeric: numbers.length === nonEmpty.length && nonEmpty.length > 0,
                min: numbers.length ? Math.min(...numbers) : null,
                max: numbers.length ? Math.max(...numbers) : null,
                mean: numbers.length ? Number((numbers.reduce((a, b) => a + b, 0) / numbers.length).toFixed(4)) : null,
              }
            })
            const payload = { file: input.name, rows: rows.length, columns: header.length, delimiter, stats }
            outputs.push((await ctx.host.fs.writeAll(`${base}-stats.json`, JSON.stringify(payload, null, 2), 'application/json')).id)
          }
        })

        return { outputs, summary: `已处理 ${ctx.inputs.length} 个文件，共 ${totalRows} 行` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'markdown',
      name: 'Markdown 转换',
      category: 'document',
      icon: 'file-code',
      description: '按 CommonMark + GFM 转成 HTML（表格、任务列表、脚注、删除线），或提取大纲。',
      accept: ['.md', '.markdown', 'text/markdown'],
      multiple: true,
      input: 'both',
      textFileName: 'input.md',
      keywords: ['markdown', 'md', 'html', 'outline', 'toc', '大纲', '目录'],
      params: [
        { key: 'mode', type: 'select', label: '输出', default: 'html', options: [{ value: 'html', label: '完整 HTML 文档' }, { value: 'fragment', label: 'HTML 片段' }, { value: 'outline', label: '大纲（Markdown）' }] },
        { key: 'title', type: 'text', label: '文档标题', default: '', placeholder: '留空则取第一个标题或文件名', when: { key: 'mode', equals: 'html' } },
        { key: 'toc', type: 'switch', label: '在开头插入目录', default: false, when: { key: 'mode', equals: ['html', 'fragment'] } },
        { key: 'breaks', type: 'switch', label: '单个换行也换行', default: false, hint: '默认遵循 Markdown 规范：段落内的单个换行视为空格。', when: { key: 'mode', equals: ['html', 'fragment'] } },
        { key: 'darkMode', type: 'switch', label: '自适应深色模式', default: true, when: { key: 'mode', equals: 'html' } },
      ],

      async run(ctx) {
        const outputs = []

        await eachText(ctx, async (input, text) => {
          const base = baseName(input.name)

          if (ctx.params.mode === 'outline') {
            const outline = extractHeadings(text).map((h) => `${'  '.repeat(h.level - 1)}- ${h.text}`).join('\n')
            outputs.push((await ctx.host.fs.writeAll(`${base}-outline.md`, outline || '（未找到标题）', 'text/markdown')).id)
            return
          }

          const rendered = renderMarkdown(text, { breaks: !!ctx.params.breaks, toc: !!ctx.params.toc })
          if (ctx.params.mode === 'fragment') {
            outputs.push((await ctx.host.fs.writeAll(`${base}.html`, rendered.html, 'text/html')).id)
            return
          }

          const title = String(ctx.params.title || '').trim() || rendered.headings[0]?.text || base
          outputs.push((await ctx.host.fs.writeAll(`${base}.html`, htmlDocument(title, rendered.html, !!ctx.params.darkMode), 'text/html')).id)
        })

        return { outputs, summary: `已转换 ${outputs.length} 个 Markdown 文件` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'text',
      name: '文本处理',
      category: 'document',
      icon: 'type',
      description: '查找替换、排序、去重、大小写、去空白、行号与字数统计。',
      accept: ['.txt', '.md', '.csv', '.log', '.json', 'text/*'],
      multiple: true,
      input: 'both',
      textFileName: 'input.txt',
      keywords: ['text', 'replace', 'sort', 'dedupe', 'case', '替换', '排序', '去重', '大小写'],
      params: [
        {
          key: 'operation', type: 'select', label: '操作', default: 'replace',
          options: [
            { value: 'replace', label: '查找替换' }, { value: 'sort', label: '按行排序' },
            { value: 'dedupe', label: '按行去重' }, { value: 'case', label: '大小写转换' },
            { value: 'trim', label: '去除行首尾空白' }, { value: 'blank', label: '删除空行' },
            { value: 'numbering', label: '添加行号' }, { value: 'count', label: '统计字数' },
          ],
        },
        { key: 'find', type: 'text', label: '查找', default: '', when: { key: 'operation', equals: 'replace' } },
        { key: 'replace', type: 'text', label: '替换为', default: '', hint: '正则模式下可用 $1 引用分组。', when: { key: 'operation', equals: 'replace' } },
        { key: 'regex', type: 'switch', label: '使用正则表达式', default: false, when: { key: 'operation', equals: 'replace' } },
        { key: 'ignoreCase', type: 'switch', label: '忽略大小写', default: false, when: { key: 'operation', equals: ['replace', 'dedupe', 'sort'] } },
        { key: 'descending', type: 'switch', label: '降序', default: false, when: { key: 'operation', equals: 'sort' } },
        { key: 'numeric', type: 'switch', label: '按数值排序', default: false, hint: '让 "10" 排在 "9" 之后。', when: { key: 'operation', equals: 'sort' } },
        {
          key: 'caseMode', type: 'select', label: '转换为', default: 'upper',
          options: [{ value: 'upper', label: '全大写' }, { value: 'lower', label: '全小写' }, { value: 'title', label: '单词首字母大写' }, { value: 'sentence', label: '句首大写' }],
          when: { key: 'operation', equals: 'case' },
        },
      ],

      async run(ctx) {
        const outputs = []
        await eachText(ctx, async (input, text) => {
          const result = transformText(text, ctx.params)
          const base = baseName(input.name)
          if (result.json) {
            outputs.push((await ctx.host.fs.writeAll(`${base}-stats.json`, JSON.stringify({ file: input.name, ...result.json }, null, 2), 'application/json')).id)
          } else {
            outputs.push((await ctx.host.fs.writeAll(`${base}-processed.txt`, result.text, 'text/plain')).id)
          }
        })
        return { outputs, summary: `已处理 ${outputs.length} 个文本文件` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'encode',
      name: '编码与哈希',
      category: 'document',
      icon: 'hash',
      description: 'Base64 / Hex / URL 编解码，Data URI，以及 SHA-1 / SHA-256 / SHA-512 校验值。',
      accept: [],
      multiple: true,
      input: 'both',
      textFileName: 'input.txt',
      keywords: ['base64', 'hex', 'url', 'hash', 'sha256', 'checksum', '编码', '解码', '哈希', '校验'],
      params: [
        {
          key: 'operation', type: 'select', label: '操作', default: 'hash',
          options: [
            { value: 'hash', label: '计算哈希' }, { value: 'base64', label: 'Base64 编码' },
            { value: 'base64-decode', label: 'Base64 解码' }, { value: 'hex', label: 'Hex 编码' },
            { value: 'hex-decode', label: 'Hex 解码' }, { value: 'url', label: 'URL 编码' },
            { value: 'url-decode', label: 'URL 解码' }, { value: 'dataurl', label: '生成 Data URI' },
          ],
        },
        {
          key: 'algorithm', type: 'select', label: '算法', default: 'SHA-256',
          options: [{ value: 'SHA-1', label: 'SHA-1' }, { value: 'SHA-256', label: 'SHA-256' }, { value: 'SHA-384', label: 'SHA-384' }, { value: 'SHA-512', label: 'SHA-512' }],
          when: { key: 'operation', equals: 'hash' },
        },
      ],

      async run(ctx) {
        const outputs = []
        const op = String(ctx.params.operation)
        const digests = []

        for (const [index, input] of ctx.inputs.entries()) {
          ctx.throwIfAborted()
          ctx.progress(index / ctx.inputs.length, `正在处理 ${input.name}`)
          const base = baseName(input.name)

          if (op === 'hash') {
            // `crypto.subtle` does not exist in the sandbox (opaque origin), so
            // the digest is computed host-side.
            digests.push(`${await ctx.host.fs.digest(input.id, String(ctx.params.algorithm))}  ${input.name}`)
            continue
          }

          const bytes = await ctx.host.fs.readAll(input.id)
          const text = () => new TextDecoder().decode(bytes)
          let name
          let body
          let type = 'text/plain'

          switch (op) {
            case 'base64':
              name = `${base}.b64.txt`
              body = toBase64(bytes)
              break
            case 'dataurl':
              name = `${base}.dataurl.txt`
              body = `data:${input.type || 'application/octet-stream'};base64,${toBase64(bytes)}`
              break
            case 'base64-decode':
              name = `${base}-decoded.bin`
              body = fromBase64(text())
              type = 'application/octet-stream'
              break
            case 'hex':
              name = `${base}.hex.txt`
              body = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
              break
            case 'hex-decode':
              name = `${base}-decoded.bin`
              body = fromHex(text())
              type = 'application/octet-stream'
              break
            case 'url':
              name = `${base}.url.txt`
              body = encodeURIComponent(text())
              break
            default:
              name = `${base}.decoded.txt`
              try {
                body = decodeURIComponent(text().trim().replace(/\+/g, ' '))
              } catch {
                throw new Error(`${input.name} 包含非法的 URL 编码序列`)
              }
          }
          outputs.push((await ctx.host.fs.writeAll(name, body, type)).id)
        }

        if (digests.length > 0) {
          const name = `checksums-${String(ctx.params.algorithm).toLowerCase().replace('-', '')}.txt`
          outputs.push((await ctx.host.fs.writeAll(name, `${digests.join('\n')}\n`, 'text/plain')).id)
        }

        ctx.progress(1)
        return { outputs, summary: op === 'hash' ? `已计算 ${digests.length} 个文件的校验值` : `已处理 ${outputs.length} 个文件` }
      },
    },
    /* ------------------------------------------------------------------ */
    {
      id: 'spreadsheet',
      name: 'Excel 表格转换',
      category: 'document',
      icon: 'table',
      description: 'Excel（xlsx / xls）、ODS 与 CSV / JSON / Markdown 表格互转；多个 CSV 可合并成一个多工作表的 Excel。',
      accept: ['.xlsx', '.xlsm', '.xls', '.ods', '.csv', '.tsv', '.json', 'text/csv', 'application/json'],
      multiple: true,
      keywords: ['excel', 'xlsx', 'xls', 'ods', 'spreadsheet', 'csv', '表格', '电子表格', 'excel转csv', 'csv转excel'],
      params: [
        {
          key: 'target', type: 'select', label: '输出格式', default: 'xlsx',
          options: [
            { value: 'xlsx', label: 'Excel（.xlsx）' }, { value: 'csv', label: 'CSV（每个工作表一个文件）' },
            { value: 'json', label: 'JSON（对象数组）' }, { value: 'markdown', label: 'Markdown 表格' },
            { value: 'html', label: 'HTML 表格' }, { value: 'ods', label: 'OpenDocument（.ods）' },
          ],
        },
        { key: 'sheets', type: 'select', label: '工作表', default: 'all', options: [{ value: 'all', label: '全部工作表' }, { value: 'first', label: '仅第一个' }], when: { key: 'target', equals: ['csv', 'json', 'markdown', 'html'] } },
        { key: 'merge', type: 'switch', label: '多个文件合并为一个工作簿', default: true, hint: '每个输入文件成为其中一个工作表。', when: { key: 'target', equals: ['xlsx', 'ods'] } },
        { key: 'bom', type: 'switch', label: 'CSV 带 BOM', default: true, hint: '让 Windows 版 Excel 直接双击打开不乱码。', when: { key: 'target', equals: 'csv' } },
      ],

      async run(ctx) {
        const { exports: XLSX } = await loadDependency('xlsx')
        const p = ctx.params
        const target = String(p.target)
        const workbooks = []
        await eachBinary(ctx, async (input, bytes) => {
          workbooks.push({ name: baseName(input.name), book: readWorkbook(XLSX, input, bytes) })
        })

        const outputs = []
        if (target === 'xlsx' || target === 'ods') {
          const write = async (book, name) => {
            const data = XLSX.write(book, { type: 'array', bookType: target, compression: true })
            outputs.push((await host.fs.writeAll(`${name}.${target}`, new Uint8Array(data), target === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/vnd.oasis.opendocument.spreadsheet')).id)
          }
          if (p.merge && workbooks.length > 1) {
            const merged = XLSX.utils.book_new()
            const used = new Set()
            for (const { name, book } of workbooks) {
              for (const sheetName of book.SheetNames) {
                const label = uniqueSheetName(book.SheetNames.length > 1 ? `${name}-${sheetName}` : name, used)
                XLSX.utils.book_append_sheet(merged, book.Sheets[sheetName], label)
              }
            }
            await write(merged, 'merged')
          } else {
            for (const { name, book } of workbooks) await write(book, name)
          }
          return { outputs, summary: `已生成 ${outputs.length} 个 ${target.toUpperCase()} 文件` }
        }

        for (const { name, book } of workbooks) {
          const sheetNames = p.sheets === 'first' ? book.SheetNames.slice(0, 1) : book.SheetNames
          for (const sheetName of sheetNames) {
            ctx.throwIfAborted()
            const sheet = book.Sheets[sheetName]
            const file = sheetNames.length > 1 ? `${name}-${safeName(sheetName)}` : name
            if (target === 'csv') {
              const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false })
              outputs.push((await host.fs.writeAll(`${file}.csv`, `${p.bom ? '\uFEFF' : ''}${csv}`, 'text/csv')).id)
            } else if (target === 'json') {
              const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false })
              outputs.push((await host.fs.writeAll(`${file}.json`, JSON.stringify(rows, null, 2), 'application/json')).id)
            } else if (target === 'markdown') {
              outputs.push((await host.fs.writeAll(`${file}.md`, sheetToMarkdown(XLSX, sheet), 'text/markdown')).id)
            } else {
              const table = XLSX.utils.sheet_to_html(sheet, { header: '', footer: '' })
              outputs.push((await host.fs.writeAll(`${file}.html`, htmlDocument(sheetName, table, true), 'text/html')).id)
            }
          }
        }
        return { outputs, summary: `已导出 ${outputs.length} 个工作表` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'markdown-pdf',
      name: 'Markdown 转 PDF',
      category: 'document',
      icon: 'file-text',
      description: '把 Markdown 排版成可打印的 PDF：标题层级、列表、引用、代码块、表格与图片，中文字体内嵌（只含用到的字）。',
      accept: ['.md', '.markdown', '.txt', 'text/markdown', 'image/png', 'image/jpeg'],
      multiple: true,
      input: 'both',
      textFileName: 'document.md',
      keywords: ['markdown to pdf', 'md to pdf', 'print', 'export pdf', 'markdown转pdf', '导出pdf', '排版'],
      params: [
        { key: 'paper', type: 'select', label: '纸张', default: 'a4', options: [{ value: 'a4', label: 'A4' }, { value: 'letter', label: 'Letter' }, { value: 'a5', label: 'A5' }] },
        { key: 'fontSize', type: 'slider', label: '正文字号', min: 8, max: 16, step: 0.5, default: 10.5, suffix: 'pt' },
        { key: 'pageNumbers', type: 'switch', label: '页脚页码', default: true },
        { key: 'title', type: 'text', label: '文档标题', default: '', placeholder: '留空则取第一个标题', hint: '写入 PDF 属性。' },
      ],

      async run(ctx) {
        const images = new Map()
        const documents = []
        for (const input of ctx.inputs) {
          if (/^image\/(png|jpeg)$/.test(input.type || '') || /\.(png|jpe?g)$/i.test(input.name)) images.set(input.name.split('/').pop().toLowerCase(), input)
          else documents.push(input)
        }
        if (documents.length === 0) throw new Error('请提供 Markdown 文件或直接输入内容')

        const { exports: PDFLib } = await loadDependency('pdf-lib')
        // An ES module bundled to a global is its namespace: the library is `default`.
        const { exports: fontkitModule } = await loadDependency('fontkit')
        const fontkit = fontkitModule.default ?? fontkitModule
        const fontBytes = await cjkFontBytes()
        const outputs = []
        for (const [index, input] of documents.entries()) {
          ctx.throwIfAborted()
          ctx.progress(index / documents.length, `排版 ${input.name}`)
          const source = (await host.fs.readText(input.id)).replace(/^\uFEFF/, '')
          const bytes = await typesetMarkdown(PDFLib, fontkit, fontBytes, source, {
            paper: String(ctx.params.paper),
            fontSize: Number(ctx.params.fontSize) || 10.5,
            pageNumbers: !!ctx.params.pageNumbers,
            title: String(ctx.params.title || '').trim(),
            fallbackTitle: baseName(input.name),
            loadImage: async (src) => {
              const match = images.get(String(src).split(/[\\/]/).pop().toLowerCase())
              return match ? { bytes: await host.fs.readAll(match.id), png: /png$/i.test(match.type || match.name) } : null
            },
          })
          outputs.push((await host.fs.writeAll(`${baseName(input.name)}.pdf`, bytes, 'application/pdf')).id)
        }
        ctx.progress(1)
        return { outputs, summary: `已生成 ${outputs.length} 个 PDF` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'ebook',
      name: '生成 EPUB 电子书',
      category: 'document',
      icon: 'file-code',
      description: '把 Markdown 或纯文本章节打包成 EPUB 3 电子书，自动生成目录；可附封面图。',
      accept: ['.md', '.markdown', '.txt', 'text/markdown', 'text/plain', 'image/jpeg', 'image/png'],
      multiple: true,
      keywords: ['epub', 'ebook', 'kindle', 'book', '电子书', '小说', '转epub'],
      params: [
        { key: 'title', type: 'text', label: '书名', default: '', placeholder: '留空则取第一个文件名' },
        { key: 'author', type: 'text', label: '作者', default: '' },
        { key: 'language', type: 'select', label: '语言', default: 'zh-CN', options: [{ value: 'zh-CN', label: '简体中文' }, { value: 'zh-TW', label: '繁体中文' }, { value: 'en', label: 'English' }, { value: 'ja', label: '日本語' }] },
        { key: 'splitHeadings', type: 'switch', label: '按一级标题拆分章节', default: true, hint: '单个长文件时很有用；关闭则每个文件一章。' },
      ],

      async run(ctx) {
        const { exports: zip } = await loadDependency('fflate')
        const cover = ctx.inputs.find((i) => /^image\//.test(i.type || '') || /\.(png|jpe?g)$/i.test(i.name))
        const texts = ctx.inputs.filter((i) => i !== cover)
        if (texts.length === 0) throw new Error('请至少提供一个 Markdown 或 TXT 文件')

        const md = createMarkdown({ xhtml: true })
        const chapters = []
        for (const input of texts) {
          const raw = (await host.fs.readText(input.id)).replace(/^\uFEFF/, '')
          const markdown = /\.txt$/i.test(input.name) ? textToMarkdown(raw) : raw
          const parts = ctx.params.splitHeadings ? splitByH1(markdown) : [markdown]
          for (const part of parts) {
            const title = (extractHeadings(part)[0]?.text || baseName(input.name)).trim()
            chapters.push({ title, html: md.render(part) })
          }
        }

        const title = String(ctx.params.title || '').trim() || baseName(texts[0].name)
        const bytes = buildEpub(zip, {
          title,
          author: String(ctx.params.author || '').trim(),
          language: String(ctx.params.language),
          chapters,
          cover: cover ? { bytes: await host.fs.readAll(cover.id), type: /png$/i.test(cover.type || cover.name) ? 'image/png' : 'image/jpeg' } : null,
        })
        const out = await host.fs.writeAll(`${safeName(title)}.epub`, bytes, 'application/epub+zip')
        return { outputs: [out.id], summary: `已生成 ${chapters.length} 章的电子书` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'email',
      name: '邮件解析（EML / MSG）',
      category: 'document',
      icon: 'file-archive',
      description: '打开 .eml 与 Outlook .msg 邮件：导出正文（HTML / 纯文本）、发件信息与全部附件。',
      accept: ['.eml', '.msg', 'message/rfc822', 'application/vnd.ms-outlook'],
      multiple: true,
      keywords: ['eml', 'msg', 'outlook', 'email', 'mail', 'attachments', '邮件', '附件', '解析'],

      async run(ctx) {
        const outputs = []
        let attachments = 0
        await eachBinary(ctx, async (input, bytes) => {
          const folder = safeName(baseName(input.name))
          const message = /\.msg$/i.test(input.name) || isOleFile(bytes) ? await parseMsg(bytes) : await parseEml(bytes)
          const headers = { subject: message.subject, from: message.from, to: message.to, cc: message.cc, date: message.date, messageId: message.messageId, attachments: message.attachments.map((a) => ({ name: a.name, bytes: a.data.length })) }
          outputs.push((await host.fs.writeAll(`${folder}/headers.json`, JSON.stringify(headers, null, 2), 'application/json')).id)
          if (message.html) outputs.push((await host.fs.writeAll(`${folder}/message.html`, emailHtmlDocument(message), 'text/html')).id)
          if (message.text) outputs.push((await host.fs.writeAll(`${folder}/message.txt`, message.text, 'text/plain')).id)
          const used = new Set()
          for (const attachment of message.attachments) {
            const name = uniqueFileName(safeName(attachment.name || 'attachment.bin'), used)
            outputs.push((await host.fs.writeAll(`${folder}/attachments/${name}`, attachment.data, attachment.type || '')).id)
            attachments++
          }
        })
        return { outputs, summary: `已解析 ${ctx.inputs.length} 封邮件${attachments ? `，导出 ${attachments} 个附件` : ''}` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'font',
      name: '字体转换与子集化',
      category: 'document',
      icon: 'type',
      description: 'TTF / OTF / WOFF / WOFF2 / EOT / SVG 字体互转；只保留用到的文字，把几 MB 的中文字体压到几 KB，并生成 @font-face CSS。',
      accept: ['.ttf', '.otf', '.woff', '.woff2', '.eot', '.svg', 'font/ttf', 'font/otf', 'font/woff', 'font/woff2'],
      multiple: true,
      keywords: ['font', 'ttf', 'otf', 'woff', 'woff2', 'subset', 'webfont', '字体', '字体转换', '字体子集', '字体压缩'],
      params: [
        { key: 'target', type: 'select', label: '输出格式', default: 'woff2', options: [{ value: 'woff2', label: 'WOFF2（网页首选）' }, { value: 'woff', label: 'WOFF' }, { value: 'ttf', label: 'TTF' }, { value: 'eot', label: 'EOT（旧版 IE）' }, { value: 'svg', label: 'SVG 字体' }] },
        { key: 'subset', type: 'textarea', label: '只保留这些文字', rows: 4, default: '', placeholder: '留空保留全部字符。可以粘贴整篇文章，重复的字会自动去掉。' },
        { key: 'ascii', type: 'switch', label: '同时保留英文字母、数字与常用标点', default: true, hint: '子集化时一并保留 ASCII 可见字符。' },
        { key: 'css', type: 'switch', label: '生成 @font-face CSS', default: true },
      ],

      async run(ctx) {
        const { exports: fontLibs, assets } = await loadDependency('font-libs')
        const p = ctx.params
        const target = String(p.target)
        if (target === 'woff2' || ctx.inputs.some((i) => /\.woff2$/i.test(i.name))) await fontLibs.initWoff2(assets['woff2.wasm'])
        const codepoints = fontSubset(String(p.subset || ''), !!p.ascii)
        const outputs = []
        const css = []
        await eachBinary(ctx, async (input, bytes) => {
          const type = fontType(input.name, bytes)
          // Hinting is kept (it matters for small text on Windows). Kerning is not:
          // its GPOS tables survive subsetting unshrunk, and together with hinting
          // the WOFF2 encoder silently returns an empty file.
          const font = fontLibs.Font.create(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), {
            type,
            ...(codepoints ? { subset: codepoints } : {}),
            hinting: true,
            compound2simple: true,
          })
          let written = font.write({ type: target, hinting: true })
          if (typeof written !== 'string' && (written.byteLength ?? written.length) === 0) written = font.write({ type: target, hinting: false })
          const data = typeof written === 'string' ? written : new Uint8Array(written.buffer ?? written)
          if (data.length === 0) throw new Error(`${input.name} 转换为 ${target.toUpperCase()} 失败：编码器没有输出任何数据`)
          const name = `${baseName(input.name)}${codepoints ? '-subset' : ''}.${target}`
          outputs.push((await host.fs.writeAll(name, data, FONT_TYPES[target])).id)
          const family = font.get().name?.fontFamily || baseName(input.name)
          css.push(`@font-face {\n  font-family: "${String(family).replace(/"/g, '')}";\n  src: url("${name}") format("${FONT_FORMATS[target]}");\n  font-display: swap;\n}`)
        })
        if (p.css) outputs.push((await host.fs.writeAll('fonts.css', `${css.join('\n\n')}\n`, 'text/css')).id)
        const glyphs = codepoints ? `，保留 ${codepoints.length} 个字符` : ''
        return { outputs, summary: `已转换 ${ctx.inputs.length} 个字体为 ${target.toUpperCase()}${glyphs}` }
      },
    },

    /* ------------------------------------------------------------------ */
    {
      id: 'chart',
      name: '图表生成',
      category: 'document',
      icon: 'layout-grid',
      description: '把 CSV 数据画成柱状图、折线图、面积图或饼图，输出矢量 SVG 与 PNG。第一列为类别，其余数值列为系列。',
      accept: ['.csv', '.tsv', 'text/csv'],
      multiple: false,
      input: 'both',
      textFileName: 'data.csv',
      keywords: ['chart', 'graph', 'bar', 'line', 'pie', 'plot', 'visualize', '图表', '柱状图', '折线图', '饼图', '可视化'],
      params: [
        { key: 'type', type: 'select', label: '图表类型', default: 'bar', options: [{ value: 'bar', label: '柱状图' }, { value: 'line', label: '折线图' }, { value: 'area', label: '面积图' }, { value: 'pie', label: '饼图（第一个数值列）' }] },
        { key: 'title', type: 'text', label: '标题', default: '' },
        { key: 'width', type: 'number', label: '宽度', default: 960, min: 320, max: 4000, suffix: 'px' },
        { key: 'height', type: 'number', label: '高度', default: 540, min: 240, max: 3000, suffix: 'px' },
        { key: 'png', type: 'switch', label: '同时输出 PNG', default: true },
      ],

      async run(ctx) {
        const p = ctx.params
        const input = ctx.inputs[0]
        const text = (await host.fs.readText(input.id)).replace(/^\uFEFF/, '')
        const table = parseCsv(text, '', input.name).rows.filter((row) => row.some((cell) => String(cell).trim()))
        if (table.length < 2) throw new Error('至少需要表头和一行数据')
        const width = Math.max(320, Math.min(4000, Number(p.width) || 960))
        const height = Math.max(240, Math.min(3000, Number(p.height) || 540))
        const svg = renderChart(table, { type: String(p.type), title: String(p.title || ''), width, height })
        const base = input.name === 'data.csv' ? 'chart' : baseName(input.name)
        const svgRef = await host.fs.writeAll(`${base}.svg`, svg, 'image/svg+xml')
        const outputs = [svgRef.id]
        if (p.png) {
          // Workers cannot rasterise SVG; the host does it in an <img>, at 2x for sharpness.
          const png = await host.image.transcode(svgRef.id, { format: 'image/png', width: width * 2 })
          outputs.push((await host.fs.writeAll(`${base}.png`, new Uint8Array(png.body), 'image/png')).id)
        }
        return { outputs, summary: `已生成${{ bar: '柱状图', line: '折线图', area: '面积图', pie: '饼图' }[String(p.type)] ?? '图表'}` }
      },
    },

  ],
})

/* ========================================================================== */
/* Shared                                                                     */
/* ========================================================================== */

function libs() {
  if (typeof DataLibs === 'undefined') throw new Error('依赖 data-libs 未能注入沙盒，请在插件面板中重载该插件')
  return DataLibs
}

async function eachText(ctx, fn) {
  if (ctx.inputs.length === 0) throw new Error('请先拖入文件或输入内容')
  for (let i = 0; i < ctx.inputs.length; i++) {
    ctx.throwIfAborted()
    ctx.progress(i / ctx.inputs.length, `正在处理 ${ctx.inputs[i].name}`)
    const text = await ctx.host.fs.readText(ctx.inputs[i].id)
    // A UTF-8 BOM would otherwise end up inside the first CSV header or JSON key.
    await fn(ctx.inputs[i], text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  }
  ctx.progress(1)
}

function baseName(name) {
  return name.replace(/\.[^.]+$/, '')
}

function extensionOf(name) {
  return (name.split('.').pop() ?? '').toLowerCase()
}

/* -------------------------------- detection ------------------------------ */

/** Picks a parser by extension, falling back to the content's shape. */
function detectFormat(text, filename) {
  const extension = extensionOf(filename)
  if (extension === 'json') return 'json'
  if (extension === 'yaml' || extension === 'yml') return 'yaml'
  if (extension === 'csv') return 'csv'
  if (extension === 'tsv') return 'tsv'
  if (extension === 'xml') return 'xml'

  const trimmed = text.trim()
  if (trimmed.startsWith('<')) return 'xml'
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed)
      return 'json'
    } catch {
      // A YAML flow mapping also starts with `{`; let YAML try.
      return 'yaml'
    }
  }
  const lines = trimmed.split(/\r?\n/).slice(0, 5)
  const columns = (sep) => lines.map((line) => line.split(sep).length)
  const delimited = (sep) => lines.length > 1 && columns(sep).every((n) => n > 1) && new Set(columns(sep)).size === 1
  if (delimited('\t')) return 'tsv'
  // `key: value` lines are YAML even when a value happens to contain commas.
  if (!/^\s*[\w"'-]+\s*:(\s|$)/m.test(trimmed) && delimited(',')) return 'csv'
  return 'yaml'
}

function parseAny(text, filename) {
  switch (detectFormat(text, filename)) {
    case 'json':
      return parseJson(text, filename)
    case 'csv':
      return rowsToObjects(parseCsv(text, ',', filename).rows)
    case 'tsv':
      return rowsToObjects(parseCsv(text, '\t', filename).rows)
    case 'xml':
      return parseXml(text, filename)
    default:
      return parseYaml(text, filename)
  }
}

function serialise(data, target, options) {
  switch (target) {
    case 'yaml':
      return { body: stringifyYaml(data, options.indent || 2), type: 'application/yaml', extension: 'yaml' }
    case 'csv':
    case 'tsv':
      return {
        body: unparseCsv(toRows(data, options.flatten), target === 'tsv' ? '\t' : ','),
        type: target === 'tsv' ? 'text/tab-separated-values' : 'text/csv',
        extension: target,
      }
    case 'xml':
      return { body: stringifyXml(data, options.rootName, options.indent), type: 'application/xml', extension: 'xml' }
    default:
      return { body: JSON.stringify(data, null, options.indent), type: 'application/json', extension: 'json' }
  }
}

/* ---------------------------------- JSON --------------------------------- */

function parseJson(text, filename) {
  try {
    return JSON.parse(text)
  } catch (err) {
    // Engines disagree on error messages (and current V8 omits the offset
    // entirely), so locate the error ourselves rather than parsing the message.
    const offset = jsonErrorOffset(text)
    const reason = String(err.message).split('\n')[0]
    if (offset < 0) throw new Error(`${filename} 不是合法的 JSON：${reason}`)
    const before = text.slice(0, offset).split('\n')
    throw new Error(`${filename} 不是合法的 JSON（第 ${before.length} 行第 ${before[before.length - 1].length + 1} 列）：${reason}`)
  }
}

/**
 * Offset of the first character that makes `text` invalid JSON, or -1. A
 * validating scanner only - it runs on the error path, after JSON.parse failed.
 */
function jsonErrorOffset(text) {
  let i = 0
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i++
  }
  const fail = () => {
    throw i
  }
  const literal = (word) => {
    for (const ch of word) if (text[i++] !== ch) (i--, fail())
  }
  const string = () => {
    i++
    while (i < text.length && text[i] !== '"') {
      if (text.charCodeAt(i) < 0x20) fail()
      if (text[i] === '\\') {
        i++
        if (text[i] === 'u') {
          for (let k = 1; k <= 4; k++) if (!/[0-9a-fA-F]/.test(text[i + k] ?? '')) (i += k, fail())
          i += 4
        } else if (!'"\\/bfnrt'.includes(text[i] ?? 'x')) fail()
      }
      i++
    }
    if (i >= text.length) fail()
    i++
  }
  const number = () => {
    const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i))
    if (!match) fail()
    i += match[0].length
  }
  const value = () => {
    ws()
    const ch = text[i]
    if (ch === '{') {
      i++
      ws()
      if (text[i] === '}') return void i++
      for (;;) {
        ws()
        if (text[i] !== '"') fail()
        string()
        ws()
        if (text[i] !== ':') fail()
        i++
        value()
        ws()
        if (text[i] === ',') i++
        else if (text[i] === '}') return void i++
        else fail()
      }
    }
    if (ch === '[') {
      i++
      ws()
      if (text[i] === ']') return void i++
      for (;;) {
        value()
        ws()
        if (text[i] === ',') i++
        else if (text[i] === ']') return void i++
        else fail()
      }
    }
    if (ch === '"') return string()
    if (ch === 't') return literal('true')
    if (ch === 'f') return literal('false')
    if (ch === 'n') return literal('null')
    if (ch === '-' || (ch >= '0' && ch <= '9')) return number()
    fail()
  }
  try {
    value()
    ws()
    return i < text.length ? i : -1
  } catch (offset) {
    return typeof offset === 'number' ? Math.min(offset, text.length) : -1
  }
}

function pickPath(data, path) {
  const segments = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
  let cursor = data
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== 'object' || !(segment in cursor)) {
      throw new Error(`路径 ${path} 不存在（在「${segment}」处中断）`)
    }
    cursor = cursor[segment]
  }
  return cursor
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortDeep(value[key])
        return acc
      }, {})
  }
  return value
}

/* ---------------------------------- YAML --------------------------------- */

/** A multi-document stream becomes an array of documents. */
function parseYaml(text, filename) {
  const { YAML } = libs()
  // `merge: true` expands `<<: *anchor`, which YAML 1.2 mode leaves off by
  // default but docker-compose, k8s and CI configs all rely on.
  const documents = YAML.parseAllDocuments(text, { merge: true })
  const list = Array.isArray(documents) ? documents : [documents]
  const errors = list.flatMap((doc) => doc.errors ?? [])
  if (errors.length) {
    const first = errors[0]
    const line = first.linePos?.[0]?.line
    throw new Error(`${filename} 不是合法的 YAML${line ? `（第 ${line} 行）` : ''}：${first.message.split('\n')[0]}`)
  }
  const values = list.map((doc) => doc.toJS({ maxAliasCount: 10000 }))
  if (values.length === 0) return null
  return values.length === 1 ? values[0] : values
}

function stringifyYaml(data, indent) {
  const { YAML } = libs()
  return YAML.stringify(data, { indent, lineWidth: 0 })
}

/* ---------------------------------- CSV ---------------------------------- */

/**
 * `delimiter` of '' lets papaparse detect it. Returns the delimiter actually
 * used so outputs keep the input's dialect.
 */
function parseCsv(text, delimiter, filename) {
  const { Papa } = libs()
  const result = Papa.parse(text, { delimiter, skipEmptyLines: 'greedy' })
  // Only unbalanced quotes abort; ragged rows are normal in real exports.
  const fatal = result.errors.find((e) => e.type === 'Quotes')
  if (fatal) throw new Error(`${filename} 的 CSV 引号不匹配（第 ${fatal.row + 1} 行）：${fatal.message}`)
  return { rows: result.data, delimiter: result.meta.delimiter || delimiter || ',' }
}

function unparseCsv(rows, delimiter) {
  const { Papa } = libs()
  return Papa.unparse(rows, { delimiter, newline: '\n' })
}

function rowsToObjects(rows) {
  if (rows.length === 0) return []
  const [header, ...body] = rows
  return body.map((row) => {
    const record = {}
    header.forEach((name, i) => {
      record[name] = row[i] ?? ''
    })
    return record
  })
}

/** Flattens a value into a header row plus data rows. */
function toRows(data, flatten) {
  const list = Array.isArray(data) ? data : [data]
  const records = list.map((item) =>
    item !== null && typeof item === 'object' && !Array.isArray(item) ? (flatten ? flattenObject(item) : item) : { value: item },
  )
  const keys = []
  for (const record of records) for (const key of Object.keys(record)) if (!keys.includes(key)) keys.push(key)
  return [
    keys,
    ...records.map((record) =>
      keys.map((key) => {
        const value = record[key]
        if (value === null || value === undefined) return ''
        return typeof value === 'object' ? JSON.stringify(value) : String(value)
      }),
    ),
  ]
}

function flattenObject(value, prefix = '', out = {}) {
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (item !== null && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length) flattenObject(item, path, out)
    else out[path] = item
  }
  return out
}

/* ---------------------------------- XML ---------------------------------- */

const XML_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  // Keep "007" and "0x1F" as written; converting them to numbers loses data.
  numberParseOptions: { leadingZeros: false, hex: false },
  parseTagValue: true,
  trimValues: true,
}

function parseXml(text, filename) {
  const { XMLParser, XMLValidator } = libs()
  const valid = XMLValidator.validate(text)
  if (valid !== true) throw new Error(`${filename} 不是合法的 XML（第 ${valid.err.line} 行）：${valid.err.msg}`)
  const parsed = new XMLParser(XML_OPTIONS).parse(text)
  // The `<?xml ?>` declaration comes back as a pseudo-key; it is not data.
  delete parsed['?xml']
  return parsed
}

function stringifyXml(data, rootName, indent) {
  const { XMLBuilder } = libs()
  const builder = new XMLBuilder({ ...XML_OPTIONS, format: indent > 0, indentBy: ' '.repeat(indent), suppressEmptyNode: true })
  const tag = sanitizeTag(rootName)
  // A single-key object already has a root; anything else gets wrapped. Arrays
  // become repeated <item> elements, the only lossless mapping.
  let tree
  if (Array.isArray(data)) tree = { [tag]: { item: data } }
  else if (data !== null && typeof data === 'object' && Object.keys(data).length === 1 && !Array.isArray(Object.values(data)[0]) && !Object.keys(data)[0].startsWith('@')) tree = data
  else tree = { [tag]: data }
  return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build(sanitizeKeys(tree))}`.trimEnd()
}

/** XML names cannot contain spaces or start with a digit; JSON keys can. */
function sanitizeKeys(value) {
  if (Array.isArray(value)) return value.map(sanitizeKeys)
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    const name = key.startsWith('@') ? `@${sanitizeTag(key.slice(1))}` : key === '#text' ? key : sanitizeTag(key)
    out[name] = sanitizeKeys(item)
  }
  return out
}

function sanitizeTag(name) {
  const cleaned = String(name).replace(/[^\p{L}\p{N}_.-]/gu, '_')
  return /^[\p{L}_]/u.test(cleaned) ? cleaned : `_${cleaned}`
}

/* -------------------------------- Markdown ------------------------------- */

function createMarkdown(options) {
  const { MarkdownIt, markdownItFootnote, markdownItTaskLists } = libs()
  // `html: false` escapes raw HTML in the source. The output is a file the user
  // opens in a browser, so passing `<script>` through would make this tool an
  // XSS vector for anything they convert. markdown-it's default link validator
  // already neutralises `javascript:` / `vbscript:` / `data:` URLs.
  // `xhtmlOut` for EPUB, whose chapters must be well-formed XML (`<br />`, not `<br>`).
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: !!options.breaks, xhtmlOut: !!options.xhtml })
  md.use(markdownItFootnote)
  md.use(markdownItTaskLists, { enabled: false, label: true })
  return md
}

/**
 * GitHub-style slugs that survive CJK headings, de-duplicated with numeric
 * suffixes.
 */
function slugger() {
  const seen = new Map()
  return (text) => {
    const base = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-') || 'section'
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base}-${count}`
  }
}

function inlineText(token) {
  return (token.children ?? []).filter((t) => t.type === 'text' || t.type === 'code_inline').map((t) => t.content).join('')
}

/** Headings via the real tokenizer: `#` inside a code block is not a heading, setext headings are. */
function extractHeadings(source) {
  const tokens = createMarkdown({}).parse(source, {})
  const slug = slugger()
  const headings = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'heading_open') continue
    const text = inlineText(tokens[i + 1])
    headings.push({ level: Number(tokens[i].tag.slice(1)), text, id: slug(text) })
  }
  return headings
}

function renderMarkdown(source, options) {
  const md = createMarkdown(options)
  const env = {}
  const tokens = md.parse(source, env)
  const slug = slugger()
  const headings = []

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'heading_open') continue
    const text = inlineText(tokens[i + 1])
    const id = slug(text)
    tokens[i].attrSet('id', id)
    headings.push({ level: Number(tokens[i].tag.slice(1)), text, id })
  }

  let html = md.renderer.render(tokens, md.options, env)

  if (options.toc && headings.length) {
    const items = headings.map((h) => `<li class="toc-l${h.level}"><a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a></li>`).join('')
    html = `<nav class="toc"><p class="toc-title">目录</p><ul>${items}</ul></nav>\n${html}`
  }

  return { html, headings }
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function htmlDocument(title, body, darkMode) {
  const dark = darkMode
    ? `@media (prefers-color-scheme: dark){body{background:#16161a;color:#e6e6e9}code,pre{background:#24242a}blockquote{border-color:#3a3a42;color:#a0a0aa}th,td,hr,h2{border-color:#3a3a42}th{background:#1f1f25}a{color:#8ab4f8}.toc{background:#1c1c22;border-color:#3a3a42}}`
    : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark}
body{max-width:48rem;margin:0 auto;padding:2.5rem 1.25rem;font:16px/1.75 ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#fff;color:#1a1a1f;overflow-wrap:break-word}
h1,h2,h3,h4,h5,h6{line-height:1.3;margin:2rem 0 .75rem;scroll-margin-top:1rem}
h1{font-size:2rem}h2{font-size:1.5rem;padding-bottom:.3rem;border-bottom:1px solid #eee}h3{font-size:1.25rem}h4{font-size:1.05rem}
p,ul,ol,blockquote,pre,table{margin:0 0 1rem}
ul,ol{padding-left:1.6rem}
li+li{margin-top:.25rem}
code{background:#f2f2f5;padding:.15em .4em;border-radius:4px;font-size:.88em;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
pre{background:#f2f2f5;padding:1rem;border-radius:8px;overflow:auto;line-height:1.55}
pre code{background:none;padding:0;font-size:.85em}
blockquote{padding:.25rem 0 .25rem 1rem;border-left:3px solid #ddd;color:#666}
table{border-collapse:collapse;display:block;max-width:100%;overflow:auto}
th,td{border:1px solid #ddd;padding:.45rem .75rem}
th{background:#f7f7f9;font-weight:600}
img{max-width:100%}
hr{border:0;border-top:1px solid #ddd;margin:2rem 0}
.task-list-item{list-style:none;margin-left:-1.4rem}
.task-list-item-checkbox{margin-right:.5rem;vertical-align:middle}
.footnotes{font-size:.9em;color:#666}
.footnotes-sep{margin-top:3rem}
.toc{border:1px solid #eee;background:#fafafb;border-radius:8px;padding:.75rem 1.25rem;margin-bottom:2rem}
.toc-title{font-weight:600;margin:0 0 .25rem}
.toc ul{list-style:none;padding-left:0;margin:0}
.toc-l2{padding-left:1rem}.toc-l3{padding-left:2rem}.toc-l4,.toc-l5,.toc-l6{padding-left:3rem}
${dark}
</style>
</head>
<body>
${body}
</body>
</html>`
}

/* ---------------------------------- text --------------------------------- */

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu

function transformText(text, params) {
  const lines = text.split(/\r?\n/)
  const ignoreCase = !!params.ignoreCase

  switch (String(params.operation)) {
    case 'replace': {
      const find = String(params.find ?? '')
      if (!find) throw new Error('查找内容不能为空')
      let pattern
      try {
        pattern = new RegExp(params.regex ? find : escapeRegExp(find), ignoreCase ? 'gi' : 'g')
      } catch (err) {
        throw new Error(`正则表达式无效：${err.message}`)
      }
      // In literal mode `$` in the replacement must stay literal too.
      const replacement = params.regex ? String(params.replace ?? '') : String(params.replace ?? '').replace(/\$/g, '$$$$')
      return { text: text.replace(pattern, replacement) }
    }
    case 'sort': {
      const collator = new Intl.Collator('zh', { numeric: !!params.numeric, sensitivity: ignoreCase ? 'accent' : 'variant' })
      const sorted = lines.slice().sort(collator.compare)
      if (params.descending) sorted.reverse()
      return { text: sorted.join('\n') }
    }
    case 'dedupe': {
      const seen = new Set()
      return {
        text: lines
          .filter((line) => {
            const key = ignoreCase ? line.toLowerCase() : line
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
          .join('\n'),
      }
    }
    case 'case': {
      const mode = String(params.caseMode)
      if (mode === 'lower') return { text: text.toLowerCase() }
      if (mode === 'title') return { text: text.replace(/\p{L}[\p{L}\p{M}'’]*/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()) }
      if (mode === 'sentence') return { text: text.toLowerCase().replace(/(^\s*|[.!?。！？]\s*)(\p{L})/gu, (_, lead, ch) => lead + ch.toUpperCase()) }
      return { text: text.toUpperCase() }
    }
    case 'trim':
      return { text: lines.map((line) => line.trim()).join('\n') }
    case 'blank':
      return { text: lines.filter((line) => line.trim() !== '').join('\n') }
    case 'numbering': {
      const width = String(lines.length).length
      return { text: lines.map((line, i) => `${String(i + 1).padStart(width, ' ')}  ${line}`).join('\n') }
    }
    default: {
      const cjk = (text.match(CJK) ?? []).length
      // Latin words, with CJK characters (counted one each) blanked out first.
      const latinWords = (text.replace(CJK, ' ').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length
      return {
        json: {
          characters: [...text].length,
          charactersNoSpaces: [...text.replace(/\s/g, '')].length,
          cjkCharacters: cjk,
          words: latinWords + cjk,
          lines: text === '' ? 0 : lines.length,
          paragraphs: text.split(/\n\s*\n/).filter((p) => p.trim()).length,
          bytes: new TextEncoder().encode(text).length,
        },
      }
    }
  }
}

/* -------------------------------- encoding ------------------------------- */

function toBase64(bytes) {
  let binary = ''
  // Chunked so a large file does not exceed String.fromCharCode's argument limit.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function fromBase64(text) {
  // Accept data URIs, the URL-safe alphabet, whitespace and missing padding.
  let clean = text.trim().replace(/^data:[^,]*,/, '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  while (clean.length % 4) clean += '='
  let binary
  try {
    binary = atob(clean)
  } catch {
    throw new Error('不是合法的 Base64 内容')
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function fromHex(text) {
  const clean = text.trim().replace(/^0x/i, '').replace(/[\s:]/g, '')
  if (clean.length % 2 || /[^0-9a-f]/i.test(clean)) throw new Error('不是合法的 Hex 内容')
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

/* ========================================================================== */
/* Documents batch                                                            */
/* ========================================================================== */

async function eachBinary(ctx, fn) {
  if (ctx.inputs.length === 0) throw new Error('请先拖入文件')
  for (let i = 0; i < ctx.inputs.length; i++) {
    ctx.throwIfAborted()
    ctx.progress(i / ctx.inputs.length, `正在读取 ${ctx.inputs[i].name}`)
    await fn(ctx.inputs[i], await host.fs.readAll(ctx.inputs[i].id))
  }
  ctx.progress(1)
}

function safeName(name) {
  return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 120) || 'file'
}

function uniqueFileName(name, used) {
  let candidate = name
  let n = 2
  while (used.has(candidate.toLowerCase())) {
    const dot = name.lastIndexOf('.')
    candidate = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`
    n++
  }
  used.add(candidate.toLowerCase())
  return candidate
}

/* ------------------------------ spreadsheets ------------------------------ */

/**
 * Reads any supported input into a SheetJS workbook. CSV text is decoded first:
 * Excel on Chinese Windows saves CSV as GBK, which SheetJS would read as
 * Latin-1 garbage.
 */
function readWorkbook(XLSX, input, bytes) {
  const name = input.name.toLowerCase()
  if (/\.json$/.test(name)) {
    const data = JSON.parse(decodeText(bytes))
    const rows = Array.isArray(data) ? data : [data]
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows.map((row) => (row && typeof row === 'object' ? row : { value: row }))), 'Sheet1')
    return book
  }
  if (/\.(csv|tsv|txt)$/.test(name)) {
    return XLSX.read(decodeText(bytes), { type: 'string', raw: false, cellDates: true, FS: /\.tsv$/.test(name) ? '\t' : undefined })
  }
  try {
    return XLSX.read(bytes, { type: 'array', cellDates: true })
  } catch (err) {
    throw new Error(`${input.name} 无法读取：${/password|encrypt/i.test(String(err && err.message)) ? '文件受密码保护' : err && err.message ? err.message : err}`)
  }
}

/** UTF-8 when valid, otherwise GBK. BOM stripped. */
function decodeText(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
  } catch {
    return new TextDecoder('gbk').decode(bytes)
  }
}

function uniqueSheetName(name, used) {
  // Excel: at most 31 characters, none of : \ / ? * [ ]
  const base = String(name).replace(/[:\\/?*[\]]/g, '_').slice(0, 31) || 'Sheet'
  let candidate = base
  let n = 2
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` (${n++})`
    candidate = base.slice(0, 31 - suffix.length) + suffix
  }
  used.add(candidate.toLowerCase())
  return candidate
}

function sheetToMarkdown(XLSX, sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false, blankrows: false })
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map((r) => r.length))
  const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
  const line = (row) => `| ${Array.from({ length: width }, (_, i) => cell(row[i])).join(' | ')} |`
  return [line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n') + '\n'
}

/* --------------------------------- fonts ---------------------------------- */

const FONT_TYPES = { ttf: 'font/ttf', woff: 'font/woff', woff2: 'font/woff2', eot: 'application/vnd.ms-fontobject', svg: 'image/svg+xml' }
const FONT_FORMATS = { ttf: 'truetype', woff: 'woff', woff2: 'woff2', eot: 'embedded-opentype', svg: 'svg' }

/** Font container from magic bytes, falling back to the extension. */
function fontType(name, bytes) {
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
  if (tag === 'wOF2') return 'woff2'
  if (tag === 'wOFF') return 'woff'
  if (tag === 'OTTO') return 'otf'
  if (tag === 'true' || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)) return 'ttf'
  const extension = extensionOf(name)
  if (['eot', 'svg', 'otf', 'ttf', 'woff', 'woff2'].includes(extension)) return extension
  throw new Error(`${name} 不是可识别的字体文件`)
}

/** Unique code points to keep, or null for "all". */
function fontSubset(text, ascii) {
  const points = new Set()
  for (const ch of text) if (!/\s/.test(ch) || ch === ' ') points.add(ch.codePointAt(0))
  if (points.size === 0) return null
  if (ascii) for (let c = 0x20; c < 0x7f; c++) points.add(c)
  return [...points].sort((a, b) => a - b)
}

/* ---------------------------------- email ---------------------------------- */

function isOleFile(bytes) {
  return bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0
}

/** A message in one shape for both formats: subject, from, to, cc, date, html, text, attachments. */
async function parseEml(bytes) {
  const { exports } = await loadDependency('postal-mime')
  const PostalMime = exports.default ?? exports
  const email = await PostalMime.parse(bytes)
  const address = (a) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : '')
  return {
    subject: email.subject || '',
    from: address(email.from),
    to: (email.to || []).map(address),
    cc: (email.cc || []).map(address),
    date: email.date || '',
    messageId: email.messageId || '',
    html: email.html || '',
    text: email.text || '',
    attachments: (email.attachments || []).map((a) => ({ name: a.filename || 'attachment.bin', type: a.mimeType, data: toUint8(a.content) })),
  }
}

async function parseMsg(bytes) {
  const { exports } = await loadDependency('msgreader')
  const MsgReader = exports.default ?? exports.MsgReader ?? exports
  const reader = new MsgReader(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  const data = reader.getFileData()
  if (data.error) throw new Error(`无法解析 MSG 邮件：${data.error}`)
  const recipients = (data.recipients || []).map((r) => ({ kind: r.recipType, text: r.smtpAddress || r.email ? `${r.name || ''} <${r.smtpAddress || r.email}>`.trim() : r.name }))
  const html = data.html ? decodeText(toUint8(data.html)) : data.bodyHtml || ''
  return {
    subject: data.subject || '',
    from: data.senderEmail ? `${data.senderName || ''} <${data.senderSmtpAddress || data.senderEmail}>`.trim() : data.senderName || '',
    to: recipients.filter((r) => r.kind !== 'cc' && r.kind !== 'bcc').map((r) => r.text),
    cc: recipients.filter((r) => r.kind === 'cc').map((r) => r.text),
    date: data.messageDeliveryTime || data.clientSubmitTime || '',
    messageId: data.messageId || '',
    html,
    text: data.body || '',
    attachments: (data.attachments || [])
      .filter((a) => !a.innerMsgContent)
      .map((a) => {
        const file = reader.getAttachment(a)
        return { name: file.fileName || a.fileName || 'attachment.bin', type: a.attachMimeTag || '', data: toUint8(file.content) }
      }),
  }
}

function toUint8(data) {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (typeof data === 'string') return new TextEncoder().encode(data)
  return new Uint8Array(0)
}

/**
 * The HTML body with a header block. Opened in the app's preview it is sandboxed
 * with network blocked, so tracking pixels in the mail stay silent.
 */
function emailHtmlDocument(message) {
  const rows = [['主题', message.subject], ['发件人', message.from], ['收件人', message.to.join(', ')], ['抄送', message.cc.join(', ')], ['日期', String(message.date)]]
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
    .join('')
  const head = `<table style="font:13px system-ui,sans-serif;border-collapse:collapse;margin:0 0 16px">${rows}</table><hr>`
  const body = /<body[^>]*>/i.test(message.html) ? message.html.replace(/<body([^>]*)>/i, `<body$1>${head}`) : `<!doctype html><meta charset="utf-8"><body>${head}${message.html}</body>`
  return body
}

/* ---------------------------------- EPUB ---------------------------------- */

function textToMarkdown(text) {
  // Plain text: blank lines separate paragraphs; single newlines are kept.
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.replace(/([\\`*_{}[\]()#+\-.!|<>])/g, '\\$1').replace(/\r?\n/g, '  \n'))
    .join('\n\n')
}

function splitByH1(markdown) {
  const tokens = createMarkdown({}).parse(markdown, {})
  const starts = tokens.filter((t) => t.type === 'heading_open' && t.tag === 'h1' && t.map).map((t) => t.map[0])
  if (starts.length <= 1) return [markdown]
  const lines = markdown.split(/\r?\n/)
  const parts = []
  if (starts[0] > 0 && lines.slice(0, starts[0]).join('').trim()) parts.push(lines.slice(0, starts[0]).join('\n'))
  starts.forEach((start, i) => parts.push(lines.slice(start, starts[i + 1] ?? lines.length).join('\n')))
  return parts
}

function xmlEscape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function randomUuid() {
  // The sandbox is not a secure context, so crypto.randomUUID is unavailable; getRandomValues is.
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/**
 * EPUB 3 with an EPUB 2 NCX for older readers. `mimetype` must be the first
 * entry and stored uncompressed - readers identify the format by those bytes.
 */
function buildEpub(zip, { title, author, language, chapters, cover }) {
  const id = `urn:uuid:${randomUuid()}`
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  const text = (s) => zip.strToU8(s)
  const files = { mimetype: [text('application/epub+zip'), { level: 0 }] }
  files['META-INF/container.xml'] = text('<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
  files['OEBPS/style.css'] = text('body{font-family:serif;line-height:1.7;margin:0 5%}h1,h2,h3{line-height:1.3}pre{white-space:pre-wrap;background:#f4f4f4;padding:.6em}code{font-family:monospace}blockquote{margin:1em 0;padding-left:1em;border-left:3px solid #ccc;color:#555}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.3em .5em}')

  const xhtml = (heading, body) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}" lang="${language}"><head><meta charset="UTF-8"/><title>${xmlEscape(heading)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${body}</body></html>`
  const manifest = ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>', '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>', '<item id="css" href="style.css" media-type="text/css"/>']
  const spine = []

  if (cover) {
    const extension = cover.type === 'image/png' ? 'png' : 'jpg'
    files[`OEBPS/cover.${extension}`] = [cover.bytes, { level: 0 }]
    files['OEBPS/cover.xhtml'] = text(xhtml(title, `<div style="text-align:center"><img src="cover.${extension}" alt="${xmlEscape(title)}"/></div>`))
    manifest.push(`<item id="cover-image" href="cover.${extension}" media-type="${cover.type}" properties="cover-image"/>`, '<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>')
    spine.push('<itemref idref="cover" linear="no"/>')
  }
  chapters.forEach((chapter, i) => {
    const name = `chapter-${String(i + 1).padStart(3, '0')}.xhtml`
    files[`OEBPS/${name}`] = text(xhtml(chapter.title, chapter.html))
    manifest.push(`<item id="c${i + 1}" href="${name}" media-type="application/xhtml+xml"/>`)
    spine.push(`<itemref idref="c${i + 1}"/>`)
  })

  const tocItems = chapters.map((c, i) => `<li><a href="chapter-${String(i + 1).padStart(3, '0')}.xhtml">${xmlEscape(c.title)}</a></li>`).join('')
  files['OEBPS/nav.xhtml'] = text(xhtml('目录', `<nav epub:type="toc" id="toc"><h1>目录</h1><ol>${tocItems}</ol></nav>`))
  files['OEBPS/toc.ncx'] = text(`<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${id}"/></head><docTitle><text>${xmlEscape(title)}</text></docTitle><navMap>${chapters.map((c, i) => `<navPoint id="n${i + 1}" playOrder="${i + 1}"><navLabel><text>${xmlEscape(c.title)}</text></navLabel><content src="chapter-${String(i + 1).padStart(3, '0')}.xhtml"/></navPoint>`).join('')}</navMap></ncx>`)
  files['OEBPS/content.opf'] = text(`<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${language}"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">${id}</dc:identifier><dc:title>${xmlEscape(title)}</dc:title>${author ? `<dc:creator>${xmlEscape(author)}</dc:creator>` : ''}<dc:language>${language}</dc:language><meta property="dcterms:modified">${modified}</meta>${cover ? '<meta name="cover" content="cover-image"/>' : ''}</metadata><manifest>${manifest.join('')}</manifest><spine toc="ncx">${spine.join('')}</spine></package>`)
  return zip.zipSync(files, { level: 6 })
}

/* ------------------------------ PDF typesetting ---------------------------- */

async function cjkFontBytes() {
  const { exports: fonts, assets } = await loadDependency('cjk-font')
  const name = 'NotoSansSC-Regular.ttf'
  if (!fonts[name]?.available || !assets[name] || assets[name].byteLength < 1024) {
    throw new Error('内置中文字体未打包（构建时需要联网运行一次 pnpm vendor），暂时无法生成 PDF')
  }
  return new Uint8Array(assets[name])
}

const PAPER_SIZES = { a4: [595.28, 841.89], letter: [612, 792], a5: [419.53, 595.28] }

/**
 * A small typesetter over markdown-it tokens. It does not try to be a browser:
 * one font, sizes for hierarchy, wrapping that breaks CJK anywhere and Latin at
 * spaces, and blocks that start a new page when they would not fit. Everything
 * in the source ends up on the page - styling is simplified, content is not.
 */
async function typesetMarkdown(PDFLib, fontkit, fontBytes, source, options) {
  const { PDFDocument, rgb } = PDFLib
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const font = await doc.embedFont(fontBytes, { subset: true })
  const supported = new Set(font.getCharacterSet())
  const clean = (text) => [...String(text).replace(/\t/g, '    ')].map((ch) => (supported.has(ch.codePointAt(0)) ? ch : ch.trim() ? '□' : ' ')).join('')

  const [PW, PH] = PAPER_SIZES[options.paper] ?? PAPER_SIZES.a4
  const M = PW < 500 ? 42 : 56
  const W = PW - M * 2
  const base = options.fontSize
  const ink = rgb(0.1, 0.1, 0.12)
  const muted = rgb(0.4, 0.4, 0.45)
  const rule = rgb(0.85, 0.85, 0.88)
  let page = null
  let y = 0
  const newPage = () => {
    page = doc.addPage([PW, PH])
    y = PH - M
  }
  newPage()
  const ensure = (height) => {
    if (y - height < M) newPage()
  }

  const wrap = (text, size, width) => {
    const lines = []
    for (const paragraph of clean(text).split('\n')) {
      const tokens = paragraph.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{P}]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{P}]+|\s+/gu) ?? ['']
      let line = ''
      for (const token of tokens) {
        const next = line + token
        if (line && font.widthOfTextAtSize(next.trimEnd(), size) > width) {
          lines.push(line.trimEnd())
          line = token.trimStart()
          // A single word wider than the line is broken by characters.
          while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
            let cut = line.length - 1
            while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--
            lines.push(line.slice(0, cut))
            line = line.slice(cut)
          }
        } else {
          line = next
        }
      }
      lines.push(line.trimEnd())
    }
    return lines
  }

  const textBlock = (text, { size = base, indent = 0, color = ink, gap = base * 0.6, leading = 1.55, prefix = '', bar = null, background = null }) => {
    const width = W - indent
    const lines = wrap(text, size, width - (prefix ? font.widthOfTextAtSize(prefix, size) : 0))
    const lineHeight = size * leading
    for (const [i, line] of lines.entries()) {
      ensure(lineHeight)
      if (background) page.drawRectangle({ x: M + indent - 6, y: y - lineHeight + size * 0.1, width: width + 12, height: lineHeight, color: background })
      if (bar) page.drawRectangle({ x: M + indent - 10, y: y - lineHeight + size * 0.1, width: 2.5, height: lineHeight, color: bar })
      const px = i === 0 && prefix ? font.widthOfTextAtSize(prefix, size) : prefix ? font.widthOfTextAtSize(prefix, size) : 0
      if (i === 0 && prefix) page.drawText(clean(prefix), { x: M + indent, y: y - size, size, font, color })
      page.drawText(line, { x: M + indent + px, y: y - size, size, font, color })
      y -= lineHeight
    }
    y -= gap
  }

  const inlineText = (token) =>
    (token.children ?? [])
      .map((child) => {
        if (child.type === 'text' || child.type === 'code_inline') return child.content
        if (child.type === 'softbreak') return ' '
        if (child.type === 'hardbreak') return '\n'
        if (child.type === 'image') return `\u0000img:${child.attrGet('src')}\u0000${child.content}`
        if (child.type === 'html_inline' && /checkbox/.test(child.content)) return /checked/.test(child.content) ? '[x] ' : '[ ] '
        return ''
      })
      .join('')

  const drawParagraphWithImages = async (content, style) => {
    // Split around image placeholders so each image is its own block.
    for (const part of content.split(/(\u0000img:[^\u0000]*\u0000[^\u0000]*)/)) {
      const image = /^\u0000img:([^\u0000]*)\u0000(.*)$/s.exec(part)
      if (!image) {
        if (part.trim()) textBlock(part, style)
        continue
      }
      const loaded = await options.loadImage(image[1]).catch(() => null)
      if (!loaded) {
        textBlock(`[图片：${image[2] || image[1]}]`, { ...style, color: muted })
        continue
      }
      const embedded = loaded.png ? await doc.embedPng(loaded.bytes) : await doc.embedJpg(loaded.bytes)
      const scale = Math.min(1, (W - (style.indent || 0)) / embedded.width, (PH - M * 2) / embedded.height)
      const w = embedded.width * scale
      const h = embedded.height * scale
      ensure(h + 8)
      page.drawImage(embedded, { x: M + (style.indent || 0), y: y - h, width: w, height: h })
      y -= h + base * 0.8
    }
  }

  const md = createMarkdown({})
  const tokens = md.parse(source, {})
  const lists = []
  let quoteDepth = 0
  let firstHeading = ''
  const HEADING = [2.2, 1.75, 1.45, 1.25, 1.1, 1]

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const indent = lists.length * 18 + quoteDepth * 14
    const style = { indent, color: quoteDepth ? muted : ink, bar: quoteDepth ? rule : null }

    switch (token.type) {
      case 'heading_open': {
        const level = Number(token.tag.slice(1))
        const text = inlineText(tokens[i + 1])
        if (!firstHeading) firstHeading = text
        const size = base * HEADING[level - 1]
        y -= level <= 2 ? size * 0.6 : size * 0.3
        ensure(size * 3)
        textBlock(text, { ...style, size, gap: level <= 2 ? size * 0.2 : size * 0.3, leading: 1.3 })
        if (level <= 2) {
          page.drawLine({ start: { x: M + indent, y: y + size * 0.05 }, end: { x: PW - M, y: y + size * 0.05 }, thickness: 0.6, color: rule })
          y -= size * 0.4
        }
        i += 2
        break
      }
      case 'paragraph_open': {
        const content = inlineText(tokens[i + 1])
        const item = lists[lists.length - 1]
        if (item && item.pendingPrefix) {
          const prefix = item.pendingPrefix
          item.pendingPrefix = ''
          textBlock(content, { ...style, indent: indent - 18 + 0, prefix: `${prefix} `, gap: base * 0.25 })
        } else {
          await drawParagraphWithImages(content, { ...style, gap: lists.length ? base * 0.25 : base * 0.7 })
        }
        i += 2
        break
      }
      case 'bullet_list_open':
        lists.push({ ordered: false, n: 0 })
        break
      case 'ordered_list_open':
        lists.push({ ordered: true, n: Number(token.attrGet('start') || 1) - 1 })
        break
      case 'bullet_list_close':
      case 'ordered_list_close':
        lists.pop()
        if (!lists.length) y -= base * 0.4
        break
      case 'list_item_open': {
        const list = lists[lists.length - 1]
        list.n++
        // Task list items carry their checkbox in the first inline token.
        list.pendingPrefix = list.ordered ? `${list.n}.` : ['•', '◦', '▪'][(lists.length - 1) % 3]
        break
      }
      case 'blockquote_open':
        quoteDepth++
        break
      case 'blockquote_close':
        quoteDepth--
        y -= base * 0.3
        break
      case 'fence':
      case 'code_block': {
        const size = base * 0.88
        y -= base * 0.2
        for (const line of token.content.replace(/\n$/, '').split('\n')) {
          textBlock(line || ' ', { size, indent: indent + 6, color: rgb(0.2, 0.2, 0.25), gap: 0, leading: 1.45, background: rgb(0.955, 0.955, 0.965) })
        }
        y -= base * 0.8
        break
      }
      case 'hr':
        ensure(base * 2)
        y -= base * 0.6
        page.drawLine({ start: { x: M, y }, end: { x: PW - M, y }, thickness: 0.8, color: rule })
        y -= base
        break
      case 'table_open': {
        const rows = []
        let j = i + 1
        let row = null
        for (; j < tokens.length && tokens[j].type !== 'table_close'; j++) {
          if (tokens[j].type === 'tr_open') row = []
          else if (tokens[j].type === 'tr_close') rows.push(row)
          else if (tokens[j].type === 'inline' && row) row.push(inlineText(tokens[j]))
        }
        drawTable(rows)
        i = j
        break
      }
      case 'inline':
        // Inline content outside a paragraph (tight list items).
        if (token.content.trim()) {
          const item = lists[lists.length - 1]
          const prefix = item?.pendingPrefix
          if (item) item.pendingPrefix = ''
          textBlock(inlineText(token), { ...style, indent: prefix ? indent - 18 : indent, prefix: prefix ? `${prefix} ` : '', gap: base * 0.25 })
        }
        break
      default:
        break
    }
  }

  function drawTable(rows) {
    if (rows.length === 0) return
    const columns = Math.max(...rows.map((r) => r.length))
    const size = base * 0.9
    const cellPad = 4
    const colWidth = W / columns
    y -= base * 0.3
    for (const [r, row] of rows.entries()) {
      const wrapped = Array.from({ length: columns }, (_, c) => wrap(row[c] ?? '', size, colWidth - cellPad * 2))
      const height = Math.max(...wrapped.map((lines) => lines.length)) * size * 1.4 + cellPad * 2
      ensure(height)
      if (r === 0) page.drawRectangle({ x: M, y: y - height, width: W, height, color: rgb(0.96, 0.96, 0.97) })
      wrapped.forEach((lines, c) => {
        const x = M + c * colWidth
        page.drawRectangle({ x, y: y - height, width: colWidth, height, borderColor: rule, borderWidth: 0.6 })
        lines.forEach((line, k) => page.drawText(line, { x: x + cellPad, y: y - cellPad - size - k * size * 1.4 + size * 0.15, size, font, color: ink }))
      })
      y -= height
    }
    y -= base * 0.8
  }

  const pages = doc.getPages()
  if (options.pageNumbers) {
    const size = base * 0.8
    pages.forEach((p, index) => {
      const label = `${index + 1} / ${pages.length}`
      p.drawText(label, { x: (PW - font.widthOfTextAtSize(label, size)) / 2, y: M * 0.45, size, font, color: muted })
    })
  }
  doc.setTitle(options.title || firstHeading || options.fallbackTitle)
  doc.setCreator('OmniTool')
  return doc.save()
}

/* ---------------------------------- charts --------------------------------- */

const CHART_COLORS = ['#2563eb', '#16a34a', '#f59e0b', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d']

/** "Nice" axis ticks: 1, 2 or 5 × 10^n steps covering [min, max]. */
function niceTicks(min, max, count = 5) {
  if (min === max) max = min + 1
  const span = max - min
  const step0 = span / count
  const magnitude = 10 ** Math.floor(Math.log10(step0))
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => span / s <= count) ?? 10 * magnitude
  const start = Math.floor(min / step) * step
  const ticks = []
  for (let v = start; v <= max + step * 0.5; v += step) ticks.push(Number(v.toFixed(10)))
  return ticks
}

function formatNumber(value) {
  const abs = Math.abs(value)
  if (abs >= 1e8) return `${(value / 1e8).toFixed(abs >= 1e9 ? 0 : 1)}亿`
  if (abs >= 1e4) return `${(value / 1e4).toFixed(abs >= 1e5 ? 0 : 1)}万`
  return String(Number(value.toFixed(2)))
}

function renderChart(table, { type, title, width, height }) {
  const [header, ...body] = table
  const labels = body.map((row) => String(row[0] ?? ''))
  const series = header
    .slice(1)
    .map((name, i) => ({ name: String(name), color: CHART_COLORS[i % CHART_COLORS.length], values: body.map((row) => Number(String(row[i + 1] ?? '').replace(/[,，%\s]/g, ''))) }))
    .filter((s) => s.values.some((v) => Number.isFinite(v)))
  if (series.length === 0) throw new Error('没有找到数值列：除第一列外，至少需要一列数字')

  const font = 'font-family="Noto Sans SC, PingFang SC, Microsoft YaHei, system-ui, sans-serif"'
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ${font}>`, `<rect width="${width}" height="${height}" fill="#ffffff"/>`]
  const top = title ? 56 : 24
  if (title) parts.push(`<text x="${width / 2}" y="34" text-anchor="middle" font-size="20" font-weight="600" fill="#111827">${xmlEscape(title)}</text>`)

  if (type === 'pie') {
    const s = series[0]
    const values = s.values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0))
    const total = values.reduce((a, b) => a + b, 0) || 1
    const cx = width * 0.4
    const cy = top + (height - top) / 2
    const r = Math.min(width * 0.32, (height - top) / 2 - 20)
    let angle = -Math.PI / 2
    values.forEach((v, i) => {
      const sweep = (v / total) * Math.PI * 2
      if (sweep <= 0) return
      const x1 = cx + r * Math.cos(angle)
      const y1 = cy + r * Math.sin(angle)
      const x2 = cx + r * Math.cos(angle + sweep)
      const y2 = cy + r * Math.sin(angle + sweep)
      const color = CHART_COLORS[i % CHART_COLORS.length]
      const path = sweep >= Math.PI * 2 - 1e-6 ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>` : `<path d="M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${sweep > Math.PI ? 1 : 0} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z" fill="${color}" stroke="#fff" stroke-width="2"/>`
      parts.push(path)
      const mid = angle + sweep / 2
      if (sweep > 0.25) parts.push(`<text x="${(cx + r * 0.65 * Math.cos(mid)).toFixed(1)}" y="${(cy + r * 0.65 * Math.sin(mid)).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="13" fill="#fff">${((v / total) * 100).toFixed(1)}%</text>`)
      angle += sweep
    })
    labels.forEach((label, i) => {
      const y = top + 20 + i * 24
      parts.push(`<rect x="${width * 0.76}" y="${y - 10}" width="14" height="14" rx="3" fill="${CHART_COLORS[i % CHART_COLORS.length]}"/>`, `<text x="${width * 0.76 + 22}" y="${y + 2}" font-size="13" fill="#374151">${xmlEscape(label)}（${formatNumber(values[i])}）</text>`)
    })
    parts.push('</svg>')
    return parts.join('\n')
  }

  const all = series.flatMap((s) => s.values.filter(Number.isFinite))
  const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all))
  const [lo, hi] = [ticks[0], ticks[ticks.length - 1]]
  const left = 64
  const right = width - 24
  const legendHeight = series.length > 1 ? 28 : 0
  const bottom = height - 48 - legendHeight
  const yOf = (v) => bottom - ((v - lo) / (hi - lo || 1)) * (bottom - top)
  const band = (right - left) / Math.max(1, labels.length)

  for (const tick of ticks) {
    const y = yOf(tick).toFixed(1)
    parts.push(`<line x1="${left}" x2="${right}" y1="${y}" y2="${y}" stroke="${tick === 0 ? '#9ca3af' : '#e5e7eb'}"/>`, `<text x="${left - 8}" y="${y}" text-anchor="end" dominant-baseline="middle" font-size="12" fill="#6b7280">${formatNumber(tick)}</text>`)
  }
  const every = Math.ceil(labels.length / Math.max(1, Math.floor((right - left) / 60)))
  labels.forEach((label, i) => {
    if (i % every) return
    parts.push(`<text x="${(left + band * (i + 0.5)).toFixed(1)}" y="${bottom + 20}" text-anchor="middle" font-size="12" fill="#374151">${xmlEscape(label.length > 10 ? `${label.slice(0, 9)}…` : label)}</text>`)
  })

  if (type === 'bar') {
    const groupWidth = band * 0.72
    const barWidth = groupWidth / series.length
    series.forEach((s, k) => {
      s.values.forEach((v, i) => {
        if (!Number.isFinite(v)) return
        const x = left + band * i + (band - groupWidth) / 2 + k * barWidth
        const y0 = yOf(Math.max(0, v))
        const h = Math.abs(yOf(v) - yOf(0))
        parts.push(`<rect x="${x.toFixed(1)}" y="${y0.toFixed(1)}" width="${Math.max(1, barWidth - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${s.color}"/>`)
      })
    })
  } else {
    series.forEach((s) => {
      const points = s.values.map((v, i) => (Number.isFinite(v) ? [left + band * (i + 0.5), yOf(v)] : null)).filter(Boolean)
      if (points.length === 0) return
      const path = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
      if (type === 'area') parts.push(`<path d="${path} L${points[points.length - 1][0].toFixed(1)},${yOf(Math.max(lo, 0)).toFixed(1)} L${points[0][0].toFixed(1)},${yOf(Math.max(lo, 0)).toFixed(1)} Z" fill="${s.color}" fill-opacity="0.18"/>`)
      parts.push(`<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round"/>`)
      for (const [x, y] of points) parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="#fff" stroke="${s.color}" stroke-width="2"/>`)
    })
  }

  if (series.length > 1) {
    let x = left
    const y = height - 18
    for (const s of series) {
      parts.push(`<rect x="${x}" y="${y - 10}" width="12" height="12" rx="2" fill="${s.color}"/>`, `<text x="${x + 18}" y="${y}" font-size="13" fill="#374151">${xmlEscape(s.name)}</text>`)
      x += 36 + s.name.length * 13
    }
  }
  parts.push('</svg>')
  return parts.join('\n')
}
