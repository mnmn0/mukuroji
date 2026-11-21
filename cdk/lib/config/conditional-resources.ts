import * as cdk from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';

/**
 * Deploys a construct's CloudFormation resource only when a stack condition holds.
 *
 * Used for resources that cost money while idle, such as alarms for a feature the
 * deployment has not configured.
 *
 * @param construct - Construct whose default child carries the condition.
 * @param condition - Condition that must be true for CloudFormation to create the resource.
 * @returns The same construct, so the call can wrap a constructor expression.
 */
export function deployOnlyWhen<T extends IConstruct>(
  construct: T,
  condition: cdk.CfnCondition,
): T {
  const resource = construct.node.defaultChild;
  if (!(resource instanceof cdk.CfnResource)) {
    throw new Error(`${construct.node.path} has no CloudFormation resource to condition.`);
  }
  resource.cfnOptions.condition = condition;
  return construct;
}
