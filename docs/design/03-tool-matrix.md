# 工具矩阵：与 Stirling-PDF / SnapOtter / Transmute 的对齐

> 面向：项目负责人与参与开发的工程师。用于决定「下一批做什么」，以及哪些工具在纯浏览器架构下根本做不了。

调研基于三个项目的源码（2026-09-16 克隆）：

| 项目 | 规模 | 工具的实际来源 |
| --- | --- | --- |
| Stirling-PDF | 53 个 PDF 工具 | `frontend/editor/src/core/tools/*.tsx`，后端 Java + LibreOffice/qpdf/OCRmyPDF |
| SnapOtter | 243 条工具路由 | `llms.txt` 工具清单，后端 Fastify + Sharp/FFmpeg/qpdf/LibreOffice + Python AI sidecar |
| Transmute | 约 3000 种格式转换 | `backend/converters/*.py`：pillow、ffmpeg、libreoffice、pandoc、calibre、inkscape 等转换器的**格式矩阵展开** |

## 一、先说清楚「数量」

**「243 条路由」和「3000 种转换」不能按条数对齐，否则会做出几百个重复工具。**

- SnapOtter 的 243 条里，约 120 条是「JPG to PNG」「MOV to MP4」这类**格式对**落地页，背后是同一个 `convert`。
- Transmute 的 3000 种是 `输入格式 × 输出格式` 的笛卡尔积，由十几个转换器实现。

所以本项目按**操作**对齐，格式对作为参数：一个「视频转码」工具覆盖 MP4/MKV/MOV/WebM/AVI 两两互转的 20 种组合。
下文所有计数都是去重后的「操作」。

状态图例：

- ✅ 已实现
- 🔜 浏览器内可行，排入计划
- ⚠️ 技术上可行，但卡在一个需要负责人拍板的决定上（许可、模型来源、安全设计、默认离线原则），见「九」
- ❌ 纯浏览器内无法可靠实现，说明原因

---

## 二、PDF（对齐 Stirling-PDF 53 项 + SnapOtter PDF 分区）

| 能力 | 状态 | 实现 / 说明 |
| --- | --- | --- |
| 合并 Merge | ✅ | `omnitool.pdf/merge` |
| 拆分 / 提取页 Split, ExtractPages | ✅ | `split`：页码范围、每 N 页、逐页、对半 |
| 删除页 / 重排 RemovePages, ReorganizePages | ✅ | `organize`：删除、保留、自定义顺序、倒序、奇偶页 |
| 旋转 Rotate | ✅ | `rotate`，支持按页码范围 |
| 文字水印 AddWatermark | ✅ | `watermark` |
| 页码 AddPageNumbers | ✅ | `watermark` 内页码选项 |
| 多页合一 PageLayout (N-up) | ✅ | `nup`：2/4/6/9 合一 |
| PDF 转图片 / 长图 | ✅ | `to-image`：pdf.js 渲染，可拼长图 |
| PDF 转文本 / Markdown | ✅ | `to-text`：含坐标 JSON |
| 压缩 Compress | ✅ | `compress`：按 DPI 栅格化重编码（文字层会丢失，界面已明示）；无损的对象流压缩见 `linearize` |
| 元数据 ChangeMetadata, GetPdfInfo | ✅ | `metadata`：查看 / 写入 / 清空 |
| 移除密码 RemovePassword | ✅ | `unlock`：qpdf 按已知密码解密，去除打开密码与权限限制；密码错误明确提示 |
| 小册子拼版 BookletImposition | ✅ | `booklet`：骑马钉顺序、左右装订、爬移补偿，页数不足自动补空白 |
| 添加图片 / 印章 / 文字 AddImage, AddStamp, AddText | ✅ | `stamp`：页面预览上拖框定位，图片 / 手写签名 / 文字（中文字体子集嵌入），可应用到指定页；**旋转页面按显示方向放置** |
| 裁剪页面 Crop | ✅ | `page-layout` 按毫米裁边（改 CropBox，链接与表单保留） |
| 表单扁平化 Flatten | ✅ | `sanitize`；`fill-form` 填完可锁定 |
| 移除注释 RemoveAnnotations | ✅ | `sanitize`：批注与链接分开控制，表单控件不受影响 |
| 删除空白页 RemoveBlanks | ✅ | `remove-blanks`：无文字层**且**墨迹低于阈值才删，有一个字也保留 |
| 提取图片 ExtractImages | ✅ | `extract-images`：取嵌入原图而非整页截图，去重 |
| 叠加 PDF OverlayPdfs | ✅ | `overlay`：上方 / 下方、页面映射、不透明度 |
| 单页长图 PDF SingleLargePage | ✅ | `page-layout` 拼成单张长页 |
| 调整页面缩放 AdjustPageScale | ✅ | `page-layout`：缩放到 A3/A4/A5/Letter/Legal、加页边距 |
| 调整对比度 AdjustContrast | ✅ | `enhance-scan`：亮度、对比度、灰度、黑白二值化（处理过的页面被栅格化） |
| 替换颜色 ReplaceColor | ✅ | 工作流模板「PDF 替换颜色」：转图片 → `image/color-tools` → 合成 PDF（页面变为图片，模板说明中已提示） |
| 附件 AddAttachments | ✅ | `attachments`：添加与导出 |
| 目录书签 EditTableOfContents | ✅ | `bookmarks`：导出为可编辑文本，按缩进写回多级书签 |
| 比较 Compare | ✅ | `compare`：Myers 差分，按行或按词，输出可直接预览的 HTML 报告 |
| 查看内嵌脚本 ShowJS | ✅ | `inspect-security`：文档级脚本源码、自动动作、启动程序、外链、附件、XFA |
| 清理 Sanitize | ✅ | `sanitize` |
| 可视签名 Sign | ✅ | `stamp` 的手写签名板（笔迹平滑，按墨迹裁切成透明 PNG 嵌入） |
| 涂黑 Redact | ✅ | `redact`：框选 + 关键词 + 手机号 / 身份证 / 邮箱 / 银行卡自动识别；**含涂黑的页面整页栅格化**，底层文字被真正删除，并清空文档信息 |
| 自动重命名 AutoRename | ✅ | `auto-rename`：首页最大字号文字或文档属性标题 |
| 解锁表单 UnlockPdfForms | ✅ | `sanitize` 的「解除表单字段只读」；`fill-form` 填写时自动解除 |
| OCR / 可搜索 PDF | ✅ | `omnitool.ai/ocr`：PP-OCRv4；输出文本、带坐标 JSON、标注预览，或**可搜索 PDF**（原图 + 透明文字层，中文字体子集） |
| 自动旋转 AutoRotate | ✅ | `auto-rotate`：按文字层方向判断横躺 / 倒置页并设置旋转；无文字层的页面如实报告（可先 OCR） |
| 扫描件切分 ScannerImageSplit | ✅ | `omnitool.image/scan-split`：一次扫描多张照片时自动找出、摆正并分别导出 |
| 加密 AddPassword, ChangePermissions | ✅ | `protect`：qpdf-wasm，AES-256 / AES-128，打开密码、权限密码（留空随机生成）、打印 / 修改 / 复制权限 |
| 修复 Repair | ✅ | `repair`：pdf-lib 容错解析重建交叉引用表，qpdf `--check` 校验结果（该 qpdf 构建无法运行自身的恢复逻辑，见架构文档 12.3） |
| 网页优化 Linearize | ✅ | `linearize`：qpdf 线性化 + 可选对象流压缩 |
| 表单填写 formFill | ✅ | `fill-form`：列出文本 / 勾选 / 下拉 / 单选字段直接填写，中文值自动嵌入字体，可扁平化 |
| 自动识别表单 autoFormDetection | ❌ | 从扫描件推断字段位置需要版面分析模型，没有可用的开源许可模型 |
| 作品集 CreatePortfolio | ✅ | `attachments` 的「制作作品集」：Collection 字典，阅读器以文件列表打开 |
| 数字证书签名 CertSign, SharedSign | ⚠️ | PKCS#7 签名在浏览器可做；**证书与私钥存在哪里、如何授权插件使用**属于安全设计，需拍板（见「九」） |
| 验签 / 移除证书签名 ValidateSignature, RemoveCertificateSign | ⚠️ | 与证书签名一并设计 |
| 时间戳 TimestampPdf | ⚠️ | 必须向 TSA 服务器发请求，与「默认离线」原则冲突，需拍板是否作为显式联网的可选插件 |
| PDF/A 转换 | ❌ | 需要 Ghostscript + veraPDF 级别的合规处理；Ghostscript 为 AGPL，体积与许可都不适合默认内置 |
| PDF 文本编辑器 pdfTextEditor | ❌ | 真正改写 PDF 文字需要字体子集重排，浏览器内无成熟方案 |
| 自动化流水线 Automate | ✅ | **平台功能**「工作流」：多个工具串联，模板、导入导出，见架构文档 13 |
| PDF 转 Word / Office 转 PDF | ❌ | 见「七、Office」 |

**PDF 小计**（去重操作 48 项，不含平台功能「自动化流水线」）：✅ 41，⚠️ 3，❌ 4。

---

## 三、图片（对齐 SnapOtter 图片分区 + Transmute pillow/inkscape 转换器）

| 能力 | 状态 | 实现 / 说明 |
| --- | --- | --- |
| 格式转换 PNG/JPG/WebP/AVIF | ✅ | `omnitool.image/convert`（覆盖 SnapOtter 约 30 条格式对路由） |
| 压缩 / 网页优化 | ✅ | `convert` 质量 + 尺寸上限 |
| 缩放 Resize | ✅ | `resize`：百分比 / 适应 / 填满 / 留白 / 拉伸 |
| 裁剪 Crop、智能去边 | ✅ | `crop`：宽高比、精确区域、去纯色边框 |
| 旋转翻转 | ✅ | `transform` |
| 调色、锐化、模糊、像素化、灰度、反色 | ✅ | `adjust` |
| 色盲模拟 | ✅ | `adjust` 预设 |
| 文字水印 | ✅ | `watermark`：含平铺防盗 |
| 边框、圆角、圆形裁切、投影 | ✅ | `frame` |
| 拼图、长图拼接 | ✅ | `collage` |
| 切图 / 九宫格 | ✅ | `split` |
| 图标生成 Favicon | ✅ | `favicon` |
| 图片转 PDF | ✅ | `to-pdf` |
| 图片信息、主色板、LQIP 占位图 | ✅ | `inspect` |
| GIF / 动态 WebP 保留动画 | ✅ | magick-wasm 第二引擎 + `animation`（变速、倒放、拆帧、压缩、循环、合成）；APNG 输出见 `omnitool.media/to-gif` |
| EXIF 方位、ICC 色彩配置文件 | ✅ | 默认摆正并去除 EXIF（含 GPS）；可选保留 EXIF，ICC 始终保留 |
| HEIC / TIFF / PSD / JXL / RAW 解码 | ✅ | magick 解码兜底；可写 GIF / TIFF / JXL（EPS 需 Ghostscript，不支持） |
| 去除 / 编辑元数据 | ✅ | `metadata` |
| 图片水印（叠图） | ✅ | `watermark` 的 Logo 模式 |
| 文字叠加、表情包生成 | ✅ | `meme`：上下描边字幕，中文字体 |
| 边框美化截图 Beautify Screenshot | ✅ | `frame` 的渐变背景与窗口装饰 |
| 双色调、暗角、填充 | ✅ | `color-tools` |
| 替换颜色 | ✅ | `color-tools`：容差、透明替换（去白底） |
| 图片对比 Compare | ✅ | `compare`：差异高亮图、左右并排图，变化比例、PSNR 与 SSIM |
| 查重 Find Duplicates | ✅ | `find-similar`：感知哈希分组 |
| 直方图 | ✅ | `histogram`：分通道直方图与曝光统计 |
| 转 Base64 | ✅ | `omnitool.data/encode` 的 Data URI 模式 |
| 二维码生成 / 条码生成 | ✅ | `barcode`（zxing-wasm） |
| 条码 / 二维码识别 | ✅ | `barcode-read`（zxing-wasm） |
| 精灵图 Sprite Sheet | ✅ | `sprite`：打包 + CSS / JSON 坐标 |
| SVG 转位图 | ✅ | `svg-render`：宿主以 `<img>` 解码，外部引用不会加载 |
| 位图转 SVG（矢量化） | ✅ | `vectorize`（imagetracerjs，Unlicense） |
| 扫描件拆分照片 | ✅ | `scan-split`：背景估计 → 闭运算 → 连通域 → 最小外接旋转矩形，自动摆正 |
| 内容感知缩放 Seam Carving | ✅ | `seam-carve`：动态规划逐条移除像素缝；满画面细节的照片主体也会变形，说明中已提示 |
| 降噪 | ✅ | `denoise`：自引导滤波（边缘保持），不依赖模型 |
| HTML 转图片 | ❌ | 需要真实浏览器排版截屏；沙盒内无 DOM，宿主截屏会引入跨域与安全问题 |
| **AI：去背景** | ✅ | `omnitool.ai/remove-background`：U²-Netp（Apache-2.0）/ IS-Net（MIT） |
| **AI：超分辨率** | ✅ | `omnitool.ai/upscale`：Swin2SR 轻量 ×2（Apache-2.0） |
| **AI：OCR 文字识别** | ✅ | `omnitool.ai/ocr`：PP-OCRv4（Apache-2.0），中英文 |
| **AI：物体擦除** | ✅ | `omnitool.ai/erase`：画笔涂抹；MI-GAN（MIT，28 MB，任意尺寸）/ LaMa（Apache-2.0，208 MB）；只替换涂抹区域并羽化边缘 |
| **AI：人脸打码** | ✅ | `omnitool.ai/face-blur`：YuNet（MIT，0.2 MB），整图 + 分块两遍检测，马赛克 / 模糊 / 纯色 |
| **AI：去红眼** | ✅ | `omnitool.ai/red-eye`：YuNet 眼部关键点定位，只修正瞳孔中心的红色连通块 |
| **AI：智能裁剪** | ✅ | `omnitool.ai/smart-crop`：U²-Netp 显著性，最大取景或贴近主体 |
| AI：人脸增强、老照片修复 | ⚠️ | GFPGAN / CodeFormer 没有官方 ONNX 导出，只有来源不明的第三方转换；CodeFormer 为非商用许可。需拍板是否由项目自行导出并托管模型 |
| AI：黑白照片上色 | ⚠️ | DDColor（Apache-2.0）/ DeOldify（MIT）同样没有官方 ONNX，体积约 200 MB 以上；同上 |
| AI：扩图 Outpainting | ❌ | 需要扩散模型（GB 级）与多步采样，浏览器内不可用 |

> **APNG**：ImageMagick 的 APNG 写出依赖外部 ffmpeg 程序，wasm 里不存在；APNG 由音视频工具箱的 ffmpeg 输出。

**图片小计**（去重操作 46 项）：✅ 42，⚠️ 2，❌ 2。

---

## 四、音视频（对齐 SnapOtter 视频 / 音频分区 + Transmute ffmpeg 转换器）

| 能力 | 状态 | 实现 / 说明 |
| --- | --- | --- |
| 视频格式互转 | ✅ | `convert-video` |
| 视频压缩（画质等级 / 目标体积两遍编码） | ✅ | `compress-video` |
| 裁剪片段（可视化时间轴） | ✅ | `trim` |
| 提取音频 / 音频格式互转 | ✅ | `extract-audio` |
| 音量、响度标准化、淡入淡出、变速、去静音、声道 | ✅ | `audio-edit` |
| 视频裁切画面、旋转、镜像、变速、静音、调色 | ✅ | `video-edit` |
| 视频转 GIF / 动态 WebP / APNG | ✅ | `to-gif` |
| 抽帧、封面 | ✅ | `frames` |
| 拼接视频、替换音轨 | ✅ | `merge` |
| 媒体信息 | ✅ | `inspect-media` |
| GIF 转视频、图片序列转视频 | ✅ | `images-to-video`：图片幻灯片（可配乐、淡入淡出），GIF 转 MP4 / APNG |
| 视频水印 | ✅ | `watermark-video`：文字（中文字体）或图片，画面上定位 |
| 烧录字幕 / 嵌入字幕 / 提取字幕 | ✅ | `subtitles`：libass 烧录（内置中文字体）、内嵌软字幕、从视频提取；GBK 字幕自动转码 |
| 字幕格式互转 SRT/VTT/ASS | ✅ | `subtitles` 转换与平移时间轴 |
| 视频防抖 | ✅ | `video-effects`：ffmpeg `deshake`（此 ffmpeg.wasm 构建不含 vidstab，deshake 效果略弱） |
| 倒放、帧率转换、模糊补边 | ✅ | `video-effects` |
| 视频降噪 | ✅ | `video-effects`：`hqdn3d` 三档 |
| 音频拆分、铃声制作、波形图 | ✅ | `audio-split`、`waveform` |
| 变调 Pitch Shift | ✅ | `audio-edit`（`asetrate + atempo`） |
| 音频降噪 | ✅ | `audio-edit`（`afftdn`） |
| **AI：语音转文字 / 自动字幕** | ✅ | `omnitool.ai/transcribe`：Whisper base / small（MIT，int8），SRT / VTT / 文稿，近百种语言，可译为英文 |
| 视频元数据清理 | ✅ | `video-effects` 的「清除元数据」 |

**音视频小计**（去重操作 22 项）：✅ 22。

---

## 五、数据与文本（对齐 SnapOtter 文件分区 + Transmute pandas/pypandoc 转换器）

| 能力 | 状态 | 实现 / 说明 |
| --- | --- | --- |
| JSON / YAML / CSV / TSV / XML 互转 | ✅ | `omnitool.data/convert`，支持直接粘贴 |
| JSON 格式化、压缩、路径提取 | ✅ | `json-format` |
| CSV 合并、拆分、筛选列、去重、统计 | ✅ | `csv-tools` |
| Markdown 转 HTML、大纲提取 | ✅ | `markdown` |
| 文本查找替换、排序、去重、大小写、统计 | ✅ | `text` |
| Base64 / Hex / Data URI / 哈希校验 | ✅ | `encode` |
| Markdown 转 PDF | ✅ | `markdown-pdf`：pdf-lib 排版，中文字体子集嵌入 |
| Excel ↔ CSV | ✅ | `spreadsheet`（SheetJS 社区版） |
| 图表生成 Chart Maker | ✅ | `chart` |
| 字体格式转换 TTF/OTF/WOFF2、子集化 | ✅ | `font` |
| 电子书 EPUB 生成 | ✅ | `ebook` |
| EPUB / MOBI 互转 | ❌ | 依赖 calibre |
| 邮件 EML/MSG 解析 | ✅ | `email`：正文、头信息与附件导出 |

**数据与文本小计**（去重操作 13 项）：✅ 12，❌ 1。

---

## 六、压缩与归档

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 打包 ZIP | ✅ | 结果区「打包下载 ZIP」（保留目录结构），以及 `omnitool.archive/create` |
| 创建 ZIP / 解压 ZIP 工具 | ✅ | `create` / `extract`：GBK 文件名修复、防路径穿越、解压前按声明大小拦截压缩炸弹 |
| 7z / RAR 解压、带密码的 ZIP | ✅ | `extract`：libarchive-wasm（按需加载，0.6 MB）；RAR v4/v5、7z（LZMA/LZMA2/BZip2）、ZipCrypto/AES 加密 ZIP。**加密了文件名的 RAR** 在 libarchive 中不受支持，会明确提示 |
| TAR / GZ | ✅ | 自研 ustar + PAX 读写（与 GNU tar 双向互通），GZ 用 fflate |

---

## 七、Office 与 CAD：纯浏览器的硬边界

| 能力 | 状态 | 原因 |
| --- | --- | --- |
| Word / Excel / PowerPoint → PDF | ❌ | 需要完整的 Office 排版引擎。LibreOffice 有实验性 wasm 构建（ZetaOffice），但体积数百 MB、启动数十秒、中文字体需另行打包，不具备可用性 |
| PDF → Word | ❌ | 版面还原需要服务端级别的分析（Transmute 用 pdf2docx，Python） |
| 演示文稿、表格格式互转 | ❌ | 同上 |
| CAD (DXF)、3D 网格、draw.io、iWork | ❌ | Transmute 用 ezdxf / trimesh / inkscape 等桌面级依赖 |

这些不是「还没做」，是本项目「纯本地、零服务器」定位的代价。若将来需要，正确的形态是一个**可选的自托管转换服务插件**：插件声明 `net` 能力，用户自行部署 LibreOffice 容器并在设置里放行内网地址——架构已经支持，不需要改宿主。

---

## 八、汇总

| 分区 | 去重操作数 | ✅ 已实现 | 🔜 可行待做 | ⚠️ 需拍板 | ❌ 浏览器内不可行 |
| --- | ---: | ---: | ---: | ---: | ---: |
| PDF | 48 | 41 | 0 | 3 | 4 |
| 图片 | 46 | 42 | 0 | 2 | 2 |
| 音视频 | 22 | 22 | 0 | 0 | 0 |
| 数据与文本 | 13 | 12 | 0 | 0 | 1 |
| 归档 | 4 | 4 | 0 | 0 | 0 |
| Office / CAD | 3 | 0 | 0 | 0 | 3 |
| **合计** | **136** | **121** | **0** | **5** | **10** |

口径说明：

- 按表格行计数，一行是一种独立操作；格式对不单独计数。与第 3 轮相比，PDF 把「调整对比度 / 替换颜色」「表单填写 / 自动识别表单」各拆成两行，图片把原先挤在两行里的 AI 能力（人脸打码与增强；上色、降噪、去红眼、老照片修复、智能裁剪、内容感知缩放、扩图）逐项拆开并补上扫描件拆分，音视频把视频降噪单列，因此总数从 126 变为 136。
- 「✅ 121」与内置工具数 95 不一一对应：一个工具可覆盖多行（如 `watermark` 同时覆盖水印与页码），「PDF 替换颜色」由工作流模板组合现有工具完成。
- 「PDF 转 Word」在 PDF 与 Office 两处出现，只在 PDF 计一次。
- 「自动化流水线」是平台功能，不计入工具数与小计。

## 九、需要拍板的事项

矩阵里已没有「🔜 可做未做」。剩下的 ⚠️ 都不是工作量问题，而是需要负责人决定的取舍：

1. **数字证书签名 / 验签**：证书与私钥的存储方式（沿用 `secret` 能力的加密保险库，还是只允许每次临时导入 .p12）、插件能否读取私钥本体或只能请求宿主代签。这是沙盒安全架构层面的设计，按协作约定暂停等待确认。
2. **PDF 时间戳**：必须联网访问 TSA。是否提供一个默认关闭、需显式授予 `net` 能力的可选插件。
3. **人脸增强 / 老照片修复 / 黑白上色**：官方项目没有 ONNX 导出。选项是（a）项目自行从官方权重导出、公开导出脚本并托管模型文件；（b）不提供。第三方匿名转换的模型不应进入「来源 + SHA-256」的信任链。
4. **Ghostscript（PDF/A、EPS）**：AGPL 许可，若引入需以独立的可选插件形式分发。
