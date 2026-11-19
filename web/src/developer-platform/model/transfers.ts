import type {
  CanonicalWorkItem,
  CreateImportDryRunInput,
  ImportJob,
} from '@mukuroji/contracts'
import { readRecord } from '../../shared/api/jsonValidation'
import { createWorkItemOutlineKey } from '../../work-items/model/workItemHierarchy'

/**
 * Mapping between a source field and a Work Item field.
 */
export type DeveloperImportFieldMapping = ImportJob['mapping'][number]

/**
 * Supported import source format.
 */
export type DeveloperImportFormat = ImportJob['format']

/**
 * Input used for both import dry-runs and committed imports.
 */
export type DryRunDeveloperImportInput = CreateImportDryRunInput

/**
 * Supported Work Item export format.
 */
export type DeveloperExportFormat = 'csv' | 'json'

/**
 * Replaces one property in an import mapping row without mutating the source.
 *
 * @param mappings - Current import mapping rows.
 * @param index - Row index to update.
 * @param property - Mapping property to replace.
 * @param value - New property value.
 * @returns A new mapping array containing the updated row.
 */
export function updateImportMapping(
  mappings: DeveloperImportFieldMapping[],
  index: number,
  property: keyof DeveloperImportFieldMapping,
  value: string,
) {
  return mappings.map((mapping, mappingIndex) =>
    mappingIndex === index
      ? { ...mapping, [property]: value }
      : mapping,
  )
}

/**
 * Filters import Project options to the selected Team.
 *
 * @param options - Project options containing Team ownership.
 * @param teamId - Selected Team identifier.
 * @returns Project options owned by the selected Team.
 */
export function filterImportProjectOptions<
  TOption extends { teamId: string },
>(options: TOption[], teamId: string) {
  return options.filter((option) => option.teamId === teamId)
}

/**
 * Selects the most recently created import job.
 *
 * @param imports - Import jobs returned by the aggregate resource.
 * @returns Most recent import job, or undefined when the list is empty.
 */
export function selectLatestImport(imports: ImportJob[]) {
  return [...imports].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  )[0]
}

/**
 * Work Item export response と download metadata です。
 */
export type DeveloperExportFile = {
  /**
   * Browser download に渡す response body です。
   */
  blob: Blob
  /**
   * UI が export 日と format から生成した file 名です。
   */
  fileName: string
}

/**
 * Builds the CSV or JSON download of exported Work Items.
 *
 * @param format - CSV または JSON の export format です。
 * @param workItems - Exported Work Items.
 * @param wbsNumbers - WBS numbers by `createWorkItemOutlineKey` key; a missing number leaves the cell empty.
 * @returns Browser download に使う Blob と file 名です。
 */
export function createDeveloperExportFile(
  format: DeveloperExportFormat,
  workItems: readonly CanonicalWorkItem[],
  wbsNumbers: ReadonlyMap<string, string>,
): DeveloperExportFile {
  const suffix = new Date().toISOString().slice(0, 10)
  /** Reads the WBS number of one exported Work Item. */
  const readWbsNumber = (workItem: CanonicalWorkItem) =>
    wbsNumbers.get(createWorkItemOutlineKey(workItem.teamId, workItem.id))
  if (format === 'json') {
    const body = `${JSON.stringify({
      apiVersion: '2026-07-01',
      workItems: workItems.map((workItem) => toExportWorkItem(workItem, readWbsNumber(workItem))),
    }, null, 2)}\n`

    return {
      blob: new Blob([body], {
        type: 'application/json; charset=utf-8',
      }),
      fileName: `mukuroji-work-items-${suffix}.json`,
    }
  }

  const customFieldIds = [...new Set(
    workItems.flatMap((workItem) =>
      Object.keys(workItem.customFieldValues)
    ),
  )].sort()
  const headers = [
    'id',
    'teamId',
    'wbsNumber',
    'title',
    'description',
    'assignedProjectId',
    'assigneeUserId',
    'workflowStatusId',
    'statusCategory',
    'dueDate',
    'schedule',
    'priority',
    'revision',
    'createdAt',
    'updatedAt',
    ...customFieldIds.map(
      (fieldId) => `customFieldValues.${fieldId}`,
    ),
  ]
  const lines = [
    headers.map(escapeDeveloperExportCsvValue).join(','),
    ...workItems.map((workItem) =>
      headers.map((header) => {
        const value = header.startsWith('customFieldValues.')
          ? workItem.customFieldValues[
              header.slice('customFieldValues.'.length)
            ]
          : header === 'wbsNumber'
            ? readWbsNumber(workItem)
            : readRecord(workItem)[header]

        return escapeDeveloperExportCsvValue(
          serializeDeveloperExportCell(value),
        )
      }).join(',')
    ),
  ]

  return {
    blob: new Blob(
      [`\ufeff${lines.join('\r\n')}\r\n`],
      { type: 'text/csv; charset=utf-8' },
    ),
    fileName: `mukuroji-work-items-${suffix}.csv`,
  }
}

/**
 * Builds the JSON export entry of one Work Item.
 *
 * @param workItem - Exported Work Item.
 * @param wbsNumber - Its WBS number, if its Team's hierarchy could be read.
 * @returns The entry, without the WBS number when it is unknown.
 */
function toExportWorkItem(workItem: CanonicalWorkItem, wbsNumber: string | undefined) {
  return {
    id: workItem.id,
    teamId: workItem.teamId,
    ...(wbsNumber ? { wbsNumber } : {}),
    title: workItem.title,
    ...(workItem.description
      ? { description: workItem.description }
      : {}),
    ...(workItem.assignedProjectId
      ? { assignedProjectId: workItem.assignedProjectId }
      : {}),
    assigneeUserId: workItem.assigneeUserId,
    workflowStatusId: workItem.workflowStatusId,
    statusCategory: workItem.statusCategory,
    customFieldValues: structuredClone(workItem.customFieldValues),
    relationIds: [...workItem.relationIds],
    dueDate: workItem.dueDate,
    schedule: structuredClone(workItem.schedule),
    priority: workItem.priority,
    revision: workItem.revision,
    createdAt: workItem.createdAt,
    updatedAt: workItem.updatedAt,
  }
}

/**
 * Turns one CSV cell value into text; objects and arrays become JSON.
 *
 * @param value - Cell value.
 * @returns The text, empty for a missing value.
 */
function serializeDeveloperExportCell(value: unknown) {
  if (value === undefined || value === null) {
    return ''
  }
  if (
    Array.isArray(value) ||
    (typeof value === 'object' && value !== null)
  ) {
    return JSON.stringify(value)
  }

  return String(value)
}

/**
 * Quotes one CSV cell and prefixes a leading formula character so spreadsheets read it as text.
 *
 * @param value - Cell text.
 * @returns The escaped cell.
 */
function escapeDeveloperExportCsvValue(value: string) {
  const safeValue = /^[\t\r\n ]*[=+\-@]/u.test(value)
    ? `'${value}`
    : value

  return /[",\r\n]/u.test(safeValue)
    ? `"${safeValue.replaceAll('"', '""')}"`
    : safeValue
}
