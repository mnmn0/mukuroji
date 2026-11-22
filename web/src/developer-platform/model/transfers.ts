import type {
  CanonicalWorkItem,
  CreateImportDryRunInput,
  ImportJob,
  ScheduleDependencyConstraint,
  ScheduleDependencyType,
  TeamWorkItemHierarchyNode,
  WorkItemContributorAssignment,
  WorkItemScheduleDependency,
} from '@mukuroji/contracts'
import {
  createMultiTeamWorkItemOutlineRows,
  createWorkItemOutlineKey,
} from '../../work-items/model/workItemHierarchy'
import { createMsProjectXml, type MsProjectTaskInput } from './msProjectXml'
import { createSpreadsheetWorkbook } from './spreadsheet'

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
 * Supported Work Item export format; `msproject` is MS Project XML.
 */
export type DeveloperExportFormat = 'csv' | 'json' | 'xlsx' | 'msproject'

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

/** Structure read alongside the exported Work Items. */
export type DeveloperExportContext = {
  /** Hierarchy nodes in outline order by Team; a Team left out has no WBS numbers or parents. */
  hierarchies: ReadonlyMap<string, readonly TeamWorkItemHierarchyNode[]>
  /** Schedule dependencies; only those between exported Work Items are written. */
  dependencies: readonly WorkItemScheduleDependency[]
}

/** One exported Work Item with its place in the outline and its links. */
export type DeveloperExportRow = {
  /** Exported Work Item. */
  workItem: CanonicalWorkItem
  /** Outline number across the whole export, such as `2.1`. */
  wbsNumber: string
  /** One-based outline level among the exported Work Items. */
  outlineLevel: number
  /** Nearest exported ancestor. */
  parentId?: string
  /** Predecessors among the exported Work Items. */
  dependencies: Array<{
    /** Predecessor Work Item ID. */
    key: string
    /** Dependency type. */
    type: ScheduleDependencyType
    /** Signed lag in calendar days. */
    lagDays: number
    /** Explicit date constraint on the successor, if any. */
    constraint?: ScheduleDependencyConstraint
  }>
  /** Relations to other exported Work Items, without parent and child. */
  relations: Array<{
    /** Relation type as stored, such as `blocks`. */
    type: string
    /** Related Work Item ID. */
    key: string
  }>
  /** Contributor assignments without their server-assigned IDs. */
  contributors: Array<Omit<WorkItemContributorAssignment, 'assignmentId'>>
  /** Acceptance criteria without their server-assigned IDs. */
  acceptanceCriteria: Array<{
    /** Criterion text. */
    text: string
    /** Whether the criterion is met. */
    satisfied: boolean
  }>
}

/** Export columns before the custom fields, in file order. */
const exportColumns = [
  'id',
  'teamId',
  'wbsNumber',
  'outlineLevel',
  'parentId',
  'title',
  'description',
  'assignedProjectId',
  'assigneeUserId',
  'workItemTypeId',
  'workflowStatusId',
  'statusCategory',
  'dueDate',
  'schedule',
  'priority',
  'dependencies',
  'relations',
  'contributors',
  'acceptanceCriteria',
  'revision',
  'createdAt',
  'updatedAt',
] as const

/** Abbreviations of the dependency types, as import reads them. */
const dependencyTypeAbbreviations: Record<ScheduleDependencyType, string> = {
  'finish-to-start': 'FS',
  'start-to-start': 'SS',
  'finish-to-finish': 'FF',
  'start-to-finish': 'SF',
}

/**
 * Builds the download of exported Work Items in outline order.
 *
 * Every format carries the parent, WBS number, outline level, schedule dependencies, relations,
 * contributors, and acceptance criteria in the shape that import reads back, so an exported file
 * re-imports into the same structure. Links to Work Items outside the export are left out.
 *
 * @param format - Export format.
 * @param workItems - Exported Work Items.
 * @param context - Hierarchies and dependencies read for the exported Teams.
 * @param exportedAt - Time used for the file name and the workbook entries.
 * @returns Browser download に使う Blob と file 名です。
 */
export function createDeveloperExportFile(
  format: DeveloperExportFormat,
  workItems: readonly CanonicalWorkItem[],
  context: DeveloperExportContext,
  exportedAt = new Date(),
): DeveloperExportFile {
  const suffix = exportedAt.toISOString().slice(0, 10)
  const rows = createDeveloperExportRows(workItems, context)
  if (format === 'json') {
    const body = `${JSON.stringify({
      apiVersion: '2026-07-01',
      workItems: rows.map(toExportWorkItem),
    }, null, 2)}\n`

    return {
      blob: new Blob([body], {
        type: 'application/json; charset=utf-8',
      }),
      fileName: `mukuroji-work-items-${suffix}.json`,
    }
  }
  if (format === 'msproject') {
    return {
      blob: new Blob([createMsProjectXml('mukuroji Work Items', rows.map(toMsProjectTask))], {
        type: 'application/xml; charset=utf-8',
      }),
      fileName: `mukuroji-work-items-${suffix}.xml`,
    }
  }

  const { headers, cells } = createDeveloperExportTable(rows)
  if (format === 'xlsx') {
    const workbook = createSpreadsheetWorkbook([{
      name: 'Work Items',
      columns: headers,
      dateColumns: new Set(['dueDate']),
      rows: cells.map((row) => row.map((cell) => cell || null)),
    }], exportedAt)
    return {
      blob: new Blob([new Uint8Array(workbook)], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      fileName: `mukuroji-work-items-${suffix}.xlsx`,
    }
  }
  const lines = [headers, ...cells].map((row) => row.map(escapeDeveloperExportCsvValue).join(','))

  return {
    blob: new Blob(
      [`\ufeff${lines.join('\r\n')}\r\n`],
      { type: 'text/csv; charset=utf-8' },
    ),
    fileName: `mukuroji-work-items-${suffix}.csv`,
  }
}

/**
 * Builds the header and text cells shared by the CSV and workbook exports.
 *
 * @param rows - Export rows in outline order.
 * @returns Header names and one text cell per header for each row; an empty cell is `''`.
 */
export function createDeveloperExportTable(rows: readonly DeveloperExportRow[]) {
  const customFieldIds = [...new Set(
    rows.flatMap((row) => Object.keys(row.workItem.customFieldValues)),
  )].sort()
  const headers = [
    ...exportColumns,
    ...customFieldIds.map((fieldId) => `customFieldValues.${fieldId}`),
  ]
  const cells = rows.map((row) => [
    ...exportColumns.map((column) => readExportCell(row, column)),
    ...customFieldIds.map((fieldId) => serializeDeveloperExportCell(row.workItem.customFieldValues[fieldId])),
  ])
  return { headers, cells }
}

/**
 * Orders exported Work Items as an outline and reads their links among themselves.
 *
 * @param workItems - Exported Work Items.
 * @param context - Hierarchies and dependencies.
 * @returns Rows in outline order.
 */
export function createDeveloperExportRows(
  workItems: readonly CanonicalWorkItem[],
  context: DeveloperExportContext,
): DeveloperExportRow[] {
  const exportedIds = new Set(workItems.map((workItem) => workItem.id))
  const exportedKeys = new Set(workItems.map((workItem) => createWorkItemOutlineKey(workItem.teamId, workItem.id)))
  const dependenciesBySuccessor = new Map<string, DeveloperExportRow['dependencies']>()
  for (const dependency of context.dependencies) {
    const predecessorKey = createWorkItemOutlineKey(dependency.predecessor.teamId, dependency.predecessor.workItemId)
    const successorKey = createWorkItemOutlineKey(dependency.successor.teamId, dependency.successor.workItemId)
    if (!exportedKeys.has(predecessorKey) || !exportedKeys.has(successorKey)) continue
    dependenciesBySuccessor.set(successorKey, [
      ...(dependenciesBySuccessor.get(successorKey) ?? []),
      {
        key: dependency.predecessor.workItemId,
        type: dependency.type,
        lagDays: dependency.lagDays,
        ...(dependency.constraint ? { constraint: dependency.constraint } : {}),
      },
    ])
  }
  const outline = createMultiTeamWorkItemOutlineRows(workItems, context.hierarchies, new Set())
  const ancestors: string[] = []
  let previousTeamId: string | undefined
  // Each Team numbers its WBS from 1, so the export numbers its rows from the outline instead;
  // the numbers then stay unique when they are imported again as references.
  const outlineCounters: number[] = []
  return outline.map(({ item: workItem, depth }) => {
    outlineCounters.length = Math.min(outlineCounters.length, depth + 1)
    const counterIndex = Math.min(depth, outlineCounters.length)
    outlineCounters[counterIndex] = (outlineCounters[counterIndex] ?? 0) + 1
    const wbsNumber = outlineCounters.join('.')
    if (workItem.teamId !== previousTeamId) ancestors.length = 0
    previousTeamId = workItem.teamId
    ancestors.length = Math.min(ancestors.length, depth)
    const parentId = depth > 0 ? ancestors[depth - 1] : undefined
    ancestors[depth] = workItem.id
    const key = createWorkItemOutlineKey(workItem.teamId, workItem.id)
    return {
      workItem,
      wbsNumber,
      outlineLevel: depth + 1,
      ...(parentId ? { parentId } : {}),
      dependencies: dependenciesBySuccessor.get(key) ?? [],
      relations: workItem.relationIds.flatMap((relationId) => {
        const separator = relationId.indexOf(':')
        const type = relationId.slice(0, separator)
        const target = relationId.slice(separator + 1)
        return separator > 0 && type !== 'parent' && type !== 'child' && exportedIds.has(target)
          ? [{ type, key: target }]
          : []
      }),
      contributors: (workItem.contributorAssignments ?? []).map((assignment) => ({
        ...(assignment.memberUserId ? { memberUserId: assignment.memberUserId } : {}),
        ...(assignment.jobRoleId ? { jobRoleId: assignment.jobRoleId } : {}),
        ...(assignment.plannedEffortMinutes === undefined ? {} : { plannedEffortMinutes: assignment.plannedEffortMinutes }),
        status: assignment.status,
      })),
      acceptanceCriteria: (workItem.acceptanceCriteria ?? []).map((criterion) => ({
        text: criterion.text,
        satisfied: criterion.satisfied,
      })),
    }
  })
}

/**
 * Reads one text cell of the CSV and workbook exports.
 *
 * @param row - Export row.
 * @param column - Fixed export column.
 * @returns Cell text, empty for a missing value.
 */
function readExportCell(row: DeveloperExportRow, column: (typeof exportColumns)[number]) {
  const { workItem } = row
  switch (column) {
    case 'wbsNumber':
      return row.wbsNumber
    case 'outlineLevel':
      return String(row.outlineLevel)
    case 'parentId':
      return row.parentId ?? ''
    case 'dependencies':
      // The compact form has no place for a date constraint, so such a cell is a JSON array.
      if (row.dependencies.some((dependency) => dependency.constraint)) return JSON.stringify(row.dependencies)
      return row.dependencies.map((dependency) =>
        `${dependency.key} ${dependencyTypeAbbreviations[dependency.type]}${
          dependency.lagDays ? ` ${dependency.lagDays > 0 ? '+' : ''}${dependency.lagDays}` : ''}`).join('; ')
    case 'relations':
      return row.relations.map((relation) => `${relation.type}:${relation.key}`).join('; ')
    case 'contributors':
      return row.contributors.map((contributor) => [
        contributor.memberUserId ? `member:${contributor.memberUserId}` : '',
        contributor.jobRoleId ? `role:${contributor.jobRoleId}` : '',
        contributor.plannedEffortMinutes === undefined ? '' : `effort:${contributor.plannedEffortMinutes}`,
        `status:${contributor.status}`,
      ].filter(Boolean).join(' ')).join('; ')
    case 'acceptanceCriteria':
      return writeAcceptanceCriteriaCell(row.acceptanceCriteria)
    case 'workItemTypeId':
      return workItem.workItemTypeId ?? ''
    case 'description':
      return workItem.description ?? ''
    case 'assignedProjectId':
      return workItem.assignedProjectId ?? ''
    default:
      return serializeDeveloperExportCell(workItem[column])
  }
}

/**
 * Builds the JSON export entry of one Work Item.
 *
 * @param row - Export row.
 * @returns The entry; optional values are left out when empty.
 */
function toExportWorkItem(row: DeveloperExportRow) {
  const { workItem } = row
  return {
    id: workItem.id,
    teamId: workItem.teamId,
    wbsNumber: row.wbsNumber,
    outlineLevel: row.outlineLevel,
    ...(row.parentId ? { parentId: row.parentId } : {}),
    title: workItem.title,
    ...(workItem.description
      ? { description: workItem.description }
      : {}),
    ...(workItem.assignedProjectId
      ? { assignedProjectId: workItem.assignedProjectId }
      : {}),
    assigneeUserId: workItem.assigneeUserId,
    ...(workItem.workItemTypeId ? { workItemTypeId: workItem.workItemTypeId } : {}),
    workflowStatusId: workItem.workflowStatusId,
    statusCategory: workItem.statusCategory,
    customFieldValues: structuredClone(workItem.customFieldValues),
    relationIds: [...workItem.relationIds],
    dueDate: workItem.dueDate,
    schedule: structuredClone(workItem.schedule),
    priority: workItem.priority,
    ...(row.dependencies.length ? { dependencies: row.dependencies } : {}),
    ...(row.relations.length ? { relations: row.relations } : {}),
    ...(row.contributors.length ? { contributors: row.contributors } : {}),
    ...(row.acceptanceCriteria.length ? { acceptanceCriteria: row.acceptanceCriteria } : {}),
    revision: workItem.revision,
    createdAt: workItem.createdAt,
    updatedAt: workItem.updatedAt,
  }
}

/**
 * Writes acceptance criteria as one text cell.
 *
 * Criteria are written one per line with `[x]` or `[ ]`. When a criterion has a line break, or
 * starts with a mark that the line format drops, the cell is a JSON array instead, which import
 * also reads, so the criteria keep their boundaries and states.
 *
 * @param criteria - Criteria of the Work Item.
 * @returns Cell text, empty without criteria.
 */
function writeAcceptanceCriteriaCell(criteria: DeveloperExportRow['acceptanceCriteria']) {
  if (criteria.some((criterion) => /[\r\n]/u.test(criterion.text) || /^(?:\[|[-*・])/u.test(criterion.text))) {
    return JSON.stringify(criteria.map((criterion) => ({ text: criterion.text, satisfied: criterion.satisfied })))
  }
  return criteria.map((criterion) => `${criterion.satisfied ? '[x]' : '[ ]'} ${criterion.text}`).join('\n')
}

/**
 * Builds the MS Project task of one Work Item.
 *
 * @param row - Export row.
 * @returns The task, with its dates from the schedule.
 */
function toMsProjectTask(row: DeveloperExportRow): MsProjectTaskInput {
  const { workItem } = row
  const schedule = workItem.schedule
  // A due date is written as a finish without a start, so it re-imports as a due date.
  const dates = schedule.mode === 'due-date'
    ? { finishDate: schedule.dueDate }
    : schedule.mode === 'unscheduled'
      ? {}
      : { startDate: schedule.startDate, finishDate: schedule.endDate }
  return {
    key: workItem.id,
    name: workItem.title,
    ...(workItem.description ? { notes: workItem.description } : {}),
    wbsNumber: row.wbsNumber,
    outlineLevel: row.outlineLevel,
    ...dates,
    ...(schedule.mode === 'milestone' ? { milestone: true } : {}),
    completed: workItem.statusCategory === 'completed',
    ownerUserId: workItem.assigneeUserId,
    contributors: row.contributors.flatMap((contributor) => contributor.memberUserId
      ? [{
          memberUserId: contributor.memberUserId,
          ...(contributor.plannedEffortMinutes === undefined ? {} : { plannedEffortMinutes: contributor.plannedEffortMinutes }),
        }]
      : []),
    dependencies: row.dependencies.map((dependency) => ({
      predecessorKey: dependency.key,
      type: dependency.type,
      lagDays: dependency.lagDays,
    })),
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
