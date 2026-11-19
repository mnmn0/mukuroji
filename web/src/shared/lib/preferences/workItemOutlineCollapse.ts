/** Most collapsed Work Items remembered per Team. */
const maxStoredCollapsedIds = 1_000

/**
 * Builds the storage key of one Team's collapsed outline rows.
 *
 * @param teamId - Team whose outline is stored.
 * @returns The local storage key.
 */
function createStorageKey(teamId: string): string {
  return `mukuroji.workItemOutline.collapsed.${teamId}`
}

/**
 * Reads which outline rows the viewer collapsed in a Team on this browser.
 *
 * @param teamId - Team whose outline is read.
 * @returns Collapsed Work Item IDs; empty when nothing is stored or storage is unavailable.
 */
export function readCollapsedWorkItemOutlineIds(teamId: string): Set<string> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(createStorageKey(teamId)) ?? '[]')
    return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

/**
 * Remembers which outline rows the viewer collapsed in a Team on this browser.
 *
 * @param teamId - Team whose outline is stored.
 * @param collapsedIds - Collapsed Work Item IDs.
 * @returns Nothing; storage failures are ignored because the state is only a convenience.
 */
export function writeCollapsedWorkItemOutlineIds(teamId: string, collapsedIds: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(
      createStorageKey(teamId),
      JSON.stringify([...collapsedIds].slice(-maxStoredCollapsedIds)),
    )
  } catch {
    // Private windows and full storage keep the state for this visit only.
  }
}
