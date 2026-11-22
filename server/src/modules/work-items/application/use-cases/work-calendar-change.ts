import {
  WORK_CALENDAR_CHANGE_EXAMPLE_LIMIT,
  WORK_CALENDAR_CHANGE_MAX_WORK_ITEMS,
  haveSameWorkCalendarRules,
  type WorkCalendar,
  type WorkCalendarAdjustment,
  type WorkCalendarChangeExample,
  type WorkCalendarChangeImpact,
  type WorkCalendarChangeResult,
  type WorkItemSchedule,
  type WorkItemScheduleCalendarPolicy,
} from '@mukuroji/contracts'
import { ProjectDataError } from '../../../directory'
import { rebaseWorkItemScheduleCalendar } from '../../domain/work-item-schedule'
import { WORK_ITEM_SCHEDULE_CASCADE_LIMIT } from '../../domain/work-item-schedule-dependencies'

/** The fields of a Work Item a calendar change reads. */
export type WorkCalendarChangeWorkItem = {
  /** Team that owns the Work Item. */
  teamId: string
  /** Team-local Work Item identifier. */
  id: string
  /** Short reference such as `ABC-12`, when the Work Item has one. */
  key?: string
  /** Work Item title. */
  title: string
  /** Current Work Item revision. */
  revision: number
  /** Project the Work Item is assigned to, if any. */
  assignedProjectId?: string
  /** Current schedule. */
  schedule: WorkItemSchedule
}

/** One revision-bound schedule rewrite a calendar change makes. */
export type WorkCalendarScheduleUpdate = {
  /** Team that owns the Work Item. */
  teamId: string
  /** Team-local Work Item identifier. */
  workItemId: string
  /** Revision the rewrite was planned from. */
  expectedRevision: number
  /** Complete replacement schedule. */
  schedule: WorkItemSchedule
}

/** Rules that decide which Work Items a calendar change reaches and how. */
export type WorkCalendarChangeRules = {
  /** Shared calendar each Work Item follows before the change. */
  before(workItem: WorkCalendarChangeWorkItem): WorkItemScheduleCalendarPolicy
  /** Shared calendar each Work Item follows after the change. */
  after(workItem: WorkCalendarChangeWorkItem): WorkItemScheduleCalendarPolicy
  /** How date ranges keep their dates. */
  adjustment: WorkCalendarAdjustment
  /**
   * Whether the change may reach a Work Item at all. A Project calendar reaches only the Work
   * Items of that Project, whatever their stored policy says.
   */
  includes(workItem: WorkCalendarChangeWorkItem): boolean
  /** Whether the caller may see a Work Item as an example. */
  canShowExample(workItem: WorkCalendarChangeWorkItem): boolean
  /**
   * Whether an older Work Item without a calendar source follows the calendar when its rules
   * equal the calendar before the change. Team and Project changes adopt them; a Workspace change
   * does not, because it is applied after the new settings are saved.
   */
  adoptLegacy: boolean
}

/** Inputs of a calendar change plan. */
export type WorkCalendarChangePlanInput = WorkCalendarChangeRules & {
  /** Work Items the change may reach. */
  workItems: readonly WorkCalendarChangeWorkItem[]
}

/** A calendar change plan: what it does and the schedule rewrites it needs. */
export type WorkCalendarChangePlan = {
  /** Impact shown in the preview. */
  impact: WorkCalendarChangeImpact
  /** Schedule rewrites, in Team then Work Item order. */
  updates: WorkCalendarScheduleUpdate[]
}

/** Ports a calendar change reads and writes Work Items through. */
export type WorkCalendarChangePorts = {
  /** Reads the current Work Items the change may reach. */
  readWorkItems(): Promise<readonly WorkCalendarChangeWorkItem[]>
  /**
   * Rewrites schedules in one transaction.
   *
   * @throws ProjectDataError 409 when a Work Item changed since it was read.
   */
  writeSchedules(updates: readonly WorkCalendarScheduleUpdate[], batch: number): Promise<void>
  /**
   * Reads a value that changes whenever any calendar the change resolved from is saved again.
   * Rewrites stop once it differs from the value read after this change's own save, so an older
   * change never overwrites the schedules a newer one wrote.
   */
  readCalendarVersion(): Promise<string>
}

/**
 * Plans what a shared calendar change does to the Work Items that follow it (ADR 0058).
 *
 * A Work Item follows the calendar when its policy is marked `shared`, or when it is an older row
 * with its own policy that equals the calendar before the change; such a row is marked `shared`
 * when the change rewrites it. Only following Work Items whose rules differ from the new calendar
 * are rewritten; the impact counts those whose dates or working days change.
 *
 * @param input - Work Items, calendars before and after, and the adjustment.
 * @returns The impact and the rewrites.
 */
export function planWorkCalendarChange(input: WorkCalendarChangePlanInput): WorkCalendarChangePlan {
  const updates: WorkCalendarScheduleUpdate[] = []
  const examples: { example: WorkCalendarChangeExample, sortKey: string }[] = []
  let followingCount = 0
  let changedCount = 0
  let fallbackToKeepDurationCount = 0
  const ordered = input.workItems
    .filter((workItem) => input.includes(workItem))
    .sort((left, right) =>
      left.teamId === right.teamId ? compareText(left.id, right.id) : compareText(left.teamId, right.teamId))
  for (const workItem of ordered) {
    if (!followsCalendar(workItem, input)) continue
    followingCount += 1
    const current = workItem.schedule.calendarPolicy
    const after = input.after(workItem)
    // A row whose rules already match the new calendar needs no write; an older row stays as it is
    // until a change moves its dates, so a first change never rewrites every Work Item of a Team.
    if (haveSameWorkCalendarRules(current, after)) continue
    const rebased = rebaseWorkItemScheduleCalendar(workItem.schedule, after, input.adjustment)
    updates.push({
      teamId: workItem.teamId,
      workItemId: workItem.id,
      expectedRevision: workItem.revision,
      schedule: rebased.schedule,
    })
    const beforeDates = readScheduleDates(workItem.schedule)
    const afterDates = readScheduleDates(rebased.schedule)
    if (!beforeDates || !afterDates || sameDates(beforeDates, afterDates)) continue
    changedCount += 1
    if (rebased.fellBackToKeepDuration) fallbackToKeepDurationCount += 1
    if (!input.canShowExample(workItem)) continue
    examples.push({
      sortKey: `${beforeDates.startDate}\0${workItem.teamId}\0${workItem.id}`,
      example: {
        teamId: workItem.teamId,
        workItemId: workItem.id,
        ...(workItem.key ? { key: workItem.key } : {}),
        title: workItem.title,
        before: beforeDates,
        after: afterDates,
      },
    })
  }
  return {
    impact: {
      adjustment: input.adjustment,
      followingCount,
      changedCount,
      examples: examples
        .sort((left, right) => compareText(left.sortKey, right.sortKey))
        .slice(0, WORK_CALENDAR_CHANGE_EXAMPLE_LIMIT)
        .map((entry) => entry.example),
      fallbackToKeepDurationCount,
    },
    updates,
  }
}

/**
 * Shows what a calendar change would do without saving anything.
 *
 * @param rules - Which Work Items the change reaches and how.
 * @param ports - Work Item reads.
 * @returns The impact.
 */
export async function previewWorkCalendarChange(
  rules: WorkCalendarChangeRules,
  ports: Pick<WorkCalendarChangePorts, 'readWorkItems'>,
): Promise<WorkCalendarChangeImpact> {
  return planWorkCalendarChange({ ...rules, workItems: await ports.readWorkItems() }).impact
}

/**
 * Saves a calendar change, then rewrites the Work Items that follow the calendar.
 *
 * The plan is checked against the write limit before anything is saved. Rewrites go in bounded
 * transactions; a transaction that meets a concurrent Work Item change is retried once per Work
 * Item from a fresh read with the same before and after calendars, so an older Work Item that was
 * being adopted keeps its chance to follow the calendar. Before each further transaction and the
 * retry, the calendar version is read again; once a newer calendar change has been saved, this one
 * stops and counts the rest as conflicts, leaving them to the newer change. Work Items that still
 * conflict are counted.
 *
 * @param rules - Which Work Items the change reaches and how.
 * @param ports - Work Item reads and writes.
 * @param save - Saves the calendar itself, if this change stores one.
 * @returns The saved calendar, the impact, and how many Work Items were rewritten or skipped.
 * @throws ProjectDataError 413 when the change would rewrite more Work Items than one save may.
 */
export async function applyWorkCalendarChange(
  rules: WorkCalendarChangeRules,
  ports: WorkCalendarChangePorts,
  save?: () => Promise<WorkCalendar>,
): Promise<WorkCalendarChangeResult> {
  // Without a save of its own, the change is bound to the calendars as they were when it planned.
  const plannedVersion = save ? undefined : await ports.readCalendarVersion()
  const plan = planWorkCalendarChange({ ...rules, workItems: await ports.readWorkItems() })
  if (plan.updates.length > WORK_CALENDAR_CHANGE_MAX_WORK_ITEMS) {
    throw new ProjectDataError(
      413,
      'WorkCalendarChangeTooLarge',
      `A calendar change can adjust at most ${WORK_CALENDAR_CHANGE_MAX_WORK_ITEMS} Work Items at once.`,
    )
  }
  const calendar = save ? await save() : undefined
  const version = plannedVersion ?? await ports.readCalendarVersion()
  /** Reports whether a newer calendar change has started since this one saved. */
  const superseded = async () => await ports.readCalendarVersion() !== version
  let batch = 0
  let updatedCount = 0
  let conflictCount = 0
  const conflicted = new Set<string>()
  for (let index = 0; index < plan.updates.length; index += WORK_ITEM_SCHEDULE_CASCADE_LIMIT) {
    const chunk = plan.updates.slice(index, index + WORK_ITEM_SCHEDULE_CASCADE_LIMIT)
    if ((index > 0 || !save) && await superseded()) {
      // The newer change plans from the current Work Items and rewrites the rest itself.
      conflictCount += plan.updates.length - index
      return { ...(calendar ? { calendar } : {}), impact: plan.impact, updatedCount, conflictCount }
    }
    if (await writeOrConflict(ports, chunk, batch++)) updatedCount += chunk.length
    else for (const update of chunk) conflicted.add(workItemKey(update.teamId, update.workItemId))
  }
  if (conflicted.size > 0) {
    if (await superseded()) {
      conflictCount += conflicted.size
    } else {
      const fresh = await ports.readWorkItems()
      const retry = planWorkCalendarChange({
        ...rules,
        workItems: fresh.filter((workItem) => conflicted.has(workItemKey(workItem.teamId, workItem.id))),
      })
      // Work Items that no longer need a rewrite were settled by the concurrent change.
      for (const update of retry.updates) {
        if (await writeOrConflict(ports, [update], batch++)) updatedCount += 1
        else conflictCount += 1
      }
    }
  }
  return { ...(calendar ? { calendar } : {}), impact: plan.impact, updatedCount, conflictCount }
}

/**
 * Writes one transaction and reports a revision conflict instead of failing.
 *
 * @param ports - Work Item writes.
 * @param updates - Rewrites of the transaction.
 * @param batch - Transaction number within the change.
 * @returns Whether the transaction was written.
 */
async function writeOrConflict(
  ports: WorkCalendarChangePorts,
  updates: readonly WorkCalendarScheduleUpdate[],
  batch: number,
): Promise<boolean> {
  try {
    await ports.writeSchedules(updates, batch)
    return true
  } catch (error) {
    if (error instanceof ProjectDataError && error.status === 409) return false
    throw error
  }
}

/**
 * Reports whether a Work Item follows the calendar being changed.
 *
 * @param workItem - Work Item.
 * @param rules - Change rules.
 * @returns Whether its policy is shared, or an adoptable older policy.
 */
function followsCalendar(workItem: WorkCalendarChangeWorkItem, rules: WorkCalendarChangeRules): boolean {
  const current = workItem.schedule.calendarPolicy
  if (current.calendarSource === 'shared') return true
  return rules.adoptLegacy && haveSameWorkCalendarRules(current, rules.before(workItem))
}

/**
 * Builds the key of a Work Item within a Workspace.
 *
 * @param teamId - Team ID.
 * @param workItemId - Team-local Work Item ID.
 * @returns The key.
 */
function workItemKey(teamId: string, workItemId: string): string {
  return `${teamId}\0${workItemId}`
}

/**
 * Reads the dates of a date-range schedule.
 *
 * @param schedule - Canonical schedule.
 * @returns The dates, or undefined for a schedule without a date range.
 */
function readScheduleDates(schedule: WorkItemSchedule) {
  return schedule.mode === 'date-range'
    ? { startDate: schedule.startDate, endDate: schedule.endDate, durationDays: schedule.durationDays }
    : undefined
}

/**
 * Compares the dates of two date ranges.
 *
 * @param left - First dates.
 * @param right - Second dates.
 * @returns Whether start, end, and working days are equal.
 */
function sameDates(
  left: { startDate: string, endDate: string, durationDays: number },
  right: { startDate: string, endDate: string, durationDays: number },
): boolean {
  return left.startDate === right.startDate &&
    left.endDate === right.endDate &&
    left.durationDays === right.durationDays
}

/**
 * Compares text by UTF-16 code units, as the other deterministic orders do.
 *
 * @param left - First text.
 * @param right - Second text.
 * @returns A negative, zero, or positive number.
 */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
