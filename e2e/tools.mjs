/**
 * Exercises the expanded built-in toolkits end to end in a real browser.
 */
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const DIR = new URL('./', import.meta.url).pathname

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// Fixtures the data toolkit needs.
writeFileSync(`${DIR}sample.csv`, 'name,age,city\nAda,36,London\nGrace,45,"New York"\nAda,36,London\n')
writeFileSync(`${DIR}sample.yaml`, 'project: omnitool\ntags:\n  - local\n  - privacy\nmeta:\n  version: 2\n  stable: true\n')
writeFileSync(`${DIR}sample.md`, '# Title\n\nSome **bold** text.\n\n- one\n- two\n\n```js\nconst x = 1 < 2\n```\n')

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})

/** Runs one tool and returns its summary line. */
async function runTool(pluginId, toolId, files, tweak, timeout = 180000) {
  // `networkidle` never settles once a sandbox iframe or a wasm worker is live,
  // so navigate on commit and gate on the view instead.
  // Leave the tool first: re-navigating to the same hash is a no-op for the
  // SPA, and the previous run's inputs would still be selected.
  await page.goto(`${BASE}/#/files`, { waitUntil: 'commit' })
  // Hash navigation resolves before the router swaps views; until the old tool
  // view is gone its file input is still in the DOM and would take the files.
  await page.waitForSelector('main input[type=file]', { state: 'detached', timeout: 10000 })
  await page.goto(`${BASE}/#/t/${pluginId}/${toolId}`, { waitUntil: 'commit' })
  // Gate on the file input rather than a heading: tools that also accept text
  // label the intake "输入" with tabs, and default to the files tab.
  await page.waitForSelector('main input[type=file]', { state: 'attached', timeout: 30000 })
  await page.setInputFiles('input[type=file]', files)
  await page.waitForSelector(`text=${files[0].split('/').pop()}`, { timeout: 20000 })
  if (tweak) await tweak(page)
  // The run control is the last button of the side column; panel tools relabel it.
  const start = page.locator('main aside button').last()
  await start.scrollIntoViewIfNeeded()
  await start.click()
  // Terminal states only; a failure returns promptly with its error text in the summary.
  await page.waitForSelector('[data-task-status="done"], [data-task-status="failed"], [data-task-status="cancelled"]', { timeout })
  // Results render just after the status flips.
  await page.waitForTimeout(150)
  const panel = await page.textContent('main section')
  return panel.replace(/\s+/g, ' ')
}

/**
 * Picks an option in the Select whose parameter label matches `label`.
 *
 * By label rather than by index: the index shifts whenever a conditional
 * parameter appears or a tool gains a control, which silently retargets the
 * assertion instead of failing loudly.
 */
async function selectOption(page, label, optionText) {
  const trigger = page.locator(`div:has(> div > label:text-is("${label}")) [data-slot=select-trigger]`).first()
  const target = (await trigger.count()) ? trigger : page.locator(`#param-${label}`)
  // The parameter card scrolls internally, so a control further down the list
  // needs bringing into view before it can be clicked.
  await target.scrollIntoViewIfNeeded()
  await target.click()
  await page.locator('[data-slot=select-item]', { hasText: optionText }).first().click()
  await page.waitForTimeout(150)
}

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('main a[href^="#/t/"]', { timeout: 30000 })

  const toolCount = await page.locator('main a[href^="#/t/"]').count()
  check('all built-in toolkits registered', toolCount >= 25, `${toolCount} 个工具`)

  /* ---------------------------------------------------------------- data */
  let summary = await runTool('omnitool.data', 'convert', [`${DIR}sample.yaml`], async (p) => {
    await selectOption(p, 'target', 'JSON')
  })
  check('YAML → JSON', /已转换 1 个文件为 JSON/.test(summary), summary.slice(0, 120))

  summary = await runTool('omnitool.data', 'csv-tools', [`${DIR}sample.csv`], async (p) => {
    await selectOption(p, 'mode', '按整行去重')
  })
  check('CSV dedupe', /已处理 1 个文件/.test(summary), summary.slice(0, 120))

  summary = await runTool('omnitool.data', 'markdown', [`${DIR}sample.md`])
  check('Markdown → HTML', /已转换 1 个 Markdown 文件/.test(summary), summary.slice(0, 120))

  summary = await runTool('omnitool.data', 'encode', [`${DIR}sample.md`])
  check('SHA-256 checksum', /已计算 1 个文件的校验值/.test(summary), summary.slice(0, 120))

  /* ------------------------------------------------ documents: batch 2 */
  summary = await runTool('omnitool.data', 'spreadsheet', [`${DIR}sample.csv`])
  check('spreadsheet: CSV → xlsx', /已生成 1 个 XLSX 文件/.test(summary) && summary.includes('sample.xlsx'), summary.slice(-120))

  summary = await runTool('omnitool.data', 'markdown-pdf', [`${DIR}chapter.md`], null, 120000)
  check('Markdown → PDF with the bundled CJK font', /已生成 1 个 PDF/.test(summary) && summary.includes('chapter.pdf'), summary.slice(-120))

  summary = await runTool('omnitool.data', 'ebook', [`${DIR}chapter.md`])
  check('EPUB from Markdown split by H1', /已生成 2 章的电子书/.test(summary), summary.slice(-120))

  summary = await runTool('omnitool.data', 'email', [`${DIR}mail.eml`])
  check('EML: headers, body and attachment', /已解析 1 封邮件，导出 1 个附件/.test(summary) && summary.includes('mail/attachments/note.txt'), summary.slice(-160))

  summary = await runTool('omnitool.data', 'font', [new URL('../public/vendor/fonts/NotoSansSC-Regular.ttf', import.meta.url).pathname], async (p) => {
    await p.fill('#param-subset', '本地工具箱')
  }, 120000)
  // A 0 B WOFF2 once passed a looser check; require a plausible size.
  const woff2Size = /NotoSansSC-Regular-subset\.woff2([\d.]+) (B|KB)/.exec(summary)
  const woff2Bytes = woff2Size ? Number(woff2Size[1]) * (woff2Size[2] === 'KB' ? 1024 : 1) : 0
  check('font: subset a 10 MB CJK font to WOFF2', /已转换 1 个字体为 WOFF2，保留 \d+ 个字符/.test(summary) && woff2Bytes > 2000 && woff2Bytes < 60000, `${woff2Bytes} bytes`)

  summary = await runTool('omnitool.data', 'chart', [`${DIR}sample.csv`], null, 60000)
  check('chart: SVG + host-rasterised PNG', /已生成柱状图/.test(summary) && summary.includes('sample.png'), summary.slice(-140))

  /* --------------------------------------------------------------- image */
  summary = await runTool('omnitool.image', 'resize', [`${DIR}sample.png`])
  check('image resize', /已调整 1 张图片的尺寸/.test(summary), summary.slice(0, 120))

  summary = await runTool('omnitool.image', 'watermark', [`${DIR}sample.png`])
  check('image watermark', /已为 1 张图片添加水印/.test(summary), summary.slice(0, 120))

  summary = await runTool('omnitool.image', 'split', [`${DIR}sample.png`])
  check('image split 3×3', /已切出 9 个切片/.test(summary), summary.slice(0, 140))

  summary = await runTool('omnitool.image', 'to-pdf', [`${DIR}sample.png`])
  check('images → PDF', /已合成 1 页 PDF/.test(summary), summary.slice(0, 120))

  summary = await runTool('omnitool.image', 'inspect', [`${DIR}sample.png`])
  check('image inspect + palette', /已分析 1 张图片/.test(summary), summary.slice(0, 120))

  /* ------------------------------------------- image: ImageMagick engine */
  // These load the lazy 14 MB magick dependency inside the sandbox worker.
  summary = await runTool('omnitool.image', 'metadata', [`${DIR}anim.gif`], null, 120000)
  const metadata = await page.textContent('main pre')
  check('magick loads lazily in the sandbox and reads all GIF frames', /"frames": 10/.test(metadata ?? ''), summary.slice(0, 120))

  summary = await runTool('omnitool.image', 'animation', [`${DIR}anim.gif`], async (p) => {
    await selectOption(p, 'mode', '拆分为单帧图片')
  }, 120000)
  check('animation: split GIF into frames', /已拆出 10 帧/.test(summary), summary.slice(0, 120))

  summary = await runTool('omnitool.image', 'resize', [`${DIR}anim.gif`], null, 120000)
  check('resize keeps a GIF animated (magick path)', /已调整 1 张图片的尺寸/.test(summary) && /anim-60x40\.gif/.test(summary), summary.slice(0, 160))

  summary = await runTool('omnitool.image', 'convert', [`${DIR}scan.tiff`], null, 120000)
  check('TIFF decodes via magick fallback, encodes via canvas', /1 张图片/.test(summary) && /scan\.webp/.test(summary), summary.slice(0, 160))

  /* ------------------------------------------------------------- archive */
  summary = await runTool('omnitool.archive', 'create', [`${DIR}sample.csv`, `${DIR}sample.md`])
  check('archive: create ZIP', /已打包 2 个文件/.test(summary) && /archive\.zip/.test(summary), summary.slice(0, 160))

  summary = await runTool('omnitool.archive', 'extract', [`${DIR}bundle.zip`])
  check('archive: extract ZIP keeping folders', /已解压 3 个文件/.test(summary) && summary.includes('bundle/docs/图片/说明.md'), summary.slice(0, 200))

  /* ------------------------------------------------ image: batch 2 tools */
  await page.goto(`${BASE}/#/files`, { waitUntil: 'commit' })
  await page.goto(`${BASE}/#/t/omnitool.image/barcode`, { waitUntil: 'commit' })
  await page.waitForSelector('main textarea', { timeout: 30000 })
  await page.fill('main textarea', 'https://example.com/本地')
  await page.locator('main aside button').last().click()
  await page.waitForSelector('[data-task-status="done"], [data-task-status="failed"]', { timeout: 60000 })
  summary = (await page.textContent('main section')).replace(/\s+/g, ' ')
  check('barcode: QR code from typed text', /已生成 1 个二维码/.test(summary), summary.slice(-100))

  summary = await runTool('omnitool.image', 'barcode-read', [`${DIR}qr.png`], null, 120000)
  const decoded = await page.textContent('main pre').catch(() => '')
  check('barcode-read: decodes Chinese QR content', (decoded ?? '').includes('OmniTool 扫码测试'), JSON.stringify(decoded))

  summary = await runTool('omnitool.image', 'vectorize', [`${DIR}object.png`])
  check('vectorize to SVG', /已描摹 1 张图片为 SVG/.test(summary), summary.slice(-120))

  summary = await runTool('omnitool.image', 'svg-render', [`${DIR}sample.svg`], async (p) => {
    await p.fill('#param-widths', '16,128')
  })
  check('SVG rendered on the host at two widths', /已渲染 2 张图片/.test(summary) && summary.includes('sample-128.png'), summary.slice(-120))

  summary = await runTool('omnitool.image', 'histogram', [`${DIR}sample.png`])
  check('histogram chart + stats', /已分析 1 张图片/.test(summary), summary.slice(-120))

  summary = await runTool('omnitool.image', 'find-similar', [`${DIR}object.png`, `${DIR}sample.png`, `${DIR}object-2x.png`])
  check('find-similar groups the resized copy only', /找到 1 组相似图片，可去掉 1 张/.test(summary), summary.slice(-120))

  summary = await runTool('omnitool.image', 'compare', [`${DIR}sample.png`, `${DIR}object.png`])
  check('compare two images', /变化像素 [\d.]+%，SSIM/.test(summary), summary.slice(-120))

  summary = await runTool('omnitool.image', 'sprite', [`${DIR}sample-small.png`, `${DIR}object.png`, `${DIR}qr.png`])
  check('sprite sheet + CSS', /已打包 3 张图片/.test(summary) && summary.includes('sprite.css'), summary.slice(-120))

  summary = await runTool('omnitool.image', 'color-tools', [`${DIR}object.png`])
  check('color replace', /已处理 1 张图片/.test(summary), summary.slice(-100))

  summary = await runTool('omnitool.image', 'meme', [`${DIR}object.png`], async (p) => {
    await p.fill('#param-top', '顶部文字')
    await p.fill('#param-bottom', 'BOTTOM TEXT')
  })
  check('meme captions with the bundled CJK font', /已为 1 张图片加上文字/.test(summary), summary.slice(-100))

  summary = await runTool('omnitool.image', 'watermark', [`${DIR}sample-small.png`, `${DIR}object.png`], async (p) => {
    await selectOption(p, 'mode', '图片 Logo')
  })
  check('image watermark with a logo', /已为 1 张图片添加 Logo 水印/.test(summary), summary.slice(-100))

  summary = await runTool('omnitool.image', 'frame', [`${DIR}object.png`], async (p) => {
    await selectOption(p, 'backdrop', '海洋渐变')
    await selectOption(p, 'chrome', 'macOS 窗口')
  })
  check('screenshot beautify: gradient + window chrome', /已处理 1 张图片/.test(summary), summary.slice(-100))

  /* ----------------------------------------------------------------- pdf */
  summary = await runTool('omnitool.pdf', 'split', [`${DIR}b.pdf`], async (p) => {
    await selectOption(p, 'mode', '每页一个文件')
  })
  check('PDF split per page', /已提取 3 页，生成 3 个文件/.test(summary), summary.slice(0, 140))

  summary = await runTool('omnitool.pdf', 'to-image', [`${DIR}a.pdf`])
  check('PDF → image (pdf.js render)', /已渲染 2 张图片/.test(summary), summary.slice(0, 140))

  summary = await runTool('omnitool.pdf', 'to-text', [`${DIR}a.pdf`])
  check('PDF → text', /已从 1 个 PDF 提取文本/.test(summary), summary.slice(0, 160))

  summary = await runTool('omnitool.pdf', 'nup', [`${DIR}b.pdf`])
  check('PDF 2-up imposition', /已生成 1 个拼版文件/.test(summary), summary.slice(0, 140))

  summary = await runTool('omnitool.pdf', 'watermark', [`${DIR}a.pdf`], async (p) => {
    await p.fill('#param-watermark', 'CONFIDENTIAL')
  })
  check('PDF watermark', /已处理 1 个文件/.test(summary), summary.slice(0, 120))

  /* ------------------------------------------------- pdf: batch 3 tools */
  summary = await runTool('omnitool.pdf', 'remove-blanks', [`${DIR}mixed.pdf`])
  check('PDF remove blank pages (pdf.js render)', /共删除 1 个空白页/.test(summary), summary.slice(0, 140))

  summary = await runTool('omnitool.pdf', 'to-image', [`${DIR}mixed.pdf`])
  check('PDF pages containing images render in the sandbox worker', /已渲染 4 张图片/.test(summary), summary.slice(0, 140))

  summary = await runTool('omnitool.pdf', 'extract-images', [`${DIR}mixed.pdf`])
  check('PDF extract embedded images', /已提取 1 张图片/.test(summary), summary.slice(0, 140))

  summary = await runTool('omnitool.pdf', 'auto-rename', [`${DIR}mixed.pdf`])
  check('PDF auto-rename from largest title', summary.includes('mixed.pdf → Quarterly Report 2026.pdf'), summary.slice(0, 160))

  summary = await runTool('omnitool.pdf', 'compare', [`${DIR}a.pdf`, `${DIR}a-revised.pdf`])
  const report = await page.frameLocator('main iframe[title="HTML 预览"]').locator('.added').first().textContent({ timeout: 10000 }).catch(() => '')
  check('PDF text compare with rendered diff report', /新增 1，删除 1/.test(summary) && report.includes('revised'), `${summary.slice(0, 80)} | ${report}`)

  summary = await runTool('omnitool.pdf', 'sanitize', [`${DIR}a.pdf`])
  check('PDF sanitize', /已处理 1 个 PDF/.test(summary), summary.slice(0, 140))

  summary = await runTool('omnitool.pdf', 'booklet', [`${DIR}b.pdf`])
  check('PDF booklet imposition', /已生成 1 份小册子/.test(summary), summary.slice(0, 140))

  summary = await runTool('omnitool.image', 'scan-split', [`${DIR}scan-bed.png`])
  check('image scan-split finds two tilted photos', /已拆分出 2 张照片/.test(summary), summary.slice(0, 140))

  /* ------------------------------------------ image: pixel algorithms */
  summary = await runTool('omnitool.image', 'seam-carve', [`${DIR}sample.png`])
  check('content-aware resize to 75% width', /已处理 1 张图片/.test(summary) && summary.includes('sample-384x512.png'), summary.slice(0, 160))

  summary = await runTool('omnitool.image', 'denoise', [`${DIR}sample.png`])
  check('guided-filter denoise', /已降噪 1 张图片/.test(summary) && summary.includes('sample-denoised.png'), summary.slice(0, 160))

  /* ------------------------------------------------- pdf: qpdf tools */
  summary = await runTool('omnitool.pdf', 'protect', [`${DIR}a.pdf`], async (p) => {
    await p.fill('#param-userPassword', 'open-sesame')
  })
  check('PDF protect with AES-256 password (qpdf wasm)', /已加密 1 个 PDF（需要密码才能打开）/.test(summary), summary.slice(0, 140))

  summary = await runTool('omnitool.pdf', 'unlock', [`${DIR}locked.pdf`], async (p) => {
    await p.fill('#param-password', 'open-sesame')
  })
  check('PDF unlock with the right password', /已解除 1 个文件的密码与限制/.test(summary), summary.slice(0, 140))

  summary = await runTool('omnitool.pdf', 'unlock', [`${DIR}locked.pdf`], async (p) => {
    await p.fill('#param-password', 'wrong')
  })
  check('PDF unlock reports a wrong password', /密码不正确/.test(summary), summary.slice(0, 140))

  summary = await runTool('omnitool.pdf', 'repair', [`${DIR}broken.pdf`])
  check('PDF repair rebuilds a broken xref', /broken.pdf：已修复.*共 2 页/.test(summary), summary.slice(0, 160))

  summary = await runTool('omnitool.pdf', 'linearize', [`${DIR}mixed.pdf`])
  check('PDF linearize (fast web view)', /已线性化 1 个 PDF/.test(summary), summary.slice(0, 140))

  /* ------------------------------------------------ archive: libarchive */
  summary = await runTool('omnitool.archive', 'extract', [`${DIR}../tests/fixtures/archives/lzma2.7z`])
  check('7z extraction (libarchive wasm)', /已解压 2 个文件/.test(summary), summary.slice(0, 140))

  summary = await runTool('omnitool.archive', 'extract', [`${DIR}../tests/fixtures/archives/v5.rar`])
  check('RAR v5 extraction (libarchive wasm)', /已解压 3 个文件/.test(summary), summary.slice(0, 140))

  /* --------------------------------------------- pdf: placement tools */
  summary = await runTool('omnitool.pdf', 'stamp', [`${DIR}a.pdf`], async (p) => {
    // The page preview is rendered by pdf.js inside the sandbox and shown as an image.
    await p.waitForSelector('main img[src^="blob:"]', { timeout: 30000 })
    const pad = p.locator('main canvas').first()
    await pad.scrollIntoViewIfNeeded()
    const box = await pad.boundingBox()
    await p.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.6)
    await p.mouse.down()
    for (let i = 1; i <= 12; i++) await p.mouse.move(box.x + box.width * (0.2 + i * 0.05), box.y + box.height * (0.6 - Math.sin(i / 2) * 0.2))
    await p.mouse.up()
    await p.waitForSelector('main aside button:has-text("保存 PDF"):not([disabled])')
  })
  check('PDF hand-drawn signature', /已在 1 页上添加签名/.test(summary), summary.slice(0, 140))

  summary = await runTool('omnitool.pdf', 'stamp', [`${DIR}b.pdf`], async (p) => {
    await p.waitForSelector('main img[src^="blob:"]', { timeout: 30000 })
    await p.click('main [data-slot=toggle-group-item]:has-text("文字")')
    await p.fill('#panel-text', '已审核 Approved')
    await p.click('main [data-slot=toggle-group-item]:has-text("全部页")')
  })
  check('PDF Chinese text stamp on all pages', /已在 3 页上添加文字/.test(summary), summary.slice(0, 140))

  summary = await runTool('omnitool.pdf', 'redact', [`${DIR}mixed.pdf`], async (p) => {
    await p.waitForSelector('main img[src^="blob:"]', { timeout: 30000 })
    await p.click('main button:has-text("涂黑选区")')
    await p.waitForSelector('text=1 处，涉及 1 页')
    await p.fill('#panel-terms', 'third')
  })
  check('PDF redact box + keyword', /已涂黑 2 处，涉及 2 页/.test(summary), summary.slice(0, 140))

  summary = await runTool('omnitool.pdf', 'enhance-scan', [`${DIR}mixed.pdf`])
  check('PDF scan enhancement', /已增强 1 个 PDF/.test(summary), summary.slice(0, 140))

  summary = await runTool('omnitool.pdf', 'fill-form', [`${DIR}form.pdf`], async (p) => {
    await p.waitForSelector('#panel-f0', { timeout: 30000 })
    await p.fill('#panel-f0', '张三')
    await p.click('#panel-f1')
  })
  check('PDF form fill with Chinese value', /已填写 2 个字段/.test(summary), summary.slice(0, 140))

  summary = await runTool('omnitool.pdf', 'auto-rotate', [`${DIR}sideways.pdf`])
  check('PDF auto-rotate sideways page', /转正 1 页/.test(summary), summary.slice(0, 140))

  summary = await runTool('omnitool.pdf', 'attachments', [`${DIR}a.pdf`, `${DIR}sample.csv`], async (p) => {
    await selectOption(p, 'mode', '作品集')
  })
  check('PDF portfolio', /作品集/.test(summary), summary.slice(0, 140))

  /* --------------------------------------------------------------- media */
  summary = await runTool('omnitool.media', 'extract-audio', [`${DIR}clip.mp4`], null, 300000)
  check('ffmpeg extract audio → MP3', /已导出 1 个 MP3 音频/.test(summary), summary.slice(0, 160))

  summary = await runTool('omnitool.media', 'convert-video', [`${DIR}clip.mp4`], async (p) => {
    await selectOption(p, 'resolution', '720p')
  }, 300000)
  check('ffmpeg transcode to 720p MP4', /已转码 1 个视频为 MP4/.test(summary), summary.slice(0, 160))

  summary = await runTool('omnitool.media', 'frames', [`${DIR}clip.mp4`], async (p) => {
    // Mark two frames on the timeline: seek by clicking the strip, then mark.
    await p.waitForFunction(() => document.querySelector('main video')?.readyState >= 1)
    const strip = p.locator('main [role=slider][aria-label="播放位置"]')
    await strip.scrollIntoViewIfNeeded()
    const box = await strip.boundingBox()
    for (const fraction of [0.2, 0.7]) {
      // Locator clicks scroll into view first; raw page coordinates can land
      // under the task dock once enough tasks have run.
      await strip.click({ position: { x: box.width * fraction, y: box.height / 2 } })
      await p.waitForTimeout(200)
      await p.click('button:has-text("标记当前帧")')
    }
    await p.waitForSelector('main aside button:has-text("导出 2 帧")')
  }, 300000)
  check('frames: export marked frames', /已导出 2 帧/.test(summary), summary.slice(0, 160))

  summary = await runTool('omnitool.media', 'frames', [`${DIR}clip.mp4`], async (p) => {
    await p.click('main [data-slot=toggle-group-item]:has-text("按间隔")')
    await p.fill('#panel-interval', '1')
  }, 300000)
  check('frames: interval within range', /已导出 [34] 帧/.test(summary), summary.slice(0, 160))

  summary = await runTool('omnitool.media', 'inspect-media', [`${DIR}clip.mp4`], null, 300000)
  check('ffmpeg probe', /已分析 1 个媒体文件/.test(summary), summary.slice(0, 160))

  // Multi-consumer graphs: these are what overflow the pthread pool if the
  // thread budget is wrong, so they get their own checks.
  summary = await runTool('omnitool.media', 'merge', [`${DIR}clip.mp4`, `${DIR}clip2.mp4`], null, 300000)
  check('ffmpeg concat 2 inputs (filter_complex)', /已拼接 2 个片段/.test(summary), summary.slice(0, 160))

  summary = await runTool('omnitool.media', 'merge', [`${DIR}clip.mp4`, `${DIR}silent-small.mp4`], async (p) => {
    // Reorder: move the second clip to the top with its up arrow.
    await p.locator('main li:has-text("silent-small.mp4") button[aria-label="上移"]').click()
    await p.waitForFunction(() => document.querySelector('main ol li')?.textContent.includes('silent-small'), undefined, { timeout: 5000 })
  }, 300000)
  check('concat mixed sizes + missing audio, reordered', /已拼接 2 个片段/.test(summary), summary.slice(0, 160))

  summary = await runTool('omnitool.media', 'merge', [`${DIR}tone.m4a`, `${DIR}tone.m4a`], null, 300000)
  check('concat audio-only inputs', /已拼接 2 个片段/.test(summary), summary.slice(0, 160))

  summary = await runTool('omnitool.media', 'video-edit', [`${DIR}clip.mp4`], async (p) => {
    await p.waitForFunction(() => document.querySelector('main video')?.readyState >= 1)
    await p.click('#panel-cropOn')
    await p.click('main [data-slot=toggle-group-item]:has-text("1:1")')
    await p.click('main [data-slot=toggle-group-item]:has-text("90°")')
    await p.waitForSelector('main dd:has-text("×")')
    const size = await p.locator('main dt:has-text("输出尺寸") + dd').textContent()
    // 320×240 source, largest centred 1:1 box is 240×240, rotation keeps it square.
    if (size.trim() !== '240 × 240') throw new Error(`unexpected output size ${size}`)
  }, 300000)
  check('video-edit: 1:1 crop + rotate', /已处理 1 个视频/.test(summary), summary.slice(0, 160))

  summary = await runTool('omnitool.media', 'audio-edit', [`${DIR}tone.m4a`], async (p) => {
    await p.waitForSelector('main [role=slider][aria-label="播放位置"]')
    await p.waitForFunction(() => document.querySelector('main audio')?.readyState >= 1)
    // The panel's own section (by its heading), not the page section around it.
    await p.locator('main section:has(> h3:text-is("淡入淡出")) [data-slot=slider-thumb]').first().focus()
    for (let i = 0; i < 10; i++) await p.keyboard.press('ArrowRight') // fade in 1.0 s
    // A flat envelope has a zero-height box, so wait for attachment, then check
    // that the curve starts silent and ramps up.
    await p.waitForSelector('main svg polyline', { state: 'attached' })
    await p.waitForFunction(() => {
      const points = document.querySelector('main svg polyline')?.getAttribute('points') ?? ''
      const [first, second] = points.split(' ').map((pair) => pair.split(',').map(Number))
      return first?.[1] === 100 && second?.[1] === 50
    }, undefined, { timeout: 5000 })
  }, 300000)
  check('audio-edit: fade envelope + export', /已处理 1 个音频/.test(summary), summary.slice(0, 160))

  summary = await runTool('omnitool.media', 'to-gif', [`${DIR}clip.mp4`], null, 300000)
  check('ffmpeg GIF with two-pass palette', /已生成 1 个动图/.test(summary), summary.slice(0, 160))

  /* ------------------------------------------------- media: batch 2 */
  summary = await runTool('omnitool.media', 'subtitles', [`${DIR}sub-gbk.srt`], async (p) => {
    await selectOption(p, 'target', 'WebVTT')
  }, 300000)
  check('subtitles: GBK SRT → WebVTT', /已转换 1 个字幕文件/.test(summary) && summary.includes('sub-gbk.vtt'), summary.slice(-140))

  summary = await runTool('omnitool.media', 'subtitles', [`${DIR}clip.mp4`, `${DIR}sub.srt`], async (p) => {
    await selectOption(p, 'mode', '烧录进画面')
  }, 300000)
  check('subtitles: burn Chinese subtitles with the bundled font', /已把字幕烧录进画面/.test(summary), summary.slice(-140))

  summary = await runTool('omnitool.media', 'watermark-video', [`${DIR}clip.mp4`], async (p) => {
    await p.waitForFunction(() => document.querySelector('main video')?.readyState >= 1)
    await p.fill('#panel-text', '水印测试 OmniTool')
  }, 300000)
  check('watermark-video: CJK text watermark', /已为 1 个视频添加水印/.test(summary), summary.slice(-140))

  summary = await runTool('omnitool.media', 'watermark-video', [`${DIR}clip.mp4`, `${DIR}sample.png`], null, 300000)
  check('watermark-video: image logo overlay', /已为 1 个视频添加水印/.test(summary), summary.slice(-140))

  summary = await runTool('omnitool.media', 'video-effects', [`${DIR}clip.mp4`], null, 300000)
  check('video-effects: blurred background to 9:16', /已处理 1 个视频/.test(summary) && summary.includes('clip-9x16.mp4'), summary.slice(-140))

  summary = await runTool('omnitool.media', 'video-effects', [`${DIR}clip.mp4`], async (p) => {
    await selectOption(p, 'effect', '倒放')
  }, 300000)
  check('video-effects: reverse', /已处理 1 个视频/.test(summary), summary.slice(-140))

  summary = await runTool('omnitool.media', 'audio-split', [`${DIR}tone.m4a`], async (p) => {
    await p.click('main [data-slot=toggle-group-item]:has-text("按时长均分")')
    await p.fill('#panel-length', '1')
  }, 300000)
  check('audio-split: equal 1 s segments', /已分割为 4 段/.test(summary), summary.slice(-140))

  summary = await runTool('omnitool.media', 'audio-split', [`${DIR}tone.m4a`], async (p) => {
    await p.click('main [data-slot=toggle-group-item]:has-text("制作铃声")')
    await p.waitForFunction(() => document.querySelector('main audio')?.readyState >= 1)
  }, 300000)
  check('audio-split: iPhone ringtone', /iPhone 铃声/.test(summary) && summary.includes('tone.m4r'), summary.slice(-140))

  summary = await runTool('omnitool.media', 'waveform', [`${DIR}tone.m4a`], null, 300000)
  check('waveform image', /已生成 1 张图/.test(summary), summary.slice(-120))

  // A video without an audio track: a readable explanation, not FFmpeg's "matches no streams".
  summary = await runTool('omnitool.media', 'waveform', [`${DIR}silent-small.mp4`], async (p) => {
    await selectOption(p, 'kind', '声谱图')
  }, 300000)
  check('spectrogram of a video without audio explains itself', /silent-small.mp4 没有音轨（只有画面），无法绘制声谱图/.test(summary) && !/matches no streams/.test(summary), summary.slice(-140))

  summary = await runTool('omnitool.media', 'images-to-video', [`${DIR}sample.png`, `${DIR}object.png`, `${DIR}tone.m4a`], null, 300000)
  check('images-to-video: slideshow with music', /已生成 00:06.00 的视频/.test(summary), summary.slice(-140))

  summary = await runTool('omnitool.media', 'images-to-video', [`${DIR}anim.gif`], async (p) => {
    await p.click('main [data-slot=toggle-group-item]:has-text("APNG")')
  }, 300000)
  check('images-to-video: GIF → APNG', /已转换为 APNG/.test(summary), summary.slice(-140))

  /* ------------------------------------------------------------ hygiene */
  const unexpected = errors.filter((t) => !/Failed to load resource|ERR_|net::|favicon/.test(t))
  check('no unexpected console errors', unexpected.length === 0, unexpected.slice(0, 2).join(' // '))
} catch (error) {
  check('test run completed', false, error.message.split('\n')[0])
  await page.screenshot({ path: `${DIR}tools-failure.png`, fullPage: true }).catch(() => {})
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
