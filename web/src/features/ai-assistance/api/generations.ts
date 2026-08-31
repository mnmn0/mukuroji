import type {
  AiAssistanceContent,
  AiAssistanceGeneration,
  AiAssistanceTask,
  CreateAiAssistanceFeedbackRequest,
  DecideAiAssistanceGenerationRequest,
  GenerateAiAssistanceRequest,
} from '@mukuroji/contracts'
import {
  createMutationHeaders,
  type MutationRequestContext,
} from '../../../shared/api/mutationHeaders'
import {
  AiAssistanceApiError,
  resolveAiAssistanceApiBaseUrl,
} from './errors'
import { parseAiAssistanceGenerationResponse } from './generationResponse'

const aiAssistanceApiBaseUrl = `${resolveAiAssistanceApiBaseUrl(import.meta.env)}/ai-assistance`
const defaultErrorMessage = 'Unable to complete the AI assistance request.'

/** Parsed JSON and trusted response metadata returned by the AI assistance transport. */
type AiAssistanceJsonResponse = {
  /** Untrusted JSON body returned by the endpoint. */
  readonly body: unknown
  /** Whether the server explicitly identified this response as an idempotency replay. */
  readonly idempotencyReplayed: boolean
}

/** Options shared by explicit AI generation requests. */
export type GenerateAiAssistanceOptions = {
  /** Bearer access token for the active Workspace member. */
  accessToken: string
  /** Versioned generation input from the shared contract. */
  input: GenerateAiAssistanceRequest
  /** Idempotency and correlation headers for the logical mutation. */
  mutationContext: MutationRequestContext
  /** Optional signal used to cancel a user-initiated generation. */
  signal?: AbortSignal
}

/** Options for re-reading one owner-scoped AI generation. */
export type GetAiAssistanceGenerationOptions = {
  /** Bearer access token for the active Workspace member. */
  accessToken: string
  /** Generation whose current disclosure state must be revalidated. */
  generationId: string
  /** Workflow expected by the product surface performing the read. */
  expectedTask: AiAssistanceTask
}

/** Options for revalidating one approved generation immediately before local adoption. */
export type RevalidateApprovedAiAssistanceGenerationOptions = {
  /** Bearer access token for the active Workspace member. */
  accessToken: string
  /** Exact approved generation returned by the decision endpoint. */
  expectedGeneration: AiAssistanceGeneration
}

/** Stable reason returned by a disclosure-safe withheld generation. */
type AiAssistanceWithheldReason = Extract<
  AiAssistanceContent,
  { availability: 'withheld' }
>['reasonCode']

/**
 * Failure raised after the decision endpoint returned successful JSON that cannot represent the
 * reviewed decision safely.
 */
export class AiAssistanceDecisionResponseError extends AiAssistanceApiError {
  /**
   * Creates a provider-classified error that also proves a decision response was received.
   *
   * @param message - Safe explanation of the invalid decision response.
   */
  constructor(message: string) {
    super(502, message, 'InvalidAiAssistanceResponse')
    this.name = 'AiAssistanceDecisionResponseError'
  }
}

/**
 * Options for recording a human review decision.
 *
 * @property accessToken - Bearer access token for the active Workspace member.
 * @property generationId - Generation whose review outcome is being recorded.
 * @property expectedGeneration - Exact generation content reviewed before the decision.
 * @property expectedTask - Workflow task originally reviewed by the operator.
 * @property expectedOutcome - Review outcome requested by the operator.
 * @property input - Revision-fenced human review outcome.
 * @property mutationContext - Idempotency and correlation headers for the mutation.
 */
export type DecideAiAssistanceOptions = {
  /** Bearer access token for the active Workspace member. */
  accessToken: string
  /** Generation whose review outcome is being recorded. */
  generationId: string
  /** Exact generation content that the operator reviewed before deciding. */
  expectedGeneration: AiAssistanceGeneration
  /** Workflow task originally reviewed by the operator. */
  expectedTask: AiAssistanceTask
  /** Review outcome requested by the operator. */
  expectedOutcome: DecideAiAssistanceGenerationRequest['outcome']
  /** Revision-fenced human review outcome. */
  input: DecideAiAssistanceGenerationRequest
  /** Idempotency and correlation headers for the logical mutation. */
  mutationContext: MutationRequestContext
}

/** Options for attaching evaluation feedback to one generation. */
export type CreateAiAssistanceFeedbackOptions = {
  /** Bearer access token for the active Workspace member. */
  accessToken: string
  /** Audited generation receiving the feedback. */
  generationId: string
  /** Coarse feedback rating and optional bounded comment. */
  input: CreateAiAssistanceFeedbackRequest
  /** Idempotency and correlation headers for the logical mutation. */
  mutationContext: MutationRequestContext
}

/**
 * Generates a permission-filtered AI draft without mutating a domain resource.
 *
 * @param options - Authentication, input, mutation context, and optional cancellation signal.
 * @returns The validated audited generation.
 */
export async function generateAiAssistance(
  options: GenerateAiAssistanceOptions,
): Promise<AiAssistanceGeneration> {
  const response = await requestJson(
    `${aiAssistanceApiBaseUrl}/generations`,
    options.accessToken,
    {
      body: JSON.stringify(options.input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(options.mutationContext),
      },
      method: 'POST',
      signal: options.signal,
    },
  )

  try {
    return parseAiAssistanceGenerationResponse(response.body, options.input.task)
  } catch (error) {
    if (
      error instanceof AiAssistanceApiError &&
      error.code === 'InvalidAiAssistanceResponse'
    ) {
      throw new AiAssistanceApiError(
        error.status,
        error.message,
        error.code,
        {
          idempotencyReplayed: response.idempotencyReplayed,
          successfulResponseReceived: true,
        },
      )
    }
    throw error
  }
}

/**
 * Re-reads one generation through the server's current authorization and retention projection.
 *
 * @param options - Authentication, generation identity, and expected workflow.
 * @returns The validated current generation projection.
 */
export async function getAiAssistanceGeneration(
  options: GetAiAssistanceGenerationOptions,
): Promise<AiAssistanceGeneration> {
  const response = await requestJson(
    `${aiAssistanceApiBaseUrl}/generations/${encodeURIComponent(options.generationId)}`,
    options.accessToken,
    {
      cache: 'no-store',
      method: 'GET',
    },
  )

  return parseAiAssistanceGenerationResponse(response.body, options.expectedTask)
}

/**
 * Revalidates an approved generation immediately before a workflow copies its content locally.
 *
 * @param options - Authentication and the exact approved decision response under review.
 * @returns The matching currently available generation returned by the read boundary.
 * @throws AiAssistanceApiError when disclosure is withheld or the read no longer matches.
 */
export async function revalidateApprovedAiAssistanceGeneration(
  options: RevalidateApprovedAiAssistanceGenerationOptions,
): Promise<AiAssistanceGeneration> {
  const generation = await getAiAssistanceGeneration({
    accessToken: options.accessToken,
    expectedTask: options.expectedGeneration.task,
    generationId: options.expectedGeneration.id,
  })
  if (generation.content.availability === 'withheld') {
    throw createAiAssistanceWithheldError(generation.content.reasonCode)
  }
  if (!isApprovedAiAssistanceRevalidationConsistent(
    generation,
    options.expectedGeneration,
  )) {
    throw new AiAssistanceApiError(
      502,
      'AI assistance revalidation returned a generation different from the approved draft.',
      'InvalidAiAssistanceResponse',
    )
  }
  return generation
}

/**
 * Records approval or rejection without applying the draft to a domain resource.
 *
 * @param options - Authentication, generation identity, revision, and mutation context.
 * @returns The updated validated generation.
 */
export async function decideAiAssistanceGeneration(
  options: DecideAiAssistanceOptions,
): Promise<AiAssistanceGeneration> {
  const response = await requestJson(
    `${aiAssistanceApiBaseUrl}/generations/${encodeURIComponent(options.generationId)}/decision`,
    options.accessToken,
    {
      body: JSON.stringify(options.input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(options.mutationContext),
      },
      method: 'POST',
    },
  )

  let generation: AiAssistanceGeneration
  try {
    generation = parseAiAssistanceGenerationResponse(response.body, options.expectedTask)
  } catch (error) {
    if (
      error instanceof AiAssistanceApiError &&
      error.code === 'InvalidAiAssistanceResponse'
    ) {
      throw new AiAssistanceDecisionResponseError(
        'AI assistance decision returned an invalid generation.',
      )
    }
    throw error
  }
  if (generation.decision?.outcome !== options.expectedOutcome) {
    throw new AiAssistanceDecisionResponseError(
      'AI assistance decision returned an unexpected outcome.',
    )
  }
  if (!isDecisionGenerationEnvelopeConsistent(generation, options.expectedGeneration)) {
    throw new AiAssistanceDecisionResponseError(
      'AI assistance decision returned a generation different from the reviewed generation.',
    )
  }
  return generation
}

/**
 * Verifies that a decision response preserves the reviewed generation envelope.
 *
 * A server-authoritative withholding is the only permitted content change: it removes
 * disclosure after access or retention changes and never introduces new model output.
 * The decision and optimistic-concurrency revision are intentionally allowed to change.
 *
 * @param generation - Parsed decision response returned by the server.
 * @param expectedGeneration - Generation whose content and audit metadata were reviewed.
 * @returns Whether the response is safe to replace the reviewed generation in local state.
 */
function isDecisionGenerationEnvelopeConsistent(
  generation: AiAssistanceGeneration,
  expectedGeneration: AiAssistanceGeneration,
): boolean {
  const immutableEnvelopeMatches = generation.schemaVersion === expectedGeneration.schemaVersion &&
    generation.id === expectedGeneration.id &&
    generation.task === expectedGeneration.task &&
    stableSerialize(generation.details) === stableSerialize(expectedGeneration.details) &&
    generation.createdAt === expectedGeneration.createdAt &&
    generation.expiresAt === expectedGeneration.expiresAt
  if (!immutableEnvelopeMatches) return false

  if (stableSerialize(generation.content) === stableSerialize(expectedGeneration.content)) {
    return true
  }

  return expectedGeneration.content.availability === 'available' &&
    generation.content.availability === 'withheld'
}

/**
 * Checks that a fresh generation read is the exact available draft approved by the operator.
 *
 * @param generation - Current generation returned by the authorization-aware GET endpoint.
 * @param expectedGeneration - Approved generation returned by the decision endpoint.
 * @returns Whether adoption may continue with the freshly revalidated generation.
 */
export function isApprovedAiAssistanceRevalidationConsistent(
  generation: AiAssistanceGeneration,
  expectedGeneration: AiAssistanceGeneration,
): boolean {
  return generation.content.availability === 'available' &&
    expectedGeneration.content.availability === 'available' &&
    generation.schemaVersion === expectedGeneration.schemaVersion &&
    generation.id === expectedGeneration.id &&
    generation.task === expectedGeneration.task &&
    generation.revision === expectedGeneration.revision &&
    generation.decision?.outcome === 'approved' &&
    expectedGeneration.decision?.outcome === 'approved' &&
    generation.decision.decidedAt === expectedGeneration.decision.decidedAt &&
    generation.createdAt === expectedGeneration.createdAt &&
    Date.parse(generation.expiresAt) <= Date.parse(expectedGeneration.expiresAt) &&
    stableSerialize(generation.details) === stableSerialize(expectedGeneration.details) &&
    stableSerialize(generation.content) === stableSerialize(expectedGeneration.content)
}

/**
 * Converts a withheld projection into a non-sensitive failure understood by the controller.
 *
 * @param reasonCode - Server-authoritative reason that content can no longer be disclosed.
 * @returns An API error whose status maps to the existing permission or conflict UI.
 */
export function createAiAssistanceWithheldError(
  reasonCode: AiAssistanceWithheldReason,
): AiAssistanceApiError {
  if (reasonCode === 'permission-changed') {
    return new AiAssistanceApiError(
      403,
      'AI assistance content is no longer available because access changed.',
      'AiAssistanceAuthorizationChanged',
    )
  }
  if (reasonCode === 'source-changed') {
    return new AiAssistanceApiError(
      409,
      'AI assistance content is no longer available because a source changed.',
      'AiAssistanceSourceChanged',
    )
  }
  return new AiAssistanceApiError(
    409,
    'AI assistance content is no longer available because its retention period ended.',
    'AiAssistanceRetentionExpired',
  )
}

/**
 * Serializes validated JSON values with deterministic object-key ordering.
 *
 * @param value - JSON-compatible value from a validated AI response.
 * @returns A stable representation suitable for exact content comparison.
 */
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/**
 * Records usefulness feedback for an audited generation.
 *
 * @param options - Authentication, generation identity, feedback, and mutation context.
 * @returns A promise that resolves after the server accepts the feedback.
 */
export async function createAiAssistanceFeedback(
  options: CreateAiAssistanceFeedbackOptions,
): Promise<void> {
  await requestJson(
    `${aiAssistanceApiBaseUrl}/generations/${encodeURIComponent(options.generationId)}/feedback`,
    options.accessToken,
    {
      body: JSON.stringify(options.input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(options.mutationContext),
      },
      method: 'POST',
    },
    true,
  )
}

/** Performs one authenticated JSON request and converts stable API failures. */
async function requestJson(
  url: string,
  accessToken: string,
  init: RequestInit,
  allowEmptyResponse = false,
): Promise<AiAssistanceJsonResponse> {
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...init.headers,
      },
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new AiAssistanceApiError(0, defaultErrorMessage, 'AiAssistanceNetworkError')
  }

  const idempotencyReplayed = hasConfirmedIdempotencyReplay(response)
  const value = await readJson(response, allowEmptyResponse, idempotencyReplayed)
  if (!response.ok) {
    const error = isRecord(value) ? value : {}
    throw new AiAssistanceApiError(
      response.status,
      typeof error.message === 'string' ? error.message : defaultErrorMessage,
      typeof error.code === 'string' ? error.code : undefined,
      { idempotencyReplayed },
    )
  }

  return {
    body: value,
    idempotencyReplayed,
  }
}

/** Reads JSON while accepting the feedback endpoint's empty success response. */
async function readJson(
  response: Response,
  allowEmptyResponse: boolean,
  idempotencyReplayed: boolean,
): Promise<unknown> {
  let text: string
  try {
    text = await response.text()
  } catch {
    throw new AiAssistanceApiError(
      0,
      defaultErrorMessage,
      'AiAssistanceNetworkError',
      {
        idempotencyReplayed,
        successfulResponseReceived: response.ok,
      },
    )
  }
  if (!text) {
    if (allowEmptyResponse && response.ok) return undefined
    throw new AiAssistanceApiError(
      response.status,
      'AI assistance API returned an empty response.',
      'InvalidAiAssistanceResponse',
      {
        idempotencyReplayed,
        successfulResponseReceived: response.ok,
      },
    )
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new AiAssistanceApiError(
      response.status,
      'AI assistance API returned invalid JSON.',
      'InvalidAiAssistanceResponse',
      {
        idempotencyReplayed,
        successfulResponseReceived: response.ok,
      },
    )
  }
}

/**
 * Accepts only the canonical server replay marker and rejects malformed header values.
 *
 * @param response - HTTP response whose server-owned replay metadata is being inspected.
 * @returns Whether the response contains the exact canonical replay marker.
 */
function hasConfirmedIdempotencyReplay(response: Response): boolean {
  return response.headers.get('Idempotency-Replayed') === 'true'
}

/** Narrows an unknown JSON value to a record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
