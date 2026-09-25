import { describe, expect, it } from 'vitest'
import { StderrRing, defaultRedactStderrLine } from '../../../src/runtime/process/stderr.ts'

describe('StderrRing private-key redaction', () => {
  it('masks a complete PEM block inside one push and keeps following text visible', () => {
    const ring = new StderrRing(20, 4096, defaultRedactStderrLine)
    ring.push('before -----BEGIN PRIVATE KEY-----\nprivate-key-body\n-----END PRIVATE KEY----- after password=hunter2\nordinary diagnostic')

    const snapshot = ring.snapshot()
    const text = snapshot.join('\n')
    expect(text).not.toContain('private-key-body')
    expect(text).toContain('before <redacted-private-key>')
    expect(text).toContain('after password=<redacted>')
    expect(snapshot).toContain('ordinary diagnostic')
  })

  it('masks bodies across pushes until the matching END marker', () => {
    const ring = new StderrRing(20, 4096, defaultRedactStderrLine)
    ring.push('-----BEGIN EC PRIVATE KEY-----')
    ring.push('first secret line')
    ring.push('-----BEGIN EC PRIVATE KEY-----')
    ring.push('-----END EC PRIVATE KEY----- trailing API_TOKEN=after-key')
    ring.push('visible post-key diagnostic')

    const snapshot = ring.snapshot()
    expect(snapshot.join('\n')).not.toContain('first secret line')
    expect(snapshot).toContain('<redacted-private-key>')
    expect(snapshot.join('\n')).toContain('trailing API_TOKEN=<redacted>')
    expect(snapshot).toContain('visible post-key diagnostic')
    expect(snapshot.filter(line => line === '<redacted-private-key>')).toHaveLength(1)
  })

  it('keeps masking a truncated block across pushes, then resumes ordinary redaction after END', () => {
    const ring = new StderrRing(20, 4096, defaultRedactStderrLine)
    ring.push('-----BEGIN OPENSSH PRIVATE KEY-----')
    ring.push('x'.repeat(5000))
    ring.push('still private')
    expect(ring.snapshot().join('\n')).not.toContain('still private')

    ring.push('-----END OPENSSH PRIVATE KEY-----')
    ring.push('ordinary TOKEN=after-key')
    expect(ring.snapshot().join('\n')).not.toContain('still private')
    expect(ring.snapshot()).toContain('ordinary TOKEN=<redacted>')
  })

  it('continues masking when a complete block is followed by a truncated block in one push', () => {
    const ring = new StderrRing(20, 4096, defaultRedactStderrLine)
    ring.push('-----BEGIN PRIVATE KEY-----\nfirst body\n-----END PRIVATE KEY-----\n-----BEGIN RSA PRIVATE KEY-----')
    ring.push('second body')
    ring.push('-----END RSA PRIVATE KEY-----')
    ring.push('visible after both blocks')

    const text = ring.snapshot().join('\n')
    expect(text).not.toContain('first body')
    expect(text).not.toContain('second body')
    expect(text.match(/<redacted-private-key>/g)).toHaveLength(2)
    expect(text).toContain('visible after both blocks')
  })
})
