import { parseWorkItemKey } from '@mukuroji/contracts'

/** Most Work Item keys indexed from one message. */
export const SLACK_MESSAGE_KEY_LIMIT = 20

/** Seconds in one day. */
const DAY_SECONDS = 86_400

/** Candidate Work Item keys written in uppercase, not inside a longer word. */
const KEY_CANDIDATE_PATTERN = /(?<![A-Za-z0-9_-])[A-Z][A-Z0-9]{1,9}-[1-9][0-9]{0,8}(?![A-Za-z0-9_])/gu

/**
 * Lists the distinct Work Item keys written in a message, in first-appearance order.
 *
 * Lowercase spellings are ignored so that words such as `utf-8` are not read as keys.
 *
 * @param text - Message text.
 * @returns Up to {@link SLACK_MESSAGE_KEY_LIMIT} canonical keys.
 */
export function extractWorkItemKeys(text: string): string[] {
  const keys: string[] = []
  for (const match of text.matchAll(KEY_CANDIDATE_PATTERN)) {
    const key = parseWorkItemKey(match[0])?.key
    if (!key || keys.includes(key)) continue
    keys.push(key)
    if (keys.length >= SLACK_MESSAGE_KEY_LIMIT) break
  }
  return keys
}

/**
 * Converts a Slack timestamp to Unix seconds.
 *
 * @param ts - Slack timestamp.
 * @returns Whole seconds.
 */
export function slackTsSeconds(ts: string): number {
  return Number(ts.split('.')[0])
}

/**
 * Converts a Slack timestamp to an ISO 8601 time.
 *
 * @param ts - Slack timestamp.
 * @returns ISO 8601 time with milliseconds.
 */
export function slackTsToIso(ts: string): string {
  const [seconds = '0', fraction = '0'] = ts.split('.')
  return new Date(Number(seconds) * 1000 + Math.floor(Number(fraction.padEnd(6, '0')) / 1000)).toISOString()
}

/**
 * Builds the Slack timestamp at a Unix time, for history `oldest` bounds and cutoffs.
 *
 * @param seconds - Unix seconds.
 * @returns Slack timestamp with a zero fraction.
 */
export function slackTsAt(seconds: number): string {
  return `${Math.floor(seconds)}.000000`
}

/**
 * Calculates the TTL of a message kept for the given days.
 *
 * @param ts - Message timestamp.
 * @param retentionDays - Days messages are kept.
 * @returns Unix seconds at which DynamoDB may delete the row.
 */
export function messageExpiresAt(ts: string, retentionDays: number): number {
  return slackTsSeconds(ts) + retentionDays * DAY_SECONDS
}

/**
 * Returns the oldest message timestamp still inside the retention period.
 *
 * @param nowSeconds - Current Unix seconds.
 * @param retentionDays - Days messages are kept.
 * @returns The cutoff timestamp; older messages are out of retention.
 */
export function retentionCutoffTs(nowSeconds: number, retentionDays: number): string {
  return slackTsAt(nowSeconds - retentionDays * DAY_SECONDS)
}

/**
 * Validates the Slack team URL from `auth.test` and returns its origin.
 *
 * @param value - Team URL such as `https://example.slack.com/`.
 * @returns The `https://<name>.slack.com` origin, or `undefined` when the URL is not a Slack team URL.
 */
export function readSlackTeamOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined
  if (!/^[a-z0-9][a-z0-9-]{0,62}(\.enterprise)?\.slack\.com$/u.test(url.hostname)) return undefined
  return url.origin
}

/**
 * Builds the link that opens a message in Slack.
 *
 * @param teamOrigin - Validated team origin.
 * @param channelId - Channel ID.
 * @param ts - Message timestamp.
 * @param threadTs - Parent timestamp of a thread reply.
 * @returns The permalink.
 */
export function buildSlackPermalink(teamOrigin: string, channelId: string, ts: string, threadTs?: string): string {
  const base = `${teamOrigin}/archives/${channelId}/p${ts.replace('.', '')}`
  return threadTs ? `${base}?thread_ts=${threadTs}&cid=${channelId}` : base
}
