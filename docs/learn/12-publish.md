---
title: 安装、发布与给 AI 的说明
titleEn: Installing and publishing
chapter: 发布
sample: text
sampleName: 示例.json
sampleText: {"name":"OmniTool","tags":["local","plugin"],"stars":42}
---

你已经掌握了写插件需要的全部概念。最后一课讲怎么把它交给别人用。

## 在本机安装

「插件与订阅 → 创建新插件」打开编辑器，粘贴代码，`Ctrl/⌘ S` 保存。
编辑器会像安装时一样在零授权沙盒里校验清单，并实时给出类型提示（`host.`、`ctx.`、`ui.` 都有补全）。

## 发布：一个 URL 就够

把插件文件放到任何 https 地址上（GitHub Pages、对象存储、你自己的服务器），
用户在「插件与订阅 → 添加订阅」里填这个地址即可。一个订阅也可以是索引，列出多个插件：

```json
{
  "name": "我的工具集",
  "description": "一些顺手的小工具",
  "plugins": [
    { "url": "./json-tools.js" },
    { "url": "https://example.com/other-plugin.js" }
  ]
}
```

- `url` 可以相对于索引地址；
- 更新插件就是更新文件并**提升 `version`**；用户启动时自动刷新；
- 如果新版本申请了新能力，更新会被扣下，等用户重新确认。

## 发布前检查清单

- [ ] `id` 全局唯一且不再改变（反向域名）；
- [ ] 只声明用到的能力；
- [ ] 每个参数都有合理的 `default`；
- [ ] 错误信息是写给用户看的，并说明怎么办；
- [ ] 批量处理时报告进度、检查取消；
- [ ] 读取音视频流前先 `probe`，处理图片前考虑超大尺寸；
- [ ] 跨站依赖写了 `integrity`。

## 让 AI 帮你写插件

OmniTool 为 AI 助手准备了两份**英文**纯文本文档，放在站点根目录（AI 读英文文档最稳定）：

- [`/llms.txt`](/llms.txt)：简介、必须遵守的规则与索引；
- [`/llms-full.txt`](/llms-full.txt)：完整的插件指南、类型声明，以及本教程 12 课的参考答案作为示例。

把 `llms-full.txt` 的内容（或地址）交给 AI，再描述你想要的工具，它写出的代码可以直接粘贴到编辑器里安装。
教程页右上角的「复制给 AI」按钮会把这份文档和当前课程一并复制到剪贴板。

## 最后的练习

下面是一个完整的 JSON 工具，把它改造成你自己的第一个可发布插件：

1. 换一个你自己的 `id` 和 `name`；
2. 加一个「只保留这些键」的参数（逗号分隔），输出过滤后的 JSON；
3. JSON 解析失败时给出带行号的友好提示（提示：`JSON.parse` 的错误信息里通常有 position）。

```js starter
definePlugin({
  id: 'learn.publish',
  name: 'JSON 小工具',
  version: '1.0.0',
  description: '格式化 JSON。',
  author: '你的名字',
  capabilities: ['fs'],
  tools: [
    {
      id: 'pretty',
      name: '格式化 JSON',
      category: 'document',
      icon: 'file-json',
      accept: ['.json', 'application/json'],
      input: 'both',
      textFileName: 'input.json',
      keywords: ['json', 'format', '格式化'],
      params: [{ key: 'indent', type: 'slider', label: '缩进', min: 0, max: 8, default: 2 }],
      async run(ctx) {
        const input = ctx.inputs[0]
        const data = JSON.parse(await ctx.host.fs.readText(input.id))
        const out = await ctx.host.fs.writeAll(input.name, JSON.stringify(data, null, Number(ctx.params.indent)) + '\n', 'application/json')
        return { outputs: [out.id], summary: '已格式化' }
      },
    },
  ],
})
```

```js solution
definePlugin({
  id: 'learn.publish',
  name: 'JSON 小工具',
  version: '1.1.0',
  description: '格式化 JSON，可只保留指定的键。',
  author: '你的名字',
  capabilities: ['fs'],
  tools: [
    {
      id: 'pretty',
      name: '格式化 JSON',
      category: 'document',
      icon: 'file-json',
      accept: ['.json', 'application/json'],
      input: 'both',
      textFileName: 'input.json',
      keywords: ['json', 'format', 'pick', '格式化', '筛选'],
      params: [
        { key: 'indent', type: 'slider', label: '缩进', min: 0, max: 8, default: 2 },
        { key: 'keep', type: 'text', label: '只保留这些键', default: '', placeholder: '如 name, tags（留空保留全部）' },
      ],
      async run(ctx) {
        const input = ctx.inputs[0]
        const text = await ctx.host.fs.readText(input.id)
        let data
        try {
          data = JSON.parse(text)
        } catch (error) {
          const position = Number(/position (\d+)/.exec(error.message)?.[1])
          const line = Number.isFinite(position) ? text.slice(0, position).split('\n').length : null
          throw new Error(`${input.name} 不是合法的 JSON${line ? `（第 ${line} 行附近）` : ''}：${error.message}`)
        }
        const keys = String(ctx.params.keep).split(/[,，\s]+/).filter(Boolean)
        if (keys.length && data && typeof data === 'object' && !Array.isArray(data)) {
          data = Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]))
        }
        const out = await ctx.host.fs.writeAll(input.name, JSON.stringify(data, null, Number(ctx.params.indent)) + '\n', 'application/json')
        return { outputs: [out.id], summary: keys.length ? `已保留 ${Object.keys(data).length} 个键` : '已格式化' }
      },
    },
  ],
})
```
