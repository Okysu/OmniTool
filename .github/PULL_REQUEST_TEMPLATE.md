## 变更说明

<!-- 这个 PR 做了什么、为什么。修复问题请说明根因。 -->

关联 Issue：#

## 变更类型

- [ ] Bug 修复
- [ ] 新功能 / 新工具
- [ ] Plugin API 变更（请注明是否兼容）
- [ ] 文档
- [ ] 重构 / 测试 / 构建

## 验证

<!-- 如何确认改动有效；界面改动请附截图。 -->

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 通过
- [ ] 涉及沙盒、宿主能力、音视频或界面交互时，`pnpm test:e2e` 通过

## 检查清单

- [ ] 已在 `CHANGELOG.md` 的 `[Unreleased]` 下补充用户可见的变更
- [ ] 涉及 Plugin API 时，已同步更新 `docs/design/02-plugin-api.md`、`docs/llms/plugin-guide.md`（英文）与 `sdk/omnitool-plugin.d.ts`
- [ ] 新增第三方依赖时，已确认许可并更新 `THIRD_PARTY_NOTICES.md`
- [ ] 不涉及沙盒安全架构的变更，或已在 Issue 中讨论并达成一致
