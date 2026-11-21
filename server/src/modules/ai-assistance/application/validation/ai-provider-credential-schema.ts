import type {
  AiAssistanceExternalProvider,
  DeleteAiAssistanceProviderCredentialRequest,
  PutAiAssistanceProviderCredentialRequest,
} from '@mukuroji/contracts'
import { z } from 'zod'
import { AiAssistanceError } from '../../errors'

/** Key prefixes published by each provider; checked so a key is not pasted into the wrong slot. */
const API_KEY_PREFIXES: Readonly<Record<AiAssistanceExternalProvider, string>> = {
  anthropic: 'sk-ant-',
  openai: 'sk-',
}

const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

const putSchema = z.object({
  apiKey: z.string().regex(/^[\x21-\x7E]{20,512}$/u),
  expectedRevision: revisionSchema,
}).strict()

const deleteSchema = z.object({
  expectedRevision: revisionSchema,
}).strict()

/**
 * Validates a key registration body without echoing the key in errors.
 *
 * @param provider - Provider slot the key is registered for.
 * @param value - Untrusted JSON body.
 * @returns The validated request.
 * @throws AiAssistanceError when the body or key shape is invalid.
 */
export function parsePutAiAssistanceProviderCredentialRequest(
  provider: AiAssistanceExternalProvider,
  value: unknown,
): PutAiAssistanceProviderCredentialRequest {
  const parsed = putSchema.safeParse(value)
  if (!parsed.success || !hasProviderPrefix(provider, parsed.data.apiKey)) {
    throw new AiAssistanceError(
      'validation',
      'InvalidAiAssistanceProviderCredential',
      'The API key does not look like a key for this provider.',
    )
  }
  return parsed.data
}

/**
 * Validates a key removal body.
 *
 * @param value - Untrusted JSON body.
 * @returns The validated request.
 * @throws AiAssistanceError when the body is invalid.
 */
export function parseDeleteAiAssistanceProviderCredentialRequest(
  value: unknown,
): DeleteAiAssistanceProviderCredentialRequest {
  const parsed = deleteSchema.safeParse(value)
  if (!parsed.success) {
    throw new AiAssistanceError(
      'validation',
      'InvalidAiAssistanceRequest',
      'The AI provider key removal request is invalid.',
    )
  }
  return parsed.data
}

/**
 * Checks the published key prefix; an Anthropic key is never accepted as an OpenAI key.
 *
 * @param provider - Provider slot.
 * @param apiKey - Shape-checked key.
 * @returns Whether the key prefix matches the provider.
 */
function hasProviderPrefix(provider: AiAssistanceExternalProvider, apiKey: string): boolean {
  if (provider === 'openai' && apiKey.startsWith(API_KEY_PREFIXES.anthropic)) return false
  return apiKey.startsWith(API_KEY_PREFIXES[provider])
}
