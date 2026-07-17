import type {
  RequestAnswerValue as ContractRequestAnswerValue,
  RequestLocalizedText as ContractRequestLocalizedText,
} from '@mukuroji/contracts'

/**
 * Request form の回答として browser が保持できる値です。
 */
export type RequestAnswerValue = ContractRequestAnswerValue

/**
 * Locale ごとの管理者入力文です。
 */
export type RequestLocalizedText = ContractRequestLocalizedText

/**
 * Conditional rule が利用できる比較演算子です。
 */
export type RequestConditionOperator =
  | 'equals'
  | 'not-equals'
  | 'contains'
  | 'is-empty'
  | 'is-not-empty'

/**
 * 一つの回答に対する表示条件です。
 */
export type RequestConditionRule = {
  /**
   * 判定対象 field ID です。
   */
  fieldId: string
  /**
   * 回答へ適用する比較演算子です。
   */
  operator: RequestConditionOperator
  /**
   * Empty 判定以外で比較する値です。
   */
  value?: RequestAnswerValue
}

/**
 * Section または field の表示条件です。
 */
export type RequestVisibilityCondition = {
  /**
   * すべての rule またはいずれかの rule を要求する結合方法です。
   */
  match: 'all' | 'any'
  /**
   * 回答へ適用する rule 一覧です。
   */
  rules: RequestConditionRule[]
}

/**
 * Request field の基本 validation rule です。
 */
export type RequestFieldValidation = {
  /**
   * 文字列または配列の最小長です。
   */
  minLength?: number
  /**
   * 文字列または配列の最大長です。
   */
  maxLength?: number
  /**
   * 数値の最小値です。
   */
  min?: number
  /**
   * 数値の最大値です。
   */
  max?: number
  /**
   * Text value に適用する regular expression source です。
   */
  pattern?: string
}

/**
 * Pure form logic が参照する field の最小構造です。
 */
export type RequestFormLogicField = {
  /**
   * Form version 内で一意な field ID です。
   */
  id: string
  /**
   * Browser control を選ぶ field type です。
   */
  type: string
  /**
   * 表示中に回答を必須とするかどうかです。
   */
  required?: boolean
  /**
   * Field 自体の表示条件です。
   */
  condition?: RequestVisibilityCondition
  /**
   * 型固有 validation です。
   */
  validation?: RequestFieldValidation
  /**
   * Select 系 field で許可する option ID です。
   */
  optionIds?: string[]
}

/**
 * Pure form logic が参照する section の最小構造です。
 */
export type RequestFormLogicSection = {
  /**
   * Form version 内で一意な section ID です。
   */
  id: string
  /**
   * Section 全体の表示条件です。
   */
  condition?: RequestVisibilityCondition
  /**
   * Section に含まれる field 一覧です。
   */
  fields: RequestFormLogicField[]
}

/**
 * Pure form logic が参照する immutable form version の最小構造です。
 */
export type RequestFormLogicVersion = {
  /**
   * Form の既定 locale です。
   */
  defaultLocale: string
  /**
   * Form が表示できる locale 一覧です。
   */
  locales: string[]
  /**
   * 表示順に並んだ section 一覧です。
   */
  sections: RequestFormLogicSection[]
}

/**
 * Field validation の機械判定用 code です。
 */
export type RequestFieldValidationCode =
  | 'required'
  | 'invalid-email'
  | 'invalid-number'
  | 'min'
  | 'max'
  | 'min-length'
  | 'max-length'
  | 'pattern'
  | 'invalid-option'

/**
 * 一つの visible field に対する validation error です。
 */
export type RequestFieldValidationError = {
  /**
   * Error 対象 field ID です。
   */
  fieldId: string
  /**
   * UI が文言へ変換する安定 code です。
   */
  code: RequestFieldValidationCode
}

/**
 * Attachment answer に実際に参照される claim token だけを submit 用に選びます。
 *
 * @param version - Attachment field を含む form version です。
 * @param answers - Submit する visible answer です。
 * @param claims - Upload 完了時に browser memory だけに保持した claim token です。
 * @returns Attachment ID ごとの claim token です。
 */
export function selectRequestAttachmentClaims(
  version: Pick<RequestFormLogicVersion, 'sections'>,
  answers: Record<string, RequestAnswerValue>,
  claims: ReadonlyMap<string, string>,
) {
  const selectedClaims: Record<string, string> = {}
  for (const field of version.sections.flatMap((section) => section.fields)) {
    if (field.type !== 'attachment') continue
    const value = answers[field.id]
    if (!Array.isArray(value)) continue
    for (const attachmentId of value) {
      const claimToken = claims.get(attachmentId)
      if (claimToken) selectedClaims[attachmentId] = claimToken
    }
  }
  return selectedClaims
}

/**
 * Attachment field ごとの upload 実行中状態を immutable に更新します。
 *
 * @param current - 現在 upload 中の field ID 一覧です。
 * @param fieldId - 状態を変更する attachment field ID です。
 * @param pending - Upload 開始時は true、完了時は false です。
 * @returns 指定 field の状態だけを反映した新しい Set です。
 */
export function updatePendingRequestAttachmentFields(
  current: ReadonlySet<string>,
  fieldId: string,
  pending: boolean,
) {
  const next = new Set(current)

  if (pending) {
    next.add(fieldId)
  } else {
    next.delete(fieldId)
  }

  return next
}

/**
 * 非同期 form response が現在表示中の public link request に属するか判定します。
 *
 * @param requestedLinkToken - Request 開始時の link token です。
 * @param requestedGeneration - Request 開始時の load generation です。
 * @param activeLinkToken - 現在 route が示す link token です。
 * @param activeGeneration - 現在有効な load generation です。
 * @returns Token と generation の両方が一致するとき true です。
 */
export function isCurrentPublicRequestFormRequest(
  requestedLinkToken: string,
  requestedGeneration: number,
  activeLinkToken: string,
  activeGeneration: number,
) {
  return requestedLinkToken === activeLinkToken && requestedGeneration === activeGeneration
}

/**
 * Form が表示に利用する locale を requested、default、先頭候補の順で解決します。
 *
 * @param version - Locale 設定を持つ form version です。
 * @param requestedLocale - URL または browser 設定から得た locale です。
 * @returns Form がサポートする locale code です。
 */
export function resolveRequestFormLocale(
  version: Pick<RequestFormLogicVersion, 'defaultLocale' | 'locales'>,
  requestedLocale: string | null | undefined,
) {
  const supportedLocales = Array.from(new Set([
    ...version.locales,
    version.defaultLocale,
  ].map(normalizeLocale).filter(Boolean)))
  const requested = normalizeLocale(requestedLocale)
  const exactMatch = supportedLocales.find((locale) => locale === requested)

  if (exactMatch) {
    return exactMatch
  }

  const languageMatch = requested
    ? supportedLocales.find((locale) => locale.split('-')[0] === requested.split('-')[0])
    : undefined

  return languageMatch ??
    supportedLocales.find((locale) => locale === normalizeLocale(version.defaultLocale)) ??
    supportedLocales[0] ??
    'ja'
}

/**
 * Locale map から requested locale、default locale、最初の非空値の順で表示文を返します。
 *
 * @param text - Locale ごとの管理者入力文です。
 * @param locale - 表示に使う locale です。
 * @param defaultLocale - Form version の既定 locale です。
 * @returns 解決した表示文です。
 */
export function resolveRequestLocalizedText(
  text: RequestLocalizedText | undefined,
  locale: string,
  defaultLocale: string,
) {
  if (!text) {
    return ''
  }

  const normalizedLocale = normalizeLocale(locale)
  const normalizedDefaultLocale = normalizeLocale(defaultLocale)
  const exactEntry = Object.entries(text).find(
    ([candidate]) => normalizeLocale(candidate) === normalizedLocale,
  )

  if (exactEntry?.[1]?.trim()) {
    return exactEntry[1]
  }

  const languageEntry = Object.entries(text).find(
    ([candidate, value]) =>
      value?.trim() &&
      normalizeLocale(candidate).split('-')[0] === normalizedLocale.split('-')[0],
  )

  if (languageEntry) {
    return languageEntry[1]
  }

  const defaultEntry = Object.entries(text).find(
    ([candidate]) => normalizeLocale(candidate) === normalizedDefaultLocale,
  )

  return defaultEntry?.[1]?.trim()
    ? defaultEntry[1]
    : Object.values(text).find((value) => value?.trim()) ?? ''
}

/**
 * 現在の回答が conditional rule set を満たすか判定します。
 *
 * @param condition - Section または field の conditional logic です。
 * @param answers - Field ID ごとの現在回答です。
 * @returns 条件が未設定または成立している場合は true です。
 */
export function matchesRequestVisibilityCondition(
  condition: RequestVisibilityCondition | undefined,
  answers: Readonly<Record<string, RequestAnswerValue>>,
) {
  if (!condition || condition.rules.length === 0) {
    return true
  }

  const results = condition.rules.map((rule) => matchesRule(rule, answers[rule.fieldId]))

  return condition.match === 'any' ? results.some(Boolean) : results.every(Boolean)
}

/**
 * 現在 visible な field ID を form order で返します。
 *
 * @param version - Section と field を持つ form version です。
 * @param answers - Conditional logic の判定に使う回答です。
 * @returns 表示対象 field ID 一覧です。
 */
export function getVisibleRequestFieldIds(
  version: Pick<RequestFormLogicVersion, 'sections'>,
  answers: Readonly<Record<string, RequestAnswerValue>>,
) {
  const visibleFieldIds: string[] = []
  const visibleAnswers: Record<string, RequestAnswerValue> = {}

  for (const section of version.sections) {
    if (!matchesRequestVisibilityCondition(section.condition, visibleAnswers)) {
      continue
    }

    for (const field of section.fields) {
      if (!matchesRequestVisibilityCondition(field.condition, visibleAnswers)) {
        continue
      }

      visibleFieldIds.push(field.id)
      const value = answers[field.id]
      if (value !== undefined && value !== '') {
        visibleAnswers[field.id] = value
      }
    }
  }

  return visibleFieldIds
}

/**
 * Hidden field の古い回答を除外して submission payload を作ります。
 *
 * @param version - 表示条件を持つ form version です。
 * @param answers - Browser が保持する全回答です。
 * @returns Visible field の回答だけを持つ新しい object です。
 */
export function filterVisibleRequestAnswers(
  version: Pick<RequestFormLogicVersion, 'sections'>,
  answers: Readonly<Record<string, RequestAnswerValue>>,
) {
  const visibleFieldIds = new Set(getVisibleRequestFieldIds(version, answers))

  return Object.fromEntries(
    Object.entries(answers).filter(([fieldId]) => visibleFieldIds.has(fieldId)),
  ) as Record<string, RequestAnswerValue>
}

/**
 * Visible field の required と基本的な型別 validation を評価します。
 *
 * @param version - Validation rule を持つ form version です。
 * @param answers - Field ID ごとの回答です。
 * @returns Form order で並んだ validation error 一覧です。
 */
export function validateVisibleRequestAnswers(
  version: Pick<RequestFormLogicVersion, 'sections'>,
  answers: Readonly<Record<string, RequestAnswerValue>>,
) {
  const visibleFieldIds = new Set(getVisibleRequestFieldIds(version, answers))

  return version.sections.flatMap((section) => section.fields.flatMap((field) => {
    if (!visibleFieldIds.has(field.id)) {
      return []
    }

    return validateRequestField(field, answers[field.id])
  }))
}

function validateRequestField(
  field: RequestFormLogicField,
  value: RequestAnswerValue | undefined,
): RequestFieldValidationError[] {
  const errors: RequestFieldValidationError[] = []
  const empty = isEmptyAnswer(value)

  if (field.required && empty) {
    return [{ fieldId: field.id, code: 'required' }]
  }

  if (empty) {
    return errors
  }

  if (field.type === 'email' && (
    typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  )) {
    errors.push({ fieldId: field.id, code: 'invalid-email' })
  }

  if (field.type === 'number') {
    const numericValue = typeof value === 'number' ? value : Number.NaN

    if (!Number.isFinite(numericValue)) {
      errors.push({ fieldId: field.id, code: 'invalid-number' })
    } else {
      if (field.validation?.min !== undefined && numericValue < field.validation.min) {
        errors.push({ fieldId: field.id, code: 'min' })
      }
      if (field.validation?.max !== undefined && numericValue > field.validation.max) {
        errors.push({ fieldId: field.id, code: 'max' })
      }
    }
  }

  const valueLength = typeof value === 'string' || Array.isArray(value) ? value.length : undefined
  if (
    valueLength !== undefined &&
    field.validation?.minLength !== undefined &&
    valueLength < field.validation.minLength
  ) {
    errors.push({ fieldId: field.id, code: 'min-length' })
  }
  if (
    valueLength !== undefined &&
    field.validation?.maxLength !== undefined &&
    valueLength > field.validation.maxLength
  ) {
    errors.push({ fieldId: field.id, code: 'max-length' })
  }

  if (
    typeof value === 'string' &&
    field.validation?.pattern &&
    !matchesPattern(field.validation.pattern, value)
  ) {
    errors.push({ fieldId: field.id, code: 'pattern' })
  }

  if (field.optionIds?.length && (
    typeof value === 'string'
      ? !field.optionIds.includes(value)
      : Array.isArray(value)
        ? value.some((optionId) => !field.optionIds?.includes(optionId))
        : true
  )) {
    errors.push({ fieldId: field.id, code: 'invalid-option' })
  }

  return errors
}

function matchesRule(rule: RequestConditionRule, answer: RequestAnswerValue | undefined) {
  switch (rule.operator) {
    case 'equals':
      return answersEqual(answer, rule.value)
    case 'not-equals':
      return !answersEqual(answer, rule.value)
    case 'contains':
      return containsAnswer(answer, rule.value)
    case 'is-empty':
      return isEmptyAnswer(answer)
    case 'is-not-empty':
      return !isEmptyAnswer(answer)
  }
}

function answersEqual(
  answer: RequestAnswerValue | undefined,
  expected: RequestAnswerValue | undefined,
) {
  return Array.isArray(answer)
    ? expected !== undefined && answer.includes(String(expected))
    : answer === expected
}

function containsAnswer(
  answer: RequestAnswerValue | undefined,
  expected: RequestAnswerValue | undefined,
) {
  if (typeof answer === 'string' && expected !== undefined) {
    return answer.includes(String(expected))
  }

  if (Array.isArray(answer)) {
    return expected !== undefined && answer.includes(String(expected))
  }

  return false
}

function isEmptyAnswer(value: RequestAnswerValue | undefined) {
  return value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
}

function matchesPattern(pattern: string, value: string) {
  try {
    return new RegExp(pattern, 'u').test(value)
  } catch {
    return false
  }
}

function normalizeLocale(value: string | null | undefined) {
  return value?.trim().replace(/_/g, '-').toLowerCase() ?? ''
}
