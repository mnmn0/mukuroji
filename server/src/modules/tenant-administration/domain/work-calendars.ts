import {
  isWorkCalendarAdjustment,
  readWorkCalendarOverrides,
  type WorkCalendar,
  type WorkCalendarAdjustment,
  type WorkCalendarOverrides,
  type WorkCalendarScope,
} from '@mukuroji/contracts'

/** Team or Project scope a stored calendar belongs to. */
export type StoredWorkCalendarScope = Extract<WorkCalendarScope, { kind: 'team' | 'project' }>

/** Calendar values a save writes; the store adds the revision and the audit fields. */
export type WorkCalendarWrite = {
  /** Team or Project that owns the calendar. */
  scope: StoredWorkCalendarScope
  /** New rules of the calendar. */
  overrides: WorkCalendarOverrides
  /** Adjustment of this save; a Team calendar also offers it first for its next change. */
  changeAdjustment?: WorkCalendarAdjustment
}

/** Port that keeps Team and Project calendars (ADR 0058). */
export interface WorkCalendarStore {
  /**
   * Reads one stored calendar.
   *
   * @param workspaceId - Workspace that owns the calendar.
   * @param scope - Team or Project to read.
   * @returns The calendar, or undefined while the scope inherits everything.
   */
  get(workspaceId: string, scope: StoredWorkCalendarScope): Promise<WorkCalendar | undefined>
  /**
   * Lists every stored calendar of a Team: its own and its Projects'.
   *
   * @param workspaceId - Workspace that owns the Team.
   * @param teamId - Team to list.
   * @returns Calendars in key order.
   */
  listTeam(workspaceId: string, teamId: string): Promise<WorkCalendar[]>
  /**
   * Saves a calendar when its stored revision still matches.
   *
   * @param workspaceId - Workspace that owns the calendar.
   * @param write - Calendar values to store.
   * @param expectedRevision - Revision read before the change; 0 when nothing was stored.
   * @param actorMemberKey - Member who saves the calendar.
   * @param now - Save time as an ISO timestamp.
   * @param authorizationFences - Checks on the saving member's authorization, written in the same
   *   transaction so a member whose access changed after the route authorized them saves nothing.
   * @returns The stored calendar.
   * @throws WorkCalendarRevisionConflictError when another save came first.
   * @throws WorkCalendarAuthorizationChangedError when an authorization fence no longer holds.
   */
  save(
    workspaceId: string,
    write: WorkCalendarWrite,
    expectedRevision: number,
    actorMemberKey: string,
    now: string,
    authorizationFences?: readonly WorkCalendarAuthorizationFence[],
  ): Promise<WorkCalendar>
}

/** Read-only DynamoDB condition on one row the saving member's authorization comes from. */
export type WorkCalendarAuthorizationFence = {
  /** Condition check written in the calendar save transaction. */
  ConditionCheck: {
    /** Table of the authorization row. */
    TableName: string | undefined
    /** Key of the authorization row. */
    Key: Record<string, unknown> | undefined
    /** Condition the row must still meet. */
    ConditionExpression: string | undefined
    /** Attribute names the condition uses. */
    ExpressionAttributeNames?: Record<string, string>
    /** Attribute values the condition uses. */
    ExpressionAttributeValues?: Record<string, unknown>
  }
}

/** Raised when the saving member's authorization changed after it was checked. */
export class WorkCalendarAuthorizationChangedError extends Error {
  /** Creates the error. */
  constructor() {
    super('Your access changed while the calendar was being saved. Reload and try again.')
    this.name = 'WorkCalendarAuthorizationChangedError'
  }
}

/** Raised when a calendar changed after the caller read it. */
export class WorkCalendarRevisionConflictError extends Error {
  /** Creates the conflict error. */
  constructor() {
    super('The calendar changed after it was read. Reload and try again.')
    this.name = 'WorkCalendarRevisionConflictError'
  }
}

/** Raised when a stored calendar row cannot be read, so it is never used silently. */
export class InvalidStoredWorkCalendarError extends Error {
  /** Creates the error. */
  constructor() {
    super('A stored Team or Project calendar is invalid.')
    this.name = 'InvalidStoredWorkCalendarError'
  }
}

/** Prefix of every calendar row's sort key in the tenant administration table. */
export const WORK_CALENDAR_RECORD_PREFIX = 'WORK_CALENDAR#TEAM#'

/**
 * Builds the sort key prefix shared by a Team's calendar and its Projects' calendars.
 *
 * @param teamId - Team identifier.
 * @returns Sort key prefix ending in `#`.
 */
export function createTeamWorkCalendarRecordPrefix(teamId: string): string {
  return `${WORK_CALENDAR_RECORD_PREFIX}${teamId}#`
}

/**
 * Builds the sort key of one calendar row.
 *
 * @param scope - Team or Project that owns the calendar.
 * @returns `WORK_CALENDAR#TEAM#<teamId>#` for a Team and
 *   `WORK_CALENDAR#TEAM#<teamId>#PROJECT#<projectId>` for a Project.
 */
export function createWorkCalendarRecordKey(scope: StoredWorkCalendarScope): string {
  const prefix = createTeamWorkCalendarRecordPrefix(scope.teamId)
  return scope.kind === 'team' ? prefix : `${prefix}PROJECT#${scope.projectId}`
}

/**
 * Reads a stored calendar row.
 *
 * @param value - Untrusted stored row, without its key attributes.
 * @returns The calendar, or undefined when any field is invalid.
 */
export function readStoredWorkCalendar(value: unknown): WorkCalendar | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const scope = readStoredScope(Reflect.get(value, 'scope'))
  const overrides = readWorkCalendarOverrides(Reflect.get(value, 'overrides'))
  const changeAdjustment: unknown = Reflect.get(value, 'changeAdjustment')
  const revision: unknown = Reflect.get(value, 'revision')
  const updatedAt: unknown = Reflect.get(value, 'updatedAt')
  const updatedBy: unknown = Reflect.get(value, 'updatedBy')
  if (
    !scope ||
    !overrides ||
    (changeAdjustment !== undefined && !isWorkCalendarAdjustment(changeAdjustment)) ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    typeof updatedAt !== 'string' ||
    Number.isNaN(Date.parse(updatedAt)) ||
    typeof updatedBy !== 'string' ||
    updatedBy.length === 0
  ) {
    return undefined
  }
  return {
    ...overrides,
    scope,
    ...(isWorkCalendarAdjustment(changeAdjustment) ? { changeAdjustment } : {}),
    revision,
    updatedAt,
    updatedBy,
  }
}

/**
 * Reads the stored scope of a calendar row.
 *
 * @param value - Untrusted `scope` field.
 * @returns The scope, or undefined when it is invalid.
 */
function readStoredScope(value: unknown): StoredWorkCalendarScope | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const kind: unknown = Reflect.get(value, 'kind')
  const teamId: unknown = Reflect.get(value, 'teamId')
  const projectId: unknown = Reflect.get(value, 'projectId')
  if (typeof teamId !== 'string' || teamId.length === 0) return undefined
  if (kind === 'team' && projectId === undefined) return { kind, teamId }
  if (kind === 'project' && typeof projectId === 'string' && projectId.length > 0) {
    return { kind, teamId, projectId }
  }
  return undefined
}

/**
 * Builds the calendar a save stores.
 *
 * @param write - Calendar values to store.
 * @param revision - New revision.
 * @param actorMemberKey - Member who saves the calendar.
 * @param now - Save time.
 * @returns The stored calendar.
 */
export function createStoredWorkCalendar(
  write: WorkCalendarWrite,
  revision: number,
  actorMemberKey: string,
  now: string,
): WorkCalendar {
  return {
    scope: { ...write.scope },
    ...(write.overrides.workingWeekdays ? { workingWeekdays: [...write.overrides.workingWeekdays] } : {}),
    ...(write.overrides.publicHolidays ? { publicHolidays: write.overrides.publicHolidays } : {}),
    additionalHolidays: [...write.overrides.additionalHolidays],
    ...(write.changeAdjustment ? { changeAdjustment: write.changeAdjustment } : {}),
    revision,
    updatedAt: now,
    updatedBy: actorMemberKey,
  }
}

/**
 * Splits a stored calendar into the row fields the store writes.
 *
 * @param calendar - Calendar to store.
 * @returns Row fields without key attributes.
 */
export function toStoredWorkCalendarFields(calendar: WorkCalendar): Record<string, unknown> {
  return {
    scope: { ...calendar.scope },
    overrides: {
      ...(calendar.workingWeekdays ? { workingWeekdays: [...calendar.workingWeekdays] } : {}),
      ...(calendar.publicHolidays ? { publicHolidays: calendar.publicHolidays } : {}),
      additionalHolidays: [...calendar.additionalHolidays],
    },
    ...(calendar.changeAdjustment ? { changeAdjustment: calendar.changeAdjustment } : {}),
    revision: calendar.revision,
    updatedAt: calendar.updatedAt,
    updatedBy: calendar.updatedBy,
  }
}

/** Keeps calendars in memory for tests and the in-memory composition. */
export class InMemoryWorkCalendarStore implements WorkCalendarStore {
  /** Stored row fields keyed by Workspace, then sort key. */
  private readonly rows = new Map<string, Map<string, Record<string, unknown>>>()

  /** @inheritdoc */
  async get(workspaceId: string, scope: StoredWorkCalendarScope): Promise<WorkCalendar | undefined> {
    const row = this.rows.get(workspaceId)?.get(createWorkCalendarRecordKey(scope))
    if (!row) return undefined
    const calendar = readStoredWorkCalendar(structuredClone(row))
    if (!calendar) throw new InvalidStoredWorkCalendarError()
    return calendar
  }

  /** @inheritdoc */
  async listTeam(workspaceId: string, teamId: string): Promise<WorkCalendar[]> {
    const prefix = createTeamWorkCalendarRecordPrefix(teamId)
    return [...(this.rows.get(workspaceId) ?? new Map<string, Record<string, unknown>>()).entries()]
      .filter(([recordKey]) => recordKey.startsWith(prefix))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, row]) => {
        const calendar = readStoredWorkCalendar(structuredClone(row))
        if (!calendar) throw new InvalidStoredWorkCalendarError()
        return calendar
      })
  }

  /** @inheritdoc */
  async save(
    workspaceId: string,
    write: WorkCalendarWrite,
    expectedRevision: number,
    actorMemberKey: string,
    now: string,
  ): Promise<WorkCalendar> {
    const rows = this.rows.get(workspaceId) ?? new Map<string, Record<string, unknown>>()
    const recordKey = createWorkCalendarRecordKey(write.scope)
    const current = rows.get(recordKey)
    const currentRevision = current === undefined ? 0 : Reflect.get(current, 'revision')
    if (currentRevision !== expectedRevision) throw new WorkCalendarRevisionConflictError()
    const calendar = createStoredWorkCalendar(write, expectedRevision + 1, actorMemberKey, now)
    rows.set(recordKey, toStoredWorkCalendarFields(calendar))
    this.rows.set(workspaceId, rows)
    return calendar
  }
}
