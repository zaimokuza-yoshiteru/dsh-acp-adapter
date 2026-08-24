# 入门

[中文](getting-started.md) | [English](en/getting-started.md)

## 环境

- DSH `0.1.1-rc.2` 或更高版本（本项目已验证 rc.2；不支持 rc.8）。
- Node.js `^22.19.0 || >=24.0.0`，门禁版本 Node 24.19.0。
- 一个已安装、可独立运行的 ACP Agent CLI。

## 安装插件

公开包安装：

```bash
dsh plugin --profile web add @zaimokuza/dsh-acp-adapter
dsh web
```

本地开发或发布前验证：

```bash
pnpm pack
dsh plugin --profile web add /absolute/path/to/zaimokuza-dsh-acp-adapter-*.tgz
dsh web
```

卸载使用 `dsh plugin --profile web remove @zaimokuza/dsh-acp-adapter`。安装、卸载和
验证应在测试 profile 中完成；不要把生产 profile 的状态目录用于试验。

## 创建第一个 ACP 会话

1. 按 [Agent 指南索引](agents/README.md) 完成 CLI 自己的登录与健康检查。
2. 打开 DSH ACP 设置，选择目前支持的 Devin、Codex、Kimi 或 Claude 模板。
3. 确认命令可执行、协议初始化通过、health 为 `ready`。
4. 选择 Agent 暴露的 model/mode/config option 后创建会话。
5. 首次 prompt 前确认设置面板已经显示 workspace 权限和 Agent mode 两条独立信息。

ACP 会话创建后 backend 不可变。需要从 native 切到 ACP，或从一个 ACP runtime 切到
另一个 runtime 时，请新建会话；插件不会把历史隐式迁移到新 Agent。

## 不要做的事

不要在插件配置、shell 日志、测试夹具或 issue 中粘贴认证文件、token、cookie、环境
变量值或完整 command line。问题报告请只保留 Agent 名称、版本、health 状态和脱敏的
错误类别。
