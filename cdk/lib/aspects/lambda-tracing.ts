import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import type { IConstruct } from 'constructs';

/** Deploy-time switch that decides whether application tracing is recorded by X-Ray. */
export interface LambdaTracingConfiguration {
  /** `PassThrough` (default) or `Active`, applied to every function that requests active tracing. */
  readonly tracingMode: cdk.CfnParameter;
  /** True when `tracingMode` is `Active`; drives the Step Functions tracing flag. */
  readonly tracingActive: cdk.CfnCondition;
}

/**
 * Narrows a synthesized tracing property to a literal `Active` Lambda configuration.
 *
 * @param value - `TracingConfig` value of a Lambda function.
 * @returns Whether the function was built with `lambda.Tracing.ACTIVE`.
 */
function isActiveLambdaTracing(value: unknown): boolean {
  return typeof value === 'object' && value !== null
    && Reflect.get(value, 'mode') === lambda.Tracing.ACTIVE;
}

/**
 * Narrows a synthesized tracing property to a literal enabled state-machine configuration.
 *
 * @param value - `TracingConfiguration` value of a state machine.
 * @returns Whether the state machine was built with `tracingEnabled: true`.
 */
function isEnabledStateMachineTracing(value: unknown): boolean {
  return typeof value === 'object' && value !== null
    && Reflect.get(value, 'enabled') === true;
}

/**
 * Rewrites code-level active tracing into the deploy-time tracing switch.
 *
 * Subsystems keep declaring `lambda.Tracing.ACTIVE` and keep the X-Ray write permissions
 * that CDK adds for it, so turning the switch back on changes only the tracing mode and
 * never the execution roles.
 */
class LambdaTracingAspect implements cdk.IAspect {
  /** Deploy-time switch applied to every visited function and state machine. */
  private readonly configuration: LambdaTracingConfiguration;

  /**
   * Holds the switch applied to every visited function and state machine.
   *
   * @param configuration - Deploy-time tracing switch.
   */
  constructor(configuration: LambdaTracingConfiguration) {
    this.configuration = configuration;
  }

  /**
   * Replaces literal active tracing on one construct.
   *
   * @param node - Construct visited by the aspect.
   */
  public visit(node: IConstruct): void {
    if (node instanceof lambda.CfnFunction && isActiveLambdaTracing(node.tracingConfig)) {
      node.tracingConfig = { mode: this.configuration.tracingMode.valueAsString };
      return;
    }
    if (
      node instanceof stepfunctions.CfnStateMachine
      && isEnabledStateMachineTracing(node.tracingConfiguration)
    ) {
      node.tracingConfiguration = {
        enabled: cdk.Fn.conditionIf(
          this.configuration.tracingActive.logicalId,
          true,
          false,
        ),
      };
    }
  }
}

/**
 * Makes X-Ray tracing of application Lambdas and state machines a deploy-time choice.
 *
 * The default `PassThrough` records no trace unless an upstream caller already sampled the
 * request, which removes the per-minute job and API traces from the X-Ray bill.
 *
 * @param scope - Stack whose functions and state machines follow the switch.
 * @param configuration - Tracing mode parameter and its `Active` condition.
 */
export function configureLambdaTracing(
  scope: cdk.Stack,
  configuration: LambdaTracingConfiguration,
): void {
  cdk.Aspects.of(scope).add(new LambdaTracingAspect(configuration));
}
