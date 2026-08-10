import type { TriageBulkActionInput } from '../api'
import type { TriageEntryView } from './triageView'

/** Bulk operation whose confirmation form is currently open. */
export type TriageBulkActionMode = 'assign' | 'decline' | 'snooze'

/** Builds a bounded bulk input from selected entry revisions and form values.
 *
 * @param entries - Selected entry views whose revisions must be fenced.
 * @param mode - Bulk action represented by the confirmation form.
 * @param formData - Submitted form values.
 * @returns A validated bulk input, or undefined when required values are missing.
 */
export function createTriageBulkInput(
  entries: readonly TriageEntryView[],
  mode: TriageBulkActionMode,
  formData: FormData,
): TriageBulkActionInput | undefined {
  const targets = entries.map(({ entry }) => ({
    entryId: entry.id,
    expectedRevision: entry.revision,
  }))
  if (mode === 'assign') {
    const ownerUserId = readFormValue(formData, 'ownerUserId')
    const projectId = readFormValue(formData, 'projectId')
    return {
      operation: {
        action: 'assign',
        ownerUserId: ownerUserId || null,
        ...(projectId ? { projectId } : {}),
      },
      targets,
    }
  }
  if (mode === 'decline') {
    const reason = readFormValue(formData, 'reason')
    return reason ? { operation: { action: 'decline', reason }, targets } : undefined
  }
  const localUntil = readFormValue(formData, 'until')
  const until = localUntil ? new Date(localUntil) : undefined
  return until && !Number.isNaN(until.getTime())
    ? { operation: { action: 'snooze', until: until.toISOString() }, targets }
    : undefined
}

/** Reads and trims one string field from a bulk form.
 *
 * @param formData - Submitted bulk action form data.
 * @param key - Field name to read.
 * @returns The trimmed field value, or an empty string when absent/non-text.
 */
function readFormValue(formData: FormData, key: string): string {
  const value = formData.get(key)
  return typeof value === 'string' ? value.trim() : ''
}
