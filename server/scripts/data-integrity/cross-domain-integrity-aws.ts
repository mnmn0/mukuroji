import { createHmac, timingSafeEqual } from 'node:crypto'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import type {
  GetObjectAttributesCommandOutput,
  GetObjectTaggingCommandOutput,
  HeadObjectCommandOutput,
  Tag,
} from '@aws-sdk/client-s3'
import { WORK_ITEM_CONFIGURATION_SCHEMA_VERSION } from '@mukuroji/contracts'
import {
  createAuditActorKey,
  createAuditEntityKey,
  createWorkspaceMemberAuditEntityIdFromKeyBytes,
  upcastAuditEvent,
  type AuditEventV1,
} from '../../src/modules/audit'
import {
  checkFileMetadataIntegrity,
  isMissingFileObjectVersionError,
  mapGuardDutyScanStatus,
  parseFileIntegrityReferences,
  type FileIntegrityObjectObservation,
  type FileIntegrityReference,
  type FileMetadataIntegrityFailureCode,
} from '../../src/modules/files'
import {
  createWorkItemConfigurationScopeKey,
  isCanonicalWorkItemRecord,
  validateWorkItemConfiguration,
} from '../../src/modules/work-items'
import {
  decodeAttributeMap,
  decodeAttributeMapToNativeRecord,
  encodeUnknownAttributeMap,
  serializeCanonicalAttributeMap,
} from '../migrations/workspace-search-v1/dynamodb-attribute-codec'
import {
  CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
  runCrossDomainIntegrityCheck,
  validateCrossDomainIntegrityLimits,
  type CrossDomainAuditReference,
  type CrossDomainExternalFileEvidence,
  type CrossDomainIntegrityItem,
  type CrossDomainIntegrityPage,
  type CrossDomainIntegrityPageRequest,
  type CrossDomainIntegrityReadPort,
  type CrossDomainIntegrityResult,
  type CrossDomainRelationType,
} from './cross-domain-integrity'
import type {
  CrossDomainIntegrityCheckBridgeInput,
  CrossDomainIntegrityObjectVersionReference,
  CrossDomainIntegrityTableTarget,
} from './cross-domain-integrity-aws-types'

const AUDIT_TENANT_MISMATCH_SENTINEL = 'audit-tenant-boundary-mismatch'
const AUDIT_TENANT_MISMATCH_ALTERNATE_SENTINEL = 'audit-tenant-boundary-mismatch-alternate'
const UNVERIFIED_OBJECT_VERSION_PREFIX = 'unverified:'
/** Exact writer-owned lifecycle tuples whose target may no longer be current. */
const historicalAuditTargetLifecycles = Object.freeze([
  { eventType: 'file.deleted', action: 'deleted', targetType: 'file' },
  { eventType: 'work-item.deleted', action: 'deleted', targetType: 'work-item' },
])

const tableScanOrder: readonly CrossDomainIntegrityTableTarget[] = [
  'work-items',
  'work-item-configuration',
  'project-directory',
  'workspace-access',
  'audit-events',
  'file-proofing',
]

const knownProjectDirectoryAuxiliaryEntryTypes = new Set([
  'email-alias',
  'planning-meta',
  'project-member',
  'webhook-active-locator-rollback-checkpoint',
  'webhook-authorization-backfill-checkpoint',
  'webhook-team-grant',
  'webhook-team-grant-cleanup',
  'workspace-member',
  'workspace-metadata',
])

const knownFileProofingAuxiliaryEntryTypes = new Set([
  'annotation',
  'approval',
  'approval-summary',
  'download',
  'file-approval-index',
  'reviewer-approval',
])

/** One validated low-level DynamoDB scan page. */
type RawScanPage = {
  /** Strictly validated raw DynamoDB items. */
  readonly items: readonly Record<string, AttributeValue>[]
  /** Strictly validated continuation key. */
  readonly nextKey?: Record<string, AttributeValue>
}

/** Mutable state retained only for one composition-bridge invocation. */
type BridgeCollection = {
  /** Maximum combined normalized and externally checked items retained. */
  readonly itemCapacity: number
  /** Maximum number of raw DynamoDB pages allowed across every table. */
  readonly rawPageCapacity: number
  /** Normalized cross-domain records passed to the pure checker. */
  readonly items: CrossDomainIntegrityItem[]
  /** Per-File-row HMACs used to create page-order-independent external evidence. */
  readonly fileRowDigests: string[]
  /** Audit references retained until latest-resource lifecycle can be resolved. */
  readonly pendingAuditReferences: PendingAuditReference[]
  /** Canonical member pseudonyms resolved from Workspace Access rows. */
  readonly workspaceMembersByAuditEntityId: Map<string, WorkspaceMemberAuditIdentity>
  /** Stable failures emitted by the independently implemented File checker. */
  readonly fileFailureCodes: Set<FileMetadataIntegrityFailureCode>
  /** Number of strictly parsed File versions evaluated by the File checker. */
  checkedFileVersionCount: number
  /** Number of exact object versions for which three fixed S3 reads were issued. */
  exactObjectVersionReadCount: number
  /** Number of raw DynamoDB pages read across every table. */
  rawPageCount: number
  /** Whether collection stopped after retaining the single overflow item. */
  limitReached: boolean
}

/** Inputs needed while normalizing one File Proofing row. */
type FileRowNormalizationInput = {
  /** Canonical timestamp shared with the whole check. */
  readonly checkedAt: string
  /** Invocation-local collection. */
  readonly collection: BridgeCollection
  /** Dedicated in-memory evidence HMAC key. */
  readonly digestKey: Uint8Array
  /** Raw low-level row used only as HMAC input. */
  readonly rawItem: Readonly<Record<string, AttributeValue>>
  /** Narrow exact-version AWS reader. */
  readonly reader: CrossDomainIntegrityCheckBridgeInput['reader']
  /** Strict native File row. */
  readonly row: Record<string, unknown>
}

/** Process-local audit candidate before the latest-resource lifecycle is resolved. */
type PendingAuditReference = {
  /** Stable event ordering key. */
  readonly eventOrder: string
  /** Event ID retained only inside aggregate HMAC input. */
  readonly eventId: string
  /** Whether this event itself is explicitly historical. */
  readonly historical: boolean
  /** Stable process-local identity for latest-event selection. */
  readonly resourceIdentity: string
  /** Joinable normalized reference. */
  readonly reference: Omit<CrossDomainAuditReference, 'resourceState'>
}

/** Private in-process join target for one Workspace member Audit pseudonym. */
type WorkspaceMemberAuditIdentity = {
  /** Canonical member key retained only inside the checker process. */
  readonly memberKey: string
  /** Workspace owning the canonical member row. */
  readonly workspaceId: string
}

/** A validated S3 observation plus the three exact-version responses. */
type ObservedFileObject = {
  /** Evidence-safe observation consumed by the File checker. */
  readonly observation: FileIntegrityObjectObservation
  /** Exact-version attributes response. */
  readonly attributes: GetObjectAttributesCommandOutput
  /** Exact-version HEAD response. */
  readonly head: HeadObjectCommandOutput
  /** Exact-version tagging response. */
  readonly tagging: GetObjectTaggingCommandOutput
}

/** A stable raw-data-free composition failure. */
export class CrossDomainIntegrityAwsBridgeFailure extends Error {
  /** Stable machine-readable failure category. */
  readonly code:
    | 'AWS_PAGE_INVALID'
    | 'KEY_CONFIGURATION_INVALID'
    | 'NORMALIZATION_FAILED'

  /**
   * Creates a raw-data-free bridge failure.
   *
   * @param code - Stable raw-data-free failure category.
   */
  constructor(
    code:
      | 'AWS_PAGE_INVALID'
      | 'KEY_CONFIGURATION_INVALID'
      | 'NORMALIZATION_FAILED',
  ) {
    super(code)
    this.name = 'CrossDomainIntegrityAwsBridgeFailure'
    this.code = code
  }
}

/**
 * Runs the production cross-domain checker over bounded raw AWS reads.
 *
 * @param input - Explicit role, timestamp, bounds, digest key, binding digest, and AWS reader.
 * @returns Secret-free aggregate checker evidence.
 */
export async function runCrossDomainIntegrityAwsCheck(
  input: CrossDomainIntegrityCheckBridgeInput,
): Promise<CrossDomainIntegrityResult> {
  requireCanonicalTimestamp(input.checkedAt)
  validateCrossDomainIntegrityLimits({
    maxItems: input.maxItems,
    maxPages: input.maxPages,
    pageSize: input.pageSize,
  })
  validateBridgeKeys(input.digestKey, input.auditPseudonymKey)
  const collection = createBridgeCollection(input.maxItems, input.maxPages)
  for (const target of tableScanOrder) {
    await scanAndNormalizeTable(input, target, collection)
    if (collection.limitReached) break
  }
  finalizePendingAuditReferences(collection)
  const externalFileEvidence = createExternalFileEvidence(input.digestKey, collection)
  return runCrossDomainIntegrityCheck({
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    checkedAt: input.checkedAt,
    role: input.role,
    digestKey: input.digestKey,
    resourceBindingDigest: input.resourceBindingDigest,
    resourceIdentities: input.resourceIdentities,
    resourceIdentityDigest: input.resourceIdentityDigest,
    limits: {
      maxPages: input.maxPages,
      maxItems: input.maxItems,
      pageSize: input.pageSize,
    },
    reader: createNormalizedReadPort(collection.items, collection.limitReached),
    externalFileEvidence,
  })
}

/**
 * Validates independent fixed-size key domains before any external read.
 *
 * @param digestKey - Dedicated evidence HMAC key bytes.
 * @param auditPseudonymKey - Existing Workspace Audit pseudonym key bytes.
 */
function validateBridgeKeys(
  digestKey: Uint8Array,
  auditPseudonymKey: Uint8Array,
): void {
  if (
    digestKey.byteLength !== 32 ||
    auditPseudonymKey.byteLength !== 32 ||
    timingSafeEqual(digestKey, auditPseudonymKey)
  ) {
    throw new CrossDomainIntegrityAwsBridgeFailure(
      'KEY_CONFIGURATION_INVALID',
    )
  }
}

/**
 * Creates invocation-local bounded collection state.
 *
 * @param maxItems - Maximum normalized and external evidence item count.
 * @param maxPages - Maximum raw page count shared by every table.
 * @returns Empty bounded collection state.
 */
function createBridgeCollection(maxItems: number, maxPages: number): BridgeCollection {
  return {
    itemCapacity: maxItems,
    rawPageCapacity: maxPages,
    items: [],
    fileRowDigests: [],
    pendingAuditReferences: [],
    workspaceMembersByAuditEntityId: new Map(),
    fileFailureCodes: new Set<FileMetadataIntegrityFailureCode>(),
    checkedFileVersionCount: 0,
    exactObjectVersionReadCount: 0,
    rawPageCount: 0,
    limitReached: false,
  }
}

/** Scans one complete logical table and normalizes each raw row. */
async function scanAndNormalizeTable(
  input: CrossDomainIntegrityCheckBridgeInput,
  target: CrossDomainIntegrityTableTarget,
  collection: BridgeCollection,
): Promise<void> {
  const seenCursors = new Set<string>()
  let exclusiveStartKey: Record<string, AttributeValue> | undefined
  do {
    if (collection.rawPageCount >= collection.rawPageCapacity) {
      collection.limitReached = true
      return
    }
    collection.rawPageCount += 1
    const output = await input.reader.scanPage(target, exclusiveStartKey)
    const page = parseRawScanPage(output, input.pageSize)
    if (collection.rawPageCount === collection.rawPageCapacity && page.nextKey) {
      collection.limitReached = true
      return
    }
    for (const rawItem of page.items) {
      const row = runNormalizationBoundary(() => decodeAttributeMapToNativeRecord(rawItem))
      const normalized = await normalizeRow(target, row, rawItem, input, collection)
      appendNormalizedItems(collection, normalized)
      if (collection.limitReached) return
    }
    exclusiveStartKey = page.nextKey
    if (exclusiveStartKey) {
      const cursorFingerprint = serializeCanonicalAttributeMap(exclusiveStartKey)
      if (seenCursors.has(cursorFingerprint)) {
        throw new CrossDomainIntegrityAwsBridgeFailure('AWS_PAGE_INVALID')
      }
      seenCursors.add(cursorFingerprint)
    }
  } while (exclusiveStartKey)
}

/** Parses and validates a low-level DynamoDB Scan response. */
function parseRawScanPage(value: unknown, pageSize: number): RawScanPage {
  try {
    const record = requireRecord(value)
    const rawItems = record.Items === undefined ? [] : requireArray(record.Items)
    if (rawItems.length > pageSize) {
      throw new CrossDomainIntegrityAwsBridgeFailure('AWS_PAGE_INVALID')
    }
    const items = rawItems.map(parseRawAttributeMap)
    if (record.Count !== undefined && record.Count !== items.length) {
      throw new CrossDomainIntegrityAwsBridgeFailure('AWS_PAGE_INVALID')
    }
    if (
      record.ScannedCount !== undefined &&
      (!isNonNegativeSafeInteger(record.ScannedCount) || record.ScannedCount > pageSize ||
        record.ScannedCount < items.length)
    ) {
      throw new CrossDomainIntegrityAwsBridgeFailure('AWS_PAGE_INVALID')
    }
    if (record.LastEvaluatedKey === undefined) return { items }
    const nextKey = parseRawAttributeMap(record.LastEvaluatedKey)
    if (Object.keys(nextKey).length === 0) {
      throw new CrossDomainIntegrityAwsBridgeFailure('AWS_PAGE_INVALID')
    }
    return { items, nextKey }
  } catch (error) {
    if (
      error instanceof CrossDomainIntegrityAwsBridgeFailure &&
      error.code === 'AWS_PAGE_INVALID'
    ) throw error
    throw new CrossDomainIntegrityAwsBridgeFailure('AWS_PAGE_INVALID')
  }
}

/** Reconstructs a strictly validated low-level DynamoDB attribute map. */
function parseRawAttributeMap(value: unknown): Record<string, AttributeValue> {
  try {
    return decodeAttributeMap(encodeUnknownAttributeMap(value))
  } catch {
    throw new CrossDomainIntegrityAwsBridgeFailure('AWS_PAGE_INVALID')
  }
}

/** Dispatches one native row to its owning schema normalizer. */
async function normalizeRow(
  target: CrossDomainIntegrityTableTarget,
  row: Record<string, unknown>,
  rawItem: Readonly<Record<string, AttributeValue>>,
  input: CrossDomainIntegrityCheckBridgeInput,
  collection: BridgeCollection,
): Promise<CrossDomainIntegrityItem[]> {
  if (target === 'work-items') return normalizeWorkItem(row)
  if (target === 'work-item-configuration') return normalizeConfigurationRow(row)
  if (target === 'project-directory') return normalizeProjectDirectoryRow(row)
  if (target === 'workspace-access') {
    const items = normalizeWorkspaceAccessRow(row)
    indexWorkspaceMemberAuditIdentities(
      items,
      input.auditPseudonymKey,
      collection.workspaceMembersByAuditEntityId,
    )
    return items
  }
  if (target === 'audit-events') {
    appendPendingAuditReferences(
      collection,
      normalizeAuditRow(row, collection.workspaceMembersByAuditEntityId),
    )
    return []
  }
  return normalizeFileRow({
    checkedAt: input.checkedAt,
    collection,
    digestKey: input.digestKey,
    rawItem,
    reader: input.reader,
    row,
  })
}

/** Strictly normalizes one canonical Work Item row. */
function normalizeWorkItem(row: Record<string, unknown>): CrossDomainIntegrityItem[] {
  if (!isCanonicalWorkItemRecord(row)) {
    throw new CrossDomainIntegrityAwsBridgeFailure('NORMALIZATION_FAILED')
  }
  if (row.deletedAt !== undefined) {
    const deletedAt = requireCanonicalTimestamp(row.deletedAt)
    if (deletedAt < row.createdAt || deletedAt > row.updatedAt) {
      return normalizationFailure()
    }
    return []
  }
  return [{
    kind: 'work-item',
    workspaceId: row.directoryId,
    teamId: row.teamId,
    workItemId: row.issueId,
    creatorMemberKey: row.creatorMemberKey,
    workflowStatusId: row.workflowStatusId,
    statusCategory: row.statusCategory,
    projectId: row.assignedProjectId ?? null,
    relationIds: [...row.relationIds],
  }]
}

/** Strictly normalizes Configuration and relation-graph rows. */
function normalizeConfigurationRow(row: Record<string, unknown>): CrossDomainIntegrityItem[] {
  const recordKey = requireText(row.recordKey)
  if (recordKey === 'CONFIG') {
    const scopeType = row.scopeType
    if (scopeType !== 'workspace' && scopeType !== 'team') return normalizationFailure()
    const scopeId = requireText(row.scopeId)
    const configuration = runNormalizationBoundary(() =>
      validateWorkItemConfiguration(row, { scopeType, scopeId })
    )
    if (configuration.revision < 1) return normalizationFailure()
    const scope = parseConfigurationScope(requireText(row.scopeKey), scopeType, scopeId)
    return [{
      kind: 'configuration',
      workspaceId: scope.workspaceId,
      teamId: scope.teamId,
      workflowStatuses: configuration.workflow.statuses.map((status) => ({
        statusId: status.id,
        category: status.category,
      })),
    }]
  }
  if (row.entryType === 'relation') {
    const scope = parseConfigurationScope(requireText(row.scopeKey), 'team')
    const relationType = requireRelationType(row.type)
    const sourceWorkItemId = requireText(row.sourceWorkItemId)
    const targetWorkItemId = requireText(row.targetWorkItemId)
    requireCanonicalTimestamp(row.createdAt)
    const expectedRecordKey = `REL#${encodeURIComponent(sourceWorkItemId)}#` +
      `${encodeURIComponent(relationType)}#${encodeURIComponent(targetWorkItemId)}`
    if (recordKey !== expectedRecordKey || scope.teamId === null) return normalizationFailure()
    return [{
      kind: 'relation',
      workspaceId: scope.workspaceId,
      teamId: scope.teamId,
      sourceWorkItemId,
      targetWorkItemId,
      relationType,
    }]
  }
  if (row.entryType === 'relation-graph') {
    const scope = parseConfigurationScope(requireText(row.scopeKey), 'team')
    if (
      recordKey !== 'RELATION_GRAPH' || scope.teamId === null ||
      row.schemaVersion !== WORK_ITEM_CONFIGURATION_SCHEMA_VERSION ||
      !isPositiveSafeInteger(row.revision)
    ) return normalizationFailure()
    return []
  }
  if (row.entryType === 'configuration-write-lock') {
    parseConfigurationScope(requireText(row.scopeKey))
    if (
      recordKey !== 'CONFIG_WRITE_LOCK' || !isText(row.token) ||
      !isPositiveSafeInteger(row.expiresAtEpochSeconds)
    ) return normalizationFailure()
    return []
  }
  return normalizationFailure()
}

/** Parses a canonical Configuration table scope key. */
function parseConfigurationScope(
  scopeKey: string,
  expectedType?: 'team' | 'workspace',
  expectedScopeId?: string,
): { readonly workspaceId: string; readonly teamId: string | null } {
  const workspaceSuffix = '#work-item-configuration'
  if (scopeKey.endsWith(workspaceSuffix)) {
    const encodedWorkspaceId = scopeKey.slice(0, -workspaceSuffix.length)
    if (!encodedWorkspaceId.includes('#')) {
      const workspaceId = decodeCanonicalIdentifier(encodedWorkspaceId)
      if (
        (expectedType !== undefined && expectedType !== 'workspace') ||
        (expectedScopeId !== undefined && expectedScopeId !== workspaceId) ||
        createWorkItemConfigurationScopeKey(workspaceId, 'workspace') !== scopeKey
      ) return normalizationFailure()
      return { workspaceId, teamId: null }
    }
  }
  const teamMarker = '#team#'
  const teamSuffix = '#work-item-configuration'
  const markerIndex = scopeKey.indexOf(teamMarker)
  if (markerIndex <= 0 || !scopeKey.endsWith(teamSuffix)) return normalizationFailure()
  const encodedWorkspaceId = scopeKey.slice(0, markerIndex)
  const encodedTeamId = scopeKey.slice(markerIndex + teamMarker.length, -teamSuffix.length)
  if (!encodedTeamId || encodedTeamId.includes('#')) return normalizationFailure()
  const workspaceId = decodeCanonicalIdentifier(encodedWorkspaceId)
  const teamId = decodeCanonicalIdentifier(encodedTeamId)
  if (
    (expectedType !== undefined && expectedType !== 'team') ||
    (expectedScopeId !== undefined && expectedScopeId !== teamId) ||
    createWorkItemConfigurationScopeKey(workspaceId, 'team', teamId) !== scopeKey
  ) return normalizationFailure()
  return { workspaceId, teamId }
}

/** Decodes an identifier while requiring canonical percent encoding. */
function decodeCanonicalIdentifier(encoded: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(encoded)
  } catch {
    return normalizationFailure()
  }
  if (!isText(decoded) || encodeURIComponent(decoded) !== encoded) return normalizationFailure()
  return decoded
}

/** Strictly normalizes Team and Project rows while recognizing known auxiliary rows. */
function normalizeProjectDirectoryRow(row: Record<string, unknown>): CrossDomainIntegrityItem[] {
  const workspaceId = requireText(row.directoryId)
  const entryKey = requireText(row.entryKey)
  if (row.entryType === 'team') {
    if (workspaceId.length > 1_024) return normalizationFailure()
    const teamId = requireProjectDirectoryIdentifier(row.teamId)
    if (!isPositiveSafeInteger(row.teamSortOrder)) return normalizationFailure()
    const teamSortOrder = row.teamSortOrder
    validateProjectDirectoryLocalizedNames(row.nameJa, row.nameEn)
    validateProjectDirectoryLifecycle(row)
    if (row.expanded !== undefined && typeof row.expanded !== 'boolean') return normalizationFailure()
    if (entryKey !== `${padSortOrder(teamSortOrder)}#000000#TEAM#${teamId}`) {
      return normalizationFailure()
    }
    return [{ kind: 'team', workspaceId, teamId }]
  }
  if (row.entryType === 'project') {
    if (workspaceId.length > 1_024) return normalizationFailure()
    const teamId = requireProjectDirectoryIdentifier(row.teamId)
    const projectId = requireProjectDirectoryIdentifier(row.projectId)
    if (
      !isPositiveSafeInteger(row.teamSortOrder) ||
      !isPositiveSafeInteger(row.projectSortOrder)
    ) return normalizationFailure()
    const teamSortOrder = row.teamSortOrder
    const projectSortOrder = row.projectSortOrder
    validateProjectDirectoryLocalizedNames(row.nameJa, row.nameEn)
    validateProjectDirectoryLifecycle(row)
    if (!isProjectTone(row.tone)) return normalizationFailure()
    if (
      entryKey !== `${padSortOrder(teamSortOrder)}#${padSortOrder(projectSortOrder)}#PROJECT#${projectId}`
    ) return normalizationFailure()
    return [{ kind: 'project', workspaceId, teamId, projectId }]
  }
  if (!isText(row.entryType) || !knownProjectDirectoryAuxiliaryEntryTypes.has(row.entryType)) {
    return normalizationFailure()
  }
  validateProjectDirectoryAuxiliaryRow(row, workspaceId, entryKey)
  return []
}

/** Reads one canonical Team or Project identifier used by Workspace Search. */
function requireProjectDirectoryIdentifier(value: unknown): string {
  const identifier = requireText(value)
  if (identifier.length > 256 || identifier.includes('/')) {
    return normalizationFailure()
  }
  return identifier
}

/** Validates the localized-name fallback and Workspace Search length contract. */
function validateProjectDirectoryLocalizedNames(
  nameJa: unknown,
  nameEn: unknown,
): void {
  if (typeof nameJa !== 'string' || typeof nameEn !== 'string') {
    return normalizationFailure()
  }
  const visibleNames = [nameJa.trim(), nameEn.trim()].filter(
    (name) => name.length > 0,
  )
  if (
    visibleNames.length === 0 ||
    visibleNames.some((name) => name.length > 500)
  ) normalizationFailure()
}

/** Validates optional Team or Project lifecycle timestamps and their ordering. */
function validateProjectDirectoryLifecycle(
  row: Readonly<Record<string, unknown>>,
): void {
  const archivedAt = requireOptionalCanonicalTimestamp(row.archivedAt)
  const createdAt = requireOptionalCanonicalTimestamp(row.createdAt)
  const updatedAt = requireOptionalCanonicalTimestamp(row.updatedAt)
  if (
    (createdAt !== undefined && updatedAt !== undefined && createdAt > updatedAt) ||
    (archivedAt !== undefined && createdAt !== undefined && archivedAt < createdAt) ||
    (archivedAt !== undefined && updatedAt !== undefined && archivedAt > updatedAt)
  ) normalizationFailure()
}

/** Validates primary identity fields for non-target Project Directory rows. */
function validateProjectDirectoryAuxiliaryRow(
  row: Record<string, unknown>,
  directoryId: string,
  entryKey: string,
): void {
  if (row.entryType === 'webhook-team-grant') {
    const workspaceId = requireText(row.workspaceId)
    const teamId = requireText(row.teamId)
    const projectId = requireText(row.projectId)
    const memberKey = requireText(row.memberKey)
    if (
      directoryId !== `WEBHOOK_TEAM_GRANT#${workspaceId}#${memberKey}` ||
      entryKey !== `TEAM#${teamId}#PROJECT#${projectId}`
    ) normalizationFailure()
    return
  }
  if (row.entryType === 'webhook-team-grant-cleanup') {
    const workspaceId = requireText(row.workspaceId)
    const teamId = requireText(row.teamId)
    const projectId = requireText(row.projectId)
    const memberKey = requireText(row.memberKey)
    if (
      directoryId !== `WEBHOOK_GRANT_CLEANUP#${workspaceId}#${teamId}` ||
      entryKey !== `PROJECT#${projectId}#MEMBER#${memberKey}`
    ) normalizationFailure()
    return
  }
  if (
    isProjectDirectoryTargetEntryKey(entryKey) ||
    (row.workspaceId !== undefined && row.workspaceId !== directoryId) ||
    !isText(row.entryType) || !isText(entryKey)
  ) normalizationFailure()
}

/** Detects an auxiliary discriminator occupying a Team or Project target key. */
function isProjectDirectoryTargetEntryKey(entryKey: string): boolean {
  return /^[0-9]{6,}#000000#TEAM#[^#]+$/u.test(entryKey) ||
    /^[0-9]{6,}#[0-9]{6,}#PROJECT#[^#]+$/u.test(entryKey)
}

/** Recreates the Project Directory's canonical six-character sort prefix. */
function padSortOrder(value: number): string {
  return String(value).padStart(6, '0')
}

/** Strictly normalizes retained Workspace member rows and recognizes invitations. */
function normalizeWorkspaceAccessRow(row: Record<string, unknown>): CrossDomainIntegrityItem[] {
  const workspaceId = requireText(row.workspaceId)
  const recordKey = requireText(row.recordKey)
  if (row.entryType === 'workspace-member') {
    const memberKey = requireText(row.memberKey)
    if (
      recordKey !== `MEMBER#${memberKey}` || row.id !== memberKey ||
      !isText(row.email) || !isWorkspaceRole(row.role) ||
      !isWorkspaceMemberStatus(row.status) || !isPositiveSafeInteger(row.version)
    ) return normalizationFailure()
    const createdAt = requireCanonicalTimestamp(row.createdAt)
    const updatedAt = requireCanonicalTimestamp(row.updatedAt)
    if (updatedAt < createdAt) return normalizationFailure()
    if (row.status === 'active' && row.deactivatedAt !== undefined) return normalizationFailure()
    if (row.status === 'deactivated') {
      const deactivatedAt = requireCanonicalTimestamp(row.deactivatedAt)
      if (deactivatedAt < createdAt || deactivatedAt > updatedAt) return normalizationFailure()
    }
    return [{ kind: 'workspace-member', workspaceId, memberKey }]
  }
  if (row.entryType === 'workspace-invitation') {
    if (!recordKey.startsWith('INVITATION#') || !isText(row.id) || !isText(row.email)) {
      return normalizationFailure()
    }
    return []
  }
  if (row.entryType === 'workspace-meta') {
    if (
      recordKey !== 'WORKSPACE' || !isPositiveSafeInteger(row.activeOwnerCount) ||
      !isPositiveSafeInteger(row.version)
    ) return normalizationFailure()
    const createdAt = requireCanonicalTimestamp(row.createdAt)
    const updatedAt = requireCanonicalTimestamp(row.updatedAt)
    if (updatedAt < createdAt) return normalizationFailure()
    return []
  }
  return normalizationFailure()
}

/**
 * Builds the private member-pseudonym index used by canonical Workspace Audit events.
 *
 * @param items - Normalized Workspace Access records from one raw row.
 * @param pseudonymKey - Existing Workspace Audit pseudonym key bytes.
 * @param identities - Invocation-local pseudonym-to-member join index.
 */
function indexWorkspaceMemberAuditIdentities(
  items: readonly CrossDomainIntegrityItem[],
  pseudonymKey: Uint8Array,
  identities: Map<string, WorkspaceMemberAuditIdentity>,
): void {
  for (const item of items) {
    if (item.kind !== 'workspace-member') continue
    const auditEntityId = createWorkspaceMemberAuditEntityIdFromKeyBytes(
      item.workspaceId,
      item.memberKey,
      pseudonymKey,
    )
    const existing = identities.get(auditEntityId)
    if (
      existing !== undefined &&
      (existing.workspaceId !== item.workspaceId || existing.memberKey !== item.memberKey)
    ) {
      normalizationFailure()
    }
    identities.set(auditEntityId, {
      workspaceId: item.workspaceId,
      memberKey: item.memberKey,
    })
  }
}

/** Strictly upcasts an Audit Event and retains joinable resource candidates. */
function normalizeAuditRow(
  row: Record<string, unknown>,
  workspaceMembersByAuditEntityId: ReadonlyMap<string, WorkspaceMemberAuditIdentity>,
): PendingAuditReference[] {
  const event = runNormalizationBoundary(() => upcastAuditEvent(row))
  const tenantConsistent = auditTenantBoundaryIsCanonical(row, event)
  const referencedWorkspaceId = tenantConsistent
    ? event.workspaceId
    : createAuditTenantMismatchSentinel(event.workspaceId)
  const pending = createAuditCandidates(
    event,
    referencedWorkspaceId,
    workspaceMembersByAuditEntityId,
  )
  if (pending.length === 0) {
    return [{
      eventOrder: event.occurredAtEventId,
      eventId: event.eventId,
      historical: true,
      resourceIdentity: `audit-event:${event.eventId}`,
      reference: {
        kind: 'audit-reference',
        workspaceId: event.workspaceId,
        referencedWorkspaceId,
        resourceType: 'team',
        resourceId: `audit-event:${event.eventId}`,
        teamId: null,
      },
    }]
  }
  return pending
}

/** Selects a tenant-mismatch marker that can never equal the event Workspace. */
function createAuditTenantMismatchSentinel(workspaceId: string): string {
  return workspaceId === AUDIT_TENANT_MISMATCH_SENTINEL
    ? AUDIT_TENANT_MISMATCH_ALTERNATE_SENTINEL
    : AUDIT_TENANT_MISMATCH_SENTINEL
}

/** Retains bounded Audit candidates before lifecycle finalization. */
function appendPendingAuditReferences(
  collection: BridgeCollection,
  candidates: readonly PendingAuditReference[],
): void {
  for (const candidate of candidates) {
    if (retainedEvidenceItemCount(collection) >= collection.itemCapacity) {
      collection.limitReached = true
      return
    }
    collection.pendingAuditReferences.push(candidate)
  }
}

/** Resolves only the latest event per resource as potentially current. */
function finalizePendingAuditReferences(collection: BridgeCollection): void {
  const latestByResource = new Map<string, PendingAuditReference>()
  for (const candidate of collection.pendingAuditReferences) {
    const current = latestByResource.get(candidate.resourceIdentity)
    if (!current || compareUtf8Ordinal(current.eventOrder, candidate.eventOrder) < 0) {
      latestByResource.set(candidate.resourceIdentity, candidate)
    }
  }
  const finalized = collection.pendingAuditReferences.map((candidate) => {
    const latest = latestByResource.get(candidate.resourceIdentity)
    const current = latest === candidate && !candidate.historical
    const resourceState: CrossDomainAuditReference['resourceState'] = current
      ? 'current'
      : 'historical'
    return {
      ...candidate.reference,
      resourceId: current
        ? candidate.reference.resourceId
        : `audit-event:${candidate.eventId}:${candidate.reference.resourceType}`,
      resourceState,
    }
  })
  collection.pendingAuditReferences.length = 0
  collection.items.push(...finalized)
}

/** Checks every duplicated Audit key without exposing the mismatched value. */
function auditTenantBoundaryIsCanonical(
  row: Record<string, unknown>,
  event: AuditEventV1,
): boolean {
  if (row.schemaVersion === undefined || row.schemaVersion === 0) return true
  const expectedEventKey = `${event.occurredAt}#${event.eventId}`
  return row.directoryId === event.workspaceId &&
    row.workspaceId === event.workspaceId &&
    event.directoryId === event.workspaceId &&
    event.workspaceKey === event.workspaceId &&
    event.occurredAtEventId === expectedEventKey &&
    event.workspaceEventKey === expectedEventKey &&
    event.actorUserId === event.actor.id &&
    event.actorKey === createAuditActorKey(event.workspaceId, event.actor.id) &&
    event.actorEventKey === expectedEventKey &&
    event.entityType === event.entity.type &&
    event.entityId === event.entity.id &&
    event.entityKey === createAuditEntityKey(event.workspaceId, event.entity) &&
    event.entityEventKey === expectedEventKey &&
    event.targetType === event.target.type &&
    event.targetId === event.target.id &&
    event.targetKey === createAuditEntityKey(event.workspaceId, event.target) &&
    event.targetEventKey === expectedEventKey &&
    duplicatedAuditEntityMatches(row.entityType, row.entityId, event.entity) &&
    duplicatedAuditEntityMatches(row.targetType, row.targetId, event.target)
}

/** Validates a duplicated flattened Audit entity pair. */
function duplicatedAuditEntityMatches(
  type: unknown,
  id: unknown,
  entity: AuditEventV1['entity'],
): boolean {
  return type === entity.type && id === entity.id
}

/** Creates at most one candidate for each resource mentioned by an Audit Event. */
function createAuditCandidates(
  event: AuditEventV1,
  referencedWorkspaceId: string,
  workspaceMembersByAuditEntityId: ReadonlyMap<string, WorkspaceMemberAuditIdentity>,
): PendingAuditReference[] {
  const sourceHistorical = auditEventSourceIsHistorical(event)
  const targetHistorical = sourceHistorical ||
    auditEventTargetIsHistorical(event)
  const entityIsTarget = event.entity.type === event.target.type &&
    event.entity.id === event.target.id
  const candidates = [
    createAuditCandidate(
      event,
      event.entity,
      referencedWorkspaceId,
      sourceHistorical || (entityIsTarget && targetHistorical),
      workspaceMembersByAuditEntityId,
    ),
    createAuditCandidate(
      event,
      event.target,
      referencedWorkspaceId,
      targetHistorical,
      workspaceMembersByAuditEntityId,
    ),
  ]
    .filter((candidate): candidate is PendingAuditReference => candidate !== undefined)
  const unique = new Map<string, PendingAuditReference>()
  for (const candidate of candidates) unique.set(candidate.resourceIdentity, candidate)
  return [...unique.values()]
}

/** Maps one known Audit entity to its canonical cross-domain resource identity. */
function createAuditCandidate(
  event: AuditEventV1,
  entity: AuditEventV1['entity'],
  referencedWorkspaceId: string,
  historical: boolean,
  workspaceMembersByAuditEntityId: ReadonlyMap<string, WorkspaceMemberAuditIdentity>,
): PendingAuditReference | undefined {
  const metadata = event.metadata
  if (entity.type === 'work-item') {
    const parsed = parseAuditWorkItemIdentity(entity.id, metadata)
    if (!parsed) return undefined
    return createPendingAuditReference(event, referencedWorkspaceId, historical, {
      resourceType: 'work-item',
      resourceId: parsed.workItemId,
      teamId: parsed.teamId,
    })
  }
  if (entity.type === 'project') {
    if (metadata?.kind === 'team') {
      const teamId = readAuditMetadataText(metadata, 'teamId') ?? parseAuditTeamIdentity(entity.id)
      if (!teamId) return undefined
      return createPendingAuditReference(event, referencedWorkspaceId, historical, {
        resourceType: 'team',
        resourceId: teamId,
        teamId: null,
      })
    }
    const teamId = readAuditMetadataText(metadata, 'teamId')
    if (!teamId) return undefined
    return createPendingAuditReference(event, referencedWorkspaceId, historical, {
      resourceType: 'project',
      resourceId: entity.id,
      teamId,
    })
  }
  if (entity.type === 'file') {
    return createPendingAuditReference(event, referencedWorkspaceId, historical, {
      resourceType: 'file',
      resourceId: entity.id,
      teamId: readAuditMetadataText(metadata, 'teamId') ?? null,
    })
  }
  if (entity.type === 'member') {
    if (metadata?.kind === 'workspace-member') {
      const identity = workspaceMembersByAuditEntityId.get(entity.id)
      const memberKey = identity?.workspaceId === event.workspaceId
        ? identity.memberKey
        : `unresolved-workspace-member:${entity.id}`
      return createPendingAuditReference(event, referencedWorkspaceId, historical, {
        resourceType: 'workspace-member',
        resourceId: memberKey,
        teamId: null,
      })
    }
    const memberKey = readAuditMetadataText(metadata, 'memberKey')
    if (!memberKey) return undefined
    return createPendingAuditReference(event, referencedWorkspaceId, historical, {
      resourceType: 'workspace-member',
      resourceId: memberKey,
      teamId: null,
    })
  }
  if (entity.type === 'team') {
    return createPendingAuditReference(event, referencedWorkspaceId, historical, {
      resourceType: 'team',
      resourceId: entity.id,
      teamId: null,
    })
  }
  return undefined
}

/** Constructs a process-local Audit candidate with stable lifecycle identity. */
function createPendingAuditReference(
  event: AuditEventV1,
  referencedWorkspaceId: string,
  historical: boolean,
  resource: Pick<CrossDomainAuditReference, 'resourceId' | 'resourceType' | 'teamId'>,
): PendingAuditReference {
  const resourceIdentity = JSON.stringify([
    event.workspaceId,
    resource.resourceType,
    resource.teamId,
    resource.resourceId,
  ])
  return {
    eventOrder: event.occurredAtEventId,
    eventId: event.eventId,
    historical,
    resourceIdentity,
    reference: {
      kind: 'audit-reference',
      workspaceId: event.workspaceId,
      referencedWorkspaceId,
      resourceType: resource.resourceType,
      resourceId: resource.resourceId,
      teamId: resource.teamId,
    },
  }
}

/** Parses the canonical Team-scoped Work Item audit entity ID. */
function parseAuditWorkItemIdentity(
  entityId: string,
  metadata: AuditEventV1['metadata'],
): { readonly teamId: string; readonly workItemId: string } | undefined {
  const match = /^team\/([^/]+)\/issue\/(.+)$/u.exec(entityId)
  const metadataTeamId = readAuditMetadataText(metadata, 'teamId')
  const metadataIssueId = readAuditMetadataText(metadata, 'issueId')
  const teamId = match?.[1] ?? metadataTeamId
  const workItemId = match?.[2] ?? metadataIssueId
  if (!teamId || !workItemId) return undefined
  if (
    (metadataTeamId !== undefined && metadataTeamId !== teamId) ||
    (metadataIssueId !== undefined && metadataIssueId !== workItemId)
  ) return normalizationFailure()
  return { teamId, workItemId }
}

/** Parses a Team ID represented by the Project-domain Team audit convention. */
function parseAuditTeamIdentity(entityId: string): string | undefined {
  const prefix = 'team/'
  return entityId.startsWith(prefix) && entityId.length > prefix.length
    ? entityId.slice(prefix.length)
    : undefined
}

/** Reads one non-empty string from validated Audit metadata. */
function readAuditMetadataText(
  metadata: AuditEventV1['metadata'],
  field: string,
): string | undefined {
  const value = metadata?.[field]
  return isText(value) ? value : undefined
}

/** Classifies an Audit source whose complete resource snapshot is historical. */
function auditEventSourceIsHistorical(event: AuditEventV1): boolean {
  return event.source === 'backfill' || event.source === 'migration'
}

/** Classifies lifecycle semantics that make only an event target historical. */
function auditEventTargetIsHistorical(event: AuditEventV1): boolean {
  const lifecycle = historicalAuditTargetLifecycles.find(
    (lifecycle) =>
      lifecycle.eventType === event.eventType &&
      lifecycle.action === event.action &&
      lifecycle.targetType === event.target.type,
  )
  if (!lifecycle) return false
  if (event.target.type === 'work-item') {
    return event.entity.type === 'work-item' &&
      event.entity.id === event.target.id
  }
  return event.target.type === 'file' &&
    (event.entity.type === 'work-item' || event.entity.type === 'project') &&
    readAuditMetadataText(event.metadata, 'fileId') === event.target.id
}

/** Strictly normalizes one File Proofing row and observes its exact object versions. */
async function normalizeFileRow(
  input: FileRowNormalizationInput,
): Promise<CrossDomainIntegrityItem[]> {
  const entryType = requireText(input.row.entryType)
  requireText(input.row.scopeKey)
  requireText(input.row.recordKey)
  if (entryType !== 'file') {
    if (!knownFileProofingAuxiliaryEntryTypes.has(entryType)) return normalizationFailure()
    return []
  }

  let references: FileIntegrityReference[] = []
  try {
    references = parseFileIntegrityReferences(input.row)
  } catch {
    // The independent checker converts strict parse failures to evidence-safe codes.
  }
  const nonExpiredReferences = references.filter((reference) =>
    !isExpiredFileTombstone(reference, input.checkedAt)
  )
  const requiredItemBudget = references.length + nonExpiredReferences.length * 2
  if (
    retainedEvidenceItemCount(input.collection) + requiredItemBudget >
      input.collection.itemCapacity
  ) {
    input.collection.limitReached = true
    return []
  }
  const observations: FileIntegrityObjectObservation[] = []
  const observedByIdentity = new Map<string, ObservedFileObject>()
  for (const reference of references) {
    const objectVersionId = reference.objectVersionId
    if (!objectVersionId || isExpiredFileTombstone(reference, input.checkedAt)) continue
    if (input.collection.exactObjectVersionReadCount >= input.collection.itemCapacity) {
      input.collection.limitReached = true
      return []
    }
    input.collection.exactObjectVersionReadCount += 1
    const observed = await observeExactFileObject(input.reader, {
      ...reference,
      objectVersionId,
    })
    if (!observed) continue
    observations.push(observed.observation)
    observedByIdentity.set(fileObjectIdentity(reference.objectKey, objectVersionId), observed)
  }

  const fileResult = checkFileMetadataIntegrity({
    checkedAt: input.checkedAt,
    item: input.row,
    objects: observations,
  })
  input.collection.checkedFileVersionCount += fileResult.checkedVersionCount
  for (const code of fileResult.failureCodes) input.collection.fileFailureCodes.add(code)
  input.collection.fileRowDigests.push(createFileRowDigest(
    input.digestKey,
    input.rawItem,
    references,
    observations,
    fileResult.failureCodes,
  ))

  const normalized: CrossDomainIntegrityItem[] = []
  for (const reference of references) {
    if (isExpiredFileTombstone(reference, input.checkedAt)) continue
    const objectVersionId = reference.objectVersionId ??
      `${UNVERIFIED_OBJECT_VERSION_PREFIX}${reference.versionId}`
    normalized.push({
      kind: 'file-metadata',
      workspaceId: reference.workspaceId,
      teamId: reference.teamId,
      fileId: reference.fileId,
      versionId: reference.versionId,
      targetType: reference.parentTargetType,
      targetId: reference.parentTargetId,
      objectKey: reference.objectKey,
      objectVersionId,
      contentType: reference.contentType,
      sizeBytes: reference.sizeBytes,
      scanStatus: reference.scanStatus,
    })
    if (!reference.objectVersionId) {
      normalized.push(createSyntheticPendingObject(reference, objectVersionId))
      continue
    }
    const observed = observedByIdentity.get(
      fileObjectIdentity(reference.objectKey, reference.objectVersionId),
    )
    if (!observed) continue
    normalized.push({
      kind: 'file-object',
      objectKey: reference.objectKey,
      objectVersionId: reference.objectVersionId,
      workspaceId: reference.workspaceId,
      fileId: reference.fileId,
      versionId: reference.versionId,
      contentType: observed.observation.contentType,
      sizeBytes: observed.observation.sizeBytes,
      scanStatus: reference.scanStatus,
    })
  }
  return normalized
}

/** Reads one exact immutable S3 object version without interpreting raw errors. */
async function observeExactFileObject(
  reader: CrossDomainIntegrityCheckBridgeInput['reader'],
  reference: FileIntegrityReference & { readonly objectVersionId: string },
): Promise<ObservedFileObject | undefined> {
  const objectReference: CrossDomainIntegrityObjectVersionReference = {
    bucket: 'file',
    key: reference.objectKey,
    versionId: reference.objectVersionId,
  }
  let responses: readonly [
    HeadObjectCommandOutput,
    GetObjectAttributesCommandOutput,
    GetObjectTaggingCommandOutput,
  ]
  try {
    responses = await Promise.all([
      reader.headObject(objectReference),
      reader.getObjectAttributes(objectReference),
      reader.getObjectTagging(objectReference),
    ])
  } catch (error) {
    if (isMissingFileObjectVersionError(error)) return undefined
    throw error
  }
  const [head, attributes, tagging] = responses
  validateExactObjectVersionResponse(reference.objectVersionId, head.VersionId)
  validateExactObjectVersionResponse(reference.objectVersionId, attributes.VersionId)
  validateExactObjectVersionResponse(reference.objectVersionId, tagging.VersionId)
  const contentType = requireText(head.ContentType)
  const headSize = requireNonNegativeSafeInteger(head.ContentLength)
  const attributeSize = requireNonNegativeSafeInteger(attributes.ObjectSize)
  if (headSize !== attributeSize) return normalizationFailure()
  const tags = parseS3Tags(tagging.TagSet)
  return {
    head,
    attributes,
    tagging,
    observation: {
      objectKey: reference.objectKey,
      objectVersionId: reference.objectVersionId,
      sizeBytes: attributeSize,
      contentType,
      scanStatus: mapGuardDutyScanStatus(tags),
      uploadState: readUploadState(tags),
      deleted: tags.some((tag) => tag.Key === 'mukuroji-deleted' && tag.Value === 'true'),
    },
  }
}

/** Requires every exact-version S3 response to echo the requested VersionId. */
function validateExactObjectVersionResponse(expected: string, observed: unknown): void {
  if (observed !== expected) normalizationFailure()
}

/** Strictly reconstructs an S3 tag set and rejects duplicate tag keys. */
function parseS3Tags(value: unknown): Tag[] {
  if (!Array.isArray(value)) return normalizationFailure()
  const tags: Tag[] = []
  const keys = new Set<string>()
  for (const entry of value) {
    const record = requireRecord(entry)
    const key = requireText(record.Key)
    const tagValue = requireText(record.Value)
    if (keys.has(key)) return normalizationFailure()
    keys.add(key)
    tags.push({ Key: key, Value: tagValue })
  }
  return tags
}

/** Reads the required canonical upload lifecycle tag. */
function readUploadState(tags: readonly Tag[]): 'completed' | 'pending' {
  const value = tags.find((tag) => tag.Key === 'mukuroji-upload')?.Value
  if (value !== 'completed' && value !== 'pending') return normalizationFailure()
  return value
}

/** Creates a matching process-local object for a not-yet-verified pending upload. */
function createSyntheticPendingObject(
  reference: FileIntegrityReference,
  objectVersionId: string,
): CrossDomainIntegrityItem {
  return {
    kind: 'file-object',
    objectKey: reference.objectKey,
    objectVersionId,
    workspaceId: reference.workspaceId,
    fileId: reference.fileId,
    versionId: reference.versionId,
    contentType: reference.contentType,
    sizeBytes: reference.sizeBytes,
    scanStatus: reference.scanStatus,
  }
}

/** Determines whether a retained File tombstone no longer owns object checks. */
function isExpiredFileTombstone(reference: FileIntegrityReference, checkedAt: string): boolean {
  return reference.deleted && reference.retentionUntil !== undefined &&
    reference.retentionUntil <= checkedAt
}

/** Creates a process-local exact object identity. */
function fileObjectIdentity(objectKey: string, objectVersionId: string): string {
  return JSON.stringify([objectKey, objectVersionId])
}

/** Creates one order-independent File-row HMAC input digest. */
function createFileRowDigest(
  digestKey: Uint8Array,
  rawItem: Readonly<Record<string, AttributeValue>>,
  references: readonly FileIntegrityReference[],
  observations: readonly FileIntegrityObjectObservation[],
  failureCodes: readonly FileMetadataIntegrityFailureCode[],
): string {
  const normalizedReferences = references
    .map((reference) => ({
      contentType: reference.contentType,
      currentVersion: reference.currentVersion,
      deleted: reference.deleted,
      fileId: reference.fileId,
      objectKey: reference.objectKey,
      objectVersionPresent: reference.objectVersionId !== undefined,
      parentTargetId: reference.parentTargetId,
      parentTargetType: reference.parentTargetType,
      retentionUntil: reference.retentionUntil ?? null,
      scanStatus: reference.scanStatus,
      sizeBytes: reference.sizeBytes,
      teamId: reference.teamId,
      versionId: reference.versionId,
      workspaceId: reference.workspaceId,
    }))
    .sort(compareCanonicalJson)
  const normalizedObservations = observations
    .map((observation) => ({
      contentType: observation.contentType,
      deleted: observation.deleted,
      objectKey: observation.objectKey,
      scanStatus: observation.scanStatus,
      sizeBytes: observation.sizeBytes,
      uploadState: observation.uploadState,
    }))
    .sort(compareCanonicalJson)
  const hmac = createHmac('sha256', digestKey)
  hmac.update('mukuroji-cross-domain-file-row/v1\0', 'utf8')
  hmac.update(serializeRestorePortableFileAttributeMap(rawItem), 'utf8')
  hmac.update('\0', 'utf8')
  hmac.update(JSON.stringify(normalizedReferences), 'utf8')
  hmac.update('\0', 'utf8')
  hmac.update(JSON.stringify(normalizedObservations), 'utf8')
  hmac.update('\0', 'utf8')
  hmac.update(JSON.stringify([...failureCodes].sort()), 'utf8')
  return hmac.digest('hex')
}

/**
 * Serializes a File row while replacing only system-generated S3 Version IDs.
 *
 * Isolated S3 copies receive new physical Version IDs, so paired source/restore
 * evidence compares every other raw File attribute while local validation still
 * binds each metadata row to its exact immutable object version.
 *
 * @param rawItem - Strictly decoded low-level File row.
 * @returns Canonical row text with physical object-version values normalized.
 */
function serializeRestorePortableFileAttributeMap(
  rawItem: Readonly<Record<string, AttributeValue>>,
): string {
  const versions = rawItem.versions?.L
  if (!versions) return serializeCanonicalAttributeMap(rawItem)
  const normalizedVersions = versions.map((version) => {
    if (!version.M) return version
    const normalizedVersion: Record<string, AttributeValue> = {}
    for (const [name, value] of Object.entries(version.M)) {
      normalizedVersion[name] = name === 'objectVersionId'
        ? { S: 'restore-portable-object-version' }
        : value
    }
    return { M: normalizedVersion }
  })
  const normalizedItem: Record<string, AttributeValue> = {}
  for (const [name, value] of Object.entries(rawItem)) {
    normalizedItem[name] = name === 'versions' ? { L: normalizedVersions } : value
  }
  return serializeCanonicalAttributeMap(normalizedItem)
}

/** Compares two constructed JSON values by canonical serialization. */
function compareCanonicalJson(left: object, right: object): number {
  return Buffer.compare(
    Buffer.from(JSON.stringify(left), 'utf8'),
    Buffer.from(JSON.stringify(right), 'utf8'),
  )
}

/** Creates aggregate external File evidence without serializing row-level digests. */
function createExternalFileEvidence(
  digestKey: Uint8Array,
  collection: BridgeCollection,
): CrossDomainExternalFileEvidence {
  const hmac = createHmac('sha256', digestKey)
  hmac.update('mukuroji-cross-domain-external-file-evidence/v1\0', 'utf8')
  for (const digest of [...collection.fileRowDigests].sort()) {
    hmac.update(digest, 'hex')
  }
  return {
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    checkedItemCount: collection.checkedFileVersionCount,
    aggregateDigest: hmac.digest('hex'),
    failureCodes: [...collection.fileFailureCodes].sort(),
  }
}

/** Appends normalized records while retaining exactly one overflow item. */
function appendNormalizedItems(
  collection: BridgeCollection,
  items: readonly CrossDomainIntegrityItem[],
): void {
  for (const item of items) {
    if (retainedEvidenceItemCount(collection) >= collection.itemCapacity) {
      collection.limitReached = true
      return
    }
    collection.items.push(item)
  }
}

/** Counts normalized and pending Audit items. */
function retainedNormalizedItemCount(collection: BridgeCollection): number {
  return collection.items.length + collection.pendingAuditReferences.length
}

/** Counts normalized items plus independently checked File versions. */
function retainedEvidenceItemCount(collection: BridgeCollection): number {
  return retainedNormalizedItemCount(collection) + collection.checkedFileVersionCount
}

/** Compares strings by exact UTF-8 byte order. */
function compareUtf8Ordinal(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

/** Creates a bounded in-memory reader for the pure checker core. */
function createNormalizedReadPort(
  items: readonly CrossDomainIntegrityItem[],
  forceLimitFailure: boolean,
): CrossDomainIntegrityReadPort {
  return {
    /** Reads a deterministic bounded slice without exposing AWS cursors. */
    async readPage(request: CrossDomainIntegrityPageRequest): Promise<CrossDomainIntegrityPage> {
      if (request.cursor === 'limit-overflow') {
        return { items: createLimitOverflowPage(request.pageSize) }
      }
      const offset = request.cursor === undefined ? 0 : parseNormalizedCursor(request.cursor)
      const pageItems = items.slice(offset, offset + request.pageSize)
      const nextOffset = offset + pageItems.length
      return {
        items: pageItems,
        ...(nextOffset < items.length
          ? { nextCursor: String(nextOffset) }
          : forceLimitFailure
            ? { nextCursor: 'limit-overflow' }
            : {}),
      }
    },
  }
}

/** Creates a discarded overrun page that makes the core emit its stable limit failure. */
function createLimitOverflowPage(pageSize: number): CrossDomainIntegrityItem[] {
  return Array.from({ length: pageSize + 1 }, (_, index) => ({
    kind: 'team',
    workspaceId: 'integrity-limit-overflow',
    teamId: `overflow-${index}`,
  }))
}

/** Parses an adapter-private decimal normalized cursor. */
function parseNormalizedCursor(value: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) return normalizationFailure()
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) return normalizationFailure()
  return parsed
}

/** Narrows an unknown value to a non-array record. */
function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return normalizationFailure()
  }
  return Object.fromEntries(Object.entries(value))
}

/** Narrows an unknown value to an array. */
function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) return normalizationFailure()
  return value
}

/** Reads a trimmed non-empty string. */
function requireText(value: unknown): string {
  if (!isText(value)) return normalizationFailure()
  return value
}

/** Checks a trimmed non-empty string. */
function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

/** Reads a positive safe integer. */
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** Checks a non-negative safe integer. */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Reads a non-negative safe integer. */
function requireNonNegativeSafeInteger(value: unknown): number {
  if (!isNonNegativeSafeInteger(value)) return normalizationFailure()
  return value
}

/** Reads a canonical millisecond-precision UTC timestamp. */
function requireCanonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string') return normalizationFailure()
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    return normalizationFailure()
  }
  return value
}

/**
 * Validates an optional canonical timestamp.
 *
 * @param value - Optional untrusted timestamp.
 * @returns The canonical timestamp when present.
 */
function requireOptionalCanonicalTimestamp(value: unknown): string | undefined {
  return value === undefined ? undefined : requireCanonicalTimestamp(value)
}

/** Reads one supported relation type. */
function requireRelationType(value: unknown): CrossDomainRelationType {
  if (
    value !== 'blockedBy' && value !== 'blocks' && value !== 'child' &&
    value !== 'duplicate' && value !== 'parent' && value !== 'related'
  ) return normalizationFailure()
  return value
}

/** Checks a supported Project display tone. */
function isProjectTone(value: unknown): boolean {
  return value === 'blue' || value === 'purple' || value === 'green' || value === 'yellow'
}

/** Checks a supported Workspace role. */
function isWorkspaceRole(value: unknown): boolean {
  return value === 'owner' || value === 'admin' || value === 'member' || value === 'guest'
}

/** Checks a retained Workspace membership status. */
function isWorkspaceMemberStatus(value: unknown): boolean {
  return value === 'active' || value === 'deactivated'
}

/** Converts domain validation errors to one raw-data-free bridge category. */
function runNormalizationBoundary<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (error instanceof CrossDomainIntegrityAwsBridgeFailure) throw error
    return normalizationFailure()
  }
}

/** Throws the stable normalization failure with a generic return type. */
function normalizationFailure<T>(): T {
  throw new CrossDomainIntegrityAwsBridgeFailure('NORMALIZATION_FAILED')
}
