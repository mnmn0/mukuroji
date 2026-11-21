import { describe, expect, test } from 'bun:test'
import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  createDefaultDueDateWorkItemSchedule,
  type AnalyticsQueryInput,
  type CanonicalWorkItem,
} from '@mukuroji/contracts'
import { BatchGetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  ANALYTICS_METRIC_DEFINITIONS,
  AnalyticsError,
  DynamoDbAnalyticsRepository,
  createAnalyticsSnapshot,
  queryAnalyticsEvidence,
  selectAnalyticsWorkItemsRequiringHistory,
} from './analytics'
import {
  readAnalyticsWorkItemHistoryEvents,
  type AnalyticsWorkItemHistoryReader,
} from './analytics-history-reader'
import {
  ANALYTICS_WORK_ITEM_HISTORY_MAX_BYTES,
  createAnalyticsWorkItemHistoryRecordKey,
  createEmptyAnalyticsWorkItemHistoryRow,
  mergeAnalyticsWorkItemHistoryEntries,
  parseStoredAnalyticsWorkItemHistoryRow,
  readAnalyticsWorkItemHistoryEvent,
  toAnalyticsHistoryEvents,
  toStoredAnalyticsWorkItemHistoryRow,
  type AnalyticsHistoryEvent,
  type AnalyticsWorkItemHistoryKey,
  type AnalyticsWorkItemHistoryRow,
  type AnalyticsWorkItemHistoryRowRead,
  type AnalyticsWorkItemHistoryStore,
} from './analytics-work-item-history'
import { DynamoDbAnalyticsWorkItemHistoryStore } from './adapter-out/dynamodb/analytics-work-item-history-store'
import {
  processAnalyticsWorkItemHistoryProjectionBatch,
  type AnalyticsWorkItemTimeline,
} from './adapter-in/events/analytics-work-item-history-projection'
import { AUDIT_SCHEMA_VERSION, type AuditEventV1, type AuditFieldChange } from '../audit/audit'
import type {
  DynamoAttributeValue,
  DynamoStreamRecord,
} from '../../infrastructure/aws/dynamodb-stream'

const workspaceId = 'workspace-1'
const authorizedProjectIds = new Set(['project-1', 'project-2', 'project-a'])

/**
 * Builds a canonical Work Item for tests.
 *
 * @param id - Work Item ID.
 * @param overrides - Fields to override.
 * @returns The Work Item.
 */
function createWorkItem(id: string, overrides: Partial<CanonicalWorkItem> = {}): CanonicalWorkItem {
  const dueDate = overrides.dueDate ?? '2026-01-10'
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    id,
    teamId: 'core',
    title: `Work ${id}`,
    assigneeUserId: 'user-1',
    creatorMemberKey: 'member-1',
    priority: 'medium',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    workflowStatusId: 'status-backlog',
    statusCategory: 'backlog',
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    customFieldValues: {},
    relationIds: [],
    source: 'dynamodb',
    ...overrides,
    dueDate,
    schedule: overrides.schedule ?? createDefaultDueDateWorkItemSchedule(dueDate),
  }
}

/** Options of {@link createAuditEvent}. */
type AuditEventOptions = {
  /** Event type; defaults to `work-item.updated`. */
  eventType?: string
  /** Action; defaults to `updated`. */
  action?: string
  /** Canonical revision after the mutation; omitted for attached records. */
  afterRevision?: number
  /** Target entity ID; defaults to the Work Item itself. */
  targetId?: string
  /** Audit retention expiry. */
  expiresAt?: number
}

/**
 * Builds an audit event on a Work Item's entity timeline.
 *
 * @param eventId - Event ID.
 * @param workItem - Work Item the timeline belongs to.
 * @param occurredAt - Occurrence time.
 * @param changes - Field changes.
 * @param options - Event type, revision, and target overrides.
 * @returns The audit event.
 */
function createAuditEvent(
  eventId: string,
  workItem: Pick<CanonicalWorkItem, 'teamId' | 'id'>,
  occurredAt: string,
  changes: AuditFieldChange[],
  options: AuditEventOptions = {},
): AuditEventV1 {
  const entityId = `team/${workItem.teamId}/issue/${workItem.id}`
  const targetId = options.targetId ?? entityId
  const targetType = options.targetId ? 'comment' : 'work-item'
  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    eventId,
    directoryId: workspaceId,
    workspaceId,
    workspaceKey: workspaceId,
    eventType: options.eventType ?? 'work-item.updated',
    occurredAt,
    occurredAtEventId: `${occurredAt}#${eventId}`,
    workspaceEventKey: `${occurredAt}#${eventId}`,
    actor: { id: 'user-1', kind: 'user' },
    actorUserId: 'user-1',
    actorKey: `${workspaceId}#user-1`,
    actorEventKey: `${occurredAt}#${eventId}`,
    entity: { type: 'work-item', id: entityId },
    entityType: 'work-item',
    entityId,
    entityKey: `${workspaceId}#work-item#${entityId}`,
    entityEventKey: `${occurredAt}#${eventId}`,
    target: { type: targetType, id: targetId },
    targetType,
    targetId,
    targetKey: `${workspaceId}#${targetType}#${targetId}`,
    targetEventKey: `${occurredAt}#${eventId}`,
    changes,
    action: options.action ?? 'updated',
    correlationId: eventId,
    idempotencyKeyHash: eventId,
    requestFingerprint: eventId,
    source: 'api',
    outboxStatus: 'pending',
    ...(options.afterRevision === undefined
      ? {}
      : {
          metadata: {
            adapter: 'canonical-work-item',
            teamId: workItem.teamId,
            issueId: workItem.id,
            afterRevision: options.afterRevision,
          },
        }),
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
  }
}

/**
 * Simulates Work Items whose every mutation writes an audit event with its revision, plus
 * comment events that share the Work Item timeline.
 *
 * @param count - Number of Work Items.
 * @returns Final canonical Work Items and every audit event, in write order.
 */
function simulateHistory(count: number) {
  let seed = 42
  /** Returns the next deterministic pseudo-random integer below the bound. */
  const next = (bound: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed % bound
  }
  /** Picks a deterministic pseudo-random element. */
  const pick = <T,>(values: readonly T[]): T => {
    const value = values[next(values.length)]
    if (value === undefined) throw new Error('empty pick')
    return value
  }
  const statuses = ['backlog', 'unstarted', 'started', 'completed', 'canceled'] as const
  const projects = ['project-1', 'project-2', 'project-a', 'project-hidden'] as const
  const hour = 60 * 60 * 1_000
  const start = Date.parse('2026-01-01T00:00:00.000Z')
  const workItems: CanonicalWorkItem[] = []
  const events: AuditEventV1[] = []
  for (let index = 0; index < count; index += 1) {
    let at = start + next(24 * 60) * hour
    const createdAt = new Date(at).toISOString()
    let item = createWorkItem(`item-${String(index).padStart(3, '0')}`, {
      createdAt,
      updatedAt: createdAt,
      statusCategory: pick(statuses),
      assignedProjectId: pick(projects),
    })
    events.push(createAuditEvent(`${item.id}-created`, item, createdAt, [], {
      eventType: 'work-item.created',
      action: 'created',
      afterRevision: 1,
    }))
    const changeCount = next(8)
    for (let change = 0; change < changeCount; change += 1) {
      at += (1 + next(24 * 6)) * hour
      const occurredAt = new Date(at).toISOString()
      if (next(4) === 0) {
        events.push(createAuditEvent(`${item.id}-comment-${change}`, item, occurredAt, [
          { field: 'title', before: 'old comment', after: 'new comment' },
        ], { targetId: `comment-${item.id}-${change}`, eventType: 'comment.updated' }))
        continue
      }
      let changes: AuditFieldChange[]
      let after: CanonicalWorkItem
      if (next(3) === 0) {
        const assignedProjectId = pick(projects)
        changes = [
          { field: 'assignedProjectId', before: item.assignedProjectId ?? null, after: assignedProjectId },
          { field: 'priority', before: 'medium', after: 'high' },
        ]
        after = { ...item, assignedProjectId }
      } else {
        const statusCategory = pick(statuses)
        changes = [{ field: 'statusCategory', before: item.statusCategory, after: statusCategory }]
        after = { ...item, statusCategory }
      }
      after = { ...after, revision: item.revision + 1, updatedAt: occurredAt }
      events.push(createAuditEvent(`${item.id}-${change}`, item, occurredAt, changes, {
        afterRevision: after.revision,
      }))
      item = after
    }
    workItems.push(item)
  }
  return { workItems, events }
}

/** In-memory {@link AnalyticsWorkItemHistoryStore} that also reads rows like the repository. */
class MemoryHistoryStore implements AnalyticsWorkItemHistoryStore, AnalyticsWorkItemHistoryReader {
  /** Stored rows by record key. */
  readonly rows = new Map<string, AnalyticsWorkItemHistoryRow>()
  /** Number of successful writes. */
  writes = 0

  /**
   * Reads one row.
   *
   * @param key - Row identity.
   * @returns The row read.
   */
  async getRow(key: AnalyticsWorkItemHistoryKey): Promise<AnalyticsWorkItemHistoryRowRead> {
    const row = this.rows.get(this.recordKey(key))
    return { row: row ? structuredClone(row) : undefined, exists: row !== undefined }
  }

  /**
   * Writes one row when the stored version still matches.
   *
   * @param row - Row to save.
   * @param previous - Read the row was built from.
   * @returns Whether the write applied.
   */
  async putRow(row: AnalyticsWorkItemHistoryRow, previous: AnalyticsWorkItemHistoryRowRead) {
    const stored = this.rows.get(this.recordKey(row))
    if ((stored?.rowVersion ?? undefined) !== previous.row?.rowVersion) return false
    const roundTripped = parseStoredAnalyticsWorkItemHistoryRow(
      JSON.parse(JSON.stringify(toStoredAnalyticsWorkItemHistoryRow(row))),
    )
    if (!roundTripped) throw new Error('row does not round-trip')
    this.rows.set(this.recordKey(row), roundTripped)
    this.writes += 1
    return true
  }

  /**
   * Deletes one row.
   *
   * @param key - Row identity.
   */
  async deleteRow(key: AnalyticsWorkItemHistoryKey) {
    this.rows.delete(this.recordKey(key))
  }

  /**
   * Reads the rows of the given Work Items.
   *
   * @param id - Workspace ID.
   * @param workItems - Work Items to read.
   * @returns Existing rows.
   */
  async getWorkItemHistoryRows(
    id: string,
    workItems: readonly Pick<AnalyticsWorkItemHistoryKey, 'teamId' | 'workItemId'>[],
  ) {
    return workItems.flatMap((workItem) => {
      const row = this.rows.get(this.recordKey({ workspaceId: id, ...workItem }))
      return row ? [structuredClone(row)] : []
    })
  }

  /**
   * Builds the map key of a row.
   *
   * @param key - Row identity.
   * @returns The key.
   */
  private recordKey(key: AnalyticsWorkItemHistoryKey) {
    return `${key.workspaceId}|${createAnalyticsWorkItemHistoryRecordKey(key.teamId, key.workItemId)}`
  }
}

/**
 * Converts a plain value to a DynamoDB stream attribute.
 *
 * @param value - Plain value.
 * @returns The stream attribute.
 */
function marshal(value: unknown): DynamoAttributeValue {
  if (value === null) return { NULL: true }
  if (typeof value === 'string') return { S: value }
  if (typeof value === 'number') return { N: String(value) }
  if (typeof value === 'boolean') return { BOOL: value }
  if (Array.isArray(value)) return { L: value.map(marshal) }
  if (typeof value === 'object') {
    return {
      M: Object.fromEntries(
        Object.entries(value).filter(([, entry]) => entry !== undefined)
          .map(([key, entry]) => [key, marshal(entry)]),
      ),
    }
  }
  throw new Error('unsupported value')
}

/**
 * Builds an AuditEvents stream record.
 *
 * @param event - Audit event.
 * @param eventName - Stream event name.
 * @returns The stream record.
 */
function streamRecord(event: AuditEventV1, eventName: 'INSERT' | 'MODIFY' = 'INSERT'): DynamoStreamRecord {
  const image = marshal(event).M
  if (!image) throw new Error('not a map')
  return { eventName, dynamodb: { NewImage: image, SequenceNumber: event.eventId } }
}

/**
 * Builds a timeline reader over a fixed list of audit events.
 *
 * @param events - Events the audit table holds.
 * @returns A reader and a counter of reads.
 */
function createTimeline(events: readonly AuditEventV1[]) {
  const reads: string[] = []
  return {
    reads,
    /**
     * Returns the events of one Work Item.
     *
     * @param _workspaceId - Workspace ID.
     * @param teamId - Team ID.
     * @param workItemId - Work Item ID.
     * @returns The timeline.
     */
    async readWorkItemTimeline(
      _workspaceId: string,
      teamId: string,
      workItemId: string,
    ): Promise<AnalyticsWorkItemTimeline> {
      reads.push(workItemId)
      const entityId = `team/${teamId}/issue/${workItemId}`
      return {
        events: events.filter((event) => event.entityId === entityId)
          .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)),
        complete: true,
      }
    },
  }
}

const query: AnalyticsQueryInput = {
  filter: {
    period: { from: '2026-02-01T00:00:00.000Z', to: '2026-03-15T00:00:00.000Z' },
    includeArchived: true,
  },
  widgets: [
    ...(Object.keys(ANALYTICS_METRIC_DEFINITIONS) as Array<keyof typeof ANALYTICS_METRIC_DEFINITIONS>)
      .map((metric) => ({
        id: `chart-${metric}`,
        title: metric,
        type: 'chart' as const,
        metric,
        groupBy: { dimension: 'week' as const },
        ...(metric === 'sla' ? { slaTargetHours: 240 } : {}),
      })),
    {
      id: 'by-project',
      title: 'By project',
      type: 'table',
      metric: 'remaining-scope',
      groupBy: { dimension: 'project' },
    },
  ],
  asOf: '2026-03-10T12:00:00.000Z',
  timeZone: 'Asia/Tokyo',
}

describe('Analytics work item history rows', () => {
  test('produces the same snapshot and evidence as reading every audit timeline', async () => {
    const { workItems, events } = simulateHistory(180)
    const store = new MemoryHistoryStore()
    const timeline = createTimeline(events)
    for (const event of events) {
      const response = await processAnalyticsWorkItemHistoryProjectionBatch(
        { Records: [streamRecord(event)] },
        { store, readWorkItemTimeline: timeline.readWorkItemTimeline },
      )
      expect(response.batchItemFailures).toEqual([])
    }
    expect(timeline.reads).toEqual([])

    const historyWorkItems = selectAnalyticsWorkItemsRequiringHistory(
      workItems,
      query.filter.period.from,
    )
    const historyEvents = await readAnalyticsWorkItemHistoryEvents({
      workspaceId,
      workItems: historyWorkItems,
      historyReadAt: '2026-04-01T00:00:00.000Z',
      historyReader: store,
      readAuditEvents: async () => {
        throw new Error('every Work Item should be covered by its history row')
      },
    })
    const auditEvents = events.filter((event) =>
      historyWorkItems.some((item) => event.entityId === `team/${item.teamId}/issue/${item.id}`)
    )
    const fromAudit = createAnalyticsSnapshot({
      workItems,
      events: auditEvents,
      query,
      authorizedProjectIds,
    })
    const fromHistory = createAnalyticsSnapshot({
      workItems,
      events: historyEvents,
      query,
      authorizedProjectIds,
    })
    expect(fromHistory).toEqual(fromAudit)
    expect(fromAudit.widgets.some((widget) => (widget.value ?? 0) > 0)).toBe(true)

    for (const metric of ['throughput', 'cycle-time', 'wip', 'scope-change'] as const) {
      const evidence = {
        metric,
        filter: query.filter,
        asOf: query.asOf,
        timeZone: query.timeZone,
        limit: 200,
      }
      expect(queryAnalyticsEvidence({
        workItems,
        events: historyEvents,
        evidence,
        authorizedProjectIds,
      })).toEqual(queryAnalyticsEvidence({
        workItems,
        events: auditEvents,
        evidence,
        authorizedProjectIds,
      }))
    }
  })

  test('falls back to the audit timeline for missing, stale, and overflowed rows', async () => {
    const covered = createWorkItem('covered', { revision: 2 })
    const stale = createWorkItem('stale', { revision: 3 })
    const missing = createWorkItem('missing', { revision: 2 })
    const overflowed = createWorkItem('overflowed', { revision: 2 })
    const store = new MemoryHistoryStore()
    const rowFor = (item: CanonicalWorkItem, revisions: number[]) =>
      mergeAnalyticsWorkItemHistoryEntries(
        createEmptyAnalyticsWorkItemHistoryRow({ workspaceId, teamId: item.teamId, workItemId: item.id }),
        revisions.map((revision) => {
          const input = readAnalyticsWorkItemHistoryEvent(createAuditEvent(
            `${item.id}-${revision}`,
            item,
            `2026-01-0${revision}T00:00:00.000Z`,
            [],
            { afterRevision: revision },
          ))
          if (!input) throw new Error('not a history event')
          return input.entry
        }),
      )
    for (const row of [
      rowFor(covered, [1, 2]),
      rowFor(stale, [1, 2]),
      { ...rowFor(overflowed, [1, 2]), overflow: true, entries: [] },
    ]) {
      await store.putRow(row, { row: undefined, exists: false })
    }
    const fallback: string[] = []
    const result = await readAnalyticsWorkItemHistoryEvents({
      workspaceId,
      workItems: [covered, stale, missing, overflowed],
      historyReadAt: '2026-02-01T00:00:00.000Z',
      historyReader: store,
      readAuditEvents: async (items) => {
        fallback.push(...items.map((item) => item.id))
        return []
      },
    })
    expect(fallback).toEqual(['stale', 'missing', 'overflowed'])
    expect(result.map((event) => event.eventId)).toEqual(['covered-1', 'covered-2'])
  })

  test('reads 3,000 Work Items from history rows without the 500 audit timeline limit', async () => {
    const store = new MemoryHistoryStore()
    const workItems = Array.from({ length: 3_000 }, (_, index) =>
      createWorkItem(`bulk-${index}`, { revision: 1 })
    )
    for (const item of workItems) {
      const input = readAnalyticsWorkItemHistoryEvent(createAuditEvent(
        `${item.id}-created`,
        item,
        '2026-01-01T00:00:00.000Z',
        [],
        { eventType: 'work-item.created', action: 'created', afterRevision: 1 },
      ))
      if (!input) throw new Error('not a history event')
      await store.putRow(
        mergeAnalyticsWorkItemHistoryEntries(
          createEmptyAnalyticsWorkItemHistoryRow({ workspaceId, teamId: item.teamId, workItemId: item.id }),
          [input.entry],
        ),
        { row: undefined, exists: false },
      )
    }
    const events = await readAnalyticsWorkItemHistoryEvents({
      workspaceId,
      workItems,
      historyReadAt: '2026-02-01T00:00:00.000Z',
      historyReader: store,
      readAuditEvents: async () => {
        throw new Error('no Work Item should need the audit timeline')
      },
    })
    expect(events).toHaveLength(3_000)
  })

  test('drains BatchGetItem responses that return one row per call', async () => {
    const stored = new Map(Array.from({ length: 12 }, (_, index) => {
      const row = createEmptyAnalyticsWorkItemHistoryRow({
        workspaceId,
        teamId: 'core',
        workItemId: `size-${index}`,
      })
      const item = toStoredAnalyticsWorkItemHistoryRow({ ...row, coveredRevision: 1 })
      return [item.recordKey, item]
    }))
    let calls = 0
    /** Returns one requested row per call, like a partition hitting the 1 MB response limit. */
    const send = async (command: unknown) => {
      if (!(command instanceof BatchGetCommand)) throw new Error('unexpected command')
      calls += 1
      const keys = command.input.RequestItems?.['analytics-table']?.Keys ?? []
      const [first, ...rest] = keys
      const item = typeof first?.recordKey === 'string' ? stored.get(first.recordKey) : undefined
      return {
        Responses: { 'analytics-table': item ? [item] : [] },
        ...(rest.length === 0 ? {} : { UnprocessedKeys: { 'analytics-table': { Keys: rest } } }),
      }
    }
    // Same test-double pattern as analytics.test.ts: only `send` is exercised.
    const client = { send } as unknown as DynamoDBDocumentClient
    const rows = await new DynamoDbAnalyticsRepository('analytics-table', client)
      .getWorkItemHistoryRows(workspaceId, [...stored.values()].map((item) => ({
        teamId: item.teamId,
        workItemId: item.workItemId,
      })))
    expect(rows).toHaveLength(12)
    expect(calls).toBe(12)
  })

  test('rejects reads whose history rows exceed the byte budget', async () => {
    const padding = 'x'.repeat(300 * 1024)
    const item = toStoredAnalyticsWorkItemHistoryRow({
      ...createEmptyAnalyticsWorkItemHistoryRow({ workspaceId, teamId: 'core', workItemId: 'big' }),
      coveredRevision: 1,
      entries: [{
        eventId: 'big-1',
        eventType: 'work-item.created',
        action: 'created',
        occurredAt: '2026-01-01T00:00:00.000Z',
        changes: [{ field: 'statusCategory', before: null, after: padding }],
        metadata: { afterRevision: 1 },
      }],
    })
    let calls = 0
    /** Returns the same large row for every requested key. */
    const send = async (command: unknown) => {
      if (!(command instanceof BatchGetCommand)) throw new Error('unexpected command')
      calls += 1
      const keys = command.input.RequestItems?.['analytics-table']?.Keys ?? []
      return {
        Responses: {
          'analytics-table': keys.map((key) => {
            const workItemId = String(key.recordKey).split('#').at(-1) ?? ''
            return { ...item, recordKey: key.recordKey, workItemId }
          }),
        },
      }
    }
    // Same test-double pattern as analytics.test.ts: only `send` is exercised.
    const client = { send } as unknown as DynamoDBDocumentClient
    const read = new DynamoDbAnalyticsRepository('analytics-table', client)
      .getWorkItemHistoryRows(workspaceId, Array.from({ length: 1_000 }, (_, index) => ({
        teamId: 'core',
        workItemId: `big-${index}`,
      })))
    await expect(read).rejects.toMatchObject({ status: 413, code: 'AnalyticsHistoryLimitExceeded' })
    expect(calls).toBeLessThan(10)
  })

  test('rejects reads that would restore more history entries than the limit', async () => {
    const item = createWorkItem('large', { revision: 1 })
    const entry = {
      eventId: 'e',
      eventType: 'work-item.created',
      action: 'created',
      occurredAt: '2026-01-01T00:00:00.000Z',
      changes: [],
      metadata: { afterRevision: 1 },
    }
    const row: AnalyticsWorkItemHistoryRow = {
      ...createEmptyAnalyticsWorkItemHistoryRow({ workspaceId, teamId: 'core', workItemId: 'large' }),
      coveredRevision: 1,
      entries: Array.from({ length: 200_001 }, (_, index) => ({ ...entry, eventId: `e-${index}` })),
    }
    const reader: AnalyticsWorkItemHistoryReader = {
      getWorkItemHistoryRows: async () => [row],
    }
    const read = readAnalyticsWorkItemHistoryEvents({
      workspaceId,
      workItems: [item],
      historyReadAt: '2026-02-01T00:00:00.000Z',
      historyReader: reader,
      readAuditEvents: async () => [],
    })
    expect(read).rejects.toBeInstanceOf(AnalyticsError)
  })

  test('rebuilds from the audit timeline when the row is missing or has a revision gap', async () => {
    const item = createWorkItem('gap')
    const created = createAuditEvent('gap-1', item, '2026-01-01T00:00:00.000Z', [], {
      eventType: 'work-item.created',
      action: 'created',
      afterRevision: 1,
    })
    const second = createAuditEvent('gap-2', item, '2026-01-02T00:00:00.000Z', [
      { field: 'statusCategory', before: 'backlog', after: 'started' },
    ], { afterRevision: 2 })
    const third = createAuditEvent('gap-3', item, '2026-01-03T00:00:00.000Z', [
      { field: 'statusCategory', before: 'started', after: 'completed' },
    ], { afterRevision: 3 })
    const store = new MemoryHistoryStore()
    const timeline = createTimeline([created, second, third])

    // The projection sees revision 3 first: no row exists, so it rebuilds from the timeline.
    await processAnalyticsWorkItemHistoryProjectionBatch(
      { Records: [streamRecord(third)] },
      { store, readWorkItemTimeline: timeline.readWorkItemTimeline },
    )
    const key = { workspaceId, teamId: 'core', workItemId: 'gap' }
    expect((await store.getRow(key)).row?.coveredRevision).toBe(3)
    expect(timeline.reads).toEqual(['gap'])

    // Replays are no-ops and do not write.
    const writes = store.writes
    await processAnalyticsWorkItemHistoryProjectionBatch(
      { Records: [streamRecord(created), streamRecord(second)] },
      { store, readWorkItemTimeline: timeline.readWorkItemTimeline },
    )
    expect(store.writes).toBe(writes)
  })

  test('stops coverage at a gap that the audit index has not caught up with', async () => {
    const item = createWorkItem('lag')
    const created = createAuditEvent('lag-1', item, '2026-01-01T00:00:00.000Z', [], {
      eventType: 'work-item.created',
      action: 'created',
      afterRevision: 1,
    })
    const second = createAuditEvent('lag-2', item, '2026-01-02T00:00:00.000Z', [], {
      afterRevision: 2,
    })
    const third = createAuditEvent('lag-3', item, '2026-01-03T00:00:00.000Z', [], {
      afterRevision: 3,
    })
    const store = new MemoryHistoryStore()
    const dependencies = { store, readWorkItemTimeline: createTimeline([created]).readWorkItemTimeline }
    await processAnalyticsWorkItemHistoryProjectionBatch({ Records: [streamRecord(created)] }, dependencies)
    await processAnalyticsWorkItemHistoryProjectionBatch({ Records: [streamRecord(third)] }, dependencies)
    const key = { workspaceId, teamId: 'core', workItemId: 'lag' }
    expect((await store.getRow(key)).row?.coveredRevision).toBe(1)
    await processAnalyticsWorkItemHistoryProjectionBatch({ Records: [streamRecord(second)] }, dependencies)
    expect((await store.getRow(key)).row?.coveredRevision).toBe(3)
  })

  test('updates retention expiry on MODIFY and drops expired entries when reading', async () => {
    const item = createWorkItem('retention')
    const created = createAuditEvent('retention-1', item, '2026-01-01T00:00:00.000Z', [], {
      eventType: 'work-item.created',
      action: 'created',
      afterRevision: 1,
      expiresAt: 2_000_000_000,
    })
    const store = new MemoryHistoryStore()
    const dependencies = { store, readWorkItemTimeline: createTimeline([]).readWorkItemTimeline }
    await processAnalyticsWorkItemHistoryProjectionBatch({ Records: [streamRecord(created)] }, dependencies)
    await processAnalyticsWorkItemHistoryProjectionBatch({
      Records: [streamRecord({ ...created, expiresAt: 1_800_000_000 }, 'MODIFY')],
    }, dependencies)
    const key = { workspaceId, teamId: 'core', workItemId: 'retention' }
    const row = (await store.getRow(key)).row
    expect(row?.entries.map((entry) => entry.expiresAt)).toEqual([1_800_000_000])
    if (!row) throw new Error('row missing')
    expect(toAnalyticsHistoryEvents(row, '2027-01-01T00:00:00.000Z', 1_700_000_000)).toHaveLength(1)
    expect(toAnalyticsHistoryEvents(row, '2027-01-01T00:00:00.000Z', 1_800_000_000)).toHaveLength(0)
    expect(toAnalyticsHistoryEvents(row, '2025-12-31T00:00:00.000Z', 1_700_000_000)).toHaveLength(0)
  })

  test('keeps applied retention updates when a later gap rebuilds from a stale index', async () => {
    const item = createWorkItem('stale-retention')
    const options = { expiresAt: 2_000_000_000 }
    const created = createAuditEvent('stale-1', item, '2026-01-01T00:00:00.000Z', [], {
      ...options,
      eventType: 'work-item.created',
      action: 'created',
      afterRevision: 1,
    })
    const second = createAuditEvent('stale-2', item, '2026-01-02T00:00:00.000Z', [], {
      ...options,
      afterRevision: 2,
    })
    const third = createAuditEvent('stale-3', item, '2026-01-03T00:00:00.000Z', [], {
      ...options,
      afterRevision: 3,
    })
    const fourth = createAuditEvent('stale-4', item, '2026-01-04T00:00:00.000Z', [], {
      ...options,
      afterRevision: 4,
    })
    const store = new MemoryHistoryStore()
    // The index still returns the expiry from before the retention change.
    const dependencies = {
      store,
      readWorkItemTimeline: createTimeline([created, second, third]).readWorkItemTimeline,
    }
    await processAnalyticsWorkItemHistoryProjectionBatch({
      Records: [streamRecord(created), streamRecord(second)],
    }, dependencies)
    await processAnalyticsWorkItemHistoryProjectionBatch({
      Records: [
        streamRecord({ ...created, expiresAt: 1_800_000_000 }, 'MODIFY'),
        streamRecord({ ...second, expiresAt: 1_800_000_000 }, 'MODIFY'),
      ],
    }, dependencies)
    await processAnalyticsWorkItemHistoryProjectionBatch({
      Records: [streamRecord({ ...fourth, expiresAt: 1_800_000_000 })],
    }, dependencies)
    const row = (await store.getRow({ workspaceId, teamId: 'core', workItemId: 'stale-retention' })).row
    expect(row?.coveredRevision).toBe(4)
    expect(row?.entries.map((entry) => [entry.eventId, entry.expiresAt])).toEqual([
      ['stale-1', 1_800_000_000],
      ['stale-2', 1_800_000_000],
      ['stale-3', 2_000_000_000],
      ['stale-4', 1_800_000_000],
    ])
  })

  test('drops expired entries on write and expires the row with its oldest entry', () => {
    const key = { workspaceId, teamId: 'core', workItemId: 'ttl' }
    const now = Date.parse('2026-06-01T00:00:00.000Z') / 1000
    const entry = (revision: number, expiresAt?: number) => ({
      eventId: `ttl-${revision}`,
      eventType: 'work-item.updated',
      action: 'updated',
      occurredAt: `2026-01-0${revision}T00:00:00.000Z`,
      changes: [],
      metadata: { afterRevision: revision },
      ...(expiresAt === undefined ? {} : { expiresAt }),
    })
    const row = mergeAnalyticsWorkItemHistoryEntries(
      createEmptyAnalyticsWorkItemHistoryRow(key),
      [entry(1, now - 10), entry(2, now + 300), entry(3, now + 200), entry(4)],
      now,
    )
    expect(row.entries.map((stored) => stored.eventId)).toEqual(['ttl-2', 'ttl-3', 'ttl-4'])
    expect(row.coveredRevision).toBe(4)
    expect(toStoredAnalyticsWorkItemHistoryRow(row).historyExpiresAt).toBe(now + 200)
    const held = mergeAnalyticsWorkItemHistoryEntries(createEmptyAnalyticsWorkItemHistoryRow(key), [entry(1)])
    expect('historyExpiresAt' in toStoredAnalyticsWorkItemHistoryRow(held)).toBe(false)
  })

  test('logs store failures without failing the stream batch', async () => {
    const item = createWorkItem('failing')
    const created = createAuditEvent('failing-1', item, '2026-01-01T00:00:00.000Z', [], {
      eventType: 'work-item.created',
      action: 'created',
      afterRevision: 1,
    })
    const store = new MemoryHistoryStore()
    store.getRow = async () => {
      throw Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' })
    }
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => { errors.push(args) }
    try {
      const response = await processAnalyticsWorkItemHistoryProjectionBatch(
        { Records: [streamRecord(created)] },
        { store, readWorkItemTimeline: createTimeline([]).readWorkItemTimeline },
      )
      expect(response.batchItemFailures).toEqual([])
      const key = { workspaceId, teamId: 'core', workItemId: 'failing' }
      store.rows.set(`${workspaceId}|${createAnalyticsWorkItemHistoryRecordKey('core', 'failing')}`, {
        ...createEmptyAnalyticsWorkItemHistoryRow(key),
        coveredRevision: 1,
      })
      const retried = await processAnalyticsWorkItemHistoryProjectionBatch(
        { Records: [streamRecord({ ...created, expiresAt: 1_900_000_000 }, 'MODIFY')] },
        { store, readWorkItemTimeline: createTimeline([]).readWorkItemTimeline },
      )
      expect(retried.batchItemFailures).toEqual([])
      expect(store.rows.size).toBe(0)
      store.deleteRow = async () => {
        throw new Error('still throttled')
      }
      const failed = await processAnalyticsWorkItemHistoryProjectionBatch(
        { Records: [streamRecord(created)] },
        { store, readWorkItemTimeline: createTimeline([]).readWorkItemTimeline },
      )
      expect(failed.batchItemFailures).toEqual([{ itemIdentifier: 'failing-1' }])
    } finally {
      console.error = original
    }
    expect(errors).toHaveLength(3)
  })

  test('does not start coverage after revision 1 while the audit index may still be catching up', async () => {
    const item = createWorkItem('recent')
    const second = createAuditEvent('recent-2', item, '2026-11-21T11:59:00.000Z', [], { afterRevision: 2 })
    const third = createAuditEvent('recent-3', item, '2026-11-21T12:00:00.000Z', [], { afterRevision: 3 })
    const store = new MemoryHistoryStore()
    const key = { workspaceId, teamId: 'core', workItemId: 'recent' }
    // The index has not returned revisions 1 and 2 yet; only revision 3 itself is known.
    await processAnalyticsWorkItemHistoryProjectionBatch({ Records: [streamRecord(third)] }, {
      store,
      readWorkItemTimeline: createTimeline([]).readWorkItemTimeline,
      now: () => new Date('2026-11-21T12:00:30.000Z'),
    })
    expect((await store.getRow(key)).row?.coveredRevision).toBe(0)
    // Hours later, revision 2 is the oldest retained event, so earlier ones have expired.
    await processAnalyticsWorkItemHistoryProjectionBatch({ Records: [streamRecord(second)] }, {
      store,
      readWorkItemTimeline: createTimeline([second, third]).readWorkItemTimeline,
      now: () => new Date('2026-11-21T15:00:00.000Z'),
    })
    expect((await store.getRow(key)).row?.coveredRevision).toBe(3)
  })

  test('deletes the row when the Work Item is deleted and skips attached records', async () => {
    const item = createWorkItem('deleted')
    const created = createAuditEvent('deleted-1', item, '2026-01-01T00:00:00.000Z', [], {
      eventType: 'work-item.created',
      action: 'created',
      afterRevision: 1,
    })
    const comment = createAuditEvent('deleted-c', item, '2026-01-02T00:00:00.000Z', [
      { field: 'title', before: 'a', after: 'b' },
    ], { targetId: 'comment-1' })
    const deleted = createAuditEvent('deleted-2', item, '2026-01-03T00:00:00.000Z', [], {
      eventType: 'work-item.deleted',
      action: 'deleted',
    })
    const store = new MemoryHistoryStore()
    const dependencies = { store, readWorkItemTimeline: createTimeline([]).readWorkItemTimeline }
    await processAnalyticsWorkItemHistoryProjectionBatch({
      Records: [streamRecord(created), streamRecord(comment)],
    }, dependencies)
    const key = { workspaceId, teamId: 'core', workItemId: 'deleted' }
    expect((await store.getRow(key)).row?.entries.map((entry) => entry.eventId)).toEqual(['deleted-1'])
    await processAnalyticsWorkItemHistoryProjectionBatch({ Records: [streamRecord(deleted)] }, dependencies)
    expect((await store.getRow(key)).exists).toBe(false)
  })

  test('rebuilds a Work Item recreated with the same ID from its new history only', async () => {
    const item = createWorkItem('again')
    const first = createAuditEvent('again-1', item, '2026-01-01T00:00:00.000Z', [], {
      eventType: 'work-item.created',
      action: 'created',
      afterRevision: 1,
    })
    const deleted = createAuditEvent('again-2', item, '2026-01-02T00:00:00.000Z', [], {
      eventType: 'work-item.deleted',
      action: 'deleted',
    })
    const recreated = createAuditEvent('again-3', item, '2026-01-03T00:00:00.000Z', [], {
      eventType: 'work-item.created',
      action: 'created',
      afterRevision: 1,
    })
    const second = createAuditEvent('again-4', item, '2026-01-04T00:00:00.000Z', [], { afterRevision: 2 })
    const third = createAuditEvent('again-5', item, '2026-01-05T00:00:00.000Z', [], { afterRevision: 3 })
    const store = new MemoryHistoryStore()
    const timeline = createTimeline([first, deleted, recreated, second, third])
    await processAnalyticsWorkItemHistoryProjectionBatch(
      { Records: [streamRecord(third)] },
      { store, readWorkItemTimeline: timeline.readWorkItemTimeline },
    )
    const row = (await store.getRow({ workspaceId, teamId: 'core', workItemId: 'again' })).row
    expect(row?.coveredRevision).toBe(3)
    expect(row?.entries.map((entry) => entry.eventId)).toEqual(['again-3', 'again-4', 'again-5'])

    // A delete after the event still means the Work Item is gone.
    const later = new MemoryHistoryStore()
    await processAnalyticsWorkItemHistoryProjectionBatch(
      { Records: [streamRecord(second)] },
      { store: later, readWorkItemTimeline: createTimeline([recreated, second, { ...deleted, occurredAt: '2026-01-06T00:00:00.000Z' }]).readWorkItemTimeline },
    )
    expect((await later.getRow({ workspaceId, teamId: 'core', workItemId: 'again' })).exists).toBe(false)
  })

  test('expires an overflowed row with its oldest entry and rebuilds it afterwards', async () => {
    const key = { workspaceId, teamId: 'core', workItemId: 'shrink' }
    const now = Date.parse('2026-06-01T00:00:00.000Z') / 1000
    const entries = Array.from({ length: 400 }, (_, index) => ({
      eventId: `shrink-${index}`,
      eventType: 'work-item.updated',
      action: 'updated',
      occurredAt: new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString(),
      changes: [{ field: 'title', before: 'x'.repeat(500), after: 'y'.repeat(500) }],
      metadata: { afterRevision: index + 1 },
      expiresAt: now + 1_000 + index,
    }))
    const overflowed = mergeAnalyticsWorkItemHistoryEntries(
      createEmptyAnalyticsWorkItemHistoryRow(key),
      entries,
      now,
    )
    expect(overflowed.overflow).toBe(true)
    expect(overflowed.overflowExpiresAt).toBe(now + 1_000)
    const stored = toStoredAnalyticsWorkItemHistoryRow(overflowed)
    expect(stored.historyExpiresAt).toBe(now + 1_000)
    expect(parseStoredAnalyticsWorkItemHistoryRow(stored)?.overflowExpiresAt).toBe(now + 1_000)

    // After the oldest entry expires, the next event measures the remaining history again.
    const store = new MemoryHistoryStore()
    store.rows.set(
      `${workspaceId}|${createAnalyticsWorkItemHistoryRecordKey('core', 'shrink')}`,
      { ...overflowed, overflowExpiresAt: now - 1 },
    )
    const item = createWorkItem('shrink')
    const created = createAuditEvent('shrink-a', item, '2026-01-01T00:00:00.000Z', [], {
      eventType: 'work-item.created',
      action: 'created',
      afterRevision: 1,
    })
    const next = createAuditEvent('shrink-b', item, '2026-01-02T00:00:00.000Z', [], { afterRevision: 2 })
    await processAnalyticsWorkItemHistoryProjectionBatch(
      { Records: [streamRecord(next)] },
      { store, readWorkItemTimeline: createTimeline([created, next]).readWorkItemTimeline, now: () => new Date(now * 1000) },
    )
    const row = (await store.getRow(key)).row
    expect(row?.overflow).toBe(false)
    expect(row?.coveredRevision).toBe(2)
  })

  test('rechecks an overflowed row without expiry and versions new rows by time', async () => {
    const key = { workspaceId, teamId: 'core', workItemId: 'held' }
    const now = Date.parse('2026-06-01T00:00:00.000Z') / 1000
    const entries = Array.from({ length: 400 }, (_, index) => ({
      eventId: `held-${index}`,
      eventType: 'work-item.updated',
      action: 'updated',
      occurredAt: new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString(),
      changes: [{ field: 'title', before: 'x'.repeat(500), after: 'y'.repeat(500) }],
      metadata: { afterRevision: index + 1 },
    }))
    const overflowed = mergeAnalyticsWorkItemHistoryEntries(createEmptyAnalyticsWorkItemHistoryRow(key), entries, now)
    expect(overflowed.overflow).toBe(true)
    expect(overflowed.overflowExpiresAt).toBe(now + 30 * 24 * 60 * 60)

    // A recreated row never reuses the version of a row that was deleted before it.
    const item = createWorkItem('versioned')
    const created = createAuditEvent('versioned-1', item, '2026-01-01T00:00:00.000Z', [], {
      eventType: 'work-item.created',
      action: 'created',
      afterRevision: 1,
    })
    const store = new MemoryHistoryStore()
    await processAnalyticsWorkItemHistoryProjectionBatch(
      { Records: [streamRecord(created)] },
      { store, readWorkItemTimeline: createTimeline([]).readWorkItemTimeline, now: () => new Date(now * 1000) },
    )
    const versionedKey = { workspaceId, teamId: 'core', workItemId: 'versioned' }
    const staleRead = await store.getRow(versionedKey)
    const row = staleRead.row
    expect(row?.rowVersion).toBeGreaterThan(0)
    expect(row?.rowVersion).toBeLessThan(2 ** 48)
    expect(Number.isSafeInteger(row?.rowVersion)).toBe(true)

    // A writer that read the row before it was deleted and recreated cannot overwrite the new row.
    await store.deleteRow(versionedKey)
    await processAnalyticsWorkItemHistoryProjectionBatch(
      { Records: [streamRecord(created)] },
      { store, readWorkItemTimeline: createTimeline([]).readWorkItemTimeline, now: () => new Date(now * 1000) },
    )
    const recreated = (await store.getRow(versionedKey)).row
    expect(recreated?.rowVersion).not.toBe(row?.rowVersion)
    if (!row) throw new Error('row was not written')
    const staleWrite = { ...row, rowVersion: row.rowVersion + 1, coveredRevision: 99 }
    expect(await store.putRow(staleWrite, staleRead)).toBe(false)
    expect((await store.getRow(versionedKey)).row).toEqual(recreated)
  })

  test('replaces a malformed row only while it is still the item that was read', async () => {
    const conditions: unknown[] = []
    /** Records each conditional put. */
    const send = async (command: unknown) => {
      if (!(command instanceof PutCommand)) throw new Error('unexpected command')
      conditions.push([command.input.ConditionExpression, command.input.ExpressionAttributeValues])
      return {}
    }
    // Same test-double pattern as analytics.test.ts: only `send` is exercised.
    const client = { send } as unknown as DynamoDBDocumentClient
    const store = new DynamoDbAnalyticsWorkItemHistoryStore('analytics-table', client)
    const row = createEmptyAnalyticsWorkItemHistoryRow({ workspaceId, teamId: 'core', workItemId: 'bad' })
    await store.putRow(row, { row: undefined, exists: true, storedRowVersion: 7 })
    await store.putRow(row, { row: undefined, exists: true })
    expect(conditions).toEqual([
      ['rowVersion = :rowVersion', { ':rowVersion': 7 }],
      ['attribute_exists(recordKey) AND attribute_not_exists(rowVersion)', undefined],
    ])
  })

  test('reads the audit timeline when a row has expired entries or a read fails temporarily', async () => {
    const item = createWorkItem('fallback', { revision: 1 })
    const row: AnalyticsWorkItemHistoryRow = {
      ...createEmptyAnalyticsWorkItemHistoryRow({ workspaceId, teamId: 'core', workItemId: 'fallback' }),
      coveredRevision: 1,
      entries: [{
        eventId: 'fallback-1',
        eventType: 'work-item.created',
        action: 'created',
        occurredAt: '2026-01-01T00:00:00.000Z',
        changes: [],
        metadata: { afterRevision: 1 },
        expiresAt: 1_000,
      }],
    }
    const audit: AnalyticsHistoryEvent[] = []
    let auditReads = 0
    const readAuditEvents = async () => {
      auditReads += 1
      return audit
    }
    const base = { workspaceId, workItems: [item], historyReadAt: '2026-02-01T00:00:00.000Z', readAuditEvents }
    await readAnalyticsWorkItemHistoryEvents({
      ...base,
      historyReader: { getWorkItemHistoryRows: async () => [row] },
      now: () => new Date(2_000 * 1000),
    })
    expect(auditReads).toBe(1)
    await readAnalyticsWorkItemHistoryEvents({
      ...base,
      historyReader: {
        getWorkItemHistoryRows: async () => {
          throw Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' })
        },
      },
    })
    expect(auditReads).toBe(2)
    const tooLarge = readAnalyticsWorkItemHistoryEvents({
      ...base,
      historyReader: {
        getWorkItemHistoryRows: async () => {
          throw new AnalyticsError(413, 'AnalyticsHistoryLimitExceeded', 'too large')
        },
      },
    })
    await expect(tooLarge).rejects.toMatchObject({ status: 413 })
    const denied = readAnalyticsWorkItemHistoryEvents({
      ...base,
      historyReader: {
        getWorkItemHistoryRows: async () => {
          throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' })
        },
      },
    })
    await expect(denied).rejects.toMatchObject({ name: 'AccessDeniedException' })
    await readAnalyticsWorkItemHistoryEvents({
      ...base,
      historyReader: {
        getWorkItemHistoryRows: async () => {
          throw new AnalyticsError(503, 'AnalyticsHistoryReadUnavailable', 'retry')
        },
      },
    })
    expect(auditReads).toBe(3)
  })

  test('rejects stored entries whose occurrence time is not a valid timestamp', () => {
    const row = toStoredAnalyticsWorkItemHistoryRow({
      ...createEmptyAnalyticsWorkItemHistoryRow({ workspaceId, teamId: 'core', workItemId: 'time' }),
      coveredRevision: 1,
      entries: [{
        eventId: 'time-1',
        eventType: 'work-item.created',
        action: 'created',
        occurredAt: 'invalid',
        changes: [],
        metadata: { afterRevision: 1 },
      }],
    })
    expect(parseStoredAnalyticsWorkItemHistoryRow(row)).toBeUndefined()
  })

  test('marks a row that does not fit as overflowed', () => {
    const key = { workspaceId, teamId: 'core', workItemId: 'big' }
    const entries = Array.from({ length: 400 }, (_, index) => ({
      eventId: `big-${index}`,
      eventType: 'work-item.updated',
      action: 'updated',
      occurredAt: new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString(),
      changes: [{ field: 'title', before: 'x'.repeat(500), after: 'y'.repeat(500) }],
      metadata: { afterRevision: index + 1 },
    }))
    const row = mergeAnalyticsWorkItemHistoryEntries(createEmptyAnalyticsWorkItemHistoryRow(key), entries)
    expect(JSON.stringify(entries).length).toBeGreaterThan(ANALYTICS_WORK_ITEM_HISTORY_MAX_BYTES)
    expect(row.overflow).toBe(true)
    expect(row.entries).toEqual([])
  })

  test('keeps only Analytics fields and rejects malformed stored rows', () => {
    const item = createWorkItem('fields')
    const input = readAnalyticsWorkItemHistoryEvent(createAuditEvent('fields-2', item, '2026-01-02T00:00:00.000Z', [
      { field: 'statusCategory', before: 'backlog', after: 'started' },
      { field: 'description', before: 'secret', after: 'other' },
      { field: 'customFieldValues.points', before: 1, after: 3 },
    ], { afterRevision: 2 }))
    expect(input?.entry.changes.map((change) => change.field)).toEqual([
      'statusCategory',
      'customFieldValues.points',
    ])
    const restored: AnalyticsHistoryEvent[] = input
      ? toAnalyticsHistoryEvents(
          mergeAnalyticsWorkItemHistoryEntries(
            createEmptyAnalyticsWorkItemHistoryRow({ workspaceId, teamId: 'core', workItemId: 'fields' }),
            [input.entry],
          ),
          '2026-02-01T00:00:00.000Z',
          0,
        )
      : []
    expect(restored[0]?.metadata).toEqual({
      adapter: 'canonical-work-item',
      teamId: 'core',
      issueId: 'fields',
      afterRevision: 2,
    })
    expect(parseStoredAnalyticsWorkItemHistoryRow({
      ...toStoredAnalyticsWorkItemHistoryRow(
        createEmptyAnalyticsWorkItemHistoryRow({ workspaceId, teamId: 'core', workItemId: 'fields' }),
      ),
      recordKey: createAnalyticsWorkItemHistoryRecordKey('core', 'other'),
    })).toBeUndefined()
  })
})
