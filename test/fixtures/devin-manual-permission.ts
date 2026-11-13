import type { AcpPermissionAskedAuditData, AcpPermissionCheckAuditData } from '../../src/domain/policy/events.ts'

// Protocol-only facts from CLI 3000.12.43's fourth RC.2 Teams run (2026-11-13).
// Session/request/call identifiers are synthetic; the options, identity and {} hash are unchanged.
export const devinManualPermission: {
  asked: AcpPermissionAskedAuditData
  bridge: AcpPermissionCheckAuditData
} = {
  asked: {
    phase: 'asked',
    requestId: 'request',
    agentSessionId: 'acp',
    toolCall: {
      toolCallId: 'real-call',
      title: 'list_agents',
      rawInputSummary: '{}',
      rawInputHash: '44136fa355b3678a',
    },
    locationCount: 0,
    omittedLocationCount: 0,
    optionCount: 7,
    omittedOptionCount: 0,
    options: [
      { optionId: 'allow_once', kind: 'allow_once', name: 'Allow' },
      {
        optionId: 'allow_session',
        kind: 'allow_always',
        name: 'Yes, allow calling list_agents on the dsh MCP server (this session)',
      },
      {
        optionId: 'allow_always',
        kind: 'allow_always',
        name: 'Yes, always allow calling list_agents on the dsh MCP server',
      },
      {
        optionId: 'allow_server_session',
        kind: 'allow_always',
        name: 'Yes, allow calling all tools on the dsh MCP server (this session)',
      },
      {
        optionId: 'allow_server_always',
        kind: 'allow_always',
        name: 'Yes, always allow calling tools on the dsh MCP server',
      },
      { optionId: 'switch_bypass', kind: 'allow_always', name: 'Yes, switch to bypass mode' },
      { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
    ],
  },
  bridge: {
    phase: 'bridge',
    agentSessionId: 'acp',
    toolCallId: 'real-call',
    toolName: 'list_agents',
    reason: 'approval-required',
    identitySource: 'devin-title',
    structuredIdentityPresent: false,
    titleMatchesCurrentTool: true,
  },
}
