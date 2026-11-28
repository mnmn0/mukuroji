import type {
  AgentRunActivity,
  AgentRunRuntime,
  AgentRunUsage,
  AgentToolActivity,
  FactoryAnalyticsPullRequestInterval,
  FactoryAnalyticsStage,
  FactoryBoardLane,
  WorkItemSizeBand,
  WorkspaceWorkPhaseSettings,
} from '@mukuroji/contracts'
import type { FactoryLineStation } from '../model/factoryLine'
import { createTranslator, type Locale } from '../../../shared/i18n/i18n'
import { createWorkItemAgentRunsLabels, type WorkItemAgentRunsLabels } from '../../../work-items/ui/agentRunLabels'
import { createAgentRunReportChipsLabels, type AgentRunReportChipsLabels } from '../../../work-items/ui/agentRunReportLabels'
import { readWorkPhaseDisplayName } from '../../../workspace/model/workPhases'

/** Locale-aware text of the line view of the Factory board. */
export type FactoryLineLabels = {
  /** Accessible name of the line scene. */
  sceneLabel: string
  /** Scene description with a `{summary}` placeholder for the station counts. */
  sceneSummary: string
  /** Accessible name of the station bar. */
  stepBar: string
  /** Action that shows the whole line. */
  overview: string
  /** Action that starts going through the stations. */
  play: string
  /** Action that stops going through the stations. */
  pause: string
  /** Item count with a `{count}` placeholder. */
  count: string
  /** Count of items not drawn with a `{count}` placeholder. */
  more: string
  /** Marker of a stalled run. */
  stalled: string
  /** Text of an item no agent has picked up. */
  noAgent: string
  /** Text of a station without items. */
  empty: string
  /** Heading of the panel when no station is chosen. */
  overviewTitle: string
  /** Explanation of the panel when no station is chosen. */
  overviewDescription: string
  /** Action that returns from a task's detail to its station. */
  backToStation: string
  /** Station names. */
  stations: Record<FactoryLineStation, string>
  /** What each station holds. */
  stationDescriptions: Record<FactoryLineStation, string>
}

/** Locale-aware text of the Factory board. */
export type FactoryBoardLabels = {
  /** Accessible name of the view switch. */
  viewLabel: string
  /** Name of the lane view. */
  viewLanes: string
  /** Name of the line view. */
  viewLine: string
  /** Text of the line view. */
  line: FactoryLineLabels
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
  /** Action that reads the rest of the sources that reached a read bound. */
  loadMore: string
  /** Text of the load-more action while it reads. */
  loadingMore: string
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
    viewLabel: t('factoryBoard.view.label'),
    viewLanes: t('factoryBoard.view.lanes'),
    viewLine: t('factoryBoard.view.line'),
    line: {
      sceneLabel: t('factoryBoard.line.sceneLabel'),
      sceneSummary: t('factoryBoard.line.sceneSummary'),
      stepBar: t('factoryBoard.line.stepBar'),
      overview: t('factoryBoard.line.overview'),
      play: t('factoryBoard.line.play'),
      pause: t('factoryBoard.line.pause'),
      count: t('factoryBoard.line.count'),
      more: t('factoryBoard.line.more'),
      stalled: t('factoryBoard.line.stalled'),
      noAgent: t('factoryBoard.line.noAgent'),
      empty: t('factoryBoard.line.empty'),
      overviewTitle: t('factoryBoard.line.overviewTitle'),
      overviewDescription: t('factoryBoard.line.overviewDescription'),
      backToStation: t('factoryBoard.line.backToStation'),
      stations: {
        intake: t('factoryBoard.line.station.intake'),
        build: t('factoryBoard.line.station.build'),
        verify: t('factoryBoard.line.station.verify'),
        artifact: t('factoryBoard.line.station.artifact'),
        decision: t('factoryBoard.line.station.decision'),
        done: t('factoryBoard.line.station.done'),
        repair: t('factoryBoard.line.station.repair'),
      },
      stationDescriptions: {
        intake: t('factoryBoard.line.stationDescription.intake'),
        build: t('factoryBoard.line.stationDescription.build'),
        verify: t('factoryBoard.line.stationDescription.verify'),
        artifact: t('factoryBoard.line.stationDescription.artifact'),
        decision: t('factoryBoard.line.stationDescription.decision'),
        done: t('factoryBoard.line.stationDescription.done'),
        repair: t('factoryBoard.line.stationDescription.repair'),
      },
    },
    summary: t('factoryBoard.summary'),
    refresh: t('factoryBoard.refresh'),
    loading: t('factoryBoard.loading'),
    loadError: t('factoryBoard.loadError'),
    retry: t('factoryBoard.retry'),
    empty: t('factoryBoard.empty'),
    emptyDescription: t('factoryBoard.emptyDescription'),
    noResults: t('factoryBoard.noResults'),
    incomplete: t('factoryBoard.incomplete'),
    loadMore: t('factoryBoard.loadMore'),
    loadingMore: t('factoryBoard.loadingMore'),
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

/** Locale-aware text of the Factory analytics summary. */
export type FactoryAnalyticsLabels = {
  /** Heading of the summary. */
  title: string
  /** Explanation under the heading. */
  description: string
  /** Label of the period select. */
  period: string
  /** Period choice with a `{days}` placeholder. */
  periodDays: string
  /** Initial loading text. */
  loading: string
  /** Loading failure text. */
  loadError: string
  /** Retry action. */
  retry: string
  /** Text shown when no run finished in the period. */
  empty: string
  /** Notice shown when the server reached a read bound. */
  incomplete: string
  /** Success rate heading. */
  successRate: string
  /** Success rate detail with `{completed}` and `{total}` placeholders. */
  successRateDetail: string
  /** Rework rate heading. */
  reworkRate: string
  /** Rework rate detail with a `{count}` placeholder. */
  reworkRateDetail: string
  /** Intervention heading. */
  interventions: string
  /** Intervention detail with `{released}` and `{superseded}` placeholders. */
  interventionsDetail: string
  /** Finished run heading. */
  finishedRuns: string
  /** Finished run detail with `{failed}` and `{paused}` placeholders. */
  finishedRunsDetail: string
  /** Text of a value that cannot be calculated. */
  notAvailable: string
  /** Percentage with a `{value}` placeholder. */
  percent: string
  /** Heading of the station dwell times. */
  stageHeading: string
  /** Hours with an `{hours}` placeholder. */
  stageHours: string
  /** Sample count with a `{count}` placeholder. */
  stageSamples: string
  /** Station names. */
  stages: Record<FactoryAnalyticsStage, string>
  /** Heading of the runtime table. */
  runtimeHeading: string
  /** Runtime column. */
  runtimeColumn: string
  /** Finished run column. */
  runsColumn: string
  /** Success rate column. */
  successColumn: string
  /** Rework rate column. */
  reworkColumn: string
  /** Intervention column. */
  interventionsColumn: string
  /** Display names of runtimes. */
  runtimes: Record<AgentRunRuntime, string>
  /** Heading of the token usage part. */
  usageHeading: string
  /** Explanation of where usage comes from and who sees the cost. */
  usageHint: string
  /** Notice shown when runs or buckets were left out of the usage. */
  usagePartial: string
  /** Heading of the usage per Project. */
  usageProjectsHeading: string
  /** Name of the group of Work Items without a Project. */
  usageNoProject: string
  /** Heading of the Work Items with the most tokens. */
  usageWorkItemsHeading: string
  /** Heading of the usage per work phase. */
  usagePhasesHeading: string
  /** Shown when the Workspace phase names could not be read. */
  workPhasesLoadError: string
  /** Button that reads the Workspace phase names again. */
  retryWorkPhases: string
  /**
   * Names a work phase of the usage per phase.
   * @param phaseKey - Phase key, or the group of runs without a phase.
   * @param settings - Workspace work phases, when loaded.
   * @returns Display name.
   */
  phaseName: (phaseKey: string, settings: WorkspaceWorkPhaseSettings | undefined) => string
  /** Heading of the pull request intervals. */
  pullRequestHeading: string
  /** Explanation of which pull requests the intervals count. */
  pullRequestHint: string
  /** Sample count with a `{count}` placeholder. */
  pullRequestSamples: string
  /** Names of the pull request intervals. */
  pullRequestIntervals: Record<FactoryAnalyticsPullRequestInterval, string>
  /**
   * Describes total tokens and, for managers, the estimated cost.
   * @param usage - Usage to describe.
   * @returns Short text.
   */
  formatUsageCompact: (usage: AgentRunUsage) => string
  /**
   * Describes the four token counts.
   * @param usage - Usage to describe.
   * @returns Token breakdown.
   */
  formatUsageTokens: (usage: AgentRunUsage) => string
  /**
   * Describes the request count and, for managers, the estimated cost.
   * @param usage - Usage to describe.
   * @returns Detail text.
   */
  formatUsageDetail: (usage: AgentRunUsage) => string
  /** Heading of the time breakdown. */
  activityHeading: string
  /** Explanation of the time breakdown. */
  activityHint: string
  /** Share of agent working time, with `{value}`. */
  activityShare: string
  /** Heading of the tools with the longest time. */
  activityTopTools: string
  /** Heading of the comparison. */
  comparisonHeading: string
  /** Explanation of the comparison. */
  comparisonHint: string
  /** Label of the comparison axis selector. */
  comparisonAxis: string
  /** Option of the size axis. */
  comparisonAxisSize: string
  /** Shown in place of the axis selector when the custom fields could not be read. */
  comparisonFieldsError: string
  /** Names the group of Work Items that have no value in the compared custom field. */
  comparisonNoValue: string
  /** Button that goes back to comparing by estimate size after a custom-field comparison failed to load. */
  comparisonBackToSize: string
  /** Heading of the comparison groups. */
  comparisonGroups: string
  /** Heading of the outliers. */
  comparisonOutliers: string
  /** Text shown when no Work Item is an outlier. */
  comparisonNoOutliers: string
  /** Note on Work Items without a value, with `{count}`. */
  comparisonUnsized: string
  /** Group line with `{type}`, `{value}`, `{count}`, `{minutes}`, and `{tokens}`. */
  comparisonGroupLine: string
  /** Outlier line with `{ratio}`, `{minutes}`, `{tokens}`, `{runs}`, and `{rework}`. */
  comparisonOutlierLine: string
  /** Outlier time line with `{ai}`, `{tools}`, and `{wait}`. */
  comparisonOutlierTime: string
  /** Name of the group of Work Items without a type. */
  comparisonNoType: string
  /** Display names of size bands. */
  sizeBands: Record<WorkItemSizeBand, string>
  /**
   * Describes model, tool, and wait time.
   * @param aiDurationMs - Milliseconds of model requests.
   * @param activity - Tool time and waits, when present.
   * @returns Breakdown text.
   */
  formatActivityBreakdown: (aiDurationMs: number, activity: AgentRunActivity | undefined) => string
  /**
   * Describes one tool's time.
   * @param tool - Tool.
   * @returns Tool text.
   */
  formatTool: (tool: AgentToolActivity) => string
  /**
   * Formats an elapsed time.
   * @param milliseconds - Elapsed milliseconds.
   * @returns Duration text.
   */
  formatDuration: (milliseconds: number) => string
}

/**
 * Creates the Factory analytics summary text for a locale.
 *
 * @param locale - Display locale.
 * @returns Summary text.
 */
export function createFactoryAnalyticsLabels(locale: Locale): FactoryAnalyticsLabels {
  const t = createTranslator(locale)
  const runLabels = createWorkItemAgentRunsLabels(locale)
  return {
    title: t('factoryBoard.analytics.title'),
    description: t('factoryBoard.analytics.description'),
    period: t('factoryBoard.analytics.period'),
    periodDays: t('factoryBoard.analytics.periodDays'),
    loading: t('factoryBoard.analytics.loading'),
    loadError: t('factoryBoard.analytics.loadError'),
    retry: t('factoryBoard.retry'),
    empty: t('factoryBoard.analytics.empty'),
    incomplete: t('factoryBoard.analytics.incomplete'),
    successRate: t('factoryBoard.analytics.successRate'),
    successRateDetail: t('factoryBoard.analytics.successRateDetail'),
    reworkRate: t('factoryBoard.analytics.reworkRate'),
    reworkRateDetail: t('factoryBoard.analytics.reworkRateDetail'),
    interventions: t('factoryBoard.analytics.interventions'),
    interventionsDetail: t('factoryBoard.analytics.interventionsDetail'),
    finishedRuns: t('factoryBoard.analytics.finishedRuns'),
    finishedRunsDetail: t('factoryBoard.analytics.finishedRunsDetail'),
    notAvailable: t('factoryBoard.analytics.notAvailable'),
    percent: t('factoryBoard.analytics.percent'),
    stageHeading: t('factoryBoard.analytics.stageHeading'),
    stageHours: t('factoryBoard.analytics.stageHours'),
    stageSamples: t('factoryBoard.analytics.stageSamples'),
    stages: {
      build: t('factoryBoard.line.station.build'),
      verify: t('factoryBoard.line.station.verify'),
      artifact: t('factoryBoard.line.station.artifact'),
      decision: t('factoryBoard.line.station.decision'),
    },
    runtimeHeading: t('factoryBoard.analytics.runtimeHeading'),
    runtimeColumn: t('factoryBoard.analytics.runtimeColumn'),
    runsColumn: t('factoryBoard.analytics.runsColumn'),
    successColumn: t('factoryBoard.analytics.successColumn'),
    reworkColumn: t('factoryBoard.analytics.reworkColumn'),
    interventionsColumn: t('factoryBoard.analytics.interventionsColumn'),
    runtimes: runLabels.runtimes,
    usageHeading: t('factoryBoard.analytics.usageHeading'),
    usageHint: t('factoryBoard.analytics.usageHint'),
    usagePartial: t('factoryBoard.analytics.usagePartial'),
    usageProjectsHeading: t('factoryBoard.analytics.usageProjectsHeading'),
    usageNoProject: t('factoryBoard.analytics.usageNoProject'),
    usageWorkItemsHeading: t('factoryBoard.analytics.usageWorkItemsHeading'),
    usagePhasesHeading: t('factoryBoard.analytics.usagePhasesHeading'),
    workPhasesLoadError: t('factoryBoard.analytics.workPhasesLoadError'),
    retryWorkPhases: t('factoryBoard.analytics.retryWorkPhases'),
    phaseName: (phaseKey, settings) => readWorkPhaseDisplayName(phaseKey, settings, t),
    pullRequestHeading: t('factoryBoard.analytics.pullRequestHeading'),
    pullRequestHint: t('factoryBoard.analytics.pullRequestHint'),
    pullRequestSamples: t('factoryBoard.analytics.pullRequestSamples'),
    pullRequestIntervals: {
      'review-wait': t('factoryBoard.analytics.pullRequestInterval.reviewWait'),
      review: t('factoryBoard.analytics.pullRequestInterval.review'),
      'merge-wait': t('factoryBoard.analytics.pullRequestInterval.mergeWait'),
      total: t('factoryBoard.analytics.pullRequestInterval.total'),
    },
    formatUsageCompact: runLabels.formatUsageCompact,
    formatUsageTokens: runLabels.formatUsageTokens,
    formatUsageDetail: runLabels.formatUsageDetail,
    activityHeading: t('factoryBoard.analytics.activityHeading'),
    activityHint: t('factoryBoard.analytics.activityHint'),
    activityShare: t('factoryBoard.analytics.activityShare'),
    activityTopTools: t('factoryBoard.analytics.activityTopTools'),
    comparisonHeading: t('factoryBoard.analytics.comparisonHeading'),
    comparisonHint: t('factoryBoard.analytics.comparisonHint'),
    comparisonAxis: t('factoryBoard.analytics.comparisonAxis'),
    comparisonAxisSize: t('factoryBoard.analytics.comparisonAxisSize'),
    comparisonFieldsError: t('factoryBoard.analytics.comparisonFieldsError'),
    comparisonNoValue: t('factoryBoard.analytics.comparisonNoValue'),
    comparisonBackToSize: t('factoryBoard.analytics.comparisonBackToSize'),
    comparisonGroups: t('factoryBoard.analytics.comparisonGroups'),
    comparisonOutliers: t('factoryBoard.analytics.comparisonOutliers'),
    comparisonNoOutliers: t('factoryBoard.analytics.comparisonNoOutliers'),
    comparisonUnsized: t('factoryBoard.analytics.comparisonUnsized'),
    comparisonGroupLine: t('factoryBoard.analytics.comparisonGroupLine'),
    comparisonOutlierLine: t('factoryBoard.analytics.comparisonOutlierLine'),
    comparisonOutlierTime: t('factoryBoard.analytics.comparisonOutlierTime'),
    comparisonNoType: t('factoryBoard.analytics.comparisonNoType'),
    sizeBands: {
      'up-to-2h': t('factoryBoard.analytics.sizeBand.up-to-2h'),
      'up-to-1d': t('factoryBoard.analytics.sizeBand.up-to-1d'),
      'up-to-3d': t('factoryBoard.analytics.sizeBand.up-to-3d'),
      'over-3d': t('factoryBoard.analytics.sizeBand.over-3d'),
      none: t('factoryBoard.analytics.sizeBand.none'),
    },
    formatActivityBreakdown: runLabels.formatActivityBreakdown,
    formatTool: runLabels.formatTool,
    formatDuration: runLabels.formatDuration,
  }
}
