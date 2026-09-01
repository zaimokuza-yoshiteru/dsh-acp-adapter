/** Additive browser contribution for the ACP activity journal. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { AcpActivityNode, acpPromptAnchorDefinition, createAcpActivityDefinition } from './ui/AcpActivityNode.ts'
import { AcpActivityJournalHub } from './data/activity-journal.ts'
import { CrossBackendCoordinator } from './coordinator/cross-backend-coordinator.ts'
import { CrossBackendModal } from './ui/CrossBackendModal.ts'
import { AcpRecoveryDock } from './ui/AcpRecoveryDock.ts'
import { AcpAgentControl } from './ui/AcpAgentControl.ts'
import { resolveCrossBackendLocation } from './data/cross-backend-controller.ts'
import { AcpPanelController } from './data/controller.ts'
import { ManagedAcpRouteCatalog } from './data/managed-routes.ts'
import { ProjectedSubagentCatalog } from './data/projected-subagents.ts'
import { createAcpPanelStore } from './data/stores/panel-store.ts'
import type { AcpPanelStoreActions } from './data/stores/panel-store.ts'
import { AcpSection } from './ui/AcpSection.ts'
import type { AcpSectionWire, AcpTranslate } from './ui/AcpSection.ts'
import { ACP_SETTINGS_NS, decodeAcpSettings } from './data/logic.ts'
import type { AcpSettings } from './data/logic.ts'
import { AcpAuditVisibilityGate, createAcpAuditView } from './ui/AcpAuditHeaderAction.ts'
import { en, zh } from './ui/locales.ts'
import type { AcpRemoteLike } from './data/acp-remote.ts'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import contribution from '../../lib/typert.remote-client.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    acpActivity: import('./ui/locales.ts').AcpLocaleKey
    'settings.acp': import('./ui/locales.ts').AcpLocaleKey
  }
}

export const inject = [
  'uiConversation', 'slots', 'locale', 'remote',
  'sessions', 'workspaces', 'settingsScope', 'remote.settings', 'remote.session',
] as const

/** Register only a Conversation Definition and one keyed Chat renderer. */
async function registerUi(ctx: ClientContext): Promise<void> {
  const acpRemote: AcpRemoteLike = ctx.remote.dshAcp
  const journalHub = new AcpActivityJournalHub(acpRemote, ctx.remote)
  const sessions = ctx.get('sessions') as unknown as ISessions
  const workspaces = ctx.get('workspaces') as unknown as IWorkspaces
  const settingsScope = ctx.settingsScope.bind<AcpSettings>({
    namespace: ACP_SETTINGS_NS,
    decode: decodeAcpSettings,
  })
  const ownedRoutes = await acpRemote.ownedProviderRoutes().catch(() => undefined)
  const projectedIds = await acpRemote.projectedSubagentIds().catch(() => undefined)
  const projectedSubagents = new ProjectedSubagentCatalog(
    acpRemote,
    projectedIds?.ok === true ? projectedIds.value.sessionIds : [],
  )
  const managedRoutes = new ManagedAcpRouteCatalog(
    settingsScope,
    ownedRoutes?.ok === true ? ownedRoutes.value.providers : [],
  )
  const panelController = new AcpPanelController({
    scope: settingsScope,
    settings: {
      mutate: async (request) => ({
        result: await ctx.remote.settings.mutate(
          request.ns,
          request.ops as never,
          request.expectedRevision,
        ),
      }),
    },
    remote: acpRemote,
  })
  const panelWire: AcpSectionWire = {
    refreshHealth: (recheck) => { void panelController.refreshHealth(recheck) },
    refreshAgentHealth: (agentId) => { void panelController.refreshAgentHealth(agentId) },
    saveAgent: (editingId, draft) => panelController.saveAgent(editingId, draft),
    deleteAgent: (id) => panelController.deleteAgent(id),
    countBoundSessions: (id) => panelController.countBoundSessions(id),
  }
  const settingsT = ctx.locale.bind('settings.acp') as AcpTranslate
  ctx.uiConversation.events.register(acpPromptAnchorDefinition)
  ctx.uiConversation.events.register(createAcpActivityDefinition(managedRoutes.owns))
  ctx.effect(() => ctx.locale.register('acpActivity', { zh, en }), 'dsh-acp: activity dictionaries')
  ctx.effect(() => ctx.locale.register('settings.acp', { zh, en }), 'dsh-acp: settings dictionaries')
  ctx.effect(() => () => { panelController.dispose() }, 'dsh-acp: settings controller')
  ctx.effect(() => () => { managedRoutes.dispose() }, 'dsh-acp: managed route catalogue')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'acp',
    order: 900,
    label: () => settingsT('title'),
    locale: 'settings.acp',
    store: createAcpPanelStore,
    inject: (actions: AcpPanelStoreActions) => {
      panelController.attach(actions)
      return { panel: panelWire }
    },
  }, AcpSection))
  let setAuditViewVisible: (sessionId: string, visible: boolean) => void = () => undefined
  ctx.slots.inject('conversation.view', () => {
    let disposeView: (() => void) | undefined
    let ownerSessionId: string | undefined
    setAuditViewVisible = (sessionId, visible) => {
      if (!visible) {
        if (ownerSessionId !== sessionId) return
        disposeView?.()
        disposeView = undefined
        ownerSessionId = undefined
        return
      }
      if (ownerSessionId === sessionId && disposeView !== undefined) return
      disposeView?.()
      ownerSessionId = sessionId
      disposeView = ctx.slots.register({
        name: 'conversation.view',
        id: 'dsh-acp-audit',
        order: 20,
        label: () => settingsT('auditOpen'),
        locale: 'acpActivity',
        inject: (): { readonly remote: AcpRemoteLike } => ({ remote: acpRemote }),
      }, createAcpAuditView(acpRemote))
    }
    return () => {
      setAuditViewVisible = () => undefined
      disposeView?.()
    }
  })
  // Alpha 的 view roster 暂无 per-session selector。保留一个不渲染 UI
  // 的会话门，只在当前会话已经建立 ACP binding 时贡献 Agent 审计 Tab；
  // 原生模型会话因此保持 DSH 自带的 Tab 集合。
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'dsh-acp-audit-visibility',
    order: 100,
        inject: (): { readonly remote: AcpRemoteLike; readonly onVisibilityChange: typeof setAuditViewVisible; readonly ownsRoute: typeof managedRoutes.owns } => ({
          remote: acpRemote,
          ownsRoute: managedRoutes.owns,
          onVisibilityChange: (sessionId, visible) => { setAuditViewVisible(sessionId, visible) },
    }),
  }, AcpAuditVisibilityGate))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'acp-activity',
    locale: 'acpActivity',
    inject: (): {
      readonly journalHub: AcpActivityJournalHub
      readonly onProjectedChild: (parentSessionId: string, childSessionId: string) => void
      readonly onOpenProjectedChild: (childSessionId: string) => void
    } => ({
      journalHub,
      onProjectedChild: (parentSessionId, childSessionId) => {
        if (projectedSubagents.add(childSessionId)) void sessions.refreshSubagents(parentSessionId as never)
      },
      onOpenProjectedChild: (childSessionId) => { sessions.open(childSessionId as never) },
    }),
  }, AcpActivityNode))
  const coordinator = new CrossBackendCoordinator(ctx, managedRoutes.owns)
  ctx.effect(() => coordinator.start(), 'dsh-acp: model transition coordinator')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-acp-cross-backend-confirmation',
    locale: 'acpActivity',
    inject: (): { readonly coordinator: CrossBackendCoordinator } => ({ coordinator }),
  }, CrossBackendModal))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'dsh-acp-recovery',
    order: 90,
    locale: 'acpActivity',
    inject: (): { readonly remote: AcpRemoteLike; readonly createNewSession: (sourceSessionId: string) => Promise<void>; readonly ownsRoute: typeof managedRoutes.owns } => ({
      remote: acpRemote,
      ownsRoute: managedRoutes.owns,
      createNewSession: async (sourceSessionId) => {
        const row = sessions.list.getSnapshot().byId[sourceSessionId as never]
        const location = resolveCrossBackendLocation(sourceSessionId, workspaces.list.getSnapshot().items, row?.cwd)
        if (location === undefined) throw new Error('The original session workspace is unavailable')
        const child = await sessions.create({
          ...(location.cwd === undefined ? {} : { cwd: location.cwd }),
          ...(location.workspaceId === undefined ? {} : { workspaceId: location.workspaceId as never }),
        })
        sessions.open(child)
      },
    }),
  }, AcpRecoveryDock))
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'dsh-acp-agent-control',
    order: 80,
    locale: 'acpActivity',
    inject: (): { readonly remote: AcpRemoteLike; readonly ownsRoute: typeof managedRoutes.owns } => ({
      remote: acpRemote,
      ownsRoute: managedRoutes.owns,
    }),
  }, AcpAgentControl))
}

/** Mount the generated namespace before starting the fiber that consumes it. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject([...inject, 'remote.dshAcp'], registerUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await disposeRemote()
    throw error
  }
  return async () => {
    await ui.dispose()
    await disposeRemote()
  }
}
