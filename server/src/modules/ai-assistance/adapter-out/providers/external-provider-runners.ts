import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { AiAssistanceExternalProvider } from '@mukuroji/contracts'
import OpenAI from 'openai'
import { z } from 'zod'
import { aiAssistanceModelOutputSchema } from '../../application/validation/ai-assistance-schema'
import type {
  MastraStructuredGenerationInput,
  MastraStructuredGenerationResult,
} from '../mastra/mastra-bedrock-ai-model-gateway'

/** One structured call to an external provider with a Workspace API key. */
export type ExternalProviderRunner = (
  apiKey: string,
  input: MastraStructuredGenerationInput,
) => Promise<MastraStructuredGenerationResult>

/** Thinking setting per reviewed Claude model; Opus 5.5 cannot disable thinking, so it runs at low effort. */
const ANTHROPIC_THINKING: Readonly<Record<string, Anthropic.ThinkingConfigParam | undefined>> = {
  'claude-sonnet-5-5': { type: 'between_tools' },
  'claude-haiku-5-5': { type: 'disabled' },
  'claude-opus-5-5': undefined,
}

/**
 * Calls the Claude API once with strict JSON structured output and no tools.
 *
 * Retries are disabled so one budget reservation maps to at most one paid call,
 * matching the Bedrock path. A refusal stop reason maps to the same
 * content-filter finish reason that the gateway records as a model refusal.
 *
 * @param apiKey - Workspace Claude API key.
 * @param input - Bounded prompt, model, deadline, and abort signal.
 * @returns Unvalidated structured object and usage for the gateway to re-validate.
 */
export const runAnthropicStructuredGeneration: ExternalProviderRunner = async (apiKey, input) => {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: input.timeoutMs })
  const thinking = ANTHROPIC_THINKING[input.modelId]
  const response = await client.messages.create(
    {
      model: input.modelId,
      max_tokens: input.maxOutputTokens,
      system: input.systemInstructions,
      messages: [{ role: 'user', content: input.prompt }],
      output_config: {
        effort: 'low',
        format: zodOutputFormat(aiAssistanceModelOutputSchema),
      },
      ...(thinking === undefined ? {} : { thinking }),
    },
    { signal: input.abortSignal },
  )
  const text = response.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
  return {
    object: parseJsonOrUndefined(text),
    finishReason: response.stop_reason === 'refusal' ? 'content-filter' : response.stop_reason,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    traceId: response.id,
  }
}

/** JSON Schema sent to OpenAI; the gateway still enforces the strict Zod schema afterwards. */
const OPENAI_OUTPUT_JSON_SCHEMA: Record<string, unknown> = z.toJSONSchema(
  aiAssistanceModelOutputSchema,
  { io: 'output', unrepresentable: 'any' },
)

/**
 * Calls the OpenAI Responses API once with JSON-schema output and no tools.
 *
 * @param apiKey - Workspace OpenAI API key.
 * @param input - Bounded prompt, model, deadline, and abort signal.
 * @returns Unvalidated structured object and usage for the gateway to re-validate.
 */
export const runOpenAiStructuredGeneration: ExternalProviderRunner = async (apiKey, input) => {
  const client = new OpenAI({ apiKey, maxRetries: 0, timeout: input.timeoutMs })
  const response = await client.responses.create(
    {
      model: input.modelId,
      instructions: input.systemInstructions,
      input: input.prompt,
      max_output_tokens: input.maxOutputTokens,
      reasoning: { effort: 'low' },
      store: false,
      text: {
        format: {
          type: 'json_schema',
          name: 'mukuroji_ai_assistance',
          schema: OPENAI_OUTPUT_JSON_SCHEMA,
          strict: false,
        },
      },
    },
    { signal: input.abortSignal },
  )
  const contentFiltered = response.status === 'incomplete' &&
    response.incomplete_details?.reason === 'content_filter'
  return {
    object: parseJsonOrUndefined(response.output_text),
    finishReason: contentFiltered ? 'content-filter' : response.status,
    ...(response.usage === undefined || response.usage === null
      ? {}
      : {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        }),
    traceId: response.id,
  }
}

/** Runner used for each external provider. */
export const EXTERNAL_PROVIDER_RUNNERS: Readonly<
  Record<AiAssistanceExternalProvider, ExternalProviderRunner>
> = {
  anthropic: runAnthropicStructuredGeneration,
  openai: runOpenAiStructuredGeneration,
}

/**
 * Parses model text as JSON; invalid text becomes undefined so strict validation reports invalid output.
 *
 * @param text - Raw model text.
 * @returns Parsed JSON value or undefined.
 */
function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
