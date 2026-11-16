import type { TaskViewLayoutMode, TaskViewScope, TaskViewSurface } from '@mukuroji/contracts'
import { useMemo, useState } from 'react'
import {
  continueTaskViewLayoutMode,
  resolveTaskViewLayoutMode,
  type ContinuedTaskViewLayoutMode,
} from '../model/taskViewBaseSelection'
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
  /**
   * Identity within which a scope change keeps the last resolved layout, such as a Project ID.
   *
   * Opening a Work Item adds its Team to the scope; the layout of the same Project is kept until
   * the new scope's saved views load. A different identity never reuses another one's layout.
   */
  continuityKey: string
}

/**
 * Resolves the effective layout mode of a task-view route as soon as it is known.
 *
 * A URL layout override decides it immediately. Otherwise the saved views of the route must
 * settle first, because a personal or Team default can choose the layout. After a scope change
 * with the same `continuityKey`, the last settled layout is kept until the new views load; after
 * any other change the layout stays unknown until then. The saved-view query
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
  const savedViews = useSavedTaskViews(
    input.accessToken,
    input.surface,
    input.scope,
    input.enabled,
  )
  const [lastResolved, setLastResolved] = useState<ContinuedTaskViewLayoutMode>()
  const current = resolveCurrentLayoutMode()
  // Remembers the last settled layout while rendering, so a scope change within the same
  // continuity key can keep it until the new scope's saved views load.
  if (
    current !== undefined &&
    (lastResolved?.continuityKey !== input.continuityKey || lastResolved.mode !== current)
  ) {
    setLastResolved({ continuityKey: input.continuityKey, mode: current })
  }
  return continueTaskViewLayoutMode(current, lastResolved, input.continuityKey)

  /**
   * Resolves the layout from the URL and the current scope's saved views only.
   *
   * @returns The layout, or `undefined` while the current scope's saved views are not settled.
   */
  function resolveCurrentLayoutMode(): TaskViewLayoutMode | undefined {
    const overrideMode = parsedUrl.state.override?.layout?.mode
    if (overrideMode) return overrideMode
    if (!input.accessToken || !input.enabled) return undefined
    if (savedViews.data === undefined && savedViews.error === undefined) return undefined
    // Same rule as the task-view controller: cached views of this scope still decide the layout
    // when a revalidation fails, and a first read that fails falls back to the built-in layout.
    return resolveTaskViewLayoutMode({
      builtInMode: input.builtInMode,
      savedViews: savedViews.data?.views ?? [],
      ...(parsedUrl.state.viewId ? { viewId: parsedUrl.state.viewId } : {}),
    })
  }
}
