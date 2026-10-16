/** Message keys used to explain a failed Collection action. */
export type CollectionErrorMessageKey =
  | 'collections.error.conflict'
  | 'collections.error.notFound'
  | 'collections.error.limit'
  | 'collections.error.denied'
  | 'collections.error.generic'

/**
 * Chooses the message for a failed Collection action.
 *
 * @param status - HTTP status of the failure, when known.
 * @param code - Stable API error code, when known.
 * @returns Message key describing what the user can do next.
 */
export function resolveCollectionErrorMessageKey(status: number | undefined, code: string | undefined): CollectionErrorMessageKey {
  if (code === 'CollectionLimitReached' || code === 'CollectionItemLimitReached') return 'collections.error.limit'
  if (status === 403) return 'collections.error.denied'
  if (status === 409) return 'collections.error.conflict'
  if (status === 404) return 'collections.error.notFound'
  return 'collections.error.generic'
}
