import { createHash, createHmac } from 'node:crypto'
import {
  workItemSizeBand,
  type AgentToolKind,
  type CustomFieldDefinition,
  type CustomFieldValue,
} from '@mukuroji/contracts'
import type { StoredAgentRun } from './agent-run'
import type { AgentActivityEvent, AgentActivityEventKind } from './agent-run-activity'

/**
 * Event names kept in the analytics store (ADR 0118), without the runtime prefix. Every other
 * Claude Code event is dropped before it leaves the receiver.
 */
export type AgentAnalyticsEventName = 'api_request' | 'api_error' | 'tool_result' | 'tool_decision' | 'user_prompt'

/** One accepted telemetry event, reduced to the allowlisted values the analytics store keeps. */
export type AgentAnalyticsEvent = {
  /** Event name without the runtime prefix. */
  name: AgentAnalyticsEventName
  /** SHA-256 of the agent instance ID, or `unknown`. */
  instanceIdHash: string
  /** Event time in epoch milliseconds. */
  occurredAtMs: number
  /** Per-process event order the runtime sent. */
  sequence?: number
  /** Hash of the runtime session ID. */
  sessionHash?: string
  /** Model of an `api_request`. */
  model?: string
  /** Uncached input tokens of an `api_request`. */
  inputTokens?: number
  /** Output tokens of an `api_request`. */
  outputTokens?: number
  /** Prompt-cache read tokens of an `api_request`. */
  cacheReadTokens?: number
  /** Prompt-cache write tokens of an `api_request`. */
  cacheCreationTokens?: number
  /** Estimated cost of an `api_request` in millionths of US dollars. */
  costMicroUsd?: number
  /** Milliseconds an `api_request` or a `tool_result` took. */
  durationMs?: number
  /** Tool kind of a `tool_result`. */
  toolKind?: AgentToolKind
  /** Tool name of a `tool_result`, such as `Bash` or `github/get_issue`. */
  toolName?: string
  /** Whether a `tool_result` succeeded. */
  success?: boolean
  /** Whether a person made a `tool_decision`. */
  decidedByPerson?: boolean
}

/** Analytics event names by activity kind. */
const analyticsEventNames: Readonly<Record<AgentActivityEventKind, AgentAnalyticsEventName>> = {
  request: 'api_request',
  error: 'api_error',
  tool: 'tool_result',
  decision: 'tool_decision',
  prompt: 'user_prompt',
}

/**
 * Reduces an accepted activity event to its analytics values.
 *
 * @param event - Activity event.
 * @returns The analytics event.
 */
export function agentAnalyticsEventFromActivity(event: AgentActivityEvent): AgentAnalyticsEvent {
  return compact({
    name: analyticsEventNames[event.kind],
    instanceIdHash: event.instanceIdHash,
    occurredAtMs: event.occurredAtMs,
    sequence: event.sequence,
    sessionHash: event.sessionHash,
    durationMs: event.durationMs,
    toolKind: event.tool?.kind,
    toolName: event.tool?.name,
    success: event.kind === 'tool' ? event.failed !== true : undefined,
    decidedByPerson: event.byPerson,
  })
}

/** One row of the `agent_events` table. Column names match the Glue table (ADR 0118). */
export type AgentAnalyticsEventRow = {
  /** Partition key: SHA-256 of the Workspace ID. */
  workspace_key: string
  /** Stable ID of the event within its export; the same on a retried export. */
  event_id: string
  /** Stable ID of the export. */
  batch_id: string
  /** Receive time in epoch milliseconds. */
  received_at_ms: number
  /** Event time in epoch milliseconds. */
  occurred_at_ms: number
  /** Event name. */
  event_name: AgentAnalyticsEventName
  /** Pseudonym of the member that sent the export. */
  member_key: string
  /** SHA-256 of the agent instance ID. */
  instance_hash: string
  /** Hash of the runtime session ID. */
  session_hash?: string
  /** Per-process event order. */
  sequence?: number
  /** Model of a request. */
  model?: string
  /** Uncached input tokens. */
  input_tokens?: number
  /** Output tokens. */
  output_tokens?: number
  /** Prompt-cache read tokens. */
  cache_read_tokens?: number
  /** Prompt-cache write tokens. */
  cache_creation_tokens?: number
  /** Estimated cost in millionths of US dollars. */
  cost_micro_usd?: number
  /** Milliseconds the request or tool call took. */
  duration_ms?: number
  /** Tool kind. */
  tool_kind?: AgentToolKind
  /** Tool name. */
  tool_name?: string
  /** Whether the tool call succeeded. */
  success?: boolean
  /** Whether a person made the permission decision. */
  decided_by_person?: boolean
}

/** One row of the `agent_runs` table: the start snapshot, or the run's state on a daily export. */
export type AgentAnalyticsRunRow = {
  /** Partition key: SHA-256 of the Workspace ID. */
  workspace_key: string
  /** Run ID. */
  run_id: string
  /** `started` for the snapshot taken when the run started; `daily` for the daily export of its state. */
  record_kind: 'started' | 'daily'
  /** When the row was written, in epoch milliseconds. */
  recorded_at_ms: number
  /** Team ID. */
  team_id: string
  /** Work Item ID. */
  work_item_id: string
  /** SHA-256 of the agent instance ID; events of the run carry the same hash. */
  instance_hash: string
  /** Agent runtime. */
  runtime: string
  /** Run start in epoch milliseconds. */
  started_at_ms: number
  /** Pseudonym of the member running the agent; only on the start snapshot. */
  member_key?: string
  /** Project of the Work Item when the run started. */
  project_id?: string
  /** Work Item type when the run started. */
  work_item_type_id?: string
  /** Effort estimate in minutes when the run started. */
  planned_effort_minutes?: number
  /** Size band of the estimate when the run started. */
  size_band?: string
  /** Priority when the run started. */
  priority?: string
  /** Comparison custom field values when the run started, as JSON text keyed by field ID. */
  compare_fields_json?: string
  /** Earlier run the run resumed. */
  resumed_from_run_id?: string
  /** Run state on a daily export. */
  state?: string
  /** Outcome of a finished run. */
  outcome?: string
  /** Finish time in epoch milliseconds. */
  finished_at_ms?: number
}

/** One row of the `agent_work_items` table: a Work Item's current values on a daily export. */
export type AgentAnalyticsWorkItemRow = {
  /** Partition key: SHA-256 of the Workspace ID. */
  workspace_key: string
  /** Team ID. */
  team_id: string
  /** Work Item ID. */
  work_item_id: string
  /** Export time in epoch milliseconds. */
  exported_at_ms: number
  /** Status category, such as `completed`. */
  status_category: string
  /** Project the Work Item is assigned to. */
  project_id?: string
  /** Work Item type. */
  work_item_type_id?: string
  /** Effort estimate in minutes. */
  planned_effort_minutes?: number
  /** Size band of the estimate. */
  size_band: string
  /** Recorded remaining effort in minutes. */
  remaining_effort_minutes?: number
  /** Priority. */
  priority?: string
  /** Local date the work first started. */
  actual_start_date?: string
  /** Local date of the latest completion, while completed. */
  actual_end_date?: string
  /** Whether the Work Item is archived. */
  archived: boolean
}

/** Work Item values the start snapshot and the daily export read. */
export type AgentAnalyticsWorkItem = {
  /** Status category. */
  statusCategory: string
  /** Assigned Project. */
  assignedProjectId?: string
  /** Work Item type. */
  workItemTypeId?: string
  /** Schedule holding the estimate. */
  schedule?: {
    /** Effort estimate in minutes. */
    plannedEffortMinutes?: number
  }
  /** Remaining effort in minutes. */
  remainingEffortMinutes?: number
  /** Priority. */
  priority?: string
  /** First start date. */
  actualStartDate?: string
  /** Latest completion date. */
  actualEndDate?: string
  /** Archive time. */
  archivedAt?: string
  /** Custom field values by field ID. */
  customFieldValues?: Record<string, CustomFieldValue>
}

/** Custom field types the start snapshot keeps: values that name a level, never free text or people. */
const comparisonFieldTypes: ReadonlySet<CustomFieldDefinition['type']> = new Set(['select', 'multi-select', 'number', 'boolean'])

/** Largest record Firehose accepts is 1,000 KiB; records stay well below it. */
const maximumRecordBytes = 900 * 1024

/** Most rows Firehose splits out of one record; JSON deaggregation stops at 500. */
export const AGENT_ANALYTICS_MAX_ROWS_PER_RECORD = 500

/** Largest number of records one `PutRecordBatch` call accepts. */
export const AGENT_ANALYTICS_MAX_RECORDS_PER_BATCH = 500

/** Largest total size one `PutRecordBatch` call accepts is 4 MiB; batches stay below it. */
export const AGENT_ANALYTICS_MAX_BATCH_BYTES = 3.5 * 1024 * 1024

/**
 * Builds the key that partitions a Workspace's analytics objects. It is a hash, so object keys
 * do not show the Workspace ID, which can contain an email address for a personal Workspace.
 *
 * @param workspaceId - Workspace ID.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
export function agentAnalyticsWorkspaceKey(workspaceId: string): string {
  return createHash('sha256').update(workspaceId).digest('hex')
}

/**
 * Builds the pseudonym of a member in the analytics store. It is keyed with the Workspace audit
 * pseudonym key, so a member key such as an email address cannot be found by hashing guesses.
 *
 * @param pseudonymKey - Workspace audit pseudonym key (64 hexadecimal characters).
 * @param workspaceId - Workspace ID.
 * @param memberKey - Member key.
 * @returns The first 32 hexadecimal characters of the HMAC-SHA256 digest.
 */
export function agentAnalyticsMemberKey(pseudonymKey: string, workspaceId: string, memberKey: string): string {
  return createHmac('sha256', Buffer.from(pseudonymKey, 'hex'))
    .update(`agent-analytics-member\u0000${workspaceId}\u0000${memberKey}`)
    .digest('hex')
    .slice(0, 32)
}

/**
 * Derives a stable ID for the analytics events of one export from every stored field, so a retried
 * export gets the same event IDs while exports that differ in any value, such as the model or a
 * token count, never share one.
 *
 * @param memberKey - Member that sent the export.
 * @param events - Accepted events in export order.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
export function deriveAgentAnalyticsBatchId(memberKey: string, events: readonly AgentAnalyticsEvent[]): string {
  const hash = createHash('sha256').update(`agent-analytics-batch\u0000${memberKey}`)
  for (const event of events) {
    hash.update([
      '',
      event.name,
      event.instanceIdHash,
      String(event.occurredAtMs),
      String(event.sequence ?? ''),
      event.sessionHash ?? '',
      event.model ?? '',
      String(event.inputTokens ?? ''),
      String(event.outputTokens ?? ''),
      String(event.cacheReadTokens ?? ''),
      String(event.cacheCreationTokens ?? ''),
      String(event.costMicroUsd ?? ''),
      String(event.durationMs ?? ''),
      event.toolKind ?? '',
      event.toolName ?? '',
      event.success === undefined ? '' : event.success ? '1' : '0',
      event.decidedByPerson === undefined ? '' : event.decidedByPerson ? '1' : '0',
    ].join('\u0000'))
  }
  return hash.digest('hex')
}

/**
 * Builds the rows of one export's events.
 *
 * @param input - Export values.
 * @param input.workspaceId - Workspace ID.
 * @param input.memberKey - Pseudonym of the member that sent the export.
 * @param input.batchId - Stable ID of the export.
 * @param input.receivedAt - Receive time.
 * @param input.events - Accepted events in export order.
 * @returns One row per event.
 */
export function buildAgentAnalyticsEventRows(input: {
  workspaceId: string
  memberKey: string
  batchId: string
  receivedAt: Date
  events: readonly AgentAnalyticsEvent[]
}): AgentAnalyticsEventRow[] {
  const workspaceKey = agentAnalyticsWorkspaceKey(input.workspaceId)
  const receivedAtMs = input.receivedAt.getTime()
  return input.events.map((event, index) => compact({
    workspace_key: workspaceKey,
    event_id: `${input.batchId.slice(0, 32)}-${index}`,
    batch_id: input.batchId,
    received_at_ms: receivedAtMs,
    occurred_at_ms: event.occurredAtMs,
    event_name: event.name,
    member_key: input.memberKey,
    instance_hash: event.instanceIdHash,
    session_hash: event.sessionHash,
    sequence: event.sequence,
    model: event.model,
    input_tokens: event.inputTokens,
    output_tokens: event.outputTokens,
    cache_read_tokens: event.cacheReadTokens,
    cache_creation_tokens: event.cacheCreationTokens,
    cost_micro_usd: event.costMicroUsd,
    duration_ms: event.durationMs,
    tool_kind: event.toolKind,
    tool_name: event.toolName,
    success: event.success,
    decided_by_person: event.decidedByPerson,
  }))
}

/**
 * Reads the comparison custom field values of a Work Item: select, multi-select, number, and
 * boolean fields only, so free text and people never reach the analytics store.
 *
 * @param values - Work Item custom field values.
 * @param definitions - Custom field definitions of the Work Item's configuration.
 * @returns JSON text keyed by field ID, or undefined when no such value is set.
 */
export function readAgentAnalyticsCompareFields(
  values: Readonly<Record<string, CustomFieldValue>> | undefined,
  definitions: readonly Pick<CustomFieldDefinition, 'id' | 'type'>[],
): string | undefined {
  if (values === undefined) return undefined
  const kept: Record<string, CustomFieldValue> = {}
  for (const definition of definitions) {
    if (!comparisonFieldTypes.has(definition.type)) continue
    const value = values[definition.id]
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) continue
    kept[definition.id] = Array.isArray(value) ? [...value].sort() : value
  }
  return Object.keys(kept).length === 0 ? undefined : JSON.stringify(kept)
}

/**
 * Builds the start snapshot of a run: the comparison axes as they were when the run started.
 *
 * @param run - Run that started.
 * @param workItem - Work Item as the start read it.
 * @param customFields - Custom field definitions of the Work Item's configuration.
 * @param memberKey - Pseudonym of the member running the agent.
 * @param now - Start time.
 * @returns The snapshot row.
 */
export function buildAgentAnalyticsRunStartRow(
  run: StoredAgentRun,
  workItem: AgentAnalyticsWorkItem,
  customFields: readonly Pick<CustomFieldDefinition, 'id' | 'type'>[],
  memberKey: string,
  now: Date,
): AgentAnalyticsRunRow {
  const plannedEffortMinutes = workItem.schedule?.plannedEffortMinutes
  return compact({
    ...runIdentity(run, 'started', now),
    member_key: memberKey,
    project_id: workItem.assignedProjectId,
    work_item_type_id: workItem.workItemTypeId,
    planned_effort_minutes: plannedEffortMinutes,
    size_band: workItemSizeBand(plannedEffortMinutes),
    priority: workItem.priority,
    compare_fields_json: readAgentAnalyticsCompareFields(workItem.customFieldValues, customFields),
    resumed_from_run_id: run.resumedFromRunId,
  })
}

/**
 * Builds the daily row of a run's state.
 *
 * @param run - Run as read now.
 * @param now - Export time.
 * @returns The state row.
 */
export function buildAgentAnalyticsRunStateRow(run: StoredAgentRun, now: Date): AgentAnalyticsRunRow {
  const finishedAtMs = run.finishedAt === undefined ? undefined : Date.parse(run.finishedAt)
  return compact({
    ...runIdentity(run, 'daily', now),
    state: run.state,
    outcome: run.outcome,
    finished_at_ms: finishedAtMs !== undefined && Number.isFinite(finishedAtMs) ? finishedAtMs : undefined,
  })
}

/**
 * Builds the daily row of a Work Item's current values.
 *
 * @param workspaceId - Workspace ID.
 * @param teamId - Team ID.
 * @param workItemId - Work Item ID.
 * @param workItem - Work Item as read now.
 * @param now - Export time.
 * @returns The Work Item row.
 */
export function buildAgentAnalyticsWorkItemRow(
  workspaceId: string,
  teamId: string,
  workItemId: string,
  workItem: AgentAnalyticsWorkItem,
  now: Date,
): AgentAnalyticsWorkItemRow {
  const plannedEffortMinutes = workItem.schedule?.plannedEffortMinutes
  return compact({
    workspace_key: agentAnalyticsWorkspaceKey(workspaceId),
    team_id: teamId,
    work_item_id: workItemId,
    exported_at_ms: now.getTime(),
    status_category: workItem.statusCategory,
    project_id: workItem.assignedProjectId,
    work_item_type_id: workItem.workItemTypeId,
    planned_effort_minutes: plannedEffortMinutes,
    size_band: workItemSizeBand(plannedEffortMinutes),
    remaining_effort_minutes: workItem.remainingEffortMinutes,
    priority: workItem.priority,
    actual_start_date: workItem.actualStartDate,
    actual_end_date: workItem.actualEndDate,
    archived: workItem.archivedAt !== undefined,
  })
}

/**
 * Packs rows into Firehose records of newline-separated JSON. Firehose splits each record back into
 * rows before it partitions and converts them (multi-record deaggregation), and bills ingestion in
 * 5 KB steps per record, so packing keeps the billed size close to the real one.
 *
 * @param rows - Rows to send.
 * @returns Records, each below the Firehose record limit and holding at most
 *   {@link AGENT_ANALYTICS_MAX_ROWS_PER_RECORD} rows.
 */
export function packAgentAnalyticsRecords(rows: readonly object[]): Uint8Array[] {
  const records: Uint8Array[] = []
  let lines: string[] = []
  let size = 0
  for (const row of rows) {
    const line = `${JSON.stringify(row)}\n`
    const lineSize = Buffer.byteLength(line)
    if (lineSize > maximumRecordBytes) continue
    if ((size + lineSize > maximumRecordBytes || lines.length === AGENT_ANALYTICS_MAX_ROWS_PER_RECORD) && lines.length > 0) {
      records.push(Buffer.from(lines.join('')))
      lines = []
      size = 0
    }
    lines.push(line)
    size += lineSize
  }
  if (lines.length > 0) records.push(Buffer.from(lines.join('')))
  return records
}

/**
 * Groups records into `PutRecordBatch` calls within the count and size limits.
 *
 * @param records - Records to send.
 * @returns Batches in order.
 */
export function batchAgentAnalyticsRecords(records: readonly Uint8Array[]): Uint8Array[][] {
  const batches: Uint8Array[][] = []
  let batch: Uint8Array[] = []
  let size = 0
  for (const record of records) {
    if (batch.length > 0 && (batch.length === AGENT_ANALYTICS_MAX_RECORDS_PER_BATCH || size + record.byteLength > AGENT_ANALYTICS_MAX_BATCH_BYTES)) {
      batches.push(batch)
      batch = []
      size = 0
    }
    batch.push(record)
    size += record.byteLength
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

/**
 * Builds the identity columns of a run row.
 *
 * @param run - Run.
 * @param recordKind - Row kind.
 * @param now - Write time.
 * @returns Identity columns.
 */
function runIdentity(run: StoredAgentRun, recordKind: AgentAnalyticsRunRow['record_kind'], now: Date) {
  return {
    workspace_key: agentAnalyticsWorkspaceKey(run.directoryId),
    run_id: run.runId,
    record_kind: recordKind,
    recorded_at_ms: now.getTime(),
    team_id: run.teamId,
    work_item_id: run.workItemId,
    instance_hash: run.instanceIdHash,
    runtime: run.runtime,
    started_at_ms: Date.parse(run.startedAt),
  }
}

/**
 * Drops the properties whose value is undefined, so a row carries only the columns it has.
 *
 * @param row - Row with optional columns.
 * @returns The same row without undefined columns.
 */
function compact<T extends object>(row: T): T {
  for (const key of Object.keys(row)) {
    if (Reflect.get(row, key) === undefined) Reflect.deleteProperty(row, key)
  }
  return row
}
