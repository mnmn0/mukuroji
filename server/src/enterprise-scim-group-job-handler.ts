import type {
  BatchResponse,
  DynamoStreamEvent,
  DynamoStreamRecord,
} from './collaboration-projection-handler'
import type {
  EnterpriseScimGroupJobReference,
} from './enterprise-scim-group-job-reference'

export type {
  EnterpriseScimGroupJobReference,
} from './enterprise-scim-group-job-reference'

const ENTERPRISE_SCIM_GROUP_JOB_ENTRY_TYPE = 'enterprise-scim-group-job'
const ENTERPRISE_SCIM_GROUP_JOB_RECORD_KEY_PREFIX = 'SCIM_GROUP_JOB#'

/**
 * Enterprise SCIM group reconciliation job processor の dependency です。
 */
export type EnterpriseScimGroupJobProcessor = {
  /** Durable state を一度読み、一つの bounded job page を処理します。 */
  processJob(reference: EnterpriseScimGroupJobReference): Promise<unknown>
}

/**
 * DynamoDB source discriminator を含む Enterprise SCIM job stream record です。
 */
export type EnterpriseScimGroupJobStreamRecord = DynamoStreamRecord & {
  /** AWS Lambda event source の canonical service identifier です。 */
  eventSource?: string
}

/**
 * Enterprise SCIM group job を配送する DynamoDB Stream event です。
 */
export type EnterpriseScimGroupJobStreamEvent = Omit<DynamoStreamEvent, 'Records'> & {
  /** 同じ batch で配送された stream records です。 */
  Records?: EnterpriseScimGroupJobStreamRecord[]
}

/**
 * Lambda event が DynamoDB Stream 由来かどうかを判定します。
 */
export function isEnterpriseScimGroupJobStreamEvent(
  value: unknown,
): value is EnterpriseScimGroupJobStreamEvent {
  if (!isRecord(value) || !Array.isArray(value.Records)) return false
  return value.Records.some((record) =>
    isRecord(record) && record.eventSource === 'aws:dynamodb'
  )
}

/**
 * Enterprise SCIM group job stream batch を record 単位で処理します。
 */
export async function processEnterpriseScimGroupJobBatch(
  event: EnterpriseScimGroupJobStreamEvent,
  processor: EnterpriseScimGroupJobProcessor,
): Promise<BatchResponse> {
  for (const record of event.Records ?? []) {
    try {
      const reference = readEnterpriseScimGroupJobReference(record)
      if (reference) await processor.processJob(reference)
    } catch (error) {
      console.error('Enterprise SCIM group reconciliation failed:', error)
      const sequenceNumber = record.dynamodb?.SequenceNumber
      if (!sequenceNumber) throw error
      return {
        batchItemFailures: [{ itemIdentifier: sequenceNumber }],
      }
    }
  }
  return { batchItemFailures: [] }
}

/**
 * Strictly validated INSERT/MODIFY record から durable job reference を返します。
 *
 * @remarks
 * 別 source・REMOVE・別 entry type は対象外として無視します。Job entry を名乗る
 * record の key または revision が不正な場合は、破損を DLQ で検知できるよう例外にします。
 */
export function readEnterpriseScimGroupJobReference(
  record: EnterpriseScimGroupJobStreamRecord,
): EnterpriseScimGroupJobReference | undefined {
  if (
    record.eventSource !== 'aws:dynamodb' ||
    record.eventName !== 'INSERT' && record.eventName !== 'MODIFY'
  ) {
    return undefined
  }
  const image = record.dynamodb?.NewImage
  if (image?.entryType?.S !== ENTERPRISE_SCIM_GROUP_JOB_ENTRY_TYPE) {
    return undefined
  }

  const workspaceId = readCanonicalIdentifier(image.workspaceId?.S)
  const jobId = readCanonicalIdentifier(image.jobId?.S)
  const revision = readPositiveSafeInteger(image.revision?.N)
  if (
    workspaceId === undefined ||
    jobId === undefined ||
    revision === undefined ||
    image.scopeKey?.S !== `WORKSPACE#${workspaceId}` ||
    image.recordKey?.S !== `${ENTERPRISE_SCIM_GROUP_JOB_RECORD_KEY_PREFIX}${jobId}`
  ) {
    throw new Error('Enterprise SCIM group job stream record is invalid.')
  }

  return { workspaceId, jobId, revision }
}

function readCanonicalIdentifier(value: string | undefined) {
  if (!value || value.trim() !== value) return undefined
  return value
}

function readPositiveSafeInteger(value: string | undefined) {
  if (!value || !/^[1-9]\d*$/u.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
