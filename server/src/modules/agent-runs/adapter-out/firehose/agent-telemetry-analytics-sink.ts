import { PutRecordBatchCommand } from '@aws-sdk/client-firehose'
import {
  agentAnalyticsMemberKey,
  batchAgentAnalyticsRecords,
  packAgentAnalyticsRecords,
  type AgentAnalyticsEventRow,
  type AgentAnalyticsRunRow,
  type AgentAnalyticsWorkItemRow,
} from '../../domain/agent-telemetry-analytics'

/** Writes analytics rows to the S3 analytics store (ADR 0118). */
export interface AgentTelemetryAnalyticsSink {
  /** Whether the deployment has the analytics store; a disabled sink drops every row. */
  readonly enabled: boolean
  /**
   * Builds the pseudonym of a member.
   * @param workspaceId - Workspace ID.
   * @param memberKey - Member key.
   * @returns Pseudonym that the analytics rows carry instead of the member key, or undefined when
   *   the runtime has no pseudonym key, in which case rows that name a member are not written.
   */
  memberPseudonym(workspaceId: string, memberKey: string): string | undefined
  /**
   * Writes telemetry event rows.
   * @param rows - Event rows.
   */
  putEvents(rows: readonly AgentAnalyticsEventRow[]): Promise<void>
  /**
   * Writes run rows.
   * @param rows - Run rows.
   */
  putRuns(rows: readonly AgentAnalyticsRunRow[]): Promise<void>
  /**
   * Writes Work Item rows.
   * @param rows - Work Item rows.
   */
  putWorkItems(rows: readonly AgentAnalyticsWorkItemRow[]): Promise<void>
}

/** Firehose delivery stream of each analytics table. */
export type AgentTelemetryAnalyticsStreams = {
  /** Stream of the `agent_events` table. */
  events: string
  /** Stream of the `agent_runs` table. */
  runs: string
  /** Stream of the `agent_work_items` table. */
  workItems: string
}

/** Firehose client operations the sink uses. */
export type AgentTelemetryAnalyticsFirehoseClient = {
  /** Sends one batch. */
  send(command: PutRecordBatchCommand): Promise<{
    /** Records Firehose did not accept. */
    FailedPutCount?: number
    /** Per-record results in request order. */
    RequestResponses?: { ErrorCode?: string }[]
  }>
}

/** Times a batch's refused records are sent again before the write fails. */
const resendAttempts = 2

/** Error raised when Firehose kept refusing records. */
export class AgentTelemetryAnalyticsWriteError extends Error {
  /**
   * Creates the error.
   * @param refused - Records still refused.
   */
  constructor(refused: number) {
    super(`Firehose refused ${refused} analytics records.`)
    this.name = 'AgentTelemetryAnalyticsWriteError'
  }
}

/** Sink that writes rows to Amazon Data Firehose, one stream per table. */
export class FirehoseAgentTelemetryAnalyticsSink implements AgentTelemetryAnalyticsSink {
  /** @inheritdoc */
  readonly enabled = true
  /** Firehose client. */
  readonly #client: AgentTelemetryAnalyticsFirehoseClient
  /** Stream names. */
  readonly #streams: AgentTelemetryAnalyticsStreams
  /** Workspace audit pseudonym key, when the runtime has it. */
  readonly #pseudonymKey: string | undefined

  /**
   * Creates the sink.
   * @param client - Firehose client.
   * @param streams - Stream names.
   * @param pseudonymKey - Workspace audit pseudonym key (64 hexadecimal characters), when the runtime has it.
   */
  constructor(client: AgentTelemetryAnalyticsFirehoseClient, streams: AgentTelemetryAnalyticsStreams, pseudonymKey: string | undefined) {
    this.#client = client
    this.#streams = streams
    this.#pseudonymKey = pseudonymKey
  }

  /** @inheritdoc */
  memberPseudonym(workspaceId: string, memberKey: string): string | undefined {
    return this.#pseudonymKey === undefined ? undefined : agentAnalyticsMemberKey(this.#pseudonymKey, workspaceId, memberKey)
  }

  /** @inheritdoc */
  async putEvents(rows: readonly AgentAnalyticsEventRow[]): Promise<void> {
    await this.#put(this.#streams.events, rows)
  }

  /** @inheritdoc */
  async putRuns(rows: readonly AgentAnalyticsRunRow[]): Promise<void> {
    await this.#put(this.#streams.runs, rows)
  }

  /** @inheritdoc */
  async putWorkItems(rows: readonly AgentAnalyticsWorkItemRow[]): Promise<void> {
    await this.#put(this.#streams.workItems, rows)
  }

  /**
   * Packs rows into records and sends them, sending refused records again.
   * @param stream - Delivery stream name.
   * @param rows - Rows to send.
   */
  async #put(stream: string, rows: readonly object[]): Promise<void> {
    for (const batch of batchAgentAnalyticsRecords(packAgentAnalyticsRecords(rows))) {
      let pending = batch
      for (let attempt = 0; pending.length > 0; attempt += 1) {
        const result = await this.#client.send(new PutRecordBatchCommand({
          DeliveryStreamName: stream,
          Records: pending.map((Data) => ({ Data })),
        }))
        if ((result.FailedPutCount ?? 0) === 0) break
        const responses = result.RequestResponses ?? []
        const refused = pending.filter((_, index) => responses[index]?.ErrorCode !== undefined)
        // Without per-record results every record is sent again; Athena removes duplicates by ID.
        pending = refused.length === 0 ? pending : refused
        if (attempt === resendAttempts) throw new AgentTelemetryAnalyticsWriteError(pending.length)
      }
    }
  }
}

/** Sink of a deployment without the analytics store. */
export const disabledAgentTelemetryAnalyticsSink: AgentTelemetryAnalyticsSink = Object.freeze({
  enabled: false,
  /** Returns no pseudonym; no row is written. */
  memberPseudonym: () => undefined,
  /** Drops the rows. */
  async putEvents() {},
  /** Drops the rows. */
  async putRuns() {},
  /** Drops the rows. */
  async putWorkItems() {},
})
