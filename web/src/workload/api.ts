import type { CapacityPlanningGranularity, WorkloadSnapshot } from '@mukuroji/contracts'

/** Error returned by the workload API. */
export class WorkloadApiError extends Error {
  /** HTTP response status. */
  readonly status: number

  /** Creates a workload API error. */
  constructor(status: number, message: string) {
    super(message)
    this.name = 'WorkloadApiError'
    this.status = status
  }
}

const workloadApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_API_BASE_URL ?? '/api',
)

/** Fetches a Team workload snapshot for a local date range. */
export async function getTeamWorkload(
  accessToken: string,
  teamId: string,
  input: {
    /** Inclusive local start date. */
    fromDate: string
    /** Inclusive local end date. */
    toDate: string
    /** Snapshot granularity. */
    granularity: CapacityPlanningGranularity
  },
  signal?: AbortSignal,
): Promise<WorkloadSnapshot> {
  const query = new URLSearchParams({
    from: input.fromDate,
    to: input.toDate,
    granularity: input.granularity,
  })
  const response = await fetch(
    `${workloadApiBaseUrl}/teams/${encodeURIComponent(teamId)}/workload?${query.toString()}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal,
    },
  )
  const data = await readJson(response)
  if (!response.ok) {
    throw new WorkloadApiError(response.status, readErrorMessage(data))
  }
  if (!isWorkloadSnapshot(data)) {
    throw new WorkloadApiError(502, 'Workload response is invalid.')
  }
  return data
}

/** Checks whether a response has the minimum workload snapshot shape. */
function isWorkloadSnapshot(value: unknown): value is WorkloadSnapshot {
  return typeof value === 'object' && value !== null &&
    'schemaVersion' in value && typeof value.schemaVersion === 'number' &&
    'members' in value && Array.isArray(value.members) &&
    'assignments' in value && Array.isArray(value.assignments)
}

/** Reads a safe API error message. */
function readErrorMessage(value: unknown): string {
  return typeof value === 'object' && value !== null &&
    'message' in value && typeof value.message === 'string'
    ? value.message
    : 'Workload data could not be loaded.'
}

/** Reads a JSON response body without assuming its runtime shape. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  return text ? JSON.parse(text) : {}
}

/** Removes trailing slashes from an API base URL. */
function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '')
}
