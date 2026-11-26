import type { AgentRunOutcome, AgentRunRuntime } from '@mukuroji/contracts'
import { createTranslator, type Locale } from '../../../shared/i18n/i18n'
import { createWorkItemAgentRunsLabels } from '../../../work-items/ui/agentRunLabels'
import type { RunHistoryCsvLabels } from '../model/runHistory'

/** Locale-aware text of the Run history page. */
export type RunHistoryLabels = {
  /** Accessible name of the history. */
  title: string
  /** Accessible name of the filter group. */
  filters: string
  /** Link back to a Team's Factory board. */
  backToBoard: string
  /** Period filter label. */
  period: string
  /** Period option with a `{days}` placeholder. */
  periodDays: string
  /** Team filter label. */
  team: string
  /** Option for every Team. */
  allTeams: string
  /** Outcome filter label. */
  outcome: string
  /** Option for every outcome. */
  allOutcomes: string
  /** Runtime filter label. */
  runtime: string
  /** Option for every runtime. */
  allRuntimes: string
  /** Scope filter label. */
  scope: string
  /** Option for every member's runs. */
  scopeAll: string
  /** Option for the viewer's own runs. */
  scopeMine: string
  /** Project filter label. */
  project: string
  /** Option for every Project. */
  allProjects: string
  /** Loading message. */
  loading: string
  /** Load failure message. */
  loadError: string
  /** Retry action. */
  retry: string
  /** Message when no run matches. */
  empty: string
  /** Message when the viewer can view no Team. */
  noTeams: string
  /** Notice that some runs were left out. */
  incomplete: string
  /** Notice naming the Teams left out for lack of permission, with a `{teams}` placeholder. */
  deniedTeams: string
  /** Number of shown runs with a `{count}` placeholder. */
  count: string
  /** CSV download action. */
  download: string
  /** Column headings, shared with the CSV. */
  headings: RunHistoryCsvLabels['headings']
  /** Display names of outcomes. */
  outcomes: Record<AgentRunOutcome, string>
  /** Display names of runtimes. */
  runtimes: Record<AgentRunRuntime, string>
}

/**
 * Creates the text of the Run history page.
 *
 * @param locale - Display locale.
 * @returns Labels.
 */
export function createRunHistoryLabels(locale: Locale): RunHistoryLabels {
  const t = createTranslator(locale)
  const runLabels = createWorkItemAgentRunsLabels(locale)
  return {
    title: t('factoryBoard.history.title'),
    filters: t('factoryBoard.filter.label'),
    backToBoard: t('factoryBoard.history.backToBoard'),
    period: t('factoryBoard.history.period'),
    periodDays: t('factoryBoard.history.periodDays'),
    team: t('factoryBoard.history.team'),
    allTeams: t('factoryBoard.history.allTeams'),
    outcome: t('factoryBoard.history.outcome'),
    allOutcomes: t('factoryBoard.history.allOutcomes'),
    runtime: t('factoryBoard.history.runtime'),
    allRuntimes: t('factoryBoard.history.allRuntimes'),
    scope: t('factoryBoard.history.scope'),
    scopeAll: t('factoryBoard.history.scopeAll'),
    scopeMine: t('factoryBoard.history.scopeMine'),
    project: t('factoryBoard.history.project'),
    allProjects: t('factoryBoard.history.allProjects'),
    loading: t('factoryBoard.history.loading'),
    loadError: t('factoryBoard.history.loadError'),
    retry: t('factoryBoard.retry'),
    empty: t('factoryBoard.history.empty'),
    noTeams: t('factoryBoard.history.noTeams'),
    incomplete: t('factoryBoard.history.incomplete'),
    deniedTeams: t('factoryBoard.history.deniedTeams'),
    count: t('factoryBoard.history.count'),
    download: t('factoryBoard.history.download'),
    headings: {
      finishedAt: t('factoryBoard.history.column.finishedAt'),
      team: t('factoryBoard.history.column.team'),
      workItem: t('factoryBoard.history.column.workItem'),
      workItemId: t('factoryBoard.history.column.workItemId'),
      project: t('factoryBoard.history.column.project'),
      assignee: t('factoryBoard.history.column.assignee'),
      agentName: t('factoryBoard.history.column.agentName'),
      runtime: t('factoryBoard.history.column.runtime'),
      outcome: t('factoryBoard.history.column.outcome'),
      startedAt: t('factoryBoard.history.column.startedAt'),
      durationMinutes: t('factoryBoard.history.column.duration'),
      runId: t('factoryBoard.history.column.runId'),
    },
    outcomes: {
      completed: runLabels.states.completed,
      paused: runLabels.states.paused,
      failed: runLabels.states.failed,
      released: runLabels.states.released,
      superseded: runLabels.states.superseded,
    },
    runtimes: runLabels.runtimes,
  }
}
