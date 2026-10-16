import type {
  AiWorkItemSource,
  PlanningSnapshot,
  WorkItemConfiguration,
  WorkItemDetailSectionId,
  WorkItemRelation,
} from '@mukuroji/contracts'
import { DEFAULT_WORK_ITEM_TYPE_ID, DEFAULT_WORK_ITEM_TYPE } from '@mukuroji/contracts'
import {
  Fragment,
  type FormEvent,
  useCallback,
  useRef,
  useState,
  useId,
  type ChangeEvent,
  type ReactNode,
} from 'react'
import { createAiAssistantSessionKey } from '../../features/ai-assistance/model/assistantSessionKey'
import { AiSummaryAssistant } from '../../features/ai-assistance/ui/AiSummaryAssistant'
import { IssueArtifactsPanel } from '../../files/ui/IssueArtifactsPanel'
import { type FileArtifactsController } from '../../files/mutations/useFileArtifacts'
import { type Locale, type MessageKey } from '../../shared/i18n/i18n'
import { previewTeamIssueWorkItemType, type TeamIssue, type UpdateTeamIssueInput } from '../api'
import { IssueCollaborationPanel, type IssueSummaryAiAssistance } from './IssueCollaborationPanel'
import { type IssueCollaborationController } from '../mutations/useIssueCollaboration'
import { useDocumentContextPromotion } from '../mutations/useDocumentContextPromotion'
import { type IssueCollaborationRoute } from '../model/collaborationTabs'
import { type ProjectDirectoryTeam, type ProjectMember } from '../../projects/api'
import type { WorkspaceMember } from '../../workspace/api'
import { WorkItemExternalLinksPanelContainer } from '../../work-items/ui/WorkItemExternalLinksPanel'
import {
  isCustomFieldApplicable,
  parseCustomFieldFormData,
} from '../../work-items/model/customFields'
import { WorkItemFieldsEditor } from '../../work-items/ui/WorkItemFieldsEditor'
import { WorkItemDependencyPanel } from '../../work-items/ui/WorkItemDependencyPanel'
import {
  WorkItemRelationsEditor,
  type WorkItemRelationEditorInput,
} from '../../work-items/ui/WorkItemRelationsEditor'
import {
  createCustomFieldErrorMessages,
  createVisibleCustomFieldValuePatch,
  resolveCreateWorkflowStatuses,
  resolveEditableWorkflowStatuses,
  resolveWorkItemAssignee,
  resolveWorkItemContributorOptions,
  resolveWorkItemPersonOptions,
  resolveWorkItemTypeDefinition,
  resolveWorkItemTypeFormFields,
  resolveWorkItemTypes,
  resolveWorkItemTypeWorkflow,
  resolveWorkItemWorkflowStatusId,
} from '../../work-items/model/workItemDisplay'
import { RelatedDocuments } from '../../documents/ui/RelatedDocuments'
import { createTaskViewItemKey } from '../../task-views/model/taskViewSelection'
import {
  describeTeamIssueSchedule,
  formatProjectMemberOption,
  issuePriorities,
  resolveIssuePriority,
  resolveIssueTitle,
} from '../model/teamIssueDisplay'
import { IssuePriorityBadge } from './TeamIssueBadges'
import { readContributorDraftSubmission } from '../../work-items/model/contributorAssignments'
import {
  WorkItemContributorsEditor,
} from '../../work-items/ui/WorkItemContributorsEditor'
import { useContributorDraft } from '../../work-items/ui/useContributorDraft'
import {
  type CanManageWorkItemDependencyEndpoint,
  type TeamIssueScreenProps,
  type TeamIssueTypeChangeState,
} from './teamIssueScreenShared'

/**
 * Renders the detail pane for the selected Team Work Item.
 *
 * @param props - Detail pane props.
 * @returns The detail pane.
 */
export function IssueDetailPane({
  aiAssistanceEnabled = true,
  accessToken,
  assigneeOptions,
  artifacts,
  canAssignUnassigned,
  canManageDependencyEndpoint,
  canManageExternalLinks,
  collaboration,
  collaborationRoute,
  configuration,
  currentWorkspaceMemberKey,
  detailErrorMessage,
  externalLinksAccessToken,
  focusedCommentId,
  focusedRootCommentId,
  issue,
  isAiSummaryOperationPending,
  isRelationsLoading,
  locale,
  onAddRelation,
  onAuthenticatedApiError,
  onAiSummaryOperationPendingChange,
  onCommentDraftDirtyChange,
  onCreateScheduleDependency,
  onDeleteRelation,
  onDeleteScheduleDependency,
  onUpdateIssue,
  onUpdateScheduleDependency,
  planningSnapshot,
  projects,
  relationCandidates,
  relations,
  t,
  workspaceMembers,
}: {
  /** Whether the saved Workspace AI policy permits the Summary workflow. */
  aiAssistanceEnabled?: boolean
  accessToken?: string
  assigneeOptions: ProjectMember[]
  artifacts?: FileArtifactsController
  /** Whether the current viewer may move this Work Item out of a Project. */
  canAssignUnassigned: boolean
  /** Determines whether the current user may manage one canonical dependency endpoint. */
  canManageDependencyEndpoint?: CanManageWorkItemDependencyEndpoint
  canManageExternalLinks: boolean
  collaboration?: IssueCollaborationController
  collaborationRoute?: IssueCollaborationRoute
  configuration?: WorkItemConfiguration
  currentWorkspaceMemberKey?: string
  detailErrorMessage?: string
  externalLinksAccessToken?: string
  focusedCommentId?: string
  focusedRootCommentId?: string
  issue?: TeamIssue
  /** Whether the mounted Brief assistant currently fences Team Issue navigation. */
  isAiSummaryOperationPending: boolean
  isRelationsLoading: boolean
  locale: Locale
  onAddRelation?: (issueId: string, input: WorkItemRelationEditorInput) => Promise<void>
  /** Reports an authenticated AI API failure to the route-level session guard. */
  onAuthenticatedApiError?: (error: unknown) => void
  /** Reports the keyed Brief operation state to the Team Issue screen. */
  onAiSummaryOperationPendingChange?: (issueKey: string, pending: boolean) => void
  /** Reports retained comment composer input to the Team Issue navigation guard. */
  onCommentDraftDirtyChange?: (isDirty: boolean, issueId?: string) => void
  /** Creates a canonical schedule dependency. */
  onCreateScheduleDependency?: TeamIssueScreenProps['onCreateScheduleDependency']
  onDeleteRelation?: (issueId: string, relation: WorkItemRelation) => Promise<void>
  /** Deletes a canonical schedule dependency. */
  onDeleteScheduleDependency?: TeamIssueScreenProps['onDeleteScheduleDependency']
  onUpdateIssue?: (issueId: string, input: UpdateTeamIssueInput) => Promise<void>
  /** Updates a canonical schedule dependency. */
  onUpdateScheduleDependency?: TeamIssueScreenProps['onUpdateScheduleDependency']
  /** Authoritative canonical dependency graph. */
  planningSnapshot?: PlanningSnapshot
  projects: ProjectDirectoryTeam['projects']
  relationCandidates: TeamIssue[]
  relations: readonly WorkItemRelation[]
  t: (key: MessageKey) => string
  workspaceMembers: WorkspaceMember[]
}) {
  if (!issue) {
    return (
      <aside className="workbench-detail-pane min-h-0 min-w-0 px-6 py-7 max-[1080px]:border-l-0 max-[1080px]:border-t">
        <p className="text-sm font-medium text-[var(--workbench-muted)]">{t('issues.detail.empty')}</p>
      </aside>
    )
  }

  return (
    <IssueDetailContent
      aiAssistanceEnabled={aiAssistanceEnabled}
      accessToken={accessToken}
      assigneeOptions={assigneeOptions}
      artifacts={artifacts}
      canAssignUnassigned={canAssignUnassigned}
      canManageDependencyEndpoint={canManageDependencyEndpoint}
      canManageExternalLinks={canManageExternalLinks}
      collaboration={collaboration}
      collaborationRoute={collaborationRoute}
      configuration={configuration}
      currentWorkspaceMemberKey={currentWorkspaceMemberKey}
      detailErrorMessage={detailErrorMessage}
      externalLinksAccessToken={externalLinksAccessToken}
      focusedCommentId={focusedCommentId}
      focusedRootCommentId={focusedRootCommentId}
      issue={issue}
      isAiSummaryOperationPending={isAiSummaryOperationPending}
      isRelationsLoading={isRelationsLoading}
      key={issue.id}
      locale={locale}
      onAddRelation={onAddRelation}
      onAuthenticatedApiError={onAuthenticatedApiError}
      onAiSummaryOperationPendingChange={onAiSummaryOperationPendingChange}
      onCommentDraftDirtyChange={onCommentDraftDirtyChange}
      onCreateScheduleDependency={onCreateScheduleDependency}
      onDeleteRelation={onDeleteRelation}
      onDeleteScheduleDependency={onDeleteScheduleDependency}
      onUpdateIssue={onUpdateIssue}
      onUpdateScheduleDependency={onUpdateScheduleDependency}
      planningSnapshot={planningSnapshot}
      projects={projects}
      relationCandidates={relationCandidates}
      relations={relations}
      t={t}
      workspaceMembers={workspaceMembers}
    />
  )
}

function IssueDetailContent({
  aiAssistanceEnabled = true,
  accessToken,
  assigneeOptions,
  artifacts,
  canAssignUnassigned,
  canManageDependencyEndpoint,
  canManageExternalLinks,
  collaboration,
  collaborationRoute,
  configuration,
  currentWorkspaceMemberKey,
  detailErrorMessage,
  externalLinksAccessToken,
  focusedCommentId,
  focusedRootCommentId,
  issue,
  isAiSummaryOperationPending,
  isRelationsLoading,
  locale,
  onAddRelation,
  onAuthenticatedApiError,
  onAiSummaryOperationPendingChange,
  onCommentDraftDirtyChange,
  onCreateScheduleDependency,
  onDeleteRelation,
  onDeleteScheduleDependency,
  onUpdateIssue,
  onUpdateScheduleDependency,
  planningSnapshot,
  projects,
  relationCandidates,
  relations,
  t,
  workspaceMembers,
}: {
  /** Whether the saved Workspace AI policy permits the Summary workflow. */
  aiAssistanceEnabled?: boolean
  /** Related Documents を取得する access token です。 */
  accessToken?: string
  /** 担当者 selector の候補です。 */
  assigneeOptions: ProjectMember[]
  /** 選択中 Issue の file/version/annotation/approval controller です。 */
  artifacts?: FileArtifactsController
  /** Whether the current viewer may move this Work Item out of a Project. */
  canAssignUnassigned: boolean
  /** Determines whether the current user may manage one canonical dependency endpoint. */
  canManageDependencyEndpoint?: CanManageWorkItemDependencyEndpoint
  /** External link の作成、更新、解除が許可されているかどうかです。 */
  canManageExternalLinks: boolean
  /** 選択中 Issue の discussion controller です。 */
  collaboration?: IssueCollaborationController
  /** Collaboration section selected by route state. */
  collaborationRoute?: IssueCollaborationRoute
  /** 選択中 Issue に適用する configuration です。 */
  configuration?: WorkItemConfiguration
  /** 現在の Workspace member key です。 */
  currentWorkspaceMemberKey?: string
  /** Detail mutation error の表示文言です。 */
  detailErrorMessage?: string
  /** External link management API の Bearer token です。 */
  externalLinksAccessToken?: string
  /** notification deep link から focus する comment ID です。 */
  focusedCommentId?: string
  /** notification deep link の reply が属する root comment ID です。 */
  focusedRootCommentId?: string
  /** 編集対象 Issue です。 */
  issue: TeamIssue
  /** Whether the mounted Brief assistant currently fences Team Issue navigation. */
  isAiSummaryOperationPending: boolean
  /** Relation 候補の取得中かどうかです。 */
  isRelationsLoading: boolean
  /** 表示 locale です。 */
  locale: Locale
  /** Relation 追加 callback です。 */
  onAddRelation?: (issueId: string, input: WorkItemRelationEditorInput) => Promise<void>
  /** Reports an authenticated AI API failure to the route-level session guard. */
  onAuthenticatedApiError?: (error: unknown) => void
  /** Reports the keyed Brief operation state to the Team Issue screen. */
  onAiSummaryOperationPendingChange?: (issueKey: string, pending: boolean) => void
  /** Reports retained comment composer input to the Team Issue navigation guard. */
  onCommentDraftDirtyChange?: (isDirty: boolean, issueId?: string) => void
  /** Creates a canonical schedule dependency. */
  onCreateScheduleDependency?: TeamIssueScreenProps['onCreateScheduleDependency']
  /** Relation 解除 callback です。 */
  onDeleteRelation?: (issueId: string, relation: WorkItemRelation) => Promise<void>
  /** Deletes a canonical schedule dependency. */
  onDeleteScheduleDependency?: TeamIssueScreenProps['onDeleteScheduleDependency']
  /** Issue 更新 callback です。 */
  onUpdateIssue?: (issueId: string, input: UpdateTeamIssueInput) => Promise<void>
  /** Updates a canonical schedule dependency. */
  onUpdateScheduleDependency?: TeamIssueScreenProps['onUpdateScheduleDependency']
  /** Authoritative canonical dependency graph. */
  planningSnapshot?: PlanningSnapshot
  /** Project selector の候補です。 */
  projects: ProjectDirectoryTeam['projects']
  /** Relation target の候補です。 */
  relationCandidates: TeamIssue[]
  /** 選択中 Issue の relation 一覧です。 */
  relations: readonly WorkItemRelation[]
  /** i18n translator です。 */
  t: (key: MessageKey) => string
  /** Person field と discussion で使う Workspace member 一覧です。 */
  workspaceMembers: WorkspaceMember[]
}) {
  const commentDraftDirtyRef = useRef(false)
  const [isCommentDraftDirty, setIsCommentDraftDirty] = useState(false)
  /** Reports this Team Issue's comment dirtiness to the owning screen. */
  const handleCommentDraftDirtyChange = useCallback((isDirty: boolean) => {
    commentDraftDirtyRef.current = isDirty
    setIsCommentDraftDirty(isDirty)
    onCommentDraftDirtyChange?.(isDirty, issue.id)
  }, [issue.id, onCommentDraftDirtyChange])
  const aiSummarySource = {
    expectedRevision: issue.revision,
    teamId: issue.teamId,
    type: 'work-item',
    workItemId: issue.id,
  } satisfies AiWorkItemSource
  const collaborationAiAssistance = aiAssistanceEnabled && accessToken
    ? {
        renderBrief: (
          onAdopt: Parameters<IssueSummaryAiAssistance['renderBrief']>[0],
          onOperationPendingChange: Parameters<IssueSummaryAiAssistance['renderBrief']>[1],
        ) => (
          <AiSummaryAssistant
            accessToken={accessToken}
            activityLabel={issue.title}
            adoptLabel={t('ai.summary.adoptContext')}
            key={createAiAssistantSessionKey(aiSummarySource)}
            locale={locale}
            onAdopt={onAdopt}
            onAuthenticatedApiError={onAuthenticatedApiError}
            onOperationPendingChange={(pending) => {
              onAiSummaryOperationPendingChange?.(
                createTaskViewItemKey(issue.teamId, issue.id),
                pending,
              )
              onOperationPendingChange?.(createAiAssistantSessionKey(aiSummarySource), pending)
            }}
            sources={[aiSummarySource]}
            t={t}
          />
        ),
        sessionKey: createAiAssistantSessionKey(aiSummarySource),
      }
    : undefined
  const [selectedProject, setSelectedProject] = useState({
    revision: issue.revision,
    value: issue.assignedProjectId ?? '',
  })
  const selectedProjectId = selectedProject.revision === issue.revision
    ? selectedProject.value
    : issue.assignedProjectId ?? ''
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string | undefined>>>({})
  const currentWorkItemTypeId = issue.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID
  const workItemTypes = resolveWorkItemTypes(configuration)
  const typeChangeRequestSequenceRef = useRef(0)
  const [selectedWorkItemType, setSelectedWorkItemType] = useState({
    revision: issue.revision,
    value: currentWorkItemTypeId,
  })
  const selectedWorkItemTypeId = selectedWorkItemType.revision === issue.revision
    ? selectedWorkItemType.value
    : currentWorkItemTypeId
  const workItemTypeSelectionIdentity = `${issue.teamId}:${issue.id}:${issue.revision}`
  const typeChangePreviewIdentity = `${workItemTypeSelectionIdentity}:${selectedProjectId}`
  const [typeChangeState, setTypeChangeState] = useState<TeamIssueTypeChangeState>({
    acknowledgedLostCustomFieldIds: [],
    identity: typeChangePreviewIdentity,
    isPreviewing: false,
    targetWorkItemTypeId: currentWorkItemTypeId,
  })
  const activeTypeChangeState = typeChangeState.identity === typeChangePreviewIdentity &&
      typeChangeState.targetWorkItemTypeId === selectedWorkItemTypeId
    ? typeChangeState
    : {
        acknowledgedLostCustomFieldIds: [],
        identity: typeChangePreviewIdentity,
        isPreviewing: false,
        targetWorkItemTypeId: selectedWorkItemTypeId,
      }
  const documentContextPromotion = useDocumentContextPromotion(
    Boolean(collaboration?.context.capabilities.canCreate && !isAiSummaryOperationPending),
    `${issue.teamId}:${issue.id}`,
    collaborationRoute?.onCollaborationTabChange,
  )
  const isIssueReadOnly = !onUpdateIssue
  // A save in flight locks the editors, so a draft cannot change or be submitted twice
  // before the refreshed issue remounts them.
  const [isIssueUpdatePending, setIssueUpdatePending] = useState(false)
  const hasSelectedAssigneeOption = assigneeOptions.some((member) => member.id === issue.assigneeUserId)
  const currentWorkflowStatusId = resolveWorkItemWorkflowStatusId(issue)
  const selectedWorkItemTypeDefinition = resolveWorkItemTypeDefinition(
    configuration,
    selectedWorkItemTypeId,
  )
  const detailSectionOrder = selectedWorkItemTypeDefinition?.detailSections ??
    DEFAULT_WORK_ITEM_TYPE.detailSections
  const shouldRetainActivityForDraft = isCommentDraftDirty &&
    !detailSectionOrder.includes('activity')
  const renderedDetailSectionOrder: readonly WorkItemDetailSectionId[] = shouldRetainActivityForDraft
    ? [...detailSectionOrder, 'activity']
    : detailSectionOrder
  const collaborationReadOnlyMessage = shouldRetainActivityForDraft
    ? t('collaboration.readOnly')
    : undefined
  const hasOverviewSection = detailSectionOrder.includes('overview')
  const hasDescriptionSection = detailSectionOrder.includes('description')
  const hasCustomFieldSection = detailSectionOrder.includes('custom-fields')
  const hasWorkflowSection = detailSectionOrder.includes('workflow')
  const selectedTypeCustomFieldDefinitions = resolveWorkItemTypeFormFields(
    configuration,
    selectedWorkItemTypeId,
  )
  const customFieldEditorDefinitions = hasCustomFieldSection
    ? selectedTypeCustomFieldDefinitions
    : selectedTypeCustomFieldDefinitions.filter((definition) => definition.required)
  const selectedTypeWorkflow = resolveWorkItemTypeWorkflow(
    configuration,
    selectedWorkItemTypeId,
  )
  const workflowStatuses = selectedWorkItemTypeId === currentWorkItemTypeId
    ? resolveEditableWorkflowStatuses(issue, configuration)
    : resolveCreateWorkflowStatuses(configuration, selectedWorkItemTypeId)
  const selectedTypeStatusFallback = workflowStatuses.some((status) => status.id === currentWorkflowStatusId)
    ? currentWorkflowStatusId
    : selectedTypeWorkflow?.initialStatusId ?? workflowStatuses[0]?.id ?? currentWorkflowStatusId
  const typeChangePreview = activeTypeChangeState.preview
  const isWorkItemTypeChangeRequested = selectedWorkItemTypeId !== currentWorkItemTypeId
  const typeChangeLostFields = typeChangePreview?.lostCustomFieldIds.map((fieldId) =>
    configuration?.customFields.find((definition) => definition.id === fieldId) ?? {
      id: fieldId,
      name: fieldId,
    },
  ) ?? []
  const selectedTypeWorkflowStatusId = activeTypeChangeState.replacementWorkflowStatusId ??
    selectedTypeStatusFallback
  const personOptions = resolveWorkItemPersonOptions(workspaceMembers)
  const contributorOptions = resolveWorkItemContributorOptions(workspaceMembers)
  const hasCustomFields = customFieldEditorDefinitions.some((definition) =>
    isCustomFieldApplicable(definition, selectedProjectId || undefined),
  )

  /** Requests a server-authoritative preview before saving a Team Issue type change. */
  async function requestWorkItemTypePreview(targetWorkItemTypeId: string) {
    typeChangeRequestSequenceRef.current += 1
    const requestSequence = typeChangeRequestSequenceRef.current
    if (!onUpdateIssue || !accessToken || targetWorkItemTypeId === currentWorkItemTypeId) return
    setTypeChangeState({
      acknowledgedLostCustomFieldIds: [],
      identity: typeChangePreviewIdentity,
      isPreviewing: true,
      targetWorkItemTypeId,
    })
    try {
      const preview = await previewTeamIssueWorkItemType(
        issue.teamId,
        issue.id,
        accessToken,
        {
          expectedRevision: issue.revision,
          targetWorkItemTypeId,
          assignedProjectId: selectedProjectId || null,
        },
      )
      if (typeChangeRequestSequenceRef.current !== requestSequence) return
      setTypeChangeState({
        acknowledgedLostCustomFieldIds: [],
        isPreviewing: false,
        identity: typeChangePreviewIdentity,
        preview,
        replacementWorkflowStatusId: preview.invalidWorkflowStatusId === undefined
          ? undefined
          : preview.targetInitialWorkflowStatusId,
        targetWorkItemTypeId,
      })
    } catch {
      if (typeChangeRequestSequenceRef.current !== requestSequence) return
      setTypeChangeState({
        acknowledgedLostCustomFieldIds: [],
        errorMessage: t('tasks.detail.typeChange.previewError'),
        identity: typeChangePreviewIdentity,
        isPreviewing: false,
        targetWorkItemTypeId,
      })
    }
  }

  /** Handles a Work Item Type selection from the Team Issue editor. */
  const handleWorkItemTypeChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextWorkItemTypeId = event.target.value
    const nextWorkItemTypeDefinition = resolveWorkItemTypeDefinition(
      configuration,
      nextWorkItemTypeId,
    )
    const nextDetailSections = nextWorkItemTypeDefinition?.detailSections ??
      DEFAULT_WORK_ITEM_TYPE.detailSections
    if (
      detailSectionOrder.includes('activity') &&
      !nextDetailSections.includes('activity') &&
      commentDraftDirtyRef.current &&
      !globalThis.window.confirm(t('collaboration.composer.discardConfirm'))
    ) return
    if (detailSectionOrder.includes('activity') && !nextDetailSections.includes('activity')) {
      handleCommentDraftDirtyChange(false)
    }
    setSelectedWorkItemType({
      revision: issue.revision,
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
  const editorFormId = useId()
  const editorIdentity = [issue.teamId, issue.id, issue.revision].join(':')
  // Held here so a Work Item Type change that moves the contributor editor keeps its draft.
  const contributorDraftState = useContributorDraft(editorIdentity)

  /** Submits the visible Team Issue controls through the external editor form. */
  const submitEditorForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!onUpdateIssue || isAiSummaryOperationPending || isIssueUpdatePending) {
      return
    }

    if (isWorkItemTypeChangeRequested && !typeChangePreview) {
      if (!activeTypeChangeState.isPreviewing) {
        void requestWorkItemTypePreview(selectedWorkItemTypeId)
      }
      return
    }

    const formData = new FormData(event.currentTarget)
    const assignedProjectId = hasOverviewSection
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
    const parsedCustomFields = configuration
      ? parseCustomFieldFormData(formData, customFieldEditorDefinitions, {
          projectId: assignedProjectId || undefined,
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
    const contributorSubmission = readContributorDraftSubmission(formData)
    if (contributorSubmission && 'error' in contributorSubmission) {
      contributorDraftState.setDraft((current) => ({ ...current, submitError: contributorSubmission }))
      return
    }
    contributorDraftState.setDraft((current) => current.submitError ? { ...current, submitError: undefined } : current)
    const contributorDraft = contributorSubmission

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
      issue.customFieldValues,
      parsedCustomFields.values,
      assignedProjectId || undefined,
    )
    const nextIssueInput: UpdateTeamIssueInput = {
      ...(hasOverviewSection
        ? {
            assignedProjectId: assignedProjectId || null,
            priority: resolveIssuePriority(formData.get('priority')),
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
    if (contributorDraft) {
      nextIssueInput.contributorAssignments = contributorDraft.assignments
    }

    setIssueUpdatePending(true)
    void onUpdateIssue(issue.id, nextIssueInput)
      .catch(() => undefined)
      .finally(() => setIssueUpdatePending(false))
  }

  /** Renders the Work Item Type selector and any pending type-change resolution UI. */
  const renderWorkItemTypeControl = (): ReactNode => configuration ? (
    <section className="workbench-panel-muted grid min-w-0 gap-3 p-3" data-testid="team-issue-detail-work-item-type">
      <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
        {t('tasks.create.workItemType')}
        <select
          className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
          disabled={isIssueReadOnly || isAiSummaryOperationPending || isIssueUpdatePending || activeTypeChangeState.isPreviewing}
          form={editorFormId}
          name="workItemTypeId"
          onChange={handleWorkItemTypeChange}
          value={selectedWorkItemTypeId}
        >
          {workItemTypes
            .filter((type) => type.status === 'active' || type.id === currentWorkItemTypeId)
            .map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}{type.status === 'archived' ? ' (' + t('tasks.create.archived') + ')' : ''}
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
        <div className="grid gap-2 rounded-md border border-[var(--workbench-border-strong)] bg-surface p-3 text-sm" data-testid="team-issue-detail-work-item-type-preview">
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
                          disabled={isIssueReadOnly || isAiSummaryOperationPending}
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
                    disabled={isIssueReadOnly || isAiSummaryOperationPending}
                    form={editorFormId}
                    name="typeChangeWorkflowStatusId"
                    onChange={(event) => setTypeChangeState((current) => ({
                      ...current,
                      replacementWorkflowStatusId: event.target.value,
                    }))}
                    value={selectedTypeWorkflowStatusId}
                  >
                    {resolveCreateWorkflowStatuses(
                      configuration,
                      selectedWorkItemTypeId,
                    ).map((status) => (
                      <option key={status.id} value={status.id}>{status.name}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              {typeChangePreview.missingRequiredCustomFieldIds.length > 0 ? (
                <p className="text-fg-amber-700">
                  {t('tasks.detail.typeChange.missingRequired')}
                </p>
              ) : null}
            </>
          ) : activeTypeChangeState.errorMessage ? (
            <p className="text-fg-red-700" role="alert">{activeTypeChangeState.errorMessage}</p>
          ) : null}
          {fieldErrors.typeChange ? (
            <p className="font-semibold text-fg-red-700" role="alert">{fieldErrors.typeChange}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  ) : null

  /** Renders the Work Item-wide contributor editor; shown even when a type omits the overview section. */
  const renderContributorsEditor = (): ReactNode => (
    <WorkItemContributorsEditor
      assignments={issue.contributorAssignments}
      formId={editorFormId}
      jobRoles={configuration?.jobRoles ?? []}
      draftState={contributorDraftState}
      key={editorIdentity + ':contributors'}
      locale={locale}
      memberOptions={contributorOptions}
      ownerUserId={issue.assigneeUserId}
      readOnly={isIssueReadOnly}
    />
  )

  /** Renders one configured Team Issue detail section in its persisted order. */
  const renderDetailSection = (section: WorkItemDetailSectionId): ReactNode => {
    switch (section) {
      case 'overview':
        return (
          <fieldset
            className="contents"
            disabled={isIssueReadOnly || isAiSummaryOperationPending || isIssueUpdatePending}
          >
            <section className="grid min-w-0 gap-3" data-testid="team-issue-detail-overview">
              {renderWorkItemTypeControl()}
              <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
                {t('issues.column.title')}
                <input
                  className="workbench-input w-full min-w-0 px-3 py-2 text-lg font-semibold disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                  defaultValue={resolveIssueTitle(issue, t)}
                  form={editorFormId}
                  key={editorIdentity + ':title'}
                  name="title"
                  required
                />
              </label>
              <div className="workbench-panel-muted grid grid-cols-1 gap-3 p-3">
                <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
                  {t('issues.create.project')}
                  <select
                    className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                    form={editorFormId}
                    name="assignedProjectId"
                    onChange={(event) => setSelectedProject({
                      revision: issue.revision,
                      value: event.target.value,
                    })}
                    value={selectedProjectId}
                  >
                    {canAssignUnassigned ? (
                      <option value="">{t('issues.project.unassigned')}</option>
                    ) : null}
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>{project.name}</option>
                    ))}
                  </select>
                </label>
                <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
                  {t('workItems.owner.label')}
                  <span
                    aria-hidden="true"
                    className="text-xs font-normal text-[var(--workbench-muted)]"
                    id={`${editorFormId}-owner-help`}
                  >
                    {t('workItems.owner.help')}
                  </span>
                  <select
                    aria-describedby={`${editorFormId}-owner-help`}
                    className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                    defaultValue={issue.assigneeUserId}
                    form={editorFormId}
                    key={editorIdentity + ':assignee'}
                    name="assigneeUserId"
                  >
                    {!hasSelectedAssigneeOption ? (
                      <option value={issue.assigneeUserId}>{resolveWorkItemAssignee(issue)}</option>
                    ) : null}
                    {assigneeOptions.map((member) => (
                      <option key={member.id} value={member.id}>{formatProjectMemberOption(member)}</option>
                    ))}
                  </select>
                </label>
                <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
                  {t('tasks.column.priority')}
                  <select
                    className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                    defaultValue={issue.priority}
                    form={editorFormId}
                    key={editorIdentity + ':priority'}
                    name="priority"
                  >
                    {issuePriorities.map((priority) => (
                      <option key={priority} value={priority}>{t(`tasks.priority.${priority}`)}</option>
                    ))}
                  </select>
                </label>
              </div>
              {renderContributorsEditor()}
            </section>
          </fieldset>
        )
      case 'description':
        return (
          <fieldset
            className="contents"
            disabled={isIssueReadOnly || isAiSummaryOperationPending}
          >
            <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
              {t('issues.create.description')}
              <textarea
                className="workbench-input min-h-28 w-full min-w-0 px-3 py-2 leading-6 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                defaultValue={issue.description}
                form={editorFormId}
                key={editorIdentity + ':description'}
                name="description"
              />
            </label>
          </fieldset>
        )
      case 'custom-fields':
        return hasCustomFields ? (
          <fieldset
            className="contents"
            disabled={isIssueReadOnly || isAiSummaryOperationPending}
          >
            <div className="workbench-panel-muted p-4">
              <WorkItemFieldsEditor
                definitions={customFieldEditorDefinitions}
                errors={fieldErrors}
                formId={editorFormId}
                locale={locale}
                personOptions={personOptions}
                projectId={selectedProjectId || undefined}
                values={issue.customFieldValues}
                key={editorIdentity}
              />
            </div>
          </fieldset>
        ) : null
      case 'workflow':
        return (
          <fieldset
            className="contents"
            disabled={isIssueReadOnly || isAiSummaryOperationPending}
          >
            <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
              {t('tasks.column.status')}
              <select
                className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                defaultValue={isWorkItemTypeChangeRequested ? selectedTypeWorkflowStatusId : currentWorkflowStatusId}
                form={editorFormId}
                key={editorIdentity + ':workflow:' + selectedWorkItemTypeId}
                name="workflowStatusId"
              >
                {workflowStatuses.map((status) => (
                  <option key={status.id} value={status.id}>{status.name}</option>
                ))}
              </select>
            </label>
          </fieldset>
        )
      case 'schedule':
        return (
          <div className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            <span>{t('tasks.schedule.title')}</span>
            <output className="min-h-9 rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 py-2 font-medium text-[var(--workbench-muted)]">
              {describeTeamIssueSchedule(issue.schedule, t)}
            </output>
          </div>
        )
      case 'relations':
        return (
          <>
            {planningSnapshot ? (
              <div className="border-t border-[var(--workbench-border)] bg-surface px-6 py-6">
                <WorkItemDependencyPanel
                  canManageEndpoint={canManageDependencyEndpoint}
                  currentEndpoint={{ teamId: issue.teamId, workItemId: issue.id }}
                  onCreate={isAiSummaryOperationPending ? undefined : onCreateScheduleDependency}
                  onDelete={isAiSummaryOperationPending ? undefined : onDeleteScheduleDependency}
                  onUpdate={isAiSummaryOperationPending ? undefined : onUpdateScheduleDependency}
                  snapshot={planningSnapshot}
                  t={t}
                />
              </div>
            ) : null}
            <div className="border-t border-[var(--workbench-border)] px-6 py-6">
              <WorkItemRelationsEditor
                candidates={relationCandidates.map((candidate) => ({
                  id: candidate.id,
                  title: resolveIssueTitle(candidate, t),
                }))}
                currentWorkItemId={issue.id}
                isLoading={isRelationsLoading}
                locale={locale}
                onAddRelation={onAddRelation && !isAiSummaryOperationPending
                  ? (input) => onAddRelation(issue.id, input)
                  : undefined}
                onDeleteRelation={onDeleteRelation && !isAiSummaryOperationPending
                  ? (relation) => onDeleteRelation(issue.id, relation)
                  : undefined}
                readOnly={isAiSummaryOperationPending || (!onAddRelation && !onDeleteRelation)}
                relations={relations}
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
            {externalLinksAccessToken ? (
              <WorkItemExternalLinksPanelContainer
                accessToken={externalLinksAccessToken}
                canManage={canManageExternalLinks && !isAiSummaryOperationPending}
                locale={locale}
                teamId={issue.teamId}
                workItemId={issue.id}
              />
            ) : null}
            <RelatedDocuments
              accessToken={accessToken}
              onPromoteToContext={documentContextPromotion.onPromoteToContext}
              t={t}
              targetId={'team/' + issue.teamId + '/issue/' + issue.id}
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
            key={issue.teamId + ':' + issue.id}
            controller={collaboration}
            currentMemberKey={currentWorkspaceMemberKey}
            focusedCommentId={focusedCommentId}
            focusedRootCommentId={focusedRootCommentId}
            locale={locale}
            members={workspaceMembers}
            onAiSummaryOperationPendingChange={(pending) => {
              onAiSummaryOperationPendingChange?.(
                createTaskViewItemKey(issue.teamId, issue.id),
                pending,
              )
            }}
            onCommentDraftDirtyChange={handleCommentDraftDirtyChange}
            onContextDraftConsumed={documentContextPromotion.onContextDraftConsumed}
            readOnlyMessage={collaborationReadOnlyMessage}
          />
        ) : null
      default:
        return null
    }
  }

  return (
    <aside
      className="workbench-detail-pane min-h-0 min-w-0 max-[1080px]:border-l-0 max-[1080px]:border-t"
      data-testid="team-issue-detail-pane"
    >
      <form
        aria-hidden="true"
        className="hidden"
        id={editorFormId}
        onSubmit={submitEditorForm}
      />
      <div className="grid min-w-0 gap-4 px-6 py-7">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="workbench-eyebrow">{t('tasks.detail.title')}</p>
            <p className="mt-1 truncate text-lg font-semibold leading-6 text-[var(--workbench-text)]">
              {resolveIssueTitle(issue, t)}
            </p>
          </div>
          <IssuePriorityBadge priority={issue.priority} t={t} />
        </div>
        <div className="grid min-w-0 gap-4">
          {!hasOverviewSection ? renderWorkItemTypeControl() : null}
          {renderedDetailSectionOrder.map((section) => (
            <Fragment key={section}>{renderDetailSection(section)}</Fragment>
          ))}
          {!hasOverviewSection ? (
          // Same mutation lock as the overview section, so a draft cannot change while it saves.
          <fieldset className="contents" disabled={isIssueReadOnly || isAiSummaryOperationPending || isIssueUpdatePending}>
            {renderContributorsEditor()}
          </fieldset>
        ) : null}
          {!hasCustomFieldSection && hasCustomFields
            ? <Fragment>{renderDetailSection('custom-fields')}</Fragment>
            : null}
        </div>
        <button
          className="workbench-button-primary h-10 px-4 disabled:border-slate-300 disabled:bg-slate-300"
          disabled={isIssueReadOnly || isAiSummaryOperationPending || isIssueUpdatePending}
          form={editorFormId}
          type="submit"
        >
          {t('issues.detail.save')}
        </button>
        {isIssueReadOnly ? (
          <p className="text-sm font-medium text-[var(--workbench-muted)]">
            {t('issues.detail.readOnlyPermission')}
          </p>
        ) : null}
        {detailErrorMessage ? <p className="text-sm font-bold text-fg-red-600">{detailErrorMessage}</p> : null}
      </div>
    </aside>
  )
}
