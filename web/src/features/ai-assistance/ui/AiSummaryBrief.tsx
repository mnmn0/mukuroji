import type {
  AiAssistanceCitation,
  AiBriefItem,
  AiSummaryDraft,
} from '@mukuroji/contracts'
import type { MessageKey } from '../../../shared/i18n/i18n'
import { hasValidAiEvidenceReferences } from '../model/aiEvidenceValidation'
import { AiDraftEvidenceMeta } from './AiDraftEvidence'

/** Props for a grounded AI summary rendered inside the authorization-aware review shell. */
export type AiSummaryBriefProps = {
  /** Permission-safe citations supplied by the available-content review boundary. */
  citations: readonly AiAssistanceCitation[]
  /** Validated summary draft that remains unapplied until human review. */
  draft: AiSummaryDraft
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Renders a grounded overview, decisions, actions, and risks with claim-level evidence.
 *
 * @param props - Authorized summary draft, permission-safe citations, and localized labels.
 * @returns A flat evidence-first brief, or a fail-closed validation message.
 */
export function AiSummaryBrief({ citations, draft, t }: AiSummaryBriefProps) {
  const allItems = [
    draft.overview,
    ...draft.decisions,
    ...draft.actions,
    ...draft.risks,
  ]
  if (!hasValidAiEvidenceReferences(
    citations,
    allItems.map((item) => item.citationIds),
  )) {
    return (
      <p className="text-app-body font-semibold text-[var(--workbench-danger)]" role="alert">
        {t('ai.error.validation')}
      </p>
    )
  }

  return (
    <div className="grid gap-5" data-testid="ai-summary-brief">
      <section>
        <h3 className="text-app-caption font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
          {t('ai.summary.overview')}
        </h3>
        <p className="mt-2 whitespace-pre-wrap text-app-body font-semibold leading-6 text-[var(--workbench-text)]">
          {draft.overview.text}
        </p>
        <AiDraftEvidenceMeta
          citations={citations}
          citationIds={draft.overview.citationIds}
          confidence={draft.overview.confidence}
          t={t}
        />
      </section>

      <AiBriefSection citations={citations} items={draft.decisions} title={t('ai.summary.decisions')} t={t} />
      <AiBriefSection citations={citations} items={draft.actions} title={t('ai.summary.actions')} t={t} />
      <AiBriefSection citations={citations} items={draft.risks} title={t('ai.summary.risks')} t={t} />
    </div>
  )
}

/** Props for one flat summary claim group. */
type AiBriefSectionProps = {
  /** Permission-safe citations available to each item. */
  citations: readonly AiAssistanceCitation[]
  /** Ordered generated claims in this group. */
  items: readonly AiBriefItem[]
  /** Visible localized group title. */
  title: string
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/** Renders one brief group with separated claims and explicit empty state. */
function AiBriefSection({ citations, items, title, t }: AiBriefSectionProps) {
  return (
    <section className="border-t border-[var(--workbench-border)] pt-4">
      <h3 className="text-app-caption font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
        {title}
      </h3>
      {items.length === 0 ? (
        <p className="mt-2 text-app-caption text-[var(--workbench-muted)]">{t('ai.summary.empty')}</p>
      ) : (
        <ol className="mt-1 divide-y divide-[var(--workbench-border)]">
          {items.map((item) => (
            <li className="py-3" key={item.id}>
              <p className="whitespace-pre-wrap text-app-body leading-6 text-[var(--workbench-text)]">
                {item.text}
              </p>
              <AiDraftEvidenceMeta
                citations={citations}
                citationIds={item.citationIds}
                confidence={item.confidence}
                t={t}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
