---
title: 画布：像素级交互
titleEn: Canvas: pixel-level interaction
chapter: 界面
sample: none
---

有些交互组件描述不了：签名板、涂抹、标注。`canvas` 节点把一块**真正的 OffscreenCanvas**
交到沙盒里，你直接在上面画；鼠标和手指的动作以事件形式传进来。

```js
ui.render({ nodes: [{ type: 'canvas', id: 'pad', aspect: 2, interactive: true }] })

ui.on('canvas', (id, canvas) => {   // 画布交到你手里（首次，以及每次重新挂载）
  paint(canvas)
})
ui.on('pointer', (id, p) => {       // p = { type: 'down' | 'move' | 'up', x, y, buttons }
})
```

几个要点：

- 坐标是**画布像素**（已经乘过设备像素比），直接用来画即可；
- `move` 事件每帧最多一次，不会把通道淹没；
- 节点被隐藏再显示时，宿主会交给你一块**新**画布，所以要在 `ui.on('canvas')` 里重画，而不是只画一次；
- 面板里的笔迹放在模块级变量里，`run` 在同一个沙盒中执行，可以直接读到。

这个工具不需要输入文件，它把你画的内容导出为 PNG。

## 动手试试

1. 在预览的画布上画几笔，然后运行，看看导出的图片。
2. 加一个「颜色」节点（`type: 'color'`，绑定 `color`），让笔迹使用选中的颜色。
3. 加一个「清空」按钮（`type: 'button'`，`action: 'clear'`），在 `ui.on('action')` 里清空笔迹并重画。

```js starter
const strokes = []

function paint(canvas, color) {
  const g = canvas.getContext('2d')
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, canvas.width, canvas.height)
  g.strokeStyle = color
  g.lineWidth = Math.max(3, canvas.width / 150)
  g.lineCap = 'round'
  g.lineJoin = 'round'
  for (const stroke of strokes) {
    g.beginPath()
    stroke.forEach(([x, y], i) => (i ? g.lineTo(x * canvas.width, y * canvas.height) : g.moveTo(x * canvas.width, y * canvas.height)))
    g.stroke()
  }
}

definePlugin({
  id: 'learn.canvas',
  name: '画板',
  version: '1.0.0',
  capabilities: ['fs'],
  tools: [
    {
      id: 'draw',
      name: '手绘导出',
      category: 'image',
      input: 'none',
      setup(ui) {
        let surface = null
        ui.render({
          runLabel: '导出 PNG',
          nodes: [
            { type: 'text', text: '在下面的画布上画画', variant: 'muted' },
            { type: 'canvas', id: 'pad', aspect: 2, interactive: true },
          ],
        })
        ui.on('canvas', (id, canvas) => {
          surface = canvas
          paint(surface, '#111827')
        })
        ui.on('pointer', (id, p) => {
          if (!surface) return
          // Store fractions, so the drawing does not depend on the canvas size.
          const point = [p.x / surface.width, p.y / surface.height]
          if (p.type === 'down') strokes.push([point])
          else if (p.type === 'move' && p.buttons && strokes.length) strokes[strokes.length - 1].push(point)
          paint(surface, '#111827')
        })
      },
      async run(ctx) {
        const canvas = new OffscreenCanvas(1200, 600)
        paint(canvas, '#111827')
        const png = await canvas.convertToBlob({ type: 'image/png' })
        const out = await ctx.host.fs.writeAll('手绘.png', new Uint8Array(await png.arrayBuffer()), 'image/png')
        return { outputs: [out.id], summary: `已导出 ${strokes.length} 笔` }
      },
    },
  ],
})
```

```js solution
const strokes = []

function paint(canvas, color) {
  const g = canvas.getContext('2d')
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, canvas.width, canvas.height)
  g.strokeStyle = color
  g.lineWidth = Math.max(3, canvas.width / 150)
  g.lineCap = 'round'
  g.lineJoin = 'round'
  for (const stroke of strokes) {
    g.beginPath()
    stroke.forEach(([x, y], i) => (i ? g.lineTo(x * canvas.width, y * canvas.height) : g.moveTo(x * canvas.width, y * canvas.height)))
    g.stroke()
  }
}

definePlugin({
  id: 'learn.canvas',
  name: '画板',
  version: '1.0.0',
  capabilities: ['fs'],
  tools: [
    {
      id: 'draw',
      name: '手绘导出',
      category: 'image',
      input: 'none',
      setup(ui) {
        let surface = null
        const repaint = () => surface && paint(surface, String(ui.state.color || '#111827'))
        ui.render({
          state: { color: '#2563eb', ...ui.state },
          runLabel: '导出 PNG',
          nodes: [
            {
              type: 'row', gap: 3, align: 'center',
              children: [
                { type: 'color', bind: 'color', label: '笔迹颜色' },
                { type: 'button', text: '清空', action: 'clear', variant: 'outline', icon: 'eraser' },
              ],
            },
            { type: 'canvas', id: 'pad', aspect: 2, interactive: true },
          ],
        })
        ui.on('canvas', (id, canvas) => {
          surface = canvas
          repaint()
        })
        ui.on('change', (key) => key === 'color' && repaint())
        ui.on('action', (name) => {
          if (name === 'clear') strokes.length = 0
          repaint()
        })
        ui.on('pointer', (id, p) => {
          if (!surface) return
          const point = [p.x / surface.width, p.y / surface.height]
          if (p.type === 'down') strokes.push([point])
          else if (p.type === 'move' && p.buttons && strokes.length) strokes[strokes.length - 1].push(point)
          repaint()
        })
      },
      async run(ctx) {
        const canvas = new OffscreenCanvas(1200, 600)
        paint(canvas, String(ctx.params.color || '#111827'))
        const png = await canvas.convertToBlob({ type: 'image/png' })
        const out = await ctx.host.fs.writeAll('手绘.png', new Uint8Array(await png.arrayBuffer()), 'image/png')
        return { outputs: [out.id], summary: `已导出 ${strokes.length} 笔` }
      },
    },
  ],
})
```
