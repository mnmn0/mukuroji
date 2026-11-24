import {
  CAPACITY_PLANNING_SCHEMA_VERSION,
  type CapacityPlanningGranularity,
  type WorkspaceWorkloadSnapshot,
} from '@mukuroji/contracts'
import { isRecord } from '../../shared/api/jsonValidation'
import {
  isCellStatus,
  isIsoDate,
  isNonNegativeSafeInteger,
  readErrorMessage,
  readJson,
  WorkloadApiError,
  workloadApiBaseUrl,
} from '../api'

/**
 * Reads the Workspace-wide workload of the members the caller may see, across Teams.
 *
 * @param accessToken - Authenticated Workspace access token.
 * @param input - Inclusive local range and granularity.
 * @param signal - Optional abort signal.
 * @returns Members with Workspace-wide capacity, total allocation, and visible breakdowns.
 */
export async function getWorkspaceWorkload(
  accessToken: string,
  input: {
    /** Inclusive local start date. */
    fromDate: string
    /** Inclusive local end date. */
    toDate: string
    /** Snapshot granularity. */
    granularity: CapacityPlanningGranularity
  },
  signal?: AbortSignal,
): Promise<WorkspaceWorkloadSnapshot> {
  const query = new URLSearchParams({ from: input.fromDate, to: input.toDate, granularity: input.granularity })
  const response = await fetch(`${workloadApiBaseUrl}/workload?${query.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  })
  const data = await readJson(response)
  if (!response.ok) {
    throw new WorkloadApiError(response.status, readErrorMessage(data))
  }
  if (!isWorkspaceWorkloadSnapshot(data)) {
    throw new WorkloadApiError(502, 'Workspace workload response is invalid.')
  }
  return data
}

/**
 * Checks a Workspace workload response before the page renders it.
 *
 * @param value - Response body.
 * @returns Whether the body is a valid snapshot.
 */
function isWorkspaceWorkloadSnapshot(value: unknown): value is WorkspaceWorkloadSnapshot {
  if (!isRecord(value) || value.schemaVersion !== CAPACITY_PLANNING_SCHEMA_VERSION ||
    typeof value.workspaceId !== 'string' ||
    !isIsoDate(value.fromDate) || !isIsoDate(value.toDate) || value.fromDate > value.toDate ||
    (value.granularity !== 'day' && value.granularity !== 'week' && value.granularity !== 'month') ||
    !Array.isArray(value.teams) || !Array.isArray(value.members) || typeof value.generatedAt !== 'string') return false
  return value.teams.every((team) => isRecord(team) && typeof team.teamId === 'string' && typeof team.name === 'string') &&
    value.members.every((member) => isRecord(member) &&
      typeof member.memberId === 'string' &&
      (member.displayName === undefined || typeof member.displayName === 'string') &&
      Array.isArray(member.teamIds) && member.teamIds.every((teamId) => typeof teamId === 'string') &&
      isNonNegativeSafeInteger(member.capacityMinutes) &&
      isNonNegativeSafeInteger(member.allocatedMinutes) &&
      typeof member.overloaded === 'boolean' &&
      Array.isArray(member.cells) && member.cells.every(isWorkspaceWorkloadCell))
}

/**
 * Checks one Workspace workload bucket.
 *
 * @param value - Cell from a response.
 * @returns Whether the cell is valid.
 */
function isWorkspaceWorkloadCell(value: unknown): boolean {
  if (!isRecord(value)) return false
  return isIsoDate(value.fromDate) && isIsoDate(value.toDate) && value.fromDate <= value.toDate &&
    typeof value.label === 'string' &&
    isNonNegativeSafeInteger(value.capacityMinutes) &&
    isNonNegativeSafeInteger(value.allocatedMinutes) &&
    isNonNegativeSafeInteger(value.utilizationPercent) &&
    isNonNegativeSafeInteger(value.hiddenAllocatedMinutes) &&
    typeof value.varianceMinutes === 'number' && Number.isSafeInteger(value.varianceMinutes) &&
    isCellStatus(value.status) &&
    Array.isArray(value.teams) && value.teams.every((team) => isRecord(team) &&
      typeof team.teamId === 'string' && isNonNegativeSafeInteger(team.allocatedMinutes)) &&
    Array.isArray(value.projects) && value.projects.every((project) => isRecord(project) &&
      typeof project.teamId === 'string' &&
      (project.projectId === undefined || typeof project.projectId === 'string') &&
      isNonNegativeSafeInteger(project.allocatedMinutes))
}
