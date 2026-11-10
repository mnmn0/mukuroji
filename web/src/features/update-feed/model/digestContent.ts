/** Current bounded observations used to invalidate ephemeral digest content. */
export type DigestContentObservation = {
  /** Explicit URL selection, independent of delayed definition hydration. */ scope: string
  /** Successful Planning revision and report/read-state fingerprint. */ feed?: string
  /** Successful personal definition revision. */ saved?: number
  /** Whether the Feed read currently failed. */ feedFailed: boolean
  /** Whether the definition read currently failed. */ savedFailed: boolean
}

/** Last successful baselines and the invalidation generation they establish. */
export type DigestContentState = DigestContentObservation & {
  /** Advances only for scope changes, changed known data, or loss of known data. */ generation: number
}

/** Establishes first observations without confusing hydration with a data change.
 * @param previous - Retained successful baselines for this session.
 * @param observed - Current query outcomes and explicit selection.
 * @returns Stable state identity until an observation changes.
 */
export function observeDigestContent(previous: DigestContentState | undefined, observed: DigestContentObservation): DigestContentState {
  const sameScope = previous?.scope === observed.scope
  const changed = previous !== undefined && (!sameScope ||
    (previous.feed !== undefined && observed.feed !== undefined && previous.feed !== observed.feed) ||
    (previous.saved !== undefined && observed.saved !== undefined && previous.saved !== observed.saved) ||
    (previous.feed !== undefined && observed.feedFailed && !previous.feedFailed) ||
    (previous.saved !== undefined && observed.savedFailed && !previous.savedFailed))
  const next = { ...observed, feed: observed.feed ?? (sameScope ? previous?.feed : undefined), saved: observed.saved ?? (sameScope ? previous?.saved : undefined), generation: (previous?.generation ?? 0) + (changed ? 1 : 0) }
  if (previous && previous.scope === next.scope && previous.feed === next.feed && previous.saved === next.saved && previous.feedFailed === next.feedFailed && previous.savedFailed === next.savedFailed && previous.generation === next.generation) return previous
  return next
}
