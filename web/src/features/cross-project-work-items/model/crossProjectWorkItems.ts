import type {
  CanonicalWorkItem,
  ResolvedWorkItemConfiguration,
  WorkspaceWorkItemListFilter,
} from '@mukuroji/contracts'
import type { ProjectDirectoryTeam } from '../../../projects/api/directory'
import type { TaskGanttGrouping } from '../../../tasks/model/taskGanttRows'
import { isOpenWorkItem, resolveWorkItemAssignee } from '../../../work-items/model/workItemDisplay'
import {
  createWorkspaceTaskStatusColumns,
  isTaskInWorkspaceStatusColumn,
  resolveWorkspaceTaskInvolvement,
} from '../../../work-items/model/workspaceWorkItems'

/** How the cross-Project Work Item table groups its rows. */
export type CrossProjectWorkItemGrouping = 'project' | 'assignee'

/** Read-only layouts of the cross-Project Work Item list. */
export type CrossProjectWorkItemLayout = 'table' | 'board' | 'gantt'

/** Every layout of the cross-Project Work Item list, in switcher order. */
export const crossProjectWorkItemLayouts: readonly CrossProjectWorkItemLayout[] = ['table', 'board', 'gantt']

/**
 * Filters and grouping of the cross-Project Work Item list, kept in the URL so a view can be
 * bookmarked and shared.
 *
 * Every field only narrows the Work Items the viewer can already read.
 */
export type CrossProjectWorkItemListState = {
  /** Team-qualified Projects to show. Empty means every readable Project. */
  projects: CrossProjectWorkItemProjectRef[]
  /** Whether completed and canceled Work Items are hidden. */
  openOnly: boolean
  /** Whether only Work Items the viewer owns or contributes to are shown. */
  mine: boolean
  /** Workspace member key that must appear as a contributor, when set. */
  contributorMemberId?: string
  /**
   * Team-qualified job role that must appear on a contributor assignment, when set.
   *
   * Job role IDs are unique only within one Team configuration, so the role carries its Team.
   */
  contributorJobRole?: CrossProjectWorkItemJobRoleRef
  /** Row grouping of the table, board swimlanes, and Gantt heading rows. */
  grouping: CrossProjectWorkItemGrouping
  /** Layout that shows the filtered Work Items. */
  layout: CrossProjectWorkItemLayout
}

/** Team-qualified Project reference, because a Project ID can appear in several Teams. */
export type CrossProjectWorkItemProjectRef = {
  /** Team that owns the Project. */
  teamId: string
  /** Team-local Project ID. */
  projectId: string
}

/** Team-qualified job role reference. */
export type CrossProjectWorkItemJobRoleRef = {
  /** Team whose Work Item configuration defines the role. */
  teamId: string
  /** Job role ID within that Team configuration. */
  jobRoleId: string
}

/** One selectable job role in the list filter. */
export type CrossProjectWorkItemJobRoleOption = CrossProjectWorkItemJobRoleRef & {
  /** Stable key used by the URL and by form controls. */
  key: string
  /** Job role name; falls back to the ID when no configuration defines it. */
  name: string
  /** Display name of the Team that defines the role. */
  teamName: string
}

/** One selectable Project in the list filter. */
export type CrossProjectWorkItemProjectOption = CrossProjectWorkItemProjectRef & {
  /** Stable key used by the URL and by form controls. */
  key: string
  /** Project display name. */
  name: string
  /** Display name of the owning Team. */
  teamName: string
}

/** One selectable contributor member in the list filter. */
export type CrossProjectWorkItemFilterOption = {
  /** Workspace member key. */
  id: string
  /** Display label; falls back to the ID when no name is known. */
  label: string
}

/** One group of rows in the cross-Project Work Item table. */
export type CrossProjectWorkItemGroup = {
  /** Stable group key used as the React key. */
  key: string
  /** Group heading; empty when the group collects Work Items without a Project or assignee. */
  label: string
  /** Secondary heading text, such as the owning Team name of a Project group. */
  detail?: string
  /** Whether the group collects Work Items without a Project or without an assignee. */
  isUnassigned: boolean
  /** Work Items of the group, ordered by due date and then title. */
  workItems: CanonicalWorkItem[]
}

/** One workflow status column of a board swimlane. */
export type CrossProjectWorkItemBoardColumn = {
  /** Team, Work Item Type, and status identity used as the React key. */
  key: string
  /** Column heading, prefixed with the Team and Type names when the swimlane mixes them. */
  label: string
  /** Work Items in this status, in the swimlane order. */
  workItems: CanonicalWorkItem[]
}

/** Status columns of one board swimlane. */
export type CrossProjectWorkItemBoardLane = {
  /** Workflow status columns of the Teams whose Work Items are in the swimlane. */
  columns: CrossProjectWorkItemBoardColumn[]
  /**
   * Work Items that fit no column, because their Team configuration did not load or their status
   * is not in the configured workflow.
   */
  unplacedWorkItems: CanonicalWorkItem[]
}

/** Labels the Gantt group headings need for groups without a Project or owner. */
export type CrossProjectWorkItemGanttGroupLabels = {
  /** Heading of Work Items without a Project. */
  noProject: string
  /** Heading of Work Items without an owner. */
  noAssignee: string
}

/** URL query parameter names owned by the cross-Project Work Item list. */
const queryParameter = {
  project: 'project',
  status: 'status',
  mine: 'mine',
  member: 'member',
  role: 'role',
  group: 'group',
  layout: 'layout',
} as const

/** Separator between the encoded Team ID and the Team-local ID of one query value. */
const teamScopedIdSeparator = ':'

/** Default state used when the URL carries no list parameters. */
export const defaultCrossProjectWorkItemListState: CrossProjectWorkItemListState = {
  projects: [],
  openOnly: true,
  mine: false,
  grouping: 'project',
  layout: 'table',
}

/**
 * Creates the stable key of a Team-qualified Project reference.
 *
 * Both IDs are URI-encoded so that a separator inside an ID cannot change the meaning.
 *
 * @param ref - Team-qualified Project reference.
 * @returns Key used in the URL and in form controls.
 */
export function createCrossProjectWorkItemProjectKey(ref: CrossProjectWorkItemProjectRef) {
  return createTeamScopedKey(ref.teamId, ref.projectId)
}

/**
 * Creates the stable key of a Team-qualified job role reference.
 *
 * @param ref - Team-qualified job role reference.
 * @returns Key used in the URL and in form controls.
 */
export function createCrossProjectWorkItemJobRoleKey(ref: CrossProjectWorkItemJobRoleRef) {
  return createTeamScopedKey(ref.teamId, ref.jobRoleId)
}

/**
 * Joins a Team ID and a Team-local ID, URI-encoding both so a separator inside an ID is kept.
 *
 * @param teamId - Owning Team ID.
 * @param localId - ID that is unique only within the Team.
 * @returns The combined key.
 */
function createTeamScopedKey(teamId: string, localId: string) {
  return `${encodeURIComponent(teamId)}${teamScopedIdSeparator}${encodeURIComponent(localId)}`
}

/**
 * Splits a key created by {@link createTeamScopedKey}.
 *
 * @param value - Raw key from the URL.
 * @returns The Team ID and Team-local ID, or undefined for a malformed key.
 */
function parseTeamScopedKey(value: string): [teamId: string, localId: string] | undefined {
  const separatorIndex = value.indexOf(teamScopedIdSeparator)
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) return undefined
  try {
    const teamId = decodeURIComponent(value.slice(0, separatorIndex))
    const localId = decodeURIComponent(value.slice(separatorIndex + 1))
    return teamId && localId ? [teamId, localId] : undefined
  } catch {
    return undefined
  }
}

/**
 * Reads the list state from URL query parameters, ignoring unknown or malformed values.
 *
 * @param searchParams - Current URL query parameters.
 * @returns The list state, with defaults for missing parameters.
 */
export function parseCrossProjectWorkItemListState(
  searchParams: URLSearchParams,
): CrossProjectWorkItemListState {
  const projectsByKey = new Map<string, CrossProjectWorkItemProjectRef>()
  for (const value of searchParams.getAll(queryParameter.project)) {
    const parts = parseTeamScopedKey(value)
    if (!parts) continue
    const ref = { teamId: parts[0], projectId: parts[1] }
    projectsByKey.set(createCrossProjectWorkItemProjectKey(ref), ref)
  }
  const contributorMemberId = searchParams.get(queryParameter.member)?.trim()
  const roleParts = parseTeamScopedKey(searchParams.get(queryParameter.role) ?? '')
  return {
    projects: [...projectsByKey.values()],
    openOnly: searchParams.get(queryParameter.status) !== 'all',
    mine: searchParams.get(queryParameter.mine) === '1',
    ...(contributorMemberId ? { contributorMemberId } : {}),
    ...(roleParts ? { contributorJobRole: { teamId: roleParts[0], jobRoleId: roleParts[1] } } : {}),
    grouping: searchParams.get(queryParameter.group) === 'assignee' ? 'assignee' : 'project',
    layout: parseCrossProjectWorkItemLayout(searchParams.get(queryParameter.layout)),
  }
}

/**
 * Reads a layout query value, falling back to the table for missing or unknown values.
 *
 * @param value - Raw `layout` query value.
 * @returns A supported layout.
 */
function parseCrossProjectWorkItemLayout(value: string | null): CrossProjectWorkItemLayout {
  return crossProjectWorkItemLayouts.find((layout) => layout === value) ?? 'table'
}

/**
 * Writes the list state as URL query parameters, leaving defaults out.
 *
 * @param state - List state to serialize.
 * @returns Query parameters that {@link parseCrossProjectWorkItemListState} reads back.
 */
export function createCrossProjectWorkItemListSearchParams(
  state: CrossProjectWorkItemListState,
) {
  const searchParams = new URLSearchParams()
  for (const ref of state.projects) {
    searchParams.append(queryParameter.project, createCrossProjectWorkItemProjectKey(ref))
  }
  if (!state.openOnly) searchParams.set(queryParameter.status, 'all')
  if (state.mine) searchParams.set(queryParameter.mine, '1')
  if (state.contributorMemberId) searchParams.set(queryParameter.member, state.contributorMemberId)
  if (state.contributorJobRole) {
    searchParams.set(queryParameter.role, createCrossProjectWorkItemJobRoleKey(state.contributorJobRole))
  }
  if (state.grouping !== 'project') searchParams.set(queryParameter.group, state.grouping)
  if (state.layout !== 'table') searchParams.set(queryParameter.layout, state.layout)
  return searchParams
}

/**
 * Converts the list state into the server-side filter of `GET /api/work-items`.
 *
 * The server filter only narrows the read; the client filter in
 * {@link filterCrossProjectWorkItems} still applies the full state. When every selected
 * Project belongs to one Team, the read is narrowed to that Team, and to the Project itself
 * when only one is selected.
 *
 * @param state - Current list state.
 * @returns Server-side filter that never widens what the client shows.
 */
export function createCrossProjectWorkItemServerFilter(
  state: CrossProjectWorkItemListState,
): WorkspaceWorkItemListFilter {
  const teamIds = new Set(state.projects.map((ref) => ref.teamId))
  const [onlyTeamId] = teamIds.size === 1 ? [...teamIds] : []
  const [onlyProject] = state.projects.length === 1 ? state.projects : []
  return {
    ...(state.mine ? { involvement: 'mine' as const } : {}),
    ...(state.openOnly ? { openOnly: true } : {}),
    ...(onlyTeamId ? { teamId: onlyTeamId } : {}),
    ...(onlyProject ? { projectId: onlyProject.projectId } : {}),
  }
}

/**
 * Applies the list state to Work Items the viewer can read.
 *
 * @param workItems - Work Items returned by the permission-filtered Workspace list API.
 * @param state - Current list state.
 * @param userIdentityAliases - Identifiers of the current viewer, used by the `mine` filter.
 * @returns Work Items that match every filter of the state.
 */
export function filterCrossProjectWorkItems(
  workItems: readonly CanonicalWorkItem[],
  state: CrossProjectWorkItemListState,
  userIdentityAliases: readonly string[],
) {
  const projectKeys = new Set(state.projects.map(createCrossProjectWorkItemProjectKey))
  return workItems.filter((workItem) => {
    if (projectKeys.size > 0) {
      if (!workItem.assignedProjectId) return false
      const key = createCrossProjectWorkItemProjectKey({
        teamId: workItem.teamId,
        projectId: workItem.assignedProjectId,
      })
      if (!projectKeys.has(key)) return false
    }
    if (state.openOnly && !isOpenWorkItem(workItem)) return false
    if (state.mine && !resolveWorkspaceTaskInvolvement(workItem, userIdentityAliases)) return false
    const assignments = workItem.contributorAssignments ?? []
    if (
      state.contributorMemberId &&
      !assignments.some((assignment) => assignment.memberUserId === state.contributorMemberId)
    ) {
      return false
    }
    const role = state.contributorJobRole
    if (
      role &&
      (workItem.teamId !== role.teamId ||
        !assignments.some((assignment) => assignment.jobRoleId === role.jobRoleId))
    ) {
      return false
    }
    return true
  })
}

/**
 * Lists the readable Projects of the directory as filter options, ordered by Team and name.
 *
 * @param teams - Workspace Team and Project directory visible to the viewer.
 * @returns Project options with Team-qualified keys.
 */
export function createCrossProjectWorkItemProjectOptions(
  teams: readonly ProjectDirectoryTeam[],
): CrossProjectWorkItemProjectOption[] {
  return teams
    .flatMap((team) => team.projects.map((project) => ({
      key: createCrossProjectWorkItemProjectKey({ teamId: team.id, projectId: project.id }),
      name: project.name,
      projectId: project.id,
      teamId: team.id,
      teamName: team.name,
    })))
    .sort((left, right) =>
      left.teamName.localeCompare(right.teamName) || left.name.localeCompare(right.name),
    )
}

/**
 * Lists the members who appear as contributors on the given Work Items.
 *
 * @param workItems - Work Items the viewer can read.
 * @param memberLabels - Known display labels keyed by Workspace member key.
 * @param selectedMemberId - Member kept in the list even when no loaded Work Item names them.
 * @returns Contributor member options ordered by label.
 */
export function createCrossProjectWorkItemMemberOptions(
  workItems: readonly CanonicalWorkItem[],
  memberLabels: ReadonlyMap<string, string>,
  selectedMemberId?: string,
): CrossProjectWorkItemFilterOption[] {
  const ids = new Set<string>()
  for (const workItem of workItems) {
    for (const assignment of workItem.contributorAssignments ?? []) {
      if (assignment.memberUserId) ids.add(assignment.memberUserId)
    }
  }
  if (selectedMemberId) ids.add(selectedMemberId)
  return [...ids]
    .map((id) => ({ id, label: memberLabels.get(id) ?? id }))
    .sort((left, right) => left.label.localeCompare(right.label))
}

/**
 * Lists the job roles of the loaded Team configurations, and roles the Work Items use, per Team.
 *
 * A role ID is unique only within its Team configuration, so every option keeps its Team.
 *
 * @param workItems - Work Items the viewer can read.
 * @param configurationsByTeam - Resolved Team configurations keyed by Team ID.
 * @param teams - Workspace directory used for Team names.
 * @param selectedJobRole - Role kept in the list even when nothing loaded defines it.
 * @returns Job role options ordered by name and then Team name.
 */
export function createCrossProjectWorkItemJobRoleOptions(
  workItems: readonly CanonicalWorkItem[],
  configurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>,
  teams: readonly ProjectDirectoryTeam[],
  selectedJobRole?: CrossProjectWorkItemJobRoleRef,
): CrossProjectWorkItemJobRoleOption[] {
  const options = new Map<string, CrossProjectWorkItemJobRoleOption>()
  const add = (teamId: string, jobRoleId: string, name: string) => {
    const key = createCrossProjectWorkItemJobRoleKey({ teamId, jobRoleId })
    if (options.has(key)) return
    const teamName = teams.find((team) => team.id === teamId)?.name ?? teamId
    options.set(key, { key, teamId, jobRoleId, name, teamName })
  }
  for (const [teamId, resolved] of Object.entries(configurationsByTeam)) {
    for (const role of resolved.configuration.jobRoles ?? []) add(teamId, role.id, role.name)
  }
  for (const workItem of workItems) {
    for (const assignment of workItem.contributorAssignments ?? []) {
      if (assignment.jobRoleId) add(workItem.teamId, assignment.jobRoleId, assignment.jobRoleId)
    }
  }
  if (selectedJobRole) add(selectedJobRole.teamId, selectedJobRole.jobRoleId, selectedJobRole.jobRoleId)
  return [...options.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || left.teamName.localeCompare(right.teamName),
  )
}

/**
 * Groups Work Items by Team-qualified Project or by accountable owner.
 *
 * Named groups come first in label order; the group without a Project or assignee comes last.
 *
 * @param workItems - Filtered Work Items.
 * @param grouping - Row grouping of the table.
 * @param teams - Workspace directory used for Project and Team names.
 * @returns Groups with their Work Items ordered by due date and then title.
 */
export function groupCrossProjectWorkItems(
  workItems: readonly CanonicalWorkItem[],
  grouping: CrossProjectWorkItemGrouping,
  teams: readonly ProjectDirectoryTeam[],
): CrossProjectWorkItemGroup[] {
  const groups = new Map<string, CrossProjectWorkItemGroup>()
  for (const workItem of workItems) {
    const group = resolveGroupIdentity(workItem, grouping, teams)
    const existing = groups.get(group.key)
    if (existing) {
      existing.workItems.push(workItem)
    } else {
      groups.set(group.key, { ...group, workItems: [workItem] })
    }
  }
  return [...groups.values()]
    .map((group) => ({ ...group, workItems: [...group.workItems].sort(compareWorkItems) }))
    .sort((left, right) =>
      Number(left.isUnassigned) - Number(right.isUnassigned) ||
      left.label.localeCompare(right.label) ||
      (left.detail ?? '').localeCompare(right.detail ?? ''),
    )
}

/**
 * Resolves the group a Work Item belongs to, without its rows.
 *
 * @param workItem - Work Item to place.
 * @param grouping - Row grouping of the table.
 * @param teams - Workspace directory used for Project and Team names.
 * @returns Group key, labels, and whether it is the unassigned group.
 */
function resolveGroupIdentity(
  workItem: CanonicalWorkItem,
  grouping: CrossProjectWorkItemGrouping,
  teams: readonly ProjectDirectoryTeam[],
): Omit<CrossProjectWorkItemGroup, 'workItems'> {
  if (grouping === 'assignee') {
    const assigneeId = workItem.assigneeUserId
    return assigneeId
      ? { key: `assignee:${assigneeId}`, label: resolveWorkItemAssignee(workItem), isUnassigned: false }
      : { key: 'assignee:', label: '', isUnassigned: true }
  }
  const projectId = workItem.assignedProjectId
  if (!projectId) return { key: 'project:', label: '', isUnassigned: true }
  const team = teams.find((candidate) => candidate.id === workItem.teamId)
  const project = team?.projects.find((candidate) => candidate.id === projectId)
  return {
    key: `project:${createCrossProjectWorkItemProjectKey({ teamId: workItem.teamId, projectId })}`,
    label: project?.name ?? projectId,
    ...(team ? { detail: team.name } : {}),
    isUnassigned: false,
  }
}

/**
 * Orders Work Items by due date, with undated items last, and then by title.
 *
 * @param left - First Work Item.
 * @param right - Second Work Item.
 * @returns Negative, zero, or positive as in `Array.prototype.sort`.
 */
function compareWorkItems(left: CanonicalWorkItem, right: CanonicalWorkItem) {
  const leftDue = left.dueDate || '￿'
  const rightDue = right.dueDate || '￿'
  return leftDue.localeCompare(rightDue) || left.title.localeCompare(right.title)
}

/**
 * Places the Work Items of one group into the workflow status columns of their Teams.
 *
 * Every status of each Team present in the group gets a column, so a Project swimlane shows its
 * whole workflow even when some statuses are empty.
 *
 * @param workItems - Work Items of one group, already ordered.
 * @param configurationsByTeam - Resolved Team configurations keyed by Team ID.
 * @param teams - Workspace directory used for Team names in column headings.
 * @returns The swimlane columns and the Work Items no column can hold.
 */
export function createCrossProjectWorkItemBoardLane(
  workItems: readonly CanonicalWorkItem[],
  configurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>,
  teams: readonly ProjectDirectoryTeam[],
): CrossProjectWorkItemBoardLane {
  const statusColumns = createWorkspaceTaskStatusColumns(workItems, configurationsByTeam, teams)
  const placed = new Set<CanonicalWorkItem>()
  const columns = statusColumns.map((column) => {
    const columnWorkItems = workItems.filter((workItem) => isTaskInWorkspaceStatusColumn(workItem, column))
    for (const workItem of columnWorkItems) placed.add(workItem)
    return { key: column.key, label: column.label, workItems: columnWorkItems }
  })
  return { columns, unplacedWorkItems: workItems.filter((workItem) => !placed.has(workItem)) }
}

/**
 * Creates the Gantt heading-row grouping that matches the list grouping.
 *
 * Project headings carry the Team name, because Project names can repeat across Teams.
 *
 * @param grouping - Grouping selected in the list.
 * @param teams - Workspace directory used for Project and Team names.
 * @param labels - Headings of the groups without a Project or owner.
 * @returns Grouping passed to the Gantt chart.
 */
export function createCrossProjectWorkItemGanttGrouping(
  grouping: CrossProjectWorkItemGrouping,
  teams: readonly ProjectDirectoryTeam[],
  labels: CrossProjectWorkItemGanttGroupLabels,
): TaskGanttGrouping {
  return {
    direction: 'asc',
    resolve: (workItem) => {
      const group = resolveGroupIdentity(workItem, grouping, teams)
      if (group.isUnassigned) {
        return { key: group.key, label: grouping === 'assignee' ? labels.noAssignee : labels.noProject }
      }
      return { key: group.key, label: group.detail ? `${group.label} · ${group.detail}` : group.label }
    },
  }
}
