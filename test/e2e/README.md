# 原生功能回归

这组 E2E 的验收对象是 DSH 与 ACP 之间的产品行为：执行者可以不同，输入、消息、审批及详情仍应复用宿主公开能力。测试启动目标版本的完整 Loader 装配、真实 ACP 子进程和浏览器，浏览器加载构建后的插件与 DSH UI。它不使用现有单元测试的 React 或 UI primitive stub。

同一组断言在 Claude、Codex、Devin、Kimi 四种协议夹具下运行，共 40 项。夹具只是可控的协议输入，不代表真实 Agent 或具体模型已经通过验收；真实 Agent 的升级仍需要少量单独冒烟。模型文案、推理质量和回答风格不作为固定夹具的通过条件。

| 场景 | 必须保持的行为 |
| --- | --- |
| 文件、消息与恢复 | 原生输入栏上传；ACP 收到文件文本句柄；主会话保存 v2 stream；刷新后消息、附件、原生 TerminalBlock 可见 |
| 宿主扩展 | system prompt、动态上下文与 pre-step 插件输入真正到达 ACP；插件触发的后续步骤正常运行；旧用户输入不重复发送；卸载插件后不再携带其指令 |
| 图片与文件活动 | assistant 图片经原生附件存储后可刷新显示；Read / Diff 使用原生组件；活动不会制造 DSH 工具调用 |
| 故障恢复 | Agent 崩溃后提示恢复，刷新保留历史；明确放弃远端上下文后才能建立新绑定并继续 |
| 审批允许 / 拒绝 | 原生审批或问题卡显示操作；选择映射回原始 optionId；拒绝不产生文件副作用；不扩大授权范围 |
| 停止后继续 | 原生停止按钮发送 ACP cancel；当前轮次结束；下一轮仍能执行 |
| 模型切换 | 原生 picker 的选择传到 ACP session 配置；后续请求使用新模型 |
| 子代理 | Claude / Devin 有完整证据时显示原生只读详情并可刷新；Codex / Kimi 的无证据活动不制造子会话 |
| 原生 provider 对照 | ACP 已注册时原生 provider 正常执行；原生工具经过 pre/post hooks，修改后的结果真正回到模型请求；不误发 ACP prompt |

## 运行

当前源码适配目标是 `dsh-v0.1.3-alpha.1`。该 CLI 的 npm 产物尚待安装验收，所以锁文件里的 rc.1 依赖仅用于引导工具安装；运行前必须把所有 DSH 开发依赖链接到准确版本的已构建源码。npm 发布检查会阻止使用旧依赖元数据发布本次源码适配。

```sh
# reference/deepseek-harness 必须检出 dsh-v0.1.3-alpha.1
pnpm --dir ../reference/deepseek-harness install --frozen-lockfile
pnpm --dir ../reference/deepseek-harness build
pnpm install --frozen-lockfile
pnpm setup:source-reference
pnpm typecheck
pnpm test
pnpm build
pnpm --dir ../reference/deepseek-harness/apps/web exec playwright install chromium
pnpm test:e2e
```

`DSH_UPSTREAM_CHECKOUT` 可指定其他源码目录。`pnpm test:e2e -t 'claude'` 可只运行一种协议夹具。默认使用 Playwright Chromium；`DSH_E2E_BROWSER_CHANNEL=chrome` 可使用本机已安装 Chrome。`DSH_E2E_NODE` 可指定宿主支持的另一份 Node 运行时，但原生依赖必须针对该 Node ABI 构建。插件构建与常规测试仍遵循 `.nvmrc`。

测试使用临时工作区和独立 DSH_HOME，结束后销毁浏览器、Agent 进程与测试目录。失败截图写入 gitignored `.local/e2e-failures/`。断言使用原生组件的数据标记及可访问名称，不依赖 CSS 哈希、整页像素截图或真实模型措辞；默认不重试失败测试。浏览器回归期间不要并行运行 build、pack 或默认安装检查：prepack 会清理并重建共享的 `lib` 目录；应按顺序执行，或向安装检查传入已生成的 tarball。

## 真实 Agent 冒烟

真实连接默认跳过，不在 CI 中运行。明确授权使用现有 Agent 登录和模型额度后，可执行：

```sh
DSH_E2E_LIVE=1 pnpm test:e2e -t 'live ACP smoke'
```

测试优先选择实际目录中的 Haiku、Mini 等较小模型，每个 Agent 在独立临时工作区接收一条无工具请求，验证宿主指令中的标记到达模型、原生消息落盘及刷新恢复。`DSH_E2E_LIVE_PROFILES=claude` 可限定 Agent；结果和实际模型目录写入 gitignored `.local/e2e-live/`。它会向 Agent 已配置的模型服务发送测试指令、宿主指令与临时工作区元数据；不会把项目文件作为输入。登录或网络失败会使已选择的测试失败，不会伪装成通过。

若 Agent 仅通过父进程环境中的密钥认证，需要显式指定要放入临时 ACP profile 的环境变量名，例如 `DSH_E2E_LIVE_CLAUDE_ENV_KEYS=ANTHROPIC_AUTH_TOKEN`。测试只读取列出的变量，值不写入测试结果；临时 profile 随宿主清理。生产环境仍需在该 Agent 的连接设置中显式配置凭据，不会自动继承父进程密钥。模型目录能够返回不等于生成请求已经完成认证。

## 版本迁移的补充验证

`test/unit/host/external-subagent-projector.spec.ts` 覆盖写句柄释放、flush 失败、前缀续写、重复投影、旧 sidecar 摘要和 v1 chunkless 消息迁移。新投影的 stream 使用上游 accumulator，时间表示结果被观察到的时间，不补造外部 Agent 的 token 时间线。旧记录保留空 stream，不重写既有历史。旧 sidecar 的 `turn/start.trigger` 不属于上游 v1 相邻迁移器接受的字段，因而保留摘要校验后的专用恢复路径；测试检查整个事件列表和 sidecar 内容不变。写句柄使用原生异步释放，flush 或释放失败均不能发布完成状态。退出宽限为零时仍在下一次定时器触发后终止等待，不使用宿主 deadline 的零值（禁用超时）语义。

ACP v1 没有 system 消息角色，宿主指令以有标注的请求上下文传递；无法强制改变外部 Agent 的指令优先级。DSH 的原生工具执行 hooks、技能加载工具和 MCP 执行不会自动进入外部 Agent：ACP 没有通用的宿主工具执行回调，工具活动通知也不是执行请求。测试证明日志化的上下文扩展到达 ACP、原生 provider 的工具扩展仍有效，不承诺不存在的执行桥接。
