/** Triage module public application, persistence, HTTP, and schedule surface. */
export {
  TriageError,
  applyTriageAction,
  createTriageCapabilities,
  evaluateTriageAdmission,
  evaluateTriageSchedule,
  isTerminalTriageState,
  projectTriageEntryForResponse,
  recordTriageSourceActivity,
  type ApplyTriageActionContext,
  type TriageAdmissionEvaluation,
  type TriageAdmissionRotationReservation,
  type TriageScheduleEvaluation,
  type TriageSourceActivity,
} from './domain/triage-entry'

/** Triage application ports used by composition and adapters. */
export {
  createTriageBulkTargetIdempotencyKey,
  createTriageInputFingerprint,
  type ResolveTriageWorkItemAction,
  type TriageActor,
  type TriageClient,
  type TriageIdempotency,
  type TriageWorkItemActionResolution,
} from './triage'

/** Composable Request Intake table transaction builders. */
export {
  DEFAULT_TRIAGE_WAKE_SHARD_COUNT,
  createFormTriageEntryTransactionItems,
  createFormTriageEntryTransactionPut,
  createTriageAcceptanceTransactionItems,
  createTriageActionTransactionItems,
  createTriageEntryKey,
  createTriageEntryTransactionItems,
  createTriageOperationReceiptTransactionPut,
  createTriageReceiptKey,
  createTriageScheduleTransactionItems,
  createTriageSourceActivityTransactionItems,
  createTriageSourceClaimKey,
  createTriageWorkItemSourcePrefix,
  createWorkspaceScopeKey,
  decodeTriageEntryRow,
  validateTriageEntryProjection,
  type CreateFormTriageEntryTransactionPutInput,
  type CreateTriageAcceptanceTransactionItemsInput,
  type CreateTriageActionTransactionItemsInput,
  type CreateTriageEntryTransactionItemsInput,
  type CreateTriageOperationReceiptTransactionPutInput,
  type CreateTriageScheduleTransactionItemsInput,
  type CreateTriageSourceActivityTransactionItemsInput,
  type TriageScheduleTransactionContribution,
  type TriageTransactionContribution,
  type TriageTransactionItem,
  type TriageTransactionItems,
} from './adapter-out/dynamodb/triage-transactions'

/** DynamoDB-backed triage application client. */
export {
  TRIAGE_OWNER_ACTIVITY_INDEX_NAME,
  TRIAGE_TEAM_ACTIVITY_INDEX_NAME,
  DynamoDbTriageClient,
  type DynamoDbTriageClientOptions,
  type TriageAdmissionTransactionContribution,
  type TriageAdmissionValidator,
} from './adapter-out/dynamodb/dynamo-db-triage-client'

/** Team triage HTTP adapter and composable action boundary. */
export {
  createTriageRouter,
  type TriagePrincipal,
  type TriageRouterBulkActionRequest,
  type TriageRouterActionRequest,
  type TriageRouterDependencies,
  type TriageTeamAccess,
} from './adapter-in/http/triage-router'

/** EventBridge triage deadline schedule adapter. */
export {
  TRIAGE_WAKE_INDEX_NAME,
  createProductionTriageScheduleHandler,
  createTriageScheduleHandler,
  runTriageSchedule,
  type RunTriageScheduleOptions,
  type TriageScheduleDocumentClient,
  type TriageScheduleEvent,
  type TriageScheduleHandlerConfiguration,
  type TriageScheduleResult,
} from './adapter-in/schedules/triage-schedule'
