import { describe, expect, test } from 'bun:test'
import {
  FileIntegrityFailure,
  checkFileMetadataIntegrity as checkFileMetadataIntegrityAtTime,
  parseFileIntegrityReferences,
  type FileIntegrityObjectObservation,
  type FileMetadataIntegrityCheckInput,
  type FileMetadataIntegrityResult,
} from './file-integrity'

const OBJECT_KEY = 'workspaces/workspace-private/files/file-private/version-private/design.pdf'
const CHECKED_AT = '2026-08-02T00:00:00.000Z'

/**
 * Runs a fixture check at the common explicit clock.
 *
 * @param input - File row and object observations without the common clock.
 * @returns Evidence-safe integrity result.
 */
function checkFileMetadataIntegrity(
  input: Omit<FileMetadataIntegrityCheckInput, 'checkedAt'>,
): FileMetadataIntegrityResult {
  return checkFileMetadataIntegrityAtTime({ ...input, checkedAt: CHECKED_AT })
}

/**
 * Creates a valid stored File row with optional corruption overrides.
 *
 * @param itemOverrides - Top-level row overrides.
 * @param versionOverrides - First-version overrides.
 * @returns A DynamoDB-shaped File row fixture.
 */
function createFileItem(
  itemOverrides: Record<string, unknown> = {},
  versionOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const version = {
    id: 'version-private',
    number: 1,
    fileName: 'design.pdf',
    contentType: 'application/pdf',
    sizeBytes: 4_096,
    scanStatus: 'available',
    previewKind: 'pdf',
    createdByMemberKey: 'member-private',
    createdAt: '2026-08-01T00:00:00.000Z',
    verifiedAt: '2026-08-01T00:01:00.000Z',
    objectKey: OBJECT_KEY,
    objectVersionId: 'object-version-private',
    ...versionOverrides,
  }
  return {
    scopeKey: 'WORKSPACE#workspace-private#TEAM#team-private#WORKITEM#issue-private',
    recordKey: 'FILE#file-private',
    entryType: 'file',
    workspaceId: 'workspace-private',
    teamId: 'team-private',
    issueId: 'issue-private',
    fileId: 'file-private',
    revision: 1,
    pendingApprovalCount: 0,
    name: 'design.pdf',
    targetType: 'work-item',
    targetId: 'issue-private',
    versions: [version],
    currentVersionId: 'version-private',
    createdByMemberKey: 'member-private',
    guestAccess: false,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:01:00.000Z',
    ...itemOverrides,
  }
}

/**
 * Creates an exact valid object observation with optional metadata differences.
 *
 * @param overrides - Observation overrides.
 * @returns An exact object observation fixture.
 */
function createObjectObservation(
  overrides: Partial<FileIntegrityObjectObservation> = {},
): FileIntegrityObjectObservation {
  return {
    objectKey: OBJECT_KEY,
    objectVersionId: 'object-version-private',
    sizeBytes: 4_096,
    contentType: 'application/pdf',
    scanStatus: 'available',
    uploadState: 'completed',
    deleted: false,
    ...overrides,
  }
}

describe('file metadata integrity references', () => {
  test('strictly parses a valid row into process-local exact object references', () => {
    expect(parseFileIntegrityReferences(createFileItem())).toEqual([{
      scopeKey: 'WORKSPACE#workspace-private#TEAM#team-private#WORKITEM#issue-private',
      recordKey: 'FILE#file-private',
      workspaceId: 'workspace-private',
      teamId: 'team-private',
      targetType: 'work-item',
      targetId: 'issue-private',
      parentTargetType: 'work-item',
      parentTargetId: 'issue-private',
      fileId: 'file-private',
      versionId: 'version-private',
      currentVersion: true,
      objectKey: OBJECT_KEY,
      objectVersionId: 'object-version-private',
      sizeBytes: 4_096,
      contentType: 'application/pdf',
      scanStatus: 'available',
      deleted: false,
    }])
  })

  test('returns the validated parent scope for project and comment attachments', () => {
    const projectReferences = parseFileIntegrityReferences(createFileItem({
      scopeKey: 'WORKSPACE#workspace-private#TEAM#team-private#PROJECT#project-private',
      issueId: undefined,
      projectId: 'project-private',
      targetType: 'project',
      targetId: 'project-private',
    }))
    const commentReferences = parseFileIntegrityReferences(createFileItem({
      targetType: 'comment',
      targetId: 'comment-private',
    }))

    expect(projectReferences[0]).toMatchObject({
      parentTargetType: 'project',
      parentTargetId: 'project-private',
    })
    expect(commentReferences[0]).toMatchObject({
      targetType: 'comment',
      targetId: 'comment-private',
      parentTargetType: 'work-item',
      parentTargetId: 'issue-private',
    })
  })

  test('rejects a tenant-crossing physical scope deterministically', () => {
    const item = createFileItem({
      scopeKey: 'WORKSPACE#other-workspace#TEAM#team-private#WORKITEM#issue-private',
    })

    expect(() => parseFileIntegrityReferences(item)).toThrow(FileIntegrityFailure)
    expect(checkFileMetadataIntegrity({ item, objects: [] })).toEqual({
      ok: false,
      checkedVersionCount: 0,
      checkedObjectCount: 0,
      failureCodes: ['FILE_METADATA_TENANT_MISMATCH'],
    })
  })

  test('rejects target ownership that crosses the parent Work Item', () => {
    const result = checkFileMetadataIntegrity({
      item: createFileItem({ targetId: 'other-issue-private' }),
      objects: [],
    })

    expect(result.failureCodes).toEqual(['FILE_METADATA_TENANT_MISMATCH'])
    expect(JSON.stringify(result)).not.toContain('other-issue-private')
  })

  test('rejects an object key that does not bind workspace, file, version, and name', () => {
    const result = checkFileMetadataIntegrity({
      item: createFileItem({}, { objectKey: 'workspaces/other/private-object' }),
      objects: [],
    })

    expect(result.failureCodes).toEqual(['FILE_METADATA_REFERENCE_MISSING'])
  })

  test('accepts an unverified pending upload without requiring an object observation', () => {
    const item = createFileItem({}, {
      scanStatus: 'pending',
      objectVersionId: undefined,
      verifiedAt: undefined,
    })

    expect(checkFileMetadataIntegrity({ item, objects: [] })).toEqual({
      ok: true,
      checkedVersionCount: 1,
      checkedObjectCount: 0,
      failureCodes: [],
    })
  })

  test('rejects a current version identifier absent from the version set', () => {
    const result = checkFileMetadataIntegrity({
      item: createFileItem({ currentVersionId: 'missing-version-private' }),
      objects: [],
    })

    expect(result.failureCodes).toEqual(['FILE_METADATA_REFERENCE_MISSING'])
  })

  test('rejects writer-disallowed media types through the shared canonical allowlist', () => {
    const result = checkFileMetadataIntegrity({
      item: createFileItem({}, { contentType: 'application/octet-stream' }),
      objects: [],
    })

    expect(result.failureCodes).toEqual(['FILE_METADATA_REFERENCE_MISSING'])
  })

  test('requires an explicit canonical check timestamp', () => {
    expect(() => checkFileMetadataIntegrityAtTime({
      checkedAt: '2026-08-02T00:00:00Z',
      item: createFileItem(),
      objects: [],
    })).toThrow('File integrity checkedAt is invalid.')
  })
})

describe('file metadata object integrity', () => {
  test('reports a clean exact version without exposing raw identifiers', () => {
    const result = checkFileMetadataIntegrity({
      item: createFileItem(),
      objects: [createObjectObservation()],
    })

    expect(result).toEqual({
      ok: true,
      checkedVersionCount: 1,
      checkedObjectCount: 1,
      failureCodes: [],
    })
    const evidence = JSON.stringify(result)
    expect(evidence).not.toContain('workspace-private')
    expect(evidence).not.toContain('file-private')
    expect(evidence).not.toContain('object-version-private')
  })

  test('reports a missing exact immutable object version', () => {
    expect(checkFileMetadataIntegrity({
      item: createFileItem(),
      objects: [],
    })).toEqual({
      ok: false,
      checkedVersionCount: 1,
      checkedObjectCount: 0,
      failureCodes: ['FILE_METADATA_OBJECT_MISSING'],
    })
  })

  test('classifies exact version identity substitution as object mismatch', () => {
    const result = checkFileMetadataIntegrity({
      item: createFileItem(),
      objects: [createObjectObservation({ objectVersionId: 'substituted-private' })],
    })

    expect(result.failureCodes).toEqual(['FILE_METADATA_OBJECT_MISMATCH'])
  })

  test('classifies size, media type, scan, and deletion differences deterministically', () => {
    const result = checkFileMetadataIntegrity({
      item: createFileItem(),
      objects: [createObjectObservation({
        sizeBytes: 8_192,
        contentType: 'application/json',
        scanStatus: 'blocked',
        deleted: true,
      })],
    })

    expect(result).toEqual({
      ok: false,
      checkedVersionCount: 1,
      checkedObjectCount: 1,
      failureCodes: ['FILE_METADATA_OBJECT_MISMATCH'],
    })
  })

  test('accepts terminal GuardDuty states while a scanning row converges', () => {
    const item = createFileItem({}, { scanStatus: 'scanning' })
    const availablePending = checkFileMetadataIntegrity({
      item,
      objects: [createObjectObservation({ scanStatus: 'available', uploadState: 'pending' })],
    })
    const availableCompleted = checkFileMetadataIntegrity({
      item,
      objects: [createObjectObservation({ scanStatus: 'available', uploadState: 'completed' })],
    })
    const blockedPending = checkFileMetadataIntegrity({
      item,
      objects: [createObjectObservation({ scanStatus: 'blocked', uploadState: 'pending' })],
    })
    const failedPending = checkFileMetadataIntegrity({
      item,
      objects: [createObjectObservation({ scanStatus: 'failed', uploadState: 'pending' })],
    })

    expect([
      availablePending.ok,
      availableCompleted.ok,
      blockedPending.ok,
      failedPending.ok,
    ]).toEqual([true, true, true, true])
  })

  test('rejects upload tag states that cannot occur in the File lifecycle', () => {
    const availablePending = checkFileMetadataIntegrity({
      item: createFileItem(),
      objects: [createObjectObservation({ uploadState: 'pending' })],
    })
    const scanningCompleted = checkFileMetadataIntegrity({
      item: createFileItem({}, { scanStatus: 'scanning' }),
      objects: [createObjectObservation({ scanStatus: 'scanning', uploadState: 'completed' })],
    })

    expect(availablePending.failureCodes).toEqual(['FILE_METADATA_OBJECT_MISMATCH'])
    expect(scanningCompleted.failureCodes).toEqual(['FILE_METADATA_OBJECT_MISMATCH'])
  })

  test('classifies an observed object without a metadata reference', () => {
    const result = checkFileMetadataIntegrity({
      item: createFileItem(),
      objects: [
        createObjectObservation(),
        createObjectObservation({
          objectKey: 'workspaces/workspace-private/files/orphan/version/orphan.pdf',
          objectVersionId: 'orphan-version-private',
        }),
      ],
    })

    expect(result.failureCodes).toEqual(['FILE_METADATA_REFERENCE_MISSING'])
  })

  test('accepts both sides of the durable soft-delete quarantine transition', () => {
    const deletedAt = '2026-08-01T00:05:00.000Z'
    const retentionUntil = '2026-08-31T00:05:00.000Z'
    const item = createFileItem({
      deletedAt,
      retentionUntil,
      expiresAt: Math.floor(Date.parse(retentionUntil) / 1_000),
    })

    expect(checkFileMetadataIntegrity({
      item,
      objects: [createObjectObservation({ deleted: true })],
    }).ok).toBe(true)
    expect(checkFileMetadataIntegrity({
      item,
      objects: [createObjectObservation({ deleted: false })],
    }).ok).toBe(true)
  })

  test('still rejects a deleted quarantine tag on a live File row', () => {
    const result = checkFileMetadataIntegrity({
      item: createFileItem(),
      objects: [createObjectObservation({ deleted: true })],
    })

    expect(result.failureCodes).toEqual(['FILE_METADATA_OBJECT_MISMATCH'])
  })

  test('excludes an expired TTL-delayed tombstone from all object requirements', () => {
    const retentionUntil = '2026-08-01T12:00:00.000Z'
    const result = checkFileMetadataIntegrityAtTime({
      checkedAt: CHECKED_AT,
      item: createFileItem({
        deletedAt: '2026-08-01T00:05:00.000Z',
        retentionUntil,
        expiresAt: Math.floor(Date.parse(retentionUntil) / 1_000),
      }),
      objects: [createObjectObservation({
        objectKey: 'workspaces/workspace-private/files/orphan/version/orphan.pdf',
        objectVersionId: 'orphan-version-private',
        contentType: 'application/octet-stream',
        scanStatus: 'blocked',
        uploadState: 'pending',
      })],
    })

    expect(result).toEqual({
      ok: true,
      checkedVersionCount: 1,
      checkedObjectCount: 0,
      failureCodes: [],
    })
  })

  test('rejects incomplete deletion retention as a missing reference invariant', () => {
    const result = checkFileMetadataIntegrity({
      item: createFileItem({ deletedAt: '2026-08-01T00:05:00.000Z' }),
      objects: [],
    })

    expect(result.failureCodes).toEqual(['FILE_METADATA_REFERENCE_MISSING'])
  })
})
