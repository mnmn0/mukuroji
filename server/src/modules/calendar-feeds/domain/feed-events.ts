import type {
  CalendarFeedLocale,
  CanonicalWorkItem,
  PlanningEntity,
} from '@mukuroji/contracts'
import type { CalendarFeedEvent } from './icalendar'

/** Work Item fields a feed event is built from. */
export type CalendarFeedWorkItem = Pick<
  CanonicalWorkItem,
  'id' | 'teamId' | 'key' | 'title' | 'schedule' | 'revision'
>

/** Planning fields a Milestone or Cycle event is built from. */
export type CalendarFeedPlanningEntity = Pick<PlanningEntity, 'id' | 'type' | 'title' | 'forecast'>

/** Localized words of feed titles. */
type FeedLabels = {
  /** Prefix of a deadline-only Work Item. */
  due: string
  /** Prefix of a Planning Milestone. */
  milestone: string
  /** Prefix of a Cycle. */
  cycle: string
  /** Name of a member feed. */
  memberCalendar: string
  /** Name of a Project feed, before the Project name. */
  projectCalendar: string
}

/** Labels of each feed locale. */
const LABELS: Record<CalendarFeedLocale, FeedLabels> = {
  ja: {
    due: '期限',
    milestone: 'マイルストーン',
    cycle: 'Cycle',
    memberCalendar: 'Mukuroji: 自分の予定',
    projectCalendar: 'Mukuroji',
  },
  en: {
    due: 'Due',
    milestone: 'Milestone',
    cycle: 'Cycle',
    memberCalendar: 'Mukuroji: My schedule',
    projectCalendar: 'Mukuroji',
  },
}

/** Domain part of every event UID. */
const UID_DOMAIN = 'mukuroji'

/**
 * Maps a Work Item schedule to an all-day event.
 *
 * A deadline-only item is a one-day event on its deadline, a date range spans its inclusive
 * dates, and a milestone item is a one-day event. An unscheduled item has no event.
 *
 * @param workItem - Work Item the caller can read.
 * @param locale - Language of the title.
 * @returns The event, or `undefined` when the item has no date.
 */
export function toWorkItemFeedEvent(
  workItem: CalendarFeedWorkItem,
  locale: CalendarFeedLocale,
): CalendarFeedEvent | undefined {
  const labels = LABELS[locale]
  const title = workItem.key ? `${workItem.key} ${workItem.title}` : workItem.title
  const base = {
    uid: `work-item.${encodeURIComponent(workItem.teamId)}.${encodeURIComponent(workItem.id)}@${UID_DOMAIN}`,
    sequence: workItem.revision,
  }
  const schedule = workItem.schedule
  switch (schedule.mode) {
    case 'unscheduled':
      return undefined
    case 'due-date':
      return {
        ...base,
        startDate: schedule.dueDate,
        endDate: schedule.dueDate,
        summary: `${labels.due}: ${title}`,
      }
    case 'date-range':
      return { ...base, startDate: schedule.startDate, endDate: schedule.endDate, summary: title }
    case 'milestone':
      return { ...base, startDate: schedule.startDate, endDate: schedule.endDate, summary: `◆ ${title}` }
  }
}

/**
 * Maps a Planning Milestone to a one-day event on its forecast date, and a Cycle to an event
 * that spans its forecast range, so both of its boundaries show.
 *
 * @param entity - Milestone or Cycle the caller can read.
 * @param locale - Language of the title.
 * @returns The event, or `undefined` for another entity type.
 */
export function toPlanningFeedEvent(
  entity: CalendarFeedPlanningEntity,
  locale: CalendarFeedLocale,
): CalendarFeedEvent | undefined {
  const labels = LABELS[locale]
  const uid = `planning.${encodeURIComponent(entity.id)}@${UID_DOMAIN}`
  if (entity.type === 'milestone') {
    return {
      uid,
      startDate: entity.forecast.endDate,
      endDate: entity.forecast.endDate,
      summary: `◆ ${labels.milestone}: ${entity.title}`,
    }
  }
  if (entity.type === 'cycle') {
    return {
      uid,
      startDate: entity.forecast.startDate,
      endDate: entity.forecast.endDate,
      summary: `${labels.cycle}: ${entity.title}`,
    }
  }
  return undefined
}

/**
 * Names the calendar a feed creates in the subscriber's client.
 *
 * @param kind - Feed kind.
 * @param locale - Language of the name.
 * @param projectName - Project name, for a Project feed.
 * @returns The calendar name.
 */
export function calendarFeedName(
  kind: 'member' | 'project',
  locale: CalendarFeedLocale,
  projectName?: string,
): string {
  const labels = LABELS[locale]
  if (kind === 'member') return labels.memberCalendar
  return projectName ? `${labels.projectCalendar}: ${projectName}` : labels.projectCalendar
}
