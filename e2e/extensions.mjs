/**
 * The repository's subscribable extensions, exercised the way a user gets
 * them: subscribe to the index over HTTP, review and grant, store the API key
 * in the host dialog, then run tools against a fake OpenAI-compatible server.
 *
 * What this proves beyond the unit tests: the plugin evaluates in the real
 * sandbox, `/vendor` dependencies resolve for a subscribed plugin, the key
 * leaves the host only for the approved origin, local endpoints are blocked
 * until the user allows them, and batch requests do not spam toasts.
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'

const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const ROOT = new URL('../', import.meta.url).pathname
const DIR = new URL('./', import.meta.url).pathname
const PORT = 4179
const API = `http://localhost:${PORT}/v1`
const KEY = 'sk-e2e-secret'

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ------------------------- fake extension host + API ------------------------ */

const seen = []
const server = createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end()
  const url = new URL(req.url, `http://localhost:${PORT}`)
  if (req.method === 'GET' && url.pathname.startsWith('/extensions/')) {
    const file = normalize(join(ROOT, url.pathname))
    if (!file.startsWith(join(ROOT, 'extensions'))) return res.writeHead(403, cors).end()
    try {
      return res.writeHead(200, { ...cors, 'Content-Type': file.endsWith('.json') ? 'application/json' : 'text/javascript' }).end(readFileSync(file))
    } catch {
      return res.writeHead(404, cors).end()
    }
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = Buffer.concat(chunks).toString('utf8')
  seen.push({ path: url.pathname, authorization: req.headers.authorization ?? null })
  if (req.headers.authorization !== `Bearer ${KEY}`) {
    return res.writeHead(401, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'bad key' } }))
  }
  if (url.pathname === '/v1/chat/completions') {
    const payload = JSON.parse(body)
    const last = payload.messages.at(-1).content
    let content
    if (Array.isArray(last)) {
      content = JSON.stringify({ objects: [{ label: 'logo', box: [100, 100, 600, 900] }] })
    } else if (last.includes('Reply with exactly: OK')) {
      content = 'OK'
    } else if (last.includes('Return {"answers"')) {
      const count = (last.match(/^Task \d+:/gm) ?? []).length
      content = JSON.stringify({ answers: Array.from({ length: count }, (_, i) => `答案${i + 1}`) })
    } else {
      content = last.split('\n\n').map((para) => (para.startsWith('```') ? para : `【译】${para}`)).join('\n\n')
    }
    return res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
  }
  res.writeHead(404, cors).end()
})
await new Promise((resolve) => server.listen(PORT, resolve))

const work = mkdtempSync(join(tmpdir(), 'omnitool-ext-'))
writeFileSync(join(work, 'people.csv'), 'name,city\nAda,London\nGrace,New York\n')
writeFileSync(join(work, 'notes.md'), [1, 2, 3, 4, 5, 6].map((n) => `Paragraph ${n}. ${'word '.repeat(120)}`).join('\n\n') + '\n\n```\ncode stays\n```\n')

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))

async function openTool(toolId) {
  await page.goto(`${BASE}/#/files`, { waitUntil: 'commit' })
  await page.waitForTimeout(300)
  await page.goto(`${BASE}/#/t/omnitool.ext.ai/${toolId}`, { waitUntil: 'commit' })
}

async function runAndWait(timeout = 60000) {
  const start = page.locator('main aside button').last()
  await start.scrollIntoViewIfNeeded()
  await start.click()
  await page.waitForSelector('[data-task-status="done"], [data-task-status="failed"]', { timeout })
  await page.waitForTimeout(200)
  return (await page.textContent('main section')).replace(/\s+/g, ' ')
}

try {
  /* Subscribe and install. */
  await page.goto(`${BASE}/#/plugins`, { waitUntil: 'commit' })
  await page.waitForSelector('text=远程订阅', { timeout: 30000 })
  await page.fill('input[placeholder^="https://example.com/my-tools.json"]', `http://localhost:${PORT}/extensions/index.json`)
  await page.click('button:has-text("添加")')
  await page.waitForSelector('text=安装并授权', { timeout: 30000 })
  const review = (await page.textContent('[role=dialog]')).replace(/\s+/g, ' ')
  check('review lists the extension and its network access', review.includes('AI 扩展工具箱') && review.includes('外网请求'), review.slice(0, 120))
  check('host proxy calls are not reported as blocked raw fetches', !review.includes('直接网络调用'))
  // Medium-risk `secret` is never pre-ticked: the user opts in, as a real user would.
  const secretRow = page.locator('[role=dialog] li:has(code:text-is("secret"))')
  const secretSwitch = secretRow.locator('button[role=switch]')
  check('credential capability starts unticked', (await secretSwitch.getAttribute('aria-checked')) === 'false')
  await secretSwitch.click()
  await page.click('button:has-text("安装并授权")')
  await page.waitForSelector('text=1 个插件', { timeout: 30000 })
  check('subscription installs one plugin', true)

  /* Configure the connection against a local endpoint. */
  await openTool('settings')
  await page.waitForSelector('#panel-baseUrl', { timeout: 30000 })
  await page.fill('#panel-baseUrl', API)
  await page.fill('#panel-chatModel', 'fake-chat')
  await page.fill('#panel-visionModel', 'fake-vl')
  await page.waitForTimeout(300)

  // Running asks for the key first (auth is on for the OpenAI preset) - the
  // dialog the host draws, bound to the endpoint's origin.
  const start = page.locator('main aside button').last()
  await start.click()
  await page.waitForSelector('#omni-secret-value', { timeout: 15000 })
  const dialog = (await page.textContent('[role=dialog]')).replace(/\s+/g, ' ')
  check('key dialog binds the key to the endpoint origin', dialog.includes(`http://localhost:${PORT}`), dialog.slice(0, 160))
  await page.fill('#omni-secret-value', KEY)
  await page.click('[role=dialog] button:has-text("保存")')
  await page.waitForSelector('[data-task-status="done"], [data-task-status="failed"]', { timeout: 30000 })
  let summary = (await page.textContent('main section')).replace(/\s+/g, ' ')
  check('local endpoint is blocked until the user allows it', summary.includes('已阻止插件访问本机/内网地址'), summary.slice(0, 160))
  check('nothing reached the server while blocked', seen.length === 0)

  await page.evaluate(() => {
    const key = 'omnitool.settings.v2'
    const current = JSON.parse(localStorage.getItem(key) ?? '{}')
    localStorage.setItem(key, JSON.stringify({ ...current, allowLocalNetwork: true }))
  })
  await page.reload({ waitUntil: 'commit' })
  await page.waitForSelector('#panel-baseUrl', { timeout: 30000 })
  check('saved connection is restored into the panel', (await page.inputValue('#panel-baseUrl')) === API)
  await page.waitForSelector('text=已录入（仅发往', { timeout: 15000 })

  summary = await runAndWait()
  check('connection test succeeds with the stored key', summary.includes('fake-chat 响应正常') && summary.includes('OK'), summary.slice(0, 160))
  check('server received the key only as a substituted header', seen.at(-1)?.authorization === `Bearer ${KEY}`)
  const pluginHeap = await page.evaluate((key) => document.documentElement.innerHTML.includes(key), KEY)
  check('key is never rendered into the page', !pluginHeap)

  /* Translate a document in several requests. */
  await openTool('translate')
  await page.waitForSelector('main input[type=file]', { state: 'attached', timeout: 30000 })
  await page.setInputFiles('main input[type=file]', join(work, 'notes.md'))
  await page.waitForSelector('text=notes.md', { timeout: 20000 })
  const chunkSlider = page.locator('#param-chunk')
  if (await chunkSlider.count()) {
    await chunkSlider.focus()
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowLeft')
  }
  const before = seen.length
  summary = await runAndWait()
  check('translation finishes', summary.includes('已翻译 1 个文件为 简体中文') && summary.includes('notes.zh-CN.md'), summary.slice(0, 160))
  check('long document is sent in several requests', seen.length - before >= 2, `${seen.length - before} requests`)
  check('translated text is shown and code is untouched', summary.includes('【译】Paragraph 1.') && summary.includes('code stays') && !summary.includes('【译】```'))
  const secretToasts = await page.locator('[data-sonner-toast]:has-text("使用凭据")').count()
  check('secret-use notices coalesce into one toast', secretToasts === 1, `${secretToasts} toasts`)

  /* VLM detection on an image. */
  await openTool('detect')
  await page.waitForSelector('main input[type=file]', { state: 'attached', timeout: 30000 })
  await page.setInputFiles('main input[type=file]', DIR + 'sample.png')
  await page.waitForSelector('text=sample.png', { timeout: 20000 })
  summary = await runAndWait()
  check('detection exports every annotation format', ['coco.json', 'classes.txt', 'sample.txt', 'sample.json', 'sample.png'].every((n) => summary.includes(n)), summary.slice(0, 220))
  check('detection summary counts the boxes', summary.includes('在 1 张图片中检测到 1 个目标（1 个类别）'))

  /* Same-origin `/vendor` dependencies load for a subscribed plugin. */
  await openTool('csv-ai')
  await page.waitForSelector('main input[type=file]', { state: 'attached', timeout: 30000 })
  await page.setInputFiles('main input[type=file]', join(work, 'people.csv'))
  await page.waitForSelector('text=people.csv', { timeout: 20000 })
  await page.fill('#param-template', '{{name}} lives in {{city}}')
  summary = await runAndWait()
  check('CSV tool loads data-libs and fills the new column', summary.includes('已处理 2 行') && summary.includes('答案2'), summary.slice(0, 200))

  await openTool('vision-ocr')
  await page.waitForSelector('main input[type=file]', { state: 'attached', timeout: 30000 })
  await page.setInputFiles('main input[type=file]', DIR + 'a.pdf')
  await page.waitForSelector('text=a.pdf', { timeout: 20000 })
  summary = await runAndWait(120000)
  check('PDF pages render through pdf.js in the sandbox and reach the VLM', summary.includes('已转换 1 个文件') && summary.includes('a.md'), summary.slice(0, 200))

  check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
} catch (error) {
  console.error(error)
  await page.screenshot({ path: `${DIR}extensions-failure.png`, fullPage: true }).catch(() => {})
  results.push(false)
} finally {
  await browser.close()
  server.close()
}

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
