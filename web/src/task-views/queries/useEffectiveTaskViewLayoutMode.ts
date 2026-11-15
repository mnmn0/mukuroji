import type { TaskViewLayoutMode, TaskViewScope, TaskViewSurface } from '@mukuroji/contracts'
import { useMemo } from 'react'
import { resolveTaskViewLayoutMode } from '../model/taskViewBaseSelection'
import { parseTaskViewUrlState } from '../model/taskViewUrlState'
import { useSavedTaskViews } from './useSavedTaskViews'

/** Inputs that identify one task-view route, matching the task-view controller's inputs. */
export type UseEffectiveTaskViewLayoutModeInput = {
  /** Session bearer token for the saved-view query. */
  accessToken?: string
  /** Whether the saved-view query may run. Must match the task-view controller. */
  enabled: boolean
  /** Layout of the route's built-in definition. */
  builtInMode: TaskViewLayoutMode
  /** Route scope of the saved views. */
  scope: TaskViewScope
  /** Current URL search parameters. */
  searchParams: URLSearchParams
  /** Product surface of the route. */
  surface: TaskViewSurface
}

/**
 * Resolves the effective layout mode of a task-view route as soon as it is known.
 *
 * A URL layout override decides it immediately. Otherwise the saved views of the route must
 * settle first, because a personal or Team default can choose the layout. After a scope change,
 * the previous scope's saved views decide it until the new ones load. The saved-view query
 * shares its cache key with the task-view controller, so it adds no request.
 *
 * @param input - Route identity, URL state, and saved-view query inputs.
 * @returns The layout mode, or `undefined` while it still depends on unloaded saved views.
 */
export function useEffectiveTaskViewLayoutMode(
  input: UseEffectiveTaskViewLayoutModeInput,
): TaskViewLayoutMode | undefined {
  const parsedUrl = useMemo(
    () => parseTaskViewUrlState(input.searchParams, {
      scope: input.scope,
      surface: input.surface,
    }),
    [input.scope, input.searchParams, input.surface],
  )
  // Opening a Work Item adds its Team to the scope. Keeping the previous collection while that
  // scope loads keeps the list loaded instead of emptying it until the saved views return.
  const savedViews = useSavedTaskViews(
    input.accessToken,
    input.surface,
    input.scope,
    input.enabled,
    true,
  )
  const overrideMode = parsedUrl.state.override?.layout?.mode
  if (overrideMode) return overrideMode
  if (!input.accessToken || !input.enabled) return undefined
  // A failed saved-view read falls back to the built-in layout, as the controller does.
  if (savedViews.data === undefined && savedViews.error === undefined) return undefined
  return resolveTaskViewLayoutMode({
    builtInMode: input.builtInMode,
    savedViews: savedViews.data?.views ?? [],
    ...(parsedUrl.state.viewId ? { viewId: parsedUrl.state.viewId } : {}),
  })
}
