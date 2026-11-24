import type {
  TeamTaskViewScope,
  WorkItemActionContext,
  WorkItemActionId,
  WorkItemActionResult,
  WorkItemActionSelection,
  WorkItemScheduleOperation,
  BulkOperation,
} from '@mukuroji/contracts'
import { createSearchWorkItemTypeKey, DEFAULT_WORK_ITEM_TYPE_ID } from '@mukuroji/contracts'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { MobileSidebarButton } from '../../shared/ui/sidebar'
import { createTranslator } from '../../shared/i18n/i18n'
import { type TeamIssue, type UpdateTeamIssueInput } from '../api'
import { useWorkspaceSidebarController } from '../../shared/ui/sidebar'
import { createWorkItemDependencySummaries } from '../../work-items/model/workItemDependencies'
import { WorkItemDefinitionFilters } from '../../work-items/ui/WorkItemDefinitionFilters'
import {
  matchesWorkItemDefinitionFilter,
  type WorkItemDefinitionFilter,
} from '../../work-items/model/workItemFilters'
import {
  resolveWorkItemTypeWorkflowStatuses,
  resolveEditableWorkflowStatuses,
  resolveWorkItemPersonOptions,
  resolveWorkItemTypes,
  resolveWorkItemWorkflowStatusId,
  createWorkItemTypeWorkflowStatusKey,
} from '../../work-items/model/workItemDisplay'
import {
  applyTaskViewDefinitionToTasks,
  type TeamIssueViewState,
} from '../../task-views/model/taskViewSurfaceState'
import {
  createFocusedTaskViewActionSelection,
  createTaskViewActionSelection,
  createTaskViewItemKey,
  createTaskViewSelectionKeyboardAction,
  createTaskViewSelectionState,
  reduceTaskViewSelection,
  type TaskViewSelectionState,
} from '../../task-views/model/taskViewSelection'
import {
  allowTaskAction,
  createCancelledTaskActionResult,
  createFailedTaskActionResult,
  createSucceededTaskCreateActionResult,
  createSucceededTaskActionResult,
  createSucceededTaskActionMutationResult,
  denyTaskAction,
  resolveTaskActionExecutionFailureMessage,
  type TaskActionExecutionResult,
} from '../../task-views/model/taskActionRegistry'
import {
  canDismissCompletedTaskActionOwner,
  createTaskActionCompletionBridge,
  isPendingTaskActionFocusCurrent,
  resolvePendingTaskActionContext,
} from '../../task-views/model/taskActionCompletion'
import {
  clearTaskStatusMoveRequest,
  createTaskStatusMoveRequest,
  type TaskStatusMoveRequestSlot,
} from '../../task-views/model/taskStatusMoveRequest'
import {
  executeTeamIssueDirectStatusMove,
  isTeamIssueRevisionConflict,
} from '../../task-views/model/teamIssueDirectMove'
import {
  createTaskSurfaceActionBaseContext,
  resolveTaskSurfaceActionTarget,
  resolveTaskSurfaceActionTargets,
  useTaskSurfaceActions,
  type TaskSurfaceActionDisabledReasons,
  type TaskSurfaceActionHandlers,
  type TaskSurfaceActionLabels,
  type TaskSurfaceActionPermissions,
} from '../../task-views/mutations/useTaskSurfaceActions'
import {
  createTaskSurfaceKeyboardInput,
  formatTaskSurfaceKeyboardShortcut,
} from '../../task-views/ui/taskSurfaceKeyboard'
import type { TaskActionContextMenuAnchorPoint } from '../../task-views/model/taskActionContextMenu'
import { TaskActionContextMenu } from '../../task-views/ui/TaskActionContextMenu'
import {
  isWorkItemRelationGraphConflict,
  matchesTeamIssueKeyword,
  resolveIssueTitle,
  resolveTeamIssueStatusFilter,
} from '../model/teamIssueDisplay'
import { isCancelledTeamIssueUpdate } from '../model/teamIssueUpdateOutcome'
import { CreateIssuePanel } from './CreateTeamIssuePanel'
import {
  createWorkItemDuplicateDraft,
  createWorkItemTemplateDraft,
  listWorkItemTemplatesForTeam,
  type WorkItemDuplicateDraft,
} from '../model/workItemDuplicate'
import { IssueBoard } from './TeamIssueBoard'
import { IssueDetailPane } from './TeamIssueDetailPane'
import {
  emptyWorkspaceMembers,
  type IssueViewMode,
  issueViewPanelId,
  type TeamIssueActionMenuOpenHandler,
  type TeamIssueScreenProps,
} from './teamIssueScreenShared'
import { IssueTable } from './TeamIssueTable'
import {
  createWorkItemOutlineRows,
  planWorkItemHierarchyMove,
  readWorkItemHierarchyMoveShortcut,
  type WorkItemHierarchyMoveBlockReason,
  type WorkItemHierarchyMoveDirection,
} from '../../work-items/model/workItemHierarchy'
import {
  readCollapsedWorkItemOutlineIds,
  writeCollapsedWorkItemOutlineIds,
} from '../../shared/lib/preferences/workItemOutlineCollapse'
import type { MessageKey } from '../../shared/i18n/i18n'
import { IssueToolbar } from './TeamIssueToolbar'
import { TaskGanttView, type TaskGanttOutline } from '../../tasks/ui/TaskGanttView'
import { createTaskGanttDisplayBinding } from '../../tasks/model/taskGanttDisplay'
import { TaskCalendarView } from '../../tasks/ui/TaskCalendarView'
import { startWorkItemListScheduleChange } from '../../task-views/model/workItemListScheduleChange'
import {
  BulkOperationToolbar,
  type BulkOperationMutationContext,
} from '../../bulk-operations/ui/BulkOperationToolbar'
import {
  clearSucceededBulkSelection,
  type BulkOperationSelection,
} from '../../bulk-operations/model/bulkOperation'
import { getCurrentTaskMonth } from '../../tasks/model/taskScheduleWindow'
import { listTaskCalendarMonthTasks } from '../../tasks/model/taskCalendarMonth'
import { listTaskGanttRowTasks, type TaskGanttGrouping } from '../../tasks/model/taskGanttRows'
import { resolveTeamIssueGroupValue } from '../model/teamIssueDisplay'
import { createWorkItemOutlineKey } from '../../work-items/model/workItemHierarchy'
import { useWorkItemScheduleBaselines } from '../../work-items/queries/useWorkItemScheduleBaselines'
import { useWorkItemCreateTemplates } from '../../automation/queries/useWorkItemCreateTemplates'
import { WORK_ITEM_BASELINE_END_DELAY_COLUMN } from '../../work-items/model/workItemScheduleBaselines'
import { createWorkItemCreateSessionDraftKey } from '../../work-items/model/workItemCreateSessionDraft'
import { hasPendingSessionDraft } from '../../auth/useSessionDraft'

/** Message shown when a hierarchy move cannot be made. */
const outlineMoveBlockMessageKeys = {
  'not-in-hierarchy': 'issues.outline.move.not-in-hierarchy',
  'parent-hidden': 'issues.outline.move.parent-hidden',
  'no-previous-sibling': 'issues.outline.move.no-previous-sibling',
  'no-next-sibling': 'issues.outline.move.no-next-sibling',
  'top-level': 'issues.outline.move.top-level',
  'rank-exhausted': 'issues.outline.move.rank-exhausted',
} as const satisfies Record<WorkItemHierarchyMoveBlockReason, MessageKey>

/** Transient Team Issue context-menu target retained independently from keyboard selection. */
type TeamIssueActionContextMenuState = {
  /** Pointer or overflow-control position used by the responsive menu layout. */
  anchorPoint: TaskActionContextMenuAnchorPoint
  /** Element that regains focus after the menu closes. */
  returnFocusElement: HTMLElement
  /** Revision-bound target selected by this row or card entrance. */
  selection: WorkItemActionSelection
  /** Work Item the menu was opened on; screen-owned actions such as Duplicate read it. */
  issue: TeamIssue
}

/** Context retained while a canonical Team Create action is being accepted. */
type TeamIssueCreateContext = {
  /** Optional workflow status inherited from a Board column. */
  workflowStatusId?: string
  /** Optional Work Item Type inherited from a Board column. */
  workItemTypeId?: string
  /** Values copied from an existing Work Item when the member duplicates it. */
  duplicateDraft?: WorkItemDuplicateDraft
}

/**
 * チーム所有 Issue の管理 UI を描画する Storybook 兼用 screen です。
 */
export function TeamIssueScreen({
  activeTaskViewId,
  aiAssistanceEnabled = true,
  softwareFactoryEnabled = true,
  accessToken,
  assigneeOptions = [],
  artifacts,
  bulkWorkspaceId,
  canCreateUnassignedIssue = true,
  canMutateIssue,
  canManageDependencyEndpoint,
  canManageExternalLinks = false,
  collaboration,
  collaborationRoute,
  onAuthenticatedApiError,
  onCommentDraftDirtyChange,
  onBeforeSelectIssue,
  configurationErrorMessage,
  currentWorkspaceMemberKey,
  defaultCreateIssueOpen = false,
  detailErrorMessage,
  externalLinksAccessToken,
  focusedCommentId,
  focusedRootCommentId,
  initialViewMode = 'table',
  issueErrorMessage,
  issueOutline,
  issues = [],
  isLoading = false,
  isPlanningLoading = false,
  isRelationsLoading = false,
  locale,
  onAddRelation,
  onArchiveIssue,
  onBulkApply,
  onBulkPreview,
  onBulkRetry,
  onBulkUndo,
  onCreateIssue,
  onConfirmScheduleChange,
  onCreateScheduleDependency,
  onDeleteRelation,
  onDeleteScheduleDependency,
  onPreviewScheduleChange,
  onRetryPlanning,
  onSelectIssue,
  onUpdateIssue,
  onUpdateScheduleDependency,
  planningErrorMessage,
  planningSnapshot,
  workingCalendar,
  calendarPeriods,
  workingCalendarErrorMessage,
  onRetryWorkingCalendar,
  createIssueProjects,
  relations = [],
  resolvedConfiguration,
  selectedIssueId,
  teamId,
  teamName,
  teams,
  taskViewToolbar,
  taskViewDefinition,
  taskViewPresentation,
  onTaskViewPresentationChange,
  userInitial,
  viewState,
  onViewStateChange,
  workspaceMembers = emptyWorkspaceMembers,
}: TeamIssueScreenProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const { openMobileSidebar } = useWorkspaceSidebarController()
  const [localViewMode, setLocalViewMode] = useState<IssueViewMode>(initialViewMode)
  const [calendarMonth, setCalendarMonth] = useState(() => getCurrentTaskMonth())
  const [localSearchQuery, setLocalSearchQuery] = useState('')
  const [localStatusFilter, setLocalStatusFilter] = useState<string>('all')
  const [localWorkItemTypeFilter, setLocalWorkItemTypeFilter] = useState<string>('all')
  const [localDefinitionFilter, setLocalDefinitionFilter] = useState<WorkItemDefinitionFilter>({
    category: 'all',
    customFieldId: '',
  })
  const createSessionDraftKey = createWorkItemCreateSessionDraftKey(['team', teamId])
  // A create form whose text was kept when the session ended opens again so the text comes back.
  const [isCreateOpen, setIsCreateOpen] = useState(() =>
    defaultCreateIssueOpen || hasPendingSessionDraft(createSessionDraftKey))
  const [createWorkflowStatusId, setCreateWorkflowStatusId] = useState<string>()
  const [createWorkItemTypeId, setCreateWorkItemTypeId] = useState<string>()
  const [createDuplicateDraft, setCreateDuplicateDraft] = useState<WorkItemDuplicateDraft>()
  // Due date entered before a template was picked or cleared, so the restarted form keeps it.
  const [createKeptDueDate, setCreateKeptDueDate] = useState<string>()
  const [createErrorMessage, setCreateErrorMessage] = useState<string | undefined>()
  const createTemplates = useWorkItemCreateTemplates(accessToken, isCreateOpen && Boolean(onCreateIssue))
  const teamCreateTemplates = useMemo(
    () => listWorkItemTemplatesForTeam(createTemplates.templates, teamId),
    [createTemplates.templates, teamId],
  )
  const [detailUpdateError, setDetailUpdateError] = useState<readonly [string, string] | undefined>()
  const [taskViewSelection, setTaskViewSelection] = useState<TaskViewSelectionState>(
    createTaskViewSelectionState,
  )
  const [taskActionErrorMessage, setTaskActionErrorMessage] = useState<string>()
  const [taskActionContextMenuState, setTaskActionContextMenuState] = useState<
    TeamIssueActionContextMenuState
  >()
  const [taskActionCompletion] = useState(createTaskActionCompletionBridge)
  const directStatusMoveRequestSlotRef = useRef<TaskStatusMoveRequestSlot>({
    current: undefined,
  })
  const pendingCreateContextRef = useRef<TeamIssueCreateContext | undefined>(undefined)
  const onSelectIssueRef = useRef(onSelectIssue)
  const selectedIssueIdRef = useRef(selectedIssueId)
  const commentDraftDirtyRef = useRef(false)
  const commentDraftOwnerRef = useRef<string | undefined>(undefined)
  const [pendingAiSummaryIssueKey, setPendingAiSummaryIssueKey] = useState<string>()
  const isAiSummaryOperationPendingRef = useRef(false)
  const activeAiSummaryIssueKey = selectedIssueId
    ? createTaskViewItemKey(teamId, selectedIssueId)
    : undefined
  const activeAiSummaryIssueKeyRef = useRef(activeAiSummaryIssueKey)
  const pendingAiSummaryIssueKeyRef = useRef<string | undefined>(undefined)
  const isAiSummaryOperationPending = pendingAiSummaryIssueKey !== undefined &&
    pendingAiSummaryIssueKey === activeAiSummaryIssueKey

  /** Reports a keyed Brief operation so Team navigation can remain fenced. */
  const reportAiSummaryOperationPending = useCallback((
    issueKey: string,
    pending: boolean,
  ) => {
    if (issueKey !== activeAiSummaryIssueKeyRef.current) return
    if (!pending && pendingAiSummaryIssueKeyRef.current !== issueKey) return
    pendingAiSummaryIssueKeyRef.current = pending ? issueKey : undefined
    isAiSummaryOperationPendingRef.current = pending
    setPendingAiSummaryIssueKey(pending ? issueKey : undefined)
    if (pending) setTaskActionContextMenuState(undefined)
  }, [])

  /** Clears a failed action's selected Team Issue without closing another Issue's dirty draft. */
  const clearSelectedIssueIfAllowed = useCallback((owner: WorkItemActionContext | string = '') => {
    const ownerIssueId = typeof owner === 'string'
      ? owner || undefined
      : resolveTaskSurfaceActionTarget(owner)?.workItemId
    if (isAiSummaryOperationPendingRef.current) return
    const currentIssueId = selectedIssueIdRef.current || undefined
    if (ownerIssueId !== undefined && currentIssueId !== ownerIssueId) return
    if (commentDraftDirtyRef.current && commentDraftOwnerRef.current === currentIssueId) return
    if (commentDraftDirtyRef.current && commentDraftOwnerRef.current !== currentIssueId) {
      commentDraftDirtyRef.current = false
      commentDraftOwnerRef.current = undefined
    }
    onSelectIssueRef.current?.('')
  }, [])

  useLayoutEffect(() => {
    activeAiSummaryIssueKeyRef.current = activeAiSummaryIssueKey
  }, [activeAiSummaryIssueKey])
  useLayoutEffect(() => {
    selectedIssueIdRef.current = selectedIssueId
  }, [selectedIssueId])
  useEffect(() => {
    isAiSummaryOperationPendingRef.current = isAiSummaryOperationPending
    if (!isAiSummaryOperationPending) {
      pendingAiSummaryIssueKeyRef.current = undefined
    }
  }, [isAiSummaryOperationPending])
  useEffect(() => {
    onSelectIssueRef.current = onSelectIssue
  }, [onSelectIssue])
  useEffect(() => () => {
    taskActionCompletion.cancel()
  }, [taskActionCompletion])
  const viewMode = viewState?.viewMode ?? localViewMode
  const searchQuery = viewState?.searchQuery ?? localSearchQuery
  const statusFilter = viewState?.statusFilter ?? localStatusFilter
  const workItemTypeFilter = viewState?.workItemTypeFilter ?? localWorkItemTypeFilter
  const definitionFilter = viewState?.definitionFilter ?? localDefinitionFilter
  const currentViewState: TeamIssueViewState = {
    definitionFilter,
    searchQuery,
    statusFilter,
    workItemTypeFilter,
    viewMode,
  }

  /** Applies one Team Issue view state locally and forwards it to the route controller. */
  const commitViewState = (nextViewState: TeamIssueViewState) => {
    if (isAiSummaryOperationPendingRef.current) return
    setLocalDefinitionFilter(nextViewState.definitionFilter)
    setLocalSearchQuery(nextViewState.searchQuery)
    setLocalStatusFilter(nextViewState.statusFilter)
    setLocalWorkItemTypeFilter(nextViewState.workItemTypeFilter)
    setLocalViewMode(nextViewState.viewMode)
    onViewStateChange?.(nextViewState)
  }
  const activeTeam = teams.find((team) => team.id === teamId)
  const selectedIssue = issues.find((issue) => issue.id === selectedIssueId)
  /** Reports Team-local comment dirtiness while retaining its exact Issue owner. */
  const handleCommentDraftDirtyChange = useCallback((isDirty: boolean, issueId?: string) => {
    const reportedIssueId = issueId ?? selectedIssue?.id
    if (!reportedIssueId) return
    if (isDirty) {
      commentDraftDirtyRef.current = true
      commentDraftOwnerRef.current = reportedIssueId
    } else if (commentDraftOwnerRef.current === reportedIssueId) {
      commentDraftDirtyRef.current = false
      commentDraftOwnerRef.current = undefined
    }
    onCommentDraftDirtyChange?.(isDirty, reportedIssueId)
  }, [onCommentDraftDirtyChange, selectedIssue?.id])
  const dependencySummaries = useMemo(
    () => createWorkItemDependencySummaries(planningSnapshot),
    [planningSnapshot],
  )

  useEffect(() => {
    if (defaultCreateIssueOpen) {
      queueMicrotask(() => setIsCreateOpen(true))
    }
  }, [defaultCreateIssueOpen])

  const configuration = resolvedConfiguration?.configuration
  const workflowStatusFilterOptions = useMemo(
    () => resolveWorkItemTypeWorkflowStatuses(configuration),
    [configuration],
  )
  const workflowStatuses = useMemo(
    () => resolveWorkItemTypeWorkflowStatuses(configuration),
    [configuration],
  )
  const effectiveStatusFilter = resolveTeamIssueStatusFilter(
    statusFilter,
    teamId,
    workflowStatusFilterOptions,
  )
  const effectiveDefinitionFilter = useMemo(() =>
    !definitionFilter.customFieldId ||
      configuration?.customFields.some((field) => field.id === definitionFilter.customFieldId)
      ? definitionFilter
      : {
          category: definitionFilter.category,
          customFieldId: '',
        },
  [configuration?.customFields, definitionFilter])
  const personLabels = useMemo(
    () => Object.fromEntries(workspaceMembers.map((member) => [member.email, member.name ?? member.email])),
    [workspaceMembers],
  )
  const selectedIssueUpdateErrorKey = selectedIssue
    ? JSON.stringify([selectedIssue.teamId, selectedIssue.id])
    : undefined
  const detailErrorMessageLocal = detailUpdateError && detailUpdateError[0] === selectedIssueUpdateErrorKey
    ? detailUpdateError[1]
    : undefined

  /** Dismisses the Team create form without completing another invocation. */
  const dismissCreateIssueEditor = useCallback(() => {
    setCreateErrorMessage(undefined)
    setCreateWorkflowStatusId(undefined)
    setCreateWorkItemTypeId(undefined)
    setCreateDuplicateDraft(undefined)
    setCreateKeptDueDate(undefined)
    setIsCreateOpen(false)
  }, [])

  /** Opens the Team create form for an already accepted canonical invocation. */
  const showCreateIssueEditor = useCallback((context?: TeamIssueCreateContext) => {
    setCreateErrorMessage(undefined)
    setCreateWorkflowStatusId(context?.workflowStatusId)
    setCreateWorkItemTypeId(context?.workItemTypeId)
    setCreateDuplicateDraft(context?.duplicateDraft)
    setCreateKeptDueDate(undefined)
    setIsCreateOpen(true)
  }, [])

  /** Closes the Team create form and clears its contextual defaults. */
  const closeCreateIssue = useCallback(() => {
    taskActionCompletion.cancel('create')
    dismissCreateIssueEditor()
  }, [dismissCreateIssueEditor, taskActionCompletion])

  const visibleIssues = useMemo(
    () => taskViewDefinition
      ? applyTaskViewDefinitionToTasks(issues, taskViewDefinition, {
          resolveProgressMode: () => configuration?.progressMode,
          keywordMatcher: (issue, normalizedKeyword) => matchesTeamIssueKeyword(
            issue,
            normalizedKeyword,
            activeTeam,
            configuration,
            locale,
            personLabels,
            t,
          ),
        })
      : issues.filter((issue) => {
        const matchesStatus = effectiveStatusFilter === 'all' ||
          createWorkItemTypeWorkflowStatusKey(
            issue.teamId,
            issue.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID,
            resolveWorkItemWorkflowStatusId(issue),
          ) === effectiveStatusFilter
        const matchesWorkItemType = workItemTypeFilter === 'all' ||
          createSearchWorkItemTypeKey(
            issue.teamId,
            issue.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID,
          ) === workItemTypeFilter
        const matchesDefinition = matchesWorkItemDefinitionFilter(
          issue,
          configuration,
          effectiveDefinitionFilter,
        )
        const normalizedQuery = searchQuery.trim().toLowerCase()

        if (!matchesStatus || !matchesWorkItemType || !matchesDefinition) {
          return false
        }

        if (!normalizedQuery) {
          return true
        }

        return matchesTeamIssueKeyword(
          issue,
          normalizedQuery,
          activeTeam,
          configuration,
          locale,
          personLabels,
          t,
        )
      }),
    [
      activeTeam,
      configuration,
      effectiveDefinitionFilter,
      effectiveStatusFilter,
      issues,
      locale,
      personLabels,
      searchQuery,
      workItemTypeFilter,
      t,
      taskViewDefinition,
    ],
  )
  // Collapsed rows belong to one Team: the screen stays mounted when the person switches Team,
  // so rows saved for the previous Team are dropped and the new Team's saved rows are read.
  const [collapsedOutlineState, setCollapsedOutlineState] = useState(
    () => ({ teamId, ids: readCollapsedWorkItemOutlineIds(teamId) }),
  )
  const collapsedOutlineIds = useMemo(
    () => collapsedOutlineState.teamId === teamId
      ? collapsedOutlineState.ids
      : readCollapsedWorkItemOutlineIds(teamId),
    [collapsedOutlineState, teamId],
  )
  // Latest collapsed rows, read when a move finishes so collapses made while it saved are kept.
  const collapsedOutlineIdsRef = useRef(collapsedOutlineIds)
  useEffect(() => {
    collapsedOutlineIdsRef.current = collapsedOutlineIds
  }, [collapsedOutlineIds])
  // The Team this screen currently shows; cleared on unmount, so a move that finishes after the
  // person left the screen or switched Team changes nothing here.
  const shownTeamIdRef = useRef<string | undefined>(teamId)
  useEffect(() => {
    shownTeamIdRef.current = teamId
    return () => {
      shownTeamIdRef.current = undefined
    }
  }, [teamId])
  const [outlineStatusMessage, setOutlineStatusMessage] = useState<string>()
  const outlineMovePendingRef = useRef(false)
  const issueViewPanelRef = useRef<HTMLDivElement>(null)
  // Set when the person retries the hierarchy from the retry button, which disappears once the
  // read succeeds; focus then moves to the loaded view instead of falling back to the page.
  const outlineRetryFocusPendingRef = useRef(false)
  // The table nests rows only without grouping; the Gantt chart nests them within each group.
  const isOutlineRequested = (taskViewPresentation?.display.showOutline ?? false) && (
    viewMode === 'gantt' || (viewMode === 'table' && !taskViewPresentation?.groupBy)
  )
  const outlineNodes = isOutlineRequested ? issueOutline?.nodes : undefined
  const outlineRows = useMemo(
    () => outlineNodes && viewMode === 'table'
      ? createWorkItemOutlineRows(visibleIssues, outlineNodes, collapsedOutlineIds)
      : undefined,
    [collapsedOutlineIds, outlineNodes, viewMode, visibleIssues],
  )
  const hasOutlineError = Boolean(isOutlineRequested && issueOutline?.errorMessage)
  // Whether the outline is on screen, and how many times it has been hidden. A move that
  // finishes after the outline gave way to the flat table, such as while the hierarchy reloads,
  // leaves focus alone instead of moving it to the flat row with the same ID. That holds even if
  // the outline came back meanwhile, because the rows were rebuilt.
  const outlineShownRef = useRef({ shown: false, hiddenCount: 0 })
  useEffect(() => {
    const shown = outlineRows !== undefined
    if (outlineShownRef.current.shown && !shown) outlineShownRef.current.hiddenCount += 1
    outlineShownRef.current.shown = shown
  }, [outlineRows])
  useEffect(() => {
    // A retry started before the outline closed does not move focus once it is shown again.
    if (!isOutlineRequested) outlineRetryFocusPendingRef.current = false
  }, [isOutlineRequested])
  useEffect(() => {
    // Waits for the error to clear rather than for new rows: a retry that returns the same
    // hierarchy as before the failure keeps the rows, but the retry button still goes away.
    if (hasOutlineError || !outlineRows || !outlineRetryFocusPendingRef.current) return
    outlineRetryFocusPendingRef.current = false
    // Only reclaim focus the retry button lost; focus the person moved elsewhere stays put.
    const activeElement = document.activeElement
    if (activeElement === null || activeElement === document.body) {
      issueViewPanelRef.current?.focus()
    }
  }, [hasOutlineError, outlineRows])

  /** Shows or hides the rows nested under one outline row and remembers the choice. */
  const toggleOutlineCollapsed = useCallback((issueId: string) => {
    const next = new Set(collapsedOutlineIds)
    if (!next.delete(issueId)) next.add(issueId)
    writeCollapsedWorkItemOutlineIds(teamId, next)
    setCollapsedOutlineState({ teamId, ids: next })
  }, [collapsedOutlineIds, teamId])

  const ganttOutline = useMemo<TaskGanttOutline | undefined>(() => outlineNodes && viewMode === 'gantt'
    ? {
        hierarchies: new Map([[teamId, outlineNodes]]),
        collapsedKeys: new Set([...collapsedOutlineIds].map((id) => createWorkItemOutlineKey(teamId, id))),
        onToggleCollapsed: (issue) => toggleOutlineCollapsed(issue.id),
      }
    : undefined, [collapsedOutlineIds, outlineNodes, teamId, toggleOutlineCollapsed, viewMode])
  // Baselines are read only while the Gantt chart or the table's baseline column shows them.
  const scheduleBaselineFor = useWorkItemScheduleBaselines(
    accessToken,
    visibleIssues,
    viewMode === 'gantt' || (
      viewMode === 'table' &&
      (taskViewPresentation?.columns ?? []).some((column) => column.field === WORK_ITEM_BASELINE_END_DELAY_COLUMN)
    ),
  )
  const ganttGroupBy = viewMode === 'gantt' ? taskViewPresentation?.groupBy : undefined
  const ganttGroupDirection = taskViewPresentation?.groupDirection ?? 'asc'
  const ganttGroup = useMemo<TaskGanttGrouping | undefined>(() => ganttGroupBy
    ? {
        direction: ganttGroupDirection,
        resolve: (issue) => resolveTeamIssueGroupValue(issue, ganttGroupBy, configuration, activeTeam, t),
      }
    : undefined, [activeTeam, configuration, ganttGroupBy, ganttGroupDirection, t])
  // Keyboard navigation and selection follow the rows shown: the outline order without the rows
  // under a collapsed parent, and in the Gantt chart its groups and schedule order as well.
  // The calendar keeps only the cards of the shown month and the unscheduled bucket.
  const navigableIssues = useMemo(
    () => viewMode === 'gantt'
      ? listTaskGanttRowTasks(visibleIssues, {
          ...(ganttOutline ? { outline: ganttOutline } : {}),
          ...(ganttGroup ? { group: ganttGroup } : {}),
        })
      : viewMode === 'calendar'
        ? listTaskCalendarMonthTasks(visibleIssues, calendarMonth)
        : outlineRows ? outlineRows.map((row) => row.item) : visibleIssues,
    [calendarMonth, ganttGroup, ganttOutline, outlineRows, viewMode, visibleIssues],
  )
  const visibleIssueActionTargets = useMemo(
    () => navigableIssues.map((issue) => ({
      expectedRevision: issue.revision,
      teamId: issue.teamId,
      workItemId: issue.id,
    })),
    [navigableIssues],
  )
  const ganttConfigurationsByTeam = useMemo(
    () => resolvedConfiguration ? { [teamId]: resolvedConfiguration } : {},
    [resolvedConfiguration, teamId],
  )
  const saveOutlineMove = issueOutline?.onMove
  /** Plans and saves one indent, outdent, or sibling move, then reports the outcome. */
  const moveIssueInOutline = useCallback((issue: TeamIssue, direction: WorkItemHierarchyMoveDirection) => {
    if (!outlineNodes || !saveOutlineMove || outlineMovePendingRef.current) return
    const plan = planWorkItemHierarchyMove(outlineNodes, issue.id, direction)
    if (!plan.ok) {
      setOutlineStatusMessage(t(outlineMoveBlockMessageKeys[plan.reason]))
      return
    }
    outlineMovePendingRef.current = true
    setOutlineStatusMessage(undefined)
    // Kept from the start of the move: if the view is rebuilt while the move saves, such as by
    // a reload, focus is not handed to a row in the new view the person did not move from.
    const viewPanel = issueViewPanelRef.current
    const outlineHiddenCountAtStart = outlineShownRef.current.hiddenCount
    saveOutlineMove(issue.id, {
      parentWorkItemId: plan.parentWorkItemId,
      hierarchyRank: plan.hierarchyRank,
    }).then(() => {
      // The move saved, but the screen that started it is gone or shows another Team: its
      // collapsed rows and focus belong to that other view now.
      if (shownTeamIdRef.current !== teamId) return
      // Indenting under a collapsed row would hide the moved row, so the new parent opens.
      const latestCollapsedIds = collapsedOutlineIdsRef.current
      if (plan.parentWorkItemId !== null && latestCollapsedIds.has(plan.parentWorkItemId)) {
        const next = new Set(latestCollapsedIds)
        next.delete(plan.parentWorkItemId)
        writeCollapsedWorkItemOutlineIds(teamId, next)
        collapsedOutlineIdsRef.current = next
        setCollapsedOutlineState({ teamId, ids: next })
      }
      setOutlineStatusMessage(t('issues.outline.moved').replace('{title}', resolveIssueTitle(issue, t)))
      // Moving the row in the DOM drops focus; return it so repeated moves keep working. Focus
      // the person moved elsewhere while the move saved stays where it is.
      globalThis.requestAnimationFrame(() => {
        const activeElement = document.activeElement
        if (activeElement !== null && activeElement !== document.body) return
        // Only the view that started the move is searched, so a row with the same ID in another
        // Team's view never takes focus.
        if (!viewPanel?.isConnected || shownTeamIdRef.current !== teamId) return
        const outlineShown = outlineShownRef.current
        if (!outlineShown.shown || outlineShown.hiddenCount !== outlineHiddenCountAtStart) return
        viewPanel.querySelector<HTMLElement>(`[data-testid="issue-row-${CSS.escape(issue.id)}"]`)?.focus()
      })
    }, (error: unknown) => {
      if (shownTeamIdRef.current !== teamId) return
      setOutlineStatusMessage(
        error instanceof Error && error.message ? error.message : t('issues.outline.move.failed'),
      )
    }).finally(() => {
      outlineMovePendingRef.current = false
    })
  }, [outlineNodes, saveOutlineMove, t, teamId])
  const visibleIssueKeys = useMemo(
    () => visibleIssueActionTargets.map((target) =>
      createTaskViewItemKey(target.teamId, target.workItemId)
    ),
    [visibleIssueActionTargets],
  )
  const teamActionSelection = useMemo(
    () => createTaskViewActionSelection(taskViewSelection, visibleIssueActionTargets),
    [taskViewSelection, visibleIssueActionTargets],
  )
  useEffect(() => {
    const pendingContext = taskActionCompletion.current()
    if (
      pendingContext &&
      !isPendingTaskActionFocusCurrent(pendingContext, teamActionSelection)
    ) taskActionCompletion.cancel(pendingContext.actionId)
  }, [taskActionCompletion, teamActionSelection])
  const teamActionScope = useMemo<TeamTaskViewScope>(
    () => ({ kind: 'team', teamId }),
    [teamId],
  )
  const canCreateIssueAction = onCreateIssue !== undefined && !isAiSummaryOperationPending
  const canOpenIssueAction = onSelectIssue !== undefined && !isAiSummaryOperationPending
  const canEditIssueAction = onUpdateIssue !== undefined && canOpenIssueAction
  const canAssignIssueAction = canEditIssueAction && assigneeOptions.length > 0
  const canManageIssueRelationAction = onAddRelation !== undefined && canOpenIssueAction
  /** Checks the exact persisted Work Item ownership scope. */
  const canMutateTeamIssueAction = useCallback((issue: TeamIssue) =>
    canMutateIssue?.(issue) ?? true,
  [canMutateIssue])
  /** Checks whether one visible Team Issue has a different reachable workflow status. */
  const canMoveTeamIssueAction = useCallback((issue: TeamIssue) =>
    !isAiSummaryOperationPending && canEditIssueAction && canMutateTeamIssueAction(issue) &&
      resolveEditableWorkflowStatuses(issue, configuration).some(
      (status) => status.id !== issue.workflowStatusId,
    ), [canEditIssueAction, canMutateTeamIssueAction, configuration, isAiSummaryOperationPending])
  const teamActionLabels = useMemo<TaskSurfaceActionLabels>(() => ({
    archive: t('taskViews.action.archive'),
    assign: t('taskViews.action.assign'),
    create: t('taskViews.action.create'),
    edit: t('taskViews.action.edit'),
    move: t('taskViews.action.move'),
    open: t('taskViews.action.open'),
    relation: t('taskViews.action.relation'),
    schedule: t('taskViews.action.schedule'),
    watch: t('taskViews.action.watch'),
  }), [t])
  const teamActionDisabledReasons = useMemo<TaskSurfaceActionDisabledReasons>(() => ({
    selectionRequired: t('taskViews.action.selectionRequired'),
    singleSelectionRequired: t('taskViews.action.singleSelectionRequired'),
    unavailable: t('taskViews.action.unavailable'),
  }), [t])

  const canUseBulkOperations = viewMode === 'table' && bulkWorkspaceId !== undefined &&
    onBulkPreview !== undefined && onBulkApply !== undefined
  const bulkProjectOptions = useMemo(
    () => (activeTeam?.projects ?? []).map((project) => ({ id: project.id, label: project.name })),
    [activeTeam],
  )
  const selectedIssueKeySet = useMemo(
    () => new Set(taskViewSelection.selectedKeys),
    [taskViewSelection.selectedKeys],
  )
  // Like keyboard selection, "select all shown" leaves out the rows under a collapsed parent.
  const visibleBulkItems = useMemo(
    () => navigableIssues.map(createTeamIssueBulkSelection),
    [navigableIssues],
  )
  const selectedBulkItems = useMemo(
    () => visibleBulkItems.filter((item) => selectedIssueKeySet.has(item.selectionKey)),
    [selectedIssueKeySet, visibleBulkItems],
  )

  /** Selects or clears one table row for a bulk operation. */
  const changeIssueBulkSelection = useCallback((issue: TeamIssue, selected: boolean) => {
    const key = createTaskViewItemKey(issue.teamId, issue.id)
    setTaskViewSelection((current) => {
      if (current.selectedKeys.includes(key) === selected) return current
      return reduceTaskViewSelection(current, {
        key,
        mode: 'toggle',
        orderedKeys: visibleIssueKeys,
        type: 'select',
      })
    })
  }, [visibleIssueKeys])

  /** Selects or clears every listed row from the bulk toolbar. */
  const changeVisibleBulkSelection = useCallback((selectionKeys: string[], selected: boolean) => {
    setTaskViewSelection((current) => {
      const changedKeys = new Set(selectionKeys)
      const selectedKeys = selected
        ? [...current.selectedKeys, ...selectionKeys.filter((key) => !current.selectedKeys.includes(key))]
        : current.selectedKeys.filter((key) => !changedKeys.has(key))
      return { ...current, selectedKeys }
    })
  }, [])

  /** Clears the rows a finished bulk operation changed, keeping the failed ones selected. */
  const handleBulkOperationComplete = useCallback((operation: BulkOperation) => {
    setTaskViewSelection((current) => ({
      ...current,
      selectedKeys: clearSucceededBulkSelection(
        [...current.selectedKeys],
        selectedBulkItems,
        operation,
      ),
    }))
  }, [selectedBulkItems])

  /**
   * Confirms discarding an unsaved comment before a bulk archive removes its Work Item from view.
   *
   * @param context - Request or operation about to be dispatched.
   * @returns Whether the mutation may run.
   */
  const handleBeforeBulkMutation = useCallback((context: BulkOperationMutationContext) => {
    const action = context.request?.action ?? context.operation?.action
    if (context.kind === 'undo' || action?.type !== 'archive' || !action.archived) return true
    const ownerIssueId = commentDraftDirtyRef.current ? commentDraftOwnerRef.current : undefined
    if (!ownerIssueId) return true
    const items = context.request?.items ?? context.operation?.items ?? []
    if (!items.some((item) => item.teamId === teamId && item.workItemId === ownerIssueId)) return true
    if (!globalThis.window.confirm(t('collaboration.composer.discardConfirm'))) return false
    handleCommentDraftDirtyChange(false, ownerIssueId)
    return true
  }, [handleCommentDraftDirtyChange, t, teamId])

  /** Starts a Calendar or Gantt schedule change; the view shows its preview for confirmation. */
  const handleRequestScheduleChange = useMemo(() => onPreviewScheduleChange && onConfirmScheduleChange && canEditIssueAction
    ? (issue: TeamIssue, operation: WorkItemScheduleOperation) => startWorkItemListScheduleChange(
        teamId,
        issue,
        operation,
        { confirm: onConfirmScheduleChange, preview: onPreviewScheduleChange },
        !isAiSummaryOperationPendingRef.current && canMutateTeamIssueAction(issue),
        teamActionDisabledReasons.unavailable,
      )
    : undefined, [
    canEditIssueAction,
    canMutateTeamIssueAction,
    onConfirmScheduleChange,
    onPreviewScheduleChange,
    teamActionDisabledReasons.unavailable,
    teamId,
  ])

  /** Opens one Team Issue detail and focuses an existing mutation control when requested. */
  const executeTeamIssueDetailAction = useCallback((
    context: WorkItemActionContext,
    controlSelector?: string,
    waitForMutation = false,
  ): Promise<WorkItemActionResult> | WorkItemActionResult => {
    const target = resolveTaskSurfaceActionTarget(context)
    if (isAiSummaryOperationPendingRef.current) {
      return createFailedTaskActionResult(
        context.actionId,
        target,
        'TeamTaskAiOperationPending',
        'unavailable',
        teamActionDisabledReasons.unavailable,
      )
    }
    const issue = target
      ? visibleIssues.find((candidate) =>
          candidate.teamId === target.teamId && candidate.id === target.workItemId
        )
      : undefined
    if (!target || !issue) {
      return createFailedTaskActionResult(
        context.actionId,
        target,
        'TeamTaskActionTargetNotFound',
        'not-found',
        t('taskViews.action.notFound'),
      )
    }
    if (onBeforeSelectIssue && !onBeforeSelectIssue(issue.id)) {
      return createCancelledTaskActionResult(context.actionId, [target])
    }

    const completion = waitForMutation
      ? taskActionCompletion.begin(context, clearSelectedIssueIfAllowed)
      : undefined
    setDetailUpdateError(undefined)
    if (!completion) taskActionCompletion.cancel()
    setTaskViewSelection((currentSelection) => reduceTaskViewSelection(currentSelection, {
      key: createTaskViewItemKey(issue.teamId, issue.id),
      type: 'focus',
    }))
    if (selectedIssueIdRef.current !== issue.id) {
      commentDraftDirtyRef.current = false
      commentDraftOwnerRef.current = undefined
    }
    selectedIssueIdRef.current = issue.id
    onSelectIssueRef.current?.(issue.id)
    if (controlSelector) focusTeamIssueDetailControl(controlSelector)
    return completion ?? createSucceededTaskActionResult(context.actionId, target)
  }, [clearSelectedIssueIfAllowed, onBeforeSelectIssue, t, taskActionCompletion, teamActionDisabledReasons.unavailable, visibleIssues])

  const currentTeamActionTarget = teamActionSelection.targets.length === 1
    ? teamActionSelection.targets[0]
    : teamActionSelection.targets.length === 0
      ? teamActionSelection.focusedTarget
      : undefined
  const toggleIssueWatch = currentTeamActionTarget &&
      selectedIssue?.teamId === currentTeamActionTarget.teamId &&
      selectedIssue.id === currentTeamActionTarget.workItemId &&
      collaboration?.watch &&
      collaboration.capabilities.canWatch
    ? collaboration.toggleWatch
    : undefined
  const canMutateSelectedIssue = selectedIssue !== undefined &&
    canMutateTeamIssueAction(selectedIssue)

  /** Executes a destination-bearing Board Move or reveals the detail selector for other entrances. */
  const executeTeamIssueMoveAction = useCallback((
    context: WorkItemActionContext,
  ): WorkItemActionResult | Promise<WorkItemActionResult> => {
    const requestSlot = directStatusMoveRequestSlotRef.current
    if (!requestSlot.current) {
      return executeTeamIssueDetailAction(
        context,
        'select[name="workflowStatusId"]',
        true,
      )
    }

    taskActionCompletion.cancel()
    return executeTeamIssueDirectStatusMove(
      context,
      requestSlot,
      visibleIssues,
      configuration,
      onUpdateIssue,
      {
        conflict: t('tasks.action.conflict'),
        failed: t('taskViews.action.failed'),
        unavailable: teamActionDisabledReasons.unavailable,
        openChildren: t('issues.error.openChildren'),
      },
    ) ?? createFailedTaskActionResult(
      context.actionId,
      resolveTaskSurfaceActionTarget(context),
      'TeamTaskMoveRequestMismatch',
      'validation',
      teamActionDisabledReasons.unavailable,
    )
  }, [
    configuration,
    executeTeamIssueDetailAction,
    onUpdateIssue,
    t,
    taskActionCompletion,
    teamActionDisabledReasons.unavailable,
    visibleIssues,
  ])

  const teamActionHandlers = useMemo<TaskSurfaceActionHandlers>(() => ({
    ...(canCreateIssueAction
      ? {
          create: (context) => {
            const createContext = pendingCreateContextRef.current
            pendingCreateContextRef.current = undefined
            const completion = taskActionCompletion.begin(context, dismissCreateIssueEditor)
            showCreateIssueEditor(createContext)
            return completion
          },
        }
      : {}),
    ...(canOpenIssueAction
      ? {
          open: (context) => executeTeamIssueDetailAction(context),
        }
      : {}),
    ...(canEditIssueAction
      ? {
          edit: (context) => executeTeamIssueDetailAction(
            context,
            'input[name="title"]',
            true,
          ),
          move: executeTeamIssueMoveAction,
        }
      : {}),
    ...(canAssignIssueAction
      ? {
          assign: (context) => executeTeamIssueDetailAction(
            context,
            'select[name="assigneeUserId"]',
            true,
          ),
        }
      : {}),
    ...(canManageIssueRelationAction
      ? {
          relation: (context) => executeTeamIssueDetailAction(
            context,
            '[data-testid="work-item-relations-editor"] select',
            true,
          ),
        }
      : {}),
    ...(toggleIssueWatch
      ? {
          watch: async (context) => {
            const target = resolveTaskSurfaceActionTarget(context)
            if (
              !target ||
              !selectedIssue ||
              selectedIssue.teamId !== target.teamId ||
              selectedIssue.id !== target.workItemId
            ) {
              return createFailedTaskActionResult(
                context.actionId,
                target,
                'TeamTaskActionTargetNotFound',
                'not-found',
                t('taskViews.action.notFound'),
              )
            }
            const succeeded = await toggleIssueWatch()
            return succeeded
              ? createSucceededTaskActionResult(context.actionId, target)
              : createFailedTaskActionResult(
                  context.actionId,
                  target,
                  'TeamTaskWatchFailed',
                  'unknown',
                  t('taskViews.action.failed'),
                )
          },
        }
      : {}),
  }), [
    canAssignIssueAction,
    canCreateIssueAction,
    canEditIssueAction,
    canManageIssueRelationAction,
    canOpenIssueAction,
    dismissCreateIssueEditor,
    executeTeamIssueDetailAction,
    executeTeamIssueMoveAction,
    selectedIssue,
    showCreateIssueEditor,
    t,
    taskActionCompletion,
    toggleIssueWatch,
  ])

  /** Evaluates one Team detail entrance against its revision-bound visible target. */
  const evaluateTeamIssueTargetPermission = useCallback((context: WorkItemActionContext) => {
    if (isAiSummaryOperationPendingRef.current) {
      return denyTaskAction(teamActionDisabledReasons.unavailable)
    }
    const targets = resolveTaskSurfaceActionTargets(context)
    if (targets.length === 0) return allowTaskAction()
    if (targets.length !== 1) {
      return denyTaskAction(teamActionDisabledReasons.singleSelectionRequired)
    }
    const target = targets[0]
    return target && visibleIssues.some((issue) =>
      issue.teamId === target.teamId && issue.id === target.workItemId
    )
      ? allowTaskAction()
      : denyTaskAction(teamActionDisabledReasons.unavailable)
  }, [teamActionDisabledReasons, visibleIssues])

  /** Evaluates one canonical mutation against the current Team-qualified Work Item scope. */
  const evaluateTeamIssueMutationPermission = useCallback((context: WorkItemActionContext) => {
    if (isAiSummaryOperationPendingRef.current) {
      return denyTaskAction(teamActionDisabledReasons.unavailable)
    }
    const targets = resolveTaskSurfaceActionTargets(context)
    if (targets.length === 0) return allowTaskAction()
    if (targets.length !== 1) {
      return denyTaskAction(teamActionDisabledReasons.singleSelectionRequired)
    }
    const target = targets[0]
    const issue = target
      ? visibleIssues.find((candidate) =>
          candidate.teamId === target.teamId && candidate.id === target.workItemId
        )
      : undefined
    return issue && canMutateTeamIssueAction(issue)
      ? allowTaskAction()
      : denyTaskAction(teamActionDisabledReasons.unavailable)
  }, [
    canMutateTeamIssueAction,
    teamActionDisabledReasons,
    visibleIssues,
  ])

  const teamActionPermissions = useMemo<TaskSurfaceActionPermissions>(() => ({
    assign: evaluateTeamIssueMutationPermission,
    edit: evaluateTeamIssueMutationPermission,
    move: (context) => {
      if (isAiSummaryOperationPendingRef.current) {
        return denyTaskAction(teamActionDisabledReasons.unavailable)
      }
      const targets = resolveTaskSurfaceActionTargets(context)
      if (targets.length === 0) return allowTaskAction()
      if (targets.length !== 1) {
        return denyTaskAction(teamActionDisabledReasons.singleSelectionRequired)
      }
      const target = targets[0]
      const issue = target
        ? visibleIssues.find((candidate) =>
            candidate.teamId === target.teamId && candidate.id === target.workItemId
          )
        : undefined
      return issue && canMoveTeamIssueAction(issue)
        ? allowTaskAction()
        : denyTaskAction(teamActionDisabledReasons.unavailable)
    },
    open: evaluateTeamIssueTargetPermission,
    relation: evaluateTeamIssueMutationPermission,
    watch: (context) => {
      if (isAiSummaryOperationPendingRef.current) {
        return denyTaskAction(teamActionDisabledReasons.unavailable)
      }
      const target = resolveTaskSurfaceActionTarget(context)
      return target && selectedIssue && toggleIssueWatch &&
          selectedIssue.teamId === target.teamId && selectedIssue.id === target.workItemId
        ? allowTaskAction()
        : denyTaskAction(teamActionDisabledReasons.unavailable)
    },
  }), [
    canMoveTeamIssueAction,
    evaluateTeamIssueMutationPermission,
    evaluateTeamIssueTargetPermission,
    selectedIssue,
    teamActionDisabledReasons,
    toggleIssueWatch,
    visibleIssues,
  ])

  /**
   * Projects normalized Team action failures into an accessible local notice.
   *
   * @param result - Canonical action execution result to present.
   * @returns Nothing.
   */
  const handleTeamActionExecution = useCallback((result: TaskActionExecutionResult) => {
    setTaskActionErrorMessage(resolveTaskActionExecutionFailureMessage(
      result,
      t('taskViews.action.failed'),
    ))
  }, [t])

  const teamActions = useTaskSurfaceActions({
    ...(activeTaskViewId !== undefined ? { activeViewId: activeTaskViewId } : {}),
    disabledReasons: teamActionDisabledReasons,
    handlers: teamActionHandlers,
    labels: teamActionLabels,
    onExecutionResult: handleTeamActionExecution,
    permissions: teamActionPermissions,
    registrationId: `team-task-actions:${teamId}`,
    scope: teamActionScope,
    selection: teamActionSelection,
    surface: 'team',
  })

  /** Routes a Team Board status selection or drop through the canonical Move registry. */
  const handleTeamIssueStatusMove = useCallback(async (
    issue: TeamIssue,
    destinationWorkflowStatusId: string,
  ): Promise<void> => {
    if (isAiSummaryOperationPendingRef.current) return
    const target = {
      expectedRevision: issue.revision,
      teamId: issue.teamId,
      workItemId: issue.id,
    }
    const request = createTaskStatusMoveRequest(target, destinationWorkflowStatusId)
    const requestSlot = directStatusMoveRequestSlotRef.current
    requestSlot.current = request
    setTaskActionErrorMessage(undefined)
    setTaskViewSelection((currentSelection) => reduceTaskViewSelection(currentSelection, {
      key: createTaskViewItemKey(issue.teamId, issue.id),
      type: 'focus',
    }))

    try {
      await teamActions.execute(
        'move',
        'click',
        undefined,
        createFocusedTaskViewActionSelection(target),
      )
    } finally {
      clearTaskStatusMoveRequest(requestSlot, request)
    }
  }, [teamActions])

  /**
   * Routes header and Board-column Create clicks through the canonical Team registry.
   *
   * @param workflowStatusId - Optional Board-column status default for the create editor.
   * @param workItemTypeId - Optional Board-column Work Item Type default for the create editor.
   */
  const handleTeamCreateClick = useCallback((workflowStatusId?: string, workItemTypeId?: string) => {
    if (isAiSummaryOperationPendingRef.current) return
    pendingCreateContextRef.current = { workflowStatusId, workItemTypeId }
    void teamActions.execute(
      'create',
      'click',
      undefined,
      { mode: 'none', targets: [] },
    )
  }, [teamActions])

  /**
   * Opens the create form with a draft copied from an existing Work Item.
   *
   * @param issue - Work Item to duplicate.
   */
  const handleDuplicateIssue = useCallback((issue: TeamIssue) => {
    if (isAiSummaryOperationPendingRef.current) return
    pendingCreateContextRef.current = { duplicateDraft: createWorkItemDuplicateDraft(issue) }
    void teamActions.execute(
      'create',
      'click',
      undefined,
      { mode: 'none', targets: [] },
    )
  }, [teamActions])

  /**
   * Returns a detail-form mutation outcome to a pending Edit, Move, or Assign action.
   *
   * @param issueId - Team Issue persisted by the existing detail form.
   * @param input - Validated detail patch submitted by the form.
   * @returns Nothing after the existing mutation and completion bridge settle.
   */
  const handleTeamIssueActionUpdate = useCallback(async (
    issueId: string,
    input: UpdateTeamIssueInput,
  ): Promise<void> => {
    if (!onUpdateIssue || isAiSummaryOperationPendingRef.current) return
    const pendingCandidate = resolvePendingTaskActionContext(
      taskActionCompletion,
      ['assign', 'edit', 'move', 'relation'],
      { teamId, workItemId: issueId },
    )
    const currentIssue = selectedIssue?.id === issueId ? selectedIssue : undefined
    const pendingContext = pendingCandidate && (
      pendingCandidate.actionId === 'edit' ||
      (pendingCandidate.actionId === 'move' &&
        currentIssue !== undefined &&
        input.workflowStatusId !== resolveWorkItemWorkflowStatusId(currentIssue)) ||
      (pendingCandidate.actionId === 'assign' &&
        input.assigneeUserId !== undefined &&
        input.assigneeUserId !== currentIssue?.assigneeUserId)
    )
      ? pendingCandidate
      : undefined
    if (pendingCandidate && !pendingContext) {
      taskActionCompletion.cancelContext(pendingCandidate)
    }
    const target = pendingContext
      ? resolveTaskSurfaceActionTarget(pendingContext)
      : undefined
    const claimedContext = pendingContext && target && taskActionCompletion.claim(pendingContext)
      ? pendingContext
      : undefined
    setDetailUpdateError(undefined)

    try {
      const outcome = await onUpdateIssue(issueId, input)
      if (claimedContext && target) {
        taskActionCompletion.settle(claimedContext, isCancelledTeamIssueUpdate(outcome)
          ? createCancelledTaskActionResult(claimedContext.actionId, [target])
          : createSucceededTaskActionMutationResult(
            claimedContext.actionId,
            target,
            outcome?.revision,
          ))
      }
    } catch (error) {
      if (claimedContext) {
        const isConflict = isTeamIssueRevisionConflict(error)
        const canDismissOwner = canDismissCompletedTaskActionOwner(
          taskActionCompletion,
          claimedContext,
        )
        taskActionCompletion.settle(claimedContext, createFailedTaskActionResult(
          claimedContext.actionId,
          target,
          isConflict ? 'WorkItemRevisionConflict' : 'TeamTaskActionMutationFailed',
          isConflict ? 'conflict' : 'unknown',
          isConflict ? t('tasks.action.conflict') : t('taskViews.action.failed'),
          isConflict,
        ))
        if (canDismissOwner) clearSelectedIssueIfAllowed(issueId)
      }
      if (
        selectedIssueUpdateErrorKey &&
        (!claimedContext || canDismissCompletedTaskActionOwner(
          taskActionCompletion,
          claimedContext,
        ))
      ) {
        setDetailUpdateError([
          selectedIssueUpdateErrorKey,
          error instanceof Error ? error.message : t('issues.error.update'),
        ])
      }
    }
  }, [
    onUpdateIssue,
    selectedIssueUpdateErrorKey,
    selectedIssue,
    t,
    taskActionCompletion,
    teamId,
    clearSelectedIssueIfAllowed,
  ])

  /**
   * Returns a relation editor mutation to a pending canonical Relation action.
   *
   * @param issueId - Team Issue whose relation graph is being changed.
   * @param mutate - Existing add or delete relation mutation.
   * @returns Nothing after the relation graph refresh completes.
   */
  const handleTeamIssueActionRelation = useCallback(async (
    issueId: string,
    mutate: () => Promise<void>,
  ): Promise<void> => {
    if (isAiSummaryOperationPendingRef.current) return
    const pendingCandidate = resolvePendingTaskActionContext(
      taskActionCompletion,
      ['assign', 'edit', 'move', 'relation'],
      { teamId, workItemId: issueId },
    )
    const pendingContext = pendingCandidate?.actionId === 'relation'
      ? pendingCandidate
      : undefined
    if (pendingCandidate && !pendingContext) {
      taskActionCompletion.cancelContext(pendingCandidate)
    }
    const target = pendingContext
      ? resolveTaskSurfaceActionTarget(pendingContext)
      : undefined
    const claimedContext = pendingContext && target && taskActionCompletion.claim(pendingContext)
      ? pendingContext
      : undefined

    try {
      await mutate()
      if (claimedContext && target) {
        taskActionCompletion.settle(claimedContext, createSucceededTaskActionMutationResult(
          claimedContext.actionId,
          target,
        ))
      }
    } catch (error) {
      if (claimedContext) {
        const isConflict = isWorkItemRelationGraphConflict(error)
        const canDismissOwner = canDismissCompletedTaskActionOwner(
          taskActionCompletion,
          claimedContext,
        )
        taskActionCompletion.settle(claimedContext, createFailedTaskActionResult(
          claimedContext.actionId,
          target,
          isConflict ? 'WorkItemRelationGraphConflict' : 'TeamTaskRelationMutationFailed',
          isConflict ? 'conflict' : 'unknown',
          t('taskViews.action.failed'),
          isConflict,
        ))
        if (canDismissOwner) clearSelectedIssueIfAllowed(issueId)
      }
      throw error
    }
  }, [clearSelectedIssueIfAllowed, t, taskActionCompletion, teamId])

  const taskActionContextMenuContext = useMemo(() => {
    if (!taskActionContextMenuState) return undefined
    return createTaskSurfaceActionBaseContext(
      'team',
      teamActionScope,
      taskActionContextMenuState.selection,
      activeTaskViewId,
    )
  }, [
    activeTaskViewId,
    taskActionContextMenuState,
    teamActionScope,
  ])

  useEffect(() => {
    queueMicrotask(() => {
      setTaskViewSelection((currentSelection) => reduceTaskViewSelection(currentSelection, {
        availableKeys: visibleIssueKeys,
        type: 'prune',
      }))
    })
  }, [visibleIssueKeys])

  /**
   * Opens one clicked Team Issue through the canonical action registry.
   *
   * @param issue - Visible Team Issue activated by pointer input.
   * @returns Nothing.
   */
  const handleOpenIssue = useCallback((issue: TeamIssue) => {
    if (isAiSummaryOperationPendingRef.current) return
    if (onBeforeSelectIssue && !onBeforeSelectIssue(issue.id)) return
    const issueKey = createTaskViewItemKey(issue.teamId, issue.id)
    setTaskViewSelection((currentSelection) => reduceTaskViewSelection(currentSelection, {
      key: issueKey,
      type: 'focus',
    }))
    void teamActions.execute(
      'open',
      'click',
      undefined,
      createFocusedTaskViewActionSelection({
        expectedRevision: issue.revision,
        teamId: issue.teamId,
        workItemId: issue.id,
      }),
    )
  }, [onBeforeSelectIssue, teamActions])

  /** Opens a revision-bound Team Issue menu without inheriting unrelated selection. */
  const handleTeamIssueActionMenuOpen = useCallback<TeamIssueActionMenuOpenHandler>((
    issue,
    anchorPoint,
    returnFocusElement,
  ) => {
    if (isAiSummaryOperationPendingRef.current) return
    const issueKey = createTaskViewItemKey(issue.teamId, issue.id)
    setTaskViewSelection((currentSelection) => reduceTaskViewSelection(currentSelection, {
      key: issueKey,
      type: 'focus',
    }))
    setTaskActionContextMenuState({
      anchorPoint,
      issue,
      returnFocusElement,
      selection: createFocusedTaskViewActionSelection({
        expectedRevision: issue.revision,
        teamId: issue.teamId,
        workItemId: issue.id,
      }),
    })
  }, [])

  /** Routes one Team Issue menu activation through the canonical action registry. */
  const handleTeamIssueActionMenuExecute = useCallback((actionId: WorkItemActionId) => {
    if (isAiSummaryOperationPendingRef.current || !taskActionContextMenuState) return
    void teamActions.execute(
      actionId,
      'context-menu',
      undefined,
      taskActionContextMenuState.selection,
    )
  }, [taskActionContextMenuState, teamActions])

  const menuIssue = taskActionContextMenuState?.issue
  const taskActionContextMenuExtraActions = useMemo(() => onCreateIssue && menuIssue
    ? [{
        id: 'duplicate',
        label: t('issues.duplicate.menuAction'),
        onSelect: () => handleDuplicateIssue(menuIssue),
      }]
    : [], [handleDuplicateIssue, menuIssue, onCreateIssue, t])

  useEffect(() => {
    /**
     * Routes Team navigation and action shortcuts through shared reducers and registry policy.
     *
     * @param event - Document keydown event to normalize and route.
     * @returns Nothing.
     */
    const handleTeamKeyboard = (event: KeyboardEvent) => {
      if (isAiSummaryOperationPendingRef.current) return
      const input = createTaskSurfaceKeyboardInput(
        event,
        isCreateOpen || Boolean(taskActionContextMenuState),
      )
      // A move applies to the row chosen in the table, so it needs the key press to come from the
      // table or from the page itself after J/K; focus on another control leaves the row alone.
      const target = event.target
      const isOutlineKeyTarget = target === document.body ||
        (target instanceof Node && issueViewPanelRef.current?.contains(target) === true)
      const outlineDirection = outlineRows && isOutlineKeyTarget && !input.isEditableTarget && !input.isModalOpen
        ? readWorkItemHierarchyMoveShortcut(event)
        : undefined
      const outlineIssue = outlineDirection
        ? outlineRows?.find((row) =>
            createTaskViewItemKey(row.item.teamId, row.item.id) === taskViewSelection.focusedKey
          )?.item
        : undefined
      if (outlineDirection && outlineIssue) {
        event.preventDefault()
        moveIssueInOutline(outlineIssue, outlineDirection)
        return
      }
      const selectionAction = createTaskViewSelectionKeyboardAction(
        input,
        taskViewSelection,
        visibleIssueKeys,
      )
      if (selectionAction) {
        event.preventDefault()
        taskActionCompletion.cancel()
        setTaskActionErrorMessage(undefined)
        setTaskViewSelection(reduceTaskViewSelection(taskViewSelection, selectionAction))
        return
      }

      const definition = teamActions.resolveShortcut(input)
      if (!definition) return
      event.preventDefault()
      void teamActions.execute(
        definition.id,
        'keyboard',
        definition.shortcut
          ? formatTaskSurfaceKeyboardShortcut(definition.shortcut)
          : undefined,
      )
    }

    document.addEventListener('keydown', handleTeamKeyboard)
    return () => document.removeEventListener('keydown', handleTeamKeyboard)
  }, [
    isCreateOpen,
    moveIssueInOutline,
    outlineRows,
    taskActionContextMenuState,
    taskActionCompletion,
    taskViewSelection,
    teamActions,
    visibleIssueKeys,
  ])

  return (
    <>
        <header className="workbench-header flex-none px-[clamp(20px,3vw,34px)] py-4">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <MobileSidebarButton
                label={t('sidebar.mobileOpen')}
                onClick={openMobileSidebar}
              />
              <div className="min-w-0">
                <p className="workbench-eyebrow">
                  {t('issues.eyebrow')}
                </p>
                <h1
                  className="workbench-title mt-2 truncate text-page-title"
                  data-testid="team-issues-heading"
                >
                  {teamName ?? t('issues.title')}
                </h1>
                <p className="workbench-description mt-2 max-w-[760px]">
                  {t('issues.description')}
                </p>
              </div>
            </div>
            <div className="flex flex-none items-center gap-3">
              {onCreateIssue ? (
                <button
                  aria-expanded={isCreateOpen}
                  className="workbench-button-primary inline-flex h-10 items-center gap-2 px-4"
                  disabled={isAiSummaryOperationPending}
                  onClick={() => isCreateOpen ? closeCreateIssue() : handleTeamCreateClick()}
                  type="button"
                >
                  + {t('issues.action.new')}
                </button>
              ) : null}
              <div className="grid h-10 w-10 place-items-center rounded-full border border-tone-99d7cf bg-tone-e5f7f4 text-sm font-semibold text-[var(--workbench-primary-text)]">
                {userInitial}
              </div>
            </div>
          </div>
        </header>

        {isLoading ? (
          <div className="grid min-h-0 flex-1 place-items-center px-6 text-sm font-medium text-[var(--workbench-muted)]">
            {t('issues.loading')}
          </div>
        ) : (
          <div className="min-h-0 flex-1">
            <div className="grid min-h-full grid-cols-[minmax(0,1fr)_minmax(360px,440px)] gap-0 max-[1080px]:grid-cols-1">
              <section className="min-w-0 px-[clamp(20px,3vw,34px)] py-5">
                {configurationErrorMessage ? (
                  <p
                    className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-fg-red-700"
                    role="alert"
                  >
                    {configurationErrorMessage}
                  </p>
                ) : null}
                {isCreateOpen && onCreateIssue ? (
                  <CreateIssuePanel
                    key={`create-issue-${createWorkItemTypeId ?? ''}-${createWorkflowStatusId ?? ''}-${createDuplicateDraft?.sourceWorkItemId ?? ''}`}
                    assigneeOptions={assigneeOptions}
                    calendarPolicy={workingCalendar}
                    canCreateUnassignedIssue={canCreateUnassignedIssue}
                    configuration={configuration}
                    duplicateDraft={createDuplicateDraft}
                    initialDueDate={createKeptDueDate}
                    errorMessage={createErrorMessage}
                    onApplyTemplate={(template, dueDate) => {
                      setCreateErrorMessage(undefined)
                      // The restarted form keeps the due date the member entered, with or without a template.
                      setCreateKeptDueDate(dueDate)
                      setCreateDuplicateDraft(template ? createWorkItemTemplateDraft(template) : undefined)
                    }}
                    templateLoadFailed={createTemplates.hasLoadError}
                    onRetryTemplates={createTemplates.retry}
                    templates={teamCreateTemplates}
                    workItemTypeId={createWorkItemTypeId}
                    workflowStatusId={createWorkflowStatusId}
                    locale={locale}
                    onCancel={() => {
                      closeCreateIssue()
                    }}
                    onSubmit={async (input) => {
                      if (!onCreateIssue || isAiSummaryOperationPendingRef.current) {
                        return
                      }

                      setCreateErrorMessage(undefined)

                      const pendingContext = resolvePendingTaskActionContext(
                        taskActionCompletion,
                        ['create'],
                      )
                      const claimedContext = pendingContext &&
                          taskActionCompletion.claim(pendingContext)
                        ? pendingContext
                        : undefined
                      try {
                        const createdMutation = await onCreateIssue(input)
                        const canDismissOwner = claimedContext
                          ? canDismissCompletedTaskActionOwner(
                              taskActionCompletion,
                              claimedContext,
                            )
                          : true
                        if (claimedContext) {
                          taskActionCompletion.settle(claimedContext, createSucceededTaskCreateActionResult(
                            createdMutation
                              ? {
                                  expectedRevision: createdMutation.issue.revision,
                                  teamId: createdMutation.issue.teamId,
                                  workItemId: createdMutation.issue.id,
                                }
                              : undefined,
                            createdMutation?.navigationPath,
                          ))
                        }
                        if (canDismissOwner) dismissCreateIssueEditor()
                      } catch (error) {
                        if (claimedContext) {
                          const canDismissOwner = canDismissCompletedTaskActionOwner(
                            taskActionCompletion,
                            claimedContext,
                          )
                          taskActionCompletion.settle(claimedContext, createFailedTaskActionResult(
                            claimedContext.actionId,
                            undefined,
                            'TeamTaskCreateFailed',
                            'unknown',
                            t('issues.error.create'),
                          ))
                          if (canDismissOwner) dismissCreateIssueEditor()
                        }
                        if (!claimedContext) {
                          setCreateErrorMessage(
                            error instanceof Error ? error.message : t('issues.error.create'),
                          )
                        }
                      }
                    }}
                    sessionDraftKey={createSessionDraftKey}
                    projects={createIssueProjects ?? activeTeam?.projects ?? []}
                    t={t}
                    workspaceMembers={workspaceMembers}
                  />
                ) : null}
                {taskViewToolbar}
                <IssueToolbar
                  onSearchQueryChange={(nextSearchQuery) => commitViewState({
                    ...currentViewState,
                    searchQuery: nextSearchQuery,
                  })}
                  onStatusFilterChange={(nextStatusFilter) => commitViewState({
                    ...currentViewState,
                    statusFilter: nextStatusFilter,
                  })}
                  onWorkItemTypeFilterChange={(nextWorkItemTypeFilter) => commitViewState({
                    ...currentViewState,
                    workItemTypeFilter: nextWorkItemTypeFilter,
                  })}
                  onViewModeChange={(nextViewMode) => commitViewState({
                    ...currentViewState,
                    viewMode: nextViewMode,
                  })}
                  searchQuery={searchQuery}
                  statusFilter={effectiveStatusFilter}
                  teamId={teamId}
                  t={t}
                  viewMode={viewMode}
                  workItemTypeFilter={workItemTypeFilter}
                  workItemTypes={resolveWorkItemTypes(configuration)}
                  workflowStatuses={workflowStatusFilterOptions}
                />
                <div className="workbench-toolbar mt-3 px-3 py-2">
                  <WorkItemDefinitionFilters
                    configuration={configuration}
                    idPrefix="team-issues"
                    locale={locale}
                    onChange={(nextDefinitionFilter) => commitViewState({
                      ...currentViewState,
                      definitionFilter: nextDefinitionFilter,
                    })}
                    personOptions={resolveWorkItemPersonOptions(workspaceMembers)}
                    value={effectiveDefinitionFilter}
                  />
                </div>
                {issueErrorMessage ? (
                  <p className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-fg-red-700">
                    {issueErrorMessage}
                  </p>
                ) : null}
                {workingCalendarErrorMessage ? (
                  <div
                    className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--workbench-warning-border)] bg-[var(--workbench-warning-surface)] px-4 py-3"
                    data-testid="team-issue-workspace-calendar-error"
                    role="alert"
                  >
                    <p className="text-sm font-semibold text-[var(--workbench-warning)]">{workingCalendarErrorMessage}</p>
                    {onRetryWorkingCalendar ? (
                      <button className="workbench-button-secondary min-h-9 px-3" onClick={onRetryWorkingCalendar} type="button">
                        {t('tasks.workspaceCalendar.retry')}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {planningErrorMessage ? (
                  <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3" role="alert">
                    <p className="text-sm font-bold text-fg-red-700">{planningErrorMessage}</p>
                    {onRetryPlanning ? (
                      <button className="workbench-button-secondary min-h-9 px-3" onClick={onRetryPlanning} type="button">
                        {t('planning.action.retry')}
                      </button>
                    ) : null}
                  </div>
                ) : isPlanningLoading ? (
                  <p className="mt-5 text-sm font-semibold text-[var(--workbench-muted)]">
                    {t('planning.loading')}
                  </p>
                ) : null}
                {taskActionErrorMessage ? (
                  <p
                    className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-fg-red-700"
                    role="alert"
                  >
                    {taskActionErrorMessage}
                  </p>
                ) : null}
                {isOutlineRequested && issueOutline?.isLoading && !hasOutlineError ? (
                  <p
                    className="mt-5 text-sm font-semibold text-[var(--workbench-muted)]"
                    data-testid="team-issue-outline-loading"
                    role="status"
                  >
                    {t('issues.outline.loading')}
                  </p>
                ) : null}
                {hasOutlineError && issueOutline?.errorMessage ? (
                  <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3" data-testid="team-issue-outline-unavailable">
                    <p className="text-sm font-semibold text-fg-amber-800" role="alert">{issueOutline.errorMessage}</p>
                    {issueOutline.onRetry ? (
                      <button
                        aria-busy={issueOutline.isRetrying ? true : undefined}
                        // aria-disabled rather than disabled keeps focus on the button while the
                        // read runs, so a failed retry leaves the person where they were.
                        aria-disabled={issueOutline.isRetrying ? true : undefined}
                        className="workbench-button-secondary min-h-9 px-3 aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
                        onClick={(event) => {
                          if (issueOutline.isRetrying) return
                          outlineRetryFocusPendingRef.current = document.activeElement === event.currentTarget
                          issueOutline.onRetry?.()
                        }}
                        type="button"
                      >
                        {issueOutline.isRetrying ? t('issues.outline.retrying') : t('issues.outline.retry')}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {outlineRows ? (
                  <p
                    className={outlineStatusMessage
                      ? 'mt-5 text-sm font-semibold text-[var(--workbench-muted)]'
                      : 'sr-only'}
                    data-testid="team-issue-outline-status"
                    role="status"
                  >
                    {outlineStatusMessage}
                  </p>
                ) : null}
                <div
                  aria-label={t(`issues.view.${viewMode}`)}
                  id={issueViewPanelId}
                  ref={issueViewPanelRef}
                  role="region"
                  tabIndex={-1}
                >
                  {canUseBulkOperations ? (
                    <BulkOperationToolbar
                      key={teamId}
                      onApply={onBulkApply}
                      onBeforeMutation={handleBeforeBulkMutation}
                      onOperationComplete={handleBulkOperationComplete}
                      onPreview={onBulkPreview}
                      onRetry={onBulkRetry}
                      onUndo={onBulkUndo}
                      onVisibleSelectionChange={changeVisibleBulkSelection}
                      projectOptions={bulkProjectOptions}
                      readOnly={isAiSummaryOperationPending}
                      selectedItems={selectedBulkItems}
                      t={t}
                      visibleItems={visibleBulkItems}
                      workspaceId={bulkWorkspaceId}
                    />
                  ) : null}
                  {viewMode === 'table' ? (
                    <IssueTable
                      activeTeam={activeTeam}
                      configuration={configuration}
                      dependencySummaries={dependencySummaries}
                      focusedIssueKey={taskViewSelection.focusedKey}
                      isAiOperationPending={isAiSummaryOperationPending}
                      issues={visibleIssues}
                      presentation={taskViewPresentation}
                      locale={locale}
                      onIssueActionMenuOpen={handleTeamIssueActionMenuOpen}
                      onIssueSelectionChange={canUseBulkOperations ? changeIssueBulkSelection : undefined}
                      onOpenIssue={canOpenIssueAction ? handleOpenIssue : undefined}
                      scheduleBaselineFor={scheduleBaselineFor}
                      outline={outlineRows
                        ? {
                            rows: outlineRows,
                            onToggleCollapsed: toggleOutlineCollapsed,
                            ...(saveOutlineMove ? { onMove: moveIssueInOutline } : {}),
                          }
                        : undefined}
                      selectedIssueKeys={taskViewSelection.selectedKeys}
                      selectedIssueId={selectedIssueId}
                      t={t}
                      workspaceMembers={workspaceMembers}
                    />
                  ) : viewMode === 'calendar' ? (
                    <TaskCalendarView
                      calendarPeriods={calendarPeriods}
                      configuration={configuration}
                      configurationsByTeam={ganttConfigurationsByTeam}
                      month={calendarMonth}
                      monthNote="shown-month"
                      onMonthChange={setCalendarMonth}
                      onRequestScheduleChange={handleRequestScheduleChange}
                      onSelectTask={canOpenIssueAction ? handleOpenIssue : undefined}
                      t={t}
                      tasks={visibleIssues}
                      workingCalendar={workingCalendar}
                    />
                  ) : viewMode === 'gantt' ? (
                    <TaskGanttView
                      configuration={configuration}
                      configurationsByTeam={ganttConfigurationsByTeam}
                      group={ganttGroup}
                      onRequestScheduleChange={handleRequestScheduleChange}
                      onSelectTask={canOpenIssueAction ? handleOpenIssue : undefined}
                      outline={ganttOutline}
                      planningSnapshot={planningSnapshot}
                      scheduleBaselineFor={scheduleBaselineFor}
                      t={t}
                      tasks={visibleIssues}
                      workingCalendar={workingCalendar}
                      calendarPeriods={calendarPeriods}
                      {...createTaskGanttDisplayBinding(
                        taskViewPresentation,
                        onTaskViewPresentationChange,
                      )}
                    />
                  ) : (
                    <IssueBoard
                      activeTeam={activeTeam}
                      configuration={configuration}
                      dependencySummaries={dependencySummaries}
                      focusedIssueKey={taskViewSelection.focusedKey}
                      isAiOperationPending={isAiSummaryOperationPending}
                      issues={visibleIssues}
                      presentation={taskViewPresentation}
                      locale={locale}
                      canMoveIssueStatus={canMoveTeamIssueAction}
                      onCreateIssueOpen={onCreateIssue ? handleTeamCreateClick : undefined}
                      onIssueActionMenuOpen={handleTeamIssueActionMenuOpen}
                      onMoveIssueStatus={canEditIssueAction
                        ? handleTeamIssueStatusMove
                        : undefined}
                      onOpenIssue={canOpenIssueAction ? handleOpenIssue : undefined}
                      selectedIssueKeys={taskViewSelection.selectedKeys}
                      selectedIssueId={selectedIssueId}
                      t={t}
                      workflowStatuses={workflowStatuses}
                      workspaceMembers={workspaceMembers}
                    />
                  )}
                </div>
              </section>
              <IssueDetailPane
                aiAssistanceEnabled={aiAssistanceEnabled}
                softwareFactoryEnabled={softwareFactoryEnabled}
                accessToken={accessToken}
                assigneeOptions={assigneeOptions}
                artifacts={artifacts}
                canManageDependencyEndpoint={canManageDependencyEndpoint}
                canManageExternalLinks={canManageExternalLinks}
                collaboration={collaboration}
                collaborationRoute={collaborationRoute}
                configuration={configuration}
                currentWorkspaceMemberKey={currentWorkspaceMemberKey}
                detailErrorMessage={detailErrorMessage ?? detailErrorMessageLocal}
                externalLinksAccessToken={externalLinksAccessToken}
                focusedCommentId={focusedCommentId}
                focusedRootCommentId={focusedRootCommentId}
                issue={selectedIssue}
                isAiSummaryOperationPending={isAiSummaryOperationPending}
                isRelationsLoading={isRelationsLoading}
                locale={locale}
                onAuthenticatedApiError={onAuthenticatedApiError}
                onAiSummaryOperationPendingChange={reportAiSummaryOperationPending}
                onCommentDraftDirtyChange={handleCommentDraftDirtyChange}
                onDuplicateIssue={onCreateIssue ? handleDuplicateIssue : undefined}
                onArchiveIssue={canMutateSelectedIssue ? onArchiveIssue : undefined}
                onAddRelation={canMutateSelectedIssue && onAddRelation
                  ? (issueId, input) => handleTeamIssueActionRelation(
                      issueId,
                      () => onAddRelation(issueId, input),
                    )
                  : undefined}
                onCreateScheduleDependency={canMutateSelectedIssue
                  ? onCreateScheduleDependency
                  : undefined}
                onDeleteRelation={canMutateSelectedIssue && onDeleteRelation
                  ? (issueId, relation) => handleTeamIssueActionRelation(
                      issueId,
                      () => onDeleteRelation(issueId, relation),
                    )
                  : undefined}
                onDeleteScheduleDependency={canMutateSelectedIssue
                  ? onDeleteScheduleDependency
                  : undefined}
                onUpdateIssue={canMutateSelectedIssue && onUpdateIssue
                  ? handleTeamIssueActionUpdate
                  : undefined}
                onUpdateScheduleDependency={canMutateSelectedIssue
                  ? onUpdateScheduleDependency
                  : undefined}
                planningSnapshot={planningSnapshot}
                canAssignUnassigned={canCreateUnassignedIssue}
                projects={createIssueProjects ?? activeTeam?.projects ?? []}
                relationCandidates={issues}
                relations={relations}
                t={t}
                workspaceMembers={workspaceMembers}
              />
            </div>
          </div>
        )}
        {taskActionContextMenuState && taskActionContextMenuContext ? (
          <TaskActionContextMenu
            anchorPoint={taskActionContextMenuState.anchorPoint}
            context={taskActionContextMenuContext}
            labels={teamActionLabels}
            menuLabel={t('tasks.action.more')}
            onClose={() => setTaskActionContextMenuState(undefined)}
            extraActions={taskActionContextMenuExtraActions}
            onExecute={handleTeamIssueActionMenuExecute}
            registry={teamActions.registry}
            returnFocusElement={taskActionContextMenuState.returnFocusElement}
            testId="team-issue-action-context-menu"
          />
        ) : null}
    </>
  )
}

/**
 * Focuses and reveals a control after React commits a selected Team Issue detail update.
 *
 * @param selector - Selector scoped to the active Team Issue detail pane.
 * @returns Nothing.
 */
function focusTeamIssueDetailControl(selector: string): void {
  requestAnimationFrame(() => {
    const detailPane = document.querySelector<HTMLElement>(
      '[data-testid="team-issue-detail-pane"]',
    )
    const control = detailPane?.querySelector<HTMLElement>(selector)
    control?.focus()
    control?.scrollIntoView({ block: 'nearest' })
  })
}

/**
 * Builds the bulk-operation snapshot of one Team Work Item, keyed like the table selection.
 *
 * @param issue - Work Item at the revision the table shows.
 * @returns Revision-bound selection item.
 */
function createTeamIssueBulkSelection(issue: TeamIssue): BulkOperationSelection {
  return {
    expectedRevision: issue.revision,
    label: issue.title,
    selectionKey: createTaskViewItemKey(issue.teamId, issue.id),
    teamId: issue.teamId,
    workItemId: issue.id,
  }
}
