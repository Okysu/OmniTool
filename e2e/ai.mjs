/**
 * Local AI tools end to end: real models downloaded from Hugging Face through the
 * host's approval dialog, verified, cached, and run in the browser.
 *
 * Needs network on the first run (models are then cached in the browser profile,
 * which Playwright discards - so every run downloads ~28 MB). Set
 * OMNITOOL_E2E_OFFLINE=1 to skip.
 */
import { chromium } from 'playwright'
import { existsSync, writeFileSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://localhost:4173'
const DIR = new URL('./', import.meta.url).pathname
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

if (process.env.OMNITOOL_E2E_OFFLINE) {
  console.log('SKIP  AI tools (OMNITOOL_E2E_OFFLINE set)')
  process.exit(0)
}

// A crowd photo for face detection: OpenCV Zoo's YuNet example output (MIT).
if (!existsSync(`${DIR}faces.jpg`)) {
  const response = await fetch('https://huggingface.co/opencv/face_detection_yunet/resolve/main/example_outputs/largest_selfie.jpg')
  writeFileSync(`${DIR}faces.jpg`, new Uint8Array(await response.arrayBuffer()))
}

// A speech sample for Whisper (JFK's inaugural address, public domain).
if (!existsSync(`${DIR}speech.wav`)) {
  const response = await fetch('https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav')
  writeFileSync(`${DIR}speech.wav`, new Uint8Array(await response.arrayBuffer()))
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))

/** Approves every model download dialog that appears while `work` runs. */
async function approvingDownloads(work) {
  let approved = 0
  let active = true
  const loop = (async () => {
    while (active) {
      const button = page.locator('[role=dialog] button:has-text("下载并缓存")')
      if (await button.isVisible().catch(() => false)) {
        await button.click()
        approved++
      }
      await page.waitForTimeout(250)
    }
  })()
  try {
    await work()
  } finally {
    active = false
    await loop
  }
  return approved
}

async function runTool(toolId, files, tweak) {
  await page.goto(`${BASE}/#/files`, { waitUntil: 'commit' })
  await page.waitForSelector('main input[type=file]', { state: 'detached', timeout: 10000 }).catch(() => {})
  await page.goto(`${BASE}/#/t/omnitool.ai/${toolId}`, { waitUntil: 'commit' })
  await page.waitForSelector('main input[type=file]', { state: 'attached', timeout: 30000 })
  await page.setInputFiles('main input[type=file]', files)
  if (tweak) await tweak()
  await page.locator('main aside button').last().click()
  await page.waitForSelector('[data-task-status="done"], [data-task-status="failed"]', { timeout: 300000 })
  await page.waitForTimeout(200)
  return (await page.textContent('main section')).replace(/\s+/g, ' ')
}

/** Reads a result image back through the page and reports size and transparency. */
async function inspectResult(name) {
  return page.evaluate(async (fileName) => {
    const img = [...document.querySelectorAll('main img')].find((i) => i.alt === fileName || i.title === fileName) || document.querySelector('main section img:last-of-type')
    if (!img) return null
    await img.decode().catch(() => {})
    const canvas = new OffscreenCanvas(img.naturalWidth, img.naturalHeight)
    const g = canvas.getContext('2d')
    g.drawImage(img, 0, 0)
    const { data } = g.getImageData(0, 0, canvas.width, canvas.height)
    let transparent = 0
    for (let i = 3; i < data.length; i += 4) if (data[i] < 16) transparent++
    const centre = g.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data[3]
    return { width: canvas.width, height: canvas.height, transparentShare: transparent / (data.length / 4), centreAlpha: centre }
  }, name)
}

try {
  let summary
  const approvals = await approvingDownloads(async () => {
    summary = await runTool('ocr', [`${DIR}ocr.png`])
  })
  const text = await page.textContent('main pre').catch(() => '')
  check('OCR downloads det + rec models with approval', approvals === 2, `${approvals} dialogs`)
  check('OCR reads Chinese and English lines', text.includes('本地离线识别') && text.includes('Hello, OmniTool!'), JSON.stringify(text))

  summary = await runTool('ocr', [`${DIR}ocr.png`], async () => {
    await page.locator('#param-output').click()
    await page.locator('[data-slot=select-item]', { hasText: '可搜索 PDF' }).first().click()
  })
  check('OCR produces a searchable PDF', /已生成 1 个可搜索 PDF，识别出 2 行文字/.test(summary) && summary.includes('ocr-ocr.pdf'), summary.slice(-100))

  await approvingDownloads(async () => {
    summary = await runTool('remove-background', [`${DIR}object.png`])
  })
  check('background removal produced a cutout', /已处理 1 张图片/.test(summary) && summary.includes('object-cutout.png'), summary.slice(-120))
  const cutout = await inspectResult('object-cutout.png')
  check('cutout background is transparent and the subject opaque', !!cutout && cutout.transparentShare > 0.4 && cutout.centreAlpha > 200, JSON.stringify(cutout))

  await approvingDownloads(async () => {
    summary = await runTool('upscale', [`${DIR}object.png`])
  })
  check('upscale ×2 via Swin2SR', /已放大 1 张图片（×2）/.test(summary) && summary.includes('object-x2.png'), summary.slice(-120))
  const upscaled = await inspectResult('object-x2.png')
  check('upscaled image has doubled dimensions', !!upscaled && upscaled.width === 320 && upscaled.height === 240, JSON.stringify(upscaled))

  await approvingDownloads(async () => {
    summary = await runTool('face-blur', [`${DIR}faces.jpg`])
  })
  const faces = Number(/共遮挡 (\d+) 张人脸/.exec(summary)?.[1] ?? 0)
  // The sample is a crowd; the tiled pass should find well over twenty faces.
  check('face blur finds and covers the crowd', faces >= 20 && summary.includes('faces-anonymized.jpg'), summary.slice(-120))

  await approvingDownloads(async () => {
    summary = await runTool('erase', [`${DIR}object.png`], async () => {
      const canvas = page.locator('main canvas').first()
      await canvas.waitFor({ timeout: 30000 })
      // Largest brush, then paint over the object in horizontal passes.
      const slider = page.locator('main [role=slider]').first()
      await slider.focus()
      await page.keyboard.press('End')
      await canvas.scrollIntoViewIfNeeded()
      const box = await canvas.boundingBox()
      for (const fy of [0.2, 0.32, 0.44, 0.56, 0.68, 0.8]) {
        await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * fy)
        await page.mouse.down()
        for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + box.width * (0.25 + i * 0.0625), box.y + box.height * fy)
        await page.mouse.up()
      }
      await page.waitForSelector('main aside button:has-text("开始消除"):not([disabled])')
    })
  })
  const centre = await page.evaluate(async () => {
    const img = [...document.querySelectorAll('main section img')].pop()
    if (!img) return null
    await img.decode().catch(() => {})
    const canvas = new OffscreenCanvas(img.naturalWidth, img.naturalHeight)
    const g = canvas.getContext('2d')
    g.drawImage(img, 0, 0)
    return [...g.getImageData(80, 60, 1, 1).data.slice(0, 3)]
  })
  check('erase fills the painted object from its surroundings (MI-GAN)', /已消除 6 处涂抹区域（MI-GAN）/.test(summary) && !!centre && centre[0] - centre[2] < 60, `${summary.slice(-80)} | centre ${JSON.stringify(centre)}`)

  await approvingDownloads(async () => {
    summary = await runTool('transcribe', [`${DIR}speech.wav`])
  })
  const srt = await page.textContent('main pre').catch(() => '')
  check('Whisper transcribes speech to timed SRT', /已生成字幕 · speech.wav：\d+ 条（en）/.test(summary) && /00:00:00,000 --> /.test(srt) && (srt.match(/your country/gi) ?? []).length === 2, `${summary.slice(-80)} | ${JSON.stringify(srt.slice(0, 160))}`)

  await approvingDownloads(async () => {
    summary = await runTool('red-eye', [`${DIR}faces.jpg`])
  })
  check('red-eye pass finds the faces', /检测到 \d{2,} 张脸，修正了 \d+ 只红眼/.test(summary) && summary.includes('faces-redeye.jpg'), summary.slice(-100))

  await approvingDownloads(async () => {
    summary = await runTool('smart-crop', [`${DIR}object.png`], async () => {
      await page.locator('#param-ratio').click()
      await page.locator('[data-slot=select-item]', { hasText: '16:9' }).first().click()
    })
  })
  const cropped = await inspectResult('object-16x9.png')
  // 160×120 → the largest 16:9 crop is 160×90.
  check('smart crop to 16:9 around the subject', /已按 16:9 裁剪 1 张图片/.test(summary) && !!cropped && cropped.width === 160 && cropped.height === 90, `${summary.slice(-60)} | ${JSON.stringify(cropped)}`)

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '))
} catch (error) {
  check('ai test completed', false, error.message.split('\n')[0])
  await page.screenshot({ path: `${DIR}ai-failure.png` })
} finally {
  await browser.close()
}

console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(results.every(Boolean) ? 0 : 1)
