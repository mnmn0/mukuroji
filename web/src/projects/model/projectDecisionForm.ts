import type {
  ProjectDecisionEntry,
  ProjectDecisionEntryInput,
  ProjectDecisionOrigin,
  ProjectDecisionSource,
  ProjectDecisionStatus,
} from '@mukuroji/contracts'

/** Values of the decision form, as the inputs hold them. */
export type ProjectDecisionFormValues = {
  /** Short summary. */
  title: string
  /** What was decided. */
  content: string
  /** Why it was decided. */
  rationale: string
  /** Project members who decided. */
  deciderMemberIds: string[]
  /** Deciders outside the Project. */
  deciderNote: string
  /** When the decision was made, as a `datetime-local` value in the viewer's time zone. */
  decidedAtLocal: string
  /** Related Work Items. */
  relatedWorkItemIds: string[]
  /** Source links; empty rows are dropped on save. */
  sources: ProjectDecisionSource[]
  /** Whether the decision still holds. */
  status: ProjectDecisionStatus
  /** Decision replacing this one, when superseded. */
  supersededByEntryId: string
}

/** Values a screen fills in before the form opens. */
export type ProjectDecisionFormPrefill = {
  /** Suggested title, such as the Work Item or Document title. */
  title?: string
  /** Suggested related Work Items. */
  relatedWorkItemIds?: string[]
  /** Suggested source links, such as the Document being read. */
  sources?: ProjectDecisionSource[]
}

/**
 * Formats a timestamp as a `datetime-local` value in the viewer's time zone.
 *
 * @param date - Time to format.
 * @returns `YYYY-MM-DDTHH:mm`.
 */
export function toDateTimeLocalValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Converts a `datetime-local` value in the viewer's time zone to a UTC ISO timestamp.
 *
 * @param value - `YYYY-MM-DDTHH:mm` value.
 * @returns The ISO timestamp, or `undefined` when the value is not a time.
 */
export function fromDateTimeLocalValue(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/**
 * Builds the form values of a decision being edited, or of a new one.
 *
 * @param entry - Decision being edited, or `undefined` for a new one.
 * @param prefill - Values a screen suggests for a new decision.
 * @param now - Current time, the default decision time of a new decision.
 * @returns The form values.
 */
export function toProjectDecisionFormValues(
  entry: ProjectDecisionEntry | undefined,
  prefill: ProjectDecisionFormPrefill = {},
  now = new Date(),
): ProjectDecisionFormValues {
  if (entry) {
    return {
      title: entry.title,
      content: entry.content,
      rationale: entry.rationale ?? '',
      deciderMemberIds: entry.deciderMemberIds ?? [],
      deciderNote: entry.deciderNote ?? '',
      decidedAtLocal: toDateTimeLocalValue(new Date(entry.decidedAt)),
      relatedWorkItemIds: entry.relatedWorkItemIds ?? [],
      sources: entry.sources ?? [],
      status: entry.status,
      supersededByEntryId: entry.supersededByEntryId ?? '',
    }
  }
  return {
    title: prefill.title ?? '',
    content: '',
    rationale: '',
    deciderMemberIds: [],
    deciderNote: '',
    decidedAtLocal: toDateTimeLocalValue(now),
    relatedWorkItemIds: prefill.relatedWorkItemIds ?? [],
    sources: prefill.sources ?? [],
    status: 'active',
    supersededByEntryId: '',
  }
}

/**
 * Converts form values to the input the API accepts. The server validates every field again.
 *
 * @param values - Form values.
 * @param origin - Screen the decision is recorded from; the server keeps the first one.
 * @returns The input, with empty optional fields left out.
 */
export function toProjectDecisionEntryInput(values: ProjectDecisionFormValues, origin: ProjectDecisionOrigin): ProjectDecisionEntryInput {
  const rationale = values.rationale.trim()
  const deciderNote = values.deciderNote.trim()
  const sources = values.sources
    .map((source) => ({ url: source.url.trim(), label: source.label?.trim() ?? '' }))
    .filter((source) => source.url.length > 0)
    .map((source) => (source.label ? { url: source.url, label: source.label } : { url: source.url }))
  const decidedAt = fromDateTimeLocalValue(values.decidedAtLocal) ?? values.decidedAtLocal
  return {
    title: values.title.trim(),
    content: values.content.trim(),
    ...(rationale ? { rationale } : {}),
    ...(values.deciderMemberIds.length > 0 ? { deciderMemberIds: values.deciderMemberIds } : {}),
    ...(deciderNote ? { deciderNote } : {}),
    decidedAt,
    ...(values.relatedWorkItemIds.length > 0 ? { relatedWorkItemIds: values.relatedWorkItemIds } : {}),
    ...(sources.length > 0 ? { sources } : {}),
    status: values.status,
    ...(values.status === 'superseded' && values.supersededByEntryId ? { supersededByEntryId: values.supersededByEntryId } : {}),
    origin,
  }
}

/**
 * Tells whether a source link points to an architecture decision record in a repository, so the
 * log can show that the design decision itself is kept there.
 *
 * @param url - Source URL.
 * @returns Whether the path names an ADR file.
 */
export function isAdrSourceUrl(url: string) {
  try {
    return /\/(?:docs\/)?adrs?\/[^/]+\.md$/iu.test(new URL(url).pathname)
  } catch {
    return false
  }
}
