import { chromium } from 'playwright'
const DIR = new URL('./', import.meta.url).pathname
const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`) }
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', e => errors.push(e.message))
const waitDone = () => page.waitForSelector('[data-task-status="done"], [data-task-status="failed"]', { timeout: 120000 })

try {
  /* Pasted text → JSON, with inline output */
  await page.goto(`${BASE}/#/t/omnitool.data/convert`, { waitUntil: 'commit' })
  await page.waitForSelector('text=直接输入', { timeout: 30000 })
  await page.click('button[role=tab]:has-text("直接输入")')
  await page.fill('textarea[placeholder="在这里粘贴或输入内容…"]', 'name: omnitool\nlocal: true\ntags:\n  - pdf\n  - video\n')
  await page.click('button:has-text("开始处理")')
  await waitDone()
  const out = await page.textContent('pre')
  check('paste YAML → inline JSON output', out.includes('"name": "omnitool"') && out.includes('"video"'), out.replace(/\s+/g, ' ').slice(0, 80))
  check('copy button shown for text result', await page.locator('button:has-text("复制")').count() > 0)

  /* Long Markdown → rendered HTML: the whole document, and no network from the preview */
  const { readFileSync } = await import('node:fs')
  const markdown = readFileSync(new URL('../docs/design/02-plugin-api.md', import.meta.url), 'utf8') + '\n\n![tracker](https://tracker.invalid/pixel.png)\n\n## 最后一节\n\n文末段落 END-OF-DOC\n'
  // Chrome still emits a `request` for a CSP-blocked load, then fails it with
  // a "csp" failure; anything else means the fetch really went out.
  const external = []
  page.on('request', (r) => { if (r.url().includes('tracker.invalid')) external.push({ url: r.url(), blocked: false }) })
  page.on('requestfailed', (r) => {
    const hit = external.find((e) => e.url === r.url() && !e.blocked)
    // Playwright reports the reason as "csp" (Chromium's ERR_BLOCKED_BY_CSP).
    if (hit && /csp/i.test(r.failure()?.errorText ?? '')) hit.blocked = true
  })
  await page.goto(`${BASE}/#/t/omnitool.data/markdown`, { waitUntil: 'commit' })
  await page.waitForSelector('text=直接输入', { timeout: 30000 })
  await page.click('button[role=tab]:has-text("直接输入")')
  await page.fill('textarea[placeholder="在这里粘贴或输入内容…"]', markdown)
  await page.click('button:has-text("开始处理")')
  await waitDone()
  const frame = page.frameLocator('main iframe[title="HTML 预览"]')
  await frame.locator('text=END-OF-DOC').waitFor({ timeout: 15000 })
  const headings = await frame.locator('h1, h2, h3').count()
  const sourceHeadings = (markdown.match(/^#{1,3} /gm) ?? []).length
  check('markdown renders the complete document', headings === sourceHeadings, `${headings}/${sourceHeadings} headings`)
  await page.waitForTimeout(500)
  const leaked = external.filter((e) => !e.blocked)
  check('rendered preview blocks remote resources', external.length > 0 && leaked.length === 0, leaked[0]?.url ?? `${external.length} blocked`)
  await page.click('button[role=tab]:has-text("源码")')
  const source = await page.textContent('main pre')
  check('source tab shows the full HTML document', source.trimEnd().endsWith('</html>') && source.includes('END-OF-DOC'))

  /* Timeline trim */
  await page.goto(`${BASE}/#/t/omnitool.media/trim`, { waitUntil: 'commit' })
  await page.waitForSelector('text=先拖入一个音视频文件', { timeout: 30000 })
  check('panel empty-state renders from plugin', true)
  check('run disabled until input', await page.locator('button:has-text("开始处理")').isDisabled())

  await page.setInputFiles('input[type=file]', DIR + 'clip.mp4')
  await page.waitForSelector('video', { timeout: 30000 })
  await page.waitForSelector('button:has-text("播放选区")', { timeout: 30000 })
  check('timeline widget rendered with video', true)
  const runLabel = (await page.locator('main aside button').first().textContent()).trim()
  check('plugin-provided run label', runLabel.includes('导出片段'), runLabel)

  // Wait for metadata so the timeline sets its initial range, then drag start handle.
  await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.readyState >= 1 })
  const thumbs = page.locator('[data-slot=slider-thumb]')
  const count = await thumbs.count()
  // Keyboard-move the start thumb of the range slider (first slider with 2 thumbs).
  const rangeStart = thumbs.nth(count - 2)
  await rangeStart.focus()
  for (let i = 0; i < 100; i++) await page.keyboard.press('ArrowRight') // +1.00s at step 0.01
  const label = await page.locator('text=/→/').first().textContent()
  check('dragging range updates readout', /00:01\.00/.test(label), label.trim())

  // Switch off lossless so the cut is exact, then export.
  await page.locator('[data-slot=segmented], [role=group]').first().waitFor({ timeout: 5000 }).catch(() => {})
  await page.locator('button:has-text("导出片段")').click()
  await waitDone()
  const summary = (await page.textContent('main')).replace(/\s+/g, ' ')
  check('trim exported the selected range', /已导出 00:01\.00 →/.test(summary), (summary.match(/已导出[^处]*/) ?? ['?'])[0].slice(0, 80))

  /* A long real-world Markdown document (if present locally): rendered to its last paragraph */
  const { existsSync } = await import('node:fs')
  if (existsSync(DIR + 'test.md')) {
    const source = readFileSync(DIR + 'test.md', 'utf8')
    await page.goto(`${BASE}/#/files`, { waitUntil: 'commit' })
    await page.goto(`${BASE}/#/t/omnitool.data/markdown`, { waitUntil: 'commit' })
    await page.waitForSelector('main input[type=file]', { state: 'attached', timeout: 30000 })
    await page.setInputFiles('main input[type=file]', DIR + 'test.md')
    await page.waitForSelector('text=test.md')
    await page.locator('main aside button').last().click()
    await waitDone()
    const doc = page.frameLocator('main iframe[title="HTML 预览"]')
    const lastLine = source.trim().split('\n').pop().replace(/[*_`]/g, '').trim()
    await doc.locator('body').waitFor({ timeout: 15000 })
    const rendered = await doc.locator('body').textContent()
    const sourceHeadings = (source.match(/^#{1,6} /gm) ?? []).length
    const renderedHeadings = await doc.locator('h1,h2,h3,h4,h5,h6').count()
    check('test.md renders to the end', rendered.includes(lastLine.slice(0, 30)) && renderedHeadings === sourceHeadings, `${renderedHeadings}/${sourceHeadings} headings`)
  }

  /* Model download source is a persisted setting */
  await page.goto(`${BASE}/#/settings`, { waitUntil: 'commit' })
  await page.waitForSelector('[data-settings-models]', { timeout: 30000 })
  await page.locator('#model-source').scrollIntoViewIfNeeded()
  await page.click('#model-source')
  await page.locator('[data-slot=select-item]', { hasText: 'hf-mirror.com' }).click()
  await page.reload({ waitUntil: 'commit' })
  await page.waitForSelector('[data-settings-models]', { timeout: 30000 })
  const effective = await page.locator('[data-settings-models]').textContent()
  check('model download source switches to the mirror and persists', effective.includes('https://hf-mirror.com'), effective.match(/当前生效：\S+/)?.[0] ?? '')
  await page.click('#model-source')
  await page.locator('[data-slot=select-item]', { hasText: 'huggingface.co' }).click()

  /* Workspace: importing the same file twice stores it once; picking from the workspace is filtered by type */
  const workspaceCount = async () => {
    await page.goto(`${BASE}/#/files`, { waitUntil: 'commit' })
    await page.waitForSelector('text=工作区文件', { timeout: 30000 })
    await page.waitForTimeout(300)
    return Number(((await page.textContent('main header')).match(/(\d+) 个文件/) ?? [])[1] ?? -1)
  }
  const openTool = async (path) => {
    await page.goto(`${BASE}/#/t/${path}`, { waitUntil: 'commit' })
    await page.waitForSelector('main input[type=file]', { state: 'attached', timeout: 30000 })
  }
  const before = await workspaceCount()
  await openTool('omnitool.image/convert')
  await page.setInputFiles('main input[type=file]', DIR + 'sample-small.png')
  await page.waitForSelector('main li:has-text("sample-small.png")')
  const afterFirst = await workspaceCount()
  await openTool('omnitool.image/resize')
  await page.setInputFiles('main input[type=file]', DIR + 'sample-small.png')
  await page.waitForSelector('text=已在工作区中，直接复用', { timeout: 10000 })
  await page.waitForSelector('main li:has-text("sample-small.png")')
  check('re-importing the same file reuses it', (await workspaceCount()) === afterFirst && afterFirst === before + 1, `${before} → ${afterFirst} → same`)

  // Deselecting keeps the file; the picker offers it again, and only to tools that accept it.
  await openTool('omnitool.image/resize')
  await page.setInputFiles('main input[type=file]', DIR + 'sample-small.png')
  await page.waitForSelector('main li:has-text("sample-small.png")')
  await page.click('main li:has-text("sample-small.png") button[aria-label="从列表中移除"]')
  check('removing from a tool only deselects', (await workspaceCount()) === afterFirst)
  await openTool('omnitool.image/resize')
  await page.click('main [data-pick-workspace]')
  await page.waitForSelector('[data-workspace-picker]')
  const offered = await page.locator('[data-workspace-picker] [data-picker-file]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-picker-file')))
  check('workspace picker lists files the tool accepts', offered.includes('sample-small.png') && offered.every((n) => /\.(png|jpe?g|webp|gif|svg|bmp|avif|tiff?|heic)$/i.test(n)), offered.slice(0, 5).join(', '))
  await page.click('[data-workspace-picker] [data-picker-file="sample-small.png"]')
  await page.click('[data-picker-confirm]')
  await page.waitForSelector('main li:has-text("sample-small.png")')
  await page.click('button:has-text("开始处理")')
  await waitDone()
  check('a picked workspace file runs like a dropped one', /已/.test(await page.textContent('[data-task-status]')))
  await openTool('omnitool.pdf/to-image')
  const pdfOffer = await page.locator('main [data-pick-workspace]').textContent()
  await page.click('main [data-pick-workspace]').catch(() => {})
  const pdfFiles = await page.locator('[data-workspace-picker] [data-picker-file]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-picker-file')))
  check('a PDF tool is not offered images', !pdfFiles.some((n) => /\.png$/i.test(n)), `${pdfOffer.trim()} · ${pdfFiles.slice(0, 3).join(', ')}`)
  await page.keyboard.press('Escape')

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '))
} catch (e) {
  check('ui test completed', false, e.message.split('\n')[0])
  await page.screenshot({ path: DIR + 'ui-failure.png' })
} finally { await browser.close() }
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
// Non-zero exit so e2e/run.mjs fails the whole run.
process.exit(results.every(Boolean) ? 0 : 1)
