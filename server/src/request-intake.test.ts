import { createHmac } from 'node:crypto'
import { expect, test } from 'bun:test'
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type {
  RequestForm,
  RequestFormDefinition,
  RequestFormDraft,
  RequestFormVersion,
  RequestSubmission,
  SubmitRequestInput,
} from '@mukuroji/contracts'
import type { FileObjectClient } from './file-proofing'
import {
  DynamoDbRequestIntakeClient,
  RequestIntakeError,
  createRequestWorkItemInput,
  evaluateRequestConditionGroup,
  resolveRequestRouting,
  validateRequestAnswers,
  validateRequestFormDefinition,
  validateRequestFormDraft,
  type RequestLinkResolution,
} from './request-intake'

const now = new Date('2026-07-16T09:00:00.000Z')
const sessionToken = 'S'.repeat(43)
const threadToken = 'T'.repeat(43)
const tokenHashSecret = 'request-intake-test-secret-0000000000000000'

const definition = {
  defaultLocale: 'ja',
  supportedLocales: ['ja', 'en'],
  title: { ja: 'お問い合わせ', en: 'Request' },
  description: { ja: '必要事項を入力してください。', en: 'Please provide the details.' },
  sections: [
    {
      id: 'overview',
      title: { ja: '概要', en: 'Overview' },
      fields: [
        {
          id: 'category',
          type: 'single-select',
          label: { ja: '種別', en: 'Category' },
          options: [
            { id: 'general', label: { ja: '一般', en: 'General' } },
            { id: 'urgent', label: { ja: '緊急', en: 'Urgent' } },
          ],
          validation: { required: true },
        },
        {
          id: 'title',
          type: 'short-text',
          label: { ja: '件名', en: 'Title' },
          validation: { required: true, minLength: 3, pattern: '^[A-Z].+' },
        },
        {
          id: 'estimate',
          type: 'number',
          label: { ja: '見積', en: 'Estimate' },
          validation: { min: 1, max: 100 },
        },
        {
          id: 'urgent-note',
          type: 'long-text',
          label: { ja: '緊急理由', en: 'Urgency reason' },
          validation: { required: true },
          visibleWhen: {
            mode: 'all',
            conditions: [{ fieldId: 'category', operator: 'equals', value: 'urgent' }],
          },
        },
        {
          id: 'email',
          type: 'email',
          label: { ja: 'メール', en: 'Email' },
          validation: { required: true },
        },
      ],
    },
    {
      id: 'impact-section',
      title: { ja: '影響', en: 'Impact' },
      visibleWhen: {
        mode: 'all',
        conditions: [{ fieldId: 'category', operator: 'equals', value: 'urgent' }],
      },
      fields: [
        {
          id: 'impact',
          type: 'long-text',
          label: { ja: '影響範囲', en: 'Impact' },
          validation: { required: true },
        },
      ],
    },
  ],
  consent: {
    required: true,
    label: { ja: 'プライバシーポリシーに同意します。', en: 'I accept the privacy policy.' },
    privacyUrl: 'https://example.com/privacy',
  },
  confirmation: {
    message: { ja: '受け付けました。', en: 'Your request was received.' },
  },
} satisfies RequestFormDefinition

const routing = {
  defaultTarget: {
    teamId: 'team-core',
    assigneeUserId: 'triage@example.com',
    priority: 'medium',
    dueDateOffsetDays: 7,
  },
  rules: [
    {
      id: 'urgent-first',
      name: 'Urgent requests',
      when: {
        mode: 'all',
        conditions: [{ fieldId: 'category', operator: 'equals', value: 'urgent' }],
      },
      target: {
        teamId: 'team-core',
        projectId: 'project-urgent',
        workflowStatusId: 'triage',
        assigneeUserId: 'urgent@example.com',
        priority: 'high',
        dueDateOffsetDays: 1,
      },
    },
    {
      id: 'non-empty-fallback',
      name: 'Any categorized request',
      when: {
        mode: 'all',
        conditions: [{ fieldId: 'category', operator: 'is-not-empty' }],
      },
      target: {
        teamId: 'team-core',
        projectId: 'project-general',
        assigneeUserId: 'general@example.com',
        priority: 'low',
        dueDateOffsetDays: 14,
      },
    },
  ],
  mapping: {
    titleFieldId: 'title',
    descriptionFieldIds: ['urgent-note', 'impact'],
    customFieldMappings: { category: 'request-channel', estimate: 'estimate' },
  },
} satisfies RequestFormDraft['routing']

const draft = { definition, routing } satisfies RequestFormDraft

const resolution = {
  workspaceId: 'workspace-1',
  formId: 'form-1',
  accessMode: 'public',
  tokenDigest: 'link-digest',
} satisfies RequestLinkResolution

function cloneDraft() {
  return structuredClone(draft)
}

function createStoredVersion(
  version = 1,
  snapshot: RequestFormDraft = draft,
) {
  return {
    entryType: 'form-version',
    scopeKey: 'WORKSPACE#workspace-1',
    recordKey: `FORM_VERSION#form-1#VERSION#${String(version).padStart(6, '0')}`,
    schemaVersion: 1,
    formId: 'form-1',
    version,
    snapshot,
    createdBy: 'admin@example.com',
    createdAt: '2026-07-16T08:00:00.000Z',
  } satisfies RequestFormVersion & Record<string, unknown>
}

function createStoredForm(overrides: Record<string, unknown> = {}) {
  return {
    entryType: 'form',
    scopeKey: 'WORKSPACE#workspace-1',
    recordKey: 'FORM_ROOT#form-1',
    id: 'form-1',
    name: 'Support request',
    scope: { type: 'team', teamId: 'team-core' },
    status: 'published',
    revision: 1,
    draft,
    currentPublishedVersion: 1,
    publishedVersions: [1],
    link: {
      linkId: 'link-1',
      accessMode: 'public',
    },
    createdAt: '2026-07-16T08:00:00.000Z',
    updatedAt: '2026-07-16T08:00:00.000Z',
    capabilities: { canEdit: true, canPublish: true, canManageLink: true },
    ...overrides,
  } as RequestForm & Record<string, unknown>
}

function createStoredSubmission(overrides: Record<string, unknown> = {}) {
  return {
    entryType: 'submission',
    scopeKey: 'WORKSPACE#workspace-1',
    recordKey: 'SUBMISSION#req-1',
    queueKey: 'WORKSPACE#workspace-1',
    queueRecordKey: '2026-07-16T08:30:00.000Z#req-1',
    schemaVersion: 1,
    id: 'req-1',
    receiptId: 'receipt-1',
    formId: 'form-1',
    formVersion: 1,
    formSnapshot: createStoredVersion(),
    status: 'received',
    source: 'web',
    revision: 1,
    locale: 'ja',
    answers: {
      category: 'urgent',
      title: 'Alpha outage',
      estimate: 8,
      'urgent-note': 'Production is unavailable.',
      email: 'requester@example.com',
      impact: 'All customers are affected.',
    },
    consent: {
      accepted: true,
      label: definition.consent!.label,
      acceptedAt: '2026-07-16T08:30:00.000Z',
    },
    attachments: [],
    routingTarget: routing.rules[0]!.target,
    workItemMapping: routing.mapping,
    duplicateCandidateIds: [],
    messages: [],
    events: [{
      id: 'event-1',
      type: 'submitted',
      actorId: 'requester',
      summary: 'Request was submitted.',
      createdAt: '2026-07-16T08:30:00.000Z',
    }],
    createdAt: '2026-07-16T08:30:00.000Z',
    updatedAt: '2026-07-16T08:30:00.000Z',
    capabilities: {
      canAssign: true,
      canRequestMoreInfo: true,
      canReject: true,
      canMarkDuplicate: true,
      canConvert: true,
    },
    requesterEmail: 'requester@example.com',
    threadDigest: 'thread-digest',
    duplicateFingerprint: 'duplicate-digest',
    attachmentObjectKeys: {},
    attachmentObjectVersionIds: {},
    ...overrides,
  } as RequestSubmission & Record<string, unknown>
}

/** Test double が受け取る AWS SDK command の最小表現です。 */
type FakeCommand = {
  /** AWS SDK command が公開する入力です。 */
  input: Record<string, unknown>
}

function createDocumentClient(
  send: (command: FakeCommand) => unknown | Promise<unknown>,
  options: {
    rateCounters?: Map<string, number>
    rateCommands?: FakeCommand[]
    rateFailure?: Error
  } = {},
) {
  const rateCounters = options.rateCounters ?? new Map<string, number>()
  return {
    send(command: FakeCommand) {
      const transactionUpdates = readRateLimitTransactionUpdates(command)
      if (transactionUpdates) {
        options.rateCommands?.push(command)
        if (options.rateFailure) throw options.rateFailure
        const blocked = transactionUpdates.map((update) => isRateLimitUpdateBlocked(update, rateCounters))
        if (blocked.some(Boolean)) {
          throw Object.assign(new Error('rate limit exceeded'), {
            name: 'TransactionCanceledException',
            CancellationReasons: blocked.map((isBlocked) => ({
              Code: isBlocked ? 'ConditionalCheckFailed' : 'None',
            })),
          })
        }
        for (const update of transactionUpdates) incrementRateLimitUpdate(update, rateCounters)
        return {}
      }
      const singleUpdate = readSingleRateLimitUpdate(command)
      if (singleUpdate) {
        options.rateCommands?.push(command)
        if (options.rateFailure) throw options.rateFailure
        if (isRateLimitUpdateBlocked(singleUpdate, rateCounters)) {
          throw Object.assign(new Error('rate limit exceeded'), {
            name: 'ConditionalCheckFailedException',
          })
        }
        incrementRateLimitUpdate(singleUpdate, rateCounters)
        return {}
      }
      return send(command)
    },
  } as unknown as DynamoDBDocumentClient
}

function readRateLimitTransactionUpdates(command: FakeCommand) {
  const items = command.input.TransactItems
  if (!Array.isArray(items)) return undefined
  const updates = items.map((item) => (
    item && typeof item === 'object' && 'Update' in item
      ? (item as { Update?: Record<string, unknown> }).Update
      : undefined
  ))
  return updates.length > 0 && updates.every(isRateLimitUpdate)
    ? updates as Record<string, unknown>[]
    : undefined
}

function readSingleRateLimitUpdate(command: FakeCommand) {
  return isRateLimitUpdate(command.input) ? command.input : undefined
}

function isRateLimitUpdate(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const update = value as Record<string, unknown>
  const key = update.Key as { recordKey?: unknown } | undefined
  return key?.recordKey === 'COUNTER' &&
    typeof update.UpdateExpression === 'string' &&
    update.UpdateExpression.includes('ADD #count :one') &&
    typeof update.ConditionExpression === 'string' &&
    update.ConditionExpression.includes('#count < :maximum')
}

function readRateLimitState(
  update: Record<string, unknown>,
  counters: Map<string, number>,
) {
  const key = update.Key as { scopeKey?: unknown }
  const values = update.ExpressionAttributeValues as Record<string, unknown>
  if (typeof key.scopeKey !== 'string' || typeof values[':maximum'] !== 'number') {
    throw new Error(`Invalid rate-limit update: ${JSON.stringify(update)}`)
  }
  return {
    key: key.scopeKey,
    count: counters.get(key.scopeKey) ?? 0,
    maximum: values[':maximum'],
  }
}

function isRateLimitUpdateBlocked(
  update: Record<string, unknown>,
  counters: Map<string, number>,
) {
  const state = readRateLimitState(update, counters)
  return state.count >= state.maximum
}

function incrementRateLimitUpdate(
  update: Record<string, unknown>,
  counters: Map<string, number>,
) {
  const state = readRateLimitState(update, counters)
  counters.set(state.key, state.count + 1)
}

function createObjectClient(overrides: Partial<FileObjectClient> = {}) {
  return {
    async createUpload() {
      return {
        url: 'https://upload.example.com/request',
        method: 'PUT' as const,
        headers: { 'Content-Type': 'application/pdf' },
        expiresAt: '2026-07-16T09:10:00.000Z',
        maxSizeBytes: 10_000,
      }
    },
    async verifyUpload(_objectKey, expected) {
      return {
        ...expected,
        scanStatus: 'available' as const,
        objectVersionId: 'object-version-1',
      }
    },
    async getScanStatus() {
      return 'available' as const
    },
    async markCompleted() {},
    async createAccess() {
      return {
        url: 'https://download.example.com/request',
        expiresAt: '2026-07-16T09:05:00.000Z',
      }
    },
    async quarantineDeletedVersion() {},
    async softDelete() {},
    ...overrides,
  } satisfies FileObjectClient
}

function createClient(
  documentClient: DynamoDBDocumentClient,
  options: {
    objectClient?: FileObjectClient
    rateLimitPerHour?: number
    token?: () => string
  } = {},
) {
  return new DynamoDbRequestIntakeClient({
    tableName: 'request-intake-table',
    queueIndexName: 'RequestQueueIndex',
    documentClient,
    dynamoDbClient: { send: async () => ({}) } as unknown as DynamoDBClient,
    objectClient: options.objectClient ?? createObjectClient(),
    tokenHashSecret,
    rateLimitPerHour: options.rateLimitPerHour ?? 10,
    now: () => new Date(now),
    token: options.token ?? (() => threadToken),
    bootstrapLocalTable: false,
  })
}

function createExpectedRateScopeKey(
  tokenDigest: string,
  operation: 'form' | 'submit' | 'thread' | 'upload',
  namespace: 'client' | 'link-global' | 'thread-global',
  subject: string,
) {
  const subjectDigest = createHmac('sha256', tokenHashSecret)
    .update(`rate-${namespace}\0${subject}`)
    .digest('hex')
  const rateDigest = createHmac('sha256', tokenHashSecret)
    .update(
      `rate\0${tokenDigest}\0${operation}\0${namespace}\0${subjectDigest}\0${now.toISOString().slice(0, 13)}`,
    )
    .digest('hex')
  return `RATE#${rateDigest}`
}

function expectIntakeError(
  callback: () => unknown,
  message: string,
) {
  expect(callback).toThrow(RequestIntakeError)
  expect(callback).toThrow(message)
}

test('validates a complete form draft and rejects unknown or forward conditional references', () => {
  expect(validateRequestFormDraft(draft)).toEqual(draft)

  const fieldForwardReference = cloneDraft()
  fieldForwardReference.definition.sections[0]!.fields[0]!.visibleWhen = {
    mode: 'all',
    conditions: [{ fieldId: 'title', operator: 'is-not-empty' }],
  }
  expectIntakeError(
    () => validateRequestFormDraft(fieldForwardReference),
    'references unknown or forward field "title"',
  )

  const sectionForwardReference = cloneDraft()
  sectionForwardReference.definition.sections[0]!.visibleWhen = {
    mode: 'all',
    conditions: [{ fieldId: 'category', operator: 'equals', value: 'urgent' }],
  }
  expectIntakeError(
    () => validateRequestFormDraft(sectionForwardReference),
    'references unknown or forward field "category"',
  )

  const unknownReference = cloneDraft()
  unknownReference.definition.sections[1]!.visibleWhen = {
    mode: 'all',
    conditions: [{ fieldId: 'missing-field', operator: 'is-not-empty' }],
  }
  expectIntakeError(
    () => validateRequestFormDraft(unknownReference),
    'references unknown or forward field "missing-field"',
  )

  const oversizedDraft = cloneDraft() as RequestFormDraft
  for (let index = 0; index < 10; index += 1) {
    oversizedDraft.definition.sections[0]!.fields.push({
      id: `large-label-${index}`,
      type: 'short-text',
      label: { ja: 'あ'.repeat(5_000) },
    })
  }
  expectIntakeError(
    () => validateRequestFormDraft(oversizedDraft),
    'Request form draft is too large.',
  )
})

test('evaluates all/any conditions and rejects answers submitted to hidden fields or sections', () => {
  expect(evaluateRequestConditionGroup(
    {
      mode: 'all',
      conditions: [
        { fieldId: 'category', operator: 'equals', value: 'urgent' },
        { fieldId: 'note', operator: 'contains', value: 'down' },
      ],
    },
    { category: 'urgent', note: 'service down' },
  )).toBe(true)
  expect(evaluateRequestConditionGroup(
    {
      mode: 'any',
      conditions: [
        { fieldId: 'category', operator: 'equals', value: 'general' },
        { fieldId: 'note', operator: 'is-empty' },
      ],
    },
    { category: 'urgent' },
  )).toBe(true)

  const baseAnswers = {
    category: 'general',
    title: 'Alpha request',
    estimate: 10,
    email: 'requester@example.com',
  }
  expect(validateRequestAnswers(definition, 'ja', baseAnswers)).toEqual(baseAnswers)
  expectIntakeError(
    () => validateRequestAnswers(definition, 'ja', {
      ...baseAnswers,
      'urgent-note': 'This should remain hidden.',
    }),
    'Hidden field "urgent-note" must not be submitted.',
  )
  expectIntakeError(
    () => validateRequestAnswers(definition, 'ja', {
      ...baseAnswers,
      impact: 'This section is hidden.',
    }),
    'Hidden section field "impact" must not be submitted.',
  )
})

test('enforces visible required fields, answer types, numeric bounds, safe patterns, and locale', () => {
  const urgentAnswers = {
    category: 'urgent',
    title: 'Alpha outage',
    estimate: 10,
    'urgent-note': 'Production is unavailable.',
    email: 'requester@example.com',
    impact: 'All customers are affected.',
  }
  expect(validateRequestAnswers(definition, 'en', urgentAnswers)).toEqual(urgentAnswers)
  expectIntakeError(
    () => validateRequestAnswers(definition, 'ja', {
      ...urgentAnswers,
      'urgent-note': undefined,
    }),
    'Field "urgent-note" is required.',
  )
  expectIntakeError(
    () => validateRequestAnswers(definition, 'ja', { ...urgentAnswers, estimate: '10' }),
    'Field "estimate" must be numeric.',
  )
  expectIntakeError(
    () => validateRequestAnswers(definition, 'ja', { ...urgentAnswers, estimate: 101 }),
    'Field "estimate" exceeds its maximum.',
  )
  expectIntakeError(
    () => validateRequestAnswers(definition, 'ja', { ...urgentAnswers, title: 'lowercase title' }),
    'Field "title" has an invalid format.',
  )
  expectIntakeError(
    () => validateRequestAnswers(definition, 'ja', { ...urgentAnswers, email: 'invalid' }),
    'Field "email" must be an email address.',
  )
  const datedDefinition = structuredClone(definition) as RequestFormDefinition
  datedDefinition.sections[0]!.fields.push({
    id: 'requested-date',
    type: 'date',
    label: { ja: '希望日', en: 'Requested date' },
  })
  expectIntakeError(
    () => validateRequestAnswers(datedDefinition, 'ja', {
      ...urgentAnswers,
      'requested-date': '2026-99-99',
    }),
    'Field "requested-date" must be an ISO date.',
  )
  const answerHeavyDefinition = structuredClone(definition) as RequestFormDefinition
  const answerHeavyValues: Record<string, string> = {}
  for (let index = 0; index < 5; index += 1) {
    const fieldId = `large-answer-${index}`
    answerHeavyDefinition.sections[0]!.fields.push({
      id: fieldId,
      type: 'long-text',
      label: { ja: `長文 ${index}` },
    })
    answerHeavyValues[fieldId] = 'a'.repeat(20_000)
  }
  expectIntakeError(
    () => validateRequestAnswers(answerHeavyDefinition, 'ja', {
      ...urgentAnswers,
      ...answerHeavyValues,
    }),
    'Request answers is too large.',
  )
  expectIntakeError(
    () => validateRequestAnswers(definition, 'fr' as 'ja', urgentAnswers),
    'Submission locale is not supported',
  )

  const unsafePattern = structuredClone(definition)
  unsafePattern.sections[0]!.fields[1]!.validation!.pattern = '^(a+)+$'
  expectIntakeError(
    () => validateRequestFormDefinition(unsafePattern),
    'unsafe repeated expression',
  )
  const ambiguousPattern = structuredClone(definition)
  ambiguousPattern.sections[0]!.fields[1]!.validation!.pattern = '^(a|aa)+$'
  expectIntakeError(
    () => validateRequestFormDefinition(ambiguousPattern),
    'unsafe repeated expression',
  )
})

test('uses the first matching routing rule and maps a submission into a canonical Work Item input', () => {
  const answers = createStoredSubmission().answers
  expect(resolveRequestRouting(routing, answers)).toEqual(routing.rules[0]!.target)

  const mapped = createRequestWorkItemInput(
    createStoredSubmission() as RequestSubmission,
    { action: 'convert', expectedRevision: 1 },
  )
  expect(mapped).toEqual({
    target: routing.rules[0]!.target,
    input: {
      title: 'Alpha outage',
      description: 'Production is unavailable.\n\nAll customers are affected.',
      assignedProjectId: 'project-urgent',
      assigneeUserId: 'urgent@example.com',
      workflowStatusId: 'triage',
      customFieldValues: { 'request-channel': 'urgent', estimate: 8 },
      dueDate: '2026/07/17',
      priority: 'high',
    },
  })

  const overridden = createRequestWorkItemInput(
    createStoredSubmission() as RequestSubmission,
    {
      action: 'convert',
      expectedRevision: 1,
      title: 'Manual title',
      target: {
        projectId: 'project-manual',
        dueDateOffsetDays: 3,
        priority: 'low',
      },
    },
  )
  expect(overridden.input).toMatchObject({
    title: 'Manual title',
    assignedProjectId: 'project-manual',
    dueDate: '2026/07/19',
    priority: 'low',
  })
})

test('creates a form with a digest-keyed link lookup and CAS-protected form row', async () => {
  const commands: FakeCommand[] = []
  const client = createClient(createDocumentClient((command) => {
    commands.push(command)
    return {}
  }))

  const form = await client.createForm('workspace-1', { id: 'admin@example.com' }, {
    name: 'Support request',
    scope: { type: 'team', teamId: 'team-core' },
    accessMode: 'public',
    draft,
  })

  const transaction = commands[0]?.input.TransactItems as Array<{
    Put?: { Item?: Record<string, unknown>; ConditionExpression?: string }
  }>
  expect(transaction).toHaveLength(2)
  expect(transaction[0]?.Put?.ConditionExpression).toContain('attribute_not_exists')
  expect(JSON.stringify(transaction[0]?.Put?.Item)).not.toContain(form.link.token)
  const lookup = transaction[1]?.Put?.Item
  const derivedToken = createHmac('sha256', tokenHashSecret)
    .update(`link-value\0workspace-1\0${form.id}\0${form.link.linkId}`)
    .digest('hex')
  expect(form.link.token).toBe(derivedToken)
  const expectedDigest = createHmac('sha256', tokenHashSecret)
    .update(`link\0${derivedToken}`)
    .digest('hex')
  expect(lookup).toMatchObject({
    entryType: 'link-lookup',
    scopeKey: `LINK#${expectedDigest}`,
    recordKey: 'LOOKUP',
    workspaceId: 'workspace-1',
  })
  expect(JSON.stringify(lookup)).not.toContain(derivedToken)
})

test('publishes an immutable version snapshot and protects the form revision with CAS', async () => {
  const current = createStoredForm({ status: 'draft', currentPublishedVersion: undefined, publishedVersions: [] })
  const commands: FakeCommand[] = []
  const client = createClient(createDocumentClient((command) => {
    commands.push(command)
    if (command.input.Key) return { Item: current }
    return {}
  }))

  const published = await client.publishForm(
    'workspace-1',
    'form-1',
    { id: 'admin@example.com' },
    { expectedRevision: 1 },
  )
  expect(published).toMatchObject({
    status: 'published',
    revision: 2,
    currentPublishedVersion: 1,
    publishedVersions: [1],
  })
  const transactionCommand = commands.find((command) => Array.isArray(command.input.TransactItems))
  const transaction = transactionCommand?.input.TransactItems as Array<{
    Put?: {
      Item?: Record<string, unknown>
      ConditionExpression?: string
      ExpressionAttributeValues?: Record<string, unknown>
    }
  }>
  expect(transaction[0]?.Put?.Item).toMatchObject({
    entryType: 'form-version',
    recordKey: 'FORM_VERSION#form-1#VERSION#000001',
    version: 1,
    snapshot: draft,
    createdBy: 'admin@example.com',
  })
  expect(transaction[0]?.Put?.ConditionExpression).toContain('attribute_not_exists')
  expect(transaction[1]?.Put?.ConditionExpression).toContain('revision = :expectedRevision')
  expect(transaction[1]?.Put?.ExpressionAttributeValues).toMatchObject({ ':expectedRevision': 1 })

  const conflictingClient = createClient(createDocumentClient((command) => {
    if (command.input.Key) return { Item: current }
    throw Object.assign(new Error('conflict'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
    })
  }))
  await expect(conflictingClient.publishForm(
    'workspace-1',
    'form-1',
    { id: 'admin@example.com' },
    { expectedRevision: 1 },
  )).rejects.toMatchObject({ code: 'RequestRevisionConflict', status: 409 })
})

test('lists only form root rows after publishing an immutable version', async () => {
  let root = createStoredForm({
    status: 'draft',
    currentPublishedVersion: undefined,
    publishedVersions: [],
  })
  let versionRow: Record<string, unknown> | undefined
  let queryPrefix: unknown
  const client = createClient(createDocumentClient((command) => {
    const key = command.input.Key as { recordKey?: string } | undefined
    if (key?.recordKey === 'FORM_ROOT#form-1') return { Item: root }
    const transaction = command.input.TransactItems as Array<{
      Put?: { Item?: Record<string, unknown> }
    }> | undefined
    if (transaction) {
      versionRow = transaction[0]?.Put?.Item
      root = transaction[1]?.Put?.Item as typeof root
      return {}
    }
    if (command.input.KeyConditionExpression) {
      const values = command.input.ExpressionAttributeValues as Record<string, unknown>
      queryPrefix = values[':prefix']
      return {
        Items: [root, versionRow].filter((item) => (
          item && typeof item.recordKey === 'string' && item.recordKey.startsWith(String(queryPrefix))
        )),
      }
    }
    throw new Error(`Unexpected command: ${JSON.stringify(command.input)}`)
  }))

  await client.publishForm(
    'workspace-1',
    'form-1',
    { id: 'admin@example.com' },
    { expectedRevision: 1 },
  )
  const result = await client.listForms('workspace-1')

  expect(queryPrefix).toBe('FORM_ROOT#')
  expect(versionRow?.recordKey).toBe('FORM_VERSION#form-1#VERSION#000001')
  expect(result.forms).toHaveLength(1)
  expect(result.forms[0]).toMatchObject({
    id: 'form-1',
    status: 'published',
    currentPublishedVersion: 1,
  })
})

test('rejects invalid form status and masks non-conditional store failures', async () => {
  const current = createStoredForm({ status: 'draft' })
  const invalidStatusClient = createClient(createDocumentClient((command) => {
    if (command.input.Key) return { Item: current }
    return {}
  }))
  await expect(invalidStatusClient.updateForm(
    'workspace-1',
    'form-1',
    { id: 'admin@example.com' },
    { expectedRevision: 1, status: 'published' } as never,
  )).rejects.toMatchObject({ code: 'InvalidRequestIntakeInput', status: 400 })

  const unavailableClient = createClient(createDocumentClient((command) => {
    if (command.input.Key) return { Item: current }
    throw Object.assign(new Error('sensitive upstream detail'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ProvisionedThroughputExceeded' }],
      $metadata: { httpStatusCode: 400 },
    })
  }))
  await expect(unavailableClient.publishForm(
    'workspace-1',
    'form-1',
    { id: 'admin@example.com' },
    { expectedRevision: 1 },
  )).rejects.toMatchObject({
    code: 'RequestIntakeUnavailable',
    message: 'Request intake storage is unavailable.',
    status: 503,
  })
})

test('returns an allowlisted public DTO without routing or storage keys', async () => {
  const form = createStoredForm()
  const version = createStoredVersion()
  const writes: FakeCommand[] = []
  const client = createClient(createDocumentClient((command) => {
    const key = command.input.Key as { recordKey?: string } | undefined
    if (key?.recordKey === 'FORM_ROOT#form-1') return { Item: form }
    if (key?.recordKey?.includes('#VERSION#')) return { Item: version }
    writes.push(command)
    return {}
  }), { token: () => sessionToken })

  const publicForm = await client.getPublicForm(resolution, { clientKey: 'client-1' })
  expect(publicForm).toEqual({
    schemaVersion: 1,
    formId: 'form-1',
    version: 1,
    accessMode: 'public',
    definition,
    submissionSession: {
      token: sessionToken,
      minimumSubmitAt: '2026-07-16T09:00:01.000Z',
      expiresAt: '2026-07-16T09:15:00.000Z',
    },
  })
  const publicJson = JSON.stringify(publicForm)
  expect(publicJson).not.toContain('routing')
  expect(publicJson).not.toContain('team-core')
  expect(publicJson).not.toContain('triage@example.com')
  expect(publicJson).not.toContain('scopeKey')
  const sessionWrite = writes.find((command) =>
    (command.input.Item as { entryType?: string } | undefined)?.entryType === 'submission-session'
  )
  expect(sessionWrite?.input.Item).toMatchObject({
    entryType: 'submission-session',
    formVersion: 1,
  })
})

test('atomically enforces client and link-global rate limits with isolated namespaces', async () => {
  const rateCounters = new Map<string, number>()
  const rateCommands: FakeCommand[] = []
  const form = createStoredForm()
  const version = createStoredVersion()
  const client = createClient(createDocumentClient((command) => {
    const key = command.input.Key as { recordKey?: string } | undefined
    if (key?.recordKey === 'FORM_ROOT#form-1') return { Item: form }
    if (key?.recordKey?.includes('#VERSION#')) return { Item: version }
    if ((command.input.Item as { entryType?: string } | undefined)?.entryType === 'submission-session') {
      return {}
    }
    throw new Error(`Unexpected command: ${JSON.stringify(command.input)}`)
  }, { rateCounters, rateCommands }), { rateLimitPerHour: 1 })
  const firstContext = { clientKey: 'link-global' }
  const firstClientKey = createExpectedRateScopeKey(
    resolution.tokenDigest,
    'form',
    'client',
    firstContext.clientKey,
  )
  const globalKey = createExpectedRateScopeKey(
    resolution.tokenDigest,
    'form',
    'link-global',
    'link-global',
  )

  expect(firstClientKey).not.toBe(globalKey)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await expect(client.getPublicForm(resolution, firstContext)).resolves.toMatchObject({
      formId: 'form-1',
    })
  }
  await expect(client.getPublicForm(resolution, firstContext)).rejects.toMatchObject({
    status: 429,
    code: 'RequestRateLimited',
  })
  expect(rateCounters.get(firstClientKey)).toBe(5)
  expect(rateCounters.get(globalKey)).toBe(5)

  for (let attempt = 0; attempt < 95; attempt += 1) {
    await client.getPublicForm(resolution, { clientKey: `rotating-client-${attempt}` })
  }
  const blockedClientKey = createExpectedRateScopeKey(
    resolution.tokenDigest,
    'form',
    'client',
    'new-client-after-global-limit',
  )
  await expect(client.getPublicForm(
    resolution,
    { clientKey: 'new-client-after-global-limit' },
  )).rejects.toMatchObject({ status: 429, code: 'RequestRateLimited' })
  expect(rateCounters.get(globalKey)).toBe(100)
  expect(rateCounters.has(blockedClientKey)).toBe(false)
  expect(rateCommands[0]?.input.TransactItems).toHaveLength(2)
  expect(JSON.stringify(rateCommands[0]?.input)).not.toContain(firstContext.clientKey)
})

test('rejects an invalid attachment session without consuming rate-limit quota', async () => {
  const rateCounters = new Map<string, number>()
  const rateCommands: FakeCommand[] = []
  const client = createClient(createDocumentClient(() => ({}), { rateCounters, rateCommands }))

  await expect(client.createAttachmentUpload(resolution, {
    sessionToken,
    fieldId: 'files',
    fileName: 'evidence.pdf',
    contentType: 'application/pdf',
    sizeBytes: 500,
  }, { clientKey: '203.0.113.10' })).rejects.toMatchObject({
    status: 409,
    code: 'RequestSessionUnavailable',
  })
  expect(rateCounters.size).toBe(0)
  expect(rateCommands).toEqual([])
})

test('masks non-conditional rate-limit transaction failures', async () => {
  const rateFailure = Object.assign(new Error('sensitive rate store failure'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'ProvisionedThroughputExceeded' }],
  })
  const client = createClient(createDocumentClient(() => ({}), { rateFailure }))

  await expect(client.getPublicForm(
    resolution,
    { clientKey: '203.0.113.10' },
  )).rejects.toMatchObject({
    status: 503,
    code: 'RequestIntakeUnavailable',
    message: 'Request intake storage is unavailable.',
  })
})

test('claims an attachment after submission session renewal without persisting the raw claim', async () => {
  const oldSessionToken = 'O'.repeat(43)
  const renewedSessionToken = 'N'.repeat(43)
  const claimToken = 'C'.repeat(43)
  const attachmentDraft = cloneDraft()
  attachmentDraft.definition.sections[0]!.fields.push({
    id: 'files',
    type: 'attachment',
    label: { ja: '添付', en: 'Attachments' },
  })
  attachmentDraft.definition.attachments = {
    enabled: true,
    maxFiles: 2,
    maxSizeBytes: 1_000,
    allowedMediaTypes: ['application/pdf'],
  }
  const version = createStoredVersion(1, attachmentDraft)
  const createSession = (token: string) => ({
    entryType: 'submission-session',
    scopeKey: `SESSION#${createHmac('sha256', tokenHashSecret).update(`session\0${token}`).digest('hex')}`,
    recordKey: 'LOOKUP',
    workspaceId: 'workspace-1',
    formId: 'form-1',
    formVersion: 1,
    linkDigest: resolution.tokenDigest,
    minimumSubmitAt: '2026-07-16T08:59:00.000Z',
    expiresAtIso: '2026-07-16T09:15:00.000Z',
    expiresAt: Math.floor(Date.parse('2026-07-16T09:15:00.000Z') / 1_000),
  })
  const oldSession = createSession(oldSessionToken)
  const renewedSession = createSession(renewedSessionToken)
  let storedUpload: Record<string, unknown> | undefined
  let transaction: Array<{
    Put?: { Item?: Record<string, unknown> }
    Update?: { ExpressionAttributeValues?: Record<string, unknown> }
  }> | undefined
  const generatedTokens = [claimToken, threadToken]
  const client = createClient(createDocumentClient((command) => {
    if (command.input.TransactItems) {
      transaction = command.input.TransactItems as typeof transaction
      return {}
    }
    if (command.input.ReturnValues === 'UPDATED_NEW') {
      return { Attributes: { count: 1 } }
    }
    const item = command.input.Item as Record<string, unknown> | undefined
    if (item?.entryType === 'attachment-upload') {
      storedUpload = item
      return {}
    }
    if (command.input.UpdateExpression) return {}
    const key = command.input.Key as { scopeKey?: string; recordKey?: string } | undefined
    if (key?.scopeKey === oldSession.scopeKey) return { Item: oldSession }
    if (key?.scopeKey === renewedSession.scopeKey) return { Item: renewedSession }
    if (key?.recordKey?.includes('#VERSION#')) return { Item: version }
    if (key?.recordKey?.startsWith('UPLOAD#')) return { Item: storedUpload }
    if (key?.scopeKey?.startsWith('DUPLICATE#')) return {}
    throw new Error(`Unexpected command: ${JSON.stringify(command.input)}`)
  }), {
    token: () => generatedTokens.shift() ?? threadToken,
  })

  const upload = await client.createAttachmentUpload(resolution, {
    sessionToken: oldSessionToken,
    fieldId: 'files',
    fileName: 'evidence.pdf',
    contentType: 'application/pdf',
    sizeBytes: 500,
  }, { clientKey: 'client-1' })
  expect(upload.claimToken).toBe(claimToken)
  expect(storedUpload).toMatchObject({
    attachmentId: upload.attachmentId,
    sessionDigest: oldSession.scopeKey.slice('SESSION#'.length),
    claimDigest: createHmac('sha256', tokenHashSecret)
      .update(`attachment-claim\0${claimToken}`)
      .digest('hex'),
  })
  expect(JSON.stringify(storedUpload)).not.toContain(claimToken)

  const answers = {
    category: 'general',
    title: 'Alpha request',
    estimate: 10,
    email: 'requester@example.com',
    files: [upload.attachmentId],
  }
  await expect(client.submit(resolution, {
    sessionToken: renewedSessionToken,
    locale: 'ja',
    answers,
    attachmentClaims: { [upload.attachmentId]: 'X'.repeat(43) },
    consentAccepted: true,
  }, { clientKey: 'client-1' })).rejects.toMatchObject({
    status: 400,
    code: 'InvalidRequestIntakeInput',
  })

  await expect(client.submit(resolution, {
    sessionToken: renewedSessionToken,
    locale: 'ja',
    answers,
    attachmentClaims: { [upload.attachmentId]: claimToken },
    consentAccepted: true,
  }, { clientKey: 'client-1' })).resolves.toMatchObject({
    confirmationMessage: '受け付けました。',
  })
  expect(transaction?.[0]?.Put?.Item).toMatchObject({
    answers: { files: [upload.attachmentId] },
  })
  expect(JSON.stringify(transaction)).not.toContain(claimToken)
  expect(transaction?.at(-1)?.Update?.ExpressionAttributeValues).toMatchObject({
    ':claimDigest': storedUpload?.claimDigest,
  })
})

test('rate limits an unused submission session and hashes the external client key', async () => {
  const rateCounters = new Map<string, number>()
  const rateCommands: FakeCommand[] = []
  const session = {
    entryType: 'submission-session',
    scopeKey: `SESSION#${createHmac('sha256', tokenHashSecret).update(`session\0${sessionToken}`).digest('hex')}`,
    recordKey: 'LOOKUP',
    workspaceId: 'workspace-1',
    formId: 'form-1',
    formVersion: 1,
    linkDigest: resolution.tokenDigest,
    minimumSubmitAt: '2026-07-16T08:59:00.000Z',
    expiresAtIso: '2026-07-16T09:15:00.000Z',
    expiresAt: 1_784_193_300,
  }
  const version = createStoredVersion()
  const client = createClient(createDocumentClient((command) => {
    const key = command.input.Key as { scopeKey?: string; recordKey?: string } | undefined
    if (key?.scopeKey === session.scopeKey) return { Item: session }
    if (key?.recordKey?.includes('#VERSION#')) return { Item: version }
    throw new Error(`Unexpected command: ${JSON.stringify(command.input)}`)
  }, { rateCounters, rateCommands }), { rateLimitPerHour: 1 })
  const context = { clientKey: '203.0.113.10' }

  await expect(client.submit(
    resolution,
    { sessionToken, locale: 'ja', answers: {}, consentAccepted: true },
    context,
  )).rejects.toMatchObject({ status: 400, code: 'InvalidRequestIntakeInput' })
  await expect(client.submit(
    resolution,
    { sessionToken, locale: 'ja', answers: {}, consentAccepted: true },
    context,
  )).rejects.toMatchObject({ status: 429, code: 'RequestRateLimited' })
  const clientKey = createExpectedRateScopeKey(
    resolution.tokenDigest,
    'submit',
    'client',
    context.clientKey,
  )
  const globalKey = createExpectedRateScopeKey(
    resolution.tokenDigest,
    'submit',
    'link-global',
    'link-global',
  )
  expect(rateCounters.get(clientKey)).toBe(1)
  expect(rateCounters.get(globalKey)).toBe(1)
  expect(rateCommands).toHaveLength(2)
  expect(JSON.stringify(rateCommands)).not.toContain(context.clientKey)
})

test('fixes submission history to the session version and replays only an identical payload', async () => {
  const sessionDigest = createHmac('sha256', tokenHashSecret)
    .update(`session\0${sessionToken}`)
    .digest('hex')
  const session: Record<string, unknown> = {
    entryType: 'submission-session',
    scopeKey: `SESSION#${sessionDigest}`,
    recordKey: 'LOOKUP',
    workspaceId: 'workspace-1',
    formId: 'form-1',
    formVersion: 1,
    linkDigest: resolution.tokenDigest,
    minimumSubmitAt: '2026-07-16T08:59:00.000Z',
    expiresAtIso: '2026-07-16T09:15:00.000Z',
    expiresAt: Math.floor(Date.parse('2026-07-16T09:15:00.000Z') / 1_000),
  }
  const version = createStoredVersion()
  let submissionItem: Record<string, unknown> | undefined
  const client = createClient(createDocumentClient((command) => {
    const key = command.input.Key as { scopeKey?: string; recordKey?: string } | undefined
    if (key?.scopeKey === session.scopeKey) return { Item: session }
    if (key?.recordKey?.includes('#VERSION#')) return { Item: version }
    if (key?.recordKey?.startsWith('SUBMISSION#')) return { Item: submissionItem }
    if (key?.scopeKey?.startsWith('DUPLICATE#')) return {}
    const transactItems = command.input.TransactItems as Array<{
      Put?: { Item?: Record<string, unknown> }
      Update?: { ExpressionAttributeValues?: Record<string, unknown> }
    }> | undefined
    if (transactItems) {
      submissionItem = transactItems[0]?.Put?.Item
      const values = transactItems[1]?.Update?.ExpressionAttributeValues ?? {}
      session.usedAt = values[':usedAt']
      session.inputFingerprint = values[':fingerprint']
      session.receipt = values[':receipt']
      return {}
    }
    throw new Error(`Unexpected command: ${JSON.stringify(command.input)}`)
  }), { token: () => threadToken })
  const input = {
    sessionToken,
    locale: 'ja',
    answers: {
      category: 'general',
      title: 'Alpha request',
      estimate: 10,
      email: 'requester@example.com',
    },
    consentAccepted: true,
  } satisfies SubmitRequestInput

  await expect(client.submit(
    resolution,
    { ...input, consentAccepted: false },
    { clientKey: 'client-1' },
  )).rejects.toThrow('Consent is required')

  const first = await client.submit(resolution, input, { clientKey: 'client-1' })
  const replay = await client.submit(resolution, input, { clientKey: 'client-1' })
  expect(replay).toEqual(first)
  for (let replayAttempt = 0; replayAttempt < 4; replayAttempt += 1) {
    await expect(client.submit(resolution, input, { clientKey: 'client-1' })).resolves.toEqual(first)
  }
  await expect(client.submit(
    resolution,
    input,
    { clientKey: 'client-1' },
  )).rejects.toMatchObject({ status: 429, code: 'RequestRateLimited' })
  expect(submissionItem).toMatchObject({
    formVersion: 1,
    formSnapshot: { version: 1, snapshot: draft },
    routingTarget: routing.defaultTarget,
    workItemMapping: routing.mapping,
  })
  expect(JSON.stringify(submissionItem?.formSnapshot)).not.toContain('scopeKey')
  expect(JSON.stringify(submissionItem?.formSnapshot)).not.toContain('recordKey')
  expect(JSON.stringify(submissionItem?.formSnapshot)).not.toContain('entryType')
  await expect(client.submit(
    resolution,
    {
      ...input,
      answers: { ...input.answers, title: 'Another request' },
    },
    { clientKey: 'client-1' },
  )).rejects.toMatchObject({ status: 409, code: 'RequestSessionConsumed' })
})

test('applies explicit triage transitions and rejects mutation after a terminal state', async () => {
  let stored = createStoredSubmission()
  const puts: Record<string, unknown>[] = []
  const client = createClient(createDocumentClient((command) => {
    if (command.input.Key) return { Item: stored }
    if (command.input.Item) {
      stored = command.input.Item as RequestSubmission & Record<string, unknown>
      puts.push(stored)
      return {}
    }
    throw new Error(`Unexpected command: ${JSON.stringify(command.input)}`)
  }))

  const assigned = await client.applyAction(
    'workspace-1',
    'req-1',
    { id: 'manager@example.com' },
    { action: 'assign', expectedRevision: 1, assigneeUserId: 'TRIAGER@example.com' },
  )
  expect(assigned).toMatchObject({
    status: 'triaging',
    revision: 2,
    triageAssigneeUserId: 'triager@example.com',
  })

  const waiting = await client.applyAction(
    'workspace-1',
    'req-1',
    { id: 'manager@example.com' },
    { action: 'request-more-info', expectedRevision: 2, message: 'Please add an order number.' },
  )
  expect(waiting).toMatchObject({ status: 'needs-more-info', revision: 3 })
  expect(waiting.messages.at(-1)).toMatchObject({
    direction: 'internal',
    source: 'internal',
    body: 'Please add an order number.',
  })

  const rejected = await client.applyAction(
    'workspace-1',
    'req-1',
    { id: 'manager@example.com' },
    { action: 'reject', expectedRevision: 3, reason: 'Out of scope.' },
  )
  expect(rejected).toMatchObject({
    status: 'rejected',
    revision: 4,
    capabilities: {
      canAssign: false,
      canRequestMoreInfo: false,
      canReject: false,
      canMarkDuplicate: false,
      canConvert: false,
    },
  })
  expect(rejected.events.at(-1)?.summary).toBe('Request was rejected: Out of scope.')
  await expect(client.applyAction(
    'workspace-1',
    'req-1',
    { id: 'manager@example.com' },
    { action: 'assign', expectedRevision: 4, assigneeUserId: 'other@example.com' },
  )).rejects.toMatchObject({ status: 409, code: 'RequestSubmissionTerminal' })
  expect(puts).toHaveLength(3)
})

test('rejects an unknown triage discriminator instead of treating it as a duplicate', async () => {
  const client = createClient(createDocumentClient((command) => {
    if (command.input.Key) return { Item: createStoredSubmission() }
    throw new Error(`Unexpected command: ${JSON.stringify(command.input)}`)
  }))

  await expect(client.applyAction(
    'workspace-1',
    'req-1',
    { id: 'manager@example.com' },
    { action: 'unknown', expectedRevision: 1 } as never,
  )).rejects.toMatchObject({ code: 'InvalidRequestIntakeInput', status: 400 })
})

test('makes Work Item conversion completion idempotent for the same trace target', async () => {
  let stored = createStoredSubmission()
  let putCount = 0
  const client = createClient(createDocumentClient((command) => {
    if (command.input.Key) return { Item: stored }
    if (command.input.Item) {
      stored = command.input.Item as RequestSubmission & Record<string, unknown>
      putCount += 1
      return {}
    }
    return {}
  }))
  const projection = {
    expectedRevision: 1,
    workItem: { teamId: 'team-core', projectId: 'project-urgent', workItemId: 'wi-1' },
  }
  const converted = await client.completeConversion(
    'workspace-1',
    'req-1',
    { id: 'manager@example.com' },
    projection,
  )
  const replay = await client.completeConversion(
    'workspace-1',
    'req-1',
    { id: 'manager@example.com' },
    projection,
  )
  expect(converted).toMatchObject({ status: 'converted', revision: 2, workItem: projection.workItem })
  expect(replay).toEqual(converted)
  expect(putCount).toBe(1)
})

test('exposes staff requests through an allowlisted requester thread view', async () => {
  const expectedDigest = createHmac('sha256', tokenHashSecret)
    .update(`thread\0${threadToken}`)
    .digest('hex')
  const stored = createStoredSubmission({
    status: 'needs-more-info',
    messages: [
      {
        id: 'staff-message',
        direction: 'internal',
        source: 'internal',
        body: 'Please add an order number.',
        createdAt: now.toISOString(),
      },
    ],
  })
  const client = createClient(createDocumentClient((command) => {
    if (command.input.UpdateExpression && command.input.ReturnValues === 'UPDATED_NEW') {
      return { Attributes: { count: 1 } }
    }
    const key = command.input.Key as { scopeKey?: string; recordKey?: string } | undefined
    if (key?.scopeKey === `THREAD#${expectedDigest}`) {
      return { Item: {
        entryType: 'thread-lookup',
        scopeKey: key.scopeKey,
        recordKey: 'LOOKUP',
        workspaceId: 'workspace-1',
        submissionId: 'req-1',
        expiresAt: 1_815_897_600,
      } }
    }
    if (key?.recordKey === 'SUBMISSION#req-1') return { Item: stored }
    throw new Error(`Unexpected command: ${JSON.stringify(command.input)}`)
  }))

  await expect(client.getRequesterThread(
    threadToken,
    { clientKey: 'client-1' },
  )).resolves.toEqual({
    status: 'open',
    messages: [{
      id: 'staff-message',
      direction: 'staff',
      body: 'Please add an order number.',
      createdAt: now.toISOString(),
    }],
    updatedAt: stored.updatedAt,
  })
})

test('validates thread capabilities before rate writes and caps idempotency receipt reads', async () => {
  const expectedDigest = createHmac('sha256', tokenHashSecret)
    .update(`thread\0${threadToken}`)
    .digest('hex')
  const context = { clientKey: '203.0.113.10', idempotencyKey: 'random-reply-key' }
  const readClientKey = createExpectedRateScopeKey(
    expectedDigest,
    'thread',
    'client',
    context.clientKey,
  )
  const readGlobalKey = createExpectedRateScopeKey(
    expectedDigest,
    'thread',
    'thread-global',
    'thread-global',
  )
  const replyClientKey = createExpectedRateScopeKey(
    expectedDigest,
    'submit',
    'client',
    context.clientKey,
  )
  const replyGlobalKey = createExpectedRateScopeKey(
    expectedDigest,
    'submit',
    'thread-global',
    'thread-global',
  )
  const rateCounters = new Map<string, number>([
    [readClientKey, 10],
    [readGlobalKey, 3],
    [replyClientKey, 5],
    [replyGlobalKey, 2],
  ])
  const rateCommands: FakeCommand[] = []
  let lookupCount = 0
  let replyReceiptReadCount = 0
  const client = createClient(createDocumentClient((command) => {
    const key = command.input.Key as { scopeKey?: string } | undefined
    if (key?.scopeKey === `THREAD#${expectedDigest}`) {
      lookupCount += 1
      return { Item: {
        entryType: 'thread-lookup',
        scopeKey: key.scopeKey,
        recordKey: 'LOOKUP',
        workspaceId: 'workspace-1',
        submissionId: 'req-1',
        expiresAt: 1_815_897_600,
      } }
    }
    if (key?.scopeKey?.startsWith('REPLY#')) {
      replyReceiptReadCount += 1
      return {}
    }
    if (key?.scopeKey?.startsWith('THREAD#')) return {}
    throw new Error(`Unexpected command: ${JSON.stringify(command.input)}`)
  }, { rateCounters, rateCommands }), { rateLimitPerHour: 1 })

  await expect(client.getRequesterThread('X'.repeat(43), context)).rejects.toMatchObject({
    status: 404,
    code: 'RequestThreadUnavailable',
  })
  expect(rateCommands).toEqual([])
  await expect(client.getRequesterThread(threadToken, context)).rejects.toMatchObject({
    status: 429,
    code: 'RequestRateLimited',
  })
  await expect(client.replyToThread(
    threadToken,
    { body: 'Additional information.' },
    context,
  )).rejects.toMatchObject({ status: 429, code: 'RequestRateLimited' })

  expect(lookupCount).toBe(2)
  expect(replyReceiptReadCount).toBe(0)
  expect(rateCounters.get(readGlobalKey)).toBe(3)
  expect(rateCounters.get(replyGlobalKey)).toBe(2)
  expect(rateCommands).toHaveLength(2)
})

test('hashes requester thread tokens and appends a web reply to an open request', async () => {
  const expectedDigest = createHmac('sha256', tokenHashSecret)
    .update(`thread\0${threadToken}`)
    .digest('hex')
  let stored = createStoredSubmission({ status: 'needs-more-info' })
  let replyReceipt: Record<string, unknown> | undefined
  const commands: FakeCommand[] = []
  const client = createClient(createDocumentClient((command) => {
    commands.push(command)
    const key = command.input.Key as { scopeKey?: string; recordKey?: string } | undefined
    if (key?.scopeKey === `THREAD#${expectedDigest}`) {
      return { Item: {
        entryType: 'thread-lookup',
        scopeKey: key.scopeKey,
        recordKey: 'LOOKUP',
        workspaceId: 'workspace-1',
        submissionId: 'req-1',
        expiresAt: 1_815_897_600,
        requesterEmail: 'requester@example.com',
      } }
    }
    if (key?.scopeKey?.startsWith('REPLY#')) return replyReceipt ? { Item: replyReceipt } : {}
    if (command.input.UpdateExpression && command.input.ReturnValues === 'UPDATED_NEW') {
      return { Attributes: { count: 1 } }
    }
    if (key?.recordKey === 'SUBMISSION#req-1') return { Item: stored }
    const items = command.input.TransactItems as Array<{ Put?: { Item?: Record<string, unknown> } }> | undefined
    if (items) {
      stored = items[0]!.Put!.Item as RequestSubmission & Record<string, unknown>
      replyReceipt = items[1]?.Put?.Item
      return {}
    }
    throw new Error(`Unexpected command: ${JSON.stringify(command.input)}`)
  }))

  const receipt = await client.replyToThread(
    threadToken,
    { body: 'The order number is 12345.' },
    { clientKey: 'client-1', idempotencyKey: 'reply-attempt-1' },
  )
  expect(receipt).toMatchObject({ receivedAt: now.toISOString() })
  expect(stored).toMatchObject({ status: 'triaging', revision: 2 })
  expect((stored.messages as Array<Record<string, unknown>>).at(-1)).toMatchObject({
    direction: 'requester',
    source: 'web',
    body: 'The order number is 12345.',
  })
  expect(commands[0]?.input.Key).toEqual({
    scopeKey: `THREAD#${expectedDigest}`,
    recordKey: 'LOOKUP',
  })
  expect(JSON.stringify(commands[0]?.input)).not.toContain(threadToken)
  await expect(client.replyToThread(
    threadToken,
    { body: 'The order number is 12345.' },
    { clientKey: 'client-1', idempotencyKey: 'reply-attempt-1' },
  )).resolves.toEqual(receipt)
  await expect(client.replyToThread(
    threadToken,
    { body: 'Changed body.' },
    { clientKey: 'client-1', idempotencyKey: 'reply-attempt-1' },
  )).rejects.toMatchObject({ status: 409, code: 'RequestIdempotencyConflict' })
  expect(stored).toMatchObject({ revision: 2 })
})

test('binds email replies to the original sender and deduplicates Message-ID', async () => {
  const threadDigest = createHmac('sha256', tokenHashSecret)
    .update(`thread\0${threadToken}`)
    .digest('hex')
  let stored = createStoredSubmission({ status: 'needs-more-info' })
  let emailReceipt: Record<string, unknown> | undefined
  let transactionCount = 0
  const client = createClient(createDocumentClient((command) => {
    const key = command.input.Key as { scopeKey?: string; recordKey?: string } | undefined
    if (key?.scopeKey === `THREAD#${threadDigest}`) {
      return { Item: {
        entryType: 'thread-lookup',
        scopeKey: key.scopeKey,
        recordKey: 'LOOKUP',
        workspaceId: 'workspace-1',
        submissionId: 'req-1',
        expiresAt: 1_815_897_600,
        requesterEmail: 'requester@example.com',
      } }
    }
    if (key?.scopeKey?.startsWith('EMAIL#')) return emailReceipt ? { Item: emailReceipt } : {}
    if (key?.recordKey === 'SUBMISSION#req-1') return { Item: stored }
    const items = command.input.TransactItems as Array<{ Put?: { Item?: Record<string, unknown> } }> | undefined
    if (items) {
      transactionCount += 1
      stored = items[0]!.Put!.Item as RequestSubmission & Record<string, unknown>
      emailReceipt = items[1]!.Put!.Item
      return {}
    }
    throw new Error(`Unexpected command: ${JSON.stringify(command.input)}`)
  }))
  const envelope = {
    threadToken,
    messageId: '<message-1@example.com>',
    fromAddress: 'requester@example.com',
    subject: 'Re: more information',
    textBody: 'The order number is 12345.',
    receivedAt: now.toISOString(),
  }

  await expect(client.ingestEmail({
    ...envelope,
    fromAddress: 'attacker@example.com',
  })).rejects.toMatchObject({ status: 403, code: 'RequestEmailSenderDenied' })
  const first = await client.ingestEmail(envelope)
  const replay = await client.ingestEmail({ ...envelope, textBody: 'Changed replay body.' })
  expect(replay).toEqual(first)
  expect(transactionCount).toBe(1)
  expect((stored.messages as Array<Record<string, unknown>>).at(-1)).toMatchObject({
    direction: 'requester',
    source: 'email',
    body: 'The order number is 12345.',
  })
})

test('gates request attachment access on the current malware scan result', async () => {
  const attachmentSubmission = createStoredSubmission({
    attachments: [{
      id: 'attachment-1',
      fieldId: 'files',
      fileName: 'evidence.pdf',
      contentType: 'application/pdf',
      sizeBytes: 100,
      scanStatus: 'pending',
    }],
    attachmentObjectKeys: { 'attachment-1': 'private/evidence.pdf' },
    attachmentObjectVersionIds: { 'attachment-1': 'version-1' },
  })
  let scanStatus: 'pending' | 'available' = 'pending'
  let markedCompleted = 0
  let accessCalls = 0
  const objectClient = createObjectClient({
    async getScanStatus() {
      return scanStatus
    },
    async markCompleted() {
      markedCompleted += 1
    },
    async createAccess() {
      accessCalls += 1
      return {
        url: 'https://download.example.com/evidence',
        expiresAt: '2026-07-16T09:05:00.000Z',
      }
    },
  })
  const client = createClient(createDocumentClient(() => ({ Item: attachmentSubmission })), {
    objectClient,
  })

  await expect(client.createAttachmentAccess(
    'workspace-1',
    'req-1',
    'attachment-1',
  )).rejects.toMatchObject({ status: 409, code: 'RequestAttachmentUnavailable' })
  expect(markedCompleted).toBe(0)
  expect(accessCalls).toBe(0)

  scanStatus = 'available'
  const refreshed = await client.getSubmission('workspace-1', 'req-1')
  expect(refreshed.attachments[0]?.scanStatus).toBe('available')
  expect(markedCompleted).toBe(1)
  attachmentSubmission.attachments[0]!.scanStatus = 'available'
  await client.getSubmission('workspace-1', 'req-1')
  expect(markedCompleted).toBe(2)
  await expect(client.createAttachmentAccess(
    'workspace-1',
    'req-1',
    'attachment-1',
  )).resolves.toEqual({
    url: 'https://download.example.com/evidence',
    expiresAt: '2026-07-16T09:05:00.000Z',
  })
  expect(markedCompleted).toBe(3)
  expect(accessCalls).toBe(1)
})
