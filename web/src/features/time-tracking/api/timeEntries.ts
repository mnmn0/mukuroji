import type { TimeEntry, TimeEntryHistory, TimeEntryStatus } from '@mukuroji/contracts'
import { isRecord, isStringArray } from '../../../shared/api/jsonValidation'
import { createMutationHeaders, type MutationRequestContext } from '../../../shared/api/mutationHeaders'
import {
  createInvalidTimeTrackingResponseError,
  createTeamTimeTrackingUrl,
  requestTimeTrackingJson,
} from './timeTrackingRequest'
import { readTimeEntries, readTimeEntry, readTimeEntryHistory } from './timeTrackingValidation'

/** Filters of a time entry list request. */
export type ListTimeEntriesInput = {
  /** Inclusive range start as an ISO 8601 instant. */
  from: string
  /** Exclusive range end as an ISO 8601 instant. */
  to: string
  /** Member whose entries are read; managers may read another member, others always read their own. */
  userId?: string
  /** Lifecycle state to keep. */
  status?: TimeEntryStatus
}

/** Fields of a manual time entry. */
export type TimeEntryDraftInput = {
  /** Canonical Work Item the time was spent on. */
  workItemId: string
  /** Inclusive interval start as an ISO 8601 instant. */
  startAt: string
  /** Exclusive interval end as an ISO 8601 instant. */
  endAt: string
  /** Optional explanation; an empty string clears it on update. */
  description: string
  /** Whether the interval is chargeable. */
  billable: boolean
}

/** Single-entry lifecycle action. */
export type TimeEntryTransitionAction = 'submit' | 'approve' | 'reject' | 'lock'

/** Result of a period-wide lifecycle action. */
export type TimesheetTransitionResult = {
  /** Number of entries that changed state. */
  count: number
  /** Entries that could not change state and need a later retry. */
  failedEntryIds: string[]
  /** Whether some eligible entries failed. */
  partialFailure: boolean
  /** Entries that changed state. */
  entries: TimeEntry[]
}

/**
 * Lists time entries of a Team in a period.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param teamId - Team that owns the entries.
 * @param input - Period and filters.
 * @returns Entries ordered by start time.
 */
export async function listTimeEntries(
  accessToken: string,
  teamId: string,
  input: ListTimeEntriesInput,
): Promise<TimeEntry[]> {
  const query = new URLSearchParams({ from: input.from, to: input.to, limit: '500' })
  if (input.userId) query.set('userId', input.userId)
  if (input.status) query.set('status', input.status)
  const data = await requestTimeTrackingJson(
    createTeamTimeTrackingUrl(teamId, `/time-entries?${query.toString()}`),
    accessToken,
  )
  const entries = isRecord(data) ? readTimeEntries(data.entries) : undefined
  if (!entries) throw createInvalidTimeTrackingResponseError('Time entry list')
  return entries
}

/**
 * Creates a manual draft entry.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param teamId - Team that owns the Work Item.
 * @param input - Entry fields.
 * @param context - Mutation identity shared by retries.
 * @returns Created draft.
 */
export async function createTimeEntry(
  accessToken: string,
  teamId: string,
  input: TimeEntryDraftInput,
  context: MutationRequestContext,
): Promise<TimeEntry> {
  const description = input.description.trim()
  const data = await requestTimeTrackingJson(createTeamTimeTrackingUrl(teamId, '/time-entries'), accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...createMutationHeaders(context) },
    body: JSON.stringify({
      workItemId: input.workItemId,
      startAt: input.startAt,
      endAt: input.endAt,
      ...(description ? { description } : {}),
      billable: input.billable,
    }),
  })
  return readEntryEnvelope(data, 'Time entry creation')
}

/**
 * Edits a draft or rejected entry with optimistic concurrency.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param entry - Entry being edited, whose revision is expected.
 * @param input - Replacement fields.
 * @param context - Mutation identity shared by retries.
 * @returns Updated entry.
 */
export async function updateTimeEntry(
  accessToken: string,
  entry: Pick<TimeEntry, 'id' | 'revision' | 'teamId'>,
  input: TimeEntryDraftInput,
  context: MutationRequestContext,
): Promise<TimeEntry> {
  const description = input.description.trim()
  const data = await requestTimeTrackingJson(
    createTeamTimeTrackingUrl(entry.teamId, `/time-entries/${encodeURIComponent(entry.id)}`),
    accessToken,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...createMutationHeaders(context) },
      body: JSON.stringify({
        expectedRevision: entry.revision,
        workItemId: input.workItemId,
        startAt: input.startAt,
        endAt: input.endAt,
        description: description || null,
        billable: input.billable,
      }),
    },
  )
  return readEntryEnvelope(data, 'Time entry update')
}

/**
 * Applies one lifecycle action to one entry.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param entry - Entry whose revision is expected.
 * @param action - Lifecycle action.
 * @param context - Mutation identity shared by retries.
 * @param reason - Rejection reason.
 * @returns Entry in its new state.
 */
export async function transitionTimeEntry(
  accessToken: string,
  entry: Pick<TimeEntry, 'id' | 'revision' | 'teamId'>,
  action: TimeEntryTransitionAction,
  context: MutationRequestContext,
  reason?: string,
): Promise<TimeEntry> {
  const trimmedReason = reason?.trim()
  const data = await requestTimeTrackingJson(
    createTeamTimeTrackingUrl(entry.teamId, `/time-entries/${encodeURIComponent(entry.id)}/${action}`),
    accessToken,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...createMutationHeaders(context) },
      body: JSON.stringify({
        expectedRevision: entry.revision,
        ...(trimmedReason ? { reason: trimmedReason } : {}),
      }),
    },
  )
  return readEntryEnvelope(data, 'Time entry transition')
}

/**
 * Applies a lifecycle action to every eligible entry in a period.
 *
 * Submit covers the caller's own draft and rejected entries; approve and reject cover submitted
 * entries; lock covers approved entries. Entries that fail are listed for a later retry.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param teamId - Team that owns the entries.
 * @param action - Lifecycle action.
 * @param period - Inclusive start and exclusive end as ISO 8601 instants.
 * @param context - Mutation identity shared by retries.
 * @returns Changed entries and the entries that still need a retry.
 */
export async function transitionTimesheet(
  accessToken: string,
  teamId: string,
  action: TimeEntryTransitionAction,
  period: { from: string; to: string },
  context: MutationRequestContext,
): Promise<TimesheetTransitionResult> {
  const data = await requestTimeTrackingJson(createTeamTimeTrackingUrl(teamId, `/timesheet/${action}`), accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...createMutationHeaders(context) },
    body: JSON.stringify({ from: period.from, to: period.to }),
  })
  const entries = isRecord(data) ? readTimeEntries(data.entries) : undefined
  if (
    !isRecord(data) || !entries || typeof data.count !== 'number' ||
    !isStringArray(data.failedEntryIds) || typeof data.partialFailure !== 'boolean'
  ) {
    throw createInvalidTimeTrackingResponseError('Timesheet transition')
  }
  return { count: data.count, failedEntryIds: data.failedEntryIds, partialFailure: data.partialFailure, entries }
}

/**
 * Reads the immutable lifecycle history of one entry.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param teamId - Team that owns the entry.
 * @param entryId - Entry identifier.
 * @returns History records in the order the API returns them.
 */
export async function listTimeEntryHistory(
  accessToken: string,
  teamId: string,
  entryId: string,
): Promise<TimeEntryHistory[]> {
  const data = await requestTimeTrackingJson(
    createTeamTimeTrackingUrl(teamId, `/time-entries/${encodeURIComponent(entryId)}/history`),
    accessToken,
  )
  const history = isRecord(data) && Array.isArray(data.history) ? data.history.map(readTimeEntryHistory) : undefined
  if (!history || history.some((record) => record === undefined)) {
    throw createInvalidTimeTrackingResponseError('Time entry history')
  }
  return history.filter((record) => record !== undefined)
}

/**
 * Reads the `{ entry }` envelope of an entry mutation.
 *
 * @param data - Untrusted response body.
 * @param subject - Endpoint subject for the error message.
 * @returns Validated entry.
 */
function readEntryEnvelope(data: unknown, subject: string): TimeEntry {
  const entry = isRecord(data) ? readTimeEntry(data.entry) : undefined
  if (!entry) throw createInvalidTimeTrackingResponseError(subject)
  return entry
}
