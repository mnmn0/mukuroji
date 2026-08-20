import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { expect, test } from '@jest/globals';
import {
  requireTriageIndexDeploymentStage,
  resolveTriageIndexDeploymentStage,
  triageIndexDeploymentIncludes,
  type TriageIndexDeploymentStage,
} from '../lib/config/triage-index-deployment';
import { buildDataStores } from '../lib/subsystems/data-stores';

/**
 * Narrows one synthesized CloudFormation value to a string-keyed record.
 *
 * @param value - Candidate synthesized value.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Synthesizes only the data stores at one reviewed Triage index rollout stage.
 *
 * @param stage - Stage whose Request Intake indexes should be inspected.
 * @returns Global secondary index names synthesized for RequestIntakeTable.
 */
function synthesizeRequestIntakeIndexNames(
  stage: TriageIndexDeploymentStage,
): string[] {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, `TriageIndex${stage}`);
  const connectorRuntimeConfiguration = new cdk.CfnParameter(
    stack,
    'ConnectorRuntimeConfiguration',
    { noEcho: true, type: 'String' },
  );
  const stores = buildDataStores(stack, {
    connectorRuntimeConfiguration,
    teamIssueCommentIndexDeploymentStage: 'comment',
    triageIndexDeploymentStage: stage,
  });
  const requestTableResource = stores.requestIntakeTable.node.defaultChild;
  if (!(requestTableResource instanceof cdk.CfnResource)) {
    throw new Error('Request Intake table resource was not synthesized.');
  }
  const requestTableLogicalId = stack.getLogicalId(
    requestTableResource,
  );
  const document: unknown = Template.fromStack(stack).toJSON();
  if (!isRecord(document) || !isRecord(document.Resources)) {
    throw new Error('Data-store template was not synthesized.');
  }
  const table = document.Resources[requestTableLogicalId];
  if (!isRecord(table) || !isRecord(table.Properties)) {
    throw new Error('Request Intake table definition was not synthesized.');
  }
  const indexes = table.Properties.GlobalSecondaryIndexes;
  if (!Array.isArray(indexes)) return [];
  return indexes.flatMap((index) =>
    isRecord(index) && typeof index.IndexName === 'string'
      ? [index.IndexName]
      : []
  );
}

test('defaults to a single deploy-safe Triage index addition', () => {
  const stage = resolveTriageIndexDeploymentStage(undefined);

  expect(stage).toBe('team');
  expect(triageIndexDeploymentIncludes(stage, 'team')).toBe(true);
  expect(triageIndexDeploymentIncludes(stage, 'owner')).toBe(false);
  expect(triageIndexDeploymentIncludes(stage, 'wake')).toBe(false);
  expect(synthesizeRequestIntakeIndexNames(stage)).toEqual([
    'RequestQueueIndex',
    'triage-team-activity-index',
  ]);
});

test('adds exactly one Triage GSI at each reviewed rollout stage', () => {
  const teamIndexes = synthesizeRequestIntakeIndexNames('team');
  const ownerIndexes = synthesizeRequestIntakeIndexNames('owner');
  const wakeIndexes = synthesizeRequestIntakeIndexNames('wake');

  expect(ownerIndexes.filter((index) => !teamIndexes.includes(index))).toEqual([
    'triage-owner-activity-index',
  ]);
  expect(wakeIndexes.filter((index) => !ownerIndexes.includes(index))).toEqual([
    'triage-wake-index',
  ]);
});

test('rejects unreviewed Triage index rollout context values', () => {
  expect(() => requireTriageIndexDeploymentStage(undefined)).toThrow(
    'triageIndexDeploymentStage context is required to prevent an accidental Triage GSI rollback.',
  );
  expect(() => resolveTriageIndexDeploymentStage('all')).toThrow(
    'triageIndexDeploymentStage must be one of team, owner, or wake.',
  );
  expect(() => resolveTriageIndexDeploymentStage(3)).toThrow(
    'triageIndexDeploymentStage must be one of team, owner, or wake.',
  );
});
