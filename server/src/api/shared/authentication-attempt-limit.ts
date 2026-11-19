import { createHash } from 'node:crypto'
import type { Context } from 'hono'
import { resolveTrustedRequestSource } from '../../infrastructure/http/trusted-request-source'
import { developerPlatformDependencies } from './app-dependencies'

/** Counter partition that keeps sign-in attempts apart from Public API credential counters. */
const AUTHENTICATION_ATTEMPT_PARTITION = 'authentication-attempts'

/** Attempts allowed in one fixed window. */
export type AuthenticationAttemptLimit = {
  /** Attempts allowed per client address and subject in one window. */
  attempts: number
  /** Window length in seconds. */
  windowSeconds: number
}

/** Outcome of counting one sign-in attempt. */
export type AuthenticationAttemptDecision =
  | {
      /** The attempt may proceed. */
      allowed: true
    }
  | {
      /** The attempt is over the limit. */
      allowed: false
      /** Seconds until the window resets. */
      retryAfterSeconds: number
    }

/**
 * Counts one sign-in attempt in the shared rate-limit store and reports whether it is allowed.
 *
 * The counter is keyed by the scope, the trusted client address (the CloudFront viewer address
 * when the request came through CloudFront), and the subject, and lives in DynamoDB with a TTL,
 * so every Lambda instance sees the same count.
 *
 * @param c - Hono request context.
 * @param scope - Kind of attempt; each scope is counted separately.
 * @param subject - Email address or user the attempt targets.
 * @param limit - Attempts allowed in one window.
 * @returns Whether the attempt is allowed and, if not, when to retry.
 */
export async function consumeAuthenticationAttempt(
  c: Context,
  scope: string,
  subject: string,
  limit: AuthenticationAttemptLimit,
): Promise<AuthenticationAttemptDecision> {
  const key = createHash('sha256')
    .update(`${scope}\0${resolveTrustedRequestSource(c)}\0${subject}`)
    .digest('hex')
  const decision = await developerPlatformDependencies.rateLimits.consumeRateLimit({
    workspaceId: AUTHENTICATION_ATTEMPT_PARTITION,
    credentialId: `${scope}:${key}`,
    limit: limit.attempts,
    windowSeconds: limit.windowSeconds,
  })
  if (decision.allowed) return { allowed: true }
  return { allowed: false, retryAfterSeconds: Math.max(1, decision.retryAfterSeconds ?? 1) }
}
