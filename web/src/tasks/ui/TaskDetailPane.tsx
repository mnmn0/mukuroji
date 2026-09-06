import type {
  AiPlanningDraft,
  AiWorkItemSource,
  PlanningSnapshot,
  WorkItemTypeChangePreview,
  WorkItemDetailSectionId,
  WorkItemDependencyEndpoint,
  WorkItemConfiguration,
  WorkItemRelation,
  WorkItemSchedule,
  WorkItemScheduleCalendarPolicy,
  WorkItemScheduleDependency,
  WorkItemScheduleDependencyPatch,
} from '@mukuroji/contracts'
import { DEFAULT_WORK_ITEM_TYPE, DEFAULT_WORK_ITEM_TYPE_ID } from '@mukuroji/contracts'
import { Fragment, useId, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import { RelatedDocuments } from '../../documents/ui/RelatedDocuments'
import type { FileArtifactsController } from '../../files/mutations/useFileArtifacts'
import { IssueArtifactsPanel } from '../../files/ui/IssueArtifactsPanel'
import type {
  IssueCollaborationController,
} from '../../issues/mutations/useIssueCollaboration'
import { useDocumentContextPromotion } from '../../issues/mutations/useDocumentContextPromotion'
import type { TeamIssue, TeamIssueDetail, UpdateTeamIssueInput } from '../../issues/api'
import { previewTeamIssueWorkItemType } from '../../issues/api/workItems'
import {
  resolveWorkItemAssignee,
  resolveCreateWorkflowStatuses,
  resolveWorkItemTypeDefinition,
  resolveWorkItemTypeFormFields,
  resolveWorkItemTypeLabel,
  resolveWorkItemTypes,
  resolveWorkItemTypeWorkflow,
  resolveWorkItemTitle,
} from '../../work-items/model/workItemDisplay'
import {
  IssueCollaborationPanel,
  type IssueSummaryAiAssistance,
} from '../../issues/ui/IssueCollaborationPanel'
import type { IssueCollaborationRoute } from '../../issues/model/collaborationTabs'
import type { ProjectDirectoryTeam, ProjectMember } from '../../projects/api'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import { createTeamTriagePath } from '../../shared/routing/paths'
import { useTriageWorkItemSources } from '../../triage/queries/useTriageQueries'
import type { WorkspaceMember } from '../../workspace/api'
import {
  isCustomFieldApplicable,
  parseCustomFieldFormData,
} from '../../work-items/model/customFields'
import {
  createCustomFieldErrorMessages,
  createVisibleCustomFieldValuePatch,
  resolveEditableWorkflowStatuses,
  resolveWorkItemPersonOptions,
  resolveWorkItemWorkflowStatusId,
} from '../../work-items/model/workItemDisplay'
import type { WorkItemDependencyCreateDraft } from '../../work-items/model/workItemDependencies'
import { WorkItemFieldsEditor } from '../../work-items/ui/WorkItemFieldsEditor'
import { WorkItemDependencyPanel } from '../../work-items/ui/WorkItemDependencyPanel'
import { WorkItemTypeIcon } from '../../work-items/ui/WorkItemTypeIcon'
import {
  WorkItemRelationsEditor,
  type WorkItemRelationEditorInput,
} from '../../work-items/ui/WorkItemRelationsEditor'
import type { CanonicalWorkItem } from '../api/tasks'
import { CustomerImpactPanel } from '../../customers/ui'
import { resolveTaskPriority, taskPriorities } from '../model/taskView'
import {
  areTaskSchedulesEqual,
  countTaskSchedulePolicyWorkingDays,
  createDefaultDateRangeTaskSchedule,
  createDefaultDueDateTaskSchedule,
  createDefaultMilestoneTaskSchedule,
  createDefaultUnscheduledTaskSchedule,
  resolveTaskScheduleEndDate,
  resolveTaskScheduleStartDate,
} from '../model/taskSchedule'
import { TaskPriorityBadge } from './TaskViewPrimitives'

/** Context passed from the Work Item container to the feature-owned AI renderer. */
export type TaskDetailAiAssistanceRenderContext = {
  /** Active Workspace member bearer token. */
  accessToken?: string
  /** Whether the Planning workflow is enabled for this route. */
  aiAssistanceEnabled: boolean
  /** Whether the Summary workflow is enabled for this route. */
  aiSummaryAssistanceEnabled: boolean
  /** Whether a Work Item mutation is currently in flight. */
  isMutationPending: boolean
  /** Locale used by the assistants. */
  locale: Locale
  /** Reports authenticated AI failures to the route session guard. */
  onAuthenticatedApiError?: (error: unknown) => void
  /** Copies an approved Planning draft into the local Work Item editor. */
  onPlanningAdopt?: (draft: AiPlanningDraft) => void | Promise<void>
  /** Reports Planning operation state to the local Work Item save guard. */
  onPlanningOperationPendingChange?: (pending: boolean) => void
  /** Determines whether a Planning draft contains an editable supported field. */
  canAdoptPlanningDraft?: (draft: AiPlanningDraft) => boolean
  /** Rechecks local edits after the asynchronous Planning approval. */
  shouldConfirmPlanningAdoption?: (draft: AiPlanningDraft) => boolean
  /** Resolves a visible workflow status label. */
  resolveStatusLabel?: (statusId: string) => string
  /** Resolves a visible Team-qualified Work Item label. */
  resolveWorkItemLabel?: (endpoint: WorkItemDependencyEndpoint) => string
  /** Whether Planning adoption must confirm replacing local edits. */
  requirePlanningAdoptionConfirmation?: boolean
  /** Reports Summary operation state to the local Work Item save guard. */
  onSummaryOperationPendingChange?: (pending: boolean) => void
  /** Revision-fenced Work Item source shared by both workflows. */
  source: AiWorkItemSource
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/** AI slots returned by a feature-owned Work Item renderer. */
export type TaskDetailAiAssistanceSlots = {
  /** Planning assistant rendered above the Work Item fields. */
  planning?: ReactNode
  /** Summary assistant supplied to the collaboration panel. */
  summary?: IssueSummaryAiAssistance
}

/** Builds feature-owned AI UI for the selected Work Item detail pane. */
export type TaskDetailAiAssistanceRenderer = (
  context: TaskDetailAiAssistanceRenderContext,
) => TaskDetailAiAssistanceSlots

/** Props accepted by the selected task detail pane. */
export type TaskDetailPaneProps = {
  /** Optional feature-owned AI renderer supplied by the route container. */
  renderAiAssistance?: TaskDetailAiAssistanceRenderer
  /** Whether the dependent AI API deployment has enabled the route-level controls. */
  aiAssistanceEnabled?: boolean
  /** Whether the Summary workflow is enabled for the current Workspace member. */
  aiSummaryAssistanceEnabled?: boolean
  /** Reports authenticated AI failures to the owning task route session guard. */
  onAuthenticatedApiError?: (error: unknown) => void
  /** Determines whether the current user may manage one canonical dependency endpoint. */
  canManageScheduleDependencyEndpoint?: (endpoint: WorkItemDependencyEndpoint) => boolean
  /** Whether the current Workspace member may read Team Triage source links. */
  canAccessTriage?: boolean
  /** Access token used by the related-document panel. */
  accessToken?: string
  /** Active project members available as assignees. */
  assigneeOptions: ProjectMember[]
  /** File controller scoped to the selected Work Item. */
  artifacts?: FileArtifactsController
  /** Collaboration controller scoped to the selected Work Item. */
  collaboration?: IssueCollaborationController
  /** Work Item configuration resolved for the selected task. */
  configuration?: WorkItemConfiguration
  /** Current Workspace member key used by collaboration and approval controls. */
  currentWorkspaceMemberKey?: string
  /** Latest detail response for the selected Work Item. */
  detail?: TeamIssueDetail
  /** Detail load or mutation error shown below the form. */
  errorMessage?: string
  /** Comment selected by a notification deep link. */
  focusedCommentId?: string
  /** Root comment containing the selected reply. */
  focusedRootCommentId?: string
  /** Route-owned collaboration section and deep-link state. */
  collaborationRoute?: IssueCollaborationRoute
  /** Whether the selected Work Item detail is loading. */
  isLoading: boolean
  /** Whether relation candidates are loading. */
  isRelationCandidatesLoading: boolean
  /** Locale used by form controls and nested panels. */
  locale: Locale
  /** Authoritative canonical Work Item dependency graph. */
  planningSnapshot?: PlanningSnapshot
  /** Creates a relation from the selected Work Item. */
  onAddRelation?: (issueId: string, input: WorkItemRelationEditorInput) => Promise<void>
  /** Deletes a relation from the selected Work Item. */
  onDeleteRelation?: (issueId: string, relation: WorkItemRelation) => Promise<void>
  /** Creates a canonical schedule dependency involving any visible Work Item. */
  onCreateScheduleDependency?: (input: WorkItemDependencyCreateDraft) => void | Promise<void>
  /** Deletes a canonical schedule dependency. */
  onDeleteScheduleDependency?: (dependency: WorkItemScheduleDependency) => void | Promise<void>
  /** Closes the detail pane while keeping the list selection and scroll position. */
  onClose?: () => void
  /** Reports combined Work Item AI operation state to the owning task screen. */
  onAiOperationPendingChange?: (pending: boolean) => void
  /** Cancels an accepted Schedule action when explicit save detects no schedule change. */
  onScheduleNoChange?: (teamId: string, issueId: string) => void
  /** Saves editable fields on the selected Work Item. */
  onUpdateIssue?: (
    teamId: string,
    issueId: string,
    input: UpdateTeamIssueInput,
  ) => Promise<void>
  /** Updates a canonical schedule dependency rule. */
  onUpdateScheduleDependency?: (
    dependency: WorkItemScheduleDependency,
    patch: WorkItemScheduleDependencyPatch,
  ) => void | Promise<void>
  /** Projects in the selected Work Item's owning Team. */
  projects: ProjectDirectoryTeam['projects']
  /** Same-Team Work Items available as relation targets. */
  relationCandidates: TeamIssue[]
  /** Relation candidate load error shown by the relation editor. */
  relationCandidatesErrorMessage?: string
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
  /** Task selected by the list, board, or route. */
  task?: CanonicalWorkItem
  /** Workspace members used by custom fields and collaboration panels. */
  workspaceMembers: WorkspaceMember[]
}

/** Local Work Item editor defaults copied from one approved Planning draft. */
type WorkItemAiFormSeed = {
  /** Approved draft used only as uncontrolled form defaults. */
  draft?: AiPlanningDraft
  /** Exact Work Item identity and source revision represented by this seed. */
  identity: string
  /** Monotonic key used to remount the supported editor fields. */
  revision: number
}

/** Dirty state scoped to one exact Work Item editor revision. */
type WorkItemEditorDirtyState = {
  /** Whether an operator changed a local editable field. */
  dirty: boolean
  /** Exact Work Item identity and source revision represented by the dirty flag. */
  identity: string
}

/** Local state for a revision-fenced Work Item Type change preview. */
type WorkItemTypeChangeEditorState = {
  /** Field identifiers whose removal the operator has acknowledged. */
  acknowledgedLostCustomFieldIds: string[]
  /** Exact Work Item revision and Project selection represented by this preview. */
  identity: string
  /** Whether the preview request is currently running. */
  isPreviewing: boolean
  /** Server-authoritative impact summary, when available. */
  preview?: WorkItemTypeChangePreview
  /** Replacement workflow status selected for an invalid current status. */
  replacementWorkflowStatusId?: string
  /** Error from the latest preview request. */
  errorMessage?: string
  /** Type selected by the operator for this preview. */
  targetWorkItemTypeId: string
}

/**
 * Renders the selected Work Item form, files, relations, documents, and collaboration.
 *
 * @param props - Selected task data, scoped controllers, and mutation callbacks.
 * @returns The selected task detail pane.
 */
export function TaskDetailPane({
  accessToken,
  aiAssistanceEnabled = true,
  aiSummaryAssistanceEnabled = false,
  assigneeOptions,
  canAccessTriage = false,
  artifacts,
  canManageScheduleDependencyEndpoint,
  collaboration,
  configuration,
  currentWorkspaceMemberKey,
  detail,
  errorMessage,
  focusedCommentId,
  collaborationRoute,
  focusedRootCommentId,
  isLoading,
  isRelationCandidatesLoading,
  locale,
  planningSnapshot,
  onAddRelation,
  onAuthenticatedApiError,
  onCreateScheduleDependency,
  onAiOperationPendingChange,
  onClose,
  onDeleteRelation,
  onDeleteScheduleDependency,
  onScheduleNoChange,
  onUpdateIssue,
  onUpdateScheduleDependency,
  projects,
  relationCandidates,
  relationCandidatesErrorMessage,
  renderAiAssistance,
  t,
  task,
  workspaceMembers,
}: TaskDetailPaneProps) {
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string | undefined>>>({})
  const [isIssueSaving, setIsIssueSaving] = useState(false)
  const isIssueSavingRef = useRef(false)
  const [isAiPlanningOperationPending, setIsAiPlanningOperationPending] = useState(false)
  const isAiPlanningOperationPendingRef = useRef(false)
  const [isAiSummaryOperationPending, setIsAiSummaryOperationPending] = useState(false)
  const isAiSummaryOperationPendingRef = useRef(false)
  const isWorkItemMutationPending = isIssueSaving ||
    isAiPlanningOperationPending ||
    isAiSummaryOperationPending
  const [aiFormSeed, setAiFormSeed] = useState<WorkItemAiFormSeed>({
    identity: '',
    revision: 0,
  })
  const [editorDirtyState, setEditorDirtyState] = useState<WorkItemEditorDirtyState>({
    dirty: false,
    identity: '',
  })
  const editorDirtyStateRef = useRef<WorkItemEditorDirtyState>({
    dirty: false,
    identity: '',
  })
  const documentContextPromotion = useDocumentContextPromotion(
    Boolean(collaboration?.context.capabilities.canCreate && !isAiSummaryOperationPending),
    `${task?.teamId ?? ''}:${task?.id ?? ''}`,
    collaborationRoute?.onCollaborationTabChange,
  )
  const editorFormId = useId()
  const scheduleFormId = useId()
  const {
    data: triageSourcesPages,
    error: triageSourcesError,
    isValidating: isTriageSourcesValidating,
    setSize: setTriageSourcesSize,
    size: triageSourcesSize,
  } = useTriageWorkItemSources(
    accessToken,
    task?.teamId,
    task?.id,
    Boolean(task && canAccessTriage),
  )
  const hasMatchingIssueDetail = Boolean(
    task && detail?.issue.id === task.id && detail.issue.teamId === task.teamId,
  )
  const customerImpact = hasMatchingIssueDetail ? detail?.customerImpact : undefined
  const matchingDetailIssue = hasMatchingIssueDetail ? detail?.issue : undefined
  const selectedIssue = matchingDetailIssue && task && matchingDetailIssue.revision < task.revision
    ? task
    : matchingDetailIssue
  const currentWorkItemTypeId = selectedIssue?.workItemTypeId ?? task?.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID
  const workItemTypeSelectionIdentity = `${task?.teamId ?? ''}:${task?.id ?? ''}:${selectedIssue?.revision ?? task?.revision ?? 'loading'}`
  const [selectedWorkItemType, setSelectedWorkItemType] = useState({
    identity: workItemTypeSelectionIdentity,
    value: currentWorkItemTypeId,
  })
  const selectedWorkItemTypeId = selectedWorkItemType.identity === workItemTypeSelectionIdentity
    ? selectedWorkItemType.value
    : currentWorkItemTypeId
  const resolvedAssignedProjectId = selectedIssue?.assignedProjectId ?? task?.assignedProjectId ?? ''
  const projectSelectionIdentity = `${task?.teamId ?? ''}:${task?.id ?? ''}:${selectedIssue?.revision ?? task?.revision ?? 'loading'}`
  const [selectedProject, setSelectedProject] = useState({
    identity: projectSelectionIdentity,
    value: resolvedAssignedProjectId,
  })
  const selectedProjectId = selectedProject.identity === projectSelectionIdentity
    ? selectedProject.value
    : resolvedAssignedProjectId
  const typeChangePreviewIdentity = `${workItemTypeSelectionIdentity}:${selectedProjectId}`
  const [typeChangeState, setTypeChangeState] = useState<WorkItemTypeChangeEditorState>({
    acknowledgedLostCustomFieldIds: [],
    identity: typeChangePreviewIdentity,
    isPreviewing: false,
    targetWorkItemTypeId: currentWorkItemTypeId,
  })
  const typeChangeRequestSequenceRef = useRef(0)
  const activeTypeChangeState = typeChangeState.identity === typeChangePreviewIdentity &&
      typeChangeState.targetWorkItemTypeId === selectedWorkItemTypeId
    ? typeChangeState
    : {
        acknowledgedLostCustomFieldIds: [],
        identity: typeChangePreviewIdentity,
        isPreviewing: false,
        targetWorkItemTypeId: selectedWorkItemTypeId,
      }
  const resolvedSchedule = selectedIssue?.schedule ?? task?.schedule
  const scheduleSelectionIdentity = `${task?.teamId ?? ''}:${task?.id ?? ''}:${selectedIssue?.revision ?? task?.revision ?? 'loading'}`
  const [scheduleSelection, setScheduleSelection] = useState<{
    /** Detail revision represented by the selected schedule mode. */
    identity: string
    /** Explicit schedule mode selected in the editor. */
    mode: WorkItemSchedule['mode']
  }>({
    identity: scheduleSelectionIdentity,
    mode: resolvedSchedule?.mode ?? 'unscheduled',
  })
  const selectedScheduleMode = scheduleSelection.identity === scheduleSelectionIdentity
    ? scheduleSelection.mode
    : resolvedSchedule?.mode ?? 'unscheduled'

  if (!task) {
    const statusMessage = isLoading
      ? t('tasks.detail.loading')
      : errorMessage ?? t('tasks.detail.empty')
    return (
      <aside
        className="workbench-detail-pane min-h-0 min-w-0 px-5 py-6 max-[1180px]:border-l-0 max-[1180px]:border-t"
        data-testid="task-detail-pane"
      >
        <p
          className={`rounded-md border border-dashed px-4 py-8 text-center text-sm font-medium ${
            errorMessage && !isLoading
              ? 'border-red-200 bg-red-50 text-red-700'
              : 'border-[var(--workbench-border-strong)] bg-white text-[var(--workbench-muted)]'
          }`}
          tabIndex={errorMessage && !isLoading ? -1 : undefined}
          role={errorMessage && !isLoading ? 'alert' : 'status'}
        >
          {statusMessage}
        </p>
      </aside>
    )
  }

  const currentTask = task
  const issue = selectedIssue
  const resolvedConfiguration = hasMatchingIssueDetail
    ? detail?.resolvedConfiguration?.configuration ?? configuration
    : configuration
  const needsDetailBeforeEdit = !issue
  const isReadOnly = !onUpdateIssue || needsDetailBeforeEdit
  const title = resolveWorkItemTitle(issue ?? task)
  const workItemTypes = resolveWorkItemTypes(resolvedConfiguration)
  const selectedWorkItemTypeDefinition = resolveWorkItemTypeDefinition(
    resolvedConfiguration,
    selectedWorkItemTypeId,
  )
  const detailSectionOrder = selectedWorkItemTypeDefinition?.detailSections ??
    DEFAULT_WORK_ITEM_TYPE.detailSections
  const hasOverviewSection = detailSectionOrder.includes('overview')
  const hasDescriptionSection = detailSectionOrder.includes('description')
  const hasCustomFieldSection = detailSectionOrder.includes('custom-fields')
  const hasWorkflowSection = detailSectionOrder.includes('workflow')
  const selectedTypeCustomFieldDefinitions = resolveWorkItemTypeFormFields(
    resolvedConfiguration,
    selectedWorkItemTypeId,
  )
  const customFieldEditorDefinitions = hasCustomFieldSection
    ? selectedTypeCustomFieldDefinitions
    : selectedTypeCustomFieldDefinitions.filter((definition) => definition.required)
  const selectedTypeWorkflow = resolveWorkItemTypeWorkflow(
    resolvedConfiguration,
    selectedWorkItemTypeId,
  )
  const assigneeUserId = issue?.assigneeUserId ?? task.assigneeUserId ?? ''
  const hasSelectedAssigneeOption = assigneeOptions.some((member) => member.id === assigneeUserId)
  const assigneeLabel = resolveWorkItemAssignee(issue ?? task)
  const schedule = issue?.schedule ?? task.schedule
  const currentWorkflowStatusId = resolveWorkItemWorkflowStatusId(issue ?? task)
  const workflowStatuses = issue
    ? selectedWorkItemTypeId === currentWorkItemTypeId
      ? resolveEditableWorkflowStatuses(issue, resolvedConfiguration)
      : resolveCreateWorkflowStatuses(resolvedConfiguration, selectedWorkItemTypeId)
    : []
  const selectedTypeStatusFallback = workflowStatuses.some((status) => status.id === currentWorkflowStatusId)
    ? currentWorkflowStatusId
    : selectedTypeWorkflow?.initialStatusId ?? workflowStatuses[0]?.id ?? currentWorkflowStatusId
  const typeChangePreview = activeTypeChangeState.preview
  const isWorkItemTypeChangeRequested = selectedWorkItemTypeId !== currentWorkItemTypeId
  const typeChangeFieldDefinitions = resolvedConfiguration?.customFields ?? []
  const typeChangeLostFields = typeChangePreview?.lostCustomFieldIds.map((fieldId) =>
    typeChangeFieldDefinitions.find((definition) => definition.id === fieldId) ?? {
      id: fieldId,
      name: fieldId,
    },
  ) ?? []
  const selectedTypeWorkflowStatusId = activeTypeChangeState.replacementWorkflowStatusId ??
    selectedTypeStatusFallback
  const personOptions = resolveWorkItemPersonOptions(workspaceMembers)
  const hasCustomFields = customFieldEditorDefinitions.some((definition) =>
    isCustomFieldApplicable(definition, selectedProjectId || undefined),
  )
  const relations = hasMatchingIssueDetail ? detail?.relations ?? [] : []
  const canonicalRelationCandidates = relationCandidates.filter((candidate) =>
    candidate.teamId === task.teamId,
  )
  const sourceTriageEntryId = issue?.sourceTriageEntryId ?? task.sourceTriageEntryId
  const triageContextSnapshots = hasMatchingIssueDetail
    ? detail?.triageContextSnapshots ?? []
    : []
  const lastTriageSourcesPage = triageSourcesPages?.at(-1)
  const hasMoreTriageSources = Boolean(lastTriageSourcesPage?.nextCursor)
  const isLoadingMoreTriageSources = Boolean(
    triageSourcesPages && triageSourcesSize > triageSourcesPages.length && isTriageSourcesValidating,
  )
  const reverseTriageSources = triageSourcesPages
    ?.flatMap((page) => page.entries)
    .filter((entry) => entry.id !== sourceTriageEntryId) ?? []
  const editorIdentity = `${task.teamId}:${task.id}:${issue?.revision ?? task.revision}`
  const activeAiFormSeed = aiFormSeed.identity === editorIdentity ? aiFormSeed : undefined
  const activeAiDraft = activeAiFormSeed?.draft
  const seededTitle = activeAiDraft?.title?.value ?? title
  const seededDescription = activeAiDraft?.description?.value ?? issue?.description ?? ''
  const seededPriority = activeAiDraft?.priority?.value ?? issue?.priority ?? task.priority
  // Planned effort belongs to the standalone schedule mutation. Keep the AI estimate
  // in the review rail, but do not copy it into a separate form that can outlive the
  // approved generation's Work Item revision.
  const seededPlannedEffortMinutes = schedule.plannedEffortMinutes
  const seededWorkflowStatusId = activeAiDraft?.status && workflowStatuses.some(
    (status) => status.id === activeAiDraft.status?.value,
  )
    ? activeAiDraft.status.value
    : selectedTypeWorkflowStatusId
  const hasApplicableAiWorkflowStatus = Boolean(
    activeAiDraft?.status && seededWorkflowStatusId === activeAiDraft.status.value,
  )
  const isEditorDirty = editorDirtyState.identity === editorIdentity && editorDirtyState.dirty
  const aiSummarySource = {
    expectedRevision: issue?.revision ?? task.revision,
    teamId: task.teamId,
    type: 'work-item',
    workItemId: task.id,
  } satisfies AiWorkItemSource
  const handleAiPlanningAdopt = (draft: AiPlanningDraft) => {
    applyAiPlanningDraft(draft)
  }
  const handleAiPlanningOperationPendingChange = (pending: boolean) => {
    reportAiPlanningOperationPending(pending)
  }
  const handleAiSummaryOperationPendingChange = (pending: boolean) => {
    reportAiSummaryOperationPending(pending)
  }
  const confirmAiPlanningAdoption = () =>
    shouldConfirmAiPlanningAdoption()
  // The renderer only constructs inert React elements; the supplied callbacks
  // are invoked later by user events inside the feature-owned assistants.
  // eslint-disable-next-line react-hooks/refs -- the renderer returns inert elements and invokes callbacks only from later user events.
  const aiAssistanceSlots = renderAiAssistance?.({
    accessToken,
    aiAssistanceEnabled,
    aiSummaryAssistanceEnabled,
    canAdoptPlanningDraft: (draft) => {
      const hasSupportedField = Boolean(
        draft.title || draft.description || draft.priority || draft.status,
      )
      const hasAvailableStatus = draft.status === undefined || workflowStatuses.some(
        (status) => status.id === draft.status?.value,
      )
      return hasSupportedField && hasAvailableStatus
    },
    isMutationPending: isWorkItemMutationPending,
    locale,
    onAuthenticatedApiError,
    onPlanningAdopt: isReadOnly ? undefined : handleAiPlanningAdopt,
    onPlanningOperationPendingChange: handleAiPlanningOperationPendingChange,
    onSummaryOperationPendingChange: handleAiSummaryOperationPendingChange,
    requirePlanningAdoptionConfirmation: isEditorDirty,
    resolveStatusLabel: (statusId) =>
      workflowStatuses.find((status) => status.id === statusId)?.name ?? statusId,
    resolveWorkItemLabel: (endpoint) => planningSnapshot?.workItems.find(
      (workItem) => workItem.teamId === endpoint.teamId && workItem.id === endpoint.workItemId,
    )?.title ?? `${endpoint.teamId} / ${endpoint.workItemId}`,
    shouldConfirmPlanningAdoption: confirmAiPlanningAdoption,
    source: aiSummarySource,
    t,
  })
  const collaborationAiAssistance = aiSummaryAssistanceEnabled
    ? aiAssistanceSlots?.summary
    : undefined

  /** Copies supported approved fields into a fresh local form seed without saving them. */
  function applyAiPlanningDraft(draft: AiPlanningDraft) {
    if (isIssueSavingRef.current || isAiSummaryOperationPendingRef.current) return
    const nextDirtyState = { dirty: true, identity: editorIdentity }
    editorDirtyStateRef.current = nextDirtyState
    setEditorDirtyState(nextDirtyState)
    setAiFormSeed((current) => ({
      draft,
      identity: editorIdentity,
      revision: current.revision + 1,
    }))
  }

  /** Requests a server-authoritative preview before allowing a Work Item Type mutation. */
  async function requestWorkItemTypePreview(targetWorkItemTypeId: string) {
    typeChangeRequestSequenceRef.current += 1
    const requestSequence = typeChangeRequestSequenceRef.current
    if (!issue || !accessToken || targetWorkItemTypeId === currentWorkItemTypeId) {
      return
    }
    const requestIdentity = typeChangePreviewIdentity
    setTypeChangeState({
      acknowledgedLostCustomFieldIds: [],
      identity: requestIdentity,
      isPreviewing: true,
      targetWorkItemTypeId,
    })
    try {
      const preview = await previewTeamIssueWorkItemType(
        currentTask.teamId,
        currentTask.id,
        accessToken,
        {
          expectedRevision: issue.revision,
          targetWorkItemTypeId,
          assignedProjectId: selectedProjectId || null,
        },
      )
      if (typeChangeRequestSequenceRef.current !== requestSequence) {
        return
      }
      setTypeChangeState({
        acknowledgedLostCustomFieldIds: [],
        identity: requestIdentity,
        isPreviewing: false,
        preview,
        replacementWorkflowStatusId: preview.invalidWorkflowStatusId === undefined
          ? undefined
          : preview.targetInitialWorkflowStatusId,
        targetWorkItemTypeId,
      })
    } catch {
      if (typeChangeRequestSequenceRef.current !== requestSequence) {
        return
      }
      setTypeChangeState({
        acknowledgedLostCustomFieldIds: [],
        errorMessage: t('tasks.detail.typeChange.previewError'),
        identity: requestIdentity,
        isPreviewing: false,
        targetWorkItemTypeId,
      })
    }
  }

  /** Handles a Work Item Type selection from the detail editor. */
  const handleWorkItemTypeChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextWorkItemTypeId = event.target.value
    setSelectedWorkItemType({
      identity: workItemTypeSelectionIdentity,
      value: nextWorkItemTypeId,
    })
    setFieldErrors((current) => ({ ...current, typeChange: undefined }))
    if (nextWorkItemTypeId === currentWorkItemTypeId) {
      typeChangeRequestSequenceRef.current += 1
      setTypeChangeState({
        acknowledgedLostCustomFieldIds: [],
        identity: typeChangePreviewIdentity,
        isPreviewing: false,
        targetWorkItemTypeId: nextWorkItemTypeId,
      })
      return
    }
    void requestWorkItemTypePreview(nextWorkItemTypeId)
  }

  /** Persists one Work Item update while exposing its pending state to AI review controls. */
  async function submitIssueUpdate(input: UpdateTeamIssueInput) {
    if (
      isReadOnly ||
      !task ||
      !task.teamId ||
      !onUpdateIssue ||
      isIssueSavingRef.current ||
      isAiPlanningOperationPendingRef.current ||
      isAiSummaryOperationPendingRef.current
    ) return
    const currentTask = task
    isIssueSavingRef.current = true
    setIsIssueSaving(true)
    try {
      await onUpdateIssue(currentTask.teamId, currentTask.id, input)
    } catch {
      // The owning route supplies the user-visible mutation error.
    } finally {
      isIssueSavingRef.current = false
      setIsIssueSaving(false)
    }
  }

  /** Keeps canonical Work Item save controls disabled while AI planning is pending. */
  function reportAiPlanningOperationPending(pending: boolean) {
    isAiPlanningOperationPendingRef.current = pending
    setIsAiPlanningOperationPending(pending)
    reportCombinedAiOperationPending()
  }

  /** Keeps the task route fenced while the Summary assistant is in flight. */
  function reportAiSummaryOperationPending(pending: boolean) {
    isAiSummaryOperationPendingRef.current = pending
    setIsAiSummaryOperationPending(pending)
    reportCombinedAiOperationPending()
  }

  /** Reports whether any assistant owned by this Work Item is still in flight. */
  function reportCombinedAiOperationPending() {
    onAiOperationPendingChange?.(
      isAiPlanningOperationPendingRef.current ||
        isAiSummaryOperationPendingRef.current,
    )
  }

  /** Rechecks whether the current Work Item editor contains supported manual edits. */
  function shouldConfirmAiPlanningAdoption() {
    return editorDirtyStateRef.current.identity === editorIdentity &&
      editorDirtyStateRef.current.dirty
  }

  /** Submits the visible detail controls through the external editor form. */
  const submitEditorForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (
      isReadOnly ||
      !task.teamId ||
      isIssueSavingRef.current ||
      isAiPlanningOperationPendingRef.current ||
      isAiSummaryOperationPendingRef.current
    ) {
      return
    }

    if (isWorkItemTypeChangeRequested && !typeChangePreview) {
      if (!activeTypeChangeState.isPreviewing) {
        void requestWorkItemTypePreview(selectedWorkItemTypeId)
      }
      return
    }

    const formData = new FormData(event.currentTarget)
    const nextAssignedProjectId = hasOverviewSection
      ? String(formData.get('assignedProjectId') ?? '').trim()
      : selectedProjectId
    const selectedAssigneeUserId = String(formData.get('assigneeUserId') ?? '').trim()
    const formWorkflowStatusId = String(
      formData.get('workflowStatusId') ?? currentWorkflowStatusId,
    ).trim()
    const workflowStatusId = isWorkItemTypeChangeRequested && typeChangePreview?.invalidWorkflowStatusId
      ? String(
          formData.get('typeChangeWorkflowStatusId') ?? selectedTypeWorkflowStatusId,
        ).trim()
      : formWorkflowStatusId
    const parsedCustomFields = resolvedConfiguration
      ? parseCustomFieldFormData(formData, customFieldEditorDefinitions, {
          projectId: nextAssignedProjectId || undefined,
        })
      : { errors: [], values: {} }
    if (parsedCustomFields.errors.length > 0) {
      setFieldErrors(createCustomFieldErrorMessages(
        parsedCustomFields.errors,
        customFieldEditorDefinitions,
        locale,
      ))
      return
    }

    if (isWorkItemTypeChangeRequested && typeChangePreview) {
      const acknowledgedIds = new Set(activeTypeChangeState.acknowledgedLostCustomFieldIds)
      const missingAcknowledgements = typeChangePreview.lostCustomFieldIds.filter((fieldId) =>
        !acknowledgedIds.has(fieldId),
      )
      if (missingAcknowledgements.length > 0) {
        setFieldErrors({
          typeChange: t('tasks.detail.typeChange.acknowledge'),
        })
        return
      }
    }

    setFieldErrors({})
    const customFieldValues = createVisibleCustomFieldValuePatch(
      hasCustomFields,
      customFieldEditorDefinitions,
      issue?.customFieldValues ?? task.customFieldValues,
      parsedCustomFields.values,
      nextAssignedProjectId || undefined,
    )
    const nextIssueInput: UpdateTeamIssueInput = {
      ...(hasOverviewSection
        ? {
            assignedProjectId: nextAssignedProjectId || null,
            priority: resolveTaskPriority(formData.get('priority')),
            title: String(formData.get('title') ?? '').trim(),
          }
        : {}),
      ...((hasWorkflowSection || isWorkItemTypeChangeRequested) ? { workflowStatusId } : {}),
      ...(hasDescriptionSection
        ? { description: String(formData.get('description') ?? '').trim() }
        : {}),
      ...(customFieldValues === undefined ? {} : { customFieldValues }),
    }

    if (isWorkItemTypeChangeRequested && typeChangePreview) {
      nextIssueInput.workItemTypeId = selectedWorkItemTypeId
      nextIssueInput.typeChangeResolution = {
        discardCustomFieldIds: [...activeTypeChangeState.acknowledgedLostCustomFieldIds].sort(),
        ...(typeChangePreview.invalidWorkflowStatusId === undefined
          ? {}
          : { workflowStatusId }),
      }
    }

    if (hasOverviewSection && assigneeOptions.some((member) => member.id === selectedAssigneeUserId)) {
      nextIssueInput.assigneeUserId = selectedAssigneeUserId
    }

    void submitIssueUpdate(nextIssueInput)
  }

  /** Renders the Work Item Type selector and any pending type-change resolution UI. */
  const renderWorkItemTypeControl = (): ReactNode => resolvedConfiguration ? (
    <section className="workbench-panel-muted grid min-w-0 gap-3 p-3" data-testid="task-detail-work-item-type">
      <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
        {t('tasks.create.workItemType')}
        <select
          className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
          disabled={isReadOnly || isWorkItemMutationPending || activeTypeChangeState.isPreviewing}
          form={editorFormId}
          name="workItemTypeId"
          onChange={handleWorkItemTypeChange}
          value={selectedWorkItemTypeId}
        >
          {workItemTypes
            .filter((type) => type.status === 'active' || type.id === currentWorkItemTypeId)
            .map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}{type.status === 'archived' ? ` (${t('tasks.create.archived')})` : ''}
              </option>
            ))}
        </select>
        {selectedWorkItemTypeDefinition?.description ? (
          <span className="text-xs font-medium text-[var(--workbench-muted)]">
            {selectedWorkItemTypeDefinition.description}
          </span>
        ) : null}
      </label>
      {isWorkItemTypeChangeRequested ? (
        <div className="grid gap-2 rounded-md border border-[var(--workbench-border-strong)] bg-white p-3 text-sm" data-testid="task-detail-work-item-type-preview">
          <p className="font-semibold text-[var(--workbench-text)]">
            {t('tasks.detail.typeChange.title')}
          </p>
          {activeTypeChangeState.isPreviewing ? (
            <p className="text-[var(--workbench-muted)]">{t('tasks.detail.typeChange.previewing')}</p>
          ) : typeChangePreview ? (
            <>
              <p className="text-[var(--workbench-muted)]">
                {t('tasks.detail.typeChange.preview')}
              </p>
              {typeChangeLostFields.length > 0 ? (
                <div className="grid gap-2">
                  <p className="font-semibold text-[var(--workbench-text)]">
                    {t('tasks.detail.typeChange.lostFields')}
                  </p>
                  {typeChangeLostFields.map((field) => {
                    const checked = activeTypeChangeState.acknowledgedLostCustomFieldIds.includes(field.id)
                    return (
                      <label className="flex items-start gap-2 font-medium text-[var(--workbench-muted)]" key={field.id}>
                        <input
                          checked={checked}
                          className="mt-0.5"
                          disabled={isReadOnly || isWorkItemMutationPending}
                          form={editorFormId}
                          onChange={(event) => {
                            const nextIds = event.target.checked
                              ? [...activeTypeChangeState.acknowledgedLostCustomFieldIds, field.id]
                              : activeTypeChangeState.acknowledgedLostCustomFieldIds.filter((id) => id !== field.id)
                            setTypeChangeState((current) => ({
                              ...current,
                              acknowledgedLostCustomFieldIds: [...new Set(nextIds)].sort(),
                            }))
                            setFieldErrors((current) => ({ ...current, typeChange: undefined }))
                          }}
                          type="checkbox"
                        />
                        <span>{field.name}</span>
                      </label>
                    )
                  })}
                </div>
              ) : null}
              {typeChangePreview.invalidWorkflowStatusId ? (
                <label className="grid gap-1.5 font-semibold text-[var(--workbench-text)]">
                  {t('tasks.detail.typeChange.invalidStatus')}
                  <select
                    className="workbench-input h-9 px-3"
                    disabled={isReadOnly || isWorkItemMutationPending}
                    form={editorFormId}
                    name="typeChangeWorkflowStatusId"
                    onChange={(event) => setTypeChangeState((current) => ({
                      ...current,
                      replacementWorkflowStatusId: event.target.value,
                    }))}
                    value={selectedTypeWorkflowStatusId}
                  >
                    {resolveCreateWorkflowStatuses(
                      resolvedConfiguration,
                      selectedWorkItemTypeId,
                    ).map((status) => (
                      <option key={status.id} value={status.id}>{status.name}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              {typeChangePreview.missingRequiredCustomFieldIds.length > 0 ? (
                <p className="text-amber-700">
                  {t('tasks.detail.typeChange.missingRequired')}
                </p>
              ) : null}
            </>
          ) : activeTypeChangeState.errorMessage ? (
            <p className="text-red-700" role="alert">{activeTypeChangeState.errorMessage}</p>
          ) : null}
          {fieldErrors.typeChange ? (
            <p className="font-semibold text-red-700" role="alert">{fieldErrors.typeChange}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  ) : null

  /** Renders one configured Work Item detail section in its persisted order. */
  const renderDetailSection = (section: WorkItemDetailSectionId): ReactNode => {
    switch (section) {
      case 'overview':
        return (
          <fieldset
            className="contents"
            disabled={isReadOnly || isWorkItemMutationPending}
          >
            <section className="grid min-w-0 gap-3" data-testid="task-detail-overview">
              {renderWorkItemTypeControl()}
              <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
                {t('issues.column.title')}
                <input
                  className="workbench-input w-full min-w-0 px-3 py-2 text-base font-semibold disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                  defaultValue={seededTitle}
                  form={editorFormId}
                  key={`title:${editorIdentity}:${activeAiDraft?.title ? activeAiFormSeed?.revision ?? 0 : 0}`}
                  name="title"
                  required
                />
              </label>
              <div className="workbench-panel-muted grid grid-cols-1 gap-3 p-3">
                <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
                  {t('issues.create.project')}
                  <select
                    className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                    form={editorFormId}
                    name="assignedProjectId"
                    onChange={(event) => setSelectedProject({
                      identity: projectSelectionIdentity,
                      value: event.target.value,
                    })}
                    value={selectedProjectId}
                  >
                    <option value="">{t('issues.project.unassigned')}</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>{project.name}</option>
                    ))}
                  </select>
                </label>
                <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
                  {t('issues.create.assignee')}
                  <select
                    className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                    defaultValue={assigneeUserId}
                    form={editorFormId}
                    key={`assignee:${editorIdentity}`}
                    name="assigneeUserId"
                  >
                    {!hasSelectedAssigneeOption && assigneeUserId ? (
                      <option value={assigneeUserId}>{assigneeLabel}</option>
                    ) : null}
                    {assigneeOptions.map((member) => (
                      <option key={member.id} value={member.id}>{formatProjectMemberOption(member)}</option>
                    ))}
                  </select>
                </label>
                <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
                  {t('tasks.column.priority')}
                  <select
                    className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                    defaultValue={seededPriority}
                    form={editorFormId}
                    key={`priority:${editorIdentity}:${activeAiDraft?.priority ? activeAiFormSeed?.revision ?? 0 : 0}`}
                    name="priority"
                  >
                    {taskPriorities.map((priority) => (
                      <option key={priority} value={priority}>{t(`tasks.priority.${priority}`)}</option>
                    ))}
                  </select>
                </label>
              </div>
              {customerImpact ? <CustomerImpactPanel signal={customerImpact} t={t} /> : null}
            </section>
          </fieldset>
        )
      case 'description':
        return (
          <fieldset
            className="contents"
            disabled={isReadOnly || isWorkItemMutationPending}
          >
            <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('tasks.detail.description')}
              <textarea
                className="workbench-input min-h-24 w-full min-w-0 px-3 py-2 leading-6 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                defaultValue={seededDescription}
                form={editorFormId}
                key={`description:${editorIdentity}:${activeAiDraft?.description ? activeAiFormSeed?.revision ?? 0 : 0}`}
                name="description"
              />
            </label>
          </fieldset>
        )
      case 'custom-fields':
        return hasCustomFields ? (
          <fieldset
            className="contents"
            disabled={isReadOnly || isWorkItemMutationPending}
          >
            <div className="workbench-panel-muted p-4">
              <WorkItemFieldsEditor
                definitions={customFieldEditorDefinitions}
                errors={fieldErrors}
                formId={editorFormId}
                locale={locale}
                personOptions={personOptions}
                projectId={selectedProjectId || undefined}
                values={issue?.customFieldValues ?? task.customFieldValues}
                key={editorIdentity}
              />
            </div>
          </fieldset>
        ) : null
      case 'workflow':
        return (
          <fieldset
            className="contents"
            disabled={isReadOnly || isWorkItemMutationPending}
          >
            <div className="workbench-panel-muted grid grid-cols-1 gap-3 p-3">
              <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
                {t('tasks.column.status')}
                <select
                  className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                  defaultValue={seededWorkflowStatusId}
                  form={editorFormId}
                  key={`status:${editorIdentity}:${selectedWorkItemTypeId}:${hasApplicableAiWorkflowStatus ? activeAiFormSeed?.revision ?? 0 : 0}`}
                  name="workflowStatusId"
                >
                  {workflowStatuses.map((status) => (
                    <option key={status.id} value={status.id}>{status.name}</option>
                  ))}
                </select>
              </label>
            </div>
          </fieldset>
        )
      case 'schedule':
        return (
          <fieldset
            className="contents"
            disabled={isReadOnly || isWorkItemMutationPending}
          >
            <div className="workbench-panel-muted grid grid-cols-1 gap-3 p-3">
              <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
                {t('tasks.schedule.mode')}
                <select
                  className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                  form={scheduleFormId}
                  name="scheduleMode"
                  onChange={(event) => setScheduleSelection({
                    identity: scheduleSelectionIdentity,
                    mode: readDetailScheduleMode(event.currentTarget.value),
                  })}
                  value={selectedScheduleMode}
                >
                  <option value="unscheduled">{t('tasks.schedule.unscheduled')}</option>
                  <option value="due-date">{t('tasks.schedule.dueDate')}</option>
                  <option value="date-range">{t('tasks.schedule.dateRange')}</option>
                  <option value="milestone">{t('tasks.schedule.milestone')}</option>
                </select>
              </label>
              {selectedScheduleMode === 'due-date' ? (
                <DetailScheduleDateInput
                  defaultValue={resolveTaskScheduleEndDate(schedule) ?? ''}
                  formId={scheduleFormId}
                  key={`schedule-due-date:${editorIdentity}`}
                  label={t('tasks.schedule.dueDate')}
                  name="scheduleDueDate"
                />
              ) : null}
              {selectedScheduleMode === 'date-range' ? (
                <>
                  <DetailScheduleDateInput
                    defaultValue={resolveTaskScheduleStartDate(schedule) ?? ''}
                    formId={scheduleFormId}
                    key={`schedule-start-date:${editorIdentity}`}
                    label={t('tasks.schedule.startDate')}
                    name="scheduleStartDate"
                  />
                  <DetailScheduleDateInput
                    defaultValue={resolveTaskScheduleEndDate(schedule) ?? ''}
                    formId={scheduleFormId}
                    key={`schedule-end-date:${editorIdentity}`}
                    label={t('tasks.schedule.endDate')}
                    name="scheduleEndDate"
                  />
                </>
              ) : null}
              {selectedScheduleMode === 'milestone' ? (
                <DetailScheduleDateInput
                  defaultValue={resolveTaskScheduleStartDate(schedule) ?? ''}
                  formId={scheduleFormId}
                  key={`schedule-milestone-date:${editorIdentity}`}
                  label={t('tasks.schedule.milestoneDate')}
                  name="scheduleMilestoneDate"
                />
              ) : null}
              <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
                {t('tasks.schedule.effortMinutes')}
                <input
                  className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                  defaultValue={seededPlannedEffortMinutes}
                  form={scheduleFormId}
                  key={`effort:${editorIdentity}`}
                  min="0"
                  name="scheduleEffortMinutes"
                  type="number"
                />
              </label>
              <p className="text-xs font-medium text-[var(--workbench-muted)]">
                {schedule.calendarPolicy.timeZone} · {schedule.calendarPolicy.workingWeekdays.join(', ')}
                {schedule.calendarPolicy.holidays.length > 0
                  ? ` · ${schedule.calendarPolicy.holidays.join(', ')}`
                  : ''}
              </p>
              {fieldErrors.schedule ? (
                <p className="text-sm font-semibold text-red-700" role="alert">
                  {fieldErrors.schedule}
                </p>
              ) : null}
              <button
                className="workbench-button-secondary min-h-[44px] px-3 disabled:border-slate-300 disabled:bg-slate-300"
                disabled={isReadOnly || isWorkItemMutationPending}
                form={scheduleFormId}
                type="submit"
              >
                {t('tasks.schedule.save')}
              </button>
            </div>
          </fieldset>
        )
      case 'relations':
        return (
          <>
            <div className="border-b border-[var(--workbench-border)] bg-white px-5 py-5">
              <WorkItemRelationsEditor
                candidates={canonicalRelationCandidates.map((candidate) => ({
                  id: candidate.id,
                  title: resolveTeamIssueTitle(candidate),
                }))}
                currentWorkItemId={task.id}
                errorMessage={relationCandidatesErrorMessage}
                isLoading={isRelationCandidatesLoading || (isLoading && !issue)}
                locale={locale}
                onAddRelation={onAddRelation
                  && !isWorkItemMutationPending
                  ? (input) => onAddRelation(task.id, input)
                  : undefined}
                onDeleteRelation={onDeleteRelation
                  && !isWorkItemMutationPending
                  ? (relation) => onDeleteRelation(task.id, relation)
                  : undefined}
                readOnly={isReadOnly || isWorkItemMutationPending || (!onAddRelation && !onDeleteRelation)}
                relations={relations}
              />
            </div>
            <div className="border-b border-[var(--workbench-border)] bg-white px-5 py-5">
              <WorkItemDependencyPanel
                canManageEndpoint={canManageScheduleDependencyEndpoint}
                currentEndpoint={{ teamId: task.teamId, workItemId: task.id }}
                onCreate={isWorkItemMutationPending ? undefined : onCreateScheduleDependency}
                onDelete={isWorkItemMutationPending ? undefined : onDeleteScheduleDependency}
                onUpdate={isWorkItemMutationPending ? undefined : onUpdateScheduleDependency}
                snapshot={planningSnapshot}
                t={t}
              />
            </div>
          </>
        )
      case 'files':
        return (
          <>
            {artifacts ? (
              <IssueArtifactsPanel
                completionTransitions={workflowStatuses.filter(
                  (status) => status.id !== currentWorkflowStatusId,
                )}
                controller={artifacts}
                currentMemberKey={currentWorkspaceMemberKey}
                locale={locale}
                members={workspaceMembers}
              />
            ) : null}
            <RelatedDocuments
              accessToken={accessToken}
              onPromoteToContext={documentContextPromotion.onPromoteToContext}
              t={t}
              targetId={task.teamId ? `team/${task.teamId}/issue/${task.id}` : undefined}
              targetKind="work-item"
            />
          </>
        )
      case 'activity':
        return collaboration ? (
          <IssueCollaborationPanel
            aiAssistance={collaborationAiAssistance}
            route={collaborationRoute}
            artifacts={artifacts}
            contextDraft={documentContextPromotion.documentContextDraft}
            key={`${task.teamId ?? ''}:${task.id}`}
            controller={collaboration}
            currentMemberKey={currentWorkspaceMemberKey}
            focusedCommentId={focusedCommentId}
            focusedRootCommentId={focusedRootCommentId}
            locale={locale}
            members={workspaceMembers}
            onAiSummaryOperationPendingChange={reportAiSummaryOperationPending}
            onContextDraftConsumed={documentContextPromotion.onContextDraftConsumed}
          />
        ) : null
      default:
        return null
    }
  }

  return (
    <aside
      className="workbench-detail-pane min-h-0 min-w-0 max-[1180px]:border-l-0 max-[1180px]:border-t"
      data-testid="task-detail-pane"
    >
      <form
        aria-hidden="true"
        className="hidden"
        id={editorFormId}
        onSubmit={submitEditorForm}
      />
      <div
        className="grid min-w-0 gap-4 border-b border-[var(--workbench-border)] bg-white px-5 py-4"
        onChange={() => {
          const nextDirtyState = { dirty: true, identity: editorIdentity }
          editorDirtyStateRef.current = nextDirtyState
          setEditorDirtyState(nextDirtyState)
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="workbench-eyebrow text-[var(--workbench-muted)]">
              {t('tasks.detail.title')}
            </p>
            <h2
              className="mt-1.5 text-lg font-semibold leading-6 text-[var(--workbench-text)]"
              tabIndex={-1}
            >
              {title}
            </h2>
            {isLoading ? (
              <p className="mt-2 text-sm font-medium text-[var(--workbench-muted)]">{t('tasks.detail.loading')}</p>
            ) : null}
            {canAccessTriage && sourceTriageEntryId ? (
              <a
                className="mt-2 inline-flex text-sm font-semibold text-[var(--workbench-primary)] underline-offset-4 hover:underline"
                data-testid="task-detail-triage-source"
                href={isWorkItemMutationPending ? undefined : createTeamTriagePath(task.teamId, sourceTriageEntryId)}
                aria-disabled={isWorkItemMutationPending || undefined}
                tabIndex={isWorkItemMutationPending ? -1 : undefined}
              >
                {t('tasks.detail.openTriageSource')}
              </a>
            ) : null}
            {reverseTriageSources.length > 0 || triageSourcesError ? (
              <section
                className="mt-3 rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 py-2.5"
                data-testid="task-detail-triage-sources"
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--workbench-muted)]">
                  {t('tasks.detail.triageSources.title')}
                </p>
                <ul className="mt-2 grid gap-2">
                  {reverseTriageSources.map((entry) => (
                    <li key={entry.id}>
                      <a
                        className="text-xs font-semibold text-[var(--workbench-primary)] underline-offset-4 hover:underline"
                        href={isWorkItemMutationPending ? undefined : createTeamTriagePath(task.teamId, entry.id)}
                        aria-disabled={isWorkItemMutationPending || undefined}
                        tabIndex={isWorkItemMutationPending ? -1 : undefined}
                      >
                        {entry.sourcePreview.title || t(resolveTriageSourceMessageKey(entry.source.kind))}
                      </a>
                    </li>
                  ))}
                </ul>
                {triageSourcesError ? (
                  <p className="mt-2 text-xs text-red-700" role="alert">
                    {t('tasks.detail.triageSources.error')}
                  </p>
                ) : null}
                {hasMoreTriageSources ? (
                  <button
                    className="workbench-button-secondary mt-3 min-h-9 px-3 text-xs"
                    disabled={isLoadingMoreTriageSources}
                    onClick={() => void setTriageSourcesSize(triageSourcesSize + 1)}
                    type="button"
                  >
                    {isLoadingMoreTriageSources
                      ? t('tasks.detail.triageSources.loadingMore')
                      : t('tasks.detail.triageSources.loadMore')}
                  </button>
                ) : null}
              </section>
            ) : null}
            {canAccessTriage && triageContextSnapshots.length > 0 ? (
              <section
                className="mt-3 rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 py-2.5"
                data-testid="task-detail-triage-context"
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--workbench-muted)]">
                  {t('tasks.detail.triageContext.title')}
                </p>
                <ul className="mt-2 grid gap-2">
                  {triageContextSnapshots.map((snapshot) => (
                    <li className="text-xs leading-5 text-[var(--workbench-muted)]" key={snapshot.triageEntryId}>
                      <a
                        className="font-semibold text-[var(--workbench-primary)] underline-offset-4 hover:underline"
                        href={isWorkItemMutationPending ? undefined : createTeamTriagePath(task.teamId, snapshot.triageEntryId)}
                        aria-disabled={isWorkItemMutationPending || undefined}
                        tabIndex={isWorkItemMutationPending ? -1 : undefined}
                      >
                        {t(resolveTriageSourceMessageKey(snapshot.sourceKind))}
                      </a>
                      <span>
                        {' · '}
                        {t('tasks.detail.triageContext.counts')
                          .replace('{comments}', String(snapshot.commentMetadataCount))
                          .replace('{attachments}', String(snapshot.attachmentMetadataCount))
                          .replace('{watchers}', String(snapshot.watcherMetadataCount))}
                      </span>
                      <span className="block">
                        {t(resolveTriageContextAvailabilityMessageKey(snapshot.availability))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <span className="workbench-badge" data-work-item-type-id={currentWorkItemTypeId}>
            <WorkItemTypeIcon
              className="h-3.5 w-3.5"
              iconToken={resolveWorkItemTypeDefinition(
                resolvedConfiguration,
                currentWorkItemTypeId,
              )?.iconToken ?? 'work-item'}
            />
              {resolveWorkItemTypeLabel(issue ?? task, resolvedConfiguration)}
            </span>
            <TaskPriorityBadge priority={issue?.priority ?? task.priority} t={t} />
            {onClose ? (
              <button
                aria-label={t('tasks.detail.close')}
                className="rounded px-2 py-1 text-lg leading-none text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-text)]"
                data-testid="task-detail-close"
                disabled={isWorkItemMutationPending}
                onClick={onClose}
                type="button"
              >
                ×
              </button>
            ) : null}
          </div>
        </div>
        {aiAssistanceEnabled ? aiAssistanceSlots?.planning ?? null : null}
        {!hasOverviewSection ? renderWorkItemTypeControl() : null}
        {detailSectionOrder.map((section) => (
          <Fragment key={section}>{renderDetailSection(section)}</Fragment>
        ))}
        {!hasCustomFieldSection && hasCustomFields ? (
          <fieldset
            className="contents"
            disabled={isReadOnly || isWorkItemMutationPending}
          >
            <div className="workbench-panel-muted p-4" data-testid="task-detail-required-work-item-fields">
              <WorkItemFieldsEditor
                definitions={customFieldEditorDefinitions}
                errors={fieldErrors}
                formId={editorFormId}
                locale={locale}
                personOptions={personOptions}
                projectId={selectedProjectId || undefined}
                values={issue?.customFieldValues ?? task.customFieldValues}
                key={`${editorIdentity}:required`}
              />
            </div>
          </fieldset>
        ) : null}
        <button
          className="workbench-button-primary min-h-[44px] px-4 disabled:border-slate-300 disabled:bg-slate-300"
          form={editorFormId}
          disabled={isReadOnly || isWorkItemMutationPending}
          type="submit"
        >
          {t('issues.detail.save')}
        </button>
        {isReadOnly && !needsDetailBeforeEdit ? (
          <p className="text-sm font-medium text-[var(--workbench-muted)]">
            {t(!onUpdateIssue ? 'tasks.detail.readOnlyPermission' : 'tasks.detail.readOnly')}
          </p>
        ) : null}
        {errorMessage ? (
          <p className="text-sm font-semibold text-red-700" role="alert" tabIndex={-1}>{errorMessage}</p>
        ) : null}
      </div>
      <form
        aria-label={t('tasks.schedule.title')}
        className="hidden"
        id={scheduleFormId}
        onSubmit={(event) => {
          event.preventDefault()
          if (
            isReadOnly ||
            !task.teamId ||
            isIssueSavingRef.current ||
            isAiPlanningOperationPendingRef.current
          ) return
          const nextSchedule = createDetailSchedule(new FormData(event.currentTarget), schedule)
          if (!nextSchedule) {
            setFieldErrors((current) => ({
              ...current,
              schedule: t('tasks.schedule.invalid'),
            }))
            return
          }
          setFieldErrors((current) => ({ ...current, schedule: undefined }))
          if (areTaskSchedulesEqual(schedule, nextSchedule)) {
            onScheduleNoChange?.(task.teamId, task.id)
            return
          }
          void submitIssueUpdate({ schedule: nextSchedule })
        }}
      />
    </aside>
  )
}

/** Props for a schedule date field in the detail editor. */
type DetailScheduleDateInputProps = {
  /** Current ISO date shown by the input. */
  defaultValue: string
  /** Identifier of the standalone schedule form that owns this control. */
  formId: string
  /** Visible and accessible input label. */
  label: string
  /** Form field name used to construct the schedule patch. */
  name: string
}

/**
 * Renders one required native date input for the selected schedule mode.
 *
 * @param props - Current value, label, and form name.
 * @returns A labeled schedule date input.
 */
function DetailScheduleDateInput({
  defaultValue,
  formId,
  label,
  name,
}: DetailScheduleDateInputProps) {
  return (
    <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
      {label}
      <input
        className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
        defaultValue={defaultValue}
        form={formId}
        name={name}
        required
        type="date"
      />
    </label>
  )
}

/**
 * Builds a complete replacement schedule while retaining its persisted calendar policy.
 *
 * @param formData - Submitted detail fields.
 * @param currentSchedule - Current canonical schedule and calendar policy.
 * @returns A replacement schedule, or undefined when its dates or effort are invalid.
 */
function createDetailSchedule(
  formData: FormData,
  currentSchedule: WorkItemSchedule,
): WorkItemSchedule | undefined {
  const mode = readDetailScheduleMode(String(formData.get('scheduleMode') ?? 'unscheduled'))
  const plannedEffortMinutes = readDetailPlannedEffort(
    formData.get('scheduleEffortMinutes'),
  )
  if (plannedEffortMinutes === null) {
    return undefined
  }
  const calendarPolicy = cloneScheduleCalendarPolicy(currentSchedule.calendarPolicy)

  try {
    if (mode === 'unscheduled') {
      return {
        ...createDefaultUnscheduledTaskSchedule(plannedEffortMinutes),
        calendarPolicy,
      }
    }
    if (mode === 'due-date') {
      return {
        ...createDefaultDueDateTaskSchedule(
          String(formData.get('scheduleDueDate') ?? ''),
          plannedEffortMinutes,
        ),
        calendarPolicy,
      }
    }
    if (mode === 'milestone') {
      return {
        ...createDefaultMilestoneTaskSchedule(
          String(formData.get('scheduleMilestoneDate') ?? ''),
          plannedEffortMinutes,
        ),
        calendarPolicy,
      }
    }

    const draft = createDefaultDateRangeTaskSchedule(
      String(formData.get('scheduleStartDate') ?? ''),
      String(formData.get('scheduleEndDate') ?? ''),
      plannedEffortMinutes,
    )
    const durationDays = countTaskSchedulePolicyWorkingDays(
      draft.startDate,
      draft.endDate,
      calendarPolicy,
    )
    return durationDays > 0
      ? { ...draft, calendarPolicy, durationDays }
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Narrows an editor value to one explicit schedule mode.
 *
 * @param value - Candidate select value.
 * @returns A supported mode, defaulting unknown values to unscheduled.
 */
function readDetailScheduleMode(value: string): WorkItemSchedule['mode'] {
  if (value === 'due-date' || value === 'date-range' || value === 'milestone') {
    return value
  }
  return 'unscheduled'
}

/**
 * Reads optional nonnegative planned effort.
 *
 * @param value - Submitted effort field.
 * @returns Integer minutes, undefined for an empty field, or null when invalid.
 */
function readDetailPlannedEffort(value: FormDataEntryValue | null): number | undefined | null {
  const text = String(value ?? '').trim()
  if (!text) {
    return undefined
  }
  const minutes = Number(text)
  return Number.isSafeInteger(minutes) && minutes >= 0 ? minutes : null
}

/**
 * Detaches a schedule calendar policy before it is placed in a mutation payload.
 *
 * @param policy - Persisted calendar policy.
 * @returns A detached policy with copied weekday and holiday arrays.
 */
function cloneScheduleCalendarPolicy(
  policy: WorkItemScheduleCalendarPolicy,
): WorkItemScheduleCalendarPolicy {
  return {
    holidays: [...policy.holidays],
    timeZone: policy.timeZone,
    workingWeekdays: [...policy.workingWeekdays],
  }
}

/** Formats a project member for an assignee select option. */
function formatProjectMemberOption(member: ProjectMember) {
  return `${member.name ?? member.email} / ${member.email}`
}

/**
 * Resolves one provider-neutral Triage source kind to an existing localized label.
 *
 * @param sourceKind - Source channel retained by the duplicate-context snapshot.
 * @returns The message key for the source label.
 */
function resolveTriageSourceMessageKey(
  sourceKind: 'form' | 'chat' | 'email' | 'webhook' | 'manual-handoff',
): MessageKey {
  if (sourceKind === 'manual-handoff') return 'triage.source.manualHandoff'
  return `triage.source.${sourceKind}`
}

/**
 * Resolves retained-context disclosure level to a concise localized explanation.
 *
 * @param availability - Permission-safe context level committed during the merge.
 * @returns The matching Work Item detail message key.
 */
function resolveTriageContextAvailabilityMessageKey(
  availability: 'summary-metadata' | 'counts-only' | 'restricted' | 'redacted',
): MessageKey {
  if (availability === 'summary-metadata') {
    return 'tasks.detail.triageContext.availability.summaryMetadata'
  }
  if (availability === 'counts-only') {
    return 'tasks.detail.triageContext.availability.countsOnly'
  }
  if (availability === 'restricted') {
    return 'tasks.detail.triageContext.availability.restricted'
  }
  return 'tasks.detail.triageContext.availability.redacted'
}

/** Resolves a Team Issue title for relation candidate display. */
function resolveTeamIssueTitle(issue: TeamIssue) {
  return resolveWorkItemTitle(issue)
}
