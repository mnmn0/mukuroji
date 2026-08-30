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
export type {
  AiAssistanceActor,
  AiAssistanceAllowedValues,
  AiAssistanceAuthorizationCondition,
  AiAssistanceCustomFieldDefinition,
  AiAssistanceAuthorizationCallbacks,
  AiAssistanceAuthorizationState,
  AiAssistanceDecisionCommitFence,
  AiAssistanceGenerationCommitFence,
  AiAssistanceGenerationReservation,
  AiAssistanceGenerationBudgetReservation,
  AiAssistancePolicyAuthorization,
  AiAssistancePolicyAuthorizationFence,
  AiAssistancePolicyAudit,
  AiAssistancePolicyAuditInput,
  AiAssistancePrivateMemberIdentifiers,
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
  ResolveAiAssistanceContextInput,
  ResolvedAiAssistanceContext,
  ReadAiAssistanceGenerationReservationInput,
  ReserveAiAssistanceGenerationInput,
  StoredAiAssistanceFeedback,
  StoredAiAssistanceGeneration,
} from './application/ports/ai-assistance-ports'
/** Creates the application service used by the HTTP adapter and offline evaluator. */
export {
  createAiAssistanceService,
  validateAiAssistanceDraftForApplication,
} from './application/use-cases/ai-assistance-service'

/** HTTP adapter with injected current-principal authorization callbacks. */
export {
  createAiAssistanceRouter,
  type AiAssistanceRouterDependencies,
} from './adapter-in/http/ai-assistance-router'

/** WorkspaceSearchTable persistence adapter. */
export {
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
