import type { WorkspaceSearchFilters } from '@mukuroji/contracts'
import type {
  AiBedrockModelPricing,
  AiModelGenerationInput,
} from '../../src/modules/ai-assistance'

/** Safety and quality limits applied to one recorded model result. */
export type AiAssistanceOfflineEvalBudgets = {
  /** Maximum provider input tokens accepted by the benchmark. */
  maxInputTokens: number
  /** Maximum provider output tokens accepted by the benchmark. */
  maxOutputTokens: number
  /** Maximum end-to-end provider latency accepted by the benchmark. */
  maxLatencyMs: number
  /** Optional maximum estimated provider cost accepted by the benchmark. */
  maxCostUsd?: number
}

/** Model input fields that are captured only after authorization and redaction. */
export type AiAssistanceOfflineModelInput = Pick<
  AiModelGenerationInput,
  | 'task'
  | 'locale'
  | 'promptVersion'
  | 'request'
  | 'promptContext'
  | 'citations'
  | 'allowedValues'
>

/** Quality, safety, and serialization expectations for one sanitized input case. */
export type AiAssistanceOfflineInputCase = {
  /** Stable non-tenant benchmark identifier. */
  id: string
  /** Sanitized production-shaped input supplied to the prompt gateway. */
  modelInput: AiAssistanceOfflineModelInput
  /** Reviewed SHA-256 of the exact serialized user prompt. */
  expectedPromptSha256: string
  /** Minimum number of evidence-bearing claims required for this case. */
  minimumClaimCount: number
  /** Text fragments required in the structured output for deterministic quality regression. */
  requiredTextFragments: readonly string[]
  /** Canary strings that must never occur in a disclosed output. */
  forbiddenSubstrings: readonly string[]
  /** Exact safe filter expectation for Search translation cases. */
  expectedSearchFilters?: WorkspaceSearchFilters
  /** Per-case release budgets. */
  budgets: AiAssistanceOfflineEvalBudgets
}

/** Reviewed provenance shared by every sanitized model-input case. */
export type AiAssistanceOfflineInputProvenance = {
  /** Version of the sanitized input corpus. */
  datasetRevision: string
  /** Provider boundary exercised by this corpus. */
  provider: 'bedrock-runtime'
  /** Exact Bedrock model or inference-profile identifier supplied to Mastra. */
  modelId: string
  /** Exact inference-profile identifier reviewed for the recorded run. */
  inferenceProfileId: string
  /** Prompt template version required on every input. */
  promptVersion: string
  /** Public structured-output schema version reviewed with the corpus. */
  schemaVersion: number
  /** Reviewed SHA-256 of the production system instructions. */
  systemInstructionsSha256: string
  /** Version of the price card used for the deterministic cost estimate. */
  pricingRevision: string
  /** Versioned per-token prices used by the production gateway estimate. */
  pricing: AiBedrockModelPricing
}

/** Versioned sanitized input dataset with no tenant or credential material. */
export type AiAssistanceOfflineInputDataset = {
  /** Reviewed dataset-level runtime and prompt provenance. */
  provenance: AiAssistanceOfflineInputProvenance
  /** Ordered production-shaped sanitized input cases. */
  cases: readonly AiAssistanceOfflineInputCase[]
}

/** Provider counters recorded beside one reviewed deterministic output. */
export type AiAssistanceOfflineRecordedUsage = {
  /** Provider-reported input token count. */
  inputTokens: number
  /** Provider-reported output token count. */
  outputTokens: number
  /** End-to-end provider latency observed for the reviewed recording. */
  latencyMs: number
}

/** One reviewed structured output paired to a sanitized input case. */
export type AiAssistanceOfflineRecordedOutput = {
  /** Stable benchmark case identifier. */
  id: string
  /** Unknown output parsed through the production strict schema. */
  modelOutput: unknown
  /** Recorded provider counters replayed through the production gateway. */
  usage: AiAssistanceOfflineRecordedUsage
}

/** Versioned reviewed outputs recorded independently from model inputs. */
export type AiAssistanceOfflineRecordedOutputDataset = {
  /** Version of the recorded structured output set. */
  outputRevision: string
  /** Ordered outputs paired one-to-one with the input dataset. */
  cases: readonly AiAssistanceOfflineRecordedOutput[]
}

/** Complete network-free baseline evaluated by the release command. */
export type AiAssistanceOfflineBaseline = {
  /** Versioned sanitized model-input dataset. */
  inputDataset: AiAssistanceOfflineInputDataset
  /** Versioned reviewed model-output recordings. */
  recordedOutputs: AiAssistanceOfflineRecordedOutputDataset
}

/** Deterministic metrics emitted for one offline evaluation case. */
export type AiAssistanceOfflineEvalMetrics = {
  /** Whether the production prompt matched its reviewed serialization digest. */
  promptDigestMatched: boolean
  /** Number of evidence-bearing claims found in the parsed draft. */
  claimCount: number
  /** Fraction of claims containing one or more authorized citation references. */
  citationCoverage: number
  /** Number of citation references not present in the authorized prompt set. */
  unknownCitationCount: number
  /** Number of resource identifiers not present in the authorized allowlists. */
  unknownAllowedValueCount: number
  /** Number of required quality fragments absent from the output. */
  missingRequiredTextCount: number
  /** Number of forbidden canary or secret patterns found in the output. */
  forbiddenMatchCount: number
  /** Whether a Search draft exactly matched its reviewed safe-filter expectation. */
  searchFiltersMatch?: boolean
  /** Recorded input token count, defaulting to zero only for reporting. */
  inputTokens: number
  /** Recorded output token count, defaulting to zero only for reporting. */
  outputTokens: number
  /** Recorded provider latency. */
  latencyMs: number
  /** Recorded cost when a trusted estimate was available. */
  costUsd?: number
}

/** Fail-closed result for one sanitized offline evaluation case. */
export type AiAssistanceOfflineEvalCaseResult = {
  /** Stable benchmark case identifier. */
  id: string
  /** Whether every schema, prompt, quality, safety, and budget check passed. */
  passed: boolean
  /** Stable failure codes without source or output content. */
  failures: string[]
  /** Deterministic non-content metrics safe for CI artifacts. */
  metrics?: AiAssistanceOfflineEvalMetrics
}

/** Content-free provenance emitted in the aggregate CI report. */
export type AiAssistanceOfflineEvalProvenance = Omit<
  AiAssistanceOfflineInputProvenance,
  'pricing'
> & {
  /** Version of the paired reviewed model-output recordings. */
  outputRevision: string
}

/** Aggregate offline evaluation report suitable for a CI release artifact. */
export type AiAssistanceOfflineEvalReport = {
  /** Report schema version. */
  schemaVersion: 2
  /** Content-free runtime, dataset, prompt, and output provenance. */
  provenance: AiAssistanceOfflineEvalProvenance
  /** Whether every benchmark case passed. */
  passed: boolean
  /** Number of benchmark cases evaluated. */
  caseCount: number
  /** Number of passing benchmark cases. */
  passedCaseCount: number
  /** Ordered, non-content per-case results. */
  cases: AiAssistanceOfflineEvalCaseResult[]
}
