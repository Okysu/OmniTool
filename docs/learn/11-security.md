---
title: 沙盒与能力：用户为什么敢装你的插件
titleEn: Sandbox and capabilities
chapter: 发布
sample: none
---

你可能已经注意到一些「做不到」的事：不能 `fetch`、没有 `document`、读不到别的文件。
这些不是疏漏，而是 OmniTool 敢让任何人发布插件的原因。

## 插件运行在哪里

```
OmniTool 页面
  └─ 独立来源的 iframe（sandbox="allow-scripts"，不透明来源）
       └─ Worker ← 你的代码在这里
```

- **不透明来源**：读不到页面的 Cookie、localStorage、IndexedDB，也读不到其他插件的数据；
- **网络被锁死**：CSP 禁止一切连接，`fetch`、`XMLHttpRequest`、`WebSocket` 都被替换成直接报错的桩；
- **所有能力走宿主**：你调用的每一个 `host.*` 方法，宿主都会检查你的插件是否获得了对应授权。

## 能力清单

| 能力 | 能做什么 | 风险 |
| --- | --- | --- |
| `fs` | 读本次输入、写输出 | 低 |
| `ui` | 通知 | 低 |
| `kv` | 插件私有存储 | 低 |
| `image` | 宿主侧图片解码 / 编码 | 低 |
| `ffmpeg` | 本地音视频处理 | 低 |
| `onnx` | 本地模型推理（下载模型需用户逐个确认，并按 SHA-256 校验） | 低 |
| `secret` | 请用户填写凭据，插件只能「使用」不能「读取」 | 中 |
| `net` | 通过宿主访问网络——**数据可能离开这台电脑** | 高 |

安装时用户看到的就是这张表的子集，外加一份源码风险分析（比如是否出现了动态执行、可疑的网络地址）。
订阅更新如果**申请了新能力**，不会静默生效，必须再次确认。

## 需要网络怎么办

声明 `net`，用 `host.net.fetch`。宿主替你发请求，不带用户的 Cookie，默认拒绝访问本机与内网地址。
需要 API Key 时，用 `secret` 让用户输入，然后在请求里写占位符 `{{secret:名字}}`——
宿主只在你声明过的域名上替换它，你的代码永远拿不到明文。

教程预览**不会授予** `net` 与 `secret`，下面的代码正好演示直接联网会发生什么。

## 动手试试

1. 运行下面的工具，看看摘要里报告的错误。
2. 把 `fetch` 改成 `ctx.host.net.fetch`，再运行一次：这次是宿主拒绝了你，因为没有 `net` 授权。
   对比两条错误信息——一个来自沙盒的网络封锁，一个来自宿主的能力检查。

```js starter
definePlugin({
  id: 'learn.security',
  name: '越狱尝试',
  version: '1.0.0',
  tools: [
    {
      id: 'escape',
      name: '尝试直接联网',
      category: 'other',
      input: 'none',
      async run(ctx) {
        const attempts = []
        try {
          await fetch('https://example.com/')
          attempts.push('fetch：竟然成功了？')
        } catch (error) {
          attempts.push(`fetch 被拦截：${error.message}`)
        }
        attempts.push(`document 存在吗：${typeof document !== 'undefined'}`)
        return { outputs: [], summary: attempts.join('；') }
      },
    },
  ],
})
```

```js solution
definePlugin({
  id: 'learn.security',
  name: '越狱尝试',
  version: '1.0.0',
  tools: [
    {
      id: 'escape',
      name: '尝试直接联网',
      category: 'other',
      input: 'none',
      async run(ctx) {
        const attempts = []
        try {
          await fetch('https://example.com/')
          attempts.push('fetch：竟然成功了？')
        } catch (error) {
          attempts.push(`fetch 被拦截：${error.message}`)
        }
        try {
          await ctx.host.net.fetch('https://example.com/')
          attempts.push('host.net.fetch：成功')
        } catch (error) {
          attempts.push(`host.net.fetch 被拒绝：${error.message}`)
        }
        return { outputs: [], summary: attempts.join('；') }
      },
    },
  ],
})
```
