# OmniTool 参与贡献指南

感谢你对 OmniTool 的关注与支持。我们追求构建一个极速、私密且完全运行在浏览器端的高性能工具箱。无论是报告异常、完善文档、修复 Bug，还是基于插件架构实现新的工具套件，都非常欢迎你的加入。

参与本项目即默认遵守 [贡献者行为准则](CODE_OF_CONDUCT.md)。若发现安全缺陷或沙盒逃逸漏洞，请**不要**提交公开 Issue，请遵循 [安全策略](SECURITY.md) 提交私密报告。

## 目录

- [OmniTool 参与贡献指南](#omnitool-参与贡献指南)
  - [目录](#目录)
  - [贡献切入点](#贡献切入点)
  - [本地开发环境搭建](#本地开发环境搭建)
  - [工程目录概览](#工程目录概览)
  - [研发工程规范](#研发工程规范)
    - [源码与架构规范](#源码与架构规范)
    - [缺陷修复原则](#缺陷修复原则)
    - [交互文本与本地化](#交互文本与本地化)
  - [测试与质量验证](#测试与质量验证)
  - [Git 规范与 Pull Request 流程](#git-规范与-pull-request-流程)
  - [重大架构改动审批原则](#重大架构改动审批原则)
  - [文档同步机制](#文档同步机制)

## 贡献切入点

- **Bug 反馈**：使用 [Bug 报告模板](https://github.com/Okysu/OmniTool/issues/new?template=bug_report.yml)，准确提供浏览器具体版本、精准复现步骤，并在不涉及隐私的前提下附上最小复现样例文件。
- **功能特性提案**：通过 [功能建议模板](https://github.com/Okysu/OmniTool/issues/new?template=feature_request.yml) 提出新需求。在规划新功能前，请务必检索 [工具规划矩阵](docs/design/03-tool-matrix.md)，确认该能力具备在浏览器沙盒环境落地的可行性。
- **实现新工具（插件体系）**：OmniTool 的大部分能力均由插件承载，开发新工具通常无需触动核心宿主代码。你可以从内置的交互式教程（`/#/learn`）快速熟悉 Plugin API。
- **文档维护**：修正表述瑕疵、修正失真示例或翻译疏漏，可直接发起 Pull Request。

## 本地开发环境搭建

基础环境要求：

- Node.js 24 或更高版本
- pnpm 11（启用 `corepack enable` 后，系统将自动对齐 `package.json` 中锁定的包管理器版本）
- （可选）本地系统级 `ffmpeg`：用于自动化端到端测试时生成视频测试资产

```bash
# 克隆工程
git clone https://github.com/Okysu/OmniTool.git
cd OmniTool

# 安装依赖
pnpm install

# 启动本地开发服务（内置跨源隔离响应头）
pnpm dev          # 访问地址: http://localhost:5173
```

在首次执行 `pnpm dev` 或 `pnpm build` 时，构建流水线将通过 `pnpm vendor` 自动下载并整理离线运行时所需的资源文件（涵盖 FFmpeg.wasm、ONNX Runtime Web、ImageMagick-Wasm、pdf.js 等，体积约 140 MB，该目录不纳入 Git 版本控制），并同步下载中文字体包及 Whisper 词表缓存（位于 `node_modules/.cache/omnitool`，内置 SHA-256 完整性校验）。在断网但已有缓存的环境下，构建依然可以离线闭环完成。

常用研发指令：

| 脚本指令 | 职责描述 |
| --- | --- |
| `pnpm dev` | 启动本地热重载开发服务器（预置 Cross-Origin 隔离响应头） |
| `pnpm build` | 资源归档校验 → TypeScript 静态类型检查 → 生产环境构建打包 |
| `pnpm preview` | 启动本地静态服务器，预览 `dist/` 生产产物 |
| `pnpm typecheck` | 执行严格 TypeScript 类型审查 |
| `pnpm test` | 执行基于 Vitest 的单测套件 |
| `pnpm test:e2e` | 运行端到端测试（基于 Playwright + Chromium 驱动） |
| `pnpm vendor` | 重新校验并拉取 `public/vendor/` 运行时资产与 `llms.txt` |

## 工程目录概览

```
src/
├─ core/              # 宿主核心引擎
│  ├─ sandbox/        # 插件沙盒：主线程宿主桥接 (host.ts) 与隔离层运行时 (guest/)
│  ├─ capabilities/   # 宿主原生能力实现：fs, ffmpeg, onnx, image, kv, secret, net 权限门禁
│  ├─ plugin/         # 插件生命周期：元数据校验、依赖编排、动态加载与静态分析
│  ├─ pipelines/      # 工作流拓扑编排与执行引擎
│  ├─ tasks/          # 任务调度器与后台 Worker 线程池管控
│  ├─ vfs/            # 私有文件系统抽象（基于 Origin Private File System，OPFS）
│  ├─ learn/          # 交互式插件演练场运行时
│  └─ ui/             # 声明式 UI 树渲染引擎与安全清洗机制
├─ plugins/builtin/   # 原生内置工具（与第三方扩展使用完全相同的开放 API）
├─ components/        # 全局 Vue 组件库（ui/ 为无样式原子化的 shadcn-vue 组件）
└─ views/             # 核心视图路由页面
extensions/           # 随仓库维护、按需订阅的联网扩展（不进入构建产物），如 AI 扩展工具箱
sdk/                  # 官方开放插件类型定义库 omnitool-plugin.d.ts
scripts/              # 构建辅助工具链：vendor.mjs (运行时包体整理), llms.mjs (AI 知识库提取)
docs/                 # 核心架构设计方案、教程规范与版本纪要，详见 docs/README.md
tests/                # 单元测试；包含在 Node 隔离环境下执行真实插件逻辑的测试脚手架
e2e/                  # Playwright 驱动的全链路回归套件及测试素材生成器
```

## 研发工程规范

### 源码与架构规范

- 全面开启 TypeScript 严格模式，所有提交必须百分之百通过 `pnpm typecheck`。
- 注释重在讲透「设计权衡与边界考量（Why）」，严禁简单复述代码语义（What）。
- UI 层严禁肆意引入第三方视觉库，统一基于 `src/components/ui/` 下的 shadcn-vue 组件封装。如确有底层魔改必要，须在代码头部声明 `LOCAL MODIFICATION` 标记，便于上游组件升级时进行差异合并。
- **架构同构性原则**：内置工具没有任何特权，必须纯粹基于公开的 Plugin API 构建。若内置能力遇到 API 限制，证明当前 SDK 存在设计死角，应按正规流程扩充开放 API，严禁在内置插件内走宿主后门。
- **UI 线程免阻塞原则**：任何计算密集型任务（转码、解码、推理、排版）均须剥离至沙盒 Worker 或宿主专属 Worker 执行，绝对禁止阻塞主渲染循环。

### 缺陷修复原则

- **根因溯源**：杜绝通过“延长超时时间”、“加设防御性空判断”或“新增冗余配置开关”等手段掩盖深层竞争条件与内存泄漏问题。
- 每一个 Bug 修复 PR 必须附带能够稳定复现原问题的测试用例，并在 PR 说明中阐述问题复现链路与根治方案。

### 交互文本与本地化

- 面向用户的报错及提示信息应言之有物：清晰告知“系统发生了什么状态”以及“下一步可行的纠正动作”。
- 中英文混排严格保证间距空格（盘古之白）；中文语境下统一使用全角标点符号。
- 数据摘要必须精准度量，拒绝模糊表述。如：「657.6 KB → 6.0 KB（压缩率 -99.1%）」，严禁输出「处理完毕」等无有效信息量的占位符。

## 测试与质量验证

| 测试层级 | 存放路径 | 覆盖重点 |
| --- | --- | --- |
| 单元测试 | `tests/*.test.ts` | 核心算法纯逻辑、数据解析矩阵、边界异常及参数校验 |
| 端到端测试 | `e2e/*.mjs` | 真实浏览器沙盒隔离、Canvas 像素吞吐、FFmpeg 线程生命周期与复合交互 |

- 插件单测基于 `tests/harness/plugin.ts` 运行环境，在 Node 环境中对等加载插件源码并挂载内存虚拟文件系统。
- 端到端测试覆盖 `smoke`（冒烟）、`tools`（全量内置工具）、`ui`（视图响应）、`flows`（工作流管道）、`editor`（编辑器诊断）、`extensions`（订阅扩展与模拟的 OpenAI 兼容接口）及 `ai`（端侧推理模型）。其中 `ai` 套件需要在线下拉测试权重，本地调试可通过设置 `OMNITOOL_E2E_OFFLINE=1` 予以跳过。

发起 Pull Request 之前的本地最低验证门槛：

```bash
pnpm typecheck && pnpm test
```

凡改动涉及沙盒隔离逻辑、宿主核心能级、WebAssembly 调度或复杂 UI 流程，必须在本地完整跑通 `pnpm test:e2e`。

## Git 规范与 Pull Request 流程

- 分支基于主干 `main` 签出，严格遵循原子化提交原则：**单个 PR 仅聚焦于解决一个具体问题**。
- Commit 语义化信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/) 规范：
  - `feat(pdf): 支持 PDF 表单交互填报`
  - `fix(media): 修复无音轨视频生成频谱时抛出异常的问题`
  - `docs: 完善自托管部署跨域安全头配置说明`
- 若提交内容包含用户可感知的改动，请在 [CHANGELOG.md](CHANGELOG.md) 的 `[Unreleased]` 区块下主动补充一条变更日志。
- PR 正文须阐明设计方案、关键技术权衡，并附上验证说明；涉及界面的变动需上传对比截图或交互演示。

## 重大架构改动审批原则

下列范畴的架构变动**严禁未经前置讨论直接发起 PR**，必须先立项开启 Issue 征求核心维护团队意见：

1. **沙盒安全边界重构**：如 iframe / Worker 隔离方式演进、CSP 策略放宽、跨域安全头调整、权限仲裁层或文件系统隔离机制的变更。
2. **Plugin API 破坏性变更**：任何既有 API 字段含义变更、签名调整、事件丢弃行为。
3. **引入重型或非宽松商业协议的第三方依赖**：如几十 MB 量级的 Wasm 资产、包含 GPL / AGPL 强传染性代码的引入。
4. **任何形式的网络外联默认行为**：OmniTool 的产品底线是用户数据离线优先，默认严禁产生任何外联流量。

## 文档同步机制

架构改动与文档存在强依赖关系，改动发生时须同步推进以下文档变更：

| 改动范围 | 对应必须同步维护的文档 |
| --- | --- |
| Plugin API 扩展 | [`docs/design/02-plugin-api.md`](docs/design/02-plugin-api.md)（中文规范）、[`docs/llms/plugin-guide.md`](docs/llms/plugin-guide.md)（英文技术指引，供 LLM 读取）、[`sdk/omnitool-plugin.d.ts`](sdk/omnitool-plugin.d.ts) |
| 宿主能力、安全架构与沙盒拓扑 | [`docs/design/01-architecture.md`](docs/design/01-architecture.md) |
| 新增或废弃内置工具 | [`docs/design/03-tool-matrix.md`](docs/design/03-tool-matrix.md) 及主 README 功能矩阵 |
| 插件编写范式演进 | [`docs/learn/`](docs/learn/) 交互式课程教材 |
| 引入第三方开源资产 | [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) 合规清单 |

面向 LLM 的语料资产（`docs/llms/`）统一采用精准的英文技术书写，其余架构文档统一使用中文维护。