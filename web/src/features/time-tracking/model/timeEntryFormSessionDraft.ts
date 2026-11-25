/**
 * Input of a new time entry form, kept across an ended session.
 */
export type TimeEntryFormSessionDraft = {
  /** Text of each named field, such as `date`, `start`, or `description`, as the member left it. */
  fields: Record<string, string>
  /** Whether the billable box was checked. */
  billable: boolean
}

/** Kind of new time entry a form records. */
export type TimeEntryFormSessionDraftKind = 'work-item' | 'indirect'

/** Named text fields the time entry forms have; other names are not kept. */
const timeEntryFormFieldNames: ReadonlySet<string> = new Set([
  'category',
  'date',
  'description',
  'end',
  'endDate',
  'hours',
  'projectId',
  'start',
  'workItemId',
])

/**
 * Builds the key under which a new time entry form's input is kept across an ended session.
 *
 * @param kind - Whether the form records Work Item time or indirect work.
 * @param scope - Where the form was opened, such as the timesheet or one Work Item.
 * @returns The draft key.
 */
export function createTimeEntryFormSessionDraftKey(
  kind: TimeEntryFormSessionDraftKind,
  scope: readonly string[],
): string {
  return `time-entry:${JSON.stringify([kind, ...scope])}`
}

/**
 * Builds a draft from the text fields and billable box of a time entry form.
 *
 * @param entries - Field names and values as the form holds them.
 * @param billable - Whether the billable box is checked.
 * @returns The draft, keeping only the form's known text fields.
 */
export function createTimeEntryFormSessionDraft(
  entries: Iterable<readonly [string, unknown]>,
  billable: boolean,
): TimeEntryFormSessionDraft {
  const fields: Record<string, string> = {}
  for (const [name, value] of entries) {
    if (timeEntryFormFieldNames.has(name) && typeof value === 'string') fields[name] = value
  }
  return { fields, billable }
}

/**
 * Validates a time entry form input read back after an ended session.
 *
 * @param value - Value kept in this tab.
 * @returns The input, or `undefined` when the value is not one.
 */
export function parseTimeEntryFormSessionDraft(value: unknown): TimeEntryFormSessionDraft | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const fields: unknown = Reflect.get(value, 'fields')
  const billable: unknown = Reflect.get(value, 'billable')
  if (typeof fields !== 'object' || fields === null || typeof billable !== 'boolean') return undefined
  return createTimeEntryFormSessionDraft(Object.entries(fields), billable)
}
