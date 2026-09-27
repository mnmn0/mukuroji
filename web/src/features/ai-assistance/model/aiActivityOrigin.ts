import { isSafeApplicationPath } from '../../../shared/routing/applicationPath'

/** Selection keys needed to return to an existing source, excluding free-text searches. */
const selectionKeys = new Set([
  'teamId', 'projectId', 'taskId', 'workItemId', 'issueId', 'entryId', 'submissionId',
  'formId', 'documentId', 'entityId', 'targetType', 'tab', 'panel', 'view', 'collaborationTab',
])

/**
 * Retains only route and source-selection parameters in session metadata.
 * @param pathname - Workspace route that owns the assistant.
 * @param search - Current URL parameters, potentially containing search text.
 * @returns An internal source path without queries, prompts, or arbitrary URL data.
 */
export function createAiActivityOrigin(pathname: string, search: string): string {
  if (!isSafeApplicationPath(pathname)) return ''
  const selected = new URLSearchParams()
  for (const [key, value] of new URLSearchParams(search)) {
    if (selectionKeys.has(key)) selected.set(key, value)
  }
  const encoded = selected.toString()
  return encoded ? `${pathname}?${encoded}` : pathname
}
