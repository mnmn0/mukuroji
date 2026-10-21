import { createHash } from 'node:crypto'
import { ProjectDataError } from '../../modules/directory'
import {
  WorkItemScheduleError,
  type PublicUpdateTeamIssueRequestBody,
  type WorkItemAuthorizationSnapshot,
} from '../../modules/work-items'
import {
  PlanningError,
  requirePlanningWorkItemHasNoScheduleDependencies,
} from '../../modules/planning'
import { workItemDependencies } from './app-dependencies'
import { type WorkspacePrincipal } from './project-access'
import { isRecord } from './value-guards'
import {
  createWorkItemAuthorizationSnapshot,
  rejectWorkItemInternalFields,
} from './work-item-access'

/**
 * Derives a Developer Platform-safe partition from an internal Workspace directory key.
 *
 * @param directoryId - Internal Workspace directory partition key.
 * @returns Stable opaque Developer Platform Workspace identifier.
 */
export function createWorkItemScheduleIdempotencyWorkspaceId(directoryId: string): string {
  return `directory:${createHash('sha256').update(directoryId).digest('hex').slice(0, 48)}`
}

/**
 * Derives a user-scoped credential namespace without persisting the Cognito identity.
 *
 * @param directoryId - Internal Workspace directory partition key.
 * @param actorId - Immutable Cognito subject or username.
 * @returns Stable opaque user credential identifier.
 */
export function createWorkItemScheduleIdempotencyUserId(
  directoryId: string,
  actorId: string,
): string {
  const digest = createHash('sha256')
    .update(`${directoryId}\0${actorId}`)
    .digest('hex')
    .slice(0, 48)
  return `user:${digest}`
}

/**
 * Rejects server-owned fields in a public Work Item update body.
 *
 * @param input - Request input.
 */
export function rejectInternalWorkItemUpdateFields(input: PublicUpdateTeamIssueRequestBody) {
  rejectDerivedWorkItemScheduleFields(input)
  if ('archivedAt' in input || 'archivedBy' in input) {
    throw new ProjectDataError(
      400,
      'InvalidWorkItemArchiveUpdate',
      'Work Item archive fields cannot be updated through this endpoint.',
    )
  }
  rejectWorkItemInternalFields(input, [
    'authorizationConditionChecks',
    'authorizationSnapshot',
    'configurationConditionChecks',
    'planningRevisionFence',
    'statusCategory',
    'workflowSchemaVersion',
  ])
}

/**
 * Rejects adapter-owned fields at an untrusted Work Item create boundary.
 *
 * @param input - Untrusted create body.
 */
export function rejectInternalWorkItemCreateFields(input: unknown): void {
  rejectDerivedWorkItemScheduleFields(input)
  rejectWorkItemInternalFields(input, [
    'authorizationConditionChecks',
    'authorizationSnapshot',
    'configurationConditionChecks',
    'idempotencyResourceId',
    'idempotentIssueId',
    'idempotentRequestDigest',
    'statusCategory',
    'workflowSchemaVersion',
  ])
}

/**
 * Rejects the removed deadline mutation field at internal Work Item API boundaries.
 *
 * @param input - Untrusted create or update body.
 */
function rejectDerivedWorkItemScheduleFields(input: unknown): void {
  if (!isRecord(input)) {
    throw new ProjectDataError(
      400,
      'InvalidProjectWrite',
      'Work Item body must be an object.',
    )
  }
  if ('dueDate' in input) {
    throw new WorkItemScheduleError(
      400,
      'InvalidWorkItemSchedule',
      'dueDate is derived from schedule and cannot be written directly.',
    )
  }
}

/**
 * Validates that a Work Item has no incident schedule dependency and captures mutation fences.
 *
 * @param principal - Principal authorized to mutate the Work Item.
 * @param teamId - Owning Team identifier.
 * @param workItemId - Team-local Work Item identifier.
 * @returns Authorization snapshot bound to the exact unfiltered Planning revision checked.
 */
export async function createDependencyFencedWorkItemAuthorizationSnapshot(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
): Promise<WorkItemAuthorizationSnapshot> {
  const planningState = await workItemDependencies.planning.getAuthorizationState(
    principal.directoryId,
  )
  if (planningState.workItemDependencies === undefined) {
    throw new PlanningError(
      503,
      'PlanningWorkItemDependencyStateUnavailable',
      'Work Item dependency state is unavailable for mutation validation.',
    )
  }
  requirePlanningWorkItemHasNoScheduleDependencies(
    planningState.workItemDependencies,
    teamId,
    workItemId,
  )
  return createWorkItemAuthorizationSnapshot(principal, planningState.revision)
}
