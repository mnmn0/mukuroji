import {
  WEEKLY_REPORT_SECTION_NAMES,
  type SubmitWeeklyReportRequest,
  type TeamWeeklyReportMemberStatus,
  type TeamWeeklyReportStatusResponse,
  type WeeklyReportDraft,
  type WeeklyReportHistoryEntry,
  type WeeklyReportHistoryResponse,
  type WeeklyReportItemView,
  type WeeklyReportNotes,
  type WeeklyReportResponse,
  type WeeklyReportSectionName,
  type WeeklyReportSubmission,
} from '@mukuroji/contracts'
import { isNonnegativeSafeInteger, isOptionalString, isRecord } from '../../../shared/api/jsonValidation'
import { createMutationHeaders, type MutationRequestContext } from '../../../shared/api/mutationHeaders'
import { createTeamTimeTrackingUrl, requestTimeTrackingJson, TimeTrackingApiError } from './timeTrackingRequest'

/**
 * Builds the URL of one member's weekly report resource.
 *
 * @param teamId - Team the report belongs to.
 * @param memberKey - Author's member key.
 * @param suffix - Path below the member, starting with a slash, or empty.
 * @returns Request URL.
 */
function createMemberUrl(teamId: string, memberKey: string, suffix = ''): string {
  return createTeamTimeTrackingUrl(teamId, `/weekly-reports/${encodeURIComponent(memberKey.toLowerCase())}${suffix}`)
}

/**
 * Creates the error for a response that does not match the contract.
 *
 * @param label - Operation name.
 * @returns The error.
 */
function invalidResponse(label: string): TimeTrackingApiError {
  return new TimeTrackingApiError(502, `${label} returned an invalid response.`, 'InvalidResponse')
}

/**
 * Reads notes.
 *
 * @param value - Untrusted value.
 * @returns The notes, or undefined when invalid.
 */
function readNotes(value: unknown): WeeklyReportNotes | undefined {
  if (!isRecord(value) || typeof value.issues !== 'string' || typeof value.reflection !== 'string') return undefined
  return { issues: value.issues, reflection: value.reflection }
}

/**
 * Reads one Work Item row as the reader sees it.
 *
 * @param value - Untrusted value.
 * @returns The row, or undefined when invalid.
 */
function readItem(value: unknown): WeeklyReportItemView | undefined {
  if (!isRecord(value) || !isNonnegativeSafeInteger(value.minutes)) return undefined
  if (value.hidden === true) return { hidden: true, minutes: value.minutes }
  if (
    value.hidden !== false ||
    typeof value.workItemId !== 'string' ||
    typeof value.title !== 'string' ||
    !isOptionalString(value.key) ||
    !isOptionalString(value.plannedEndDate)
  ) {
    return undefined
  }
  return {
    hidden: false,
    workItemId: value.workItemId,
    ...(value.key === undefined ? {} : { key: value.key }),
    title: value.title,
    ...(value.plannedEndDate === undefined ? {} : { plannedEndDate: value.plannedEndDate }),
    minutes: value.minutes,
  }
}

/**
 * Reads a list of Work Item rows.
 *
 * @param value - Untrusted value.
 * @returns The rows, or undefined when any is invalid.
 */
function readItems(value: unknown): WeeklyReportItemView[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items: WeeklyReportItemView[] = []
  for (const candidate of value) {
    const item = readItem(candidate)
    if (!item) return undefined
    items.push(item)
  }
  return items
}

/**
 * Reads one submitted version.
 *
 * @param value - Untrusted value.
 * @returns The version, or undefined when invalid.
 */
function readSubmission(value: unknown): WeeklyReportSubmission | undefined {
  if (!isRecord(value) || !isRecord(value.sections)) return undefined
  const sections: Partial<Record<WeeklyReportSectionName, WeeklyReportItemView[]>> = {}
  for (const name of WEEKLY_REPORT_SECTION_NAMES) {
    const items = readItems(value.sections[name])
    if (!items) return undefined
    sections[name] = items
  }
  const { completed, started, overdue, upcoming } = sections
  const time = readItems(value.time)
  const notes = readNotes(value.notes)
  if (
    !completed || !started || !overdue || !upcoming || !time || !notes ||
    !isNonnegativeSafeInteger(value.version) ||
    typeof value.submittedAt !== 'string' ||
    typeof value.weekStart !== 'string' ||
    typeof value.weekEnd !== 'string' ||
    !isNonnegativeSafeInteger(value.totalMinutes) ||
    typeof value.timeIsPartial !== 'boolean'
  ) {
    return undefined
  }
  return {
    version: value.version,
    submittedAt: value.submittedAt,
    weekStart: value.weekStart,
    weekEnd: value.weekEnd,
    sections: { completed, started, overdue, upcoming },
    time,
    totalMinutes: value.totalMinutes,
    timeIsPartial: value.timeIsPartial,
    notes,
  }
}

/**
 * Reads the saved notes of a week.
 *
 * @param value - Untrusted value.
 * @returns The draft, or undefined when invalid.
 */
function readDraft(value: unknown): WeeklyReportDraft | undefined {
  if (!isRecord(value) || !isNonnegativeSafeInteger(value.revision) || typeof value.updatedAt !== 'string') return undefined
  const notes = readNotes(value.notes)
  return notes ? { revision: value.revision, updatedAt: value.updatedAt, notes } : undefined
}

/**
 * Reads a weekly report response.
 *
 * @param data - Untrusted body.
 * @param label - Operation name used in errors.
 * @returns The response.
 * @throws TimeTrackingApiError when the body does not match the contract.
 */
function readReportResponse(data: unknown, label: string): WeeklyReportResponse {
  if (
    !isRecord(data) ||
    typeof data.teamId !== 'string' ||
    typeof data.memberKey !== 'string' ||
    typeof data.weekStart !== 'string' ||
    !isNonnegativeSafeInteger(data.submissionCount)
  ) {
    throw invalidResponse(label)
  }
  const draft = data.draft === undefined ? undefined : readDraft(data.draft)
  const submission = data.submission === undefined ? undefined : readSubmission(data.submission)
  if ((data.draft !== undefined && !draft) || (data.submission !== undefined && !submission)) throw invalidResponse(label)
  return {
    teamId: data.teamId,
    memberKey: data.memberKey,
    weekStart: data.weekStart,
    submissionCount: data.submissionCount,
    ...(draft ? { draft } : {}),
    ...(submission ? { submission } : {}),
  }
}

/**
 * Reads one member's week.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param teamId - Team the report belongs to.
 * @param memberKey - Author's member key.
 * @param weekStart - First day of the week.
 * @returns The latest submission and, for the author, the saved notes.
 */
export async function getWeeklyReport(
  accessToken: string,
  teamId: string,
  memberKey: string,
  weekStart: string,
): Promise<WeeklyReportResponse> {
  const data = await requestTimeTrackingJson(createMemberUrl(teamId, memberKey, `/${encodeURIComponent(weekStart)}`), accessToken)
  return readReportResponse(data, 'Weekly report')
}

/**
 * Saves the signed-in member's notes for a week.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param teamId - Team the report belongs to.
 * @param memberKey - The member's own key.
 * @param weekStart - First day of the week.
 * @param input - Expected revision and notes.
 * @param context - Mutation identity shared by retries.
 * @returns The saved report.
 */
export async function saveWeeklyReportDraft(
  accessToken: string,
  teamId: string,
  memberKey: string,
  weekStart: string,
  input: { expectedRevision: number; notes: WeeklyReportNotes },
  context: MutationRequestContext,
): Promise<WeeklyReportResponse> {
  const data = await requestTimeTrackingJson(createMemberUrl(teamId, memberKey, `/${encodeURIComponent(weekStart)}/draft`), accessToken, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...createMutationHeaders(context) },
    body: JSON.stringify(input),
  })
  return readReportResponse(data, 'Weekly report save')
}

/**
 * Submits a new version of the signed-in member's report for a week.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param teamId - Team the report belongs to.
 * @param memberKey - The member's own key.
 * @param weekStart - First day of the week.
 * @param input - Work Item references, time, and notes.
 * @param context - Mutation identity shared by retries.
 * @returns The report with the new version.
 */
export async function submitWeeklyReport(
  accessToken: string,
  teamId: string,
  memberKey: string,
  weekStart: string,
  input: SubmitWeeklyReportRequest,
  context: MutationRequestContext,
): Promise<WeeklyReportResponse> {
  const data = await requestTimeTrackingJson(createMemberUrl(teamId, memberKey, `/${encodeURIComponent(weekStart)}/submissions`), accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...createMutationHeaders(context) },
    body: JSON.stringify(input),
  })
  return readReportResponse(data, 'Weekly report submission')
}

/**
 * Reads one member's weeks, newest first.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param teamId - Team the reports belong to.
 * @param memberKey - Author's member key.
 * @param limit - Weeks to read.
 * @returns The weeks; other readers than the author see only submitted ones.
 */
export async function listWeeklyReportHistory(
  accessToken: string,
  teamId: string,
  memberKey: string,
  limit = 12,
): Promise<WeeklyReportHistoryResponse> {
  const data = await requestTimeTrackingJson(createMemberUrl(teamId, memberKey, `?limit=${limit}`), accessToken)
  if (!isRecord(data) || typeof data.teamId !== 'string' || typeof data.memberKey !== 'string' || !Array.isArray(data.weeks)) {
    throw invalidResponse('Weekly report history')
  }
  const weeks: WeeklyReportHistoryEntry[] = []
  for (const week of data.weeks) {
    if (
      !isRecord(week) ||
      typeof week.weekStart !== 'string' ||
      !isNonnegativeSafeInteger(week.submissionCount) ||
      !isOptionalString(week.lastSubmittedAt)
    ) {
      throw invalidResponse('Weekly report history')
    }
    weeks.push({
      weekStart: week.weekStart,
      submissionCount: week.submissionCount,
      ...(week.lastSubmittedAt === undefined ? {} : { lastSubmittedAt: week.lastSubmittedAt }),
    })
  }
  if (!isOptionalString(data.nextCursor)) throw invalidResponse('Weekly report history')
  return {
    teamId: data.teamId,
    memberKey: data.memberKey,
    weeks,
    ...(data.nextCursor === undefined ? {} : { nextCursor: data.nextCursor }),
  }
}

/**
 * Reads who submitted a report for a week among the members the signed-in manager may read.
 *
 * @param accessToken - Bearer token of the signed-in manager.
 * @param teamId - Team ID.
 * @param weekStart - First day of the week.
 * @returns Each member's submission count.
 */
export async function getTeamWeeklyReportStatus(
  accessToken: string,
  teamId: string,
  weekStart: string,
): Promise<TeamWeeklyReportStatusResponse> {
  const data = await requestTimeTrackingJson(
    createTeamTimeTrackingUrl(teamId, `/weekly-reports?weekStart=${encodeURIComponent(weekStart)}`),
    accessToken,
  )
  if (!isRecord(data) || typeof data.teamId !== 'string' || typeof data.weekStart !== 'string' || !Array.isArray(data.members)) {
    throw invalidResponse('Team weekly reports')
  }
  const members: TeamWeeklyReportMemberStatus[] = []
  for (const member of data.members) {
    if (
      !isRecord(member) ||
      typeof member.memberKey !== 'string' ||
      !isOptionalString(member.displayName) ||
      !isNonnegativeSafeInteger(member.submissionCount) ||
      !isOptionalString(member.lastSubmittedAt)
    ) {
      throw invalidResponse('Team weekly reports')
    }
    members.push({
      memberKey: member.memberKey,
      ...(member.displayName === undefined ? {} : { displayName: member.displayName }),
      submissionCount: member.submissionCount,
      ...(member.lastSubmittedAt === undefined ? {} : { lastSubmittedAt: member.lastSubmittedAt }),
    })
  }
  return { teamId: data.teamId, weekStart: data.weekStart, members }
}
