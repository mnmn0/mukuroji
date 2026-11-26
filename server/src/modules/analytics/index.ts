/** Analytics module public application and domain surface. */
export {
  createAnalyticsScheduleRenderer,
  processAnalyticsSchedule,
  renderInAppAnalyticsArtifact,
  resolveAnalyticsScheduleProcessingTime,
  type AnalyticsScheduleEvent,
} from './adapter-in/schedules/analytics-schedule'
/** Per-Work-Item history rows maintained from the AuditEvents stream (ADR 0042). */
export {
  processAnalyticsWorkItemHistoryProjectionBatch,
  type AnalyticsWorkItemTimeline,
} from './adapter-in/events/analytics-work-item-history-projection'
/** Scheduled delivery notification emitted through the audit outbox. */
export {
  ANALYTICS_REPORT_DELIVERED_EVENT_TYPE,
  createAnalyticsDeliveryAuditNotifier,
} from './adapter-out/dynamodb/analytics-delivery-notifier'
/** Milestone date history read by the `milestone-trend` metric. */
export {
  ANALYTICS_MILESTONE_TREND_FIELDS,
  createAnalyticsMilestoneScopeKey,
  type AnalyticsMilestoneChange,
  type AnalyticsMilestoneFieldChange,
  type AnalyticsMilestoneHistory,
} from './analytics-milestone-trend'
/** Agent Run telemetry usage read by the `agent-tokens` and `agent-cost` metrics (ADR 0061). */
export {
  ANALYTICS_AGENT_USAGE_UNAVAILABLE_WARNING,
  MAX_ANALYTICS_AGENT_USAGE_RUNS,
  analyticsQueryReadsAgentCost,
  analyticsQueryReadsAgentUsage,
  analyticsSnapshotReadAgentCost,
  type AnalyticsAgentUsage,
  type AnalyticsAgentUsageRun,
} from './analytics-agent-usage'
/** Earned value read by the `evm-spi`, `evm-cpi`, and `evm-eac` metrics (ADR 0110). */
export {
  ANALYTICS_EARNED_VALUE_MAX_AS_OF_AGE_MS,
  MAX_ANALYTICS_EARNED_VALUE_PROJECTS,
  analyticsQueryReadsEarnedValue,
  analyticsSnapshotReadEarnedValue,
  createAnalyticsEarnedValueProjectKey,
  type AnalyticsEarnedValue,
  type AnalyticsEarnedValueProject,
} from './analytics-earned-value'
export {
  ANALYTICS_PLANNING_GROUPS_UNAVAILABLE_WARNING,
  MAX_ANALYTICS_RECIPIENT_DELIVERY_PAGE,
  type AnalyticsRecipientDelivery,
  type AnalyticsRecipientDeliveryPage,
  AnalyticsError,
  analyticsFilterIncludesWorkItem,
  analyticsQueryReadsMilestones,
  analyticsQueryReadsPlanningGroups,
  analyticsSnapshotReadPlanningGroups,
  type AnalyticsPlanningGroupEntity,
  type AnalyticsPlanningGroups,
  analyticsSnapshotReadMilestones,
  calculateAnalyticsNextRunAt,
  compareDynamoDbStringSortKeys,
  createAnalyticsCsv,
  createAnalyticsDeliveryRecordKey,
  createAnalyticsEvidenceCursor,
  createAnalyticsNextDeliveryAtRecordKey,
  createAnalyticsPdf,
  createAnalyticsTextPdf,
  createAnalyticsPermissionScopeHash,
  createAnalyticsScheduleShard,
  createAnalyticsSnapshot,
  createAnalyticsSnapshotListCursor,
  normalizeAnalyticsEvidenceInput,
  normalizeAnalyticsExportLocale,
  normalizeAnalyticsQueryInput,
  parseAnalyticsEvidenceCursor,
  queryAnalyticsEvidence,
  validateAnalyticsSnapshotRecordSize,
  DynamoDbAnalyticsRepository,
  type AnalyticsDeliveryReceipt,
  type AnalyticsDeliveryReceiptResult,
  type AnalyticsDueReportPage,
  type AnalyticsDueReportReference,
  type AnalyticsEngineInput,
  type AnalyticsEvidenceEngineInput,
  type AnalyticsReportPage,
  type AnalyticsRepository,
  type AnalyticsSnapshotPage,
} from './analytics'
