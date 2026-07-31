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
  PLANNING_SCHEMA_VERSION,
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
} from '@mukuroji/contracts'
import {
  createAuditEvent,
  createMutationAuditContext,
  createWorkspaceMemberAuditEntityIdFromKeyBytes,
} from '../../src/modules/audit'
import {
  CrossDomainIntegrityAwsBridgeFailure,
  runCrossDomainIntegrityAwsCheck,
} from './cross-domain-integrity-aws'
import {
  calculateCrossDomainIntegrityResourceIdentityDigest,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS,
  verifyCrossDomainIntegrityResult,
  type CrossDomainIntegrityResourceIdentity,
} from './cross-domain-integrity'
import type {
  CrossDomainIntegrityManagedAwsReadPort,
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
  /** Fixed page size shared with the pure checker. */
  readonly pageSize?: number
}

/** Optional fields for one immutable File version fixture. */
type FileVersionOptions = {
  /** Immutable File-domain version ID. */
  readonly id?: string
  /** Monotonic File-domain version number. */
  readonly number?: number
  /** Stored scan status. */
  readonly scanStatus?: 'available' | 'blocked' | 'failed' | 'pending' | 'scanning'
}

/** Fake read-only AWS port retaining requests for exact-read assertions. */
class FixtureAwsReader implements CrossDomainIntegrityManagedAwsReadPort {
  /** Exact GetObjectAttributes references received by the reader. */
  readonly attributeReferences: CrossDomainIntegrityObjectVersionReference[] = []

  /** Exact GetObjectTagging references received by the reader. */
  readonly taggingReferences: CrossDomainIntegrityObjectVersionReference[] = []

  /** Exact HeadObject references received by the reader. */
  readonly headReferences: CrossDomainIntegrityObjectVersionReference[] = []

  /** Raw scan calls in invocation order. */
  readonly scanRequests: CapturedScanRequest[] = []

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
  ): Promise<GetObjectAttributesCommandOutput> {
    this.attributeReferences.push(reference)
    return {
      $metadata: {},
      ObjectSize: 4_096,
      VersionId: this.options.echoedVersionId ?? reference.versionId,
    }
  }

  /** Returns scan and upload tags for the exact requested immutable version. */
  async getObjectTagging(
    reference: CrossDomainIntegrityObjectVersionReference,
  ): Promise<GetObjectTaggingCommandOutput> {
    this.taggingReferences.push(reference)
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
  ): Promise<HeadObjectCommandOutput> {
    this.headReferences.push(reference)
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

  /** Returns the next configured raw page for one target. */
  async scanPage(
    target: CrossDomainIntegrityTableTarget,
    exclusiveStartKey?: Record<string, AttributeValue>,
  ): Promise<ScanCommandOutput> {
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
      nameJa: 'チーム',
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
      nameJa: 'プロジェクト',
      nameEn: 'Project',
      tone: 'blue',
    },
  ]
}

/** Creates Workspace metadata, member, and planning revision rows. */
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
    {
      workspaceId: WORKSPACE_ID,
      recordKey: 'META',
      entryType: 'planning-meta',
      schemaVersion: PLANNING_SCHEMA_VERSION,
      revision: 1,
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
  action: 'created' | 'deleted' | 'updated',
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
    objectVersionId: number === 1 ? OBJECT_VERSION_ID : `${OBJECT_VERSION_ID}-${number}`,
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
  return runCrossDomainIntegrityAwsCheck({
    auditPseudonymKey: options.auditPseudonymKey ?? AUDIT_PSEUDONYM_KEY,
    checkedAt: CHECKED_AT,
    digestKey: options.digestKey ?? DIGEST_KEY,
    maxPages: options.maxPages ?? 100,
    maxItems: options.maxItems ?? 100,
    pageSize: options.pageSize ?? 100,
    reader,
    resourceBindingDigest: 'b'.repeat(64),
    resourceIdentities: RESOURCE_IDENTITIES,
    resourceIdentityDigest: RESOURCE_IDENTITY_DIGEST,
    role: 'source',
  })
}

/** Returns the total number of exact S3 operations issued by a fake reader. */
function exactS3OperationCount(reader: FixtureAwsReader): number {
  return reader.headReferences.length + reader.attributeReferences.length +
    reader.taggingReferences.length
}

describe('cross-domain integrity AWS composition bridge', () => {
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

  test('keeps a missing member historical when a later deactivation event exists', async () => {
    const removedMemberKey = 'removed-member-private-canary@example.test'
    const reader = new FixtureAwsReader(createPagesFromNativeRows(createHealthyNativeRows({
      auditRows: [
        createWorkspaceMemberAuditRow(
          '2026-08-01T00:08:00.000Z',
          removedMemberKey,
        ),
        createWorkspaceMemberAuditRow(
          '2026-08-01T00:09:00.000Z',
          removedMemberKey,
          'deactivated',
        ),
      ],
    })))

    const result = await runBridge(reader)

    expect(result.failureCodes).not.toContain('AUDIT_RESOURCE_MISSING')
    expect(JSON.stringify(result)).not.toContain(removedMemberKey)
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
})
