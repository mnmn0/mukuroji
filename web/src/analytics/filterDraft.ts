import type { AnalyticsCustomFieldFilter } from '@mukuroji/contracts'

/**
 * Custom field filter operator が数値との比較を要求するか判定します。
 *
 * @param operator - 判定する比較演算子です。
 * @returns 数値draftを要求する場合は`true`です。
 */
export function analyticsCustomFieldOperatorUsesNumericValue(
  operator: AnalyticsCustomFieldFilter['operator'],
) {
  return operator === 'greater-than' ||
    operator === 'greater-than-or-equal' ||
    operator === 'less-than' ||
    operator === 'less-than-or-equal'
}

/**
 * Custom field filter editor の文字列draftをcontractのtyped valueへ変換します。
 *
 * @param value - Inputに表示しているdraft文字列です。
 * @param operator - Draftを適用する比較演算子です。
 * @param currentValue - 編集前のvalue typeを保持するための現在値です。
 * @returns 有効なtyped value、または数値・booleanとして不正な場合は`undefined`です。
 */
export function parseAnalyticsCustomFieldDraftValue(
  value: string,
  operator: AnalyticsCustomFieldFilter['operator'],
  currentValue?: AnalyticsCustomFieldFilter['value'],
): AnalyticsCustomFieldFilter['value'] {
  const normalized = value.trim()
  if (
    analyticsCustomFieldOperatorUsesNumericValue(operator) ||
    typeof currentValue === 'number'
  ) {
    if (!normalized) return undefined
    const numericValue = Number(normalized)
    return Number.isFinite(numericValue) ? numericValue : undefined
  }
  if (typeof currentValue === 'boolean') {
    if (normalized === 'true') return true
    if (normalized === 'false') return false
    return undefined
  }
  if (Array.isArray(currentValue)) {
    return splitAnalyticsCustomFieldDraftValues(value)
  }
  return value
}

/**
 * Multi-select filter のcheckbox操作を明示allowlistへ反映します。
 *
 * `undefined`は全件、空配列はmatch-noneを表すため、最後の選択解除でも空配列を
 * 維持します。
 *
 * @param selectedValues - 操作前の明示allowlistです。
 * @param value - 操作対象のdimension値です。
 * @param checked - 操作後のcheckbox状態です。
 * @returns 操作後の明示allowlistです。
 */
export function updateAnalyticsMultiSelectValues<T extends string>(
  selectedValues: readonly T[] | undefined,
  value: T,
  checked: boolean,
): T[] {
  const nextValues = new Set(selectedValues ?? [])
  if (checked) {
    nextValues.add(value)
  } else {
    nextValues.delete(value)
  }
  return [...nextValues]
}

function splitAnalyticsCustomFieldDraftValues(value: string) {
  return [...new Set(
    value.split(',').map((item) => item.trim()).filter(Boolean),
  )]
}
