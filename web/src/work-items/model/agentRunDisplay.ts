import type { AgentRun, AgentRunStartedBy } from '@mukuroji/contracts'

/** Display state of an Agent Run, with stalled runs separated from running ones. */
export type AgentRunDisplayState =
  | 'running'
  | 'stalled'
  | 'completed'
  | 'paused'
  | 'failed'
  | 'released'
  | 'superseded'

/**
 * Derives the display state of a run.
 *
 * @param run - Run read from the API.
 * @returns Display state.
 */
export function readAgentRunDisplayState(run: Pick<AgentRun, 'state' | 'stalled' | 'outcome'>): AgentRunDisplayState {
  if (run.state === 'active') return run.stalled ? 'stalled' : 'running'
  return run.outcome ?? 'completed'
}

/**
 * Splits runs into the active run, which can hold the Work Item, and the finished history.
 *
 * @param runs - Runs, newest first.
 * @returns The active run and the remaining runs in their original order.
 */
export function splitAgentRuns<Run extends Pick<AgentRun, 'state'>>(runs: readonly Run[]): {
  /** Run that currently claims the Work Item. */
  active?: Run
  /** Finished runs, newest first. */
  history: Run[]
} {
  const active = runs.find((run) => run.state === 'active')
  return {
    ...(active ? { active } : {}),
    history: runs.filter((run) => run !== active),
  }
}

/**
 * Describes the credential that started a run: its API key name with the ID, or the ID alone.
 *
 * @param startedBy - Credential and instance that started the run.
 * @returns Display text.
 */
export function formatAgentRunCredential(startedBy: AgentRunStartedBy): string {
  return startedBy.credentialName === undefined
    ? startedBy.credentialId
    : `${startedBy.credentialName} (${startedBy.credentialId})`
}

/**
 * Shortens an instance hash for display; the full hash stays available as a tooltip.
 *
 * @param instanceIdHash - SHA-256 hash of the agent instance ID.
 * @returns The first 12 characters.
 */
export function shortenAgentInstanceHash(instanceIdHash: string): string {
  return instanceIdHash.slice(0, 12)
}

/** Units of an elapsed time, as the viewer's locale writes them. */
export type AgentDurationUnits = {
  /** Hours and minutes, such as `{h} h {m} min`. */
  hours: string
  /** Minutes and seconds, such as `{m} min {s} s`. */
  minutes: string
  /** Seconds, such as `{s} s`. */
  seconds: string
}

/**
 * Formats an elapsed time for the Agent Run time breakdown, rounded to the two largest units.
 *
 * @param milliseconds - Elapsed milliseconds.
 * @param units - Locale text with `{h}`, `{m}`, and `{s}` placeholders.
 * @returns Text such as `1 h 5 min`, `3 min 20 s`, or `45 s`.
 */
export function formatAgentDuration(milliseconds: number, units: AgentDurationUnits): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000))
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return units.hours.replace('{h}', String(hours)).replace('{m}', String(minutes))
  if (minutes > 0) return units.minutes.replace('{m}', String(minutes)).replace('{s}', String(seconds))
  return units.seconds.replace('{s}', String(seconds))
}
