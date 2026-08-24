#!/usr/bin/env node
// unknown-notify-agent.mjs — 最小 ACP agent fixture（零依赖纯 Node ESM）。
//
// 用途：mock-agent.mjs 的固定 scenario 不含"未知厂商通知"，而约束禁止改 mock 本体，
// 故用本 fixture 补 的 `_vendor/foo` 容忍性用例：
//   - session/new 响应前先推一条 `_vendor/foo` 通知（对齐 devin 的 `_cognition.ai/*` 习惯）
//   - session/prompt turn 中途再推一条 `_vendor/foo`
// 只实现 initialize / session/new / session/prompt 三个方法，其余帧忽略。
import readline from 'node:readline';

function send(frame) {
  process.stdout.write(JSON.stringify(frame) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed); // fixture 只被测试驱动，输入必为合法 JSON
  if (msg.id === undefined) return; // 通知/响应一律忽略
  switch (msg.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
          authMethods: [],
        },
      });
      break;
    case 'session/new':
      send({ jsonrpc: '2.0', method: '_vendor/foo', params: { hint: 'before-session-new-response' } });
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'vendor-session-1' } });
      break;
    case 'session/prompt':
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: msg.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'vendor-ok' } },
        },
      });
      send({ jsonrpc: '2.0', method: '_vendor/foo', params: { hint: 'mid-turn' } });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      break;
    default:
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
