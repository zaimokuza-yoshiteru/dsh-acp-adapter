import { RemoteSnapshotStream, type RemoteStreamFactory } from '@deepseek-ai/dsh-api-gateway/client'
import type { AcpToolApprovalPolicyFrame, AcpToolApprovalPolicySnapshot } from '../../contract/remote.ts'
import type { AcpRemoteLike } from './acp-remote.ts'

export type { AcpToolApprovalPolicySnapshot as ToolApprovalPolicySnapshot }

/** Current policy subscription, including host-owned fresh ACP sessions. */
export function toolApprovalPolicyStream(
  remote: AcpRemoteLike,
  factory: RemoteStreamFactory,
  sessionId: string,
  changed: (snapshot: AcpToolApprovalPolicySnapshot) => void,
  unavailable: (error: unknown) => void,
): RemoteSnapshotStream<Extract<AcpToolApprovalPolicyFrame, { type: 'opened' }>, Extract<AcpToolApprovalPolicyFrame, { type: 'changed' }>> {
  return new RemoteSnapshotStream(factory.$stream<AcpToolApprovalPolicyFrame>({
    name: 'DSH tool approval policy',
    open: signal => remote.toolApprovalPolicyFollow(sessionId, signal),
    ended: () => new Error('DSH tool approval policy stream ended'),
    carrierFailed: unavailable,
  }), {
    name: 'DSH tool approval policy',
    isSnapshot: (frame): frame is Extract<AcpToolApprovalPolicyFrame, { type: 'opened' }> => frame.type === 'opened',
    replace: frame => changed(frame.snapshot),
    update: frame => changed(frame.snapshot),
    failed: unavailable,
  })
}
