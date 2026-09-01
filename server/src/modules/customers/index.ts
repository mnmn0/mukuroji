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
  type CustomerWorkspaceState,
} from './customers'
export {
  CUSTOMER_RETENTION_INDEX_NAME,
  DynamoDbCustomerClient,
  type DynamoDbCustomerClientOptions,
  type CustomerRetentionSweepResult,
} from './adapter-out/dynamodb/dynamo-db-customer-client'
export {
  createCustomerRouter,
  type CustomerAuthorizationScope,
  type CustomerProjectAuthorization,
  type CustomerPrincipal,
  type CustomerRouterDependencies,
  type CustomerWorkItemAuthorization,
} from './adapter-in/http/customer-router'
