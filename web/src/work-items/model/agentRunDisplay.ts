import type { AgentRun } from '@mukuroji/contracts'

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
