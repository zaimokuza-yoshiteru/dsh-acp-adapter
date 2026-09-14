import type { AcpAgentSessionSnapshotView, AcpAgentSessionOptionWrite } from './remote.ts'
import { normalizeAcpConfigOptionKey } from './config-options.ts'

export function teamModeChoices(snapshot: AcpAgentSessionSnapshotView) {
  const option = snapshot.configOptions?.find(option => normalizeAcpConfigOptionKey(option.id) === 'mode' || normalizeAcpConfigOptionKey(option.category ?? '') === 'mode')
  if (option !== undefined) {
    if (option.type !== 'select') return []
    return option.options.flatMap(entry => 'options' in entry ? entry.options : [entry]).map(value => ({
      id: value.value, name: value.name, label: `${option.name}: ${value.name}`, current: value.value === option.currentValue,
      write: { kind: 'config', id: option.id, value: value.value } as AcpAgentSessionOptionWrite,
    }))
  }
  return (snapshot.modes ?? []).map(mode => ({ id: mode.id, name: mode.name, label: mode.name, current: mode.id === snapshot.currentModeId,
    write: { kind: 'mode', id: mode.id } as AcpAgentSessionOptionWrite }))
}

