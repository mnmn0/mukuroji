import {
  countWorkItemCalendarDaysBetween,
  readWorkItemPlannedEndDate,
  weeklyReportWeekEnd,
  WEEKLY_SUMMARY_SECTION_ITEM_LIMIT,
  type CanonicalWorkItem,
  type ProjectScheduleBaseline,
  type TeamWeeklySummaryResponse,
  type WeeklySummaryItem,
  type WeeklySummaryScope,
  type WeeklySummarySectionName,
} from '@mukuroji/contracts'

/** Work Item fields the weekly summary reads. */
export type WeeklySummaryWorkItem = Pick<
  CanonicalWorkItem,
  'id' | 'key' | 'title' | 'schedule' | 'statusCategory' | 'actualEndDate' | 'archivedAt'
> & {
  /** Project the Work Item is assigned to, if any. */
  assignedProjectId?: string
}

/** Inputs of {@link buildTeamWeeklySummary}, after the route authorized the reader. */
export type TeamWeeklySummaryInput<TWorkItem extends WeeklySummaryWorkItem> = {
  /** Team summarized. */
  teamId: string
  /** First day of the week as `YYYY-MM-DD`. */
  weekStart: string
  /** Instant the summary is computed at. */
  now: Date
  /** Projects of the Team the reader may read, in display order. */
  projectIds: readonly string[]
  /** Latest baseline of each readable Project; a Project without one maps to `null`. */
  baselines: ReadonlyMap<string, ProjectScheduleBaseline | null>
  /** The Team's non-archived Work Items the reader may read. */
  workItems: Iterable<TWorkItem>
  /**
   * Returns today's date in the Work Item's schedule calendar, so "overdue" follows the calendar
   * its dates are written in.
   *
   * @param workItem - Work Item.
   * @returns Local `YYYY-MM-DD` date of `now`.
   */
  localToday: (workItem: TWorkItem) => string
}

/** Matching Work Items of one section before they are cut to the listed limit. */
type SectionAccumulator = {
  /** Number of matches. */
  count: number
  /** Matches with the key they are ordered by: a date, or minus the delay in days. */
  items: { order: string | number; item: WeeklySummaryItem }[]
}

/** Sections of one scope while Work Items are added. */
type ScopeAccumulator = {
  /** Project ID, or undefined for Work Items outside any Project. */
  projectId?: string
  /** Planned end of each Work Item in the baseline, keyed by Work Item ID. */
  baselineEnds?: ReadonlyMap<string, string>
  /** Baseline of the Project, `null` when none, undefined outside any Project. */
  baseline?: ProjectScheduleBaseline | null
  /** Section accumulators. */
  sections: Record<WeeklySummarySectionName, SectionAccumulator>
}

/**
 * Computes the weekly summary of a Team and each of its readable Projects: Work Items completed
 * in the week, delays against the Project schedule baseline, overdue Work Items, and Milestones
 * reached.
 *
 * "Open" means the Work Item's current status is neither completed nor canceled. A Work Item is
 * overdue when it is open and its planned end is before the day after the week, or before today
 * while the week is still running. A Work Item is delayed when it completed in the week after
 * its baseline end, or when it is open and its current planned end is after its baseline end.
 *
 * @param input - Week, readable Projects, baselines, and readable Work Items.
 * @returns The summary.
 */
export function buildTeamWeeklySummary<TWorkItem extends WeeklySummaryWorkItem>(
  input: TeamWeeklySummaryInput<TWorkItem>,
): TeamWeeklySummaryResponse {
  const weekEnd = weeklyReportWeekEnd(input.weekStart)
  const dayAfterWeek = addDays(weekEnd, 1)
  const scopes = new Map<string, ScopeAccumulator>()
  for (const projectId of input.projectIds) {
    const baseline = input.baselines.get(projectId) ?? null
    scopes.set(projectId, {
      projectId,
      baseline,
      ...(baseline === null
        ? {}
        : {
            baselineEnds: new Map(baseline.entries.flatMap((entry) =>
              entry.endDate === undefined ? [] : [[entry.workItemId, entry.endDate] as const])),
          }),
      sections: createSections(),
    })
  }
  const readableProjects = new Set(input.projectIds)
  let unassigned: ScopeAccumulator | undefined

  for (const workItem of input.workItems) {
    if (workItem.archivedAt !== undefined) continue
    let scope: ScopeAccumulator | undefined
    if (workItem.assignedProjectId === undefined) {
      unassigned ??= { sections: createSections() }
      scope = unassigned
    } else if (readableProjects.has(workItem.assignedProjectId)) {
      scope = scopes.get(workItem.assignedProjectId)
    }
    // A Work Item of a Project the reader cannot open is never counted.
    if (!scope) continue

    const plannedEndDate = readWorkItemPlannedEndDate(workItem.schedule)
    const baselineEndDate = scope.baselineEnds?.get(workItem.id)
    const item: WeeklySummaryItem = {
      workItemId: workItem.id,
      ...(workItem.key === undefined ? {} : { key: workItem.key }),
      title: workItem.title,
      ...(plannedEndDate === undefined ? {} : { plannedEndDate }),
      ...(workItem.actualEndDate === undefined ? {} : { actualEndDate: workItem.actualEndDate }),
      ...(baselineEndDate === undefined ? {} : { baselineEndDate }),
    }
    const open = workItem.statusCategory !== 'completed' && workItem.statusCategory !== 'canceled'
    const completedInWeek = workItem.statusCategory === 'completed' &&
      workItem.actualEndDate !== undefined &&
      workItem.actualEndDate >= input.weekStart &&
      workItem.actualEndDate <= weekEnd

    if (completedInWeek) {
      const completedOn = workItem.actualEndDate ?? ''
      add(scope.sections.completed, item, completedOn)
      if (workItem.schedule.mode === 'milestone') add(scope.sections.milestonesReached, item, completedOn)
    }
    if (open && plannedEndDate !== undefined) {
      const today = input.localToday(workItem)
      const cutoff = today < dayAfterWeek ? today : dayAfterWeek
      if (plannedEndDate < cutoff) add(scope.sections.overdue, item, plannedEndDate)
    }
    const measuredEnd = completedInWeek ? workItem.actualEndDate : open ? plannedEndDate : undefined
    const delayDays = countWorkItemCalendarDaysBetween(baselineEndDate, measuredEnd)
    if (delayDays !== undefined && delayDays > 0) {
      // Most delayed first.
      add(scope.sections.delayed, { ...item, delayDays }, -delayDays)
    }
  }

  const orderedScopes = [...scopes.values(), ...(unassigned ? [unassigned] : [])].map(toScope)
  /**
   * Sums one section across the scopes.
   *
   * @param name - Section.
   * @returns The total count.
   */
  const total = (name: WeeklySummarySectionName) => orderedScopes.reduce((sum, scope) => sum + scope[name].count, 0)
  const totals = {
    completed: total('completed'),
    delayed: total('delayed'),
    overdue: total('overdue'),
    milestonesReached: total('milestonesReached'),
  }
  return {
    teamId: input.teamId,
    weekStart: input.weekStart,
    weekEnd,
    generatedAt: input.now.toISOString(),
    totals,
    scopes: orderedScopes,
  }
}

/**
 * Creates empty section accumulators.
 *
 * @returns One accumulator per section.
 */
function createSections(): Record<WeeklySummarySectionName, SectionAccumulator> {
  return {
    completed: { count: 0, items: [] },
    delayed: { count: 0, items: [] },
    overdue: { count: 0, items: [] },
    milestonesReached: { count: 0, items: [] },
  }
}

/**
 * Adds a matching Work Item to a section.
 *
 * @param section - Section accumulator.
 * @param item - Listed Work Item.
 * @param order - Sort key; smaller keys are listed first.
 */
function add(section: SectionAccumulator, item: WeeklySummaryItem, order: string | number) {
  section.count += 1
  section.items.push({ order, item })
}

/**
 * Converts a scope accumulator to the response shape, listing at most the section limit.
 *
 * @param scope - Scope accumulator.
 * @returns The scope.
 */
function toScope(scope: ScopeAccumulator): WeeklySummaryScope {
  /**
   * Orders and cuts one section.
   *
   * @param section - Section accumulator.
   * @returns The section.
   */
  const finish = (section: SectionAccumulator) => ({
    count: section.count,
    items: section.items
      .sort((left, right) => compareOrder(left.order, right.order) || compare(itemLabel(left.item), itemLabel(right.item)))
      .slice(0, WEEKLY_SUMMARY_SECTION_ITEM_LIMIT)
      .map(({ item }) => item),
  })
  return {
    ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
    ...(scope.projectId === undefined
      ? {}
      : { baseline: scope.baseline ? { revision: scope.baseline.revision, capturedAt: scope.baseline.capturedAt } : null }),
    completed: finish(scope.sections.completed),
    delayed: finish(scope.sections.delayed),
    overdue: finish(scope.sections.overdue),
    milestonesReached: finish(scope.sections.milestonesReached),
  }
}

/**
 * Builds the tie-breaking label of a listed Work Item.
 *
 * @param item - Listed Work Item.
 * @returns Key, title, and ID.
 */
function itemLabel(item: WeeklySummaryItem) {
  return `${item.key ?? ''}\u0000${item.title}\u0000${item.workItemId}`
}

/**
 * Compares strings by code unit order, so the result does not depend on the server locale.
 *
 * @param left - Left value.
 * @param right - Right value.
 * @returns Negative, zero, or positive.
 */
function compare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Compares two section order keys; a section uses keys of one type only.
 *
 * @param left - Left key.
 * @param right - Right key.
 * @returns Negative, zero, or positive.
 */
function compareOrder(left: string | number, right: string | number) {
  if (typeof left === 'number' && typeof right === 'number') return left - right
  return compare(String(left), String(right))
}

/**
 * Adds days to a `YYYY-MM-DD` date.
 *
 * @param date - Calendar date.
 * @param days - Days to add.
 * @returns The shifted date.
 */
function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}
