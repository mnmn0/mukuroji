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
