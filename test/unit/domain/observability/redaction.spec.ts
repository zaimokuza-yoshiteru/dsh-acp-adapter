import { describe, expect, it } from 'vitest'
import { isSensitiveActivityField, redactSecretText } from '../../../../src/domain/observability/redaction.ts'

describe('shared secret redaction', () => {
  it('redacts common AWS, Slack, Google, and PEM credential forms', () => {
    const awsId = 'AKIAIOSFODNN7EXAMPLE'
    const slack = ['xoxb', '1'.repeat(12), '2'.repeat(12), 'a'.repeat(24)].join('-')
    const googleApiKey = `AIza${'A'.repeat(35)}`
    const googleClientSecret = `GOCSPX-${'a'.repeat(28)}`
    const privateKey = '-----BEGIN PRIVATE KEY-----\nprivate-key-body\n-----END PRIVATE KEY-----'
    const input = [
      `access key ${awsId}`,
      `Slack token ${slack}`,
      `Google key ${googleApiKey}`,
      `Google client secret ${googleClientSecret}`,
      'AWS_SECRET_ACCESS_KEY=aws-secret-value',
      privateKey,
    ].join('\n')
    const redacted = redactSecretText(input)

    expect(redacted).not.toContain(awsId)
    expect(redacted).not.toContain(slack)
    expect(redacted).not.toContain(googleApiKey)
    expect(redacted).not.toContain(googleClientSecret)
    expect(redacted).not.toContain('aws-secret-value')
    expect(redacted).not.toContain('private-key-body')
    expect(redacted).toContain('<redacted-aws-key>')
    expect(redacted).toContain('<redacted-slack-token>')
    expect(redacted).toContain('<redacted-google-key>')
    expect(redacted).toContain('<redacted-google-secret>')
    expect(redacted).toContain('<redacted-private-key>')
  })

  it('redacts bare sensitive assignments, preserves exact numeric usage, and leaves ordinary text alone', () => {
    expect(redactSecretText('token=secret-value password=hunter2 apiKey=abc123')).toBe(
      'token=<redacted> password=<redacted> apiKey=<redacted>',
    )
    expect(redactSecretText('inputTokens=42 outputTokens=7 ordinary text remains')).toBe(
      'inputTokens=42 outputTokens=7 ordinary text remains',
    )
    expect(redactSecretText('AKIA-short xoxb-public AIza-short is ordinary text')).toBe(
      'AKIA-short xoxb-public AIza-short is ordinary text',
    )
  })

  it('only exempts non-negative safe-integer counters with the exact usage field names', () => {
    expect(isSensitiveActivityField('inputTokens', 42)).toBe(false)
    expect(isSensitiveActivityField('cacheReadTokens', 0)).toBe(false)
    expect(isSensitiveActivityField('inputTokens', '42')).toBe(true)
    expect(isSensitiveActivityField('inputTokens', -1)).toBe(true)
    expect(isSensitiveActivityField('outputTokens', Number.MAX_SAFE_INTEGER + 1)).toBe(true)
    expect(isSensitiveActivityField('token', 42)).toBe(true)
    expect(isSensitiveActivityField('accessToken', 'secret-value')).toBe(true)
  })

  it('redacts JSON api_key and password and preserves credentials objects and numeric usage fields', () => {
    const jsonApi = '{"api_key": "abc123secretvalue"}'
    const redactedApi = redactSecretText(jsonApi)
    expect(redactedApi).not.toContain('abc123secretvalue')
    expect(redactedApi).toContain('api_key')

    const jsonPassword = '{"password":"hunter2"}'
    const redactedPass = redactSecretText(jsonPassword)
    expect(redactedPass).not.toContain('hunter2')

    const creds = '{"credentials": {"a":1}}'
    const redactedCreds = redactSecretText(creds)
    expect(redactedCreds).toContain('{"credentials": {')

    const usage = '{"inputTokens": 123}'
    const redactedUsage = redactSecretText(usage)
    expect(redactedUsage).toContain('"inputTokens": 123')
  })

  it('redacts Authorization: Basic credentials without leaking base64', () => {
    const header = 'Authorization: Basic dXNlcjpwYXNz'
    const redacted = redactSecretText(header)
    expect(redacted).not.toContain('dXNlcjpwYXNz')
    expect(redacted).toContain('Authorization')

    const shortHeader = 'Authorization: Basic dTpw'
    const shortRedacted = redactSecretText(shortHeader)
    expect(shortRedacted).toContain('<redacted>')
    expect(shortRedacted).not.toContain('dTpw')
    for (const token of ['OnA=', 'dTo=', 'Og==']) {
      const result = redactSecretText(`Authorization: Basic ${token}`)
      expect(result).toContain('<redacted>')
      expect(result).not.toContain(token)
    }
  })
})
