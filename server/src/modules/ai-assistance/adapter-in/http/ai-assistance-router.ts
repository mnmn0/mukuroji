import { Hono, type Context } from 'hono'
import type { HonoRequest } from 'hono/request'
import type {
  AiAssistanceActor,
  AiAssistanceAuthorizationCondition,
  AiAssistanceAuthorizationCallbacks,
  AiAssistanceAuthorizationState,
  AiAssistanceService,
  AiAssistancePolicyAuthorization,
  AiAssistancePolicyAuthorizationFence,
  CheckAiAssistanceAuthorizationInput,
  ResolveAiAssistanceContextInput,
  ResolvedAiAssistanceContext,
} from '../../application/ports/ai-assistance-ports'
import {
  parseCreateAiAssistanceFeedbackRequest,
  parseDecideAiAssistanceGenerationRequest,
  parseGenerateAiAssistanceRequest,
  parseUpdateAiAssistancePolicyRequest,
  parseUpdateAiAssistancePreferenceRequest,
} from '../../application/validation/ai-assistance-schema'
import { AiAssistanceError } from '../../errors'

/** Injected HTTP and authorization boundaries required by the AI assistance router. */
export type AiAssistanceRouterDependencies<Principal> = {
  /** AI assistance application service assembled by composition. */
  service: AiAssistanceService
  /** Reads the bearer token using the application's canonical header rules. */
  readBearerAccessToken(context: Context): string | undefined
  /** Resolves the current authenticated Workspace principal. */
  authenticate(accessToken: string, context: Context): Promise<Principal>
  /** Projects the authenticated principal into the application actor. */
  toActor(
    principal: Principal,
    context: Context,
  ): AiAssistanceActor | Promise<AiAssistanceActor>
  /** Resolves the commit-time policy authorization fence for a fresh principal. */
  getPolicyAuthorizationFence?(
    principal: Principal,
    actor: AiAssistanceActor,
    context: Context,
  ):
    | AiAssistancePolicyAuthorizationFence
    | Promise<AiAssistancePolicyAuthorizationFence | undefined>
    | undefined
  /** Resolves current permission-filtered model context. */
  resolveContext(
    principal: Principal,
    input: ResolveAiAssistanceContextInput,
    context: Context,
  ): Promise<ResolvedAiAssistanceContext>
  /** Rechecks a captured authorization snapshot before persistence or disclosure. */
  isAuthorizationCurrent(
    principal: Principal,
    input: CheckAiAssistanceAuthorizationInput,
    context: Context,
  ): Promise<AiAssistanceAuthorizationState>
  /** Resolves current actor authorization rows for a preference commit. */
  getActorAuthorizationConditions?(
    principal: Principal,
    actor: AiAssistanceActor,
    context: Context,
  ): readonly AiAssistanceAuthorizationCondition[] |
    Promise<readonly AiAssistanceAuthorizationCondition[]> |
    undefined
  /** Parses a JSON request with the application's canonical body-size/error boundary. */
  readJson(request: HonoRequest): Promise<unknown>
  /** Maps authentication, source authorization, and unexpected errors safely. */
  mapError(context: Context, error: unknown): Response
}

/**
 * Creates the isolated AI assistance Hono router.
 *
 * @param dependencies - Application service and current-principal callbacks.
 * @returns Router mounted by composition at the application root.
 */
export function createAiAssistanceRouter<Principal>(
  dependencies: AiAssistanceRouterDependencies<Principal>,
): Hono {
  const router = new Hono()

  router.get('/api/ai-assistance/policy', async (context) => {
    try {
      const { actor } = await authenticateRequest(context, dependencies)
      requireAiAssistancePolicyManager(actor)
      context.header('Cache-Control', 'private, no-store')
      return context.json(await dependencies.service.getPolicy(actor))
    } catch (error) {
      return mapRouterError(context, error, dependencies.mapError)
    }
  })

  router.put('/api/ai-assistance/policy', async (context) => {
    try {
      const { actor, policyAuthorization } = await authenticateRequest(context, dependencies)
      const request = parseUpdateAiAssistancePolicyRequest(
        await dependencies.readJson(context.req),
      )
      return context.json(await dependencies.service.updatePolicy(
        actor,
        request,
        policyAuthorization,
      ))
    } catch (error) {
      return mapRouterError(context, error, dependencies.mapError)
    }
  })

  router.get('/api/ai-assistance/preferences/me', async (context) => {
    try {
      const { actor } = await authenticateRequest(context, dependencies)
      context.header('Cache-Control', 'private, no-store')
      return context.json(await dependencies.service.getPreference(actor))
    } catch (error) {
      return mapRouterError(context, error, dependencies.mapError)
    }
  })

  router.put('/api/ai-assistance/preferences/me', async (context) => {
    try {
      const { actor, authorization } = await authenticateRequest(context, dependencies)
      const request = parseUpdateAiAssistancePreferenceRequest(
        await dependencies.readJson(context.req),
      )
      return context.json(await dependencies.service.updatePreference(actor, request, authorization))
    } catch (error) {
      return mapRouterError(context, error, dependencies.mapError)
    }
  })

  router.post('/api/ai-assistance/generations', async (context) => {
    const requestStartedAtMs = Date.now()
    try {
      const { actor, authorization } = await authenticateRequest(context, dependencies)
      const request = parseGenerateAiAssistanceRequest(
        await dependencies.readJson(context.req),
      )
      const idempotencyKey = requireIdempotencyKey(
        context.req.header('Idempotency-Key'),
      )
      const execution = await dependencies.service.generateWithMetadata(
        actor,
        request,
        authorization,
        idempotencyKey,
        requestStartedAtMs,
      )
      if (execution.replayed) {
        context.header('Idempotency-Replayed', 'true')
      }
      return context.json(execution.generation, 201)
    } catch (error) {
      return mapRouterError(context, error, dependencies.mapError)
    }
  })

  router.get('/api/ai-assistance/generations/:generationId', async (context) => {
    try {
      const { actor, authorization } = await authenticateRequest(context, dependencies)
      const generationId = requireGenerationId(context.req.param('generationId'))
      context.header('Cache-Control', 'private, no-store')
      return context.json(await dependencies.service.getGeneration(
        actor,
        generationId,
        authorization,
      ))
    } catch (error) {
      return mapRouterError(context, error, dependencies.mapError)
    }
  })

  router.post(
    '/api/ai-assistance/generations/:generationId/decision',
    async (context) => {
      try {
        const { actor, authorization } = await authenticateRequest(context, dependencies)
        const generationId = requireGenerationId(context.req.param('generationId'))
        const request = parseDecideAiAssistanceGenerationRequest(
          await dependencies.readJson(context.req),
        )
        return context.json(await dependencies.service.decideGeneration(
          actor,
          generationId,
          request,
          authorization,
        ))
      } catch (error) {
        return mapRouterError(context, error, dependencies.mapError)
      }
    },
  )

  router.post(
    '/api/ai-assistance/generations/:generationId/feedback',
    async (context) => {
      try {
        const { actor, authorization } = await authenticateRequest(context, dependencies)
        const generationId = requireGenerationId(context.req.param('generationId'))
        const request = parseCreateAiAssistanceFeedbackRequest(
          await dependencies.readJson(context.req),
        )
        const idempotencyKey = requireIdempotencyKey(
          context.req.header('Idempotency-Key'),
        )
        const feedbackResult = await dependencies.service.createFeedback(
          actor,
          generationId,
          request,
          authorization,
          idempotencyKey,
        )
        if (feedbackResult.replayed) {
          context.header('Idempotency-Replayed', 'true')
        }
        return context.body(null, 204)
      } catch (error) {
        return mapRouterError(context, error, dependencies.mapError)
      }
    },
  )

  return router
}

/** Authenticated request state bound to current source authorization callbacks. */
type AuthenticatedAiAssistanceRequest<Principal> = {
  /** Current transport principal. */
  principal: Principal
  /** Current application actor. */
  actor: AiAssistanceActor
  /** Callbacks bound to the same current principal. */
  authorization: AiAssistanceAuthorizationCallbacks
  /** Rechecks current Workspace management permission before policy persistence. */
  policyAuthorization: AiAssistancePolicyAuthorization
}

/** Resolves bearer authentication and binds principal-scoped source callbacks. */
async function authenticateRequest<Principal>(
  context: Context,
  dependencies: AiAssistanceRouterDependencies<Principal>,
): Promise<AuthenticatedAiAssistanceRequest<Principal>> {
  const accessToken = dependencies.readBearerAccessToken(context)
  if (!accessToken) {
    throw new AiAssistanceError(
      'authentication',
      'AiAssistanceAuthenticationRequired',
      'Bearer authentication is required.',
    )
  }
  const principal = await dependencies.authenticate(accessToken, context)
  const actor = await dependencies.toActor(principal, context)
  return {
    principal,
    actor,
    policyAuthorization: {
      isCurrent: async () => {
        const currentAccessToken = dependencies.readBearerAccessToken(context)
        if (currentAccessToken === undefined || currentAccessToken !== accessToken) {
          return false
        }
        try {
          const currentPrincipal = await dependencies.authenticate(
            currentAccessToken,
            context,
          )
          const currentActor = await dependencies.toActor(currentPrincipal, context)
          return currentActor.workspaceId === actor.workspaceId &&
            currentActor.memberId === actor.memberId &&
            currentActor.actorId === actor.actorId &&
            currentActor.canManagePolicy
        } catch {
          return false
        }
      },
      getCommitFence: async () => {
        const currentAccessToken = dependencies.readBearerAccessToken(context)
        if (currentAccessToken === undefined || currentAccessToken !== accessToken) {
          return undefined
        }
        try {
          const currentPrincipal = await dependencies.authenticate(
            currentAccessToken,
            context,
          )
          const currentActor = await dependencies.toActor(currentPrincipal, context)
          if (
            currentActor.workspaceId !== actor.workspaceId ||
            currentActor.memberId !== actor.memberId ||
            currentActor.actorId !== actor.actorId ||
            !currentActor.canManagePolicy
          ) return undefined
          return await dependencies.getPolicyAuthorizationFence?.(
            currentPrincipal,
            currentActor,
            context,
          )
        } catch {
          return undefined
        }
      },
    },
    authorization: {
      resolveContext: (input) => dependencies.resolveContext(principal, input, context),
      isAuthorizationCurrent: async (input) => {
        const freshPrincipal = await dependencies.authenticate(accessToken, context)
        const freshActor = await dependencies.toActor(freshPrincipal, context)
        if (
          freshActor.workspaceId !== input.actor.workspaceId ||
          freshActor.memberId !== input.actor.memberId ||
          freshActor.actorId !== input.actor.actorId
        ) {
          return { current: false, reason: 'permission-changed' }
        }
        return await dependencies.isAuthorizationCurrent(
          freshPrincipal,
          { ...input, actor: freshActor },
          context,
        )
      },
      getActorAuthorizationConditions: async () => {
        const currentAccessToken = dependencies.readBearerAccessToken(context)
        if (currentAccessToken === undefined || currentAccessToken !== accessToken) {
          return []
        }
        try {
          const currentPrincipal = await dependencies.authenticate(
            currentAccessToken,
            context,
          )
          const currentActor = await dependencies.toActor(currentPrincipal, context)
          if (
            currentActor.workspaceId !== actor.workspaceId ||
            currentActor.memberId !== actor.memberId ||
            currentActor.actorId !== actor.actorId
          ) return []
          return await dependencies.getActorAuthorizationConditions?.(
            currentPrincipal,
            currentActor,
            context,
          ) ?? []
        } catch {
          return []
        }
      },
    },
  }
}

/** Requires Workspace management permission before exposing governance policy. */
function requireAiAssistancePolicyManager(actor: AiAssistanceActor): void {
  if (actor.canManagePolicy) return
  throw new AiAssistanceError(
    'authorization',
    'AiAssistanceDisabled',
    'The current operator cannot read AI assistance policy.',
  )
}

/** Validates one path generation identifier without accepting physical table keys. */
function requireGenerationId(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256) {
    throw new AiAssistanceError(
      'validation',
      'InvalidAiAssistanceRequest',
      'AI assistance generation ID is invalid.',
    )
  }
  return normalized
}

/** Requires a bounded generation Idempotency-Key header. */
function requireIdempotencyKey(value: string | undefined): string {
  const normalized = value?.trim() ?? ''
  if (!normalized || normalized.length > 256) {
    throw new AiAssistanceError(
      'validation',
      'AiAssistanceIdempotencyKeyRequired',
      'A valid Idempotency-Key header is required.',
    )
  }
  return normalized
}

/** Maps application errors locally and delegates external boundaries to composition. */
function mapRouterError(
  context: Context,
  error: unknown,
  mapExternalError: (context: Context, error: unknown) => Response,
): Response {
  if (!(error instanceof AiAssistanceError)) {
    return mapExternalError(context, error)
  }
  if (error.idempotencyReplayed) {
    context.header('Idempotency-Replayed', 'true')
  }
  return context.json(
    { code: error.code, message: error.message },
    toHttpStatus(error),
  )
}

/** Maps one stable application error category to an HTTP status. */
function toHttpStatus(
  error: AiAssistanceError,
): 400 | 401 | 403 | 404 | 409 | 429 | 502 | 504 {
  if (
    error.code === 'InvalidAiAssistanceOutput' ||
    error.code === 'AiAssistanceCitationInvalid' ||
    error.code === 'AiAssistanceOutputNotAllowed'
  ) return 502
  if (error.category === 'validation') return 400
  if (error.category === 'authentication') return 401
  if (error.category === 'authorization') return 403
  if (error.category === 'not-found') return 404
  if (error.category === 'conflict') return 409
  if (error.category === 'rate-limit') return 429
  if (error.category === 'timeout') return 504
  return 502
}
