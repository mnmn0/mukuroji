/** Registers tests for the optional modules a deployment creates only on request. */
import { describe, expect, test } from '@jest/globals';
import { Match } from 'aws-cdk-lib/assertions';
import {
  NO_OPTIONAL_MODULES,
  parseOptionalModules,
} from '../lib/config/optional-modules';
import {
  API_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID,
  createTemplate,
  findApiRuntimeConfigurationSource,
} from './test-support';

describe('optional-module context', () => {
  test('creates no optional module when the context is absent, blank, or none', () => {
    expect(parseOptionalModules(undefined)).toEqual(NO_OPTIONAL_MODULES);
    expect(parseOptionalModules('')).toEqual(NO_OPTIONAL_MODULES);
    expect(parseOptionalModules(' none ')).toEqual(NO_OPTIONAL_MODULES);
    expect(parseOptionalModules([])).toEqual(NO_OPTIONAL_MODULES);
  });

  test('reads comma-separated CLI context and cdk.json lists', () => {
    expect(parseOptionalModules('restoreDrill, connectors')).toEqual({
      restoreDrill: true,
      connectors: true,
      requestEmail: false,
    });
    expect(parseOptionalModules(['requestEmail'])).toEqual({
      restoreDrill: false,
      connectors: false,
      requestEmail: true,
    });
  });

  test('rejects unknown names and malformed values instead of dropping a module', () => {
    expect(() => parseOptionalModules('restoreDrill,conectors'))
      .toThrow('Unknown optional module "conectors"');
    expect(() => parseOptionalModules('none,restoreDrill'))
      .toThrow('Unknown optional module "none"');
    expect(() => parseOptionalModules(true))
      .toThrow('must be a comma-separated string or a list of module names');
    expect(() => parseOptionalModules([1]))
      .toThrow('entries must be module names');
  });
});

describe('default deployment without optional modules', () => {
  const template = createTemplate(NO_OPTIONAL_MODULES);
  const json = template.toJSON();
  const resources = json.Resources as Record<string, {
    Type: string;
    Properties?: Record<string, unknown>;
  }>;
  const logicalIds = Object.keys(resources);

  test('creates one KMS key shared by the developer platform', () => {
    template.resourceCountIs('AWS::KMS::Key', 1);
    expect(logicalIds.filter((id) => id.startsWith('DeveloperPlatformKey')))
      .toHaveLength(1);
  });

  test('omits every restore-drill, connector, and request email resource and output', () => {
    for (const prefix of [
      'RestoreDrill',
      'ConnectorSync',
      'ConnectorPoll',
      'ConnectorRuntimeSecret',
      'RequestEmailIngestion',
    ]) {
      expect(logicalIds.filter((id) => id.startsWith(prefix))).toEqual([]);
      expect(Object.keys(json.Outputs).filter((id) => id.startsWith(prefix)))
        .toEqual([]);
    }
  });

  test('declares no parameter that only an omitted module reads', () => {
    for (const parameterName of [
      'ConnectorRuntimeConfiguration',
      'RequestEmailWebhookSecret',
      'RestoreDrillCleanupApproverRoleArn',
    ]) {
      expect(json.Parameters).not.toHaveProperty(parameterName);
    }
  });

  test('turns off the connector projection and loads no connector provider', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          CONNECTOR_SYNC_ENABLED: 'false',
          MUKUROJI_RUNTIME_ROLE: 'audit-projection',
        }),
      },
    });
    const projection = Object.values(resources).find((resource) =>
      resource.Type === 'AWS::Lambda::Function' &&
      JSON.stringify(resource.Properties).includes('"MUKUROJI_RUNTIME_ROLE":"audit-projection"'));
    expect(JSON.stringify(projection)).not.toContain('CONNECTOR_SYNC_QUEUE_URL');

    const configuration = resources[API_RUNTIME_CONFIGURATION_SECRET_LOGICAL_ID];
    expect(findApiRuntimeConfigurationSource(
      configuration.Properties?.SecretString,
      'CONNECTOR_RUNTIME_CONFIGURATION_SECRET_ARN',
    )).toEqual({ 'Fn::Base64': '' });
  });

  test('lets no principal read deleted file versions without the restore drill', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'DeletedObjectsCannotBeRead',
            Condition: {
              StringEquals: { 's3:ExistingObjectTag/mukuroji-deleted': 'true' },
            },
          }),
        ]),
      },
    });
  });
});
