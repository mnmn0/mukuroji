import {
  DEFAULT_PROJECT_LIFECYCLE_STATE,
  PROJECT_CHARTER_CODE_MAX_LENGTH,
  PROJECT_CHARTER_CODE_PATTERN,
  PROJECT_CHARTER_REPOSITORY_URL_MAX_LENGTH,
  PROJECT_CHARTER_REPOSITORY_URLS_MAX_ITEMS,
  PROJECT_CHARTER_TAG_MAX_LENGTH,
  PROJECT_CHARTER_TAGS_MAX_ITEMS,
  PROJECT_CHARTER_TEXT_MAX_LENGTH,
  PROJECT_INITIAL_LIFECYCLE_STATES,
  canTransitionProjectLifecycle,
  isProjectLifecycleState,
  type ProjectCharter,
  type ProjectCharterPerson,
  type ProjectCharterSummary,
  type ProjectLifecycleState,
} from '@mukuroji/contracts'

/** Maximum length of a stored person display-name snapshot. */
const PERSON_DISPLAY_NAME_MAX_LENGTH = 320

/** Maximum length of a referenced member key. */
const MEMBER_KEY_MAX_LENGTH = 320

/** Validation failure with a stable code that adapters map to a client error. */
export type ProjectCharterValidationFailure = {
  /** Discriminator of a failed validation. */
  ok: false
  /** Stable application error code. */
  code: 'InvalidProjectCharter' | 'InvalidProjectLifecycleTransition'
  /** Safe diagnostic message. */
  message: string
}

/** Result of validating untrusted charter input. */
export type ProjectCharterValidationResult<T> =
  | {
      /** Discriminator of a successful validation. */
      ok: true
      /** Normalized value. */
      value: T
    }
  | ProjectCharterValidationFailure

/** Normalized charter replacement whose people are still unresolved member keys. */
export type ProjectCharterUpdate = {
  /** Revision read before constructing the update. */
  expectedRevision: number
  /** Normalized upper-case Project code. */
  code?: string
  /** Trimmed description. */
  description?: string
  /** Trimmed purpose. */
  purpose?: string
  /** Member key of the accountable Project manager. */
  ownerUserId?: string
  /** Member key of the sponsor. */
  sponsorUserId?: string
  /** Planned start date in `YYYY-MM-DD`. */
  plannedStartDate?: string
  /** Planned end date in `YYYY-MM-DD`. */
  plannedEndDate?: string
  /** De-duplicated classification tags. */
  tags: string[]
  /** De-duplicated HTTPS repository URLs. */
  repositoryUrls: string[]
}

/** Normalized lifecycle transition request. */
export type ProjectLifecycleTransition = {
  /** Revision read before constructing the transition. */
  expectedRevision: number
  /** Requested lifecycle state. */
  state: ProjectLifecycleState
}

/** Lifecycle-related fields stored on a Project directory row. */
export type StoredProjectLifecycleFields = {
  /** Stored lifecycle state, absent on legacy rows. */
  lifecycleState?: StoredProjectLifecycleState
  /** Archive timestamp, which always wins over the stored lifecycle state. */
  archivedAt?: string
}

/**
 * Resolves the effective lifecycle state of a stored Project row.
 *
 * The legacy `archivedAt` marker is the source of truth for `archived`, so archiving through the
 * existing archive operation and the lifecycle state never disagree.
 *
 * @param row - Stored lifecycle fields.
 * @returns The effective lifecycle state.
 */
export function resolveProjectLifecycleState(row: StoredProjectLifecycleFields): ProjectLifecycleState {
  if (row.archivedAt !== undefined) return 'archived'
  return row.lifecycleState ?? DEFAULT_PROJECT_LIFECYCLE_STATE
}

/** Lifecycle states stored on a Project row; `archived` is derived from `archivedAt`. */
export type StoredProjectLifecycleState = Exclude<ProjectLifecycleState, 'archived'>

/**
 * Validates the optional initial lifecycle state of a Project create request.
 *
 * @param value - Untrusted request value.
 * @returns The initial state, defaulting to `active`.
 */
export function readInitialProjectLifecycleState(
  value: unknown,
): ProjectCharterValidationResult<StoredProjectLifecycleState> {
  if (value === undefined || value === null) {
    return { ok: true, value: 'active' }
  }
  if (
    !isProjectLifecycleState(value) ||
    value === 'archived' ||
    !PROJECT_INITIAL_LIFECYCLE_STATES.includes(value)
  ) {
    return invalidCharter('A new Project can start only as proposed, approved, or active.')
  }
  return { ok: true, value }
}

/**
 * Normalizes a Project code to the stored upper-case form.
 *
 * @param value - Raw code text.
 * @returns The normalized code, or undefined when it is not a valid code.
 */
export function normalizeProjectCode(value: string): string | undefined {
  const code = value.trim().toUpperCase()
  if (
    code.length === 0 ||
    code.length > PROJECT_CHARTER_CODE_MAX_LENGTH ||
    !PROJECT_CHARTER_CODE_PATTERN.test(code)
  ) {
    return undefined
  }
  return code
}

/**
 * Validates an untrusted complete charter replacement request.
 *
 * Blank optional text fields are treated as cleared values.
 *
 * @param value - Untrusted request body.
 * @returns The normalized update or a validation failure.
 */
export function readProjectCharterUpdate(
  value: unknown,
): ProjectCharterValidationResult<ProjectCharterUpdate> {
  if (!isRecord(value)) return invalidCharter('Project charter body is required.')
  const expectedRevision = readRevision(value.expectedRevision)
  if (expectedRevision === undefined) {
    return invalidCharter('expectedRevision must be a non-negative integer.')
  }
  if (!isRecord(value.charter)) return invalidCharter('charter is required.')
  const charter = value.charter

  const rawCode = readOptionalText(charter.code)
  if (rawCode === null) return invalidCharter('code must be a string.')
  let code: string | undefined
  if (rawCode !== undefined) {
    code = normalizeProjectCode(rawCode)
    if (code === undefined) {
      return invalidCharter(
        `code must be 1-${PROJECT_CHARTER_CODE_MAX_LENGTH} letters, digits, "-" or "_", starting with a letter or digit.`,
      )
    }
  }

  const description = readOptionalText(charter.description)
  const purpose = readOptionalText(charter.purpose)
  if (description === null || purpose === null) {
    return invalidCharter('description and purpose must be strings.')
  }
  if (
    (description?.length ?? 0) > PROJECT_CHARTER_TEXT_MAX_LENGTH ||
    (purpose?.length ?? 0) > PROJECT_CHARTER_TEXT_MAX_LENGTH
  ) {
    return invalidCharter(
      `description and purpose must be at most ${PROJECT_CHARTER_TEXT_MAX_LENGTH} characters.`,
    )
  }

  const ownerUserId = readOptionalText(charter.ownerUserId)
  const sponsorUserId = readOptionalText(charter.sponsorUserId)
  if (
    ownerUserId === null ||
    sponsorUserId === null ||
    (ownerUserId?.length ?? 0) > MEMBER_KEY_MAX_LENGTH ||
    (sponsorUserId?.length ?? 0) > MEMBER_KEY_MAX_LENGTH
  ) {
    return invalidCharter('ownerUserId and sponsorUserId must be member keys.')
  }

  const plannedStartDate = readOptionalText(charter.plannedStartDate)
  const plannedEndDate = readOptionalText(charter.plannedEndDate)
  if (
    plannedStartDate === null ||
    plannedEndDate === null ||
    (plannedStartDate !== undefined && !isCalendarDate(plannedStartDate)) ||
    (plannedEndDate !== undefined && !isCalendarDate(plannedEndDate))
  ) {
    return invalidCharter('Planned dates must be valid YYYY-MM-DD dates.')
  }
  if (plannedStartDate !== undefined && plannedEndDate !== undefined && plannedEndDate < plannedStartDate) {
    return invalidCharter('plannedEndDate must not be before plannedStartDate.')
  }

  const tags = readTags(charter.tags)
  if (tags === undefined) {
    return invalidCharter(
      `tags must be at most ${PROJECT_CHARTER_TAGS_MAX_ITEMS} strings of at most ${PROJECT_CHARTER_TAG_MAX_LENGTH} characters.`,
    )
  }
  const repositoryUrls = readRepositoryUrls(charter.repositoryUrls)
  if (repositoryUrls === undefined) {
    return invalidCharter(
      `repositoryUrls must be at most ${PROJECT_CHARTER_REPOSITORY_URLS_MAX_ITEMS} HTTPS URLs without credentials.`,
    )
  }

  return {
    ok: true,
    value: {
      expectedRevision,
      ...(code === undefined ? {} : { code }),
      ...(description === undefined ? {} : { description }),
      ...(purpose === undefined ? {} : { purpose }),
      ...(ownerUserId === undefined ? {} : { ownerUserId }),
      ...(sponsorUserId === undefined ? {} : { sponsorUserId }),
      ...(plannedStartDate === undefined ? {} : { plannedStartDate }),
      ...(plannedEndDate === undefined ? {} : { plannedEndDate }),
      tags,
      repositoryUrls,
    },
  }
}

/**
 * Validates an untrusted lifecycle transition request.
 *
 * @param value - Untrusted request body.
 * @returns The normalized transition or a validation failure.
 */
export function readProjectLifecycleTransition(
  value: unknown,
): ProjectCharterValidationResult<ProjectLifecycleTransition> {
  if (!isRecord(value)) {
    return invalidTransition('Project lifecycle body is required.')
  }
  const expectedRevision = readRevision(value.expectedRevision)
  if (expectedRevision === undefined) {
    return invalidTransition('expectedRevision must be a non-negative integer.')
  }
  if (!isProjectLifecycleState(value.state)) {
    return invalidTransition('state must be a Project lifecycle state.')
  }
  return { ok: true, value: { expectedRevision, state: value.state } }
}

/** Decision on one requested lifecycle transition. */
export type ProjectLifecycleTransitionDecision =
  | {
      /** Discriminator of an allowed transition. */
      ok: true
      /** Lifecycle state the Project leaves. */
      from: ProjectLifecycleState
      /** Stored lifecycle state the Project enters. */
      to: StoredProjectLifecycleState
    }
  | {
      /** Discriminator of a rejected transition. */
      ok: false
      /** Stable application error code. */
      code: 'ProjectCharterRevisionConflict' | 'ProjectLifecycleTransitionNotAllowed'
      /** Safe diagnostic message. */
      message: string
    }

/**
 * Decides whether a Project at its current state and revision may move to the requested state.
 *
 * `archived` is never a target here: it is reached only through the archive operation. The
 * persistence layer still guards the write with the same revision, so a concurrent change that
 * commits after this decision fails as a revision conflict.
 *
 * @param current - Strongly read lifecycle state and charter revision.
 * @param transition - Requested transition with the revision the client read.
 * @returns The allowed transition or the rejection.
 */
export function decideProjectLifecycleTransition(
  current: {
    /** Current lifecycle state. */
    lifecycleState: ProjectLifecycleState
    /** Current charter revision. */
    revision: number
  },
  transition: ProjectLifecycleTransition,
): ProjectLifecycleTransitionDecision {
  if (current.revision !== transition.expectedRevision) {
    return {
      ok: false,
      code: 'ProjectCharterRevisionConflict',
      message: 'The Project charter changed. Reload and try again.',
    }
  }
  const from = current.lifecycleState
  const to = transition.state
  if (to === 'archived' || !canTransitionProjectLifecycle(from, to)) {
    return {
      ok: false,
      code: 'ProjectLifecycleTransitionNotAllowed',
      message: `A Project cannot move from "${from}" to "${to}".`,
    }
  }
  return { ok: true, from, to }
}

/**
 * Builds the stored charter from a normalized update and resolved people.
 *
 * @param update - Normalized update.
 * @param people - Display snapshots of the referenced owner and sponsor.
 * @returns The charter to persist.
 */
export function createProjectCharter(
  update: ProjectCharterUpdate,
  people: {
    /** Resolved owner, required when the update names one. */
    owner?: ProjectCharterPerson
    /** Resolved sponsor, required when the update names one. */
    sponsor?: ProjectCharterPerson
  },
): ProjectCharter {
  return {
    ...(update.code === undefined ? {} : { code: update.code }),
    ...(update.description === undefined ? {} : { description: update.description }),
    ...(update.purpose === undefined ? {} : { purpose: update.purpose }),
    ...(people.owner === undefined ? {} : { owner: { ...people.owner } }),
    ...(people.sponsor === undefined ? {} : { sponsor: { ...people.sponsor } }),
    ...(update.plannedStartDate === undefined ? {} : { plannedStartDate: update.plannedStartDate }),
    ...(update.plannedEndDate === undefined ? {} : { plannedEndDate: update.plannedEndDate }),
    tags: [...update.tags],
    repositoryUrls: [...update.repositoryUrls],
  }
}

/**
 * Returns an empty charter used by Projects that have never saved one.
 *
 * @returns A charter without optional fields.
 */
export function createEmptyProjectCharter(): ProjectCharter {
  return { tags: [], repositoryUrls: [] }
}

/**
 * Picks the directory summary fields of a charter.
 *
 * @param charter - Stored charter.
 * @returns The summary, or undefined when no summary field is set.
 */
export function toProjectCharterSummary(charter: ProjectCharter | undefined): ProjectCharterSummary | undefined {
  if (!charter) return undefined
  const summary: ProjectCharterSummary = {
    ...(charter.code === undefined ? {} : { code: charter.code }),
    ...(charter.owner === undefined ? {} : { owner: { ...charter.owner } }),
    ...(charter.plannedStartDate === undefined ? {} : { plannedStartDate: charter.plannedStartDate }),
    ...(charter.plannedEndDate === undefined ? {} : { plannedEndDate: charter.plannedEndDate }),
  }
  return Object.keys(summary).length === 0 ? undefined : summary
}

/**
 * Checks whether a persisted value is a valid stored charter. Unknown shapes fail closed.
 *
 * @param value - Persisted DynamoDB value.
 * @returns Whether the value can be returned as a charter.
 */
export function isStoredProjectCharter(value: unknown): value is ProjectCharter {
  if (!isRecord(value)) return false
  const optionalStrings = ['code', 'description', 'purpose', 'plannedStartDate', 'plannedEndDate'] as const
  if (optionalStrings.some((key) => value[key] !== undefined && typeof value[key] !== 'string')) {
    return false
  }
  if (typeof value.code === 'string' && normalizeProjectCode(value.code) !== value.code) return false
  return (
    (value.owner === undefined || isStoredProjectCharterPerson(value.owner)) &&
    (value.sponsor === undefined || isStoredProjectCharterPerson(value.sponsor)) &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === 'string') &&
    Array.isArray(value.repositoryUrls) &&
    value.repositoryUrls.every((url) => typeof url === 'string')
  )
}

/**
 * Lists the charter fields whose values differ, for audit change records.
 *
 * @param before - Charter before the change.
 * @param after - Charter after the change.
 * @returns Names of changed fields in a stable order.
 */
export function listChangedProjectCharterFields(before: ProjectCharter, after: ProjectCharter): string[] {
  const fields: Array<keyof ProjectCharter> = [
    'code',
    'description',
    'purpose',
    'owner',
    'sponsor',
    'plannedStartDate',
    'plannedEndDate',
    'tags',
    'repositoryUrls',
  ]
  return fields.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
}

/** Checks a persisted person snapshot. */
function isStoredProjectCharterPerson(value: unknown): value is ProjectCharterPerson {
  return isRecord(value) &&
    typeof value.userId === 'string' &&
    value.userId.length > 0 &&
    typeof value.displayName === 'string'
}

/**
 * Builds a display snapshot for a charter person.
 *
 * @param userId - Member key.
 * @param name - Optional profile name.
 * @param email - Optional profile email.
 * @returns A bounded display snapshot.
 */
export function createProjectCharterPerson(
  userId: string,
  name: string | undefined,
  email: string | undefined,
): ProjectCharterPerson {
  const displayName = (name?.trim() || email?.trim() || userId).slice(0, PERSON_DISPLAY_NAME_MAX_LENGTH)
  return { userId, displayName }
}

/**
 * Reads an optional trimmed text value.
 *
 * @param value - Untrusted value.
 * @returns The trimmed text, undefined for blank or absent values, or null for wrong types.
 */
function readOptionalText(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text.length === 0 ? undefined : text
}

/** Reads a non-negative safe integer revision. */
function readRevision(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Checks a real calendar date in `YYYY-MM-DD` form.
 *
 * @param value - Candidate date text.
 * @returns Whether the date exists.
 */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/**
 * Reads de-duplicated trimmed tags.
 *
 * @param value - Untrusted tag list.
 * @returns The tags, or undefined when invalid.
 */
function readTags(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return undefined
  const tags: string[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (typeof candidate !== 'string') return undefined
    const tag = candidate.trim()
    if (tag.length === 0) continue
    if (tag.length > PROJECT_CHARTER_TAG_MAX_LENGTH) return undefined
    const key = tag.toLocaleLowerCase('en-US')
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
  }
  return tags.length > PROJECT_CHARTER_TAGS_MAX_ITEMS ? undefined : tags
}

/**
 * Reads de-duplicated HTTPS repository URLs without credentials.
 *
 * @param value - Untrusted URL list.
 * @returns The URLs, or undefined when invalid.
 */
function readRepositoryUrls(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return undefined
  const urls: string[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'string') return undefined
    const text = candidate.trim()
    if (text.length === 0) continue
    if (text.length > PROJECT_CHARTER_REPOSITORY_URL_MAX_LENGTH) return undefined
    let url: URL
    try {
      url = new URL(text)
    } catch {
      return undefined
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hostname === '') {
      return undefined
    }
    const normalized = url.toString()
    if (!urls.includes(normalized)) urls.push(normalized)
  }
  return urls.length > PROJECT_CHARTER_REPOSITORY_URLS_MAX_ITEMS ? undefined : urls
}

/** Creates a charter validation failure. */
function invalidCharter(message: string): ProjectCharterValidationFailure {
  return { ok: false, code: 'InvalidProjectCharter', message }
}

/** Creates a lifecycle validation failure. */
function invalidTransition(message: string): ProjectCharterValidationFailure {
  return { ok: false, code: 'InvalidProjectLifecycleTransition', message }
}

/** Checks a plain object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
