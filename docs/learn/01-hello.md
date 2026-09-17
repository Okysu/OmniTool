---
title: 你好，插件
titleEn: Hello, plugin
chapter: 入门
sample: none
---

欢迎！这份教程会带你从零写出一个真正能用的 OmniTool 插件。右边是编辑器，下面是**实时预览**：
你每改一次代码，它都会在一个真实的沙盒里重新运行——和安装后的插件完全一样。

## 插件就是一个 `definePlugin` 调用

OmniTool 里的每个工具（包括内置的 95 个）都是插件。插件是一个普通的 JavaScript 文件，
在顶层调用一次 `definePlugin`，告诉宿主：我是谁、提供哪些工具、每个工具做什么。

```js
definePlugin({
  id: 'learn.hello',     // 全局唯一，推荐反向域名：com.you.tools
  name: '你好插件',
  tools: [ /* 一个或多个工具 */ ],
})
```

一个工具最少需要四样东西：`id`、`name`、`category`（决定它出现在侧边栏哪个分组）和 `run`。

## `run` 做事，返回结果

`run(ctx)` 在用户点击「开始处理」时执行。它可以返回一句**摘要**，显示在结果卡片上：

```js
async run(ctx) {
  return { outputs: [], summary: '处理完成' }
}
```

这个工具不需要文件，所以声明了 `input: 'none'`——预览里不会出现拖放区。

## 动手试试

1. 把摘要改成你自己的问候语，预览会立刻刷新。
2. 在 `tools` 数组里再加一个工具（`id` 不能重复），看看预览里的工具切换。

> 插件运行在**没有网络、没有 DOM** 的沙盒 Worker 里。这不是限制，而是用户敢于安装第三方插件的原因——后面会专门讲。

```js starter
definePlugin({
  id: 'learn.hello',
  name: '你好插件',
  version: '1.0.0',
  tools: [
    {
      id: 'greet',
      name: '打个招呼',
      category: 'other',
      input: 'none',
      async run(ctx) {
        return { outputs: [], summary: '你好，OmniTool！' }
      },
    },
  ],
})
```

```js solution
definePlugin({
  id: 'learn.hello',
  name: '你好插件',
  version: '1.0.0',
  tools: [
    {
      id: 'greet',
      name: '打个招呼',
      category: 'other',
      input: 'none',
      async run(ctx) {
        const hour = new Date().getHours()
        const part = hour < 12 ? '上午好' : hour < 18 ? '下午好' : '晚上好'
        return { outputs: [], summary: `${part}，这是我的第一个插件！` }
      },
    },
    {
      id: 'time',
      name: '现在几点',
      category: 'other',
      input: 'none',
      async run() {
        return { outputs: [], summary: `现在是 ${new Date().toLocaleTimeString()}` }
      },
    },
  ],
})
```
