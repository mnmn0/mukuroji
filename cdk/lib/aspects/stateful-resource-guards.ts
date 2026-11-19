import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { IConstruct } from 'constructs';

/** CloudFormation type of every Lambda function, including CDK-internal singleton handlers. */
const LAMBDA_FUNCTION_RESOURCE_TYPE = 'AWS::Lambda::Function';

/** Construct ID of the log group added next to a Lambda function that has none. */
const DEFAULT_LAMBDA_LOG_GROUP_ID = 'DefaultLogGroup';

/** Retention applied to Lambda log groups that no subsystem declared explicitly. */
const DEFAULT_LAMBDA_LOG_RETENTION = logs.RetentionDays.THREE_MONTHS;

/**
 * Returns whether a Lambda function resource already writes to an explicit log group.
 *
 * @param resource - Synthesized Lambda function resource.
 * @returns Whether `LoggingConfig.LogGroup` is set.
 */
function hasExplicitLogGroup(resource: cdk.CfnResource): boolean {
  if (resource instanceof lambda.CfnFunction) {
    const loggingConfig = resource.loggingConfig;
    if (loggingConfig === undefined) {
      return false;
    }
    if (cdk.Token.isUnresolved(loggingConfig)) {
      return true;
    }

    return (loggingConfig as lambda.CfnFunction.LoggingConfigProperty).logGroup
      !== undefined;
  }

  return false;
}

/**
 * Gives every Lambda function a retained log group with a finite retention period.
 *
 * Without an explicit log group, Lambda creates `/aws/lambda/<name>` on first invocation
 * with no retention, so logs accumulate storage cost forever.
 */
class LambdaLogRetentionAspect implements cdk.IAspect {
  /**
   * Adds a log group to a Lambda function that has none.
   *
   * @param node - Construct visited by the aspect.
   */
  public visit(node: IConstruct): void {
    if (
      !(node instanceof cdk.CfnResource)
      || node.cfnResourceType !== LAMBDA_FUNCTION_RESOURCE_TYPE
      || hasExplicitLogGroup(node)
    ) {
      return;
    }
    const scope = node.node.scope;
    if (
      scope === undefined
      || scope.node.tryFindChild(DEFAULT_LAMBDA_LOG_GROUP_ID) !== undefined
    ) {
      return;
    }
    const logGroup = new logs.LogGroup(scope, DEFAULT_LAMBDA_LOG_GROUP_ID, {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retention: DEFAULT_LAMBDA_LOG_RETENTION,
    });
    node.addPropertyOverride('LoggingConfig.LogGroup', logGroup.logGroupName);
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
