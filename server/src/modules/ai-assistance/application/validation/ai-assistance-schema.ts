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
/** Member identifiers may be longer than generic resource identifiers (for example, long emails). */
const memberIdentifierSchema = z.string().trim().min(1).max(320)
const boundedTextSchema = createSafeTextSchema(2_000)
const titleTextSchema = createSafeTextSchema(256)
const planningStatusTextSchema = createSafeTextSchema(2_000, 0).refine(
  isWellFormedUnicode,
  { message: 'Planning status text must be well-formed Unicode.' },
)
const requiredPlanningStatusTextSchema = createSafeTextSchema(2_000).refine(
  isWellFormedUnicode,
  { message: 'Planning status text must be well-formed Unicode.' },
)
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

const suggestedMemberIdentifierSchema = z.object({
  value: memberIdentifierSchema,
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
  z.string().trim().max(2_000).refine(
    (value) => !hasUnsafeControlCharacter(value),
    { message: 'Custom-field text must not contain unsafe control characters.' },
  ),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().trim().max(500).refine(
    (value) => !hasUnsafeControlCharacter(value),
    { message: 'Custom-field text must not contain unsafe control characters.' },
  )).max(100),
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
      (filter.value.trim().length === 0 ||
        filter.value !== filter.value.trim())
  ) {
    context.addIssue({
      code: 'custom',
      path: ['value'],
      message: 'String equality custom field operators require a non-empty trimmed string.',
    })
  }
})

const workspaceSearchFiltersSchema = z.object({
  keyword: createSafeTextSchema(256).optional(),
  entityTypes: z.array(z.enum([
    'work-item',
    'project',
    'team',
    'comment',
    'context-item',
    'file',
    'document',
  ])).max(7).optional(),
  assigneeUserIds: z.array(memberIdentifierSchema).max(100).optional(),
  creatorUserIds: z.array(memberIdentifierSchema).max(100).optional(),
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
  description: createSafeTextSchema(10_000).optional(),
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

const planningDependenciesSchema = z.array(planningDependencySchema).max(100).superRefine(
  (dependencies, context) => {
    const seenEdges = new Set<string>()
    dependencies.forEach((dependency, index) => {
      const edgeKey = planningDependencyEdgeKey(dependency)
      if (seenEdges.has(edgeKey)) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: 'Planning dependencies must use unique predecessor and successor endpoints.',
        })
        return
      }
      seenEdges.add(edgeKey)
    })
    if (hasPlanningDependencyCycle(dependencies)) {
      context.addIssue({
        code: 'custom',
        path: [],
        message: 'Planning dependencies must not contain directed cycles.',
      })
    }
  },
)

const planningStatusUpdateSchema = z.object({
  health: z.enum(['unknown', 'on-track', 'at-risk', 'off-track']),
  risk: z.enum(['none', 'low', 'medium', 'high', 'critical']),
  summary: requiredPlanningStatusTextSchema,
  riskSummary: planningStatusTextSchema,
  decisionSummary: planningStatusTextSchema,
  helpNeeded: planningStatusTextSchema,
  nextAction: requiredPlanningStatusTextSchema,
  confidence: confidenceSchema,
  citationIds: z.array(identifierSchema).min(1).max(20),
}).strict()

const draftSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('triage'),
    title: suggestedTitleSchema.optional(),
    description: suggestedStringSchema.optional(),
    priority: suggestedPrioritySchema.optional(),
    assigneeUserId: suggestedMemberIdentifierSchema.optional(),
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
    caveats: z.array(createSafeTextSchema(1_000)).max(20),
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
 * Creates a bounded text schema that rejects unsafe C0 and DEL control characters.
 *
 * @param maximumLength - Inclusive UTF-16 length limit.
 * @param minimumLength - Inclusive minimum length after trimming.
 * @returns A Zod string schema with the shared generated-prose safety rules.
 */
function createSafeTextSchema(maximumLength: number, minimumLength = 1) {
  return z.string()
    .trim()
    .min(minimumLength)
    .max(maximumLength)
    .refine(
      (value) => !hasUnsafeControlCharacter(value),
      { message: 'Text must not contain unsafe control characters.' },
    )
}

/**
 * Checks text for a disallowed C0 or DEL control character.
 *
 * @param value - Text to inspect.
 * @returns Whether the text contains a control character that cannot cross the API boundary.
 */
function hasUnsafeControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint === 127 || (codePoint < 32 && codePoint !== 9 && codePoint !== 10)
  })
}

/**
 * Creates a stable directed edge key for one planning dependency.
 *
 * @param dependency - Dependency whose predecessor and successor form the edge.
 * @returns A serialized endpoint pair used for duplicate detection.
 */
function planningDependencyEdgeKey(
  dependency: {
    predecessor: { teamId: string; workItemId: string }
    successor: { teamId: string; workItemId: string }
  },
): string {
  return JSON.stringify([
    dependency.predecessor.teamId,
    dependency.predecessor.workItemId,
    dependency.successor.teamId,
    dependency.successor.workItemId,
  ])
}

/**
 * Checks whether directed planning dependencies contain a cycle.
 *
 * @param dependencies - Parsed dependency edges to inspect.
 * @returns Whether a path returns to a previously visiting endpoint.
 */
function hasPlanningDependencyCycle(
  dependencies: ReadonlyArray<{
    predecessor: { teamId: string; workItemId: string }
    successor: { teamId: string; workItemId: string }
  }>,
): boolean {
  const outgoing = new Map<string, Set<string>>()
  for (const dependency of dependencies) {
    const predecessor = `${dependency.predecessor.teamId}\u0000${dependency.predecessor.workItemId}`
    const successor = `${dependency.successor.teamId}\u0000${dependency.successor.workItemId}`
    const successors = outgoing.get(predecessor) ?? new Set<string>()
    successors.add(successor)
    outgoing.set(predecessor, successors)
    if (!outgoing.has(successor)) outgoing.set(successor, new Set<string>())
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true
    if (visited.has(node)) return false
    visiting.add(node)
    for (const successor of outgoing.get(node) ?? []) {
      if (visit(successor)) return true
    }
    visiting.delete(node)
    visited.add(node)
    return false
  }
  for (const node of outgoing.keys()) {
    if (visit(node)) return true
  }
  return false
}

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
 * Rejects lone UTF-16 surrogates before persistence or browser encoding.
 *
 * @param value - Candidate normalized text.
 * @returns Whether every surrogate is paired as a valid UTF-16 code point.
 */
function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1)
      if (
        index + 1 >= value.length ||
        nextCodeUnit < 0xdc00 ||
        nextCodeUnit > 0xdfff
      ) return false
      index += 1
      continue
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false
  }
  return true
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
  label: createSafeTextSchema(500),
  href: createSafeTextSchema(2_000),
  excerpt: createSafeTextSchema(2_000, 0).optional(),
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
