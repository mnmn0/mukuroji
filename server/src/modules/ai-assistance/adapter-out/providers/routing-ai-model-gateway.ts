import type { AiAssistanceExternalProvider } from '@mukuroji/contracts'
import type { AiModelGateway } from '../../application/ports/ai-assistance-ports'
import {
  AI_ASSISTANCE_EXTERNAL_MODELS,
  findAiAssistanceExternalModel,
} from '../../domain/ai-assistance-model-catalog'
import { AiAssistanceError } from '../../errors'
import {
  createMastraBedrockAiModelGateway,
  type AiBedrockModelPricing,
} from '../mastra/mastra-bedrock-ai-model-gateway'
import {
  EXTERNAL_PROVIDER_RUNNERS,
  type ExternalProviderRunner,
} from './external-provider-runners'

/** Dependencies of the provider-routing gateway. */
export type RoutingAiModelGatewayOptions = {
  /** Gateway for deployment-allowlisted Bedrock models, when Bedrock is configured. */
  bedrock?: AiModelGateway
  /** Decrypts the Workspace key for one provider, or undefined when none is registered. */
  resolveApiKey(
    workspaceId: string,
    provider: AiAssistanceExternalProvider,
  ): Promise<string | undefined>
  /** Injectable runners used by tests; the SDK runners are used otherwise. */
  runners?: Partial<Record<AiAssistanceExternalProvider, ExternalProviderRunner>>
  /** Monotonic clock forwarded to the shared gateway for latency. */
  nowMilliseconds?: () => number
}

/** Reviewed catalog prices keyed by model ID, used for the audit cost estimate. */
const EXTERNAL_PRICING_BY_MODEL_ID: Readonly<Record<string, AiBedrockModelPricing>> =
  Object.fromEntries(AI_ASSISTANCE_EXTERNAL_MODELS.map((model) => [model.modelId, model.pricing]))

/**
 * Creates a gateway that sends each generation to the provider of its model.
 *
 * External calls reuse the shared gateway's deadline, dispatch-marker, strict
 * output validation, refusal, throttling, and usage handling; only the runner
 * differs. The Workspace key is decrypted per call and never cached.
 *
 * @param options - Bedrock gateway, key resolver, and test hooks.
 * @returns Provider-routing AI model gateway.
 */
export function createRoutingAiModelGateway(
  options: RoutingAiModelGatewayOptions,
): AiModelGateway {
  return {
    async generate(input) {
      const externalModel = findAiAssistanceExternalModel(input.modelId)
      if (externalModel === undefined) {
        if (options.bedrock === undefined) {
          throw new AiAssistanceError(
            'validation',
            'AiAssistanceModelNotAllowed',
            'The selected AI model is not available in this deployment.',
          )
        }
        return await options.bedrock.generate(input)
      }
      const nowMilliseconds = options.nowMilliseconds ?? Date.now
      const resolutionStartedAt = nowMilliseconds()
      const apiKey = await resolveWithinDeadline(
        options.resolveApiKey(input.workspaceId, externalModel.provider),
        input.timeoutMs,
      )
      // Key lookup and KMS decryption spend the same generation deadline, so the
      // provider call only gets what is left and never starts after it expires.
      const remainingTimeoutMs = input.timeoutMs - (nowMilliseconds() - resolutionStartedAt)
      if (remainingTimeoutMs <= 0) throw providerDeadlineError()
      if (apiKey === undefined) {
        // The service checks key presence before reserving budget; reaching
        // here means the key was removed mid-request, so fail as a provider error.
        throw new AiAssistanceError(
          'upstream',
          'AiAssistanceProviderError',
          'The AI provider key is no longer registered.',
        )
      }
      const runner = options.runners?.[externalModel.provider] ??
        EXTERNAL_PROVIDER_RUNNERS[externalModel.provider]
      return await createMastraBedrockAiModelGateway({
        pricingByModelId: EXTERNAL_PRICING_BY_MODEL_ID,
        runStructuredGeneration: (runnerInput) => runner(apiKey, runnerInput),
        ...(options.nowMilliseconds === undefined
          ? {}
          : { nowMilliseconds: options.nowMilliseconds }),
      }).generate({ ...input, timeoutMs: remainingTimeoutMs })
    },
  }
}

/**
 * Waits for the Workspace key without exceeding the generation deadline.
 *
 * @param resolution - Pending key lookup and decryption.
 * @param timeoutMs - Remaining generation deadline.
 * @returns The decrypted key, or undefined when none is registered.
 */
async function resolveWithinDeadline(
  resolution: Promise<string | undefined>,
  timeoutMs: number,
): Promise<string | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(providerDeadlineError()), Math.max(0, timeoutMs))
  })
  try {
    return await Promise.race([resolution, deadline])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

/**
 * Creates the same deadline error the shared gateway raises before any provider dispatch.
 *
 * @returns Stable provider timeout error.
 */
function providerDeadlineError(): AiAssistanceError {
  return new AiAssistanceError(
    'timeout',
    'AiAssistanceProviderTimeout',
    'The AI provider did not complete within the configured deadline.',
  )
}
