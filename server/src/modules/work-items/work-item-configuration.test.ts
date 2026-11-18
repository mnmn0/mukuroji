import { expect, test } from 'bun:test'
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  DEFAULT_WORK_ITEM_TYPE,
  type WorkItemConfiguration,
} from '@mukuroji/contracts'
import {
  DEFAULT_WORK_ITEM_CONFIGURATION,
  DynamoDbWorkItemConfigurationClient,
  MAX_WORK_ITEM_CONFIGURATION_ITEM_SERIALIZED_BYTES,
  WorkItemConfigurationError,
  assertWorkItemChildTypeAllowed,
  assertWorkflowTransitionAllowed,
  assertWorkItemTypeChangeResolution,
  createWorkItemConfigurationScopeKey,
  createWorkItemConfigurationGuardConditionChecks,
  createWorkItemRelationIds,
  createWorkItemRelationGraphRevisionIncrementTransactionItem,
  isCanonicalWorkItemRelationIds,
  normalizeCustomFieldValues,
  previewWorkItemTypeChange,
  resolveWorkItemType,
  resolveWorkItemTypeWorkflow,
  resolveWorkflowStatus,
  validateWorkItemConfiguration,
} from './work-item-configuration'
import { createMutationAuditContext } from '../audit'

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

test('resolves the implicit default type to a legacy configuration workflow', () => {
  const configuration = createConfiguration({
    workflow: {
      ...DEFAULT_WORK_ITEM_CONFIGURATION.workflow,
      id: 'legacy-delivery-workflow',
      initialStatusId: 'backlog',
      statuses: [{
        id: 'backlog',
        name: 'Backlog',
        category: 'backlog',
        sortOrder: 10,
      }],
      transitions: [],
    },
  })

  expect(resolveWorkItemTypeWorkflow(configuration).id).toBe('legacy-delivery-workflow')
  expect(resolveWorkflowStatus(configuration).workflowStatusId).toBe('backlog')
})

test('rejects explicitly empty Work Item Type IDs', () => {
  const configuration = createConfiguration()

  for (const requestedTypeId of [null, '']) {
    expectConfigurationError(
      () => resolveWorkItemType(configuration, requestedTypeId),
      'InvalidWorkItemConfiguration',
      'Work Item Type ID is invalid.',
    )
  }
  expect(resolveWorkItemType(configuration, undefined)).toEqual(DEFAULT_WORK_ITEM_TYPE)
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

  expect(() => validateWorkItemConfiguration({
    ...DEFAULT_WORK_ITEM_CONFIGURATION,
    workflows: [{ ...DEFAULT_WORK_ITEM_CONFIGURATION.workflow }],
  })).toThrow('Workflow ID must be unique.')

  expect(() => validateWorkItemConfiguration({
    ...DEFAULT_WORK_ITEM_CONFIGURATION,
    workflows: [{
      ...DEFAULT_WORK_ITEM_CONFIGURATION.workflow,
      id: 'incident-workflow',
    }],
  })).toThrow('Workflow status ID must be unique.')
})

test('validates job roles with stable IDs and trimmed names', () => {
  expect(validateWorkItemConfiguration({
    ...DEFAULT_WORK_ITEM_CONFIGURATION,
    jobRoles: [
      { id: 'designer', name: '  Designer  ' },
      { id: 'legacy.writer', name: 'Writer', archived: true },
      { id: 'qa', name: 'QA', archived: false },
    ],
  }).jobRoles).toEqual([
    { id: 'designer', name: 'Designer' },
    { id: 'legacy.writer', name: 'Writer', archived: true },
    { id: 'qa', name: 'QA' },
  ])
  expect(validateWorkItemConfiguration(DEFAULT_WORK_ITEM_CONFIGURATION).jobRoles).toBeUndefined()

  expect(() => validateWorkItemConfiguration({
    ...DEFAULT_WORK_ITEM_CONFIGURATION,
    jobRoles: [{ id: 'qa', name: 'QA' }, { id: 'qa', name: 'Quality' }],
  })).toThrow('Job role ID must be unique.')
  expect(() => validateWorkItemConfiguration({
    ...DEFAULT_WORK_ITEM_CONFIGURATION,
    jobRoles: [{ id: 'Quality Assurance', name: 'QA' }],
  })).toThrow('Job role ID must use letters')
  expect(() => validateWorkItemConfiguration({
    ...DEFAULT_WORK_ITEM_CONFIGURATION,
    jobRoles: [{ id: 'qa', name: ' ' }],
  })).toThrow('Job role name is invalid.')
  expect(() => validateWorkItemConfiguration({
    ...DEFAULT_WORK_ITEM_CONFIGURATION,
    jobRoles: Array.from({ length: 101 }, (_, index) => ({ id: `role-${index}`, name: `Role ${index}` })),
  })).toThrow('at most 100 entries')
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

test('validates and resolves type-specific workflows and custom fields', () => {
  const configuration = createConfiguration({
    customFields: [
      field('summary', 'text'),
      field('severity', 'select', { options: options('low', 'high') }),
    ],
    workflows: [{
      id: 'incident-workflow',
      name: 'Incident workflow',
      initialStatusId: 'investigating',
      statuses: [{
        id: 'investigating',
        name: 'Investigating',
        category: 'started',
        sortOrder: 10,
      }],
      transitions: [],
    }],
    workItemTypes: [{
      id: 'incident',
      name: 'Incident',
      iconToken: 'alert-triangle',
      status: 'active',
      defaultWorkflowId: 'incident-workflow',
      customFieldIds: ['summary', 'severity'],
      requiredCustomFieldIds: ['severity'],
      detailSections: ['overview', 'custom-fields', 'activity'],
      allowedChildTypeIds: ['default', 'incident'],
      sortOrder: 10,
    }],
  })

  expect(resolveWorkItemType(configuration, 'incident').name).toBe('Incident')
  expect(resolveWorkItemTypeWorkflow(configuration, 'incident').id).toBe('incident-workflow')
  expect(normalizeCustomFieldValues(configuration, {
    summary: 'Database outage',
    severity: 'high',
  }, { mode: 'create', workItemTypeId: 'incident' })).toEqual({
    summary: 'Database outage',
    severity: 'high',
  })
  expect(() => normalizeCustomFieldValues(configuration, {
    summary: 'Database outage',
  }, { mode: 'create', workItemTypeId: 'incident' })).toThrow(
    'Custom field "severity" is required.',
  )
})

test('validates type-specific formula dependencies and required fields', () => {
  expectConfigurationError(
    () => createConfiguration({
      customFields: [
        field('amount', 'number'),
        field('total', 'formula', { formulaExpression: '{amount} * 2' }),
      ],
      workItemTypes: [{
        id: 'computed',
        name: 'Computed',
        iconToken: 'calculator',
        status: 'active',
        defaultWorkflowId: 'default-workflow',
        customFieldIds: ['total'],
        requiredCustomFieldIds: [],
        detailSections: ['overview'],
        allowedChildTypeIds: ['default'],
        sortOrder: 10,
      }],
    }),
    'InvalidWorkItemConfiguration',
    'Work Item Type "computed" formula field "total" references an unavailable field "amount".',
  )

  expectConfigurationError(
    () => createConfiguration({
      customFields: [
        field('amount', 'number'),
        field('total', 'formula', { formulaExpression: '{amount} * 2' }),
      ],
      workItemTypes: [{
        id: 'computed',
        name: 'Computed',
        iconToken: 'calculator',
        status: 'active',
        defaultWorkflowId: 'default-workflow',
        customFieldIds: ['amount', 'total'],
        requiredCustomFieldIds: ['total'],
        detailSections: ['overview'],
        allowedChildTypeIds: ['default'],
        sortOrder: 10,
      }],
    }),
    'InvalidWorkItemConfiguration',
    'Work Item Type "computed" cannot require a formula field.',
  )
})

test('requires explicit resolution for lost fields and invalid statuses on type change', () => {
  const configuration = createConfiguration({
    customFields: [field('severity', 'text'), field('owner', 'text')],
    workItemTypes: [{
      id: 'request',
      name: 'Request',
      iconToken: 'inbox',
      status: 'active',
      defaultWorkflowId: 'default-workflow',
      customFieldIds: ['severity'],
      requiredCustomFieldIds: [],
      detailSections: ['overview'],
      allowedChildTypeIds: ['default'],
      sortOrder: 10,
    }],
  })
  const preview = previewWorkItemTypeChange(
    configuration,
    'default',
    'review',
    { owner: 'platform' },
    'request',
    undefined,
    7,
  )

  expect(preview).toMatchObject({
    expectedRevision: 7,
    lostCustomFieldIds: ['owner'],
  })
  expect(() => assertWorkItemTypeChangeResolution(preview, undefined)).toThrow(
    'requires an explicit resolution',
  )
  expect(assertWorkItemTypeChangeResolution(preview, {
    discardCustomFieldIds: ['owner'],
  })).toBe('review')
})

test('reports empty required values in a Work Item Type change preview', () => {
  const configuration = createConfiguration({
    customFields: [
      field('summary', 'text'),
      field('labels', 'multi-select', { options: options('alpha', 'beta') }),
    ],
    workItemTypes: [{
      id: 'incident',
      name: 'Incident',
      iconToken: 'incident',
      status: 'active',
      defaultWorkflowId: 'default-workflow',
      customFieldIds: ['summary', 'labels'],
      requiredCustomFieldIds: ['summary', 'labels'],
      detailSections: ['overview'],
      allowedChildTypeIds: ['default'],
      sortOrder: 10,
    }],
  })

  expect(previewWorkItemTypeChange(
    configuration,
    'default',
    'todo',
    { summary: '', labels: [] },
    'incident',
  )).toMatchObject({
    missingRequiredCustomFieldIds: ['labels', 'summary'],
    missingRequiredCustomFieldDefinitions: [
      expect.objectContaining({ id: 'labels', required: true, type: 'multi-select' }),
      expect.objectContaining({ id: 'summary', required: true, type: 'text' }),
    ],
    requiresResolution: true,
  })
})

test('does not allow archived types for new Work Items', () => {
  const configuration = createConfiguration({
    workItemTypes: [{
      id: 'legacy',
      name: 'Legacy',
      iconToken: 'archive',
      status: 'archived',
      defaultWorkflowId: 'default-workflow',
      customFieldIds: [],
      requiredCustomFieldIds: [],
      detailSections: ['overview'],
      allowedChildTypeIds: ['default'],
      sortOrder: 10,
    }],
  })

  expect(() => resolveWorkItemType(configuration, 'legacy')).toThrow(
    'is archived and cannot be used',
  )
  expect(resolveWorkItemType(configuration, 'legacy', { allowArchived: true }).status).toBe('archived')
})

test('enforces allowed child Work Item Types', () => {
  const configuration = createConfiguration({
    workItemTypes: [
      {
        id: 'parent',
        name: 'Parent',
        iconToken: 'folder',
        status: 'active',
        defaultWorkflowId: 'default-workflow',
        customFieldIds: [],
        requiredCustomFieldIds: [],
        detailSections: ['overview'],
        allowedChildTypeIds: ['child'],
        sortOrder: 10,
      },
      {
        id: 'child',
        name: 'Child',
        iconToken: 'check',
        status: 'active',
        defaultWorkflowId: 'default-workflow',
        customFieldIds: [],
        requiredCustomFieldIds: [],
        detailSections: ['overview'],
        allowedChildTypeIds: [],
        sortOrder: 20,
      },
    ],
  })

  expect(() => assertWorkItemChildTypeAllowed(configuration, 'parent', 'child')).not.toThrow()
  expect(() => assertWorkItemChildTypeAllowed(configuration, 'child', 'parent')).toThrow(
    'Work Item Type "parent" cannot be created as a child of "child".',
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

test('allows required fields to be completed after a quick capture', () => {
  const configuration = createConfiguration({
    customFields: [field('required', 'text', { required: true })],
  })

  expect(normalizeCustomFieldValues(configuration, undefined, {
    allowRequiredMissing: true,
    mode: 'create',
  })).toEqual({})
  expect(normalizeCustomFieldValues(configuration, undefined, {
    allowRequiredMissing: true,
    existingValues: {},
    mode: 'update',
  })).toEqual({})
})

test('defers formulas that reference required values omitted by quick capture', () => {
  const configuration = createConfiguration({
    customFields: [
      field('amount', 'number', { required: true }),
      field('total', 'formula', { formulaExpression: '{amount} * 2' }),
    ],
  })

  expect(normalizeCustomFieldValues(configuration, undefined, {
    allowRequiredMissing: true,
    mode: 'create',
  })).toEqual({})
})

test('defers formulas that reference Work Item Type required values omitted by quick capture', () => {
  const configuration = createConfiguration({
    customFields: [
      field('amount', 'number'),
      field('total', 'formula', { formulaExpression: '{amount} * 2' }),
    ],
    workItemTypes: [{
      id: 'incident',
      name: 'Incident',
      iconToken: 'incident',
      status: 'active',
      defaultWorkflowId: 'default-workflow',
      customFieldIds: ['amount', 'total'],
      requiredCustomFieldIds: ['amount'],
      detailSections: ['overview'],
      allowedChildTypeIds: ['default'],
      sortOrder: 10,
    }],
  })

  expect(normalizeCustomFieldValues(configuration, undefined, {
    allowRequiredMissing: true,
    mode: 'create',
    workItemTypeId: 'incident',
  })).toEqual({})
})

test('removes stale deferred formula values during a quick-capture update', () => {
  const configuration = createConfiguration({
    customFields: [
      field('amount', 'number', { required: true }),
      field('total', 'formula', { formulaExpression: '{amount} * 2' }),
    ],
  })

  expect(normalizeCustomFieldValues(
    configuration,
    { amount: null },
    {
      allowRequiredMissing: true,
      existingValues: { amount: 3, total: 6 },
      mode: 'update',
    },
  )).toEqual({})
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

test('enforces Work Item Type required fields when values are explicitly empty', () => {
  const configuration = createConfiguration({
    customFields: [
      field('summary', 'text'),
      field('labels', 'multi-select', { options: options('alpha', 'beta') }),
    ],
    workItemTypes: [{
      id: 'incident',
      name: 'Incident',
      iconToken: 'incident',
      status: 'active',
      defaultWorkflowId: 'default-workflow',
      customFieldIds: ['summary', 'labels'],
      requiredCustomFieldIds: ['summary', 'labels'],
      detailSections: ['overview'],
      allowedChildTypeIds: ['default'],
      sortOrder: 10,
    }],
  })

  expect(() => normalizeCustomFieldValues(
    configuration,
    { summary: '', labels: ['alpha'] },
    { mode: 'create', workItemTypeId: 'incident' },
  )).toThrow('Custom field "summary" is required.')
  expect(() => normalizeCustomFieldValues(
    configuration,
    { summary: 'Database outage', labels: [] },
    { mode: 'create', workItemTypeId: 'incident' },
  )).toThrow('Custom field "labels" is required.')
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
  const completion = {
    Update: {
      TableName: 'automation-table',
      Key: { scopeKey: 'workspace-1#automation', recordKey: 'TEMPLATE_APPLICATION#application-1' },
      UpdateExpression: 'SET #status = :succeeded',
    },
  }
  const usageConditionCheck = {
    ConditionCheck: {
      TableName: 'configuration-table',
      Key: { scopeKey: 'workspace-1#team#core-team#work-item-configuration', recordKey: 'RELATION_GRAPH' },
      ConditionExpression: '#revision = :expectedRevision',
      ExpressionAttributeNames: { '#revision': 'revision' },
      ExpressionAttributeValues: { ':expectedRevision': 4 },
    },
  }

  const response = await client.saveTeamConfiguration(
    'workspace-1',
    'core-team',
    createConfiguration({ scopeType: 'team', scopeId: 'core-team', revision: 2 }),
    async () => [usageConditionCheck],
    [completion],
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
      usageConditionCheck,
      completion,
    ],
  })
})

test('rejects an oversized configuration before acquiring the write lock', async () => {
  const sent: string[] = []
  const documentClient = {
    async send(command: { constructor: { name: string } }) {
      sent.push(command.constructor.name)
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbWorkItemConfigurationClient(
    'configuration-table',
    'work-items-table',
    documentClient,
    {} as DynamoDBClient,
  )
  const customFields = Array.from({ length: 20 }, (_, fieldIndex) => field(
    `large-field-${fieldIndex}`,
    'select',
    {
      options: Array.from({ length: 100 }, (_, optionIndex) => ({
        id: `option-${optionIndex}`,
        name: 'x'.repeat(160),
        sortOrder: optionIndex,
      })),
    },
  ))
  const configuration = createConfiguration({ customFields })
  const item = {
    ...configuration,
    scopeKey: 'workspace-1#work-item-configuration',
    recordKey: 'CONFIG',
    revision: configuration.revision + 1,
    updatedAt: '2026-08-01T00:00:00.000Z',
  }

  expect(Buffer.byteLength(JSON.stringify(item), 'utf8'))
    .toBeGreaterThan(MAX_WORK_ITEM_CONFIGURATION_ITEM_SERIALIZED_BYTES)
  await expect(client.saveWorkspaceConfiguration(
    'workspace-1',
    configuration,
    async () => undefined,
  )).rejects.toMatchObject({
    code: 'WorkItemConfigurationItemTooLarge',
    status: 413,
  })
  expect(sent).toEqual([])
})

test('writes a configuration audit event in the same transaction as the revision update', async () => {
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
    false,
    'audit-table',
  )
  const auditContext = createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: { id: 'actor-1', kind: 'user' },
    idempotencyKey: 'configuration-audit-1',
    request: {
      method: 'PUT',
      path: '/api/work-item-configuration',
      body: { revision: 0 },
    },
    source: {
      kind: 'api',
      method: 'PUT',
      route: '/api/work-item-configuration',
    },
    occurredAt: '2026-07-16T00:00:00.000Z',
  })

  const response = await client.saveWorkspaceConfiguration(
    'workspace-1',
    createConfiguration({ scopeId: 'workspace-1' }),
    async () => undefined,
    [],
    auditContext,
  )

  expect(response.configuration.revision).toBe(1)
  const transaction = sent[2]
  if (!transaction || !Array.isArray(transaction.TransactItems)) {
    throw new Error('Expected a configuration transaction.')
  }
  const auditItem = transaction.TransactItems.find((candidate) => {
    if (typeof candidate !== 'object' || candidate === null || !('Put' in candidate)) {
      return false
    }
    const put = candidate.Put
    return typeof put === 'object' && put !== null &&
      'TableName' in put && put.TableName === 'audit-table'
  })
  expect(auditItem).toMatchObject({
    Put: {
      Item: expect.objectContaining({
        eventType: 'work-item-configuration.created',
        entityType: 'work-item-configuration',
        entityId: 'workspace:workspace-1',
        action: 'created',
      }),
    },
  })
})

test('audits the progress mode before and after a change of only that setting', async () => {
  const previousConfiguration = createConfiguration({ revision: 2 })
  const sent: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      sent.push(command.input)
      if (command.constructor.name === 'GetCommand') {
        return { Item: toStoredConfiguration(previousConfiguration) }
      }
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbWorkItemConfigurationClient(
    'configuration-table',
    'work-items-table',
    documentClient,
    {} as DynamoDBClient,
    false,
    'audit-table',
  )
  const auditContext = createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: { id: 'actor-1', kind: 'user' },
    idempotencyKey: 'configuration-progress-mode-audit-1',
    request: { method: 'PUT', path: '/api/work-item-configuration', body: { revision: 2 } },
    source: { kind: 'api', method: 'PUT', route: '/api/work-item-configuration' },
    occurredAt: '2026-07-16T00:00:00.000Z',
  })

  await client.saveWorkspaceConfiguration(
    'workspace-1',
    { ...previousConfiguration, progressMode: 'manual' },
    async () => undefined,
    [],
    auditContext,
  )

  const transaction = sent[2]
  if (!transaction || !Array.isArray(transaction.TransactItems)) {
    throw new Error('Expected a configuration transaction.')
  }
  expect(transaction.TransactItems).toContainEqual(expect.objectContaining({
    Put: expect.objectContaining({
      TableName: 'audit-table',
      Item: expect.objectContaining({
        changes: expect.arrayContaining([
          expect.objectContaining({ field: 'progressMode', before: 'status-category', after: 'manual' }),
        ]),
      }),
    }),
  }))
})

test('audits Work Item Type policy changes even when policy counts stay the same', async () => {
  const previousConfiguration = createConfiguration({
    customFields: [field('summary', 'text'), field('severity', 'text')],
    revision: 4,
    workItemTypes: [{
      ...DEFAULT_WORK_ITEM_TYPE,
      id: 'incident',
      defaultWorkflowId: DEFAULT_WORK_ITEM_CONFIGURATION.workflow.id,
      customFieldIds: ['summary'],
      requiredCustomFieldIds: ['summary'],
      detailSections: ['overview'],
      allowedChildTypeIds: ['default'],
      sortOrder: 10,
    }],
  })
  const previousType = previousConfiguration.workItemTypes?.[0]
  if (!previousType) throw new Error('Expected an initial Work Item Type.')
  const nextConfiguration = createConfiguration({
    customFields: previousConfiguration.customFields.map((customField) => customField.id === 'summary'
      ? {
          ...customField,
          validation: { minLength: 2 },
        }
      : customField),
    revision: previousConfiguration.revision,
    workflow: {
      ...previousConfiguration.workflow,
      statuses: previousConfiguration.workflow.statuses.map((status, index) => index === 0
        ? { ...status, name: 'Updated initial status' }
        : status),
    },
    workItemTypes: [{
      ...previousType,
      customFieldIds: ['severity'],
      requiredCustomFieldIds: ['severity'],
      detailSections: ['description'],
      allowedChildTypeIds: ['incident'],
    }],
  })
  const sent: Array<Record<string, unknown>> = []
  const documentClient = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      sent.push(command.input)
      if (command.constructor.name === 'GetCommand') {
        return { Item: toStoredConfiguration(previousConfiguration) }
      }
      return {}
    },
  } as unknown as DynamoDBDocumentClient
  const client = new DynamoDbWorkItemConfigurationClient(
    'configuration-table',
    'work-items-table',
    documentClient,
    {} as DynamoDBClient,
    false,
    'audit-table',
  )
  const auditContext = createMutationAuditContext({
    workspaceId: 'workspace-1',
    actor: { id: 'actor-1', kind: 'user' },
    idempotencyKey: 'configuration-policy-audit-1',
    request: {
      method: 'PUT',
      path: '/api/work-item-configuration',
      body: { revision: previousConfiguration.revision },
    },
    source: {
      kind: 'api',
      method: 'PUT',
      route: '/api/work-item-configuration',
    },
    occurredAt: '2026-07-16T00:00:00.000Z',
  })

  await client.saveWorkspaceConfiguration(
    'workspace-1',
    nextConfiguration,
    async () => undefined,
    [],
    auditContext,
  )

  const transaction = sent[2]
  if (!transaction || !Array.isArray(transaction.TransactItems)) {
    throw new Error('Expected a configuration transaction.')
  }
  const auditItem = transaction.TransactItems.find((candidate) => {
    if (typeof candidate !== 'object' || candidate === null || !('Put' in candidate)) {
      return false
    }
    const put = candidate.Put
    return typeof put === 'object' && put !== null &&
      'TableName' in put && put.TableName === 'audit-table'
  })
  expect(auditItem).toMatchObject({
    Put: {
      Item: expect.objectContaining({
        changes: expect.arrayContaining([
          expect.objectContaining({
            field: 'workItemTypes',
            before: expect.arrayContaining([
              expect.objectContaining({
                id: 'incident',
                policyHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
              }),
            ]),
            after: expect.arrayContaining([
              expect.objectContaining({
                id: 'incident',
                policyHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
              }),
            ]),
          }),
          expect.objectContaining({
            field: 'workflowPolicies',
            before: expect.arrayContaining([
              expect.objectContaining({
                id: DEFAULT_WORK_ITEM_CONFIGURATION.workflow.id,
                policyHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
              }),
            ]),
            after: expect.arrayContaining([
              expect.objectContaining({
                id: DEFAULT_WORK_ITEM_CONFIGURATION.workflow.id,
                policyHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
              }),
            ]),
          }),
          expect.objectContaining({
            field: 'customFieldPolicies',
            before: expect.arrayContaining([
              expect.objectContaining({
                id: 'summary',
                policyHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
              }),
            ]),
            after: expect.arrayContaining([
              expect.objectContaining({
                id: 'summary',
                policyHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
              }),
            ]),
          }),
        ]),
      }),
    },
  })
})

test('creates an atomic relation graph revision fence for a related Work Item type change', () => {
  expect(createWorkItemRelationGraphRevisionIncrementTransactionItem(
    'configuration-table',
    'workspace-1',
    'core-team',
    4,
  )).toEqual({
    Update: {
      TableName: 'configuration-table',
      Key: {
        scopeKey: 'workspace-1#team#core-team#work-item-configuration',
        recordKey: 'RELATION_GRAPH',
      },
      UpdateExpression: 'SET #revision = :nextRevision',
      ConditionExpression:
        '#entryType = :entryType AND #schemaVersion = :schemaVersion AND ' +
        '#revision = :expectedRevision',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#schemaVersion': 'schemaVersion',
        '#revision': 'revision',
      },
      ExpressionAttributeValues: {
        ':entryType': 'relation-graph',
        ':schemaVersion': 1,
        ':expectedRevision': 4,
        ':nextRevision': 5,
      },
    },
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

test('reads zero and the stored canonical relation graph revision consistently', async () => {
  const reads: Record<string, unknown>[] = []
  let storedRevision: number | undefined
  const documentClient = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      expect(command.constructor.name).toBe('GetCommand')
      reads.push(command.input)
      return storedRevision === undefined
        ? {}
        : {
            Item: {
              entryType: 'relation-graph',
              schemaVersion: 1,
              revision: storedRevision,
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

  expect(await client.getRelationGraphRevision('workspace-1', 'core-team')).toBe(0)
  storedRevision = 7
  expect(await client.getRelationGraphRevision('workspace-1', 'core-team')).toBe(7)
  expect(reads).toEqual([
    {
      TableName: 'configuration-table',
      Key: {
        scopeKey: 'workspace-1#team#core-team#work-item-configuration',
        recordKey: 'RELATION_GRAPH',
      },
      ConsistentRead: true,
    },
    {
      TableName: 'configuration-table',
      Key: {
        scopeKey: 'workspace-1#team#core-team#work-item-configuration',
        recordKey: 'RELATION_GRAPH',
      },
      ConsistentRead: true,
    },
  ])
})

test('reads the complete stable relation graph for bulk projections', async () => {
  const store = createInMemoryRelationStore()
  store.seedRelation('source-a', 'target-a', 'blocks')
  store.seedRelation('source-b', 'target-b', 'related')
  store.seedGraph(9, 4)
  const client = store.createClient()

  expect(await client.listRelationGraph('workspace-1', 'core-team')).toEqual({
    graphRevision: 9,
    relations: [
      {
        sourceWorkItemId: 'source-a',
        targetWorkItemId: 'target-a',
        type: 'blocks',
        createdAt: '2026-07-12T00:00:00.000Z',
      },
      {
        sourceWorkItemId: 'source-b',
        targetWorkItemId: 'target-b',
        type: 'related',
        createdAt: '2026-07-12T00:00:00.000Z',
      },
      {
        sourceWorkItemId: 'target-a',
        targetWorkItemId: 'source-a',
        type: 'blockedBy',
        createdAt: '2026-07-12T00:00:00.000Z',
      },
      {
        sourceWorkItemId: 'target-b',
        targetWorkItemId: 'source-b',
        type: 'related',
        createdAt: '2026-07-12T00:00:00.000Z',
      },
    ],
  })
})

test('reads one Work Item relation neighbourhood through its source key prefix', async () => {
  const store = createInMemoryRelationStore()
  store.seedRelation('source-a', 'target-a', 'blocks')
  store.seedRelation('source-b', 'target-b', 'related')
  store.seedRelation('source-a', 'parent-a', 'parent')
  store.seedGraph(3, 6)
  const client = store.createClient()

  expect(await client.listRelations('workspace-1', 'core-team', 'source-a')).toEqual({
    graphRevision: 3,
    relations: [
      {
        sourceWorkItemId: 'source-a',
        targetWorkItemId: 'target-a',
        type: 'blocks',
        createdAt: '2026-07-12T00:00:00.000Z',
      },
      {
        sourceWorkItemId: 'source-a',
        targetWorkItemId: 'parent-a',
        type: 'parent',
        createdAt: '2026-07-12T00:00:00.000Z',
      },
    ],
  })
  expect(store.queryPrefixes).toEqual(['REL#source-a#'])

  store.queryPrefixes.length = 0
  expect((await client.listRelations('workspace-1', 'core-team', 'source-a', {
    types: ['parent'],
  })).relations.map((relation) => relation.targetWorkItemId)).toEqual(['parent-a'])
  expect(store.queryPrefixes).toEqual(['REL#source-a#parent#'])
})

test('creates reciprocal relation edges with endpoint and graph guards in one transaction', async () => {
  const store = createInMemoryRelationStore()
  const client = store.createClient()

  const response = await client.createRelation('workspace-1', 'core-team', {
    sourceWorkItemId: 'child',
    targetWorkItemId: 'parent',
    type: 'parent',
    expectedGraphRevision: 0,
    sourceExpectedRevision: 1,
    targetExpectedRevision: 1,
  })
  const transactItems = store.transactions[0]?.TransactItems as Array<Record<string, unknown>>

  expect(response).toMatchObject({
    graphRevision: 1,
    relation: { type: 'parent' },
    reciprocalRelation: { type: 'child' },
  })
  expect(transactItems).toHaveLength(5)
  expect(transactItems[0]).toEqual({
    Update: expect.objectContaining({
      TableName: 'work-items-table',
      Key: { directoryTeamId: 'workspace-1#team#core-team', issueId: 'child' },
      ConditionExpression: expect.stringContaining('#revision = :revision'),
      UpdateExpression: 'SET #relationIds = :relationIds',
      ExpressionAttributeValues: { ':relationIds': ['parent:parent'], ':revision': 1 },
    }),
  })
  expect(transactItems[1]).toEqual({
    ConditionCheck: {
      TableName: 'work-items-table',
      Key: { directoryTeamId: 'workspace-1#team#core-team', issueId: 'parent' },
      ConditionExpression:
        'attribute_exists(directoryTeamId) AND attribute_exists(issueId) AND #revision = :revision AND ' +
        'attribute_not_exists(#assignedProjectId)',
      ExpressionAttributeNames: { '#assignedProjectId': 'assignedProjectId', '#revision': 'revision' },
      ExpressionAttributeValues: { ':revision': 1 },
    },
  })
  expect(JSON.stringify(transactItems)).not.toContain('updatedAt')
  expect(transactItems[2]).toEqual({
    Put: expect.objectContaining({
      Item: {
        scopeKey: 'workspace-1#team#core-team#work-item-configuration',
        recordKey: 'RELATION_GRAPH',
        entryType: 'relation-graph',
        schemaVersion: 1,
        revision: 1,
        edgeCount: 2,
      },
    }),
  })
})

test('fences relation creation against a concurrent configuration change', async () => {
  const transactions: Array<Record<string, unknown>> = []
  const configurationConditionCheck = {
    ConditionCheck: {
      TableName: 'configuration-table',
      Key: { scopeKey: 'workspace-1#team#core-team#work-item-configuration', recordKey: 'CONFIG' },
      ConditionExpression: '#revision = :revision',
      ExpressionAttributeNames: { '#revision': 'revision' },
      ExpressionAttributeValues: { ':revision': 3 },
    },
  }
  const documentClient = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      if (command.constructor.name === 'QueryCommand') {
        return { Items: [] }
      }
      if (command.constructor.name === 'TransactWriteCommand') {
        transactions.push(command.input)
        throw {
          name: 'TransactionCanceledException',
          CancellationReasons: [
            { Code: 'None' },
            { Code: 'None' },
            { Code: 'None' },
            { Code: 'None' },
            { Code: 'None' },
            { Code: 'ConditionalCheckFailed' },
          ],
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

  await expect(client.createRelation('workspace-1', 'core-team', {
    sourceWorkItemId: 'child',
    targetWorkItemId: 'parent',
    type: 'parent',
    expectedGraphRevision: 0,
    sourceExpectedRevision: 1,
    targetExpectedRevision: 1,
  }, [configurationConditionCheck])).rejects.toMatchObject({
    code: 'WorkItemConfigurationRevisionConflict',
    status: 409,
  })
  const transactionItems = transactions[0]?.TransactItems
  expect(Array.isArray(transactionItems) ? transactionItems.at(-1) : undefined)
    .toEqual(configurationConditionCheck)
})

test('derives sorted relation projections without child rows for create and delete', async () => {
  const store = createInMemoryRelationStore()
  store.seedRelation('source', 'existing-z', 'related')
  store.seedRelation('source', 'target', 'blocks')
  store.seedRelation('target', 'existing-a', 'parent')
  store.seedRelation('source', 'grandchild', 'child')
  store.seedGraph(1, 8)
  const client = store.createClient()

  await client.createRelation('workspace-1', 'core-team', {
    sourceWorkItemId: 'source',
    targetWorkItemId: 'new-target',
    type: 'parent',
    expectedGraphRevision: 1,
    sourceExpectedRevision: 7,
    targetExpectedRevision: 2,
  })
  await client.deleteRelation('workspace-1', 'core-team', {
    sourceWorkItemId: 'source',
    targetWorkItemId: 'target',
    type: 'blocks',
    expectedGraphRevision: 2,
    sourceExpectedRevision: 7,
    targetExpectedRevision: 2,
  })

  expect(store.transactions.map(readEndpointProjections)).toEqual([
    [['blocks:target', 'parent:new-target', 'related:existing-z'], undefined],
    [['parent:new-target', 'related:existing-z'], ['parent:existing-a']],
  ])
  expect(store.graph()).toMatchObject({ revision: 3, edgeCount: 8 })
})

test('clears the child sibling rank when its parent link is deleted from either side', async () => {
  const store = createInMemoryRelationStore()
  store.seedRelation('task', 'phase', 'parent')
  store.seedRelation('phase', 'other-task', 'child')
  store.seedGraph(1, 4)
  const client = store.createClient()
  /** Reads each Work Item endpoint's update expression, or `check` for a condition-only endpoint. */
  const endpointExpressions = (index: number) =>
    ((store.transactions[index]?.TransactItems ?? []) as Array<Record<string, Record<string, unknown>>>)
      .filter((item) =>
        item.Update?.TableName === 'work-items-table' ||
        item.ConditionCheck?.TableName === 'work-items-table'
      )
      .map((item) => item.Update?.UpdateExpression ?? 'check')

  await client.deleteRelation('workspace-1', 'core-team', {
    sourceWorkItemId: 'task',
    targetWorkItemId: 'phase',
    type: 'parent',
    expectedGraphRevision: 1,
    sourceExpectedRevision: 3,
    targetExpectedRevision: 2,
  })
  await client.deleteRelation('workspace-1', 'core-team', {
    sourceWorkItemId: 'phase',
    targetWorkItemId: 'other-task',
    type: 'child',
    expectedGraphRevision: 2,
    sourceExpectedRevision: 2,
    targetExpectedRevision: 4,
  })

  expect(endpointExpressions(0)).toEqual(['SET #relationIds = :relationIds REMOVE #hierarchyRank', 'check'])
  expect(endpointExpressions(1)).toEqual(['check', 'SET #relationIds = :relationIds REMOVE #hierarchyRank'])
})

test('validates canonical derived relation IDs as bounded unique sorted keys', () => {
  expect(createWorkItemRelationIds([
    { sourceWorkItemId: 'source', targetWorkItemId: 'z', type: 'related' },
    { sourceWorkItemId: 'source', targetWorkItemId: 'a', type: 'blocks' },
    { sourceWorkItemId: 'source', targetWorkItemId: 'c', type: 'child' },
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

test('does not count children against the parent relation projection limit', () => {
  const children = Array.from({ length: 1_000 }, (_, index) => ({
    sourceWorkItemId: 'phase',
    targetWorkItemId: `task-${index}`,
    type: 'child' as const,
  }))

  expect(createWorkItemRelationIds([
    ...children,
    { sourceWorkItemId: 'phase', targetWorkItemId: 'root', type: 'parent' },
  ], 'phase')).toEqual(['parent:root'])
})

test('rejects relation creation before the Team link limit using the stored edge count', async () => {
  const store = createInMemoryRelationStore()
  store.seedGraph(4, 20_000)
  const client = store.createClient()

  await expect(client.createRelation('workspace-1', 'core-team', {
    sourceWorkItemId: 'source',
    targetWorkItemId: 'target',
    type: 'related',
    expectedGraphRevision: 4,
    sourceExpectedRevision: 1,
    targetExpectedRevision: 1,
  })).rejects.toMatchObject({
    code: 'WorkItemRelationGraphLimitExceeded',
    status: 413,
  })
  expect(store.transactions).toHaveLength(0)
})

test('counts legacy relation rows once when the graph row has no edge count', async () => {
  const store = createInMemoryRelationStore()
  store.seedRelation('a', 'b', 'related')
  store.seedGraph(2)
  const client = store.createClient()

  await client.createRelation('workspace-1', 'core-team', {
    sourceWorkItemId: 'c',
    targetWorkItemId: 'd',
    type: 'blocks',
    expectedGraphRevision: 2,
    sourceExpectedRevision: 1,
    targetExpectedRevision: 1,
  })

  expect(store.countQueries).toBe(1)
  expect(store.graph()).toMatchObject({ revision: 3, edgeCount: 4 })
})

test('rejects self, duplicate, and transitive cyclic relations before writing', async () => {
  const store = createInMemoryRelationStore()
  store.seedRelation('b', 'c', 'blocks')
  store.seedRelation('c', 'a', 'blocks')
  store.seedRelation('x', 'y', 'parent')
  store.seedRelation('y', 'z', 'parent')
  store.seedGraph(4, 8)
  const client = store.createClient()
  const create = (sourceWorkItemId: string, targetWorkItemId: string, type: 'blocks' | 'parent' | 'related') =>
    client.createRelation('workspace-1', 'core-team', {
      sourceWorkItemId,
      targetWorkItemId,
      type,
      expectedGraphRevision: 4,
      sourceExpectedRevision: 1,
      targetExpectedRevision: 1,
    })

  await expect(create('a', 'a', 'related')).rejects.toMatchObject({ code: 'WorkItemRelationSelf' })
  await expect(create('b', 'c', 'blocks')).rejects.toMatchObject({ code: 'WorkItemRelationDuplicate' })
  await expect(create('c', 'b', 'blocks')).rejects.toMatchObject({ code: 'WorkItemRelationCycle' })
  await expect(create('a', 'b', 'blocks')).rejects.toMatchObject({ code: 'WorkItemRelationCycle' })
  await expect(create('z', 'x', 'parent')).rejects.toMatchObject({ code: 'WorkItemRelationCycle' })
  expect(store.transactions).toHaveLength(0)
})

test('rejects a second parent and keeps blocks and related relations unchanged', async () => {
  const store = createInMemoryRelationStore()
  store.seedRelation('task', 'phase-a', 'parent')
  store.seedGraph(1, 2)
  const client = store.createClient()

  await expect(client.createRelation('workspace-1', 'core-team', {
    sourceWorkItemId: 'task',
    targetWorkItemId: 'phase-b',
    type: 'parent',
    expectedGraphRevision: 1,
    sourceExpectedRevision: 1,
    targetExpectedRevision: 1,
  })).rejects.toMatchObject({ code: 'WorkItemParentAlreadyExists', status: 409 })
  await client.createRelation('workspace-1', 'core-team', {
    sourceWorkItemId: 'task',
    targetWorkItemId: 'phase-b',
    type: 'blocks',
    expectedGraphRevision: 1,
    sourceExpectedRevision: 1,
    targetExpectedRevision: 1,
  })
  await client.createRelation('workspace-1', 'core-team', {
    sourceWorkItemId: 'task',
    targetWorkItemId: 'phase-b',
    type: 'related',
    expectedGraphRevision: 2,
    sourceExpectedRevision: 1,
    targetExpectedRevision: 1,
  })

  expect((await client.listRelations('workspace-1', 'core-team', 'task')).relations
    .map((relation) => `${relation.type}:${relation.targetWorkItemId}`))
    .toEqual(['blocks:phase-b', 'parent:phase-a', 'related:phase-b'])
})

test('replaces, removes, and sets a parent atomically', async () => {
  const store = createInMemoryRelationStore()
  store.seedRelation('task', 'phase-a', 'parent')
  store.seedRelation('task', 'other', 'related')
  store.seedGraph(5, 4)
  const client = store.createClient()

  expect(await client.replaceParent('workspace-1', 'core-team', {
    child: { workItemId: 'task', expectedRevision: 3 },
    currentParent: { workItemId: 'phase-a', expectedRevision: 1 },
    nextParent: { workItemId: 'phase-b', expectedRevision: 2, assignedProjectId: 'project-1' },
    expectedGraphRevision: 5,
  })).toEqual({ previousParentWorkItemId: 'phase-a', parentWorkItemId: 'phase-b', graphRevision: 6 })
  const replacement = store.transactions[0]?.TransactItems as Array<Record<string, unknown>>
  expect(replacement.map((item) => Object.keys(item)[0])).toEqual([
    'Update',
    'ConditionCheck',
    'ConditionCheck',
    'Put',
    'Delete',
    'Delete',
    'Put',
    'Put',
  ])
  expect(readEndpointProjections(store.transactions[0] ?? {})).toEqual([
    ['parent:phase-b', 'related:other'],
    undefined,
    undefined,
  ])
  expect((await client.listRelations('workspace-1', 'core-team', 'phase-a')).relations).toEqual([])
  expect((await client.listRelations('workspace-1', 'core-team', 'phase-b')).relations
    .map((relation) => `${relation.type}:${relation.targetWorkItemId}`)).toEqual(['child:task'])

  expect(await client.replaceParent('workspace-1', 'core-team', {
    child: { workItemId: 'task', expectedRevision: 3 },
    currentParent: { workItemId: 'phase-b', expectedRevision: 2, assignedProjectId: 'project-1' },
    expectedGraphRevision: 6,
  })).toEqual({ previousParentWorkItemId: 'phase-b', parentWorkItemId: null, graphRevision: 7 })
  expect(store.graph()).toMatchObject({ revision: 7, edgeCount: 2 })

  expect(await client.replaceParent('workspace-1', 'core-team', {
    child: { workItemId: 'task', expectedRevision: 3 },
    nextParent: { workItemId: 'phase-a', expectedRevision: 1 },
    expectedGraphRevision: 7,
  })).toEqual({ previousParentWorkItemId: null, parentWorkItemId: 'phase-a', graphRevision: 8 })
  expect(store.graph()).toMatchObject({ revision: 8, edgeCount: 4 })

  expect(await client.replaceParent('workspace-1', 'core-team', {
    child: { workItemId: 'task', expectedRevision: 3 },
    currentParent: { workItemId: 'phase-a', expectedRevision: 1 },
    nextParent: { workItemId: 'phase-a', expectedRevision: 1 },
    expectedGraphRevision: 8,
  })).toEqual({ previousParentWorkItemId: 'phase-a', parentWorkItemId: 'phase-a', graphRevision: 8 })
  expect(store.transactions).toHaveLength(3)
})

test('stores the sibling order rank with a parent change and reorders under the same parent', async () => {
  const store = createInMemoryRelationStore()
  store.seedRelation('task', 'phase-a', 'parent')
  store.seedGraph(5, 2)
  const client = store.createClient()
  /** Reads the child endpoint update of one transaction. */
  const childUpdate = (index: number): Record<string, unknown> | undefined => {
    const items = store.transactions[index]?.TransactItems
    const first: unknown = Array.isArray(items) ? items[0] : undefined
    if (typeof first !== 'object' || first === null || !('Update' in first)) return undefined
    const update: unknown = first.Update
    return typeof update === 'object' && update !== null ? Object.fromEntries(Object.entries(update)) : undefined
  }

  await client.replaceParent('workspace-1', 'core-team', {
    child: { workItemId: 'task', expectedRevision: 3 },
    currentParent: { workItemId: 'phase-a', expectedRevision: 1 },
    nextParent: { workItemId: 'phase-b', expectedRevision: 2 },
    expectedGraphRevision: 5,
    hierarchyRank: 'k',
  })
  expect(childUpdate(0)).toMatchObject({
    UpdateExpression: 'SET #relationIds = :relationIds, #hierarchyRank = :hierarchyRank',
    ExpressionAttributeValues: expect.objectContaining({ ':hierarchyRank': 'k' }),
  })

  expect(await client.replaceParent('workspace-1', 'core-team', {
    child: { workItemId: 'task', expectedRevision: 3 },
    currentParent: { workItemId: 'phase-b', expectedRevision: 2 },
    nextParent: { workItemId: 'phase-b', expectedRevision: 2 },
    expectedGraphRevision: 6,
    hierarchyRank: 'm',
  })).toEqual({ previousParentWorkItemId: 'phase-b', parentWorkItemId: 'phase-b', graphRevision: 7 })
  // The reorder writes only the child's rank and advances the graph revision it read.
  expect(store.transactions).toHaveLength(2)
  // A rank chosen from a stale outline, even one only a reorder ago, is refused.
  await expect(client.replaceParent('workspace-1', 'core-team', {
    child: { workItemId: 'task', expectedRevision: 3 },
    currentParent: { workItemId: 'phase-b', expectedRevision: 2 },
    nextParent: { workItemId: 'phase-b', expectedRevision: 2 },
    expectedGraphRevision: 6,
    hierarchyRank: 'n',
  })).rejects.toMatchObject({ code: 'WorkItemRelationGraphConflict', status: 409 })
  expect(store.transactions).toHaveLength(2)
  expect(childUpdate(1)).toMatchObject({
    TableName: 'work-items-table',
    UpdateExpression: 'SET #hierarchyRank = :hierarchyRank',
    ExpressionAttributeValues: expect.objectContaining({ ':hierarchyRank': 'm', ':revision': 3 }),
  })
  expect(store.transactions[1]?.TransactItems).toContainEqual({
    Put: expect.objectContaining({
      TableName: 'configuration-table',
      Item: expect.objectContaining({ revision: 7, edgeCount: 2 }),
      ConditionExpression: '#revision = :expectedRevision',
      ExpressionAttributeNames: { '#revision': 'revision' },
      ExpressionAttributeValues: { ':expectedRevision': 6 },
    }),
  })

  await client.replaceParent('workspace-1', 'core-team', {
    child: { workItemId: 'task', expectedRevision: 3 },
    currentParent: { workItemId: 'phase-b', expectedRevision: 2 },
    nextParent: { workItemId: 'phase-a', expectedRevision: 1 },
    expectedGraphRevision: 7,
  })
  expect(childUpdate(2)?.UpdateExpression).toBe('SET #relationIds = :relationIds REMOVE #hierarchyRank')

  await expect(client.replaceParent('workspace-1', 'core-team', {
    child: { workItemId: 'task', expectedRevision: 3 },
    currentParent: { workItemId: 'phase-a', expectedRevision: 1 },
    nextParent: { workItemId: 'phase-a', expectedRevision: 1 },
    expectedGraphRevision: 8,
    hierarchyRank: 'k0',
  })).rejects.toMatchObject({ code: 'InvalidWorkItemHierarchyRank', status: 400 })
})

test('reports a reorder canceled by a concurrent write as retryable while the graph revision is unchanged', async () => {
  const store = createInMemoryRelationStore({ cancelTransactions: true })
  store.seedRelation('task', 'phase-a', 'parent')
  store.seedGraph(5, 2)
  const client = store.createClient()

  await expect(client.replaceParent('workspace-1', 'core-team', {
    child: { workItemId: 'task', expectedRevision: 3 },
    currentParent: { workItemId: 'phase-a', expectedRevision: 1 },
    nextParent: { workItemId: 'phase-a', expectedRevision: 1 },
    expectedGraphRevision: 5,
    hierarchyRank: 'm',
  })).rejects.toMatchObject({ code: 'WorkItemRelationUnavailable', status: 503 })
  expect(store.graph()).toMatchObject({ revision: 5 })
})

test('returns success without writing when a lost-response retry finds the requested parent', async () => {
  const store = createInMemoryRelationStore()
  store.seedRelation('task', 'phase-a', 'parent')
  store.seedGraph(5, 2)
  const client = store.createClient()
  const input = {
    child: { workItemId: 'task', expectedRevision: 3 },
    currentParent: { workItemId: 'phase-a', expectedRevision: 1 },
    nextParent: { workItemId: 'phase-b', expectedRevision: 2 },
    expectedGraphRevision: 5,
  }

  expect(await client.replaceParent('workspace-1', 'core-team', input)).toMatchObject({
    parentWorkItemId: 'phase-b',
    graphRevision: 6,
  })
  expect(await client.replaceParent('workspace-1', 'core-team', input)).toMatchObject({
    parentWorkItemId: 'phase-b',
    graphRevision: 6,
  })
  expect(store.transactions).toHaveLength(1)
})

test('rejects a no-op parent replacement when the graph changes while the parent is read', async () => {
  let graphChanged = false
  const store = createInMemoryRelationStore({
    afterQuery: () => {
      if (graphChanged) return
      graphChanged = true
      store.seedGraph(6, 2)
    },
  })
  store.seedRelation('task', 'phase-b', 'parent')
  store.seedGraph(5, 2)
  const client = store.createClient()

  await expect(client.replaceParent('workspace-1', 'core-team', {
    child: { workItemId: 'task', expectedRevision: 3 },
    currentParent: { workItemId: 'phase-a', expectedRevision: 1 },
    nextParent: { workItemId: 'phase-b', expectedRevision: 2 },
    expectedGraphRevision: 5,
  })).rejects.toMatchObject({ code: 'WorkItemRelationGraphConflict', status: 409 })
  expect(store.transactions).toHaveLength(0)
})

test('keeps unexplained parent replacement cancellations retryable', async () => {
  const store = createInMemoryRelationStore({ cancelTransactions: true })
  store.seedRelation('task', 'phase-a', 'parent')
  store.seedGraph(5, 2)
  const client = store.createClient()

  await expect(client.replaceParent('workspace-1', 'core-team', {
    child: { workItemId: 'task', expectedRevision: 1 },
    currentParent: { workItemId: 'phase-a', expectedRevision: 1 },
    nextParent: { workItemId: 'phase-b', expectedRevision: 1 },
    expectedGraphRevision: 5,
  })).rejects.toMatchObject({ code: 'WorkItemRelationUnavailable', status: 503 })
  await expect(client.replaceParent('workspace-1', 'core-team', {
    child: { workItemId: 'task', expectedRevision: 2 },
    currentParent: { workItemId: 'phase-a', expectedRevision: 1 },
    nextParent: { workItemId: 'phase-b', expectedRevision: 1 },
    expectedGraphRevision: 5,
  })).rejects.toMatchObject({ code: 'WorkItemRelationGraphConflict', status: 409 })
})

test('rejects a stale or cyclic parent replacement before writing', async () => {
  const store = createInMemoryRelationStore()
  store.seedRelation('task', 'phase', 'parent')
  store.seedRelation('phase', 'root', 'parent')
  store.seedGraph(2, 4)
  const client = store.createClient()

  await expect(client.replaceParent('workspace-1', 'core-team', {
    child: { workItemId: 'task', expectedRevision: 1 },
    nextParent: { workItemId: 'root', expectedRevision: 1 },
    expectedGraphRevision: 2,
  })).rejects.toMatchObject({ code: 'WorkItemRelationGraphConflict', status: 409 })
  await expect(client.replaceParent('workspace-1', 'core-team', {
    child: { workItemId: 'root', expectedRevision: 1 },
    nextParent: { workItemId: 'task', expectedRevision: 1 },
    expectedGraphRevision: 2,
  })).rejects.toMatchObject({ code: 'WorkItemRelationCycle', status: 409 })
  await expect(client.replaceParent('workspace-1', 'core-team', {
    child: { workItemId: 'task', expectedRevision: 1 },
    currentParent: { workItemId: 'phase', expectedRevision: 1 },
    nextParent: { workItemId: 'task', expectedRevision: 1 },
    expectedGraphRevision: 2,
  })).rejects.toMatchObject({ code: 'WorkItemRelationSelf', status: 400 })
  await expect(client.replaceParent('workspace-1', 'core-team', {
    child: { workItemId: 'task', expectedRevision: 1 },
    currentParent: { workItemId: 'phase', expectedRevision: 1 },
    nextParent: { workItemId: 'root', expectedRevision: 1 },
    expectedGraphRevision: 1,
  })).rejects.toMatchObject({ code: 'WorkItemRelationGraphConflict', status: 409 })
  expect(store.transactions).toHaveLength(0)
})

test('builds, reads, and re-parents a 5,000 link WBS by reading only endpoint neighbourhoods', async () => {
  const store = createInMemoryRelationStore()
  const client = store.createClient()
  let graphRevision = 0
  const link = async (child: string, parent: string) => {
    const response = await client.createRelation('workspace-1', 'core-team', {
      sourceWorkItemId: child,
      targetWorkItemId: parent,
      type: 'parent',
      expectedGraphRevision: graphRevision,
      sourceExpectedRevision: 1,
      targetExpectedRevision: 1,
    })
    graphRevision = response.graphRevision
  }
  for (let phase = 0; phase < 20; phase += 1) {
    await link(`phase-${phase}`, 'root')
    for (let task = 0; task < 249; task += 1) {
      await link(`task-${phase}-${task}`, `phase-${phase}`)
    }
  }

  expect(store.graph()).toMatchObject({ revision: 5_000, edgeCount: 10_000 })
  expect(store.maxRowsReadPerOperation).toBeLessThanOrEqual(3)
  expect((await client.listRelations('workspace-1', 'core-team', 'root')).relations).toHaveLength(20)
  expect((await client.listRelations('workspace-1', 'core-team', 'phase-3')).relations).toHaveLength(250)

  store.resetReadCounters()
  await client.replaceParent('workspace-1', 'core-team', {
    child: { workItemId: 'task-3-10', expectedRevision: 1 },
    currentParent: { workItemId: 'phase-3', expectedRevision: 1 },
    nextParent: { workItemId: 'phase-4', expectedRevision: 1 },
    expectedGraphRevision: graphRevision,
  })
  expect(store.rowsRead).toBeLessThanOrEqual(5)
  expect((await client.listRelations('workspace-1', 'core-team', 'phase-4', {
    types: ['child'],
  })).relations).toHaveLength(250)
  expect((await client.listRelationGraph('workspace-1', 'core-team')).relations).toHaveLength(10_000)
}, 60_000)

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

/** Relation rows and graph metadata held by the in-memory configuration table fake. */
type InMemoryRelationStore = {
  /** Committed TransactWrite inputs. */
  transactions: Array<Record<string, unknown>>
  /** Key prefixes of every attribute Query in call order. */
  queryPrefixes: string[]
  /** Number of COUNT queries issued. */
  countQueries: number
  /** Relation rows returned since the last reset. */
  rowsRead: number
  /** Largest number of relation rows read between two transactions. */
  maxRowsReadPerOperation: number
  /** Adds a reciprocal relation pair without a transaction. */
  seedRelation(sourceWorkItemId: string, targetWorkItemId: string, type: string): void
  /** Stores graph metadata; omitting the edge count simulates a legacy row. */
  seedGraph(revision: number, edgeCount?: number): void
  /** Returns the stored graph metadata row. */
  graph(): Record<string, unknown> | undefined
  /** Resets the row read counters. */
  resetReadCounters(): void
  /** Creates a configuration client backed by this fake. */
  createClient(): DynamoDbWorkItemConfigurationClient
}

/**
 * Creates an in-memory configuration table that understands relation key prefixes.
 *
 * @param options - Set `cancelTransactions` to make every TransactWrite fail as canceled.
 *
 * @returns The fake store and its counters.
 */
function createInMemoryRelationStore(
  options: { cancelTransactions?: boolean; afterQuery?: (prefix: string) => void } = {},
): InMemoryRelationStore {
  const scopeKey = 'workspace-1#team#core-team#work-item-configuration'
  const rows = new Map<string, Record<string, unknown>>()
  const rowsBySource = new Map<string, Map<string, Record<string, unknown>>>()
  const sourceOf = (recordKey: string) => recordKey.split('#')[1] ?? ''
  const setRow = (recordKey: string, item: Record<string, unknown>) => {
    rows.set(recordKey, item)
    if (!recordKey.startsWith('REL#')) return
    const sourceRows = rowsBySource.get(sourceOf(recordKey)) ?? new Map<string, Record<string, unknown>>()
    sourceRows.set(recordKey, item)
    rowsBySource.set(sourceOf(recordKey), sourceRows)
  }
  const deleteRow = (recordKey: string) => {
    rows.delete(recordKey)
    rowsBySource.get(sourceOf(recordKey))?.delete(recordKey)
  }
  let rowsSinceTransaction = 0
  const store: InMemoryRelationStore = {
    transactions: [],
    queryPrefixes: [],
    countQueries: 0,
    rowsRead: 0,
    maxRowsReadPerOperation: 0,
    seedRelation(sourceWorkItemId, targetWorkItemId, type) {
      const reciprocal: Record<string, string> = {
        parent: 'child',
        child: 'parent',
        blocks: 'blockedBy',
        blockedBy: 'blocks',
        related: 'related',
        duplicate: 'duplicate',
      }
      for (const item of [
        relationItem(sourceWorkItemId, targetWorkItemId, type),
        relationItem(targetWorkItemId, sourceWorkItemId, reciprocal[type] ?? type),
      ]) {
        setRow(item.recordKey, item)
      }
    },
    seedGraph(revision, edgeCount) {
      setRow('RELATION_GRAPH', {
        scopeKey,
        recordKey: 'RELATION_GRAPH',
        entryType: 'relation-graph',
        schemaVersion: 1,
        revision,
        ...(edgeCount === undefined ? {} : { edgeCount }),
      })
    },
    graph() {
      return rows.get('RELATION_GRAPH')
    },
    resetReadCounters() {
      store.rowsRead = 0
      store.maxRowsReadPerOperation = 0
      rowsSinceTransaction = 0
    },
    createClient() {
      const documentClient = {
        async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
          const input = command.input
          if (command.constructor.name === 'GetCommand') {
            const key = input.Key as Record<string, string>
            if (input.TableName !== 'configuration-table') {
              return { Item: { revision: 1 } }
            }
            return key.recordKey ? { Item: rows.get(key.recordKey) } : {}
          }
          if (command.constructor.name === 'QueryCommand') {
            const values = input.ExpressionAttributeValues as Record<string, string>
            const prefix = values[':prefix'] ?? ''
            const candidates = prefix === 'REL#'
              ? rows
              : rowsBySource.get(sourceOf(prefix)) ?? new Map<string, Record<string, unknown>>()
            const items = [...candidates.entries()]
              .filter(([recordKey]) => recordKey.startsWith(prefix))
              .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
              .map(([, item]) => item)
            if (input.Select === 'COUNT') {
              store.countQueries += 1
              return { Count: items.length }
            }
            store.queryPrefixes.push(prefix)
            store.rowsRead += items.length
            rowsSinceTransaction += items.length
            options.afterQuery?.(prefix)
            return { Items: items }
          }
          if (command.constructor.name === 'TransactWriteCommand' && options.cancelTransactions) {
            throw { name: 'TransactionCanceledException' }
          }
          if (command.constructor.name === 'TransactWriteCommand') {
            store.maxRowsReadPerOperation = Math.max(store.maxRowsReadPerOperation, rowsSinceTransaction)
            rowsSinceTransaction = 0
            store.transactions.push(input)
            for (const item of input.TransactItems as Array<Record<string, Record<string, unknown>>>) {
              if (item.Put?.TableName === 'configuration-table') {
                const putItem = item.Put.Item as Record<string, unknown>
                setRow(String(putItem.recordKey), putItem)
              }
              if (item.Delete?.TableName === 'configuration-table') {
                const key = item.Delete.Key as Record<string, string>
                deleteRow(String(key.recordKey))
              }
            }
            return {}
          }
          return {}
        },
      } as unknown as DynamoDBDocumentClient
      return new DynamoDbWorkItemConfigurationClient(
        'configuration-table',
        'work-items-table',
        documentClient,
        {} as DynamoDBClient,
      )
    },
  }
  return store
}

/**
 * Reads the `relationIds` written to each endpoint, or undefined for condition-only endpoints.
 *
 * @param transaction - TransactWrite input.
 * @returns One entry per Work Item endpoint in transaction order.
 */
function readEndpointProjections(transaction: Record<string, unknown>) {
  return (transaction.TransactItems as Array<Record<string, Record<string, unknown>>>)
    .filter((item) =>
      item.Update?.TableName === 'work-items-table' ||
      item.ConditionCheck?.TableName === 'work-items-table'
    )
    .map((item) => {
      const values = item.Update?.ExpressionAttributeValues as Record<string, unknown> | undefined
      return values?.[':relationIds']
    })
}

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

test('validates the parent completion policy', () => {
  expect(createConfiguration({ parentCompletionPolicy: 'reject' }).parentCompletionPolicy).toBe('reject')
  expect(createConfiguration().parentCompletionPolicy).toBeUndefined()
  expect(() => validateWorkItemConfiguration({
    ...structuredClone(DEFAULT_WORK_ITEM_CONFIGURATION),
    scopeId: 'workspace-1',
    parentCompletionPolicy: 'block',
  })).toThrow('Parent completion policy must be warn or reject.')
})
