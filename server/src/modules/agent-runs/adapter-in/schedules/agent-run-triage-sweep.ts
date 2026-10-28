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
  store: Pick<AgentRunStore, 'getRun' | 'getSettings' | 'listActiveRuns'> & AgentRunTriageStore
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
  const title = `${reason === 'failed' ? 'Agent run failed' : 'Agent run stalled'}: ${workItem.title}`
  const summary = reason === 'failed'
    ? `${run.agentName} (${run.runtime}) finished its run on this Work Item as failed at ${run.finishedAt ?? run.lastHeartbeatAt}.`
    : `${run.agentName} (${run.runtime}) has not reported on this Work Item since ${run.lastHeartbeatAt}; its lease expired at ${run.leaseExpiresAt}.`
  return {
    runId: run.runId,
    reason,
    title: title.length > titleMaxLength ? `${title.slice(0, titleMaxLength - 1)}…` : title,
    body: [
      summary,
      '',
      `Work Item: ${workItem.title}`,
      `Path: ${workItem.path}`,
      `Run: ${run.runId}`,
      `Assignee: ${run.assigneeUserId}`,
      ...(run.lastReportKind === undefined ? [] : [`Latest report: ${run.lastReportKind} at ${run.lastReportAt ?? 'unknown time'}`]),
    ].join('\n'),
    agentName: run.agentName,
    assigneeUserId: run.assigneeUserId,
    ...(workItem.projectId === undefined ? {} : { projectId: workItem.projectId }),
  }
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
 * Files the stalled runs of the Teams that file them, each run once.
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
  const { store, now } = dependencies
  let cursor: string | undefined
  let teamsSeen = 0
  do {
    const page = await store.listTriageTeams(cursor, pageSize)
    cursor = page.nextCursor
    for (const team of page.teams) {
      if (teamsSeen >= AGENT_RUN_TRIAGE_MAX_TEAMS || result.stalledFiled + result.errors >= AGENT_RUN_TRIAGE_STALLED_BATCH) {
        result.truncated = true
        return
      }
      teamsSeen += 1
      try {
        const settings = await readSettings(team)
        if (!settings.fileStalledRunsToTriage) continue
        for (const run of await readStalledRuns(store, team, now, result)) {
          if (result.stalledFiled + result.errors >= AGENT_RUN_TRIAGE_STALLED_BATCH) {
            result.truncated = true
            return
          }
          try {
            // The index is eventually consistent; a heartbeat it has not seen yet means the run is not stalled.
            const current = await store.getRun(team.directoryId, team.teamId, run.runId)
            if (!current || !isAgentRunStalled(current, now) || current.stallTriagedAt !== undefined) continue
            const workItem = await dependencies.workItems.read(team.directoryId, team.teamId, current.workItemId)
            if (!workItem) continue
            const outcome = await dependencies.triage.file(team.directoryId, team.teamId, createAgentRunTriageFiling(current, 'stalled', workItem))
            if (outcome === 'filed') result.stalledFiled += 1
            else result.rejected += 1
            // A run that recovered or finished since it was read keeps no mark; its entry stays.
            await store.markStallTriaged(current, now)
          } catch (error) {
            result.errors += 1
            dependencies.onError?.({ ...team, runId: run.runId, code: readErrorCode(error) })
          }
        }
      } catch (error) {
        result.errors += 1
        dependencies.onError?.({ ...team, code: readErrorCode(error) })
      }
    }
  } while (cursor !== undefined)
}

/**
 * Reads a Team's stalled runs that were not filed yet. Active runs come soonest lease expiry
 * first, so reading stops at the first run whose lease has not expired.
 *
 * @param store - Agent Run store.
 * @param team - Team.
 * @param now - Sweep time.
 * @param result - Counts to update when the bound is reached.
 * @returns Stalled runs without a filing mark.
 */
async function readStalledRuns(
  store: Pick<AgentRunStore, 'listActiveRuns'>,
  team: AgentRunTriageTeam,
  now: Date,
  result: AgentRunTriageSweepResult,
): Promise<StoredAgentRun[]> {
  const stalled: StoredAgentRun[] = []
  let cursor: string | undefined
  let read = 0
  do {
    const page = await store.listActiveRuns(team.directoryId, team.teamId, cursor, pageSize)
    cursor = page.nextCursor
    for (const run of page.runs) {
      read += 1
      if (!isAgentRunStalled(run, now)) return stalled
      if (run.stallTriagedAt === undefined) stalled.push(run)
    }
    if (read >= activeRunsPerTeam && cursor !== undefined) {
      result.truncated = true
      return stalled
    }
  } while (cursor !== undefined)
  return stalled
}
