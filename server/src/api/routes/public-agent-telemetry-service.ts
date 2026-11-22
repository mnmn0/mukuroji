import {
  AgentTelemetryFormatError,
  deriveAgentTelemetryBatchId,
  groupAgentUsageBuckets,
  parseAgentTelemetryLogs,
} from '../../modules/agent-runs'
import type { AuthenticatedDeveloperCredential } from '../../modules/developer-platform/application/ports'
import {
  PublicApiServiceError,
  type PublicAgentTelemetryService,
} from '../../modules/developer-platform/public-api'
import { workItemDependencies } from '../shared/app-dependencies'
import { resolveDeveloperCredentialPrincipal } from '../shared/developer-platform-access'
import { requireWorkspaceBusinessWrite } from '../shared/project-access'

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
      // Read-only maintenance refuses the write; exporters retry, then drop the export.
      requireWorkspaceBusinessWrite(principal)
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
      if (parsed.events.length === 0) return { rejectedRecords: parsed.rejectedRecords, duplicate: false }
      const result = await workItemDependencies.agentRunUsage.recordBatch(
        principal.directoryId,
        principal.userKey,
        deriveAgentTelemetryBatchId(principal.userKey, parsed.events),
        groupAgentUsageBuckets(parsed.events),
        receivedAt,
      )
      return { rejectedRecords: parsed.rejectedRecords, duplicate: result === 'duplicate' }
    },
  }
}
