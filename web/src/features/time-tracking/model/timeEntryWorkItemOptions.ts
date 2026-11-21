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

/** Where a member may record indirect work, such as a meeting, in one Team. */
export type IndirectTimeEntryTargetChoices = {
  /** Team Projects the server would accept the time on, sorted by name. */
  projects: Array<{ id: string; name: string }>
  /** Whether time without a Project may be recorded, which needs the Team scope. */
  allowNoProject: boolean
}

/**
 * Lists where the server would accept indirect work: Projects with a Team-qualified write scope,
 * and no Project when the Team scope is writable, the same rule as a Work Item without a Project.
 *
 * @param projects - Projects of the Team.
 * @param teamId - Team whose time is being recorded.
 * @param capabilities - Server-effective write scopes.
 * @returns Writable Projects and whether no Project may be chosen.
 */
export function selectIndirectTimeEntryTargets(
  projects: readonly { id: string; name: string }[],
  teamId: string,
  capabilities: TaskViewWorkItemWriteCapabilities,
): IndirectTimeEntryTargetChoices {
  return {
    projects: projects
      .filter((project) => capabilities.writableProjectScopes.some((scope) => scope.teamId === teamId && scope.projectId === project.id))
      .map((project) => ({ id: project.id, name: project.name }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    allowNoProject: capabilities.writableTeamIds.includes(teamId),
  }
}
