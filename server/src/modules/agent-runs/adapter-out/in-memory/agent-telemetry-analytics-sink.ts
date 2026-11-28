import {
  agentAnalyticsMemberKey,
  type AgentAnalyticsEventRow,
  type AgentAnalyticsRunRow,
  type AgentAnalyticsWorkItemRow,
} from '../../domain/agent-telemetry-analytics'
import type { AgentTelemetryAnalyticsSink } from '../firehose/agent-telemetry-analytics-sink'

/** Sink that keeps rows in memory, for tests. */
export class InMemoryAgentTelemetryAnalyticsSink implements AgentTelemetryAnalyticsSink {
  /** @inheritdoc */
  readonly enabled = true
  /** Event rows written. */
  readonly events: AgentAnalyticsEventRow[] = []
  /** Run rows written. */
  readonly runs: AgentAnalyticsRunRow[] = []
  /** Work Item rows written. */
  readonly workItems: AgentAnalyticsWorkItemRow[] = []

  /** @inheritdoc */
  memberPseudonym(workspaceId: string, memberKey: string): string {
    return agentAnalyticsMemberKey('0'.repeat(64), workspaceId, memberKey)
  }

  /** @inheritdoc */
  async putEvents(rows: readonly AgentAnalyticsEventRow[]): Promise<void> {
    this.events.push(...rows)
  }

  /** @inheritdoc */
  async putRuns(rows: readonly AgentAnalyticsRunRow[]): Promise<void> {
    this.runs.push(...rows)
  }

  /** @inheritdoc */
  async putWorkItems(rows: readonly AgentAnalyticsWorkItemRow[]): Promise<void> {
    this.workItems.push(...rows)
  }
}
