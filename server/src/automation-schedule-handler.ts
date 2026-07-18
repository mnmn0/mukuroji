import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  AUTOMATION_SCHEMA_VERSION,
  type AutomationAction,
  type AutomationExecution,
  type AutomationRule,
  type RecurringWork,
} from '@mukuroji/contracts'
import {
  AUTOMATION_SCHEDULE_SHARD_COUNT,
  DEFAULT_AUTOMATION_RETRY_POLICY,
  AutomationEngine,
  AutomationError,
  DynamoDbAutomationClient,
  createAutomationActionId,
  createAutomationExecutionId,
  createRecurringExecutionId,
  getNextRecurringOccurrence,
  getRecurringOccurrences,
  normalizeAutomationActionFailure,
  selectCatchUpOccurrences,
  type AutomationActionExecutor,
  type AutomationClient,
  type AutomationEvent,
  type AutomationExecutionClaimToken,
  type AutomationInboundWebhookSecretCleanup,
} from './automation'
import {
  SecretsManagerAutomationInboundWebhookSecretStore,
  type AutomationInboundWebhookSecretStore,
} from './automation-inbound-webhook'
import { createAutomationActionExecutor } from './index'

/** Schedule invocation の dependency contract です。 */
export type AutomationScheduleDependencies = {
  /** Automation definitions、execution、receipts の durable store です。 */
  client: AutomationClient
  /** Recurring Work Item create action の executor です。 */
  actionExecutor: AutomationActionExecutor
  /** Revoke 済み inbound webhook secret の durable cleanup store です。 */
  inboundWebhookSecrets?: AutomationInboundWebhookSecretStore
}

/** EventBridge schedule event のうち handler が利用する最小表現です。 */
export type AutomationScheduleEvent = {
  /** EventBridge が渡す schedule timestamp です。 */
  time?: string
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
const automationInboundWebhookSecrets =
  new SecretsManagerAutomationInboundWebhookSecretStore()
const RECURRING_ACTION_LEASE_MS = 5 * 60_000

/** EventBridge timestamp を検証し、runner lease 用の wall-clock 時刻を返します。 */
export function resolveAutomationScheduleProcessingTime(
  event: AutomationScheduleEvent,
  wallClock = new Date(),
) {
  if (event.time && Number.isNaN(Date.parse(event.time))) {
    throw new AutomationError(400, 'AutomationScheduleTimeInvalid', 'Schedule time is invalid.')
  }
  return wallClock
}

/** Due recurring definitions を timezone/DST policy に従って materialize します。 */
export async function handler(event: AutomationScheduleEvent = {}) {
  const now = resolveAutomationScheduleProcessingTime(event)
  return await processAutomationSchedule(now, {
    client: automationClient,
    actionExecutor: createAutomationActionExecutor(),
    inboundWebhookSecrets: automationInboundWebhookSecrets,
  })
}

/** 全 due-index shards を走査して recurring definitions を処理します。 */
export async function processAutomationSchedule(
  now: Date,
  dependencies: AutomationScheduleDependencies,
) {
  const dueAt = now.toISOString()
  const pages = await Promise.all(
    Array.from({ length: AUTOMATION_SCHEDULE_SHARD_COUNT }, async (_, index) => {
      const shard = `schedule-${String(index).padStart(2, '0')}`
      return await Promise.all([
        dependencies.client.listDueRecurringWorks(
          shard,
          dueAt,
          25,
        ),
        dependencies.client.listDueScheduledRules(
          shard,
          dueAt,
          25,
        ),
        dependencies.client.listDueExecutions(
          shard,
          dueAt,
          25,
        ),
        dependencies.inboundWebhookSecrets
          ? dependencies.client.listDueInboundWebhookSecretCleanups(
              shard,
              dueAt,
              25,
            )
          : Promise.resolve([]),
      ])
    }),
  )
  const definitions = pages.flatMap(([recurring]) => recurring)
  const scheduledRules = pages.flatMap(([, rules]) => rules)
  const dueExecutions = pages.flatMap(([, , executions]) => executions)
  const inboundWebhookSecretCleanups = pages.flatMap(([, , , cleanups]) => cleanups)
  const retryResults = await Promise.allSettled(
    dueExecutions.map(async (execution) => {
      await processDueAutomationExecution(execution, now, dependencies)
    }),
  )
  const scheduleResults = await Promise.allSettled([
    ...definitions.map(async (definition) => {
      await processRecurringWorkDefinition(definition, now, dependencies)
    }),
    ...scheduledRules.map(async (rule) => {
      await processScheduledAutomationRule(rule, now, dependencies)
    }),
    ...inboundWebhookSecretCleanups.map(async (cleanup) => {
      await processInboundWebhookSecretCleanup(cleanup, now, dependencies)
    }),
  ])
  const results = [...retryResults, ...scheduleResults]
  const failures = results.filter((result) => result.status === 'rejected')
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `${failures.length} automation schedule entries failed.`,
    )
  }
  return {
    processedDefinitions: definitions.length,
    processedScheduledRules: scheduledRules.length,
    processedDueExecutions: dueExecutions.length,
  }
}

/** Revoke tombstone の期限まで DeleteSecret を反復して late write を回収します。 */
export async function processInboundWebhookSecretCleanup(
  cleanup: AutomationInboundWebhookSecretCleanup,
  now: Date,
  dependencies: AutomationScheduleDependencies,
) {
  const secretStore = dependencies.inboundWebhookSecrets
  if (!secretStore) return
  await secretStore.delete(cleanup)
  await dependencies.client.completeInboundWebhookSecretCleanup(
    cleanup,
    now.toISOString(),
  )
}

/** Due execution を保存済み immutable rule version/event だけで retry します。 */
export async function processDueAutomationExecution(
  execution: AutomationExecution,
  now: Date,
  dependencies: AutomationScheduleDependencies,
) {
  if (!execution.nextRetryAt || execution.nextRetryAt > now.toISOString()) {
    return execution
  }
  const engine = new AutomationEngine(dependencies.client, dependencies.actionExecutor)
  try {
    if (execution.ruleId.startsWith('recurring:')) {
      const recurringWorkId = execution.ruleId.slice('recurring:'.length)
      const definition = recurringWorkId
        ? await dependencies.client.getRecurringWork(execution.workspaceId, recurringWorkId)
        : undefined
      if (!definition?.enabled) return execution
      const retryableFailure = execution.status === 'failed' && execution.retryable
      const expiredRunner = execution.status === 'running' &&
        (!execution.nextRetryAt || execution.nextRetryAt <= now.toISOString())
      if (!retryableFailure && !expiredRunner) return execution
      return await engine.retryExecution(execution.workspaceId, execution.id, undefined, now)
    }
    if (execution.status === 'failed' && execution.retryable) {
      return await engine.retryExecution(execution.workspaceId, execution.id, undefined, now)
    }
    if (execution.status !== 'running') return execution
    const rule = await dependencies.client.getRuleVersion(
      execution.workspaceId,
      execution.ruleId,
      execution.ruleVersion,
    )
    if (!rule) {
      throw new AutomationError(
        503,
        'AutomationRuleVersionUnavailable',
        'Automation rule version is unavailable.',
        true,
      )
    }
    const event = await dependencies.client.getExecutionEvent(execution.workspaceId, execution.id)
    if (!event) {
      throw new AutomationError(
        503,
        'AutomationTriggerEventUnavailable',
        'Automation trigger event is unavailable.',
        true,
      )
    }
    return await engine.handleEvent(rule, event, {}, now) ?? execution
  } catch (error) {
    if (!isBenignRetryRace(error)) throw error
    return await dependencies.client.getExecution(execution.workspaceId, execution.id) ?? execution
  }
}

/** 一つの schedule-trigger rule の due/catch-up slots を実行し CAS で進めます。 */
export async function processScheduledAutomationRule(
  scheduledRule: AutomationRule,
  now: Date,
  dependencies: AutomationScheduleDependencies,
) {
  const rule = await dependencies.client.getRule(scheduledRule.workspaceId, scheduledRule.id)
  if (!rule) return scheduledRule
  if (
    !rule.enabled ||
    rule.trigger.type !== 'schedule' ||
    !rule.nextRunAt ||
    new Date(rule.nextRunAt) > now
  ) {
    return rule
  }
  const dueStart = new Date(new Date(rule.nextRunAt).getTime() - 1)
  const dueOccurrences = getRecurringOccurrences(rule.trigger.schedule, dueStart, now)
  const fallbackOccurrence = new Date(rule.nextRunAt)
  const occurrences = dueOccurrences.length > 0 ? dueOccurrences : [fallbackOccurrence]
  const selected = await selectScheduledRuleDueOccurrences(
    rule,
    occurrences,
    rule.trigger.schedule.maxCatchUpOccurrences ?? 100,
    now,
    dependencies.client,
  )
  const engine = new AutomationEngine(dependencies.client, dependencies.actionExecutor)

  for (const occurrence of selected) {
    let execution: AutomationExecution | undefined
    try {
      execution = await engine.handleEvent(rule, {
        eventId: `scheduled-rule:${rule.id}:${occurrence.toISOString()}`,
        eventType: 'automation.schedule',
        workspaceId: rule.workspaceId,
        occurredAt: occurrence.toISOString(),
        changes: [],
        metadata: {
          ruleId: rule.id,
          scheduledFor: occurrence.toISOString(),
        },
      }, {}, now)
    } catch (error) {
      if (isBenignRetryRace(error)) return rule
      throw error
    }
    if (execution?.status === 'failed' && execution.retryable) return rule
  }

  const lastCompleted = selected.at(-1) ?? occurrences.at(-1)!
  const nextRun = getNextRecurringOccurrence(rule.trigger.schedule, lastCompleted)
  if (!nextRun) {
    throw new AutomationError(409, 'AutomationScheduleExhausted', 'Automation schedule has no next occurrence.')
  }
  try {
    return await dependencies.client.completeScheduledRule(
      rule.workspaceId,
      rule.id,
      rule.revision,
      lastCompleted.toISOString(),
      nextRun.toISOString(),
    )
  } catch (error) {
    const current = await dependencies.client.getRule(rule.workspaceId, rule.id)
    if (current?.lastRunAt && current.lastRunAt >= lastCompleted.toISOString()) return current
    throw error
  }
}

/** 一つの recurring definition の due/catch-up slots を実行し CAS で進めます。 */
export async function processRecurringWorkDefinition(
  scheduledDefinition: RecurringWork,
  now: Date,
  dependencies: AutomationScheduleDependencies,
) {
  const definition = await dependencies.client.getRecurringWork(
    scheduledDefinition.workspaceId,
    scheduledDefinition.id,
  )
  if (!definition) return scheduledDefinition
  if (!definition.enabled || new Date(definition.nextRunAt) > now) return definition
  const dueStart = new Date(new Date(definition.nextRunAt).getTime() - 1)
  const dueOccurrences = getRecurringOccurrences(definition.schedule, dueStart, now)
  const fallbackOccurrence = new Date(definition.nextRunAt)
  const occurrences = dueOccurrences.length > 0 ? dueOccurrences : [fallbackOccurrence]
  const selected = await selectRecurringDueOccurrences(
    definition,
    occurrences,
    fallbackOccurrence,
    definition.schedule.maxCatchUpOccurrences ?? 100,
    now,
    dependencies.client,
  )

  for (const occurrence of selected) {
    const completed = await executeRecurringOccurrence(
      definition,
      occurrence,
      dependencies,
      now,
    )
    if (!completed) return definition
  }

  const lastCompleted = selected.at(-1) ?? occurrences.at(-1)!
  const nextRun = getNextRecurringOccurrence(definition.schedule, lastCompleted)
  if (!nextRun) {
    throw new AutomationError(409, 'RecurringScheduleExhausted', 'Recurring schedule has no next occurrence.')
  }
  try {
    return await dependencies.client.completeRecurringWork(
      definition.workspaceId,
      definition.id,
      definition.revision,
      lastCompleted.toISOString(),
      nextRun.toISOString(),
    )
  } catch (error) {
    const current = await dependencies.client.getRecurringWork(definition.workspaceId, definition.id)
    if (current?.lastRunAt && current.lastRunAt >= lastCompleted.toISOString()) return current
    throw error
  }
}

async function executeRecurringOccurrence(
  definition: RecurringWork,
  occurrence: Date,
  dependencies: AutomationScheduleDependencies,
  now: Date,
) {
  const executionId = createRecurringExecutionId(
    definition.workspaceId,
    definition.id,
    occurrence.toISOString(),
  )
  const actionId = createAutomationActionId(executionId, 0)
  const event: AutomationEvent = {
    eventId: `recurring:${definition.id}:${occurrence.toISOString()}`,
    eventType: 'automation.schedule',
    workspaceId: definition.workspaceId,
    occurredAt: occurrence.toISOString(),
    changes: [],
    metadata: {
      teamId: definition.teamId,
      recurringWorkId: definition.id,
      templateId: definition.templateId,
      templateVersion: definition.templateVersion,
      scheduledFor: occurrence.toISOString(),
    },
  }
  const execution: AutomationExecution = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: executionId,
    workspaceId: definition.workspaceId,
    ruleId: `recurring:${definition.id}`,
    ruleVersion: definition.version,
    triggerEventId: event.eventId,
    status: 'pending',
    attempts: 0,
    actions: [{ actionIndex: 0, actionId, status: 'pending', attempts: 0 }],
    startedAt: now.toISOString(),
    retryable: false,
  }
  const created = await dependencies.client.createExecution(execution, event, {
    kind: 'recurring',
    id: definition.id,
    version: definition.version,
    revision: definition.revision,
  })
  const current = created
    ? execution
    : await dependencies.client.getExecution(definition.workspaceId, executionId)
  if (!current) return false
  const storedEvent = created
    ? event
    : await dependencies.client.getExecutionEvent(definition.workspaceId, executionId)
  if (!storedEvent) {
    throw new AutomationError(
      503,
      'AutomationTriggerEventUnavailable',
      'Automation trigger event is unavailable.',
      true,
    )
  }
  const storedTeamId = readRecurringMetadataText(storedEvent, 'teamId')
  const storedTemplateId = readRecurringMetadataText(storedEvent, 'templateId')
  const storedTemplateVersion = storedEvent.metadata?.templateVersion
  const storedScheduledFor = readRecurringMetadataText(storedEvent, 'scheduledFor')
  if (
    !storedTeamId ||
    !storedTemplateId ||
    !Number.isSafeInteger(storedTemplateVersion) ||
    !storedScheduledFor
  ) {
    throw new AutomationError(503, 'RecurringExecutionInvalid', 'Recurring execution event is invalid.')
  }
  const storedAction: AutomationAction = {
    type: 'create',
    templateId: storedTemplateId,
    templateVersion: storedTemplateVersion as number,
    values: { teamId: storedTeamId },
  }
  if (current.status === 'succeeded' || current.status === 'dead-letter' || current.status === 'skipped') {
    return true
  }
  if (
    (current.status === 'running' || current.status === 'failed') &&
    current.nextRetryAt &&
    current.nextRetryAt > now.toISOString()
  ) {
    return false
  }
  const actionState = current.actions[0]
  if (!actionState) {
    throw new AutomationError(503, 'RecurringExecutionInvalid', 'Recurring execution is invalid.')
  }
  const actionAlreadySucceeded = await dependencies.client.hasActionReceipt(
    definition.workspaceId,
    executionId,
    actionId,
  )
  const leaseExpiresAt = new Date(now.getTime() + RECURRING_ACTION_LEASE_MS).toISOString()
  if (!await dependencies.client.claimExecution(current, now, leaseExpiresAt, {
    kind: 'recurring',
    id: definition.id,
    version: definition.version,
    revision: definition.revision,
  })) {
    const raced = await dependencies.client.getExecution(definition.workspaceId, executionId)
    return isTerminalAutomationExecution(raced)
  }
  current.status = 'running'
  current.attempts += 1
  current.retryable = false
  current.completedAt = undefined
  current.nextRetryAt = leaseExpiresAt
  current.errorCode = undefined
  current.errorMessage = undefined
  const claimToken: AutomationExecutionClaimToken = {
    attempt: current.attempts,
    leaseExpiresAt,
  }
  if (actionAlreadySucceeded) {
    actionState.status = 'succeeded'
    actionState.completedAt ??= now.toISOString()
    actionState.errorCode = undefined
    actionState.errorMessage = undefined
    current.status = 'succeeded'
    current.completedAt = actionState.completedAt
    current.nextRetryAt = undefined
    current.errorCode = undefined
    current.errorMessage = undefined
    if (!await dependencies.client.saveExecution(current, claimToken, now)) {
      return await readRecurringExecutionCompletionAfterLeaseLoss(
        dependencies.client,
        definition.workspaceId,
        executionId,
      )
    }
    return true
  }
  actionState.status = 'running'
  actionState.attempts += 1
  actionState.startedAt ??= now.toISOString()
  actionState.completedAt = undefined
  actionState.errorCode = undefined
  actionState.errorMessage = undefined
  try {
    await dependencies.actionExecutor.execute(storedAction, {
      execution: current,
      event: storedEvent,
      actionIndex: 0,
      idempotencyKey: actionId,
    })
    await dependencies.client.putActionReceipt(definition.workspaceId, executionId, actionId)
    const savedAt = new Date()
    actionState.status = 'succeeded'
    actionState.completedAt = savedAt.toISOString()
    current.status = 'succeeded'
    current.completedAt = actionState.completedAt
    current.nextRetryAt = undefined
    current.errorCode = undefined
    current.errorMessage = undefined
    if (!await dependencies.client.saveExecution(current, claimToken, savedAt)) {
      return await readRecurringExecutionCompletionAfterLeaseLoss(
        dependencies.client,
        definition.workspaceId,
        executionId,
      )
    }
    return true
  } catch (error) {
    const failure = normalizeAutomationActionFailure(error)
    const savedAt = new Date()
    actionState.status = 'failed'
    actionState.completedAt = savedAt.toISOString()
    actionState.errorCode = failure.code
    actionState.errorMessage = failure.message
    current.completedAt = savedAt.toISOString()
    current.errorCode = failure.code
    current.errorMessage = failure.message
    if (failure.retryable && current.attempts < DEFAULT_AUTOMATION_RETRY_POLICY.maxAttempts) {
      current.status = 'failed'
      current.retryable = true
      current.nextRetryAt = new Date(
        now.getTime() + calculateRecurringRetryDelay(current.attempts),
      ).toISOString()
      if (!await dependencies.client.saveExecution(current, claimToken, savedAt)) {
        return await readRecurringExecutionCompletionAfterLeaseLoss(
          dependencies.client,
          definition.workspaceId,
          executionId,
        )
      }
      return false
    }
    current.status = 'dead-letter'
    current.retryable = true
    current.nextRetryAt = undefined
    if (!await dependencies.client.saveExecution(current, claimToken, savedAt)) {
      return await readRecurringExecutionCompletionAfterLeaseLoss(
        dependencies.client,
        definition.workspaceId,
        executionId,
      )
    }
    return true
  }
}

async function readRecurringExecutionCompletionAfterLeaseLoss(
  client: AutomationClient,
  workspaceId: string,
  executionId: string,
) {
  return isTerminalAutomationExecution(await client.getExecution(workspaceId, executionId))
}

function isTerminalAutomationExecution(execution: AutomationExecution | undefined) {
  return execution?.status === 'succeeded' ||
    execution?.status === 'dead-letter' ||
    execution?.status === 'skipped'
}

async function selectScheduledRuleDueOccurrences(
  rule: AutomationRule,
  occurrences: readonly Date[],
  maximum: number,
  now: Date,
  client: AutomationClient,
) {
  if (rule.trigger.type !== 'schedule') return []
  if (rule.trigger.schedule.catchUpPolicy !== 'skip') {
    return selectCatchUpOccurrences(
      occurrences,
      rule.trigger.schedule.catchUpPolicy,
      maximum,
    )
  }
  const firstOccurrence = occurrences[0]
  const onTimeOccurrences = selectOnTimeOccurrences(occurrences, now)
  if (!firstOccurrence || firstOccurrence.getTime() === now.getTime()) return onTimeOccurrences
  const eventId = `scheduled-rule:${rule.id}:${firstOccurrence.toISOString()}`
  const executionId = createAutomationExecutionId(rule, eventId)
  const execution = await client.getExecution(rule.workspaceId, executionId)
  return execution
    ? mergeOccurrences(firstOccurrence, onTimeOccurrences)
    : onTimeOccurrences
}

async function selectRecurringDueOccurrences(
  definition: RecurringWork,
  occurrences: readonly Date[],
  fallbackOccurrence: Date,
  maximum: number,
  now: Date,
  client: AutomationClient,
) {
  const selected = definition.schedule.catchUpPolicy === 'skip'
    ? selectOnTimeOccurrences(occurrences, now)
    : selectCatchUpOccurrences(occurrences, definition.schedule.catchUpPolicy, maximum)
  const executionId = createRecurringExecutionId(
    definition.workspaceId,
    definition.id,
    fallbackOccurrence.toISOString(),
  )
  const execution = await client.getExecution(definition.workspaceId, executionId)
  return execution
    ? mergeOccurrences(fallbackOccurrence, selected).slice(0, maximum)
    : selected
}

function selectOnTimeOccurrences(occurrences: readonly Date[], now: Date) {
  return occurrences.filter((occurrence) => occurrence.getTime() === now.getTime()).slice(-1)
}

function mergeOccurrences(firstOccurrence: Date, occurrences: readonly Date[]) {
  return [firstOccurrence, ...occurrences.filter((occurrence) =>
    occurrence.getTime() !== firstOccurrence.getTime())]
}

function calculateRecurringRetryDelay(attempts: number) {
  return Math.min(
    DEFAULT_AUTOMATION_RETRY_POLICY.maxDelayMs,
    Math.floor(
      DEFAULT_AUTOMATION_RETRY_POLICY.initialDelayMs *
      DEFAULT_AUTOMATION_RETRY_POLICY.backoffMultiplier ** Math.max(0, attempts - 1),
    ),
  )
}

function isBenignRetryRace(error: unknown) {
  return error instanceof AutomationError && (
    error.code === 'AutomationExecutionNotRetryable' ||
    error.code === 'AutomationRetryNotDue'
  )
}

function readRecurringMetadataText(event: AutomationEvent, key: string) {
  const value = event.metadata?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
