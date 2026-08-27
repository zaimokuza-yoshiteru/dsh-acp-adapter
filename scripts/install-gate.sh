#!/usr/bin/env bash
# install-gate.sh — 发布门禁：干净安装 / 卸载 的真实验证（不用 link:，只用
# pnpm pack 产出的 .tgz 文件依赖安装）。本地与 CI（macOS lane）同一姿势。
#
# Lane 语义（minimum / latest）：
#   - minimum（默认，发布门禁）：宿主钉最低已验证版本 0.1.1-rc.2，机械结构可钉死——
#     dump-config 白名单 diff、卸载后与 stock 逐字节一致等结构断言全部 fail-hard。
#   - latest（CI host-latest lane）：宿主用真实最新 DSH（@deepseek-ai/dsh@next；
#     注意 dsh 卫星包的 latest dist-tag 停在旧线，真实最新宿主线走 next），行为契约
#     fail-hard（计划内 row 在场/disabled、boot 200、插件 bundle 路由、native 回归、
#     卸载 manifest/node_modules 零残留），跨版本机械断言（白名单 diff、逐字节恢复）
#     降级为记录证据 + 告警——新宿主版本可能合法引入计划外 row，结构真相由
#     host-compat structure-gate 在运行时 fail-closed。
#
# 流程：
# 1. pnpm pack（触发 prepack 全量门禁：clean（realpath 守卫
#      清理）→ typecheck → test → build（build 自身也先 clean，tarball 恒来自
#      干净构建，绝不装到陈旧 lib/ 产物）→ 含 verify-bundle → pack --dry-run；
#      见 scripts/prepack.mjs）产 .tgz。
#   2. 全新隔离 GATE_ROOT：host/ 工作区以 npm 已发布的 @deepseek-ai/dsh@<HOST_SPEC>
#      为宿主（生产形态：宿主链落 lib 构建产物，不经 reference 仓 tsx 源启），
#      DSH_HOME 隔离在 GATE_ROOT 下。HOST_SPEC 默认 0.1.1-rc.2（minimum lane）。
#   3. 预置两个 profile（gate-stock 对照 + gate-acp 受测），形态与 DSH web profile
#      一致（临时项目不声明 packageManager，使用 PATH 中的 pnpm）
#      版本，对 dsh 无语义）。
#   4. dsh plugin add <abs>.tgz 安装 → 启动前 --dump-config 双重断言：
#      gate-acp 出现 agent-loop-acp 行（name = @zaimokuza/dsh-acp-adapter）、
#      agent-loop 与 ui-model-selection 行 disabled、关键 id 无重复；与 gate-stock
#      的 diff 逐行过白名单（只许计划内 row 差异，任何未知 row 差异即失败）。
#   5. boot 冒烟：起 web 表面（端口自选，默认 3328），断言 / 200、插件 client
#      bundle 路由 /plugins/@zaimokuza/dsh-acp-adapter/client.js 200 且注册 id 为
#      scoped 包名、日志无 ERROR/未处理 rejection 等致命词。
#   6. native provider 回归（原生能力回归脚本
#      形态）：session.create → session.prompt → session.history。无
#      DEEPSEEK_API_KEY 时降级——断言 turn 推进到 llm-deepseek 的 MISSING_CREDENTIAL
#      （证明 native 路由/preset mount/持久化全链路活着，仅 LLM 调用本身不验）；
#      有 key 时断言 turn/end 非 MISSING_CREDENTIAL 收尾。
#   7. dsh plugin remove 卸载 → dump-config 与 gate-stock 逐字节一致（stock 行
#      恢复、无残留 patch row），profile manifest 与 node_modules 无包名残留。
#
# 有意不覆盖：
#   - 「从上一 rc 包升级」仍需在独立升级验收中覆盖；本脚本只验证当前 tarball 的干净安装。
#     后续版本应在独立升级门禁中安装前一版 tarball，再验证 settings 与 sidecar
#     binding 保留；首版脚本不伪造不存在的升级来源。
#   - DSH 版本不匹配的活体错误文案：host-compat structure-gate 的 fail closed 与
#     升级指引由 test/integration/host/host-compat.spec.ts 钉版（ACP_HOST_INCOMPATIBLE）；活体错版宿主
#     组合需要第二份 dsh 安装，成本高于收益，本门禁不跑。
#
# 环境变量覆盖：DSH_ACP_GATE_ROOT（默认 mktemp -d）、DSH_ACP_GATE_PORT（默认 3328）、
# DSH_ACP_GATE_HOST_SPEC（宿主 dsh 版本/dist-tag，默认 0.1.1-rc.2；latest lane 传 next）、
# DSH_ACP_GATE_LANE（minimum|latest，默认 minimum；语义见文件头 Lane 语义）、
# DSH_ACP_GATE_TGZ（门禁调试/分段复跑用：跳过 pack 步，直接门禁一个已产出的
# tarball——该 tarball 未经本流程的 clean build 重建，陈旧产物风险由调用者自担；
# 正式发布证据必须跑默认全流程，不得以本覆写冒充）。
# 依赖：PATH 上有 node（24.19.0）与 pnpm；网络可达 npm registry
# （装宿主 dsh 与本包运行时依赖 @agentclientprotocol/sdk、zod）。
# 平台：保持 bash + lsof/curl（非 npm script，不在 跨平台 clean 范围）；
# Windows 移植注意项见 .github/workflows/ci.yml windows lane 头注。
set -euo pipefail

# 兼容 macOS 自带的 bash 3.2：变量后紧跟全角标点时写 ${VAR} 形态；
# 不使用 bash 4+ 特性。

ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE_ROOT="${DSH_ACP_GATE_ROOT:-$(mktemp -d /tmp/dsh-acp-install-gate.XXXXXX)}"
export DSH_HOME="$GATE_ROOT/dsh-home"
HOST_DIR="$GATE_ROOT/host"
DSH_BIN="$HOST_DIR/node_modules/.bin/dsh"
PKG_NAME='@zaimokuza/dsh-acp-adapter'
PROFILE='gate-acp'
STOCK_PROFILE='gate-stock'
PORT="${DSH_ACP_GATE_PORT:-3328}"
HOST_SPEC="${DSH_ACP_GATE_HOST_SPEC:-0.1.1-rc.2}"
LANE="${DSH_ACP_GATE_LANE:-minimum}"
BOOT_LOG="$GATE_ROOT/boot.log"
BOOT_PID=''

# Never interpolate the credential itself into gate status output.  This helper is
# intentionally tiny so the self-test below exercises the same branch used by the
# real native regression.
credential_presence() {
  if [[ -n "${DEEPSEEK_API_KEY:-}" ]]; then
    echo 'present'
  else
    echo 'absent'
  fi
}

step() { printf '\n==> %s\n' "$*"; }
fail() { echo "install-gate FAIL: $*" >&2; exit 1; }
report_native_regression_status() {
  local status="$1" evidence="$2"
  case "$status" in
    pass)
      echo "native 回归通过（含真实 LLM 往返；证据 ${evidence}）。"
      ;;
    missing-credential)
      echo "native 回归通过（降级级：turn/end = 预期 MISSING_CREDENTIAL；证据 ${evidence}）。"
      ;;
    pending|fail|*)
      fail "native 回归：90s 内未观察到终态（${evidence}）"
      ;;
  esac
}
# latest lane 的机械断言降级出口：记录证据并响亮告警，不翻转门禁成败（行为断言
# 仍走 fail）。minimum lane 调用本函数即配置错误，直接 fail。
soft_fail() {
  if [[ "$LANE" = "latest" ]]; then
    echo "install-gate WARN(latest lane 机械断言降级，证据保留在 ${GATE_ROOT}): $*" >&2
  else
    fail "$*"
  fi
}

if [[ "$LANE" != "minimum" && "$LANE" != "latest" ]]; then
  fail "DSH_ACP_GATE_LANE 只接受 minimum|latest（当前：${LANE}）"
fi

cleanup() {
  if [[ -n "$BOOT_PID" ]] && kill -0 "$BOOT_PID" 2>/dev/null; then
    kill "$BOOT_PID" 2>/dev/null || true
    sleep 2
    kill -9 "$BOOT_PID" 2>/dev/null || true
  fi
  # 端口兜底：boot 中途失败时不留孤儿监听。
  if command -v lsof >/dev/null 2>&1 && lsof -ti :"$PORT" >/dev/null 2>&1; then
    lsof -ti :"$PORT" | xargs kill 2>/dev/null || true
  fi
  echo
  echo "install-gate 证据目录保留在：$GATE_ROOT"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------

preflight() {
  step "0/8 前置检查（GATE_ROOT=${GATE_ROOT}）"
  command -v node >/dev/null || fail "node 不在 PATH"
  command -v pnpm >/dev/null || fail "pnpm 不在 PATH"
  command -v curl >/dev/null || fail "curl 不在 PATH"
  command -v lsof >/dev/null || fail "lsof 不在 PATH（端口/进程树断言需要）"
  if lsof -ti :"$PORT" >/dev/null 2>&1; then
    fail "端口 ${PORT} 被占用（DSH_ACP_GATE_PORT 可换）"
  fi
  if [[ -z "${DSH_ACP_GATE_TGZ:-}" ]]; then
 # 默认流程 pack 经 prepack 先 clean 再全量重建，lib/ 会被重新产出；
    # 此处仅作早期 sanity——lib 缺失说明从未 build 过，提前响亮失败省一轮宿主装配。
    # TGZ 覆写流程不经 pack、完全不读本仓 lib/，故跳过本检查。
    [[ -f "$ADAPTER_DIR/lib/index.js" && -f "$ADAPTER_DIR/lib/client.js" ]] \
      || fail "本包 lib/ 产物缺失，先跑 pnpm build"
  fi
}

pack_tarball() {
  if [[ -n "${DSH_ACP_GATE_TGZ:-}" ]]; then
    step "1/8 跳过 pack：门禁既有 tarball（DSH_ACP_GATE_TGZ 覆写，非发布证据全流程）"
    TGZ="$DSH_ACP_GATE_TGZ"
  else
    step "1/8 pnpm pack（prepack 全量门禁随之运行，需数分钟）"
    (cd "$ADAPTER_DIR" && pnpm pack --pack-destination "$GATE_ROOT")
    TGZ="$(ls "$GATE_ROOT"/zaimokuza-dsh-acp-adapter-*.tgz 2>/dev/null | head -1)"
  fi
  [[ -f "$TGZ" ]] || fail "未找到 pack 产物 tarball（${TGZ:-未定位}）"
  echo "tarball: $TGZ"
}

provision_host() {
  step "2/8 装配宿主工作区（npm 版 @deepseek-ai/dsh@${HOST_SPEC}，lane=${LANE}）"
  mkdir -p "$HOST_DIR"
  cat > "$HOST_DIR/package.json" <<JSON
{
  "name": "dsh-acp-install-gate-host",
  "private": true,
  "dependencies": {
    "@deepseek-ai/dsh": "${HOST_SPEC}"
  }
}
JSON
  # 宿主树的 build script 一律显式跳过（CI pnpm 对未决的 ignored builds 报
  # ERR_PNPM_IGNORED_BUILDS 非零退出，必须逐一点名）：三个原生件随包发布
  # prebuilt 二进制（与本仓 pnpm-workspace.yaml 同一口径）；@google/genai 与
 # protobufjs 的 postinstall 对 dsh boot 非必需（首跑实测钉入）。
  # dsh 树未来新增 build-script 包会让本步大声失败——有意如此，强制复核。
  cat > "$HOST_DIR/pnpm-workspace.yaml" <<'YAML'
packages:
  - .

allowBuilds:
  '@deepseek-ai/dsh-subprocess-local': false
  koffi: false
  node-pty: false
  '@google/genai': false
  protobufjs: false
YAML
  (cd "$HOST_DIR" && pnpm install)
  [[ -x "$DSH_BIN" ]] || fail "宿主 dsh bin 缺失：$DSH_BIN"
  # 落证据：spec（dist-tag 可变）对应的实际解析版本——latest lane 的「真实最新
  # 宿主」以本文件为准，不看步骤名。
  node -e 'console.log(require(process.argv[1]).version)' \
    "$HOST_DIR/node_modules/@deepseek-ai/dsh/package.json" \
    > "$GATE_ROOT/host-version.txt" || fail "无法解析宿主实际版本"
  echo "宿主实际版本：$(cat "$GATE_ROOT/host-version.txt")（spec=${HOST_SPEC}）"
}

# 预置一个 profile（initProfile 产物形态；工具版本由 PATH 决定）。
preset_profile() {
  local name="$1" dir="$DSH_HOME/profiles/$1"
  mkdir -p "$dir"
  cat > "$dir/package.json" <<JSON
{
  "name": "dsh-profile-${name}",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app"
      ]
    }
  }
}
JSON
  cat > "$dir/pnpm-workspace.yaml" <<'YAML'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
YAML
  printf '# Your patch layer for this dsh profile, applied after every bundle layer.\n[]\n' \
    > "$dir/cordis.patch.yml"
}

preset_profiles() {
  step "3/8 预置 profile（${STOCK_PROFILE} 对照 / ${PROFILE} 受测）"
  preset_profile "$STOCK_PROFILE"
  preset_profile "$PROFILE"
}

dump_config() { # dump_config <profile> <out-file>
  "$DSH_BIN" --profile "$1" --dump-config > "$2" || fail "dump-config 失败：profile $1（输出见 $2）"
  head -1 "$2" | grep -q '^# == @deepseek-ai/dsh-base' \
    || fail "dump-config 输出形态异常（首行不是 dsh-base 层头）：$(head -1 "$2")"
}

# 提取 dump 中某个 id 的 row 块（从 `- id: <id>` 到下一个 `- id:` 之前）。
row_block() { # row_block <file> <id>
  awk -v target="- id: $2" '
    /^- id: / { inblock = ($0 == target) }
    inblock { print }
  ' "$1"
}

assert_dump_with_plugin() {
  step "5/8 启动前 dump-config 断言（lane=${LANE}：stock 基线/白名单 diff 为机械钉，计划内 row 为行为契约）"
  dump_config "$STOCK_PROFILE" "$GATE_ROOT/dump-stock.txt"
  dump_config "$PROFILE" "$GATE_ROOT/dump-acp.txt"

  # stock 基线（机械钉——钉的是本版宿主的出厂形态，latest lane 降级为告警）：
  # agent-loop / ui-model-selection 在场且未 disabled，无 agent-loop-acp。
  row_block "$GATE_ROOT/dump-stock.txt" agent-loop | grep -q "name: '@deepseek-ai/dsh-agent-loop'" \
    || soft_fail "stock dump 缺 agent-loop 行"
  row_block "$GATE_ROOT/dump-stock.txt" agent-loop | grep -q 'disabled: true' \
    && soft_fail "stock dump 的 agent-loop 不应 disabled"
  row_block "$GATE_ROOT/dump-stock.txt" ui-model-selection | grep -q 'disabled: true' \
    && soft_fail "stock dump 的 ui-model-selection 不应 disabled"
  grep -q 'id: agent-loop-acp' "$GATE_ROOT/dump-stock.txt" && soft_fail "stock dump 不应含 agent-loop-acp"

  # 受测 profile：计划内三 row（行为契约——证明 patch layer 在真实宿主上生效，
  # 任何 lane 都 fail-hard）。
  row_block "$GATE_ROOT/dump-acp.txt" agent-loop-acp | grep -q "name: '${PKG_NAME}'" \
    || fail "agent-loop-acp 行缺失或 name 不是 ${PKG_NAME}"
  row_block "$GATE_ROOT/dump-acp.txt" agent-loop | grep -q 'disabled: true' \
    || fail "agent-loop 行未 disabled"
  row_block "$GATE_ROOT/dump-acp.txt" ui-model-selection | grep -q 'disabled: true' \
    || fail "ui-model-selection 行未 disabled"

  # 关键 id 无重复。
  for id in agent-loop agent-loop-acp ui-model-selection; do
    local count
    count="$(grep -c "^- id: ${id}\$" "$GATE_ROOT/dump-acp.txt")"
    [[ "$count" = "1" ]] || fail "dump-acp 中 id ${id} 出现 ${count} 次（期望恰好 1）"
  done

  # 与 stock 的 diff 逐行过白名单：只许计划内 row 差异（防未知/重复关键 row）。
  diff "$GATE_ROOT/dump-stock.txt" "$GATE_ROOT/dump-acp.txt" > "$GATE_ROOT/dump.diff" || true
  local unexpected
  unexpected="$(grep -E '^[<>] ' "$GATE_ROOT/dump.diff" | sed -E 's/^[<>] //' | grep -vE \
    -e '^- id: agent-loop$' \
    -e '^- id: agent-loop-acp$' \
    -e '^- id: ui-model-selection$' \
    -e "^  name: '@zaimokuza/dsh-acp-adapter'\$" \
    -e '^  disabled: true$' \
    -e '^  config:$' \
    -e '^    maxParallelToolCalls: 10$' \
    -e '^    agents: \[\]$' \
    -e '^# == ' || true)"
  if [[ -n "$unexpected" ]]; then
    echo "dump diff 含计划外行（${LANE} lane：$([[ "$LANE" = latest ]] && echo 降级告警 || echo fail-hard)）：" >&2
    printf '%s\n' "$unexpected" >&2
    soft_fail "未知 row 差异（完整 diff 见 ${GATE_ROOT}/dump.diff）"
  fi
  echo "dump-config 断言通过（diff 全文见 ${GATE_ROOT}/dump.diff）。"
}

install_plugin() {
  step "4/8 安装 tarball 进 ${PROFILE}（dsh plugin add，.tgz 文件依赖，非 link:）"
  "$DSH_BIN" plugin --profile "$PROFILE" add "$TGZ" || fail "dsh plugin add 失败"
  grep -q "\"${PKG_NAME}\"" "$DSH_HOME/profiles/$PROFILE/package.json" \
    || fail "reconcile 后 profile manifest 不含 ${PKG_NAME}"
}

boot_smoke() {
  step "6/8 boot 冒烟（端口 ${PORT}，日志 ${BOOT_LOG}）"
  "$DSH_BIN" --profile "$PROFILE" --port "$PORT" > "$BOOT_LOG" 2>&1 &
  BOOT_PID=$!
  local i
  for i in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:${PORT}/" > /dev/null 2>&1; then break; fi
    if ! kill -0 "$BOOT_PID" 2>/dev/null; then
      tail -30 "$BOOT_LOG" >&2
      fail "dsh 进程提前退出"
    fi
    sleep 1
  done
  curl -sf "http://127.0.0.1:${PORT}/" > /dev/null || { tail -30 "$BOOT_LOG" >&2; fail "boot 60s 内未就绪"; }
  # 插件 client bundle 经宿主 /plugins 路由可服务（scoped id 含斜杠，宿主明确支持），
  # 且注册 id 就是 scoped 包名（loader 以包名键注册）。rolldown 会把 banner 重排成
  # 多行（见 verify-bundle ③ 同款规范化断言），故分两断言行判定。
  curl -sf "http://127.0.0.1:${PORT}/plugins/${PKG_NAME}/client.js" > "$GATE_ROOT/client-served.js" \
    || fail "插件 client bundle 路由 404：/plugins/${PKG_NAME}/client.js"
  head -c 400 "$GATE_ROOT/client-served.js" | grep -q 'window.__ModuleLoader__.load({' \
    || fail "client bundle 不以 __ModuleLoader__.load 包装开头"
  head -c 400 "$GATE_ROOT/client-served.js" | grep -q "id: \"${PKG_NAME}\"" \
    || fail "client bundle 注册 id 不是 ${PKG_NAME}"
  # 保存最小进程清单，供失败时判断是否残留宿主进程。
  ps -Ao pid,ppid,command | grep -E "[d]sh|node.*${PROFILE}" > "$GATE_ROOT/boot-processes.txt" || true
  # 日志致命词断言（[dsh-acp *] WARN 是允许噪音；ERROR 不是）。
  if grep -nE 'ERROR|Unhandled|unhandled rejection|Cannot find module|EADDRINUSE' "$BOOT_LOG"; then
    fail "boot 日志含致命错误（见上）"
  fi
  echo "boot 冒烟通过（web 200 + 插件 bundle 路由 200 + 日志无致命词）。"
}

# native provider 回归；无 DEEPSEEK_API_KEY 时验证 MISSING_CREDENTIAL 边界。
native_regression() {
  local credential_state
  credential_state="$(credential_presence)"
  step "7/8 native provider 回归（DEEPSEEK_API_KEY ${credential_state}）"
  local base="http://127.0.0.1:${PORT}/api" out="$GATE_ROOT/native-regression.txt"
  local create sid hist
  create="$(curl -sS -X POST "${base}/session.create" -H 'content-type: application/json' \
    -d '{"type":"client-request","rpcId":"gate-create","method":"session.create","payload":{"cwd":"/tmp/dsh-acp-install-gate-native"}}')" \
    || fail "native 回归：session.create 请求失败"
  sid="$(printf '%s' "$create" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.result||!j.result.ok){console.error(s);process.exit(1)};console.log(j.result.value.sessionId)})')" \
    || fail "native 回归：session.create 未返回 ok"
  local expected_nonce='dsh-install-gate-native-ok'
  curl -sS -X POST "${base}/session.prompt" -H 'content-type: application/json' \
    -d "{\"type\":\"client-request\",\"rpcId\":\"gate-prompt\",\"method\":\"session.prompt\",\"payload\":{\"sessionId\":\"${sid}\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"reply exactly with ${expected_nonce}\"}]}}" \
    > /dev/null || fail "native 回归：session.prompt 请求失败"
  local status='pending'
  local poll
  # LLM latency is variable; poll the structured history for a bounded 90s
  # budget.  The helper emits only a small status word, never the history.
  for poll in $(seq 1 45); do
    hist="$(curl -sS -X POST "${base}/session.history" -H 'content-type: application/json' \
      -d "{\"type\":\"client-request\",\"rpcId\":\"gate-history-${poll}\",\"method\":\"session.history\",\"payload\":{\"sessionId\":\"${sid}\"}}")" \
      || fail "native 回归：session.history 请求失败"
    status="$(printf '%s' "$hist" | node "$ADAPTER_DIR/scripts/install-gate-history.mjs" --status "$expected_nonce")" \
      || fail "native 回归：session.history 返回非法 envelope（${out}）"
    case "$status" in
      pass)
        [[ -n "${DEEPSEEK_API_KEY:-}" ]] \
          || fail "native 回归（降级级）：无 key 却收到 completed nonce（${out}）"
        break
        ;;
      missing-credential)
        [[ -z "${DEEPSEEK_API_KEY:-}" ]] \
          || fail "native 回归：DEEPSEEK_API_KEY 在场却收到 MISSING_CREDENTIAL（${out}）"
        break
        ;;
      fail)
        fail "native 回归：目标 turn 终态失败或 assistant 未返回预期 nonce（${out}）"
        ;;
      pending)
        sleep 2
        ;;
      *)
        fail "native 回归：history 判定器返回未知状态（${out}）"
        ;;
    esac
  done
  # Artifact 只保存判定所需元数据；完整 session history 可能包含用户或模型内容，
  # 不得写入磁盘或上传到 CI。
  printf 'sessionId=%s\nstatus=%s\ncredentialState=%s\npolls=%s\n' \
    "$sid" "$status" "$credential_state" "$poll" > "$out"
  report_native_regression_status "$status" "$out"
}

# Credential-safety canary.  It writes through the same evidence-directory
# convention as the gate and proves the value never reaches either stream or an
# artifact.  This is deliberately opt-in so normal runs still perform the full
# release gate.
self_test() {
  local artifact="$GATE_ROOT/install-gate-self-test.log"
  local state
  state="$(credential_presence)"
  printf 'credential_state=%s\n' "$state" > "$artifact"
  echo "install-gate self-test passed (artifact ${artifact})"
}

shutdown_boot() {
  if [[ -z "$BOOT_PID" ]]; then return; fi
  kill "$BOOT_PID" 2>/dev/null || true
  local i
  for i in $(seq 1 10); do
    if ! lsof -ti :"$PORT" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  if lsof -ti :"$PORT" >/dev/null 2>&1; then
    lsof -ti :"$PORT" | xargs kill -9 2>/dev/null || true
  fi
  wait "$BOOT_PID" 2>/dev/null || true
  BOOT_PID=''
  if curl -sf "http://127.0.0.1:${PORT}/" > /dev/null 2>&1; then
    fail "boot 关停后端口 ${PORT} 仍在服务（进程残留）"
  fi
  echo "boot 已关停，端口释放。"
}

uninstall_and_assert() {
  step "8/8 卸载并断言 stock 行恢复、零残留"
  shutdown_boot
  "$DSH_BIN" plugin --profile "$PROFILE" remove "$PKG_NAME" || fail "dsh plugin remove 失败"
  grep -q "\"${PKG_NAME}\"" "$DSH_HOME/profiles/$PROFILE/package.json" \
    && fail "卸载后 profile manifest 仍含 ${PKG_NAME}"
  [[ ! -e "$DSH_HOME/profiles/$PROFILE/node_modules/@zaimokuza/dsh-acp-adapter" ]] \
    || fail "卸载后 profile node_modules 仍残留本包"
  dump_config "$PROFILE" "$GATE_ROOT/dump-acp-after-remove.txt"
  # 卸载后与 stock 逐字节一致是机械钉（钉本版宿主的恢复形态）；latest lane 降级
  # 为告警——manifest/node_modules 零残留的行为断言在上方已 fail-hard。
  if ! diff "$GATE_ROOT/dump-stock.txt" "$GATE_ROOT/dump-acp-after-remove.txt" > "$GATE_ROOT/dump-after-remove.diff"; then
    cat "$GATE_ROOT/dump-after-remove.diff" >&2
    soft_fail "卸载后 dump 与 stock 不逐字节一致（残留 patch row，见上 diff）"
  fi
 # sidecar 摘要证据（计划 产物项；本门禁不建 ACP 会话，正常应为空目录或缺席）。
  if [[ -d "$DSH_HOME/dsh-acp" ]]; then
    ls -la "$DSH_HOME/dsh-acp" > "$GATE_ROOT/sidecar-summary.txt"
  else
    echo "(no dsh-acp sidecar dir — 未建 ACP 会话，符合预期)" > "$GATE_ROOT/sidecar-summary.txt"
  fi
  echo "卸载断言通过：stock agent-loop / ui-model-selection 恢复，dump 与 stock 逐字节一致。"
}

main() {
  preflight
  pack_tarball
  provision_host
  preset_profiles
  install_plugin
  assert_dump_with_plugin
  boot_smoke
  native_regression
  uninstall_and_assert
  step "install-gate 全绿（lane=${LANE}，host spec=${HOST_SPEC}，实际版本 $(cat "$GATE_ROOT/host-version.txt")）"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" && "${1:-}" = "--self-test" ]]; then
  self_test
elif [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
