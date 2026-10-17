import { describe, expect, test } from 'bun:test'
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { createAuditExportRequestFingerprint, createAuditExportWorkspacePrefix, type AuditExportJob } from '../../audit-export'
import { S3AuditExportStore } from './s3-audit-export-store'

/** S3 failure with the name and status the SDK reports. */
function awsError(name: string, status: number) {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } })
}

/**
 * Creates a store backed by an in-memory S3 fake that enforces conditional writes.
 *
 * @returns The store, its objects, and the recorded put commands.
 */
function createStore() {
  const objects = new Map<string, { body: string; etag: string }>()
  const puts: PutObjectCommand['input'][] = []
  let etagSequence = 0
  const client = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } })
  Object.assign(client, {
    async send(command: unknown) {
      if (command instanceof PutObjectCommand) {
        const input = command.input
        puts.push(input)
        const key = input.Key ?? ''
        const existing = objects.get(key)
        if (input.IfNoneMatch === '*' && existing) throw awsError('PreconditionFailed', 412)
        if (input.IfMatch !== undefined && existing?.etag !== input.IfMatch) throw awsError('PreconditionFailed', 412)
        const body = input.Body
        objects.set(key, {
          body: typeof body === 'string' ? body : new TextDecoder().decode(body instanceof Uint8Array ? body : new Uint8Array()),
          etag: `"etag-${++etagSequence}"`,
        })
        return {}
      }
      if (command instanceof GetObjectCommand) {
        const object = objects.get(command.input.Key ?? '')
        if (!object) throw awsError('NoSuchKey', 404)
        return { ETag: object.etag, Body: { transformToString: async () => object.body } }
      }
      if (command instanceof ListObjectsV2Command) {
        const prefix = command.input.Prefix ?? ''
        const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort()
        return { Contents: keys.map((Key) => ({ Key })), IsTruncated: false }
      }
      throw new Error('Unexpected S3 command.')
    },
  })
  return { store: new S3AuditExportStore({ client, bucketName: 'exports' }), objects, puts }
}

/** Builds a job document. */
function job(exportId: string, createdAt: string, workspaceId = 'ws-1'): AuditExportJob {
  return {
    schemaVersion: 1,
    workspaceId,
    exportId,
    status: 'queued',
    filters: { eventTypes: ['work-item.updated'] },
    requestFingerprint: createAuditExportRequestFingerprint({ eventTypes: ['work-item.updated'] }),
    snapshotAt: createdAt,
    requestedBy: { userKey: 'admin@example.com', displayName: 'admin@example.com' },
    createdAt,
    updatedAt: createdAt,
    expiresAt: '2099-01-01T00:00:00.000Z',
    eventCount: 0,
    parts: [],
    scanAttempt: 1,
  }
}

describe('S3AuditExportStore', () => {
  test('creates a job once and replaces it only with the current ETag', async () => {
    const { store, puts, objects } = createStore()
    const first = job('a'.repeat(32), '2026-07-18T00:00:00.000Z')

    expect(await store.createJob(first)).toBe('created')
    expect(await store.createJob(first)).toBe('exists')
    const stored = await store.readJob('ws-1', first.exportId)
    expect(stored?.job).toEqual(first)

    const running: AuditExportJob = { ...first, status: 'running', nextCursor: 'cursor-1' }
    expect(await store.replaceJob(running, stored?.version ?? '')).toBe(true)
    expect(await store.replaceJob({ ...first, status: 'failed' }, stored?.version ?? '')).toBe(false)
    expect((await store.readJob('ws-1', first.exportId))?.job.status).toBe('running')
    expect(puts.every((input) => input.ServerSideEncryption === 'AES256')).toBe(true)
    expect(puts[0]?.Key).toBe(`${createAuditExportWorkspacePrefix('ws-1')}${first.exportId}/job.json`)
    expect(puts[1]?.Key).toBe(`${createAuditExportWorkspacePrefix('ws-1')}index/8215667199999-${first.exportId}`)
    // A replay only creates a missing marker; an existing one keeps its object and
    // lifecycle clock instead of being rewritten.
    expect(puts[3]?.Key).toBe(puts[1]?.Key)
    expect(puts[3]?.IfNoneMatch).toBe('*')
    expect(objects.get(puts[1]?.Key ?? '')?.etag).toBe('"etag-2"')
    expect(puts.every((input) => !input.Key?.includes('ws-1'))).toBe(true)
  })

  test('propagates S3 409 conflicts instead of reporting an existing or changed job', async () => {
    const client = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } })
    Object.assign(client, {
      async send() {
        throw awsError('ConditionalRequestConflict', 409)
      },
    })
    const store = new S3AuditExportStore({ client, bucketName: 'exports' })
    const conflicted = job('a'.repeat(32), '2026-07-18T00:00:00.000Z')
    await expect(store.createJob(conflicted)).rejects.toMatchObject({ name: 'ConditionalRequestConflict' })
    await expect(store.replaceJob(conflicted, '"etag-1"')).rejects.toMatchObject({ name: 'ConditionalRequestConflict' })
  })

  test('returns undefined for a missing job and rejects malformed stored jobs', async () => {
    const { store, objects } = createStore()
    const exportId = 'b'.repeat(32)

    expect(await store.readJob('ws-1', exportId)).toBeUndefined()
    objects.set(`${createAuditExportWorkspacePrefix('ws-1')}${exportId}/job.json`, { body: '{"status":"done"}', etag: '"x"' })
    await expect(store.readJob('ws-1', exportId)).rejects.toThrow(TypeError)
    await expect(store.readJob('ws-1', '../other')).rejects.toThrow('32 lowercase hexadecimal digits')
    // An unknown stored filter key could be a restriction; fail closed instead of dropping it.
    const unknownFilter = { ...job(exportId, '2026-07-18T00:00:00.000Z'), filters: { eventTypez: ['x'] } }
    objects.set(`${createAuditExportWorkspacePrefix('ws-1')}${exportId}/job.json`, { body: JSON.stringify(unknownFilter), etag: '"y"' })
    await expect(store.readJob('ws-1', exportId)).rejects.toThrow('unknown field: eventTypez')
    // Deadlines come from these times, so unreadable or reordered ones are corrupt.
    const jobPath = `${createAuditExportWorkspacePrefix('ws-1')}${exportId}/job.json`
    objects.set(jobPath, { body: JSON.stringify({ ...job(exportId, '2026-07-18T00:00:00.000Z'), createdAt: 'soon' }), etag: '"z"' })
    await expect(store.readJob('ws-1', exportId)).rejects.toThrow('createdAt must be an ISO timestamp.')
    const reordered = { ...job(exportId, '2026-07-18T00:00:00.000Z'), expiresAt: '2026-07-17T00:00:00.000Z' }
    objects.set(jobPath, { body: JSON.stringify(reordered), etag: '"w"' })
    await expect(store.readJob('ws-1', exportId)).rejects.toThrow('expires before it was created')
    // A fingerprint that no longer describes the stored filters would let a changed job run
    // under the original request's identity.
    const widened = { ...job(exportId, '2026-07-18T00:00:00.000Z'), filters: {} }
    objects.set(jobPath, { body: JSON.stringify(widened), etag: '"v"' })
    await expect(store.readJob('ws-1', exportId)).rejects.toThrow('do not match their fingerprint')
    // Only a running job has a cursor, and a running job always has one.
    for (const mismatched of [
      { ...job(exportId, '2026-07-18T00:00:00.000Z'), status: 'running' },
      { ...job(exportId, '2026-07-18T00:00:00.000Z'), status: 'running', nextCursor: '' },
      { ...job(exportId, '2026-07-18T00:00:00.000Z'), status: 'completed', nextCursor: 'cursor-1' },
      // A running job either scans from a cursor or verifies with a count, never both.
      { ...job(exportId, '2026-07-18T00:00:00.000Z'), status: 'running', nextCursor: 'cursor-1', verification: { count: 0 } },
      // A completed job must not carry an unfinished completeness check.
      { ...job(exportId, '2026-07-18T00:00:00.000Z'), status: 'completed', verification: { count: 0 } },
    ]) {
      objects.set(jobPath, { body: JSON.stringify(mismatched), etag: '"q"' })
      await expect(store.readJob('ws-1', exportId)).rejects.toThrow('status does not match its cursor')
    }
    // A queued job has no progress yet.
    const queuedWithProgress = {
      ...job(exportId, '2026-07-18T00:00:00.000Z'),
      status: 'queued',
      eventCount: 5,
      parts: [{ index: 1, key: 'k', eventCount: 5, byteLength: 1, sha256: 'a'.repeat(64) }],
    }
    objects.set(jobPath, { body: JSON.stringify(queuedWithProgress), etag: '"p"' })
    await expect(store.readJob('ws-1', exportId)).rejects.toThrow('already has progress')
    const { scanAttempt: _scanAttempt, ...withoutAttempt } = job(exportId, '2026-07-18T00:00:00.000Z')
    void _scanAttempt
    objects.set(jobPath, { body: JSON.stringify(withoutAttempt), etag: '"n"' })
    await expect(store.readJob('ws-1', exportId)).rejects.toThrow('scanAttempt must be a non-negative integer')
    // Only an unfinished job can wait for a continuation send.
    const pendingAfterCompletion = { ...job(exportId, '2026-07-18T00:00:00.000Z'), status: 'completed', continuationPending: true }
    objects.set(jobPath, { body: JSON.stringify(pendingAfterCompletion), etag: '"l"' })
    await expect(store.readJob('ws-1', exportId)).rejects.toThrow('does not match its pending continuation')
    const verifying = { ...job(exportId, '2026-07-18T00:00:00.000Z'), status: 'running', verification: { count: 0, cursor: 'c' }, lastStepMessageId: 'm-1' }
    objects.set(jobPath, { body: JSON.stringify(verifying), etag: '"m"' })
    expect((await store.readJob('ws-1', exportId))?.job).toMatchObject({ verification: { count: 0, cursor: 'c' }, lastStepMessageId: 'm-1' })
    // The stored identity must match the key it was read from.
    objects.set(jobPath, { body: JSON.stringify(job('c'.repeat(32), '2026-07-18T00:00:00.000Z')), etag: '"u"' })
    await expect(store.readJob('ws-1', exportId)).rejects.toThrow('does not match its storage key')
    objects.set(`${createAuditExportWorkspacePrefix('ws-2')}${exportId}/job.json`, { body: JSON.stringify(job(exportId, '2026-07-18T00:00:00.000Z')), etag: '"t"' })
    await expect(store.readJob('ws-2', exportId)).rejects.toThrow('does not match its storage key')
    // The worker enforces the event limit from the job total, so it must match the parts.
    const understated = {
      ...job(exportId, '2026-07-18T00:00:00.000Z'),
      status: 'running',
      nextCursor: 'cursor-1',
      eventCount: 1,
      parts: [{ index: 1, key: 'k', eventCount: 5, byteLength: 1, sha256: 'a'.repeat(64) }],
    }
    objects.set(jobPath, { body: JSON.stringify(understated), etag: '"s"' })
    await expect(store.readJob('ws-1', exportId)).rejects.toThrow('event count does not match its parts')
    // Parts from another writer show as gaps, duplicates, or checksums that are not SHA-256 digests.
    const storedPart = { key: 'k', eventCount: 1, byteLength: 1, sha256: 'a'.repeat(64) }
    const foreignParts: [unknown[], string][] = [
      [[{ ...storedPart, index: 0 }], 'numbered from 1 in order'],
      [[{ ...storedPart, index: 1 }, { ...storedPart, index: 1 }], 'numbered from 1 in order'],
      [[{ ...storedPart, index: 2 }], 'numbered from 1 in order'],
      [[{ ...storedPart, index: 1, sha256: 'not-a-digest' }], 'SHA-256 hex digest'],
    ]
    // A failure is written only with the failed status, so any other pairing is corrupt.
    for (const mismatched of [
      { ...job(exportId, '2026-07-18T00:00:00.000Z'), status: 'completed', failure: { code: 'X', message: 'x' } },
      { ...job(exportId, '2026-07-18T00:00:00.000Z'), status: 'failed' },
    ]) {
      objects.set(jobPath, { body: JSON.stringify(mismatched), etag: '"f"' })
      await expect(store.readJob('ws-1', exportId)).rejects.toThrow('does not match its failure')
    }
    for (const [parts, message] of foreignParts) {
      const foreign = { ...understated, eventCount: parts.length, parts }
      objects.set(jobPath, { body: JSON.stringify(foreign), etag: '"p"' })
      await expect(store.readJob('ws-1', exportId)).rejects.toThrow(message)
    }
    // An empty stored restriction would be dropped by the query and widen the export.
    for (const filters of [{ eventTypes: [] }, { eventTypes: [' '] }, { actorId: '' }]) {
      const widenedByEmpty = { ...job(exportId, '2026-07-18T00:00:00.000Z'), filters }
      objects.set(jobPath, { body: JSON.stringify(widenedByEmpty), etag: '"r"' })
      await expect(store.readJob('ws-1', exportId)).rejects.toThrow('must not be empty')
    }
  })

  test('propagates a missing bucket instead of reporting a missing job', async () => {
    const client = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } })
    Object.assign(client, {
      async send() {
        throw awsError('NoSuchBucket', 404)
      },
    })
    const store = new S3AuditExportStore({ client, bucketName: 'missing' })
    await expect(store.readJob('ws-1', 'b'.repeat(32))).rejects.toMatchObject({ name: 'NoSuchBucket' })
  })

  test('lists only the Workspace jobs, newest first', async () => {
    const { store, objects } = createStore()
    await store.createJob(job('1'.repeat(32), '2026-07-16T00:00:00.000Z'))
    await store.createJob(job('2'.repeat(32), '2026-07-18T00:00:00.000Z'))
    await store.createJob(job('3'.repeat(32), '2026-07-17T00:00:00.000Z', 'ws-2'))

    // A replay keeps the stored creation time, and a stale marker without a job is skipped.
    await store.createJob(job('1'.repeat(32), '2026-07-19T00:00:00.000Z'))
    objects.set(`${createAuditExportWorkspacePrefix('ws-1')}index/0000000000000-${'4'.repeat(32)}`, { body: '', etag: '"m"' })

    expect((await store.listJobs('ws-1', 20)).map((entry) => entry.exportId)).toEqual(['2'.repeat(32), '1'.repeat(32)])
    expect((await store.listJobs('ws-1', 1)).map((entry) => entry.exportId)).toEqual(['2'.repeat(32)])
  })

  test('writes checksummed parts and presigns downloads inside the export namespace', async () => {
    const { store, puts } = createStore()
    const exportId = 'c'.repeat(32)

    const part = await store.putPart('ws-1', exportId, 1, '{"eventId":"e1"}\n')

    expect(part.key).toBe(`${createAuditExportWorkspacePrefix('ws-1')}${exportId}/part-00001-${part.sha256}.ndjson`)
    expect(part.byteLength).toBe(17)
    expect(part.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(puts.at(-1)).toMatchObject({ ChecksumSHA256: Buffer.from(part.sha256, 'hex').toString('base64') })
    // Different content for the same index gets a different key, so it cannot replace a committed part.
    expect((await store.putPart('ws-1', exportId, 1, '{"eventId":"e2"}\n')).key).not.toBe(part.key)
    await expect(store.putPart('ws-1', exportId, 0, '')).rejects.toThrow(RangeError)

    const url = new URL(await store.createPartDownloadUrl('ws-1', exportId, { ...part, index: 1, eventCount: 1 }, 3600))
    expect(url.pathname).toBe(`/${part.key}`)
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300')
    // A link never outlives the job.
    const capped = new URL(await store.createPartDownloadUrl('ws-1', exportId, { ...part, index: 1, eventCount: 1 }, 42))
    expect(capped.searchParams.get('X-Amz-Expires')).toBe('42')
    expect(url.searchParams.get('response-content-disposition')).toContain('mukuroji-audit-part-00001.ndjson')
    await expect(store.createPartDownloadUrl('ws-1', exportId, { ...part, key: 'workspaces/x/files/a', index: 1, eventCount: 1 }, 300))
      .rejects.toThrow('does not match the export part')
    // A key from another Workspace's or another export's namespace is rejected too.
    await expect(store.createPartDownloadUrl('ws-2', exportId, { ...part, index: 1, eventCount: 1 }, 300))
      .rejects.toThrow('does not match the export part')
    await expect(store.createPartDownloadUrl('ws-1', 'd'.repeat(32), { ...part, index: 1, eventCount: 1 }, 300))
      .rejects.toThrow('does not match the export part')
    // An orphan part from a discarded scan cannot be served under another part's index or checksum.
    const orphan = await store.putPart('ws-1', exportId, 2, '{"eventId":"orphan"}\n')
    await expect(store.createPartDownloadUrl('ws-1', exportId, { ...part, key: orphan.key, index: 1, eventCount: 1 }, 300))
      .rejects.toThrow('does not match the export part')
    await expect(store.createPartDownloadUrl('ws-1', exportId, { ...orphan, index: 1, eventCount: 1 }, 300))
      .rejects.toThrow('does not match the export part')
    // Every checksum character is bound, so a stored checksum differing only in its tail is rejected.
    const tamperedSha256 = `${part.sha256.slice(0, 63)}${part.sha256.endsWith('0') ? '1' : '0'}`
    await expect(store.createPartDownloadUrl('ws-1', exportId, { ...part, sha256: tamperedSha256, index: 1, eventCount: 1 }, 300))
      .rejects.toThrow('does not match the export part')
  })
})
