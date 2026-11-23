/** Optional health update fields that a Workspace may make required. */
export type PlanningUpdateRequirableField =
  | 'riskSummary'
  | 'decisionSummary'
  | 'helpNeeded'
  | 'nextAction'
  | 'evidence'

/** Every field a Workspace may make required, in display order. */
export const PLANNING_UPDATE_REQUIRABLE_FIELDS: readonly PlanningUpdateRequirableField[] = [
  'riskSummary',
  'decisionSummary',
  'helpNeeded',
  'nextAction',
  'evidence',
]

/** Text fields of a health update that a Workspace template can prefill. */
export type PlanningUpdateTemplateTextField =
  | 'summary'
  | 'riskSummary'
  | 'decisionSummary'
  | 'helpNeeded'
  | 'nextAction'

/** Every text field a template can prefill, in display order. */
export const PLANNING_UPDATE_TEMPLATE_TEXT_FIELDS: readonly PlanningUpdateTemplateTextField[] = [
  'summary',
  'riskSummary',
  'decisionSummary',
  'helpNeeded',
  'nextAction',
]

/** Longest template text in characters; it stays within the 8,000-byte limit of update fields. */
export const MAX_PLANNING_UPDATE_TEMPLATE_TEXT_LENGTH = 2_000

/** Workspace rules for health updates: required fields and the text a new update starts from. */
export type PlanningUpdateTemplateSettings = {
  /** Optional fields that every published update must fill in, without duplicates. */
  requiredFields: PlanningUpdateRequirableField[]
  /** Starting text of each field in the publish form; a missing field starts empty. */
  template: Partial<Record<PlanningUpdateTemplateTextField, string>>
}

/** Settings of a Workspace that has not chosen any: nothing extra is required and forms start empty. */
export const DEFAULT_PLANNING_UPDATE_TEMPLATE_SETTINGS: PlanningUpdateTemplateSettings = {
  requiredFields: [],
  template: {},
}

/** Response of `GET /api/planning/updates/template`. */
export type PlanningUpdateTemplateResponse = {
  /** The Workspace's settings, or the defaults when none were saved. */
  settings: PlanningUpdateTemplateSettings
}

/** Health update content checked against the required fields. */
export type PlanningUpdateRequiredFieldInput = {
  /** Risk background and impact. */
  riskSummary: string
  /** Decisions of this update. */
  decisionSummary: string
  /** Help the update asks for. */
  helpNeeded: string
  /** Next action. */
  nextAction: string
  /** Evidence references; only the count matters. */
  evidence: readonly unknown[]
}

/**
 * Reports whether a value is a field a Workspace may make required.
 *
 * @param value - Untrusted value.
 * @returns True for a requirable field name.
 */
export function isPlanningUpdateRequirableField(value: unknown): value is PlanningUpdateRequirableField {
  return PLANNING_UPDATE_REQUIRABLE_FIELDS.some((field) => field === value)
}

/**
 * Validates Workspace health update template settings.
 *
 * Required fields are kept in display order without duplicates. Template text keeps its line
 * breaks; blank text is dropped so the form starts empty.
 *
 * @param value - Untrusted settings.
 * @returns The settings, or undefined when any field is invalid.
 */
export function readPlanningUpdateTemplateSettings(value: unknown): PlanningUpdateTemplateSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const requiredFields: unknown = Reflect.get(value, 'requiredFields')
  const template: unknown = Reflect.get(value, 'template')
  if (!Array.isArray(requiredFields) || requiredFields.length > PLANNING_UPDATE_REQUIRABLE_FIELDS.length) {
    return undefined
  }
  if (!requiredFields.every(isPlanningUpdateRequirableField)) return undefined
  if (typeof template !== 'object' || template === null || Array.isArray(template)) return undefined
  const texts: Partial<Record<PlanningUpdateTemplateTextField, string>> = {}
  for (const key of Object.keys(template)) {
    const field = PLANNING_UPDATE_TEMPLATE_TEXT_FIELDS.find((candidate) => candidate === key)
    const text: unknown = Reflect.get(template, key)
    if (!field || typeof text !== 'string' || text.length > MAX_PLANNING_UPDATE_TEMPLATE_TEXT_LENGTH) {
      return undefined
    }
    if (text.trim()) texts[field] = text
  }
  return {
    requiredFields: PLANNING_UPDATE_REQUIRABLE_FIELDS.filter((field) => requiredFields.includes(field)),
    template: texts,
  }
}

/**
 * Lists the required fields that an update leaves empty.
 *
 * @param settings - Workspace template settings.
 * @param input - Update content about to be published.
 * @returns Missing fields in display order; empty when the update may be published.
 */
export function listMissingPlanningUpdateFields(
  settings: PlanningUpdateTemplateSettings,
  input: PlanningUpdateRequiredFieldInput,
): PlanningUpdateRequirableField[] {
  return settings.requiredFields.filter((field) =>
    field === 'evidence' ? input.evidence.length === 0 : !input[field].trim()
  )
}
