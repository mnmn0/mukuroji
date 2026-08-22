import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  CreateTableCommand,
  DescribeTableCommand,
  type DynamoDBClient,
  type TableDescription,
} from '@aws-sdk/client-dynamodb'
import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  AUTOMATION_SCHEMA_VERSION,
  type AutomationInboundWebhookLifecycleInput,
  type AutomationAction,
  type AutomationExecution,
  type AutomationRule,
  type AutomationTemplate,
  type AutomationTemplateApplication,
  type AutomationTemplateApplicationResult,
  type AutomationTemplateApplicationTarget,
  type AutomationTrigger,
  type BulkOperation,
  type CreateAutomationRuleInput,
  type CreateAutomationInboundWebhookEndpointInput,
  type CreateAutomationTemplateInput,
  type CreateRecurringWorkInput,
  type RecurringWork,
  type UpdateAutomationRuleInput,
  type UpdateAutomationInboundWebhookEndpointInput,
  type UpdateAutomationTemplateInput,
  type UpdateRecurringWorkInput,
} from '@mukuroji/contracts'
import type {
  AutomationExecutionClaimToken,
  AutomationExecutionDefinitionGuard,
  AutomationExecutionQuery,
  AutomationInboundWebhookDeliveryInput as AutomationInboundWebhookDeliveryMutationInput,
  AutomationInboundWebhookEndpointRecord,
  AutomationInboundWebhookProvisioning,
  AutomationInboundWebhookProvisioningOperation,
  AutomationInboundWebhookSecretCleanup,
  AutomationRepository,
} from '../../application/ports'
import { toAutomationInboundWebhookEndpoint } from '../../application/inbound-webhook-view'
import { AutomationError } from '../../domain/automation-error'
import {
  createRecurringExecutionId,
} from '../../application/execution-identifiers'
import {
  DEFAULT_AUTOMATION_RATE_LIMIT,
  DEFAULT_AUTOMATION_RETRY_POLICY,
} from '../../domain/execution-policy'
import {
  type AutomationEvent,
} from '../../domain/rule-evaluation'
import {
  getNextRecurringOccurrence,
} from '../../domain/recurring-schedule'
import { validateCreateAutomationRuleInput } from '../../domain/rule-validation'
import {
  validateAutomationInboundWebhookLifecycleInput,
  validateCreateAutomationInboundWebhookEndpointInput,
  validateCreateAutomationTemplateInput,
  validateCreateRecurringWorkInput,
  validateUpdateAutomationInboundWebhookEndpointInput,
} from '../../domain/management-validation'
import {
  createAutomationScheduleShard,
} from '../../application/schedule-shard'
import {
  createAutomationInboundWebhookSecretId,
} from '../inbound-webhook-secret-id'
export { AutomationError } from '../../domain/automation-error'
export { isAutomationValue } from '../../domain/automation-value'
export { normalizeAutomationActionFailure } from '../../application/action-failure'
export {
  evaluateAutomationCondition,
  matchesAutomationTrigger,
} from '../../domain/rule-evaluation'
export {
  getNextRecurringOccurrence,
  getRecurringOccurrences,
  selectCatchUpOccurrences,
  validateRecurringSchedule,
} from '../../domain/recurring-schedule'
export { validateCreateAutomationRuleInput } from '../../domain/rule-validation'
export {
  validateApplyAutomationTemplateInput,
  validateAutomationInboundWebhookLifecycleInput,
  validateCreateAutomationInboundWebhookEndpointInput,
  validateCreateAutomationTemplateInput,
  validateCreateRecurringWorkInput,
  validateUpdateAutomationInboundWebhookEndpointInput,
} from '../../domain/management-validation'
export { toAutomationInboundWebhookEndpoint } from '../../application/inbound-webhook-view'
export {
  AUTOMATION_TEMPLATE_APPLICATION_LEASE_MS,
} from '../../application/template-application-policy'
export {
  createAutomationActionId,
  createAutomationExecutionId,
  createRecurringExecutionId,
} from '../../application/execution-identifiers'
export type {
  AutomationActionExecutionContext,
  AutomationActionExecutor,
  AutomationExecutionClaimToken,
  AutomationExecutionDefinitionGuard,
  AutomationExecutionPage,
  AutomationExecutionQuery,
  AutomationExecutionReservation,
  AutomationInboundWebhookDeliveryResult,
  AutomationInboundWebhookEndpointRecord,
  AutomationInboundWebhookProvisioning,
  AutomationInboundWebhookProvisioningOperation,
  AutomationInboundWebhookSecretCleanup,
  BulkItemApplyResult,
  BulkItemPreviewResult,
  BulkOperationAdapter,
} from '../../application/ports'
export type {
  AutomationConditionContext,
  AutomationEvent,
  AutomationEventChange,
} from '../../domain/rule-evaluation'

export {
  DEFAULT_AUTOMATION_RATE_LIMIT,
  DEFAULT_AUTOMATION_RETRY_POLICY,
} from '../../domain/execution-policy'
export {
  AUTOMATION_SCHEDULE_SHARD_COUNT,
  createAutomationScheduleShard,
} from '../../application/schedule-shard'
/** Inbound webhook plaintext secret を同じ key で回収できる時間です。 */
export const AUTOMATION_INBOUND_WEBHOOK_SECRET_RECOVERY_MS = 24 * 60 * 60_000
/** Revoke 後の late secret write を再削除する間隔です。 */
export const AUTOMATION_INBOUND_WEBHOOK_SECRET_CLEANUP_INTERVAL_MS = 5 * 60_000
/** Recovery 期限直前に開始した provisioning write を最終削除まで覆う猶予です。 */
export const AUTOMATION_INBOUND_WEBHOOK_SECRET_CLEANUP_GRACE_MS =
  AUTOMATION_INBOUND_WEBHOOK_SECRET_CLEANUP_INTERVAL_MS
/** Audit outbox より長く保持する inbound webhook delivery receipt の秒数です。 */
export const AUTOMATION_INBOUND_WEBHOOK_DELIVERY_RETENTION_SECONDS = 400 * 86_400
/** One DynamoDB transaction mutation owned by the persistence adapter. */
type DynamoDbAutomationTransactionItem =
  NonNullable<TransactWriteCommandInput['TransactItems']>[number]

/** DynamoDB single-table adapter implementing the focused Automation ports. */
export class DynamoDbAutomationRepository implements AutomationRepository<
  DynamoDbAutomationTransactionItem,
  DynamoDbAutomationTransactionItem
> {
  /** Automation table 名です。 */
  private readonly tableName: string
  /** DynamoDB DocumentClient です。 */
  private readonly documentClient: DynamoDBDocumentClient
  /** Local bootstrap 用 low-level client です。 */
  private readonly dynamoDbClient?: DynamoDBClient
  /** Local table bootstrap を有効にするかどうかです。 */
  private readonly bootstrapLocalTable: boolean

  /** Creates a DynamoDB-backed Automation repository. */
  constructor(
    tableName = process.env.AUTOMATION_TABLE_NAME ?? 'mukuroji-automation-local',
    documentClient: DynamoDBDocumentClient,
    dynamoDbClient?: DynamoDBClient,
    bootstrapLocalTable = false,
  ) {
    this.tableName = tableName
    this.documentClient = documentClient
    this.dynamoDbClient = dynamoDbClient
    this.bootstrapLocalTable = bootstrapLocalTable
  }

  /** Workspace の current rules を返します。 */
  async listRules(workspaceId: string) {
    return await this.listCurrent<AutomationRule>(workspaceId, 'RULE#', 'rule')
  }

  /** Current rule を返します。 */
  async getRule(workspaceId: string, ruleId: string) {
    return await this.getCurrent<AutomationRule>(workspaceId, `RULE#${encodeKey(ruleId)}`, 'rule')
  }

  /** Immutable rule version を返します。 */
  async getRuleVersion(workspaceId: string, ruleId: string, version: number) {
    return await this.getCurrent<AutomationRule>(
      workspaceId,
      ruleVersionKey(ruleId, version),
      'rule-version',
    )
  }

  /** Rule を作成します。 */
  async createRule(workspaceId: string, input: CreateAutomationRuleInput, idempotencyKey?: string) {
    await this.ensureTable()
    const normalizedWorkspaceId = requireText(workspaceId, 'Workspace ID')
    const normalized = validateCreateAutomationRuleInput(input)
    const requestedDefinition = {
      name: normalized.name,
      enabled: normalized.enabled,
      trigger: normalized.trigger,
      conditions: normalized.conditions ?? [],
      actions: normalized.actions,
      retryPolicy: normalized.retryPolicy ?? structuredClone(DEFAULT_AUTOMATION_RETRY_POLICY),
      rateLimit: normalized.rateLimit ?? structuredClone(DEFAULT_AUTOMATION_RATE_LIMIT),
      allowReentry: normalized.allowReentry ?? false,
      maxChainDepth: normalized.maxChainDepth ?? 8,
    }
    const createIdentity = idempotencyKey
      ? createAutomationCreateIdentity(normalizedWorkspaceId, 'rule', idempotencyKey, requestedDefinition)
      : undefined
    const idempotentCurrentKey = createIdentity
      ? `RULE#${encodeKey(createIdentity.resourceId)}`
      : undefined
    if (createIdentity) {
      const replay = await this.getOptionalIdempotentCreateReplay<AutomationRule>(
        normalizedWorkspaceId,
        idempotentCurrentKey!,
        'rule',
        createIdentity,
      )
      if (replay) return replay
    }
    let webhookTriggerEndpoint: AutomationInboundWebhookEndpointRecord | undefined
    try {
      webhookTriggerEndpoint = await this.assertActiveInboundWebhookTrigger(
        normalizedWorkspaceId,
        requestedDefinition.trigger,
      )
    } catch (error) {
      if (createIdentity) {
        const replay = await this.getOptionalIdempotentCreateReplay<AutomationRule>(
          normalizedWorkspaceId,
          idempotentCurrentKey!,
          'rule',
          createIdentity,
        )
        if (replay) return replay
      }
      throw error
    }
    const definition = {
      ...requestedDefinition,
      actions: await this.pinWorkItemTemplateVersions(
        normalizedWorkspaceId,
        requestedDefinition.actions,
      ),
    }
    const now = new Date().toISOString()
    const nextRunAt = definition.trigger.type === 'schedule'
      ? getNextRecurringOccurrence(definition.trigger.schedule, new Date(now))
      : undefined
    if (definition.trigger.type === 'schedule' && !nextRunAt) {
      throw invalidInput('Automation schedule trigger has no future occurrence.')
    }
    const rule: AutomationRule = {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      id: createIdentity?.resourceId ?? createResourceId('rule', definition.name),
      workspaceId: normalizedWorkspaceId,
      ...definition,
      version: 1,
      revision: 1,
      ...(nextRunAt ? { nextRunAt: nextRunAt.toISOString() } : {}),
      createdAt: now,
      updatedAt: now,
    }
    const ruleCurrentKey = `RULE#${encodeKey(rule.id)}`
    try {
      await this.putVersionedCreate(
        normalizedWorkspaceId,
        ruleCurrentKey,
        ruleVersionKey(rule.id, 1),
        'rule',
        rule,
        scheduledRuleIndexAttributes(rule),
        createIdentity,
        webhookTriggerEndpoint
          ? [createInboundWebhookRuleActiveConditionCheck(this.tableName, webhookTriggerEndpoint)]
          : [],
      )
    } catch (error) {
      if (!isTransactionConditionalCheckFailed(error)) throw persistenceError(error)
      if (createIdentity) {
        const replay = await this.getOptionalIdempotentCreateReplay<AutomationRule>(
          normalizedWorkspaceId,
          ruleCurrentKey,
          'rule',
          createIdentity,
        )
        if (replay) return replay
      }
      if (webhookTriggerEndpoint) {
        await this.assertActiveInboundWebhookTrigger(
          normalizedWorkspaceId,
          requestedDefinition.trigger,
        )
      }
      throw idempotencyConflict()
    }
    return rule
  }

  /** Rule を revision CAS 付きで更新します。 */
  async updateRule(workspaceId: string, ruleId: string, input: UpdateAutomationRuleInput) {
    const current = await this.requireRule(workspaceId, ruleId)
    assertExpectedRevision(current.revision, input.expectedRevision)
    const normalized = validateCreateAutomationRuleInput({
      name: input.name ?? current.name,
      enabled: input.enabled ?? current.enabled,
      trigger: input.trigger ?? current.trigger,
      conditions: input.conditions ?? current.conditions,
      actions: input.actions ?? current.actions,
      retryPolicy: input.retryPolicy ?? current.retryPolicy,
      rateLimit: input.rateLimit ?? current.rateLimit,
      allowReentry: input.allowReentry ?? current.allowReentry,
      maxChainDepth: input.maxChainDepth ?? current.maxChainDepth,
    })
    const webhookTriggerChanged = normalized.trigger.type === 'webhook' && (
      current.trigger.type !== 'webhook' ||
      current.trigger.webhookId !== normalized.trigger.webhookId
    )
    const webhookRuleEnabled = normalized.trigger.type === 'webhook' &&
      !current.enabled && normalized.enabled
    const webhookTriggerEndpoint = webhookTriggerChanged || webhookRuleEnabled
      ? await this.assertActiveInboundWebhookTrigger(workspaceId, normalized.trigger)
      : undefined
    const pinnedActions = input.actions === undefined
      ? current.actions
      : await this.pinWorkItemTemplateVersions(workspaceId, normalized.actions)
    const scheduleChanged = normalized.trigger.type === 'schedule' && (
      current.trigger.type !== 'schedule' ||
      canonicalString(current.trigger.schedule) !== canonicalString(normalized.trigger.schedule)
    )
    const scheduleNextRunAt = normalized.trigger.type === 'schedule'
      ? scheduleChanged || !current.nextRunAt
        ? getNextRecurringOccurrence(normalized.trigger.schedule, new Date())
        : new Date(current.nextRunAt)
      : undefined
    if (normalized.trigger.type === 'schedule' && !scheduleNextRunAt) {
      throw invalidInput('Automation schedule trigger has no future occurrence.')
    }
    const rule: AutomationRule = {
      ...current,
      ...normalized,
      actions: pinnedActions,
      conditions: normalized.conditions ?? [],
      retryPolicy: normalized.retryPolicy ?? current.retryPolicy,
      rateLimit: normalized.rateLimit ?? current.rateLimit,
      version: current.version + 1,
      revision: current.revision + 1,
      ...(scheduleNextRunAt ? { nextRunAt: scheduleNextRunAt.toISOString() } : {}),
      updatedAt: new Date().toISOString(),
    }
    if (normalized.trigger.type !== 'schedule') {
      delete rule.nextRunAt
      delete rule.lastRunAt
    } else if (scheduleChanged) {
      delete rule.lastRunAt
    }
    try {
      await this.putVersionedUpdate(
        workspaceId,
        `RULE#${encodeKey(rule.id)}`,
        ruleVersionKey(rule.id, rule.version),
        'rule',
        rule,
        current.revision,
        scheduledRuleIndexAttributes(rule),
        webhookTriggerEndpoint
          ? [createInboundWebhookRuleActiveConditionCheck(this.tableName, webhookTriggerEndpoint)]
          : [],
      )
    } catch (error) {
      if (webhookTriggerEndpoint) {
        await this.assertActiveInboundWebhookTrigger(workspaceId, normalized.trigger)
      }
      throw error
    }
    return rule
  }

  /** Rule を削除します。 */
  async deleteRule(workspaceId: string, ruleId: string, expectedRevision: number) {
    await this.deleteCurrent(workspaceId, `RULE#${encodeKey(ruleId)}`, expectedRevision)
  }

  /** Due schedule-trigger rules を ScheduleDueIndex から返します。 */
  async listDueScheduledRules(scheduleShard: string, dueAt: string, limit = 100) {
    return await this.listDueEntries(
      scheduleShard,
      dueAt,
      'rule',
      normalizeLimit(limit),
      (item) => stripStorage<AutomationRule>(item),
    )
  }

  /** Schedule-trigger slot 完了後に last/next run を revision CAS 付きで進めます。 */
  async completeScheduledRule(
    workspaceId: string,
    ruleId: string,
    expectedRevision: number,
    lastRunAt: string,
    nextRunAt: string,
  ) {
    const current = await this.requireRule(workspaceId, ruleId)
    assertExpectedRevision(current.revision, expectedRevision)
    if (!current.enabled || current.trigger.type !== 'schedule') {
      throw new AutomationError('conflict', 'AutomationScheduledRuleDisabled', 'Scheduled automation rule is disabled.')
    }
    const normalizedLastRunAt = normalizeTimestamp(lastRunAt)
    const normalizedNextRunAt = normalizeTimestamp(nextRunAt)
    if (normalizedNextRunAt <= normalizedLastRunAt) {
      throw invalidInput('Automation schedule next run must be later than the completed run.')
    }
    if (current.lastRunAt && normalizedLastRunAt <= normalizeTimestamp(current.lastRunAt)) {
      throw new AutomationError('conflict', 'AutomationScheduleSlotAlreadyCompleted', 'Automation schedule slot was already completed.')
    }
    const rule: AutomationRule = {
      ...current,
      revision: current.revision + 1,
      lastRunAt: normalizedLastRunAt,
      nextRunAt: normalizedNextRunAt,
      updatedAt: new Date().toISOString(),
    }
    await this.putCurrentUpdate(
      workspaceId,
      `RULE#${encodeKey(rule.id)}`,
      'rule',
      rule,
      current.revision,
      scheduledRuleIndexAttributes(rule),
    )
    return rule
  }

  /** Workspace の templates を返します。 */
  async listTemplates(workspaceId: string) {
    return await this.listCurrent<AutomationTemplate>(workspaceId, 'TEMPLATE#', 'template')
  }

  /** Template を返します。 */
  async getTemplate(workspaceId: string, templateId: string) {
    return await this.getCurrent<AutomationTemplate>(workspaceId, `TEMPLATE#${encodeKey(templateId)}`, 'template')
  }

  /** Immutable template version を返します。 */
  async getTemplateVersion(workspaceId: string, templateId: string, version: number) {
    return await this.getCurrent<AutomationTemplate>(
      workspaceId,
      templateVersionKey(templateId, version),
      'template-version',
    )
  }

  /** Template を作成します。 */
  async createTemplate(workspaceId: string, input: CreateAutomationTemplateInput, idempotencyKey?: string) {
    await this.ensureTable()
    const normalizedWorkspaceId = requireText(workspaceId, 'Workspace ID')
    const normalized = validateCreateAutomationTemplateInput(input)
    const createIdentity = idempotencyKey
      ? createAutomationCreateIdentity(normalizedWorkspaceId, 'template', idempotencyKey, normalized)
      : undefined
    const now = new Date().toISOString()
    const template: AutomationTemplate = {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      id: createIdentity?.resourceId ?? createResourceId('template', normalized.name),
      workspaceId: normalizedWorkspaceId,
      ...normalized,
      version: 1,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }
    const currentKey = `TEMPLATE#${encodeKey(template.id)}`
    try {
      await this.putVersionedCreate(
        normalizedWorkspaceId,
        currentKey,
        templateVersionKey(template.id, 1),
        'template',
        template,
        {},
        createIdentity,
      )
    } catch (error) {
      if (!createIdentity || !isTransactionConditionalCheckFailed(error)) throw persistenceError(error)
      return await this.getIdempotentCreateReplay<AutomationTemplate>(
        normalizedWorkspaceId,
        currentKey,
        'template',
        createIdentity,
      )
    }
    return template
  }

  /** Template を更新します。 */
  async updateTemplate(workspaceId: string, templateId: string, input: UpdateAutomationTemplateInput) {
    assertOnlyKeys(
      requireRecord(input, 'Automation template update'),
      ['enabled', 'expectedRevision', 'name', 'payload'],
      'Automation template update',
    )
    const current = await this.requireTemplate(workspaceId, templateId)
    assertExpectedRevision(current.revision, input.expectedRevision)
    const normalized = validateCreateAutomationTemplateInput({
      kind: current.kind,
      name: input.name ?? current.name,
      enabled: input.enabled ?? current.enabled,
      payload: input.payload ?? current.payload,
    })
    const template = {
      ...current,
      ...normalized,
      version: current.version + 1,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    } as AutomationTemplate
    await this.putVersionedUpdate(
      workspaceId,
      `TEMPLATE#${encodeKey(template.id)}`,
      templateVersionKey(template.id, template.version),
      'template',
      template,
      current.revision,
    )
    return template
  }

  /** Template を削除します。 */
  async deleteTemplate(workspaceId: string, templateId: string, expectedRevision: number) {
    await this.deleteCurrent(workspaceId, `TEMPLATE#${encodeKey(templateId)}`, expectedRevision)
  }

  /** Current enabled template version を固定した application receipt を予約します。 */
  async reserveTemplateApplication(
    workspaceId: string,
    actorId: string,
    templateId: string,
    target: AutomationTemplateApplicationTarget,
    idempotencyKey: string,
  ) {
    await this.ensureTable()
    const normalizedWorkspaceId = requireText(workspaceId, 'Workspace ID')
    const normalizedActorId = requireBoundedText(actorId, 'Template application actor ID', 256)
    const normalizedTemplateId = requireBoundedText(templateId, 'Template application template ID', 256)
    const identity = createTemplateApplicationIdentity(
      normalizedWorkspaceId,
      normalizedActorId,
      normalizedTemplateId,
      target,
      idempotencyKey,
    )
    const scopeKey = automationScopeKey(normalizedWorkspaceId)
    const recordKey = templateApplicationKey(identity.applicationId)
    const existing = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { scopeKey, recordKey },
      ConsistentRead: true,
    }))
    if (existing.Item) {
      if (
        existing.Item.entryType !== 'template-application' ||
        existing.Item.requestFingerprint !== identity.requestFingerprint ||
        existing.Item.actorId !== normalizedActorId
      ) {
        throw idempotencyConflict()
      }
      return readTemplateApplication(existing.Item)
    }
    const template = await this.requireTemplate(normalizedWorkspaceId, normalizedTemplateId)
    if (!template.enabled || (template.kind !== 'project' && template.kind !== 'workflow')) {
      throw new AutomationError(
        'conflict',
        'AutomationTemplateUnavailable',
        'The selected Project or Workflow template is unavailable.',
      )
    }
    if (target.kind !== template.kind) {
      throw invalidInput('Template application target does not match the template kind.')
    }
    const now = new Date().toISOString()
    const application: AutomationTemplateApplication = {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      id: identity.applicationId,
      workspaceId: normalizedWorkspaceId,
      actorId: normalizedActorId,
      templateId: normalizedTemplateId,
      templateVersion: template.version,
      kind: template.kind,
      target: structuredClone(target),
      status: 'pending',
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: this.tableName,
              Key: { scopeKey, recordKey: `TEMPLATE#${encodeKey(template.id)}` },
              ConditionExpression:
                '#entryType = :entryType AND #enabled = :enabled AND #version = :version AND #revision = :revision',
              ExpressionAttributeNames: {
                '#enabled': 'enabled',
                '#entryType': 'entryType',
                '#revision': 'revision',
                '#version': 'version',
              },
              ExpressionAttributeValues: {
                ':enabled': true,
                ':entryType': 'template',
                ':revision': template.revision,
                ':version': template.version,
              },
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: {
                scopeKey,
                recordKey,
                entryType: 'template-application',
                requestFingerprint: identity.requestFingerprint,
                ...application,
              },
              ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
            },
          },
        ],
      }))
      return application
    } catch (error) {
      if (!isTransactionConditionalCheckFailed(error)) throw persistenceError(error)
      const replay = await this.documentClient.send(new GetCommand({
        TableName: this.tableName,
        Key: { scopeKey, recordKey },
        ConsistentRead: true,
      }))
      if (
        replay.Item?.entryType !== 'template-application' ||
        replay.Item.requestFingerprint !== identity.requestFingerprint ||
        replay.Item.actorId !== normalizedActorId
      ) {
        throw idempotencyConflict()
      }
      return readTemplateApplication(replay.Item)
    }
  }

  /** Template application receipt を返します。 */
  async getTemplateApplication(workspaceId: string, applicationId: string) {
    await this.ensureTable()
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        scopeKey: automationScopeKey(workspaceId),
        recordKey: templateApplicationKey(applicationId),
      },
      ConsistentRead: true,
    }))
    return response.Item?.entryType === 'template-application'
      ? readTemplateApplication(response.Item)
      : undefined
  }

  /** Pending または lease 切れ application の runner lease を revision CAS 付きで取得します。 */
  async claimTemplateApplication(
    application: AutomationTemplateApplication,
    now: Date,
    leaseExpiresAt: string,
  ) {
    await this.ensureTable()
    const normalizedNow = normalizeTimestamp(now.toISOString())
    const normalizedLeaseExpiresAt = normalizeTimestamp(leaseExpiresAt)
    if (normalizedLeaseExpiresAt <= normalizedNow) {
      throw invalidInput('Template application runner lease must expire in the future.')
    }
    try {
      const response = await this.documentClient.send(new UpdateCommand({
        TableName: this.tableName,
        Key: {
          scopeKey: automationScopeKey(application.workspaceId),
          recordKey: templateApplicationKey(application.id),
        },
        ConditionExpression:
          '#revision = :expectedRevision AND (#status = :pending OR (#status = :running AND (attribute_not_exists(#runnerLeaseExpiresAt) OR #runnerLeaseExpiresAt <= :now)))',
        UpdateExpression:
          'SET #status = :running, #revision = :nextRevision, #runnerLeaseExpiresAt = :runnerLeaseExpiresAt, #updatedAt = :updatedAt REMOVE #errorCode, #errorMessage, #result',
        ExpressionAttributeNames: {
          '#errorCode': 'errorCode',
          '#errorMessage': 'errorMessage',
          '#result': 'result',
          '#revision': 'revision',
          '#runnerLeaseExpiresAt': 'runnerLeaseExpiresAt',
          '#status': 'status',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':expectedRevision': application.revision,
          ':nextRevision': application.revision + 1,
          ':now': normalizedNow,
          ':pending': 'pending',
          ':runnerLeaseExpiresAt': normalizedLeaseExpiresAt,
          ':running': 'running',
          ':updatedAt': normalizedNow,
        },
        ReturnValues: 'ALL_NEW',
      }))
      return response.Attributes ? readTemplateApplication(response.Attributes) : undefined
    } catch (error) {
      if (isNamedError(error, 'ConditionalCheckFailedException')) return undefined
      throw persistenceError(error)
    }
  }

  /** Domain mutation と同じ transaction に含める application 成功更新を生成します。 */
  createTemplateApplicationCompletionMutation(
    application: AutomationTemplateApplication,
    result: AutomationTemplateApplicationResult,
  ): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
    if (application.status !== 'running' || !application.runnerLeaseExpiresAt) {
      throw invalidInput('Template application must hold a runner lease before completion.')
    }
    const updatedAt = new Date().toISOString()
    return {
      Update: {
        TableName: this.tableName,
        Key: {
          scopeKey: automationScopeKey(application.workspaceId),
          recordKey: templateApplicationKey(application.id),
        },
        ConditionExpression:
          '#status = :running AND #revision = :expectedRevision AND #runnerLeaseExpiresAt = :runnerLeaseExpiresAt',
        UpdateExpression:
          'SET #status = :succeeded, #revision = :nextRevision, #result = :result, #updatedAt = :updatedAt REMOVE #runnerLeaseExpiresAt, #errorCode, #errorMessage',
        ExpressionAttributeNames: {
          '#errorCode': 'errorCode',
          '#errorMessage': 'errorMessage',
          '#result': 'result',
          '#revision': 'revision',
          '#runnerLeaseExpiresAt': 'runnerLeaseExpiresAt',
          '#status': 'status',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':expectedRevision': application.revision,
          ':nextRevision': application.revision + 1,
          ':result': structuredClone(result),
          ':runnerLeaseExpiresAt': application.runnerLeaseExpiresAt,
          ':running': 'running',
          ':succeeded': 'succeeded',
          ':updatedAt': updatedAt,
        },
      },
    }
  }

  /** Template application receipt を revision CAS 付きで保存します。 */
  async saveTemplateApplication(
    application: AutomationTemplateApplication,
    expectedRevision: number,
  ) {
    await this.ensureTable()
    if (application.revision !== expectedRevision + 1) {
      throw invalidInput('Template application revision must advance by exactly one.')
    }
    const key = {
      scopeKey: automationScopeKey(application.workspaceId),
      recordKey: templateApplicationKey(application.id),
    }
    const stored = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: key,
      ConsistentRead: true,
    }))
    if (
      stored.Item?.entryType !== 'template-application' ||
      typeof stored.Item.requestFingerprint !== 'string'
    ) {
      throw new AutomationError(
        'unavailable',
        'AutomationTemplateApplicationUnavailable',
        'Template application receipt is unavailable.',
        true,
      )
    }
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          ...key,
          entryType: 'template-application',
          requestFingerprint: stored.Item.requestFingerprint,
          ...application,
        },
        ConditionExpression: '#revision = :expectedRevision',
        ExpressionAttributeNames: { '#revision': 'revision' },
        ExpressionAttributeValues: { ':expectedRevision': expectedRevision },
      }))
    } catch (error) {
      if (isNamedError(error, 'ConditionalCheckFailedException')) throw revisionConflict()
      throw persistenceError(error)
    }
  }

  /** Workspace の inbound webhook endpoints を secret metadata なしで返します。 */
  async listInboundWebhookEndpoints(workspaceId: string) {
    const values = await this.listCurrent<Record<string, unknown>>(
      workspaceId,
      'INBOUND_WEBHOOK#',
      'inbound-webhook',
    )
    return values
      .map(readInboundWebhookEndpointRecord)
      .map(toAutomationInboundWebhookEndpoint)
  }

  /** Workspace 内 endpoint を secret metadata なしで返します。 */
  async getInboundWebhookEndpoint(workspaceId: string, endpointId: string) {
    const value = await this.getInboundWebhookEndpointRecord(workspaceId, endpointId)
    return value ? toAutomationInboundWebhookEndpoint(value) : undefined
  }

  /** Opaque public ID を global lookup から current endpoint へ解決します。 */
  async resolveInboundWebhookEndpoint(opaqueEndpointId: string) {
    await this.ensureTable()
    const normalizedOpaqueId = requireInboundWebhookOpaqueId(opaqueEndpointId)
    const lookup = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        scopeKey: inboundWebhookLookupScopeKey(normalizedOpaqueId),
        recordKey: 'ENDPOINT',
      },
      ConsistentRead: true,
    }))
    if (
      lookup.Item?.entryType !== 'inbound-webhook-lookup' ||
      lookup.Item.opaqueEndpointId !== normalizedOpaqueId ||
      typeof lookup.Item.workspaceId !== 'string' ||
      typeof lookup.Item.endpointId !== 'string'
    ) {
      return undefined
    }
    const endpoint = await this.getInboundWebhookEndpointRecord(
      lookup.Item.workspaceId,
      lookup.Item.endpointId,
    )
    return endpoint?.opaqueEndpointId === normalizedOpaqueId ? endpoint : undefined
  }

  /** Create operation と provisioning endpoint を atomic に予約します。 */
  async reserveCreateInboundWebhookEndpoint(
    workspaceId: string,
    actorId: string,
    input: CreateAutomationInboundWebhookEndpointInput,
    idempotencyKey: string,
    endpointBaseUrl: string,
  ) {
    await this.ensureTable()
    const normalizedWorkspaceId = requireText(workspaceId, 'Workspace ID')
    const normalizedActorId = requireBoundedText(actorId, 'Inbound webhook actor ID', 256)
    const normalized = validateCreateAutomationInboundWebhookEndpointInput(input)
    const identity = createInboundWebhookOperationIdentity(
      normalizedWorkspaceId,
      normalizedActorId,
      'create',
      undefined,
      idempotencyKey,
      normalized,
    )
    const existing = await this.getInboundWebhookProvisioningOperation(
      normalizedWorkspaceId,
      identity.operationId,
    )
    if (existing) {
      return await this.readInboundWebhookProvisioningReplay(existing, identity.requestFingerprint)
    }

    const endpointId = `webhook-${randomUUID()}`
    const opaqueEndpointId = randomBytes(32).toString('base64url')
    const secretGeneration = 1
    const secretId = createAutomationInboundWebhookSecretId(normalizedWorkspaceId, endpointId)
    const secretVersionId = createInboundWebhookSecretVersionId(
      identity.operationId,
      secretGeneration,
    )
    const now = new Date().toISOString()
    const endpoint: AutomationInboundWebhookEndpointRecord = {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      id: endpointId,
      workspaceId: normalizedWorkspaceId,
      opaqueEndpointId,
      name: normalized.name,
      status: 'provisioning',
      version: 1,
      secretGeneration,
      revision: 1,
      endpointUrl: createInboundWebhookEndpointUrl(endpointBaseUrl, opaqueEndpointId),
      secretId,
      secretVersionId,
      provisioningOperationId: identity.operationId,
      provisioningTargetStatus: 'active',
      createdAt: now,
      updatedAt: now,
    }
    const operation: AutomationInboundWebhookProvisioningOperation = {
      id: identity.operationId,
      workspaceId: normalizedWorkspaceId,
      actorId: normalizedActorId,
      kind: 'create',
      endpointId,
      requestFingerprint: identity.requestFingerprint,
      status: 'provisioning',
      targetStatus: 'active',
      endpointVersion: endpoint.version,
      endpointRevision: endpoint.revision,
      secretGeneration,
      secretId,
      secretVersionId,
      createdAt: now,
      updatedAt: now,
      recoveryExpiresAt: new Date(
        Date.parse(now) + AUTOMATION_INBOUND_WEBHOOK_SECRET_RECOVERY_MS,
      ).toISOString(),
    }
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: createInboundWebhookEndpointStorageItem(endpoint),
              ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: {
                scopeKey: inboundWebhookLookupScopeKey(opaqueEndpointId),
                recordKey: 'ENDPOINT',
                entryType: 'inbound-webhook-lookup',
                opaqueEndpointId,
                workspaceId: normalizedWorkspaceId,
                endpointId,
                createdAt: now,
              },
              ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: createInboundWebhookProvisioningStorageItem(operation),
              ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
            },
          },
        ],
      }))
      return { endpoint, operation }
    } catch (error) {
      if (!isTransactionConditionalCheckFailed(error)) throw persistenceError(error)
      const replay = await this.getInboundWebhookProvisioningOperation(
        normalizedWorkspaceId,
        identity.operationId,
      )
      if (!replay) throw idempotencyConflict()
      return await this.readInboundWebhookProvisioningReplay(replay, identity.requestFingerprint)
    }
  }

  /** Rotate operation と次 secret generation を atomic に予約します。 */
  async reserveRotateInboundWebhookEndpoint(
    workspaceId: string,
    actorId: string,
    endpointId: string,
    input: AutomationInboundWebhookLifecycleInput,
    idempotencyKey: string,
  ) {
    await this.ensureTable()
    const normalizedWorkspaceId = requireText(workspaceId, 'Workspace ID')
    const normalizedActorId = requireBoundedText(actorId, 'Inbound webhook actor ID', 256)
    const normalizedEndpointId = requireBoundedText(endpointId, 'Inbound webhook endpoint ID', 256)
    const normalized = validateAutomationInboundWebhookLifecycleInput(input)
    const identity = createInboundWebhookOperationIdentity(
      normalizedWorkspaceId,
      normalizedActorId,
      'rotate',
      normalizedEndpointId,
      idempotencyKey,
      normalized,
    )
    const existing = await this.getInboundWebhookProvisioningOperation(
      normalizedWorkspaceId,
      identity.operationId,
    )
    if (existing) {
      return await this.readInboundWebhookProvisioningReplay(existing, identity.requestFingerprint)
    }

    const current = await this.requireInboundWebhookEndpointRecord(
      normalizedWorkspaceId,
      normalizedEndpointId,
    )
    assertInboundWebhookExpectedRevision(current.revision, normalized.expectedRevision)
    if (current.status !== 'active' && current.status !== 'paused') {
      throw inboundWebhookLifecycleConflict()
    }
    const secretGeneration = current.secretGeneration + 1
    const secretVersionId = createInboundWebhookSecretVersionId(
      identity.operationId,
      secretGeneration,
    )
    const now = new Date().toISOString()
    const endpoint: AutomationInboundWebhookEndpointRecord = {
      ...current,
      status: 'provisioning',
      version: current.version + 1,
      secretGeneration,
      revision: current.revision + 1,
      secretVersionId,
      provisioningOperationId: identity.operationId,
      provisioningTargetStatus: current.status,
      updatedAt: now,
    }
    const operation: AutomationInboundWebhookProvisioningOperation = {
      id: identity.operationId,
      workspaceId: normalizedWorkspaceId,
      actorId: normalizedActorId,
      kind: 'rotate',
      endpointId: normalizedEndpointId,
      requestFingerprint: identity.requestFingerprint,
      status: 'provisioning',
      targetStatus: current.status,
      endpointVersion: endpoint.version,
      endpointRevision: endpoint.revision,
      secretGeneration,
      secretId: current.secretId,
      secretVersionId,
      createdAt: now,
      updatedAt: now,
      recoveryExpiresAt: new Date(
        Date.parse(now) + AUTOMATION_INBOUND_WEBHOOK_SECRET_RECOVERY_MS,
      ).toISOString(),
    }
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: createInboundWebhookEndpointStorageItem(endpoint),
              ConditionExpression:
                '#revision = :expectedRevision AND #status = :expectedStatus AND #version = :expectedVersion AND #secretGeneration = :expectedSecretGeneration',
              ExpressionAttributeNames: {
                '#revision': 'revision',
                '#secretGeneration': 'secretGeneration',
                '#status': 'status',
                '#version': 'version',
              },
              ExpressionAttributeValues: {
                ':expectedRevision': current.revision,
                ':expectedSecretGeneration': current.secretGeneration,
                ':expectedStatus': current.status,
                ':expectedVersion': current.version,
              },
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: createInboundWebhookProvisioningStorageItem(operation),
              ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
            },
          },
        ],
      }))
      return { endpoint, operation }
    } catch (error) {
      if (!isTransactionConditionalCheckFailed(error)) throw persistenceError(error)
      const replay = await this.getInboundWebhookProvisioningOperation(
        normalizedWorkspaceId,
        identity.operationId,
      )
      if (replay) {
        return await this.readInboundWebhookProvisioningReplay(replay, identity.requestFingerprint)
      }
      throw revisionConflict()
    }
  }

  /** Provisioned secret generation を current endpoint と operation に同時確定します。 */
  async completeInboundWebhookProvisioning(
    provisioning: AutomationInboundWebhookProvisioning,
  ) {
    await this.ensureTable()
    const { operation } = provisioning
    assertInboundWebhookSecretRecoveryOpen(operation)
    const current = await this.requireInboundWebhookEndpointRecord(
      operation.workspaceId,
      operation.endpointId,
    )
    if (
      (current.status === 'active' || current.status === 'paused') &&
      current.secretGeneration === operation.secretGeneration &&
      current.secretVersionId === operation.secretVersionId &&
      !current.provisioningOperationId
    ) {
      return current
    }
    if (
      current.status !== 'provisioning' ||
      current.provisioningOperationId !== operation.id ||
      current.revision !== operation.endpointRevision ||
      current.version !== operation.endpointVersion ||
      current.secretGeneration !== operation.secretGeneration ||
      current.secretVersionId !== operation.secretVersionId
    ) {
      throw inboundWebhookLifecycleConflict()
    }
    const now = new Date().toISOString()
    const completedEndpoint: AutomationInboundWebhookEndpointRecord = {
      ...current,
      status: operation.targetStatus,
      revision: current.revision + 1,
      updatedAt: now,
      ...(operation.kind === 'rotate' ? { rotatedAt: now } : {}),
    }
    delete completedEndpoint.provisioningOperationId
    delete completedEndpoint.provisioningTargetStatus
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: createInboundWebhookEndpointStorageItem(completedEndpoint),
              ConditionExpression:
                '#status = :provisioning AND #revision = :expectedRevision AND #provisioningOperationId = :operationId AND #secretVersionId = :secretVersionId',
              ExpressionAttributeNames: {
                '#provisioningOperationId': 'provisioningOperationId',
                '#revision': 'revision',
                '#secretVersionId': 'secretVersionId',
                '#status': 'status',
              },
              ExpressionAttributeValues: {
                ':expectedRevision': current.revision,
                ':operationId': operation.id,
                ':provisioning': 'provisioning',
                ':secretVersionId': operation.secretVersionId,
              },
            },
          },
          {
            Update: {
              TableName: this.tableName,
              Key: {
                scopeKey: automationScopeKey(operation.workspaceId),
                recordKey: inboundWebhookOperationKey(operation.id),
              },
              ConditionExpression: '#status = :provisioning AND #requestFingerprint = :requestFingerprint',
              UpdateExpression: 'SET #status = :succeeded, #updatedAt = :updatedAt',
              ExpressionAttributeNames: {
                '#requestFingerprint': 'requestFingerprint',
                '#status': 'status',
                '#updatedAt': 'updatedAt',
              },
              ExpressionAttributeValues: {
                ':provisioning': 'provisioning',
                ':requestFingerprint': operation.requestFingerprint,
                ':succeeded': 'succeeded',
                ':updatedAt': now,
              },
            },
          },
        ],
      }))
      return completedEndpoint
    } catch (error) {
      if (!isTransactionConditionalCheckFailed(error)) throw persistenceError(error)
      const recovered = await this.requireInboundWebhookEndpointRecord(
        operation.workspaceId,
        operation.endpointId,
      )
      if (
        recovered.status === operation.targetStatus &&
        recovered.secretGeneration === operation.secretGeneration &&
        recovered.secretVersionId === operation.secretVersionId &&
        !recovered.provisioningOperationId
      ) {
        return recovered
      }
      throw inboundWebhookLifecycleConflict()
    }
  }

  /** Endpoint 表示名を revision CAS 付きで更新します。 */
  async updateInboundWebhookEndpoint(
    workspaceId: string,
    endpointId: string,
    input: UpdateAutomationInboundWebhookEndpointInput,
  ) {
    const normalized = validateUpdateAutomationInboundWebhookEndpointInput(input)
    const current = await this.requireInboundWebhookEndpointRecord(workspaceId, endpointId)
    assertInboundWebhookExpectedRevision(current.revision, normalized.expectedRevision)
    assertInboundWebhookMutable(current)
    const updated = {
      ...current,
      name: normalized.name,
      version: current.version + 1,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    }
    await this.saveInboundWebhookEndpointRecord(updated, current)
    return toAutomationInboundWebhookEndpoint(updated)
  }

  /** Endpoint を pause または resume します。 */
  async setInboundWebhookEndpointStatus(
    workspaceId: string,
    endpointId: string,
    input: AutomationInboundWebhookLifecycleInput,
    status: 'active' | 'paused',
  ) {
    const normalized = validateAutomationInboundWebhookLifecycleInput(input)
    const current = await this.requireInboundWebhookEndpointRecord(workspaceId, endpointId)
    assertInboundWebhookExpectedRevision(current.revision, normalized.expectedRevision)
    if (current.status === status) return toAutomationInboundWebhookEndpoint(current)
    const expectedStatus = status === 'active' ? 'paused' : 'active'
    if (current.status !== expectedStatus) throw inboundWebhookLifecycleConflict()
    const updated = {
      ...current,
      status,
      version: current.version + 1,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    }
    await this.saveInboundWebhookEndpointRecord(updated, current)
    return toAutomationInboundWebhookEndpoint(updated)
  }

  /** Endpoint を revoke して global lookup を削除します。 */
  async revokeInboundWebhookEndpoint(
    workspaceId: string,
    endpointId: string,
    input: AutomationInboundWebhookLifecycleInput,
  ) {
    const normalized = validateAutomationInboundWebhookLifecycleInput(input)
    const current = await this.requireInboundWebhookEndpointRecord(workspaceId, endpointId)
    if (current.status === 'revoked') return current
    assertInboundWebhookExpectedRevision(current.revision, normalized.expectedRevision)
    if (
      current.status !== 'active' &&
      current.status !== 'paused' &&
      current.status !== 'provisioning'
    ) {
      throw inboundWebhookLifecycleConflict()
    }
    const now = new Date().toISOString()
    const revoked: AutomationInboundWebhookEndpointRecord = {
      ...current,
      status: 'revoked',
      version: current.version + 1,
      revision: current.revision + 1,
      revokedAt: now,
      updatedAt: now,
    }
    delete revoked.provisioningOperationId
    delete revoked.provisioningTargetStatus
    const cleanup: AutomationInboundWebhookSecretCleanup = {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      workspaceId: current.workspaceId,
      endpointId: current.id,
      secretId: current.secretId,
      secretVersionId: current.secretVersionId,
      secretGeneration: current.secretGeneration,
      revision: 1,
      nextCleanupAt: new Date(
        Date.parse(now) + AUTOMATION_INBOUND_WEBHOOK_SECRET_CLEANUP_INTERVAL_MS,
      ).toISOString(),
      cleanupUntil: new Date(
        Date.parse(now) + AUTOMATION_INBOUND_WEBHOOK_SECRET_RECOVERY_MS +
          AUTOMATION_INBOUND_WEBHOOK_SECRET_CLEANUP_GRACE_MS,
      ).toISOString(),
      createdAt: now,
      updatedAt: now,
    }
    const provisioningCondition = current.status === 'provisioning'
      ? ' AND #provisioningOperationId = :provisioningOperationId'
      : ''
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: createInboundWebhookEndpointStorageItem(revoked),
              ConditionExpression:
                `#revision = :expectedRevision AND #version = :expectedVersion AND #secretGeneration = :expectedSecretGeneration AND (#status = :active OR #status = :paused OR #status = :provisioning)${provisioningCondition}`,
              ExpressionAttributeNames: {
                ...(current.status === 'provisioning'
                  ? { '#provisioningOperationId': 'provisioningOperationId' }
                  : {}),
                '#revision': 'revision',
                '#secretGeneration': 'secretGeneration',
                '#status': 'status',
                '#version': 'version',
              },
              ExpressionAttributeValues: {
                ':active': 'active',
                ':expectedRevision': current.revision,
                ':expectedSecretGeneration': current.secretGeneration,
                ':expectedVersion': current.version,
                ':paused': 'paused',
                ':provisioning': 'provisioning',
                ...(current.status === 'provisioning'
                  ? { ':provisioningOperationId': current.provisioningOperationId }
                  : {}),
              },
            },
          },
          {
            Delete: {
              TableName: this.tableName,
              Key: {
                scopeKey: inboundWebhookLookupScopeKey(current.opaqueEndpointId),
                recordKey: 'ENDPOINT',
              },
              ConditionExpression: '#workspaceId = :workspaceId AND #endpointId = :endpointId',
              ExpressionAttributeNames: {
                '#endpointId': 'endpointId',
                '#workspaceId': 'workspaceId',
              },
              ExpressionAttributeValues: {
                ':endpointId': current.id,
                ':workspaceId': current.workspaceId,
              },
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: createInboundWebhookSecretCleanupStorageItem(cleanup),
              ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
            },
          },
        ],
      }))
      return revoked
    } catch (error) {
      if (!isTransactionConditionalCheckFailed(error)) throw persistenceError(error)
      const recovered = await this.requireInboundWebhookEndpointRecord(workspaceId, endpointId)
      if (recovered.status === 'revoked') return recovered
      throw revisionConflict()
    }
  }

  /** Endpoint guard、delivery/signature receipt、audit outbox を atomic に保存します。 */
  async recordInboundWebhookDelivery(
    endpoint: AutomationInboundWebhookEndpointRecord,
    input: AutomationInboundWebhookDeliveryMutationInput<unknown>,
  ) {
    await this.ensureTable()
    if (!isDynamoDbAuditPutTransactionItem(input.auditMutation)) {
      throw invalidInput('Inbound webhook audit mutation is invalid.')
    }
    const normalizedKey = requireBoundedText(input.idempotencyKey, 'Inbound webhook idempotency key', 256)
    const idempotencyKeyHash = hashCanonicalText(normalizedKey)
    const bodyFingerprint = requireSha256Fingerprint(input.bodyFingerprint, 'Inbound webhook body fingerprint')
    const signatureFingerprint = requireSha256Fingerprint(
      input.signatureFingerprint,
      'Inbound webhook signature fingerprint',
    )
    const eventId = requireBoundedText(input.eventId, 'Inbound webhook event ID', 256)
    const deliveryKey = inboundWebhookDeliveryKey(endpoint.id, idempotencyKeyHash)
    const existing = await this.getInboundWebhookDeliveryReceipt(endpoint.workspaceId, deliveryKey)
    if (existing) {
      if (existing.bodyFingerprint !== bodyFingerprint) throw inboundWebhookIdempotencyConflict()
      await this.recordInboundWebhookSignatureReceipt(
        endpoint,
        idempotencyKeyHash,
        signatureFingerprint,
        input.signatureTimestamp,
      )
      return { eventId: existing.eventId, replayed: true }
    }

    const now = new Date().toISOString()
    const signatureReceipt = createInboundWebhookSignatureReceiptStorageItem(
      endpoint,
      idempotencyKeyHash,
      signatureFingerprint,
      input.signatureTimestamp,
      now,
    )
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          { ConditionCheck: createInboundWebhookActiveConditionCheck(this.tableName, endpoint) },
          {
            Put: {
              TableName: this.tableName,
              Item: {
                scopeKey: automationScopeKey(endpoint.workspaceId),
                recordKey: deliveryKey,
                entryType: 'inbound-webhook-delivery',
                endpointId: endpoint.id,
                idempotencyKeyHash,
                bodyFingerprint,
                eventId,
                createdAt: now,
                expiresAt: Math.floor(Date.parse(now) / 1_000) +
                  AUTOMATION_INBOUND_WEBHOOK_DELIVERY_RETENTION_SECONDS,
              },
              ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: signatureReceipt,
              ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
            },
          },
          input.auditMutation,
        ],
      }))
      return { eventId, replayed: false }
    } catch (error) {
      if (!isTransactionConditionalCheckFailed(error)) throw persistenceError(error)
      const replay = await this.getInboundWebhookDeliveryReceipt(endpoint.workspaceId, deliveryKey)
      if (replay) {
        if (replay.bodyFingerprint !== bodyFingerprint) throw inboundWebhookIdempotencyConflict()
        await this.recordInboundWebhookSignatureReceipt(
          endpoint,
          idempotencyKeyHash,
          signatureFingerprint,
          input.signatureTimestamp,
        )
        return { eventId: replay.eventId, replayed: true }
      }
      const signature = await this.getInboundWebhookSignatureReceipt(
        endpoint.workspaceId,
        endpoint.id,
        signatureFingerprint,
      )
      if (signature && signature.idempotencyKeyHash !== idempotencyKeyHash) {
        throw inboundWebhookSignatureReplay()
      }
      await this.throwInboundWebhookEndpointConditionFailure(endpoint)
      throw new AutomationError(
        'conflict',
        'AutomationInboundWebhookDeliveryConflict',
        'Inbound webhook delivery could not be committed.',
      )
    }
  }

  /** Due inbound webhook secret cleanup intents を返します。 */
  async listDueInboundWebhookSecretCleanups(
    scheduleShard: string,
    dueAt: string,
    limit = 100,
  ) {
    return await this.listDueEntries(
      scheduleShard,
      dueAt,
      'inbound-webhook-secret-cleanup',
      normalizeLimit(limit),
      readInboundWebhookSecretCleanup,
    )
  }

  /** DeleteSecret 成功後に cleanup intent を再予約または完了します。 */
  async completeInboundWebhookSecretCleanup(
    cleanup: AutomationInboundWebhookSecretCleanup,
    attemptedAt: string,
  ) {
    await this.ensureTable()
    const normalizedAttemptedAt = normalizeTimestamp(attemptedAt)
    const key = {
      scopeKey: automationScopeKey(cleanup.workspaceId),
      recordKey: inboundWebhookSecretCleanupKey(cleanup.endpointId),
    }
    const condition =
      '#entryType = :entryType AND #revision = :expectedRevision AND #nextCleanupAt = :expectedNextCleanupAt AND #secretId = :expectedSecretId'
    const expressionAttributeNames = {
      '#entryType': 'entryType',
      '#nextCleanupAt': 'nextCleanupAt',
      '#revision': 'revision',
      '#secretId': 'secretId',
    }
    const expressionAttributeValues = {
      ':entryType': 'inbound-webhook-secret-cleanup',
      ':expectedNextCleanupAt': cleanup.nextCleanupAt,
      ':expectedRevision': cleanup.revision,
      ':expectedSecretId': cleanup.secretId,
    }
    try {
      if (normalizedAttemptedAt < cleanup.cleanupUntil) {
        const nextCleanupAt = new Date(Math.min(
          Date.parse(normalizedAttemptedAt) +
            AUTOMATION_INBOUND_WEBHOOK_SECRET_CLEANUP_INTERVAL_MS,
          Date.parse(cleanup.cleanupUntil),
        )).toISOString()
        const updated: AutomationInboundWebhookSecretCleanup = {
          ...cleanup,
          revision: cleanup.revision + 1,
          nextCleanupAt,
          updatedAt: normalizedAttemptedAt,
        }
        await this.documentClient.send(new PutCommand({
          TableName: this.tableName,
          Item: createInboundWebhookSecretCleanupStorageItem(updated),
          ConditionExpression: condition,
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues,
        }))
      } else {
        await this.documentClient.send(new DeleteCommand({
          TableName: this.tableName,
          Key: key,
          ConditionExpression: condition,
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues,
        }))
      }
    } catch (error) {
      if (isNamedError(error, 'ConditionalCheckFailedException')) return
      throw persistenceError(error)
    }
  }

  /** Workspace の recurring definitions を返します。 */
  async listRecurringWorks(workspaceId: string) {
    return await this.listCurrent<RecurringWork>(workspaceId, 'RECURRING#', 'recurring')
  }

  /** Recurring definition を返します。 */
  async getRecurringWork(workspaceId: string, recurringWorkId: string) {
    return await this.getCurrent<RecurringWork>(workspaceId, `RECURRING#${encodeKey(recurringWorkId)}`, 'recurring')
  }

  /** Recurring definition を作成します。 */
  async createRecurringWork(workspaceId: string, input: CreateRecurringWorkInput, idempotencyKey?: string) {
    await this.ensureTable()
    const normalizedWorkspaceId = requireText(workspaceId, 'Workspace ID')
    const normalized = validateCreateRecurringWorkInput(input)
    const createIdentity = idempotencyKey
      ? createAutomationCreateIdentity(normalizedWorkspaceId, 'recurring', idempotencyKey, normalized)
      : undefined
    if (createIdentity) {
      const replay = await this.getOptionalIdempotentCreateReplay<RecurringWork>(
        normalizedWorkspaceId,
        `RECURRING#${encodeKey(createIdentity.resourceId)}`,
        'recurring',
        createIdentity,
      )
      if (replay) return replay
    }
    const template = await this.requireEnabledWorkItemTemplate(
      normalizedWorkspaceId,
      normalized.templateId,
    )
    const now = new Date().toISOString()
    const nextRunAt = getNextRecurringOccurrence(normalized.schedule, new Date(now))
    if (!nextRunAt) throw invalidInput('Recurring schedule has no future occurrence.')
    const recurring: RecurringWork = {
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      id: createIdentity?.resourceId ?? createResourceId('recurring', normalized.name),
      workspaceId: normalizedWorkspaceId,
      ...normalized,
      templateVersion: template.version,
      version: 1,
      revision: 1,
      nextRunAt: nextRunAt.toISOString(),
      createdAt: now,
      updatedAt: now,
    }
    const currentKey = `RECURRING#${encodeKey(recurring.id)}`
    try {
      await this.putVersionedCreate(
        normalizedWorkspaceId,
        currentKey,
        recurringVersionKey(recurring.id, 1),
        'recurring',
        recurring,
        recurringIndexAttributes(recurring),
        createIdentity,
      )
    } catch (error) {
      if (!createIdentity || !isTransactionConditionalCheckFailed(error)) throw persistenceError(error)
      return await this.getIdempotentCreateReplay<RecurringWork>(
        normalizedWorkspaceId,
        currentKey,
        'recurring',
        createIdentity,
      )
    }
    return recurring
  }

  /** Recurring definition を更新します。 */
  async updateRecurringWork(workspaceId: string, recurringWorkId: string, input: UpdateRecurringWorkInput) {
    const current = await this.requireRecurringWork(workspaceId, recurringWorkId)
    assertExpectedRevision(current.revision, input.expectedRevision)
    const normalized = validateCreateRecurringWorkInput({
      name: input.name ?? current.name,
      teamId: input.teamId ?? current.teamId,
      enabled: input.enabled ?? current.enabled,
      templateId: input.templateId ?? current.templateId,
      schedule: input.schedule ?? current.schedule,
    })
    const now = new Date()
    const scheduleChanged = canonicalString(normalized.schedule) !== canonicalString(current.schedule)
    const activeSlotExecution = scheduleChanged
      ? await this.getExecution(
          workspaceId,
          createRecurringExecutionId(workspaceId, current.id, current.nextRunAt),
        )
      : undefined
    const mustFinishCurrentSlot = activeSlotExecution?.status === 'pending' ||
      activeSlotExecution?.status === 'running' ||
      (activeSlotExecution?.status === 'failed' && activeSlotExecution.retryable)
    const nextRunAt = !scheduleChanged || mustFinishCurrentSlot
      ? new Date(current.nextRunAt)
      : getNextRecurringOccurrence(normalized.schedule, now)
    if (!nextRunAt) throw invalidInput('Recurring schedule has no future occurrence.')
    const templateVersion = input.templateId === undefined
      ? current.templateVersion
      : (await this.requireEnabledWorkItemTemplate(workspaceId, normalized.templateId)).version
    const recurring: RecurringWork = {
      ...current,
      ...normalized,
      templateVersion,
      version: current.version + 1,
      revision: current.revision + 1,
      nextRunAt: nextRunAt.toISOString(),
      updatedAt: now.toISOString(),
    }
    await this.putVersionedUpdate(
      workspaceId,
      `RECURRING#${encodeKey(recurring.id)}`,
      recurringVersionKey(recurring.id, recurring.version),
      'recurring',
      recurring,
      current.revision,
      recurringIndexAttributes(recurring),
    )
    return recurring
  }

  /** Scheduled slot 完了後に last/next run を revision CAS 付きで進めます。 */
  async completeRecurringWork(
    workspaceId: string,
    recurringWorkId: string,
    expectedRevision: number,
    lastRunAt: string,
    nextRunAt: string,
  ) {
    const current = await this.requireRecurringWork(workspaceId, recurringWorkId)
    assertExpectedRevision(current.revision, expectedRevision)
    if (!current.enabled) {
      throw new AutomationError('conflict', 'RecurringWorkDisabled', 'Recurring Work definition is disabled.')
    }
    const normalizedLastRunAt = normalizeTimestamp(lastRunAt)
    const normalizedNextRunAt = normalizeTimestamp(nextRunAt)
    if (normalizedNextRunAt <= normalizedLastRunAt) {
      throw invalidInput('Recurring next run must be later than the completed run.')
    }
    if (current.lastRunAt && normalizedLastRunAt <= normalizeTimestamp(current.lastRunAt)) {
      throw new AutomationError('conflict', 'RecurringSlotAlreadyCompleted', 'Recurring Work slot was already completed.')
    }
    const recurring: RecurringWork = {
      ...current,
      revision: current.revision + 1,
      lastRunAt: normalizedLastRunAt,
      nextRunAt: normalizedNextRunAt,
      updatedAt: new Date().toISOString(),
    }
    await this.putCurrentUpdate(
      workspaceId,
      `RECURRING#${encodeKey(recurring.id)}`,
      'recurring',
      recurring,
      current.revision,
      recurringIndexAttributes(recurring),
    )
    return recurring
  }

  /** Recurring definition を削除します。 */
  async deleteRecurringWork(workspaceId: string, recurringWorkId: string, expectedRevision: number) {
    await this.deleteCurrent(workspaceId, `RECURRING#${encodeKey(recurringWorkId)}`, expectedRevision)
  }

  /** Due recurring definitions を ScheduleDueIndex から返します。 */
  async listDueRecurringWorks(scheduleShard: string, dueAt: string, limit = 100) {
    return await this.listDueEntries(
      scheduleShard,
      dueAt,
      'recurring',
      normalizeLimit(limit),
      readRecurringWork,
    )
  }

  /** Due retry/runner lease rule executions を ScheduleDueIndex から返します。 */
  async listDueExecutions(scheduleShard: string, dueAt: string, limit = 100) {
    return await this.listDueEntries(
      scheduleShard,
      dueAt,
      'execution',
      normalizeLimit(limit),
      readExecution,
    )
  }

  /** Rule execution と fixed-window rate token を同じ transaction で予約します。 */
  async reserveExecution(
    execution: AutomationExecution,
    event: AutomationEvent,
    rule: AutomationRule,
  ) {
    await this.ensureTable()
    const now = new Date(execution.startedAt)
    if (!isValidDate(now)) {
      throw invalidInput('Automation execution start time is invalid.')
    }
    const windowMilliseconds = rule.rateLimit.windowSeconds * 1_000
    const windowStartedAt = Math.floor(now.getTime() / windowMilliseconds) * windowMilliseconds
    const counterKey = {
      scopeKey: automationScopeKey(rule.workspaceId),
      recordKey: `RATE#${encodeKey(rule.id)}#${windowStartedAt}`,
    }
    const counterExpiresAt = Math.floor(
      (windowStartedAt + windowMilliseconds + 86_400_000) / 1_000,
    )
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: createAutomationExecutionDefinitionConditionCheck(
              this.tableName,
              rule.workspaceId,
              {
                kind: 'rule',
                id: rule.id,
                version: rule.version,
                revision: rule.revision,
              },
            ),
          },
          {
            Put: {
              TableName: this.tableName,
              Item: {
                scopeKey: automationScopeKey(execution.workspaceId),
                recordKey: `EXECUTION#${encodeKey(execution.id)}`,
                entryType: 'execution',
                ...execution,
                triggerEvent: event,
                ruleExecutionKey: `${execution.workspaceId}#rule#${execution.ruleId}`,
                startedAtExecutionId: `${execution.startedAt}#${execution.id}`,
              },
              ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
            },
          },
          {
            Update: {
              TableName: this.tableName,
              Key: counterKey,
              UpdateExpression:
                'SET #entryType = if_not_exists(#entryType, :entryType), #expiresAt = :expiresAt ADD #executionCount :one',
              ConditionExpression:
                'attribute_not_exists(#executionCount) OR #executionCount < :maximumExecutions',
              ExpressionAttributeNames: {
                '#entryType': 'entryType',
                '#expiresAt': 'expiresAt',
                '#executionCount': 'executionCount',
              },
              ExpressionAttributeValues: {
                ':entryType': 'rate-limit-counter',
                ':expiresAt': counterExpiresAt,
                ':one': 1,
                ':maximumExecutions': rule.rateLimit.maxExecutions,
              },
            },
          },
        ],
      }))
      return 'created' as const
    } catch (error) {
      if (!isNamedError(error, 'TransactionCanceledException')) throw persistenceError(error)
      const existing = await this.getExecution(rule.workspaceId, execution.id)
      if (existing) return 'duplicate' as const
      const currentRule = await this.getRule(rule.workspaceId, rule.id)
      if (
        !currentRule ||
        !currentRule.enabled ||
        currentRule.version !== rule.version ||
        currentRule.revision !== rule.revision
      ) {
        return 'stale-definition' as const
      }
      const counter = await this.documentClient.send(new GetCommand({
        TableName: this.tableName,
        Key: counterKey,
        ConsistentRead: true,
      }))
      if (typeof counter.Item?.executionCount === 'number' &&
        counter.Item.executionCount >= rule.rateLimit.maxExecutions) {
        return 'rate-limited' as const
      }
      throw persistenceError(error)
    }
  }

  /** Execution を deterministic key と optional current-definition guard で条件付き作成します。 */
  async createExecution(
    execution: AutomationExecution,
    event: AutomationEvent,
    definitionGuard?: AutomationExecutionDefinitionGuard,
  ) {
    await this.ensureTable()
    const item = {
      scopeKey: automationScopeKey(execution.workspaceId),
      recordKey: `EXECUTION#${encodeKey(execution.id)}`,
      entryType: 'execution',
      ...execution,
      triggerEvent: event,
      ruleExecutionKey: `${execution.workspaceId}#rule#${execution.ruleId}`,
      startedAtExecutionId: `${execution.startedAt}#${execution.id}`,
    }
    try {
      if (definitionGuard) {
        await this.documentClient.send(new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: createAutomationExecutionDefinitionConditionCheck(
                this.tableName,
                execution.workspaceId,
                definitionGuard,
              ),
            },
            {
              Put: {
                TableName: this.tableName,
                Item: item,
                ConditionExpression:
                  'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
              },
            },
          ],
        }))
      } else {
        await this.documentClient.send(new PutCommand({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
        }))
      }
      return true
    } catch (error) {
      if (
        isNamedError(error, 'ConditionalCheckFailedException') ||
        (definitionGuard && isTransactionConditionalCheckFailed(error))
      ) {
        return false
      }
      throw persistenceError(error)
    }
  }

  /** Execution を返します。 */
  async getExecution(workspaceId: string, executionId: string) {
    return await this.getCurrent<AutomationExecution>(
      workspaceId,
      `EXECUTION#${encodeKey(executionId)}`,
      'execution',
    )
  }

  /** Execution と同じ row に保持した trigger event を返します。 */
  async getExecutionEvent(workspaceId: string, executionId: string) {
    await this.ensureTable()
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        scopeKey: automationScopeKey(workspaceId),
        recordKey: `EXECUTION#${encodeKey(executionId)}`,
      },
      ConsistentRead: true,
    }))
    return response.Item?.entryType === 'execution' && isAutomationEvent(response.Item.triggerEvent)
      ? structuredClone(response.Item.triggerEvent)
      : undefined
  }

  /** Execution runner lease を state/attempt CAS 付きで取得します。 */
  async claimExecution(
    execution: AutomationExecution,
    now: Date,
    leaseExpiresAt: string,
    definitionGuard?: AutomationExecutionDefinitionGuard,
  ) {
    await this.ensureTable()
    const normalizedLeaseExpiresAt = normalizeTimestamp(leaseExpiresAt)
    const expectedStatus = execution.status
    const expectedAttempts = execution.attempts
    const recurringExecution = execution.ruleId.startsWith('recurring:')
    const update = {
      TableName: this.tableName,
      Key: {
        scopeKey: automationScopeKey(execution.workspaceId),
        recordKey: `EXECUTION#${encodeKey(execution.id)}`,
      },
      UpdateExpression: [
        'SET #status = :running, #attempts = :nextAttempts, #retryable = :notRetryable, ' +
          '#nextRetryAt = :leaseExpiresAt' + (recurringExecution
            ? ''
            : ', #scheduleShard = :scheduleShard, #nextRunAtRecordKey = :nextRunAtRecordKey'),
        'REMOVE #completedAt, #errorCode, #errorMessage' + (recurringExecution
          ? ', #scheduleShard, #nextRunAtRecordKey'
          : ''),
      ].join(' '),
      ConditionExpression: [
        '#status = :expectedStatus',
        '#attempts = :expectedAttempts',
        ...(expectedStatus === 'running'
          ? ['(attribute_not_exists(#nextRetryAt) OR #nextRetryAt <= :now)']
          : []),
      ].join(' AND '),
      ExpressionAttributeNames: {
        '#status': 'status',
        '#attempts': 'attempts',
        '#retryable': 'retryable',
        '#nextRetryAt': 'nextRetryAt',
        '#scheduleShard': 'scheduleShard',
        '#nextRunAtRecordKey': 'nextRunAtRecordKey',
        '#completedAt': 'completedAt',
        '#errorCode': 'errorCode',
        '#errorMessage': 'errorMessage',
      },
      ExpressionAttributeValues: {
        ':running': 'running',
        ':nextAttempts': expectedAttempts + 1,
        ':notRetryable': false,
        ':leaseExpiresAt': normalizedLeaseExpiresAt,
        ...(recurringExecution
          ? {}
          : {
              ':scheduleShard': createAutomationScheduleShard(
                execution.workspaceId,
                `execution:${execution.id}`,
              ),
              ':nextRunAtRecordKey': `${normalizedLeaseExpiresAt}#execution#${execution.id}`,
            }),
        ':expectedStatus': expectedStatus,
        ':expectedAttempts': expectedAttempts,
        ...(expectedStatus === 'running' ? { ':now': now.toISOString() } : {}),
      },
    }
    try {
      if (definitionGuard) {
        await this.documentClient.send(new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: createAutomationExecutionDefinitionConditionCheck(
                this.tableName,
                execution.workspaceId,
                definitionGuard,
              ),
            },
            { Update: update },
          ],
        }))
      } else {
        await this.documentClient.send(new UpdateCommand(update))
      }
      return true
    } catch (error) {
      if (
        isNamedError(error, 'ConditionalCheckFailedException') ||
        (definitionGuard && isTransactionConditionalCheckFailed(error))
      ) return false
      throw persistenceError(error)
    }
  }

  /** Execution state を runner lease fencing token の CAS 付きで保存します。 */
  async saveExecution(
    execution: AutomationExecution,
    claimToken: AutomationExecutionClaimToken,
    now: Date,
  ) {
    await this.ensureTable()
    const triggerEvent = await this.getExecutionEvent(execution.workspaceId, execution.id)
    if (!triggerEvent) {
      throw new AutomationError('unavailable', 'AutomationTriggerEventUnavailable', 'Automation trigger event is unavailable.')
    }
    const expectedLeaseExpiresAt = normalizeTimestamp(claimToken.leaseExpiresAt)
    if (
      !Number.isSafeInteger(claimToken.attempt) ||
      claimToken.attempt < 1 ||
      execution.attempts !== claimToken.attempt ||
      (execution.status === 'running' && execution.nextRetryAt !== expectedLeaseExpiresAt) ||
      !isValidDate(now)
    ) {
      throw invalidInput('Automation execution claim token is invalid.')
    }
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          scopeKey: automationScopeKey(execution.workspaceId),
          recordKey: `EXECUTION#${encodeKey(execution.id)}`,
          entryType: 'execution',
          ...execution,
          triggerEvent,
          ruleExecutionKey: `${execution.workspaceId}#rule#${execution.ruleId}`,
          startedAtExecutionId: `${execution.startedAt}#${execution.id}`,
          ...executionDueIndexAttributes(execution),
        },
        ConditionExpression: [
          'attribute_exists(scopeKey)',
          'attribute_exists(recordKey)',
          '#status = :running',
          '#attempts = :expectedAttempt',
          '#nextRetryAt = :expectedLeaseExpiresAt',
          '#nextRetryAt > :now',
        ].join(' AND '),
        ExpressionAttributeNames: {
          '#status': 'status',
          '#attempts': 'attempts',
          '#nextRetryAt': 'nextRetryAt',
        },
        ExpressionAttributeValues: {
          ':running': 'running',
          ':expectedAttempt': claimToken.attempt,
          ':expectedLeaseExpiresAt': expectedLeaseExpiresAt,
          ':now': now.toISOString(),
        },
      }))
      return true
    } catch (error) {
      if (isNamedError(error, 'ConditionalCheckFailedException')) return false
      throw persistenceError(error)
    }
  }

  /** Rule execution timeline を返します。 */
  async listExecutions(query: AutomationExecutionQuery) {
    await this.ensureTable()
    const limit = normalizeLimit(query.limit ?? 50)
    const readBudget = query.status === undefined ? limit : limit * 5
    const indexQuery: {
      IndexName: string
      KeyConditionExpression: string
      ExpressionAttributeNames: Record<string, string>
      ExpressionAttributeValues: Record<string, string>
    } = query.ruleId
      ? {
          IndexName: 'RuleExecutionIndex',
          KeyConditionExpression: '#ruleExecutionKey = :ruleExecutionKey',
          ExpressionAttributeNames: { '#ruleExecutionKey': 'ruleExecutionKey' },
          ExpressionAttributeValues: {
            ':ruleExecutionKey': `${requireText(query.workspaceId, 'Workspace ID')}#rule#${requireText(query.ruleId, 'Rule ID')}`,
          },
        }
      : {
          IndexName: 'WorkspaceExecutionIndex',
          KeyConditionExpression: '#scopeKey = :scopeKey',
          ExpressionAttributeNames: { '#scopeKey': 'scopeKey' },
          ExpressionAttributeValues: {
            ':scopeKey': automationScopeKey(query.workspaceId),
          },
        }
    const executions: AutomationExecution[] = []
    let evaluated = 0
    let exclusiveStartKey = query.cursor ? decodeCursor(query.cursor) : undefined
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        ...indexQuery,
        ...(query.status !== undefined
          ? {
              FilterExpression: '#status = :status',
              ExpressionAttributeNames: {
                ...indexQuery.ExpressionAttributeNames,
                '#status': 'status',
              },
              ExpressionAttributeValues: {
                ...indexQuery.ExpressionAttributeValues,
                ':status': query.status,
              },
            }
          : {}),
        Limit: Math.min(limit - executions.length, readBudget - evaluated),
        ScanIndexForward: false,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))
      executions.push(...(response.Items ?? []).map(readExecution))
      const evaluatedCount = response.ScannedCount ?? response.Count ?? response.Items?.length ?? 0
      evaluated += Math.max(evaluatedCount, response.LastEvaluatedKey ? 1 : 0)
      exclusiveStartKey = response.LastEvaluatedKey
    } while (
      query.status !== undefined &&
      executions.length < limit &&
      exclusiveStartKey &&
      evaluated < readBudget
    )
    return {
      executions,
      ...(exclusiveStartKey ? { nextCursor: encodeCursor(exclusiveStartKey) } : {}),
    }
  }

  /** 成功済み action receipt が存在するか返します。 */
  async hasActionReceipt(workspaceId: string, executionId: string, actionId: string) {
    await this.ensureTable()
    const result = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        scopeKey: executionScopeKey(workspaceId, executionId),
        recordKey: `ACTION#${encodeKey(actionId)}`,
      },
      ConsistentRead: true,
    }))
    return result.Item !== undefined
  }

  /** 成功済み action receipt を条件付き保存します。 */
  async putActionReceipt(workspaceId: string, executionId: string, actionId: string) {
    await this.ensureTable()
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          scopeKey: executionScopeKey(workspaceId, executionId),
          recordKey: `ACTION#${encodeKey(actionId)}`,
          entryType: 'action-receipt',
          actionId,
          processedAt: new Date().toISOString(),
        },
        ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
      }))
      return true
    } catch (error) {
      if (isNamedError(error, 'ConditionalCheckFailedException')) return false
      throw persistenceError(error)
    }
  }

  /** Durable bulk operation を条件付き作成します。 */
  async createBulkOperation(operation: BulkOperation) {
    await this.ensureTable()
    if (operation.revision !== 1) throw invalidInput('New Bulk operation revision must be 1.')
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: createBulkOperationStorageItem(operation),
        ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
      }))
      return true
    } catch (error) {
      if (isNamedError(error, 'ConditionalCheckFailedException')) return false
      throw persistenceError(error)
    }
  }

  /** Durable bulk operation を revision CAS 付きで保存します。 */
  async saveBulkOperation(operation: BulkOperation, expectedRevision: number) {
    await this.ensureTable()
    const expected = requireInteger(
      expectedRevision,
      'Bulk operation expected revision',
      1,
      Number.MAX_SAFE_INTEGER,
    )
    if (operation.revision !== expected + 1) {
      throw invalidInput('Bulk operation revision must advance by exactly one.')
    }
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: createBulkOperationStorageItem(operation),
        ConditionExpression: '#revision = :expectedRevision',
        ExpressionAttributeNames: { '#revision': 'revision' },
        ExpressionAttributeValues: { ':expectedRevision': expected },
      }))
    } catch (error) {
      if (isNamedError(error, 'ConditionalCheckFailedException')) throw bulkRevisionConflict()
      throw persistenceError(error)
    }
  }

  /** Durable bulk operation を返します。 */
  async getBulkOperation(workspaceId: string, operationId: string) {
    await this.ensureTable()
    const result = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { scopeKey: bulkScopeKey(workspaceId, operationId), recordKey: 'OPERATION' },
      ConsistentRead: true,
    }))
    return result.Item?.entryType === 'bulk-operation' ? readBulkOperation(result.Item) : undefined
  }

  private async getInboundWebhookEndpointRecord(workspaceId: string, endpointId: string) {
    const value = await this.getCurrent<Record<string, unknown>>(
      workspaceId,
      inboundWebhookEndpointKey(endpointId),
      'inbound-webhook',
    )
    return value ? readInboundWebhookEndpointRecord(value) : undefined
  }

  private async requireInboundWebhookEndpointRecord(workspaceId: string, endpointId: string) {
    const value = await this.getInboundWebhookEndpointRecord(workspaceId, endpointId)
    if (!value) throw inboundWebhookNotFound()
    return value
  }

  private async getInboundWebhookProvisioningOperation(
    workspaceId: string,
    operationId: string,
  ) {
    await this.ensureTable()
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        scopeKey: automationScopeKey(workspaceId),
        recordKey: inboundWebhookOperationKey(operationId),
      },
      ConsistentRead: true,
    }))
    return response.Item?.entryType === 'inbound-webhook-provisioning'
      ? readInboundWebhookProvisioningOperation(response.Item)
      : undefined
  }

  private async readInboundWebhookProvisioningReplay(
    operation: AutomationInboundWebhookProvisioningOperation,
    requestFingerprint: string,
  ) {
    if (operation.requestFingerprint !== requestFingerprint) throw idempotencyConflict()
    assertInboundWebhookSecretRecoveryOpen(operation)
    const endpoint = await this.requireInboundWebhookEndpointRecord(
      operation.workspaceId,
      operation.endpointId,
    )
    if (endpoint.status === 'revoked') throw inboundWebhookNotFound()
    if (
      endpoint.secretGeneration !== operation.secretGeneration ||
      endpoint.secretVersionId !== operation.secretVersionId
    ) {
      throw new AutomationError(
        'conflict',
        'AutomationInboundWebhookSecretSuperseded',
        'Inbound webhook signing secret was superseded by a later rotation.',
      )
    }
    if (operation.status === 'provisioning') {
      if (
        endpoint.status !== 'provisioning' ||
        endpoint.provisioningOperationId !== operation.id
      ) {
        throw inboundWebhookLifecycleConflict()
      }
    } else if (
      endpoint.status !== 'active' && endpoint.status !== 'paused'
    ) {
      throw inboundWebhookLifecycleConflict()
    }
    return { endpoint, operation }
  }

  private async saveInboundWebhookEndpointRecord(
    updated: AutomationInboundWebhookEndpointRecord,
    current: AutomationInboundWebhookEndpointRecord,
  ) {
    await this.ensureTable()
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: createInboundWebhookEndpointStorageItem(updated),
        ConditionExpression:
          '#revision = :expectedRevision AND #status = :expectedStatus AND #version = :expectedVersion AND #secretGeneration = :expectedSecretGeneration',
        ExpressionAttributeNames: {
          '#revision': 'revision',
          '#secretGeneration': 'secretGeneration',
          '#status': 'status',
          '#version': 'version',
        },
        ExpressionAttributeValues: {
          ':expectedRevision': current.revision,
          ':expectedSecretGeneration': current.secretGeneration,
          ':expectedStatus': current.status,
          ':expectedVersion': current.version,
        },
      }))
    } catch (error) {
      if (isNamedError(error, 'ConditionalCheckFailedException')) throw revisionConflict()
      throw persistenceError(error)
    }
  }

  private async getInboundWebhookDeliveryReceipt(workspaceId: string, recordKey: string) {
    await this.ensureTable()
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { scopeKey: automationScopeKey(workspaceId), recordKey },
      ConsistentRead: true,
    }))
    if (response.Item?.entryType !== 'inbound-webhook-delivery') return undefined
    if (
      typeof response.Item.bodyFingerprint !== 'string' ||
      typeof response.Item.eventId !== 'string'
    ) {
      throw storedInvalid('inbound webhook delivery receipt')
    }
    return {
      bodyFingerprint: response.Item.bodyFingerprint,
      eventId: response.Item.eventId,
    }
  }

  private async getInboundWebhookSignatureReceipt(
    workspaceId: string,
    endpointId: string,
    signatureFingerprint: string,
  ) {
    await this.ensureTable()
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        scopeKey: automationScopeKey(workspaceId),
        recordKey: inboundWebhookSignatureKey(endpointId, signatureFingerprint),
      },
      ConsistentRead: true,
    }))
    if (response.Item?.entryType !== 'inbound-webhook-signature') return undefined
    if (typeof response.Item.idempotencyKeyHash !== 'string') {
      throw storedInvalid('inbound webhook signature receipt')
    }
    return { idempotencyKeyHash: response.Item.idempotencyKeyHash }
  }

  private async recordInboundWebhookSignatureReceipt(
    endpoint: AutomationInboundWebhookEndpointRecord,
    idempotencyKeyHash: string,
    signatureFingerprint: string,
    signatureTimestamp: string,
  ) {
    const existing = await this.getInboundWebhookSignatureReceipt(
      endpoint.workspaceId,
      endpoint.id,
      signatureFingerprint,
    )
    if (existing) {
      if (existing.idempotencyKeyHash !== idempotencyKeyHash) throw inboundWebhookSignatureReplay()
      await this.assertInboundWebhookSignatureReceiptActive(
        endpoint,
        idempotencyKeyHash,
        signatureFingerprint,
      )
      return
    }
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          { ConditionCheck: createInboundWebhookActiveConditionCheck(this.tableName, endpoint) },
          {
            Put: {
              TableName: this.tableName,
              Item: createInboundWebhookSignatureReceiptStorageItem(
                endpoint,
                idempotencyKeyHash,
                signatureFingerprint,
                signatureTimestamp,
                new Date().toISOString(),
              ),
              ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
            },
          },
        ],
      }))
    } catch (error) {
      if (!isTransactionConditionalCheckFailed(error)) throw persistenceError(error)
      const raced = await this.getInboundWebhookSignatureReceipt(
        endpoint.workspaceId,
        endpoint.id,
        signatureFingerprint,
      )
      if (raced) {
        if (raced.idempotencyKeyHash !== idempotencyKeyHash) throw inboundWebhookSignatureReplay()
        await this.assertInboundWebhookSignatureReceiptActive(
          endpoint,
          idempotencyKeyHash,
          signatureFingerprint,
        )
        return
      }
      await this.throwInboundWebhookEndpointConditionFailure(endpoint)
      throw new AutomationError(
        'conflict',
        'AutomationInboundWebhookSignatureConflict',
        'Inbound webhook signature receipt could not be committed.',
      )
    }
  }

  private async assertInboundWebhookSignatureReceiptActive(
    endpoint: AutomationInboundWebhookEndpointRecord,
    idempotencyKeyHash: string,
    signatureFingerprint: string,
  ) {
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          { ConditionCheck: createInboundWebhookActiveConditionCheck(this.tableName, endpoint) },
          {
            ConditionCheck: {
              TableName: this.tableName,
              Key: {
                scopeKey: automationScopeKey(endpoint.workspaceId),
                recordKey: inboundWebhookSignatureKey(endpoint.id, signatureFingerprint),
              },
              ConditionExpression:
                '#entryType = :entryType AND #endpointId = :endpointId AND #endpointVersion = :endpointVersion AND #secretGeneration = :secretGeneration AND #secretVersionId = :secretVersionId AND #idempotencyKeyHash = :idempotencyKeyHash AND #signatureFingerprint = :signatureFingerprint',
              ExpressionAttributeNames: {
                '#endpointId': 'endpointId',
                '#endpointVersion': 'endpointVersion',
                '#entryType': 'entryType',
                '#idempotencyKeyHash': 'idempotencyKeyHash',
                '#secretGeneration': 'secretGeneration',
                '#secretVersionId': 'secretVersionId',
                '#signatureFingerprint': 'signatureFingerprint',
              },
              ExpressionAttributeValues: {
                ':endpointId': endpoint.id,
                ':endpointVersion': endpoint.version,
                ':entryType': 'inbound-webhook-signature',
                ':idempotencyKeyHash': idempotencyKeyHash,
                ':secretGeneration': endpoint.secretGeneration,
                ':secretVersionId': endpoint.secretVersionId,
                ':signatureFingerprint': signatureFingerprint,
              },
            },
          },
        ],
      }))
    } catch (error) {
      if (!isTransactionConditionalCheckFailed(error)) throw persistenceError(error)
      const receipt = await this.getInboundWebhookSignatureReceipt(
        endpoint.workspaceId,
        endpoint.id,
        signatureFingerprint,
      )
      if (receipt && receipt.idempotencyKeyHash !== idempotencyKeyHash) {
        throw inboundWebhookSignatureReplay()
      }
      await this.throwInboundWebhookEndpointConditionFailure(endpoint)
    }
  }

  private async throwInboundWebhookEndpointConditionFailure(
    expected: AutomationInboundWebhookEndpointRecord,
  ): Promise<never> {
    const current = await this.getInboundWebhookEndpointRecord(expected.workspaceId, expected.id)
    if (!current || current.status === 'revoked') {
      throw inboundWebhookNotFound()
    }
    if (current.status === 'paused') {
      throw new AutomationError(
        'locked',
        'AutomationInboundWebhookPaused',
        'Inbound webhook endpoint is paused.',
      )
    }
    throw new AutomationError(
      'conflict',
      'AutomationInboundWebhookVersionConflict',
      'Inbound webhook endpoint, lifecycle, or signing secret changed during delivery.',
    )
  }

  /** Local table が必要なら作成します。 */
  private async ensureTable() {
    if (this.bootstrapLocalTable && this.dynamoDbClient) {
      await ensureLocalAutomationTable(this.tableName, this.dynamoDbClient)
    }
  }

  /** Prefix に一致する current rows を返します。 */
  private async listCurrent<T>(workspaceId: string, prefix: string, entryType: string) {
    await this.ensureTable()
    const items: T[] = []
    const seenCursors = new Set<string>()
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        ConsistentRead: true,
        KeyConditionExpression: '#scopeKey = :scopeKey AND begins_with(#recordKey, :prefix)',
        ExpressionAttributeNames: { '#scopeKey': 'scopeKey', '#recordKey': 'recordKey' },
        ExpressionAttributeValues: { ':scopeKey': automationScopeKey(workspaceId), ':prefix': prefix },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))
      items.push(...(response.Items ?? [])
        .filter((item) => item.entryType === entryType)
        .map((item) => stripStorage<T>(item)))
      exclusiveStartKey = response.LastEvaluatedKey
      if (exclusiveStartKey) {
        const cursorFingerprint = canonicalString(exclusiveStartKey)
        if (seenCursors.has(cursorFingerprint)) {
          throw new AutomationError(
            'unavailable',
            'AutomationPaginationCursorLoop',
            'Automation current-list pagination cursor did not advance.',
            true,
          )
        }
        seenCursors.add(cursorFingerprint)
      }
    } while (exclusiveStartKey)
    return items
  }

  /** Shared due index を pagination し、指定 entry type のみ limit まで返します。 */
  private async listDueEntries<T>(
    scheduleShard: string,
    dueAt: string,
    entryType: string,
    limit: number,
    read: (item: Record<string, unknown>) => T,
  ) {
    await this.ensureTable()
    const items: T[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        IndexName: 'ScheduleDueIndex',
        KeyConditionExpression: '#scheduleShard = :scheduleShard AND #nextRunAtRecordKey <= :due',
        ExpressionAttributeNames: {
          '#scheduleShard': 'scheduleShard',
          '#nextRunAtRecordKey': 'nextRunAtRecordKey',
        },
        ExpressionAttributeValues: {
          ':scheduleShard': requireText(scheduleShard, 'Schedule shard'),
          ':due': `${normalizeTimestamp(dueAt)}#\uffff`,
        },
        Limit: limit,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))
      items.push(...(response.Items ?? [])
        .filter((item) => item.entryType === entryType)
        .slice(0, limit - items.length)
        .map(read))
      exclusiveStartKey = response.LastEvaluatedKey
    } while (items.length < limit && exclusiveStartKey)
    return items
  }

  /** Current/version row を返します。 */
  private async getCurrent<T>(workspaceId: string, recordKey: string, entryType: string) {
    await this.ensureTable()
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { scopeKey: automationScopeKey(workspaceId), recordKey },
      ConsistentRead: true,
    }))
    return response.Item?.entryType === entryType ? stripStorage<T>(response.Item) : undefined
  }

  /** Rule を必須取得します。 */
  private async requireRule(workspaceId: string, ruleId: string) {
    const value = await this.getRule(workspaceId, ruleId)
    if (!value) throw new AutomationError('not-found', 'AutomationRuleNotFound', 'Automation rule was not found.')
    return value
  }

  /** Template を必須取得します。 */
  private async requireTemplate(workspaceId: string, templateId: string) {
    const value = await this.getTemplate(workspaceId, templateId)
    if (!value) throw new AutomationError('not-found', 'AutomationTemplateNotFound', 'Automation template was not found.')
    return value
  }

  /** Enabled Work Item template を取得し、保存時に固定できることを確認します。 */
  private async requireEnabledWorkItemTemplate(workspaceId: string, templateId: string) {
    const template = await this.requireTemplate(workspaceId, templateId)
    if (!template.enabled || template.kind !== 'work-item') {
      throw new AutomationError(
        'conflict',
        'AutomationTemplateUnavailable',
        'The selected Work Item template is unavailable.',
      )
    }
    return template
  }

  /** Create actions の template reference を current immutable version へ固定します。 */
  private async pinWorkItemTemplateVersions(
    workspaceId: string,
    actions: readonly AutomationAction[],
  ) {
    return await Promise.all(actions.map(async (action): Promise<AutomationAction> => {
      if (action.type !== 'create' || !action.templateId) return action
      const template = await this.requireEnabledWorkItemTemplate(workspaceId, action.templateId)
      return { ...action, templateVersion: template.version }
    }))
  }

  /** Recurring definition を必須取得します。 */
  private async requireRecurringWork(workspaceId: string, recurringWorkId: string) {
    const value = await this.getRecurringWork(workspaceId, recurringWorkId)
    if (!value) throw new AutomationError('not-found', 'RecurringWorkNotFound', 'Recurring Work definition was not found.')
    return value
  }

  private async assertActiveInboundWebhookTrigger(
    workspaceId: string,
    trigger: AutomationTrigger,
  ) {
    if (trigger.type !== 'webhook') return
    const endpoint = await this.getInboundWebhookEndpointRecord(workspaceId, trigger.webhookId)
    if (endpoint?.status !== 'active') {
      throw new AutomationError(
        'conflict',
        'AutomationInboundWebhookTriggerUnavailable',
        'Automation webhook trigger requires an active inbound webhook endpoint.',
      )
    }
    return endpoint
  }

  private async getOptionalIdempotentCreateReplay<T>(
    workspaceId: string,
    currentKey: string,
    entryType: string,
    identity: ReturnType<typeof createAutomationCreateIdentity>,
  ) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        scopeKey: automationScopeKey(workspaceId),
        recordKey: identity.receiptKey,
      },
      ConsistentRead: true,
    }))
    if (!response.Item) return undefined
    return await this.getIdempotentCreateReplay<T>(
      workspaceId,
      currentKey,
      entryType,
      identity,
    )
  }

  /** Idempotent create receipt を検証し、既存の current resource を返します。 */
  private async getIdempotentCreateReplay<T>(
    workspaceId: string,
    currentKey: string,
    entryType: string,
    identity: ReturnType<typeof createAutomationCreateIdentity>,
  ) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        scopeKey: automationScopeKey(workspaceId),
        recordKey: identity.receiptKey,
      },
      ConsistentRead: true,
    }))
    const receipt = response.Item
    if (
      receipt?.entryType !== 'create-receipt' ||
      receipt.resourceKind !== entryType ||
      receipt.resourceId !== identity.resourceId ||
      receipt.requestFingerprint !== identity.requestFingerprint
    ) {
      throw idempotencyConflict()
    }
    const existing = await this.getCurrent<T>(workspaceId, currentKey, entryType)
    if (!existing) throw idempotencyConflict()
    return existing
  }

  /** Current と immutable version を条件付き作成します。 */
  private async putVersionedCreate(
    workspaceId: string,
    currentKey: string,
    versionKey: string,
    entryType: string,
    value: object,
    extra: Record<string, unknown> = {},
    identity?: ReturnType<typeof createAutomationCreateIdentity>,
    additionalTransactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [],
  ) {
    const scopeKey = automationScopeKey(workspaceId)
    await this.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        ...[currentKey, versionKey].map((recordKey, index) => ({
          Put: {
            TableName: this.tableName,
            Item: {
              scopeKey,
              recordKey,
              entryType: index === 0 ? entryType : `${entryType}-version`,
              ...value,
              ...(index === 0 ? extra : {}),
            },
            ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
          },
        })),
        ...(identity
          ? [{
              Put: {
                TableName: this.tableName,
                Item: {
                  scopeKey,
                  recordKey: identity.receiptKey,
                  entryType: 'create-receipt',
                  resourceKind: entryType,
                  resourceId: identity.resourceId,
                  requestFingerprint: identity.requestFingerprint,
                },
                ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
              },
            }]
          : []),
        ...additionalTransactItems,
      ],
    }))
  }

  /** Current row CAS と immutable version create を同じ transaction で行います。 */
  private async putVersionedUpdate(
    workspaceId: string,
    currentKey: string,
    versionKey: string,
    entryType: string,
    value: object,
    expectedRevision: number,
    extra: Record<string, unknown> = {},
    additionalTransactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [],
  ) {
    const scopeKey = automationScopeKey(workspaceId)
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: { scopeKey, recordKey: currentKey, entryType, ...value, ...extra },
              ConditionExpression: '#revision = :expectedRevision',
              ExpressionAttributeNames: { '#revision': 'revision' },
              ExpressionAttributeValues: { ':expectedRevision': expectedRevision },
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: { scopeKey, recordKey: versionKey, entryType: `${entryType}-version`, ...value },
              ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
            },
          },
          ...additionalTransactItems,
        ],
      }))
    } catch (error) {
      if (isNamedError(error, 'TransactionCanceledException')) throw revisionConflict()
      throw persistenceError(error)
    }
  }

  /** Immutable version を増やさない operational current row を CAS 更新します。 */
  private async putCurrentUpdate(
    workspaceId: string,
    recordKey: string,
    entryType: string,
    value: object,
    expectedRevision: number,
    extra: Record<string, unknown> = {},
  ) {
    await this.ensureTable()
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          scopeKey: automationScopeKey(workspaceId),
          recordKey,
          entryType,
          ...value,
          ...extra,
        },
        ConditionExpression: '#revision = :expectedRevision',
        ExpressionAttributeNames: { '#revision': 'revision' },
        ExpressionAttributeValues: { ':expectedRevision': expectedRevision },
      }))
    } catch (error) {
      if (isNamedError(error, 'ConditionalCheckFailedException')) throw revisionConflict()
      throw persistenceError(error)
    }
  }

  /** Current row を revision CAS 付きで削除します。 */
  private async deleteCurrent(workspaceId: string, recordKey: string, expectedRevision: number) {
    await this.ensureTable()
    try {
      await this.documentClient.send(new DeleteCommand({
        TableName: this.tableName,
        Key: { scopeKey: automationScopeKey(workspaceId), recordKey },
        ConditionExpression: '#revision = :expectedRevision',
        ExpressionAttributeNames: { '#revision': 'revision' },
        ExpressionAttributeValues: { ':expectedRevision': expectedRevision },
      }))
    } catch (error) {
      if (isNamedError(error, 'ConditionalCheckFailedException')) throw revisionConflict()
      throw persistenceError(error)
    }
  }
}

/** CDK と同じ key/GSI schema の local Automation table を作成します。 */
export async function ensureLocalAutomationTable(tableName: string, client: DynamoDBClient) {
  try {
    const response = await client.send(new DescribeTableCommand({ TableName: tableName }))
    if (!isAutomationTableDescription(response.Table)) {
      throw new Error(`Local Automation table "${tableName}" has an incompatible schema.`)
    }
    return
  } catch (error) {
    if (!isNamedError(error, 'ResourceNotFoundException')) throw error
  }
  await client.send(new CreateTableCommand({
    TableName: tableName,
    AttributeDefinitions: [
      { AttributeName: 'scopeKey', AttributeType: 'S' },
      { AttributeName: 'recordKey', AttributeType: 'S' },
      { AttributeName: 'scheduleShard', AttributeType: 'S' },
      { AttributeName: 'nextRunAtRecordKey', AttributeType: 'S' },
      { AttributeName: 'ruleExecutionKey', AttributeType: 'S' },
      { AttributeName: 'startedAtExecutionId', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'scopeKey', KeyType: 'HASH' },
      { AttributeName: 'recordKey', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'ScheduleDueIndex',
        KeySchema: [
          { AttributeName: 'scheduleShard', KeyType: 'HASH' },
          { AttributeName: 'nextRunAtRecordKey', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'RuleExecutionIndex',
        KeySchema: [
          { AttributeName: 'ruleExecutionKey', KeyType: 'HASH' },
          { AttributeName: 'startedAtExecutionId', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'WorkspaceExecutionIndex',
        KeySchema: [
          { AttributeName: 'scopeKey', KeyType: 'HASH' },
          { AttributeName: 'startedAtExecutionId', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  }))
}

function recurringIndexAttributes(value: RecurringWork) {
  return value.enabled
    ? {
        scheduleShard: createAutomationScheduleShard(value.workspaceId, value.id),
        nextRunAtRecordKey: `${value.nextRunAt}#${value.id}`,
      }
    : {}
}

function scheduledRuleIndexAttributes(value: AutomationRule) {
  return value.enabled && value.trigger.type === 'schedule' && value.nextRunAt
    ? {
        scheduleShard: createAutomationScheduleShard(value.workspaceId, value.id),
        nextRunAtRecordKey: `${value.nextRunAt}#${value.id}`,
      }
    : {}
}

function executionDueIndexAttributes(value: AutomationExecution) {
  return (value.status === 'running' || (value.status === 'failed' && value.retryable)) &&
      value.nextRetryAt &&
      !value.ruleId.startsWith('recurring:')
    ? {
        scheduleShard: createAutomationScheduleShard(value.workspaceId, `execution:${value.id}`),
        nextRunAtRecordKey: `${normalizeTimestamp(value.nextRetryAt)}#execution#${value.id}`,
      }
    : {}
}

function createBulkOperationStorageItem(operation: BulkOperation) {
  return {
    scopeKey: bulkScopeKey(operation.workspaceId, operation.id),
    recordKey: 'OPERATION',
    entryType: 'bulk-operation',
    ...operation,
  }
}

function automationScopeKey(workspaceId: string) {
  return `${encodeKey(requireText(workspaceId, 'Workspace ID'))}#automation`
}

function executionScopeKey(workspaceId: string, executionId: string) {
  return `${automationScopeKey(workspaceId)}#execution#${encodeKey(executionId)}`
}

function bulkScopeKey(workspaceId: string, operationId: string) {
  return `${automationScopeKey(workspaceId)}#bulk#${encodeKey(operationId)}`
}

function ruleVersionKey(ruleId: string, version: number) {
  return `RULE_VERSION#${encodeKey(ruleId)}#${String(version).padStart(10, '0')}`
}

function templateVersionKey(templateId: string, version: number) {
  return `TEMPLATE_VERSION#${encodeKey(templateId)}#${String(version).padStart(10, '0')}`
}

function templateApplicationKey(applicationId: string) {
  return `TEMPLATE_APPLICATION#${encodeKey(applicationId)}`
}

function inboundWebhookEndpointKey(endpointId: string) {
  return `INBOUND_WEBHOOK#${encodeKey(endpointId)}`
}

function inboundWebhookLookupScopeKey(opaqueEndpointId: string) {
  return `INBOUND_WEBHOOK_LOOKUP#${requireInboundWebhookOpaqueId(opaqueEndpointId)}`
}

function inboundWebhookOperationKey(operationId: string) {
  return `INBOUND_WEBHOOK_OPERATION#${encodeKey(operationId)}`
}

function inboundWebhookSecretCleanupKey(endpointId: string) {
  return `INBOUND_WEBHOOK_SECRET_CLEANUP#${encodeKey(endpointId)}`
}

function inboundWebhookDeliveryKey(endpointId: string, idempotencyKeyHash: string) {
  return `INBOUND_WEBHOOK_DELIVERY#${encodeKey(endpointId)}#${requireSha256Fingerprint(
    idempotencyKeyHash,
    'Inbound webhook idempotency fingerprint',
  )}`
}

function inboundWebhookSignatureKey(endpointId: string, signatureFingerprint: string) {
  return `INBOUND_WEBHOOK_SIGNATURE#${encodeKey(endpointId)}#${requireSha256Fingerprint(
    signatureFingerprint,
    'Inbound webhook signature fingerprint',
  )}`
}

function createInboundWebhookOperationIdentity(
  workspaceId: string,
  actorId: string,
  kind: AutomationInboundWebhookProvisioningOperation['kind'],
  endpointId: string | undefined,
  idempotencyKey: string,
  normalizedInput: unknown,
) {
  const normalizedKey = requireBoundedText(
    idempotencyKey,
    'Inbound webhook idempotency key',
    256,
  )
  const operationHash = createHash('sha256')
    .update(
      `${workspaceId}\0inbound-webhook\0${kind}\0${endpointId ?? ''}\0${actorId}\0${normalizedKey}`,
    )
    .digest('hex')
  return {
    operationId: `inbound_operation_${operationHash.slice(0, 48)}`,
    requestFingerprint: hashCanonicalText({ kind, endpointId, input: normalizedInput }),
  }
}

function createInboundWebhookSecretVersionId(operationId: string, secretGeneration: number) {
  const generation = requireInteger(
    secretGeneration,
    'Inbound webhook secret generation',
    1,
    Number.MAX_SAFE_INTEGER,
  )
  return createHash('sha256')
    .update(`${requireBoundedText(operationId, 'Inbound webhook operation ID', 256)}\0${generation}`)
    .digest('hex')
}

function createInboundWebhookEndpointUrl(endpointBaseUrl: string, opaqueEndpointId: string) {
  let endpointUrl: URL
  try {
    endpointUrl = new URL(requireBoundedText(endpointBaseUrl, 'Inbound webhook endpoint base URL', 2_048))
  } catch {
    throw invalidInput('Inbound webhook endpoint base URL is invalid.')
  }
  const localHttpHosts = new Set(['localhost', '127.0.0.1', '[::1]'])
  if (
    endpointUrl.protocol !== 'https:' &&
    !(endpointUrl.protocol === 'http:' && localHttpHosts.has(endpointUrl.hostname))
  ) {
    throw invalidInput('Inbound webhook endpoint base URL must use HTTPS except on loopback development hosts.')
  }
  endpointUrl.username = ''
  endpointUrl.password = ''
  endpointUrl.search = ''
  endpointUrl.hash = ''
  const basePath = endpointUrl.pathname.replace(/\/+$/g, '')
  endpointUrl.pathname = `${basePath}/api/automation/inbound-webhooks/${requireInboundWebhookOpaqueId(
    opaqueEndpointId,
  )}`
  return endpointUrl.toString()
}

function createInboundWebhookEndpointStorageItem(endpoint: AutomationInboundWebhookEndpointRecord) {
  return {
    scopeKey: automationScopeKey(endpoint.workspaceId),
    recordKey: inboundWebhookEndpointKey(endpoint.id),
    entryType: 'inbound-webhook',
    ...endpoint,
  }
}

function createInboundWebhookProvisioningStorageItem(
  operation: AutomationInboundWebhookProvisioningOperation,
) {
  return {
    scopeKey: automationScopeKey(operation.workspaceId),
    recordKey: inboundWebhookOperationKey(operation.id),
    entryType: 'inbound-webhook-provisioning',
    ...operation,
  }
}

function createInboundWebhookSecretCleanupStorageItem(
  cleanup: AutomationInboundWebhookSecretCleanup,
) {
  return {
    scopeKey: automationScopeKey(cleanup.workspaceId),
    recordKey: inboundWebhookSecretCleanupKey(cleanup.endpointId),
    entryType: 'inbound-webhook-secret-cleanup',
    scheduleShard: createAutomationScheduleShard(
      cleanup.workspaceId,
      `inbound-webhook-secret-cleanup:${cleanup.endpointId}`,
    ),
    nextRunAtRecordKey:
      `${cleanup.nextCleanupAt}#INBOUND_WEBHOOK_SECRET_CLEANUP#${encodeKey(cleanup.endpointId)}`,
    ...cleanup,
  }
}

function createInboundWebhookSignatureReceiptStorageItem(
  endpoint: AutomationInboundWebhookEndpointRecord,
  idempotencyKeyHash: string,
  signatureFingerprint: string,
  signatureTimestamp: string,
  createdAt: string,
) {
  const normalizedCreatedAt = normalizeTimestamp(createdAt)
  return {
    scopeKey: automationScopeKey(endpoint.workspaceId),
    recordKey: inboundWebhookSignatureKey(endpoint.id, signatureFingerprint),
    entryType: 'inbound-webhook-signature',
    endpointId: endpoint.id,
    endpointVersion: endpoint.version,
    secretGeneration: endpoint.secretGeneration,
    secretVersionId: endpoint.secretVersionId,
    idempotencyKeyHash: requireSha256Fingerprint(
      idempotencyKeyHash,
      'Inbound webhook idempotency fingerprint',
    ),
    signatureFingerprint: requireSha256Fingerprint(
      signatureFingerprint,
      'Inbound webhook signature fingerprint',
    ),
    signatureTimestamp: requireBoundedText(
      signatureTimestamp,
      'Inbound webhook signature timestamp',
      64,
    ),
    createdAt: normalizedCreatedAt,
    expiresAt: Math.floor(Date.parse(normalizedCreatedAt) / 1_000) + 86_400,
  }
}

function createInboundWebhookActiveConditionCheck(
  tableName: string,
  endpoint: AutomationInboundWebhookEndpointRecord,
) {
  return {
    TableName: tableName,
    Key: {
      scopeKey: automationScopeKey(endpoint.workspaceId),
      recordKey: inboundWebhookEndpointKey(endpoint.id),
    },
    ConditionExpression:
      '#entryType = :entryType AND #id = :id AND #opaqueEndpointId = :opaqueEndpointId AND #status = :active AND #version = :version AND #revision = :revision AND #secretGeneration = :secretGeneration AND #secretVersionId = :secretVersionId',
    ExpressionAttributeNames: {
      '#entryType': 'entryType',
      '#id': 'id',
      '#opaqueEndpointId': 'opaqueEndpointId',
      '#revision': 'revision',
      '#secretGeneration': 'secretGeneration',
      '#secretVersionId': 'secretVersionId',
      '#status': 'status',
      '#version': 'version',
    },
    ExpressionAttributeValues: {
      ':active': 'active',
      ':entryType': 'inbound-webhook',
      ':id': endpoint.id,
      ':opaqueEndpointId': endpoint.opaqueEndpointId,
      ':revision': endpoint.revision,
      ':secretGeneration': endpoint.secretGeneration,
      ':secretVersionId': endpoint.secretVersionId,
      ':version': endpoint.version,
    },
  }
}

function createInboundWebhookRuleActiveConditionCheck(
  tableName: string,
  endpoint: AutomationInboundWebhookEndpointRecord,
) {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: {
        scopeKey: automationScopeKey(endpoint.workspaceId),
        recordKey: inboundWebhookEndpointKey(endpoint.id),
      },
      ConditionExpression:
        '#entryType = :entryType AND #id = :id AND #status = :active',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#id': 'id',
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':active': 'active',
        ':entryType': 'inbound-webhook',
        ':id': endpoint.id,
      },
    },
  }
}

function createAutomationExecutionDefinitionConditionCheck(
  tableName: string,
  workspaceId: string,
  guard: AutomationExecutionDefinitionGuard,
) {
  const recordKey = guard.kind === 'rule'
    ? `RULE#${encodeKey(guard.id)}`
    : `RECURRING#${encodeKey(guard.id)}`
  return {
    TableName: tableName,
    Key: {
      scopeKey: automationScopeKey(workspaceId),
      recordKey,
    },
    ConditionExpression:
      '#entryType = :entryType AND #id = :id AND #enabled = :enabled AND #version = :version AND #revision = :revision',
    ExpressionAttributeNames: {
      '#enabled': 'enabled',
      '#entryType': 'entryType',
      '#id': 'id',
      '#revision': 'revision',
      '#version': 'version',
    },
    ExpressionAttributeValues: {
      ':enabled': true,
      ':entryType': guard.kind,
      ':id': guard.id,
      ':revision': guard.revision,
      ':version': guard.version,
    },
  }
}

function recurringVersionKey(recurringWorkId: string, version: number) {
  return `RECURRING_VERSION#${encodeKey(recurringWorkId)}#${String(version).padStart(10, '0')}`
}

function createAutomationCreateIdentity(
  workspaceId: string,
  resourceKind: 'rule' | 'template' | 'recurring',
  idempotencyKey: string,
  normalizedInput: unknown,
) {
  const normalizedKey = requireBoundedText(idempotencyKey, 'Automation idempotency key', 256)
  const keyHash = createHash('sha256')
    .update(`${workspaceId}\0${resourceKind}\0${normalizedKey}`)
    .digest('hex')
  return {
    receiptKey: `CREATE#${resourceKind.toUpperCase()}#${keyHash}`,
    requestFingerprint: createHash('sha256').update(canonicalString(normalizedInput)).digest('hex'),
    resourceId: `${resourceKind}_${keyHash.slice(0, 48)}`,
  }
}

function createTemplateApplicationIdentity(
  workspaceId: string,
  actorId: string,
  templateId: string,
  target: AutomationTemplateApplicationTarget,
  idempotencyKey: string,
) {
  const normalizedKey = requireBoundedText(idempotencyKey, 'Automation idempotency key', 256)
  const keyHash = createHash('sha256')
    .update(`${workspaceId}\0template-application\0${actorId}\0${normalizedKey}`)
    .digest('hex')
  return {
    applicationId: `application_${keyHash.slice(0, 48)}`,
    requestFingerprint: createHash('sha256')
      .update(canonicalString({ templateId, target }))
      .digest('hex'),
  }
}

function createResourceId(prefix: string, name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || prefix
  return `${slug}-${randomUUID().slice(0, 8)}`
}

function encodeKey(value: string) {
  return encodeURIComponent(requireText(value, 'Automation key'))
}

function stripStorage<T>(item: Record<string, unknown>) {
  const {
    scopeKey: _scopeKey,
    recordKey: _recordKey,
    entryType: _entryType,
    scheduleShard: _scheduleShard,
    nextRunAtRecordKey: _nextRunAtRecordKey,
    ruleExecutionKey: _ruleExecutionKey,
    startedAtExecutionId: _startedAtExecutionId,
    triggerEvent: _triggerEvent,
    requestFingerprint: _requestFingerprint,
    ...value
  } = item
  return value as T
}

function readRecurringWork(item: Record<string, unknown>) {
  const value = stripStorage<RecurringWork>(item)
  if (value.schemaVersion !== AUTOMATION_SCHEMA_VERSION) throw storedInvalid('Recurring Work')
  return value
}

function readExecution(item: Record<string, unknown>) {
  const value = stripStorage<AutomationExecution>(item)
  if (value.schemaVersion !== AUTOMATION_SCHEMA_VERSION) throw storedInvalid('Automation execution')
  return value
}

function readBulkOperation(item: Record<string, unknown>) {
  const value = stripStorage<BulkOperation>(item)
  if (
    value.schemaVersion !== AUTOMATION_SCHEMA_VERSION ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  ) {
    throw storedInvalid('Bulk operation')
  }
  return value
}

function readTemplateApplication(item: Record<string, unknown>) {
  const value = stripStorage<AutomationTemplateApplication>(item)
  if (
    value.schemaVersion !== AUTOMATION_SCHEMA_VERSION ||
    (value.kind !== 'project' && value.kind !== 'workflow') ||
    (value.status !== 'pending' &&
      value.status !== 'running' &&
      value.status !== 'succeeded' &&
      value.status !== 'failed') ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  ) {
    throw storedInvalid('template application')
  }
  return value
}

function readInboundWebhookEndpointRecord(item: Record<string, unknown>) {
  const value = stripStorage<AutomationInboundWebhookEndpointRecord>(item)
  const statusIsValid = value.status === 'provisioning' || value.status === 'active' ||
    value.status === 'paused' || value.status === 'revoked'
  const provisioningIsValid = value.status === 'provisioning'
    ? isNonEmptyText(value.provisioningOperationId) &&
      (value.provisioningTargetStatus === 'active' || value.provisioningTargetStatus === 'paused')
    : value.provisioningOperationId === undefined && value.provisioningTargetStatus === undefined
  if (
    value.schemaVersion !== AUTOMATION_SCHEMA_VERSION ||
    !isNonEmptyText(value.id) ||
    !isNonEmptyText(value.workspaceId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.opaqueEndpointId ?? '') ||
    !isNonEmptyText(value.name) ||
    !statusIsValid ||
    !Number.isSafeInteger(value.version) || value.version < 1 ||
    !Number.isSafeInteger(value.secretGeneration) || value.secretGeneration < 1 ||
    !Number.isSafeInteger(value.revision) || value.revision < 1 ||
    !isHttpUrl(value.endpointUrl) ||
    !isNonEmptyText(value.secretId) ||
    !/^[a-f0-9]{64}$/.test(value.secretVersionId ?? '') ||
    !isIsoTimestamp(value.createdAt) ||
    !isIsoTimestamp(value.updatedAt) ||
    (value.rotatedAt !== undefined && !isIsoTimestamp(value.rotatedAt)) ||
    (value.revokedAt !== undefined && !isIsoTimestamp(value.revokedAt)) ||
    !provisioningIsValid
  ) {
    throw storedInvalid('inbound webhook endpoint')
  }
  return value
}

function readInboundWebhookProvisioningOperation(item: Record<string, unknown>) {
  const {
    scopeKey: _scopeKey,
    recordKey: _recordKey,
    entryType: _entryType,
    ...storedValue
  } = item
  const value = storedValue as AutomationInboundWebhookProvisioningOperation
  if (
    !isNonEmptyText(value.id) ||
    !isNonEmptyText(value.workspaceId) ||
    !isNonEmptyText(value.actorId) ||
    (value.kind !== 'create' && value.kind !== 'rotate') ||
    !isNonEmptyText(value.endpointId) ||
    !/^[a-f0-9]{64}$/.test(value.requestFingerprint ?? '') ||
    (value.status !== 'provisioning' && value.status !== 'succeeded') ||
    (value.targetStatus !== 'active' && value.targetStatus !== 'paused') ||
    !Number.isSafeInteger(value.endpointVersion) || value.endpointVersion < 1 ||
    !Number.isSafeInteger(value.endpointRevision) || value.endpointRevision < 1 ||
    !Number.isSafeInteger(value.secretGeneration) || value.secretGeneration < 1 ||
    !isNonEmptyText(value.secretId) ||
    !/^[a-f0-9]{64}$/.test(value.secretVersionId ?? '') ||
    !isIsoTimestamp(value.createdAt) ||
    !isIsoTimestamp(value.updatedAt) ||
    !isIsoTimestamp(value.recoveryExpiresAt) ||
    Date.parse(value.recoveryExpiresAt) <= Date.parse(value.createdAt)
  ) {
    throw storedInvalid('inbound webhook provisioning operation')
  }
  return value
}

function readInboundWebhookSecretCleanup(item: Record<string, unknown>) {
  const value = stripStorage<AutomationInboundWebhookSecretCleanup>(item)
  if (
    value.schemaVersion !== AUTOMATION_SCHEMA_VERSION ||
    !isNonEmptyText(value.workspaceId) ||
    !isNonEmptyText(value.endpointId) ||
    !isNonEmptyText(value.secretId) ||
    !/^[a-f0-9]{64}$/.test(value.secretVersionId ?? '') ||
    !Number.isSafeInteger(value.secretGeneration) || value.secretGeneration < 1 ||
    !Number.isSafeInteger(value.revision) || value.revision < 1 ||
    !isIsoTimestamp(value.nextCleanupAt) ||
    !isIsoTimestamp(value.cleanupUntil) ||
    !isIsoTimestamp(value.createdAt) ||
    !isIsoTimestamp(value.updatedAt) ||
    Date.parse(value.nextCleanupAt) > Date.parse(value.cleanupUntil) ||
    Date.parse(value.createdAt) > Date.parse(value.updatedAt)
  ) {
    throw storedInvalid('inbound webhook secret cleanup')
  }
  return value
}

function encodeCursor(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function decodeCursor(value: string) {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    return requireRecord(decoded, 'Automation cursor')
  } catch {
    throw invalidInput('Automation cursor is invalid.')
  }
}

function normalizeLimit(value: number) {
  return requireInteger(value, 'Automation page limit', 1, 100)
}

function normalizeTimestamp(value: string) {
  const timestamp = requireText(value, 'Automation timestamp')
  if (Number.isNaN(Date.parse(timestamp))) throw invalidInput('Automation timestamp is invalid.')
  return new Date(timestamp).toISOString()
}

function requireInboundWebhookOpaqueId(value: string) {
  const normalized = requireText(value, 'Inbound webhook opaque endpoint ID')
  if (!/^[A-Za-z0-9_-]{43}$/.test(normalized)) throw inboundWebhookNotFound()
  return normalized
}

function assertInboundWebhookExpectedRevision(actual: number, expected: number) {
  if (!Number.isSafeInteger(expected) || expected < 1 || actual !== expected) {
    throw revisionConflict()
  }
}

function assertInboundWebhookMutable(endpoint: AutomationInboundWebhookEndpointRecord) {
  if (endpoint.status === 'revoked') throw inboundWebhookNotFound()
  if (endpoint.status === 'provisioning') throw inboundWebhookLifecycleConflict()
}

function assertInboundWebhookSecretRecoveryOpen(
  operation: AutomationInboundWebhookProvisioningOperation,
) {
  if (Date.parse(operation.recoveryExpiresAt) <= Date.now()) {
    throw new AutomationError(
      'conflict',
      'AutomationInboundWebhookSecretRecoveryExpired',
      'Signing secret recovery expired. Revoke a provisioning endpoint or rotate an active endpoint.',
    )
  }
}

function requireSha256Fingerprint(value: unknown, label: string) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw invalidInput(`${label} is invalid.`)
  }
  return value
}

function hashCanonicalText(value: unknown) {
  const source = typeof value === 'string' ? value : canonicalString(value)
  return createHash('sha256').update(source).digest('hex')
}

function assertExpectedRevision(actual: number, expected: number) {
  if (!Number.isSafeInteger(expected) || expected <= 0 || actual !== expected) throw revisionConflict()
}

function revisionConflict() {
  return new AutomationError('conflict', 'AutomationRevisionConflict', 'Automation revision does not match.')
}

function bulkRevisionConflict() {
  return new AutomationError('conflict', 'BulkOperationRevisionConflict', 'Bulk operation revision does not match.')
}

function idempotencyConflict() {
  return new AutomationError(
    'conflict',
    'IdempotencyConflict',
    'Idempotency key was already used with different automation input.',
  )
}

function inboundWebhookNotFound() {
  return new AutomationError(
    'not-found',
    'AutomationInboundWebhookNotFound',
    'Inbound webhook endpoint was not found.',
  )
}

function inboundWebhookLifecycleConflict() {
  return new AutomationError(
    'conflict',
    'AutomationInboundWebhookLifecycleConflict',
    'Inbound webhook endpoint lifecycle changed.',
  )
}

function inboundWebhookIdempotencyConflict() {
  return new AutomationError(
    'conflict',
    'AutomationInboundWebhookIdempotencyConflict',
    'Idempotency key was already used with a different request body.',
  )
}

function inboundWebhookSignatureReplay() {
  return new AutomationError(
    'conflict',
    'AutomationInboundWebhookSignatureReplay',
    'Inbound webhook signature was already used with a different idempotency key.',
  )
}

function invalidInput(message: string) {
  return new AutomationError('invalid-input', 'InvalidAutomationInput', message)
}

function storedInvalid(label: string) {
  return new AutomationError('unavailable', 'StoredAutomationInvalid', `Stored ${label} is invalid.`)
}

function persistenceError(error: unknown) {
  if (error instanceof AutomationError) return error
  return new AutomationError(
    'unavailable',
    isRecord(error) && typeof error.name === 'string' ? error.name : 'AutomationUnavailable',
    'Automation storage is unavailable.',
    true,
  )
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalidInput(`${label} must be an object.`)
  return value
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
) {
  const allowed = new Set(allowedKeys)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) {
    throw invalidInput(`${label} contains unsupported fields: ${unknown.join(', ')}.`)
  }
}

function requireText(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw invalidInput(`${label} is required.`)
  return value.trim()
}

function requireBoundedText(value: unknown, label: string, maximum: number) {
  const text = requireText(value, label)
  if (text.length > maximum) throw invalidInput(`${label} must be ${maximum} characters or fewer.`)
  return text
}

function requireInteger(value: unknown, label: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw invalidInput(`${label} must be an integer between ${minimum} and ${maximum}.`)
  }
  return value as number
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

/** Tests whether a Date contains a valid instant. */
function isValidDate(value: Date): boolean {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function isAutomationEvent(value: unknown): value is AutomationEvent {
  if (!isRecord(value)) return false
  return typeof value.eventId === 'string' && Boolean(value.eventId) &&
    typeof value.eventType === 'string' && Boolean(value.eventType) &&
    typeof value.workspaceId === 'string' && Boolean(value.workspaceId) &&
    typeof value.occurredAt === 'string' && !Number.isNaN(Date.parse(value.occurredAt)) &&
    Array.isArray(value.changes)
}

function canonicalString(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalString).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalString(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Checks whether an unknown value is a valid DynamoDB audit Put transaction item. */
function isDynamoDbAuditPutTransactionItem(
  value: unknown,
): value is DynamoDbAutomationTransactionItem {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== 'Put') return false
  const put = value.Put
  if (!isRecord(put)) return false
  return typeof put.TableName === 'string' &&
    put.TableName.trim().length > 0 &&
    isRecord(put.Item) &&
    Object.keys(put.Item).length > 0
}

function isNamedError(error: unknown, name: string) {
  return isRecord(error) && (error.name === name || error.code === name)
}

function isTransactionConditionalCheckFailed(error: unknown) {
  if (!isRecord(error)) return false
  if (error.name === 'ConditionalCheckFailedException' || error.code === 'ConditionalCheckFailedException') return true
  if (error.name !== 'TransactionCanceledException' && error.code !== 'TransactionCanceledException') return false
  const reasons = error.CancellationReasons
  if (Array.isArray(reasons) && reasons.some((reason) =>
    isRecord(reason) && reason.Code === 'ConditionalCheckFailed'
  )) return true
  return typeof error.message === 'string' && error.message.includes('ConditionalCheckFailed')
}

function isAutomationTableDescription(table: TableDescription | undefined) {
  const indexes: Array<[string, string, string]> = [
    ['ScheduleDueIndex', 'scheduleShard', 'nextRunAtRecordKey'],
    ['RuleExecutionIndex', 'ruleExecutionKey', 'startedAtExecutionId'],
    ['WorkspaceExecutionIndex', 'scopeKey', 'startedAtExecutionId'],
  ]
  return hasAutomationKeySchema(table, [
    ['scopeKey', 'HASH'],
    ['recordKey', 'RANGE'],
  ]) && indexes.every(([indexName, partitionKey, sortKey]) =>
    table?.GlobalSecondaryIndexes?.some((index) =>
      index.IndexName === indexName && hasAutomationKeySchema(index, [
        [partitionKey, 'HASH'],
        [sortKey, 'RANGE'],
      ])
    ),
  )
}

function hasAutomationKeySchema(
  value: { KeySchema?: TableDescription['KeySchema'] } | undefined,
  expected: Array<[string, 'HASH' | 'RANGE']>,
) {
  return expected.every(([attributeName, keyType]) =>
    value?.KeySchema?.some((key) =>
      key.AttributeName === attributeName && key.KeyType === keyType
    )
  )
}
