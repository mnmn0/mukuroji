import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { expect, test } from 'bun:test'
import { S3Client } from '@aws-sdk/client-s3'
import type { TenantOperation } from '@mukuroji/contracts'
import { TenantAdministrationError } from '../../domain/tenant-administration'
import { S3TenantExportDownloadClient } from './tenant-export-download'

/** Creates one completed export operation for the S3 adapter test. */
function createCompletedExport(): TenantOperation {
  return {
    operationId: 'operation-1',
    workspaceId: 'workspace-1',
    kind: 'export',
    status: 'completed',
    requestedBy: 'owner-1',
    requestedAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:01:00.000Z',
    updatedBy: 'owner-1',
    completedSteps: ['snapshot', 'prepare-artifact', 'verify-artifact'],
    exportFormat: 'jsonl',
    revision: 3,
  }
}

/** Creates one XML list response containing the given export objects. */
function createListResponse(...keys: string[]) {
  return {
    response: {
      body: new TextEncoder().encode(
        '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
        keys.map((key) => `<Contents><Key>${key}</Key><Size>1</Size></Contents>`).join('') +
        '<IsTruncated>false</IsTruncated></ListBucketResult>',
      ),
      headers: { 'content-type': 'application/xml' },
      statusCode: 200,
    },
  }
}

/** Creates one GetObject response carrying a JSON manifest. */
function createManifestResponse(manifest: Record<string, unknown>) {
  return {
    response: {
      body: Readable.from([Buffer.from(JSON.stringify(manifest))]),
      headers: { 'content-type': 'application/json' },
      statusCode: 200,
    },
  }
}

/** Reads the list prefix of one serialized S3 request, or undefined for another call. */
function readListPrefix(request: unknown): string | undefined {
  if (!isRecord(request)) throw new Error('Expected an S3 request.')
  const query = Reflect.get(request, 'query')
  if (!isRecord(query) || Reflect.get(query, 'list-type') === undefined) return undefined
  const prefixValue = Reflect.get(query, 'prefix')
  if (typeof prefixValue === 'string') return prefixValue
  if (Array.isArray(prefixValue) && typeof prefixValue[0] === 'string') return prefixValue[0]
  return ''
}

/** Creates the opaque export namespace for one operation. */
function createPrefix(operation: TenantOperation): string {
  const workspaceDigest = createHash('sha256').update(operation.workspaceId).digest('hex')
  const operationDigest = createHash('sha256').update(operation.operationId).digest('hex')
  return `tenant-exports/${workspaceDigest}/${operationDigest}`
}

test('lists and signs every object in a completed export namespace', async () => {
  const operation = createCompletedExport()
  const workspaceDigest = createHash('sha256').update(operation.workspaceId).digest('hex')
  const operationDigest = createHash('sha256').update(operation.operationId).digest('hex')
  const prefix = `tenant-exports/${workspaceDigest}/${operationDigest}`
  const requests: string[] = []
  const client = new S3Client({
    credentials: {
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
    },
    region: 'ap-northeast-1',
    requestHandler: {
      async handle(request: unknown) {
        const prefixText = readListPrefix(request)
        if (prefixText === undefined) return createManifestResponse({ schemaVersion: 1 })
        requests.push(prefixText)
        return createListResponse(`${prefix}/manifest.json`)
      },
    },
  })
  const downloadClient = new S3TenantExportDownloadClient(
    client,
    'tenant-export',
    300,
    () => new Date('2026-08-02T00:02:00.000Z'),
  )

  try {
    const download = await downloadClient.createDownload(operation)

    expect(requests).toEqual([`${prefix}/`])
    expect(download.expiresAt).toBe('2026-08-02T00:07:00.000Z')
    expect(download.files).toHaveLength(1)
    expect(download.files[0]?.name).toBe('manifest.json')
    expect(download.files[0]?.url).toContain('X-Amz-Expires=300')
  } finally {
    client.destroy()
  }
})

/** Returns true for a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

test('rejects a download request before reading an incomplete export', async () => {
  const client = new S3Client({ region: 'ap-northeast-1' })
  const downloadClient = new S3TenantExportDownloadClient(client, 'tenant-export')

  try {
    await expect(downloadClient.createDownload({
      ...createCompletedExport(),
      status: 'running',
    })).rejects.toMatchObject({
      code: 'TenantExportNotReady',
    } satisfies Partial<TenantAdministrationError>)
  } finally {
    client.destroy()
  }
})

test('signs only the data pages of the snapshot run named by the manifest', async () => {
  const operation = createCompletedExport()
  const prefix = createPrefix(operation)
  const completedRun = 'a'.repeat(32)
  const abandonedRun = 'b'.repeat(32)
  const client = new S3Client({
    credentials: {
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
    },
    region: 'ap-northeast-1',
    requestHandler: {
      async handle(request: unknown) {
        if (readListPrefix(request) === undefined) {
          return createManifestResponse({ schemaVersion: 2, snapshotRunId: completedRun })
        }
        return createListResponse(
          `${prefix}/manifest.json`,
          `${prefix}/snapshot-complete.json`,
          `${prefix}/snapshot-runs/${abandonedRun}/data/work-items/page-1.jsonl`,
          `${prefix}/snapshot-runs/${abandonedRun}/data/work-items/page-2.jsonl`,
          `${prefix}/snapshot-runs/${completedRun}/data/work-items/page-1.jsonl`,
          `${prefix}/snapshot-runs/${completedRun}/data/work-items/page-3.jsonl`,
          `${prefix}/snapshot/files/report.pdf`,
        )
      },
    },
  })
  const downloadClient = new S3TenantExportDownloadClient(client, 'tenant-export')

  try {
    const download = await downloadClient.createDownload(operation)

    expect(download.files.map((file) => file.name)).toEqual([
      'manifest.json',
      'snapshot-complete.json',
      'snapshot/data/work-items/page-1.jsonl',
      'snapshot/data/work-items/page-3.jsonl',
      'snapshot/files/report.pdf',
    ])
    expect(download.files[2]?.url).toContain(
      `snapshot-runs/${completedRun}/data/work-items/page-1.jsonl`,
    )
    expect(download.files.some((file) => file.url.includes(abandonedRun))).toBe(false)
  } finally {
    client.destroy()
  }
})

test('rejects a manifest whose snapshot run is malformed', async () => {
  const operation = createCompletedExport()
  const client = new S3Client({
    credentials: {
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
    },
    region: 'ap-northeast-1',
    requestHandler: {
      async handle(request: unknown) {
        if (readListPrefix(request) === undefined) {
          return createManifestResponse({ snapshotRunId: '../other-run' })
        }
        throw new Error('The export must not be listed after an invalid manifest.')
      },
    },
  })
  const downloadClient = new S3TenantExportDownloadClient(client, 'tenant-export')

  try {
    await expect(downloadClient.createDownload(operation)).rejects.toMatchObject({
      code: 'TenantExportArtifactInvalid',
    } satisfies Partial<TenantAdministrationError>)
  } finally {
    client.destroy()
  }
})
