import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { acknowledgeKnownNagFindings } from '../lib/acknowledge-nag-findings';
import { CdkStack } from '../lib/cdk-stack';

const app = new cdk.App({
  context: {
    '@aws-cdk/aws-iam:minimizePolicies': true,
    '@aws-cdk/aws-lambda:createNewPoliciesWithAddToRolePolicy': false,
    '@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy': true,
  },
});
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
const stack = new CdkStack(app, 'NagCheck', {
  teamIssueCommentIndexDeploymentStage: 'comment',
  triageIndexDeploymentStage: 'wake',
});
acknowledgeKnownNagFindings(stack);
app.synth();
