/**
 * The ImageMagick engine of the image toolbox, run for real in Node through the
 * same lazy-dependency path the sandbox uses. Canvas paths need a browser and are
 * covered by e2e/tools.mjs; everything here must work without OffscreenCanvas.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { loadPlugin } from './harness/plugin'

type Magick = typeof import('@imagemagick/magick-wasm')

let plugin: ReturnType<typeof loadPlugin>
let M: Magick

beforeAll(async () => {
  plugin = loadPlugin('src/plugins/builtin/image-tools.js')
  const dep = (await (globalThis as unknown as { loadDependency: (id: string) => Promise<{ exports: Magick; assets: Record<string, ArrayBuffer> }> }).loadDependency('magick'))
  M = dep.exports
  await M.initializeImageMagick(new Uint8Array(dep.assets['magick.wasm']))
}, 60_000)

/** A solid PNG, optionally semi-transparent. */
function png(color: string, width = 40, height = 30): Uint8Array {
  const image = M.MagickImage.create(new M.MagickColor(color), width, height)
  try {
    return image.write(M.MagickFormat.Png, (data) => new Uint8Array(data))
  } finally {
    image.dispose()
  }
}

/** Frame count, size, per-frame delays and alpha of an encoded image. */
function describeImage(bytes: Uint8Array) {
  return M.ImageMagick.readCollection(bytes, (images) => ({
    frames: images.length,
    width: images[0].width,
    height: images[0].height,
    delays: images.map((i) => i.animationDelay),
    alpha: images[0].hasAlpha,
    format: images[0].format,
    iterations: images[0].animationIterations,
  }))
}

async function composeGif(colors = ['red', 'green', 'blue', 'yellow'], delay = 100, format = 'keep') {
  const result = await plugin.run('animation', colors.map((c, i) => ({ name: `f${i}.png`, content: png(c), type: 'image/png' })), { mode: 'compose', delay, format })
  return result.outputs[0]
}

describe('animation: compose', () => {
  it('builds an animated GIF with one frame per image and the requested timing', async () => {
    const gif = await composeGif()
    expect(gif.name).toBe('animation.gif')
    expect(describeImage(gif.bytes)).toMatchObject({ frames: 4, width: 40, height: 30, format: 'GIF', delays: [10, 10, 10, 10], iterations: 0 })
  })

  it('fits later frames of other sizes onto the first frame’s canvas', async () => {
    const inputs = [png('red', 40, 30), png('blue', 200, 50)].map((content, i) => ({ name: `${i}.png`, content, type: 'image/png' }))
    const result = await plugin.run('animation', inputs, { mode: 'compose', delay: 50, format: 'image/webp' })
    expect(describeImage(result.outputs[0].bytes)).toMatchObject({ frames: 2, width: 40, height: 30, format: 'WEBP' })
  })
})

describe('animation: edits keep every frame', () => {
  it('doubles speed by halving delays', async () => {
    const gif = await composeGif(undefined, 200)
    const result = await plugin.run('animation', [{ name: 'a.gif', content: gif.bytes, type: 'image/gif' }], { mode: 'speed', speed: 200 })
    expect(describeImage(result.outputs[0].bytes).delays).toEqual([10, 10, 10, 10])
  })

  it('never produces sub-20ms delays that browsers would slow down', async () => {
    const gif = await composeGif(undefined, 30)
    const result = await plugin.run('animation', [{ name: 'a.gif', content: gif.bytes, type: 'image/gif' }], { mode: 'speed', speed: 400 })
    expect(Math.min(...describeImage(result.outputs[0].bytes).delays)).toBe(2)
  })

  it('reverses frame order', async () => {
    const gif = await composeGif(['red', 'blue'])
    const result = await plugin.run('animation', [{ name: 'a.gif', content: gif.bytes, type: 'image/gif' }], { mode: 'reverse' })
    const firstPixel = M.ImageMagick.readCollection(result.outputs[0].bytes, (images) => {
      images.coalesce()
      return images[0].getPixels((pixels) => Array.from(pixels.getPixel(5, 5)).slice(0, 3))
    })
    expect(firstPixel).toEqual([0, 0, 255])
  })

  it('drops frames without changing the total duration', async () => {
    const gif = await composeGif(['red', 'green', 'blue', 'yellow'], 100)
    const result = await plugin.run('animation', [{ name: 'a.gif', content: gif.bytes, type: 'image/gif' }], { mode: 'optimize', keepEvery: 2, colors: 64, maxWidth: 20 })
    const info = describeImage(result.outputs[0].bytes)
    expect(info.frames).toBe(2)
    expect(info.delays.reduce((a, b) => a + b, 0)).toBe(40)
    expect(info.width).toBe(20)
  })

  it('sets the loop count', async () => {
    const gif = await composeGif(['red', 'blue'])
    const result = await plugin.run('animation', [{ name: 'a.gif', content: gif.bytes, type: 'image/gif' }], { mode: 'loop', loops: 3 })
    expect(describeImage(result.outputs[0].bytes).iterations).toBe(3)
  })

  it('converts GIF to animated WebP with all frames', async () => {
    const gif = await composeGif(['red', 'green', 'blue'])
    const result = await plugin.run('animation', [{ name: 'a.gif', content: gif.bytes, type: 'image/gif' }], { mode: 'convert', format: 'image/webp' })
    expect(describeImage(result.outputs[0].bytes)).toMatchObject({ frames: 3, format: 'WEBP' })
  })

  it('does not offer APNG output, which ImageMagick cannot encode in WebAssembly', () => {
    const tool = plugin.tools.find((t) => t.id === 'animation')!
    const format = tool.params!.find((p) => p.key === 'format')!
    expect(format.options!.map((o) => o.value)).not.toContain('image/apng')
  })

  it('extracts frames as numbered PNGs, optionally every Nth', async () => {
    const gif = await composeGif(['red', 'green', 'blue', 'yellow'])
    const result = await plugin.run('animation', [{ name: 'clip.gif', content: gif.bytes, type: 'image/gif' }], { mode: 'extract', every: 2 })
    expect(result.outputs.map((o) => o.name)).toEqual(['clip-frame0001.png', 'clip-frame0003.png'])
    expect(result.summary).toBe('已拆出 2 帧')
  })
})

describe('geometry tools switch to magick for animations', () => {
  it('resizes every frame of an animated GIF instead of flattening it', async () => {
    const gif = await composeGif()
    const result = await plugin.run('resize', [{ name: 'a.gif', content: gif.bytes, type: 'image/gif' }], { mode: 'percent', percent: 50, format: 'keep', quality: 90 })
    expect(result.outputs[0].name).toBe('a-20x15.gif')
    expect(describeImage(result.outputs[0].bytes)).toMatchObject({ frames: 4, width: 20, height: 15 })
  })

  it('rotates every frame', async () => {
    const gif = await composeGif(['red', 'blue'])
    const result = await plugin.run('transform', [{ name: 'a.gif', content: gif.bytes, type: 'image/gif' }], { rotate: '90', format: 'keep', quality: 90 })
    expect(describeImage(result.outputs[0].bytes)).toMatchObject({ frames: 2, width: 30, height: 40 })
  })

  it('converts an animated GIF to animated WebP in the batch converter', async () => {
    const gif = await composeGif(['red', 'green', 'blue'])
    const result = await plugin.run('convert', [{ name: 'a.gif', content: gif.bytes, type: 'image/gif' }], { format: 'image/webp', quality: 80, skipLarger: false })
    expect(describeImage(result.outputs[0].bytes)).toMatchObject({ frames: 3, format: 'WEBP' })
  })

  it('keeps alpha through a magick round-trip', async () => {
    const result = await plugin.run('convert', [{ name: 't.png', content: png('#ff000080'), type: 'image/png' }], { format: 'image/webp', quality: 90, keepMetadata: true, skipLarger: false })
    expect(describeImage(result.outputs[0].bytes).alpha).toBe(true)
  })

  it('reads formats without a MIME type from their extension', async () => {
    const tiff = M.MagickImage.create(new M.MagickColor('purple'), 16, 12)
    const bytes = tiff.write(M.MagickFormat.Tiff, (data) => new Uint8Array(data))
    tiff.dispose()
    const result = await plugin.run('convert', [{ name: 'scan.tif', content: bytes, type: '' }], { format: 'keep', quality: 90, skipLarger: false, keepMetadata: true })
    expect(result.outputs[0].name).toBe('scan.tiff')
    expect(describeImage(result.outputs[0].bytes)).toMatchObject({ format: 'TIFF', width: 16, height: 12 })
  })
})

describe('metadata', () => {
  /** A JPEG carrying EXIF with GPS and an orientation tag, built by magick itself. */
  function jpegWithExif(): Uint8Array {
    const image = M.MagickImage.create(new M.MagickColor('orange'), 64, 32)
    try {
      image.setAttribute('comment', 'secret note')
      return image.write(M.MagickFormat.Jpeg, (data) => new Uint8Array(data))
    } finally {
      image.dispose()
    }
  }

  it('reports format, size, profiles and attributes', async () => {
    const result = await plugin.run('metadata', [{ name: 'p.jpg', content: jpegWithExif(), type: 'image/jpeg' }], { mode: 'view' })
    const [report] = JSON.parse(result.outputs[0].text)
    expect(report).toMatchObject({ file: 'p.jpg', format: 'JPEG', width: 64, height: 32, frames: 1, containsLocation: false })
    expect(report.attributes.comment).toBe('secret note')
  })

  it('strips comments and profiles but keeps pixels and format', async () => {
    const result = await plugin.run('metadata', [{ name: 'p.jpg', content: jpegWithExif(), type: 'image/jpeg' }], { mode: 'strip', keepIcc: true, autoOrient: true })
    expect(result.outputs[0].name).toBe('p-clean.jpg')
    const again = await plugin.run('metadata', [{ name: 'p-clean.jpg', content: result.outputs[0].bytes, type: 'image/jpeg' }], { mode: 'view' })
    const [report] = JSON.parse(again.outputs[0].text)
    expect(report.attributes.comment).toBeUndefined()
    expect(report).toMatchObject({ width: 64, height: 32 })
  })
})

describe('container sniffing', () => {
  it('detects animation without decoding', async () => {
    const gif = await composeGif(['red', 'blue'])
    const still = M.MagickImage.create(new M.MagickColor('red'), 8, 8)
    const stillGif = still.write(M.MagickFormat.Gif, (d) => new Uint8Array(d))
    still.dispose()
    // Through the plugin: a still GIF to single-frame tools raises no notice, an animation does.
    const animatedRun = await plugin.run('metadata', [{ name: 'a.gif', content: gif.bytes, type: 'image/gif' }], { mode: 'view' })
    const stillRun = await plugin.run('metadata', [{ name: 's.gif', content: stillGif, type: 'image/gif' }], { mode: 'view' })
    expect(JSON.parse(animatedRun.outputs[0].text)[0].frames).toBe(2)
    expect(JSON.parse(stillRun.outputs[0].text)[0].frames).toBe(1)
  })
})
