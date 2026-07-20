import type { MutationRequestContext } from '../api/mutationHeaders'
import { updateTeamIssue } from '../issues/api'
import {
  getProjectMembers,
  type ProjectDirectoryProject,
} from '../projects/api'
import type { ProjectTask, TaskStatus } from '../tasks/api'
import type {
  TeamProjectMemberAccess,
  TeamProjectMembersResult,
} from './workspaceTypes'

async function loadTeamProjectMembers(
  accessToken: string,
  projects: readonly ProjectDirectoryProject[],
): Promise<TeamProjectMembersResult> {
  const results = await Promise.allSettled(
    projects.map(async (project) => ({
      members: await getProjectMembers(accessToken, project.id),
      project,
    })),
  )
  const members: TeamProjectMemberAccess[] = []
  const failedProjectIds: string[] = []

  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      for (const member of result.value.members) {
        members.push({
          projectId: result.value.project.id,
          projectName: result.value.project.name,
          member,
        })
      }
    } else {
      const failedProjectId = projects[index]?.id

      if (failedProjectId) {
        failedProjectIds.push(failedProjectId)
      }
    }
  }

  return {
    failedProjectIds,
    members,
  }
}

async function updateWorkspaceTaskRemote(
  task: ProjectTask,
  accessToken: string,
  status: TaskStatus,
  mutationContext: MutationRequestContext,
) {
  if (task.source === 'legacy') {
    return task
  }

  if (task.source !== 'dynamodb') {
    return task
  }

  return updateTeamIssue(
    task.teamId,
    task.id,
    accessToken,
    {
      expectedRevision: task.revision,
      status,
    },
    mutationContext,
  )
}

/**
 * WorkspacePage が利用する API 取得・mutation 処理です。
 */
export const workspaceData = {
  loadTeamProjectMembers,
  updateWorkspaceTaskRemote,
}
