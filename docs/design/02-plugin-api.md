# Plugin API 参考 · v2

> 面向：为 OmniTool 编写插件的开发者。你只需要会写 JavaScript，不需要了解 OmniTool 的内部实现。

一个插件就是一段调用 `definePlugin()` 的 JavaScript。没有构建步骤，没有 import，没有框架。

最快的上手方式：「插件与订阅 → 创建新插件」。内置编辑器是 VS Code 同款内核，
输入 `host.`、`ctx.`、`ui.` 会给出补全，悬停显示文档，保存前实时校验清单。
同一份类型声明在仓库的 [`sdk/omnitool-plugin.d.ts`](../../sdk/omnitool-plugin.d.ts)，
也可以直接拿到你自己的 IDE 里用。

---

## 最小示例

```js
definePlugin({
  id: 'example.hello',
  name: '示例插件',
  version: '1.0.0',
  capabilities: ['fs'],

  tools: [
    {
      id: 'copy',
      name: '原样复制',
      category: 'other',
      async run(ctx) {
        const input = ctx.inputs[0]
        const bytes = await ctx.host.fs.readAll(input.id)
        const out = await ctx.host.fs.writeAll('copy-' + input.name, bytes, input.type)
        return { outputs: [out.id], summary: '复制了 1 个文件' }
      },
    },
  ],
})
```

---

## 运行环境

你的代码运行在**不透明来源的 iframe 里的 Worker** 中。

| 能做 | 不能做 |
| --- | --- |
| 任意纯 JS 计算、`WebAssembly` | 直接 `fetch` / `XMLHttpRequest` / `WebSocket`（被 CSP 拦截，用 `host.net`） |
| `OffscreenCanvas`、`createImageBitmap` | 访问 DOM（Worker 里没有 `document`） |
| `TextEncoder`、`crypto.getRandomValues` | **`crypto.subtle`**（不透明来源不是安全上下文，这个接口根本不存在——用 `host.fs.digest`） |
| `host.*` 中你已获授权的部分 | **`DOMParser`**（Worker 里没有，XML 请自带解析器） |
| | `localStorage` / `indexedDB`（用 `host.kv`） |

直接调用被禁止的网络 API 会抛出明确的错误，指向 `host.net.fetch`。

**图像处理建议直接在沙盒里用 `OffscreenCanvas`**，它在 Worker 线程上跑，不占用界面线程。

---

## 清单

### 插件级

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | ✓ | 全局唯一，匹配 `/^[a-z0-9][a-z0-9._-]{1,63}$/i`。建议反向域名，如 `com.you.tools` |
| `name` | string | ✓ | 显示名 |
| `version` | string | | 语义化版本 |
| `description` / `author` / `homepage` | string | | 元信息 |
| `icon` | string | | Lucide 图标名（kebab-case） |
| `capabilities` | Capability[] | | 申请的能力，见下 |
| `deps` | Dep[] | | 外部脚本，由宿主拉取、校验、缓存后注入 |
| `tools` | Tool[] | ✓ | 至少一个 |

### 工具级

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | ✓ | 插件内唯一 |
| `name` | string | ✓ | 显示名 |
| `category` | string | ✓ | `pdf` `media` `image` `document` `dev` `ai` `archive` `other` |
| `description` / `icon` / `keywords` | | | 卡片、工具页、命令面板检索 |
| `accept` | string[] | | 文件选择器过滤，如 `['image/*', '.heic']`。接受音频（`audio/*`）的工具，输入区会自动多出「录音」按钮：麦克风由宿主调用，插件拿到的只是一个普通输入文件 |
| `multiple` | boolean | | 是否接受多文件，默认 `false` |
| `minFiles` | number | | 可运行所需最少输入数，默认 `1`（`input: 'none'` 时为 `0`） |
| `input` | string | | **v2** 输入方式，见下 |
| `textFileName` | string | | **v2** 粘贴文本保存成的文件名，扩展名决定格式识别 |
| `params` | Param[] | | 生成式参数表单 |
| `setup` | function | | **v2** 自定义界面，定义后忽略 `params` |
| `run` | function | ✓ | 执行 |

### 输入方式 `input`（v2）

| 值 | 界面 |
| --- | --- |
| `'files'`（默认） | 拖放区 |
| `'text'` | 文本框 |
| `'both'` | 「文件 / 直接输入」两个标签页 |
| `'none'` | 不需要输入（生成器类工具） |

**粘贴的文本会先写成工作区文件再交给你**，文件名取 `textFileName`。
所以 `run()` 永远只需要处理 `ctx.inputs` 这一种形态，不必区分用户是拖文件还是粘贴。

单个文本类输出会在结果区内联显示，并带「复制」按钮。

---

## 两种界面

### 1. 生成式表单：`params`

宿主按声明渲染，风格与内置工具完全一致。

```js
params: [
  { key: 'quality', type: 'slider', label: '质量', min: 1, max: 100, default: 80, suffix: '%' },
  { key: 'format', type: 'select', label: '格式', default: 'webp',
    options: [{ value: 'webp', label: 'WebP' }, { value: 'png', label: 'PNG' }] },
  { key: 'bg', type: 'text', label: '背景色', when: { key: 'format', equals: 'png' } },
]
```

| `type` | 额外字段 |
| --- | --- |
| `text` | `default` `placeholder` |
| `textarea` | `default` `placeholder` `rows` |
| `number` | `default` `min` `max` `step` `suffix` |
| `slider` | `min`✓ `max`✓ `default` `step` `suffix` |
| `switch` | `default` |
| `select` | `options`✓ `default` |

所有类型都支持 `hint` 与 `when`（条件显示，`equals` 可为数组）。

### 2. 自定义界面：`setup(ui)`（v2）

表单表达不了的交互——时间轴裁剪、画框标注、实时预览——用 `setup`。

```js
async setup(ui) {
  const input = ui.inputs[0]
  if (!input) {
    ui.render({ runDisabled: true, nodes: [{ type: 'alert', tone: 'info', text: '先拖入一个视频。' }] })
    return
  }
  ui.render({
    state: { range: [], copy: true },
    runLabel: '导出片段',
    nodes: [
      { type: 'timeline', fileId: input.id, bind: 'range' },
      { type: 'switch', bind: 'copy', label: '无损快切' },
    ],
  })
},

async run(ctx) {
  const [start, end] = ctx.params.range   // 面板里 bind 的值就是 ctx.params
  …
}
```

**你描述界面，宿主用真实的 shadcn 组件渲染。** 这意味着：

- 第三方插件的界面与内置工具**视觉上无法区分**，而且会自动跟随主题与今后的样式更新；
- 没有任何标记、样式、事件处理器越过沙盒边界，只有数据——界面描述本身无法注入脚本；
- 所有字符串都按纯文本渲染。

#### 生命周期

- 工具页打开时调用一次 `setup`；**用户更换输入文件时会再调用一次**（旧面板先卸载）。
- 面板打开期间，`ui.inputs` 里的文件对插件可读，方便预览和探测；面板关闭即回收权限。
- 运行时，面板绑定的状态整体作为 `ctx.params` 传入 `run()`。

#### `ui` 对象

| 成员 | 说明 |
| --- | --- |
| `ui.inputs` | 当前选中的文件 |
| `ui.state` | 当前绑定值，随用户编辑自动同步 |
| `ui.host` | 宿主 API |
| `ui.render(panel)` | 替换整个面板。`panel = { nodes, state?, runLabel?, runDisabled? }` |
| `ui.setState(patch)` | 只更新绑定值，不重发组件树 |
| `ui.on('change', (key, value, state) => …)` | 绑定控件变更 |
| `ui.on('action', (name, _, state) => …)` | `button` 被点击 |
| `ui.on('pointer', (canvasId, p, state) => …)` | 可交互画布上的指针事件，坐标是画布像素 |
| `ui.on('canvas', (canvasId, canvas, state) => …)` | 画布表面交到沙盒时触发：首次渲染，以及节点被重新挂载（如被 `when` 隐藏后再显示）时——**在这里重画** |
| `await ui.canvas(id)` | 取得 `canvas` 节点背后的 `OffscreenCanvas` |

`on()` 返回一个取消订阅的函数。

#### 节点

| 类型 | 字段 | 说明 |
| --- | --- | --- |
| `stack` / `row` | `children` `gap` · row 另有 `align` `wrap` | 纵向 / 横向布局 |
| `section` | `title` `children` | 带小标题的分组 |
| `separator` | | 分隔线 |
| `text` | `text` `variant: title/body/muted/mono` | 文字 |
| `badge` | `text` `tone` | 徽标 |
| `alert` | `text` `title` `tone: info/success/warning/destructive` | 提示框 |
| `facts` | `rows: [{label, value}]` | 键值列表，适合展示探测结果 |
| `code` | `text, label?, height?, wrap?` | 等宽、可滚动的输出，带宿主绘制的「复制」按钮（插件无法访问剪贴板）；最长 200 000 字符，`height` 以 rem 计，默认 20 |
| `input` | `bind` `label` `hint` `placeholder` `inputType` `min` `max` `step` `suffix` | 输入框 |
| `textarea` | `bind` `label` `hint` `rows` `mono` | 多行文本 |
| `select` | `bind` `label` `options` | 下拉 |
| `segmented` | `bind` `label` `options` | 分段选择，适合 2–4 个选项 |
| `slider` | `bind` `min`✓ `max`✓ `step` `suffix` | 滑块 |
| `switch` | `bind` `label` `hint` | 开关 |
| `color` | `bind` `label` | 取色器 + 色值输入 |
| `button` | `text` `action`✓ `variant` `icon` `disabled` `busy` | 触发 `action` 事件 |
| `preview` | `fileId` `height` | 图片 / 视频 / 音频 / PDF / 文本内联预览 |
| `timeline` | `fileId` `bind` | 音视频时间轴：播放、波形、双柄选区、设为起终点、播放选区。绑定值为 `[开始秒, 结束秒]`。等价于只绑定 `range` 的 `media` |
| `media` | `fileId`✓ `range` `crop` `cropAspect` `markers` `meta` `effects` `height` | 可视化音视频编辑器，见下 |
| `reorder` | `bind` `items: [{label, detail}]` `label` | 可拖动 / 上下移动排序的列表，绑定值为下标排列，如 `[2, 0, 1]` |
| `canvas` | `id` `aspect` `height` `interactive` | 绘图表面，见下 |

所有节点都支持 `when`。未知的节点类型会被忽略，不会让整个面板失败。

#### `media`：可视化音视频编辑（v2.1，新增，非破坏性）

画面裁切、旋转预览、淡入淡出包络这类编辑，不需要插件自己画画布。`media` 节点的每个字段都是**状态键名**，
宿主负责播放、拖拽与预览，插件只读写状态：

| 字段 | 绑定值 | 交互 |
| --- | --- | --- |
| `range` | `[开始秒, 结束秒]` | 波形条上的双柄选区、设为起点 / 终点、播放选区 |
| `crop` | `[x, y, w, h]`，**源画面的比例**（0–1）；`[]` 隐藏裁切框 | 在画面上拖动框体、拖动 8 个手柄、方向键微调（Shift 加速） |
| `cropAspect` | 像素宽高比，`0` 为自由 | 约束裁切框；变化时自动换成该比例下最大的居中框 |
| `markers` | 秒数数组（最多 64 个） | 「标记当前帧」、点击跳转、删除 |
| `meta` | 由宿主写入 `[时长, 宽, 高]` | 媒体加载后触发一次 `change` 事件，可用于计算输出尺寸 |
| `effects` | `{ 效果名: 键名 或 { bind, scale } }` | 实时预览，见下 |

裁切用比例而不是像素，是为了让同一个框能批量应用到不同分辨率的文件：
`crop=trunc(iw*w/2)*2:trunc(ih*h/2)*2:trunc(iw*x):trunc(ih*y)`。

`effects` 支持：`rotate`（度，90 的倍数）、`flipH` / `flipV` / `mute`（布尔）、`brightness`（-1..1，同 ffmpeg `eq`）、
`contrast` / `saturation` / `speed` / `volume`（倍数，1 为不变）、`hue`（度）、`fadeIn` / `fadeOut`（秒，从选区两端起算）。
`scale` 用于单位换算，例如 0–400 的百分比滑块预览音量：`volume: { bind: 'volume', scale: 0.01 }`。

画面效果用 CSS 变换与滤镜、音量与淡入淡出用 Web Audio、变速用不变调的 `playbackRate` 预览——都是**近似效果**，
导出结果完全由你的 ffmpeg 命令决定，面板会提示这一点。裁切框画在源画面上、随旋转镜像一起变换，
因此命令里的滤镜顺序应当是：**裁切 → 旋转 / 镜像 → 调色**，内置「视频画面处理」即按此实现。

```js
ui.render({
  state: { crop: [], rotate: '0', saturation: 100, meta: [] },
  nodes: [
    {
      type: 'media', fileId: ui.inputs[0].id, meta: 'meta', crop: 'crop',
      effects: { rotate: 'rotate', saturation: { bind: 'saturation', scale: 0.01 } },
    },
    { type: 'segmented', bind: 'rotate', options: [{ value: '0', label: '0°' }, { value: '90', label: '90°' }] },
    { type: 'slider', bind: 'saturation', min: 0, max: 300, suffix: '%' },
  ],
})
ui.on('change', (key, value) => {
  if (key === 'meta') ui.render({ nodes: /* 用 value[1]、value[2] 计算输出尺寸 */ [] })
})
```

> 注意：`setup` 工具没有 `params`，宿主不会替你补默认值。`run()` 里请自行为缺失的键补默认值——
> 内置插件用同一张默认值表同时初始化面板和兜底 `ctx.params`。

#### 画布：像素级交互的出口

声明式组件画不了裁剪框、签名板、标注。`canvas` 节点把一块**真正的 `OffscreenCanvas`**
从宿主页面转交进沙盒，你直接在上面画——没有像素会被拷贝回来，而你依然碰不到页面的其它部分。

```js
ui.render({ nodes: [{ type: 'canvas', id: 'stage', aspect: 16 / 9, interactive: true }] })

const canvas = await ui.canvas('stage')          // 渲染后才会到手
const g = canvas.getContext('2d')

ui.on('pointer', (id, p) => {                     // p = { type: 'down'|'move'|'up', x, y, buttons }
  g.fillRect(p.x - 2, p.y - 2, 4, 4)
})
```

- 画布尺寸在转交时按容器大小 × 设备像素比确定，之后不能从宿主侧改变；
- 节点被 `when` 隐藏再显示、或组件树结构变化导致重新挂载时，宿主会转交一块**新的**画布，旧的 `OffscreenCanvas` 不再显示。
  需要保持画面的插件应监听 `ui.on('canvas', …)` 重画，而不是只在 `await ui.canvas(id)` 之后画一次（v2.2）；
- `move` 事件每帧最多一次，拖拽不会淹没消息通道；
- 完整的「框选标注」示例见编辑器的「自定义界面」模板。

---

## 执行 `run(ctx)`

| 字段 | 说明 |
| --- | --- |
| `ctx.inputs` | `FileRef[]` |
| `ctx.params` | 表单值，或面板的绑定状态 |
| `ctx.signal` | `AbortSignal`，用户取消时触发 |
| `ctx.throwIfAborted()` | 已取消则抛错；长循环里每轮调一次 |
| `ctx.progress(value, label?)` | `value` 为 `0..1` 或 `null`（不确定进度），节流至约 20 次/秒 |
| `ctx.host` | 宿主 API。**在 `run` 里优先用它而不是全局 `host`**：FFmpeg、模型下载的进度会汇报到这次任务，取消也会传递过去 |

`FileRef = { id, name, size, type }`，**只有 `id` 是有效句柄**。

返回 `{ outputs: [fileId…], summary }`。`summary` 写得具体些：「657.6 KB → 6.0 KB（-99.1%）」比「处理完成」有用得多。

---

## 宿主 API

每个命名空间对应一个能力，未授权的调用在宿主侧被拒绝。

### `fs` —— 文件

可访问范围：本次调用的输入、当前面板的输入、本插件创建的输出。仅此而已。

```js
await host.fs.read(id, offset = 0, length = -1)   // → Uint8Array
await host.fs.readAll(id) / readText(id) / readJSON(id) / blob(id, type?)
await host.fs.create(name, type?)                 // → FileRef，打开写入
await host.fs.write(id, data)                     // 追加（复制）
await host.fs.writeTransfer(id, data)             // 追加（转移，更快，data 随后失效）
await host.fs.close(id)                           // → FileRef
await host.fs.writeAll(name, data, type?)         // create + write + close
await host.fs.remove(id)                          // v2：删除自己创建的中间文件
await host.fs.digest(id, 'SHA-256')               // v2：十六进制摘要（替代沙盒里不存在的 crypto.subtle）
```

### `ui` —— 通知

```js
await host.ui.notify(message, 'info' | 'success' | 'warn' | 'error')
```

### `net` —— 网络（高风险）

```js
await host.net.fetch(url, { method, headers, body })   // → { status, ok, headers, body: Uint8Array }
await host.net.fetchText(url, init) / fetchJSON(url, init)
```

- 强制 `credentials: 'omit'`，**请求永远不会带上用户的 Cookie**；
- 仅 `http:` / `https:`，响应上限 64 MB；
- 默认阻止 localhost 与内网地址（用户可在设置中放行）；
- 可在请求头或文本请求体中使用 `{{secret:名字}}` 引用凭据，见下。

### `kv` —— 插件私有存储

```js
await host.kv.get(key) / set(key, value) / remove(key) / keys()
```

命名空间对每个插件私有，**在磁盘上加密保存**（AES-GCM，密钥为不可导出的 `CryptoKey`）。
单值上限 256 KB。用于偏好设置，**不要存凭据**——插件能读回 `kv` 的值。

### `secret` —— 凭据保管（v2）

API Key 这类东西，如果插件能读到，就能把它塞进一个发往任意地址的请求里上传。
所以凭据是**封存**的，而不仅仅是加密的：

1. **插件从来拿不到明文。** `request()` 由宿主绘制输入框，用户输入，插件只得到 `true`/`false`。
2. **插件只能按名字引用。** 在 `host.net.fetch` 的请求头或文本请求体里写 `{{secret:apiKey}}`，宿主在发送时替换。
3. **凭据绑定域名。** 录入时就要声明 `origins`，用户在对话框里看到完整名单后才保存。发往名单之外的请求，**即使插件有网络权限也会被拒绝**。

```js
await ctx.host.secret.request('apiKey', {
  label: 'DeepL API Key',
  hint: '在 deepl.com/account 获取',
  origins: ['https://api-free.deepl.com'],
})

await ctx.host.net.fetch('https://api-free.deepl.com/v2/translate', {
  method: 'POST',
  headers: { Authorization: 'DeepL-Auth-Key {{secret:apiKey}}' },
  body: JSON.stringify({ text: ['hello'], target_lang: 'ZH' }),
})
```

```js
await host.secret.has(name)
await host.secret.list()      // 只有元数据，没有值
await host.secret.remove(name)
```

需要同时申请 `net` 与 `secret`——两种不同的权力，分两次授权。

**这个设计挡住了什么，没挡住什么：** 挡住了「插件把密钥发到自己服务器」。
没挡住「批准的那个服务器本身把密钥回显给插件」——域名绑定限定了影响范围，但无法消除对目标服务的信任。

### `image` —— 宿主侧 Canvas（兜底）

```js
await host.image.probe(id)           // → { width, height }
await host.image.transcode(id, opts) // → { width, height, type, body }
await host.image.encoders()          // → ['image/png', …]
```

优先在沙盒里用 `OffscreenCanvas`。

### `ffmpeg` —— 本地音视频（v2 正式可用）

```js
const { files, log } = await ctx.host.ffmpeg.run({
  args: ['-i', '$in0', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '$out0'],
  inputs: [ctx.inputs[0].id],
  outputs: ['audio.mp3'],
  label: '提取音轨',
})
```

- 用 `$in0`、`$in1`… 引用输入，`$out0`… 引用输出。**你写不出任何宿主没挂载的路径**；
- 输出名含 `%04d`（如 `frame-%04d.jpg`）表示图像序列，写出的每一帧都会被收集；
- 输出直接落在工作区，`files` 是 `FileRef[]`——2 GB 的转码结果不会进入你的内存；
- 多个任务共用一个 FFmpeg 实例并串行排队；
- **线程数由宿主管理，不要自己加 `-threads`**（见下）。

```js
await ctx.host.ffmpeg.probe(id)
// → { durationSeconds, width, height, videoCodec, audioCodec, log }
```

> **为什么不要自己设线程数**：ffmpeg.wasm 的多线程核心预先创建固定 32 个线程 worker。
> FFmpeg 默认按 CPU 核数开线程，在多核机器上（例如 28 核：x264 约 42 线程 + 解码器 29 线程）会超出线程池。
> 线程池耗尽后，新线程需要执行 `exec` 的那个事件循环来创建 worker，而它正被 `exec` 阻塞——任务永久卡死、没有任何报错。
> 宿主会按输入输出数量分配线程预算以避免这种情况。

### `onnx` —— 本地模型推理（v2）

```js
const session = await ctx.host.onnx.load({
  id: 'u2netp',
  name: 'U²-Net (portable)',
  url: 'https://…/u2netp.onnx',
  sha256: '…64 位十六进制…',   // 必填
  bytes: 4_600_000,
  license: 'Apache-2.0',
})

const info = await ctx.host.onnx.info(session)     // → { inputs, outputs }
const out = await ctx.host.onnx.run(session, {
  input: { type: 'float32', dims: [1, 3, 320, 320], data: float32Array },
})
await ctx.host.onnx.release(session)
```

- 模型**首次使用时**弹出宿主确认框，显示来源、体积、SHA-256 与许可，用户同意后才下载；
- 下载后缓存在本机，**每次加载都重新校验 SHA-256**；
- 推理在宿主的专用 Worker 上运行（不占 UI 线程），检测到可用的 WebGPU 适配器时优先使用，否则走多线程 wasm；
- 会话按插件隔离，一个插件无法驱动另一个插件的模型；插件沙盒被回收时会话随之释放。

#### 保留张量：自回归解码不再来回拷贝（v2.2，新增，非破坏性）

解码器每一步都要把 KV 缓存喂回模型。以 Whisper base 为例，交叉注意力缓存约 37 MB，
逐 token 在「沙盒 → 宿主 → 推理 Worker」之间来回复制会让拷贝时间超过推理本身。
`run` 的第三个参数让输出**留在推理 Worker 里**，插件只拿到一个句柄：

```js
const first = await host.onnx.run(decoder, feeds, {
  keep: ['present.0.decoder.key', /* … */],   // 这些输出不回传数据，返回 { type, dims, tensor: 't17' }
  outputs: ['logits', 'present.0.decoder.key', /* … */],  // 只计算需要的输出（默认全部）
})
const next = await host.onnx.run(decoder, {
  input_ids: { type: 'int64', dims: [1, 1], data: BigInt64Array.of(token) },
  'past_key_values.0.decoder.key': { tensor: first['present.0.decoder.key'].tensor },  // 句柄直接作为输入
}, { keep: [/* … */] })
await host.onnx.dispose([first['present.0.decoder.key'].tensor])   // 用完释放
```

- 句柄与会话一样**按插件隔离**：别的插件的句柄会被当作不存在；
- 每个插件最多同时保留 4096 个张量，超过时 `run` 报错，提示先 `dispose`；插件沙盒回收时全部释放；
- `keep` / `outputs` 里写了模型不存在的输出名会直接报错，而不是静默忽略。

---

## 依赖

```js
deps: [
  { id: 'pdf-lib', url: 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js', global: 'PDFLib', integrity: 'sha384-…' },
]
```

宿主拉取、校验 SRI、缓存，并在你的代码**之前**注入。依赖必须是经典脚本（UMD/IIFE），因为注入方式是求值源码，不是 `import`。

**依赖获得与插件完全相同的权限**，安装弹窗会明确告知用户。

> 注入方式是间接 `eval`。若打包产物以 `"use strict"` 开头，顶层 `var X` **不会**成为全局变量，
> 请在文件末尾显式写 `globalThis.X = X`。声明了 `global` 的依赖执行后若没有定义该全局，宿主会直接报出这个原因。

### 按需加载与二进制资源（v2.1，新增，非破坏性）

体积大、且只有部分工具用得到的库（例如 14 MB 的 WebAssembly），可以声明为 `lazy`，并附带二进制资源：

```js
deps: [
  {
    id: 'magick',
    url: '/vendor/magick/magick.js',
    global: 'MagickWasm',
    lazy: true,
    assets: { 'magick.wasm': { url: '/vendor/magick/magick.wasm', integrity: 'sha384-…' } },
  },
],

async run(ctx) {
  const { exports, assets } = await loadDependency('magick')   // 首次调用才拉取，之后复用
  await exports.initializeImageMagick(new Uint8Array(assets['magick.wasm']))
}
```

- `loadDependency(id)` 返回 `{ exports, assets }`：`exports` 是脚本定义的全局，`assets` 是 `名称 → ArrayBuffer`；
  并发调用共享同一次加载，失败后下次调用会重试。非 `lazy` 的依赖也可以用它取回自己的 `assets`。
- 资源与脚本同样由宿主拉取、按 `integrity` 校验（每次加载都校验），单个资源上限 64 MB。
- **只能加载安装时清单里声明过的依赖。** 宿主以安装记录（用户审查过的那份）为准，而不是沙盒启动时自报的清单——
  插件代码先于自报清单运行，理论上可以伪造它。
- 同源依赖（如 `/vendor/…`）不写入 IndexedDB 缓存，随应用部署更新；跨源依赖按 URL + integrity 缓存，支持离线。

---

## 能力一览

| 能力 | 风险 | 授予后允许 |
| --- | --- | --- |
| `fs` | 低 | 读取输入、写出结果 |
| `ui` | 低 | 通知 |
| `image` | 低 | 宿主 Canvas 编解码 |
| `ffmpeg` | 低 | 本地 FFmpeg |
| `onnx` | 低 | 本地模型推理（下载需用户逐次确认） |
| `kv` | 中 | 加密的私有存储 |
| `secret` | 中 | 请用户录入凭据；只能引用、不能读取 |
| `net` | **高** | 向外部发请求——**用户文件可能因此离开本机** |

只申请你真正用到的。安装审查会标出「声明了但没用到的高风险能力」和「用到了但没声明的能力」。

---

## 调试

- 插件里的 `console.log` / `warn` / `error` 转发到宿主控制台，带插件名前缀；
- 编辑器右侧实时显示解析出的清单、静态扫描结果和注册错误；
- 「插件与订阅 → 编辑源码」直接修改已安装的本地插件；
- 「设置 → 诊断」显示沙盒隔离层级、FFmpeg 核心、ONNX 执行后端与宿主 API 全表。

---

## 版本与变更

当前 `PLUGIN_API_VERSION = 2`。

### v1 → v2

全部为**新增**，v1 插件无需修改即可运行。

- 工具：`setup(ui)`、`input`、`textFileName`
- 能力：`secret`、`onnx`；`ffmpeg` 从预留变为可用
- `fs`：`remove`、`digest`
- `kv`：改为加密存储（对插件透明）
- 分类：新增 `archive`
- 协议：`call` 消息携带调用 id，宿主侧进度与取消可以准确归属到任务

### v2 增补（第 3 轮，均为新增）

- 依赖：`lazy`、`assets`、沙盒内全局函数 `loadDependency(id)`
- 界面节点：`media`（可视化音视频编辑）、`reorder`（排序列表）；`timeline` 保留，等价于只绑定 `range` 的 `media`
- 界面状态中的数字数组上限从 16 提升到 256（标记点、片段顺序）
- 文件名可以包含相对路径（`docs/a.txt`）：宿主逐段清洗（去掉 `.`、`..`、控制字符），「打包下载 ZIP」保留目录结构
- 清单 `apiVersion` 如实标记为 2（此前运行时误标为 1）

### v2.2 增补（第 4 轮，均为新增）

- `onnx.run(session, feeds, { keep, outputs })`：输出可保留在推理 Worker 中并以句柄返回，句柄可直接作为输入；新增 `onnx.dispose(tensors)`
- 界面事件 `ui.on('canvas', (id, canvas, state) => …)`：画布被（重新）转交时触发
- 平台功能「工作流」只调用工具已有的 `run(ctx)`，不需要插件做任何适配；带 `setup(ui)` 的工具不能加入工作流（它们的参数来自交互）

### 已在考虑的变更

把 `fs` 的可见范围从「插件级」收紧到「调用级」（同一插件并发的两次调用互相不可读）。
v2 的协议已经让每个宿主调用都带上了调用 id，这一收紧现在只需改宿主侧，**不再是破坏性变更**。
