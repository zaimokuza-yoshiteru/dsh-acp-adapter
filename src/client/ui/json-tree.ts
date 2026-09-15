import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { JsonTreeLabels, JsonTreeProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AcpLocaleKey } from './locales.ts'

export type AcpJsonStringWrapping = Omit<NonNullable<JsonTreeProps['stringWrapping']>, 'label'>

type Translate = (key: AcpLocaleKey, params?: Record<string, string | number>) => string

/** Shared copy for all ACP JSON inspectors. */
export function acpJsonTreeLabels(t: Translate | undefined): JsonTreeLabels {
  const text = (key: AcpLocaleKey, fallback: string, params?: Record<string, string | number>): string => {
    const value = t?.(key, params)
    return value === undefined || value.trim() === '' ? fallback : value
  }
  return {
    copyValue: text('auditCopyValue', 'Copy value'),
    copyJson: text('auditCopyJson', 'Copy JSON'),
    copyPath: text('auditCopyPath', 'Copy path'),
    copyPrettyJson: text('auditCopyPrettyJson', 'Copy formatted JSON'),
    copyCompactJson: text('auditCopyCompactJson', 'Copy compact JSON'),
    copied: text('auditCopied', 'Copied'),
    copyFailed: text('auditCopyFailed', 'Copy failed'),
    collapseNode: text('auditCollapseNode', 'Collapse node'),
    expandNode: text('auditExpandNode', 'Expand node'),
    copyButtonTitle: action => text('auditCopyOptions', `Copy options: ${action}`, { action }),
  }
}

/** Share the native expanded-string preference for one client registration. */
export function createAcpJsonStringWrapping(): AcpJsonStringWrapping {
  const store = createSnapshotStore(true)
  return { getDefault: store.getSnapshot, setDefault: value => { store.set(value) } }
}
