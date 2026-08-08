import type {
  PlanningSnapshot,
  WorkItemScheduleDependency,
  WorkItemScheduleDependencyPatch,
} from '@mukuroji/contracts'
import type { KeyedMutator } from 'swr'
import type { CurrentUser } from '../../auth/api'
import type { MutationRequestRunner } from '../../shared/api/mutationHeaders'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  createWorkItemDependencyMutationId,
  type WorkItemDependencyCreateDraft,
} from '../../work-items/model/workItemDependencies'
import {
  createWorkItemScheduleDependency,
  deleteWorkItemScheduleDependency,
  isPlanningSnapshotConflict,
  updateWorkItemScheduleDependency,
} from '../api'
import {
  canManagePlanningWorkItemDependency,
  type PlanningAccessSnapshot,
} from '../model/permissions'

/** Dependencies used by canonical Work Item schedule-dependency mutations. */
export type WorkItemDependencyMutationControllerOptions = {
  /** Session bearer token used by Planning mutations. */
  accessToken?: string
  /** Applies enterprise-session redirect policy to one API promise. */
  guardEnterpriseSession: <Result>(request: Promise<Result>) => Promise<Result>
  /** Revalidates or updates the authoritative Planning snapshot cache. */
  mutatePlanning: KeyedMutator<PlanningSnapshot>
  /** Retains idempotency context for retryable logical mutations. */
  mutationRequestRunner: MutationRequestRunner
  /** Current user's Team and Project management scope. */
  planningAccess: PlanningAccessSnapshot
  /** Latest authoritative Planning snapshot. */
  planningSnapshot?: PlanningSnapshot
  /** Resolves localized authorization fallback messages. */
  t: (key: MessageKey) => string
  /** Authenticated user whose endpoint authority is checked before mutations. */
  user?: CurrentUser | null
}

/** Canonical dependency mutations shared by task and Team Work Item routes. */
export type WorkItemDependencyMutationController = {
  /** Creates one canonical Work Item schedule dependency. */
  create: (input: WorkItemDependencyCreateDraft) => Promise<void>
  /** Deletes one canonical Work Item schedule dependency. */
  delete: (dependency: WorkItemScheduleDependency) => Promise<void>
  /** Updates one canonical Work Item schedule dependency rule. */
  update: (
    dependency: WorkItemScheduleDependency,
    patch: WorkItemScheduleDependencyPatch,
  ) => Promise<void>
}

/**
 * Creates revision-aware Work Item dependency mutations shared by route-level controllers.
 *
 * @param options - API authority, cache mutator, session policy, and Planning revision context.
 * @returns Create, update, and delete callbacks for the canonical dependency graph.
 */
export function createWorkItemDependencyMutationController({
  accessToken,
  guardEnterpriseSession,
  mutatePlanning,
  mutationRequestRunner,
  planningAccess,
  planningSnapshot,
  t,
  user,
}: WorkItemDependencyMutationControllerOptions): WorkItemDependencyMutationController {
  /** Persists one dependency mutation and refreshes stale Planning authority on conflicts. */
  const runMutation = async (
    request: () => Promise<PlanningSnapshot>,
  ): Promise<void> => {
    try {
      const result = await request()
      await mutatePlanning(result, { revalidate: false })
    } catch (error) {
      if (isPlanningSnapshotConflict(error)) await mutatePlanning()
      throw error
    }
  }

  /** Returns the token and snapshot after checking both dependency endpoints. */
  const requireMutationContext = (
    dependency: Pick<WorkItemScheduleDependency, 'predecessor' | 'successor'>,
  ): { snapshot: PlanningSnapshot; token: string } => {
    if (
      !accessToken ||
      !planningSnapshot ||
      !canManagePlanningWorkItemDependency(
        user,
        dependency,
        planningSnapshot.workItems,
        planningAccess,
      )
    ) {
      throw new Error(t('planning.error'))
    }
    return { snapshot: planningSnapshot, token: accessToken }
  }

  /** Creates one revision-bound canonical Work Item schedule dependency. */
  const create = async (input: WorkItemDependencyCreateDraft): Promise<void> => {
    const { snapshot, token } = requireMutationContext(input)
    await runMutation(() => guardEnterpriseSession(mutationRequestRunner.run(
      'planning:work-item-dependency:create',
      JSON.stringify([snapshot.revision, input]),
      (context) => createWorkItemScheduleDependency(token, {
        ...input,
        expectedRevision: snapshot.revision,
        id: createWorkItemDependencyMutationId(context.idempotencyKey),
      }, context),
    )))
  }

  /** Updates one revision-bound canonical Work Item schedule dependency. */
  const update = async (
    dependency: WorkItemScheduleDependency,
    patch: WorkItemScheduleDependencyPatch,
  ): Promise<void> => {
    const { snapshot, token } = requireMutationContext(dependency)
    await runMutation(() => guardEnterpriseSession(mutationRequestRunner.run(
      `planning:work-item-dependency:${dependency.id}:update`,
      JSON.stringify([snapshot.revision, patch]),
      (context) => updateWorkItemScheduleDependency(token, dependency.id, {
        expectedRevision: snapshot.revision,
        patch,
      }, context),
    )))
  }

  /** Deletes one revision-bound canonical Work Item schedule dependency. */
  const deleteDependency = async (
    dependency: WorkItemScheduleDependency,
  ): Promise<void> => {
    const { snapshot, token } = requireMutationContext(dependency)
    await runMutation(() => guardEnterpriseSession(mutationRequestRunner.run(
      `planning:work-item-dependency:${dependency.id}:delete`,
      String(snapshot.revision),
      (context) => deleteWorkItemScheduleDependency(token, dependency.id, {
        expectedRevision: snapshot.revision,
      }, context),
    )))
  }

  return { create, delete: deleteDependency, update }
}
