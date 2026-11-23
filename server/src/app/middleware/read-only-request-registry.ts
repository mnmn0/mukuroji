import { TrieRouter } from 'hono/router/trie-router'

/**
 * Requests that a read-only maintenance window admits.
 *
 * Every `GET` and `HEAD` route only reads. A `POST` route is admitted only when it is listed in
 * {@link READ_ONLY_POST_ROUTES}; any other method or unlisted route counts as a change and is
 * rejected, so a new mutation route stays blocked without being registered here.
 */

/**
 * `POST` routes that change no domain data and stay available during read-only maintenance.
 *
 * The update-feed digest preview and the provisioning preview are not listed: the first records
 * delivery receipts and the second stores the preview that a later reconcile applies.
 *
 * Sign-in and token refresh keep sessions alive so users do not lose what they are editing.
 * They may still record incidental bookkeeping, such as sign-in rate-limit counters, audit events,
 * and the idempotent membership reconciliation run at sign-in. A migration that cannot tolerate
 * any write uses the `disabled` mode instead.
 *
 * Routes use Hono path patterns; a `:name` segment matches one non-empty path segment.
 */
export const READ_ONLY_POST_ROUTES: readonly string[] = Object.freeze([
  '/api/auth/login',
  '/api/auth/challenge/mfa',
  '/api/auth/refresh',
  '/api/auth/logout',
  '/api/auth/sso/start',
  '/api/auth/sso/exchange',
  '/api/analytics/query',
  '/api/analytics/evidence',
  '/api/analytics/export',
  '/api/bulk-operations/preview',
  '/api/document-backlinks/batch',
  '/api/enterprise/security/policy/preview',
  '/api/teams/:teamId/issues/:issueId/schedule/preview',
  '/api/teams/:teamId/issues/:issueId/work-item-type-preview',
  '/api/teams/:teamId/projects/:projectId/status-report/pdf',
])

/** Methods that never change data. */
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD'])

/** Router holding the read-only `POST` routes, with the same path rules as the app's routes. */
const READ_ONLY_POST_ROUTER = new TrieRouter<true>()
for (const route of READ_ONLY_POST_ROUTES) READ_ONLY_POST_ROUTER.add('POST', route, true)

/**
 * Tells whether a request only reads and may run during read-only maintenance.
 *
 * @param method - Upper-case HTTP method of the request.
 * @param path - Request path without the query string, as Hono routes it.
 * @returns Whether the request is a read.
 */
export function isReadOnlyRequest(method: string, path: string): boolean {
  if (READ_METHODS.has(method)) return true
  if (method !== 'POST') return false
  return READ_ONLY_POST_ROUTER.match('POST', path)[0].length > 0
}
