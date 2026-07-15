import { expect, test } from 'bun:test'
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { WorkItemConfiguration } from '@mukuroji/contracts'
import {
  DEFAULT_WORK_ITEM_CONFIGURATION,
  DynamoDbWorkItemConfigurationClient,
  WorkItemConfigurationError,
  assertWorkflowTransitionAllowed,
  createWorkItemConfigurationScopeKey,
  createWorkItemConfigurationGuardConditionChecks,
  createWorkItemRelationIds,
  isCanonicalWorkItemRelationIds,
  normalizeCustomFieldValues,
  resolveWorkflowStatus,
  validateWorkItemConfiguration,
} from './work-item-configuration'

test('validates the built-in workflow and resolves configured statuses', () => {
  const configuration = validateWorkItemConfiguration(DEFAULT_WORK_ITEM_CONFIGURATION)

  expect(configuration.workflow.statuses.map((status) => status.id)).toEqual([
    'todo',
    'in-progress',
    'review',
    'done',
  ])
  expect(resolveWorkflowStatus(configuration, 'done')).toEqual({
    workflowStatusId: 'done',
    statusCategory: 'completed',
  })
})

test('encodes configuration scope key components before adding delimiters', () => {
  expect(createWorkItemConfigurationScopeKey(
    'workspace#owner@example.com',
    'team',
    'team#one',
  )).toBe('workspace%23owner%40example.com#team#team%23one#work-item-configuration')
})

test('rejects duplicate status IDs and broken transition references', () => {
  expect(() => validateWorkItemConfiguration({
    ...DEFAULT_WORK_ITEM_CONFIGURATION,
    workflow: {
      ...DEFAULT_WORK_ITEM_CONFIGURATION.workflow,
      statuses: [
        DEFAULT_WORK_ITEM_CONFIGURATION.workflow.statuses[0],
        DEFAULT_WORK_ITEM_CONFIGURATION.workflow.statuses[0],
      ],
    },
  })).toThrow('Workflow status ID must be unique.')

  expect(() => validateWorkItemConfiguration({
    ...DEFAULT_WORK_ITEM_CONFIGURATION,
    workflow: {
      ...DEFAULT_WORK_ITEM_CONFIGURATION.workflow,
      transitions: [{ fromStatusId: 'todo', toStatusId: 'missing' }],
    },
  })).toThrow('Workflow transition references an invalid status.')
})

test('enforces allowed workflow transitions', () => {
  const configuration = createConfiguration({
    workflow: {
      ...DEFAULT_WORK_ITEM_CONFIGURATION.workflow,
      transitions: [{ fromStatusId: 'todo', toStatusId: 'in-progress' }],
    },
  })

  expect(() => assertWorkflowTransitionAllowed(configuration, 'todo', 'in-progress')).not.toThrow()
  expect(() => assertWorkflowTransitionAllowed(configuration, 'todo', 'done')).toThrow(
    'Transition from "todo" to "done" is not allowed.',
  )
})

test('normalizes every stored custom field type and evaluates formulas', () => {
  const configuration = createConfiguration({
    customFields: [
      field('text', 'text', { required: true, validation: { minLength: 2 } }),
      field('number', 'number', { validation: { min: 0, max: 10 } }),
      field('boolean', 'boolean'),
      field('date', 'date'),
      field('select', 'select', { options: options('one', 'two') }),
      field('multi', 'multi-select', { options: options('one', 'two') }),
      field('person', 'person'),
      field('currency', 'currency', { currencyCode: 'JPY' }),
      field('duration', 'duration', { durationUnit: 'hours' }),
      field('formula', 'formula', { formulaExpression: '{number} * 2 + {duration}' }),
    ],
  })

  const values = normalizeCustomFieldValues(configuration, {
    text: 'ready',
    number: 4,
    boolean: true,
    date: '2026-07-12',
    select: 'one',
    multi: ['two', 'one'],
    person: 'member@example.com',
    currency: 1200,
    duration: 3,
  }, { mode: 'create' })

  expect(values).toEqual({
    text: 'ready',
    number: 4,
    boolean: true,
    date: '2026-07-12',
    select: 'one',
    multi: ['one', 'two'],
    person: 'member@example.com',
    currency: 1200,
    duration: 3,
    formula: 11,
  })
})

test('evaluates transitive formulas by dependency instead of display order', () => {
  const configuration = createConfiguration({
    customFields: [
      field('total', 'formula', { formulaExpression: '{subtotal} + 1', sortOrder: 0 }),
      field('subtotal', 'formula', { formulaExpression: '{amount} * 2', sortOrder: 1 }),
      field('amount', 'number', { sortOrder: 2 }),
    ],
  })

  expect(normalizeCustomFieldValues(
    configuration,
    { amount: 3 },
    { mode: 'create' },
  )).toEqual({ amount: 3, subtotal: 6, total: 7 })
})

test('validates formula syntax without evaluating fixed mock values', () => {
  const configuration = createConfiguration({
    customFields: [
      field('count', 'number'),
      field('sample', 'formula', { formulaExpression: '{count} / ({count} - 1)' }),
    ],
  })

  expect(normalizeCustomFieldValues(
    configuration,
    { count: 2 },
    { mode: 'create' },
  )).toEqual({ count: 2, sample: 2 })
  expectConfigurationError(
    () => normalizeCustomFieldValues(configuration, { count: 1 }, { mode: 'create' }),
    'InvalidCustomFieldValue',
    'Formula cannot divide by zero.',
  )
})

test('rejects statically invalid formula arithmetic at definition time', () => {
  expectConfigurationError(
    () => createConfiguration({
      customFields: [field('formula', 'formula', { formulaExpression: '1 / 0' })],
    }),
    'InvalidWorkItemConfiguration',
    'Formula cannot divide by zero.',
  )
  expectConfigurationError(
    () => createConfiguration({
      customFields: [
        field('count', 'number'),
        field('formula', 'formula', { formulaExpression: '1 / (0 * {count})' }),
      ],
    }),
    'InvalidWorkItemConfiguration',
    'Formula cannot divide by zero.',
  )
  expectConfigurationError(
    () => createConfiguration({
      customFields: [field('formula', 'formula', { formulaExpression: '9'.repeat(400) })],
    }),
    'InvalidWorkItemConfiguration',
    'Formula result is invalid.',
  )
})

test('applies defaults only on create and does not resurrect removed values on update', () => {
  const configuration = createConfiguration({
    customFields: [field('required', 'text', { required: true, defaultValue: 'default' })],
  })

  expect(normalizeCustomFieldValues(configuration, undefined, { mode: 'create' })).toEqual({
    required: 'default',
  })
  expect(() => normalizeCustomFieldValues(configuration, {}, { mode: 'update' }))
    .toThrow('is required')
})

test('revalidates stored values against the current definition before an unrelated update', () => {
  const configuration = createConfiguration({
    customFields: [field('amount', 'number')],
  })

  expect(() => normalizeCustomFieldValues(
    configuration,
    {},
    {
      existingValues: { amount: 'not-a-number' },
      mode: 'update',
    },
  )).toThrow('must be a finite number')
})

test('rejects invalid options, dates, ranges, and client formula values', () => {
  const configuration = createConfiguration({
    customFields: [
      field('choice', 'select', { options: options('one') }),
      field('date', 'date'),
      field('amount', 'number', { validation: { min: 1, max: 2 } }),
      field('formula', 'formula', { formulaExpression: '{amount} + 1' }),
    ],
  })

  expect(() => normalizeCustomFieldValues(configuration, { choice: 'missing' }, { mode: 'create' }))
    .toThrow('contains an invalid option')
  expect(() => normalizeCustomFieldValues(configuration, { date: '2026-02-30' }, { mode: 'create' }))
    .toThrow('must be an ISO date')
  expect(() => normalizeCustomFieldValues(configuration, { amount: 3 }, { mode: 'create' }))
    .toThrow('exceeds its maximum')
  expect(() => normalizeCustomFieldValues(configuration, { formula: 3 }, { mode: 'create' }))
    .toThrow('is read-only')
})

test('rejects formula dependency cycles and unsupported syntax', () => {
  expect(() => createConfiguration({
    customFields: [
      field('first', 'formula', { formulaExpression: '{second} + 1' }),
      field('second', 'formula', { formulaExpression: '{first} + 1' }),
    ],
  })).toThrow('Formula dependency cycle')

  expectConfigurationError(
    () => createConfiguration({
      customFields: [
        field('amount', 'number'),
        field('formula', 'formula', { formulaExpression: 'Math.max({amount}, 1)' }),
      ],
    }),
    'InvalidWorkItemConfiguration',
    'Formula contains unsupported syntax.',
  )

  expectConfigurationError(
    () => createConfiguration({
      customFields: [
        field('amount', 'number'),
        field('formula', 'formula', { formulaExpression: '{amount} +' }),
      ],
    }),
    'InvalidWorkItemConfiguration',
    'Formula expression is invalid.',
  )

  expect(() => createConfiguration({
    customFields: [
      field('title', 'text'),
      field('formula', 'formula', { formulaExpression: '{title} + 1' }),
    ],
  })).toThrow('references non-numeric field')

  expect(() => createConfiguration({
    customFields: [
      field('amount', 'number', { projectIds: ['project-a'] }),
      field('formula', 'formula', { formulaExpression: '{amount} + 1' }),
    ],
  })).toThrow('reference "amount" is unavailable')
})

test('rejects empty required values, control characters, and duplicate multi-select options', () => {
  const configuration = createConfiguration({
    customFields: [
      field('summary', 'text', { required: true }),
      field('labels', 'multi-select', {
        options: [
          { id: 'alpha', name: 'Alpha', sortOrder: 0 },
          { id: 'beta', name: 'Beta', sortOrder: 1 },
        ],
      }),
    ],
  })

  expect(() => normalizeCustomFieldValues(
    configuration,
    { summary: '   ' },
    { mode: 'create' },
  )).toThrow('is required')
  expect(() => normalizeCustomFieldValues(
    configuration,
    { summary: 'unsafe\u0000value' },
    { mode: 'create' },
  )).toThrow('control characters')
  expect(() => normalizeCustomFieldValues(
    configuration,
    { labels: ['alpha', 'alpha'], summary: 'Ready' },
    { mode: 'create' },
  )).toThrow('duplicate options')

  const durationConfiguration = createConfiguration({
    customFields: [field('duration', 'duration', { durationUnit: 'hours' })],
  })
  expect(() => normalizeCustomFieldValues(
    durationConfiguration,
    { duration: -1 },
    { mode: 'create' },
  )).toThrow('cannot be negative')
})

test('rejects unsafe patterns and currency values beyond their minor-unit precision', () => {
  expect(() => createConfiguration({
    customFields: [field('text', 'text', { validation: { pattern: '(a+)+' } })],
  })).toThrow('unsafe repeated expressions')
  expect(() => createConfiguration({
    customFields: [field('text', 'text', { validation: { pattern: '^a*a*a*a*a*b$' } })],
  })).toThrow('unsafe repeated expressions')
  expect(() => createConfiguration({
    customFields: [field('text', 'text', { validation: { pattern: 'a+b' } })],
  })).toThrow('unsafe repeated expressions')
  expect(() => createConfiguration({
    customFields: [field('text', 'text', { validation: { pattern: '.*b' } })],
  })).toThrow('unsafe repeated expressions')

  const configuration = createConfiguration({
    customFields: [field('price', 'currency', { currencyCode: 'JPY' })],
  })
  expect(() => normalizeCustomFieldValues(
    configuration,
    { price: 1.5 },
    { mode: 'create' },
  )).toThrow('currency precision')
})

test('honors project scope and validates required scoped fields', () => {
  const configuration = createConfiguration({
    customFields: [field('launch-code', 'text', {
      required: true,
      projectIds: ['launch'],
    })],
  })

  expect(normalizeCustomFieldValues(configuration, undefined, {
    mode: 'create',
    projectId: 'other',
  })).toEqual({})
  expect(() => normalizeCustomFieldValues(configuration, undefined, {
    mode: 'create',
    projectId: 'launch',
  })).toThrow('is required')
  expect(normalizeCustomFieldValues(configuration, {}, {
    existingValues: { 'launch-code': 'internal' },
    mode: 'update',
    projectId: 'other',
  })).toEqual({})
  expect(() => normalizeCustomFieldValues(configuration, {}, {
    existingValues: { unknown: 'value' },
    mode: 'update',
    projectId: 'other',
  })).toThrow('is not defined')
})

test('resolves Team configuration from Workspace and returns mutation guards', async () => {
  const workspaceConfiguration = createConfiguration({ revision: 4, scopeId: 'workspace-1' })
  const commands: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      commands.push(command.input)
      return commands.length === 1 ? {} : { Item: toStoredConfiguration(workspaceConfiguration) }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbWorkItemConfigurationClient(
    'configuration-table',
    'work-items-table',
    documentClient,
    {} as DynamoDBClient,
  )

  const resolved = await client.getTeamConfiguration('workspace-1', 'core-team')
  const checks = createWorkItemConfigurationGuardConditionChecks(
    'configuration-table',
    'workspace-1',
    'core-team',
    resolved,
  )

  expect(resolved.inheritedFrom).toBe('workspace')
  expect(checks).toHaveLength(4)
  expect(checks[0]).toMatchObject({
    ConditionCheck: {
      Key: { recordKey: 'CONFIG_WRITE_LOCK' },
      ConditionExpression:
        '(attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)) OR #expiresAt < :now',
    },
  })
  expect(checks[1]).toMatchObject({
    ConditionCheck: { ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)' },
  })
  expect(checks[3]).toMatchObject({
    ConditionCheck: { ExpressionAttributeValues: { ':revision': 4 } },
  })
})

test('classifies invalid stored configuration separately from client validation', async () => {
  const stored = toStoredConfiguration(createConfiguration({ revision: 1 }))
  const documentClient = {
    async send() {
      return {
        Item: {
          ...stored,
          workflow: { ...stored.workflow, statuses: [] },
        },
      }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbWorkItemConfigurationClient(
    'configuration-table',
    'work-items-table',
    documentClient,
    {} as DynamoDBClient,
  )

  await expect(client.getWorkspaceConfiguration('workspace-1')).rejects.toMatchObject({
    code: 'StoredWorkItemConfigurationInvalid',
    status: 503,
  })
})

test('saves configuration with revision CAS and returns the incremented revision', async () => {
  const sent: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { input: Record<string, unknown> }) {
      sent.push(command.input)
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbWorkItemConfigurationClient(
    'configuration-table',
    'work-items-table',
    documentClient,
    {} as DynamoDBClient,
  )

  const response = await client.saveTeamConfiguration(
    'workspace-1',
    'core-team',
    createConfiguration({ scopeType: 'team', scopeId: 'core-team', revision: 2 }),
    async () => undefined,
  )

  expect(response.configuration.revision).toBe(3)
  expect(sent[0]).toMatchObject({
    TableName: 'configuration-table',
    Item: { recordKey: 'CONFIG_WRITE_LOCK' },
  })
  expect(sent[1]).toMatchObject({
    TransactItems: [
      {
        Put: {
          ConditionExpression: '#revision = :expectedRevision',
          ExpressionAttributeValues: { ':expectedRevision': 2 },
        },
      },
      {
        Delete: {
          ConditionExpression: '#token = :token AND #expiresAt >= :now',
        },
      },
    ],
  })
})

test('classifies configuration CAS failures with a stable conflict code', async () => {
  let requestCount = 0
  const documentClient = {
    async send() {
      requestCount += 1
      if (requestCount === 2) {
        throw {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
        }
      }
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbWorkItemConfigurationClient(
    'configuration-table',
    'work-items-table',
    documentClient,
    {} as DynamoDBClient,
  )

  await expect(client.saveWorkspaceConfiguration(
    'workspace-1',
    createConfiguration({ scopeId: 'workspace-1' }),
    async () => undefined,
  )).rejects.toMatchObject({
    status: 409,
    code: 'WorkItemConfigurationRevisionConflict',
  })
})

test('preserves infrastructure failures from configuration transactions', async () => {
  let requestCount = 0
  const documentClient = {
    async send() {
      requestCount += 1
      if (requestCount === 2) {
        throw {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'TransactionConflict' }, { Code: 'None' }],
        }
      }
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbWorkItemConfigurationClient(
    'configuration-table',
    'work-items-table',
    documentClient,
    {} as DynamoDBClient,
  )

  await expect(client.saveWorkspaceConfiguration(
    'workspace-1',
    createConfiguration({ scopeId: 'workspace-1' }),
    async () => undefined,
  )).rejects.toMatchObject({
    status: 503,
    code: 'TransactionCanceledException',
  })
})

test('releases the configuration write lock when usage validation fails', async () => {
  const sentCommands: string[] = []
  const documentClient = {
    async send(command: { constructor: { name: string } }) {
      sentCommands.push(command.constructor.name)
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbWorkItemConfigurationClient(
    'configuration-table',
    'work-items-table',
    documentClient,
    {} as DynamoDBClient,
  )

  await expect(client.saveWorkspaceConfiguration(
    'workspace-1',
    createConfiguration({ scopeId: 'workspace-1' }),
    async () => {
      throw new WorkItemConfigurationError(
        409,
        'WorkItemConfigurationInUse',
        'Configuration is in use.',
      )
    },
  )).rejects.toMatchObject({
    code: 'WorkItemConfigurationInUse',
    status: 409,
  })
  expect(sentCommands).toEqual(['PutCommand', 'DeleteCommand'])
})

test('preserves unexpected usage validation failures after releasing the lock', async () => {
  const sentCommands: string[] = []
  const usageError = new Error('Usage validation failed unexpectedly.')
  const documentClient = {
    async send(command: { constructor: { name: string } }) {
      sentCommands.push(command.constructor.name)
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbWorkItemConfigurationClient(
    'configuration-table',
    'work-items-table',
    documentClient,
    {} as DynamoDBClient,
  )

  let caughtError: unknown
  try {
    await client.saveWorkspaceConfiguration(
      'workspace-1',
      createConfiguration({ scopeId: 'workspace-1' }),
      async () => {
        throw usageError
      },
    )
  } catch (error) {
    caughtError = error
  }

  expect(caughtError).toBe(usageError)
  expect(sentCommands).toEqual(['PutCommand', 'DeleteCommand'])
})

test('creates reciprocal relation edges with endpoint and graph guards in one transaction', async () => {
  const sent: Array<{ name: string; input: Record<string, unknown> }> = []
  const documentClient = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      sent.push({ name: command.constructor.name, input: command.input })
      if (command.constructor.name === 'QueryCommand') {
        return { Items: [] }
      }
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbWorkItemConfigurationClient(
    'configuration-table',
    'work-items-table',
    documentClient,
    {} as DynamoDBClient,
  )

  const response = await client.createRelation('workspace-1', 'core-team', {
    sourceWorkItemId: 'parent',
    targetWorkItemId: 'child',
    type: 'parent',
    expectedGraphRevision: 0,
    sourceExpectedRevision: 1,
    targetExpectedRevision: 1,
  })
  const transaction = sent.find((entry) => entry.name === 'TransactWriteCommand')?.input
  const transactItems = transaction?.TransactItems as Array<Record<string, unknown>>

  expect(response).toMatchObject({
    graphRevision: 1,
    relation: { type: 'parent' },
    reciprocalRelation: { type: 'child' },
  })
  expect(transactItems).toHaveLength(5)
  expect(transactItems.filter((item) => 'Update' in item)).toHaveLength(2)
  expect(transactItems.filter((item) => 'Put' in item)).toHaveLength(3)
  expect(transactItems.filter((item) => 'Update' in item)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        Update: expect.objectContaining({
          ConditionExpression: expect.stringContaining('#revision = :revision'),
          UpdateExpression: 'SET #relationIds = :relationIds',
          ExpressionAttributeValues: expect.objectContaining({
            ':relationIds': ['parent:child'],
            ':revision': 1,
          }),
        }),
      }),
      expect.objectContaining({
        Update: expect.objectContaining({
          UpdateExpression: 'SET #relationIds = :relationIds',
          ExpressionAttributeValues: expect.objectContaining({
            ':relationIds': ['child:parent'],
            ':revision': 1,
          }),
        }),
      }),
    ]),
  )
  expect(JSON.stringify(transactItems.filter((item) => 'Update' in item))).not.toContain('updatedAt')
  expect(transactItems).toContainEqual(expect.objectContaining({
    Put: expect.objectContaining({
      Item: expect.objectContaining({
        entryType: 'relation-graph',
        recordKey: 'RELATION_GRAPH',
        schemaVersion: 1,
      }),
    }),
  }))
})

test('derives complete sorted relation projections for create and delete transactions', async () => {
  const sentTransactions: Array<Record<string, unknown>> = []
  let relations = [
    relationItem('source', 'existing-z', 'related'),
    relationItem('existing-z', 'source', 'related'),
    relationItem('source', 'target', 'blocks'),
    relationItem('target', 'source', 'blockedBy'),
    relationItem('target', 'existing-a', 'parent'),
    relationItem('existing-a', 'target', 'child'),
  ]
  let graphRevision = 1
  const documentClient = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      if (command.constructor.name === 'GetCommand') {
        return {
          Item: {
            entryType: 'relation-graph',
            schemaVersion: 1,
            revision: graphRevision,
          },
        }
      }
      if (command.constructor.name === 'QueryCommand') {
        return { Items: relations }
      }
      if (command.constructor.name === 'TransactWriteCommand') {
        sentTransactions.push(command.input)
      }
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbWorkItemConfigurationClient(
    'configuration-table',
    'work-items-table',
    documentClient,
    {} as DynamoDBClient,
  )

  await client.createRelation('workspace-1', 'core-team', {
    sourceWorkItemId: 'source',
    targetWorkItemId: 'new-target',
    type: 'parent',
    expectedGraphRevision: 1,
    sourceExpectedRevision: 7,
    targetExpectedRevision: 2,
  })
  relations = [
    ...relations,
    relationItem('source', 'new-target', 'parent'),
    relationItem('new-target', 'source', 'child'),
  ]
  graphRevision = 2
  await client.deleteRelation('workspace-1', 'core-team', {
    sourceWorkItemId: 'source',
    targetWorkItemId: 'target',
    type: 'blocks',
    expectedGraphRevision: 2,
    sourceExpectedRevision: 7,
    targetExpectedRevision: 2,
  })

  const createTransaction = sentTransactions[0]
  const deleteTransaction = sentTransactions[1]
  if (!createTransaction || !deleteTransaction) {
    throw new Error('Expected create and delete relation transactions.')
  }
  const createUpdates = (createTransaction.TransactItems as Array<{
    Update?: { ExpressionAttributeValues?: Record<string, unknown> }
  }>).flatMap((item) => item.Update ? [item.Update] : [])
  const deleteUpdates = (deleteTransaction.TransactItems as Array<{
    Update?: { ExpressionAttributeValues?: Record<string, unknown> }
  }>).flatMap((item) => item.Update ? [item.Update] : [])
  expect(createUpdates.map((update) => update.ExpressionAttributeValues?.[':relationIds']))
    .toEqual([
      ['blocks:target', 'parent:new-target', 'related:existing-z'],
      ['child:source'],
    ])
  expect(deleteUpdates.map((update) => update.ExpressionAttributeValues?.[':relationIds']))
    .toEqual([
      ['parent:new-target', 'related:existing-z'],
      ['parent:existing-a'],
    ])
})

test('validates canonical derived relation IDs as bounded unique sorted keys', () => {
  expect(createWorkItemRelationIds([
    { sourceWorkItemId: 'source', targetWorkItemId: 'z', type: 'related' },
    { sourceWorkItemId: 'source', targetWorkItemId: 'a', type: 'blocks' },
  ], 'source')).toEqual(['blocks:a', 'related:z'])
  expect(isCanonicalWorkItemRelationIds(['blocks:a', 'related:z'])).toBe(true)
  expect(isCanonicalWorkItemRelationIds(['related:z', 'blocks:a'])).toBe(false)
  expect(isCanonicalWorkItemRelationIds(['blocks:a', 'blocks:a'])).toBe(false)
  expect(isCanonicalWorkItemRelationIds(['unknown:a'])).toBe(false)
  expect(isCanonicalWorkItemRelationIds(Array.from(
    { length: 101 },
    (_, index) => `related:item-${String(index).padStart(3, '0')}`,
  ))).toBe(false)
})

test('rejects relation creation before reciprocal rows exceed the graph limit', async () => {
  const relations = Array.from({ length: 2_000 }, (_, index) => ({
    entryType: 'relation',
    sourceWorkItemId: `source-${index}`,
    targetWorkItemId: `target-${index}`,
    type: 'related',
    createdAt: '2026-07-14T00:00:00.000Z',
  }))
  const documentClient = {
    async send(command: { constructor: { name: string } }) {
      return command.constructor.name === 'QueryCommand' ? { Items: relations } : {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbWorkItemConfigurationClient(
    'configuration-table',
    'work-items-table',
    documentClient,
    {} as DynamoDBClient,
  )

  await expect(client.createRelation('workspace-1', 'core-team', {
    sourceWorkItemId: 'source',
    targetWorkItemId: 'target',
    type: 'related',
    expectedGraphRevision: 0,
    sourceExpectedRevision: 1,
    targetExpectedRevision: 1,
  })).rejects.toMatchObject({
    code: 'WorkItemRelationGraphLimitExceeded',
    status: 413,
  })
})

test('rejects self, duplicate, and transitive cyclic relations before writing', async () => {
  const relations = [
    relationItem('b', 'c', 'blocks'),
    relationItem('c', 'a', 'blocks'),
  ]
  let transactionCount = 0
  const documentClient = {
    async send(command: { constructor: { name: string } }) {
      if (command.constructor.name === 'QueryCommand') {
        return { Items: relations }
      }
      if (command.constructor.name === 'TransactWriteCommand') {
        transactionCount += 1
      }
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbWorkItemConfigurationClient(
    'configuration-table',
    'work-items-table',
    documentClient,
    {} as DynamoDBClient,
  )

  await expect(client.createRelation('workspace-1', 'core-team', {
    sourceWorkItemId: 'a',
    targetWorkItemId: 'a',
    type: 'related',
    expectedGraphRevision: 0,
    sourceExpectedRevision: 1,
    targetExpectedRevision: 1,
  })).rejects.toMatchObject({ code: 'WorkItemRelationSelf' })
  await expect(client.createRelation('workspace-1', 'core-team', {
    sourceWorkItemId: 'a',
    targetWorkItemId: 'b',
    type: 'blocks',
    expectedGraphRevision: 0,
    sourceExpectedRevision: 1,
    targetExpectedRevision: 1,
  })).rejects.toMatchObject({ code: 'WorkItemRelationCycle' })
  expect(transactionCount).toBe(0)
})

test('fails closed when the relation graph changes during a consistent snapshot', async () => {
  let guardRead = 0
  const documentClient = {
    async send(command: { constructor: { name: string } }) {
      if (command.constructor.name === 'GetCommand') {
        guardRead += 1
        return {
          Item: {
            entryType: 'relation-graph',
            schemaVersion: 1,
            revision: guardRead,
          },
        }
      }
      return { Items: [] }
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbWorkItemConfigurationClient(
    'configuration-table',
    'work-items-table',
    documentClient,
    {} as DynamoDBClient,
  )

  await expect(client.listRelations('workspace-1', 'core-team', 'a')).rejects.toMatchObject({
    code: 'WorkItemRelationGraphConflict',
  })
})

test('classifies invalid stored relations separately from client validation', async () => {
  const documentClient = {
    async send(command: { constructor: { name: string } }) {
      if (command.constructor.name === 'QueryCommand') {
        return { Items: [relationItem('', 'target', 'related')] }
      }
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbWorkItemConfigurationClient(
    'configuration-table',
    'work-items-table',
    documentClient,
    {} as DynamoDBClient,
  )

  await expect(client.listRelations('workspace-1', 'core-team', 'source')).rejects.toMatchObject({
    code: 'StoredWorkItemRelationInvalid',
    status: 503,
  })
})

test('classifies a canceled relation transaction when an endpoint disappeared', async () => {
  const documentClient = {
    async send(command: { constructor: { name: string } }) {
      if (command.constructor.name === 'TransactWriteCommand') {
        throw { name: 'TransactionCanceledException' }
      }
      if (command.constructor.name === 'QueryCommand') {
        return { Items: [] }
      }
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbWorkItemConfigurationClient(
    'configuration-table',
    'work-items-table',
    documentClient,
    {} as DynamoDBClient,
  )

  await expect(client.createRelation('workspace-1', 'core-team', {
    sourceWorkItemId: 'source',
    targetWorkItemId: 'target',
    type: 'related',
    expectedGraphRevision: 0,
    sourceExpectedRevision: 1,
    targetExpectedRevision: 1,
  })).rejects.toMatchObject({
    code: 'WorkItemRelationEndpointNotFound',
    status: 404,
  })
})

function createConfiguration(
  overrides: Partial<WorkItemConfiguration> = {},
): WorkItemConfiguration {
  return validateWorkItemConfiguration({
    ...structuredClone(DEFAULT_WORK_ITEM_CONFIGURATION),
    scopeId: 'workspace-1',
    ...overrides,
  })
}

function field(
  id: string,
  type: WorkItemConfiguration['customFields'][number]['type'],
  overrides: Partial<WorkItemConfiguration['customFields'][number]> = {},
) {
  return {
    id,
    name: id,
    type,
    sortOrder: fieldSortOrder(id),
    required: false,
    ...overrides,
  }
}

function options(...ids: string[]) {
  return ids.map((id, index) => ({ id, name: id, sortOrder: (index + 1) * 10 }))
}

function fieldSortOrder(id: string) {
  return [...id].reduce((sum, character) => sum + character.charCodeAt(0), 0)
}

function toStoredConfiguration(configuration: WorkItemConfiguration) {
  return {
    scopeKey: `${encodeURIComponent(configuration.scopeId)}#work-item-configuration`,
    recordKey: 'CONFIG',
    ...configuration,
  }
}

function relationItem(sourceWorkItemId: string, targetWorkItemId: string, type: string) {
  return {
    scopeKey: 'workspace-1#team#core-team#work-item-configuration',
    recordKey: `REL#${sourceWorkItemId}#${type}#${targetWorkItemId}`,
    entryType: 'relation',
    sourceWorkItemId,
    targetWorkItemId,
    type,
    createdAt: '2026-07-12T00:00:00.000Z',
  }
}

function expectConfigurationError(callback: () => unknown, code: string, message: string) {
  let thrown: unknown
  try {
    callback()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toMatchObject({ code, message, status: 400 })
}
