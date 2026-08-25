import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  AI_ASSISTANCE_SCHEMA_VERSION,
  type AiAssistanceDraft,
} from '@mukuroji/contracts'
import {
  AI_ASSISTANCE_SYSTEM_INSTRUCTIONS,
  AiAssistanceError,
  createAiAssistanceGenerationPrompt,
  createMastraBedrockAiModelGateway,
  redactAiAssistanceCitation,
  redactAiAssistanceDraft,
  redactAiAssistanceText,
  redactAiAssistanceUncertainty,
  redactGenerateAiAssistanceRequest,
  type AiAssistanceAllowedValues,
  type AiModelGenerationResult,
  type MastraStructuredGenerationInput,
} from '../../src/modules/ai-assistance'
import { aiAssistanceOfflineBaseline } from './offline-baseline'
import type {
  AiAssistanceOfflineBaseline,
  AiAssistanceOfflineEvalCaseResult,
  AiAssistanceOfflineEvalProvenance,
  AiAssistanceOfflineEvalReport,
  AiAssistanceOfflineInputCase,
  AiAssistanceOfflineInputProvenance,
  AiAssistanceOfflineRecordedOutput,
} from './offline-evaluation-types'

/** Re-exports the versioned offline evaluation contract types. */
export type {
  AiAssistanceOfflineBaseline,
  AiAssistanceOfflineEvalBudgets,
  AiAssistanceOfflineEvalCaseResult,
  AiAssistanceOfflineEvalMetrics,
  AiAssistanceOfflineEvalProvenance,
  AiAssistanceOfflineEvalReport,
  AiAssistanceOfflineInputCase,
  AiAssistanceOfflineInputDataset,
  AiAssistanceOfflineInputProvenance,
  AiAssistanceOfflineModelInput,
  AiAssistanceOfflineRecordedOutput,
  AiAssistanceOfflineRecordedOutputDataset,
  AiAssistanceOfflineRecordedUsage,
} from './offline-evaluation-types'

/** One evidence-bearing claim and the citations emitted beside it. */
type EvaluatedClaim = {
  /** Citation identifiers emitted for the claim. */
  citationIds: readonly string[]
}

/** Captured production gateway boundary used for prompt regression checks. */
type CapturedGatewayBoundary = {
  /** Exact fixed system instructions passed to the runner. */
  systemInstructions: string
  /** Exact serialized user prompt passed to the runner. */
  prompt: string
  /** Exact provider model identifier passed to the runner. */
  modelId: string
  /** Provider output limit passed to the runner. */
  maxOutputTokens: number
  /** Provider timeout passed to the runner. */
  timeoutMs: number
  /** Safe deterministic provider trace identifier. */
  traceId: string
}

/** Result of replaying one recorded output through the production gateway. */
type OfflineGatewayReplay = {
  /** Captured gateway input, absent only when the boundary was not reached. */
  captured?: CapturedGatewayBoundary
  /** Strictly parsed production result, absent when the parser rejected the recording. */
  generation?: AiModelGenerationResult
  /** Stable content-free failure emitted by the production boundary. */
  failure?: 'schema-invalid' | 'gateway-boundary-failed'
}

/** Content-free candidate digests shown only during an explicit reviewed update. */
export type AiAssistanceOfflineReviewDigestReport = {
  /** SHA-256 of the production system instructions. */
  systemInstructionsSha256: string
  /** Ordered case identifiers and candidate serialized-prompt digests. */
  cases: Array<{
    /** Stable sanitized dataset case identifier. */
    id: string
    /** SHA-256 of the production prompt serialization for this case. */
    promptSha256: string
  }>
}

/**
 * Calculates candidate prompt digests without printing or returning prompt content.
 *
 * @param baseline - Reviewed sanitized input dataset and provider configuration.
 * @returns Content-free digest candidates that still require human review before pinning.
 */
export function createAiAssistanceOfflineReviewDigests(
  baseline: AiAssistanceOfflineBaseline,
): AiAssistanceOfflineReviewDigestReport {
  const provenance = baseline.inputDataset.provenance
  return {
    systemInstructionsSha256: createSha256(AI_ASSISTANCE_SYSTEM_INSTRUCTIONS),
    cases: baseline.inputDataset.cases.map((evaluationCase) => ({
      id: evaluationCase.id,
      promptSha256: createSha256(createAiAssistanceGenerationPrompt({
        ...evaluationCase.modelInput,
        modelId: provenance.modelId,
        traceId: createOfflineTraceId(evaluationCase.id),
        maxOutputTokens: evaluationCase.budgets.maxOutputTokens,
        timeoutMs: evaluationCase.budgets.maxLatencyMs,
      })),
    })),
  }
}

/**
 * Evaluates sanitized inputs and reviewed outputs through the production prompt and parser gateway.
 *
 * @param baseline - Independently versioned model-input dataset and output recordings.
 * @returns Content-free aggregate prompt, schema, quality, safety, citation, and budget results.
 */
export async function evaluateAiAssistanceOffline(
  baseline: AiAssistanceOfflineBaseline,
): Promise<AiAssistanceOfflineEvalReport> {
  const results: AiAssistanceOfflineEvalCaseResult[] = []
  const inputCases = baseline.inputDataset.cases
  const outputCases = baseline.recordedOutputs.cases
  for (let index = 0; index < inputCases.length; index += 1) {
    const inputCase = inputCases[index]
    if (!inputCase) continue
    const recordedOutput = outputCases[index]
    if (recordedOutput === undefined || recordedOutput.id !== inputCase.id) {
      results.push({
        id: inputCase.id,
        passed: false,
        failures: ['recording-pair-mismatch'],
      })
      continue
    }
    results.push(await evaluateCase(
      inputCase,
      recordedOutput,
      baseline.inputDataset.provenance,
    ))
  }
  for (let index = inputCases.length; index < outputCases.length; index += 1) {
    const unmatchedOutput = outputCases[index]
    if (!unmatchedOutput) continue
    results.push({
      id: unmatchedOutput.id,
      passed: false,
      failures: ['recording-pair-mismatch'],
    })
  }

  const passedCaseCount = results.filter((result) => result.passed).length
  return {
    schemaVersion: 2,
    provenance: createReportProvenance(
      baseline.inputDataset.provenance,
      baseline.recordedOutputs.outputRevision,
    ),
    passed: passedCaseCount === results.length && results.length > 0,
    caseCount: results.length,
    passedCaseCount,
    cases: results,
  }
}

/** Evaluates one input/output pair and never includes their content in the report. */
async function evaluateCase(
  evaluationCase: AiAssistanceOfflineInputCase,
  recordedOutput: AiAssistanceOfflineRecordedOutput,
  provenance: AiAssistanceOfflineInputProvenance,
): Promise<AiAssistanceOfflineEvalCaseResult> {
  const failures = collectInputAndProvenanceFailures(evaluationCase, provenance)
  const replay = await replayProductionGateway(evaluationCase, recordedOutput, provenance)
  if (replay.failure) failures.push(replay.failure)

  const promptDigestMatched = replay.captured !== undefined &&
    createSha256(replay.captured.prompt) === evaluationCase.expectedPromptSha256
  if (!promptDigestMatched) failures.push('prompt-serialization-digest')

  const systemInstructionsDigestMatched = replay.captured !== undefined &&
    createSha256(replay.captured.systemInstructions) === provenance.systemInstructionsSha256
  if (!systemInstructionsDigestMatched) failures.push('prompt-system-instructions-digest')

  if (
    replay.captured === undefined ||
    replay.captured.modelId !== provenance.modelId ||
    replay.captured.maxOutputTokens !== evaluationCase.budgets.maxOutputTokens ||
    replay.captured.timeoutMs !== evaluationCase.budgets.maxLatencyMs ||
    replay.captured.traceId !== createOfflineTraceId(evaluationCase.id)
  ) failures.push('gateway-config-mismatch')

  const parsed = replay.generation
  if (!parsed) {
    return {
      id: evaluationCase.id,
      passed: false,
      failures: uniqueFailures(failures),
    }
  }

  if (parsed.draft.kind !== evaluationCase.modelInput.task) failures.push('task-mismatch')

  const claims = collectClaims(parsed.draft)
  const authorizedCitationIds = new Set(
    evaluationCase.modelInput.citations.map((citation) => citation.id),
  )
  const citedClaimCount = claims.filter((claim) => claim.citationIds.length > 0).length
  const unknownCitationCount = claims.reduce(
    (count, claim) => count + claim.citationIds.filter(
      (citationId) => !authorizedCitationIds.has(citationId),
    ).length,
    0,
  )
  const unknownAllowedValueCount = countUnknownAllowedValues(
    parsed.draft,
    evaluationCase.modelInput.allowedValues,
  )
  const serializedOutput = JSON.stringify({
    draft: parsed.draft,
    uncertainty: parsed.uncertainty,
  })
  const normalizedOutput = serializedOutput.toLocaleLowerCase('en-US')
  const missingRequiredTextCount = evaluationCase.requiredTextFragments.filter(
    (fragment) => !normalizedOutput.includes(fragment.toLocaleLowerCase('en-US')),
  ).length
  const forbiddenSubstringMatchCount = evaluationCase.forbiddenSubstrings.filter(
    (value) => normalizedOutput.includes(value.toLocaleLowerCase('en-US')),
  ).length
  const redactedSerializedOutput = JSON.stringify({
    draft: redactAiAssistanceDraft(parsed.draft),
    uncertainty: redactAiAssistanceUncertainty(parsed.uncertainty),
  })
  const privacyComparableOutput = JSON.stringify({
    draft: normalizeModelOwnedRowIdsForPrivacyComparison(parsed.draft),
    uncertainty: parsed.uncertainty,
  })
  const redactableCredentialMatchCount = redactedSerializedOutput === privacyComparableOutput
    ? 0
    : 1
  const forbiddenMatchCount = forbiddenSubstringMatchCount + redactableCredentialMatchCount
  const citationCoverage = claims.length === 0 ? 1 : citedClaimCount / claims.length
  const searchFiltersMatch = evaluationCase.expectedSearchFilters === undefined
    ? undefined
    : parsed.draft.kind === 'search' && isDeepStrictEqual(
      parsed.draft.filters,
      evaluationCase.expectedSearchFilters,
    )

  if (claims.length < evaluationCase.minimumClaimCount) failures.push('quality-claim-count')
  if (citationCoverage !== 1) failures.push('citation-coverage')
  if (unknownCitationCount > 0) failures.push('citation-unknown')
  if (unknownAllowedValueCount > 0) failures.push('allowed-value-unknown')
  if (missingRequiredTextCount > 0) failures.push('quality-required-text')
  if (forbiddenMatchCount > 0) failures.push('safety-canary-leak')
  if (searchFiltersMatch === false) failures.push('search-filter-mismatch')

  const inputTokens = parsed.usage.inputTokens ?? 0
  const outputTokens = parsed.usage.outputTokens ?? 0
  if (
    parsed.usage.inputTokens === undefined ||
    inputTokens > evaluationCase.budgets.maxInputTokens
  ) failures.push('budget-input-tokens')
  if (
    parsed.usage.outputTokens === undefined ||
    outputTokens > evaluationCase.budgets.maxOutputTokens
  ) failures.push('budget-output-tokens')
  if (parsed.usage.latencyMs > evaluationCase.budgets.maxLatencyMs) {
    failures.push('budget-latency')
  }
  if (
    evaluationCase.budgets.maxCostUsd !== undefined &&
    (
      parsed.usage.costUsd === undefined ||
      parsed.usage.costUsd > evaluationCase.budgets.maxCostUsd
    )
  ) failures.push('budget-cost')

  const uniqueCaseFailures = uniqueFailures(failures)
  return {
    id: evaluationCase.id,
    passed: uniqueCaseFailures.length === 0,
    failures: uniqueCaseFailures,
    metrics: {
      promptDigestMatched,
      claimCount: claims.length,
      citationCoverage,
      unknownCitationCount,
      unknownAllowedValueCount,
      missingRequiredTextCount,
      forbiddenMatchCount,
      ...(searchFiltersMatch === undefined ? {} : { searchFiltersMatch }),
      inputTokens,
      outputTokens,
      latencyMs: parsed.usage.latencyMs,
      ...(parsed.usage.costUsd === undefined ? {} : { costUsd: parsed.usage.costUsd }),
    },
  }
}

/**
 * Applies only the server-owned row ID normalization that is unrelated to credential redaction.
 *
 * @param draft - Strict provider draft before the application privacy transform.
 * @returns Draft with the same deterministic row identifiers used by production disclosure.
 */
function normalizeModelOwnedRowIdsForPrivacyComparison(
  draft: AiAssistanceDraft,
): AiAssistanceDraft {
  if (draft.kind === 'summary') {
    return {
      ...draft,
      overview: { ...draft.overview, id: 'summary-overview-1' },
      decisions: draft.decisions.map((item, index) => ({
        ...item,
        id: `summary-decision-${index + 1}`,
      })),
      actions: draft.actions.map((item, index) => ({
        ...item,
        id: `summary-action-${index + 1}`,
      })),
      risks: draft.risks.map((item, index) => ({
        ...item,
        id: `summary-risk-${index + 1}`,
      })),
    }
  }
  if (draft.kind === 'planning') {
    return {
      ...draft,
      subtasks: draft.subtasks.map((subtask, index) => ({
        ...subtask,
        id: `planning-subtask-${index + 1}`,
      })),
      dependencies: draft.dependencies.map((dependency, index) => ({
        ...dependency,
        id: `planning-dependency-${index + 1}`,
      })),
    }
  }
  return draft
}

/** Replays one recorded provider response through the production Mastra gateway boundary. */
async function replayProductionGateway(
  evaluationCase: AiAssistanceOfflineInputCase,
  recordedOutput: AiAssistanceOfflineRecordedOutput,
  provenance: AiAssistanceOfflineInputProvenance,
): Promise<OfflineGatewayReplay> {
  let captured: CapturedGatewayBoundary | undefined
  let clockReadCount = 0
  const gateway = createMastraBedrockAiModelGateway({
    runStructuredGeneration: async (input) => {
      captured = captureGatewayBoundary(input)
      return {
        object: recordedOutput.modelOutput,
        inputTokens: recordedOutput.usage.inputTokens,
        outputTokens: recordedOutput.usage.outputTokens,
        traceId: `recorded-${evaluationCase.id}`,
      }
    },
    pricingByModelId: {
      [provenance.modelId]: provenance.pricing,
    },
    nowMilliseconds: () => {
      clockReadCount += 1
      return clockReadCount === 1 ? 0 : recordedOutput.usage.latencyMs
    },
  })

  try {
    const generation = await gateway.generate({
      ...evaluationCase.modelInput,
      modelId: provenance.modelId,
      traceId: createOfflineTraceId(evaluationCase.id),
      maxOutputTokens: evaluationCase.budgets.maxOutputTokens,
      timeoutMs: evaluationCase.budgets.maxLatencyMs,
    })
    return { ...(captured ? { captured } : {}), generation }
  } catch (error) {
    return {
      ...(captured ? { captured } : {}),
      failure: error instanceof AiAssistanceError &&
        error.code === 'InvalidAiAssistanceOutput'
        ? 'schema-invalid'
        : 'gateway-boundary-failed',
    }
  }
}

/** Copies content-bearing runner input into a short-lived comparison boundary. */
function captureGatewayBoundary(
  input: MastraStructuredGenerationInput,
): CapturedGatewayBoundary {
  return {
    systemInstructions: input.systemInstructions,
    prompt: input.prompt,
    modelId: input.modelId,
    maxOutputTokens: input.maxOutputTokens,
    timeoutMs: input.timeoutMs,
    traceId: input.traceId,
  }
}

/** Finds provenance or sanitization regressions before output quality scoring. */
function collectInputAndProvenanceFailures(
  evaluationCase: AiAssistanceOfflineInputCase,
  provenance: AiAssistanceOfflineInputProvenance,
): string[] {
  const failures: string[] = []
  if (provenance.schemaVersion !== AI_ASSISTANCE_SCHEMA_VERSION) {
    failures.push('provenance-schema-version')
  }
  if (evaluationCase.modelInput.promptVersion !== provenance.promptVersion) {
    failures.push('provenance-prompt-version')
  }
  if (evaluationCase.modelInput.request.task !== evaluationCase.modelInput.task) {
    failures.push('input-task-mismatch')
  }
  if (provenance.modelId !== provenance.inferenceProfileId) {
    failures.push('provenance-model-profile')
  }
  if (!isSanitizedModelInput(evaluationCase)) failures.push('input-not-sanitized')
  return failures
}

/** Verifies that the recorded input is already stable under production redaction. */
function isSanitizedModelInput(evaluationCase: AiAssistanceOfflineInputCase): boolean {
  const input = evaluationCase.modelInput
  if (!isDeepStrictEqual(
    redactGenerateAiAssistanceRequest(input.request),
    input.request,
  )) return false
  if (!isDeepStrictEqual(
    input.citations.map((citation) => redactAiAssistanceCitation(citation)),
    input.citations,
  )) return false
  return redactAiAssistanceText(input.promptContext) === input.promptContext &&
    redactAiAssistanceText(JSON.stringify(input.allowedValues)) ===
      JSON.stringify(input.allowedValues)
}

/** Collects all evidence-bearing claims from one production-shaped draft. */
function collectClaims(draft: AiAssistanceDraft): EvaluatedClaim[] {
  if (draft.kind === 'search') return []
  if (draft.kind === 'summary') {
    return [
      draft.overview,
      ...draft.decisions,
      ...draft.actions,
      ...draft.risks,
    ].map((item) => ({ citationIds: item.citationIds }))
  }
  if (draft.kind === 'triage') {
    return [
      draft.title,
      draft.description,
      draft.priority,
      draft.assigneeUserId,
      draft.teamId,
      draft.projectId,
      ...draft.customFields,
    ].flatMap((suggestion) => suggestion === undefined
      ? []
      : [{ citationIds: suggestion.citationIds }])
  }
  return [
    draft.title,
    draft.description,
    draft.priority,
    draft.status,
    draft.plannedEffortMinutes,
    ...draft.subtasks,
    ...draft.dependencies,
    draft.statusUpdate,
  ].flatMap((suggestion) => suggestion === undefined
    ? []
    : [{ citationIds: suggestion.citationIds }])
}

/** Counts model-emitted resource identifiers absent from the authorized allowlists. */
function countUnknownAllowedValues(
  draft: AiAssistanceDraft,
  allowedValues: AiAssistanceAllowedValues,
): number {
  if (draft.kind === 'summary') return 0
  if (draft.kind === 'triage') {
    return countUnknownOptionalValue(draft.assigneeUserId?.value, allowedValues.assigneeUserIds) +
      countUnknownOptionalValue(draft.teamId?.value, allowedValues.teamIds) +
      countUnknownOptionalValue(draft.projectId?.value, allowedValues.projectIds) +
      draft.customFields.filter(
        (field) => !allowedValues.customFieldIds.includes(field.fieldId),
      ).length
  }
  if (draft.kind === 'search') {
    return countUnknownValues(draft.filters.assigneeUserIds, allowedValues.assigneeUserIds) +
      countUnknownValues(draft.filters.creatorUserIds, allowedValues.creatorUserIds) +
      countUnknownValues(draft.filters.teamIds, allowedValues.teamIds) +
      countUnknownValues(draft.filters.projectIds, allowedValues.projectIds) +
      countUnknownValues(draft.filters.statuses, allowedValues.statuses) +
      countUnknownValues(draft.filters.relationIds, allowedValues.relationIds) +
      (draft.filters.customFields ?? []).filter(
        (field) => !allowedValues.customFieldIds.includes(field.fieldId),
      ).length
  }
  return countUnknownOptionalValue(draft.status?.value, allowedValues.statuses) +
    draft.dependencies.reduce((count, dependency) => count +
      countUnknownEndpoint(dependency.predecessor, allowedValues) +
      countUnknownEndpoint(dependency.successor, allowedValues), 0)
}

/** Counts one optional identifier when it is absent from its allowlist. */
function countUnknownOptionalValue(
  value: string | undefined,
  allowedValues: readonly string[],
): number {
  return value !== undefined && !allowedValues.includes(value) ? 1 : 0
}

/** Counts identifiers absent from one allowlist. */
function countUnknownValues(
  values: readonly string[] | undefined,
  allowedValues: readonly string[],
): number {
  return values?.filter((value) => !allowedValues.includes(value)).length ?? 0
}

/** Counts one Work Item endpoint when the complete pair is not allowlisted. */
function countUnknownEndpoint(
  endpoint: { readonly teamId: string; readonly workItemId: string },
  allowedValues: AiAssistanceAllowedValues,
): number {
  return allowedValues.workItemEndpoints.some(
    (allowed) => allowed.teamId === endpoint.teamId &&
      allowed.workItemId === endpoint.workItemId,
  ) ? 0 : 1
}

/** Creates a deterministic trace identifier without tenant or source content. */
function createOfflineTraceId(caseId: string): string {
  return `offline-eval-${caseId}`
}

/** Creates a lowercase SHA-256 digest for a reviewed non-secret prompt fixture. */
function createSha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Removes duplicate failure codes while preserving deterministic order. */
function uniqueFailures(failures: readonly string[]): string[] {
  return [...new Set(failures)]
}

/** Creates report-safe provenance without copying the numeric price card. */
function createReportProvenance(
  provenance: AiAssistanceOfflineInputProvenance,
  outputRevision: string,
): AiAssistanceOfflineEvalProvenance {
  return {
    datasetRevision: provenance.datasetRevision,
    provider: provenance.provider,
    modelId: provenance.modelId,
    inferenceProfileId: provenance.inferenceProfileId,
    promptVersion: provenance.promptVersion,
    schemaVersion: provenance.schemaVersion,
    systemInstructionsSha256: provenance.systemInstructionsSha256,
    pricingRevision: provenance.pricingRevision,
    outputRevision,
  }
}

/** Runs the network-free baseline and emits content-free JSON metrics for CI. */
async function main(): Promise<void> {
  if (process.argv.includes('--review-digests')) {
    console.info(JSON.stringify(
      createAiAssistanceOfflineReviewDigests(aiAssistanceOfflineBaseline),
      null,
      2,
    ))
    return
  }
  const report = await evaluateAiAssistanceOffline(aiAssistanceOfflineBaseline)
  console.info(JSON.stringify(report, null, 2))
  if (!report.passed) process.exitCode = 1
}

if (import.meta.main) await main()
