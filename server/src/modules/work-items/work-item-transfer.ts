import type {
  CreateWorkItemInput,
  CustomFieldValue,
  WorkItem,
  WorkItemPriority,
  WorkItemSchedule,
} from '@mukuroji/contracts'
import {
  normalizeWorkItemSchedule,
  WorkItemScheduleError,
} from './domain/work-item-schedule'

/** Import/export で扱う file format です。 */
export type WorkItemTransferFormat = 'csv' | 'json'

/** Import source field と Work Item field の対応です。 */
export type WorkItemTransferMapping = {
  /** Source row に含まれる column/property 名です。 */
  sourceField: string
  /** Work Item field または `customFieldValues.<fieldId>` 形式の保存先です。 */
  targetField: string
  /** Mapping 前に適用する組み込み変換です。 */
  transform?: WorkItemTransferTransform
  /** Source が空で default も無い場合に row error とするかどうかです。 */
  required?: boolean
  /** Source が空の場合に利用する JSON-safe value です。 */
  defaultValue?: unknown
}

/** Import field に適用できる安全な組み込み変換です。 */
export type WorkItemTransferTransform =
  | 'none'
  | 'trim'
  | 'lowercase'
  | 'uppercase'
  | 'parse-date'
  | 'parse-number'
  | 'split-comma'

/** Import row で検出した安定した validation error です。 */
export type WorkItemTransferRowError = {
  /** Header を除く1始まりの row 番号です。 */
  row: number
  /** Error の対象 source/target field です。 */
  field?: string
  /** Client が分岐に利用できる安定した error code です。 */
  code: string
  /** 人が修正内容を判断できる説明です。 */
  message: string
}

/** Dry-run で検証した1 row の結果です。 */
export type WorkItemTransferPreviewRow = {
  /** Header を除く1始まりの row 番号です。 */
  row: number
  /** Validation に成功した canonical create input です。 */
  input?: CreateWorkItemInput
  /** Row に含まれる validation errors です。 */
  errors: WorkItemTransferRowError[]
}

/** Import dry-run の集計と row-level report です。 */
export type WorkItemTransferPreview = {
  /** Source に含まれた全 data row 数です。 */
  totalRows: number
  /** Commit 対象にできる row 数です。 */
  validRows: number
  /** 修正が必要な row 数です。 */
  invalidRows: number
  /** 入力順を維持した dry-run rows です。 */
  rows: WorkItemTransferPreviewRow[]
  /** 全 row の validation errors です。 */
  errors: WorkItemTransferRowError[]
}

/** Work Item export の download payload です。 */
export type WorkItemTransferExport = {
  /** HTTP Content-Type header に設定する media type です。 */
  contentType: string
  /** Content-Disposition に利用する安全な file name です。 */
  fileName: string
  /** UTF-8 encoded export body です。 */
  body: string
}

/** Import parser が返す user-facing validation error です。 */
export class WorkItemTransferError extends Error {
  /** HTTP response に利用する status です。 */
  readonly status: number
  /** Stable API error code です。 */
  readonly code: string

  /** Work Item transfer error を作成します。 */
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'WorkItemTransferError'
    this.status = status
    this.code = code
  }
}

/** 一度の import で受け付ける UTF-8 text の最大 byte 数です。 */
export const WORK_ITEM_IMPORT_MAX_BYTES = 2 * 1024 * 1024

/** 一度の import で dry-run できる最大 row 数です。 */
export const WORK_ITEM_IMPORT_MAX_ROWS = 1_000

const requiredTargetFields = ['title', 'assigneeUserId', 'schedule'] as const
const supportedTargetFields = new Set([
  ...requiredTargetFields,
  'description',
  'assignedProjectId',
  'workflowStatusId',
  'priority',
])

/** CSV/JSON text を mapping し、書き込みを行わず canonical input を検証します。 */
export function previewWorkItemImport(
  format: WorkItemTransferFormat,
  data: string,
  mapping: readonly WorkItemTransferMapping[],
): WorkItemTransferPreview {
  validateImportSize(data)
  const normalizedMapping = normalizeMapping(mapping)
  const sourceRows = format === 'csv' ? parseCsvObjects(data) : parseJsonObjects(data)

  if (sourceRows.length > WORK_ITEM_IMPORT_MAX_ROWS) {
    throw new WorkItemTransferError(
      413,
      'ImportRowLimitExceeded',
      `Import cannot contain more than ${WORK_ITEM_IMPORT_MAX_ROWS} rows.`,
    )
  }

  const rows = sourceRows.map((source, index) => mapImportRow(source, index + 1, normalizedMapping))
  const errors = rows.flatMap((row) => row.errors)
  return {
    totalRows: rows.length,
    validRows: rows.filter((row) => row.errors.length === 0).length,
    invalidRows: rows.filter((row) => row.errors.length > 0).length,
    rows,
    errors,
  }
}

/** Permission-filtered Work Items を CSV または JSON download payload に変換します。 */
export function createWorkItemExport(
  format: WorkItemTransferFormat,
  workItems: readonly WorkItem[],
  exportedAt = new Date(),
): WorkItemTransferExport {
  const suffix = exportedAt.toISOString().slice(0, 10)
  if (format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      fileName: `mukuroji-work-items-${suffix}.json`,
      body: `${JSON.stringify({
        apiVersion: '2026-07-01',
        workItems: workItems.map(toExportWorkItem),
      }, null, 2)}\n`,
    }
  }

  const customFieldIds = [...new Set(
    workItems.flatMap((workItem) => Object.keys(workItem.customFieldValues)),
  )].sort()
  const headers = [
    'id',
    'teamId',
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
    ...customFieldIds.map((fieldId) => `customFieldValues.${fieldId}`),
  ]
  const lines = [
    headers.map(escapeCsvValue).join(','),
    ...workItems.map((workItem) => headers.map((header) => {
      const value = header.startsWith('customFieldValues.')
        ? workItem.customFieldValues[header.slice('customFieldValues.'.length)]
        : (workItem as unknown as Record<string, unknown>)[header]
      return escapeCsvValue(serializeCell(value))
    }).join(',')),
  ]
  return {
    contentType: 'text/csv; charset=utf-8',
    fileName: `mukuroji-work-items-${suffix}.csv`,
    body: `\ufeff${lines.join('\r\n')}\r\n`,
  }
}

function toExportWorkItem(workItem: WorkItem) {
  return {
    id: workItem.id,
    teamId: workItem.teamId,
    title: workItem.title,
    ...(workItem.description ? { description: workItem.description } : {}),
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

function validateImportSize(data: string) {
  if (new TextEncoder().encode(data).byteLength > WORK_ITEM_IMPORT_MAX_BYTES) {
    throw new WorkItemTransferError(
      413,
      'ImportPayloadTooLarge',
      `Import data cannot exceed ${WORK_ITEM_IMPORT_MAX_BYTES} bytes.`,
    )
  }
}

function normalizeMapping(mapping: readonly WorkItemTransferMapping[]) {
  const result = new Map<string, WorkItemTransferMapping>()
  const sourceFields = new Set<string>()

  for (const entry of mapping) {
    const sourceField = entry.sourceField.trim()
    const targetField = entry.targetField.trim()
    if (!sourceField || !isSupportedTargetField(targetField)) {
      throw new WorkItemTransferError(
        400,
        'InvalidImportMapping',
        `Import mapping target "${targetField || '(empty)'}" is invalid.`,
      )
    }
    if (result.has(targetField) || sourceFields.has(sourceField)) {
      throw new WorkItemTransferError(
        400,
        'DuplicateImportMapping',
        'A source or target field cannot be mapped more than once.',
      )
    }
    const transform = readImportTransform(entry.transform)
    if (entry.required !== undefined && typeof entry.required !== 'boolean') {
      throw new WorkItemTransferError(
        400,
        'InvalidImportMapping',
        `Import mapping required flag for "${targetField}" is invalid.`,
      )
    }
    result.set(targetField, {
      sourceField,
      targetField,
      ...(transform === 'none' ? {} : { transform }),
      ...(entry.required === undefined ? {} : { required: entry.required }),
      ...(entry.defaultValue === undefined ? {} : { defaultValue: entry.defaultValue }),
    })
    sourceFields.add(sourceField)
  }

  for (const field of requiredTargetFields) {
    if (!result.has(field)) {
      throw new WorkItemTransferError(
        400,
        'MissingImportMapping',
        `Import mapping for "${field}" is required.`,
      )
    }
  }
  return result
}

function readImportTransform(value: WorkItemTransferTransform | undefined) {
  if (
    value === undefined ||
    value === 'none' ||
    value === 'trim' ||
    value === 'lowercase' ||
    value === 'uppercase' ||
    value === 'parse-date' ||
    value === 'parse-number' ||
    value === 'split-comma'
  ) return value ?? 'none'
  throw new WorkItemTransferError(
    400,
    'InvalidImportMapping',
    `Import mapping transform "${String(value)}" is invalid.`,
  )
}

function isSupportedTargetField(value: string) {
  return supportedTargetFields.has(value) || /^customFieldValues\.[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function mapImportRow(
  source: Record<string, unknown>,
  row: number,
  mapping: ReadonlyMap<string, WorkItemTransferMapping>,
): WorkItemTransferPreviewRow {
  const errors: WorkItemTransferRowError[] = []
  const values = new Map<string, unknown>()
  for (const entry of mapping.values()) {
    values.set(entry.targetField, resolveMappedValue(source, entry, row, errors))
  }
  const read = (targetField: string) => values.get(targetField)
  const title = readRequiredImportString(read('title'), row, 'title', errors)
  const assigneeUserId = readRequiredImportString(
    read('assigneeUserId'),
    row,
    'assigneeUserId',
    errors,
  )
  const schedule = readImportSchedule(read('schedule'), row, errors)
  const priority = readPriority(read('priority'), row, errors)
  const description = readOptionalImportString(read('description'), row, 'description', errors)
  const assignedProjectId = readOptionalImportString(
    read('assignedProjectId'),
    row,
    'assignedProjectId',
    errors,
  )
  const workflowStatusId = readOptionalImportString(
    read('workflowStatusId'),
    row,
    'workflowStatusId',
    errors,
  )
  const customFieldValues: Record<string, CustomFieldValue> = {}

  for (const [targetField] of mapping) {
    if (!targetField.startsWith('customFieldValues.')) continue
    const fieldId = targetField.slice('customFieldValues.'.length)
    const value = parseCustomFieldValue(read(targetField))
    if (value !== undefined) customFieldValues[fieldId] = value
  }

  if (errors.length > 0 || !title || !assigneeUserId || !schedule || !priority) {
    return { row, errors }
  }

  return {
    row,
    errors,
    input: {
      title,
      assigneeUserId,
      schedule,
      priority,
      ...(description ? { description } : {}),
      ...(assignedProjectId ? { assignedProjectId } : {}),
      ...(workflowStatusId ? { workflowStatusId } : {}),
      ...(Object.keys(customFieldValues).length > 0 ? { customFieldValues } : {}),
    },
  }
}

function resolveMappedValue(
  source: Record<string, unknown>,
  mapping: WorkItemTransferMapping,
  row: number,
  errors: WorkItemTransferRowError[],
) {
  const sourceValue = readSourceValue(source, mapping.sourceField)
  const value = isEmptyImportValue(sourceValue)
    ? mapping.defaultValue
    : sourceValue
  if (isEmptyImportValue(value)) {
    if (mapping.required) {
      errors.push({
        row,
        field: mapping.targetField,
        code: 'RequiredFieldMissing',
        message: `${mapping.targetField} is required.`,
      })
    }
    return undefined
  }
  try {
    return transformImportValue(value, mapping.transform ?? 'none')
  } catch {
    errors.push({
      row,
      field: mapping.targetField,
      code: 'InvalidFieldTransform',
      message: `${mapping.targetField} could not be transformed with ${mapping.transform}.`,
    })
    return undefined
  }
}

function readSourceValue(source: Record<string, unknown>, sourceField: string) {
  if (Object.hasOwn(source, sourceField)) return source[sourceField]
  return sourceField.split('.').reduce<unknown>((value, segment) => (
    isRecord(value) && Object.hasOwn(value, segment) ? value[segment] : undefined
  ), source)
}

function isEmptyImportValue(value: unknown) {
  return value === undefined || value === null || value === ''
}

function transformImportValue(value: unknown, transform: WorkItemTransferTransform) {
  if (transform === 'none') return value
  if (transform === 'parse-number') {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value !== 'string' || !value.trim()) throw new TypeError('Not a number.')
    const parsed = Number(value.trim())
    if (!Number.isFinite(parsed)) throw new TypeError('Not a number.')
    return parsed
  }
  if (transform === 'parse-date') {
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new TypeError('Not a date.')
    }
    const text = String(value).trim()
    const timestamp = Date.parse(text)
    if (!text || Number.isNaN(timestamp)) throw new TypeError('Not a date.')
    return /^\d{4}-\d{2}-\d{2}$/u.test(text)
      ? text
      : new Date(timestamp).toISOString().slice(0, 10)
  }
  if (transform === 'split-comma') {
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      return value.map((entry) => entry.trim()).filter(Boolean)
    }
    if (typeof value !== 'string') throw new TypeError('Not comma-separated text.')
    return value.split(',').map((entry) => entry.trim()).filter(Boolean)
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new TypeError('Not text.')
  }
  const text = String(value)
  if (transform === 'trim') return text.trim()
  if (transform === 'lowercase') return text.trim().toLocaleLowerCase('und')
  return text.trim().toLocaleUpperCase('und')
}

function readRequiredImportString(
  value: unknown,
  row: number,
  field: string,
  errors: WorkItemTransferRowError[],
) {
  const result = typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : ''
  if (
    !result &&
    !errors.some((error) => error.field === field)
  ) {
    errors.push({ row, field, code: 'RequiredFieldMissing', message: `${field} is required.` })
  }
  return result || undefined
}

function readOptionalImportString(
  value: unknown,
  row: number,
  field: string,
  errors: WorkItemTransferRowError[],
) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' && typeof value !== 'number') {
    errors.push({ row, field, code: 'InvalidFieldType', message: `${field} must be text.` })
    return undefined
  }
  return String(value).trim() || undefined
}

/**
 * Reads and canonicalizes a complete schedule from a JSON import value.
 *
 * CSV cells carry the schedule as JSON text, while JSON imports may provide the object directly.
 *
 * @param value - Imported schedule object or JSON text.
 * @param row - One-based data row number.
 * @param errors - Mutable row error collection.
 * @returns A canonical schedule, or undefined after recording an error.
 */
function readImportSchedule(
  value: unknown,
  row: number,
  errors: WorkItemTransferRowError[],
): WorkItemSchedule | undefined {
  if (isEmptyImportValue(value)) {
    if (!errors.some((error) => error.field === 'schedule')) {
      errors.push({
        row,
        field: 'schedule',
        code: 'RequiredFieldMissing',
        message: 'schedule is required.',
      })
    }
    return undefined
  }

  let candidate: unknown = value
  if (typeof value === 'string') {
    try {
      candidate = JSON.parse(value)
    } catch {
      candidate = undefined
    }
  }

  try {
    return normalizeWorkItemSchedule(candidate)
  } catch (error) {
    const message = error instanceof WorkItemScheduleError
      ? error.message
      : 'schedule must be a canonical Work Item schedule.'
    errors.push({
      row,
      field: 'schedule',
      code: 'InvalidSchedule',
      message,
    })
    return undefined
  }
}

function readPriority(
  value: unknown,
  row: number,
  errors: WorkItemTransferRowError[],
): WorkItemPriority | undefined {
  if (value === undefined || value === null || value === '') return 'medium'
  if (value === 'high' || value === 'medium' || value === 'low') return value
  errors.push({
    row,
    field: 'priority',
    code: 'InvalidPriority',
    message: 'priority must be high, medium, or low.',
  })
  return undefined
}

function parseCustomFieldValue(value: unknown): CustomFieldValue | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'boolean' || typeof value === 'number') return value
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value
  const text = String(value).trim()
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return Number(text)
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) return parsed
    } catch {
      return text
    }
  }
  return text
}

function parseJsonObjects(data: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(data.replace(/^\ufeff/, ''))
  } catch {
    throw new WorkItemTransferError(400, 'InvalidImportJson', 'Import JSON is invalid.')
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.workItems)
    ? parsed.workItems
    : undefined
  if (!rows || !rows.every(isRecord)) {
    throw new WorkItemTransferError(
      400,
      'InvalidImportJsonShape',
      'Import JSON must be an array or an object with a workItems array.',
    )
  }
  return rows
}

function parseCsvObjects(data: string) {
  const rows = parseCsvRows(data.replace(/^\ufeff/, ''))
  const headers = rows.shift()?.map((header) => header.trim()) ?? []
  if (headers.length === 0 || headers.some((header) => !header)) {
    throw new WorkItemTransferError(400, 'InvalidImportCsvHeader', 'CSV header is required.')
  }
  if (new Set(headers).size !== headers.length) {
    throw new WorkItemTransferError(400, 'DuplicateImportCsvHeader', 'CSV headers must be unique.')
  }
  return rows
    .filter((row) => row.some((value) => value.trim()))
    .map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])))
}

function parseCsvRows(data: string) {
  const rows: string[][] = []
  let row: string[] = []
  let value = ''
  let quoted = false
  for (let index = 0; index < data.length; index += 1) {
    const character = data[index]
    if (quoted) {
      if (character === '"' && data[index + 1] === '"') {
        value += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
      } else {
        value += character
      }
      continue
    }
    if (character === '"' && value.length === 0) quoted = true
    else if (character === ',') {
      row.push(value)
      value = ''
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && data[index + 1] === '\n') index += 1
      row.push(value)
      rows.push(row)
      row = []
      value = ''
    } else value += character
  }
  if (quoted) throw new WorkItemTransferError(400, 'InvalidImportCsv', 'CSV quote is not closed.')
  if (value || row.length > 0) {
    row.push(value)
    rows.push(row)
  }
  return rows
}

function serializeCell(value: unknown) {
  if (value === undefined || value === null) return ''
  if (Array.isArray(value) || isRecord(value)) return JSON.stringify(value)
  return String(value)
}

function escapeCsvValue(value: string) {
  const safeValue = /^[\t\r\n ]*[=+\-@]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safeValue) ? `"${safeValue.replaceAll('"', '""')}"` : safeValue
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
