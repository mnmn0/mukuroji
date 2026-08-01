import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'node:crypto'
import type {
  RequestTenantClosureInput,
  RequestTenantExportInput,
  TenantAdministrationSnapshot,
  TenantClosureStep,
  TenantDefaultPolicy,
  TenantEntitlement,
  TenantExportStep,
  TenantGovernancePolicy,
  TenantOperation,
  TenantOperationStepProof,
  TenantProfile,
  TenantUsage,
  UpdateTenantEntitlementInput,
  UpdateTenantGovernanceInput,
  UpdateTenantProfileInput,
} from '@mukuroji/contracts'
import type { TenantFeature } from '@mukuroji/contracts'
import {
  TENANT_CLOSURE_STEPS,
  TENANT_EXPORT_STEPS,
  TenantAdministrationError,
  advanceTenantOperation,
  assertTenantFeatureEnabled,
  createDefaultTenantAdministrationSnapshot,
  isTenantOperationActive,
  pauseTenantOperation,
  reserveTenantUsage,
  resumeTenantOperation,
  validateTenantBoolean,
  validateTenantFeatures,
  validateTenantInteger,
  validateTenantLocale,
  validateTenantPlan,
  validateTenantRegion,
  verifyTenantClosure,
} from '../../domain/tenant-administration'
import type {
  TenantAdministrationAuditEvent,
  TenantAdministrationAuditWriter,
  TenantAdministrationClient,
  TenantAdministrationTransactionItem,
} from '../../application/ports/tenant-administration-port'

/** DynamoDB transaction item used by tenant administration mutations. */
type TenantTransactionItem = TenantAdministrationTransactionItem

const PROFILE_RECORD_KEY = 'PROFILE'
const ENTITLEMENT_RECORD_KEY = 'ENTITLEMENT'
const USAGE_RECORD_KEY = 'USAGE'
const GOVERNANCE_RECORD_KEY = 'GOVERNANCE'
const ACTIVE_OPERATION_RECORD_KEY = 'ACTIVE_OPERATION'
const OPERATION_RECORD_PREFIX = 'OPERATION#'

/**
 * DynamoDB-backed tenant administration state and workflow adapter.
 */
export class DynamoDbTenantAdministrationClient implements TenantAdministrationClient {
  /** DynamoDB table containing tenant control-plane records. */
  private readonly tableName: string
  /** Document client used for strongly consistent tenant reads. */
  private readonly documentClient: DynamoDBDocumentClient
  /** Clock injected for deterministic tests and operation timestamps. */
  private readonly now: () => string
  /** Optional append-only audit transaction builder. */
  private readonly auditWriter?: TenantAdministrationAuditWriter

  /**
   * Creates a tenant administration adapter.
   *
   * @param tableName - Tenant administration table name.
   * @param documentClient - DynamoDB document client.
   * @param now - Timestamp supplier.
   * @param auditWriter - Optional append-only audit transaction builder.
   */
  constructor(
    tableName: string,
    documentClient: DynamoDBDocumentClient,
    now: () => string = () => new Date().toISOString(),
    auditWriter?: TenantAdministrationAuditWriter,
  ) {
    const normalizedTableName = tableName.trim()
    if (!normalizedTableName) {
      throw new TenantAdministrationError(
        503,
        'TenantAdministrationUnavailable',
        'Tenant administration state is unavailable.',
      )
    }
    this.tableName = normalizedTableName
    this.documentClient = documentClient
    this.now = now
    this.auditWriter = auditWriter
  }

  /** Ensures the four tenant aggregate records exist before returning them. */
  async ensureSnapshot(
    workspaceId: string,
    ownerMemberKey: string,
  ): Promise<TenantAdministrationSnapshot> {
    try {
      return await this.getSnapshot(workspaceId)
    } catch (error) {
      if (!(error instanceof TenantAdministrationError) || error.code !== 'TenantAdministrationNotInitialized') {
        throw error
      }
    }

    const now = this.now()
    const snapshot = createDefaultTenantAdministrationSnapshot(workspaceId, ownerMemberKey, now)
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          createPutTransactionItem(this.tableName, workspaceId, PROFILE_RECORD_KEY, 'profile', snapshot.profile),
          createPutTransactionItem(this.tableName, workspaceId, ENTITLEMENT_RECORD_KEY, 'entitlement', snapshot.entitlement),
          createPutTransactionItem(this.tableName, workspaceId, USAGE_RECORD_KEY, 'usage', snapshot.usage),
          createPutTransactionItem(this.tableName, workspaceId, GOVERNANCE_RECORD_KEY, 'governance', snapshot.governance),
        ],
      }))
    } catch (error) {
      if (!isConditionalFailure(error)) {
        throw toTenantPersistenceError(error)
      }
    }
    return this.getSnapshot(workspaceId)
  }

  /** Reads the tenant aggregate with strongly consistent record reads. */
  async getSnapshot(workspaceId: string): Promise<TenantAdministrationSnapshot> {
    const [profile, entitlement, usage, governance] = await Promise.all([
      this.readRecord(workspaceId, PROFILE_RECORD_KEY, readTenantProfile),
      this.readRecord(workspaceId, ENTITLEMENT_RECORD_KEY, readTenantEntitlement),
      this.readRecord(workspaceId, USAGE_RECORD_KEY, readTenantUsage),
      this.readRecord(workspaceId, GOVERNANCE_RECORD_KEY, readTenantGovernance),
    ])
    const activeOperation = await this.readActiveOperation(workspaceId)
    return {
      schemaVersion: 1,
      profile,
      entitlement,
      usage,
      governance,
      ...(activeOperation ? { activeOperation } : {}),
    }
  }

  /** Updates profile state with a top-level revision condition. */
  async updateProfile(
    workspaceId: string,
    actorMemberKey: string,
    input: UpdateTenantProfileInput,
  ): Promise<TenantProfile> {
    const [current, governance] = await Promise.all([
      this.readRecord(workspaceId, PROFILE_RECORD_KEY, readTenantProfile),
      this.readRecord(workspaceId, GOVERNANCE_RECORD_KEY, readTenantGovernance),
    ])
    if (current.revision !== input.expectedRevision) {
      throw revisionConflict('TenantProfileRevisionConflict')
    }
    const updated: TenantProfile = {
      ...current,
      region: validateTenantRegion(input.region),
      locale: validateTenantLocale(input.locale),
      defaultPolicy: readTenantDefaultPolicy(input.defaultPolicy),
      revision: current.revision + 1,
      updatedAt: this.now(),
    }
    await this.putRecord(workspaceId, PROFILE_RECORD_KEY, 'profile', updated, current.revision, {
      workspaceId,
      actorMemberKey,
      eventType: 'tenant.profile.updated',
      entityId: workspaceId,
      action: 'updated',
      path: '/api/tenant/profile',
      idempotencyKey: `tenant-profile:${workspaceId}:${updated.revision}`,
      before: current,
      after: updated,
      metadata: { kind: 'tenant-profile' },
      retentionDays: governance.auditRetentionDays,
      legalHold: governance.legalHold,
      occurredAt: updated.updatedAt,
    })
    return updated
  }

  /** Updates entitlement state while preserving the current usage boundary. */
  async updateEntitlement(
    workspaceId: string,
    actorMemberKey: string,
    input: UpdateTenantEntitlementInput,
  ): Promise<TenantEntitlement> {
    const [current, usage, governance] = await Promise.all([
      this.readRecord(workspaceId, ENTITLEMENT_RECORD_KEY, readTenantEntitlement),
      this.readRecord(workspaceId, USAGE_RECORD_KEY, readTenantUsage),
      this.readRecord(workspaceId, GOVERNANCE_RECORD_KEY, readTenantGovernance),
    ])
    if (current.revision !== input.expectedRevision) {
      throw revisionConflict('TenantEntitlementRevisionConflict')
    }
    const seatLimit = validateTenantInteger(input.seatLimit, 1_000_000, 'InvalidTenantSeatLimit')
    if (usage.activeSeats > seatLimit) {
      throw new TenantAdministrationError(
        409,
        'TenantSeatLimitBelowUsage',
        'Tenant seat limit cannot be lower than current active seats.',
      )
    }
    const updated: TenantEntitlement = {
      ...current,
      plan: validateTenantPlan(input.plan),
      features: validateTenantFeatures(input.features),
      seatLimit,
      usageQuota: validateTenantInteger(input.usageQuota, 1_000_000_000, 'InvalidTenantUsageQuota'),
      gracePeriodDays: validateTenantInteger(input.gracePeriodDays, 90, 'InvalidTenantGracePeriod'),
      revision: current.revision + 1,
      updatedAt: this.now(),
    }
    await this.putRecord(workspaceId, ENTITLEMENT_RECORD_KEY, 'entitlement', updated, current.revision, {
      workspaceId,
      actorMemberKey,
      eventType: 'tenant.entitlement.updated',
      entityId: workspaceId,
      action: 'updated',
      path: '/api/tenant/entitlement',
      idempotencyKey: `tenant-entitlement:${workspaceId}:${updated.revision}`,
      before: current,
      after: updated,
      metadata: { kind: 'tenant-entitlement' },
      retentionDays: governance.auditRetentionDays,
      legalHold: governance.legalHold,
      occurredAt: updated.updatedAt,
    })
    return updated
  }

  /** Updates governance policy and rejects unsafe retention or residency values. */
  async updateGovernance(
    workspaceId: string,
    actorMemberKey: string,
    input: UpdateTenantGovernanceInput,
  ): Promise<TenantGovernancePolicy> {
    const current = await this.readRecord(workspaceId, GOVERNANCE_RECORD_KEY, readTenantGovernance)
    if (current.revision !== input.expectedRevision) {
      throw revisionConflict('TenantGovernanceRevisionConflict')
    }
    const updated: TenantGovernancePolicy = {
      ...current,
      auditRetentionDays: validateTenantInteger(input.auditRetentionDays, 2_555, 'InvalidAuditRetentionDays'),
      legalHold: validateTenantBoolean(input.legalHold, 'InvalidLegalHold'),
      dataResidency: validateTenantRegion(input.dataResidency),
      encryptionKeyPolicy: readEncryptionKeyPolicy(input.encryptionKeyPolicy),
      revision: current.revision + 1,
      updatedAt: this.now(),
      updatedBy: actorMemberKey,
    }
    if (updated.auditRetentionDays < 30) {
      throw new TenantAdministrationError(
        400,
        'InvalidAuditRetentionDays',
        'Audit retention must be at least 30 days.',
      )
    }
    await this.putRecord(workspaceId, GOVERNANCE_RECORD_KEY, 'governance', updated, current.revision, {
      workspaceId,
      actorMemberKey,
      eventType: 'tenant.governance.updated',
      entityId: workspaceId,
      action: 'updated',
      path: '/api/tenant/governance',
      idempotencyKey: `tenant-governance:${workspaceId}:${updated.revision}`,
      before: current,
      after: updated,
      metadata: { kind: 'tenant-governance' },
      retentionDays: updated.auditRetentionDays,
      legalHold: updated.legalHold,
      occurredAt: updated.updatedAt,
    })
    return updated
  }

  /** Applies a feature and quota check before atomically persisting metered usage. */
  async reserveUsage(
    workspaceId: string,
    feature: TenantFeature,
    additionalUnits: number,
  ): Promise<TenantUsage> {
    const [entitlement, current, governance] = await Promise.all([
      this.readRecord(workspaceId, ENTITLEMENT_RECORD_KEY, readTenantEntitlement),
      this.readRecord(workspaceId, USAGE_RECORD_KEY, readTenantUsage),
      this.readRecord(workspaceId, GOVERNANCE_RECORD_KEY, readTenantGovernance),
    ])
    assertTenantFeatureEnabled(entitlement, feature)
    const updated = reserveTenantUsage(entitlement, current, additionalUnits, this.now())
    await this.putRecord(workspaceId, USAGE_RECORD_KEY, 'usage', updated, current.revision, {
      workspaceId,
      actorMemberKey: `meter:${feature}`,
      eventType: 'tenant.usage.reserved',
      entityId: workspaceId,
      action: 'reserved',
      path: '/internal/tenant/usage',
      idempotencyKey: `tenant-usage:${workspaceId}:${feature}:${updated.revision}`,
      before: current,
      after: updated,
      metadata: { feature, additionalUnits },
      retentionDays: governance.auditRetentionDays,
      legalHold: governance.legalHold,
      occurredAt: updated.updatedAt,
    })
    return updated
  }

  /** Creates a new export operation after enforcing one active operation per tenant. */
  async requestExport(
    workspaceId: string,
    actorMemberKey: string,
    input: RequestTenantExportInput,
  ): Promise<TenantOperation> {
    const snapshot = await this.ensureSnapshot(workspaceId, actorMemberKey)
    const operation = await this.createOperation(
      workspaceId,
      actorMemberKey,
      'export',
      input.format,
      snapshot.governance.auditRetentionDays,
      snapshot.governance.legalHold,
    )
    return operation
  }

  /** Creates a closure operation only after explicit confirmation and legal-hold checks. */
  async requestClosure(
    workspaceId: string,
    actorMemberKey: string,
    input: RequestTenantClosureInput,
  ): Promise<TenantOperation> {
    if (input.confirmation !== 'CLOSE') {
      throw new TenantAdministrationError(400, 'ClosureConfirmationRequired', 'Closure confirmation is required.')
    }
    const snapshot = await this.ensureSnapshot(workspaceId, actorMemberKey)
    if (snapshot.governance.legalHold) {
      throw new TenantAdministrationError(
        409,
        'TenantLegalHoldActive',
        'Tenant closure is blocked while legal hold is active.',
      )
    }
    return this.createOperation(
      workspaceId,
      actorMemberKey,
      'closure',
      undefined,
      snapshot.governance.auditRetentionDays,
      snapshot.governance.legalHold,
    )
  }

  /** Reads one operation and confirms that it belongs to the requested tenant. */
  async getOperation(workspaceId: string, operationId: string): Promise<TenantOperation> {
    let operation: TenantOperation
    try {
      operation = await this.readRecord(
        workspaceId,
        `${OPERATION_RECORD_PREFIX}${operationId}`,
        readTenantOperation,
      )
    } catch (error) {
      if (error instanceof TenantAdministrationError && error.code === 'TenantAdministrationNotInitialized') {
        throw new TenantAdministrationError(404, 'TenantOperationNotFound', 'Tenant operation was not found.')
      }
      throw error
    }
    if (operation.workspaceId !== workspaceId) {
      throw new TenantAdministrationError(404, 'TenantOperationNotFound', 'Tenant operation was not found.')
    }
    return operation
  }

  /** Advances one operation step and releases the tenant lock at terminal state. */
  async advanceOperation(
    workspaceId: string,
    actorMemberKey: string,
    operationId: string,
    proof: TenantOperationStepProof | undefined,
  ): Promise<TenantOperation> {
    return this.transitionOperation(workspaceId, actorMemberKey, operationId, (operation) =>
      advanceTenantOperation(operation, proof, this.now()))
  }

  /** Pauses one active operation. */
  async pauseOperation(
    workspaceId: string,
    actorMemberKey: string,
    operationId: string,
  ): Promise<TenantOperation> {
    return this.transitionOperation(workspaceId, actorMemberKey, operationId, (operation) =>
      pauseTenantOperation(operation, this.now()))
  }

  /** Resumes one paused operation. */
  async resumeOperation(
    workspaceId: string,
    actorMemberKey: string,
    operationId: string,
  ): Promise<TenantOperation> {
    return this.transitionOperation(workspaceId, actorMemberKey, operationId, (operation) =>
      resumeTenantOperation(operation, this.now()))
  }

  /** Verifies one completed closure and seals the terminal result. */
  async verifyClosure(
    workspaceId: string,
    actorMemberKey: string,
    operationId: string,
  ): Promise<TenantOperation> {
    return this.transitionOperation(workspaceId, actorMemberKey, operationId, (operation) =>
      verifyTenantClosure(operation, this.now()))
  }

  /** Reads the active operation by querying only the tenant partition. */
  private async readActiveOperation(workspaceId: string): Promise<TenantOperation | undefined> {
    let response
    try {
      response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: {
          ':workspaceId': workspaceId,
          ':prefix': OPERATION_RECORD_PREFIX,
        },
        ConsistentRead: true,
        ScanIndexForward: false,
        Limit: 25,
      }))
    } catch (error) {
      throw toTenantPersistenceError(error)
    }
    const rawItems: unknown = response.Items
    if (!Array.isArray(rawItems)) return undefined
    for (const rawItem of rawItems) {
      if (!isRecord(rawItem) || typeof rawItem.payload !== 'string') continue
      const operation = readTenantOperation(parsePayload(rawItem.payload))
      if (isTenantOperationActive(operation.status)) return operation
    }
    return undefined
  }

  /** Creates an operation and an active-operation lock in one transaction. */
  private async createOperation(
    workspaceId: string,
    actorMemberKey: string,
    kind: 'export' | 'closure',
    format?: 'jsonl' | 'csv',
    retentionDays = 2_555,
    legalHold = false,
  ): Promise<TenantOperation> {
    if (await this.readActiveOperation(workspaceId)) {
      throw new TenantAdministrationError(
        409,
        'TenantOperationAlreadyActive',
        'Another tenant operation is already active.',
      )
    }
    const operationId = randomUUID()
    const now = this.now()
    const operation: TenantOperation = {
      operationId,
      workspaceId,
      kind,
      status: 'requested',
      requestedBy: actorMemberKey,
      requestedAt: now,
      updatedAt: now,
      updatedBy: actorMemberKey,
      completedSteps: [],
      ...(format ? { exportFormat: format } : {}),
      revision: 0,
    }
    const auditPut = this.createAuditPut({
      workspaceId,
      actorMemberKey,
      eventType: kind === 'export' ? 'tenant.export.requested' : 'tenant.closure.requested',
      entityId: operationId,
      action: 'requested',
      path: kind === 'export' ? '/api/tenant/exports' : '/api/tenant/closures',
      idempotencyKey: `tenant-operation-request:${workspaceId}:${operationId}`,
      metadata: { kind, operationId },
      retentionDays,
      legalHold,
      occurredAt: now,
    })
    const items: TenantTransactionItem[] = [
      {
        Put: {
          TableName: this.tableName,
          Item: createStateItem(workspaceId, `${OPERATION_RECORD_PREFIX}${operationId}`, 'operation', operation),
          ConditionExpression: 'attribute_not_exists(recordKey)',
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: {
            workspaceId,
            recordKey: ACTIVE_OPERATION_RECORD_KEY,
            operationId,
            kind,
          },
          ConditionExpression: 'attribute_not_exists(recordKey)',
        },
      },
      ...(auditPut ? [auditPut] : []),
    ]
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: items,
      }))
    } catch (error) {
      if (isConditionalFailure(error)) {
        throw new TenantAdministrationError(
          409,
          'TenantOperationAlreadyActive',
          'Another tenant operation is already active.',
        )
      }
      throw toTenantPersistenceError(error)
    }
    return operation
  }

  /** Applies a state transition under the operation revision condition. */
  private async transitionOperation(
    workspaceId: string,
    actorMemberKey: string,
    operationId: string,
    transition: (operation: TenantOperation) => TenantOperation,
  ): Promise<TenantOperation> {
    const current = await this.getOperation(workspaceId, operationId)
    const governance = await this.readRecord(workspaceId, GOVERNANCE_RECORD_KEY, readTenantGovernance)
    const transitioned = transition(current)
    const operation: TenantOperation = {
      ...transitioned,
      updatedBy: actorMemberKey,
    }
    const items: TenantTransactionItem[] = [{
      Put: {
        TableName: this.tableName,
        Item: createStateItem(workspaceId, `${OPERATION_RECORD_PREFIX}${operationId}`, 'operation', operation),
        ConditionExpression: 'revision = :expectedRevision',
        ExpressionAttributeValues: { ':expectedRevision': current.revision },
      },
    }]
    if (!isTenantOperationActive(operation.status)) {
      items.push({
        Delete: {
          TableName: this.tableName,
          Key: { workspaceId, recordKey: ACTIVE_OPERATION_RECORD_KEY },
          ConditionExpression: 'operationId = :operationId',
          ExpressionAttributeValues: { ':operationId': operationId },
        },
      })
    }
    const auditPut = this.createAuditPut({
      workspaceId,
      actorMemberKey,
      eventType: operation.status === 'verified'
        ? 'tenant.closure.verified'
        : `tenant.${operation.kind}.${operation.status}`,
      entityId: operation.operationId,
      action: operation.status,
      path: `/internal/tenant/operations/${operation.operationId}`,
      idempotencyKey: `tenant-operation-transition:${workspaceId}:${operation.operationId}:${operation.revision}`,
      before: current,
      after: operation,
      metadata: {
        kind: operation.kind,
        status: operation.status,
        ...(operation.lastEvidenceReference
          ? { evidenceReference: operation.lastEvidenceReference }
          : {}),
      },
      retentionDays: governance.auditRetentionDays,
      legalHold: governance.legalHold,
      occurredAt: operation.updatedAt,
    })
    if (auditPut) items.push(auditPut)
    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: items }))
    } catch (error) {
      if (isConditionalFailure(error)) throw revisionConflict('TenantOperationRevisionConflict')
      throw toTenantPersistenceError(error)
    }
    return operation
  }

  /** Reads one tenant record and validates its serialized payload. */
  private async readRecord<T>(
    workspaceId: string,
    recordKey: string,
    parser: (value: unknown) => T,
  ): Promise<T> {
    let response
    try {
      response = await this.documentClient.send(new GetCommand({
        TableName: this.tableName,
        Key: { workspaceId, recordKey },
        ConsistentRead: true,
      }))
    } catch (error) {
      throw toTenantPersistenceError(error)
    }
    const item: unknown = response.Item
    if (!isRecord(item) || typeof item.payload !== 'string') {
      throw new TenantAdministrationError(
        404,
        'TenantAdministrationNotInitialized',
        'Tenant administration state is not initialized.',
      )
    }
    try {
      return parser(parsePayload(item.payload))
    } catch (error) {
      if (error instanceof TenantAdministrationError) throw error
      throw new TenantAdministrationError(
        503,
        'TenantAdministrationCorrupt',
        'Tenant administration state is invalid.',
      )
    }
  }

  /** Writes one tenant record and uses a revision condition for updates. */
  private async putRecord<T extends object>(
    workspaceId: string,
    recordKey: string,
    kind: string,
    value: T,
    expectedRevision: number,
    audit?: TenantAdministrationAuditEvent,
  ): Promise<void> {
    const auditPut = audit ? this.createAuditPut(audit) : undefined
    const items: TenantTransactionItem[] = [{
      Put: {
        TableName: this.tableName,
        Item: createStateItem(workspaceId, recordKey, kind, value),
        ConditionExpression: 'revision = :expectedRevision',
        ExpressionAttributeValues: { ':expectedRevision': expectedRevision },
      },
    }]
    if (auditPut) items.push(auditPut)
    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: items }))
    } catch (error) {
      if (isConditionalFailure(error)) throw revisionConflict('TenantRevisionConflict')
      throw toTenantPersistenceError(error)
    }
  }

  /** Creates a conditional audit event Put for a tenant mutation. */
  private createAuditPut(input: TenantAdministrationAuditEvent): TenantTransactionItem | undefined {
    return this.auditWriter?.createTransactionItem(input)
  }
}

function createPutTransactionItem<T extends object>(
  tableName: string,
  workspaceId: string,
  recordKey: string,
  kind: string,
  value: T,
): TenantTransactionItem {
  return {
    Put: {
      TableName: tableName,
      Item: createStateItem(workspaceId, recordKey, kind, value),
      ConditionExpression: 'attribute_not_exists(recordKey)',
    },
  }
}

function createStateItem<T extends object>(
  workspaceId: string,
  recordKey: string,
  kind: string,
  value: T,
): Record<string, unknown> {
  const revision = 'revision' in value && typeof value.revision === 'number'
    ? value.revision
    : 0
  const updatedAt = 'updatedAt' in value && typeof value.updatedAt === 'string'
    ? value.updatedAt
    : new Date(0).toISOString()
  return {
    workspaceId,
    recordKey,
    kind,
    revision,
    updatedAt,
    payload: JSON.stringify(value),
  }
}

function parsePayload(payload: string): unknown {
  return JSON.parse(payload)
}

function readTenantProfile(value: unknown): TenantProfile {
  if (!isRecord(value)) throw new Error('invalid profile')
  const policy = readTenantDefaultPolicy(value.defaultPolicy)
  const workspaceId = readRequiredString(value.workspaceId)
  const ownerMemberKey = readRequiredString(value.ownerMemberKey)
  const createdAt = readRequiredString(value.createdAt)
  const updatedAt = readRequiredString(value.updatedAt)
  return {
    workspaceId,
    ownerMemberKey,
    region: validateTenantRegion(value.region),
    locale: validateTenantLocale(value.locale),
    defaultPolicy: policy,
    revision: readRevision(value.revision),
    createdAt,
    updatedAt,
  }
}

function readTenantDefaultPolicy(value: unknown): TenantDefaultPolicy {
  if (!isRecord(value)) throw new Error('invalid policy')
  const defaultMemberRole = value.defaultMemberRole === 'member' || value.defaultMemberRole === 'guest'
    ? value.defaultMemberRole
    : undefined
  if (defaultMemberRole === undefined) throw new Error('invalid member role')
  return {
    allowExternalCollaborators: validateTenantBoolean(value.allowExternalCollaborators, 'InvalidTenantPolicy'),
    requireMfa: validateTenantBoolean(value.requireMfa, 'InvalidTenantPolicy'),
    defaultMemberRole,
  }
}

function readTenantEntitlement(value: unknown): TenantEntitlement {
  if (!isRecord(value)) throw new Error('invalid entitlement')
  return {
    workspaceId: readRequiredString(value.workspaceId),
    plan: validateTenantPlan(value.plan),
    features: validateTenantFeatures(value.features),
    seatLimit: validateTenantInteger(value.seatLimit, 1_000_000, 'InvalidTenantSeatLimit'),
    usageQuota: validateTenantInteger(value.usageQuota, 1_000_000_000, 'InvalidTenantUsageQuota'),
    gracePeriodDays: validateTenantInteger(value.gracePeriodDays, 90, 'InvalidTenantGracePeriod'),
    revision: readRevision(value.revision),
    updatedAt: readRequiredString(value.updatedAt),
  }
}

function readTenantUsage(value: unknown): TenantUsage {
  if (!isRecord(value)) throw new Error('invalid usage')
  const gracePeriodEndsAt = value.gracePeriodEndsAt === undefined
    ? undefined
    : readRequiredString(value.gracePeriodEndsAt)
  return {
    workspaceId: readRequiredString(value.workspaceId),
    activeSeats: validateTenantInteger(value.activeSeats, 1_000_000, 'InvalidTenantActiveSeats'),
    periodUsage: validateTenantInteger(value.periodUsage, 1_000_000_000, 'InvalidTenantPeriodUsage'),
    periodStart: readRequiredString(value.periodStart),
    periodEnd: readRequiredString(value.periodEnd),
    ...(gracePeriodEndsAt ? { gracePeriodEndsAt } : {}),
    revision: readRevision(value.revision),
    updatedAt: readRequiredString(value.updatedAt),
  }
}

function readTenantGovernance(value: unknown): TenantGovernancePolicy {
  if (!isRecord(value)) throw new Error('invalid governance')
  return {
    workspaceId: readRequiredString(value.workspaceId),
    auditRetentionDays: validateTenantInteger(value.auditRetentionDays, 2_555, 'InvalidAuditRetentionDays'),
    legalHold: validateTenantBoolean(value.legalHold, 'InvalidLegalHold'),
    dataResidency: validateTenantRegion(value.dataResidency),
    encryptionKeyPolicy: readEncryptionKeyPolicy(value.encryptionKeyPolicy),
    revision: readRevision(value.revision),
    updatedAt: readRequiredString(value.updatedAt),
    updatedBy: readRequiredString(value.updatedBy),
  }
}

function readTenantOperation(value: unknown): TenantOperation {
  if (!isRecord(value)) throw new Error('invalid operation')
  const kind = value.kind === 'export' || value.kind === 'closure' ? value.kind : undefined
  const status = value.status === 'requested' || value.status === 'running' || value.status === 'paused' ||
    value.status === 'completed' || value.status === 'failed' || value.status === 'verified'
    ? value.status
    : undefined
  if (kind === undefined || status === undefined || !Array.isArray(value.completedSteps)) {
    throw new Error('invalid operation state')
  }
  const completedSteps = value.completedSteps.filter(isTenantStep)
  if (completedSteps.length !== value.completedSteps.length) throw new Error('invalid operation steps')
  const currentStep = value.currentStep === undefined
    ? undefined
    : isTenantStep(value.currentStep) ? value.currentStep : undefined
  if (value.currentStep !== undefined && currentStep === undefined) throw new Error('invalid current step')
  return {
    operationId: readRequiredString(value.operationId),
    workspaceId: readRequiredString(value.workspaceId),
    kind,
    status,
    requestedBy: readRequiredString(value.requestedBy),
    requestedAt: readRequiredString(value.requestedAt),
    updatedAt: readRequiredString(value.updatedAt),
    updatedBy: readRequiredString(value.updatedBy),
    ...(currentStep ? { currentStep } : {}),
    completedSteps,
    ...(typeof value.lastEvidenceReference === 'string' && value.lastEvidenceReference.trim()
      ? { lastEvidenceReference: value.lastEvidenceReference }
      : {}),
    ...(typeof value.failureCode === 'string' ? { failureCode: value.failureCode } : {}),
    ...(value.exportFormat === 'jsonl' || value.exportFormat === 'csv' ? { exportFormat: value.exportFormat } : {}),
    revision: readRevision(value.revision),
  }
}

function isTenantStep(value: unknown): value is TenantExportStep | TenantClosureStep {
  return typeof value === 'string' && (
    TENANT_EXPORT_STEPS.some((step) => step === value) ||
    TENANT_CLOSURE_STEPS.some((step) => step === value)
  )
}

function readEncryptionKeyPolicy(value: unknown): 'aws-managed' | 'customer-managed' {
  if (value === 'aws-managed' || value === 'customer-managed') return value
  throw new TenantAdministrationError(400, 'InvalidEncryptionKeyPolicy', 'Encryption key policy is invalid.')
}

function readRequiredString(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value
  throw new Error('required string missing')
}

function readRevision(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  throw new Error('revision missing')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isConditionalFailure(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'ConditionalCheckFailedException' ||
    error.name === 'TransactionCanceledException'
  )
}

function revisionConflict(code: string): TenantAdministrationError {
  return new TenantAdministrationError(409, code, 'Tenant state was changed by another request.')
}

function toTenantPersistenceError(error: unknown): TenantAdministrationError {
  if (error instanceof TenantAdministrationError) return error
  return new TenantAdministrationError(
    503,
    'TenantAdministrationUnavailable',
    'Tenant administration state is unavailable.',
  )
}
