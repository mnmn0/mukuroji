import type { RunningTimer, TimeEntry } from '@mukuroji/contracts'
import { isRecord } from '../../../shared/api/jsonValidation'
import { createMutationHeaders, type MutationRequestContext } from '../../../shared/api/mutationHeaders'
import {
  createInvalidTimeTrackingResponseError,
  createTeamTimeTrackingUrl,
  requestTimeTrackingJson,
  timeTrackingApiBaseUrl,
} from './timeTrackingRequest'
import { readRunningTimer, readTimeEntry } from './timeTrackingValidation'

/** Fields of a timer start request. */
export type StartTimerInput = {
  /** Canonical Work Item the timer measures. */
  workItemId: string
  /** Optional explanation copied to the created entry. */
  description?: string
  /** Whether the resulting interval is chargeable. */
  billable: boolean
}

/**
 * Reads the signed-in member's running timer so it survives reloads and offline periods.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @returns Running timer, or null when none is running.
 */
export async function getActiveTimer(accessToken: string): Promise<RunningTimer | null> {
  const data = await requestTimeTrackingJson(`${timeTrackingApiBaseUrl}/time-tracking/timers/active`, accessToken)
  if (!isRecord(data) || !('timer' in data)) throw createInvalidTimeTrackingResponseError('Active timer')
  if (data.timer === null) return null
  const timer = readRunningTimer(data.timer)
  if (!timer) throw createInvalidTimeTrackingResponseError('Active timer')
  return timer
}

/**
 * Starts the signed-in member's timer on a Work Item.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param teamId - Team that owns the Work Item.
 * @param input - Timer fields.
 * @param context - Mutation identity shared by retries.
 * @returns Started timer.
 */
export async function startTimer(
  accessToken: string,
  teamId: string,
  input: StartTimerInput,
  context: MutationRequestContext,
): Promise<RunningTimer> {
  const description = input.description?.trim()
  const data = await requestTimeTrackingJson(createTeamTimeTrackingUrl(teamId, '/timers'), accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...createMutationHeaders(context) },
    body: JSON.stringify({
      workItemId: input.workItemId,
      ...(description ? { description } : {}),
      billable: input.billable,
    }),
  })
  const timer = isRecord(data) ? readRunningTimer(data.timer) : undefined
  if (!timer) throw createInvalidTimeTrackingResponseError('Timer start')
  return timer
}

/**
 * Stops a running timer and creates its draft entry.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param timerId - Running timer identifier.
 * @param context - Mutation identity shared by retries.
 * @returns Created draft entry.
 */
export async function stopTimer(
  accessToken: string,
  timerId: string,
  context: MutationRequestContext,
): Promise<TimeEntry> {
  const data = await requestTimeTrackingJson(
    `${timeTrackingApiBaseUrl}/time-tracking/timers/${encodeURIComponent(timerId)}/stop`,
    accessToken,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...createMutationHeaders(context) },
      body: JSON.stringify({}),
    },
  )
  const entry = isRecord(data) ? readTimeEntry(data.entry) : undefined
  if (!entry) throw createInvalidTimeTrackingResponseError('Timer stop')
  return entry
}

/**
 * Discards a running timer without creating an entry.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param timerId - Running timer identifier.
 * @param context - Mutation identity shared by retries.
 */
export async function discardTimer(
  accessToken: string,
  timerId: string,
  context: MutationRequestContext,
): Promise<void> {
  await requestTimeTrackingJson(
    `${timeTrackingApiBaseUrl}/time-tracking/timers/${encodeURIComponent(timerId)}`,
    accessToken,
    { method: 'DELETE', headers: createMutationHeaders(context) },
  )
}
