import type {
  CustomFieldDefinition,
  CustomFieldDurationUnit,
  CustomFieldValue,
} from '@mukuroji/contracts'

/**
 * Custom field input の `name` 属性に付ける接頭辞です。
 */
export const CUSTOM_FIELD_FORM_NAME_PREFIX = 'custom-field:'

/**
 * Client validation が返す安定 error code です。
 */
export type CustomFieldValidationCode =
  | 'required'
  | 'invalid-type'
  | 'invalid-option'
  | 'invalid-date'
  | 'min'
  | 'max'
  | 'min-length'
  | 'max-length'
  | 'pattern'

/**
 * Custom field 一件の client validation error です。
 */
export type CustomFieldValidationError = {
  /**
   * Error の対象 field ID です。
   */
  fieldId: string
  /**
   * 表示文言へ変換できる安定 error code です。
   */
  code: CustomFieldValidationCode
}

/**
 * FormData から custom field value を読み取る条件です。
 */
export type ParseCustomFieldFormDataOptions = {
  /**
   * Project scope の適用可否を判定する Project ID です。
   */
  projectId?: string
  /**
   * 未入力 field に definition の default value を補完するかどうかです。
   */
  applyDefaults?: boolean
}

/**
 * FormData の parse と client validation の結果です。
 */
export type ParsedCustomFieldValues = {
  /**
   * Formula を除く保存可能な typed value です。
   */
  values: Record<string, CustomFieldValue>
  /**
   * 保存前に解消すべき validation error です。
   */
  errors: CustomFieldValidationError[]
}

/**
 * Custom field value の表示形式を調整する入力です。
 */
export type FormatCustomFieldValueOptions = {
  /**
   * Currency の `Intl.NumberFormat` に渡す locale です。
   */
  locale?: string
  /**
   * Boolean true の表示文言です。
   */
  trueLabel?: string
  /**
   * Boolean false の表示文言です。
   */
  falseLabel?: string
  /**
   * Duration の保存単位を表示 locale の label へ変換する map です。
   */
  durationUnitLabels?: Partial<Record<CustomFieldDurationUnit, string>>
  /**
   * Person ID から表示名を解決する map です。
   */
  personLabels?: Readonly<Record<string, string>>
  /**
   * 値が無い場合の表示文言です。
   */
  emptyLabel?: string
}

/**
 * Custom field ID から衝突しない FormData field name を生成します。
 *
 * @param fieldId - Custom field definition ID です。
 * @returns URL encode 済み field ID を含む form name です。
 */
export function createCustomFieldFormName(fieldId: string) {
  return `${CUSTOM_FIELD_FORM_NAME_PREFIX}${encodeURIComponent(fieldId)}`
}

/**
 * FormData field name から custom field ID を復元します。
 *
 * @param name - Form control の name です。
 * @returns Custom field ID、または custom field control でない場合は undefined です。
 */
export function readCustomFieldIdFromFormName(name: string) {
  if (!name.startsWith(CUSTOM_FIELD_FORM_NAME_PREFIX)) {
    return undefined
  }

  try {
    return decodeURIComponent(name.slice(CUSTOM_FIELD_FORM_NAME_PREFIX.length))
  } catch {
    return undefined
  }
}

/**
 * Definition が現在の Project または未割り当て Work Item に適用されるか判定します。
 *
 * @param definition - 判定対象 custom field definition です。
 * @param projectId - Work Item の遂行先 Project ID です。
 * @returns Field を表示・検証する場合は true です。
 */
export function isCustomFieldApplicable(
  definition: CustomFieldDefinition,
  projectId?: string,
) {
  if (!definition.projectIds || definition.projectIds.length === 0) {
    return true
  }

  return Boolean(projectId && definition.projectIds.includes(projectId))
}

/**
 * Applicable field の既定値を defensive copy して返します。
 *
 * @param definitions - 解決済み custom field definition 一覧です。
 * @param projectId - Work Item の遂行先 Project ID です。
 * @returns Field ID ごとの default value です。
 */
export function createDefaultCustomFieldValues(
  definitions: readonly CustomFieldDefinition[],
  projectId?: string,
) {
  const values: Record<string, CustomFieldValue> = {}

  for (const definition of sortCustomFieldDefinitions(definitions)) {
    if (
      definition.type === 'formula' ||
      definition.defaultValue === undefined ||
      !isCustomFieldApplicable(definition, projectId)
    ) {
      continue
    }

    values[definition.id] = cloneCustomFieldValue(definition.defaultValue)
  }

  return values
}

/**
 * FormData から全 applicable custom field を typed value として読み、client validation します。
 *
 * Server validation が最終 authority であり、この関数は入力時の即時 feedback 用です。
 *
 * @param formData - Custom field controls を含む FormData です。
 * @param definitions - 解決済み custom field definition 一覧です。
 * @param options - Project scope と default 補完条件です。
 * @returns Typed value と validation error です。
 */
export function parseCustomFieldFormData(
  formData: FormData,
  definitions: readonly CustomFieldDefinition[],
  options: ParseCustomFieldFormDataOptions = {},
): ParsedCustomFieldValues {
  const values = options.applyDefaults
    ? createDefaultCustomFieldValues(definitions, options.projectId)
    : {}
  const errors: CustomFieldValidationError[] = []

  for (const definition of sortCustomFieldDefinitions(definitions)) {
    if (!isCustomFieldApplicable(definition, options.projectId) || definition.type === 'formula') {
      continue
    }

    const value = parseCustomFieldValue(formData, definition)

    if (value === undefined) {
      if (definition.required && values[definition.id] === undefined) {
        errors.push({ fieldId: definition.id, code: 'required' })
      }
      continue
    }

    values[definition.id] = value
    errors.push(...validateCustomFieldValue(definition, value))
  }

  return { errors, values }
}

/**
 * Definition と value の組み合わせを client 側で検証します。
 *
 * @param definition - 検証ルールを持つ field definition です。
 * @param value - 検証対象 value です。
 * @returns 対象 field ID を含む validation error 一覧です。
 */
export function validateCustomFieldValue(
  definition: CustomFieldDefinition,
  value: CustomFieldValue | undefined,
) {
  const errors: CustomFieldValidationError[] = []
  const push = (code: CustomFieldValidationCode) => {
    if (!errors.some((error) => error.code === code)) {
      errors.push({ fieldId: definition.id, code })
    }
  }

  if (isEmptyCustomFieldValue(value)) {
    if (definition.required && definition.type !== 'formula') {
      push('required')
    }
    return errors
  }

  if (value === undefined) {
    return errors
  }

  if (!matchesCustomFieldType(definition, value)) {
    push('invalid-type')
    return errors
  }

  if (definition.type === 'date' && typeof value === 'string' && !isIsoDate(value)) {
    push('invalid-date')
  }

  if (
    (definition.type === 'select' || definition.type === 'multi-select') &&
    !containsOnlyConfiguredOptions(definition, value)
  ) {
    push('invalid-option')
  }

  const validation = definition.validation

  if (!validation) {
    return errors
  }

  if (typeof value === 'number') {
    if (validation.min !== undefined && value < validation.min) {
      push('min')
    }
    if (validation.max !== undefined && value > validation.max) {
      push('max')
    }
  }

  const valueLength = typeof value === 'string' || Array.isArray(value)
    ? value.length
    : undefined

  if (valueLength !== undefined) {
    if (validation.minLength !== undefined && valueLength < validation.minLength) {
      push('min-length')
    }
    if (validation.maxLength !== undefined && valueLength > validation.maxLength) {
      push('max-length')
    }
  }

  if (
    validation.pattern &&
    typeof value === 'string' &&
    definition.type === 'text' &&
    !matchesPattern(value, validation.pattern)
  ) {
    push('pattern')
  }

  return errors
}

/**
 * Custom field value が filter 入力と一致するか型に応じて判定します。
 *
 * @param definition - Filter 対象 field definition です。
 * @param value - Work Item に保存された value です。
 * @param filterValue - UI で指定された filter 値です。
 * @returns Filter を指定していない、または value が一致する場合は true です。
 */
export function matchesCustomFieldFilter(
  definition: CustomFieldDefinition,
  value: CustomFieldValue | undefined,
  filterValue: CustomFieldValue | undefined,
) {
  if (isEmptyCustomFieldValue(filterValue)) {
    return true
  }

  if (value === undefined) {
    return false
  }

  if (Array.isArray(filterValue)) {
    return Array.isArray(value) && filterValue.every((candidate) => value.includes(candidate))
  }

  if (definition.type === 'text' && typeof value === 'string' && typeof filterValue === 'string') {
    return value.toLocaleLowerCase().includes(filterValue.toLocaleLowerCase())
  }

  return value === filterValue
}

/**
 * Custom field value を list、board、report で使える短い表示文字列へ変換します。
 *
 * @param definition - Format 対象 field definition です。
 * @param value - Work Item に保存された value です。
 * @param options - Locale と表示ラベルです。
 * @returns 型と option 定義を反映した表示文字列です。
 */
export function formatCustomFieldValue(
  definition: CustomFieldDefinition,
  value: CustomFieldValue | undefined,
  options: FormatCustomFieldValueOptions = {},
) {
  if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
    return options.emptyLabel ?? '—'
  }

  if (definition.type === 'boolean' && typeof value === 'boolean') {
    return value ? options.trueLabel ?? 'True' : options.falseLabel ?? 'False'
  }

  if (definition.type === 'currency' && typeof value === 'number') {
    return formatCurrencyValue(value, definition.currencyCode, options.locale)
  }

  if (definition.type === 'duration' && typeof value === 'number') {
    const unit = definition.durationUnit ?? 'hours'

    return `${value} ${options.durationUnitLabels?.[unit] ?? unit}`
  }

  if (definition.type === 'person' && typeof value === 'string') {
    return options.personLabels?.[value] ?? value
  }

  if (definition.type === 'select' && typeof value === 'string') {
    return resolveOptionName(definition, value)
  }

  if (definition.type === 'multi-select' && Array.isArray(value)) {
    return value.map((optionId) => resolveOptionName(definition, optionId)).join(', ')
  }

  return String(value)
}

/**
 * Custom field definition を安定した表示順へ並べます。
 *
 * @param definitions - 並べ替える definition 一覧です。
 * @returns 元配列を変更しない sort 済み配列です。
 */
export function sortCustomFieldDefinitions(
  definitions: readonly CustomFieldDefinition[],
) {
  return [...definitions].sort(
    (first, second) => first.sortOrder - second.sortOrder || first.name.localeCompare(second.name),
  )
}

function parseCustomFieldValue(
  formData: FormData,
  definition: CustomFieldDefinition,
): CustomFieldValue | undefined {
  const formName = createCustomFieldFormName(definition.id)
  const rawValues = formData.getAll(formName)

  if (definition.type === 'boolean') {
    if (rawValues.length === 0) {
      return false
    }

    return String(rawValues.at(-1)) === 'true'
  }

  if (definition.type === 'multi-select') {
    const values = rawValues
      .map(String)
      .map((value) => value.trim())
      .filter(Boolean)

    return values.length > 0 ? [...new Set(values)] : undefined
  }

  const rawValue = rawValues.length > 0 ? String(rawValues.at(-1) ?? '').trim() : ''

  if (!rawValue) {
    return undefined
  }

  if (
    definition.type === 'number' ||
    definition.type === 'currency' ||
    definition.type === 'duration'
  ) {
    const value = Number(rawValue)

    return Number.isFinite(value) ? value : rawValue
  }

  return rawValue
}

function matchesCustomFieldType(
  definition: CustomFieldDefinition,
  value: CustomFieldValue,
) {
  if (
    definition.type === 'number' ||
    definition.type === 'currency' ||
    definition.type === 'duration'
  ) {
    return typeof value === 'number' && Number.isFinite(value)
  }

  if (definition.type === 'boolean') {
    return typeof value === 'boolean'
  }

  if (definition.type === 'multi-select') {
    return Array.isArray(value) && value.every((item) => typeof item === 'string')
  }

  return typeof value === 'string'
}

function isEmptyCustomFieldValue(value: CustomFieldValue | undefined) {
  return value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
}

function containsOnlyConfiguredOptions(
  definition: CustomFieldDefinition,
  value: CustomFieldValue,
) {
  const optionIds = new Set(definition.options?.map((option) => option.id) ?? [])
  const values = Array.isArray(value) ? value : [value]

  return values.every((candidate) => typeof candidate === 'string' && optionIds.has(candidate))
}

function resolveOptionName(definition: CustomFieldDefinition, optionId: string) {
  return definition.options?.find((option) => option.id === optionId)?.name ?? optionId
}

function isIsoDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)

  if (!match) {
    return false
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))

  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function matchesPattern(value: string, pattern: string) {
  try {
    return new RegExp(pattern, 'u').test(value)
  } catch {
    return false
  }
}

function formatCurrencyValue(value: number, currencyCode = 'USD', locale?: string) {
  try {
    return new Intl.NumberFormat(locale, {
      currency: currencyCode,
      style: 'currency',
    }).format(value)
  } catch {
    return `${currencyCode} ${value}`
  }
}

function cloneCustomFieldValue(value: CustomFieldValue): CustomFieldValue {
  return Array.isArray(value) ? [...value] : value
}
