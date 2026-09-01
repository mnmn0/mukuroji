import type {
  AiTriageDraft,
  CreateCustomerRequestFromTriageInput,
  Customer,
  CustomerRequest,
  CustomerRequestImportance,
} from '@mukuroji/contracts'
import {
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import type { AiAssistanceController } from '../../features/ai-assistance/mutations/useAiAssistanceController'
import { AiTriageDraftComposer } from '../../features/ai-assistance/ui/AiTriageDraftComposer'
import type { MessageKey } from '../../shared/i18n/i18n'
import { createTeamIssuesPath } from '../../shared/routing/paths'
import { ShieldIcon } from '../../shared/ui/icons'
import type {
  TriageActionInput,
  TriageEntry,
  TriageEntryState,
} from '../api'
import {
  resolveTriageActionShortcut,
  type TriageActionMode,
} from '../model/keyboard'
import type { TriageEntryView } from '../model/triageView'
import { TriageSourceIcon } from './TriageSourceIcon'

/** Props accepted by the permission-aware triage entry detail pane. */
export type TriageEntryDetailProps = {
  /** Active Workspace member bearer token used only for explicit AI generation. */
  readonly accessToken?: string
  /** Whether the dependent AI API deployment has enabled the route-level controls. */
  readonly aiAssistanceEnabled?: boolean
  /** Optional AI controller override for isolated interaction stories. */
  readonly aiAssistanceController?: AiAssistanceController
  /** Reports authenticated AI failures to the owning Team route session guard. */
  readonly onAuthenticatedApiError?: (error: unknown) => void
  /** Reports AI request state so the owning queue can fence source changes. */
  readonly onOperationPendingChange?: (pending: boolean) => void
  /** Whether an AI generation, decision, or feedback request is in flight. */
  readonly isAiOperationPending?: boolean
  /** Team route identifier used to scope the AI source reference. */
  readonly teamId: string
  /** Project IDs currently visible to the viewer in this Team directory. */
  readonly visibleProjectIds?: readonly string[]
  /** Active non-guest members keyed by their current Team-qualified Project. */
  readonly eligibleAssigneeIdsByProject?: ReadonlyMap<string, ReadonlySet<string>>
  /** Selected permission-safe entry view. */
  readonly view?: TriageEntryView
  /** Current locale used for dates. */
  readonly locale: 'ja' | 'en'
  /** Whether the selected entry detail is loading. */
  readonly isLoading?: boolean
  /** Whether an action is currently running for the selected entry. */
  readonly isPending?: boolean
  /** Safe detail or mutation error. */
  readonly errorMessage?: string
  /** Localized message resolver. */
  readonly t: (key: MessageKey) => string
  /** Returns to the queue-only mobile surface. */
  readonly onBack: () => void
  /** Retries the selected detail query. */
  readonly onRetry?: () => void
  /** Applies one explicit revision-fenced triage action. */
  readonly onAction?: (
    entryId: string,
    input: TriageActionInput,
  ) => Promise<TriageEntry>
  /** Saves one accepted Triage Entry as a Customer Request. */
  readonly onCreateCustomerRequest?: (
    entryId: string,
    input: CreateCustomerRequestFromTriageInput,
  ) => Promise<CustomerRequest>
  /** Customers currently visible to the current Workspace member. */
  readonly customerOptions?: readonly Pick<Customer, 'id' | 'name'>[]
  /** Whether the Customer picker is still loading. */
  readonly isCustomerOptionsLoading?: boolean
  /** Safe error message when the Customer picker cannot load its options. */
  readonly customerOptionsErrorMessage?: string
  /** Retries loading Customer picker options. */
  readonly onRetryCustomerOptions?: () => void
  /** Restores queue navigation after a successful action. */
  readonly onActionComplete?: (entryId: string) => void
}

const stateLabelKeys: Record<TriageEntryState, MessageKey> = {
  accepted: 'triage.state.accepted',
  declined: 'triage.state.declined',
  duplicate: 'triage.state.duplicate',
  'needs-information': 'triage.state.needsInformation',
  pending: 'triage.state.pending',
  snoozed: 'triage.state.snoozed',
}

/** Tracks local routing edits that require confirmation before AI adoption. */
type TriageRoutingDirtyState = {
  /** Whether the owner field contains a local edit. */
  owner: boolean
  /** Whether the Project field contains a local edit. */
  project: boolean
}

/**
 * Renders source context, traceability, routing, activity, and safe action forms.
 *
 * Keyboard shortcuts open forms only; the user must explicitly submit every mutation.
 *
 * @param props - Selected entry, loading state, translations, and callbacks.
 * @returns Responsive entry detail pane.
 */
export function TriageEntryDetail({
  accessToken,
  aiAssistanceEnabled = true,
  aiAssistanceController,
  errorMessage,
  customerOptions,
  customerOptionsErrorMessage,
  isCustomerOptionsLoading = false,
  isAiOperationPending = false,
  isLoading = false,
  isPending = false,
  locale,
  onAuthenticatedApiError,
  onAction,
  onCreateCustomerRequest,
  onActionComplete,
  onBack,
  onOperationPendingChange,
  onRetry,
  onRetryCustomerOptions,
  t,
  teamId,
  eligibleAssigneeIdsByProject,
  visibleProjectIds = [],
  view,
}: TriageEntryDetailProps) {
  const [actionMode, setActionMode] = useState<TriageActionMode>()
  const [acceptMode, setAcceptMode] = useState<'create' | 'link'>('create')
  const [actionError, setActionError] = useState(false)
  const [actionAnnouncement, setActionAnnouncement] = useState('')
  const [customerRequestError, setCustomerRequestError] = useState(false)
  const [customerRequestAnnouncement, setCustomerRequestAnnouncement] = useState('')
  const [customerId, setCustomerId] = useState(view?.entry.customerId ?? '')
  const [customerRequestImportance, setCustomerRequestImportance] =
    useState<CustomerRequestImportance>('normal')
  const [ownerUserId, setOwnerUserId] = useState(view?.entry.ownerUserId ?? '')
  const [projectId, setProjectId] = useState(
    view?.entry.projectId ?? view?.routingCandidate?.projectId ?? '',
  )
  const [, setRoutingDirty] = useState<TriageRoutingDirtyState>({
    owner: false,
    project: false,
  })
  const routingDirtyRef = useRef<TriageRoutingDirtyState>({
    owner: false,
    project: false,
  })
  const actionTrigger = useRef<HTMLButtonElement | null>(null)
  const [isActionMutationPending, setIsActionMutationPending] = useState(false)
  const isActionMutationPendingRef = useRef(false)
  const actionIsPending = isPending || isActionMutationPending || isAiOperationPending

  const submitCustomerRequest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (
      !view ||
      !onCreateCustomerRequest ||
      !customerId ||
      actionIsPending
    ) return
    setCustomerRequestError(false)
    setCustomerRequestAnnouncement('')
    try {
      await onCreateCustomerRequest(view.entry.id, {
        customerId,
        expectedRevision: view.entry.revision,
        importance: customerRequestImportance,
      })
      setCustomerRequestAnnouncement(t('triage.customerRequest.succeeded'))
    } catch {
      setCustomerRequestError(true)
    }
  }

  const closeAction = () => {
    setActionMode(undefined)
    setActionError(false)
    actionTrigger.current?.focus()
  }
  const activateAction = (
    mode: TriageActionMode,
    trigger?: HTMLButtonElement,
  ) => {
    if (actionIsPending) return
    actionTrigger.current = trigger ?? null
    setActionError(false)
    setActionAnnouncement('')
    setOwnerUserId(view?.entry.ownerUserId ?? '')
    setProjectId(view?.entry.projectId ?? view?.routingCandidate?.projectId ?? '')
    const cleanState = { owner: false, project: false }
    routingDirtyRef.current = cleanState
    setRoutingDirty(cleanState)
    setActionMode(mode)
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!view || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if (event.key === 'Escape' && actionMode) {
      event.preventDefault()
      closeAction()
      return
    }
    if (event.altKey || event.ctrlKey || event.metaKey || actionIsPending) return
    const shortcut = resolveTriageActionShortcut(
      event.key,
      event.target,
      view.entry.capabilities,
    )
    if (!shortcut) return
    event.preventDefault()
    activateAction(
      shortcut,
      event.target instanceof HTMLButtonElement ? event.target : undefined,
    )
  }

  if (isLoading) {
    return <DetailSkeleton label={t('triage.detail.loading')} />
  }

  if (!view) {
    return (
      <aside className="grid min-h-[520px] place-items-center bg-white p-8 text-center" data-testid="triage-detail-empty">
        <div>
          <p className="text-sm font-semibold text-[var(--workbench-text)]">{t('triage.detail.empty')}</p>
          {errorMessage ? (
            <div className="mt-4 grid justify-items-center gap-3" role="alert">
              <p className="text-sm font-semibold text-red-700">{errorMessage}</p>
              {onRetry ? (
                <button className="workbench-button-secondary min-h-10 px-4" onClick={onRetry} type="button">
                  {t('triage.detail.retry')}
                </button>
              ) : null}
            </div>
          ) : null}
          <button
            className="workbench-button-secondary mt-4 min-h-10 px-4"
            onClick={onBack}
            type="button"
          >
            {t('triage.detail.back')}
          </button>
        </div>
      </aside>
    )
  }

  const entry = view.entry
  const canonicalPath = entry.canonicalWorkItem
    ? createTeamIssuesPath(
        entry.canonicalWorkItem.teamId,
        entry.canonicalWorkItem.workItemId,
      )
    : undefined

  /** Returns whether this AI draft would replace a locally edited routing field. */
  const shouldConfirmTriageAdoption = (draft: AiTriageDraft) => (
    (draft.assigneeUserId !== undefined && routingDirtyRef.current.owner) ||
    (draft.projectId !== undefined && routingDirtyRef.current.project)
  )

  /** Copies only owner and Project fields supported by the existing triage action contracts. */
  const adoptTriageDraft = (draft: AiTriageDraft, replacementConfirmed = false) => {
    if (actionIsPending || isActionMutationPendingRef.current) return
    if (shouldConfirmTriageAdoption(draft) && !replacementConfirmed) return
    setActionError(false)
    setActionAnnouncement('')
    if (draft.assigneeUserId !== undefined) {
      setOwnerUserId(draft.assigneeUserId.value)
      const nextDirtyState = { ...routingDirtyRef.current, owner: false }
      routingDirtyRef.current = nextDirtyState
      setRoutingDirty(nextDirtyState)
    }
    if (draft.projectId !== undefined) {
      setProjectId(draft.projectId.value)
      const nextDirtyState = { ...routingDirtyRef.current, project: false }
      routingDirtyRef.current = nextDirtyState
      setRoutingDirty(nextDirtyState)
    }
    if (draft.assigneeUserId && entry.capabilities.canAssign) {
      setActionMode('assign')
      return
    }
    if (entry.capabilities.canAcceptCreate) {
      setAcceptMode('create')
      setActionMode('accept')
      return
    }
    if (entry.capabilities.canAssign) setActionMode('assign')
  }

  const submitAction = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!actionMode || !onAction || actionIsPending || isActionMutationPendingRef.current) return
    const formData = new FormData(event.currentTarget)
    const input = createActionInput(entry, actionMode, acceptMode, formData)
    if (!input) {
      setActionError(true)
      return
    }
    setActionError(false)
    isActionMutationPendingRef.current = true
    setIsActionMutationPending(true)
    try {
      await onAction(entry.id, input)
      setActionMode(undefined)
      setActionAnnouncement(t('triage.action.succeeded'))
      if (onActionComplete) onActionComplete(entry.id)
      else actionTrigger.current?.focus()
    } catch {
      setActionError(true)
    } finally {
      isActionMutationPendingRef.current = false
      setIsActionMutationPending(false)
    }
  }

  return (
    <aside
      aria-label={t('triage.detail.aria')}
      className="min-w-0 bg-white"
      data-testid="triage-entry-detail"
      onKeyDown={handleKeyDown}
    >
      <div className="sticky top-0 z-10 border-b border-[var(--workbench-border)] bg-white px-5 py-4 max-[860px]:px-4">
        <button
          className="mb-3 hidden min-h-10 items-center gap-2 text-sm font-semibold text-[var(--workbench-primary)] disabled:cursor-not-allowed disabled:opacity-50 max-[860px]:inline-flex"
          onClick={onBack}
          disabled={actionIsPending}
          type="button"
        >
          ← {t('triage.detail.back')}
        </button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
              <TriageSourceIcon className="h-4 w-4 fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]" source={entry.source.kind} />
              {view.sourceLabel}
            </p>
            <h2 className="mt-2 max-w-[780px] text-xl font-semibold text-[var(--workbench-text)]">
              {view.title ?? t('triage.permission.restrictedTitle')}
            </h2>
            <p className="mt-2 text-sm font-medium text-[var(--workbench-muted)]">
              {entry.permission.visibility === 'denied'
                ? t('triage.permission.denied')
                : `${entry.requester.displayName}${entry.requester.guest ? ` · ${t('triage.detail.guest')}` : ''}`}
            </p>
          </div>
          <span className={stateTone(entry.state)}>{t(stateLabelKeys[entry.state])}</span>
        </div>
      </div>

      <div className="grid gap-6 p-5 max-[860px]:p-4">
        <p aria-live="polite" className="sr-only" role="status">
          {actionAnnouncement}
        </p>
        {errorMessage || actionError ? (
          <p className="border-l-2 border-red-400 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700" role="alert">
            {errorMessage ?? t('triage.action.error')}
          </p>
        ) : null}

        <PermissionNotice entry={entry} locale={locale} t={t} />

        {entry.permission.visibility === 'full' ? (
          <>
            <DetailSection title={t('triage.detail.sourcePreview')}>
              <p className="whitespace-pre-wrap break-words text-sm font-medium leading-6 text-[var(--workbench-text)]">
                {view.body || t('triage.detail.sourceBodyEmpty')}
              </p>
              {entry.sourcePreview.sanitized || entry.sourcePreview.truncated ? (
                <p className="mt-3 text-xs font-semibold text-amber-700">
                  {entry.sourcePreview.sanitized && entry.sourcePreview.truncated
                    ? t('triage.detail.sanitizedAndTruncated')
                    : entry.sourcePreview.sanitized
                      ? t('triage.detail.sanitized')
                      : t('triage.detail.truncated')}
                </p>
              ) : null}
            </DetailSection>
            {aiAssistanceEnabled && (accessToken || aiAssistanceController) && (
              entry.capabilities.canAcceptCreate || entry.capabilities.canAssign
            ) ? (
              <AiTriageDraftComposer
                accessToken={accessToken}
                adoptLabel={t('ai.triage.adoptTeam')}
                controller={aiAssistanceController}
                locale={locale}
                onAuthenticatedApiError={onAuthenticatedApiError}
                onAdoptDraft={adoptTriageDraft}
                onOperationPendingChange={onOperationPendingChange}
                canAdoptDraft={(draft) => {
                  const hasInvalidProject = draft.projectId !== undefined &&
                    !visibleProjectIds.includes(draft.projectId.value)
                  const hasUnsupportedAssignee =
                    draft.assigneeUserId !== undefined && !entry.capabilities.canAssign
                  const hasSupportedAssignee =
                    draft.assigneeUserId !== undefined &&
                    entry.capabilities.canAssign &&
                    isEligibleAssigneeForTriage(
                      draft.assigneeUserId.value,
                      draft.projectId?.value ?? (projectId || undefined),
                      eligibleAssigneeIdsByProject,
                    )
                  const hasInvalidAssignee = draft.assigneeUserId !== undefined &&
                    !hasSupportedAssignee
                  const hasSupportedProject =
                    draft.projectId !== undefined &&
                    !hasInvalidProject &&
                    (entry.capabilities.canAssign || entry.capabilities.canAcceptCreate)
                  return !hasInvalidProject &&
                    !hasUnsupportedAssignee &&
                    !hasInvalidAssignee &&
                    (hasSupportedAssignee || hasSupportedProject)
                }}
                // AI requests must be allowed to start; only domain mutations
                // disable the composer itself. The combined action state still
                // fences every external triage control above and below.
                isMutationPending={isPending || isActionMutationPending}
                shouldConfirmAdoption={shouldConfirmTriageAdoption}
                source={{
                  expectedRevision: entry.revision,
                  teamId,
                  triageEntryId: entry.id,
                  type: 'triage-entry',
                }}
                t={t}
              />
            ) : null}
          </>
        ) : null}

        <DetailSection title={t('triage.detail.trace')}>
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <DetailTerm label={t('triage.detail.sourceId')} value={entry.source.sourceId} />
            <DetailTerm label={t('triage.detail.receivedAt')} value={formatDateTime(entry.receivedAt, locale)} />
            <DetailTerm label={t('triage.detail.lastActivityAt')} value={formatDateTime(entry.lastActivityAt, locale)} />
            {entry.source.provider ? <DetailTerm label={t('triage.detail.provider')} value={entry.source.provider} /> : null}
            {entry.requester.email && entry.permission.visibility === 'full' ? (
              <DetailTerm label={t('triage.detail.requesterEmail')} value={entry.requester.email} />
            ) : null}
          </dl>
          {entry.permission.visibility !== 'denied' && entry.sourcePreview.permalink ? (
            <a
              className="mt-4 inline-flex min-h-10 items-center text-sm font-semibold text-[var(--workbench-primary)] underline-offset-4 hover:underline"
              href={entry.sourcePreview.permalink}
              rel="noreferrer noopener"
              target="_blank"
            >
              {t('triage.detail.openSource')} ↗
            </a>
          ) : null}
        </DetailSection>

        <DetailSection title={t('triage.detail.contextCounts')}>
          <div className="grid grid-cols-3 divide-x divide-[var(--workbench-border)] border-y border-[var(--workbench-border)] py-3 text-center">
            <ContextCount label={t('triage.detail.attachments')} value={entry.sourcePreview.attachmentCount} />
            <ContextCount label={t('triage.detail.comments')} value={entry.sourcePreview.commentCount} />
            <ContextCount label={t('triage.detail.watchers')} value={entry.sourcePreview.watcherCount} />
          </div>
        </DetailSection>

        {entry.capabilities.canViewInternalContext ? (
          <DetailSection title={t('triage.detail.routing')}>
            <p className="text-sm font-medium leading-6 text-[var(--workbench-text)]">{entry.routing.reason}</p>
            {entry.routing.candidates.length > 0 ? (
              <ol className="mt-3 divide-y divide-[var(--workbench-border)] border-y border-[var(--workbench-border)]">
                {entry.routing.candidates.map((candidate) => (
                  <li className="flex items-start justify-between gap-3 py-3 text-sm" key={`${candidate.teamId}:${candidate.projectId ?? ''}:${candidate.reason}`}>
                    <span>
                      <strong className="block text-[var(--workbench-text)]">
                        {candidate.teamId}{candidate.projectId ? ` / ${candidate.projectId}` : ''}
                      </strong>
                      <span className="mt-1 block text-xs font-medium text-[var(--workbench-muted)]">{candidate.reason}</span>
                    </span>
                    <span className={candidate.permitted ? 'workbench-badge-success' : 'workbench-badge-danger'}>
                      {candidate.permitted ? t('triage.detail.routePermitted') : t('triage.detail.routeDenied')}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-2 text-sm font-medium text-[var(--workbench-muted)]">{t('triage.detail.routingEmpty')}</p>
            )}
          </DetailSection>
        ) : null}

        <DetailSection title={t('triage.detail.serviceBoundary')}>
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <DetailTerm
              label={t('triage.detail.owner')}
              value={entry.ownerUserId ?? t('triage.queue.unowned')}
            />
            <DetailTerm
              label={t('triage.detail.slaDueAt')}
              value={entry.sla ? formatDateTime(entry.sla.dueAt, locale) : t('triage.sla.paused')}
            />
            <DetailTerm
              label={t('triage.detail.retentionExpiresAt')}
              value={formatDateTime(entry.retention.expiresAt, locale)}
            />
            {entry.snoozedUntil ? (
              <DetailTerm label={t('triage.detail.snoozedUntil')} value={formatDateTime(entry.snoozedUntil, locale)} />
            ) : null}
          </dl>
        </DetailSection>

        {entry.capabilities.canViewInternalContext && entry.events.length > 0 ? (
          <DetailSection title={t('triage.detail.activity')}>
            <ol className="divide-y divide-[var(--workbench-border)] border-y border-[var(--workbench-border)]">
              {entry.events.map((activity) => (
                <li className="py-3 text-sm" key={activity.id}>
                  <p className="font-semibold text-[var(--workbench-text)]">{activity.summary}</p>
                  <p className="mt-1 text-xs font-medium text-[var(--workbench-muted)]">
                    {activity.actorId} · {formatDateTime(activity.createdAt, locale)}
                  </p>
                </li>
              ))}
            </ol>
          </DetailSection>
        ) : null}

        {entry.mergeReceipt ? (
          <DetailSection title={t('triage.detail.mergeReceipt')}>
            <p className="text-sm font-semibold text-[var(--workbench-text)]">
              {t('triage.detail.mergeReceiptSummary')
                .replace('{sources}', String(entry.mergeReceipt.mergedSourceCount))
                .replace('{comments}', String(entry.mergeReceipt.mergedCommentCount))
                .replace('{attachments}', String(entry.mergeReceipt.mergedAttachmentCount))
                .replace('{watchers}', String(entry.mergeReceipt.mergedWatcherCount))}
            </p>
          </DetailSection>
        ) : null}

        {entry.state === 'accepted' && onCreateCustomerRequest && entry.permission.visibility === 'full' ? (
          <DetailSection title={t('triage.detail.customerRequest')}>
            {entry.customerRequestId ? (
              <p className="text-sm font-semibold text-[var(--workbench-text)]">
                {t('triage.customerRequest.associated').replace('{id}', entry.customerRequestId)}
              </p>
            ) : isCustomerOptionsLoading ? (
              <p className="text-sm font-medium text-[var(--workbench-muted)]" role="status">
                {t('triage.customerRequest.loading')}
              </p>
            ) : customerOptionsErrorMessage ? (
              <div className="grid gap-3 border-l-2 border-red-400 bg-red-50 px-3 py-2" role="alert">
                <p className="text-sm font-semibold text-red-700">{customerOptionsErrorMessage}</p>
                {onRetryCustomerOptions ? (
                  <button
                    className="workbench-button-secondary min-h-9 w-fit px-3"
                    onClick={onRetryCustomerOptions}
                    type="button"
                  >
                    {t('customers.retry')}
                  </button>
                ) : null}
              </div>
            ) : customerOptions === undefined ? null : customerOptions.length === 0 ? (
              <p className="text-sm font-medium text-[var(--workbench-muted)]">
                {t('triage.customerRequest.noCustomers')}
              </p>
            ) : (
              <form className="grid gap-4" onSubmit={(event) => void submitCustomerRequest(event)}>
                <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
                  {t('triage.customerRequest.customer')}
                  <select
                    className="workbench-input min-h-10 px-3"
                    onChange={(event) => setCustomerId(event.target.value)}
                    required
                    value={customerId}
                  >
                    <option value="">{t('triage.customerRequest.chooseCustomer')}</option>
                    {customerOptions.map((customer) => (
                      <option key={customer.id} value={customer.id}>{customer.name}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
                  {t('triage.customerRequest.importance')}
                  <select
                    className="workbench-input min-h-10 px-3"
                    onChange={(event) => setCustomerRequestImportance(
                      readCustomerRequestImportance(event.target.value),
                    )}
                    value={customerRequestImportance}
                  >
                    <option value="low">{t('customers.values.importance.low')}</option>
                    <option value="normal">{t('customers.values.importance.normal')}</option>
                    <option value="high">{t('customers.values.importance.high')}</option>
                    <option value="urgent">{t('customers.values.importance.urgent')}</option>
                  </select>
                </label>
                {customerRequestError ? (
                  <p className="border-l-2 border-red-400 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700" role="alert">
                    {t('triage.customerRequest.error')}
                  </p>
                ) : null}
                <p aria-live="polite" className="sr-only" role="status">
                  {customerRequestAnnouncement}
                </p>
                <button
                  className="workbench-button-primary min-h-10 w-fit px-4"
                  disabled={actionIsPending}
                  type="submit"
                >
                  {actionIsPending ? t('triage.customerRequest.saving') : t('triage.customerRequest.save')}
                </button>
              </form>
            )}
          </DetailSection>
        ) : null}

        {canonicalPath ? (
          <a className="workbench-button-primary inline-flex min-h-10 w-fit items-center justify-center px-4 no-underline" href={canonicalPath}>
            {t('triage.detail.openCanonical')}
          </a>
        ) : null}

        <div className="border-t border-[var(--workbench-border)] pt-5">
          <div className="flex flex-wrap gap-2" aria-label={t('triage.action.aria')}>
            {entry.capabilities.canAssign ? (
              <ActionButton disabled={actionIsPending} label={t('triage.action.assign')} onActivate={activateAction} mode="assign" />
            ) : null}
            {(entry.capabilities.canAcceptCreate || entry.capabilities.canAcceptLink) ? (
              <ActionButton disabled={actionIsPending} shortcut="A" label={t('triage.action.accept')} primary onActivate={activateAction} mode="accept" />
            ) : null}
            {entry.capabilities.canMarkDuplicate ? (
              <ActionButton disabled={actionIsPending} shortcut="D" label={t('triage.action.duplicate')} onActivate={activateAction} mode="duplicate" />
            ) : null}
            {entry.capabilities.canRequestInformation && entry.capabilities.canReply ? (
              <ActionButton disabled={actionIsPending} shortcut="I" label={t('triage.action.requestInformation')} onActivate={activateAction} mode="request-information" />
            ) : null}
            {entry.capabilities.canSnooze ? (
              <ActionButton disabled={actionIsPending} shortcut="S" label={t('triage.action.snooze')} onActivate={activateAction} mode="snooze" />
            ) : null}
            {entry.capabilities.canDecline ? (
              <ActionButton disabled={actionIsPending} shortcut="X" label={t('triage.action.decline')} onActivate={activateAction} mode="decline" />
            ) : null}
          </div>
          {!hasAnyAction(entry) ? (
            <p className="text-sm font-semibold text-[var(--workbench-muted)]">{t('triage.action.readOnly')}</p>
          ) : null}
        </div>

        {actionMode ? (
          <form
            className="grid gap-4 border-l-2 border-[var(--workbench-primary)] bg-[var(--workbench-surface-muted)] p-4"
            data-testid={`triage-action-${actionMode}`}
            onSubmit={(event) => void submitAction(event)}
          >
            <h3 className="text-base font-semibold text-[var(--workbench-text)]">
              {t(actionTitleKey(actionMode))}
            </h3>
            {actionMode === 'assign' ? (
              <>
                <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
                  {t('triage.action.ownerUserId')}
                  <input
                    autoFocus
                    className="workbench-input min-h-10 px-3"
                    name="ownerUserId"
                    onChange={(event) => {
                      setOwnerUserId(event.target.value)
                      const nextDirtyState = { ...routingDirtyRef.current, owner: true }
                      routingDirtyRef.current = nextDirtyState
                      setRoutingDirty(nextDirtyState)
                    }}
                    placeholder={t('triage.action.ownerOptional')}
                    value={ownerUserId}
                  />
                </label>
                <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
                  {t('triage.action.projectId')}
                  <input
                    className="workbench-input min-h-10 px-3"
                    name="projectId"
                    onChange={(event) => {
                      setProjectId(event.target.value)
                      const nextDirtyState = { ...routingDirtyRef.current, project: true }
                      routingDirtyRef.current = nextDirtyState
                      setRoutingDirty(nextDirtyState)
                    }}
                    placeholder={t('triage.action.projectOptional')}
                    value={projectId}
                  />
                </label>
              </>
            ) : actionMode === 'accept' ? (
              <>
                <div className="flex gap-2" role="group" aria-label={t('triage.action.acceptMode')}>
                  {entry.capabilities.canAcceptCreate ? (
                    <button
                      aria-pressed={acceptMode === 'create'}
                      className={modeButtonClass(acceptMode === 'create')}
                      onClick={() => setAcceptMode('create')}
                      type="button"
                    >
                      {t('triage.action.acceptCreate')}
                    </button>
                  ) : null}
                  {entry.capabilities.canAcceptLink ? (
                    <button
                      aria-pressed={acceptMode === 'link'}
                      className={modeButtonClass(acceptMode === 'link')}
                      onClick={() => setAcceptMode('link')}
                      type="button"
                    >
                      {t('triage.action.acceptLink')}
                    </button>
                  ) : null}
                </div>
                {acceptMode === 'create' && entry.capabilities.canAcceptCreate ? (
                  <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
                    {t('triage.action.projectId')}
                    <input
                      autoFocus
                      className="workbench-input min-h-10 px-3"
                      name="projectId"
                      onChange={(event) => {
                        setProjectId(event.target.value)
                        const nextDirtyState = { ...routingDirtyRef.current, project: true }
                        routingDirtyRef.current = nextDirtyState
                        setRoutingDirty(nextDirtyState)
                      }}
                      placeholder={t('triage.action.projectOptional')}
                      value={projectId}
                    />
                  </label>
                ) : (
                  <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
                    {t('triage.action.workItemId')}
                    <input autoFocus className="workbench-input min-h-10 px-3" name="workItemId" required />
                  </label>
                )}
              </>
            ) : actionMode === 'duplicate' ? (
              <>
                <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
                  {t('triage.action.canonicalWorkItemId')}
                  <input autoFocus className="workbench-input min-h-10 px-3" name="canonicalWorkItemId" required />
                </label>
                <p className="text-sm font-medium text-[var(--workbench-muted)]">
                  {t('triage.action.mergeContext')
                    .replace('{comments}', String(entry.sourcePreview.commentCount))
                    .replace('{attachments}', String(entry.sourcePreview.attachmentCount))
                    .replace('{watchers}', String(entry.sourcePreview.watcherCount))}
                </p>
              </>
            ) : actionMode === 'snooze' ? (
              <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
                {t('triage.action.snoozeUntil')}
                <input autoFocus className="workbench-input min-h-10 px-3" min={toLocalDateTime(new Date())} name="until" required type="datetime-local" />
              </label>
            ) : (
              <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
                {actionMode === 'decline' ? t('triage.action.reason') : t('triage.action.message')}
                <textarea autoFocus className="workbench-input min-h-28 px-3 py-2" name={actionMode === 'decline' ? 'reason' : 'message'} required />
              </label>
            )}
            <div className="flex justify-end gap-2">
              <button className="workbench-button-secondary min-h-10 px-4" disabled={actionIsPending} onClick={closeAction} type="button">
                {t('triage.action.cancel')}
              </button>
              <button className="workbench-button-primary min-h-10 px-4" disabled={actionIsPending} type="submit">
                {actionIsPending ? t('triage.action.pending') : t('triage.action.submit')}
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </aside>
  )
}

/** Renders the live source-visibility boundary for a restricted entry. */
function PermissionNotice({ entry, locale, t }: {
  entry: TriageEntry
  locale: 'ja' | 'en'
  t: (key: MessageKey) => string
}) {
  if (entry.permission.visibility === 'full') return null
  return (
    <section className={`border-l-2 px-4 py-3 ${entry.permission.visibility === 'denied' ? 'border-red-400 bg-red-50' : 'border-amber-400 bg-amber-50'}`} role={entry.permission.visibility === 'denied' ? 'alert' : 'status'}>
      <div className="flex items-start gap-3">
        <ShieldIcon className="mt-0.5 h-5 w-5 flex-none fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]" />
        <div>
          <h3 className="text-sm font-semibold text-[var(--workbench-text)]">
            {t(`triage.permission.${entry.permission.visibility}`)}
          </h3>
          <p className="mt-1 text-sm font-medium text-[var(--workbench-muted)]">
            {entry.permission.reasonCode ?? t('triage.permission.restrictedDescription')}
          </p>
          <p className="mt-2 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('triage.permission.checkedAt')} {formatDateTime(entry.permission.checkedAt, locale)}
          </p>
        </div>
      </div>
    </section>
  )
}

/** Renders one labeled detail section without nested card styling. */
function DetailSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section>
      <h3 className="mb-3 text-xs font-bold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">{title}</h3>
      {children}
    </section>
  )
}

/** Renders one term and value inside detail metadata. */
function DetailTerm({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="font-semibold text-[var(--workbench-muted)]">{label}</dt>
      <dd className="min-w-0 break-words font-medium text-[var(--workbench-text)]">{value}</dd>
    </>
  )
}

/**
 * Checks an AI-proposed owner against the current active member directory.
 *
 * A Project-qualified lookup is preferred whenever the entry has a destination
 * Project. When no destination exists, an active member in any visible Team
 * Project is accepted; an absent directory fails closed.
 *
 * @param assigneeUserId - Proposed Workspace member identifier.
 * @param projectId - Proposed or current destination Project identifier.
 * @param eligibleAssigneeIdsByProject - Current active member keys by Project.
 * @returns Whether the owner is eligible for the destination.
 */
function isEligibleAssigneeForTriage(
  assigneeUserId: string,
  projectId: string | undefined,
  eligibleAssigneeIdsByProject: ReadonlyMap<string, ReadonlySet<string>> | undefined,
): boolean {
  if (!eligibleAssigneeIdsByProject) return false
  const normalizedAssignee = assigneeUserId.trim().toLowerCase()
  if (!normalizedAssignee) return false
  if (projectId) {
    const eligibleMembers = eligibleAssigneeIdsByProject.get(projectId.trim().toLowerCase())
    return eligibleMembers?.has(normalizedAssignee) ?? false
  }
  for (const eligibleMembers of eligibleAssigneeIdsByProject.values()) {
    if (eligibleMembers.has(normalizedAssignee)) return true
  }
  return false
}

/** Renders one retained source-context count. */
function ContextCount({ label, value }: { label: string; value: number }) {
  return (
    <div className="px-2">
      <strong className="block text-lg text-[var(--workbench-text)]">{value}</strong>
      <span className="mt-1 block text-xs font-semibold text-[var(--workbench-muted)]">{label}</span>
    </div>
  )
}

/** Opens one explicit action form and shows its keyboard shortcut. */
function ActionButton({ disabled = false, label, mode, onActivate, primary = false, shortcut }: {
  disabled?: boolean
  label: string
  mode: TriageActionMode
  onActivate: (mode: TriageActionMode, trigger?: HTMLButtonElement) => void
  primary?: boolean
  shortcut?: string
}) {
  return (
    <button
      className={`${primary ? 'workbench-button-primary' : 'workbench-button-secondary'} min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-50`}
      disabled={disabled}
      onClick={(event) => onActivate(mode, event.currentTarget)}
      type="button"
    >
      {label} {shortcut ? <kbd className="ml-1 text-[10px] opacity-70">{shortcut}</kbd> : null}
    </button>
  )
}

/** Renders the stable loading skeleton for a selected entry. */
function DetailSkeleton({ label }: { label: string }) {
  return (
    <aside aria-label={label} className="animate-pulse bg-white p-6 motion-reduce:animate-none" role="status">
      <div className="h-4 w-24 rounded bg-slate-200" />
      <div className="mt-4 h-7 w-3/4 rounded bg-slate-200" />
      <div className="mt-8 h-36 rounded bg-slate-100" />
      <div className="mt-6 h-24 rounded bg-slate-100" />
    </aside>
  )
}

/** Builds a revision-fenced action from a reviewed detail form. */
function createActionInput(
  entry: TriageEntry,
  actionMode: TriageActionMode,
  acceptMode: 'create' | 'link',
  formData: FormData,
): TriageActionInput | undefined {
  const expectedRevision = entry.revision
  if (actionMode === 'assign') {
    const ownerUserId = readFormValue(formData, 'ownerUserId')
    const projectId = readFormValue(formData, 'projectId')
    return {
      action: 'assign',
      expectedRevision,
      ownerUserId: ownerUserId || null,
      projectId: projectId || null,
    }
  }
  if (actionMode === 'accept') {
    if (acceptMode === 'create' && entry.capabilities.canAcceptCreate) {
      const projectId = readFormValue(formData, 'projectId')
      return {
        action: 'accept',
        expectedRevision,
        mode: 'create',
        ...(projectId ? { projectId } : {}),
      }
    }
    const workItemId = readFormValue(formData, 'workItemId')
    return workItemId
      ? { action: 'accept', expectedRevision, mode: 'link', workItemId }
      : undefined
  }
  if (actionMode === 'duplicate') {
    const canonicalWorkItemId = readFormValue(formData, 'canonicalWorkItemId')
    return canonicalWorkItemId
      ? { action: 'duplicate', canonicalWorkItemId, expectedRevision }
      : undefined
  }
  if (actionMode === 'decline') {
    const reason = readFormValue(formData, 'reason')
    return reason ? { action: 'decline', expectedRevision, reason } : undefined
  }
  if (actionMode === 'request-information') {
    const message = readFormValue(formData, 'message')
    return message
      ? { action: 'request-information', expectedRevision, message }
      : undefined
  }
  const localUntil = readFormValue(formData, 'until')
  const until = localUntil ? new Date(localUntil) : undefined
  return until && !Number.isNaN(until.getTime())
    ? { action: 'snooze', expectedRevision, until: until.toISOString() }
    : undefined
}

/** Resolves the localized heading used by an action form. */
function actionTitleKey(mode: TriageActionMode): MessageKey {
  if (mode === 'assign') return 'triage.action.assign'
  if (mode === 'accept') return 'triage.action.accept'
  if (mode === 'duplicate') return 'triage.action.duplicate'
  if (mode === 'decline') return 'triage.action.decline'
  if (mode === 'request-information') return 'triage.action.requestInformation'
  return 'triage.action.snooze'
}

/** Checks whether an entry exposes any operator decision. */
function hasAnyAction(entry: TriageEntry) {
  const capabilities = entry.capabilities
  return capabilities.canAssign || capabilities.canAcceptCreate || capabilities.canAcceptLink ||
    capabilities.canMarkDuplicate || capabilities.canDecline ||
    capabilities.canSnooze ||
    (capabilities.canRequestInformation && capabilities.canReply)
}

/** Resolves the semantic badge class for an entry state. */
function stateTone(state: TriageEntryState) {
  if (state === 'accepted') return 'workbench-badge-success'
  if (state === 'declined' || state === 'duplicate') return 'workbench-badge-danger'
  if (state === 'needs-information' || state === 'snoozed') return 'workbench-badge'
  return 'workbench-badge-primary'
}

/** Resolves selected and unselected accept-mode button styles. */
function modeButtonClass(active: boolean) {
  return `min-h-10 rounded-md border px-4 text-sm font-semibold ${active
    ? 'border-[var(--workbench-primary)] bg-teal-50 text-[var(--workbench-primary)]'
    : 'border-[var(--workbench-border)] bg-white text-[var(--workbench-text)]'}`
}

/** Keeps Customer Request importance inside the supported contract values. */
function readCustomerRequestImportance(value: string): CustomerRequestImportance {
  if (value === 'low' || value === 'high' || value === 'urgent') return value
  return 'normal'
}

/** Reads and trims one string field from an action form. */
function readFormValue(formData: FormData, key: string) {
  const value = formData.get(key)
  return typeof value === 'string' ? value.trim() : ''
}

/** Formats an ISO timestamp using the active locale with a safe fallback. */
function formatDateTime(value: string, locale: 'ja' | 'en') {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

/** Formats a Date for a local `datetime-local` input. */
function toLocalDateTime(date: Date) {
  const offsetDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return offsetDate.toISOString().slice(0, 16)
}
