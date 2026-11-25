import { AgentTaskError, type AgentRunFilters, type AgentRunRecord, type AgentWorkItemApi } from './work-item-api'

/** Run pages one hook call reads per Team; a member rarely holds more than one page of active runs. */
export const HOOK_HEARTBEAT_MAX_PAGES_PER_TEAM = 5

/**
 * Age of a run's last heartbeat under which a rate-limited heartbeat still counts as recent.
 * The server refuses a heartbeat within 10 seconds of the previous one; the margin covers clock skew.
 */
export const HOOK_HEARTBEAT_RECENT_MS = 30_000

/** Team API a hook heartbeat renews runs through. */
export type HookHeartbeatTeam = {
  /** Team ID. */
  teamId: string
  /** Run reads and heartbeats of the Team. */
  api: Pick<AgentWorkItemApi, 'listActiveRuns' | 'heartbeat'>
}

/** Options of one hook heartbeat. */
export type HookHeartbeatOptions = {
  /** Whether a run belongs to the configured Project; omitted when no Project is configured. */
  runInScope?: (run: AgentRunRecord) => Promise<boolean>
  /** Current time in milliseconds; defaults to the clock. */
  now?: number
}

/** Counts of one hook heartbeat. */
export type HookHeartbeatResult = {
  /** Runs whose lease was extended. */
  renewed: number
  /** Runs that already received a heartbeat in the last 30 seconds; their lease is current. */
  recent: number
  /** Teams or runs that could not be read, scoped, or renewed, including Teams with more runs than one call reads. */
  failed: number
}

/**
 * Extends the lease of every active run this instance started, as an agent hook calls it between
 * tool calls. A rate-limited heartbeat counts as recent only when the run's last heartbeat is
 * recent; otherwise it is a failure, since the throttle may be the credential's and the lease was
 * not extended. Failures are counted, never thrown, so a hook never blocks the agent.
 *
 * @param teams - Configured Teams and their APIs.
 * @param owner - Assignee and instance of this agent process.
 * @param owner.assigneeUserId - Configured assignee.
 * @param owner.instanceId - Instance ID the runs were started with.
 * @param options - Optional Project scope and clock.
 * @returns Counts of the call.
 */
export async function heartbeatOwnRuns(
  teams: readonly HookHeartbeatTeam[],
  owner: Required<AgentRunFilters>,
  options: HookHeartbeatOptions = {},
): Promise<HookHeartbeatResult> {
  const result: HookHeartbeatResult = { renewed: 0, recent: 0, failed: 0 }
  const now = options.now ?? Date.now()
  for (const { api } of teams) {
    let runs: AgentRunRecord[]
    try {
      runs = await listOwnActiveRuns(api, owner)
    } catch {
      result.failed += 1
      continue
    }
    for (const run of runs) {
      try {
        if (options.runInScope && !(await options.runInScope(run))) continue
        await api.heartbeat(run.runId, owner.instanceId)
        result.renewed += 1
      } catch (error) {
        if (error instanceof AgentTaskError && error.code === 'rate_limited' && heartbeatIsRecent(run, now)) result.recent += 1
        else result.failed += 1
      }
    }
  }
  return result
}

/**
 * Reads every active run of the owner in one Team, following cursors.
 *
 * @param api - Team API.
 * @param owner - Assignee and instance of this agent process.
 * @returns The owner's active runs.
 * @throws AgentTaskError invalid_response for a missing or repeated cursor, queue_limit when more pages exist than one call reads.
 */
async function listOwnActiveRuns(
  api: HookHeartbeatTeam['api'],
  owner: Required<AgentRunFilters>,
): Promise<AgentRunRecord[]> {
  const runs: AgentRunRecord[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < HOOK_HEARTBEAT_MAX_PAGES_PER_TEAM; page += 1) {
    const listed = await api.listActiveRuns(owner, cursor)
    runs.push(...listed.items.filter((run) => run.assigneeUserId === owner.assigneeUserId && run.state === 'active'))
    if (!listed.hasMore) return runs
    if (!listed.nextCursor || cursors.has(listed.nextCursor)) {
      throw new AgentTaskError('invalid_response', 'The API returned a missing or repeated run cursor.')
    }
    cursor = listed.nextCursor
    cursors.add(cursor)
  }
  throw new AgentTaskError('queue_limit', 'More active runs exist than one hook heartbeat reads.')
}

/**
 * Checks whether a run's last heartbeat is recent enough that its lease is current.
 *
 * @param run - Listed run.
 * @param now - Current time in milliseconds.
 * @returns True when the last heartbeat is within the recent window.
 */
function heartbeatIsRecent(run: AgentRunRecord, now: number): boolean {
  const last = Date.parse(run.lastHeartbeatAt)
  return Number.isFinite(last) && now - last < HOOK_HEARTBEAT_RECENT_MS
}
