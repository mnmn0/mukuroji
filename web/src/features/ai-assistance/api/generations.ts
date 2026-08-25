import type {
  AiAssistanceGeneration,
  CreateAiAssistanceFeedbackRequest,
  DecideAiAssistanceGenerationRequest,
  GenerateAiAssistanceRequest,
} from '@mukuroji/contracts'
import {
  createMutationHeaders,
  type MutationRequestContext,
} from '../../../shared/api/mutationHeaders'
import { parseAiAssistanceGeneration } from '../model/aiGenerationValidation'
import {
  AiAssistanceApiError,
  resolveAiAssistanceApiBaseUrl,
} from './errors'

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

/** Options for recording a human review decision. */
export type DecideAiAssistanceOptions = {
  /** Bearer access token for the active Workspace member. */
  accessToken: string
  /** Generation whose review outcome is being recorded. */
  generationId: string
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

  return parseGenerationResponse(value)
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

  return parseGenerationResponse(value)
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

/** Converts a validated JSON value into a generation-specific transport result. */
function parseGenerationResponse(value: unknown): AiAssistanceGeneration {
  try {
    return parseAiAssistanceGeneration(value)
  } catch {
    throw new AiAssistanceApiError(
      502,
      'AI assistance API returned an invalid response.',
      'InvalidAiAssistanceResponse',
    )
  }
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
