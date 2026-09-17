/**
 * Pipelines end to end: creating from a template through the 新建 dialog, the
 * full-screen editor, a pinned workflow used like a tool from the sidebar,
 * persistence across reloads, a pipeline assembled from a tool page plus the
 * step picker, and the flowchart (insert, remove, drag a node, auto-arrange).
 */
import { chromium } from 'playwright'

const DIR = new URL('./', import.meta.url).pathname
const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
const waitRun = () => page.waitForSelector('[data-pipeline-status="done"], [data-pipeline-status="failed"], [data-pipeline-status="cancelled"]', { timeout: 180000 })
const dropInput = '[data-pipeline-run-column] input[type=file], [data-pipeline-run-page] input[type=file]'

try {
  /* Library → 新建 dialog → template → editor. */
  await page.goto(`${BASE}/#/flows`, { waitUntil: 'commit' })
  await page.waitForSelector('[data-pipeline-new]', { timeout: 30000 })
  check('library shows no templates until 新建', (await page.locator('[data-template]').count()) === 0)
  await page.click('[data-pipeline-new]')
  await page.waitForSelector('[role=dialog] [data-template="pdf-to-webp"]', { timeout: 30000 })
  await page.click('[data-template="pdf-to-webp"]')
  check('picking a template fills the name', (await page.inputValue('#new-pipeline-name')) === 'PDF 逐页转 WebP 图片')
  await page.fill('#new-pipeline-name', '我的 PDF 转图')
  await page.click('[data-pipeline-create]')
  await page.waitForURL(/#\/flows\/[\w-]+\/edit$/)
  await page.waitForSelector('[data-pipeline-editor]')
  const flowId = page.url().match(/flows\/([\w-]+)\/edit/)[1]
  check('editor is full-screen without the app sidebar', (await page.locator('aside nav, [data-sidebar]').count()) === 0 && (await page.locator('header >> text=OmniTool').count()) === 0)
  check('template creates a two-step pipeline with the typed name', (await page.inputValue('#pipeline-name')) === '我的 PDF 转图')
  await page.click('[data-pipeline-view="list"]')
  check('list view shows both steps', (await page.locator('[data-pipeline-step]').count()) === 2)

  await page.setInputFiles(dropInput, [`${DIR}a.pdf`])
  await page.waitForSelector('text=a.pdf')
  await page.click('[data-pipeline-run]')
  await waitRun()
  let status = await page.getAttribute('[data-pipeline-status]', 'data-pipeline-status')
  let text = (await page.textContent('[data-pipeline-status]')).replace(/\s+/g, ' ')
  check('PDF → images → WebP runs through both steps', status === 'done' && /完成，共得到 2 个文件/.test(text), text.slice(0, 160))
  const names = (await page.textContent('[data-pipeline-run-column]')).match(/[\w-]+\.webp/g) ?? []
  check('final outputs are WebP', names.length >= 2, names.slice(0, 3).join(', '))

  /* Pin it, then use it from the sidebar like a tool. */
  await page.click('[data-pipeline-pin]')
  await page.click('[data-pipeline-back]')
  await page.waitForSelector('[data-pipeline-card]')
  const pinned = page.locator(`[data-pinned="flow:${flowId}"]`)
  await pinned.waitFor({ timeout: 10000 })
  check('pinned workflow appears in the sidebar', (await pinned.textContent()).includes('我的 PDF 转图'))

  await page.reload({ waitUntil: 'commit' })
  await page.waitForSelector('[data-pipeline-card]', { timeout: 30000 })
  check('pipelines and pins persist across reloads', (await page.locator('[data-pipeline-card]:has-text("我的 PDF 转图")').count()) === 1 && (await pinned.count()) === 1)

  await pinned.click()
  await page.waitForURL(new RegExp(`#/flows/${flowId}$`))
  await page.waitForSelector('[data-pipeline-run-page]', { timeout: 30000 })
  const header = (await page.textContent('[data-pipeline-run-page] header')).replace(/\s+/g, ' ')
  check('run page describes the chain', header.includes('PDF 转图片') || header.includes('→'), header.slice(0, 120))
  await page.setInputFiles(dropInput, [`${DIR}a.pdf`])
  await page.waitForSelector('text=a.pdf')
  await page.click('[data-pipeline-run]')
  await waitRun()
  text = (await page.textContent('[data-pipeline-status]')).replace(/\s+/g, ' ')
  check('pinned workflow runs from its own page', /完成，共得到 2 个文件/.test(text), text.slice(0, 120))

  /* From a tool page, with its current parameters, then one more step from the picker. */
  await page.goto(`${BASE}/#/t/omnitool.image/resize`, { waitUntil: 'commit' })
  await page.waitForSelector('main input[type=file]', { state: 'attached', timeout: 30000 })
  await page.click('button[aria-label="加入工作流"]')
  await page.click('[role=menuitem]:has-text("新建工作流")')
  await page.waitForURL(/#\/flows\/[\w-]+\/edit$/)
  await page.click('[data-pipeline-view="list"]')
  await page.click('button:has-text("添加步骤")')
  // Panel tools (a signature pad, a crop box) need interaction a pipeline cannot give.
  await page.fill('[role=dialog] input', '签名')
  await page.waitForTimeout(200)
  check('picker hides panel tools', (await page.locator('[role=dialog] [data-tool-key="omnitool.pdf/stamp"]').count()) === 0)
  await page.fill('[role=dialog] input', 'webp')
  await page.click('[role=dialog] [data-tool-key="omnitool.image/convert"]')
  check('tool page + picker build a pipeline', (await page.locator('[data-pipeline-step]').count()) === 2)

  await page.setInputFiles(dropInput, [`${DIR}sample.png`])
  await page.waitForSelector('text=sample.png')
  await page.click('[data-pipeline-run]')
  await waitRun()
  status = await page.getAttribute('[data-pipeline-status]', 'data-pipeline-status')
  text = (await page.textContent('[data-pipeline-status]')).replace(/\s+/g, ' ')
  check('resize → convert pipeline completes', status === 'done' && /共得到 1 个文件/.test(text), text.slice(0, 160))

  /* The same pipeline as a flowchart. */
  await page.click('[data-pipeline-view="flow"]')
  await page.waitForSelector('[data-pipeline-flow]')
  check('flowchart view shows a node per step', (await page.locator('[data-flow-node]').count()) === 2)
  const canvasBox = await page.locator('[data-pipeline-flow]').boundingBox()
  check('flowchart fills the editor height', canvasBox.height > 700, `${Math.round(canvasBox.height)}px`)
  await page.locator('[data-flow-insert]').nth(1).click()
  await page.fill('[role=dialog] input', '旋转')
  await page.locator('[role=dialog] [data-tool-key="omnitool.image/transform"]').click()
  await page.waitForTimeout(300)
  const order = await page.locator('[data-flow-node] p.text-sm').allTextContents()
  check('connector + inserts a step at that point', order.length === 3 && order[1].includes('旋转'), order.join(' → '))
  await page.locator('[data-flow-node]').nth(1).click()
  await page.click('[data-flow-inspector] button:has-text("删除")')
  check('inspector removes the selected step', (await page.locator('[data-flow-node]').count()) === 2)

  // Drag the second node down and to the left; it stays there after a reload.
  const node = page.locator('[data-flow-node]').nth(1)
  const before = await node.boundingBox()
  await page.mouse.move(before.x + 40, before.y + 20)
  await page.mouse.down()
  await page.mouse.move(before.x - 60, before.y + 120, { steps: 8 })
  await page.mouse.move(before.x - 160, before.y + 240, { steps: 8 })
  await page.mouse.up()
  const after = await node.boundingBox()
  check('dragging moves a node anywhere, including up and down', after.y - before.y > 150 && before.x - after.x > 100, `Δx ${Math.round(after.x - before.x)} Δy ${Math.round(after.y - before.y)}`)
  await page.reload({ waitUntil: 'commit' })
  await page.waitForSelector('[data-flow-node]', { timeout: 30000 })
  await page.waitForTimeout(300)
  const nodes = page.locator('[data-flow-node]')
  const [first, second] = [await nodes.nth(0).boundingBox(), await nodes.nth(1).boundingBox()]
  check('dragged position is saved with the pipeline', second.y - first.y > 150, `Δy ${Math.round(second.y - first.y)}`)
  await page.click('[data-flow-auto-arrange]')
  await page.waitForTimeout(300)
  const [a1, a2] = [await nodes.nth(0).boundingBox(), await nodes.nth(1).boundingBox()]
  check('auto-arrange puts nodes back in one row', Math.abs(a2.y - a1.y) < 2 && a2.x > a1.x, `Δy ${Math.round(a2.y - a1.y)}`)

  await page.click('[data-pipeline-view="list"]')
  check('list view is unchanged', (await page.locator('[data-pipeline-step]').count()) === 2)

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '))
} catch (error) {
  check('flows test completed', false, error.message.split('\n')[0])
  await page.screenshot({ path: `${DIR}flows-failure.png` })
} finally {
  await browser.close()
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
