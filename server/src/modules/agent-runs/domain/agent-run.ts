import { createHash, randomUUID } from 'node:crypto'
import {
  AGENT_RUN_AGENT_NAME_MAX_LENGTH,
  AGENT_RUN_DEFAULT_LEASE_MINUTES,
  AGENT_RUN_FINISH_OUTCOMES,
  AGENT_RUN_INSTANCE_ID_MAX_LENGTH,
  AGENT_RUN_MAX_LEASE_MINUTES,
  AGENT_RUN_MIN_LEASE_MINUTES,
  AGENT_RUN_RUNTIMES,
  AGENT_RUN_SCHEMA_VERSION,
  AGENT_SETTINGS_SCHEMA_VERSION,
  type AgentRun,
  type AgentRunFinishOutcome,
  type AgentRunOutcome,
  type AgentRunRuntime,
  type AgentSettings,
  type StartAgentRunRequest,
  type UpdateAgentSettingsRequest,
} from '@mukuroji/contracts'
import { AgentRunError } from './agent-run-error'

/** Persisted Agent Run, including audit-only fields that responses never expose. */
export type StoredAgentRun = {
  /** Agent Run contract schema version. */
  schemaVersion: typeof AGENT_RUN_SCHEMA_VERSION
  /** Server-assigned run ID. */
  runId: string
  /** Workspace that owns the run. */
  directoryId: string
  /** Team that owns the claimed Work Item. */
  teamId: string
  /** Claimed Work Item ID. */
  workItemId: string
  /** Member responsible for the Work Item when the run started. */
  assigneeUserId: string
  /** Client runtime. */
  runtime: AgentRunRuntime
  /** Display name of the agent. */
  agentName: string
  /** SHA-256 of the client instance ID. */
  instanceIdHash: string
  /** Public ID of the credential that started the run. */
  credentialId: string
  /** Lifecycle state. */
  state: 'active' | 'finished'
  /** Reason the run finished. */
  outcome?: AgentRunOutcome
  /** Work Item revision produced by the start transition. */
  startRevision: number
  /** Lease length fixed at start. */
  leaseMinutes: number
  /** Start time. */
  startedAt: string
  /** Latest heartbeat or fenced mutation time. */
  lastHeartbeatAt: string
  /** Lease expiry time. */
  leaseExpiresAt: string
  /** Time of the latest explicit heartbeat request, used for rate limiting. */
  lastHeartbeatRequestAt?: string
  /** Finish time. */
  finishedAt?: string
  /** `agent` or the member key that released the run. */
  finishedBy?: string
  /** Number of saved structured reports. */
  reportCount: number
}

/** Persisted claim that fences one Work Item to its single active run. */
export type StoredAgentRunClaim = {
  /** Claimed Work Item ID. */
  workItemId: string
  /** Active run holding the claim. */
  runId: string
  /** Instance hash of the holding run. */
  instanceIdHash: string
  /** Member responsible for the holding run. */
  assigneeUserId: string
}

/**
 * Agent instance that may no longer act on a Work Item without starting a new run, because a person
 * released its run or another instance took it over. Only the same member and instance starting
 * again on the Work Item clears it.
 */
export type AgentRunRevocation = {
  /** Work Item ID. */
  workItemId: string
  /** Member the revoked instance acts for. */
  assigneeUserId: string
  /** Hash of the revoked instance ID. */
  instanceIdHash: string
}

/** Validated input for a run start, with the instance ID already hashed. */
export type ValidatedAgentRunStart = Omit<StartAgentRunRequest, 'instanceId'> & {
  /** SHA-256 of the client instance ID. */
  instanceIdHash: string
}

/** Validated take over request, with the instance ID already hashed. */
export type ValidatedAgentRunTakeOver = Omit<ValidatedAgentRunStart, 'expectedRevision' | 'workflowStatusId'>

/** Validated mutation fence, with the instance ID already hashed. */
export type ValidatedAgentRunFence = {
  /** Run the caller claims to hold. */
  agentRunId?: string
  /** SHA-256 of the caller instance ID. */
  instanceIdHash?: string
}

/** Validated finish request, with the instance ID already hashed. */
export type ValidatedAgentRunFinish = {
  /** Reason the agent is closing the run. */
  outcome: AgentRunFinishOutcome
  /** SHA-256 of the caller instance ID. */
  instanceIdHash: string
}

const runIdPattern = /^run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const agentNamePattern = /^[\p{L}\p{N} ._-]+$/u
const identifierMaxLength = 256

/**
 * Creates a new run ID.
 *
 * @returns `run_` followed by a random UUID.
 */
export function createAgentRunId(): string {
  return `run_${randomUUID()}`
}

/**
 * Hashes an opaque client instance ID so that the raw value is never stored or compared.
 *
 * @param instanceId - Validated client instance ID.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
export function hashAgentInstanceId(instanceId: string): string {
  return createHash('sha256').update(`agent-instance\u0000${instanceId}`).digest('hex')
}

/**
 * Checks whether a value is a well-formed run ID.
 *
 * @param value - Untrusted value.
 * @returns True when the value is a run ID.
 */
export function isAgentRunId(value: unknown): value is string {
  return typeof value === 'string' && runIdPattern.test(value)
}

/**
 * Reads a run ID from untrusted input.
 *
 * @param value - Untrusted value.
 * @param pointer - JSON Pointer reported on failure.
 * @returns The run ID.
 */
export function readAgentRunId(value: unknown, pointer = '/agentRunId'): string {
  if (!isAgentRunId(value)) {
    throw new AgentRunError('validation_failed', 'agentRunId must be a run ID returned by Mukuroji.', { pointer })
  }
  return value
}

/**
 * Reads an opaque client instance ID from untrusted input.
 *
 * @param value - Untrusted value.
 * @param pointer - JSON Pointer reported on failure.
 * @returns The trimmed-free instance ID.
 */
export function readAgentInstanceId(value: unknown, pointer: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > AGENT_RUN_INSTANCE_ID_MAX_LENGTH ||
    value !== value.trim() ||
    [...value].some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  ) {
    throw new AgentRunError(
      'validation_failed',
      `instanceId must be 1-${AGENT_RUN_INSTANCE_ID_MAX_LENGTH} printable characters without surrounding spaces.`,
      { pointer },
    )
  }
  return value
}

/**
 * Checks that a value is a record.
 *
 * @param value - Untrusted value.
 * @returns True for a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Rejects unknown request fields so that typos never silently change behavior.
 *
 * @param body - Request record.
 * @param allowed - Accepted field names.
 * @param label - Request name used in the message.
 */
function assertKnownFields(body: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(body).find((key) => !allowed.includes(key))
  if (unknown !== undefined) {
    throw new AgentRunError('validation_failed', `${label} does not accept field "${unknown}".`, {
      pointer: `/${unknown}`,
    })
  }
}

/**
 * Reads a positive integer revision.
 *
 * @param value - Untrusted value.
 * @param name - Field name.
 * @param allowZero - Whether `0` is accepted.
 * @returns The revision.
 */
function readRevision(value: unknown, name: string, allowZero: boolean): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new AgentRunError('validation_failed', `${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer.`, {
      pointer: `/${name}`,
    })
  }
  return value
}

/**
 * Reads a Team-local identifier such as a workflow status ID.
 *
 * @param value - Untrusted value.
 * @param name - Field name.
 * @returns The identifier.
 */
function readIdentifier(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > identifierMaxLength ||
    value !== value.trim() ||
    value === '.' ||
    value === '..'
  ) {
    throw new AgentRunError('validation_failed', `${name} must be a non-empty identifier.`, { pointer: `/${name}` })
  }
  return value
}

/**
 * Validates a run start request body.
 *
 * @param value - Untrusted JSON body.
 * @returns Start input with a hashed instance ID.
 */
export function readStartAgentRunRequest(value: unknown): ValidatedAgentRunStart {
  if (!isRecord(value)) throw new AgentRunError('validation_failed', 'Agent Run start body is required.')
  assertKnownFields(value, ['expectedRevision', 'workflowStatusId', 'runtime', 'agentName', 'instanceId'], 'Agent Run start')
  return {
    expectedRevision: readRevision(value.expectedRevision, 'expectedRevision', false),
    workflowStatusId: readIdentifier(value.workflowStatusId, 'workflowStatusId'),
    ...readAgentIdentity(value),
  }
}

/**
 * Validates a take over request body.
 *
 * @param value - Untrusted JSON body.
 * @returns Runtime, agent name, and the hash of the instance taking over.
 */
export function readTakeOverAgentRunRequest(value: unknown): ValidatedAgentRunTakeOver {
  if (!isRecord(value)) throw new AgentRunError('validation_failed', 'Agent Run take over body is required.')
  assertKnownFields(value, ['runtime', 'agentName', 'instanceId'], 'Agent Run take over')
  return readAgentIdentity(value)
}

/**
 * Validates the runtime, display name, and instance of an agent.
 *
 * @param value - Untrusted JSON object.
 * @returns Runtime, agent name, and instance hash.
 */
function readAgentIdentity(value: Record<string, unknown>): ValidatedAgentRunTakeOver {
  if (typeof value.runtime !== 'string' || !AGENT_RUN_RUNTIMES.some((runtime) => runtime === value.runtime)) {
    throw new AgentRunError('validation_failed', `runtime must be one of ${AGENT_RUN_RUNTIMES.join(', ')}.`, { pointer: '/runtime' })
  }
  const runtime = AGENT_RUN_RUNTIMES.find((candidate) => candidate === value.runtime) ?? 'other'
  if (
    typeof value.agentName !== 'string' ||
    value.agentName.length === 0 ||
    value.agentName.length > AGENT_RUN_AGENT_NAME_MAX_LENGTH ||
    value.agentName !== value.agentName.trim() ||
    !agentNamePattern.test(value.agentName)
  ) {
    throw new AgentRunError(
      'validation_failed',
      `agentName must be 1-${AGENT_RUN_AGENT_NAME_MAX_LENGTH} letters, digits, spaces, dots, underscores, or hyphens.`,
      { pointer: '/agentName' },
    )
  }
  return {
    runtime,
    agentName: value.agentName,
    instanceIdHash: hashAgentInstanceId(readAgentInstanceId(value.instanceId, '/instanceId')),
  }
}

/**
 * Validates a run heartbeat request body.
 *
 * @param value - Untrusted JSON body.
 * @returns Hash of the instance that asks to extend the lease.
 */
export function readHeartbeatAgentRunRequest(value: unknown): string {
  if (!isRecord(value)) throw new AgentRunError('validation_failed', 'Agent Run heartbeat body is required.')
  assertKnownFields(value, ['instanceId'], 'Agent Run heartbeat')
  return hashAgentInstanceId(readAgentInstanceId(value.instanceId, '/instanceId'))
}

/**
 * Validates a run finish request body.
 *
 * @param value - Untrusted JSON body.
 * @returns The requested outcome and the hash of the instance that asks to finish.
 */
export function readFinishAgentRunRequest(value: unknown): ValidatedAgentRunFinish {
  if (!isRecord(value)) throw new AgentRunError('validation_failed', 'Agent Run finish body is required.')
  assertKnownFields(value, ['outcome', 'instanceId'], 'Agent Run finish')
  const outcome = AGENT_RUN_FINISH_OUTCOMES.find((candidate) => candidate === value.outcome)
  if (!outcome) {
    throw new AgentRunError('validation_failed', `outcome must be one of ${AGENT_RUN_FINISH_OUTCOMES.join(', ')}.`, { pointer: '/outcome' })
  }
  return { outcome, instanceIdHash: hashAgentInstanceId(readAgentInstanceId(value.instanceId, '/instanceId')) }
}

/**
 * Validates optional fence fields sent with a Work Item mutation.
 *
 * @param fence - Raw fence fields; absent fields are ignored.
 * @returns Validated fence, or undefined when no fence field was sent.
 */
export function readAgentRunMutationFence(fence: Record<string, unknown>): ValidatedAgentRunFence | undefined {
  const hasRun = fence.agentRunId !== undefined
  const hasInstance = fence.agentInstanceId !== undefined
  if (!hasRun && !hasInstance) return undefined
  if (hasRun && !hasInstance) {
    throw new AgentRunError('validation_failed', 'agentRunId must be sent together with agentInstanceId.', {
      pointer: '/agentInstanceId',
    })
  }
  return {
    ...(hasRun ? { agentRunId: readAgentRunId(fence.agentRunId) } : {}),
    instanceIdHash: hashAgentInstanceId(readAgentInstanceId(fence.agentInstanceId, '/agentInstanceId')),
  }
}

/**
 * Splits the fence fields from a request body without mutating it.
 *
 * @param body - Untrusted request record.
 * @returns The body without fence fields and the raw fence fields.
 */
export function splitAgentRunMutationFence(body: Record<string, unknown>): {
  /** Request fields other than the fence. */
  rest: Record<string, unknown>
  /** Raw, unvalidated `agentRunId` and `agentInstanceId` fields. */
  fence: Record<string, unknown>
} {
  const { agentRunId, agentInstanceId, ...rest } = body
  return {
    rest,
    fence: {
      ...(agentRunId === undefined ? {} : { agentRunId }),
      ...(agentInstanceId === undefined ? {} : { agentInstanceId }),
    },
  }
}

/**
 * Calculates when a lease expires.
 *
 * @param from - Heartbeat time.
 * @param leaseMinutes - Lease length.
 * @returns UTC ISO 8601 expiry time.
 */
export function calculateLeaseExpiry(from: Date, leaseMinutes: number): string {
  return new Date(from.getTime() + leaseMinutes * 60_000).toISOString()
}

/**
 * Derives whether an active run has outlived its lease.
 *
 * @param run - Stored run.
 * @param now - Read time.
 * @returns True for an active run with an expired lease.
 */
export function isAgentRunStalled(run: Pick<StoredAgentRun, 'state' | 'leaseExpiresAt'>, now: Date): boolean {
  return run.state === 'active' && Date.parse(run.leaseExpiresAt) < now.getTime()
}

/**
 * Builds a new active run.
 *
 * @param input - Scope, validated start input, credential, lease, and time.
 * @returns Run ready to be persisted.
 */
export function createActiveAgentRun(input: {
  /** Workspace ID. */
  directoryId: string
  /** Team ID. */
  teamId: string
  /** Work Item ID. */
  workItemId: string
  /** Responsible member. */
  assigneeUserId: string
  /** Runtime, agent name, and instance hash of the agent that starts or takes over the run. */
  start: ValidatedAgentRunTakeOver
  /** Credential public ID. */
  credentialId: string
  /** Revision the start transition produces. */
  startRevision: number
  /** Lease length from the Team settings. */
  leaseMinutes: number
  /** Start time. */
  now: Date
  /** Run ID; generated when omitted. */
  runId?: string
}): StoredAgentRun {
  const startedAt = input.now.toISOString()
  return {
    schemaVersion: AGENT_RUN_SCHEMA_VERSION,
    runId: input.runId ?? createAgentRunId(),
    directoryId: input.directoryId,
    teamId: input.teamId,
    workItemId: input.workItemId,
    assigneeUserId: input.assigneeUserId,
    runtime: input.start.runtime,
    agentName: input.start.agentName,
    instanceIdHash: input.start.instanceIdHash,
    credentialId: input.credentialId,
    state: 'active',
    startRevision: input.startRevision,
    leaseMinutes: input.leaseMinutes,
    startedAt,
    lastHeartbeatAt: startedAt,
    leaseExpiresAt: calculateLeaseExpiry(input.now, input.leaseMinutes),
    reportCount: 0,
  }
}

/**
 * Builds the finished form of an active run.
 *
 * @param run - Active run.
 * @param outcome - Finish reason.
 * @param finishedBy - `agent` or the releasing member key.
 * @param now - Finish time.
 * @returns Finished run.
 */
export function finishAgentRun(
  run: StoredAgentRun,
  outcome: AgentRunOutcome,
  finishedBy: string,
  now: Date,
): StoredAgentRun {
  const { lastHeartbeatRequestAt: _lastHeartbeatRequestAt, ...rest } = run
  return { ...rest, state: 'finished', outcome, finishedAt: now.toISOString(), finishedBy }
}

/**
 * Projects a stored run onto the public contract.
 *
 * @param run - Stored run.
 * @param now - Read time used to derive `stalled`.
 * @returns Public run without instance hash or credential.
 */
export function toAgentRun(run: StoredAgentRun, now: Date): AgentRun {
  return {
    schemaVersion: run.schemaVersion,
    runId: run.runId,
    teamId: run.teamId,
    workItemId: run.workItemId,
    assigneeUserId: run.assigneeUserId,
    runtime: run.runtime,
    agentName: run.agentName,
    state: run.state,
    ...(run.outcome === undefined ? {} : { outcome: run.outcome }),
    startRevision: run.startRevision,
    leaseMinutes: run.leaseMinutes,
    startedAt: run.startedAt,
    lastHeartbeatAt: run.lastHeartbeatAt,
    leaseExpiresAt: run.leaseExpiresAt,
    stalled: isAgentRunStalled(run, now),
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    ...(run.finishedBy === undefined ? {} : { finishedBy: run.finishedBy }),
    reportCount: run.reportCount,
  }
}

/**
 * Summarizes a holding run for a conflict message without instance or credential data.
 *
 * @param run - Holding run.
 * @param now - Read time.
 * @returns Safe one-line summary.
 */
export function describeHoldingRun(run: StoredAgentRun, now: Date): string {
  return `It is held by ${run.agentName} (${run.runtime}) since ${run.startedAt}${isAgentRunStalled(run, now) ? ', and its lease has expired' : ''}.`
}

/**
 * Returns the settings a Team uses before any were saved.
 *
 * @param teamId - Team ID.
 * @returns Default settings at revision 0.
 */
export function createDefaultAgentSettings(teamId: string): AgentSettings {
  return {
    schemaVersion: AGENT_SETTINGS_SCHEMA_VERSION,
    teamId,
    revision: 0,
    leaseMinutes: AGENT_RUN_DEFAULT_LEASE_MINUTES,
    allowTakeoverAfterLeaseExpiry: false,
  }
}

/**
 * Validates an Agent settings update body.
 *
 * @param value - Untrusted JSON body.
 * @returns Validated update.
 */
export function readUpdateAgentSettingsRequest(value: unknown): UpdateAgentSettingsRequest {
  if (!isRecord(value)) throw new AgentRunError('validation_failed', 'Agent settings body is required.')
  assertKnownFields(value, ['expectedRevision', 'leaseMinutes', 'allowTakeoverAfterLeaseExpiry'], 'Agent settings')
  const leaseMinutes = value.leaseMinutes
  if (
    typeof leaseMinutes !== 'number' ||
    !Number.isSafeInteger(leaseMinutes) ||
    leaseMinutes < AGENT_RUN_MIN_LEASE_MINUTES ||
    leaseMinutes > AGENT_RUN_MAX_LEASE_MINUTES
  ) {
    throw new AgentRunError(
      'validation_failed',
      `leaseMinutes must be an integer from ${AGENT_RUN_MIN_LEASE_MINUTES} to ${AGENT_RUN_MAX_LEASE_MINUTES}.`,
      { pointer: '/leaseMinutes' },
    )
  }
  if (typeof value.allowTakeoverAfterLeaseExpiry !== 'boolean') {
    throw new AgentRunError('validation_failed', 'allowTakeoverAfterLeaseExpiry must be a boolean.', {
      pointer: '/allowTakeoverAfterLeaseExpiry',
    })
  }
  return {
    expectedRevision: readRevision(value.expectedRevision, 'expectedRevision', true),
    leaseMinutes,
    allowTakeoverAfterLeaseExpiry: value.allowTakeoverAfterLeaseExpiry,
  }
}
