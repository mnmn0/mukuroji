import type {
  WorkflowStatusCategory,
  WorkflowStatusDefinition,
  WorkItemConfiguration,
} from '@mukuroji/contracts'

const CONFIGURATION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i

/** Pure workflow-definition validation failure. */
export class WorkflowDefinitionValidationError extends Error {
  /** Stable machine-readable validation code. */
  readonly code = 'InvalidWorkItemConfiguration'
}

/**
 * Validates an untrusted Work Item workflow definition without persistence dependencies.
 *
 * @param value - Untrusted workflow definition.
 * @returns Normalized workflow definition.
 */
export function validateWorkflowDefinition(
  value: unknown,
): WorkItemConfiguration['workflow'] {
  if (!isRecord(value)) {
    throw invalidWorkflow('Workflow must be an object.')
  }
  const id = readConfigurationId(value.id, 'Workflow ID')
  const name = readDisplayName(value.name, 'Workflow name')
  const initialStatusId = readConfigurationId(value.initialStatusId, 'Initial status ID')
  if (!Array.isArray(value.statuses) || value.statuses.length === 0 || value.statuses.length > 32) {
    throw invalidWorkflow('Workflow must contain between 1 and 32 statuses.')
  }
  const statuses = value.statuses.map(readWorkflowStatus)
  assertUnique(statuses.map((status) => status.id), 'Workflow status ID')
  assertUnique(statuses.map((status) => status.sortOrder), 'Workflow status sortOrder')
  if (!statuses.some((status) => status.id === initialStatusId)) {
    throw invalidWorkflow('Workflow initial status is not defined.')
  }
  if (!Array.isArray(value.transitions) || value.transitions.length > 1_024) {
    throw invalidWorkflow('Workflow transitions must be an array with at most 1024 entries.')
  }
  const statusIds = new Set(statuses.map((status) => status.id))
  const transitions = value.transitions.map((transition) => {
    if (!isRecord(transition)) {
      throw invalidWorkflow('Workflow transition must be an object.')
    }
    const fromStatusId = readConfigurationId(transition.fromStatusId, 'Transition source status')
    const toStatusId = readConfigurationId(transition.toStatusId, 'Transition target status')
    if (!statusIds.has(fromStatusId) || !statusIds.has(toStatusId) || fromStatusId === toStatusId) {
      throw invalidWorkflow('Workflow transition references an invalid status.')
    }
    return { fromStatusId, toStatusId }
  })
  assertUnique(
    transitions.map((transition) => `${transition.fromStatusId}\0${transition.toStatusId}`),
    'Workflow transition',
  )
  return { id, name, initialStatusId, statuses, transitions }
}

/** Validates one workflow status definition. */
function readWorkflowStatus(value: unknown): WorkflowStatusDefinition {
  if (!isRecord(value)) {
    throw invalidWorkflow('Workflow status must be an object.')
  }
  const category = value.category
  if (!isWorkflowCategory(category)) {
    throw invalidWorkflow('Workflow status category is invalid.')
  }
  return {
    id: readConfigurationId(value.id, 'Workflow status ID'),
    name: readDisplayName(value.name, 'Workflow status name'),
    category,
    sortOrder: readNonNegativeInteger(value.sortOrder, 'Workflow status sortOrder'),
    ...(value.color === undefined ? {} : {
      color: readDisplayName(value.color, 'Workflow status color'),
    }),
  }
}

/** Rejects duplicate identifiers or ordering values. */
function assertUnique(values: readonly (number | string)[], label: string) {
  if (new Set(values).size !== values.length) {
    throw invalidWorkflow(`${label} must be unique.`)
  }
}

/** Reads a bounded identifier. */
function readIdentifier(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw invalidWorkflow(`${label} is invalid.`)
  }
  return value.trim()
}

/** Reads an identifier accepted by Work Item configuration contracts. */
function readConfigurationId(value: unknown, label: string) {
  const id = readIdentifier(value, label)
  if (!CONFIGURATION_ID_PATTERN.test(id)) {
    throw invalidWorkflow(`${label} must use letters, numbers, dots, underscores, or hyphens.`)
  }
  return id
}

/** Reads a bounded display name. */
function readDisplayName(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 160) {
    throw invalidWorkflow(`${label} is invalid.`)
  }
  return value.trim()
}

/** Reads a non-negative safe integer without a type assertion. */
function readNonNegativeInteger(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidWorkflow(`${label} must be a non-negative integer.`)
  }
  return value
}

/** Narrows an unknown workflow status category. */
function isWorkflowCategory(value: unknown): value is WorkflowStatusCategory {
  return value === 'backlog' || value === 'unstarted' || value === 'started' ||
    value === 'completed' || value === 'canceled'
}

/** Narrows an unknown value to a non-null record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Creates a pure workflow validation error. */
function invalidWorkflow(message: string) {
  return new WorkflowDefinitionValidationError(message)
}
