import type {
  ExternalChatSourceAvailability,
  ExternalChatSourceState,
  ExternalChatWorkItemLink,
} from '@mukuroji/contracts'
import {
  externalChatLifecycleBlocksSynchronization,
  type ExternalChatLinkLifecycleState,
  type ExternalChatParentLifecycleFenceSnapshot,
} from './external-chat'

/** Effective source lifecycle composed from private observations and parent authorities. */
export type ExternalChatEffectiveLifecycleState = {
  /** Most restrictive current source reachability. */
  availability: ExternalChatSourceAvailability
  /** Most restrictive current source lifecycle state. */
  state: ExternalChatSourceState
}

/**
 * Returns the fail-closed rank of one source availability value.
 *
 * @param value - Provider reachability to rank.
 * @returns Monotonic restrictive rank.
 */
export function lifecycleAvailabilityRank(value: ExternalChatSourceAvailability): number {
  if (value === 'available') return 0
  if (value === 'temporarily-unavailable') return 1
  if (value === 'needs-reauth') return 2
  if (value === 'installation-disconnected') return 3
  if (value === 'scope-changed') return 4
  return 5
}

/**
 * Returns the fail-closed rank of one provider lifecycle state.
 *
 * @param value - Provider lifecycle state to rank.
 * @returns Monotonic restrictive rank.
 */
export function lifecycleSourceStateRank(value: ExternalChatSourceState): number {
  if (value === 'active') return 0
  if (value === 'completed') return 1
  if (value === 'retained-metadata') return 2
  if (value === 'deleted') return 3
  return 4
}

/**
 * Composes link-local observations with exact restrictive parent fences.
 *
 * @param state - Private scope-local lifecycle observations.
 * @param parentFences - Strongly read workspace and conversation authorities.
 * @param minimumAuthorizationRevision - Oldest applicable authorization generation.
 * @returns Most restrictive effective lifecycle state.
 */
export function effectiveExternalChatLifecycleState(
  state: ExternalChatLinkLifecycleState,
  parentFences: ExternalChatParentLifecycleFenceSnapshot,
  minimumAuthorizationRevision: number,
): ExternalChatEffectiveLifecycleState {
  let availability: ExternalChatSourceAvailability = 'available'
  let sourceState: ExternalChatSourceState = 'active'
  for (const observation of [state.workspace, state.conversation, state.thread]) {
    if (
      observation === undefined ||
      observation.authorizationRevision < minimumAuthorizationRevision
    ) continue
    if (lifecycleAvailabilityRank(observation.availability) > lifecycleAvailabilityRank(availability)) {
      availability = observation.availability
    }
    if (lifecycleSourceStateRank(observation.state) > lifecycleSourceStateRank(sourceState)) {
      sourceState = observation.state
    }
  }
  for (const fence of [parentFences.workspace, parentFences.conversation]) {
    if (
      fence?.restrictive !== true ||
      fence.authorizationRevision < minimumAuthorizationRevision
    ) continue
    if (lifecycleAvailabilityRank(fence.availability) > lifecycleAvailabilityRank(availability)) {
      availability = fence.availability
    }
    if (lifecycleSourceStateRank(fence.state) > lifecycleSourceStateRank(sourceState)) {
      sourceState = fence.state
    }
  }
  return { availability, state: sourceState }
}

/**
 * Checks whether provider metadata must be removed from a source projection.
 *
 * @param availability - Effective source reachability.
 * @param state - Effective provider lifecycle state.
 * @returns Whether policy-controlled metadata must be redacted.
 */
export function mustRedactExternalChatSourceMetadata(
  availability: ExternalChatSourceAvailability,
  state: ExternalChatSourceState,
): boolean {
  return availability === 'permission-lost' ||
    availability === 'scope-changed' ||
    state === 'deleted' ||
    state === 'retention-expired'
}

/**
 * Removes provider display, permalink, and quote metadata while retaining source IDs.
 *
 * @param link - Current provider-neutral link projection.
 * @returns Source-redacted link projection.
 */
export function redactExternalChatSourceMetadata(
  link: ExternalChatWorkItemLink,
): ExternalChatWorkItemLink {
  return {
    ...link,
    workspace: {
      provider: link.workspace.provider,
      externalId: link.workspace.externalId,
    },
    conversation: {
      externalId: link.conversation.externalId,
      externalWorkspaceId: link.conversation.externalWorkspaceId,
      kind: link.conversation.kind,
    },
    source: {
      externalWorkspaceId: link.source.externalWorkspaceId,
      conversationExternalId: link.source.conversationExternalId,
      threadExternalId: link.source.threadExternalId,
      rootMessageExternalId: link.source.rootMessageExternalId,
      ...(link.source.sourceMessageExternalId === undefined
        ? {}
        : { sourceMessageExternalId: link.source.sourceMessageExternalId }),
    },
  }
}

/**
 * Applies an effective lifecycle floor to a public link projection.
 *
 * @param candidate - Candidate public link projection.
 * @param floor - Effective lifecycle restriction the candidate may not relax.
 * @returns Candidate with the lifecycle floor and required redaction applied.
 */
export function composeExternalChatLinkProjectionWithLifecycleFloor(
  candidate: ExternalChatWorkItemLink,
  floor: ExternalChatEffectiveLifecycleState,
): ExternalChatWorkItemLink {
  const availability = lifecycleAvailabilityRank(candidate.sourceAvailability) >=
      lifecycleAvailabilityRank(floor.availability)
    ? candidate.sourceAvailability
    : floor.availability
  const state = lifecycleSourceStateRank(candidate.sourceState) >=
      lifecycleSourceStateRank(floor.state)
    ? candidate.sourceState
    : floor.state
  if (availability === candidate.sourceAvailability && state === candidate.sourceState) {
    return candidate
  }
  const projected = mustRedactExternalChatSourceMetadata(availability, state)
    ? redactExternalChatSourceMetadata(candidate)
    : candidate
  return {
    ...projected,
    sourceAvailability: availability,
    sourceState: state,
    syncStatus: externalChatLifecycleBlocksSynchronization(availability, state)
      ? 'paused'
      : 'synced',
  }
}
