import { createHash } from 'node:crypto'
import type {
  CreatePlanningEntityInput,
  PlanningEntity,
  PlanningDateRange,
  PlanningEntityPatch,
  PlanningReadScope,
  PlanningUpdate,
  PlanningUpdateTarget,
  PlanningWorkItemLinkInput,
  PublicPlanningEntity,
  PublicPlanningEntityMutation,
  PublicPlanningStatusUpdate,
  PublicPlanningStatusUpdateMutation,
  PublicPlanningStatusUpdatePage,
  PublicWorkItemPlanning,
} from '@mukuroji/contracts'
import { createMutationAuditContext, type MutationAuditContext } from '../../modules/audit/audit'
import type {
  AuthenticatedDeveloperCredential,
  IdempotencyMutationToken,
} from '../../modules/developer-platform/application/ports'
import { readCredentialPrincipalKey } from '../../modules/developer-platform/credential-principal'
import {
  PublicApiServiceError,
  type PublicMutationContext,
  type PublicPlanningService,
} from '../../modules/developer-platform/public-api'
import {
  PlanningError,
  type PlanningEntityTransactionResult,
  type PlanningMutationTransaction,
  type PlanningWorkItemLinkTransactionResult,
} from '../../modules/planning'
import { workItemDependencies } from '../shared/app-dependencies'
import { resolveDeveloperCredentialPrincipal } from '../shared/developer-platform-access'
import {
  filterPlanningSnapshotForPrincipal,
  readPlanningWorkItemState,
  withPlanningLegacyReadScope,
} from '../shared/planning-access'
import { requirePlanningEntityPermission, requirePlanningScopePermission } from '../shared/planning-scope-access'
import { requireWorkspaceBusinessWrite, type WorkspacePrincipal } from '../shared/project-access'
import { isRecord } from '../shared/value-guards'
import { createWorkItemIdempotencyTransaction, loadAuthorizedTeamIssue } from '../shared/work-item-access'
import {
  authorizePlanningUpdateReplayAsPrincipal,
  createPlanningEntityAsPrincipal,
  deletePlanningWorkItemLinkAsPrincipal,
  listPlanningUpdatesAsPrincipal,
  publishPlanningUpdateAsPrincipal,
  putPlanningWorkItemLinkAsPrincipal,
  readPlanningSnapshotAsPrincipal,
  updatePlanningEntityAsPrincipal,
} from './planning-routes'

/** Route the Milestone writes record in their audit events. */
const MILESTONES_ROUTE = '/api/v1/planning/milestones'

/** Route the health update publish records in its audit events. */
const STATUS_UPDATES_ROUTE = '/api/v1/planning/status-updates'

/** Team, or Team and Project, a Planning request acts on. */
type PlanningResource = {
  /** Team of the resource. */
  teamId?: string
  /** Project of the resource, inside `teamId`. */
  projectId?: string
}

/**
 * Resolves the credential owner with the Enterprise permission the Web Planning routes require,
 * evaluated the same way: at the Team or Project the request acts on when it has one, otherwise at
 * the Workspace counting Team and Project grants, with the legacy Project scopes loaded.
 *
 * @param credential - Authenticated developer credential.
 * @param permission - `planning.read` for reads, `planning.write` for writes.
 * @param resource - Team or Project the request acts on, as the Web route resolves it.
 * @returns The owner as a Workspace principal.
 */
async function resolvePlanningPrincipal(
  credential: AuthenticatedDeveloperCredential,
  permission: 'planning.read' | 'planning.write',
  resource: PlanningResource = {},
): Promise<WorkspacePrincipal> {
  const scope = resource.teamId === undefined
    ? {}
    : { teamId: resource.teamId, ...(resource.projectId === undefined ? {} : { projectId: resource.projectId }) }
  // The Web Planning routes load the legacy Project scopes with the principal; do the same, so
  // an owner without Enterprise grants sees the Planning entities of their Projects.
  return withPlanningLegacyReadScope(
    await resolveDeveloperCredentialPrincipal(credential, { permission, evaluateProjectScopes: true, ...scope }),
  )
}

/**
 * Reads the Team and Project of a live Planning entity, which the Web routes authorize an entity
 * write at.
 *
 * @param workspaceId - Workspace ID.
 * @param entityId - Planning entity ID.
 * @returns The entity's scope; empty for a Workspace-wide or missing entity.
 */
async function readEntityResource(workspaceId: string, entityId: string): Promise<PlanningResource> {
  const state = await workItemDependencies.planning.getAuthorizationState(workspaceId)
  const entity = state.entities.find((candidate) => candidate.id === entityId)
  return entity?.teamId === undefined
    ? {}
    : { teamId: entity.teamId, ...(entity.projectId === undefined ? {} : { projectId: entity.projectId }) }
}

/**
 * Reads the Team and Project of a Work Item, which the Web link routes authorize a link write at.
 *
 * @param workspaceId - Workspace ID.
 * @param teamId - Team of the Work Item.
 * @param workItemId - Work Item ID.
 * @returns The Work Item's Project inside the Team, or the Team alone.
 */
async function readWorkItemResource(workspaceId: string, teamId: string, workItemId: string): Promise<PlanningResource> {
  const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(workspaceId, teamId, workItemId, {
    consistentIssueRead: true,
    includeEvents: false,
  })
  const projectId = detail.issue.assignedProjectId
  return projectId ? { teamId, projectId } : { teamId }
}

/**
 * Reads the ID and version of the update a keyed publish stored with its response.
 *
 * @param storedBody - Stored response body.
 * @returns The update's ID and version.
 */
function readStoredStatusUpdate(storedBody: unknown): { id: string, version: number } {
  const item = isRecord(storedBody) && isRecord(storedBody.item) ? storedBody.item : undefined
  if (
    !item ||
    typeof item.id !== 'string' ||
    typeof item.version !== 'number' ||
    !Number.isSafeInteger(item.version) ||
    item.version < 1
  ) {
    throw new PublicApiServiceError(503, 'temporarily_unavailable', 'Stored idempotency response is invalid.', true)
  }
  return { id: item.id, version: item.version }
}

/**
 * Builds the audit context of a Planning write made through the Public API.
 *
 * @param principal - Credential owner.
 * @param context - Request, correlation, and idempotency identifiers.
 * @param method - HTTP method.
 * @param route - Canonical route.
 * @param body - Values the audit event fingerprints.
 * @returns The audit context.
 */
function createAuditContext(
  principal: WorkspacePrincipal,
  context: PublicMutationContext,
  method: string,
  route: string,
  body: unknown,
): MutationAuditContext {
  return createMutationAuditContext({
    workspaceId: principal.directoryId,
    actor: { id: principal.actorId, kind: 'user', displayName: principal.userKey },
    idempotencyKey: context.idempotencyKey,
    ...(context.correlationId ? { correlationId: context.correlationId } : {}),
    request: { method, path: route, body },
    source: { kind: 'api', requestId: context.requestId, method, route },
  })
}

/**
 * Derives the ID of an entity or update a keyed write creates, so that a retry with the same key
 * names the same one instead of creating another. It uses the same stable caller identity as the
 * Public API idempotency receipt, which outlives one OAuth access token.
 *
 * @param prefix - ID prefix.
 * @param principal - Credential owner.
 * @param credential - Authenticated developer credential.
 * @param context - Mutation context carrying the idempotency key.
 * @returns A stable ID.
 */
function deriveWriteId(
  prefix: string,
  principal: WorkspacePrincipal,
  credential: AuthenticatedDeveloperCredential,
  context: PublicMutationContext,
): string {
  const digest = createHash('sha256')
    .update(`public-planning-v1\n${prefix}\n${principal.directoryId}\n${readCredentialPrincipalKey(credential)}\n${context.idempotencyKey}`)
    .digest('hex')
  return `${prefix}-${digest.slice(0, 32)}`
}

/**
 * Reads the Planning revision a write applies to: the one the client sent, or the latest.
 *
 * @param principal - Credential owner.
 * @param expectedRevision - Revision the client sent, if any.
 * @returns The revision to send to the Planning write.
 */
async function resolveRevision(principal: WorkspacePrincipal, expectedRevision: number | undefined): Promise<number> {
  if (expectedRevision !== undefined) return expectedRevision
  return (await workItemDependencies.planning.getAuthorizationState(principal.directoryId)).revision
}

/**
 * Reads the Planning revision a write with a durable receipt applies to. A receipt is prepared for
 * one exact revision, so the store does not rebase such a write over Work Item changes; this reads
 * the latest revision instead when only Work Item changes moved it past the one the client sent,
 * which the Web routes accept.
 *
 * @param principal - Credential owner.
 * @param expectedRevision - Revision the client sent, if any.
 * @param current - Revision of the state the write was built from.
 * @returns The revision to send to the Planning write; a revision Planning changes moved past
 *   stays as sent, so the write still fails.
 */
async function resolveReceiptRevision(
  principal: WorkspacePrincipal,
  expectedRevision: number | undefined,
  current: number,
): Promise<number> {
  if (expectedRevision === undefined || expectedRevision === current) return current
  return expectedRevision < current &&
      await workItemDependencies.planning.isWorkItemOnlyRevisionAdvance(principal.directoryId, expectedRevision, current)
    ? current
    : expectedRevision
}

/**
 * Builds the one-day date range a Milestone holds.
 *
 * @param date - Date as `YYYY-MM-DD`.
 * @returns The range that starts and ends on the date.
 */
function singleDay(date: string): PlanningDateRange {
  return { startDate: date, endDate: date }
}

/**
 * Projects a Planning entity to its Public API shape.
 *
 * @param entity - Planning entity.
 * @returns The Public API entity.
 */
function toPublicPlanningEntity(entity: PlanningEntity): PublicPlanningEntity {
  return {
    id: entity.id,
    type: entity.type,
    title: entity.title,
    ...(entity.description === undefined ? {} : { description: entity.description }),
    ...(entity.parentId === undefined ? {} : { parentId: entity.parentId }),
    ...(entity.teamId === undefined ? {} : { teamId: entity.teamId }),
    ...(entity.projectId === undefined ? {} : { projectId: entity.projectId }),
    ownerMemberId: entity.ownerMemberKey,
    status: entity.status,
    health: entity.health,
    risk: entity.risk,
    progress: entity.progress,
    linkedWorkItemCount: entity.linkedWorkItemCount,
    baseline: { startDate: entity.baseline.startDate, endDate: entity.baseline.endDate },
    forecast: { startDate: entity.forecast.startDate, endDate: entity.forecast.endDate },
    ...(entity.type === 'cycle' && entity.cadence !== undefined
      ? { cadence: { unit: entity.cadence.unit, count: entity.cadence.count } }
      : {}),
    ...(entity.type === 'cycle' && entity.capacity !== undefined ? { capacity: entity.capacity } : {}),
    ...(entity.type === 'goal' && entity.goalFramework !== undefined ? { goalFramework: entity.goalFramework } : {}),
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  }
}

/**
 * Projects an immutable Planning update to its Public API shape.
 *
 * @param update - Planning update.
 * @returns The Public API health update.
 */
function toPublicStatusUpdate(update: PlanningUpdate): PublicPlanningStatusUpdate {
  return {
    id: update.id,
    version: update.version,
    target: update.target,
    health: update.health,
    risk: update.risk,
    summary: update.summary,
    riskSummary: update.riskSummary,
    decisionSummary: update.decisionSummary,
    helpNeeded: update.helpNeeded,
    nextAction: update.nextAction,
    progress: {
      percent: update.progressSnapshot.percent,
      linkedWorkItemCount: update.progressSnapshot.linkedWorkItemCount,
    },
    authorMemberId: update.authorMemberKey,
    coveredDueAt: update.coveredDueAt,
    createdAt: update.createdAt,
    ...(update.acknowledgement ? { acknowledgedAt: update.acknowledgement.acknowledgedAt } : {}),
  }
}

/**
 * Finds a Milestone in a principal-filtered snapshot and answers 404 alike for a hidden, archived,
 * or missing one, or an entity of another type.
 *
 * @param entities - Entities of the filtered snapshot.
 * @param milestoneId - Milestone ID.
 * @returns The Public API Milestone.
 */
function requireVisibleMilestone(entities: readonly PlanningEntity[], milestoneId: string): PublicPlanningEntity {
  const entity = entities.find((candidate) => candidate.id === milestoneId)
  if (!entity || entity.type !== 'milestone' || entity.archivedAt !== undefined) {
    throw new PublicApiServiceError(404, 'not_found', 'Milestone was not found.')
  }
  return toPublicPlanningEntity(entity)
}

/**
 * Requires a Milestone the principal may change, as the Web patch route checks it.
 *
 * @param principal - Credential owner.
 * @param milestoneId - Milestone ID.
 */
async function requireChangeableMilestone(principal: WorkspacePrincipal, milestoneId: string): Promise<PlanningEntity> {
  const { entities } = await readUnfilteredSnapshot(principal)
  const entity = entities.find((candidate) => candidate.id === milestoneId)
  if (!entity || entity.type !== 'milestone' || entity.archivedAt !== undefined) {
    throw new PublicApiServiceError(404, 'not_found', 'Milestone was not found.')
  }
  await requirePlanningEntityPermission(principal, entities, milestoneId, 'member')
  return entity
}

/**
 * Creates the transaction that stores a Milestone update's Public API response with the change,
 * so a retry after a lost response replays it instead of applying the patch to a newer revision.
 *
 * The stored Milestone is the committed entity with the progress, linked Work Item count, and
 * rollup health the committed graph computes for it.
 *
 * @param workspaceId - Workspace ID of the credential.
 * @param token - Public API idempotency reservation.
 * @param before - The Milestone as read before the patch.
 * @returns The receipt transaction, or undefined without a transactional idempotency store.
 */
function createMilestoneUpdateReceipt(
  workspaceId: string,
  token: IdempotencyMutationToken,
  before: PlanningEntity,
): PlanningMutationTransaction<PlanningEntityTransactionResult> | undefined {
  const transaction = createWorkItemIdempotencyTransaction(workspaceId, token)
  if (!transaction) return undefined
  return {
    prepare: (result) => {
      const body: PublicPlanningEntityMutation = {
        schemaVersion: 1,
        revision: result.revision,
        item: toPublicPlanningEntity({ ...result.entity, ...(result.rollup ?? before) }),
      }
      return transaction.prepare({ status: 200, body })
    },
  }
}

/**
 * Projects a Work Item link to its Public API shape, leaving out the entities the principal
 * cannot see.
 *
 * @param teamId - Team of the Work Item.
 * @param workItemId - Work Item ID.
 * @param revision - Planning revision of the read or write.
 * @param link - The link; absent when the Work Item has none.
 * @param visible - IDs of the entities the principal can see.
 * @returns The Public API Work Item planning.
 */
function toPublicWorkItemPlanning(
  teamId: string,
  workItemId: string,
  revision: number,
  link: { cycleId?: string, milestoneId?: string, goalIds: readonly string[] } | undefined,
  visible: ReadonlySet<string>,
): PublicWorkItemPlanning {
  return {
    schemaVersion: 1,
    revision,
    teamId,
    workItemId,
    ...(link?.cycleId !== undefined && visible.has(link.cycleId) ? { cycleId: link.cycleId } : {}),
    ...(link?.milestoneId !== undefined && visible.has(link.milestoneId) ? { milestoneId: link.milestoneId } : {}),
    goalIds: (link?.goalIds ?? []).filter((goalId) => visible.has(goalId)),
  }
}

/**
 * Creates the transaction that stores a Work Item planning change's Public API response with the
 * link write, so a retry after a lost response replays it instead of writing the link again.
 *
 * @param workspaceId - Workspace ID of the credential.
 * @param token - Public API idempotency reservation.
 * @param visible - IDs of the entities the principal could see before the write; the link names
 *   only those, since the write requires access to each of them.
 * @returns The receipt transaction, or undefined without a transactional idempotency store.
 */
function createWorkItemPlanningReceipt(
  workspaceId: string,
  token: IdempotencyMutationToken,
  visible: ReadonlySet<string>,
): PlanningMutationTransaction<PlanningWorkItemLinkTransactionResult> | undefined {
  const transaction = createWorkItemIdempotencyTransaction(workspaceId, token)
  if (!transaction) return undefined
  return {
    prepare: (result) => transaction.prepare({
      status: 200,
      body: toPublicWorkItemPlanning(result.teamId, result.workItemId, result.revision, result.link, visible),
    }),
  }
}

/**
 * Names the Web publish receipt of one Public API idempotency key, inside the same caller identity
 * as the outer Public API reservation, so two credentials of one member keep separate keys.
 *
 * @param credential - Authenticated developer credential.
 * @param context - Mutation context carrying the idempotency key.
 * @returns The key the shared publish reserves.
 */
function deriveInnerPublishKey(credential: AuthenticatedDeveloperCredential, context: PublicMutationContext): string {
  const digest = createHash('sha256')
    .update(`public-planning-update-v1\n${readCredentialPrincipalKey(credential)}\n${context.idempotencyKey}`)
    .digest('hex')
  return `public-api-${digest}`
}

/**
 * Reads the whole Planning snapshot for authorization, as the Web write routes read it.
 *
 * @param principal - Credential owner.
 * @returns The snapshot, not filtered for the principal.
 */
async function readUnfilteredSnapshot(principal: WorkspacePrincipal) {
  return workItemDependencies.planning.get(principal.directoryId, await readPlanningWorkItemState(principal))
}

/**
 * Reads a Work Item's Planning link, which the caller has already been authorized to read, and
 * leaves out the Cycle, Milestone, and Goals the principal cannot see.
 *
 * @param principal - Credential owner.
 * @param teamId - Team of the Work Item.
 * @param workItemId - Work Item ID.
 * @returns The link as the Public API returns it.
 */
async function readWorkItemPlanning(
  principal: WorkspacePrincipal,
  teamId: string,
  workItemId: string,
): Promise<PublicWorkItemPlanning> {
  const state = await workItemDependencies.planning.getAuthorizationState(principal.directoryId)
  const link = state.workItemLinks.find((candidate) =>
    candidate.teamId === teamId && candidate.workItemId === workItemId
  )
  const visible = link === undefined ? new Set<string>() : await readVisibleEntityIds(principal)
  return toPublicWorkItemPlanning(teamId, workItemId, state.revision, link, visible)
}

/**
 * Reads the IDs of the Planning entities the principal can see.
 *
 * @param principal - Credential owner.
 * @returns The visible entity IDs.
 */
async function readVisibleEntityIds(principal: WorkspacePrincipal): Promise<Set<string>> {
  return new Set((await readPlanningSnapshotAsPrincipal(principal)).entities.map((entity) => entity.id))
}

/**
 * Reads one page of a target's health updates in the Public API shape.
 *
 * @param principal - Credential owner.
 * @param target - Project, Team, or Initiative.
 * @param limit - Page size.
 * @param cursor - Cursor of the previous page.
 * @returns The page and the revision read.
 */
async function readStatusUpdatePage(
  principal: WorkspacePrincipal,
  target: PlanningUpdateTarget,
  limit: number | undefined,
  cursor: string | undefined,
): Promise<PublicPlanningStatusUpdatePage> {
  const { page, revision } = await listPlanningUpdatesAsPrincipal(principal, {
    target,
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  })
  return {
    schemaVersion: 1,
    revision,
    items: page.updates.map(toPublicStatusUpdate),
    hasMore: page.nextCursor !== undefined,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  }
}

/**
 * Creates the Planning adapter of the Public API. Every call resolves the credential owner's
 * current permissions and runs the same authorization as the Web Planning routes (ADR 0107).
 *
 * @returns Public Planning service.
 */
export function createCanonicalPublicPlanningService(): PublicPlanningService {
  return {
    async listEntities(credential, type, scope) {
      const principal = await resolvePlanningPrincipal(credential, 'planning.read')
      const readScope: PlanningReadScope | undefined = scope.teamId === undefined
        ? undefined
        : scope.projectId === undefined
          ? { type: 'team', teamId: scope.teamId }
          : { type: 'project', teamId: scope.teamId, projectId: scope.projectId }
      const snapshot = await readPlanningSnapshotAsPrincipal(principal, readScope)
      return {
        schemaVersion: 1,
        revision: snapshot.revision,
        items: snapshot.entities
          .filter((entity) => entity.type === type && entity.archivedAt === undefined)
          .filter((entity) => scope.teamId === undefined || entity.teamId === scope.teamId)
          .filter((entity) => scope.projectId === undefined || entity.projectId === scope.projectId)
          .map(toPublicPlanningEntity),
      }
    },

    async authorizeMilestoneCreate(credential, input) {
      const principal = await resolvePlanningPrincipal(credential, 'planning.write', input)
      requireWorkspaceBusinessWrite(principal)
      await requirePlanningScopePermission(principal, input, 'member')
    },

    async createMilestone(credential, input, context) {
      const principal = await resolvePlanningPrincipal(credential, 'planning.write', input)
      const entityId = deriveWriteId('pe', principal, credential, context)
      /** Answers with the Milestone an earlier attempt with the same key created. */
      const replay = async (): Promise<PublicPlanningEntityMutation> => {
        const snapshot = await readPlanningSnapshotAsPrincipal(principal)
        return { schemaVersion: 1, revision: snapshot.revision, item: requireVisibleMilestone(snapshot.entities, entityId) }
      }
      // The ID comes from the key, so after a lost response the retry finds the Milestone it made,
      // even though that creation moved the revision the retry still sends.
      const state = await workItemDependencies.planning.getAuthorizationState(principal.directoryId)
      if (state.entities.some((entity) => entity.id === entityId)) {
        requireWorkspaceBusinessWrite(principal)
        await requirePlanningEntityPermission(principal, (await readUnfilteredSnapshot(principal)).entities, entityId, 'member')
        return replay()
      }
      const creation: CreatePlanningEntityInput = {
        type: 'milestone',
        title: input.title,
        ...(input.description === undefined ? {} : { description: input.description }),
        parentId: input.parentId,
        ...(input.teamId === undefined ? {} : { teamId: input.teamId }),
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ownerMemberKey: input.ownerMemberId ?? principal.userKey,
        status: input.status ?? 'planned',
        health: input.health ?? 'unknown',
        risk: input.risk ?? 'none',
        progressMode: 'automatic',
        baseline: singleDay(input.baselineDate ?? input.targetDate),
        forecast: singleDay(input.targetDate),
        expectedRevision: await resolveRevision(principal, input.expectedRevision),
      }
      try {
        const response = await createPlanningEntityAsPrincipal(
          principal,
          creation,
          entityId,
          (recorded) => createAuditContext(principal, context, 'POST', MILESTONES_ROUTE, recorded),
        )
        const visible = filterPlanningSnapshotForPrincipal(principal, response.planning)
        return { schemaVersion: 1, revision: visible.revision, item: requireVisibleMilestone(visible.entities, entityId) }
      } catch (error) {
        // A concurrent attempt with the same key committed first.
        if (!(error instanceof PlanningError && error.code === 'PlanningEntityExists')) throw error
        return replay()
      }
    },

    async authorizeMilestoneUpdate(credential, milestoneId) {
      const principal = await resolvePlanningPrincipal(
        credential,
        'planning.write',
        await readEntityResource(credential.workspaceId, milestoneId),
      )
      requireWorkspaceBusinessWrite(principal)
      await requireChangeableMilestone(principal, milestoneId)
    },

    async updateMilestone(credential, milestoneId, input, context, idempotency) {
      const principal = await resolvePlanningPrincipal(
        credential,
        'planning.write',
        await readEntityResource(credential.workspaceId, milestoneId),
      )
      const before = await requireChangeableMilestone(principal, milestoneId)
      const patch: PlanningEntityPatch = {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.ownerMemberId === undefined ? {} : { ownerMemberKey: input.ownerMemberId }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.health === undefined ? {} : { health: input.health }),
        ...(input.risk === undefined ? {} : { risk: input.risk }),
        ...(input.targetDate === undefined ? {} : { forecast: singleDay(input.targetDate) }),
        ...(input.baselineDate === undefined ? {} : { baseline: singleDay(input.baselineDate) }),
      }
      const expectedRevision = await resolveReceiptRevision(
        principal,
        input.expectedRevision,
        (await workItemDependencies.planning.getAuthorizationState(principal.directoryId)).revision,
      )
      const response = await updatePlanningEntityAsPrincipal(
        principal,
        milestoneId,
        { expectedRevision, patch },
        createAuditContext(principal, context, 'PATCH', `${MILESTONES_ROUTE}/{milestoneId}`, { entityId: milestoneId, expectedRevision, patch }),
        createMilestoneUpdateReceipt(credential.workspaceId, idempotency, before),
      )
      const visible = filterPlanningSnapshotForPrincipal(principal, response.planning)
      return { schemaVersion: 1, revision: visible.revision, item: requireVisibleMilestone(visible.entities, milestoneId) }
    },

    async getWorkItemPlanning(credential, teamId, workItemId) {
      const principal = await resolvePlanningPrincipal(credential, 'planning.read')
      await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'viewer')
      return readWorkItemPlanning(principal, teamId, workItemId)
    },

    async authorizeWorkItemPlanningChange(credential, teamId, workItemId) {
      const principal = await resolvePlanningPrincipal(
        credential,
        'planning.write',
        await readWorkItemResource(credential.workspaceId, teamId, workItemId),
      )
      requireWorkspaceBusinessWrite(principal)
      await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'member')
    },

    async updateWorkItemPlanning(credential, teamId, workItemId, input, idempotency) {
      const principal = await resolvePlanningPrincipal(
        credential,
        'planning.write',
        await readWorkItemResource(credential.workspaceId, teamId, workItemId),
      )
      const state = await workItemDependencies.planning.getAuthorizationState(principal.directoryId)
      const current = state.workItemLinks.find((link) => link.teamId === teamId && link.workItemId === workItemId)
      const cycleId = input.cycleId === undefined ? current?.cycleId : input.cycleId ?? undefined
      const milestoneId = input.milestoneId === undefined ? current?.milestoneId : input.milestoneId ?? undefined
      const link: PlanningWorkItemLinkInput = {
        teamId,
        workItemId,
        // The store takes the Project from the canonical Work Item, which may have moved since the
        // stored link was written.
        ...(cycleId === undefined ? {} : { cycleId }),
        ...(milestoneId === undefined ? {} : { milestoneId }),
        goalIds: [...(current?.goalIds ?? [])],
        // The link is merged into the state just read, so the write still fails if Planning changed
        // it in between.
        expectedRevision: await resolveReceiptRevision(principal, input.expectedRevision, state.revision),
      }
      const removes = link.cycleId === undefined && link.milestoneId === undefined && link.goalIds.length === 0
      if (removes && !current) {
        // Nothing to remove; still answer only for a Work Item the owner may change.
        requireWorkspaceBusinessWrite(principal)
        await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'member')
        return readWorkItemPlanning(principal, teamId, workItemId)
      }
      const visible = await readVisibleEntityIds(principal)
      const receipt = createWorkItemPlanningReceipt(credential.workspaceId, idempotency, visible)
      // A link must name a Cycle, Milestone, or Goal, so taking the last one out removes the link.
      const response = removes
        ? await deletePlanningWorkItemLinkAsPrincipal(principal, teamId, workItemId, { expectedRevision: link.expectedRevision }, receipt)
        : await putPlanningWorkItemLinkAsPrincipal(principal, link, receipt)
      // Answer from the committed graph, as the receipt does, so a replay returns the same body.
      const committed = removes
        ? undefined
        : response.planning.workItemLinks.find((candidate) => candidate.teamId === teamId && candidate.workItemId === workItemId)
      return toPublicWorkItemPlanning(teamId, workItemId, response.planning.revision, committed, visible)
    },

    async listStatusUpdates(credential, target, limit, cursor) {
      const principal = await resolvePlanningPrincipal(credential, 'planning.read')
      return readStatusUpdatePage(principal, target, limit, cursor)
    },

    async authorizeStatusUpdateReplay(credential, target, storedBody) {
      const { id, version } = readStoredStatusUpdate(storedBody)
      await authorizePlanningUpdateReplayAsPrincipal(
        await resolvePlanningPrincipal(credential, 'planning.write'),
        target,
        id,
        version,
      )
    },

    async publishStatusUpdate(credential, input, context): Promise<PublicPlanningStatusUpdateMutation> {
      const principal = await resolvePlanningPrincipal(credential, 'planning.write')
      const { expectedRevision, ...request } = input
      // The ID comes from the key, and the key's receipt commits with the update, bound to the
      // client body. A retry after a lost response therefore replays the update it made, after the
      // same captured-scope check as the Web replay, even though the latest revision has moved.
      const outcome = await publishPlanningUpdateAsPrincipal(principal, {
        ...request,
        id: deriveWriteId('pu', principal, credential, context),
        risk: input.risk ?? 'none',
        riskSummary: input.riskSummary ?? '',
        decisionSummary: input.decisionSummary ?? '',
        helpNeeded: input.helpNeeded ?? '',
        nextAction: input.nextAction ?? '',
        evidence: [],
        expectedRevision: await resolveRevision(principal, expectedRevision),
      }, {
        idempotencyKey: deriveInnerPublishKey(credential, context),
        method: 'POST',
        path: STATUS_UPDATES_ROUTE,
        fingerprint: input,
        createAuditContext: (recorded) => createAuditContext(principal, context, 'POST', STATUS_UPDATES_ROUTE, recorded),
      })
      return { schemaVersion: 1, revision: outcome.planning.revision, item: toPublicStatusUpdate(outcome.update) }
    },
  }
}

