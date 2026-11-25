import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import { DEFAULT_WORKSPACE_TIME_ZONE } from '@mukuroji/contracts'
import type { Context } from 'hono'
import {
  CalendarFeedError,
  type CalendarFeedIssueReceipts,
  type CalendarFeedOwner,
  type CalendarFeedOwnerView,
  type CalendarFeedReader,
  type CalendarFeedWorkItemFilter,
} from '../../modules/calendar-feeds'
import { DeveloperPlatformError } from '../../modules/developer-platform'
import { readReadableLivePlanningEntities } from './analytics-milestones'
import {
  developerPlatformDependencies,
  enforceActiveTenantForRequest,
  workspaceDependencies,
} from './app-dependencies'
import { resolveDeveloperCredentialPrincipal } from './developer-platform-access'
import {
  canAccessAssignedProject,
  requireTeamPermission,
  type WorkspacePrincipal,
} from './project-access'
import {
  readAccessibleWorkItemPage,
  resolveAccessibleWorkItemTeamContexts,
  type WorkItemAggregateFilter,
} from './work-item-aggregate-read'
import type { TeamPermissionContext } from './workspace-access'

/** One DynamoDB transaction item. */
type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number]

/** Requests one feed may make within {@link CALENDAR_FEED_RATE_WINDOW_SECONDS}. */
const CALENDAR_FEED_RATE_LIMIT = 30

/** Rate limit window of one feed. */
export const CALENDAR_FEED_RATE_WINDOW_SECONDS = 300

/** Work Items read per page; the use case stops at its event limit. */
const CALENDAR_FEED_WORK_ITEM_PAGE_SIZE = 1_000

/**
 * Creates the read ports of the calendar feed use cases over the Workspace, Work Item, and
 * Planning services, with the owner's current permissions.
 *
 * @param c - Request context, used for the closed-Workspace check.
 * @returns The reader.
 */
export function createCalendarFeedReader(c: Context): CalendarFeedReader {
  return {
    async openOwnerView(workspaceId, memberKey, project) {
      return withAccessLoss(async () => {
        // A closed Workspace answers like a revoked token.
        await enforceActiveTenantForRequest(workspaceId, c)
        const principal = await resolveFeedPrincipal(workspaceId, memberKey, project)
        if (!project) return createOwnerView(principal, undefined, undefined)
        const readable = await readFeedProjectContext(principal, project.teamId, project.projectId)
        return readable ? createOwnerView(principal, project, readable.projectName) : undefined
      }, () => undefined)
    },
    async readTimeZone(workspaceId) {
      const profile = await workspaceDependencies.tenantAdministration.getProfile(workspaceId)
      return profile?.calendar?.timeZone ?? DEFAULT_WORKSPACE_TIME_ZONE
    },
    async consumeRateLimit(workspaceId, feedId) {
      const result = await developerPlatformDependencies.rateLimits.consumeRateLimit({
        workspaceId,
        credentialId: `calendar-feed:${feedId}`,
        limit: CALENDAR_FEED_RATE_LIMIT,
        windowSeconds: CALENDAR_FEED_RATE_WINDOW_SECONDS,
      })
      return {
        allowed: result.allowed,
        ...(result.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: result.retryAfterSeconds }),
      }
    },
  }
}

/**
 * Checks, with the feed-read rule, that a member can read a Project.
 *
 * @param c - Request context.
 * @param owner - Member.
 * @param teamId - Team of the Project.
 * @param projectId - Project.
 * @returns Whether a Project feed would show the Project.
 */
export async function canReadCalendarFeedProject(
  c: Context,
  owner: CalendarFeedOwner,
  teamId: string,
  projectId: string,
): Promise<boolean> {
  const view = await createCalendarFeedReader(c).openOwnerView(owner.workspaceId, owner.memberKey, { teamId, projectId })
  return view !== undefined
}

/**
 * Creates the issue receipts over the shared idempotency store. The receipt is encrypted and
 * committed in the feed transaction when the store supports it.
 *
 * @returns The receipts port.
 */
export function createCalendarFeedIssueReceipts(): CalendarFeedIssueReceipts<TransactItem> {
  const toRequest = (key: Parameters<CalendarFeedIssueReceipts<TransactItem>['reserve']>[0]) => ({
    workspaceId: key.workspaceId,
    credentialId: key.credentialId,
    idempotencyKey: key.idempotencyKey,
    requestFingerprint: key.requestFingerprint,
  })
  return {
    async reserve(key) {
      try {
        return await developerPlatformDependencies.idempotency.reserveIdempotency(toRequest(key))
      } catch (error) {
        if (error instanceof DeveloperPlatformError && error.code === 'IdempotencyKeyConflict') {
          throw new CalendarFeedError(
            'conflict',
            'CalendarFeedIdempotencyConflict',
            'Idempotency-Key was already used for a different calendar feed request.',
          )
        }
        throw receiptsUnavailable(error)
      }
    },
    async prepareCompletion(key) {
      const prepare = developerPlatformDependencies.transactions.prepareIdempotencyCompletionTransactWrite
      if (!prepare) return undefined
      try {
        const prepared = await prepare.call(developerPlatformDependencies.transactions, {
          ...toRequest(key),
          reservationId: key.reservationId,
          response: { status: 201, body: key.response },
        })
        return prepared.transactWriteItem
      } catch (error) {
        throw receiptsUnavailable(error)
      }
    },
    async complete(key) {
      try {
        await developerPlatformDependencies.idempotency.completeIdempotency({
          ...toRequest(key),
          reservationId: key.reservationId,
          response: { status: 201, body: key.response },
        })
      } catch (error) {
        throw receiptsUnavailable(error)
      }
    },
    async release(key) {
      await developerPlatformDependencies.idempotency.releaseIdempotency({
        ...toRequest(key),
        reservationId: key.reservationId,
      })
    },
  }
}

/**
 * Builds the owner view over a resolved principal.
 *
 * @param principal - Owner's principal.
 * @param project - Project of a Project feed.
 * @param projectName - Name of that Project.
 * @returns The view.
 */
function createOwnerView(
  principal: WorkspacePrincipal,
  project: { teamId: string, projectId: string } | undefined,
  projectName: string | undefined,
): CalendarFeedOwnerView {
  let contexts: Promise<TeamPermissionContext[]> | undefined
  return {
    memberKeys: [...new Set([principal.userKey, principal.actorId])],
    ...(projectName === undefined ? {} : { projectName }),
    async readWorkItemPage(filter, cursor) {
      return withAccessLoss(async () => {
        contexts ??= resolveAccessibleWorkItemTeamContexts(principal, project)
        const result = await readAccessibleWorkItemPage(principal, await contexts, {
          limit: CALENDAR_FEED_WORK_ITEM_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
          includeArchived: false,
          filter: toAggregateFilter(filter),
        })
        return {
          workItems: result.workItems,
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        }
      })
    },
    async readPlanningEntities() {
      return withAccessLoss(() => readReadableLivePlanningEntities(principal, ['milestone', 'cycle']))
    },
  }
}

/**
 * Converts a feed filter to the Work Item aggregate filter.
 *
 * @param filter - Feed filter.
 * @returns Aggregate filter of open Work Items.
 */
function toAggregateFilter(filter: CalendarFeedWorkItemFilter): WorkItemAggregateFilter {
  return filter.kind === 'project'
    ? { teamId: filter.teamId, projectId: filter.projectId, openOnly: true }
    : { openOnly: true, involvedMemberKeys: [...filter.memberKeys] }
}

/**
 * Resolves the owner's current Workspace principal, the way a Public API key of the owner is
 * resolved: an inactive or deprovisioned member, or one without `work-items.read` at the
 * Workspace or the Project, is refused.
 *
 * @param workspaceId - Workspace of the feed.
 * @param memberKey - Owner member key.
 * @param project - Team and Project of a Project feed.
 * @returns The owner's principal.
 */
async function resolveFeedPrincipal(
  workspaceId: string,
  memberKey: string,
  project: { teamId: string, projectId: string } | undefined,
): Promise<WorkspacePrincipal> {
  return resolveDeveloperCredentialPrincipal(
    {
      kind: 'api-key',
      workspaceId,
      credentialId: `calendar-feed:${memberKey}`,
      subjectUserId: memberKey,
      scopes: ['work-items:read'],
    },
    project
      ? { permission: 'work-items.read', teamId: project.teamId, projectId: project.projectId, evaluateProjectScopes: true }
      : { permission: 'work-items.read', evaluateProjectScopes: true },
  )
}

/**
 * Returns the name of a Project the owner can still read.
 *
 * @param principal - Owner's principal.
 * @param teamId - Team of the Project.
 * @param projectId - Project.
 * @returns The name, or `undefined` when the Project is missing or not readable.
 */
async function readFeedProjectContext(
  principal: WorkspacePrincipal,
  teamId: string,
  projectId: string,
): Promise<{ projectName: string } | undefined> {
  const context = await requireTeamPermission(principal, teamId, 'viewer')
  const project = context.team.projects.find((candidate) => candidate.id === projectId)
  if (!project || !canAccessAssignedProject(principal, context, projectId, 'viewer')) return undefined
  return { projectName: project.name }
}

/**
 * Runs a read and turns a lost permission, a removed member, or a closed Workspace into
 * {@link CalendarFeedError} `not-found`, or into the fallback value when one is given.
 *
 * @param read - Read to run.
 * @param onAccessLoss - Value to return instead of raising.
 * @returns The read result.
 */
async function withAccessLoss<T, F = never>(read: () => Promise<T>, onAccessLoss?: () => F): Promise<T | F> {
  try {
    return await read()
  } catch (error) {
    if (!isAccessLoss(error)) throw error
    if (onAccessLoss) return onAccessLoss()
    throw new CalendarFeedError('not-found', 'CalendarFeedAccessLost', 'Calendar feed is unavailable.', { cause: error })
  }
}

/**
 * Returns whether an error means the owner, the Workspace, or the Project is no longer available.
 *
 * @param error - Thrown error.
 * @returns Whether the feed answers like an unknown token.
 */
function isAccessLoss(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('status' in error)) return false
  const status = error.status
  return status === 401 || status === 403 || status === 404 || status === 410 || status === 423
}

/**
 * Error for an unavailable idempotency store.
 *
 * @param cause - Underlying error.
 * @returns A calendar feed error.
 */
function receiptsUnavailable(cause: unknown) {
  return new CalendarFeedError(
    'unavailable',
    'CalendarFeedIdempotencyUnavailable',
    'Calendar feed request receipts are temporarily unavailable.',
    { cause },
  )
}
