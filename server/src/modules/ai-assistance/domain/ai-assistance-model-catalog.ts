import type {
  AiAssistanceAvailableModel,
  AiAssistanceExternalProvider,
  AiAssistanceProvider,
} from '@mukuroji/contracts'

/** External providers in the stable order used by APIs and settings screens. */
export const AI_ASSISTANCE_EXTERNAL_PROVIDERS = [
  'anthropic',
  'openai',
] as const satisfies readonly AiAssistanceExternalProvider[]

/** Reviewed list price for one external model in USD per one million tokens. */
export type AiAssistanceExternalModelPricing = {
  /** Standard input token price. */
  inputPerMillionTokensUsd: number
  /** Standard output token price. */
  outputPerMillionTokensUsd: number
}

/** One code-reviewed external model the deployment may offer. */
export type AiAssistanceExternalModel = {
  /** Exact provider model identifier. */
  modelId: string
  /** Provider that serves the model. */
  provider: AiAssistanceExternalProvider
  /** Reviewed list price used for the audit cost estimate. */
  pricing: AiAssistanceExternalModelPricing
}

/**
 * Code-reviewed external models with list prices checked on 2026-11-21.
 *
 * Adding a model or changing a price is a reviewed code change, matching the
 * Bedrock rule that prices come from deployment evidence rather than tenants.
 * The first model of each provider is its default.
 */
export const AI_ASSISTANCE_EXTERNAL_MODELS: readonly AiAssistanceExternalModel[] = [
  {
    modelId: 'claude-sonnet-5-5',
    provider: 'anthropic',
    pricing: { inputPerMillionTokensUsd: 2, outputPerMillionTokensUsd: 10 },
  },
  {
    modelId: 'claude-opus-5-5',
    provider: 'anthropic',
    pricing: { inputPerMillionTokensUsd: 4, outputPerMillionTokensUsd: 20 },
  },
  {
    modelId: 'claude-haiku-5-5',
    provider: 'anthropic',
    pricing: { inputPerMillionTokensUsd: 0.1, outputPerMillionTokensUsd: 0.5 },
  },
  {
    modelId: 'gpt-6.2-sol',
    provider: 'openai',
    pricing: { inputPerMillionTokensUsd: 2, outputPerMillionTokensUsd: 10 },
  },
]

/**
 * Lists the reviewed external models of the providers a deployment enables.
 *
 * @param providers - External providers enabled by deployment configuration.
 * @returns Catalog entries in catalog order.
 */
export function listAiAssistanceExternalModels(
  providers: ReadonlySet<AiAssistanceExternalProvider>,
): AiAssistanceExternalModel[] {
  return AI_ASSISTANCE_EXTERNAL_MODELS.filter((model) => providers.has(model.provider))
}

/**
 * Finds a reviewed external model by its exact identifier.
 *
 * @param modelId - Model identifier selected by policy or request.
 * @returns The catalog entry, or undefined for Bedrock or unknown models.
 */
export function findAiAssistanceExternalModel(
  modelId: string,
): AiAssistanceExternalModel | undefined {
  return AI_ASSISTANCE_EXTERNAL_MODELS.find((model) => model.modelId === modelId)
}

/**
 * Narrows an unknown value to an external provider name.
 *
 * @param value - Untrusted provider name from a path or configuration.
 * @returns Whether the value names a supported external provider.
 */
export function isAiAssistanceExternalProvider(
  value: unknown,
): value is AiAssistanceExternalProvider {
  return value === 'anthropic' || value === 'openai'
}

/**
 * Parses the deployment list of enabled external providers.
 *
 * @param value - Comma-separated provider names; undefined or empty enables none.
 * @returns The enabled providers.
 * @throws TypeError when an entry is not a supported provider.
 */
export function parseAiAssistanceExternalProviders(
  value: string | undefined,
): Set<AiAssistanceExternalProvider> {
  const providers = new Set<AiAssistanceExternalProvider>()
  for (const entry of (value ?? '').split(',')) {
    const normalized = entry.trim()
    if (normalized.length === 0) continue
    if (!isAiAssistanceExternalProvider(normalized)) {
      throw new TypeError(
        'AI_ASSISTANCE_EXTERNAL_PROVIDERS must list only anthropic and openai.',
      )
    }
    providers.add(normalized)
  }
  return providers
}

/**
 * Builds the server-owned model list returned with a Workspace policy.
 *
 * @param bedrockModelIds - Deployment-allowlisted Bedrock model identifiers.
 * @param externalModels - Reviewed external models enabled for the deployment.
 * @returns Model and provider pairs in display order.
 */
export function createAiAssistanceAvailableModels(
  bedrockModelIds: readonly string[],
  externalModels: readonly AiAssistanceExternalModel[],
): AiAssistanceAvailableModel[] {
  const bedrockProvider: AiAssistanceProvider = 'bedrock'
  return [
    ...bedrockModelIds.map((modelId) => ({ modelId, provider: bedrockProvider })),
    ...externalModels.map(({ modelId, provider }) => ({ modelId, provider })),
  ]
}
