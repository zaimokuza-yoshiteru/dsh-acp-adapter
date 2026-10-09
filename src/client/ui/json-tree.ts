import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { JsonTreeLabels, JsonTreeProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AcpLocaleKey } from './locales.ts'

export type AcpJsonStringWrapping = Omit<NonNullable<JsonTreeProps['stringWrapping']>, 'label'>

type Translate = (key: AcpLocaleKey, params?: Record<string, string | number>) => string

/** Shared copy for all ACP JSON inspectors. */
export function acpJsonTreeLabels(t: Translate): JsonTreeLabels {
  return {
    copyValue: t('auditCopyValue'),
    copyJson: t('auditCopyJson'),
    copyPath: t('auditCopyPath'),
    copyPrettyJson: t('auditCopyPrettyJson'),
    copyCompactJson: t('auditCopyCompactJson'),
    copied: t('auditCopied'),
    copyFailed: t('auditCopyFailed'),
    collapseNode: t('auditCollapseNode'),
    expandNode: t('auditExpandNode'),
    copyButtonTitle: (action) => t('auditCopyOptions', { action }),
  }
}

/** Share the native expanded-string preference for one client registration. */
export function createAcpJsonStringWrapping(): AcpJsonStringWrapping {
  const store = createSnapshotStore(true)
  return {
    getDefault: store.getSnapshot,
    setDefault: (value) => {
      store.set(value)
    },
  }
}
