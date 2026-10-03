import type { UpdateFeedEntry, UpdateFeedView } from './update-feed'

/** UTC calendar interval used by the preview-only digest. */
export type UpdateFeedDigestFrequency = 'daily' | 'weekly'

/** Personal generation preferences; these never enable a live schedule. */
export type UpdateFeedDigestPreferences = {
  /** Opt-in for manual preview generation only. */
  enabled: boolean
  /** UTC day or Monday-based UTC week. */
  frequency: UpdateFeedDigestFrequency
  /** Union of at most six unique standard views. */
  views: UpdateFeedView[]
}

/** Content-free bounded generation receipt, never a cached notification body. */
export type UpdateFeedDigestReceipt = {
  /** Frequency-qualified UTC calendar start date. */
  id: string
  /** Claim, completion, or retryable failure. */
  status: 'pending' | 'completed' | 'failed'
  /** Monotonic attempt count, at most three per interval. */
  attempts: number
  /** Opaque fencing token for the latest attempt. */
  token: string
  /** Epoch milliseconds until which the claim is exclusive. */
  leaseUntil: number
  /** Number of entries at completion; contains no target identifiers. */
  count: number
}

/** One bounded personal row with revision-guarded preferences and receipts. */
export type UpdateFeedDigestState = {
  /** Compare-and-swap revision; zero denotes absent persistence. */
  revision: number
  /** Current personal preferences. */
  preferences: UpdateFeedDigestPreferences
  /** Most recent twenty interval receipts, with no report content. */
  history: UpdateFeedDigestReceipt[]
}

/** Freshly authorized preview output; never sent or stored as a notification. */
export type UpdateFeedDigestPreview = {
  /** Stable calendar interval identity. */
  id: string
  /** This interval already had a successful generation. */
  replay: boolean
  /** Current unread entries, deduplicated and capped at fifty. */
  entries: UpdateFeedEntry[]
  /** A source or aggregate bound omitted eligible candidates. */
  truncated: boolean
  /** Explicitly identifies the non-delivery transport. */
  transport: 'preview'
}
