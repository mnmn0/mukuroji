import { createHash } from 'node:crypto'
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import {
  createAuditExportWorkspacePrefix,
  parseAuditExportJob,
  type AuditExportJob,
  type AuditExportPart,
  type AuditExportStore,
  type StoredAuditExportJob,
} from '../../audit-export'

/** Seconds a part download URL stays valid. */
const AUDIT_EXPORT_DOWNLOAD_TTL_SECONDS = 300
/** Upper bound on job directories inspected when listing exports. */
const AUDIT_EXPORT_LIST_SCAN_LIMIT = 200

/**
 * Configuration of the S3 export store.
 */
export type S3AuditExportStoreOptions = {
  /** S3 client used for every request. */
  readonly client: S3Client
  /** Private bucket that holds jobs and parts. */
  readonly bucketName: string
}

/**
 * Stores export job documents and NDJSON parts in one private S3 bucket.
 *
 * Each job lives under `audit-exports/<sha256(workspaceId)>/<exportId>/`. The job
 * document uses `If-None-Match` for creation and `If-Match` on its ETag for every
 * replacement, so concurrent workers cannot both advance a job.
 */
export class S3AuditExportStore implements AuditExportStore {
  /** S3 client used for every request. */
  private readonly client: S3Client
  /** Private bucket that holds jobs and parts. */
  private readonly bucketName: string

  /**
   * Creates the store.
   *
   * @param options - S3 client and bucket.
   */
  constructor(options: S3AuditExportStoreOptions) {
    this.client = options.client
    this.bucketName = options.bucketName
  }

  /**
   * Creates a job document unless one already exists.
   *
   * @param job - New job state.
   * @returns `created`, or `exists` when the ID is taken.
   */
  async createJob(job: AuditExportJob): Promise<'created' | 'exists'> {
    try {
      await this.client.send(this.putJobCommand(job, { IfNoneMatch: '*' }))
      return 'created'
    } catch (error) {
      if (isConditionalWriteFailure(error)) return 'exists'
      throw error
    }
  }

  /**
   * Reads one job document and its ETag.
   *
   * @param workspaceId - Workspace that owns the job.
   * @param exportId - Export identifier.
   * @returns The job and version, or undefined when missing.
   */
  async readJob(workspaceId: string, exportId: string): Promise<StoredAuditExportJob | undefined> {
    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucketName,
        Key: jobKey(workspaceId, exportId),
      }))
      const text = await response.Body?.transformToString('utf-8')
      if (text === undefined || !response.ETag) {
        throw new TypeError('Audit export job storage returned an incomplete object.')
      }
      const parsed: unknown = JSON.parse(text)
      return { job: parseAuditExportJob(parsed), version: response.ETag }
    } catch (error) {
      if (isMissingObject(error)) return undefined
      throw error
    }
  }

  /**
   * Replaces a job document when its ETag still matches.
   *
   * @param job - Next job state.
   * @param expectedVersion - ETag read before computing the state.
   * @returns Whether the replacement was applied.
   */
  async replaceJob(job: AuditExportJob, expectedVersion: string): Promise<boolean> {
    try {
      await this.client.send(this.putJobCommand(job, { IfMatch: expectedVersion }))
      return true
    } catch (error) {
      if (isConditionalWriteFailure(error)) return false
      throw error
    }
  }

  /**
   * Lists the newest jobs of a Workspace.
   *
   * @param workspaceId - Workspace that owns the jobs.
   * @param limit - Maximum number of jobs.
   * @returns Jobs ordered from newest to oldest.
   */
  async listJobs(workspaceId: string, limit: number): Promise<AuditExportJob[]> {
    const prefix = createAuditExportWorkspacePrefix(workspaceId)
    const exportIds: string[] = []
    let continuationToken: string | undefined
    do {
      const response = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: prefix,
        Delimiter: '/',
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }))
      for (const common of response.CommonPrefixes ?? []) {
        const exportId = common.Prefix?.slice(prefix.length).replace(/\/$/u, '')
        if (exportId && /^[0-9a-f]{32}$/u.test(exportId)) exportIds.push(exportId)
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
    } while (continuationToken && exportIds.length < AUDIT_EXPORT_LIST_SCAN_LIMIT)

    const jobs = await Promise.all(
      exportIds.slice(0, AUDIT_EXPORT_LIST_SCAN_LIMIT).map(async (exportId) =>
        (await this.readJob(workspaceId, exportId))?.job
      ),
    )
    return jobs
      .filter((job): job is AuditExportJob => job !== undefined)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
  }

  /**
   * Writes one NDJSON part with an S3-verified checksum.
   *
   * @param workspaceId - Workspace that owns the job.
   * @param exportId - Export identifier.
   * @param index - One-based part number.
   * @param body - NDJSON content.
   * @returns The stored key, size, and hex digest.
   */
  async putPart(workspaceId: string, exportId: string, index: number, body: string) {
    if (!Number.isSafeInteger(index) || index < 1 || index > 99_999) {
      throw new RangeError('Audit export part index is out of range.')
    }
    const bytes = new TextEncoder().encode(body)
    const digest = createHash('sha256').update(bytes).digest()
    const key = `${createAuditExportWorkspacePrefix(workspaceId)}${exportId}/part-${String(index).padStart(5, '0')}.ndjson`
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: bytes,
      ContentLength: bytes.byteLength,
      ContentType: 'application/x-ndjson; charset=utf-8',
      ChecksumSHA256: digest.toString('base64'),
      ServerSideEncryption: 'AES256',
    }))
    return { key, byteLength: bytes.byteLength, sha256: digest.toString('hex') }
  }

  /**
   * Creates a five-minute download URL for a part.
   *
   * @param part - Part to download.
   * @returns The presigned URL.
   */
  async createPartDownloadUrl(part: AuditExportPart): Promise<string> {
    if (!part.key.startsWith('audit-exports/') || !part.key.endsWith('.ndjson')) {
      throw new TypeError('Audit export part key is outside the export namespace.')
    }
    return await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: part.key,
        ResponseContentDisposition:
          `attachment; filename="mukuroji-audit-part-${String(part.index).padStart(5, '0')}.ndjson"`,
      }),
      { expiresIn: AUDIT_EXPORT_DOWNLOAD_TTL_SECONDS },
    )
  }

  /**
   * Builds the write command for a job document.
   *
   * @param job - Job state to write.
   * @param condition - Creation or replacement precondition.
   * @returns The put command.
   */
  private putJobCommand(
    job: AuditExportJob,
    condition: { readonly IfNoneMatch: '*' } | { readonly IfMatch: string },
  ) {
    return new PutObjectCommand({
      Bucket: this.bucketName,
      Key: jobKey(job.workspaceId, job.exportId),
      Body: JSON.stringify(job),
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
      ...condition,
    })
  }
}

/**
 * Builds the object key of a job document.
 *
 * @param workspaceId - Workspace that owns the job.
 * @param exportId - Export identifier.
 * @returns The job document key.
 */
function jobKey(workspaceId: string, exportId: string) {
  if (!/^[0-9a-f]{32}$/u.test(exportId)) {
    throw new TypeError('Audit export identifiers must be 32 lowercase hexadecimal digits.')
  }
  return `${createAuditExportWorkspacePrefix(workspaceId)}${exportId}/job.json`
}

/**
 * Reads the error name and HTTP status of an AWS SDK failure.
 *
 * @param error - Unknown thrown value.
 * @returns The name and status when present.
 */
function readAwsFailure(error: unknown) {
  if (typeof error !== 'object' || error === null) return {}
  const name: unknown = Reflect.get(error, 'name')
  const metadata: unknown = Reflect.get(error, '$metadata')
  const status: unknown = typeof metadata === 'object' && metadata !== null
    ? Reflect.get(metadata, 'httpStatusCode')
    : undefined
  return {
    name: typeof name === 'string' ? name : undefined,
    status: typeof status === 'number' ? status : undefined,
  }
}

/**
 * Checks whether a conditional write lost a race or found an existing object.
 *
 * @param error - Unknown thrown value.
 * @returns `true` for precondition and conditional-request conflicts.
 */
function isConditionalWriteFailure(error: unknown) {
  const { name, status } = readAwsFailure(error)
  return name === 'PreconditionFailed' || name === 'ConditionalRequestConflict' || status === 412 || status === 409
}

/**
 * Checks whether a read found no object.
 *
 * @param error - Unknown thrown value.
 * @returns `true` when the object does not exist.
 */
function isMissingObject(error: unknown) {
  const { name, status } = readAwsFailure(error)
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404
}
