import {
  PUBLIC_WORK_ITEM_LISTED_RELATION_TYPES,
  type CreatePublicWorkItemRelationRequest,
  type PublicWorkItemRelation,
  type PublicWorkItemRelationMutation,
  type PublicWorkItemRelationType,
  type WorkItemRelation,
  type WorkItemRelationType,
} from '@mukuroji/contracts'
import { createMutationAuditContext } from '../../modules/audit/audit'
import type { AuthenticatedDeveloperCredential, IdempotencyMutationToken } from '../../modules/developer-platform/application/ports'
import type {
  PublicMutationContext,
  PublicWorkItemRelationService,
} from '../../modules/developer-platform/public-api'
import {
  createTeamIssueDeepLink,
  isTeamIssueNotFoundError,
  type TeamIssueResponseItem,
  type WorkItemRelationNotificationEndpoint,
} from '../../modules/work-items'
import {
  WorkItemConfigurationError,
  assertWorkItemChildTypeAllowed,
  createWorkItemConfigurationGuardConditionChecks,
} from '../../modules/work-items/work-item-configuration'
import { workItemDependencies } from './app-dependencies'
import { resolveDeveloperCredentialPrincipal } from './developer-platform-access'
import {
  canAccessAssignedProject,
  requireAssignedProjectPermission,
  requireTeamPermission,
  requireWorkspaceBusinessWrite,
  type WorkspacePrincipal,
} from './project-access'
import { projectWorkItemMutationSearchDocumentBestEffort } from './search-access'
import { getWorkItemConfigurationTableName } from './work-item-configuration'
import { createWorkItemIdempotencyTransaction } from './work-item-access'

/** Work Items read at once while checking which relation targets the owner can read. */
const RELATION_TARGET_READ_CONCURRENCY = 10

/**
 * Times a relation write re-reads the Team graph after another write moved it first. The caller
 * names the exact link, so applying it to the newer graph keeps its meaning.
 */
const RELATION_GRAPH_CONFLICT_ATTEMPTS = 3

/** A relation write as the store expects it: the stored direction of the link. */
type StoredRelationDirection = {
  /** Work Item stored as the source. */
  sourceWorkItemId: string
  /** Work Item stored as the target. */
  targetWorkItemId: string
  /** Stored type; `child` and `blockedBy` are stored from the other side. */
  type: WorkItemRelationType
}

/**
 * Turns a relation named from either side into the direction the store creates, so a `child` link
 * is stored as the child's `parent` link and `blockedBy` as the blocker's `blocks` link.
 *
 * @param workItemId - Work Item named in the path.
 * @param targetWorkItemId - Other Work Item.
 * @param type - Relation type from the named Work Item's point of view.
 * @returns The stored direction.
 */
function toStoredRelationDirection(
  workItemId: string,
  targetWorkItemId: string,
  type: PublicWorkItemRelationType,
): StoredRelationDirection {
  if (type === 'child') return { sourceWorkItemId: targetWorkItemId, targetWorkItemId: workItemId, type: 'parent' }
  if (type === 'blockedBy') return { sourceWorkItemId: targetWorkItemId, targetWorkItemId: workItemId, type: 'blocks' }
  return { sourceWorkItemId: workItemId, targetWorkItemId, type }
}

/**
 * Projects a stored relation to the Public API shape.
 *
 * @param relation - Relation whose source is the named Work Item.
 * @returns The public relation.
 */
function toPublicRelation(relation: WorkItemRelation): PublicWorkItemRelation {
  return {
    type: relation.type,
    targetWorkItemId: relation.targetWorkItemId,
    ...(relation.createdAt === undefined ? {} : { createdAt: relation.createdAt }),
  }
}

/**
 * Builds the response of a relation mutation, naming the relation from the path Work Item's side.
 *
 * @param teamId - Team that owns both Work Items.
 * @param workItemId - Work Item named in the path.
 * @param relation - Stored relation.
 * @param reciprocalRelation - Its reciprocal row.
 * @returns The response body.
 */
function toRelationMutation(
  teamId: string,
  workItemId: string,
  relation: WorkItemRelation,
  reciprocalRelation: WorkItemRelation,
): PublicWorkItemRelationMutation {
  const named = relation.sourceWorkItemId === workItemId ? relation : reciprocalRelation
  return { schemaVersion: 1, teamId, workItemId, relation: toPublicRelation(named) }
}

/**
 * Creates the builder of the idempotency receipt committed with a relation mutation, so a retry
 * after a lost response replays it instead of failing as a duplicate or a missing relation.
 *
 * @param workspaceId - Workspace that scopes the request.
 * @param teamId - Team that owns both Work Items.
 * @param workItemId - Work Item named in the path.
 * @param status - Response status the receipt replays.
 * @param idempotency - Idempotency token of the request, if any.
 * @returns Builder of the receipt writes, or undefined when the request carries no token.
 */
function createRelationReceiptWrites(
  workspaceId: string,
  teamId: string,
  workItemId: string,
  status: 200 | 201,
  idempotency: IdempotencyMutationToken | undefined,
) {
  const transaction = createWorkItemIdempotencyTransaction(workspaceId, idempotency)
  if (!transaction) return undefined
  return async (relation: WorkItemRelation, reciprocalRelation: WorkItemRelation) => {
    const receipt = await transaction.prepare({ status, body: toRelationMutation(teamId, workItemId, relation, reciprocalRelation) })
    return receipt ? [receipt.transactWriteItem] : []
  }
}

/**
 * Builds the notification details of one authorized relation endpoint.
 *
 * @param teamId - Team that owns the endpoint.
 * @param endpoint - Endpoint read during authorization.
 * @returns Details that let the relation audit event notify the endpoint's assignee.
 */
function toNotificationEndpoint(
  teamId: string,
  endpoint: TeamIssueResponseItem,
): WorkItemRelationNotificationEndpoint {
  return {
    assigneeMemberKey: endpoint.assigneeUserId,
    title: endpoint.title,
    deepLink: createTeamIssueDeepLink(teamId, endpoint.id),
    ...(endpoint.assignedProjectId ? { assignedProjectId: endpoint.assignedProjectId } : {}),
  }
}

/**
 * Tells whether an error is a lost race on the Team relation graph or an endpoint revision.
 *
 * @param error - Error raised by the relation store.
 * @returns Whether reading again and retrying can succeed.
 */
function isRetryableRelationConflict(error: unknown) {
  return error instanceof WorkItemConfigurationError &&
    (error.code === 'WorkItemRelationGraphConflict' || error.code === 'WorkItemRevisionConflict')
}

/**
 * Resolves the credential owner as a Team member who may change Work Items.
 *
 * @param credential - Authenticated developer credential.
 * @param teamId - Team that owns the Work Items.
 * @returns The owner with current permissions.
 */
async function resolveRelationWriter(credential: AuthenticatedDeveloperCredential, teamId: string) {
  const principal = await resolveDeveloperCredentialPrincipal(credential, {
    permission: 'work-items.write',
    teamId,
    evaluateProjectScopes: true,
  })
  requireWorkspaceBusinessWrite(principal)
  return principal
}

/**
 * Reads both endpoints of a relation change and checks member access to their Projects.
 *
 * @param principal - Credential owner with current permissions.
 * @param teamId - Team that owns both Work Items.
 * @param sourceWorkItemId - One endpoint.
 * @param targetWorkItemId - Other endpoint.
 * @returns Consistent snapshots of both endpoints.
 */
async function authorizeEndpoints(
  principal: WorkspacePrincipal,
  teamId: string,
  sourceWorkItemId: string,
  targetWorkItemId: string,
) {
  const context = await requireTeamPermission(principal, teamId, 'member')
  const [source, target] = await Promise.all([sourceWorkItemId, targetWorkItemId].map(async (workItemId) =>
    (await workItemDependencies.teamIssues.getTeamIssueDetail(principal.directoryId, teamId, workItemId, {
      consistentIssueRead: true,
      includeEvents: false,
    })).issue,
  ))
  if (!source || !target) throw new Error('Relation endpoints were not read.')
  requireAssignedProjectPermission(principal, context, source.assignedProjectId, 'member')
  requireAssignedProjectPermission(principal, context, target.assignedProjectId, 'member')
  return { source, target }
}

/**
 * Builds the audit context of a Public API relation change.
 *
 * @param principal - Credential owner.
 * @param context - Request, correlation, and idempotency identifiers.
 * @param method - HTTP method.
 * @param path - Request path.
 * @param body - Request fields recorded with the audit event.
 * @returns The audit input for the relation store.
 */
function createRelationAudit(
  principal: WorkspacePrincipal,
  context: PublicMutationContext,
  method: string,
  path: string,
  body: Record<string, string>,
) {
  return createMutationAuditContext({
    workspaceId: principal.directoryId,
    actor: { id: principal.actorId, kind: 'user', displayName: principal.userKey },
    idempotencyKey: context.idempotencyKey,
    ...(context.correlationId ? { correlationId: context.correlationId } : {}),
    request: { method, path, body },
    source: { kind: 'api', requestId: context.requestId, method, route: path },
  })
}

/**
 * Runs a relation write, reading the graph again when another write moved it first.
 *
 * @param write - One attempt; it reads every revision it sends.
 * @returns The result of the first attempt that did not lose a race.
 */
async function retryRelationConflicts<T>(write: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await write()
    } catch (error) {
      if (attempt >= RELATION_GRAPH_CONFLICT_ATTEMPTS || !isRetryableRelationConflict(error)) throw error
    }
  }
}

/**
 * Updates the search documents of both endpoints after a relation change, without failing it.
 *
 * @param workspaceId - Workspace that owns the Work Items.
 * @param endpoints - Both endpoints read during authorization.
 * @param operation - Operation name used in logs.
 */
async function refreshSearchDocuments(
  workspaceId: string,
  endpoints: readonly TeamIssueResponseItem[],
  operation: string,
) {
  await Promise.all(endpoints.map((endpoint) =>
    projectWorkItemMutationSearchDocumentBestEffort(workspaceId, endpoint, operation)))
}

/**
 * Creates the Public API relation adapter on top of the canonical relation store.
 *
 * @returns The relation service.
 */
export function createCanonicalPublicRelationService(): PublicWorkItemRelationService {
  return {
    async listRelations(credential, teamId, workItemId) {
      const principal = await resolveDeveloperCredentialPrincipal(credential, {
        permission: 'work-items.read',
        teamId,
        evaluateProjectScopes: true,
      })
      const context = await requireTeamPermission(principal, teamId, 'viewer')
      const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(principal.directoryId, teamId, workItemId, {
        consistentIssueRead: true,
        includeEvents: false,
      })
      requireAssignedProjectPermission(principal, context, detail.issue.assignedProjectId, 'viewer')
      const { relations } = await workItemDependencies.workItemConfigurations.listRelations(
        principal.directoryId,
        teamId,
        workItemId,
        { types: [...PUBLIC_WORK_ITEM_LISTED_RELATION_TYPES] },
      )
      const targetIds = [...new Set(relations.map((relation) => relation.targetWorkItemId))]
      const readable = new Set<string>()
      for (let offset = 0; offset < targetIds.length; offset += RELATION_TARGET_READ_CONCURRENCY) {
        await Promise.all(targetIds.slice(offset, offset + RELATION_TARGET_READ_CONCURRENCY).map(async (targetId) => {
          try {
            const target = await workItemDependencies.teamIssues.getTeamIssueDetail(principal.directoryId, teamId, targetId, {
              consistentIssueRead: true,
              includeEvents: false,
            })
            if (canAccessAssignedProject(principal, context, target.issue.assignedProjectId, 'viewer')) readable.add(targetId)
          } catch (error) {
            // A target removed while this list was read is left out rather than failing the list.
            if (!isTeamIssueNotFoundError(error)) throw error
          }
        }))
      }
      return {
        schemaVersion: 1,
        teamId: detail.issue.teamId,
        workItemId: detail.issue.id,
        relations: relations
          .filter((relation) => readable.has(relation.targetWorkItemId))
          .map(toPublicRelation),
      }
    },

    async authorizeRelationChange(credential, teamId, workItemId, targetWorkItemId) {
      const principal = await resolveRelationWriter(credential, teamId)
      await authorizeEndpoints(principal, teamId, workItemId, targetWorkItemId)
    },

    async createRelation(credential, teamId, workItemId, input: CreatePublicWorkItemRelationRequest, context, idempotency) {
      const principal = await resolveRelationWriter(credential, teamId)
      const stored = toStoredRelationDirection(workItemId, input.targetWorkItemId, input.type)
      const path = `/api/v1/work-items/${encodeURIComponent(workItemId)}/relations`
      const { endpoints, response } = await retryRelationConflicts(async () => {
        const endpoints = await authorizeEndpoints(principal, teamId, stored.sourceWorkItemId, stored.targetWorkItemId)
        const resolvedConfiguration = stored.type === 'parent'
          ? await workItemDependencies.workItemConfigurations.getTeamConfiguration(principal.directoryId, teamId)
          : undefined
        if (resolvedConfiguration) {
          // A parent link makes the target the parent, so its Type must allow the source's Type.
          assertWorkItemChildTypeAllowed(
            resolvedConfiguration.configuration,
            endpoints.target.workItemTypeId,
            endpoints.source.workItemTypeId,
          )
        }
        const expectedGraphRevision = (await workItemDependencies.workItemConfigurations.listRelations(
          principal.directoryId,
          teamId,
          stored.sourceWorkItemId,
          { types: ['parent'] },
        )).graphRevision
        const response = await workItemDependencies.workItemConfigurations.createRelation(
          principal.directoryId,
          teamId,
          {
            ...stored,
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
          {
            context: createRelationAudit(principal, context, 'POST', path, {
              teamId,
              type: input.type,
              targetWorkItemId: input.targetWorkItemId,
            }),
            actorMemberKey: principal.userKey,
            createCoWrites: createRelationReceiptWrites(principal.directoryId, teamId, workItemId, 201, idempotency),
          },
        )
        return { endpoints, response }
      })
      await refreshSearchDocuments(principal.directoryId, [endpoints.source, endpoints.target], 'Public API relation creation')
      return toRelationMutation(teamId, workItemId, response.relation, response.reciprocalRelation)
    },

    async deleteRelation(credential, teamId, workItemId, targetWorkItemId, type, context, idempotency) {
      const principal = await resolveRelationWriter(credential, teamId)
      const path = `/api/v1/work-items/${encodeURIComponent(workItemId)}/relations/${encodeURIComponent(targetWorkItemId)}/${type}`
      const { endpoints, response } = await retryRelationConflicts(async () => {
        const endpoints = await authorizeEndpoints(principal, teamId, workItemId, targetWorkItemId)
        const expectedGraphRevision = (await workItemDependencies.workItemConfigurations.listRelations(
          principal.directoryId,
          teamId,
          workItemId,
          { types: ['parent'] },
        )).graphRevision
        const response = await workItemDependencies.workItemConfigurations.deleteRelation(
          principal.directoryId,
          teamId,
          {
            sourceWorkItemId: workItemId,
            targetWorkItemId,
            type,
            expectedGraphRevision,
            sourceExpectedRevision: endpoints.source.revision,
            targetExpectedRevision: endpoints.target.revision,
            sourceAssignedProjectId: endpoints.source.assignedProjectId,
            targetAssignedProjectId: endpoints.target.assignedProjectId,
          },
          {
            context: createRelationAudit(principal, context, 'DELETE', path, { teamId, targetWorkItemId, type }),
            actorMemberKey: principal.userKey,
            notificationEndpoints: new Map([endpoints.source, endpoints.target].map((endpoint) => [
              endpoint.id,
              toNotificationEndpoint(teamId, endpoint),
            ])),
            createCoWrites: createRelationReceiptWrites(principal.directoryId, teamId, workItemId, 200, idempotency),
          },
        )
        return { endpoints, response }
      })
      await refreshSearchDocuments(principal.directoryId, [endpoints.source, endpoints.target], 'Public API relation deletion')
      return toRelationMutation(teamId, workItemId, response.relation, response.reciprocalRelation)
    },
  }
}
