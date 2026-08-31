/** AI assistance application errors. */
export {
  AiAssistanceError,
  type AiAssistanceErrorCategory,
  type AiAssistanceErrorCode,
} from './errors'

/** Strict request, persistence, and model-output validators. */
export {
  aiAssistanceModelOutputSchema,
  parseAiAssistanceGeneration,
  parseAiAssistanceModelOutput,
  parseAiAssistancePolicy,
  parseAiAssistancePreference,
  parseCreateAiAssistanceFeedbackRequest,
  parseDecideAiAssistanceGenerationRequest,
  parseGenerateAiAssistanceRequest,
  parseUpdateAiAssistancePolicyRequest,
  parseUpdateAiAssistancePreferenceRequest,
  type AiAssistanceModelOutput,
} from './application/validation/ai-assistance-schema'

/** Deterministic input and output redaction. */
export {
  aliasAiAssistanceTextIdentifiers,
  classifyAiAssistanceSensitivePromptField,
  createAiAssistancePrivateTextAliases,
  redactAiAssistanceCitation,
  redactAiAssistanceDraft,
  redactAiAssistancePromptFieldValue,
  redactAiAssistanceText,
  redactAiAssistanceUncertainty,
  redactGenerateAiAssistanceRequest,
  type AiAssistanceTextAlias,
  type AiAssistancePromptField,
  type AiAssistanceSensitiveFieldMarker,
  type AiAssistancePrivateIdentifierGroup,
} from './domain/ai-assistance-redaction'

/** Application ports and use-case composition. */
export {
  AI_ASSISTANCE_MAX_GENERATION_AUTHORIZATION_CONDITIONS,
} from './application/ports/ai-assistance-ports'
export type {
  AiAssistanceActor,
  AiAssistanceAllowedValues,
  AiAssistanceAuthorizationCondition,
  AiAssistanceCustomFieldDefinition,
  AiAssistanceAuthorizationCallbacks,
  AiAssistanceAuthorizationState,
  AiAssistanceDecisionCommitFence,
  AiAssistanceDecisionStoreResult,
  AiAssistanceGenerationCommitFence,
  AiAssistanceFeedbackWriteResult,
  AiAssistanceGenerationExecution,
  AiAssistanceGenerationRequestObservation,
  AiAssistanceGenerationRequestOutcome,
  AiAssistanceGenerationReservation,
  AiAssistanceGenerationBudgetReservation,
  AiAssistancePolicyAuthorization,
  AiAssistancePolicyAuthorizationFence,
  AiAssistancePolicyAudit,
  AiAssistancePolicyAuditInput,
  AiAssistancePlanningDependency,
  AiAssistancePrivateMemberIdentifiers,
  AiAssistanceProviderAttemptObservation,
  AiAssistanceProviderAttemptOutcome,
  AiAssistanceObservability,
  AiAssistanceDecisionObservation,
  AiAssistanceTriageRoutingTuple,
  AiAssistanceTriageSourceRouting,
  AiAssistanceService,
  AiAssistanceServiceOptions,
  AiAssistanceStore,
  AiModelGateway,
  AiModelGenerationInput,
  AiModelGenerationResult,
  CheckAiAssistanceAuthorizationInput,
  CompleteAiAssistanceGenerationReservationInput,
  ExpireAiAssistanceGenerationAttemptInput,
  MarkAiAssistanceGenerationProviderStartedInput,
  ResolveAiAssistanceContextInput,
  ResolvedAiAssistanceContext,
  ReadAiAssistanceGenerationReservationInput,
  ReserveAiAssistanceGenerationInput,
  StoredAiAssistanceFeedback,
  StoredAiAssistanceGeneration,
} from './application/ports/ai-assistance-ports'
/** Creates the application service used by the HTTP adapter and offline evaluator. */
export {
  createAiAssistanceFeedbackIdentity,
  createAiAssistanceGenerationInputFingerprint,
  createAiAssistanceService,
  validateAiAssistanceDraftForApplication,
} from './application/use-cases/ai-assistance-service'

/** HTTP adapter with injected current-principal authorization callbacks. */
export {
  createAiAssistanceRouter,
  type AiAssistanceRouterDependencies,
} from './adapter-in/http/ai-assistance-router'

/** DynamoDB Stream projection for durable provider-attempt and decision metrics. */
export {
  processAiAssistanceObservabilityBatch,
} from './adapter-in/events/ai-assistance-observability-projection'

/** WorkspaceSearchTable persistence adapter. */
export {
  createAiAssistanceFeedbackRecordKey,
  createAiAssistanceGenerationRecordKey,
  createAiAssistanceIdempotencyRecordKey,
  createAiAssistancePreferenceRecordKey,
  DynamoDbAiAssistanceStore,
} from './adapter-out/dynamodb/dynamo-db-ai-assistance-store'

/** Mastra Bedrock Runtime model adapter. */
export {
  AI_ASSISTANCE_SYSTEM_INSTRUCTIONS,
  createAiAssistanceGenerationPrompt,
  createMastraBedrockAiModelGateway,
  type AiBedrockCredentials,
  type AiBedrockModelPricing,
  type MastraBedrockAiModelGatewayOptions,
  type MastraStructuredGenerationInput,
  type MastraStructuredGenerationResult,
  type MastraStructuredGenerationRunner,
} from './adapter-out/mastra/mastra-bedrock-ai-model-gateway'

/** Safe Embedded Metric Format observations for AI assistance operations. */
export {
  createAiAssistanceEmfObservability,
  type AiAssistanceEmfObservabilityOptions,
  type StructuredAiAssistanceLogSink,
} from './adapter-out/observability/ai-assistance-observability'
