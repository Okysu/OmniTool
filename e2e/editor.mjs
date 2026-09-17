import { chromium } from 'playwright'
const DIR = new URL('./', import.meta.url).pathname
const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`) }
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', e => errors.push(e.message))

try {
  await page.goto(`${BASE}/#/plugins`, { waitUntil: 'commit' })
  await page.waitForSelector('text=创建新插件', { timeout: 30000 })
  const tiles = page.locator('section button.aspect-square')
  const boxes = await Promise.all([0, 1].map(i => tiles.nth(i).boundingBox()))
  check('two square entry tiles', boxes.every(b => b && Math.abs(b.width - b.height) < 2), boxes.map(b => `${b.width}x${b.height}`).join(' '))

  await page.click('text=创建新插件')
  await page.waitForSelector('.monaco-editor', { timeout: 60000 })
  check('Monaco editor loads', true)

  // Start from the panel template.
  await page.click('button:has-text("模板")')
  await page.click('[role=menuitem]:has-text("自定义界面")')
  await page.waitForTimeout(500)

  // Completion: type `host.fs.` at the end of the file.
  await page.click('.monaco-editor .view-lines')
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('host.fs.')
  await page.waitForSelector('.monaco-editor .suggest-widget.visible', { timeout: 20000 })
  const suggestions = await page.locator('.monaco-editor .suggest-widget .monaco-list-row').allTextContents()
  check('host.fs. completions from Plugin API types', ['readAll', 'writeAll', 'digest'].every(n => suggestions.some(s => s.includes(n))), suggestions.slice(0, 6).join(', '))
  await page.keyboard.press('Escape')
  // Remove the probe line again.
  await page.keyboard.press('Home'); await page.keyboard.press('Shift+End'); await page.keyboard.press('Delete'); await page.keyboard.press('Backspace')

  // Live validation panel.
  await page.waitForSelector('aside >> text=example.image-annotate', { timeout: 30000 })
  const aside = (await page.textContent('main aside')).replace(/\s+/g, ' ')
  check('live manifest shows tool with 界面 badge', aside.includes('矩形标注') && aside.includes('界面'), aside.slice(0, 90))

  // Save & install.
  await page.click('button:has-text("保存并安装")')
  await page.waitForSelector('text=安装并授权', { timeout: 30000 })
  await page.click('button:has-text("安装并授权")')
  await page.waitForURL(/#\/t\/example\.image-annotate\/annotate/, { timeout: 30000 })
  check('install navigates to the new tool', true)

  // The installed panel tool: canvas + pointer interaction.
  await page.waitForSelector('text=先拖入一张图片', { timeout: 30000 })
  await page.setInputFiles('input[type=file]', DIR + 'sample.png')
  const canvas = page.locator('main canvas').first()
  await canvas.waitFor({ timeout: 30000 })
  await page.waitForTimeout(1500)
  const box = await canvas.boundingBox()
  // Drag a rectangle across the stage.
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.3)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.6, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(600)
  await canvas.screenshot({ path: DIR + '10-annotate-canvas.png' })
  check('interactive canvas accepted a drag (see screenshot)', true)

  await page.click('button:has-text("导出标注图")')
  await page.waitForFunction(() => (document.querySelector('main')?.textContent ?? '').includes('处理结果'), undefined, { timeout: 60000 })
  const summary = (await page.textContent('main')).replace(/\s+/g, ' ')
  check('panel state (box) reached run() and exported', summary.includes('已导出标注图'))

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '))
} catch (e) {
  check('editor test completed', false, e.message.split('\n')[0])
  await page.screenshot({ path: DIR + 'editor-failure.png' })
} finally { await browser.close() }
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
// Non-zero exit so e2e/run.mjs fails the whole run.
process.exit(results.every(Boolean) ? 0 : 1)
