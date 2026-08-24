# 操作与发布检查

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

首次发布需要维护者用 npm 账户完成一次 bootstrap。确认 `npm whoami` 返回包 scope 的
所有者，创建并推送与 `package.json` 完全一致的 tag（例如 `v0.1.0-rc.1`），然后执行
`pnpm verify:release` 和 `npm publish --access public --tag next`。前一个命令会验证当前
HEAD 正好位于版本 tag；预发布版本禁止占用 `latest`。

首次发布后，在 npm 包设置中把 GitHub Actions Trusted Publisher 绑定到
`zaimokuza-yoshiteru/dsh-acp-adapter`、工作流 `publish.yml` 和 environment
`npm-publish`，允许 `npm publish`。后续版本只需更新版本号、通过 CI、创建对应 tag，
再从该 tag 手动运行 `publish npm` 工作流。工作流使用 OIDC，不读取长期 npm token；
预发布版本自动进入 `next`，稳定版本自动进入 `latest`。
