import type { AiAssistanceCitation } from '@mukuroji/contracts'
import { isSafeApplicationPath } from '../../../shared/routing/applicationPath'

/**
 * Validates that every generated claim has a currently safe, unique evidence target.
 *
 * @param citations - Permission-safe citations supplied by the review boundary.
 * @param referenceGroups - Citation identifiers attached to every claim that will render.
 * @returns Whether all citations and claim references are safe and internally consistent.
 */
export function hasValidAiEvidenceReferences(
  citations: readonly AiAssistanceCitation[],
  referenceGroups: readonly (readonly string[])[],
): boolean {
  const citationIds = new Set<string>()
  for (const citation of citations) {
    if (citationIds.has(citation.id) || !isSafeApplicationPath(citation.href)) return false
    citationIds.add(citation.id)
  }

  return referenceGroups.every((references) =>
    references.length > 0 && references.every((citationId) => citationIds.has(citationId)))
}
