import * as lambda from 'aws-cdk-lib/aws-lambda';

/** Audit entity type of the operator's runtime-control switch events (scripts/runtime-control.ts). */
const RUNTIME_CONTROL_AUDIT_ENTITY_TYPE = 'runtime-control';

/**
 * Builds the AuditEvents stream filters that drop runtime-control switch events.
 *
 * The operator script writes those events while runtime control may block every audit stream
 * consumer, so a blocked consumer would retry them into its DLQ. They need no projection: the
 * script applies the tenant retention itself and they are outside notifications and automation.
 * Records without an entity type (for example a TTL removal, which has no new image) still reach
 * the consumer. Lambda applies `exists` only to leaf values, so the rule checks `entityType.S`.
 *
 * @returns Filter criteria for a `DynamoEventSource` on the AuditEvents table; any one may match.
 */
export function skipRuntimeControlAuditEvents(): Array<{ [key: string]: unknown }> {
  return [
    lambda.FilterCriteria.filter({
      dynamodb: { NewImage: { entityType: { S: lambda.FilterRule.notEquals(RUNTIME_CONTROL_AUDIT_ENTITY_TYPE) } } },
    }),
    lambda.FilterCriteria.filter({
      dynamodb: { NewImage: { entityType: { S: lambda.FilterRule.notExists() } } },
    }),
  ];
}
