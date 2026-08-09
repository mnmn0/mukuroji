import type { CuratedContextSourceKind } from '@mukuroji/contracts'

/**
 * Tabs available in the issue collaboration panel, in keyboard-navigation order.
 */
export const issueCollaborationTabs = [
  'conversation',
  'decisions',
  'activity',
  'sources',
] as const

/**
 * A tab available in the issue collaboration panel.
 */
export type IssueCollaborationTab = (typeof issueCollaborationTabs)[number]

/** Route-owned collaboration state shared by detail-pane boundaries. */
export type IssueCollaborationRoute = {
  /** Collaboration section selected by route state. */
  collaborationTab?: IssueCollaborationTab
  /** Curated context item selected by a deep link. */
  focusedContextItemId?: string
  /** Source provenance selected by a deep link. */
  focusedSourceId?: string
  /** Source category that disambiguates a source ID. */
  focusedSourceKind?: CuratedContextSourceKind
  /** Activity event selected by a deep link. */
  focusedActivityEventId?: string
  /** Persists collaboration tab selection in route state. */
  onCollaborationTabChange?: (tab: IssueCollaborationTab) => void
}

/**
 * URL query keys that target content inside one collaboration panel.
 */
export type IssueCollaborationTargetSearchParam =
  | 'activityEventId'
  | 'collaborationTab'
  | 'commentId'
  | 'contextItemId'
  | 'rootCommentId'
  | 'sourceId'
  | 'sourceKind'

/** All collaboration target keys cleared when an ambiguous Work Item route is normalized. */
export const issueCollaborationTargetSearchParams: readonly IssueCollaborationTargetSearchParam[] = [
  'commentId',
  'rootCommentId',
  'contextItemId',
  'sourceId',
  'sourceKind',
  'activityEventId',
  'collaborationTab',
]

/**
 * Safely reads an issue collaboration tab from URL query state.
 *
 * @param value - The value of the collaboration tab query parameter.
 * @returns The matching tab, or conversation when the value is unsupported.
 */
export function readIssueCollaborationTab(
  value: string | null | undefined,
): IssueCollaborationTab {
  return issueCollaborationTabs.find((tab) => tab === value) ?? 'conversation'
}

/**
 * Resolves the initial collaboration tab from route state and deep-link targets.
 *
 * @param input - Route values that may identify a collaboration destination.
 * @returns The tab that should own the current route.
 */
export function resolveIssueCollaborationTab(input: {
  requestedTab?: string | null
  focusedContextItemId?: string
  focusedSourceId?: string
  focusedActivityEventId?: string
}): IssueCollaborationTab {
  if (input.requestedTab !== undefined && input.requestedTab !== null) {
    return readIssueCollaborationTab(input.requestedTab)
  }

  if (input.focusedContextItemId) return 'decisions'
  if (input.focusedSourceId) return 'sources'
  if (input.focusedActivityEventId) return 'activity'
  return 'conversation'
}

/**
 * Applies a selected collaboration tab while clearing stale target parameters.
 *
 * @param searchParams - Current route query parameters.
 * @param tab - Tab that should remain selected.
 * @returns A new query parameter set with the tab state applied.
 */
export function applyIssueCollaborationTabToSearchParams(
  searchParams: URLSearchParams,
  tab: IssueCollaborationTab,
): URLSearchParams {
  const nextSearchParams = new URLSearchParams(searchParams)
  if (tab === 'conversation') {
    nextSearchParams.delete('collaborationTab')
  } else {
    nextSearchParams.set('collaborationTab', tab)
  }

  for (const key of getIssueCollaborationSearchParamsToClear(tab)) {
    nextSearchParams.delete(key)
  }

  return nextSearchParams
}

/**
 * Lists stale deep-link keys that must be removed when selecting a collaboration tab.
 *
 * @param tab - Collaboration tab that will remain active.
 * @returns Query keys owned by every other collaboration section.
 */
export function getIssueCollaborationSearchParamsToClear(
  tab: IssueCollaborationTab,
): IssueCollaborationTargetSearchParam[] {
  const keys: IssueCollaborationTargetSearchParam[] = []
  if (tab !== 'conversation') keys.push('commentId', 'rootCommentId')
  if (tab !== 'decisions') keys.push('contextItemId')
  if (tab !== 'sources') keys.push('sourceId', 'sourceKind')
  if (tab !== 'activity') keys.push('activityEventId')
  return keys
}

/**
 * Resolves the tab targeted by Arrow, Home, or End keyboard navigation.
 *
 * @param currentTab - The tab that currently owns keyboard focus.
 * @param key - The keyboard event key.
 * @param visibleTabs - Tabs currently rendered, in visual navigation order.
 * @returns The target tab, or undefined when the key or current tab is unsupported.
 */
export function resolveIssueCollaborationTabTarget(
  currentTab: IssueCollaborationTab,
  key: string,
  visibleTabs: readonly IssueCollaborationTab[],
): IssueCollaborationTab | undefined {
  const currentIndex = visibleTabs.indexOf(currentTab)

  if (currentIndex < 0 || visibleTabs.length === 0) {
    return undefined
  }

  if (key === 'ArrowRight') {
    return visibleTabs[(currentIndex + 1) % visibleTabs.length]
  }

  if (key === 'ArrowLeft') {
    return visibleTabs[
      (currentIndex - 1 + visibleTabs.length) % visibleTabs.length
    ]
  }

  if (key === 'Home') {
    return visibleTabs[0]
  }

  if (key === 'End') {
    return visibleTabs.at(-1)
  }

  return undefined
}
