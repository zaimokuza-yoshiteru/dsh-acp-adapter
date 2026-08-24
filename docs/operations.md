# 操作与发布检查

[中文](operations.md) | [English](en/operations.md)

## 日常诊断

先记录 profile、Agent 命令、版本、health 状态和错误类别，不记录环境变量值或认证文件。
按顺序检查 DSH、Agent CLI、ACP initialize、临时 session 和目标 workspace 权限。health
不是 ready 时不要创建会话；已有会话按 UI 提供的回滚或新建出口处理。

## 本地门禁

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm pack --dry-run
pnpm check:stale-build
pnpm check:picker-diff
git diff --check
```

这些命令串行执行。install gate 必须使用隔离 profile 和 tarball；不带凭证运行时只验
证凭证缺失的降级路径，不为了门禁读取或打印已有 key，也不发送真实模型 prompt。

## 发布前

从最终工作树重新 `pnpm pack`，检查 tarball 只包含 lib、patch、许可证、README 和 docs
用户文档；在干净 DSH rc.2 profile 完成 install/boot/uninstall 后，再由发布负责人执行
npm/GitHub Actions。未实际执行的 CI、npm publish、Windows 或 Agent E2E 不得写成 PASS。

## npm 发布

正式发布使用 GitHub Actions Trusted Publishing。npm 包绑定
`zaimokuza-yoshiteru/dsh-acp-adapter`、工作流 `publish.yml` 和 environment
`npm-publish`；工作流使用 OIDC，不读取长期 npm token。

发布时更新 `package.json` 版本并通过全部门禁，创建并推送与版本完全一致的
`v<package-version>` tag，然后在 GitHub Actions 中从该 tag 手动运行 `publish npm`。工作流会
验证 HEAD、tag 和版本一致，打包一次并发布同一份 tarball。预发布版本进入 `next`，稳定
版本进入 `latest`；发布后必须检查公开 packument、tarball 和 dist-tag。预发布版本不应
占用 `latest`。
