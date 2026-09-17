---
title: 批量、进度、取消与报错
titleEn: Batches, progress, cancellation and errors
chapter: 入门
sample: text
sampleName: 日志.txt
sampleText: 2026-09-01 INFO 启动\n2026-09-01 ERROR 连接失败\n2026-09-02 WARN 重试\n2026-09-02 ERROR 超时\n
---

真实用户会一次拖进几十个文件。一个好工具要做到三件事：**报告进度、响应取消、把错误说清楚**。

## 接收多个文件

```js
multiple: true,
```

然后 `ctx.inputs` 里就会有多个文件，逐个处理即可。

## 进度

```js
ctx.progress(i / ctx.inputs.length, `正在处理 ${input.name}`)
```

第一个参数是 0 到 1 的比例（不知道进度时传 `null`），第二个是显示在任务队列里的文字。
调用再频繁也没关系，宿主会节流。

## 取消

用户点了「取消」之后，`ctx.signal` 会被中止。在每个耗时步骤之间调用一次
`ctx.throwIfAborted()`，就能及时停下来，不做无用功。

## 报错：写给用户看的话

直接 `throw new Error('……')`。消息会原样显示在结果卡片上，所以要写**用户能看懂、知道怎么办**的话：

```js
throw new Error(`${input.name} 是空文件，没有可以统计的内容`)
```

而不是 `TypeError: cannot read property 'x' of undefined`。

## 动手试试

当前工具只处理第一个文件，并且不管文件里有没有 `ERROR` 都照常输出。请：

1. 支持多个文件，输出一份汇总报告，每个文件一行；循环里报告进度、检查取消。
2. 如果所有文件都没有任何 `ERROR` 行，抛出一个说明性的错误。
3. 可以在预览里再拖进一个你自己的 `.txt` 试试。

```js starter
definePlugin({
  id: 'learn.batch',
  name: '日志检查',
  version: '1.0.0',
  capabilities: ['fs'],
  tools: [
    {
      id: 'errors',
      name: '统计错误行',
      category: 'document',
      accept: ['.txt', '.log', 'text/plain'],
      async run(ctx) {
        const input = ctx.inputs[0]
        const text = await ctx.host.fs.readText(input.id)
        const errors = text.split('\n').filter((line) => line.includes('ERROR'))
        const out = await ctx.host.fs.writeAll('错误行.txt', errors.join('\n'), 'text/plain')
        return { outputs: [out.id], summary: `${input.name}：${errors.length} 条错误` }
      },
    },
  ],
})
```

```js solution
definePlugin({
  id: 'learn.batch',
  name: '日志检查',
  version: '1.0.0',
  capabilities: ['fs'],
  tools: [
    {
      id: 'errors',
      name: '统计错误行',
      category: 'document',
      accept: ['.txt', '.log', 'text/plain'],
      multiple: true,
      async run(ctx) {
        const rows = []
        let total = 0
        for (const [index, input] of ctx.inputs.entries()) {
          ctx.throwIfAborted()
          ctx.progress(index / ctx.inputs.length, `正在检查 ${input.name}`)
          const text = await ctx.host.fs.readText(input.id)
          const errors = text.split('\n').filter((line) => line.includes('ERROR'))
          total += errors.length
          rows.push(`${input.name}\t${errors.length}`)
        }
        if (total === 0) {
          throw new Error(`检查了 ${ctx.inputs.length} 个文件，没有发现 ERROR 行`)
        }
        ctx.progress(1)
        const out = await ctx.host.fs.writeAll('错误汇总.tsv', `文件\t错误数\n${rows.join('\n')}\n`, 'text/tab-separated-values')
        return { outputs: [out.id], summary: `${ctx.inputs.length} 个文件，共 ${total} 条错误` }
      },
    },
  ],
})
```
