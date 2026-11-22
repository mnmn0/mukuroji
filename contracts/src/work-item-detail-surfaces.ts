/**
 * Screens that show one Work Item in a detail pane.
 *
 * `project` is the Project screen, and `team` is the Team Work Item screen, which My Tasks opens.
 */
export type WorkItemDetailSurface = 'project' | 'team'

/** Panels and actions a Work Item detail pane can offer besides the configured detail sections. */
export type WorkItemDetailPanel =
  | 'key-actions'
  | 'archive'
  | 'collaboration'
  | 'files'
  | 'external-links'
  | 'related-documents'
  | 'relations'
  | 'dependencies'
  | 'time'
  | 'handoff'
  | 'agent-runs'
  | 'actual-dates'
  | 'schedule-baseline'
  | 'customer-impact'

/** What one detail surface offers, so the differences between screens are stated in one place. */
export type WorkItemDetailSurfaceCapabilities = {
  /** Panels and actions the surface shows, subject to the person's permissions and the data loaded. */
  panels: readonly WorkItemDetailPanel[]
  /**
   * Whether the surface may correct actual start and finish dates. Correction needs Project
   * management, which only the Project screen resolves, so other surfaces show the dates read-only.
   */
  correctsActualDates: boolean
}

/** Panels every detail surface shows. */
const SHARED_WORK_ITEM_DETAIL_PANELS: readonly WorkItemDetailPanel[] = [
  'key-actions',
  'archive',
  'collaboration',
  'files',
  'external-links',
  'related-documents',
  'relations',
  'dependencies',
  'time',
  'handoff',
  'agent-runs',
  'actual-dates',
]

/**
 * Capabilities of each Work Item detail surface.
 *
 * The schedule baseline and customer impact panels read Project data (the Project baseline and
 * the customer signals linked to the Project), so only the Project screen offers them.
 */
export const WORK_ITEM_DETAIL_SURFACE_CAPABILITIES: Readonly<
  Record<WorkItemDetailSurface, WorkItemDetailSurfaceCapabilities>
> = {
  project: {
    correctsActualDates: true,
    panels: [...SHARED_WORK_ITEM_DETAIL_PANELS, 'schedule-baseline', 'customer-impact'],
  },
  team: {
    correctsActualDates: false,
    panels: SHARED_WORK_ITEM_DETAIL_PANELS,
  },
}

/**
 * Returns whether a detail surface offers one panel or action.
 *
 * @param surface - Detail surface being rendered.
 * @param panel - Panel or action to check.
 * @returns Whether the surface offers it.
 */
export function hasWorkItemDetailPanel(
  surface: WorkItemDetailSurface,
  panel: WorkItemDetailPanel,
): boolean {
  return WORK_ITEM_DETAIL_SURFACE_CAPABILITIES[surface].panels.includes(panel)
}
