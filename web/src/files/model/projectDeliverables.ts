import type {
  FileScanStatus,
  ProjectDeliverable,
  ProjectDeliverableApprovalState,
} from '@mukuroji/contracts'
import { escapeSpreadsheetCell } from '../../shared/lib/spreadsheetCell'

/**
 * Column headers and value labels of the Project deliverables CSV.
 */
export type ProjectDeliverableCsvLabels = {
  /**
   * Column headers, in column order.
   */
  headers: {
    /** File name column. */
    file: string
    /** Owner column. */
    owner: string
    /** Current version column. */
    version: string
    /** Scan state column. */
    scan: string
    /** Approval state column. */
    approval: string
    /** Unresolved annotation count column. */
    annotations: string
    /** Update time column. */
    updatedAt: string
  }
  /**
   * Names the owner of a deliverable.
   *
   * @param owner - Project or Work Item that holds the file.
   * @returns The owner label.
   */
  owner: (owner: ProjectDeliverable['owner']) => string
  /**
   * Names a scan state.
   *
   * @param status - Scan state of the current version.
   * @returns The scan label.
   */
  scan: (status: FileScanStatus) => string
  /**
   * Names an approval state.
   *
   * @param state - Approval state of the current version.
   * @returns The approval label.
   */
  approval: (state: ProjectDeliverableApprovalState) => string
}

/**
 * Names the Work Item that holds a deliverable as `KEY title`, or the title alone without a key.
 *
 * @param owner - Work Item owner.
 * @returns The Work Item label.
 */
export function formatDeliverableWorkItemLabel(
  owner: Extract<ProjectDeliverable['owner'], { kind: 'work-item' }>,
) {
  return owner.key ? `${owner.key} ${owner.title}` : owner.title
}

/**
 * Builds the CSV export of Project deliverables, with a header row and CRLF line ends.
 *
 * @param deliverables - Rows to export, in export order.
 * @param labels - Column headers and value labels.
 * @returns CSV text.
 */
export function createProjectDeliverablesCsv(
  deliverables: readonly ProjectDeliverable[],
  labels: ProjectDeliverableCsvLabels,
): string {
  const { headers } = labels
  const rows = [
    [
      headers.file,
      headers.owner,
      headers.version,
      headers.scan,
      headers.approval,
      headers.annotations,
      headers.updatedAt,
    ],
    ...deliverables.map((deliverable) => [
      deliverable.file.name,
      labels.owner(deliverable.owner),
      `v${deliverable.file.currentVersion.number}`,
      labels.scan(deliverable.file.currentVersion.scanStatus),
      labels.approval(deliverable.approvalState),
      String(deliverable.unresolvedAnnotationCount),
      deliverable.file.updatedAt,
    ]),
  ]
  return `${rows.map((row) => row.map(toCsvCell).join(',')).join('\r\n')}\r\n`
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
