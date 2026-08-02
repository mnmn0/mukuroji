import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import { createHash, randomUUID } from 'node:crypto'
import type {
  RequestTenantClosureInput,
  RequestTenantExportInput,
  TenantAdministrationSnapshot,
  TenantBillingPeriod,
  TenantClosureStep,
  TenantDefaultPolicy,
  TenantEntitlement,
  TenantExportStep,
  TenantGovernanceEnforcement,
  TenantGovernancePolicy,
  TenantOperation,
  TenantOperationStepProof,
  TenantProfile,
  TenantRetentionReconciliation,
  TenantUsage,
  UpdateTenantEntitlementInput,
  UpdateTenantGovernanceInput,
  UpdateTenantProfileInput,
} from '@mukuroji/contracts'
import type { TenantFeature } from '@mukuroji/contracts'
import { calculateAuditExpiresAt } from '../../../audit'
import {
  TENANT_CLOSURE_STEPS,
  TENANT_EXPORT_STEPS,
  DEFAULT_TENANT_GOVERNANCE_ENFORCEMENT,
  TenantAdministrationError,
  advanceTenantOperation,
  assertTenantActive,
  assertTenantFeatureEnabled,
  assertTenantGovernanceEnforced,
  assertTenantSeatAvailable,
  beginTenantUsageMutation,
  createDefaultTenantAdministrationSnapshot,
  failTenantOperation,
  isTenantOperationActive,
  pauseTenantOperation,
  recordTenantBillingPeriod,
  reserveTenantUsage,
  resumeTenantOperation,
  validateTenantBoolean,
  validateTenantFeatures,
  validateTenantGovernanceEnforcement,
  validateTenantInteger,
  validateTenantLocale,
  validateTenantPlan,
  validateTenantRegion,
  verifyTenantClosure,
} from '../../domain/tenant-administration'
import type {
  TenantAdministrationAuditEvent,
  TenantAdministrationAuditWriter,
  TenantAuditRetentionProcessor,
  TenantAdministrationClient,
  TenantSeatMeter,
  TenantSeatMutationInput,
} from '../../application/ports/tenant-administration-port'
import { createTenantDeletedMemberAlias } from '../../application/tenant-operation-resource-owner'

/** DynamoDB transaction item used by tenant administration mutations. */
type TenantTransactionItem = NonNullable<
  TransactWriteCommandInput['TransactItems']
>[number]

/** Optional governance conditions applied to a lifecycle state transition. */
type TenantOperationTransitionOptions = {
  /** Blocks a closure transition and detects concurrent legal-hold changes. */
  requireInactiveLegalHold?: boolean
  /** Leaves a requested operation pending instead of retrying while legal hold is active. */
  returnCurrentOnLegalHold?: boolean
  /** Recognizes a safely replayed transition before applying another mutation. */
  acceptReplay?: (operation: TenantOperation) => boolean
  /** Seals the tenant profile when a completed closure is verified. */
  closeTenant?: boolean
}

/** Durable, expiring receipt for one metered request reservation. */
type TenantUsageReceipt = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Commercial feature whose usage was reserved. */
  feature: TenantFeature
  /** Number of units reserved by the request. */
  additionalUnits: number
  /** Fingerprint that binds the key to its metering payload. */
  requestFingerprint: string
  /** Usage revision committed with this receipt. */
  usageRevision: number
  /** Receipt creation timestamp. */
  createdAt: string
  /** DynamoDB TTL epoch seconds. */
  expiresAt: number
}

/** Parsed metering idempotency scope and request binding. */
type TenantUsageIdempotency = {
  /** Stable input used to derive the durable receipt key. */
  receiptKeyInput: string
  /** Optional request digest used to reject key reuse with another payload. */
  requestBinding?: string
}

const PROFILE_RECORD_KEY = 'PROFILE'
const ENTITLEMENT_RECORD_KEY = 'ENTITLEMENT'
const USAGE_RECORD_KEY = 'USAGE'
const GOVERNANCE_RECORD_KEY = 'GOVERNANCE'
const ACTIVE_OPERATION_RECORD_KEY = 'ACTIVE_OPERATION'
const BILLING_PERIOD_RECORD_PREFIX = 'BILLING#'
const OPERATION_RECORD_PREFIX = 'OPERATION#'
const OPERATION_HISTORY_RECORD_PREFIX = 'OPERATION_HISTORY#'
const USAGE_RECEIPT_RECORD_PREFIX = 'USAGE_RECEIPT#'
const RETENTION_JOB_RECORD_KEY = 'RETENTION_JOB'
const RETENTION_RECONCILIATION_PAGE_SIZE = 22
const USAGE_RECEIPT_RETENTION_SECONDS = 35 * 24 * 60 * 60
const TENANT_METERING_IDEMPOTENCY_PATTERN =
  /^tenant-meter:v1:([a-f0-9]{64}):([a-f0-9]{64})$/u

/**
 * DynamoDB-backed tenant administration state and workflow adapter.
 */
export class DynamoDbTenantAdministrationClient implements
  TenantAdministrationClient,
  TenantSeatMeter<TenantTransactionItem>,
  TenantAuditRetentionProcessor {
  /** DynamoDB table containing tenant control-plane records. */
  private readonly tableName: string
  /** Document client used for strongly consistent tenant reads. */
  private readonly documentClient: DynamoDBDocumentClient
  /** Clock injected for deterministic tests and operation timestamps. */
  private readonly now: () => string
  /** Optional append-only audit transaction builder. */
  private readonly auditWriter?: TenantAdministrationAuditWriter<TenantTransactionItem>
  /** Residency and key controls implemented by the deployed data plane. */
  private readonly governanceEnforcement: TenantGovernanceEnforcement
  /** Append-only audit table whose TTL attributes are reconciled. */
  private readonly auditTableName?: string
  /** Workspace membership table used to remove the final closure verifier. */
  private readonly workspaceAccessTableName?: string

  /**
   * Creates a tenant administration adapter.
   *
   * @param tableName - Tenant administration table name.
   * @param documentClient - DynamoDB document client.
   * @param now - Timestamp supplier.
   * @param auditWriter - Optional append-only audit transaction builder.
   * @param governanceEnforcement - Residency and key controls implemented by the deployment.
   * @param auditTableName - Optional audit table used by the retention worker.
   * @param workspaceAccessTableName - Workspace membership table sealed by closure verification.
   */
  constructor(
    tableName: string,
    documentClient: DynamoDBDocumentClient,
    now: () => string = () => new Date().toISOString(),
    auditWriter?: TenantAdministrationAuditWriter<TenantTransactionItem>,
    governanceEnforcement: TenantGovernanceEnforcement = DEFAULT_TENANT_GOVERNANCE_ENFORCEMENT,
    auditTableName?: string,
    workspaceAccessTableName?: string,
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
    this.governanceEnforcement = validateTenantGovernanceEnforcement(governanceEnforcement)
    this.auditTableName = auditTableName?.trim() || undefined
    this.workspaceAccessTableName = workspaceAccessTableName?.trim() || undefined
  }

  /** Ensures tenant aggregate and initial retention records exist before returning them. */
  async ensureSnapshot(
    workspaceId: string,
    ownerMemberKey: string,
    activeSeats = 1,
  ): Promise<TenantAdministrationSnapshot> {
    try {
      const snapshot = await this.getSnapshot(workspaceId)
      if (
        snapshot.profile.status !== 'active' ||
        snapshot.profile.ownerMemberKey === ownerMemberKey
      ) return snapshot
      return await this.reconcileAuthoritativeOwner(snapshot, ownerMemberKey)
    } catch (error) {
      if (!(error instanceof TenantAdministrationError) || error.code !== 'TenantAdministrationNotInitialized') {
        throw error
      }
    }

    const now = this.now()
    const snapshot = createDefaultTenantAdministrationSnapshot(
      workspaceId,
      ownerMemberKey,
      now,
      this.governanceEnforcement,
      activeSeats,
    )
    try {
      const retentionJob: TenantRetentionReconciliation | undefined =
        this.auditTableName && this.auditWriter
          ? {
              workspaceId,
              governanceRevision: snapshot.governance.revision,
              status: 'pending',
              retentionDays: snapshot.governance.auditRetentionDays,
              legalHold: snapshot.governance.legalHold,
              processedEvents: 0,
              revision: 0,
              updatedAt: now,
              updatedBy: ownerMemberKey,
            }
          : undefined
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          createPutTransactionItem(this.tableName, workspaceId, PROFILE_RECORD_KEY, 'profile', snapshot.profile),
          createPutTransactionItem(this.tableName, workspaceId, ENTITLEMENT_RECORD_KEY, 'entitlement', snapshot.entitlement),
          createPutTransactionItem(this.tableName, workspaceId, USAGE_RECORD_KEY, 'usage', snapshot.usage),
          createPutTransactionItem(
            this.tableName,
            workspaceId,
            createBillingPeriodRecordKey(snapshot.usage.periodStart),
            'billing-period',
            recordTenantBillingPeriod(snapshot.usage),
          ),
          createPutTransactionItem(this.tableName, workspaceId, GOVERNANCE_RECORD_KEY, 'governance', snapshot.governance),
          ...(retentionJob
            ? [{
                Put: {
                  TableName: this.tableName,
                  Item: createRetentionJobStateItem(retentionJob),
                  ConditionExpression: 'attribute_not_exists(recordKey)',
                },
              }]
            : []),
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
    const [
      activeOperation,
      recentOperations,
      retentionReconciliation,
      storedBillingPeriods,
    ] = await Promise.all([
      this.readActiveOperation(workspaceId),
      this.readRecentOperations(workspaceId),
      this.readOptionalRecord(
        workspaceId,
        RETENTION_JOB_RECORD_KEY,
        readTenantRetentionReconciliation,
      ),
      this.readBillingPeriods(workspaceId),
    ])
    const billingPeriods = storedBillingPeriods.length > 0
      ? storedBillingPeriods
      : [recordTenantBillingPeriod(usage)]
    return {
      schemaVersion: 2,
      profile,
      entitlement,
      usage,
      billingPeriods,
      governance,
      governanceEnforcement: this.governanceEnforcement,
      recentOperations,
      ...(retentionReconciliation ? { retentionReconciliation } : {}),
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
    assertTenantActive(current)
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
    assertTenantGovernanceEnforced(
      updated.region,
      governance.encryptionKeyPolicy,
      this.governanceEnforcement,
    )
    await this.putRecord(
      workspaceId,
      PROFILE_RECORD_KEY,
      'profile',
      updated,
      current.revision,
      {
        workspaceId,
        actorMemberKey,
        eventType: 'tenant.profile.updated',
        entityId: workspaceId,
        action: 'updated',
        path: '/api/tenant/profile',
        requestMethod: 'PATCH',
        idempotencyKey: `tenant-profile:${workspaceId}:${updated.revision}`,
        before: current,
        after: updated,
        metadata: { kind: 'tenant-profile' },
        retentionDays: governance.auditRetentionDays,
        legalHold: governance.legalHold,
        occurredAt: updated.updatedAt,
      },
      governance.revision,
    )
    return updated
  }

  /** Updates entitlement state while preserving the current usage boundary. */
  async updateEntitlement(
    workspaceId: string,
    actorMemberKey: string,
    input: UpdateTenantEntitlementInput,
  ): Promise<TenantEntitlement> {
    const [current, usage, governance, profile] = await Promise.all([
      this.readRecord(workspaceId, ENTITLEMENT_RECORD_KEY, readTenantEntitlement),
      this.readRecord(workspaceId, USAGE_RECORD_KEY, readTenantUsage),
      this.readRecord(workspaceId, GOVERNANCE_RECORD_KEY, readTenantGovernance),
      this.readRecord(workspaceId, PROFILE_RECORD_KEY, readTenantProfile),
    ])
    assertTenantActive(profile)
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
    const auditPut = this.createAuditPut({
      workspaceId,
      actorMemberKey,
      eventType: 'tenant.entitlement.updated',
      entityId: workspaceId,
      action: 'updated',
      path: '/api/tenant/entitlement',
      requestMethod: 'PATCH',
      idempotencyKey: `tenant-entitlement:${workspaceId}:${updated.revision}`,
      before: current,
      after: updated,
      metadata: { kind: 'tenant-entitlement' },
      retentionDays: governance.auditRetentionDays,
      legalHold: governance.legalHold,
      occurredAt: updated.updatedAt,
    })
    const items: TenantTransactionItem[] = [
      {
        Put: {
          TableName: this.tableName,
          Item: createStateItem(
            workspaceId,
            ENTITLEMENT_RECORD_KEY,
            'entitlement',
            updated,
          ),
          ConditionExpression: 'revision = :expectedRevision',
          ExpressionAttributeValues: { ':expectedRevision': current.revision },
        },
      },
      createRevisionConditionCheck(
        this.tableName,
        workspaceId,
        USAGE_RECORD_KEY,
        usage.revision,
      ),
      createRevisionConditionCheck(
        this.tableName,
        workspaceId,
        GOVERNANCE_RECORD_KEY,
        governance.revision,
      ),
      createRevisionConditionCheck(
        this.tableName,
        workspaceId,
        PROFILE_RECORD_KEY,
        profile.revision,
      ),
    ]
    if (auditPut) items.push(auditPut)
    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: items }))
    } catch (error) {
      if (isConditionalFailure(error)) {
        throw revisionConflict('TenantEntitlementRevisionConflict')
      }
      throw toTenantPersistenceError(error)
    }
    return updated
  }

  /** Updates governance policy and rejects unsafe retention or residency values. */
  async updateGovernance(
    workspaceId: string,
    actorMemberKey: string,
    input: UpdateTenantGovernanceInput,
  ): Promise<TenantGovernancePolicy> {
    const [current, currentRetentionJob, profile] = await Promise.all([
      this.readRecord(workspaceId, GOVERNANCE_RECORD_KEY, readTenantGovernance),
      this.readOptionalRecord(
        workspaceId,
        RETENTION_JOB_RECORD_KEY,
        readTenantRetentionReconciliation,
      ),
      this.readRecord(workspaceId, PROFILE_RECORD_KEY, readTenantProfile),
    ])
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
    assertTenantGovernanceEnforced(
      updated.dataResidency,
      updated.encryptionKeyPolicy,
      this.governanceEnforcement,
    )
    if (updated.auditRetentionDays < 30) {
      throw new TenantAdministrationError(
        400,
        'InvalidAuditRetentionDays',
        'Audit retention must be at least 30 days.',
      )
    }
    if (profile.status === 'closed') {
      assertTenantActive(profile)
    }
    if (
      profile.status === 'closing' &&
      (
        updated.auditRetentionDays !== current.auditRetentionDays ||
        updated.dataResidency !== current.dataResidency ||
        updated.encryptionKeyPolicy !== current.encryptionKeyPolicy
      )
    ) {
      throw new TenantAdministrationError(
        409,
        'TenantGovernanceLockedDuringClosure',
        'Only legal hold can be changed while tenant closure is active.',
      )
    }
    const auditEvent: TenantAdministrationAuditEvent = {
      workspaceId,
      actorMemberKey,
      eventType: 'tenant.governance.updated',
      entityId: workspaceId,
      action: 'updated',
      path: '/api/tenant/governance',
      requestMethod: 'PATCH',
      idempotencyKey: `tenant-governance:${workspaceId}:${updated.revision}`,
      before: current,
      after: updated,
      metadata: { kind: 'tenant-governance' },
      retentionDays: updated.auditRetentionDays,
      legalHold: updated.legalHold,
      occurredAt: updated.updatedAt,
    }
    const retentionChanged = current.auditRetentionDays !== updated.auditRetentionDays ||
      current.legalHold !== updated.legalHold
    if (!retentionChanged) {
      await this.putRecord(
        workspaceId,
        GOVERNANCE_RECORD_KEY,
        'governance',
        updated,
        current.revision,
        auditEvent,
        undefined,
        profile.revision,
      )
      return updated
    }
    if (!this.auditTableName) {
      throw new TenantAdministrationError(
        503,
        'TenantRetentionReconciliationUnavailable',
        'Tenant audit retention reconciliation is unavailable.',
      )
    }
    if (
      currentRetentionJob?.status === 'pending' ||
      currentRetentionJob?.status === 'running'
    ) {
      throw new TenantAdministrationError(
        409,
        'TenantRetentionReconciliationActive',
        'A tenant audit retention reconciliation is already active.',
      )
    }
    const retentionJob: TenantRetentionReconciliation = {
      workspaceId,
      governanceRevision: updated.revision,
      status: 'pending',
      retentionDays: updated.auditRetentionDays,
      legalHold: updated.legalHold,
      processedEvents: 0,
      revision: 0,
      updatedAt: updated.updatedAt,
      updatedBy: actorMemberKey,
    }
    const items: TenantTransactionItem[] = [
      {
        Put: {
          TableName: this.tableName,
          Item: createStateItem(
            workspaceId,
            GOVERNANCE_RECORD_KEY,
            'governance',
            updated,
          ),
          ConditionExpression: 'revision = :expectedRevision',
          ExpressionAttributeValues: { ':expectedRevision': current.revision },
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: createRetentionJobStateItem(retentionJob),
          ConditionExpression:
            'attribute_not_exists(recordKey) OR #status = :completed',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':completed': 'completed' },
        },
      },
      createRevisionConditionCheck(
        this.tableName,
        workspaceId,
        PROFILE_RECORD_KEY,
        profile.revision,
      ),
    ]
    const auditPut = this.createAuditPut(auditEvent)
    if (auditPut) items.push(auditPut)
    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: items }))
    } catch (error) {
      if (isConditionalFailure(error)) {
        throw revisionConflict('TenantGovernanceRevisionConflict')
      }
      throw toTenantPersistenceError(error)
    }
    return updated
  }

  /** Rejects normal access after a verified tenant closure. */
  async assertActive(workspaceId: string): Promise<void> {
    const profile = await this.readOptionalRecord(
      workspaceId,
      PROFILE_RECORD_KEY,
      readTenantProfile,
    )
    if (profile) assertTenantActive(profile)
  }

  /**
   * Creates a cross-table transaction guard that linearizes tenant-owned writes
   * against account closure.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @returns A DynamoDB condition check that accepts active or legacy-uninitialized tenants.
   */
  createActiveWriteCondition(workspaceId: string): TenantTransactionItem {
    return {
      ConditionCheck: {
        TableName: this.tableName,
        Key: { workspaceId, recordKey: PROFILE_RECORD_KEY },
        ConditionExpression:
          'attribute_not_exists(recordKey) OR ' +
          '(#kind = :profileKind AND ' +
          '(attribute_not_exists(lifecycleStatus) OR lifecycleStatus = :active))',
        ExpressionAttributeNames: { '#kind': 'kind' },
        ExpressionAttributeValues: {
          ':active': 'active',
          ':profileKind': 'profile',
        },
      },
    }
  }

  /** Checks one feature against the current strongly consistent entitlement. */
  async assertFeature(workspaceId: string, feature: TenantFeature): Promise<void> {
    await this.assertActive(workspaceId)
    const entitlement = await this.readRecord(
      workspaceId,
      ENTITLEMENT_RECORD_KEY,
      readTenantEntitlement,
    )
    assertTenantFeatureEnabled(entitlement, feature)
  }

  /**
   * Prepares a seat counter mutation for the same transaction as membership state.
   *
   * @param input - Authoritative membership transition being metered.
   * @returns Conditional tenant usage and audit transaction items.
   */
  async prepareSeatMutation(
    input: TenantSeatMutationInput,
  ): Promise<readonly TenantTransactionItem[]> {
    const [entitlement, current, governance, profile] = await Promise.all([
      this.readRecord(input.workspaceId, ENTITLEMENT_RECORD_KEY, readTenantEntitlement),
      this.readRecord(input.workspaceId, USAGE_RECORD_KEY, readTenantUsage),
      this.readRecord(input.workspaceId, GOVERNANCE_RECORD_KEY, readTenantGovernance),
      this.readRecord(input.workspaceId, PROFILE_RECORD_KEY, readTenantProfile),
    ])
    assertTenantActive(profile)
    if (input.direction === 'activate') {
      assertTenantSeatAvailable(entitlement, current)
    } else if (current.activeSeats === 0) {
      throw new TenantAdministrationError(
        503,
        'TenantSeatCounterCorrupt',
        'Tenant seat state is inconsistent with active membership.',
      )
    }
    const periodUsage = beginTenantUsageMutation(
      current,
      input.occurredAt,
    )
    const activeSeats = input.direction === 'activate'
      ? periodUsage.activeSeats + 1
      : periodUsage.activeSeats - 1
    const updated: TenantUsage = {
      ...periodUsage,
      activeSeats,
      updatedAt: input.occurredAt,
    }
    const currentBillingPeriod = await this.readOptionalRecord(
      input.workspaceId,
      createBillingPeriodRecordKey(updated.periodStart),
      readTenantBillingPeriod,
    )
    const billingPeriod = recordTenantBillingPeriod(updated, currentBillingPeriod)
    const items: TenantTransactionItem[] = []
    if (input.direction === 'activate') {
      items.push(createRevisionConditionCheck(
        this.tableName,
        input.workspaceId,
        ENTITLEMENT_RECORD_KEY,
        entitlement.revision,
      ))
    }
    items.push({
      Put: {
        TableName: this.tableName,
        Item: createStateItem(input.workspaceId, USAGE_RECORD_KEY, 'usage', updated),
        ConditionExpression: 'revision = :expectedRevision',
        ExpressionAttributeValues: { ':expectedRevision': current.revision },
      },
    }, createBillingPeriodTransactionItem(
      this.tableName,
      input.workspaceId,
      billingPeriod,
      currentBillingPeriod,
    ), createRevisionConditionCheck(
      this.tableName,
      input.workspaceId,
      GOVERNANCE_RECORD_KEY,
      governance.revision,
    ), createRevisionConditionCheck(
      this.tableName,
      input.workspaceId,
      PROFILE_RECORD_KEY,
      profile.revision,
    ))
    const auditPut = this.createAuditPut({
      workspaceId: input.workspaceId,
      actorMemberKey: 'meter:seat',
      eventType: input.direction === 'activate'
        ? 'tenant.seat.assigned'
        : 'tenant.seat.released',
      entityId: input.workspaceId,
      privateMemberKey: input.memberKey,
      action: input.direction === 'activate' ? 'assigned' : 'released',
      path: '/internal/tenant/seats',
      requestMethod: 'INTERNAL',
      idempotencyKey:
        `tenant-seat:${input.workspaceId}:${input.memberKey}:${input.direction}:${updated.revision}`,
      before: current,
      after: updated,
      metadata: {
        direction: input.direction,
      },
      retentionDays: governance.auditRetentionDays,
      legalHold: governance.legalHold,
      occurredAt: input.occurredAt,
    })
    if (auditPut) items.push(auditPut)
    return items
  }

  /**
   * Applies one bounded, resumable page of audit TTL reconciliation.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @returns Updated durable progress, or undefined when no job exists.
   */
  async reconcileAuditRetention(
    workspaceId: string,
  ): Promise<TenantRetentionReconciliation | undefined> {
    const current = await this.readOptionalRecord(
      workspaceId,
      RETENTION_JOB_RECORD_KEY,
      readTenantRetentionReconciliation,
    )
    if (!current || current.status === 'completed') return current
    if (!this.auditTableName || !this.auditWriter) {
      throw new TenantAdministrationError(
        503,
        'TenantRetentionReconciliationUnavailable',
        'Tenant audit retention reconciliation is unavailable.',
      )
    }
    let response
    try {
      response = await this.documentClient.send(new QueryCommand({
        TableName: this.auditTableName,
        KeyConditionExpression: 'directoryId = :workspaceId',
        ExpressionAttributeValues: { ':workspaceId': workspaceId },
        ...(current.cursorEventId
          ? {
              ExclusiveStartKey: {
                directoryId: workspaceId,
                eventId: current.cursorEventId,
              },
            }
          : {}),
        ConsistentRead: true,
        Limit: RETENTION_RECONCILIATION_PAGE_SIZE,
      }))
    } catch (error) {
      throw toTenantPersistenceError(error)
    }
    const auditEvents = readAuditRetentionItems(response.Items)
    const cursorEventId = readAuditCursorEventId(
      response.LastEvaluatedKey,
      workspaceId,
    )
    const now = this.now()
    const updated: TenantRetentionReconciliation = {
      ...current,
      status: cursorEventId ? 'running' : 'completed',
      processedEvents: current.processedEvents + auditEvents.length,
      ...(cursorEventId ? { cursorEventId } : { cursorEventId: undefined }),
      revision: current.revision + 1,
      updatedAt: now,
      updatedBy: 'executor:tenant-retention',
    }
    const items: TenantTransactionItem[] = auditEvents.map((event) => ({
      Update: {
        TableName: this.auditTableName,
        Key: { directoryId: workspaceId, eventId: event.eventId },
        UpdateExpression: current.legalHold
          ? 'REMOVE expiresAt'
          : 'SET expiresAt = :expiresAt',
        ConditionExpression: 'attribute_exists(eventId)',
        ...(current.legalHold
          ? {}
          : {
              ExpressionAttributeValues: {
                ':expiresAt': calculateAuditExpiresAt(
                  event.occurredAt,
                  current.retentionDays,
                ),
              },
            }),
      },
    }))
    items.push({
      Put: {
        TableName: this.tableName,
        Item: createRetentionJobStateItem(updated),
        ConditionExpression: 'revision = :expectedRevision',
        ExpressionAttributeValues: { ':expectedRevision': current.revision },
      },
    })
    const auditPut = this.createAuditPut({
      workspaceId,
      actorMemberKey: 'executor:tenant-retention',
      eventType: updated.status === 'completed'
        ? 'tenant.retention.completed'
        : 'tenant.retention.progressed',
      entityId: workspaceId,
      action: updated.status,
      path: '/internal/tenant/retention',
      requestMethod: 'INTERNAL',
      idempotencyKey:
        `tenant-retention:${workspaceId}:${updated.governanceRevision}:${updated.revision}`,
      before: current,
      after: updated,
      metadata: {
        governanceRevision: updated.governanceRevision,
        legalHold: updated.legalHold,
        processedEvents: updated.processedEvents,
        status: updated.status,
      },
      retentionDays: updated.retentionDays,
      legalHold: updated.legalHold,
      occurredAt: now,
    })
    if (auditPut) items.push(auditPut)
    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: items }))
    } catch (error) {
      if (isConditionalFailure(error)) {
        throw revisionConflict('TenantRetentionReconciliationConflict')
      }
      throw toTenantPersistenceError(error)
    }
    return updated
  }

  /** Applies the current governance policy to one newly inserted audit event. */
  async reconcileAuditEventRetention(
    workspaceId: string,
    eventId: string,
    occurredAt: string,
  ): Promise<void> {
    let governance: TenantGovernancePolicy
    try {
      governance = await this.readRecord(
        workspaceId,
        GOVERNANCE_RECORD_KEY,
        readTenantGovernance,
      )
    } catch (error) {
      if (
        error instanceof TenantAdministrationError &&
        error.code === 'TenantAdministrationNotInitialized'
      ) {
        return
      }
      throw error
    }
    if (!this.auditTableName) {
      throw new TenantAdministrationError(
        503,
        'TenantRetentionReconciliationUnavailable',
        'Tenant audit retention reconciliation is unavailable.',
      )
    }
    const auditUpdate: TenantTransactionItem = {
      Update: {
        TableName: this.auditTableName,
        Key: { directoryId: workspaceId, eventId },
        UpdateExpression: governance.legalHold
          ? 'REMOVE expiresAt'
          : 'SET expiresAt = :expiresAt',
        ConditionExpression:
          'attribute_exists(eventId) AND occurredAt = :occurredAt',
        ExpressionAttributeValues: {
          ':occurredAt': occurredAt,
          ...(governance.legalHold
            ? {}
            : {
                ':expiresAt': calculateAuditExpiresAt(
                  occurredAt,
                  governance.auditRetentionDays,
                ),
              }),
        },
      },
    }
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          createRevisionConditionCheck(
            this.tableName,
            workspaceId,
            GOVERNANCE_RECORD_KEY,
            governance.revision,
          ),
          auditUpdate,
        ],
      }))
    } catch (error) {
      if (isConditionalFailure(error)) {
        throw revisionConflict('TenantAuditRetentionConflict')
      }
      throw toTenantPersistenceError(error)
    }
  }

  /**
   * Applies a feature and quota check before atomically persisting metered usage.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param feature - Commercial feature being metered.
   * @param additionalUnits - Number of usage units to reserve.
   * @param idempotencyKey - Optional request key used to replay a committed reservation.
   * @returns Current-period usage after the reservation or a matching replay.
   */
  async reserveUsage(
    workspaceId: string,
    feature: TenantFeature,
    additionalUnits: number,
    idempotencyKey?: string,
  ): Promise<TenantUsage> {
    const now = this.now()
    const currentEpochSeconds = toEpochSeconds(now)
    const meteringIdempotency = readTenantUsageIdempotency(idempotencyKey)
    const receiptRecordKey = meteringIdempotency
      ? createUsageReceiptRecordKey(
          workspaceId,
          feature,
          meteringIdempotency.receiptKeyInput,
        )
      : undefined
    const requestFingerprint = createUsageRequestFingerprint(
      feature,
      additionalUnits,
      meteringIdempotency?.requestBinding,
    )
    const [
      entitlement,
      current,
      governance,
      profile,
      existingReceipt,
    ] = await Promise.all([
      this.readRecord(workspaceId, ENTITLEMENT_RECORD_KEY, readTenantEntitlement),
      this.readRecord(workspaceId, USAGE_RECORD_KEY, readTenantUsage),
      this.readRecord(workspaceId, GOVERNANCE_RECORD_KEY, readTenantGovernance),
      this.readRecord(workspaceId, PROFILE_RECORD_KEY, readTenantProfile),
      receiptRecordKey
        ? this.readOptionalRecord(
            workspaceId,
            receiptRecordKey,
            readTenantUsageReceipt,
          )
        : Promise.resolve(undefined),
    ])
    assertTenantActive(profile)
    assertTenantFeatureEnabled(entitlement, feature)
    if (existingReceipt && existingReceipt.expiresAt > currentEpochSeconds) {
      assertTenantUsageReceipt(
        existingReceipt,
        workspaceId,
        feature,
        additionalUnits,
        requestFingerprint,
        current,
      )
      return current
    }
    const updated = reserveTenantUsage(entitlement, current, additionalUnits, now)
    const currentBillingPeriod = await this.readOptionalRecord(
      workspaceId,
      createBillingPeriodRecordKey(updated.periodStart),
      readTenantBillingPeriod,
    )
    const billingPeriod = recordTenantBillingPeriod(updated, currentBillingPeriod)
    const auditPut = this.createAuditPut({
      workspaceId,
      actorMemberKey: `meter:${feature}`,
      eventType: 'tenant.usage.reserved',
      entityId: workspaceId,
      action: 'reserved',
      path: '/internal/tenant/usage',
      requestMethod: 'INTERNAL',
      idempotencyKey: `tenant-usage:${workspaceId}:${feature}:${updated.revision}`,
      before: current,
      after: updated,
      metadata: { feature, additionalUnits },
      retentionDays: governance.auditRetentionDays,
      legalHold: governance.legalHold,
      occurredAt: updated.updatedAt,
    })
    const items: TenantTransactionItem[] = [
      createRevisionConditionCheck(
        this.tableName,
        workspaceId,
        ENTITLEMENT_RECORD_KEY,
        entitlement.revision,
      ),
      createRevisionConditionCheck(
        this.tableName,
        workspaceId,
        GOVERNANCE_RECORD_KEY,
        governance.revision,
      ),
      createRevisionConditionCheck(
        this.tableName,
        workspaceId,
        PROFILE_RECORD_KEY,
        profile.revision,
      ),
      {
        Put: {
          TableName: this.tableName,
          Item: createStateItem(workspaceId, USAGE_RECORD_KEY, 'usage', updated),
          ConditionExpression: 'revision = :expectedRevision',
          ExpressionAttributeValues: { ':expectedRevision': current.revision },
        },
      },
      createBillingPeriodTransactionItem(
      this.tableName,
      workspaceId,
      billingPeriod,
      currentBillingPeriod,
      ),
    ]
    if (receiptRecordKey) {
      const receipt: TenantUsageReceipt = {
        workspaceId,
        feature,
        additionalUnits,
        requestFingerprint,
        usageRevision: updated.revision,
        createdAt: now,
        expiresAt: toTenantReceiptExpiry(now),
      }
      items.push({
        Put: {
          TableName: this.tableName,
          Item: createUsageReceiptStateItem(receiptRecordKey, receipt),
          ConditionExpression:
            'attribute_not_exists(recordKey) OR expiresAt <= :currentEpochSeconds',
          ExpressionAttributeValues: {
            ':currentEpochSeconds': currentEpochSeconds,
          },
        },
      })
    }
    if (auditPut) items.push(auditPut)
    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: items }))
    } catch (error) {
      if (isConditionalFailure(error)) {
        if (receiptRecordKey) {
          const [replayedReceipt, replayedUsage] = await Promise.all([
            this.readOptionalRecord(
              workspaceId,
              receiptRecordKey,
              readTenantUsageReceipt,
            ),
            this.readRecord(workspaceId, USAGE_RECORD_KEY, readTenantUsage),
          ])
          if (replayedReceipt && replayedReceipt.expiresAt > currentEpochSeconds) {
            assertTenantUsageReceipt(
              replayedReceipt,
              workspaceId,
              feature,
              additionalUnits,
              requestFingerprint,
              replayedUsage,
            )
            return replayedUsage
          }
        }
        throw revisionConflict('TenantUsageRevisionConflict')
      }
      throw toTenantPersistenceError(error)
    }
    return updated
  }

  /** Creates a new export operation after enforcing one active operation per tenant. */
  async requestExport(
    workspaceId: string,
    actorMemberKey: string,
    input: RequestTenantExportInput,
    idempotencyKey?: string,
  ): Promise<TenantOperation> {
    const snapshot = await this.getSnapshot(workspaceId)
    assertTenantActive(snapshot.profile)
    const operation = await this.createOperation(
      workspaceId,
      actorMemberKey,
      'export',
      snapshot.profile,
      input.format,
      snapshot.governance.auditRetentionDays,
      snapshot.governance.legalHold,
      snapshot.governance.revision,
      snapshot.profile.revision,
      idempotencyKey,
    )
    return operation
  }

  /** Creates a closure operation only after explicit confirmation and legal-hold checks. */
  async requestClosure(
    workspaceId: string,
    actorMemberKey: string,
    input: RequestTenantClosureInput,
    idempotencyKey?: string,
  ): Promise<TenantOperation> {
    if (input.confirmation !== 'CLOSE') {
      throw new TenantAdministrationError(400, 'ClosureConfirmationRequired', 'Closure confirmation is required.')
    }
    const snapshot = await this.getSnapshot(workspaceId)
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
      snapshot.profile,
      undefined,
      snapshot.governance.auditRetentionDays,
      snapshot.governance.legalHold,
      snapshot.governance.revision,
      snapshot.profile.revision,
      idempotencyKey,
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

  /**
   * Rechecks pause and legal-hold state immediately before one resource-owner page.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param operationId - Durable tenant operation identifier.
   * @returns Whether the current operation may still perform side effects.
   */
  async isOperationExecutionAllowed(
    workspaceId: string,
    operationId: string,
  ): Promise<boolean> {
    const [operation, governance] = await Promise.all([
      this.getOperation(workspaceId, operationId),
      this.readRecord(
        workspaceId,
        GOVERNANCE_RECORD_KEY,
        readTenantGovernance,
      ),
    ])
    return operation.status === 'running' &&
      operation.currentStep !== undefined &&
      (operation.kind !== 'closure' || !governance.legalHold)
  }

  /** Advances one operation step and releases the tenant lock at terminal state. */
  async advanceOperation(
    workspaceId: string,
    actorMemberKey: string,
    operationId: string,
    proof: TenantOperationStepProof | undefined,
  ): Promise<TenantOperation> {
    return this.transitionOperation(
      workspaceId,
      actorMemberKey,
      operationId,
      (operation) => advanceTenantOperation(operation, proof, this.now()),
      {
        requireInactiveLegalHold: true,
        returnCurrentOnLegalHold: true,
        acceptReplay: (operation) => proof !== undefined &&
          operation.completedSteps.includes(proof.step) &&
          operation.lastEvidenceReference === proof.evidenceReference.trim(),
      },
    )
  }

  /** Records a safe terminal failure from the current step capability. */
  async failOperation(
    workspaceId: string,
    actorMemberKey: string,
    operationId: string,
    failureCode: string,
  ): Promise<TenantOperation> {
    return this.transitionOperation(
      workspaceId,
      actorMemberKey,
      operationId,
      (operation) => failTenantOperation(operation, failureCode, this.now()),
      {
        acceptReplay: (operation) => operation.status === 'failed' &&
          operation.failureCode === failureCode.trim() &&
          operation.updatedBy === actorMemberKey,
      },
    )
  }

  /** Pauses one active operation. */
  async pauseOperation(
    workspaceId: string,
    actorMemberKey: string,
    operationId: string,
  ): Promise<TenantOperation> {
    return this.transitionOperation(
      workspaceId,
      actorMemberKey,
      operationId,
      (operation) => pauseTenantOperation(operation, this.now()),
      {
        acceptReplay: (operation) => operation.status === 'paused' &&
          operation.updatedBy === actorMemberKey,
      },
    )
  }

  /** Starts one held requested operation or resumes one paused operation. */
  async resumeOperation(
    workspaceId: string,
    actorMemberKey: string,
    operationId: string,
  ): Promise<TenantOperation> {
    return this.transitionOperation(
      workspaceId,
      actorMemberKey,
      operationId,
      (operation) => resumeTenantOperation(operation, this.now()),
      {
        requireInactiveLegalHold: true,
        acceptReplay: (operation) => operation.status === 'running' &&
          operation.updatedBy === actorMemberKey,
      },
    )
  }

  /** Verifies one completed closure and seals the terminal result. */
  async verifyClosure(
    workspaceId: string,
    actorMemberKey: string,
    operationId: string,
  ): Promise<TenantOperation> {
    return this.transitionOperation(
      workspaceId,
      actorMemberKey,
      operationId,
      (operation) => verifyTenantClosure(operation, this.now()),
      {
        acceptReplay: (operation) => operation.status === 'verified' &&
          operation.updatedBy === actorMemberKey,
        closeTenant: true,
        requireInactiveLegalHold: true,
      },
    )
  }

  /** Reads the operation referenced by the tenant's single-operation lock. */
  private async readActiveOperation(workspaceId: string): Promise<TenantOperation | undefined> {
    let response
    try {
      response = await this.documentClient.send(new GetCommand({
        TableName: this.tableName,
        Key: { workspaceId, recordKey: ACTIVE_OPERATION_RECORD_KEY },
        ConsistentRead: true,
      }))
    } catch (error) {
      throw toTenantPersistenceError(error)
    }
    const lock: unknown = response.Item
    if (lock === undefined) return undefined
    if (
      !isRecord(lock) ||
      lock.workspaceId !== workspaceId ||
      lock.recordKey !== ACTIVE_OPERATION_RECORD_KEY ||
      typeof lock.operationId !== 'string' ||
      (lock.kind !== 'export' && lock.kind !== 'closure')
    ) {
      throw tenantAdministrationCorrupt(
        'Tenant active-operation lock is invalid.',
      )
    }
    let operation: TenantOperation
    try {
      operation = await this.getOperation(workspaceId, lock.operationId)
    } catch (error) {
      if (
        error instanceof TenantAdministrationError &&
        error.code === 'TenantOperationNotFound'
      ) {
        throw tenantAdministrationCorrupt(
          'Tenant active-operation lock references a missing operation.',
        )
      }
      throw error
    }
    if (
      operation.kind !== lock.kind ||
      !doesTenantOperationOwnActiveLock(operation)
    ) {
      throw tenantAdministrationCorrupt(
        'Tenant active-operation lock does not match operation state.',
      )
    }
    return operation
  }

  /** Reads the newest invoice-ready tenant billing periods. */
  private async readBillingPeriods(workspaceId: string): Promise<TenantBillingPeriod[]> {
    let response
    try {
      response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: {
          ':workspaceId': workspaceId,
          ':prefix': BILLING_PERIOD_RECORD_PREFIX,
        },
        ConsistentRead: true,
        ScanIndexForward: false,
        Limit: 13,
      }))
    } catch (error) {
      throw toTenantPersistenceError(error)
    }
    const rawItems: unknown = response.Items
    if (rawItems === undefined) return []
    if (!Array.isArray(rawItems)) {
      throw new TenantAdministrationError(
        503,
        'TenantAdministrationCorrupt',
        'Tenant billing history is invalid.',
      )
    }
    return rawItems.map((rawItem) => {
      if (
        !isRecord(rawItem) ||
        typeof rawItem.recordKey !== 'string' ||
        !rawItem.recordKey.startsWith(BILLING_PERIOD_RECORD_PREFIX)
      ) {
        throw tenantAdministrationCorrupt(
          'Tenant billing history key is invalid.',
        )
      }
      const billingPeriod = this.parseStateItem(
        rawItem,
        workspaceId,
        rawItem.recordKey,
        readTenantBillingPeriod,
      )
      if (
        rawItem.recordKey !== createBillingPeriodRecordKey(
          billingPeriod.periodStart,
        )
      ) {
        throw tenantAdministrationCorrupt(
          'Tenant billing history period is inconsistent.',
        )
      }
      return billingPeriod
    })
  }

  /** Reads the newest lifecycle operation snapshots for result inspection. */
  private async readRecentOperations(workspaceId: string): Promise<TenantOperation[]> {
    let response
    try {
      response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression:
          'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: {
          ':workspaceId': workspaceId,
          ':prefix': OPERATION_HISTORY_RECORD_PREFIX,
        },
        ConsistentRead: true,
        ScanIndexForward: false,
        Limit: 10,
      }))
    } catch (error) {
      throw toTenantPersistenceError(error)
    }
    const rawItems: unknown = response.Items
    if (rawItems === undefined) return []
    if (!Array.isArray(rawItems)) {
      throw tenantAdministrationCorrupt('Tenant operation history is invalid.')
    }
    return rawItems.map((rawItem) => {
      if (
        !isRecord(rawItem) ||
        typeof rawItem.recordKey !== 'string' ||
        !rawItem.recordKey.startsWith(OPERATION_HISTORY_RECORD_PREFIX)
      ) {
        throw tenantAdministrationCorrupt(
          'Tenant operation history key is invalid.',
        )
      }
      const operation = this.parseStateItem(
        rawItem,
        workspaceId,
        rawItem.recordKey,
        readTenantOperation,
      )
      if (rawItem.recordKey !== createOperationHistoryRecordKey(operation)) {
        throw tenantAdministrationCorrupt(
          'Tenant operation history entry is inconsistent.',
        )
      }
      return operation
    })
  }

  /** Creates an operation and an active-operation lock in one transaction. */
  private async createOperation(
    workspaceId: string,
    actorMemberKey: string,
    kind: 'export' | 'closure',
    profile: TenantProfile,
    format?: 'jsonl' | 'csv',
    retentionDays = 2_555,
    legalHold = false,
    governanceRevision = 0,
    profileRevision = profile.revision,
    idempotencyKey?: string,
  ): Promise<TenantOperation> {
    const normalizedIdempotencyKey = readOptionalTenantIdempotencyKey(idempotencyKey)
    const operationId = normalizedIdempotencyKey
      ? createTenantOperationId(
          workspaceId,
          actorMemberKey,
          kind,
          normalizedIdempotencyKey,
        )
      : randomUUID()
    if (normalizedIdempotencyKey) {
      const replay = await this.readOptionalRecord(
        workspaceId,
        `${OPERATION_RECORD_PREFIX}${operationId}`,
        readTenantOperation,
      )
      if (replay) {
        assertTenantOperationReplay(replay, actorMemberKey, kind, format)
        return replay
      }
    }
    assertTenantActive(profile)
    if (await this.readActiveOperation(workspaceId)) {
      throw new TenantAdministrationError(
        409,
        'TenantOperationAlreadyActive',
        'Another tenant operation is already active.',
      )
    }
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
    const closingProfile: TenantProfile | undefined = kind === 'closure'
      ? {
          ...profile,
          status: 'closing',
          revision: profile.revision + 1,
          updatedAt: now,
        }
      : undefined
    const auditPut = this.createAuditPut({
      workspaceId,
      actorMemberKey,
      eventType: kind === 'export' ? 'tenant.export.requested' : 'tenant.closure.requested',
      entityId: operationId,
      action: 'requested',
      path: kind === 'export' ? '/api/tenant/exports' : '/api/tenant/closures',
      requestMethod: 'POST',
      idempotencyKey: `tenant-operation-request:${workspaceId}:${operationId}`,
      metadata: { kind, operationId },
      retentionDays,
      legalHold,
      occurredAt: now,
    })
    const profileAuditPut = closingProfile
      ? this.createAuditPut({
          workspaceId,
          actorMemberKey,
          eventType: 'tenant.profile.closing',
          entityId: workspaceId,
          action: 'closing',
          path: '/api/tenant/closures',
          requestMethod: 'POST',
          idempotencyKey:
            `tenant-profile-closing:${workspaceId}:${operationId}:${closingProfile.revision}`,
          before: profile,
          after: closingProfile,
          metadata: { operationId },
          retentionDays,
          legalHold,
          occurredAt: now,
        })
      : undefined
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
          Item: createStateItem(
            workspaceId,
            createOperationHistoryRecordKey(operation),
            'operation-history',
            operation,
          ),
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
      {
        ConditionCheck: {
          TableName: this.tableName,
          Key: { workspaceId, recordKey: GOVERNANCE_RECORD_KEY },
          ConditionExpression: 'revision = :expectedGovernanceRevision',
          ExpressionAttributeValues: {
            ':expectedGovernanceRevision': governanceRevision,
          },
        },
      },
      closingProfile
        ? {
            Put: {
              TableName: this.tableName,
              Item: createStateItem(
                workspaceId,
                PROFILE_RECORD_KEY,
                'profile',
                closingProfile,
              ),
              ConditionExpression: 'revision = :expectedProfileRevision',
              ExpressionAttributeValues: {
                ':expectedProfileRevision': profileRevision,
              },
            },
          }
        : createRevisionConditionCheck(
            this.tableName,
            workspaceId,
            PROFILE_RECORD_KEY,
            profileRevision,
          ),
      ...(auditPut ? [auditPut] : []),
      ...(profileAuditPut ? [profileAuditPut] : []),
    ]
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: items,
      }))
    } catch (error) {
      if (isConditionalFailure(error)) {
        if (normalizedIdempotencyKey) {
          const replay = await this.readOptionalRecord(
            workspaceId,
            `${OPERATION_RECORD_PREFIX}${operationId}`,
            readTenantOperation,
          )
          if (replay) {
            assertTenantOperationReplay(replay, actorMemberKey, kind, format)
            return replay
          }
        }
        throw new TenantAdministrationError(
          409,
          'TenantOperationConflict',
          'Tenant operation state or governance changed concurrently.',
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
    options: TenantOperationTransitionOptions = {},
  ): Promise<TenantOperation> {
    const current = await this.getOperation(workspaceId, operationId)
    if (options.acceptReplay?.(current)) return current
    const [governance, profile] = await Promise.all([
      this.readRecord(workspaceId, GOVERNANCE_RECORD_KEY, readTenantGovernance),
      this.readRecord(workspaceId, PROFILE_RECORD_KEY, readTenantProfile),
    ])
    if (current.kind === 'closure') {
      if (profile.status !== 'closing') {
        throw tenantAdministrationCorrupt(
          'Tenant closure operation does not match profile lifecycle state.',
        )
      }
    } else {
      assertTenantActive(profile)
    }
    if (
      options.requireInactiveLegalHold &&
      current.kind === 'closure' &&
      governance.legalHold
    ) {
      if (options.returnCurrentOnLegalHold) return current
      throw new TenantAdministrationError(
        409,
        'TenantLegalHoldActive',
        'Tenant closure is blocked while legal hold is active.',
      )
    }
    const transitioned = transition(current)
    const closesTenant = options.closeTenant && transitioned.status === 'verified'
    const closureRequesterAlias = closesTenant
      ? createTenantDeletedMemberAlias(
          workspaceId,
          operationId,
          current.requestedBy,
        )
      : undefined
    const operation: TenantOperation = {
      ...transitioned,
      ...(closureRequesterAlias
        ? {
            requestedBy: closureRequesterAlias,
            updatedBy: closureRequesterAlias,
          }
        : { updatedBy: actorMemberKey }),
    }
    const closedProfile: TenantProfile | undefined = closesTenant
      ? {
          ...profile,
          ownerMemberKey: createTenantDeletedMemberAlias(
            workspaceId,
            operationId,
            profile.ownerMemberKey,
          ),
          status: 'closed',
          closedAt: operation.updatedAt,
          closedByOperationId: operation.operationId,
          revision: profile.revision + 1,
          updatedAt: operation.updatedAt,
        }
      : undefined
    const reopenedProfile: TenantProfile | undefined =
      current.kind === 'closure' && operation.status === 'failed'
        ? {
            ...profile,
            status: 'active',
            revision: profile.revision + 1,
            updatedAt: operation.updatedAt,
          }
        : undefined
    const transitionedProfile = closedProfile ?? reopenedProfile
    const items: TenantTransactionItem[] = [
      {
        Put: {
          TableName: this.tableName,
          Item: createStateItem(workspaceId, `${OPERATION_RECORD_PREFIX}${operationId}`, 'operation', operation),
          ConditionExpression: 'revision = :expectedRevision',
          ExpressionAttributeValues: { ':expectedRevision': current.revision },
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: createStateItem(
            workspaceId,
            createOperationHistoryRecordKey(operation),
            'operation-history',
            operation,
          ),
          ConditionExpression: 'revision = :expectedRevision',
          ExpressionAttributeValues: { ':expectedRevision': current.revision },
        },
      },
    ]
    items.push(createRevisionConditionCheck(
      this.tableName,
      workspaceId,
      GOVERNANCE_RECORD_KEY,
      governance.revision,
    ))
    items.push(transitionedProfile
      ? {
          Put: {
            TableName: this.tableName,
            Item: createStateItem(
              workspaceId,
              PROFILE_RECORD_KEY,
              'profile',
              transitionedProfile,
            ),
            ConditionExpression: 'revision = :expectedRevision',
            ExpressionAttributeValues: { ':expectedRevision': profile.revision },
          },
        }
      : createRevisionConditionCheck(
          this.tableName,
          workspaceId,
          PROFILE_RECORD_KEY,
          profile.revision,
        ))
    if (!doesTenantOperationOwnActiveLock(operation)) {
      items.push({
        Delete: {
          TableName: this.tableName,
          Key: { workspaceId, recordKey: ACTIVE_OPERATION_RECORD_KEY },
          ConditionExpression: 'operationId = :operationId',
          ExpressionAttributeValues: { ':operationId': operationId },
        },
      })
    }
    if (closedProfile) {
      if (!this.workspaceAccessTableName) {
        throw new TenantAdministrationError(
          503,
          'TenantClosureVerificationUnavailable',
          'Tenant closure verification cannot seal Workspace access.',
        )
      }
      const requesterMemberKey = normalizeClosureMemberKey(current.requestedBy)
      items.push({
        Delete: {
          TableName: this.workspaceAccessTableName,
          Key: {
            workspaceId,
            recordKey: `MEMBER#${requesterMemberKey}`,
          },
          ConditionExpression: 'memberKey = :requesterMemberKey',
          ExpressionAttributeValues: {
            ':requesterMemberKey': requesterMemberKey,
          },
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
      requestMethod: 'INTERNAL',
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
    if (transitionedProfile) {
      const profileAction = closedProfile ? 'closed' : 'reopened'
      const profileAuditPut = this.createAuditPut({
        workspaceId,
        actorMemberKey,
        eventType: `tenant.profile.${profileAction}`,
        entityId: workspaceId,
        action: profileAction,
        path: `/internal/tenant/operations/${operation.operationId}`,
        requestMethod: 'INTERNAL',
        idempotencyKey:
          `tenant-profile-${profileAction}:${workspaceId}:${operation.operationId}:${transitionedProfile.revision}`,
        before: profile,
        after: transitionedProfile,
        metadata: { operationId: operation.operationId },
        retentionDays: governance.auditRetentionDays,
        legalHold: governance.legalHold,
        occurredAt: operation.updatedAt,
      })
      if (profileAuditPut) items.push(profileAuditPut)
    }
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
    if (item === undefined) {
      throw new TenantAdministrationError(
        404,
        'TenantAdministrationNotInitialized',
        'Tenant administration state is not initialized.',
      )
    }
    return this.parseStateItem(item, workspaceId, recordKey, parser)
  }

  /** Reads an optional tenant record and validates its serialized payload. */
  private async readOptionalRecord<T>(
    workspaceId: string,
    recordKey: string,
    parser: (value: unknown) => T,
  ): Promise<T | undefined> {
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
    if (item === undefined) return undefined
    return this.parseStateItem(item, workspaceId, recordKey, parser)
  }

  /**
   * Validates physical and serialized tenant scope before returning one state value.
   *
   * @param item - Untrusted DynamoDB item returned by the document client.
   * @param workspaceId - Canonical tenant partition requested by the caller.
   * @param recordKey - Canonical tenant record key requested by the caller.
   * @param parser - Runtime parser for the serialized payload.
   * @returns Parsed state that matches its physical tenant key and revision.
   */
  private parseStateItem<T>(
    item: unknown,
    workspaceId: string,
    recordKey: string,
    parser: (value: unknown) => T,
  ): T {
    if (
      !isRecord(item) ||
      item.workspaceId !== workspaceId ||
      item.recordKey !== recordKey ||
      typeof item.payload !== 'string'
    ) {
      throw tenantAdministrationCorrupt(
        'Tenant administration state does not match its physical key.',
      )
    }
    let parsed: T
    try {
      parsed = parser(parsePayload(item.payload))
    } catch {
      throw tenantAdministrationCorrupt(
        'Tenant administration state payload is invalid.',
      )
    }
    if (
      isRecord(parsed) &&
      (
        ('workspaceId' in parsed && parsed.workspaceId !== workspaceId) ||
        (
          'revision' in parsed &&
          (
            typeof parsed.revision !== 'number' ||
            item.revision !== parsed.revision
          )
        )
      )
    ) {
      throw tenantAdministrationCorrupt(
        'Tenant administration payload scope or revision is inconsistent.',
      )
    }
    return parsed
  }

  /**
   * Reconciles profile ownership from authoritative Workspace membership.
   *
   * @param snapshot - Current tenant aggregate read before reconciliation.
   * @param ownerMemberKey - Current active Workspace owner member key.
   * @returns The aggregate with its reconciled profile.
   */
  private async reconcileAuthoritativeOwner(
    snapshot: TenantAdministrationSnapshot,
    ownerMemberKey: string,
  ): Promise<TenantAdministrationSnapshot> {
    const current = snapshot.profile
    const updated: TenantProfile = {
      ...current,
      ownerMemberKey,
      revision: current.revision + 1,
      updatedAt: this.now(),
    }
    await this.putRecord(
      current.workspaceId,
      PROFILE_RECORD_KEY,
      'profile',
      updated,
      current.revision,
      {
        workspaceId: current.workspaceId,
        actorMemberKey: 'system:workspace-owner-reconciliation',
        eventType: 'tenant.profile.owner-reconciled',
        entityId: current.workspaceId,
        action: 'reconciled',
        path: '/internal/tenant/profile/owner',
        requestMethod: 'INTERNAL',
        idempotencyKey:
          `tenant-profile-owner:${current.workspaceId}:${updated.revision}`,
        before: current,
        after: updated,
        metadata: { kind: 'tenant-profile-owner' },
        retentionDays: snapshot.governance.auditRetentionDays,
        legalHold: snapshot.governance.legalHold,
        occurredAt: updated.updatedAt,
      },
      snapshot.governance.revision,
    )
    return { ...snapshot, profile: updated }
  }

  /** Writes one tenant record and uses a revision condition for updates. */
  private async putRecord<T extends object>(
    workspaceId: string,
    recordKey: string,
    kind: string,
    value: T,
    expectedRevision: number,
    audit?: TenantAdministrationAuditEvent,
    governanceRevision?: number,
    profileRevision?: number,
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
    if (governanceRevision !== undefined) {
      items.push(createRevisionConditionCheck(
        this.tableName,
        workspaceId,
        GOVERNANCE_RECORD_KEY,
        governanceRevision,
      ))
    }
    if (profileRevision !== undefined) {
      items.push(createRevisionConditionCheck(
        this.tableName,
        workspaceId,
        PROFILE_RECORD_KEY,
        profileRevision,
      ))
    }
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

/**
 * Creates a conditional billing-period write that joins the authoritative usage mutation.
 *
 * @param tableName - Tenant administration table name.
 * @param workspaceId - Canonical Workspace identifier.
 * @param value - Updated invoice-ready period aggregate.
 * @param current - Existing period aggregate, when this is an update.
 * @returns One create-or-revision-checked transaction item.
 */
function createBillingPeriodTransactionItem(
  tableName: string,
  workspaceId: string,
  value: TenantBillingPeriod,
  current?: TenantBillingPeriod,
): TenantTransactionItem {
  return {
    Put: {
      TableName: tableName,
      Item: createStateItem(
        workspaceId,
        createBillingPeriodRecordKey(value.periodStart),
        'billing-period',
        value,
      ),
      ConditionExpression: current
        ? 'revision = :expectedRevision'
        : 'attribute_not_exists(recordKey)',
      ...(current
        ? { ExpressionAttributeValues: { ':expectedRevision': current.revision } }
        : {}),
    },
  }
}

/**
 * Creates a revision condition that serializes related aggregate mutations.
 *
 * @param tableName - Tenant administration table name.
 * @param workspaceId - Canonical Workspace identifier.
 * @param recordKey - Aggregate record whose revision must remain unchanged.
 * @param expectedRevision - Revision observed before preparing the mutation.
 * @returns One DynamoDB transaction condition check.
 */
function createRevisionConditionCheck(
  tableName: string,
  workspaceId: string,
  recordKey: string,
  expectedRevision: number,
): TenantTransactionItem {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { workspaceId, recordKey },
      ConditionExpression: 'revision = :expectedRevision',
      ExpressionAttributeValues: { ':expectedRevision': expectedRevision },
    },
  }
}

/** Creates the tenant-partition sort key for one UTC billing period. */
function createBillingPeriodRecordKey(periodStart: string): string {
  return `${BILLING_PERIOD_RECORD_PREFIX}${periodStart}`
}

/**
 * Creates a newest-first sortable history key for one tenant operation.
 *
 * @param operation - Durable operation whose request timestamp owns the key.
 * @returns Tenant-partition operation-history sort key.
 */
function createOperationHistoryRecordKey(operation: TenantOperation): string {
  return `${OPERATION_HISTORY_RECORD_PREFIX}${operation.requestedAt}#${operation.operationId}`
}

/**
 * Normalizes the retained closure requester to the Workspace membership key format.
 *
 * @param value - Requester identity stored on the closure operation.
 * @returns Lowercase member key used by Workspace access storage.
 */
function normalizeClosureMemberKey(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    throw tenantAdministrationCorrupt(
      'Tenant closure requester identity is invalid.',
    )
  }
  return normalized
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
  const lifecycleStatus = kind === 'profile' &&
      'status' in value &&
      (
        value.status === 'active' ||
        value.status === 'closing' ||
        value.status === 'closed'
      )
    ? value.status
    : undefined
  return {
    workspaceId,
    recordKey,
    kind,
    revision,
    updatedAt,
    payload: JSON.stringify(value),
    ...(lifecycleStatus ? { lifecycleStatus } : {}),
  }
}

/**
 * Creates an expiring, digest-keyed usage reservation receipt item.
 *
 * @param recordKey - Digest-derived receipt sort key.
 * @param receipt - Safe receipt payload that excludes the raw idempotency key.
 * @returns DynamoDB item with a top-level TTL attribute.
 */
function createUsageReceiptStateItem(
  recordKey: string,
  receipt: TenantUsageReceipt,
): Record<string, unknown> {
  return {
    ...createStateItem(
      receipt.workspaceId,
      recordKey,
      'usage-receipt',
      receipt,
    ),
    updatedAt: receipt.createdAt,
    expiresAt: receipt.expiresAt,
  }
}

/** Creates a retention job item with stream-filterable status metadata. */
function createRetentionJobStateItem(
  value: TenantRetentionReconciliation,
): Record<string, unknown> {
  return {
    ...createStateItem(
      value.workspaceId,
      RETENTION_JOB_RECORD_KEY,
      'retention-job',
      value,
    ),
    status: value.status,
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
  const status = value.status === undefined
    ? 'active'
    : value.status === 'active' ||
        value.status === 'closing' ||
        value.status === 'closed'
      ? value.status
      : undefined
  if (!status) throw new Error('invalid tenant status')
  const closedAt = value.closedAt === undefined
    ? undefined
    : readRequiredTimestamp(value.closedAt)
  const closedByOperationId = value.closedByOperationId === undefined
    ? undefined
    : readRequiredString(value.closedByOperationId)
  if (
    status === 'closed'
      ? !closedAt || !closedByOperationId
      : closedAt !== undefined || closedByOperationId !== undefined
  ) {
    throw new Error('invalid tenant closure state')
  }
  return {
    workspaceId,
    ownerMemberKey,
    region: validateTenantRegion(value.region),
    locale: validateTenantLocale(value.locale),
    defaultPolicy: policy,
    status,
    ...(closedAt ? { closedAt } : {}),
    ...(closedByOperationId ? { closedByOperationId } : {}),
    revision: readRevision(value.revision),
    createdAt,
    updatedAt,
  }
}

/** Parses one invoice-ready billing aggregate from durable state. */
function readTenantBillingPeriod(value: unknown): TenantBillingPeriod {
  if (!isRecord(value)) throw new Error('invalid billing period')
  return {
    workspaceId: readRequiredString(value.workspaceId),
    periodStart: readRequiredString(value.periodStart),
    periodEnd: readRequiredString(value.periodEnd),
    meteredUnits: validateTenantInteger(
      value.meteredUnits,
      1_000_000_000,
      'InvalidTenantBillingUsage',
    ),
    activeSeatHighWaterMark: validateTenantInteger(
      value.activeSeatHighWaterMark,
      1_000_000,
      'InvalidTenantBillingSeats',
    ),
    revision: readRevision(value.revision),
    updatedAt: readRequiredString(value.updatedAt),
  }
}

function readTenantDefaultPolicy(value: unknown): TenantDefaultPolicy {
  if (!isRecord(value)) throw new Error('invalid policy')
  const defaultMemberRole = value.defaultMemberRole === 'member' || value.defaultMemberRole === 'guest'
    ? value.defaultMemberRole
    : undefined
  if (defaultMemberRole === undefined) throw new Error('invalid member role')
  return {
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

/**
 * Parses one durable metering idempotency receipt.
 *
 * @param value - Serialized receipt payload.
 * @returns Validated receipt state.
 */
function readTenantUsageReceipt(value: unknown): TenantUsageReceipt {
  if (!isRecord(value)) throw new Error('invalid usage receipt')
  const requestFingerprint = readRequiredString(value.requestFingerprint)
  if (!/^[a-f0-9]{64}$/u.test(requestFingerprint)) {
    throw new Error('invalid usage receipt fingerprint')
  }
  return {
    workspaceId: readRequiredString(value.workspaceId),
    feature: readTenantFeature(value.feature),
    additionalUnits: validateTenantInteger(
      value.additionalUnits,
      1_000_000_000,
      'InvalidUsageUnits',
    ),
    requestFingerprint,
    usageRevision: readRevision(value.usageRevision),
    createdAt: readRequiredString(value.createdAt),
    expiresAt: validateTenantInteger(
      value.expiresAt,
      Number.MAX_SAFE_INTEGER,
      'InvalidTenantUsageReceiptExpiry',
    ),
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

/** Reads and validates one serialized audit-retention reconciliation job. */
function readTenantRetentionReconciliation(
  value: unknown,
): TenantRetentionReconciliation {
  if (!isRecord(value)) throw new Error('invalid retention reconciliation')
  const status = value.status === 'pending' ||
    value.status === 'running' ||
    value.status === 'completed'
    ? value.status
    : undefined
  if (!status) throw new Error('invalid retention reconciliation status')
  const cursorEventId = value.cursorEventId === undefined
    ? undefined
    : readRequiredString(value.cursorEventId)
  return {
    workspaceId: readRequiredString(value.workspaceId),
    governanceRevision: readRevision(value.governanceRevision),
    status,
    retentionDays: validateTenantInteger(
      value.retentionDays,
      2_555,
      'InvalidAuditRetentionDays',
    ),
    legalHold: validateTenantBoolean(value.legalHold, 'InvalidLegalHold'),
    processedEvents: validateTenantInteger(
      value.processedEvents,
      Number.MAX_SAFE_INTEGER,
      'InvalidTenantRetentionProgress',
    ),
    ...(cursorEventId ? { cursorEventId } : {}),
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
  const failureCode = typeof value.failureCode === 'string'
    ? value.failureCode.trim()
    : undefined
  const lastEvidenceReference = typeof value.lastEvidenceReference === 'string'
    ? value.lastEvidenceReference.trim()
    : undefined
  const operation: TenantOperation = {
    operationId: readRequiredString(value.operationId),
    workspaceId: readRequiredString(value.workspaceId),
    kind,
    status,
    requestedBy: readRequiredString(value.requestedBy),
    requestedAt: readRequiredTimestamp(value.requestedAt),
    updatedAt: readRequiredTimestamp(value.updatedAt),
    updatedBy: readRequiredString(value.updatedBy),
    ...(currentStep ? { currentStep } : {}),
    completedSteps,
    ...(lastEvidenceReference
      ? { lastEvidenceReference }
      : {}),
    ...(failureCode ? { failureCode } : {}),
    ...(value.exportFormat === 'jsonl' || value.exportFormat === 'csv' ? { exportFormat: value.exportFormat } : {}),
    revision: readRevision(value.revision),
  }
  assertTenantOperationState(operation)
  return operation
}

/**
 * Rejects durable lifecycle states that do not match their workflow prefix.
 *
 * @param operation - Parsed tenant operation candidate.
 */
function assertTenantOperationState(operation: TenantOperation): void {
  const steps = operation.kind === 'export'
    ? TENANT_EXPORT_STEPS
    : TENANT_CLOSURE_STEPS
  if (
    operation.completedSteps.length > steps.length ||
    operation.completedSteps.some((step, index) => step !== steps[index])
  ) {
    throw new Error('invalid completed operation prefix')
  }
  const expectedCurrentStep = steps[operation.completedSteps.length] ?? steps.at(-1)
  if (operation.status === 'requested') {
    if (
      operation.currentStep !== undefined ||
      operation.completedSteps.length !== 0 ||
      operation.lastEvidenceReference !== undefined
    ) {
      throw new Error('invalid requested operation state')
    }
  } else if (
    operation.status === 'running' ||
    operation.status === 'paused' ||
    operation.status === 'failed'
  ) {
    if (operation.currentStep !== expectedCurrentStep) {
      throw new Error('invalid active operation step')
    }
  } else if (
    operation.completedSteps.length !== steps.length ||
    operation.currentStep !== steps.at(-1)
  ) {
    throw new Error('invalid completed operation state')
  }
  if (
    (operation.completedSteps.length > 0) !==
      (operation.lastEvidenceReference !== undefined) ||
    (
      operation.lastEvidenceReference !== undefined &&
      !/^evidence:sha256:[a-f0-9]{64}$/u.test(operation.lastEvidenceReference)
    )
  ) {
    throw new Error('invalid operation evidence state')
  }
  if (
    operation.status === 'failed'
      ? !operation.failureCode || !/^[A-Z][A-Z0-9_]{2,63}$/u.test(operation.failureCode)
      : operation.failureCode !== undefined
  ) {
    throw new Error('invalid operation failure state')
  }
  if (
    operation.kind === 'export'
      ? operation.exportFormat !== 'jsonl' && operation.exportFormat !== 'csv'
      : operation.exportFormat !== undefined
  ) {
    throw new Error('invalid operation export format')
  }
  if (operation.status === 'verified' && operation.kind !== 'closure') {
    throw new Error('invalid verified operation kind')
  }
}

/**
 * Returns whether an operation must keep the tenant's single-operation lock.
 *
 * Completed closures retain the lock until an administrator verifies their
 * evidence-backed terminal result. Completed exports release it immediately.
 *
 * @param operation - Durable tenant operation state.
 * @returns Whether `ACTIVE_OPERATION` must still reference this operation.
 */
function doesTenantOperationOwnActiveLock(
  operation: TenantOperation,
): boolean {
  return isTenantOperationActive(operation.status) ||
    (operation.kind === 'closure' && operation.status === 'completed')
}

function isTenantStep(value: unknown): value is TenantExportStep | TenantClosureStep {
  return typeof value === 'string' && (
    TENANT_EXPORT_STEPS.some((step) => step === value) ||
    TENANT_CLOSURE_STEPS.some((step) => step === value)
  )
}

/** Minimal immutable audit fields needed to reconcile one TTL. */
type AuditRetentionItem = {
  /** Immutable audit event identifier. */
  eventId: string
  /** Event occurrence timestamp used to calculate retention expiry. */
  occurredAt: string
}

/** Validates the audit page returned for retention reconciliation. */
function readAuditRetentionItems(value: unknown): AuditRetentionItem[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new TenantAdministrationError(
      503,
      'TenantAuditRetentionPageInvalid',
      'Tenant audit retention page is invalid.',
    )
  }
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new TenantAdministrationError(
        503,
        'TenantAuditRetentionPageInvalid',
        'Tenant audit retention page is invalid.',
      )
    }
    return {
      eventId: readRequiredString(item.eventId),
      occurredAt: readRequiredString(item.occurredAt),
    }
  })
}

/** Reads a same-tenant LastEvaluatedKey without trusting the AWS response shape. */
function readAuditCursorEventId(
  value: unknown,
  workspaceId: string,
): string | undefined {
  if (value === undefined) return undefined
  if (
    !isRecord(value) ||
    value.directoryId !== workspaceId ||
    typeof value.eventId !== 'string' ||
    value.eventId.trim().length === 0
  ) {
    throw new TenantAdministrationError(
      503,
      'TenantAuditRetentionCursorInvalid',
      'Tenant audit retention cursor is invalid.',
    )
  }
  return value.eventId
}

/**
 * Creates a digest-only sort key for one usage reservation receipt.
 *
 * @param workspaceId - Canonical Workspace identifier.
 * @param feature - Commercial feature being metered.
 * @param receiptKeyInput - Validated raw or server-scoped receipt-key input.
 * @returns A non-secret DynamoDB record key.
 */
function createUsageReceiptRecordKey(
  workspaceId: string,
  feature: TenantFeature,
  receiptKeyInput: string,
): string {
  const digest = createHash('sha256')
    .update(workspaceId)
    .update('\0')
    .update(feature)
    .update('\0')
    .update(receiptKeyInput)
    .digest('hex')
  return `${USAGE_RECEIPT_RECORD_PREFIX}${digest}`
}

/**
 * Binds a usage idempotency key to its feature and unit count.
 *
 * @param feature - Commercial feature being metered.
 * @param additionalUnits - Requested unit count.
 * @param requestBinding - Optional digest binding the key to request semantics.
 * @returns A stable SHA-256 request fingerprint.
 */
function createUsageRequestFingerprint(
  feature: TenantFeature,
  additionalUnits: number,
  requestBinding?: string,
): string {
  const hash = createHash('sha256')
    .update(feature)
    .update('\0')
    .update(String(additionalUnits))
  if (requestBinding) {
    hash.update('\0').update(requestBinding)
  }
  return hash.digest('hex')
}

/**
 * Creates a deterministic operation identifier without persisting the raw request key.
 *
 * @param workspaceId - Canonical Workspace identifier.
 * @param actorMemberKey - Stable requesting administrator key.
 * @param kind - Tenant lifecycle operation kind.
 * @param idempotencyKey - Validated raw request key, used only as hash input.
 * @returns A route-safe deterministic operation identifier.
 */
function createTenantOperationId(
  workspaceId: string,
  actorMemberKey: string,
  kind: 'export' | 'closure',
  idempotencyKey: string,
): string {
  const digest = createHash('sha256')
    .update(workspaceId)
    .update('\0')
    .update(actorMemberKey)
    .update('\0')
    .update(kind)
    .update('\0')
    .update(idempotencyKey)
    .digest('hex')
  return `operation-${digest}`
}

/**
 * Converts an ISO timestamp to whole epoch seconds.
 *
 * @param value - Tenant clock timestamp.
 * @returns Epoch seconds suitable for DynamoDB TTL comparisons.
 */
function toEpochSeconds(value: string): number {
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) {
    throw new TenantAdministrationError(500, 'InvalidTenantClock', 'Tenant clock is invalid.')
  }
  return Math.floor(timestamp / 1_000)
}

/**
 * Calculates the bounded TTL for a usage reservation receipt.
 *
 * @param createdAt - Receipt creation timestamp.
 * @returns DynamoDB TTL epoch seconds.
 */
function toTenantReceiptExpiry(createdAt: string): number {
  return toEpochSeconds(createdAt) + USAGE_RECEIPT_RETENTION_SECONDS
}

/**
 * Validates an optional request idempotency key before it reaches hashing logic.
 *
 * @param value - Candidate request header value.
 * @returns The normalized key, or undefined when no key was supplied.
 */
function readOptionalTenantIdempotencyKey(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  if (!normalized) return undefined
  const hasControlCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
  })
  if (normalized.length > 256 || hasControlCharacter) {
    throw new TenantAdministrationError(
      400,
      'InvalidTenantIdempotencyKey',
      'Tenant idempotency key is invalid.',
    )
  }
  return normalized
}

/**
 * Reads an optional metering scope while retaining compatibility with internal keys.
 *
 * @param value - Candidate scoped or legacy idempotency key.
 * @returns Receipt-key input and optional request binding.
 */
function readTenantUsageIdempotency(
  value: string | undefined,
): TenantUsageIdempotency | undefined {
  const normalized = readOptionalTenantIdempotencyKey(value)
  if (!normalized) return undefined
  const scoped = normalized.match(TENANT_METERING_IDEMPOTENCY_PATTERN)
  if (!scoped) return { receiptKeyInput: normalized }
  const receiptKeyInput = scoped[1]
  const requestBinding = scoped[2]
  if (!receiptKeyInput || !requestBinding) {
    throw new TenantAdministrationError(
      400,
      'InvalidTenantIdempotencyKey',
      'Tenant idempotency key is invalid.',
    )
  }
  return {
    receiptKeyInput,
    requestBinding,
  }
}

/**
 * Confirms a metering receipt belongs to the current request and committed usage.
 *
 * @param receipt - Durable receipt found for the digest-derived key.
 * @param workspaceId - Canonical Workspace identifier.
 * @param feature - Commercial feature being metered.
 * @param additionalUnits - Requested unit count.
 * @param requestFingerprint - Current request fingerprint.
 * @param usage - Current durable usage aggregate.
 */
function assertTenantUsageReceipt(
  receipt: TenantUsageReceipt,
  workspaceId: string,
  feature: TenantFeature,
  additionalUnits: number,
  requestFingerprint: string,
  usage: TenantUsage,
): void {
  if (
    receipt.workspaceId !== workspaceId ||
    receipt.feature !== feature ||
    receipt.additionalUnits !== additionalUnits ||
    receipt.requestFingerprint !== requestFingerprint
  ) {
    throw new TenantAdministrationError(
      409,
      'TenantUsageIdempotencyConflict',
      'Tenant usage idempotency key was already used for another request.',
    )
  }
  if (usage.workspaceId !== workspaceId || usage.revision < receipt.usageRevision) {
    throw new TenantAdministrationError(
      503,
      'TenantAdministrationCorrupt',
      'Tenant usage receipt is inconsistent with current usage.',
    )
  }
}

/**
 * Confirms a deterministic lifecycle operation is a replay of the same request.
 *
 * @param operation - Existing operation stored under the deterministic identifier.
 * @param actorMemberKey - Stable requesting administrator key.
 * @param kind - Requested operation kind.
 * @param format - Requested export format, when applicable.
 */
function assertTenantOperationReplay(
  operation: TenantOperation,
  actorMemberKey: string,
  kind: 'export' | 'closure',
  format: 'jsonl' | 'csv' | undefined,
): void {
  if (
    operation.requestedBy !== actorMemberKey ||
    operation.kind !== kind ||
    operation.exportFormat !== format
  ) {
    throw new TenantAdministrationError(
      409,
      'TenantOperationIdempotencyConflict',
      'Tenant operation idempotency key was already used for another request.',
    )
  }
}

/**
 * Parses one tenant feature discriminator from durable state.
 *
 * @param value - Candidate feature value.
 * @returns A validated tenant feature.
 */
function readTenantFeature(value: unknown): TenantFeature {
  if (
    value === 'documents' ||
    value === 'analytics' ||
    value === 'automation' ||
    value === 'developer-platform' ||
    value === 'sso' ||
    value === 'scim'
  ) {
    return value
  }
  throw new Error('invalid tenant feature')
}

function readEncryptionKeyPolicy(value: unknown): 'aws-managed' | 'customer-managed' {
  if (value === 'aws-managed' || value === 'customer-managed') return value
  throw new TenantAdministrationError(400, 'InvalidEncryptionKeyPolicy', 'Encryption key policy is invalid.')
}

function readRequiredString(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value
  throw new Error('required string missing')
}

/** Reads one non-empty ISO timestamp from durable state. */
function readRequiredTimestamp(value: unknown): string {
  const timestamp = readRequiredString(value)
  if (Number.isNaN(Date.parse(timestamp))) throw new Error('timestamp invalid')
  return timestamp
}

function readRevision(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  throw new Error('revision missing')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Distinguishes optimistic-lock failures from retryable DynamoDB cancellations.
 *
 * @param error - Unknown persistence failure returned by DynamoDB.
 * @returns Whether every reported transaction failure is conditional.
 */
function isConditionalFailure(error: unknown): boolean {
  if (!isRecord(error)) return false
  const errorName = typeof error.name === 'string'
    ? error.name
    : typeof error.code === 'string'
      ? error.code
      : undefined
  if (errorName === 'ConditionalCheckFailedException') return true
  if (errorName !== 'TransactionCanceledException') return false

  const reasons = error.CancellationReasons
  if (!Array.isArray(reasons) || reasons.length === 0) return false
  let hasConditionalFailure = false
  for (const reason of reasons) {
    if (!isRecord(reason)) return false
    if (reason.Code === 'ConditionalCheckFailed') {
      hasConditionalFailure = true
      continue
    }
    if (reason.Code !== 'None') return false
  }
  return hasConditionalFailure
}

function revisionConflict(code: string): TenantAdministrationError {
  return new TenantAdministrationError(409, code, 'Tenant state was changed by another request.')
}

/** Creates one fail-closed durable tenant-state corruption error. */
function tenantAdministrationCorrupt(message: string): TenantAdministrationError {
  return new TenantAdministrationError(
    503,
    'TenantAdministrationCorrupt',
    message,
  )
}

function toTenantPersistenceError(error: unknown): TenantAdministrationError {
  if (error instanceof TenantAdministrationError) return error
  return new TenantAdministrationError(
    503,
    'TenantAdministrationUnavailable',
    'Tenant administration state is unavailable.',
  )
}
