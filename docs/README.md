# 文档总览

OmniTool 的文档分为四类。第一次接触项目，建议按「使用 → 写插件 → 设计」的顺序阅读。

## 写插件

| 文档 | 适合谁 | 内容 |
| --- | --- | --- |
| 插件教程（应用内 `/#/learn`） | 第一次写插件的人 | 边改代码边看效果，12 课从零到发布；课程源文件在 [learn/](learn/) |
| [Plugin API 参考](design/02-plugin-api.md) | 插件开发者 | 清单字段、表单与自定义面板、全部宿主能力、依赖、调试 |
| [类型声明](../sdk/omnitool-plugin.d.ts) | 插件开发者 | 可直接放进自己的 IDE，获得补全与类型检查 |
| [Plugin Guide（英文）](llms/plugin-guide.md) | AI 助手 | 构建时生成站点根目录的 `/llms.txt` 与 `/llms-full.txt` |

## 设计

| 文档 | 内容 |
| --- | --- |
| [架构设计](design/01-architecture.md) | 分层、沙盒与四层围栏、句柄式文件系统、依赖注入、并发，以及每一轮新增的设计 |
| [工具矩阵](design/03-tool-matrix.md) | 与 Stirling-PDF、SnapOtter、Transmute 的逐项对齐，哪些已实现、哪些需要决策、哪些在浏览器内做不了 |

## 迭代记录

每一轮迭代都记录了关键决策、交付内容、过程中定位的问题与根因、验证结果。版本对应关系见 [CHANGELOG](../CHANGELOG.md)。

| 轮次 | 版本 | 总结 | 测试覆盖 |
| --- | --- | --- | --- |
| 第 1 轮 | 0.1.0 | [插件内核与骨架界面](iterations/01-summary.md) | [测试场景](testing/01-test-scenarios.md) |
| 第 2 轮 | 0.2.0 | [官方组件、FFmpeg / ONNX / 凭据能力、39 个工具](iterations/02-summary.md) | [测试场景](testing/02-test-scenarios.md) |
| 第 3 轮 | 0.3.0 | [图片双引擎、可视化音视频编辑、AI 与归档](iterations/03-summary.md) | [测试场景](testing/03-test-scenarios.md) |
| 第 4 轮 | 0.4.0 | [95 个工具、工作流、清零可做未做项](iterations/04-summary.md) | [测试场景](testing/04-test-scenarios.md) |
| 第 5 轮 | 0.5.0 | [流程图、交互式教程、模型管理、部署](iterations/05-summary.md) | [测试场景](testing/05-test-scenarios.md) |

## 项目规范

- [参与贡献](../CONTRIBUTING.md)：开发环境、约定、测试、提交流程、需要先讨论的改动
- [安全策略](../SECURITY.md)：如何私下报告漏洞、什么算安全问题
- [行为准则](../CODE_OF_CONDUCT.md)
- [第三方许可声明](../THIRD_PARTY_NOTICES.md)

## 文档约定

- 除 `llms/` 外，文档使用简体中文；中文与英文、数字之间加空格，中文语境使用全角标点。
- 每篇设计与记录文档开头用一行 `> 面向：…` 说明读者。
- 改动 Plugin API 时，中文参考、英文指南与类型声明三处同步更新。
