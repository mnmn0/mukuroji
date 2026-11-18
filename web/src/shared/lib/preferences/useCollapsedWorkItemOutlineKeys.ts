import { useCallback, useState } from 'react'
import {
  readCollapsedWorkItemOutlineKeys,
  writeCollapsedWorkItemOutlineKeys,
} from './workItemOutlineCollapse'

/**
 * Keeps which outline rows the viewer collapsed in a view that can span Teams, remembered on
 * this browser.
 *
 * @param scope - View whose rows are kept, such as `project.<Project ID>` or `my-tasks`.
 * @returns The collapsed row keys and a toggle that flips and stores one key.
 */
export function useCollapsedWorkItemOutlineKeys(scope: string) {
  const [state, setState] = useState(() => ({
    scope,
    keys: readCollapsedWorkItemOutlineKeys(scope),
  }))
  // A new scope, such as another Project, reads its own stored rows.
  const current = state.scope === scope
    ? state
    : { scope, keys: readCollapsedWorkItemOutlineKeys(scope) }
  if (current !== state) setState(current)
  const toggle = useCallback((key: string) => {
    setState((previous) => {
      const base = previous.scope === scope ? previous.keys : readCollapsedWorkItemOutlineKeys(scope)
      const next = new Set(base)
      if (!next.delete(key)) next.add(key)
      writeCollapsedWorkItemOutlineKeys(scope, next)
      return { scope, keys: next }
    })
  }, [scope])
  return [current.keys, toggle] as const
}
