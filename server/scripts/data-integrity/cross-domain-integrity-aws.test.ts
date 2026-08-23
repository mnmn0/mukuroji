import { describe, expect, test } from 'bun:test'
import type {
  AttributeValue,
  ScanCommandOutput,
} from '@aws-sdk/client-dynamodb'
import type {
  GetObjectAttributesCommandOutput,
  GetObjectTaggingCommandOutput,
  HeadObjectCommandOutput,
} from '@aws-sdk/client-s3'
import {
  createDefaultDueDateWorkItemSchedule,
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
} from '@mukuroji/contracts'
import {
  createAuditEvent,
  createMutationAuditContext,
  createWorkspaceMemberAuditEntityIdFromKeyBytes,
} from '../../src/modules/audit'
import {
  calculateCrossDomainIntegrityAwsPageOriginDigest,
  CrossDomainIntegrityAwsBridgeFailure,
  readCrossDomainIntegrityAwsNormalizedPage,
  runCrossDomainIntegrityAwsCheck,
} from './cross-domain-integrity-aws'
import {
  calculateCrossDomainIntegrityResourceIdentityDigest,
  compareCrossDomainIntegrityResults,
  createCrossDomainIntegrityImmutableResourceIdentities,
  createCrossDomainIntegrityInvocationDeadline,
  CrossDomainIntegrityDeadlineFailure,
  CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
  CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS,
  verifyCrossDomainIntegrityResult,
  type CrossDomainIntegrityFileBucketMarkerAttestation,
  type CrossDomainIntegrityResourceIdentity,
  type CrossDomainIntegrityResourceAttestation,
  type CrossDomainIntegrityObservationMode,
} from './cross-domain-integrity'
import type {
  CrossDomainIntegrityManagedAwsReadPort,
  CrossDomainIntegrityLiveRuntimeBridge,
  CrossDomainIntegrityObjectVersionReference,
  CrossDomainIntegrityTableTarget,
} from './verify-cross-domain-integrity'

const CHECKED_AT = '2026-08-02T00:00:00.000Z'
const WORKSPACE_ID = 'workspace-private-canary'
const TEAM_ID = 'team-private-canary'
const PROJECT_ID = 'project-private-canary'
const WORK_ITEM_ID = 'issue-private-canary'
const MEMBER_KEY = 'directory-member-private-canary'
const FILE_ID = 'file-private-canary'
const VERSION_ID = 'version-private-canary'
const OBJECT_VERSION_ID = 'object-version-private-canary'
const HISTORICAL_AUDIT_SOURCES: readonly ('backfill' | 'migration')[] = [
  'backfill',
  'migration',
]
const OBJECT_KEY =
  `workspaces/${WORKSPACE_ID}/files/${FILE_ID}/${VERSION_ID}/design.pdf`
const DIGEST_KEY = new Uint8Array(32).fill(31)
const AUDIT_PSEUDONYM_KEY = new Uint8Array(32).fill(47)
const RESOURCE_IDENTITIES: CrossDomainIntegrityResourceIdentity[] =
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS.map((target, index) => ({
    target,
    identityDigest: ((index + 1) % 16).toString(16).repeat(64),
  }))
const RESOURCE_IDENTITY_DIGEST =
  calculateCrossDomainIntegrityResourceIdentityDigest(
    RESOURCE_IDENTITIES,
    DIGEST_KEY,
  )
const RESTORE_RESOURCE_IDENTITIES: CrossDomainIntegrityResourceIdentity[] =
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS.map((target, index) => ({
    target,
    identityDigest: ((index + 8) % 16).toString(16).repeat(64),
  }))
const RESTORE_RESOURCE_IDENTITY_DIGEST =
  calculateCrossDomainIntegrityResourceIdentityDigest(
    RESTORE_RESOURCE_IDENTITIES,
    DIGEST_KEY,
  )
const RESOURCE_ATTESTATION = createResourceAttestation()
const LIVE_RESOURCE_IDENTITIES =
  createCrossDomainIntegrityImmutableResourceIdentities(
    RESOURCE_ATTESTATION,
    DIGEST_KEY,
  )
const LIVE_RESOURCE_IDENTITY_DIGEST =
  calculateCrossDomainIntegrityResourceIdentityDigest(
    LIVE_RESOURCE_IDENTITIES,
    DIGEST_KEY,
  )

/**
 * Creates one strict immutable resource-attestation fixture.
 *
 * @returns Immutable private resource-attestation fixture.
 */
function createResourceAttestation(): CrossDomainIntegrityResourceAttestation {
  return {
    kind: 'mukuroji-cross-domain-integrity-resource-attestation',
    version: 1,
    scheme: CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    account: '123456789012',
    region: 'ap-northeast-1',
    bucket: {
      target: 'bucket:file',
      bucketName: 'file-integrity-bucket',
      marker: {
        key: CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
        versionId: 'file-bucket-marker-version-1',
        checksumSha256: Buffer.alloc(32, 0x5a).toString('base64'),
        size: 128,
      },
    },
    tables: [
      createTableAttestation('table:audit-events', 'audit-events-table', 1),
      createTableAttestation('table:file-proofing', 'file-proofing-table', 2),
      createTableAttestation('table:project-directory', 'project-directory-table', 3),
      createTableAttestation(
        'table:work-item-configuration',
        'work-item-configuration-table',
        4,
      ),
      createTableAttestation('table:work-items', 'work-items-table', 5),
      createTableAttestation('table:workspace-access', 'workspace-access-table', 6),
    ],
  }
}

/**
 * Creates one strict immutable table-attestation fixture.
 *
 * @param target - Canonical logical table target.
 * @param tableName - Exact configured table name.
 * @param index - Unique immutable fixture suffix.
 * @returns Immutable table resource fields.
 */
function createTableAttestation(
  target: CrossDomainIntegrityResourceIdentity['target'] & `table:${string}`,
  tableName: string,
  index: number,
) {
  return {
    target,
    tableName,
    tableArn:
      `arn:aws:dynamodb:ap-northeast-1:123456789012:table/${tableName}`,
    tableId: `immutable-table-id-${index}`,
    creationTime: `2026-01-0${index}T00:00:00.000Z`,
  }
}

/**
 * Replaces one immutable TableId while preserving the strict snapshot shape.
 *
 * @param attestation - Source strict immutable-resource snapshot.
 * @param tableIndex - Canonical table-vector index to replace.
 * @returns New snapshot containing one different table incarnation.
 */
function replaceResourceAttestationTableId(
  attestation: CrossDomainIntegrityResourceAttestation,
  tableIndex: number,
): CrossDomainIntegrityResourceAttestation {
  return {
    ...attestation,
    bucket: {
      ...attestation.bucket,
      marker: { ...attestation.bucket.marker },
    },
    tables: attestation.tables.map((table, index) => index === tableIndex
      ? { ...table, tableId: `${table.tableId}-replaced` }
      : { ...table }),
  }
}

describe('bounded normalized page origin digests', () => {
  test('prehashes a near-DynamoDB-limit row without a semantic token length cap', () => {
    const rawItem: Record<string, AttributeValue> = {
      payload: { S: 'x'.repeat(390_000) },
    }
    expect(calculateCrossDomainIntegrityAwsPageOriginDigest(
      DIGEST_KEY,
      'work-items',
      rawItem,
    )).toMatch(/^[a-f0-9]{64}$/u)
  })
})

describe('normalized page global capacity boundary', () => {
  test('allows an empty page at exact capacity and rejects the next retained unit', async () => {
    const emptyReader = new FixtureAwsReader({
      'work-items': [createScanPage([])],
    })
    await expect(readCrossDomainIntegrityAwsNormalizedPage({
      auditPseudonymKey: AUDIT_PSEUDONYM_KEY,
      checkedAt: CHECKED_AT,
      digestKey: DIGEST_KEY,
      pageSize: 25,
      reader: emptyReader,
      remainingItemCapacity: 0,
      signal: AbortSignal.timeout(60_000),
      target: 'work-items',
    })).resolves.toMatchObject({ retainedUnitCount: 0 })

    const rows = createHealthyNativeRows()
    const fullReader = new FixtureAwsReader({
      'work-items': [createScanPage(rows['work-items'].map(toRawItem))],
    })
    await expect(readCrossDomainIntegrityAwsNormalizedPage({
      auditPseudonymKey: AUDIT_PSEUDONYM_KEY,
      checkedAt: CHECKED_AT,
      digestKey: DIGEST_KEY,
      pageSize: 25,
      reader: fullReader,
      remainingItemCapacity: 0,
      signal: AbortSignal.timeout(60_000),
      target: 'work-items',
    })).rejects.toEqual(new CrossDomainIntegrityAwsBridgeFailure('LIMIT_EXCEEDED'))
  })

  test('preflights the combined File-row budget before exact-version reads', async () => {
    const reader = new FixtureAwsReader({
      'file-proofing': [createScanPage([
        toRawItem(createFileRow()),
        toRawItem(createFileRow()),
      ])],
    })

    await expect(readCrossDomainIntegrityAwsNormalizedPage({
      auditPseudonymKey: AUDIT_PSEUDONYM_KEY,
      checkedAt: CHECKED_AT,
      digestKey: DIGEST_KEY,
      pageSize: 2,
      reader,
      remainingItemCapacity: 5,
      signal: AbortSignal.timeout(60_000),
      target: 'file-proofing',
    })).rejects.toEqual(new CrossDomainIntegrityAwsBridgeFailure('LIMIT_EXCEEDED'))
    expect(exactS3OperationCount(reader)).toBe(0)
  })

  test('validates every File Proofing row before exact-version reads', async () => {
    const reader = new FixtureAwsReader({
      'file-proofing': [createScanPage([
        toRawItem(createFileRow()),
        toRawItem({
          entryType: 'annotation',
          recordKey: 'ANNOTATION#private-canary',
        }),
      ])],
    })

    await expect(readCrossDomainIntegrityAwsNormalizedPage({
      auditPseudonymKey: AUDIT_PSEUDONYM_KEY,
      checkedAt: CHECKED_AT,
      digestKey: DIGEST_KEY,
      pageSize: 2,
      reader,
      remainingItemCapacity: 6,
      signal: AbortSignal.timeout(60_000),
      target: 'file-proofing',
    })).rejects.toEqual(new CrossDomainIntegrityAwsBridgeFailure('NORMALIZATION_FAILED'))
    expect(exactS3OperationCount(reader)).toBe(0)
  })
})

/** Native rows keyed by the six logical table targets. */
type NativeRowsByTarget = Record<CrossDomainIntegrityTableTarget, readonly object[]>

/** Low-level pages keyed by logical table target. */
type ScanPagesByTarget = Partial<
  Record<CrossDomainIntegrityTableTarget, readonly ScanCommandOutput[]>
>

/** One captured raw scan request. */
type CapturedScanRequest = {
  /** Opaque continuation key supplied to the fake reader. */
  readonly exclusiveStartKey?: Record<string, AttributeValue>
  /** Logical table target selected by the bridge. */
  readonly target: CrossDomainIntegrityTableTarget
}

/** Fake exact-version S3 behavior. */
type FixtureReaderOptions = {
  /** Version ID echoed by S3, or the requested version when omitted. */
  readonly echoedVersionId?: string
  /** Raw exact-version HEAD failure returned by the fake reader. */
  readonly headError?: Error
  /** Optional ordered immutable-resource snapshots returned by pre/post measurement. */
  readonly resourceAttestations?:
    readonly CrossDomainIntegrityResourceAttestation[]
  /** Upload lifecycle tag returned by GetObjectTagging. */
  readonly uploadState?: 'completed' | 'pending'
}

/** Options for a healthy six-table fixture. */
type HealthyFixtureOptions = {
  /** Audit rows replacing the default current Work Item event. */
  readonly auditRows?: readonly object[]
  /** File rows replacing the default verified File row. */
  readonly fileRows?: readonly object[]
}

/** Optional bridge inputs varied by focused tests. */
type RunBridgeOptions = {
  /** Workspace Audit pseudonym key bytes. */
  readonly auditPseudonymKey?: Uint8Array
  /** Evidence HMAC key bytes. */
  readonly digestKey?: Uint8Array
  /** Maximum retained normalized and external evidence items. */
  readonly maxItems?: number
  /** Maximum raw DynamoDB pages shared across every table. */
  readonly maxPages?: number
  /** Total invocation duration used by focused deadline tests. */
  readonly maximumDurationMilliseconds?: number
  /** Trusted monotonic clock used by focused deadline tests. */
  readonly monotonicClock?: () => number
  /** Logical or actual-runtime migration rehearsal mode. */
  readonly observationMode?: CrossDomainIntegrityObservationMode
  /** One-shot trusted completion seam for live mode. */
  readonly liveRuntime?: CrossDomainIntegrityLiveRuntimeBridge
  /** Fixed page size shared with the pure checker. */
  readonly pageSize?: number
  /** Complete physical resource identities for this dataset. */
  readonly resourceIdentities?: readonly CrossDomainIntegrityResourceIdentity[]
  /** Keyed digest of the complete physical resource identity vector. */
  readonly resourceIdentityDigest?: string
  /** Dataset role represented by this invocation. */
  readonly role?: 'restore' | 'source'
}

/** Optional fields for one immutable File version fixture. */
type FileVersionOptions = {
  /** Immutable File-domain version ID. */
  readonly id?: string
  /** Monotonic File-domain version number. */
  readonly number?: number
  /** Dataset-local immutable object-store version ID. */
  readonly objectVersionId?: string
  /** Stored scan status. */
  readonly scanStatus?: 'available' | 'blocked' | 'failed' | 'pending' | 'scanning'
}

/** Fake read-only AWS port retaining requests for exact-read assertions. */
class FixtureAwsReader implements CrossDomainIntegrityManagedAwsReadPort {
  /** Finite signals received by raw AWS request boundaries. */
  readonly requestSignals: AbortSignal[] = []

  /** Exact GetObjectAttributes references received by the reader. */
  readonly attributeReferences: CrossDomainIntegrityObjectVersionReference[] = []

  /** Exact GetObjectTagging references received by the reader. */
  readonly taggingReferences: CrossDomainIntegrityObjectVersionReference[] = []

  /** Exact HeadObject references received by the reader. */
  readonly headReferences: CrossDomainIntegrityObjectVersionReference[] = []

  /** Raw scan calls in invocation order. */
  readonly scanRequests: CapturedScanRequest[] = []

  /** High-level external operation order for pre/post attestation assertions. */
  readonly operationOrder: string[] = []

  /** Number of immutable-resource measurements completed. */
  resourceAttestationMeasurementCount = 0

  /** Per-target next page indexes. */
  private readonly nextPageIndexes = new Map<CrossDomainIntegrityTableTarget, number>()

  /** Configured fake exact-version response behavior. */
  private readonly options: FixtureReaderOptions

  /** Configured low-level pages. */
  private readonly pages: ScanPagesByTarget

  /**
   * Creates a deterministic fake raw AWS port.
   *
   * @param pages - Low-level pages grouped by logical table target.
   * @param options - Optional exact-version response differences.
   */
  constructor(pages: ScanPagesByTarget, options: FixtureReaderOptions = {}) {
    this.pages = pages
    this.options = options
  }

  /** Releases no resources for the in-memory fake. */
  close(): void {}

  /** Returns attributes for the exact requested immutable object version. */
  async getObjectAttributes(
    reference: CrossDomainIntegrityObjectVersionReference,
    signal?: AbortSignal,
  ): Promise<GetObjectAttributesCommandOutput> {
    this.operationOrder.push('get-object-attributes')
    this.attributeReferences.push(reference)
    if (signal !== undefined) this.requestSignals.push(signal)
    return {
      $metadata: {},
      ObjectSize: 4_096,
      VersionId: this.options.echoedVersionId ?? reference.versionId,
    }
  }

  /** Returns scan and upload tags for the exact requested immutable version. */
  async getObjectTagging(
    reference: CrossDomainIntegrityObjectVersionReference,
    signal?: AbortSignal,
  ): Promise<GetObjectTaggingCommandOutput> {
    this.operationOrder.push('get-object-tagging')
    this.taggingReferences.push(reference)
    if (signal !== undefined) this.requestSignals.push(signal)
    return {
      $metadata: {},
      TagSet: [
        { Key: 'GuardDutyMalwareScanStatus', Value: 'NO_THREATS_FOUND' },
        { Key: 'mukuroji-upload', Value: this.options.uploadState ?? 'completed' },
      ],
      VersionId: this.options.echoedVersionId ?? reference.versionId,
    }
  }

  /** Returns headers for the exact requested immutable object version. */
  async headObject(
    reference: CrossDomainIntegrityObjectVersionReference,
    signal?: AbortSignal,
  ): Promise<HeadObjectCommandOutput> {
    this.operationOrder.push('head-object')
    this.headReferences.push(reference)
    if (signal !== undefined) this.requestSignals.push(signal)
    if (this.options.headError) throw this.options.headError
    return {
      $metadata: {},
      ContentLength: 4_096,
      ContentType: 'application/pdf',
      VersionId: this.options.echoedVersionId ?? reference.versionId,
    }
  }

  /** Returns a fixed test account unused by the bridge. */
  async readCallerAccount(): Promise<string> {
    return '123456789012'
  }

  /** Measures one configured immutable-resource snapshot. */
  async measureResourceAttestation(
    marker: CrossDomainIntegrityFileBucketMarkerAttestation,
    signal?: AbortSignal,
  ): Promise<CrossDomainIntegrityResourceAttestation> {
    this.operationOrder.push('resource-attestation')
    if (signal !== undefined) this.requestSignals.push(signal)
    if (
      marker.key !== RESOURCE_ATTESTATION.bucket.marker.key ||
      marker.versionId !== RESOURCE_ATTESTATION.bucket.marker.versionId ||
      marker.checksumSha256 !==
        RESOURCE_ATTESTATION.bucket.marker.checksumSha256 ||
      marker.size !== RESOURCE_ATTESTATION.bucket.marker.size
    ) {
      throw new Error('Unexpected immutable marker fixture.')
    }
    const index = this.resourceAttestationMeasurementCount
    this.resourceAttestationMeasurementCount += 1
    return this.options.resourceAttestations?.[index] ?? RESOURCE_ATTESTATION
  }

  /** Returns the next configured raw page for one target. */
  async scanPage(
    target: CrossDomainIntegrityTableTarget,
    exclusiveStartKey?: Record<string, AttributeValue>,
    signal?: AbortSignal,
  ): Promise<ScanCommandOutput> {
    this.operationOrder.push('scan')
    if (signal !== undefined) this.requestSignals.push(signal)
    this.scanRequests.push(exclusiveStartKey === undefined
      ? { target }
      : { target, exclusiveStartKey })
    const index = this.nextPageIndexes.get(target) ?? 0
    this.nextPageIndexes.set(target, index + 1)
    return this.pages[target]?.[index] ?? createScanPage([])
  }
}

/** Creates a healthy strict canonical Work Item row. */
function createWorkItemRow(): object {
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 1,
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    directoryId: WORKSPACE_ID,
    directoryTeamId: `${WORKSPACE_ID}#team#${TEAM_ID}`,
    directoryProjectId: `${WORKSPACE_ID}#project#${PROJECT_ID}`,
    teamId: TEAM_ID,
    assignedProjectId: PROJECT_ID,
    issueId: WORK_ITEM_ID,
    sortOrder: 10,
    title: 'Bridge fixture',
    description: 'Strict canonical row',
    assigneeUserId: MEMBER_KEY,
    creatorMemberKey: MEMBER_KEY,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026-08-31',
    schedule: createDefaultDueDateWorkItemSchedule('2026-08-31'),
    priority: 'medium',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:01:00.000Z',
  }
}

/** Creates one stored Workspace-level Work Item configuration row. */
function createConfigurationRow(): object {
  return {
    scopeKey: `${encodeURIComponent(WORKSPACE_ID)}#work-item-configuration`,
    recordKey: 'CONFIG',
    scopeType: 'workspace',
    scopeId: WORKSPACE_ID,
    schemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    revision: 1,
    workflow: {
      id: 'default-workflow',
      name: 'Default workflow',
      initialStatusId: 'todo',
      statuses: [
        {
          id: 'todo',
          name: 'Todo',
          category: 'unstarted',
          sortOrder: 10,
          color: 'slate',
        },
      ],
      transitions: [],
    },
    customFields: [],
  }
}

/** Creates canonical Team and Project directory rows. */
function createProjectDirectoryRows(): readonly object[] {
  return [
    {
      directoryId: WORKSPACE_ID,
      entryKey: `000010#000000#TEAM#${TEAM_ID}`,
      entryType: 'team',
      teamId: TEAM_ID,
      teamSortOrder: 10,
      nameJa: '',
      nameEn: 'Team',
      expanded: true,
    },
    {
      directoryId: WORKSPACE_ID,
      entryKey: `000010#000010#PROJECT#${PROJECT_ID}`,
      entryType: 'project',
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
      teamSortOrder: 10,
      projectSortOrder: 10,
      nameJa: ' プロジェクト ',
      nameEn: '',
      tone: 'blue',
    },
  ]
}

/** Creates Workspace metadata and member rows. */
function createWorkspaceAccessRows(): readonly object[] {
  return [
    {
      workspaceId: WORKSPACE_ID,
      recordKey: 'WORKSPACE',
      entryType: 'workspace-meta',
      activeOwnerCount: 1,
      version: 1,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:01:00.000Z',
    },
    {
      workspaceId: WORKSPACE_ID,
      recordKey: `MEMBER#${MEMBER_KEY}`,
      entryType: 'workspace-member',
      id: MEMBER_KEY,
      memberKey: MEMBER_KEY,
      email: 'renamed-member-private-canary@example.test',
      role: 'owner',
      status: 'active',
      version: 1,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:01:00.000Z',
    },
  ]
}

/**
 * Creates one strict Audit event referencing a Team-scoped Work Item.
 *
 * @param occurredAt - Canonical event occurrence time.
 * @param action - Resource lifecycle action.
 * @param workItemId - Referenced Work Item identifier.
 * @param workspaceId - Owning Workspace identifier.
 * @returns Stored current-schema Audit event.
 */
function createWorkItemAuditRow(
  occurredAt: string,
  action: 'created' | 'deleted' | 'deleted-label' | 'updated',
  workItemId = WORK_ITEM_ID,
  workspaceId = WORKSPACE_ID,
): object {
  const context = createMutationAuditContext({
    workspaceId,
    actor: { id: 'system:bridge-test', kind: 'system' },
    idempotencyKey: `bridge-${action}-${occurredAt}`,
    occurredAt,
    request: { method: 'CHECK', path: '/internal/data-integrity' },
    source: { kind: 'system' },
  })
  return createAuditEvent({
    context,
    expiresAt: 2_000_000_000,
    eventType: `work-item.${action}`,
    entity: { type: 'work-item', id: `team/${TEAM_ID}/issue/${workItemId}` },
    action,
    metadata: { teamId: TEAM_ID, issueId: workItemId },
  })
}

/**
 * Creates an Audit event whose Work Item entity differs from its Comment target.
 *
 * @param source - Snapshot backfill or ordinary system-event provenance.
 * @param action - Backfill or target-deletion lifecycle action.
 * @returns Stored current-schema Audit event.
 */
function createCommentTargetAuditRow(
  source: 'backfill' | 'migration' | 'system',
  action: 'backfilled' | 'deleted',
): object {
  const context = createMutationAuditContext({
    workspaceId: WORKSPACE_ID,
    actor: { id: 'system:bridge-test', kind: 'system' },
    idempotencyKey: `bridge-comment-${source}-${action}`,
    occurredAt: '2026-08-01T00:07:00.000Z',
    request: { method: 'CHECK', path: '/internal/data-integrity' },
    source: { kind: source },
  })
  return createAuditEvent({
    context,
    expiresAt: 2_000_000_000,
    eventType: `comment.${action}`,
    entity: {
      type: 'work-item',
      id: `team/${TEAM_ID}/issue/${WORK_ITEM_ID}`,
    },
    target: {
      type: 'comment',
      id: `team/${TEAM_ID}/issue/${WORK_ITEM_ID}/comment/historical`,
    },
    action,
    metadata: { teamId: TEAM_ID, issueId: WORK_ITEM_ID },
  })
}

/**
 * Creates the production File deletion Audit shape whose metadata tombstone may later expire.
 *
 * @returns Stored current-schema File deletion event.
 */
function createFileDeletedAuditRow(): object {
  const context = createMutationAuditContext({
    workspaceId: WORKSPACE_ID,
    actor: { id: 'system:bridge-test', kind: 'system' },
    idempotencyKey: 'bridge-file-deleted',
    occurredAt: '2026-08-01T00:07:30.000Z',
    request: { method: 'CHECK', path: '/internal/data-integrity' },
    source: { kind: 'system' },
  })
  return createAuditEvent({
    context,
    expiresAt: 2_000_000_000,
    eventType: 'file.deleted',
    entity: {
      type: 'work-item',
      id: `team/${TEAM_ID}/issue/${WORK_ITEM_ID}`,
    },
    target: { type: 'file', id: FILE_ID },
    action: 'deleted',
    metadata: {
      teamId: TEAM_ID,
      issueId: WORK_ITEM_ID,
      fileId: FILE_ID,
      versionId: VERSION_ID,
    },
  })
}

/**
 * Creates the production Project archive Audit shape whose directory row remains retained.
 *
 * @returns Stored current-schema Project archive event.
 */
function createProjectArchivedAuditRow(): object {
  const context = createMutationAuditContext({
    workspaceId: WORKSPACE_ID,
    actor: { id: 'system:bridge-test', kind: 'system' },
    idempotencyKey: 'bridge-project-archived',
    occurredAt: '2026-08-01T00:07:45.000Z',
    request: { method: 'CHECK', path: '/internal/data-integrity' },
    source: { kind: 'system' },
  })
  return createAuditEvent({
    context,
    expiresAt: 2_000_000_000,
    eventType: 'project.archived',
    entity: { type: 'project', id: PROJECT_ID },
    action: 'archived',
    metadata: { kind: 'project', projectId: PROJECT_ID, teamId: TEAM_ID },
  })
}

/**
 * Creates one canonical Workspace member Audit event using the production pseudonym contract.
 *
 * @param occurredAt - Canonical event occurrence time.
 * @param memberKey - Private member key represented only through its Audit pseudonym.
 * @param action - Workspace member lifecycle action.
 * @returns Stored current-schema Workspace member Audit event.
 */
function createWorkspaceMemberAuditRow(
  occurredAt: string,
  memberKey: string,
  action: 'created' | 'deactivated' = 'created',
): object {
  const context = createMutationAuditContext({
    workspaceId: WORKSPACE_ID,
    actor: { id: 'system:bridge-test', kind: 'system' },
    idempotencyKey: `bridge-member-${action}-${occurredAt}`,
    occurredAt,
    request: { method: 'CHECK', path: '/internal/data-integrity' },
    source: { kind: 'system' },
  })
  return createAuditEvent({
    context,
    expiresAt: 2_000_000_000,
    eventType: `member.${action}`,
    entity: {
      type: 'member',
      id: createWorkspaceMemberAuditEntityIdFromKeyBytes(
        WORKSPACE_ID,
        memberKey,
        AUDIT_PSEUDONYM_KEY,
      ),
    },
    action,
    metadata: { kind: 'workspace-member' },
  })
}

/** Creates one current Project-member Audit event that retains metadata.memberKey. */
function createProjectMemberAuditRow(occurredAt: string): object {
  const context = createMutationAuditContext({
    workspaceId: WORKSPACE_ID,
    actor: { id: 'system:bridge-test', kind: 'system' },
    idempotencyKey: `bridge-project-member-${occurredAt}`,
    occurredAt,
    request: { method: 'CHECK', path: '/internal/data-integrity' },
    source: { kind: 'system' },
  })
  return createAuditEvent({
    context,
    expiresAt: 2_000_000_000,
    eventType: 'member.added',
    entity: { type: 'member', id: `${PROJECT_ID}/${MEMBER_KEY}` },
    action: 'added',
    metadata: { projectId: PROJECT_ID, memberKey: MEMBER_KEY },
  })
}

/**
 * Creates one immutable File version fixture.
 *
 * @param options - Optional identity, sequence, and scan state.
 * @returns Strict File version object.
 */
function createFileVersion(options: FileVersionOptions = {}): object {
  const id = options.id ?? VERSION_ID
  const number = options.number ?? 1
  return {
    id,
    number,
    fileName: 'design.pdf',
    contentType: 'application/pdf',
    sizeBytes: 4_096,
    scanStatus: options.scanStatus ?? 'available',
    previewKind: 'pdf',
    createdByMemberKey: MEMBER_KEY,
    createdAt: `2026-08-01T00:0${number}:00.000Z`,
    verifiedAt: `2026-08-01T00:1${number}:00.000Z`,
    objectKey: `workspaces/${WORKSPACE_ID}/files/${FILE_ID}/${id}/design.pdf`,
    objectVersionId: options.objectVersionId ??
      (number === 1 ? OBJECT_VERSION_ID : `${OBJECT_VERSION_ID}-${number}`),
  }
}

/**
 * Creates one strict File metadata row.
 *
 * @param overrides - Optional top-level row differences.
 * @param versions - Optional immutable version list.
 * @returns Stored File row.
 */
function createFileRow(
  overrides: Record<string, unknown> = {},
  versions: readonly object[] = [createFileVersion()],
): object {
  const currentVersion = versions[versions.length - 1]
  const currentVersionId = isRecord(currentVersion) && typeof currentVersion.id === 'string'
    ? currentVersion.id
    : VERSION_ID
  return {
    scopeKey: `WORKSPACE#${WORKSPACE_ID}#TEAM#${TEAM_ID}#WORKITEM#${WORK_ITEM_ID}`,
    recordKey: `FILE#${FILE_ID}`,
    entryType: 'file',
    workspaceId: WORKSPACE_ID,
    teamId: TEAM_ID,
    issueId: WORK_ITEM_ID,
    fileId: FILE_ID,
    revision: 1,
    pendingApprovalCount: 0,
    name: 'design.pdf',
    targetType: 'work-item',
    targetId: WORK_ITEM_ID,
    versions,
    currentVersionId,
    createdByMemberKey: MEMBER_KEY,
    guestAccess: false,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:20:00.000Z',
    ...overrides,
  }
}

/** Creates all six healthy native table datasets. */
function createHealthyNativeRows(
  options: HealthyFixtureOptions = {},
): NativeRowsByTarget {
  return {
    'work-items': [createWorkItemRow()],
    'work-item-configuration': [createConfigurationRow()],
    'project-directory': createProjectDirectoryRows(),
    'workspace-access': createWorkspaceAccessRows(),
    'audit-events': options.auditRows ?? [
      createWorkItemAuditRow('2026-08-01T00:10:00.000Z', 'updated'),
    ],
    'file-proofing': options.fileRows ?? [createFileRow()],
  }
}

/** Converts all native table rows into one low-level page per table. */
function createPagesFromNativeRows(rows: NativeRowsByTarget): ScanPagesByTarget {
  return {
    'work-items': [createScanPage(rows['work-items'].map(toRawItem))],
    'work-item-configuration': [
      createScanPage(rows['work-item-configuration'].map(toRawItem)),
    ],
    'project-directory': [createScanPage(rows['project-directory'].map(toRawItem))],
    'workspace-access': [createScanPage(rows['workspace-access'].map(toRawItem))],
    'audit-events': [createScanPage(rows['audit-events'].map(toRawItem))],
    'file-proofing': [createScanPage(rows['file-proofing'].map(toRawItem))],
  }
}

/**
 * Creates one low-level DynamoDB page.
 *
 * @param items - Raw item list.
 * @param nextKey - Optional opaque continuation key.
 * @returns Fake Scan response.
 */
function createScanPage(
  items: Record<string, AttributeValue>[],
  nextKey?: Record<string, AttributeValue>,
): ScanCommandOutput {
  return {
    $metadata: {},
    Count: items.length,
    ScannedCount: items.length,
    Items: items,
    ...(nextKey === undefined ? {} : { LastEvaluatedKey: nextKey }),
  }
}

/** Marshals one native object into a low-level DynamoDB item. */
function toRawItem(value: object): Record<string, AttributeValue> {
  const item: Record<string, AttributeValue> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) item[key] = toAttributeValue(entry)
  }
  return item
}

/** Marshals the JSON-compatible fixture subset into a low-level attribute. */
function toAttributeValue(value: unknown): AttributeValue {
  if (value === null) return { NULL: true }
  if (typeof value === 'string') return { S: value }
  if (typeof value === 'number' && Number.isFinite(value)) return { N: String(value) }
  if (typeof value === 'boolean') return { BOOL: value }
  if (Array.isArray(value)) return { L: value.map(toAttributeValue) }
  if (isRecord(value)) return { M: toRawItem(value) }
  throw new TypeError('Unsupported fixture value.')
}

/** Narrows a value to a non-array object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Runs the bridge with fixed secret-free digests and optional focused bounds. */
function runBridge(
  reader: CrossDomainIntegrityManagedAwsReadPort,
  options: RunBridgeOptions = {},
) {
  const live = options.observationMode === 'migration-rehearsal-live'
  return runCrossDomainIntegrityAwsCheck({
    auditPseudonymKey: options.auditPseudonymKey ?? AUDIT_PSEUDONYM_KEY,
    checkedAt: CHECKED_AT,
    observationMode: options.observationMode,
    ...(options.liveRuntime === undefined
      ? {}
      : { liveRuntime: options.liveRuntime }),
    deadline: createCrossDomainIntegrityInvocationDeadline({
      maximumDurationMilliseconds:
        options.maximumDurationMilliseconds ?? 60_000,
      monotonicClock: options.monotonicClock ?? (() => 1_000),
    }),
    digestKey: options.digestKey ?? DIGEST_KEY,
    maxPages: options.maxPages ?? 100,
    maxItems: options.maxItems ?? 100,
    pageSize: options.pageSize ?? 100,
    reader,
    resourceBindingDigest: 'b'.repeat(64),
    ...(live
      ? {
          resourceAttestation: RESOURCE_ATTESTATION,
          resourceIdentityScheme:
            CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
        }
      : {}),
    resourceIdentities: options.resourceIdentities ??
      (live ? LIVE_RESOURCE_IDENTITIES : RESOURCE_IDENTITIES),
    resourceIdentityDigest: options.resourceIdentityDigest ??
      (live ? LIVE_RESOURCE_IDENTITY_DIGEST : RESOURCE_IDENTITY_DIGEST),
    role: options.role ?? 'source',
  })
}

/** Returns the total number of exact S3 operations issued by a fake reader. */
function exactS3OperationCount(reader: FixtureAwsReader): number {
  return reader.headReferences.length + reader.attributeReferences.length +
    reader.taggingReferences.length
}

describe('cross-domain integrity AWS composition bridge', () => {
  test('samples live completion exactly after all external reads', async () => {
    const reader = new FixtureAwsReader(
      createPagesFromNativeRows(createHealthyNativeRows()),
    )
    const completedAt = '2026-08-02T00:01:00.000Z'
    let completionCalls = 0
    const result = await runBridge(reader, {
      observationMode: 'migration-rehearsal-live',
      liveRuntime: {
        startedAt: CHECKED_AT,
        sampleCompletedAt: () => {
          completionCalls += 1
          expect(reader.scanRequests).toHaveLength(6)
          expect(exactS3OperationCount(reader)).toBe(3)
          expect(reader.resourceAttestationMeasurementCount).toBe(2)
          expect(reader.operationOrder[0]).toBe('resource-attestation')
          expect(reader.operationOrder.at(-1)).toBe('resource-attestation')
          return completedAt
        },
      },
    })

    expect(completionCalls).toBe(1)
    expect(reader.operationOrder.indexOf('scan')).toBeGreaterThan(0)
    expect(result.checkedAt).toBe(completedAt)
    expect(result.runtimeProvenance).toMatchObject({
      startedAt: CHECKED_AT,
      completedAt,
      checkedAtSource: 'trusted-wall-clock-after-external-reads',
    })
    expect(verifyCrossDomainIntegrityResult(result, DIGEST_KEY)).toBe(true)
  })

  test('rejects an immutable-resource mismatch before the first Scan', async () => {
    const reader = new FixtureAwsReader(
      createPagesFromNativeRows(createHealthyNativeRows()),
      {
        resourceAttestations: [
          replaceResourceAttestationTableId(RESOURCE_ATTESTATION, 0),
        ],
      },
    )

    await expect(runBridge(reader, {
      observationMode: 'migration-rehearsal-live',
      liveRuntime: {
        startedAt: CHECKED_AT,
        sampleCompletedAt: () => '2026-08-02T00:01:00.000Z',
      },
    })).rejects.toEqual(
      new CrossDomainIntegrityAwsBridgeFailure('RESOURCE_ATTESTATION_INVALID'),
    )
    expect(reader.resourceAttestationMeasurementCount).toBe(1)
    expect(reader.scanRequests).toHaveLength(0)
  })

  test('rejects resource reincarnation measured after all data reads', async () => {
    const reader = new FixtureAwsReader(
      createPagesFromNativeRows(createHealthyNativeRows()),
      {
        resourceAttestations: [
          RESOURCE_ATTESTATION,
          replaceResourceAttestationTableId(RESOURCE_ATTESTATION, 5),
        ],
      },
    )
    let completionCalls = 0

    await expect(runBridge(reader, {
      observationMode: 'migration-rehearsal-live',
      liveRuntime: {
        startedAt: CHECKED_AT,
        sampleCompletedAt: () => {
          completionCalls += 1
          return '2026-08-02T00:01:00.000Z'
        },
      },
    })).rejects.toEqual(
      new CrossDomainIntegrityAwsBridgeFailure('RESOURCE_ATTESTATION_INVALID'),
    )
    expect(reader.resourceAttestationMeasurementCount).toBe(2)
    expect(reader.scanRequests).toHaveLength(6)
    expect(completionCalls).toBe(0)
  })

  test('normalizes all six tables and reads only exact immutable object versions', async () => {
    const reader = new FixtureAwsReader(
      createPagesFromNativeRows(createHealthyNativeRows()),
    )

    const result = await runBridge(reader)

    expect(result.status).toBe('pass')
    expect(result.failureCodes).toEqual([])
    expect(reader.scanRequests.map((request) => request.target)).toEqual([
      'work-items',
      'work-item-configuration',
      'project-directory',
      'workspace-access',
      'audit-events',
      'file-proofing',
    ])
    const expectedReference: CrossDomainIntegrityObjectVersionReference = {
      bucket: 'file',
      key: OBJECT_KEY,
      versionId: OBJECT_VERSION_ID,
    }
    expect(reader.headReferences).toEqual([expectedReference])
    expect(reader.attributeReferences).toEqual([expectedReference])
    expect(reader.taggingReferences).toEqual([expectedReference])
    expect(reader.requestSignals.length).toBeGreaterThan(0)
    expect(new Set(reader.requestSignals).size).toBe(1)
    expect(reader.requestSignals[0]?.aborted).toBe(false)
    const evidence = JSON.stringify(result)
    for (const privateValue of [
      WORKSPACE_ID,
      TEAM_ID,
      PROJECT_ID,
      WORK_ITEM_ID,
      FILE_ID,
      OBJECT_KEY,
      OBJECT_VERSION_ID,
    ]) {
      expect(evidence).not.toContain(privateValue)
    }
  })

  test('recognizes current Project Directory Webhook rows as auxiliary', async () => {
    const rows = createHealthyNativeRows()
    rows['project-directory'] = [
      ...rows['project-directory'],
      {
        directoryId: `WEBHOOK_TEAM_GRANT#${WORKSPACE_ID}#${MEMBER_KEY}`,
        entryKey: `TEAM#${TEAM_ID}#PROJECT#${PROJECT_ID}`,
        entryType: 'webhook-team-grant',
        workspaceId: WORKSPACE_ID,
        teamId: TEAM_ID,
        projectId: PROJECT_ID,
        memberKey: MEMBER_KEY,
      },
      {
        directoryId: `WEBHOOK_GRANT_CLEANUP#${WORKSPACE_ID}#${TEAM_ID}`,
        entryKey: `PROJECT#${PROJECT_ID}#MEMBER#${MEMBER_KEY}`,
        entryType: 'webhook-team-grant-cleanup',
        workspaceId: WORKSPACE_ID,
        teamId: TEAM_ID,
        projectId: PROJECT_ID,
        memberKey: MEMBER_KEY,
      },
    ]
    const reader = new FixtureAwsReader(createPagesFromNativeRows(rows))

    const result = await runBridge(reader)

    expect(result.status).toBe('pass')
    expect(result.failureCodes).toEqual([])
  })

  test('rejects Project Directory target rows outside the canonical mapper contract', async () => {
    const [teamValue, projectValue] = createProjectDirectoryRows()
    if (!isRecord(teamValue) || !isRecord(projectValue)) {
      throw new Error('Expected canonical Project Directory fixtures.')
    }
    const oversizedTeamId = 't'.repeat(257)
    const oversizedProjectId = 'p'.repeat(257)
    const invalidRows: readonly object[] = [
      {
        ...teamValue,
        teamSortOrder: 0,
        entryKey: `000000#000000#TEAM#${TEAM_ID}`,
      },
      {
        ...teamValue,
        teamId: 'team/invalid',
        entryKey: '000010#000000#TEAM#team/invalid',
      },
      {
        ...teamValue,
        teamId: oversizedTeamId,
        entryKey: `000010#000000#TEAM#${oversizedTeamId}`,
      },
      {
        ...teamValue,
        directoryId: 'w'.repeat(1_025),
      },
      {
        ...teamValue,
        nameJa: '名'.repeat(501),
        nameEn: 'Team',
      },
      {
        ...teamValue,
        createdAt: 'not-a-timestamp',
      },
      {
        ...teamValue,
        createdAt: '2026-08-01T00:02:00.000Z',
        updatedAt: '2026-08-01T00:01:00.000Z',
      },
      {
        ...teamValue,
        createdAt: '2026-08-01T00:01:00.000Z',
        updatedAt: '2026-08-01T00:03:00.000Z',
        archivedAt: '2026-08-01T00:00:00.000Z',
      },
      {
        ...projectValue,
        tone: undefined,
      },
      {
        ...projectValue,
        projectId: 'project/invalid',
        entryKey: '000010#000010#PROJECT#project/invalid',
      },
      {
        ...projectValue,
        projectId: oversizedProjectId,
        entryKey: `000010#000010#PROJECT#${oversizedProjectId}`,
      },
      {
        directoryId: WORKSPACE_ID,
        entryKey: '000010#000000#TEAM#spoofed-target',
        entryType: 'planning-meta',
      },
    ]

    for (const invalidRow of invalidRows) {
      const rows = createHealthyNativeRows()
      rows['project-directory'] = [
        ...rows['project-directory'],
        invalidRow,
      ]
      const reader = new FixtureAwsReader(createPagesFromNativeRows(rows))

      await expect(runBridge(reader)).rejects.toMatchObject({
        code: 'NORMALIZATION_FAILED',
      })
    }
  })

  test('excludes a valid retained legacy Work Item tombstone from live joins', async () => {
    const rows = createHealthyNativeRows({ auditRows: [], fileRows: [] })
    rows['work-items'] = [{
      ...createWorkItemRow(),
      deletedAt: '2026-08-01T00:00:30.000Z',
    }]
    const reader = new FixtureAwsReader(createPagesFromNativeRows(rows))

    const result = await runBridge(reader)

    expect(result.status).toBe('pass')
    expect(result.evidence.domains.find((domain) => domain.domain === 'work-item'))
      .toMatchObject({ itemCount: 0 })
  })

  test('rejects a malformed retained legacy Work Item deletion clock', async () => {
    for (const deletedAt of [
      'not-a-timestamp',
      '2026-07-31T23:59:59.999Z',
      '2026-08-01T00:01:00.001Z',
    ]) {
      const rows = createHealthyNativeRows({ auditRows: [], fileRows: [] })
      rows['work-items'] = [{ ...createWorkItemRow(), deletedAt }]
      const reader = new FixtureAwsReader(createPagesFromNativeRows(rows))

      await expect(runBridge(reader)).rejects.toMatchObject({
        code: 'NORMALIZATION_FAILED',
      })
    }
  })

  test('rejects a Planning row misplaced in Workspace Access', async () => {
    const rows = createHealthyNativeRows()
    rows['workspace-access'] = [
      ...rows['workspace-access'],
      {
        workspaceId: WORKSPACE_ID,
        recordKey: 'META',
        entryType: 'planning-meta',
        schemaVersion: 1,
        revision: 1,
        updatedAt: '2026-08-01T00:01:00.000Z',
      },
    ]
    const reader = new FixtureAwsReader(createPagesFromNativeRows(rows))

    await expect(runBridge(reader)).rejects.toMatchObject({
      code: 'NORMALIZATION_FAILED',
    })
  })

  test('joins canonical Workspace and Project-member Audit events to Workspace Access', async () => {
    const reader = new FixtureAwsReader(createPagesFromNativeRows(createHealthyNativeRows({
      auditRows: [
        createWorkspaceMemberAuditRow(
          '2026-08-01T00:08:00.000Z',
          MEMBER_KEY,
        ),
        createProjectMemberAuditRow('2026-08-01T00:09:00.000Z'),
      ],
    })))

    const result = await runBridge(reader)

    expect(result.status).toBe('pass')
    expect(result.failureCodes).not.toContain('AUDIT_RESOURCE_MISSING')
    expect(JSON.stringify(result)).not.toContain(MEMBER_KEY)
  })

  test('reports a current Workspace member Audit event whose canonical row is missing', async () => {
    const missingMemberKey = 'missing-member-private-canary@example.test'
    const reader = new FixtureAwsReader(createPagesFromNativeRows(createHealthyNativeRows({
      auditRows: [
        createWorkspaceMemberAuditRow(
          '2026-08-01T00:08:00.000Z',
          missingMemberKey,
        ),
      ],
    })))

    const result = await runBridge(reader)

    expect(result.failureCodes).toContain('AUDIT_RESOURCE_MISSING')
    expect(JSON.stringify(result)).not.toContain(missingMemberKey)
  })

  test('reports a retained Workspace member missing after deactivation', async () => {
    const deactivatedMemberKey = 'deactivated-member-private-canary@example.test'
    const reader = new FixtureAwsReader(createPagesFromNativeRows(createHealthyNativeRows({
      auditRows: [
        createWorkspaceMemberAuditRow(
          '2026-08-01T00:08:00.000Z',
          deactivatedMemberKey,
        ),
        createWorkspaceMemberAuditRow(
          '2026-08-01T00:09:00.000Z',
          deactivatedMemberKey,
          'deactivated',
        ),
      ],
    })))

    const result = await runBridge(reader)

    expect(result.failureCodes).toContain('AUDIT_RESOURCE_MISSING')
    expect(JSON.stringify(result)).not.toContain(deactivatedMemberKey)
  })

  test('reports a retained Project missing after archive', async () => {
    const rows = createHealthyNativeRows({
      auditRows: [createProjectArchivedAuditRow()],
      fileRows: [],
    })
    rows['work-items'] = []
    rows['project-directory'] = []
    const reader = new FixtureAwsReader(createPagesFromNativeRows(rows))

    const result = await runBridge(reader)

    expect(result.status).toBe('fail')
    expect(result.failureCodes).toContain('AUDIT_RESOURCE_MISSING')
  })

  test('rejects malformed relevant rows without reflecting raw canaries', async () => {
    const healthy = createHealthyNativeRows()
    const reader = new FixtureAwsReader(createPagesFromNativeRows({
      ...healthy,
      'work-items': [{
        ...createWorkItemRow(),
        title: '',
        privateCanary: 'raw-row-do-not-expose',
      }],
    }))

    let failure: unknown
    try {
      await runBridge(reader)
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(CrossDomainIntegrityAwsBridgeFailure)
    expect(failure).toMatchObject({ code: 'NORMALIZATION_FAILED' })
    expect(JSON.stringify(failure)).not.toContain('raw-row-do-not-expose')

    const malformedAttribute: AttributeValue = { S: 'raw-attribute-do-not-expose' }
    Object.defineProperty(malformedAttribute, 'N', { enumerable: true, value: '1' })
    const rawReader = new FixtureAwsReader({
      'work-items': [createScanPage([{ malformedAttribute }])],
    })
    let rawFailure: unknown
    try {
      await runBridge(rawReader)
    } catch (error) {
      rawFailure = error
    }
    expect(rawFailure).toMatchObject({ code: 'AWS_PAGE_INVALID' })
    expect(JSON.stringify(rawFailure)).not.toContain('raw-attribute-do-not-expose')
  })

  test('rejects raw page overruns and repeated opaque cursors', async () => {
    const overrunReader = new FixtureAwsReader({
      'work-items': [createScanPage([toRawItem(createWorkItemRow()), toRawItem(createWorkItemRow())])],
    })
    await expect(runBridge(overrunReader, { pageSize: 1 })).rejects.toMatchObject({
      code: 'AWS_PAGE_INVALID',
    })

    const cursor = { privateCursor: { S: 'cursor-private-canary' } }
    const loopReader = new FixtureAwsReader({
      'work-items': [
        createScanPage([], cursor),
        createScanPage([], cursor),
      ],
    })
    await expect(runBridge(loopReader)).rejects.toMatchObject({ code: 'AWS_PAGE_INVALID' })
  })

  test('enforces one raw page budget across empty and auxiliary pages', async () => {
    const firstCursor = { cursor: { S: 'first-private-cursor' } }
    const secondCursor = { cursor: { S: 'second-private-cursor' } }
    const reader = new FixtureAwsReader({
      'work-items': [createScanPage([])],
      'work-item-configuration': [createScanPage([])],
      'project-directory': [createScanPage([])],
      'workspace-access': [createScanPage([])],
      'audit-events': [createScanPage([])],
      'file-proofing': [
        createScanPage([], firstCursor),
        createScanPage([toRawItem({
          entryType: 'annotation',
          scopeKey: 'private-auxiliary-scope',
          recordKey: 'ANNOTATION#private-auxiliary-record',
        })], secondCursor),
      ],
    })

    const result = await runBridge(reader, {
      maxItems: 7,
      maxPages: 7,
      pageSize: 1,
    })

    expect(result.status).toBe('fail')
    expect(result.failureCodes).toContain('INTEGRITY_LIMIT_EXCEEDED')
    expect(verifyCrossDomainIntegrityResult(result, DIGEST_KEY)).toBe(true)
    expect(reader.scanRequests).toHaveLength(7)
    expect(exactS3OperationCount(reader)).toBe(0)
  })

  test('does not read S3 when the last allowed File page proves the scan incomplete', async () => {
    const nextCursor = { cursor: { S: 'file-overflow-private-cursor' } }
    const reader = new FixtureAwsReader({
      'work-items': [createScanPage([])],
      'work-item-configuration': [createScanPage([])],
      'project-directory': [createScanPage([])],
      'workspace-access': [createScanPage([])],
      'audit-events': [createScanPage([])],
      'file-proofing': [createScanPage([toRawItem(createFileRow())], nextCursor)],
    })

    const result = await runBridge(reader, {
      maxItems: 6,
      maxPages: 6,
      pageSize: 1,
    })

    expect(result.status).toBe('fail')
    expect(result.failureCodes).toContain('INTEGRITY_LIMIT_EXCEEDED')
    expect(verifyCrossDomainIntegrityResult(result, DIGEST_KEY)).toBe(true)
    expect(reader.scanRequests).toHaveLength(6)
    expect(exactS3OperationCount(reader)).toBe(0)
  })

  test('rejects invalid direct-hook limits before any AWS read', async () => {
    for (const options of [
      { pageSize: 1_001 },
      { maxPages: 10_001 },
      { maxItems: 1_000_001 },
      { maxItems: 1, maxPages: 1_001, pageSize: 1_000 },
      { maxItems: 2, maxPages: 1, pageSize: 1 },
    ] satisfies readonly RunBridgeOptions[]) {
      const reader = new FixtureAwsReader({})

      await expect(runBridge(reader, options)).rejects.toBeInstanceOf(TypeError)
      expect(reader.scanRequests).toHaveLength(0)
      expect(exactS3OperationCount(reader)).toBe(0)
    }
  })

  test('rejects invalid or reused bridge keys before any AWS read', async () => {
    for (const options of [
      { digestKey: new Uint8Array(31) },
      { digestKey: new Uint8Array(33) },
      { auditPseudonymKey: new Uint8Array(31) },
      { auditPseudonymKey: new Uint8Array(33) },
      {
        auditPseudonymKey: new Uint8Array(DIGEST_KEY),
        digestKey: DIGEST_KEY,
      },
    ] satisfies readonly RunBridgeOptions[]) {
      const reader = new FixtureAwsReader({})

      await expect(runBridge(reader, options)).rejects.toMatchObject({
        code: 'KEY_CONFIGURATION_INVALID',
        message: 'KEY_CONFIGURATION_INVALID',
        name: 'CrossDomainIntegrityAwsBridgeFailure',
      })
      expect(reader.scanRequests).toHaveLength(0)
      expect(exactS3OperationCount(reader)).toBe(0)
    }
  })

  test('enforces exact response versions and independently checks upload tags', async () => {
    const pages = createPagesFromNativeRows(createHealthyNativeRows())
    const substitutedVersionReader = new FixtureAwsReader(pages, {
      echoedVersionId: 'substituted-object-version-private-canary',
    })
    await expect(runBridge(substitutedVersionReader)).rejects.toMatchObject({
      code: 'NORMALIZATION_FAILED',
    })

    const pendingUploadReader = new FixtureAwsReader(pages, { uploadState: 'pending' })
    const pendingUploadResult = await runBridge(pendingUploadReader)
    expect(pendingUploadResult.failureCodes).toContain('FILE_METADATA_OBJECT_MISMATCH')
  })

  test('compares isolated S3 copies without requiring physical Version ID reuse', async () => {
    const secondVersionId = 'version-two-private-canary'
    const sourceVersions = [
      createFileVersion(),
      createFileVersion({
        id: secondVersionId,
        number: 2,
        objectVersionId: 'source-object-version-two-private-canary',
      }),
    ]
    const source = await runBridge(new FixtureAwsReader(
      createPagesFromNativeRows(createHealthyNativeRows({
        fileRows: [createFileRow({}, sourceVersions)],
      })),
    ))
    const restoredObjectVersionId = 'isolated-restore-object-version-private-canary'
    const restoredVersions = [
      createFileVersion({ objectVersionId: restoredObjectVersionId }),
      createFileVersion({
        id: secondVersionId,
        number: 2,
        objectVersionId: 'isolated-restore-object-version-two-private-canary',
      }),
    ]
    const restoredRows = createHealthyNativeRows({
      fileRows: [createFileRow({}, restoredVersions)],
    })
    const restoreReader = new FixtureAwsReader(
      createPagesFromNativeRows(restoredRows),
    )
    const restore = await runBridge(restoreReader, {
      resourceIdentities: RESTORE_RESOURCE_IDENTITIES,
      resourceIdentityDigest: RESTORE_RESOURCE_IDENTITY_DIGEST,
      role: 'restore',
    })

    const restoredReferences: CrossDomainIntegrityObjectVersionReference[] = [
      {
        bucket: 'file',
        key: OBJECT_KEY,
        versionId: restoredObjectVersionId,
      },
      {
        bucket: 'file',
        key:
          `workspaces/${WORKSPACE_ID}/files/${FILE_ID}/${secondVersionId}/design.pdf`,
        versionId: 'isolated-restore-object-version-two-private-canary',
      },
    ]
    expect(restoreReader.headReferences).toEqual(restoredReferences)
    expect(restoreReader.attributeReferences).toEqual(restoredReferences)
    expect(restoreReader.taggingReferences).toEqual(restoredReferences)
    expect(compareCrossDomainIntegrityResults(source, restore, DIGEST_KEY)).toEqual({
      kind: 'mukuroji-cross-domain-integrity-comparison',
      contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
      status: 'pass',
      failureCodes: [],
    })

    const changedRows = createHealthyNativeRows({
      fileRows: [createFileRow(
        { name: 'changed-logical-metadata.pdf' },
        restoredVersions,
      )],
    })
    const changedRestore = await runBridge(new FixtureAwsReader(
      createPagesFromNativeRows(changedRows),
    ), {
      resourceIdentities: RESTORE_RESOURCE_IDENTITIES,
      resourceIdentityDigest: RESTORE_RESOURCE_IDENTITY_DIGEST,
      role: 'restore',
    })
    expect(compareCrossDomainIntegrityResults(
      source,
      changedRestore,
      DIGEST_KEY,
    ).failureCodes).toEqual(['RESTORE_FILE_DIFFERENCE'])
  })

  test('signs a stable missing-object failure for a HeadObject NotFound', async () => {
    const notFound = new Error('raw-s3-not-found-private-canary')
    notFound.name = 'NotFound'
    const reader = new FixtureAwsReader(
      createPagesFromNativeRows(createHealthyNativeRows()),
      { headError: notFound },
    )

    const result = await runBridge(reader)

    expect(result.status).toBe('fail')
    expect(result.failureCodes).toContain('FILE_METADATA_OBJECT_MISSING')
    expect(verifyCrossDomainIntegrityResult(result, DIGEST_KEY)).toBe(true)
    expect(JSON.stringify(result)).not.toContain(
      'raw-s3-not-found-private-canary',
    )
  })

  test('accepts an expired File tombstone without issuing any S3 request', async () => {
    const retentionUntil = '2026-08-01T12:00:00.000Z'
    const tombstone = createFileRow({
      deletedAt: '2026-08-01T00:30:00.000Z',
      retentionUntil,
      expiresAt: Math.floor(Date.parse(retentionUntil) / 1_000),
    })
    const reader = new FixtureAwsReader(createPagesFromNativeRows(
      createHealthyNativeRows({ fileRows: [tombstone] }),
    ))

    const result = await runBridge(reader)

    expect(result.status).toBe('pass')
    expect(exactS3OperationCount(reader)).toBe(0)
  })

  test('treats an older live Audit reference followed by deletion as historical', async () => {
    const historicalWorkItemId = 'historical-work-item-private-canary'
    const reader = new FixtureAwsReader(createPagesFromNativeRows(createHealthyNativeRows({
      auditRows: [
        createWorkItemAuditRow(
          '2026-08-01T00:05:00.000Z',
          'created',
          historicalWorkItemId,
        ),
        createWorkItemAuditRow(
          '2026-08-01T00:06:00.000Z',
          'deleted',
          historicalWorkItemId,
        ),
      ],
    })))

    const result = await runBridge(reader)

    expect(result.status).toBe('pass')
    expect(result.failureCodes).not.toContain('AUDIT_RESOURCE_MISSING')
    expect(JSON.stringify(result)).not.toContain(historicalWorkItemId)
  })

  test('accepts a deleted File event after its TTL-managed metadata is gone', async () => {
    const reader = new FixtureAwsReader(createPagesFromNativeRows(createHealthyNativeRows({
      auditRows: [createFileDeletedAuditRow()],
      fileRows: [],
    })))

    const result = await runBridge(reader)

    expect(result.status).toBe('pass')
    expect(result.failureCodes).not.toContain('AUDIT_RESOURCE_MISSING')
  })

  test('treats every resource candidate from backfill or migration as historical', async () => {
    for (const source of HISTORICAL_AUDIT_SOURCES) {
      const rows = createHealthyNativeRows({
        auditRows: [createCommentTargetAuditRow(source, 'backfilled')],
        fileRows: [],
      })
      rows['work-items'] = []
      const reader = new FixtureAwsReader(createPagesFromNativeRows(rows))

      const result = await runBridge(reader)

      expect(result.status).toBe('pass')
      expect(result.failureCodes).not.toContain('AUDIT_RESOURCE_MISSING')
    }
  })

  test('still requires a current entity when only an Audit target was deleted', async () => {
    const rows = createHealthyNativeRows({
      auditRows: [createCommentTargetAuditRow('system', 'deleted')],
      fileRows: [],
    })
    rows['work-items'] = []
    const reader = new FixtureAwsReader(createPagesFromNativeRows(rows))

    const result = await runBridge(reader)

    expect(result.status).toBe('fail')
    expect(result.failureCodes).toContain('AUDIT_RESOURCE_MISSING')
  })

  test('does not treat lifecycle-marker substrings as resource deletion', async () => {
    const rows = createHealthyNativeRows({
      auditRows: [createWorkItemAuditRow(
        '2026-08-01T00:08:00.000Z',
        'deleted-label',
        'missing-work-item-private-canary',
      )],
      fileRows: [],
    })
    rows['work-items'] = []
    const reader = new FixtureAwsReader(createPagesFromNativeRows(rows))

    const result = await runBridge(reader)

    expect(result.status).toBe('fail')
    expect(result.failureCodes).toContain('AUDIT_RESOURCE_MISSING')
  })

  test('detects tenant mismatch when a real Workspace equals the primary sentinel', async () => {
    const sentinelWorkspaceId = 'audit-tenant-boundary-mismatch'
    const auditRow = createWorkItemAuditRow(
      '2026-08-01T00:06:00.000Z',
      'deleted',
      'historical-work-item-private-canary',
      sentinelWorkspaceId,
    )
    const rows: NativeRowsByTarget = {
      'work-items': [],
      'work-item-configuration': [],
      'project-directory': [],
      'workspace-access': [],
      'audit-events': [{ ...auditRow, directoryId: 'cross-tenant-private-canary' }],
      'file-proofing': [],
    }
    const reader = new FixtureAwsReader(createPagesFromNativeRows(rows))

    const result = await runBridge(reader)

    expect(result.failureCodes).toContain('AUDIT_TENANT_MISMATCH')
    expect(JSON.stringify(result)).not.toContain('cross-tenant-private-canary')
  })

  test('accounts for File expansion instead of raw row count at the item boundary', async () => {
    const fileOnlyRows: NativeRowsByTarget = {
      'work-items': [],
      'work-item-configuration': [],
      'project-directory': [],
      'workspace-access': [],
      'audit-events': [],
      'file-proofing': [createFileRow()],
    }
    const reader = new FixtureAwsReader(createPagesFromNativeRows(fileOnlyRows))

    const result = await runBridge(reader, { maxItems: 3, pageSize: 1 })

    expect(result.failureCodes).not.toContain('INTEGRITY_LIMIT_EXCEEDED')
    expect(result.evidence.itemCount).toBe(3)
    expect(exactS3OperationCount(reader)).toBe(3)
  })

  test('fails closed before S3 when one File row would exceed the total evidence bound', async () => {
    const versions = [
      createFileVersion({ id: 'version-private-1', number: 1 }),
      createFileVersion({ id: 'version-private-2', number: 2 }),
      createFileVersion({ id: 'version-private-3', number: 3 }),
    ]
    const fileOnlyRows: NativeRowsByTarget = {
      'work-items': [],
      'work-item-configuration': [],
      'project-directory': [],
      'workspace-access': [],
      'audit-events': [],
      'file-proofing': [createFileRow({}, versions)],
    }
    const reader = new FixtureAwsReader(createPagesFromNativeRows(fileOnlyRows))
    const maxItems = 8

    const result = await runBridge(reader, { maxItems })

    expect(result.failureCodes).toContain('INTEGRITY_LIMIT_EXCEEDED')
    expect(result.evidence.itemCount).toBeLessThanOrEqual(maxItems)
    expect(exactS3OperationCount(reader)).toBeLessThanOrEqual(3 * maxItems)
    expect(exactS3OperationCount(reader)).toBe(0)
  })

  test('bounds a pending raw AWS page and aborts it with the shared signal', async () => {
    let observedSignal: AbortSignal | undefined
    const reader: CrossDomainIntegrityManagedAwsReadPort = {
      /** Releases no resources for this pending-request fixture. */
      close(): void {},
      /** Must remain unreachable before the first raw Scan completes. */
      async getObjectAttributes(): Promise<never> {
        throw new Error('Unexpected object attributes request.')
      },
      /** Must remain unreachable before the first raw Scan completes. */
      async getObjectTagging(): Promise<never> {
        throw new Error('Unexpected object tagging request.')
      },
      /** Must remain unreachable before the first raw Scan completes. */
      async headObject(): Promise<never> {
        throw new Error('Unexpected object head request.')
      },
      /** Returns the fixed account unused by the bridge. */
      async readCallerAccount(): Promise<string> {
        return '123456789012'
      },
      /** Waits until the bridge's finite request deadline aborts the Scan. */
      async scanPage(_target, _cursor, signal): Promise<ScanCommandOutput> {
        observedSignal = signal
        if (signal === undefined) throw new Error('Expected a finite signal.')
        return await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('untrusted raw adapter abort detail'))
          }, { once: true })
        })
      },
    }

    const failure = await runBridge(reader, {
      maximumDurationMilliseconds: 5,
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(CrossDomainIntegrityDeadlineFailure)
    if (!(failure instanceof CrossDomainIntegrityDeadlineFailure)) {
      throw new Error('Expected a deadline failure.')
    }
    expect(failure.code).toBe('DEADLINE_EXCEEDED')
    expect(observedSignal?.aborted).toBe(true)
  })
})
