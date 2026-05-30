import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
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

  template.hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
    Runtime: 'nodejs22.x',
  });

  template.resourceCountIs('AWS::Lambda::Url', 1);

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
});
