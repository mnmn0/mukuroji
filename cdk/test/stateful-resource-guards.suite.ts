/** Registers Lambda log retention and table deletion protection tests. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Template } from 'aws-cdk-lib/assertions';
import { expect, test } from '@jest/globals';
import { createTemplate, synthesizedTemplate } from './test-support';

/** Feature flags from `cdk.json`, including `@aws-cdk/aws-lambda:useCdkManagedLogGroup`. */
const deploymentContext = (
  JSON.parse(readFileSync(join(__dirname, '..', 'cdk.json'), 'utf8')) as {
    context: Record<string, unknown>;
  }
).context;

/** Default-module template synthesized with the deployment feature flags. */
const deploymentTemplate = createTemplate({}, deploymentContext);

/** Longest Lambda log retention allowed; the restore drill keeps its logs for one year. */
const MAX_LAMBDA_LOG_RETENTION_DAYS = 365;

/** CloudFormation resource shape used by the guard assertions. */
interface SynthesizedResource {
  readonly DeletionPolicy?: string;
  readonly Properties?: Record<string, unknown>;
}

/**
 * Finds the log group CDK names `/aws/lambda/<function name>` under `useCdkManagedLogGroup`.
 *
 * @param logGroups - Log groups in the synthesized template.
 * @param functionLogicalId - Logical ID of the Lambda function.
 * @returns Logical ID of the default-named log group, if any.
 */
function findDefaultNamedLogGroupId(
  logGroups: Record<string, SynthesizedResource>,
  functionLogicalId: string,
): string | undefined {
  const functionReference = JSON.stringify({ Ref: functionLogicalId });

  return Object.entries(logGroups).find(([, resource]) => {
    const logGroupName = JSON.stringify(resource.Properties?.LogGroupName ?? '');

    return logGroupName.includes('/aws/lambda/') && logGroupName.includes(functionReference);
  })?.[0];
}

/**
 * Lists Lambda functions whose log group is missing, unretained, or kept too long.
 *
 * @param template - Synthesized template to inspect.
 * @returns Logical IDs of functions that violate the log retention guard.
 */
function findFunctionsWithoutRetainedLogs(template: Template): string[] {
  const logGroups = template.findResources('AWS::Logs::LogGroup') as Record<
    string,
    SynthesizedResource
  >;
  const functions = template.findResources('AWS::Lambda::Function') as Record<
    string,
    SynthesizedResource
  >;

  return Object.entries(functions)
    .filter(([logicalId, resource]) => {
      const loggingConfig = resource.Properties?.LoggingConfig as
        | { LogGroup?: { Ref?: string } }
        | undefined;
      const logGroupId = loggingConfig?.LogGroup?.Ref
        ?? findDefaultNamedLogGroupId(logGroups, logicalId);
      const logGroup = logGroupId === undefined ? undefined : logGroups[logGroupId];

      return logGroup === undefined
        || typeof logGroup.Properties?.RetentionInDays !== 'number'
        || logGroup.Properties.RetentionInDays > MAX_LAMBDA_LOG_RETENTION_DAYS
        || logGroup.DeletionPolicy !== 'Retain';
    })
    .map(([logicalId]) => logicalId);
}

/**
 * Lists retained DynamoDB tables that can still be deleted from the console or CLI.
 *
 * @param template - Synthesized template to inspect.
 * @returns Logical IDs of retained tables without deletion protection.
 */
function findUnprotectedRetainedTables(template: Template): string[] {
  const tables = template.findResources('AWS::DynamoDB::Table') as Record<
    string,
    SynthesizedResource
  >;

  return Object.entries(tables)
    .filter(([, resource]) =>
      resource.DeletionPolicy === 'Retain'
      && resource.Properties?.DeletionProtectionEnabled !== true)
    .map(([logicalId]) => logicalId);
}

test('every Lambda function writes to a retained log group with finite retention', () => {
  expect(findFunctionsWithoutRetainedLogs(synthesizedTemplate)).toEqual([]);
  expect(findFunctionsWithoutRetainedLogs(deploymentTemplate)).toEqual([]);
});

test('no log group keeps logs longer than a year', () => {
  for (const template of [synthesizedTemplate, deploymentTemplate]) {
    const longLived = Object.entries(
      template.findResources('AWS::Logs::LogGroup') as Record<string, SynthesizedResource>,
    )
      .filter(([, resource]) => {
        const retention = resource.Properties?.RetentionInDays;

        return typeof retention !== 'number' || retention > MAX_LAMBDA_LOG_RETENTION_DAYS;
      })
      .map(([logicalId]) => logicalId);

    expect(longLived).toEqual([]);
  }
});

test('functions without an explicit log group keep their logs for 90 days', () => {
  const template = synthesizedTemplate;
  const functions = template.findResources('AWS::Lambda::Function') as Record<
    string,
    SynthesizedResource
  >;
  const loggingConfig = functions.ApiFunctionCE271BD4?.Properties?.LoggingConfig as
    | { LogGroup?: { Ref?: string } }
    | undefined;
  const logGroupId = loggingConfig?.LogGroup?.Ref ?? '';

  expect(logGroupId).toMatch(/^ApiFunctionDefaultLogGroup/);
  expect(template.findResources('AWS::Logs::LogGroup')[logGroupId]).toMatchObject({
    DeletionPolicy: 'Retain',
    Properties: { RetentionInDays: 90 },
  });
});

test('every retained DynamoDB table has deletion protection', () => {
  expect(findUnprotectedRetainedTables(synthesizedTemplate)).toEqual([]);
  expect(findUnprotectedRetainedTables(deploymentTemplate)).toEqual([]);
});
