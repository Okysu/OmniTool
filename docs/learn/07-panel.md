---
title: 自定义面板：setup(ui)
titleEn: Custom panels with setup(ui)
chapter: 界面
sample: text
sampleName: 草稿.txt
sampleText: OmniTool 是一个本地优先的工具箱。\n所有文件都在你的电脑上处理。\n插件运行在沙盒里。\n
---

生成式表单能覆盖大多数工具。但有时你想**先看一眼文件再决定**，或者让界面随选择变化——
这时定义 `setup(ui)`，自己描述面板。

## 面板也是数据

```js
async setup(ui) {
  ui.render({
    nodes: [
      { type: 'text', text: '选一个模式', variant: 'muted' },
      { type: 'segmented', bind: 'mode', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
    ],
    state: { mode: 'a' },
    runLabel: '开始',
  })
}
```

- 带 `bind` 的节点和 `ui.state` 双向绑定；**这份 state 就是运行时的 `ctx.params`**，`run` 不需要知道面板的存在。
- `runLabel` 改按钮文字，`runDisabled` 可以在条件不满足时禁用运行。
- 可用节点：`text`、`alert`、`facts`、`badge`、`row`、`section`、`input`、`textarea`、`select`、`segmented`、`slider`、`switch`、`color`、`button`、`preview`、`media`、`canvas`……完整列表见 API 参考。

## 响应变化

```js
ui.on('change', (key, value, state) => { /* 重新 render */ })
ui.on('action', (name) => { /* button 被点击 */ })
```

`setup` 在输入文件变化时会被重新调用，所以 `ui.inputs` 永远是当前选择；在里面读取文件内容做预检很常见：

```js
const text = await ui.host.fs.readText(ui.inputs[0].id)
```

## 动手试试

当前面板会显示文件的行数和字数，并按「前缀」给每行加编号。请：

1. 加一个 `segmented` 让用户在「加编号」和「加引用符号 >」之间切换，运行按钮文字随之变成「添加编号」/「添加引用」。
2. 前缀输入框只在「加编号」模式显示（节点也支持 `when`）。
3. 当文件为空时，用 `alert` 提示并设置 `runDisabled: true`。

```js starter
definePlugin({
  id: 'learn.panel',
  name: '行前缀',
  version: '1.0.0',
  capabilities: ['fs'],
  tools: [
    {
      id: 'prefix',
      name: '给每行加前缀',
      category: 'document',
      accept: ['.txt', 'text/plain'],
      async setup(ui) {
        if (!ui.inputs.length) {
          ui.render({ nodes: [{ type: 'alert', text: '先拖入一个文本文件' }], runDisabled: true })
          return
        }
        const text = await ui.host.fs.readText(ui.inputs[0].id)
        const lines = text.split('\n').filter(Boolean)
        ui.render({
          state: { prefix: '第{n}行：', ...ui.state },
          runLabel: '添加编号',
          nodes: [
            { type: 'facts', rows: [{ label: '行数', value: String(lines.length) }, { label: '字数', value: String(text.replace(/\s/g, '').length) }] },
            { type: 'input', bind: 'prefix', label: '前缀', hint: '{n} 会被替换为行号' },
          ],
        })
      },
      async run(ctx) {
        const text = await ctx.host.fs.readText(ctx.inputs[0].id)
        const lines = text.split('\n').filter(Boolean)
        const body = lines.map((line, i) => String(ctx.params.prefix).replace('{n}', i + 1) + line).join('\n')
        const out = await ctx.host.fs.writeAll('结果.txt', body + '\n', 'text/plain')
        return { outputs: [out.id], summary: `已处理 ${lines.length} 行` }
      },
    },
  ],
})
```

```js solution
definePlugin({
  id: 'learn.panel',
  name: '行前缀',
  version: '1.0.0',
  capabilities: ['fs'],
  tools: [
    {
      id: 'prefix',
      name: '给每行加前缀',
      category: 'document',
      accept: ['.txt', 'text/plain'],
      async setup(ui) {
        if (!ui.inputs.length) {
          ui.render({ nodes: [{ type: 'alert', text: '先拖入一个文本文件' }], runDisabled: true })
          return
        }
        const text = await ui.host.fs.readText(ui.inputs[0].id)
        const lines = text.split('\n').filter(Boolean)

        const draw = (state) =>
          ui.render({
            runLabel: state.mode === 'quote' ? '添加引用' : '添加编号',
            runDisabled: lines.length === 0,
            nodes: [
              lines.length === 0
                ? { type: 'alert', tone: 'warning', title: '文件是空的', text: '没有可以处理的行。' }
                : { type: 'facts', rows: [{ label: '行数', value: String(lines.length) }, { label: '字数', value: String(text.replace(/\s/g, '').length) }] },
              { type: 'segmented', bind: 'mode', label: '方式', options: [{ value: 'number', label: '加编号' }, { value: 'quote', label: '加引用符号' }] },
              { type: 'input', bind: 'prefix', label: '前缀', hint: '{n} 会被替换为行号', when: { key: 'mode', equals: 'number' } },
            ],
          })

        ui.render({ state: { mode: 'number', prefix: '第{n}行：', ...ui.state }, nodes: [] })
        draw(ui.state)
        ui.on('change', (key, value, state) => {
          if (key === 'mode') draw(state)
        })
      },
      async run(ctx) {
        const text = await ctx.host.fs.readText(ctx.inputs[0].id)
        const lines = text.split('\n').filter(Boolean)
        const body = lines
          .map((line, i) => (ctx.params.mode === 'quote' ? `> ${line}` : String(ctx.params.prefix).replace('{n}', i + 1) + line))
          .join('\n')
        const out = await ctx.host.fs.writeAll('结果.txt', body + '\n', 'text/plain')
        return { outputs: [out.id], summary: `已处理 ${lines.length} 行` }
      },
    },
  ],
})
```
