import {
  WORK_ITEM_ACCEPTANCE_CRITERIA_LIMIT,
  WORK_ITEM_ACCEPTANCE_CRITERION_TEXT_MAX_LENGTH,
  type WorkItemAcceptanceCriterion,
} from '@mukuroji/contracts'

/** Fields of one acceptance criterion on input. */
const INPUT_FIELDS = new Set(['id', 'text', 'satisfied'])

/** Shape of server-generated criterion identifiers. */
const CRITERION_ID_PATTERN = /^[0-9a-f]{32}$/u

/**
 * Rejected acceptance criteria input.
 */
export class WorkItemAcceptanceCriteriaError extends Error {
  /** Stable machine-readable error code. */
  readonly code = 'InvalidAcceptanceCriteria'

  /**
   * Creates the error with a client-facing message.
   *
   * @param message - Explanation of the rejected input.
   */
  constructor(message: string) {
    super(message)
    this.name = 'WorkItemAcceptanceCriteriaError'
  }
}

/** Context needed to validate a replacement acceptance criteria list. */
export type AcceptanceCriteriaNormalizationContext = {
  /** Criteria currently stored on the Work Item; empty for a new Work Item. */
  readonly existing: readonly WorkItemAcceptanceCriterion[]
  /** Creates an identifier for a new criterion. */
  readonly createCriterionId: () => string
}

/**
 * Validates and normalizes a complete replacement list of acceptance criteria.
 *
 * Existing criteria are matched by `id`, so clients cannot invent identifiers; an entry without an
 * ID is a new criterion and receives a new one.
 *
 * @param value - Untrusted `acceptanceCriteria` request value.
 * @param context - Current criteria and the identifier factory.
 * @returns Normalized criteria in request order.
 * @throws WorkItemAcceptanceCriteriaError when the list is invalid.
 */
export function normalizeAcceptanceCriteria(
  value: unknown,
  context: AcceptanceCriteriaNormalizationContext,
): WorkItemAcceptanceCriterion[] {
  if (!Array.isArray(value)) {
    throw new WorkItemAcceptanceCriteriaError('Acceptance criteria must be an array.')
  }
  if (value.length > WORK_ITEM_ACCEPTANCE_CRITERIA_LIMIT) {
    throw new WorkItemAcceptanceCriteriaError(
      `A Work Item can have at most ${WORK_ITEM_ACCEPTANCE_CRITERIA_LIMIT} acceptance criteria.`,
    )
  }
  const existingIds = new Set(context.existing.map((criterion) => criterion.id))
  const seen = new Set<string>()
  return value.map((candidate): WorkItemAcceptanceCriterion => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new WorkItemAcceptanceCriteriaError('Each acceptance criterion must be an object.')
    }
    const unknownField = Object.keys(candidate).find((key) => !INPUT_FIELDS.has(key))
    if (unknownField !== undefined) {
      throw new WorkItemAcceptanceCriteriaError(`Unsupported acceptance criterion field: ${unknownField}.`)
    }
    const requestedId: unknown = Reflect.get(candidate, 'id')
    if (requestedId !== undefined && (typeof requestedId !== 'string' || !existingIds.has(requestedId))) {
      throw new WorkItemAcceptanceCriteriaError('An acceptance criterion ID must name a criterion of this Work Item. Omit it for a new criterion.')
    }
    const id = typeof requestedId === 'string' ? requestedId : context.createCriterionId()
    if (seen.has(id)) {
      throw new WorkItemAcceptanceCriteriaError('Each acceptance criterion can appear only once.')
    }
    seen.add(id)
    const satisfied: unknown = Reflect.get(candidate, 'satisfied')
    if (satisfied !== undefined && typeof satisfied !== 'boolean') {
      throw new WorkItemAcceptanceCriteriaError('An acceptance criterion `satisfied` must be a boolean.')
    }
    return { id, text: readCriterionText(Reflect.get(candidate, 'text')), satisfied: satisfied === true }
  })
}

/**
 * Checks that a replacement list only changes whether existing criteria are met: the same
 * criteria, in the same order, with the same text.
 *
 * @param next - Normalized replacement criteria.
 * @param existing - Criteria stored before the change.
 * @returns Whether only `satisfied` values differ.
 */
export function changesOnlyCriterionSatisfaction(
  next: readonly WorkItemAcceptanceCriterion[],
  existing: readonly WorkItemAcceptanceCriterion[],
): boolean {
  return next.length === existing.length &&
    next.every((criterion, index) => criterion.id === existing[index]?.id && criterion.text === existing[index]?.text)
}

/**
 * Checks whether a stored value is a valid, non-empty acceptance criteria list.
 *
 * @param value - Stored attribute value.
 * @returns Whether the value is a well-formed list with unique IDs.
 */
export function isStoredAcceptanceCriterionList(value: unknown): value is WorkItemAcceptanceCriterion[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > WORK_ITEM_ACCEPTANCE_CRITERIA_LIMIT ||
    !value.every(isStoredAcceptanceCriterion)
  ) {
    return false
  }
  return new Set(value.map((criterion) => criterion.id)).size === value.length
}

/**
 * Checks one stored acceptance criterion.
 *
 * @param value - Stored list entry.
 * @returns Whether the entry is well formed.
 */
function isStoredAcceptanceCriterion(value: unknown): value is WorkItemAcceptanceCriterion {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (Object.keys(value).some((key) => !INPUT_FIELDS.has(key))) return false
  const id: unknown = Reflect.get(value, 'id')
  const text: unknown = Reflect.get(value, 'text')
  const satisfied: unknown = Reflect.get(value, 'satisfied')
  return typeof id === 'string' &&
    CRITERION_ID_PATTERN.test(id) &&
    isCriterionText(text) &&
    typeof satisfied === 'boolean'
}

/**
 * Reads the text of one criterion.
 *
 * @param value - Untrusted text.
 * @returns Trimmed text.
 * @throws WorkItemAcceptanceCriteriaError when the text is missing or too long.
 */
function readCriterionText(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : undefined
  if (text === undefined || !isCriterionText(text)) {
    throw new WorkItemAcceptanceCriteriaError(
      `An acceptance criterion needs text of 1 to ${WORK_ITEM_ACCEPTANCE_CRITERION_TEXT_MAX_LENGTH} characters.`,
    )
  }
  return text
}

/**
 * Checks the text of one criterion.
 *
 * @param value - Candidate text.
 * @returns Whether it is non-blank, within the length limit, and trimmed.
 */
function isCriterionText(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= WORK_ITEM_ACCEPTANCE_CRITERION_TEXT_MAX_LENGTH &&
    value === value.trim()
}
