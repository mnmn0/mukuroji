import type { AgentSettings } from '@mukuroji/contracts'
import { isAgentRunStalled, type StoredAgentRun } from '../../domain/agent-run'
import type {
  AgentRunStore,
  AgentRunTriageOutboxEntry,
  AgentRunTriageStore,
  AgentRunTriageTeam,
} from '../../adapter-out/dynamodb/agent-run-store'

/** Failed runs one sweep files at most, oldest finish first. */
export const AGENT_RUN_TRIAGE_FAILED_BATCH = 50

/** Teams one sweep checks for stalled runs at most. */
export const AGENT_RUN_TRIAGE_MAX_TEAMS = 500

/** Stalled runs one sweep files at most across all Teams. */
export const AGENT_RUN_TRIAGE_STALLED_BATCH = 100

/** Active runs read per Team at most, soonest lease expiry first. */
const activeRunsPerTeam = 200

/** Page size of the Team and active run reads. */
const pageSize = 100

/** Longest title of an entry, matching the Triage limit. */
const titleMaxLength = 500

/** Longest body of an entry, matching the Triage limit. */
const bodyMaxLength = 8000

/**
 * Stall age after which the eventually consistent index is trusted to list every earlier run.
 * The watermark only passes runs this long past their lease, so a run the index has not shown
 * yet stays ahead of it unless the index lags by more than the lease plus this margin.
 */
const watermarkSettleMs = 15 * 60_000

/** Why a run is filed. */
export type AgentRunTriageReason = 'failed' | 'stalled'

/** Work Item facts an entry shows. */
export type AgentRunTriageWorkItem = {
  /** Work Item title. */
  title: string
  /** Path of the Work Item in the Web application. */
  path: string
  /** Project the Work Item is assigned to, if any. */
  projectId?: string
}

/** Reads the Work Item a run belongs to. */
export interface AgentRunTriageWorkItemReader {
  /**
   * Reads one Work Item.
   * @param directoryId - Workspace ID.
   * @param teamId - Team ID.
   * @param workItemId - Work Item ID.
   * @returns The Work Item, or undefined when it was deleted or archived.
   */
  read(directoryId: string, teamId: string, workItemId: string): Promise<AgentRunTriageWorkItem | undefined>
}

/** Content of one entry the sweep files. */
export type AgentRunTriageFiling = {
  /** Run the entry is about. */
  runId: string
  /** Whether the run failed or stalled. */
  reason: AgentRunTriageReason
  /** Entry title. */
  title: string
  /** Plain-text entry body. */
  body: string
  /** Agent name shown as the requester. */
  agentName: string
  /** Member responsible for the run. */
  assigneeUserId: string
  /** Project of the Work Item; the entry is then visible only to people who can see it. */
  projectId?: string
}

/**
 * Files entries to Triage. `filed` includes an entry that already existed; `rejected` means Triage
 * refused the input, so retrying cannot help. Any other failure throws and is retried later.
 */
export interface AgentRunTriageFiler {
  /**
   * Files one entry.
   * @param directoryId - Workspace ID.
   * @param teamId - Team ID.
   * @param filing - Entry content.
   * @returns Whether the entry exists now or was refused.
   */
  file(directoryId: string, teamId: string, filing: AgentRunTriageFiling): Promise<'filed' | 'rejected'>
}

/** Dependencies of one sweep. */
export type AgentRunTriageSweepDependencies = {
  /** Agent Run reads and the Triage outbox. */
  store: Pick<AgentRunStore, 'getRun' | 'getSettings'> & AgentRunTriageStore
  /** Work Item reader. */
  workItems: AgentRunTriageWorkItemReader
  /** Triage writer. */
  triage: AgentRunTriageFiler
  /** Sweep time. */
  now: Date
  /** Receives a failure that leaves its item for the next sweep; only IDs and an error code are passed. */
  onError?: (failure: AgentRunTriageSweepFailure) => void
}

/** A failure of one item, without content that could hold personal data. */
export type AgentRunTriageSweepFailure = {
  /** Workspace ID. */
  directoryId: string
  /** Team ID. */
  teamId: string
  /** Run ID, when the failure concerns one run. */
  runId?: string
  /** Error name or code. */
  code: string
}

/** Counts of one sweep. */
export type AgentRunTriageSweepResult = {
  /** Failed runs filed, including entries that already existed. */
  failedFiled: number
  /** Failed runs removed from the outbox without filing: the Team does not file them, or the run or Work Item is gone. */
  failedSkipped: number
  /** Stalled runs filed, including entries that already existed. */
  stalledFiled: number
  /** Runs Triage refused; they are not retried. */
  rejected: number
  /** Items left for the next sweep after a failure. */
  errors: number
  /** Whether a bound stopped the sweep before it saw every candidate. */
  truncated: boolean
}

/**
 * Builds the entry for a failed or stalled run. The body holds identifiers and times only, never
 * report text or artifact links, which the Work Item already shows to people allowed to see them.
 *
 * @param run - Run as stored.
 * @param reason - Whether the run failed or stalled.
 * @param workItem - Work Item of the run.
 * @returns Entry content.
 */
export function createAgentRunTriageFiling(
  run: StoredAgentRun,
  reason: AgentRunTriageReason,
  workItem: AgentRunTriageWorkItem,
): AgentRunTriageFiling {
  const title = truncate(`${reason === 'failed' ? 'Agent run failed' : 'Agent run stalled'}: ${workItem.title}`, titleMaxLength)
  const summary = reason === 'failed'
    ? `${run.agentName} (${run.runtime}) finished its run on this Work Item as failed at ${run.finishedAt ?? run.lastHeartbeatAt}.`
    : `${run.agentName} (${run.runtime}) has not reported on this Work Item since ${run.lastHeartbeatAt}; its lease expired at ${run.leaseExpiresAt}.`
  return {
    runId: run.runId,
    reason,
    title,
    // A Work Item title may be longer than an entry allows, so the body never repeats it in full.
    body: truncate([
      summary,
      '',
      `Work Item: ${truncate(workItem.title, titleMaxLength)}`,
      `Path: ${workItem.path}`,
      `Run: ${run.runId}`,
      `Assignee: ${run.assigneeUserId}`,
      ...(run.lastReportKind === undefined ? [] : [`Latest report: ${run.lastReportKind} at ${run.lastReportAt ?? 'unknown time'}`]),
    ].join('\n'), bodyMaxLength),
    agentName: run.agentName,
    assigneeUserId: run.assigneeUserId,
    ...(workItem.projectId === undefined ? {} : { projectId: workItem.projectId }),
  }
}

/**
 * Shortens text to a length, ending it with an ellipsis when it was cut.
 *
 * @param text - Text.
 * @param maxLength - Largest length.
 * @returns Text of at most `maxLength` characters.
 */
function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}

/**
 * Reads a safe code from an unknown error.
 *
 * @param error - Thrown value.
 * @returns Error code or name.
 */
function readErrorCode(error: unknown): string {
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
    return code ?? error.name
  }
  return 'Unknown'
}

/**
 * Files failed runs from the Triage outbox and stalled runs of the Teams that file them. Each run
 * is filed once; a failure leaves the run for the next sweep, and every read is bounded.
 *
 * @param dependencies - Stores, Triage writer, and the sweep time.
 * @returns Counts of the sweep.
 */
export async function runAgentRunTriageSweep(dependencies: AgentRunTriageSweepDependencies): Promise<AgentRunTriageSweepResult> {
  const result: AgentRunTriageSweepResult = { failedFiled: 0, failedSkipped: 0, stalledFiled: 0, rejected: 0, errors: 0, truncated: false }
  const settingsByTeam = new Map<string, Promise<AgentSettings>>()
  /**
   * Strongly reads a Team's settings once per sweep.
   * @param team - Team.
   * @returns Settings.
   */
  const readSettings = (team: AgentRunTriageTeam) => {
    const teamKey = `${team.directoryId}|${team.teamId}`
    const cached = settingsByTeam.get(teamKey)
    if (cached) return cached
    const read = dependencies.store.getSettings(team.directoryId, team.teamId)
    settingsByTeam.set(teamKey, read)
    return read
  }
  await fileFailedRuns(dependencies, readSettings, result)
  await fileStalledRuns(dependencies, readSettings, result)
  return result
}

/**
 * Files the oldest failed runs of the outbox.
 *
 * @param dependencies - Sweep dependencies.
 * @param readSettings - Cached settings read.
 * @param result - Counts to update.
 */
async function fileFailedRuns(
  dependencies: AgentRunTriageSweepDependencies,
  readSettings: (team: AgentRunTriageTeam) => Promise<AgentSettings>,
  result: AgentRunTriageSweepResult,
): Promise<void> {
  const { store } = dependencies
  const entries = await store.listFailedRunsToTriage(AGENT_RUN_TRIAGE_FAILED_BATCH)
  if (entries.length === AGENT_RUN_TRIAGE_FAILED_BATCH) result.truncated = true
  for (const entry of entries) {
    try {
      const outcome = await fileFailedRun(dependencies, readSettings, entry)
      if (outcome === 'filed') result.failedFiled += 1
      else if (outcome === 'rejected') result.rejected += 1
      else result.failedSkipped += 1
      await store.clearFailedRunTriage(entry)
    } catch (error) {
      result.errors += 1
      dependencies.onError?.({ ...entry, code: readErrorCode(error) })
    }
  }
}

/**
 * Files one failed run when its Team files failed runs.
 *
 * @param dependencies - Sweep dependencies.
 * @param readSettings - Cached settings read.
 * @param entry - Outbox entry.
 * @returns What happened to the run.
 */
async function fileFailedRun(
  dependencies: AgentRunTriageSweepDependencies,
  readSettings: (team: AgentRunTriageTeam) => Promise<AgentSettings>,
  entry: AgentRunTriageOutboxEntry,
): Promise<'filed' | 'rejected' | 'skipped'> {
  const settings = await readSettings(entry)
  if (!settings.fileFailedRunsToTriage) return 'skipped'
  const run = await dependencies.store.getRun(entry.directoryId, entry.teamId, entry.runId)
  if (run?.outcome !== 'failed') return 'skipped'
  const workItem = await dependencies.workItems.read(entry.directoryId, entry.teamId, run.workItemId)
  if (!workItem) return 'skipped'
  return dependencies.triage.file(entry.directoryId, entry.teamId, createAgentRunTriageFiling(run, 'failed', workItem))
}

/**
 * Files the stalled runs of the Teams that file them, each run once. A sweep that reaches its bound
 * saves the Team it stopped at, so the next sweep continues there instead of at the first Team.
 *
 * @param dependencies - Sweep dependencies.
 * @param readSettings - Cached settings read.
 * @param result - Counts to update.
 */
async function fileStalledRuns(
  dependencies: AgentRunTriageSweepDependencies,
  readSettings: (team: AgentRunTriageTeam) => Promise<AgentSettings>,
  result: AgentRunTriageSweepResult,
): Promise<void> {
  const { store } = dependencies
  const resumeTeam = await store.readTriageSweepResumeTeam()
  let cursor: string | undefined
  let teamsSeen = 0
  do {
    const page = await store.listTriageTeams(cursor, pageSize, cursor === undefined ? resumeTeam : undefined)
    cursor = page.nextCursor
    for (const team of page.teams) {
      let complete = teamsSeen < AGENT_RUN_TRIAGE_MAX_TEAMS && !isStalledBatchFull(result)
      if (complete) {
        teamsSeen += 1
        try {
          const settings = await readSettings(team)
          if (settings.fileStalledRunsToTriage) complete = await fileTeamStalledRuns(dependencies, team, result)
        } catch (error) {
          result.errors += 1
          dependencies.onError?.({ ...team, code: readErrorCode(error) })
        }
      }
      if (!complete) {
        result.truncated = true
        await store.saveTriageSweepResumeTeam(team)
        return
      }
    }
  } while (cursor !== undefined)
  if (resumeTeam !== undefined) await store.saveTriageSweepResumeTeam(undefined)
}

/**
 * Checks whether the sweep filed or failed as many stalled runs as it may.
 *
 * @param result - Counts so far.
 * @returns True when no further stalled run may be filed.
 */
function isStalledBatchFull(result: AgentRunTriageSweepResult): boolean {
  return result.stalledFiled + result.errors >= AGENT_RUN_TRIAGE_STALLED_BATCH
}

/**
 * Files a Team's stalled runs after its watermark, soonest lease expiry first, and moves the
 * watermark past each run it is done with. Reading stops at the first run whose lease has not
 * expired, and a failed run stays after the watermark for the next sweep.
 *
 * @param dependencies - Sweep dependencies.
 * @param team - Team that files stalled runs.
 * @param result - Counts to update.
 * @returns False when the sweep bound stopped the Team before its last stalled run.
 */
async function fileTeamStalledRuns(
  dependencies: AgentRunTriageSweepDependencies,
  team: AgentRunTriageTeam,
  result: AgentRunTriageSweepResult,
): Promise<boolean> {
  const { store, now } = dependencies
  const after = await store.readStallWatermark(team)
  let passed: StoredAgentRun | undefined
  let complete = true
  let cursor: string | undefined
  let read = 0
  reading: do {
    const page = await store.listStallCandidates(team, after, cursor, pageSize)
    cursor = page.nextCursor
    for (const run of page.runs) {
      if (!isAgentRunStalled(run, now)) break reading
      if (run.stallTriagedAt === undefined) {
        if (isStalledBatchFull(result)) {
          complete = false
          break reading
        }
        try {
          await fileStalledRun(dependencies, team, run, result)
        } catch (error) {
          result.errors += 1
          dependencies.onError?.({ ...team, runId: run.runId, code: readErrorCode(error) })
          break reading
        }
      }
      // Runs come soonest lease first, so once one is too recent to pass, none after it is passed.
      if (Date.parse(run.leaseExpiresAt) <= now.getTime() - watermarkSettleMs) passed = run
      read += 1
    }
    if (read >= activeRunsPerTeam && cursor !== undefined) {
      // The watermark has moved past these runs, so the next sweep reads the ones after them.
      result.truncated = true
      break
    }
  } while (cursor !== undefined)
  if (passed !== undefined) await store.saveStallWatermark(passed)
  return complete
}

/**
 * Files one run the index lists as stalled, after reading it again strongly.
 *
 * @param dependencies - Sweep dependencies.
 * @param team - Team of the run.
 * @param run - Run as listed.
 * @param result - Counts to update.
 */
async function fileStalledRun(
  dependencies: AgentRunTriageSweepDependencies,
  team: AgentRunTriageTeam,
  run: StoredAgentRun,
  result: AgentRunTriageSweepResult,
): Promise<void> {
  const { store, now } = dependencies
  // The index is eventually consistent; a heartbeat it has not seen yet means the run is not stalled.
  const current = await store.getRun(team.directoryId, team.teamId, run.runId)
  if (!current || !isAgentRunStalled(current, now) || current.stallTriagedAt !== undefined) return
  const workItem = await dependencies.workItems.read(team.directoryId, team.teamId, current.workItemId)
  if (!workItem) return
  const outcome = await dependencies.triage.file(team.directoryId, team.teamId, createAgentRunTriageFiling(current, 'stalled', workItem))
  if (outcome === 'filed') result.stalledFiled += 1
  else result.rejected += 1
  // A run that recovered or finished since it was read keeps no mark; its entry stays.
  await store.markStallTriaged(current, now)
}
