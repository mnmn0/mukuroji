import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import { describe, expect, test } from 'bun:test'
import {
  RESTORE_DRILL_TABLE_TARGETS,
} from './restore-drill'
import type {
  RestoreDrillAwsConfiguration,
  RestoreDrillRecordedExport,
  RestoreDrillRecordedRestoreTable,
  RestoreDrillSourceTableNames,
  RestoreDrillTableDescriptor,
} from './restore-drill-aws'
import {
  AwsRestoreDrillVerifier,
  type RestoreDrillSemanticReaderFactory,
  type RestoreDrillVerifierInput,
} from './restore-drill-orchestrator'

const ACCOUNT_ID = '123456789012'
const REGION = 'ap-northeast-1'
const RESTORE_POINT = '2026-08-01T00:00:00.000Z'
const SECRET_VERSION_ID = 'v'.repeat(32)
const DIGEST_KEY = new Uint8Array(32).fill(17)
const AUDIT_KEY_HEX = '2f'.repeat(32)

/** Converts a JSON-compatible test value to one low-level DynamoDB attribute. */
function toAttributeValue(value: unknown): AttributeValue {
  if (value === null) return { NULL: true }
  if (typeof value === 'string') return { S: value }
  if (typeof value === 'number' && Number.isFinite(value)) return { N: String(value) }
  if (typeof value === 'boolean') return { BOOL: value }
  if (Array.isArray(value)) return { L: value.map(toAttributeValue) }
  if (isRecord(value)) return { M: toRawItem(value) }
  throw new TypeError('Unsupported fixture value.')
}

/** Converts one native fixture to a low-level DynamoDB item. */
function toRawItem(value: Readonly<Record<string, unknown>>): Record<string, AttributeValue> {
  const item: Record<string, AttributeValue> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) item[key] = toAttributeValue(entry)
  }
  return item
}

/** Narrows one value to a non-array object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Creates a near-400-KiB low-level File row containing canonical pending versions. */
function createLargePendingFileItem(versionCount: number): Record<string, AttributeValue> {
  const versions = Array.from({ length: versionCount }, (_, index) => {
    const id = index.toString(36)
    return {
      contentType: 'image/png',
      fileName: 'x',
      id,
      number: index + 1,
      objectKey: `workspaces/w/files/f/${id}/x`,
      scanStatus: 'pending',
      sizeBytes: 1,
    }
  })
  return toRawItem({
    createdAt: '2026-08-01T00:00:00.000Z',
    createdByMemberKey: 'm',
    currentVersionId: versions[versions.length - 1]?.id ?? '',
    entryType: 'file',
    fileId: 'f',
    guestAccess: false,
    issueId: 'i',
    name: 'x',
    pendingApprovalCount: 0,
    recordKey: 'FILE#f',
    revision: 1,
    scopeKey: 'WORKSPACE#w#TEAM#t#WORKITEM#i',
    targetId: 'i',
    targetType: 'work-item',
    teamId: 't',
    updatedAt: '2026-08-01T00:20:00.000Z',
    versions,
    workspaceId: 'w',
  })
}

/** Creates the minimal strict descriptor needed by verifier input validation. */
function descriptor(index: number): RestoreDrillTableDescriptor {
  return {
    attributeDefinitions: [{ attributeName: 'id', attributeType: 'S' }],
    billingMode: 'PAY_PER_REQUEST',
    globalSecondaryIndexes: [],
    itemCount: 0,
    keySchema: [{ attributeName: 'id', keyType: 'HASH' }],
    sseStatus: 'ENABLED',
    sseType: 'KMS',
    tableId: `source-table-${index}`,
    ttlEnabled: false,
    ttlStatus: 'DISABLED',
  }
}

/** Creates complete fixed-vector verifier input with no table rows. */
function verifierInput(): RestoreDrillVerifierInput {
  const sources = RESTORE_DRILL_TABLE_TARGETS.map((target, index) => ({
    descriptor: descriptor(index),
    earliestRestorableAt: '2026-07-01T00:00:00.000Z',
    latestRestorableAt: RESTORE_POINT,
    sourceTableArn: `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/source-${index}`,
    target,
  }))
  const restores = RESTORE_DRILL_TABLE_TARGETS.map(
    (target, index): RestoreDrillRecordedRestoreTable => ({
    kind: 'restore-table',
    restorePoint: RESTORE_POINT,
    sourceTableArn: sources[index]?.sourceTableArn ?? '',
    tableArn: `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/restore-${index}`,
    tableId: `restore-table-${index}`,
    tableName: `restore-table-${index}`,
    target,
    }),
  )
  const exports = RESTORE_DRILL_TABLE_TARGETS.map(
    (target, index): RestoreDrillRecordedExport => ({
    clientToken: `client-token-${index}`,
    exportArn: `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/source-${index}/export/1`,
    exportPoint: RESTORE_POINT,
    kind: 'table-export',
    scratchPrefix: `restore-drill/runs/drill-1/exports/${index}`,
    sourceTableArn: sources[index]?.sourceTableArn ?? '',
    sourceTableId: `source-table-${index}`,
    target,
    }),
  )
  return {
    checkpoint: {
      exports,
      restoredDescriptors: RESTORE_DRILL_TABLE_TARGETS.map((_, index) => descriptor(index)),
      restores,
      sources,
    },
    digestKey: DIGEST_KEY,
    drillId: '20260801T000000000Z-123e4567-e89b-42d3-a456-426614174000',
    exportCompletions: RESTORE_DRILL_TABLE_TARGETS.map((target) => ({
      exportArnDigest: 'a'.repeat(64),
      itemCount: 0,
      manifestKey: 'manifest-summary.json',
      target,
    })),
    restorePoint: RESTORE_POINT,
  }
}

/** Creates a syntactically valid production verifier configuration. */
function configuration(): RestoreDrillAwsConfiguration {
  const sourceTables: RestoreDrillSourceTableNames = {
    'table:audit-events': 'source-0',
    'table:file-proofing': 'source-1',
    'table:project-directory': 'source-2',
    'table:work-item-configuration': 'source-3',
    'table:work-items': 'source-4',
    'table:workspace-access': 'source-5',
  }
  return {
    accountId: ACCOUNT_ID,
    auditPseudonymSecretArn:
      `arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:audit-pseudonym`,
    evidenceBucketName: 'restore-evidence-bucket',
    evidenceKmsKeyArn: `arn:aws:kms:${REGION}:${ACCOUNT_ID}:key/evidence-key`,
    metricNamespace: 'Mukuroji/RestoreDrill',
    region: REGION,
    restoreTablePrefix: 'restore-drill',
    scratchBucketName: 'restore-scratch-bucket',
    scratchKmsKeyArn: `arn:aws:kms:${REGION}:${ACCOUNT_ID}:key/scratch-key`,
    sourceFileBucketName: 'source-file-bucket',
    sourceTables,
    stateTableName: 'restore-drill-state',
  }
}

describe('production semantic verifier adapter', () => {
  test('pins the exact secret VersionId and matches the reader Scan limit to page size', async () => {
    let createdScanLimit: number | undefined
    let scanned = false
    const factory: RestoreDrillSemanticReaderFactory = {
      create(_configuration, _tableNames, scanLimit) {
        createdScanLimit = scanLimit
        return {
          close() {},
          async getObjectAttributes() {
            throw new Error('unexpected File read')
          },
          async getObjectTagging() {
            throw new Error('unexpected File read')
          },
          async headObject() {
            throw new Error('unexpected File read')
          },
          async readCallerAccount() {
            return ACCOUNT_ID
          },
          async scanPage() {
            scanned = true
            return { $metadata: {}, Count: 0, Items: [], ScannedCount: 0 }
          },
        }
      },
    }
    const verifier = new AwsRestoreDrillVerifier(configuration(), factory)
    const secretRequests: Array<{ readonly versionId?: string; readonly versionStage?: string }> = []
    Object.defineProperty(verifier, 'secrets', {
      value: {
        destroy() {},
        async send(command: unknown) {
          if (!(command instanceof GetSecretValueCommand)) {
            throw new Error('unexpected secret command')
          }
          secretRequests.push({
            ...(command.input.VersionId ? { versionId: command.input.VersionId } : {}),
            ...(command.input.VersionStage ? { versionStage: command.input.VersionStage } : {}),
          })
          return {
            SecretString: AUDIT_KEY_HEX,
            VersionId: SECRET_VERSION_ID,
          }
        },
      },
    })
    try {
      const input = verifierInput()
      await expect(verifier.resolveSemanticSecretVersion(input)).resolves.toBe(SECRET_VERSION_ID)
      await expect(verifier.readSemanticClaimPage(
        input,
        'table:work-items',
        SECRET_VERSION_ID,
        1_000_000,
      )).resolves.toEqual({ claims: [], retainedUnitCount: 0 })
      expect(createdScanLimit).toBe(25)
      expect(scanned).toBe(true)
      expect(secretRequests).toEqual([
        { versionStage: 'AWSCURRENT' },
        { versionId: SECRET_VERSION_ID },
      ])
    } finally {
      verifier.close()
    }
  })

  test('accepts and deterministically replays a near-limit raw File page above the old claim cap', async () => {
    const rawItem = createLargePendingFileItem(2_000)
    const serializedBytes = new TextEncoder().encode(JSON.stringify(rawItem)).byteLength
    expect(serializedBytes).toBeGreaterThan(380_000)
    expect(serializedBytes).toBeLessThan(400 * 1_024)
    const factory: RestoreDrillSemanticReaderFactory = {
      create() {
        return {
          close() {},
          async getObjectAttributes() {
            throw new Error('unexpected pending File read')
          },
          async getObjectTagging() {
            throw new Error('unexpected pending File read')
          },
          async headObject() {
            throw new Error('unexpected pending File read')
          },
          async readCallerAccount() {
            return ACCOUNT_ID
          },
          async scanPage() {
            return { $metadata: {}, Count: 1, Items: [rawItem], ScannedCount: 1 }
          },
        }
      },
    }
    const verifier = new AwsRestoreDrillVerifier(configuration(), factory)
    Object.defineProperty(verifier, 'secrets', {
      value: {
        destroy() {},
        async send(command: unknown) {
          if (!(command instanceof GetSecretValueCommand)) {
            throw new Error('unexpected secret command')
          }
          return {
            SecretString: AUDIT_KEY_HEX,
            VersionId: SECRET_VERSION_ID,
          }
        },
      },
    })
    try {
      const input = verifierInput()
      const first = await verifier.readSemanticClaimPage(
        input,
        'table:file-proofing',
        SECRET_VERSION_ID,
        1_000_000,
      )
      const replay = await verifier.readSemanticClaimPage(
        input,
        'table:file-proofing',
        SECRET_VERSION_ID,
        1_000_000,
      )
      expect(first.retainedUnitCount).toBe(6_000)
      expect(first.claims).toHaveLength(26_000)
      expect(replay).toEqual(first)
    } finally {
      verifier.close()
    }
  })
})
