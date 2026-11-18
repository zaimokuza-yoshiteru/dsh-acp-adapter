import { expect, it } from 'vitest'
import { localizedDiagnostic } from '../../../src/client/data/diagnostics.ts'
import { AcpClientError } from '../../../src/protocol/v1/errors.ts'

const translate = (_key: string, params?: Record<string, string | number>) => `Localized failure${params?.reference}`

it('preserves current Host correlation IDs through localized UI diagnostics', () => {
  const error = new AcpClientError('timeout', 'private Host detail')
  expect(localizedDiagnostic(translate, 'failed', `${error.code}: ${error.message} [${error.correlationId}]`)).toBe(
    `Localized failure (${error.correlationId})`,
  )
})

it('retains references in historical diagnostics', () => {
  const id = 'acperr-20260820T184752Z-1-abcdef'
  expect(localizedDiagnostic(translate, 'failed', `ACP_TIMEOUT: old Host detail [${id}]`)).toBe(
    `Localized failure (${id})`,
  )
})

it('uses only stable codes when no valid correlation ID is available', () => {
  expect(localizedDiagnostic(translate, 'failed', 'ACP_TIMEOUT: private Host detail')).toBe(
    'Localized failure (ACP_TIMEOUT)',
  )
  expect(localizedDiagnostic(translate, 'failed', 'private Host detail')).toBe('Localized failure')
})
