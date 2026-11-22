import {
  isWorkCalendarAdjustment,
  isWorkspaceCalendarWeekday,
  isWorkspaceHolidayDate,
  readWorkCalendarOverrides,
  type ApplyWorkspaceWorkCalendarInput,
  type PreviewWorkspaceWorkCalendarInput,
  type SaveWorkCalendarInput,
  type WorkCalendar,
  type WorkCalendarChangeDates,
  type WorkCalendarChangeExample,
  type WorkCalendarChangeImpact,
  type WorkCalendarChangeInput,
  type WorkCalendarChangeResult,
  type WorkCalendarResponse,
  type WorkItemScheduleCalendarPolicy,
} from '@mukuroji/contracts'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'
import {
  isNonnegativeSafeInteger,
  isPositiveSafeInteger,
  isRecord,
} from '../../shared/api/jsonValidation'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { WorkspaceAccessApiError } from './errors'

const workCalendarApiBaseUrl = resolveApiBaseUrl('workspace')

/**
 * Reads the calendar of a Team, or of one of its Projects, with the calendar new Work Items take.
 *
 * @param accessToken - Bearer token used for the read.
 * @param teamId - Team to read.
 * @param projectId - Project to read; omitted for the Team calendar.
 * @returns The validated calendar response.
 * @throws WorkspaceAccessApiError When the request fails or the response is malformed.
 */
export async function getWorkCalendar(
  accessToken: string,
  teamId: string,
  projectId?: string,
): Promise<WorkCalendarResponse> {
  const query = projectId === undefined ? '' : `?projectId=${encodeURIComponent(projectId)}`
  const body = await sendWorkCalendarRequest(`${createTeamPath(teamId)}${query}`, accessToken)
  const response = readWorkCalendarResponse(body)
  if (!response) throw invalidResponse()
  return response
}

/**
 * Shows what a Team or Project calendar change would do without saving it.
 *
 * @param accessToken - Bearer token of a member who may change the calendar.
 * @param teamId - Team whose calendar, or Project calendar, changes.
 * @param input - New rules and adjustment.
 * @returns The validated impact.
 */
export async function previewWorkCalendarChange(
  accessToken: string,
  teamId: string,
  input: WorkCalendarChangeInput,
): Promise<WorkCalendarChangeImpact> {
  const body = await sendWorkCalendarRequest(`${createTeamPath(teamId)}/preview`, accessToken, {
    body: JSON.stringify(input),
    method: 'POST',
  })
  const impact = readWorkCalendarChangeImpact(body)
  if (!impact) throw invalidResponse()
  return impact
}

/**
 * Saves a Team or Project calendar and adjusts the Work Items that follow it.
 *
 * @param accessToken - Bearer token of a member who may change the calendar.
 * @param teamId - Team whose calendar, or Project calendar, changes.
 * @param input - New rules, adjustment, and the revision that was read.
 * @param mutationContext - Idempotency and correlation identifiers of the save.
 * @returns The validated result.
 */
export async function saveWorkCalendar(
  accessToken: string,
  teamId: string,
  input: SaveWorkCalendarInput,
  mutationContext: MutationRequestContext,
): Promise<WorkCalendarChangeResult> {
  const body = await sendWorkCalendarRequest(createTeamPath(teamId), accessToken, {
    body: JSON.stringify(input),
    headers: createMutationHeaders(mutationContext),
    method: 'PUT',
  })
  const result = readWorkCalendarChangeResult(body)
  if (!result) throw invalidResponse()
  return result
}

/**
 * Shows what saving Workspace calendar settings would do to the Work Items that follow them.
 *
 * @param accessToken - Bearer token of a Workspace administrator.
 * @param input - Candidate Workspace calendar settings and adjustment.
 * @returns The validated impact.
 */
export async function previewWorkspaceWorkCalendarChange(
  accessToken: string,
  input: PreviewWorkspaceWorkCalendarInput,
): Promise<WorkCalendarChangeImpact> {
  const body = await sendWorkCalendarRequest('/workspace/work-calendar/preview', accessToken, {
    body: JSON.stringify(input),
    method: 'POST',
  })
  const impact = readWorkCalendarChangeImpact(body)
  if (!impact) throw invalidResponse()
  return impact
}

/**
 * Adjusts the Work Items that follow the saved Workspace calendar.
 *
 * @param accessToken - Bearer token of a Workspace administrator.
 * @param input - Adjustment to use.
 * @param mutationContext - Idempotency and correlation identifiers of the change.
 * @returns The validated result.
 */
export async function applyWorkspaceWorkCalendar(
  accessToken: string,
  input: ApplyWorkspaceWorkCalendarInput,
  mutationContext: MutationRequestContext,
): Promise<WorkCalendarChangeResult> {
  const body = await sendWorkCalendarRequest('/workspace/work-calendar/apply', accessToken, {
    body: JSON.stringify(input),
    headers: createMutationHeaders(mutationContext),
    method: 'POST',
  })
  const result = readWorkCalendarChangeResult(body)
  if (!result) throw invalidResponse()
  return result
}

/**
 * Validates a calendar response.
 *
 * @param value - Unknown JSON value.
 * @returns The response, or undefined when its shape is not supported.
 */
export function readWorkCalendarResponse(value: unknown): WorkCalendarResponse | undefined {
  if (!isRecord(value)) return undefined
  const scope = readScope(value.scope)
  const calendar = value.calendar === undefined ? undefined : readWorkCalendar(value.calendar)
  const teamCalendar = value.teamCalendar === undefined ? undefined : readWorkCalendar(value.teamCalendar)
  const resolvedPolicy = readPolicy(value.resolvedPolicy)
  if (
    !scope ||
    (value.calendar !== undefined && !calendar) ||
    (value.teamCalendar !== undefined && !teamCalendar) ||
    !isWorkCalendarAdjustment(value.changeAdjustment) ||
    !resolvedPolicy ||
    typeof value.canManage !== 'boolean'
  ) {
    return undefined
  }
  return {
    scope,
    ...(calendar ? { calendar } : {}),
    ...(teamCalendar ? { teamCalendar } : {}),
    changeAdjustment: value.changeAdjustment,
    resolvedPolicy,
    canManage: value.canManage,
  }
}

/**
 * Validates a calendar change impact.
 *
 * @param value - Unknown JSON value.
 * @returns The impact, or undefined when its shape is not supported.
 */
export function readWorkCalendarChangeImpact(value: unknown): WorkCalendarChangeImpact | undefined {
  if (!isRecord(value) || !Array.isArray(value.examples)) return undefined
  const examples = value.examples.map(readExample)
  if (
    !isWorkCalendarAdjustment(value.adjustment) ||
    !isNonnegativeSafeInteger(value.followingCount) ||
    !isNonnegativeSafeInteger(value.changedCount) ||
    !isNonnegativeSafeInteger(value.fallbackToKeepDurationCount) ||
    !examples.every((example) => example !== undefined)
  ) {
    return undefined
  }
  return {
    adjustment: value.adjustment,
    followingCount: value.followingCount,
    changedCount: value.changedCount,
    examples: examples.filter((example) => example !== undefined),
    fallbackToKeepDurationCount: value.fallbackToKeepDurationCount,
  }
}

/**
 * Validates a calendar change result.
 *
 * @param value - Unknown JSON value.
 * @returns The result, or undefined when its shape is not supported.
 */
function readWorkCalendarChangeResult(value: unknown): WorkCalendarChangeResult | undefined {
  if (!isRecord(value)) return undefined
  const impact = readWorkCalendarChangeImpact(value.impact)
  const calendar = value.calendar === undefined ? undefined : readWorkCalendar(value.calendar)
  if (
    !impact ||
    (value.calendar !== undefined && !calendar) ||
    !isNonnegativeSafeInteger(value.updatedCount) ||
    !isNonnegativeSafeInteger(value.conflictCount)
  ) {
    return undefined
  }
  return {
    ...(calendar ? { calendar } : {}),
    impact,
    updatedCount: value.updatedCount,
    conflictCount: value.conflictCount,
  }
}

/**
 * Validates a stored Team or Project calendar.
 *
 * @param value - Unknown JSON value.
 * @returns The calendar, or undefined when its shape is not supported.
 */
function readWorkCalendar(value: unknown): WorkCalendar | undefined {
  if (!isRecord(value)) return undefined
  const scope = readScope(value.scope)
  const { workingWeekdays, publicHolidays, additionalHolidays } = value
  const overrides = readWorkCalendarOverrides({
    ...(workingWeekdays === undefined ? {} : { workingWeekdays }),
    ...(publicHolidays === undefined ? {} : { publicHolidays }),
    ...(additionalHolidays === undefined ? {} : { additionalHolidays }),
  })
  if (
    !scope ||
    !overrides ||
    (value.changeAdjustment !== undefined && !isWorkCalendarAdjustment(value.changeAdjustment)) ||
    !isPositiveSafeInteger(value.revision) ||
    typeof value.updatedAt !== 'string' ||
    typeof value.updatedBy !== 'string'
  ) {
    return undefined
  }
  return {
    ...overrides,
    scope,
    ...(isWorkCalendarAdjustment(value.changeAdjustment) ? { changeAdjustment: value.changeAdjustment } : {}),
    revision: value.revision,
    updatedAt: value.updatedAt,
    updatedBy: value.updatedBy,
  }
}

/**
 * Validates the scope of a calendar.
 *
 * @param value - Unknown JSON value.
 * @returns The Team or Project scope, or undefined.
 */
function readScope(value: unknown): WorkCalendar['scope'] | undefined {
  if (!isRecord(value) || typeof value.teamId !== 'string' || !value.teamId) return undefined
  if (value.kind === 'team') return { kind: 'team', teamId: value.teamId }
  if (value.kind === 'project' && typeof value.projectId === 'string' && value.projectId) {
    return { kind: 'project', teamId: value.teamId, projectId: value.projectId }
  }
  return undefined
}

/**
 * Validates a resolved calendar policy.
 *
 * @param value - Unknown JSON value.
 * @returns The policy, or undefined.
 */
function readPolicy(value: unknown): WorkItemScheduleCalendarPolicy | undefined {
  if (
    !isRecord(value) ||
    typeof value.timeZone !== 'string' ||
    !Array.isArray(value.workingWeekdays) ||
    !Array.isArray(value.holidays)
  ) {
    return undefined
  }
  const weekdays: unknown[] = value.workingWeekdays
  const holidays: unknown[] = value.holidays
  if (
    weekdays.length === 0 ||
    !weekdays.every(isWorkspaceCalendarWeekday) ||
    !holidays.every(isWorkspaceHolidayDate) ||
    (value.calendarSource !== undefined && value.calendarSource !== 'shared')
  ) {
    return undefined
  }
  return {
    timeZone: value.timeZone,
    workingWeekdays: weekdays.filter(isWorkspaceCalendarWeekday),
    holidays: holidays.filter(isWorkspaceHolidayDate),
    ...(value.calendarSource === 'shared' ? { calendarSource: 'shared' as const } : {}),
  }
}

/**
 * Validates one changed Work Item of an impact.
 *
 * @param value - Unknown JSON value.
 * @returns The example, or undefined.
 */
function readExample(value: unknown): WorkCalendarChangeExample | undefined {
  if (!isRecord(value)) return undefined
  const before = readDates(value.before)
  const after = readDates(value.after)
  if (
    typeof value.teamId !== 'string' ||
    typeof value.workItemId !== 'string' ||
    (value.key !== undefined && typeof value.key !== 'string') ||
    typeof value.title !== 'string' ||
    !before ||
    !after
  ) {
    return undefined
  }
  return {
    teamId: value.teamId,
    workItemId: value.workItemId,
    ...(typeof value.key === 'string' ? { key: value.key } : {}),
    title: value.title,
    before,
    after,
  }
}

/**
 * Validates the dates of a changed Work Item.
 *
 * @param value - Unknown JSON value.
 * @returns The dates, or undefined.
 */
function readDates(value: unknown): WorkCalendarChangeDates | undefined {
  if (
    !isRecord(value) ||
    !isWorkspaceHolidayDate(value.startDate) ||
    !isWorkspaceHolidayDate(value.endDate) ||
    !isNonnegativeSafeInteger(value.durationDays)
  ) {
    return undefined
  }
  return { startDate: value.startDate, endDate: value.endDate, durationDays: value.durationDays }
}

/**
 * Builds the calendar path of a Team.
 *
 * @param teamId - Team ID.
 * @returns The path below the API base URL.
 */
function createTeamPath(teamId: string): string {
  return `/teams/${encodeURIComponent(teamId)}/work-calendar`
}

/**
 * Creates the error for a response the Web cannot trust.
 *
 * @returns The error.
 */
function invalidResponse(): WorkspaceAccessApiError {
  return new WorkspaceAccessApiError(502, 'workspace.workCalendar.invalidResponse')
}

/**
 * Sends one calendar request and returns its parsed body.
 *
 * @param path - Path below the API base URL.
 * @param accessToken - Bearer token.
 * @param init - Request options.
 * @returns The parsed body.
 * @throws WorkspaceAccessApiError When the response is not successful.
 */
async function sendWorkCalendarRequest(
  path: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(`${workCalendarApiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })
  const text = await response.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = undefined
  }
  if (!response.ok) {
    const message = isRecord(data) && typeof data.message === 'string' && data.message.trim()
      ? data.message.trim()
      : 'workspace.workCalendar.requestFailed'
    const code = isRecord(data) && typeof data.code === 'string' ? data.code : undefined
    throw new WorkspaceAccessApiError(response.status, message, code)
  }
  return data
}
