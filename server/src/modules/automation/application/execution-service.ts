import {
  type AutomationAction,
  type AutomationExecution,
  type AutomationRetryPolicy,
  type AutomationRule,
  type AutomationValue,
} from '@mukuroji/contracts'
import { normalizeAutomationActionFailure } from './action-failure'
import type {
  AutomationActionExecutor,
  AutomationExecutionClaimToken,
  AutomationExecutionDefinitionGuard,
  AutomationExecutionServicePort,
} from './ports'
import { AutomationError } from '../domain/automation-error'
import {
  createAutomationActionId,
  createAutomationExecutionId,
  createRecurringExecutionId,
} from '../domain/execution-identifiers'
import { DEFAULT_AUTOMATION_RETRY_POLICY } from '../domain/execution-policy'
import { createPendingAutomationExecution } from '../domain/pending-execution'
import {
  evaluateAutomationCondition as evaluateDomainAutomationCondition,
  matchesAutomationTrigger as matchesDomainAutomationTrigger,
  type AutomationEvent,
} from '../domain/rule-evaluation'

const AUTOMATION_EXECUTION_LEASE_MS = 5 * 60_000

/** Executes matched Automation rules with durable idempotent action receipts. */
export class AutomationEngine {
  /** Focused execution persistence capability. */
  private readonly client: AutomationExecutionServicePort
  /** Side-effect executor for domain actions. */
  private readonly actionExecutor: AutomationActionExecutor

  /** Creates an Automation execution service. */
  constructor(client: AutomationExecutionServicePort, actionExecutor: AutomationActionExecutor) {
    this.client = client
    this.actionExecutor = actionExecutor
  }

  /** Applies one durable event to one pinned rule version. */
  async handleEvent(
    rule: AutomationRule,
    event: AutomationEvent,
    variables: Record<string, AutomationValue> = {},
    now = new Date(),
  ) {
    if (rule.workspaceId !== event.workspaceId) {
      return undefined
    }
    const executionId = createAutomationExecutionId(rule, event.eventId)
    const existing = await this.client.getExecution(rule.workspaceId, executionId)
    if (existing) return await this.resumeExistingExecution(existing, now)
    if (
      rule.trigger.type !== 'schedule' &&
      new Date(event.occurredAt).getTime() < new Date(rule.updatedAt).getTime()
    ) {
      return undefined
    }
    if (!rule.enabled || !matchesDomainAutomationTrigger(rule.trigger, event)) return undefined
    if (!rule.conditions.every((condition) => evaluateDomainAutomationCondition(condition, {
      event,
      workItem: event.workItem,
      variables,
    }))) {
      return undefined
    }
    const execution = createPendingAutomationExecution(rule, event, now)
    const lineage = event.automationRuleLineage ?? []
    if (lineage.length >= rule.maxChainDepth || (!rule.allowReentry && lineage.includes(rule.id))) {
      execution.status = 'skipped'
      execution.completedAt = now.toISOString()
      execution.errorCode = 'AutomationLoopPrevented'
      execution.errorMessage = 'Automation rule re-entry or chain depth was rejected.'
      execution.retryable = false
      return await this.createOrReadExecution(execution, event, rule)
    }
    const reservation = await this.client.reserveExecution(execution, event, rule)
    if (reservation === 'stale-definition') return undefined
    if (reservation === 'rate-limited') {
      execution.status = 'skipped'
      execution.completedAt = now.toISOString()
      execution.errorCode = 'AutomationRateLimitExceeded'
      execution.errorMessage = 'Automation rule rate limit was exceeded.'
      execution.retryable = false
      return await this.createOrReadExecution(execution, event, rule)
    }
    if (reservation === 'duplicate') {
      const duplicate = await this.client.getExecution(rule.workspaceId, execution.id)
      if (!duplicate) {
        throw new AutomationError(
          'unavailable',
          'AutomationExecutionUnavailable',
          'Automation execution is unavailable after duplicate delivery.',
          true,
        )
      }
      return await this.resumeExistingExecution(duplicate, now)
    }
    return await this.run(rule, event, execution, now)
  }

  /** Retries a failed execution with its immutable definition and trigger event. */
  async retryExecution(
    workspaceId: string,
    executionId: string,
    event?: AutomationEvent,
    now = new Date(),
  ) {
    const execution = await this.client.getExecution(workspaceId, executionId)
    if (!execution) throw new AutomationError('not-found', 'AutomationExecutionNotFound', 'Automation execution was not found.')
    if (execution.ruleId.startsWith('recurring:')) {
      const recurringWorkId = execution.ruleId.slice('recurring:'.length)
      const definition = recurringWorkId
        ? await this.client.getRecurringWork(workspaceId, recurringWorkId)
        : undefined
      if (!definition?.enabled) {
        throw new AutomationError(
          'conflict',
          'RecurringWorkDisabled',
          'Recurring Work definition is unavailable or disabled.',
        )
      }
      return await retryRecurringExecution(
        execution,
        event ?? await this.client.getExecutionEvent(workspaceId, executionId),
        this.client,
        this.actionExecutor,
        now,
        {
          kind: 'recurring',
          id: definition.id,
          version: definition.version,
          revision: definition.revision,
        },
      )
    }
    const isDelayedRetry = execution.status === 'failed' && execution.retryable
    const isManualDeadLetterRetry = execution.status === 'dead-letter'
    if (!isDelayedRetry && !isManualDeadLetterRetry) {
      throw new AutomationError('conflict', 'AutomationExecutionNotRetryable', 'Automation execution cannot be retried.')
    }
    if (isDelayedRetry && execution.nextRetryAt && execution.nextRetryAt > now.toISOString()) {
      throw new AutomationError('conflict', 'AutomationRetryNotDue', 'Automation retry delay has not elapsed.')
    }
    const rule = await this.client.getRuleVersion(workspaceId, execution.ruleId, execution.ruleVersion)
    if (!rule) throw new AutomationError('unavailable', 'AutomationRuleVersionUnavailable', 'Automation rule version is unavailable.')
    const triggerEvent = event ?? await this.client.getExecutionEvent(workspaceId, executionId)
    if (!triggerEvent) {
      throw new AutomationError('unavailable', 'AutomationTriggerEventUnavailable', 'Automation trigger event is unavailable.')
    }
    return await this.run(rule, triggerEvent, execution, now)
  }

  /** Conditionally creates an execution or reads the duplicate row. */
  private async createOrReadExecution(
    execution: AutomationExecution,
    event: AutomationEvent,
    rule: AutomationRule,
  ) {
    if (await this.client.createExecution(execution, event, {
      kind: 'rule',
      id: rule.id,
      version: rule.version,
      revision: rule.revision,
    })) return execution
    return await this.client.getExecution(execution.workspaceId, execution.id)
  }

  /** Resumes an execution from its originally pinned rule and event. */
  private async resumeExistingExecution(execution: AutomationExecution, now: Date) {
    const resumable = execution.status === 'pending' || execution.status === 'running' ||
      (execution.status === 'failed' && execution.retryable)
    if (!resumable) return execution
    if (
      (execution.status === 'failed' || execution.status === 'running') &&
      execution.nextRetryAt &&
      execution.nextRetryAt > now.toISOString()
    ) {
      return execution
    }
    const rule = await this.client.getRuleVersion(
      execution.workspaceId,
      execution.ruleId,
      execution.ruleVersion,
    )
    if (!rule) {
      throw new AutomationError(
        'unavailable',
        'AutomationRuleVersionUnavailable',
        'Automation rule version is unavailable.',
        true,
      )
    }
    const event = await this.client.getExecutionEvent(execution.workspaceId, execution.id)
    if (!event) {
      throw new AutomationError(
        'unavailable',
        'AutomationTriggerEventUnavailable',
        'Automation trigger event is unavailable.',
        true,
      )
    }
    return await this.run(rule, event, execution, now)
  }

  /** Runs actions sequentially while honoring durable success receipts. */
  private async run(
    rule: AutomationRule,
    event: AutomationEvent,
    execution: AutomationExecution,
    now: Date,
  ) {
    const leaseExpiresAt = new Date(now.getTime() + AUTOMATION_EXECUTION_LEASE_MS).toISOString()
    const claimed = await this.client.claimExecution(execution, now, leaseExpiresAt)
    if (!claimed) {
      const current = await this.client.getExecution(execution.workspaceId, execution.id)
      if (current) return current
      throw new AutomationError(
        'unavailable',
        'AutomationExecutionUnavailable',
        'Automation execution is unavailable after runner lease contention.',
        true,
      )
    }
    execution.status = 'running'
    execution.attempts += 1
    execution.retryable = false
    execution.nextRetryAt = leaseExpiresAt
    execution.completedAt = undefined
    execution.errorCode = undefined
    execution.errorMessage = undefined
    const claimToken: AutomationExecutionClaimToken = {
      attempt: execution.attempts,
      leaseExpiresAt,
    }

    for (let index = 0; index < rule.actions.length; index += 1) {
      const action = rule.actions[index]!
      const actionState = execution.actions[index]!
      if (await this.client.hasActionReceipt(execution.workspaceId, execution.id, actionState.actionId)) {
        actionState.status = 'succeeded'
        if (!await this.client.saveExecution(execution, claimToken, new Date())) {
          return await readAutomationExecutionAfterLeaseLoss(this.client, execution)
        }
        continue
      }
      actionState.status = 'running'
      actionState.attempts += 1
      actionState.startedAt ??= now.toISOString()
      try {
        await this.actionExecutor.execute(action, {
          execution,
          event,
          actionIndex: index,
          idempotencyKey: actionState.actionId,
        })
        await this.client.putActionReceipt(execution.workspaceId, execution.id, actionState.actionId)
        const savedAt = new Date()
        actionState.status = 'succeeded'
        actionState.completedAt = savedAt.toISOString()
        actionState.errorCode = undefined
        actionState.errorMessage = undefined
        if (!await this.client.saveExecution(execution, claimToken, savedAt)) {
          return await readAutomationExecutionAfterLeaseLoss(this.client, execution)
        }
      } catch (error) {
        const failure = normalizeAutomationActionFailure(error)
        const savedAt = new Date()
        actionState.status = 'failed'
        actionState.errorCode = failure.code
        actionState.errorMessage = failure.message
        execution.errorCode = failure.code
        execution.errorMessage = failure.message
        execution.completedAt = savedAt.toISOString()
        if (failure.retryable && execution.attempts < rule.retryPolicy.maxAttempts) {
          execution.status = 'failed'
          execution.retryable = true
          execution.nextRetryAt = new Date(
            now.getTime() + calculateRetryDelay(rule.retryPolicy, execution.attempts),
          ).toISOString()
        } else {
          execution.status = 'dead-letter'
          execution.retryable = true
          execution.nextRetryAt = undefined
        }
        if (!await this.client.saveExecution(execution, claimToken, savedAt)) {
          return await readAutomationExecutionAfterLeaseLoss(this.client, execution)
        }
        return execution
      }
    }
    const savedAt = new Date()
    execution.status = 'succeeded'
    execution.retryable = false
    execution.nextRetryAt = undefined
    execution.completedAt = savedAt.toISOString()
    execution.errorCode = undefined
    execution.errorMessage = undefined
    if (!await this.client.saveExecution(execution, claimToken, savedAt)) {
      return await readAutomationExecutionAfterLeaseLoss(this.client, execution)
    }
    return execution
  }
}

/** Reads current execution state after losing a lease fence. */
async function readAutomationExecutionAfterLeaseLoss(
  client: AutomationExecutionServicePort,
  execution: AutomationExecution,
) {
  const current = await client.getExecution(execution.workspaceId, execution.id)
  if (current) return current
  throw new AutomationError(
    'unavailable',
    'AutomationExecutionUnavailable',
    'Automation execution is unavailable after runner lease loss.',
    true,
  )
}

/** Retries a recurring execution from its stored event and action receipt. */
async function retryRecurringExecution(
  execution: AutomationExecution,
  event: AutomationEvent | undefined,
  client: AutomationExecutionServicePort,
  actionExecutor: AutomationActionExecutor,
  now: Date,
  definitionGuard: AutomationExecutionDefinitionGuard,
) {
  if (!event) {
    throw new AutomationError(
      'unavailable',
      'AutomationTriggerEventUnavailable',
      'Automation trigger event is unavailable.',
      true,
    )
  }
  const recurringWorkId = execution.ruleId.slice('recurring:'.length)
  const metadata = event.metadata ?? {}
  const storedRecurringWorkId = metadata.recurringWorkId
  const teamId = metadata.teamId
  const templateId = metadata.templateId
  const templateVersion = metadata.templateVersion
  const scheduledFor = metadata.scheduledFor
  if (
    !recurringWorkId ||
    storedRecurringWorkId !== recurringWorkId ||
    typeof teamId !== 'string' || !teamId.trim() ||
    typeof templateId !== 'string' || !templateId.trim() ||
    !isPositiveSafeInteger(templateVersion) ||
    typeof scheduledFor !== 'string' ||
    execution.workspaceId !== event.workspaceId ||
    execution.triggerEventId !== event.eventId ||
    execution.id !== createRecurringExecutionId(
      execution.workspaceId,
      recurringWorkId,
      scheduledFor,
    )
  ) {
    throw new AutomationError(
      'unavailable',
      'RecurringExecutionInvalid',
      'Recurring execution event is invalid.',
    )
  }
  const actionState = execution.actions[0]
  const actionId = createAutomationActionId(execution.id, 0)
  if (
    execution.actions.length !== 1 ||
    !actionState ||
    actionState.actionIndex !== 0 ||
    actionState.actionId !== actionId
  ) {
    throw new AutomationError(
      'unavailable',
      'RecurringExecutionInvalid',
      'Recurring execution action state is invalid.',
    )
  }
  const actionAlreadySucceeded = await client.hasActionReceipt(
    execution.workspaceId,
    execution.id,
    actionId,
  )
  if (
    actionAlreadySucceeded &&
    execution.status === 'succeeded' &&
    actionState.status === 'succeeded'
  ) return execution
  const delayedRetry = execution.status === 'failed' && execution.retryable
  const expiredRunner = execution.status === 'running' &&
    (!execution.nextRetryAt || execution.nextRetryAt <= now.toISOString())
  if (execution.status !== 'dead-letter' && !delayedRetry && !expiredRunner) {
    throw new AutomationError(
      'conflict',
      'AutomationExecutionNotRetryable',
      'Automation execution cannot be retried.',
    )
  }
  if (
    !actionAlreadySucceeded &&
    delayedRetry &&
    execution.nextRetryAt &&
    execution.nextRetryAt > now.toISOString()
  ) {
    throw new AutomationError('conflict', 'AutomationRetryNotDue', 'Automation retry delay has not elapsed.')
  }
  const leaseExpiresAt = new Date(now.getTime() + 5 * 60_000).toISOString()
  if (!await client.claimExecution(execution, now, leaseExpiresAt, definitionGuard)) {
    const raced = await client.getExecution(execution.workspaceId, execution.id)
    if (!raced) {
      throw new AutomationError(
        'unavailable',
        'AutomationExecutionUnavailable',
        'Automation execution is unavailable after a retry race.',
        true,
      )
    }
    return raced
  }
  execution.status = 'running'
  execution.attempts += 1
  execution.retryable = false
  execution.completedAt = undefined
  execution.nextRetryAt = leaseExpiresAt
  execution.errorCode = undefined
  execution.errorMessage = undefined
  const claimToken: AutomationExecutionClaimToken = {
    attempt: execution.attempts,
    leaseExpiresAt,
  }
  if (actionAlreadySucceeded) {
    actionState.status = 'succeeded'
    actionState.completedAt ??= now.toISOString()
    actionState.errorCode = undefined
    actionState.errorMessage = undefined
    execution.status = 'succeeded'
    execution.completedAt = actionState.completedAt
    execution.retryable = false
    execution.nextRetryAt = undefined
    execution.errorCode = undefined
    execution.errorMessage = undefined
    if (!await client.saveExecution(execution, claimToken, now)) {
      return await readAutomationExecutionAfterLeaseLoss(client, execution)
    }
    return execution
  }
  actionState.status = 'running'
  actionState.attempts += 1
  actionState.startedAt ??= now.toISOString()
  actionState.completedAt = undefined
  actionState.errorCode = undefined
  actionState.errorMessage = undefined
  const action: AutomationAction = {
    type: 'create',
    templateId,
    templateVersion,
    values: { teamId },
  }
  try {
    await actionExecutor.execute(action, {
      execution,
      event,
      actionIndex: 0,
      idempotencyKey: actionId,
    })
    await client.putActionReceipt(execution.workspaceId, execution.id, actionId)
    const savedAt = new Date()
    const completedAt = savedAt.toISOString()
    actionState.status = 'succeeded'
    actionState.completedAt = completedAt
    execution.status = 'succeeded'
    execution.completedAt = completedAt
    execution.retryable = false
    execution.nextRetryAt = undefined
    execution.errorCode = undefined
    execution.errorMessage = undefined
    if (!await client.saveExecution(execution, claimToken, savedAt)) {
      return await readAutomationExecutionAfterLeaseLoss(client, execution)
    }
    return execution
  } catch (error) {
    const failure = normalizeAutomationActionFailure(error)
    const savedAt = new Date()
    actionState.status = 'failed'
    actionState.completedAt = savedAt.toISOString()
    actionState.errorCode = failure.code
    actionState.errorMessage = failure.message
    execution.completedAt = savedAt.toISOString()
    execution.errorCode = failure.code
    execution.errorMessage = failure.message
    if (failure.retryable && execution.attempts < DEFAULT_AUTOMATION_RETRY_POLICY.maxAttempts) {
      const exponent = Math.max(0, execution.attempts - 1)
      const delay = Math.min(
        DEFAULT_AUTOMATION_RETRY_POLICY.maxDelayMs,
        Math.round(
          DEFAULT_AUTOMATION_RETRY_POLICY.initialDelayMs *
          DEFAULT_AUTOMATION_RETRY_POLICY.backoffMultiplier ** exponent,
        ),
      )
      execution.status = 'failed'
      execution.retryable = true
      execution.nextRetryAt = new Date(now.getTime() + delay).toISOString()
    } else {
      execution.status = 'dead-letter'
      execution.retryable = true
      execution.nextRetryAt = undefined
    }
    if (!await client.saveExecution(execution, claimToken, savedAt)) {
      return await readAutomationExecutionAfterLeaseLoss(client, execution)
    }
    return execution
  }
}
/** Calculates exponential retry delay within the configured maximum. */
function calculateRetryDelay(policy: AutomationRetryPolicy, attempts: number): number {
  return Math.min(
    policy.maxDelayMs,
    Math.floor(
      policy.initialDelayMs *
      policy.backoffMultiplier ** Math.max(0, attempts - 1),
    ),
  )
}

/** Narrows an unknown value to a positive safe integer. */
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}
