import { createHash } from 'node:crypto'
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

/** Creates one XML list response containing an export manifest. */
function createListResponse(key: string) {
  return {
    response: {
      body: new TextEncoder().encode(
        '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
        `<Contents><Key>${key}</Key><Size>1</Size></Contents>` +
        '<IsTruncated>false</IsTruncated></ListBucketResult>',
      ),
      headers: { 'content-type': 'application/xml' },
      statusCode: 200,
    },
  }
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
        if (!isRecord(request)) throw new Error('Expected an S3 request.')
        const query = Reflect.get(request, 'query')
        const prefixValue = isRecord(query) ? Reflect.get(query, 'prefix') : undefined
        const prefixText = typeof prefixValue === 'string'
          ? prefixValue
          : Array.isArray(prefixValue) && typeof prefixValue[0] === 'string'
            ? prefixValue[0]
            : ''
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
