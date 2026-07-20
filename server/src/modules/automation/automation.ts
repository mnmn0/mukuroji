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
  APPROVAL_MAX_REVIEWERS,
  AUTOMATION_SCHEMA_VERSION,
  type ApplyAutomationTemplateInput,
  type AutomationInboundWebhookEndpoint,
  type AutomationInboundWebhookLifecycleInput,
  type AutomationAction,
  type AutomationActionExecution,
  type AutomationCondition,
  type AutomationExecution,
  type AutomationRateLimit,
  type AutomationRetryPolicy,
  type AutomationRule,
  type AutomationTemplate,
  type AutomationTemplateApplication,
  type AutomationTemplateApplicationResult,
  type AutomationTemplateApplicationTarget,
  type AutomationTrigger,
  type AutomationValue,
  type BulkOperation,
  type BulkOperationItemResult,
  type BulkOperationPreview,
  type BulkOperationRequest,
  type CreateAutomationRuleInput,
  type CreateAutomationInboundWebhookEndpointInput,
  type CreateAutomationTemplateInput,
  type CreateRecurringWorkInput,
  type RecurringCatchUpPolicy,
  type RecurringSchedule,
  type RecurringWork,
  type UpdateAutomationRuleInput,
  type UpdateAutomationInboundWebhookEndpointInput,
  type UpdateAutomationTemplateInput,
  type UpdateRecurringWorkInput,
} from '@mukuroji/contracts'
import {
  isAutomationWebhookSecretAlias,
  readAutomationWebhookEndpoint,
} from './automation-webhook-policy'
import { validateWorkflowDefinition } from '../work-items'

/** Automation action の既定 retry policy です。 */
export const DEFAULT_AUTOMATION_RETRY_POLICY: AutomationRetryPolicy = Object.freeze({
  maxAttempts: 3,
  initialDelayMs: 1_000,
  backoffMultiplier: 2,
  maxDelayMs: 60_000,
})

/** Automation rule の既定 rate limit です。 */
export const DEFAULT_AUTOMATION_RATE_LIMIT: AutomationRateLimit = Object.freeze({
  maxExecutions: 100,
  windowSeconds: 60,
})
const AUTOMATION_EXECUTION_LEASE_MS = 5 * 60_000
/** Template application runner lease の長さです。 */
export const AUTOMATION_TEMPLATE_APPLICATION_LEASE_MS = 5 * 60_000
/** Inbound webhook plaintext secret を同じ key で回収できる時間です。 */
export const AUTOMATION_INBOUND_WEBHOOK_SECRET_RECOVERY_MS = 24 * 60 * 60_000
/** Revoke 後の late secret write を再削除する間隔です。 */
export const AUTOMATION_INBOUND_WEBHOOK_SECRET_CLEANUP_INTERVAL_MS = 5 * 60_000
/** Recovery 期限直前に開始した provisioning write を最終削除まで覆う猶予です。 */
export const AUTOMATION_INBOUND_WEBHOOK_SECRET_CLEANUP_GRACE_MS =
  AUTOMATION_INBOUND_WEBHOOK_SECRET_CLEANUP_INTERVAL_MS
/** Audit outbox より長く保持する inbound webhook delivery receipt の秒数です。 */
export const AUTOMATION_INBOUND_WEBHOOK_DELIVERY_RETENTION_SECONDS = 400 * 86_400
const AUTOMATION_UPDATE_FIELDS = new Set([
  'assignedProjectId',
  'assigneeUserId',
  'customFieldValues',
  'description',
  'dueDate',
  'priority',
  'title',
  'workflowStatusId',
])

/** Automation domain / persistence error です。 */
export class AutomationError extends Error {
  /** API response に利用できる HTTP status です。 */
  readonly status: number
  /** Client が安定判定できる error code です。 */
  readonly code: string
  /** 同じ入力で retry してよいかどうかです。 */
  readonly retryable: boolean

  /** Automation error を作成します。 */
  constructor(status: number, code: string, message: string, retryable = false) {
    super(message)
    this.status = status
    this.code = code
    this.retryable = retryable
  }
}

/** Automation trigger が受け取る audit field change です。 */
export type AutomationEventChange = {
  /** Dot-separated field path です。 */
  field: string
  /** Mutation 前の値です。 */
  before?: AutomationValue
  /** Mutation 後の値です。 */
  after?: AutomationValue
}

/** Audit outbox、form、webhook、schedule を共通化した trigger event です。 */
export type AutomationEvent = {
  /** Durable source event ID です。 */
  eventId: string
  /** `work-item.updated` などの event type です。 */
  eventType: string
  /** Event が属する Workspace ID です。 */
  workspaceId: string
  /** Event 発生日時です。 */
  occurredAt: string
  /** Field changes です。 */
  changes: AutomationEventChange[]
  /** Trigger adapter が提供する metadata です。 */
  metadata?: Record<string, AutomationValue>
  /** Event 時点または再取得済み Work Item snapshot です。 */
  workItem?: Record<string, AutomationValue>
  /** 先行 automation execution の rule lineage です。 */
  automationRuleLineage?: string[]
}

/** Condition evaluation へ渡す values です。 */
export type AutomationConditionContext = {
  /** Trigger event です。 */
  event: AutomationEvent
  /** Current Work Item snapshot です。 */
  workItem?: Record<string, AutomationValue>
  /** Adapter が解決した追加 variables です。 */
  variables?: Record<string, AutomationValue>
}

/** Action executor へ渡す deterministic execution context です。 */
export type AutomationActionExecutionContext = {
  /** Parent execution です。 */
  execution: AutomationExecution
  /** Trigger event です。 */
  event: AutomationEvent
  /** Action の0始まり index です。 */
  actionIndex: number
  /** Downstream side effect へ渡す idempotency key です。 */
  idempotencyKey: string
}

/** Domain-specific automation action を実行する注入 adapter です。 */
export interface AutomationActionExecutor {
  /** Action を実行し、downstream が成功を確定した後に return します。 */
  execute(action: AutomationAction, context: AutomationActionExecutionContext): Promise<void>
}

/** Bulk item adapter の preview result です。 */
export type BulkItemPreviewResult = {
  /** Apply 可能かどうかです。 */
  allowed: boolean
  /** Stable validation code です。 */
  errorCode?: string
  /** Safe validation message です。 */
  errorMessage?: string
  /** Retry 可能な一時失敗かどうかです。 */
  retryable?: boolean
  /** Apply 応答消失後の recovery と undo に使う server-only snapshot です。 */
  undoPayload?: Record<string, AutomationValue>
}

/** Bulk apply adapter の成功 result です。 */
export type BulkItemApplyResult = {
  /** Mutation 後の revision です。 */
  resultingRevision: number
  /** Safe undo に必要な opaque payload です。 */
  undoPayload?: Record<string, AutomationValue>
}

/** Bulk operation の外部 Work Item I/O adapter です。 */
export interface BulkOperationAdapter {
  /** Item の認可、revision、configuration を mutation なしで検証します。 */
  preview(request: BulkOperationRequest, itemIndex: number): Promise<BulkItemPreviewResult>
  /** Item へ bulk action を optimistic concurrency 付きで適用します。 */
  apply(
    request: BulkOperationRequest,
    itemIndex: number,
    checkpoint: BulkOperationItemResult,
  ): Promise<BulkItemApplyResult>
  /** 保存済み undo payload を current revision guard 付きで適用します。 */
  undo(operation: BulkOperation, itemIndex: number): Promise<BulkItemApplyResult>
}

/** Automation execution list の query です。 */
export type AutomationExecutionQuery = {
  /** 対象 Workspace ID です。 */
  workspaceId: string
  /** 対象 rule ID です。 */
  ruleId?: string
  /** 対象 execution status です。 */
  status?: AutomationExecution['status']
  /** Page size です。 */
  limit?: number
  /** 前 page の opaque cursor です。 */
  cursor?: string
}

/** Automation execution list の1 pageです。 */
export type AutomationExecutionPage = {
  /** Execution rows です。 */
  executions: AutomationExecution[]
  /** 次 page がある場合の cursor です。 */
  nextCursor?: string
}

/** Atomic execution/rate-limit reservation の結果です。 */
export type AutomationExecutionReservation =
  | 'created'
  | 'duplicate'
  | 'rate-limited'
  | 'stale-definition'

/** Execution create と同じ transaction で確認する current definition token です。 */
export type AutomationExecutionDefinitionGuard = {
  /** Current row の種類です。 */
  kind: 'rule' | 'recurring'
  /** Current definition ID です。 */
  id: string
  /** 読み込んだ immutable version です。 */
  version: number
  /** 読み込んだ optimistic revision です。 */
  revision: number
}

/** Execution runner が保持する不変の lease fencing token です。 */
export type AutomationExecutionClaimToken = {
  /** Lease 取得後の execution attempt 番号です。 */
  attempt: number
  /** Lease 取得時に保存した正確な有効期限です。 */
  leaseExpiresAt: string
}

/** Secrets Manager と二段階 provisioning を含む server-only endpoint record です。 */
export type AutomationInboundWebhookEndpointRecord = AutomationInboundWebhookEndpoint & {
  /** Secrets Manager secret resource ID です。 */
  secretId: string
  /** Current generation の immutable Secrets Manager version ID です。 */
  secretVersionId: string
  /** Provisioning 中 operation ID です。 */
  provisioningOperationId?: string
  /** Provisioning 完了後に戻す active/paused status です。 */
  provisioningTargetStatus?: 'active' | 'paused'
}

/** Create/rotate の response-loss recovery に使う provisioning operation です。 */
export type AutomationInboundWebhookProvisioningOperation = {
  /** Deterministic operation ID です。 */
  id: string
  /** Operation が属する Workspace ID です。 */
  workspaceId: string
  /** Operation を開始した actor ID です。 */
  actorId: string
  /** Provisioning の種類です。 */
  kind: 'create' | 'rotate'
  /** 対象 endpoint ID です。 */
  endpointId: string
  /** Idempotency key と入力を束縛する fingerprint です。 */
  requestFingerprint: string
  /** Operation 状態です。 */
  status: 'provisioning' | 'succeeded'
  /** Provisioning 完了後に戻す endpoint status です。 */
  targetStatus: 'active' | 'paused'
  /** 予約済み endpoint version です。 */
  endpointVersion: number
  /** 予約済み endpoint revision です。 */
  endpointRevision: number
  /** 予約済み secret generation です。 */
  secretGeneration: number
  /** Secrets Manager secret resource ID です。 */
  secretId: string
  /** Immutable Secrets Manager version ID です。 */
  secretVersionId: string
  /** Operation 作成日時です。 */
  createdAt: string
  /** Operation 最終更新日時です。 */
  updatedAt: string
  /** Plaintext secret の response-loss recovery を許可する期限です。 */
  recoveryExpiresAt: string
}

/** Provisioning orchestration が利用する endpoint と operation の組です。 */
export type AutomationInboundWebhookProvisioning = {
  /** Internal secret reference を含む endpoint record です。 */
  endpoint: AutomationInboundWebhookEndpointRecord
  /** Idempotent provisioning operation です。 */
  operation: AutomationInboundWebhookProvisioningOperation
}

/** Revoke と競合した late Secrets Manager write を回収する durable cleanup intent です。 */
export type AutomationInboundWebhookSecretCleanup = {
  /** Automation schema version です。 */
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION
  /** Cleanup が属する Workspace ID です。 */
  workspaceId: string
  /** Revoke 済み endpoint ID です。 */
  endpointId: string
  /** 削除する Secrets Manager secret resource ID です。 */
  secretId: string
  /** Revoke 時点の immutable secret version ID です。 */
  secretVersionId: string
  /** Revoke 時点の secret generation です。 */
  secretGeneration: number
  /** Cleanup intent の optimistic revision です。 */
  revision: number
  /** 次に DeleteSecret を再試行する日時です。 */
  nextCleanupAt: string
  /** Late write を考慮して cleanup intent を保持する期限です。 */
  cleanupUntil: string
  /** Cleanup intent 作成日時です。 */
  createdAt: string
  /** Cleanup intent 最終更新日時です。 */
  updatedAt: string
}

/** Atomic inbound delivery transaction の入力です。 */
export type AutomationInboundWebhookDeliveryInput = {
  /** Sender が retry 間で固定する idempotency key です。 */
  idempotencyKey: string
  /** Raw request bytes の SHA-256 fingerprint です。 */
  bodyFingerprint: string
  /** 検証済み signature header の SHA-256 fingerprint です。 */
  signatureFingerprint: string
  /** 検証済み sender epoch timestamp です。 */
  signatureTimestamp: string
  /** Audit outbox event ID です。 */
  eventId: string
  /** Audit table へ同じ transaction で保存する Put item です。 */
  auditTransactItem: NonNullable<TransactWriteCommandInput['TransactItems']>[number]
}

/** Atomic inbound delivery の重複判定結果です。 */
export type AutomationInboundWebhookDeliveryResult = {
  /** 元または新規 audit outbox event ID です。 */
  eventId: string
  /** 既存 delivery receipt の replay かどうかです。 */
  replayed: boolean
}

/** Automation persistence と execution receipt の contract です。 */
export interface AutomationClient {
  /** Workspace の current rules を返します。 */
  listRules(workspaceId: string): Promise<AutomationRule[]>
  /** Current rule を返します。 */
  getRule(workspaceId: string, ruleId: string): Promise<AutomationRule | undefined>
  /** Immutable rule version を返します。 */
  getRuleVersion(workspaceId: string, ruleId: string, version: number): Promise<AutomationRule | undefined>
  /** Rule を作成します。 */
  createRule(
    workspaceId: string,
    input: CreateAutomationRuleInput,
    idempotencyKey?: string,
  ): Promise<AutomationRule>
  /** Rule を revision CAS 付きで更新し、新 version を保存します。 */
  updateRule(workspaceId: string, ruleId: string, input: UpdateAutomationRuleInput): Promise<AutomationRule>
  /** Rule を revision CAS 付きで削除します。 */
  deleteRule(workspaceId: string, ruleId: string, expectedRevision: number): Promise<void>
  /** Due index から実行予定の schedule-trigger rules を返します。 */
  listDueScheduledRules(scheduleShard: string, dueAt: string, limit?: number): Promise<AutomationRule[]>
  /** Schedule-trigger slot 完了後に last/next run を revision CAS 付きで進めます。 */
  completeScheduledRule(
    workspaceId: string,
    ruleId: string,
    expectedRevision: number,
    lastRunAt: string,
    nextRunAt: string,
  ): Promise<AutomationRule>
  /** Workspace の templates を返します。 */
  listTemplates(workspaceId: string): Promise<AutomationTemplate[]>
  /** Template を返します。 */
  getTemplate(workspaceId: string, templateId: string): Promise<AutomationTemplate | undefined>
  /** Immutable template version を返します。 */
  getTemplateVersion(
    workspaceId: string,
    templateId: string,
    version: number,
  ): Promise<AutomationTemplate | undefined>
  /** Template を作成します。 */
  createTemplate(
    workspaceId: string,
    input: CreateAutomationTemplateInput,
    idempotencyKey?: string,
  ): Promise<AutomationTemplate>
  /** Template を更新します。 */
  updateTemplate(workspaceId: string, templateId: string, input: UpdateAutomationTemplateInput): Promise<AutomationTemplate>
  /** Template を削除します。 */
  deleteTemplate(workspaceId: string, templateId: string, expectedRevision: number): Promise<void>
  /** Current enabled template version を固定した application receipt を予約します。 */
  reserveTemplateApplication(
    workspaceId: string,
    actorId: string,
    templateId: string,
    target: AutomationTemplateApplicationTarget,
    idempotencyKey: string,
  ): Promise<AutomationTemplateApplication>
  /** Template application receipt を返します。 */
  getTemplateApplication(
    workspaceId: string,
    applicationId: string,
  ): Promise<AutomationTemplateApplication | undefined>
  /** Pending または lease 切れ application の runner lease を revision CAS 付きで取得します。 */
  claimTemplateApplication(
    application: AutomationTemplateApplication,
    now: Date,
    leaseExpiresAt: string,
  ): Promise<AutomationTemplateApplication | undefined>
  /** Domain mutation と同じ transaction に含める application 成功更新を生成します。 */
  createTemplateApplicationCompletionTransactItem(
    application: AutomationTemplateApplication,
    result: AutomationTemplateApplicationResult,
  ): NonNullable<TransactWriteCommandInput['TransactItems']>[number]
  /** Template application receipt を revision CAS 付きで保存します。 */
  saveTemplateApplication(
    application: AutomationTemplateApplication,
    expectedRevision: number,
  ): Promise<void>
  /** Workspace の inbound webhook endpoints を返します。 */
  listInboundWebhookEndpoints(workspaceId: string): Promise<AutomationInboundWebhookEndpoint[]>
  /** Workspace 内 endpoint を返します。 */
  getInboundWebhookEndpoint(
    workspaceId: string,
    endpointId: string,
  ): Promise<AutomationInboundWebhookEndpoint | undefined>
  /** Opaque public ID から internal secret reference 付き endpoint を解決します。 */
  resolveInboundWebhookEndpoint(
    opaqueEndpointId: string,
  ): Promise<AutomationInboundWebhookEndpointRecord | undefined>
  /** Create operation と provisioning endpoint を一つの transaction で予約します。 */
  reserveCreateInboundWebhookEndpoint(
    workspaceId: string,
    actorId: string,
    input: CreateAutomationInboundWebhookEndpointInput,
    idempotencyKey: string,
    endpointBaseUrl: string,
  ): Promise<AutomationInboundWebhookProvisioning>
  /** Rotate operation と次 secret generation を一つの transaction で予約します。 */
  reserveRotateInboundWebhookEndpoint(
    workspaceId: string,
    actorId: string,
    endpointId: string,
    input: AutomationInboundWebhookLifecycleInput,
    idempotencyKey: string,
  ): Promise<AutomationInboundWebhookProvisioning>
  /** Secret provisioning 済み operation を endpoint current row と同時に確定します。 */
  completeInboundWebhookProvisioning(
    provisioning: AutomationInboundWebhookProvisioning,
  ): Promise<AutomationInboundWebhookEndpointRecord>
  /** Endpoint 表示名を revision CAS 付きで更新します。 */
  updateInboundWebhookEndpoint(
    workspaceId: string,
    endpointId: string,
    input: UpdateAutomationInboundWebhookEndpointInput,
  ): Promise<AutomationInboundWebhookEndpoint>
  /** Endpoint を pause または resume します。 */
  setInboundWebhookEndpointStatus(
    workspaceId: string,
    endpointId: string,
    input: AutomationInboundWebhookLifecycleInput,
    status: 'active' | 'paused',
  ): Promise<AutomationInboundWebhookEndpoint>
  /** Endpoint を revoke して global lookup を削除します。 */
  revokeInboundWebhookEndpoint(
    workspaceId: string,
    endpointId: string,
    input: AutomationInboundWebhookLifecycleInput,
  ): Promise<AutomationInboundWebhookEndpointRecord>
  /** Endpoint guard、delivery/signature receipt、audit outbox を atomic に保存します。 */
  recordInboundWebhookDelivery(
    endpoint: AutomationInboundWebhookEndpointRecord,
    input: AutomationInboundWebhookDeliveryInput,
  ): Promise<AutomationInboundWebhookDeliveryResult>
  /** Due inbound webhook secret cleanup intents を返します。 */
  listDueInboundWebhookSecretCleanups(
    scheduleShard: string,
    dueAt: string,
    limit?: number,
  ): Promise<AutomationInboundWebhookSecretCleanup[]>
  /** DeleteSecret 成功後に cleanup intent を再予約または完了します。 */
  completeInboundWebhookSecretCleanup(
    cleanup: AutomationInboundWebhookSecretCleanup,
    attemptedAt: string,
  ): Promise<void>
  /** Workspace の recurring definitions を返します。 */
  listRecurringWorks(workspaceId: string): Promise<RecurringWork[]>
  /** Recurring definition を返します。 */
  getRecurringWork(workspaceId: string, recurringWorkId: string): Promise<RecurringWork | undefined>
  /** Recurring definition を作成します。 */
  createRecurringWork(
    workspaceId: string,
    input: CreateRecurringWorkInput,
    idempotencyKey?: string,
  ): Promise<RecurringWork>
  /** Recurring definition を更新します。 */
  updateRecurringWork(workspaceId: string, recurringWorkId: string, input: UpdateRecurringWorkInput): Promise<RecurringWork>
  /** Scheduled slot 完了後に last/next run を revision CAS 付きで進めます。 */
  completeRecurringWork(
    workspaceId: string,
    recurringWorkId: string,
    expectedRevision: number,
    lastRunAt: string,
    nextRunAt: string,
  ): Promise<RecurringWork>
  /** Recurring definition を削除します。 */
  deleteRecurringWork(workspaceId: string, recurringWorkId: string, expectedRevision: number): Promise<void>
  /** Due index から実行予定 recurring definitions を返します。 */
  listDueRecurringWorks(scheduleShard: string, dueAt: string, limit?: number): Promise<RecurringWork[]>
  /** Due index から retry/runner lease 時刻に達した rule executions を返します。 */
  listDueExecutions(
    scheduleShard: string,
    dueAt: string,
    limit?: number,
  ): Promise<AutomationExecution[]>
  /** Rule execution と fixed-window rate token を同じ transaction で予約します。 */
  reserveExecution(
    rule: AutomationRule,
    event: AutomationEvent,
    now: Date,
  ): Promise<AutomationExecutionReservation>
  /** Execution を deterministic key と optional current-definition guard で条件付き作成します。 */
  createExecution(
    execution: AutomationExecution,
    event: AutomationEvent,
    definitionGuard?: AutomationExecutionDefinitionGuard,
  ): Promise<boolean>
  /** Execution を返します。 */
  getExecution(workspaceId: string, executionId: string): Promise<AutomationExecution | undefined>
  /** Execution と同じ row に保持した trigger event を返します。 */
  getExecutionEvent(workspaceId: string, executionId: string): Promise<AutomationEvent | undefined>
  /** Execution runner lease を state/attempt CAS 付きで取得します。 */
  claimExecution(
    execution: AutomationExecution,
    now: Date,
    leaseExpiresAt: string,
    definitionGuard?: AutomationExecutionDefinitionGuard,
  ): Promise<boolean>
  /** Execution state を runner lease fencing token の CAS 付きで保存します。 */
  saveExecution(
    execution: AutomationExecution,
    claimToken: AutomationExecutionClaimToken,
    now: Date,
  ): Promise<boolean>
  /** Rule execution timeline を返します。 */
  listExecutions(query: AutomationExecutionQuery): Promise<AutomationExecutionPage>
  /** 成功済み action receipt が存在するか返します。 */
  hasActionReceipt(workspaceId: string, executionId: string, actionId: string): Promise<boolean>
  /** 成功済み action receipt を条件付き保存します。 */
  putActionReceipt(workspaceId: string, executionId: string, actionId: string): Promise<boolean>
  /** Durable bulk operation を条件付き作成します。 */
  createBulkOperation(operation: BulkOperation): Promise<boolean>
  /** Durable bulk operation を revision CAS 付きで保存します。 */
  saveBulkOperation(operation: BulkOperation, expectedRevision: number): Promise<void>
  /** Durable bulk operation を返します。 */
  getBulkOperation(workspaceId: string, operationId: string): Promise<BulkOperation | undefined>
}

/** DynamoDB single table を利用する Automation client です。 */
export class DynamoDbAutomationClient implements AutomationClient {
  /** Automation table 名です。 */
  private readonly tableName: string
  /** DynamoDB DocumentClient です。 */
  private readonly documentClient: DynamoDBDocumentClient
  /** Local bootstrap 用 low-level client です。 */
  private readonly dynamoDbClient?: DynamoDBClient
  /** Local table bootstrap を有効にするかどうかです。 */
  private readonly bootstrapLocalTable: boolean

  /** DynamoDB Automation client を作成します。 */
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
      throw new AutomationError(409, 'AutomationScheduledRuleDisabled', 'Scheduled automation rule is disabled.')
    }
    const normalizedLastRunAt = normalizeTimestamp(lastRunAt)
    const normalizedNextRunAt = normalizeTimestamp(nextRunAt)
    if (normalizedNextRunAt <= normalizedLastRunAt) {
      throw invalidInput('Automation schedule next run must be later than the completed run.')
    }
    if (current.lastRunAt && normalizedLastRunAt <= normalizeTimestamp(current.lastRunAt)) {
      throw new AutomationError(409, 'AutomationScheduleSlotAlreadyCompleted', 'Automation schedule slot was already completed.')
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
        409,
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
  createTemplateApplicationCompletionTransactItem(
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
        503,
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
    const secretId = createInboundWebhookSecretId(normalizedWorkspaceId, endpointId)
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
    input: AutomationInboundWebhookDeliveryInput,
  ) {
    await this.ensureTable()
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
          input.auditTransactItem,
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
        409,
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
      throw new AutomationError(409, 'RecurringWorkDisabled', 'Recurring Work definition is disabled.')
    }
    const normalizedLastRunAt = normalizeTimestamp(lastRunAt)
    const normalizedNextRunAt = normalizeTimestamp(nextRunAt)
    if (normalizedNextRunAt <= normalizedLastRunAt) {
      throw invalidInput('Recurring next run must be later than the completed run.')
    }
    if (current.lastRunAt && normalizedLastRunAt <= normalizeTimestamp(current.lastRunAt)) {
      throw new AutomationError(409, 'RecurringSlotAlreadyCompleted', 'Recurring Work slot was already completed.')
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
  async reserveExecution(rule: AutomationRule, event: AutomationEvent, now: Date) {
    await this.ensureTable()
    const execution = createPendingExecution(rule, event, now)
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
      throw new AutomationError(503, 'AutomationTriggerEventUnavailable', 'Automation trigger event is unavailable.')
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
        409,
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
        409,
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
        423,
        'AutomationInboundWebhookPaused',
        'Inbound webhook endpoint is paused.',
      )
    }
    throw new AutomationError(
      409,
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
            503,
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
    if (!value) throw new AutomationError(404, 'AutomationRuleNotFound', 'Automation rule was not found.')
    return value
  }

  /** Template を必須取得します。 */
  private async requireTemplate(workspaceId: string, templateId: string) {
    const value = await this.getTemplate(workspaceId, templateId)
    if (!value) throw new AutomationError(404, 'AutomationTemplateNotFound', 'Automation template was not found.')
    return value
  }

  /** Enabled Work Item template を取得し、保存時に固定できることを確認します。 */
  private async requireEnabledWorkItemTemplate(workspaceId: string, templateId: string) {
    const template = await this.requireTemplate(workspaceId, templateId)
    if (!template.enabled || template.kind !== 'work-item') {
      throw new AutomationError(
        409,
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
    if (!value) throw new AutomationError(404, 'RecurringWorkNotFound', 'Recurring Work definition was not found.')
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
        409,
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

/** Logical Rule/event pair から version に依存しない deterministic execution ID を作成します。 */
export function createAutomationExecutionId(rule: AutomationRule, eventId: string) {
  const digest = createHash('sha256')
    .update(`${rule.workspaceId}\0${rule.id}\0${requireText(eventId, 'Event ID')}`)
    .digest('hex')
  return `automation_${digest.slice(0, 48)}`
}

/** Recurring definition/slot から deterministic execution ID を作成します。 */
export function createRecurringExecutionId(
  workspaceId: string,
  recurringWorkId: string,
  scheduledFor: string,
) {
  const normalizedScheduledFor = normalizeTimestamp(scheduledFor)
  const digest = createHash('sha256')
    .update(
      `${requireText(workspaceId, 'Workspace ID')}\0` +
      `${requireText(recurringWorkId, 'Recurring Work ID')}\0${normalizedScheduledFor}`,
    )
    .digest('hex')
  return `recurring_${digest.slice(0, 48)}`
}

/** Execution/action index から deterministic action ID を作成します。 */
export function createAutomationActionId(executionId: string, actionIndex: number) {
  if (!Number.isSafeInteger(actionIndex) || actionIndex < 0) {
    throw invalidInput('Action index must be a non-negative integer.')
  }
  return `${requireText(executionId, 'Execution ID')}:action:${String(actionIndex).padStart(4, '0')}`
}

/** Unknown rule input を厳格に検証して正規化します。 */
export function validateCreateAutomationRuleInput(value: unknown): CreateAutomationRuleInput {
  const input = requireRecord(value, 'Automation rule')
  const name = requireBoundedText(input.name, 'Automation rule name', 160)
  if (typeof input.enabled !== 'boolean') throw invalidInput('Automation rule enabled must be boolean.')
  const trigger = validateAutomationTrigger(input.trigger)
  const conditions = input.conditions === undefined
    ? undefined
    : validateAutomationConditions(input.conditions)
  if (!Array.isArray(input.actions) || input.actions.length === 0 || input.actions.length > 32) {
    throw invalidInput('Automation rule must contain between 1 and 32 actions.')
  }
  const actions = input.actions.map(validateAutomationAction)
  const retryPolicy = input.retryPolicy === undefined
    ? undefined
    : validateAutomationRetryPolicy(input.retryPolicy)
  const rateLimit = input.rateLimit === undefined
    ? undefined
    : validateAutomationRateLimit(input.rateLimit)
  const allowReentry = input.allowReentry === undefined
    ? undefined
    : requireBoolean(input.allowReentry, 'Automation allowReentry')
  const maxChainDepth = input.maxChainDepth === undefined
    ? undefined
    : requireInteger(input.maxChainDepth, 'Automation maxChainDepth', 1, 64)
  return {
    name,
    enabled: input.enabled,
    trigger,
    ...(conditions ? { conditions } : {}),
    actions,
    ...(retryPolicy ? { retryPolicy } : {}),
    ...(rateLimit ? { rateLimit } : {}),
    ...(allowReentry === undefined ? {} : { allowReentry }),
    ...(maxChainDepth === undefined ? {} : { maxChainDepth }),
  }
}

/** Unknown template input を厳格に検証して正規化します。 */
export function validateCreateAutomationTemplateInput(
  value: unknown,
): CreateAutomationTemplateInput {
  const input = requireRecord(value, 'Automation template')
  assertOnlyKeys(input, ['enabled', 'kind', 'name', 'payload'], 'Automation template')
  if (input.kind !== 'work-item' && input.kind !== 'project' && input.kind !== 'workflow') {
    throw invalidInput('Automation template kind is invalid.')
  }
  const name = requireBoundedText(input.name, 'Automation template name', 160)
  const enabled = requireBoolean(input.enabled, 'Automation template enabled')
  const payload = requireRecord(input.payload, 'Automation template payload')
  switch (input.kind) {
    case 'work-item': {
      assertOnlyKeys(payload, [
        'assignedProjectId',
        'assigneeUserId',
        'customFieldValues',
        'description',
        'dueDate',
        'priority',
        'teamId',
        'title',
        'workflowStatusId',
      ], 'Work Item template payload')
      const title = requireBoundedText(payload.title, 'Work Item template title', 500)
      const assignedProjectId = payload.assignedProjectId
      if (
        assignedProjectId !== undefined &&
        assignedProjectId !== null &&
        typeof assignedProjectId !== 'string'
      ) {
        throw invalidInput('Work Item template assigned Project ID must be a string or null.')
      }
      const assigneeUserId = readOptionalTemplateString(
        payload.assigneeUserId,
        'Work Item template assignee user ID',
      )
      const description = readOptionalTemplateString(
        payload.description,
        'Work Item template description',
      )
      const dueDate = readOptionalTemplateString(
        payload.dueDate,
        'Work Item template due date',
      )
      const teamId = readOptionalTemplateString(
        payload.teamId,
        'Work Item template Team ID',
      )
      const workflowStatusId = readOptionalTemplateString(
        payload.workflowStatusId,
        'Work Item template Workflow status ID',
      )
      let customFieldValues: Record<string, AutomationValue> | undefined
      if (payload.customFieldValues !== undefined) {
        if (!isRecord(payload.customFieldValues) || !isAutomationValue(payload.customFieldValues)) {
          throw invalidInput('Work Item template custom field values must be an object.')
        }
        customFieldValues = structuredClone(payload.customFieldValues) as Record<string, AutomationValue>
      }
      if (
        payload.priority !== undefined &&
        payload.priority !== 'low' &&
        payload.priority !== 'medium' &&
        payload.priority !== 'high'
      ) {
        throw invalidInput('Work Item template priority is invalid.')
      }
      return {
        kind: input.kind,
        name,
        enabled,
        payload: {
          title,
          ...(assignedProjectId === undefined ? {} : { assignedProjectId }),
          ...(assigneeUserId === undefined ? {} : { assigneeUserId }),
          ...(customFieldValues === undefined ? {} : { customFieldValues }),
          ...(description === undefined ? {} : { description }),
          ...(dueDate === undefined ? {} : { dueDate }),
          ...(payload.priority === undefined ? {} : { priority: payload.priority }),
          ...(teamId === undefined ? {} : { teamId }),
          ...(workflowStatusId === undefined ? {} : { workflowStatusId }),
        },
      }
    }
    case 'project': {
      assertOnlyKeys(payload, ['name', 'nameEn', 'nameJa', 'tone'], 'Project template payload')
      const rawName = typeof payload.name === 'string' ? payload.name.trim() : ''
      const rawNameJa = typeof payload.nameJa === 'string' ? payload.nameJa.trim() : ''
      const rawNameEn = typeof payload.nameEn === 'string' ? payload.nameEn.trim() : ''
      const primaryName = rawNameJa || rawName || rawNameEn
      if (!primaryName) throw invalidInput('Project template name is required.')
      for (const [label, candidate] of [
        ['Project template name', rawName],
        ['Project template Japanese name', rawNameJa],
        ['Project template English name', rawNameEn],
      ] as const) {
        if (candidate.length > 160) throw invalidInput(`${label} must be 160 characters or fewer.`)
      }
      const tone = payload.tone ?? 'blue'
      if (tone !== 'blue' && tone !== 'purple' && tone !== 'green' && tone !== 'yellow') {
        throw invalidInput('Project template tone is invalid.')
      }
      return {
        kind: input.kind,
        name,
        enabled,
        payload: {
          ...(rawName ? { name: rawName } : {}),
          ...(rawNameJa ? { nameJa: rawNameJa } : {}),
          ...(rawNameEn ? { nameEn: rawNameEn } : {}),
          tone,
        },
      }
    }
    case 'workflow': {
      assertOnlyKeys(payload, ['id', 'initialStatusId', 'name', 'statuses', 'transitions'], 'Workflow template payload')
      if (Array.isArray(payload.statuses)) {
        for (const status of payload.statuses) {
          assertOnlyKeys(
            requireRecord(status, 'Workflow template status'),
            ['category', 'color', 'id', 'name', 'sortOrder'],
            'Workflow template status',
          )
        }
      }
      if (Array.isArray(payload.transitions)) {
        for (const transition of payload.transitions) {
          assertOnlyKeys(
            requireRecord(transition, 'Workflow template transition'),
            ['fromStatusId', 'toStatusId'],
            'Workflow template transition',
          )
        }
      }
      return {
        kind: input.kind,
        name,
        enabled,
        payload: validateWorkflowDefinition(payload),
      }
    }
  }
}

/** Unknown template application input を厳格に検証します。 */
export function validateApplyAutomationTemplateInput(
  value: unknown,
): ApplyAutomationTemplateInput {
  const input = requireRecord(value, 'Template application')
  assertOnlyKeys(input, ['target'], 'Template application')
  const target = requireRecord(input.target, 'Template application target')
  if (target.kind === 'project') {
    assertOnlyKeys(target, ['kind', 'teamId'], 'Project template application target')
    return {
      target: {
        kind: 'project',
        teamId: requireBoundedText(target.teamId, 'Project template Team ID', 256),
      },
    }
  }
  if (target.kind === 'workflow') {
    assertOnlyKeys(
      target,
      ['expectedRevision', 'kind', 'scopeId', 'scopeType'],
      'Workflow template application target',
    )
    if (target.scopeType !== 'workspace' && target.scopeType !== 'team') {
      throw invalidInput('Workflow template scope type is invalid.')
    }
    if (!Number.isSafeInteger(target.expectedRevision) || (target.expectedRevision as number) < 0) {
      throw invalidInput('Workflow template expected revision must be a non-negative integer.')
    }
    return {
      target: {
        kind: 'workflow',
        scopeType: target.scopeType,
        scopeId: requireBoundedText(target.scopeId, 'Workflow template scope ID', 256),
        expectedRevision: target.expectedRevision as number,
      },
    }
  }
  throw invalidInput('Template application target kind is invalid.')
}

/** Unknown inbound webhook endpoint 作成入力を厳格に検証します。 */
export function validateCreateAutomationInboundWebhookEndpointInput(
  value: unknown,
): CreateAutomationInboundWebhookEndpointInput {
  const input = requireRecord(value, 'Inbound webhook endpoint')
  assertOnlyKeys(input, ['name'], 'Inbound webhook endpoint')
  return {
    name: requireBoundedText(input.name, 'Inbound webhook endpoint name', 160),
  }
}

/** Unknown inbound webhook endpoint 更新入力を厳格に検証します。 */
export function validateUpdateAutomationInboundWebhookEndpointInput(
  value: unknown,
): UpdateAutomationInboundWebhookEndpointInput {
  const input = requireRecord(value, 'Inbound webhook endpoint update')
  assertOnlyKeys(input, ['expectedRevision', 'name'], 'Inbound webhook endpoint update')
  return {
    expectedRevision: requireInteger(
      input.expectedRevision,
      'Inbound webhook endpoint expected revision',
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    name: requireBoundedText(input.name, 'Inbound webhook endpoint name', 160),
  }
}

/** Unknown inbound webhook lifecycle 入力を厳格に検証します。 */
export function validateAutomationInboundWebhookLifecycleInput(
  value: unknown,
): AutomationInboundWebhookLifecycleInput {
  const input = requireRecord(value, 'Inbound webhook endpoint lifecycle')
  assertOnlyKeys(input, ['expectedRevision'], 'Inbound webhook endpoint lifecycle')
  return {
    expectedRevision: requireInteger(
      input.expectedRevision,
      'Inbound webhook endpoint expected revision',
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  }
}

/** Unknown recurring input を厳格に検証して正規化します。 */
export function validateCreateRecurringWorkInput(value: unknown): CreateRecurringWorkInput {
  const input = requireRecord(value, 'Recurring Work')
  return {
    name: requireBoundedText(input.name, 'Recurring Work name', 160),
    teamId: requireBoundedText(input.teamId, 'Recurring Work Team ID', 256),
    enabled: requireBoolean(input.enabled, 'Recurring Work enabled'),
    templateId: requireBoundedText(input.templateId, 'Recurring Work template ID', 256),
    schedule: validateRecurringSchedule(input.schedule),
  }
}

/** Unknown recurring schedule を検証します。 */
export function validateRecurringSchedule(value: unknown): RecurringSchedule {
  const schedule = requireRecord(value, 'Recurring schedule')
  if (schedule.frequency !== 'daily' && schedule.frequency !== 'weekly' && schedule.frequency !== 'monthly') {
    throw invalidInput('Recurring schedule frequency is invalid.')
  }
  const interval = requireInteger(schedule.interval, 'Recurring interval', 1, 365)
  const timeZone = requireBoundedText(schedule.timeZone, 'Recurring timezone', 128)
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format()
  } catch {
    throw invalidInput('Recurring timezone must be a valid IANA timezone ID.')
  }
  const localTime = requireBoundedText(schedule.localTime, 'Recurring local time', 5)
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(localTime)) {
    throw invalidInput('Recurring local time must use HH:mm.')
  }
  const startDate = requireBoundedText(schedule.startDate, 'Recurring start date', 10)
  if (!isIsoDate(startDate)) throw invalidInput('Recurring start date must use a valid YYYY-MM-DD date.')
  if (schedule.catchUpPolicy !== 'skip' && schedule.catchUpPolicy !== 'latest' && schedule.catchUpPolicy !== 'all') {
    throw invalidInput('Recurring catch-up policy is invalid.')
  }
  const result: RecurringSchedule = {
    frequency: schedule.frequency,
    interval,
    timeZone,
    localTime,
    startDate,
    catchUpPolicy: schedule.catchUpPolicy,
  }
  if (schedule.frequency === 'weekly') {
    if (!Array.isArray(schedule.daysOfWeek) || schedule.daysOfWeek.length === 0) {
      throw invalidInput('Weekly recurring schedule requires daysOfWeek.')
    }
    const days = schedule.daysOfWeek.map((day) => requireInteger(day, 'Recurring weekday', 0, 6))
    if (new Set(days).size !== days.length) throw invalidInput('Recurring weekdays must be unique.')
    result.daysOfWeek = [...days].sort((first, second) => first - second)
  } else if (schedule.daysOfWeek !== undefined) {
    throw invalidInput('Only weekly recurring schedules can define daysOfWeek.')
  }
  if (schedule.frequency === 'monthly') {
    result.dayOfMonth = requireInteger(schedule.dayOfMonth, 'Recurring month day', 1, 31)
  } else if (schedule.dayOfMonth !== undefined) {
    throw invalidInput('Only monthly recurring schedules can define dayOfMonth.')
  }
  if (schedule.maxCatchUpOccurrences !== undefined) {
    result.maxCatchUpOccurrences = requireInteger(
      schedule.maxCatchUpOccurrences,
      'Maximum catch-up occurrences',
      1,
      1_000,
    )
  }
  return result
}

/** Trigger event が trigger discriminator/filter に一致するか返します。 */
export function matchesAutomationTrigger(trigger: AutomationTrigger, event: AutomationEvent) {
  const metadata = event.metadata ?? {}
  switch (trigger.type) {
    case 'status': {
      const change = findChange(event, 'workflowStatusId')
      return Boolean(
        change &&
        (trigger.fromStatusId === undefined || change.before === trigger.fromStatusId) &&
        (trigger.toStatusId === undefined || change.after === trigger.toStatusId),
      )
    }
    case 'assignee': {
      const change = findChange(event, 'assigneeUserId')
      return Boolean(change && (
        trigger.assigneeMemberKey === undefined || change.after === trigger.assigneeMemberKey
      ))
    }
    case 'due': {
      const reason = event.eventType === 'work-item.due'
        ? 'due'
        : event.eventType === 'work-item.overdue'
          ? 'overdue'
          : findChange(event, 'dueDate') ? 'changed' : undefined
      return reason !== undefined && (trigger.reason === undefined || trigger.reason === reason)
    }
    case 'custom-field':
      return event.changes.some((change) =>
        change.field === `customFieldValues.${trigger.fieldId}` ||
        change.field === `customFields.${trigger.fieldId}`
      )
    case 'comment': {
      const commentKind = event.eventType === 'comment.created'
        ? 'comment'
        : event.eventType === 'comment.replied'
          ? 'reply'
          : undefined
      return commentKind !== undefined && (
        trigger.kind === undefined || trigger.kind === 'any' || trigger.kind === commentKind
      )
    }
    case 'form':
      return event.eventType === 'form.submitted' && metadata.formId === trigger.formId
    case 'webhook':
      return event.eventType === 'webhook.received' && metadata.webhookId === trigger.webhookId
    case 'schedule':
      return event.eventType === 'automation.schedule'
  }
}

/** Condition tree を event/workItem/variables に対して評価します。 */
export function evaluateAutomationCondition(
  condition: AutomationCondition,
  context: AutomationConditionContext,
): boolean {
  if (condition.type === 'all') {
    return condition.conditions.every((child) => evaluateAutomationCondition(child, context))
  }
  if (condition.type === 'any') {
    return condition.conditions.some((child) => evaluateAutomationCondition(child, context))
  }
  if (condition.type === 'not') {
    return !evaluateAutomationCondition(condition.condition, context)
  }
  const actual = readPath(context as unknown as Record<string, unknown>, condition.field)
  if (
    actual === undefined &&
    condition.operator !== 'exists' &&
    condition.operator !== 'not-exists'
  ) {
    return false
  }
  switch (condition.operator) {
    case 'exists': return actual !== undefined && actual !== null
    case 'not-exists': return actual === undefined || actual === null
    case 'equals': return canonicalString(actual) === canonicalString(condition.value)
    case 'not-equals': return canonicalString(actual) !== canonicalString(condition.value)
    case 'contains': return containsValue(actual, condition.value)
    case 'greater-than': return compareValues(actual, condition.value) > 0
    case 'greater-than-or-equal': return compareValues(actual, condition.value) >= 0
    case 'less-than': return compareValues(actual, condition.value) < 0
    case 'less-than-or-equal': return compareValues(actual, condition.value) <= 0
  }
}

/** Automation rule の event matching と idempotent action execution を行います。 */
export class AutomationEngine {
  /** Automation persistence client です。 */
  private readonly client: AutomationClient
  /** Domain action executor です。 */
  private readonly actionExecutor: AutomationActionExecutor

  /** Automation engine を作成します。 */
  constructor(client: AutomationClient, actionExecutor: AutomationActionExecutor) {
    this.client = client
    this.actionExecutor = actionExecutor
  }

  /** 一つの durable event を一つの rule version に適用します。 */
  async handleEvent(
    rule: AutomationRule,
    event: AutomationEvent,
    variables: Record<string, AutomationValue> = {},
    now = new Date(),
  ) {
    if (rule.workspaceId !== event.workspaceId) {
      return undefined
    }
    const executionId = createAutomationExecutionId(rule, event.eventId)
    const existing = await this.client.getExecution(rule.workspaceId, executionId)
    if (existing) return await this.resumeExistingExecution(existing, now)
    if (
      rule.trigger.type !== 'schedule' &&
      new Date(event.occurredAt).getTime() < new Date(rule.updatedAt).getTime()
    ) {
      return undefined
    }
    if (!rule.enabled || !matchesAutomationTrigger(rule.trigger, event)) return undefined
    if (!rule.conditions.every((condition) => evaluateAutomationCondition(condition, {
      event,
      workItem: event.workItem,
      variables,
    }))) {
      return undefined
    }
    const execution = createPendingExecution(rule, event, now)
    const lineage = event.automationRuleLineage ?? []
    if (lineage.length >= rule.maxChainDepth || (!rule.allowReentry && lineage.includes(rule.id))) {
      execution.status = 'skipped'
      execution.completedAt = now.toISOString()
      execution.errorCode = 'AutomationLoopPrevented'
      execution.errorMessage = 'Automation rule re-entry or chain depth was rejected.'
      execution.retryable = false
      return await this.createOrReadExecution(execution, event, rule)
    }
    const reservation = await this.client.reserveExecution(rule, event, now)
    if (reservation === 'stale-definition') return undefined
    if (reservation === 'rate-limited') {
      execution.status = 'skipped'
      execution.completedAt = now.toISOString()
      execution.errorCode = 'AutomationRateLimitExceeded'
      execution.errorMessage = 'Automation rule rate limit was exceeded.'
      execution.retryable = false
      return await this.createOrReadExecution(execution, event, rule)
    }
    if (reservation === 'duplicate') {
      const duplicate = await this.client.getExecution(rule.workspaceId, execution.id)
      if (!duplicate) {
        throw new AutomationError(
          503,
          'AutomationExecutionUnavailable',
          'Automation execution is unavailable after duplicate delivery.',
          true,
        )
      }
      return await this.resumeExistingExecution(duplicate, now)
    }
    return await this.run(rule, event, execution, now)
  }

  /** Failed/dead-letter execution を同じ immutable rule version と trigger event で retry します。 */
  async retryExecution(
    workspaceId: string,
    executionId: string,
    event?: AutomationEvent,
    now = new Date(),
  ) {
    const execution = await this.client.getExecution(workspaceId, executionId)
    if (!execution) throw new AutomationError(404, 'AutomationExecutionNotFound', 'Automation execution was not found.')
    if (execution.ruleId.startsWith('recurring:')) {
      const recurringWorkId = execution.ruleId.slice('recurring:'.length)
      const definition = recurringWorkId
        ? await this.client.getRecurringWork(workspaceId, recurringWorkId)
        : undefined
      if (!definition?.enabled) {
        throw new AutomationError(
          409,
          'RecurringWorkDisabled',
          'Recurring Work definition is unavailable or disabled.',
        )
      }
      return await retryRecurringExecution(
        execution,
        event ?? await this.client.getExecutionEvent(workspaceId, executionId),
        this.client,
        this.actionExecutor,
        now,
        {
          kind: 'recurring',
          id: definition.id,
          version: definition.version,
          revision: definition.revision,
        },
      )
    }
    const isDelayedRetry = execution.status === 'failed' && execution.retryable
    const isManualDeadLetterRetry = execution.status === 'dead-letter'
    if (!isDelayedRetry && !isManualDeadLetterRetry) {
      throw new AutomationError(409, 'AutomationExecutionNotRetryable', 'Automation execution cannot be retried.')
    }
    if (isDelayedRetry && execution.nextRetryAt && execution.nextRetryAt > now.toISOString()) {
      throw new AutomationError(409, 'AutomationRetryNotDue', 'Automation retry delay has not elapsed.')
    }
    const rule = await this.client.getRuleVersion(workspaceId, execution.ruleId, execution.ruleVersion)
    if (!rule) throw new AutomationError(503, 'AutomationRuleVersionUnavailable', 'Automation rule version is unavailable.')
    const triggerEvent = event ?? await this.client.getExecutionEvent(workspaceId, executionId)
    if (!triggerEvent) {
      throw new AutomationError(503, 'AutomationTriggerEventUnavailable', 'Automation trigger event is unavailable.')
    }
    return await this.run(rule, triggerEvent, execution, now)
  }

  /** Execution を条件付き作成し、duplicate の current row を返します。 */
  private async createOrReadExecution(
    execution: AutomationExecution,
    event: AutomationEvent,
    rule: AutomationRule,
  ) {
    if (await this.client.createExecution(execution, event, {
      kind: 'rule',
      id: rule.id,
      version: rule.version,
      revision: rule.revision,
    })) return execution
    return await this.client.getExecution(execution.workspaceId, execution.id)
  }

  /** Existing execution を初回予約時の immutable rule/event だけで再開します。 */
  private async resumeExistingExecution(execution: AutomationExecution, now: Date) {
    const resumable = execution.status === 'pending' || execution.status === 'running' ||
      (execution.status === 'failed' && execution.retryable)
    if (!resumable) return execution
    if (
      (execution.status === 'failed' || execution.status === 'running') &&
      execution.nextRetryAt &&
      execution.nextRetryAt > now.toISOString()
    ) {
      return execution
    }
    const rule = await this.client.getRuleVersion(
      execution.workspaceId,
      execution.ruleId,
      execution.ruleVersion,
    )
    if (!rule) {
      throw new AutomationError(
        503,
        'AutomationRuleVersionUnavailable',
        'Automation rule version is unavailable.',
        true,
      )
    }
    const event = await this.client.getExecutionEvent(execution.workspaceId, execution.id)
    if (!event) {
      throw new AutomationError(
        503,
        'AutomationTriggerEventUnavailable',
        'Automation trigger event is unavailable.',
        true,
      )
    }
    return await this.run(rule, event, execution, now)
  }

  /** 成功 receipt を尊重して actions を順次実行します。 */
  private async run(
    rule: AutomationRule,
    event: AutomationEvent,
    execution: AutomationExecution,
    now: Date,
  ) {
    const leaseExpiresAt = new Date(now.getTime() + AUTOMATION_EXECUTION_LEASE_MS).toISOString()
    const claimed = await this.client.claimExecution(execution, now, leaseExpiresAt)
    if (!claimed) {
      const current = await this.client.getExecution(execution.workspaceId, execution.id)
      if (current) return current
      throw new AutomationError(
        503,
        'AutomationExecutionUnavailable',
        'Automation execution is unavailable after runner lease contention.',
        true,
      )
    }
    execution.status = 'running'
    execution.attempts += 1
    execution.retryable = false
    execution.nextRetryAt = leaseExpiresAt
    execution.completedAt = undefined
    execution.errorCode = undefined
    execution.errorMessage = undefined
    const claimToken: AutomationExecutionClaimToken = {
      attempt: execution.attempts,
      leaseExpiresAt,
    }

    for (let index = 0; index < rule.actions.length; index += 1) {
      const action = rule.actions[index]!
      const actionState = execution.actions[index]!
      if (await this.client.hasActionReceipt(execution.workspaceId, execution.id, actionState.actionId)) {
        actionState.status = 'succeeded'
        if (!await this.client.saveExecution(execution, claimToken, new Date())) {
          return await readAutomationExecutionAfterLeaseLoss(this.client, execution)
        }
        continue
      }
      actionState.status = 'running'
      actionState.attempts += 1
      actionState.startedAt ??= now.toISOString()
      try {
        await this.actionExecutor.execute(action, {
          execution,
          event,
          actionIndex: index,
          idempotencyKey: actionState.actionId,
        })
        await this.client.putActionReceipt(execution.workspaceId, execution.id, actionState.actionId)
        const savedAt = new Date()
        actionState.status = 'succeeded'
        actionState.completedAt = savedAt.toISOString()
        actionState.errorCode = undefined
        actionState.errorMessage = undefined
        if (!await this.client.saveExecution(execution, claimToken, savedAt)) {
          return await readAutomationExecutionAfterLeaseLoss(this.client, execution)
        }
      } catch (error) {
        const failure = normalizeAutomationActionFailure(error)
        const savedAt = new Date()
        actionState.status = 'failed'
        actionState.errorCode = failure.code
        actionState.errorMessage = failure.message
        execution.errorCode = failure.code
        execution.errorMessage = failure.message
        execution.completedAt = savedAt.toISOString()
        if (failure.retryable && execution.attempts < rule.retryPolicy.maxAttempts) {
          execution.status = 'failed'
          execution.retryable = true
          execution.nextRetryAt = new Date(
            now.getTime() + calculateRetryDelay(rule.retryPolicy, execution.attempts),
          ).toISOString()
        } else {
          execution.status = 'dead-letter'
          execution.retryable = true
          execution.nextRetryAt = undefined
        }
        if (!await this.client.saveExecution(execution, claimToken, savedAt)) {
          return await readAutomationExecutionAfterLeaseLoss(this.client, execution)
        }
        return execution
      }
    }
    const savedAt = new Date()
    execution.status = 'succeeded'
    execution.retryable = false
    execution.nextRetryAt = undefined
    execution.completedAt = savedAt.toISOString()
    execution.errorCode = undefined
    execution.errorMessage = undefined
    if (!await this.client.saveExecution(execution, claimToken, savedAt)) {
      return await readAutomationExecutionAfterLeaseLoss(this.client, execution)
    }
    return execution
  }
}

async function readAutomationExecutionAfterLeaseLoss(
  client: AutomationClient,
  execution: AutomationExecution,
) {
  const current = await client.getExecution(execution.workspaceId, execution.id)
  if (current) return current
  throw new AutomationError(
    503,
    'AutomationExecutionUnavailable',
    'Automation execution is unavailable after runner lease loss.',
    true,
  )
}

/** Recurring execution を保存済み event と同じ action receipt で再実行します。 */
async function retryRecurringExecution(
  execution: AutomationExecution,
  event: AutomationEvent | undefined,
  client: AutomationClient,
  actionExecutor: AutomationActionExecutor,
  now: Date,
  definitionGuard: AutomationExecutionDefinitionGuard,
) {
  if (!event) {
    throw new AutomationError(
      503,
      'AutomationTriggerEventUnavailable',
      'Automation trigger event is unavailable.',
      true,
    )
  }
  const recurringWorkId = execution.ruleId.slice('recurring:'.length)
  const metadata = event.metadata ?? {}
  const storedRecurringWorkId = metadata.recurringWorkId
  const teamId = metadata.teamId
  const templateId = metadata.templateId
  const templateVersion = metadata.templateVersion
  const scheduledFor = metadata.scheduledFor
  if (
    !recurringWorkId ||
    storedRecurringWorkId !== recurringWorkId ||
    typeof teamId !== 'string' || !teamId.trim() ||
    typeof templateId !== 'string' || !templateId.trim() ||
    !Number.isSafeInteger(templateVersion) || (templateVersion as number) < 1 ||
    typeof scheduledFor !== 'string' ||
    execution.workspaceId !== event.workspaceId ||
    execution.triggerEventId !== event.eventId ||
    execution.id !== createRecurringExecutionId(
      execution.workspaceId,
      recurringWorkId,
      scheduledFor,
    )
  ) {
    throw new AutomationError(
      503,
      'RecurringExecutionInvalid',
      'Recurring execution event is invalid.',
    )
  }
  const actionState = execution.actions[0]
  const actionId = createAutomationActionId(execution.id, 0)
  if (
    execution.actions.length !== 1 ||
    !actionState ||
    actionState.actionIndex !== 0 ||
    actionState.actionId !== actionId
  ) {
    throw new AutomationError(
      503,
      'RecurringExecutionInvalid',
      'Recurring execution action state is invalid.',
    )
  }
  const actionAlreadySucceeded = await client.hasActionReceipt(
    execution.workspaceId,
    execution.id,
    actionId,
  )
  if (
    actionAlreadySucceeded &&
    execution.status === 'succeeded' &&
    actionState.status === 'succeeded'
  ) return execution
  const delayedRetry = execution.status === 'failed' && execution.retryable
  const expiredRunner = execution.status === 'running' &&
    (!execution.nextRetryAt || execution.nextRetryAt <= now.toISOString())
  if (execution.status !== 'dead-letter' && !delayedRetry && !expiredRunner) {
    throw new AutomationError(
      409,
      'AutomationExecutionNotRetryable',
      'Automation execution cannot be retried.',
    )
  }
  if (
    !actionAlreadySucceeded &&
    delayedRetry &&
    execution.nextRetryAt &&
    execution.nextRetryAt > now.toISOString()
  ) {
    throw new AutomationError(409, 'AutomationRetryNotDue', 'Automation retry delay has not elapsed.')
  }
  const leaseExpiresAt = new Date(now.getTime() + 5 * 60_000).toISOString()
  if (!await client.claimExecution(execution, now, leaseExpiresAt, definitionGuard)) {
    const raced = await client.getExecution(execution.workspaceId, execution.id)
    if (!raced) {
      throw new AutomationError(
        503,
        'AutomationExecutionUnavailable',
        'Automation execution is unavailable after a retry race.',
        true,
      )
    }
    return raced
  }
  execution.status = 'running'
  execution.attempts += 1
  execution.retryable = false
  execution.completedAt = undefined
  execution.nextRetryAt = leaseExpiresAt
  execution.errorCode = undefined
  execution.errorMessage = undefined
  const claimToken: AutomationExecutionClaimToken = {
    attempt: execution.attempts,
    leaseExpiresAt,
  }
  if (actionAlreadySucceeded) {
    actionState.status = 'succeeded'
    actionState.completedAt ??= now.toISOString()
    actionState.errorCode = undefined
    actionState.errorMessage = undefined
    execution.status = 'succeeded'
    execution.completedAt = actionState.completedAt
    execution.retryable = false
    execution.nextRetryAt = undefined
    execution.errorCode = undefined
    execution.errorMessage = undefined
    if (!await client.saveExecution(execution, claimToken, now)) {
      return await readAutomationExecutionAfterLeaseLoss(client, execution)
    }
    return execution
  }
  actionState.status = 'running'
  actionState.attempts += 1
  actionState.startedAt ??= now.toISOString()
  actionState.completedAt = undefined
  actionState.errorCode = undefined
  actionState.errorMessage = undefined
  const action: AutomationAction = {
    type: 'create',
    templateId,
    templateVersion: templateVersion as number,
    values: { teamId },
  }
  try {
    await actionExecutor.execute(action, {
      execution,
      event,
      actionIndex: 0,
      idempotencyKey: actionId,
    })
    await client.putActionReceipt(execution.workspaceId, execution.id, actionId)
    const savedAt = new Date()
    const completedAt = savedAt.toISOString()
    actionState.status = 'succeeded'
    actionState.completedAt = completedAt
    execution.status = 'succeeded'
    execution.completedAt = completedAt
    execution.retryable = false
    execution.nextRetryAt = undefined
    execution.errorCode = undefined
    execution.errorMessage = undefined
    if (!await client.saveExecution(execution, claimToken, savedAt)) {
      return await readAutomationExecutionAfterLeaseLoss(client, execution)
    }
    return execution
  } catch (error) {
    const failure = normalizeAutomationActionFailure(error)
    const savedAt = new Date()
    actionState.status = 'failed'
    actionState.completedAt = savedAt.toISOString()
    actionState.errorCode = failure.code
    actionState.errorMessage = failure.message
    execution.completedAt = savedAt.toISOString()
    execution.errorCode = failure.code
    execution.errorMessage = failure.message
    if (failure.retryable && execution.attempts < DEFAULT_AUTOMATION_RETRY_POLICY.maxAttempts) {
      const exponent = Math.max(0, execution.attempts - 1)
      const delay = Math.min(
        DEFAULT_AUTOMATION_RETRY_POLICY.maxDelayMs,
        Math.round(
          DEFAULT_AUTOMATION_RETRY_POLICY.initialDelayMs *
          DEFAULT_AUTOMATION_RETRY_POLICY.backoffMultiplier ** exponent,
        ),
      )
      execution.status = 'failed'
      execution.retryable = true
      execution.nextRetryAt = new Date(now.getTime() + delay).toISOString()
    } else {
      execution.status = 'dead-letter'
      execution.retryable = true
      execution.nextRetryAt = undefined
    }
    if (!await client.saveExecution(execution, claimToken, savedAt)) {
      return await readAutomationExecutionAfterLeaseLoss(client, execution)
    }
    return execution
  }
}

/** Recurring schedule の window 内 occurrences を UTC Date で返します。 */
export function getRecurringOccurrences(
  scheduleValue: RecurringSchedule,
  fromExclusive: Date,
  toInclusive: Date,
) {
  const schedule = validateRecurringSchedule(scheduleValue)
  if (!isValidDate(fromExclusive) || !isValidDate(toInclusive) || fromExclusive >= toInclusive) return []
  const firstLocal = addIsoDays(zonedDate(fromExclusive, schedule.timeZone), -2)
  const lastLocal = addIsoDays(zonedDate(toInclusive, schedule.timeZone), 2)
  const occurrences: Date[] = []
  for (let date = firstLocal, count = 0; date <= lastLocal; date = addIsoDays(date, 1), count += 1) {
    if (count > 20_000) throw new RangeError('Recurring occurrence window is too large.')
    if (date < schedule.startDate || !scheduleMatchesDate(schedule, date)) continue
    const instant = resolveLocalOccurrence(date, schedule.localTime, schedule.timeZone)
    if (instant > fromExclusive && instant <= toInclusive) occurrences.push(instant)
  }
  return occurrences.sort((first, second) => first.getTime() - second.getTime())
}

/** 指定 instant より後の最初の recurring occurrence を返します。 */
export function getNextRecurringOccurrence(schedule: RecurringSchedule, after: Date) {
  if (!isValidDate(after)) throw invalidInput('Recurring after timestamp is invalid.')
  const windows = [366, 1_830, 3_660]
  for (const days of windows) {
    const occurrences = getRecurringOccurrences(
      schedule,
      after,
      new Date(after.getTime() + days * 86_400_000),
    )
    if (occurrences[0]) return occurrences[0]
  }
  return undefined
}

/** Missed occurrences へ skip/latest/all catch-up policy を適用します。 */
export function selectCatchUpOccurrences(
  occurrences: readonly Date[],
  policy: RecurringCatchUpPolicy,
  maximum = 100,
) {
  const sorted = [...occurrences].filter(isValidDate).sort((first, second) => first.getTime() - second.getTime())
  if (policy === 'skip') return []
  if (policy === 'latest') return sorted.length ? [sorted.at(-1)!] : []
  return sorted.slice(0, requireInteger(maximum, 'Maximum catch-up occurrences', 1, 1_000))
}

/** Bulk request を mutation なしで preview します。 */
export async function previewBulkOperation(
  requestValue: BulkOperationRequest,
  adapter: BulkOperationAdapter,
) {
  const request = validateBulkOperationRequest(requestValue)
  const results = await Promise.all(request.items.map(async (item, itemIndex) => {
    try {
      const preview = await adapter.preview(request, itemIndex)
      return {
        ...item,
        status: preview.allowed ? 'ready' as const : 'failed' as const,
        ...(preview.errorCode ? { errorCode: preview.errorCode } : {}),
        ...(preview.errorMessage ? { errorMessage: preview.errorMessage } : {}),
        retryable: preview.retryable ?? false,
        undoable: false,
        ...(preview.undoPayload ? { undoPayload: structuredClone(preview.undoPayload) } : {}),
      }
    } catch (error) {
      const failure = normalizeAutomationActionFailure(error)
      return {
        ...item,
        status: 'failed' as const,
        errorCode: failure.code,
        errorMessage: failure.message,
        retryable: failure.retryable,
        undoable: false,
      }
    }
  }))
  return {
    operationToken: createBulkOperationToken(request),
    action: request.action,
    items: results,
    canApply: results.every((item) => item.status === 'ready'),
  } satisfies BulkOperationPreview
}

/** Preview token を検証し、item 単位の partial result を保持して apply します。 */
export async function applyBulkOperation(
  requestValue: BulkOperationRequest,
  preview: BulkOperationPreview,
  adapter: BulkOperationAdapter,
  actorMemberKey: string,
  client?: AutomationClient,
) {
  const request = validateBulkOperationRequest(requestValue)
  const normalizedActorMemberKey = requireBoundedText(
    actorMemberKey,
    'Bulk operation actor member key',
    256,
  )
  if (!request.operationToken || request.operationToken !== createBulkOperationToken(request) ||
    request.operationToken !== preview.operationToken) {
    throw new AutomationError(409, 'BulkPreviewTokenConflict', 'Bulk operation preview is stale.')
  }
  const operationId = createBulkOperationId(
    request.workspaceId,
    request.operationToken,
    normalizedActorMemberKey,
  )
  const existingOperation = client
    ? await client.getBulkOperation(request.workspaceId, operationId)
    : undefined
  if (existingOperation) {
    if (existingOperation.actorMemberKey !== normalizedActorMemberKey) {
      throw new AutomationError(403, 'BulkOperationForbidden', 'Bulk operation access is denied.')
    }
    return existingOperation.status === 'running'
      ? await retryBulkOperation(existingOperation, adapter, client)
      : existingOperation
  }
  if (!preview.canApply) throw new AutomationError(409, 'BulkPreviewRejected', 'Bulk preview contains invalid items.')
  const now = new Date().toISOString()
  const operation: BulkOperation = {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id: operationId,
    workspaceId: request.workspaceId,
    actorMemberKey: normalizedActorMemberKey,
    revision: 1,
    status: 'running',
    action: request.action,
    items: preview.items.map((item) => structuredClone(item)),
    createdAt: now,
    updatedAt: now,
  }
  if (client && !await client.createBulkOperation(operation)) {
    const concurrentlyCreated = await client.getBulkOperation(request.workspaceId, operationId)
    if (concurrentlyCreated) return concurrentlyCreated
    throw new AutomationError(
      503,
      'BulkOperationUnavailable',
      'Bulk operation was created but is not yet available.',
      true,
    )
  }
  for (let itemIndex = 0; itemIndex < request.items.length; itemIndex += 1) {
    operation.items[itemIndex] = await applyBulkItem(
      request,
      operation.items[itemIndex]!,
      itemIndex,
      adapter,
    )
    operation.updatedAt = new Date().toISOString()
    await saveBulkOperationCheckpoint(operation, client)
  }
  operation.status = summarizeBulkStatus(operation.items)
  operation.updatedAt = new Date().toISOString()
  await saveBulkOperationCheckpoint(operation, client)
  return operation
}

/** 未完了または retryable な failed items だけを再実行します。 */
export async function retryBulkOperation(
  operation: BulkOperation,
  adapter: BulkOperationAdapter,
  client?: AutomationClient,
) {
  const retryableIndexes = operation.items.flatMap((item, itemIndex) =>
    item.status === 'ready' || (item.status === 'failed' && item.retryable) ? [itemIndex] : []
  )
  if (retryableIndexes.length === 0) {
    if (operation.status === 'running') {
      operation.status = summarizeBulkStatus(operation.items)
      operation.updatedAt = new Date().toISOString()
      await saveBulkOperationCheckpoint(operation, client)
    }
    return operation
  }
  const request: BulkOperationRequest = {
    workspaceId: operation.workspaceId,
    action: operation.action,
    items: operation.items.map(({ teamId, workItemId, expectedRevision }) => ({
      teamId,
      workItemId,
      expectedRevision,
    })),
  }
  operation.status = 'running'
  operation.updatedAt = new Date().toISOString()
  await saveBulkOperationCheckpoint(operation, client)
  for (const itemIndex of retryableIndexes) {
    const item = operation.items[itemIndex]!
    operation.items[itemIndex] = await applyBulkItem(request, item, itemIndex, adapter)
    operation.updatedAt = new Date().toISOString()
    await saveBulkOperationCheckpoint(operation, client)
  }
  operation.status = summarizeBulkStatus(operation.items)
  operation.updatedAt = new Date().toISOString()
  await saveBulkOperationCheckpoint(operation, client)
  return operation
}

/** Successful items を current revision guard 付きで逆順 undo します。 */
export async function undoBulkOperation(
  operation: BulkOperation,
  adapter: BulkOperationAdapter,
  client?: AutomationClient,
) {
  operation.status = 'undoing'
  operation.updatedAt = new Date().toISOString()
  await saveBulkOperationCheckpoint(operation, client)
  for (let index = operation.items.length - 1; index >= 0; index -= 1) {
    const item = operation.items[index]!
    if (item.status !== 'succeeded' || !item.undoable) continue
    try {
      const result = await adapter.undo(operation, index)
      operation.items[index] = {
        ...item,
        status: 'undone',
        resultingRevision: result.resultingRevision,
        retryable: false,
        undoable: false,
      }
    } catch (error) {
      const failure = normalizeAutomationActionFailure(error)
      operation.items[index] = failure.retryable
        ? {
            ...item,
            errorCode: failure.code,
            errorMessage: failure.message,
            retryable: true,
          }
        : {
            ...item,
            status: 'failed',
            errorCode: failure.code,
            errorMessage: failure.message,
            retryable: false,
          }
    }
    operation.updatedAt = new Date().toISOString()
    await saveBulkOperationCheckpoint(operation, client)
  }
  operation.status = operation.items.every((item) => item.status === 'undone' || item.status === 'skipped')
    ? 'undone'
    : 'partial'
  operation.updatedAt = new Date().toISOString()
  await saveBulkOperationCheckpoint(operation, client)
  return operation
}

async function saveBulkOperationCheckpoint(
  operation: BulkOperation,
  client: AutomationClient | undefined,
) {
  const expectedRevision = operation.revision
  operation.revision = expectedRevision + 1
  if (!client) return
  try {
    await client.saveBulkOperation(operation, expectedRevision)
  } catch (error) {
    operation.revision = expectedRevision
    throw error
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

/** ScheduleDueIndex の固定 shard 数です。 */
export const AUTOMATION_SCHEDULE_SHARD_COUNT = 16

/** Workspace/definition を ScheduleDueIndex の安定した shard へ割り当てます。 */
export function createAutomationScheduleShard(workspaceId: string, recurringWorkId: string) {
  const digest = createHash('sha256').update(`${workspaceId}\0${recurringWorkId}`).digest()
  return `schedule-${String(digest[0]! % AUTOMATION_SCHEDULE_SHARD_COUNT).padStart(2, '0')}`
}

/** Bulk request 内容へ束縛した deterministic preview token を作成します。 */
export function createBulkOperationToken(request: BulkOperationRequest) {
  const normalized = {
    workspaceId: request.workspaceId,
    items: request.items,
    action: request.action,
  }
  return `bulk_preview_${createHash('sha256').update(canonicalString(normalized)).digest('hex')}`
}

function createBulkOperationId(
  workspaceId: string,
  operationToken: string,
  actorMemberKey: string,
) {
  const digest = createHash('sha256')
    .update(`${workspaceId}\0${operationToken}\0${actorMemberKey}`)
    .digest('hex')
  return `bulk_${digest}`
}

function validateAutomationTrigger(value: unknown): AutomationTrigger {
  const trigger = requireRecord(value, 'Automation trigger')
  switch (trigger.type) {
    case 'status':
      return {
        type: 'status',
        ...(trigger.fromStatusId === undefined ? {} : {
          fromStatusId: requireBoundedText(trigger.fromStatusId, 'From status ID', 128),
        }),
        ...(trigger.toStatusId === undefined ? {} : {
          toStatusId: requireBoundedText(trigger.toStatusId, 'To status ID', 128),
        }),
      }
    case 'assignee':
      return {
        type: 'assignee',
        ...(trigger.assigneeMemberKey === undefined ? {} : {
          assigneeMemberKey: requireBoundedText(trigger.assigneeMemberKey, 'Assignee member key', 256),
        }),
      }
    case 'due':
      if (trigger.reason !== undefined && trigger.reason !== 'changed' &&
        trigger.reason !== 'due' && trigger.reason !== 'overdue') {
        throw invalidInput('Automation due trigger reason is invalid.')
      }
      return { type: 'due', ...(trigger.reason === undefined ? {} : { reason: trigger.reason }) }
    case 'custom-field':
      return {
        type: 'custom-field',
        fieldId: requireBoundedText(trigger.fieldId, 'Custom field ID', 128),
      }
    case 'comment':
      if (trigger.kind !== undefined && trigger.kind !== 'comment' &&
        trigger.kind !== 'reply' && trigger.kind !== 'any') {
        throw invalidInput('Automation comment trigger kind is invalid.')
      }
      return { type: 'comment', ...(trigger.kind === undefined ? {} : { kind: trigger.kind }) }
    case 'form':
      return { type: 'form', formId: requireBoundedText(trigger.formId, 'Form ID', 256) }
    case 'webhook':
      return { type: 'webhook', webhookId: requireBoundedText(trigger.webhookId, 'Webhook ID', 256) }
    case 'schedule':
      return { type: 'schedule', schedule: validateRecurringSchedule(trigger.schedule) }
    default:
      throw invalidInput('Automation trigger type is invalid.')
  }
}

function validateAutomationConditions(value: unknown): AutomationCondition[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw invalidInput('Automation conditions must be an array with at most 32 entries.')
  }
  return value.map((condition) => validateAutomationCondition(condition, 0))
}

function validateAutomationCondition(value: unknown, depth: number): AutomationCondition {
  if (depth > 8) throw invalidInput('Automation condition nesting exceeds 8 levels.')
  const condition = requireRecord(value, 'Automation condition')
  if (condition.type === 'all' || condition.type === 'any') {
    if (!Array.isArray(condition.conditions) || condition.conditions.length === 0 ||
      condition.conditions.length > 32) {
      throw invalidInput('Automation condition group must contain between 1 and 32 children.')
    }
    return {
      type: condition.type,
      conditions: condition.conditions.map((child) => validateAutomationCondition(child, depth + 1)),
    }
  }
  if (condition.type === 'not') {
    return { type: 'not', condition: validateAutomationCondition(condition.condition, depth + 1) }
  }
  if (condition.type !== 'field') throw invalidInput('Automation condition type is invalid.')
  const field = requireBoundedText(condition.field, 'Automation condition field', 256)
  if (!field.startsWith('event.') && !field.startsWith('workItem.') && !field.startsWith('variables.')) {
    throw invalidInput('Automation condition field must start with event., workItem., or variables..')
  }
  const operators = new Set([
    'equals',
    'not-equals',
    'contains',
    'greater-than',
    'greater-than-or-equal',
    'less-than',
    'less-than-or-equal',
    'exists',
    'not-exists',
  ])
  if (typeof condition.operator !== 'string' || !operators.has(condition.operator)) {
    throw invalidInput('Automation condition operator is invalid.')
  }
  const isExistenceOperator = condition.operator === 'exists' || condition.operator === 'not-exists'
  if (isExistenceOperator && condition.value !== undefined) {
    throw invalidInput('Automation existence conditions cannot define a comparison value.')
  }
  if (!isExistenceOperator && condition.value === undefined) {
    throw invalidInput('Automation comparison conditions require a value.')
  }
  if (condition.value !== undefined && !isAutomationValue(condition.value)) {
    throw invalidInput('Automation condition value is invalid.')
  }
  return {
    type: 'field',
    field,
    operator: condition.operator as Extract<AutomationCondition, { type: 'field' }>['operator'],
    ...(condition.value === undefined ? {} : { value: structuredClone(condition.value) }),
  }
}

function validateAutomationAction(value: unknown): AutomationAction {
  const action = requireRecord(value, 'Automation action')
  switch (action.type) {
    case 'assign':
      return {
        type: 'assign',
        assigneeMemberKey: requireBoundedText(action.assigneeMemberKey, 'Assignee member key', 256),
      }
    case 'move':
      return {
        type: 'move',
        targetProjectId: action.targetProjectId === null
          ? null
          : requireBoundedText(action.targetProjectId, 'Target Project ID', 256),
      }
    case 'update': {
      const patch = requireRecord(action.patch, 'Automation update patch')
      if (!isAutomationValue(patch)) throw invalidInput('Automation update patch is invalid.')
      const fields = Object.keys(patch)
      if (fields.length === 0) throw invalidInput('Automation update patch cannot be empty.')
      const unsupportedFields = fields.filter((field) => !AUTOMATION_UPDATE_FIELDS.has(field))
      if (unsupportedFields.length > 0) {
        throw invalidInput(`Automation update patch contains unsupported fields: ${unsupportedFields.join(', ')}.`)
      }
      return { type: 'update', patch: structuredClone(patch) as Record<string, AutomationValue> }
    }
    case 'create': {
      const result: Extract<AutomationAction, { type: 'create' }> = { type: 'create' }
      if (action.templateId !== undefined) {
        result.templateId = requireBoundedText(action.templateId, 'Automation template ID', 256)
      }
      if (action.values !== undefined) {
        const values = requireRecord(action.values, 'Automation create values')
        if (!isAutomationValue(values)) throw invalidInput('Automation create values are invalid.')
        result.values = structuredClone(values) as Record<string, AutomationValue>
      }
      if (!result.templateId && !result.values) throw invalidInput('Automation create action requires templateId or values.')
      return result
    }
    case 'comment':
      return { type: 'comment', body: requireBoundedText(action.body, 'Automation comment body', 20_000) }
    case 'notify': {
      const recipientMemberKeys = readUniqueTexts(action.recipientMemberKeys, 'Notification recipients', 100)
      if (recipientMemberKeys.length === 0) throw invalidInput('Automation notification requires recipients.')
      return {
        type: 'notify',
        recipientMemberKeys,
        title: requireBoundedText(action.title, 'Notification title', 256),
        ...(action.body === undefined ? {} : {
          body: requireBoundedText(action.body, 'Notification body', 4_096),
        }),
      }
    }
    case 'approval': {
      const reviewerMemberKeys = readUniqueTexts(
        action.reviewerMemberKeys,
        'Approval reviewers',
        APPROVAL_MAX_REVIEWERS,
      )
      if (reviewerMemberKeys.length === 0) throw invalidInput('Automation approval requires reviewers.')
      return {
        type: 'approval',
        reviewerMemberKeys,
        dueInHours: requireInteger(action.dueInHours, 'Approval due hours', 1, 8_760),
        ...(action.completionStatusId === undefined ? {} : {
          completionStatusId: requireBoundedText(action.completionStatusId, 'Completion status ID', 128),
        }),
      }
    }
    case 'webhook': {
      const url = requireBoundedText(action.url, 'Webhook URL', 2_048)
      const endpoint = readAutomationWebhookEndpoint(url)
      if (!endpoint) {
        throw invalidInput('Automation webhook URL must use public HTTPS without credentials or a custom port.')
      }
      const result: Extract<AutomationAction, { type: 'webhook' }> = {
        type: 'webhook',
        url: endpoint.toString(),
      }
      if (action.secretReference !== undefined) {
        const secretReference = requireBoundedText(
          action.secretReference,
          'Webhook secret reference',
          128,
        )
        if (!isAutomationWebhookSecretAlias(secretReference)) {
          throw invalidInput('Automation webhook secret reference must be a valid alias.')
        }
        result.secretReference = secretReference
      }
      if (action.body !== undefined) {
        const body = requireRecord(action.body, 'Webhook body')
        if (!isAutomationValue(body)) throw invalidInput('Automation webhook body is invalid.')
        result.body = structuredClone(body) as Record<string, AutomationValue>
      }
      return result
    }
    default:
      throw invalidInput('Automation action type is invalid.')
  }
}

function validateAutomationRetryPolicy(value: unknown): AutomationRetryPolicy {
  const policy = requireRecord(value, 'Automation retry policy')
  const initialDelayMs = requireInteger(policy.initialDelayMs, 'Initial retry delay', 0, 86_400_000)
  const maxDelayMs = requireInteger(policy.maxDelayMs, 'Maximum retry delay', 0, 86_400_000)
  if (maxDelayMs < initialDelayMs) throw invalidInput('Maximum retry delay cannot be smaller than initial delay.')
  if (typeof policy.backoffMultiplier !== 'number' || !Number.isFinite(policy.backoffMultiplier) ||
    policy.backoffMultiplier < 1 || policy.backoffMultiplier > 100) {
    throw invalidInput('Automation retry backoff multiplier is invalid.')
  }
  return {
    maxAttempts: requireInteger(policy.maxAttempts, 'Maximum retry attempts', 1, 100),
    initialDelayMs,
    backoffMultiplier: policy.backoffMultiplier,
    maxDelayMs,
  }
}

function validateAutomationRateLimit(value: unknown): AutomationRateLimit {
  const limit = requireRecord(value, 'Automation rate limit')
  return {
    maxExecutions: requireInteger(limit.maxExecutions, 'Maximum executions', 1, 100_000),
    windowSeconds: requireInteger(limit.windowSeconds, 'Rate-limit window', 1, 86_400),
  }
}

const bulkEditableWorkItemFields = new Set([
  'assignedProjectId',
  'assigneeUserId',
  'customFieldValues',
  'description',
  'dueDate',
  'priority',
  'title',
  'workflowStatusId',
])

function validateBulkOperationRequest(value: unknown): BulkOperationRequest {
  const request = requireRecord(value, 'Bulk operation request')
  const workspaceId = requireBoundedText(request.workspaceId, 'Bulk Workspace ID', 256)
  if (!Array.isArray(request.items) || request.items.length === 0 || request.items.length > 100) {
    throw invalidInput('Bulk operation must contain between 1 and 100 items.')
  }
  const items = request.items.map((value) => {
    const item = requireRecord(value, 'Bulk operation item')
    return {
      teamId: requireBoundedText(item.teamId, 'Bulk Team ID', 256),
      workItemId: requireBoundedText(item.workItemId, 'Bulk Work Item ID', 256),
      expectedRevision: requireInteger(item.expectedRevision, 'Bulk expected revision', 1, Number.MAX_SAFE_INTEGER),
    }
  })
  const uniqueTargets = new Set(items.map((item) => `${item.teamId}\0${item.workItemId}`))
  if (uniqueTargets.size !== items.length) throw invalidInput('Bulk operation items must be unique.')
  const action = requireRecord(request.action, 'Bulk operation action')
  let normalizedAction: BulkOperationRequest['action']
  if (action.type === 'edit') {
    const patch = requireRecord(action.patch, 'Bulk edit patch')
    if (!isAutomationValue(patch) || Object.keys(patch).length === 0) throw invalidInput('Bulk edit patch is invalid.')
    const unsupportedFields = Object.keys(patch).filter((field) => !bulkEditableWorkItemFields.has(field))
    if (unsupportedFields.length > 0) {
      throw invalidInput(`Bulk edit cannot update fields: ${unsupportedFields.join(', ')}.`)
    }
    normalizedAction = { type: 'edit', patch: structuredClone(patch) as Record<string, AutomationValue> }
  } else if (action.type === 'move') {
    normalizedAction = {
      type: 'move',
      targetProjectId: action.targetProjectId === null
        ? null
        : requireBoundedText(action.targetProjectId, 'Bulk target Project ID', 256),
    }
  } else if (action.type === 'archive') {
    normalizedAction = { type: 'archive', archived: requireBoolean(action.archived, 'Bulk archived') }
  } else {
    throw invalidInput('Bulk operation action is invalid.')
  }
  return {
    workspaceId,
    items,
    action: normalizedAction,
    ...(request.operationToken === undefined ? {} : {
      operationToken: requireBoundedText(request.operationToken, 'Bulk operation token', 256),
    }),
  }
}

async function applyBulkItem(
  request: BulkOperationRequest,
  item: BulkOperationItemResult,
  itemIndex: number,
  adapter: BulkOperationAdapter,
): Promise<BulkOperationItemResult> {
  try {
    const result = await adapter.apply(request, itemIndex, item)
    return {
      ...item,
      status: 'succeeded',
      resultingRevision: result.resultingRevision,
      retryable: false,
      undoable: result.undoPayload !== undefined,
      ...(result.undoPayload ? { undoPayload: result.undoPayload } : {}),
    }
  } catch (error) {
    const failure = normalizeAutomationActionFailure(error)
    return {
      ...item,
      status: 'failed',
      errorCode: failure.code,
      errorMessage: failure.message,
      retryable: failure.retryable,
      undoable: false,
    }
  }
}

function summarizeBulkStatus(items: readonly BulkOperationItemResult[]): BulkOperation['status'] {
  const succeeded = items.filter((item) => item.status === 'succeeded').length
  if (succeeded === items.length) return 'succeeded'
  if (succeeded > 0) return 'partial'
  return 'failed'
}

function createPendingExecution(rule: AutomationRule, event: AutomationEvent, now: Date): AutomationExecution {
  const id = createAutomationExecutionId(rule, event.eventId)
  return {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    id,
    workspaceId: rule.workspaceId,
    ruleId: rule.id,
    ruleVersion: rule.version,
    triggerEventId: event.eventId,
    status: 'pending',
    attempts: 0,
    actions: rule.actions.map((_action, actionIndex) => ({
      actionIndex,
      actionId: createAutomationActionId(id, actionIndex),
      status: 'pending',
      attempts: 0,
    } satisfies AutomationActionExecution)),
    startedAt: now.toISOString(),
    retryable: false,
  }
}

function calculateRetryDelay(policy: AutomationRetryPolicy, attempts: number) {
  return Math.min(
    policy.maxDelayMs,
    Math.floor(policy.initialDelayMs * policy.backoffMultiplier ** Math.max(0, attempts - 1)),
  )
}

const retryableAwsErrorCodes = new Set([
  'InternalServerError',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
  'RequestTimeout',
  'ServiceUnavailable',
  'Throttling',
  'ThrottlingException',
  'TransactionInProgressException',
])
const trustedExternalAutomationFailureCodes = new Set([
  ...retryableAwsErrorCodes,
  'ConditionalCheckFailedException',
  'WorkItemRevisionConflict',
])

/** Action adapter failure を stable code/message/retryability へ正規化します。 */
export function normalizeAutomationActionFailure(error: unknown) {
  if (error instanceof AutomationError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable || isTransientFailureStatus(error.status),
    }
  }
  if (isRecord(error)) {
    const metadata = isRecord(error.$metadata) ? error.$metadata : undefined
    const status = typeof error.status === 'number'
      ? error.status
      : typeof error.statusCode === 'number'
        ? error.statusCode
        : typeof metadata?.httpStatusCode === 'number'
          ? metadata.httpStatusCode
          : undefined
    const rawCode = typeof error.code === 'string'
      ? error.code
      : typeof error.name === 'string' ? error.name : 'AutomationActionFailed'
    const code = trustedExternalAutomationFailureCodes.has(rawCode)
      ? rawCode
      : 'AutomationActionFailed'
    return {
      code,
      message: 'Automation action failed.',
      retryable: error.retryable === true || Boolean(error.$retryable) ||
        retryableAwsErrorCodes.has(code) || isTransientFailureStatus(status),
    }
  }
  return { code: 'AutomationActionFailed', message: 'Automation action failed.', retryable: false }
}

function isTransientFailureStatus(status: number | undefined) {
  return status === 408 || status === 429 ||
    (status !== undefined && status >= 500 && status <= 599)
}

function findChange(event: AutomationEvent, field: string) {
  return event.changes.find((change) => change.field === field)
}

function readPath(root: Record<string, unknown>, path: string) {
  return path.split('.').reduce<unknown>((value, part) =>
    isRecord(value) ? value[part] : undefined, root)
}

function containsValue(actual: unknown, expected: unknown) {
  if (typeof actual === 'string' && typeof expected === 'string') return actual.includes(expected)
  if (Array.isArray(actual)) return actual.some((value) => canonicalString(value) === canonicalString(expected))
  return false
}

function compareValues(first: unknown, second: unknown) {
  if (typeof first === 'number' && typeof second === 'number') return first - second
  if (typeof first === 'string' && typeof second === 'string') return first.localeCompare(second)
  return Number.NaN
}

function scheduleMatchesDate(schedule: RecurringSchedule, date: string) {
  const dayDifference = daysBetween(schedule.startDate, date)
  if (dayDifference < 0) return false
  if (schedule.frequency === 'daily') return dayDifference % schedule.interval === 0
  if (schedule.frequency === 'weekly') {
    return Math.floor(dayDifference / 7) % schedule.interval === 0 &&
      Boolean(schedule.daysOfWeek?.includes(isoDateWeekday(date)))
  }
  const monthDifference = monthsBetween(schedule.startDate, date)
  return monthDifference >= 0 && monthDifference % schedule.interval === 0 &&
    Number(date.slice(8, 10)) === schedule.dayOfMonth
}

function resolveLocalOccurrence(date: string, time: string, timeZone: string) {
  const exact = findMatchingInstants(date, time, timeZone)
  if (exact.length > 0) return exact[0]!
  let candidateDate = date
  let candidateTime = time
  for (let skippedMinutes = 0; skippedMinutes < 180; skippedMinutes += 1) {
    ;({ date: candidateDate, time: candidateTime } = addLocalMinute(candidateDate, candidateTime))
    const shifted = findMatchingInstants(candidateDate, candidateTime, timeZone)
    if (shifted.length > 0) return shifted[0]!
  }
  throw new AutomationError(503, 'RecurringDstResolutionFailed', 'Recurring local time could not be resolved.')
}

function findMatchingInstants(date: string, time: string, timeZone: string) {
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const approximate = Date.UTC(year!, month! - 1, day!, hour!, minute!)
  const offsets = new Set([-2, -1, 0, 1, 2].map((dayOffset) =>
    zonedOffsetMinutes(new Date(approximate + dayOffset * 86_400_000), timeZone)
  ))
  const matches: Date[] = []
  for (const offset of offsets) {
    const candidate = new Date(approximate - offset * 60_000)
    const local = zonedDateTime(candidate, timeZone)
    if (local.date === date && local.time === time) matches.push(candidate)
  }
  return [...new Map(matches.map((match) => [match.getTime(), match])).values()]
    .sort((first, second) => first.getTime() - second.getTime())
}

function zonedDate(value: Date, timeZone: string) {
  return zonedDateTime(value, timeZone).date
}

function zonedDateTime(value: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? ''
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    time: `${part('hour')}-${part('minute')}`.replace('-', ':'),
  }
}

function zonedOffsetMinutes(value: Date, timeZone: string) {
  const local = zonedDateTime(value, timeZone)
  const [year, month, day] = local.date.split('-').map(Number)
  const [hour, minute] = local.time.split(':').map(Number)
  const minuteAligned = Math.floor(value.getTime() / 60_000) * 60_000
  return (Date.UTC(year!, month! - 1, day!, hour!, minute!) - minuteAligned) / 60_000
}

function addLocalMinute(date: string, time: string) {
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const next = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute! + 1))
  return { date: next.toISOString().slice(0, 10), time: next.toISOString().slice(11, 16) }
}

function addIsoDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function daysBetween(from: string, to: string) {
  return Math.floor((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000)
}

function monthsBetween(from: string, to: string) {
  return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
    Number(to.slice(5, 7)) - Number(from.slice(5, 7))
}

function isoDateWeekday(date: string) {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay()
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

function createInboundWebhookSecretId(workspaceId: string, endpointId: string) {
  const prefix = process.env.AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX
    ?.trim()
    .replace(/^\/+|\/+$/g, '') || 'mukuroji/automation-inbound-webhooks'
  return `${prefix}/${hashCanonicalText(requireText(workspaceId, 'Workspace ID'))}/${requireBoundedText(
    endpointId,
    'Inbound webhook endpoint ID',
    256,
  )}`
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

/** Server-only secret/provisioning metadata を除いた endpoint response を返します。 */
export function toAutomationInboundWebhookEndpoint(
  endpoint: AutomationInboundWebhookEndpointRecord,
): AutomationInboundWebhookEndpoint {
  const {
    secretId: _secretId,
    secretVersionId: _secretVersionId,
    provisioningOperationId: _provisioningOperationId,
    provisioningTargetStatus: _provisioningTargetStatus,
    ...publicEndpoint
  } = endpoint
  return publicEndpoint
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
      409,
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
  return new AutomationError(409, 'AutomationRevisionConflict', 'Automation revision does not match.')
}

function bulkRevisionConflict() {
  return new AutomationError(409, 'BulkOperationRevisionConflict', 'Bulk operation revision does not match.')
}

function idempotencyConflict() {
  return new AutomationError(
    409,
    'IdempotencyConflict',
    'Idempotency key was already used with different automation input.',
  )
}

function inboundWebhookNotFound() {
  return new AutomationError(
    404,
    'AutomationInboundWebhookNotFound',
    'Inbound webhook endpoint was not found.',
  )
}

function inboundWebhookLifecycleConflict() {
  return new AutomationError(
    409,
    'AutomationInboundWebhookLifecycleConflict',
    'Inbound webhook endpoint lifecycle changed.',
  )
}

function inboundWebhookIdempotencyConflict() {
  return new AutomationError(
    409,
    'AutomationInboundWebhookIdempotencyConflict',
    'Idempotency key was already used with a different request body.',
  )
}

function inboundWebhookSignatureReplay() {
  return new AutomationError(
    409,
    'AutomationInboundWebhookSignatureReplay',
    'Inbound webhook signature was already used with a different idempotency key.',
  )
}

function invalidInput(message: string) {
  return new AutomationError(400, 'InvalidAutomationInput', message)
}

function storedInvalid(label: string) {
  return new AutomationError(503, 'StoredAutomationInvalid', `Stored ${label} is invalid.`)
}

function persistenceError(error: unknown) {
  if (error instanceof AutomationError) return error
  return new AutomationError(
    503,
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

function readOptionalTemplateString(value: unknown, label: string) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalidInput(`${label} must be a string.`)
  return value
}

function requireBoolean(value: unknown, label: string) {
  if (typeof value !== 'boolean') throw invalidInput(`${label} must be boolean.`)
  return value
}

function requireInteger(value: unknown, label: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw invalidInput(`${label} must be an integer between ${minimum} and ${maximum}.`)
  }
  return value as number
}

function readUniqueTexts(value: unknown, label: string, maximum: number) {
  if (!Array.isArray(value) || value.length > maximum) throw invalidInput(`${label} are invalid.`)
  const values = value.map((entry) => requireBoundedText(entry, label, 256))
  if (new Set(values).size !== values.length) throw invalidInput(`${label} must be unique.`)
  return values
}

/** Public inbound webhook payload として保存可能な JSON-compatible value か判定します。 */
export function isAutomationValue(value: unknown, depth = 0): value is AutomationValue {
  if (depth > 20) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 1_000 && value.every((entry) => isAutomationValue(entry, depth + 1))
  if (isRecord(value)) {
    const entries = Object.entries(value)
    return entries.length <= 1_000 && entries.every(([key, entry]) =>
      key.length > 0 && key.length <= 256 && isAutomationValue(entry, depth + 1)
    )
  }
  return false
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
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

function isIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function isValidDate(value: Date) {
  return value instanceof Date && !Number.isNaN(value.getTime())
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
