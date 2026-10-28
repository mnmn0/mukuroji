import type { FactoryBoardLane } from '@mukuroji/contracts'
import { createTranslator, type Locale } from '../../../shared/i18n/i18n'
import { createWorkItemAgentRunsLabels, type WorkItemAgentRunsLabels } from '../../../work-items/ui/agentRunLabels'
import { createAgentRunReportChipsLabels, type AgentRunReportChipsLabels } from '../../../work-items/ui/agentRunReportLabels'

/** Locale-aware text of the Factory board. */
export type FactoryBoardLabels = {
  /** Count summary with `{processing}`, `{decision}`, and `{stalled}` placeholders. */
  summary: string
  /** Refresh action. */
  refresh: string
  /** Initial loading text. */
  loading: string
  /** Loading failure text. */
  loadError: string
  /** Retry action. */
  retry: string
  /** Text shown when the Team has nothing on the board. */
  empty: string
  /** Explanation under the empty text. */
  emptyDescription: string
  /** Text shown when the filters match nothing. */
  noResults: string
  /** Notice shown when the server reached a read bound. */
  incomplete: string
  /** Accessible name of the filter group. */
  filterLabel: string
  /** Runtime filter label. */
  filterRuntime: string
  /** Assignee filter label. */
  filterAssignee: string
  /** Project filter label. */
  filterProject: string
  /** Filter choice that keeps everything. */
  filterAll: string
  /** Project filter choice for unassigned Work Items. */
  filterNoProject: string
  /** Lane names. */
  lanes: Record<FactoryBoardLane, string>
  /** Explanation of the run-less group at the end of the processing lane. */
  noRunDescription: string
  /** Text of an empty lane. */
  laneEmpty: string
  /** Lease time left with a `{minutes}` placeholder. */
  leaseRemaining: string
  /** Time since the lease expired with a `{minutes}` placeholder. */
  leaseExpired: string
  /** Finish time with a `{time}` placeholder. */
  finishedAt: string
  /** Text shown when a run has no report. */
  noReport: string
  /** Verification counts with `{passed}` and `{failed}` placeholders. */
  verifications: string
  /** Accessible name of the detail pane. */
  detailLabel: string
  /** Phone action that returns from the detail to the lanes. */
  back: string
  /** Text of the desktop detail pane before a selection. */
  detailPlaceholder: string
  /** Action that opens the Work Item. */
  openWorkItem: string
  /** Label of the run's start revision. */
  startRevision: string
  /** Label of the Work Item assignee. */
  assignee: string
  /** Heading of the latest report excerpt. */
  latestReport: string
  /** Heading of the report timeline. */
  reports: string
  /** Report loading text. */
  reportsLoading: string
  /** Report loading failure text. */
  reportsError: string
  /** Text shown when the run has no report. */
  reportsEmpty: string
  /** Note shown when older reports are not loaded. */
  reportsTruncated: string
  /** Detail text of a Work Item without a run. */
  noRunDetail: string
  /** Run text shared with the Work Item's run panel. */
  runs: WorkItemAgentRunsLabels
  /** Report chip text shared with the Work Item discussion. */
  reportChips: AgentRunReportChipsLabels
}

/**
 * Creates the Factory board text for a locale.
 *
 * @param locale - Display locale.
 * @returns Board text.
 */
export function createFactoryBoardLabels(locale: Locale): FactoryBoardLabels {
  const t = createTranslator(locale)
  return {
    summary: t('factoryBoard.summary'),
    refresh: t('factoryBoard.refresh'),
    loading: t('factoryBoard.loading'),
    loadError: t('factoryBoard.loadError'),
    retry: t('factoryBoard.retry'),
    empty: t('factoryBoard.empty'),
    emptyDescription: t('factoryBoard.emptyDescription'),
    noResults: t('factoryBoard.noResults'),
    incomplete: t('factoryBoard.incomplete'),
    filterLabel: t('factoryBoard.filter.label'),
    filterRuntime: t('factoryBoard.filter.runtime'),
    filterAssignee: t('factoryBoard.filter.assignee'),
    filterProject: t('factoryBoard.filter.project'),
    filterAll: t('factoryBoard.filter.all'),
    filterNoProject: t('factoryBoard.filter.noProject'),
    lanes: {
      processing: t('factoryBoard.lane.processing'),
      'no-run': t('factoryBoard.lane.no-run'),
      decision: t('factoryBoard.lane.decision'),
      stalled: t('factoryBoard.lane.stalled'),
      failed: t('factoryBoard.lane.failed'),
      completed: t('factoryBoard.lane.completed'),
    },
    noRunDescription: t('factoryBoard.lane.noRunDescription'),
    laneEmpty: t('factoryBoard.laneEmpty'),
    leaseRemaining: t('factoryBoard.tile.leaseRemaining'),
    leaseExpired: t('factoryBoard.tile.leaseExpired'),
    finishedAt: t('factoryBoard.tile.finishedAt'),
    noReport: t('factoryBoard.tile.noReport'),
    verifications: t('factoryBoard.tile.verifications'),
    detailLabel: t('factoryBoard.detail.label'),
    back: t('factoryBoard.detail.back'),
    detailPlaceholder: t('factoryBoard.detail.placeholder'),
    openWorkItem: t('factoryBoard.detail.openWorkItem'),
    startRevision: t('factoryBoard.detail.startRevision'),
    assignee: t('factoryBoard.detail.assignee'),
    latestReport: t('factoryBoard.detail.latestReport'),
    reports: t('factoryBoard.detail.reports'),
    reportsLoading: t('factoryBoard.detail.reportsLoading'),
    reportsError: t('factoryBoard.detail.reportsError'),
    reportsEmpty: t('factoryBoard.detail.reportsEmpty'),
    reportsTruncated: t('factoryBoard.detail.reportsTruncated'),
    noRunDetail: t('factoryBoard.detail.noRun'),
    runs: createWorkItemAgentRunsLabels(locale),
    reportChips: createAgentRunReportChipsLabels(locale),
  }
}
