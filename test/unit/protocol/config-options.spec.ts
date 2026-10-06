import { describe, expect, it } from 'vitest'
import { ACP_CONFIG_IDENTIFIER_MAX } from '../../../src/contract/config-options.ts'
import { acpConfigOptionsSnapshot } from '../../../src/protocol/v1/config-options.ts'

describe('ACP config option identity bounds', () => {
  it('keeps IDs and values through 512 characters and drops values above the limit intact', () => {
    const id511 = 'a'.repeat(ACP_CONFIG_IDENTIFIER_MAX - 1)
    const id512 = 'b'.repeat(ACP_CONFIG_IDENTIFIER_MAX)
    const id513 = 'c'.repeat(ACP_CONFIG_IDENTIFIER_MAX + 1)
    const snapshot = acpConfigOptionsSnapshot([
      {
        id: id511,
        name: 'Mode 511',
        type: 'select',
        currentValue: id511,
        options: [{ value: id511, name: '511' }],
      },
      {
        id: id512,
        name: 'Mode 512',
        type: 'select',
        currentValue: id512,
        options: [
          { value: id512, name: '512' },
          { value: id513, name: 'too long' },
        ],
      },
      { id: id513, name: 'Too long ID', type: 'boolean', currentValue: true },
      {
        id: 'too-long-current',
        name: 'Too long current value',
        type: 'select',
        currentValue: id513,
        options: [{ value: 'safe', name: 'Safe' }],
      },
    ])
    expect(snapshot?.map((option) => option.id)).toEqual([id511, id512])
    expect(snapshot?.[0]).toMatchObject({ currentValue: id511, options: [{ value: id511 }] })
    expect(snapshot?.[1]).toMatchObject({ currentValue: id512, options: [{ value: id512 }] })
  })
})
