import type { AgentRunUsageStore, AgentAnalyticsWatch } from '../../adapter-out/dynamodb/agent-run-usage-store'
import { AGENT_ANALYTICS_WATCH_DAYS } from '../../adapter-out/dynamodb/agent-run-usage-store'
import type { AgentTelemetryAnalyticsSink } from '../../adapter-out/firehose/agent-telemetry-analytics-sink'
import type { StoredAgentRun } from '../../domain/agent-run'
import {
  buildAgentAnalyticsRunStateRow,
  buildAgentAnalyticsWorkItemRow,
  type AgentAnalyticsRunRow,
  type AgentAnalyticsWorkItem,
  type AgentAnalyticsWorkItemRow,
} from '../../domain/agent-telemetry-analytics'

/** Runs read at a time. */
const readConcurrency = 8

/** Watches one query reads. */
const watchPageSize = 500

/** What the daily export reads and writes. */
export type AgentAnalyticsDailyExportDependencies = {
  /** Store of the started-run notes. */
  usage: Pick<AgentRunUsageStore, 'listAnalyticsWatches'>
  /** Reads one run. */
  readRun(directoryId: string, teamId: string, runId: string): Promise<StoredAgentRun | undefined>
  /** Reads a Work Item's current values; undefined when it no longer exists. */
  readWorkItem(directoryId: string, teamId: string, workItemId: string): Promise<AgentAnalyticsWorkItem | undefined>
  /** Whether a Workspace is still active; a closing or closed Workspace is skipped. */
  isWorkspaceActive(workspaceId: string): Promise<boolean>
  /** Analytics sink. */
  sink: Pick<AgentTelemetryAnalyticsSink, 'enabled' | 'putRuns' | 'putWorkItems'>
  /** Export time. */
  now: Date
}

/** Counts of one daily export. */
export type AgentAnalyticsDailyExportResult = {
  /** Run rows written. */
  runs: number
  /** Work Item rows written. */
  workItems: number
  /** Runs skipped because the run, its Work Item, or its Workspace is gone. */
  skipped: number
}

/**
 * Writes the current state of every run that started in the last {@link AGENT_ANALYTICS_WATCH_DAYS}
 * days, and the current values of their Work Items, to the S3 analytics store (ADR 0118). Athena reads
 * the latest row of each run and Work Item, so a finish, a release, or a completion after the start
 * reaches the analytics store within a day.
 *
 * @param dependencies - Stores, sink, and export time.
 * @returns Counts of the export.
 */
export async function runAgentAnalyticsDailyExport(
  dependencies: AgentAnalyticsDailyExportDependencies,
): Promise<AgentAnalyticsDailyExportResult> {
  const result: AgentAnalyticsDailyExportResult = { runs: 0, workItems: 0, skipped: 0 }
  if (!dependencies.sink.enabled) return result
  const activeWorkspaces = new Map<string, Promise<boolean>>()
  const writtenWorkItems = new Set<string>()
  const today = Date.UTC(dependencies.now.getUTCFullYear(), dependencies.now.getUTCMonth(), dependencies.now.getUTCDate())
  // Every page of every day is read and written before the next, so no noted run is left out and
  // memory stays bounded by one page.
  for (let offset = 0; offset <= AGENT_ANALYTICS_WATCH_DAYS; offset += 1) {
    const day = new Date(today - offset * 86_400_000).toISOString().slice(0, 10)
    let cursor: string | undefined
    do {
      const page = await dependencies.usage.listAnalyticsWatches(day, cursor, watchPageSize)
      await exportWatchPage(dependencies, page.watches, activeWorkspaces, writtenWorkItems, result)
      cursor = page.nextCursor
    } while (cursor !== undefined)
  }
  return result
}

/**
 * Reads one page of noted runs and writes their state and their Work Items' values. A Work Item
 * already written by an earlier page of this export is not written again.
 *
 * @param dependencies - Stores, sink, and export time.
 * @param watches - Noted runs of the page.
 * @param activeWorkspaces - Workspace availability read so far.
 * @param writtenWorkItems - Work Items written so far, by key.
 * @param result - Counts to add to.
 */
async function exportWatchPage(
  dependencies: AgentAnalyticsDailyExportDependencies,
  watches: readonly AgentAnalyticsWatch[],
  activeWorkspaces: Map<string, Promise<boolean>>,
  writtenWorkItems: Set<string>,
  result: AgentAnalyticsDailyExportResult,
): Promise<void> {
  const workItemReads = new Map<string, Promise<AgentAnalyticsWorkItem | undefined>>()
  const runRows: AgentAnalyticsRunRow[] = []
  const workItemRows = new Map<string, AgentAnalyticsWorkItemRow>()
  for (let start = 0; start < watches.length; start += readConcurrency) {
    await Promise.all(watches.slice(start, start + readConcurrency).map(async (watch) => {
      const active = activeWorkspaces.get(watch.directoryId) ?? dependencies.isWorkspaceActive(watch.directoryId)
      activeWorkspaces.set(watch.directoryId, active)
      if (!await active) {
        result.skipped += 1
        return
      }
      const run = await dependencies.readRun(watch.directoryId, watch.teamId, watch.runId)
      if (run === undefined) {
        result.skipped += 1
        return
      }
      const key = `${run.directoryId}#${run.teamId}#${run.workItemId}`
      const read = workItemReads.get(key) ?? dependencies.readWorkItem(run.directoryId, run.teamId, run.workItemId)
      workItemReads.set(key, read)
      const workItem = await read
      if (workItem === undefined) {
        result.skipped += 1
        return
      }
      runRows.push(buildAgentAnalyticsRunStateRow(run, dependencies.now))
      if (!writtenWorkItems.has(key)) {
        workItemRows.set(key, buildAgentAnalyticsWorkItemRow(run.directoryId, run.teamId, run.workItemId, workItem, dependencies.now))
      }
    }))
  }
  if (runRows.length > 0) await dependencies.sink.putRuns(runRows)
  if (workItemRows.size > 0) await dependencies.sink.putWorkItems([...workItemRows.values()])
  for (const key of workItemRows.keys()) writtenWorkItems.add(key)
  result.runs += runRows.length
  result.workItems += workItemRows.size
}
