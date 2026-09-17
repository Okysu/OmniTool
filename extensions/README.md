# OmniTool 扩展

这里存放**随仓库维护、但不随 OmniTool 内置分发**的扩展插件。

OmniTool 的内置工具全部在本机运行，不产生任何外联流量。本目录中的扩展需要连接网络服务（云端大模型 API，或你在本机 / 内网运行的 Ollama、LM Studio 等），与这一默认承诺不同，因此只在你主动订阅后才会安装，并且安装时需要你逐项授权。

| 扩展 | 文件 | 说明 |
| --- | --- | --- |
| AI 扩展工具箱 | [`ai-toolkit.js`](ai-toolkit.js) | 连接任意 OpenAI 兼容接口的 21 个 AI 工具：翻译、摘要、信息抽取、视觉理解、目标检测打标、语音转写与合成等 |

## 订阅

在 OmniTool 中打开「插件与订阅 → 远程订阅」，粘贴以下任一地址：

```text
# 订阅整个扩展目录（今后新增的扩展会一并出现）
https://cdn.jsdelivr.net/gh/Okysu/OmniTool@main/extensions/index.json

# 只订阅 AI 扩展工具箱
https://cdn.jsdelivr.net/gh/Okysu/OmniTool@main/extensions/ai-toolkit.js
```

- **固定版本**：把 `@main` 换成发布标签（如 `@v0.6.0`），内容就不会随主分支变化。jsDelivr 会缓存分支地址的内容，推送后不一定立即生效；维护者可以访问 `https://purge.jsdelivr.net/gh/Okysu/OmniTool@main/extensions/ai-toolkit.js` 刷新缓存。
- **更新策略**：订阅刷新时，能力清单不变的更新会静默应用；如果新版本申请了新的能力，会暂停更新并交给你重新审查。订阅永远无法自行扩大权限。
- **自行托管**：`extensions/` 目录是纯静态文件，也可以放到 GitHub Pages、对象存储或内网服务器上。服务器需要返回 `Access-Control-Allow-Origin` 响应头。

## AI 扩展工具箱

### 安装时的授权

| 能力 | 用途 | 建议 |
| --- | --- | --- |
| `net` 网络请求 | 调用你配置的模型接口 | 必须 |
| `secret` 凭据保管 | 保存 API Key。插件**无法读回明文**，宿主只在请求发往你录入时指定的域名时才代为填入 | 使用云端服务时必须；只用本机 Ollama 可以不授权 |
| `kv` 本地存储 | 保存接口地址、模型名等连接设置（加密存储，不含 Key） | 必须 |
| `fs` / `ui` | 读取输入文件、写出结果、上报进度 | 必须 |
| `ffmpeg` | 语音转写前在本机提取并压缩音轨 | 用到「云端语音转写」时需要 |

`secret` 属于中风险能力，默认不勾选，请在审查对话框中手动开启。

### 配置连接

打开「AI 连接设置」工具：

1. **选择服务商**。预设会填好接口地址和常用模型名，你可以按需修改。
2. **录入 API Key**。宿主会弹出凭据对话框，Key 与当前接口的域名绑定，发往其他任何地址的请求都会被拒绝。以后更换服务商时，工具会提示你重新录入。
3. **点击「保存并测试连接」**。

| 预设 | Base URL | 说明 |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | 支持全部工具（包括语音与图像生成） |
| DeepSeek | `https://api.deepseek.com/v1` | 文本工具 |
| 阿里云百炼（通义千问） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 文本、视觉（`qwen-vl-max`）、向量 |
| 硅基流动 SiliconFlow | `https://api.siliconflow.cn/v1` | 文本、视觉、向量、SenseVoice 语音转写 |
| 智谱 BigModel | `https://open.bigmodel.cn/api/paas/v4` | 文本、视觉、向量 |
| 月之暗面 Kimi | `https://api.moonshot.cn/v1` | 文本工具 |
| OpenRouter | `https://openrouter.ai/api/v1` | 按所选模型的能力而定 |
| Ollama（本机） | `http://localhost:11434/v1` | 无需 Key |
| LM Studio（本机） | `http://localhost:1234/v1` | 无需 Key |
| 自定义 | 任意 OpenAI 兼容地址 | vLLM、Xinference、One API、自建网关等 |

模型分为六类：文本、视觉、向量、语音转写、语音合成、图像生成。只有文本模型是必填的；其他模型留空时，依赖它的工具会提示你补充（视觉模型留空时使用文本模型）。

### 使用本机模型（Ollama / LM Studio）

请求由浏览器直接发出，因此需要同时满足两个条件：

1. **在 OmniTool 中放行本机地址**：「设置 → 安全 → 允许插件访问本机与内网地址」。默认关闭，以防插件探测你的内网。
2. **让模型服务允许跨域访问**：
   - **Ollama**：设置环境变量后重启服务，例如 `OLLAMA_ORIGINS=* ollama serve`。更安全的做法是只填你访问 OmniTool 的地址，如 `OLLAMA_ORIGINS=https://your-omnitool.example.com`。
   - **LM Studio**：在 Developer → Server Settings 中开启 **Enable CORS**。
   - **其他服务**：需要返回 `Access-Control-Allow-Origin`，并允许 `Authorization`、`Content-Type` 请求头。

视觉类工具需要支持图片输入的模型，如 `qwen2.5vl`、`llama3.2-vision`、`minicpm-v`。

### 工具一览

**文本**

| 工具 | 说明 |
| --- | --- |
| AI 翻译 | 文本 / Markdown（代码块原样保留，不发送给模型）、SRT / VTT 字幕（逐条对齐，保留时间轴）、i18n JSON（只翻译值）。支持术语表与双语对照 |
| AI 摘要 | 超长文本先分段摘要再汇总，不受模型上下文长度限制 |
| AI 润色改写 | 纠错、正式化、口语化、精简、扩写、通俗化 |
| AI 信息抽取 | 按自定义字段从合同、简历、发票、邮件中抽取结构化数据，输出 JSON 与汇总 CSV |
| AI 文本分类 | 按自定义类别给文件或每一行打标签（情感分析、工单分流、意图识别） |
| AI 表格逐行处理 | 用 `{{列名}}` 模板对 CSV 每一行调用模型，结果写入新列 |
| AI 会议纪要 | 从转写稿或字幕整理摘要、决议、待办（负责人 / 截止时间）与未决问题 |
| AI 文档问答 | 对一批文档提问，回答附带引用段落。配置向量模型时按语义检索，否则按关键词（含中文二元组）检索 |
| AI 自定义提示词 | 用 `{{content}}`、`{{filename}}` 模板批量处理文件 |

**视觉**

| 工具 | 说明 |
| --- | --- |
| AI 目标检测打标 | 用视觉大模型框选目标，导出 COCO、YOLO、LabelMe 标注与带框预览图 |
| AI 图片描述 | 替代文本、详细描述、电商卖点、社交配文、训练标签；可为每张图生成同名 `.txt` |
| AI 图片 / PDF 转 Markdown | 把截图、扫描件与 PDF 页面转成保留标题、表格与公式的 Markdown |
| AI 看图问答 | 对每张图片提同一个问题，结果汇总成表 |
| AI 图片分类整理 | 按类别把图片分进文件夹（打包下载即为整理好的目录），或生成关键词 |
| AI 表格 / 图表转数据 | 表格截图、报表照片、柱状图 / 折线图还原成 CSV |
| AI 截图转网页 | 界面截图或手绘草图还原成单文件 HTML |
| AI 智能命名 | 根据内容为图片和文档生成描述性文件名（自动去重） |

**语音与图像生成**

| 工具 | 接口 | 说明 |
| --- | --- | --- |
| AI 云端语音转写 | `/audio/transcriptions` | 先在本机把音轨压缩为 32 kbps 单声道 MP3；超过 20 分钟自动分段，合并时校正时间轴 |
| AI 语音合成 | `/audio/speech` | 长文按句切分合成后拼接为一个 MP3 |
| AI 图像生成 | `/images/generations` | 兼容返回 `b64_json` 或 `url` 的服务 |

### 目标检测的坐标约定

提示词要求模型输出 **0–1000 归一化**的 `[x1, y1, x2, y2]`（左上角为原点），这是 Qwen-VL、GLM-4V 等模型训练时使用的格式。实际输出因模型而异，「模型坐标格式」默认的「自动识别」会按以下规则处理：

| 模型输出 | 识别依据 | 换算 |
| --- | --- | --- |
| `box_2d: [ymin, xmin, ymax, xmax]`（Gemini） | 键名 `box_2d` | 调换 x / y 后除以 1000 |
| 数值均 ≤ 1 | 值域 | 已是 0–1 归一化 |
| 数值均 ≤ 1000 | 值域 | 除以 1000 |
| 存在大于 1000 的数值（Qwen2.5-VL 的绝对坐标） | 值域 | 除以**发送给模型的图片**的宽高 |

也可以手动指定格式。框的字段兼容 `box`、`bbox`、`bbox_2d`、`box_2d`、`xmin/ymin/xmax/ymax`、`x1/y1/x2/y2`、`x/y/width/height` 等写法。坐标先归一化到 0–1，裁剪到画面内，并丢弃面积过小的框，然后再换算为各导出格式：

- **YOLO**：`类别序号 cx cy w h`，保持 0–1 归一化，附 `classes.txt`
- **COCO**：原图像素坐标 `[x, y, w, h]`
- **LabelMe**：原图像素坐标的矩形两点

发送给模型的图片会按「发送图片的最长边」缩放，导出的像素坐标始终对应**原图尺寸**。

> 大模型的定位精度不如专用检测模型。适合快速预标注、少样本数据集冷启动和质检，正式训练前请人工复核。

### 隐私与费用

- 你选择的文件内容（文本、图片、音频）会发送到你配置的模型服务，并受该服务的隐私政策约束。处理敏感资料时，请使用本机运行的模型。
- 调用云端服务会产生费用。批量任务的并发数可在「AI 连接设置」中调整（默认 2）。
- 每次使用凭据发起请求，宿主都会提示发往的域名；同一批任务的连续请求会合并为一条提示。
- API Key 由宿主加密保管，可在「AI 连接设置」中点击「删除 API Key」随时删除。卸载插件**不会**自动清除已保存的 Key，如不再使用，请先删除 Key 再卸载。

## 开发与测试

扩展使用与内置工具相同的 [Plugin API](../docs/design/02-plugin-api.md)，不依赖任何私有接口。

```bash
pnpm exec vitest run tests/ext-ai-toolkit.test.ts   # 单元测试：模拟 OpenAI 兼容接口
node e2e/run.mjs                                     # 端到端测试的 extensions 套件：真实订阅、授权、录入凭据与运行
```

新增扩展时，请在 [`index.json`](index.json) 中登记（`url` 相对于索引文件），并补充对应的测试。
