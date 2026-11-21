import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * IAM statement shape the checks below read.
 */
interface Statement {
  /** Statement ID. */
  readonly Sid?: string;
  /** Allow or Deny. */
  readonly Effect: string;
  /** One action or a list of actions. */
  readonly Action: string | readonly string[];
  /** One resource or a list of resources. */
  readonly Resource?: unknown;
  /** Condition block. */
  readonly Condition?: Record<string, Record<string, unknown>>;
  /** Principal block. */
  readonly Principal?: unknown;
}

const templatePath = path.join(__dirname, '../deploy-access/github-deploy-access.template.json');
const template: unknown = JSON.parse(readFileSync(templatePath, 'utf8'));

/**
 * Reads a nested property of the parsed template.
 *
 * @param keys - Property path.
 * @returns The value at the path.
 * @throws Error when a property on the path is missing.
 */
function at(...keys: string[]): unknown {
  let value: unknown = template;
  for (const key of keys) {
    if (typeof value !== 'object' || value === null || !(key in value)) {
      throw new Error(`Template has no ${keys.join('.')}`);
    }
    value = Reflect.get(value, key);
  }
  return value;
}

/**
 * Checks that a value looks like an IAM statement.
 *
 * @param value - Value to check.
 * @returns Whether the value has an Effect and Action.
 */
function isStatement(value: unknown): value is Statement {
  return typeof value === 'object' && value !== null && 'Effect' in value && 'Action' in value;
}

/**
 * Reads a list of statements.
 *
 * @param value - `Statement` array from a policy document.
 * @returns The statements.
 */
function statements(value: unknown): Statement[] {
  if (!Array.isArray(value)) throw new Error('Statement is not an array');
  return value.filter(isStatement);
}

const trust = statements(at('Resources', 'GitHubDeployRole', 'Properties', 'AssumeRolePolicyDocument', 'Statement'));
const policies = at('Resources', 'GitHubDeployRole', 'Properties', 'Policies');
const permissions = Array.isArray(policies)
  ? policies.flatMap((policy: unknown) => {
      if (typeof policy !== 'object' || policy === null) return [];
      const document: unknown = Reflect.get(policy, 'PolicyDocument');
      return typeof document === 'object' && document !== null
        ? statements(Reflect.get(document, 'Statement'))
        : [];
    })
  : [];

/**
 * Lists the actions of a statement.
 *
 * @param statement - Statement to read.
 * @returns Its actions.
 */
function actions(statement: Statement): readonly string[] {
  return typeof statement.Action === 'string' ? [statement.Action] : statement.Action;
}

describe('GitHub deploy access template', () => {
  test('only one repository Environment can assume the role through the GitHub OIDC audience', () => {
    expect(trust).toHaveLength(1);
    const [statement] = trust;
    expect(statement?.Action).toBe('sts:AssumeRoleWithWebIdentity');
    expect(statement?.Condition).toEqual({
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': {
          'Fn::Sub': 'repo:${GitHubRepository}:environment:${GitHubEnvironment}',
        },
      },
    });
    expect(JSON.stringify(statement?.Condition)).not.toContain('StringLike');
    expect(at('Parameters', 'GitHubRepository', 'Default')).toBe('mnmn0/mukuroji');
    expect(at('Parameters', 'GitHubEnvironment', 'Default')).toBe('production');
  });

  test('the role deploys only by assuming the CDK bootstrap roles, not with its own write access to resources', () => {
    const assume = permissions.find((statement) => statement.Sid === 'AssumeCdkBootstrapRoles');
    expect(assume?.Resource).toEqual([
      { 'Fn::Sub': 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cdk-${CdkBootstrapQualifier}-deploy-role-${AWS::AccountId}-${AWS::Region}' },
      { 'Fn::Sub': 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cdk-${CdkBootstrapQualifier}-file-publishing-role-${AWS::AccountId}-${AWS::Region}' },
      { 'Fn::Sub': 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cdk-${CdkBootstrapQualifier}-lookup-role-${AWS::AccountId}-${AWS::Region}' },
    ]);
    const allActions = permissions.filter((statement) => statement.Effect === 'Allow').flatMap(actions);
    expect(allActions.filter((action) => action.includes('*'))).toEqual([]);
    for (const forbidden of ['iam:', 'cloudformation:CreateStack', 'cloudformation:UpdateStack', 'cloudformation:DeleteStack', 'ssm:DeleteParameter']) {
      expect(allActions.filter((action) => action.startsWith(forbidden))).toEqual([]);
    }
  });

  test('no allow statement uses a bare wildcard resource', () => {
    for (const statement of permissions.filter((candidate) => candidate.Effect === 'Allow')) {
      expect(JSON.stringify(statement.Resource)).not.toBe('"*"');
    }
  });

  test('deploy secrets can be created but never overwritten', () => {
    const create = permissions.find((statement) => statement.Sid === 'CreateMissingDeploySecrets');
    expect(create?.Resource).toEqual({
      'Fn::Sub': 'arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter/mukuroji/deploy/secrets/*',
    });
    const deny = permissions.find((statement) => statement.Sid === 'NeverOverwriteDeploySecrets');
    expect(deny?.Effect).toBe('Deny');
    expect(deny?.Action).toBe('ssm:PutParameter');
    expect(deny?.Condition).toEqual({ Bool: { 'ssm:Overwrite': 'true' } });
  });

  test('runtime control changes only AppConfig resources that carry the application tag', () => {
    const write = permissions.find((statement) => statement.Sid === 'SwitchMukurojiRuntimeControl');
    expect(write?.Action).toEqual(['appconfig:CreateHostedConfigurationVersion', 'appconfig:StartDeployment']);
    expect(write?.Condition).toEqual({ StringEquals: { 'aws:ResourceTag/mukuroji:application': 'mukuroji' } });
    const read = permissions.find((statement) => statement.Sid === 'ReadRuntimeControl');
    expect(actions(read ?? { Effect: 'Allow', Action: [] }).every((action) => /^appconfig:(Get|List)/.test(action))).toBe(true);
  });

  test('runtime control may start a deployment with the stack strategy', () => {
    const strategy = permissions.find((statement) => statement.Sid === 'UseRuntimeControlDeploymentStrategy');
    expect(strategy?.Action).toBe('appconfig:StartDeployment');
    expect(strategy?.Resource).toEqual({
      'Fn::Sub': 'arn:${AWS::Partition}:appconfig:${AWS::Region}:${AWS::AccountId}:deploymentstrategy/*',
    });
  });

  test('runtime control may only add audit events to the deployment Workspace partition of the audit table', () => {
    const audit = permissions.find((statement) => statement.Sid === 'RecordRuntimeControlAudit');
    expect(audit?.Action).toBe('dynamodb:PutItem');
    expect(audit?.Resource).toEqual({
      'Fn::Sub': 'arn:${AWS::Partition}:dynamodb:${AWS::Region}:${AWS::AccountId}:table/${MukurojiStackName}-AuditEventsTable*',
    });
    expect(audit?.Condition).toEqual({
      'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [{ Ref: 'WorkspaceDirectoryId' }] },
    });
    const dynamoDbActions = permissions.filter((statement) => statement.Effect === 'Allow').flatMap(actions)
      .filter((action) => action.startsWith('dynamodb:'));
    expect(dynamoDbActions).toEqual(['dynamodb:PutItem']);
  });

  test('alarm topics accept publishes only from CloudWatch alarms in this account', () => {
    const topicPolicy = statements(at('Resources', 'AlarmTopicPolicy', 'Properties', 'PolicyDocument', 'Statement'));
    const allow = topicPolicy.find((statement) => statement.Effect === 'Allow');
    expect(allow?.Principal).toEqual({ Service: 'cloudwatch.amazonaws.com' });
    expect(allow?.Action).toBe('sns:Publish');
    expect(allow?.Condition).toEqual({
      StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } },
      ArnLike: { 'aws:SourceArn': { 'Fn::Sub': 'arn:${AWS::Partition}:cloudwatch:${AWS::Region}:${AWS::AccountId}:alarm:*' } },
    });
  });

  test('writes the configuration names that scripts/github-deploy.ts reads', () => {
    const resources = at('Resources');
    const names = Object.keys(typeof resources === 'object' && resources !== null ? resources : {})
      .filter((logicalId) => at('Resources', logicalId, 'Type') === 'AWS::SSM::Parameter')
      .map((logicalId) => at('Resources', logicalId, 'Properties', 'Name'));
    expect(names.sort()).toEqual([
      '/mukuroji/deploy/config/alarm-primary-topic-name',
      '/mukuroji/deploy/config/alarm-secondary-topic-name',
      '/mukuroji/deploy/config/api-allowed-origins',
      '/mukuroji/deploy/config/initial-owner-email',
      '/mukuroji/deploy/config/workspace-directory-id',
    ]);
  });
});
