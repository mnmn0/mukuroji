import type { PlanningHealth, PlanningLatestUpdateSummary, PlanningUpdateState, PlanningUpdateTarget } from './planning'

/** Standard views over the latest update of each configured target. */
export type UpdateFeedView = 'for-me' | 'recent' | 'at-risk' | 'missing' | 'stale' | 'overdue'

/** Explainable relevance signals available without reading historical annotations. */
export type UpdateFeedReason = 'update-owner' | 'latest-author'

/** One current, authorized Project or Initiative projection. */
export type UpdateFeedEntry = {
  /** Current authorized target name. */
  title: string
  /** Team-qualified Project or Initiative identity for existing detail/history routes. */
  target: PlanningUpdateTarget
  /** Reported health, independently of submission freshness. */
  health: PlanningHealth
  /** Current submission freshness, evaluated by Planning. */
  updateState: PlanningUpdateState
  /** Latest authorized canonical summary; absent before the first report. */
  latestUpdate?: Omit<PlanningLatestUpdateSummary, 'capturedScope'>
  /** Stable reasons explaining the current relevance score. */
  reasons: UpdateFeedReason[]
  /** Owner contributes two points; latest author contributes one. */
  relevance: number
  /** Per-member read state for this exact published version; absent without readable content. */
  readState?: UpdateFeedReadState
}

/** Durable member-specific state with optimistic concurrency. */
export type UpdateFeedReadState = {
  /** Whether this exact immutable version was marked read. */
  read: boolean
  /** State revision; zero means no saved state. */
  revision: number
}

/** Explicit read/unread mutation for one visible immutable report. */
export type SetUpdateFeedReadStateInput = {
  /** Current target selected from an authorized feed. */
  target: PlanningUpdateTarget
  /** Exact report version; newer reports remain unread. */
  version: number
  /** Desired read state. */
  read: boolean
  /** Last observed state revision to guard concurrent devices. */
  expectedRevision: number
}

/** Bounded, live aggregate response; no persisted feed copy is created. */
export type UpdateFeedResponse = {
  /** Selected standard view. */
  view: UpdateFeedView
  /** Current Planning graph revision used for the projection. */
  revision: number
  /** Ranked entries, capped at the requested limit. */
  entries: UpdateFeedEntry[]
  /** Total authorized matches before applying the response limit. */
  total: number
  /** Explicitly signals that additional matches were omitted by the limit. */
  truncated: boolean
}

/** Personal saved filters: alternatives within a dimension, intersection across dimensions. */
export type UpdateFeedFilters = {
  /** Current Team scopes; empty means unrestricted. */
  teamIds: string[]
  /** Team-qualified Project targets/scopes; empty means unrestricted. */
  projects: { /** Owning Team. */ teamId: string; /** Project within that Team. */ projectId: string }[]
  /** Current Portfolio ancestors; empty means unrestricted. */
  portfolioIds: string[]
  /** Exact Initiative targets; empty means unrestricted. */
  initiativeIds: string[]
  /** Reported health values, independent of submission freshness. */
  health: PlanningHealth[]
  /** Current submission freshness values. */
  updateStates: PlanningUpdateState[]
}

/** A member-owned filter definition, never a copy of report content. */
export type SavedUpdateFeed = {
  /** Stable member-local identifier. */
  id: string
  /** User-provided display name. */
  name: string
  /** Standard view and ranking to refine. */
  view: UpdateFeedView
  /** Explicit bounded dimensions. */
  filters: UpdateFeedFilters
}

/** Bounded personal collection, replaced with compare-and-swap for CRUD. */
export type SavedUpdateFeeds = {
  /** Revision zero denotes an empty unsaved collection. */
  revision: number
  /** At most twenty member-owned definitions. */
  feeds: SavedUpdateFeed[]
}

/** Desired personal collection and last observed revision. */
export type ReplaceSavedUpdateFeedsInput = {
  /** Last observed revision, guarding concurrent sessions. */
  expectedRevision: number
  /** Complete desired collection: add, edit, or omit a definition to delete it. */
  feeds: SavedUpdateFeed[]
}

/** A currently readable logical selector and its current display name. */
export type UpdateFeedNamedOption = {
  /** Logical identifier, never a persistence key. */
  id: string
  /** Current authorized display label. */
  name: string
}

/** Current authorized options drawn from the bounded target graph. */
export type UpdateFeedFilterOptions = {
  /** Team scopes containing readable targets. */
  teams: UpdateFeedNamedOption[]
  /** Qualified Project scopes containing readable targets. */
  projects: { /** Owning Team. */ teamId: string; /** Local Project identifier. */ projectId: string; /** Current authorized name. */ name: string }[]
  /** Readable active Portfolio ancestors of these targets. */
  portfolios: UpdateFeedNamedOption[]
  /** Readable configured Initiative targets. */
  initiatives: UpdateFeedNamedOption[]
}
