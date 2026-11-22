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
export {
  AnalyticsError,
  analyticsFilterIncludesWorkItem,
  analyticsQueryReadsMilestones,
  analyticsSnapshotReadMilestones,
  calculateAnalyticsNextRunAt,
  compareDynamoDbStringSortKeys,
  createAnalyticsCsv,
  createAnalyticsDeliveryRecordKey,
  createAnalyticsEvidenceCursor,
  createAnalyticsNextDeliveryAtRecordKey,
  createAnalyticsPdf,
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
