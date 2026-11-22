import type { DocumentScope } from '@mukuroji/contracts'
import {
  isActiveProjectAssignmentCandidate,
  type ProjectDirectoryTeam,
} from '../../projects/api'
import {
  useActiveDirectoryMembers,
  useTeamProjectMembers,
} from '../../projects/queries/useProjectMembers'
import type { ChecklistAssigneeOption } from '../model/checklistItems'

/**
 * Owner options of one Document and the state of the member reads behind them.
 */
export type ChecklistAssigneeOptionsState = {
  /** Members offered as owners, sorted by label. */
  options: readonly ChecklistAssigneeOption[]
  /** Whether a member read failed, so some owners may be missing. */
  hasError: boolean
  /** Reads the members again after a failure. */
  retry: () => void
}

/**
 * Loads the members offered as checklist item owners in one Document.
 *
 * A Project Document offers that Project's members. A Workspace Document
 * offers the members of every Project the viewer can see, de-duplicated.
 * Inactive members are left out, while an owner saved earlier is still shown
 * by the editor.
 *
 * @param accessToken - Bearer token for the Project member API.
 * @param teams - Teams and Projects visible to the viewer.
 * @param scope - Scope of the open Document.
 * @param enabled - Whether the Document has checklist items to assign.
 * @returns Owner options sorted by label, and whether some member reads failed.
 */
export function useChecklistAssigneeOptions(
  accessToken: string | undefined,
  teams: readonly ProjectDirectoryTeam[],
  scope: DocumentScope | undefined,
  enabled: boolean,
): ChecklistAssigneeOptionsState {
  const projectId = scope?.type === 'project' ? scope.projectId : undefined
  // The same Project ID can exist in several Teams; the first Team that lists
  // it qualifies the member lookup, like the Work Item dialog's default.
  const projectTeam = projectId
    ? teams.find((team) => team.projects.some((project) => project.id === projectId))
    : undefined
  const project = projectTeam?.projects.find((candidate) => candidate.id === projectId)
  const projectMembers = useTeamProjectMembers(
    accessToken,
    projectTeam?.id,
    project ? [project] : [],
    enabled && project !== undefined,
  )
  const directoryMembers = useActiveDirectoryMembers(
    accessToken,
    teams,
    enabled && projectId === undefined,
  )
  const members = projectId === undefined
    ? directoryMembers.data?.members ?? []
    : (projectMembers.data?.members ?? [])
        .map((access) => access.member)
        .filter(isActiveProjectAssignmentCandidate)
  const options = new Map<string, ChecklistAssigneeOption>()
  for (const member of members) {
    options.set(member.id, { id: member.id, label: member.name ?? member.email })
  }
  // Both loaders resolve with per-Project errors instead of rejecting, so a
  // partial failure is reported like a failed query rather than as fewer owners.
  const activeQuery = projectId === undefined ? directoryMembers : projectMembers
  const hasError =
    activeQuery.error !== undefined || (activeQuery.data?.errors.length ?? 0) > 0
  return {
    hasError,
    options: [...options.values()].sort((left, right) =>
      left.label.localeCompare(right.label)),
    retry: () => {
      void activeQuery.mutate()
    },
  }
}
