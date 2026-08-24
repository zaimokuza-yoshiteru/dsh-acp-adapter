# 发布验收摘要

本目录只保留公开、脱敏的验收摘要。原始日志、账户信息、调研记录和内部设计材料
只保存在维护者本地，不进入 Git 或 npm 包。
外部研究 spike 不属于插件包，公开结论只在此记录，不复制 raw frame、workspace 内容或
认证信息。

## 当前矩阵

| 门禁 | 状态 | 说明 |
| --- | --- | --- |
| 自动化 typecheck/test/build/pack | 通过 | 2026-08-24：50 个文件，1114 通过、5 跳过；构建与 tarball 清单通过 |
| DSH rc.2 minimum install gate | 通过 | 2026-08-24：最终 tarball 干净安装、boot、native 无凭证降级和卸载恢复通过 |
| DSH latest lane | 待公开 CI | 仅作前向兼容预警；不等价于所有未来版本支持，也不阻止 rc.2 最低宿主发布 |
| macOS Agent 验收 | 已验证摘要 | Devin/Codex/Kimi/Claude 的范围和限制见兼容性文档 |
| Windows | 未验证 | 不属于当前 Gate，不宣称支持 |
| GitHub Actions | 未执行 | 推送公开仓库后首跑；workflow 会自行 checkout 固定 DSH rc.2 基线 |
| npm publish | 未执行 | 发布动作由维护者单独审批 |

## 重要边界

- DSH `0.1.1-rc.2` 是最低已验证宿主；package peer 接受更高版本，但结构 gate 仍会
  fail closed。
- 审批 `allowed-once`、外部登录、恢复对账、sidecar 审计和模型切换 CAS 是发布边界。
- Devin 被拒工具的 replay divergence 会被恢复门拦截；不以放宽对账换取假连续性。
- DSH rc.2 没有可忽略自定义事件 seam，ACP 审计只能落 sidecar。
- 完整 controller 的确定性故障矩阵已由自动化覆盖；没有公开宿主 seam 时，不把真机
  DSH rejection 写成已验证。

所有“已验证”均指相应环境和代码快照，不扩大为任意 Agent 版本、平台或宿主版本承诺。
