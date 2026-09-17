/**
 * End-to-end smoke test for the OmniTool plugin runtime.
 *
 * Verifies the parts that only exist in a real browser: null-origin sandbox
 * boot, blob-worker isolation tier, OPFS-backed VFS, and both built-in plugins
 * running a real job through the public Plugin API.
 */
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const DIR = new URL('./', import.meta.url).pathname

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch()
const page = await browser.newPage()

const consoleErrors = []
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text())
})
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))

try {
  await page.goto(BASE, { waitUntil: 'networkidle' })

  /* 1. Cross-origin isolation ------------------------------------------- */
  const coi = await page.evaluate(() => globalThis.crossOriginIsolated === true)
  check('cross-origin isolated (SharedArrayBuffer available)', coi)

  /* 2. Built-in plugins booted and registered --------------------------- */
  await page.waitForSelector('text=图片工具箱', { timeout: 20000 })
  const toolNames = await page.$$eval('a[href^="#/t/"] h3', (els) => els.map((e) => e.textContent.trim()))
  check('built-in tools registered', toolNames.length >= 3, toolNames.join(' | '))

  /* 3. Isolation tier --------------------------------------------------- */
  const isolationBadge = await page.textContent('text=/沙盒：/').catch(() => '')
  check(
    'sandbox tier is iframe + worker',
    isolationBadge.includes('独立源 + Worker'),
    isolationBadge.trim() || '(badge missing)',
  )

  /* 5. Storage backing --------------------------------------------------- */
  await page.click('button[aria-label="设置"]')
  await page.waitForSelector('text=诊断')
  const diagnostics = await page.textContent('section:has-text("诊断")')
  check('VFS is backed by OPFS', diagnostics.includes('OPFS（持久化到磁盘）'))

  /* 6. Image plugin: real work inside the sandbox ------------------------ */
  await page.goto(`${BASE}/#/t/omnitool.image/convert`, { waitUntil: 'networkidle' })
  await page.waitForSelector('text=输入文件')
  await page.setInputFiles('input[type=file]', `${DIR}sample.png`)
  await page.waitForSelector('text=sample.png')

  await page.click('button:has-text("开始处理")')
  await page.waitForSelector('text=处理结果', { timeout: 60000 })
  const imageSummary = (await page.textContent('text=/张图片：/')) ?? ''
  check('image compress produced a result', /张图片：/.test(imageSummary), imageSummary.trim())

  const webpName = await page.textContent('li:has-text(".webp") p').catch(() => '')
  check('image output is a .webp file', webpName.includes('.webp'), webpName.trim())

  /* 7b. The live sandbox frame really is opaque-origin -------------------- */
  const frameAudit = await page.evaluate(() => {
    const frames = [...document.querySelectorAll('iframe[title^="plugin sandbox"]')]
    return frames.map((f) => ({
      sandbox: f.getAttribute('sandbox'),
      // Reaching contentDocument across an opaque origin must throw or be null.
      reachable: (() => {
        try {
          return f.contentDocument !== null
        } catch {
          return false
        }
      })(),
    }))
  })
  check(
    'sandbox iframes are null-origin and unreachable from host',
    frameAudit.length > 0 && frameAudit.every((f) => f.sandbox === 'allow-scripts' && !f.reachable),
    JSON.stringify(frameAudit),
  )

  /* 7. UI thread stayed responsive -------------------------------------- */
  const responsive = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const start = performance.now()
        requestAnimationFrame(() => resolve(performance.now() - start))
      }),
  )
  check('UI thread responsive during/after work', responsive < 250, `${responsive.toFixed(0)}ms to next frame`)

  /* 8. PDF plugin: dependency injection + merge -------------------------- */
  await page.goto(`${BASE}/#/t/omnitool.pdf/merge`, { waitUntil: 'networkidle' })
  await page.waitForSelector('text=输入文件')
  await page.setInputFiles('input[type=file]', [`${DIR}a.pdf`, `${DIR}b.pdf`])
  await page.waitForSelector('text=b.pdf')

  await page.click('button:has-text("开始处理")')
  await page.waitForSelector('text=处理结果', { timeout: 60000 })
  const pdfSummary = (await page.textContent('text=/已合并/')) ?? ''
  check('pdf-lib dependency injected and merge succeeded', /已合并 2 个文件，共 5 页/.test(pdfSummary), pdfSummary.trim())

  /* 9. Capability enforcement ------------------------------------------- */
  await page.goto(`${BASE}/#/plugins`, { waitUntil: 'networkidle' })
  await page.click('button:has-text("导入插件")')
  await page.fill(
    'textarea',
    `definePlugin({
      id: 'test.denied',
      name: '越权测试插件',
      version: '1.0.0',
      capabilities: ['fs'],
      tools: [{
        id: 'probe', name: '越权探针', category: 'other',
        async run(ctx) {
          const report = []
          try { await fetch('https://example.com'); report.push('fetch:ALLOWED') }
          catch (e) { report.push('fetch:BLOCKED') }
          try { indexedDB.open('x'); report.push('idb:REACHABLE') }
          catch (e) { report.push('idb:BLOCKED') }
          try { await host.net.fetch('https://example.com'); report.push('host.net:ALLOWED') }
          catch (e) { report.push('host.net:DENIED') }
          try { await host.kv.set('k', 1); report.push('host.kv:ALLOWED') }
          catch (e) { report.push('host.kv:DENIED') }
          const out = await host.fs.writeAll('report.txt', report.join('\\n'), 'text/plain')
          return { outputs: [out.id], summary: report.join(' ') }
        }
      }]
    })`,
  )
  await page.click('button:has-text("解析并审查")')
  await page.waitForSelector('text=安装插件', { timeout: 20000 })
  const declared = await page.textContent('section:has-text("能力授权")')
  check('review dialog lists only declared capabilities', declared.includes('文件读写') && !declared.includes('网络请求'))
  await page.click('button:has-text("安装并授权")')
  await page.waitForSelector('text=已安装', { timeout: 15000 })

  await page.goto(`${BASE}/#/t/test.denied/probe`, { waitUntil: 'networkidle' })
  // A hash-only goto is a same-document navigation, so wait for the view itself
  // rather than for the network to settle.
  await page.waitForSelector('h1:has-text("越权探针")', { timeout: 20000 })
  await page.setInputFiles('input[type=file]', `${DIR}a.pdf`)
  await page.waitForSelector('text=a.pdf')
  await page.click('button:has-text("开始处理")')
  await page.waitForSelector('text=处理结果', { timeout: 60000 })
  const probe = (await page.textContent('text=/fetch:/')) ?? ''
  check('direct fetch blocked inside sandbox', probe.includes('fetch:BLOCKED'), probe.trim())
  check('ungranted host.net.fetch denied by host', probe.includes('host.net:DENIED'), probe.trim())
  check('ungranted host.kv denied by host', probe.includes('host.kv:DENIED'), probe.trim())

  /* 10. No unexpected console errors ------------------------------------ */
  const unexpected = consoleErrors.filter(
    (text) => !/Failed to load resource|ERR_|example\.com|net::/.test(text),
  )
  check('no unexpected console errors', unexpected.length === 0, unexpected.slice(0, 3).join(' // '))
} catch (error) {
  check('test run completed', false, error.message)
  await page.screenshot({ path: `${DIR}failure.png`, fullPage: true }).catch(() => {})
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
