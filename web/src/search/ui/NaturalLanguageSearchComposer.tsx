import type {
  AiAssistanceGeneration,
  AiSearchDraft,
  CreateAiAssistanceFeedbackRequest,
  SearchCustomFieldFilter,
  WorkspaceSearchFilters,
} from '@mukuroji/contracts'
import { useState, type FormEvent } from 'react'
import {
  AiAssistanceReview,
} from '../../features/ai-assistance/ui/AiAssistanceReview'
import {
  useAiAssistanceController,
  type AiAssistanceControllerError,
} from '../../features/ai-assistance/mutations/useAiAssistanceController'
import { isReviewableAiAssistanceGeneration } from '../../features/ai-assistance/model/aiGenerationValidation'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import {
  aiSearchCustomFieldOperators,
  aiSearchEntityTypes,
  createEditableAiSearchFilters,
  formatAiSearchCustomFieldValue,
  formatAiSearchList,
  hasReviewableAiSearchCustomFields,
  hasReviewableAiSearchDate,
  hasReviewableAiSearchFilterBounds,
  hasReviewableAiSearchFilters,
  normalizeAiSearchFilters,
  parseAiSearchCustomFieldValue,
  parseAiSearchList,
  readAiSearchCustomFieldOperator,
  readAiSearchDateField,
  toggleAiSearchEntityType,
  updateAiSearchCustomField,
} from '../model/aiSearchDraft'
import type { ApprovedAiSearchApplication } from '../model/aiSearchApplication'

/** Props for the Search route's AI assistance container. */
export type NaturalLanguageSearchComposerProps = {
  /** Active Workspace member bearer token. */
  accessToken?: string
  /** Reports authenticated AI failures to the Search route session guard. */
  onAuthenticatedApiError?: (error: unknown) => void
  /** Applies reviewed filters and an optional report intent to existing Search route state. */
  onApply: (application: ApprovedAiSearchApplication) => void
  /** Locale sent to the generation request and used for presentation. */
  locale: Locale
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Connects explicit natural-language generation to the reusable AI review controller.
 *
 * @param props - Search authentication, locale, and explicit URL-apply callback.
 * @returns A natural-language Search composer.
 */
export function NaturalLanguageSearchComposer({
  accessToken,
  locale,
  onAuthenticatedApiError,
  onApply,
  t,
}: NaturalLanguageSearchComposerProps) {
  const controller = useAiAssistanceController({ accessToken, onAuthenticatedApiError })

  return (
    <NaturalLanguageSearchComposerView
      canGenerate={Boolean(accessToken)}
      error={controller.error}
      feedbackRating={controller.feedbackRating}
      generation={controller.generation}
      isDecisionPending={controller.isDecisionPending}
      isFeedbackPending={controller.isFeedbackPending}
      isGenerating={controller.isGenerating}
      locale={locale}
      onApply={onApply}
      onCancelGeneration={controller.cancelGeneration}
      onDecide={controller.decide}
      onFeedback={controller.sendFeedback}
      onGenerate={(query) => controller.generate({ locale, query, task: 'search' })}
      t={t}
    />
  )
}

/** Props for the pure natural-language Search composer view. */
export type NaturalLanguageSearchComposerViewProps = {
  /** Whether the active session can issue a generation request. */
  canGenerate?: boolean
  /** Safe controller failure classification. */
  error?: AiAssistanceControllerError
  /** Feedback already accepted for the visible generation. */
  feedbackRating?: CreateAiAssistanceFeedbackRequest['rating']
  /** Current permission-aware generation. */
  generation?: AiAssistanceGeneration
  /** Whether a human decision is being recorded. */
  isDecisionPending?: boolean
  /** Whether evaluation feedback is being recorded. */
  isFeedbackPending?: boolean
  /** Whether an explicit generation is in flight. */
  isGenerating?: boolean
  /** Locale used for visible metadata. */
  locale: Locale
  /** Applies reviewed filters and an optional report intent to Search route state. */
  onApply: (application: ApprovedAiSearchApplication) => void
  /** Cancels the active generation request. */
  onCancelGeneration?: () => void
  /** Records a human decision without mutating Search URL state. */
  onDecide: (outcome: 'approved' | 'rejected') => Promise<AiAssistanceGeneration | undefined>
  /** Records usefulness feedback. */
  onFeedback?: (rating: CreateAiAssistanceFeedbackRequest['rating']) => void | Promise<void>
  /** Runs a generation only after form submission. */
  onGenerate: (query: string) => void | Promise<unknown>
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Renders an explicit Generate form followed by a permission-aware editable filter review.
 *
 * @param props - Pure generation state and event handlers.
 * @returns The plain-language Search mode content.
 */
export function NaturalLanguageSearchComposerView({
  canGenerate = true,
  error,
  feedbackRating,
  generation,
  isDecisionPending = false,
  isFeedbackPending = false,
  isGenerating = false,
  locale,
  onApply,
  onCancelGeneration,
  onDecide,
  onFeedback,
  onGenerate,
  t,
}: NaturalLanguageSearchComposerViewProps) {
  const [query, setQuery] = useState('')
  const isOperationPending = isGenerating || isDecisionPending || isFeedbackPending

  /** Submits only the operator's explicit Generate action. */
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedQuery = query.trim()
    if (!canGenerate || !normalizedQuery || isOperationPending) return
    void onGenerate(normalizedQuery)
  }

  const availableSearchDraft = getAvailableSearchDraft(generation)
  const invalidDraft = generation?.content.availability === 'available' && !availableSearchDraft

  return (
    <div className="grid gap-4" data-testid="plain-language-search">
      <form className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3 max-[620px]:grid-cols-1" onSubmit={handleSubmit}>
        <label className="grid gap-2 text-app-caption font-semibold text-[var(--workbench-muted)]">
          {t('ai.search.query.label')}
          <textarea
            className="workbench-input min-h-24 resize-y px-3 py-2 text-app-body font-normal text-[var(--workbench-text)]"
            disabled={isOperationPending}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('ai.search.query.placeholder')}
            value={query}
          />
        </label>
        <button
          className="workbench-button-primary min-h-[44px] px-5 disabled:cursor-not-allowed disabled:opacity-50 max-[620px]:w-full"
          disabled={!canGenerate || !query.trim() || isOperationPending}
          type="submit"
        >
          {isGenerating ? t('ai.search.generating') : t('ai.search.generate')}
        </button>
      </form>

      {invalidDraft ? (
        <AiAssistanceReview
          errorKind="validation"
          locale={locale}
          renderDraft={() => null}
          t={t}
        />
      ) : availableSearchDraft && generation ? (
        <SearchDraftReview
          error={error}
          feedbackRating={feedbackRating}
          generation={generation}
          isDecisionPending={isDecisionPending}
          isFeedbackPending={isFeedbackPending}
          key={generation.id}
          locale={locale}
          onApply={onApply}
          onDecide={onDecide}
          onFeedback={onFeedback}
          t={t}
        />
      ) : (
        <AiAssistanceReview
          cancelLabel={t('ai.search.cancel')}
          errorKind={error?.kind}
          generation={generation}
          generatingLabel={t('ai.search.generating')}
          isGenerating={isGenerating}
          locale={locale}
          onCancelGeneration={onCancelGeneration}
          renderDraft={() => null}
          t={t}
        />
      )}
    </div>
  )
}

/** Props for a generation-keyed editable Search draft review. */
type SearchDraftReviewProps = {
  /** Latest safe controller error. */
  error?: AiAssistanceControllerError
  /** Feedback already accepted for this generation. */
  feedbackRating?: CreateAiAssistanceFeedbackRequest['rating']
  /** Search generation being reviewed. */
  generation: AiAssistanceGeneration
  /** Whether a decision request is in flight. */
  isDecisionPending: boolean
  /** Whether feedback is in flight. */
  isFeedbackPending: boolean
  /** Locale used for generation metadata. */
  locale: Locale
  /** Applies reviewed filters and an optional report intent to Search route state. */
  onApply: (application: ApprovedAiSearchApplication) => void
  /** Records the review outcome before a Search URL change. */
  onDecide: (outcome: 'approved' | 'rejected') => Promise<AiAssistanceGeneration | undefined>
  /** Records usefulness feedback. */
  onFeedback?: (rating: CreateAiAssistanceFeedbackRequest['rating']) => void | Promise<void>
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/** Serializes canonical Search filters so an approval is bound to exact criteria. */
function serializeSearchFilters(filters: WorkspaceSearchFilters): string {
  return JSON.stringify({
    ...filters,
    customFields: filters.customFields?.map(({ fieldId, operator, value }) => ({
      fieldId,
      operator,
      value,
    })),
  })
}

/** Keeps reviewed filter edits local until the explicit Apply action succeeds. */
function SearchDraftReview({
  error,
  feedbackRating,
  generation,
  isDecisionPending,
  isFeedbackPending,
  locale,
  onApply,
  onDecide,
  onFeedback,
  t,
}: SearchDraftReviewProps) {
  const draft = getAvailableSearchDraft(generation)
  const [filters, setFilters] = useState<WorkspaceSearchFilters>(() =>
    createEditableAiSearchFilters(draft?.filters ?? {}))
  const [editorRevision, setEditorRevision] = useState(0)
  const hasInvalidFilterSet = !hasReviewableAiSearchFilters(filters)

  if (!draft) return null

  const reviewedFilters = normalizeAiSearchFilters(filters)
  const generatedFilters = normalizeAiSearchFilters(draft.filters)
  const hasUnapprovedFilterEdits = serializeSearchFilters(reviewedFilters) !==
    serializeSearchFilters(generatedFilters)
  const canAdopt = !hasInvalidFilterSet && !hasUnapprovedFilterEdits

  /** Records approval first, then applies the exact reviewed local filters. */
  const adoptFilters = async () => {
    if (!canAdopt) return
    const approvedFilters = reviewedFilters
    const reviewedGeneration = await onDecide('approved')
    const approvedDraft = getAvailableSearchDraft(reviewedGeneration)
    if (reviewedGeneration?.decision?.outcome !== 'approved' || !approvedDraft) return
    const normalizedApprovedDraftFilters = normalizeAiSearchFilters(approvedDraft.filters)
    if (serializeSearchFilters(approvedFilters) !== serializeSearchFilters(normalizedApprovedDraftFilters)) return
    onApply({
      filters: approvedFilters,
      report: approvedDraft.report,
    })
  }

  return (
    <div className="grid gap-3">
      <AiAssistanceReview
        adoptLabel={t('ai.search.apply')}
        errorKind={error?.kind}
        feedbackRating={feedbackRating}
        generation={generation}
        isDecisionPending={isDecisionPending}
        isFeedbackPending={isFeedbackPending}
        locale={locale}
        onAdopt={canAdopt ? adoptFilters : undefined}
        onFeedback={onFeedback}
        onReject={() => {
          void onDecide('rejected')
        }}
        renderDraft={({ draft: renderedDraft }) => renderedDraft.kind === 'search' ? (
          <AiSearchDraftEditor
              draft={renderedDraft}
              filters={filters}
              disabled={isDecisionPending || isFeedbackPending}
              key={editorRevision}
              onChange={setFilters}
            t={t}
          />
        ) : null}
        t={t}
      />
      {hasUnapprovedFilterEdits ? (
        <div className="grid gap-2 border-l-2 border-[var(--workbench-warning)] bg-[var(--workbench-surface-muted)] px-3 py-3">
          <p className="text-app-caption font-medium text-[var(--workbench-text)]">
            {t('ai.search.validation.edited')}
          </p>
          <button
            className="workbench-button-secondary min-h-[44px] justify-self-start px-3"
            onClick={() => {
              setFilters(createEditableAiSearchFilters(draft.filters))
              setEditorRevision((revision) => revision + 1)
            }}
            type="button"
          >
            {t('ai.search.validation.restore')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** Props for the structured Search filter draft editor. */
export type AiSearchDraftEditorProps = {
  /** Server-validated interpretation, caveats, and optional report intent. */
  draft: AiSearchDraft
  /** Locally reviewed filter values. */
  filters: WorkspaceSearchFilters
  /** Prevents edits while the approval request is in flight. */
  disabled?: boolean
  /** Replaces the local draft without changing the URL. */
  onChange: (filters: WorkspaceSearchFilters) => void
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

const listFilterFields = [
  ['statuses', 'search.filters.status'],
  ['assigneeUserIds', 'search.filters.assignee'],
  ['creatorUserIds', 'search.filters.creator'],
  ['teamIds', 'search.filters.team'],
  ['projectIds', 'search.filters.project'],
  ['relationIds', 'search.filters.relation'],
] as const satisfies readonly [
  keyof Pick<WorkspaceSearchFilters, 'statuses' | 'assigneeUserIds' | 'creatorUserIds' | 'teamIds' | 'projectIds' | 'relationIds'>,
  MessageKey,
][]

/**
 * Renders the generated Search interpretation as editable structured controls.
 *
 * @param props - Search draft, local filters, and replacement callback.
 * @returns A flat review editor that does not touch route state.
 */
export function AiSearchDraftEditor({
  disabled = false,
  draft,
  filters,
  onChange,
  t,
}: AiSearchDraftEditorProps) {
  const customFields = filters.customFields ?? []
  const hasInvalidCustomField = !hasReviewableAiSearchCustomFields(filters)
  const hasInvalidBounds = !hasReviewableAiSearchFilterBounds(filters)
  const hasInvalidDate = !hasReviewableAiSearchDate(filters)

  return (
    <div className="grid gap-5">
      <section className="grid gap-1">
        <h3 className="text-app-caption font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
          {t('ai.search.interpretation')}
        </h3>
        <p className="text-app-body font-medium text-[var(--workbench-text)]">{draft.interpretation}</p>
      </section>

      {draft.caveats.length > 0 ? (
        <section className="border-l-2 border-[var(--workbench-warning)] bg-amber-50 px-3 py-2">
          <h3 className="text-app-caption font-semibold text-amber-900">{t('ai.search.caveats')}</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-app-caption text-amber-900">
            {draft.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}
          </ul>
        </section>
      ) : null}

      <fieldset className="grid gap-4" disabled={disabled}>
        <legend className="mb-1 text-app-caption font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
          {t('ai.search.filters')}
        </legend>
        <label className="grid gap-1 text-app-caption font-semibold text-[var(--workbench-muted)]">
          {t('search.input.label')}
          <input
            className="workbench-input min-h-[44px] px-3 font-normal text-[var(--workbench-text)]"
            onChange={(event) => onChange({ ...filters, keyword: event.target.value || undefined })}
            type="text"
            value={filters.keyword ?? ''}
          />
        </label>

        <fieldset className="grid gap-2 border-t border-[var(--workbench-border)] pt-3">
          <legend className="pr-2 text-app-caption font-semibold text-[var(--workbench-muted)]">
            {t('search.filters.types')}
          </legend>
          <div className="flex flex-wrap gap-2">
            {aiSearchEntityTypes.map((entityType) => {
              const active = filters.entityTypes?.includes(entityType) ?? false
              return (
                <button
                  aria-pressed={active}
                  className={`min-h-[44px] rounded-md border px-3 text-app-caption font-semibold transition ${
                    active
                      ? 'border-[#99d7cf] bg-[#e5f7f4] text-[var(--workbench-primary)]'
                      : 'border-[var(--workbench-border)] bg-white text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)]'
                  }`}
                  key={entityType}
                  onClick={() => onChange({
                    ...filters,
                    entityTypes: toggleAiSearchEntityType(filters.entityTypes, entityType),
                  })}
                  type="button"
                >
                  {t(`search.entity.${entityType}`)}
                </button>
              )
            })}
          </div>
        </fieldset>

        <div className="grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">
          {listFilterFields.map(([field, labelKey]) => (
            <label className="grid gap-1 text-app-caption font-semibold text-[var(--workbench-muted)]" key={field}>
              {t(labelKey)}
              <AiSearchListDraftInput
                onChange={(value) => onChange({ ...filters, [field]: value })}
                value={filters[field]}
              />
            </label>
          ))}
        </div>
        <p className="text-[11px] text-[var(--workbench-muted)]" id="ai-search-list-hint">
          {t('ai.search.listHint')}
        </p>

        <div className="grid grid-cols-[minmax(120px,0.8fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3 max-[640px]:grid-cols-1">
          <label className="grid gap-1 text-app-caption font-semibold text-[var(--workbench-muted)]">
            {t('search.filters.dateField')}
            <select
              className="workbench-input min-h-[44px] px-3 font-normal text-[var(--workbench-text)]"
              onChange={(event) => onChange({
                ...filters,
                date: {
                  ...filters.date,
                  field: readAiSearchDateField(event.target.value),
                },
              })}
              value={filters.date?.field ?? 'updatedAt'}
            >
              <option value="updatedAt">{t('search.columns.updatedAt')}</option>
              <option value="createdAt">{t('search.columns.createdAt')}</option>
              <option value="dueDate">{t('tasks.column.dueDate')}</option>
            </select>
          </label>
          <DateDraftInput
            label={t('search.filters.dateFrom')}
            onChange={(value) => onChange({
              ...filters,
              date: { field: filters.date?.field ?? 'updatedAt', ...filters.date, from: value || undefined },
            })}
            value={filters.date?.from ?? ''}
          />
          <DateDraftInput
            label={t('search.filters.dateTo')}
            onChange={(value) => onChange({
              ...filters,
              date: { field: filters.date?.field ?? 'updatedAt', ...filters.date, to: value || undefined },
            })}
            value={filters.date?.to ?? ''}
          />
        </div>

        {customFields.length > 0 ? (
          <fieldset className="grid gap-3 border-t border-[var(--workbench-border)] pt-3">
            <legend className="pr-2 text-app-caption font-semibold text-[var(--workbench-muted)]">
              {t('search.filters.customField')}
            </legend>
            {customFields.map((filter, index) => (
              <CustomFieldDraftRow
                filter={filter}
                key={index}
                onChange={(patch) => onChange({
                  ...filters,
                  customFields: updateAiSearchCustomField(customFields, index, patch),
                })}
                onRemove={() => onChange({
                  ...filters,
                  customFields: customFields.filter((_, filterIndex) => filterIndex !== index),
                })}
                t={t}
              />
            ))}
          </fieldset>
        ) : null}
        {!hasReviewableAiSearchCustomFields(filters) ? (
          <p className="border-l-2 border-[var(--workbench-danger)] bg-red-50 px-3 py-2 text-app-caption font-semibold text-[var(--workbench-danger)]" role="alert">
            {t('ai.search.validation.customFieldValue')}
          </p>
        ) : null}
        {hasInvalidBounds && !hasInvalidCustomField ? (
          <p className="border-l-2 border-[var(--workbench-danger)] bg-red-50 px-3 py-2 text-app-caption font-semibold text-[var(--workbench-danger)]" role="alert">
            {t('ai.search.validation.bounds')}
          </p>
        ) : null}
        {hasInvalidDate && !hasInvalidCustomField && !hasInvalidBounds ? (
          <p className="border-l-2 border-[var(--workbench-danger)] bg-red-50 px-3 py-2 text-app-caption font-semibold text-[var(--workbench-danger)]" role="alert">
            {t('ai.search.validation.dateRange')}
          </p>
        ) : null}
      </fieldset>

      {draft.report ? (
        <section className="border-t border-[var(--workbench-border)] pt-3">
          <h3 className="text-app-caption font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
            {t('ai.search.report')}
          </h3>
          <p className="mt-1 text-app-body text-[var(--workbench-text)]">
            {t('ai.search.report.count')}
            {draft.report.groupBy
              ? ` · ${t('ai.search.report.groupBy').replace('{field}', formatAiSearchReportGroupBy(draft.report.groupBy, t))}`
              : ''}
          </p>
        </section>
      ) : null}
    </div>
  )
}

/**
 * Resolves an AI Search report grouping identifier to the existing Search label.
 *
 * @param groupBy - Server-validated report grouping identifier.
 * @param t - Localized message resolver.
 * @returns The localized grouping label shown in the review.
 */
function formatAiSearchReportGroupBy(
  groupBy: NonNullable<NonNullable<AiSearchDraft['report']>['groupBy']>,
  t: (key: MessageKey) => string,
): string {
  switch (groupBy) {
    case 'entityType': return t('search.filters.types')
    case 'assignee': return t('search.filters.assignee')
    case 'creator': return t('search.filters.creator')
    case 'status': return t('search.filters.status')
    case 'project': return t('search.filters.project')
    case 'team': return t('search.filters.team')
  }
}

/** Props for a raw-text Search list editor. */
type AiSearchListDraftInputProps = {
  /** Replaces the normalized list without changing the visible in-progress text. */
  onChange: (value: string[] | undefined) => void
  /** Current normalized list value. */
  value?: readonly string[]
}

/** Preserves commas and trailing spaces while emitting normalized filter values. */
function AiSearchListDraftInput({ onChange, value }: AiSearchListDraftInputProps) {
  const [rawValue, setRawValue] = useState(() => formatAiSearchList(value))

  return (
    <input
      aria-describedby="ai-search-list-hint"
      className="workbench-input min-h-[44px] px-3 font-normal text-[var(--workbench-text)]"
      onChange={(event) => {
        const nextValue = event.target.value
        setRawValue(nextValue)
        onChange(parseAiSearchList(nextValue))
      }}
      value={rawValue}
    />
  )
}

/** Props for one editable date filter boundary. */
type DateDraftInputProps = {
  /** Visible input label. */
  label: string
  /** Replaces this date boundary. */
  onChange: (value: string) => void
  /** Current ISO calendar date. */
  value: string
}

/** Renders one accessible date boundary input. */
function DateDraftInput({ label, onChange, value }: DateDraftInputProps) {
  return (
    <label className="grid gap-1 text-app-caption font-semibold text-[var(--workbench-muted)]">
      {label}
      <input
        className="workbench-input min-h-[44px] px-3 font-normal text-[var(--workbench-text)]"
        onChange={(event) => onChange(event.target.value)}
        type="date"
        value={value}
      />
    </label>
  )
}

/** Props for one editable generated custom-field filter. */
type CustomFieldDraftRowProps = {
  /** Current generated custom-field filter. */
  filter: SearchCustomFieldFilter
  /** Replaces selected row fields locally. */
  onChange: (patch: Partial<SearchCustomFieldFilter>) => void
  /** Removes this generated filter locally. */
  onRemove: () => void
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/** Renders a generated custom-field filter as editable structured controls. */
function CustomFieldDraftRow({ filter, onChange, onRemove, t }: CustomFieldDraftRowProps) {
  const valueDisabled = filter.operator === 'is-empty' || filter.operator === 'is-not-empty'

  return (
    <div className="grid grid-cols-[minmax(100px,1fr)_minmax(150px,1fr)_minmax(100px,1fr)_auto] items-end gap-2 max-[640px]:grid-cols-1">
      <label className="grid gap-1 text-[11px] font-semibold text-[var(--workbench-muted)]">
        {t('search.filters.customFieldId')}
        <input className="workbench-input min-h-[44px] px-3" onChange={(event) => onChange({ fieldId: event.target.value })} value={filter.fieldId} />
      </label>
      <label className="grid gap-1 text-[11px] font-semibold text-[var(--workbench-muted)]">
        {t('search.filters.operator')}
        <select
          className="workbench-input min-h-[44px] px-3"
          onChange={(event) => {
            const operator = readAiSearchCustomFieldOperator(event.target.value)
            onChange({
              operator,
              ...(operator === 'is-empty' || operator === 'is-not-empty'
                ? { value: undefined }
                : {}),
            })
          }}
          value={filter.operator}
        >
          {aiSearchCustomFieldOperators.map((operator) => (
            <option key={operator} value={operator}>{t(`search.operator.${operator}`)}</option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-[11px] font-semibold text-[var(--workbench-muted)]">
        {t('search.filters.value')}
        <input
          className="workbench-input min-h-[44px] px-3 disabled:bg-[var(--workbench-surface-muted)]"
          disabled={valueDisabled}
          onChange={(event) => onChange({ value: parseAiSearchCustomFieldValue(event.target.value) })}
          value={formatAiSearchCustomFieldValue(filter.value)}
        />
      </label>
      <button
        aria-label={`${t('search.filters.remove')}: ${filter.fieldId}`}
        className="min-h-[44px] rounded-md px-3 font-semibold text-[var(--workbench-danger)] hover:bg-red-50"
        onClick={onRemove}
        type="button"
      >
        {t('search.filters.remove')}
      </button>
    </div>
  )
}

/** Returns the Search draft only after the permission and task boundaries both pass. */
function getAvailableSearchDraft(generation?: AiAssistanceGeneration): AiSearchDraft | undefined {
  if (
    !isReviewableAiAssistanceGeneration(generation, 'search') ||
    generation.content.availability !== 'available'
  ) return undefined
  return generation.content.draft.kind === 'search' ? generation.content.draft : undefined
}
