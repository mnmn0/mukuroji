import type {
  AiAssistanceCitation,
  AiAssistanceConfidence,
  AiPlanningDraft,
  AiPlanningStatusUpdateDraft,
  WorkItemDependencyEndpoint,
} from '@mukuroji/contracts'
import type { MessageKey } from '../../../shared/i18n/i18n'
import { hasValidAiEvidenceReferences } from '../model/aiEvidenceValidation'
import { AiDraftEvidenceMeta } from './AiDraftEvidence'

/** Props for an unapplied AI planning draft rendered inside the shared review shell. */
export type AiPlanningDraftReviewProps = {
  /** Permission-safe citations supplied by the available-content review boundary. */
  citations: readonly AiAssistanceCitation[]
  /** Validated planning draft that has not mutated a Work Item or Planning target. */
  draft: AiPlanningDraft
  /** Locale used for effort and lead-or-lag formatting. */
  locale: 'ja' | 'en'
  /** Resolves a configured workflow status identifier to its visible label when available. */
  resolveStatusLabel?: (statusId: string) => string
  /** Resolves a Team-qualified Work Item endpoint to a visible label when available. */
  resolveWorkItemLabel?: (endpoint: WorkItemDependencyEndpoint) => string
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/** One evidence-backed Work Item field displayed in the planning review. */
type PlanningSuggestedField = {
  /** Generation-local field key used for stable rendering. */
  key: string
  /** Visible localized field label. */
  label: string
  /** Proposed field value formatted for review. */
  value: string
  /** Concise model rationale for the field proposal. */
  reason: string
  /** Model-estimated field confidence. */
  confidence: AiAssistanceConfidence
  /** Permission-safe citation identifiers supporting the field. */
  citationIds: readonly string[]
  /** Whether the value should preserve line breaks. */
  multiline?: boolean
}

/**
 * Renders proposed fields, child items, dependencies, and status updates without applying them.
 *
 * @param props - Authorized planning draft, evidence, display resolvers, and locale.
 * @returns A flat, evidence-first planning review or a fail-closed validation message.
 */
export function AiPlanningDraftReview({
  citations,
  draft,
  locale,
  resolveStatusLabel,
  resolveWorkItemLabel,
  t,
}: AiPlanningDraftReviewProps) {
  const fields = createSuggestedFields(draft, locale, resolveStatusLabel, t)
  const referenceGroups = [
    ...fields.map((field) => field.citationIds),
    ...draft.subtasks.map((subtask) => subtask.citationIds),
    ...draft.dependencies.map((dependency) => dependency.citationIds),
    ...(draft.statusUpdate ? [draft.statusUpdate.citationIds] : []),
  ]
  if (!hasValidAiEvidenceReferences(citations, referenceGroups)) {
    return (
      <p className="text-app-body font-semibold text-[var(--workbench-danger)]" role="alert">
        {t('ai.error.validation')}
      </p>
    )
  }

  return (
    <div className="grid gap-5" data-testid="ai-planning-draft-review">
      <PlanningFields citations={citations} fields={fields} t={t} />

      <section className="border-t border-[var(--workbench-border)] pt-4">
        <h3 className="text-app-caption font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
          {t('ai.planning.subtasks')}
        </h3>
        {draft.subtasks.length === 0 ? (
          <EmptyPlanningSection t={t} />
        ) : (
          <ol className="mt-1 divide-y divide-[var(--workbench-border)]">
            {draft.subtasks.map((subtask) => (
              <li className="grid gap-2 py-3" key={subtask.id}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h4 className="text-app-body font-semibold text-[var(--workbench-text)]">{subtask.title}</h4>
                  <span className="text-app-caption font-semibold text-[var(--workbench-muted)]">
                    {t(`ai.planning.priority.${subtask.priority}`)}
                    {subtask.plannedEffortMinutes === undefined
                      ? ''
                      : ` · ${formatEffort(subtask.plannedEffortMinutes, locale, t)}`}
                  </span>
                </div>
                {subtask.description ? (
                  <p className="whitespace-pre-wrap text-app-caption leading-5 text-[var(--workbench-text)]">
                    {subtask.description}
                  </p>
                ) : null}
                <PlanningReason reason={subtask.reason} t={t} />
                <AiDraftEvidenceMeta
                  citations={citations}
                  citationIds={subtask.citationIds}
                  confidence={subtask.confidence}
                  t={t}
                />
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="border-t border-[var(--workbench-border)] pt-4">
        <h3 className="text-app-caption font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
          {t('ai.planning.dependencies')}
        </h3>
        {draft.dependencies.length === 0 ? (
          <EmptyPlanningSection t={t} />
        ) : (
          <ol className="mt-1 divide-y divide-[var(--workbench-border)]">
            {draft.dependencies.map((dependency) => {
              const predecessor = resolveEndpointLabel(dependency.predecessor, resolveWorkItemLabel)
              const successor = resolveEndpointLabel(dependency.successor, resolveWorkItemLabel)
              return (
                <li className="grid gap-2 py-3" key={dependency.id}>
                  <p className="break-words text-app-body font-semibold text-[var(--workbench-text)]">
                    {replaceTokens(t('ai.planning.dependency.direction'), {
                      predecessor,
                      successor,
                    })}
                  </p>
                  <p className="text-app-caption font-semibold text-[var(--workbench-muted)]">
                    {t(`ai.planning.dependency.${dependency.type}`)} · {formatLag(dependency.lagDays, locale, t)}
                  </p>
                  <PlanningReason reason={dependency.reason} t={t} />
                  <AiDraftEvidenceMeta
                    citations={citations}
                    citationIds={dependency.citationIds}
                    confidence={dependency.confidence}
                    t={t}
                  />
                </li>
              )
            })}
          </ol>
        )}
      </section>

      <PlanningStatusUpdate citations={citations} statusUpdate={draft.statusUpdate} t={t} />
    </div>
  )
}

/** Props for the flat suggested-field section. */
type PlanningFieldsProps = {
  /** Permission-safe citations supporting the fields. */
  citations: readonly AiAssistanceCitation[]
  /** Formatted field proposals. */
  fields: readonly PlanningSuggestedField[]
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/** Renders suggested Work Item fields as divided rows instead of nested cards. */
function PlanningFields({ citations, fields, t }: PlanningFieldsProps) {
  return (
    <section>
      <h3 className="text-app-caption font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
        {t('ai.planning.fields')}
      </h3>
      {fields.length === 0 ? (
        <EmptyPlanningSection t={t} />
      ) : (
        <dl className="mt-1 divide-y divide-[var(--workbench-border)]">
          {fields.map((field) => (
            <div className="grid gap-1 py-3" key={field.key}>
              <dt className="text-app-caption font-semibold text-[var(--workbench-muted)]">{field.label}</dt>
              <dd className={`${field.multiline ? 'whitespace-pre-wrap' : 'break-words'} text-app-body font-semibold leading-6 text-[var(--workbench-text)]`}>
                {field.value}
              </dd>
              <PlanningReason reason={field.reason} t={t} />
              <AiDraftEvidenceMeta
                citations={citations}
                citationIds={field.citationIds}
                confidence={field.confidence}
                t={t}
              />
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}

/** Props for one suggested-value rationale. */
type PlanningReasonProps = {
  /** Concise generated rationale. */
  reason: string
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/** Renders an explicit rationale label beside the model's reason. */
function PlanningReason({ reason, t }: PlanningReasonProps) {
  return (
    <p className="text-app-caption leading-5 text-[var(--workbench-muted)]">
      <span className="font-semibold">{t('ai.planning.reason')}:</span> {reason}
    </p>
  )
}

/** Props for a possible planning status update proposal. */
type PlanningStatusUpdateProps = {
  /** Permission-safe citations supporting the update. */
  citations: readonly AiAssistanceCitation[]
  /** Optional structured update proposed by the model. */
  statusUpdate?: AiPlanningStatusUpdateDraft
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/** Renders a structured status update as a flat definition list. */
function PlanningStatusUpdate({ citations, statusUpdate, t }: PlanningStatusUpdateProps) {
  return (
    <section className="border-t border-[var(--workbench-border)] pt-4">
      <h3 className="text-app-caption font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
        {t('ai.planning.statusUpdate')}
      </h3>
      {!statusUpdate ? (
        <EmptyPlanningSection t={t} />
      ) : (
        <>
          <dl className="mt-2 grid gap-2 text-app-caption max-[520px]:gap-3">
            <StatusUpdateRow label={t('ai.planning.status.health')} value={t(`ai.planning.health.${statusUpdate.health}`)} />
            <StatusUpdateRow label={t('ai.planning.status.risk')} value={t(`ai.planning.risk.${statusUpdate.risk}`)} />
            <StatusUpdateRow label={t('ai.planning.status.summary')} value={statusUpdate.summary} />
            <StatusUpdateRow label={t('ai.planning.status.riskSummary')} value={statusUpdate.riskSummary} />
            <StatusUpdateRow label={t('ai.planning.status.decisionSummary')} value={statusUpdate.decisionSummary} />
            <StatusUpdateRow label={t('ai.planning.status.helpNeeded')} value={statusUpdate.helpNeeded} />
            <StatusUpdateRow label={t('ai.planning.status.nextAction')} value={statusUpdate.nextAction} />
          </dl>
          <AiDraftEvidenceMeta
            citations={citations}
            citationIds={statusUpdate.citationIds}
            confidence={statusUpdate.confidence}
            t={t}
          />
        </>
      )}
    </section>
  )
}

/** Props for one status update definition row. */
type StatusUpdateRowProps = {
  /** Visible localized definition term. */
  label: string
  /** Generated or enumerated display value. */
  value: string
}

/** Renders one status update term and whitespace-preserving value. */
function StatusUpdateRow({ label, value }: StatusUpdateRowProps) {
  return (
    <div className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 max-[520px]:grid-cols-1 max-[520px]:gap-1">
      <dt className="font-semibold text-[var(--workbench-muted)]">{label}</dt>
      <dd className="whitespace-pre-wrap text-[var(--workbench-text)]">{value || '—'}</dd>
    </div>
  )
}

/** Props for a planning section without proposals. */
type EmptyPlanningSectionProps = {
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/** Renders an explicit empty state for one proposal category. */
function EmptyPlanningSection({ t }: EmptyPlanningSectionProps) {
  return <p className="mt-2 text-app-caption text-[var(--workbench-muted)]">{t('ai.planning.empty')}</p>
}

/** Builds ordered Work Item field proposals from optional contract values. */
function createSuggestedFields(
  draft: AiPlanningDraft,
  locale: 'ja' | 'en',
  resolveStatusLabel: AiPlanningDraftReviewProps['resolveStatusLabel'],
  t: (key: MessageKey) => string,
): PlanningSuggestedField[] {
  const fields: PlanningSuggestedField[] = []
  if (draft.title) {
    fields.push({ key: 'title', label: t('ai.planning.field.title'), ...draft.title })
  }
  if (draft.description) {
    fields.push({
      key: 'description',
      label: t('ai.planning.field.description'),
      multiline: true,
      ...draft.description,
    })
  }
  if (draft.priority) {
    fields.push({
      citationIds: draft.priority.citationIds,
      confidence: draft.priority.confidence,
      key: 'priority',
      label: t('ai.planning.field.priority'),
      reason: draft.priority.reason,
      value: t(`ai.planning.priority.${draft.priority.value}`),
    })
  }
  if (draft.status) {
    fields.push({
      citationIds: draft.status.citationIds,
      confidence: draft.status.confidence,
      key: 'status',
      label: t('ai.planning.field.status'),
      reason: draft.status.reason,
      value: resolveStatusLabel?.(draft.status.value) || draft.status.value,
    })
  }
  if (draft.plannedEffortMinutes) {
    fields.push({
      citationIds: draft.plannedEffortMinutes.citationIds,
      confidence: draft.plannedEffortMinutes.confidence,
      key: 'planned-effort',
      label: t('ai.planning.field.effort'),
      reason: draft.plannedEffortMinutes.reason,
      value: formatEffort(draft.plannedEffortMinutes.value, locale, t),
    })
  }
  return fields
}

/** Formats a non-negative effort estimate without coupling to a Planning form. */
function formatEffort(
  totalMinutes: number,
  locale: 'ja' | 'en',
  t: (key: MessageKey) => string,
): string {
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  const formattedHours = hours.toLocaleString(locale)
  const formattedMinutes = minutes.toLocaleString(locale)
  if (hours > 0 && minutes > 0) {
    return replaceTokens(t('ai.planning.effort.hoursMinutes'), {
      hours: formattedHours,
      minutes: formattedMinutes,
    })
  }
  return hours > 0
    ? t('ai.planning.effort.hours').replace('{hours}', formattedHours)
    : t('ai.planning.effort.minutes').replace('{minutes}', formattedMinutes)
}

/** Formats a dependency lead or lag using a signed day count. */
function formatLag(
  lagDays: number,
  locale: 'ja' | 'en',
  t: (key: MessageKey) => string,
): string {
  if (lagDays === 0) return t('ai.planning.dependency.none')
  const days = Math.abs(lagDays).toLocaleString(locale)
  return t(lagDays > 0 ? 'ai.planning.dependency.lag' : 'ai.planning.dependency.lead')
    .replace('{days}', days)
}

/** Resolves an authorized dependency endpoint or uses its Team-qualified identifier. */
function resolveEndpointLabel(
  endpoint: WorkItemDependencyEndpoint,
  resolver: AiPlanningDraftReviewProps['resolveWorkItemLabel'],
): string {
  return resolver?.(endpoint) || `${endpoint.teamId} / ${endpoint.workItemId}`
}

/** Replaces all named display tokens in a localized message. */
function replaceTokens(template: string, values: Readonly<Record<string, string>>): string {
  let result = template
  for (const [key, value] of Object.entries(values)) {
    result = result.replace(`{${key}}`, value)
  }
  return result
}
