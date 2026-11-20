import {
  isWeeklyReportDate,
  parseSubmitWeeklyReportRequest,
  parseWeeklyReportNotes,
  WEEKLY_REPORT_HISTORY_MAX_PAGE_SIZE,
  WEEKLY_REPORT_MAX_SUBMISSIONS,
  WEEKLY_REPORT_SECTION_NAMES,
  weeklyReportWeekEnd,
  type TeamWeeklyReportMemberStatus,
  type TeamWeeklyReportStatusResponse,
  type WeeklyReportHistoryResponse,
  type WeeklyReportItemInput,
  type WeeklyReportItemView,
  type WeeklyReportNotes,
  type WeeklyReportResponse,
  type WeeklyReportSectionName,
  type WeeklyReportStoredItem,
  type WeeklyReportSubmission,
} from '@mukuroji/contracts'
import { ProjectDataError } from '../../directory'

/** Team of a weekly report request, after the route authorized it. */
export type WeeklyReportTeamScope = {
  /** Workspace directory ID. */
  workspaceId: string
  /** Team the reports belong to. */
  teamId: string
}

/** Author of one member's weekly reports within a Team. */
export type WeeklyReportMemberScope = WeeklyReportTeamScope & {
  /** Normalized (lower-case) member key of the author. */
  memberKey: string
}

/** The stored state of one member's week: saved notes and submission count. */
export type WeeklyReportWeekRecord = {
  /** First day of the week as `YYYY-MM-DD`. */
  weekStart: string
  /** Increments with every saved change to the row, including submissions. */
  revision: number
  /** ISO timestamp of the last change. */
  updatedAt: string
  /** The author's latest saved notes. */
  notes: WeeklyReportNotes
  /** Number of versions submitted for the week. */
  submissionCount: number
  /** ISO timestamp of the latest submission. */
  lastSubmittedAt?: string
}

/** Durable record of one submission request, kept for every version so any retry is recognized. */
export type WeeklyReportSubmissionReceipt = {
  /** Hash of the request's Idempotency-Key and content. */
  receipt: string
  /** Week the request submitted. */
  weekStart: string
  /** Version the request produced. */
  version: number
}

/** Where a Work Item referenced by a stored version is now. */
export type WeeklyReportItemLocation = {
  /** Project the Work Item is assigned to now; absent for a Team-level Work Item. */
  projectId?: string
}

/**
 * Reads where the referenced Work Items are now. Work Items that no longer exist are absent.
 *
 * @param workItemIds - Distinct referenced IDs.
 * @returns Current locations keyed by Work Item ID.
 */
export type WeeklyReportItemLocator = (workItemIds: readonly string[]) => Promise<ReadonlyMap<string, WeeklyReportItemLocation>>

/** One submitted version as stored, before it is filtered for a reader. */
export type StoredWeeklyReportSubmission = {
  /** Version number, 1 for the first submission of the week. */
  version: number
  /** ISO timestamp of the submission. */
  submittedAt: string
  /** First day of the week as `YYYY-MM-DD`. */
  weekStart: string
  /** Last day of the week as `YYYY-MM-DD`. */
  weekEnd: string
  /** Work Item rows of each section, referencing {@link items}. */
  sections: Record<WeeklyReportSectionName, WeeklyReportItemInput[]>
  /** Recorded time rows, referencing {@link items}. */
  time: WeeklyReportItemInput[]
  /** Every referenced Work Item, resolved by the server with the author's permissions. */
  items: WeeklyReportStoredItem[]
  /** Total recorded minutes the author reported. */
  totalMinutes: number
  /** Whether the author's time was only partly read when the report was drafted. */
  timeIsPartial: boolean
  /** Notes submitted with this version. */
  notes: WeeklyReportNotes
}

/** Commit-time inputs shared by every weekly report write. */
export type WeeklyReportMutation<TCallerCheck, TAudit> = {
  /** Mutation time as an ISO timestamp. */
  now: string
  /** Server-built conditions that fail the write when the caller lost access. */
  callerAuthorization: readonly TCallerCheck[]
  /** Audit context of the request, recorded in the same transaction. */
  auditContext: TAudit
}

/** Input of a week row replacement, as the persistence port receives it. */
export type SaveWeeklyReportWeekInput<TCallerCheck, TAudit> = WeeklyReportMemberScope &
  WeeklyReportMutation<TCallerCheck, TAudit> & {
    /** Row read before the change, or `null` when none existed; its revision guards the write. */
    previous: WeeklyReportWeekRecord | null
    /** Row to store. */
    next: WeeklyReportWeekRecord
  }

/** Input of a submission, as the persistence port receives it. */
export type SubmitWeeklyReportStoreInput<TCallerCheck, TAudit> = SaveWeeklyReportWeekInput<TCallerCheck, TAudit> & {
  /** New version to add; never replaced once stored. */
  submission: StoredWeeklyReportSubmission
  /** Receipt stored with the version under the request's key; the write fails if the key exists. */
  receipt: { key: string; receipt: string }
}

/** One page of a member's weeks. */
export type WeeklyReportWeekPage = {
  /** Weeks, newest first. */
  weeks: WeeklyReportWeekRecord[]
  /** Whether older weeks exist. */
  hasMore: boolean
}

/** Persistence port of weekly reports. */
export type WeeklyReportStore<TCallerCheck, TAudit> = {
  /**
   * Reads one member's week with a strongly consistent read.
   *
   * @param scope - Author.
   * @param weekStart - First day of the week.
   * @returns The week, or `null` when nothing was saved for it.
   */
  getWeek(scope: WeeklyReportMemberScope, weekStart: string): Promise<WeeklyReportWeekRecord | null>
  /**
   * Reads the same week of several members.
   *
   * @param scope - Team.
   * @param memberKeys - Normalized member keys.
   * @param weekStart - First day of the week.
   * @returns Weeks keyed by member key; members without a saved week are absent.
   */
  getWeeks(scope: WeeklyReportTeamScope, memberKeys: readonly string[], weekStart: string): Promise<Map<string, WeeklyReportWeekRecord>>
  /**
   * Lists one member's weeks, newest first.
   *
   * @param scope - Author.
   * @param options - Page size, exclusive upper bound, and whether to skip weeks never submitted.
   * @returns One page.
   */
  listWeeks(
    scope: WeeklyReportMemberScope,
    options: { limit: number; before?: string; submittedOnly: boolean },
  ): Promise<WeeklyReportWeekPage>
  /**
   * Lists one member's submitted weeks that start within a range of days.
   *
   * @param scope - Author.
   * @param from - First week start of the range, inclusive.
   * @param to - Last week start of the range, inclusive.
   * @returns The submitted weeks in the range, oldest first.
   */
  listSubmittedWeeksBetween(scope: WeeklyReportMemberScope, from: string, to: string): Promise<WeeklyReportWeekRecord[]>
  /**
   * Reads one submitted version.
   *
   * @param scope - Author.
   * @param weekStart - First day of the week.
   * @param version - Version number.
   * @returns The version, or `null` when it does not exist.
   */
  getSubmission(scope: WeeklyReportMemberScope, weekStart: string, version: number): Promise<StoredWeeklyReportSubmission | null>
  /**
   * Reads the receipt stored by an earlier submission request with the same key.
   *
   * @param scope - Author.
   * @param submissionKey - Key of the request, derived from its Idempotency-Key without content.
   * @returns The receipt, or `null` when no submission used the key.
   */
  getSubmissionReceipt(scope: WeeklyReportMemberScope, submissionKey: string): Promise<WeeklyReportSubmissionReceipt | null>
  /**
   * Replaces a week's notes when the row still has the previous revision.
   *
   * @param input - Replacement input.
   */
  saveDraft(input: SaveWeeklyReportWeekInput<TCallerCheck, TAudit>): Promise<void>
  /**
   * Adds a submitted version and advances the week row in one transaction.
   *
   * @param input - Submission input.
   */
  submit(input: SubmitWeeklyReportStoreInput<TCallerCheck, TAudit>): Promise<void>
}

/** Decides whether the reader may see a Work Item resolved into a report. */
export type WeeklyReportItemReadCheck = (item: WeeklyReportStoredItem) => boolean

/**
 * Resolves Work Item IDs with the author's permissions.
 *
 * @param workItemIds - Distinct Work Item IDs referenced by the report.
 * @returns The Work Items the author may read; unknown or unreadable IDs are absent.
 */
export type WeeklyReportItemResolver = (workItemIds: readonly string[]) => Promise<Map<string, WeeklyReportStoredItem>>

/**
 * Validates a week start taken from the path.
 *
 * @param weekStart - Untrusted path segment.
 * @param today - Today's UTC date as `YYYY-MM-DD`.
 * @returns The week start.
 * @throws ProjectDataError 400 for an invalid date or a week starting more than a week from today.
 */
export function readWeeklyReportWeekStart(weekStart: string | undefined, today: string): string {
  if (!isWeeklyReportDate(weekStart)) {
    throw new ProjectDataError(400, 'InvalidWeeklyReport', 'The week must be a YYYY-MM-DD date.')
  }
  // A report describes a week that has started; one more week covers time zones ahead of UTC.
  if (weekStart > addDays(today, 7)) {
    throw new ProjectDataError(400, 'InvalidWeeklyReport', 'A weekly report cannot be written for a future week.')
  }
  return weekStart
}

/**
 * Adds days to a `YYYY-MM-DD` date.
 *
 * @param date - Calendar date.
 * @param days - Days to add.
 * @returns The shifted date.
 */
function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

/**
 * Converts one stored row to what a reader sees.
 *
 * @param row - Stored row.
 * @param items - Resolved Work Items keyed by ID.
 * @param canRead - Reader check.
 * @param locations - Where the Work Items are now; a Work Item found there is checked at its
 *   current Project instead of the one stored at submission.
 * @returns The visible row, or a hidden row carrying only the minutes.
 */
function toItemView(
  row: WeeklyReportItemInput,
  items: ReadonlyMap<string, WeeklyReportStoredItem>,
  canRead: WeeklyReportItemReadCheck,
  locations?: ReadonlyMap<string, WeeklyReportItemLocation>,
): WeeklyReportItemView {
  const item = items.get(row.workItemId)
  if (!item) return { hidden: true, minutes: row.minutes }
  const location = locations?.get(item.workItemId)
  const checked: WeeklyReportStoredItem = location === undefined
    ? item
    : {
        workItemId: item.workItemId,
        title: item.title,
        ...(location.projectId === undefined ? {} : { projectId: location.projectId }),
      }
  if (!canRead(checked)) return { hidden: true, minutes: row.minutes }
  return {
    hidden: false,
    workItemId: item.workItemId,
    ...(item.key === undefined ? {} : { key: item.key }),
    title: item.title,
    ...(item.plannedEndDate === undefined ? {} : { plannedEndDate: item.plannedEndDate }),
    minutes: row.minutes,
  }
}

/**
 * Filters a stored version for one reader: Work Items the reader may not read lose their ID,
 * key, and title, and keep only their minutes.
 *
 * @param submission - Stored version.
 * @param canRead - Reader check.
 * @param locations - Where the Work Items are now, when known.
 * @returns The version as the reader sees it.
 */
export function toWeeklyReportSubmissionView(
  submission: StoredWeeklyReportSubmission,
  canRead: WeeklyReportItemReadCheck,
  locations?: ReadonlyMap<string, WeeklyReportItemLocation>,
): WeeklyReportSubmission {
  const items = new Map(submission.items.map((item) => [item.workItemId, item]))
  const view = (rows: readonly WeeklyReportItemInput[]) => rows.map((row) => toItemView(row, items, canRead, locations))
  return {
    version: submission.version,
    submittedAt: submission.submittedAt,
    weekStart: submission.weekStart,
    weekEnd: submission.weekEnd,
    sections: {
      completed: view(submission.sections.completed),
      started: view(submission.sections.started),
      overdue: view(submission.sections.overdue),
      upcoming: view(submission.sections.upcoming),
    },
    time: view(submission.time),
    totalMinutes: submission.totalMinutes,
    timeIsPartial: submission.timeIsPartial,
    notes: { ...submission.notes },
  }
}

/** Options of {@link readWeeklyReportUseCase}. */
export type ReadWeeklyReportOptions = {
  /** Whether the reader is the author, who also sees the saved notes. */
  includeDraft: boolean
  /** Version to read; the latest when omitted. */
  version?: number
  /** Reader check applied to every Work Item. */
  canReadItem: WeeklyReportItemReadCheck
  /**
   * Reads where the version's Work Items are now, so one moved to a Project the reader cannot
   * read is hidden. Without it, the Project stored at submission is checked.
   */
  locateItems?: WeeklyReportItemLocator
}

/**
 * Reads one member's week: the latest or requested version and, for the author, the saved notes.
 *
 * @param store - Weekly report persistence.
 * @param scope - Authorized author.
 * @param weekStart - First day of the week.
 * @param options - Reader options.
 * @returns The report response.
 * @throws ProjectDataError 404 when the requested version does not exist.
 */
export async function readWeeklyReportUseCase<TCallerCheck, TAudit>(
  store: WeeklyReportStore<TCallerCheck, TAudit>,
  scope: WeeklyReportMemberScope,
  weekStart: string,
  options: ReadWeeklyReportOptions,
): Promise<WeeklyReportResponse> {
  const week = await store.getWeek(scope, weekStart)
  const submissionCount = week?.submissionCount ?? 0
  const version = options.version ?? submissionCount
  if (options.version !== undefined && (version < 1 || version > submissionCount)) {
    throw new ProjectDataError(404, 'WeeklyReportVersionNotFound', 'The weekly report version was not found.')
  }
  return await buildWeeklyReportResponse(store, scope, weekStart, week, version, options)
}

/**
 * Builds a report response from a week row the caller already holds, reading only the requested
 * version, which never changes once stored.
 *
 * @param store - Weekly report persistence.
 * @param scope - Authorized author.
 * @param weekStart - First day of the week.
 * @param week - Week row to report, or `null` when nothing was saved.
 * @param version - Version to include; 0 for none.
 * @param options - Reader options.
 * @returns The report response.
 * @throws ProjectDataError 502 when the version is missing.
 */
async function buildWeeklyReportResponse<TCallerCheck, TAudit>(
  store: WeeklyReportStore<TCallerCheck, TAudit>,
  scope: WeeklyReportMemberScope,
  weekStart: string,
  week: WeeklyReportWeekRecord | null,
  version: number,
  options: ReadWeeklyReportOptions,
): Promise<WeeklyReportResponse> {
  const submission = version > 0 ? await store.getSubmission(scope, weekStart, version) : null
  if (version > 0 && !submission) {
    throw new ProjectDataError(502, 'WeeklyReportCorruptState', 'The stored weekly report is invalid.')
  }
  const locations = submission && options.locateItems
    ? await options.locateItems(submission.items.map((item) => item.workItemId))
    : undefined
  return {
    teamId: scope.teamId,
    memberKey: scope.memberKey,
    weekStart,
    submissionCount: week?.submissionCount ?? 0,
    ...(options.includeDraft && week
      ? { draft: { revision: week.revision, updatedAt: week.updatedAt, notes: { ...week.notes } } }
      : {}),
    ...(submission ? { submission: toWeeklyReportSubmissionView(submission, options.canReadItem, locations) } : {}),
  }
}

/**
 * Saves the author's notes for a week without submitting.
 *
 * @param store - Weekly report persistence.
 * @param scope - Authorized author.
 * @param weekStart - First day of the week.
 * @param body - Untrusted request body.
 * @param mutation - Mutation time, caller fences, and audit context.
 * @returns The report response with the notes this request saved and the version they follow.
 * @throws ProjectDataError 400 for an invalid body and 409 for a stale revision.
 */
export async function saveWeeklyReportDraftUseCase<TCallerCheck, TAudit>(
  store: WeeklyReportStore<TCallerCheck, TAudit>,
  scope: WeeklyReportMemberScope,
  weekStart: string,
  body: unknown,
  mutation: WeeklyReportMutation<TCallerCheck, TAudit> & { canReadItem: WeeklyReportItemReadCheck; locateItems?: WeeklyReportItemLocator },
): Promise<WeeklyReportResponse> {
  const record = isRecord(body) ? body : {}
  const expectedRevision = record.expectedRevision
  if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new ProjectDataError(400, 'InvalidWeeklyReport', 'expectedRevision must be a non-negative integer.')
  }
  const notes = parseWeeklyReportNotes(record.notes)
  if (!notes.ok) throw new ProjectDataError(400, 'InvalidWeeklyReport', notes.message)
  const previous = await store.getWeek(scope, weekStart)
  const readOptions: ReadWeeklyReportOptions = {
    includeDraft: true,
    canReadItem: mutation.canReadItem,
    ...(mutation.locateItems ? { locateItems: mutation.locateItems } : {}),
  }
  if (
    previous &&
    previous.revision === expectedRevision + 1 &&
    sameNotes(previous.notes, notes.value)
  ) {
    // The same notes already produced the current revision, and only the response was lost.
    return await buildWeeklyReportResponse(store, scope, weekStart, previous, previous.submissionCount, readOptions)
  }
  if ((previous?.revision ?? 0) !== expectedRevision) throw staleWeek()
  const next: WeeklyReportWeekRecord = {
    ...(previous ?? { weekStart, submissionCount: 0 }),
    weekStart,
    revision: expectedRevision + 1,
    updatedAt: mutation.now,
    notes: notes.value,
  }
  await store.saveDraft({ ...scope, ...mutation, previous, next })
  // Answer with what this request stored, not a later save from another window.
  return await buildWeeklyReportResponse(store, scope, weekStart, next, next.submissionCount, readOptions)
}

/** Submission-specific inputs of {@link submitWeeklyReportUseCase}. */
export type SubmitWeeklyReportMutation<TCallerCheck, TAudit> = WeeklyReportMutation<TCallerCheck, TAudit> & {
  /** Receipt of this request, derived from its Idempotency-Key and content. */
  submissionReceipt: string
  /** Key of this request without its content. */
  submissionKey: string
  /** Resolves the referenced Work Items with the author's permissions. */
  resolveItems: WeeklyReportItemResolver
  /** Reader check for the response, which the author reads. */
  canReadItem: WeeklyReportItemReadCheck
  /** Reads where the Work Items of an earlier version are now, for a retried request. */
  locateItems?: WeeklyReportItemLocator
}

/**
 * Submits a new version of the author's report for a week.
 *
 * The server keeps only the Work Items the author may read and copies their key, title, Project,
 * and planned end from the Work Item, so a reader's filter is decided by the real Project.
 *
 * @param store - Weekly report persistence.
 * @param scope - Authorized author.
 * @param weekStart - First day of the week.
 * @param body - Untrusted request body.
 * @param mutation - Mutation time, caller fences, audit context, request receipt, and resolvers.
 * @returns The report response with the new version.
 * @throws ProjectDataError 400 for an invalid body, 409 for a stale count or reused key, and 413
 *   when the week already has the most versions allowed.
 */
export async function submitWeeklyReportUseCase<TCallerCheck, TAudit>(
  store: WeeklyReportStore<TCallerCheck, TAudit>,
  scope: WeeklyReportMemberScope,
  weekStart: string,
  body: unknown,
  mutation: SubmitWeeklyReportMutation<TCallerCheck, TAudit>,
): Promise<WeeklyReportResponse> {
  const parsed = parseSubmitWeeklyReportRequest(body)
  if (!parsed.ok) throw new ProjectDataError(400, 'InvalidWeeklyReport', parsed.message)
  const request = parsed.value
  const readOptions: ReadWeeklyReportOptions = {
    includeDraft: true,
    canReadItem: mutation.canReadItem,
    ...(mutation.locateItems ? { locateItems: mutation.locateItems } : {}),
  }
  // The receipt is checked before the count, so a retry is recognized even after later versions.
  const stored = await store.getSubmissionReceipt(scope, mutation.submissionKey)
  if (stored) {
    if (stored.receipt !== mutation.submissionReceipt || stored.weekStart !== weekStart) {
      throw new ProjectDataError(409, 'WeeklyReportIdempotencyConflict', 'This Idempotency-Key was already used for another submission.')
    }
    // This same request already produced a version, and only the response was lost.
    return await buildWeeklyReportResponse(store, scope, weekStart, await store.getWeek(scope, weekStart), stored.version, readOptions)
  }
  const previous = await store.getWeek(scope, weekStart)
  const previousCount = previous?.submissionCount ?? 0
  // A stale count means another submission; a stale revision means notes saved elsewhere that
  // this submission would replace.
  if (previousCount !== request.expectedSubmissionCount || (previous?.revision ?? 0) !== request.expectedRevision) {
    throw staleWeek()
  }
  if (previousCount >= WEEKLY_REPORT_MAX_SUBMISSIONS) {
    throw new ProjectDataError(413, 'WeeklyReportSubmissionLimit', `A week can be submitted at most ${WEEKLY_REPORT_MAX_SUBMISSIONS} times.`)
  }

  const referenced = new Set<string>()
  for (const name of WEEKLY_REPORT_SECTION_NAMES) for (const row of request.sections[name]) referenced.add(row.workItemId)
  for (const row of request.time) referenced.add(row.workItemId)
  const resolved = await mutation.resolveItems([...referenced])
  const keep = (rows: readonly WeeklyReportItemInput[]) => rows.filter((row) => resolved.has(row.workItemId))
  const sections: Record<WeeklyReportSectionName, WeeklyReportItemInput[]> = {
    completed: keep(request.sections.completed),
    started: keep(request.sections.started),
    overdue: keep(request.sections.overdue),
    upcoming: keep(request.sections.upcoming),
  }
  const time = keep(request.time)
  const used = new Set([...Object.values(sections).flat(), ...time].map((row) => row.workItemId))
  const items = [...resolved.values()].filter((item) => used.has(item.workItemId))

  const version = previousCount + 1
  const submission: StoredWeeklyReportSubmission = {
    version,
    submittedAt: mutation.now,
    weekStart,
    weekEnd: weeklyReportWeekEnd(weekStart),
    sections,
    time,
    items,
    totalMinutes: request.totalMinutes,
    timeIsPartial: request.timeIsPartial,
    notes: request.notes,
  }
  const next: WeeklyReportWeekRecord = {
    weekStart,
    revision: (previous?.revision ?? 0) + 1,
    updatedAt: mutation.now,
    notes: request.notes,
    submissionCount: version,
    lastSubmittedAt: mutation.now,
  }
  await store.submit({
    ...scope,
    now: mutation.now,
    callerAuthorization: mutation.callerAuthorization,
    auditContext: mutation.auditContext,
    previous,
    next,
    submission,
    receipt: { key: mutation.submissionKey, receipt: mutation.submissionReceipt },
  })
  // Answer with the version this request stored, not a later one from another window. Its Work
  // Items were resolved just now, so their stored Projects are current.
  return {
    teamId: scope.teamId,
    memberKey: scope.memberKey,
    weekStart,
    submissionCount: next.submissionCount,
    draft: { revision: next.revision, updatedAt: next.updatedAt, notes: { ...next.notes } },
    submission: toWeeklyReportSubmissionView(submission, mutation.canReadItem),
  }
}

/**
 * Lists one member's weeks, newest first.
 *
 * @param store - Weekly report persistence.
 * @param scope - Authorized author.
 * @param options - Untrusted page size and cursor, and whether only submitted weeks are listed.
 * @returns One page of the history.
 * @throws ProjectDataError 400 for an invalid page size or cursor.
 */
export async function listWeeklyReportHistoryUseCase<TCallerCheck, TAudit>(
  store: WeeklyReportStore<TCallerCheck, TAudit>,
  scope: WeeklyReportMemberScope,
  options: { limit?: string; cursor?: string; submittedOnly: boolean },
): Promise<WeeklyReportHistoryResponse> {
  const limit = options.limit === undefined ? 12 : Number(options.limit)
  if (!/^\d+$/u.test(options.limit ?? '12') || !Number.isSafeInteger(limit) || limit < 1 || limit > WEEKLY_REPORT_HISTORY_MAX_PAGE_SIZE) {
    throw new ProjectDataError(400, 'InvalidWeeklyReport', `limit must be between 1 and ${WEEKLY_REPORT_HISTORY_MAX_PAGE_SIZE}.`)
  }
  if (options.cursor !== undefined && !isWeeklyReportDate(options.cursor)) {
    throw new ProjectDataError(400, 'InvalidWeeklyReport', 'cursor is invalid.')
  }
  const page = await store.listWeeks(scope, {
    limit,
    submittedOnly: options.submittedOnly,
    ...(options.cursor === undefined ? {} : { before: options.cursor }),
  })
  const last = page.weeks.at(-1)
  return {
    teamId: scope.teamId,
    memberKey: scope.memberKey,
    weeks: page.weeks.map((week) => ({
      weekStart: week.weekStart,
      submissionCount: week.submissionCount,
      ...(week.lastSubmittedAt === undefined ? {} : { lastSubmittedAt: week.lastSubmittedAt }),
    })),
    ...(page.hasMore && last ? { nextCursor: last.weekStart } : {}),
  }
}

/** Members whose fallback weeks are read at the same time. */
const OVERLAPPING_WEEK_CONCURRENCY = 10

/**
 * Reads the submission state of the members a manager may read, for one week.
 *
 * A member without a submission under the requested week start may have submitted the same
 * calendar week under the start day the Workspace used before. The submitted week that overlaps
 * the requested one most is then reported with its stored week start, so the manager can open it.
 *
 * @param store - Weekly report persistence.
 * @param scope - Authorized Team.
 * @param members - Members the manager may read, with display names.
 * @param weekStart - First day of the week.
 * @returns Every member with their submission count, by display name.
 */
export async function readTeamWeeklyReportStatusUseCase<TCallerCheck, TAudit>(
  store: WeeklyReportStore<TCallerCheck, TAudit>,
  scope: WeeklyReportTeamScope,
  members: readonly { memberKey: string; displayName?: string }[],
  weekStart: string,
): Promise<TeamWeeklyReportStatusResponse> {
  const weeks = await store.getWeeks(scope, members.map((member) => member.memberKey), weekStart)
  const unsubmitted = members.filter((member) => (weeks.get(member.memberKey)?.submissionCount ?? 0) === 0)
  for (let offset = 0; offset < unsubmitted.length; offset += OVERLAPPING_WEEK_CONCURRENCY) {
    await Promise.all(unsubmitted.slice(offset, offset + OVERLAPPING_WEEK_CONCURRENCY).map(async (member) => {
      const candidates = await store.listSubmittedWeeksBetween(
        { ...scope, memberKey: member.memberKey },
        addDays(weekStart, -6),
        addDays(weekStart, 6),
      )
      const closest = pickClosestWeek(candidates, weekStart)
      if (closest) weeks.set(member.memberKey, closest)
    }))
  }
  const rows: TeamWeeklyReportMemberStatus[] = members.map((member) => {
    const week = weeks.get(member.memberKey)
    return {
      memberKey: member.memberKey,
      ...(member.displayName === undefined ? {} : { displayName: member.displayName }),
      submissionCount: week?.submissionCount ?? 0,
      ...(week?.lastSubmittedAt === undefined ? {} : { lastSubmittedAt: week.lastSubmittedAt }),
      ...(week === undefined || week.weekStart === weekStart ? {} : { weekStart: week.weekStart }),
    }
  })
  rows.sort((left, right) =>
    (left.displayName ?? left.memberKey).localeCompare(right.displayName ?? right.memberKey) ||
    left.memberKey.localeCompare(right.memberKey))
  return { teamId: scope.teamId, weekStart, members: rows }
}

/**
 * Picks the submitted week that shares the most days with the requested week.
 *
 * @param candidates - Submitted weeks starting within six days of the requested start.
 * @param weekStart - First day of the requested week.
 * @returns The week whose start is nearest, the earlier one on a tie, or `undefined`.
 */
function pickClosestWeek(candidates: readonly WeeklyReportWeekRecord[], weekStart: string): WeeklyReportWeekRecord | undefined {
  const target = Date.parse(`${weekStart}T00:00:00Z`)
  let best: WeeklyReportWeekRecord | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    if (candidate.submissionCount === 0) continue
    const distance = Math.abs(Date.parse(`${candidate.weekStart}T00:00:00Z`) - target)
    if (distance < bestDistance || (distance === bestDistance && best !== undefined && candidate.weekStart < best.weekStart)) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/**
 * Compares two sets of notes.
 *
 * @param left - First notes.
 * @param right - Second notes.
 * @returns Whether both fields are equal.
 */
function sameNotes(left: WeeklyReportNotes, right: WeeklyReportNotes) {
  return left.issues === right.issues && left.reflection === right.reflection
}

/**
 * Creates the error for a week changed since it was read.
 *
 * @returns The error.
 */
function staleWeek() {
  return new ProjectDataError(409, 'WeeklyReportConflict', 'The weekly report changed. Reload and try again.')
}

/**
 * Narrows an unknown value to a plain object.
 *
 * @param value - Value to check.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
