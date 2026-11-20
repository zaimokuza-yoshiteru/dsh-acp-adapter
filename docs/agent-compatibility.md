# ACP Agent 差异与贡献边界

[English](agent-compatibility.en.md)

普通 ACP Agent 无须新增 runtime、专用 client 或实现类。在设置里手动添加命令与参数，走同一个 ACP 握手、能力探测、会话生命周期、工具审批和活动投影即可。目录元数据只是安装与展示信息；新增目录条目不应自动获得专有行为。

## 新增差异的最小步骤

1. 先用通用路径复现，记录实际 `initialize.agentInfo`、能力广告与造成差异的请求/通知。确认这是标准协议不能表达的行为。
2. 在 `src/agents/<agent>.ts` 添加窄函数或不可变参数。一个文件足够时不建目录；存在独立协议解析器时再用目录组织。新增一个 Agent 不需要复制连接、会话或审批实现，也不要求声明一个空模块。
3. 由 `src/agents/compatibility.ts` 显式组合所需事实，让对应共享 owner 消费。不要添加万能 driver、任意前后置 hook 或进程级可变注册表。
4. 增加正例和身份不匹配的负例，并在真实消费路径加一条回归。模板规则的测试不能代替连接/生命周期测试。

CodeBuddy 的握手名称是 `codebuddy-code`。部分版本省略 `agentInfo`，此时适配器可以识别直接启动的 `codebuddy --acp` 或 `codebuddy-code --acp`。如果配置声明了 `runtime: codebuddy`，也可以识别目录中通过 `npx` 启动的 `@tencent-ai/codebuddy-code`。识别后，适配器会读取各模型的思考档位。

CodeBuddy 确认取消后，下一条消息会重新加载原会话。这适用于声明了 `runtime: codebuddy` 的配置和可识别的直接启动命令。手动配置的命令如果在握手时报告为其他 Agent，则沿用该 Agent 的取消行为。取消和持久化由共享的会话运行时负责。

`src/agents/` 中也有其他可参考的实现。按握手身份探测可参考 Qwen，探测参数可参考 Devin 和 Codex，通知扩展可参考 Claude，覆盖可执行文件路径可参考 Antigravity。

## 四种身份不能混用

| 事实                               | 用途                           | 不应推导                 |
| ---------------------------------- | ------------------------------ | ------------------------ |
| profile id / `acp-<id>`            | 用户配置、路由、会话绑定       | CLI 品牌或权限           |
| 显式 runtime                       | 启动前必须确定的已支持兼容行为 | catalog 文案或命令字符串 |
| 握手 Agent identity + capabilities | 当前连接的协议差异与可用操作   | 已登录、持续在线、授权   |
| catalog id                         | 目录展示和创建预设             | 已保存配置的 runtime     |

只有原先已支持的 Devin/Codex/Claude profile id 保留历史 runtime 回退；新 Agent 应显式绑定需要的行为。只涉及标准能力的 Agent 永远保持 generic。身份匹配必须精确，禁止通过命令子串或显示标题赋予权限。

## 不移动的共享 owner

进程所有权、超时取消、会话连续性、fork/recovery、pending settlement、DSH 工具目录代次、审批目标和持久化边界继续由现有 runtime/host/persistence owner 管理。Agent 模块不能直接注册 DSH 工具、改变审批策略、提交存储、重写历史绑定或持有 Host 服务。

Qwen 的主动轮次和心跳由协议层管理，Devin 和 Claude 的委派解析由领域层管理。迁移这些行为时，应一起迁移事件的生产者和消费者，并保留取消、停用、迟到通知和跨会话负例。

## 已移除的 Kimi 支持

目录不再显示 Kimi。旧 `runtime: kimi` 和无 runtime 的旧 `id: kimi` 仅作为停用标记读取：配置及历史保留，相关路由不注册、不探测、不启动，也不自动降为 generic；设置页说明支持已移除。其他 Agent 的配置继续可用，用户可显式删除旧配置。

官方 Registry 快照原样保留，在目录合成时过滤退休条目。持久化 launch fingerprint 保留原有 `KIMI_CODE_HOME` 序列化槽及顺序，避免改变所有已有 Agent 的身份 hash；它不提供访问权限或启动环境覆盖。历史兼容只读，不放宽 binding 比较，也不迁写用户历史。

## Devin 版本要求

本分支支持 Devin CLI `3000.14.30821` 起的版本，CI 固定该版本检查会话工具桥。使用旧版时，请先升级到[最新稳定版](https://docs.devin.ai/cli/changelog/stable)，用 `devin --version` 确认。工具桥经标准 ACP 会话级 `mcpServers` 传入。HTTP 回环地址沿用现有代理排除项，只追加 `127.0.0.1`。

此前安装留下的用户 MCP 配置和启动器不会被自动删除。新版会话直接提供自己的工具桥；通用 stdio 传输仍为不支持 HTTP 的 Agent 保留。Devin 的原生授权请求仍需用户确认，这与旧版 MCP 配置无关。

工具目录较长时，Devin 会将完整内容保存到临时文件，再用自身的读取或搜索工具查看所需定义。这是正常的目录发现流程；DSH 任务操作仍使用当前会话的 MCP 工具，原生权限规则保持不变。
