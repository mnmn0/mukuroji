import type { ProjectCharter, ProjectCharterPerson, ProjectCharterState } from '@mukuroji/contracts'
import {
  createProjectCharter,
  decideProjectLifecycleTransition,
  readProjectCharterUpdate,
  readProjectLifecycleTransition,
  type StoredProjectLifecycleState,
} from '../domain/project-charter'
import { ProjectDataError } from '../project-data-error'

/** Identifies one Team-owned Project inside a Workspace. */
export type ProjectCharterScope = {
  /** Workspace directory that owns the Project. */
  workspaceId: string
  /** Team that owns the Project. */
  teamId: string
  /** Project identifier. */
  projectId: string
}

/**
 * Charter persistence required by the use cases.
 *
 * `TFence` is an opaque commit-time proof built by the person resolver and checked by the store
 * in the same transaction; `TAudit` is the audit context the inbound adapter captured.
 */
export type ProjectCharterStore<TFence, TAudit> = {
  /** Strongly reads the charter and lifecycle state. */
  getProjectCharter(workspaceId: string, teamId: string, projectId: string): Promise<ProjectCharterState>
  /** Replaces the charter in one transaction that also checks every person fence. */
  updateProjectCharter(
    workspaceId: string,
    teamId: string,
    projectId: string,
    expectedRevision: number,
    charter: ProjectCharter,
    auditContext: TAudit,
    personFences: TFence[],
  ): Promise<ProjectCharterState>
  /** Stores an already decided lifecycle state, guarded by the same revision. */
  transitionProjectLifecycle(
    workspaceId: string,
    teamId: string,
    projectId: string,
    expectedRevision: number,
    state: StoredProjectLifecycleState,
    auditContext: TAudit,
  ): Promise<ProjectCharterState>
}

/** A charter person resolved to an active Workspace member. */
export type ResolvedProjectCharterPerson<TFence> = {
  /** Display snapshot stored on the charter. */
  person: ProjectCharterPerson
  /** Proof that the member is still active when the charter write commits. */
  fence?: TFence
}

/** Ports used by the charter update use case. */
export type UpdateProjectCharterPorts<TFence, TAudit> = {
  /** Charter persistence. */
  store: ProjectCharterStore<TFence, TAudit>
  /**
   * Resolves a member key to an active Workspace member.
   * Rejects with `ProjectCharterPersonInactive` when the member is not active.
   */
  resolvePerson(workspaceId: string, userId: string): Promise<ResolvedProjectCharterPerson<TFence>>
  /** Best-effort projection of the committed charter into Workspace search. */
  projectSearchDocument(workspaceId: string, state: ProjectCharterState): Promise<void>
}

/**
 * Validates and stores a complete charter replacement.
 *
 * The owner and sponsor are resolved to active members, and their membership fences commit with
 * the charter, so a deactivation that lands after the read cannot be saved as owner or sponsor.
 *
 * @param ports - Persistence, person resolution, and search projection.
 * @param scope - Project whose charter is replaced; the caller already authorized it.
 * @param body - Untrusted request body.
 * @param auditContext - Builds the audit context of the request.
 * @returns The committed charter state.
 */
export async function updateProjectCharterUseCase<TFence, TAudit>(
  ports: UpdateProjectCharterPorts<TFence, TAudit>,
  scope: ProjectCharterScope,
  body: unknown,
  auditContext: (update: Record<string, unknown>) => TAudit,
): Promise<ProjectCharterState> {
  const update = readProjectCharterUpdate(body)
  if (!update.ok) throw new ProjectDataError(400, update.code, update.message)
  const resolve = (userId: string | undefined) =>
    userId === undefined ? undefined : ports.resolvePerson(scope.workspaceId, userId)
  const [owner, sponsor] = await Promise.all([
    resolve(update.value.ownerUserId),
    resolve(update.value.sponsorUserId),
  ])
  const charter = createProjectCharter(update.value, {
    ...(owner === undefined ? {} : { owner: owner.person }),
    ...(sponsor === undefined ? {} : { sponsor: sponsor.person }),
  })
  // One fence per member: DynamoDB rejects a transaction naming one item twice.
  const personFences = [...new Map(
    [owner, sponsor].flatMap((resolved) =>
      resolved?.fence === undefined ? [] : [[resolved.person.userId, resolved.fence] as const]
    ),
  ).values()]
  const state = await ports.store.updateProjectCharter(
    scope.workspaceId,
    scope.teamId,
    scope.projectId,
    update.value.expectedRevision,
    charter,
    auditContext({ teamId: scope.teamId, projectId: scope.projectId, ...update.value }),
    personFences,
  )
  await ports.projectSearchDocument(scope.workspaceId, state)
  return state
}

/** Ports used by the lifecycle transition use case. */
export type TransitionProjectLifecyclePorts<TAudit> = {
  /** Charter persistence. */
  store: Pick<ProjectCharterStore<never, TAudit>, 'getProjectCharter' | 'transitionProjectLifecycle'>
  /** Rejects when the caller may not approve or reject a proposed Project. */
  requireProposalDecision(): void
}

/**
 * Moves a Project to another lifecycle state.
 *
 * Deciding on a `proposed` Project is the approval step and needs its own permission. The store
 * guards the write with the revision the decision was based on.
 *
 * @param ports - Persistence and the proposal-decision permission check.
 * @param scope - Project to move; the caller already authorized managing it.
 * @param body - Untrusted request body.
 * @param auditContext - Builds the audit context of the request.
 * @returns The committed charter state.
 */
export async function transitionProjectLifecycleUseCase<TAudit>(
  ports: TransitionProjectLifecyclePorts<TAudit>,
  scope: ProjectCharterScope,
  body: unknown,
  auditContext: (transition: Record<string, unknown>) => TAudit,
): Promise<ProjectCharterState> {
  const transition = readProjectLifecycleTransition(body)
  if (!transition.ok) throw new ProjectDataError(400, transition.code, transition.message)
  const current = await ports.store.getProjectCharter(scope.workspaceId, scope.teamId, scope.projectId)
  if (current.lifecycleState === 'proposed') ports.requireProposalDecision()
  const decision = decideProjectLifecycleTransition(current, transition.value)
  if (!decision.ok) throw new ProjectDataError(409, decision.code, decision.message)
  return await ports.store.transitionProjectLifecycle(
    scope.workspaceId,
    scope.teamId,
    scope.projectId,
    transition.value.expectedRevision,
    decision.to,
    auditContext({ teamId: scope.teamId, projectId: scope.projectId, ...transition.value }),
  )
}
