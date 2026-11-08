import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { acknowledgeKnownNagFindings } from '../lib/acknowledge-nag-findings';
import { ALL_STACK_MODULE_PROPS } from '../bin/stack-modules';
import { MukurojiStack } from '../lib/stacks/mukuroji-stack';

const app = new cdk.App({
  context: {
    '@aws-cdk/aws-iam:minimizePolicies': true,
    '@aws-cdk/aws-lambda:createNewPoliciesWithAddToRolePolicy': false,
    '@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy': true,
  },
});
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
// Checks the default stack and the stack with every optional module.
for (const [id, props] of [
  ['NagCheck', {}],
  ['NagCheckAllModules', ALL_STACK_MODULE_PROPS],
] as const) {
  const stack = new MukurojiStack(app, id, props);
  acknowledgeKnownNagFindings(stack);
}
app.synth();
