import type { TeamIssue } from '../../issues/api'
import type { ProjectDirectoryTeam } from '../../projects/api'
import type { ProjectTask } from '../api'

/**
 * 指定したプロジェクトを、優先チームを考慮してディレクトリから解決します。
 */
export function findProjectInTeams(
  teams: ProjectDirectoryTeam[],
  projectId: string,
  preferredTeamId?: string,
) {
  const preferredTeam = preferredTeamId
    ? teams.find((team) => team.id === preferredTeamId)
    : undefined
  const preferredProject = preferredTeam?.projects.find((candidate) => candidate.id === projectId)

  if (preferredProject) {
    return preferredProject
  }

  for (const team of teams) {
    const project = team.projects.find((candidate) => candidate.id === projectId)

    if (project) {
      return project
    }
  }

  return undefined
}

/**
 * 指定したプロジェクトの所属チームを、優先チームを考慮して解決します。
 */
export function findTeamForProject(
  teams: ProjectDirectoryTeam[],
  projectId: string,
  preferredTeamId?: string,
) {
  const preferredTeam = preferredTeamId
    ? teams.find((team) => team.id === preferredTeamId)
    : undefined

  if (preferredTeam?.projects.some((project) => project.id === projectId)) {
    return preferredTeam
  }

  return teams.find((team) => team.projects.some((project) => project.id === projectId))
}

/**
 * URL の Issue 選択値と一致する Issue をチーム ID も含めて解決します。
 */
export function findIssueBySelection(
  issues: TeamIssue[],
  selectedIssueId?: string,
  selectedTeamId?: string,
) {
  if (!selectedIssueId) {
    return undefined
  }

  return issues.find((issue) =>
    issue.id === selectedIssueId && (!selectedTeamId || issue.teamId === selectedTeamId),
  )
}

/**
 * 詳細ペインの選択値と一致するタスクをチーム ID も含めて解決します。
 */
export function findTaskBySelection(
  tasks: ProjectTask[],
  selectedTaskId?: string,
  selectedTeamId?: string,
) {
  if (!selectedTaskId) {
    return undefined
  }

  return tasks.find((task) =>
    task.id === selectedTaskId && (!selectedTeamId || task.teamId === selectedTeamId),
  )
}
