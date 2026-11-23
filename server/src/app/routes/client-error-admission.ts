import { createHash } from 'node:crypto'
import type { Context } from 'hono'
import type { AppDependencies } from '../composition/app-dependencies'
import type { ClientErrorReportAdmission } from './client-error-router'

/** Counter partition that keeps browser error reports apart from other rate-limit counters. */
const CLIENT_ERROR_REPORT_PARTITION = 'client-error-reports'

/** Reports one client address may send in {@link PER_CLIENT_WINDOW_SECONDS}. */
export const CLIENT_ERROR_REPORTS_PER_CLIENT = 10

/** Window of the per-client limit, in seconds. */
const PER_CLIENT_WINDOW_SECONDS = 600

/** Reports all clients together may send in {@link OVERALL_WINDOW_SECONDS}, which caps log volume. */
export const CLIENT_ERROR_REPORTS_OVERALL = 600

/** Window of the overall limit, in seconds. */
const OVERALL_WINDOW_SECONDS = 3600

/**
 * Creates the rate-limit check for browser error reports.
 *
 * Each report counts first against its trusted client address (the CloudFront viewer address
 * when the request came through CloudFront), then against one overall counter. Both live in the
 * shared DynamoDB rate-limit store with a TTL, so every Lambda instance sees the same counts. The
 * client address is stored only as a SHA-256 digest inside the counter key.
 *
 * @param rateLimits - Shared fixed-window rate-limit store.
 * @param resolveSource - Returns the trusted client address of a request.
 * @returns The admission check for the report route.
 */
export function createClientErrorReportAdmission(
  rateLimits: AppDependencies['developerPlatform']['rateLimits'],
  resolveSource: (context: Context) => string,
): (context: Context) => Promise<ClientErrorReportAdmission> {
  return async (context) => {
    const sourceKey = createHash('sha256').update(`client-error\0${resolveSource(context)}`).digest('hex')
    const perClient = await rateLimits.consumeRateLimit({
      workspaceId: CLIENT_ERROR_REPORT_PARTITION,
      credentialId: `client:${sourceKey}`,
      limit: CLIENT_ERROR_REPORTS_PER_CLIENT,
      windowSeconds: PER_CLIENT_WINDOW_SECONDS,
    })
    if (!perClient.allowed) return { allowed: false, retryAfterSeconds: perClient.retryAfterSeconds ?? 1 }
    const overall = await rateLimits.consumeRateLimit({
      workspaceId: CLIENT_ERROR_REPORT_PARTITION,
      credentialId: 'overall',
      limit: CLIENT_ERROR_REPORTS_OVERALL,
      windowSeconds: OVERALL_WINDOW_SECONDS,
    })
    if (!overall.allowed) return { allowed: false, retryAfterSeconds: overall.retryAfterSeconds ?? 1 }
    return { allowed: true }
  }
}
