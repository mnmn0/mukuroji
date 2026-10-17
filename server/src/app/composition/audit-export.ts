import { S3Client } from '@aws-sdk/client-s3'
import { createSqsClient } from '../../infrastructure/aws/sqs-client'
import {
  loadServerConfig,
  readServerEnvironment,
  type ServerEnvironment,
} from '../../infrastructure/config/server-config'
import { S3AuditExportStore } from '../../modules/audit/adapter-out/s3/s3-audit-export-store'
import { SqsAuditExportQueue } from '../../modules/audit/adapter-out/sqs/sqs-audit-export-queue'
import {
  createAuditExportService,
  type AuditExportEventCounter,
  type AuditExportEventReader,
  type AuditExportService,
} from '../../modules/audit/audit-export'

/**
 * Creates the audit export service when its bucket and queue are configured.
 *
 * @param events - Audit event reader shared with the synchronous API, and the consistent
 * counter that verifies a finished scan.
 * @param environment - Runtime environment that names the bucket and queue.
 * @param isTenantActive - Optional tenant lifecycle check used by worker steps.
 * @returns The service, or undefined when asynchronous export is not deployed.
 */
export function createConfiguredAuditExportService(
  events: {
    /** Index-backed reader shared with the synchronous API. */
    readonly readEvents: AuditExportEventReader
    /** Strongly consistent base-table counter. */
    readonly countEvents: AuditExportEventCounter
  },
  environment: ServerEnvironment = readServerEnvironment(),
  isTenantActive?: (workspaceId: string) => Promise<boolean>,
): AuditExportService | undefined {
  const bucketName = environment.AUDIT_EXPORT_BUCKET_NAME?.trim()
  const queueUrl = environment.AUDIT_EXPORT_QUEUE_URL?.trim()
  if (!bucketName || !queueUrl) return undefined
  return createAuditExportService({
    store: new S3AuditExportStore({
      client: new S3Client({ region: loadServerConfig(environment).awsRegion }),
      bucketName,
    }),
    queue: new SqsAuditExportQueue(createSqsClient(), queueUrl),
    readEvents: events.readEvents,
    countEvents: events.countEvents,
    ...(isTenantActive ? { isTenantActive } : {}),
  })
}
