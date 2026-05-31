import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { expect, test } from '@jest/globals';
import { CdkStack } from '../lib/cdk-stack';

test('project task data store and lambda API are created', () => {
  const app = new cdk.App();
  const stack = new CdkStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      {
        AttributeName: 'projectId',
        KeyType: 'HASH',
      },
      {
        AttributeName: 'taskId',
        KeyType: 'RANGE',
      },
    ],
  });

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      {
        AttributeName: 'directoryId',
        KeyType: 'HASH',
      },
      {
        AttributeName: 'entryKey',
        KeyType: 'RANGE',
      },
    ],
  });

  template.hasResourceProperties('AWS::Lambda::Function', {
    Environment: {
      Variables: {
        ALLOWED_ORIGINS: {
          Ref: 'TaskApiAllowedOrigins',
        },
        PROJECT_DIRECTORY_TABLE_NAME: {
          Ref: Match.stringLikeRegexp('ProjectDirectoryTable'),
        },
      },
    },
    Handler: 'index.handler',
    Runtime: 'nodejs22.x',
  });

  template.hasResourceProperties('AWS::Lambda::Url', {
    Cors: {
      AllowOrigins: {
        'Fn::Split': [
          ',',
          {
            Ref: 'TaskApiAllowedOrigins',
          },
        ],
      },
    },
  });

  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 'cognito-idp:GetUser',
          Effect: 'Allow',
          Resource: '*',
        }),
      ]),
    },
  });

  const customResources = template.findResources('Custom::AWS');
  const seedResource = Object.values(customResources).find((resource) =>
    JSON.stringify(resource).includes('transactWriteItems'),
  );
  const createJoinParts = seedResource?.Properties?.Create?.['Fn::Join']?.[1] ?? [];
  const seedPayload = createJoinParts
    .filter((part: unknown): part is string => typeof part === 'string')
    .join('');

  expect(seedPayload).toContain('"service":"DynamoDB"');
  expect(seedPayload).toContain('"action":"transactWriteItems"');
  expect(seedPayload.match(/"Put"/g)).toHaveLength(10);
  expect(seedPayload).toContain('"taskId":{"S":"wireframe"}');
  expect(seedPayload).toContain('"taskId":{"S":"landing-release"}');
  expect(seedResource?.Properties?.Update).toBeUndefined();

  const directorySeedResource = Object.values(customResources).find((resource) =>
    JSON.stringify(resource).includes('shared-launch'),
  );
  const directoryCreateJoinParts = directorySeedResource?.Properties?.Create?.['Fn::Join']?.[1] ?? [];
  const directorySeedPayload = directoryCreateJoinParts
    .filter((part: unknown): part is string => typeof part === 'string')
    .join('');

  expect(directorySeedPayload).toContain('"directoryId":{"S":"sidebar"}');
  expect(directorySeedPayload).toContain('"entryKey":{"S":"000010#000000#TEAM#core-team"}');
  expect(directorySeedPayload).toContain('"entryKey":{"S":"000010#000010#PROJECT#refero"}');
  expect(directorySeedPayload).toContain('"teamId":{"S":"core-team"}');
  expect(directorySeedPayload).toContain('"teamId":{"S":"design-team"}');
  expect(directorySeedPayload.match(/"projectId":{"S":"shared-launch"}/g)).toHaveLength(2);
  expect(directorySeedResource?.Properties?.Update).toBeUndefined();

  const lambdaResource = Object.values(template.findResources('AWS::Lambda::Function')).find((resource) =>
    JSON.stringify(resource).includes('isProjectDirectoryRequest'),
  );
  const lambdaCode = lambdaResource?.Properties?.Code?.ZipFile ?? '';

  expect(lambdaCode).toContain('(?:api\\/)?projects\\/([^/]+)\\/tasks');
  expect(lambdaCode).toContain('const projectItems = [];');
});
