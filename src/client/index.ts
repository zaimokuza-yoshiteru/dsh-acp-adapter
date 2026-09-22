/** Native browser integration for ACP sessions and activity. */
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
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { isMainSession, openSubagentAside } from './coordinator/native-session-navigation.ts'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { AcpActivityNode, acpPromptAnchorDefinition, createAcpActivityDefinition, createAcpLiveActivityDefinition } from './ui/AcpActivityNode.ts'
import { installNativeToolRenderer } from './ui/native-tool-renderer.ts'
import { installAcpAssistantStream } from './ui/AcpAssistantStream.ts'
import { AcpActivityJournalHub } from './data/activity-journal.ts'
import { CrossBackendCoordinator } from './coordinator/cross-backend-coordinator.ts'
import { CrossBackendModal } from './ui/CrossBackendModal.ts'
import { AcpRecoveryDock } from './ui/AcpRecoveryDock.ts'
import { AcpAgentControl } from './ui/AcpAgentControl.ts'
import { AcpTeamManagement } from './ui/AcpTeamManagement.ts'
import { AcpTeamApprovals } from './ui/AcpTeamApprovals.ts'
import type { AcpTeamApprovalActions } from './ui/AcpTeamApprovals.ts'
import type {} from '@deepseek-ai/dsh-experimental-agent-team/remote'
import { resolveCrossBackendLocation } from './data/cross-backend-controller.ts'
import { AcpPanelController } from './data/controller.ts'
import { ManagedAcpRouteCatalog } from './data/managed-routes.ts'
import { ProjectedSubagentCatalog } from './data/projected-subagents.ts'
import { createAcpPanelStore } from './data/stores/panel-store.ts'
import type { AcpPanelStoreActions } from './data/stores/panel-store.ts'
import { AcpSection } from './ui/AcpSection.ts'
import type { AcpSectionWire, AcpTranslate } from './ui/AcpSection.ts'
import { ACP_SETTINGS_NS } from './data/logic.ts'
import type { AcpSettings } from './data/logic.ts'
import { AcpAuditVisibilityGate, createAcpAuditView } from './ui/AcpAuditHeaderAction.ts'
import { createAcpJsonStringWrapping, type AcpJsonStringWrapping } from './ui/json-tree.ts'
import { en, zh } from './ui/locales.ts'
import type { AcpRemoteLike } from './data/acp-remote.ts'
import type { RemoteStreamFactory } from '@deepseek-ai/dsh-api-gateway/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
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
  'sessions', 'workspaces', 'uiWorkspace', 'sidebarRight', 'configForms', 'remote.settings', 'remote.session',
] as const

/** Normalize ACP presentation facts and compose the registered native UI. */
async function registerUi(ctx: ClientContext): Promise<void> {
  const acpRemote: AcpRemoteLike = ctx.remote.dshAcp
  const journalHub = new AcpActivityJournalHub(acpRemote, ctx.remote)
  const sessions = ctx.get('sessions') as unknown as ISessions
  const workspaces = ctx.get('workspaces') as unknown as IWorkspaces
  const openProjectedChild = (parentSessionId: string, childSessionId: string): void => {
    openSubagentAside(ctx.sidebarRight, {
      parentSessionId: parentSessionId as SessionId, childSessionId: childSessionId as SessionId, mode: 'one-shot',
    })
  }
  const settingsScope = ctx.configForms.get<AcpSettings>(ACP_SETTINGS_NS)
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
    mutate: (ops, revision) => settingsScope.mutate(ops, revision),
    refusedMessage: () => ctx.locale.bind('settings.acp')('settingsWriteRefused'),
    remote: acpRemote,
  })
  const jsonStringWrapping = createAcpJsonStringWrapping()
  const panelWire: AcpSectionWire = {
    refreshHealth: (recheck) => { void panelController.refreshHealth(recheck) },
    refreshAgentHealth: (agentId) => { void panelController.refreshAgentHealth(agentId) },
    saveAgent: (editingId, draft) => panelController.saveAgent(editingId, draft),
    deleteAgent: (id) => panelController.deleteAgent(id),
    countBoundSessions: (id) => panelController.countBoundSessions(id),
  }
  const settingsT = ctx.locale.bind('settings.acp') as AcpTranslate
  ctx.uiConversation.events.register(createAcpLiveActivityDefinition(managedRoutes.owns))
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
        inject: () => ({ remote: acpRemote }),
      }, createAcpAuditView(acpRemote, jsonStringWrapping))
    }
    return () => {
      setAuditViewVisible = () => undefined
      disposeView?.()
    }
  })
  // Alpha 的 view roster 暂无 per-session selector。保留一个不渲染 UI
  // 的主区域会话门，只在 mainView 已建立 ACP binding 时贡献诊断 Tab；
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
  installNativeToolRenderer(ctx)
  installAcpAssistantStream(ctx, {
    journalHub, t: ctx.locale.bind('acpActivity'), jsonStringWrapping,
    onProjectedChild: (_parentSessionId, childSessionId) => {
      projectedSubagents.add(childSessionId)
    },
    onOpenProjectedChild: openProjectedChild,
  })
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'acp-activity',
    locale: 'acpActivity',
    inject: (): {
      readonly journalHub: AcpActivityJournalHub
      readonly onProjectedChild: (parentSessionId: string, childSessionId: string) => void
      readonly onOpenProjectedChild: (parentSessionId: string, childSessionId: string) => void
      readonly jsonStringWrapping: AcpJsonStringWrapping
    } => ({
      journalHub,
      onProjectedChild: (_parentSessionId, childSessionId) => {
        projectedSubagents.add(childSessionId)
      },
      onOpenProjectedChild: openProjectedChild,
      jsonStringWrapping,
    }),
  }, AcpActivityNode))
  const coordinator = new CrossBackendCoordinator(ctx, managedRoutes.owns)
  // Only the user's native Teams Web profile mounts this Remote namespace.
  ctx.inject(['remote.agentTeams', 'remote.subagents', 'uiSession'], (teamCtx) => {
    const actions: AcpTeamApprovalActions = {
      status: teamCtx.uiSession.sessionStatus,
      isCurrent: sessionId => isMainSession(sessions, sessionId),
      ownsRoute: managedRoutes.owns,
      async loadMembers(sessionId) {
        const result = await teamCtx.remote.agentTeams.view(sessionId)
        if (!result.ok) throw new Error(result.error.message)
        return result.value.members
      },
      async openMember(parentSessionId, childSessionId) {
        if (!isMainSession(sessions, parentSessionId)) return
        openSubagentAside(ctx.sidebarRight, { parentSessionId, childSessionId, mode: 'continuable' })
      },
    }
    teamCtx.slots.inject('conversation.session.header.utilities', () => teamCtx.slots.register({
      name: 'conversation.session.header.utilities', id: 'acp-team-management', order: 94,
      locale: 'acpActivity', inject: () => ({ remote: ctx.remote.dshAcp, streamFactory: ctx.remote, ownsRoute: managedRoutes.owns, isCurrent: actions.isCurrent,
        async interruptMember(lead: SessionId, member: SessionId) {
          const result = await teamCtx.remote.subagents.interruptByParent(member, lead, 'continuable')
          if (!result.ok) throw new Error(result.error.message)
        },
      }),
    }, AcpTeamManagement))
    teamCtx.slots.inject('conversation.input.dock', () => teamCtx.slots.register({
      name: 'conversation.input.dock', id: 'acp-team-approvals', order: 95,
      locale: 'acpActivity', inject: () => actions,
    }, AcpTeamApprovals))
  })
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
        ctx.uiWorkspace.openSession(child)
      },
    }),
  }, AcpRecoveryDock))
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'dsh-acp-agent-control',
    order: 80,
    locale: 'acpActivity',
    inject: (): { readonly remote: AcpRemoteLike; readonly streamFactory: RemoteStreamFactory; readonly ownsRoute: typeof managedRoutes.owns } => ({
      remote: acpRemote,
      streamFactory: ctx.remote,
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

// Public payload types referenced by the generated ./remote declarations.
export type * from '../contract/remote.ts'
