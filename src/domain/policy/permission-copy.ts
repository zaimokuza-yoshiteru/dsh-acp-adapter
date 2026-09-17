/** Adapter-owned approval text; Agent commands, titles and options stay intact. */
const en = {
  actions: { execute: 'run a command', edit: 'edit files', delete: 'delete files', move: 'move files', read: 'read restricted content', fetch: 'access a restricted external resource' } as Record<string, string>,
  restrictedOperation: 'perform a restricted operation',
  request: (action: string) => `The ACP Agent requests permission to ${action}.`,
  tool: 'Tool', command: 'Command', target: 'Target', details: 'Details',
  unknownCommand: 'Command details were not provided by the Agent or could not be matched to this request.',
  agentOption: 'Agent option',
  option: (ordinal: number) => `option ${String(ordinal)}`,
  acpTool: 'ACP tool',
}

const zh: typeof en = {
  actions: { execute: '执行命令', edit: '编辑文件', delete: '删除文件', move: '移动文件', read: '读取受限内容', fetch: '访问受限的外部资源' },
  restrictedOperation: '执行受限操作',
  request: action => `ACP Agent 请求${action}的权限。`,
  tool: '工具', command: '命令', target: '目标', details: '详情',
  unknownCommand: 'Agent 未提供命令详情，或无法将命令与本次请求对应。',
  agentOption: 'Agent 选项',
  option: ordinal => `选项 ${String(ordinal)}`,
  acpTool: 'ACP 工具',
}

export type PermissionCopy = typeof en

/** Host locale preference is optional; browser-only detection is unavailable here. */
export function permissionCopy(locale: string | undefined): PermissionCopy {
  return /^zh(?:-|$)/i.test(locale ?? '') ? zh : en
}
