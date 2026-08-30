import type { SavedViewVisibility, WorkspaceSearchFilters } from './search'
import type { WorkflowStatusCategory } from './work-item-configuration'
import type { WorkItemPriority } from './work-items'

/** Current schema version for persisted task view definitions. */
export const TASK_VIEW_SCHEMA_VERSION = 1

/** Current schema version for task view state encoded in a URL. */
export const TASK_VIEW_URL_STATE_SCHEMA_VERSION = 1

/** Current schema version for shared Work Item action results. */
export const WORK_ITEM_ACTION_SCHEMA_VERSION = 1

/** Product surfaces that can consume the shared task view definition. */
export type TaskViewSurface =
  | 'workspace-search'
  | 'project'
  | 'team'
  | 'my-tasks'
  | 'focus'
  | 'triage'

/** Stable ordered list of product surfaces that support task views. */
export const TASK_VIEW_SURFACES: readonly TaskViewSurface[] = [
  'workspace-search',
  'project',
  'team',
  'my-tasks',
  'focus',
  'triage',
]

/** Workspace-wide scope for a task view. */
export type WorkspaceTaskViewScope = {
  /** Scope discriminator. */
  kind: 'workspace'
}

/** Project scope for a task view. */
export type ProjectTaskViewScope = {
  /** Scope discriminator. */
  kind: 'project'
  /** Project whose Work Items are eligible for the view. */
  projectId: string
  /** Optional owning Team used when Project identifiers are not globally unique. */
  teamId?: string
}

/** Team scope for a task view. */
export type TeamTaskViewScope = {
  /** Scope discriminator. */
  kind: 'team'
  /** Team whose Work Items are eligible for the view. */
  teamId: string
}

/** Current-viewer scope for personal queues such as My Tasks and Focus. */
export type ViewerTaskViewScope = {
  /** Scope discriminator. */
  kind: 'viewer'
}

/** Resource boundary within which a task view definition is evaluated. */
export type TaskViewScope =
  | WorkspaceTaskViewScope
  | ProjectTaskViewScope
  | TeamTaskViewScope
  | ViewerTaskViewScope

/** Team-qualified workflow status referenced by a task filter. */
export type TaskViewWorkflowStatusFilter = {
  /** Team that owns the workflow status definition. */
  teamId: string
  /** Stable workflow status identifier within the Team configuration. */
  statusId: string
}

/** Relative due-date buckets supported by task surfaces. */
export type TaskViewDueDatePreset = 'overdue' | 'today' | 'upcoming' | 'no-date'

/**
 * Permission-aware filters shared by Search and every task surface.
 *
 * The inherited Workspace Search fields preserve compatibility with existing saved views.
 */
export type TaskViewFilters = WorkspaceSearchFilters & {
  /** Team-qualified status references used by multi-Team task surfaces. */
  workflowStatuses?: TaskViewWorkflowStatusFilter[]
  /** Stable workflow categories retained across status-definition changes. */
  workflowCategories?: WorkflowStatusCategory[]
  /** Work Item priorities to retain. */
  priorities?: WorkItemPriority[]
  /** Relative due-date bucket evaluated at view load time. */
  dueDatePreset?: TaskViewDueDatePreset
  /** Whether archived Work Items may be included after permission filtering. */
  includeArchived?: boolean
  /** Stable Work Item Type identifiers to retain. */
  workItemTypeIds?: string[]
}

/** Layout modes supported by Search and task-oriented product surfaces. */
export type TaskViewLayoutMode =
  | 'table'
  | 'board'
  | 'list'
  | 'gantt'
  | 'calendar'
  | 'timeline'

/** Sort direction used by task view sorting and grouping. */
export type TaskViewSortDirection = 'asc' | 'desc'

/** One ordered sort rule in a task view. */
export type TaskViewSort = {
  /** Built-in field or `custom:<field ID>` reference used for sorting. */
  field: string
  /** Direction in which values are sorted. */
  direction: TaskViewSortDirection
}

/** Primary or secondary grouping rule in a task view. */
export type TaskViewGrouping = {
  /** Built-in field or `custom:<field ID>` reference used for grouping. */
  field: string
  /** Direction in which group headings are ordered. */
  direction: TaskViewSortDirection
}

/** Edge to which a task view column is pinned. */
export type TaskViewColumnPin = 'start' | 'end'

/** One visible column in a task view. */
export type TaskViewColumn = {
  /** Built-in field or `custom:<field ID>` reference rendered by the column. */
  field: string
  /** Optional persisted column width in CSS pixels. */
  width?: number
  /** Optional edge to which the column remains pinned while scrolling. */
  pin?: TaskViewColumnPin
}

/** Visual density applied by a task view. */
export type TaskViewDensity = 'compact' | 'comfortable' | 'spacious'

/** Optional presentation choices that do not change the underlying filter result. */
export type TaskViewDisplayOptions = {
  /** Whether completed Work Items remain visible. */
  showCompleted?: boolean
  /** Whether archived Work Items remain visible when the filter also permits them. */
  showArchived?: boolean
  /** Whether child Work Items are expanded beneath their parents. */
  showSubItems?: boolean
  /** Whether groups without a matching Work Item are rendered. */
  showEmptyGroups?: boolean
  /** Whether long cell content wraps onto multiple lines. */
  wrapText?: boolean
  /** Whether assignee avatars are rendered alongside assignee names. */
  showAssigneeAvatars?: boolean
}

/** Reproducible layout shared by every task view surface. */
export type TaskViewLayout = {
  /** Primary visual layout mode. */
  mode: TaskViewLayoutMode
  /** Optional primary grouping rule. */
  group?: TaskViewGrouping
  /** Optional secondary grouping rule evaluated within each primary group. */
  subgroup?: TaskViewGrouping
  /** Ordered sort rules applied within the active grouping. */
  sort: TaskViewSort[]
  /** Ordered visible columns and their persisted presentation metadata. */
  columns: TaskViewColumn[]
  /** Row or card spacing density. */
  density: TaskViewDensity
  /** Presentation options that do not alter task eligibility. */
  displayOptions: TaskViewDisplayOptions
}

/** Complete reusable definition that determines a task view result and presentation. */
export type TaskViewDefinition = {
  /** Product surface that consumes the definition. */
  surface: TaskViewSurface
  /** Resource boundary within which filters are evaluated. */
  scope: TaskViewScope
  /** Filters that determine the permission-aware result set. */
  filters: TaskViewFilters
  /** Layout used to present the filtered result set. */
  layout: TaskViewLayout
}

/** Visibility of a persisted task view definition. */
export type SavedTaskViewVisibility = SavedViewVisibility

/** Source that supplied the effective default for a task view surface and scope. */
export type TaskViewDefaultSource = 'personal' | 'team' | 'built-in'

/** Default sources that a saved view mutation may explicitly configure. */
export type SavedTaskViewDefaultSource = 'personal' | 'team'

/** Viewer-specific preference and resolved default state for a saved task view. */
export type SavedTaskViewPreference = {
  /** Whether the current viewer marked the view as a favorite. */
  favorite: boolean
  /** Whether the current viewer pinned the view in navigation. */
  pinned: boolean
  /** Whether this view is the effective default for its surface and scope. */
  isDefault: boolean
  /** Whether this view is the current viewer's personal default. */
  isPersonalDefault: boolean
  /** Whether this view is the underlying Team default, even when a personal default wins. */
  isTeamDefault: boolean
  /** Source that made this view the effective default. */
  defaultSource?: TaskViewDefaultSource
}

/** Effective default selected after applying personal, Team, and built-in precedence. */
export type TaskViewDefaultSelection = {
  /** Source that supplied the effective default. */
  source: TaskViewDefaultSource
  /** Saved view identifier for a personal or Team default. */
  viewId?: string
}

/** Stable reason that a persisted or URL-provided task view required migration. */
export type TaskViewMigrationWarningCode =
  | 'deleted-custom-field'
  | 'deleted-workflow-status'
  | 'permission-redacted'
  | 'inaccessible-scope'
  | 'invalid-layout'
  | 'invalid-url-override'

/** Definition section affected by task view migration. */
export type TaskViewMigrationSection =
  | 'scope'
  | 'filter'
  | 'layout'
  | 'group'
  | 'subgroup'
  | 'sort'
  | 'column'
  | 'density'
  | 'display-option'
  | 'url-override'

/** Safe fallback applied after a task view reference becomes invalid. */
export type TaskViewMigrationFallback =
  | 'removed'
  | 'reset-to-default'
  | 'ignored'
  | 'unavailable'

/** Safe migration notice returned with an effective task view. */
export type TaskViewMigrationWarning = {
  /** Stable machine-readable migration reason. */
  code: TaskViewMigrationWarningCode
  /** Definition section affected by the migration. */
  section: TaskViewMigrationSection
  /** Fallback applied to keep evaluation deterministic and permission-safe. */
  fallback: TaskViewMigrationFallback
  /** Referenced identifier, included only when the current viewer may read it. */
  referenceId?: string
}

/** Persisted task view with lifecycle metadata and current-viewer preferences. */
export type SavedTaskView = {
  /** Persisted task view schema version. */
  schemaVersion: typeof TASK_VIEW_SCHEMA_VERSION
  /** Workspace-unique saved view identifier. */
  id: string
  /** Human-readable saved view name. */
  name: string
  /** Optional human-readable description. */
  description?: string
  /** Audience allowed to discover the saved view. */
  visibility: SavedTaskViewVisibility
  /** Workspace user who created the saved view. */
  ownerUserId: string
  /** Team that receives a Team-visible view. */
  teamId?: string
  /** Reusable filter and layout definition. */
  definition: TaskViewDefinition
  /** Monotonically increasing optimistic concurrency revision. */
  revision: number
  /** Whether the current viewer may edit or delete the definition. */
  canEdit: boolean
  /** Current-viewer preference and effective default metadata. */
  preference: SavedTaskViewPreference
  /** Creation timestamp in ISO 8601 format. */
  createdAt: string
  /** Last definition update timestamp in ISO 8601 format. */
  updatedAt: string
  /** Safe read-time migrations applied before returning the definition. */
  migrationWarnings?: TaskViewMigrationWarning[]
}

/** One Team-qualified Project scope where the current viewer may mutate Work Items. */
export type TaskViewWritableProjectScope = {
  /** Team that owns the writable Project. */
  teamId: string
  /** Project where the current viewer has authoritative Work Item write access. */
  projectId: string
}

/**
 * Saved View lifecycle permissions and Work Item write scopes evaluated for an exact list context.
 */
export type SavedTaskViewCapabilities = {
  /** Whether the current viewer may mutate personal task views and preferences in this scope. */
  canWrite: boolean
  /** Whether the current viewer may create or manage Workspace-shared task views in this scope. */
  canManageSharedViews: boolean
  /** Whether the current viewer may assign a Team default for this scope. */
  canSetTeamDefault: boolean
  /**
   * Readable Team scopes with authoritative write access for unassigned Work Items.
   *
   * Team-visible Saved View creation additionally requires the `canWrite` lifecycle permission.
   */
  writableTeamIds: string[]
  /** Readable Team-qualified Project scopes with authoritative assigned Work Item write access. */
  writableProjectScopes: TaskViewWritableProjectScope[]
}

/** Cursor-paginated page of task views visible to the current viewer. */
export type SavedTaskViewsResponse = {
  /** Server-authoritative mutation capabilities for the requested surface and scope. */
  capabilities: SavedTaskViewCapabilities
  /** Permission-filtered saved task views in the current page. */
  views: SavedTaskView[]
  /** Opaque cursor for the next permission-filtered page. */
  nextCursor?: string
}

/** Query parameters accepted by a saved task view list endpoint. */
export type SavedTaskViewListQuery = {
  /** Optional surface used to narrow discoverable views. */
  surface?: TaskViewSurface
  /** Optional scope used to narrow discoverable views. */
  scope?: TaskViewScope
  /** Maximum number of permission-filtered views to return. */
  limit?: number
  /** Opaque cursor returned by the previous page. */
  cursor?: string
}

/** Input used to persist a new task view. */
export type CreateSavedTaskViewInput = {
  /** Human-readable saved view name. */
  name: string
  /** Optional human-readable description. */
  description?: string
  /** Audience allowed to discover the saved view. */
  visibility: SavedTaskViewVisibility
  /** Team that receives a Team-visible view. */
  teamId?: string
  /** Reusable filter and layout definition to persist. */
  definition: TaskViewDefinition
  /** Whether the current viewer should favorite the new view. */
  favorite?: boolean
  /** Whether the current viewer should pin the new view. */
  pinned?: boolean
  /** Optional personal or Team default assignment applied atomically with creation. */
  defaultSource?: SavedTaskViewDefaultSource
}

/** Revision-guarded update to a saved task view and current-viewer preferences. */
export type UpdateSavedTaskViewInput = {
  /** Saved view revision observed before the update. */
  expectedRevision: number
  /** Replacement human-readable name. */
  name?: string
  /** Replacement description, or null to remove it. */
  description?: string | null
  /** Replacement visibility. */
  visibility?: SavedTaskViewVisibility
  /** Replacement Team, or null to remove Team visibility. */
  teamId?: string | null
  /** Replacement reusable definition. */
  definition?: TaskViewDefinition
  /** Replacement favorite preference for the current viewer. */
  favorite?: boolean
  /** Replacement pin preference for the current viewer. */
  pinned?: boolean
  /** Personal or Team default assignment, or null to clear the applicable assignment. */
  defaultSource?: SavedTaskViewDefaultSource | null
  /** Explicit default marker to clear when personal and Team defaults coexist. */
  clearDefaultSource?: SavedTaskViewDefaultSource
}

/** Destination metadata applied while duplicating an accessible saved task view. */
export type DuplicateSavedTaskViewInput = {
  /** Optional replacement name; omission allows the server to derive a copy label. */
  name?: string
  /** Optional replacement description, or null to remove the source description. */
  description?: string | null
  /** Optional replacement visibility. */
  visibility?: SavedTaskViewVisibility
  /** Replacement Team ID, or null to remove Team visibility. */
  teamId?: string | null
  /** Whether the current viewer should favorite the duplicate. */
  favorite?: boolean
  /** Whether the current viewer should pin the duplicate. */
  pinned?: boolean
  /** Optional personal or Team default assignment for the duplicate. */
  defaultSource?: SavedTaskViewDefaultSource
}

/** Partial layout patch carried by a temporary URL override. */
export type TaskViewLayoutOverride = {
  /** Temporary layout mode. */
  mode?: TaskViewLayoutMode
  /** Temporary primary grouping rule, or null to remove grouping. */
  group?: TaskViewGrouping | null
  /** Temporary secondary grouping rule, or null to remove subgrouping. */
  subgroup?: TaskViewGrouping | null
  /** Temporary ordered sort rules. */
  sort?: TaskViewSort[]
  /** Temporary ordered visible columns. */
  columns?: TaskViewColumn[]
  /** Temporary visual density. */
  density?: TaskViewDensity
  /** Temporary display option replacements. */
  displayOptions?: TaskViewDisplayOptions
}

/** Temporary, non-persisted changes layered over a saved or built-in task view. */
export type TaskViewUrlOverride = {
  /** Replacement filters evaluated only for the current URL. */
  filters?: TaskViewFilters
  /** Layout fields patched only for the current URL. */
  layout?: TaskViewLayoutOverride
}

/** Versioned task view state that can be serialized into a permalink. */
export type TaskViewUrlState = {
  /** URL state schema version. */
  schemaVersion: typeof TASK_VIEW_URL_STATE_SCHEMA_VERSION
  /** Product surface that must consume the URL state. */
  surface: TaskViewSurface
  /** Route and authorization scope bound to the URL state. */
  scope: TaskViewScope
  /** Optional saved view used as the base definition. */
  viewId?: string
  /** Optional temporary changes layered over the base definition. */
  override?: TaskViewUrlOverride
}

/** Stable Work Item actions exposed through the shared action registry. */
export type WorkItemActionId =
  | 'create'
  | 'open'
  | 'edit'
  | 'move'
  | 'assign'
  | 'schedule'
  | 'relation'
  | 'watch'
  | 'archive'

/** Stable ordered list of Work Item actions exposed by the registry. */
export const WORK_ITEM_ACTION_IDS: readonly WorkItemActionId[] = [
  'create',
  'open',
  'edit',
  'move',
  'assign',
  'schedule',
  'relation',
  'watch',
  'archive',
]

/** User interaction path that invoked a Work Item action. */
export type WorkItemActionTrigger =
  | 'click'
  | 'context-menu'
  | 'command-menu'
  | 'keyboard'
  | 'bulk-action'

/** Revision-aware Work Item identity used by action validation and mutation. */
export type WorkItemActionTarget = {
  /** Team that owns the canonical Work Item. */
  teamId: string
  /** Team-local canonical Work Item identifier. */
  workItemId: string
  /** Revision observed before a mutation-oriented action. */
  expectedRevision?: number
}

/** Shared focus and multi-selection snapshot supplied to every action entry point. */
export type WorkItemActionSelection = {
  /** Selection cardinality represented by the snapshot. */
  mode: 'none' | 'single' | 'multiple'
  /** Ordered canonical targets selected for the action. */
  targets: WorkItemActionTarget[]
  /** Target that currently owns keyboard focus. */
  focusedTarget?: WorkItemActionTarget
  /** Target from which range selection is extended. */
  anchorTarget?: WorkItemActionTarget
}

/** Common contextual input passed to permission, validation, and mutation handlers. */
export type WorkItemActionContext = {
  /** Action context schema version. */
  schemaVersion: typeof WORK_ITEM_ACTION_SCHEMA_VERSION
  /** Stable action requested by the invoking entry point. */
  actionId: WorkItemActionId
  /** Interaction path that invoked the action. */
  trigger: WorkItemActionTrigger
  /** Product surface from which the action was invoked. */
  surface: TaskViewSurface
  /** Resource boundary inherited from the active task view. */
  scope: TaskViewScope
  /** Current focus and selection snapshot. */
  selection: WorkItemActionSelection
  /** Saved view active when the action was invoked. */
  viewId?: string
  /** Normalized keyboard shortcut used to invoke the action. */
  keyboardShortcut?: string
}

/** Stable category for a permission or validation failure returned by an action. */
export type WorkItemActionFailureCategory =
  | 'validation'
  | 'permission'
  | 'conflict'
  | 'not-found'
  | 'unavailable'
  | 'unknown'

/** Safe failure returned consistently by every Work Item action entry point. */
export type WorkItemActionFailure = {
  /** Stable machine-readable error code. */
  code: string
  /** Stable failure category used for UI behavior. */
  category: WorkItemActionFailureCategory
  /** Safe user-facing failure message. */
  message: string
  /** Whether retrying the same normalized action may succeed. */
  retryable: boolean
}

/** Per-target outcome of a Work Item action. */
export type WorkItemActionItemStatus = 'succeeded' | 'failed' | 'skipped' | 'cancelled'

/** Result for one selected Work Item target. */
export type WorkItemActionItemResult = {
  /** Canonical target evaluated by the action. */
  target: WorkItemActionTarget
  /** Terminal status for this target. */
  status: WorkItemActionItemStatus
  /** Canonical revision returned after a successful mutation. */
  resultingRevision?: number
  /** Safe failure returned for a failed or skipped target. */
  failure?: WorkItemActionFailure
}

/** Aggregate terminal status of a shared Work Item action. */
export type WorkItemActionStatus = 'succeeded' | 'partial' | 'failed' | 'cancelled'

/** Common result returned regardless of how a Work Item action was invoked. */
export type WorkItemActionResult = {
  /** Action result schema version. */
  schemaVersion: typeof WORK_ITEM_ACTION_SCHEMA_VERSION
  /** Stable action that produced the result. */
  actionId: WorkItemActionId
  /** Aggregate outcome across every evaluated target. */
  status: WorkItemActionStatus
  /** Ordered target-level validation and mutation outcomes. */
  items: WorkItemActionItemResult[]
  /** Target created by a successful create action. */
  createdTarget?: WorkItemActionTarget
  /** Application-relative destination produced by create or open actions. */
  navigationPath?: string
  /** Opaque token accepted by the shared undo handler. */
  undoToken?: string
  /** Aggregate failure when no target-specific failure is available. */
  failure?: WorkItemActionFailure
}
