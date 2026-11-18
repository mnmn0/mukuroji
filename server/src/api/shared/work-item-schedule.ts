import { createHash } from 'node:crypto'
import { ProjectDataError } from '../../modules/directory'
import {
  WorkItemScheduleError,
  type PublicCreateTeamIssueRequestBody,
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
 * Fields a client may send to the Work Item update endpoint.
 *
 * Keyed by the public body type so a new public field fails type checking until it is listed here.
 */
const publicWorkItemUpdateFields: Readonly<Record<keyof PublicUpdateTeamIssueRequestBody, true>> = {
  expectedRevision: true,
  title: true,
  description: true,
  assignedProjectId: true,
  assigneeUserId: true,
  contributorAssignments: true,
  acceptanceCriteria: true,
  schedule: true,
  remainingEffortMinutes: true,
  progressPercent: true,
  priority: true,
  workflowStatusId: true,
  workItemTypeId: true,
  customFieldValues: true,
  typeChangeResolution: true,
}

/**
 * Fields a client may send to the Work Item create endpoint.
 *
 * Keyed by the public body type so a new public field fails type checking until it is listed here.
 */
const publicWorkItemCreateFields: Readonly<Record<keyof PublicCreateTeamIssueRequestBody, true>> = {
  title: true,
  description: true,
  assignedProjectId: true,
  assigneeUserId: true,
  contributorAssignments: true,
  schedule: true,
  priority: true,
  workflowStatusId: true,
  workItemTypeId: true,
  customFieldValues: true,
  quickCapture: true,
}

/**
 * Returns whether a client-supplied key is a public Work Item update field.
 *
 * @param field - Key read from the untrusted request body.
 * @returns Whether the key may be copied into the update input.
 */
function isPublicWorkItemUpdateField(field: string): field is keyof PublicUpdateTeamIssueRequestBody {
  return Object.hasOwn(publicWorkItemUpdateFields, field)
}

/**
 * Returns whether a client-supplied key is a public Work Item create field.
 *
 * @param field - Key read from the untrusted request body.
 * @returns Whether the key may be copied into the create input.
 */
function isPublicWorkItemCreateField(field: string): field is keyof PublicCreateTeamIssueRequestBody {
  return Object.hasOwn(publicWorkItemCreateFields, field)
}

/**
 * Reads an untrusted Work Item update body into a fresh object holding only public fields.
 *
 * Known server-owned fields are rejected with 400; unknown fields are dropped, so nothing the
 * client sends can reach adapter-only inputs such as transaction items.
 *
 * @param input - Untrusted update body.
 * @returns A new body built from the public update fields only.
 */
export function readPublicWorkItemUpdateBody(input: unknown): PublicUpdateTeamIssueRequestBody {
  rejectInternalWorkItemUpdateFields(input)
  const body: PublicUpdateTeamIssueRequestBody = {}
  for (const [field, value] of Object.entries(input)) {
    if (isPublicWorkItemUpdateField(field)) {
      body[field] = value
    }
  }
  return body
}

/**
 * Reads an untrusted Work Item create body into a fresh object holding only public fields.
 *
 * Known server-owned fields are rejected with 400; unknown fields are dropped.
 *
 * @param input - Untrusted create body.
 * @returns A new body built from the public create fields only.
 */
export function readPublicWorkItemCreateBody(input: unknown): PublicCreateTeamIssueRequestBody {
  rejectInternalWorkItemCreateFields(input)
  // A missing schedule stays undefined, which the create path rejects as before.
  const body: PublicCreateTeamIssueRequestBody = { schedule: input.schedule }
  for (const [field, value] of Object.entries(input)) {
    if (isPublicWorkItemCreateField(field)) {
      body[field] = value
    }
  }
  return body
}

/**
 * Rejects server-owned fields in a public Work Item update body.
 *
 * @param input - Request input.
 */
export function rejectInternalWorkItemUpdateFields(
  input: unknown,
): asserts input is Record<string, unknown> {
  rejectDerivedWorkItemScheduleFields(input)
  if ('archivedAt' in input || 'archivedBy' in input) {
    throw new ProjectDataError(
      400,
      'InvalidWorkItemArchiveUpdate',
      'Work Item archive fields cannot be updated through this endpoint.',
    )
  }
  rejectWorkItemInternalFields(input, [
    'agentRunTransactItems',
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
export function rejectInternalWorkItemCreateFields(
  input: unknown,
): asserts input is Record<string, unknown> {
  rejectDerivedWorkItemScheduleFields(input)
  rejectWorkItemInternalFields(input, [
    'agentRunTransactItems',
    'authorizationConditionChecks',
    'authorizationSnapshot',
    'configurationConditionChecks',
    'idempotencyResourceId',
    'idempotentIssueId',
    'idempotentRequestDigest',
    'newWorkItemProjectConditionCheck',
    'statusCategory',
    'workflowSchemaVersion',
  ])
}

/**
 * Rejects the removed deadline mutation field at internal Work Item API boundaries.
 *
 * @param input - Untrusted create or update body.
 */
function rejectDerivedWorkItemScheduleFields(
  input: unknown,
): asserts input is Record<string, unknown> {
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
