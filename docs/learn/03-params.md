---
title: 参数：让宿主替你画表单
titleEn: Params: let the host draw the form
chapter: 入门
sample: text
sampleName: 名单.txt
sampleText: 王五\n张三\n李四\n张三\n  赵六  \n
---

工具通常需要选项。你**不写任何界面代码**，只要声明 `params`，宿主就会画出表单，
用户填的值在运行时出现在 `ctx.params` 里。

```js
params: [
  { key: 'order', type: 'select', label: '排序', default: 'asc',
    options: [{ value: 'asc', label: '升序' }, { value: 'desc', label: '降序' }] },
  { key: 'unique', type: 'switch', label: '去重', default: true },
],
```

可用的类型有 `text`、`textarea`、`number`、`slider`、`switch`、`select`。
每个参数都应该有 `default`——用户什么都不改时，工具也要给出合理结果。

## 为什么不让插件自己画界面？

插件界面是**数据**，不是 HTML。宿主负责渲染，所以插件没有办法伪造一个「请输入你的密码」弹窗，
也没有办法往页面里塞脚本。第 7 课会讲更自由的 `setup(ui)`，它同样是数据。

## 按条件显示：`when`

```js
{ key: 'separator', type: 'text', label: '分隔符', default: ', ',
  when: { key: 'output', equals: 'join' } },
```

只有当 `output` 选了 `join` 时才显示这一项。`equals` 也可以是数组。

## 动手试试

当前工具按行排序。请：

1. 加一个开关 `trim`（默认开），开启时去掉每行首尾空格——示例里「赵六」两边有空格。
2. 加一个选择 `output`：「每行一个」或「合并成一行」；选「合并成一行」时再显示一个分隔符输入框。

```js starter
definePlugin({
  id: 'learn.params',
  name: '行处理',
  version: '1.0.0',
  capabilities: ['fs'],
  tools: [
    {
      id: 'lines',
      name: '排序与去重',
      category: 'document',
      accept: ['.txt', 'text/plain'],
      params: [
        {
          key: 'order', type: 'select', label: '排序', default: 'asc',
          options: [{ value: 'asc', label: '升序' }, { value: 'desc', label: '降序' }],
        },
        { key: 'unique', type: 'switch', label: '去除重复行', default: true },
      ],
      async run(ctx) {
        const { order, unique } = ctx.params
        const text = await ctx.host.fs.readText(ctx.inputs[0].id)
        let lines = text.split('\n').filter((line) => line !== '')
        if (unique) lines = [...new Set(lines)]
        lines.sort((a, b) => a.localeCompare(b, 'zh'))
        if (order === 'desc') lines.reverse()

        const out = await ctx.host.fs.writeAll('结果.txt', lines.join('\n') + '\n', 'text/plain')
        return { outputs: [out.id], summary: `共 ${lines.length} 行` }
      },
    },
  ],
})
```

```js solution
definePlugin({
  id: 'learn.params',
  name: '行处理',
  version: '1.0.0',
  capabilities: ['fs'],
  tools: [
    {
      id: 'lines',
      name: '排序与去重',
      category: 'document',
      accept: ['.txt', 'text/plain'],
      params: [
        {
          key: 'order', type: 'select', label: '排序', default: 'asc',
          options: [{ value: 'asc', label: '升序' }, { value: 'desc', label: '降序' }],
        },
        { key: 'unique', type: 'switch', label: '去除重复行', default: true },
        { key: 'trim', type: 'switch', label: '去掉首尾空格', default: true },
        {
          key: 'output', type: 'select', label: '输出', default: 'lines',
          options: [{ value: 'lines', label: '每行一个' }, { value: 'join', label: '合并成一行' }],
        },
        { key: 'separator', type: 'text', label: '分隔符', default: '、', when: { key: 'output', equals: 'join' } },
      ],
      async run(ctx) {
        const { order, unique, trim, output, separator } = ctx.params
        const text = await ctx.host.fs.readText(ctx.inputs[0].id)
        let lines = text.split('\n').map((line) => (trim ? line.trim() : line)).filter((line) => line !== '')
        if (unique) lines = [...new Set(lines)]
        lines.sort((a, b) => a.localeCompare(b, 'zh'))
        if (order === 'desc') lines.reverse()

        const body = output === 'join' ? lines.join(String(separator)) : lines.join('\n')
        const out = await ctx.host.fs.writeAll('结果.txt', body + '\n', 'text/plain')
        return { outputs: [out.id], summary: `共 ${lines.length} 行` }
      },
    },
  ],
})
```
