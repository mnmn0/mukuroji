import { createHash } from 'node:crypto'
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  AGENT_RUN_REPORT_KINDS,
  AGENT_RUN_RUNTIMES,
  AGENT_RUN_SCHEMA_VERSION,
  AGENT_SETTINGS_SCHEMA_VERSION,
  AGENT_RUN_HEARTBEAT_INTERVAL_SECONDS,
  type AgentRunOutcome,
  type AgentSettings,
} from '@mukuroji/contracts'
import {
  calculateLeaseExpiry,
  createDefaultAgentSettings,
  createSavedAgentSettings,
  type StoredAgentRun,
  type AgentRunRevocation,
  type StoredAgentRunClaim,
  type ValidatedAgentSettingsUpdate,
} from '../../domain/agent-run'
import { readAgentRunReportDetails, type AgentRunReportDetails, type StoredAgentRunReport } from '../../domain/agent-run-report'
import {
  AgentRunError,
  createAgentRunCommitConflictError,
  createAgentRunIntegrityError,
  createAgentRunNotActiveError,
} from '../../domain/agent-run-error'

/** One item of a DynamoDB write transaction. */
export type AgentRunTransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number]

/** Index that lists one Work Item's runs by start time. */
export const AGENT_RUN_WORK_ITEM_INDEX_NAME = 'WorkItemRunIndex'

/** Sparse index that lists a Team's active runs by lease expiry. */
export const AGENT_RUN_ACTIVE_INDEX_NAME = 'ActiveRunIndex'

/**
 * Sparse index of the Teams that file runs to Triage and of failed runs waiting to be filed. Both
 * partitions stay small, so neither is sharded.
 */
export const AGENT_RUN_TRIAGE_INDEX_NAME = 'AgentRunTriageIndex'

/** Triage index partition of the settings rows of Teams that file failed or stalled runs. */
const triageTeamPartition = 'triage-filing-team'

/** Triage index partition of failed runs not yet filed, oldest finish first. */
const triageFailedRunPartition = 'triage-failed-run'

/** Sort key of a Team's stall sweep watermark: the last active run the sweep passed. */
const stallWatermarkRecordKey = 'agent-run-triage-stall-watermark'

/** Partition and sort key of the Team where the last bounded stall sweep stopped. */
const triageSweepResumeKey = { directoryTeamId: 'agent-run-triage-sweep', recordKey: 'resume-team' }

/** Largest page a list query returns. */
const maximumPageSize = 100

/** Strong reads in flight at once when a history page re-reads its runs from the base table. */
const historyRereadConcurrency = 10

/** Minimal DynamoDB command boundary used by the Agent Run store. */
export type AgentRunDocumentClient = {
  /** Sends one read, query, update, or transaction. */
  send(command: GetCommand | QueryCommand | UpdateCommand | TransactWriteCommand): Promise<{
    /** Strongly read item. */
    Item?: Record<string, unknown>
    /** Query page. */
    Items?: Record<string, unknown>[]
    /** Key of the last evaluated item when more items remain. */
    LastEvaluatedKey?: Record<string, unknown>
  }>
}

/** One page of runs and the opaque continuation for the next page. */
export type AgentRunPage = {
  /** Runs in index order. */
  runs: StoredAgentRun[]
  /** Continuation for the next page; absent on the last page. */
  nextCursor?: string
}

/** A Team whose Agent settings file failed or stalled runs to Triage. */
export type AgentRunTriageTeam = {
  /** Workspace ID. */
  directoryId: string
  /** Team ID. */
  teamId: string
}

/** A failed run waiting in the Triage outbox. */
export type AgentRunTriageOutboxEntry = {
  /** Workspace ID. */
  directoryId: string
  /** Team ID. */
  teamId: string
  /** Run ID. */
  runId: string
}

/** Where the stall sweep of a Team continues. */
export type AgentRunStallPosition = {
  /** Last run every later sweep may skip: passed, and long enough past its lease for the index to have settled. */
  watermark?: string
  /** Last run a pass that stopped at its read bound passed; the next sweep continues after it. */
  resume?: string
}

/** One page of Teams that file runs to Triage. */
export type AgentRunTriageTeamPage = {
  /** Teams in index order. */
  teams: AgentRunTriageTeam[]
  /** Continuation for the next page; absent on the last page. */
  nextCursor?: string
}

/** Persistence port of the worker that files failed and stalled runs to Triage. */
export interface AgentRunTriageStore {
  /**
   * Lists the Teams whose settings file failed or stalled runs. The index is eventually
   * consistent, so the worker reads each Team's settings again before acting.
   * @param cursor - Continuation from a previous page.
   * @param limit - Page size from 1 to 100.
   * @param from - Team the first page starts at, inclusive; ignored with a cursor.
   * @returns One page of Teams.
   */
  listTriageTeams(cursor: string | undefined, limit: number, from?: AgentRunTriageTeam): Promise<AgentRunTriageTeamPage>
  /**
   * Reads the Team where the previous stall sweep stopped at its bound.
   * @returns The Team to resume from, or undefined to start from the first Team.
   */
  readTriageSweepResumeTeam(): Promise<AgentRunTriageTeam | undefined>
  /**
   * Saves the Team the next stall sweep resumes from, or clears it after a sweep reached the last Team.
   * @param team - Team to resume from, or undefined.
   */
  saveTriageSweepResumeTeam(team: AgentRunTriageTeam | undefined): Promise<void>
  /**
   * Reads where the stall sweep continues in a Team.
   * @param team - Team.
   * @returns Opaque watermark and resume positions; both are absent before the first pass.
   */
  readStallPosition(team: AgentRunTriageTeam): Promise<AgentRunStallPosition>
  /**
   * Lists a Team's active runs after a watermark, soonest lease expiry first. A lease only moves
   * later, so a run before the watermark was already passed.
   * @param team - Team.
   * @param after - Position from {@link AgentRunTriageStore.readStallPosition}.
   * @param cursor - Continuation from a previous page.
   * @param limit - Page size from 1 to 100.
   * @returns One page of runs.
   */
  listStallCandidates(team: AgentRunTriageTeam, after: string | undefined, cursor: string | undefined, limit: number): Promise<AgentRunPage>
  /**
   * Moves a Team's watermark past a run as it was listed; the watermark never moves back.
   * @param run - Last run the sweep passed, as listed.
   */
  saveStallWatermark(run: StoredAgentRun): Promise<void>
  /**
   * Saves the run a pass stopped after at its read bound, or clears it once a pass read to the end.
   * @param team - Team.
   * @param run - Last run the pass passed, as listed, or undefined to clear.
   */
  saveStallResume(team: AgentRunTriageTeam, run: StoredAgentRun | undefined): Promise<void>
  /**
   * Lists failed runs not yet filed, oldest finish first.
   * @param limit - Largest number of entries, from 1 to 100.
   * @returns Outbox entries; the worker reads each run again before acting.
   */
  listFailedRunsToTriage(limit: number): Promise<AgentRunTriageOutboxEntry[]>
  /**
   * Removes a run from the Triage outbox after it was filed or deliberately skipped.
   * @param entry - Outbox entry.
   */
  clearFailedRunTriage(entry: AgentRunTriageOutboxEntry): Promise<void>
  /**
   * Moves a run whose filing failed to the back of the Triage outbox, so it is retried after the
   * runs behind it instead of holding them back.
   * @param entry - Outbox entry.
   * @param now - Failure time; later than the finish of every run already in the outbox.
   */
  deferFailedRunTriage(entry: AgentRunTriageOutboxEntry, now: Date): Promise<void>
  /**
   * Records that a stalled run was filed, while it is still active with the lease that was read.
   * @param run - Stalled run as read.
   * @param now - Filing time.
   * @returns False when the run changed since it was read, such as a heartbeat or a finish.
   */
  markStallTriaged(run: StoredAgentRun, now: Date): Promise<boolean>
}

/** Persistence port for Agent Runs, claims, and Team Agent settings. */
export interface AgentRunStore {
  /**
   * Strongly reads one run.
   * @param directoryId - Workspace ID.
   * @param teamId - Team ID.
   * @param runId - Run ID.
   * @returns The run, or undefined when it does not exist.
   */
  getRun(directoryId: string, teamId: string, runId: string): Promise<StoredAgentRun | undefined>
  /**
   * Strongly reads the claim of one Work Item.
   * @param directoryId - Workspace ID.
   * @param teamId - Team ID.
   * @param workItemId - Work Item ID.
   * @returns The claim, or undefined when no run holds the Work Item.
   */
  getClaim(directoryId: string, teamId: string, workItemId: string): Promise<StoredAgentRunClaim | undefined>
  /**
   * Strongly reads whether a person released, or another instance took over, a run of this member
   * and instance on the Work Item since the instance last started one there.
   * @param directoryId - Workspace ID.
   * @param teamId - Team ID.
   * @param revocation - Work Item, member, and instance hash.
   * @returns True when the instance must start a new run before acting on the Work Item.
   */
  isInstanceRevoked(directoryId: string, teamId: string, revocation: AgentRunRevocation): Promise<boolean>
  /**
   * Strongly reads Team Agent settings.
   * @param directoryId - Workspace ID.
   * @param teamId - Team ID.
   * @returns Saved settings or the defaults at revision 0.
   */
  getSettings(directoryId: string, teamId: string): Promise<AgentSettings>
  /**
   * Replaces Team Agent settings with revision CAS.
   * @param directoryId - Workspace ID.
   * @param teamId - Team ID.
   * @param update - Validated update including the expected revision.
   * @param actorMemberKey - Editor.
   * @param now - Save time.
   * @param mutationKey - Opaque key of this save. Every committed key keeps a receipt: a retry with the
   * same key and values returns the settings that save committed, and any other reuse is a conflict.
   * @param extraItems - Audit writes committed with the settings.
   * @returns The saved settings.
   */
  saveSettings(
    directoryId: string,
    teamId: string,
    update: ValidatedAgentSettingsUpdate,
    actorMemberKey: string,
    now: Date,
    mutationKey: string,
    extraItems: readonly AgentRunTransactItem[],
  ): Promise<AgentSettings>
  /**
   * Lists one Work Item's runs, newest first.
   * @param directoryId - Workspace ID.
   * @param teamId - Team ID.
   * @param workItemId - Work Item ID.
   * @param cursor - Continuation from a previous page of the same query.
   * @param limit - Page size from 1 to 100.
   * @returns One page of runs.
   */
  listWorkItemRuns(directoryId: string, teamId: string, workItemId: string, cursor: string | undefined, limit: number): Promise<AgentRunPage>
  /**
   * Lists a Team's active runs, soonest lease expiry first.
   * @param directoryId - Workspace ID.
   * @param teamId - Team ID.
   * @param cursor - Continuation from a previous page of the same query.
   * @param limit - Page size from 1 to 100.
   * @returns One page of active runs.
   */
  listActiveRuns(directoryId: string, teamId: string, cursor: string | undefined, limit: number): Promise<AgentRunPage>
  /**
   * Lists a Team's finished runs in storage order.
   * @param directoryId - Workspace ID.
   * @param teamId - Team ID.
   * @param cursor - Continuation from a previous page of the same query.
   * @param limit - Evaluated items per page from 1 to 100; a page can be empty and still continue.
   * @returns One page of finished runs.
   */
  listFinishedRuns(directoryId: string, teamId: string, cursor: string | undefined, limit: number): Promise<AgentRunPage>
  /**
   * Builds the writes that create a run, claim its Work Item, and clear an earlier revocation of the
   * same member and instance on it.
   * @param run - New active run.
   * @returns Run and claim puts that fail when either already exists, then the revocation delete.
   */
  createStartItems(run: StoredAgentRun): AgentRunTransactItem[]
  /**
   * Builds the checks that fence a Work Item mutation with the caller's claim and run. The lease is
   * extended after the mutation commits, so an older mutation never overwrites a newer heartbeat.
   * @param input - Scope, current run, instance hash, and time.
   * @returns Run and claim condition checks, or, without a run, claim and revocation checks that
   * reject an instance whose run a person released or another instance took over.
   */
  createMutationFenceConditionChecks(input: AgentRunFenceInput): AgentRunTransactItem[]
  /**
   * Builds a check that no run holds a Work Item, for writes that must not race a start.
   * @param directoryId - Workspace ID.
   * @param teamId - Team ID.
   * @param workItemId - Work Item ID.
   * @returns ConditionCheck that the claim row does not exist.
   */
  createClaimAbsentCheck(directoryId: string, teamId: string, workItemId: string): AgentRunTransactItem
  /**
   * Builds a check that the Team's Agent settings are still at the revision a start read.
   * @param directoryId - Workspace ID.
   * @param teamId - Team ID.
   * @param revision - Revision the start read; `0` means the defaults were never saved.
   * @returns ConditionCheck on the settings row.
   */
  createSettingsRevisionCheck(directoryId: string, teamId: string, revision: number): AgentRunTransactItem
  /**
   * Builds the writes that finish an active run, remove its claim, and, for a release or take over,
   * revoke the run's instance on the Work Item.
   * @param run - Finished form of the run.
   * @param expectedInstanceIdHash - Instance that must still own the run, when an agent closes it.
   * @param fenceProgress - Also require the report count and last heartbeat that were read, so a
   *   response built from the read run describes the committed row; a concurrent report or
   *   heartbeat then fails the close like a run that is no longer active.
   * @returns Run update and claim delete conditioned on the run still being active, then any revocation put.
   */
  createCloseItems(run: StoredAgentRun, expectedInstanceIdHash?: string, fenceProgress?: boolean): AgentRunTransactItem[]
  /**
   * Builds the writes that hand a stalled run's Work Item to another instance: the stalled run is
   * superseded and its instance revoked, and the successor takes over the claim in place.
   * @param superseded - Superseded form of the stalled run.
   * @param successor - New active run of another instance on the same Work Item.
   * @returns Run update and claim replacement conditioned on the stalled run still holding an expired
   * lease, then the revocation put, the successor run put, and the successor's revocation delete.
   */
  createTakeOverItems(superseded: StoredAgentRun, successor: StoredAgentRun): AgentRunTransactItem[]
  /**
   * Builds the writes that save a structured report of an active run and renew its lease.
   * @param run - Active run as read; its `reportCount` is the sequence of its previous report.
   * @param report - Report numbered `run.reportCount + 1`, created at `now`.
   * @param now - Report time the lease is renewed from.
   * @returns Run update conditioned on the run still being active for the same instance and report
   * count with no newer heartbeat, the check that the run still holds its claim, and the report put.
   */
  createReportItems(run: StoredAgentRun, report: StoredAgentRunReport, now: Date): AgentRunTransactItem[]
  /**
   * Lists one Work Item's structured reports, newest first, with strongly consistent reads.
   * @param directoryId - Workspace ID.
   * @param teamId - Team ID.
   * @param workItemId - Work Item ID.
   * @param cursor - Continuation from a previous page of the same query.
   * @param limit - Page size from 1 to 100.
   * @returns One page of reports.
   */
  listWorkItemReports(directoryId: string, teamId: string, workItemId: string, cursor: string | undefined, limit: number): Promise<AgentRunReportPage>
  /**
   * Commits a standalone transaction of Agent Run writes and caller items.
   * @param items - Agent Run writes first, then audit or receipt writes.
   * @param fenceItemCount - Number of leading Agent Run writes whose failure means the run changed.
   */
  commit(items: readonly AgentRunTransactItem[], fenceItemCount: number): Promise<void>
  /**
   * Extends a lease in response to an explicit heartbeat, at most once per interval, while the run
   * still holds its Work Item's claim.
   * @param run - Active run.
   * @param instanceIdHash - Instance that must own the run.
   * @param now - Heartbeat time.
   * @param conditionChecks - Checks on other tables that must still hold, such as the Work Item's assignment.
   * @returns The run with the extended lease.
   */
  heartbeat(run: StoredAgentRun, instanceIdHash: string, now: Date, conditionChecks?: readonly AgentRunTransactItem[]): Promise<StoredAgentRun>
  /**
   * Extends a lease after a mutation that could only check the run; a finished run is left as is.
   * @param run - Run that fenced the mutation.
   * @param now - Mutation time.
   */
  extendLeaseAfterMutation(run: StoredAgentRun, now: Date): Promise<void>
}

/** One page of structured reports. */
export type AgentRunReportPage = {
  /** Reports in page order. */
  reports: StoredAgentRunReport[]
  /** Opaque continuation, present when more reports may exist. */
  nextCursor?: string
}

/** Input for building a mutation fence. */
export type AgentRunFenceInput = {
  /** Workspace ID. */
  directoryId: string
  /** Team ID. */
  teamId: string
  /** Mutated Work Item ID. */
  workItemId: string
  /** Hash of the caller's instance ID. */
  instanceIdHash: string
  /** Member the caller's credential acts for; an instance ID only counts together with its member. */
  assigneeUserId: string
  /** Active run the caller holds for the Work Item, when it sent one. */
  run?: StoredAgentRun
  /** Mutation time. */
  now: Date
}

/**
 * Builds the Team partition key shared with canonical Work Items.
 *
 * @param directoryId - Workspace ID.
 * @param teamId - Team ID.
 * @returns Partition key.
 */
export function createAgentRunPartition(directoryId: string, teamId: string): string {
  return `${directoryId}#team#${teamId}`
}

/**
 * Builds a run row key.
 *
 * @param runId - Run ID.
 * @returns Sort key.
 */
function runRecordKey(runId: string): string {
  return `agent-run#${runId}`
}

/**
 * Builds a claim row key.
 *
 * @param workItemId - Work Item ID.
 * @returns Sort key.
 */
function claimRecordKey(workItemId: string): string {
  return `agent-run-claim#${workItemId}`
}

/**
 * Builds the sort key of an instance revocation. The member and instance are hashed together so
 * neither can contain the key separator.
 *
 * @param revocation - Work Item, member, and instance hash.
 * @returns Sort key.
 */
function revocationRecordKey(revocation: AgentRunRevocation): string {
  const subject = createHash('sha256').update(`${revocation.assigneeUserId}\u0000${revocation.instanceIdHash}`).digest('hex')
  return `agent-run-revoked#${revocation.workItemId}#${subject}`
}

/** Sort key of the Team Agent settings row. */
const settingsRecordKey = 'agent-settings'

/**
 * Builds the sort key of a settings save receipt.
 *
 * @param mutationKey - Opaque key of the save.
 * @returns Sort key.
 */
function settingsMutationRecordKey(mutationKey: string): string {
  return `agent-settings-mutation#${mutationKey}`
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
 * Reads a required non-empty string from a stored row.
 *
 * @param item - Stored row.
 * @param name - Attribute name.
 * @returns The value.
 */
function storedString(item: Record<string, unknown>, name: string): string {
  const value = item[name]
  if (typeof value !== 'string' || value.length === 0) throw createAgentRunIntegrityError()
  return value
}

/**
 * Reads an optional string from a stored row.
 *
 * @param item - Stored row.
 * @param name - Attribute name.
 * @returns The value or undefined.
 */
function optionalStoredString(item: Record<string, unknown>, name: string): string | undefined {
  const value = item[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) throw createAgentRunIntegrityError()
  return value
}

/**
 * Reads a required non-negative integer from a stored row.
 *
 * @param item - Stored row.
 * @param name - Attribute name.
 * @returns The value.
 */
function storedInteger(item: Record<string, unknown>, name: string): number {
  const value = item[name]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw createAgentRunIntegrityError()
  return value
}

/**
 * Reads a required UTC timestamp from a stored row.
 *
 * @param item - Stored row.
 * @param name - Attribute name.
 * @returns The timestamp.
 */
function storedTimestamp(item: Record<string, unknown>, name: string): string {
  const value = storedString(item, name)
  if (!Number.isFinite(Date.parse(value))) throw createAgentRunIntegrityError()
  return value
}

/**
 * Parses a stored run row and fails closed on any unexpected shape.
 *
 * @param item - Stored row.
 * @param expected - Partition and Team the row must belong to.
 * @returns The run.
 */
function parseRun(
  item: Record<string, unknown>,
  expected: {
    /** Expected Workspace ID. */
    directoryId: string
    /** Expected Team ID. */
    teamId: string
  },
): StoredAgentRun {
  if (item.schemaVersion !== AGENT_RUN_SCHEMA_VERSION || item.entityType !== 'agent-run') {
    throw createAgentRunIntegrityError()
  }
  const runId = storedString(item, 'runId')
  if (
    item.directoryTeamId !== createAgentRunPartition(expected.directoryId, expected.teamId) ||
    item.recordKey !== runRecordKey(runId) ||
    item.workspaceId !== expected.directoryId ||
    item.teamId !== expected.teamId
  ) {
    throw createAgentRunIntegrityError()
  }
  const runtime = AGENT_RUN_RUNTIMES.find((candidate) => candidate === item.runtime)
  const state = item.state === 'active' || item.state === 'finished' ? item.state : undefined
  const outcome = item.outcome === undefined ? undefined : storedOutcomes.find((candidate) => candidate === item.outcome)
  if (!runtime || !state || (item.outcome !== undefined && !outcome) || (state === 'finished') !== (outcome !== undefined)) {
    throw createAgentRunIntegrityError()
  }
  const startRevision = storedInteger(item, 'startRevision')
  const leaseMinutes = storedInteger(item, 'leaseMinutes')
  if (startRevision < 1 || leaseMinutes < 1) throw createAgentRunIntegrityError()
  const finishedAt = item.finishedAt === undefined ? undefined : storedTimestamp(item, 'finishedAt')
  const lastHeartbeatRequestAt = item.lastHeartbeatRequestAt === undefined
    ? undefined
    : storedTimestamp(item, 'lastHeartbeatRequestAt')
  if ((state === 'finished') !== (finishedAt !== undefined)) throw createAgentRunIntegrityError()
  return {
    schemaVersion: AGENT_RUN_SCHEMA_VERSION,
    runId,
    directoryId: expected.directoryId,
    teamId: expected.teamId,
    workItemId: storedString(item, 'workItemId'),
    assigneeUserId: storedString(item, 'assigneeUserId'),
    runtime,
    agentName: storedString(item, 'agentName'),
    instanceIdHash: storedString(item, 'instanceIdHash'),
    credentialId: storedString(item, 'credentialId'),
    state,
    ...(outcome === undefined ? {} : { outcome }),
    startRevision,
    leaseMinutes,
    startedAt: storedTimestamp(item, 'startedAt'),
    lastHeartbeatAt: storedTimestamp(item, 'lastHeartbeatAt'),
    leaseExpiresAt: storedTimestamp(item, 'leaseExpiresAt'),
    ...(lastHeartbeatRequestAt === undefined ? {} : { lastHeartbeatRequestAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(optionalStoredString(item, 'finishedBy') === undefined ? {} : { finishedBy: storedString(item, 'finishedBy') }),
    reportCount: storedInteger(item, 'reportCount'),
    ...readLastReport(item),
    ...(item.stallTriagedAt === undefined ? {} : { stallTriagedAt: storedTimestamp(item, 'stallTriagedAt') }),
  }
}

/**
 * Reads the latest report summary a run row carries.
 *
 * @param item - Stored run row.
 * @returns Kind and time of the latest report, or nothing before the first report.
 */
function readLastReport(item: Record<string, unknown>): Pick<StoredAgentRun, 'lastReportKind' | 'lastReportAt'> {
  if (item.lastReportKind === undefined && item.lastReportAt === undefined) return {}
  const lastReportKind = AGENT_RUN_REPORT_KINDS.find((candidate) => candidate === item.lastReportKind)
  if (!lastReportKind) throw createAgentRunIntegrityError()
  return { lastReportKind, lastReportAt: storedTimestamp(item, 'lastReportAt') }
}

/**
 * Builds the sort-key prefix shared by one Work Item's reports from a digest of the Work Item ID.
 *
 * @param workItemId - Work Item ID.
 * @returns Sort-key prefix ending with the separator.
 */
function reportRecordKeyPrefix(workItemId: string): string {
  // A Work Item ID can hold many multi-byte letters; a fixed-length digest keeps the key far below
  // DynamoDB's 1,024-byte sort key limit and free of the separator. Rows also store the ID itself.
  return `agent-run-report#${createHash('sha256').update(workItemId).digest('base64url')}#`
}

/**
 * Builds a report row key that sorts a Work Item's reports by creation time.
 *
 * @param report - Report.
 * @returns Sort key.
 */
function reportRecordKey(report: Pick<StoredAgentRunReport, 'workItemId' | 'createdAt' | 'runId' | 'sequence'>): string {
  return `${reportRecordKeyPrefix(report.workItemId)}${report.createdAt}#${report.runId}#${String(report.sequence).padStart(6, '0')}`
}

/**
 * Serializes a report row.
 *
 * @param report - Report.
 * @returns Stored item.
 */
function serializeReport(report: StoredAgentRunReport): Record<string, unknown> {
  const { directoryId, ...fields } = report
  return {
    directoryTeamId: createAgentRunPartition(directoryId, report.teamId),
    recordKey: reportRecordKey(report),
    entityType: 'agent-run-report',
    workspaceId: directoryId,
    ...fields,
  }
}

/**
 * Re-applies the request rules to a stored row's structured fields, so a row written outside the
 * validator never reaches viewers.
 *
 * @param item - Stored row.
 * @returns The validated fields.
 */
function parseReportDetails(item: Record<string, unknown>): AgentRunReportDetails {
  // A list is optional in a request but always written on a row.
  if (!Array.isArray(item.verifications) || !Array.isArray(item.artifacts)) throw createAgentRunIntegrityError()
  try {
    return readAgentRunReportDetails(item)
  } catch {
    throw createAgentRunIntegrityError()
  }
}

/**
 * Parses a stored report row and fails closed on any unexpected shape.
 *
 * @param item - Stored row.
 * @param expected - Workspace, Team, and Work Item the row must belong to.
 * @returns The report.
 */
function parseReport(
  item: Record<string, unknown>,
  expected: {
    /** Expected Workspace ID. */
    directoryId: string
    /** Expected Team ID. */
    teamId: string
    /** Expected Work Item ID. */
    workItemId: string
  },
): StoredAgentRunReport {
  if (item.schemaVersion !== AGENT_RUN_SCHEMA_VERSION || item.entityType !== 'agent-run-report') throw createAgentRunIntegrityError()
  const kind = AGENT_RUN_REPORT_KINDS.find((candidate) => candidate === item.kind)
  const sequence = storedInteger(item, 'sequence')
  const report: StoredAgentRunReport = {
    schemaVersion: AGENT_RUN_SCHEMA_VERSION,
    runId: storedString(item, 'runId'),
    directoryId: expected.directoryId,
    teamId: expected.teamId,
    workItemId: storedString(item, 'workItemId'),
    sequence,
    kind: kind ?? 'progress',
    commentId: storedString(item, 'commentId'),
    ...parseReportDetails(item),
    createdAt: storedTimestamp(item, 'createdAt'),
    createdBy: storedString(item, 'createdBy'),
  }
  if (
    !kind ||
    sequence < 1 ||
    item.directoryTeamId !== createAgentRunPartition(expected.directoryId, expected.teamId) ||
    item.workspaceId !== expected.directoryId ||
    item.teamId !== expected.teamId ||
    report.workItemId !== expected.workItemId ||
    item.recordKey !== reportRecordKey(report)
  ) {
    throw createAgentRunIntegrityError()
  }
  return report
}

/** Every outcome a stored run can carry. */
const storedOutcomes: readonly AgentRunOutcome[] = ['completed', 'paused', 'failed', 'released', 'superseded']

/**
 * Serializes a run row with its index keys.
 *
 * @param run - Run to store.
 * @returns DynamoDB item.
 */
function serializeRun(run: StoredAgentRun): Record<string, unknown> {
  const partition = createAgentRunPartition(run.directoryId, run.teamId)
  const { directoryId, ...fields } = run
  return {
    directoryTeamId: partition,
    recordKey: runRecordKey(run.runId),
    entityType: 'agent-run',
    workspaceId: directoryId,
    ...fields,
    workItemRunKey: `${partition}#${run.workItemId}`,
    workItemRunSortKey: `${run.startedAt}#${run.runId}`,
    ...(run.state === 'active'
      ? { activeRunPartition: partition, activeRunSortKey: `${run.leaseExpiresAt}#${run.runId}` }
      : {}),
  }
}

/**
 * Encodes a DynamoDB continuation key as an opaque cursor.
 *
 * @param key - LastEvaluatedKey.
 * @returns Base64url cursor or undefined.
 */
function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
  return key === undefined ? undefined : Buffer.from(JSON.stringify(key), 'utf8').toString('base64url')
}

/**
 * Decodes a cursor and checks that it continues the same partition.
 *
 * @param cursor - Opaque cursor from a previous page.
 * @param partitionAttribute - Index partition attribute name.
 * @param partition - Expected partition value.
 * @returns ExclusiveStartKey, or undefined for the first page.
 */
function decodeCursor(cursor: string | undefined, partitionAttribute: string, partition: string): Record<string, unknown> | undefined {
  if (cursor === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new AgentRunError('validation_failed', 'The cursor is invalid.', { pointer: '/cursor' })
  }
  if (
    !isRecord(parsed) ||
    parsed[partitionAttribute] !== partition ||
    !Object.values(parsed).every((value) => typeof value === 'string')
  ) {
    throw new AgentRunError('validation_failed', 'The cursor is invalid.', { pointer: '/cursor' })
  }
  return parsed
}

/**
 * Checks whether saved settings are exactly what a save with these values committed.
 * @param saved - Current settings.
 * @param update - Values of the save.
 * @returns True when the save produced the current revision and values.
 */
export function isSameSettingsSave(saved: AgentSettings, update: ValidatedAgentSettingsUpdate): boolean {
  // Briefs the editor could not see were copied from the settings, not sent, so a retry is matched
  // on what the editor sent even if another save changed those briefs since.
  const kept = new Set(update.keptProjectIds ?? [])
  const savedProjects = Object.keys(saved.projectBriefs).filter((projectId) => !kept.has(projectId))
  const updateProjects = Object.keys(update.projectBriefs).filter((projectId) => !kept.has(projectId))
  return saved.revision === update.expectedRevision + 1 &&
    saved.leaseMinutes === update.leaseMinutes &&
    saved.allowTakeoverAfterLeaseExpiry === update.allowTakeoverAfterLeaseExpiry &&
    saved.readyStatusIds.length === update.readyStatusIds.length &&
    saved.readyStatusIds.every((id, index) => id === update.readyStatusIds[index]) &&
    saved.requireAcceptanceCriteria === update.requireAcceptanceCriteria &&
    saved.fileFailedRunsToTriage === update.fileFailedRunsToTriage &&
    saved.fileStalledRunsToTriage === update.fileStalledRunsToTriage &&
    saved.acceptanceCriteriaFieldId === update.acceptanceCriteriaFieldId &&
    saved.brief === update.brief &&
    savedProjects.length === updateProjects.length &&
    savedProjects.every((projectId) =>
      Object.hasOwn(update.projectBriefs, projectId) && saved.projectBriefs[projectId] === update.projectBriefs[projectId])
}

/**
 * Validates a page size.
 *
 * @param limit - Requested size.
 * @returns The size.
 */
function readLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumPageSize) {
    throw new AgentRunError('validation_failed', `limit must be an integer from 1 to ${maximumPageSize}.`, { pointer: '/limit' })
  }
  return limit
}

/**
 * Checks whether a DynamoDB error has a given name.
 *
 * @param error - Thrown value.
 * @param name - Exception name.
 * @returns True when the names match.
 */
function isAwsNamedError(error: unknown, name: string): boolean {
  return isRecord(error) && error.name === name
}

/**
 * Checks whether a transaction was cancelled by a conditional failure within the leading items.
 *
 * @param error - Thrown value.
 * @param count - Number of leading items to inspect.
 * @returns True when one of them failed its condition.
 */
function isLeadingConditionalFailure(error: unknown, count: number): boolean {
  if (!isAwsNamedError(error, 'TransactionCanceledException') || !isRecord(error)) return false
  const reasons = error.CancellationReasons
  if (!Array.isArray(reasons)) return false
  return reasons.slice(0, count).some((reason) => isRecord(reason) && reason.Code === 'ConditionalCheckFailed')
}

/**
 * Reads stored settings values from a settings row or a save receipt.
 *
 * @param item - Stored row.
 * @param directoryId - Expected Workspace ID.
 * @param teamId - Expected Team ID.
 * @returns The settings.
 */
function readStoredSettings(item: Record<string, unknown>, directoryId: string, teamId: string): AgentSettings {
  if (
    item.schemaVersion !== AGENT_SETTINGS_SCHEMA_VERSION ||
    item.workspaceId !== directoryId ||
    item.teamId !== teamId ||
    typeof item.allowTakeoverAfterLeaseExpiry !== 'boolean'
  ) {
    throw createAgentRunIntegrityError()
  }
  const revision = storedInteger(item, 'revision')
  const leaseMinutes = storedInteger(item, 'leaseMinutes')
  if (revision < 1 || leaseMinutes < 1) throw createAgentRunIntegrityError()
  // Rows saved before Ready statuses and briefs existed lack them; any other value, null included, is corrupt.
  const readyStatusIds = item.readyStatusIds === undefined ? [] : item.readyStatusIds
  const projectBriefs = item.projectBriefs === undefined ? {} : item.projectBriefs
  if (
    !Array.isArray(readyStatusIds) ||
    !readyStatusIds.every((id): id is string => typeof id === 'string' && id !== '') ||
    (item.brief !== undefined && (typeof item.brief !== 'string' || item.brief === '')) ||
    (item.requireAcceptanceCriteria !== undefined && typeof item.requireAcceptanceCriteria !== 'boolean') ||
    (item.fileFailedRunsToTriage !== undefined && typeof item.fileFailedRunsToTriage !== 'boolean') ||
    (item.fileStalledRunsToTriage !== undefined && typeof item.fileStalledRunsToTriage !== 'boolean') ||
    (item.acceptanceCriteriaFieldId !== undefined &&
      (typeof item.acceptanceCriteriaFieldId !== 'string' || item.acceptanceCriteriaFieldId === '')) ||
    !isRecord(projectBriefs)
  ) {
    throw createAgentRunIntegrityError()
  }
  const briefEntries = Object.entries(projectBriefs)
  if (!briefEntries.every(([, brief]) => typeof brief === 'string' && brief !== '')) throw createAgentRunIntegrityError()
  const briefs: Record<string, string> = Object.fromEntries(
    briefEntries.flatMap(([projectId, brief]) => typeof brief === 'string' ? [[projectId, brief]] : []),
  )
  return {
    schemaVersion: AGENT_SETTINGS_SCHEMA_VERSION,
    teamId,
    revision,
    leaseMinutes,
    allowTakeoverAfterLeaseExpiry: item.allowTakeoverAfterLeaseExpiry,
    readyStatusIds,
    requireAcceptanceCriteria: item.requireAcceptanceCriteria === true,
    ...(typeof item.acceptanceCriteriaFieldId === 'string' ? { acceptanceCriteriaFieldId: item.acceptanceCriteriaFieldId } : {}),
    ...(typeof item.brief === 'string' ? { brief: item.brief } : {}),
    projectBriefs: briefs,
    fileFailedRunsToTriage: item.fileFailedRunsToTriage === true,
    fileStalledRunsToTriage: item.fileStalledRunsToTriage === true,
    updatedAt: storedTimestamp(item, 'updatedAt'),
    updatedBy: storedString(item, 'updatedBy'),
  }
}

/** DynamoDB-backed Agent Run store. */
export class DynamoDbAgentRunStore implements AgentRunStore, AgentRunTriageStore {
  /** Document client configured by the composition root. */
  readonly #client: AgentRunDocumentClient
  /** Agent Runs table name. */
  readonly #tableName: string

  /**
   * Creates the store.
   *
   * @param client - DynamoDB document client.
   * @param tableName - Agent Runs table name.
   */
  constructor(client: AgentRunDocumentClient, tableName: string) {
    this.#client = client
    this.#tableName = tableName
  }

  /** @inheritdoc */
  async getRun(directoryId: string, teamId: string, runId: string): Promise<StoredAgentRun | undefined> {
    const response = await this.#client.send(new GetCommand({
      TableName: this.#tableName,
      Key: { directoryTeamId: createAgentRunPartition(directoryId, teamId), recordKey: runRecordKey(runId) },
      ConsistentRead: true,
    }))
    return response.Item === undefined ? undefined : parseRun(response.Item, { directoryId, teamId })
  }

  /** @inheritdoc */
  async getClaim(directoryId: string, teamId: string, workItemId: string): Promise<StoredAgentRunClaim | undefined> {
    const response = await this.#client.send(new GetCommand({
      TableName: this.#tableName,
      Key: { directoryTeamId: createAgentRunPartition(directoryId, teamId), recordKey: claimRecordKey(workItemId) },
      ConsistentRead: true,
    }))
    const item = response.Item
    if (item === undefined) return undefined
    if (item.entityType !== 'agent-run-claim' || item.workItemId !== workItemId || item.workspaceId !== directoryId) {
      throw createAgentRunIntegrityError()
    }
    return {
      workItemId,
      runId: storedString(item, 'runId'),
      instanceIdHash: storedString(item, 'instanceIdHash'),
      assigneeUserId: storedString(item, 'assigneeUserId'),
    }
  }

  /** @inheritdoc */
  async isInstanceRevoked(directoryId: string, teamId: string, revocation: AgentRunRevocation): Promise<boolean> {
    const response = await this.#client.send(new GetCommand({
      TableName: this.#tableName,
      Key: { directoryTeamId: createAgentRunPartition(directoryId, teamId), recordKey: revocationRecordKey(revocation) },
      ConsistentRead: true,
    }))
    const item = response.Item
    if (item === undefined) return false
    if (
      item.entityType !== 'agent-run-revocation' ||
      item.workItemId !== revocation.workItemId ||
      item.workspaceId !== directoryId ||
      item.assigneeUserId !== revocation.assigneeUserId ||
      item.instanceIdHash !== revocation.instanceIdHash
    ) {
      throw createAgentRunIntegrityError()
    }
    return true
  }

  /** @inheritdoc */
  async getSettings(directoryId: string, teamId: string): Promise<AgentSettings> {
    const response = await this.#client.send(new GetCommand({
      TableName: this.#tableName,
      Key: { directoryTeamId: createAgentRunPartition(directoryId, teamId), recordKey: settingsRecordKey },
      ConsistentRead: true,
    }))
    const item = response.Item
    if (item === undefined) return createDefaultAgentSettings(teamId)
    if (item.entityType !== 'agent-settings') throw createAgentRunIntegrityError()
    return readStoredSettings(item, directoryId, teamId)
  }

  /** @inheritdoc */
  async saveSettings(
    directoryId: string,
    teamId: string,
    update: ValidatedAgentSettingsUpdate,
    actorMemberKey: string,
    now: Date,
    mutationKey: string,
    extraItems: readonly AgentRunTransactItem[],
  ): Promise<AgentSettings> {
    const settings = createSavedAgentSettings(teamId, update, actorMemberKey, now)
    const partition = createAgentRunPartition(directoryId, teamId)
    try {
      await this.#client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.#tableName,
              Item: {
                directoryTeamId: partition,
                recordKey: settingsRecordKey,
                entityType: 'agent-settings',
                workspaceId: directoryId,
                ...settings,
                // Lists the Team for the Triage worker only while it files runs.
                ...(settings.fileFailedRunsToTriage || settings.fileStalledRunsToTriage
                  ? { triageIndexPartition: triageTeamPartition, triageIndexSortKey: partition }
                  : {}),
              },
              ConditionExpression: update.expectedRevision === 0 ? 'attribute_not_exists(recordKey)' : '#revision = :expectedRevision',
              ...(update.expectedRevision === 0
                ? {}
                : {
                    ExpressionAttributeNames: { '#revision': 'revision' },
                    ExpressionAttributeValues: { ':expectedRevision': update.expectedRevision },
                  }),
            },
          },
          {
            // A durable receipt per key: a committed key may only ever replay the save that used it.
            Put: {
              TableName: this.#tableName,
              Item: {
                directoryTeamId: partition,
                recordKey: settingsMutationRecordKey(mutationKey),
                entityType: 'agent-settings-mutation',
                workspaceId: directoryId,
                ...settings,
              },
              ConditionExpression: 'attribute_not_exists(recordKey)',
            },
          },
          ...extraItems,
        ],
      }))
    } catch (error) {
      if (isLeadingConditionalFailure(error, 2)) {
        const receipt = await this.#readSettingsReceipt(directoryId, teamId, mutationKey)
        if (receipt === undefined) {
          throw new AgentRunError('conflict', 'Agent settings changed. Reload them before saving.', { pointer: '/expectedRevision' })
        }
        if (isSameSettingsSave(receipt, update)) return receipt
        throw new AgentRunError('conflict', 'This Idempotency-Key was already used for a different settings save.')
      }
      throw error
    }
    return settings
  }

  /**
   * Reads the settings an earlier save with this key committed.
   * @param directoryId - Workspace ID.
   * @param teamId - Team ID.
   * @param mutationKey - Opaque key of the save.
   * @returns The settings that save committed, or undefined when no save used the key.
   */
  async #readSettingsReceipt(directoryId: string, teamId: string, mutationKey: string): Promise<AgentSettings | undefined> {
    const response = await this.#client.send(new GetCommand({
      TableName: this.#tableName,
      Key: { directoryTeamId: createAgentRunPartition(directoryId, teamId), recordKey: settingsMutationRecordKey(mutationKey) },
      ConsistentRead: true,
    }))
    const item = response.Item
    if (item === undefined) return undefined
    if (item.entityType !== 'agent-settings-mutation') throw createAgentRunIntegrityError()
    return readStoredSettings(item, directoryId, teamId)
  }

  /** @inheritdoc */
  async listWorkItemRuns(directoryId: string, teamId: string, workItemId: string, cursor: string | undefined, limit: number): Promise<AgentRunPage> {
    const key = `${createAgentRunPartition(directoryId, teamId)}#${workItemId}`
    const response = await this.#client.send(new QueryCommand({
      TableName: this.#tableName,
      IndexName: AGENT_RUN_WORK_ITEM_INDEX_NAME,
      KeyConditionExpression: '#workItemRunKey = :workItemRunKey',
      ExpressionAttributeNames: { '#workItemRunKey': 'workItemRunKey' },
      ExpressionAttributeValues: { ':workItemRunKey': key },
      ScanIndexForward: false,
      Limit: readLimit(limit),
      ExclusiveStartKey: decodeCursor(cursor, 'workItemRunKey', key),
    }))
    const indexed = (response.Items ?? []).map((item) => parseRun(item, { directoryId, teamId }))
    if (indexed.some((run) => run.workItemId !== workItemId)) throw createAgentRunIntegrityError()
    // The index is eventually consistent, so a run that just finished can still look active there.
    const runs: StoredAgentRun[] = []
    for (let start = 0; start < indexed.length; start += historyRereadConcurrency) {
      runs.push(...await Promise.all(indexed.slice(start, start + historyRereadConcurrency).map(async (run) => {
        const current = await this.getRun(directoryId, teamId, run.runId)
        if (!current || current.workItemId !== workItemId) throw createAgentRunIntegrityError()
        return current
      })))
    }
    return this.#page(runs, response.LastEvaluatedKey)
  }

  /** @inheritdoc */
  async listActiveRuns(directoryId: string, teamId: string, cursor: string | undefined, limit: number): Promise<AgentRunPage> {
    const partition = createAgentRunPartition(directoryId, teamId)
    const response = await this.#client.send(new QueryCommand({
      TableName: this.#tableName,
      IndexName: AGENT_RUN_ACTIVE_INDEX_NAME,
      KeyConditionExpression: '#activeRunPartition = :partition',
      ExpressionAttributeNames: { '#activeRunPartition': 'activeRunPartition' },
      ExpressionAttributeValues: { ':partition': partition },
      Limit: readLimit(limit),
      ExclusiveStartKey: decodeCursor(cursor, 'activeRunPartition', partition),
    }))
    // The index is eventually consistent; a run that just finished can still appear once.
    const runs = (response.Items ?? [])
      .map((item) => parseRun(item, { directoryId, teamId }))
      .filter((run) => run.state === 'active')
    return this.#page(runs, response.LastEvaluatedKey)
  }

  /** @inheritdoc */
  async listTriageTeams(cursor: string | undefined, limit: number, from?: AgentRunTriageTeam): Promise<AgentRunTriageTeamPage> {
    const start = cursor === undefined && from !== undefined ? createAgentRunPartition(from.directoryId, from.teamId) : undefined
    const response = await this.#client.send(new QueryCommand({
      TableName: this.#tableName,
      IndexName: AGENT_RUN_TRIAGE_INDEX_NAME,
      KeyConditionExpression: '#triageIndexPartition = :partition' + (start === undefined ? '' : ' AND #triageIndexSortKey >= :start'),
      ExpressionAttributeNames: {
        '#triageIndexPartition': 'triageIndexPartition',
        ...(start === undefined ? {} : { '#triageIndexSortKey': 'triageIndexSortKey' }),
      },
      ExpressionAttributeValues: { ':partition': triageTeamPartition, ...(start === undefined ? {} : { ':start': start }) },
      Limit: readLimit(limit),
      ExclusiveStartKey: decodeCursor(cursor, 'triageIndexPartition', triageTeamPartition),
    }))
    const teams = (response.Items ?? []).map((item) => {
      const team = { directoryId: storedString(item, 'workspaceId'), teamId: storedString(item, 'teamId') }
      if (item.directoryTeamId !== createAgentRunPartition(team.directoryId, team.teamId)) throw createAgentRunIntegrityError()
      return team
    })
    const nextCursor = encodeCursor(response.LastEvaluatedKey)
    return { teams, ...(nextCursor === undefined ? {} : { nextCursor }) }
  }

  /** @inheritdoc */
  async readTriageSweepResumeTeam(): Promise<AgentRunTriageTeam | undefined> {
    const response = await this.#client.send(new GetCommand({
      TableName: this.#tableName,
      Key: triageSweepResumeKey,
      ConsistentRead: true,
    }))
    const item = response.Item
    if (item === undefined || item.workspaceId === undefined) return undefined
    return { directoryId: storedString(item, 'workspaceId'), teamId: storedString(item, 'teamId') }
  }

  /** @inheritdoc */
  async saveTriageSweepResumeTeam(team: AgentRunTriageTeam | undefined): Promise<void> {
    // The row carries the Workspace ID while it names a Team, so Workspace deletion removes it.
    await this.#client.send(new UpdateCommand({
      TableName: this.#tableName,
      Key: triageSweepResumeKey,
      ...(team === undefined
        ? {
            UpdateExpression: 'REMOVE #workspaceId, #teamId',
            ExpressionAttributeNames: { '#workspaceId': 'workspaceId', '#teamId': 'teamId' },
          }
        : {
            UpdateExpression: 'SET #workspaceId = :workspaceId, #teamId = :teamId',
            ExpressionAttributeNames: { '#workspaceId': 'workspaceId', '#teamId': 'teamId' },
            ExpressionAttributeValues: { ':workspaceId': team.directoryId, ':teamId': team.teamId },
          }),
    }))
  }

  /** @inheritdoc */
  async readStallPosition(team: AgentRunTriageTeam): Promise<AgentRunStallPosition> {
    const response = await this.#client.send(new GetCommand({
      TableName: this.#tableName,
      Key: { directoryTeamId: createAgentRunPartition(team.directoryId, team.teamId), recordKey: stallWatermarkRecordKey },
      ConsistentRead: true,
    }))
    const item = response.Item
    if (item === undefined) return {}
    if (storedString(item, 'workspaceId') !== team.directoryId || storedString(item, 'teamId') !== team.teamId) {
      throw createAgentRunIntegrityError()
    }
    return {
      ...(item.watermark === undefined ? {} : { watermark: storedString(item, 'watermark') }),
      ...(item.resume === undefined ? {} : { resume: storedString(item, 'resume') }),
    }
  }

  /** @inheritdoc */
  async listStallCandidates(team: AgentRunTriageTeam, after: string | undefined, cursor: string | undefined, limit: number): Promise<AgentRunPage> {
    const partition = createAgentRunPartition(team.directoryId, team.teamId)
    const response = await this.#client.send(new QueryCommand({
      TableName: this.#tableName,
      IndexName: AGENT_RUN_ACTIVE_INDEX_NAME,
      KeyConditionExpression: '#activeRunPartition = :partition' + (after === undefined ? '' : ' AND #activeRunSortKey > :after'),
      ExpressionAttributeNames: {
        '#activeRunPartition': 'activeRunPartition',
        ...(after === undefined ? {} : { '#activeRunSortKey': 'activeRunSortKey' }),
      },
      ExpressionAttributeValues: { ':partition': partition, ...(after === undefined ? {} : { ':after': after }) },
      Limit: readLimit(limit),
      ExclusiveStartKey: decodeCursor(cursor, 'activeRunPartition', partition),
    }))
    const runs = (response.Items ?? [])
      .map((item) => parseRun(item, team))
      .filter((run) => run.state === 'active')
    return this.#page(runs, response.LastEvaluatedKey)
  }

  /** @inheritdoc */
  async saveStallWatermark(run: StoredAgentRun): Promise<void> {
    const watermark = `${run.leaseExpiresAt}#${run.runId}`
    try {
      await this.#client.send(new UpdateCommand({
        TableName: this.#tableName,
        Key: { directoryTeamId: createAgentRunPartition(run.directoryId, run.teamId), recordKey: stallWatermarkRecordKey },
        UpdateExpression: 'SET #workspaceId = :workspaceId, #teamId = :teamId, #watermark = :watermark',
        // Overlapping sweeps never move the watermark back over a run the other one passed.
        ConditionExpression: 'attribute_not_exists(#watermark) OR #watermark < :watermark',
        ExpressionAttributeNames: { '#workspaceId': 'workspaceId', '#teamId': 'teamId', '#watermark': 'watermark' },
        ExpressionAttributeValues: { ':workspaceId': run.directoryId, ':teamId': run.teamId, ':watermark': watermark },
      }))
    } catch (error) {
      if (!isAwsNamedError(error, 'ConditionalCheckFailedException')) throw error
    }
  }

  /** @inheritdoc */
  async saveStallResume(team: AgentRunTriageTeam, run: StoredAgentRun | undefined): Promise<void> {
    const key = { directoryTeamId: createAgentRunPartition(team.directoryId, team.teamId), recordKey: stallWatermarkRecordKey }
    try {
      await this.#client.send(new UpdateCommand(run === undefined
        ? {
            TableName: this.#tableName,
            Key: key,
            UpdateExpression: 'REMOVE #resume',
            // Clearing never creates a row.
            ConditionExpression: 'attribute_exists(#resume)',
            ExpressionAttributeNames: { '#resume': 'resume' },
          }
        : {
            TableName: this.#tableName,
            Key: key,
            UpdateExpression: 'SET #workspaceId = :workspaceId, #teamId = :teamId, #resume = :resume',
            ExpressionAttributeNames: { '#workspaceId': 'workspaceId', '#teamId': 'teamId', '#resume': 'resume' },
            ExpressionAttributeValues: { ':workspaceId': team.directoryId, ':teamId': team.teamId, ':resume': `${run.leaseExpiresAt}#${run.runId}` },
          }))
    } catch (error) {
      if (!isAwsNamedError(error, 'ConditionalCheckFailedException')) throw error
    }
  }

  /** @inheritdoc */
  async listFailedRunsToTriage(limit: number): Promise<AgentRunTriageOutboxEntry[]> {
    const response = await this.#client.send(new QueryCommand({
      TableName: this.#tableName,
      IndexName: AGENT_RUN_TRIAGE_INDEX_NAME,
      KeyConditionExpression: '#triageIndexPartition = :partition',
      ExpressionAttributeNames: { '#triageIndexPartition': 'triageIndexPartition' },
      ExpressionAttributeValues: { ':partition': triageFailedRunPartition },
      Limit: readLimit(limit),
    }))
    return (response.Items ?? []).map((item) => {
      const entry = {
        directoryId: storedString(item, 'workspaceId'),
        teamId: storedString(item, 'teamId'),
        runId: storedString(item, 'runId'),
      }
      if (item.directoryTeamId !== createAgentRunPartition(entry.directoryId, entry.teamId) || item.recordKey !== runRecordKey(entry.runId)) {
        throw createAgentRunIntegrityError()
      }
      return entry
    })
  }

  /** @inheritdoc */
  async deferFailedRunTriage(entry: AgentRunTriageOutboxEntry, now: Date): Promise<void> {
    const partition = createAgentRunPartition(entry.directoryId, entry.teamId)
    try {
      await this.#client.send(new UpdateCommand({
        TableName: this.#tableName,
        Key: { directoryTeamId: partition, recordKey: runRecordKey(entry.runId) },
        UpdateExpression: 'SET #triageIndexSortKey = :triageIndexSortKey',
        // Never puts back an entry another sweep already cleared.
        ConditionExpression: '#triageIndexPartition = :triageIndexPartition',
        ExpressionAttributeNames: { '#triageIndexPartition': 'triageIndexPartition', '#triageIndexSortKey': 'triageIndexSortKey' },
        ExpressionAttributeValues: {
          ':triageIndexPartition': triageFailedRunPartition,
          ':triageIndexSortKey': `${now.toISOString()}#${partition}#${entry.runId}`,
        },
      }))
    } catch (error) {
      if (!isAwsNamedError(error, 'ConditionalCheckFailedException')) throw error
    }
  }

  /** @inheritdoc */
  async clearFailedRunTriage(entry: AgentRunTriageOutboxEntry): Promise<void> {
    try {
      await this.#client.send(new UpdateCommand({
        TableName: this.#tableName,
        Key: { directoryTeamId: createAgentRunPartition(entry.directoryId, entry.teamId), recordKey: runRecordKey(entry.runId) },
        UpdateExpression: 'REMOVE #triageIndexPartition, #triageIndexSortKey',
        // Never creates a row: a run deleted since it was listed has nothing left to clear.
        ConditionExpression: 'attribute_exists(#recordKey)',
        ExpressionAttributeNames: {
          '#triageIndexPartition': 'triageIndexPartition',
          '#triageIndexSortKey': 'triageIndexSortKey',
          '#recordKey': 'recordKey',
        },
      }))
    } catch (error) {
      if (!isAwsNamedError(error, 'ConditionalCheckFailedException')) throw error
    }
  }

  /** @inheritdoc */
  async markStallTriaged(run: StoredAgentRun, now: Date): Promise<boolean> {
    try {
      await this.#client.send(new UpdateCommand({
        TableName: this.#tableName,
        Key: { directoryTeamId: createAgentRunPartition(run.directoryId, run.teamId), recordKey: runRecordKey(run.runId) },
        UpdateExpression: 'SET #stallTriagedAt = :now',
        ConditionExpression: '#state = :active AND #leaseExpiresAt = :leaseExpiresAt',
        ExpressionAttributeNames: { '#stallTriagedAt': 'stallTriagedAt', '#state': 'state', '#leaseExpiresAt': 'leaseExpiresAt' },
        ExpressionAttributeValues: { ':now': now.toISOString(), ':active': 'active', ':leaseExpiresAt': run.leaseExpiresAt },
      }))
      return true
    } catch (error) {
      if (isAwsNamedError(error, 'ConditionalCheckFailedException')) return false
      throw error
    }
  }

  /** @inheritdoc */
  async listFinishedRuns(directoryId: string, teamId: string, cursor: string | undefined, limit: number): Promise<AgentRunPage> {
    const partition = createAgentRunPartition(directoryId, teamId)
    const response = await this.#client.send(new QueryCommand({
      TableName: this.#tableName,
      KeyConditionExpression: '#directoryTeamId = :partition AND begins_with(#recordKey, :prefix)',
      FilterExpression: '#state = :finished',
      ExpressionAttributeNames: { '#directoryTeamId': 'directoryTeamId', '#recordKey': 'recordKey', '#state': 'state' },
      ExpressionAttributeValues: { ':partition': partition, ':prefix': 'agent-run#', ':finished': 'finished' },
      Limit: readLimit(limit),
      ExclusiveStartKey: decodeCursor(cursor, 'directoryTeamId', partition),
    }))
    return this.#page((response.Items ?? []).map((item) => parseRun(item, { directoryId, teamId })), response.LastEvaluatedKey)
  }

  /** @inheritdoc */
  async listWorkItemReports(directoryId: string, teamId: string, workItemId: string, cursor: string | undefined, limit: number): Promise<AgentRunReportPage> {
    const partition = createAgentRunPartition(directoryId, teamId)
    const prefix = reportRecordKeyPrefix(workItemId)
    const start = decodeCursor(cursor, 'directoryTeamId', partition)
    if (start !== undefined && (typeof start.recordKey !== 'string' || !start.recordKey.startsWith(prefix))) {
      throw new AgentRunError('validation_failed', 'The cursor is invalid.', { pointer: '/cursor' })
    }
    const pageSize = readLimit(limit)
    // A page can end at the item limit or at 1 MB with nothing left, so one more report is read to
    // know whether older ones exist, and the cursor continues after the last returned report.
    const items: Record<string, unknown>[] = []
    let next = start
    do {
      const response = await this.#client.send(new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: '#directoryTeamId = :partition AND begins_with(#recordKey, :prefix)',
        ExpressionAttributeNames: { '#directoryTeamId': 'directoryTeamId', '#recordKey': 'recordKey' },
        ExpressionAttributeValues: { ':partition': partition, ':prefix': prefix },
        ScanIndexForward: false,
        ConsistentRead: true,
        Limit: pageSize + 1 - items.length,
        ExclusiveStartKey: next,
      }))
      items.push(...(response.Items ?? []))
      next = response.LastEvaluatedKey
    } while (items.length <= pageSize && next !== undefined)
    const page = items.slice(0, pageSize)
    const reports = page.map((item) => parseReport(item, { directoryId, teamId, workItemId }))
    const last = page.at(-1)
    const nextCursor = items.length > pageSize && last !== undefined
      ? encodeCursor({ directoryTeamId: last.directoryTeamId, recordKey: last.recordKey })
      : undefined
    return { reports, ...(nextCursor === undefined ? {} : { nextCursor }) }
  }

  /** @inheritdoc */
  createReportItems(run: StoredAgentRun, report: StoredAgentRunReport, now: Date): AgentRunTransactItem[] {
    if (
      run.state !== 'active' ||
      report.runId !== run.runId ||
      report.workItemId !== run.workItemId ||
      report.sequence !== run.reportCount + 1 ||
      report.createdAt !== now.toISOString()
    ) {
      throw new TypeError('createReportItems requires the next report of an active run, created at the report time.')
    }
    const partition = createAgentRunPartition(run.directoryId, run.teamId)
    const leaseExpiresAt = calculateLeaseExpiry(now, run.leaseMinutes)
    return [
      {
        Update: {
          TableName: this.#tableName,
          Key: { directoryTeamId: partition, recordKey: runRecordKey(run.runId) },
          UpdateExpression: 'SET #reportCount = :sequence, #lastReportKind = :kind, #lastReportAt = :now, ' +
            '#lastHeartbeatAt = :now, #leaseExpiresAt = :leaseExpiresAt, #activeRunSortKey = :activeRunSortKey',
          // Reports are numbered by the run; a concurrent report or a closed run fails this write, and a
          // heartbeat newer than the report keeps its later lease.
          ConditionExpression: '#state = :active AND #instanceIdHash = :instanceIdHash AND #reportCount = :previous AND #lastHeartbeatAt <= :now',
          ExpressionAttributeNames: {
            '#reportCount': 'reportCount',
            '#lastReportKind': 'lastReportKind',
            '#lastReportAt': 'lastReportAt',
            '#lastHeartbeatAt': 'lastHeartbeatAt',
            '#leaseExpiresAt': 'leaseExpiresAt',
            '#activeRunSortKey': 'activeRunSortKey',
            '#state': 'state',
            '#instanceIdHash': 'instanceIdHash',
          },
          ExpressionAttributeValues: {
            ':sequence': report.sequence,
            ':kind': report.kind,
            ':now': report.createdAt,
            ':leaseExpiresAt': leaseExpiresAt,
            ':activeRunSortKey': `${leaseExpiresAt}#${run.runId}`,
            ':active': 'active',
            ':instanceIdHash': run.instanceIdHash,
            ':previous': run.reportCount,
          },
        },
      },
      this.#claimCheck({
        directoryId: run.directoryId,
        teamId: run.teamId,
        workItemId: run.workItemId,
        instanceIdHash: run.instanceIdHash,
        assigneeUserId: run.assigneeUserId,
        run,
        now,
      }),
      {
        Put: {
          TableName: this.#tableName,
          Item: serializeReport(report),
          ConditionExpression: 'attribute_not_exists(recordKey)',
        },
      },
    ]
  }

  /** @inheritdoc */
  createStartItems(run: StoredAgentRun): AgentRunTransactItem[] {
    const partition = createAgentRunPartition(run.directoryId, run.teamId)
    return [
      {
        Put: {
          TableName: this.#tableName,
          Item: serializeRun(run),
          ConditionExpression: 'attribute_not_exists(recordKey)',
        },
      },
      {
        Put: {
          TableName: this.#tableName,
          Item: {
            directoryTeamId: partition,
            recordKey: claimRecordKey(run.workItemId),
            entityType: 'agent-run-claim',
            workspaceId: run.directoryId,
            workItemId: run.workItemId,
            runId: run.runId,
            instanceIdHash: run.instanceIdHash,
            assigneeUserId: run.assigneeUserId,
          },
          ConditionExpression: 'attribute_not_exists(recordKey)',
        },
      },
      {
        // Starting again is how a released instance resumes work on this Work Item.
        Delete: {
          TableName: this.#tableName,
          Key: { directoryTeamId: partition, recordKey: revocationRecordKey(run) },
        },
      },
    ]
  }

  /** @inheritdoc */
  createMutationFenceConditionChecks(input: AgentRunFenceInput): AgentRunTransactItem[] {
    if (!input.run) return [this.#claimCheck(input), this.#notRevokedCheck(input)]
    return [
      {
        ConditionCheck: {
          TableName: this.#tableName,
          Key: { directoryTeamId: createAgentRunPartition(input.directoryId, input.teamId), recordKey: runRecordKey(input.run.runId) },
          ConditionExpression: '#state = :active AND #workItemId = :workItemId AND #instanceIdHash = :instanceIdHash',
          ExpressionAttributeNames: { '#state': 'state', '#workItemId': 'workItemId', '#instanceIdHash': 'instanceIdHash' },
          ExpressionAttributeValues: { ':active': 'active', ':workItemId': input.workItemId, ':instanceIdHash': input.instanceIdHash },
        },
      },
      this.#claimCheck(input),
    ]
  }

  /** @inheritdoc */
  createClaimAbsentCheck(directoryId: string, teamId: string, workItemId: string): AgentRunTransactItem {
    return {
      ConditionCheck: {
        TableName: this.#tableName,
        Key: { directoryTeamId: createAgentRunPartition(directoryId, teamId), recordKey: claimRecordKey(workItemId) },
        ConditionExpression: 'attribute_not_exists(#recordKey)',
        ExpressionAttributeNames: { '#recordKey': 'recordKey' },
      },
    }
  }

  /** @inheritdoc */
  createSettingsRevisionCheck(directoryId: string, teamId: string, revision: number): AgentRunTransactItem {
    const conditionCheck = {
      TableName: this.#tableName,
      Key: { directoryTeamId: createAgentRunPartition(directoryId, teamId), recordKey: settingsRecordKey },
    }
    return {
      ConditionCheck: revision === 0
        ? { ...conditionCheck, ConditionExpression: 'attribute_not_exists(#recordKey)', ExpressionAttributeNames: { '#recordKey': 'recordKey' } }
        : {
            ...conditionCheck,
            ConditionExpression: '#revision = :revision',
            ExpressionAttributeNames: { '#revision': 'revision' },
            ExpressionAttributeValues: { ':revision': revision },
          },
    }
  }

  /** @inheritdoc */
  createCloseItems(run: StoredAgentRun, expectedInstanceIdHash?: string, fenceProgress = false): AgentRunTransactItem[] {
    if (run.state !== 'finished' || !run.outcome || !run.finishedAt || !run.finishedBy) {
      throw new TypeError('createCloseItems requires the finished form of a run.')
    }
    const partition = createAgentRunPartition(run.directoryId, run.teamId)
    const failed = run.outcome === 'failed'
    const conditions = [
      '#state = :active',
      ...(expectedInstanceIdHash === undefined ? [] : ['#instanceIdHash = :instanceIdHash']),
      ...(fenceProgress ? ['#reportCount = :reportCount', '#lastHeartbeatAt = :lastHeartbeatAt'] : []),
    ]
    return [
      {
        Update: {
          TableName: this.#tableName,
          Key: { directoryTeamId: partition, recordKey: runRecordKey(run.runId) },
          // A failed run joins the Triage outbox in the same write, so the worker never misses it.
          UpdateExpression: 'SET #state = :finished, #outcome = :outcome, #finishedAt = :finishedAt, #finishedBy = :finishedBy' +
            (failed ? ', #triageIndexPartition = :triageIndexPartition, #triageIndexSortKey = :triageIndexSortKey' : '') +
            ' REMOVE #activeRunPartition, #activeRunSortKey, #lastHeartbeatRequestAt',
          ConditionExpression: conditions.join(' AND '),
          ExpressionAttributeNames: {
            '#state': 'state',
            ...(expectedInstanceIdHash === undefined ? {} : { '#instanceIdHash': 'instanceIdHash' }),
            ...(fenceProgress ? { '#reportCount': 'reportCount', '#lastHeartbeatAt': 'lastHeartbeatAt' } : {}),
            '#outcome': 'outcome',
            '#finishedAt': 'finishedAt',
            '#finishedBy': 'finishedBy',
            '#activeRunPartition': 'activeRunPartition',
            '#activeRunSortKey': 'activeRunSortKey',
            '#lastHeartbeatRequestAt': 'lastHeartbeatRequestAt',
            ...(failed ? { '#triageIndexPartition': 'triageIndexPartition', '#triageIndexSortKey': 'triageIndexSortKey' } : {}),
          },
          ExpressionAttributeValues: {
            ':finished': 'finished',
            ...(failed
              ? { ':triageIndexPartition': triageFailedRunPartition, ':triageIndexSortKey': `${run.finishedAt}#${partition}#${run.runId}` }
              : {}),
            ':outcome': run.outcome,
            ':finishedAt': run.finishedAt,
            ':finishedBy': run.finishedBy,
            ':active': 'active',
            ...(expectedInstanceIdHash === undefined ? {} : { ':instanceIdHash': expectedInstanceIdHash }),
            ...(fenceProgress ? { ':reportCount': run.reportCount, ':lastHeartbeatAt': run.lastHeartbeatAt } : {}),
          },
        },
      },
      {
        Delete: {
          TableName: this.#tableName,
          Key: { directoryTeamId: partition, recordKey: claimRecordKey(run.workItemId) },
          ConditionExpression: '#runId = :runId',
          ExpressionAttributeNames: { '#runId': 'runId' },
          ExpressionAttributeValues: { ':runId': run.runId },
        },
      },
      ...(run.outcome === 'released' || run.outcome === 'superseded'
        ? [{
            Put: {
              TableName: this.#tableName,
              Item: {
                directoryTeamId: partition,
                recordKey: revocationRecordKey(run),
                entityType: 'agent-run-revocation',
                workspaceId: run.directoryId,
                workItemId: run.workItemId,
                assigneeUserId: run.assigneeUserId,
                instanceIdHash: run.instanceIdHash,
                runId: run.runId,
                revokedAt: run.finishedAt,
              },
            },
          }]
        : []),
    ]
  }

  /** @inheritdoc */
  createTakeOverItems(superseded: StoredAgentRun, successor: StoredAgentRun): AgentRunTransactItem[] {
    if (
      superseded.outcome !== 'superseded' ||
      successor.state !== 'active' ||
      successor.workItemId !== superseded.workItemId ||
      successor.instanceIdHash === superseded.instanceIdHash
    ) {
      throw new TypeError('createTakeOverItems requires a superseded run and an active successor of another instance.')
    }
    const [closeUpdate, , revocationPut] = this.createCloseItems(superseded, superseded.instanceIdHash)
    const [runPut, claimPut, revocationDelete] = this.createStartItems(successor)
    if (!closeUpdate?.Update || !revocationPut || !runPut || !claimPut?.Put || !revocationDelete) {
      throw new TypeError('The close and start builders returned unexpected items.')
    }
    return [
      {
        Update: {
          ...closeUpdate.Update,
          // A heartbeat that renews the lease first wins; only a stalled run can be taken over.
          ConditionExpression: `${closeUpdate.Update.ConditionExpression} AND #leaseExpiresAt < :takenOverAt`,
          ExpressionAttributeNames: { ...closeUpdate.Update.ExpressionAttributeNames, '#leaseExpiresAt': 'leaseExpiresAt' },
          ExpressionAttributeValues: { ...closeUpdate.Update.ExpressionAttributeValues, ':takenOverAt': successor.startedAt },
        },
      },
      {
        // The claim is replaced in place; a delete and a put of the same row cannot share a transaction.
        // Only a claim whose whole holder is the superseded run may be replaced.
        Put: {
          ...claimPut.Put,
          ConditionExpression: '#runId = :supersededRunId AND #instanceIdHash = :supersededInstanceIdHash AND #assigneeUserId = :supersededAssigneeUserId',
          ExpressionAttributeNames: { '#runId': 'runId', '#instanceIdHash': 'instanceIdHash', '#assigneeUserId': 'assigneeUserId' },
          ExpressionAttributeValues: {
            ':supersededRunId': superseded.runId,
            ':supersededInstanceIdHash': superseded.instanceIdHash,
            ':supersededAssigneeUserId': superseded.assigneeUserId,
          },
        },
      },
      revocationPut,
      runPut,
      revocationDelete,
    ]
  }

  /** @inheritdoc */
  async commit(items: readonly AgentRunTransactItem[], fenceItemCount: number): Promise<void> {
    try {
      await this.#client.send(new TransactWriteCommand({ TransactItems: [...items] }))
    } catch (error) {
      if (isLeadingConditionalFailure(error, fenceItemCount)) throw createAgentRunNotActiveError()
      if (isAwsNamedError(error, 'TransactionCanceledException')) throw createAgentRunCommitConflictError()
      throw error
    }
  }

  /** @inheritdoc */
  async heartbeat(
    run: StoredAgentRun,
    instanceIdHash: string,
    now: Date,
    conditionChecks: readonly AgentRunTransactItem[] = [],
  ): Promise<StoredAgentRun> {
    const leaseExpiresAt = calculateLeaseExpiry(now, run.leaseMinutes)
    const threshold = new Date(now.getTime() - AGENT_RUN_HEARTBEAT_INTERVAL_SECONDS * 1_000).toISOString()
    const partition = createAgentRunPartition(run.directoryId, run.teamId)
    try {
      await this.#client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.#tableName,
              Key: { directoryTeamId: partition, recordKey: runRecordKey(run.runId) },
              UpdateExpression: 'SET #lastHeartbeatAt = :now, #lastHeartbeatRequestAt = :now, #leaseExpiresAt = :leaseExpiresAt, #activeRunSortKey = :activeRunSortKey',
              ConditionExpression: '#state = :active AND #instanceIdHash = :instanceIdHash AND #lastHeartbeatAt < :now AND ' +
                '(attribute_not_exists(#lastHeartbeatRequestAt) OR #lastHeartbeatRequestAt <= :threshold)',
              ExpressionAttributeNames: {
                '#lastHeartbeatAt': 'lastHeartbeatAt',
                '#lastHeartbeatRequestAt': 'lastHeartbeatRequestAt',
                '#leaseExpiresAt': 'leaseExpiresAt',
                '#activeRunSortKey': 'activeRunSortKey',
                '#state': 'state',
                '#instanceIdHash': 'instanceIdHash',
              },
              ExpressionAttributeValues: {
                ':now': now.toISOString(),
                ':leaseExpiresAt': leaseExpiresAt,
                ':activeRunSortKey': `${leaseExpiresAt}#${run.runId}`,
                ':active': 'active',
                ':threshold': threshold,
                ':instanceIdHash': instanceIdHash,
              },
            },
          },
          {
            // An active run that no longer holds its claim is inconsistent and must not stay alive.
            ConditionCheck: {
              TableName: this.#tableName,
              Key: { directoryTeamId: partition, recordKey: claimRecordKey(run.workItemId) },
              ConditionExpression: '#runId = :runId AND #instanceIdHash = :instanceIdHash',
              ExpressionAttributeNames: { '#runId': 'runId', '#instanceIdHash': 'instanceIdHash' },
              ExpressionAttributeValues: { ':runId': run.runId, ':instanceIdHash': instanceIdHash },
            },
          },
          ...conditionChecks,
        ],
      }))
    } catch (error) {
      if (!isAwsNamedError(error, 'TransactionCanceledException')) throw error
      if (!isLeadingConditionalFailure(error, 2)) throw createAgentRunCommitConflictError()
      const current = await this.getRun(run.directoryId, run.teamId, run.runId)
      if (!current || current.state !== 'active' || current.instanceIdHash !== instanceIdHash) throw createAgentRunNotActiveError()
      const claim = await this.getClaim(run.directoryId, run.teamId, run.workItemId)
      if (claim?.runId !== run.runId || claim.instanceIdHash !== instanceIdHash) throw createAgentRunIntegrityError()
      const nextAllowedAt = current.lastHeartbeatRequestAt === undefined
        ? 0
        : Date.parse(current.lastHeartbeatRequestAt) + AGENT_RUN_HEARTBEAT_INTERVAL_SECONDS * 1_000
      // Outside the rate window, only a newer lease renewal (a fenced mutation) can have failed the condition.
      if (nextAllowedAt <= now.getTime()) return current
      const retryAfterSeconds = Math.max(1, Math.ceil((nextAllowedAt - now.getTime()) / 1_000))
      throw new AgentRunError('rate_limited', `Send at most one heartbeat every ${AGENT_RUN_HEARTBEAT_INTERVAL_SECONDS} seconds per run.`, { retryAfterSeconds })
    }
    return {
      ...run,
      lastHeartbeatAt: now.toISOString(),
      lastHeartbeatRequestAt: now.toISOString(),
      leaseExpiresAt,
    }
  }

  /** @inheritdoc */
  async extendLeaseAfterMutation(run: StoredAgentRun, now: Date): Promise<void> {
    const leaseExpiresAt = calculateLeaseExpiry(now, run.leaseMinutes)
    try {
      await this.#client.send(new UpdateCommand({
        TableName: this.#tableName,
        Key: { directoryTeamId: createAgentRunPartition(run.directoryId, run.teamId), recordKey: runRecordKey(run.runId) },
        UpdateExpression: 'SET #lastHeartbeatAt = :now, #leaseExpiresAt = :leaseExpiresAt, #activeRunSortKey = :activeRunSortKey',
        ConditionExpression: '#state = :active AND #lastHeartbeatAt < :now',
        ExpressionAttributeNames: {
          '#lastHeartbeatAt': 'lastHeartbeatAt',
          '#leaseExpiresAt': 'leaseExpiresAt',
          '#activeRunSortKey': 'activeRunSortKey',
          '#state': 'state',
        },
        ExpressionAttributeValues: {
          ':now': now.toISOString(),
          ':leaseExpiresAt': leaseExpiresAt,
          ':activeRunSortKey': `${leaseExpiresAt}#${run.runId}`,
          ':active': 'active',
        },
      }))
    } catch (error) {
      // The mutation already committed under the run fence; a run released since then keeps its state.
      if (!isAwsNamedError(error, 'ConditionalCheckFailedException')) throw error
    }
  }

  /**
   * Builds the claim condition for a fenced mutation.
   *
   * @param input - Fence input.
   * @returns ConditionCheck on the claim row.
   */
  #claimCheck(input: AgentRunFenceInput): AgentRunTransactItem {
    const key = { directoryTeamId: createAgentRunPartition(input.directoryId, input.teamId), recordKey: claimRecordKey(input.workItemId) }
    return input.run
      ? {
          ConditionCheck: {
            TableName: this.#tableName,
            Key: key,
            ConditionExpression: '#runId = :runId AND #instanceIdHash = :instanceIdHash',
            ExpressionAttributeNames: { '#runId': 'runId', '#instanceIdHash': 'instanceIdHash' },
            ExpressionAttributeValues: { ':runId': input.run.runId, ':instanceIdHash': input.instanceIdHash },
          },
        }
      : {
          ConditionCheck: {
            TableName: this.#tableName,
            Key: key,
            ConditionExpression: 'attribute_not_exists(#recordKey) OR (#instanceIdHash = :instanceIdHash AND #assigneeUserId = :assigneeUserId)',
            ExpressionAttributeNames: { '#recordKey': 'recordKey', '#instanceIdHash': 'instanceIdHash', '#assigneeUserId': 'assigneeUserId' },
            ExpressionAttributeValues: { ':instanceIdHash': input.instanceIdHash, ':assigneeUserId': input.assigneeUserId },
          },
        }
  }

  /**
   * Builds the check that rejects an instance whose run on the Work Item a person released or
   * another instance took over. It reads committed state, unlike the run index.
   *
   * @param input - Fence input.
   * @returns ConditionCheck that no revocation exists for the caller's member and instance.
   */
  #notRevokedCheck(input: AgentRunFenceInput): AgentRunTransactItem {
    return {
      ConditionCheck: {
        TableName: this.#tableName,
        Key: {
          directoryTeamId: createAgentRunPartition(input.directoryId, input.teamId),
          recordKey: revocationRecordKey({
            workItemId: input.workItemId,
            assigneeUserId: input.assigneeUserId,
            instanceIdHash: input.instanceIdHash,
          }),
        },
        ConditionExpression: 'attribute_not_exists(#recordKey)',
        ExpressionAttributeNames: { '#recordKey': 'recordKey' },
      },
    }
  }

  /**
   * Builds a page from query results.
   *
   * @param runs - Parsed runs.
   * @param lastEvaluatedKey - Continuation key.
   * @returns Page.
   */
  #page(runs: StoredAgentRun[], lastEvaluatedKey: Record<string, unknown> | undefined): AgentRunPage {
    const nextCursor = encodeCursor(lastEvaluatedKey)
    return { runs, ...(nextCursor === undefined ? {} : { nextCursor }) }
  }
}
