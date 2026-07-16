import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { AutomationValue } from '@mukuroji/contracts'
import {
  AutomationEngine,
  AutomationError,
  DynamoDbAutomationClient,
  type AutomationClient,
  type AutomationEvent,
} from './automation'
import {
  DynamoDbTeamIssuesClient,
  createAutomationActionExecutor,
} from './index'
import type {
  BatchItemFailure,
  BatchResponse,
  DynamoAttributeValue,
  DynamoStreamEvent,
  DynamoStreamRecord,
} from './collaboration-projection-handler'

/** Audit outbox event を automation rules へ配送する processor です。 */
export type AutomationEventProcessor = {
  /** 一つの canonical event を eligible rules へ配送します。 */
  process(event: AutomationEvent): Promise<void>
}

const dynamoDbClient = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'us-east-1' })
const documentClient = DynamoDBDocumentClient.from(dynamoDbClient, {
  marshallOptions: { removeUndefinedValues: true },
})
const automationClient = new DynamoDbAutomationClient(
  process.env.AUTOMATION_TABLE_NAME ?? 'mukuroji-automation',
  documentClient,
  dynamoDbClient,
)
const workItemsClient = new DynamoDbTeamIssuesClient()

/** AuditEventsTable stream から version 固定 automation executions を開始します。 */
export async function handler(event: DynamoStreamEvent): Promise<BatchResponse> {
  return await processAutomationEventBatch(event, createAutomationEventProcessor(automationClient))
}

/** Stream batch を record 単位で処理し、失敗した sequence だけを再配送させます。 */
export async function processAutomationEventBatch(
  event: DynamoStreamEvent,
  processor: AutomationEventProcessor,
): Promise<BatchResponse> {
  const records = event.Records ?? []
  for (const record of records) {
    try {
      const automationEvent = parseAutomationStreamRecord(record)
      if (automationEvent) await processor.process(automationEvent)
    } catch (error) {
      console.error('Automation event processing failed:', error)
      const failure = createBatchItemFailure(record)
      if (!failure) throw error
      return { batchItemFailures: [failure] }
    }
  }
  return { batchItemFailures: [] }
}

/** Audit DynamoDB stream record を automation event へ正規化します。 */
export function parseAutomationStreamRecord(record: DynamoStreamRecord) {
  if (record.eventName !== 'INSERT') return undefined
  if (!record.dynamodb?.NewImage) {
    throw new AutomationError(
      400,
      'AutomationOutboxEventMalformed',
      'Inserted automation outbox record is missing NewImage.',
    )
  }
  const value = unmarshalMap(record.dynamodb.NewImage)
  if (value.outboxStatus === 'suppressed') return undefined
  const eventId = readText(value.eventId)
  const eventType = readText(value.eventType)
  const workspaceId = readText(value.workspaceId) ?? readText(value.directoryId)
  const occurredAt = readText(value.occurredAt)
  if (!eventId || !eventType || !workspaceId || !occurredAt) {
    throw new AutomationError(
      400,
      'AutomationOutboxEventMalformed',
      'Inserted automation outbox record is missing required event fields.',
    )
  }
  const metadata = isRecord(value.metadata) && isAutomationRecord(value.metadata)
    ? value.metadata
    : undefined
  const sourceDetails = isRecord(value.sourceDetails) ? value.sourceDetails : undefined
  const lineage = readAutomationLineage(metadata?.automationRuleLineage) ??
    readAutomationLineageRoute(sourceDetails?.route)
  return {
    eventId,
    eventType,
    workspaceId,
    occurredAt,
    changes: readAutomationChanges(value.changes),
    ...(metadata ? { metadata } : {}),
    ...(lineage ? { automationRuleLineage: lineage } : {}),
  } satisfies AutomationEvent
}

/** Durable action failure を scheduler へ引き渡す audit event processor を作成します。 */
export function createAutomationEventProcessor(
  client: AutomationClient,
  engine: Pick<AutomationEngine, 'handleEvent'> = new AutomationEngine(
    client,
    createAutomationActionExecutor(),
  ),
): AutomationEventProcessor {
  return {
    async process(event) {
      const rules = await client.listRules(event.workspaceId)
      const hydratedEvent = await hydrateAutomationWorkItem(event)
      await Promise.all(rules.map(async (rule) =>
        await engine.handleEvent(rule, hydratedEvent)
      ))
    },
  }
}

async function hydrateAutomationWorkItem(event: AutomationEvent): Promise<AutomationEvent> {
  const teamId = readText(event.metadata?.teamId)
  const workItemId = readText(event.metadata?.issueId) ?? readText(event.metadata?.workItemId)
  if (!teamId || !workItemId) return event
  try {
    const detail = await workItemsClient.getTeamIssueDetail(
      event.workspaceId,
      teamId,
      workItemId,
      { consistentIssueRead: true, eventLimit: 0 },
    )
    const workItem = structuredClone(detail.issue) as unknown
    return isRecord(workItem) && isAutomationRecord(workItem)
      ? { ...event, workItem }
      : event
  } catch (error) {
    if (isRecord(error) && error.status === 404) return event
    throw error
  }
}

function readAutomationChanges(value: unknown): AutomationEvent['changes'] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return []
    const field = readText(candidate.field)
    if (!field) return []
    const before = isAutomationValue(candidate.before) ? candidate.before : undefined
    const after = isAutomationValue(candidate.after) ? candidate.after : undefined
    return [{
      field,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    }]
  })
}

function readAutomationLineage(value: AutomationValue | undefined) {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return undefined
  return value as string[]
}

function readAutomationLineageRoute(value: unknown) {
  const route = readText(value)
  if (!route?.startsWith('automation-lineage:')) return undefined
  return route.slice('automation-lineage:'.length).split(',').filter(Boolean)
}

function createBatchItemFailure(record: DynamoStreamRecord): BatchItemFailure | undefined {
  const identifier = record.dynamodb?.SequenceNumber ?? record.eventID
  return identifier ? { itemIdentifier: identifier } : undefined
}

function unmarshalMap(value: Record<string, DynamoAttributeValue>) {
  return Object.fromEntries(
    Object.entries(value).map(([key, attribute]) => [key, unmarshalAttribute(attribute)]),
  )
}

function unmarshalAttribute(value: DynamoAttributeValue): unknown {
  if (value.S !== undefined) return value.S
  if (value.N !== undefined) return Number(value.N)
  if (value.BOOL !== undefined) return value.BOOL
  if (value.NULL) return null
  if (value.L) return value.L.map(unmarshalAttribute)
  if (value.M) return unmarshalMap(value.M)
  if (value.SS) return value.SS
  if (value.NS) return value.NS.map(Number)
  return undefined
}

function isAutomationRecord(value: Record<string, unknown>): value is Record<string, AutomationValue> {
  return Object.values(value).every(isAutomationValue)
}

function isAutomationValue(value: unknown): value is AutomationValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isAutomationValue)
  return isRecord(value) && Object.values(value).every(isAutomationValue)
}

function readText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
