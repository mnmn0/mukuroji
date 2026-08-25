/** A tab shown in the Document context drawer. */
export type DocumentContextTab =
  | 'comments'
  | 'brief'
  | 'backlinks'
  | 'versions'
  | 'activity'

/** Stable visual order for every Document context drawer tab. */
export const documentContextTabs = [
  'comments',
  'brief',
  'backlinks',
  'versions',
  'activity',
] as const satisfies readonly DocumentContextTab[]

/**
 * Resolves WAI-ARIA roving-tab focus for the currently rendered tab subset.
 *
 * @param current - Tab that currently owns keyboard focus.
 * @param key - Keyboard key received by the tab.
 * @param visibleTabs - Permission-filtered tab order rendered in the drawer.
 * @returns The tab that should be selected and focused, when the key is handled.
 */
export function resolveDocumentContextTabTarget(
  current: DocumentContextTab,
  key: string,
  visibleTabs: readonly DocumentContextTab[] = documentContextTabs,
): DocumentContextTab | undefined {
  const currentIndex = visibleTabs.indexOf(current)
  if (currentIndex < 0 || visibleTabs.length === 0) return undefined
  if (key === 'Home') return visibleTabs[0]
  if (key === 'End') return visibleTabs[visibleTabs.length - 1]
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return undefined

  const direction = key === 'ArrowRight' ? 1 : -1
  return visibleTabs[
    (currentIndex + direction + visibleTabs.length) % visibleTabs.length
  ]
}
