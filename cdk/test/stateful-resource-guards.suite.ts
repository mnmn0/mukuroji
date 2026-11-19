/** Registers Lambda log retention and table deletion protection tests. */
import type { Template } from 'aws-cdk-lib/assertions';
import { expect, test } from '@jest/globals';
import { createTemplate, synthesizedTemplate } from './test-support';

/** CloudFormation resource shape used by the guard assertions. */
interface SynthesizedResource {
  readonly DeletionPolicy?: string;
  readonly Properties?: Record<string, unknown>;
}

/**
 * Lists Lambda functions whose log group is missing, unretained, or kept forever.
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
    .filter(([, resource]) => {
      const loggingConfig = resource.Properties?.LoggingConfig as
        | { LogGroup?: { Ref?: string } }
        | undefined;
      const logGroupId = loggingConfig?.LogGroup?.Ref;
      const logGroup = logGroupId === undefined ? undefined : logGroups[logGroupId];

      return logGroup === undefined
        || typeof logGroup.Properties?.RetentionInDays !== 'number'
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
  expect(findFunctionsWithoutRetainedLogs(createTemplate({}))).toEqual([]);
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
  expect(findUnprotectedRetainedTables(createTemplate({}))).toEqual([]);
});
