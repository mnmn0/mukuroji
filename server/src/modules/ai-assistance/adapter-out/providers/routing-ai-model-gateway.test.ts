import { describe, expect, test } from 'bun:test'
import type { AiModelGenerationInput } from '../../application/ports/ai-assistance-ports'
import { AiAssistanceError } from '../../errors'
import { createRoutingAiModelGateway } from './routing-ai-model-gateway'

/** Creates one gateway input for the given model. */
function createInput(modelId: string): AiModelGenerationInput {
  return {
    workspaceId: 'workspace-1',
    modelId,
    task: 'search',
    locale: 'ja',
    promptVersion: 'ai-assistance-v1',
    request: { task: 'search', locale: 'ja', query: '未完了の項目' },
    promptContext: 'Visible search catalog.',
    citations: [],
    allowedValues: {
      assigneeUserIds: [],
      creatorUserIds: [],
      teamIds: [],
      projectIds: [],
      workItemTypeIds: [],
      customFieldIds: [],
      relationIds: [],
      statuses: ['todo'],
      workItemEndpoints: [],
    },
    traceId: 'trace-1',
    maxOutputTokens: 1_000,
    timeoutMs: 100,
    async onProviderDispatch() {},
  }
}

/** Strict search output returned by fake runners. */
const searchOutput = {
  draft: {
    kind: 'search',
    interpretation: '未完了の項目です。',
    filters: { statuses: ['todo'] },
    caveats: [],
  },
  uncertainty: { level: 'low', reason: '明確です。' },
}

describe('createRoutingAiModelGateway', () => {
  test('sends a Claude model to the Anthropic runner with the Workspace key and catalog price', async () => {
    const calls: Array<{ apiKey: string, modelId: string }> = []
    const resolved: string[] = []
    let clock = 0
    const gateway = createRoutingAiModelGateway({
      resolveApiKey: async (workspaceId, provider) => {
        resolved.push(`${workspaceId}:${provider}`)
        return 'sk-ant-test-key-0000000000'
      },
      runners: {
        anthropic: async (apiKey, input) => {
          calls.push({ apiKey, modelId: input.modelId })
          clock = 40
          return { object: searchOutput, inputTokens: 1_000_000, outputTokens: 100_000 }
        },
      },
      nowMilliseconds: () => clock,
    })

    const result = await gateway.generate(createInput('claude-sonnet-5-5'))

    expect(resolved).toEqual(['workspace-1:anthropic'])
    expect(calls).toEqual([{ apiKey: 'sk-ant-test-key-0000000000', modelId: 'claude-sonnet-5-5' }])
    // $2 per million input tokens and $10 per million output tokens.
    expect(result.usage).toEqual({
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      latencyMs: 40,
      costUsd: 3,
    })
  })

  test('sends an OpenAI model to the OpenAI runner', async () => {
    const providers: string[] = []
    const gateway = createRoutingAiModelGateway({
      resolveApiKey: async (_workspaceId, provider) => {
        providers.push(provider)
        return 'sk-openai-test-key-000000'
      },
      runners: {
        openai: async () => ({ object: searchOutput, inputTokens: 1, outputTokens: 1 }),
      },
    })

    await gateway.generate(createInput('gpt-6.2-sol'))

    expect(providers).toEqual(['openai'])
  })

  test('keeps Bedrock models on the Bedrock gateway without reading any key', async () => {
    const bedrockModels: string[] = []
    const gateway = createRoutingAiModelGateway({
      bedrock: {
        async generate(input) {
          bedrockModels.push(input.modelId)
          return {
            draft: {
              kind: 'search',
              interpretation: '未完了の項目です。',
              filters: { statuses: ['todo'] },
              caveats: [],
            },
            uncertainty: { level: 'low', reason: '明確です。' },
            usage: { latencyMs: 1, costUnavailableReason: 'pricing-not-configured' },
          }
        },
      },
      resolveApiKey: async () => {
        throw new Error('must not read a key for Bedrock')
      },
    })

    await gateway.generate(createInput('jp.anthropic.claude-sonnet-4-6'))

    expect(bedrockModels).toEqual(['jp.anthropic.claude-sonnet-4-6'])
  })

  test('fails without calling a provider when the key was removed mid-request', async () => {
    let runnerCalled = false
    const gateway = createRoutingAiModelGateway({
      resolveApiKey: async () => undefined,
      runners: {
        anthropic: async () => {
          runnerCalled = true
          return { object: searchOutput }
        },
      },
    })

    const error = await gateway.generate(createInput('claude-opus-5-5')).catch((caught) => caught)

    expect(error).toBeInstanceOf(AiAssistanceError)
    expect(error.code).toBe('AiAssistanceProviderError')
    expect(runnerCalled).toBe(false)
  })

  test('rejects a non-catalog model when Bedrock is not configured', async () => {
    const gateway = createRoutingAiModelGateway({ resolveApiKey: async () => undefined })

    const error = await gateway.generate(createInput('unknown-model')).catch((caught) => caught)

    expect(error.code).toBe('AiAssistanceModelNotAllowed')
  })
})
