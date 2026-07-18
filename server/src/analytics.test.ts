import { describe, expect, test } from 'bun:test'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  type AnalyticsQueryInput,
  type AnalyticsSnapshotRecord,
  type CanonicalWorkItem,
  type CreateAnalyticsReportInput,
} from '@mukuroji/contracts'
import {
  ANALYTICS_METRIC_DEFINITIONS,
  AnalyticsError,
  DynamoDbAnalyticsRepository,
  InMemoryAnalyticsRepository,
  calculateAnalyticsNextRunAt,
  createAnalyticsCsv,
  createAnalyticsPermissionScopeHash,
  createAnalyticsPdf,
  createAnalyticsScheduleShard,
  createAnalyticsSnapshot,
  normalizeAnalyticsExportLocale,
  queryAnalyticsEvidence,
} from './analytics'
import {
  AUDIT_SCHEMA_VERSION,
  type AuditEventV1,
  type AuditFieldChange,
} from './audit'
import { analyticsPdfFont } from './analytics-pdf-font'

const period = {
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-01-07T00:00:00.000Z',
}

const defaultAuthorizedProjectIds = new Set([
  '=cmd',
  'project-1',
  'project-2',
  'project-a',
  'project-b',
])

function createTestAnalyticsSnapshot(
  input: Omit<Parameters<typeof createAnalyticsSnapshot>[0], 'authorizedProjectIds'>,
  authorizedProjectIds: ReadonlySet<string> = defaultAuthorizedProjectIds,
) {
  return createAnalyticsSnapshot({ ...input, authorizedProjectIds })
}

function queryTestAnalyticsEvidence(
  input: Omit<Parameters<typeof queryAnalyticsEvidence>[0], 'authorizedProjectIds'>,
  authorizedProjectIds: ReadonlySet<string> = defaultAuthorizedProjectIds,
) {
  return queryAnalyticsEvidence({ ...input, authorizedProjectIds })
}

function createWorkItem(
  id: string,
  overrides: Partial<CanonicalWorkItem> = {},
): CanonicalWorkItem {
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    id,
    teamId: 'core',
    title: `Work ${id}`,
    assigneeUserId: 'user-1',
    creatorMemberKey: 'member-1',
    dueDate: '2026-01-10',
    priority: 'medium',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-06T00:00:00.000Z',
    workflowStatusId: 'status-completed',
    statusCategory: 'completed',
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    customFieldValues: {},
    relationIds: [],
    source: 'dynamodb',
    ...overrides,
  }
}

function createAuditEvent(
  eventId: string,
  workItem: CanonicalWorkItem,
  occurredAt: string,
  changes: AuditFieldChange[],
): AuditEventV1 {
  const entityId = `team/${workItem.teamId}/issue/${workItem.id}`
  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    eventId,
    directoryId: 'workspace-1',
    workspaceId: 'workspace-1',
    workspaceKey: 'workspace-1',
    eventType: 'work-item.updated',
    occurredAt,
    occurredAtEventId: `${occurredAt}#${eventId}`,
    workspaceEventKey: `${occurredAt}#${eventId}`,
    actor: { id: 'user-1', kind: 'user' },
    actorUserId: 'user-1',
    actorKey: 'workspace-1#user-1',
    actorEventKey: `${occurredAt}#${eventId}`,
    entity: { type: 'work-item', id: entityId },
    entityType: 'work-item',
    entityId,
    entityKey: `workspace-1#work-item#${entityId}`,
    entityEventKey: `${occurredAt}#${eventId}`,
    target: { type: 'work-item', id: entityId },
    targetType: 'work-item',
    targetId: entityId,
    targetKey: `workspace-1#work-item#${entityId}`,
    targetEventKey: `${occurredAt}#${eventId}`,
    changes,
    action: 'updated',
    correlationId: eventId,
    idempotencyKeyHash: eventId,
    requestFingerprint: eventId,
    source: 'api',
    outboxStatus: 'pending',
  }
}

function createQuery(
  widgets: AnalyticsQueryInput['widgets'],
  overrides: Partial<AnalyticsQueryInput> = {},
): AnalyticsQueryInput {
  return {
    filter: { period },
    widgets,
    asOf: period.to,
    timeZone: 'UTC',
    ...overrides,
  }
}

function createReportInput(
  overrides: Partial<CreateAnalyticsReportInput> = {},
): CreateAnalyticsReportInput {
  return {
    id: 'report-1',
    name: 'Delivery health',
    visibility: 'personal',
    timeZone: 'UTC',
    filter: { period },
    widgets: [{
      id: 'throughput',
      title: 'Throughput',
      type: 'metric',
      metric: 'throughput',
    }],
    ...overrides,
  }
}

function createDynamoDocumentClient() {
  const rows = new Map<string, Record<string, unknown>>()
  const commands: unknown[] = []
  let queryLastEvaluatedKey: Record<string, unknown> | undefined
  let queryPageSize: number | undefined
  let nextTransactionError: unknown
  const keyOf = (key: Record<string, unknown>) =>
    `${String(key.workspaceId)}\u0000${String(key.recordKey)}`
  const send = async (command: unknown) => {
    commands.push(command)
    if (command instanceof GetCommand) {
      const key = command.input.Key!
      return { Item: rows.get(keyOf(key)) }
    }
    if (command instanceof PutCommand) {
      const item = command.input.Item!
      const key = keyOf(item)
      const current = rows.get(key)
      if (command.input.ConditionExpression?.includes('attribute_not_exists') && current) {
        throw Object.assign(new Error('conditional'), {
          name: 'ConditionalCheckFailedException',
        })
      }
      const expectedRevision = command.input.ExpressionAttributeValues?.[':expectedRevision']
      if (
        expectedRevision !== undefined &&
        current?.revision !== expectedRevision
      ) {
        throw Object.assign(new Error('conditional'), {
          name: 'ConditionalCheckFailedException',
        })
      }
      rows.set(key, structuredClone(item))
      return {}
    }
    if (command instanceof TransactWriteCommand) {
      if (nextTransactionError !== undefined) {
        const error = nextTransactionError
        nextTransactionError = undefined
        throw error
      }
      const writes = (command.input.TransactItems ?? []).flatMap((item) =>
        item.Put === undefined ? [] : [item.Put]
      )
      for (const write of writes) {
        const item = write.Item!
        if (
          write.ConditionExpression?.includes('attribute_not_exists') &&
          rows.has(keyOf(item))
        ) {
          throw Object.assign(new Error('transaction canceled'), {
            name: 'TransactionCanceledException',
            CancellationReasons: [
              { Code: 'ConditionalCheckFailed' },
              { Code: 'None' },
            ],
          })
        }
      }
      for (const write of writes) {
        const item = write.Item!
        rows.set(keyOf(item), structuredClone(item))
      }
      return {}
    }
    if (command instanceof DeleteCommand) {
      const key = command.input.Key!
      const current = rows.get(keyOf(key))
      const expectedRevision = command.input.ExpressionAttributeValues?.[':expectedRevision']
      if (!current || current.revision !== expectedRevision) {
        throw Object.assign(new Error('conditional'), {
          name: 'ConditionalCheckFailedException',
        })
      }
      rows.delete(keyOf(key))
      return {}
    }
    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues ?? {}
      const workspaceId = values[':workspaceId']
      const recordPrefix = values[':recordPrefix']
      const snapshotId = values[':snapshotId']
      const upperBound = values[':upperBound']
      const items = [...rows.values()].filter((item) => {
        if (
          workspaceId !== undefined &&
          item.workspaceId !== workspaceId
        ) return false
        if (
          typeof recordPrefix === 'string' &&
          !String(item.recordKey).startsWith(recordPrefix)
        ) return false
        if (snapshotId !== undefined && item.id !== snapshotId) return false
        if (
          upperBound !== undefined &&
          (
            item.scheduleShard !== values[':scheduleShard'] ||
            typeof item.nextDeliveryAtRecordKey !== 'string' ||
            item.nextDeliveryAtRecordKey > upperBound
          )
        ) return false
        return true
      })
      const sortAttribute = command.input.IndexName === undefined
        ? 'recordKey'
        : 'nextDeliveryAtRecordKey'
      items.sort((left, right) =>
        String(left[sortAttribute]).localeCompare(String(right[sortAttribute]))
      )
      if (command.input.ScanIndexForward === false) items.reverse()
      const exclusiveStartIndex = command.input.ExclusiveStartKey === undefined
        ? -1
        : items.findIndex((item) =>
            keyOf(item) === keyOf(command.input.ExclusiveStartKey!)
          )
      const remainingItems = items.slice(exclusiveStartIndex + 1)
      const requestedLimit = command.input.Limit ?? Number.POSITIVE_INFINITY
      const pageLimit = Math.min(
        requestedLimit,
        queryPageSize ?? Number.POSITIVE_INFINITY,
      )
      const limitedItems = remainingItems.slice(0, pageLimit)
      const lastItem = limitedItems.at(-1)
      const naturalLastEvaluatedKey =
        lastItem !== undefined &&
          limitedItems.length < remainingItems.length
          ? {
              workspaceId: lastItem.workspaceId,
              recordKey: lastItem.recordKey,
              ...(command.input.IndexName === undefined
                ? {}
                : {
                    scheduleShard: lastItem.scheduleShard,
                    nextDeliveryAtRecordKey: lastItem.nextDeliveryAtRecordKey,
                  }),
            }
          : undefined
      const lastEvaluatedKey = queryLastEvaluatedKey ?? naturalLastEvaluatedKey
      queryLastEvaluatedKey = undefined
      return {
        Items: limitedItems,
        ...(lastEvaluatedKey === undefined ? {} : { LastEvaluatedKey: lastEvaluatedKey }),
      }
    }
    throw new Error('Unexpected DynamoDB command.')
  }
  return {
    client: { send } as unknown as DynamoDBDocumentClient,
    rows,
    commands,
    setQueryLastEvaluatedKey(value: Record<string, unknown>) {
      queryLastEvaluatedKey = value
    },
    setQueryPageSize(value: number) {
      queryPageSize = value
    },
    setNextTransactionError(error: unknown) {
      nextTransactionError = error
    },
  }
}

describe('Analytics metric engine', () => {
  test('computes all metrics from deterministic reopen/recomplete facts', () => {
    const completed = createWorkItem('completed', { assignedProjectId: 'project-2' })
    const active = createWorkItem('active', {
      statusCategory: 'started',
      workflowStatusId: 'status-started',
      dueDate: '2026/01/05',
      updatedAt: period.to,
    })
    const started = createAuditEvent(
      'event-started',
      completed,
      '2026-01-02T00:00:00.000Z',
      [{ field: 'statusCategory', before: 'unstarted', after: 'started' }],
    )
    const firstCompletion = createAuditEvent(
      'event-completed-1',
      completed,
      '2026-01-03T00:00:00.000Z',
      [{ field: 'statusCategory', before: 'started', after: 'completed' }],
    )
    const reopened = createAuditEvent(
      'event-reopened',
      completed,
      '2026-01-04T00:00:00.000Z',
      [{ field: 'statusCategory', before: 'completed', after: 'started' }],
    )
    const scopeChange = createAuditEvent(
      'event-scope',
      completed,
      '2026-01-05T00:00:00.000Z',
      [{ field: 'assignedProjectId', before: 'project-1', after: 'project-2' }],
    )
    const recompleted = createAuditEvent(
      'event-completed-2',
      completed,
      '2026-01-06T00:00:00.000Z',
      [{ field: 'statusCategory', before: 'started', after: 'completed' }],
    )
    const metrics = Object.keys(ANALYTICS_METRIC_DEFINITIONS) as Array<
      keyof typeof ANALYTICS_METRIC_DEFINITIONS
    >
    const snapshot = createTestAnalyticsSnapshot({
      workItems: [active, completed],
      events: [recompleted, started, scopeChange, firstCompletion, recompleted, reopened],
      query: createQuery(metrics.map((metric) => ({
        id: metric,
        title: metric,
        type: 'metric',
        metric,
        ...(metric === 'sla' ? { slaTargetHours: 200 } : {}),
      }))),
    })
    const values = Object.fromEntries(
      snapshot.widgets.map((widget) => [widget.metric, widget.value]),
    )

    expect(values).toEqual({
      throughput: 1,
      'cycle-time': 48,
      'lead-time': 120,
      wip: 1,
      overdue: 1,
      'scope-change': 1,
      velocity: 1,
      sla: 100,
    })
    expect(snapshot.generatedAt).toBe(period.to)
    expect(snapshot.queryHash).toHaveLength(64)
    expect(snapshot.permissionScopeHash).toHaveLength(64)
    expect(snapshot.evidenceCount).toBeGreaterThan(0)
  })

  test('does not invent a completion when immutable completion history is absent', () => {
    const item = createWorkItem('missing-history', {
      updatedAt: '2026-01-05T00:00:00.000Z',
    })
    const snapshot = createTestAnalyticsSnapshot({
      workItems: [item],
      events: [],
      query: createQuery([{
        id: 'throughput',
        title: 'Throughput',
        type: 'metric',
        metric: 'throughput',
      }]),
    })

    expect(snapshot.widgets[0]?.value).toBe(0)
    expect(snapshot.widgets[0]?.sampleSize).toBe(0)
    expect(snapshot.widgets[0]?.warnings).toHaveLength(1)
  })

  test('rejects conflicting duplicate event IDs while identical duplicates count once', () => {
    const item = createWorkItem('duplicate')
    const completion = createAuditEvent(
      'same-event',
      item,
      '2026-01-06T00:00:00.000Z',
      [{ field: 'statusCategory', before: 'started', after: 'completed' }],
    )
    const query = createQuery([{
      id: 'throughput',
      title: 'Throughput',
      type: 'metric',
      metric: 'throughput',
    }])
    expect(createTestAnalyticsSnapshot({
      workItems: [item],
      events: [completion, completion],
      query,
    }).widgets[0]?.value).toBe(1)

    const conflicting = {
      ...completion,
      changes: [{ field: 'statusCategory', before: 'unstarted', after: 'completed' }],
    }
    expect(() => createTestAnalyticsSnapshot({
      workItems: [item],
      events: [completion, conflicting],
      query,
    })).toThrow(AnalyticsError)

    const other = createWorkItem('other', { teamId: 'other-team' })
    const identityConflict = {
      ...completion,
      metadata: { teamId: other.teamId, issueId: other.id },
    }
    expect(() => createTestAnalyticsSnapshot({
      workItems: [item, other],
      events: [identityConflict],
      query,
    })).toThrow(AnalyticsError)

    const legacyRawIdForInaccessibleItem = {
      ...completion,
      entityId: item.id,
      entity: { type: 'work-item', id: item.id },
      metadata: { teamId: 'inaccessible-team', issueId: item.id },
    }
    expect(createTestAnalyticsSnapshot({
      workItems: [item],
      events: [legacyRawIdForInaccessibleItem],
      query,
    }).widgets[0]?.value).toBe(0)

    const mismatchedEntityType = {
      ...completion,
      entityType: 'project' as const,
    }
    expect(createTestAnalyticsSnapshot({
      workItems: [item],
      events: [mismatchedEntityType],
      query,
    }).widgets[0]?.value).toBe(0)
  })

  test('excludes redacted metric transitions instead of interpreting redaction markers', () => {
    const item = createWorkItem('redacted')
    const redacted = createAuditEvent(
      'redacted-completion',
      item,
      '2026-01-06T00:00:00.000Z',
      [{
        field: 'statusCategory',
        before: '[REDACTED]',
        after: '[REDACTED]',
        redacted: true,
      }],
    )
    const snapshot = createTestAnalyticsSnapshot({
      workItems: [item],
      events: [redacted],
      query: createQuery([{
        id: 'throughput',
        title: 'Throughput',
        type: 'metric',
        metric: 'throughput',
      }, {
        id: 'scope-change',
        title: 'Scope change',
        type: 'metric',
        metric: 'scope-change',
      }]),
    })
    expect(snapshot.widgets.map((widget) => widget.value)).toEqual([0, 0])
    expect(snapshot.widgets.every((widget) => widget.warnings.length > 0)).toBeTrue()
  })

  test('rewinds historical WIP calendar groups and handles slash due dates by timezone', () => {
    const completed = createWorkItem('historical-wip', {
      createdAt: '2025-12-31T00:00:00.000Z',
      updatedAt: '2026-01-02T01:00:00.000Z',
    })
    const events = [
      createAuditEvent(
        'start',
        completed,
        '2026-01-01T01:00:00.000Z',
        [{ field: 'statusCategory', before: 'unstarted', after: 'started' }],
      ),
      createAuditEvent(
        'complete',
        completed,
        '2026-01-02T01:00:00.000Z',
        [{ field: 'statusCategory', before: 'started', after: 'completed' }],
      ),
    ]
    const historical = createTestAnalyticsSnapshot({
      workItems: [completed],
      events,
      query: createQuery([{
        id: 'wip',
        title: 'WIP',
        type: 'metric',
        metric: 'wip',
        groupBy: { dimension: 'day' },
      }], {
        filter: {
          period: {
            from: '2026-01-01T00:00:00.000Z',
            to: '2026-01-02T23:59:59.999Z',
          },
        },
        asOf: '2026-01-02T23:59:59.999Z',
      }),
    })
    expect(historical.widgets[0]?.groups.map((group) => group.value)).toEqual([1, 0])

    const overdue = createWorkItem('slash-due', {
      statusCategory: 'unstarted',
      workflowStatusId: 'status-unstarted',
      dueDate: '2026/01/01',
      updatedAt: '2026-01-01T18:00:00.000Z',
    })
    const overdueWidget = [{
      id: 'overdue',
      title: 'Overdue',
      type: 'metric' as const,
      metric: 'overdue' as const,
    }]
    const asOf = '2026-01-01T18:00:00.000Z'
    const losAngeles = createTestAnalyticsSnapshot({
      workItems: [overdue],
      events: [],
      query: createQuery(overdueWidget, { asOf, timeZone: 'America/Los_Angeles' }),
    })
    const tokyo = createTestAnalyticsSnapshot({
      workItems: [overdue],
      events: [],
      query: createQuery(overdueWidget, { asOf, timeZone: 'Asia/Tokyo' }),
    })
    expect(losAngeles.widgets[0]?.value).toBe(0)
    expect(tokyo.widgets[0]?.value).toBe(1)
  })

  test('produces bounded ordered forecast percentiles without NaN', () => {
    const first = createWorkItem('forecast-1')
    const second = createWorkItem('forecast-2')
    const remaining = createWorkItem('forecast-remaining', {
      statusCategory: 'unstarted',
      workflowStatusId: 'status-unstarted',
    })
    const events = [
      createAuditEvent(
        'forecast-complete-1',
        first,
        '2026-01-03T00:00:00.000Z',
        [{ field: 'statusCategory', before: 'started', after: 'completed' }],
      ),
      createAuditEvent(
        'forecast-complete-2',
        second,
        '2026-01-05T00:00:00.000Z',
        [{ field: 'statusCategory', before: 'started', after: 'completed' }],
      ),
    ]
    const forecast = createTestAnalyticsSnapshot({
      workItems: [remaining, second, first],
      events,
      query: createQuery([]),
    }).forecast

    expect(forecast.sampleSize).toBe(2)
    expect(forecast.dailyThroughput).toBeGreaterThan(0)
    expect(forecast.confidence).toBeGreaterThanOrEqual(0)
    expect(forecast.confidence).toBeLessThanOrEqual(1)
    expect(Date.parse(forecast.p50!)).toBeLessThanOrEqual(Date.parse(forecast.p85!))
    expect(Date.parse(forecast.p85!)).toBeLessThanOrEqual(Date.parse(forecast.p95!))
    expect(JSON.stringify(forecast)).not.toContain('NaN')
  })

  test('binds evidence cursors to the complete query scope', () => {
    const first = createWorkItem('evidence-1')
    const second = createWorkItem('evidence-2')
    const events = [first, second].map((item, index) =>
      createAuditEvent(
        `completion-${index}`,
        item,
        `2026-01-0${index + 3}T00:00:00.000Z`,
        [{ field: 'statusCategory', before: 'started', after: 'completed' }],
      )
    )
    const page = queryTestAnalyticsEvidence({
      workItems: [first, second],
      events,
      evidence: {
        metric: 'throughput',
        filter: { period },
        asOf: period.to,
        timeZone: 'UTC',
        limit: 1,
      },
    })
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).toBeDefined()
    expect(() => queryTestAnalyticsEvidence({
      workItems: [first, second],
      events,
      evidence: {
        metric: 'throughput',
        filter: { period, teamIds: ['different'] },
        asOf: period.to,
        timeZone: 'UTC',
        cursor: page.nextCursor,
      },
    })).toThrow(AnalyticsError)

    expect(() => queryTestAnalyticsEvidence({
      workItems: [first],
      events: [events[0]!],
      evidence: {
        metric: 'throughput',
        filter: { period },
        asOf: period.to,
        timeZone: 'UTC',
        cursor: page.nextCursor,
      },
    })).toThrow(AnalyticsError)

    expect(() => queryTestAnalyticsEvidence({
      workItems: [first, second],
      events,
      evidence: {
        metric: 'throughput',
        filter: { period },
        asOf: period.to,
        timeZone: 'UTC',
        cursor: page.nextCursor,
      },
    }, new Set(['different-project']))).toThrow(AnalyticsError)
  })

  test('clips period end to as-of and ignores future-created items in permission scope', () => {
    const current = createWorkItem('current')
    const future = createWorkItem('future', {
      createdAt: '2026-01-08T00:00:00.000Z',
      updatedAt: '2026-01-08T00:00:00.000Z',
    })
    const query = createQuery([], {
      filter: {
        period: {
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-01-07T23:59:59.999Z',
        },
      },
      asOf: '2026-01-07T12:34:56.000Z',
    })
    const withoutFuture = createTestAnalyticsSnapshot({
      workItems: [current],
      events: [],
      query,
    })
    const withFuture = createTestAnalyticsSnapshot({
      workItems: [future, current],
      events: [],
      query,
    })

    expect(withFuture.filter.period.to).toBe(query.asOf)
    expect(withFuture.queryHash).toBe(withoutFuture.queryHash)
    expect(withFuture.permissionScopeHash).toBe(withoutFuture.permissionScopeHash)
  })

  test('normalizes velocity and forecast by local calendar days across DST', () => {
    const springFirst = createWorkItem('spring-1', {
      createdAt: '2026-03-01T00:00:00.000Z',
    })
    const springSecond = createWorkItem('spring-2', {
      createdAt: '2026-03-01T00:00:00.000Z',
    })
    const springPeriod = {
      from: '2026-03-05T05:00:00.000Z',
      to: '2026-03-12T03:59:59.999Z',
    }
    const springEvents = [
      createAuditEvent(
        'spring-complete-1',
        springFirst,
        '2026-03-06T12:00:00.000Z',
        [{ field: 'statusCategory', before: 'started', after: 'completed' }],
      ),
      createAuditEvent(
        'spring-complete-2',
        springSecond,
        '2026-03-10T12:00:00.000Z',
        [{ field: 'statusCategory', before: 'started', after: 'completed' }],
      ),
    ]
    const spring = createTestAnalyticsSnapshot({
      workItems: [springFirst, springSecond],
      events: springEvents,
      query: createQuery([{
        id: 'velocity',
        title: 'Velocity',
        type: 'metric',
        metric: 'velocity',
      }], {
        filter: { period: springPeriod },
        asOf: springPeriod.to,
        timeZone: 'America/New_York',
      }),
    })
    expect(spring.widgets[0]?.value).toBe(2)
    expect(spring.forecast.dailyThroughput).toBe(0.286)

    const fallPeriod = {
      from: '2026-10-29T04:00:00.000Z',
      to: '2026-11-05T04:59:59.999Z',
    }
    const fall = createTestAnalyticsSnapshot({
      workItems: [springFirst, springSecond],
      events: [
        createAuditEvent(
          'fall-complete-1',
          springFirst,
          '2026-10-30T12:00:00.000Z',
          [{ field: 'statusCategory', before: 'started', after: 'completed' }],
        ),
        createAuditEvent(
          'fall-complete-2',
          springSecond,
          '2026-11-03T12:00:00.000Z',
          [{ field: 'statusCategory', before: 'started', after: 'completed' }],
        ),
      ],
      query: createQuery([{
        id: 'velocity',
        title: 'Velocity',
        type: 'metric',
        metric: 'velocity',
      }], {
        filter: { period: fallPeriod },
        asOf: fallPeriod.to,
        timeZone: 'America/New_York',
      }),
    })
    expect(fall.widgets[0]?.value).toBe(2)
    expect(fall.forecast.dailyThroughput).toBe(0.286)
  })

  test('keeps custom-field group keys type-safe and array-order independent', () => {
    const values: CanonicalWorkItem['customFieldValues'][] = [
      { estimate: 1 },
      { estimate: '1' },
      { estimate: ['a,b', 'c'] },
      { estimate: ['a', 'b,c'] },
      { estimate: ['c', 'a,b'] },
    ]
    const workItems = values.map((customFieldValues, index) =>
      createWorkItem(`group-${index}`, {
        statusCategory: 'started',
        workflowStatusId: 'status-started',
        customFieldValues,
      })
    )
    const groups = createTestAnalyticsSnapshot({
      workItems,
      events: [],
      query: createQuery([{
        id: 'grouped-wip',
        title: 'Grouped WIP',
        type: 'metric',
        metric: 'wip',
        groupBy: { dimension: 'custom-field', customFieldId: 'estimate' },
      }]),
    }).widgets[0]!.groups

    expect(groups).toHaveLength(4)
    expect(new Set(groups.map((group) => group.key)).size).toBe(4)
    expect(groups.some((group) => group.sampleSize === 2)).toBeTrue()
  })

  test('returns dimension groups instead of calendar series for non-calendar charts', () => {
    const workItems = [
      createWorkItem('project-a', {
        assignedProjectId: 'project-a',
        statusCategory: 'started',
        workflowStatusId: 'status-started',
      }),
      createWorkItem('project-b', {
        assignedProjectId: 'project-b',
        statusCategory: 'started',
        workflowStatusId: 'status-started',
      }),
    ]
    const result = createTestAnalyticsSnapshot({
      workItems,
      events: [],
      query: createQuery([{
        id: 'wip-by-project',
        title: 'WIP by Project',
        type: 'chart',
        metric: 'wip',
        groupBy: { dimension: 'project' },
      }]),
    }).widgets[0]!

    expect(result.series).toEqual([])
    expect(result.groups.map((group) => group.key)).toEqual(['project-a', 'project-b'])
  })

  test('rewinds a custom-field removal that also contains an empty container marker', () => {
    const item = createWorkItem('custom-field-removal', {
      statusCategory: 'started',
      workflowStatusId: 'status-started',
      customFieldValues: {},
    })
    const removal = createAuditEvent(
      'remove-custom-field',
      item,
      '2026-01-06T00:00:00.000Z',
      [{
        field: 'customFieldValues',
        after: {},
      }, {
        field: 'customFieldValues.segment',
        before: 'enterprise',
      }],
    )
    const snapshot = createTestAnalyticsSnapshot({
      workItems: [item],
      events: [removal],
      query: createQuery([{
        id: 'historical-custom-field',
        title: 'Historical custom field',
        type: 'metric',
        metric: 'wip',
        groupBy: { dimension: 'custom-field', customFieldId: 'segment' },
      }], {
        filter: {
          period: {
            from: '2026-01-01T00:00:00.000Z',
            to: '2026-01-05T23:59:59.999Z',
          },
          customFields: [{
            fieldId: 'segment',
            operator: 'equals',
            value: 'enterprise',
          }],
        },
        asOf: '2026-01-05T23:59:59.999Z',
      }),
    })

    expect(snapshot.widgets[0]?.value).toBe(1)
    expect(snapshot.widgets[0]?.groups.map((group) => group.label)).toEqual(['enterprise'])
  })

  test('requires an explicit UTC designator or offset for every instant', () => {
    expect(() => createTestAnalyticsSnapshot({
      workItems: [],
      events: [],
      query: createQuery([], {
        asOf: '2026-01-07T00:00:00',
      }),
    })).toThrow(AnalyticsError)

    const snapshot = createTestAnalyticsSnapshot({
      workItems: [],
      events: [],
      query: createQuery([], {
        asOf: '2026-01-07T09:00:00+09:00',
      }),
    })
    expect(snapshot.asOf).toBe('2026-01-07T00:00:00.000Z')
  })

  test('forecasts empirical completion days in the report local calendar', () => {
    const first = createWorkItem('dst-forecast-1')
    const second = createWorkItem('dst-forecast-2')
    const remaining = createWorkItem('dst-forecast-remaining', {
      statusCategory: 'unstarted',
      workflowStatusId: 'status-unstarted',
    })
    const forecast = createTestAnalyticsSnapshot({
      workItems: [first, second, remaining],
      events: [
        createAuditEvent(
          'dst-forecast-complete-1',
          first,
          '2026-03-05T12:00:00.000Z',
          [{ field: 'statusCategory', before: 'started', after: 'completed' }],
        ),
        createAuditEvent(
          'dst-forecast-complete-2',
          second,
          '2026-03-06T12:00:00.000Z',
          [{ field: 'statusCategory', before: 'started', after: 'completed' }],
        ),
      ],
      query: createQuery([], {
        filter: {
          period: {
            from: '2026-03-05T05:00:00.000Z',
            to: '2026-03-07T14:00:00.000Z',
          },
        },
        asOf: '2026-03-07T14:00:00.000Z',
        timeZone: 'America/New_York',
      }),
    }).forecast

    expect(forecast.dailyThroughput).toBe(0.667)
    expect(forecast.p50).toBe('2026-03-08T13:00:00.000Z')
    expect(forecast.p85).toBe('2026-03-09T13:00:00.000Z')
    expect(forecast.p95).toBe('2026-03-09T13:00:00.000Z')
  })

  test('excludes facts and evidence whose as-of Project is outside the current allowlist', () => {
    const item = createWorkItem('cross-project-history', {
      assignedProjectId: 'project-a',
      statusCategory: 'started',
      workflowStatusId: 'status-started',
      updatedAt: '2026-01-06T00:00:00.000Z',
    })
    const moved = createAuditEvent(
      'cross-project-move',
      item,
      '2026-01-06T00:00:00.000Z',
      [{
        field: 'assignedProjectId',
        before: 'project-b',
        after: 'project-a',
      }],
    )
    const asOf = '2026-01-05T23:59:59.999Z'
    const filter = {
      period: {
        from: period.from,
        to: asOf,
      },
    }
    const widgets = [{
      id: 'historical-wip',
      title: 'Historical WIP',
      type: 'metric' as const,
      metric: 'wip' as const,
      groupBy: { dimension: 'project' as const },
    }]
    const hidden = createTestAnalyticsSnapshot({
      workItems: [item],
      events: [moved],
      query: createQuery(widgets, { asOf, filter }),
    }, new Set(['project-a']))
    const hiddenEvidence = queryTestAnalyticsEvidence({
      workItems: [item],
      events: [moved],
      evidence: {
        metric: 'wip',
        filter,
        asOf,
        timeZone: 'UTC',
      },
    }, new Set(['project-a']))
    const visible = createTestAnalyticsSnapshot({
      workItems: [item],
      events: [moved],
      query: createQuery(widgets, { asOf, filter }),
    }, new Set(['project-b']))

    expect(hidden.widgets[0]?.value).toBe(0)
    expect(hidden.widgets[0]?.groups).toEqual([])
    expect(hidden.evidenceCount).toBe(0)
    expect(hiddenEvidence.items).toEqual([])
    expect(visible.widgets[0]?.value).toBe(1)
    expect(visible.widgets[0]?.groups.map((group) => group.key)).toEqual(['project-b'])
  })

  test('reapplies the Project allowlist to historical chart and calendar-group buckets', () => {
    const item = createWorkItem('bucket-project-scope', {
      assignedProjectId: 'project-a',
      statusCategory: 'started',
      workflowStatusId: 'status-started',
    })
    const moved = createAuditEvent(
      'bucket-project-move',
      item,
      '2026-01-06T00:00:00.000Z',
      [{
        field: 'assignedProjectId',
        before: 'project-b',
        after: 'project-a',
      }],
    )
    const snapshot = createTestAnalyticsSnapshot({
      workItems: [item],
      events: [moved],
      query: createQuery([{
        id: 'historical-wip-chart',
        title: 'Historical WIP',
        type: 'chart',
        metric: 'wip',
        groupBy: { dimension: 'day' },
      }]),
    }, new Set(['project-a']))

    expect(snapshot.widgets[0]?.series.map((point) => point.value)).toEqual([
      0,
      0,
      0,
      0,
      0,
      1,
      1,
    ])
    expect(snapshot.widgets[0]?.groups.map((group) => group.value)).toEqual([
      0,
      0,
      0,
      0,
      0,
      1,
      1,
    ])
  })

  test('binds permission scope hashes to the complete current Project allowlist', () => {
    const item = createWorkItem('permission-scope', {
      assignedProjectId: 'project-a',
    })
    const asOf = Date.parse(period.to)
    const first = createAnalyticsPermissionScopeHash(
      [item],
      asOf,
      new Set(['project-b', 'project-a']),
    )
    const reordered = createAnalyticsPermissionScopeHash(
      [item],
      asOf,
      new Set(['project-a', 'project-b']),
    )
    const accessChanged = createAnalyticsPermissionScopeHash(
      [item],
      asOf,
      new Set(['project-b']),
    )
    const snapshot = createTestAnalyticsSnapshot({
      workItems: [item],
      events: [],
      query: createQuery([]),
    }, new Set(['project-b', 'project-a']))

    expect(first).toBe(reordered)
    expect(first).not.toBe(accessChanged)
    expect(snapshot.permissionScopeHash).toBe(first)
  })
})

describe('Analytics export', () => {
  test('exports fixed table columns formula-safely and localizes supported labels', () => {
    const item = createWorkItem('@export', {
      assignedProjectId: '=cmd',
      title: '+SUM(1,1)',
    })
    const completion = createAuditEvent(
      'export-completed',
      item,
      '2026-01-05T00:00:00.000Z',
      [{ field: 'statusCategory', before: 'started', after: 'completed' }],
    )
    const snapshot = createTestAnalyticsSnapshot({
      workItems: [item],
      events: [completion],
      query: createQuery([{
        id: 'throughput',
        title: 'Throughput',
        type: 'table',
        metric: 'throughput',
        groupBy: { dimension: 'project' },
      }]),
    })
    const csv = createAnalyticsCsv(snapshot)
    const japaneseCsv = createAnalyticsCsv(snapshot, 'ja-JP')
    const fallbackCsv = createAnalyticsCsv(snapshot, 'fr-FR')

    expect(csv).toContain("'=cmd")
    expect(csv).toContain("'+SUM(1,1)")
    expect(csv).toContain("'@export")
    expect(csv).toContain('Table row')
    expect(csv.split('\r\n')[0]).toBe(
      'Widget ID,Metric key,Metric,Value,Sample size,Record type,Dimension value,' +
      'Period from,Period to,Row ID,Row label,Team ID,Work Item ID,Project ID,Occurred at',
    )
    expect(japaneseCsv.split('\r\n')[0]).toBe(
      'ウィジェットID,指標キー,指標,値,サンプル数,レコード種別,ディメンション値,' +
      '期間開始,期間終了,行ID,行ラベル,チームID,作業項目ID,プロジェクトID,発生日時',
    )
    expect(japaneseCsv).toContain('スループット')
    expect(japaneseCsv).toContain('テーブル行')
    expect(fallbackCsv.split('\r\n')[0]).toBe(csv.split('\r\n')[0])
    expect(normalizeAnalyticsExportLocale('JA_jp')).toBe('ja')
    expect(normalizeAnalyticsExportLocale('en-US')).toBe('en')
    expect(normalizeAnalyticsExportLocale('unsupported')).toBe('en')
  })

  test('creates localized, structurally complete PDFs with automatic pagination', async () => {
    const paginatedSnapshot = createTestAnalyticsSnapshot({
      workItems: [],
      events: [],
      query: createQuery(Array.from({ length: 50 }, (_, index) => ({
        id: `throughput-${index}`,
        title: `Throughput ${index}`,
        type: 'metric',
        metric: 'throughput',
      }))),
    })
    const localizedSnapshot = createTestAnalyticsSnapshot({
      workItems: [],
      events: [],
      query: createQuery(([
        'throughput',
        'cycle-time',
        'lead-time',
        'wip',
        'overdue',
        'scope-change',
        'velocity',
        'sla',
      ] as const).map((metric) => ({
        id: metric,
        title: metric,
        type: 'metric',
        metric,
      }))),
    })
    const pdf = Buffer.from(createAnalyticsPdf(paginatedSnapshot)).toString('latin1')
    const japanesePdfBytes = createAnalyticsPdf(localizedSnapshot, 'ja')
    const japanesePdf = Buffer.from(japanesePdfBytes).toString('latin1')

    expect(pdf.startsWith('%PDF-1.4')).toBeTrue()
    expect(pdf).toContain('/Lang (en-US)')
    expect(pdf).toContain('/Count 2')
    expect(pdf.match(/\/Type \/Page /gu)).toHaveLength(2)
    expect(pdf).toContain('\nxref\n')
    expect(pdf.endsWith('%%EOF\n')).toBeTrue()
    expect(japanesePdf).toContain('/Lang (ja-JP)')
    expect(japanesePdf).toContain('/Encoding /Identity-H')
    expect(japanesePdf).toContain('/FontFile2 ')
    expect(japanesePdf).toContain('/CIDToGIDMap /Identity')
    expect(japanesePdf).toContain('/ToUnicode ')
    expect(japanesePdf).toContain('<007C> <57FA>')
    expect(japanesePdf).toContain('/FontName /JYQTAR+NotoSansJP-Thin')
    expect(japanesePdf.match(/\/BaseFont \/JYQTAR\+NotoSansJP-Thin/gu)).toHaveLength(2)

    const japaneseLoadingTask = getDocument({
      data: japanesePdfBytes,
    })
    const japaneseDocument = await japaneseLoadingTask.promise
    const extractedPages = await Promise.all(
      Array.from({ length: japaneseDocument.numPages }, async (_, index) => {
        const page = await japaneseDocument.getPage(index + 1)
        const content = await page.getTextContent()
        return content.items
          .flatMap((item) => 'str' in item ? [item.str] : [])
          .join(' ')
      }),
    )
    const extractedText = extractedPages.join(' ')
    const expectedRenderedLabels = [
      '基準日時',
      'タイムゾーン',
      'スループット',
      'サイクルタイム',
      'リードタイム',
      '進行中',
      '期限超過',
      'スコープ変更',
      'ベロシティ',
      'SLA達成率',
      '件',
      '時間',
      '件/週',
      '予測 P85',
      'リスク',
      '不明',
      '利用不可',
    ]
    for (const expectedLabel of expectedRenderedLabels) {
      expect(extractedText).toContain(expectedLabel)
    }
    const everyJapaneseLabel = [
      ...expectedRenderedLabels,
      '低',
      '中',
      '高',
    ]
    const requiredJapaneseCharacters = new Set(
      everyJapaneseLabel
        .flatMap((label) => [...label])
        .filter((character) => character.codePointAt(0)! > 0x7E),
    )
    for (const character of requiredJapaneseCharacters) {
      expect(analyticsPdfFont.japaneseGlyphs).toContain(character)
    }
    await japaneseLoadingTask.destroy()
  })
})

describe('Analytics scheduling', () => {
  test('distributes reports deterministically across schedule partitions', () => {
    const reportIds = Array.from({ length: 128 }, (_, index) => `report-${index}`)
    const shards = reportIds.map((reportId) =>
      createAnalyticsScheduleShard('workspace-1', reportId)
    )

    expect(new Set(shards).size).toBeGreaterThan(8)
    expect(shards.every((shard) => /^schedule-(?:0\d|1[0-5])$/u.test(shard)))
      .toBeTrue()
    expect(reportIds.map((reportId) =>
      createAnalyticsScheduleShard('workspace-1', reportId)
    )).toEqual(shards)
  })

  test('resolves DST gaps/folds and clamps monthly schedules to short months', () => {
    const daily = {
      enabled: true,
      frequency: 'daily' as const,
      timeZone: 'America/New_York',
      localTime: '02:30',
      recipientMemberKeys: ['member-1'],
      format: 'pdf' as const,
    }
    expect(calculateAnalyticsNextRunAt(
      daily,
      '2026-03-07T08:00:00.000Z',
    )).toBe('2026-03-08T07:00:00.000Z')
    expect(calculateAnalyticsNextRunAt(
      { ...daily, localTime: '01:30' },
      '2026-11-01T05:45:00.000Z',
    )).toBe('2026-11-01T06:30:00.000Z')
    const firstFoldOccurrence = calculateAnalyticsNextRunAt(
      { ...daily, localTime: '01:30' },
      '2026-11-01T04:00:00.000Z',
    )
    expect(firstFoldOccurrence).toBe('2026-11-01T05:30:00.000Z')
    expect(calculateAnalyticsNextRunAt(
      { ...daily, localTime: '01:30' },
      firstFoldOccurrence,
    )).toBe('2026-11-02T06:30:00.000Z')
    expect(calculateAnalyticsNextRunAt({
      enabled: true,
      frequency: 'monthly',
      timeZone: 'UTC',
      localTime: '09:00',
      dayOfMonth: 31,
      recipientMemberKeys: ['member-1'],
      format: 'csv',
    }, '2026-01-31T10:00:00.000Z')).toBe('2026-02-28T09:00:00.000Z')
  })
})

describe('Analytics repository', () => {
  test('requires route-safe report IDs at the repository boundary', async () => {
    const repository = new InMemoryAnalyticsRepository()
    for (const id of [
      '/report',
      'report/path',
      'report path',
      '..',
      'report%2Fpath',
      `r${'x'.repeat(128)}`,
    ]) {
      await expect(repository.createReport(
        'workspace-1',
        'member-1',
        createReportInput({ id }),
      )).rejects.toMatchObject({ code: 'AnalyticsReportIdInvalid' })
    }
    const created = await repository.createReport(
      'workspace-1',
      'member-1',
      createReportInput({ id: 'Report_1-safe' }),
    )
    expect(created.id).toBe('Report_1-safe')
  })

  test('enforces report revisions and immutable snapshot payloads', async () => {
    const repository = new InMemoryAnalyticsRepository(
      () => new Date('2026-01-08T00:00:00.000Z'),
    )
    const report = await repository.createReport(
      'workspace-1',
      'member-1',
      createReportInput({
        forecastBaseline: {
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-01-10T00:00:00.000Z',
        },
      }),
    )
    const updated = await repository.updateReport('workspace-1', report.id, {
      expectedRevision: 1,
      name: 'Updated',
      forecastBaseline: {
        from: '2026-01-02T00:00:00.000Z',
        to: '2026-01-11T00:00:00.000Z',
      },
    })
    expect(updated.revision).toBe(2)
    expect(updated.forecastBaseline?.from).toBe('2026-01-02T00:00:00.000Z')
    await expect(repository.updateReport('workspace-1', report.id, {
      expectedRevision: 1,
      name: 'Stale',
    })).rejects.toMatchObject({ code: 'AnalyticsRevisionConflict' })

    const query = createQuery(createReportInput().widgets)
    const snapshot = createTestAnalyticsSnapshot({ workItems: [], events: [], query })
    const record: AnalyticsSnapshotRecord = {
      id: 'snapshot-1',
      workspaceId: 'workspace-1',
      reportId: report.id,
      reportRevision: updated.revision,
      createdByMemberKey: 'member-1',
      createdAt: '2026-01-08T00:00:00.000Z',
      query,
      snapshot,
    }
    await repository.putSnapshot(record)
    const retried = await repository.putSnapshot({
      ...record,
      createdAt: '2026-01-08T00:00:01.000Z',
    })
    expect(retried.createdAt).toBe(record.createdAt)
    expect(await repository.listSnapshots('workspace-1', report.id)).toEqual([record])
    await expect(repository.putSnapshot({
      ...record,
      createdByMemberKey: 'different-member',
    })).rejects.toMatchObject({ code: 'AnalyticsSnapshotConflict' })
    await expect(repository.putSnapshot({
      ...record,
      id: 'snapshot-query-mismatch',
      snapshot: {
        ...snapshot,
        filter: {
          ...snapshot.filter,
          teamIds: ['different-team'],
        },
      },
    })).rejects.toMatchObject({ code: 'AnalyticsSnapshotQueryMismatch' })
  })

  test('orders due schedules and stores occurrence receipts idempotently', async () => {
    const repository = new InMemoryAnalyticsRepository(
      () => new Date('2026-01-08T00:00:00.000Z'),
    )
    await repository.createReport('workspace-1', 'member-1', createReportInput({
      id: 'later-0',
      schedule: {
        enabled: true,
        frequency: 'daily',
        timeZone: 'UTC',
        localTime: '09:00',
        recipientMemberKeys: ['member-1'],
        format: 'pdf',
      },
    }))
    await repository.createReport('workspace-1', 'member-1', createReportInput({
      id: 'earlier-22',
      schedule: {
        enabled: true,
        frequency: 'daily',
        timeZone: 'UTC',
        localTime: '09:00',
        recipientMemberKeys: ['member-1'],
        format: 'pdf',
        nextRunAt: '2026-01-08T08:00:00.000Z',
      },
    }))
    const scheduleShard = createAnalyticsScheduleShard('workspace-1', 'later-0')
    expect(scheduleShard).toBe(
      createAnalyticsScheduleShard('workspace-1', 'earlier-22'),
    )
    const due = await repository.listDueReports(
      scheduleShard,
      '2026-01-08T09:00:00.000Z',
      10,
    )
    expect(due.reports.map((report) => report.id)).toEqual([
      'earlier-22',
      'later-0',
    ])

    const receipt = {
      workspaceId: 'workspace-1',
      reportId: 'earlier-22',
      occurrenceKey: '2026-01-08T08:00:00.000Z',
      reportRevision: 1,
      format: 'pdf' as const,
      snapshotId: 'snapshot-1',
      recipientMemberKeys: ['member-1'],
      createdAt: '2026-01-08T08:00:01.000Z',
    }
    expect((await repository.putDeliveryReceipt(receipt)).created).toBeTrue()
    const retried = await repository.putDeliveryReceipt({
      ...receipt,
      createdAt: '2026-01-08T08:00:02.000Z',
    })
    expect(retried.created).toBeFalse()
    expect(retried.receipt.createdAt).toBe(receipt.createdAt)
    await expect(repository.putDeliveryReceipt({
      ...receipt,
      snapshotId: 'different',
    })).rejects.toMatchObject({ code: 'AnalyticsDeliveryConflict' })
  })

  test('continues due pages by key when processed reports leave the due set', async () => {
    const repository = new InMemoryAnalyticsRepository(
      () => new Date('2026-01-08T00:00:00.000Z'),
    )
    const reportIds = ['candidate-5', 'candidate-6', 'candidate-8']
    const scheduleShard = createAnalyticsScheduleShard('workspace-1', reportIds[0]!)
    expect(reportIds.every((reportId) =>
      createAnalyticsScheduleShard('workspace-1', reportId) === scheduleShard
    )).toBeTrue()
    for (const id of reportIds) {
      await repository.createReport('workspace-1', 'member-1', createReportInput({
        id,
        schedule: {
          enabled: true,
          frequency: 'daily',
          timeZone: 'UTC',
          localTime: '08:00',
          recipientMemberKeys: ['member-1'],
          format: 'pdf',
          nextRunAt: '2026-01-08T08:00:00.000Z',
        },
      }))
    }

    const firstPage = await repository.listDueReports(
      scheduleShard,
      '2026-01-08T09:00:00.000Z',
      2,
    )
    expect(firstPage.reports.map((report) => report.id)).toEqual(reportIds.slice(0, 2))
    expect(firstPage.nextCursor).toBeDefined()
    for (const report of firstPage.reports) {
      await repository.updateReport(report.workspaceId, report.id, {
        expectedRevision: report.revision,
        schedule: {
          ...report.schedule!,
          localTime: '10:00',
        },
      })
    }

    const secondPage = await repository.listDueReports(
      scheduleShard,
      '2026-01-08T09:00:00.000Z',
      2,
      firstPage.nextCursor,
    )
    expect(secondPage.reports.map((report) => report.id)).toEqual([reportIds[2]])
    expect(secondPage.nextCursor).toBeUndefined()
  })

  test('accepts generated due cursors containing long valid Workspace IDs', async () => {
    const workspaceId = `workspace-${'w'.repeat(390)}`
    const reportIdsByShard = new Map<string, string[]>()
    for (let index = 0; index < 100; index += 1) {
      const reportId = `long-cursor-report-${index}`
      const shard = createAnalyticsScheduleShard(workspaceId, reportId)
      const reportIds = reportIdsByShard.get(shard) ?? []
      reportIds.push(reportId)
      reportIdsByShard.set(shard, reportIds)
    }
    const entry = [...reportIdsByShard.entries()].find(([, reportIds]) =>
      reportIds.length >= 2
    )
    expect(entry).toBeDefined()
    const [scheduleShard, reportIds] = entry!
    const selectedReportIds = reportIds.slice(0, 2).sort()
    const repository = new InMemoryAnalyticsRepository(
      () => new Date('2026-01-08T00:00:00.000Z'),
    )
    for (const id of selectedReportIds) {
      await repository.createReport(workspaceId, 'member-1', createReportInput({
        id,
        schedule: {
          enabled: true,
          frequency: 'daily',
          timeZone: 'UTC',
          localTime: '08:00',
          recipientMemberKeys: ['member-1'],
          format: 'pdf',
          nextRunAt: '2026-01-08T08:00:00.000Z',
        },
      }))
    }

    const firstPage = await repository.listDueReports(
      scheduleShard,
      '2026-01-08T09:00:00.000Z',
      1,
    )
    expect(firstPage.nextCursor?.length).toBeGreaterThan(512)
    const secondPage = await repository.listDueReports(
      scheduleShard,
      '2026-01-08T09:00:00.000Z',
      1,
      firstPage.nextCursor,
    )

    expect(secondPage.reports.map((report) => report.id)).toEqual(
      selectedReportIds.slice(1),
    )
  })

  test('limits snapshot history in the DynamoDB query before deserializing payloads', async () => {
    const query = createQuery(createReportInput().widgets)
    const snapshot = createTestAnalyticsSnapshot({ workItems: [], events: [], query })
    const records = Array.from({ length: 101 }, (_, index) => ({
      id: `snapshot-${String(index).padStart(3, '0')}`,
      workspaceId: 'workspace-1',
      reportId: 'report-1',
      reportRevision: 1,
      createdByMemberKey: 'member-1',
      createdAt: new Date(Date.UTC(2026, 0, 8, 9, 0, index)).toISOString(),
      query,
      snapshot,
    } satisfies AnalyticsSnapshotRecord))
    const memory = new InMemoryAnalyticsRepository()
    const fake = createDynamoDocumentClient()
    const dynamo = new DynamoDbAnalyticsRepository('analytics-table', fake.client)
    for (const record of records) {
      await memory.putSnapshot(record)
      await dynamo.putSnapshot(record)
    }

    const expectedIds = records.slice(1).reverse().map((record) => record.id)
    fake.setQueryPageSize(17)
    expect((await memory.listSnapshots('workspace-1', 'report-1'))
      .map((record) => record.id)).toEqual(expectedIds)
    expect((await dynamo.listSnapshots('workspace-1', 'report-1'))
      .map((record) => record.id)).toEqual(expectedIds)
    const snapshotQueries = fake.commands.filter((command) =>
      command instanceof QueryCommand &&
      command.input.ExpressionAttributeValues?.[':recordPrefix'] ===
        'SNAPSHOT#report-1#'
    ) as QueryCommand[]
    expect(snapshotQueries.map((command) => command.input.Limit))
      .toEqual([100, 83, 66, 49, 32, 15])
    expect(snapshotQueries.every((command) =>
      command.input.ConsistentRead === true &&
      command.input.ScanIndexForward === false
    )).toBeTrue()
    expect(snapshotQueries[0]?.input.ExpressionAttributeValues?.[':recordPrefix'])
      .toBe('SNAPSHOT#report-1#')
    const latestClaim = [...fake.rows.values()].find((row) =>
      row.entryType === 'analytics-snapshot-id' &&
      row.snapshotId === 'snapshot-100'
    )
    expect(latestClaim?.snapshotRecordKey).toBe(
      'SNAPSHOT#report-1#2026-01-08T09:01:40.000Z#snapshot-100',
    )
  })

  test('uses DynamoDB CAS, due GSI cursors, and first-write-wins immutable rows', async () => {
    const fake = createDynamoDocumentClient()
    const repository = new DynamoDbAnalyticsRepository(
      'analytics-table',
      fake.client,
      { now: () => new Date('2026-01-08T00:00:00.000Z') },
    )
    const report = await repository.createReport(
      'workspace-1',
      'member-1',
      createReportInput({
        schedule: {
          enabled: true,
          frequency: 'daily',
          timeZone: 'UTC',
          localTime: '09:00',
          recipientMemberKeys: ['member-1'],
          format: 'pdf',
        },
      }),
    )
    const reportRow = [...fake.rows.values()].find(
      (row) => row.entryType === 'analytics-report',
    )!
    const scheduleShard = createAnalyticsScheduleShard(report.workspaceId, report.id)
    expect(reportRow.scheduleShard).toBe(scheduleShard)
    expect(reportRow.nextDeliveryAtRecordKey).toBe(
      '2026-01-08T09:00:00.000Z#workspace-1#report-1',
    )
    const createPut = fake.commands.find((command) => command instanceof PutCommand) as PutCommand
    expect(createPut.input.ConditionExpression).toContain('attribute_not_exists')

    const updated = await repository.updateReport('workspace-1', report.id, {
      expectedRevision: 1,
      name: 'Dynamo updated',
    })
    expect(updated.revision).toBe(2)
    const updatePut = [...fake.commands]
      .reverse()
      .find((command) => command instanceof PutCommand) as PutCommand
    expect(updatePut.input.ConditionExpression).toBe('#revision = :expectedRevision')
    await expect(repository.updateReport('workspace-1', report.id, {
      expectedRevision: 1,
      name: 'Stale',
    })).rejects.toMatchObject({ code: 'AnalyticsRevisionConflict' })

    fake.setQueryLastEvaluatedKey({
      workspaceId: 'workspace-1',
      recordKey: 'REPORT#report-1',
      scheduleShard,
      nextDeliveryAtRecordKey: reportRow.nextDeliveryAtRecordKey,
    })
    const firstDuePage = await repository.listDueReports(
      scheduleShard,
      '2026-01-08T09:00:00.000Z',
      1,
    )
    expect(firstDuePage.nextCursor).toBeDefined()
    const firstDueQuery = [...fake.commands]
      .reverse()
      .find((command) => command instanceof QueryCommand) as QueryCommand
    expect(firstDueQuery.input.IndexName).toBe('ScheduleDueIndex')
    expect(firstDueQuery.input.ExpressionAttributeValues?.[':upperBound']).toBe(
      '2026-01-08T09:00:00.000Z#\u{10FFFF}',
    )
    await repository.listDueReports(
      scheduleShard,
      '2026-01-08T09:00:00.000Z',
      1,
      firstDuePage.nextCursor,
    )
    const continuedQuery = [...fake.commands]
      .reverse()
      .find((command) => command instanceof QueryCommand) as QueryCommand
    expect(continuedQuery.input.ExclusiveStartKey?.recordKey).toBe('REPORT#report-1')

    const query = createQuery(report.widgets)
    const snapshot = createTestAnalyticsSnapshot({ workItems: [], events: [], query })
    const record: AnalyticsSnapshotRecord = {
      id: 'dynamo-snapshot',
      workspaceId: 'workspace-1',
      reportId: report.id,
      reportRevision: updated.revision,
      createdByMemberKey: 'member-1',
      createdAt: '2026-01-08T09:00:00.000Z',
      query,
      snapshot,
    }
    await repository.putSnapshot(record)
    const snapshotRetry = await repository.putSnapshot({
      ...record,
      createdAt: '2026-01-08T09:00:01.000Z',
    })
    expect(snapshotRetry.createdAt).toBe(record.createdAt)
    expect(await repository.listSnapshots('workspace-1', report.id)).toEqual([record])

    const receipt = {
      workspaceId: 'workspace-1',
      reportId: report.id,
      occurrenceKey: '2026-01-08T09:00:00.000Z',
      reportRevision: updated.revision,
      format: 'pdf' as const,
      snapshotId: record.id,
      recipientMemberKeys: ['member-1'],
      createdAt: '2026-01-08T09:00:02.000Z',
    }
    await repository.putDeliveryReceipt(receipt)
    const receiptRetry = await repository.putDeliveryReceipt({
      ...receipt,
      createdAt: '2026-01-08T09:00:03.000Z',
    })
    expect(receiptRetry.created).toBeFalse()
    expect(receiptRetry.receipt.createdAt).toBe(receipt.createdAt)
  })

  test('does not misclassify operational transaction cancellations as snapshot conflicts', async () => {
    const fake = createDynamoDocumentClient()
    const repository = new DynamoDbAnalyticsRepository('analytics-table', fake.client)
    const query = createQuery([])
    const snapshot = createTestAnalyticsSnapshot({ workItems: [], events: [], query })
    const record: AnalyticsSnapshotRecord = {
      id: 'operational-cancellation',
      workspaceId: 'workspace-1',
      createdByMemberKey: 'member-1',
      createdAt: '2026-01-08T09:00:00.000Z',
      query,
      snapshot,
    }
    for (const error of [
      Object.assign(new Error('transaction conflict'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'TransactionConflict' }],
      }),
      Object.assign(new Error('mixed cancellation reasons'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [
          { Code: 'ConditionalCheckFailed' },
          { Code: 'TransactionConflict' },
        ],
      }),
      Object.assign(new Error('malformed cancellation reasons'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, {}],
      }),
      Object.assign(new Error('missing cancellation reasons'), {
        name: 'TransactionCanceledException',
      }),
    ]) {
      fake.setNextTransactionError(error)
      await expect(repository.putSnapshot(record)).rejects.toMatchObject({
        code: 'AnalyticsPersistenceUnavailable',
      })
    }
  })

  test('enforces Workspace-unique snapshot IDs consistently across repositories', async () => {
    const query = createQuery([])
    const snapshot = createTestAnalyticsSnapshot({ workItems: [], events: [], query })
    const first: AnalyticsSnapshotRecord = {
      id: 'workspace-unique',
      workspaceId: 'workspace-1',
      reportId: 'report-a',
      reportRevision: 1,
      createdByMemberKey: 'member-1',
      createdAt: '2026-01-08T09:00:00.000Z',
      query,
      snapshot,
    }
    const second: AnalyticsSnapshotRecord = {
      ...first,
      reportId: 'report-b',
    }

    const memory = new InMemoryAnalyticsRepository()
    await memory.putSnapshot(first)
    await expect(memory.putSnapshot(second)).rejects.toMatchObject({
      code: 'AnalyticsSnapshotConflict',
    })
    expect(await memory.listSnapshots('workspace-1', 'report-a')).toEqual([first])
    expect(await memory.listSnapshots('workspace-1', 'report-b')).toEqual([])

    const fake = createDynamoDocumentClient()
    const dynamo = new DynamoDbAnalyticsRepository('analytics-table', fake.client)
    await dynamo.putSnapshot(first)
    await expect(dynamo.putSnapshot(second)).rejects.toMatchObject({
      code: 'AnalyticsSnapshotConflict',
    })
    expect(await dynamo.listSnapshots('workspace-1', 'report-a')).toEqual([first])
    expect(await dynamo.listSnapshots('workspace-1', 'report-b')).toEqual([])
    expect([...fake.rows.values()].filter(
      (row) => row.entryType === 'analytics-snapshot-id',
    )).toHaveLength(1)
  })
})
