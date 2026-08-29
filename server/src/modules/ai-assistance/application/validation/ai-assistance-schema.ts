import type {
  AiAssistanceDraft,
  AiAssistanceGeneration,
  AiAssistancePolicy,
  AiAssistancePreference,
  AiAssistanceUsage,
  AiAssistanceUncertainty,
  CreateAiAssistanceFeedbackRequest,
  DecideAiAssistanceGenerationRequest,
  GenerateAiAssistanceRequest,
  UpdateAiAssistancePolicyRequest,
  UpdateAiAssistancePreferenceRequest,
} from '@mukuroji/contracts'
import { AI_ASSISTANCE_SCHEMA_VERSION } from '@mukuroji/contracts'
import { z } from 'zod'
import { AiAssistanceError } from '../../errors'

const identifierSchema = z.string().trim().min(1).max(256)
const boundedTextSchema = z.string().trim().min(1).max(2_000)
const titleTextSchema = z.string().trim().min(1).max(256)
/** Maximum URL-encoded query size accepted by the existing Search GET route. */
const searchFilterGetQueryMaximumBytes = 6_144
const confidenceSchema = z.enum(['high', 'medium', 'low'])
const taskSchema = z.enum(['triage', 'summary', 'search', 'planning'])
const revisionSchema = z.number().int().min(0)
const workItemPrioritySchema = z.enum(['high', 'medium', 'low'])
const calendarDateSchema = z.string().trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine(isValidCalendarDate, { message: 'Date must be a valid YYYY-MM-DD value.' })
const uniqueModelIdsSchema = z.array(identifierSchema).min(1).max(20).refine(
  (values) => new Set(values).size === values.length,
  { message: 'Model identifiers must be unique.' },
)
const uniqueTasksSchema = z.array(taskSchema).min(1).max(4).refine(
  (values) => new Set(values).size === values.length,
  { message: 'AI assistance tasks must be unique.' },
)

const planningTargetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('project'),
    teamId: identifierSchema,
    projectId: identifierSchema,
  }).strict(),
  z.object({
    type: z.literal('initiative'),
    entityId: identifierSchema,
  }).strict(),
])

const sourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('triage-entry'),
    teamId: identifierSchema,
    triageEntryId: identifierSchema,
    expectedRevision: revisionSchema,
  }).strict(),
  z.object({
    type: z.literal('request-submission'),
    formId: identifierSchema,
    submissionId: identifierSchema,
    expectedRevision: revisionSchema,
  }).strict(),
  z.object({
    type: z.literal('work-item'),
    teamId: identifierSchema,
    workItemId: identifierSchema,
    expectedRevision: revisionSchema,
  }).strict(),
  z.object({
    type: z.literal('document'),
    documentId: identifierSchema,
    expectedRevision: revisionSchema,
  }).strict(),
  z.object({
    type: z.literal('planning-target'),
    target: planningTargetSchema,
    expectedRevision: revisionSchema,
  }).strict(),
])

const generationOptionsShape = {
  modelId: identifierSchema.optional(),
  locale: z.enum(['ja', 'en']),
}

const generateRequestSchema = z.discriminatedUnion('task', [
  z.object({
    ...generationOptionsShape,
    task: z.literal('triage'),
    source: z.union([
      sourceSchema.options[0],
      sourceSchema.options[1],
    ]),
    guidance: boundedTextSchema.optional(),
  }).strict(),
  z.object({
    ...generationOptionsShape,
    task: z.literal('summary'),
    sources: z.array(sourceSchema).min(1).max(20),
    focus: boundedTextSchema.optional(),
  }).strict(),
  z.object({
    ...generationOptionsShape,
    task: z.literal('search'),
    query: boundedTextSchema,
  }).strict(),
  z.object({
    ...generationOptionsShape,
    task: z.literal('planning'),
    source: z.union([
      sourceSchema.options[2],
      sourceSchema.options[4],
    ]),
    guidance: boundedTextSchema.optional(),
  }).strict(),
])

const suggestedStringSchema = z.object({
  value: boundedTextSchema,
  reason: boundedTextSchema,
  confidence: confidenceSchema,
  citationIds: z.array(identifierSchema).min(1).max(20),
}).strict()

const suggestedTitleSchema = z.object({
  value: titleTextSchema,
  reason: boundedTextSchema,
  confidence: confidenceSchema,
  citationIds: z.array(identifierSchema).min(1).max(20),
}).strict()

const suggestedIdentifierSchema = z.object({
  value: identifierSchema,
  reason: boundedTextSchema,
  confidence: confidenceSchema,
  citationIds: z.array(identifierSchema).min(1).max(20),
}).strict()

const suggestedPrioritySchema = z.object({
  value: workItemPrioritySchema,
  reason: boundedTextSchema,
  confidence: confidenceSchema,
  citationIds: z.array(identifierSchema).min(1).max(20),
}).strict()

const suggestedEffortSchema = z.object({
  value: z.number().int().min(0).max(10_000_000),
  reason: boundedTextSchema,
  confidence: confidenceSchema,
  citationIds: z.array(identifierSchema).min(1).max(20),
}).strict()

const customFieldValueSchema = z.union([
  z.string().max(2_000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(500)).max(100),
  z.null(),
])

const suggestedCustomFieldSchema = z.object({
  fieldId: identifierSchema,
  value: customFieldValueSchema,
  reason: boundedTextSchema,
  confidence: confidenceSchema,
  citationIds: z.array(identifierSchema).min(1).max(20),
}).strict()

const briefItemSchema = z.object({
  id: identifierSchema,
  text: boundedTextSchema,
  confidence: confidenceSchema,
  citationIds: z.array(identifierSchema).min(1).max(20),
}).strict()

const customFieldFilterSchema = z.object({
  fieldId: identifierSchema,
  operator: z.enum([
    'equals',
    'not-equals',
    'contains',
    'greater-than',
    'greater-than-or-equal',
    'less-than',
    'less-than-or-equal',
    'is-empty',
    'is-not-empty',
  ]),
  value: customFieldValueSchema.optional(),
}).strict().superRefine((filter, context) => {
  const isEmptyOperator = filter.operator === 'is-empty' || filter.operator === 'is-not-empty'
  if (filter.value === undefined && !isEmptyOperator) {
    context.addIssue({
      code: 'custom',
      path: ['value'],
      message: 'A value is required for this custom field operator.',
    })
    return
  }
  if (filter.value !== undefined && isEmptyOperator) {
    context.addIssue({
      code: 'custom',
      path: ['value'],
      message: 'Empty-check custom field operators cannot include a value.',
    })
    return
  }
  if (filter.value === undefined) return

  const comparisonOperator = filter.operator === 'greater-than' ||
    filter.operator === 'greater-than-or-equal' ||
    filter.operator === 'less-than' ||
    filter.operator === 'less-than-or-equal'
  if (comparisonOperator && (typeof filter.value !== 'number' || !Number.isFinite(filter.value))) {
    context.addIssue({
      code: 'custom',
      path: ['value'],
      message: 'Comparison custom field operators require a finite number.',
    })
    return
  }
  if (filter.operator === 'contains') {
    const validContainsValue = typeof filter.value === 'string'
      ? filter.value.trim().length > 0 && filter.value === filter.value.trim()
      : Array.isArray(filter.value) &&
        filter.value.length > 0 &&
        filter.value.every((item) => item.length > 0 && item === item.trim())
    if (!validContainsValue) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Contains custom field operators require a non-empty string or string array.',
      })
    }
    return
  }
  if (
    (filter.operator === 'equals' || filter.operator === 'not-equals') &&
    typeof filter.value === 'string' &&
    (filter.value.trim().length === 0 || filter.value !== filter.value.trim())
  ) {
    context.addIssue({
      code: 'custom',
      path: ['value'],
      message: 'Equality custom field operators require a non-empty trimmed string.',
    })
  }
})

const workspaceSearchFiltersSchema = z.object({
  keyword: z.string().trim().min(1).max(256).optional(),
  entityTypes: z.array(z.enum([
    'work-item',
    'project',
    'team',
    'comment',
    'context-item',
    'file',
    'document',
  ])).max(7).optional(),
  assigneeUserIds: z.array(identifierSchema).max(100).optional(),
  creatorUserIds: z.array(identifierSchema).max(100).optional(),
  statuses: z.array(identifierSchema).max(100).optional(),
  customFields: z.array(customFieldFilterSchema).max(50).optional(),
  relationIds: z.array(identifierSchema).max(100).optional(),
  date: z.object({
    field: z.enum(['createdAt', 'updatedAt', 'dueDate']),
    from: calendarDateSchema.optional(),
    to: calendarDateSchema.optional(),
  }).strict().refine(
    (date) => date.from !== undefined || date.to !== undefined,
    { message: 'At least one date bound is required.' },
  ).refine(
    (date) => date.from === undefined || date.to === undefined || date.from <= date.to,
    { message: 'The date range must not be reversed.' },
  ).optional(),
  projectIds: z.array(identifierSchema).max(100).optional(),
  teamIds: z.array(identifierSchema).max(100).optional(),
}).strict().superRefine((filters, context) => {
  if (!isSearchFilterTransportWithinGetBudget(filters)) {
    context.addIssue({
      code: 'custom',
      message: 'Search filters exceed the canonical GET transport budget.',
    })
  }
})

const workItemEndpointSchema = z.object({
  teamId: identifierSchema,
  workItemId: identifierSchema,
}).strict()

const planningSubtaskSchema = z.object({
  id: identifierSchema,
  title: titleTextSchema,
  description: z.string().trim().min(1).max(10_000).optional(),
  priority: workItemPrioritySchema,
  plannedEffortMinutes: z.number().int().min(0).max(10_000_000).optional(),
  reason: boundedTextSchema,
  confidence: confidenceSchema,
  citationIds: z.array(identifierSchema).min(1).max(20),
}).strict()

const planningDependencySchema = z.object({
  id: identifierSchema,
  predecessor: workItemEndpointSchema,
  successor: workItemEndpointSchema,
  type: z.enum([
    'finish-to-start',
    'start-to-start',
    'finish-to-finish',
    'start-to-finish',
  ]),
  lagDays: z.number().int().min(-36_600).max(36_600),
  reason: boundedTextSchema,
  confidence: confidenceSchema,
  citationIds: z.array(identifierSchema).min(1).max(20),
}).strict().superRefine((dependency, context) => {
  if (
    dependency.predecessor.teamId === dependency.successor.teamId &&
    dependency.predecessor.workItemId === dependency.successor.workItemId
  ) {
    context.addIssue({
      code: 'custom',
      path: ['successor'],
      message: 'A planning dependency cannot reference the same Work Item twice.',
    })
  }
})

const planningSubtasksSchema = z.array(planningSubtaskSchema).max(50)

const planningDependenciesSchema = z.array(planningDependencySchema).max(100)

const planningStatusUpdateSchema = z.object({
  health: z.enum(['unknown', 'on-track', 'at-risk', 'off-track']),
  risk: z.enum(['none', 'low', 'medium', 'high', 'critical']),
  summary: boundedTextSchema,
  riskSummary: z.string().trim().max(2_000),
  decisionSummary: z.string().trim().max(2_000),
  helpNeeded: z.string().trim().max(2_000),
  nextAction: z.string().trim().min(1).max(2_000),
  confidence: confidenceSchema,
  citationIds: z.array(identifierSchema).min(1).max(20),
}).strict()

const draftSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('triage'),
    title: suggestedTitleSchema.optional(),
    description: suggestedStringSchema.optional(),
    priority: suggestedPrioritySchema.optional(),
    assigneeUserId: suggestedIdentifierSchema.optional(),
    teamId: suggestedIdentifierSchema.optional(),
    projectId: suggestedIdentifierSchema.optional(),
    customFields: z.array(suggestedCustomFieldSchema).max(50).superRefine((fields, context) => {
      const fieldIds = fields.map((field) => field.fieldId)
      if (new Set(fieldIds).size !== fieldIds.length) {
        context.addIssue({
          code: 'custom',
          message: 'Triage custom-field suggestions must use unique field identifiers.',
        })
      }
    }),
  }).strict(),
  z.object({
    kind: z.literal('summary'),
    overview: briefItemSchema,
    decisions: z.array(briefItemSchema).max(100),
    actions: z.array(briefItemSchema).max(100),
    risks: z.array(briefItemSchema).max(100),
  }).strict(),
  z.object({
    kind: z.literal('search'),
    interpretation: boundedTextSchema,
    filters: workspaceSearchFiltersSchema,
    report: z.object({
      metric: z.literal('count'),
      groupBy: z.enum([
        'entityType',
        'assignee',
        'creator',
        'status',
        'project',
        'team',
      ]).optional(),
    }).strict().optional(),
    caveats: z.array(z.string().trim().min(1).max(1_000)).max(20),
  }).strict(),
  z.object({
    kind: z.literal('planning'),
    title: suggestedTitleSchema.optional(),
    description: suggestedStringSchema.optional(),
    priority: suggestedPrioritySchema.optional(),
    status: suggestedIdentifierSchema.optional(),
    plannedEffortMinutes: suggestedEffortSchema.optional(),
    subtasks: planningSubtasksSchema,
    dependencies: planningDependenciesSchema,
    statusUpdate: planningStatusUpdateSchema.optional(),
  }).strict(),
])

const uncertaintySchema = z.object({
  level: confidenceSchema,
  reason: boundedTextSchema,
}).strict()

/** Strict structured output schema supplied to Mastra for every generation. */
export const aiAssistanceModelOutputSchema = z.object({
  draft: draftSchema,
  uncertainty: uncertaintySchema,
}).strict()

/**
 * Checks one fixed-width ISO calendar date without accepting timestamp coercion.
 *
 * @param value - Candidate date after schema-level string normalization.
 * @returns Whether year, month, and day form a real Gregorian calendar date.
 */
function isValidCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1) return false
  const leapYear = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0)
  const daysByMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ]
  const maximumDay = daysByMonth[month - 1]
  return maximumDay !== undefined && day <= maximumDay
}

/**
 * Checks the aggregate URL-encoded size accepted by the canonical Search GET transport.
 *
 * @param filters - Parsed Search filters that will be serialized into the GET query.
 * @returns Whether the encoded `filters` query parameter fits the route budget.
 */
function isSearchFilterTransportWithinGetBudget(filters: unknown): boolean {
  try {
    const serialized = JSON.stringify(filters)
    if (serialized === undefined) return false
    return new TextEncoder().encode(
      new URLSearchParams({ filters: serialized }).toString(),
    ).byteLength <= searchFilterGetQueryMaximumBytes
  } catch {
    return false
  }
}

const citationSchema = z.object({
  id: identifierSchema,
  sourceType: z.enum([
    'triage-entry',
    'request-submission',
    'work-item',
    'document',
    'planning-target',
  ]),
  label: z.string().trim().min(1).max(500),
  href: z.string().trim().min(1).max(2_000),
  excerpt: z.string().trim().max(2_000).optional(),
  capturedRevision: revisionSchema,
}).strict()

const usageBaseSchema = z.object({
  inputTokens: z.number().finite().int().min(0).optional(),
  outputTokens: z.number().finite().int().min(0).optional(),
  latencyMs: z.number().finite().int().min(0),
}).strict()

const usageSchema = z.union([
  usageBaseSchema.extend({
    costUsd: z.number().min(0).finite(),
  }).strict(),
  usageBaseSchema.extend({
    costUnavailableReason: z.enum([
      'provider-not-reported',
      'pricing-not-configured',
    ]),
  }).strict(),
])

const generationSchema = z.object({
  schemaVersion: z.literal(AI_ASSISTANCE_SCHEMA_VERSION),
  id: identifierSchema,
  task: taskSchema,
  revision: revisionSchema,
  content: z.discriminatedUnion('availability', [
    z.object({
      availability: z.literal('available'),
      draft: draftSchema,
      citations: z.array(citationSchema).max(100),
      uncertainty: uncertaintySchema,
    }).strict(),
    z.object({
      availability: z.literal('withheld'),
      reasonCode: z.enum([
        'permission-changed',
        'retention-expired',
        'source-changed',
      ]),
    }).strict(),
  ]),
  details: z.object({
    provider: z.literal('bedrock'),
    modelId: identifierSchema,
    promptVersion: identifierSchema,
    traceId: identifierSchema,
    usage: usageSchema,
  }).strict(),
  decision: z.object({
    outcome: z.enum(['approved', 'rejected']),
    decidedAt: z.string().datetime(),
  }).strict().optional(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict()

const policySchema = z.object({
  schemaVersion: z.literal(AI_ASSISTANCE_SCHEMA_VERSION),
  enabled: z.boolean(),
  allowedModelIds: uniqueModelIdsSchema,
  defaultModelId: identifierSchema,
  enabledTasks: uniqueTasksSchema,
  retentionDays: z.number().int().min(1).max(365),
  revision: revisionSchema,
  updatedAt: z.string().datetime(),
}).strict()

const preferenceSchema = z.object({
  schemaVersion: z.literal(AI_ASSISTANCE_SCHEMA_VERSION),
  enabled: z.boolean(),
  revision: revisionSchema,
  updatedAt: z.string().datetime(),
}).strict()

const updatePolicySchema = policySchema.omit({
  schemaVersion: true,
  revision: true,
  updatedAt: true,
}).extend({ expectedRevision: revisionSchema }).strict()

const updatePreferenceSchema = preferenceSchema.omit({
  schemaVersion: true,
  revision: true,
  updatedAt: true,
}).extend({ expectedRevision: revisionSchema }).strict()

const decisionSchema = z.object({
  outcome: z.enum(['approved', 'rejected']),
  expectedRevision: revisionSchema,
}).strict()

const feedbackSchema = z.object({
  rating: z.enum(['helpful', 'not-helpful']),
  comment: z.string().trim().min(1).max(2_000).optional(),
}).strict()

/** Parsed structured output returned by the model gateway. */
export type AiAssistanceModelOutput = {
  /** Validated task-specific draft. */
  draft: AiAssistanceDraft
  /** Validated overall uncertainty disclosure. */
  uncertainty: AiAssistanceUncertainty
}

/**
 * Parses an untrusted generation request.
 *
 * @param value - Unknown request body.
 * @returns Strictly validated generation request.
 */
export function parseGenerateAiAssistanceRequest(
  value: unknown,
): GenerateAiAssistanceRequest {
  return parseOrThrow(generateRequestSchema, value, 'Invalid AI assistance request.')
}

/**
 * Parses an untrusted model response.
 *
 * @param value - Unknown structured model output.
 * @returns Strictly validated model output.
 */
export function parseAiAssistanceModelOutput(
  value: unknown,
): AiAssistanceModelOutput {
  return parseOrThrow(aiAssistanceModelOutputSchema, value, 'Invalid AI assistance output.', true)
}

/**
 * Parses provider usage metadata before it crosses the application boundary.
 *
 * @param value - Untrusted usage reported by a model adapter.
 * @returns Finite, non-negative usage values accepted by the public contract.
 */
export function parseAiAssistanceUsage(value: unknown): AiAssistanceUsage {
  return parseOrThrow(usageSchema, value, 'Invalid AI assistance usage.', true)
}

/**
 * Parses an untrusted persisted generation.
 *
 * @param value - Unknown persisted generation record.
 * @returns Strictly validated generation record.
 */
export function parseAiAssistanceGeneration(value: unknown): AiAssistanceGeneration {
  return parseRecordOrThrow(generationSchema, value)
}

/**
 * Parses an untrusted persisted Workspace policy.
 *
 * @param value - Unknown persisted policy record.
 * @returns Strictly validated Workspace policy.
 */
export function parseAiAssistancePolicy(value: unknown): AiAssistancePolicy {
  return parseRecordOrThrow(policySchema, value)
}

/**
 * Parses an untrusted persisted member preference.
 *
 * @param value - Unknown persisted preference record.
 * @returns Strictly validated member preference.
 */
export function parseAiAssistancePreference(value: unknown): AiAssistancePreference {
  return parseRecordOrThrow(preferenceSchema, value)
}

/**
 * Parses an untrusted Workspace policy update.
 *
 * @param value - Unknown policy update request.
 * @returns Strictly validated policy update request.
 */
export function parseUpdateAiAssistancePolicyRequest(
  value: unknown,
): UpdateAiAssistancePolicyRequest {
  return parseOrThrow(updatePolicySchema, value, 'Invalid AI assistance policy update.')
}

/**
 * Parses an untrusted member preference update.
 *
 * @param value - Unknown preference update request.
 * @returns Strictly validated preference update request.
 */
export function parseUpdateAiAssistancePreferenceRequest(
  value: unknown,
): UpdateAiAssistancePreferenceRequest {
  return parseOrThrow(updatePreferenceSchema, value, 'Invalid AI assistance preference update.')
}

/**
 * Parses an untrusted human decision request.
 *
 * @param value - Unknown decision request.
 * @returns Strictly validated generation decision request.
 */
export function parseDecideAiAssistanceGenerationRequest(
  value: unknown,
): DecideAiAssistanceGenerationRequest {
  return parseOrThrow(decisionSchema, value, 'Invalid AI assistance decision.')
}

/**
 * Parses untrusted generation feedback.
 *
 * @param value - Unknown feedback request.
 * @returns Strictly validated feedback request.
 */
export function parseCreateAiAssistanceFeedbackRequest(
  value: unknown,
): CreateAiAssistanceFeedbackRequest {
  return parseOrThrow(feedbackSchema, value, 'Invalid AI assistance feedback.')
}

/**
 * Parses one input schema and converts Zod details into a stable application error.
 *
 * @param schema - Schema used to validate the value.
 * @param value - Untrusted value.
 * @param message - Safe failure message.
 * @param output - Whether the value came from the model.
 * @returns Parsed schema output.
 */
function parseOrThrow<Output>(
  schema: z.ZodType<Output>,
  value: unknown,
  message: string,
  output = false,
): Output {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  throw new AiAssistanceError(
    output ? 'upstream' : 'validation',
    output ? 'InvalidAiAssistanceOutput' : 'InvalidAiAssistanceRequest',
    message,
  )
}

/** Parses one persisted record and fails closed on unknown schema. */
function parseRecordOrThrow<Output>(schema: z.ZodType<Output>, value: unknown): Output {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  throw new AiAssistanceError(
    'upstream',
    'InvalidAiAssistanceRecord',
    'The AI assistance record is invalid.',
  )
}
