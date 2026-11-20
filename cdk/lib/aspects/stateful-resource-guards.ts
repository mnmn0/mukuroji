import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { IConstruct } from 'constructs';

/** Construct ID of the log group CDK creates under `useCdkManagedLogGroup`. */
const CDK_MANAGED_LAMBDA_LOG_GROUP_ID = 'LogGroup';

/** Retention applied to CDK-managed Lambda log groups. */
const DEFAULT_LAMBDA_LOG_RETENTION = logs.RetentionDays.THREE_MONTHS;

/**
 * Returns whether a Lambda function already writes to an explicit log group.
 *
 * @param resource - Synthesized Lambda function resource.
 * @returns Whether `LoggingConfig.LogGroup` is set.
 */
function hasExplicitLogGroup(resource: lambda.CfnFunction): boolean {
  const loggingConfig = resource.loggingConfig;
  if (loggingConfig === undefined) {
    return false;
  }

  return cdk.Token.isUnresolved(loggingConfig)
    || (loggingConfig as lambda.CfnFunction.LoggingConfigProperty).logGroup !== undefined;
}

/**
 * Enforces a bounded retention on every Lambda function's log group.
 *
 * Without an explicit log group, Lambda creates `/aws/lambda/<name>` on first invocation
 * with no retention. `@aws-cdk/aws-lambda:useCdkManagedLogGroup` (set in `cdk.json`) makes
 * CDK create that group, but with the two-year default; this aspect bounds it to 90 days.
 * A function with neither kind of log group is reported as a synth error; each
 * subsystem owns creating the log group for its functions.
 */
class LambdaLogRetentionAspect implements cdk.IAspect {
  /**
   * Bounds the CDK-managed log group retention, or reports a function without a log group.
   *
   * @param node - Construct visited by the aspect.
   */
  public visit(node: IConstruct): void {
    if (!(node instanceof lambda.CfnFunction)) {
      return;
    }
    const cdkManagedLogGroup = node.node.scope?.node.tryFindChild(
      CDK_MANAGED_LAMBDA_LOG_GROUP_ID,
    );
    if (cdkManagedLogGroup instanceof logs.LogGroup) {
      const cfnLogGroup = cdkManagedLogGroup.node.defaultChild as logs.CfnLogGroup;
      cfnLogGroup.retentionInDays = DEFAULT_LAMBDA_LOG_RETENTION;
      cfnLogGroup.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

      return;
    }
    if (!hasExplicitLogGroup(node)) {
      cdk.Annotations.of(node).addError(
        'Lambda function has no log group with bounded retention. Pass `logGroup`, or '
          + 'enable `@aws-cdk/aws-lambda:useCdkManagedLogGroup`.',
      );
    }
  }
}

/**
 * Turns on deletion protection for every retained DynamoDB table.
 *
 * `RemovalPolicy.RETAIN` only protects a table from stack deletion; deletion protection
 * also blocks `DeleteTable` from the console or CLI.
 */
class TableDeletionProtectionAspect implements cdk.IAspect {
  /**
   * Enables deletion protection on a retained table.
   *
   * @param node - Construct visited by the aspect.
   */
  public visit(node: IConstruct): void {
    if (
      node instanceof dynamodb.CfnTable
      && node.cfnOptions.deletionPolicy === cdk.CfnDeletionPolicy.RETAIN
      && node.deletionProtectionEnabled === undefined
    ) {
      node.deletionProtectionEnabled = true;
    }
  }
}

/**
 * Adds stack-wide guards for stateful resources: Lambda log retention and table deletion
 * protection.
 *
 * @param scope - Stack whose resources are guarded.
 */
export function configureStatefulResourceGuards(scope: cdk.Stack): void {
  cdk.Aspects.of(scope).add(new LambdaLogRetentionAspect(), {
    priority: cdk.AspectPriority.MUTATING,
  });
  cdk.Aspects.of(scope).add(new TableDeletionProtectionAspect(), {
    priority: cdk.AspectPriority.MUTATING,
  });
}
