import { createContext, useContext } from 'react'

/**
 * Workspace command menu contextで公開する操作です。
 */
export type WorkspaceCommandMenuContextValue = {
  /**
   * Workspace command menuを開きます。
   */
  open?: () => void
}

/**
 * 認証済みworkbench間で共有するcommand menu contextです。
 */
export const WorkspaceCommandMenuContext = createContext<WorkspaceCommandMenuContextValue>({})

/**
 * 現在のrouteからWorkspace command menuを開く操作を取得します。
 */
export function useWorkspaceCommandMenu() {
  return useContext(WorkspaceCommandMenuContext)
}
