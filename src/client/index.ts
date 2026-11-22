/** Native browser integration for ACP sessions and activity. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { ClientRemoteAccess } from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import {
  independentSessionNavigation,
  reconcileIndependentChild,
  openIndependentChild,
  sourcePresetUnavailable,
  type IndependentSessionAction,
  isMainSession,
  openSubagentAside,
} from './coordinator/native-session-navigation.ts'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { AcpActivityNode } from './ui/AcpActivityNode.ts'
import {
  acpPromptAnchorDefinition,
  createAcpEffectiveRouteDefinition,
  followAcpActivityDefinitions,
} from './ui/activity-definitions.ts'
import { installNativeToolRenderer } from './ui/native-tool-renderer.ts'
import { installAcpAssistantStream } from './ui/AcpAssistantStream.ts'
import { AcpActivityJournalHub } from './data/activity-journal.ts'
import { AcpUiFeedback, followAcpQuestionLimitations, type AcpUiOutcome } from './data/feedback.ts'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { UnroutedHistoryDock } from './ui/UnroutedHistoryDock.ts'
import { UnsentModelSwitchInput } from './ui/UnsentModelSwitchInput.ts'
import { SessionHandoffClient } from './coordinator/session-handoff.ts'
import { HandoffComposer, HandoffDock } from './ui/SessionHandoff.ts'
import { CrossBackendCoordinator } from './coordinator/cross-backend-coordinator.ts'
import { AcpNativeForkCoordinator, type NativeForkFailure } from './coordinator/native-fork.ts'
import { createNativeForkJournal } from './coordinator/native-fork-journal.ts'
import { CreatedSessionDock } from './ui/CreatedSessionDock.ts'
import { CrossBackendModal } from './ui/CrossBackendModal.ts'
import { AcpOutcomeToast } from './ui/AcpOutcomeToast.ts'
import { AcpRecoveryDock } from './ui/AcpRecoveryDock.ts'
import { AcpNativeForkRecovery } from './ui/AcpNativeForkRecovery.ts'
import { AccountPlanControl } from './ui/AccountPlanControl.ts'
import { AcpAgentControl, isNativePermissionSeat } from './ui/AcpAgentControl.ts'
import {
  AcpExternalSubagentComposer,
  followExternalSubagentRecords,
  selectExternalSubagentRecord,
} from './ui/AcpExternalSubagentComposer.ts'
import type { SessionAccessSource } from './ui/session-action-access.ts'
import {
  AcpTeamManagementAction,
  AcpTeamManagementOverlay,
  type AcpTeamManagementInjected,
} from './ui/AcpTeamManagement.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-ui-subagent/client'
import { CreatedAgentSessions } from './ui/CreatedAgentSessions.ts'
import { AcpTeamApprovals } from './ui/AcpTeamApprovals.ts'
import type { AcpTeamApprovalActions } from './ui/AcpTeamApprovals.ts'
import { followNativeSubagentUi } from './ui/native-team-ui-lifecycle.ts'
import { resolveCrossBackendLocation } from './data/cross-backend-controller.ts'
import { AcpPanelController } from './data/controller.ts'
import { ManagedAcpRouteCatalog } from './data/managed-routes.ts'
import { createAcpPanelStore } from './data/stores/panel-store.ts'
import type { AcpPanelStoreActions } from './data/stores/panel-store.ts'
import { AcpSection } from './ui/AcpSection.ts'
import {
  AcpPermissionQuestion,
  createAcpPermissionQuestionStore,
  isAcpPermissionQuestion,
} from './ui/acp-permission-question.ts'
import type { AcpSectionWire, AcpTranslate } from './ui/AcpSection.ts'
import { ACP_SETTINGS_NS } from './data/logic.ts'
import type { AcpSettings } from './data/logic.ts'
import { AcpAuditVisibilityGate, createAcpAuditView } from './ui/AcpAuditHeaderAction.ts'
import { AcpAuditViewVisibility } from './ui/audit-view-visibility.ts'
import { createAcpJsonStringWrapping, type AcpJsonStringWrapping } from './ui/json-tree.ts'
import { en, zh } from './ui/locales.ts'
import type { AcpRemoteLike } from './data/acp-remote.ts'
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
  'uiConversation',
  'slots',
  'locale',
  'remote',
  'remoteAccess',
  'sessions',
  'workspaces',
  'uiWorkspace',
  'layout',
  'sidebarRight',
  'configForms',
  'remote.settings',
  'remote.session',
  'remote.workspace',
] as const

const forkOutcomes: Readonly<Record<NativeForkFailure, AcpUiOutcome>> = {
  'workspace-attach': 'fork-workspace-attach-failed',
  storage: 'fork-storage-failed',
  'access-denied': 'fork-access-denied',
  unavailable: 'fork-unavailable',
  'invalid-seed': 'fork-invalid-seed',
  'source-conflict': 'fork-source-conflict',
  'child-bound': 'fork-child-bound',
  'source-unavailable': 'fork-source-unavailable',
  'child-changed': 'fork-child-changed',
}

/** Normalize ACP presentation facts and compose the registered native UI. */
async function registerUi(ctx: ClientContext): Promise<void> {
  const acpRemote: AcpRemoteLike = ctx.remote.dshAcp
  const sessionAccessSource: SessionAccessSource = (sessionId, action) => {
    // Host and Client merge different RemoteAccess faces into Cordis Context.
    // This UI reads only the published Client source, and never grants on absence.
    const access = ctx.get('remoteAccess') as unknown as ClientRemoteAccess | undefined
    return typeof access?.source === 'function' ? access.source('session', sessionId, action) : undefined
  }
  ctx.slots.inject('conversation.session.header.utilities', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.utilities',
        id: 'dsh-acp-created-sessions',
        order: 50,
        locale: 'acpActivity',
        inject: () => ({
          access: sessionAccessSource,
          navigate: (id: SessionId) => openIndependentChild(ctx, id),
          load: async (source: string) => {
            const result = await acpRemote.createdAgentSessions(source)
            if (!result.ok) throw result.error
            return result.value
          },
        }),
      },
      CreatedAgentSessions,
    ),
  )
  const journalHub = new AcpActivityJournalHub(acpRemote, ctx.remote)
  const sessions = ctx.get('sessions') as unknown as ISessions
  const workspaces = ctx.get('workspaces') as unknown as IWorkspaces
  const openProjectedChild = (parentSessionId: string, childSessionId: string): void => {
    openSubagentAside(ctx.sidebarRight, {
      parentSessionId: parentSessionId as SessionId,
      childSessionId: childSessionId as SessionId,
      mode: 'one-shot',
    })
  }
  const settingsScope = ctx.configForms.get<AcpSettings>(ACP_SETTINGS_NS)
  const managedRoutes = new ManagedAcpRouteCatalog(async () => {
    const result = await acpRemote.ownedProviderRoutes()
    return result.ok ? result.value : undefined
  })
  ctx.effect(() => {
    const updated = ctx.remote.$on('llm/adapters-updated', () => {
      void managedRoutes.refresh()
    })
    const reset = ctx.on('connection/reset', () => managedRoutes.reset())
    return () => {
      updated()
      reset()
      managedRoutes.dispose()
    }
  }, 'dsh-acp: managed route catalogue')
  await managedRoutes.refresh()
  const panelController = new AcpPanelController({
    scope: settingsScope,
    mutate: (ops, revision) => settingsScope.mutate(ops, revision),
    refusedMessage: () => ctx.locale.bind('settings.acp')('settingsWriteRefused'),
    remote: acpRemote,
  })
  const feedback = new AcpUiFeedback()
  const nativeFork = new AcpNativeForkCoordinator({
    sessions,
    scope: (source) => acpRemote.nativeForkScope(source),
    journal: (scope, source, atSeq) => createNativeForkJournal(() => sessionStorage, scope, source, atSeq),
    register: (child, source, atSeq) => acpRemote.registerNativeFork(child, source, atSeq),
    open: (child) => ctx.uiWorkspace.openSession(child),
    failed: (source, child, reason) =>
      feedback.report(reason === undefined ? 'fork-failed' : forkOutcomes[reason], {
        id: child ?? source,
        title: null,
      }),
  })
  ctx.effect(() => nativeFork.dispose, 'dsh-acp: native fork coordinator')
  ctx.effect(
    () =>
      followAcpQuestionLimitations(
        (listener) => ctx.remote.$on('api-session/error', listener),
        feedback,
        (id) => {
          const summary = sessions.list.getSnapshot().byId[id as SessionId]
          return summary?.title ?? summary?.displayTitle ?? null
        },
      ),
    'dsh-acp: child question limitation feedback',
  )
  const jsonStringWrapping = createAcpJsonStringWrapping()
  const panelWire: AcpSectionWire = {
    accountUsage: async (id, refresh) => {
      const result = await acpRemote.accountUsage(id, refresh)
      if (!result.ok) throw new Error('Account information unavailable')
      return result.value
    },
    refreshHealth: (recheck) => {
      void panelController.refreshHealth(recheck)
    },
    refreshAgentHealth: (agentId) => {
      void panelController.refreshAgentHealth(agentId)
    },
    saveAgent: (editingId, draft) => panelController.saveAgent(editingId, draft),
    deleteAgent: (id) => panelController.deleteAgent(id),
    notifyOutcome: feedback.report,
    setAiApproval: (enabled) => panelController.setAiApproval(enabled),
    setOpenCodeReviewModel: (id, value) => panelController.setOpenCodeReviewModel(id, value),
    setDevinReviewModel: (value) => panelController.setDevinReviewModel(value),
    countBoundSessions: (id) => panelController.countBoundSessions(id),
  }
  const settingsT = ctx.locale.bind('settings.acp') as AcpTranslate
  ctx.uiConversation.events.register(createAcpEffectiveRouteDefinition())
  ctx.uiConversation.events.register(acpPromptAnchorDefinition)
  ctx.effect(
    () => followAcpActivityDefinitions(managedRoutes, (definition) => ctx.uiConversation.events.register(definition)),
    'dsh-acp: route-owned activity history',
  )
  ctx.effect(() => ctx.locale.register('acpActivity', { zh, en }), 'dsh-acp: activity dictionaries')
  ctx.effect(() => ctx.locale.register('settings.acp', { zh, en }), 'dsh-acp: settings dictionaries')
  ctx.slots.inject('conversation.composer', () =>
    followExternalSubagentRecords(sessions.list, (records) =>
      ctx.slots.register(
        {
          name: 'conversation.composer',
          priority: -11,
          select: (owner: ComposerChainProps) => selectExternalSubagentRecord(owner, records),
          locale: 'acpActivity',
        },
        AcpExternalSubagentComposer,
      ),
    ),
  )
  ctx.slots.inject('conversation.composer', () =>
    ctx.slots.register(
      {
        name: 'conversation.composer',
        priority: -1,
        select: ({ pendingInteraction }: ComposerChainProps) =>
          isAcpPermissionQuestion(pendingInteraction) ? pendingInteraction : null,
        locale: 'acpActivity',
        store: createAcpPermissionQuestionStore,
      },
      (props) =>
        AcpPermissionQuestion({
          ...props,
          language: ctx.locale.resolveText({ en: 'en', zh: 'zh' }) === 'zh' ? 'zh' : 'en',
        }),
    ),
  )
  ctx.effect(
    () => () => {
      panelController.dispose()
    },
    'dsh-acp: settings controller',
  )
  ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register(
      {
        name: 'plugins.bundle.config',
        key: '@zaimokuza/dsh-acp-adapter',
        locale: 'settings.acp',
        store: createAcpPanelStore,
        inject: (actions: AcpPanelStoreActions) => {
          panelController.attach(actions)
          return { panel: panelWire }
        },
      },
      AcpSection,
    ),
  )
  const auditVisibility = new AcpAuditViewVisibility()
  // The view registration follows the plugin, not a React session gate. A gate
  // can unmount after Native has withdrawn its Session binding but before scope
  // cleanup; changing the global view roster there re-enters all old bindings.
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: 'dsh-acp-audit',
        order: 20,
        label: () => settingsT('auditOpen'),
        locale: 'acpActivity',
        inject: () => ({ remote: acpRemote }),
      },
      createAcpAuditView(acpRemote, jsonStringWrapping),
    ),
  )
  // The same per-session source filters both native header navigation and body
  // selection; ordinary model sessions retain the native view set and fallback.
  ctx.slots.inject('conversation.session.header.utilities', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.utilities',
        id: 'dsh-acp-audit-visibility',
        order: 100,
        inject: (): {
          readonly remote: AcpRemoteLike
          readonly onVisibilityChange: typeof auditVisibility.setVisible
          readonly hooks: { routeOwnership: typeof managedRoutes.store }
        } => ({
          remote: acpRemote,
          hooks: { routeOwnership: managedRoutes.store },
          onVisibilityChange: auditVisibility.setVisible,
        }),
      },
      AcpAuditVisibilityGate,
    ),
  )
  installNativeToolRenderer(ctx)
  installAcpAssistantStream(ctx, {
    journalHub,
    t: ctx.locale.bind('acpActivity'),
    jsonStringWrapping,
    auditVisibility,
    onOpenProjectedChild: openProjectedChild,
    forkAt: (sessionId, seq) => {
      void nativeFork.fork(sessionId as SessionId, seq)
    },
  })
  ctx.slots.inject('conversation.chat.node', () =>
    ctx.slots.register(
      {
        name: 'conversation.chat.node',
        key: 'acp-activity',
        locale: 'acpActivity',
        inject: (): {
          readonly journalHub: AcpActivityJournalHub
          readonly onOpenProjectedChild: (parentSessionId: string, childSessionId: string) => void
          readonly jsonStringWrapping: AcpJsonStringWrapping
        } => ({
          journalHub,
          onOpenProjectedChild: openProjectedChild,
          jsonStringWrapping,
        }),
      },
      AcpActivityNode,
    ),
  )
  const transitionModelLabels = {
    loadModelCatalog: async () => {
      const result = await ctx.remote.session.modelCatalog()
      return result.ok ? result.value : null
    },
    profileName: (provider: string) => {
      const profiles = settingsScope.getSnapshot().value?.agents
      const id = Object.keys(profiles ?? {}).find((candidate) => `acp-${candidate}` === provider)
      return id === undefined ? undefined : profiles?.[id]?.name
    },
  }

  const openHandoffSession = (id: string) => openIndependentChild(ctx, id as SessionId)
  const handoffs = new SessionHandoffClient(
    (session, command) => acpRemote.handoff(session, command),
    (source, destination) => {
      if (
        ctx.sidebarRight.mounted.getSnapshot() === source &&
        document.visibilityState !== 'hidden' &&
        !document.activeElement?.closest('[data-sidebar-right-session]') &&
        sessionAccessSource(destination, 'session/follow')?.getSnapshot()
      )
        openHandoffSession(destination)
    },
    () => ctx.layout.beginNavigation(),
  )
  ctx.on('connection/reset', () => handoffs.reconnect())
  ctx.effect(() => () => handoffs.dispose(), 'dsh-acp: session handoffs')
  const coordinator = new CrossBackendCoordinator(ctx, managedRoutes.store, handoffs)
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'dsh-acp-session-handoff',
        order: 88,
        locale: 'acpActivity',
        inject: () => ({ client: handoffs, openSession: openHandoffSession, access: sessionAccessSource }),
      },
      HandoffDock,
    ),
  )
  ctx.slots.inject('conversation.composer', () => {
    const mounted = new Map<string, () => void>()
    const sync = () => {
      const drafts = new Set(handoffs.draftDestinations())
      for (const [id, dispose] of mounted) {
        if (!drafts.has(id)) {
          dispose()
          mounted.delete(id)
        }
      }
      for (const id of drafts) {
        if (mounted.has(id)) continue
        const access = ctx.get('remoteAccess') as unknown as ClientRemoteAccess | undefined
        const source = handoffs.get(id)?.sourceSessionId
        if (!access || !source) continue
        const unmount = access.whenResourceAccess('session', id, 'dshAcp/handoff', () =>
          access.whenResourceAccess('session', source, 'session/events', () =>
            access.whenResourceAccess('session', id, 'session/events', () =>
              ctx.slots.register(
                {
                  name: 'conversation.composer',
                  priority: -2,
                  locale: 'acpActivity',
                  select: (owner: ComposerChainProps) =>
                    owner.sessionId === id && !owner.pendingInteraction ? true : null,
                  inject: () => ({ client: handoffs, openSession: openHandoffSession, ...transitionModelLabels }),
                },
                HandoffComposer,
              ),
            ),
          ),
        )
        mounted.set(id, unmount)
      }
    }
    const unsubscribe = handoffs.subscribe(sync)
    sync()
    return () => {
      unsubscribe()
      for (const dispose of mounted.values()) dispose()
    }
  })
  // The native catalog owns discovery/navigation; ACP contributes only its settings action.
  ctx.inject(['remote.subagents', 'uiSession'], (teamCtx) => {
    const loadMembers = async (sessionId: SessionId) => {
      const result = await acpRemote.teamMembers(sessionId)
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
      return result.value
    }
    teamCtx.effect(
      () =>
        followNativeSubagentUi(teamCtx.slots, () => {
          const unmount = teamCtx.effect(function* () {
            const request = createSnapshotStore<SessionId | null>(null)
            yield () => {
              request.set(null)
            }
            yield teamCtx.slots.inject('shell.overlay', () =>
              teamCtx.slots.register(
                {
                  name: 'shell.overlay',
                  id: 'acp-team-settings',
                  locale: 'acpActivity',
                  inject: (): AcpTeamManagementInjected => ({
                    hooks: { managementRequest: request },
                    closeManagement: () => request.set(null),
                    remote: acpRemote,
                    streamFactory: ctx.remote,
                    loadMembers,
                    isCurrent: (sessionId) => isMainSession(sessions, sessionId),
                    status: teamCtx.uiSession.sessionStatus,
                    sessionAccessSource,
                    async interruptMember(member) {
                      const result = await teamCtx.remote.subagents.interruptByUser(member)
                      if (!result.ok) throw new Error(result.error.message)
                    },
                  }),
                },
                AcpTeamManagementOverlay,
              ),
            )
            yield teamCtx.slots.inject('conversation.session.header.actions.subagent.footer', () =>
              teamCtx.slots.register(
                {
                  name: 'conversation.session.header.actions.subagent.footer',
                  id: 'acp-settings',
                  order: 95,
                  locale: 'acpActivity',
                  inject: () => ({
                    loadMembers,
                    status: teamCtx.uiSession.sessionStatus,
                    openManagement: (sessionId: SessionId) => request.set(sessionId),
                  }),
                },
                AcpTeamManagementAction,
              ),
            )
          }, 'dsh-acp: native subagent settings')
          return () => {
            void unmount()
          }
        }),
      'dsh-acp: native subagent UI lifecycle',
    )
  })
  ctx.inject(['uiSession'], (approvalCtx) => {
    const actions: AcpTeamApprovalActions = {
      status: approvalCtx.uiSession.sessionStatus,
      isCurrent: (sessionId) => isMainSession(sessions, sessionId),
      async loadChildren(parent) {
        const result = await acpRemote.approvalChildren(parent)
        if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
        return result.value
      },
      async openMember(parent, child) {
        if (!isMainSession(sessions, parent)) return
        const children = await actions.loadChildren(parent)
        const current = children.find(
          (entry) =>
            entry.sessionId === child.sessionId &&
            entry.parentSessionId === child.parentSessionId &&
            entry.mode === child.mode,
        )
        if (!isMainSession(sessions, parent) || current === undefined) return
        openSubagentAside(ctx.sidebarRight, {
          parentSessionId: current.parentSessionId as SessionId,
          childSessionId: current.sessionId as SessionId,
          mode: current.mode,
        })
      },
      resolveReason: (reason) => (reason === undefined ? undefined : ctx.locale.resolveText(reason)),
    }
    approvalCtx.slots.inject('conversation.input.dock', () =>
      approvalCtx.slots.register(
        {
          name: 'conversation.input.dock',
          id: 'acp-team-approvals',
          order: 95,
          locale: 'acpActivity',
          inject: () => actions,
        },
        AcpTeamApprovals,
      ),
    )
  })
  const openIndependentSession = independentSessionNavigation(
    sessions,
    (source) => {
      const row = sessions.list.getSnapshot().byId[source]
      return resolveCrossBackendLocation(
        source,
        workspaces.list.getSnapshot().items,
        row?.cwd,
        row?.projectionValues?.agentPreset,
      )
    },
    (child) => openIndependentChild(ctx, child),
    (child, location) => reconcileIndependentChild(ctx, child, location),
    (preset) => sourcePresetUnavailable(ctx, preset),
    (repair, child, current) => repair.run(ctx, child, current),
  )
  ctx.inject(['modelDirectories'], (scope) =>
    scope.slots.inject('conversation.input.dock', () =>
      scope.slots.register(
        {
          name: 'conversation.input.dock',
          id: 'dsh-acp-unrouted-history',
          order: 85,
          locale: 'acpActivity',
          inject: (sessionId) => ({
            directory: scope.modelDirectories.directoryFor(sessionId).store,
            hooks: { routeOwnership: managedRoutes.store },
            openIndependent: (current: () => boolean, action: IndependentSessionAction) =>
              openIndependentSession(sessionId, () => current() && isMainSession(sessions, sessionId), action),
          }),
        },
        UnroutedHistoryDock,
      ),
    ),
  )
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'dsh-acp-unsent-model-switch',
        order: 87,
        locale: 'acpActivity',
        inject: () => ({ remote: acpRemote }),
      },
      UnsentModelSwitchInput,
    ),
  )
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'dsh-acp-created-session',
        order: 86,
        locale: 'acpActivity',
        inject: () => ({ coordinator, sessionAccessSource }),
      },
      CreatedSessionDock,
    ),
  )
  ctx.effect(() => coordinator.start(), 'dsh-acp: model transition coordinator')
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'dsh-acp-native-fork-recovery',
        locale: 'acpActivity',
        inject: () => ({ coordinator: nativeFork }),
      },
      AcpNativeForkRecovery,
    ),
  )
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'dsh-acp-cross-backend-confirmation',
        locale: 'acpActivity',
        inject: () => ({
          coordinator,
          ...transitionModelLabels,
          sessionAccessSource,
          language: (): 'zh' | 'en' => (ctx.locale.resolveText({ en: 'en', zh: 'zh' }) === 'zh' ? 'zh' : 'en'),
        }),
      },
      CrossBackendModal,
    ),
  )
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'dsh-acp-operation-outcomes',
        locale: 'acpActivity',
        inject: (): { readonly feedback: AcpUiFeedback } => ({ feedback }),
      },
      AcpOutcomeToast,
    ),
  )
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'dsh-acp-recovery',
        order: 90,
        locale: 'acpActivity',
        inject: () => ({
          remote: acpRemote,
          sessionAccessSource,
          streamFactory: ctx.remote,
          hooks: { routeOwnership: managedRoutes.store },
          createNewSession: openIndependentSession,
        }),
      },
      AcpRecoveryDock,
    ),
  )
  // One default-model lookup per catalog generation, shared by all mounted composers.
  type Selection = { provider: string; model: string }
  let defaultRead: Promise<Selection | undefined> | undefined
  const defaultListeners = new Set<() => void>()
  const getDefaultSelection = (): Promise<Selection | undefined> => {
    if (defaultRead) return defaultRead
    const current: Promise<Selection | undefined> = ctx.remote.session.modelCatalog().then(
      (result) => {
        if (defaultRead !== current) return undefined
        if (result.ok) return result.value.default
        defaultRead = undefined
      },
      () => {
        if (defaultRead === current) defaultRead = undefined
        return undefined
      },
    )
    defaultRead = current
    return current
  }
  const composerDefault = {
    getDefaultProvider: async () => (await getDefaultSelection())?.provider,
    watchDefaultProvider: (changed: () => void) => {
      defaultListeners.add(changed)
      return () => {
        defaultListeners.delete(changed)
      }
    },
  }
  const invalidateDefault = () => {
    defaultRead = undefined
    for (const changed of defaultListeners) changed()
  }
  ctx.effect(() => {
    const stop = [
      ctx.remote.$on('settings/document-updated', invalidateDefault),
      ctx.remote.$on('llm/adapters-updated', invalidateDefault),
      ctx.remote.$on('llm/models-updated', invalidateDefault),
      ctx.remote.$on('credentials/record-updated', invalidateDefault),
      ctx.remote.$on('credentials/reference-updated', invalidateDefault),
      ctx.on('connection/reset', invalidateDefault),
    ]
    return () => {
      for (const dispose of stop) dispose()
    }
  }, 'dsh-acp: composer default model')
  const openPlans = new WeakMap<object, ReturnType<typeof createSnapshotStore<boolean>>>()
  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.right',
        id: 'dsh-acp-account-plan',
        order: 90,
        locale: 'acpActivity',
        inject: (sessionId) => {
          const binding = sessions.binding(sessionId)
          const visibility = (binding && openPlans.get(binding)) ?? createSnapshotStore(false)
          if (binding) openPlans.set(binding, visibility)
          return {
            getDefaultSelection,
            watchDefaultProvider: composerDefault.watchDefaultProvider,
            hooks: { routeOwnership: managedRoutes.store, accountSettings: settingsScope, planOpen: visibility },
            setOpen: visibility.set,
            read: panelWire.accountUsage,
          }
        },
      },
      AccountPlanControl,
    ),
  )
  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: 'dsh-acp-agent-control',
        order: 80,
        locale: 'acpActivity',
        inject: () => ({
          remote: acpRemote,
          sessionAccessSource,
          streamFactory: ctx.remote,
          hooks: {
            routeOwnership: managedRoutes.store,
            nativePermissionSeat: {
              getSnapshot: () => {
                const slot = 'conversation.input.permission'
                if (!ctx.get('inputTriggers')) return false
                const official = Array.from(ctx.get('loader')?.entries() ?? []).find(
                  (entry) => entry.options.name === '@deepseek-ai/dsh-client-ui-permission-presets',
                )
                return isNativePermissionSeat(
                  ctx.slots.entriesOfSlot(slot)[0],
                  ctx.slots.entries(slot),
                  official?.fiber?.name,
                )
              },
              subscribe: (changed: () => void) => ctx.slots.subscribe('conversation.input.permission', changed),
            },
          },
          nativeStopLabel: () => ctx.locale.bind('conversation')('input.stop'),
          openToolPermissions: async (sessionId: string, signal: AbortSignal) => {
            const scope = sessions.scope(sessionId as SessionId)
            const triggers = scope && ctx.get('inputTriggers')?.sessionOf(scope)
            // Use the native decorated command with its own confirmation and Session binding.
            return (await triggers?.adjudicate('/permission', signal, { attachments: 0 })) === 'handled'
          },
          feedback,
          ...composerDefault,
        }),
      },
      AcpAgentControl,
    ),
  )
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
