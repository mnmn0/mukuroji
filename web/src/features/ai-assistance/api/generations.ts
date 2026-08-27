import type {
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
  const value = await requestJson(
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

  return parseAiAssistanceGenerationResponse(value, options.input.task)
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
  const value = await requestJson(
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

  const generation = parseAiAssistanceGenerationResponse(value, options.expectedTask)
  if (generation.decision?.outcome !== options.expectedOutcome) {
    throw new AiAssistanceApiError(
      502,
      'AI assistance decision returned an unexpected outcome.',
      'InvalidAiAssistanceResponse',
    )
  }
  if (
    generation.content.availability === 'available' &&
    stableSerialize(generation.content) !== stableSerialize(options.expectedGeneration.content)
  ) {
    throw new AiAssistanceApiError(
      502,
      'AI assistance decision returned content different from the reviewed generation.',
      'InvalidAiAssistanceResponse',
    )
  }
  return generation
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
): Promise<unknown> {
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

  const value = await readJson(response, allowEmptyResponse)
  if (!response.ok) {
    const error = isRecord(value) ? value : {}
    throw new AiAssistanceApiError(
      response.status,
      typeof error.message === 'string' ? error.message : defaultErrorMessage,
      typeof error.code === 'string' ? error.code : undefined,
    )
  }

  return value
}

/** Reads JSON while accepting the feedback endpoint's empty success response. */
async function readJson(response: Response, allowEmptyResponse: boolean): Promise<unknown> {
  const text = await response.text()
  if (!text) {
    if (allowEmptyResponse && response.ok) return undefined
    throw new AiAssistanceApiError(
      response.status,
      'AI assistance API returned an empty response.',
      'InvalidAiAssistanceResponse',
    )
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new AiAssistanceApiError(
      response.status,
      'AI assistance API returned invalid JSON.',
      'InvalidAiAssistanceResponse',
    )
  }
}

/** Narrows an unknown JSON value to a record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
