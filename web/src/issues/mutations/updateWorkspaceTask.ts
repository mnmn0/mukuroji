import type { CanonicalWorkItem } from '@mukuroji/contracts'
import type { MutationRequestContext } from '../../shared/api/mutationHeaders'
import { updateTeamIssue } from '../api/workItems'

/**
 * Workspace 画面から canonical Work Item の workflow status を更新します。
 *
 * @param task - 更新対象の canonical Work Item です。
 * @param accessToken - Team Issue API の access token です。
 * @param workflowStatusId - 更新後の workflow status ID です。
 * @param mutationContext - retry 間で共有する mutation request context です。
 * @returns 更新後の canonical Work Item です。
 */
export function updateWorkspaceTaskRemote(
  task: CanonicalWorkItem,
  accessToken: string,
  workflowStatusId: string,
  mutationContext: MutationRequestContext,
) {
  return updateTeamIssue(
    task.teamId,
    task.id,
    accessToken,
    {
      expectedRevision: task.revision,
      workflowStatusId,
    },
    mutationContext,
  )
}
