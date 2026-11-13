import type { CanonicalWorkItem } from '@mukuroji/contracts'
import {
  canWriteTaskViewWorkItem,
  type TaskViewWorkItemWriteCapabilities,
} from '../../../task-views/model/taskViewWorkItemPermission'

/** A Work Item offered when recording time. */
export type TimeEntryWorkItemChoice = {
  /** Work Item identifier. */
  id: string
  /** Title shown in the picker. */
  title: string
}

/**
 * Lists the Team's open Work Items that the server would accept a time entry for.
 *
 * Write access comes from server-returned scopes, so enterprise grants count and a missing scope
 * never widens to the whole Team.
 *
 * @param items - Work Items readable by the viewer.
 * @param teamId - Team whose time is being recorded.
 * @param capabilities - Server-effective write scopes, or undefined while they load.
 * @returns Choices sorted by title; empty until the scopes are known.
 */
export function selectTimeEntryWorkItemChoices(
  items: readonly Pick<CanonicalWorkItem, 'archivedAt' | 'assignedProjectId' | 'id' | 'teamId' | 'title'>[],
  teamId: string,
  capabilities: TaskViewWorkItemWriteCapabilities | undefined,
): TimeEntryWorkItemChoice[] {
  if (!capabilities) return []
  return items
    .filter((item) => item.teamId === teamId && !item.archivedAt)
    .filter((item) => canWriteTaskViewWorkItem(capabilities, item))
    .map((item) => ({ id: item.id, title: item.title }))
    .sort((left, right) => left.title.localeCompare(right.title))
}
