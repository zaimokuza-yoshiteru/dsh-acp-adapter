/** Adapter-owned approval text; Agent commands, titles and options stay intact. */
const en = {
  actions: {
    execute: 'Run a command',
    edit: 'Edit files',
    delete: 'Delete files',
    move: 'Move files',
    read: 'Read restricted content',
    fetch: 'Access a restricted external resource',
  } as Record<string, string>,
  restrictedOperation: 'Restricted operation',
  permission: 'Permission request',
  command: 'Command',
  directory: 'Working directory',
  backgroundWait: (milliseconds: number) => `Wait before backgrounding: ${milliseconds} ms`,
  filePath: 'File path',
  content: 'Content',
  locations: 'Locations',
  input: 'Input',
  details: 'Details',
  member: 'Member',
  responsibility: 'Responsibility',
  recipient: 'Recipient',
  workspace: 'Shared workspace',
  context: 'Context',
  provider: 'Provider',
  model: 'Model',
  agent: 'Agent',
  unknownCommand: 'Command details were not provided by the Agent or could not be matched to this request.',
  agentOption: 'Agent option',
  option: (ordinal: number) => `option ${String(ordinal)}`,
  acpTool: 'ACP tool',
  allowOnce: 'Allow once',
  rejectOnce: 'Reject once',
  delegatedPermissionUnavailable:
    'The host does not yet support these authorization options for child sessions; no permission was granted.',
  delegatedQuestionUnavailable: 'The host does not yet support questions for child sessions; no answer was submitted.',
  permissionPolicyUnavailable:
    'The automatic approval rule failed. This operation was not authorized. Try again after the rule is available.',
}

const zh: typeof en = {
  actions: {
    execute: '执行命令',
    edit: '编辑文件',
    delete: '删除文件',
    move: '移动文件',
    read: '读取受限内容',
    fetch: '访问受限的外部资源',
  },
  restrictedOperation: '受限操作',
  permission: '授权请求',
  command: '命令',
  directory: '工作目录',
  backgroundWait: (milliseconds) => `转入后台前等待: ${milliseconds} 毫秒`,
  filePath: '文件路径',
  content: '内容',
  locations: '位置',
  input: '输入',
  details: '详情',
  member: '成员',
  responsibility: '职责',
  recipient: '接收者',
  workspace: '共享工作目录',
  context: '上下文',
  provider: '提供方',
  model: '模型',
  agent: 'Agent',
  unknownCommand: 'Agent 未提供命令详情，或无法将命令与本次请求对应。',
  agentOption: 'Agent 选项',
  option: (ordinal) => `选项 ${String(ordinal)}`,
  acpTool: 'ACP 工具',
  allowOnce: '本次允许',
  rejectOnce: '本次拒绝',
  delegatedPermissionUnavailable: '宿主暂不支持子会话的此类授权选项；本次未授权。',
  delegatedQuestionUnavailable: '宿主暂不支持子会话的此类问答；本次未提交答案。',
  permissionPolicyUnavailable: '自动审批规则暂不可用，本次操作未获授权。请在规则恢复后重试。',
}

export type PermissionCopy = typeof en

/** Host locale preference is optional; browser-only detection is unavailable here. */
export function permissionCopy(locale: string | undefined): PermissionCopy {
  return /^zh(?:-|$)/i.test(locale ?? '') ? zh : en
}
