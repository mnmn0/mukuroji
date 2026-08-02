import {
  CAPACITY_PLANNING_SCHEMA_VERSION,
  type CapacityPlanningGranularity,
  type ResourceAssignmentStatus,
  type WorkloadMemberSummary,
  type WorkloadHoliday,
  type WorkloadSnapshot,
  type WorkingSchedule,
} from '@mukuroji/contracts'

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

/** Input sent when a member saves recurring availability settings. */
export type SaveWorkloadProfileRequest = {
  /** Optional display name copied from the directory. */
  displayName?: string
  /** Optional role used by resource matching. */
  role?: string
  /** Skill identifiers used by resource matching. */
  skills: string[]
  /** IANA timezone used for local capacity dates. */
  timeZone: string
  /** Recurring weekday schedule. */
  schedule: WorkingSchedule
  /** Local holidays that remove availability. */
  holidays: WorkloadHoliday[]
  /** Expected profile revision, or zero for a new profile. */
  expectedRevision: number
  /** Expected Team workload revision. */
  expectedTeamRevision: number
}

/** Input sent when a member records planned time off. */
export type SaveWorkloadTimeOffRequest = {
  /** Local start date. */
  fromDate: string
  /** Local end date. */
  toDate: string
  /** Optional daily absence in minutes. */
  minutesPerDay?: number
  /** Optional explanation. */
  reason?: string
  /** Approval state. */
  status: 'planned' | 'approved' | 'canceled'
  /** Expected profile revision. */
  expectedRevision: number
  /** Expected Team workload revision. */
  expectedTeamRevision: number
}

/** Input sent when a manager creates a resource request. */
export type CreateWorkloadRequestRequest = {
  /** Optional requesting project. */
  projectId?: string
  /** Human-readable request title. */
  title: string
  /** Optional requested role. */
  role?: string
  /** Required skill identifiers. */
  skillIds: string[]
  /** Local start date. */
  fromDate: string
  /** Local end date. */
  toDate: string
  /** Total requested effort in minutes. */
  requestedMinutes: number
  /** Whether the request is confidential. */
  confidential: boolean
  /** Expected Team workload revision. */
  expectedTeamRevision: number
}

/** Input sent when a manager creates a resource assignment. */
export type CreateWorkloadAssignmentRequest = {
  /** Optional request being fulfilled. */
  requestId?: string
  /** Optional receiving project. */
  projectId?: string
  /** Optional receiving Work Item. */
  workItemId?: string
  /** Assigned member. */
  memberId: string
  /** Optional role represented by the assignment. */
  role?: string
  /** Skills represented by the assignment. */
  skillIds: string[]
  /** Local start date. */
  fromDate: string
  /** Local end date. */
  toDate: string
  /** Reserved capacity in minutes. */
  allocationMinutes: number
  /** Planned effort in minutes. */
  plannedEffortMinutes: number
  /** Whether the assignment is confidential. */
  confidential: boolean
  /** Assignment lifecycle state. */
  status: ResourceAssignmentStatus
  /** Expected Team workload revision. */
  expectedTeamRevision: number
}

/** Input sent when a manager moves or resizes an assignment. */
export type UpdateWorkloadAssignmentRequest = {
  /** New assigned member. */
  memberId?: string
  /** New local start date. */
  fromDate?: string
  /** New local end date. */
  toDate?: string
  /** New reserved capacity in minutes. */
  allocationMinutes?: number
  /** New planned effort in minutes. */
  plannedEffortMinutes?: number
  /** New assignment lifecycle state. */
  status?: ResourceAssignmentStatus
  /** Expected assignment revision. */
  expectedRevision: number
  /** Expected Team workload revision. */
  expectedTeamRevision: number
}

/** Input sent when a manager previews a proposed assignment. */
export type WorkloadWhatIfRequest = {
  /** Local snapshot start date. */
  fromDate: string
  /** Local snapshot end date. */
  toDate: string
  /** Snapshot aggregation. */
  granularity: CapacityPlanningGranularity
  /** Preview member. */
  memberId: string
  /** Existing assignment to replace, when moving an assignment. */
  assignmentId?: string
  /** Proposed local start date. */
  assignmentFromDate: string
  /** Proposed local end date. */
  assignmentToDate: string
  /** Proposed reserved capacity in minutes. */
  allocationMinutes: number
  /** Proposed planned effort in minutes. */
  plannedEffortMinutes: number
}

const workloadApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_API_BASE_URL ?? '/api',
)

/**
 * Fetches a Team workload snapshot for a local date range.
 *
 * @param accessToken - Authenticated Workspace access token.
 * @param teamId - Team whose workload is requested.
 * @param input - Local range and aggregation settings.
 * @param signal - Optional cancellation signal.
 * @returns A visibility-filtered workload snapshot.
 */
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

/**
 * Saves recurring availability for one Team member.
 *
 * @param accessToken - Authenticated Workspace access token.
 * @param teamId - Team containing the member.
 * @param memberId - Member whose profile is saved.
 * @param input - Availability and optimistic-concurrency values.
 */
export async function saveWorkloadProfile(
  accessToken: string,
  teamId: string,
  memberId: string,
  input: SaveWorkloadProfileRequest,
): Promise<void> {
  await sendWorkloadMutation(
    accessToken,
    `/teams/${encodeURIComponent(teamId)}/workload/profiles/${encodeURIComponent(memberId)}`,
    input,
  )
}

/**
 * Saves planned time off for one Team member.
 *
 * @param accessToken - Authenticated Workspace access token.
 * @param teamId - Team containing the member.
 * @param memberId - Member whose time off is saved.
 * @param timeOffId - Stable time-off identifier.
 * @param input - Time-off dates and optimistic-concurrency values.
 */
export async function saveWorkloadTimeOff(
  accessToken: string,
  teamId: string,
  memberId: string,
  timeOffId: string,
  input: SaveWorkloadTimeOffRequest,
): Promise<void> {
  await sendWorkloadMutation(
    accessToken,
    `/teams/${encodeURIComponent(teamId)}/workload/profiles/${encodeURIComponent(memberId)}/time-off/${encodeURIComponent(timeOffId)}`,
    { id: timeOffId, ...input },
  )
}

/**
 * Creates a resource request for a Team.
 *
 * @param accessToken - Authenticated Workspace access token.
 * @param teamId - Team receiving the request.
 * @param input - Request details and optimistic-concurrency value.
 */
export async function createWorkloadRequest(
  accessToken: string,
  teamId: string,
  input: CreateWorkloadRequestRequest,
): Promise<void> {
  await sendWorkloadMutation(
    accessToken,
    `/teams/${encodeURIComponent(teamId)}/workload/requests`,
    input,
    'POST',
  )
}

/**
 * Creates a resource assignment for a Team member.
 *
 * @param accessToken - Authenticated Workspace access token.
 * @param teamId - Team receiving the assignment.
 * @param input - Assignment details and optimistic-concurrency value.
 */
export async function createWorkloadAssignment(
  accessToken: string,
  teamId: string,
  input: CreateWorkloadAssignmentRequest,
): Promise<void> {
  await sendWorkloadMutation(
    accessToken,
    `/teams/${encodeURIComponent(teamId)}/workload/assignments`,
    input,
    'POST',
  )
}

/**
 * Updates a resource assignment after a drag/drop or explicit edit.
 *
 * @param accessToken - Authenticated Workspace access token.
 * @param teamId - Team containing the assignment.
 * @param assignmentId - Assignment being changed.
 * @param input - Changed fields and optimistic-concurrency values.
 */
export async function updateWorkloadAssignment(
  accessToken: string,
  teamId: string,
  assignmentId: string,
  input: UpdateWorkloadAssignmentRequest,
): Promise<void> {
  await sendWorkloadMutation(
    accessToken,
    `/teams/${encodeURIComponent(teamId)}/workload/assignments/${encodeURIComponent(assignmentId)}`,
    input,
    'PATCH',
  )
}

/**
 * Calculates a proposed resource assignment without persisting it.
 *
 * @param accessToken - Authenticated Workspace access token.
 * @param teamId - Team used for the preview.
 * @param input - Proposed assignment and snapshot range.
 * @returns A workload snapshot containing the proposed assignment.
 */
export async function previewWorkloadAssignment(
  accessToken: string,
  teamId: string,
  input: WorkloadWhatIfRequest,
): Promise<WorkloadSnapshot> {
  const response = await fetch(
    `${workloadApiBaseUrl}/teams/${encodeURIComponent(teamId)}/workload/what-if`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    },
  )
  const data = await readJson(response)
  if (!response.ok) throw new WorkloadApiError(response.status, readErrorMessage(data))
  if (!isWorkloadSnapshot(data)) throw new WorkloadApiError(502, 'Workload response is invalid.')
  return data
}

/** Sends a JSON workload mutation and maps its error response consistently. */
async function sendWorkloadMutation(
  accessToken: string,
  path: string,
  body: unknown,
  method: 'PATCH' | 'POST' | 'PUT' = 'PUT',
): Promise<void> {
  const response = await fetch(`${workloadApiBaseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const data = await readJson(response)
  if (!response.ok) throw new WorkloadApiError(response.status, readErrorMessage(data))
}

/** Checks whether a response has the minimum workload snapshot shape. */
function isWorkloadSnapshot(value: unknown): value is WorkloadSnapshot {
  if (!isRecord(value) || value.schemaVersion !== CAPACITY_PLANNING_SCHEMA_VERSION ||
    typeof value.workspaceId !== 'string' || typeof value.teamId !== 'string' ||
    !isIsoDate(value.fromDate) || !isIsoDate(value.toDate) || value.fromDate > value.toDate ||
    !Array.isArray(value.members) || !Array.isArray(value.requests) || !Array.isArray(value.assignments) ||
    !isNonNegativeSafeInteger(value.redactedAssignmentCount) ||
    !isNonNegativeSafeInteger(value.redactedRequestCount) ||
    !isNonNegativeSafeInteger(value.revision) || typeof value.generatedAt !== 'string' ||
    (value.granularity !== 'day' && value.granularity !== 'week' && value.granularity !== 'month')) return false
  return value.members.every((member): member is WorkloadMemberSummary => isRecord(member) &&
    typeof member.memberId === 'string' &&
    typeof member.timeZone === 'string' &&
    Array.isArray(member.skills) && member.skills.every((skill) => typeof skill === 'string') &&
    isWorkingSchedule(member.schedule) &&
    Array.isArray(member.holidays) && member.holidays.every(isWorkloadHoliday) &&
    typeof member.profileRevision === 'number' &&
    Number.isSafeInteger(member.profileRevision) && member.profileRevision >= 0 &&
    Array.isArray(member.cells) && member.cells.every(isWorkloadCell) &&
    isNonNegativeSafeInteger(member.capacityMinutes) &&
    isNonNegativeSafeInteger(member.allocatedMinutes) &&
    isNonNegativeSafeInteger(member.plannedEffortMinutes) &&
    isNonNegativeSafeInteger(member.actualMinutes) &&
    isNonNegativeSafeInteger(member.remainingEffortMinutes) &&
    typeof member.overloaded === 'boolean') &&
    value.requests.every(isResourceRequest) && value.assignments.every(isResourceAssignment)
}

/** Checks the required numeric and date fields of one workload cell. */
function isWorkloadCell(value: unknown): boolean {
  if (!isRecord(value)) return false
  return isIsoDate(value.fromDate) && isIsoDate(value.toDate) && value.fromDate <= value.toDate &&
    typeof value.label === 'string' &&
    isNonNegativeSafeInteger(value.capacityMinutes) &&
    isNonNegativeSafeInteger(value.allocatedMinutes) &&
    isNonNegativeSafeInteger(value.plannedEffortMinutes) &&
    isNonNegativeSafeInteger(value.actualMinutes) &&
    isNonNegativeSafeInteger(value.remainingEffortMinutes) &&
    isNonNegativeSafeInteger(value.utilizationPercent) &&
    typeof value.varianceMinutes === 'number' && Number.isSafeInteger(value.varianceMinutes) &&
    (value.status === 'under' || value.status === 'balanced' || value.status === 'over' || value.status === 'unavailable')
}

/** Checks one resource request returned by a workload snapshot. */
function isResourceRequest(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' && typeof value.workspaceId === 'string' && typeof value.teamId === 'string' &&
    (value.projectId === undefined || typeof value.projectId === 'string') &&
    typeof value.title === 'string' && (value.role === undefined || typeof value.role === 'string') &&
    Array.isArray(value.skillIds) && value.skillIds.every((skill) => typeof skill === 'string') &&
    isIsoDate(value.fromDate) && isIsoDate(value.toDate) && value.fromDate <= value.toDate &&
    isNonNegativeSafeInteger(value.requestedMinutes) && typeof value.confidential === 'boolean' &&
    (value.status === 'open' || value.status === 'partially-filled' || value.status === 'filled' || value.status === 'canceled') &&
    isPositiveSafeInteger(value.revision) && typeof value.createdAt === 'string' && typeof value.updatedAt === 'string'
}

/** Checks one resource assignment returned by a workload snapshot. */
function isResourceAssignment(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' && typeof value.workspaceId === 'string' && typeof value.teamId === 'string' &&
    (value.requestId === undefined || typeof value.requestId === 'string') &&
    (value.projectId === undefined || typeof value.projectId === 'string') &&
    (value.workItemId === undefined || typeof value.workItemId === 'string') &&
    (value.cycleId === undefined || typeof value.cycleId === 'string') &&
    (value.recurringWorkId === undefined || typeof value.recurringWorkId === 'string') &&
    typeof value.memberId === 'string' && (value.role === undefined || typeof value.role === 'string') &&
    Array.isArray(value.skillIds) && value.skillIds.every((skill) => typeof skill === 'string') &&
    isIsoDate(value.fromDate) && isIsoDate(value.toDate) && value.fromDate <= value.toDate &&
    isNonNegativeSafeInteger(value.allocationMinutes) && isNonNegativeSafeInteger(value.plannedEffortMinutes) &&
    typeof value.confidential === 'boolean' &&
    (value.status === 'tentative' || value.status === 'confirmed' || value.status === 'canceled') &&
    isPositiveSafeInteger(value.revision) && typeof value.createdAt === 'string' && typeof value.updatedAt === 'string'
}

/** Checks the seven-day working schedule included in a member summary. */
function isWorkingSchedule(value: unknown): value is WorkingSchedule {
  if (!isRecord(value)) return false
  return ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].every((day) => {
    const entry = value[day]
    return isRecord(entry) && typeof entry.enabled === 'boolean' &&
      typeof entry.minutes === 'number' && Number.isSafeInteger(entry.minutes) && entry.minutes >= 0
  })
}

/** Checks one holiday value at the workload API boundary. */
function isWorkloadHoliday(value: unknown): value is WorkloadHoliday {
  return isRecord(value) && typeof value.date === 'string' &&
    (value.label === undefined || typeof value.label === 'string')
}

/** Checks a non-negative safe integer at the workload API boundary. */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Checks a positive safe integer at the workload API boundary. */
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** Checks a Gregorian calendar date at the workload API boundary. */
function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const parsed = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
}

/** Reads a safe API error message. */
function readErrorMessage(value: unknown): string {
  return typeof value === 'object' && value !== null &&
    'message' in value && typeof value.message === 'string'
    ? value.message
    : 'Workload data could not be loaded.'
}

/** Checks whether an unknown response value is a non-array record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads a JSON response body without assuming its runtime shape. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/** Removes trailing slashes from an API base URL. */
function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '')
}
