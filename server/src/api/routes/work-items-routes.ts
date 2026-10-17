import { createHash } from 'node:crypto'
import {
  readSearchWorkItemTypeKey,
  type AcceptCreateTriageAction,
  type ApprovalSummary,
  type ConfirmedWorkItemSchedule,
  type ConfirmWorkItemScheduleChangeResponse,
  type CreateCuratedContextItemRequest,
  type CuratedContextActorSnapshot,
  type CuratedContextCapabilities,
  type CuratedContextItem,
  type CuratedContextQuote,
  type CuratedContextSource,
  type RequestSubmission,
  type RequestSubmissionActionInput,
  type TriageActionInput,
  type TriageEntry,
  type CustomFieldValue,
  PROJECT_QUICK_ACCESS_MAX_REVISION,
  type ProjectQuickAccessPreferences,
  type UpdateProjectQuickAccessPreferencesInput,
  type UpdateCuratedContextItemRequest,
  type WorkItemRelation,
  type WorkItemRelationType,
  type WorkItemDependencyEndpoint,
  type WorkItemScheduleEvaluationRevision,
  type WorkItemScheduleImpact,
  type WorkItemScheduleOperation,
  type EnterprisePermissionId,
} from '@mukuroji/contracts'
import type { Hono } from 'hono'
import type { Context } from 'hono'
import {
  clampCognitoPageLimit,
  CognitoServiceError,
  isCognitoUserNotFoundError,
  type CognitoUserProfile,
  type CognitoUsersResponse,
  type ListCognitoUsersInput,
} from '../../modules/authentication'
import {
  createProjectQuickAccessIdentity,
  isProjectQuickAccessItems,
  ProjectDataError,
  readLocalizedNames,
  type CreateProjectRequestBody,
  type CreateTeamRequestBody,
  type ProjectAccessEntry,
  type ProjectDirectoryTeamResponse,
  type ProjectArchiveWorkItemRevisionGuard,
  type ProjectMemberResponseItem,
  type ProjectMembersResponse,
  type ProjectRole,
  type UpdateProjectMemberRequestBody,
  type UpdateProjectMemberResponse,
} from '../../modules/directory'
import {
  getConfiguredAuditTableName,
  getConfiguredAuditRetentionDays,
  getConfiguredDynamoDbEndpoint,
  toAuditEventView,
  type AuditEventPage,
} from '../../modules/audit/audit'
import {
  createTeamIssueAuditEntityId,
  createTeamIssueDeepLink,
  confirmWorkItemScheduleChange,
  collectWorkItemScheduleEvaluationEndpoints,
  createWorkItemDependencyKey,
  createWorkItemRelationGraphRevisionConditionCheck,
  deriveWorkItemScheduleDueDate,
  isTeamIssueNotFoundError,
  normalizeWorkItemSchedule,
  normalizeWorkItemScheduleOperation,
  previewWorkItemDependencyScheduleChange,
  readAssignedProjectId,
  readRequiredString,
  readTeamIssueAssigneeUserId,
  readWorkItemExpectedRevision,
  WorkItemScheduleError,
  WORK_ITEM_SCHEDULE_CASCADE_LIMIT,
  type CreateTeamIssueRequestBody,
  type CreateTeamIssueResponse,
  type ConfirmWorkItemScheduleChangeCommand,
  type ProjectIssuesResponse,
  type PublicUpdateTeamIssueRequestBody,
  type TeamIssueDetailResponse,
  type TeamIssueResponseItem,
  type TeamIssuesResponse,
  type TriageDuplicateContextTransactionContribution,
  type UpdateTeamIssueResponse,
  type WorkItemIdempotencyTransaction,
  type WorkItemAuthorizationSnapshot,
  type WorkItemDependencyScheduleState,
} from '../../modules/work-items'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import {
  CollaborationError,
  COLLABORATION_CONTEXT_BODY_MAX_LENGTH,
  COLLABORATION_CONTEXT_TITLE_MAX_LENGTH,
  createProjectCollaborationEntityKey,
  createWorkItemCollaborationEntityKey,
  type CuratedContextActivitySourceAuthorizationSnapshot,
  type CuratedContextDocumentSourceAuthorizationSnapshot,
} from '../../modules/collaboration/collaboration'
import {
  FILE_APPROVAL_MAX_REVIEWERS,
  FileProofingError,
  createFileProofingScopeKey,
  type CancelFileApprovalInput,
  type CreateFileApprovalDecisionInput,
  type CreateFileApprovalInput,
  type FileApprovalCompletionTransition,
  type FileApprovalCompletionTransitionResolver,
} from '../../modules/files/file-proofing'
import {
  createCuratedContextItemWorkspaceSearchDocument,
  createDocumentWorkspaceSearchBody,
  createTeamWorkspaceSearchDocument,
} from '../../modules/workspace-search/workspace-search'
import {
  createFormTriageEntryId,
  RequestIntakeError,
  createRequestWorkItemInput,
} from '../../modules/request-intake/request-intake'
import { CustomerError, projectCustomerImpactSignal } from '../../modules/customers'
import {
  createTriageAcceptanceTransactionItems,
  createTriageActionAuditIdempotencyKey,
  createTriageActionTransactionItems,
  createTriageInputFingerprint,
  TriageError,
  type TriageIdempotency,
  type TriageTransactionContribution,
} from '../../modules/triage'
import {
  evaluateEnterpriseAccess,
  type EnterpriseAuthorizationResource,
} from '../../modules/enterprise-identity'
import {
  WorkItemConfigurationError,
  assertWorkItemChildTypeAllowed,
  createWorkItemConfigurationGuardConditionChecks,
  createWorkItemRelationIds,
  previewWorkItemTypeChange,
} from '../../modules/work-items/work-item-configuration'
import { PlanningError } from '../../modules/planning'
import type {
  IdempotencyMutationToken,
  ReserveIdempotencyRequest,
} from '../../modules/developer-platform/application/ports'
import { DeveloperPlatformError } from '../../modules/developer-platform'
import { DocumentError, type DocumentAccessContext } from '../../modules/documents'
import {
  authenticationDependencies,
  developerPlatformDependencies,
  workItemDependencies,
  workspaceDependencies,
} from '../shared/app-dependencies'
import {
  canManageTeamIssueCollaboration,
  createTeamIssueAutomaticWatcherCandidates,
  loadFileProofingRequestContext,
  readCommentMentionMemberKeys,
  readOptionalCommentId,
  requireValidCommentMentions,
  toCollaborationCommentResponse,
  toCollaborationErrorResponse,
  toWorkItemConfigurationErrorResponse,
} from '../shared/collaboration-access'
import { WORK_ITEM_RELATION_TARGET_READ_CONCURRENCY } from '../shared/constants'
import { hasCustomerManagementAccess, hasCustomerReadAccess } from '../shared/customer-access'
import {
  createProjectSearchDocument,
  createWorkItemSearchDocument,
  projectWorkItemSearchDocumentBestEffort,
} from '../shared/document-access'
import {
  type EnterpriseTeamAccess,
  toCognitoDirectoryErrorResponse,
} from '../shared/enterprise-access'
import {
  hasApprovalSummaryContent,
  hasWorkItemApprovalCompletionTransitionConflict,
  listAuthorizedReviewerApprovals,
  prepareConfiguredUpdateWorkItem,
  readFileProofingJson,
  requireApprovalReviewers,
  requireCanonicalFileProofingWorkItem,
  resolveFileApprovalCompletionTransition,
  toFileProofingErrorResponse,
} from '../shared/file-approval-access'
import {
  invalidCuratedContextInput,
  readBearerAccessToken,
  readCuratedContextIdentifier,
  readCuratedContextRevision,
  readCuratedContextText,
  readJson,
  toAuthErrorResponse,
} from '../shared/http'
import { readAuditEventQuery, readLocale, readRequiredRouteId } from '../shared/input-parsing'
import {
  createPlanningFencedWorkItemAuthorizationSnapshot,
  filterPlanningSnapshotForPrincipal,
  readAccessibleWorkItems,
  readPlanningIdentifier,
  readPlanningWorkItemState,
  requirePlanningUpdateProjectPermission,
  requirePlanningWorkItemEndpointPermission,
} from '../shared/planning-access'
import {
  canAccessAssignedProject,
  createApiMutationContext,
  createCuratedContextActorSnapshot,
  getEffectiveProjectAccessList,
  type ProjectPrincipal,
  requireAssignedProjectPermission,
  requireProjectPermission,
  requireTeamPermission,
  requireWorkspaceAdministration,
  requireWorkspaceBusinessWrite,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from '../shared/project-access'
import {
  assertCuratedContextScopeUnchanged,
  authenticateWorkspacePrincipal,
  requireRequestAdministration,
} from '../shared/request-authorization'
import {
  createDeterministicTriageWorkItemId,
  createTriageActionReferenceConditionChecks,
  createTriageProjectAuthorizationConditionChecks,
  mergeTriageConditionChecks,
  toRequestIntakeErrorResponse,
} from '../shared/request-intake-access'
import { getEnv } from '../shared/runtime-config'
import {
  createWorkspaceSearchContext,
  deleteWorkspaceSearchDocumentBestEffort,
  isWorkspaceSearchAuthorizationCurrent,
  isWorkspaceSearchProjectionEnabled,
  projectWorkItemMutationSearchDocumentBestEffort,
  projectWorkspaceSearchDocumentBestEffort,
} from '../shared/search-access'
import { isRecord, stableDigestStringify } from '../shared/value-guards'
import {
  canWriteTeamIssue,
  createWorkItemAuthorizationSnapshot,
  createWorkItemIdempotencyTransaction,
  filterAccessibleTeamIssues,
  loadAuthorizedTeamIssue,
  normalizeTeamIssueInput,
  type WorkItemsResponse,
} from '../shared/work-item-access'
import {
  filterRequestConversionCustomFieldValues,
  getWorkItemConfigurationTableName,
  prepareConfiguredCreateWorkItem,
} from '../shared/work-item-configuration'
import {
  createDependencyFencedWorkItemAuthorizationSnapshot,
  createWorkItemScheduleIdempotencyUserId,
  createWorkItemScheduleIdempotencyWorkspaceId,
  rejectInternalWorkItemCreateFields,
  rejectInternalWorkItemUpdateFields,
} from '../shared/work-item-schedule'
import {
  projectAccessAllows,
  requireActiveWorkspaceAssignee,
  type TeamPermissionContext,
  validateRequestRoutingTarget,
} from '../shared/workspace-access'

/** Maximum serialized UTF-8 bytes allowed for the comments in one collaboration response. */
const COLLABORATION_COMMENT_RESPONSE_MAX_BYTES = 4_000_000

/**
 * Presence heartbeat API が受け取る request body です。
 */
type TeamIssuePresenceRequestBody = {
  /**
   * Browser tab ごとに作成する安定した client ID です。
   */
  clientId?: unknown
  /**
   * Comment composer に入力中かどうかです。
   */
  typing?: unknown
}

/** Schedule dependency graph and authorization snapshot stabilization attempts. */
const WORK_ITEM_SCHEDULE_SNAPSHOT_RETRY_LIMIT = 3

/**
 * Parses the collaboration endpoint page limit before it is clamped for root or reply pages.
 *
 * @param value - Raw query-string page limit.
 * @returns A safe integer page limit, or undefined when omitted.
 */
function readCollaborationPageLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new CollaborationError(400, 'InvalidCollaborationCursor', 'Page limit is invalid.')
  }
  return limit
}

/**
 * Parses and validates a complete quick-access replacement request.
 *
 * @param value - Unknown JSON request body.
 * @returns A normalized versioned replacement input.
 */
function readProjectQuickAccessInput(
  value: unknown,
): UpdateProjectQuickAccessPreferencesInput {
  if (!isRecord(value)) {
    throw createInvalidProjectQuickAccessInputError()
  }

  const revision = value.revision
  const candidateItems = value.items
  if (
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    revision >= PROJECT_QUICK_ACCESS_MAX_REVISION ||
    !isProjectQuickAccessItems(candidateItems)
  ) {
    throw createInvalidProjectQuickAccessInputError()
  }

  return {
    items: candidateItems.map(({ projectId, teamId }) => ({ projectId, teamId })),
    revision,
  }
}

/** Creates the safe 400 response error for malformed quick-access input. */
function createInvalidProjectQuickAccessInputError() {
  return new ProjectDataError(
    400,
    'InvalidProjectQuickAccessInput',
    'Project quick-access input is invalid.',
  )
}

/**
 * Lists active Team/Project identities visible to the current principal.
 *
 * @param principal - Authenticated Workspace principal.
 * @returns Composite keys permitted in the viewer preference.
 */
async function getAuthorizedProjectQuickAccessKeys(
  principal: ProjectPrincipal,
) {
  const [directory, directProjectAccesses] = await Promise.all([
    workspaceDependencies.projectDirectory.getProjectDirectory(
      principal.directoryId,
      'ja',
      true,
    ),
    principal.isSystemAdmin || principal.enterpriseLegacyProjectAccessSuppressed
      ? Promise.resolve([])
      : workspaceDependencies.projectDirectory.getProjectAccessList(
          principal.directoryId,
          principal.userKey,
        ),
  ])
  const readableProjectAccesses = principal.isSystemAdmin
    ? undefined
    : [...directProjectAccesses, ...(principal.enterpriseProjectAccesses ?? [])]
      .filter((access) => projectAccessAllows(access, 'viewer'))
  const projectTeamCounts = new Map<string, number>()
  for (const team of directory.teams) {
    for (const project of team.projects) {
      projectTeamCounts.set(
        project.id,
        (projectTeamCounts.get(project.id) ?? 0) + 1,
      )
    }
  }

  return new Set(directory.teams.flatMap((team) =>
    team.projects.flatMap((project) =>
      readableProjectAccesses === undefined || readableProjectAccesses.some((access) =>
        access.projectId === project.id &&
        (
          access.teamId === team.id ||
          access.teamId === undefined && projectTeamCounts.get(project.id) === 1
        )
      )
        ? [createProjectQuickAccessIdentity({ projectId: project.id, teamId: team.id })]
        : [],
    )
  ))
}

/**
 * Creates the Work Item activity response with its Web-compatible actor identifier.
 *
 * @param page - Permission-filtered audit event page.
 * @returns Activity page retaining the shared actor snapshot and stable actorUserId.
 */
function toWorkItemActivityPageView(page: AuditEventPage) {
  return {
    events: page.events.map((event) => {
      const view = toAuditEventView(event)
      const actorMemberKey = event.metadata?.actorMemberKey
      const metadata = {
        ...view.metadata,
        actorKind: view.actor.kind,
        systemChange: view.actor.kind === 'system' || view.source === 'system',
      }
      return {
        ...view,
        actorUserId: typeof actorMemberKey === 'string' && actorMemberKey.trim()
          ? actorMemberKey
          : view.actor.id,
        metadata,
      }
    }),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  }
}

function readCognitoUsersInput(c: Context, directoryId?: string): ListCognitoUsersInput {
  const limit = Number(c.req.query('limit') ?? 20)

  return {
    directoryId,
    paginationToken: c.req.query('paginationToken') ?? c.req.query('nextToken') ?? undefined,
    limit,
    query: c.req.query('query')?.trim() || undefined,
  }
}

/**
 * Strongly reads the deterministic Form Triage Entry paired with a Request submission.
 *
 * Every submission commits this entry in its creation transaction, the entry stays in the
 * submission's routing Team, and retention redacts entries instead of deleting them. A
 * missing entry is therefore a data-integrity failure rather than a fallback case.
 *
 * @param workspaceId - Owning Workspace identifier.
 * @param submission - Strongly read Request submission that owns the entry.
 * @returns The canonical entry used to build the combined Request and Triage transaction.
 * @throws RequestIntakeError when the paired Triage Entry is missing.
 */
async function readRequestTriageEntry(
  workspaceId: string,
  submission: RequestSubmission,
): Promise<TriageEntry> {
  try {
    return await workItemDependencies.triage.getEntryForMutation(
      workspaceId,
      submission.routingTarget.teamId,
      createFormTriageEntryId(submission.id),
    )
  } catch (error) {
    if (error instanceof TriageError && error.status === 404) {
      throw new RequestIntakeError(
        503,
        'RequestTriageEntryMissing',
        'Stored request Triage entry is missing.',
        { cause: error },
      )
    }
    throw error
  }
}

/** Atomic Triage contribution paired with one non-conversion Request action. */
type RequestActionTriageContribution =
  | {
      /** Indicates that the combined mutation was already committed. */
      replayed: true
    }
  | {
      /** Indicates that the caller must execute the returned contribution. */
      replayed: false
      /** Revision-fenced Triage writes appended to the Request transaction. */
      contribution: TriageTransactionContribution
    }

/**
 * Maps one non-conversion Request action to the canonical Form Triage state atomically.
 *
 * @param context - Current Request action context and idempotency header.
 * @param principal - Authenticated Workspace administrator.
 * @param submission - Strongly read Request submission.
 * @param entry - Strongly read deterministic Form Triage entry.
 * @param input - Non-conversion Request action submitted through the Request route.
 * @returns A replay marker or unexecuted Triage transaction contribution.
 */
async function createRequestActionTriageContribution(
  context: Context,
  principal: WorkspacePrincipal,
  submission: RequestSubmission,
  entry: TriageEntry,
  input: Exclude<RequestSubmissionActionInput, { action: 'convert' }>,
): Promise<RequestActionTriageContribution> {
  let action: TriageActionInput
  let duplicateContext: TriageDuplicateContextTransactionContribution | undefined
  let duplicateMergedAt: string | undefined
  let duplicateCanonicalTeamId: string | undefined
  let duplicateCanonicalWorkItemTypeId: string | undefined
  if (input.action === 'assign') {
    action = {
      action: 'assign',
      expectedRevision: entry.revision,
      ownerUserId: input.assigneeUserId,
    }
  } else if (input.action === 'request-more-info') {
    action = {
      action: 'request-information',
      expectedRevision: entry.revision,
      message: input.message,
    }
  } else if (input.action === 'reject') {
    action = {
      action: 'decline',
      expectedRevision: entry.revision,
      reason: input.reason,
    }
  } else {
    const duplicateTarget = await workItemDependencies.requestIntake.getSubmission(
      principal.directoryId,
      input.duplicateOfSubmissionId,
    )
    if (!duplicateTarget.workItem || duplicateTarget.workItem.teamId !== entry.teamId) {
      throw new RequestIntakeError(
        409,
        'RequestDuplicateCanonicalWorkItemRequired',
        'A Triage-backed duplicate must target a converted Request in the same Team.',
      )
    }
    const { detail } = await loadAuthorizedTeamIssue(
      principal,
      duplicateTarget.workItem.teamId,
      duplicateTarget.workItem.workItemId,
      'member',
    )
    duplicateCanonicalTeamId = detail.issue.teamId
    duplicateCanonicalWorkItemTypeId = detail.issue.workItemTypeId
    action = {
      action: 'duplicate',
      expectedRevision: entry.revision,
      canonicalWorkItemId: duplicateTarget.workItem.workItemId,
    }
    const mergedAt = new Date().toISOString()
    duplicateMergedAt = mergedAt
    duplicateContext = workItemDependencies.teamIssues
      .createTriageDuplicateContextTransactionItems?.({
        directoryId: principal.directoryId,
        teamId: detail.issue.teamId,
        workItemId: detail.issue.id,
        expectedWorkItemRevision: detail.issue.revision,
        actorUserId: principal.userKey,
        entry,
        mergedAt,
      })
    if (!duplicateContext) {
      throw new RequestIntakeError(
        503,
        'RequestDuplicateContextUnavailable',
        'Duplicate context preservation is unavailable.',
      )
    }
  }
  const idempotency: TriageIdempotency = {
    key: context.req.header('Idempotency-Key')?.trim() ||
      `request-action:${submission.id}:${input.action}:${input.expectedRevision}`,
    fingerprint: createTriageInputFingerprint({
      workspaceId: principal.directoryId,
      actorId: principal.userKey,
      teamId: entry.teamId,
      entryId: entry.id,
      requestAction: input,
    }),
  }
  const replay = await workItemDependencies.triage.getActionReceipt(
    principal.directoryId,
    entry.teamId,
    entry.id,
    idempotency,
  )
  if (replay) return { replayed: true }
  const tableName = getEnv('REQUEST_INTAKE_TABLE_NAME') ?? 'mukuroji-request-intake-local'
  if (action.action === 'duplicate') {
    const completedAt = duplicateMergedAt ?? new Date().toISOString()
    const triage = createTriageAcceptanceTransactionItems({
      tableName,
      entry,
      action,
      canonicalWorkItem: {
        teamId: duplicateCanonicalTeamId ?? entry.teamId,
        workItemId: action.canonicalWorkItemId,
        ...(duplicateCanonicalWorkItemTypeId
          ? { workItemTypeId: duplicateCanonicalWorkItemTypeId }
          : {}),
      },
      actorId: principal.userKey,
      now: completedAt,
      idempotency,
      mergeReceipt: {
        canonicalWorkItemId: action.canonicalWorkItemId,
        mergedSourceCount: 1,
        mergedCommentCount: duplicateContext?.snapshot.commentMetadataCount ?? 0,
        mergedAttachmentCount: duplicateContext?.snapshot.attachmentMetadataCount ?? 0,
        mergedWatcherCount: duplicateContext?.snapshot.watcherMetadataCount ?? 0,
        completedAt,
      },
    })
    return {
      replayed: false,
      contribution: {
        entry: triage.entry,
        transactItems: [...(duplicateContext?.transactItems ?? []), ...triage.transactItems],
      },
    }
  }
  const entryForAction = action.action === 'request-information'
    ? {
        ...entry,
        sourcePreview: {
          ...entry.sourcePreview,
          commentCount: entry.sourcePreview.commentCount + 1,
        },
      }
    : entry
  const contribution = createTriageActionTransactionItems({
    tableName,
    audit: {
      tableName: getConfiguredAuditTableName() ?? 'mukuroji-audit-events',
      retentionDays: getConfiguredAuditRetentionDays(),
    },
    entry: entryForAction,
    action,
    actorId: principal.userKey,
    now: new Date().toISOString(),
    idempotency,
    auditContext: createApiMutationContext(
      context,
      principal,
      input,
      createTriageActionAuditIdempotencyKey(entry.id, idempotency),
    ),
  })
  const referenceChecks = action.action === 'assign'
    ? await createTriageActionReferenceConditionChecks(
        principal.directoryId,
        entry.teamId,
        entry,
        action,
      )
    : []
  return {
    replayed: false,
    contribution: {
      entry: contribution.entry,
      transactItems: [...referenceChecks, ...contribution.transactItems],
    },
  }
}

/**
 * Creates a retention-safe Request conversion input without reading source answers.
 *
 * Routing metadata and explicit operator overrides remain available, but mapped title,
 * description, and custom fields cannot be copied after the source retention boundary.
 *
 * @param submission - Stored Request submission whose answers must be isolated.
 * @param overrides - Validated conversion options supplied by the operator.
 * @returns A Work Item input derived without retained source answers.
 */
function createRetentionSafeRequestWorkItemInput(
  submission: RequestSubmission,
  overrides: Extract<RequestSubmissionActionInput, { action: 'convert' }>,
) {
  return createRequestWorkItemInput(
    { ...submission, answers: {} },
    {
      ...overrides,
      title: overrides.title?.trim() || 'Retained source',
    },
  )
}

/**
 * Re-evaluates schedule permissions independently of the root route resource.
 *
 * @remarks
 * A schedule dependency graph may cross Team and Project boundaries. Enterprise route
 * authorization is intentionally bound to the root Work Item, so graph evaluation must derive a
 * separate principal from the authentication-time authoritative snapshot before checking each
 * server-owned endpoint.
 *
 * @param principal - Authenticated Workspace principal for the root schedule route.
 * @param minimumRole - Schedule permission required on every evaluated endpoint.
 * @returns Principal restricted to every currently authorized Team and Project for that permission.
 */
async function createWorkItemScheduleScopedPrincipal(
  principal: WorkspacePrincipal,
  minimumRole: Extract<ProjectRole, 'viewer' | 'member'>,
): Promise<WorkspacePrincipal> {
  const evaluation = principal.enterpriseAuthorizationEvaluation
  if (!evaluation || principal.isSystemAdmin) return principal

  const permission: EnterprisePermissionId = minimumRole === 'viewer'
    ? 'work-items.read'
    : 'work-items.write'
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(
    principal.directoryId,
    'ja',
  )
  const evaluateResource = (resource: EnterpriseAuthorizationResource) =>
    evaluateEnterpriseAccess({
      permission,
      principal: evaluation.principal,
      assignments: evaluation.assignments,
      customRoles: evaluation.snapshot.customRoles,
      groupMappings: evaluation.groupMappings,
      resource,
    }).allowed
  const enterpriseProjectAccesses: ProjectAccessEntry[] = []
  const enterpriseAuthorizedTeamIds: string[] = []
  const enterpriseTeamAccesses: EnterpriseTeamAccess[] = []

  for (const team of directory.teams) {
    if (evaluateResource({
      workspaceId: principal.directoryId,
      kind: 'team',
      targetId: team.id,
    })) {
      enterpriseAuthorizedTeamIds.push(team.id)
      enterpriseTeamAccesses.push({ teamId: team.id, permissions: [permission] })
    }
    for (const project of team.projects) {
      if (!evaluateResource({
        workspaceId: principal.directoryId,
        kind: 'project',
        targetId: project.id,
        parentTeamId: team.id,
      })) {
        continue
      }
      enterpriseProjectAccesses.push({
        projectId: project.id,
        teamId: team.id,
        role: minimumRole,
      })
    }
  }

  return {
    ...principal,
    enterpriseProjectAccesses,
    enterpriseAuthorizedTeamIds,
    enterpriseTeamAccesses,
    enterpriseRouteAuthorizedAtResource: false,
  }
}

/**
 * Reads the strict optional archived Work Item collection flag.
 *
 * @param value - Untrusted query value.
 * @returns Whether archived Work Items should be included; omitted values default to false.
 */
function readOptionalIncludeArchivedQuery(value: string | undefined) {
  if (value === undefined || value === 'false') return false
  if (value === 'true') return true
  throw new ProjectDataError(
    400,
    'InvalidWorkItemQuery',
    'includeArchived must be "true" or "false".',
  )
}

/** Reads an optional stable Work Item Type query filter. */
function readOptionalWorkItemTypeIdQuery(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/iu.test(value.trim())) {
    throw new ProjectDataError(
      400,
      'InvalidWorkItemQuery',
      'workItemTypeId is invalid.',
    )
  }
  return value.trim()
}

/** Reads the Team-qualified Work Item Type filter accepted by Project aggregates. */
function readOptionalProjectWorkItemTypeIdQuery(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const normalized = value.trim()
  const keyParts = readSearchWorkItemTypeKey(normalized)
  if (
    !keyParts ||
    !/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/iu.test(keyParts.workItemTypeId)
  ) {
    throw new ProjectDataError(
      400,
      'InvalidWorkItemQuery',
      'Project workItemTypeId must be a Team-qualified Work Item Type key.',
    )
  }
  return normalized
}

/** Reads the required stable Work Item Type identifier from a type-change preview request. */
function readRequiredWorkItemTypeId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/iu.test(value.trim())
  ) {
    throw new WorkItemConfigurationError(
      400,
      'InvalidWorkItemType',
      'targetWorkItemTypeId is invalid.',
    )
  }
  return value.trim()
}

async function authorizeRelationMutation(
  principal: WorkspacePrincipal,
  teamId: string,
  sourceWorkItemId: string,
  targetWorkItemId: string,
) {
  const context = await requireTeamPermission(principal, teamId, 'member')
  const [source, target] = await Promise.all([
    workItemDependencies.teamIssues.getTeamIssueDetail(principal.directoryId, teamId, sourceWorkItemId, {
      consistentIssueRead: true,
      includeEvents: false,
    }),
    workItemDependencies.teamIssues.getTeamIssueDetail(principal.directoryId, teamId, targetWorkItemId, {
      consistentIssueRead: true,
      includeEvents: false,
    }),
  ])
  requireAssignedProjectPermission(principal, context, source.issue.assignedProjectId, 'member')
  requireAssignedProjectPermission(principal, context, target.issue.assignedProjectId, 'member')
  return { source: source.issue, target: target.issue }
}

/** Relation target のみを入力順を保った bounded concurrency で取得します。 */
async function readRelationTargets(
  principal: WorkspacePrincipal,
  teamId: string,
  targetWorkItemIds: readonly string[],
) {
  const targets: Array<readonly [string, TeamIssueResponseItem]> = []

  for (
    let offset = 0;
    offset < targetWorkItemIds.length;
    offset += WORK_ITEM_RELATION_TARGET_READ_CONCURRENCY
  ) {
    const batch = targetWorkItemIds.slice(
      offset,
      offset + WORK_ITEM_RELATION_TARGET_READ_CONCURRENCY,
    )
    const batchTargets = await Promise.all(batch.map(async (targetWorkItemId) => {
      try {
        const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
          principal.directoryId,
          teamId,
          targetWorkItemId,
          { consistentIssueRead: true, includeEvents: false },
        )
        return [targetWorkItemId, detail.issue] as const
      } catch (error) {
        if (isTeamIssueNotFoundError(error)) {
          throw new WorkItemConfigurationError(
            503,
            'WorkItemRelationInconsistent',
            'A relation target Work Item is missing.',
          )
        }
        throw error
      }
    }))
    targets.push(...batchTargets)
  }

  return targets
}

async function filterVisibleWorkItemRelations(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
  teamId: string,
  relations: readonly WorkItemRelation[],
) {
  if (relations.length === 0) {
    return []
  }

  const targetWorkItemIds = [...new Set(
    relations.map((relation) => relation.targetWorkItemId),
  )]
  const targets = await readRelationTargets(principal, teamId, targetWorkItemIds)
  const workItemsById = new Map(targets)

  return relations.filter((relation) => {
    const target = workItemsById.get(relation.targetWorkItemId)
    if (!target) {
      throw new WorkItemConfigurationError(
        503,
        'WorkItemRelationInconsistent',
        'A relation target Work Item is missing.',
      )
    }
    return canAccessAssignedProject(
      principal,
      context,
      target.assignedProjectId,
      'viewer',
    )
  })
}

/** Maximum dependency endpoints that leave room for archive, audit, and Planning actions. */
const PROJECT_ARCHIVE_DEPENDENCY_ENDPOINT_LIMIT = 96

/**
 * Verifies that a Team owns no active Planning scope or dependency endpoint.
 *
 * @param directoryId - Workspace whose Planning graph is checked.
 * @param teamId - Team being archived.
 * @returns Planning revision that must still hold in the archive transaction.
 */
async function requirePlanningTeamScopeIsUnused(directoryId: string, teamId: string) {
  const authorizationState = await workItemDependencies.planning.getAuthorizationState(directoryId)
  const scopedEntity = authorizationState.entities.find((entity) =>
    !entity.archivedAt && entity.teamId === teamId
  )
  const scopedLink = authorizationState.workItemLinks.find((link) => link.teamId === teamId)
  const scopedDependency = authorizationState.workItemDependencies.find((dependency) =>
    dependency.predecessor.teamId === teamId || dependency.successor.teamId === teamId
  )
  if (scopedEntity || scopedLink || scopedDependency) {
    throw new WorkspaceAccessError(
      409,
      'PlanningTeamScopeInUse',
      'Move or archive active Planning entities and remove Work Item links and dependencies before archiving this Team.',
    )
  }
  return authorizationState.revision
}

/**
 * Verifies that a Project owns no active Planning scope or dependency endpoint assignment.
 *
 * The returned Work Item revisions close the race between the canonical assignment reads and
 * the directory archive transaction. Planning's global revision separately serializes graph
 * mutations with the archive.
 *
 * @param directoryId - Workspace whose Planning graph and Work Items are checked.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project being archived.
 * @returns Planning and canonical Work Item revisions required by the archive transaction.
 */
async function requirePlanningProjectScopeIsUnused(
  directoryId: string,
  teamId: string,
  projectId: string,
) {
  const authorizationState = await workItemDependencies.planning.getAuthorizationState(directoryId)
  const scopedEntity = authorizationState.entities.find(
    (entity) =>
      !entity.archivedAt && entity.teamId === teamId && entity.projectId === projectId,
  )
  const scopedLink = authorizationState.workItemLinks.find(
    (link) => link.teamId === teamId && link.projectId === projectId,
  )
  if (scopedEntity || scopedLink) {
    throw new WorkspaceAccessError(
      409,
      'PlanningProjectScopeInUse',
      'Move or archive active Planning entities and remove Work Item links before archiving this Project.',
    )
  }

  const endpointByKey = new Map<string, { teamId: string; workItemId: string }>()
  for (const dependency of authorizationState.workItemDependencies) {
    for (const endpoint of [dependency.predecessor, dependency.successor]) {
      if (endpoint.teamId !== teamId) continue
      endpointByKey.set(createWorkItemDependencyKey(endpoint), endpoint)
    }
  }
  const endpoints = [...endpointByKey.values()].sort((left, right) =>
    createWorkItemDependencyKey(left).localeCompare(createWorkItemDependencyKey(right))
  )
  if (endpoints.length > PROJECT_ARCHIVE_DEPENDENCY_ENDPOINT_LIMIT) {
    throw new WorkspaceAccessError(
      413,
      'PlanningProjectScopeDependencyLimitExceeded',
      'The Project has too many dependency endpoints to archive atomically.',
    )
  }

  const workItemRevisionGuards: ProjectArchiveWorkItemRevisionGuard[] = await Promise.all(
    endpoints.map(async (endpoint) => {
      let detail: TeamIssueDetailResponse
      try {
        detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
          directoryId,
          endpoint.teamId,
          endpoint.workItemId,
          { consistentIssueRead: true, includeEvents: false },
        )
      } catch (error) {
        if (!isTeamIssueNotFoundError(error)) throw error
        throw new WorkspaceAccessError(
          409,
          'PlanningProjectScopeInUse',
          'Remove unresolved Work Item dependencies before archiving this Project.',
        )
      }
      if (detail.issue.assignedProjectId === projectId) {
        throw new WorkspaceAccessError(
          409,
          'PlanningProjectScopeInUse',
          'Move dependency Work Items to another Project or remove their dependencies before archiving this Project.',
        )
      }
      return {
        teamId: endpoint.teamId,
        workItemId: endpoint.workItemId,
        expectedRevision: detail.issue.revision,
      }
    }),
  )
  return {
    expectedPlanningRevision: authorizationState.revision,
    workItemRevisionGuards,
  }
}

/** Approval 作成後に削除・無効化された遷移先を decision conflict として扱います。 */
async function resolveFileApprovalCompletionTransitionForDecision(
  directoryId: string,
  teamId: string,
  workItem: ReturnType<typeof requireCanonicalFileProofingWorkItem>,
  completionTransition: string,
): Promise<FileApprovalCompletionTransition | undefined> {
  try {
    return await resolveFileApprovalCompletionTransition(
      directoryId,
      teamId,
      workItem,
      completionTransition,
    )
  } catch (error) {
    if (
      error instanceof FileProofingError &&
      (error.code === 'InvalidWorkflowStatus' || error.code === 'WorkflowTransitionDenied')
    ) {
      return undefined
    }
    throw error
  }
}

/**
 * Builds the permission flags returned with one curated-context page.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param context - Current Team and Project authorization snapshot.
 * @param issue - Current canonical Work Item snapshot.
 * @returns Server-derived curated-context capabilities.
 */
function createCuratedContextCapabilities(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
  issue: TeamIssueResponseItem,
): CuratedContextCapabilities {
  const canWrite = canWriteTeamIssue(principal, context, issue.assignedProjectId)
  const canAcceptResolution = principal.workspaceRole !== 'guest' && (
    canManageTeamIssueCollaboration(
      principal,
      context,
      issue.assignedProjectId,
    ) || issue.assigneeUserId === principal.userKey
  )
  return {
    canCreate: canWrite,
    canEdit: canWrite,
    canReplace: canWrite,
    // Root authors are added per thread by the Web UI and rechecked by the mutation.
    canAcceptResolution,
  }
}

/**
 * Reads and validates the create payload for one curated-context item.
 *
 * @param value - Untrusted JSON request body.
 * @returns Validated shared create request.
 */
function readCreateCuratedContextItemRequest(
  value: unknown,
): CreateCuratedContextItemRequest {
  if (!isRecord(value)) {
    throw invalidCuratedContextInput('Curated context request body must be an object.')
  }
  const mentionMemberKeys = Object.hasOwn(value, 'mentionMemberKeys')
    ? readCommentMentionMemberKeys(value.mentionMemberKeys)
    : undefined
  const source = value.source === undefined
    ? undefined
    : readCuratedContextSource(value.source)
  const supersedesItemId = value.supersedesItemId === undefined
    ? undefined
    : readCuratedContextIdentifier(value.supersedesItemId, 'Superseded context item ID')
  return {
    kind: readCuratedContextKind(value.kind),
    title: readCuratedContextText(
      value.title,
      'Curated context title',
      COLLABORATION_CONTEXT_TITLE_MAX_LENGTH,
    ),
    body: readCuratedContextText(
      value.body,
      'Curated context body',
      COLLABORATION_CONTEXT_BODY_MAX_LENGTH,
    ),
    ...(source ? { source } : {}),
    ...(mentionMemberKeys ? { mentionMemberKeys } : {}),
    ...(supersedesItemId ? { supersedesItemId } : {}),
  }
}

/**
 * Reads and validates a revision-fenced curated-context update payload.
 *
 * @param value - Untrusted JSON request body.
 * @returns Validated shared update request.
 */
function readUpdateCuratedContextItemRequest(
  value: unknown,
): UpdateCuratedContextItemRequest {
  if (!isRecord(value)) {
    throw invalidCuratedContextInput('Curated context request body must be an object.')
  }
  const hasKind = Object.hasOwn(value, 'kind')
  const hasState = Object.hasOwn(value, 'state')
  const hasTitle = Object.hasOwn(value, 'title')
  const hasBody = Object.hasOwn(value, 'body')
  const hasSource = Object.hasOwn(value, 'source')
  const hasMentions = Object.hasOwn(value, 'mentionMemberKeys')
  if (hasSource) {
    throw invalidCuratedContextInput(
      'Use atomic replacement to change curated context source evidence.',
    )
  }
  if (!hasKind && !hasState && !hasTitle && !hasBody && !hasMentions) {
    throw invalidCuratedContextInput('At least one curated context field must be updated.')
  }
  return {
    expectedRevision: readCuratedContextRevision(value.expectedRevision, 'Expected context revision'),
    ...(hasKind ? { kind: readCuratedContextKind(value.kind) } : {}),
    ...(hasState ? { state: readCuratedContextState(value.state) } : {}),
    ...(hasTitle
      ? {
          title: readCuratedContextText(
            value.title,
            'Curated context title',
            COLLABORATION_CONTEXT_TITLE_MAX_LENGTH,
          ),
        }
      : {}),
    ...(hasBody
      ? {
          body: readCuratedContextText(
            value.body,
            'Curated context body',
            COLLABORATION_CONTEXT_BODY_MAX_LENGTH,
          ),
        }
      : {}),
    ...(hasMentions
      ? { mentionMemberKeys: readCommentMentionMemberKeys(value.mentionMemberKeys) }
      : {}),
  }
}

/**
 * Parses provenance fields without trusting the client-provided source snapshot.
 *
 * @param value - Untrusted source payload.
 * @returns Structurally validated source locator and requested quote.
 */
function readCuratedContextSource(value: unknown): CuratedContextSource {
  if (!isRecord(value)) {
    throw invalidCuratedContextInput('Curated context source must be an object.')
  }
  const kind = readCuratedContextSourceKind(value.kind)
  const originalBody = value.originalBody === undefined
    ? undefined
    : readCuratedContextText(
        value.originalBody,
        'Curated source original body',
        COLLABORATION_CONTEXT_BODY_MAX_LENGTH,
      )
  const availabilityReason = value.availabilityReason === undefined
    ? undefined
    : readCuratedContextText(value.availabilityReason, 'Curated source availability reason', 1_000)
  return {
    kind,
    sourceId: readCuratedContextIdentifier(value.sourceId, 'Curated source ID'),
    ...(value.containerId === undefined
      ? {}
      : { containerId: readCuratedContextIdentifier(value.containerId, 'Curated source container ID') }),
    ...(originalBody ? { originalBody } : {}),
    ...(value.quote === undefined ? {} : { quote: readCuratedContextQuote(value.quote) }),
    ...(value.permalink === undefined
      ? {}
      : { permalink: readCuratedContextText(value.permalink, 'Curated source permalink', 2_000) }),
    ...(value.actor === undefined ? {} : { actor: readCuratedContextActorSnapshot(value.actor) }),
    occurredAt: readCuratedContextText(value.occurredAt, 'Curated source timestamp', 128),
    ...(value.capturedRevision === undefined
      ? {}
      : { capturedRevision: readCuratedContextSourceRevision(value.capturedRevision) }),
    ...(value.currentRevision === undefined
      ? {}
      : { currentRevision: readCuratedContextSourceRevision(value.currentRevision) }),
    availability: readCuratedContextAvailability(value.availability),
    ...(availabilityReason ? { availabilityReason } : {}),
  }
}

/** Permission-checked source snapshot plus any server-only transaction fence. */
type ResolvedCuratedContextSource = {
  /** Canonical provenance captured from the current source of truth. */
  source: CuratedContextSource
  /** Document authorization generations that must remain current at commit time. */
  documentAuthorizationSnapshot?: CuratedContextDocumentSourceAuthorizationSnapshot
  /** Activity retention deadline that must remain valid at commit time. */
  activityAuthorizationSnapshot?: CuratedContextActivitySourceAuthorizationSnapshot
}

/**
 * Resolves a client source locator to a server-owned provenance snapshot.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param teamId - Owning Team identifier.
 * @param issueId - Owning Work Item identifier.
 * @param entityKey - Canonical collaboration entity key.
 * @param requested - Validated but untrusted source locator.
 * @returns Permission-checked provenance captured from the current source of truth.
 */
async function resolveCuratedContextSource(
  principal: WorkspacePrincipal,
  teamId: string,
  issueId: string,
  entityKey: string,
  requested: CuratedContextSource,
): Promise<ResolvedCuratedContextSource> {
  if (requested.kind === 'external-chat') {
    throw new CollaborationError(
      503,
      'ExternalChatSourceUnavailable',
      'External chat source capture is unavailable until a permission-gated provider is configured.',
    )
  }

  if (requested.kind === 'comment') {
    const comment = await workItemDependencies.collaboration.getCommentSnapshot({
      entityKey,
      commentId: requested.sourceId,
    })
    if (!comment || comment.deletedAt) {
      throw new CollaborationError(
        409,
        'CuratedContextSourceUnavailable',
        'The selected comment is no longer available.',
      )
    }
    const originalBody = captureCuratedContextSourceBody(comment.bodyMarkdown)
    return {
      source: {
        kind: 'comment',
        sourceId: comment.id,
        containerId: comment.rootCommentId,
        originalBody,
        ...(requested.quote
          ? { quote: resolveCuratedContextQuote(comment.bodyMarkdown, originalBody, requested.quote) }
          : {}),
        permalink: `${createTeamIssueDeepLink(teamId, issueId)}` +
          `&commentId=${encodeURIComponent(comment.id)}` +
          `&rootCommentId=${encodeURIComponent(comment.rootCommentId)}`,
        actor: await resolveCuratedContextMemberActor(principal.directoryId, comment.authorMemberKey),
        occurredAt: comment.createdAt,
        capturedRevision: comment.version,
        currentRevision: comment.version,
        availability: 'available',
      },
    }
  }

  if (requested.kind === 'document') {
    const searchContext = await createWorkspaceSearchContext(principal)
    const authorizationRevisionBefore =
      await workItemDependencies.documents.getAuthorizationRevision(
        principal.directoryId,
      )
    const document = await workItemDependencies.documents.get({
        workspaceId: principal.directoryId,
        documentId: requested.sourceId,
        access: searchContext.documentAccess,
      }).catch((error: unknown) => {
      if (error instanceof DocumentError && (error.status === 403 || error.status === 404)) {
        throw new CollaborationError(
          404,
          'CuratedContextSourceUnavailable',
          'The selected document is not available to the current viewer.',
          { cause: error },
        )
      }
      throw error
    })
    const authorizationRevisionAfter =
      await workItemDependencies.documents.getAuthorizationRevision(
        principal.directoryId,
      )
    if (authorizationRevisionBefore !== authorizationRevisionAfter) {
      throw new CollaborationError(
        409,
        'CuratedContextSourceAuthorizationChanged',
        'Document authorization changed while reading the source. Reload and try again.',
      )
    }
    const fullBody = createDocumentWorkspaceSearchBody(document)
    const originalBody = captureCuratedContextSourceBody(fullBody)
    return {
      source: {
        kind: 'document',
        sourceId: document.id,
        containerId: document.id,
        ...(originalBody ? { originalBody } : {}),
        ...(requested.quote
          ? { quote: resolveCuratedContextQuote(fullBody, originalBody, requested.quote) }
          : {}),
        permalink: `/documents/${encodeURIComponent(document.id)}`,
        actor: await resolveCuratedContextMemberActor(
          principal.directoryId,
          document.updatedByUserId,
        ),
        occurredAt: document.updatedAt,
        capturedRevision: document.revision,
        currentRevision: document.revision,
        availability: 'available',
      },
      documentAuthorizationSnapshot: {
        sourceId: document.id,
        documentRevision: document.revision,
        documentAuthorizationRevision: authorizationRevisionAfter,
        ...(searchContext.documentAccess.authorizationSnapshots?.[0]?.workspaceMemberKey === undefined
          ? {}
          : {
              workspaceMemberKey:
                searchContext.documentAccess.authorizationSnapshots[0].workspaceMemberKey,
              workspaceMemberVersion:
                searchContext.documentAccess.authorizationSnapshots[0].workspaceMemberVersion,
            }),
        ...(searchContext.documentAccess.authorizationSnapshots?.[0]?.planningRevision === undefined
          ? {}
          : {
              planningRevision:
                searchContext.documentAccess.authorizationSnapshots[0].planningRevision,
            }),
        ...(searchContext.documentAccess.authorizationSnapshots?.[0]?.enterpriseControlRevision === undefined
          ? {}
          : {
              enterpriseControlRevision:
                searchContext.documentAccess.authorizationSnapshots[0].enterpriseControlRevision,
            }),
      },
    }
  }

  const event = await workspaceDependencies.auditEvents.getEvent(
    principal.directoryId,
    requested.sourceId,
  )
  if (
    !event ||
    isExpiredCuratedContextAuditEvent(event) ||
    event.entity.type !== 'work-item' ||
    event.entity.id !== createTeamIssueAuditEntityId(teamId, issueId)
  ) {
    throw new CollaborationError(
      404,
      'CuratedContextSourceNotFound',
      'The selected activity event was not found in this Work Item.',
    )
  }
  const eventBody = event.summary?.trim() || event.eventType
  const originalBody = captureCuratedContextSourceBody(eventBody)
  return {
    source: {
      kind: 'activity',
      sourceId: event.eventId,
      containerId: event.entity.id,
      originalBody,
      ...(requested.quote
        ? { quote: resolveCuratedContextQuote(eventBody, originalBody, requested.quote) }
        : {}),
      permalink: `${createTeamIssueDeepLink(teamId, issueId)}` +
        `&collaborationTab=activity&activityEventId=${encodeURIComponent(event.eventId)}`,
      actor: {
        id: event.actor.id,
        displayName: event.actor.displayName?.trim() || event.actor.id,
      },
      occurredAt: event.occurredAt,
      availability: 'available',
    },
    activityAuthorizationSnapshot: {
      sourceId: event.eventId,
      ...(event.expiresAt === undefined ? {} : { expiresAt: event.expiresAt }),
    },
  }
}

/**
 * Reconciles one mutation response through the same permission-safe source overlay as reads.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param teamId - Owning Team identifier.
 * @param issueId - Owning Work Item identifier.
 * @param entityKey - Canonical collaboration entity key.
 * @param item - Canonical item returned by the collaboration store.
 * @param initialAssignedProjectId - Project assignment observed before the mutation.
 * @param accessToken - Access token used to re-resolve Enterprise authorization before return.
 * @param context - Current route context used by the authentication refresh.
 * @returns A permission-safe item for the current viewer.
 */
async function requirePermissionSafeCuratedContextItem(
  principal: WorkspacePrincipal,
  teamId: string,
  issueId: string,
  entityKey: string,
  item: CuratedContextItem,
  initialAssignedProjectId: string | undefined,
  accessToken: string,
  context: Context,
): Promise<CuratedContextItem> {
  const currentPrincipal = await assertCuratedContextScopeUnchanged(
    principal,
    teamId,
    issueId,
    'member',
    initialAssignedProjectId,
    accessToken,
    context,
  )
  const [reconciled] = await reconcileCuratedContextSourcesForViewer(
    currentPrincipal,
    teamId,
    issueId,
    entityKey,
    [item],
  )
  if (!reconciled) {
    throw new CollaborationError(
      503,
      'InvalidCollaborationRecord',
      'Curated context response could not be reconciled.',
    )
  }
  await assertCuratedContextScopeUnchanged(
    currentPrincipal,
    teamId,
    issueId,
    'member',
    initialAssignedProjectId,
    accessToken,
    context,
  )
  return reconciled
}

/**
 * Reconciles page sources against current permission-aware source state in bounded batches.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param teamId - Owning Team identifier.
 * @param issueId - Owning Work Item identifier.
 * @param entityKey - Canonical collaboration entity key.
 * @param items - Captured curated-context snapshots.
 * @returns Items with current availability overlaid while retained provenance is preserved.
 */
async function reconcileCuratedContextSourcesForViewer(
  principal: WorkspacePrincipal,
  teamId: string,
  issueId: string,
  entityKey: string,
  items: CuratedContextItem[],
) {
  const containsDocumentSource = items.some((item) => item.source?.kind === 'document')
  const authorizationAttempts = containsDocumentSource ? 2 : 1
  for (let attempt = 0; attempt < authorizationAttempts; attempt += 1) {
    const searchContext = containsDocumentSource
      ? await createWorkspaceSearchContext(principal, {
          includeDocumentAuthorizationRevision: true,
        })
      : undefined
    const documentAccess = searchContext?.documentAccess
    const reconciled: CuratedContextItem[] = []
    const concurrency = 8
    for (let offset = 0; offset < items.length; offset += concurrency) {
      const page = items.slice(offset, offset + concurrency)
      reconciled.push(...await Promise.all(page.map((item) =>
        reconcileCuratedContextSourceForViewer(
          principal,
          teamId,
          issueId,
          entityKey,
          item,
          documentAccess,
        )
      )))
    }

    if (
      !searchContext ||
      await isWorkspaceSearchAuthorizationCurrent(
        principal.directoryId,
        searchContext.planningRevision,
        searchContext.documentAuthorizationRevision,
        searchContext.documentAccess,
      )
    ) {
      return reconciled
    }
  }

  throw new CollaborationError(
    409,
    'CuratedContextSourceAuthorizationChanged',
    'Document authorization changed while reading curated context sources. Reload and try again.',
  )
}

/**
 * Overlays one context item's current source availability without replacing captured evidence.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param teamId - Owning Team identifier.
 * @param issueId - Owning Work Item identifier.
 * @param entityKey - Canonical collaboration entity key.
 * @param item - Captured curated-context item.
 * @param documentAccess - Current viewer document authorization context when needed.
 * @returns Context item with a permission-safe current availability overlay.
 */
async function reconcileCuratedContextSourceForViewer(
  principal: WorkspacePrincipal,
  teamId: string,
  issueId: string,
  entityKey: string,
  item: CuratedContextItem,
  documentAccess: DocumentAccessContext | undefined,
): Promise<CuratedContextItem> {
  const source = item.source
  if (!source) return item

  if (source.kind === 'external-chat') {
    const retainedAvailability = source.availability === 'retention-expired' ||
      source.availability === 'deleted'
      ? source.availability
      : 'permission-lost'
    return {
      ...item,
      source: overlayCuratedContextSourceAvailability(
        source,
        retainedAvailability,
        source.currentRevision,
        retainedAvailability === 'permission-lost'
          ? 'Current external chat access cannot be verified because no permission-gated provider is configured.'
          : source.availabilityReason,
        true,
      ),
    }
  }

  if (source.kind === 'comment') {
    const comment = await workItemDependencies.collaboration.getCommentSnapshot({
      entityKey,
      commentId: source.sourceId,
    })
    if (!comment) {
      return {
        ...item,
        source: overlayCuratedContextSourceAvailability(
          source,
          'deleted',
          source.currentRevision,
          'The source comment is no longer present; captured provenance remains available.',
        ),
      }
    }
    if (comment.deletedAt) {
      return {
        ...item,
        source: overlayCuratedContextSourceAvailability(
          source,
          'deleted',
          comment.version,
          'The source comment was deleted after this provenance was captured.',
        ),
      }
    }
    const bodyWasEdited = source.originalBody === undefined
      ? !sourceRevisionMatches(source.capturedRevision, comment.version)
      : source.originalBody !== captureCuratedContextSourceBody(comment.bodyMarkdown)
    const availability = bodyWasEdited ? 'edited' : 'available'
    return {
      ...item,
      source: overlayCuratedContextSourceAvailability(
        source,
        availability,
        comment.version,
        availability === 'edited'
          ? 'The source comment was edited after this provenance was captured.'
          : undefined,
      ),
    }
  }

  if (source.kind === 'document') {
    if (!documentAccess) {
      return {
        ...item,
        source: overlayCuratedContextSourceAvailability(
          source,
          'permission-lost',
          source.currentRevision,
          'Current document access could not be verified.',
        ),
      }
    }
    try {
      const document = await workItemDependencies.documents.get({
        workspaceId: principal.directoryId,
        documentId: source.sourceId,
        access: documentAccess,
        includeArchived: true,
      })
      const availability = document.archivedAt
        ? 'deleted'
        : sourceRevisionMatches(source.capturedRevision, document.revision)
          ? 'available'
          : 'edited'
      return {
        ...item,
        source: overlayCuratedContextSourceAvailability(
          source,
          availability,
          document.revision,
          availability === 'deleted'
            ? 'The source document was archived after this provenance was captured.'
            : availability === 'edited'
              ? 'The source document changed after this provenance was captured.'
              : undefined,
        ),
      }
    } catch (error) {
      if (!(error instanceof DocumentError) || (error.status !== 403 && error.status !== 404)) {
        throw error
      }
      const availability = error.status === 403
        ? 'permission-lost'
        : isCuratedContextDocumentRetentionError(error)
          ? 'retention-expired'
          : 'deleted'
      return {
        ...item,
        source: overlayCuratedContextSourceAvailability(
          source,
          availability,
          source.currentRevision,
          availability === 'permission-lost'
            ? 'The current viewer no longer has permission to open the source document.'
            : availability === 'retention-expired'
              ? 'The source document is no longer available under its retention policy.'
              : 'The source document was deleted or archived after this provenance was captured.',
          true,
        ),
      }
    }
  }

  const event = await workspaceDependencies.auditEvents.getEvent(
    principal.directoryId,
    source.sourceId,
  )
  const expectedEntityId = createTeamIssueAuditEntityId(teamId, issueId)
  if (!event) {
    return {
      ...item,
      source: overlayCuratedContextSourceAvailability(
        source,
        'retention-expired',
        source.currentRevision,
        'The source activity event is no longer available under audit retention.',
        true,
      ),
    }
  }
  if (isExpiredCuratedContextAuditEvent(event)) {
    return {
      ...item,
      source: overlayCuratedContextSourceAvailability(
        source,
        'retention-expired',
        source.currentRevision,
        'The source activity event is no longer available under audit retention.',
        true,
      ),
    }
  }
  if (event.entity.type !== 'work-item' || event.entity.id !== expectedEntityId) {
    return {
      ...item,
      source: overlayCuratedContextSourceAvailability(
        source,
        'deleted',
        source.currentRevision,
        'The source activity event no longer belongs to this Work Item.',
      ),
    }
  }
  return {
    ...item,
    source: overlayCuratedContextSourceAvailability(
      source,
      'available',
      source.currentRevision,
      undefined,
    ),
  }
}

/**
 * Treats an audit row as unavailable as soon as its retention TTL is reached.
 *
 * DynamoDB may retain expired rows briefly after their TTL, so callers must not
 * rely on physical deletion to enforce the audit retention boundary.
 *
 * @param event - Audit event returned by the strongly scoped store read.
 * @param nowEpochSeconds - Current epoch seconds used for deterministic tests.
 * @returns Whether the audit event is outside its retention window.
 */
function isExpiredCuratedContextAuditEvent(
  event: { /** DynamoDB TTL epoch seconds. */ expiresAt?: number },
  nowEpochSeconds = Math.floor(Date.now() / 1_000),
) {
  return event.expiresAt !== undefined && event.expiresAt <= nowEpochSeconds
}

/**
 * Applies current availability fields while preserving every captured provenance field.
 *
 * @param source - Captured provenance snapshot.
 * @param availability - Current permission-aware availability.
 * @param currentRevision - Latest observed source-native revision.
 * @param reason - Safe explanation for an edited or unavailable source.
 * @param redactSensitive - Whether source text and navigation must be omitted even when the availability label is retained.
 * @returns Provenance with current availability overlaid.
 */
function overlayCuratedContextSourceAvailability(
  source: CuratedContextSource,
  availability: CuratedContextSource['availability'],
  currentRevision: CuratedContextSource['currentRevision'],
  reason: string | undefined,
  redactSensitive = availability === 'permission-lost',
): CuratedContextSource {
  const overlaid: CuratedContextSource = {
    ...source,
    availability,
    ...(currentRevision === undefined ? {} : { currentRevision }),
    ...(reason ? { availabilityReason: reason } : {}),
  }
  if (!redactSensitive) return overlaid
  return {
    kind: overlaid.kind,
    sourceId: overlaid.sourceId,
    ...(overlaid.containerId ? { containerId: overlaid.containerId } : {}),
    ...(overlaid.actor ? { actor: overlaid.actor } : {}),
    occurredAt: overlaid.occurredAt,
    ...(overlaid.capturedRevision === undefined
      ? {}
      : { capturedRevision: overlaid.capturedRevision }),
    ...(overlaid.currentRevision === undefined
      ? {}
      : { currentRevision: overlaid.currentRevision }),
    availability: overlaid.availability,
    ...(reason ? { availabilityReason: reason } : {}),
  }
}

/**
 * Compares source-native revisions without conflating absent and zero revisions.
 *
 * @param captured - Revision retained at capture time.
 * @param current - Latest observed revision.
 * @returns Whether both revisions represent the same source snapshot.
 */
function sourceRevisionMatches(
  captured: CuratedContextSource['capturedRevision'],
  current: string | number,
) {
  return captured !== undefined && String(captured) === String(current)
}

/**
 * Resolves one retained member identity without requiring the member to remain active.
 *
 * @param workspaceId - Canonical Workspace identifier.
 * @param memberKey - Stable Workspace member key.
 * @returns Display-safe actor snapshot.
 */
async function resolveCuratedContextMemberActor(
  workspaceId: string,
  memberKey: string,
): Promise<CuratedContextActorSnapshot> {
  const member = await workspaceDependencies.workspaceAccess.getActiveMember(workspaceId, memberKey)
  return {
    id: memberKey,
    displayName: member?.name?.trim() || member?.email || memberKey,
  }
}

/**
 * Retains a bounded original source body inside one DynamoDB context snapshot.
 *
 * @param body - Current permission-checked source text.
 * @returns Bounded captured source text.
 */
function captureCuratedContextSourceBody(body: string) {
  const bounded = body.slice(0, COLLABORATION_CONTEXT_BODY_MAX_LENGTH)
  const lastCodeUnit = bounded.charCodeAt(bounded.length - 1)
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff
    ? bounded.slice(0, -1)
    : bounded
}

/** Stable Documents error codes that indicate a retention boundary. */
const curatedContextDocumentRetentionErrorCodes = new Set([
  'DocumentRetentionExpired',
  'DocumentVersionRetentionExpired',
])

/**
 * Distinguishes a retention-specific Documents failure from a deleted/missing source.
 *
 * @param error - Documents error returned while rehydrating a source.
 * @returns Whether the error is an explicit retention failure.
 */
function isCuratedContextDocumentRetentionError(error: DocumentError): boolean {
  return curatedContextDocumentRetentionErrorCodes.has(error.code)
}

/**
 * Verifies a requested quote against current source text and derives retained offsets.
 *
 * @param fullBody - Full current source body used for validation.
 * @param capturedBody - Bounded body retained in the provenance snapshot.
 * @param requested - Client-selected quote and optional range.
 * @returns Server-verified quote snapshot.
 */
function resolveCuratedContextQuote(
  fullBody: string,
  capturedBody: string,
  requested: CuratedContextQuote,
): CuratedContextQuote {
  const hintedStart = 'startOffset' in requested ? requested.startOffset : undefined
  const hintedEnd = 'endOffset' in requested ? requested.endOffset : undefined
  const hintedRangeMatches = hintedStart !== undefined &&
    hintedEnd !== undefined &&
    Number.isSafeInteger(hintedStart) &&
    Number.isSafeInteger(hintedEnd) &&
    hintedStart >= 0 &&
    hintedEnd === hintedStart + requested.text.length &&
    fullBody.slice(hintedStart, hintedEnd) === requested.text
  let startOffset: number
  if (hintedRangeMatches && hintedStart !== undefined) {
    startOffset = hintedStart
  } else {
    startOffset = fullBody.indexOf(requested.text)
    if (startOffset >= 0 && fullBody.indexOf(requested.text, startOffset + 1) >= 0) {
      throw invalidCuratedContextInput(
        'Curated source quote occurs multiple times; select an exact range.',
      )
    }
  }
  if (startOffset < 0) {
    throw invalidCuratedContextInput('Curated source quote no longer matches the source.')
  }
  const endOffset = startOffset + requested.text.length
  if (endOffset > capturedBody.length) {
    throw invalidCuratedContextInput('Curated source quote is outside the retained source range.')
  }
  return {
    text: requested.text,
    startOffset,
    endOffset,
  }
}

/**
 * Reads a provenance quote from an untrusted JSON object.
 *
 * @param value - Untrusted quote payload.
 * @returns Validated quote payload.
 */
function readCuratedContextQuote(value: unknown): CuratedContextQuote {
  if (!isRecord(value)) {
    throw invalidCuratedContextInput('Curated source quote must be an object.')
  }
  const startOffset = readOptionalCuratedContextOffset(value.startOffset, 'Quote start offset')
  const endOffset = readOptionalCuratedContextOffset(value.endOffset, 'Quote end offset')
  if ((startOffset === undefined) !== (endOffset === undefined)) {
    throw invalidCuratedContextInput(
      'Quote start and end offsets must be provided together.',
    )
  }
  return {
    text: readCuratedContextQuoteText(
      value.text,
      'Curated source quote',
      COLLABORATION_CONTEXT_BODY_MAX_LENGTH,
    ),
    ...(startOffset === undefined || endOffset === undefined
      ? {}
      : { startOffset, endOffset }),
  }
}

/**
 * Validates quote text without normalizing its whitespace.
 *
 * @param value - Untrusted quote text.
 * @param label - Safe validation label.
 * @param maximumLength - Maximum UTF-16 length.
 * @returns Exact quote text selected by the curator.
 */
function readCuratedContextQuoteText(
  value: unknown,
  label: string,
  maximumLength: number,
) {
  if (typeof value !== 'string') {
    throw invalidCuratedContextInput(`${label} must be text.`)
  }
  if (!value || value.length > maximumLength || hasCuratedContextUnsafeControlCharacters(value)) {
    throw invalidCuratedContextInput(`${label} is empty or too long.`)
  }
  return value
}

/**
 * Detects non-printing control characters that cannot be retained in a quote.
 *
 * @param value - Candidate quote text.
 * @returns Whether the text contains a disallowed control character.
 */
function hasCuratedContextUnsafeControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    ) {
      return true
    }
  }
  return false
}

/**
 * Reads a display-safe actor snapshot from an untrusted source payload.
 *
 * @param value - Untrusted actor payload.
 * @returns Validated actor snapshot.
 */
function readCuratedContextActorSnapshot(value: unknown): CuratedContextActorSnapshot {
  if (!isRecord(value)) {
    throw invalidCuratedContextInput('Curated source actor must be an object.')
  }
  return {
    id: readCuratedContextIdentifier(value.id, 'Curated source actor ID'),
    displayName: readCuratedContextText(value.displayName, 'Curated source actor name', 500),
    ...(value.avatarUrl === undefined
      ? {}
      : { avatarUrl: readCuratedContextText(value.avatarUrl, 'Curated source actor avatar', 2_000) }),
  }
}

/**
 * Reads one optional non-negative quote offset.
 *
 * @param value - Untrusted offset.
 * @param label - Safe validation label.
 * @returns Validated offset or undefined.
 */
function readOptionalCuratedContextOffset(value: unknown, label: string) {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidCuratedContextInput(`${label} is invalid.`)
  }
  return value
}

/**
 * Reads a curated-context semantic kind.
 *
 * @param value - Untrusted kind.
 * @returns Validated kind.
 */
function readCuratedContextKind(value: unknown) {
  if (value === 'decision' || value === 'action' || value === 'risk' || value === 'context') {
    return value
  }
  throw invalidCuratedContextInput('Curated context kind is invalid.')
}

/**
 * Reads a curated-context lifecycle state.
 *
 * @param value - Untrusted state.
 * @returns Validated state.
 */
function readCuratedContextState(value: unknown) {
  if (value === 'active' || value === 'accepted' || value === 'completed') {
    return value
  }
  throw invalidCuratedContextInput('Curated context state is invalid.')
}

/**
 * Reads a curated-context source kind.
 *
 * @param value - Untrusted kind.
 * @returns Validated source kind.
 */
function readCuratedContextSourceKind(value: unknown) {
  if (value === 'comment' || value === 'external-chat' || value === 'document' || value === 'activity') {
    return value
  }
  throw invalidCuratedContextInput('Curated context source kind is invalid.')
}

/**
 * Reads a source availability state.
 *
 * @param value - Untrusted availability.
 * @returns Validated source availability.
 */
function readCuratedContextAvailability(value: unknown) {
  if (
    value === 'available' ||
    value === 'edited' ||
    value === 'deleted' ||
    value === 'permission-lost' ||
    value === 'retention-expired'
  ) {
    return value
  }
  throw invalidCuratedContextInput('Curated source availability is invalid.')
}

/**
 * Reads a string or positive integer source-native revision.
 *
 * @param value - Untrusted source revision.
 * @returns Validated source-native revision.
 */
function readCuratedContextSourceRevision(value: unknown) {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  throw invalidCuratedContextInput('Curated source revision is invalid.')
}

/** HTTP response shape of one canonical collaboration comment. */
type CollaborationCommentResponse = ReturnType<typeof toCollaborationCommentResponse>

/**
 * Enforces the serialized comment budget shared by collaboration page responses.
 *
 * @param comments - Projected comments that would be returned by the endpoint.
 */
function enforceCollaborationCommentResponseBudget(
  comments: readonly CollaborationCommentResponse[],
): void {
  let bytesRead = 2
  for (const comment of comments) {
    const commentBytes = Buffer.byteLength(JSON.stringify(comment), 'utf8') + 1
    if (bytesRead + commentBytes > COLLABORATION_COMMENT_RESPONSE_MAX_BYTES) {
      throw new CollaborationError(
        413,
        'CollaborationThreadPayloadTooLarge',
        'Collaboration comments exceed the supported response size.',
      )
    }
    bytesRead += commentBytes
  }
}

async function hydrateProjectMembersResponse(
  response: ProjectMembersResponse,
  directoryId: string,
) {
  const members = await Promise.all(
    response.members.map(async (member) => hydrateProjectMember(member, directoryId)),
  )

  return {
    ...response,
    members,
  } satisfies ProjectMembersResponse
}

async function hydrateProjectMemberUpdateResponse(
  response: UpdateProjectMemberResponse,
  directoryId: string,
) {
  return {
    member: await hydrateProjectMember(response.member, directoryId),
  } satisfies UpdateProjectMemberResponse
}

async function hydrateProjectMember(member: ProjectMemberResponseItem, directoryId: string) {
  const workspaceMember = await workspaceDependencies.workspaceAccess.getMember(directoryId, member.id)

  try {
    const profile = await authenticationDependencies.cognito.getUserProfile(member.id)

    return {
      ...member,
      id: profile.id,
      email: profile.email,
      username: profile.username,
      name: profile.name,
      enabled: profile.enabled,
      status: profile.status,
      workspaceStatus: workspaceMember?.status ?? 'deactivated',
    } satisfies ProjectMemberResponseItem
  } catch (error) {
    if (isCognitoUserNotFoundError(error)) {
      return {
        ...member,
        workspaceStatus: workspaceMember?.status ?? 'deactivated',
      }
    }

    console.warn('Failed to hydrate project member from Cognito:', error)
    return {
      ...member,
      workspaceStatus: workspaceMember?.status ?? 'deactivated',
    }
  }
}

async function listActiveWorkspaceCognitoUsers(directoryId: string, c: Context) {
  const input = readCognitoUsersInput(c, directoryId)
  const limit = clampCognitoPageLimit(input.limit)
  const activeMemberKeys = new Set(
    (await workspaceDependencies.workspaceAccess.listActiveMembers(directoryId)).map((member) => member.memberKey),
  )
  const users: CognitoUserProfile[] = []
  let paginationToken = input.paginationToken

  do {
    const response = await authenticationDependencies.cognito.listUsers({
      ...input,
      limit: Math.max(1, limit - users.length),
      paginationToken,
    })

    users.push(
      ...response.users
        .filter((user) => activeMemberKeys.has(user.id))
        .map((user) => ({ ...user, workspaceStatus: 'active' as const })),
    )
    paginationToken = response.nextToken
  } while (users.length < limit && paginationToken)

  return {
    users,
    nextToken: paginationToken,
  } satisfies CognitoUsersResponse
}

async function hydrateTeamIssuesResponse(response: TeamIssuesResponse) {
  const profiles = await readIssueAssigneeProfiles(response.issues)

  return {
    ...response,
    issues: response.issues.map((issue) => hydrateTeamIssue(issue, profiles)),
  } satisfies TeamIssuesResponse
}

async function hydrateProjectIssuesResponse(response: ProjectIssuesResponse) {
  const profiles = await readIssueAssigneeProfiles(response.issues)

  return {
    ...response,
    issues: response.issues.map((issue) => hydrateTeamIssue(issue, profiles)),
  } satisfies ProjectIssuesResponse
}

async function hydrateWorkItemsResponse(response: WorkItemsResponse, directoryId: string) {
  const profiles = await readIssueAssigneeProfiles(response.workItems)
  const hydratedItems = response.workItems.map((workItem) => hydrateTeamIssue(workItem, profiles))
  const scopes = hydratedItems.map((workItem) => ({
    workspaceId: directoryId,
    teamId: workItem.teamId,
    kind: 'work-item' as const,
    issueId: workItem.id,
  }))
  const summaries = scopes.length > 0 &&
    (getEnv('FILE_PROOFING_TABLE_NAME') || getConfiguredDynamoDbEndpoint())
    ? await workItemDependencies.fileProofing.getApprovalSummaries(scopes)
    : new Map<string, ApprovalSummary>()
  const workItems = hydratedItems.map((workItem) => {
    const summary = summaries.get(createFileProofingScopeKey({
      workspaceId: directoryId,
      teamId: workItem.teamId,
      kind: 'work-item',
      issueId: workItem.id,
    }))
    return summary && hasApprovalSummaryContent(summary)
      ? { ...workItem, approvalSummary: summary }
      : workItem
  })

  return {
    workItems,
  } satisfies WorkItemsResponse
}

function createTeamSearchDocument(
  workspaceId: string,
  team: ProjectDirectoryTeamResponse,
  creatorUserId?: string,
  subtitle?: string,
) {
  return createTeamWorkspaceSearchDocument({
    workspaceId,
    teamId: team.id,
    title: team.name,
    ...(subtitle ? { subtitle } : {}),
    ...(creatorUserId ? { creatorUserId } : {}),
  })
}

/** Mutation 後の Work Item と relation graph を強整合 read して search へ反映します。 */
async function refreshWorkItemSearchDocumentBestEffort(
  workspaceId: string,
  teamId: string,
  issueId: string,
  operation: string,
) {
  if (!isWorkspaceSearchProjectionEnabled()) return
  try {
    const [detail, relationPage] = await Promise.all([
      workItemDependencies.teamIssues.getTeamIssueDetail(workspaceId, teamId, issueId, {
        consistentIssueRead: true,
        includeEvents: false,
      }),
      workItemDependencies.workItemConfigurations.listRelations(workspaceId, teamId, issueId),
    ])
    await workItemDependencies.workspaceSearch.upsertDocument(createWorkItemSearchDocument(
      workspaceId,
      detail.issue,
      createWorkItemRelationIds(relationPage.relations, issueId),
    ))
  } catch (error) {
    console.error(`Workspace search projection failed after ${operation}.`, error)
  }
}

async function hydrateTeamIssueDetailResponse(
  response: TeamIssueDetailResponse,
  directoryId: string,
) {
  const profiles = await readIssueAssigneeProfiles([response.issue])
  const issue = hydrateTeamIssue(response.issue, profiles)
  const approvalSummary = await readWorkItemApprovalSummary(directoryId, issue)

  return {
    ...response,
    issue: approvalSummary ? { ...issue, approvalSummary } : issue,
  } satisfies TeamIssueDetailResponse
}

async function readWorkItemApprovalSummary(directoryId: string, workItem: TeamIssueResponseItem) {
  if (!getEnv('FILE_PROOFING_TABLE_NAME') && !getConfiguredDynamoDbEndpoint()) {
    return undefined
  }
  const summary = await workItemDependencies.fileProofing.getApprovalSummary({
    workspaceId: directoryId,
    teamId: workItem.teamId,
    kind: 'work-item',
    issueId: workItem.id,
  })
  return hasApprovalSummaryContent(summary) ? summary : undefined
}

async function hydrateCreateTeamIssueResponse(response: CreateTeamIssueResponse) {
  const profiles = await readIssueAssigneeProfiles([response.issue])

  return {
    issue: hydrateTeamIssue(response.issue, profiles),
  } satisfies CreateTeamIssueResponse
}

async function hydrateUpdateTeamIssueResponse(response: UpdateTeamIssueResponse) {
  const profiles = await readIssueAssigneeProfiles([response.issue])

  return {
    issue: hydrateTeamIssue(response.issue, profiles),
  } satisfies UpdateTeamIssueResponse
}

async function readTeamIssues(
  directoryId: string,
  context: TeamPermissionContext,
  principal: ProjectPrincipal,
  includeArchived = false,
  workItemTypeId?: string,
) {
  const storedIssues = await workItemDependencies.teamIssues.getTeamIssues(
    directoryId,
    context.team.id,
    { includeArchived, ...(workItemTypeId ? { workItemTypeId } : {}) },
  )

  return {
    teamId: context.team.id,
    issues: filterAccessibleTeamIssues(storedIssues.issues, principal, context),
  } satisfies TeamIssuesResponse
}

/**
 * Recomputes one schedule preview from stable Planning data and strongly read endpoint schedules.
 *
 * The unfiltered Planning authorization graph is used only to fail closed when any root-reachable
 * successor or incoming bound predecessor is outside the principal's visible Work Item state.
 * No hidden endpoint identity is returned in that failure.
 *
 * @param principal - Authenticated Workspace principal.
 * @param rootWorkItem - Strongly read direct Work Item.
 * @param operation - Validated direct schedule operation.
 * @param relationGraphRevision - Separately observed semantic relation graph revision.
 * @param semanticBlockerCount - Visible semantic blocker count used only for warnings.
 * @param endpointRole - Minimum role required on every evaluated endpoint.
 * @param expectedPlanningRevision - Optional preview revision required by confirmation.
 * @returns Server-authoritative preview plus every revision participating in recomputation.
 */
async function recomputeWorkItemScheduleDependencyPreview(
  principal: WorkspacePrincipal,
  rootWorkItem: TeamIssueResponseItem,
  operation: WorkItemScheduleOperation,
  relationGraphRevision: number,
  semanticBlockerCount: number,
  endpointRole: Extract<ProjectRole, 'viewer' | 'member'>,
  expectedPlanningRevision?: number,
) {
  const scopedPrincipal = await createWorkItemScheduleScopedPrincipal(principal, endpointRole)
  const planning = await readStableWorkItemSchedulePlanningSnapshot(scopedPrincipal)
  if (
    expectedPlanningRevision !== undefined &&
    planning.authorizationState.revision !== expectedPlanningRevision
  ) {
    throw new ProjectDataError(
      409,
      'PlanningRevisionConflict',
      'Planning changed. Reload and try again.',
    )
  }
  const rootEndpoint = {
    teamId: rootWorkItem.teamId,
    workItemId: rootWorkItem.id,
  } satisfies WorkItemDependencyEndpoint
  const dependencies = planning.authorizationState.workItemDependencies
  if (dependencies === undefined) {
    throw new WorkItemScheduleError(
      503,
      'WorkItemScheduleDependencyStateUnavailable',
      'Work Item dependency state is unavailable for schedule evaluation.',
    )
  }
  const evaluationEndpoints = collectWorkItemScheduleEvaluationEndpoints(
    rootEndpoint,
    dependencies,
  )
  const accessibleKeys = new Set(planning.workItemState.workItems.map((workItem) =>
    createWorkItemDependencyKey({ teamId: workItem.teamId, workItemId: workItem.id })
  ))
  accessibleKeys.add(createWorkItemDependencyKey(rootEndpoint))
  if (evaluationEndpoints.some((endpoint) =>
    !accessibleKeys.has(createWorkItemDependencyKey(endpoint))
  )) {
    throw new ProjectDataError(
      403,
      'WorkItemScheduleDependencyAccessDenied',
      'Schedule dependency impact cannot be evaluated within the current access scope.',
    )
  }
  if (evaluationEndpoints.length > WORK_ITEM_SCHEDULE_CASCADE_LIMIT) {
    throw new WorkItemScheduleError(
      413,
      'WorkItemScheduleCascadeLimitExceeded',
      `A schedule cascade cannot evaluate more than ${WORK_ITEM_SCHEDULE_CASCADE_LIMIT} Work Items.`,
    )
  }
  const rootKey = createWorkItemDependencyKey(rootEndpoint)
  const states = await Promise.all(evaluationEndpoints.map(async (endpoint) => {
    const key = createWorkItemDependencyKey(endpoint)
    const issue = key === rootKey
      ? rootWorkItem
      : (await requirePlanningWorkItemEndpointPermission(
          scopedPrincipal,
          endpoint,
          endpointRole,
        )).detail.issue
    if (issue.archivedAt) {
      throw new ProjectDataError(
        409,
        'PlanningWorkItemArchived',
        'Archived Work Items cannot participate in schedule dependency changes.',
      )
    }
    const milestoneIds = [...new Set(planning.snapshot.workItemLinks.flatMap((link) =>
      link.teamId === endpoint.teamId &&
        link.workItemId === endpoint.workItemId &&
        link.milestoneId
        ? [link.milestoneId]
        : []
    ))].sort()
    return {
      endpoint,
      revision: issue.revision,
      schedule: issue.schedule,
      ...(issue.assignedProjectId ? { projectId: issue.assignedProjectId } : {}),
      milestoneIds,
    } satisfies WorkItemDependencyScheduleState
  }))
  const root = states.find((state) => createWorkItemDependencyKey(state.endpoint) === rootKey)
  if (!root) {
    throw new ProjectDataError(
      403,
      'WorkItemScheduleDependencyAccessDenied',
      'Schedule dependency impact cannot be evaluated within the current access scope.',
    )
  }
  return {
    preview: previewWorkItemDependencyScheduleChange({
      root,
      operation,
      workItems: states,
      dependencies,
      planningRevision: planning.authorizationState.revision,
      relationGraphRevision,
      semanticBlockerCount,
    }),
    states,
  }
}

/**
 * Reads matching filtered and unfiltered Planning views at one global revision.
 *
 * @param principal - Authenticated Workspace principal.
 * @returns Stable visible Work Item state, filtered snapshot, and unfiltered authorization state.
 */
async function readStableWorkItemSchedulePlanningSnapshot(
  principal: WorkspacePrincipal,
) {
  for (
    let attempt = 0;
    attempt < WORK_ITEM_SCHEDULE_SNAPSHOT_RETRY_LIMIT;
    attempt += 1
  ) {
    const authorizationState = await workItemDependencies.planning.getAuthorizationState(
      principal.directoryId,
    )
    const workItemState = await readPlanningWorkItemState(principal)
    const snapshot = filterPlanningSnapshotForPrincipal(
      principal,
      await workItemDependencies.planning.get(principal.directoryId, workItemState),
    )
    const finalRevision = await workItemDependencies.planning.getAuthorizationRevision(
      principal.directoryId,
    )
    if (
      authorizationState.revision === snapshot.revision &&
      snapshot.revision === finalRevision
    ) {
      return { authorizationState, workItemState, snapshot }
    }
  }
  throw new ProjectDataError(
    409,
    'PlanningRevisionConflict',
    'Planning changed. Reload and try again.',
  )
}

/**
 * Reads a non-negative graph revision from an untrusted confirmation request.
 *
 * @param value - Candidate revision.
 * @param label - Human-readable graph kind.
 * @returns Validated non-negative safe integer.
 */
function readWorkItemScheduleGraphRevision(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new WorkItemScheduleError(
      400,
      'InvalidWorkItemScheduleConfirmation',
      `${label} is required.`,
    )
  }
  return value
}

/**
 * Reads and canonicalizes the complete Work Item revision snapshot returned by preview.
 *
 * @param value - Candidate revision snapshot from a confirmation request.
 * @returns Qualified revisions in deterministic endpoint order.
 */
function readWorkItemScheduleEvaluationRevisions(
  value: unknown,
): WorkItemScheduleEvaluationRevision[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > WORK_ITEM_SCHEDULE_CASCADE_LIMIT
  ) {
    throw new WorkItemScheduleError(
      400,
      'InvalidWorkItemScheduleConfirmation',
      'Expected evaluated Work Item revisions are required.',
    )
  }
  const revisions = value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.teamId !== 'string' ||
      !entry.teamId.trim() ||
      typeof entry.workItemId !== 'string' ||
      !entry.workItemId.trim() ||
      typeof entry.expectedRevision !== 'number' ||
      !Number.isSafeInteger(entry.expectedRevision) ||
      entry.expectedRevision < 1
    ) {
      throw new WorkItemScheduleError(
        400,
        'InvalidWorkItemScheduleConfirmation',
        'Every evaluated Work Item revision must contain a Team ID, Work Item ID, and positive revision.',
      )
    }
    return {
      teamId: entry.teamId.trim(),
      workItemId: entry.workItemId.trim(),
      expectedRevision: entry.expectedRevision,
    } satisfies WorkItemScheduleEvaluationRevision
  }).sort(compareWorkItemScheduleEvaluationRevisions)
  const keys = revisions.map((revision) => createWorkItemDependencyKey(revision))
  if (new Set(keys).size !== keys.length) {
    throw new WorkItemScheduleError(
      400,
      'InvalidWorkItemScheduleConfirmation',
      'Expected evaluated Work Item revisions must identify distinct Work Items.',
    )
  }
  return revisions
}

/**
 * Reads and canonicalizes the exact impact list returned by a schedule preview.
 *
 * @param value - Candidate impacts copied into a confirmation request.
 * @returns Canonical impacts in the preview's deterministic order.
 */
function readWorkItemScheduleImpacts(value: unknown): WorkItemScheduleImpact[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > WORK_ITEM_SCHEDULE_CASCADE_LIMIT
  ) {
    throw new WorkItemScheduleError(
      400,
      'InvalidWorkItemScheduleConfirmation',
      'Expected schedule preview impacts are required.',
    )
  }
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.teamId !== 'string' ||
      !entry.teamId.trim() ||
      typeof entry.workItemId !== 'string' ||
      !entry.workItemId.trim() ||
      (entry.kind !== 'direct' && entry.kind !== 'dependency') ||
      typeof entry.expectedRevision !== 'number' ||
      !Number.isSafeInteger(entry.expectedRevision) ||
      entry.expectedRevision < 1 ||
      typeof entry.dateDeltaDays !== 'number' ||
      !Number.isSafeInteger(entry.dateDeltaDays) ||
      (entry.dependencyId !== undefined &&
        (typeof entry.dependencyId !== 'string' || !entry.dependencyId.trim()))
    ) {
      throw new WorkItemScheduleError(
        400,
        'InvalidWorkItemScheduleConfirmation',
        'Every expected schedule impact must match the preview impact contract.',
      )
    }
    try {
      return {
        teamId: entry.teamId.trim(),
        workItemId: entry.workItemId.trim(),
        kind: entry.kind,
        expectedRevision: entry.expectedRevision,
        before: normalizeWorkItemSchedule(entry.before),
        after: normalizeWorkItemSchedule(entry.after),
        dateDeltaDays: entry.dateDeltaDays,
        ...(entry.dependencyId === undefined
          ? {}
          : { dependencyId: entry.dependencyId.trim() }),
      } satisfies WorkItemScheduleImpact
    } catch (error) {
      if (error instanceof WorkItemScheduleError) {
        throw new WorkItemScheduleError(
          400,
          'InvalidWorkItemScheduleConfirmation',
          'Expected schedule preview impacts contain an invalid schedule.',
        )
      }
      throw error
    }
  })
}

/**
 * Validates the required user-provided key for one schedule confirmation.
 *
 * @param value - Raw `Idempotency-Key` header value.
 * @returns A trimmed key safe for the Developer Platform idempotency port.
 */
function readRequiredWorkItemScheduleIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? ''
  const hasControlCharacter = [...key].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
  })
  if (!key || key.length > 256 || hasControlCharacter) {
    throw new WorkItemScheduleError(
      400,
      'InvalidWorkItemScheduleIdempotencyKey',
      'Idempotency-Key must contain 1 to 256 characters without control characters.',
    )
  }
  return key
}

/**
 * Binds a schedule confirmation key to its exact HTTP method, path, and JSON body.
 *
 * @param method - Incoming HTTP method.
 * @param path - Canonical request path.
 * @param body - Parsed confirmation body.
 * @returns Stable SHA-256 request fingerprint.
 */
function createWorkItemScheduleConfirmationFingerprint(
  method: string,
  path: string,
  body: unknown,
): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()}\n${path}\n${stableDigestStringify(body)}`)
    .digest('hex')
}

/**
 * Reserves a schedule confirmation and maps persistence failures to its stable API contract.
 *
 * @param request - User-scoped idempotency reservation identity.
 * @returns Reservation, in-progress, or completed replay decision.
 */
async function reserveWorkItemScheduleConfirmation(request: ReserveIdempotencyRequest) {
  try {
    return await developerPlatformDependencies.idempotency.reserveIdempotency(request)
  } catch (error) {
    if (error instanceof DeveloperPlatformError && error.code === 'IdempotencyKeyConflict') {
      throw new WorkItemScheduleError(
        409,
        'WorkItemScheduleIdempotencyConflict',
        'Idempotency-Key was already used for a different schedule confirmation.',
      )
    }
    throw new WorkItemScheduleError(
      503,
      'WorkItemScheduleIdempotencyUnavailable',
      'Schedule confirmation idempotency is unavailable.',
    )
  }
}

/**
 * Adapts the Work Item schedule confirmation use case to authenticated API dependencies.
 *
 * @param c - Current Hono request context used only for replay metadata and audit context.
 * @param principal - Authenticated Workspace principal.
 * @param context - Authorized Team and Project access snapshot for the root Work Item.
 * @param body - Parsed request body recorded in the immutable audit context.
 * @param command - Fully validated application command.
 * @returns Compact schedules committed or replayed by the confirmation use case.
 */
async function executeConfirmedWorkItemScheduleChange(
  c: Context,
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
  body: Readonly<Record<string, unknown>>,
  command: ConfirmWorkItemScheduleChangeCommand,
) {
  return confirmWorkItemScheduleChange(command, {
    reserve: reserveWorkItemScheduleConfirmation,
    release: (request) =>
      developerPlatformDependencies.idempotency.releaseIdempotency(request),
    async replay(value, replayCommand) {
      const replay = readStoredWorkItemScheduleConfirmationResponse(
        value,
        replayCommand.teamId,
        replayCommand.workItemId,
      )
      await requireWorkItemScheduleConfirmationReplayAuthorization(
        principal,
        replay.authorizationEndpoints,
      )
      c.header('Idempotency-Replayed', 'true')
      return replay.response
    },
    async recompute(recomputeCommand) {
      const [detail, relationPage] = await Promise.all([
        workItemDependencies.teamIssues.getTeamIssueDetail(
          principal.directoryId,
          recomputeCommand.teamId,
          recomputeCommand.workItemId,
          { consistentIssueRead: true, includeEvents: false },
        ),
        workItemDependencies.workItemConfigurations.listRelations(
          principal.directoryId,
          recomputeCommand.teamId,
          recomputeCommand.workItemId,
        ),
      ])
      requireAssignedProjectPermission(
        principal,
        context,
        detail.issue.assignedProjectId,
        'member',
      )
      if (relationPage.graphRevision !== recomputeCommand.expectedRelationGraphRevision) {
        throw new ProjectDataError(
          409,
          'WorkItemRelationGraphConflict',
          'Work Item relations changed. Reload and try again.',
        )
      }
      const visibleRelations = await filterVisibleWorkItemRelations(
        principal,
        context,
        recomputeCommand.teamId,
        relationPage.relations,
      )
      const recomputed = await recomputeWorkItemScheduleDependencyPreview(
        principal,
        detail.issue,
        recomputeCommand.operation,
        relationPage.graphRevision,
        visibleRelations.filter((relation) =>
          relation.sourceWorkItemId === recomputeCommand.workItemId &&
          (relation.type === 'blocks' || relation.type === 'blockedBy')
        ).length,
        'member',
        recomputeCommand.expectedPlanningRevision,
      )
      return recomputed.preview
    },
    async persist(input) {
      const updateSchedules = workItemDependencies.teamIssues.updateTeamIssueSchedules
      if (!updateSchedules) {
        throw new ProjectDataError(
          503,
          'WorkItemScheduleCascadeUnavailable',
          'Atomic schedule cascade persistence is not configured.',
        )
      }
      const idempotencyTransaction =
        createWorkItemScheduleConfirmationIdempotencyTransaction(
          input.reservation.workspaceId,
          input.reservation,
          input.authorizationEndpoints,
        )
      if (!idempotencyTransaction) {
        throw new WorkItemScheduleError(
          503,
          'WorkItemScheduleIdempotencyUnavailable',
          'Durable schedule confirmation receipts are not configured.',
        )
      }
      const result = await updateSchedules.call(
        workItemDependencies.teamIssues,
        principal.directoryId,
        input.updates,
        input.guardedRevisions,
        principal.userKey,
        createApiMutationContext(c, principal, {
          teamId: command.teamId,
          issueId: command.workItemId,
          ...body,
        }),
        [createWorkItemRelationGraphRevisionConditionCheck(
          getWorkItemConfigurationTableName(),
          principal.directoryId,
          command.teamId,
          input.expectedRelationGraphRevision,
        )],
        createWorkItemAuthorizationSnapshot(
          principal,
          input.expectedPlanningRevision,
        ),
        idempotencyTransaction,
      )
      await Promise.all(result.issues.map((issue) =>
        projectWorkItemMutationSearchDocumentBestEffort(
          principal.directoryId,
          issue,
          'Work Item schedule dependency cascade',
        )
      ))
      return { workItems: result.confirmedSchedules }
    },
  })
}

/** Creates the stable failure used when a durable schedule replay receipt is malformed. */
function invalidStoredWorkItemScheduleConfirmationResponse(): WorkItemScheduleError {
  return new WorkItemScheduleError(
    503,
    'InvalidStoredWorkItemScheduleConfirmationResponse',
    'The stored schedule confirmation response is invalid.',
  )
}

/** Validated compact schedule replay receipt and its current-authorization fence. */
type StoredWorkItemScheduleConfirmation = {
  /** Exact public response committed by the original confirmation. */
  response: ConfirmWorkItemScheduleChangeResponse
  /** Every server-derived Work Item endpoint that influenced the original confirmation. */
  authorizationEndpoints: WorkItemScheduleEvaluationRevision[]
}

/**
 * Revalidates one compact schedule result stored in an encrypted replay receipt.
 *
 * @param value - Candidate compact result.
 * @returns Exact validated schedule result.
 */
function readStoredWorkItemScheduleConfirmationWorkItem(
  value: unknown,
): ConfirmedWorkItemSchedule {
  if (!isRecord(value)) {
    throw invalidStoredWorkItemScheduleConfirmationResponse()
  }
  try {
    const id = readPlanningIdentifier(value.id, 'Stored Work Item ID')
    const teamId = readPlanningIdentifier(value.teamId, 'Stored Team ID')
    const revision = readWorkItemExpectedRevision(value.revision)
    const schedule = normalizeWorkItemSchedule(value.schedule)
    const dueDate = typeof value.dueDate === 'string' ? value.dueDate : ''
    const assignedProjectId = value.assignedProjectId === undefined
      ? undefined
      : readPlanningIdentifier(value.assignedProjectId, 'Stored Project ID')
    const item: ConfirmedWorkItemSchedule = {
      id,
      teamId,
      revision,
      schedule,
      dueDate,
      ...(assignedProjectId ? { assignedProjectId } : {}),
    }
    if (stableDigestStringify(item) !== stableDigestStringify(value)) {
      throw invalidStoredWorkItemScheduleConfirmationResponse()
    }
    if (dueDate !== deriveWorkItemScheduleDueDate(schedule)) {
      throw invalidStoredWorkItemScheduleConfirmationResponse()
    }
    return item
  } catch (error) {
    if (
      error instanceof WorkItemScheduleError &&
      error.code === 'InvalidStoredWorkItemScheduleConfirmationResponse'
    ) {
      throw error
    }
    throw invalidStoredWorkItemScheduleConfirmationResponse()
  }
}

/**
 * Reads and cross-checks the exact response committed with a schedule cascade.
 *
 * @param value - Candidate Developer Platform replay payload.
 * @param rootTeamId - Team from the replay request path.
 * @param rootWorkItemId - Work Item from the replay request path.
 * @returns Exact successful response body and every endpoint that must be reauthorized.
 */
function readStoredWorkItemScheduleConfirmationResponse(
  value: unknown,
  rootTeamId: string,
  rootWorkItemId: string,
): StoredWorkItemScheduleConfirmation {
  if (!isRecord(value) || value.status !== 200 || !isRecord(value.body)) {
    throw invalidStoredWorkItemScheduleConfirmationResponse()
  }
  if (
    !Array.isArray(value.body.workItems) ||
    value.body.workItems.length === 0 ||
    value.body.workItems.length > WORK_ITEM_SCHEDULE_CASCADE_LIMIT
  ) {
    throw invalidStoredWorkItemScheduleConfirmationResponse()
  }
  const workItems = value.body.workItems.map((item) =>
    readStoredWorkItemScheduleConfirmationWorkItem(item)
  )
  let authorizationEndpoints: WorkItemScheduleEvaluationRevision[]
  try {
    authorizationEndpoints = readWorkItemScheduleEvaluationRevisions(
      value.body.authorizationEndpoints,
    )
  } catch {
    throw invalidStoredWorkItemScheduleConfirmationResponse()
  }
  const response: ConfirmWorkItemScheduleChangeResponse = { workItems }
  const endpointKeys = workItems.map((item) => createWorkItemDependencyKey({
    teamId: item.teamId,
    workItemId: item.id,
  }))
  const authorizationRevisions = new Map(authorizationEndpoints.map((endpoint) => [
    createWorkItemDependencyKey(endpoint),
    endpoint.expectedRevision,
  ]))
  const root = workItems[0]
  if (
    root?.teamId !== rootTeamId ||
    root.id !== rootWorkItemId ||
    new Set(endpointKeys).size !== endpointKeys.length ||
    workItems.some((item) =>
      authorizationRevisions.get(createWorkItemDependencyKey({
        teamId: item.teamId,
        workItemId: item.id,
      })) !== item.revision - 1
    ) ||
    stableDigestStringify({
      status: 200,
      body: { workItems, authorizationEndpoints },
    }) !== stableDigestStringify(value)
  ) {
    throw invalidStoredWorkItemScheduleConfirmationResponse()
  }
  return { response, authorizationEndpoints }
}

/**
 * Re-evaluates current write access for every endpoint contained in a replay receipt.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param authorizationEndpoints - Validated endpoints that influenced the stored confirmation.
 */
async function requireWorkItemScheduleConfirmationReplayAuthorization(
  principal: WorkspacePrincipal,
  authorizationEndpoints: readonly WorkItemScheduleEvaluationRevision[],
): Promise<void> {
  const scopedPrincipal = await createWorkItemScheduleScopedPrincipal(principal, 'member')
  for (const endpoint of authorizationEndpoints) {
    await requirePlanningWorkItemEndpointPermission(scopedPrincipal, {
      teamId: endpoint.teamId,
      workItemId: endpoint.workItemId,
    }, 'member')
  }
}

/**
 * Orders evaluated Work Item revisions by their qualified endpoint key.
 *
 * @param left - Left revision.
 * @param right - Right revision.
 * @returns Locale comparison result for deterministic ordering.
 */
function compareWorkItemScheduleEvaluationRevisions(
  left: WorkItemScheduleEvaluationRevision,
  right: WorkItemScheduleEvaluationRevision,
) {
  return createWorkItemDependencyKey(left).localeCompare(createWorkItemDependencyKey(right))
}

async function readProjectIssues(
  directoryId: string,
  projectId: string,
  includeArchived = false,
  workItemTypeId?: string,
) {
  return workItemDependencies.teamIssues.getProjectIssues(
    directoryId,
    projectId,
    { includeArchived, ...(workItemTypeId ? { workItemTypeId } : {}) },
  )
}

async function readIssueAssigneeProfiles(issues: TeamIssueResponseItem[]) {
  const profiles = new Map<string, CognitoUserProfile>()
  const userIds = new Set(issues.map((issue) => issue.assigneeUserId).filter(isDefined))

  await Promise.all(
    Array.from(userIds).map(async (userId) => {
      try {
        profiles.set(userId, await authenticationDependencies.cognito.getUserProfile(userId))
      } catch (error) {
        if (!isCognitoUserNotFoundError(error)) {
          console.warn('Failed to hydrate issue assignee from Cognito:', error)
        }
      }
    }),
  )

  return profiles
}

function hydrateTeamIssue(
  issue: TeamIssueResponseItem,
  profiles: Map<string, CognitoUserProfile>,
) {
  if (!issue.assigneeUserId) {
    return issue
  }

  const profile = profiles.get(issue.assigneeUserId)

  if (!profile) {
    return issue
  }

  return {
    ...issue,
    assigneeEmail: profile.email,
    assigneeName: profile.name,
  } satisfies TeamIssueResponseItem
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function readNonNegativeRevision(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new WorkItemConfigurationError(
      400,
      'InvalidWorkItemRelationRevision',
      `${label} must be a non-negative integer.`,
    )
  }
  return value as number
}

function readCreatableWorkItemRelationType(value: unknown): WorkItemRelationType {
  if (value === 'parent' || value === 'blocks' || value === 'related' || value === 'duplicate') {
    return value
  }
  throw new WorkItemConfigurationError(
    400,
    'InvalidWorkItemRelation',
    'Relation type must be parent, blocks, related, or duplicate.',
  )
}

function readWorkItemRelationType(value: unknown): WorkItemRelationType {
  if (
    value === 'parent' ||
    value === 'child' ||
    value === 'blocks' ||
    value === 'blockedBy' ||
    value === 'related' ||
    value === 'duplicate'
  ) {
    return value
  }
  throw new WorkItemConfigurationError(
    400,
    'InvalidWorkItemRelation',
    'Relation type is invalid.',
  )
}

/**
 * Validates and canonicalizes explicit Request conversion custom-field overrides.
 *
 * @param value - Untrusted custom-field override map from the Request action body.
 * @returns A bounded map with normalized field identifiers and JSON-compatible values.
 */
function normalizeRequestConversionCustomFieldValues(
  value: unknown,
): Record<string, CustomFieldValue | null> {
  if (!isRecord(value)) {
    throw new RequestIntakeError(
      400,
      'InvalidRequestIntakeInput',
      'Request conversion custom field values are invalid.',
    )
  }
  const entries = Object.entries(value)
  if (entries.length > 100) {
    throw new RequestIntakeError(
      400,
      'InvalidRequestIntakeInput',
      'Request conversion custom field values are limited to 100 entries.',
    )
  }
  const normalized: Record<string, CustomFieldValue | null> = {}
  for (const [fieldId, fieldValue] of entries) {
    const normalizedFieldId = fieldId.trim()
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/iu.test(normalizedFieldId)) {
      throw new RequestIntakeError(
        400,
        'InvalidRequestIntakeInput',
        'Request conversion custom field ID is invalid.',
      )
    }
    if (fieldValue === null) {
      normalized[normalizedFieldId] = null
    } else if (typeof fieldValue === 'string') {
      if (fieldValue.length > 10_000) {
        throw new RequestIntakeError(
          400,
          'InvalidRequestIntakeInput',
          'Request conversion custom field value is too long.',
        )
      }
      normalized[normalizedFieldId] = fieldValue
    } else if (typeof fieldValue === 'number' && Number.isFinite(fieldValue)) {
      normalized[normalizedFieldId] = fieldValue
    } else if (typeof fieldValue === 'boolean') {
      normalized[normalizedFieldId] = fieldValue
    } else if (
      Array.isArray(fieldValue) &&
      fieldValue.length <= 100 &&
      fieldValue.every((entry): entry is string => typeof entry === 'string') &&
      fieldValue.every((entry) => entry.length <= 10_000)
    ) {
      normalized[normalizedFieldId] = [...fieldValue]
    } else {
      throw new RequestIntakeError(
        400,
        'InvalidRequestIntakeInput',
        'Request conversion custom field value is invalid.',
      )
    }
  }
  return normalized
}

function readPresenceClientId(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(value.trim())) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Presence client ID is invalid.')
  }

  return value.trim()
}

function readPresenceTyping(value: unknown) {
  if (typeof value !== 'boolean') {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Presence typing state is invalid.')
  }

  return value
}

/**
 * Persists the adapter-produced compact schedule result as the exact replay response.
 *
 * @param workspaceId - Workspace that owns the idempotency reservation.
 * @param token - Reservation token bound to the confirmation request.
 * @param authorizationEndpoints - Server-derived endpoints that influenced the confirmation.
 * @returns Transaction contribution that stores the compact HTTP response.
 */
function createWorkItemScheduleConfirmationIdempotencyTransaction(
  workspaceId: string,
  token: IdempotencyMutationToken,
  authorizationEndpoints: readonly WorkItemScheduleEvaluationRevision[],
): WorkItemIdempotencyTransaction | undefined {
  const transaction = createWorkItemIdempotencyTransaction(workspaceId, token)
  if (!transaction) return undefined
  return {
    async prepare(response) {
      if (
        response.status !== 200 ||
        !isRecord(response.body) ||
        !Array.isArray(response.body.workItems)
      ) {
        throw new WorkItemScheduleError(
          503,
          'InvalidWorkItemScheduleCascadeReceipt',
          'The schedule cascade produced an invalid durable receipt.',
        )
      }
      return transaction.prepare({
        status: 200,
        body: {
          workItems: response.body.workItems,
          authorizationEndpoints,
        },
      })
    },
  }
}

/**
 * Registers the work items HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerWorkItemsRoutes(routeApp: Hono): void {
  /**
   * DynamoDB に保存されたチーム/プロジェクト階層を返す endpoint です。
   *
   * @remarks
   * サイドバー用の directory table を読み、`locale=en` のときだけ英語名を優先します。
   */
  routeApp.get('/api/teams/projects', async (c) => {
    const accessToken = readBearerAccessToken(c)

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(
        principal.directoryId,
        readLocale(c),
      )
      if (principal.isSystemAdmin) return c.json(directory)
      const readableProjectIds = new Set(
        (await getEffectiveProjectAccessList(principal))
          .filter((access) => projectAccessAllows(access, 'viewer'))
          .map((access) => access.projectId),
      )
      const authorizedTeamIds = new Set(principal.enterpriseAuthorizedTeamIds ?? [])
      return c.json({
        ...directory,
        teams: directory.teams
          .map((team) => ({
            ...team,
            projects: team.projects.filter((project) =>
              readableProjectIds.has(project.id)
            ),
          }))
          .filter((team) => authorizedTeamIds.has(team.id) || team.projects.length > 0),
      })
    } catch (error) {
      if (error instanceof CognitoServiceError) {
        return toAuthErrorResponse(c, error)
      }

      return toProjectDataErrorResponse(c, error)
    }
  })

  /** Returns the authenticated viewer's accessible ordered Project shortcuts. */
  routeApp.get('/api/projects/quick-access', async (c) => {
    const accessToken = readBearerAccessToken(c)

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const [preference, authorizedProjectKeys] = await Promise.all([
        workspaceDependencies.projectDirectory.getProjectQuickAccess(
          principal.directoryId,
          principal.userKey,
          true,
        ),
        getAuthorizedProjectQuickAccessKeys(principal),
      ])

      return c.json({
        ...preference,
        items: preference.items.filter((item) =>
          authorizedProjectKeys.has(createProjectQuickAccessIdentity(item))
        ),
      } satisfies ProjectQuickAccessPreferences)
    } catch (error) {
      if (error instanceof CognitoServiceError) {
        return toAuthErrorResponse(c, error)
      }

      return toProjectDataErrorResponse(c, error)
    }
  })

  /** Replaces the authenticated viewer's complete ordered Project shortcuts. */
  routeApp.put('/api/projects/quick-access', async (c) => {
    const accessToken = readBearerAccessToken(c)

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const input = readProjectQuickAccessInput(await readJson<unknown>(c.req))
      const authorizedProjectKeys = await getAuthorizedProjectQuickAccessKeys(principal)

      if (input.items.some((item) =>
        !authorizedProjectKeys.has(createProjectQuickAccessIdentity(item))
      )) {
        throw new ProjectDataError(
          403,
          'ProjectAccessDenied',
          'One or more Project quick-access references are unavailable.',
        )
      }

      return c.json(await workspaceDependencies.projectDirectory.replaceProjectQuickAccess(
        principal.directoryId,
        principal.userKey,
        input,
      ))
    } catch (error) {
      if (error instanceof CognitoServiceError) {
        return toAuthErrorResponse(c, error)
      }

      return toProjectDataErrorResponse(c, error)
    }
  })

  /**
   * DynamoDB にチームを新規作成する endpoint です。
   */
  routeApp.post('/api/teams', async (c) => {
    const accessToken = readBearerAccessToken(c)

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceAdministration(principal)
      const body = await readJson<CreateTeamRequestBody>(c.req)

      const response = await workspaceDependencies.projectDirectory.createTeam(
        principal.directoryId,
        body ?? {},
        createApiMutationContext(c, principal, body ?? {}),
      )
      await projectWorkspaceSearchDocumentBestEffort(
        () => {
          const names = readLocalizedNames(body ?? {})
          return createTeamSearchDocument(
            principal.directoryId,
            response.team,
            principal.userKey,
            names.nameEn === response.team.name ? undefined : names.nameEn,
          )
        },
        'team creation',
      )
      return c.json(response, 201)
    } catch (error) {
      if (error instanceof CognitoServiceError) {
        return toAuthErrorResponse(c, error)
      }

      return toProjectDataErrorResponse(c, error)
    }
  })

  /**
   * DynamoDB にチーム配下のプロジェクトを新規作成する endpoint です。
   */
  routeApp.post('/api/teams/:teamId/projects', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    if (!teamId) {
      return c.json({ message: 'Team ID is required.' }, 400)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceAdministration(principal)
      const body = await readJson<CreateProjectRequestBody>(c.req) ?? {}
      delete body.idempotencyResourceId

      const response = await workspaceDependencies.projectDirectory.createProject(
        principal.directoryId,
        teamId,
        body,
        {
          userKey: principal.userKey,
          workspaceMemberVersion: principal.workspaceMember.version,
        },
        createApiMutationContext(c, principal, { teamId, ...body }),
      )
      await projectWorkspaceSearchDocumentBestEffort(
        () => {
          const names = readLocalizedNames(body)
          return createProjectSearchDocument(
            principal.directoryId,
            teamId,
            response.project,
            principal.userKey,
            names.nameEn === response.project.name ? undefined : names.nameEn,
          )
        },
        'project creation',
      )
      return c.json(response, 201)
    } catch (error) {
      if (error instanceof CognitoServiceError) {
        return toAuthErrorResponse(c, error)
      }

      return toProjectDataErrorResponse(c, error)
    }
  })

  /**
   * DynamoDB 上のチームをアーカイブする endpoint です。
   */
  routeApp.patch('/api/teams/:teamId/archive', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    if (!teamId) {
      return c.json({ message: 'Team ID is required.' }, 400)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceAdministration(principal)
      const expectedPlanningRevision = await requirePlanningTeamScopeIsUnused(
        principal.directoryId,
        teamId,
      )

      const response = await workspaceDependencies.projectDirectory.archiveTeam(
        principal.directoryId,
        teamId,
        createApiMutationContext(c, principal, { teamId }),
        expectedPlanningRevision,
      )
      await deleteWorkspaceSearchDocumentBestEffort(
        principal.directoryId,
        'team',
        `team/${teamId}`,
        'team archive',
      )
      return c.json(response)
    } catch (error) {
      if (error instanceof CognitoServiceError) {
        return toAuthErrorResponse(c, error)
      }

      return toProjectDataErrorResponse(c, error)
    }
  })

  /**
   * DynamoDB 上のチーム配下プロジェクトをアーカイブする endpoint です。
   */
  routeApp.patch('/api/teams/:teamId/projects/:projectId/archive', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')
    const projectId = c.req.param('projectId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    if (!teamId) {
      return c.json({ message: 'Team ID is required.' }, 400)
    }

    if (!projectId) {
      return c.json({ message: 'Project ID is required.' }, 400)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceAdministration(principal)
      const archiveGuard = await requirePlanningProjectScopeIsUnused(
        principal.directoryId,
        teamId,
        projectId,
      )

      const response = await workspaceDependencies.projectDirectory.archiveProject(
        principal.directoryId,
        teamId,
        projectId,
        createApiMutationContext(c, principal, { teamId, projectId }),
        archiveGuard.expectedPlanningRevision,
        archiveGuard.workItemRevisionGuards,
      )
      await deleteWorkspaceSearchDocumentBestEffort(
        principal.directoryId,
        'project',
        `team/${teamId}/project/${projectId}`,
        'project archive',
      )
      return c.json(response)
    } catch (error) {
      if (error instanceof CognitoServiceError) {
        return toAuthErrorResponse(c, error)
      }

      return toProjectDataErrorResponse(c, error)
    }
  })

  /** Workspace admin が explicit triage transition または Work Item conversion を実行します。 */
  routeApp.post('/api/request-submissions/:submissionId/actions', async (c) => {
    try {
      const principal = await requireRequestAdministration(c)
      requireWorkspaceBusinessWrite(principal)
      const submissionId = c.req.param('submissionId')
      const body = await readJson<RequestSubmissionActionInput>(c.req)
      if (!body || !isRecord(body) || typeof body.action !== 'string') {
        throw new RequestIntakeError(400, 'InvalidRequestIntakeInput', 'Request action is required.')
      }
      if (
        body.action !== 'assign' &&
        body.action !== 'request-more-info' &&
        body.action !== 'reject' &&
        body.action !== 'mark-duplicate' &&
        body.action !== 'convert'
      ) {
        throw new RequestIntakeError(400, 'InvalidRequestIntakeInput', 'Request action is invalid.')
      }
      if (
        body.action === 'convert' &&
        body.workItemTypeId !== undefined &&
        (typeof body.workItemTypeId !== 'string' ||
          !/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/iu.test(body.workItemTypeId.trim()))
      ) {
        throw new RequestIntakeError(
          400,
          'InvalidRequestIntakeInput',
          'Work Item Type ID is invalid.',
        )
      }
      if (body.action === 'convert' && body.customFieldValues !== undefined) {
        body.customFieldValues = normalizeRequestConversionCustomFieldValues(
          body.customFieldValues,
        )
      }
      if (body.action !== 'convert') {
        if (body.action === 'assign') {
          if (
            body.assigneeUserId !== null &&
            (typeof body.assigneeUserId !== 'string' || !body.assigneeUserId.trim())
          ) {
            throw new RequestIntakeError(400, 'InvalidRequestIntakeInput', 'Request assignee is required.')
          }
          if (typeof body.assigneeUserId === 'string') {
            await requireActiveWorkspaceAssignee(principal.directoryId, body.assigneeUserId)
          }
        }
        const submission = await workItemDependencies.requestIntake.getSubmission(
          principal.directoryId,
          submissionId,
        )
        const triageEntry = await readRequestTriageEntry(principal.directoryId, submission)
        const triageContribution = await createRequestActionTriageContribution(
          c,
          principal,
          submission,
          triageEntry,
          body,
        )
        if (triageContribution.replayed) return c.json(submission)
        return c.json(await workItemDependencies.requestIntake.applyAction(
          principal.directoryId,
          submissionId,
          { id: principal.userKey },
          body,
          triageContribution.contribution.transactItems,
        ))
      }
      const submission = await workItemDependencies.requestIntake.getSubmission(principal.directoryId, submissionId)
      if (submission.status === 'converted' && submission.workItem) {
        return c.json(submission)
      }
      const triageEntry = await readRequestTriageEntry(principal.directoryId, submission)
      const conversion = triageEntry.retention.redactedAt !== undefined
        ? createRetentionSafeRequestWorkItemInput(submission, body)
        : createRequestWorkItemInput(submission, body)
      const teamContext = await requireTeamPermission(principal, conversion.target.teamId, 'member')
      requireAssignedProjectPermission(
        principal,
        teamContext,
        conversion.target.projectId,
        'member',
      )
      await validateRequestRoutingTarget(
        principal.directoryId,
        conversion.target,
        body.target?.workflowStatusId === undefined ? undefined : body.workItemTypeId,
      )
      if (conversion.target.teamId !== triageEntry.teamId) {
        throw new RequestIntakeError(
          409,
          'RequestTriageTeamConflict',
          'A Triage-backed Request must be accepted in its current Team.',
        )
      }
      if (triageEntry.state !== 'pending' && triageEntry.state !== 'needs-information' &&
        triageEntry.state !== 'snoozed') {
        throw new RequestIntakeError(
          409,
          'RequestTriageStateConflict',
          'The corresponding Triage entry is already resolved.',
        )
      }
      const triageAction: AcceptCreateTriageAction = {
        action: 'accept',
        mode: 'create',
        expectedRevision: triageEntry.revision,
        ...(conversion.input.workItemTypeId
          ? { workItemTypeId: conversion.input.workItemTypeId }
          : {}),
        ...(body.customFieldValues === undefined
          ? {}
          : { customFieldValues: body.customFieldValues }),
      }
      const triageIdempotency = {
        key: c.req.header('Idempotency-Key')?.trim() ||
          `request-conversion:${submissionId}:${body.expectedRevision}`,
        fingerprint: createTriageInputFingerprint({
          workspaceId: principal.directoryId,
          teamId: conversion.target.teamId,
          entryId: triageEntry.id,
          action: triageAction,
        }),
      }
      const deterministicIssueId = createDeterministicTriageWorkItemId(
        principal.directoryId,
        conversion.target.teamId,
        triageEntry.id,
      )
      const normalized = normalizeTeamIssueInput({
        ...conversion.input,
        idempotentIssueId: deterministicIssueId,
        idempotentRequestDigest: triageIdempotency.fingerprint,
      }, teamContext.team)
      const resolvedConfiguration = await workItemDependencies.workItemConfigurations.getTeamConfiguration(
        principal.directoryId,
        conversion.target.teamId,
      )
      const conversionInput = {
        ...normalized,
        customFieldValues: filterRequestConversionCustomFieldValues(
          resolvedConfiguration.configuration,
          normalized.workItemTypeId,
          normalized.customFieldValues,
          conversion.target.projectId,
        ),
      }
      const configured = await prepareConfiguredCreateWorkItem(
        principal.directoryId,
        conversion.target.teamId,
        conversionInput,
        resolvedConfiguration,
        { fallbackToTypeInitialStatus: body.target?.workflowStatusId === undefined },
      )
      const authorizationConditionChecks = await createTriageProjectAuthorizationConditionChecks(
        principal,
        teamContext,
        principal.directoryId,
        conversion.target.teamId,
        conversion.target.projectId,
      )
      const guardedConfigured = authorizationConditionChecks.length === 0
        ? configured
        : {
            ...configured,
            authorizationConditionChecks: mergeTriageConditionChecks(
              configured.authorizationConditionChecks ?? [],
              authorizationConditionChecks,
            ),
          };
      await requireActiveWorkspaceAssignee(
        principal.directoryId,
        readTeamIssueAssigneeUserId(guardedConfigured),
      )
      const triageOccurredAt = new Date().toISOString()
      const triageAcceptance = createTriageAcceptanceTransactionItems({
        tableName: getEnv('REQUEST_INTAKE_TABLE_NAME') ?? 'mukuroji-request-intake-local',
        entry: triageEntry,
        action: triageAction,
        canonicalWorkItem: {
          teamId: conversion.target.teamId,
          workItemId: deterministicIssueId,
          ...(typeof configured.workItemTypeId === 'string'
            ? { workItemTypeId: configured.workItemTypeId }
            : {}),
          ...(conversion.target.projectId
            ? { projectId: conversion.target.projectId }
            : {}),
        },
        actorId: principal.userKey,
        now: triageOccurredAt,
        idempotency: triageIdempotency,
      })
      const created = await hydrateCreateTeamIssueResponse(await workItemDependencies.teamIssues.createTeamIssue(
        principal.directoryId,
        conversion.target.teamId,
        guardedConfigured,
        principal.userKey,
        createApiMutationContext(c, principal, {
          submissionId,
          action: 'convert',
          target: conversion.target,
        }),
        {
          tableName: getEnv('REQUEST_INTAKE_TABLE_NAME') ?? 'mukuroji-request-intake-local',
          scopeKey: `WORKSPACE#${principal.directoryId}`,
          recordKey: `SUBMISSION#${submissionId}`,
          expectedRevision: body.expectedRevision,
          actorId: principal.userKey,
          submissionId,
          events: submission.events,
        },
        {
          entryId: triageAcceptance.entry.id,
          occurredAt: triageOccurredAt,
          transactItems: triageAcceptance.transactItems,
        },
      ))
      await projectWorkItemSearchDocumentBestEffort(
        principal.directoryId,
        created.issue,
        'Request conversion',
        [],
      )
      return c.json(await workItemDependencies.requestIntake.completeConversion(
        principal.directoryId,
        submissionId,
        { id: principal.userKey },
        {
          expectedRevision: body.expectedRevision,
          workItem: {
            teamId: created.issue.teamId,
            workItemId: created.issue.id,
            ...(created.issue.assignedProjectId
              ? { projectId: created.issue.assignedProjectId }
              : {}),
          },
        },
      ))
    } catch (error) {
      return toRequestIntakeErrorResponse(c, error)
    }
  })

  /** 同一 Team 内の Work Item 間へ reciprocal relation を作成します。 */
  routeApp.post('/api/teams/:teamId/issues/:issueId/relations', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')
    const issueId = c.req.param('issueId')
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }
    if (!teamId || !issueId) {
      return c.json({ message: 'Team ID and Work Item ID are required.' }, 400)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const body = await readJson<Record<string, unknown>>(c.req) ?? {}
      const relationType = readCreatableWorkItemRelationType(body.type)
      const targetWorkItemId = readRequiredString(
        body.targetWorkItemId,
        'Target Work Item ID is required.',
      )
      const expectedGraphRevision = readNonNegativeRevision(
        body.expectedGraphRevision,
        'Relation graph revision',
      )
      const endpoints = await authorizeRelationMutation(principal, teamId, issueId, targetWorkItemId)
      const resolvedConfiguration = relationType === 'parent'
        ? await workItemDependencies.workItemConfigurations.getTeamConfiguration(
            principal.directoryId,
            teamId,
          )
        : undefined
      if (resolvedConfiguration) {
        assertWorkItemChildTypeAllowed(
          resolvedConfiguration.configuration,
          endpoints.target.workItemTypeId,
          endpoints.source.workItemTypeId,
        )
      }
      const response = await workItemDependencies.workItemConfigurations.createRelation(
        principal.directoryId,
        teamId,
        {
          sourceWorkItemId: issueId,
          targetWorkItemId,
          type: relationType,
          expectedGraphRevision,
          sourceExpectedRevision: endpoints.source.revision,
          targetExpectedRevision: endpoints.target.revision,
          sourceAssignedProjectId: endpoints.source.assignedProjectId,
          targetAssignedProjectId: endpoints.target.assignedProjectId,
        },
        resolvedConfiguration
          ? createWorkItemConfigurationGuardConditionChecks(
              getWorkItemConfigurationTableName(),
              principal.directoryId,
              teamId,
              resolvedConfiguration,
            )
          : undefined,
      )
      await Promise.all([
        refreshWorkItemSearchDocumentBestEffort(
          principal.directoryId,
          teamId,
          issueId,
          'Work Item relation creation',
        ),
        refreshWorkItemSearchDocumentBestEffort(
          principal.directoryId,
          teamId,
          targetWorkItemId,
          'Work Item reciprocal relation creation',
        ),
      ])
      return c.json(response, 201)
    } catch (error) {
      return toWorkItemConfigurationErrorResponse(c, error)
    }
  })

  /** 同一 Team 内の reciprocal relation を削除します。 */
  routeApp.delete('/api/teams/:teamId/issues/:issueId/relations/:targetWorkItemId/:relationType', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')
    const issueId = c.req.param('issueId')
    const targetWorkItemId = c.req.param('targetWorkItemId')
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }
    if (!teamId || !issueId || !targetWorkItemId) {
      return c.json({ message: 'Team ID and Work Item IDs are required.' }, 400)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const body = await readJson<Record<string, unknown>>(c.req) ?? {}
      const relationType = readWorkItemRelationType(c.req.param('relationType'))
      const expectedGraphRevision = readNonNegativeRevision(
        body.expectedGraphRevision,
        'Relation graph revision',
      )
      const endpoints = await authorizeRelationMutation(principal, teamId, issueId, targetWorkItemId)
      const response = await workItemDependencies.workItemConfigurations.deleteRelation(
        principal.directoryId,
        teamId,
        {
          sourceWorkItemId: issueId,
          targetWorkItemId,
          type: relationType,
          expectedGraphRevision,
          sourceExpectedRevision: endpoints.source.revision,
          targetExpectedRevision: endpoints.target.revision,
          sourceAssignedProjectId: endpoints.source.assignedProjectId,
          targetAssignedProjectId: endpoints.target.assignedProjectId,
        },
      )
      await Promise.all([
        refreshWorkItemSearchDocumentBestEffort(
          principal.directoryId,
          teamId,
          issueId,
          'Work Item relation deletion',
        ),
        refreshWorkItemSearchDocumentBestEffort(
          principal.directoryId,
          teamId,
          targetWorkItemId,
          'Work Item reciprocal relation deletion',
        ),
      ])
      return c.json(response)
    } catch (error) {
      return toWorkItemConfigurationErrorResponse(c, error)
    }
  })

  /** 現在ユーザーが参照できる canonical Work Item を Workspace 横断で返します。 */
  routeApp.get('/api/work-items', async (c) => {
    const accessToken = readBearerAccessToken(c)

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const includeArchived = readOptionalIncludeArchivedQuery(c.req.query('includeArchived'))
      return c.json(await hydrateWorkItemsResponse(
        await readAccessibleWorkItems(principal, includeArchived),
        principal.directoryId,
      ))
    } catch (error) {
      return toWorkItemConfigurationErrorResponse(c, error)
    }
  })

  /**
   * Cognito user pool からプロジェクト権限付与候補 user を検索する endpoint です。
   */
  routeApp.get('/api/projects/:projectId/users', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const projectId = c.req.param('projectId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    if (!projectId) {
      return c.json({ message: 'Project ID is required.' }, 400)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      await requireProjectPermission(principal, projectId, 'manager')

      return c.json(await listActiveWorkspaceCognitoUsers(principal.directoryId, c))
    } catch (error) {
      if (error instanceof CognitoServiceError) {
        return toCognitoDirectoryErrorResponse(c, error)
      }

      return toProjectDataErrorResponse(c, error)
    }
  })

  /**
   * DynamoDB に保存されたプロジェクトメンバー一覧を返す endpoint です。
   */
  routeApp.get('/api/projects/:projectId/members', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const projectId = c.req.param('projectId')
    const teamIdCandidate = c.req.query('teamId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    if (!projectId) {
      return c.json({ message: 'Project ID is required.' }, 400)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const teamId = teamIdCandidate === undefined
        ? undefined
        : readPlanningIdentifier(teamIdCandidate, 'Team ID')
      if (teamId === undefined) {
        await requireProjectPermission(principal, projectId, 'member')
      } else {
        await requirePlanningUpdateProjectPermission(principal, teamId, projectId, 'member')
      }

      return c.json(
        await hydrateProjectMembersResponse(
          await workspaceDependencies.projectDirectory.getProjectMembers(
            principal.directoryId,
            projectId,
            teamId,
          ),
          principal.directoryId,
        ),
      )
    } catch (error) {
      if (error instanceof CognitoServiceError) {
        return toCognitoDirectoryErrorResponse(c, error)
      }

      return toProjectDataErrorResponse(c, error)
    }
  })

  /**
   * DynamoDB に保存されたプロジェクトメンバーの role を作成または更新する endpoint です。
   */
  routeApp.patch('/api/projects/:projectId/members/:memberKey', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const projectId = c.req.param('projectId')
    const memberKey = c.req.param('memberKey')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    if (!projectId) {
      return c.json({ message: 'Project ID is required.' }, 400)
    }

    if (!memberKey) {
      return c.json({ message: 'Member key is required.' }, 400)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      await requireProjectPermission(principal, projectId, 'manager')
      const body = await readJson<UpdateProjectMemberRequestBody>(c.req)
      const profile = await authenticationDependencies.cognito.getUserProfile(memberKey)
      const workspaceMember = await workspaceDependencies.workspaceAccess.getActiveMember(principal.directoryId, profile.id)

      if (!workspaceMember) {
        throw new WorkspaceAccessError(
          409,
          'WorkspaceMemberInactive',
          'Only active Workspace members can be assigned to a project.',
        )
      }

      return c.json(
        await hydrateProjectMemberUpdateResponse(
          await workspaceDependencies.projectDirectory.updateProjectMember(
            principal.directoryId,
            projectId,
            profile.id,
            {
              ...body,
              email: profile.email,
              name: profile.name,
            },
            workspaceMember.version,
            createApiMutationContext(c, principal, {
              projectId,
              memberKey: profile.id,
              ...body,
            }),
          ),
          principal.directoryId,
        ),
      )
    } catch (error) {
      if (error instanceof CognitoServiceError) {
        return toCognitoDirectoryErrorResponse(c, error)
      }

      return toProjectDataErrorResponse(c, error)
    }
  })

  /**
   * DynamoDB からプロジェクトメンバーの role を削除する endpoint です。
   */
  routeApp.delete('/api/projects/:projectId/members/:memberKey', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const projectId = c.req.param('projectId')
    const memberKey = c.req.param('memberKey')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    if (!projectId) {
      return c.json({ message: 'Project ID is required.' }, 400)
    }

    if (!memberKey) {
      return c.json({ message: 'Member key is required.' }, 400)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      await requireProjectPermission(principal, projectId, 'manager')
      const targetWorkspaceMember = await workspaceDependencies.workspaceAccess.getMember(
        principal.directoryId,
        memberKey,
      )

      return c.json(
        await workspaceDependencies.projectDirectory.removeProjectMember(
          principal.directoryId,
          projectId,
          memberKey,
          createApiMutationContext(c, principal, { projectId, memberKey }),
          targetWorkspaceMember === undefined
            ? { exists: false }
            : {
                exists: true,
                version: targetWorkspaceMember.version,
                status: targetWorkspaceMember.status,
              },
        ),
      )
    } catch (error) {
      if (error instanceof CognitoServiceError) {
        return toAuthErrorResponse(c, error)
      }

      return toProjectDataErrorResponse(c, error)
    }
  })

  /**
   * DynamoDB に保存されたチーム所有 Issue 一覧を返す endpoint です。
   */
  routeApp.get('/api/teams/:teamId/issues', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    if (!teamId) {
      return c.json({ message: 'Team ID is required.' }, 400)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const context = await requireTeamPermission(principal, teamId, 'viewer')
      const includeArchived = readOptionalIncludeArchivedQuery(c.req.query('includeArchived'))
      const workItemTypeId = readOptionalWorkItemTypeIdQuery(c.req.query('workItemTypeId'))

      return c.json(await hydrateTeamIssuesResponse(await readTeamIssues(
        principal.directoryId,
        context,
        principal,
        includeArchived,
        workItemTypeId,
      )))
    } catch (error) {
      if (error instanceof CognitoServiceError) {
        return toCognitoDirectoryErrorResponse(c, error)
      }

      return toProjectDataErrorResponse(c, error)
    }
  })

  /**
   * DynamoDB にチーム所有 Issue を新規作成する endpoint です。
   */
  routeApp.post('/api/teams/:teamId/issues', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    if (!teamId) {
      return c.json({ message: 'Team ID is required.' }, 400)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const context = await requireTeamPermission(principal, teamId, 'member')
      const requestBody = await readJson<CreateTeamIssueRequestBody>(c.req)
      if (!requestBody) {
        throw new ProjectDataError(400, 'InvalidProjectWrite', 'Work Item body is required.')
      }
      rejectInternalWorkItemCreateFields(requestBody)
      const body = normalizeTeamIssueInput(
        requestBody,
        context.team,
      )
      requireAssignedProjectPermission(
        principal,
        context,
        readAssignedProjectId(body.assignedProjectId),
        'member',
      )
      const resolvedConfiguration = await workItemDependencies.workItemConfigurations.getTeamConfiguration(
        principal.directoryId,
        teamId,
      )
      const configuredBody = await prepareConfiguredCreateWorkItem(
        principal.directoryId,
        teamId,
        body,
        resolvedConfiguration,
      )
      const assigneeUserId = readTeamIssueAssigneeUserId(configuredBody)
      await requireActiveWorkspaceAssignee(principal.directoryId, assigneeUserId)
      const response = await hydrateCreateTeamIssueResponse(
        await workItemDependencies.teamIssues.createTeamIssue(
          principal.directoryId,
          teamId,
          {
            ...configuredBody,
            assigneeUserId,
          },
          principal.userKey,
          createApiMutationContext(c, principal, { teamId, ...configuredBody }),
        ),
      )
      await projectWorkItemSearchDocumentBestEffort(
        principal.directoryId,
        response.issue,
        'Work Item creation',
        [],
      )
      return c.json(response, 201)
    } catch (error) {
      return toWorkItemConfigurationErrorResponse(c, error)
    }
  })

  /**
   * DynamoDB に保存されたチーム所有 Issue の paginated activity を返す endpoint です。
   */
  routeApp.get('/api/teams/:teamId/issues/:issueId/activity', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')
    const issueId = c.req.param('issueId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    if (!teamId || !issueId) {
      return c.json({ message: 'Team ID and issue ID are required.' }, 400)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const context = await requireTeamPermission(principal, teamId, 'viewer')
      const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
        principal.directoryId,
        teamId,
        issueId,
        { consistentIssueRead: true },
      )
      requireAssignedProjectPermission(principal, context, detail.issue.assignedProjectId, 'viewer')

      const page = await workspaceDependencies.auditEvents.query(
        readAuditEventQuery(c, principal.directoryId, {
          type: 'work-item',
          id: createTeamIssueAuditEntityId(teamId, issueId),
        }),
      )

      return c.json(toWorkItemActivityPageView(page))
    } catch (error) {
      if (error instanceof CognitoServiceError) {
        return toCognitoDirectoryErrorResponse(c, error)
      }

      if (error instanceof TypeError || error instanceof RangeError) {
        return c.json({ message: error.message }, 400)
      }

      return toProjectDataErrorResponse(c, error)
    }
  })

  /**
   * DynamoDB に保存されたチーム所有 Issue 詳細を返す endpoint です。
   */
  routeApp.get('/api/teams/:teamId/issues/:issueId', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')
    const issueId = c.req.param('issueId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    if (!teamId || !issueId) {
      return c.json({ message: 'Team ID and issue ID are required.' }, 400)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const context = await requireTeamPermission(principal, teamId, 'viewer')

      const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
        principal.directoryId,
        teamId,
        issueId,
        { consistentIssueRead: true },
      )
      requireAssignedProjectPermission(principal, context, detail.issue.assignedProjectId, 'viewer')
      const [resolvedConfiguration, relationPage] = await Promise.all([
        workItemDependencies.workItemConfigurations.getTeamConfiguration(principal.directoryId, teamId),
        workItemDependencies.workItemConfigurations.listRelations(principal.directoryId, teamId, issueId),
      ])
      let customerImpact: TeamIssueDetailResponse['customerImpact']
      if (hasCustomerReadAccess(principal, { teamId })) {
        try {
          customerImpact = projectCustomerImpactSignal(
            await workspaceDependencies.customers.getWorkItemImpact(
              principal.directoryId,
              teamId,
              issueId,
            ),
            hasCustomerManagementAccess(principal, { teamId }),
          )
        } catch (error) {
          console.error('Customer impact was unavailable while loading Work Item detail.', {
            workspaceId: principal.directoryId,
            teamId,
            issueId,
            errorCode: error instanceof CustomerError ? error.code : 'CustomerImpactUnavailable',
          })
        }
      }
      const visibleRelations = await filterVisibleWorkItemRelations(
        principal,
        context,
        teamId,
        relationPage.relations,
      )

      return c.json(await hydrateTeamIssueDetailResponse(
        {
          ...detail,
          resolvedConfiguration,
          relations: visibleRelations,
          relationGraphRevision: relationPage.graphRevision,
          customerImpact,
        },
        principal.directoryId,
      ))
    } catch (error) {
      return toWorkItemConfigurationErrorResponse(c, error)
    }
  })

  /**
   * Validates a Work Item schedule operation and returns its impact before mutation.
   */
  routeApp.post('/api/teams/:teamId/issues/:issueId/schedule/preview', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')
    const issueId = c.req.param('issueId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    if (!teamId || !issueId) {
      return c.json({ message: 'Team ID and issue ID are required.' }, 400)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const context = await requireTeamPermission(principal, teamId, 'member')
      const body = await readJson<Record<string, unknown>>(c.req) ?? {}
      const expectedRevision = readWorkItemExpectedRevision(body.expectedRevision)
      const operation = normalizeWorkItemScheduleOperation(body.operation)
      const [detail, relationPage] = await Promise.all([
        workItemDependencies.teamIssues.getTeamIssueDetail(
          principal.directoryId,
          teamId,
          issueId,
          { consistentIssueRead: true, includeEvents: false },
        ),
        workItemDependencies.workItemConfigurations.listRelations(
          principal.directoryId,
          teamId,
          issueId,
        ),
      ])
      requireAssignedProjectPermission(principal, context, detail.issue.assignedProjectId, 'member')
      if (detail.issue.revision !== expectedRevision) {
        throw new ProjectDataError(
          409,
          'WorkItemRevisionConflict',
          'Work Item changed. Reload and try again.',
        )
      }

      const visibleRelations = await filterVisibleWorkItemRelations(
        principal,
        context,
        teamId,
        relationPage.relations,
      )
      const recomputed = await recomputeWorkItemScheduleDependencyPreview(
        principal,
        detail.issue,
        operation,
        relationPage.graphRevision,
        visibleRelations.filter((relation) =>
          relation.sourceWorkItemId === issueId &&
          (relation.type === 'blocks' || relation.type === 'blockedBy')
        ).length,
        'viewer',
      )
      return c.json(recomputed.preview)
    } catch (error) {
      return toWorkItemConfigurationErrorResponse(c, error)
    }
  })

  /**
   * Recomputes and atomically persists an explicitly confirmed schedule dependency cascade.
   */
  routeApp.post('/api/teams/:teamId/issues/:issueId/schedule/confirm', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')
    const issueId = c.req.param('issueId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }
    if (!teamId || !issueId) {
      return c.json({ message: 'Team ID and issue ID are required.' }, 400)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const context = await requireTeamPermission(principal, teamId, 'member')
      const idempotencyKey = readRequiredWorkItemScheduleIdempotencyKey(
        c.req.header('Idempotency-Key'),
      )
      const body = await readJson<Record<string, unknown>>(c.req) ?? {}
      if (body.confirmed !== true) {
        throw new WorkItemScheduleError(
          400,
          'WorkItemScheduleConfirmationRequired',
          'Schedule dependency changes require explicit confirmation.',
        )
      }
      const expectedRevision = readWorkItemExpectedRevision(body.expectedRevision)
      const expectedPlanningRevision = readWorkItemScheduleGraphRevision(
        body.expectedPlanningRevision,
        'Planning revision',
      )
      const expectedRelationGraphRevision = readWorkItemScheduleGraphRevision(
        body.expectedRelationGraphRevision,
        'Relation graph revision',
      )
      const expectedEvaluatedRevisions = readWorkItemScheduleEvaluationRevisions(
        body.expectedEvaluatedRevisions,
      )
      const expectedImpacts = readWorkItemScheduleImpacts(body.expectedImpacts)
      const operation = normalizeWorkItemScheduleOperation(body.operation)
      const reservationRequest: ReserveIdempotencyRequest = {
        workspaceId: createWorkItemScheduleIdempotencyWorkspaceId(principal.directoryId),
        credentialId: createWorkItemScheduleIdempotencyUserId(
          principal.directoryId,
          principal.actorId,
        ),
        idempotencyKey,
        requestFingerprint: createWorkItemScheduleConfirmationFingerprint(
          c.req.method,
          new URL(c.req.url).pathname,
          body,
        ),
      }
      const response = await executeConfirmedWorkItemScheduleChange(
        c,
        principal,
        context,
        body,
        {
          teamId,
          workItemId: issueId,
          expectedRevision,
          expectedPlanningRevision,
          expectedRelationGraphRevision,
          expectedEvaluatedRevisions,
          expectedImpacts,
          operation,
          reservationRequest,
        },
      )
      return c.json(response)
    } catch (error) {
      return toWorkItemConfigurationErrorResponse(c, error)
    }
  })

  /**
   * Work Item Type の変更による影響を計算する endpoint です。
   */
  routeApp.post('/api/teams/:teamId/issues/:issueId/work-item-type-preview', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')
    const issueId = c.req.param('issueId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }
    if (!teamId || !issueId) {
      return c.json({ message: 'Team ID and issue ID are required.' }, 400)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const context = await requireTeamPermission(principal, teamId, 'member')
      const input = await readJson<Record<string, unknown>>(c.req) ?? {}
      const expectedRevision = readWorkItemExpectedRevision(input.expectedRevision)
      const targetWorkItemTypeId = readRequiredWorkItemTypeId(input.targetWorkItemTypeId)
      const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
        principal.directoryId,
        teamId,
        issueId,
        { consistentIssueRead: true, includeEvents: false },
      )
      if (detail.issue.revision !== expectedRevision) {
        throw new ProjectDataError(
          409,
          'WorkItemRevisionConflict',
          'Work Item changed. Reload and try again.',
        )
      }
      requireAssignedProjectPermission(principal, context, detail.issue.assignedProjectId, 'member')
      const proposedAssignedProjectId = 'assignedProjectId' in input
        ? readAssignedProjectId(input.assignedProjectId)
        : detail.issue.assignedProjectId
      if ('assignedProjectId' in input) {
        requireAssignedProjectPermission(
          principal,
          context,
          proposedAssignedProjectId,
          'member',
        )
      }
      const resolvedConfiguration = await workItemDependencies.workItemConfigurations.getTeamConfiguration(
        principal.directoryId,
        teamId,
      )
      const preview = previewWorkItemTypeChange(
        resolvedConfiguration.configuration,
        detail.issue.workItemTypeId,
        detail.issue.workflowStatusId,
        detail.issue.customFieldValues,
        targetWorkItemTypeId,
        proposedAssignedProjectId ?? undefined,
        expectedRevision,
      )
      const approvalCompletionTransitionConflict = await hasWorkItemApprovalCompletionTransitionConflict(
        principal.directoryId,
        teamId,
        issueId,
        preview.targetWorkItemTypeId,
        preview.invalidWorkflowStatusId === undefined
          ? preview.currentWorkflowStatusId
          : preview.targetInitialWorkflowStatusId,
        resolvedConfiguration.configuration,
      )
      return c.json({
        ...preview,
        approvalCompletionTransitionConflict,
        requiresResolution: preview.requiresResolution || approvalCompletionTransitionConflict,
      })
    } catch (error) {
      return toWorkItemConfigurationErrorResponse(c, error)
    }
  })

  /**
   * DynamoDB に保存されたチーム所有 Issue を更新する endpoint です。
   */
  routeApp.patch('/api/teams/:teamId/issues/:issueId', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')
    const issueId = c.req.param('issueId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    if (!teamId || !issueId) {
      return c.json({ message: 'Team ID and issue ID are required.' }, 400)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const context = await requireTeamPermission(principal, teamId, 'member')
      const input = await readJson<PublicUpdateTeamIssueRequestBody>(c.req) ?? {}
      rejectInternalWorkItemUpdateFields(input)
      const body = normalizeTeamIssueInput(
        input,
        context.team,
      )
      const expectedRevision = readWorkItemExpectedRevision(body.expectedRevision)
      const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
        principal.directoryId,
        teamId,
        issueId,
        { consistentIssueRead: true, includeEvents: false },
      )
      requireAssignedProjectPermission(principal, context, detail.issue.assignedProjectId, 'member')
      requireAssignedProjectPermission(
        principal,
        context,
        readAssignedProjectId(body.assignedProjectId),
        'member',
      )

      const resolvedConfiguration = await workItemDependencies.workItemConfigurations.getTeamConfiguration(
        principal.directoryId,
        teamId,
      )
      const configuredBody = await prepareConfiguredUpdateWorkItem(
        principal.directoryId,
        teamId,
        detail.issue,
        body,
        resolvedConfiguration,
      )

      let authorizationSnapshot: WorkItemAuthorizationSnapshot | undefined
      const changesSchedule =
        'schedule' in configuredBody &&
        configuredBody.schedule !== undefined &&
        stableDigestStringify(configuredBody.schedule) !==
          stableDigestStringify(detail.issue.schedule)
      const changesAssignedProject =
        'assignedProjectId' in configuredBody &&
        readAssignedProjectId(configuredBody.assignedProjectId) !== detail.issue.assignedProjectId
      if (changesSchedule) {
        try {
          authorizationSnapshot = await createDependencyFencedWorkItemAuthorizationSnapshot(
            principal,
            teamId,
            issueId,
          )
        } catch (error) {
          if (
            error instanceof PlanningError &&
            error.code === 'PlanningWorkItemDependencyInUse'
          ) {
            throw new WorkItemScheduleError(
              409,
              'WorkItemScheduleConfirmationRequired',
              'Preview and explicitly confirm schedule changes for Work Items with dependencies.',
            )
          }
          if (error instanceof PlanningError) {
            throw new WorkItemScheduleError(error.status, error.code, error.message)
          }
          throw error
        }
      } else if (changesAssignedProject) {
        authorizationSnapshot = await createPlanningFencedWorkItemAuthorizationSnapshot(principal)
      }

      if ('assigneeUserId' in configuredBody) {
        await requireActiveWorkspaceAssignee(
          principal.directoryId,
          readTeamIssueAssigneeUserId(configuredBody),
        )
      }

      const response = await hydrateUpdateTeamIssueResponse(
        await workItemDependencies.teamIssues.updateTeamIssue(
          principal.directoryId,
          teamId,
          issueId,
          {
            ...configuredBody,
            expectedRevision,
            ...(authorizationSnapshot ? { authorizationSnapshot } : {}),
          },
          principal.userKey,
          createApiMutationContext(c, principal, {
            teamId,
            issueId,
            ...configuredBody,
            expectedRevision,
          }),
        ),
      )
      await projectWorkItemMutationSearchDocumentBestEffort(
        principal.directoryId,
        response.issue,
        'Work Item update',
      )
      return c.json(response)
    } catch (error) {
      return toWorkItemConfigurationErrorResponse(c, error)
    }
  })

  /**
   * Team-owned Work Item の root comments、replies、watch、presence を page 取得します。
   */
  routeApp.get('/api/teams/:teamId/issues/:issueId/collaboration', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')
    const issueId = c.req.param('issueId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    if (!teamId || !issueId) {
      return c.json({ message: 'Team ID and issue ID are required.' }, 400)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const { context, detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
      const entityKey = createWorkItemCollaborationEntityKey(principal.directoryId, teamId, issueId)
      const projectEntityKey = detail.issue.assignedProjectId
        ? createProjectCollaborationEntityKey(principal.directoryId, detail.issue.assignedProjectId)
        : undefined
      const limit = readCollaborationPageLimit(c.req.query('limit'))
      const requestedRootCommentId = c.req.query('rootCommentId')
      const requestedCursor = c.req.query('cursor')
      const canWrite = canWriteTeamIssue(principal, context, detail.issue.assignedProjectId)
      const capabilities = {
        canComment: canWrite,
        canReact: canWrite,
        canWatch: principal.workspaceRole !== 'guest',
      }

      if (requestedRootCommentId) {
        const replies = await workItemDependencies.collaboration.getThread({
          entityKey,
          viewerMemberKey: principal.userKey,
          projectEntityKey,
          rootCommentId: readOptionalCommentId(requestedRootCommentId, 'Root comment ID'),
          cursor: requestedCursor,
          limit: limit === undefined ? 20 : Math.min(limit, 20),
        })
        const responseComments = [...replies.comments].reverse().map((comment) =>
          toCollaborationCommentResponse(
            comment,
            principal,
            context,
            detail.issue,
            replies.threadResolved === true,
          )
        )
        enforceCollaborationCommentResponseBudget(responseComments)
        return c.json({
          // Store は最新順で page し、thread 内は古い順に描画できるよう反転して返す。
          comments: responseComments,
          ...(replies.nextCursor ? { nextCursor: replies.nextCursor } : {}),
          replyRootCommentId: requestedRootCommentId,
          watch: replies.watch,
          presence: replies.presence,
          capabilities,
        })
      }

      const roots = await workItemDependencies.collaboration.getThread({
        entityKey,
        viewerMemberKey: principal.userKey,
        projectEntityKey,
        cursor: requestedCursor,
        limit: limit === undefined ? 10 : Math.min(limit, 20),
      })
      const replyPages = await Promise.all(
        roots.comments.map((root) => workItemDependencies.collaboration.getThread({
          entityKey,
          viewerMemberKey: principal.userKey,
          projectEntityKey,
          rootCommentId: root.id,
          limit: 5,
          includeScopeState: false,
        })),
      )
      const comments = roots.comments.flatMap((root, index) => {
        const replyPage = replyPages[index]
        return [root, ...[...(replyPage?.comments ?? [])].reverse()].map((comment) =>
          toCollaborationCommentResponse(
            comment,
            principal,
            context,
            detail.issue,
            replyPage?.threadResolved === true,
          )
        )
      })
      enforceCollaborationCommentResponseBudget(comments)
      const replyNextCursors = Object.fromEntries(
        roots.comments.flatMap((root, index) => {
          const cursor = replyPages[index]?.nextCursor
          return cursor ? [[root.id, cursor] as const] : []
        }),
      )
      return c.json({
        comments,
        ...(roots.nextCursor ? { nextCursor: roots.nextCursor } : {}),
        ...(Object.keys(replyNextCursors).length > 0 ? { replyNextCursors } : {}),
        watch: roots.watch,
        presence: roots.presence,
        capabilities,
      })
    } catch (error) {
      return toCollaborationErrorResponse(c, error)
    }
  })

  /** Team-owned Work Item の curated context items を cursor page で返します。 */
  routeApp.get('/api/teams/:teamId/issues/:issueId/context-items', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')
    const issueId = c.req.param('issueId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    if (!teamId || !issueId) {
      return c.json({ message: 'Team ID and issue ID are required.' }, 400)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const { context, detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
      const limitValue = c.req.query('limit')
      const limit = limitValue === undefined ? undefined : Number(limitValue)
      const entityKey = createWorkItemCollaborationEntityKey(
        principal.directoryId,
        teamId,
        issueId,
      )
      const page = await workItemDependencies.collaboration.getCuratedContext({
        entityKey,
        limit,
        cursor: c.req.query('cursor'),
        capabilities: createCuratedContextCapabilities(principal, context, detail.issue),
      })
      const currentPrincipal = await assertCuratedContextScopeUnchanged(
        principal,
        teamId,
        issueId,
        'viewer',
        detail.issue.assignedProjectId,
        accessToken,
        c,
      )
      const reconciledItems = await reconcileCuratedContextSourcesForViewer(
        currentPrincipal,
        teamId,
        issueId,
        entityKey,
        page.items,
      )
      const finalPrincipal = await assertCuratedContextScopeUnchanged(
        currentPrincipal,
        teamId,
        issueId,
        'viewer',
        detail.issue.assignedProjectId,
        accessToken,
        c,
      )
      const finalScope = await loadAuthorizedTeamIssue(
        finalPrincipal,
        teamId,
        issueId,
        'viewer',
      )
      return c.json({
        ...page,
        items: reconciledItems,
        capabilities: createCuratedContextCapabilities(
          finalPrincipal,
          finalScope.context,
          finalScope.detail.issue,
        ),
      })
    } catch (error) {
      return toCollaborationErrorResponse(c, error)
    }
  })

  /** Curated context item の immutable revision history を cursor page で返します。 */
  routeApp.get(
    '/api/teams/:teamId/issues/:issueId/context-items/:contextItemId/revisions',
    async (c) => {
      const accessToken = readBearerAccessToken(c)
      const teamId = c.req.param('teamId')
      const issueId = c.req.param('issueId')
      const contextItemId = c.req.param('contextItemId')

      if (!accessToken) {
        return c.json({ message: 'Bearer token is required.' }, 401)
      }

      try {
        const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
        const { detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
        const entityKey = createWorkItemCollaborationEntityKey(
          principal.directoryId,
          teamId,
          issueId,
        )
        const limitValue = c.req.query('limit')
        const page = await workItemDependencies.collaboration.getCuratedContextRevisions({
          entityKey,
          itemId: contextItemId,
          limit: limitValue === undefined ? undefined : Number(limitValue),
          cursor: c.req.query('cursor'),
        })
        const currentPrincipal = await assertCuratedContextScopeUnchanged(
          principal,
          teamId,
          issueId,
          'viewer',
          detail.issue.assignedProjectId,
          accessToken,
          c,
        )
        const reconciledItems = await reconcileCuratedContextSourcesForViewer(
          currentPrincipal,
          teamId,
          issueId,
          entityKey,
          page.items,
        )
        await assertCuratedContextScopeUnchanged(
          currentPrincipal,
          teamId,
          issueId,
          'viewer',
          detail.issue.assignedProjectId,
          accessToken,
          c,
        )
        return c.json({
          ...page,
          items: reconciledItems,
        })
      } catch (error) {
        return toCollaborationErrorResponse(c, error)
      }
    },
  )

  /** Team-owned Work Item に human-curated context item を追加します。 */
  routeApp.post('/api/teams/:teamId/issues/:issueId/context-items', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')
    const issueId = c.req.param('issueId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const request = readCreateCuratedContextItemRequest(await readJson<unknown>(c.req))
      const { context, detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'member')
      const entityKey = createWorkItemCollaborationEntityKey(principal.directoryId, teamId, issueId)
      const auditContext = createApiMutationContext(c, principal, { teamId, issueId, ...request })
      const replayed = await workItemDependencies.collaboration.getCuratedContextMutationReplay({
        entityKey,
        operation: 'create',
        auditContext,
      })
      if (replayed) {
        return c.json({
          item: await requirePermissionSafeCuratedContextItem(
            principal,
            teamId,
            issueId,
            entityKey,
            replayed,
            detail.issue.assignedProjectId,
            accessToken,
            c,
          ),
        }, 201)
      }
      const mentionMemberKeys = request.mentionMemberKeys ?? []
      await requireValidCommentMentions(
        principal.directoryId,
        mentionMemberKeys,
        context,
        detail.issue.assignedProjectId,
      )
      const projectEntityKey = detail.issue.assignedProjectId
        ? createProjectCollaborationEntityKey(principal.directoryId, detail.issue.assignedProjectId)
        : undefined
      const resolvedSource = request.source
        ? await resolveCuratedContextSource(principal, teamId, issueId, entityKey, request.source)
        : undefined
      const item = await workItemDependencies.collaboration.createCuratedContextItem({
        workspaceId: principal.directoryId,
        teamId,
        issueId,
        workItemTitle: detail.issue.title,
        entityKey,
        projectId: detail.issue.assignedProjectId,
        projectEntityKey,
        actor: createCuratedContextActorSnapshot(principal),
        authorizationSnapshot: {
          memberKey: principal.userKey,
          workspaceMemberVersion: principal.workspaceMember.version,
          ...(principal.enterpriseIdentityControlRevision === undefined
            ? {}
            : { enterpriseControlRevision: principal.enterpriseIdentityControlRevision }),
        },
        kind: request.kind,
        title: request.title,
        body: request.body,
        ...(resolvedSource ? { source: resolvedSource.source } : {}),
        ...(resolvedSource?.documentAuthorizationSnapshot
          ? { sourceAuthorizationSnapshot: resolvedSource.documentAuthorizationSnapshot }
          : {}),
        ...(resolvedSource?.activityAuthorizationSnapshot
          ? { activitySourceAuthorizationSnapshot: resolvedSource.activityAuthorizationSnapshot }
          : {}),
        mentionMemberKeys,
        ...(request.supersedesItemId ? { supersedesItemId: request.supersedesItemId } : {}),
        notificationCandidates: mentionMemberKeys.map((memberKey) => ({
          memberKey,
          reason: 'mention',
        })),
        automaticWatcherCandidates: createTeamIssueAutomaticWatcherCandidates(detail.issue),
        deepLink: createTeamIssueDeepLink(teamId, issueId),
        auditContext,
      })
      await projectWorkspaceSearchDocumentBestEffort(
        () => createCuratedContextItemWorkspaceSearchDocument({
          workspaceId: principal.directoryId,
          item,
          projectId: detail.issue.assignedProjectId,
        }),
        'curated context creation',
      )
      if (request.supersedesItemId) {
        await deleteWorkspaceSearchDocumentBestEffort(
          principal.directoryId,
          'context-item',
          `${createTeamIssueAuditEntityId(teamId, issueId)}/context-item/${request.supersedesItemId}`,
          'curated context supersession',
        )
      }
      return c.json({
        item: await requirePermissionSafeCuratedContextItem(
          principal,
          teamId,
          issueId,
          entityKey,
          item,
          detail.issue.assignedProjectId,
          accessToken,
          c,
        ),
      }, 201)
    } catch (error) {
      return toCollaborationErrorResponse(c, error)
    }
  })

  /** Curated context item を optimistic revision 条件付きで更新します。 */
  routeApp.patch('/api/teams/:teamId/issues/:issueId/context-items/:contextItemId', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')
    const issueId = c.req.param('issueId')
    const contextItemId = c.req.param('contextItemId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const request = readUpdateCuratedContextItemRequest(await readJson<unknown>(c.req))
      const { context, detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'member')
      const entityKey = createWorkItemCollaborationEntityKey(principal.directoryId, teamId, issueId)
      const auditContext = createApiMutationContext(c, principal, {
        teamId,
        issueId,
        contextItemId,
        ...request,
      })
      const replayed = await workItemDependencies.collaboration.getCuratedContextMutationReplay({
        entityKey,
        operation: 'update',
        itemId: contextItemId,
        auditContext,
      })
      if (replayed) {
        return c.json({
          item: await requirePermissionSafeCuratedContextItem(
            principal,
            teamId,
            issueId,
            entityKey,
            replayed,
            detail.issue.assignedProjectId,
            accessToken,
            c,
          ),
        })
      }
      if (request.mentionMemberKeys) {
        await requireValidCommentMentions(
          principal.directoryId,
          request.mentionMemberKeys,
          context,
          detail.issue.assignedProjectId,
        )
      }
      const projectEntityKey = detail.issue.assignedProjectId
        ? createProjectCollaborationEntityKey(principal.directoryId, detail.issue.assignedProjectId)
        : undefined
      const item = await workItemDependencies.collaboration.updateCuratedContextItem({
        workspaceId: principal.directoryId,
        teamId,
        issueId,
        workItemTitle: detail.issue.title,
        entityKey,
        projectId: detail.issue.assignedProjectId,
        projectEntityKey,
        itemId: contextItemId,
        actor: createCuratedContextActorSnapshot(principal),
        authorizationSnapshot: {
          memberKey: principal.userKey,
          workspaceMemberVersion: principal.workspaceMember.version,
          ...(principal.enterpriseIdentityControlRevision === undefined
            ? {}
            : { enterpriseControlRevision: principal.enterpriseIdentityControlRevision }),
        },
        expectedRevision: request.expectedRevision,
        ...(request.kind ? { kind: request.kind } : {}),
        ...(request.state ? { state: request.state } : {}),
        ...(request.title !== undefined ? { title: request.title } : {}),
        ...(request.body !== undefined ? { body: request.body } : {}),
        ...(request.mentionMemberKeys ? { mentionMemberKeys: request.mentionMemberKeys } : {}),
        notificationCandidates: (request.mentionMemberKeys ?? []).map((memberKey) => ({
          memberKey,
          reason: 'mention',
        })),
        automaticWatcherCandidates: createTeamIssueAutomaticWatcherCandidates(detail.issue),
        deepLink: createTeamIssueDeepLink(teamId, issueId),
        auditContext,
      })
      if (item.state === 'superseded') {
        await deleteWorkspaceSearchDocumentBestEffort(
          principal.directoryId,
          'context-item',
          `${createTeamIssueAuditEntityId(teamId, issueId)}/context-item/${item.id}`,
          'curated context update',
        )
      } else {
        await projectWorkspaceSearchDocumentBestEffort(
          () => createCuratedContextItemWorkspaceSearchDocument({
            workspaceId: principal.directoryId,
            item,
            projectId: detail.issue.assignedProjectId,
          }),
          'curated context update',
        )
      }
      return c.json({
        item: await requirePermissionSafeCuratedContextItem(
          principal,
          teamId,
          issueId,
          entityKey,
          item,
          detail.issue.assignedProjectId,
          accessToken,
          c,
        ),
      })
    } catch (error) {
      return toCollaborationErrorResponse(c, error)
    }
  })

  /** Work Item presence/typing heartbeat を更新します。 */
  routeApp.put('/api/teams/:teamId/issues/:issueId/presence', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')
    const issueId = c.req.param('issueId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const { context, detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
      const body = await readJson<TeamIssuePresenceRequestBody>(c.req) ?? {}
      const typing = readPresenceTyping(body.typing)

      if (typing && !canWriteTeamIssue(principal, context, detail.issue.assignedProjectId)) {
        throw new WorkspaceAccessError(403, 'WorkspaceRoleDenied', 'Comment permission is required.')
      }

      await workItemDependencies.collaboration.heartbeatPresence({
        entityKey: createWorkItemCollaborationEntityKey(principal.directoryId, teamId, issueId),
        memberKey: principal.userKey,
        clientId: readPresenceClientId(body.clientId),
        typing,
      })
      return c.json({})
    } catch (error) {
      return toCollaborationErrorResponse(c, error)
    }
  })

  /** Browser tab の Work Item presence を削除します。 */
  routeApp.delete('/api/teams/:teamId/issues/:issueId/presence/:clientId', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const teamId = c.req.param('teamId')
    const issueId = c.req.param('issueId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
      await workItemDependencies.collaboration.leavePresence({
        entityKey: createWorkItemCollaborationEntityKey(principal.directoryId, teamId, issueId),
        memberKey: principal.userKey,
        clientId: readPresenceClientId(c.req.param('clientId')),
      })
      return c.json({})
    } catch (error) {
      return toCollaborationErrorResponse(c, error)
    }
  })

  /** Work Item file version の approval request を作成する endpoint です。 */
  routeApp.post('/api/teams/:teamId/issues/:issueId/approvals', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const { scope, actor, workItem } = await loadFileProofingRequestContext(
        c,
        principal,
        'work-item',
      )
      const canonicalWorkItem = requireCanonicalFileProofingWorkItem(workItem)
      if (!actor.canWrite || actor.guest) {
        throw new FileProofingError(403, 'FileWriteDenied', 'File write access is required.')
      }
      const body = await readFileProofingJson<CreateFileApprovalInput>(c.req)
      if (
        !Array.isArray(body.reviewerMemberKeys) ||
        body.reviewerMemberKeys.length === 0 ||
        body.reviewerMemberKeys.length > FILE_APPROVAL_MAX_REVIEWERS ||
        body.reviewerMemberKeys.some((memberKey) =>
          typeof memberKey !== 'string' || !memberKey.trim() || memberKey.length > 320
        )
      ) {
        throw new FileProofingError(400, 'InvalidApprovalReviewers', 'Approval reviewers are required.')
      }
      const reviewerMemberKeys = [...new Set(
        body.reviewerMemberKeys.map((memberKey) => memberKey.trim().toLowerCase()),
      )]
      if (reviewerMemberKeys.length > FILE_APPROVAL_MAX_REVIEWERS) {
        throw new FileProofingError(400, 'InvalidApprovalReviewers', 'Too many approval reviewers.')
      }
      const collection = await workItemDependencies.fileProofing.list(scope, actor)
      const targetFile = collection.files.find((file) => file.id === body.fileId)
      if (!targetFile || targetFile.currentVersion.id !== body.versionId) {
        throw new FileProofingError(
          409,
          'ApprovalVersionStale',
          'Approval must target the current file version.',
        )
      }
      const reviewerMembers = await requireApprovalReviewers(
        principal.directoryId,
        scope.teamId,
        scope.projectId,
        reviewerMemberKeys,
      )
      if (reviewerMembers.some((member) => member.role === 'guest')) {
        if (!targetFile?.guestAccess) {
          throw new FileProofingError(
            409,
            'ApprovalGuestFileAccessDenied',
            'Guest reviewers require an explicitly guest-shared file.',
          )
        }
      }
      if (body.completionTransition !== undefined) {
        await resolveFileApprovalCompletionTransition(
          principal.directoryId,
          scope.teamId,
          canonicalWorkItem,
          body.completionTransition,
        )
      }
      const input = {
        ...body,
        reviewerMemberKeys,
      } satisfies CreateFileApprovalInput
      return c.json({
        approval: await workItemDependencies.fileProofing.createApproval(
          scope,
          actor,
          input,
          createApiMutationContext(c, principal, input),
        ),
      }, 201)
    } catch (error) {
      return toFileProofingErrorResponse(c, error)
    }
  })

  /** Assigned reviewer の approval decision を保存する endpoint です。 */
  routeApp.post('/api/teams/:teamId/issues/:issueId/approvals/:approvalId/decisions', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const { scope, actor, workItem } = await loadFileProofingRequestContext(
        c,
        principal,
        'work-item',
      )
      const canonicalWorkItem = requireCanonicalFileProofingWorkItem(workItem)
      const body = await readFileProofingJson<CreateFileApprovalDecisionInput>(c.req)
      const input = { ...body } satisfies CreateFileApprovalDecisionInput
      let resolvedCompletionTransition: FileApprovalCompletionTransition | undefined
      const resolveCompletionTransition: FileApprovalCompletionTransitionResolver = async (
        completionTransition,
      ) => {
        const resolved = await resolveFileApprovalCompletionTransitionForDecision(
          principal.directoryId,
          scope.teamId,
          canonicalWorkItem,
          completionTransition,
        )
        resolvedCompletionTransition = resolved
        return resolved
      }
      const approval = await workItemDependencies.fileProofing.decideApproval(
        scope,
        actor,
        readRequiredRouteId(c.req.param('approvalId'), 'Approval ID'),
        input,
        createApiMutationContext(c, principal, input),
        resolveCompletionTransition,
      )
      if (approval.status === 'approved' && resolvedCompletionTransition) {
        await refreshWorkItemSearchDocumentBestEffort(
          principal.directoryId,
          scope.teamId,
          canonicalWorkItem.id,
          'approval completion transition',
        )
      }
      return c.json({ approval })
    } catch (error) {
      return toFileProofingErrorResponse(c, error)
    }
  })

  /** Requester または manager が pending approval を取り消す endpoint です。 */
  routeApp.post('/api/teams/:teamId/issues/:issueId/approvals/:approvalId/cancel', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const { scope, actor } = await loadFileProofingRequestContext(
        c,
        principal,
        'work-item',
      )
      const body = await readFileProofingJson<CancelFileApprovalInput>(c.req)
      const input = {
        expectedRevision: body.expectedRevision,
      } satisfies CancelFileApprovalInput
      return c.json({
        approval: await workItemDependencies.fileProofing.cancelApproval(
          scope,
          actor,
          readRequiredRouteId(c.req.param('approvalId'), 'Approval ID'),
          input,
          createApiMutationContext(c, principal, input),
        ),
      })
    } catch (error) {
      return toFileProofingErrorResponse(c, error)
    }
  })

  /** 現在 reviewer の未完了 approval を Workspace 横断で返す endpoint です。 */
  routeApp.get('/api/approvals/reviewer', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      return c.json(await listAuthorizedReviewerApprovals(principal, {
        ...(c.req.query('cursor') ? { cursor: c.req.query('cursor') } : {}),
        ...(c.req.query('limit') ? { limit: Number(c.req.query('limit')) } : {}),
      }))
    } catch (error) {
      return toFileProofingErrorResponse(c, error)
    }
  })

  /**
   * DynamoDB に保存されたプロジェクト遂行 Issue 一覧を返す endpoint です。
   */
  routeApp.get('/api/projects/:projectId/issues', async (c) => {
    const accessToken = readBearerAccessToken(c)
    const projectId = c.req.param('projectId')

    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    if (!projectId) {
      return c.json({ message: 'Project ID is required.' }, 400)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      await requireProjectPermission(principal, projectId, 'viewer')
      const includeArchived = readOptionalIncludeArchivedQuery(c.req.query('includeArchived'))
      const workItemTypeId = readOptionalProjectWorkItemTypeIdQuery(c.req.query('workItemTypeId'))

      const response = await hydrateProjectIssuesResponse(
        await readProjectIssues(principal.directoryId, projectId, includeArchived, workItemTypeId),
      )
      return c.json({
        ...response,
        canReadCustomerImpact: hasCustomerReadAccess(principal, { projectId }),
      })
    } catch (error) {
      if (error instanceof CognitoServiceError) {
        return toCognitoDirectoryErrorResponse(c, error)
      }

      return toProjectDataErrorResponse(c, error)
    }
  })
}
