import { expect, it } from 'vitest'
import { isDevinReviewerAgent, isLocalDevinReviewProfile } from '../../../src/contract/devin-review.ts'

it('matches the local Devin ACP entrypoint without treating a wrapper or Cloud session as local', () => {
  expect(isLocalDevinReviewProfile({ command: '/opt/local/bin/devin', args: ['acp'] })).toBe(true)
  expect(isLocalDevinReviewProfile({ command: String.raw`C:\Apps\Devin.exe`, args: ['acp'] })).toBe(true)
  expect(
    isLocalDevinReviewProfile({
      command: 'devin',
      args: ['--permission-mode', 'auto', 'acp', '--process-model', 'in-process', '--model', 'swe-2-high'],
    }),
  ).toBe(true)
  for (const profile of [
    { command: 'devin', args: ['acp', '--cloud'] },
    { command: 'devin', args: ['acp', '--agent-type', 'review'] },
    { command: 'devin', args: ['--config', '/other/config', 'acp'] },
    { command: 'devin', args: ['--model', 'acp'] },
    { command: 'company-devin', args: ['acp'] },
    { command: 'node', args: ['devin.js', 'acp'] },
  ])
    expect(isLocalDevinReviewProfile(profile)).toBe(false)
})

it('identifies only the build with verified extension resolution timing', () => {
  const info = { name: 'affogato', title: 'Devin Agent', version: '3000.14.30821' }
  expect(isDevinReviewerAgent(info)).toBe(true)
  expect(isDevinReviewerAgent({ ...info, version: '3000.14.30820' })).toBe(false)
  expect(isDevinReviewerAgent({ ...info, version: '3000.14.30822' })).toBe(false)
  expect(isDevinReviewerAgent({ ...info, name: 'custom' })).toBe(false)
})
