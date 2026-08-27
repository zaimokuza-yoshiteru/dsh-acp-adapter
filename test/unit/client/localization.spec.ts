import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { localizedDiagnostic } from '../../../src/client/data/diagnostics.ts'
import type { AcpProviderHealth } from '../../../src/client/data/logic.ts'
import { healthDiagnostic } from '../../../src/client/ui/AcpSection.ts'
import { en, zh } from '../../../src/client/ui/locales.ts'
import { permissionReasonText } from '../../../src/client/ui/AcpPermissionInputDock.ts'
import type { AcpPendingPermissionView } from '../../../src/client/data/acp-remote.ts'

function translator(dictionary: Record<string, string>) {
  return (key: string, params: Record<string, string | number> = {}): string => {
    let value = dictionary[key] ?? key
    for (const [name, replacement] of Object.entries(params)) {
      value = value.replaceAll(`{${name}}`, String(replacement))
    }
    return value
  }
}

const enT = translator(en)
const zhT = translator(zh)
const containsHan = (value: string): boolean => /[\u3400-\u9fff]/u.test(value)

function failedHealth(message: string, failureKind = 'auth_required'): AcpProviderHealth {
  return {
    id: 'codex',
    name: 'Codex',
    command: 'codex-acp',
    args: [],
    loginHint: 'codex login',
    executable: true,
    version: null,
    state: 'auth-required',
    probe: { status: 'error', at: 1, failureKind, message, phase: 'initialize' },
  }
}

describe('client localization boundaries', () => {
  it('keeps product-owned Han copy inside locale dictionaries', () => {
    const roots = ['src/client', 'src/domain', 'src/host', 'src/protocol']
    const files: string[] = []
    const walk = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name)
        if (entry.isDirectory()) walk(file)
        else if (/\.tsx?$/u.test(file)) files.push(file)
      }
    }
    for (const root of roots) walk(root)

    const leaks: string[] = []
    for (const file of files) {
      if (file.endsWith('/locales.ts') || file.endsWith('/selector-locales.ts')) continue
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      const visit = (node: ts.Node): void => {
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node))
          && /[\u3400-\u9fff]/u.test(node.getText(source))) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
          leaks.push(`${file}:${String(line)}`)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(leaks).toEqual([])
  })

  it('English Check ACP copy is derived from failureKind and never leaks host Chinese prose', () => {
    const raw = '需要登录，请重新检查（错误编号 acperr-20260827T142519Z-5-7d3eea7）'
    const message = healthDiagnostic(enT, 'codex-acp', failedHealth(raw))
    expect(message).toContain('not signed in')
    expect(message).toContain('acperr-20260827T142519Z-5-7d3eea7')
    expect(containsHan(message ?? '')).toBe(false)
  })

  it('Chinese Check ACP copy uses the same stable failure facts', () => {
    const message = healthDiagnostic(zhT, 'codex-acp', failedHealth('requires authentication'))
    expect(message).toContain('尚未登录')
  })

  it('generic RPC diagnostics keep only a stable reference, not arbitrary host prose', () => {
    const message = localizedDiagnostic(enT, 'actionSaveFailed', '保存失败 ACP_SETTINGS_WRITE_FAILED')
    expect(message).toBe('Saving failed. Try again. (ACP_SETTINGS_WRITE_FAILED)')
    expect(containsHan(message)).toBe(false)
  })

  it('permission explanations are localized from ACP facts instead of persisted host prose', () => {
    const item: AcpPendingPermissionView = {
      requestId: 'request-1',
      sessionId: 'session-1',
      acpSessionId: 'agent-session-1',
      toolCallId: 'tool-1',
      title: 'Bash',
      kind: 'execute',
      reason: 'ACP Agent 请求执行一条需要额外权限的命令。',
      createdAt: 1,
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    }
    const message = permissionReasonText(item, enT)
    expect(message).toContain('run a command')
    expect(containsHan(message)).toBe(false)
  })
})
