/** User-owned, recoverable transfer between independent conversations. */
export interface AcpHandoffTarget {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export type AcpHandoffCommand =
  | { readonly kind: 'begin'; readonly id: string; readonly target: AcpHandoffTarget; readonly locale: 'zh' | 'en' }
  | { readonly kind: 'status'; readonly id?: string }
  | { readonly kind: 'cancel'; readonly id: string }
  | {
      readonly kind: 'save' | 'send'
      readonly id: string
      readonly revision: number
      readonly document: string
      readonly allowHistory: boolean
      readonly instruction: string
    }

export interface AcpHandoffView {
  readonly revision: number
  readonly id: string
  readonly sourceSessionId: string
  readonly target: AcpHandoffTarget
  readonly destinationSessionId: string | null
  readonly phase: 'summarizing' | 'draft' | 'queued' | 'completed' | 'cancelled' | 'interrupted'
  readonly document: string
  readonly instruction: string
  readonly allowHistory: boolean
}
