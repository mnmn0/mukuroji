import type { TimeEstimate } from '@mukuroji/contracts'
import { isRecord } from '../../../shared/api/jsonValidation'
import { createMutationHeaders, type MutationRequestContext } from '../../../shared/api/mutationHeaders'
import {
  createInvalidTimeTrackingResponseError,
  createTeamTimeTrackingUrl,
  requestTimeTrackingJson,
} from './timeTrackingRequest'
import { readTimeEstimate } from './timeTrackingValidation'

/**
 * Builds the estimate URL of a Work Item.
 *
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item identifier.
 * @returns Estimate URL.
 */
function createEstimateUrl(teamId: string, workItemId: string): string {
  return createTeamTimeTrackingUrl(teamId, `/work-items/${encodeURIComponent(workItemId)}/time-estimate`)
}

/**
 * Reads the estimate of a Work Item.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item identifier.
 * @returns Estimate, or null when none is set.
 */
export async function getTimeEstimate(
  accessToken: string,
  teamId: string,
  workItemId: string,
): Promise<TimeEstimate | null> {
  const data = await requestTimeTrackingJson(createEstimateUrl(teamId, workItemId), accessToken)
  if (!isRecord(data) || !('estimate' in data)) throw createInvalidTimeTrackingResponseError('Time estimate')
  if (data.estimate === null) return null
  const estimate = readTimeEstimate(data.estimate)
  if (!estimate) throw createInvalidTimeTrackingResponseError('Time estimate')
  return estimate
}

/**
 * Saves the estimate of a Work Item with optimistic concurrency.
 *
 * @param accessToken - Bearer token of the signed-in member.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item identifier.
 * @param estimateMinutes - Planned effort in minutes.
 * @param expectedRevision - Revision being replaced, or 0 for a first estimate.
 * @param context - Mutation identity shared by retries.
 * @returns Saved estimate.
 */
export async function saveTimeEstimate(
  accessToken: string,
  teamId: string,
  workItemId: string,
  estimateMinutes: number,
  expectedRevision: number,
  context: MutationRequestContext,
): Promise<TimeEstimate> {
  const data = await requestTimeTrackingJson(createEstimateUrl(teamId, workItemId), accessToken, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...createMutationHeaders(context) },
    body: JSON.stringify({ estimateMinutes, expectedRevision }),
  })
  const estimate = isRecord(data) ? readTimeEstimate(data.estimate) : undefined
  if (!estimate) throw createInvalidTimeTrackingResponseError('Time estimate update')
  return estimate
}
