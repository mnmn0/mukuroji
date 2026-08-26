import type { AiAssistanceGeneration, AiAssistanceTask } from '@mukuroji/contracts'
import { AiAssistanceApiError } from './errors'
import { isAiAssistanceGeneration } from '../model/aiGenerationValidation'

/**
 * Converts an untrusted AI generation response into a validated transport value.
 *
 * @param value - Unknown JSON returned by the AI assistance endpoint.
 * @param expectedTask - Optional workflow requested by the caller.
 * @returns A generation that satisfies the complete public contract.
 * @throws AiAssistanceApiError when the response shape is unsafe to expose.
 */
export function parseAiAssistanceGenerationResponse(
  value: unknown,
  expectedTask?: AiAssistanceTask,
): AiAssistanceGeneration {
  if (isAiAssistanceGeneration(value) &&
    (expectedTask === undefined || value.task === expectedTask)) return value
  throw new AiAssistanceApiError(
    502,
    'AI assistance API returned an invalid response.',
    'InvalidAiAssistanceResponse',
  )
}
