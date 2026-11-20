import * as cdk from 'aws-cdk-lib';

/** Tag key that marks every taggable resource of the application stack for cost allocation. */
export const COST_ALLOCATION_TAG_KEY = 'mukuroji:application';

/** Tag value shared by every resource of the application stack. */
export const COST_ALLOCATION_TAG_VALUE = 'mukuroji';

/**
 * Resource types that keep no cost allocation tag.
 *
 * - `aws:cdk:stack`: stack-level tags would make CloudFormation retag resources it cannot
 *   update in place, so only the resources themselves carry the tag.
 * - `AWS::AppConfig::Deployment` and `AWS::AppConfig::DeploymentStrategy`: a tag change
 *   replaces them, which restarts the runtime-control rollout or recreates the named
 *   strategy. Neither is billed.
 */
const UNTAGGED_RESOURCE_TYPES = [
  'aws:cdk:stack',
  'AWS::AppConfig::Deployment',
  'AWS::AppConfig::DeploymentStrategy',
];

/**
 * Tags every taggable resource in the stack so AWS Cost Explorer and Budgets can group
 * the application's cost once the tag is activated as a cost allocation tag.
 *
 * @param scope - Stack whose resources receive the tag.
 */
export function configureCostAllocationTags(scope: cdk.Stack): void {
  cdk.Tags.of(scope).add(COST_ALLOCATION_TAG_KEY, COST_ALLOCATION_TAG_VALUE, {
    excludeResourceTypes: UNTAGGED_RESOURCE_TYPES,
  });
}
