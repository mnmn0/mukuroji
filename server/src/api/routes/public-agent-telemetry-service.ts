import {
  AGENT_USAGE_BUCKET_SECONDS,
  AgentTelemetryFormatError,
  agentSessionKey,
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
      return {
        rejectedRecords: parsed.rejectedRecords,
        duplicate: results.length > 0 && results.every((result) => result === 'duplicate'),
      }
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
  const cursors = sessionKeys.length === 0 ? new Map<string, number>() : await store.readSessionCursors(directoryId, memberKey, sessionKeys)
  const layout = layoutAgentActivityRows(parsed.wellFormedActivityEvents, parsed.activityEvents, cursors, AGENT_USAGE_BUCKET_SECONDS)
  const result = layout.slots.some((slot) => slot !== undefined)
    ? await store.recordActivityBatch(
        directoryId,
        memberKey,
        deriveAgentActivityBatchId(memberKey, parsed.wellFormedActivityEvents),
        layout.slots,
        receivedAt,
      )
    : undefined
  if (layout.cursors.length > 0) await store.advanceSessionCursors(directoryId, memberKey, layout.cursors, receivedAt)
  return result
}
