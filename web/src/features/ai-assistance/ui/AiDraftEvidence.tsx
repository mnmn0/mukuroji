import type {
  AiAssistanceCitation,
  AiAssistanceConfidence,
} from '@mukuroji/contracts'
import type { MessageKey } from '../../../shared/i18n/i18n'
import { ExternalLinkIcon } from '../../../shared/ui/icons'

/** Props for evidence and confidence displayed beside one generated claim. */
export type AiDraftEvidenceMetaProps = {
  /** Permission-safe citations available to the current reviewer. */
  citations: readonly AiAssistanceCitation[]
  /** Generation-local citation identifiers supporting this claim. */
  citationIds: readonly string[]
  /** Model-estimated confidence for this claim. */
  confidence: AiAssistanceConfidence
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Renders confidence and direct evidence links adjacent to one generated claim.
 *
 * @param props - Validated evidence references, confidence, and localized labels.
 * @returns A compact evidence row that does not expose generation-local identifiers.
 */
export function AiDraftEvidenceMeta({
  citations,
  citationIds,
  confidence,
  t,
}: AiDraftEvidenceMetaProps) {
  const referencedCitations: AiAssistanceCitation[] = []
  for (const citationId of citationIds) {
    const citation = citations.find((candidate) => candidate.id === citationId)
    if (citation && !referencedCitations.some((candidate) => candidate.id === citation.id)) {
      referencedCitations.push(citation)
    }
  }
  const confidenceClassName = confidence === 'high'
    ? 'border-green-200 bg-green-50 text-green-800'
    : confidence === 'medium'
      ? 'border-amber-200 bg-amber-50 text-amber-800'
      : 'border-red-200 bg-red-50 text-red-800'

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className={`rounded-md border px-2 py-1 text-[11px] font-semibold ${confidenceClassName}`}>
        {t(`ai.review.confidence.${confidence}`)}
      </span>
      <ul aria-label={t('ai.review.citations')} className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
        {referencedCitations.map((citation) => (
          <li key={citation.id}>
            <a
              className="inline-flex min-h-[44px] items-center gap-1 text-app-caption font-semibold text-[var(--workbench-primary)] underline-offset-2 hover:underline"
              href={citation.href}
            >
              <span>{citation.label}</span>
              <ExternalLinkIcon className="h-3.5 w-3.5 fill-none stroke-current stroke-2" />
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}
