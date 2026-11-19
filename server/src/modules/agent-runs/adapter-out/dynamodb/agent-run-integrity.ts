import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { isAgentRunId, type StoredAgentRun } from '../../domain/agent-run'
import {
  claimRecordKey,
  createAgentRunPartition,
  finishedRunIndexKeys,
  latestRunRecordKey,
  parseRun,
  revocationRecordKey,
  runRecordKey,
  stallWatermarkRecordKey,
  triageFailedRunPartition,
  triageSweepResumeKey,
  workItemRunSortKey,
} from './agent-run-store'

/** Version of the Agent Run integrity evidence shape. */
export const AGENT_RUN_INTEGRITY_SCHEMA_VERSION = 1

/** Largest number of sample locations reported for one failure code. */
export const AGENT_RUN_INTEGRITY_MAX_SAMPLES = 5

/** Stable failure codes of the Agent Run integrity check, in report order. */
export const AGENT_RUN_INTEGRITY_FAILURE_CODES = [
  'AGENT_RUN_ROW_MALFORMED',
  'AGENT_RUN_ROW_UNRECOGNIZED',
  'AGENT_RUN_PARTITION_UNRESOLVED',
  'AGENT_RUN_MULTIPLE_ACTIVE_RUNS',
  'AGENT_RUN_CLAIM_RUN_MISSING',
  'AGENT_RUN_CLAIM_RUN_NOT_ACTIVE',
  'AGENT_RUN_CLAIM_HOLDER_MISMATCH',
  'AGENT_RUN_ACTIVE_RUN_UNCLAIMED',
  'AGENT_RUN_INDEX_KEYS_MISMATCH',
  'AGENT_RUN_OUTBOX_KEY_INVALID',
  'AGENT_RUN_REVOCATION_ORPHANED',
  'AGENT_RUN_REVOCATION_BLOCKS_ACTIVE_RUN',
  'AGENT_RUN_LATEST_RUN_INVALID',
  'AGENT_RUN_WATERMARK_INVALID',
] as const

/** One stable failure code of the Agent Run integrity check. */
export type AgentRunIntegrityFailureCode = (typeof AGENT_RUN_INTEGRITY_FAILURE_CODES)[number]

/** Team partition of the Agent Run table. */
export type AgentRunIntegrityTeam = {
  /** Workspace ID. */
  directoryId: string
  /** Team ID. */
  teamId: string
}

/**
 * Where an operator finds a broken row. It never carries a member ID, an instance hash, or a
 * revocation sort key, which is derived from both.
 */
export type AgentRunIntegritySample = {
  /** Workspace ID; absent when the partition key could not be resolved. */
  directoryId?: string
  /** Team ID; absent when the partition key could not be resolved. */
  teamId?: string
  /** Work Item ID, when the row names one. */
  workItemId?: string
  /** Run ID, when the row names one. */
  runId?: string
  /** Kind of row, for a row that could not be parsed. */
  recordKind?: AgentRunIntegrityRecordKind
}

/** Kind of row in a Team partition of the Agent Run table. */
export type AgentRunIntegrityRecordKind =
  | 'run'
  | 'claim'
  | 'latest'
  | 'revocation'
  | 'report'
  | 'watermark'
  | 'settings'
  | 'settings-mutation'
  | 'unknown'

/** One observed violation of an Agent Run invariant. */
export type AgentRunIntegrityFinding = {
  /** Violated invariant. */
  code: AgentRunIntegrityFailureCode
  /** Location of the broken row. */
  sample: AgentRunIntegritySample
}

/** Row counts of the partitions that were read completely. */
export type AgentRunIntegrityCounts = {
  /** Team partitions read to the end. */
  partitions: number
  /** Rows read from those partitions. */
  rows: number
  /** Run rows. */
  runs: number
  /** Active run rows. */
  activeRuns: number
  /** Finished run rows. */
  finishedRuns: number
  /** Finished runs closed before the finished-run index keys were introduced. */
  legacyFinishedRunsWithoutIndexKeys: number
  /** Claim rows. */
  claims: number
  /** Newest-run rows. */
  latestRuns: number
  /** Revocation rows. */
  revocations: number
  /** Report rows; counted, not checked. */
  reports: number
  /** Stall sweep watermark rows. */
  watermarks: number
  /** Settings and settings receipt rows; counted, not checked. */
  settings: number
}

/** Result of checking one fully read Team partition. */
export type AgentRunPartitionCheck = {
  /** Row counts of the partition. */
  counts: Omit<AgentRunIntegrityCounts, 'partitions'>
  /** Violations in the partition. */
  findings: AgentRunIntegrityFinding[]
}

/** Read ceilings of one check. Reaching one with data left makes the result incomplete. */
export type AgentRunIntegrityBounds = {
  /** Items requested per DynamoDB page, from 1 to 1,000. */
  pageSize: number
  /** Pages read across discovery and every partition, from 1 to 100,000. */
  maxPages: number
  /** Items read across discovery and every partition, from 1 to 1,000,000 and at most `pageSize * maxPages`. */
  maxItems: number
}

/** Why a check stopped before reading every row. */
export type AgentRunIntegrityIncompleteReason = 'page-limit' | 'item-limit' | 'cursor-repeated'

/** Aggregated violations of one failure code. */
export type AgentRunIntegrityFailure = {
  /** Violated invariant. */
  code: AgentRunIntegrityFailureCode
  /** Number of violations. */
  count: number
  /** Up to {@link AGENT_RUN_INTEGRITY_MAX_SAMPLES} locations, sorted. */
  samples: AgentRunIntegritySample[]
}

/** Evidence one check publishes. It holds no member ID and no instance hash. */
export type AgentRunIntegrityEvidence = {
  /** Evidence shape version. */
  schemaVersion: typeof AGENT_RUN_INTEGRITY_SCHEMA_VERSION
  /** Name of the check. */
  check: 'agent-runs-integrity'
  /** Caller-supplied ID that joins this evidence with logs and alarms. */
  correlationId: string
  /** Time the check started. */
  checkedAt: string
  /** `fail` when any invariant is broken, otherwise `incomplete` when a bound stopped the read, otherwise `pass`. */
  status: 'pass' | 'fail' | 'incomplete'
  /** Why the read stopped early; absent when every partition was read. */
  incompleteReason?: AgentRunIntegrityIncompleteReason
  /** Read ceilings of the check. */
  bounds: AgentRunIntegrityBounds
  /** Pages and items read, including discovery and any partition cut short. */
  reads: {
    /** DynamoDB pages read. */
    pages: number
    /** Items read. */
    items: number
  }
  /** Row counts of the partitions read to the end. */
  counts: AgentRunIntegrityCounts
  /** Violations by code, in code order. */
  failures: AgentRunIntegrityFailure[]
}

/** DynamoDB boundary of the check: strongly consistent Query and Scan pages only. */
export type AgentRunIntegrityClient = {
  /**
   * Sends one read.
   * @param command - Query of one Team partition or Scan that discovers partitions.
   * @returns One page.
   */
  send(command: QueryCommand | ScanCommand): Promise<{
    /** Page items. */
    Items?: Record<string, unknown>[]
    /** Key of the last evaluated item when more items remain. */
    LastEvaluatedKey?: Record<string, unknown>
  }>
}

/** Input of {@link runAgentRunsIntegrityCheck}. */
export type AgentRunsIntegrityCheckInput = {
  /** DynamoDB client. */
  client: AgentRunIntegrityClient
  /** Agent Run table name. */
  tableName: string
  /** Team partitions to check; when absent, partitions are discovered with a Scan. */
  teams?: readonly AgentRunIntegrityTeam[]
  /** Read ceilings. */
  bounds: AgentRunIntegrityBounds
  /** ID that joins the evidence with logs and alarms. */
  correlationId: string
  /** Check start time. */
  now: Date
}

/** Row of a partition in its parsed form. */
type ParsedClaim = {
  /** Claimed Work Item ID. */
  workItemId: string
  /** Run the claim names. */
  runId: string
  /** Instance hash the claim names. */
  instanceIdHash: string
  /** Member the claim names. */
  assigneeUserId: string
}

/** Revocation row in its parsed form. */
type ParsedRevocation = ParsedClaim

/** Newest-run row in its parsed form. */
type ParsedLatest = {
  /** Work Item ID. */
  workItemId: string
  /** Run the row names. */
  runId: string
}

/** Stall sweep position in its parsed form. */
type ParsedWatermarkPosition = {
  /** Lease expiry the position recorded. */
  leaseExpiresAt: string
  /** Run the position recorded. */
  runId: string
}

/** Every per-partition count, summed into the check's totals. */
const partitionCountNames = [
  'rows',
  'runs',
  'activeRuns',
  'finishedRuns',
  'legacyFinishedRunsWithoutIndexKeys',
  'claims',
  'latestRuns',
  'revocations',
  'reports',
  'watermarks',
  'settings',
] as const satisfies readonly (keyof AgentRunPartitionCheck['counts'])[]

/** Partition separator between the Workspace ID and the Team ID. */
const teamPartitionSeparator = '#team#'

/**
 * Checks that a value is a non-empty string.
 *
 * @param value - Untrusted value.
 * @returns True for a non-empty string.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Checks that a value is a parseable timestamp.
 *
 * @param value - Untrusted value.
 * @returns True for a string that `Date.parse` accepts.
 */
function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value))
}

/**
 * Classifies a row by its sort key.
 *
 * @param recordKey - Sort key of the row.
 * @returns Kind of row.
 */
function classifyRecordKey(recordKey: unknown): AgentRunIntegrityRecordKind {
  if (typeof recordKey !== 'string') return 'unknown'
  if (recordKey.startsWith('agent-run#')) return 'run'
  if (recordKey.startsWith('agent-run-claim#')) return 'claim'
  if (recordKey.startsWith('agent-run-latest#')) return 'latest'
  if (recordKey.startsWith('agent-run-revoked#')) return 'revocation'
  if (recordKey.startsWith('agent-run-report#')) return 'report'
  if (recordKey === stallWatermarkRecordKey) return 'watermark'
  if (recordKey === 'agent-settings') return 'settings'
  if (recordKey.startsWith('agent-settings-mutation#')) return 'settings-mutation'
  return 'unknown'
}

/**
 * Parses a run row, or returns undefined when it is malformed.
 *
 * @param item - Stored row.
 * @param team - Partition the row was read from.
 * @returns The run or undefined.
 */
function tryParseRun(item: Record<string, unknown>, team: AgentRunIntegrityTeam): StoredAgentRun | undefined {
  try {
    return parseRun(item, team)
  } catch {
    return undefined
  }
}

/**
 * Parses a claim row, or returns undefined when it is malformed.
 *
 * @param item - Stored row.
 * @param team - Partition the row was read from.
 * @returns The claim or undefined.
 */
function parseClaimRow(item: Record<string, unknown>, team: AgentRunIntegrityTeam): ParsedClaim | undefined {
  const { workItemId, runId, instanceIdHash, assigneeUserId } = item
  if (
    item.entityType !== 'agent-run-claim' ||
    item.workspaceId !== team.directoryId ||
    !isNonEmptyString(workItemId) ||
    item.recordKey !== claimRecordKey(workItemId) ||
    !isAgentRunId(runId) ||
    !isNonEmptyString(instanceIdHash) ||
    !isNonEmptyString(assigneeUserId)
  ) {
    return undefined
  }
  return { workItemId, runId, instanceIdHash, assigneeUserId }
}

/**
 * Parses a newest-run row, or returns undefined when it is malformed.
 *
 * @param item - Stored row.
 * @param team - Partition the row was read from.
 * @returns The row or undefined.
 */
function parseLatestRow(item: Record<string, unknown>, team: AgentRunIntegrityTeam): ParsedLatest | undefined {
  const { workItemId, runId } = item
  if (
    item.entityType !== 'agent-run-latest' ||
    item.workspaceId !== team.directoryId ||
    !isNonEmptyString(workItemId) ||
    item.recordKey !== latestRunRecordKey(workItemId) ||
    !isAgentRunId(runId)
  ) {
    return undefined
  }
  return { workItemId, runId }
}

/**
 * Parses a revocation row, or returns undefined when it is malformed.
 *
 * @param item - Stored row.
 * @param team - Partition the row was read from.
 * @returns The revocation or undefined.
 */
function parseRevocationRow(item: Record<string, unknown>, team: AgentRunIntegrityTeam): ParsedRevocation | undefined {
  const { workItemId, runId, instanceIdHash, assigneeUserId } = item
  if (
    item.entityType !== 'agent-run-revocation' ||
    item.workspaceId !== team.directoryId ||
    !isNonEmptyString(workItemId) ||
    !isAgentRunId(runId) ||
    !isNonEmptyString(instanceIdHash) ||
    !isNonEmptyString(assigneeUserId) ||
    !isTimestamp(item.revokedAt) ||
    item.recordKey !== revocationRecordKey({ workItemId, assigneeUserId, instanceIdHash })
  ) {
    return undefined
  }
  return { workItemId, runId, instanceIdHash, assigneeUserId }
}

/**
 * Parses a stall sweep position written as `<leaseExpiresAt>#<runId>`.
 *
 * @param value - Stored position.
 * @returns The position, or undefined when it is malformed.
 */
function parseWatermarkPosition(value: unknown): ParsedWatermarkPosition | undefined {
  if (typeof value !== 'string') return undefined
  const separator = value.lastIndexOf('#')
  if (separator < 0) return undefined
  const leaseExpiresAt = value.slice(0, separator)
  const runId = value.slice(separator + 1)
  if (!isTimestamp(leaseExpiresAt) || !isAgentRunId(runId)) return undefined
  return { leaseExpiresAt, runId }
}

/**
 * Checks that the index keys stored on a run row match the run.
 *
 * @param item - Stored row.
 * @param run - Parsed run.
 * @param partition - Team partition key.
 * @returns `ok`, `mismatch`, or `legacy` for a finished run closed before the finished-run index keys existed.
 */
function checkRunIndexKeys(item: Record<string, unknown>, run: StoredAgentRun, partition: string): 'ok' | 'mismatch' | 'legacy' {
  if (item.workItemRunKey !== `${partition}#${run.workItemId}` || item.workItemRunSortKey !== workItemRunSortKey(run)) {
    return 'mismatch'
  }
  if (run.state === 'active') {
    const activeKeysMatch = item.activeRunPartition === partition && item.activeRunSortKey === `${run.leaseExpiresAt}#${run.runId}`
    const hasFinishedKeys = item.finishedRunPartition !== undefined || item.finishedRunSortKey !== undefined
    return activeKeysMatch && !hasFinishedKeys ? 'ok' : 'mismatch'
  }
  if (item.activeRunPartition !== undefined || item.activeRunSortKey !== undefined) return 'mismatch'
  if (run.outcome === undefined || run.finishedAt === undefined) return 'mismatch'
  if (item.finishedRunPartition === undefined && item.finishedRunSortKey === undefined) return 'legacy'
  const expected = finishedRunIndexKeys({ ...run, outcome: run.outcome, finishedAt: run.finishedAt })
  return item.finishedRunPartition === expected.finishedRunPartition && item.finishedRunSortKey === expected.finishedRunSortKey
    ? 'ok'
    : 'mismatch'
}

/**
 * Checks the Triage outbox key on a run row. Only a run that finished as `failed` may wait in the
 * outbox, and its sort key ends with the run's partition and ID after a timestamp.
 *
 * @param item - Stored row.
 * @param run - Parsed run.
 * @param partition - Team partition key.
 * @returns True when the row has no outbox key or a valid one.
 */
function isOutboxKeyValid(item: Record<string, unknown>, run: StoredAgentRun, partition: string): boolean {
  const { triageIndexPartition, triageIndexSortKey } = item
  if (triageIndexPartition === undefined && triageIndexSortKey === undefined) return true
  if (triageIndexPartition !== triageFailedRunPartition || typeof triageIndexSortKey !== 'string') return false
  if (run.state !== 'finished' || run.outcome !== 'failed') return false
  const suffix = `#${partition}#${run.runId}`
  return triageIndexSortKey.endsWith(suffix) && isTimestamp(triageIndexSortKey.slice(0, -suffix.length))
}

/**
 * Checks every Agent Run invariant of one Team partition that was read completely and strongly.
 * The check reads nothing and never repairs.
 *
 * @param team - Team partition.
 * @param rows - Every row of the partition.
 * @returns Counts and violations.
 */
export function checkAgentRunPartition(team: AgentRunIntegrityTeam, rows: readonly Record<string, unknown>[]): AgentRunPartitionCheck {
  const partition = createAgentRunPartition(team.directoryId, team.teamId)
  const at = (sample: Omit<AgentRunIntegritySample, 'directoryId' | 'teamId'>): AgentRunIntegritySample => ({
    directoryId: team.directoryId,
    teamId: team.teamId,
    ...sample,
  })
  const findings: AgentRunIntegrityFinding[] = []
  const counts: AgentRunPartitionCheck['counts'] = {
    rows: rows.length,
    runs: 0,
    activeRuns: 0,
    finishedRuns: 0,
    legacyFinishedRunsWithoutIndexKeys: 0,
    claims: 0,
    latestRuns: 0,
    revocations: 0,
    reports: 0,
    watermarks: 0,
    settings: 0,
  }
  const runs = new Map<string, StoredAgentRun>()
  const claims = new Map<string, ParsedClaim>()
  const latestRuns: ParsedLatest[] = []
  const revocations: ParsedRevocation[] = []
  const watermarkRows: Record<string, unknown>[] = []

  for (const item of rows) {
    const kind = classifyRecordKey(item.recordKey)
    if (item.directoryTeamId !== partition) {
      findings.push({ code: 'AGENT_RUN_ROW_MALFORMED', sample: at({ recordKind: kind }) })
      continue
    }
    switch (kind) {
      case 'run': {
        counts.runs += 1
        const run = tryParseRun(item, team)
        if (run === undefined || item.recordKey !== runRecordKey(run.runId)) {
          findings.push({ code: 'AGENT_RUN_ROW_MALFORMED', sample: at({ recordKind: kind }) })
          break
        }
        runs.set(run.runId, run)
        if (run.state === 'active') counts.activeRuns += 1
        else counts.finishedRuns += 1
        const indexKeys = checkRunIndexKeys(item, run, partition)
        if (indexKeys === 'legacy') counts.legacyFinishedRunsWithoutIndexKeys += 1
        if (indexKeys === 'mismatch') {
          findings.push({ code: 'AGENT_RUN_INDEX_KEYS_MISMATCH', sample: at({ workItemId: run.workItemId, runId: run.runId }) })
        }
        if (!isOutboxKeyValid(item, run, partition)) {
          findings.push({ code: 'AGENT_RUN_OUTBOX_KEY_INVALID', sample: at({ workItemId: run.workItemId, runId: run.runId }) })
        }
        break
      }
      case 'claim': {
        counts.claims += 1
        const claim = parseClaimRow(item, team)
        if (claim === undefined) findings.push({ code: 'AGENT_RUN_ROW_MALFORMED', sample: at({ recordKind: kind }) })
        else claims.set(claim.workItemId, claim)
        break
      }
      case 'latest': {
        counts.latestRuns += 1
        const latest = parseLatestRow(item, team)
        if (latest === undefined) findings.push({ code: 'AGENT_RUN_ROW_MALFORMED', sample: at({ recordKind: kind }) })
        else latestRuns.push(latest)
        break
      }
      case 'revocation': {
        counts.revocations += 1
        const revocation = parseRevocationRow(item, team)
        if (revocation === undefined) findings.push({ code: 'AGENT_RUN_ROW_MALFORMED', sample: at({ recordKind: kind }) })
        else revocations.push(revocation)
        break
      }
      case 'report':
        counts.reports += 1
        break
      case 'watermark':
        counts.watermarks += 1
        watermarkRows.push(item)
        break
      case 'settings':
      case 'settings-mutation':
        counts.settings += 1
        break
      case 'unknown':
        findings.push({ code: 'AGENT_RUN_ROW_UNRECOGNIZED', sample: at({ recordKind: kind }) })
        break
    }
  }

  const activeByWorkItem = new Map<string, StoredAgentRun[]>()
  for (const run of runs.values()) {
    if (run.state !== 'active') continue
    activeByWorkItem.set(run.workItemId, [...(activeByWorkItem.get(run.workItemId) ?? []), run])
  }
  for (const [workItemId, active] of activeByWorkItem) {
    if (active.length > 1) {
      findings.push({ code: 'AGENT_RUN_MULTIPLE_ACTIVE_RUNS', sample: at({ workItemId }) })
    }
    for (const run of active) {
      if (claims.get(workItemId)?.runId !== run.runId) {
        findings.push({ code: 'AGENT_RUN_ACTIVE_RUN_UNCLAIMED', sample: at({ workItemId, runId: run.runId }) })
      }
    }
  }

  for (const claim of claims.values()) {
    const sample = at({ workItemId: claim.workItemId, runId: claim.runId })
    const run = runs.get(claim.runId)
    if (run === undefined) {
      findings.push({ code: 'AGENT_RUN_CLAIM_RUN_MISSING', sample })
    } else if (run.state !== 'active') {
      findings.push({ code: 'AGENT_RUN_CLAIM_RUN_NOT_ACTIVE', sample })
    } else if (
      run.workItemId !== claim.workItemId ||
      run.instanceIdHash !== claim.instanceIdHash ||
      run.assigneeUserId !== claim.assigneeUserId
    ) {
      findings.push({ code: 'AGENT_RUN_CLAIM_HOLDER_MISMATCH', sample })
    }
  }

  for (const revocation of revocations) {
    const sample = at({ workItemId: revocation.workItemId, runId: revocation.runId })
    const run = runs.get(revocation.runId)
    if (
      run === undefined ||
      run.state !== 'finished' ||
      (run.outcome !== 'released' && run.outcome !== 'superseded') ||
      run.workItemId !== revocation.workItemId ||
      run.instanceIdHash !== revocation.instanceIdHash ||
      run.assigneeUserId !== revocation.assigneeUserId
    ) {
      findings.push({ code: 'AGENT_RUN_REVOCATION_ORPHANED', sample })
    }
    // Starting a run deletes the same member and instance's revocation in the same transaction.
    const blocked = (activeByWorkItem.get(revocation.workItemId) ?? []).some((active) =>
      active.instanceIdHash === revocation.instanceIdHash && active.assigneeUserId === revocation.assigneeUserId)
    if (blocked) findings.push({ code: 'AGENT_RUN_REVOCATION_BLOCKS_ACTIVE_RUN', sample })
  }

  for (const latest of latestRuns) {
    const run = runs.get(latest.runId)
    const active = activeByWorkItem.get(latest.workItemId) ?? []
    // Every start, take over, and resume names its new run as the newest in the same transaction.
    if (run === undefined || run.workItemId !== latest.workItemId || active.some((candidate) => candidate.runId !== latest.runId)) {
      findings.push({ code: 'AGENT_RUN_LATEST_RUN_INVALID', sample: at({ workItemId: latest.workItemId, runId: latest.runId }) })
    }
  }

  for (const item of watermarkRows) {
    if (!isWatermarkRowValid(item, team, runs)) {
      findings.push({ code: 'AGENT_RUN_WATERMARK_INVALID', sample: at({ recordKind: 'watermark' }) })
    }
  }

  return { counts, findings }
}

/**
 * Checks the stall sweep row of a Team. Each position names a run of the partition and a lease
 * expiry that run had; a lease only moves later, so the run's lease is never earlier.
 *
 * @param item - Stored watermark row.
 * @param team - Team partition.
 * @param runs - Parsed runs of the partition by ID.
 * @returns True when the row is valid.
 */
function isWatermarkRowValid(item: Record<string, unknown>, team: AgentRunIntegrityTeam, runs: ReadonlyMap<string, StoredAgentRun>): boolean {
  if (item.workspaceId !== team.directoryId || item.teamId !== team.teamId) return false
  for (const name of ['watermark', 'resume'] as const) {
    if (item[name] === undefined) continue
    const position = parseWatermarkPosition(item[name])
    if (position === undefined) return false
    const run = runs.get(position.runId)
    if (run === undefined || Date.parse(run.leaseExpiresAt) < Date.parse(position.leaseExpiresAt)) return false
  }
  return true
}

/**
 * Resolves a Team partition key into its Workspace and Team.
 *
 * @param partition - Partition key read from the table.
 * @returns The Team, or undefined when the key does not have exactly one separator.
 */
export function parseAgentRunPartition(partition: string): AgentRunIntegrityTeam | undefined {
  const parts = partition.split(teamPartitionSeparator)
  const [directoryId, teamId] = parts
  if (parts.length !== 2 || !directoryId || !teamId) return undefined
  return { directoryId, teamId }
}

/**
 * Validates the read ceilings before the first read.
 *
 * @param bounds - Ceilings to validate.
 */
export function assertAgentRunIntegrityBounds(bounds: AgentRunIntegrityBounds): void {
  const { pageSize, maxPages, maxItems } = bounds
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) throw new RangeError('pageSize must be an integer from 1 to 1000.')
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100_000) throw new RangeError('maxPages must be an integer from 1 to 100000.')
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 1_000_000) throw new RangeError('maxItems must be an integer from 1 to 1000000.')
  if (maxItems > pageSize * maxPages) throw new RangeError('maxItems must not exceed pageSize * maxPages.')
}

/** Shared read budget of one check. */
class ReadBudget {
  /** Pages read. */
  pages = 0
  /** Items read. */
  items = 0
  /** Why reading stopped early. */
  stopped: AgentRunIntegrityIncompleteReason | undefined
  /** Validated ceilings. */
  readonly bounds: AgentRunIntegrityBounds

  /**
   * Creates a budget.
   * @param bounds - Validated ceilings.
   */
  constructor(bounds: AgentRunIntegrityBounds) {
    this.bounds = bounds
  }

  /**
   * Reads every page of one strongly consistent read, or stops at a ceiling.
   *
   * @param read - Sends one page request from a continuation key.
   * @returns Every item, or undefined when the budget stopped the read.
   */
  async readAll(read: (startKey: Record<string, unknown> | undefined, limit: number) => Promise<{
    /** Page items. */
    Items?: Record<string, unknown>[]
    /** Continuation key. */
    LastEvaluatedKey?: Record<string, unknown>
  }>): Promise<Record<string, unknown>[] | undefined> {
    const items: Record<string, unknown>[] = []
    const seenKeys = new Set<string>()
    let startKey: Record<string, unknown> | undefined
    do {
      if (this.pages >= this.bounds.maxPages) {
        this.stopped = 'page-limit'
        return undefined
      }
      const page = await read(startKey, this.bounds.pageSize)
      this.pages += 1
      const pageItems = page.Items ?? []
      this.items += pageItems.length
      if (this.items > this.bounds.maxItems) {
        this.stopped = 'item-limit'
        return undefined
      }
      items.push(...pageItems)
      startKey = page.LastEvaluatedKey
      if (startKey !== undefined) {
        const serialized = JSON.stringify(startKey)
        if (seenKeys.has(serialized)) {
          this.stopped = 'cursor-repeated'
          return undefined
        }
        seenKeys.add(serialized)
      }
    } while (startKey !== undefined)
    return items
  }
}

/**
 * Lists the Team partitions of the table with a strongly consistent, bounded Scan of the key only.
 *
 * @param input - Client, table, and budget.
 * @param input.client - DynamoDB client.
 * @param input.tableName - Table name.
 * @param input.budget - Shared read budget.
 * @param input.findings - Receives one finding for each partition key that cannot be resolved.
 * @returns Sorted Teams, or undefined when the budget stopped the Scan.
 */
async function discoverTeams(input: {
  /** DynamoDB client. */
  client: AgentRunIntegrityClient
  /** Table name. */
  tableName: string
  /** Shared read budget. */
  budget: ReadBudget
  /** Receives unresolved partitions. */
  findings: AgentRunIntegrityFinding[]
}): Promise<AgentRunIntegrityTeam[] | undefined> {
  const items = await input.budget.readAll((startKey, limit) => input.client.send(new ScanCommand({
    TableName: input.tableName,
    ConsistentRead: true,
    ProjectionExpression: '#directoryTeamId',
    ExpressionAttributeNames: { '#directoryTeamId': 'directoryTeamId' },
    Limit: limit,
    ExclusiveStartKey: startKey,
  })))
  if (items === undefined) return undefined
  const partitions = new Set<string>()
  const unresolved = new Set<unknown>()
  for (const item of items) {
    const partition = item.directoryTeamId
    if (partition === triageSweepResumeKey.directoryTeamId) continue
    if (typeof partition !== 'string' || parseAgentRunPartition(partition) === undefined) unresolved.add(partition)
    else partitions.add(partition)
  }
  // One finding per partition key, not per row; the key itself is not reported.
  for (const _partition of unresolved) input.findings.push({ code: 'AGENT_RUN_PARTITION_UNRESOLVED', sample: {} })
  return [...partitions].sort().flatMap((partition) => parseAgentRunPartition(partition) ?? [])
}

/**
 * Orders samples so the evidence of the same data is the same.
 *
 * @param left - First sample.
 * @param right - Second sample.
 * @returns Sort order.
 */
function compareSamples(left: AgentRunIntegritySample, right: AgentRunIntegritySample): number {
  const key = (sample: AgentRunIntegritySample) =>
    [sample.directoryId ?? '', sample.teamId ?? '', sample.workItemId ?? '', sample.runId ?? '', sample.recordKind ?? ''].join('\u0000')
  const a = key(left)
  const b = key(right)
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Aggregates findings by code with a bounded, sorted sample list.
 *
 * @param findings - Every finding.
 * @returns Failures in code order.
 */
export function summarizeAgentRunIntegrityFindings(findings: readonly AgentRunIntegrityFinding[]): AgentRunIntegrityFailure[] {
  return AGENT_RUN_INTEGRITY_FAILURE_CODES.flatMap((code) => {
    const matching = findings.filter((finding) => finding.code === code)
    if (matching.length === 0) return []
    const samples = matching.map((finding) => finding.sample).sort(compareSamples).slice(0, AGENT_RUN_INTEGRITY_MAX_SAMPLES)
    return [{ code, count: matching.length, samples }]
  })
}

/**
 * Checks the Agent Run invariants of every requested or discovered Team partition. Each partition
 * is read with a strongly consistent Query; reaching a ceiling stops the check, and a partition cut
 * short is not judged. The check never writes.
 *
 * @param input - Client, table, Teams, ceilings, correlation ID, and start time.
 * @returns Evidence without member IDs or instance hashes.
 */
export async function runAgentRunsIntegrityCheck(input: AgentRunsIntegrityCheckInput): Promise<AgentRunIntegrityEvidence> {
  assertAgentRunIntegrityBounds(input.bounds)
  if (!isNonEmptyString(input.correlationId)) throw new TypeError('correlationId is required.')
  const budget = new ReadBudget(input.bounds)
  const findings: AgentRunIntegrityFinding[] = []
  const counts: AgentRunIntegrityCounts = {
    partitions: 0,
    rows: 0,
    runs: 0,
    activeRuns: 0,
    finishedRuns: 0,
    legacyFinishedRunsWithoutIndexKeys: 0,
    claims: 0,
    latestRuns: 0,
    revocations: 0,
    reports: 0,
    watermarks: 0,
    settings: 0,
  }
  const teams = input.teams === undefined
    ? await discoverTeams({ client: input.client, tableName: input.tableName, budget, findings })
    : [...input.teams]
  for (const team of teams ?? []) {
    const partition = createAgentRunPartition(team.directoryId, team.teamId)
    const rows = await budget.readAll((startKey, limit) => input.client.send(new QueryCommand({
      TableName: input.tableName,
      KeyConditionExpression: '#directoryTeamId = :partition',
      ExpressionAttributeNames: { '#directoryTeamId': 'directoryTeamId' },
      ExpressionAttributeValues: { ':partition': partition },
      ConsistentRead: true,
      Limit: limit,
      ExclusiveStartKey: startKey,
    })))
    if (rows === undefined) break
    const result = checkAgentRunPartition(team, rows)
    counts.partitions += 1
    for (const name of partitionCountNames) counts[name] += result.counts[name]
    findings.push(...result.findings)
  }
  const failures = summarizeAgentRunIntegrityFindings(findings)
  const status = failures.length > 0 ? 'fail' : budget.stopped !== undefined ? 'incomplete' : 'pass'
  return {
    schemaVersion: AGENT_RUN_INTEGRITY_SCHEMA_VERSION,
    check: 'agent-runs-integrity',
    correlationId: input.correlationId,
    checkedAt: input.now.toISOString(),
    status,
    ...(budget.stopped === undefined ? {} : { incompleteReason: budget.stopped }),
    bounds: { ...input.bounds },
    reads: { pages: budget.pages, items: budget.items },
    counts,
    failures,
  }
}
