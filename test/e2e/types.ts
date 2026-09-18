import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

export type ObservedEvent = SessionEvent & { sessionId: SessionId }
