import {
  loadServerConfig,
  type ServerEnvironment,
} from './server-config'

/** DynamoDB resource names injected into production adapters. */
export interface ServerDynamoDbResourceConfig {
  /** Analytics report and schedule table name. */
  readonly analyticsTableName: string
  /** Analytics schedule due-date index name. */
  readonly analyticsScheduleIndexName: string
  /** Immutable audit event table name. */
  readonly auditEventsTableName: string
  /** Enterprise Identity control table name. */
  readonly enterpriseIdentityTableName: string
}

/**
 * Resolves DynamoDB resource names from centralized server configuration.
 *
 * @param environment - Optional environment map used by tests or composition.
 * @returns Normalized resource names with stable local fallbacks.
 */
export function loadServerDynamoDbResourceConfig(
  environment: ServerEnvironment = loadServerConfig().environment,
): ServerDynamoDbResourceConfig {
  return Object.freeze({
    analyticsTableName:
      environment.ANALYTICS_TABLE_NAME ?? 'mukuroji-analytics',
    analyticsScheduleIndexName:
      environment.ANALYTICS_SCHEDULE_INDEX_NAME ?? 'ScheduleDueIndex',
    auditEventsTableName:
      environment.AUDIT_EVENTS_TABLE_NAME ?? 'mukuroji-audit-events',
    enterpriseIdentityTableName:
      environment.ENTERPRISE_IDENTITY_TABLE_NAME ??
        'mukuroji-enterprise-identity',
  })
}
