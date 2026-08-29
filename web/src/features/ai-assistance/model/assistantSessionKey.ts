import type {
  AiDocumentSource,
  AiPlanningTargetSource,
  AiWorkItemSource,
} from '@mukuroji/contracts'

/** A source whose identity and revision must fence one mounted AI assistant. */
export type AiAssistantSessionSource =
  | AiDocumentSource
  | AiPlanningTargetSource
  | AiWorkItemSource

/**
 * Serializes an authorized source into a stable assistant remount key.
 *
 * @param source - Exact source identity and revision visible to the operator.
 * @returns A deterministic key that changes with identity, scope, or revision.
 */
export function createAiAssistantSessionKey(
  source: AiAssistantSessionSource,
): string {
  if (source.type === 'document') {
    return JSON.stringify({
      documentId: source.documentId,
      expectedRevision: source.expectedRevision,
      type: source.type,
    })
  }
  if (source.type === 'work-item') {
    return JSON.stringify({
      expectedRevision: source.expectedRevision,
      teamId: source.teamId,
      type: source.type,
      workItemId: source.workItemId,
    })
  }
  return JSON.stringify({
    expectedRevision: source.expectedRevision,
    target: source.target.type === 'project'
      ? {
          projectId: source.target.projectId,
          teamId: source.target.teamId,
          type: source.target.type,
        }
      : {
          entityId: source.target.entityId,
          type: source.target.type,
        },
    type: source.type,
  })
}
