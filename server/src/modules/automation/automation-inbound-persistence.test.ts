import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import type { CreateAutomationInboundWebhookEndpointInput } from '@mukuroji/contracts'
import {
  AUTOMATION_INBOUND_WEBHOOK_SECRET_CLEANUP_GRACE_MS,
  AUTOMATION_INBOUND_WEBHOOK_SECRET_RECOVERY_MS,
  DynamoDbAutomationRepository,
} from './adapter-out/dynamodb/automation-repository'
import {
  createAutomationInboundWebhookSecretId,
} from './adapter-out/inbound-webhook-secret-id'

/**
 * Creates an in-memory DynamoDB document client probe for inbound webhook persistence tests.
 *
 * @returns The probe client and its inspection helpers.
 */
function createInboundWebhookDocumentProbe() {
  const items = new Map<string, Record<string, unknown>>()
  let transactionCalls = 0
  /**
   * Derives the in-memory map key for an item or key.
   *
   * @param tableName - Table that owns the item.
   * @param value - Item or key attributes.
   * @returns The map key.
   */
  const keyFor = (tableName: string, value: Record<string, unknown>) => {
    if (typeof value.scopeKey === 'string' && typeof value.recordKey === 'string') {
      return `${tableName}\0${value.scopeKey}\0${value.recordKey}`
    }
    if (typeof value.directoryId === 'string' && typeof value.eventId === 'string') {
      return `${tableName}\0${value.directoryId}\0${value.eventId}`
    }
    if (typeof value.directoryId === 'string' && typeof value.entryKey === 'string') {
      return `${tableName}\0${value.directoryId}\0${value.entryKey}`
    }
    throw new Error('Test item key is invalid.')
  }
  const readExisting = (tableName: string, key: Record<string, unknown>) =>
    items.get(keyFor(tableName, key))
  const conditionMatches = (
    tableName: string,
    key: Record<string, unknown>,
    conditionExpression?: string,
    expressionAttributeNames: Record<string, string> = {},
    expressionAttributeValues: Record<string, unknown> = {},
  ) => {
    if (!conditionExpression) return true
    const existing = readExisting(tableName, key)
    if (conditionExpression.includes('attribute_not_exists(scopeKey) OR')) {
      if (!existing) return true
      const entryTypeField = expressionAttributeNames['#entryType'] ?? 'entryType'
      const schemaVersionField = expressionAttributeNames['#schemaVersion'] ?? 'schemaVersion'
      const revisionField = expressionAttributeNames['#revision'] ?? 'revision'
      return existing[entryTypeField] === expressionAttributeValues[':entryType'] &&
        existing[schemaVersionField] === expressionAttributeValues[':schemaVersion'] &&
        typeof existing[revisionField] === 'number' &&
        existing[revisionField] >= Number(expressionAttributeValues[':one'])
    }
    if (conditionExpression.includes('attribute_not_exists')) return existing === undefined
    if (!existing) return false

    const comparisons = new Map<string, unknown[]>()
    for (const match of conditionExpression.matchAll(/(#[A-Za-z0-9_]+)\s*=\s*(:[A-Za-z0-9_]+)/g)) {
      const field = expressionAttributeNames[match[1]!] ?? match[1]!.slice(1)
      const values = comparisons.get(field) ?? []
      values.push(expressionAttributeValues[match[2]!])
      comparisons.set(field, values)
    }
    return [...comparisons].every(([field, expectedValues]) =>
      expectedValues.some((expected) => existing[field] === expected)
    )
  }
  const transactionConflict = (reasons: boolean[]) => Object.assign(
    new Error('transaction condition failed'),
    {
      name: 'TransactionCanceledException',
      CancellationReasons: reasons.map((failed) => ({
        Code: failed ? 'ConditionalCheckFailed' : 'None',
      })),
    },
  )
  const documentClient = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const input = command.input
      if (command.constructor.name === 'GetCommand') {
        const tableName = String(input.TableName)
        const item = readExisting(tableName, input.Key as Record<string, unknown>)
        return item ? { Item: structuredClone(item) } : {}
      }
      if (command.constructor.name === 'QueryCommand') {
        const tableName = String(input.TableName)
        const values = input.ExpressionAttributeValues as Record<string, unknown>
        if (input.IndexName === 'ScheduleDueIndex') {
          return {
            Items: [...items.entries()]
              .filter(([key, item]) =>
                key.startsWith(`${tableName}\0`) &&
                item.scheduleShard === values[':scheduleShard'] &&
                typeof item.nextRunAtRecordKey === 'string' &&
                item.nextRunAtRecordKey <= String(values[':due'])
              )
              .sort(([, first], [, second]) =>
                String(first.nextRunAtRecordKey).localeCompare(String(second.nextRunAtRecordKey))
              )
              .slice(0, Number(input.Limit ?? 100))
              .map(([, item]) => structuredClone(item)),
          }
        }
        const scopeKey = values[':scopeKey']
        const recordPrefix = values[':prefix']
        const entryType = values[':entryType']
        return {
          Items: [...items.entries()]
            .filter(([key, item]) =>
              key.startsWith(`${tableName}\0`) &&
              item.scopeKey === scopeKey &&
              typeof item.recordKey === 'string' &&
              item.recordKey.startsWith(String(recordPrefix)) &&
              (entryType === undefined || item.entryType === entryType)
            )
            .map(([, item]) => structuredClone(item)),
        }
      }
      if (Array.isArray(input.TransactItems)) {
        transactionCalls += 1
        const transactionItems = input.TransactItems as Array<Record<string, Record<string, unknown>>>
        const failures = transactionItems.map((transactionItem) => {
          const action = transactionItem.Put ?? transactionItem.Delete ??
            transactionItem.Update ?? transactionItem.ConditionCheck
          const tableName = String(action.TableName)
          const key = (action.Item ?? action.Key) as Record<string, unknown>
          return !conditionMatches(
            tableName,
            key,
            action.ConditionExpression as string | undefined,
            action.ExpressionAttributeNames as Record<string, string> | undefined,
            action.ExpressionAttributeValues as Record<string, unknown> | undefined,
          )
        })
        if (failures.some(Boolean)) throw transactionConflict(failures)

        for (const transactionItem of transactionItems) {
          if (transactionItem.Put) {
            const tableName = String(transactionItem.Put.TableName)
            const item = transactionItem.Put.Item as Record<string, unknown>
            items.set(keyFor(tableName, item), structuredClone(item))
          } else if (transactionItem.Delete) {
            const tableName = String(transactionItem.Delete.TableName)
            items.delete(keyFor(
              tableName,
              transactionItem.Delete.Key as Record<string, unknown>,
            ))
          } else if (transactionItem.Update) {
            const update = transactionItem.Update
            const tableName = String(update.TableName)
            const key = update.Key as Record<string, unknown>
            const existing = readExisting(tableName, key)
            const updated = structuredClone(existing ?? key)
            const names = update.ExpressionAttributeNames as Record<string, string>
            const values = update.ExpressionAttributeValues as Record<string, unknown>
            if (String(update.UpdateExpression).includes('if_not_exists')) {
              const entryTypeField = names['#entryType'] ?? 'entryType'
              const revisionField = names['#revision'] ?? 'revision'
              const schemaVersionField = names['#schemaVersion'] ?? 'schemaVersion'
              updated[entryTypeField] = values[':entryType']
              updated[schemaVersionField] = values[':schemaVersion']
              updated[revisionField] =
                (typeof existing?.[revisionField] === 'number'
                  ? existing[revisionField]
                  : Number(values[':zero'])) + Number(values[':one'])
            }
            for (const match of String(update.UpdateExpression)
              .matchAll(/(#[A-Za-z0-9_]+)\s*=\s*(:[A-Za-z0-9_]+)/g)) {
              updated[names[match[1]!] ?? match[1]!.slice(1)] = values[match[2]!]
            }
            items.set(keyFor(tableName, key), updated)
          }
        }
        return {}
      }
      if (command.constructor.name === 'PutCommand') {
        const tableName = String(input.TableName)
        const item = input.Item as Record<string, unknown>
        if (!conditionMatches(
          tableName,
          item,
          input.ConditionExpression as string | undefined,
          input.ExpressionAttributeNames as Record<string, string> | undefined,
          input.ExpressionAttributeValues as Record<string, unknown> | undefined,
        )) {
          throw Object.assign(new Error('put condition failed'), {
            name: 'ConditionalCheckFailedException',
          })
        }
        items.set(keyFor(tableName, item), structuredClone(item))
        return {}
      }
      if (command.constructor.name === 'DeleteCommand') {
        const tableName = String(input.TableName)
        const key = input.Key as Record<string, unknown>
        if (!conditionMatches(
          tableName,
          key,
          input.ConditionExpression as string | undefined,
          input.ExpressionAttributeNames as Record<string, string> | undefined,
          input.ExpressionAttributeValues as Record<string, unknown> | undefined,
        )) {
          throw Object.assign(new Error('delete condition failed'), {
            name: 'ConditionalCheckFailedException',
          })
        }
        items.delete(keyFor(tableName, key))
        return {}
      }
      throw new Error(`Unexpected command: ${command.constructor.name}`)
    },
  } as unknown as ConstructorParameters<typeof DynamoDbAutomationRepository>[1]
  return {
    documentClient,
    items,
    get transactionCalls() {
      return transactionCalls
    },
  }
}

function fingerprint(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function auditPut(eventId: string) {
  return {
    Put: {
      TableName: 'AuditTable',
      Item: { directoryId: 'workspace-1', eventId },
      ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(eventId)',
    },
  }
}

describe('DynamoDB inbound webhook lifecycle', () => {
  test('keeps global lookup workspace-safe, redacts secrets, and rejects superseded recovery', async () => {
    const probe = createInboundWebhookDocumentProbe()
    const client = new DynamoDbAutomationRepository('AutomationTable', probe.documentClient)
    const createdProvisioning = await client.reserveCreateInboundWebhookEndpoint(
      'workspace-1',
      'actor-1',
      { name: 'Build events' },
      'create-key-1',
      'https://api.example.com/prod',
    )
    const created = await client.completeInboundWebhookProvisioning(createdProvisioning)
    expect(created.secretId).toBe(
      createAutomationInboundWebhookSecretId('workspace-1', created.id),
    )
    expect(created.endpointUrl).toBe(
      `https://api.example.com/prod/api/automation/inbound-webhooks/${created.opaqueEndpointId}`,
    )
    const listed = await client.listInboundWebhookEndpoints('workspace-1')
    expect(listed).toEqual([expect.objectContaining({ id: created.id, status: 'active' })])
    expect(listed[0]).not.toHaveProperty('secretId')
    expect(listed[0]).not.toHaveProperty('secretVersionId')
    expect(listed[0]).not.toHaveProperty('provisioningOperationId')
    expect((await client.resolveInboundWebhookEndpoint(created.opaqueEndpointId))?.workspaceId)
      .toBe('workspace-1')

    const replay = await client.reserveCreateInboundWebhookEndpoint(
      'workspace-1',
      'actor-1',
      { name: 'Build events' },
      'create-key-1',
      'https://ignored.example.com',
    )
    expect(replay.endpoint.secretVersionId).toBe(created.secretVersionId)

    const rotatedProvisioning = await client.reserveRotateInboundWebhookEndpoint(
      'workspace-1',
      'actor-1',
      created.id,
      { expectedRevision: created.revision },
      'rotate-key-1',
    )
    const rotated = await client.completeInboundWebhookProvisioning(rotatedProvisioning)
    expect(rotated).toMatchObject({
      status: 'active',
      secretGeneration: 2,
      revision: created.revision + 2,
    })
    await expect(client.completeInboundWebhookProvisioning(createdProvisioning))
      .rejects.toMatchObject({ code: 'AutomationInboundWebhookLifecycleConflict' })
    await expect(client.reserveCreateInboundWebhookEndpoint(
      'workspace-1',
      'actor-1',
      { name: 'Build events' },
      'create-key-1',
      'https://api.example.com',
    )).rejects.toMatchObject({ code: 'AutomationInboundWebhookSecretSuperseded' })

    const other = await client.reserveCreateInboundWebhookEndpoint(
      'workspace-2',
      'actor-2',
      { name: 'Other workspace' },
      'create-key-2',
      'https://api.example.com',
    )
    expect((await client.resolveInboundWebhookEndpoint(other.endpoint.opaqueEndpointId))?.workspaceId)
      .toBe('workspace-2')
  })

  test('allows an administrator to abort keyless provisioning with a guarded revoke', async () => {
    const probe = createInboundWebhookDocumentProbe()
    const client = new DynamoDbAutomationRepository('AutomationTable', probe.documentClient)
    const provisioning = await client.reserveCreateInboundWebhookEndpoint(
      'workspace-1',
      'actor-1',
      { name: 'Abandoned create' },
      'lost-key',
      'https://api.example.com',
    )
    const revoked = await client.revokeInboundWebhookEndpoint(
      'workspace-1',
      provisioning.endpoint.id,
      { expectedRevision: provisioning.endpoint.revision },
    )
    expect(revoked).toMatchObject({ status: 'revoked' })
    expect(revoked).not.toHaveProperty('provisioningOperationId')
    expect(await client.resolveInboundWebhookEndpoint(provisioning.endpoint.opaqueEndpointId))
      .toBeUndefined()
    const cleanupItem = [...probe.items.values()].find((item) =>
      item.entryType === 'inbound-webhook-secret-cleanup'
    )
    expect(cleanupItem).toMatchObject({
      endpointId: provisioning.endpoint.id,
      secretId: provisioning.endpoint.secretId,
      revision: 1,
    })
    const cleanupShard = String(cleanupItem?.scheduleShard)
    const nextCleanupAt = String(cleanupItem?.nextCleanupAt)
    expect(await client.listDueInboundWebhookSecretCleanups(
      cleanupShard,
      new Date(Date.parse(nextCleanupAt) - 1).toISOString(),
    )).toEqual([])
    const [cleanup] = await client.listDueInboundWebhookSecretCleanups(
      cleanupShard,
      nextCleanupAt,
    )
    expect(cleanup).toBeDefined()
    expect(Date.parse(cleanup!.cleanupUntil) - Date.parse(cleanup!.createdAt)).toBe(
      AUTOMATION_INBOUND_WEBHOOK_SECRET_RECOVERY_MS +
        AUTOMATION_INBOUND_WEBHOOK_SECRET_CLEANUP_GRACE_MS,
    )
    await client.completeInboundWebhookSecretCleanup(cleanup!, nextCleanupAt)
    const [rescheduledCleanup] = await client.listDueInboundWebhookSecretCleanups(
      cleanupShard,
      cleanup!.cleanupUntil,
    )
    expect(rescheduledCleanup).toMatchObject({ revision: 2 })
    await client.completeInboundWebhookSecretCleanup(
      rescheduledCleanup!,
      rescheduledCleanup!.cleanupUntil,
    )
    expect([...probe.items.values()].some((item) =>
      item.entryType === 'inbound-webhook-secret-cleanup'
    )).toBe(false)
    await expect(client.completeInboundWebhookProvisioning(provisioning))
      .rejects.toMatchObject({ code: 'AutomationInboundWebhookLifecycleConflict' })
    expect((await client.revokeInboundWebhookEndpoint(
      'workspace-1',
      provisioning.endpoint.id,
      { expectedRevision: provisioning.endpoint.revision },
    )).status).toBe('revoked')
  })

  test('bounds plaintext recovery and rejects non-loopback HTTP endpoint URLs', async () => {
    const probe = createInboundWebhookDocumentProbe()
    const client = new DynamoDbAutomationRepository('AutomationTable', probe.documentClient)
    await expect(client.reserveCreateInboundWebhookEndpoint(
      'workspace-1',
      'actor-1',
      { name: 'Insecure' },
      'insecure-key',
      'http://example.com',
    )).rejects.toMatchObject({ code: 'InvalidAutomationInput' })
    const provisioning = await client.reserveCreateInboundWebhookEndpoint(
      'workspace-1',
      'actor-1',
      { name: 'Local' },
      'local-key',
      'http://127.0.0.1:3000',
    )
    await client.completeInboundWebhookProvisioning(provisioning)
    const operationItem = [...probe.items.values()].find((item) =>
      item.entryType === 'inbound-webhook-provisioning' && item.id === provisioning.operation.id
    )!
    operationItem.createdAt = '2026-07-14T00:00:00.000Z'
    operationItem.recoveryExpiresAt = '2026-07-15T00:00:00.000Z'
    await expect(client.reserveCreateInboundWebhookEndpoint(
      'workspace-1',
      'actor-1',
      { name: 'Local' },
      'local-key',
      'http://127.0.0.1:3000',
    )).rejects.toMatchObject({ code: 'AutomationInboundWebhookSecretRecoveryExpired' })
  })

  test('requires active webhook trigger targets while preserving create replay and safe edits', async () => {
    const probe = createInboundWebhookDocumentProbe()
    const client = new DynamoDbAutomationRepository('AutomationTable', probe.documentClient)
    const provisioning = await client.reserveCreateInboundWebhookEndpoint(
      'workspace-1',
      'actor-1',
      { name: 'Rule target' },
      'endpoint-key',
      'https://api.example.com',
    )
    const endpoint = await client.completeInboundWebhookProvisioning(provisioning)
    const ruleInput = {
      name: 'Inbound deploy rule',
      enabled: false,
      trigger: { type: 'webhook' as const, webhookId: endpoint.id },
      actions: [{ type: 'comment' as const, body: 'Received' }],
    }
    const rule = await client.createRule('workspace-1', ruleInput, 'rule-key')
    await client.setInboundWebhookEndpointStatus(
      'workspace-1',
      endpoint.id,
      { expectedRevision: endpoint.revision },
      'paused',
    )

    expect((await client.completeInboundWebhookProvisioning(provisioning)).status).toBe('paused')
    expect(await client.createRule('workspace-1', ruleInput, 'rule-key')).toEqual(rule)
    const renamed = await client.updateRule('workspace-1', rule.id, {
      expectedRevision: rule.revision,
      name: 'Renamed while endpoint is paused',
    })
    expect(renamed.name).toBe('Renamed while endpoint is paused')
    await expect(client.updateRule('workspace-1', rule.id, {
      expectedRevision: renamed.revision,
      enabled: true,
    })).rejects.toMatchObject({ code: 'AutomationInboundWebhookTriggerUnavailable' })
    await expect(client.updateRule('workspace-1', rule.id, {
      expectedRevision: renamed.revision,
      trigger: { type: 'webhook', webhookId: 'missing-endpoint' },
    })).rejects.toMatchObject({ code: 'AutomationInboundWebhookTriggerUnavailable' })
    await expect(client.createRule('workspace-1', {
      ...ruleInput,
      name: 'Missing target',
      trigger: { type: 'webhook', webhookId: 'missing-endpoint' },
    }, 'missing-rule-key')).rejects.toMatchObject({
      code: 'AutomationInboundWebhookTriggerUnavailable',
    })
  })

  test('stores the endpoint purpose and keeps Triage endpoints out of Automation triggers', async () => {
    const probe = createInboundWebhookDocumentProbe()
    const client = new DynamoDbAutomationRepository('AutomationTable', probe.documentClient)
    const automation = await client.completeInboundWebhookProvisioning(await client.reserveCreateInboundWebhookEndpoint(
      'workspace-1', 'actor-1', { name: 'Builds' }, 'automation-key', 'https://api.example.com',
    ))
    const triage = await client.completeInboundWebhookProvisioning(await client.reserveCreateInboundWebhookEndpoint(
      'workspace-1', 'actor-1', { name: 'Status page', purpose: 'triage', triageRouting: { teamId: 'support' } }, 'triage-key', 'https://api.example.com',
    ))
    expect(automation.purpose).toBe('automation')
    expect(triage).toMatchObject({ purpose: 'triage', triageRouting: { teamId: 'support' } })
    // A server from before purposes resolves only `inbound-webhook-lookup`, so a Triage endpoint
    // gets its own lookup type and stays unknown to it after a rollback.
    const lookupTypes = [...probe.items.values()]
      .filter((item) => typeof item.entryType === 'string' && item.entryType.startsWith('inbound-webhook') && item.entryType.endsWith('lookup'))
      .map((item) => [item.endpointId, item.entryType])
    expect(lookupTypes).toEqual(expect.arrayContaining([
      [automation.id, 'inbound-webhook-lookup'],
      [triage.id, 'inbound-webhook-triage-lookup'],
    ]))
    expect((await client.resolveInboundWebhookEndpoint(triage.opaqueEndpointId))?.id).toBe(triage.id)
    expect((await client.resolveInboundWebhookEndpoint(automation.opaqueEndpointId))?.id).toBe(automation.id)
    // A lookup whose kind does not match the endpoint purpose resolves nothing.
    for (const item of probe.items.values()) {
      if (item.endpointId === triage.id && item.entryType === 'inbound-webhook-triage-lookup') item.entryType = 'inbound-webhook-lookup'
    }
    expect(await client.resolveInboundWebhookEndpoint(triage.opaqueEndpointId)).toBeUndefined()
    await expect(client.createRule('workspace-1', {
      name: 'Hijack Triage endpoint',
      enabled: false,
      trigger: { type: 'webhook', webhookId: triage.id },
      actions: [{ type: 'comment', body: 'Received' }],
    }, 'hijack-key')).rejects.toMatchObject({ code: 'AutomationInboundWebhookTriggerUnavailable' })
  })

  test('stores Triage endpoint rows under their own entry type through the lifecycle', async () => {
    const probe = createInboundWebhookDocumentProbe()
    const client = new DynamoDbAutomationRepository('AutomationTable', probe.documentClient)
    const automation = await client.completeInboundWebhookProvisioning(await client.reserveCreateInboundWebhookEndpoint(
      'workspace-1', 'actor-1', { name: 'Builds' }, 'automation-key', 'https://api.example.com',
    ))
    let triage = await client.completeInboundWebhookProvisioning(await client.reserveCreateInboundWebhookEndpoint(
      'workspace-1', 'actor-1', { name: 'Status page', purpose: 'triage', triageRouting: { teamId: 'support' } }, 'triage-key', 'https://api.example.com',
    ))
    /**
     * Returns the stored endpoint rows as [endpoint ID, entry type] pairs.
     *
     * @returns The endpoint rows of workspace-1.
     */
    const endpointRows = () => [...probe.items.values()]
      .filter((item) => typeof item.recordKey === 'string' && item.recordKey.startsWith('INBOUND_WEBHOOK#'))
      .map((item) => [item.id, item.entryType])
    /**
     * Asserts both endpoint rows keep their purpose-specific entry types.
     */
    const expectRowShapes = () => {
      expect(endpointRows()).toEqual(expect.arrayContaining([
        [automation.id, 'inbound-webhook'],
        [triage.id, 'inbound-webhook-triage'],
      ]))
      expect(endpointRows()).toHaveLength(2)
    }
    expectRowShapes()
    // A server from before purposes gets and lists only `inbound-webhook` rows, so after a
    // rollback it sees only the Automation endpoint.
    expect(endpointRows().filter(([, entryType]) => entryType === 'inbound-webhook').map(([id]) => id))
      .toEqual([automation.id])

    expect((await client.listInboundWebhookEndpoints('workspace-1')).map((endpoint) => [endpoint.id, endpoint.purpose]))
      .toEqual(expect.arrayContaining([[automation.id, 'automation'], [triage.id, 'triage']]))
    expect(await client.getInboundWebhookEndpoint('workspace-1', triage.id))
      .toMatchObject({ id: triage.id, purpose: 'triage', triageRouting: { teamId: 'support' } })
    expect((await client.resolveInboundWebhookEndpoint(triage.opaqueEndpointId))?.id).toBe(triage.id)

    const renamed = await client.updateInboundWebhookEndpoint('workspace-1', triage.id, { expectedRevision: triage.revision, name: 'Status page alerts' })
    const paused = await client.setInboundWebhookEndpointStatus('workspace-1', triage.id, { expectedRevision: renamed.revision }, 'paused')
    const resumed = await client.setInboundWebhookEndpointStatus('workspace-1', triage.id, { expectedRevision: paused.revision }, 'active')
    expectRowShapes()
    triage = await client.completeInboundWebhookProvisioning(await client.reserveRotateInboundWebhookEndpoint(
      'workspace-1', 'actor-1', triage.id, { expectedRevision: resumed.revision }, 'rotate-key',
    ))
    expect(triage).toMatchObject({ name: 'Status page alerts', status: 'active', secretGeneration: 2 })
    expectRowShapes()
    // The delivery's active-endpoint condition matches the Triage row's entry type.
    await client.recordInboundWebhookDelivery(triage, {
      idempotencyKey: 'delivery-key',
      bodyFingerprint: fingerprint('raw body'),
      signatureFingerprint: fingerprint('signature-1'),
      signatureTimestamp: '1784160000',
      eventId: 'event-1',
      auditMutation: auditPut('event-1'),
    })
    await client.revokeInboundWebhookEndpoint('workspace-1', triage.id, { expectedRevision: triage.revision })
    expectRowShapes()
    expect((await client.resolveAcceptedTriageWebhookDelivery(triage.opaqueEndpointId, 'delivery-key'))?.endpoint)
      .toMatchObject({ id: triage.id, status: 'revoked' })
    expect(await client.getInboundWebhookEndpoint('workspace-1', automation.id))
      .toMatchObject({ id: automation.id, purpose: 'automation', status: 'active' })

    // A row whose entry type does not match its purpose is rejected as invalid data.
    for (const item of probe.items.values()) {
      if (item.id === triage.id && item.entryType === 'inbound-webhook-triage') item.entryType = 'inbound-webhook'
    }
    await expect(client.getInboundWebhookEndpoint('workspace-1', triage.id))
      .rejects.toMatchObject({ code: 'StoredAutomationInvalid' })
  })

  test('validates a new endpoint before reserving it but replays without revalidating', async () => {
    const probe = createInboundWebhookDocumentProbe()
    const client = new DynamoDbAutomationRepository('AutomationTable', probe.documentClient)
    const input: CreateAutomationInboundWebhookEndpointInput = { name: 'Status page', purpose: 'triage', triageRouting: { teamId: 'support' } }
    let checks = 0
    const created = await client.reserveCreateInboundWebhookEndpoint('workspace-1', 'actor-1', input, 'triage-key', 'https://api.example.com', async () => {
      checks += 1
    })
    expect(checks).toBe(1)
    const replay = await client.reserveCreateInboundWebhookEndpoint('workspace-1', 'actor-1', input, 'triage-key', 'https://api.example.com', async () => {
      throw new Error('Team was archived')
    })
    expect(replay.endpoint.id).toBe(created.endpoint.id)
    await expect(client.reserveCreateInboundWebhookEndpoint('workspace-1', 'actor-1', input, 'other-key', 'https://api.example.com', async () => {
      throw new Error('Team was archived')
    })).rejects.toThrow('Team was archived')
    expect(await client.listInboundWebhookEndpoints('workspace-1')).toHaveLength(1)
  })

  test('fences the routing Team in the reservation transaction', async () => {
    const probe = createInboundWebhookDocumentProbe()
    const client = new DynamoDbAutomationRepository('AutomationTable', probe.documentClient)
    const input: CreateAutomationInboundWebhookEndpointInput = { name: 'Status page', purpose: 'triage', triageRouting: { teamId: 'support' } }
    const teamKey = { directoryId: 'workspace-1', entryKey: 'TEAM#support' }
    probe.items.set('DirectoryTable\0workspace-1\0TEAM#support', { ...teamKey, status: 'active' })
    const teamFence = {
      ConditionCheck: {
        TableName: 'DirectoryTable',
        Key: teamKey,
        ConditionExpression: '#status = :active',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':active': 'active' },
      },
    }
    // The Team is archived after validation but before the reservation commits.
    await expect(client.reserveCreateInboundWebhookEndpoint('workspace-1', 'actor-1', input, 'raced-key', 'https://api.example.com', async () => {
      probe.items.set('DirectoryTable\0workspace-1\0TEAM#support', { ...teamKey, status: 'archived' })
      return [teamFence]
    })).rejects.toMatchObject({ category: 'conflict', code: 'AutomationInboundWebhookReferenceUnavailable' })
    expect(await client.listInboundWebhookEndpoints('workspace-1')).toHaveLength(0)
    expect([...probe.items.values()].some((item) => item.entryType === 'inbound-webhook-triage-lookup')).toBe(false)

    // Only condition checks may join the reservation.
    const transactionsBeforeInvalidFence = probe.transactionCalls
    await expect(client.reserveCreateInboundWebhookEndpoint('workspace-1', 'actor-1', input, 'put-key', 'https://api.example.com', async () => [
      { Put: { TableName: 'DirectoryTable', Item: teamKey } },
    ])).rejects.toMatchObject({ code: 'InvalidAutomationInput' })
    expect(probe.transactionCalls).toBe(transactionsBeforeInvalidFence)

    probe.items.set('DirectoryTable\0workspace-1\0TEAM#support', { ...teamKey, status: 'active' })
    const created = await client.reserveCreateInboundWebhookEndpoint('workspace-1', 'actor-1', input, 'active-key', 'https://api.example.com', async () => [teamFence])
    expect(created.endpoint.triageRouting).toEqual({ teamId: 'support' })
    expect(await client.listInboundWebhookEndpoints('workspace-1')).toHaveLength(1)
  })
})

describe('DynamoDB inbound webhook delivery receipts', () => {
  test('keeps an accepted Triage delivery resolvable after the endpoint is revoked', async () => {
    const probe = createInboundWebhookDocumentProbe()
    const client = new DynamoDbAutomationRepository('AutomationTable', probe.documentClient)
    const triage = await client.completeInboundWebhookProvisioning(await client.reserveCreateInboundWebhookEndpoint(
      'workspace-1', 'actor-1', { name: 'Status page', purpose: 'triage', triageRouting: { teamId: 'support' } }, 'triage-key', 'https://api.example.com',
    ))
    const automation = await client.completeInboundWebhookProvisioning(await client.reserveCreateInboundWebhookEndpoint(
      'workspace-1', 'actor-1', { name: 'Builds' }, 'automation-key', 'https://api.example.com',
    ))
    const accepted = await client.recordInboundWebhookDelivery(triage, {
      idempotencyKey: 'delivery-key',
      bodyFingerprint: fingerprint('raw body'),
      signatureFingerprint: fingerprint('signature-1'),
      signatureTimestamp: '1784160000',
      eventId: 'event-1',
      auditMutation: auditPut('event-1'),
    })
    await client.recordInboundWebhookDelivery(automation, {
      idempotencyKey: 'delivery-key',
      bodyFingerprint: fingerprint('raw body'),
      signatureFingerprint: fingerprint('signature-2'),
      signatureTimestamp: '1784160000',
      eventId: 'event-2',
      auditMutation: auditPut('event-2'),
    })

    await client.revokeInboundWebhookEndpoint(triage.workspaceId, triage.id, { expectedRevision: triage.revision })
    expect(await client.resolveInboundWebhookEndpoint(triage.opaqueEndpointId)).toBeUndefined()
    const recovered = await client.resolveAcceptedTriageWebhookDelivery(triage.opaqueEndpointId, 'delivery-key')
    expect(recovered).toEqual({
      endpoint: expect.objectContaining({ id: triage.id, status: 'revoked', triageRouting: { teamId: 'support' } }),
      eventId: 'event-1',
      bodyFingerprint: fingerprint('raw body'),
      acceptedAt: expect.any(String),
    })
    expect(recovered?.acceptedAt).toBe(accepted.acceptedAt ?? '')
    const marker = [...probe.items.values()].find((item) => item.entryType === 'inbound-webhook-triage-delivery')
    expect(marker?.expiresAt).toBeNumber()
    // Only a committed Triage receipt resolves; new keys and Automation deliveries do not.
    expect(await client.resolveAcceptedTriageWebhookDelivery(triage.opaqueEndpointId, 'other-key')).toBeUndefined()
    expect(await client.resolveAcceptedTriageWebhookDelivery(automation.opaqueEndpointId, 'delivery-key')).toBeUndefined()
  })


  test('binds body/key/signature and checks active generation on every replay path', async () => {
    const probe = createInboundWebhookDocumentProbe()
    const client = new DynamoDbAutomationRepository('AutomationTable', probe.documentClient)
    const provisioning = await client.reserveCreateInboundWebhookEndpoint(
      'workspace-1',
      'actor-1',
      { name: 'Deploy events' },
      'create-key',
      'https://api.example.com',
    )
    const endpoint = await client.completeInboundWebhookProvisioning(provisioning)
    const transactionCallsBeforeInvalidDelivery = probe.transactionCalls
    for (const [index, auditMutation] of [
      {},
      { Put: { TableName: 'AuditTable' } },
      { Update: { TableName: 'AuditTable', Key: { eventId: 'event-1' } } },
    ].entries()) {
      await expect(client.recordInboundWebhookDelivery(endpoint, {
        idempotencyKey: `invalid-audit-mutation-${index}`,
        bodyFingerprint: fingerprint('raw body'),
        signatureFingerprint: fingerprint(`signature-invalid-audit-mutation-${index}`),
        signatureTimestamp: '1784160000',
        eventId: `invalid-audit-mutation-${index}`,
        auditMutation,
      })).rejects.toMatchObject({
        category: 'invalid-input',
        code: 'InvalidAutomationInput',
      })
    }
    expect(probe.transactionCalls).toBe(transactionCallsBeforeInvalidDelivery)

    const first = await client.recordInboundWebhookDelivery(endpoint, {
      idempotencyKey: 'delivery-key',
      bodyFingerprint: fingerprint('raw body'),
      signatureFingerprint: fingerprint('signature-1'),
      signatureTimestamp: '1784160000',
      eventId: 'event-1',
      auditMutation: auditPut('event-1'),
    })
    expect(first).toEqual({ eventId: 'event-1', replayed: false, acceptedAt: expect.any(String) })
    // Replays report the time the delivery was first accepted.
    expect(await client.recordInboundWebhookDelivery(endpoint, {
      idempotencyKey: 'delivery-key',
      bodyFingerprint: fingerprint('raw body'),
      signatureFingerprint: fingerprint('signature-1'),
      signatureTimestamp: '1784160000',
      eventId: 'unused-event',
      auditMutation: auditPut('unused-event'),
    })).toEqual({ eventId: 'event-1', replayed: true, acceptedAt: first.acceptedAt })
    expect(await client.recordInboundWebhookDelivery(endpoint, {
      idempotencyKey: 'delivery-key',
      bodyFingerprint: fingerprint('raw body'),
      signatureFingerprint: fingerprint('fresh-signature'),
      signatureTimestamp: '1784160001',
      eventId: 'unused-event',
      auditMutation: auditPut('unused-event'),
    })).toEqual({ eventId: 'event-1', replayed: true, acceptedAt: first.acceptedAt })

    await expect(client.recordInboundWebhookDelivery(endpoint, {
      idempotencyKey: 'delivery-key',
      bodyFingerprint: fingerprint('different raw body'),
      signatureFingerprint: fingerprint('signature-2'),
      signatureTimestamp: '1784160002',
      eventId: 'event-2',
      auditMutation: auditPut('event-2'),
    })).rejects.toMatchObject({ code: 'AutomationInboundWebhookIdempotencyConflict' })
    await expect(client.recordInboundWebhookDelivery(endpoint, {
      idempotencyKey: 'other-key',
      bodyFingerprint: fingerprint('raw body'),
      signatureFingerprint: fingerprint('signature-1'),
      signatureTimestamp: '1784160000',
      eventId: 'event-3',
      auditMutation: auditPut('event-3'),
    })).rejects.toMatchObject({ code: 'AutomationInboundWebhookSignatureReplay' })

    const paused = await client.setInboundWebhookEndpointStatus(
      endpoint.workspaceId,
      endpoint.id,
      { expectedRevision: endpoint.revision },
      'paused',
    )
    expect(paused.status).toBe('paused')
    await expect(client.recordInboundWebhookDelivery(endpoint, {
      idempotencyKey: 'delivery-key',
      bodyFingerprint: fingerprint('raw body'),
      signatureFingerprint: fingerprint('signature-1'),
      signatureTimestamp: '1784160000',
      eventId: 'unused-event',
      auditMutation: auditPut('unused-event'),
    })).rejects.toMatchObject({
      category: 'locked',
      code: 'AutomationInboundWebhookPaused',
    })

    const resumed = await client.setInboundWebhookEndpointStatus(
      endpoint.workspaceId,
      endpoint.id,
      { expectedRevision: paused.revision },
      'active',
    )
    const resumedRecord = await client.completeInboundWebhookProvisioning(
      provisioning,
    )
    await client.reserveRotateInboundWebhookEndpoint(
      endpoint.workspaceId,
      'actor-1',
      endpoint.id,
      { expectedRevision: resumed.revision },
      'rotate-race-key',
    )
    await expect(client.recordInboundWebhookDelivery(resumedRecord, {
      idempotencyKey: 'delivery-key',
      bodyFingerprint: fingerprint('raw body'),
      signatureFingerprint: fingerprint('signature-1'),
      signatureTimestamp: '1784160000',
      eventId: 'unused-event',
      auditMutation: auditPut('unused-event'),
    })).rejects.toMatchObject({
      code: 'AutomationInboundWebhookVersionConflict',
      category: 'conflict',
    })

    const deliveryReceipt = [...probe.items.values()].find((item) =>
      item.entryType === 'inbound-webhook-delivery'
    )
    expect(deliveryReceipt?.expiresAt).toBeNumber()
  })
})
