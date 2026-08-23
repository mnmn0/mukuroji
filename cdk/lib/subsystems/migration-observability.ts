import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';

/** CloudWatch namespace shared with secret-free migration EMF records. */
const migrationMetricNamespace = 'Mukuroji/WorkspaceSearchMigration';

/** Sole low-cardinality identity used by migration metric series. */
const migrationMetricService = 'mukuroji-workspace-search-migration';

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
 * @returns Nothing.
 */
export function buildMigrationObservability(
  scope: cdk.Stack,
): void {
  new cloudwatch.Alarm(
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
  new cloudwatch.Alarm(
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
  new cloudwatch.Alarm(
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
  new cloudwatch.Alarm(
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
  new cloudwatch.Alarm(
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
  new cloudwatch.Alarm(
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
}
