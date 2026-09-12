import { RemoteSnapshotStream, type RemoteStreamFactory } from '@deepseek-ai/dsh-api-gateway/client'
import type { AcpAgentSessionFrame, AcpAgentSessionSnapshotView } from '../../contract/remote.ts'
import type { AcpRemoteLike } from './acp-remote.ts'

/** A current-state subscription; reconnection replaces the baseline rather than replaying history. */
export function agentSessionStream(
  remote: AcpRemoteLike,
  factory: RemoteStreamFactory,
  sessionId: string,
  changed: (snapshot: AcpAgentSessionSnapshotView | null) => void,
  unavailable: (error: unknown) => void,
): RemoteSnapshotStream<Extract<AcpAgentSessionFrame, { type: 'opened' }>, Extract<AcpAgentSessionFrame, { type: 'changed' }>> {
  return new RemoteSnapshotStream(factory.$stream<AcpAgentSessionFrame>({
    name: 'ACP Agent controls',
    open: signal => remote.agentSessionFollow(sessionId, signal),
    ended: () => new Error('ACP Agent controls stream ended'),
    carrierFailed: unavailable,
  }), {
    name: 'ACP Agent controls',
    isSnapshot: (frame): frame is Extract<AcpAgentSessionFrame, { type: 'opened' }> => frame.type === 'opened',
    replace: frame => changed(frame.snapshot),
    update: frame => changed(frame.snapshot),
    failed: unavailable,
  })
}
