/** Copy used only by the opt-in searchable composer model seat. */
export const zh = {
  trigger: '模型',
  search: '搜索模型名称、ID 或提供商',
  model: '模型',
  effort: '推理等级',
  providerAccount: 'DeepSeek 账号',
  providerDefault: '默认',
  loading: '正在读取模型目录…',
  retry: '重试',
  noResults: '没有匹配的模型。',
  noModels: '没有可用的模型。',
  noEfforts: '当前模型未提供推理等级。',
  operationFailed: '模型操作失败：{message}',
  sessionInUse: '当前会话已被占用，请关闭其他正在运行的 DSH 实例后重试。',
  groupFailed: '{name} 加载失败：{message}',
} as const

export type ModelPickerLocaleKey = keyof typeof zh

export const en: Record<ModelPickerLocaleKey, string> = {
  trigger: 'Model',
  search: 'Search model name, ID, or provider',
  model: 'Model',
  effort: 'Reasoning effort',
  providerAccount: 'DeepSeek Account',
  providerDefault: 'Default',
  loading: 'Loading model catalog…',
  retry: 'Retry',
  noResults: 'No matching models.',
  noModels: 'No models available.',
  noEfforts: 'The current model does not provide reasoning effort options.',
  operationFailed: 'Model operation failed: {message}',
  sessionInUse: 'This session is in use. Close other running DSH instances and try again.',
  groupFailed: '{name} failed to load: {message}',
}
