import { describe, expect, test } from 'bun:test'
import { AiAssistanceApiError } from '../src/features/ai-assistance/api/errors'
import { isRetryableAiAssistanceSettingsError } from '../src/features/ai-assistance/queries/useAiAssistanceSettings'

describe('AI assistance settings query retry policy', () => {
  /** Keeps terminal client and permission failures from being retried. */
  test('does not retry 4xx API failures', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isRetryableAiAssistanceSettingsError(new AiAssistanceApiError(status, 'failed'))).toBe(false)
    }
  })

  /** Retries transient server and transport failures. */
  test('retries server and network failures', () => {
    expect(isRetryableAiAssistanceSettingsError(new AiAssistanceApiError(500, 'failed'))).toBe(true)
    expect(isRetryableAiAssistanceSettingsError(new Error('network failed'))).toBe(true)
  })
})
