import type { Context } from 'hono'
import { Hono } from 'hono'
import {
  TRIAGE_BULK_ACTION_LIMIT,
  type CreateManualTriageEntryInput,
  type TriageActionInput,
  type TriageBulkActionInput,
  type TriageBulkActionResult,
  type TriageBulkOperation,
  type TriageEntry,
  type TriageEntryListInput,
  type TriageMutationReceipt,
  type TriageOwnerStrategy,
  type TriageRoutingRule,
  type TriageSlaPolicy,
  type TriageSourceKind,
  type UpdateTriageConfigurationInput,
} from '@mukuroji/contracts'
import {
  createMutationAuditContext,
  type AuditActor,
  type MutationAuditContext,
} from '../../../audit'
import { projectTriageEntryForResponse, TriageError } from '../../domain/triage-entry'
import {
  createTriageActionAuditIdempotencyKey,
  createTriageBulkTargetIdempotencyKey,
  createTriageInputFingerprint,
} from '../../triage'
import type {
  TriageActor,
  TriageAuthorizationConditionChecks,
  TriageAuditContextFactory,
  TriageClient,
  TriageIdempotency,
} from '../../triage'

/** Team authorization level requested by one triage route. */
export type TriageTeamAccess = 'read' | 'write' | 'manage'

/** Authenticated Workspace principal returned by the router authorization boundary. */
export type TriagePrincipal = {
  /** Authenticated Workspace directory ID. */
  workspaceId: string
  /** Stable authenticated user or service principal identifier. */
  userId: string
  /** Stable authenticated audit actor, including service and break-glass identity. */
  auditActor: AuditActor
  /** Correlation override binding break-glass mutations to their activation. */
  auditCorrelationId?: string
  /** Strongest live Team access resolved for the authenticated principal. */
  teamAccess: TriageTeamAccess
  /** Project IDs visible to a Project-scoped principal, or undefined for full Team visibility. */
  visibleProjectIds?: readonly string[]
  /** Project IDs writable by the principal, or undefined for full Team write access. */
  writableProjectIds?: readonly string[]
  /** Whether the principal may read and replace Team Triage configuration. */
  canManageConfiguration?: boolean
}

/** Input supplied to the composable action orchestration boundary. */
export type TriageRouterActionRequest = {
  /** Authenticated Hono context used for live Project and Work Item permission checks. */
  context: Context
  /** Owning Workspace ID. */
  workspaceId: string
  /** Expected Team queue ID. */
  teamId: string
  /** Target entry ID. */
  entryId: string
  /** Authenticated mutation actor. */
  actor: TriageActor
  /** Strictly validated action. */
  action: TriageActionInput
  /** Header-bound semantic replay protection. */
  idempotency: TriageIdempotency
  /** Immutable request context captured before application orchestration. */
  auditContext: MutationAuditContext
  /** Configuration revision observed during a bulk preflight, when applicable. */
  configurationRevision?: number
  /** Caller authorization conditions joined to the action transaction. */
  authorizationConditionChecks?: TriageAuthorizationConditionChecks
}

/** Input supplied to the composable bulk-action orchestration boundary. */
export type TriageRouterBulkActionRequest = {
  /** Authenticated Hono context used for live reference checks. */
  context: Context
  /** Owning Workspace ID. */
  workspaceId: string
  /** Expected Team queue ID. */
  teamId: string
  /** Authenticated mutation actor. */
  actor: TriageActor
  /** Strictly validated bounded bulk operation. */
  input: TriageBulkActionInput
  /** Caller-supplied bulk idempotency key. */
  idempotencyKey: string
  /** Configuration revision observed before target transactions begin. */
  configurationRevision?: number
  /** Factory retaining the bulk request while binding each target receipt key. */
  createAuditContext: TriageAuditContextFactory
}

/** Dependencies injected into the Team triage HTTP adapter. */
export type TriageRouterDependencies = {
  /** Returns the request-bound triage application client. */
  getTriage(): TriageClient
  /** Authenticates the request and enforces live Team permission.
   *
   * @param context The Hono request context.
   * @param teamId The Team route parameter.
   * @param access The minimum required access.
   * @returns The authenticated Workspace principal.
   */
  requireTeamAccess(
    context: Context,
    teamId: string,
    access: TriageTeamAccess,
  ): Promise<TriagePrincipal>
  /** Enforces live permission for a reverse-source Work Item target.
   *
   * @param context The Hono request context.
   * @param teamId The owning Team identifier.
   * @param workItemId The canonical Work Item identifier.
   * @returns A promise that resolves only when the current principal may view the Work Item.
   */
  requireWorkItemAccess(
    context: Context,
    teamId: string,
    workItemId: string,
  ): Promise<void>
  /** Safely parses JSON without throwing transport-specific exceptions.
   *
   * @param request The Hono request parser surface.
   * @returns The untrusted parsed value or undefined.
   */
  readJson(request: { json: () => Promise<unknown> }): Promise<unknown>
  /** Validates live directory references before Team settings are persisted.
   *
   * @param context The authenticated Hono request context.
   * @param teamId The configured Team identifier.
   * @param input The strictly parsed replacement configuration.
   */
  validateConfiguration?(
    context: Context,
    teamId: string,
    input: UpdateTriageConfigurationInput,
  ): Promise<TriageAuthorizationConditionChecks | void>
  /** Validates live owner and Project references before a bulk mutation is applied.
   *
   * @param context The authenticated Hono request context.
   * @param teamId The Team owning every bulk target.
   * @param input The strictly parsed bulk mutation.
   */
  validateBulkAction?(
    context: Context,
    teamId: string,
    input: TriageBulkActionInput,
  ): Promise<number | void>
  /** Replaces caller-asserted manual routing fields with server-owned values.
   *
   * @param context The authenticated Hono request context.
   * @param teamId The Team receiving the manual handoff.
   * @param input The strictly parsed handoff payload.
   * @returns A handoff with current routing, owner, SLA, and retention values.
   */
  prepareManualHandoff?(
    context: Context,
    teamId: string,
    input: CreateManualTriageEntryInput,
  ): Promise<CreateManualTriageEntryInput>
  /** Builds caller authorization conditions for a manual handoff transaction.
   *
   * @param context The authenticated Hono request context.
   * @param teamId The Team receiving the handoff.
   * @param input The server-prepared handoff.
   * @returns Conditions proving the caller still has the required Team/Project access.
   */
  createManualHandoffAuthorizationConditionChecks?(
    context: Context,
    teamId: string,
    input: CreateManualTriageEntryInput,
  ): Promise<TriageAuthorizationConditionChecks>
  /** Optionally orchestrates Work Item-dependent actions in one transaction.
   *
   * Accept-create composition should strong-read the entry, build the triage transaction
   * contribution, and submit it with Work Item creation exactly once.
   *
   * @param request The authorized and validated action request.
   * @returns The replay-safe mutation result.
   */
  applyAction?(request: TriageRouterActionRequest): Promise<TriageMutationReceipt>
  /** Optionally orchestrates each bulk target through source-aware application logic.
   *
   * @param request The authorized and validated bulk action request.
   * @returns Per-target success, conflict, or failure results.
   */
  applyBulkAction?(request: TriageRouterBulkActionRequest): Promise<TriageBulkActionResult>
  /** Maps domain or dependency failures into the repository HTTP error envelope.
   *
   * @param context The Hono request context.
   * @param error The caught failure.
   * @returns The mapped HTTP response.
   */
  mapError(context: Context, error: unknown): Response
}

/** Creates Team triage queue, action, settings, handoff, and reverse-source routes.
 *
 * @param dependencies The application and authorization boundaries.
 * @returns A mountable Hono router.
 */
export function createTriageRouter(dependencies: TriageRouterDependencies) {
  const router = new Hono()

  router.get('/api/teams/:teamId/triage-entries', async (context) => {
    try {
      const teamId = readIdentifier(context.req.param('teamId') ?? '', 'Team ID')
      const principal = await dependencies.requireTeamAccess(context, teamId, 'read')
      const input = readListInput(context)
      const page = await dependencies.getTriage().listEntries(
        principal.workspaceId,
        teamId,
        {
          ...input,
          ...(principal.visibleProjectIds === undefined
            ? {}
            : { visibleProjectIds: principal.visibleProjectIds }),
        },
      )
      return context.json({
        ...page,
        ...(principal.canManageConfiguration === undefined
          ? {}
          : { canManageConfiguration: principal.canManageConfiguration }),
        allowedBulkActions: principal.teamAccess === 'read'
          ? []
          : page.allowedBulkActions,
        entries: page.entries
          .filter((entry) => isTriageEntryVisible(principal, entry))
          .map((entry) => projectTriageEntryForPrincipal(principal, entry)),
      })
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/teams/:teamId/triage-entries/:entryId', async (context) => {
    try {
      const teamId = readIdentifier(context.req.param('teamId') ?? '', 'Team ID')
      const principal = await dependencies.requireTeamAccess(context, teamId, 'read')
      const entry = await dependencies.getTriage().getEntry(
        principal.workspaceId,
        teamId,
        readIdentifier(context.req.param('entryId') ?? '', 'Triage entry ID'),
      )
      requireVisibleTriageEntry(principal, entry)
      return context.json(projectTriageEntryForPrincipal(principal, entry))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/teams/:teamId/triage-entries/:entryId/actions', async (context) => {
    try {
      const teamId = readIdentifier(context.req.param('teamId') ?? '', 'Team ID')
      const entryId = readIdentifier(context.req.param('entryId') ?? '', 'Triage entry ID')
      const principal = await dependencies.requireTeamAccess(context, teamId, 'write')
      const entry = await dependencies.getTriage().getEntry(
        principal.workspaceId,
        teamId,
        entryId,
      )
      requireVisibleTriageEntry(principal, entry)
      const action = readAction(await dependencies.readJson(context.req))
      requireVisibleActionProject(principal, action)
      const idempotency = createIdempotency(
        context.req.header('Idempotency-Key'),
        { workspaceId: principal.workspaceId, teamId, entryId, action },
      )
      const request: TriageRouterActionRequest = {
        context,
        workspaceId: principal.workspaceId,
        teamId,
        entryId,
        actor: { id: principal.userId },
        action,
        idempotency,
        auditContext: createTriageApiAuditContext(
          context,
          principal,
          entryId,
          action,
          idempotency,
        ),
      }
      const receipt = dependencies.applyAction
        ? await dependencies.applyAction(request)
        : await dependencies.getTriage().applyAction(
            request.workspaceId,
            request.teamId,
            request.entryId,
            request.actor,
            request.action,
            request.idempotency,
            request.auditContext,
          )
      return context.json({
        ...receipt,
        entry: projectTriageEntryForPrincipal(principal, receipt.entry),
      })
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/teams/:teamId/triage-entries/bulk-actions', async (context) => {
    try {
      const teamId = readIdentifier(context.req.param('teamId') ?? '', 'Team ID')
      const principal = await dependencies.requireTeamAccess(context, teamId, 'write')
      const idempotencyKey = readIdempotencyKey(context.req.header('Idempotency-Key'))
      const input = readBulkAction(await dependencies.readJson(context.req))
      const replayedReceipts = new Map<string, TriageMutationReceipt>()
      const pendingTargets = []
      for (const target of input.targets) {
        const targetIdempotency = {
          key: createTriageBulkTargetIdempotencyKey(idempotencyKey, target.entryId),
          fingerprint: createTriageInputFingerprint({
            target,
            operation: input.operation,
          }),
        }
        const replayed = await dependencies.getTriage().getActionReceipt(
          principal.workspaceId,
          target.entryId,
          targetIdempotency,
        )
        if (replayed) {
          requireVisibleTriageEntry(principal, replayed.entry)
          replayedReceipts.set(target.entryId, replayed)
          continue
        }
        const entry = await dependencies.getTriage().getEntry(
          principal.workspaceId,
          teamId,
          target.entryId,
        )
        requireVisibleTriageEntry(principal, entry)
        pendingTargets.push(target)
      }
      const pendingInput = pendingTargets.length === input.targets.length
        ? input
        : { ...input, targets: pendingTargets }
      if (pendingTargets.length > 0) {
        requireVisibleBulkProject(principal, pendingInput.operation)
      }
      const configurationRevision = pendingTargets.length === 0
        ? undefined
        : await dependencies.validateBulkAction?.(
            context,
            teamId,
            pendingInput,
          )
      const preparedAuditContexts = new Map(pendingTargets.map((target) => {
        const targetIdempotency = {
          key: createTriageBulkTargetIdempotencyKey(idempotencyKey, target.entryId),
          fingerprint: createTriageInputFingerprint({
            target,
            operation: input.operation,
          }),
        }
        return [
          target.entryId,
          {
            context: createTriageApiAuditContext(
              context,
              principal,
              target.entryId,
              input,
              targetIdempotency,
            ),
            idempotency: targetIdempotency,
          },
        ] satisfies readonly [string, {
          context: MutationAuditContext
          idempotency: TriageIdempotency
        }]
      }))
      /** Returns the preflighted context only for its exact target receipt identity. */
      const createAuditContext: TriageAuditContextFactory = (entryId, idempotency) => {
        const prepared = preparedAuditContexts.get(entryId)
        if (
          !prepared ||
          prepared.idempotency.key !== idempotency.key ||
          prepared.idempotency.fingerprint !== idempotency.fingerprint
        ) {
          throw new TriageError(
            500,
            'TriageAuditContextMismatch',
            'The preflighted Triage audit context does not match the target receipt.',
          )
        }
        return prepared.context
      }
      const result = pendingTargets.length === 0
        ? { results: [] }
        : dependencies.applyBulkAction
          ? await dependencies.applyBulkAction({
              context,
              workspaceId: principal.workspaceId,
              teamId,
              actor: { id: principal.userId },
              input: pendingInput,
              idempotencyKey,
              ...(configurationRevision === undefined ? {} : { configurationRevision }),
              createAuditContext,
            })
          : await dependencies.getTriage().applyBulkAction(
              principal.workspaceId,
              teamId,
              { id: principal.userId },
              pendingInput,
              idempotencyKey,
              createAuditContext,
            )
      const appliedResults = new Map(result.results.map((item) => [item.entryId, item]))
      const results = input.targets.map((target) => {
        const replayed = replayedReceipts.get(target.entryId)
        if (replayed) {
          return {
            entryId: target.entryId,
            status: 'succeeded' as const,
            entry: replayed.entry,
          }
        }
        const applied = appliedResults.get(target.entryId)
        if (!applied) {
          return {
            entryId: target.entryId,
            status: 'failed' as const,
            errorCode: 'TriageBulkResultMissing',
          }
        }
        return applied
      })
      return context.json({
        results: results.map((item) => item.entry
          ? { ...item, entry: projectTriageEntryForPrincipal(principal, item.entry) }
          : item),
      })
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.post('/api/teams/:teamId/triage-entries/manual-handoffs', async (context) => {
    try {
      const teamId = readIdentifier(context.req.param('teamId') ?? '', 'Team ID')
      const principal = await dependencies.requireTeamAccess(context, teamId, 'write')
      const parsedInput = readManualHandoff(await dependencies.readJson(context.req))
      const input = dependencies.prepareManualHandoff
        ? await dependencies.prepareManualHandoff(context, teamId, parsedInput)
        : parsedInput
      requireVisibleProject(principal, input.projectId)
      const authorizationConditionChecks = dependencies.createManualHandoffAuthorizationConditionChecks
        ? await dependencies.createManualHandoffAuthorizationConditionChecks(context, teamId, input)
        : undefined
      const idempotency = createIdempotency(
        context.req.header('Idempotency-Key'),
        { workspaceId: principal.workspaceId, teamId, input: parsedInput },
      )
      const receipt = await dependencies.getTriage().createManualHandoff(
        principal.workspaceId,
        teamId,
        { id: principal.userId },
        input,
        idempotency,
        authorizationConditionChecks,
      )
      requireVisibleTriageEntry(principal, receipt.entry)
      return context.json({
        ...receipt,
        entry: projectTriageEntryForPrincipal(principal, receipt.entry),
      }, receipt.replayed ? 200 : 201)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/teams/:teamId/triage-settings', async (context) => {
    try {
      const teamId = readIdentifier(context.req.param('teamId') ?? '', 'Team ID')
      const principal = await dependencies.requireTeamAccess(context, teamId, 'read')
      requireFullTeamVisibility(principal)
      return context.json(await dependencies.getTriage().getConfiguration(
        principal.workspaceId,
        teamId,
      ))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.put('/api/teams/:teamId/triage-settings', async (context) => {
    try {
      const teamId = readIdentifier(context.req.param('teamId') ?? '', 'Team ID')
      const principal = await dependencies.requireTeamAccess(context, teamId, 'manage')
      const input = readConfiguration(await dependencies.readJson(context.req))
      const idempotency = createIdempotency(
        context.req.header('Idempotency-Key'),
        { workspaceId: principal.workspaceId, teamId, input },
      )
      const replay = await dependencies.getTriage().getConfigurationUpdateReceipt(
        principal.workspaceId,
        teamId,
        idempotency,
      )
      if (replay) return context.json(replay)
      const configurationValidationResult = await dependencies.validateConfiguration?.(
        context,
        teamId,
        input,
      )
      const authorizationConditionChecks = configurationValidationResult ?? undefined
      return context.json(await dependencies.getTriage().updateConfiguration(
        principal.workspaceId,
        teamId,
        { id: principal.userId },
        input,
        idempotency,
        authorizationConditionChecks,
      ))
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.get('/api/teams/:teamId/work-items/:workItemId/triage-sources', async (context) => {
    try {
      const teamId = readIdentifier(context.req.param('teamId') ?? '', 'Team ID')
      const workItemId = readIdentifier(
        context.req.param('workItemId') ?? '',
        'Work Item ID',
      )
      const principal = await dependencies.requireTeamAccess(context, teamId, 'read')
      await dependencies.requireWorkItemAccess(context, teamId, workItemId)
      const limit = readLimit(context.req.query('limit'))
      const entries: TriageEntry[] = []
      let cursor = context.req.query('cursor')
      let nextCursor: string | undefined
      do {
        const page = await dependencies.getTriage().listWorkItemSources(
          principal.workspaceId,
          teamId,
          workItemId,
          Math.max(1, limit - entries.length),
          cursor,
          principal.visibleProjectIds,
        )
        entries.push(
          ...page.entries.filter((entry) => isTriageEntryVisible(principal, entry)),
        )
        nextCursor = page.nextCursor
        cursor = page.nextCursor
      } while (entries.length < limit && nextCursor !== undefined)
      return context.json({
        ...(nextCursor ? { nextCursor } : {}),
        entries: entries
          .slice(0, limit)
          .map((entry) => projectTriageEntryForPrincipal(principal, entry)),
      })
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  return router
}

/** Returns whether one entry is visible within the authenticated Project scope.
 *
 * @param principal The authenticated Team or Project-scoped principal.
 * @param entry The canonical entry to evaluate.
 * @returns Whether the entry may be disclosed to the principal.
 */
function isTriageEntryVisible(
  principal: TriagePrincipal,
  entry: Pick<TriageEntry, 'projectId'>,
): boolean {
  return principal.visibleProjectIds === undefined ||
    (entry.projectId !== undefined && principal.visibleProjectIds.includes(entry.projectId))
}

/**
 * Removes routing and canonical references outside a Project-scoped principal's visibility.
 *
 * @param principal The authenticated Team or Project-scoped principal.
 * @param entry The permission-projected Triage Entry.
 * @returns A response that contains no cross-Project routing metadata.
 */
function projectTriageEntryForPrincipal(
  principal: TriagePrincipal,
  entry: TriageEntry,
): TriageEntry {
  const projected = projectTriageEntryForResponse(entry)
  if (principal.visibleProjectIds === undefined) {
    return projectTriageCapabilitiesForPrincipal(principal, projected)
  }
  const visibleProjectIds = new Set(principal.visibleProjectIds)
  const candidates = projected.routing.candidates.filter((candidate) =>
    candidate.projectId !== undefined && visibleProjectIds.has(candidate.projectId)
  )
  const scoped: TriageEntry = {
    ...projected,
    routing: {
      reason: candidates.length === projected.routing.candidates.length
        ? projected.routing.reason
        : 'Routing context is limited to visible Projects.',
      candidates,
    },
  }
  if (
    scoped.canonicalWorkItem?.projectId !== undefined &&
    !visibleProjectIds.has(scoped.canonicalWorkItem.projectId)
  ) {
    delete scoped.canonicalWorkItem
  }
  return projectTriageCapabilitiesForPrincipal(principal, scoped)
}

/** Applies the principal's live Team and Project write access to response capabilities.
 *
 * @param principal The authenticated Team or Project-scoped principal.
 * @param entry The permission- and Project-safe response entry.
 * @returns The entry with truthful mutation capabilities for the current principal.
 */
function projectTriageCapabilitiesForPrincipal(
  principal: TriagePrincipal,
  entry: TriageEntry,
): TriageEntry {
  const writable = principal.teamAccess !== 'read' &&
    (
      principal.writableProjectIds === undefined ||
      entry.projectId !== undefined && principal.writableProjectIds.includes(entry.projectId)
    )
  if (writable) return entry
  return {
    ...entry,
    capabilities: {
      canAssign: false,
      canAcceptCreate: false,
      canAcceptLink: false,
      canMarkDuplicate: false,
      canDecline: false,
      canSnooze: false,
      canRequestInformation: false,
      canReply: false,
      canViewInternalContext: entry.capabilities.canViewInternalContext,
    },
  }
}

/** Fails closed when an entry is outside the authenticated Project scope.
 *
 * @param principal The authenticated Team or Project-scoped principal.
 * @param entry The canonical entry to authorize.
 */
function requireVisibleTriageEntry(
  principal: TriagePrincipal,
  entry: Pick<TriageEntry, 'projectId'>,
): void {
  if (!isTriageEntryVisible(principal, entry)) {
    throw new TriageError(404, 'TriageEntryNotFound', 'Triage entry not found.')
  }
}

/** Prevents Project-scoped principals from reading Team-wide routing and owner settings.
 *
 * @param principal The authenticated Team or Project-scoped principal.
 */
function requireFullTeamVisibility(principal: TriagePrincipal): void {
  if (principal.visibleProjectIds !== undefined) {
    throw new TriageError(
      403,
      'TriageSettingsAccessDenied',
      'Full Team visibility is required to view Triage settings.',
    )
  }
}

/** Fails closed when a selected Project is outside the authenticated Project scope.
 *
 * @param principal The authenticated Team or Project-scoped principal.
 * @param projectId The selected Project, or an absent Team-level selection.
 */
function requireVisibleProject(
  principal: TriagePrincipal,
  projectId: string | null | undefined,
): void {
  if (principal.visibleProjectIds !== undefined &&
    (projectId === null || projectId === undefined ||
      !principal.visibleProjectIds.includes(projectId))) {
    throw new TriageError(404, 'TriageEntryNotFound', 'Triage entry not found.')
  }
}

/** Enforces Project scope for an action that can select a destination Project.
 *
 * @param principal The authenticated Team or Project-scoped principal.
 * @param action The strictly parsed action.
 */
function requireVisibleActionProject(
  principal: TriagePrincipal,
  action: TriageActionInput,
): void {
  if (action.action === 'assign' && action.projectId !== undefined) {
    requireVisibleProject(principal, action.projectId)
  }
  if (action.action === 'accept' && action.mode === 'create' && action.projectId !== undefined) {
    requireVisibleProject(principal, action.projectId)
  }
}

/** Enforces Project scope for a bulk operation that can select a destination Project.
 *
 * @param principal The authenticated Team or Project-scoped principal.
 * @param operation The strictly parsed bulk operation.
 */
function requireVisibleBulkProject(
  principal: TriagePrincipal,
  operation: TriageBulkOperation,
): void {
  if (operation.action === 'assign' && operation.projectId !== undefined) {
    requireVisibleProject(principal, operation.projectId)
  }
}

/** Reads Team queue filters from the Hono query surface. */
function readListInput(context: Context): TriageEntryListInput {
  const query = context.req.query('query')?.trim()
  const state = context.req.query('state')
  const sourceKind = context.req.query('sourceKind')
  const sla = context.req.query('sla')
  const ownerUserId = context.req.query('ownerUserId')
  const ownerAlias = context.req.query('owner')
  if (ownerUserId && ownerAlias && ownerUserId !== ownerAlias) {
    throw invalidInput('Triage owner filters conflict.')
  }
  const owner = ownerUserId ?? ownerAlias
  return {
    ...(query ? { query: readQueueQuery(query) } : {}),
    ...(state ? { state: readState(state) } : {}),
    ...(sourceKind ? { sourceKind: readSourceKind(sourceKind) } : {}),
    ...(sla ? { sla: readQueueSlaFilter(sla) } : {}),
    ...(owner
      ? { ownerUserId: readOwnerFilter(owner) }
      : {}),
    ...(context.req.query('limit') ? { limit: readLimit(context.req.query('limit')) } : {}),
    ...(context.req.query('cursor') ? { cursor: context.req.query('cursor') } : {}),
  }
}

/** Validates one bounded free-text queue query. */
function readQueueQuery(value: string): string {
  if (value.length > 200) throw invalidInput('Triage queue query is too long.')
  return value
}

/** Validates one derived SLA queue filter. */
function readQueueSlaFilter(value: string): TriageEntryListInput['sla'] {
  if (value === 'on-track' || value === 'due-soon' || value === 'breached' || value === 'paused') {
    return value
  }
  throw invalidInput('Triage SLA filter is invalid.')
}

/** Strictly parses one operator action. */
function readAction(value: unknown): TriageActionInput {
  const record = readObject(value, 'Triage action')
  const expectedRevision = readRevision(record.expectedRevision)
  if (record.action === 'assign') {
    requireOnlyKeys(record, ['action', 'expectedRevision', 'ownerUserId', 'projectId'], 'Assign action')
    return {
      action: 'assign',
      expectedRevision,
      ownerUserId: record.ownerUserId === null
        ? null
        : readUserId(record.ownerUserId, 'Owner user ID'),
      ...(record.projectId === undefined
        ? {}
        : {
            projectId: record.projectId === null
              ? null
              : readIdentifier(record.projectId, 'Project ID'),
          }),
    }
  }
  if (record.action === 'accept' && record.mode === 'create') {
    requireOnlyKeys(record, ['action', 'mode', 'expectedRevision', 'projectId'], 'Accept-create action')
    return {
      action: 'accept',
      mode: 'create',
      expectedRevision,
      ...(record.projectId === undefined
        ? {}
        : { projectId: readIdentifier(record.projectId, 'Project ID') }),
    }
  }
  if (record.action === 'accept' && record.mode === 'link') {
    requireOnlyKeys(record, ['action', 'mode', 'expectedRevision', 'workItemId'], 'Accept-link action')
    return {
      action: 'accept',
      mode: 'link',
      expectedRevision,
      workItemId: readIdentifier(record.workItemId, 'Work Item ID'),
    }
  }
  if (record.action === 'duplicate') {
    requireOnlyKeys(record, ['action', 'expectedRevision', 'canonicalWorkItemId'], 'Duplicate action')
    return {
      action: 'duplicate',
      expectedRevision,
      canonicalWorkItemId: readIdentifier(record.canonicalWorkItemId, 'Canonical Work Item ID'),
    }
  }
  if (record.action === 'decline') {
    requireOnlyKeys(record, ['action', 'expectedRevision', 'reason'], 'Decline action')
    return {
      action: 'decline',
      expectedRevision,
      reason: readText(record.reason, 'Decline reason', 2_000),
    }
  }
  if (record.action === 'snooze') {
    requireOnlyKeys(record, ['action', 'expectedRevision', 'until'], 'Snooze action')
    return {
      action: 'snooze',
      expectedRevision,
      until: readIsoInstant(record.until, 'Snooze deadline'),
    }
  }
  if (record.action === 'request-information') {
    requireOnlyKeys(record, ['action', 'expectedRevision', 'message'], 'Information request action')
    return {
      action: 'request-information',
      expectedRevision,
      message: readText(record.message, 'Information request message', 8_000),
    }
  }
  throw invalidInput('Triage action is invalid.')
}

/** Strictly parses one bounded bulk action. */
function readBulkAction(value: unknown): TriageBulkActionInput {
  const record = readObject(value, 'Bulk triage action')
  requireOnlyKeys(record, ['targets', 'operation'], 'Bulk triage action')
  if (!Array.isArray(record.targets) || record.targets.length < 1 ||
    record.targets.length > TRIAGE_BULK_ACTION_LIMIT) {
    throw invalidInput('Bulk triage targets are invalid.')
  }
  const targets = record.targets.map((value) => {
    const target = readObject(value, 'Bulk triage target')
    requireOnlyKeys(target, ['entryId', 'expectedRevision'], 'Bulk triage target')
    return {
      entryId: readIdentifier(target.entryId, 'Triage entry ID'),
      expectedRevision: readRevision(target.expectedRevision),
    }
  })
  if (new Set(targets.map((target) => target.entryId)).size !== targets.length) {
    throw invalidInput('Bulk triage targets must be unique.')
  }
  return { targets, operation: readBulkOperation(record.operation) }
}

/** Strictly parses the operation shared by bulk targets. */
function readBulkOperation(value: unknown): TriageBulkOperation {
  const record = readObject(value, 'Bulk triage operation')
  if (record.action === 'assign') {
    requireOnlyKeys(record, ['action', 'ownerUserId', 'projectId'], 'Bulk assign operation')
    return {
      action: 'assign',
      ownerUserId: record.ownerUserId === null
        ? null
        : readUserId(record.ownerUserId, 'Owner user ID'),
      ...(record.projectId === undefined
        ? {}
        : {
            projectId: record.projectId === null
              ? null
              : readIdentifier(record.projectId, 'Project ID'),
          }),
    }
  }
  if (record.action === 'decline') {
    requireOnlyKeys(record, ['action', 'reason'], 'Bulk decline operation')
    return { action: 'decline', reason: readText(record.reason, 'Decline reason', 2_000) }
  }
  if (record.action === 'snooze') {
    requireOnlyKeys(record, ['action', 'until'], 'Bulk snooze operation')
    return { action: 'snooze', until: readIsoInstant(record.until, 'Snooze deadline') }
  }
  throw invalidInput('Bulk triage operation is invalid.')
}

/** Strictly parses an internal manual handoff. */
function readManualHandoff(value: unknown): CreateManualTriageEntryInput {
  const record = readObject(value, 'Manual handoff')
  requireOnlyKeys(record, [
    'sourceId', 'title', 'body', 'requesterDisplayName', 'requesterEmail', 'projectId',
    'routingReason', 'ownerUserId', 'slaPolicyId', 'slaDueAt', 'escalationDueAt',
    'retentionExpiresAt',
  ], 'Manual handoff')
  return {
    sourceId: readText(record.sourceId, 'Manual handoff source ID', 500),
    title: readText(record.title, 'Manual handoff title', 500),
    body: readText(record.body, 'Manual handoff body', 8_000, true),
    requesterDisplayName: readText(record.requesterDisplayName, 'Requester display name', 300),
    ...(record.requesterEmail === undefined
      ? {}
      : { requesterEmail: readEmail(record.requesterEmail) }),
    ...(record.projectId === undefined
      ? {}
      : { projectId: readIdentifier(record.projectId, 'Project ID') }),
    routingReason: readText(record.routingReason, 'Routing reason', 2_000),
    ...(record.ownerUserId === undefined
      ? {}
      : { ownerUserId: readUserId(record.ownerUserId, 'Owner user ID') }),
    ...(record.slaPolicyId === undefined
      ? {}
      : { slaPolicyId: readIdentifier(record.slaPolicyId, 'SLA policy ID') }),
    ...(record.slaDueAt === undefined
      ? {}
      : { slaDueAt: readIsoInstant(record.slaDueAt, 'SLA deadline') }),
    ...(record.escalationDueAt === undefined
      ? {}
      : { escalationDueAt: readIsoInstant(record.escalationDueAt, 'Escalation deadline') }),
    retentionExpiresAt: readIsoInstant(record.retentionExpiresAt, 'Retention deadline'),
  }
}

/** Strictly parses replacement Team settings. */
function readConfiguration(value: unknown): UpdateTriageConfigurationInput {
  const record = readObject(value, 'Triage settings')
  requireOnlyKeys(
    record,
    [
      'expectedRevision',
      'rules',
      'rotations',
      'slaPolicies',
      'allowedBulkActions',
      'retentionDays',
    ],
    'Triage settings',
  )
  if (!Array.isArray(record.rules) || !Array.isArray(record.rotations) ||
    !Array.isArray(record.slaPolicies)) throw invalidInput('Triage settings lists are invalid.')
  return {
    expectedRevision: readNonNegativeInteger(record.expectedRevision, 'Expected revision'),
    rules: record.rules.map(readRoutingRule),
    rotations: record.rotations.map((value) => {
      const rotation = readObject(value, 'Triage owner rotation')
      requireOnlyKeys(rotation, ['id', 'name', 'memberUserIds', 'nextIndex'], 'Triage owner rotation')
      if (!Array.isArray(rotation.memberUserIds)) throw invalidInput('Rotation members are invalid.')
      return {
        id: readIdentifier(rotation.id, 'Rotation ID'),
        name: readText(rotation.name, 'Rotation name', 200),
        memberUserIds: rotation.memberUserIds.map((member) => readUserId(member, 'Rotation member ID')),
        nextIndex: readNonNegativeInteger(rotation.nextIndex, 'Rotation next index'),
      }
    }),
    slaPolicies: record.slaPolicies.map(readSlaPolicy),
    allowedBulkActions: readAllowedBulkActions(record.allowedBulkActions),
    retentionDays: readPositiveInteger(record.retentionDays, 'Retention days', 3_650),
  }
}

/** Strictly parses the unique bulk operations enabled for a Team.
 *
 * @param value The untrusted allowed-action list.
 * @returns The validated unique supported actions.
 */
function readAllowedBulkActions(value: unknown): TriageBulkOperation['action'][] {
  if (!Array.isArray(value)) throw invalidInput('Allowed bulk actions are invalid.')
  const actions = value.map((action) => {
    if (action === 'assign' || action === 'decline' || action === 'snooze') return action
    throw invalidInput('Allowed bulk actions are invalid.')
  })
  if (new Set(actions).size !== actions.length) {
    throw invalidInput('Allowed bulk actions must be unique.')
  }
  return actions
}

/** Strictly parses one routing rule. */
function readRoutingRule(value: unknown): TriageRoutingRule {
  const rule = readObject(value, 'Triage routing rule')
  requireOnlyKeys(rule, [
    'id', 'name', 'enabled', 'order', 'sourceKinds', 'keywords', 'teamId', 'projectId', 'owner',
  ], 'Triage routing rule')
  if (!Array.isArray(rule.sourceKinds) || !Array.isArray(rule.keywords) ||
    typeof rule.enabled !== 'boolean') throw invalidInput('Triage routing rule is invalid.')
  return {
    id: readIdentifier(rule.id, 'Routing rule ID'),
    name: readText(rule.name, 'Routing rule name', 200),
    enabled: rule.enabled,
    order: readNonNegativeInteger(rule.order, 'Routing rule order'),
    sourceKinds: rule.sourceKinds.map(readSourceKind),
    keywords: rule.keywords.map((keyword) => readText(keyword, 'Routing keyword', 200)),
    teamId: readIdentifier(rule.teamId, 'Routing Team ID'),
    ...(rule.projectId === undefined
      ? {}
      : { projectId: readIdentifier(rule.projectId, 'Routing Project ID') }),
    owner: readOwnerStrategy(rule.owner),
  }
}

/** Strictly parses one owner strategy. */
function readOwnerStrategy(value: unknown): TriageOwnerStrategy {
  const owner = readObject(value, 'Triage owner strategy')
  if (owner.type === 'unowned') {
    requireOnlyKeys(owner, ['type'], 'Unowned strategy')
    return { type: 'unowned' }
  }
  if (owner.type === 'fixed') {
    requireOnlyKeys(owner, ['type', 'ownerUserId'], 'Fixed owner strategy')
    return { type: 'fixed', ownerUserId: readUserId(owner.ownerUserId, 'Owner user ID') }
  }
  if (owner.type === 'rotation') {
    requireOnlyKeys(owner, ['type', 'rotationId'], 'Rotation owner strategy')
    return { type: 'rotation', rotationId: readIdentifier(owner.rotationId, 'Rotation ID') }
  }
  throw invalidInput('Triage owner strategy is invalid.')
}

/** Strictly parses one SLA policy. */
function readSlaPolicy(value: unknown): TriageSlaPolicy {
  const policy = readObject(value, 'Triage SLA policy')
  requireOnlyKeys(policy, [
    'id', 'name', 'sourceKinds', 'responseMinutes', 'escalationMinutes', 'escalationOwnerUserId',
  ], 'Triage SLA policy')
  if (!Array.isArray(policy.sourceKinds)) throw invalidInput('SLA source kinds are invalid.')
  return {
    id: readIdentifier(policy.id, 'SLA policy ID'),
    name: readText(policy.name, 'SLA policy name', 200),
    sourceKinds: policy.sourceKinds.map(readSourceKind),
    responseMinutes: readPositiveInteger(policy.responseMinutes, 'SLA response minutes', 525_600),
    ...(policy.escalationMinutes === undefined
      ? {}
      : {
          escalationMinutes: readPositiveInteger(
            policy.escalationMinutes,
            'SLA escalation minutes',
            525_600,
          ),
        }),
    ...(policy.escalationOwnerUserId === undefined
      ? {}
      : {
          escalationOwnerUserId: readUserId(
            policy.escalationOwnerUserId,
            'Escalation owner user ID',
          ),
        }),
  }
}

/** Captures the real HTTP request as immutable assignment-audit context.
 *
 * @param context Matched Hono request, including request and correlation headers.
 * @param principal Authenticated Workspace principal resolved for the Team route.
 * @param entryId Stable target Entry used to namespace the Workspace-scoped audit event ID.
 * @param body Strictly parsed semantic body for the original single or bulk request.
 * @param idempotency Target-specific replay protection used by the transaction receipt.
 * @returns A normalized audit context safe to persist with the assignment transaction.
 */
function createTriageApiAuditContext(
  context: Context,
  principal: TriagePrincipal,
  entryId: string,
  body: unknown,
  idempotency: TriageIdempotency,
): MutationAuditContext {
  try {
    const path = new URL(context.req.url).pathname
    const correlationId = principal.auditCorrelationId ??
      context.req.header('X-Correlation-Id')?.trim()
    return createMutationAuditContext({
      workspaceId: principal.workspaceId,
      actor: principal.auditActor,
      idempotencyKey: createTriageActionAuditIdempotencyKey(entryId, idempotency),
      ...(correlationId ? { correlationId } : {}),
      request: {
        method: context.req.method,
        path,
        body,
      },
      source: {
        kind: 'api',
        requestId: context.req.header('X-Request-Id'),
        method: context.req.method,
        route: path,
        ipAddress: context.req.header('X-Forwarded-For')?.split(',')[0]?.trim(),
        userAgent: context.req.header('User-Agent'),
      },
    })
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      throw invalidInput(error.message)
    }
    throw error
  }
}

/** Creates validated fingerprint-bound replay protection. */
function createIdempotency(header: string | undefined, semanticInput: unknown): TriageIdempotency {
  return {
    key: readIdempotencyKey(header),
    fingerprint: createTriageInputFingerprint(semanticInput),
  }
}

/** Requires an Idempotency-Key header. */
function readIdempotencyKey(value: string | undefined): string {
  if (value === undefined) throw invalidInput('Idempotency-Key is required.')
  return readText(value, 'Idempotency-Key', 160)
}

/** Reads a supported queue state. */
function readState(value: unknown): TriageEntryListInput['state'] {
  if (value === 'pending' || value === 'accepted' || value === 'duplicate' ||
    value === 'declined' || value === 'snoozed' || value === 'needs-information') return value
  throw invalidInput('Triage state is invalid.')
}

/** Reads a supported source kind. */
function readSourceKind(value: unknown): TriageSourceKind {
  if (value === 'form' || value === 'chat' || value === 'email' ||
    value === 'webhook' || value === 'manual-handoff') return value
  throw invalidInput('Triage source kind is invalid.')
}

/** Reads a queue owner filter. */
function readOwnerFilter(value: string | undefined): string | 'unowned' {
  if (value === 'unowned') return value
  return readUserId(value, 'Owner user ID')
}

/** Reads a bounded queue limit. */
function readLimit(value: string | undefined): number {
  return readPositiveInteger(value === undefined ? 50 : Number(value), 'Triage page limit', 100)
}

/** Reads an optimistic concurrency revision. */
function readRevision(value: unknown): number {
  return readPositiveInteger(value, 'Expected revision', Number.MAX_SAFE_INTEGER)
}

/** Reads a bounded positive integer. */
function readPositiveInteger(value: unknown, label: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw invalidInput(`${label} is invalid.`)
  }
  return value
}

/** Reads a bounded non-negative integer. */
function readNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidInput(`${label} is invalid.`)
  }
  return value
}

/** Reads a conservative identifier. */
function readIdentifier(value: unknown, label: string): string {
  const identifier = readText(value, label, 200)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(identifier)) {
    throw invalidInput(`${label} is invalid.`)
  }
  return identifier
}

/** Reads a stable Workspace user identifier, including email-shaped member keys. */
function readUserId(value: unknown, label: string): string {
  const identifier = readText(value, label, 320)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/u.test(identifier)) {
    throw invalidInput(`${label} is invalid.`)
  }
  return identifier.toLowerCase()
}

/** Reads bounded text, optionally allowing empty content. */
function readText(
  value: unknown,
  label: string,
  maximumLength: number,
  allowEmpty = false,
): string {
  if (typeof value !== 'string') throw invalidInput(`${label} is invalid.`)
  const normalized = value.trim()
  if ((!allowEmpty && !normalized) || normalized.length > maximumLength) {
    throw invalidInput(`${label} is invalid.`)
  }
  return normalized
}

/** Reads a parseable ISO 8601 instant. */
function readIsoInstant(value: unknown, label: string): string {
  const text = readText(value, label, 100)
  const instant = new Date(text)
  if (!Number.isFinite(instant.getTime())) throw invalidInput(`${label} is invalid.`)
  return instant.toISOString()
}

/** Reads a conservative email address. */
function readEmail(value: unknown): string {
  const email = readText(value, 'Requester email', 320).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw invalidInput('Requester email is invalid.')
  return email
}

/** Narrows an untrusted JSON value to a non-array object. */
function readObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalidInput(`${label} must be an object.`)
  return value
}

/** Rejects unrecognized input fields at the transport boundary. */
function requireOnlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed)
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw invalidInput(`${label} contains an unsupported field.`)
  }
}

/** Checks whether an untrusted value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Creates a stable malformed-input error. */
function invalidInput(message: string): TriageError {
  return new TriageError(400, 'InvalidTriageInput', message)
}
