import {
  type ConfirmWorkItemScheduleChangeResponse,
  type WorkItemSchedule,
  type WorkItemScheduleChangePreview,
  type WorkItemScheduleEvaluationRevision,
  type WorkItemScheduleImpact,
  type WorkItemScheduleOperation,
} from '@mukuroji/contracts'
import { WorkItemScheduleError } from '../../domain/work-item-schedule'

/** Idempotency identity bound to one confirmed schedule request. */
export type WorkItemScheduleConfirmationReservationRequest = {
  /** Opaque Workspace namespace. */
  workspaceId: string
  /** Opaque caller credential namespace. */
  credentialId: string
  /** Caller-provided idempotency key. */
  idempotencyKey: string
  /** Stable digest of the request method, path, and body. */
  requestFingerprint: string
}

/** Result of reserving one confirmed schedule request. */
export type WorkItemScheduleConfirmationReservation =
  | {
      /** The caller owns a new reservation. */
      status: 'reserved'
      /** Opaque ownership token required by the atomic receipt. */
      reservationId: string
    }
  | {
      /** An equivalent request is already being processed. */
      status: 'in-progress'
    }
  | {
      /** An equivalent request already completed. */
      status: 'replay'
      /** Stored response validated by the replay port. */
      response: unknown
    }

/** Validated command for explicitly confirming a Work Item schedule cascade. */
export type ConfirmWorkItemScheduleChangeCommand = {
  /** Team that owns the directly edited Work Item. */
  teamId: string
  /** Team-local identifier of the directly edited Work Item. */
  workItemId: string
  /** Direct Work Item revision returned by preview. */
  expectedRevision: number
  /** Planning revision returned by preview. */
  expectedPlanningRevision: number
  /** Semantic relation graph revision returned by preview. */
  expectedRelationGraphRevision: number
  /** Every Work Item revision used by preview. */
  expectedEvaluatedRevisions: readonly WorkItemScheduleEvaluationRevision[]
  /** Exact schedule impacts shown to the user. */
  expectedImpacts: readonly WorkItemScheduleImpact[]
  /** Validated direct schedule operation. */
  operation: WorkItemScheduleOperation
  /** User-scoped idempotency reservation identity. */
  reservationRequest: WorkItemScheduleConfirmationReservationRequest
}

/** One revision-bound schedule replacement passed to the persistence port. */
export type ConfirmWorkItemScheduleUpdate = {
  /** Team that owns the Work Item. */
  teamId: string
  /** Team-local Work Item identifier. */
  workItemId: string
  /** Revision that must still match atomically. */
  expectedRevision: number
  /** Complete replacement schedule. */
  schedule: WorkItemSchedule
}

/** Persistence command derived from a newly recomputed and matched preview. */
export type PersistConfirmedWorkItemScheduleChange = {
  /** Direct and propagated schedule replacements in preview order. */
  updates: readonly ConfirmWorkItemScheduleUpdate[]
  /** Evaluated but unchanged Work Items that must remain at the observed revision. */
  guardedRevisions: readonly WorkItemScheduleEvaluationRevision[]
  /** Planning revision used to build the authorization fence. */
  expectedPlanningRevision: number
  /** Semantic relation graph revision that must remain stable through persistence. */
  expectedRelationGraphRevision: number
  /** Every endpoint that influenced the durable replay response. */
  authorizationEndpoints: readonly WorkItemScheduleEvaluationRevision[]
  /** Reservation token committed with the canonical schedule transaction. */
  reservation: WorkItemScheduleConfirmationReservationRequest & {
    /** Opaque ownership token returned by the reservation port. */
    reservationId: string
  }
}

/** Application ports required to confirm a schedule change safely. */
export type ConfirmWorkItemScheduleChangeDependencies = {
  /**
   * Reserves the caller's idempotency identity.
   *
   * @param request - Credential-scoped request identity.
   * @returns Whether this request is new, in progress, or a completed replay.
   */
  reserve(
    request: WorkItemScheduleConfirmationReservationRequest,
  ): Promise<WorkItemScheduleConfirmationReservation>
  /**
   * Releases an incomplete reservation without deleting an atomically completed receipt.
   *
   * @param request - Reservation identity and ownership token to release.
   * @returns Completion after the release attempt reaches the persistence port.
   */
  release(
    request: WorkItemScheduleConfirmationReservationRequest & { reservationId: string },
  ): Promise<void>
  /**
   * Validates, reauthorizes, and returns a stored replay response.
   *
   * @param value - Untrusted stored response from the idempotency port.
   * @param command - Current validated confirmation command.
   * @returns Exact previously committed response after current authorization succeeds.
   */
  replay(
    value: unknown,
    command: ConfirmWorkItemScheduleChangeCommand,
  ): Promise<ConfirmWorkItemScheduleChangeResponse>
  /**
   * Strongly rereads all inputs and recomputes the authoritative preview.
   *
   * @param command - Current validated confirmation command.
   * @returns Fresh server-authoritative schedule preview.
   */
  recompute(
    command: ConfirmWorkItemScheduleChangeCommand,
  ): Promise<WorkItemScheduleChangePreview>
  /**
   * Atomically persists the matched schedule cascade and its durable receipt.
   *
   * @param input - Revision-fenced schedules, guards, and reservation token.
   * @returns Compact schedules committed by the canonical transaction.
   */
  persist(
    input: PersistConfirmedWorkItemScheduleChange,
  ): Promise<ConfirmWorkItemScheduleChangeResponse>
}

/**
 * Confirms one schedule cascade only when a fresh server preview exactly matches user consent.
 *
 * @param command - Validated confirmation command from the transport adapter.
 * @param dependencies - Authorization, recomputation, idempotency, and persistence ports.
 * @returns The compact schedules committed by the atomic cascade transaction.
 */
export async function confirmWorkItemScheduleChange(
  command: ConfirmWorkItemScheduleChangeCommand,
  dependencies: ConfirmWorkItemScheduleChangeDependencies,
): Promise<ConfirmWorkItemScheduleChangeResponse> {
  const reservation = await dependencies.reserve(command.reservationRequest)
  if (reservation.status === 'in-progress') {
    throw new WorkItemScheduleError(
      409,
      'WorkItemScheduleIdempotencyInProgress',
      'The same schedule confirmation is still in progress.',
    )
  }
  if (reservation.status === 'replay') {
    return dependencies.replay(reservation.response, command)
  }

  const reservationToRelease = {
    ...command.reservationRequest,
    reservationId: reservation.reservationId,
  }
  try {
    const preview = await dependencies.recompute(command)
    requireMatchingEvaluationRevisions(command, preview)
    requireMatchingImpacts(command.expectedImpacts, preview.impacts)
    if (preview.conflicts.length > 0) {
      throw new WorkItemScheduleError(
        409,
        'WorkItemScheduleDependencyConflict',
        'Resolve schedule dependency conflicts before confirming this change.',
      )
    }

    const impactedKeys = new Set(preview.impacts.map((impact) =>
      createEndpointKey(impact.teamId, impact.workItemId)
    ))
    const confirmedRevisions = new Map(command.expectedEvaluatedRevisions.map((revision) => [
      createEndpointKey(revision.teamId, revision.workItemId),
      revision.expectedRevision,
    ]))
    return await dependencies.persist({
      updates: preview.impacts.map((impact) => ({
        teamId: impact.teamId,
        workItemId: impact.workItemId,
        expectedRevision: confirmedRevisions.get(
          createEndpointKey(impact.teamId, impact.workItemId),
        ) ?? impact.expectedRevision,
        schedule: impact.after,
      })),
      guardedRevisions: command.expectedEvaluatedRevisions.filter((revision) =>
        !impactedKeys.has(createEndpointKey(revision.teamId, revision.workItemId))
      ),
      expectedPlanningRevision: command.expectedPlanningRevision,
      expectedRelationGraphRevision: command.expectedRelationGraphRevision,
      authorizationEndpoints: preview.evaluatedRevisions,
      reservation: reservationToRelease,
    })
  } catch (error) {
    // A persistence adapter must leave an atomically completed receipt intact after response loss.
    await dependencies.release(reservationToRelease).catch(() => undefined)
    throw error
  }
}

/**
 * Requires recomputation to reproduce the exact direct and propagated preview impacts.
 *
 * @param expected - Canonical impacts copied from the user-visible preview.
 * @param actual - Canonical impacts from current server recomputation.
 */
function requireMatchingImpacts(
  expected: readonly WorkItemScheduleImpact[],
  actual: readonly WorkItemScheduleImpact[],
): void {
  if (stableStringify(actual) !== stableStringify(expected)) {
    throw new WorkItemScheduleError(
      409,
      'WorkItemSchedulePreviewStale',
      'The confirmed schedule operation does not match the preview. Preview the change again.',
    )
  }
}

/**
 * Requires confirmation to name every Work Item revision used by recomputation.
 *
 * @param command - Validated confirmation command.
 * @param preview - Fresh server-authoritative preview.
 */
function requireMatchingEvaluationRevisions(
  command: ConfirmWorkItemScheduleChangeCommand,
  preview: WorkItemScheduleChangePreview,
): void {
  const actual = [...preview.evaluatedRevisions].sort(compareEvaluationRevisions)
  const expected = [...command.expectedEvaluatedRevisions].sort(compareEvaluationRevisions)
  const matches = actual.length === expected.length &&
    actual.every((revision, index) => {
      const expectedRevision = expected[index]
      return expectedRevision !== undefined &&
        revision.teamId === expectedRevision.teamId &&
        revision.workItemId === expectedRevision.workItemId &&
        revision.expectedRevision === expectedRevision.expectedRevision
    }) && preview.expectedRevision === command.expectedRevision
  if (!matches) {
    throw new WorkItemScheduleError(
      409,
      'WorkItemSchedulePreviewStale',
      'A Work Item evaluated by the schedule preview changed. Preview the change again.',
    )
  }
}

/** Compares qualified Work Item revisions for deterministic matching. */
function compareEvaluationRevisions(
  left: WorkItemScheduleEvaluationRevision,
  right: WorkItemScheduleEvaluationRevision,
): number {
  return createEndpointKey(left.teamId, left.workItemId)
    .localeCompare(createEndpointKey(right.teamId, right.workItemId))
}

/** Creates an unambiguous key for one Team-qualified Work Item endpoint. */
function createEndpointKey(teamId: string, workItemId: string): string {
  return `${teamId}\0${workItemId}`
}

/** Serializes JSON-like values with deterministic object-key ordering. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
