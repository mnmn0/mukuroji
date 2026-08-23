#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { acknowledgeKnownNagFindings } from '../lib/acknowledge-nag-findings';
import { CdkStack } from '../lib/cdk-stack';
import {
  requireTriageIndexDeploymentStage,
} from '../lib/config/triage-index-deployment';
import {
  requireTeamIssueCommentIndexDeploymentStage,
} from '../lib/config/team-issue-comment-index-deployment';

const app = new cdk.App();
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
const triageIndexDeploymentStageContext = app.node.tryGetContext(
  'triageIndexDeploymentStage',
);
const triageIndexDeploymentStage = requireTriageIndexDeploymentStage(
  triageIndexDeploymentStageContext,
);
const teamIssueCommentIndexDeploymentStageContext = app.node.tryGetContext(
  'teamIssueCommentIndexDeploymentStage',
);
const teamIssueCommentIndexDeploymentStage = requireTeamIssueCommentIndexDeploymentStage(
  teamIssueCommentIndexDeploymentStageContext,
);
// oxlint-disable-next-line awscdk/no-construct-stack-suffix -- Existing stack ID is part of the deployed resource identity.
const stack = new CdkStack(app, 'CdkStack', {
  /* If you don't specify 'env', this stack will be environment-agnostic.
   * Account/Region-dependent features and context lookups will not work,
   * but a single synthesized template can be deployed anywhere. */

  /* Uncomment the next line to specialize this stack for the AWS Account
   * and Region that are implied by the current CLI configuration. */
  // env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },

  /* Uncomment the next line if you know exactly what Account and Region you
   * want to deploy the stack to. */
  // env: { account: '123456789012', region: 'us-east-1' },

  /* For more information, see https://docs.aws.amazon.com/cdk/latest/guide/environments.html */
  triageIndexDeploymentStage,
  teamIssueCommentIndexDeploymentStage,
});
acknowledgeKnownNagFindings(stack);
