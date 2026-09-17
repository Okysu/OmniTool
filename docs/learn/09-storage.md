---
title: 记住设置，发出通知
titleEn: Remembering settings and notifying
chapter: 宿主能力
sample: text
sampleName: 待翻译.txt
sampleText: hello world\n
---

到目前为止我们只用了 `fs`。宿主还提供了一组能力，每一项都要**声明、并由用户授权**才能用。
这一课看两个最轻量的：`kv` 和 `ui`。

## `kv`：插件私有的键值存储

```js
await ctx.host.kv.set('lastMode', 'upper')
const mode = await ctx.host.kv.get('lastMode')   // 没有时是 null
```

- 只有你的插件能读写；加密存储在本机；
- 值必须能被 JSON 序列化，单个不超过 256 KB；
- 适合保存偏好和历史，**不要存凭据**——凭据有专门的 `secret` 能力，写入后连插件自己都读不回来。

## `ui.notify`：轻提示

```js
await ctx.host.ui.notify('已记住你的选择', 'success')
```

适合说明「发生了什么但不影响结果」的事，比如「跳过了 2 个空文件」。
真正的失败请直接 `throw`。

## 在面板里也能用

`setup(ui)` 里通过 `ui.host.kv` 读取上一次的设置，作为面板初始值——用户下次打开工具时就不用重新选。

## 动手试试

当前工具统计每次运行的次数，并在摘要里显示。请：

1. 在 `kv` 里再保存上一次选择的 `mode`，下次打开工具时面板默认选中它（提示：`setup` 里读取，放进 `ui.render` 的 `state`）。
2. 当次数是 5 的倍数时，用 `notify` 庆祝一下。

```js starter
definePlugin({
  id: 'learn.storage',
  name: '大小写转换',
  version: '1.0.0',
  capabilities: ['fs', 'kv', 'ui'],
  tools: [
    {
      id: 'case',
      name: '转换大小写',
      category: 'document',
      accept: ['.txt', 'text/plain'],
      params: [
        {
          key: 'mode', type: 'select', label: '转换为', default: 'upper',
          options: [{ value: 'upper', label: '大写' }, { value: 'lower', label: '小写' }],
        },
      ],
      async run(ctx) {
        const text = await ctx.host.fs.readText(ctx.inputs[0].id)
        const result = ctx.params.mode === 'upper' ? text.toUpperCase() : text.toLowerCase()
        const out = await ctx.host.fs.writeAll('结果.txt', result, 'text/plain')

        const runs = ((await ctx.host.kv.get('runs')) ?? 0) + 1
        await ctx.host.kv.set('runs', runs)
        return { outputs: [out.id], summary: `第 ${runs} 次使用` }
      },
    },
  ],
})
```

```js solution
const MODES = [{ value: 'upper', label: '大写' }, { value: 'lower', label: '小写' }]

definePlugin({
  id: 'learn.storage',
  name: '大小写转换',
  version: '1.0.0',
  capabilities: ['fs', 'kv', 'ui'],
  tools: [
    {
      id: 'case',
      name: '转换大小写',
      category: 'document',
      accept: ['.txt', 'text/plain'],
      async setup(ui) {
        const saved = await ui.host.kv.get('mode')
        ui.render({
          state: { mode: saved ?? 'upper', ...ui.state },
          nodes: [{ type: 'segmented', bind: 'mode', label: '转换为', options: MODES }],
        })
      },
      async run(ctx) {
        const text = await ctx.host.fs.readText(ctx.inputs[0].id)
        const mode = ctx.params.mode === 'lower' ? 'lower' : 'upper'
        const result = mode === 'upper' ? text.toUpperCase() : text.toLowerCase()
        const out = await ctx.host.fs.writeAll('结果.txt', result, 'text/plain')

        const runs = ((await ctx.host.kv.get('runs')) ?? 0) + 1
        await ctx.host.kv.set('runs', runs)
        await ctx.host.kv.set('mode', mode)
        if (runs % 5 === 0) await ctx.host.ui.notify(`这已经是你第 ${runs} 次使用了！`, 'success')
        return { outputs: [out.id], summary: `第 ${runs} 次使用` }
      },
    },
  ],
})
```
