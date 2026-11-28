import {
  AGENT_USAGE_BUCKET_SECONDS,
  AgentTelemetryFormatError,
  AGENT_ACTIVITY_MAX_WAIT_ITEMS,
  agentSessionKey,
  buildAgentAnalyticsEventRows,
  createAgentUsageUnavailableError,
  deriveAgentActivityBatchId,
  deriveAgentTelemetryBatchId,
  layoutAgentActivityRows,
  layoutAgentUsageBuckets,
  parseAgentTelemetryLogs,
  type ParsedAgentTelemetry,
} from '../../modules/agent-runs'
import type { AuthenticatedDeveloperCredential } from '../../modules/developer-platform/application/ports'
import {
  PublicApiServiceError,
  type PublicAgentTelemetryService,
} from '../../modules/developer-platform/public-api'
import { workItemDependencies } from '../shared/app-dependencies'
import { resolveDeveloperCredentialPrincipal } from '../shared/developer-platform-access'
import { requireWorkspaceBusinessRead } from '../shared/project-access'

/** Times one export measures its waits again after another export moved a cursor, before it fails for a resend. */
const cursorClaimAttempts = 3

/**
 * Creates the receiver of coding agent OpenTelemetry logs. Usage is kept per credential owner,
 * agent instance, model, and 10-second bucket; it is attributed to Agent Runs when read, so
 * the receiver never looks up runs.
 *
 * @param now - Clock, replaceable in tests.
 * @returns The receiver.
 */
export function createCanonicalPublicAgentTelemetryService(now: () => Date = () => new Date()): PublicAgentTelemetryService {
  return {
    /** Adds one export's usage to the credential owner's totals. */
    async ingestLogs(credential: AuthenticatedDeveloperCredential, body: unknown) {
      const principal = await resolveDeveloperCredentialPrincipal(credential, { permission: 'workspace.read' })
      // The usage is the owner's own, so a non-guest member is enough: write grants scoped to a Team or
      // Project do not show on this Workspace-level principal. The credential still needs
      // `work-items:write`, and the read-only maintenance middleware refuses this POST.
      requireWorkspaceBusinessRead(principal)
      const receivedAt = now()
      let parsed
      try {
        parsed = parseAgentTelemetryLogs(body, receivedAt)
      } catch (error) {
        if (error instanceof AgentTelemetryFormatError) {
          throw new PublicApiServiceError(400, 'invalid_request', error.message)
        }
        throw error
      }
      const usageResult = parsed.events.length === 0
        ? undefined
        : await workItemDependencies.agentRunUsage.recordBatch(
            principal.directoryId,
            principal.userKey,
            // The ID and the chunk layout come from the export itself, not from what the receive time
            // still accepts, so a retry near the age limit finds the first attempt's receipts.
            deriveAgentTelemetryBatchId(principal.userKey, parsed.wellFormedEvents),
            layoutAgentUsageBuckets(parsed.wellFormedEvents, parsed.events),
            receivedAt,
          )
      const activityResult = await recordActivity(principal.directoryId, principal.userKey, parsed, receivedAt)
      const results = [usageResult, activityResult].filter((result) => result !== undefined)
      const duplicate = results.length > 0 && results.every((result) => result === 'duplicate')
      // A retried export whose totals were all saved before was written to the analytics store then.
      if (!duplicate) await writeAnalyticsEvents(principal.directoryId, principal.userKey, parsed, receivedAt)
      return { rejectedRecords: parsed.rejectedRecords, duplicate }
    },
  }
}

/**
 * Saves the tool time and estimated waits of one export (ADR 0117) and moves the session cursors
 * forward. Exports with only model requests still move the cursors, so the wait before the next prompt
 * is measured from the last request.
 *
 * @param directoryId - Workspace ID.
 * @param memberKey - Member that sent the export.
 * @param parsed - Parsed export.
 * @param receivedAt - Receive time.
 * @returns Whether rows were added or were already added, or undefined when the export had no rows.
 */
async function recordActivity(
  directoryId: string,
  memberKey: string,
  parsed: ParsedAgentTelemetry,
  receivedAt: Date,
): Promise<'recorded' | 'duplicate' | undefined> {
  if (parsed.activityEvents.length === 0) return undefined
  const store = workItemDependencies.agentRunUsage
  const sessionKeys = [...new Set(parsed.activityEvents.flatMap((event) => {
    const key = agentSessionKey(event)
    return key === undefined ? [] : [key]
  }))]
  const batchId = deriveAgentActivityBatchId(memberKey, parsed.wellFormedActivityEvents)
  for (let attempt = 0; attempt < cursorClaimAttempts; attempt += 1) {
    const cursors = sessionKeys.length === 0 ? new Map<string, number>() : await store.readSessionCursors(directoryId, memberKey, sessionKeys)
    const layout = layoutAgentActivityRows(parsed.wellFormedActivityEvents, parsed.activityEvents, cursors, AGENT_USAGE_BUCKET_SECONDS)
    const waitSlots = layout.slots.slice(layout.toolSlotCount)
    // Both counts come from the export alone, so a resent export makes the same choice.
    const measurable = waitSlots.length + layout.sessionCount <= AGENT_ACTIVITY_MAX_WAIT_ITEMS
    const claims = measurable
      ? layout.cursors.map((cursor) => {
          const previous = cursors.get(cursor.sessionKey)
          return previous === undefined ? cursor : { ...cursor, previousLastEventAtMs: previous }
        })
      : []
    const activity = { toolSlots: layout.slots.slice(0, layout.toolSlotCount), waitSlots: measurable ? waitSlots : [], claims }
    const empty = [...activity.toolSlots, ...activity.waitSlots].every((slot) => slot === undefined) && claims.length === 0
    const result = empty ? undefined : await store.recordActivityBatch(directoryId, memberKey, batchId, activity, receivedAt)
    // Another export of the same session moved a cursor first: measure the waits again from it.
    if (result === 'cursor-moved') continue
    if (!measurable && layout.cursors.length > 0) await store.advanceSessionCursors(directoryId, memberKey, layout.cursors, receivedAt)
    return result
  }
  throw createAgentUsageUnavailableError()
}

/**
 * Writes the export's allowlisted events to the S3 analytics store (ADR 0118). The write comes after
 * the DynamoDB totals and does not fail the export: the screens read the totals, and a client retry
 * would only add the same events again. A failure is logged.
 *
 * @param directoryId - Workspace ID.
 * @param memberKey - Member that sent the export.
 * @param parsed - Parsed export.
 * @param receivedAt - Receive time.
 */
async function writeAnalyticsEvents(
  directoryId: string,
  memberKey: string,
  parsed: ParsedAgentTelemetry,
  receivedAt: Date,
): Promise<void> {
  const sink = workItemDependencies.agentTelemetryAnalytics
  if (!sink.enabled || parsed.analyticsEvents.length === 0) return
  const memberPseudonym = sink.memberPseudonym(directoryId, memberKey)
  if (memberPseudonym === undefined) return
  try {
    await sink.putEvents(buildAgentAnalyticsEventRows({
      workspaceId: directoryId,
      memberKey: memberPseudonym,
      // The same export gives the same event IDs, so Athena can drop a retried export's copies.
      batchId: deriveAgentActivityBatchId(memberKey, parsed.wellFormedActivityEvents),
      receivedAt,
      events: parsed.analyticsEvents,
    }))
  } catch (error) {
    console.error('Agent telemetry analytics events could not be written.', error instanceof Error ? error.name : 'UnknownError')
  }
}
