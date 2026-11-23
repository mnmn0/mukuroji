import type { ProjectRaidScheduleChange, ProjectRaidScheduleChangeOperation, WorkItemSchedule } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import { labelProjectRaidReference, type ProjectRaidReferenceOption } from './projectRaidLogExport'

/**
 * Error raised when a requested date change conflicts with Work Item dependencies, so the
 * approver resolves the conflict on the Work Item first.
 */
export class ProjectChangeRequestScheduleConflictError extends Error {
  /** Work Item whose change conflicts. */
  readonly workItemId: string

  /**
   * Creates the error.
   *
   * @param workItemId - Work Item whose change conflicts.
   */
  constructor(workItemId: string) {
    super(`The date change of Work Item "${workItemId}" conflicts with its dependencies.`)
    this.name = 'ProjectChangeRequestScheduleConflictError'
    this.workItemId = workItemId
  }
}

/**
 * Reads the date of a requested change.
 *
 * @param operation - Requested change.
 * @returns The target date or the new end date.
 */
export function operationDate(operation: ProjectRaidScheduleChangeOperation) {
  return operation.type === 'move' ? operation.targetDate : operation.endDate
}

/**
 * Describes the requested date changes of an entry in one line.
 *
 * @param changes - Requested changes.
 * @param workItemOptions - Work Items with their display text.
 * @param t - Translator.
 * @returns The text.
 */
export function describeScheduleChanges(
  changes: readonly ProjectRaidScheduleChange[],
  workItemOptions: readonly ProjectRaidReferenceOption[],
  t: (key: MessageKey) => string,
) {
  return changes.map((change) => {
    const key: MessageKey = change.operation.type === 'move'
      ? 'projects.raidLog.schedule.moveTo'
      : 'projects.raidLog.schedule.endOn'
    return t(key)
      .replace('{item}', labelProjectRaidReference(workItemOptions, change.workItemId))
      .replace('{date}', operationDate(change.operation))
  }).join(' / ')
}

/**
 * Error raised when a related Work Item of a change request now belongs to another Project, so
 * approving the request would change dates outside the Project.
 */
export class ProjectChangeRequestWorkItemMovedError extends Error {
  /** Work Item that left the Project. */
  readonly workItemId: string

  /**
   * Creates the error.
   *
   * @param workItemId - Work Item that left the Project.
   */
  constructor(workItemId: string) {
    super(`Work Item "${workItemId}" no longer belongs to this Project.`)
    this.name = 'ProjectChangeRequestWorkItemMovedError'
    this.workItemId = workItemId
  }
}

/**
 * Tells whether a Work Item schedule already holds a requested change: a move puts the deadline,
 * milestone, or range start on the target date, and a resize puts a range end on the new date.
 *
 * @param schedule - Current Work Item schedule.
 * @param operation - Requested change.
 * @returns Whether the schedule matches the request.
 */
export function isScheduleChangeInPlace(
  schedule: WorkItemSchedule,
  operation: ProjectRaidScheduleChangeOperation,
): boolean {
  if (operation.type === 'resize') return schedule.mode === 'date-range' && schedule.endDate === operation.endDate
  switch (schedule.mode) {
    case 'unscheduled':
      return false
    case 'due-date':
      return schedule.dueDate === operation.targetDate
    case 'date-range':
    case 'milestone':
      return schedule.startDate === operation.targetDate
  }
}
