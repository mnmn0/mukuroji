import type {
  AiPlanningStatusUpdateDraft,
  AiPlanningTargetSource,
  PlanningCadence,
  PlanningHealth,
  PlanningRisk,
  PlanningUpdateEvidence,
} from '@mukuroji/contracts'
import { useEffect, useRef, useState } from 'react'
import { createAiAssistantSessionKey } from '../../features/ai-assistance/model/assistantSessionKey'
import { AiPlanningStatusUpdateAssistant } from '../../features/ai-assistance/ui/AiPlanningStatusUpdateAssistant'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'
import { routeAiPlanningDraftAdoption } from '../model/aiDraftAdoption'
import { isValidPlanningDateTime, readNonNegativeNumber } from '../model/cadenceForm'
import {
  readPlanningUpdateEvidence,
  readPlanningUpdateEvidenceType,
  submitPlanningUpdateCommentAndReset,
  type PlanningTargetUpdateView,
  type PlanningStatusUpdateDraft,
  type PlanningUpdateCollaborationController,
  type PlanningUpdateCadenceDraft,
  type PlanningUpdateChangeField,
  type PlanningUpdateEvidenceCandidates,
  type PlanningUpdateFreshness,
  type PlanningUpdateTargetSummaryView,
} from '../model/statusUpdateView'

/** Localized copy used by planning update presentation and forms. */
export type PlanningUpdateLabels = {
  /** Update delivery-state column heading. */
  updateState: string
  /** Latest update column heading. */
  latestUpdate: string
  /** Project update-target label. */
  projectTarget: string
  /** Initiative update-target label. */
  initiativeTarget: string
  /** Next deadline label. */
  nextDueAt: string
  /** Label shown when no update has been published. */
  neverUpdated: string
  /** Label shown when no cadence deadline is configured. */
  noDueDate: string
  /** Delivery-state labels kept separate from health labels. */
  freshnessValues: Record<PlanningUpdateFreshness, string>
  /** Formats one update author and publication timestamp. */
  statusUpdateMeta: (authorMemberKey: string, createdAt: string) => string
  /** Formats one authoritative deadline timestamp. */
  dueAtMeta: (nextDueAt: string, timeZone?: string) => string
  /** Update schedule panel heading. */
  cadenceTitle: string
  /** Update schedule panel description. */
  cadenceDescription: string
  /** Update owner field label. */
  updateOwner: string
  /** Cadence field label. */
  updateCadence: string
  /** Week cadence option label. */
  cadenceWeek: string
  /** Month cadence option label. */
  cadenceMonth: string
  /** Time-zone field label. */
  timeZone: string
  /** Reminder field label. */
  reminder: string
  /** Escalation field label. */
  escalation: string
  /** Escalation recipient field label. */
  escalationOwner: string
  /** Schedule save action label. */
  saveCadence: string
  /** Schedule clear action label. */
  clearCadence: string
  /** Read-only schedule explanation. */
  cadenceDisabled: string
  /** Structured composer heading. */
  composerTitle: string
  /** Structured composer description. */
  composerDescription: string
  /** Required-field hint shown above the composer. */
  composerRequiredHint: string
  /** Form validation error shown when a structured form cannot be submitted. */
  formInvalid: string
  /** Health field label. */
  health: string
  /** Localized planning-health values. */
  healthValues: Record<PlanningHealth, string>
  /** Structured risk severity field label. */
  risk: string
  /** Localized structured risk values. */
  riskValues: Record<PlanningRisk, string>
  /** Summary field label. */
  summary: string
  /** Progress snapshot field label. */
  progressSnapshot: string
  /** Risk narrative field label. */
  riskSummary: string
  /** Decision field label. */
  decisionSummary: string
  /** Help-needed field label. */
  helpNeeded: string
  /** Next-action field label. */
  nextAction: string
  /** Evidence section and field label. */
  evidence: string
  /** Evidence discriminator field label. */
  evidenceType: string
  /** No-evidence option label. */
  evidenceNone: string
  /** Canonical Work Item evidence option label. */
  evidenceWorkItem: string
  /** Canonical Planning entity evidence option label. */
  evidencePlanningEntity: string
  /** File evidence option label. */
  evidenceFile: string
  /** Generic HTTPS evidence option label. */
  evidenceLink: string
  /** Work Item selector placeholder. */
  evidenceWorkItemPlaceholder: string
  /** Planning entity selector placeholder. */
  evidencePlanningEntityPlaceholder: string
  /** File ID field placeholder. */
  evidenceFileIdPlaceholder: string
  /** Evidence label placeholder. */
  evidenceLabelPlaceholder: string
  /** Evidence URL placeholder. */
  evidenceUrlPlaceholder: string
  /** Publish action label. */
  publishUpdate: string
  /** Immutable history heading. */
  historyTitle: string
  /** Immutable history description. */
  historyDescription: string
  /** Empty history heading. */
  noStatusUpdates: string
  /** Empty history supporting copy. */
  noStatusUpdatesDescription: string
  /** Immutable status badge label. */
  immutable: string
  /** History loading-state label. */
  historyLoading: string
  /** History error-state label. */
  historyError: string
  /** History retry action label. */
  retryHistory: string
  /** Action label for loading the next immutable history page. */
  loadMoreHistory: string
  /** Busy label while the next immutable history page loads. */
  loadingMoreHistory: string
  /** Compare-with-previous disclosure label. */
  comparePrevious: string
  /** Previous value label. */
  previous: string
  /** Current value label. */
  current: string
  /** Planning-change labels. */
  changeLabels: Record<PlanningUpdateChangeField, string>
  /** Formats a captured progress percentage. */
  progressPercent: (value: number) => string
  /** Formats a comment count. */
  commentCount: (count: number) => string
  /** Watch action label. */
  watchUpdates: string
  /** Active watch action label. */
  watchingUpdates: string
  /** Full-history export action label. */
  exportHistory: string
  /** Add-comment action label. */
  addComment: string
  /** Comment composer placeholder. */
  commentPlaceholder: string
  /** Reaction control accessible label. */
  reaction: string
  /** Formats the target watcher count. */
  watcherCount: (count: number) => string
  /** Watcher and annotation loading-state label. */
  collaborationLoading: string
  /** Watcher and annotation error-state label. */
  collaborationError: string
}

/** Props for the delivery-state badge. */
export type PlanningUpdateFreshnessBadgeProps = {
  /** Delivery state that must remain independent from planning health. */
  freshness: PlanningUpdateFreshness
  /** Localized label map for every delivery state. */
  labels: Pick<PlanningUpdateLabels, 'freshnessValues'>
}

/**
 * Renders the operational delivery state without implying planning health.
 *
 * @param props - Freshness value and localized labels.
 * @returns A semantic workbench badge.
 */
export function PlanningUpdateFreshnessBadge({
  freshness,
  labels,
}: PlanningUpdateFreshnessBadgeProps) {
  const classes: Record<PlanningUpdateFreshness, string> = {
    'not-configured': 'workbench-badge',
    missing: 'workbench-badge',
    current: 'workbench-badge-success',
    overdue: 'workbench-badge-danger',
    stale: 'workbench-badge-warning',
  }

  return (
    <span className={classes[freshness]} data-testid="planning-update-freshness">
      {labels.freshnessValues[freshness]}
    </span>
  )
}

/** Props for the compact latest-update summary used by list views. */
export type PlanningLatestUpdateSummaryProps = {
  /** Update projection for the list row. */
  updateView: PlanningTargetUpdateView
  /** Localized labels and formatters. */
  labels: Pick<
    PlanningUpdateLabels,
    'dueAtMeta' | 'neverUpdated' | 'noDueDate' | 'statusUpdateMeta'
  >
}

/**
 * Renders author, publication time, and the next due time for one list row.
 *
 * @param props - Update projection and localized formatters.
 * @returns A compact two-line update summary.
 */
export function PlanningLatestUpdateSummary({
  labels,
  updateView,
}: PlanningLatestUpdateSummaryProps) {
  const latestUpdate = updateView.updates[0]

  return (
    <div className="grid min-w-[180px] gap-1">
      <span className="text-xs font-semibold text-[var(--workbench-text)]">
        {latestUpdate
          ? labels.statusUpdateMeta(latestUpdate.authorMemberKey, latestUpdate.createdAt)
          : labels.neverUpdated}
      </span>
      <span className="text-xs font-medium text-[var(--workbench-muted)]">
        {updateView.cadence
          ? labels.dueAtMeta(
              updateView.cadence.nextDueAt,
              updateView.cadence.timeZone,
            )
          : labels.noDueDate}
      </span>
    </div>
  )
}

/** Props for the Project-or-Initiative update detail pane. */
export type PlanningUpdateDetailPaneProps = {
  /** Optional explicit AI generation access for the selected revision-fenced target. */
  aiAssistance?: PlanningStatusUpdateAiAssistance
  /** Selected Project or Initiative display metadata. */
  summary: PlanningUpdateTargetSummaryView
  /** Cadence, delivery state, and immutable history for the selected target. */
  updateView: PlanningTargetUpdateView
  /** Localized update labels and formatters. */
  labels: PlanningUpdateLabels
  /** Saves the selected target's cadence when the viewer has permission. */
  onSaveCadence?: (draft: PlanningUpdateCadenceDraft) => void | Promise<void>
  /** Publishes a structured manual update when the viewer has permission. */
  onPublish?: (draft: PlanningStatusUpdateDraft) => void | Promise<void>
  /** Whether the selected target's full immutable history is loading. */
  isHistoryLoading?: boolean
  /** Optional recoverable history-query error message. */
  historyErrorMessage?: string
  /** Retries the selected target's history query. */
  onRetryHistory?: () => void
  /** Whether another immutable history page is available. */
  hasMoreHistory?: boolean
  /** Whether the next immutable history page is loading. */
  isLoadingMoreHistory?: boolean
  /** Loads the next immutable history page. */
  onLoadMoreHistory?: () => void | Promise<void>
  /** Watch, export, comment, and reaction controller for the selected target. */
  collaboration?: PlanningUpdateCollaborationController
  /** Canonical evidence choices visible in the selected target scope. */
  evidenceCandidates?: PlanningUpdateEvidenceCandidates
}

/**
 * Renders one canonical Project or Initiative update stream in a responsive pane.
 *
 * @param props - Target summary, update projection, labels, and permission-aware actions.
 * @returns A responsive detail pane with schedule, composer, and immutable ledger.
 */
export function PlanningUpdateDetailPane({
  aiAssistance,
  collaboration,
  evidenceCandidates,
  hasMoreHistory = false,
  labels,
  historyErrorMessage,
  isHistoryLoading = false,
  isLoadingMoreHistory = false,
  onLoadMoreHistory,
  onPublish,
  onRetryHistory,
  onSaveCadence,
  summary,
  updateView,
}: PlanningUpdateDetailPaneProps) {
  const collaborationIsPending = collaboration?.isPending ?? false
  const collaborationIsLoading = collaboration?.isLoading ?? false
  const collaborationErrorMessage = collaboration?.errorMessage
  return (
    <aside
      aria-label={`${labels.latestUpdate}: ${summary.title}`}
      className="workbench-detail-pane min-h-0 min-w-0 max-[1180px]:border-l-0 max-[1180px]:border-t"
      data-testid="planning-update-detail-pane"
    >
      <header className="border-b border-[var(--workbench-border)] px-5 py-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--workbench-muted)]">
          {summary.target.type === 'project' ? labels.projectTarget : labels.initiativeTarget}
        </p>
        <h2 className="mt-1 text-lg font-semibold text-[var(--workbench-text)]">
          {summary.title}
        </h2>
        {summary.context ? (
          <p className="mt-1 text-sm font-medium text-[var(--workbench-muted)]">
            {summary.context}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <PlanningHealthBadge health={summary.health} labels={labels} />
          <PlanningUpdateFreshnessBadge freshness={updateView.freshness} labels={labels} />
        </div>
        <div className="mt-3">
          <PlanningLatestUpdateSummary labels={labels} updateView={updateView} />
        </div>
        {collaboration?.errorMessage ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2" role="alert">
            <p className="text-xs font-semibold text-red-800">
              {collaborationErrorMessage || labels.collaborationError}
            </p>
            {collaboration.onRetry ? (
              <button className="workbench-button-secondary min-h-9 px-3" onClick={collaboration.onRetry} type="button">
                {labels.retryHistory}
              </button>
            ) : null}
          </div>
        ) : collaboration?.isLoading ? (
          <p className="mt-4 text-xs font-semibold text-[var(--workbench-muted)]">
            {labels.collaborationLoading}
          </p>
        ) : null}
        {collaboration?.watch || collaboration?.onExport ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {collaboration.watch ? (
              <button
                aria-pressed={collaboration.watch.subscribed}
                className={collaboration.watch.subscribed
                  ? 'workbench-button-primary min-h-10 px-3'
                  : 'workbench-button-secondary min-h-10 px-3'}
                disabled={
                  !collaboration.onToggleWatch ||
                  collaborationIsPending ||
                  collaborationIsLoading
                }
                onClick={() => void collaboration.onToggleWatch?.()}
                type="button"
              >
                {collaboration.watch.subscribed ? labels.watchingUpdates : labels.watchUpdates}
                <span className="ml-2 opacity-75">
                  {labels.watcherCount(collaboration.watch.watcherCount)}
                </span>
              </button>
            ) : null}
            {collaboration.onExport ? (
              <button
                className="workbench-button-secondary min-h-10 px-3"
                disabled={collaborationIsPending}
                onClick={() => void collaboration.onExport?.()}
                type="button"
              >
                {labels.exportHistory}
              </button>
            ) : null}
          </div>
        ) : null}
      </header>
      <div className="grid content-start gap-4 bg-[var(--workbench-canvas)] p-4 max-[520px]:p-3">
        <PlanningUpdateCadenceEditor
          defaultOwnerMemberKey={summary.ownerMemberKey}
          labels={labels}
          onSave={onSaveCadence}
          updateView={updateView}
        />
        <PlanningStatusUpdateComposer
          aiAssistance={aiAssistance}
          evidenceCandidates={evidenceCandidates}
          health={summary.health}
          labels={labels}
          onPublish={onPublish}
          progress={summary.progress}
        />
        <PlanningStatusUpdateLedger
          errorMessage={historyErrorMessage}
          isLoading={isHistoryLoading}
          hasMore={hasMoreHistory}
          isLoadingMore={isLoadingMoreHistory}
          labels={labels}
          onRetry={onRetryHistory}
          onLoadMore={onLoadMoreHistory}
          updateView={updateView}
          collaboration={collaboration}
        />
      </div>
    </aside>
  )
}

/** Props for the recurring update-schedule editor. */
export type PlanningUpdateCadenceEditorProps = {
  /** Current schedule and update history projection. */
  updateView: PlanningTargetUpdateView
  /** Default owner used before the schedule is configured. */
  defaultOwnerMemberKey: string
  /** Localized labels and formatters. */
  labels: PlanningUpdateLabels
  /** Saves a recurring update schedule when the viewer has permission. */
  onSave?: (draft: PlanningUpdateCadenceDraft) => void | Promise<void>
}

/**
 * Renders cadence, time-zone, reminder, and escalation controls.
 *
 * @param props - Current projection, defaults, labels, and optional save action.
 * @returns A permission-aware update schedule form.
 */
export function PlanningUpdateCadenceEditor({
  defaultOwnerMemberKey,
  labels,
  onSave,
  updateView,
}: PlanningUpdateCadenceEditorProps) {
  const cadence = updateView.cadence
  const defaultCadence: PlanningCadence = cadence?.cadence ?? { unit: 'week', count: 1 }
  const [formError, setFormError] = useState<string | undefined>()
  const [isSaving, setIsSaving] = useState(false)
  const cadenceFormKey = JSON.stringify({
    cadence,
    defaultOwnerMemberKey: cadence ? undefined : defaultOwnerMemberKey,
  })
  /** Saves one cadence draft while preventing concurrent submissions. */
  const saveCadence = (draft: PlanningUpdateCadenceDraft) => {
    if (!onSave || isSaving) return
    setIsSaving(true)
    void Promise.resolve().then(() => onSave(draft)).then(
      () => setIsSaving(false),
      () => setIsSaving(false),
    )
  }

  return (
    <section className="workbench-panel p-5" data-testid="planning-update-cadence">
      <h2 className="text-base font-semibold text-[var(--workbench-text)]">
        {labels.cadenceTitle}
      </h2>
      <p className="mt-1 text-sm font-medium text-[var(--workbench-muted)]">
        {labels.cadenceDescription}
      </p>
      <form
        key={cadenceFormKey}
        className="mt-4 grid gap-3"
        aria-busy={isSaving}
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          if (isSaving) return
          setFormError(undefined)
          if (!onSave) return
          const data = new FormData(event.currentTarget)
          const cadenceUnit = readCadenceUnit(data.get('cadenceUnit'))
          const cadenceCount = readPositiveNumber(data.get('cadenceCount'))
          const reminderHoursBefore = readNonNegativeNumber(data.get('reminderHoursBefore'))
          const escalationHoursAfter = readOptionalNonNegativeNumber(
            data.get('escalationHoursAfter'),
          )
          const updateOwnerMemberKey = String(data.get('updateOwnerMemberKey') ?? '').trim()
          const timeZone = String(data.get('timeZone') ?? '').trim()
          const nextDueAt = String(data.get('nextDueAt') ?? '').trim()

          if (!cadenceUnit || !cadenceCount || reminderHoursBefore === undefined || !updateOwnerMemberKey || !timeZone || !nextDueAt) {
            setFormError(labels.formInvalid)
            return
          }
          if (!isValidPlanningDateTime(nextDueAt)) {
            setFormError(labels.formInvalid)
            return
          }

          saveCadence({
            cadence: { unit: cadenceUnit, count: cadenceCount },
            escalationHoursAfter,
            escalationMemberKey: readOptionalText(data.get('escalationMemberKey')),
            nextDueAt,
            reminderHoursBefore,
            timeZone,
            updateOwnerMemberKey,
          })
        }}
      >
        <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
          {labels.updateOwner}
          <input
            className="workbench-input h-10 px-3"
            defaultValue={cadence?.updateOwnerMemberKey ?? defaultOwnerMemberKey}
            disabled={!onSave || isSaving}
            name="updateOwnerMemberKey"
            required
          />
        </label>
        <div className="grid grid-cols-[minmax(88px,0.45fr)_minmax(0,1fr)] gap-3 max-[520px]:grid-cols-1">
          <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {labels.updateCadence}
            <input
              className="workbench-input h-10 px-3"
              defaultValue={defaultCadence.count}
              disabled={!onSave || isSaving}
              min="1"
              name="cadenceCount"
              required
              type="number"
            />
          </label>
          <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            <span className="sr-only">{labels.updateCadence}</span>
            <select
              className="workbench-input h-10 px-3"
              defaultValue={defaultCadence.unit}
              disabled={!onSave || isSaving}
              name="cadenceUnit"
            >
              <option value="week">{labels.cadenceWeek}</option>
              <option value="month">{labels.cadenceMonth}</option>
            </select>
          </label>
        </div>
        <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
          {labels.timeZone}
          <input
            className="workbench-input h-10 px-3"
            defaultValue={cadence?.timeZone ?? 'Asia/Tokyo'}
            disabled={!onSave || isSaving}
            name="timeZone"
            required
          />
        </label>
        <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
          {labels.nextDueAt}
          <input
            className="workbench-input h-10 px-3"
            defaultValue={cadence?.nextDueAt}
            disabled={!onSave || isSaving}
            aria-describedby={formError ? 'planning-update-cadence-error' : undefined}
            aria-invalid={Boolean(formError)}
            name="nextDueAt"
            placeholder="2026-08-14T08:00:00.000Z"
            required
          />
        </label>
        <div className="grid grid-cols-2 gap-3 max-[520px]:grid-cols-1">
          <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {labels.reminder}
            <input
              className="workbench-input h-10 px-3"
              defaultValue={cadence?.reminderHoursBefore ?? 24}
              disabled={!onSave || isSaving}
              min="0"
              name="reminderHoursBefore"
              required
              type="number"
            />
          </label>
          <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {labels.escalation}
            <input
              className="workbench-input h-10 px-3"
              defaultValue={cadence?.escalationHoursAfter}
              disabled={!onSave || isSaving}
              min="0"
              name="escalationHoursAfter"
              type="number"
            />
          </label>
        </div>
        <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
          {labels.escalationOwner}
          <input
            className="workbench-input h-10 px-3"
            defaultValue={cadence?.escalationMemberKey}
            disabled={!onSave || isSaving}
            name="escalationMemberKey"
          />
        </label>
        {!onSave ? (
          <p className="text-xs font-semibold text-[var(--workbench-muted)]">
            {labels.cadenceDisabled}
          </p>
        ) : null}
        {formError ? (
          <p
            id="planning-update-cadence-error"
            className="text-sm font-semibold text-red-700"
            role="alert"
          >
            {formError}
          </p>
        ) : null}
        <button
          className="workbench-button-primary min-h-10 px-4 disabled:opacity-50"
          disabled={!onSave || isSaving}
          type="submit"
        >
          {labels.saveCadence}
        </button>
        {cadence && onSave ? (
          <button
            className="workbench-button-secondary min-h-10 px-4"
            disabled={isSaving}
            onClick={() => saveCadence(null)}
            type="button"
          >
            {labels.clearCadence}
          </button>
        ) : null}
      </form>
    </section>
  )
}

/** Props for the structured manual update composer. */
export type PlanningStatusUpdateComposerProps = {
  /** Optional explicit AI generation access for the selected Planning target. */
  aiAssistance?: PlanningStatusUpdateAiAssistance
  /** Current progress captured by the server when the update is published. */
  progress: number
  /** Current health used as the select default. */
  health: PlanningHealth
  /** Localized labels and formatters. */
  labels: PlanningUpdateLabels
  /** Canonical evidence choices visible in the selected target scope. */
  evidenceCandidates?: PlanningUpdateEvidenceCandidates
  /** Evidence type shown initially by focused stories and form tests. */
  initialEvidenceType?: PlanningUpdateEvidence['type'] | 'none'
  /** Optional initial local draft used by focused stories and prefilled workflows. */
  initialDraft?: AiPlanningStatusUpdateDraft
  /** Publishes a manual canonical update when the viewer has permission. */
  onPublish?: (draft: PlanningStatusUpdateDraft) => void | Promise<void>
}

/** Authentication and revision-fenced source for a Planning status update draft. */
export type PlanningStatusUpdateAiAssistance = {
  /** Active Workspace member bearer token. */
  accessToken: string
  /** Locale sent to Bedrock and used for draft presentation. */
  locale: Locale
  /** Planning target resolved and re-authorized by the server. */
  source: AiPlanningTargetSource
}

/** Local form seed replaced only after an approved AI draft adoption. */
type PlanningStatusUpdateFormSeed = {
  /** Status update copied into uncontrolled form defaults. */
  draft?: AiPlanningStatusUpdateDraft
  /** Monotonic key that remounts the form even when consecutive drafts are equal. */
  revision: number
}

/** An approved draft staged for one exact source session. */
type PendingAiPlanningDraft = {
  /** Approved status update awaiting explicit replacement confirmation. */
  draft: AiPlanningStatusUpdateDraft
  /** Source identity and revision that produced the approved draft. */
  sessionKey: string
}

/**
 * Renders the versioned manual update contract as a structured form.
 *
 * @param props - Current entity state, labels, and optional publish action.
 * @returns A permission-aware structured composer.
 */
export function PlanningStatusUpdateComposer({
  aiAssistance,
  evidenceCandidates = { planningEntities: [], workItems: [] },
  health,
  initialDraft,
  initialEvidenceType = 'none',
  labels,
  onPublish,
  progress,
}: PlanningStatusUpdateComposerProps) {
  const [evidenceType, setEvidenceType] = useState<PlanningUpdateEvidence['type'] | 'none'>(
    initialEvidenceType,
  )
  const [formError, setFormError] = useState<string | undefined>()
  const [isPublishing, setIsPublishing] = useState(false)
  const isFormDirtyRef = useRef(false)
  const [pendingAiDraft, setPendingAiDraft] =
    useState<PendingAiPlanningDraft>()
  const [formSeed, setFormSeed] = useState<PlanningStatusUpdateFormSeed>({
    draft: initialDraft,
    revision: 0,
  })
  const aiT = aiAssistance ? createTranslator(aiAssistance.locale) : undefined
  const aiAssistantSessionKey = aiAssistance
    ? createAiAssistantSessionKey(aiAssistance.source)
    : undefined
  const activeAiAssistantSessionKeyRef = useRef(aiAssistantSessionKey)

  useEffect(() => {
    activeAiAssistantSessionKeyRef.current = aiAssistantSessionKey
  }, [aiAssistantSessionKey])

  /**
   * Replaces the local form only after adoption is safe or explicitly confirmed.
   *
   * @param draft - Approved, currently authorized AI status update draft.
   */
  function applyAiDraft(draft: AiPlanningStatusUpdateDraft) {
    setEvidenceType(initialEvidenceType)
    setFormError(undefined)
    isFormDirtyRef.current = false
    setPendingAiDraft(undefined)
    setFormSeed((current) => ({
      draft,
      revision: current.revision + 1,
    }))
  }

  /**
   * Applies a clean-form adoption or stages it behind manual-edit confirmation.
   *
   * @param draft - Approved, currently authorized AI status update draft.
   * @param sessionKey - Source identity and revision captured by the mounted assistant.
   */
  function adoptAiDraft(
    draft: AiPlanningStatusUpdateDraft,
    sessionKey: string,
  ) {
    if (activeAiAssistantSessionKeyRef.current !== sessionKey) return
    routeAiPlanningDraftAdoption(draft, isFormDirtyRef.current, {
      apply: applyAiDraft,
      confirm: (nextDraft) => setPendingAiDraft({
        draft: nextDraft,
        sessionKey,
      }),
    })
  }

  return (
    <section className="workbench-panel p-5" data-testid="planning-update-composer">
      <h2 className="text-base font-semibold text-[var(--workbench-text)]">
        {labels.composerTitle}
      </h2>
      <p className="mt-1 text-sm font-medium text-[var(--workbench-muted)]">
        {labels.composerDescription}
      </p>
      {aiAssistance && aiT && aiAssistantSessionKey ? (
        <div className="mt-4">
          <AiPlanningStatusUpdateAssistant
            accessToken={aiAssistance.accessToken}
            key={aiAssistantSessionKey}
            locale={aiAssistance.locale}
            onAdopt={(draft) => adoptAiDraft(draft, aiAssistantSessionKey)}
            source={aiAssistance.source}
            t={aiT}
          />
        </div>
      ) : null}
      {pendingAiDraft &&
      pendingAiDraft.sessionKey === aiAssistantSessionKey &&
      aiT ? (
        <div
          className="mt-4 border-l-2 border-amber-500 bg-amber-50 px-4 py-3 text-amber-950"
          role="alert"
        >
          <p className="text-sm font-semibold">
            {aiT('ai.planning.replaceDraftTitle')}
          </p>
          <p className="mt-1 text-xs font-medium leading-5">
            {aiT('ai.planning.replaceDraftDescription')}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="workbench-button-secondary min-h-[44px] px-4"
              onClick={() => setPendingAiDraft(undefined)}
              type="button"
            >
              {aiT('ai.planning.keepManualDraft')}
            </button>
            <button
              className="workbench-button-primary min-h-[44px] px-4"
              onClick={() => applyAiDraft(pendingAiDraft.draft)}
              type="button"
            >
              {aiT('ai.planning.replaceManualDraft')}
            </button>
          </div>
        </div>
      ) : null}
      <p className="mt-3 text-xs font-semibold text-[var(--workbench-muted)]">
        {labels.composerRequiredHint}
      </p>
      <form
        className="mt-4 grid gap-3"
        key={`planning-status-update-form-${formSeed.revision}`}
        noValidate
        onChange={() => {
          isFormDirtyRef.current = true
        }}
        onSubmit={(event) => {
          event.preventDefault()
          setFormError(undefined)
          if (!onPublish || isPublishing) return
          const data = new FormData(event.currentTarget)
          const selectedHealth = readHealth(data.get('health'))
          const selectedRisk = readRisk(data.get('risk'))
          const summary = String(data.get('summary') ?? '').trim()
          const nextAction = String(data.get('nextAction') ?? '').trim()

          if (!selectedHealth || !selectedRisk || !summary || !nextAction) {
            setFormError(labels.formInvalid)
            return
          }

          const evidence = readPlanningUpdateEvidence(data, evidenceCandidates)
          if (!evidence) {
            setFormError(labels.formInvalid)
            return
          }
          const draft = {
            decisionSummary: readOptionalText(data.get('decisionSummary')) ?? '',
            evidence,
            health: selectedHealth,
            helpNeeded: readOptionalText(data.get('helpNeeded')) ?? '',
            nextAction,
            risk: selectedRisk,
            riskSummary: readOptionalText(data.get('riskSummary')) ?? '',
            summary,
          }
          setIsPublishing(true)
          void (async () => {
            try {
              await onPublish(draft)
            } catch {
              // The page-level mutation handler owns the user-visible error state.
            } finally {
              setIsPublishing(false)
            }
          })()
        }}
      >
        <div className="grid grid-cols-[minmax(140px,0.35fr)_minmax(140px,0.35fr)_minmax(0,1fr)] gap-3 max-[720px]:grid-cols-1">
          <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {labels.health}
            <select
              className="workbench-input h-10 px-3"
              defaultValue={formSeed.draft?.health ?? health}
              disabled={!onPublish}
              aria-describedby={formError ? 'planning-update-composer-error' : undefined}
              aria-invalid={Boolean(formError)}
              name="health"
            >
              {planningHealthValues.map((value) => (
                <option key={value} value={value}>{labels.healthValues[value]}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {labels.risk}
            <select
              className="workbench-input h-10 px-3"
              defaultValue={formSeed.draft?.risk ?? 'none'}
              disabled={!onPublish}
              aria-describedby={formError ? 'planning-update-composer-error' : undefined}
              aria-invalid={Boolean(formError)}
              name="risk"
            >
              {planningRiskValues.map((value) => (
                <option key={value} value={value}>{labels.riskValues[value]}</option>
              ))}
            </select>
          </label>
          <div className="workbench-panel-muted grid gap-1 px-3 py-2">
            <span className="text-xs font-semibold text-[var(--workbench-muted)]">
              {labels.progressSnapshot}
            </span>
            <span className="text-sm font-semibold text-[var(--workbench-text)]">
              {labels.progressPercent(progress)}
            </span>
          </div>
        </div>
        <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
          {labels.summary}
          <textarea
            className="workbench-input min-h-24 p-3"
            defaultValue={formSeed.draft?.summary}
            disabled={!onPublish}
            aria-describedby={formError ? 'planning-update-composer-error' : undefined}
            aria-invalid={Boolean(formError)}
            name="summary"
            required
          />
        </label>
        <div className="grid grid-cols-2 gap-3 max-[620px]:grid-cols-1">
          <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {labels.riskSummary}
            <textarea className="workbench-input min-h-20 p-3" defaultValue={formSeed.draft?.riskSummary} disabled={!onPublish} name="riskSummary" />
          </label>
          <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {labels.decisionSummary}
            <textarea className="workbench-input min-h-20 p-3" defaultValue={formSeed.draft?.decisionSummary} disabled={!onPublish} name="decisionSummary" />
          </label>
          <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {labels.helpNeeded}
            <textarea className="workbench-input min-h-20 p-3" defaultValue={formSeed.draft?.helpNeeded} disabled={!onPublish} name="helpNeeded" />
          </label>
          <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {labels.nextAction}
          <textarea
            aria-describedby={formError ? 'planning-update-composer-error' : undefined}
            aria-invalid={Boolean(formError)}
            className="workbench-input min-h-20 p-3"
            defaultValue={formSeed.draft?.nextAction}
            disabled={!onPublish}
            name="nextAction"
            required
          />
          </label>
        </div>
        <fieldset className="grid gap-3 border-t border-[var(--workbench-border)] pt-4">
          <legend className="text-sm font-semibold text-[var(--workbench-text)]">
            {labels.evidence}
          </legend>
          <label className="grid gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {labels.evidenceType}
            <select
              className="workbench-input h-10 px-3"
              disabled={!onPublish}
              aria-describedby={formError ? 'planning-update-composer-error' : undefined}
              aria-invalid={Boolean(formError)}
              name="evidenceType"
              value={evidenceType}
              onChange={(event) => setEvidenceType(readPlanningUpdateEvidenceType(event.target.value))}
            >
              <option value="none">{labels.evidenceNone}</option>
              <option disabled={evidenceCandidates.workItems.length === 0} value="work-item">
                {labels.evidenceWorkItem}
              </option>
              <option disabled={evidenceCandidates.planningEntities.length === 0} value="planning-entity">
                {labels.evidencePlanningEntity}
              </option>
              <option value="file">{labels.evidenceFile}</option>
              <option value="link">{labels.evidenceLink}</option>
            </select>
          </label>
          {evidenceType === 'work-item' ? (
            <select
              aria-label={labels.evidenceWorkItemPlaceholder}
              className="workbench-input h-10 px-3"
              disabled={!onPublish}
              name="evidenceWorkItem"
              aria-describedby={formError ? 'planning-update-composer-error' : undefined}
              aria-invalid={Boolean(formError)}
              required
            >
              <option value="">{labels.evidenceWorkItemPlaceholder}</option>
              {evidenceCandidates.workItems.map((candidate) => (
                <option key={candidate.value} value={candidate.value}>{candidate.label}</option>
              ))}
            </select>
          ) : null}
          {evidenceType === 'planning-entity' ? (
            <select
              aria-label={labels.evidencePlanningEntityPlaceholder}
              className="workbench-input h-10 px-3"
              disabled={!onPublish}
              name="evidencePlanningEntity"
              aria-describedby={formError ? 'planning-update-composer-error' : undefined}
              aria-invalid={Boolean(formError)}
              required
            >
              <option value="">{labels.evidencePlanningEntityPlaceholder}</option>
              {evidenceCandidates.planningEntities.map((candidate) => (
                <option key={candidate.value} value={candidate.value}>{candidate.label}</option>
              ))}
            </select>
          ) : null}
          {evidenceType === 'file' ? (
            <div className="grid grid-cols-[minmax(140px,0.45fr)_minmax(0,1fr)] gap-3 max-[620px]:grid-cols-1">
              <input
                aria-label={labels.evidenceFileIdPlaceholder}
                className="workbench-input h-10 px-3"
                disabled={!onPublish}
                name="evidenceFileId"
                placeholder={labels.evidenceFileIdPlaceholder}
                required
              />
              <PlanningEvidenceUrlInput
                hasError={Boolean(formError)}
                labels={labels}
                name="evidenceFileUrl"
                onPublish={onPublish}
              />
            </div>
          ) : null}
          {evidenceType === 'link' ? (
            <div className="grid grid-cols-[minmax(140px,0.45fr)_minmax(0,1fr)] gap-3 max-[620px]:grid-cols-1">
              <input
                aria-label={labels.evidenceLabelPlaceholder}
                className="workbench-input h-10 px-3"
                disabled={!onPublish}
                name="evidenceLabel"
                placeholder={labels.evidenceLabelPlaceholder}
              />
              <PlanningEvidenceUrlInput
                hasError={Boolean(formError)}
                labels={labels}
                name="evidenceUrl"
                onPublish={onPublish}
              />
            </div>
          ) : null}
        </fieldset>
        {formError ? (
          <p
            id="planning-update-composer-error"
            className="text-sm font-semibold text-red-700"
            role="alert"
          >
            {formError}
          </p>
        ) : null}
        <button
          className="workbench-button-primary min-h-[44px] px-4 disabled:opacity-50"
          disabled={!onPublish || isPublishing}
          aria-busy={isPublishing}
          type="submit"
        >
          {labels.publishUpdate}
        </button>
      </form>
    </section>
  )
}

/**
 * Renders one required HTTPS permalink field for typed evidence.
 *
 * @param props - Field name, localized placeholder, and publish permission.
 * @returns A URL input constrained to credential-free HTTPS permalinks.
 */
function PlanningEvidenceUrlInput({
  hasError = false,
  labels,
  name,
  onPublish,
}: {
  hasError?: boolean
  labels: Pick<PlanningUpdateLabels, 'evidenceUrlPlaceholder'>
  name: string
  onPublish: PlanningStatusUpdateComposerProps['onPublish']
}) {
  return (
    <input
      aria-label={labels.evidenceUrlPlaceholder}
      className="workbench-input h-10 px-3"
      disabled={!onPublish}
      aria-describedby={hasError ? 'planning-update-composer-error' : undefined}
      aria-invalid={hasError}
      name={name}
      pattern="https://.*"
      placeholder={labels.evidenceUrlPlaceholder}
      required
      type="url"
    />
  )
}

/** Props for the immutable update ledger. */
export type PlanningStatusUpdateLedgerProps = {
  /** Update projection whose immutable versions are rendered. */
  updateView: PlanningTargetUpdateView
  /** Localized labels and formatters. */
  labels: PlanningUpdateLabels
  /** Whether the full immutable history is loading. */
  isLoading?: boolean
  /** Optional recoverable history-query error message. */
  errorMessage?: string
  /** Retries the history query. */
  onRetry?: () => void
  /** Whether another immutable history page is available. */
  hasMore?: boolean
  /** Whether the next immutable history page is loading. */
  isLoadingMore?: boolean
  /** Loads the next immutable history page. */
  onLoadMore?: () => void | Promise<void>
  /** Optional comment and reaction controller for ledger entries. */
  collaboration?: PlanningUpdateCollaborationController
}

/**
 * Renders published updates as a divider-based ledger with evidence and diffs.
 *
 * @param props - Update projection and localized labels.
 * @returns An immutable chronological feed.
 */
export function PlanningStatusUpdateLedger({
  collaboration,
  errorMessage,
  hasMore = false,
  isLoading = false,
  isLoadingMore = false,
  labels,
  onRetry,
  onLoadMore,
  updateView,
}: PlanningStatusUpdateLedgerProps) {
  const onAddComment = collaboration?.onAddComment
  const collaborationIsPending = collaboration?.isPending ?? false
  const collaborationIsLoading = collaboration?.isLoading ?? false
  const collaborationErrorMessage = collaboration?.errorMessage
  return (
    <section className="workbench-panel overflow-hidden" data-testid="planning-status-update-history">
      <div className="px-5 py-4">
        <h2 className="text-base font-semibold text-[var(--workbench-text)]">
          {labels.historyTitle}
        </h2>
        <p className="mt-1 text-sm font-medium text-[var(--workbench-muted)]">
          {labels.historyDescription}
        </p>
      </div>
      {errorMessage ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-red-200 bg-red-50 px-5 py-4" role="alert">
          <p className="text-sm font-semibold text-red-800">{errorMessage || labels.historyError}</p>
          {onRetry ? (
            <button className="workbench-button-secondary min-h-9 px-3" onClick={onRetry} type="button">
              {labels.retryHistory}
            </button>
          ) : null}
        </div>
      ) : null}
      {isLoading && updateView.updates.length === 0 ? (
        <p className="border-t border-[var(--workbench-border)] px-5 py-8 text-sm font-semibold text-[var(--workbench-muted)]">
          {labels.historyLoading}
        </p>
      ) : updateView.updates.length === 0 ? (
        <div className="border-t border-[var(--workbench-border)] px-5 py-8">
          <p className="text-sm font-semibold text-[var(--workbench-text)]">
            {labels.noStatusUpdates}
          </p>
          <p className="mt-1 text-sm font-medium text-[var(--workbench-muted)]">
            {labels.noStatusUpdatesDescription}
          </p>
        </div>
      ) : (
        <div className="divide-y divide-[var(--workbench-border)] border-t border-[var(--workbench-border)]">
          {updateView.updates.map((update) => {
            const comments = collaboration?.commentsByUpdateId[update.id] ?? []
            const reactions = collaboration?.reactionsByUpdateId[update.id] ?? update.reactions
            const commentCount = comments.length || update.commentCount
            return (
            <article
              className="relative px-5 py-5"
              data-content-version={update.schemaVersion}
              data-update-version={update.version}
              key={update.id}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold text-[var(--workbench-muted)]">
                    {labels.statusUpdateMeta(update.authorMemberKey, update.createdAt)}
                  </p>
                  <p className="mt-2 text-sm font-semibold text-[var(--workbench-text)]">
                    {update.summary}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <PlanningHealthBadge health={update.health} labels={labels} />
                  <span className="workbench-badge">{labels.immutable}</span>
                </div>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 max-[620px]:grid-cols-1">
                {update.progressPercent !== undefined ? (
                  <PlanningUpdateLedgerValue
                    label={labels.progressSnapshot}
                    value={labels.progressPercent(update.progressPercent)}
                  />
                ) : null}
                <PlanningUpdateLedgerValue label={labels.riskSummary} value={update.riskSummary} />
                <PlanningUpdateLedgerValue label={labels.decisionSummary} value={update.decisionSummary} />
                <PlanningUpdateLedgerValue label={labels.helpNeeded} value={update.helpNeeded} />
                <PlanningUpdateLedgerValue label={labels.nextAction} value={update.nextAction} />
              </dl>
              {update.evidence.length > 0 ? (
                <div className="mt-4 border-t border-[var(--workbench-border)] pt-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--workbench-muted)]">
                    {labels.evidence}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {update.evidence.map((evidence) => evidence.url ? (
                      <a
                        className="workbench-button-secondary inline-flex min-h-9 items-center px-3"
                        href={evidence.url}
                        key={evidence.id}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {evidence.label}
                      </a>
                    ) : (
                      <span className="workbench-badge" key={evidence.id}>{evidence.label}</span>
                    ))}
                  </div>
                </div>
              ) : null}
              {update.changes.length > 0 ? (
                <details className="mt-4 border-t border-[var(--workbench-border)] pt-3">
                  <summary className="cursor-pointer text-sm font-semibold text-[var(--workbench-primary)]">
                    {labels.comparePrevious}
                  </summary>
                  <div className="mt-3 divide-y divide-[var(--workbench-border)] border-y border-[var(--workbench-border)]">
                    {update.changes.map((change) => (
                      <div className="grid grid-cols-[120px_minmax(0,1fr)_minmax(0,1fr)] gap-3 py-3 max-[620px]:grid-cols-1" key={change.id}>
                        <span className="text-xs font-semibold text-[var(--workbench-muted)]">
                          {labels.changeLabels[change.field]}
                        </span>
                        <span className="text-sm text-[var(--workbench-muted)]">
                          <span className="block text-xs font-semibold">{labels.previous}</span>
                          {change.previousValue}
                        </span>
                        <span className="text-sm font-semibold text-[var(--workbench-text)]">
                          <span className="block text-xs font-semibold text-[var(--workbench-muted)]">
                            {labels.current}
                          </span>
                          {change.url ? (
                            <a className="text-[var(--workbench-primary)] underline-offset-4 hover:underline" href={change.url}>
                              {change.currentValue}
                            </a>
                          ) : change.currentValue}
                        </span>
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}
              {commentCount > 0 || reactions.length > 0 ? (
                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--workbench-border)] pt-3">
                  {commentCount > 0 ? (
                    <span className="workbench-badge">{labels.commentCount(commentCount)}</span>
                  ) : null}
                  {reactions.map((reaction) => (
                    <span className="workbench-badge" key={reaction.reaction}>
                      {reaction.reaction} {reaction.count}
                    </span>
                  ))}
                </div>
              ) : null}
              {collaboration?.onToggleReaction ? (
                <div className="mt-3 flex flex-wrap items-center gap-2" aria-label={labels.reaction} role="group">
                  {planningUpdateReactionChoices.map((reaction) => {
                    const aggregate = reactions.find((candidate) =>
                      candidate.reaction === reaction
                    )
                    return (
                      <button
                        aria-label={`${labels.reaction}: ${reaction}`}
                        aria-pressed={aggregate?.reactedByViewer ?? false}
                        className={aggregate?.reactedByViewer
                          ? 'workbench-button-primary min-h-9 px-3'
                          : 'workbench-button-secondary min-h-9 px-3'}
                        disabled={
                          collaborationIsPending ||
                          collaborationIsLoading ||
                          Boolean(collaborationErrorMessage)
                        }
                        key={reaction}
                        onClick={() => void collaboration.onToggleReaction?.(update.id, reaction)}
                        type="button"
                      >
                        {reaction} {aggregate?.count ?? 0}
                      </button>
                    )
                  })}
                </div>
              ) : null}
              {comments.length > 0 ? (
                <div className="mt-4 divide-y divide-[var(--workbench-border)] border-y border-[var(--workbench-border)]">
                  {comments.map((comment) => (
                    <div className="py-3" key={comment.id}>
                      <p className="whitespace-pre-wrap text-sm font-medium text-[var(--workbench-text)]">
                        {comment.bodyMarkdown}
                      </p>
                      <p className="mt-1 text-xs font-medium text-[var(--workbench-muted)]">
                        {labels.statusUpdateMeta(comment.authorMemberKey, comment.createdAt)}
                      </p>
                    </div>
                  ))}
                </div>
              ) : null}
              {onAddComment ? (
                <form
                  className="mt-4 grid gap-2 border-t border-[var(--workbench-border)] pt-3"
                  onSubmit={(event) => {
                    event.preventDefault()
                    const form = event.currentTarget
                    const bodyMarkdown = readOptionalText(
                      new FormData(form).get('comment'),
                    )
                    if (bodyMarkdown) {
                      void submitPlanningUpdateCommentAndReset(
                        onAddComment,
                        update.id,
                        bodyMarkdown,
                        () => form.reset(),
                      ).catch(() => undefined)
                    }
                  }}
                >
                  <textarea
                    aria-label={labels.commentPlaceholder}
                    className="workbench-input min-h-20 p-3"
                    disabled={
                      collaborationIsPending ||
                      collaborationIsLoading ||
                      Boolean(collaborationErrorMessage)
                    }
                    name="comment"
                    placeholder={labels.commentPlaceholder}
                    required
                  />
                  <button
                    className="workbench-button-secondary min-h-9 px-3"
                    disabled={
                      collaborationIsPending ||
                      collaborationIsLoading ||
                      Boolean(collaborationErrorMessage)
                    }
                    type="submit"
                  >
                    {labels.addComment}
                  </button>
                </form>
              ) : null}
            </article>
            )
          })}
          {hasMore ? (
            <div className="px-5 py-4 text-center">
              <button
                className="workbench-button-secondary min-h-10 px-4"
                disabled={isLoadingMore || !onLoadMore}
                onClick={() => void onLoadMore?.()}
                type="button"
              >
                {isLoadingMore ? labels.loadingMoreHistory : labels.loadMoreHistory}
              </button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}

/** Props for one optional ledger definition value. */
type PlanningUpdateLedgerValueProps = {
  /** Definition label. */
  label: string
  /** Optional captured value. */
  value?: string
}

/**
 * Renders one non-empty structured update value.
 *
 * @param props - Definition label and optional value.
 * @returns A definition-list item, or null for an empty value.
 */
function PlanningUpdateLedgerValue({ label, value }: PlanningUpdateLedgerValueProps) {
  if (!value) return null

  return (
    <div>
      <dt className="text-xs font-semibold text-[var(--workbench-muted)]">{label}</dt>
      <dd className="mt-1 whitespace-pre-wrap text-sm font-medium text-[var(--workbench-text)]">
        {value}
      </dd>
    </div>
  )
}

/** Props for the health badge used inside one published ledger entry. */
type PlanningHealthBadgeProps = {
  /** Health captured by the update. */
  health: PlanningHealth
  /** Localized health labels. */
  labels: Pick<PlanningUpdateLabels, 'healthValues'>
}

/**
 * Renders health inside the update ledger without mixing it with freshness.
 *
 * @param props - Health value and localized labels.
 * @returns A semantic workbench badge.
 */
function PlanningHealthBadge({ health, labels }: PlanningHealthBadgeProps) {
  const classes: Record<PlanningHealth, string> = {
    unknown: 'workbench-badge',
    'on-track': 'workbench-badge-success',
    'at-risk': 'workbench-badge-warning',
    'off-track': 'workbench-badge-danger',
  }

  return <span className={classes[health]}>{labels.healthValues[health]}</span>
}

const planningHealthValues: readonly PlanningHealth[] = [
  'unknown',
  'on-track',
  'at-risk',
  'off-track',
]

const planningRiskValues: readonly PlanningRisk[] = [
  'none',
  'low',
  'medium',
  'high',
  'critical',
]

const planningUpdateReactionChoices: readonly string[] = ['👍', '❤️', '🎉', '👀', '✅']

/**
 * Reads one supported cadence unit from FormData.
 *
 * @param value - Raw FormData value.
 * @returns A supported cadence unit, or undefined.
 */
function readCadenceUnit(value: FormDataEntryValue | null): PlanningCadence['unit'] | undefined {
  return value === 'week' || value === 'month' ? value : undefined
}

/**
 * Reads one planning-health value from FormData.
 *
 * @param value - Raw FormData value.
 * @returns A supported planning-health value, or undefined.
 */
function readHealth(value: FormDataEntryValue | null): PlanningHealth | undefined {
  return planningHealthValues.find((candidate) => candidate === value)
}

/**
 * Reads one planning-risk value from FormData.
 *
 * @param value - Raw FormData value.
 * @returns A supported planning-risk value, or undefined.
 */
function readRisk(value: FormDataEntryValue | null): PlanningRisk | undefined {
  return planningRiskValues.find((candidate) => candidate === value)
}

/**
 * Parses a positive integer from FormData.
 *
 * @param value - Raw FormData value.
 * @returns A positive integer, or undefined.
 */
function readPositiveNumber(value: FormDataEntryValue | null) {
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * Parses an optional non-negative integer from FormData.
 *
 * @param value - Raw FormData value.
 * @returns A non-negative integer, or undefined when empty or invalid.
 */
function readOptionalNonNegativeNumber(value: FormDataEntryValue | null) {
  return typeof value === 'string' && value.trim()
    ? readNonNegativeNumber(value)
    : undefined
}

/**
 * Reads optional trimmed text from FormData.
 *
 * @param value - Raw FormData value.
 * @returns Trimmed text, or undefined when empty.
 */
function readOptionalText(value: FormDataEntryValue | null) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || undefined
}
