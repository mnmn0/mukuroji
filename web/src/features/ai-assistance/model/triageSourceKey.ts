import type {
  AiRequestSubmissionSource,
  AiTriageEntrySource,
} from '@mukuroji/contracts'

/**
 * Serializes a triage source identity and revision for generation fencing.
 *
 * @param source - Permission-scoped triage or request source reference.
 * @returns A deterministic key that changes when the source identity or revision changes.
 */
export function createTriageSourceKey(
  source: AiTriageEntrySource | AiRequestSubmissionSource,
): string {
  return source.type === 'triage-entry'
    ? JSON.stringify({
        expectedRevision: source.expectedRevision,
        teamId: source.teamId,
        triageEntryId: source.triageEntryId,
        type: source.type,
      })
    : JSON.stringify({
        expectedRevision: source.expectedRevision,
        formId: source.formId,
        submissionId: source.submissionId,
        type: source.type,
      })
}
