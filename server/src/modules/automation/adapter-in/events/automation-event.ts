import type { AutomationValue } from '@mukuroji/contracts'
import { AutomationEngine } from '../../application/execution-service'
import type {
  AutomationActionExecutor,
  AutomationExecutionServicePort,
  AutomationFeatureEntitlementPort,
  AutomationRuleTemplatePort,
} from '../../application/ports'
import { AutomationError } from '../../domain/automation-error'
import type { AutomationEvent } from '../../domain/rule-evaluation'
import type {
  BatchItemFailure,
  BatchResponse,
  DynamoAttributeValue,
  DynamoStreamEvent,
  DynamoStreamRecord,
} from '../../../../infrastructure/aws/dynamodb-stream'

export type {
  BatchResponse,
  DynamoStreamEvent,
} from '../../../../infrastructure/aws/dynamodb-stream'

/** Audit outbox event を automation rules へ配送する processor です。 */
export type AutomationEventProcessor = {
  /** 一つの canonical event を eligible rules へ配送します。 */
  process(event: AutomationEvent): Promise<void>
}

/** Automation event hydration に必要な canonical Work Item reader です。 */
export interface AutomationWorkItemReader {
  /** Current canonical Work Item detail を強整合 read します。 */
  getTeamIssueDetail(
    workspaceId: string,
    teamId: string,
    workItemId: string,
    options: {
      /** Canonical item を strongly consistent read するかどうかです。 */
      consistentIssueRead: boolean
      /** Activity events の最大読込件数です。 */
      eventLimit: number
    },
  ): Promise<{
    /** Automation event に添付する canonical Work Item です。 */
    issue: unknown
  }>
}

/** Focused Rule-read and execution capabilities required by event delivery. */
export type AutomationEventPort = AutomationExecutionServicePort &
  Pick<AutomationRuleTemplatePort, 'listRules'>

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
      'invalid-input',
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
  if (
    !eventId ||
    !eventType ||
    !workspaceId ||
    !occurredAt ||
    Number.isNaN(Date.parse(occurredAt))
  ) {
    throw new AutomationError(
      'invalid-input',
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

/**
 * Durable action failure を scheduler へ引き渡す audit event processor を作成します。
 *
 * @param client - Focused Automation persistence capabilities.
 * @param entitlement - Server-side Automation feature gate.
 * @param engine - Rule execution engine.
 * @param workItems - Optional canonical Work Item reader used for hydration.
 * @returns A durable Automation event processor.
 */
export function createAutomationEventProcessor(
  client: AutomationEventPort,
  entitlement: AutomationFeatureEntitlementPort,
  engine: Pick<AutomationEngine, 'handleEvent'> = new AutomationEngine(
    client,
    createUnavailableAutomationActionExecutor(),
  ),
  workItems?: AutomationWorkItemReader,
): AutomationEventProcessor {
  return {
    async process(event) {
      if (!await entitlement.isAutomationEnabled(event.workspaceId)) return
      const rules = await client.listRules(event.workspaceId)
      const hydratedEvent = await hydrateAutomationWorkItem(event, workItems)
      await Promise.all(rules.map(async (rule) =>
        await engine.handleEvent(rule, hydratedEvent)
      ))
    },
  }
}

async function hydrateAutomationWorkItem(
  event: AutomationEvent,
  workItems: AutomationWorkItemReader | undefined,
): Promise<AutomationEvent> {
  const teamId = readText(event.metadata?.teamId)
  const workItemId = readText(event.metadata?.issueId) ?? readText(event.metadata?.workItemId)
  if (!teamId || !workItemId || !workItems) return event
  try {
    const detail = await workItems.getTeamIssueDetail(
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

/** Missing composition を deterministic configuration error に変換します。 */
function createUnavailableAutomationActionExecutor(): AutomationActionExecutor {
  return {
    async execute() {
      throw new AutomationError(
        'unavailable',
        'AutomationActionExecutorUnavailable',
        'Automation action execution is not configured.',
        true,
      )
    },
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
