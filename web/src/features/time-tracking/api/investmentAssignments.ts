import {
  readTeamInvestmentAssignments,
  type TeamInvestmentAssignments,
  type TeamInvestmentAssignmentsRecord,
} from '@mukuroji/contracts'
import { isNonnegativeSafeInteger, isOptionalString, isRecord } from '../../../shared/api/jsonValidation'
import { createInvalidTimeTrackingResponseError, createTeamTimeTrackingUrl, requestTimeTrackingJson } from './timeTrackingRequest'

/** A Team's investment category assignments with whether the signed-in member may change them. */
export type TeamInvestmentAssignmentsView = {
  /** Saved assignments, or none at revision 0. */
  assignments: TeamInvestmentAssignmentsRecord
  /** Whether the member manages the whole Team and may save the assignments. */
  canEdit: boolean
}

/** Fields of an assignment update; they replace the saved assignments. */
export type SaveTeamInvestmentAssignmentsInput = TeamInvestmentAssignments & {
  /** Revision being replaced, or 0 while the Team has saved none. */
  expectedRevision: number
}

/**
 * Validates the assignment response of the API.
 *
 * @param value - Unknown JSON value.
 * @returns The assignment view, or undefined when the shape is invalid.
 */
export function readTeamInvestmentAssignmentsView(value: unknown): TeamInvestmentAssignmentsView | undefined {
  if (!isRecord(value) || typeof value.canEdit !== 'boolean' || !isRecord(value.assignments)) return undefined
  const { teamId, revision, updatedAt } = value.assignments
  const assignments = readTeamInvestmentAssignments(value.assignments)
  if (!assignments || typeof teamId !== 'string' || !isNonnegativeSafeInteger(revision) || !isOptionalString(updatedAt)) {
    return undefined
  }
  return {
    assignments: { ...assignments, teamId, revision, ...(updatedAt === undefined ? {} : { updatedAt }) },
    canEdit: value.canEdit,
  }
}

/**
 * Reads a Team's investment category assignments (ADR 0116).
 *
 * @param accessToken - Bearer token.
 * @param teamId - Team whose assignments are read.
 * @returns The assignments and whether the member may change them.
 */
export async function getTeamInvestmentAssignments(accessToken: string, teamId: string): Promise<TeamInvestmentAssignmentsView> {
  const data = await requestTimeTrackingJson(createTeamTimeTrackingUrl(teamId, '/investment-assignments'), accessToken)
  const view = readTeamInvestmentAssignmentsView(data)
  if (!view) throw createInvalidTimeTrackingResponseError('Investment assignments')
  return view
}

/**
 * Saves a Team's investment category assignments.
 *
 * @param accessToken - Bearer token.
 * @param teamId - Team whose assignments are saved.
 * @param input - Project and Work Item categories and the revision being replaced.
 * @returns The saved assignments.
 */
export async function saveTeamInvestmentAssignments(
  accessToken: string,
  teamId: string,
  input: SaveTeamInvestmentAssignmentsInput,
): Promise<TeamInvestmentAssignmentsView> {
  const data = await requestTimeTrackingJson(createTeamTimeTrackingUrl(teamId, '/investment-assignments'), accessToken, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projects: input.projects, workItems: input.workItems, expectedRevision: input.expectedRevision }),
  })
  const view = readTeamInvestmentAssignmentsView(data)
  if (!view) throw createInvalidTimeTrackingResponseError('Investment assignments')
  return view
}
