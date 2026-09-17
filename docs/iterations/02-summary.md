# 第 2 轮迭代总结

> 面向：项目负责人。回答「这一轮做了什么、为什么这样做、还剩什么」。

**范围**：官方 shadcn-vue 组件、工具矩阵扩充与对齐、FFmpeg / ONNX / 加密存储三项新能力、第 1 批可用性改造
**状态**：已完成，端到端 53/53、单元测试 30/30 通过

---

## 一、本轮确认的关键决策

| 决策 | 选定方案 |
| --- | --- |
| UI 组件来源 | shadcn-vue CLI 官方组件，预设 `axQyYxO`（reka-luma / mauve / Roboto）；只在官方不满足时做最小改装并在文件内标注 |
| 插件自定义界面 | 声明式组件树（宿主用真实 shadcn 组件渲染）+ 可转交的 OffscreenCanvas |
| 图片处理引擎 | 接入 magick-wasm，与 Canvas 双引擎（**第 2 批实施，本轮未做**） |
| 本轮优先级 | 先做可用性：插件界面、编辑器、文本直输、音视频预览与时间轴 |

---

## 二、交付内容

### 1. 组件体系换成官方 shadcn-vue

- 删除全部手写原语，改用 CLI 安装的 Select / Slider / Switch / Dialog / Command / Sonner / ToggleGroup / Tabs / DropdownMenu 等。Select 不再是浏览器原生样式。
- 仅两处改装，均在文件中标注 `LOCAL ADDITION / MODIFICATION`，以便 `add --overwrite` 后重新施加：
  - `badge`：新增 `success` / `warning` 变体
  - `progress`：`modelValue: null` 表示不确定进度
- 命令面板没有改官方组件，而是直接组合底层 reka `ListboxFilter`，避开 `CommandInput` 自带的子串过滤，保留子序列匹配。
- 预设的远程 Google Fonts 换成 `@fontsource-variable/roboto` 自托管：同一款字体，离线可用、不向第三方泄露访问。

### 2. 工具：从 3 个到 39 个

| 插件 | 工具数 | 内容 |
| --- | ---: | --- |
| 图片工具箱 | 12 | 压缩转换、缩放、裁剪、旋转翻转、调色滤镜、水印、边框圆角、拼图、切图、图标生成、转 PDF、信息与配色 |
| PDF 工具箱 | 11 | 合并、拆分提取、页面重排、旋转、水印页码、多页合一、转图片、提取文本、压缩、元数据、解除密码 |
| 音视频工具箱 | 10 | 转码、压缩、**时间轴裁剪**、提取音轨、音频处理、画面处理、转 GIF、抽帧、合并、媒体信息 |
| 数据与文本工具箱 | 6 | 结构化数据互转、JSON 格式化、CSV 处理、Markdown、文本处理、编码与哈希 |

与三个参考项目的逐项对齐见 [`docs/design/03-tool-matrix.md`](../design/03-tool-matrix.md)：
去重后共 126 种操作，已实现 44，浏览器内可行待做 66，需大型 wasm 8，纯浏览器不可行 8（主要是 Office / CAD）。

### 3. 新能力

- **`ffmpeg`**：宿主侧 FFmpeg (WASM)。`$inN / $outN` 占位符、图像序列输出、串行队列、按任务归属的进度与取消、**线程预算**。
- **`onnx`**：onnxruntime-web，模型按 URL + SHA-256 标识，首次使用由宿主弹窗确认下载，缓存在 OPFS 并每次加载校验，推理跑在代理 Worker 上。
- **`secret`**：封存式凭据。插件只能请求录入、按名字引用，**永远读不到明文**；每个凭据绑定用户批准的域名，发往其他地址的请求一律拒绝。
- **`kv`** 改为 AES-GCM 加密存储，密钥为不可导出的 `CryptoKey`。
- **`fs`** 新增 `remove`（清理自己的中间文件）与 `digest`。

### 4. 可用性

- **插件自定义界面**：`setup(ui)` 描述组件树；18 种节点，含 `preview`、`timeline`（播放 + 波形 + 双柄选区 + 播放选区）与可交互 `canvas`。
- **插件编辑器**：Monaco + 完整 Plugin API 类型声明（`sdk/omnitool-plugin.d.ts`），补全、悬停文档、类型检查、实时清单校验、四套模板、`Ctrl/⌘ S` 保存安装。
- **导入入口**：两个 1:1 方形按钮——「导入插件」「创建新插件」。
- **文本直输**：数据与文本类工具支持直接粘贴；单个文本结果内联显示并可一键复制。
- **任务队列**从浮窗改为参与布局的底部栏。

---

## 三、过程中定位并修复的问题

这一轮的问题大多隐蔽，记录下根因，避免再踩。

### 1. CSS 整体失效
**现象**：初始化 shadcn-vue 后主色全部消失。
**根因**：token 从 HSL 三元组改成了 OKLCH，但 `settings.ts` 运行时仍往 `<style id="omnitool-theme">` 写 `--primary: 231 68% 56%`；`@theme inline` 以 `var(--primary)` 直接消费，于是得到非法颜色。该覆盖层优先级最高，所以无论 CLI 生成什么都会被盖掉。
**修复**：覆盖层改写 OKLCH，且默认不覆盖（沿用预设）；设置存储键升到 v2 丢弃旧值；在 CSS 注释中写明色彩空间约束。

### 2. hover 出现大块饱和绿色
**根因**：`luma` 预设中 `--accent` 就是主色（`menuAccent: bold`），而应用组件按「accent = 中性浅色」写了 `hover:bg-accent`。
**修复**：中性 hover 改用 `muted`，与官方 Button `ghost` 变体一致。

### 3. 开发模式下 FFmpeg 报 `NS_ERROR_CORRUPTED_CONTENT`
**根因**：Vite 依赖预构建会改写 `@ffmpeg/ffmpeg` 内 `new Worker(new URL('./worker.js', import.meta.url))`，并以空 MIME 类型提供；排除预构建后，Vite 又会转换 worker 并把其中的动态 `import(coreURL)` 改写成一个随即被中止的 `?import` 请求。
**修复**：vendor 脚本用 esbuild 把 FFmpeg 的 worker 预打包到 `public/`，通过 `classWorkerURL` 指向它；Vite 原样提供，不再转换。同时改用 ESM 版核心（模块 worker 里 `importScripts` 不存在，库会回退到 `import()`）。

### 4. 多线程 FFmpeg 卡死（第一层）
**现象**：纯音频任务正常，H.264 编码无进度、无报错、永不结束。
**根因**：库把 `coreURL` 拼进 `mainScriptUrlOrBlob` 传给每个 pthread worker，pthread worker 用 `import()` 加载它；而这些 worker 是以经典模式创建的，**经典 worker 无法解析根相对的模块路径**（`/vendor/...`）。线程起不来，主线程永远等待线程池。
**定位**：在浏览器里单独起一个经典 worker 分别 `import()` 根相对路径与绝对路径，前者报 `Failed to resolve module specifier`，后者成功。
**修复**：核心地址改为绝对 URL。

### 5. 多线程 FFmpeg 卡死（第二层）
**现象**：修复 4 之后线程能起来了，720p 转码依旧卡死。
**根因**：ffmpeg.wasm 多线程核心预先创建**固定 32 个** pthread worker。FFmpeg 默认按核数开线程，本机 28 核：x264 约 42 个帧线程，H.264 解码器约 29 个。线程池耗尽后，Emscripten 需要执行 `exec` 的那个事件循环去创建新 worker，而该循环正被同步的 `exec` 阻塞——永久死锁。
**为什么难发现**：只在核数足够多、能撑爆线程池的机器上复现，4 核笔记本上一切正常。
**定位**：统计线程 worker 数量（稳定停在 32）、读取核心源码中的 `pthreadPoolSize=32`、对比 `navigator.hardwareConcurrency`，再二分线程预算：每路 8 线程仍卡死，每路 4 线程且总量不超过线程池一半时稳定完成。
**修复**：宿主在转发 argv 前为每个输入、每个输出和滤镜图注入 `-threads` 与 `-filter_threads`，对所有插件透明，插件自己设置的 `-threads` 不被覆盖。

> 这一项最初的处理是**把多线程默认关掉、加一个设置开关**。这是用开关掩盖问题，被指出后才去定位根因。
> 最终保留了开关，但仅作为兜底，默认开启多线程。

### 6. 沙盒里没有 `crypto.subtle`
**根因**：不透明来源不是安全上下文，WebCrypto 的 `subtle` 接口在沙盒内根本不存在（`getRandomValues` 仍可用）。宿主页是安全上下文，所以在宿主上测永远发现不了。
**修复**：新增 `host.fs.digest`，并写入 API 文档与类型声明，提醒第三方作者。

### 7. 沙盒里没有 `DOMParser`
**根因**：沙盒主层级是 Worker，Worker 没有 `DOMParser`。
**修复**：数据工具自带 XML 解析器（声明、注释、CDATA、属性、实体、自闭合标签）。

### 8. 任务浮窗挡住运行按钮
**根因**：浮窗与参数面板都在右下角，参数面板是 sticky 的，无法被滚出浮窗下方；任务越多浮窗越高，冲突越严重。调整高度与内边距只是移动了冲突位置。
**修复**：任务队列改为参与布局的底部栏，从结构上消除遮挡；参数卡片内部滚动、运行按钮固定在卡片底部。

### 9. 其他
- pdf.js v6 的 `destroy()` 在加载任务上而非文档对象上。
- `OffscreenCanvas` 不可结构化克隆，沙盒 frame 转发时必须列入 transfer 列表。
- Vue 模板中的箭头函数会丢失 `v-else-if` 的类型收窄，改为脚本中的计算属性。

---

## 四、验证结果

| 套件 | 结果 | 覆盖 |
| --- | --- | --- |
| smoke | 14/14 | 沙盒隔离、越权拦截、OPFS、跨源隔离 |
| tools | 22/22 | 数据 4、图片 5、PDF 5、FFmpeg 6（含多输入 filter_complex 与双遍 GIF）、控制台无错 |
| ui | 9/9 | 粘贴 YAML 转 JSON 内联输出、插件面板空状态、时间轴渲染与选区、按选区精确导出 |
| editor | 8/8 | 方形入口、Monaco 加载、`host.fs.` 补全、实时清单、保存安装跳转、画布拖拽交互、面板状态传入执行 |
| 单元 | 30/30 | 线程预算、凭据域名绑定与加密落盘（含仿冒域名与变异验证）、界面树清洗 |

详见 [`docs/testing/02-test-scenarios.md`](../testing/02-test-scenarios.md)。

---

## 五、已知限制

- **图片仍是 Canvas 引擎**：GIF 动画、EXIF 方位、ICC 配置文件会丢失，HEIC/TIFF/PSD 不能解码。已决定第 2 批接入 magick-wasm。
- **还没有任何 AI 工具**：`onnx` 能力与下载确认、缓存、校验链路已完成，但尚未接入具体模型。
- **仅在 Chromium 上验证**。
- 同一插件并发的两次调用共享文件可见范围（协议已携带调用 id，收紧只需改宿主侧）。
- 画布转交后尺寸固定，容器变化时需要插件重新渲染该节点。
- 时间轴波形对超过 200 MB 的文件不绘制（避免整个文件解码进内存）。

---

## 六、下一批（第 2 批）

1. **magick-wasm 双引擎**：动图保真、EXIF/ICC、HEIC/TIFF/PSD，重写图片工具的编码路径。
2. **ONNX 首批模型**：去背景、超分辨率、OCR（含 PDF OCR）。
3. **归档工具**：创建 / 解压 ZIP、TAR/GZ。
4. **PDF 轻量补齐**：表单扁平化、移除注释、删除空白页、提取图片、叠加、附件。
5. 用新的画布面板改造更多工具：图片裁剪框选、PDF 裁剪/签名/加图、视频水印定位。
