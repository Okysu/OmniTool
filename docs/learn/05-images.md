---
title: 处理图片：沙盒里的 Canvas
titleEn: Images with OffscreenCanvas
chapter: 进阶
sample: image
sampleName: 风景.png
---

沙盒是 Worker，没有 `document`，但有 **`OffscreenCanvas`** 和 **`createImageBitmap`**——
这正是内置图片工具箱的做法：像素计算发生在沙盒里，不占用页面的主线程。

## 解码、绘制、编码

```js
const blob = await ctx.host.fs.blob(input.id)
const bitmap = await createImageBitmap(blob)

const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
const g = canvas.getContext('2d')
g.drawImage(bitmap, 0, 0)

const png = await canvas.convertToBlob({ type: 'image/png' })
const bytes = new Uint8Array(await png.arrayBuffer())
await ctx.host.fs.writeAll('结果.png', bytes, 'image/png')
```

## 逐像素处理

`getImageData` 给你一个 `Uint8ClampedArray`，每 4 个字节是一个像素的 R、G、B、A：

```js
const image = g.getImageData(0, 0, canvas.width, canvas.height)
for (let i = 0; i < image.data.length; i += 4) {
  // image.data[i], image.data[i + 1], image.data[i + 2]
}
g.putImageData(image, 0, 0)
```

不需要为此申请 `image` 能力——那是宿主侧的兜底（比如渲染 SVG，Worker 解码不了）。

## 动手试试

当前工具把图片转成灰度。请：

1. 加一个滑块 `pixel`（2–40，默认 12），先把图片缩小再用 `imageSmoothingEnabled = false` 放大，做出马赛克效果。
2. 加一个选择，在「灰度」和「马赛克」之间切换，马赛克滑块只在选中马赛克时显示。

```js starter
definePlugin({
  id: 'learn.images',
  name: '图片效果',
  version: '1.0.0',
  capabilities: ['fs'],
  tools: [
    {
      id: 'effect',
      name: '图片滤镜',
      category: 'image',
      accept: ['image/png', 'image/jpeg', 'image/webp'],
      async run(ctx) {
        const input = ctx.inputs[0]
        const bitmap = await createImageBitmap(await ctx.host.fs.blob(input.id))
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const g = canvas.getContext('2d')
        g.drawImage(bitmap, 0, 0)

        const image = g.getImageData(0, 0, canvas.width, canvas.height)
        for (let i = 0; i < image.data.length; i += 4) {
          const y = 0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2]
          image.data[i] = image.data[i + 1] = image.data[i + 2] = y
        }
        g.putImageData(image, 0, 0)

        const png = await canvas.convertToBlob({ type: 'image/png' })
        const out = await ctx.host.fs.writeAll('灰度.png', new Uint8Array(await png.arrayBuffer()), 'image/png')
        return { outputs: [out.id], summary: `${bitmap.width} × ${bitmap.height}` }
      },
    },
  ],
})
```

```js solution
definePlugin({
  id: 'learn.images',
  name: '图片效果',
  version: '1.0.0',
  capabilities: ['fs'],
  tools: [
    {
      id: 'effect',
      name: '图片滤镜',
      category: 'image',
      accept: ['image/png', 'image/jpeg', 'image/webp'],
      params: [
        {
          key: 'mode', type: 'select', label: '效果', default: 'gray',
          options: [{ value: 'gray', label: '灰度' }, { value: 'mosaic', label: '马赛克' }],
        },
        { key: 'pixel', type: 'slider', label: '色块大小', min: 2, max: 40, default: 12, suffix: 'px', when: { key: 'mode', equals: 'mosaic' } },
      ],
      async run(ctx) {
        const input = ctx.inputs[0]
        const bitmap = await createImageBitmap(await ctx.host.fs.blob(input.id))
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const g = canvas.getContext('2d')

        if (ctx.params.mode === 'mosaic') {
          const size = Number(ctx.params.pixel)
          const small = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width / size)), Math.max(1, Math.round(bitmap.height / size)))
          small.getContext('2d').drawImage(bitmap, 0, 0, small.width, small.height)
          g.imageSmoothingEnabled = false
          g.drawImage(small, 0, 0, canvas.width, canvas.height)
        } else {
          g.drawImage(bitmap, 0, 0)
          const image = g.getImageData(0, 0, canvas.width, canvas.height)
          for (let i = 0; i < image.data.length; i += 4) {
            const y = 0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2]
            image.data[i] = image.data[i + 1] = image.data[i + 2] = y
          }
          g.putImageData(image, 0, 0)
        }

        const png = await canvas.convertToBlob({ type: 'image/png' })
        const name = ctx.params.mode === 'mosaic' ? '马赛克.png' : '灰度.png'
        const out = await ctx.host.fs.writeAll(name, new Uint8Array(await png.arrayBuffer()), 'image/png')
        return { outputs: [out.id], summary: `${bitmap.width} × ${bitmap.height}` }
      },
    },
  ],
})
```
