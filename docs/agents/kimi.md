# Kimi

[中文](kimi.md) | [English](../en/agents/kimi.md)

## CLI 检查

本机验证过 Kimi CLI 提供以下入口：

```bash
kimi --version
kimi login
kimi doctor
kimi acp --help
```

请在 Kimi 自己的 CLI/浏览器流程中登录和修复健康问题。插件只引用 Kimi data home
中的 opaque 配置、credentials 和 oauth 路径，不读取、复制或记录其中的值。

## DSH 配置

选择 Kimi 模板后先等待 health 为 `ready`，再创建 ACP 会话。模型和思考选项以本次
Agent session 实际返回的 config options 为准；没有实时 option 时，界面不会猜测或
伪造模型身份。无需、也不要把 credential 或环境变量值填入 DSH；只在 ACP 面板选择
Kimi 模板并执行重新检查。Kimi 的文本、工具和上下文占用展示遵守统一 ACP 边界。
