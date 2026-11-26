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
import type { AuthenticatedDeveloperCredential } from '../../modules/developer-platform/application/ports'
import {
  PublicApiServiceError,
  type PublicMutationContext,
  type PublicPlanningService,
} from '../../modules/developer-platform/public-api'
import { PlanningError } from '../../modules/planning'
import { workItemDependencies } from '../shared/app-dependencies'
import { resolveDeveloperCredentialPrincipal } from '../shared/developer-platform-access'
import {
  filterPlanningSnapshotForPrincipal,
  readPlanningWorkItemState,
  requirePlanningUpdateTargetPermission,
  withPlanningLegacyReadScope,
} from '../shared/planning-access'
import { requirePlanningEntityPermission, requirePlanningScopePermission } from '../shared/planning-scope-access'
import { requireWorkspaceBusinessWrite, type WorkspacePrincipal } from '../shared/project-access'
import { loadAuthorizedTeamIssue } from '../shared/work-item-access'
import {
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

/**
 * Resolves the credential owner with the Enterprise permission the Web Planning routes require,
 * evaluated the same way: at the Workspace, counting Team and Project grants, with the legacy
 * Project scopes loaded.
 *
 * @param credential - Authenticated developer credential.
 * @param permission - `planning.read` for reads, `planning.write` for writes.
 * @returns The owner as a Workspace principal.
 */
async function resolvePlanningPrincipal(
  credential: AuthenticatedDeveloperCredential,
  permission: 'planning.read' | 'planning.write',
): Promise<WorkspacePrincipal> {
  // The Web Planning routes load the legacy Project scopes with the principal; do the same, so
  // an owner without Enterprise grants sees the Planning entities of their Projects.
  return withPlanningLegacyReadScope(
    await resolveDeveloperCredentialPrincipal(credential, { permission, evaluateProjectScopes: true }),
  )
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
 * names the same one instead of creating another.
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
    .update(`public-planning-v1\n${prefix}\n${principal.directoryId}\n${credential.credentialId}\n${context.idempotencyKey}`)
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
async function requireChangeableMilestone(principal: WorkspacePrincipal, milestoneId: string): Promise<void> {
  const { entities } = await readUnfilteredSnapshot(principal)
  const entity = entities.find((candidate) => candidate.id === milestoneId)
  if (!entity || entity.type !== 'milestone' || entity.archivedAt !== undefined) {
    throw new PublicApiServiceError(404, 'not_found', 'Milestone was not found.')
  }
  await requirePlanningEntityPermission(principal, entities, milestoneId, 'member')
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
  const visible = link === undefined
    ? new Set<string>()
    : new Set((await readPlanningSnapshotAsPrincipal(principal)).entities.map((entity) => entity.id))
  return {
    schemaVersion: 1,
    revision: state.revision,
    teamId,
    workItemId,
    ...(link?.cycleId !== undefined && visible.has(link.cycleId) ? { cycleId: link.cycleId } : {}),
    ...(link?.milestoneId !== undefined && visible.has(link.milestoneId) ? { milestoneId: link.milestoneId } : {}),
    goalIds: (link?.goalIds ?? []).filter((goalId) => visible.has(goalId)),
  }
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
 * Requires the principal to hold member access to a health update target, as publishing does.
 *
 * @param principal - Credential owner.
 * @param target - Project, Team, or Initiative.
 */
async function authorizeStatusUpdateAs(principal: WorkspacePrincipal, target: PlanningUpdateTarget): Promise<void> {
  requireWorkspaceBusinessWrite(principal)
  const snapshot = filterPlanningSnapshotForPrincipal(principal, await readUnfilteredSnapshot(principal))
  await requirePlanningUpdateTargetPermission(principal, snapshot, target, 'member')
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
      const principal = await resolvePlanningPrincipal(credential, 'planning.write')
      requireWorkspaceBusinessWrite(principal)
      await requirePlanningScopePermission(principal, input, 'member')
    },

    async createMilestone(credential, input, context) {
      const principal = await resolvePlanningPrincipal(credential, 'planning.write')
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
      const principal = await resolvePlanningPrincipal(credential, 'planning.write')
      requireWorkspaceBusinessWrite(principal)
      await requireChangeableMilestone(principal, milestoneId)
    },

    async updateMilestone(credential, milestoneId, input, context) {
      const principal = await resolvePlanningPrincipal(credential, 'planning.write')
      await requireChangeableMilestone(principal, milestoneId)
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
      const expectedRevision = await resolveRevision(principal, input.expectedRevision)
      const response = await updatePlanningEntityAsPrincipal(
        principal,
        milestoneId,
        { expectedRevision, patch },
        createAuditContext(principal, context, 'PATCH', `${MILESTONES_ROUTE}/{milestoneId}`, { entityId: milestoneId, expectedRevision, patch }),
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
      const principal = await resolvePlanningPrincipal(credential, 'planning.write')
      requireWorkspaceBusinessWrite(principal)
      await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'member')
    },

    async updateWorkItemPlanning(credential, teamId, workItemId, input) {
      const principal = await resolvePlanningPrincipal(credential, 'planning.write')
      const state = await workItemDependencies.planning.getAuthorizationState(principal.directoryId)
      const current = state.workItemLinks.find((link) => link.teamId === teamId && link.workItemId === workItemId)
      const cycleId = input.cycleId === undefined ? current?.cycleId : input.cycleId ?? undefined
      const milestoneId = input.milestoneId === undefined ? current?.milestoneId : input.milestoneId ?? undefined
      const link: PlanningWorkItemLinkInput = {
        teamId,
        workItemId,
        ...(current?.projectId === undefined ? {} : { projectId: current.projectId }),
        ...(cycleId === undefined ? {} : { cycleId }),
        ...(milestoneId === undefined ? {} : { milestoneId }),
        goalIds: [...(current?.goalIds ?? [])],
        // Without a revision the link is merged into the state just read, so the write still fails
        // if anything changed it in between.
        expectedRevision: input.expectedRevision ?? state.revision,
      }
      if (link.cycleId === undefined && link.milestoneId === undefined && link.goalIds.length === 0) {
        // A link must name a Cycle, Milestone, or Goal, so taking the last one out removes the link.
        if (current) {
          await deletePlanningWorkItemLinkAsPrincipal(principal, teamId, workItemId, { expectedRevision: link.expectedRevision })
        } else {
          // Nothing to remove; still answer only for a Work Item the owner may change.
          requireWorkspaceBusinessWrite(principal)
          await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'member')
        }
      } else {
        await putPlanningWorkItemLinkAsPrincipal(principal, link)
      }
      return readWorkItemPlanning(principal, teamId, workItemId)
    },

    async listStatusUpdates(credential, target, limit, cursor) {
      const principal = await resolvePlanningPrincipal(credential, 'planning.read')
      return readStatusUpdatePage(principal, target, limit, cursor)
    },

    async authorizeStatusUpdate(credential, target) {
      await authorizeStatusUpdateAs(await resolvePlanningPrincipal(credential, 'planning.write'), target)
    },

    async publishStatusUpdate(credential, input, context): Promise<PublicPlanningStatusUpdateMutation> {
      const principal = await resolvePlanningPrincipal(credential, 'planning.write')
      const updateId = deriveWriteId('pu', principal, credential, context)
      /** Answers with the update an earlier attempt with the same key published, if it is the latest. */
      const replay = async (): Promise<PublicPlanningStatusUpdateMutation | undefined> => {
        const page = await readStatusUpdatePage(principal, input.target, 1, undefined)
        const latest = page.items[0]
        return latest?.id === updateId ? { schemaVersion: 1, revision: page.revision, item: latest } : undefined
      }
      // The ID comes from the key, so after a lost response the retry finds the update it made,
      // even though that publish moved the revision the retry still sends.
      const earlier = await replay()
      if (earlier) {
        await authorizeStatusUpdateAs(principal, input.target)
        return earlier
      }
      const publish = {
        target: input.target,
        id: updateId,
        health: input.health,
        risk: input.risk ?? 'none',
        summary: input.summary,
        riskSummary: input.riskSummary ?? '',
        decisionSummary: input.decisionSummary ?? '',
        helpNeeded: input.helpNeeded ?? '',
        nextAction: input.nextAction ?? '',
        evidence: [],
        expectedRevision: await resolveRevision(principal, input.expectedRevision),
      }
      try {
        const outcome = await publishPlanningUpdateAsPrincipal(principal, publish, {
          method: 'POST',
          path: STATUS_UPDATES_ROUTE,
          createAuditContext: (recorded) => createAuditContext(principal, context, 'POST', STATUS_UPDATES_ROUTE, recorded),
        })
        return { schemaVersion: 1, revision: outcome.planning.revision, item: toPublicStatusUpdate(outcome.update) }
      } catch (error) {
        // A concurrent attempt with the same key committed first.
        if (!(error instanceof PlanningError && error.code === 'PlanningUpdateExists')) throw error
        const concurrent = await replay()
        if (!concurrent) throw error
        return concurrent
      }
    },
  }
}

