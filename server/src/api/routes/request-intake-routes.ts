import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import {
  createDefaultUnscheduledWorkItemSchedule,
  type CreateManualTriageEntryInput,
  type TriageBulkActionInput,
  type TriageBulkActionResult,
  type TriageConfiguration,
  type TriageActionInput,
  type UpdateTriageConfigurationInput,
  type CustomFieldValue,
} from '@mukuroji/contracts'
import type { Hono } from 'hono'
import { getConnInfo } from 'hono/aws-lambda'
import type { Context } from 'hono'
import { ProjectDataError } from '../../modules/directory'
import {
  getConfiguredAuditTableName,
  getConfiguredAuditRetentionDays,
} from '../../modules/audit/audit'
import { createWorkItemRevisionConditionCheck } from '../../modules/work-items'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import {
  RequestIntakeError,
  createRequestWorkItemInput,
  type RequestExternalContext,
  type RequestLinkResolution,
} from '../../modules/request-intake/request-intake'
import {
  createAdminRequestIntakeRouter,
} from '../../modules/request-intake/adapter-in/http/admin-request-intake-router'
import {
  createPublicRequestIntakeRouter,
} from '../../modules/request-intake/adapter-in/http/public-request-intake-router'
import {
  createTriageAcceptanceTransactionItems,
  createTriageActionTransactionItems,
  createTriageBulkTargetIdempotencyKey,
  createTriageConfigurationRevisionConditionCheck,
  createTriageInputFingerprint,
  createTriageRouter,
  TriageError,
  type TriageAuthorizationConditionChecks,
  type TriageRouterBulkActionRequest,
  type TriageRouterActionRequest,
} from '../../modules/triage'
import { workItemDependencies, workspaceDependencies } from '../shared/app-dependencies'
import { TRIAGE_NON_GUEST_MEMBER_CONDITION_OPTIONS } from '../shared/constants'
import { requireTriageTeamAccess } from '../shared/customer-access'
import { projectWorkItemSearchDocumentBestEffort } from '../shared/document-access'
import { readBearerAccessToken, readJson, resolveRequestClientKey } from '../shared/http'
import { readOptionalPositiveQueryInteger } from '../shared/input-parsing'
import {
  createApiMutationContext,
  createEnterpriseControlAuthorizationConditionCheck,
  isEnterpriseTriageTeamScope,
  requireAssignedProjectPermission,
  requireTeamPermission,
  type WorkspacePrincipal,
} from '../shared/project-access'
import {
  authenticateWorkspacePrincipal,
  requireRequestAdministration,
} from '../shared/request-authorization'
import {
  createDeterministicTriageWorkItemId,
  createTriageActionReferenceConditionChecks,
  createTriageActiveActorConditionChecks,
  createTriageProjectAuthorizationConditionChecks,
  mergeTriageConditionChecks,
  toRequestIntakeErrorResponse,
  toTriageErrorResponse,
  validateRequestFormRoutingReferences,
} from '../shared/request-intake-access'
import { getEnv } from '../shared/runtime-config'
import {
  getTeamIssuesTableName,
  loadAuthorizedTeamIssue,
  normalizeTeamIssueInput,
} from '../shared/work-item-access'
import {
  filterRequestConversionCustomFieldValues,
  prepareConfiguredCreateWorkItem,
} from '../shared/work-item-configuration'
import {
  projectAccessAllows,
  requireActiveWorkspaceAssignee,
  type TeamPermissionContext,
} from '../shared/workspace-access'

async function authorizeRequestLink(c: Context, resolution: RequestLinkResolution) {
  if (resolution.accessMode === 'public') return
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    throw new RequestIntakeError(
      401,
      'RequestAuthenticationRequired',
      'Authentication is required for this request form.',
    )
  }
  const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
  if (principal.directoryId !== resolution.workspaceId) {
    throw new RequestIntakeError(404, 'RequestFormUnavailable', 'Request form is unavailable.')
  }
}

function createRequestExternalContext(c: Context): RequestExternalContext {
  let trustedSource: string | undefined
  try {
    trustedSource = getConnInfo(c).remote.address
  } catch {
    trustedSource = undefined
  }
  const trustedProxyAddresses = new Set(
    (getEnv('MUKUROJI_REQUEST_TRUSTED_PROXY_ADDRESSES') ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  const source = resolveRequestClientKey(
    trustedSource,
    c.req.header('X-Forwarded-For'),
    trustedProxyAddresses,
  )
  return {
    clientKey: source,
    ...(c.req.header('Idempotency-Key')?.trim()
      ? { idempotencyKey: c.req.header('Idempotency-Key')!.trim() }
      : {}),
  }
}

function readRequestSubmissionStatus(value: string | undefined) {
  if (value === undefined) return undefined
  if (
    value === 'received' ||
    value === 'triaging' ||
    value === 'needs-more-info' ||
    value === 'rejected' ||
    value === 'duplicate' ||
    value === 'converted'
  ) return value
  throw new RequestIntakeError(400, 'InvalidRequestIntakeInput', 'Request status is invalid.')
}

/**
 * Validates live member and Project references used by one bulk Triage mutation.
 *
 * @param context - Authenticated Hono request context.
 * @param teamId - Team whose entries will be changed.
 * @param input - Strictly parsed bulk action.
 */
async function validateTriageBulkAction(
  context: Context,
  teamId: string,
  input: TriageBulkActionInput,
): Promise<number> {
  const principal = await authenticateTriagePrincipal(context)
  const configuration = await workItemDependencies.triage.getConfiguration(
    principal.directoryId,
    teamId,
  )
  if (!configuration.allowedBulkActions.includes(input.operation.action)) {
    throw new TriageError(
      409,
      'TriageBulkActionDisabled',
      'This bulk action is disabled by the current Team Triage configuration.',
    )
  }
  if (input.operation.action !== 'assign') return configuration.revision
  const teamContext = await requireTeamPermission(principal, teamId, 'member')
  if (input.operation.ownerUserId) {
    await requireActiveWorkspaceAssignee(
      principal.directoryId,
      input.operation.ownerUserId,
    )
  }
  if (input.operation.projectId) {
    requireAssignedProjectPermission(
      principal,
      teamContext,
      input.operation.projectId,
      'member',
    )
  }
  return configuration.revision
}

/**
 * Replaces caller-asserted manual routing metadata with current Team settings.
 *
 * @param context - Authenticated Hono request context.
 * @param teamId - Team receiving the handoff.
 * @param input - Strictly parsed source content.
 * @returns A handoff carrying server-derived Project, owner, SLA, and retention values.
 */
async function prepareTriageManualHandoff(
  context: Context,
  teamId: string,
  input: CreateManualTriageEntryInput,
): Promise<CreateManualTriageEntryInput> {
  const principal = await authenticateTriagePrincipal(context)
  const teamContext = await requireTeamPermission(principal, teamId, 'member')
  const configuration = await workItemDependencies.triage.getConfiguration(
    principal.directoryId,
    teamId,
  )
  const searchableText = `${input.title}\n${input.body}`.toLocaleLowerCase('en-US')
  const rule = [...configuration.rules]
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .find((candidate) =>
      candidate.enabled &&
      candidate.sourceKinds.includes('manual-handoff') &&
      (
        candidate.keywords.length === 0 ||
        candidate.keywords.some((keyword) =>
          searchableText.includes(keyword.toLocaleLowerCase('en-US'))
        )
      )
    )
  const projectId = rule?.projectId ?? input.projectId
  requireAssignedProjectPermission(principal, teamContext, projectId, 'member')
  const ownerStrategy = rule?.owner
  const ownerUserId = resolveConfiguredTriageOwner(configuration, ownerStrategy)
  const liveOwnerIds = ownerStrategy?.type === 'rotation'
    ? configuration.rotations.find((rotation) => rotation.id === ownerStrategy.rotationId)
      ?.memberUserIds ?? []
    : ownerUserId ? [ownerUserId] : []
  const slaPolicy = configuration.slaPolicies.find((policy) =>
    policy.sourceKinds.includes('manual-handoff')
  )
  const configuredOwnerIds = new Set([
    ...liveOwnerIds,
    ...(slaPolicy?.escalationOwnerUserId ? [slaPolicy.escalationOwnerUserId] : []),
  ])
  await Promise.all([...configuredOwnerIds].map(async (memberUserId) => {
    await requireTriageOwnerProjectAccess(
      principal.directoryId,
      projectId,
      memberUserId,
    )
  }))
  const now = new Date()
  const slaDueAt = slaPolicy
    ? new Date(now.getTime() + slaPolicy.responseMinutes * 60_000)
    : undefined
  const escalationDueAt = slaDueAt && slaPolicy?.escalationMinutes !== undefined
    ? new Date(slaDueAt.getTime() + slaPolicy.escalationMinutes * 60_000)
    : undefined
  const retentionExpiresAt = new Date(now)
  retentionExpiresAt.setUTCDate(retentionExpiresAt.getUTCDate() + configuration.retentionDays)
  return {
    sourceId: input.sourceId,
    title: input.title,
    body: input.body,
    requesterDisplayName: input.requesterDisplayName,
    ...(input.requesterEmail ? { requesterEmail: input.requesterEmail } : {}),
    ...(projectId ? { projectId } : {}),
    routingReason: rule
      ? `Matched Team Triage routing rule "${rule.name}".`
      : 'No enabled Team Triage routing rule matched; the handoff remained in the selected Team.',
    ...(ownerUserId ? { ownerUserId } : {}),
    ...(slaPolicy && slaDueAt
      ? {
          slaPolicyId: slaPolicy.id,
          slaDueAt: slaDueAt.toISOString(),
          ...(escalationDueAt ? { escalationDueAt: escalationDueAt.toISOString() } : {}),
        }
      : {}),
    preparedConfigurationRevision: configuration.revision,
    retentionExpiresAt: retentionExpiresAt.toISOString(),
  }
}

/** Builds caller authorization fences for one manual Triage handoff. */
async function createTriageManualHandoffAuthorizationConditionChecks(
  context: Context,
  teamId: string,
  input: CreateManualTriageEntryInput,
): Promise<TriageAuthorizationConditionChecks> {
  const principal = await authenticateTriagePrincipal(context)
  const teamContext = await requireTeamPermission(principal, teamId, 'member')
  if (principal.isSystemAdmin) return []
  return mergeTriageConditionChecks(
    await createTriageActiveActorConditionChecks(
      principal,
      TRIAGE_NON_GUEST_MEMBER_CONDITION_OPTIONS,
    ),
    await createTriageProjectAuthorizationConditionChecks(
      principal,
      teamContext,
      principal.directoryId,
      teamId,
      input.projectId,
    ),
    await createTriageAssigneeProjectAuthorizationConditionChecks(
      principal.directoryId,
      input.projectId,
      input.ownerUserId,
    ),
  )
}

/** Validates that a configured Triage owner can work within the destination Project. */
async function requireTriageOwnerProjectAccess(
  workspaceId: string,
  projectId: string | undefined,
  ownerUserId: string,
): Promise<void> {
  await requireActiveWorkspaceAssignee(workspaceId, ownerUserId)
  if (!projectId) return
  const access = await workspaceDependencies.projectDirectory.getProjectAccess(
    workspaceId,
    projectId,
    ownerUserId,
  )
  if (!access || !projectAccessAllows(access, 'member')) {
    throw new ProjectDataError(
      409,
      'TriageAssigneeProjectAccessDenied',
      'The configured Triage owner cannot access the destination Project.',
    )
  }
}

/** Builds the commit-time Project membership fence for the assigned Triage owner. */
async function createTriageAssigneeProjectAuthorizationConditionChecks(
  workspaceId: string,
  projectId: string | undefined,
  ownerUserId: string | undefined,
): Promise<TriageAuthorizationConditionChecks> {
  if (!projectId || !ownerUserId) return []
  const createAccessConditionCheck = workspaceDependencies.projectDirectory
    .createProjectAccessConditionCheck
  if (!createAccessConditionCheck) {
    throw new TriageError(
      503,
      'TriageAssigneeProjectAccessFenceUnavailable',
      'Triage owner Project authorization fencing is unavailable. Retry the request.',
    )
  }
  const conditionCheck = await createAccessConditionCheck(
    workspaceId,
    projectId,
    ownerUserId,
    'member',
  )
  if (!conditionCheck) {
    throw new TriageError(
      409,
      'TriageAssigneeProjectAccessChanged',
      'The assigned Triage owner no longer has access to the destination Project.',
    )
  }
  return [conditionCheck]
}

/**
 * Resolves a fixed or rotation-backed owner from one current Team configuration.
 *
 * @param configuration - Current Team Triage configuration.
 * @param strategy - Matched routing rule owner strategy.
 * @returns The selected active-member candidate, or undefined for unowned routing.
 */
function resolveConfiguredTriageOwner(
  configuration: TriageConfiguration,
  strategy: TriageConfiguration['rules'][number]['owner'] | undefined,
): string | undefined {
  if (!strategy || strategy.type === 'unowned') return undefined
  if (strategy.type === 'fixed') return strategy.ownerUserId
  const rotation = configuration.rotations.find((candidate) =>
    candidate.id === strategy.rotationId
  )
  return rotation?.memberUserIds[rotation.nextIndex]
}

/**
 * Validates every live directory reference before Team Triage settings are persisted.
 *
 * @param context - Authenticated Hono request context.
 * @param teamId - Team owning the replacement configuration.
 * @param input - Strictly parsed replacement settings.
 */
async function validateTriageConfigurationReferences(
  context: Context,
  teamId: string,
  input: UpdateTriageConfigurationInput,
): Promise<TriageAuthorizationConditionChecks> {
  const principal = await authenticateTriagePrincipal(context)
  const teamContext = await requireTeamPermission(principal, teamId, 'manager')
  const memberUserIds = new Set<string>()
  for (const rotation of input.rotations) {
    for (const memberUserId of rotation.memberUserIds) memberUserIds.add(memberUserId)
  }
  for (const rule of input.rules) {
    if (rule.teamId !== teamId) {
      throw new TriageError(
        400,
        'InvalidTriageConfiguration',
        'A routing rule cannot target another Team.',
      )
    }
    requireAssignedProjectPermission(principal, teamContext, rule.projectId, 'manager')
    if (rule.owner.type === 'fixed') memberUserIds.add(rule.owner.ownerUserId)
  }
  for (const policy of input.slaPolicies) {
    if (policy.escalationOwnerUserId) memberUserIds.add(policy.escalationOwnerUserId)
  }
  await Promise.all([...memberUserIds].map(async (memberUserId) => {
    await requireActiveWorkspaceAssignee(principal.directoryId, memberUserId)
  }))
  return await createTriageConfigurationAuthorizationConditionChecks(
    principal,
    teamContext,
    principal.directoryId,
    teamId,
  )
}

/**
 * Authenticates a Triage integration hook and denies Workspace guests.
 *
 * @param context - Current Hono request context.
 * @returns The live Workspace principal.
 */
async function authenticateTriagePrincipal(context: Context): Promise<WorkspacePrincipal> {
  const accessToken = readBearerAccessToken(context)
  if (!accessToken) {
    throw new TriageError(401, 'TriageAuthenticationRequired', 'Bearer token is required.')
  }
  const principal = await authenticateWorkspacePrincipal(accessToken, undefined, context)
  if (principal.workspaceRole === 'guest') {
    throw new WorkspaceAccessError(
      403,
      'WorkspaceRoleDenied',
      'Guest members cannot mutate Team Triage.',
    )
  }
  return principal
}

/**
 * Enforces current Work Item scope before returning reverse Triage source links.
 *
 * @param context - Current Hono request context.
 * @param teamId - Owning Team identifier.
 * @param workItemId - Canonical Work Item identifier.
 */
async function requireTriageWorkItemAccess(
  context: Context,
  teamId: string,
  workItemId: string,
): Promise<void> {
  const accessToken = readBearerAccessToken(context)
  if (!accessToken) {
    throw new TriageError(401, 'TriageAuthenticationRequired', 'Bearer token is required.')
  }
  const principal = await authenticateWorkspacePrincipal(accessToken, undefined, context)
  if (principal.workspaceRole === 'guest') {
    throw new WorkspaceAccessError(
      403,
      'WorkspaceRoleDenied',
      'Guest members cannot access Triage source links.',
    )
  }
  await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'viewer')
}

/**
 * Applies an authorized Triage action, intercepting Work Item-dependent operations.
 *
 * @param request - Validated Triage action request from the HTTP adapter.
 * @returns The replay-safe mutation receipt.
 */
async function applyTriageRouteAction(request: TriageRouterActionRequest) {
  const accessToken = readBearerAccessToken(request.context)
  if (!accessToken) {
    throw new TriageError(401, 'TriageAuthenticationRequired', 'Bearer token is required.')
  }
  const principal = await authenticateWorkspacePrincipal(
    accessToken,
    undefined,
    request.context,
  )
  if (principal.directoryId !== request.workspaceId || principal.userKey !== request.actor.id) {
    throw new TriageError(404, 'TriageEntryNotFound', 'The triage entry was not found.')
  }
  const currentEntry = await workItemDependencies.triage.getEntryForMutation(
    request.workspaceId,
    request.teamId,
    request.entryId,
  )
  const currentTeamContext = await requireTeamPermission(principal, request.teamId, 'member')
  requireAssignedProjectPermission(
    principal,
    currentTeamContext,
    currentEntry.projectId,
    'member',
  )
  let authorizationConditionChecks = mergeTriageConditionChecks(
    request.authorizationConditionChecks ?? [],
    await createTriageProjectAuthorizationConditionChecks(
      principal,
      currentTeamContext,
      request.workspaceId,
      request.teamId,
      currentEntry.projectId,
    ),
  )

  if (request.action.action === 'assign') {
    if (request.action.ownerUserId) {
      const destinationProjectId = request.action.projectId === null
        ? undefined
        : request.action.projectId ?? currentEntry.projectId
      await requireTriageOwnerProjectAccess(
        request.workspaceId,
        destinationProjectId,
        request.action.ownerUserId,
      )
      authorizationConditionChecks = mergeTriageConditionChecks(
        authorizationConditionChecks,
        await createTriageAssigneeProjectAuthorizationConditionChecks(
          request.workspaceId,
          destinationProjectId,
          request.action.ownerUserId,
        ),
      )
    }
    if (request.action.projectId) {
      requireAssignedProjectPermission(
        principal,
        currentTeamContext,
        request.action.projectId,
        'member',
      )
      authorizationConditionChecks.push(...await createTriageProjectAuthorizationConditionChecks(
        principal,
        currentTeamContext,
        request.workspaceId,
        request.teamId,
        request.action.projectId,
      ))
    }
  }

  const action = request.action
  if (action.action === 'accept' && action.mode === 'create') {
    authorizationConditionChecks = mergeTriageConditionChecks(
      authorizationConditionChecks,
      await createTriageProjectAuthorizationConditionChecks(
        principal,
        currentTeamContext,
        request.workspaceId,
        request.teamId,
        action.projectId ?? currentEntry.projectId,
      ),
    )
    return await acceptTriageEntryAsNewWorkItem(
      principal,
      { ...request, action, authorizationConditionChecks },
    )
  }

  if (action.action === 'request-information') {
    return await requestTriageInformationFromSource(principal, {
      ...request,
      action,
      authorizationConditionChecks,
    })
  }

  if (
    currentEntry.source.kind === 'form' &&
    currentEntry.source.submissionId &&
    (action.action === 'assign' || action.action === 'decline')
  ) {
    const replay = await workItemDependencies.triage.getActionReceipt(
      request.workspaceId,
      request.teamId,
      request.entryId,
      request.idempotency,
    )
    if (replay) return replay
    const submission = await workItemDependencies.requestIntake.getSubmission(
      request.workspaceId,
      currentEntry.source.submissionId,
    )
    const contribution = createTriageActionTransactionItems({
      tableName: getEnv('REQUEST_INTAKE_TABLE_NAME') ?? 'mukuroji-request-intake-local',
      audit: {
        tableName: getConfiguredAuditTableName() ?? 'mukuroji-audit-events',
        retentionDays: getConfiguredAuditRetentionDays(),
      },
      entry: currentEntry,
      action,
      actorId: principal.userKey,
      now: new Date().toISOString(),
      idempotency: request.idempotency,
      auditContext: request.auditContext,
    })
    const referenceChecks = await createTriageActionReferenceConditionChecks(
      request.workspaceId,
      request.teamId,
      currentEntry,
      action,
    )
    const configurationCheck = request.configurationRevision === undefined
      ? []
      : [createTriageConfigurationRevisionConditionCheck(
          getEnv('REQUEST_INTAKE_TABLE_NAME') ?? 'mukuroji-request-intake-local',
          request.workspaceId,
          request.teamId,
          request.configurationRevision,
        )]
    await workItemDependencies.requestIntake.applyAction(
      request.workspaceId,
      submission.id,
      { id: principal.userKey },
      action.action === 'assign'
        ? {
            action: 'assign',
            expectedRevision: submission.revision,
            assigneeUserId: action.ownerUserId,
          }
        : {
            action: 'reject',
            expectedRevision: submission.revision,
            reason: action.reason,
          },
      mergeTriageConditionChecks(
        authorizationConditionChecks,
        configurationCheck,
        referenceChecks,
        contribution.transactItems,
      ),
    )
    return { entry: contribution.entry, replayed: false }
  }

  if (action.action === 'duplicate' || action.action === 'accept' && action.mode === 'link') {
    const workItemId = action.action === 'duplicate'
      ? action.canonicalWorkItemId
      : action.workItemId
    const { context: targetTeamContext, detail } = await loadAuthorizedTeamIssue(
      principal,
      request.teamId,
      workItemId,
      'member',
    )
    authorizationConditionChecks = mergeTriageConditionChecks(
      authorizationConditionChecks,
      await createTriageProjectAuthorizationConditionChecks(
        principal,
        targetTeamContext,
        request.workspaceId,
        request.teamId,
        detail.issue.assignedProjectId,
      ),
    )
    if (currentEntry.source.kind === 'form' && currentEntry.source.submissionId) {
      const replay = await workItemDependencies.triage.getActionReceipt(
        request.workspaceId,
        request.teamId,
        request.entryId,
        request.idempotency,
      )
      if (replay) return replay
      const now = new Date().toISOString()
      const duplicateContext = action.action === 'duplicate'
        ? workItemDependencies.teamIssues.createTriageDuplicateContextTransactionItems?.({
            directoryId: request.workspaceId,
            teamId: detail.issue.teamId,
            workItemId: detail.issue.id,
            expectedWorkItemRevision: detail.issue.revision,
            actorUserId: principal.userKey,
            entry: currentEntry,
            mergedAt: now,
          })
        : undefined
      if (action.action === 'duplicate' && !duplicateContext) {
        throw new TriageError(
          503,
          'TriageDuplicateContextUnavailable',
          'Duplicate context preservation is unavailable.',
        )
      }
      const contribution = createTriageAcceptanceTransactionItems({
        tableName: getEnv('REQUEST_INTAKE_TABLE_NAME') ?? 'mukuroji-request-intake-local',
        entry: currentEntry,
        action,
          canonicalWorkItem: {
            teamId: detail.issue.teamId,
            workItemId: detail.issue.id,
            ...(detail.issue.workItemTypeId
              ? { workItemTypeId: detail.issue.workItemTypeId }
              : {}),
            ...(detail.issue.assignedProjectId
              ? { projectId: detail.issue.assignedProjectId }
              : {}),
        },
        actorId: principal.userKey,
        now,
        idempotency: request.idempotency,
        ...(action.action === 'duplicate'
          ? {
              mergeReceipt: {
                canonicalWorkItemId: detail.issue.id,
                mergedSourceCount: 1,
                mergedCommentCount: duplicateContext?.snapshot.commentMetadataCount ?? 0,
                mergedAttachmentCount: duplicateContext?.snapshot.attachmentMetadataCount ?? 0,
                mergedWatcherCount: duplicateContext?.snapshot.watcherMetadataCount ?? 0,
                completedAt: now,
              },
            }
          : {}),
      })
      const submission = await workItemDependencies.requestIntake.getSubmission(
        request.workspaceId,
        currentEntry.source.submissionId,
      )
      await workItemDependencies.requestIntake.completeConversion(
        request.workspaceId,
        submission.id,
        { id: principal.userKey },
        {
          expectedRevision: submission.revision,
          workItem: {
            teamId: detail.issue.teamId,
            workItemId: detail.issue.id,
            ...(detail.issue.assignedProjectId
              ? { projectId: detail.issue.assignedProjectId }
              : {}),
          },
        },
        [
          ...authorizationConditionChecks,
          ...(action.action === 'accept'
            ? [createWorkItemRevisionConditionCheck(
                getTeamIssuesTableName(),
                request.workspaceId,
                detail.issue.teamId,
                detail.issue.id,
                detail.issue.revision,
              )]
            : []),
          ...(duplicateContext?.transactItems ?? []),
          ...contribution.transactItems,
        ],
      )
      return { entry: contribution.entry, replayed: false }
    }
  }

  return await workItemDependencies.triage.applyAction(
    request.workspaceId,
    request.teamId,
    request.entryId,
    request.actor,
    request.action,
    request.idempotency,
    request.auditContext,
    request.configurationRevision,
    mergeTriageConditionChecks(authorizationConditionChecks),
  )
}

/** Builds commit-time authorization fences for replacing a full Team configuration. */
async function createTriageConfigurationAuthorizationConditionChecks(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
  workspaceId: string,
  teamId: string,
): Promise<TriageAuthorizationConditionChecks> {
  if (principal.isSystemAdmin) return []
  if (isEnterpriseTriageTeamScope(principal, teamId)) {
    const enterpriseControlCheck = createEnterpriseControlAuthorizationConditionCheck(principal)
    return mergeTriageConditionChecks(
      await createTriageActiveActorConditionChecks(
        principal,
        TRIAGE_NON_GUEST_MEMBER_CONDITION_OPTIONS,
      ),
      enterpriseControlCheck ? [enterpriseControlCheck] : [],
    )
  }
  if (principal.workspaceRole === 'owner' || principal.workspaceRole === 'admin') {
    return await createTriageActiveActorConditionChecks(principal, {
      allowedRoles: ['owner', 'admin'],
    })
  }
  const authorizationConditionChecks = await createTriageActiveActorConditionChecks(
    principal,
    TRIAGE_NON_GUEST_MEMBER_CONDITION_OPTIONS,
  )
  for (const project of context.team.projects) {
    authorizationConditionChecks.push(...await createTriageProjectAuthorizationConditionChecks(
      principal,
      context,
      workspaceId,
      teamId,
      project.id,
      'manager',
    ))
  }
  return mergeTriageConditionChecks(authorizationConditionChecks)
}

/**
 * Applies a bounded bulk operation through the same source-aware path as single actions.
 *
 * @param request - Authorized bulk action request from the HTTP adapter.
 * @returns One independently classified result for every target.
 */
async function applyTriageBulkRouteAction(
  request: TriageRouterBulkActionRequest,
): Promise<TriageBulkActionResult> {
  const results: TriageBulkActionResult['results'] = []
  const preparedTargets = request.input.targets.map((target) => {
    const action = createTriageBulkTargetAction(target, request.input.operation)
    const idempotency = {
      key: createTriageBulkTargetIdempotencyKey(
        request.idempotencyKey,
        target.entryId,
      ),
      fingerprint: createTriageInputFingerprint({
        target,
        operation: request.input.operation,
      }),
    }
    const auditContext = request.createAuditContext(target.entryId, idempotency)
    return { action, auditContext, idempotency, target }
  })
  for (const { action, auditContext, idempotency, target } of preparedTargets) {
    try {
      const receipt = await applyTriageRouteAction({
        context: request.context,
        workspaceId: request.workspaceId,
        teamId: request.teamId,
        entryId: target.entryId,
        actor: request.actor,
        action,
        idempotency,
        auditContext,
        configurationRevision: request.configurationRevision,
      })
      results.push({ entryId: target.entryId, status: 'succeeded', entry: receipt.entry })
    } catch (error) {
      if (
        error instanceof TriageError && error.status === 409 ||
        error instanceof RequestIntakeError && error.status === 409
      ) {
        results.push({
          entryId: target.entryId,
          status: 'conflict',
          errorCode: error.code,
        })
        continue
      }
      results.push({
        entryId: target.entryId,
        status: 'failed',
        errorCode: error instanceof TriageError || error instanceof RequestIntakeError ||
            error instanceof ProjectDataError || error instanceof WorkspaceAccessError
          ? error.code
          : 'TriageBulkTargetFailed',
      })
    }
  }
  return { results }
}

/**
 * Expands one bulk operation into a revision-fenced single-entry action.
 *
 * @param target - Entry ID and revision viewed by the operator.
 * @param operation - Validated operation shared by the bulk request.
 * @returns The equivalent single-entry Triage action.
 */
function createTriageBulkTargetAction(
  target: TriageBulkActionInput['targets'][number],
  operation: TriageBulkActionInput['operation'],
): Exclude<TriageActionInput, { action: 'accept' | 'duplicate' | 'request-information' }> {
  if (operation.action === 'assign') {
    return {
      action: 'assign',
      expectedRevision: target.expectedRevision,
      ownerUserId: operation.ownerUserId,
      ...(operation.projectId === undefined ? {} : { projectId: operation.projectId }),
    }
  }
  if (operation.action === 'decline') {
    return {
      action: 'decline',
      expectedRevision: target.expectedRevision,
      reason: operation.reason,
    }
  }
  return {
    action: 'snooze',
    expectedRevision: target.expectedRevision,
    until: operation.until,
  }
}

/**
 * Delivers a Form-source information request and updates Triage in one transaction.
 *
 * Other source kinds fail closed until their production delivery adapter is composed;
 * the queue must never claim that a message was requested when no provider send occurred.
 *
 * @param principal - Current live-authorized Workspace principal.
 * @param request - Validated request-information action.
 * @returns The newly committed or replayed Triage receipt.
 */
async function requestTriageInformationFromSource(
  principal: WorkspacePrincipal,
  request: TriageRouterActionRequest & {
    action: Extract<TriageRouterActionRequest['action'], { action: 'request-information' }>
  },
) {
  const replay = await workItemDependencies.triage.getActionReceipt(
    request.workspaceId,
    request.teamId,
    request.entryId,
    request.idempotency,
  )
  if (replay) return replay
  const entry = await workItemDependencies.triage.getEntryForMutation(
    request.workspaceId,
    request.teamId,
    request.entryId,
  )
  if (entry.source.kind !== 'form' || !entry.source.submissionId) {
    throw new TriageError(
      409,
      'TriageReplyAdapterUnavailable',
      'The source reply adapter is unavailable for this entry.',
    )
  }
  const submission = await workItemDependencies.requestIntake.getSubmission(
    request.workspaceId,
    entry.source.submissionId,
  )
  const entryWithMessageCount = {
    ...entry,
    sourcePreview: {
      ...entry.sourcePreview,
      commentCount: entry.sourcePreview.commentCount + 1,
    },
  }
  const contribution = createTriageActionTransactionItems({
    tableName: getEnv('REQUEST_INTAKE_TABLE_NAME') ?? 'mukuroji-request-intake-local',
    audit: {
      tableName: getConfiguredAuditTableName() ?? 'mukuroji-audit-events',
      retentionDays: getConfiguredAuditRetentionDays(),
    },
    entry: entryWithMessageCount,
    action: request.action,
    actorId: principal.userKey,
    now: new Date().toISOString(),
    idempotency: request.idempotency,
    auditContext: request.auditContext,
  })
  const referenceChecks = await createTriageActionReferenceConditionChecks(
    request.workspaceId,
    request.teamId,
    entry,
    request.action,
  )
  await workItemDependencies.requestIntake.applyAction(
    request.workspaceId,
    submission.id,
    { id: principal.userKey },
    {
      action: 'request-more-info',
      expectedRevision: submission.revision,
      message: request.action.message,
    },
    mergeTriageConditionChecks(
      request.authorizationConditionChecks ?? [],
      referenceChecks,
      contribution.transactItems,
    ),
  )
  return { entry: contribution.entry, replayed: false }
}

/**
 * Creates a canonical Work Item and accepts its Triage Entry in one transaction.
 *
 * A Form source also converts its Request submission in the same transaction. The
 * fingerprint-bound receipt is read first so a response-loss retry never creates a
 * second Work Item or repeats the source conversion.
 *
 * @param principal - Current live-authorized Workspace principal.
 * @param request - Validated accept-create action.
 * @returns The newly committed or replayed Triage receipt.
 */
async function acceptTriageEntryAsNewWorkItem(
  principal: WorkspacePrincipal,
  request: TriageRouterActionRequest & {
    action: Extract<TriageRouterActionRequest['action'], { action: 'accept'; mode: 'create' }>
  },
) {
  const replay = await workItemDependencies.triage.getActionReceipt(
    request.workspaceId,
    request.teamId,
    request.entryId,
    request.idempotency,
  )
  if (replay) return replay

  const entry = await workItemDependencies.triage.getEntryForMutation(
    request.workspaceId,
    request.teamId,
    request.entryId,
  )
  const submission = entry.source.kind === 'form' && entry.source.submissionId
    ? await workItemDependencies.requestIntake.getSubmission(
        request.workspaceId,
        entry.source.submissionId,
      )
    : undefined
  const formConversion = submission && entry.retention.redactedAt === undefined
    ? createRequestWorkItemInput(submission, {
        action: 'convert',
        expectedRevision: submission.revision,
        target: {
          teamId: request.teamId,
          ...(request.action.projectId ? { projectId: request.action.projectId } : {}),
        },
      })
    : undefined
  const teamContext = await requireTeamPermission(principal, request.teamId, 'member')
  const assignedProjectId = request.action.projectId ?? entry.projectId
  requireAssignedProjectPermission(
    principal,
    teamContext,
    assignedProjectId,
    'member',
  )
  const assigneeUserId = entry.ownerUserId ?? principal.userKey
  await requireActiveWorkspaceAssignee(request.workspaceId, assigneeUserId)

  const issueId = createDeterministicTriageWorkItemId(
    request.workspaceId,
    request.teamId,
    request.entryId,
  )
  const resolvedConfiguration = await workItemDependencies.workItemConfigurations
    .getTeamConfiguration(request.workspaceId, request.teamId)
  const normalized = normalizeTeamIssueInput({
    ...(formConversion?.input ?? (entry.retention.redactedAt !== undefined
      ? {
          title: 'Retained source',
          schedule: createDefaultUnscheduledWorkItemSchedule(),
          priority: 'medium',
        }
      : {
          title: entry.sourcePreview.title,
          ...(entry.sourcePreview.body ? { description: entry.sourcePreview.body } : {}),
          schedule: createDefaultUnscheduledWorkItemSchedule(),
          priority: 'medium',
        })),
    assignedProjectId: assignedProjectId ?? null,
    assigneeUserId,
    ...(request.action.workItemTypeId
      ? { workItemTypeId: request.action.workItemTypeId }
      : {}),
    idempotentIssueId: issueId,
    idempotentRequestDigest: request.idempotency.fingerprint,
  }, teamContext.team)
  const customFieldValues = mergeTriageCustomFieldValues(
    'customFieldValues' in normalized ? normalized.customFieldValues : undefined,
    request.action.customFieldValues,
  )
  const conversionInput = {
    ...normalized,
    customFieldValues: filterRequestConversionCustomFieldValues(
      resolvedConfiguration.configuration,
      normalized.workItemTypeId,
      customFieldValues,
      assignedProjectId ?? undefined,
    ),
  }
  const configured = await prepareConfiguredCreateWorkItem(
    request.workspaceId,
    request.teamId,
    conversionInput,
    resolvedConfiguration,
    { fallbackToTypeInitialStatus: formConversion !== undefined },
  )
  const acceptanceReferenceConditionChecks =
    await createTriageAcceptanceReferenceConditionChecks(
      request.workspaceId,
      request.teamId,
      assignedProjectId,
      assigneeUserId,
    )
  const guardedConfigured = {
    ...configured,
    authorizationConditionChecks: [
      ...(configured.authorizationConditionChecks ?? []),
      ...acceptanceReferenceConditionChecks,
      ...(request.authorizationConditionChecks ?? []),
    ],
  }
  const now = new Date().toISOString()
  const canonicalWorkItem = {
    teamId: request.teamId,
    workItemId: issueId,
    ...(typeof configured.workItemTypeId === 'string'
      ? { workItemTypeId: configured.workItemTypeId }
      : {}),
    ...(assignedProjectId ? { projectId: assignedProjectId } : {}),
  }
  const acceptance = createTriageAcceptanceTransactionItems({
    tableName: getEnv('REQUEST_INTAKE_TABLE_NAME') ?? 'mukuroji-request-intake-local',
    entry,
    action: request.action,
    canonicalWorkItem,
    actorId: principal.userKey,
    now,
    idempotency: request.idempotency,
  })
  const created = await workItemDependencies.teamIssues.createTeamIssue(
    request.workspaceId,
    request.teamId,
    guardedConfigured,
    principal.userKey,
    createApiMutationContext(request.context, principal, {
      action: 'triage.accept',
      triageEntryId: request.entryId,
      teamId: request.teamId,
    }),
    submission
      ? {
          tableName: getEnv('REQUEST_INTAKE_TABLE_NAME') ?? 'mukuroji-request-intake-local',
          scopeKey: `WORKSPACE#${request.workspaceId}`,
          recordKey: `SUBMISSION#${submission.id}`,
          expectedRevision: submission.revision,
          actorId: principal.userKey,
          submissionId: submission.id,
          events: submission.events,
        }
      : undefined,
    {
      entryId: entry.id,
      occurredAt: now,
      transactItems: acceptance.transactItems,
    },
  )
  await projectWorkItemSearchDocumentBestEffort(
    request.workspaceId,
    created.issue,
    'Triage acceptance',
    [],
  )
  return { entry: acceptance.entry, replayed: false }
}

/** Builds commit-time Team, Project, and assignee fences for Triage acceptance.
 *
 * @param workspaceId - Owning Workspace directory identifier.
 * @param teamId - Team that must remain active through Work Item creation.
 * @param projectId - Optional Project that must remain active through commit.
 * @param assigneeUserId - Member that must remain active through commit.
 * @returns Directory and Workspace condition checks for the acceptance transaction.
 */
async function createTriageAcceptanceReferenceConditionChecks(
  workspaceId: string,
  teamId: string,
  projectId: string | undefined,
  assigneeUserId: string,
): Promise<NonNullable<TransactWriteCommandInput['TransactItems']>> {
  const createReferenceChecks = workspaceDependencies.projectDirectory.createActiveReferenceConditionChecks
  const createMemberCheck = workspaceDependencies.workspaceAccess.createActiveMemberConditionCheck
  if (!createReferenceChecks || !createMemberCheck) {
    throw new TriageError(
      503,
      'TriageAcceptanceReferenceUnavailable',
      'Acceptance reference fencing is unavailable.',
    )
  }
  let referenceChecks
  try {
    referenceChecks = await createReferenceChecks(workspaceId, teamId, projectId)
  } catch (error) {
    if (error instanceof ProjectDataError) {
      throw new TriageError(
        409,
        error.code === 'ProjectNotFound'
          ? 'TriageAcceptanceProjectUnavailable'
          : 'TriageAcceptanceTeamUnavailable',
        'The selected acceptance destination is no longer active.',
        { cause: error },
      )
    }
    throw error
  }
  const memberCheck = await createMemberCheck(
    workspaceId,
    assigneeUserId,
    TRIAGE_NON_GUEST_MEMBER_CONDITION_OPTIONS,
  )
  if (!memberCheck) {
    throw new TriageError(
      409,
      'TriageAcceptanceOwnerUnavailable',
      'The selected acceptance owner is no longer active.',
    )
  }
  return [...referenceChecks, memberCheck]
}

/** Merges explicit Triage custom-field overrides without mutating Request mappings. */
function mergeTriageCustomFieldValues(
  baseValues: Record<string, CustomFieldValue> | undefined,
  overrides: Readonly<Record<string, CustomFieldValue | null>> | undefined,
): Record<string, CustomFieldValue> | undefined {
  if (baseValues === undefined && overrides === undefined) return undefined

  const values = new Map(Object.entries(baseValues ?? {}))
  for (const [fieldId, value] of Object.entries(overrides ?? {})) {
    if (value === null) values.delete(fieldId)
    else values.set(fieldId, value)
  }
  return Object.fromEntries(values)
}

/**
 * Registers the request intake HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerRequestIntakeRoutes(routeApp: Hono): void {
  routeApp.route('/', createPublicRequestIntakeRouter({
    getRequestIntake: () => workItemDependencies.requestIntake,
    authorizeRequestLink,
    createExternalContext: createRequestExternalContext,
    mapError: (context, error) => toRequestIntakeErrorResponse(context, error, true),
    readJson,
  }))

  routeApp.route('/', createAdminRequestIntakeRouter({
    getRequestIntake: () => workItemDependencies.requestIntake,
    requireAdministration: requireRequestAdministration,
    readJson,
    validateFormRoutingReferences: validateRequestFormRoutingReferences,
    readSubmissionStatus: readRequestSubmissionStatus,
    readQueueLimit: (value) => readOptionalPositiveQueryInteger(value, 'Request queue limit'),
    mapError: toRequestIntakeErrorResponse,
  }))

  routeApp.route('/', createTriageRouter({
    getTriage: () => workItemDependencies.triage,
    requireTeamAccess: requireTriageTeamAccess,
    requireWorkItemAccess: requireTriageWorkItemAccess,
    readJson,
    validateBulkAction: validateTriageBulkAction,
    prepareManualHandoff: prepareTriageManualHandoff,
    createManualHandoffAuthorizationConditionChecks:
      createTriageManualHandoffAuthorizationConditionChecks,
    validateConfiguration: validateTriageConfigurationReferences,
    applyAction: applyTriageRouteAction,
    applyBulkAction: applyTriageBulkRouteAction,
    mapError: toTriageErrorResponse,
  }))
}
