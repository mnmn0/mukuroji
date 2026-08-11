import type {
  TaskViewColumn,
  TaskViewDensity,
  TaskViewSort,
  TaskViewSortDirection,
} from '@mukuroji/contracts'

/** Display flags shared by rows and cards across task layouts. */
export type TaskViewDisplayOptions = {
  /** Whether archived Work Items are admitted by the filter and rendered by the layout. */
  showArchived: boolean
  /** Whether assignee initials are rendered beside assignee labels. */
  showAssigneeAvatars: boolean
  /** Whether completed Work Items remain visible. */
  showCompleted: boolean
  /** Whether empty workflow columns remain visible on board layouts. */
  showEmptyGroups: boolean
  /** Whether child Work Items remain visible. */
  showSubtasks: boolean
  /** Whether long Work Item titles may wrap to additional lines. */
  wrapTitles: boolean
}

/** Presentation settings edited by the shared task-view toolbar. */
export type TaskViewPresentationSettings = {
  /** Ordered visible columns together with persisted width and pin metadata. */
  columns: readonly TaskViewColumn[]
  /** Row and card density. */
  density: TaskViewDensity
  /** Ordered sort rules applied to the visible result. */
  sort?: readonly TaskViewSort[]
  /** Optional primary grouping field. */
  groupBy?: string
  /** Ordering applied to primary group headings. */
  groupDirection?: TaskViewSortDirection
  /** Optional secondary grouping field. */
  subgroupBy?: string
  /** Ordering applied to secondary group headings. */
  subgroupDirection?: TaskViewSortDirection
  /** Row and card visibility flags. */
  display: TaskViewDisplayOptions
}

/** Stable value and visible label used to group one task-view item. */
export type TaskViewGroupValue = {
  /** Stable key identifying the group. */
  key: string
  /** Human-readable group heading. */
  label: string
}

/** One ordered item group produced for a task-view section. */
export type TaskViewItemGroup<Item> = {
  /** Stable key identifying the section. */
  key: string
  /** Human-readable section heading. */
  label: string
  /** Items retained in their input order inside the section. */
  items: readonly Item[]
}

/** One table column with resolved width and sticky-edge offsets. */
export type TaskViewTableColumnPlacement = {
  /** Persisted column metadata. */
  column: TaskViewColumn
  /** Pixel offset from the table's end edge for an end-pinned column. */
  endOffset?: number
  /** Pixel offset from the table's start edge for a start-pinned column. */
  startOffset?: number
  /** Effective pixel width used by the table layout. */
  width: number
}

/**
 * Resolves deterministic widths and cumulative sticky offsets for table columns.
 *
 * @param columns - Persisted ordered table columns.
 * @returns Column placements in the same visible order.
 */
export function resolveTaskViewTableColumnPlacements(
  columns: readonly TaskViewColumn[],
): TaskViewTableColumnPlacement[] {
  const placements: TaskViewTableColumnPlacement[] = columns.map((column) => ({
    column: { ...column },
    width: column.width ?? resolveDefaultTaskViewColumnWidth(column.field),
  }))
  let startOffset = 0
  for (const placement of placements) {
    if (placement.column.pin !== 'start') continue
    placement.startOffset = startOffset
    startOffset += placement.width
  }
  let endOffset = 0
  for (let index = placements.length - 1; index >= 0; index -= 1) {
    const placement = placements[index]
    if (!placement || placement.column.pin !== 'end') continue
    placement.endOffset = endOffset
    endOffset += placement.width
  }
  return placements
}

/**
 * Resolves a readable table width when a persisted column has no explicit width.
 *
 * @param field - Built-in or custom field identifier.
 * @returns Default CSS pixel width for the column.
 */
function resolveDefaultTaskViewColumnWidth(field: string): number {
  if (field === 'title') return 320
  if (field === 'customFields' || field.startsWith('custom:')) return 220
  return 160
}

/**
 * Groups task-view items by one definition field without changing item order.
 *
 * @param items - Filtered and sorted items to partition.
 * @param field - Definition field used to resolve each group.
 * @param resolveValue - Surface-specific field and label resolver.
 * @param direction - Ordering applied to the resulting group headings.
 * @returns Ordered non-empty task-view groups.
 */
export function groupTaskViewItems<Item>(
  items: readonly Item[],
  field: string,
  resolveValue: (item: Item, field: string) => TaskViewGroupValue,
  direction: TaskViewSortDirection = 'asc',
): TaskViewItemGroup<Item>[] {
  const groupsByKey = new Map<string, { label: string; items: Item[] }>()

  for (const item of items) {
    const value = resolveValue(item, field)
    const group = groupsByKey.get(value.key)

    if (group) {
      group.items.push(item)
    } else {
      groupsByKey.set(value.key, { items: [item], label: value.label })
    }
  }

  const directionMultiplier = direction === 'desc' ? -1 : 1
  return [...groupsByKey].map(([key, group]) => ({
    items: group.items,
    key,
    label: group.label,
  })).sort((left, right) =>
    directionMultiplier * left.label.localeCompare(right.label, undefined, {
      numeric: true,
      sensitivity: 'base',
    })
  )
}
