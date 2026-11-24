import type { PlanningEntity } from '@mukuroji/contracts'
import {
  calendarFeedName,
  toPlanningFeedEvent,
  toWorkItemFeedEvent,
  type CalendarFeedPlanningEntity,
  type CalendarFeedWorkItem,
} from '../domain/feed-events'
import { renderCalendarFeed, type CalendarFeedEvent } from '../domain/icalendar'
import {
  CalendarFeedError,
  resolveCalendarFeedTokenUseCase,
  type CalendarFeedRecord,
  type CalendarFeedStore,
} from './calendar-feed-use-cases'

/** Largest number of Work Item events one feed returns. */
export const CALENDAR_FEED_WORK_ITEM_LIMIT = 1_000

/** Largest number of Milestone and Cycle events one feed returns. */
export const CALENDAR_FEED_PLANNING_LIMIT = 300

/** Largest number of Work Item pages one feed reads, bounding the rows it evaluates. */
export const CALENDAR_FEED_WORK_ITEM_PAGE_LIMIT = 10

/** Refresh interval the feed suggests to calendar clients. */
const CALENDAR_FEED_REFRESH_MINUTES = 60

/** Work Item fields a feed reads: the event fields and the Project that scopes Planning. */
export type CalendarFeedWorkItemRow = CalendarFeedWorkItem & {
  /** Project the Work Item is assigned to. */
  assignedProjectId?: string
}

/** Planning fields a feed reads: the event fields and what selects the entity. */
export type CalendarFeedPlanningRow = CalendarFeedPlanningEntity &
  Pick<PlanningEntity, 'teamId' | 'projectId' | 'ownerMemberKey'>

/** Which Work Items a feed shows. */
export type CalendarFeedWorkItemFilter =
  | {
      /** Open Work Items of one Project. */
      kind: 'project'
      /** Team of the Project. */
      teamId: string
      /** Project. */
      projectId: string
    }
  | {
      /** Open Work Items the member is assigned to or contributes to. */
      kind: 'member'
      /** Member keys of the owner. */
      memberKeys: readonly string[]
    }

/** One page of Work Items. */
export type CalendarFeedWorkItemPage = {
  /** Work Items of the page, scheduled or not. */
  workItems: readonly CalendarFeedWorkItemRow[]
  /** Cursor of the next page. */
  nextCursor?: string
}

/**
 * What the feed owner can currently read. Every read applies the owner's permissions at the time
 * of the read; a lost permission raises {@link CalendarFeedError} `not-found`.
 */
export interface CalendarFeedOwnerView {
  /** Member keys that identify the owner. */
  readonly memberKeys: readonly string[]
  /** Name of the Project of a Project feed. */
  readonly projectName?: string
  /**
   * Reads one page of open, unarchived Work Items.
   *
   * @param filter - Work Items to read.
   * @param cursor - Cursor of the previous page.
   * @returns The page.
   */
  readWorkItemPage(filter: CalendarFeedWorkItemFilter, cursor?: string): Promise<CalendarFeedWorkItemPage>
  /**
   * Reads the live Milestones and Cycles the owner can read.
   *
   * @returns The entities.
   */
  readPlanningEntities(): Promise<readonly CalendarFeedPlanningRow[]>
}

/** Read ports of the feed use cases. */
export interface CalendarFeedReader {
  /**
   * Opens the owner's view, or returns `undefined` when the owner, the Workspace, or the Project
   * of a Project feed is no longer available.
   *
   * @param workspaceId - Workspace of the feed.
   * @param memberKey - Owner.
   * @param project - Team and Project of a Project feed.
   * @returns The view.
   */
  openOwnerView(
    workspaceId: string,
    memberKey: string,
    project?: { teamId: string, projectId: string },
  ): Promise<CalendarFeedOwnerView | undefined>
  /**
   * Returns the Workspace calendar time zone.
   *
   * @param workspaceId - Workspace.
   * @returns IANA time zone.
   */
  readTimeZone(workspaceId: string): Promise<string>
  /**
   * Counts one request against the feed's rate limit.
   *
   * @param workspaceId - Workspace.
   * @param feedId - Feed.
   * @returns Whether the request may proceed, and when to retry.
   */
  consumeRateLimit(workspaceId: string, feedId: string): Promise<{ allowed: boolean, retryAfterSeconds?: number }>
}

/** Result of {@link readCalendarFeedUseCase}. */
export type CalendarFeedReadResult =
  | {
      /** The iCalendar body. */
      kind: 'feed'
      /** RFC 5545 text. */
      body: string
    }
  | {
      /** Unknown, replaced, or revoked token, or a feed whose owner lost access. */
      kind: 'not-found'
    }
  | {
      /** Too many requests for the feed. */
      kind: 'rate-limited'
      /** Seconds until the window resets. */
      retryAfterSeconds?: number
    }

/**
 * Serves a feed to a calendar client. The token names the feed; the events are read with the
 * owner's current permissions, so anything the owner can no longer read leaves the feed, and a
 * feed whose owner or Project is gone answers like an unknown token.
 *
 * A Project feed shows the Project's open, scheduled Work Items, its Milestones and Cycles, and
 * its Team's Team-wide Cycles. A member feed shows the member's open, scheduled Work Items, the
 * Milestones and Cycles of the Projects and Teams of all the member's open Work Items (scheduled
 * or not), and the Milestones and Cycles the member owns.
 *
 * @param store - Feed persistence.
 * @param reader - Owner view, time zone, and rate limit.
 * @param token - Token route parameter.
 * @param now - Request time.
 * @returns The feed, or why there is none.
 */
export async function readCalendarFeedUseCase<AuditContext, Completion>(
  store: CalendarFeedStore<AuditContext, Completion>,
  reader: CalendarFeedReader,
  token: string | undefined,
  now: Date,
): Promise<CalendarFeedReadResult> {
  const resolved = await resolveCalendarFeedTokenUseCase(store, token)
  if (!resolved) return { kind: 'not-found' }
  const { workspaceId, record } = resolved
  const rateLimit = await reader.consumeRateLimit(workspaceId, record.id)
  if (!rateLimit.allowed) {
    return {
      kind: 'rate-limited',
      ...(rateLimit.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: rateLimit.retryAfterSeconds }),
    }
  }
  try {
    const body = await renderFeed(reader, workspaceId, record, now)
    return body === undefined ? { kind: 'not-found' } : { kind: 'feed', body }
  } catch (error) {
    if (error instanceof CalendarFeedError && error.category === 'not-found') return { kind: 'not-found' }
    throw error
  }
}

/**
 * Builds the iCalendar body of a feed.
 *
 * @param reader - Read ports.
 * @param workspaceId - Workspace of the feed.
 * @param record - Feed.
 * @param now - Request time.
 * @returns The body, or `undefined` when the owner's view is unavailable.
 */
async function renderFeed(
  reader: CalendarFeedReader,
  workspaceId: string,
  record: CalendarFeedRecord,
  now: Date,
): Promise<string | undefined> {
  const project = feedProject(record)
  const view = await reader.openOwnerView(workspaceId, record.memberKey, project)
  if (!view) return undefined
  const filter: CalendarFeedWorkItemFilter = project
    ? { kind: 'project', ...project }
    : { kind: 'member', memberKeys: view.memberKeys }
  const { scheduled, projectKeys, teamIds } = await readFeedWorkItems(view, filter)
  if (project) {
    projectKeys.clear()
    teamIds.clear()
    projectKeys.add(scopeKey(project.teamId, project.projectId))
    teamIds.add(project.teamId)
  }
  const entities = selectPlanningEntities(
    await view.readPlanningEntities(),
    record.kind === 'member' ? new Set(view.memberKeys) : new Set<string>(),
    projectKeys,
    teamIds,
  )
  const events: CalendarFeedEvent[] = [
    ...scheduled.flatMap((workItem) => toEvent(toWorkItemFeedEvent(workItem, record.locale))),
    ...entities.flatMap((entity) => toEvent(toPlanningFeedEvent(entity, record.locale))),
  ]
  return renderCalendarFeed({
    name: project
      ? calendarFeedName('project', record.locale, view.projectName)
      : calendarFeedName('member', record.locale),
    timeZone: await reader.readTimeZone(workspaceId),
    refreshIntervalMinutes: CALENDAR_FEED_REFRESH_MINUTES,
    generatedAt: now,
    events,
  })
}

/**
 * Returns the Team and Project of a Project feed.
 *
 * @param record - Feed.
 * @returns The Project, or `undefined` for the member feed.
 */
function feedProject(record: CalendarFeedRecord) {
  return record.kind === 'project' && record.teamId !== undefined && record.projectId !== undefined
    ? { teamId: record.teamId, projectId: record.projectId }
    : undefined
}

/**
 * Reads the feed's Work Items. Every page read counts toward the Planning scope, scheduled or
 * not; only scheduled Work Items become events, at most {@link CALENDAR_FEED_WORK_ITEM_LIMIT}.
 * Reading stops after {@link CALENDAR_FEED_WORK_ITEM_PAGE_LIMIT} pages so one feed cannot read the
 * whole Workspace.
 *
 * @param view - Owner view.
 * @param filter - Feed filter.
 * @returns Scheduled Work Items and the Projects and Teams of all read Work Items.
 */
async function readFeedWorkItems(view: CalendarFeedOwnerView, filter: CalendarFeedWorkItemFilter) {
  const scheduled: CalendarFeedWorkItemRow[] = []
  const projectKeys = new Set<string>()
  const teamIds = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < CALENDAR_FEED_WORK_ITEM_PAGE_LIMIT; page += 1) {
    const result = await view.readWorkItemPage(filter, cursor)
    for (const workItem of result.workItems) {
      teamIds.add(workItem.teamId)
      if (workItem.assignedProjectId) projectKeys.add(scopeKey(workItem.teamId, workItem.assignedProjectId))
      if (workItem.schedule.mode !== 'unscheduled' && scheduled.length < CALENDAR_FEED_WORK_ITEM_LIMIT) {
        scheduled.push(workItem)
      }
    }
    cursor = result.nextCursor
    if (!cursor) break
  }
  return { scheduled, projectKeys, teamIds }
}

/**
 * Selects the feed's Milestones and Cycles: those of its Projects, the Team-wide Cycles of its
 * Teams, and, for a member feed, those the member owns.
 *
 * @param readable - Entities the owner can read.
 * @param ownerKeys - Owner member keys, empty for a Project feed.
 * @param projectKeys - Projects in scope.
 * @param teamIds - Teams in scope.
 * @returns The entities by start date, at most {@link CALENDAR_FEED_PLANNING_LIMIT}.
 */
function selectPlanningEntities(
  readable: readonly CalendarFeedPlanningRow[],
  ownerKeys: ReadonlySet<string>,
  projectKeys: ReadonlySet<string>,
  teamIds: ReadonlySet<string>,
): CalendarFeedPlanningRow[] {
  return readable
    .filter((entity) => {
      if (entity.projectId !== undefined) {
        if (entity.teamId !== undefined && projectKeys.has(scopeKey(entity.teamId, entity.projectId))) return true
      } else if (entity.type === 'cycle' && entity.teamId !== undefined && teamIds.has(entity.teamId)) {
        return true
      }
      return ownerKeys.has(entity.ownerMemberKey)
    })
    .sort((left, right) =>
      left.forecast.startDate.localeCompare(right.forecast.startDate) || left.id.localeCompare(right.id))
    .slice(0, CALENDAR_FEED_PLANNING_LIMIT)
}

/**
 * Builds a set key of a Team's Project.
 *
 * @param teamId - Team.
 * @param projectId - Project.
 * @returns The key.
 */
function scopeKey(teamId: string, projectId: string) {
  return JSON.stringify([teamId, projectId])
}

/**
 * Wraps an optional event in an array for `flatMap`.
 *
 * @param event - Event, if any.
 * @returns An array of zero or one event.
 */
function toEvent(event: CalendarFeedEvent | undefined): CalendarFeedEvent[] {
  return event ? [event] : []
}
