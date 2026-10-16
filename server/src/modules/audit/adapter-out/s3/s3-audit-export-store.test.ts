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

    const running: AuditExportJob = { ...first, status: 'running' }
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

    expect(part.key).toBe(`${createAuditExportWorkspacePrefix('ws-1')}${exportId}/part-00001-${part.sha256.slice(0, 16)}.ndjson`)
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
      .rejects.toThrow('outside the export')
    // A key from another Workspace's or another export's namespace is rejected too.
    await expect(store.createPartDownloadUrl('ws-2', exportId, { ...part, index: 1, eventCount: 1 }, 300))
      .rejects.toThrow('outside the export')
    await expect(store.createPartDownloadUrl('ws-1', 'd'.repeat(32), { ...part, index: 1, eventCount: 1 }, 300))
      .rejects.toThrow('outside the export')
  })
})
