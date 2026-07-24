import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { IConstruct } from 'constructs';

/** Maximum number of alarm-state actions accepted by CloudWatch. */
const MAX_ALARM_ACTION_COUNT = 5;

/** Synthesized CloudFormation resource owned by a metric or composite alarm. */
type SynthesizedAlarmResource =
  | cloudwatch.CfnAlarm
  | cloudwatch.CfnCompositeAlarm;

/** Symbolic component used to compare equivalent CloudFormation ARN expressions. */
type AlarmActionSegment = readonly [
  kind: 'get-att' | 'literal' | 'reference',
  value: string,
];

/**
 * Required notification destinations for every CloudWatch alarm in the stack.
 */
export interface AlarmRoutingConfiguration {
  /** Primary and secondary SNS topic ARNs for redundant notification paths. */
  readonly notificationTopicArns: readonly [string, string];
}

/**
 * Returns the synthesized CloudFormation resource owned by an alarm.
 *
 * @param alarm - Alarm whose default child is inspected.
 * @returns The synthesized alarm resource, or undefined for an imported alarm.
 */
function findSynthesizedAlarmResource(
  alarm: cloudwatch.AlarmBase,
): SynthesizedAlarmResource | undefined {
  const defaultChild = alarm.node.defaultChild;

  return defaultChild instanceof cloudwatch.CfnAlarm
    || defaultChild instanceof cloudwatch.CfnCompositeAlarm
    ? defaultChild
    : undefined;
}

/**
 * Narrows an unknown value to a string-keyed object.
 *
 * @param value - Value to inspect.
 * @returns Whether the value is a non-array object.
 */
function isUnknownRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merges adjacent literal segments into a canonical representation.
 *
 * @param segments - Symbolic action segments to normalize.
 * @returns Canonical symbolic segments.
 */
function mergeLiteralSegments(
  segments: readonly AlarmActionSegment[],
): AlarmActionSegment[] {
  const mergedSegments: AlarmActionSegment[] = [];
  for (const segment of segments) {
    const previousSegment = mergedSegments.at(-1);
    if (
      previousSegment?.[0] === 'literal'
      && segment[0] === 'literal'
    ) {
      mergedSegments[mergedSegments.length - 1] = [
        'literal',
        previousSegment[1] + segment[1],
      ];
      continue;
    }
    mergedSegments.push(segment);
  }

  return mergedSegments;
}

/**
 * Expands a CloudFormation substitution into symbolic string segments.
 *
 * @param template - Fn::Sub template string.
 * @param variables - Optional Fn::Sub variable mapping.
 * @returns Symbolic segments, or undefined for an unsupported mapping value.
 */
function parseSubstitutionSegments(
  template: string,
  variables: Readonly<Record<string, unknown>>,
): AlarmActionSegment[] | undefined {
  const segments: AlarmActionSegment[] = [];
  const variablePattern = /\$\{([^}]+)\}/gu;
  let cursor = 0;

  for (const match of template.matchAll(variablePattern)) {
    const matchIndex = match.index;
    const variableName = match[1];
    if (variableName === undefined) {
      return undefined;
    }
    if (matchIndex > cursor) {
      segments.push(['literal', template.slice(cursor, matchIndex)]);
    }

    if (variableName.startsWith('!')) {
      segments.push(['literal', `\${${variableName.slice(1)}}`]);
    } else if (Object.hasOwn(variables, variableName)) {
      const mappedSegments = symbolicAlarmActionSegments(
        variables[variableName],
      );
      if (mappedSegments === undefined) {
        return undefined;
      }
      segments.push(...mappedSegments);
    } else if (variableName.includes('.')) {
      segments.push(['get-att', variableName]);
    } else {
      segments.push(['reference', variableName]);
    }
    cursor = matchIndex + match[0].length;
  }

  if (cursor < template.length) {
    segments.push(['literal', template.slice(cursor)]);
  }

  return mergeLiteralSegments(segments);
}

/**
 * Converts supported CloudFormation string expressions into symbolic segments.
 *
 * @param value - Resolved action value to normalize.
 * @returns Symbolic segments, or undefined for an opaque expression.
 */
function symbolicAlarmActionSegments(
  value: unknown,
): AlarmActionSegment[] | undefined {
  if (typeof value === 'string') {
    return [['literal', value]];
  }
  if (!isUnknownRecord(value)) {
    return undefined;
  }

  const reference = value.Ref;
  if (typeof reference === 'string') {
    return [['reference', reference]];
  }

  const getAttribute = value['Fn::GetAtt'];
  if (typeof getAttribute === 'string') {
    return [['get-att', getAttribute]];
  }
  if (
    Array.isArray(getAttribute)
    && getAttribute.length === 2
    && typeof getAttribute[0] === 'string'
    && typeof getAttribute[1] === 'string'
  ) {
    return [['get-att', `${getAttribute[0]}.${getAttribute[1]}`]];
  }

  const joinedValue = value['Fn::Join'];
  if (
    Array.isArray(joinedValue)
    && joinedValue.length === 2
    && typeof joinedValue[0] === 'string'
    && Array.isArray(joinedValue[1])
  ) {
    const segments: AlarmActionSegment[] = [];
    for (const [index, part] of joinedValue[1].entries()) {
      if (index > 0 && joinedValue[0].length > 0) {
        segments.push(['literal', joinedValue[0]]);
      }
      const partSegments = symbolicAlarmActionSegments(part);
      if (partSegments === undefined) {
        return undefined;
      }
      segments.push(...partSegments);
    }
    return mergeLiteralSegments(segments);
  }

  const substitutedValue = value['Fn::Sub'];
  if (typeof substitutedValue === 'string') {
    return parseSubstitutionSegments(substitutedValue, {});
  }
  if (
    Array.isArray(substitutedValue)
    && substitutedValue.length === 2
    && typeof substitutedValue[0] === 'string'
    && isUnknownRecord(substitutedValue[1])
  ) {
    return parseSubstitutionSegments(
      substitutedValue[0],
      substitutedValue[1],
    );
  }

  return undefined;
}

/**
 * Resolves an alarm's configured L1 property into an inspectable list.
 *
 * @param scope - Construct that provides the resolution stack.
 * @param resource - Synthesized alarm resource containing the action property.
 * @returns Resolved action values, or undefined when the property is not a list.
 */
function resolveConfiguredAlarmActions(
  scope: IConstruct,
  resource: SynthesizedAlarmResource,
): readonly unknown[] | undefined {
  const resolvedActions: unknown = cdk.Stack.of(scope).resolve(
    resource.alarmActions,
  );
  if (resolvedActions === undefined) {
    return [];
  }

  return Array.isArray(resolvedActions) ? resolvedActions : undefined;
}

/**
 * Resolves the final rendered AlarmActions after property overrides are applied.
 *
 * @param scope - Construct that provides the resolution stack.
 * @param resource - Alarm resource whose final CloudFormation is inspected.
 * @returns Final rendered actions, or undefined when they are not inspectable.
 */
function resolveRenderedAlarmActions(
  scope: IConstruct,
  resource: SynthesizedAlarmResource,
): readonly unknown[] | undefined {
  const renderedCloudFormation: unknown = cdk.Stack.of(scope).resolve(
    resource._toCloudFormation(),
  );
  if (!isUnknownRecord(renderedCloudFormation)) {
    return undefined;
  }
  const resources = renderedCloudFormation.Resources;
  if (!isUnknownRecord(resources)) {
    return undefined;
  }
  const renderedResources = Object.values(resources);
  if (renderedResources.length !== 1) {
    return undefined;
  }
  const renderedResource = renderedResources[0];
  if (!isUnknownRecord(renderedResource)) {
    return undefined;
  }
  const properties = renderedResource.Properties;
  if (!isUnknownRecord(properties)) {
    return [];
  }
  const actions = properties.AlarmActions;
  if (actions === undefined) {
    return [];
  }

  return Array.isArray(actions) ? actions : undefined;
}

/**
 * Creates a stable comparison key for an alarm action.
 *
 * @param scope - Construct that provides the resolution stack.
 * @param action - Action ARN or token to resolve.
 * @returns A canonical or opaque serialized key, or undefined if unserializable.
 */
function resolvedAlarmActionKey(
  scope: IConstruct,
  action: unknown,
): string | undefined {
  const resolvedAction: unknown = cdk.Stack.of(scope).resolve(action);
  const symbolicSegments = symbolicAlarmActionSegments(resolvedAction);
  if (symbolicSegments !== undefined) {
    return `symbolic:${JSON.stringify(symbolicSegments)}`;
  }
  const serializedAction = JSON.stringify(resolvedAction);

  return serializedAction === undefined
    ? undefined
    : `opaque:${serializedAction}`;
}

/**
 * Validates the final combined alarm actions after all aspects have run.
 *
 * @param scope - Alarm construct or resource whose actions are validated.
 * @param resource - Synthesized alarm resource containing the final actions.
 * @param requiredTopicArns - Mandatory primary and secondary topic ARNs.
 * @param preservedActionKeys - Pre-routing destinations that must remain present.
 * @returns Validation errors that prevent synthesis.
 */
function validateAlarmActions(
  scope: IConstruct,
  resource: SynthesizedAlarmResource,
  requiredTopicArns: readonly [string, string],
  preservedActionKeys: readonly string[],
): string[] {
  const actions = resolveRenderedAlarmActions(scope, resource);
  if (actions === undefined) {
    return [
      'Rendered AlarmActions must resolve to an inspectable list.',
    ];
  }

  const errors: string[] = [];
  const actionKeys: string[] = [];
  for (const action of actions) {
    const actionKey = resolvedAlarmActionKey(scope, action);
    if (actionKey === undefined) {
      errors.push('AlarmActions must contain only serializable ARN values.');
      continue;
    }
    actionKeys.push(actionKey);
  }

  if (actions.length > MAX_ALARM_ACTION_COUNT) {
    errors.push(
      `AlarmActions supports at most ${MAX_ALARM_ACTION_COUNT} destinations `
      + `after mandatory routing; found ${actions.length}.`,
    );
  }
  if (new Set(actionKeys).size !== actionKeys.length) {
    errors.push(
      'AlarmActions must contain unique destinations after mandatory routing.',
    );
  }

  const requiredActionKeys: string[] = [];
  for (const topicArn of requiredTopicArns) {
    const requiredActionKey = resolvedAlarmActionKey(scope, topicArn);
    if (requiredActionKey === undefined) {
      errors.push(
        'Mandatory notification destinations must resolve to serializable ARNs.',
      );
      continue;
    }
    requiredActionKeys.push(requiredActionKey);
  }
  if (
    requiredActionKeys.length === 2
    && new Set(requiredActionKeys).size !== 2
  ) {
    errors.push(
      'Primary and secondary notification destinations must be distinct.',
    );
  }

  const configuredActionKeys = new Set(actionKeys);
  for (const preservedActionKey of preservedActionKeys) {
    if (!configuredActionKeys.has(preservedActionKey)) {
      errors.push(
        'AlarmActions must preserve every pre-routing destination.',
      );
      break;
    }
  }
  for (const requiredActionKey of requiredActionKeys) {
    if (!configuredActionKeys.has(requiredActionKey)) {
      errors.push(
        'AlarmActions must retain both mandatory notification destinations.',
      );
      break;
    }
  }

  return errors;
}

/**
 * Adds the mandatory notification destinations to each synthesized CloudWatch alarm.
 */
class AlarmRoutingAspect implements cdk.IAspect {
  /** Primary and secondary topics for redundant notification paths. */
  private readonly notificationTopics: readonly [sns.ITopic, sns.ITopic];

  /** Pre-routing destinations captured for each synthesized alarm resource. */
  private readonly preservedActionKeysByResource = new WeakMap<
    SynthesizedAlarmResource,
    readonly string[]
  >();

  /**
   * Creates an alarm-routing aspect for the supplied topics.
   *
   * @param notificationTopics - Primary and secondary notification topics.
   */
  constructor(
    notificationTopics: readonly [sns.ITopic, sns.ITopic],
  ) {
    this.notificationTopics = notificationTopics;
  }

  /**
   * Adds primary and secondary actions to a CloudWatch alarm.
   *
   * @param node - Construct currently visited during synthesis.
   * @returns Nothing.
   */
  public visit(node: IConstruct): void {
    const requiredTopicArns: readonly [string, string] = [
      this.notificationTopics[0].topicArn,
      this.notificationTopics[1].topicArn,
    ];
    if (
      node instanceof cloudwatch.CfnAlarm
      || node instanceof cloudwatch.CfnCompositeAlarm
    ) {
      const preservedActionKeys = this.preservedActionKeysByResource.get(node)
        ?? [];
      node.node.addValidation({
        validate: () => validateAlarmActions(
          node,
          node,
          requiredTopicArns,
          preservedActionKeys,
        ),
      });
      return;
    }
    if (!(node instanceof cloudwatch.AlarmBase)) {
      return;
    }

    const alarmResource = findSynthesizedAlarmResource(node);
    if (alarmResource === undefined) {
      return;
    }
    const configuredActionKeys = new Set<string>();
    for (
      const action
      of resolveConfiguredAlarmActions(node, alarmResource) ?? []
    ) {
      const actionKey = resolvedAlarmActionKey(node, action);
      if (actionKey !== undefined) {
        configuredActionKeys.add(actionKey);
      }
    }
    this.preservedActionKeysByResource.set(
      alarmResource,
      [...configuredActionKeys],
    );

    for (const topic of this.notificationTopics) {
      const topicActionKey = resolvedAlarmActionKey(node, topic.topicArn);
      if (
        topicActionKey !== undefined
        && configuredActionKeys.has(topicActionKey)
      ) {
        continue;
      }

      node.addAlarmAction(new cloudwatchActions.SnsAction(topic));
      if (topicActionKey !== undefined) {
        configuredActionKeys.add(topicActionKey);
      }
    }
  }
}

/**
 * Routes all CloudWatch alarms below a stack to mandatory SNS destinations.
 *
 * @param scope - Stack whose alarms receive the notification actions.
 * @param configuration - Primary and secondary notification topic ARNs.
 * @returns Nothing.
 */
export function configureAlarmRouting(
  scope: cdk.Stack,
  configuration: AlarmRoutingConfiguration,
): void {
  const primaryTopic = sns.Topic.fromTopicArn(
    scope,
    'AlarmPrimaryNotificationTopic',
    configuration.notificationTopicArns[0],
  );
  const secondaryTopic = sns.Topic.fromTopicArn(
    scope,
    'AlarmSecondaryNotificationTopic',
    configuration.notificationTopicArns[1],
  );
  cdk.Aspects.of(scope).add(
    new AlarmRoutingAspect([
      primaryTopic,
      secondaryTopic,
    ]),
    { priority: cdk.AspectPriority.MUTATING },
  );
}
