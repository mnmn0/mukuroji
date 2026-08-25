import type { AiAssistanceGeneration } from '@mukuroji/contracts'
import { AiAssistanceApiError } from './errors'
import { isAiAssistanceGeneration } from '../model/aiGenerationValidation'

/**
 * Converts an untrusted AI generation response into a validated transport value.
 *
 * @param value - Unknown JSON returned by the AI assistance endpoint.
 * @returns A generation that satisfies the complete public contract.
 * @throws AiAssistanceApiError when the response shape is unsafe to expose.
 */
export function parseAiAssistanceGenerationResponse(value: unknown): AiAssistanceGeneration {
  if (isAiAssistanceGeneration(value)) return value
  throw new AiAssistanceApiError(
    502,
    'AI assistance API returned an invalid response.',
    'InvalidAiAssistanceResponse',
  )
}
