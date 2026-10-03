import type { PlanningHealth, PlanningLatestUpdateSummary, PlanningUpdateState, PlanningUpdateTarget } from './planning'

/** Standard views over the latest update of each configured target. */
export type UpdateFeedView = 'for-me' | 'recent' | 'at-risk' | 'missing' | 'stale' | 'overdue'

/** Explainable relevance signals available without reading historical annotations. */
export type UpdateFeedReason = 'update-owner' | 'latest-author'

/** One current, authorized Project or Initiative projection. */
export type UpdateFeedEntry = {
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
