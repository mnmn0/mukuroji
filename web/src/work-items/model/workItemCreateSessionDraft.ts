/**
 * Text of a new Work Item form, kept across an ended session.
 *
 * Choices that depend on the Team's configuration when the form opens, such as the Work Item Type
 * or workflow status, start again from the form's defaults.
 */
export type WorkItemCreateSessionDraft = {
  /** Title the member typed. */
  title: string
  /** Description the member typed; empty when the form has none. */
  description: string
}

/**
 * Builds the key under which a new Work Item form's text is kept across an ended session.
 *
 * @param scope - Where the form creates the Work Item, such as `['team', teamId]`.
 * @returns The draft key.
 */
export function createWorkItemCreateSessionDraftKey(scope: readonly string[]): string {
  return `work-item-create:${JSON.stringify(scope)}`
}

/**
 * Builds the draft of a new Work Item form, or nothing when the member has typed no text.
 *
 * @param title - Title field text.
 * @param description - Description field text.
 * @returns The draft, or `undefined` when both fields are blank.
 */
export function createWorkItemCreateSessionDraft(
  title: string,
  description: string,
): WorkItemCreateSessionDraft | undefined {
  return title.trim() || description.trim() ? { title, description } : undefined
}

/**
 * Validates a new Work Item form's text read back after an ended session.
 *
 * @param value - Value kept in this tab.
 * @returns The text, or `undefined` when the value is not one.
 */
export function parseWorkItemCreateSessionDraft(value: unknown): WorkItemCreateSessionDraft | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const title: unknown = Reflect.get(value, 'title')
  const description: unknown = Reflect.get(value, 'description')
  if (typeof title !== 'string' || typeof description !== 'string') return undefined
  return createWorkItemCreateSessionDraft(title, description)
}
