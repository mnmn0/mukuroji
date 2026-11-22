import { describe, expect, test } from 'bun:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  DEFAULT_WORK_ITEM_TYPE_ID,
  type AnalyticsQueryInput,
  type AnalyticsSnapshotRecord,
  type CanonicalWorkItem,
  type CreateAnalyticsReportInput,
  createSearchWorkItemTypeKey,
  createDefaultDueDateWorkItemSchedule,
} from '@mukuroji/contracts'
import {
  ANALYTICS_METRIC_DEFINITIONS,
  AnalyticsError,
  DynamoDbAnalyticsRepository,
  InMemoryAnalyticsRepository,
  MAX_ANALYTICS_GENERATED_POINTS,
  MAX_ANALYTICS_REPORTS_PER_WORKSPACE,
  MAX_ANALYTICS_SNAPSHOT_RECORD_SERIALIZED_BYTES,
  MAX_ANALYTICS_TABLE_PREVIEW_ROWS,
  calculateAnalyticsNextRunAt,
  compareDynamoDbStringSortKeys,
  createAnalyticsCsv,
  createAnalyticsNextDeliveryAtRecordKey,
  ANALYTICS_PLANNING_GROUPS_UNAVAILABLE_WARNING,
  analyticsSnapshotReadPlanningGroups,
  createAnalyticsPermissionScopeHash,
  createAnalyticsPdf,
  createAnalyticsScheduleShard,
  createAnalyticsSnapshot,
  normalizeAnalyticsEvidenceInput,
  normalizeAnalyticsExportLocale,
  normalizeAnalyticsQueryInput,
  queryAnalyticsEvidence,
  resolveAnalyticsReportFilterPeriod,
  selectAnalyticsWorkItemsRequiringHistory,
  validateAnalyticsSnapshotRecordSize,
} from './analytics'
import {
  AUDIT_SCHEMA_VERSION,
  type AuditEventV1,
  type AuditFieldChange,
} from '../audit/audit'
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

/** Directory of the predefined CMaps pdf.js needs to read the `UniJIS-UCS2-H` fallback font. */
const pdfCMapDirectory = `${dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')))}/cmaps/`

/**
 * Extracts the text of every page of a PDF with pdf.js.
 *
 * @param bytes - PDF bytes.
 * @returns Page texts joined without separators, since pdf.js splits text items at font changes.
 */
async function readPdfText(bytes: Uint8Array) {
  const loadingTask = getDocument({ data: bytes, cMapUrl: pdfCMapDirectory, cMapPacked: true })
  const document = await loadingTask.promise
  const pages = await Promise.all(
    Array.from({ length: document.numPages }, async (_, index) => {
      const page = await document.getPage(index + 1)
      const content = await page.getTextContent()
      return content.items.flatMap((item) => 'str' in item ? [item.str] : []).join('')
    }),
  )
  await loadingTask.destroy()
  return pages.join('')
}

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
    updatedAt: '2026-01-06T00:00:00.000Z',
    workflowStatusId: 'status-completed',
    statusCategory: 'completed',
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    customFieldValues: {},
    relationIds: [],
    source: 'dynamodb',
    ...overrides,
    dueDate,
    schedule: overrides.schedule ?? createDefaultDueDateWorkItemSchedule(dueDate),
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

/**
 * Simulates canonical Work Items and their audit timelines, the way each mutation writes its event
 * and sets `updatedAt` in the same transaction.
 *
 * @param count - Number of Work Items to simulate.
 * @returns Final canonical Work Items and every audit event written for them.
 */
function createSimulatedAnalyticsHistory(count: number) {
  let seed = 371
  /** Returns the next deterministic pseudo-random integer below the bound. */
  const next = (bound: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed % bound
  }
  const pick = <T,>(values: readonly T[]): T => values[next(values.length)]!
  const statuses = ['backlog', 'unstarted', 'started', 'completed', 'canceled'] as const
  const projects = ['project-1', 'project-2', 'project-a', undefined] as const
  const assignees = ['user-1', 'user-2', 'user-3'] as const
  const start = Date.parse('2026-01-01T00:00:00.000Z')
  const hour = 60 * 60 * 1_000
  const workItems: CanonicalWorkItem[] = []
  const events: AuditEventV1[] = []

  for (let index = 0; index < count; index += 1) {
    let at = start + next(24 * 100) * hour
    const createdAt = new Date(at).toISOString()
    const initialProject = pick(projects)
    let item = createWorkItem(`simulated-${String(index).padStart(3, '0')}`, {
      createdAt,
      updatedAt: createdAt,
      statusCategory: pick(statuses),
      assigneeUserId: pick(assignees),
      dueDate: `2026-0${1 + next(4)}-1${next(10)}`,
      ...(initialProject === undefined ? {} : { assignedProjectId: initialProject }),
      ...(next(3) === 0 ? { remainingEffortMinutes: 60 * (1 + next(8)) } : {}),
    })
    item = {
      ...item,
      schedule: { ...item.schedule, plannedEffortMinutes: 60 * (1 + next(16)) },
    }
    const changeCount = next(7)
    for (let change = 0; change < changeCount; change += 1) {
      at += (1 + next(24 * 12)) * hour
      const occurredAt = new Date(at).toISOString()
      const kind = next(5)
      let changes: AuditFieldChange[]
      let after: CanonicalWorkItem
      if (kind <= 1) {
        const statusCategory = pick(statuses)
        changes = [{ field: 'statusCategory', before: item.statusCategory, after: statusCategory }]
        after = { ...item, statusCategory }
      } else if (kind === 2) {
        const project = pick(projects)
        changes = [{
          field: 'assignedProjectId',
          before: item.assignedProjectId ?? null,
          after: project ?? null,
        }]
        const { assignedProjectId: _previous, ...rest } = item
        after = project === undefined ? rest : { ...rest, assignedProjectId: project }
      } else if (kind === 3) {
        const assigneeUserId = pick(assignees)
        changes = [{ field: 'assigneeUserId', before: item.assigneeUserId, after: assigneeUserId }]
        after = { ...item, assigneeUserId }
      } else if (item.archivedAt === undefined) {
        changes = [{ field: 'archivedAt', before: null, after: occurredAt }]
        after = { ...item, archivedAt: occurredAt }
      } else {
        changes = [{ field: 'archivedAt', before: item.archivedAt, after: null }]
        const { archivedAt: _archived, ...rest } = item
        after = rest
      }
      after = { ...after, revision: item.revision + 1, updatedAt: occurredAt }
      events.push(createAuditEvent(`${item.id}-${change}`, item, occurredAt, changes))
      item = after
    }
    workItems.push(item)
  }
  return { workItems, events }
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
      const transactionItems = command.input.TransactItems ?? []
      const cancellationReasons = transactionItems.map((item) => {
        if (
          item.Put?.ConditionExpression?.includes('attribute_not_exists') &&
          rows.has(keyOf(item.Put.Item!))
        ) return { Code: 'ConditionalCheckFailed' }
        if (item.Update !== undefined) {
          const current = rows.get(keyOf(item.Update.Key!))
          const values = item.Update.ExpressionAttributeValues ?? {}
          const reportCount = typeof current?.reportCount === 'number'
            ? current.reportCount
            : undefined
          if (
            typeof values[':maximum'] === 'number' &&
            reportCount !== undefined &&
            reportCount >= values[':maximum']
          ) return { Code: 'ConditionalCheckFailed' }
          if (
            typeof values[':zero'] === 'number' &&
            (reportCount === undefined || reportCount <= values[':zero'])
          ) return { Code: 'ConditionalCheckFailed' }
        }
        if (item.Delete !== undefined) {
          const current = rows.get(keyOf(item.Delete.Key!))
          const expectedRevision =
            item.Delete.ExpressionAttributeValues?.[':expectedRevision']
          if (!current || current.revision !== expectedRevision) {
            return { Code: 'ConditionalCheckFailed' }
          }
        }
        return { Code: 'None' }
      })
      if (cancellationReasons.some((reason) =>
        reason.Code === 'ConditionalCheckFailed'
      )) {
        throw Object.assign(new Error('transaction canceled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: cancellationReasons,
        })
      }
      for (const transactionItem of transactionItems) {
        if (transactionItem.Put !== undefined) {
          const item = transactionItem.Put.Item!
          rows.set(keyOf(item), structuredClone(item))
        }
        if (transactionItem.Update !== undefined) {
          const key = transactionItem.Update.Key!
          const values = transactionItem.Update.ExpressionAttributeValues ?? {}
          const current = rows.get(keyOf(key)) ?? structuredClone(key)
          if (typeof values[':entryType'] === 'string') {
            current.entryType = values[':entryType']
          }
          const delta = typeof values[':increment'] === 'number'
            ? values[':increment']
            : typeof values[':decrement'] === 'number'
              ? values[':decrement']
              : 0
          current.reportCount =
            (typeof current.reportCount === 'number' ? current.reportCount : 0) +
            delta
          rows.set(keyOf(key), current)
        }
        if (transactionItem.Delete !== undefined) {
          rows.delete(keyOf(transactionItem.Delete.Key!))
        }
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
            compareDynamoDbStringSortKeys(
                item.nextDeliveryAtRecordKey,
                String(upperBound),
              ) > 0
          )
        ) return false
        return true
      })
      const sortAttribute = command.input.IndexName === undefined
        ? 'recordKey'
        : 'nextDeliveryAtRecordKey'
      items.sort((left, right) =>
        compareDynamoDbStringSortKeys(
          String(left[sortAttribute]),
          String(right[sortAttribute]),
        )
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
        Items: command.input.IndexName === undefined
          ? limitedItems
          : limitedItems.map((item) => ({
              workspaceId: item.workspaceId,
              recordKey: item.recordKey,
              scheduleShard: item.scheduleShard,
              nextDeliveryAtRecordKey: item.nextDeliveryAtRecordKey,
            })),
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
      dueDate: '2026-01-05',
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
      'remaining-scope': 1,
      'cumulative-flow': 2,
      'milestone-trend': null,
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

    const nonCanonicalEntity = {
      ...completion,
      entityId: item.id,
      entity: { type: 'work-item', id: item.id },
    }
    expect(createTestAnalyticsSnapshot({
      workItems: [item],
      events: [nonCanonicalEntity],
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

  test('rewinds historical WIP calendar groups and handles due dates by timezone', () => {
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

    const overdue = createWorkItem('overdue', {
      statusCategory: 'unstarted',
      workflowStatusId: 'status-unstarted',
      dueDate: '2026-01-01',
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

  test('charts daily remaining scope, burnup scope, and cumulative flow from rewound state', () => {
    const done = createWorkItem('done', {
      createdAt: '2025-12-31T00:00:00.000Z',
      updatedAt: '2026-01-02T12:00:00.000Z',
    })
    const added = createWorkItem('added', {
      createdAt: '2026-01-02T06:00:00.000Z',
      updatedAt: '2026-01-02T06:00:00.000Z',
      statusCategory: 'started',
      workflowStatusId: 'status-started',
    })
    const canceled = createWorkItem('canceled', {
      createdAt: '2025-12-31T00:00:00.000Z',
      updatedAt: '2026-01-03T12:00:00.000Z',
      statusCategory: 'canceled',
      workflowStatusId: 'status-canceled',
    })
    const outside = createWorkItem('outside', {
      createdAt: '2025-12-31T00:00:00.000Z',
      statusCategory: 'unstarted',
      workflowStatusId: 'status-unstarted',
    })
    const events = [
      createAuditEvent('done-complete', done, '2026-01-02T12:00:00.000Z', [
        { field: 'statusCategory', before: 'unstarted', after: 'completed' },
      ]),
      createAuditEvent('cancel', canceled, '2026-01-03T12:00:00.000Z', [
        { field: 'statusCategory', before: 'backlog', after: 'canceled' },
      ]),
    ]
    const snapshot = createTestAnalyticsSnapshot({
      workItems: [done, added, canceled, outside],
      events,
      query: createQuery([
        {
          id: 'burndown',
          title: 'Burndown',
          type: 'chart',
          metric: 'remaining-scope',
          visualization: 'burndown',
          groupBy: { dimension: 'day' },
        },
        {
          id: 'cfd',
          title: 'CFD',
          type: 'chart',
          metric: 'cumulative-flow',
          visualization: 'area',
          groupBy: { dimension: 'day' },
        },
      ], {
        filter: {
          period: {
            from: '2026-01-01T00:00:00.000Z',
            to: '2026-01-03T23:59:59.999Z',
          },
          workItems: [
            { teamId: 'core', workItemId: 'canceled' },
            { teamId: 'core', workItemId: 'added' },
            { teamId: 'core', workItemId: 'done' },
            { teamId: 'core', workItemId: 'done' },
          ],
        },
        asOf: '2026-01-03T23:59:59.999Z',
      }),
    })

    expect(snapshot.filter.workItems).toEqual([
      { teamId: 'core', workItemId: 'added' },
      { teamId: 'core', workItemId: 'canceled' },
      { teamId: 'core', workItemId: 'done' },
    ])
    const burndown = snapshot.widgets[0]
    expect(burndown?.value).toBe(1)
    expect(burndown?.series.map((point) => point.value)).toEqual([2, 2, 1])
    expect(burndown?.series.map((point) => point.segments)).toEqual([
      [{ key: 'scope', value: 2 }, { key: 'completed', value: 0 }],
      [{ key: 'scope', value: 3 }, { key: 'completed', value: 1 }],
      [{ key: 'scope', value: 2 }, { key: 'completed', value: 1 }],
    ])
    const cfd = snapshot.widgets[1]
    expect(cfd?.value).toBe(3)
    expect(cfd?.series.map((point) =>
      Object.fromEntries((point.segments ?? []).map((segment) => [segment.key, segment.value]))
    )).toEqual([
      { completed: 0, started: 0, unstarted: 1, backlog: 1, canceled: 0 },
      { completed: 1, started: 1, unstarted: 0, backlog: 1, canceled: 0 },
      { completed: 1, started: 1, unstarted: 0, backlog: 0, canceled: 1 },
    ])
  })

  test('weights remaining scope by remaining effort and keeps existing metric series unchanged', () => {
    const estimated = createWorkItem('estimated', {
      statusCategory: 'started',
      workflowStatusId: 'status-started',
      schedule: { ...createDefaultDueDateWorkItemSchedule('2026-01-10'), plannedEffortMinutes: 240 },
      remainingEffortMinutes: 90,
    })
    const unestimated = createWorkItem('unestimated', {
      statusCategory: 'unstarted',
      workflowStatusId: 'status-unstarted',
    })
    const snapshot = createTestAnalyticsSnapshot({
      workItems: [estimated, unestimated],
      events: [],
      query: createQuery([
        {
          id: 'effort',
          title: 'Effort',
          type: 'metric',
          metric: 'remaining-scope',
          weighting: 'effort',
        },
        {
          id: 'wip',
          title: 'WIP',
          type: 'chart',
          metric: 'wip',
        },
        {
          id: 'burnup',
          title: 'Burnup',
          type: 'chart',
          metric: 'remaining-scope',
          visualization: 'burnup',
          weighting: 'effort',
        },
      ]),
    })
    expect(snapshot.widgets[2]?.series.at(-1)?.segments).toEqual([
      { key: 'scope', value: 4 },
      { key: 'completed', value: 0 },
    ])
    expect(snapshot.widgets[0]?.value).toBe(1.5)
    expect(snapshot.widgets[0]?.definition.unit).toBe('hours')
    expect(snapshot.widgets[0]?.warnings).toEqual([
      '1 remaining Work Item(s) had no estimate and counted as zero effort.',
    ])
    expect(snapshot.widgets[1]?.series.every((point) => point.segments === undefined)).toBe(true)
    expect(() => normalizeAnalyticsQueryInput(createQuery([{
      id: 'wip',
      title: 'WIP',
      type: 'metric',
      metric: 'wip',
      weighting: 'effort',
    }]))).toThrow(AnalyticsError)
    expect(() => normalizeAnalyticsQueryInput(createQuery([], {
      filter: {
        period,
        workItems: Array.from({ length: 501 }, (_, index) => ({
          teamId: 'core',
          workItemId: `item-${index}`,
        })),
      },
    }))).toThrow(AnalyticsError)
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

  test('rewinds a first Work Item Type assignment to the built-in type', () => {
    const item = createWorkItem('historical-work-item-type', {
      workItemTypeId: 'incident',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    })
    const typeAssignment = createAuditEvent(
      'assign-work-item-type',
      item,
      '2026-01-03T00:00:00.000Z',
      [{ field: 'workItemTypeId', after: 'incident' }],
    )
    const snapshot = createTestAnalyticsSnapshot({
      workItems: [item],
      events: [typeAssignment],
      query: createQuery([{
        id: 'wip-by-work-item-type',
        title: 'WIP by Work Item Type',
        type: 'metric',
        metric: 'wip',
        groupBy: { dimension: 'work-item-type' },
      }], {
        asOf: '2026-01-02T23:59:59.999Z',
      }),
    })

    expect(snapshot.widgets[0]?.groups.map((group) => group.key)).toEqual([
      createSearchWorkItemTypeKey('core', DEFAULT_WORK_ITEM_TYPE_ID),
    ])
  })

  test('rewinds the Work Item title only from events that target the Work Item itself', () => {
    const item = createWorkItem('renamed-with-context', {
      title: 'Current title',
      statusCategory: 'started',
      workflowStatusId: 'status-started',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-09T00:00:00.000Z',
    })
    const rename = createAuditEvent(
      'rename-work-item',
      item,
      '2026-01-09T00:00:00.000Z',
      [{ field: 'title', before: 'Earlier title', after: 'Current title' }],
    )
    const contextItemEvent = createAuditEvent(
      'update-context-item',
      item,
      '2026-01-08T00:00:00.000Z',
      [{ field: 'title', before: 'Old note', after: 'New note' }],
    )
    const contextItemTargetId = `${contextItemEvent.entityId}/context-item/note-1`
    const contextItemUpdate: AuditEventV1 = {
      ...contextItemEvent,
      eventType: 'context-item.updated',
      target: { type: 'context-item', id: contextItemTargetId },
      targetType: 'context-item',
      targetId: contextItemTargetId,
      targetKey: `workspace-1#context-item#${contextItemTargetId}`,
    }
    const evidence = queryTestAnalyticsEvidence({
      workItems: [item],
      events: [rename, contextItemUpdate],
      evidence: {
        metric: 'wip',
        filter: { period },
        asOf: '2026-01-07T00:00:00.000Z',
        timeZone: 'UTC',
        limit: 10,
      },
    })

    expect(evidence.items.map((evidenceItem) => evidenceItem.title)).toEqual(['Earlier title'])
  })

  test('keeps Work Item Type filters and groups isolated by Team', () => {
    const first = createWorkItem('shared-type-a', {
      teamId: 'team-a',
      workItemTypeId: 'shared',
      statusCategory: 'started',
      workflowStatusId: 'status-started',
    })
    const second = createWorkItem('shared-type-b', {
      teamId: 'team-b',
      workItemTypeId: 'shared',
      statusCategory: 'started',
      workflowStatusId: 'status-started',
    })
    const selectedKey = createSearchWorkItemTypeKey('team-a', 'shared')
    const filtered = createTestAnalyticsSnapshot({
      workItems: [first, second],
      events: [],
      query: createQuery([{
        id: 'filtered-shared-type',
        title: 'Filtered shared type',
        type: 'metric',
        metric: 'wip',
      }], {
        filter: { period, workItemTypeIds: [selectedKey] },
      }),
    })
    const grouped = createTestAnalyticsSnapshot({
      workItems: [first, second],
      events: [],
      query: createQuery([{
        id: 'grouped-shared-type',
        title: 'Grouped shared type',
        type: 'metric',
        metric: 'wip',
        groupBy: { dimension: 'work-item-type' },
      }]),
    })

    expect(filtered.widgets[0]?.value).toBe(1)
    expect(grouped.widgets[0]?.groups.map((group) => group.key)).toEqual([
      createSearchWorkItemTypeKey('team-a', 'shared'),
      createSearchWorkItemTypeKey('team-b', 'shared'),
    ])
  })

  test('rejects bare Work Item Type IDs at the Analytics filter boundary', () => {
    expect(() => normalizeAnalyticsQueryInput(createQuery([], {
      filter: { period, workItemTypeIds: ['shared'] },
    }))).toThrow(expect.objectContaining({
      code: 'AnalyticsFilterInvalid',
      status: 400,
    }))
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

  test('weights throughput, velocity, and forecast by the canonical estimate when asked', () => {
    const estimated = (id: string, minutes: number | undefined, overrides: Partial<CanonicalWorkItem> = {}) =>
      createWorkItem(id, {
        schedule: { ...createDefaultDueDateWorkItemSchedule('2026-03-10'), ...(minutes === undefined ? {} : { plannedEffortMinutes: minutes }) },
        dueDate: '2026-03-10',
        ...overrides,
      })
    const first = estimated('effort-1', 240)
    const second = estimated('effort-2', 120)
    const unestimated = estimated('effort-3', undefined)
    const open = estimated('effort-open', 600, {
      statusCategory: 'started', workflowStatusId: 'status-started', remainingEffortMinutes: 360,
    })
    // Neither an estimate nor a remaining effort: counted as zero and reported.
    const openUnestimated = estimated('effort-open-unestimated', undefined, {
      statusCategory: 'started', workflowStatusId: 'status-started',
    })
    // An explicit zero remaining effort is known, so it is not reported.
    const openFinished = estimated('effort-open-finished', 60, {
      statusCategory: 'started', workflowStatusId: 'status-started', remainingEffortMinutes: 0,
    })
    const completion = (item: CanonicalWorkItem, at: string) => createAuditEvent(
      `${item.id}-complete`, item, at, [{ field: 'statusCategory', before: 'started', after: 'completed' }],
    )
    const input = {
      workItems: [first, second, unestimated, open, openUnestimated, openFinished],
      events: [
        completion(first, '2026-03-02T12:00:00.000Z'),
        completion(second, '2026-03-03T12:00:00.000Z'),
        completion(unestimated, '2026-03-04T12:00:00.000Z'),
      ],
    }
    const snapshotFor = (weighting: 'count' | 'effort') => createTestAnalyticsSnapshot({
      ...input,
      query: createQuery([
        { id: 'throughput', title: 'Throughput', type: 'metric', metric: 'throughput', weighting },
        { id: 'velocity', title: 'Velocity', type: 'metric', metric: 'velocity', weighting },
      ], {
        filter: { period: { from: '2026-03-02T00:00:00.000Z', to: '2026-03-08T23:59:59.999Z' } },
        asOf: '2026-03-08T23:59:59.999Z',
        forecastWeighting: weighting,
      }),
    })

    const counted = snapshotFor('count')
    expect(counted.widgets.map((widget) => widget.value)).toEqual([3, 3])
    expect(counted.forecast.remainingWorkItems).toBe(3)
    expect(counted.forecast.weighting).toBeUndefined()
    expect(counted.forecast.unestimatedRemainingWorkItems).toBeUndefined()

    const weighted = snapshotFor('effort')
    expect(weighted.widgets.map((widget) => [widget.value, widget.definition.unit])).toEqual([[6, 'hours'], [6, 'hours-per-week']])
    expect(weighted.widgets[0]?.warnings).toContain('1 completed Work Item(s) had no estimate and counted as zero effort.')
    expect(weighted.forecast).toMatchObject({
      weighting: 'effort', remainingWorkItems: 3, remainingEffortHours: 6, unestimatedRemainingWorkItems: 1,
    })
    // Exports name the unit of effort-weighted rows so they cannot be mistaken for item counts.
    expect(createAnalyticsCsv(weighted)).toContain('throughput,Throughput (hours),6')
    expect(createAnalyticsCsv(weighted)).toContain('velocity,Velocity (hours/week),6')
    expect(createAnalyticsCsv(counted)).toContain('throughput,Throughput,3')
    // Six hours completed over seven days, so six remaining hours take at least the next completing days.
    expect(weighted.forecast.dailyThroughput).toBe(0.857)
    expect(weighted.forecast.p95).not.toBeNull()

    expect(() => createTestAnalyticsSnapshot({
      ...input,
      query: createQuery([{ id: 'wip', title: 'WIP', type: 'metric', metric: 'wip', weighting: 'effort' }]),
    })).toThrow('Only throughput, velocity, and remaining scope widgets can be weighted by effort.')
  })

  test('simulates effort in whole minutes so rounding the reported hours cannot add a day', () => {
    const estimated = (id: string, overrides: Partial<CanonicalWorkItem> = {}) => createWorkItem(id, {
      schedule: { ...createDefaultDueDateWorkItemSchedule('2026-03-10'), plannedEffortMinutes: 100 },
      dueDate: '2026-03-10',
      ...overrides,
    })
    const first = estimated('minutes-1')
    const second = estimated('minutes-2')
    const open = estimated('minutes-open', { statusCategory: 'started', workflowStatusId: 'status-started' })
    const completion = (item: CanonicalWorkItem, at: string) => createAuditEvent(
      `${item.id}-complete`, item, at, [{ field: 'statusCategory', before: 'started', after: 'completed' }],
    )
    const { forecast } = createTestAnalyticsSnapshot({
      workItems: [first, second, open],
      events: [completion(first, '2026-03-02T12:00:00.000Z'), completion(second, '2026-03-03T12:00:00.000Z')],
      query: createQuery([], {
        filter: { period: { from: '2026-03-02T00:00:00.000Z', to: '2026-03-03T23:59:59.999Z' } },
        asOf: '2026-03-03T23:59:59.999Z',
        forecastWeighting: 'effort',
      }),
    })
    // Each day completed 100 minutes and 100 minutes remain, so every scenario finishes on the next day.
    expect(forecast).toMatchObject({ remainingEffortHours: 1.667, dailyThroughput: 1.667 })
    expect(forecast.p50).toBe(forecast.p95)
    expect(forecast.p95).toBe('2026-03-04T23:59:59.999Z')
  })

  test('rewinds the estimate, remaining effort, and status before deriving historical remaining effort', () => {
    const schedule = (minutes: number) => ({ ...createDefaultDueDateWorkItemSchedule('2026-03-10'), plannedEffortMinutes: minutes })
    // Today the item is completed with a larger estimate and a recorded remaining effort, all set after `asOf`.
    const item = createWorkItem('effort-history', {
      schedule: schedule(600),
      dueDate: '2026-03-10',
      remainingEffortMinutes: 0,
      updatedAt: '2026-03-12T12:00:00.000Z',
    })
    const events = [
      createAuditEvent('effort-history-estimate', item, '2026-03-11T12:00:00.000Z', [
        { field: 'schedule', before: schedule(300), after: schedule(600) },
        { field: 'remainingEffortMinutes', after: 120 },
      ]),
      createAuditEvent('effort-history-complete', item, '2026-03-12T12:00:00.000Z', [
        { field: 'statusCategory', before: 'started', after: 'completed' },
        { field: 'remainingEffortMinutes', before: 120, after: 0 },
      ]),
    ]
    const snapshot = createTestAnalyticsSnapshot({
      workItems: [item],
      events,
      query: createQuery([], {
        filter: { period: { from: '2026-03-02T00:00:00.000Z', to: '2026-03-08T23:59:59.999Z' } },
        asOf: '2026-03-08T23:59:59.999Z',
        forecastWeighting: 'effort',
      }),
    })
    // At `asOf` the item was open with a 5 hour estimate and no recorded remaining effort.
    expect(snapshot.forecast).toMatchObject({ weighting: 'effort', remainingWorkItems: 1, remainingEffortHours: 5 })
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

  test('normalizes query and evidence inputs without evaluating a snapshot', () => {
    const normalizedQuery = normalizeAnalyticsQueryInput(createQuery([], {
      filter: {
        period: {
          from: period.from,
          to: '2026-01-08T00:00:00.000Z',
        },
        teamIds: [' core ', 'core'],
      },
      asOf: period.to,
    }))
    const normalizedEvidence = normalizeAnalyticsEvidenceInput({
      metric: 'throughput',
      filter: {
        period,
        projectIds: [' project-1 ', 'project-1'],
      },
      asOf: period.to,
      timeZone: 'UTC',
    })

    expect(normalizedQuery.filter.period.to).toBe(period.to)
    expect(normalizedQuery.filter.teamIds).toEqual(['core'])
    expect(normalizedEvidence.filter.projectIds).toEqual(['project-1'])
    expect(normalizedEvidence.limit).toBe(50)
  })

  test('rejects excessive periods and generated calendar points before data evaluation', () => {
    expect(() => normalizeAnalyticsQueryInput(createQuery([], {
      filter: {
        period: {
          from: '2026-01-01T00:00:00.000Z',
          to: '2027-01-03T00:00:00.000Z',
        },
      },
      asOf: '2027-01-03T00:00:00.000Z',
    }))).toThrow(expect.objectContaining({
      code: 'AnalyticsQueryPeriodLimitExceeded',
      status: 413,
    }))

    const charts = Array.from({ length: 50 }, (_, index) => ({
      id: `daily-${index}`,
      title: `Daily ${index}`,
      type: 'chart' as const,
      metric: 'throughput' as const,
      groupBy: { dimension: 'day' as const },
    }))
    expect(MAX_ANALYTICS_GENERATED_POINTS).toBe(10_000)
    expect(() => normalizeAnalyticsQueryInput(createQuery(charts, {
      filter: {
        period: {
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-06-30T00:00:00.000Z',
        },
      },
      asOf: '2026-06-30T00:00:00.000Z',
    }))).toThrow(expect.objectContaining({
      code: 'AnalyticsQueryPointLimitExceeded',
      status: 413,
    }))
  })

  test('stores only bounded table previews while evidence remains paged', () => {
    const workItems = Array.from(
      { length: MAX_ANALYTICS_TABLE_PREVIEW_ROWS + 25 },
      (_, index) => createWorkItem(`preview-${String(index).padStart(3, '0')}`),
    )
    const events = workItems.map((item, index) =>
      createAuditEvent(
        `preview-completed-${index}`,
        item,
        '2026-01-06T00:00:00.000Z',
        [{ field: 'statusCategory', before: 'started', after: 'completed' }],
      )
    )
    const query = createQuery([{
      id: 'preview',
      title: 'Preview',
      type: 'table',
      metric: 'throughput',
    }])
    const snapshot = createTestAnalyticsSnapshot({ workItems, events, query })
    const evidence = queryTestAnalyticsEvidence({
      workItems,
      events,
      evidence: {
        metric: 'throughput',
        filter: query.filter,
        asOf: query.asOf,
        timeZone: query.timeZone,
        limit: 200,
      },
    })

    expect(snapshot.widgets[0]?.rows).toHaveLength(MAX_ANALYTICS_TABLE_PREVIEW_ROWS)
    expect(snapshot.evidenceCount).toBe(workItems.length)
    expect(evidence.items).toHaveLength(workItems.length)
    expect(evidence.nextCursor).toBeUndefined()
  })

  test('gives identical results when Work Items untouched since the period start skip history', () => {
    const { workItems, events } = createSimulatedAnalyticsHistory(240)
    const historyPeriod = {
      from: '2026-03-01T00:00:00.000Z',
      to: '2026-03-31T23:59:59.999Z',
    }
    const asOf = '2026-03-24T09:30:00.000Z'
    const metrics = Object.keys(ANALYTICS_METRIC_DEFINITIONS) as Array<
      keyof typeof ANALYTICS_METRIC_DEFINITIONS
    >
    const query = createQuery([
      ...metrics.map((metric) => ({
        id: `chart-${metric}`,
        title: metric,
        type: 'chart' as const,
        metric,
        groupBy: { dimension: 'day' as const },
        ...(metric === 'sla' ? { slaTargetHours: 240 } : {}),
      })),
      ...(['project', 'status', 'assignee', 'week'] as const).map((dimension) => ({
        id: `group-${dimension}`,
        title: dimension,
        type: 'table' as const,
        metric: 'remaining-scope' as const,
        groupBy: { dimension },
      })),
      {
        id: 'effort-throughput',
        title: 'Effort throughput',
        type: 'metric',
        metric: 'throughput',
        weighting: 'effort',
      },
    ], {
      filter: { period: historyPeriod, includeArchived: true },
      asOf,
      forecastBaseline: { from: historyPeriod.from, to: '2026-04-15T00:00:00.000Z' },
    })
    const historyWorkItems = selectAnalyticsWorkItemsRequiringHistory(
      workItems,
      historyPeriod.from,
    )
    const historyKeys = new Set(historyWorkItems.map((item) =>
      `team/${item.teamId}/issue/${item.id}`
    ))
    const historyEvents = events.filter((event) => historyKeys.has(event.entityId))

    expect(historyWorkItems.length).toBeGreaterThan(0)
    expect(historyWorkItems.length).toBeLessThan(workItems.length)
    expect(historyEvents.length).toBeLessThan(events.length)

    for (const includeArchived of [true, false]) {
      const scopedQuery = {
        ...query,
        filter: { ...query.filter, includeArchived },
      }
      const full = createTestAnalyticsSnapshot({ workItems, events, query: scopedQuery })
      const reduced = createTestAnalyticsSnapshot({
        workItems,
        events: historyEvents,
        query: scopedQuery,
      })
      expect(reduced).toEqual(full)
      expect(full.widgets.some((widget) => (widget.value ?? 0) > 0)).toBe(true)
    }
    for (const metric of metrics) {
      const evidence = {
        metric,
        filter: query.filter,
        asOf,
        timeZone: 'UTC',
        limit: 200,
      }
      expect(queryTestAnalyticsEvidence({ workItems, events: historyEvents, evidence }))
        .toEqual(queryTestAnalyticsEvidence({ workItems, events, evidence }))
    }
  })

  test('requires history for every Work Item when an update instant cannot be compared', () => {
    const old = createWorkItem('old', { updatedAt: '2025-12-01T00:00:00.000Z' })
    const recent = createWorkItem('recent', { updatedAt: period.from })
    const invalid = createWorkItem('invalid', { updatedAt: 'not-a-date' })

    expect(selectAnalyticsWorkItemsRequiringHistory([old, recent, invalid], period.from))
      .toEqual([recent, invalid])
    expect(selectAnalyticsWorkItemsRequiringHistory([old, recent], 'not-a-date'))
      .toEqual([old, recent])
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
      'Period from,Period to,Row ID,Row label,Team ID,Work Item ID,Project ID,Occurred at,' +
      'Dimension key,Team,Project',
    )
    expect(japaneseCsv.split('\r\n')[0]).toBe(
      'ウィジェットID,指標キー,指標,値,サンプル数,レコード種別,ディメンション値,' +
      '期間開始,期間終了,行ID,行ラベル,チームID,作業項目ID,プロジェクトID,発生日時,' +
      'ディメンションキー,チーム,プロジェクト',
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
        'remaining-scope',
        'cumulative-flow',
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
      cMapUrl: pdfCMapDirectory,
      cMapPacked: true,
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
      'Remaining scope',
      'Cumulative flow',
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

  test('prints names, the report context, and group breakdowns instead of internal IDs', async () => {
    const assigned = createWorkItem('named', {
      assignedProjectId: 'project-a',
      assigneeUserId: 'sato@example.com',
    })
    const unassigned = createWorkItem('unassigned', { assigneeUserId: '' })
    const events = [assigned, unassigned].map((item) => createAuditEvent(
      `${item.id}-completed`,
      item,
      '2026-01-05T00:00:00.000Z',
      [{ field: 'statusCategory', before: 'started', after: 'completed' }],
    ))
    const widgets: AnalyticsQueryInput['widgets'] = [
      {
        id: 'by-project',
        title: '週次の完了',
        type: 'chart',
        metric: 'throughput',
        groupBy: { dimension: 'project' },
      },
      {
        id: 'by-assignee',
        title: 'Throughput',
        type: 'chart',
        metric: 'throughput',
        groupBy: { dimension: 'assignee' },
      },
      {
        id: 'by-status',
        title: 'Throughput',
        type: 'chart',
        metric: 'throughput',
        groupBy: { dimension: 'status' },
      },
    ]
    const snapshot = createTestAnalyticsSnapshot({
      workItems: [assigned, unassigned],
      events,
      query: createQuery(widgets, {
        filter: { period, teamIds: ['core'] },
        timeZone: 'Asia/Tokyo',
      }),
    })
    const context = {
      title: '開発チーム週次レポート',
      widgets,
      names: {
        teams: new Map([['core', '開発基盤チーム']]),
        projects: new Map([['project-a', '会計システム刷新']]),
        members: new Map([['sato@example.com', '佐藤 花子']]),
        customFields: new Map([['field-risk', 'Risk level']]),
      },
    }

    const csv = createAnalyticsCsv(snapshot, 'ja', context)
    expect(csv).toContain('グループ,会計システム刷新,')
    expect(csv).toContain(',project-a,,')
    expect(csv).toContain('グループ,未設定,')
    expect(csv).toContain('グループ,佐藤 花子,')
    expect(csv).toContain('グループ,完了,')
    expect(createAnalyticsCsv(snapshot, 'en', context)).toContain('Group,Unassigned,')

    const japaneseText = await readPdfText(createAnalyticsPdf(snapshot, 'ja', context))
    for (const expected of [
      '開発チーム週次レポート',
      '期間: 2026-01-01 - 2026-01-07',
      'タイムゾーン: Asia/Tokyo',
      'チーム: 開発基盤チーム',
      '週次の完了 (スループット): 2 件',
      '会計システム刷新: 1 件 (n=1)',
      '未設定: 1 件 (n=1)',
      '佐藤 花子: 1 件 (n=1)',
      '完了: 2 件 (n=2)',
    ]) {
      expect(japaneseText).toContain(expected)
    }
    expect(japaneseText).not.toContain('project-a')
    expect(japaneseText).not.toContain('sato@example.com')

    const englishPdf = createAnalyticsPdf(snapshot, 'en', context)
    expect(Buffer.from(englishPdf).toString('latin1')).toContain('/Encoding /UniJIS-UCS2-H')
    const englishText = await readPdfText(englishPdf)
    expect(englishText).toContain('Teams: 開発基盤チーム')
    expect(englishText).toContain('Unassigned: 1 items (n=1)')
    expect(englishText).toContain('Completed: 2 items (n=2)')

    const filtered = createTestAnalyticsSnapshot({
      workItems: [],
      events: [],
      query: createQuery(widgets, {
        filter: {
          period,
          projectIds: ['project-a'],
          customFields: [{ fieldId: 'field-risk', operator: 'equals', value: 'high' }],
          includeArchived: true,
        },
      }),
    })
    const filterText = await readPdfText(createAnalyticsPdf(filtered, 'ja', context))
    expect(filterText).toContain('プロジェクト: 会計システム刷新')
    expect(filterText).toContain('カスタム項目: Risk level = high')
    expect(filterText).toContain('アーカイブ済みを含む')
  })

  test('wraps long PDF lines and omits the fallback font when every character is embedded', async () => {
    const longTitle = `${'Quarterly delivery review '.repeat(6)}end`
    const snapshot = createTestAnalyticsSnapshot({
      workItems: [],
      events: [],
      query: createQuery([{ id: 'throughput', title: 'Throughput', type: 'metric', metric: 'throughput' }]),
    })
    const pdf = createAnalyticsPdf(snapshot, 'en', { title: longTitle })
    const source = Buffer.from(pdf).toString('latin1')

    expect(source).not.toContain('UniJIS-UCS2-H')
    expect(source).toContain('(Quarterly delivery review Quarterly')
    const text = await readPdfText(pdf)
    expect(text).toContain('end')
    expect(text).toContain('Filters: None')
  })

  test('prints the inclusive period end when the period ends at local midnight', async () => {
    const base = createTestAnalyticsSnapshot({
      workItems: [],
      events: [],
      query: createQuery([{ id: 'throughput', title: 'Throughput', type: 'metric', metric: 'throughput' }]),
    })
    const snapshot = {
      ...base,
      timeZone: 'UTC',
      filter: { ...base.filter, period: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-07T00:00:00.000Z' } },
    }
    expect(await readPdfText(createAnalyticsPdf(snapshot, 'en'))).toContain('2026-01-01 - 2026-01-07')
  })
})

describe('Analytics priority, Cycle, and Milestone groups', () => {
  const started = (id: string, overrides: Partial<CanonicalWorkItem> = {}) =>
    createWorkItem(id, { statusCategory: 'started', ...overrides })
  const groupBy = (dimension: 'priority' | 'cycle' | 'milestone'): AnalyticsQueryInput['widgets'] => [{
    id: `wip-by-${dimension}`,
    title: 'WIP',
    type: 'chart',
    metric: 'wip',
    groupBy: { dimension },
  }]

  test('groups by the priority at as-of, rewinding later priority changes', () => {
    const changedLater = started('changed', { priority: 'high' })
    const snapshot = createTestAnalyticsSnapshot({
      workItems: [changedLater, started('steady', { priority: 'high' })],
      events: [createAuditEvent(
        'changed-priority',
        changedLater,
        '2026-01-08T00:00:00.000Z',
        [{ field: 'priority', before: 'low', after: 'high' }],
      )],
      query: createQuery(groupBy('priority')),
    })
    expect(snapshot.widgets[0]?.groups.map((group) => [group.key, group.value])).toEqual([
      ['high', 1],
      ['low', 1],
    ])
  })

  test('groups by readable Cycles and Milestones and keeps the rest unset', () => {
    const inCycle = started('in-cycle')
    const planningGroups = {
      links: new Map([
        [`core\u0000${inCycle.id}`, {
          cycle: { id: 'cycle-1', title: 'Sprint 1' },
          milestone: { id: 'milestone-1', title: 'Beta' },
        }],
      ]),
      entityScopeKeys: ['cycle-1\u0000core\u0000', 'milestone-1\u0000core\u0000'],
    }
    const workItems = [inCycle, started('no-cycle')]
    const byCycle = createTestAnalyticsSnapshot({
      workItems,
      events: [],
      planningGroups,
      query: createQuery(groupBy('cycle')),
    })
    expect(byCycle.widgets[0]?.groups.map((group) => [group.key, group.label, group.value])).toEqual([
      ['', 'Unassigned', 1],
      ['cycle-1', 'Sprint 1', 1],
    ])
    const byMilestone = createTestAnalyticsSnapshot({
      workItems,
      events: [],
      planningGroups,
      query: createQuery(groupBy('milestone')),
    })
    expect(byMilestone.widgets[0]?.groups.map((group) => group.label)).toEqual(['Unassigned', 'Beta'])
    expect(analyticsSnapshotReadPlanningGroups(createQuery(groupBy('cycle')), byCycle)).toBeTrue()

    // The readable Cycles and Milestones are part of the permission scope.
    const narrowed = createTestAnalyticsSnapshot({
      workItems,
      events: [],
      planningGroups: { ...planningGroups, entityScopeKeys: ['cycle-1\u0000core\u0000'] },
      query: createQuery(groupBy('cycle')),
    })
    expect(narrowed.permissionScopeHash).not.toBe(byCycle.permissionScopeHash)
  })

  test('warns instead of grouping when the run cannot read Planning', () => {
    const query = createQuery(groupBy('cycle'))
    const snapshot = createTestAnalyticsSnapshot({ workItems: [started('a')], events: [], query })
    expect(snapshot.widgets[0]).toMatchObject({
      groups: [],
      value: null,
      warnings: [ANALYTICS_PLANNING_GROUPS_UNAVAILABLE_WARNING],
    })
    expect(analyticsSnapshotReadPlanningGroups(query, snapshot)).toBeFalse()
    // Without Planning the hash matches a snapshot that never read it.
    expect(snapshot.permissionScopeHash).toBe(createTestAnalyticsSnapshot({
      workItems: [started('a')],
      events: [],
      query: createQuery(groupBy('priority')),
    }).permissionScopeHash)
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

  test('paginates report rows and enforces the in-memory Workspace quota', async () => {
    const repository = new InMemoryAnalyticsRepository()
    for (let index = 0; index < MAX_ANALYTICS_REPORTS_PER_WORKSPACE; index += 1) {
      await repository.createReport(
        'workspace-quota',
        'member-1',
        createReportInput({
          id: `report-${String(index).padStart(4, '0')}`,
        }),
      )
    }
    await expect(repository.createReport(
      'workspace-quota',
      'member-1',
      createReportInput({ id: 'report-over-quota' }),
    )).rejects.toMatchObject({
      code: 'AnalyticsReportQuotaExceeded',
      status: 409,
    })

    const reportIds: string[] = []
    let cursor: string | undefined
    do {
      const page = await repository.listReports(
        'workspace-quota',
        137,
        cursor,
      )
      reportIds.push(...page.reports.map((report) => report.id))
      cursor = page.nextCursor
    } while (cursor !== undefined)
    expect(reportIds).toHaveLength(MAX_ANALYTICS_REPORTS_PER_WORKSPACE)
    expect(new Set(reportIds).size).toBe(MAX_ANALYTICS_REPORTS_PER_WORKSPACE)
    expect(reportIds[0]).toBe('report-0000')
    expect(reportIds.at(-1)).toBe('report-0999')

    await repository.deleteReport('workspace-quota', 'report-0000', 1)
    await expect(repository.createReport(
      'workspace-quota',
      'member-1',
      createReportInput({ id: 'report-replacement' }),
    )).resolves.toMatchObject({ id: 'report-replacement' })
  })

  test('uses one DynamoDB transaction for report quota and uniqueness', async () => {
    const fake = createDynamoDocumentClient()
    const repository = new DynamoDbAnalyticsRepository('analytics-table', fake.client)
    const first = await repository.createReport(
      'workspace-quota',
      'member-1',
      createReportInput({ id: 'first' }),
    )
    await repository.createReport(
      'workspace-quota',
      'member-1',
      createReportInput({ id: 'second' }),
    )
    const counter = [...fake.rows.values()].find((row) =>
      row.entryType === 'analytics-report-counter'
    )
    expect(counter?.reportCount).toBe(2)
    const firstPage = await repository.listReports('workspace-quota', 1)
    const secondPage = await repository.listReports(
      'workspace-quota',
      1,
      firstPage.nextCursor,
    )
    expect(firstPage.reports.map((report) => report.id)).toEqual(['first'])
    expect(firstPage.nextCursor).toBeDefined()
    expect(secondPage.reports.map((report) => report.id)).toEqual(['second'])
    expect(secondPage.nextCursor).toBeUndefined()
    counter!.reportCount = MAX_ANALYTICS_REPORTS_PER_WORKSPACE

    await expect(repository.createReport(
      'workspace-quota',
      'member-1',
      createReportInput({ id: 'over-quota' }),
    )).rejects.toMatchObject({
      code: 'AnalyticsReportQuotaExceeded',
      status: 409,
    })
    expect([...fake.rows.values()].some((row) => row.id === 'over-quota')).toBeFalse()

    counter!.reportCount = 2
    await repository.deleteReport(first.workspaceId, first.id, first.revision)
    expect(counter?.reportCount).toBe(1)
    await expect(repository.createReport(
      'workspace-quota',
      'member-1',
      createReportInput({ id: 'replacement' }),
    )).resolves.toMatchObject({ id: 'replacement' })
    expect(counter?.reportCount).toBe(2)
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
    expect((await repository.listSnapshots('workspace-1', report.id)).snapshots)
      .toEqual([record])
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

  test('rejects oversized serialized snapshot records before persistence', async () => {
    const largeValue = '界'.repeat(60_000)
    const query = createQuery([], {
      filter: {
        period,
        customFields: [{
          fieldId: 'large-value',
          operator: 'equals',
          value: largeValue,
        }],
      },
    })
    const snapshot = createTestAnalyticsSnapshot({
      workItems: [],
      events: [],
      query,
    })
    const record: AnalyticsSnapshotRecord = {
      id: 'oversized',
      workspaceId: 'workspace-1',
      createdByMemberKey: 'member-1',
      createdAt: period.to,
      query,
      snapshot,
    }

    expect(Buffer.byteLength(JSON.stringify(record), 'utf8'))
      .toBeGreaterThan(MAX_ANALYTICS_SNAPSHOT_RECORD_SERIALIZED_BYTES)
    expect(() => validateAnalyticsSnapshotRecordSize(record)).toThrow(
      expect.objectContaining({
        code: 'AnalyticsSnapshotRecordTooLarge',
        status: 413,
      }),
    )
    await expect(new InMemoryAnalyticsRepository().putSnapshot(record))
      .rejects.toMatchObject({
        code: 'AnalyticsSnapshotRecordTooLarge',
        status: 413,
      })
    const fake = createDynamoDocumentClient()
    await expect(
      new DynamoDbAnalyticsRepository('analytics-table', fake.client)
        .putSnapshot(record),
    ).rejects.toMatchObject({
      code: 'AnalyticsSnapshotRecordTooLarge',
      status: 413,
    })
    expect(fake.commands).toHaveLength(0)
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
    expect(await repository.getDeliveryReceipt(
      receipt.workspaceId,
      receipt.reportId,
      receipt.occurrenceKey,
    )).toEqual(receipt)
    expect(await repository.getDeliveryReceipt(
      receipt.workspaceId,
      receipt.reportId,
      'missing-occurrence',
    )).toBeUndefined()
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
    for (const reference of firstPage.reports) {
      const report = await repository.getReport(reference.workspaceId, reference.id)
      expect(report).toBeDefined()
      await repository.updateReport(reference.workspaceId, reference.id, {
        expectedRevision: report!.revision,
        schedule: {
          ...report!.schedule!,
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

  test('matches DynamoDB UTF-8 ordering for non-ASCII due cursor boundaries', async () => {
    const firstWorkspaceId = 'workspace-\uE000'
    const secondWorkspaceId = 'workspace-\u{10000}'
    expect(compareDynamoDbStringSortKeys(firstWorkspaceId, secondWorkspaceId))
      .toBeLessThan(0)

    const firstIdsByShard = new Map<string, string>()
    for (let index = 0; index < 64; index += 1) {
      const id = `first-${index}`
      const shard = createAnalyticsScheduleShard(firstWorkspaceId, id)
      if (!firstIdsByShard.has(shard)) firstIdsByShard.set(shard, id)
    }
    let matching: { shard: string; firstId: string; secondId: string } | undefined
    for (let index = 0; index < 64 && matching === undefined; index += 1) {
      const secondId = `second-${index}`
      const shard = createAnalyticsScheduleShard(secondWorkspaceId, secondId)
      const firstId = firstIdsByShard.get(shard)
      if (firstId !== undefined) matching = { shard, firstId, secondId }
    }
    expect(matching).toBeDefined()

    const nextRunAt = '2026-01-08T08:00:00.000Z'
    const definitions = [{
      workspaceId: firstWorkspaceId,
      id: matching!.firstId,
    }, {
      workspaceId: secondWorkspaceId,
      id: matching!.secondId,
    }]
    const expectedIds = [...definitions]
      .sort((left, right) =>
        compareDynamoDbStringSortKeys(
          createAnalyticsNextDeliveryAtRecordKey(
            nextRunAt,
            left.workspaceId,
            left.id,
          ),
          createAnalyticsNextDeliveryAtRecordKey(
            nextRunAt,
            right.workspaceId,
            right.id,
          ),
        )
      )
      .map((definition) => definition.id)
    const fake = createDynamoDocumentClient()
    const repositories = [
      new InMemoryAnalyticsRepository(),
      new DynamoDbAnalyticsRepository('analytics-table', fake.client),
    ]
    for (const repository of repositories) {
      for (const definition of definitions) {
        await repository.createReport(
          definition.workspaceId,
          'member-1',
          createReportInput({
            id: definition.id,
            schedule: {
              enabled: true,
              frequency: 'daily',
              timeZone: 'UTC',
              localTime: '08:00',
              recipientMemberKeys: ['member-1'],
              format: 'pdf',
              nextRunAt,
            },
          }),
        )
      }
      const firstPage = await repository.listDueReports(
        matching!.shard,
        '2026-01-08T09:00:00.000Z',
        1,
      )
      const secondPage = await repository.listDueReports(
        matching!.shard,
        '2026-01-08T09:00:00.000Z',
        1,
        firstPage.nextCursor,
      )
      const references = [...firstPage.reports, ...secondPage.reports]
      expect(references.map((reference) => reference.id)).toEqual(expectedIds)
      expect(references.every((reference) =>
        Object.keys(reference).sort().join(',') === 'id,workspaceId'
      )).toBeTrue()
    }
  })

  test('orders equal-time snapshots by their DynamoDB record keys', async () => {
    const query = createQuery([])
    const snapshot = createTestAnalyticsSnapshot({ workItems: [], events: [], query })
    const records = ['snapshot-\uE000', 'snapshot-\u{10000}'].map((id) => ({
      id,
      workspaceId: 'workspace-1',
      reportId: 'report-1',
      reportRevision: 1,
      createdByMemberKey: 'member-1',
      createdAt: '2026-01-08T09:00:00.000Z',
      query,
      snapshot,
    } satisfies AnalyticsSnapshotRecord))
    const expectedIds = [...records]
      .sort((left, right) =>
        compareDynamoDbStringSortKeys(
          encodeURIComponent(right.id),
          encodeURIComponent(left.id),
        )
      )
      .map((record) => record.id)
    const memory = new InMemoryAnalyticsRepository()
    const fake = createDynamoDocumentClient()
    const dynamo = new DynamoDbAnalyticsRepository('analytics-table', fake.client)
    for (const record of records) {
      await memory.putSnapshot(record)
      await dynamo.putSnapshot(record)
    }

    expect((await memory.listSnapshots('workspace-1', 'report-1')).snapshots
      .map((record) => record.id)).toEqual(expectedIds)
    expect((await dynamo.listSnapshots('workspace-1', 'report-1')).snapshots
      .map((record) => record.id)).toEqual(expectedIds)
  })

  test('paginates snapshot history with scoped cursors and bounded DynamoDB queries', async () => {
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
    for (const repository of [memory, dynamo]) {
      const firstPageRecords: AnalyticsSnapshotRecord[] = []
      let cursor: string | undefined
      do {
        const page = await repository.listSnapshots(
          'workspace-1',
          'report-1',
          100 - firstPageRecords.length,
          cursor,
        )
        firstPageRecords.push(...page.snapshots)
        cursor = page.nextCursor
      } while (firstPageRecords.length < 100 && cursor !== undefined)
      expect(firstPageRecords.map((record) => record.id)).toEqual(expectedIds)
      expect(cursor).toBeDefined()
      const finalPage = await repository.listSnapshots(
        'workspace-1',
        'report-1',
        100,
        cursor,
      )
      expect(finalPage.snapshots.map((record) => record.id))
        .toEqual(['snapshot-000'])
      expect(finalPage.nextCursor).toBeUndefined()
      await expect(repository.listSnapshots(
        'workspace-1',
        'other-report',
        1,
        cursor,
      )).rejects.toMatchObject({ code: 'AnalyticsCursorInvalid' })
      await expect(repository.listSnapshots(
        'other-workspace',
        'report-1',
        1,
        cursor,
      )).rejects.toMatchObject({ code: 'AnalyticsCursorInvalid' })
    }
    const snapshotQueries = fake.commands.filter((command) =>
      command instanceof QueryCommand &&
      command.input.ExpressionAttributeValues?.[':recordPrefix'] ===
        'SNAPSHOT#report-1#'
    ) as QueryCommand[]
    expect(snapshotQueries.map((command) => command.input.Limit))
      .toEqual([100, 83, 66, 49, 32, 15, 100])
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
  }, 10_000)

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
    const createTransaction = fake.commands.find((command) =>
      command instanceof TransactWriteCommand &&
      command.input.TransactItems?.some((item) =>
        item.Put?.Item?.entryType === 'analytics-report'
      )
    ) as TransactWriteCommand
    expect(createTransaction.input.TransactItems?.[0]?.Update?.ConditionExpression)
      .toContain('#reportCount < :maximum')
    expect(createTransaction.input.TransactItems?.[1]?.Put?.ConditionExpression)
      .toContain('attribute_not_exists')

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
      '2026-01-08T09:00:00.000Z$',
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
    expect((await repository.listSnapshots('workspace-1', report.id)).snapshots)
      .toEqual([record])

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
    expect(await repository.getDeliveryReceipt(
      receipt.workspaceId,
      receipt.reportId,
      receipt.occurrenceKey,
    )).toEqual(receipt)
    const receiptGet = [...fake.commands]
      .reverse()
      .find((command) =>
        command instanceof GetCommand &&
        String(command.input.Key?.recordKey).startsWith('DELIVERY#')
      ) as GetCommand
    expect(receiptGet.input.ConsistentRead).toBeTrue()
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
    expect((await memory.listSnapshots('workspace-1', 'report-a')).snapshots)
      .toEqual([first])
    expect((await memory.listSnapshots('workspace-1', 'report-b')).snapshots)
      .toEqual([])

    const fake = createDynamoDocumentClient()
    const dynamo = new DynamoDbAnalyticsRepository('analytics-table', fake.client)
    await dynamo.putSnapshot(first)
    await expect(dynamo.putSnapshot(second)).rejects.toMatchObject({
      code: 'AnalyticsSnapshotConflict',
    })
    expect((await dynamo.listSnapshots('workspace-1', 'report-a')).snapshots)
      .toEqual([first])
    expect((await dynamo.listSnapshots('workspace-1', 'report-b')).snapshots)
      .toEqual([])
    expect([...fake.rows.values()].filter(
      (row) => row.entryType === 'analytics-snapshot-id',
    )).toHaveLength(1)
  })
})

describe('Analytics Workspace calendar', () => {
  const weeklyChart = createQuery([{
    id: 'weekly',
    title: 'Weekly throughput',
    type: 'chart',
    metric: 'throughput',
    groupBy: { dimension: 'week' },
  }])

  test('starts week buckets on Monday when the query names no week start', () => {
    const snapshot = createTestAnalyticsSnapshot({ workItems: [], events: [], query: weeklyChart })
    expect(snapshot.widgets[0]?.series?.map((point) => point.from)).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-05T00:00:00.000Z',
    ])
  })

  test('starts week buckets on the query week start day', () => {
    const snapshot = createTestAnalyticsSnapshot({
      workItems: [],
      events: [],
      query: { ...weeklyChart, weekStartDay: 0 },
    })
    expect(snapshot.widgets[0]?.series?.map((point) => [point.from, point.to])).toEqual([
      ['2026-01-01T00:00:00.000Z', '2026-01-03T23:59:59.999Z'],
      ['2026-01-04T00:00:00.000Z', '2026-01-07T00:00:00.000Z'],
    ])
    expect(normalizeAnalyticsQueryInput({ ...weeklyChart, weekStartDay: 0 }).weekStartDay).toBe(0)
    expect(normalizeAnalyticsQueryInput({ ...weeklyChart, weekStartDay: 1 })).not.toHaveProperty('weekStartDay')
  })

  test('starts week group rows on the query week start day in the report time zone', () => {
    const snapshot = createTestAnalyticsSnapshot({
      workItems: [],
      events: [],
      query: {
        ...weeklyChart,
        timeZone: 'Asia/Tokyo',
        weekStartDay: 6,
        widgets: [{
          id: 'weekly-table',
          title: 'Weekly remaining',
          type: 'table',
          metric: 'remaining-scope',
          groupBy: { dimension: 'week' },
        }],
      },
    })
    // The period starts on Thursday 2026-01-01 in Tokyo; the second week starts on Saturday.
    expect(snapshot.widgets[0]?.groups?.map((group) => group.key)).toEqual(['2026-01-01', '2026-01-03'])
  })

  test('rejects an unknown week start day and period preset', () => {
    expect(() => normalizeAnalyticsQueryInput({ ...weeklyChart, weekStartDay: 7 }))
      .toThrow('week start day')
    expect(() => normalizeAnalyticsQueryInput({
      ...weeklyChart,
      filter: { period, periodPreset: 'next-week' },
    })).toThrow('period preset')
  })

  test('keeps a period preset on the normalized filter and report', async () => {
    expect(normalizeAnalyticsQueryInput({
      ...weeklyChart,
      filter: { period, periodPreset: 'this-week' },
    }).filter.periodPreset).toBe('this-week')
    const repository = new InMemoryAnalyticsRepository()
    const report = await repository.createReport('workspace-1', 'member-1', createReportInput({
      filter: { period, periodPreset: 'last-fiscal-quarter' },
    }))
    expect(report.filter.periodPreset).toBe('last-fiscal-quarter')
  })

  test('re-resolves a saved relative period around the run time', () => {
    const calendar = { fiscalYearStartMonth: 4, weekStartDay: 0 } as const
    // Wednesday 2026-11-25 09:00 Tokyo.
    expect(resolveAnalyticsReportFilterPeriod(
      { period, periodPreset: 'this-week', teamIds: ['core'] },
      '2026-11-25T00:00:00.000Z',
      'Asia/Tokyo',
      calendar,
    )).toEqual({
      period: { from: '2026-11-21T15:00:00.000Z', to: '2026-11-28T14:59:59.999Z' },
      periodPreset: 'this-week',
      teamIds: ['core'],
    })
    expect(resolveAnalyticsReportFilterPeriod(
      { period, periodPreset: 'last-fiscal-year' },
      '2026-11-25T00:00:00.000Z',
      'UTC',
      calendar,
    ).period).toEqual({ from: '2025-04-01T00:00:00.000Z', to: '2026-03-31T23:59:59.999Z' })
    const fixed = { period }
    expect(resolveAnalyticsReportFilterPeriod(fixed, '2026-11-25T00:00:00.000Z', 'UTC', calendar))
      .toEqual(fixed)
    // Beirut skips 00:00-01:00 on Sunday 2026-03-29, so that week starts at 01:00 local time.
    expect(resolveAnalyticsReportFilterPeriod(
      { period, periodPreset: 'this-week' },
      '2026-03-31T09:00:00.000Z',
      'Asia/Beirut',
      calendar,
    ).period.from).toBe('2026-03-28T22:00:00.000Z')
  })
})
