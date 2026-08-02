import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';

/** CloudWatch namespace shared with secret-free migration EMF records. */
const migrationMetricNamespace = 'Mukuroji/WorkspaceSearchMigration';

/** Sole low-cardinality identity used by migration metric series. */
const migrationMetricService = 'mukuroji-workspace-search-migration';

/** Stable identifier used to bind one migration alarm to rehearsal evidence. */
export type MigrationAlarmEvidenceName =
  | 'throttle'
  | 'budget-stop'
  | 'budget-exhaustion'
  | 'checkpoint-stall'
  | 'quarantine'
  | 'terminal-failure';

/** One migration alarm and its identifier-free rehearsal evidence label. */
export type MigrationAlarmEvidenceResource = {
  /** Stable identifier-free label shared with the rehearsal evidence contract. */
  readonly name: MigrationAlarmEvidenceName;
  /** Concrete CloudWatch alarm whose real notifications must be observed. */
  readonly alarm: cloudwatch.Alarm;
};

/** Complete migration alarm set consumed by the non-production evidence sink. */
export type MigrationObservabilityResources = {
  /** Six migration alarms in canonical rehearsal evidence order. */
  readonly alarms: readonly MigrationAlarmEvidenceResource[];
};

/**
 * Creates one low-cardinality Workspace Search migration metric.
 *
 * @param metricName Exact metric name emitted by migration telemetry.
 * @returns Five-minute sum scoped only to the migration service identity.
 */
function workspaceSearchMigrationMetric(
  metricName: string,
): cloudwatch.Metric {
  return new cloudwatch.Metric({
    dimensionsMap: { Service: migrationMetricService },
    metricName,
    namespace: migrationMetricNamespace,
    period: cdk.Duration.minutes(5),
    statistic: 'Sum',
    unit: cloudwatch.Unit.COUNT,
  });
}

/**
 * Creates operational alarms for secret-free Workspace Search migration telemetry.
 *
 * Primary and secondary notification actions are attached later by the stack-wide
 * alarm-routing aspect. Missing telemetry remains distinct from a reported failure
 * and therefore does not breach these event-count alarms.
 *
 * @param scope Stack that owns the migration alarms.
 * @returns The complete alarm set for optional non-production evidence wiring.
 */
export function buildMigrationObservability(
  scope: cdk.Stack,
): MigrationObservabilityResources {
  const throttleAlarm = new cloudwatch.Alarm(
    scope,
    'WorkspaceSearchMigrationDescribeTableThrottleAlarm',
    {
      alarmDescription:
        'Detects a throttled rate-managed DescribeTable attempt during a Workspace Search migration.',
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: workspaceSearchMigrationMetric('DescribeTableThrottleCount'),
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    },
  );
  const budgetStopAlarm = new cloudwatch.Alarm(
    scope,
    'WorkspaceSearchMigrationDescribeTableBudgetStopAlarm',
    {
      alarmDescription:
        'Detects any fail-closed DescribeTable budget stop during a Workspace Search migration.',
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: workspaceSearchMigrationMetric('DescribeTableBudgetStopCount'),
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    },
  );
  const budgetExhaustionAlarm = new cloudwatch.Alarm(
    scope,
    'WorkspaceSearchMigrationRateBudgetExhaustionAlarm',
    {
      alarmDescription:
        'Detects exhaustion of reviewed DescribeTable admission capacity during a Workspace Search migration.',
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: workspaceSearchMigrationMetric(
        'DescribeTableBudgetExhaustionCount',
      ),
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    },
  );
  const checkpointStallAlarm = new cloudwatch.Alarm(
    scope,
    'WorkspaceSearchMigrationCheckpointStallAlarm',
    {
      alarmDescription:
        'Detects Workspace Search migration checkpoint progress that exceeded the reviewed stall boundary.',
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: workspaceSearchMigrationMetric('CheckpointStallCount'),
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    },
  );
  const quarantineAlarm = new cloudwatch.Alarm(
    scope,
    'WorkspaceSearchMigrationQuarantineAlarm',
    {
      alarmDescription:
        'Detects a quarantined Workspace Search migration session requiring evidence review before resumption.',
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: workspaceSearchMigrationMetric('QuarantineCount'),
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    },
  );
  const terminalFailureAlarm = new cloudwatch.Alarm(
    scope,
    'WorkspaceSearchMigrationTerminalFailureAlarm',
    {
      alarmDescription:
        'Detects a terminal Workspace Search migration command failure requiring evidence review and remediation.',
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      datapointsToAlarm: 1,
      evaluationPeriods: 1,
      metric: workspaceSearchMigrationMetric('TerminalFailureCount'),
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    },
  );

  return {
    alarms: [
      { name: 'throttle', alarm: throttleAlarm },
      { name: 'budget-stop', alarm: budgetStopAlarm },
      { name: 'budget-exhaustion', alarm: budgetExhaustionAlarm },
      { name: 'checkpoint-stall', alarm: checkpointStallAlarm },
      { name: 'quarantine', alarm: quarantineAlarm },
      { name: 'terminal-failure', alarm: terminalFailureAlarm },
    ],
  };
}
