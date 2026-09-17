---
title: 读取输入，写出结果
titleEn: Reading inputs and writing outputs
chapter: 入门
sample: text
sampleName: 会议记录.txt
sampleText: 周一例会\n\n1. 确认发布日期\n2. 讨论插件教程\n\n参会：张三、李四、王五\n
---

大多数工具的模式都一样：**读入用户的文件 → 处理 → 写出新文件**。

## 文件是「句柄」，不是内容

`ctx.inputs` 是用户选中的文件列表，每一项形如 `{ id, name, size, type }`。
里面没有文件内容——`id` 是一张凭证，你需要通过宿主 API 去读：

```js
const text = await ctx.host.fs.readText(ctx.inputs[0].id)
```

为什么这么绕？因为文件可能有几个 GB。宿主把它们存在磁盘（OPFS）上，你按需读取，
而且**只能读到这一次调用的输入和你自己写出的文件**——别的文件你连 `id` 都拿不到。

## 写出文件

```js
const file = await ctx.host.fs.writeAll('结果.txt', '内容', 'text/plain')
return { outputs: [file.id], summary: '已生成 1 个文件' }
```

把文件 `id` 放进 `outputs`，它就会出现在结果区，用户可以预览、下载。

## 声明能力

读写文件需要 `fs` 能力，所以插件要声明 `capabilities: ['fs']`。用户安装时会看到这个清单，
逐项决定是否授权。**只申请你用到的能力**——少一项，用户就少一分顾虑。

## 动手试试

预览里已经放好了一个示例文件 `会议记录.txt`。当前代码只统计了字数。

1. 让它同时统计**行数**（提示：`text.split('\n')`）。
2. 额外写出一份把全部内容转成**大写**的文件（中文不受影响，试着在示例里加点英文）。
3. 把两个文件都放进 `outputs`。

```js starter
definePlugin({
  id: 'learn.files',
  name: '文本统计',
  version: '1.0.0',
  capabilities: ['fs'],
  tools: [
    {
      id: 'count',
      name: '统计字数',
      category: 'document',
      accept: ['.txt', 'text/plain'],
      async run(ctx) {
        const input = ctx.inputs[0]
        const text = await ctx.host.fs.readText(input.id)
        const chars = [...text.replace(/\s/g, '')].length

        const report = await ctx.host.fs.writeAll(`${input.name}.统计.txt`, `字数：${chars}\n`, 'text/plain')
        return { outputs: [report.id], summary: `${input.name}：${chars} 字` }
      },
    },
  ],
})
```

```js solution
definePlugin({
  id: 'learn.files',
  name: '文本统计',
  version: '1.0.0',
  capabilities: ['fs'],
  tools: [
    {
      id: 'count',
      name: '统计字数',
      category: 'document',
      accept: ['.txt', 'text/plain'],
      async run(ctx) {
        const input = ctx.inputs[0]
        const text = await ctx.host.fs.readText(input.id)
        const chars = [...text.replace(/\s/g, '')].length
        const lines = text.split('\n').length

        const report = await ctx.host.fs.writeAll(`${input.name}.统计.txt`, `字数：${chars}\n行数：${lines}\n`, 'text/plain')
        const upper = await ctx.host.fs.writeAll(`${input.name}.大写.txt`, text.toUpperCase(), 'text/plain')
        return { outputs: [report.id, upper.id], summary: `${input.name}：${chars} 字，${lines} 行` }
      },
    },
  ],
})
```
