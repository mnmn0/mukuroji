import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type {
  TenantExportDownload,
  TenantOperation,
} from '@mukuroji/contracts'
import { createHash } from 'node:crypto'
import { loadServerConfig } from '../../../../infrastructure/config/server-config'
import { TenantAdministrationError } from '../../domain/tenant-administration'
import type { TenantExportDownloadPort } from '../../application/ports/tenant-administration-port'

const DEFAULT_DOWNLOAD_TTL_SECONDS = 300

/** S3-backed authorized access to completed tenant export objects. */
export class S3TenantExportDownloadClient implements TenantExportDownloadPort {
  /** S3 client used only for the dedicated export bucket. */
  private readonly client: S3Client
  /** Dedicated private bucket containing tenant export artifacts. */
  private readonly bucketName: string
  /** Lifetime applied to every generated object URL. */
  private readonly downloadTtlSeconds: number
  /** Clock used to make the response expiry deterministic in tests. */
  private readonly clock: () => Date

  /**
   * Creates an S3 export download client.
   *
   * @param client - S3 client authorized to list and read the export bucket.
   * @param bucketName - Dedicated private export bucket name.
   * @param downloadTtlSeconds - Lifetime of each signed URL.
   * @param clock - Optional clock used for the response expiry.
   */
  constructor(
    client: S3Client,
    bucketName: string,
    downloadTtlSeconds = DEFAULT_DOWNLOAD_TTL_SECONDS,
    clock: () => Date = () => new Date(),
  ) {
    if (!bucketName.trim()) throw new TypeError('Tenant export bucket name is required.')
    if (!Number.isSafeInteger(downloadTtlSeconds) || downloadTtlSeconds <= 0) {
      throw new TypeError('Tenant export download TTL must be a positive integer.')
    }
    this.client = client
    this.bucketName = bucketName
    this.downloadTtlSeconds = downloadTtlSeconds
    this.clock = clock
  }

  /**
   * Lists and signs every object belonging to one completed export operation.
   *
   * @param operation - Operation already authorized for the current tenant.
   * @returns Short-lived URLs for all generated artifact objects.
   */
  async createDownload(operation: TenantOperation): Promise<TenantExportDownload> {
    if (operation.kind !== 'export' || operation.status !== 'completed') {
      throw new TenantAdministrationError(
        409,
        'TenantExportNotReady',
        'The tenant export is not ready for download.',
      )
    }
    const prefix = createExportPrefix(operation)
    const files: TenantExportDownload['files'] = []
    let continuationToken: string | undefined
    do {
      const response = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: `${prefix}/`,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }))
      for (const object of response.Contents ?? []) {
        if (!object.Key || !object.Key.startsWith(`${prefix}/`)) {
          throw new TenantAdministrationError(
            503,
            'TenantExportScopeMismatch',
            'Tenant export storage returned an object outside the operation namespace.',
          )
        }
        const name = object.Key.slice(prefix.length + 1)
        if (!name) {
          throw new TenantAdministrationError(
            503,
            'TenantExportArtifactInvalid',
            'Tenant export storage returned an invalid artifact key.',
          )
        }
        const url = await getSignedUrl(
          this.client,
          new GetObjectCommand({
            Bucket: this.bucketName,
            Key: object.Key,
          }),
          { expiresIn: this.downloadTtlSeconds },
        )
        files.push({ name, url })
      }
      if (response.IsTruncated && !response.NextContinuationToken) {
        throw new TenantAdministrationError(
          503,
          'TenantExportPaginationInvalid',
          'Tenant export storage did not provide a continuation token.',
        )
      }
      continuationToken = response.NextContinuationToken
    } while (continuationToken)

    if (files.length === 0) {
      throw new TenantAdministrationError(
        503,
        'TenantExportArtifactMissing',
        'Tenant export artifact is missing.',
      )
    }
    return {
      expiresAt: new Date(
        this.clock().getTime() + this.downloadTtlSeconds * 1_000,
      ).toISOString(),
      files,
    }
  }
}

/** Creates the production S3 adapter from runtime configuration. */
export function createProductionTenantExportDownloadClient(): S3TenantExportDownloadClient {
  const config = loadServerConfig()
  const endpoint = config.environment.AWS_ENDPOINT_URL_S3 ??
    config.environment.AWS_ENDPOINT_URL
  const client = new S3Client({
    region: config.awsRegion,
    ...(endpoint
      ? {
          endpoint,
          forcePathStyle: true,
          credentials: {
            accessKeyId: config.environment.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: config.environment.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }
      : {}),
  })
  return new S3TenantExportDownloadClient(
    client,
    config.environment.TENANT_EXPORT_BUCKET_NAME ?? 'mukuroji-tenant-exports-local',
    readDownloadTtl(config.environment.TENANT_EXPORT_DOWNLOAD_URL_TTL_SECONDS),
  )
}

/** Creates the opaque export namespace shared with the trusted worker. */
function createExportPrefix(operation: TenantOperation): string {
  return `tenant-exports/${digestIdentifier(operation.workspaceId)}/${digestIdentifier(operation.operationId)}`
}

/** Creates a lowercase SHA-256 digest for an internal export namespace. */
function digestIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Reads a positive signed-URL lifetime, falling back to the safe default. */
function readDownloadTtl(value: string | undefined): number {
  if (value === undefined || !/^\d+$/u.test(value)) return DEFAULT_DOWNLOAD_TTL_SECONDS
  const ttl = Number(value)
  return Number.isSafeInteger(ttl) && ttl > 0 ? ttl : DEFAULT_DOWNLOAD_TTL_SECONDS
}
