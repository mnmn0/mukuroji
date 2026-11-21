import { afterEach, describe, expect, test } from 'bun:test'
import type { MastraStructuredGenerationInput } from '../mastra/mastra-bedrock-ai-model-gateway'
import {
  runAnthropicStructuredGeneration,
  runOpenAiStructuredGeneration,
} from './external-provider-runners'

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

describe('runAnthropicStructuredGeneration', () => {
  test('sends the output schema as instructions instead of a strict structured-output grammar', async () => {
    const requests: unknown[] = []
    globalThis.fetch = Object.assign(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        requests.push(typeof init?.body === 'string' ? JSON.parse(init.body) : undefined)
        return Response.json({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-5-5',
          content: [{ type: 'text', text: '```json\n{"ok":true}\n```' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 2 },
        })
      },
      { preconnect: originalFetch.preconnect },
    )

    const result = await runAnthropicStructuredGeneration('sk-ant-test-key-000000', {
      ...createInput(),
      modelId: 'claude-haiku-5-5',
    })

    expect(result).toMatchObject({
      object: { ok: true },
      finishReason: 'end_turn',
      inputTokens: 10,
      outputTokens: 2,
      traceId: 'msg_1',
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ output_config: { effort: 'low' } })
    expect(requests[0]).not.toHaveProperty('output_config.format')
    expect(JSON.stringify(requests[0])).toContain('The object must match this JSON Schema')
  })
})
