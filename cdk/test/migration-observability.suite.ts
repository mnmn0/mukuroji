/** Registers regression coverage for retired Workspace Search migration alarms. */
import { expect, test } from '@jest/globals';
import { synthesizedTemplate } from './test-support';

test('does not synthesize retired Workspace Search migration alarms', () => {
  const retiredAlarmPrefixes = [
    'WorkspaceSearchMigrationDescribeTableThrottleAlarm',
    'WorkspaceSearchMigrationDescribeTableBudgetStopAlarm',
    'WorkspaceSearchMigrationRateBudgetExhaustionAlarm',
    'WorkspaceSearchMigrationCheckpointStallAlarm',
    'WorkspaceSearchMigrationQuarantineAlarm',
    'WorkspaceSearchMigrationTerminalFailureAlarm',
  ];
  const alarmLogicalIds = Object.keys(
    synthesizedTemplate.findResources('AWS::CloudWatch::Alarm'),
  );

  expect(alarmLogicalIds.filter((logicalId) =>
    retiredAlarmPrefixes.some((prefix) => logicalId.startsWith(prefix))
  )).toEqual([]);
  expect(JSON.stringify(synthesizedTemplate.toJSON()))
    .not.toContain('Mukuroji/WorkspaceSearchMigration');
});
