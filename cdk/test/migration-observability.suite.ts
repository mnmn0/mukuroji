/** Registers Workspace Search migration observability tests. */
import { expect, test } from '@jest/globals';
import { synthesizedTemplate } from './test-support';

/**
 * Narrows synthesized CloudFormation fragments before semantic inspection.
 *
 * @param value Untrusted synthesized value.
 * @returns Whether the value is a string-keyed record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Finds exactly one synthesized alarm by stable logical-ID prefix.
 *
 * @param logicalIdPrefix Stable construct-derived logical-ID prefix.
 * @returns Matching synthesized alarm resource.
 */
function findAlarm(logicalIdPrefix: string): Record<string, unknown> {
  const matches = Object.entries(
    synthesizedTemplate.findResources('AWS::CloudWatch::Alarm'),
  ).filter(([logicalId]) => logicalId.startsWith(logicalIdPrefix));
  expect(matches).toHaveLength(1);
  const match = matches[0];
  if (!match || !isRecord(match[1])) {
    throw new Error(`${logicalIdPrefix} was not synthesized exactly once.`);
  }
  return match[1];
}

/**
 * Reads one required nested record property.
 *
 * @param owner Synthesized record containing the property.
 * @param propertyName Required property name.
 * @returns Narrowed nested record.
 */
function requiredRecord(
  owner: Record<string, unknown>,
  propertyName: string,
): Record<string, unknown> {
  const value = owner[propertyName];
  if (!isRecord(value)) {
    throw new Error(`${propertyName} is not a synthesized object.`);
  }
  return value;
}

test('Workspace Search migration alarms cover rate, progress, quarantine, and terminal failure', () => {
  const alarmContracts = Object.freeze([
    Object.freeze({
      logicalIdPrefix: 'WorkspaceSearchMigrationDescribeTableThrottleAlarm',
      metricName: 'DescribeTableThrottleCount',
    }),
    Object.freeze({
      logicalIdPrefix: 'WorkspaceSearchMigrationDescribeTableBudgetStopAlarm',
      metricName: 'DescribeTableBudgetStopCount',
    }),
    Object.freeze({
      logicalIdPrefix: 'WorkspaceSearchMigrationRateBudgetExhaustionAlarm',
      metricName: 'DescribeTableBudgetExhaustionCount',
    }),
    Object.freeze({
      logicalIdPrefix: 'WorkspaceSearchMigrationCheckpointStallAlarm',
      metricName: 'CheckpointStallCount',
    }),
    Object.freeze({
      logicalIdPrefix: 'WorkspaceSearchMigrationQuarantineAlarm',
      metricName: 'QuarantineCount',
    }),
    Object.freeze({
      logicalIdPrefix: 'WorkspaceSearchMigrationTerminalFailureAlarm',
      metricName: 'TerminalFailureCount',
    }),
  ]);

  for (const contract of alarmContracts) {
    const properties = requiredRecord(
      findAlarm(contract.logicalIdPrefix),
      'Properties',
    );
    expect(properties).toEqual(expect.objectContaining({
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      DatapointsToAlarm: 1,
      EvaluationPeriods: 1,
      MetricName: contract.metricName,
      Namespace: 'Mukuroji/WorkspaceSearchMigration',
      Period: 300,
      Statistic: 'Sum',
      Threshold: 1,
      TreatMissingData: 'notBreaching',
      Unit: 'Count',
    }));
    expect(properties.Dimensions).toEqual([
      { Name: 'Service', Value: 'mukuroji-workspace-search-migration' },
    ]);
  }
});
