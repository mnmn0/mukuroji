/** Customer domain public surface. */
export {
  CUSTOMER_DEFAULT_RETENTION_DAYS,
  CUSTOMER_MAX_OPERATION_ROWS,
  CUSTOMER_MAX_PAGE_LIMIT,
  CustomerError,
  calculateCustomerImpactSignal,
  createCustomerContactRecord,
  createCustomerRecord,
  createCustomerRequestRecord,
  deriveCustomerProjectSummaries,
  deriveCustomerWorkItemSummaries,
  projectCustomerImpactSignal,
  redactExpiredCustomerData,
  updateCustomerContactRecord,
  updateCustomerRecord,
  updateCustomerRequestRecord,
} from './domain/customer'
export {
  InMemoryCustomerClient,
  type CustomerAuthorizationConditionChecks,
  type CustomerClient,
  createCustomerIdempotencyRecordId,
  createCustomerListQueryFingerprint,
  matchesCustomer,
  normalizeCustomerListInput,
  type CustomerIdempotencyReceipt,
  type CustomerContactIdempotencyReceipt,
  type CustomerRetentionClient,
  type CustomerRetentionSweepResult,
  type CustomerRequestIdempotencyReceipt,
  type CustomerWorkItemCompletionResolver,
  type CustomerWorkItemProjectResolver,
  type CustomerWorkspaceState,
} from './customers'
export {
  DynamoDbCustomerClient,
  type DynamoDbCustomerClientOptions,
} from './adapter-out/dynamodb/dynamo-db-customer-client'
export {
  createCustomerRouter,
  type CustomerAuthorizationScope,
  type CustomerProjectAuthorization,
  type CustomerPrincipal,
  type CustomerRouterDependencies,
  type CustomerWorkItemAuthorization,
} from './adapter-in/http/customer-router'
