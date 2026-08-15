/**
 * Current schema version for human-curated collaboration context.
 */
export const COLLABORATION_CONTEXT_SCHEMA_VERSION = 1

/**
 * Semantic category assigned to a curated context item.
 */
export type CuratedContextItemKind = 'decision' | 'action' | 'risk' | 'context'

/**
 * Lifecycle state of a curated context item.
 */
export type CuratedContextItemState =
  | 'active'
  | 'accepted'
  | 'completed'
  | 'superseded'

/**
 * Kind of evidence captured as the source of a curated context item.
 */
export type CuratedContextSourceKind =
  | 'comment'
  | 'external-chat'
  | 'document'
  | 'activity'

/**
 * Current ability to inspect the source behind a curated context item.
 */
export type CuratedContextSourceAvailability =
  | 'available'
  | 'edited'
  | 'deleted'
  | 'permission-lost'
  | 'retention-expired'

/**
 * Display-safe identity snapshot retained for collaboration history.
 */
export type CuratedContextActorSnapshot = {
  /**
   * Stable workspace- or provider-scoped actor identifier.
   */
  id: string
  /**
   * Actor display name captured when the surrounding record was written.
   */
  displayName: string
  /**
   * Stable avatar URL captured when policy permits retaining it.
   */
  avatarUrl?: string
}

/**
 * Immutable text excerpt captured from a curated context source.
 */
export type CuratedContextQuote =
  | {
      /** Exact source text retained for historical readability. */
      text: string
    }
  | {
      /** Exact source text retained for historical readability. */
      text: string
      /** Inclusive UTF-16 offset into the captured original body. */
      startOffset: number
      /** Exclusive UTF-16 offset into the captured original body. */
      endOffset: number
    }

/**
 * Auditable provenance retained for evidence promoted into curated context.
 */
export type CuratedContextSource = {
  /**
   * Source system category used to resolve navigation and current availability.
   */
  kind: CuratedContextSourceKind
  /**
   * Stable identifier of the exact comment, message, document, or activity event.
   */
  sourceId: string
  /**
   * Stable identifier of the source thread, channel, document container, or activity scope.
   */
  containerId?: string
  /**
   * Bounded original source body captured when retention policy permits it.
   */
  originalBody?: string
  /**
   * Exact excerpt selected from the original source body.
   */
  quote?: CuratedContextQuote
  /**
   * Stable source permalink retained when current permissions allow navigation.
   */
  permalink?: string
  /**
   * Display-safe snapshot of the source actor when one is known and retainable.
   */
  actor?: CuratedContextActorSnapshot
  /**
   * ISO 8601 timestamp at which the source content or event originally occurred.
   */
  occurredAt: string
  /**
   * Source-native revision captured when this provenance snapshot was created.
   */
  capturedRevision?: string | number
  /**
   * Latest source-native revision observed during availability reconciliation.
   */
  currentRevision?: string | number
  /**
   * Current availability or mutation state of the source.
   */
  availability: CuratedContextSourceAvailability
  /**
   * Human-readable reason why the source differs from or cannot expose the captured body.
   */
  availabilityReason?: string
}

/**
 * Human-curated decision, action, risk, or supporting context attached to a Work Item.
 */
export type CuratedContextItem = {
  /**
   * Collaboration context schema version used to interpret this item.
   */
  schemaVersion: typeof COLLABORATION_CONTEXT_SCHEMA_VERSION
  /**
   * Stable curated context item identifier.
   */
  id: string
  /**
   * Team that owns the associated Work Item.
   */
  teamId: string
  /**
   * Work Item that owns this curated context item.
   */
  workItemId: string
  /**
   * Semantic category selected by the curator.
   */
  kind: CuratedContextItemKind
  /**
   * Current lifecycle state of the item.
   */
  state: CuratedContextItemState
  /**
   * Short human-authored label used in context lists and search results.
   */
  title: string
  /**
   * Human-authored Markdown explanation of the curated context.
   */
  body: string
  /**
   * Optional source evidence snapshot supporting this item.
   */
  source?: CuratedContextSource
  /**
   * Stable Workspace member keys mentioned by the curated body.
   */
  mentionMemberKeys: string[]
  /**
   * Actor snapshot captured when the item was first created.
   */
  createdBy: CuratedContextActorSnapshot
  /**
   * ISO 8601 timestamp at which the item was created.
   */
  createdAt: string
  /**
   * Actor snapshot captured for the most recent item mutation.
   */
  updatedBy: CuratedContextActorSnapshot
  /**
   * ISO 8601 timestamp of the most recent item mutation.
   */
  updatedAt: string
  /**
   * Monotonic revision used for optimistic concurrency control.
   */
  revision: number
  /**
   * Newer curated context item that explicitly replaces this item.
   */
  supersededByItemId?: string
}

/**
 * Permission-derived actions available in the current curated context scope.
 */
export type CuratedContextCapabilities = {
  /**
   * Whether the current viewer may create curated context items.
   */
  canCreate: boolean
  /**
   * Whether the current viewer may edit mutable curated context items.
   */
  canEdit: boolean
  /**
   * Whether the current viewer may replace an item while preserving its history.
   */
  canReplace: boolean
  /**
   * Whether the current viewer may choose or replace a thread's accepted resolution.
   */
  canAcceptResolution: boolean
}

/**
 * Cursor-paginated curated context response for one Work Item.
 */
export type CuratedContextPage = {
  /**
   * Collaboration context schema version used to interpret this page.
   */
  schemaVersion: typeof COLLABORATION_CONTEXT_SCHEMA_VERSION
  /**
   * Permission-filtered curated context items in deterministic display order.
   */
  items: CuratedContextItem[]
  /**
   * Opaque scope-bound cursor used to request the next page.
   */
  nextCursor?: string
  /**
   * Actions authorized for the current viewer in this Work Item scope.
   */
  capabilities: CuratedContextCapabilities
}

/**
 * Cursor-paginated immutable revision history for one curated context item.
 */
export type CuratedContextRevisionPage = {
  /**
   * Historical item snapshots ordered from newest revision to oldest.
   */
  items: CuratedContextItem[]
  /**
   * Opaque item-bound cursor used to request the next page.
   */
  nextCursor?: string
}

/**
 * Input for creating a human-curated context item.
 */
export type CreateCuratedContextItemRequest = {
  /**
   * Semantic category assigned to the new item.
   */
  kind: CuratedContextItemKind
  /**
   * Short human-authored label for the item.
   */
  title: string
  /**
   * Human-authored Markdown explanation for the item.
   */
  body: string
  /**
   * Optional source evidence snapshot supporting the item. When replacing an
   * existing item, omission preserves the predecessor's immutable snapshot.
   */
  source?: CuratedContextSource
  /**
   * Stable Workspace member keys mentioned by the body.
   */
  mentionMemberKeys?: string[]
  /**
   * Existing item that this newly created item atomically supersedes.
   */
  supersedesItemId?: string
}

/**
 * Revision-fenced input for updating a curated context item in place.
 */
export type UpdateCuratedContextItemRequest = {
  /**
   * Item revision observed before constructing this update.
   */
  expectedRevision: number
  /**
   * Replacement semantic category when the item's meaning changes without supersession.
   */
  kind?: CuratedContextItemKind
  /**
   * Replacement lifecycle state for the item. Supersession requires an atomic replacement.
   */
  state?: Exclude<CuratedContextItemState, 'superseded'>
  /**
   * Replacement human-authored title.
   */
  title?: string
  /**
   * Replacement human-authored Markdown body.
   */
  body?: string
  /**
   * Complete replacement set of mentioned Workspace member keys.
   */
  mentionMemberKeys?: string[]
}

/**
 * Human-selected conclusion retained for a resolved collaboration thread.
 */
export type AcceptedResolution = {
  /**
   * Stable accepted resolution identifier retained across supersession.
   */
  id: string
  /**
   * Exact comment chosen as the source of the accepted resolution.
   */
  sourceCommentId: string
  /**
   * Root comment identifying the collaboration thread that owns this resolution.
   */
  sourceRootCommentId: string
  /**
   * Source comment revision captured when the resolution was accepted.
   */
  capturedCommentRevision: number
  /**
   * Source comment Markdown captured when the resolution was accepted.
   */
  capturedCommentBody: string
  /**
   * Stable author key captured from the source comment when available.
   *
   * This remains optional so older accepted-resolution snapshots can still be
   * read safely; the UI omits the source-author label when it is absent.
   */
  capturedCommentAuthorMemberKey?: string
  /**
   * Required manually edited summary that remains authoritative after source changes.
   */
  summary: string
  /**
   * Actor snapshot captured when the resolution was accepted.
   */
  acceptedBy: CuratedContextActorSnapshot
  /**
   * ISO 8601 timestamp at which the resolution was accepted.
   */
  acceptedAt: string
  /**
   * Whether this resolution is current or retained only as superseded history.
   */
  state: 'accepted' | 'superseded'
  /**
   * Newer accepted resolution that replaced this resolution.
   */
  supersededByResolutionId?: string
  /**
   * Actor snapshot captured when this resolution was superseded.
   */
  supersededBy?: CuratedContextActorSnapshot
  /**
   * ISO 8601 timestamp at which this resolution was superseded.
   */
  supersededAt?: string
}

/**
 * Cursor-paginated accepted resolution history for one collaboration thread.
 */
export type AcceptedResolutionPage = {
  /**
   * Accepted resolution snapshots ordered from newest to oldest.
   */
  items: AcceptedResolution[]
  /**
   * Opaque thread-bound cursor used to request the next page.
   */
  nextCursor?: string
}

/**
 * Revision-fenced input for selecting a thread's accepted resolution.
 */
export type SetAcceptedResolutionRequest = {
  /**
   * Thread version observed before choosing this accepted resolution.
   */
  expectedThreadVersion: number
  /**
   * Comment in the thread chosen as the source of the resolution.
   */
  commentId: string
  /**
   * Required manually authored summary of the accepted conclusion.
   */
  summary: string
}
