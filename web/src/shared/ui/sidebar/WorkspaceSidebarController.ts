import {
  createContext,
  useContext,
  useEffect,
  type ReactNode,
} from 'react'

/** Controls the shared sidebar from route-specific headers and screens. */
export type WorkspaceSidebarController = {
  /** Opens the shared mobile sidebar drawer. */
  openMobileSidebar: () => void
  /** Closes the shared mobile sidebar drawer. */
  closeMobileSidebar: () => void
}

/** Route-specific state that the persistent sidebar shell must reflect. */
export type WorkspaceSidebarRouteState = {
  /** Whether the current route is loading its primary content. */
  isBusy: boolean
  /** The Team resolved from the selected Project issue, when available. */
  activeProjectTeamId?: string
}

/** Props accepted by the shared sidebar controller provider. */
export type WorkspaceSidebarProviderProps = {
  /** Controller callbacks owned by the persistent Workspace shell. */
  controller: WorkspaceSidebarController
  /** Route content rendered below the shared sidebar. */
  children: ReactNode
}

/** Internal value exposed to shared sidebar consumers. */
export type WorkspaceSidebarContextValue = {
  /** Controller callbacks owned by the persistent Workspace shell. */
  controller: WorkspaceSidebarController
  /** Latest state reported by the active route. */
  routeState: WorkspaceSidebarRouteState
  /** Updates the state reflected by the persistent sidebar shell. */
  setRouteState: (routeState: WorkspaceSidebarRouteState) => void
}

/** The default route state used outside an authenticated Workspace shell. */
export const emptyWorkspaceSidebarRouteState: WorkspaceSidebarRouteState = {
  isBusy: false,
}
const emptyWorkspaceSidebarController: WorkspaceSidebarController = {
  closeMobileSidebar: () => undefined,
  openMobileSidebar: () => undefined,
}

/** Shared context consumed by the shell and route-specific screens. */
export const WorkspaceSidebarContext =
  createContext<WorkspaceSidebarContextValue | undefined>(undefined)

/**
 * Reads the controller for the shared mobile sidebar.
 *
 * @returns Shared sidebar open/close controls, or no-op controls outside the shell.
 */
export function useWorkspaceSidebarController() {
  return useContext(WorkspaceSidebarContext)?.controller ?? emptyWorkspaceSidebarController
}

/**
 * Reads route state currently reflected by the persistent sidebar shell.
 *
 * @returns The current route loading and Project Team state.
 */
export function useWorkspaceSidebarRouteState() {
  return useContext(WorkspaceSidebarContext)?.routeState ?? emptyWorkspaceSidebarRouteState
}

/**
 * Reports route-specific state to the persistent sidebar shell.
 *
 * The effect keeps the shell synchronized while a route remains mounted and clears
 * the state when that route unmounts during navigation.
 *
 * @param routeState - Loading and selected Project Team state to expose to the shell.
 * @returns Nothing.
 */
export function useReportWorkspaceSidebarRouteState(
  routeState: WorkspaceSidebarRouteState,
): void {
  const context = useContext(WorkspaceSidebarContext)

  useEffect(() => {
    if (!context) {
      return
    }

    context.setRouteState(routeState)
    return () => context.setRouteState(emptyWorkspaceSidebarRouteState)
  }, [context, routeState])
}
