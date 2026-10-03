import { runInboxDigestSchedule, type InboxDigestSchedule } from '../../application/inbox-digest'

/** Creates an explicitly configured, bounded scheduler entry point.
 * No production handler, environment flag or EventBridge target invokes this yet.
 * The caller must durably retain returned failed recipients and continuation
 * before acknowledging a scheduled event; neither is safe to discard.
 * Terminal candidates must be retained for operator inspection, without retrying them.
 * @param schedule - Explicit opt-in configuration with authorized application ports.
 * @param now - Trusted clock; event payloads cannot select historical intervals.
 * @returns A processor accepting only an opaque continuation checkpoint.
 */
export function createInboxDigestScheduleHandler(schedule: InboxDigestSchedule, now: () => number = Date.now) {
  return (cursor?: string) => runInboxDigestSchedule(schedule, now(), cursor)
}
