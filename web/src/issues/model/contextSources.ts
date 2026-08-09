import type {
  CuratedContextItem,
  CuratedContextSource,
  CuratedContextSourceKind,
} from '@mukuroji/contracts'

const issueSourceKinds: readonly CuratedContextSourceKind[] = [
  'comment',
  'external-chat',
  'document',
  'activity',
]

/**
 * One immutable provenance snapshot and the curated item that owns it.
 */
export type IssueSourceEntry = {
  /** Source provenance snapshot. */
  source: CuratedContextSource
  /** Curated item that provides the current human interpretation. */
  item: CuratedContextItem
}

/**
 * Unambiguous source target used for in-panel cross-links.
 */
export type IssueSourceTarget = {
  /** Curated context item that owns this immutable provenance snapshot. */
  contextItemId: string
  /** Source system category. */
  kind?: CuratedContextSourceKind
  /** Stable identifier inside the source category. */
  sourceId?: string
}

/**
 * Optional source focus decoded from the current route.
 */
export type IssueSourceFocus = {
  /** Curated context item that owns the requested provenance snapshot. */
  contextItemId?: string
  /** Source system category used to disambiguate duplicate identifiers. */
  kind?: CuratedContextSourceKind
  /** Stable identifier inside the source category. */
  sourceId?: string
}

/**
 * Projects every source-bearing context item into its own immutable audit entry.
 *
 * Two context items may deliberately capture a different revision or quote from the same source,
 * so source IDs must never be used to collapse audit history.
 *
 * @param items - Loaded curated context items.
 * @returns One source entry per source-bearing context item.
 */
export function createIssueSourceEntries(
  items: readonly CuratedContextItem[],
): IssueSourceEntry[] {
  return items.flatMap((item) =>
    item.source ? [{ item, source: item.source }] : [],
  )
}

/**
 * Creates a DOM anchor keyed by the context item that owns the source snapshot.
 *
 * @param contextItemId - Context item owning the provenance snapshot.
 * @returns DOM-safe provenance anchor ID.
 */
export function createIssueSourceAnchorId(contextItemId: string): string {
  return `context-source-item-${encodeURIComponent(contextItemId)}`
}

/**
 * Resolves source focus while retaining valid route targets and discarding a stale route kind.
 *
 * @param routeFocus - Optional target decoded from the current URL.
 * @param selectedTarget - Exact target selected from the Decisions tab in this panel instance.
 * @returns One internally consistent source focus target, with explicit route IDs taking priority.
 */
export function resolveIssueSourceFocus(
  routeFocus: IssueSourceFocus,
  selectedTarget: IssueSourceTarget | undefined,
): IssueSourceFocus {
  if (
    !selectedTarget ||
    routeFocus.contextItemId !== undefined ||
    routeFocus.sourceId !== undefined
  ) {
    return routeFocus
  }

  return {
    contextItemId: selectedTarget.contextItemId,
    kind: selectedTarget.kind,
    sourceId: selectedTarget.sourceId,
  }
}

/**
 * Reads an optional source-kind route discriminator without trusting URL input.
 *
 * @param value - Raw query-string value.
 * @returns A supported provenance kind or undefined.
 */
export function readIssueSourceKind(
  value: string | null,
): CuratedContextSourceKind | undefined {
  if (!value) return undefined
  return issueSourceKinds.find((kind) => kind === value)
}
