import {
  AUTOMATION_SCHEMA_VERSION,
  type AutomationAction,
  type AutomationValue,
  type AutomationExecution,
  type AutomationRule,
  type RecurringWork,
} from '@mukuroji/contracts'
import {
  normalizeAutomationActionFailure,
} from '../../application/action-failure'
import { AutomationEngine } from '../../application/execution-service'
import { AutomationError } from '../../domain/automation-error'
import {
  createAutomationActionId,
  createAutomationExecutionId,
  createRecurringExecutionId,
} from '../../application/execution-identifiers'
import {
  DEFAULT_AUTOMATION_RETRY_POLICY,
  getPendingExecutionRecoveryAt,
} from '../../domain/execution-policy'
import {
  getBusinessDayWakeUp,
  getDueDateForOccurrence,
  getLocalMonthStart,
  getNextLocalMonthStart,
  getNextRecurringOccurrence,
  getRecurringOccurrences,
  selectCatchUpOccurrences,
  type RecurringWorkCalendar,
} from '../../domain/recurring-schedule'
import {
  hydrateAutomationWorkItem,
  type AutomationWorkItemReader,
} from '../events/automation-event'
import type {
  AutomationActionExecutor,
  AutomationDueWorkItemSource,
  AutomationExecutionFailureNotifier,
  AutomationExecutionClaimToken,
  AutomationExecutionServicePort,
  AutomationFeatureEntitlementPort,
  AutomationInboundWebhookPort,
  AutomationInboundWebhookSecretCleanup,
  AutomationInboundWebhookSecretStore,
  AutomationRecurringSchedulePort,
  AutomationRuleTemplatePort,
  AutomationWorkCalendarSource,
} from '../../application/ports'
import type { AutomationEvent } from '../../domain/rule-evaluation'
import { AUTOMATION_SCHEDULE_SHARD_COUNT } from '../../application/schedule-shard'

/** Focused capabilities required by the Automation schedule adapter. */
export type AutomationSchedulePort =
  AutomationRecurringSchedulePort &
  AutomationExecutionServicePort &
  Pick<
    AutomationRuleTemplatePort,
    | 'completeScheduledRule'
    | 'getRule'
    | 'listDueScheduledRules'
  > &
  Pick<
    AutomationInboundWebhookPort,
    | 'completeInboundWebhookSecretCleanup'
    | 'listDueInboundWebhookSecretCleanups'
  >

/** Schedule invocation の dependency contract です。 */
export type AutomationScheduleDependencies = {
  /** Automation definitions、execution、receipts の durable store です。 */
  client: AutomationSchedulePort
  /** Server-side feature gate evaluated before tenant Automation execution. */
  entitlement: AutomationFeatureEntitlementPort
  /** Recurring Work Item create action の executor です。 */
  actionExecutor: AutomationActionExecutor
  /** Reports dead-lettered and rate-limited rule executions to people. */
  failureNotifier?: AutomationExecutionFailureNotifier
  /** Revoke 済み inbound webhook secret の durable cleanup store です。 */
  inboundWebhookSecrets?: AutomationInboundWebhookSecretStore
  /** Lists the Work Items a due-soon schedule rule runs for. */
  dueWorkItems?: AutomationDueWorkItemSource
  /** Reads the Work Item each due-soon run reads and acts on. */
  workItems?: AutomationWorkItemReader
  /** Reads the Team calendar a business-day Recurring Work counts on. */
  workCalendars?: AutomationWorkCalendarSource
}

/** EventBridge schedule event のうち handler が利用する最小表現です。 */
export type AutomationScheduleEvent = {
  /** EventBridge が渡す schedule timestamp です。 */
  time?: string
}

const RECURRING_ACTION_LEASE_MS = 5 * 60_000

/**
 * `skip` policy で occurrence を「定刻」とみなす wall-clock の遅れの上限です。
 *
 * Scheduler は `rate(1 minute)` で起動し、tick の秒位置は分境界と揃わず、Lambda の起動も遅れます。
 * そのため分境界の occurrence を最初に観測する `now` は最大で約 1 tick 遅れます。
 * 2 tick 分を許容し、それより古い occurrence だけを逃した slot として skip します。
 */
const SKIP_POLICY_ON_TIME_WINDOW_MS = 2 * 60_000

/** EventBridge timestamp を検証し、runner lease 用の wall-clock 時刻を返します。 */
export function resolveAutomationScheduleProcessingTime(
  event: AutomationScheduleEvent,
  wallClock = new Date(),
) {
  if (event.time && Number.isNaN(Date.parse(event.time))) {
    throw new AutomationError('invalid-input', 'AutomationScheduleTimeInvalid', 'Schedule time is invalid.')
  }
  return wallClock
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

/**
 * Due execution を保存済み immutable rule version/event だけで retry します。誰も claim しなかった
 * `pending` の予約も、予約から一定時間たったらここで再開します。
 */
export async function processDueAutomationExecution(
  execution: AutomationExecution,
  now: Date,
  dependencies: AutomationScheduleDependencies,
) {
  const dueAt = execution.status === 'pending' && !execution.ruleId.startsWith('recurring:')
    ? getPendingExecutionRecoveryAt(execution)
    : execution.nextRetryAt
  if (!dueAt || dueAt > now.toISOString()) {
    return execution
  }
  if (!await dependencies.entitlement.isAutomationEnabled(execution.workspaceId)) {
    return execution
  }
  const engine = new AutomationEngine(
    dependencies.client,
    dependencies.actionExecutor,
    dependencies.failureNotifier,
  )
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
    // A reservation nobody claimed resumes like an expired runner, from the saved rule version.
    if (execution.status !== 'running' && execution.status !== 'pending') return execution
    const rule = await dependencies.client.getRuleVersion(
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
    const event = await dependencies.client.getExecutionEvent(execution.workspaceId, execution.id)
    if (!event) {
      throw new AutomationError(
        'unavailable',
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
  if (!await dependencies.entitlement.isAutomationEnabled(rule.workspaceId)) {
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
    dependencies,
  )
  const engine = new AutomationEngine(
    dependencies.client,
    dependencies.actionExecutor,
    dependencies.failureNotifier,
  )

  for (const occurrence of selected) {
    if (rule.trigger.dueWorkItems) {
      const completed = await runDueWorkItemOccurrence(
        rule,
        rule.trigger.dueWorkItems.daysBefore,
        rule.trigger.schedule.timeZone,
        occurrence,
        engine,
        now,
        dependencies,
      )
      if (!completed) return rule
      continue
    }
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
    throw new AutomationError('conflict', 'AutomationScheduleExhausted', 'Automation schedule has no next occurrence.')
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

/**
 * Runs a due-soon schedule rule once for each open Work Item due the given number of days after
 * one occurrence.
 *
 * Each Work Item gets its own execution keyed by the occurrence and the Work Item, so a repeated
 * tick resumes the executions it already made. A failed execution retries on its own schedule,
 * so the occurrence still completes.
 *
 * @param rule - Enabled schedule rule.
 * @param daysBefore - Days from the occurrence date to the due date.
 * @param timeZone - Time zone of the schedule.
 * @param occurrence - Occurrence being run.
 * @param engine - Rule execution engine.
 * @param now - Processing time.
 * @param dependencies - Schedule dependencies.
 * @returns False when a concurrent runner holds the occurrence, true otherwise.
 * @throws AutomationError `AutomationDueWorkItemsUnavailable` without a due Work Item source.
 */
async function runDueWorkItemOccurrence(
  rule: AutomationRule,
  daysBefore: number,
  timeZone: string,
  occurrence: Date,
  engine: AutomationEngine,
  now: Date,
  dependencies: AutomationScheduleDependencies,
): Promise<boolean> {
  if (!dependencies.dueWorkItems || !dependencies.workItems) {
    throw new AutomationError(
      'unavailable',
      'AutomationDueWorkItemsUnavailable',
      'Due Work Item lookup is not configured.',
      true,
    )
  }
  const dueDate = getDueDateForOccurrence(occurrence, timeZone, daysBefore)
  const items = await dependencies.dueWorkItems.listOpenWorkItemsDueOn(rule.workspaceId, dueDate)
  const ordered = [...items].sort((first, second) =>
    first.teamId.localeCompare(second.teamId) || first.workItemId.localeCompare(second.workItemId)
  )
  for (const item of ordered) {
    const event = await hydrateAutomationWorkItem({
      eventId: createDueWorkItemEventId(rule, occurrence, item.teamId, item.workItemId),
      eventType: 'automation.schedule',
      workspaceId: rule.workspaceId,
      occurredAt: occurrence.toISOString(),
      changes: [],
      metadata: {
        ruleId: rule.id,
        scheduledFor: occurrence.toISOString(),
        teamId: item.teamId,
        issueId: item.workItemId,
        dueDate: item.dueDate,
      },
    }, dependencies.workItems)
    if (!isOpenWorkItemDueOn(event.workItem, dueDate)) continue
    try {
      await engine.handleEvent(rule, event, {}, now)
    } catch (error) {
      if (isBenignRetryRace(error)) return false
      throw error
    }
  }
  return true
}

/**
 * Tests whether a hydrated Work Item is still open, unarchived, and due on the date, since the due
 * index can lag a completion or archive.
 *
 * @param workItem - Hydrated Work Item snapshot.
 * @param dueDate - Due date the occurrence looks for.
 * @returns Whether the rule should run for the Work Item.
 */
function isOpenWorkItemDueOn(
  workItem: Record<string, AutomationValue> | undefined,
  dueDate: string,
): boolean {
  return workItem !== undefined &&
    workItem.dueDate === dueDate &&
    (workItem.archivedAt === undefined || workItem.archivedAt === null) &&
    (workItem.statusCategory === 'backlog' ||
      workItem.statusCategory === 'unstarted' ||
      workItem.statusCategory === 'started')
}

/**
 * How many of a business-day definition's newest executions are read to find a run that started
 * this month; at most one run starts per month, and retries reuse its execution.
 */
const STARTED_BUSINESS_DAY_EXECUTION_LOOKUP_LIMIT = 5

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
  if (!await dependencies.entitlement.isAutomationEnabled(definition.workspaceId)) {
    return definition
  }
  const calendar = await readRecurringWorkCalendar(definition, dependencies)
  let occurrences: Date[]
  let fallbackOccurrence: Date
  if (calendar) {
    const windowStart = readBusinessDayWindowStart(definition)
    const startedOccurrence = await findStartedBusinessDayOccurrence(definition, now, dependencies)
    const businessDayOccurrences = startedOccurrence
      ? [
          startedOccurrence,
          ...getRecurringOccurrences(definition.schedule, windowStart, now, calendar).filter((occurrence) =>
            !isInSameLocalMonth(occurrence, startedOccurrence, definition.schedule.timeZone)),
        ]
      : getRecurringOccurrences(definition.schedule, windowStart, now, calendar)
    const firstBusinessDayOccurrence = businessDayOccurrences[0]
    if (!firstBusinessDayOccurrence) {
      return await deferRecurringWorkToBusinessDay(definition, calendar, now, dependencies)
    }
    occurrences = businessDayOccurrences
    fallbackOccurrence = firstBusinessDayOccurrence
  } else {
    const dueStart = new Date(new Date(definition.nextRunAt).getTime() - 1)
    const dueOccurrences = getRecurringOccurrences(definition.schedule, dueStart, now)
    fallbackOccurrence = new Date(definition.nextRunAt)
    occurrences = dueOccurrences.length > 0 ? dueOccurrences : [fallbackOccurrence]
  }
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
  // A business-day schedule wakes on calendar day n of the next month (the earliest its run can
  // fall on) and counts business days there, so calendar changes made meanwhile take effect. It
  // runs once a month, so the search starts after the completed run's local month: a run resumed
  // at a time since edited would otherwise find a later slot on the same day.
  const nextRunAfter = definition.schedule.monthlyDay === 'business-day'
    ? new Date(getNextLocalMonthStart(lastCompleted, definition.schedule.timeZone).getTime() - 1)
    : lastCompleted
  const nextRun = getNextRecurringOccurrence(definition.schedule, nextRunAfter)
  if (!nextRun) {
    throw new AutomationError('conflict', 'RecurringScheduleExhausted', 'Recurring schedule has no next occurrence.')
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

/**
 * Finds a business-day run that already started this month and has not completed, so a retry
 * resumes the same occurrence (and Work Item) even when a calendar or schedule change since then
 * would pick another day or time.
 *
 * Reads the newest executions of the definition rather than the slots of the current schedule,
 * so an edited local time does not hide the started run. Successful runs advance the definition
 * past their month, so an execution after the window start belongs to a run that has not
 * completed. A schedule change does not move this window: the started run finishes first.
 *
 * @param definition - Business-day recurring definition.
 * @param now - Processing time.
 * @param dependencies - Schedule dependencies.
 * @returns The earliest started occurrence, or `undefined` when none started.
 */
async function findStartedBusinessDayOccurrence(
  definition: RecurringWork,
  now: Date,
  dependencies: AutomationScheduleDependencies,
): Promise<Date | undefined> {
  const monthStart = getLocalMonthStart(new Date(definition.nextRunAt), definition.schedule.timeZone)
  const windowStart = Math.max(
    monthStart.getTime() - 1,
    Date.parse(definition.lastRunAt ?? definition.createdAt),
  )
  const prefix = `recurring:${definition.id}:`
  const { executions } = await dependencies.client.listExecutions({
    workspaceId: definition.workspaceId,
    ruleId: `recurring:${definition.id}`,
    limit: STARTED_BUSINESS_DAY_EXECUTION_LOOKUP_LIMIT,
  })
  let started: Date | undefined
  for (const execution of executions) {
    if (!execution.triggerEventId.startsWith(prefix)) continue
    const occurrence = new Date(execution.triggerEventId.slice(prefix.length))
    const time = occurrence.getTime()
    if (!Number.isFinite(time) || time <= windowStart || time > now.getTime()) continue
    if (!started || time < started.getTime()) started = occurrence
  }
  return started
}

/**
 * Tests whether two instants fall in the same local calendar month.
 *
 * @param first - First instant.
 * @param second - Second instant.
 * @param timeZone - IANA time zone the months are counted in.
 * @returns Whether both are in the same local month.
 */
function isInSameLocalMonth(first: Date, second: Date, timeZone: string): boolean {
  return getLocalMonthStart(first, timeZone).getTime() === getLocalMonthStart(second, timeZone).getTime()
}

/**
 * Reads the Team calendar of a business-day Recurring Work.
 *
 * @param definition - Recurring definition.
 * @param dependencies - Schedule dependencies.
 * @returns The calendar, or undefined when the schedule does not count business days.
 * @throws AutomationError `RecurringWorkCalendarUnavailable` without a calendar source.
 */
async function readRecurringWorkCalendar(
  definition: RecurringWork,
  dependencies: AutomationScheduleDependencies,
): Promise<RecurringWorkCalendar | undefined> {
  if (definition.schedule.monthlyDay !== 'business-day') return undefined
  if (!dependencies.workCalendars) {
    throw new AutomationError(
      'unavailable',
      'RecurringWorkCalendarUnavailable',
      'Work calendar lookup is not configured.',
      true,
    )
  }
  return await dependencies.workCalendars.readTeamWorkCalendar(
    definition.workspaceId,
    definition.teamId,
  )
}

/**
 * Returns the exclusive start of the window a business-day Recurring Work looks for its due run in.
 *
 * The stored next run is calendar day n, which is in the same month as the nth business day, so
 * the window starts at that month's beginning: a holiday removed after a deferral still runs the
 * earlier day, and months missed while the definition was paused are not caught up. It never
 * starts before the last completed run, before the definition was created, nor before its schedule
 * was last changed, so a new schedule does not run a time that passed before the change.
 *
 * @param definition - Business-day recurring definition.
 * @returns The exclusive window start.
 */
function readBusinessDayWindowStart(definition: RecurringWork): Date {
  const monthStart = getLocalMonthStart(new Date(definition.nextRunAt), definition.schedule.timeZone)
  const floor = Date.parse(definition.lastRunAt ?? definition.createdAt)
  const scheduleChangedAt = definition.scheduleChangedAt === undefined
    ? Number.NEGATIVE_INFINITY
    : Date.parse(definition.scheduleChangedAt)
  return new Date(Math.max(monthStart.getTime() - 1, floor, scheduleChangedAt))
}

/**
 * Moves a business-day Recurring Work to its working day when the run it was due for, which is
 * stored as the earliest day that working day can fall on, comes before it.
 *
 * @param definition - Recurring definition that is due.
 * @param calendar - Team calendar.
 * @param now - Processing time.
 * @param dependencies - Schedule dependencies.
 * @returns The deferred definition, or the current one when another runner already moved it.
 */
async function deferRecurringWorkToBusinessDay(
  definition: RecurringWork,
  calendar: RecurringWorkCalendar,
  now: Date,
  dependencies: AutomationScheduleDependencies,
): Promise<RecurringWork> {
  const nextRun = getNextRecurringOccurrence(
    definition.schedule,
    readBusinessDayWindowStart(definition),
    calendar,
  )
  if (!nextRun) {
    throw new AutomationError('conflict', 'RecurringScheduleExhausted', 'Recurring schedule has no next occurrence.')
  }
  const wakeUp = getBusinessDayWakeUp(definition.schedule, now, nextRun)
  try {
    return await dependencies.client.deferRecurringWork(
      definition.workspaceId,
      definition.id,
      definition.revision,
      wakeUp.toISOString(),
    )
  } catch (error) {
    const current = await dependencies.client.getRecurringWork(definition.workspaceId, definition.id)
    if (current && current.revision !== definition.revision) return current
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
    ...(definition.ownerTeamId === undefined ? {} : { ownerTeamId: definition.ownerTeamId }),
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
      'unavailable',
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
    throw new AutomationError('unavailable', 'RecurringExecutionInvalid', 'Recurring execution event is invalid.')
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
    throw new AutomationError('unavailable', 'RecurringExecutionInvalid', 'Recurring execution is invalid.')
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
  client: AutomationExecutionServicePort,
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
  dependencies: AutomationScheduleDependencies,
) {
  const client = dependencies.client
  if (rule.trigger.type !== 'schedule') return []
  const firstOccurrence = occurrences[0]
  if (rule.trigger.schedule.catchUpPolicy !== 'skip') {
    const selected = selectCatchUpOccurrences(
      occurrences,
      rule.trigger.schedule.catchUpPolicy,
      maximum,
    )
    // A due-soon fan-out that already started keeps its remaining Work Items under every policy:
    // they have no execution of their own to retry once the cursor moves past the occurrence.
    if (
      !rule.trigger.dueWorkItems ||
      !firstOccurrence ||
      selected.some((occurrence) => occurrence.getTime() === firstOccurrence.getTime()) ||
      !await hasStartedDueWorkItemOccurrence(rule, firstOccurrence, dependencies)
    ) {
      return selected
    }
    return mergeOccurrences(firstOccurrence, selected)
  }
  const onTimeOccurrences = selectOnTimeOccurrences(occurrences, now)
  if (
    !firstOccurrence ||
    onTimeOccurrences.some((occurrence) => occurrence.getTime() === firstOccurrence.getTime())
  ) {
    return onTimeOccurrences
  }
  const started = rule.trigger.dueWorkItems
    ? await hasStartedDueWorkItemOccurrence(rule, firstOccurrence, dependencies)
    : Boolean(await client.getExecution(
        rule.workspaceId,
        createAutomationExecutionId(rule, `scheduled-rule:${rule.id}:${firstOccurrence.toISOString()}`),
      ))
  return started
    ? mergeOccurrences(firstOccurrence, onTimeOccurrences)
    : onTimeOccurrences
}

/**
 * How many of a due-soon rule's newest executions are read to find whether a late occurrence
 * started; the rule runs nothing past the earliest unfinished occurrence, so its newest
 * executions belong to that occurrence when it started.
 */
const STARTED_DUE_WORK_ITEM_EXECUTION_LOOKUP_LIMIT = 5

/**
 * Tests whether a late due-soon occurrence already ran for any of its Work Items, so a `skip`
 * policy resumes the rest instead of dropping them.
 *
 * Reads the rule's newest executions rather than the current due list, so the occurrence still
 * counts as started after the Work Items it already ran for are completed, archived, or moved to
 * another due date. Runs only when the occurrence is past its on-time window.
 *
 * @param rule - Due-soon schedule rule.
 * @param occurrence - Occurrence the rule is still due for.
 * @param dependencies - Schedule dependencies.
 * @returns Whether an execution exists for the occurrence.
 */
async function hasStartedDueWorkItemOccurrence(
  rule: AutomationRule,
  occurrence: Date,
  dependencies: AutomationScheduleDependencies,
): Promise<boolean> {
  const prefix = `scheduled-rule:${rule.id}:${occurrence.toISOString()}:due:`
  const { executions } = await dependencies.client.listExecutions({
    workspaceId: rule.workspaceId,
    ruleId: rule.id,
    limit: STARTED_DUE_WORK_ITEM_EXECUTION_LOOKUP_LIMIT,
  })
  return executions.some((execution) => execution.triggerEventId.startsWith(prefix))
}

/**
 * Builds the event ID of one Work Item of a due-soon occurrence.
 *
 * @param rule - Due-soon schedule rule.
 * @param occurrence - Occurrence instant.
 * @param teamId - Team of the Work Item.
 * @param workItemId - Work Item identifier.
 * @returns The deterministic event ID.
 */
function createDueWorkItemEventId(
  rule: AutomationRule,
  occurrence: Date,
  teamId: string,
  workItemId: string,
): string {
  return `scheduled-rule:${rule.id}:${occurrence.toISOString()}:due:${teamId}:${workItemId}`
}

async function selectRecurringDueOccurrences(
  definition: RecurringWork,
  occurrences: readonly Date[],
  fallbackOccurrence: Date,
  maximum: number,
  now: Date,
  client: AutomationExecutionServicePort,
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

/** `skip` policy で、tick の遅れを許容した定刻内の最新 occurrence だけを選びます。 */
function selectOnTimeOccurrences(occurrences: readonly Date[], now: Date) {
  return occurrences.filter((occurrence) => {
    const lagMs = now.getTime() - occurrence.getTime()
    return lagMs >= 0 && lagMs < SKIP_POLICY_ON_TIME_WINDOW_MS
  }).slice(-1)
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
