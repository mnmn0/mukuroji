import {
  WORK_ITEM_ACTION_IDS,
  type WorkItemActionContext,
  type WorkItemActionId,
} from '@mukuroji/contracts'
import { createContext, useContext } from 'react'

/** Display metadata and executor registered for one canonical Work Item action. */
export type WorkspaceCommandMenuWorkItemActionDefinition = {
  /** Canonical action identifier shared by every invocation surface. */
  id: WorkItemActionId
  /** Localized primary label shown in the command menu. */
  label: string
  /** Optional localized description shown below the label. */
  description?: string
  /** Optional platform-ready shortcut label shown at the end of the row. */
  shortcut?: string
  /** Localized reason that keeps a permission-denied or unavailable action visible but disabled. */
  disabledReason?: string
  /** Executes the canonical action with the command-menu invocation context. */
  execute: (context: WorkItemActionContext) => unknown
}

/** Action collection contributed by one currently mounted task surface. */
export type WorkspaceCommandMenuWorkItemActionRegistration = {
  /** Stable identifier used to replace and unregister this surface contribution. */
  registrationId: string
  /** Explicit precedence used when multiple surfaces contribute the same action. */
  precedence?: number
  /** Current surface, scope, and selection shared by every contributed action. */
  context: Omit<WorkItemActionContext, 'actionId' | 'keyboardShortcut' | 'trigger'>
  /** Canonical actions made visible by the contributing surface. */
  actions: readonly WorkspaceCommandMenuWorkItemActionDefinition[]
}

/** Canonical action resolved from all currently mounted command-menu registrations. */
export type ResolvedWorkspaceCommandMenuWorkItemAction = {
  /** Canonical action identifier shared by every invocation surface. */
  id: WorkItemActionId
  /** Localized primary label shown in the command menu. */
  label: string
  /** Optional localized description shown below the label. */
  description?: string
  /** Optional platform-ready shortcut label shown at the end of the row. */
  shortcut?: string
  /** Localized reason that keeps the action visible but disabled. */
  disabledReason?: string
  /** Complete canonical context with a command-menu trigger. */
  context: WorkItemActionContext
  /** Executor supplied by the winning surface registration. */
  execute: (context: WorkItemActionContext) => unknown
}

/** Observable registry owned by the authenticated command-menu layout. */
export type WorkspaceCommandMenuWorkItemActionRegistry = {
  /** Returns the stable resolved snapshot used by React external-store subscriptions. */
  getSnapshot: () => readonly ResolvedWorkspaceCommandMenuWorkItemAction[]
  /** Registers or replaces one surface contribution and returns its safe cleanup callback. */
  register: (registration: WorkspaceCommandMenuWorkItemActionRegistration) => () => void
  /** Subscribes to resolved action changes and returns an unsubscribe callback. */
  subscribe: (listener: () => void) => () => void
}

/** Operations shared by authenticated Workspace routes. */
export type WorkspaceCommandMenuContextValue = {
  /** Opens the Workspace command menu. */
  open?: () => void
  /** Registers canonical Work Item actions for the currently mounted surface. */
  registerWorkItemActions?: (
    registration: WorkspaceCommandMenuWorkItemActionRegistration,
  ) => () => void
}

/** Command-menu context shared by authenticated Workspace routes. */
export const WorkspaceCommandMenuContext = createContext<WorkspaceCommandMenuContextValue>({})

/**
 * Reads command-menu operations from the nearest authenticated Workspace layout.
 *
 * @returns Available command-menu operations, or an empty value outside the layout.
 */
export function useWorkspaceCommandMenu(): WorkspaceCommandMenuContextValue {
  return useContext(WorkspaceCommandMenuContext)
}

/**
 * Creates an observable, deterministic registry for mounted Work Item action contributions.
 *
 * A newer registration with the same registration ID replaces the older contribution. Its cleanup
 * callback removes only that exact contribution. Duplicate action IDs across different registrations
 * prefer the greater precedence value, followed by the lexicographically smaller registration ID.
 *
 * @returns A registry suitable for the command-menu context and React external-store subscriptions.
 */
export function createWorkspaceCommandMenuWorkItemActionRegistry(): WorkspaceCommandMenuWorkItemActionRegistry {
  const registrations = new Map<
    string,
    readonly [symbol, WorkspaceCommandMenuWorkItemActionRegistration]
  >()
  const listeners = new Set<() => void>()
  let snapshot: readonly ResolvedWorkspaceCommandMenuWorkItemAction[] = []

  /** Rebuilds the stable action snapshot and notifies every active subscriber. */
  function publish(): void {
    snapshot = resolveWorkspaceCommandMenuWorkItemActions(
      Array.from(registrations.values(), ([, registration]) => registration),
    )
    for (const listener of listeners) listener()
  }

  /**
   * Returns the current stable action snapshot.
   *
   * @returns Resolved actions in canonical contract order.
   */
  function getSnapshot(): readonly ResolvedWorkspaceCommandMenuWorkItemAction[] {
    return snapshot
  }

  /**
   * Registers or replaces one mounted surface contribution.
   *
   * @param registration - Current surface action metadata, context, and executors.
   * @returns A cleanup callback scoped to this exact registration call.
   */
  function register(
    registration: WorkspaceCommandMenuWorkItemActionRegistration,
  ): () => void {
    const token = Symbol(registration.registrationId)
    registrations.set(registration.registrationId, [token, registration])
    publish()

    return () => {
      const current = registrations.get(registration.registrationId)
      if (!current || current[0] !== token) return

      registrations.delete(registration.registrationId)
      publish()
    }
  }

  /**
   * Subscribes to resolved action changes.
   *
   * @param listener - React-compatible store change callback.
   * @returns A callback that removes the listener.
   */
  function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return { getSnapshot, register, subscribe }
}

/**
 * Resolves duplicate surface contributions into canonical Work Item action order.
 *
 * @param registrations - Mounted action contributions from the current route tree.
 * @returns Winning action definitions with complete command-menu invocation contexts.
 */
export function resolveWorkspaceCommandMenuWorkItemActions(
  registrations: readonly WorkspaceCommandMenuWorkItemActionRegistration[],
): readonly ResolvedWorkspaceCommandMenuWorkItemAction[] {
  const definitions = new Map<WorkItemActionId, ResolvedWorkspaceCommandMenuWorkItemAction>()
  const registrationsByPrecedence = [...registrations].sort(compareRegistrations)

  for (const registration of registrationsByPrecedence) {
    for (const action of registration.actions) {
      if (definitions.has(action.id)) continue

      const context: WorkItemActionContext = {
        schemaVersion: registration.context.schemaVersion,
        actionId: action.id,
        trigger: 'command-menu',
        surface: registration.context.surface,
        scope: registration.context.scope,
        selection: registration.context.selection,
        ...(registration.context.viewId !== undefined
          ? { viewId: registration.context.viewId }
          : {}),
      }
      definitions.set(action.id, {
        id: action.id,
        label: action.label,
        ...(action.description !== undefined ? { description: action.description } : {}),
        ...(action.shortcut !== undefined ? { shortcut: action.shortcut } : {}),
        ...(action.disabledReason !== undefined
          ? { disabledReason: action.disabledReason }
          : {}),
        context,
        execute: action.execute,
      })
    }
  }

  return WORK_ITEM_ACTION_IDS.flatMap((actionId) => {
    const action = definitions.get(actionId)
    return action ? [action] : []
  })
}

/**
 * Invokes the executor selected by the command-menu registration resolver.
 *
 * Mouse clicks and keyboard activation both pass through this single adapter.
 *
 * @param action - Resolved canonical action and command-menu invocation context.
 * @returns The executor result without interpreting action-registry-specific values.
 */
export function executeWorkspaceCommandMenuWorkItemAction(
  action: ResolvedWorkspaceCommandMenuWorkItemAction,
): unknown {
  return action.execute(action.context)
}

/**
 * Orders registrations by explicit precedence and stable registration identity.
 *
 * @param left - First registration to compare.
 * @param right - Second registration to compare.
 * @returns A standard array-sort comparison value.
 */
function compareRegistrations(
  left: WorkspaceCommandMenuWorkItemActionRegistration,
  right: WorkspaceCommandMenuWorkItemActionRegistration,
): number {
  return (right.precedence ?? 0) - (left.precedence ?? 0) ||
    left.registrationId.localeCompare(right.registrationId)
}
