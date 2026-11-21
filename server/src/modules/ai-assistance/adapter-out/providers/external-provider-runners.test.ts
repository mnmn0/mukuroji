import { afterEach, describe, expect, test } from 'bun:test'
import type { MastraStructuredGenerationInput } from '../mastra/mastra-bedrock-ai-model-gateway'
import { runOpenAiStructuredGeneration } from './external-provider-runners'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/** Creates one bounded runner input. */
function createInput(): MastraStructuredGenerationInput {
  return {
    modelId: 'gpt-6.2-sol',
    systemInstructions: 'Return JSON.',
    prompt: 'Find open work.',
    maxOutputTokens: 1_000,
    timeoutMs: 1_000,
    traceId: 'trace-1',
    abortSignal: new AbortController().signal,
  }
}

/**
 * Answers every OpenAI request with one Responses API body.
 *
 * @param body - JSON response body.
 */
function installFetch(body: unknown): void {
  globalThis.fetch = Object.assign(
    async (): Promise<Response> => Response.json(body),
    { preconnect: originalFetch.preconnect },
  )
}

/** Builds a completed Responses API body with the given message content. */
function createResponse(content: unknown[]): Record<string, unknown> {
  return {
    id: 'resp_1',
    object: 'response',
    status: 'completed',
    output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content }],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  }
}

describe('runOpenAiStructuredGeneration', () => {
  test('reports a structured-output refusal as content filtering', async () => {
    installFetch(createResponse([{ type: 'refusal', refusal: 'I cannot help with that.' }]))

    const result = await runOpenAiStructuredGeneration('sk-test-openai-key-000000', createInput())

    expect(result.finishReason).toBe('content-filter')
    expect(result.object).toBeUndefined()
  })

  test('returns parsed JSON text and usage for a completed response', async () => {
    installFetch(createResponse([{ type: 'output_text', text: '{"ok":true}', annotations: [] }]))

    const result = await runOpenAiStructuredGeneration('sk-test-openai-key-000000', createInput())

    expect(result).toMatchObject({
      object: { ok: true },
      finishReason: 'completed',
      inputTokens: 10,
      outputTokens: 2,
      traceId: 'resp_1',
    })
  })
})
