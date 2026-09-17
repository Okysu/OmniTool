/**
 * Pipelines end to end: a template run, persistence across reloads, and a
 * pipeline assembled from a tool page plus the step picker.
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

try {
  await page.goto(`${BASE}/#/flows`, { waitUntil: 'commit' })
  await page.waitForSelector('[data-template="pdf-to-webp"]', { timeout: 30000 })
  await page.click('[data-template="pdf-to-webp"]')
  await page.waitForURL(/#\/flows\/[\w-]+$/)
  check('template creates a two-step pipeline', (await page.locator('[data-pipeline-step]').count()) === 2)

  await page.setInputFiles('main input[type=file]:not([accept=".json,application/json"])', [`${DIR}a.pdf`])
  await page.waitForSelector('text=a.pdf')
  await page.click('[data-pipeline-run]')
  await waitRun()
  let status = await page.getAttribute('[data-pipeline-status]', 'data-pipeline-status')
  let text = (await page.textContent('[data-pipeline-status]')).replace(/\s+/g, ' ')
  check('PDF → images → WebP runs through both steps', status === 'done' && /完成，共得到 2 个文件/.test(text), text.slice(0, 160))
  const names = (await page.textContent('main')).match(/[\w-]+\.webp/g) ?? []
  check('final outputs are WebP', names.length >= 2, names.slice(0, 3).join(', '))

  await page.reload({ waitUntil: 'commit' })
  await page.waitForSelector('text=我的工作流', { timeout: 30000 })
  check('pipelines persist across reloads', (await page.locator('aside button:has-text("PDF 逐页转 WebP 图片")').count()) >= 1)

  // From a tool page, with its current parameters, then one more step from the picker.
  await page.goto(`${BASE}/#/t/omnitool.image/resize`, { waitUntil: 'commit' })
  await page.waitForSelector('main input[type=file]', { state: 'attached', timeout: 30000 })
  await page.click('button[aria-label="加入工作流"]')
  await page.click('[role=menuitem]:has-text("新建工作流")')
  await page.waitForURL(/#\/flows\/[\w-]+$/)
  await page.click('button:has-text("添加步骤")')
  // Panel tools (a signature pad, a crop box) need interaction a pipeline cannot give.
  await page.fill('[role=dialog] input', '签名')
  await page.waitForTimeout(200)
  check('picker hides panel tools', (await page.locator('[role=dialog] [data-tool-key="omnitool.pdf/stamp"]').count()) === 0)
  await page.fill('[role=dialog] input', 'webp')
  await page.click('[role=dialog] [data-tool-key="omnitool.image/convert"]')
  check('tool page + picker build a pipeline', (await page.locator('[data-pipeline-step]').count()) === 2)

  await page.setInputFiles('main input[type=file]:not([accept=".json,application/json"])', [`${DIR}sample.png`])
  await page.waitForSelector('text=sample.png')
  await page.click('[data-pipeline-run]')
  await waitRun()
  status = await page.getAttribute('[data-pipeline-status]', 'data-pipeline-status')
  text = (await page.textContent('[data-pipeline-status]')).replace(/\s+/g, ' ')
  check('resize → convert pipeline completes', status === 'done' && /共得到 1 个文件/.test(text), text.slice(0, 160))

  // The same pipeline as a flowchart: one node per step, insert through a connector, back to the list.
  await page.click('[data-pipeline-view="flow"]')
  await page.waitForSelector('[data-pipeline-flow]')
  check('flowchart view shows a node per step', (await page.locator('[data-flow-node]').count()) === 2)
  await page.locator('[data-flow-insert]').nth(1).click()
  await page.fill('[role=dialog] input', '旋转')
  await page.locator('[role=dialog] [data-tool-key="omnitool.image/transform"]').click()
  await page.waitForTimeout(300)
  const order = await page.locator('[data-flow-node] p.text-sm').allTextContents()
  check('connector + inserts a step at that point', order.length === 3 && order[1].includes('旋转'), order.join(' → '))
  await page.locator('[data-flow-node]').nth(1).click()
  await page.click('[data-flow-inspector] button:has-text("删除")')
  check('inspector removes the selected step', (await page.locator('[data-flow-node]').count()) === 2)
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
