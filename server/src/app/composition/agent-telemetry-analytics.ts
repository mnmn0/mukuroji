import { createFirehoseClient } from '../../infrastructure/aws/firehose-client'
import {
  FirehoseAgentTelemetryAnalyticsSink,
  disabledAgentTelemetryAnalyticsSink,
  type AgentTelemetryAnalyticsSink,
} from '../../modules/agent-runs'

/** Lowercase 64-character hexadecimal key, as the Workspace audit pseudonym key is stored. */
const pseudonymKeyPattern = /^[0-9a-f]{64}$/u

/**
 * Creates the analytics sink of a runtime (ADR 0118). Without all three stream names the sink is
 * disabled and drops every row, so a deployment without the analytics store, local development, and
 * tests write nothing. Without the Workspace audit pseudonym key, as in the scheduled-jobs Lambda,
 * rows that name a member are not written.
 *
 * @param environment - Runtime environment.
 * @returns The sink.
 */
export function createAgentTelemetryAnalyticsSink(
  environment: Readonly<Record<string, string | undefined>>,
): AgentTelemetryAnalyticsSink {
  const events = environment.AGENT_ANALYTICS_EVENTS_STREAM_NAME?.trim()
  const runs = environment.AGENT_ANALYTICS_RUNS_STREAM_NAME?.trim()
  const workItems = environment.AGENT_ANALYTICS_WORK_ITEMS_STREAM_NAME?.trim()
  const pseudonymKey = environment.MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY?.trim()
  if (!events || !runs || !workItems) return disabledAgentTelemetryAnalyticsSink
  const key = pseudonymKey !== undefined && pseudonymKeyPattern.test(pseudonymKey) ? pseudonymKey : undefined
  return new FirehoseAgentTelemetryAnalyticsSink(createFirehoseClient(), { events, runs, workItems }, key)
}
