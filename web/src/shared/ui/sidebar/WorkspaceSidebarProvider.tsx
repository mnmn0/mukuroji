import { useMemo, useState } from 'react'
import {
  emptyWorkspaceSidebarRouteState,
  WorkspaceSidebarContext,
  type WorkspaceSidebarContextValue,
  type WorkspaceSidebarProviderProps,
  type WorkspaceSidebarRouteState,
} from './WorkspaceSidebarController'

/**
 * Provides shared sidebar controls and route state to the authenticated Workspace shell.
 *
 * @param props - Provider callbacks and route content.
 * @returns The sidebar context provider element.
 */
export function WorkspaceSidebarProvider({
  children,
  controller,
}: WorkspaceSidebarProviderProps) {
  const [routeState, setRouteState] = useState<WorkspaceSidebarRouteState>(
    emptyWorkspaceSidebarRouteState,
  )
  const contextValue = useMemo<WorkspaceSidebarContextValue>(
    () => ({ controller, routeState, setRouteState }),
    [controller, routeState],
  )

  return (
    <WorkspaceSidebarContext.Provider value={contextValue}>
      {children}
    </WorkspaceSidebarContext.Provider>
  )
}
