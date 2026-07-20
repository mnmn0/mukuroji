import { updateWorkspaceTaskRemote } from '../issues/mutations/updateWorkspaceTask'
import {
  loadWorkspaceProjectMembers as loadTeamProjectMembers,
} from '../projects/queries/projectMembers'

/**
 * WorkspacePage が利用する API 取得・mutation 処理です。
 */
export const workspaceData = {
  loadTeamProjectMembers,
  updateWorkspaceTaskRemote,
}
