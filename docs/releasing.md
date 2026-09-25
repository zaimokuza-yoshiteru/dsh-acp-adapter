# 发布与回退

本指南描述适配器的发布流程。功能与兼容边界见 [原生复用说明](native-reuse.md)，验证方法见 [E2E 指南](../test/e2e/README.md)。用户更新说明见 [GitHub Releases](https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter/releases) 与 [中英文更新记录](../CHANGELOG.md)，验证证据记录在对应 PR 和 CI 中；本地日志、配置、会话及候选包留在 gitignored `.local/`。

## 仅修改文档

通过 PR 合并并遵守分支要求的检查即可；不修改版本，不创建发布标签，也不运行发布工作流。普通 push 或 PR 仍会运行仓库配置的 CI，但不会发布 npm 包。

## 发布适配器

1. 在 PR 中完成代码、版本及必要文档的审阅，明确 Web、桌面协议夹具与真实 Agent 的验证范围。受保护分支必须通过所需检查后合并。
2. 涉及 ACP、Teams 或连接链路的版本，须在待发布的确切提交上通过独立 Real Devin integration 的 macOS 与普通 Windows 验证；可对候选分支手动触发 workflow。普通 CI、原生夹具和旧提交结果不能替代。合并到 main 后若该 workflow 出现新失败，查清原因前不要打发布标签。
3. 从合并后的目标提交创建与 `package.json` 版本完全一致的 `v<version>` 标签并推送。不要重新使用已发布的版本或移动发布标签。
4. 标签触发 [publish npm 工作流](../.github/workflows/publish.yml)。工作流校验版本与官方 DSH 依赖，尝试同步并冻结 Registry 快照，再执行测试、构建、`npm pack` 和干净安装门禁；`npm-publish` 环境批准后通过 OIDC 发布同一份 CI tarball。手动运行也必须选择对应标签。Registry 同步失败不增加审批，也不阻塞发布；已有发布环境保护保持不变。
5. npm 成功后，独立的 `github-release` job 自动核对精确版本与 CI tarball 的 SHA-512，再创建对应 GitHub Release，无需额外人工确认。发布通道由版本推导：alpha 使用 `alpha`，RC 使用 `next`，稳定版使用 `latest`；GitHub 预发行标记由版本推导，创建 Release 不修改 npm 通道。

```sh
# 发布后查询；将 <version> 替换为本次精确版本
npm view '@zaimokuza/dsh-acp-adapter@<version>' version dist.integrity dist.tarball
```

本地 pnpm 与 CI npm 打包可能因 manifest 元数据而产生不同校验值；发布和下游清单必须以实际发布产物为准。

## GitHub Release 与历史补录

Release 自动包含 npm 实际发布时间、兼容声明、精确安装方式、包校验值和变更链接。中文、英文功能摘要维护在 `CHANGELOG.md` 的 `## <version>` 条目中，按发布标签读取，不单独维护另一份 Release 文案。没有该版本摘要时自动列出原始提交标题，不声称这些标题已翻译或经过用户影响分析；这不会新增发布审批。对比基线选择 npm 发布时间早于当前版本的最近一个已发布标签，跳过失败标签，也不使用 GitHub 补录时间排序。仓库历史有 squash 合并，因此上一次发行不一定是当前标签的 Git 祖先；跨分支发布时，完整对比可能包含分支差异。

GitHub Release 创建失败会使工作流显示失败，但已发布的 npm 包不回滚。使用 Actions 的 **Re-run failed jobs** 只重试失败的说明发布 job；不要重跑整个发布流程，否则会再次尝试发布不可覆盖的 npm 版本。重复运行说明脚本会保留已有 Release 的文案，不覆盖人工编辑。历史补录和该脚本均不设置 GitHub Latest 标记。

历史补录在当前分支运行脚本，并显式提供已有标签和更新记录。先默认生成 `.local/releases/<tag>.md`，需要写入 GitHub 时加 `--write`：

```sh
node scripts/github-release.ts --tag v0.1.6-alpha.2.0 --backfill --changelog CHANGELOG.md
node scripts/github-release.ts --tag v0.1.6-alpha.2.0 --backfill --changelog CHANGELOG.md --write
```

`--backfill` 用于旧 CI artifact 已不可用的历史补录：仍核对本地/远程标签、标签中的包身份、npm 版本和发布时间，以及可用时的 `gitHead`，但不能证明历史 CI tarball 的字节一致性。普通发布必须提供 `--tarball <CI tarball>`。脚本不会创建或移动标签，也不会调用 `npm publish`；npm 上不存在的版本不能创建发行。`v0.1.5-rc.2.2` 因文档兼容范围测试失败未发布，修复已随 `v0.1.5-rc.2.3` 发出。

Release 说明生成和补录使用 Node 与已登录的 `gh`，无需安装项目依赖。生成的说明同时保存在 CI artifact 中（90 天）。

## 更新 Agent 目录

目录快照随插件版本发布，运行时不联网刷新。发布打包前会自动下载官方 Registry，在临时目录解析启动命令并验证两个 JSON 的一致性。只有完整验证通过才替换本次构建输入；网络、包元数据解析或新快照校验失败时，两个文件均沿用本次 tag 中已验证的快照。这里的回退基线是仓库中的 `assets/registry/`，不保证等于上一版 npm 包在发布时获取的目录。

工作流摘要记录新增、删除、版本及配置变化，或失败原因和回退结果。失败时独立通知 job 自动创建或更新同一个未关闭的机器人 issue；issue API 不可用时只输出警告，不影响部署。仓库中原有快照已损坏、文件写入失败，以及原有代码测试、构建、安装门禁失败仍会阻止发布。

实际使用的两个 JSON、SHA-256 和报告保存在 `release-registry-snapshot` artifact（保留 90 天）。同一工作流重试恢复这份快照，不再次获取上游；哈希或源码提交不匹配时停止。新工作流运行可以获取更新的目录。成功同步会改变构建输入，不回写 Git tag，因此仅 checkout tag 不足以重现目录；复现该次发行必须使用归档快照或已发布 tarball。

需要更新仓库中的回退基线时，手动运行 [registry sync 工作流](../.github/workflows/registry-sync.yml)，从 `registry-snapshot-for-review` artifact 查看 `report.json` / `summary.md`。同步成功后，将其中两个 JSON 放回 `assets/registry/`，通过普通分支和 PR 更新；不要把 `fallback` 结果当作新目录。工作流不会直接推送默认分支。也可在本地执行同一套同步逻辑：

```sh
node scripts/sync-release-registry.ts
pnpm typecheck && pnpm test && pnpm build
```

同步按目录指定的分发包解析命令，保留参数和环境变量。无法确定 Agent 主机平台的二进制条目显式标为手动配置；缺失条目或不匹配的 sidecar 不会进入发布包。快照校验不代表目录中每个 Agent 的运行行为都已验证。

## 桌面内置版本

需要更新桌面安装包时，先确认适配器精确版本可从 npm 获取，再更新桌面项目的版本与 registry integrity 清单，使用桌面项目锁定的工具链打包并验收新产物。仅发布适配器不会更新已有桌面 ZIP；某个平台通过也不代表其他平台已验收。

## 回退

通过 DSH 原生插件管理安装此前已验证的精确版本，保留本地会话数据，并按 README 的步骤重启宿主、刷新页面。回退前核对目标版本的数据兼容边界；不要通过删除数据库解决加载问题。桌面回退需同步恢复版本与 integrity 清单，并重新生成和验收安装产物。
