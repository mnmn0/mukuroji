import { deriveProjectRaidSeverity, type ProjectRaidEntry, type ProjectRaidSeverity } from '@mukuroji/contracts'
import { escapeSpreadsheetCell } from '../../workspace/model/spreadsheetCell'

/** A member or Work Item the log can name, with the text shown for it. */
export type ProjectRaidReferenceOption = {
  /** Member key or Work Item ID stored on the entry. */
  id: string
  /** Display text, such as a member name or a Work Item key and title. */
  label: string
}

/** Column headers and value labels of the CSV export, in the display language. */
export type ProjectRaidLogCsvLabels = {
  /** Header of each column, in column order. */
  headers: {
    /** Kind column. */
    kind: string
    /** Title column. */
    title: string
    /** Status column. */
    status: string
    /** Severity column. */
    severity: string
    /** Probability column. */
    probability: string
    /** Impact column. */
    impact: string
    /** Owner column. */
    owner: string
    /** Review date column. */
    reviewDueDate: string
    /** Related Work Items column. */
    relatedWorkItems: string
    /** Description column. */
    description: string
    /** Response column. */
    response: string
    /** Creation time column. */
    createdAt: string
    /** Last change column. */
    updatedAt: string
    /** Close time column. */
    closedAt: string
  }
  /**
   * Names an entry's kind.
   *
   * @param entry - Entry.
   * @returns The kind label.
   */
  kind: (entry: ProjectRaidEntry) => string
  /**
   * Names an entry's status.
   *
   * @param entry - Entry.
   * @returns The status label.
   */
  status: (entry: ProjectRaidEntry) => string
  /**
   * Names a severity.
   *
   * @param severity - Severity derived from the entry.
   * @returns The severity label.
   */
  severity: (severity: ProjectRaidSeverity) => string
}

/**
 * Quotes one CSV cell after escaping a leading formula character for spreadsheets.
 *
 * @param value - Cell text.
 * @returns The quoted cell.
 */
function toCsvCell(value: string) {
  return `"${escapeSpreadsheetCell(value).replaceAll('"', '""')}"`
}

/**
 * Finds the display text of a reference, falling back to its ID when it is not among the options,
 * for example a member who has left the Project.
 *
 * @param options - Known references.
 * @param id - Stored ID.
 * @returns The label or the ID.
 */
export function labelProjectRaidReference(options: readonly ProjectRaidReferenceOption[], id: string) {
  return options.find((option) => option.id === id)?.label ?? id
}

/**
 * Builds the CSV export of a Project log, with a header row and CRLF line ends.
 *
 * @param entries - Entries to export, in export order.
 * @param labels - Column headers and value labels.
 * @param owners - Members, to name each owner.
 * @param workItems - Work Items, to name each related Work Item.
 * @returns CSV text.
 */
export function createProjectRaidLogCsv(
  entries: readonly ProjectRaidEntry[],
  labels: ProjectRaidLogCsvLabels,
  owners: readonly ProjectRaidReferenceOption[],
  workItems: readonly ProjectRaidReferenceOption[],
): string {
  const { headers } = labels
  const rows = [
    [
      headers.kind,
      headers.title,
      headers.status,
      headers.severity,
      headers.probability,
      headers.impact,
      headers.owner,
      headers.reviewDueDate,
      headers.relatedWorkItems,
      headers.description,
      headers.response,
      headers.createdAt,
      headers.updatedAt,
      headers.closedAt,
    ],
    ...entries.map((entry) => [
      labels.kind(entry),
      entry.title,
      labels.status(entry),
      labels.severity(deriveProjectRaidSeverity(entry)),
      entry.probability === undefined ? '' : String(entry.probability),
      String(entry.impact),
      entry.ownerMemberId === undefined ? '' : labelProjectRaidReference(owners, entry.ownerMemberId),
      entry.reviewDueDate ?? '',
      (entry.relatedWorkItemIds ?? []).map((id) => labelProjectRaidReference(workItems, id)).join('\n'),
      entry.description ?? '',
      entry.response ?? '',
      entry.createdAt,
      entry.updatedAt,
      entry.closedAt ?? '',
    ]),
  ]
  return `${rows.map((row) => row.map(toCsvCell).join(',')).join('\r\n')}\r\n`
}
