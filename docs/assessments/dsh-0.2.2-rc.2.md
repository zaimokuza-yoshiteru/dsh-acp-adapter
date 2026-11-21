# DSH 0.2.2-rc.2 适配决策

宿主升级到 [DSH 0.2.2-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.2)。本文记录影响后续维护的决定。完整的历史测试矩阵和试跑结果见[发行标签中的原文](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/blob/v0.2.2-rc.2.1/docs/assessments/dsh-0.2.2-rc.2.md)，当前支持范围见[Agent 兼容说明](../agent-compatibility.md)。

## 上游复用与保留的适配

- 使用原生具名子代理树、成员目录及 Team mode。父页面展示子会话请求，权限、回答和审计归原成员。目录名称不能证明调用者身份；异步操作完成前仍要核对实例和资源权限。
- 原生菜单、Modal 和工具入口负责展示。关闭成员设置时原生 footer 可能已经卸载触发按钮，插件保留原生焦点行为。创造模式继续使用 DSH 的技能与插件工具目录。
- 通过 `LlmError.fromFailure` 报告错误，保留原故障类别与重试语义。旧原生模型补写、实验性 Team 包及重复浮层可移除。Typert 对外声明随包安装。
- 在原生 `working-directory/access` 上保护工作目录操作；`create_worktree` 继续在 Git 副作用前检查。文件系统可以在检查后变化，后续 ACP 请求仍须核实绑定目录。回退到 RC.1 时要同时还原数据快照。
- 恢复或重新绑定开始时即登记任务。适配器关闭时等待在途工作，每次异步恢复后再次确认原会话实例。外部 Agent 的上下文和会话生命周期继续由适配器维护。

## Devin MCP 与长目录

Devin 改用 ACP 初始化后按能力提供的会话级 MCP。插件取消用户级 MCP 注册、专用启动器及 SQLite 注册锁。已有用户注册与登录继续保留；业务工具须对应当前连接中实际提供的目录。

当时的 Standard 会话暴露 36 个工具，Devin CLI 的完整目录输出会溢出到其返回的文件。发现说明改为通过 Devin 自带的读取和搜索工具查看该文件。任务仍通过本会话的 MCP 工具执行，无需向模型另行注入 schema，也无需缩减工具定义。

RC.2 的 macOS 独立桌面用 Devin `3000.12.43` 和 `swe-2-high` 验证了共享任务、成员消息、允许、拒绝和取消。不同平台、CLI 版本与组织授权需按各自环境核对。
