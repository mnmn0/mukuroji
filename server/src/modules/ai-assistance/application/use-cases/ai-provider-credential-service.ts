import {
  AI_ASSISTANCE_SCHEMA_VERSION,
  type AiAssistanceExternalProvider,
  type AiAssistanceProviderCredentialStatus,
  type AiAssistanceProviderCredentials,
} from '@mukuroji/contracts'
import type { AuditEventV1 } from '../../../audit'
import { AI_ASSISTANCE_EXTERNAL_PROVIDERS } from '../../domain/ai-assistance-model-catalog'
import { AiAssistanceError } from '../../errors'
import type {
  AiAssistanceActor,
  AiAssistancePolicyAuthorization,
} from '../ports/ai-assistance-ports'
import type {
  AiProviderCredentialAuditInput,
  AiProviderCredentialCipher,
  AiProviderCredentialService,
  AiProviderCredentialStore,
  StoredAiProviderCredential,
} from '../ports/ai-provider-credential-ports'
import {
  parseDeleteAiAssistanceProviderCredentialRequest,
  parsePutAiAssistanceProviderCredentialRequest,
} from '../validation/ai-provider-credential-schema'

/** Dependencies of the provider key service. */
export type AiProviderCredentialServiceOptions = {
  /** Revision-fenced key row persistence. */
  store: AiProviderCredentialStore
  /** Context-bound envelope encryption. */
  cipher: AiProviderCredentialCipher
  /** External providers the deployment allows. */
  enabledProviders: ReadonlySet<AiAssistanceExternalProvider>
  /** Builds the key-free audit event written with each change. */
  createAuditEvent(input: AiProviderCredentialAuditInput): AuditEventV1
  /** Clock used for timestamps. */
  now?: () => Date
}

/**
 * Creates the service that lets Workspace managers register provider API keys.
 *
 * Keys are write-only: responses carry only whether a key exists, its last
 * four characters, and its revision. Every change rechecks fresh management
 * authorization and is written in one transaction with its audit event.
 *
 * @param options - Store, cipher, enabled providers, and audit builder.
 * @returns Provider key service.
 */
export function createAiProviderCredentialService(
  options: AiProviderCredentialServiceOptions,
): AiProviderCredentialService {
  const now = options.now ?? (() => new Date())

  /** Reads one provider row for the actor's Workspace. */
  async function read(
    workspaceId: string,
    provider: AiAssistanceExternalProvider,
  ): Promise<StoredAiProviderCredential | undefined> {
    return await options.store.getProviderCredential(workspaceId, provider)
  }

  /** Builds the key-free status list for one Workspace. */
  async function list(actor: AiAssistanceActor): Promise<AiAssistanceProviderCredentials> {
    requireManager(actor)
    const providers = await Promise.all(
      AI_ASSISTANCE_EXTERNAL_PROVIDERS.map(async (provider) =>
        toStatus(provider, options.enabledProviders.has(provider), await read(actor.workspaceId, provider))),
    )
    return { schemaVersion: AI_ASSISTANCE_SCHEMA_VERSION, providers }
  }

  /** Persists one change after the revision and fresh-authorization checks. */
  async function write(
    actor: AiAssistanceActor,
    provider: AiAssistanceExternalProvider,
    expectedRevision: number,
    authorization: AiAssistancePolicyAuthorization,
    apiKey: string | undefined,
  ): Promise<void> {
    const current = await read(actor.workspaceId, provider)
    const currentRevision = current?.revision ?? 0
    if (currentRevision !== expectedRevision) {
      throw new AiAssistanceError(
        'conflict',
        'AiAssistanceRevisionConflict',
        'The AI provider key changed after it was loaded.',
      )
    }
    if (apiKey === undefined && current?.ciphertext === undefined) return
    if (!await authorization.isCurrent()) throw authorizationChangedError()
    const fence = await authorization.getCommitFence?.()
    if (fence === undefined) throw authorizationChangedError()
    const occurredAt = now().toISOString()
    const revision = currentRevision + 1
    const next: StoredAiProviderCredential = {
      workspaceId: actor.workspaceId,
      provider,
      revision,
      updatedAt: occurredAt,
      ...(apiKey === undefined
        ? {}
        : {
            ciphertext: await options.cipher.encrypt(apiKey, actor.workspaceId, provider),
            keyHint: apiKey.slice(-4),
          }),
    }
    const action = apiKey === undefined
      ? 'deleted'
      : current?.ciphertext === undefined ? 'created' : 'updated'
    await options.store.putProviderCredentialWithAudit(
      actor.memberId,
      next,
      expectedRevision,
      fence,
      options.createAuditEvent({
        actor,
        provider,
        action,
        previousRevision: currentRevision,
        revision,
        occurredAt,
      }),
    )
  }

  return {
    list,
    async put(actor, provider, input, authorization) {
      requireManager(actor)
      requireEnabledProvider(options.enabledProviders, provider)
      const request = parsePutAiAssistanceProviderCredentialRequest(provider, input)
      await write(actor, provider, request.expectedRevision, authorization, request.apiKey)
      return await list(actor)
    },
    async delete(actor, provider, input, authorization) {
      requireManager(actor)
      const request = parseDeleteAiAssistanceProviderCredentialRequest(input)
      await write(actor, provider, request.expectedRevision, authorization, undefined)
      return await list(actor)
    },
    async isConfigured(workspaceId, provider) {
      if (!options.enabledProviders.has(provider)) return false
      return (await read(workspaceId, provider))?.ciphertext !== undefined
    },
    async resolveApiKey(workspaceId, provider) {
      if (!options.enabledProviders.has(provider)) return undefined
      const stored = await read(workspaceId, provider)
      if (stored?.ciphertext === undefined) return undefined
      return await options.cipher.decrypt(stored.ciphertext, workspaceId, provider)
    },
  }
}

/** Projects one stored row into the key-free public status. */
function toStatus(
  provider: AiAssistanceExternalProvider,
  deploymentEnabled: boolean,
  stored: StoredAiProviderCredential | undefined,
): AiAssistanceProviderCredentialStatus {
  const configured = stored?.ciphertext !== undefined
  return {
    provider,
    deploymentEnabled,
    configured,
    ...(configured && stored?.keyHint !== undefined ? { keyHint: stored.keyHint } : {}),
    revision: stored?.revision ?? 0,
    ...(stored === undefined ? {} : { updatedAt: stored.updatedAt }),
  }
}

/** Rejects operators who may not manage Workspace AI settings. */
function requireManager(actor: AiAssistanceActor): void {
  if (actor.canManagePolicy) return
  throw new AiAssistanceError(
    'authorization',
    'AiAssistanceDisabled',
    'The current operator cannot manage AI provider keys.',
  )
}

/** Rejects key registration for a provider the deployment does not allow. */
function requireEnabledProvider(
  enabledProviders: ReadonlySet<AiAssistanceExternalProvider>,
  provider: AiAssistanceExternalProvider,
): void {
  if (enabledProviders.has(provider)) return
  throw new AiAssistanceError(
    'validation',
    'AiAssistanceProviderNotEnabled',
    'This AI provider is not enabled for the deployment.',
  )
}

/** Creates the stable error for lost management authorization. */
function authorizationChangedError(): AiAssistanceError {
  return new AiAssistanceError(
    'authorization',
    'AiAssistanceAuthorizationChanged',
    'AI provider key authorization is no longer current.',
  )
}
