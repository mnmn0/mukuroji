import { createHash, createHmac } from 'node:crypto'
import { Readable } from 'node:stream'
import {
  GetObjectCommand,
  GetObjectRetentionCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { DescribeExecutionCommand } from '@aws-sdk/client-sfn'
import {
  GetItemCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb'
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { describe, expect, test } from 'bun:test'
import {
  RESTORE_DRILL_TABLE_TARGETS,
  RestoreDrillFailure,
  createRestoreDrillCleanupApprovalReceipt,
  createRestoreDrillCleanupExecutionName,
  type RestoreDrillCleanupApprovalReceipt,
  type RestoreDrillFailureCode,
} from './restore-drill'
import type {
  RestoreDrillAwsOperations,
  RestoreDrillCreatedScratchObjectVersion,
  RestoreDrillDigestKeyEnvelope,
  RestoreDrillFileVersionProof,
  RestoreDrillExportDataFile,
  RestoreDrillRecordedExport,
  RestoreDrillRecordedExportObjectVersion,
  RestoreDrillRecordedMultipartUpload,
  RestoreDrillRecordedRestoreTable,
  RestoreDrillSourceFileVersion,
  RestoreDrillSourceTableObservation,
  RestoreDrillTableDescriptor,
} from './restore-drill-aws'
import { RestoreDrillAwsFailure } from './restore-drill-aws'
import {
  RESTORE_DRILL_CLEANUP_POLICY_VERSION,
  RESTORE_DRILL_DUE_DAYS,
  RESTORE_DRILL_OVERDUE_DAYS,
  AwsRestoreDrillApprovalStore,
  AwsRestoreDrillCleanupExecutionStore,
  AwsRestoreDrillEvidenceStore,
  AwsRestoreDrillStateStore,
  RestoreDrillOrchestratorFailure,
  createRestoreDrillExportListingCheckpoint,
  createRestoreDrillOrchestrator,
  descriptorsMatchForRestore,
  isRestoreDrillIntegrityFailureCode,
  isRestoreDrillApprovalRetentionSufficient,
  isRestoreDrillObjectKeyPathSafe,
  parseRestoreDrillHandlerRequest,
  validateRestoreDrillFileCursorAdvance,
  type RestoreDrillApprovalStore,
  type RestoreDrillCadenceState,
  type RestoreDrillCleanupExecutionObservation,
  type RestoreDrillCleanupScopeCheckpoint,
  type RestoreDrillCleanupTarget,
  type RestoreDrillCleanupProgress,
  type RestoreDrillCopyReconciliationCheckpoint,
  type RestoreDrillCopyIntent,
  type RestoreDrillDurableRun,
  type RestoreDrillEvidenceArtifact,
  type RestoreDrillEvidenceStore,
  type RestoreDrillCleanupExecutionStore,
  type RestoreDrillExportListingCheckpoint,
  type RestoreDrillFileCursorCheckpoint,
  type RestoreDrillMetricName,
  type RestoreDrillMetricSink,
  type RestoreDrillMultipartUploadListingCheckpoint,
  type RestoreDrillResourceCheckpoint,
  type RestoreDrillStateStore,
  type RestoreDrillStartIntent,
  type RestoreDrillVerificationResult,
  type RestoreDrillVerificationProgress,
} from './restore-drill-orchestrator'

const ACCOUNT_ID = '123456789012'
const REGION = 'ap-northeast-1'
const DRILL_ID = 'drill-20260801'
const DRILL_DIGEST = createHash('sha256')
  .update(`drill\0${DRILL_ID}`, 'utf8')
  .digest('hex')
  .slice(0, 16)
const DIGEST = 'a'.repeat(64)
const RESULT_DIGEST = 'b'.repeat(64)
const APPROVAL_DIGEST = 'c'.repeat(64)
const DIGEST_KEY = new Uint8Array(32).fill(41)
const STARTED_AT = '2026-08-01T00:00:00.000Z'
const DEADLINE_AT = '2026-08-01T04:00:00.000Z'
const RUNNER_EXECUTION_ARN =
  `arn:aws:states:${REGION}:${ACCOUNT_ID}:execution:restore-drill:runner-execution-1`

const ENVELOPE: RestoreDrillDigestKeyEnvelope = {
  ciphertextBase64: 'Y2lwaGVydGV4dA==',
  kind: 'restore-drill-digest-key',
  kmsKeyArn: `arn:aws:kms:${REGION}:${ACCOUNT_ID}:key/evidence`,
}

/** Creates comparable but independently role-bound File proof fixtures. */
function fileProof(role: RestoreDrillFileVersionProof['role']): RestoreDrillFileVersionProof {
  const proofWithoutMac: Omit<RestoreDrillFileVersionProof, 'proofMac'> = {
    contentDigest: DIGEST,
    metadataDigest: DIGEST,
    physicalIdentityDigest: (role === 'source' ? 'b' : 'c').repeat(64),
    proofVersion: 1,
    role,
    tagsDigest: DIGEST,
  }
  return {
    ...proofWithoutMac,
    proofMac: createHmac('sha256', DIGEST_KEY)
      .update(`restore-drill-file-${role}-proof-v1\0`, 'utf8')
      .update(JSON.stringify({
        contentDigest: proofWithoutMac.contentDigest,
        metadataDigest: proofWithoutMac.metadataDigest,
        physicalIdentityDigest: proofWithoutMac.physicalIdentityDigest,
        proofVersion: proofWithoutMac.proofVersion,
        role: proofWithoutMac.role,
        tagsDigest: proofWithoutMac.tagsDigest,
      }), 'utf8')
      .digest('hex'),
  }
}

/** Mutable model exposed by the in-memory durable state test double. */
type StateModel = {
  /** Number of successful active-lease releases. */
  releaseCount: number
  /** Number of successful cadence reconciliation writes. */
  successfulVerificationCount: number
  /** Current singleton cadence item. */
  cadence: RestoreDrillCadenceState
  /** Current cleanup progress. */
  cleanupProgress: RestoreDrillCleanupProgress
  /** Optional pre-sorted immutable cleanup ledger for large-inventory tests. */
  cleanupLedger?: readonly RestoreDrillCleanupTarget[]
  /** Current cleanup-scope seal when a test exercises pre-approval sealing. */
  cleanupScope?: RestoreDrillCleanupScopeCheckpoint
  /** Current final CopyObject reconciliation when explicitly exercised. */
  copyReconciliation?: RestoreDrillCopyReconciliationCheckpoint
  /** Durable exact export object-version inventory. */
  exportObjectVersions: RestoreDrillRecordedExportObjectVersion[]
  /** Durable export listing checkpoint per logical table target. */
  exportListings: Map<string, RestoreDrillExportListingCheckpoint>
  /** Current File scan cursor. */
  fileCursor: RestoreDrillFileCursorCheckpoint
  /** Durable copy intents keyed by digest. */
  intents: Map<string, RestoreDrillCopyIntent>
  /** Durable exact incomplete MPU inventory. */
  multipartUploads: RestoreDrillRecordedMultipartUpload[]
  /** Durable MPU listing cursor. */
  multipartUploadListing: RestoreDrillMultipartUploadListingCheckpoint
  /** Current resource checkpoint. */
  resourceCheckpoint?: RestoreDrillResourceCheckpoint
  /** Current RUN item. */
  run?: RestoreDrillDurableRun
  /** Durable restore/export start intents keyed by target. */
  startIntents: Map<string, RestoreDrillStartIntent>
  /** Individually addressable source manifest entries keyed by logical target. */
  verificationManifestFiles: Map<string, RestoreDrillExportDataFile[]>
  /** Opaque logical-partition token sets keyed by role and target. */
  verificationPartitions: Map<string, Set<string>>
  /** Current incremental verification progress when started. */
  verificationProgress?: RestoreDrillVerificationProgress
}

/** Creates one deterministic empty resource checkpoint for cleanup tests. */
function emptyResourceCheckpoint(): RestoreDrillResourceCheckpoint {
  return { exports: [], restoredDescriptors: [], restores: [], sources: [] }
}

/** Creates distinct valid cleanup-table identities for ledger transaction tests. */
function cleanupRestoreTargets(count: number): RestoreDrillRecordedRestoreTable[] {
  return RESTORE_DRILL_TABLE_TARGETS.slice(0, count).map((target) => {
    const logicalName = target.slice('table:'.length)
    const tableName = `restore-${DRILL_DIGEST}-${logicalName}`
    return {
      kind: 'restore-table',
      restorePoint: STARTED_AT,
      sourceTableArn:
        `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${logicalName}`,
      tableArn: `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${tableName}`,
      tableId: `restore-table-${logicalName}`,
      tableName,
      target,
    }
  })
}

/** Creates a minimal canonical table descriptor for orchestration fixtures. */
function tableDescriptor(): RestoreDrillTableDescriptor {
  return {
    attributeDefinitions: [{ attributeName: 'id', attributeType: 'S' }],
    billingMode: 'PAY_PER_REQUEST',
    globalSecondaryIndexes: [],
    itemCount: 0,
    keySchema: [{ attributeName: 'id', keyType: 'HASH' }],
    sseType: 'KMS',
    sseStatus: 'ENABLED',
    kmsMasterKeyArn: `arn:aws:kms:${REGION}:${ACCOUNT_ID}:key/table-key`,
    tableId: 'source-table-id',
    ttlEnabled: false,
    ttlStatus: 'DISABLED',
  }
}

/** Creates one source observation for the File Proofing target. */
function fileSourceObservation(): RestoreDrillSourceTableObservation {
  return {
    descriptor: tableDescriptor(),
    earliestRestorableAt: '2026-07-01T00:00:00.000Z',
    latestRestorableAt: STARTED_AT,
    sourceTableArn:
      `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/file-proofing`,
    target: 'table:file-proofing',
  }
}

/** Creates one exact isolated File Proofing table identity. */
function fileRestoredTable(): RestoreDrillRecordedRestoreTable {
  return {
    kind: 'restore-table',
    restorePoint: STARTED_AT,
    sourceTableArn: fileSourceObservation().sourceTableArn,
    tableArn:
      `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/restore-${DRILL_DIGEST}-file-proofing`,
    tableId: 'restore-table-id',
    tableName: `restore-${DRILL_DIGEST}-file-proofing`,
    target: 'table:file-proofing',
  }
}

/** Creates one strict immutable File version for CopyObject intent tests. */
function sourceFileVersion(index = 1): RestoreDrillSourceFileVersion {
  return {
    contentType: 'application/pdf',
    objectKey: `workspaces/workspace-1/file-${index}.pdf`,
    objectVersionId: `source-object-version-${index}`,
    sizeBytes: 7,
    versionId: `file-version-${index}`,
  }
}

/** Creates one exact scratch identity for a strict source File version. */
function createdFileCopy(
  source: RestoreDrillSourceFileVersion,
  objectVersionId: string,
): RestoreDrillCreatedScratchObjectVersion {
  return {
    bucketName: 'restore-drill-scratch',
    drillDigest: DRILL_DIGEST,
    kind: 'scratch-object-version',
    objectKey: source.objectKey,
    objectVersionId,
    versionId: source.versionId,
  }
}

/** Creates the durable digest key used by one CopyObject intent. */
function copyIntentDigest(source: RestoreDrillSourceFileVersion): string {
  return createHash('sha256')
    .update('mukuroji-restore-drill-copy-intent-v1\0', 'utf8')
    .update(source.versionId, 'utf8')
    .update('\0', 'utf8')
    .update(source.objectKey, 'utf8')
    .update('\0', 'utf8')
    .update(source.objectVersionId, 'utf8')
    .digest('hex')
}

/** Creates a deterministic digest-only cursor for one in-memory cleanup target. */
function cleanupTargetCursor(target: RestoreDrillCleanupTarget): string {
  const order = target.kind === 'restore-table'
    ? 0
    : target.kind === 'scratch-object-version'
      ? 1
      : target.kind === 'export-object-version'
        ? 2
        : 3
  return `CLEANUP_TARGET#${order}#${createHash('sha256')
    .update(JSON.stringify(target), 'utf8')
    .digest('hex')}`
}

/** Materializes the in-memory append-only cleanup ledger in cursor order. */
function cleanupTargets(model: StateModel): readonly RestoreDrillCleanupTarget[] {
  if (model.cleanupLedger) return model.cleanupLedger
  return [
    ...(model.resourceCheckpoint?.restores ?? []),
    ...[...model.intents.values()].flatMap((intent) => intent.createdCopies ?? []),
    ...model.exportObjectVersions,
    ...model.multipartUploads,
  ].sort((left, right) =>
    cleanupTargetCursor(left).localeCompare(cleanupTargetCursor(right))
  )
}

/** Synthesizes a terminal scope for tests that start after approval. */
function approvedCleanupScope(model: StateModel): RestoreDrillCleanupScopeCheckpoint {
  const targets = cleanupTargets(model)
  const lastTarget = targets.at(-1)
  const terminalCursor = lastTarget ? cleanupTargetCursor(lastTarget) : undefined
  return {
    complete: true,
    exportObjectCount: model.exportObjectVersions.length,
    fileObjectCount: [...model.intents.values()].reduce(
      (count, intent) => count + (intent.createdCopies?.length ?? 0),
      0,
    ),
    ledgerCount: targets.length,
    ledgerRevision: targets.length,
    multipartUploadCount: model.multipartUploads.length,
    resourceDigest: model.run?.resourceDigest ?? DIGEST,
    rollingDigest: DIGEST,
    started: true,
    tableCount: model.resourceCheckpoint?.restores.length ?? 0,
    ...(terminalCursor ? { terminalCursor } : {}),
  }
}

/** Creates an in-memory state adapter with strict revision checks. */
function createState(model: StateModel): RestoreDrillStateStore {
  return {
    async admitRun(run, expectedCadenceRevision) {
      if (model.run || model.cadence.revision !== expectedCadenceRevision) return false
      model.run = run
      model.cadence = {
        activeDrillId: run.drillId,
        cadenceOriginAt: model.cadence.cadenceOriginAt ?? run.startedAt,
        revision: expectedCadenceRevision + 1,
      }
      return true
    },
    async completeCopyIntent(_drillId, intentDigest, copy) {
      const intent = model.intents.get(intentDigest)
      if (!intent?.selectedCopy) throw new Error('created copy was not durable')
      model.intents.set(intentDigest, {
        ...(intent.createdCopies ? { createdCopies: intent.createdCopies } : {}),
        completedCopy: copy,
        intentDigest: intent.intentDigest,
        preexistingScratchVersionIds: intent.preexistingScratchVersionIds,
        selectedCopy: intent.selectedCopy,
        source: intent.source,
      })
    },
    async claimCopyIntent(_drillId, intentDigest, expectedClaim, nextClaim) {
      const intent = model.intents.get(intentDigest)
      if (!intent || JSON.stringify(intent.copyClaim) !== JSON.stringify(expectedClaim)) {
        return false
      }
      model.intents.set(intentDigest, { ...intent, copyClaim: nextClaim })
      return true
    },
    async listCompletedFileCopies() {
      return [...model.intents.values()]
        .flatMap((intent) => intent.completedCopy ? [intent.completedCopy] : [])
    },
    async listCreatedFileCopies() {
      return [...model.intents.values()]
        .flatMap((intent) => intent.createdCopies ?? [])
    },
    async listCopyIntents() {
      return [...model.intents.values()]
    },
    async listExportObjectVersions() {
      return model.exportObjectVersions
    },
    async listMultipartUploads() {
      return model.multipartUploads
    },
    async listExportCompletions() {
      return []
    },
    async listStartIntents() {
      return [...model.startIntents.values()]
    },
    async readActiveDrillId() {
      return model.cadence.activeDrillId
    },
    async readCadence() {
      return model.cadence
    },
    async readCleanupProgress() {
      return model.cleanupProgress
    },
    async readCleanupInventoryPage(_drillId, cursor, limit) {
      const entries = cleanupTargets(model).map((target) => ({
        cursor: cleanupTargetCursor(target),
        target,
      }))
      const start = cursor === undefined
        ? 0
        : entries.findIndex((entry) => entry.cursor === cursor) + 1
      if (start < 0) throw new Error('cleanup cursor missing')
      const page = entries.slice(start, start + limit)
      const last = page.at(-1)
      return {
        entries: page,
        ...(start + page.length < entries.length && last
          ? { nextCursor: last.cursor }
          : {}),
      }
    },
    async readCleanupLedgerControl() {
      const count = cleanupTargets(model).length
      return { count, revision: count }
    },
    async readCleanupScopeCheckpoint() {
      if (model.cleanupScope) return model.cleanupScope
      if (model.run?.resourceDigest) return approvedCleanupScope(model)
      return {
        complete: false,
        exportObjectCount: 0,
        fileObjectCount: 0,
        multipartUploadCount: 0,
        started: false,
        tableCount: 0,
      }
    },
    async writeCleanupScopeCheckpoint(_drillId, expected, next) {
      const current = model.cleanupScope ?? (
        model.run?.resourceDigest
          ? approvedCleanupScope(model)
          : {
              complete: false,
              exportObjectCount: 0,
              fileObjectCount: 0,
              multipartUploadCount: 0,
              started: false,
              tableCount: 0,
            }
      )
      if (JSON.stringify(current) !== JSON.stringify(expected)) return false
      model.cleanupScope = next
      return true
    },
    async readCopyIntent(_drillId, intentDigest) {
      return model.intents.get(intentDigest)
    },
    async readCopyIntentInventoryPage(_drillId, cursor, limit) {
      const entries = [...model.intents.values()]
        .map((intent) => ({
          cursor: `COPY_INTENT#${intent.intentDigest}`,
          intent,
        }))
        .sort((left, right) => left.cursor.localeCompare(right.cursor))
      const start = cursor === undefined
        ? 0
        : entries.findIndex((entry) => entry.cursor === cursor) + 1
      if (start < 0) throw new Error('copy cursor missing')
      const page = entries.slice(start, start + limit)
      const last = page.at(-1)
      return {
        entries: page,
        ...(start + page.length < entries.length && last
          ? { nextCursor: last.cursor }
          : {}),
      }
    },
    async readCopyReconciliationCheckpoint() {
      if (model.copyReconciliation) return model.copyReconciliation
      const intents = [...model.intents.values()]
      const terminal = intents
        .map((intent) => `COPY_INTENT#${intent.intentDigest}`)
        .sort()
        .at(-1)
      return {
        complete: true,
        createdCopyCount: intents.reduce(
          (count, intent) => count + (intent.createdCopies?.length ?? 0),
          0,
        ),
        currentDigest: DIGEST,
        intentCount: intents.length,
        pass: 2,
        passDigest: DIGEST,
        quietUntil: STARTED_AT,
        started: true,
        ...(terminal ? { terminalCursor: terminal } : {}),
      }
    },
    async reconcileCopyIntentVersions(_drillId, intentDigest, discovered) {
      const intent = model.intents.get(intentDigest)
      if (!intent) throw new Error('copy intent missing')
      const copies = new Map(
        [...(intent.createdCopies ?? []), ...discovered].map((copy) => [
          copy.objectVersionId,
          copy,
        ]),
      )
      const createdCopies = [...copies.values()].sort((left, right) =>
        left.objectVersionId.localeCompare(right.objectVersionId)
      )
      const selectedCopy = intent.selectedCopy ?? createdCopies[0]
      const next = selectedCopy
        ? { ...intent, createdCopies, selectedCopy }
        : intent
      model.intents.set(intentDigest, next)
      return next
    },
    async writeCopyReconciliationCheckpoint(_drillId, expected, next) {
      const current = await this.readCopyReconciliationCheckpoint(_drillId)
      if (JSON.stringify(current) !== JSON.stringify(expected)) return false
      model.copyReconciliation = next
      return true
    },
    async readExportListingCheckpoint(_drillId, target) {
      return model.exportListings.get(target) ?? {
        complete: true,
        objectCount: 0,
        pageCount: 1,
        started: true,
      }
    },
    async readFileCursor() {
      return model.fileCursor
    },
    async readMultipartUploadListingCheckpoint() {
      return model.multipartUploadListing
    },
    async readResourceCheckpoint() {
      return model.resourceCheckpoint
    },
    async readRun() {
      return model.run
    },
    async readCleanupRun() {
      return model.run
    },
    async readStartIntent(_drillId, target) {
      return model.startIntents.get(target)
    },
    async readVerificationCheckpoint() {
      return undefined
    },
    async readVerificationExportObjectVersion(_drillId, exportArnDigest, objectKey) {
      const matches = model.exportObjectVersions.filter((version) =>
        version.exportArnDigest === exportArnDigest && version.objectKey === objectKey
      )
      if (matches.length > 1) throw new Error('ambiguous export version')
      return matches[0]
    },
    async readVerificationManifestFile(_drillId, target, index) {
      return model.verificationManifestFiles.get(target)?.[index]
    },
    async readVerificationPartitionCountPage(_drillId, role, target) {
      return { count: model.verificationPartitions.get(`${role}\0${target}`)?.size ?? 0 }
    },
    async readVerificationProgress() {
      return model.verificationProgress ?? {
        pageCount: 0,
        partitionCount: 0,
        restoreResources: [],
        revision: 0,
        semanticItemCount: 0,
        semanticPageCount: 0,
        sourceResources: [],
        stage: 'file-data',
        targetIndex: 0,
        unitIndex: 0,
        workItemsSchemaStatus: 'pass',
      }
    },
    async evaluateVerificationSemanticRequirements() {},
    async hasVerificationSemanticFailures() {
      return false
    },
    async readVerificationSemanticRequirementPage() {
      return { requirements: [] }
    },
    async writeVerificationSemanticClaims() {},
    async recordCreatedCopyIntent(_drillId, intentDigest, claimId, copies) {
      const intent = model.intents.get(intentDigest)
      if (!intent || intent.copyClaim?.claimId !== claimId) {
        throw new Error('copy intent claim missing')
      }
      model.intents.set(intentDigest, {
        ...(intent.completedCopy ? { completedCopy: intent.completedCopy } : {}),
        createdCopies: copies.createdCopies,
        intentDigest: intent.intentDigest,
        preexistingScratchVersionIds: intent.preexistingScratchVersionIds,
        selectedCopy: copies.selectedCopy,
        source: intent.source,
      })
    },
    async recordSuccessfulVerification() {
      model.successfulVerificationCount += 1
    },
    async markStartAttempted(_drillId, target, kind) {
      const intent = model.startIntents.get(target)
      if (!intent) throw new Error('start intent missing')
      model.startIntents.set(target, kind === 'restore'
        ? { ...intent, restoreAttempted: true }
        : { ...intent, exportAttempted: true })
    },
    async recordStartedExport(_drillId, target, exportRecord) {
      const intent = model.startIntents.get(target)
      if (!intent) throw new Error('start intent missing')
      model.startIntents.set(target, { ...intent, exportRecord })
    },
    async recordStartedRestore(_drillId, target, restoreRecord) {
      const intent = model.startIntents.get(target)
      if (!intent) throw new Error('start intent missing')
      model.startIntents.set(target, { ...intent, restoreRecord })
    },
    async releaseActiveRun() {
      model.releaseCount += 1
      model.cadence = { ...model.cadence, activeDrillId: undefined }
    },
    async writeCleanupProgress(_drillId, expected, next) {
      if (JSON.stringify(model.cleanupProgress) !== JSON.stringify(expected)) return false
      model.cleanupProgress = next
      return true
    },
    async writeCopyIntent(_drillId, intent) {
      const existing = model.intents.get(intent.intentDigest)
      if (existing && JSON.stringify(existing) !== JSON.stringify(intent)) {
        throw new Error('copy intent conflict')
      }
      model.intents.set(intent.intentDigest, intent)
    },
    async writeCopyVerificationCheckpoint(_drillId, intentDigest, expected, next) {
      const intent = model.intents.get(intentDigest)
      if (!intent || JSON.stringify(intent.verificationCheckpoint) !== JSON.stringify(expected)) {
        return JSON.stringify(intent?.verificationCheckpoint) === JSON.stringify(next)
      }
      model.intents.set(intentDigest, { ...intent, verificationCheckpoint: next })
      return true
    },
    async writeExportListingPage(_drillId, target, expected, versions, nextCursor) {
      const current = await this.readExportListingCheckpoint(_drillId, target)
      if (JSON.stringify(current) !== JSON.stringify(expected)) {
        throw new Error('export listing conflict')
      }
      model.exportObjectVersions.push(...versions)
      model.exportListings.set(
        target,
        createRestoreDrillExportListingCheckpoint(
          expected,
          versions.length,
          nextCursor,
        ),
      )
    },
    async writeExportCompletion() {},
    async writeFileCursor(_drillId, revision, nextKey) {
      if (!model.run || model.run.revision !== revision) return false
      model.fileCursor = {
        complete: nextKey === undefined,
        ...(nextKey ? { nextKey } : {}),
        started: true,
      }
      model.run = { ...model.run, revision: revision + 1 }
      return true
    },
    async writeMultipartUploadListingPage(_drillId, expected, uploads, nextCursor) {
      if (JSON.stringify(model.multipartUploadListing) !== JSON.stringify(expected)) {
        throw new Error('multipart listing conflict')
      }
      model.multipartUploads.push(...uploads)
      model.multipartUploadListing = {
        complete: nextCursor === undefined,
        ...(nextCursor ? { cursor: nextCursor } : {}),
        pageCount: expected.pageCount + 1,
        started: true,
        uploadCount: expected.uploadCount + uploads.length,
      }
    },
    async writeResourceCheckpoint(_drillId, checkpoint) {
      model.resourceCheckpoint = checkpoint
    },
    async writeCleanupRun(run, expected) {
      if (!model.run || JSON.stringify(model.run) !== JSON.stringify(expected)) return false
      model.run = run
      return true
    },
    async writeRun(run, expectedRevision) {
      if (!model.run || model.run.revision !== expectedRevision) return false
      model.run = run
      return true
    },
    async writeStartIntent(_drillId, intent) {
      model.startIntents.set(intent.target, intent)
    },
    async writeVerificationCheckpoint() {},
    async writeVerificationManifestFiles(_drillId, target, files) {
      model.verificationManifestFiles.set(target, [...files])
    },
    async writeVerificationPartitionDigests(_drillId, role, target, digests) {
      const key = `${role}\0${target}`
      const existing = model.verificationPartitions.get(key) ?? new Set<string>()
      for (const digest of digests) existing.add(digest)
      model.verificationPartitions.set(key, existing)
    },
    async writeVerificationProgress(_drillId, expected, next) {
      const current = await this.readVerificationProgress(_drillId)
      if (JSON.stringify(current) !== JSON.stringify(expected)) {
        return JSON.stringify(current) === JSON.stringify(next)
      }
      model.verificationProgress = next
      return true
    },
  }
}

/** Creates a state model with empty bounded checkpoints. */
function createStateModel(
  values: Partial<StateModel> = {},
): StateModel {
  return {
    cadence: { revision: 0 },
    cleanupProgress: {
      absenceReceiptCount: 0,
      exportObjectIndex: 0,
      fileObjectIndex: 0,
      multipartUploadIndex: 0,
      tableIndex: 0,
    },
    fileCursor: { complete: false, started: false },
    exportObjectVersions: [],
    exportListings: new Map(),
    intents: new Map(),
    multipartUploadListing: {
      complete: true,
      pageCount: 1,
      started: true,
      uploadCount: 0,
    },
    multipartUploads: [],
    releaseCount: 0,
    successfulVerificationCount: 0,
    startIntents: new Map(),
    verificationManifestFiles: new Map(),
    verificationPartitions: new Map(),
    ...values,
  }
}

/** Creates no-op full AWS operations with a real in-memory digest-key callback. */
function createOperations(): RestoreDrillAwsOperations {
  const unavailable = () => Promise.reject(new Error('unexpected operation'))
  return {
    abortRecordedMultipartUpload: unavailable,
    close() {},
    collectSourceTableObservations: unavailable,
    commitFileRemap: unavailable,
    createDigestKeyEnvelope: unavailable,
    createOrAdoptFileVersion: unavailable,
    reconcileCreatedFileVersions: unavailable,
    deleteRecordedExportObjectVersion: unavailable,
    deleteRecordedRestoreTable: unavailable,
    deleteRecordedScratchObjectVersion: unavailable,
    listRecordedExportObjectVersionPage: unavailable,
    listRecordedExportObjectVersions: unavailable,
    async listRecordedMultipartUploadPage() {
      return { uploads: [] }
    },
    listScratchObjectVersionIds: unavailable,
    pollTableExport: unavailable,
    pollTableRestore: unavailable,
    scanFileProofingPage: unavailable,
    scanRestoreAggregatePage: unavailable,
    startTableExport: unavailable,
    startTableRestore: unavailable,
    verifyCreatedFileVersion: unavailable,
    async withDigestKey(_drillId, _envelope, consumer) {
      return consumer(Uint8Array.from(DIGEST_KEY))
    },
  }
}

/** Creates the fixed strict EventBridge envelope admitted by schedule tests. */
function scheduledEvent(time: string) {
  return {
    account: ACCOUNT_ID,
    detail: {},
    'detail-type': 'Scheduled Event',
    id: 'event-restore-drill-1',
    region: REGION,
    resources: ['arn:aws:events:ap-northeast-1:123456789012:rule/restore'],
    source: 'aws.events',
    time,
    version: '0',
  }
}

/** Creates a complete approval-facing passing run. */
function awaitingApprovalRun(resourceDigest: string): RestoreDrillDurableRun {
  return {
    cleanupPolicyVersion: RESTORE_DRILL_CLEANUP_POLICY_VERSION,
    deadlineAt: DEADLINE_AT,
    digestKeyEnvelope: ENVELOPE,
    drillId: DRILL_ID,
    failureCodes: [],
    outcome: 'in-progress',
    phase: 'awaiting-cleanup-approval',
    resourceDigest,
    restorePoint: STARTED_AT,
    resultDigest: RESULT_DIGEST,
    resultEvidenceKey: `evidence/v1/runs/${DRILL_ID}/result.json`,
    resultOutcome: 'pass',
    revision: 5,
    runnerExecutionArn: RUNNER_EXECUTION_ARN,
    startedAt: STARTED_AT,
    updatedAt: STARTED_AT,
    verificationCompletedAt: STARTED_AT,
  }
}

/** Serializes one strict RUN fixture in the exact document shape used by state reads. */
function stateRunItem(run: RestoreDrillDurableRun): Readonly<Record<string, unknown>> {
  return {
    ...run,
    failureCodes: [...run.failureCodes],
    kind: 'mukuroji-restore-drill-run',
    recordKey: 'RUN',
    runVersion: 1,
    scopeKey: `RESTORE_DRILL#${run.drillId}`,
  }
}

/** Creates one pre-approval run whose external work has stopped for failure sealing. */
function failureSealingRun(
  phase: RestoreDrillDurableRun['phase'] = 'copying-file-versions',
): RestoreDrillDurableRun {
  return {
    cleanupPolicyVersion: RESTORE_DRILL_CLEANUP_POLICY_VERSION,
    deadlineAt: DEADLINE_AT,
    digestKeyEnvelope: ENVELOPE,
    drillId: DRILL_ID,
    failureCodes: [],
    outcome: 'in-progress',
    phase,
    revision: 3,
    runnerExecutionArn: RUNNER_EXECUTION_ARN,
    startedAt: STARTED_AT,
    updatedAt: '2026-08-01T00:30:00.000Z',
    verificationCompletedAt: '2026-08-01T00:30:00.000Z',
  }
}

/** Creates one complete passing result artifact for terminal replay tests. */
function passingResultArtifact(): RestoreDrillEvidenceArtifact {
  return {
    result: {
      completedAt: STARTED_AT,
      comparison: { failureCodes: [], status: 'pass' },
      drillId: DRILL_ID,
      failureCodes: [],
      kind: 'mukuroji-restore-drill-result',
      objectives: {
        failureCodes: [],
        rpoMet: true,
        rpoSeconds: 0,
        rpoTargetSeconds: 300,
        rtoMet: true,
        rtoSeconds: 0,
        rtoTargetSeconds: 14_400,
      },
      resourceDigest: DIGEST,
      restoreAggregateDigest: DIGEST,
      restorePoint: STARTED_AT,
      resultVersion: 1,
      runState: { outcome: 'pass', phase: 'completed' },
      sourceAggregateDigest: DIGEST,
      startedAt: STARTED_AT,
    },
    resultDigest: RESULT_DIGEST,
    semantic: { crossDomainStatus: 'pass', workItemsSchemaStatus: 'pass' },
  }
}

/** Serializes a JSON-compatible fixture with recursively ordered object keys. */
function canonicalFixtureJson(value: unknown): string {
  return JSON.stringify(sortFixtureJsonValue(value))
}

/** Recursively orders record keys for canonical fixture serialization. */
function sortFixtureJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortFixtureJsonValue)
  if (!isFixtureRecord(value)) return value
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    result[key] = sortFixtureJsonValue(value[key])
  }
  return result
}

/** Returns whether a fixture value is a non-array JSON object. */
function isFixtureRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Calculates the exact empty cleanup scope used by the cleanup fixture. */
function emptyCleanupScopeDigest(): string {
  return createHmac('sha256', DIGEST_KEY)
    .update('mukuroji-restore-drill-cleanup-scope-v1\0', 'utf8')
    .update(
      '{"exportObjects":[],"exportRecords":[],"files":[],"tables":[],"uploads":[]}',
      'utf8',
    )
    .digest('hex')
}

/** Creates an authenticated cleanup receipt and its deterministic execution identity. */
function createApproval(
  approvedAt = '2026-08-01T00:10:00.000Z',
  expiresAt = '2026-08-01T01:10:00.000Z',
  resourceDigest = emptyCleanupScopeDigest(),
  resultDigest = RESULT_DIGEST,
): {
  /** Deterministic Standard execution ARN. */
  readonly executionArn: string
  /** Deterministic Standard execution name. */
  readonly executionName: string
  /** Authenticated approval receipt. */
  readonly receipt: RestoreDrillCleanupApprovalReceipt
} {
  const receipt = createRestoreDrillCleanupApprovalReceipt({
    approvedAt,
    approver: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/restore-owner/session-1`,
    changeLocator: 'change-immutable-1',
    drillId: DRILL_ID,
    expiresAt,
    policyVersion: RESTORE_DRILL_CLEANUP_POLICY_VERSION,
    resourceDigest,
    resultDigest,
  }, DIGEST_KEY)
  const executionName = createRestoreDrillCleanupExecutionName(receipt)
  return {
    executionArn:
      `arn:aws:states:${REGION}:${ACCOUNT_ID}:execution:cleanup:${executionName}`,
    executionName,
    receipt,
  }
}

/** Creates a deterministic orchestrator fixture over explicit in-memory ports. */
function createOrchestratorFixture(input: {
  /** Mutable clock. */
  readonly now: () => Date
  /** Mutable state model. */
  readonly model: StateModel
  /** Optional immutable approval reader. */
  readonly approvals?: RestoreDrillApprovalStore
  /** Optional evidence writer. */
  readonly evidence?: RestoreDrillEvidenceStore
  /** Optional execution observation. */
  readonly execution?: RestoreDrillCleanupExecutionObservation
  /** Optional mutable execution-status reader. */
  readonly executions?: RestoreDrillCleanupExecutionStore
  /** Optional metric sink used to inject response loss. */
  readonly metricSink?: RestoreDrillMetricSink
  /** Optional custom durable-state adapter. */
  readonly state?: RestoreDrillStateStore
}) {
  const metrics: Array<{ name: RestoreDrillMetricName; value: number }> = []
  const evidenceArtifacts: unknown[] = []
  const orchestrator = createRestoreDrillOrchestrator({
    approvals: input.approvals ?? {
      async readImmutable() {
        throw new Error('approval unavailable')
      },
    },
    evidence: input.evidence ?? {
      async putImmutable(objectKey, artifact) {
        evidenceArtifacts.push(artifact)
        return { checksumSha256: 'checksum', objectKey }
      },
      async putImmutablePinned(objectKey, artifactJson) {
        const artifact: unknown = JSON.parse(artifactJson)
        evidenceArtifacts.push(artifact)
        return { checksumSha256: 'checksum', objectKey }
      },
    },
    executions: input.executions ?? {
      async readStatus() {
        return input.execution ?? { redriveCount: 0, status: 'RUNNING' }
      },
    },
    metrics: input.metricSink ?? {
      async put(name, value) {
        metrics.push({ name, value })
      },
    },
    now: input.now,
    randomId: () => DRILL_ID,
    state: input.state ?? createState(input.model),
    verifier: {
      async resolveSemanticSecretVersion() {
        throw new Error('verification unavailable')
      },
      async readSemanticClaimPage() {
        throw new Error('verification unavailable')
      },
      async aggregateSourceExportFile() {
        throw new Error('verification unavailable')
      },
      async assembleVerification(): Promise<RestoreDrillVerificationResult> {
        throw new Error('verification unavailable')
      },
      async finalizeFileVerification() {
        throw new Error('verification unavailable')
      },
      async readSourceExportManifest() {
        throw new Error('verification unavailable')
      },
    },
  })
  return { evidenceArtifacts, metrics, orchestrator }
}

describe('restore drill orchestrator request boundary', () => {
  test('requires exact cleanup execution identity on every invocation', () => {
    const approval = createApproval()
    expect(parseRestoreDrillHandlerRequest({
      action: 'cleanup',
      approvalObjectKey:
        `approvals/v1/runs/${DRILL_ID}/${approval.receipt.approvalMac}.json`,
      cleanupExecutionArn: approval.executionArn,
      cleanupExecutionName: approval.executionName,
      drillId: DRILL_ID,
    })).toEqual({
      action: 'cleanup',
      approvalObjectKey:
        `approvals/v1/runs/${DRILL_ID}/${approval.receipt.approvalMac}.json`,
      cleanupExecutionArn: approval.executionArn,
      cleanupExecutionName: approval.executionName,
      drillId: DRILL_ID,
    })
    expect(() => parseRestoreDrillHandlerRequest({
      action: 'cleanup',
      drillId: DRILL_ID,
    })).toThrow(RestoreDrillOrchestratorFailure)
  })

  test('rejects extra outer request fields', () => {
    expect(() => parseRestoreDrillHandlerRequest({
      action: 'advance',
      drillId: DRILL_ID,
      sourceTableName: 'must-not-be-accepted',
    })).toThrow(RestoreDrillOrchestratorFailure)
  })

  test('requires the exact runner execution identity on advance and finalization', () => {
    expect(parseRestoreDrillHandlerRequest({
      action: 'advance',
      drillId: DRILL_ID,
      runnerExecutionArn: RUNNER_EXECUTION_ARN,
    })).toEqual({
      action: 'advance',
      drillId: DRILL_ID,
      runnerExecutionArn: RUNNER_EXECUTION_ARN,
    })
    expect(() => parseRestoreDrillHandlerRequest({
      action: 'finalize-failure',
    })).toThrow(RestoreDrillOrchestratorFailure)
    expect(parseRestoreDrillHandlerRequest({
      action: 'finalize-poll-budget-exceeded',
      drillId: DRILL_ID,
      runnerExecutionArn: RUNNER_EXECUTION_ARN,
    })).toEqual({
      action: 'finalize-poll-budget-exceeded',
      drillId: DRILL_ID,
      runnerExecutionArn: RUNNER_EXECUTION_ARN,
    })
  })

  test.each([
    { partition: 'aws-us-gov', region: 'us-gov-west-1' },
    { partition: 'aws-cn', region: 'cn-north-1' },
  ])('accepts Region-bound $partition runner and cleanup execution ARNs', ({
    partition,
    region,
  }) => {
    const runnerExecutionArn =
      `arn:${partition}:states:${region}:${ACCOUNT_ID}:execution:restore-drill:runner-1`
    const cleanupExecutionName = `restore-cleanup-${'d'.repeat(64)}`
    const cleanupExecutionArn =
      `arn:${partition}:states:${region}:${ACCOUNT_ID}:execution:cleanup:${cleanupExecutionName}`

    expect(parseRestoreDrillHandlerRequest({
      action: 'advance',
      drillId: DRILL_ID,
      runnerExecutionArn,
    })).toEqual({ action: 'advance', drillId: DRILL_ID, runnerExecutionArn })
    expect(parseRestoreDrillHandlerRequest({
      action: 'cleanup',
      cleanupExecutionArn,
      cleanupExecutionName,
      drillId: DRILL_ID,
    })).toEqual({
      action: 'cleanup',
      cleanupExecutionArn,
      cleanupExecutionName,
      drillId: DRILL_ID,
    })
  })

  test('rejects Step Functions ARNs whose partition disagrees with their Region', () => {
    expect(() => parseRestoreDrillHandlerRequest({
      action: 'advance',
      drillId: DRILL_ID,
      runnerExecutionArn:
        `arn:aws:states:cn-north-1:${ACCOUNT_ID}:execution:restore-drill:runner-1`,
    })).toThrow(new RestoreDrillOrchestratorFailure('REQUEST_INVALID'))
    const cleanupExecutionName = `restore-cleanup-${'d'.repeat(64)}`
    expect(() => parseRestoreDrillHandlerRequest({
      action: 'cleanup',
      cleanupExecutionArn:
        `arn:aws-cn:states:us-gov-west-1:${ACCOUNT_ID}:execution:cleanup:${cleanupExecutionName}`,
      cleanupExecutionName,
      drillId: DRILL_ID,
    })).toThrow(new RestoreDrillOrchestratorFailure('REQUEST_INVALID'))
  })
})

describe('restore drill cadence and replay', () => {
  test('admits at day 89 and emits cadence overdue at day 90', async () => {
    const cases: readonly (readonly [number, boolean])[] = [
      [RESTORE_DRILL_DUE_DAYS, false],
      [RESTORE_DRILL_OVERDUE_DAYS, true],
    ]
    for (const [ageDays, overdueExpected] of cases) {
      const now = new Date('2026-08-01T00:00:00.000Z')
      const model = createStateModel({
        cadence: {
          lastSuccessfulVerifiedAt: new Date(
            now.getTime() - ageDays * 86_400_000,
          ).toISOString(),
          revision: 3,
        },
      })
      const fixture = createOrchestratorFixture({ model, now: () => now })
      const result = await fixture.orchestrator.advance(
        scheduledEvent(now.toISOString()),
        createOperations(),
        RUNNER_EXECUTION_ARN,
      )
      expect(result.status).toBe('pending')
      expect(model.cadence.cadenceOriginAt).toBe(now.toISOString())
      expect(fixture.metrics.some(
        (metric) => metric.name === 'CadenceOverdueCount' && metric.value === 1,
      )).toBe(overdueExpected)
    }
  })

  test('emits cleanup overdue for an active lease even before cadence is due', async () => {
    const now = new Date('2026-08-02T00:00:00.000Z')
    const run = awaitingApprovalRun(emptyCleanupScopeDigest())
    const model = createStateModel({
      cadence: {
        activeDrillId: DRILL_ID,
        cadenceOriginAt: STARTED_AT,
        revision: 2,
      },
      run,
    })
    const fixture = createOrchestratorFixture({ model, now: () => now })
    const result = await fixture.orchestrator.advance(
      scheduledEvent(now.toISOString()),
      createOperations(),
      RUNNER_EXECUTION_ARN,
    )
    expect(result.status).toBe('not-due')
    expect(fixture.metrics).toContainEqual({ name: 'CleanupOverdueCount', value: 1 })
  })

  test('reconciles passing cadence state on awaiting-approval replay', async () => {
    const run = awaitingApprovalRun(emptyCleanupScopeDigest())
    const model = createStateModel({ run })
    const fixture = createOrchestratorFixture({
      model,
      now: () => new Date(STARTED_AT),
    })
    const result = await fixture.orchestrator.advance(
      { drillId: DRILL_ID },
      createOperations(),
      RUNNER_EXECUTION_ARN,
    )
    expect(result.status).toBe('awaiting-cleanup-approval')
    expect(model.successfulVerificationCount).toBe(1)
  })

  test('rejects a delayed timeout finalizer from another runner execution', async () => {
    const run = awaitingApprovalRun(emptyCleanupScopeDigest())
    const model = createStateModel({
      cadence: { activeDrillId: DRILL_ID, revision: 2 },
      run,
    })
    const fixture = createOrchestratorFixture({
      model,
      now: () => new Date(STARTED_AT),
    })
    const result = await fixture.orchestrator.finalizeFailure(
      undefined,
      createOperations(),
      `arn:aws:states:${REGION}:${ACCOUNT_ID}:execution:restore-drill:stale-runner`,
    )
    expect(result.status).toBe('failed')
    expect(model.run).toEqual(run)
  })

  test('seals poll-budget exhaustion as a non-integrity operational failure', async () => {
    const model = createStateModel({
      resourceCheckpoint: emptyResourceCheckpoint(),
      run: failureSealingRun('scheduled'),
    })
    const fixture = createOrchestratorFixture({
      model,
      now: () => new Date('2026-08-01T00:30:00.000Z'),
    })
    const result = await fixture.orchestrator.finalizePollBudgetExceeded(
      DRILL_ID,
      createOperations(),
      RUNNER_EXECUTION_ARN,
    )
    expect(result.status).toBe('awaiting-cleanup-approval')
    expect(model.run?.failureCodes).toContain('WORKFLOW_POLL_BUDGET_EXCEEDED')
    expect(fixture.evidenceArtifacts).toContainEqual(expect.objectContaining({
      failureCode: 'WORKFLOW_POLL_BUDGET_EXCEEDED',
      kind: 'mukuroji-restore-drill-operational-failure',
      phase: 'scheduled',
    }))
    expect(fixture.metrics).toContainEqual({
      name: 'DrillFailureCount',
      value: 1,
    })
    expect(fixture.metrics).toContainEqual({
      name: 'IntegrityFailureCount',
      value: 0,
    })
  })

  test('reuses the first pinned terminal bytes when competing finalizers race', async () => {
    const observedBodies: string[] = []
    let writes = 0
    const evidence: RestoreDrillEvidenceStore = {
      async putImmutable(objectKey) {
        return { checksumSha256: 'checksum', objectKey }
      },
      async putImmutablePinned(objectKey, artifactJson) {
        observedBodies.push(artifactJson)
        writes += 1
        if (writes === 1) throw new Error('put response lost before reconciliation')
        return { checksumSha256: 'checksum', objectKey }
      },
    }
    const model = createStateModel({
      resourceCheckpoint: emptyResourceCheckpoint(),
      run: failureSealingRun('scheduled'),
    })
    const fixture = createOrchestratorFixture({
      evidence,
      model,
      now: () => new Date('2026-08-01T00:30:00.000Z'),
    })
    const first = await fixture.orchestrator.finalizePollBudgetExceeded(
      DRILL_ID,
      createOperations(),
      RUNNER_EXECUTION_ARN,
    )
    expect(first.status).toBe('pending')
    expect(model.run?.phase).toBe('scheduled')
    expect(model.run?.terminalArtifactIntent?.failureCodes)
      .toEqual(['WORKFLOW_POLL_BUDGET_EXCEEDED'])

    const competing = await fixture.orchestrator.finalizeFailure(
      DRILL_ID,
      createOperations(),
      RUNNER_EXECUTION_ARN,
    )
    expect(competing.status).toBe('awaiting-cleanup-approval')
    expect(observedBodies).toHaveLength(2)
    expect(observedBodies[0]).toBe(observedBodies[1])
    expect(model.run?.failureCodes).toEqual(['WORKFLOW_POLL_BUDGET_EXCEEDED'])
    expect(model.run?.terminalArtifactIntent).toBeUndefined()
    expect(model.run?.terminalEffectIndex).toBeUndefined()
  })

  test('replays a metric response loss before exposing cleanup approval', async () => {
    const metricCalls: Array<{ name: RestoreDrillMetricName; value: number }> = []
    let loseFirstResponse = true
    const model = createStateModel({
      resourceCheckpoint: emptyResourceCheckpoint(),
      run: failureSealingRun('scheduled'),
    })
    const fixture = createOrchestratorFixture({
      metricSink: {
        async put(name, value) {
          metricCalls.push({ name, value })
          if (loseFirstResponse) {
            loseFirstResponse = false
            throw new Error('metric response lost')
          }
        },
      },
      model,
      now: () => new Date('2026-08-01T00:30:00.000Z'),
    })
    const first = await fixture.orchestrator.finalizeFailure(
      DRILL_ID,
      createOperations(),
      RUNNER_EXECUTION_ARN,
    )
    expect(first.status).toBe('pending')
    expect(model.run?.phase).toBe('scheduled')
    expect(model.run?.terminalEffectIndex).toBe(0)

    const replay = await fixture.orchestrator.advance(
      { drillId: DRILL_ID },
      createOperations(),
      RUNNER_EXECUTION_ARN,
    )
    expect(replay.status).toBe('awaiting-cleanup-approval')
    expect(metricCalls).toEqual([
      { name: 'DrillFailureCount', value: 1 },
      { name: 'DrillFailureCount', value: 1 },
      { name: 'IntegrityFailureCount', value: 0 },
    ])
    expect(model.run?.failureCodes).toEqual(['WORKFLOW_TASK_FAILED'])
  })

  test('replays successful-verification response loss before approval admission', async () => {
    const artifact = passingResultArtifact()
    const run: RestoreDrillDurableRun = {
      ...failureSealingRun('verifying'),
      restorePoint: STARTED_AT,
      terminalArtifactIntent: {
        artifactJson: canonicalFixtureJson(artifact),
        effects: [{ completedAt: STARTED_AT, kind: 'record-successful-verification' }],
        evidenceKey: `evidence/v1/runs/${DRILL_ID}/result.json`,
        failureCodes: [],
        resourceDigest: DIGEST,
        resultDigest: RESULT_DIGEST,
        resultOutcome: 'pass',
        retentionReferenceAt: STARTED_AT,
      },
      terminalEffectIndex: 0,
    }
    const model = createStateModel({ run })
    const baseState = createState(model)
    let calls = 0
    const fixture = createOrchestratorFixture({
      model,
      now: () => new Date(STARTED_AT),
      state: {
        ...baseState,
        async recordSuccessfulVerification() {
          calls += 1
          if (calls === 1) throw new Error('cadence response lost')
        },
      },
    })
    expect((await fixture.orchestrator.advance(
      { drillId: DRILL_ID },
      createOperations(),
      RUNNER_EXECUTION_ARN,
    )).status).toBe('pending')
    expect(model.run?.phase).toBe('verifying')
    expect((await fixture.orchestrator.advance(
      { drillId: DRILL_ID },
      createOperations(),
      RUNNER_EXECUTION_ARN,
    )).status).toBe('awaiting-cleanup-approval')
    expect(calls).toBe(2)
  })

  const failureScenarios: readonly {
    readonly expectedCode: RestoreDrillFailureCode
    readonly failure: Error
    readonly integrityValue: number
    readonly label: string
  }[] = [
    {
      expectedCode: 'S3_VERSION_RESTORE_FAILED',
      failure: new RestoreDrillAwsFailure('FILE_COPY_CHECKSUM_MISMATCH'),
      integrityValue: 1,
      label: 'explicit AWS copy mismatch',
    },
    {
      expectedCode: 'AGGREGATE_CONTENT_MISMATCH',
      failure: new RestoreDrillFailure('AGGREGATE_CONTENT_MISMATCH'),
      integrityValue: 1,
      label: 'explicit domain mismatch',
    },
    {
      expectedCode: 'WORKFLOW_TASK_FAILED',
      failure: new Error('transport unavailable'),
      integrityValue: 0,
      label: 'raw service failure',
    },
  ]
  for (const scenario of failureScenarios) {
    test(`classifies ${scenario.label} without losing it across finalization`, async () => {
      let envelopeAttempts = 0
      const operations: RestoreDrillAwsOperations = {
        ...createOperations(),
        async createDigestKeyEnvelope() {
          envelopeAttempts += 1
          if (envelopeAttempts === 1) throw scenario.failure
          return ENVELOPE
        },
      }
      const model = createStateModel({
        run: {
          cleanupPolicyVersion: RESTORE_DRILL_CLEANUP_POLICY_VERSION,
          deadlineAt: DEADLINE_AT,
          drillId: DRILL_ID,
          failureCodes: [],
          outcome: 'in-progress',
          phase: 'scheduled',
          revision: 1,
          runnerExecutionArn: RUNNER_EXECUTION_ARN,
          startedAt: STARTED_AT,
          updatedAt: STARTED_AT,
        },
      })
      const fixture = createOrchestratorFixture({
        model,
        now: () => new Date('2026-08-01T00:30:00.000Z'),
      })
      let status = 'pending'
      for (let attempt = 0; attempt < 10 && status === 'pending'; attempt += 1) {
        status = (await fixture.orchestrator.advance(
          { drillId: DRILL_ID },
          operations,
          RUNNER_EXECUTION_ARN,
        )).status
      }
      expect(status).toBe('awaiting-cleanup-approval')
      expect(model.run?.failureCodes).toContain(scenario.expectedCode)
      expect(fixture.metrics).toContainEqual({
        name: 'DrillFailureCount',
        value: 1,
      })
      expect(fixture.metrics).toContainEqual({
        name: 'IntegrityFailureCount',
        value: scenario.integrityValue,
      })
    })
  }

  test('classifies a verification inventory limit as an operational failure', async () => {
    const source: RestoreDrillSourceTableObservation = {
      descriptor: tableDescriptor(),
      earliestRestorableAt: '2026-07-01T00:00:00.000Z',
      latestRestorableAt: STARTED_AT,
      sourceTableArn:
        `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/audit-events`,
      target: 'table:audit-events',
    }
    const exportRecord: RestoreDrillRecordedExport = {
      clientToken: createHash('sha256')
        .update(`export\0${DRILL_ID}\0${source.target}\0${STARTED_AT}`, 'utf8')
        .digest('hex'),
      exportArn: `${source.sourceTableArn}/export/01693685827463-2d8752fd`,
      exportPoint: STARTED_AT,
      kind: 'table-export',
      scratchPrefix: `restore-drill/${DRILL_DIGEST}/${source.target}/export`,
      sourceTableArn: source.sourceTableArn,
      sourceTableId: source.descriptor.tableId,
      target: source.target,
    }
    const model = createStateModel({
      cleanupScope: {
        complete: true,
        exportObjectCount: 0,
        fileObjectCount: 0,
        ledgerCount: 0,
        ledgerRevision: 0,
        multipartUploadCount: 0,
        resourceDigest: DIGEST,
        rollingDigest: DIGEST,
        started: true,
        tableCount: 0,
      },
      exportListings: new Map([[
        source.target,
        { complete: true, objectCount: 0, pageCount: 11, started: true },
      ]]),
      resourceCheckpoint: {
        exports: [exportRecord],
        restoredDescriptors: [],
        restores: [],
        sources: [source],
      },
      run: {
        ...failureSealingRun('verifying'),
        restorePoint: STARTED_AT,
      },
    })
    const operations: RestoreDrillAwsOperations = {
      ...createOperations(),
      /** Returns one completed export whose manifest violates the logical limits. */
      async pollTableExport() {
        return {
          itemCount: 0,
          manifestKey:
            `${exportRecord.scratchPrefix}/AWSDynamoDB/01693685827463-2d8752fd/manifest-summary.json`,
          status: 'completed',
        }
      },
    }
    const fixture = createOrchestratorFixture({
      model,
      now: () => new Date('2026-08-01T00:30:00.000Z'),
    })

    const result = await fixture.orchestrator.advance(
      { drillId: DRILL_ID },
      operations,
      RUNNER_EXECUTION_ARN,
    )

    expect(result.status).toBe('awaiting-cleanup-approval')
    expect(model.run?.failureCodes).toEqual(['WORKFLOW_TASK_FAILED'])
    expect(fixture.evidenceArtifacts).toContainEqual(expect.objectContaining({
      failureCode: 'WORKFLOW_TASK_FAILED',
      kind: 'mukuroji-restore-drill-operational-failure',
      phase: 'verifying',
    }))
    expect(fixture.metrics).toContainEqual({
      name: 'IntegrityFailureCount',
      value: 0,
    })
  })

  test('preserves the first durable failure when finalization itself is retried', async () => {
    let envelopeAttempts = 0
    let inventoryAttempts = 0
    const operations: RestoreDrillAwsOperations = {
      ...createOperations(),
      async createDigestKeyEnvelope() {
        envelopeAttempts += 1
        if (envelopeAttempts === 1) {
          throw new RestoreDrillAwsFailure('FILE_COPY_CHECKSUM_MISMATCH')
        }
        return ENVELOPE
      },
      async listRecordedMultipartUploadPage() {
        inventoryAttempts += 1
        if (inventoryAttempts === 1) throw new Error('inventory transport outage')
        return { uploads: [] }
      },
    }
    const model = createStateModel({
      multipartUploadListing: {
        complete: false,
        pageCount: 0,
        started: false,
        uploadCount: 0,
      },
      run: {
        cleanupPolicyVersion: RESTORE_DRILL_CLEANUP_POLICY_VERSION,
        deadlineAt: DEADLINE_AT,
        drillId: DRILL_ID,
        failureCodes: [],
        outcome: 'in-progress',
        phase: 'scheduled',
        revision: 1,
        runnerExecutionArn: RUNNER_EXECUTION_ARN,
        startedAt: STARTED_AT,
        updatedAt: STARTED_AT,
      },
    })
    const fixture = createOrchestratorFixture({
      model,
      now: () => new Date('2026-08-01T00:30:00.000Z'),
    })
    await expect(fixture.orchestrator.advance(
      { drillId: DRILL_ID },
      operations,
      RUNNER_EXECUTION_ARN,
    )).rejects.toThrow('inventory transport outage')
    expect(model.run?.failureCodes).toEqual(['S3_VERSION_RESTORE_FAILED'])

    const result = await fixture.orchestrator.finalizeFailure(
      DRILL_ID,
      operations,
      RUNNER_EXECUTION_ARN,
    )
    expect(result.status).toBe('awaiting-cleanup-approval')
    expect(model.run?.failureCodes).toEqual(['S3_VERSION_RESTORE_FAILED'])
    expect(fixture.metrics).toContainEqual({
      name: 'DrillFailureCount',
      value: 1,
    })
    expect(fixture.metrics).toContainEqual({
      name: 'IntegrityFailureCount',
      value: 1,
    })
  })

  test('preserves a durable RTO failure and its elapsed-time effect in generic finalizer', async () => {
    const model = createStateModel({
      resourceCheckpoint: emptyResourceCheckpoint(),
      run: {
        ...failureSealingRun('scheduled'),
        failureCodes: ['RTO_TARGET_MISSED'],
      },
    })
    const fixture = createOrchestratorFixture({
      model,
      now: () => new Date('2026-08-01T00:30:00.000Z'),
    })
    const result = await fixture.orchestrator.finalizeFailure(
      DRILL_ID,
      createOperations(),
      RUNNER_EXECUTION_ARN,
    )
    expect(result.status).toBe('awaiting-cleanup-approval')
    expect(model.run?.failureCodes).toEqual(['RTO_TARGET_MISSED'])
    expect(fixture.metrics).toContainEqual({ name: 'DrillFailureCount', value: 1 })
    expect(fixture.metrics).toContainEqual({ name: 'IntegrityFailureCount', value: 0 })
    expect(fixture.metrics).toContainEqual({ name: 'RtoSeconds', value: 1_800 })
  })

  test('preserves a known RPO miss when a later workflow failure needs fallback evidence', async () => {
    const model = createStateModel({
      resourceCheckpoint: emptyResourceCheckpoint(),
      run: {
        ...failureSealingRun('restoring-tables'),
        restorePoint: '2026-07-31T23:50:00.000Z',
      },
    })
    const fixture = createOrchestratorFixture({
      model,
      now: () => new Date('2026-08-01T00:30:00.000Z'),
    })
    const result = await fixture.orchestrator.finalizeFailure(
      DRILL_ID,
      createOperations(),
      RUNNER_EXECUTION_ARN,
    )
    expect(result.status).toBe('awaiting-cleanup-approval')
    expect(model.run?.failureCodes).toEqual([
      'RPO_TARGET_MISSED',
      'WORKFLOW_TASK_FAILED',
    ])
    expect(fixture.evidenceArtifacts).toContainEqual(expect.objectContaining({
      failureCode: 'WORKFLOW_TASK_FAILED',
      kind: 'mukuroji-restore-drill-operational-failure',
    }))
    expect(fixture.metrics).toContainEqual({ name: 'RpoSeconds', value: 600 })
    expect(fixture.metrics).toContainEqual({ name: 'DrillFailureCount', value: 1 })
    expect(fixture.metrics).toContainEqual({ name: 'IntegrityFailureCount', value: 0 })
  })

  test('lets a later daily schedule take over and durably seal an overdue active run', async () => {
    const recoveryExecutionArn =
      `arn:aws:states:${REGION}:${ACCOUNT_ID}:execution:restore-drill:daily-recovery`
    const run: RestoreDrillDurableRun = {
      cleanupPolicyVersion: RESTORE_DRILL_CLEANUP_POLICY_VERSION,
      deadlineAt: '2026-08-01T00:10:00.000Z',
      digestKeyEnvelope: ENVELOPE,
      drillId: DRILL_ID,
      failureCodes: [],
      outcome: 'in-progress',
      phase: 'discovering-pitr-windows',
      restorePoint: STARTED_AT,
      revision: 3,
      runnerExecutionArn: RUNNER_EXECUTION_ARN,
      startedAt: STARTED_AT,
      updatedAt: STARTED_AT,
    }
    const model = createStateModel({
      cadence: { activeDrillId: DRILL_ID, revision: 2 },
      resourceCheckpoint: emptyResourceCheckpoint(),
      run,
    })
    const fixture = createOrchestratorFixture({
      model,
      now: () => new Date('2026-08-02T00:00:00.000Z'),
    })
    const result = await fixture.orchestrator.advance(
      scheduledEvent('2026-08-02T00:00:00.000Z'),
      createOperations(),
      recoveryExecutionArn,
    )
    expect(result.status).toBe('awaiting-cleanup-approval')
    expect(model.run?.runnerExecutionArn).toBe(recoveryExecutionArn)
    expect(model.run?.failureCodes).toContain('RTO_TARGET_MISSED')
    expect(model.run?.resultOutcome).toBe('fail')
    expect(model.successfulVerificationCount).toBe(0)
    expect(fixture.metrics).toContainEqual({
      name: 'DrillFailureCount',
      value: 1,
    })
    expect(fixture.evidenceArtifacts).toContainEqual(expect.objectContaining({
      drillId: DRILL_ID,
      failedAt: '2026-08-02T00:00:00.000Z',
      failureCode: 'RTO_TARGET_MISSED',
      kind: 'mukuroji-restore-drill-operational-failure',
      phase: 'discovering-pitr-windows',
    }))
    expect(fixture.metrics).toContainEqual({
      name: 'IntegrityFailureCount',
      value: 0,
    })
    expect(fixture.metrics).toContainEqual({
      name: 'RtoSeconds',
      value: 86_400,
    })
    const stale = await fixture.orchestrator.finalizeFailure(
      DRILL_ID,
      createOperations(),
      RUNNER_EXECUTION_ARN,
    )
    expect(stale.status).toBe('failed')
    expect(model.run?.runnerExecutionArn).toBe(recoveryExecutionArn)
  })
})

describe('restore drill cleanup durability', () => {
  test('requires the newly admitted cleanup execution to be RUNNING', async () => {
    const approval = createApproval()
    const model = createStateModel({
      cadence: { activeDrillId: DRILL_ID, revision: 1 },
      resourceCheckpoint: emptyResourceCheckpoint(),
      run: awaitingApprovalRun(emptyCleanupScopeDigest()),
    })
    const fixture = createOrchestratorFixture({
      approvals: {
        async readImmutable() {
          return { approvalDigest: APPROVAL_DIGEST, receipt: approval.receipt }
        },
      },
      execution: {
        redriveCount: 0,
        status: 'SUCCEEDED',
        stopDate: '2026-08-01T00:19:00.000Z',
      },
      model,
      now: () => new Date('2026-08-01T00:20:00.000Z'),
    })
    const result = await fixture.orchestrator.cleanup({
      approvalObjectKey:
        `approvals/v1/runs/${DRILL_ID}/${approval.receipt.approvalMac}.json`,
      cleanupExecutionArn: approval.executionArn,
      cleanupExecutionName: approval.executionName,
      drillId: DRILL_ID,
    }, createOperations())
    expect(result.status).toBe('failed')
    expect(model.run?.phase).toBe('awaiting-cleanup-approval')
    expect(model.run?.cleanupExecutionArn).toBeUndefined()
  })

  test('rejects same-ARN Step Functions redrive before cleanup admission', async () => {
    const approval = createApproval()
    const model = createStateModel({
      cadence: { activeDrillId: DRILL_ID, revision: 1 },
      resourceCheckpoint: emptyResourceCheckpoint(),
      run: awaitingApprovalRun(emptyCleanupScopeDigest()),
    })
    const fixture = createOrchestratorFixture({
      approvals: {
        async readImmutable() {
          return { approvalDigest: APPROVAL_DIGEST, receipt: approval.receipt }
        },
      },
      execution: { redriveCount: 1, status: 'RUNNING' },
      model,
      now: () => new Date('2026-08-01T00:20:00.000Z'),
    })
    const result = await fixture.orchestrator.cleanup({
      approvalObjectKey:
        `approvals/v1/runs/${DRILL_ID}/${approval.receipt.approvalMac}.json`,
      cleanupExecutionArn: approval.executionArn,
      cleanupExecutionName: approval.executionName,
      drillId: DRILL_ID,
    }, createOperations())
    expect(result.status).toBe('failed')
    expect(model.run?.phase).toBe('awaiting-cleanup-approval')
    expect(model.cleanupProgress.completedAt).toBeUndefined()
  })

  test('rejects same-ARN redrive before the next cleanup logical step', async () => {
    const approval = createApproval()
    let redriveCount = 0
    const model = createStateModel({
      cadence: { activeDrillId: DRILL_ID, revision: 1 },
      resourceCheckpoint: emptyResourceCheckpoint(),
      run: awaitingApprovalRun(emptyCleanupScopeDigest()),
    })
    const fixture = createOrchestratorFixture({
      approvals: {
        async readImmutable() {
          return { approvalDigest: APPROVAL_DIGEST, receipt: approval.receipt }
        },
      },
      executions: {
        async readStatus() {
          return { redriveCount, status: 'RUNNING' }
        },
      },
      model,
      now: () => new Date('2026-08-01T00:20:00.000Z'),
    })
    const first = await fixture.orchestrator.cleanup({
      approvalObjectKey:
        `approvals/v1/runs/${DRILL_ID}/${approval.receipt.approvalMac}.json`,
      cleanupExecutionArn: approval.executionArn,
      cleanupExecutionName: approval.executionName,
      drillId: DRILL_ID,
    }, createOperations())
    expect(first.status).toBe('pending')
    redriveCount = 1
    const replay = await fixture.orchestrator.cleanup({
      cleanupExecutionArn: approval.executionArn,
      cleanupExecutionName: approval.executionName,
      drillId: DRILL_ID,
    }, createOperations())
    expect(replay.status).toBe('failed')
    expect(model.run?.phase).toBe('cleaning-up')
    expect(model.releaseCount).toBe(0)
  })

  test('pins approval and execution once, then ignores expiry on resume', async () => {
    let now = new Date('2026-08-01T00:20:00.000Z')
    const approval = createApproval()
    let approvalReads = 0
    const model = createStateModel({
      cadence: { activeDrillId: DRILL_ID, revision: 1 },
      resourceCheckpoint: emptyResourceCheckpoint(),
      run: awaitingApprovalRun(emptyCleanupScopeDigest()),
    })
    const fixture = createOrchestratorFixture({
      approvals: {
        async readImmutable() {
          approvalReads += 1
          return { approvalDigest: APPROVAL_DIGEST, receipt: approval.receipt }
        },
      },
      model,
      now: () => now,
    })
    const approvalObjectKey =
      `approvals/v1/runs/${DRILL_ID}/${approval.receipt.approvalMac}.json`
    const first = await fixture.orchestrator.cleanup({
      approvalObjectKey,
      cleanupExecutionArn: approval.executionArn,
      cleanupExecutionName: approval.executionName,
      drillId: DRILL_ID,
    }, createOperations())
    expect(first.status).toBe('pending')
    expect(model.run?.cleanupExecutionArn).toBe(approval.executionArn)
    expect(model.cleanupProgress.completedAt).toBe(now.toISOString())
    expect(model.cleanupProgress.artifactIntent).toBeDefined()

    now = new Date('2026-08-01T02:00:00.000Z')
    const resumed = await fixture.orchestrator.cleanup({
      cleanupExecutionArn: approval.executionArn,
      cleanupExecutionName: approval.executionName,
      drillId: DRILL_ID,
    }, createOperations())
    expect(resumed.status).toBe('completed')
    expect(approvalReads).toBe(1)
    expect(model.releaseCount).toBe(1)
    expect(fixture.evidenceArtifacts[0]).toMatchObject({
      approvalAttemptCount: 1,
      approvalDigest: APPROVAL_DIGEST,
      completedAt: '2026-08-01T00:20:00.000Z',
      kind: 'mukuroji-restore-drill-cleanup',
    })
  })

  test('retries an ambiguous cleanup evidence write with identical bytes', async () => {
    let now = new Date('2026-08-01T00:20:00.000Z')
    const approval = createApproval()
    const observedBodies: string[] = []
    let writeCount = 0
    const evidence: RestoreDrillEvidenceStore = {
      async putImmutable(objectKey, artifact) {
        observedBodies.push(JSON.stringify(artifact))
        writeCount += 1
        if (writeCount === 1) throw new Error('response lost')
        return { checksumSha256: 'checksum', objectKey }
      },
      async putImmutablePinned(objectKey, artifactJson) {
        observedBodies.push(artifactJson)
        writeCount += 1
        if (writeCount === 1) throw new Error('response lost')
        return { checksumSha256: 'checksum', objectKey }
      },
    }
    const model = createStateModel({
      cadence: { activeDrillId: DRILL_ID, revision: 1 },
      resourceCheckpoint: emptyResourceCheckpoint(),
      run: awaitingApprovalRun(emptyCleanupScopeDigest()),
    })
    const fixture = createOrchestratorFixture({
      approvals: {
        async readImmutable() {
          return { approvalDigest: APPROVAL_DIGEST, receipt: approval.receipt }
        },
      },
      evidence,
      model,
      now: () => now,
    })
    const firstEvent = {
      approvalObjectKey:
        `approvals/v1/runs/${DRILL_ID}/${approval.receipt.approvalMac}.json`,
      cleanupExecutionArn: approval.executionArn,
      cleanupExecutionName: approval.executionName,
      drillId: DRILL_ID,
    }
    await fixture.orchestrator.cleanup(firstEvent, createOperations())
    now = new Date('2026-08-01T00:30:00.000Z')
    const resumeEvent = {
      cleanupExecutionArn: approval.executionArn,
      cleanupExecutionName: approval.executionName,
      drillId: DRILL_ID,
    }
    expect((await fixture.orchestrator.cleanup(resumeEvent, createOperations())).status)
      .toBe('pending')
    now = new Date('2026-08-01T00:40:00.000Z')
    expect((await fixture.orchestrator.cleanup(resumeEvent, createOperations())).status)
      .toBe('completed')
    expect(observedBodies).toHaveLength(2)
    expect(observedBodies[0]).toBe(observedBodies[1])
  })

  test('reuses pinned cleanup bytes after explicit execution reapproval', async () => {
    let now = new Date('2026-08-01T00:20:00.000Z')
    let oldExecutionFailed = false
    const oldApproval = createApproval()
    const newApproval = createApproval(
      '2026-08-01T01:00:00.000Z',
      '2026-08-01T02:00:00.000Z',
    )
    const observedBodies: string[] = []
    let writes = 0
    const evidence: RestoreDrillEvidenceStore = {
      async putImmutable(objectKey) {
        return { checksumSha256: 'checksum', objectKey }
      },
      async putImmutablePinned(objectKey, artifactJson) {
        observedBodies.push(artifactJson)
        writes += 1
        if (writes === 1) throw new Error('cleanup put response lost')
        return { checksumSha256: 'checksum', objectKey }
      },
    }
    const model = createStateModel({
      cadence: { activeDrillId: DRILL_ID, revision: 1 },
      resourceCheckpoint: emptyResourceCheckpoint(),
      run: awaitingApprovalRun(emptyCleanupScopeDigest()),
    })
    const fixture = createOrchestratorFixture({
      approvals: {
        async readImmutable(objectKey) {
          const receipt = objectKey.includes(newApproval.receipt.approvalMac)
            ? newApproval.receipt
            : oldApproval.receipt
          return { approvalDigest: APPROVAL_DIGEST, receipt }
        },
      },
      evidence,
      executions: {
        async readStatus(executionArn) {
          if (executionArn === oldApproval.executionArn && oldExecutionFailed) {
            return {
              redriveCount: 0,
              status: 'TIMED_OUT',
              stopDate: '2026-08-01T00:30:00.000Z',
            }
          }
          return { redriveCount: 0, status: 'RUNNING' }
        },
      },
      model,
      now: () => now,
    })
    expect((await fixture.orchestrator.cleanup({
      approvalObjectKey:
        `approvals/v1/runs/${DRILL_ID}/${oldApproval.receipt.approvalMac}.json`,
      cleanupExecutionArn: oldApproval.executionArn,
      cleanupExecutionName: oldApproval.executionName,
      drillId: DRILL_ID,
    }, createOperations())).status).toBe('pending')
    now = new Date('2026-08-01T00:30:00.000Z')
    expect((await fixture.orchestrator.cleanup({
      cleanupExecutionArn: oldApproval.executionArn,
      cleanupExecutionName: oldApproval.executionName,
      drillId: DRILL_ID,
    }, createOperations())).status).toBe('pending')
    expect(model.cleanupProgress.artifactIntent).toBeDefined()

    oldExecutionFailed = true
    now = new Date('2026-08-01T01:00:00.000Z')
    const reapproved = await fixture.orchestrator.cleanup({
      approvalObjectKey:
        `approvals/v1/runs/${DRILL_ID}/${newApproval.receipt.approvalMac}.json`,
      cleanupExecutionArn: newApproval.executionArn,
      cleanupExecutionName: newApproval.executionName,
      drillId: DRILL_ID,
    }, createOperations())
    expect(reapproved.status).toBe('completed')
    expect(observedBodies).toHaveLength(2)
    expect(observedBodies[0]).toBe(observedBodies[1])
    const artifact: unknown = JSON.parse(observedBodies[1] ?? '')
    expect(artifact).toEqual(expect.objectContaining({
      approvalAttemptCount: 1,
      completedAt: '2026-08-01T00:20:00.000Z',
    }))
    expect(model.run?.cleanupAttemptCount).toBe(2)
    expect(model.run?.updatedAt).toBe('2026-08-01T01:00:00.000Z')
  })

  test('replays completion effects after completed CAS and rejects another execution', async () => {
    const approval = createApproval()
    let failMetric = true
    const model = createStateModel({
      cadence: { activeDrillId: DRILL_ID, revision: 1 },
      resourceCheckpoint: emptyResourceCheckpoint(),
      run: awaitingApprovalRun(emptyCleanupScopeDigest()),
    })
    const fixture = createOrchestratorFixture({
      approvals: {
        async readImmutable() {
          return { approvalDigest: APPROVAL_DIGEST, receipt: approval.receipt }
        },
      },
      metricSink: {
        async put() {
          if (failMetric) {
            failMetric = false
            throw new Error('metric unavailable')
          }
        },
      },
      model,
      now: () => new Date('2026-08-01T00:20:00.000Z'),
    })
    const firstEvent = {
      approvalObjectKey:
        `approvals/v1/runs/${DRILL_ID}/${approval.receipt.approvalMac}.json`,
      cleanupExecutionArn: approval.executionArn,
      cleanupExecutionName: approval.executionName,
      drillId: DRILL_ID,
    }
    expect((await fixture.orchestrator.cleanup(firstEvent, createOperations())).status)
      .toBe('pending')
    const resumeEvent = {
      cleanupExecutionArn: approval.executionArn,
      cleanupExecutionName: approval.executionName,
      drillId: DRILL_ID,
    }
    expect((await fixture.orchestrator.cleanup(resumeEvent, createOperations())).status)
      .toBe('pending')
    expect(model.run?.phase).toBe('completed')
    expect(model.run?.cleanupEffectIndex).toBe(0)
    expect(model.releaseCount).toBe(0)

    const different = createApproval(
      '2026-08-01T00:21:00.000Z',
      '2026-08-01T01:21:00.000Z',
    )
    expect((await fixture.orchestrator.cleanup({
      cleanupExecutionArn: different.executionArn,
      cleanupExecutionName: different.executionName,
      drillId: DRILL_ID,
    }, createOperations())).status).toBe('failed')
    expect(model.releaseCount).toBe(0)

    expect((await fixture.orchestrator.cleanup(resumeEvent, createOperations())).status)
      .toBe('completed')
    expect(model.run?.cleanupEffectIndex).toBe(2)
    expect(model.releaseCount).toBe(1)
  })

  test('daily schedule recovers a completed run that still owns the active lease', async () => {
    const approval = createApproval()
    const run: RestoreDrillDurableRun = {
      ...awaitingApprovalRun(emptyCleanupScopeDigest()),
      approvalDigest: APPROVAL_DIGEST,
      approvalObjectKey:
        `approvals/v1/runs/${DRILL_ID}/${approval.receipt.approvalMac}.json`,
      approvedAt: approval.receipt.approvedAt,
      cleanupAttemptCount: 1,
      cleanupEffectIndex: 0,
      cleanupExecutionArn: approval.executionArn,
      cleanupExecutionName: approval.executionName,
      cleanupStartedAt: '2026-08-01T00:20:00.000Z',
      outcome: 'pass',
      phase: 'completed',
    }
    const model = createStateModel({
      cadence: { activeDrillId: DRILL_ID, revision: 4 },
      run,
    })
    const fixture = createOrchestratorFixture({
      model,
      now: () => new Date('2026-08-02T00:00:00.000Z'),
    })
    const result = await fixture.orchestrator.advance(
      scheduledEvent('2026-08-02T00:00:00.000Z'),
      createOperations(),
      RUNNER_EXECUTION_ARN,
    )
    expect(result.status).toBe('not-due')
    expect(model.run?.cleanupEffectIndex).toBe(2)
    expect(model.releaseCount).toBe(1)
    expect(fixture.metrics).toContainEqual({ name: 'CleanupOverdueCount', value: 0 })
  })

  test('rejects stale parallel reapproval and then admits a fresh receipt', async () => {
    const admitted = createApproval(
      '2026-08-01T01:00:00.000Z',
      '2026-08-01T03:00:00.000Z',
    )
    const stale = createApproval(
      '2026-08-01T00:50:00.000Z',
      '2026-08-01T03:00:00.000Z',
    )
    const fresh = createApproval(
      '2026-08-01T01:30:00.000Z',
      '2026-08-01T03:00:00.000Z',
    )
    const run: RestoreDrillDurableRun = {
      ...awaitingApprovalRun(emptyCleanupScopeDigest()),
      approvalDigest: APPROVAL_DIGEST,
      approvalObjectKey:
        `approvals/v1/runs/${DRILL_ID}/${admitted.receipt.approvalMac}.json`,
      approvedAt: admitted.receipt.approvedAt,
      cleanupAttemptCount: 2,
      cleanupExecutionArn: admitted.executionArn,
      cleanupExecutionName: admitted.executionName,
      cleanupStartedAt: '2026-08-01T00:20:00.000Z',
      phase: 'cleaning-up',
    }
    const receipts = new Map([
      [stale.receipt.approvalMac, stale.receipt],
      [fresh.receipt.approvalMac, fresh.receipt],
    ])
    const model = createStateModel({
      cleanupProgress: {
        absenceReceiptCount: 0,
        completedAt: '2026-08-01T00:30:00.000Z',
        exportObjectIndex: 0,
        fileObjectIndex: 0,
        multipartUploadIndex: 0,
        tableIndex: 0,
      },
      resourceCheckpoint: emptyResourceCheckpoint(),
      run,
    })
    const fixture = createOrchestratorFixture({
      approvals: {
        async readImmutable(objectKey) {
          const receipt = [...receipts].find(([mac]) => objectKey.includes(mac))?.[1]
          if (!receipt) throw new Error('receipt missing')
          return { approvalDigest: DIGEST, receipt }
        },
      },
      executions: {
        async readStatus(executionArn) {
          return executionArn === admitted.executionArn
            ? {
                redriveCount: 0,
                status: 'FAILED',
                stopDate: '2026-08-01T01:10:00.000Z',
              }
            : { redriveCount: 0, status: 'RUNNING' }
        },
      },
      model,
      now: () => new Date('2026-08-01T01:40:00.000Z'),
    })
    const staleResult = await fixture.orchestrator.cleanup({
      approvalObjectKey:
        `approvals/v1/runs/${DRILL_ID}/${stale.receipt.approvalMac}.json`,
      cleanupExecutionArn: stale.executionArn,
      cleanupExecutionName: stale.executionName,
      drillId: DRILL_ID,
    }, createOperations())
    expect(staleResult.status).toBe('failed')
    expect(model.run?.cleanupExecutionArn).toBe(admitted.executionArn)
    expect(model.run?.cleanupAttemptCount).toBe(2)

    const freshResult = await fixture.orchestrator.cleanup({
      approvalObjectKey:
        `approvals/v1/runs/${DRILL_ID}/${fresh.receipt.approvalMac}.json`,
      cleanupExecutionArn: fresh.executionArn,
      cleanupExecutionName: fresh.executionName,
      drillId: DRILL_ID,
    }, createOperations())
    expect(freshResult.status).toBe('pending')
    expect(model.run?.cleanupExecutionArn).toBe(fresh.executionArn)
    expect(model.run?.approvedAt).toBe(fresh.receipt.approvedAt)
    expect(model.run?.cleanupAttemptCount).toBe(3)
    expect(model.cleanupProgress.completedAt).toBe('2026-08-01T01:40:00.000Z')
    const artifactJson = model.cleanupProgress.artifactIntent?.artifactJson ?? ''
    const artifact: unknown = JSON.parse(artifactJson)
    expect(artifact).toEqual(expect.objectContaining({
      approvalAttemptCount: 3,
      completedAt: '2026-08-01T01:40:00.000Z',
    }))
  })

  test('rejects execution rotation during the terminal grace period', async () => {
    const oldApproval = createApproval()
    const newApproval = createApproval(
      '2026-08-01T01:00:00.000Z',
      '2026-08-01T02:00:00.000Z',
    )
    const run: RestoreDrillDurableRun = {
      ...awaitingApprovalRun(emptyCleanupScopeDigest()),
      approvalDigest: APPROVAL_DIGEST,
      approvalObjectKey:
        `approvals/v1/runs/${DRILL_ID}/${oldApproval.receipt.approvalMac}.json`,
      approvedAt: oldApproval.receipt.approvedAt,
      cleanupAttemptCount: 1,
      cleanupExecutionArn: oldApproval.executionArn,
      cleanupExecutionName: oldApproval.executionName,
      cleanupStartedAt: '2026-08-01T00:20:00.000Z',
      phase: 'cleaning-up',
    }
    const model = createStateModel({
      resourceCheckpoint: emptyResourceCheckpoint(),
      run,
    })
    const fixture = createOrchestratorFixture({
      approvals: {
        async readImmutable() {
          return { approvalDigest: DIGEST, receipt: newApproval.receipt }
        },
      },
      execution: {
        redriveCount: 0,
        status: 'TIMED_OUT',
        stopDate: '2026-08-01T00:50:00.000Z',
      },
      model,
      now: () => new Date('2026-08-01T01:00:00.000Z'),
    })
    const result = await fixture.orchestrator.cleanup({
      approvalObjectKey:
        `approvals/v1/runs/${DRILL_ID}/${newApproval.receipt.approvalMac}.json`,
      cleanupExecutionArn: newApproval.executionArn,
      cleanupExecutionName: newApproval.executionName,
      drillId: DRILL_ID,
    }, createOperations())
    expect(result.status).toBe('failed')
    expect(model.run?.cleanupExecutionArn).toBe(oldApproval.executionArn)
  })

  test('aborts more than 240 recorded MPUs in bounded immediate batches', async () => {
    const uploads: RestoreDrillRecordedMultipartUpload[] = Array.from(
      { length: 300 },
      (_, index) => ({
        bucketName: 'restore-drill-scratch',
        kind: 'scratch-multipart-upload',
        objectKey:
          `restore-drill/${DRILL_DIGEST}/table:audit-events/export/data-${String(index).padStart(4, '0')}.json.gz`,
        uploadId: `upload-${String(index).padStart(4, '0')}`,
      }),
    )
    const resourceDigest = createHmac('sha256', DIGEST_KEY)
      .update('mukuroji-restore-drill-cleanup-scope-v1\0', 'utf8')
      .update(JSON.stringify({
        exportObjects: [],
        exportRecords: [],
        files: [],
        tables: [],
        uploads,
      }), 'utf8')
      .digest('hex')
    const approval = createApproval(
      '2026-08-01T00:10:00.000Z',
      '2026-08-01T02:10:00.000Z',
      resourceDigest,
    )
    const model = createStateModel({
      multipartUploadListing: {
        complete: true,
        pageCount: 1,
        started: true,
        uploadCount: uploads.length,
      },
      multipartUploads: uploads,
      resourceCheckpoint: emptyResourceCheckpoint(),
      run: awaitingApprovalRun(resourceDigest),
    })
    const abortedUploadIds: string[] = []
    const operations: RestoreDrillAwsOperations = {
      ...createOperations(),
      async abortRecordedMultipartUpload(upload) {
        abortedUploadIds.push(upload.uploadId)
        return { status: 'absent' }
      },
    }
    const fixture = createOrchestratorFixture({
      approvals: {
        async readImmutable() {
          return { approvalDigest: APPROVAL_DIGEST, receipt: approval.receipt }
        },
      },
      model,
      now: () => new Date('2026-08-01T00:20:00.000Z'),
    })
    let request: unknown = {
      approvalObjectKey:
        `approvals/v1/runs/${DRILL_ID}/${approval.receipt.approvalMac}.json`,
      cleanupExecutionArn: approval.executionArn,
      cleanupExecutionName: approval.executionName,
      drillId: DRILL_ID,
    }
    let invocationCount = 0
    while (invocationCount < 20) {
      const result = await fixture.orchestrator.cleanup(request, operations)
      invocationCount += 1
      if (result.status === 'completed') break
      expect(result.status).toBe('pending')
      expect(result.waitSeconds).toBe(0)
      request = {
        cleanupExecutionArn: approval.executionArn,
        cleanupExecutionName: approval.executionName,
        drillId: DRILL_ID,
      }
    }
    expect(model.run?.phase).toBe('completed')
    expect(invocationCount).toBeLessThan(20)
    expect(new Set(abortedUploadIds).size).toBe(uploads.length)
    expect(model.cleanupProgress.absenceReceiptCount).toBe(uploads.length)
    expect(model.cleanupProgress.absenceReceiptDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(fixture.evidenceArtifacts.at(-1)).toMatchObject({
      deletedMultipartUploadCount: uploads.length,
      expectedMultipartUploadCount: uploads.length,
      kind: 'mukuroji-restore-drill-cleanup',
    })
  })

  test('cleans and releases an early zero-resource failure without RESOURCES', async () => {
    const model = createStateModel({
      cadence: { activeDrillId: DRILL_ID, revision: 1 },
      run: failureSealingRun('scheduled'),
    })
    const sealing = createOrchestratorFixture({
      model,
      now: () => new Date('2026-08-01T00:30:00.000Z'),
    })
    const sealed = await sealing.orchestrator.finalizeFailure(
      DRILL_ID,
      createOperations(),
      RUNNER_EXECUTION_ARN,
    )
    expect(sealed.status).toBe('awaiting-cleanup-approval')
    expect(model.resourceCheckpoint).toBeUndefined()
    const resourceDigest = model.run?.resourceDigest
    const resultDigest = model.run?.resultDigest
    if (!resourceDigest || !resultDigest) throw new Error('sealed digest missing')
    const approval = createApproval(
      '2026-08-01T00:31:00.000Z',
      '2026-08-01T01:31:00.000Z',
      resourceDigest,
      resultDigest,
    )
    const cleanup = createOrchestratorFixture({
      approvals: {
        async readImmutable() {
          return { approvalDigest: APPROVAL_DIGEST, receipt: approval.receipt }
        },
      },
      model,
      now: () => new Date('2026-08-01T00:32:00.000Z'),
    })
    const first = await cleanup.orchestrator.cleanup({
      approvalObjectKey:
        `approvals/v1/runs/${DRILL_ID}/${approval.receipt.approvalMac}.json`,
      cleanupExecutionArn: approval.executionArn,
      cleanupExecutionName: approval.executionName,
      drillId: DRILL_ID,
    }, createOperations())
    expect(first.status).toBe('pending')
    const completed = await cleanup.orchestrator.cleanup({
      cleanupExecutionArn: approval.executionArn,
      cleanupExecutionName: approval.executionName,
      drillId: DRILL_ID,
    }, createOperations())
    expect(completed.status).toBe('completed')
    expect(model.releaseCount).toBe(1)
  })
})

describe('restore drill external-operation intents', () => {
  test('reconciles a late restore point without treating the RPO miss as terminal', async () => {
    const restorePoint = '2026-07-31T23:50:00.000Z'
    const sources: readonly RestoreDrillSourceTableObservation[] =
      RESTORE_DRILL_TABLE_TARGETS.map((target) => ({
        descriptor: {
          ...tableDescriptor(),
          tableId: `source-${target.slice('table:'.length)}`,
        },
        earliestRestorableAt: '2026-07-01T00:00:00.000Z',
        latestRestorableAt: restorePoint,
        sourceTableArn:
          `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${target.slice('table:'.length)}`,
        target,
      }))
    const model = createStateModel({
      resourceCheckpoint: {
        exports: [],
        restoredDescriptors: [],
        restores: [],
        sources,
      },
      run: {
        cleanupPolicyVersion: RESTORE_DRILL_CLEANUP_POLICY_VERSION,
        deadlineAt: DEADLINE_AT,
        digestKeyEnvelope: ENVELOPE,
        drillId: DRILL_ID,
        failureCodes: [],
        outcome: 'in-progress',
        phase: 'discovering-pitr-windows',
        revision: 3,
        runnerExecutionArn: RUNNER_EXECUTION_ARN,
        startedAt: STARTED_AT,
        updatedAt: STARTED_AT,
      },
    })
    const fixture = createOrchestratorFixture({
      model,
      now: () => new Date('2026-08-01T00:30:00.000Z'),
    })

    const result = await fixture.orchestrator.advance(
      { drillId: DRILL_ID },
      createOperations(),
      RUNNER_EXECUTION_ARN,
    )

    expect(result).toEqual({ drillId: DRILL_ID, status: 'pending', waitSeconds: 0 })
    expect(model.run?.failureCodes).toEqual([])
    expect(model.run?.restorePoint).toBe(restorePoint)
    expect(fixture.evidenceArtifacts).toEqual([])
  })

  test('immediately re-drives all discovery state progress and waits only on AWS polls', async () => {
    const restorePoint = '2026-07-31T23:50:00.000Z'
    const sources: readonly RestoreDrillSourceTableObservation[] =
      RESTORE_DRILL_TABLE_TARGETS.map((target) => ({
        descriptor: {
          ...tableDescriptor(),
          tableId: `source-${target.slice('table:'.length)}`,
        },
        earliestRestorableAt: '2026-07-01T00:00:00.000Z',
        latestRestorableAt: restorePoint,
        sourceTableArn:
          `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${target.slice('table:'.length)}`,
        target,
      }))
    const run: RestoreDrillDurableRun = {
      cleanupPolicyVersion: RESTORE_DRILL_CLEANUP_POLICY_VERSION,
      deadlineAt: DEADLINE_AT,
      digestKeyEnvelope: ENVELOPE,
      drillId: DRILL_ID,
      failureCodes: [],
      outcome: 'in-progress',
      phase: 'discovering-pitr-windows',
      revision: 3,
      runnerExecutionArn: RUNNER_EXECUTION_ARN,
      startedAt: STARTED_AT,
      updatedAt: STARTED_AT,
    }
    const model = createStateModel({
      run,
    })
    let exportStartCount = 0
    let restoreStartCount = 0
    const operations: RestoreDrillAwsOperations = {
      ...createOperations(),
      async collectSourceTableObservations() {
        return sources
      },
      async pollTableExport() {
        return { status: 'pending' }
      },
      async pollTableRestore() {
        return { status: 'pending' }
      },
      async startTableExport(input) {
        exportStartCount += 1
        return {
          clientToken: createHash('sha256')
            .update(
              `export\0${DRILL_ID}\0${input.source.target}\0${input.exportPoint}`,
              'utf8',
            )
            .digest('hex'),
          exportArn: `${input.source.sourceTableArn}/export/export-id`,
          exportPoint: input.exportPoint,
          kind: 'table-export',
          scratchPrefix:
            `restore-drill/${DRILL_DIGEST}/${input.source.target}/export`,
          sourceTableArn: input.source.sourceTableArn,
          sourceTableId: input.source.descriptor.tableId,
          target: input.source.target,
        }
      },
      async startTableRestore(input) {
        restoreStartCount += 1
        const logicalName = input.source.target.slice('table:'.length)
        const tableName = `restore-${DRILL_DIGEST}-${logicalName}`
        return {
          adopted: false,
          table: {
            kind: 'restore-table',
            restorePoint: input.restorePoint,
            sourceTableArn: input.source.sourceTableArn,
            tableArn:
              `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${tableName}`,
            tableId: `restore-${logicalName}`,
            tableName,
            target: input.source.target,
          },
        }
      },
    }
    const fixture = createOrchestratorFixture({
      model,
      now: () => new Date('2026-08-01T00:30:00.000Z'),
    })
    const localWaits: Array<number | undefined> = []
    for (let invocation = 0; invocation < 40; invocation += 1) {
      if (model.run?.phase !== 'discovering-pitr-windows') break
      const result = await fixture.orchestrator.advance(
        { drillId: DRILL_ID },
        operations,
        RUNNER_EXECUTION_ARN,
      )
      localWaits.push(result.waitSeconds)
    }
    expect(localWaits).toHaveLength(36)
    expect(new Set(localWaits)).toEqual(new Set([0]))
    expect(exportStartCount).toBe(RESTORE_DRILL_TABLE_TARGETS.length)
    expect(restoreStartCount).toBe(RESTORE_DRILL_TABLE_TARGETS.length)
    expect(model.run?.failureCodes).toEqual([])
    expect(model.run?.phase).toBe('restoring-tables')
    expect(model.run?.restorePoint).toBe(restorePoint)
    const poll = await fixture.orchestrator.advance(
      { drillId: DRILL_ID },
      operations,
      RUNNER_EXECUTION_ARN,
    )
    expect(poll.waitSeconds).toBe(60)
  })

  test('advances 300 File rows without one-minute waits per durable cursor', async () => {
    const run: RestoreDrillDurableRun = {
      cleanupPolicyVersion: RESTORE_DRILL_CLEANUP_POLICY_VERSION,
      deadlineAt: DEADLINE_AT,
      digestKeyEnvelope: ENVELOPE,
      drillId: DRILL_ID,
      failureCodes: [],
      outcome: 'in-progress',
      phase: 'copying-file-versions',
      restorePoint: STARTED_AT,
      revision: 4,
      runnerExecutionArn: RUNNER_EXECUTION_ARN,
      startedAt: STARTED_AT,
      updatedAt: STARTED_AT,
    }
    const model = createStateModel({
      resourceCheckpoint: {
        exports: [],
        restoredDescriptors: [],
        restores: [fileRestoredTable()],
        sources: [],
      },
      run,
    })
    let scanCount = 0
    let remapCount = 0
    const operations: RestoreDrillAwsOperations = {
      ...createOperations(),
      async commitFileRemap() {
        remapCount += 1
        return { status: 'committed' }
      },
      async scanFileProofingPage() {
        scanCount += 1
        const nextKey = scanCount < 300
          ? { id: { S: `row-${String(scanCount).padStart(4, '0')}` } }
          : undefined
        return {
          ...(nextKey ? { nextKey } : {}),
          row: {
            originalItem: {},
            revision: 1,
            rowKey: { id: { S: `row-${String(scanCount).padStart(4, '0')}` } },
            versions: [],
          },
        }
      },
    }
    const fixture = createOrchestratorFixture({
      model,
      now: () => new Date('2026-08-01T00:30:00.000Z'),
    })
    for (let index = 0; index < 300; index += 1) {
      const result = await fixture.orchestrator.advance(
        { drillId: DRILL_ID },
        operations,
        RUNNER_EXECUTION_ARN,
      )
      expect(result.waitSeconds).toBe(0)
    }
    const transitioned = await fixture.orchestrator.advance(
      { drillId: DRILL_ID },
      operations,
      RUNNER_EXECUTION_ARN,
    )
    expect(transitioned.waitSeconds).toBe(0)
    expect(scanCount).toBe(300)
    expect(remapCount).toBe(300)
    expect(model.run?.phase).toBe('verifying')
  })

  test('verifies at most one File version per invocation before remapping its row', async () => {
    const versions = Array.from({ length: 3 }, (_, index) => ({
      contentType: 'application/pdf',
      objectKey: `workspaces/workspace-1/files/file-1/version-${index + 1}/file.pdf`,
      objectVersionId: `source-object-version-${index + 1}`,
      sizeBytes: 268_435_456,
      versionId: `file-version-${index + 1}`,
    }))
    const run: RestoreDrillDurableRun = {
      cleanupPolicyVersion: RESTORE_DRILL_CLEANUP_POLICY_VERSION,
      deadlineAt: DEADLINE_AT,
      digestKeyEnvelope: ENVELOPE,
      drillId: DRILL_ID,
      failureCodes: [],
      outcome: 'in-progress',
      phase: 'copying-file-versions',
      restorePoint: STARTED_AT,
      revision: 4,
      runnerExecutionArn: RUNNER_EXECUTION_ARN,
      startedAt: STARTED_AT,
      updatedAt: STARTED_AT,
    }
    const model = createStateModel({
      resourceCheckpoint: {
        exports: [],
        restoredDescriptors: [],
        restores: [fileRestoredTable()],
        sources: [],
      },
      run,
    })
    let currentInvocation = -1
    let remapCount = 0
    const verificationInvocations: number[] = []
    const operations: RestoreDrillAwsOperations = {
      ...createOperations(),
      async commitFileRemap() {
        remapCount += 1
        return { status: 'committed' }
      },
      async createOrAdoptFileVersion(input) {
        const selectedCopy: RestoreDrillCreatedScratchObjectVersion = {
          bucketName: 'restore-scratch',
          drillDigest: DRILL_DIGEST,
          kind: 'scratch-object-version',
          objectKey: input.source.objectKey,
          objectVersionId: `destination-${input.source.objectVersionId}`,
          versionId: input.source.versionId,
        }
        return { createdCopies: [selectedCopy], selectedCopy }
      },
      async listScratchObjectVersionIds() {
        return []
      },
      async scanFileProofingPage() {
        return {
          row: {
            originalItem: {},
            revision: 1,
            rowKey: { id: { S: 'file-row-many-versions' } },
            versions,
          },
        }
      },
      async verifyCreatedFileVersion(input) {
        verificationInvocations.push(currentInvocation)
        return {
          status: 'completed',
          version: {
            ...input.copy,
            destinationProof: fileProof('destination'),
            sourceProof: fileProof('source'),
          },
        }
      },
    }
    const fixture = createOrchestratorFixture({
      model,
      now: () => new Date('2026-08-01T00:30:00.000Z'),
    })
    for (let invocation = 0; invocation < versions.length; invocation += 1) {
      currentInvocation = invocation
      const result = await fixture.orchestrator.advance(
        { drillId: DRILL_ID },
        operations,
        RUNNER_EXECUTION_ARN,
      )
      expect(result.waitSeconds).toBe(0)
    }
    expect(verificationInvocations).toEqual([0, 1, 2])
    expect(remapCount).toBe(1)
    expect(model.fileCursor.complete).toBe(true)
  })

  test('rejects a non-advancing File scan LastEvaluatedKey', () => {
    const cursor = { id: { S: 'row-0001' } }
    expect(() => validateRestoreDrillFileCursorAdvance(cursor, cursor)).toThrow(
      new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED'),
    )
    expect(() => validateRestoreDrillFileCursorAdvance(cursor, undefined)).not.toThrow()
  })

  test('serializes concurrent copy attempts before CopyObject and persists identity before verify', async () => {
    const source = {
      contentType: 'application/pdf',
      objectKey: 'workspaces/workspace-1/files/file-1/version-1/file.pdf',
      objectVersionId: 'source-object-version-1',
      sizeBytes: 42,
      versionId: 'file-version-1',
    }
    const run: RestoreDrillDurableRun = {
      cleanupPolicyVersion: RESTORE_DRILL_CLEANUP_POLICY_VERSION,
      deadlineAt: DEADLINE_AT,
      digestKeyEnvelope: ENVELOPE,
      drillId: DRILL_ID,
      failureCodes: [],
      outcome: 'in-progress',
      phase: 'copying-file-versions',
      restorePoint: STARTED_AT,
      revision: 4,
      runnerExecutionArn: RUNNER_EXECUTION_ARN,
      startedAt: STARTED_AT,
      updatedAt: STARTED_AT,
    }
    const model = createStateModel({
      resourceCheckpoint: {
        exports: [],
        restoredDescriptors: [],
        restores: [fileRestoredTable()],
        sources: [],
      },
      run,
    })
    let createCount = 0
    let verifyObservedDurableIdentity = false
    const base = createOperations()
    const operations: RestoreDrillAwsOperations = {
      ...base,
      async commitFileRemap() {
        return { status: 'committed' }
      },
      async createOrAdoptFileVersion() {
        createCount += 1
        const firstCopy: RestoreDrillCreatedScratchObjectVersion = {
          bucketName: 'restore-scratch',
          drillDigest: createHash('sha256')
            .update(`drill\0${DRILL_ID}`, 'utf8')
            .digest('hex')
            .slice(0, 16),
          kind: 'scratch-object-version',
          objectKey: source.objectKey,
          objectVersionId: 'created-object-version-1',
          versionId: source.versionId,
        }
        return {
          createdCopies: [
            firstCopy,
            { ...firstCopy, objectVersionId: 'created-object-version-2' },
          ],
          selectedCopy: firstCopy,
        }
      },
      async listScratchObjectVersionIds() {
        return []
      },
      async scanFileProofingPage() {
        return {
          row: {
            originalItem: {},
            revision: 1,
            rowKey: { id: { S: 'file-row-1' } },
            versions: [source],
          },
        }
      },
      async verifyCreatedFileVersion(input) {
        verifyObservedDurableIdentity = [...model.intents.values()].some(
          (intent) => intent.createdCopies?.some(
            (copy) => copy.objectVersionId === input.copy.objectVersionId,
          ) === true && intent.selectedCopy?.objectVersionId === input.copy.objectVersionId,
        )
        return {
          status: 'completed',
          version: {
            ...input.copy,
            destinationProof: fileProof('destination'),
            sourceProof: fileProof('source'),
          },
        }
      },
    }
    const fixture = createOrchestratorFixture({
      model,
      now: () => new Date('2026-08-01T00:30:00.000Z'),
    })
    const results = await Promise.all([
      fixture.orchestrator.advance(
        { drillId: DRILL_ID },
        operations,
        RUNNER_EXECUTION_ARN,
      ),
      fixture.orchestrator.advance(
        { drillId: DRILL_ID },
        operations,
        RUNNER_EXECUTION_ARN,
      ),
    ])
    expect(results.every((result) => result.status === 'pending')).toBe(true)
    expect(createCount).toBe(1)
    expect(verifyObservedDurableIdentity).toBe(true)
    expect([...model.intents.values()][0]?.createdCopies?.map(
      (copy) => copy.objectVersionId,
    )).toEqual(['created-object-version-1', 'created-object-version-2'])
    expect([...model.intents.values()][0]?.completedCopy?.objectVersionId)
      .toBe('created-object-version-1')
  })

  test('restarts the quiet two-pass seal when a late CopyObject VersionId appears', async () => {
    const source = sourceFileVersion()
    const firstCopy = createdFileCopy(source, 'created-version-1')
    const lateCopy = createdFileCopy(source, 'created-version-2')
    const intentDigest = copyIntentDigest(source)
    let now = new Date('2026-08-01T00:31:00.000Z')
    const model = createStateModel({
      copyReconciliation: {
        complete: false,
        createdCopyCount: 0,
        intentCount: 0,
        pass: 1,
        started: false,
      },
      intents: new Map([[
        intentDigest,
        {
          createdCopies: [firstCopy],
          intentDigest,
          preexistingScratchVersionIds: [],
          selectedCopy: firstCopy,
          source,
        },
      ]]),
      resourceCheckpoint: emptyResourceCheckpoint(),
      run: failureSealingRun(),
    })
    let listCount = 0
    const operations: RestoreDrillAwsOperations = {
      ...createOperations(),
      async reconcileCreatedFileVersions() {
        listCount += 1
        return listCount === 1 ? [firstCopy] : [firstCopy, lateCopy]
      },
    }
    const fixture = createOrchestratorFixture({ model, now: () => now })

    const first = await fixture.orchestrator.finalizeFailure(
      DRILL_ID,
      operations,
      RUNNER_EXECUTION_ARN,
    )
    expect(first).toMatchObject({ status: 'pending', waitSeconds: 60 })
    now = new Date('2026-08-01T00:48:00.000Z')
    const unstable = await fixture.orchestrator.finalizeFailure(
      DRILL_ID,
      operations,
      RUNNER_EXECUTION_ARN,
    )
    expect(unstable).toMatchObject({ status: 'pending', waitSeconds: 60 })
    expect(model.copyReconciliation?.pass).toBe(2)
    now = new Date('2026-08-01T01:05:00.000Z')
    const sealed = await fixture.orchestrator.finalizeFailure(
      DRILL_ID,
      operations,
      RUNNER_EXECUTION_ARN,
    )
    expect(sealed.status).toBe('awaiting-cleanup-approval')
    expect(model.intents.get(intentDigest)?.createdCopies).toEqual([
      firstCopy,
      lateCopy,
    ])
    expect(model.copyReconciliation).toMatchObject({
      complete: true,
      createdCopyCount: 2,
      intentCount: 1,
    })
    expect(listCount).toBe(4)
  })

  test('failure finalization reconciles and seals more than 10k File versions', async () => {
    const intents: Array<readonly [string, RestoreDrillCopyIntent]> = []
    const copiesByVersionId = new Map<
      string,
      readonly RestoreDrillCreatedScratchObjectVersion[]
    >()
    const allCopies: RestoreDrillCreatedScratchObjectVersion[] = []
    for (let sourceIndex = 1; sourceIndex <= 11; sourceIndex += 1) {
      const source = sourceFileVersion(sourceIndex)
      const copyCount = sourceIndex === 11 ? 1 : 1_000
      const copies = Array.from({ length: copyCount }, (_, copyIndex) =>
        createdFileCopy(
          source,
          `created-${String(sourceIndex).padStart(2, '0')}-${String(copyIndex).padStart(4, '0')}`,
        )
      )
      const selectedCopy = copies[0]
      if (!selectedCopy) throw new Error('missing selected File copy')
      const intentDigest = copyIntentDigest(source)
      intents.push([intentDigest, {
        createdCopies: copies,
        intentDigest,
        preexistingScratchVersionIds: [],
        selectedCopy,
        source,
      }])
      copiesByVersionId.set(source.versionId, copies)
      allCopies.push(...copies)
    }
    const orderedLedger = [...allCopies].sort((left, right) =>
      cleanupTargetCursor(left).localeCompare(cleanupTargetCursor(right))
    )
    let now = new Date('2026-08-01T00:31:00.000Z')
    const model = createStateModel({
      cleanupLedger: orderedLedger,
      copyReconciliation: {
        complete: false,
        createdCopyCount: 0,
        intentCount: 0,
        pass: 1,
        started: false,
      },
      intents: new Map(intents),
      resourceCheckpoint: emptyResourceCheckpoint(),
      run: failureSealingRun(),
    })
    let reconciliationCount = 0
    const operations: RestoreDrillAwsOperations = {
      ...createOperations(),
      async reconcileCreatedFileVersions(input) {
        reconciliationCount += 1
        const copies = copiesByVersionId.get(input.source.versionId)
        if (!copies) throw new Error('unexpected File reconciliation source')
        return copies
      },
    }
    const fixture = createOrchestratorFixture({ model, now: () => now })
    let result = await fixture.orchestrator.finalizeFailure(
      DRILL_ID,
      operations,
      RUNNER_EXECUTION_ARN,
    )
    let invocationCount = 1
    let advancedQuietWindow = false
    while (result.status === 'pending' && invocationCount < 150) {
      if (result.waitSeconds === 60 && !advancedQuietWindow) {
        now = new Date('2026-08-01T00:48:00.000Z')
        advancedQuietWindow = true
      } else {
        expect(result.waitSeconds).toBe(0)
      }
      result = await fixture.orchestrator.finalizeFailure(
        DRILL_ID,
        operations,
        RUNNER_EXECUTION_ARN,
      )
      invocationCount += 1
    }
    expect(result.status).toBe('awaiting-cleanup-approval')
    expect(reconciliationCount).toBe(22)
    expect(model.copyReconciliation).toMatchObject({
      complete: true,
      createdCopyCount: 10_001,
      intentCount: 11,
    })
    expect(model.cleanupScope).toMatchObject({
      complete: true,
      fileObjectCount: 10_001,
      ledgerCount: 10_001,
    })
    expect(invocationCount).toBeLessThan(10)
  })

  test('failure finalization inventories and seals more than 10k export versions', async () => {
    const source: RestoreDrillSourceTableObservation = {
      descriptor: tableDescriptor(),
      earliestRestorableAt: '2026-07-01T00:00:00.000Z',
      latestRestorableAt: STARTED_AT,
      sourceTableArn:
        `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/audit-events`,
      target: 'table:audit-events',
    }
    const exportRecord: RestoreDrillRecordedExport = {
      clientToken: createHash('sha256')
        .update(`export\0${DRILL_ID}\0${source.target}\0${STARTED_AT}`, 'utf8')
        .digest('hex'),
      exportArn: `${source.sourceTableArn}/export/01693685827463-2d8752fd`,
      exportPoint: STARTED_AT,
      kind: 'table-export',
      scratchPrefix: `restore-drill/${DRILL_DIGEST}/${source.target}/export`,
      sourceTableArn: source.sourceTableArn,
      sourceTableId: source.descriptor.tableId,
      target: source.target,
    }
    const exportArnDigest = createHash('sha256')
      .update(`export-arn\0${exportRecord.exportArn}`, 'utf8')
      .digest('hex')
    const versions: RestoreDrillRecordedExportObjectVersion[] = Array.from(
      { length: 10_001 },
      (_, index) => ({
        bucketName: 'restore-drill-scratch',
        exportArnDigest,
        kind: 'export-object-version',
        objectKey:
          `${exportRecord.scratchPrefix}/AWSDynamoDB/data/file-${String(index).padStart(5, '0')}.json.gz`,
        objectVersionId: `export-version-${String(index).padStart(5, '0')}`,
        scratchPrefix: exportRecord.scratchPrefix,
      }),
    )
    const orderedLedger = [...versions].sort((left, right) =>
      cleanupTargetCursor(left).localeCompare(cleanupTargetCursor(right))
    )
    const model = createStateModel({
      cleanupLedger: orderedLedger,
      exportListings: new Map([[
        source.target,
        { complete: false, objectCount: 0, pageCount: 0, started: false },
      ]]),
      resourceCheckpoint: {
        exports: [exportRecord],
        restoredDescriptors: [],
        restores: [],
        sources: [source],
      },
      run: { ...failureSealingRun(), restorePoint: STARTED_AT },
    })
    let pageIndex = 0
    const operations: RestoreDrillAwsOperations = {
      ...createOperations(),
      async pollTableExport() {
        return {
          itemCount: 10_001,
          manifestKey:
            `${exportRecord.scratchPrefix}/AWSDynamoDB/01693685827463-2d8752fd/manifest-summary.json`,
          status: 'completed',
        }
      },
      async listRecordedExportObjectVersionPage() {
        const start = pageIndex * 1_000
        const pageVersions = versions.slice(start, start + 1_000)
        pageIndex += 1
        const last = pageVersions.at(-1)
        return {
          versions: pageVersions,
          ...(start + pageVersions.length < versions.length && last
            ? {
                nextCursor: {
                  keyMarker: last.objectKey,
                  versionIdMarker: last.objectVersionId,
                },
              }
            : {}),
        }
      },
    }
    const fixture = createOrchestratorFixture({
      model,
      now: () => new Date('2026-08-01T00:31:00.000Z'),
    })
    let result = await fixture.orchestrator.finalizeFailure(
      DRILL_ID,
      operations,
      RUNNER_EXECUTION_ARN,
    )
    expect(pageIndex).toBe(11)
    let invocationCount = 1
    while (result.status === 'pending' && invocationCount < 150) {
      expect(result.waitSeconds).toBe(0)
      result = await fixture.orchestrator.finalizeFailure(
        DRILL_ID,
        operations,
        RUNNER_EXECUTION_ARN,
      )
      invocationCount += 1
    }
    expect(result.status).toBe('awaiting-cleanup-approval')
    expect(pageIndex).toBe(11)
    expect(model.exportListings.get(source.target)).toMatchObject({
      complete: true,
      objectCount: 10_001,
      pageCount: 11,
    })
    expect(model.cleanupScope).toMatchObject({
      complete: true,
      exportObjectCount: 10_001,
      ledgerCount: 10_001,
    })
    expect(invocationCount).toBeLessThan(10)
  })

  test('failure finalization inventories and seals more than 10k MPUs page by page', async () => {
    const uploads: RestoreDrillRecordedMultipartUpload[] = Array.from(
      { length: 10_001 },
      (_, index) => ({
        bucketName: 'restore-drill-scratch',
        kind: 'scratch-multipart-upload',
        objectKey:
          `restore-drill/${DRILL_DIGEST}/table:audit-events/export/large-${String(index).padStart(5, '0')}`,
        uploadId: `upload-${String(index).padStart(5, '0')}`,
      }),
    )
    const orderedLedger = [...uploads].sort((left, right) =>
      cleanupTargetCursor(left).localeCompare(cleanupTargetCursor(right))
    )
    const model = createStateModel({
      cleanupLedger: orderedLedger,
      multipartUploadListing: {
        complete: false,
        pageCount: 0,
        started: false,
        uploadCount: 0,
      },
      resourceCheckpoint: emptyResourceCheckpoint(),
      run: failureSealingRun(),
    })
    let pageIndex = 0
    const operations: RestoreDrillAwsOperations = {
      ...createOperations(),
      async listRecordedMultipartUploadPage() {
        const start = pageIndex * 1_000
        const pageUploads = uploads.slice(start, start + 1_000)
        pageIndex += 1
        const last = pageUploads.at(-1)
        return {
          uploads: pageUploads,
          ...(start + pageUploads.length < uploads.length && last
            ? {
                nextCursor: {
                  keyMarker: last.objectKey,
                  uploadIdMarker: last.uploadId,
                },
              }
            : {}),
        }
      },
    }
    const fixture = createOrchestratorFixture({
      model,
      now: () => new Date('2026-08-01T00:31:00.000Z'),
    })
    let result = await fixture.orchestrator.finalizeFailure(
      DRILL_ID,
      operations,
      RUNNER_EXECUTION_ARN,
    )
    expect(pageIndex).toBe(11)
    let invocationCount = 1
    while (result.status === 'pending' && invocationCount < 150) {
      expect(result.waitSeconds).toBe(0)
      result = await fixture.orchestrator.finalizeFailure(
        DRILL_ID,
        operations,
        RUNNER_EXECUTION_ARN,
      )
      invocationCount += 1
    }
    expect(result.status).toBe('awaiting-cleanup-approval')
    expect(pageIndex).toBe(11)
    expect(model.multipartUploadListing).toMatchObject({
      complete: true,
      pageCount: 11,
      uploadCount: 10_001,
    })
    expect(model.cleanupScope).toMatchObject({
      complete: true,
      ledgerCount: 10_001,
      multipartUploadCount: 10_001,
    })
    expect(invocationCount).toBeLessThan(10)
  })

  test('includes a response-lost restore start in terminal cleanup scope', async () => {
    const source: RestoreDrillSourceTableObservation = {
      descriptor: tableDescriptor(),
      earliestRestorableAt: '2026-07-01T00:00:00.000Z',
      latestRestorableAt: STARTED_AT,
      sourceTableArn:
        `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/audit-events`,
      target: 'table:audit-events',
    }
    const table: RestoreDrillRecordedRestoreTable = {
      kind: 'restore-table',
      restorePoint: STARTED_AT,
      sourceTableArn: source.sourceTableArn,
      tableArn:
        `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/restore-${DRILL_DIGEST}-audit-events`,
      tableId: 'restore-audit-table-id',
      tableName: `restore-${DRILL_DIGEST}-audit-events`,
      target: source.target,
    }
    const run: RestoreDrillDurableRun = {
      cleanupPolicyVersion: RESTORE_DRILL_CLEANUP_POLICY_VERSION,
      deadlineAt: DEADLINE_AT,
      digestKeyEnvelope: ENVELOPE,
      drillId: DRILL_ID,
      failureCodes: [],
      outcome: 'in-progress',
      phase: 'discovering-pitr-windows',
      restorePoint: STARTED_AT,
      revision: 3,
      runnerExecutionArn: RUNNER_EXECUTION_ARN,
      startedAt: STARTED_AT,
      updatedAt: STARTED_AT,
    }
    const model = createStateModel({
      resourceCheckpoint: {
        exports: [],
        restoredDescriptors: [],
        restores: [],
        sources: [source],
      },
      run,
      startIntents: new Map([[
        source.target,
        {
          exportAttempted: false,
          restoreAttempted: true,
          restorePoint: STARTED_AT,
          source,
          target: source.target,
        },
      ]]),
    })
    let startCount = 0
    const operations: RestoreDrillAwsOperations = {
      ...createOperations(),
      async startTableRestore() {
        startCount += 1
        if (startCount === 1) throw new Error('restore API response lost')
        return { adopted: false, table }
      },
    }
    const fixture = createOrchestratorFixture({
      model,
      now: () => new Date('2026-08-01T00:30:00.000Z'),
    })
    const first = await fixture.orchestrator.advance(
      { drillId: DRILL_ID },
      operations,
      RUNNER_EXECUTION_ARN,
    )
    expect(first.status).toBe('pending')
    const result = await fixture.orchestrator.finalizeFailure(
      DRILL_ID,
      operations,
      RUNNER_EXECUTION_ARN,
    )
    expect(result.status).toBe('awaiting-cleanup-approval')
    expect(startCount).toBe(2)
    expect(model.resourceCheckpoint?.restores).toEqual([table])
    expect(model.run?.resourceDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  test('adopts an identical restore record after its durable write response is lost', async () => {
    const source: RestoreDrillSourceTableObservation = {
      descriptor: tableDescriptor(),
      earliestRestorableAt: '2026-07-01T00:00:00.000Z',
      latestRestorableAt: STARTED_AT,
      sourceTableArn:
        `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/audit-events`,
      target: 'table:audit-events',
    }
    const table: RestoreDrillRecordedRestoreTable = {
      kind: 'restore-table',
      restorePoint: STARTED_AT,
      sourceTableArn: source.sourceTableArn,
      tableArn:
        `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/restore-${DRILL_DIGEST}-audit-events`,
      tableId: 'restore-audit-table-id',
      tableName: `restore-${DRILL_DIGEST}-audit-events`,
      target: source.target,
    }
    const run: RestoreDrillDurableRun = {
      cleanupPolicyVersion: RESTORE_DRILL_CLEANUP_POLICY_VERSION,
      deadlineAt: DEADLINE_AT,
      digestKeyEnvelope: ENVELOPE,
      drillId: DRILL_ID,
      failureCodes: [],
      outcome: 'in-progress',
      phase: 'discovering-pitr-windows',
      restorePoint: STARTED_AT,
      revision: 3,
      runnerExecutionArn: RUNNER_EXECUTION_ARN,
      startedAt: STARTED_AT,
      updatedAt: STARTED_AT,
    }
    const model = createStateModel({
      resourceCheckpoint: {
        exports: [],
        restoredDescriptors: [],
        restores: [],
        sources: [source],
      },
      run,
      startIntents: new Map([[
        source.target,
        {
          exportAttempted: false,
          restoreAttempted: true,
          restorePoint: STARTED_AT,
          source,
          target: source.target,
        },
      ]]),
    })
    const baseState = createState(model)
    let loseWriteResponse = true
    const state: RestoreDrillStateStore = {
      ...baseState,
      async recordStartedRestore(_drillId, target, restoreRecord) {
        const intent = model.startIntents.get(target)
        if (!intent) throw new Error('start intent missing')
        model.startIntents.set(target, { ...intent, restoreRecord })
        if (loseWriteResponse) {
          loseWriteResponse = false
          throw new Error('state write response lost')
        }
      },
    }
    let startCount = 0
    const operations: RestoreDrillAwsOperations = {
      ...createOperations(),
      async startTableRestore() {
        startCount += 1
        return { adopted: false, table }
      },
    }
    const fixture = createOrchestratorFixture({
      model,
      now: () => new Date('2026-08-01T00:30:00.000Z'),
      state,
    })
    const result = await fixture.orchestrator.advance(
      { drillId: DRILL_ID },
      operations,
      RUNNER_EXECUTION_ARN,
    )
    expect(result.status).toBe('awaiting-cleanup-approval')
    expect(startCount).toBe(1)
    expect(model.resourceCheckpoint?.restores).toEqual([table])
  })

  test('retries an export response loss with the same client token and records its ARN', async () => {
    const source: RestoreDrillSourceTableObservation = {
      descriptor: tableDescriptor(),
      earliestRestorableAt: '2026-07-01T00:00:00.000Z',
      latestRestorableAt: STARTED_AT,
      sourceTableArn:
        `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/audit-events`,
      target: 'table:audit-events',
    }
    const table: RestoreDrillRecordedRestoreTable = {
      kind: 'restore-table',
      restorePoint: STARTED_AT,
      sourceTableArn: source.sourceTableArn,
      tableArn:
        `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/restore-${DRILL_DIGEST}-audit-events`,
      tableId: 'restore-audit-table-id',
      tableName: `restore-${DRILL_DIGEST}-audit-events`,
      target: source.target,
    }
    const exportRecord: RestoreDrillRecordedExport = {
      clientToken: createHash('sha256')
        .update(`export\0${DRILL_ID}\0${source.target}\0${STARTED_AT}`, 'utf8')
        .digest('hex'),
      exportArn: `${source.sourceTableArn}/export/01693685827463-2d8752fd`,
      exportPoint: STARTED_AT,
      kind: 'table-export',
      scratchPrefix: `restore-drill/${DRILL_DIGEST}/${source.target}/export`,
      sourceTableArn: source.sourceTableArn,
      sourceTableId: source.descriptor.tableId,
      target: source.target,
    }
    const run: RestoreDrillDurableRun = {
      cleanupPolicyVersion: RESTORE_DRILL_CLEANUP_POLICY_VERSION,
      deadlineAt: DEADLINE_AT,
      digestKeyEnvelope: ENVELOPE,
      drillId: DRILL_ID,
      failureCodes: [],
      outcome: 'in-progress',
      phase: 'discovering-pitr-windows',
      restorePoint: STARTED_AT,
      revision: 3,
      runnerExecutionArn: RUNNER_EXECUTION_ARN,
      startedAt: STARTED_AT,
      updatedAt: STARTED_AT,
    }
    const model = createStateModel({
      resourceCheckpoint: {
        exports: [],
        restoredDescriptors: [],
        restores: [],
        sources: [source],
      },
      run,
      startIntents: new Map([[
        source.target,
        {
          exportAttempted: true,
          restoreAttempted: true,
          restorePoint: STARTED_AT,
          restoreRecord: table,
          source,
          target: source.target,
        },
      ]]),
    })
    let startCount = 0
    const observedClientTokens: string[] = []
    const operations: RestoreDrillAwsOperations = {
      ...createOperations(),
      async pollTableExport() {
        return {
          itemCount: 0,
          manifestKey:
            `${exportRecord.scratchPrefix}/AWSDynamoDB/01693685827463-2d8752fd/manifest-summary.json`,
          status: 'completed',
        }
      },
      async startTableExport() {
        startCount += 1
        observedClientTokens.push(exportRecord.clientToken)
        if (startCount === 1) throw new Error('export API response lost')
        return exportRecord
      },
    }
    const fixture = createOrchestratorFixture({
      model,
      now: () => new Date('2026-08-01T00:30:00.000Z'),
    })
    const first = await fixture.orchestrator.advance(
      { drillId: DRILL_ID },
      operations,
      RUNNER_EXECUTION_ARN,
    )
    expect(first.status).toBe('pending')
    const result = await fixture.orchestrator.finalizeFailure(
      DRILL_ID,
      operations,
      RUNNER_EXECUTION_ARN,
    )
    expect(result.status).toBe('awaiting-cleanup-approval')
    expect(startCount).toBe(2)
    expect(new Set(observedClientTokens)).toEqual(new Set([exportRecord.clientToken]))
    expect(model.resourceCheckpoint?.exports).toEqual([exportRecord])
  })
})

describe('restore drill integrity metric classification', () => {
  test('excludes objective, cadence, evidence, and operational failures', () => {
    expect(isRestoreDrillIntegrityFailureCode('AGGREGATE_CONTENT_MISMATCH')).toBe(true)
    expect(isRestoreDrillIntegrityFailureCode('CROSS_DOMAIN_INTEGRITY_FAILED')).toBe(true)
    expect(isRestoreDrillIntegrityFailureCode('S3_VERSION_RESTORE_FAILED')).toBe(true)
    expect(isRestoreDrillIntegrityFailureCode('RPO_TARGET_MISSED')).toBe(false)
    expect(isRestoreDrillIntegrityFailureCode('RTO_TARGET_MISSED')).toBe(false)
    expect(isRestoreDrillIntegrityFailureCode('CADENCE_OVERDUE')).toBe(false)
    expect(isRestoreDrillIntegrityFailureCode('EVIDENCE_PERSIST_FAILED')).toBe(false)
    expect(isRestoreDrillIntegrityFailureCode('DYNAMODB_RESTORE_FAILED')).toBe(false)
    expect(isRestoreDrillIntegrityFailureCode('WORKFLOW_POLL_BUDGET_EXCEEDED')).toBe(false)
  })
})

describe('restore drill table descriptor gate', () => {
  test('binds the exact enabled KMS key identity', () => {
    const source = tableDescriptor()
    expect(descriptorsMatchForRestore(source, source)).toBe(true)
    expect(descriptorsMatchForRestore(source, {
      ...source,
      kmsMasterKeyArn: `arn:aws:kms:${REGION}:${ACCOUNT_ID}:key/substituted`,
    })).toBe(false)
  })
})

describe('restore drill approval Object Lock policy', () => {
  test('binds the trusted approver role ARN to the configured Region partition', () => {
    const configuration = {
      accountId: ACCOUNT_ID,
      evidenceBucketName: 'restore-drill-evidence',
      evidenceKmsKeyArn:
        `arn:aws-cn:kms:cn-north-1:${ACCOUNT_ID}:key/evidence`,
      region: 'cn-north-1',
    }
    const store = new AwsRestoreDrillApprovalStore(
      configuration,
      `arn:aws-cn:iam::${ACCOUNT_ID}:role/restore-owner`,
    )
    store.close()

    expect(() => new AwsRestoreDrillApprovalStore(
      configuration,
      `arn:aws:iam::${ACCOUNT_ID}:role/restore-owner`,
    )).toThrow(new RestoreDrillOrchestratorFailure('CONFIGURATION_INVALID'))
  })

  test('rejects governance mode and a retention deadline shorter than 400 days', () => {
    const exactMinimum = new Date(
      Date.parse(STARTED_AT) + 400 * 86_400_000,
    )
    const oneMillisecondShort = new Date(exactMinimum.getTime() - 1)
    expect(isRestoreDrillApprovalRetentionSufficient(
      STARTED_AT,
      'GOVERNANCE',
      exactMinimum,
    )).toBe(false)
    expect(isRestoreDrillApprovalRetentionSufficient(
      STARTED_AT,
      'COMPLIANCE',
      oneMillisecondShort,
    )).toBe(false)
  })

  test('rejects invalid retention dates and accepts the exact minimum', () => {
    const exactMinimum = new Date(
      Date.parse(STARTED_AT) + 400 * 86_400_000,
    )
    expect(isRestoreDrillApprovalRetentionSufficient(
      STARTED_AT,
      'COMPLIANCE',
      new Date(Number.NaN),
    )).toBe(false)
    expect(isRestoreDrillApprovalRetentionSufficient(
      STARTED_AT,
      'COMPLIANCE',
      exactMinimum,
    )).toBe(true)
  })
})

describe('restore drill terminal evidence Object Lock policy', () => {
  const artifact: RestoreDrillEvidenceArtifact = {
    drillId: DRILL_ID,
    failedAt: STARTED_AT,
    failureCode: 'DYNAMODB_RESTORE_FAILED',
    failureVersion: 1,
    kind: 'mukuroji-restore-drill-operational-failure',
    phase: 'restoring-tables',
  }
  const body = Buffer.from(JSON.stringify(artifact), 'utf8')
  const checksum = createHash('sha256').update(body).digest('base64')
  const retainUntil = new Date(Date.parse(STARTED_AT) + 400 * 86_400_000)

  /** Creates one evidence store with a deterministic in-memory S3 transport. */
  function createEvidenceStore(
    send: (command: unknown) => Promise<unknown>,
  ): AwsRestoreDrillEvidenceStore {
    const store = new AwsRestoreDrillEvidenceStore({
      accountId: ACCOUNT_ID,
      evidenceBucketName: 'restore-drill-evidence',
      evidenceKmsKeyArn: `arn:aws:kms:${REGION}:${ACCOUNT_ID}:key/evidence`,
      region: REGION,
    })
    Object.defineProperty(store, 's3', {
      value: { destroy() {}, send },
    })
    return store
  }

  test('accepts only a complete exact protected PutObject response', async () => {
    const commands: unknown[] = []
    const store = createEvidenceStore(async (command) => {
      commands.push(command)
      if (command instanceof PutObjectCommand) {
        return {
          $metadata: {},
          ChecksumSHA256: checksum,
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: `arn:aws:kms:${REGION}:${ACCOUNT_ID}:key/evidence`,
          VersionId: 'evidence-version-1',
        }
      }
      if (command instanceof GetObjectCommand) {
        expect(command.input.VersionId).toBe('evidence-version-1')
        return {
          $metadata: {},
          Body: Readable.from([body]),
          ChecksumSHA256: checksum,
          ContentLength: body.byteLength,
          ContentType: 'application/json',
          ObjectLockMode: 'COMPLIANCE',
          ObjectLockRetainUntilDate: retainUntil,
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: `arn:aws:kms:${REGION}:${ACCOUNT_ID}:key/evidence`,
          VersionId: 'evidence-version-1',
        }
      }
      if (command instanceof GetObjectRetentionCommand) return {
        $metadata: {},
        Retention: { Mode: 'COMPLIANCE', RetainUntilDate: retainUntil },
      }
      throw new Error('unexpected command')
    })
    try {
      await expect(store.putImmutable(
        `evidence/v1/runs/${DRILL_ID}/result.json`,
        artifact,
      )).resolves.toEqual({
        checksumSha256: checksum,
        objectKey: `evidence/v1/runs/${DRILL_ID}/result.json`,
      })
      expect(commands).toHaveLength(3)
    } finally {
      store.close()
    }
  })

  test('reconciles a missing Put checksum through exact bytes and retention', async () => {
    const commands: unknown[] = []
    const store = createEvidenceStore(async (command) => {
      commands.push(command)
      if (command instanceof PutObjectCommand) {
        return {
          $metadata: {},
          ObjectLockMode: 'COMPLIANCE',
          ObjectLockRetainUntilDate: retainUntil,
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: `arn:aws:kms:${REGION}:${ACCOUNT_ID}:key/evidence`,
          VersionId: 'evidence-version-1',
        }
      }
      if (command instanceof GetObjectCommand) {
        return {
          $metadata: {},
          Body: Readable.from([body]),
          ChecksumSHA256: checksum,
          ContentLength: body.byteLength,
          ContentType: 'application/json',
          ObjectLockMode: 'COMPLIANCE',
          ObjectLockRetainUntilDate: retainUntil,
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: `arn:aws:kms:${REGION}:${ACCOUNT_ID}:key/evidence`,
          VersionId: 'evidence-version-1',
        }
      }
      if (command instanceof GetObjectRetentionCommand) {
        expect(command.input.VersionId).toBe('evidence-version-1')
        return {
          $metadata: {},
          Retention: { Mode: 'COMPLIANCE', RetainUntilDate: retainUntil },
        }
      }
      throw new Error('unexpected command')
    })
    try {
      await expect(store.putImmutable(
        `evidence/v1/runs/${DRILL_ID}/result.json`,
        artifact,
      )).resolves.toBeDefined()
      expect(commands[0]).toBeInstanceOf(PutObjectCommand)
      expect(commands[1]).toBeInstanceOf(GetObjectCommand)
      expect(commands[2]).toBeInstanceOf(GetObjectRetentionCommand)
    } finally {
      store.close()
    }
  })

  test('rejects a reconciled retention observation that does not match exactly', async () => {
    const store = createEvidenceStore(async (command) => {
      if (command instanceof PutObjectCommand) throw new Error('response lost')
      if (command instanceof GetObjectCommand) {
        return {
          $metadata: {},
          Body: Readable.from([body]),
          ChecksumSHA256: checksum,
          ContentLength: body.byteLength,
          ContentType: 'application/json',
          ObjectLockMode: 'COMPLIANCE',
          ObjectLockRetainUntilDate: retainUntil,
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: `arn:aws:kms:${REGION}:${ACCOUNT_ID}:key/evidence`,
          VersionId: 'evidence-version-1',
        }
      }
      if (command instanceof GetObjectRetentionCommand) {
        return {
          $metadata: {},
          Retention: {
            Mode: 'COMPLIANCE',
            RetainUntilDate: new Date(retainUntil.getTime() + 1),
          },
        }
      }
      throw new Error('unexpected command')
    })
    try {
      await expect(store.putImmutable(
        `evidence/v1/runs/${DRILL_ID}/result.json`,
        artifact,
      )).rejects.toEqual(
        new RestoreDrillOrchestratorFailure('EVIDENCE_WRITE_FAILED'),
      )
    } finally {
      store.close()
    }
  })
})

describe('restore drill cleanup execution identity', () => {
  test.each([
    { partition: 'aws-us-gov', region: 'us-gov-west-1' },
    { partition: 'aws-cn', region: 'cn-north-1' },
  ])('reads a Region-bound $partition cleanup execution', async ({
    partition,
    region,
  }) => {
    const executionName = `restore-cleanup-${'d'.repeat(64)}`
    const executionArn =
      `arn:${partition}:states:${region}:${ACCOUNT_ID}:execution:cleanup:${executionName}`
    const store = new AwsRestoreDrillCleanupExecutionStore(
      region,
      ACCOUNT_ID,
      'cleanup',
    )
    Object.defineProperty(store, 'sfn', {
      value: {
        /** Releases no resources for the in-memory Step Functions fixture. */
        destroy() {},
        /** Returns the Region-bound cleanup execution observation. */
        async send(command: unknown) {
          if (!(command instanceof DescribeExecutionCommand)) {
            throw new Error('unexpected command')
          }
          return {
            $metadata: {},
            executionArn,
            name: executionName,
            startDate: new Date(STARTED_AT),
            stateMachineArn:
              `arn:${partition}:states:${region}:${ACCOUNT_ID}:stateMachine:cleanup`,
            status: 'RUNNING',
            redriveCount: 0,
          }
        },
      },
    })
    try {
      await expect(store.readStatus(executionArn)).resolves.toEqual({
        redriveCount: 0,
        status: 'RUNNING',
      })
    } finally {
      store.close()
    }
  })

  test('requires DescribeExecution to echo the configured workflow identity', async () => {
    const approval = createApproval()
    const store = new AwsRestoreDrillCleanupExecutionStore(
      REGION,
      ACCOUNT_ID,
      'cleanup',
    )
    Object.defineProperty(store, 'sfn', {
      value: {
        destroy() {},
        async send(command: unknown) {
          if (!(command instanceof DescribeExecutionCommand)) {
            throw new Error('unexpected command')
          }
          return {
            $metadata: {},
            executionArn: approval.executionArn,
            name: approval.executionName,
            startDate: new Date(STARTED_AT),
            stateMachineArn:
              `arn:aws:states:${REGION}:${ACCOUNT_ID}:stateMachine:cleanup`,
            status: 'RUNNING',
            redriveCount: 0,
          }
        },
      },
    })
    try {
      await expect(store.readStatus(approval.executionArn)).resolves.toEqual({
        redriveCount: 0,
        status: 'RUNNING',
      })
    } finally {
      store.close()
    }
  })

  test('rejects an execution returned for a different state machine', async () => {
    const approval = createApproval()
    const store = new AwsRestoreDrillCleanupExecutionStore(
      REGION,
      ACCOUNT_ID,
      'cleanup',
    )
    Object.defineProperty(store, 'sfn', {
      value: {
        destroy() {},
        async send(command: unknown) {
          if (!(command instanceof DescribeExecutionCommand)) {
            throw new Error('unexpected command')
          }
          return {
            $metadata: {},
            executionArn: approval.executionArn,
            name: approval.executionName,
            startDate: new Date(STARTED_AT),
            stateMachineArn:
              `arn:aws:states:${REGION}:${ACCOUNT_ID}:stateMachine:substituted`,
            status: 'RUNNING',
            redriveCount: 0,
          }
        },
      },
    })
    try {
      await expect(store.readStatus(approval.executionArn)).rejects.toEqual(
        new RestoreDrillOrchestratorFailure('APPROVAL_INVALID'),
      )
    } finally {
      store.close()
    }
  })

  test('reports redrive count and fails closed when it is absent', async () => {
    const approval = createApproval()
    let includeRedriveCount = true
    const store = new AwsRestoreDrillCleanupExecutionStore(
      REGION,
      ACCOUNT_ID,
      'cleanup',
    )
    Object.defineProperty(store, 'sfn', {
      value: {
        destroy() {},
        async send() {
          return {
            $metadata: {},
            executionArn: approval.executionArn,
            name: approval.executionName,
            ...(includeRedriveCount ? { redriveCount: 1 } : {}),
            startDate: new Date(STARTED_AT),
            stateMachineArn:
              `arn:aws:states:${REGION}:${ACCOUNT_ID}:stateMachine:cleanup`,
            status: 'RUNNING',
          }
        },
      },
    })
    try {
      await expect(store.readStatus(approval.executionArn)).resolves.toEqual({
        redriveCount: 1,
        status: 'RUNNING',
      })
      includeRedriveCount = false
      await expect(store.readStatus(approval.executionArn)).rejects.toEqual(
        new RestoreDrillOrchestratorFailure('APPROVAL_INVALID'),
      )
    } finally {
      store.close()
    }
  })
})

describe('restore drill object-key validation', () => {
  test('accepts consecutive dots inside a legal path segment', () => {
    expect(isRestoreDrillObjectKeyPathSafe(
      'workspaces/workspace-1/report..final.pdf',
    )).toBe(true)
  })

  test('rejects exact traversal segments, NUL, and backslashes', () => {
    expect(isRestoreDrillObjectKeyPathSafe('workspaces/../secret')).toBe(false)
    expect(isRestoreDrillObjectKeyPathSafe('workspaces/./file')).toBe(false)
    expect(isRestoreDrillObjectKeyPathSafe('workspaces/file\u0000name')).toBe(false)
    expect(isRestoreDrillObjectKeyPathSafe('workspaces\\file')).toBe(false)
  })
})

describe('restore drill export inventory bounds', () => {
  test('rejects a stalled continuation cursor', () => {
    const cursor = { keyMarker: 'marker', versionIdMarker: 'version-marker' }
    expect(() => createRestoreDrillExportListingCheckpoint({
      complete: false,
      cursor,
      objectCount: 1,
      pageCount: 1,
      started: true,
    }, 1, cursor)).toThrow(new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED'))
  })

  test('continues cleanup inventory beyond verification limits but rejects overflow', () => {
    expect(createRestoreDrillExportListingCheckpoint({
      complete: false,
      cursor: { keyMarker: 'marker-10', versionIdMarker: 'version-10' },
      objectCount: 10_000,
      pageCount: 10,
      started: true,
    }, 1)).toEqual({
      complete: true,
      objectCount: 10_001,
      pageCount: 11,
      started: true,
    })
    expect(() => createRestoreDrillExportListingCheckpoint({
      complete: false,
      cursor: { keyMarker: 'marker-max', versionIdMarker: 'version-max' },
      objectCount: Number.MAX_SAFE_INTEGER,
      pageCount: 11,
      started: true,
    }, 1)).toThrow(new RestoreDrillOrchestratorFailure('VERIFICATION_FAILED'))
  })
})

describe('restore drill checkpoint query bounds', () => {
  test.each([
    { partition: 'aws-us-gov', region: 'us-gov-west-1' },
    { partition: 'aws-cn', region: 'cn-north-1' },
  ])('round-trips a durable $partition RUN with its native KMS envelope', async ({
    partition,
    region,
  }) => {
    const run: RestoreDrillDurableRun = {
      ...awaitingApprovalRun(emptyCleanupScopeDigest()),
      digestKeyEnvelope: {
        ciphertextBase64: ENVELOPE.ciphertextBase64,
        kind: 'restore-drill-digest-key',
        kmsKeyArn: `arn:${partition}:kms:${region}:${ACCOUNT_ID}:key/evidence`,
      },
      runnerExecutionArn:
        `arn:${partition}:states:${region}:${ACCOUNT_ID}:execution:restore-drill:runner-1`,
    }
    const state = new AwsRestoreDrillStateStore('restore-drill-state', region)
    Object.defineProperty(state, 'document', {
      value: {
        /** Returns the partition-native durable RUN fixture. */
        async send(command: unknown) {
          if (!(command instanceof GetCommand)) throw new Error('unexpected command')
          return { Item: stateRunItem(run) }
        },
      },
    })
    try {
      await expect(state.readRun(DRILL_ID)).resolves.toEqual(run)
    } finally {
      state.close()
    }
  })

  test('rejects a durable KMS envelope whose partition disagrees with its Region', async () => {
    const run: RestoreDrillDurableRun = {
      ...awaitingApprovalRun(emptyCleanupScopeDigest()),
      digestKeyEnvelope: {
        ciphertextBase64: ENVELOPE.ciphertextBase64,
        kind: 'restore-drill-digest-key',
        kmsKeyArn: `arn:aws:kms:cn-north-1:${ACCOUNT_ID}:key/evidence`,
      },
      runnerExecutionArn:
        `arn:aws-cn:states:cn-north-1:${ACCOUNT_ID}:execution:restore-drill:runner-1`,
    }
    const state = new AwsRestoreDrillStateStore('restore-drill-state', 'cn-north-1')
    Object.defineProperty(state, 'document', {
      value: {
        /** Returns the deliberately partition-mismatched durable RUN fixture. */
        async send(command: unknown) {
          if (!(command instanceof GetCommand)) throw new Error('unexpected command')
          return { Item: stateRunItem(run) }
        },
      },
    })
    try {
      await expect(state.readRun(DRILL_ID)).rejects.toEqual(
        new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID'),
      )
    } finally {
      state.close()
    }
  })

  test('accepts a fallback intent that retains a known RPO miss', async () => {
    const failedAt = '2026-08-01T00:30:00.000Z'
    const artifact: RestoreDrillEvidenceArtifact = {
      drillId: DRILL_ID,
      failedAt,
      failureCode: 'WORKFLOW_TASK_FAILED',
      failureVersion: 1,
      kind: 'mukuroji-restore-drill-operational-failure',
      phase: 'restoring-tables',
    }
    const run: RestoreDrillDurableRun = {
      ...failureSealingRun('restoring-tables'),
      failureCodes: ['WORKFLOW_TASK_FAILED'],
      restorePoint: '2026-07-31T23:50:00.000Z',
      terminalArtifactIntent: {
        artifactJson: canonicalFixtureJson(artifact),
        effects: [
          { kind: 'metric', metricName: 'RpoSeconds', unit: 'Seconds', value: 600 },
          { kind: 'metric', metricName: 'DrillFailureCount', unit: 'Count', value: 1 },
          { kind: 'metric', metricName: 'IntegrityFailureCount', unit: 'Count', value: 0 },
        ],
        evidenceKey: `evidence/v1/runs/${DRILL_ID}/result.json`,
        failureCodes: ['RPO_TARGET_MISSED', 'WORKFLOW_TASK_FAILED'],
        resourceDigest: DIGEST,
        resultDigest: RESULT_DIGEST,
        resultOutcome: 'fail',
        retentionReferenceAt: failedAt,
      },
      terminalEffectIndex: 0,
    }
    const state = new AwsRestoreDrillStateStore('restore-drill-state', REGION)
    Object.defineProperty(state, 'document', {
      value: {
        async send(command: unknown) {
          if (!(command instanceof GetCommand)) throw new Error('unexpected command')
          return { Item: stateRunItem(run) }
        },
      },
    })
    try {
      expect(await state.readRun(DRILL_ID)).toEqual(run)
    } finally {
      state.close()
    }
  })

  test('accepts a complete six-effect passing terminal intent from durable state', async () => {
    const artifact = passingResultArtifact()
    const run: RestoreDrillDurableRun = {
      ...failureSealingRun('verifying'),
      restorePoint: STARTED_AT,
      terminalArtifactIntent: {
        artifactJson: canonicalFixtureJson(artifact),
        effects: [
          { completedAt: STARTED_AT, kind: 'record-successful-verification' },
          { kind: 'metric', metricName: 'RpoSeconds', unit: 'Seconds', value: 0 },
          { kind: 'metric', metricName: 'RtoSeconds', unit: 'Seconds', value: 0 },
          { kind: 'metric', metricName: 'DrillFailureCount', unit: 'Count', value: 0 },
          { kind: 'metric', metricName: 'IntegrityFailureCount', unit: 'Count', value: 0 },
          { kind: 'metric', metricName: 'CleanupOverdueCount', unit: 'Count', value: 0 },
        ],
        evidenceKey: `evidence/v1/runs/${DRILL_ID}/result.json`,
        failureCodes: [],
        resourceDigest: DIGEST,
        resultDigest: RESULT_DIGEST,
        resultOutcome: 'pass',
        retentionReferenceAt: STARTED_AT,
      },
      terminalEffectIndex: 0,
      updatedAt: STARTED_AT,
      verificationCompletedAt: STARTED_AT,
    }
    const state = new AwsRestoreDrillStateStore('restore-drill-state', REGION)
    Object.defineProperty(state, 'document', {
      value: {
        async send(command: unknown) {
          if (!(command instanceof GetCommand)) throw new Error('unexpected command')
          return { Item: stateRunItem(run) }
        },
      },
    })
    try {
      expect(await state.readRun(DRILL_ID)).toEqual(run)
    } finally {
      state.close()
    }
  })

  test('projects only approval-facing RUN attributes for cleanup reads', async () => {
    const state = new AwsRestoreDrillStateStore('restore-drill-state', REGION)
    const run = awaitingApprovalRun(emptyCleanupScopeDigest())
    let read: GetCommand | undefined
    Object.defineProperty(state, 'document', {
      value: {
        async send(command: unknown) {
          if (!(command instanceof GetCommand)) throw new Error('unexpected command')
          read = command
          return { Item: stateRunItem(run) }
        },
      },
    })
    try {
      await expect(state.readCleanupRun(DRILL_ID)).resolves.toEqual(run)
      expect(Object.values(read?.input.ExpressionAttributeNames ?? {}))
        .not.toContain('payloadJson')
      expect(Object.values(read?.input.ExpressionAttributeNames ?? {}))
        .toContain('digestKeyEnvelope')
      expect(read?.input.ProjectionExpression).toBeDefined()
    } finally {
      state.close()
    }
  })

  test('adopts an exact generic RUN write after its response is lost', async () => {
    const state = new AwsRestoreDrillStateStore('restore-drill-state', REGION)
    const expected = awaitingApprovalRun(emptyCleanupScopeDigest())
    const next = { ...expected, revision: expected.revision + 1 }
    Object.defineProperty(state, 'document', {
      value: {
        async send(command: unknown) {
          if (command instanceof PutCommand) throw new Error('response lost')
          if (command instanceof GetCommand) return { Item: stateRunItem(next) }
          throw new Error('unexpected command')
        },
      },
    })
    try {
      await expect(state.writeRun(next, expected.revision)).resolves.toBe(true)
    } finally {
      state.close()
    }
  })

  test('uses cleanup-only UpdateItem and adopts its exact response loss', async () => {
    const state = new AwsRestoreDrillStateStore('restore-drill-state', REGION)
    const expected = awaitingApprovalRun(emptyCleanupScopeDigest())
    const approval = createApproval()
    const next: RestoreDrillDurableRun = {
      ...expected,
      approvalDigest: APPROVAL_DIGEST,
      approvalObjectKey:
        `approvals/v1/runs/${DRILL_ID}/${approval.receipt.approvalMac}.json`,
      approvedAt: approval.receipt.approvedAt,
      cleanupAttemptCount: 1,
      cleanupExecutionArn: approval.executionArn,
      cleanupExecutionName: approval.executionName,
      cleanupStartedAt: '2026-08-01T00:20:00.000Z',
      phase: 'cleaning-up',
      revision: expected.revision + 1,
      updatedAt: '2026-08-01T00:20:00.000Z',
    }
    let update: UpdateCommand | undefined
    Object.defineProperty(state, 'document', {
      value: {
        async send(command: unknown) {
          if (command instanceof UpdateCommand) {
            update = command
            throw new Error('response lost')
          }
          if (command instanceof GetCommand) return { Item: stateRunItem(next) }
          throw new Error('unexpected command')
        },
      },
    })
    try {
      await expect(state.writeCleanupRun(next, expected)).resolves.toBe(true)
      expect(update?.input.ConditionExpression).toContain(
        'attribute_not_exists(#cleanupExecutionArn)',
      )
      expect(update?.input.UpdateExpression).not.toContain('resultDigest')
      expect(update?.input.UpdateExpression).not.toContain('digestKeyEnvelope')
    } finally {
      state.close()
    }
  })

  test('adopts an exact run admission only when RUN and CONTROL both landed', async () => {
    const state = new AwsRestoreDrillStateStore('restore-drill-state', REGION)
    const run: RestoreDrillDurableRun = {
      cleanupPolicyVersion: RESTORE_DRILL_CLEANUP_POLICY_VERSION,
      deadlineAt: DEADLINE_AT,
      drillId: DRILL_ID,
      failureCodes: [],
      outcome: 'in-progress',
      phase: 'scheduled',
      revision: 1,
      runnerExecutionArn: RUNNER_EXECUTION_ARN,
      startedAt: STARTED_AT,
      updatedAt: STARTED_AT,
    }
    Object.defineProperty(state, 'document', {
      value: {
        async send(command: unknown) {
          if (command instanceof TransactWriteCommand) throw new Error('response lost')
          if (command instanceof GetCommand) {
            return command.input.Key?.scopeKey === 'CONTROL'
              ? {
                  Item: {
                    activeDrillId: DRILL_ID,
                    cadenceOriginAt: STARTED_AT,
                    kind: 'mukuroji-restore-drill-cadence',
                    recordKey: 'CADENCE',
                    revision: 1,
                    scopeKey: 'CONTROL',
                  },
                }
              : { Item: stateRunItem(run) }
          }
          throw new Error('unexpected command')
        },
      },
    })
    try {
      await expect(state.admitRun(run, 0)).resolves.toBe(true)
    } finally {
      state.close()
    }
  })

  test('adopts an exact File cursor transaction after response loss', async () => {
    const state = new AwsRestoreDrillStateStore('restore-drill-state', REGION)
    let cursorItem: Readonly<Record<string, unknown>> | undefined
    Object.defineProperty(state, 'dynamodb', {
      value: {
        destroy() {},
        async send(command: unknown) {
          if (command instanceof TransactWriteItemsCommand) {
            cursorItem = command.input.TransactItems?.[0]?.Put?.Item
            throw new Error('response lost')
          }
          if (command instanceof GetItemCommand) {
            return command.input.Key?.recordKey?.S === 'RUN'
              ? {
                  Item: {
                    fileCheckpointRecordKey: { S: 'FILE_CURSOR#000000000006' },
                    phase: { S: 'copying-file-versions' },
                    revision: { N: '6' },
                  },
                }
              : { Item: cursorItem }
          }
          throw new Error('unexpected command')
        },
      },
    })
    try {
      await expect(state.writeFileCursor(DRILL_ID, 5)).resolves.toBe(true)
    } finally {
      state.close()
    }
  })

  test('adopts an exact resource checkpoint after an unconditional Put response loss', async () => {
    const state = new AwsRestoreDrillStateStore('restore-drill-state', REGION)
    let persisted: Readonly<Record<string, unknown>> | undefined
    Object.defineProperty(state, 'document', {
      value: {
        async send(command: unknown) {
          if (command instanceof PutCommand) {
            persisted = command.input.Item
            throw new Error('response lost')
          }
          if (command instanceof GetCommand) return persisted ? { Item: persisted } : {}
          throw new Error('unexpected command')
        },
      },
    })
    try {
      await expect(state.writeResourceCheckpoint(
        DRILL_ID,
        emptyResourceCheckpoint(),
      )).resolves.toBeUndefined()
    } finally {
      state.close()
    }
  })

  test('inserts one cleanup-ledger page and its count in a single transaction', async () => {
    const state = new AwsRestoreDrillStateStore('restore-drill-state', REGION)
    const restores = cleanupRestoreTargets(3)
    let transaction: TransactWriteCommand | undefined
    Object.defineProperty(state, 'document', {
      value: {
        async send(command: unknown) {
          if (command instanceof GetCommand) return {}
          if (command instanceof TransactWriteCommand) {
            transaction = command
            return {}
          }
          if (command instanceof PutCommand) return {}
          throw new Error('unexpected command')
        },
      },
    })
    try {
      await state.writeResourceCheckpoint(DRILL_ID, {
        exports: [],
        restoredDescriptors: [],
        restores,
        sources: [],
      })
      const items = transaction?.input.TransactItems ?? []
      expect(items).toHaveLength(5)
      expect(items.filter((item) => item.Put !== undefined)).toHaveLength(3)
      expect(items.at(-1)?.Update?.ExpressionAttributeValues?.[':delta']).toBe(3)
    } finally {
      state.close()
    }
  })

  test('retries only missing cleanup targets after a partial conditional conflict', async () => {
    const state = new AwsRestoreDrillStateStore('restore-drill-state', REGION)
    const restores = cleanupRestoreTargets(3)
    const persisted = new Map<string, Readonly<Record<string, unknown>>>()
    const deltas: number[] = []
    let transactionCount = 0
    Object.defineProperty(state, 'document', {
      value: {
        async send(command: unknown) {
          if (command instanceof GetCommand) {
            const recordKey = command.input.Key?.recordKey
            return typeof recordKey === 'string' && persisted.has(recordKey)
              ? { Item: persisted.get(recordKey) }
              : {}
          }
          if (command instanceof TransactWriteCommand) {
            transactionCount += 1
            const items = command.input.TransactItems ?? []
            const puts = items.flatMap((item) => item.Put?.Item ? [item.Put.Item] : [])
            const delta = items.at(-1)?.Update?.ExpressionAttributeValues?.[':delta']
            if (typeof delta === 'number') deltas.push(delta)
            if (transactionCount === 1) {
              const first = puts[0]
              if (first && typeof first.recordKey === 'string') {
                persisted.set(first.recordKey, first)
              }
              const error = new Error('competing target transaction')
              error.name = 'TransactionCanceledException'
              throw error
            }
            for (const item of puts) {
              if (typeof item.recordKey === 'string') persisted.set(item.recordKey, item)
            }
            return {}
          }
          if (command instanceof PutCommand) return {}
          throw new Error('unexpected command')
        },
      },
    })
    try {
      await state.writeResourceCheckpoint(DRILL_ID, {
        exports: [],
        restoredDescriptors: [],
        restores,
        sources: [],
      })
      expect(transactionCount).toBe(2)
      expect(deltas).toEqual([3, 2])
      expect(persisted.size).toBe(3)
    } finally {
      state.close()
    }
  })

  test('adopts a cleanup-ledger transaction after its response is lost', async () => {
    const state = new AwsRestoreDrillStateStore('restore-drill-state', REGION)
    const restores = cleanupRestoreTargets(3)
    const persisted = new Map<string, Readonly<Record<string, unknown>>>()
    let transactionCount = 0
    Object.defineProperty(state, 'document', {
      value: {
        async send(command: unknown) {
          if (command instanceof GetCommand) {
            const recordKey = command.input.Key?.recordKey
            return typeof recordKey === 'string' && persisted.has(recordKey)
              ? { Item: persisted.get(recordKey) }
              : {}
          }
          if (command instanceof TransactWriteCommand) {
            transactionCount += 1
            for (const item of command.input.TransactItems ?? []) {
              const persistedItem = item.Put?.Item
              if (persistedItem && typeof persistedItem.recordKey === 'string') {
                persisted.set(persistedItem.recordKey, persistedItem)
              }
            }
            throw new Error('transaction response lost')
          }
          if (command instanceof PutCommand) return {}
          throw new Error('unexpected command')
        },
      },
    })
    try {
      await expect(state.writeResourceCheckpoint(DRILL_ID, {
        exports: [],
        restoredDescriptors: [],
        restores,
        sources: [],
      })).resolves.toBeUndefined()
      expect(transactionCount).toBe(1)
      expect(persisted.size).toBe(3)
    } finally {
      state.close()
    }
  })

  test('adopts exact cadence mutations after generic response loss', async () => {
    const state = new AwsRestoreDrillStateStore('restore-drill-state', REGION)
    let operation: 'record' | 'release' = 'record'
    Object.defineProperty(state, 'document', {
      value: {
        async send(command: unknown) {
          if (command instanceof UpdateCommand) throw new Error('response lost')
          if (command instanceof GetCommand) {
            return operation === 'record'
              ? {
                  Item: {
                    activeDrillId: DRILL_ID,
                    kind: 'mukuroji-restore-drill-cadence',
                    lastSuccessfulVerifiedAt: STARTED_AT,
                    recordKey: 'CADENCE',
                    revision: 2,
                    scopeKey: 'CONTROL',
                  },
                }
              : {
                  Item: {
                    activeDrillId: 'drill-20260802',
                    kind: 'mukuroji-restore-drill-cadence',
                    recordKey: 'CADENCE',
                    revision: 3,
                    scopeKey: 'CONTROL',
                  },
                }
          }
          throw new Error('unexpected command')
        },
      },
    })
    try {
      await expect(
        state.recordSuccessfulVerification(DRILL_ID, STARTED_AT),
      ).resolves.toBeUndefined()
      operation = 'release'
      await expect(state.releaseActiveRun(DRILL_ID)).resolves.toBeUndefined()
    } finally {
      state.close()
    }
  })

  test('adopts an exact cleanup-scope transaction after its response is lost', async () => {
    const state = new AwsRestoreDrillStateStore('restore-drill-state', REGION)
    let persistedScope: Readonly<Record<string, unknown>> | undefined
    let transactionScopeKey: unknown
    Object.defineProperty(state, 'document', {
      value: {
        async send(command: unknown) {
          if (command instanceof TransactWriteCommand) {
            const item = command.input.TransactItems?.[0]?.Put?.Item
            if (!item) throw new Error('missing cleanup scope transaction item')
            persistedScope = item
            transactionScopeKey = item.scopeKey
            throw new Error('response lost')
          }
          if (command instanceof GetCommand) {
            return command.input.Key?.recordKey === 'CLEANUP_SCOPE' && persistedScope
              ? { Item: persistedScope }
              : {}
          }
          throw new Error('unexpected command')
        },
      },
    })
    const expected: RestoreDrillCleanupScopeCheckpoint = {
      complete: false,
      exportObjectCount: 0,
      fileObjectCount: 0,
      multipartUploadCount: 0,
      rollingDigest: DIGEST,
      started: true,
      tableCount: 0,
    }
    const next: RestoreDrillCleanupScopeCheckpoint = {
      ...expected,
      complete: true,
      ledgerCount: 0,
      ledgerRevision: 0,
      resourceDigest: DIGEST,
    }
    try {
      await expect(
        state.writeCleanupScopeCheckpoint(DRILL_ID, expected, next),
      ).resolves.toBe(true)
      expect(transactionScopeKey).toBe(`RESTORE_DRILL_LEDGER#${DRILL_ID}`)
    } finally {
      state.close()
    }
  })

  test('adopts an exact cleanup-progress CAS after its response is lost', async () => {
    const state = new AwsRestoreDrillStateStore('restore-drill-state', REGION)
    let persistedProgress: Readonly<Record<string, unknown>> | undefined
    let readScopeKey: unknown
    Object.defineProperty(state, 'document', {
      value: {
        async send(command: unknown) {
          if (command instanceof PutCommand) {
            persistedProgress = command.input.Item
            throw new Error('response lost')
          }
          if (command instanceof GetCommand) {
            readScopeKey = command.input.Key?.scopeKey
            return persistedProgress ? { Item: persistedProgress } : {}
          }
          throw new Error('unexpected command')
        },
      },
    })
    const expected: RestoreDrillCleanupProgress = {
      absenceReceiptCount: 0,
      exportObjectIndex: 0,
      fileObjectIndex: 0,
      multipartUploadIndex: 0,
      tableIndex: 0,
    }
    const next: RestoreDrillCleanupProgress = {
      ...expected,
      completedAt: '2026-08-01T00:32:00.000Z',
    }
    try {
      await expect(
        state.writeCleanupProgress(DRILL_ID, expected, next),
      ).resolves.toBe(true)
      expect(persistedProgress?.scopeKey).toBe(`RESTORE_DRILL_CLEANUP#${DRILL_ID}`)
      expect(readScopeKey).toBe(`RESTORE_DRILL_CLEANUP#${DRILL_ID}`)
    } finally {
      state.close()
    }
  })

  test('returns a cleanup-progress CAS conflict instead of adopting different state', async () => {
    const state = new AwsRestoreDrillStateStore('restore-drill-state', REGION)
    const expected: RestoreDrillCleanupProgress = {
      absenceReceiptCount: 0,
      exportObjectIndex: 0,
      fileObjectIndex: 0,
      multipartUploadIndex: 0,
      tableIndex: 0,
    }
    const next: RestoreDrillCleanupProgress = {
      ...expected,
      completedAt: '2026-08-01T00:32:00.000Z',
    }
    const concurrent: RestoreDrillCleanupProgress = {
      ...expected,
      completedAt: '2026-08-01T00:31:59.000Z',
    }
    Object.defineProperty(state, 'document', {
      value: {
        async send(command: unknown) {
          if (command instanceof PutCommand) {
            const error = new Error('conditional conflict')
            error.name = 'ConditionalCheckFailedException'
            throw error
          }
          if (command instanceof GetCommand) {
            return {
              Item: {
                payloadJson: JSON.stringify(concurrent),
                recordKey: 'CLEANUP_PROGRESS',
                scopeKey: `RESTORE_DRILL_CLEANUP#${DRILL_ID}`,
              },
            }
          }
          throw new Error('unexpected command')
        },
      },
    })
    try {
      await expect(
        state.writeCleanupProgress(DRILL_ID, expected, next),
      ).resolves.toBe(false)
    } finally {
      state.close()
    }
  })

  test('rejects a stalled cleanup-ledger cursor in its separate partition', async () => {
    const state = new AwsRestoreDrillStateStore('restore-drill-state', REGION)
    const cursor = `CLEANUP_TARGET#0#${DIGEST}`
    let queriedScopeKey: unknown
    Object.defineProperty(state, 'document', {
      value: {
        async send(command: unknown) {
          if (!(command instanceof QueryCommand)) throw new Error('unexpected command')
          queriedScopeKey = command.input.ExpressionAttributeValues?.[':scopeKey']
          return {
            Items: [],
            LastEvaluatedKey: {
              recordKey: cursor,
              scopeKey: `RESTORE_DRILL_LEDGER#${DRILL_ID}`,
            },
          }
        },
      },
    })
    try {
      await expect(
        state.readCleanupInventoryPage(DRILL_ID, cursor, 25),
      ).rejects.toEqual(new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID'))
      expect(queriedScopeKey).toBe(`RESTORE_DRILL_LEDGER#${DRILL_ID}`)
    } finally {
      state.close()
    }
  })

  test('rejects a non-advancing DynamoDB LastEvaluatedKey', async () => {
    const state = new AwsRestoreDrillStateStore('restore-drill-state', REGION)
    const lastEvaluatedKey = {
      recordKey: 'START_INTENT#table:audit-events',
      scopeKey: `RUN#${DRILL_ID}`,
    }
    Object.defineProperty(state, 'document', {
      value: {
        async send() {
          return { Items: [], LastEvaluatedKey: lastEvaluatedKey }
        },
      },
    })
    try {
      await expect(state.listStartIntents(DRILL_ID)).rejects.toEqual(
        new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID'),
      )
    } finally {
      state.close()
    }
  })

  test('rejects more records than a checkpoint family permits', async () => {
    const state = new AwsRestoreDrillStateStore('restore-drill-state', REGION)
    Object.defineProperty(state, 'document', {
      value: {
        async send() {
          return {
            Items: Array.from({ length: 7 }, () => ({ payloadJson: '{}' })),
          }
        },
      },
    })
    try {
      await expect(state.listStartIntents(DRILL_ID)).rejects.toEqual(
        new RestoreDrillOrchestratorFailure('RUN_STATE_INVALID'),
      )
    } finally {
      state.close()
    }
  })
})
