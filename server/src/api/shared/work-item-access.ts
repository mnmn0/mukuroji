import {
  ProjectDataError,
  type ProjectDirectoryTeamResponse,
  type ProjectRole,
} from '../../modules/directory'
import {
  readAssignedProjectId,
  type CreateTeamIssueRequestBody,
  type TeamIssueDetailReadOptions,
  type TeamIssueResponseItem,
  type TeamIssuesResponse,
  type UpdateTeamIssueRequestBody,
  type WorkItemIdempotencyTransaction,
  type WorkItemAuthorizationSnapshot,
} from '../../modules/work-items'
import type { IdempotencyMutationToken } from '../../modules/developer-platform/application/ports'
import { developerPlatformDependencies, workItemDependencies } from './app-dependencies'
import { WORK_ITEMS_PARTITION_SCAN_LIMIT, WORK_ITEMS_RESPONSE_LIMIT } from './constants'
import {
  canAccessAssignedProject,
  type ProjectPrincipal,
  requireAssignedProjectPermission,
  requireTeamPermission,
  type WorkspacePrincipal,
} from './project-access'
import { getEnv } from './runtime-config'
import { isRecord } from './value-guards'
import { projectAccessAllows, type TeamPermissionContext } from './workspace-access'

/**
 * Workspace 横断 Work Item API が返す response body です。
 */
export type WorkItemsResponse = {
  /**
   * 現在ユーザーが参照できる canonical Work Item 一覧です。
   */
  workItems: TeamIssueResponseItem[]
}

/**
 * Loads a Team Work Item after verifying that the principal holds the required role.
 *
 * @param principal - Authenticated Workspace principal.
 * @param teamId - Team that owns the resource.
 * @param issueId - Work Item ID within the Team.
 * @param minimumRole - Minimum role the principal must hold.
 * @param detailReadOptions - Work Item detail read options.
 * @returns The authorized Work Item together with its permission context.
 */
export async function loadAuthorizedTeamIssue(
  principal: WorkspacePrincipal,
  teamId: string,
  issueId: string,
  minimumRole: ProjectRole,
  detailReadOptions: TeamIssueDetailReadOptions = {
    consistentIssueRead: true,
    includeEvents: false,
  },
) {
  const context = await requireTeamPermission(principal, teamId, minimumRole)
  const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
    principal.directoryId,
    teamId,
    issueId,
    detailReadOptions,
  )
  requireAssignedProjectPermission(
    principal,
    context,
    detail.issue.assignedProjectId,
    minimumRole,
  )

  return { context, detail }
}

/**
 * Checks whether the principal can write the Work Item.
 *
 * @param principal - Authenticated Workspace principal.
 * @param context - Team permission context of the principal.
 * @param assignedProjectId - Project the Work Item is assigned to.
 * @returns `true` when the principal may write the Work Item.
 */
export function canWriteTeamIssue(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
  assignedProjectId: string | undefined,
) {
  if (principal.workspaceRole === 'guest') {
    return false
  }

  if (principal.isSystemAdmin) {
    return true
  }

  if (assignedProjectId) {
    const access = context.projectAccesses?.find((entry) => entry.projectId === assignedProjectId)
    return access !== undefined && projectAccessAllows(access, 'member')
  }

  return context.projectAccesses?.some((access) => projectAccessAllows(access, 'member')) ?? false
}

/**
 * Filters Work Items down to those the principal can access.
 *
 * @param issues - Work Items to filter.
 * @param principal - Authenticated Workspace principal.
 * @param context - Team permission context of the principal.
 * @returns The accessible Work Items.
 */
export function filterAccessibleTeamIssues(
  issues: TeamIssueResponseItem[],
  principal: ProjectPrincipal,
  context: TeamPermissionContext,
) {
  return issues.filter((issue) =>
    canAccessAssignedProject(principal, context, issue.assignedProjectId, 'viewer'),
  )
}

/** Returns the configured canonical Work Item table used by transaction fences. */
export function getTeamIssuesTableName(): string {
  return getEnv('WORK_ITEMS_TABLE_NAME') ??
    'mukuroji-team-issues-local'
}

/**
 * Reads a Team's canonical Work Items for an aggregate list within the response limit.
 *
 * @param directoryId - Workspace directory ID.
 * @param context - Team permission context of the principal.
 * @param principal - Authenticated Workspace principal.
 * @param includeArchived - Whether archived Work Items are included.
 * @returns The accessible Work Items of the Team.
 */
export async function readCanonicalTeamIssuesForAggregate(
  directoryId: string,
  context: TeamPermissionContext,
  principal: ProjectPrincipal,
  includeArchived = false,
) {
  const clientReadLimit = createWorkItemListProbeLimit(WORK_ITEMS_PARTITION_SCAN_LIMIT)
  const storedIssues = await workItemDependencies.teamIssues.getTeamIssues(
    directoryId,
    context.team.id,
    { limit: clientReadLimit, consistentRead: true, includeArchived },
  )
  assertWorkItemListWithinLimit(
    storedIssues.issues,
    WORK_ITEMS_PARTITION_SCAN_LIMIT,
    `Team "${context.team.id}" canonical partition`,
  )

  return {
    teamId: context.team.id,
    issues: filterAccessibleTeamIssues(storedIssues.issues, principal, context),
  } satisfies TeamIssuesResponse
}

/**
 * Adds a Work Item to an aggregate list and enforces the response limit.
 *
 * @param workItemsById - Aggregate Work Items keyed by Team and ID.
 * @param workItem - Work Item response item.
 */
export function addAggregateWorkItem(
  workItemsById: Map<string, TeamIssueResponseItem>,
  workItem: TeamIssueResponseItem,
) {
  workItemsById.set(`${workItem.teamId}\0${workItem.id}`, workItem)
  if (workItemsById.size > WORK_ITEMS_RESPONSE_LIMIT) {
    throw createWorkItemListLimitExceededError(
      `Workspace has more than ${WORK_ITEMS_RESPONSE_LIMIT} accessible Work Items.`,
    )
  }
}

/**
 * Creates the read limit that detects lists exceeding the response limit.
 *
 * @param limit - Maximum number of items.
 * @returns The limit plus one, or `undefined` when unlimited.
 */
export function createWorkItemListProbeLimit(limit: number | undefined) {
  return limit === undefined ? undefined : limit + 1
}

/**
 * Asserts that a Work Item list does not exceed its limit.
 *
 * @param items - Items to check.
 * @param limit - Maximum number of items.
 * @param scope - Scope named in the error message.
 */
export function assertWorkItemListWithinLimit(
  items: readonly unknown[],
  limit: number | undefined,
  scope: string,
) {
  if (limit !== undefined && items.length > limit) {
    throw createWorkItemListLimitExceededError(
      `${scope} has more than ${limit} Work Items.`,
    )
  }
}

/**
 * Creates the error returned when an aggregate Work Item list exceeds its limit.
 *
 * @param reason - Reason included in the error message.
 * @returns The 413 project data error.
 */
export function createWorkItemListLimitExceededError(reason: string) {
  return new ProjectDataError(
    413,
    'WorkItemListLimitExceeded',
    `${reason} Refine the Workspace before loading the aggregate Work Item list.`,
  )
}

/**
 * Normalizes the assigned Project of a Work Item create or update body against the Team.
 *
 * @param input - Request input.
 * @param team - Team directory entry.
 * @returns The normalized input.
 */
export function normalizeTeamIssueInput<TInput extends CreateTeamIssueRequestBody | UpdateTeamIssueRequestBody>(
  input: TInput,
  team: ProjectDirectoryTeamResponse,
) {
  if (!('assignedProjectId' in input)) {
    return input
  }

  const assignedProjectId = readAssignedProjectId(input.assignedProjectId)

  if (
    assignedProjectId &&
    !team.projects.some((project) => project.id === assignedProjectId)
  ) {
    throw new ProjectDataError(
      400,
      'InvalidProjectWrite',
      `Assigned project "${assignedProjectId}" is not active in team "${team.id}".`,
    )
  }

  return {
    ...input,
    assignedProjectId,
  }
}

/**
 * Rejects named internal fields before normalization can spread an untrusted object.
 *
 * @param input - Untrusted Work Item body already narrowed to a record.
 * @param fields - Adapter-owned field names forbidden at the boundary.
 */
export function rejectWorkItemInternalFields(
  input: unknown,
  fields: readonly string[],
): void {
  if (!isRecord(input)) {
    throw new ProjectDataError(
      400,
      'InvalidProjectWrite',
      'Work Item body must be an object.',
    )
  }
  const suppliedFields = fields.filter((field) => field in input)
  if (suppliedFields.length > 0) {
    throw new ProjectDataError(
      400,
      'InvalidProjectWrite',
      `Work Item body contains internal fields: ${suppliedFields.join(', ')}.`,
    )
  }
}

/**
 * Captures application-level authorization generations for a Work Item mutation.
 *
 * @param principal - Principal authorized against current Workspace state.
 * @param planningRevision - Planning authorization revision observed with the principal.
 * @returns A storage-agnostic authorization snapshot for the Work Item port.
 */
export function createWorkItemAuthorizationSnapshot(
  principal: WorkspacePrincipal,
  planningRevision: number,
): WorkItemAuthorizationSnapshot {
  return {
    workspaceId: principal.directoryId,
    memberKey: principal.userKey,
    workspaceMemberVersion: principal.workspaceMember.version,
    planningRevision,
    ...(principal.enterpriseIdentityControlRevision === undefined
      ? {}
      : {
          enterpriseControlRevision:
            principal.enterpriseIdentityControlRevision,
        }),
  }
}

/**
 * Creates the idempotency transaction for a Work Item mutation.
 *
 * @param workspaceId - Workspace that scopes the operation.
 * @param token - Idempotency mutation token, when the request carries one.
 * @returns The idempotency transaction, or `undefined` when none applies.
 */
export function createWorkItemIdempotencyTransaction(
  workspaceId: string,
  token: IdempotencyMutationToken | undefined,
): WorkItemIdempotencyTransaction | undefined {
  if (!token || !developerPlatformDependencies.transactions.prepareIdempotencyCompletionTransactWrite) {
    return undefined
  }
  return {
    async prepare(response) {
      return developerPlatformDependencies.transactions.prepareIdempotencyCompletionTransactWrite?.({
        workspaceId,
        credentialId: token.credentialId,
        idempotencyKey: token.idempotencyKey,
        requestFingerprint: token.requestFingerprint,
        reservationId: token.reservationId,
        response,
      })
    },
  }
}
