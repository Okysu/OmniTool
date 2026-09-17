# 第三方开源许可声明

OmniTool 自身代码库遵循 [MIT 许可证](LICENSE) 开源。

在构建产物（`dist/`）中，集成了若干第三方开源软件包及运行时组件；此外在项目构建或应用首次启动时，还会根据具体业务调度按需加载外部资源。上述组件均受其各自原作者的开源许可证管辖，**其版权与许可范围不因被 OmniTool 集成而发生任何改变**。

本文档汇总梳理了核心组件的来源与授权范畴，具体版本以实际构建时的 `pnpm-lock.yaml` 为准。完整的开源许可全文随各依赖包分发，亦可在 `node_modules/<包名>/LICENSE` 或其对应官方仓库中核对。

## 一、GPL 开源组件：FFmpeg WebAssembly 运行核心

| 运行时核心 | 固化版本 | 开源协议 | 产物分发路径 |
| --- | --- | --- | --- |
| `@ffmpeg/core`（确定性单线程核心） | 0.12.10 | GPL-2.0-or-later | `dist/vendor/ffmpeg/` |
| `@ffmpeg/core-mt`（多线程并行核心） | 0.12.10 | GPL-2.0-or-later | `dist/vendor/ffmpeg-mt/` |

上述两个 WebAssembly 运行时核心由 [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) 组织基于 `--enable-gpl` 编译参数生成，内部链接了 FFmpeg 框架及其所依赖的 x264、libass 等受 GPL/LGPL 约束的算法库。

- **隔离分发声明**：OmniTool **未对这两个 Wasm 核心文件的二进制进行任何重写或反编译修改**。它们作为独立的外部静态资产存储，在前端运行时按需被浏览器 Worker 加载执行，不与 OmniTool 的应用层业务逻辑进行动态/静态编译链接。因此，OmniTool 自身应用层代码的 MIT 授权完整有效。
- **源码开放获取路径**：对应版本的全套构建流程与依赖源码已在 ffmpeg.wasm 官方仓库的 [`v0.12.10` Release 标签](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10) 中公开；FFmpeg 官方源码见 [ffmpeg.org](https://ffmpeg.org/download.html)。
- **二次分发义务提示**：若你在分发部署（包括云端自建站点部署）中包含了上述两个核心二进制，你须同样遵循 GPL 协议对最终接收方的要求：完整保留本许可声明，并提供获取对应核心源码的公开渠道。若你的交付场景明确要求规避 GPL 软件，可在构建前于 `scripts/vendor.mjs` 中剔除这两个模块；此操作仅会导致音视频相关的高阶转码工具停用，应用内的其余非音视频模块不受任何影响。

## 二、内置于构建产物中的第三方运行时与依赖

### 应用层框架与交互组件

| 依赖库名称 | 开源许可证 |
| --- | --- |
| Vue 3、vue-router、@vueuse/core | MIT |
| reka-ui、shadcn-vue 组件体系、vue-sonner | MIT |
| Tailwind CSS、tw-animate-css、tailwind-merge、clsx | MIT |
| class-variance-authority | Apache-2.0 |
| @lucide/vue（矢量图标） | ISC |
| monaco-editor（内置代码工作台） | MIT |
| idb-keyval | Apache-2.0 |
| markdown-it、markdown-it-footnote | MIT |
| markdown-it-task-lists | ISC |
| Roboto 字体家族（@fontsource-variable/roboto） | OFL-1.1 |

### 端侧计算与能力封装（`dist/vendor/` 运行时目录）

| 依赖组件 | 功能用途 | 开源许可证 |
| --- | --- | --- |
| @ffmpeg/ffmpeg、@ffmpeg/util | 宿主层 FFmpeg 调度封装 | MIT |
| onnxruntime-web | 本地深度学习网络推理加速引擎 | MIT |
| @imagemagick/magick-wasm | 专业图像处理底盘（ImageMagick 引擎） | Apache-2.0（ImageMagick 专属授权） |
| pdfjs-dist（pdf.js） | PDF 高精度渲染与正文提取 | Apache-2.0 |
| pdf.js 资源包 `pdfjs-data`（随 pdfjs-dist 分发） | Adobe CMap（未嵌入字体的中日韩文字解码）；Foxit 标准字体程序；OpenJPEG 与 JBIG2 图像解码器 wasm（扫描件常用的 JPEG 2000 / JBIG2 图像） | CMap：BSD-3-Clause（Adobe）；Foxit 字体：BSD-3-Clause（PDFium）；OpenJPEG：BSD-2-Clause；JBIG2：BSD-3-Clause（PDFium），pdf.js 封装 Apache-2.0。未包含 Liberation 字体 |
| pdf-lib、@pdf-lib/fontkit | PDF 页面重排、表单修改与字体子集化 | MIT |
| @neslinesli93/qpdf-wasm | PDF 线性化、加解密与结构修复（qpdf 衍生） | ISC（上游 qpdf 核心为 Apache-2.0） |
| libarchive-wasm | 7z、RAR 多协议高压缩比归档解析 | MIT（上游 libarchive 核心为 BSD-2-Clause） |
| zxing-wasm | 一维条形码 / 二维码多协议矩阵编解码 | MIT（上游 zxing-cpp 核心为 Apache-2.0） |
| xlsx（SheetJS 社区版） | 纯前端电子表格解析与构建 | Apache-2.0 |
| fflate | 极致轻量的高性能 ZIP / GZIP 压缩流 | MIT |
| fft.js | 声谱图的快速傅里叶变换 | MIT |
| yaml | YAML 标准格式序列化与解析 | ISC |
| papaparse | 工业级 CSV 大文本流式解析 | MIT |
| fast-xml-parser | 纯 JS 实现的轻量 XML 处理器 | MIT |
| postal-mime | 标准 RFC 822 EML 邮件协议解析 | MIT-0 |
| @kenjiuno/msgreader | 微软 Outlook MSG 专有格式解析 | Apache-2.0 |
| fonteditor-core | 网页字体跨格式转换与 Woff2 Wasm 压缩 | MIT |
| imagetracerjs | 栅格位图高精度转 SVG 矢量追踪 | Unlicense（公有领域） |
| buffer、string_decoder | 现代浏览器对 Node.js 基础二进制的兼容垫片 | MIT |

## 三、构建流水线拉取的外部静态资产

执行 `pnpm vendor` 时，系统依据硬编码的固定 SHA-256 哈希完整性校验拉取以下外部文件，并注入至 `dist/vendor/` 产物结构中：

| 资产名称 | 权威发布来源 | 许可证标准 |
| --- | --- | --- |
| Noto Sans SC Regular（思源黑体） | Google Fonts 官方仓库 | SIL Open Font License 1.1 |
| Whisper 词表文件（解析自 tokenizer.json） | Hugging Face 组织 `onnx-community/whisper-base` | MIT（基于 OpenAI Whisper 授权） |

## 四、端侧 AI 运行时按需加载的模型权重（不随软件分发）

所有端侧 AI 工具所依赖的预训练网络权重**均不包含在 OmniTool 的代码包或默认构建产物中**。
当用户在前端首次触发相关功能时，应用会弹窗提示模型体积、用途及开源协议，**经用户显式确认授权后**，浏览器才会通过分片请求从 Hugging Face（或用户指定的镜像服务）直接下拉权重至本机的 OPFS 私有缓存中。模型资产相关的权益遵循其原作者的开源授权协议：

| 预训练神经网络 | 场景用途 | 算法权重开源许可证 |
| --- | --- | --- |
| U²-Netp | 前景显著性检测、智能抠图与主体裁剪 | Apache-2.0 |
| IS-Net general | 超细粒度工业级精细抠图 | MIT |
| PP-OCRv4 文本检测/识别矩阵 | 复杂场景文本定位与文字 OCR | Apache-2.0 |
| Swin2SR lightweight ×2 | 图像结构增强与双倍超分辨率放大 | Apache-2.0 |
| YuNet 2023mar（OpenCV Zoo） | 极速面部关键点定位、人脸隐私遮蔽与去红眼 | MIT |
| MI-GAN | 画面冗余元素极速感知消除 | MIT |
| LaMa（Carve 导出版本） | 大范围画面元素深度纹理填充与消除 | Apache-2.0 |
| Whisper base / small | 多语言离线端侧高精度语音转文字 | MIT |

## 五、自动化测试素材声明

以下资源仅供本地单元测试与端到端回归套件调用，不会被打包进任何面向终端用户的分发产物：

- `tests/fixtures/archives/` 下的 7z、RAR 及加密 ZIP 样本源自 [libarchive-wasm](https://github.com/ofk/libarchive-wasm) 官方测试套件（遵循 MIT 协议）。
- 端到端测试执行期间所下载的 YuNet 样本人像（MIT 协议）与 JFK 就职演说音频切片（属于 Public Domain 公有领域）。