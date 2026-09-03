import type {
  AiTriageDraft,
  CustomFieldDefinition,
  CustomFieldValue,
  RequestFormRoutingTarget,
  RequestSubmissionActionInput,
  WorkItemConfiguration,
} from '@mukuroji/contracts'
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { AiAssistanceController } from '../../features/ai-assistance/mutations/useAiAssistanceController'
import { AiTriageDraftComposer } from '../../features/ai-assistance/ui/AiTriageDraftComposer'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'
import { createProjectIssuesPath, createTeamIssuesPath } from '../../shared/routing/paths'
import {
  createCustomFieldErrorMessages,
  resolveWorkItemTypeWorkflow,
  resolveWorkItemTypeFormFields,
  resolveWorkItemTypes,
} from '../../work-items/model/workItemDisplay'
import {
  createDefaultCustomFieldValues,
  isCustomFieldApplicable,
  parseCustomFieldFormData,
} from '../../work-items/model/customFields'
import { WorkItemFieldsEditor } from '../../work-items/ui/WorkItemFieldsEditor'
import {
  type RequestSubmissionModel,
} from '../model/requestForm'
import { createMappedConversionCustomFieldValues } from '../model/requestConversion'
import { resolveRequestLocalizedText } from '../model/requestFormLogic'
import {
  canAdoptRequestTriageDraft,
  createSafeTriageRoutingOverride,
  resolveRequestWorkItemConfiguration,
  type RequestRoutingAssigneeDirectory,
  type RequestRoutingProjectDirectory,
} from '../model/requestTriageRouting'
import {
  isRequestAiOperationPendingForSubmission,
  updateRequestAiOperationFence,
  type RequestAiOperationFence,
} from '../model/requestAiOperationFence'

/** Props for the Request Intake queue, detail pane, and explicit actions. */
export type RequestQueueProps = {
  /** Active Workspace member bearer token used only for explicit AI generation. */
  accessToken?: string
  /** Optional AI controller override for isolated interaction stories. */
  aiAssistanceController?: AiAssistanceController
  /** Reports authenticated AI failures to the Request Intake session guard. */
  onAuthenticatedApiError?: (error: unknown) => void
  /** Whether the current principal may send administrator-only intake content to AI. */
  canUseAiAssistance?: boolean
  /** Team-scoped Project IDs used to validate AI routing proposals before adoption. */
  projectDirectory?: RequestRoutingProjectDirectory
  /** Active non-guest Workspace member keys used to validate AI assignee proposals before adoption. */
  assigneeDirectory?: RequestRoutingAssigneeDirectory
  /** Team-scoped Work Item configurations used by the conversion type picker. */
  workItemConfigurations?: Readonly<Record<string, WorkItemConfiguration>>
  /**
   * 表示 locale です。
   */
  locale: Locale
  /**
   * Queue page に表示する submission 一覧です。
   */
  submissions: RequestSubmissionModel[]
  /**
   * Detail pane に表示する submission です。
   */
  selectedSubmission?: RequestSubmissionModel
  /**
   * Queue または detail を読み込み中かどうかです。
   */
  isLoading?: boolean
  /**
   * Queue/detail API の表示 error です。
   */
  errorMessage?: string
  /**
   * Cursor が示す次 page を取得できるかどうかです。
   */
  hasMore?: boolean
  /**
   * 次 page を読み込み中かどうかです。
   */
  isLoadingMore?: boolean
  /**
   * Submission 行を選択したときの callback です。
   */
  onSelectSubmission: (submissionId: string) => void
  /**
   * Triage action を実行する callback です。
   */
  onAction?: (
    submissionId: string,
    input: RequestSubmissionActionInput,
  ) => Promise<void>
  /**
   * 次の cursor page を読み込む callback です。
   */
  onLoadMore?: () => void
  /**
   * Scan 済み attachment の短命 access URL を開く callback です。
   */
  onOpenAttachment?: (
    submissionId: string,
    attachmentId: string,
  ) => Promise<void>
}

/** Queue detail で編集中の triage action です。 */
type ActionMode = RequestSubmissionActionInput['action'] | undefined

/** Tracks which conversion overrides the operator has edited locally. */
type ConversionOverrideDirtyState = {
  /** Whether the conversion title override contains a local edit. */
  title: boolean
  /** Whether the conversion description override contains a local edit. */
  description: boolean
}

/** Renders the Request Intake queue, detail pane, and explicit action controls. */
export function RequestQueue({
  accessToken,
  aiAssistanceController,
  canUseAiAssistance,
  errorMessage,
  hasMore = false,
  isLoading = false,
  isLoadingMore = false,
  locale,
  onAuthenticatedApiError,
  onAction,
  onLoadMore,
  onOpenAttachment,
  onSelectSubmission,
  projectDirectory,
  assigneeDirectory,
  workItemConfigurations,
  selectedSubmission,
  submissions,
}: RequestQueueProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [isAiOperationPending, setIsAiOperationPending] = useState(false)
  const [aiOperationOwner, setAiOperationOwner] = useState<string>()
  const aiOperationOwnerRef = useRef<string | undefined>(undefined)
  const selectedSubmissionId = selectedSubmission?.id
  const selectedSubmissionIdRef = useRef(selectedSubmissionId)

  /** Keeps delayed child callbacks associated with the current selected submission. */
  useEffect(() => {
    selectedSubmissionIdRef.current = selectedSubmissionId
  }, [selectedSubmissionId])

  const isPendingForSelectedSubmission = isRequestAiOperationPendingForSubmission(
    { ownerSubmissionId: aiOperationOwner, pending: isAiOperationPending },
    selectedSubmissionId,
  )

  /** Keeps the request source fence synchronized before React renders. */
  const reportAiOperationPending = (submissionId: string, pending: boolean) => {
    const nextFence = updateRequestAiOperationFence(
      {
        ownerSubmissionId: aiOperationOwnerRef.current,
        pending: isAiOperationPending,
      } satisfies RequestAiOperationFence,
      selectedSubmissionIdRef.current,
      submissionId,
      pending,
    )
    if (!nextFence) return
    aiOperationOwnerRef.current = nextFence.ownerSubmissionId
    setAiOperationOwner(nextFence.ownerSubmissionId)
    setIsAiOperationPending(nextFence.pending)
  }

  /** Ignores source changes while an AI operation is awaiting its response. */
  const selectSubmission = (submissionId: string) => {
    if (isPendingForSelectedSubmission) return
    aiOperationOwnerRef.current = undefined
    setAiOperationOwner(undefined)
    setIsAiOperationPending(false)
    onSelectSubmission(submissionId)
  }

  return (
    <div className="grid grid-cols-[minmax(420px,0.9fr)_minmax(480px,1.1fr)] gap-5 max-[1120px]:grid-cols-1" data-testid="request-intake-queue">
      <section className="workbench-panel min-w-0 overflow-hidden">
        <div className="border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 py-4">
          <p className="workbench-eyebrow">{t('requests.eyebrow')}</p>
          <h2 className="mt-2 text-xl font-semibold text-[var(--workbench-text)]">
            {t('requests.queue.title')}
          </h2>
          <p className="mt-1 text-sm font-medium text-[var(--workbench-muted)]">
            {t('requests.queue.description')}
          </p>
        </div>

        {isLoading && submissions.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm font-semibold text-[var(--workbench-muted)]">
            {t('requests.loading')}
          </p>
        ) : submissions.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm font-semibold text-[var(--workbench-muted)]">
            {t('requests.queue.empty')}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left">
              <thead>
                <tr className="workbench-table-head">
                  <th className="px-4 py-3" scope="col">{t('requests.queue.receivedAt')}</th>
                  <th className="px-4 py-3" scope="col">{t('requests.queue.form')}</th>
                  <th className="px-4 py-3" scope="col">{t('requests.queue.source')}</th>
                  <th className="px-4 py-3" scope="col">{t('requests.queue.status')}</th>
                  <th className="px-4 py-3" scope="col">{t('requests.queue.assignee')}</th>
                </tr>
              </thead>
              <tbody>
                {submissions.map((submission) => (
                  <tr
                    aria-selected={selectedSubmission?.id === submission.id}
                    className={`border-b border-[var(--workbench-border)] text-sm font-medium text-[var(--workbench-text)] hover:bg-[var(--workbench-surface-muted)] ${selectedSubmission?.id === submission.id ? 'bg-teal-50' : ''}`}
                    data-testid={`request-queue-row-${submission.id}`}
                    key={submission.id}
                  >
                    <td className="px-4 py-4">{formatDateTime(submission.receivedAt, locale)}</td>
                    <td className="max-w-[240px] px-4 py-4">
                      <button
                        aria-current={selectedSubmission?.id === submission.id ? 'true' : undefined}
                        aria-label={`${t('requests.queue.openSubmission')}: ${submission.formName} ${submission.formVersionLabel}`}
                        className="group block min-h-10 w-full rounded-md px-2 py-1 text-left outline-none hover:bg-white focus-visible:ring-2 focus-visible:ring-[var(--workbench-primary)] focus-visible:ring-offset-2"
                        disabled={isPendingForSelectedSubmission}
                        onClick={() => selectSubmission(submission.id)}
                        type="button"
                      >
                        <strong className="block truncate group-hover:text-[var(--workbench-primary)]">{submission.formName}</strong>
                        <span className="text-xs text-[var(--workbench-muted)]">{submission.formVersionLabel}</span>
                      </button>
                    </td>
                    <td className="px-4 py-4">{t(`requests.source.${submission.source}`)}</td>
                    <td className="px-4 py-4"><RequestStatusBadge status={submission.status} t={t} /></td>
                    <td className="max-w-[180px] truncate px-4 py-4 text-[var(--workbench-muted)]">
                      {submission.assigneeUserId ?? t('requests.queue.unassigned')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {hasMore ? (
          <div className="border-t border-[var(--workbench-border)] p-4 text-center">
            <button className="workbench-button-secondary min-h-10 px-5" disabled={isLoadingMore || isPendingForSelectedSubmission} onClick={onLoadMore} type="button">
              {isLoadingMore ? t('requests.queue.loadingMore') : t('requests.queue.loadMore')}
            </button>
          </div>
        ) : null}
        {errorMessage ? (
          <p className="m-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700" role="alert">
            {errorMessage}
          </p>
        ) : null}
      </section>

      <RequestSubmissionDetail
        accessToken={accessToken}
        aiAssistanceController={aiAssistanceController}
        canUseAiAssistance={canUseAiAssistance ?? Boolean(aiAssistanceController)}
        key={selectedSubmission?.id ?? 'empty'}
        locale={locale}
        submission={selectedSubmission}
        onAction={onAction}
        onAuthenticatedApiError={onAuthenticatedApiError}
        isAiOperationPending={isPendingForSelectedSubmission}
        onOperationPendingChange={(pending) => {
          if (selectedSubmission) reportAiOperationPending(selectedSubmission.id, pending)
        }}
        onOpenAttachment={onOpenAttachment}
        assigneeDirectory={assigneeDirectory}
        projectDirectory={projectDirectory}
        workItemConfigurations={workItemConfigurations}
      />
    </div>
  )
}

function RequestSubmissionDetail({
  accessToken,
  aiAssistanceController,
  canUseAiAssistance,
  isAiOperationPending,
  locale,
  onAuthenticatedApiError,
  onAction,
  onOpenAttachment,
  onOperationPendingChange,
  assigneeDirectory,
  projectDirectory,
  workItemConfigurations,
  submission,
}: {
  accessToken?: string
  aiAssistanceController?: AiAssistanceController
  canUseAiAssistance: boolean
  /** Whether an AI generation, decision, or feedback request is in flight. */
  isAiOperationPending: boolean
  onAuthenticatedApiError?: (error: unknown) => void
  /** Reports AI request state so the parent queue can fence source changes. */
  onOperationPendingChange?: (pending: boolean) => void
  locale: Locale
  projectDirectory?: RequestRoutingProjectDirectory
  assigneeDirectory?: RequestRoutingAssigneeDirectory
  /** Team-scoped Work Item configurations used by the effective conversion target. */
  workItemConfigurations?: Readonly<Record<string, WorkItemConfiguration>>
  onAction?: RequestQueueProps['onAction']
  onOpenAttachment?: RequestQueueProps['onOpenAttachment']
  submission?: RequestSubmissionModel
}) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const [conversionTargetOverride, setConversionTargetOverride] =
    useState<Partial<RequestFormRoutingTarget>>({})
  const effectiveRouting: Partial<RequestFormRoutingTarget> = {
    ...submission?.routing,
    ...conversionTargetOverride,
  }
  const effectiveWorkItemConfiguration = submission
    ? resolveRequestWorkItemConfiguration(
        workItemConfigurations,
        submission,
        conversionTargetOverride,
      )
    : undefined
  const workItemTypes = useMemo(
    () => resolveWorkItemTypes(effectiveWorkItemConfiguration).filter((type) => type.status === 'active'),
    [effectiveWorkItemConfiguration],
  )
  const hasCreatableWorkItemType = workItemTypes.length > 0
  const [selectedWorkItemTypeId, setSelectedWorkItemTypeId] = useState(
    () => workItemTypes[0]?.id ?? 'default',
  )
  const effectiveWorkItemTypeId = workItemTypes.some((type) => type.id === selectedWorkItemTypeId)
    ? selectedWorkItemTypeId
    : workItemTypes[0]?.id ?? 'default'
  const conversionProjectId = effectiveRouting.projectId || undefined
  const conversionFieldDefinitions = effectiveWorkItemConfiguration
    ? resolveConversionFieldDefinitions(
        effectiveWorkItemConfiguration,
        effectiveWorkItemTypeId,
        conversionProjectId,
      )
    : []
  const conversionCustomFieldValues = createConversionCustomFieldValues(
    submission,
    effectiveWorkItemConfiguration,
    effectiveWorkItemTypeId,
    conversionProjectId,
  )
  const [conversionFieldErrors, setConversionFieldErrors] = useState<
    Readonly<Record<string, string | undefined>>
  >({})
  const [actionMode, setActionMode] = useState<ActionMode>()
  const [actionValue, setActionValue] = useState('')
  const [titleOverride, setTitleOverride] = useState('')
  const [descriptionOverride, setDescriptionOverride] = useState('')
  const [, setConversionOverrideDirty] =
    useState<ConversionOverrideDirtyState>({ title: false, description: false })
  const conversionOverrideDirtyRef = useRef<ConversionOverrideDirtyState>({
    title: false,
    description: false,
  })
  const [isSubmitting, setIsSubmitting] = useState(false)
  const isSubmittingRef = useRef(false)
  const [actionError, setActionError] = useState(false)
  const [openingAttachmentId, setOpeningAttachmentId] = useState<string>()
  const [attachmentErrorId, setAttachmentErrorId] = useState<string>()
  const actionIsPending = isSubmitting || isAiOperationPending

  /** Opens an explicit action and resets transient conversion overrides. */
  const activateAction = (mode: Exclude<ActionMode, undefined>, value = '') => {
    setActionError(false)
    setConversionFieldErrors({})
    setActionMode(mode)
    setActionValue(value)
    setDescriptionOverride('')
    setTitleOverride('')
    setConversionTargetOverride({})
    const cleanState = { title: false, description: false }
    conversionOverrideDirtyRef.current = cleanState
    setConversionOverrideDirty(cleanState)
  }

  /** Opens the conversion action while preserving any locally edited overrides. */
  const openConversionAction = () => {
    setActionError(false)
    setConversionFieldErrors({})
    setActionMode('convert')
    setActionValue('')
  }

  /** Copies proposed conversion fields while retaining fields omitted by the draft. */
  const applyTriageDraft = (draft: AiTriageDraft) => {
    if (!submission || isSubmittingRef.current) return
    openConversionAction()
    setTitleOverride((current) => draft.title?.value ?? current)
    setDescriptionOverride((current) => draft.description?.value ?? current)
    setConversionTargetOverride((current) => createSafeTriageRoutingOverride(
      submission,
      draft,
      current,
      projectDirectory,
      assigneeDirectory,
    ))
    const currentDirtyState = conversionOverrideDirtyRef.current
    const nextDirtyState = {
      title: draft.title === undefined ? currentDirtyState.title : false,
      description: draft.description === undefined ? currentDirtyState.description : false,
    }
    conversionOverrideDirtyRef.current = nextDirtyState
    setConversionOverrideDirty(nextDirtyState)
  }

  /** Returns whether this AI draft would replace a locally edited conversion field. */
  const shouldConfirmTriageAdoption = (draft: AiTriageDraft) => (
    (draft.title !== undefined && conversionOverrideDirtyRef.current.title) ||
    (draft.description !== undefined && conversionOverrideDirtyRef.current.description)
  )

  /** Copies an AI draft only after the composer has confirmed any replacement. */
  const adoptTriageDraft = (draft: AiTriageDraft, replacementConfirmed = false) => {
    if (!submission) return
    if (shouldConfirmTriageAdoption(draft) && !replacementConfirmed) return
    applyTriageDraft(draft)
  }

  if (!submission) {
    return (
      <aside className="workbench-panel grid min-h-80 place-items-center p-8 text-center text-sm font-semibold text-[var(--workbench-muted)]">
        {t('requests.detail.empty')}
      </aside>
    )
  }

  const submitAction = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!actionMode || !onAction || actionIsPending || isSubmittingRef.current) return

    const parsedConversionCustomFields = actionMode === 'convert' &&
      effectiveWorkItemConfiguration
      ? parseConversionCustomFieldFormData(
          new FormData(event.currentTarget),
          conversionFieldDefinitions,
          conversionProjectId,
          locale,
        )
      : undefined
    if (parsedConversionCustomFields && Object.keys(parsedConversionCustomFields.errors).length > 0) {
      setConversionFieldErrors(parsedConversionCustomFields.errors)
      return
    }
    const conversionCustomFieldOverrides = parsedConversionCustomFields?.values
    const common = { expectedRevision: submission.revision }
    const input: RequestSubmissionActionInput = actionMode === 'assign'
      ? { action: actionMode, assigneeUserId: actionValue.trim(), ...common }
      : actionMode === 'reject'
        ? { action: actionMode, reason: actionValue.trim(), ...common }
        : actionMode === 'request-more-info'
          ? { action: actionMode, message: actionValue.trim(), ...common }
          : actionMode === 'mark-duplicate'
            ? { action: actionMode, duplicateOfSubmissionId: actionValue.trim(), ...common }
            : {
                action: 'convert',
                ...common,
                ...(effectiveWorkItemTypeId
                  ? { workItemTypeId: effectiveWorkItemTypeId }
                  : {}),
                description: descriptionOverride.trim() || undefined,
                ...(Object.keys(conversionTargetOverride).length > 0
                  ? { target: conversionTargetOverride }
                  : {}),
                title: titleOverride.trim() || undefined,
                ...(conversionCustomFieldOverrides === undefined
                  ? {}
                  : { customFieldValues: conversionCustomFieldOverrides }),
              }

    isSubmittingRef.current = true
    setIsSubmitting(true)
    setActionError(false)
    setConversionFieldErrors({})
    try {
      await onAction(submission.id, input)
      setActionMode(undefined)
      setActionValue('')
      setDescriptionOverride('')
      setTitleOverride('')
      setConversionTargetOverride({})
      const cleanState = { title: false, description: false }
      conversionOverrideDirtyRef.current = cleanState
      setConversionOverrideDirty(cleanState)
    } catch {
      setActionError(true)
    } finally {
      isSubmittingRef.current = false
      setIsSubmitting(false)
    }
  }

  const workItemPath = submission.workItem
    ? submission.workItem.projectId
      ? createProjectIssuesPath(
          submission.workItem.projectId,
          submission.workItem.teamId,
          submission.workItem.id,
        )
      : createTeamIssuesPath(submission.workItem.teamId, submission.workItem.id)
    : undefined
  const effectiveWorkItemWorkflow = effectiveWorkItemConfiguration
    ? resolveWorkItemTypeWorkflow(effectiveWorkItemConfiguration, effectiveWorkItemTypeId)
    : undefined
  const effectiveWorkflowStatusId = conversionTargetOverride.workflowStatusId !== undefined
    ? effectiveRouting.workflowStatusId
    : effectiveRouting.workflowStatusId && effectiveWorkItemWorkflow?.statuses.some(
        (status) => status.id === effectiveRouting.workflowStatusId,
      )
      ? effectiveRouting.workflowStatusId
      : effectiveWorkItemWorkflow?.initialStatusId ?? effectiveRouting.workflowStatusId

  return (
    <aside className="workbench-panel min-w-0 overflow-hidden" data-testid="request-submission-detail">
      <div className="border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="workbench-eyebrow">{submission.requesterLabel}</p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--workbench-text)]">
              {t('requests.detail.title')}
            </h2>
            <p className="mt-1 text-sm font-medium text-[var(--workbench-muted)]">
              {submission.formName} · {submission.formVersionLabel}
            </p>
          </div>
          <RequestStatusBadge status={submission.status} t={t} />
        </div>
      </div>

      <div className="grid gap-5 p-5">
        <DetailSection title={t('requests.detail.answers')}>
          <dl className="grid gap-3">
            {submission.answers.map((answer) => (
              <div className="rounded-lg border border-[var(--workbench-border)] bg-white px-4 py-3" key={answer.fieldId}>
                <dt className="text-xs font-bold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
                  {resolveRequestLocalizedText(answer.label, locale, submission.formDefaultLocale) || answer.fieldId}
                </dt>
                <dd className="mt-2 whitespace-pre-wrap break-words text-sm font-medium text-[var(--workbench-text)]">
                  {formatAnswer(answer, locale, submission.formDefaultLocale, t)}
                </dd>
              </div>
            ))}
          </dl>
        </DetailSection>

        {submission.attachments.length > 0 ? (
          <DetailSection title={t('requests.detail.attachments')}>
            <ul className="grid gap-2">
              {submission.attachments.map((attachment) => (
                <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--workbench-border)] px-4 py-3 text-sm font-semibold" key={attachment.id}>
                  <span className="min-w-0 truncate">{attachment.fileName}</span>
                  <span className="flex flex-none items-center gap-2">
                    <span className="workbench-badge">{t(`requests.scanStatus.${attachment.scanStatus}`)}</span>
                    {attachment.scanStatus === 'available' && onOpenAttachment ? (
                      <button className="workbench-button-secondary min-h-9 px-3" disabled={openingAttachmentId === attachment.id || actionIsPending} onClick={() => {
                        setOpeningAttachmentId(attachment.id)
                        setAttachmentErrorId(undefined)
                        void onOpenAttachment(submission.id, attachment.id)
                          .catch(() => setAttachmentErrorId(attachment.id))
                          .finally(() => setOpeningAttachmentId(undefined))
                      }} type="button">
                        {openingAttachmentId === attachment.id ? t('requests.detail.openingAttachment') : t('requests.detail.openAttachment')}
                      </button>
                    ) : null}
                  </span>
                  {attachmentErrorId === attachment.id ? <span className="basis-full text-xs font-semibold text-red-700" role="alert">{t('requests.detail.attachmentError')}</span> : null}
                </li>
              ))}
            </ul>
          </DetailSection>
        ) : null}

        {submission.consentText ? (
          <DetailSection title={t('requests.detail.consent')}>
            <p className="whitespace-pre-wrap text-sm font-medium leading-6 text-[var(--workbench-text)]">
              {submission.consentAccepted ? '✓ ' : '— '}
              {resolveRequestLocalizedText(submission.consentText, locale, locale)}
            </p>
          </DetailSection>
        ) : null}

        {submission.capabilities.canMarkDuplicate && submission.duplicateCandidateIds.length > 0 ? (
          <DetailSection title={t('requests.detail.duplicates')}>
            <div className="flex flex-wrap gap-2">
              {submission.duplicateCandidateIds.map((id) => (
                <button className="workbench-button-secondary min-h-9 px-3" disabled={actionIsPending} key={id} onClick={() => {
                  activateAction('mark-duplicate', id)
                }} type="button">{id}</button>
              ))}
            </div>
          </DetailSection>
        ) : null}

        {submission.messages.length > 0 ? (
          <DetailSection title={t('requests.detail.messages')}>
            <div className="grid gap-2">
              {submission.messages.map((message) => (
                <div className={`rounded-lg border px-4 py-3 ${message.direction === 'internal' ? 'border-teal-200 bg-teal-50' : 'border-[var(--workbench-border)] bg-white'}`} key={message.id}>
                  <p className="text-xs font-bold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
                    {t(`requests.messageDirection.${message.direction}`)} · {formatDateTime(message.createdAt, locale)}
                  </p>
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm font-medium leading-6 text-[var(--workbench-text)]">{message.body}</p>
                </div>
              ))}
            </div>
          </DetailSection>
        ) : null}

        {submission.events.length > 0 ? (
          <DetailSection title={t('requests.detail.activity')}>
            <ol className="grid gap-2">
              {submission.events.map((event) => (
                <li className="border-l-2 border-teal-200 pl-3 text-sm font-medium text-[var(--workbench-text)]" key={event.id}>
                  <strong>{t(`requests.eventType.${event.type}`)}</strong> · {event.summary}
                  <span className="mt-1 block text-xs text-[var(--workbench-muted)]">{formatDateTime(event.createdAt, locale)}</span>
                </li>
              ))}
            </ol>
          </DetailSection>
        ) : null}

        {workItemPath ? (
          <a className="workbench-button-primary inline-flex min-h-10 items-center justify-center px-4 no-underline" href={workItemPath}>
            {t('requests.detail.workItem')}
          </a>
        ) : null}

        {submission.capabilities.canConvert &&
        canUseAiAssistance &&
        (accessToken || aiAssistanceController) ? (
          <AiTriageDraftComposer
            accessToken={accessToken}
            adoptLabel={t('ai.triage.adoptRequest')}
            controller={aiAssistanceController}
            locale={locale}
            onAuthenticatedApiError={onAuthenticatedApiError}
            onAdoptDraft={adoptTriageDraft}
            onOperationPendingChange={onOperationPendingChange}
            canAdoptDraft={(draft) => canAdoptRequestTriageDraft(
              submission,
              draft,
              conversionTargetOverride,
              projectDirectory,
              assigneeDirectory,
            )}
            isMutationPending={isSubmitting}
            shouldConfirmAdoption={shouldConfirmTriageAdoption}
            source={{
              expectedRevision: submission.revision,
              formId: submission.formId,
              submissionId: submission.id,
              type: 'request-submission',
            }}
            t={t}
          />
        ) : null}

        <div className="flex flex-wrap gap-2 border-t border-[var(--workbench-border)] pt-4">
          {submission.capabilities.canAssign ? <ActionButton disabled={actionIsPending} label={t('requests.action.assign')} onClick={() => activateAction('assign')} /> : null}
          {submission.capabilities.canRequestMoreInfo ? <ActionButton disabled={actionIsPending} label={t('requests.action.moreInfo')} onClick={() => activateAction('request-more-info')} /> : null}
          {submission.capabilities.canReject ? <ActionButton disabled={actionIsPending} label={t('requests.action.reject')} onClick={() => activateAction('reject')} /> : null}
          {submission.capabilities.canMarkDuplicate ? <ActionButton disabled={actionIsPending} label={t('requests.action.duplicate')} onClick={() => activateAction('mark-duplicate')} /> : null}
          {submission.capabilities.canConvert ? <ActionButton disabled={actionIsPending} label={t('requests.action.convert')} primary onClick={() => activateAction('convert')} /> : null}
        </div>

        {actionMode ? (
          <form className="grid gap-3 rounded-lg border border-[var(--workbench-border-strong)] bg-[var(--workbench-surface-muted)] p-4" onSubmit={(event) => void submitAction(event)}>
            <h3 className="text-sm font-semibold text-[var(--workbench-text)]">
              {actionMode === 'assign'
                ? t('requests.action.assign')
                : actionMode === 'reject'
                  ? t('requests.action.reject')
                  : actionMode === 'request-more-info'
                    ? t('requests.action.moreInfo')
                    : actionMode === 'mark-duplicate'
                      ? t('requests.action.duplicate')
                      : t('requests.action.convert')}
            </h3>
            {actionMode === 'convert' ? (
              <>
                <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
                  {t('requests.action.workItemType')}
                  <select
                    aria-label={t('requests.action.workItemType')}
                    className="workbench-input min-h-10 px-3"
                    disabled={actionIsPending || !hasCreatableWorkItemType}
                    name="workItemTypeId"
                    onChange={(event) => {
                      const nextTypeId = event.target.value
                      setSelectedWorkItemTypeId(nextTypeId)
                      setConversionFieldErrors({})
                    }}
                    value={effectiveWorkItemTypeId}
                  >
                    {workItemTypes.map((type) => (
                      <option key={type.id} value={type.id}>{type.name}</option>
                    ))}
                  </select>
                  {!hasCreatableWorkItemType ? (
                    <span className="text-xs font-semibold text-amber-700">
                      {t('tasks.create.noActiveWorkItemTypes')}
                    </span>
                  ) : null}
                </label>
                <input aria-label={t('requests.action.titleOverride')} className="workbench-input min-h-10 px-3" disabled={actionIsPending} placeholder={t('requests.action.titleOverride')} value={titleOverride} onChange={(event) => {
                  setTitleOverride(event.target.value)
                  const nextDirtyState = { ...conversionOverrideDirtyRef.current, title: true }
                  conversionOverrideDirtyRef.current = nextDirtyState
                  setConversionOverrideDirty(nextDirtyState)
                }} />
                <textarea aria-label={t('requests.action.descriptionOverride')} className="workbench-input min-h-24 px-3 py-2" disabled={actionIsPending} placeholder={t('requests.action.descriptionOverride')} value={descriptionOverride} onChange={(event) => {
                  setDescriptionOverride(event.target.value)
                  const nextDirtyState = { ...conversionOverrideDirtyRef.current, description: true }
                  conversionOverrideDirtyRef.current = nextDirtyState
                  setConversionOverrideDirty(nextDirtyState)
                }} />
                {effectiveWorkItemConfiguration ? (
                  <div className="workbench-panel-muted p-4">
                    <WorkItemFieldsEditor
                      definitions={conversionFieldDefinitions}
                      errors={conversionFieldErrors}
                      key={`${submission.id}:${effectiveRouting.teamId ?? ''}:${effectiveWorkItemTypeId}:${conversionProjectId ?? ''}:${effectiveWorkItemConfiguration.scopeId}:${effectiveWorkItemConfiguration.revision}`}
                      locale={locale}
                      values={conversionCustomFieldValues}
                      projectId={conversionProjectId}
                      testId="request-conversion-work-item-fields"
                    />
                  </div>
                ) : null}
                <p className="break-words text-xs font-medium text-[var(--workbench-muted)]">
                  {effectiveRouting.teamId} · {effectiveRouting.projectId ?? t('requests.routing.teamBacklog')} · {effectiveWorkflowStatusId ?? t('requests.routing.initialStatus')} · {effectiveRouting.assigneeUserId} · {t(`requests.priority.${effectiveRouting.priority ?? 'medium'}`)}
                </p>
              </>
            ) : actionMode === 'assign' || actionMode === 'mark-duplicate' ? (
              <input
                aria-label={actionMode === 'assign' ? t('requests.action.assignee') : t('requests.action.targetSubmission')}
                className="workbench-input min-h-10 px-3"
                disabled={actionIsPending}
                required
                value={actionValue}
                onChange={(event) => setActionValue(event.target.value)}
              />
            ) : (
              <textarea
                aria-label={actionMode === 'reject' ? t('requests.action.reason') : t('requests.action.message')}
                className="workbench-input min-h-24 px-3 py-2"
                disabled={actionIsPending}
                required
                value={actionValue}
                onChange={(event) => setActionValue(event.target.value)}
              />
            )}
            {actionError ? <p className="text-sm font-semibold text-red-700" role="alert">{t('requests.action.error')}</p> : null}
            <div className="flex justify-end gap-2">
              <button className="workbench-button-secondary min-h-10 px-4" disabled={actionIsPending} onClick={() => setActionMode(undefined)} type="button">{t('requests.action.cancel')}</button>
              <button className="workbench-button-primary min-h-10 px-4" disabled={actionIsPending || (actionMode === 'convert' && !hasCreatableWorkItemType)} type="submit">{isSubmitting ? t('requests.action.pending') : t('requests.action.submit')}</button>
            </div>
          </form>
        ) : null}
      </div>
    </aside>
  )
}

/**
 * Returns custom fields applicable to the selected conversion type and project.
 *
 * @param configuration - Team-scoped Work Item configuration.
 * @param typeId - Work Item Type selected for conversion.
 * @param projectId - Project selected for conversion, when any.
 * @returns Saveable custom field definitions in display order.
 */
function resolveConversionFieldDefinitions(
  configuration: WorkItemConfiguration,
  typeId: string,
  projectId?: string,
): CustomFieldDefinition[] {
  return resolveWorkItemTypeFormFields(configuration, typeId).filter((definition) =>
    definition.type !== 'formula' && isCustomFieldApplicable(definition, projectId),
  )
}

/**
 * Creates the initial conversion field state from mapped answers and defaults.
 *
 * @param submission - Submission being converted, when available.
 * @param configuration - Team-scoped Work Item configuration, when available.
 * @param typeId - Work Item Type selected for conversion.
 * @param projectId - Project selected for conversion, when any.
 * @returns Custom field values allowed by the selected type and project.
 */
function createConversionCustomFieldValues(
  submission: RequestSubmissionModel | undefined,
  configuration: WorkItemConfiguration | undefined,
  typeId: string,
  projectId?: string,
): Record<string, CustomFieldValue> {
  const mappedValues = createMappedConversionCustomFieldValues(submission)
  if (!configuration) return mappedValues

  const definitions = resolveConversionFieldDefinitions(configuration, typeId, projectId)
  const allowedFieldIds = new Set(definitions.map((definition) => definition.id))
  const values = {
    ...createDefaultCustomFieldValues(definitions, projectId),
    ...mappedValues,
  }

  return Object.fromEntries(
    Object.entries(values).filter(([fieldId]) => allowedFieldIds.has(fieldId)),
  )
}

/**
 * Parses and validates custom fields submitted with a request conversion.
 *
 * @param formData - Conversion form data containing custom field controls.
 * @param definitions - Custom fields displayed for the selected type.
 * @param projectId - Project selected for conversion, when any.
 * @param locale - Locale used for validation messages.
 * @returns Explicit field overrides, including null for cleared fields, and messages.
 */
function parseConversionCustomFieldFormData(
  formData: FormData,
  definitions: readonly CustomFieldDefinition[],
  projectId: string | undefined,
  locale: Locale,
): {
  values: Record<string, CustomFieldValue | null>
  errors: Readonly<Record<string, string | undefined>>
} {
  const parsed = parseCustomFieldFormData(formData, definitions, { projectId })
  const values: Record<string, CustomFieldValue | null> = {}

  for (const definition of definitions) {
    values[definition.id] = parsed.values[definition.id] ?? null
  }

  return {
    errors: createCustomFieldErrorMessages(parsed.errors, definitions, locale),
    values,
  }
}

function DetailSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section>
      <h3 className="mb-3 text-sm font-bold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">{title}</h3>
      {children}
    </section>
  )
}

function ActionButton({ disabled = false, label, onClick, primary = false }: { disabled?: boolean; label: string; onClick: () => void; primary?: boolean }) {
  return <button className={`${primary ? 'workbench-button-primary' : 'workbench-button-secondary'} min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-50`} disabled={disabled} onClick={onClick} type="button">{label}</button>
}

function RequestStatusBadge({ status, t }: { status: RequestSubmissionModel['status']; t: ReturnType<typeof createTranslator> }) {
  const tone = status === 'converted'
    ? 'workbench-badge-success'
    : status === 'rejected' || status === 'duplicate'
      ? 'workbench-badge-danger'
      : status === 'needs-more-info'
        ? 'workbench-badge'
        : 'workbench-badge-primary'

  return <span className={tone}>{t(`requests.status.${status}`)}</span>
}

function formatAnswer(
  answer: RequestSubmissionModel['answers'][number],
  locale: Locale,
  defaultLocale: RequestSubmissionModel['formDefaultLocale'],
  t: ReturnType<typeof createTranslator>,
) {
  const optionLabels = new Map(answer.options.map((option) => [
    option.id,
    resolveRequestLocalizedText(option.label, locale, defaultLocale) || option.id,
  ]))
  const formatValue = (value: string) => optionLabels.get(value) ?? value

  return Array.isArray(answer.value)
    ? answer.value.map(formatValue).join(', ')
    : typeof answer.value === 'boolean'
      ? (answer.value ? t('requests.boolean.true') : t('requests.boolean.false'))
      : typeof answer.value === 'string'
        ? formatValue(answer.value)
        : String(answer.value)
}

function formatDateTime(value: string, locale: Locale) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
