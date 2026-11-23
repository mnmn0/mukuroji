import { createHash, randomUUID } from 'node:crypto'
import type {
  ApiProblem,
  CreateWorkItemInput,
  ImportDryRunReport,
  ImportFieldMapping,
  ImportReport,
  WorkItemScheduleCalendarPolicy,
} from '@mukuroji/contracts'
import { WORK_ITEM_IMPORT_MAX_BYTES } from './work-item-transfer'
import type { WorkItemImportLink } from './work-item-import-structure'
import { isRecord } from '../../infrastructure/runtime/value-guards'

/** Import source object を自動削除するまでの既定日数です。 */
export const WORK_ITEM_IMPORT_SOURCE_RETENTION_DAYS = 15

/** Import DLQ message を原因調査できる保持日数です。 */
export const WORK_ITEM_IMPORT_DLQ_RETENTION_DAYS = 14

/** SQS が message を DLQ へ移す前に worker が許可する最大受信回数です。 */
export const WORK_ITEM_IMPORT_MAX_RECEIVE_COUNT = 5

/** Import worker lease の既定秒数です。 */
export const WORK_ITEM_IMPORT_LEASE_SECONDS = 20 * 60

/**
 * Seconds one worker invocation spends on rows and links before it hands the rest of the job to
 * a new queue message. It leaves the 15-minute Lambda timeout room for the step that is running.
 */
export const WORK_ITEM_IMPORT_SLICE_SECONDS = 10 * 60

const storedImportErrorLimit = 100
const storedImportErrorCodeLength = 128
const storedImportErrorMessageLength = 512
const storedImportErrorFieldLength = 128

/** Durable import execution の lifecycle 状態です。 */
export type WorkItemImportExecutionStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** S3 に保存した immutable import source locator です。 */
export type WorkItemImportSourceLocator = {
  /** Source object を保存した bucket 名です。 */
  bucketName: string
  /** Tenant/job/hash から決定的に作った object key です。 */
  objectKey: string
  /** Versioning 有効 bucket が返した immutable version ID です。 */
  objectVersionId: string
  /** UTF-8 source bytes の lowercase SHA-256 です。 */
  sha256: string
  /** UTF-8 source の byte 数です。 */
  byteLength: number
  /** Lifecycle cleanup の予定時刻です。 */
  expiresAt: string
}

/** Worker が再開に利用する durable import execution です。 */
export type WorkItemImportExecution = {
  /** Workspace-scoped import job ID です。 */
  jobId: string
  /** Import 対象 Workspace ID です。 */
  workspaceId: string
  /** Job を作成した Workspace member key です。 */
  createdByUserId: string
  /** Work Item owner Team ID です。 */
  teamId: string
  /** Work Item の既定 assigned Project ID です。 */
  assignedProjectId?: string
  /** Source file format です。 */
  format: 'csv' | 'json'
  /** Job に固定した field mapping です。 */
  mapping: ImportFieldMapping[]
  /**
   * Row の schedule に calendarPolicy がないときに使う、job 作成時の Workspace 稼働カレンダーです。
   * 再試行でも同じ値を使い、row の request digest を変えません。これを持たない古い execution は
   * 既定の policy を使います。
   */
  defaultCalendarPolicy?: WorkItemScheduleCalendarPolicy
  /** Dry-run/source/job metadata を束縛する request digest です。 */
  requestDigest: string
  /** Immutable source locator です。 */
  source: WorkItemImportSourceLocator
  /** 現在の lifecycle 状態です。 */
  status: WorkItemImportExecutionStatus
  /** 最後に durable receipt を記録した1始まりの row 番号です。 */
  checkpointRow: number
  /**
   * Rows and links the worker found when it last validated the source, kept so the progress of a
   * running import can be shown. Absent until a worker validates the source.
   */
  plannedSteps?: WorkItemImportPlannedSteps
  /** Cancel API が cooperative worker に設定する marker です。 */
  cancelRequested: boolean
  /** 現在 lease を所有する invocation ID です。 */
  leaseOwner?: string
  /** 現在 lease の期限です。 */
  leaseExpiresAt?: string
  /** Job 作成時刻です。 */
  createdAt: string
  /** 最終更新時刻です。 */
  updatedAt: string
  /** Terminal metadata/source cleanup 用 TTL epoch seconds です。 */
  expiresAt: number
  /** Completed execution を public ImportJob へ再同期する report です。 */
  terminalReport?: ImportReport
  /** Failed execution を public ImportJob へ再同期する safe problem です。 */
  terminalProblem?: ApiProblem
}

/** Rows and links one import creates, rows first and then links. */
export type WorkItemImportPlannedSteps = {
  /** Source rows, each creating one Work Item. */
  rows: number
  /** Parent, dependency, relation, and acceptance-criteria links applied after every row. */
  links: number
}

/** 完了した1 row の deterministic receipt です。 */
export type WorkItemImportRowReceipt = {
  /** Workspace-scoped job ID です。 */
  jobId: string
  /** 1始まりの source row 番号です。 */
  row: number
  /** Row input と execution identity の SHA-256 です。 */
  requestDigest: string
  /** Canonical create に渡した deterministic idempotency key です。 */
  idempotencyKey: string
  /** Receipt 記録時刻です。 */
  completedAt: string
}

/** SQS に載せる secret-free import locator です。 */
export type WorkItemImportQueueMessage = {
  /** Import 対象 Workspace ID です。 */
  workspaceId: string
  /** Durable import job ID です。 */
  jobId: string
}

/** SQS Lambda event の最小 record 表現です。 */
export type WorkItemImportSqsRecord = {
  /** Partial batch failure で返す message ID です。 */
  messageId?: string
  /** JSON serialized secret-free locator です。 */
  body?: string
  /** SQS system attributes です。 */
  attributes?: {
    /** Redrive 判定に利用する受信回数です。 */
    ApproximateReceiveCount?: string
  }
}

/** SQS Lambda event の最小表現です。 */
export type WorkItemImportSqsEvent = {
  /** 同じ batch に含まれる queue records です。 */
  Records?: WorkItemImportSqsRecord[]
}

/** Lambda partial batch response の1 failure です。 */
export type WorkItemImportBatchItemFailure = {
  /** 再試行する SQS message ID です。 */
  itemIdentifier: string
}

/** Import worker の partial batch response です。 */
export type WorkItemImportBatchResponse = {
  /** 再試行する records です。 */
  batchItemFailures: WorkItemImportBatchItemFailure[]
}

/** API が durable import を stage する入力です。 */
export type StageWorkItemImportRequest = {
  /** Deterministic import job ID です。 */
  jobId: string
  /** Import 対象 Workspace ID です。 */
  workspaceId: string
  /** Job を開始した Workspace member key です。 */
  createdByUserId: string
  /** Import 先 Team ID です。 */
  teamId: string
  /** Import 先の既定 Project ID です。 */
  assignedProjectId?: string
  /** Source file format です。 */
  format: 'csv' | 'json'
  /** UTF-8 source 本文です。 */
  sourceContent: string
  /** Dry-run 済み field mapping です。 */
  mapping: ImportFieldMapping[]
  /** Execution に固定する Workspace 稼働カレンダーです。既存 execution の値は置き換えません。 */
  defaultCalendarPolicy?: WorkItemScheduleCalendarPolicy
  /** API idempotency fingerprint です。原文 key は保存しません。 */
  requestFingerprint: string
}

/** Immutable source storage の書き込み入力です。 */
export type PutWorkItemImportSourceRequest = {
  /** Import 対象 Workspace ID です。 */
  workspaceId: string
  /** Import job ID です。 */
  jobId: string
  /** UTF-8 source 本文です。 */
  content: string
  /** Source bytes の SHA-256 です。 */
  sha256: string
  /** Source bytes 数です。 */
  byteLength: number
  /** Cleanup 予定時刻です。 */
  expiresAt: string
}

/** Immutable import source storage 境界です。 */
export interface WorkItemImportSourceStore {
  /** Source を immutable encrypted object として保存します。 */
  putImmutable(
    request: PutWorkItemImportSourceRequest,
  ): Promise<WorkItemImportSourceLocator>
  /** Version ID を固定して source を取得し、digest と size を検証します。 */
  getVerified(
    locator: WorkItemImportSourceLocator,
    expected: WorkItemImportSourceOwner,
  ): Promise<string>
  /** Terminal job の immutable source version を削除します。 */
  deleteVersion(
    locator: WorkItemImportSourceLocator,
    expected: WorkItemImportSourceOwner,
  ): Promise<void>
}

/** Source locator を tenant/job identity に束縛する expected owner です。 */
export type WorkItemImportSourceOwner = {
  /** Expected Workspace ID です。 */
  workspaceId: string
  /** Expected import job ID です。 */
  jobId: string
}

/** Durable import execution/receipt store 境界です。 */
export interface WorkItemImportExecutionStore {
  /** Execution を if-absent で作成し、retry 時は同一 request だけ再利用します。 */
  createOrGet(execution: WorkItemImportExecution): Promise<WorkItemImportExecution>
  /** Execution を strong-consistent read します。 */
  get(workspaceId: string, jobId: string): Promise<WorkItemImportExecution | undefined>
  /** Stale lease の takeover を許可して worker lease を取得します。 */
  claim(
    workspaceId: string,
    jobId: string,
    leaseOwner: string,
    leaseExpiresAt: string,
    now: string,
  ): Promise<WorkItemImportExecution | undefined>
  /** Retry を早く再開できるよう現在 worker の lease を解放します。 */
  releaseClaim(workspaceId: string, jobId: string, leaseOwner: string): Promise<void>
  /** Current lease owner だけが、validation で数えた row と link の数を保存できます。 */
  recordPlannedSteps(
    workspaceId: string,
    jobId: string,
    leaseOwner: string,
    plannedSteps: WorkItemImportPlannedSteps,
  ): Promise<void>
  /** Row receipt と monotonically increasing checkpoint を原子的に保存します。 */
  recordRowReceipt(
    workspaceId: string,
    jobId: string,
    leaseOwner: string,
    receipt: WorkItemImportRowReceipt,
    leaseExpiresAt: string,
  ): Promise<'created' | 'existing'>
  /** Cancel request を durable state に反映します。 */
  requestCancellation(
    workspaceId: string,
    jobId: string,
    now: string,
  ): Promise<WorkItemImportExecution>
  /** Current lease owner だけが completed execution/report を保存できます。 */
  markCompletedIfClaimed(
    workspaceId: string,
    jobId: string,
    leaseOwner: string,
    report: ImportReport,
    now: string,
  ): Promise<boolean>
  /** Current lease owner だけが retry exhaustion を terminal failure にできます。 */
  markFailedIfClaimed(
    workspaceId: string,
    jobId: string,
    leaseOwner: string,
    problem: ApiProblem,
    report: ImportReport | undefined,
    now: string,
  ): Promise<boolean>
}

/** Durable import queue 境界です。 */
export interface WorkItemImportQueue {
  /** Secret-free job locator を enqueue します。 */
  enqueue(message: WorkItemImportQueueMessage): Promise<void>
}

/** Worker validation が返す row と report です。 */
export type WorkItemImportValidationResult = {
  /** Current RBAC/configuration での dry-run report です。 */
  report: ImportDryRunReport
  /** Input 順の valid canonical create inputs です。 */
  rows: Array<{
    /** Source の1始まり row 番号です。 */
    row: number
    /** Current configuration で検証済み create input です。 */
    input: CreateWorkItemInput
  }>
  /** 全 row の作成後に適用順に付ける親子・依存・relation・受け入れ条件です。 */
  links?: WorkItemImportLink[]
}

/** Worker が全 row の作成後に1つの link を付ける入力です。 */
export type ApplyImportedWorkItemLinkRequest = {
  /** Durable execution です。 */
  execution: WorkItemImportExecution
  /** 付ける link です。 */
  link: WorkItemImportLink
  /** Retry でも同じになる link の identity です。 */
  linkIdentity: string
  /** Source row に対して作成した Work Item ID を返します。 */
  workItemIdForRow: (row: number) => string
}

/** Worker が1 row を作成する入力です。 */
export type CreateImportedWorkItemRequest = {
  /** Durable execution です。 */
  execution: WorkItemImportExecution
  /** 1始まりの source row 番号です。 */
  row: number
  /** 検証済み canonical input です。 */
  input: CreateWorkItemInput
  /** Retry で同一になる idempotency key です。 */
  idempotencyKey: string
  /** Retry で同一になる public Work Item ID seed です。 */
  workItemId: string
  /** Execution/row/input を束縛する deterministic request digest です。 */
  requestDigest: string
}

/** Public ImportJob metadata との同期境界です。 */
export interface WorkItemImportJobLifecycle {
  /** Queued job を running にします。既に running なら成功扱いにします。 */
  markRunning(execution: WorkItemImportExecution): Promise<void>
  /** 完了 report を公開 Job に保存します。 */
  markCompleted(
    execution: WorkItemImportExecution,
    report: ImportReport,
  ): Promise<void>
  /** Redact 済み problem と optional row report を公開 Job に保存します。 */
  markFailed(
    execution: WorkItemImportExecution,
    problem: ApiProblem,
    report?: ImportReport,
  ): Promise<void>
  /** Cooperative cancellation を公開 Job に保存します。 */
  markCancelled(execution: WorkItemImportExecution): Promise<void>
}

/** Import worker の注入可能 dependencies です。 */
export type WorkItemImportWorkerDependencies = {
  /** Durable execution/receipt store です。 */
  executions: WorkItemImportExecutionStore
  /** Immutable source storage です。 */
  sources: WorkItemImportSourceStore
  /** Public ImportJob lifecycle gateway です。 */
  jobs: WorkItemImportJobLifecycle
  /** Creator/Team/Project の current RBAC を再評価します。 */
  authorize(execution: WorkItemImportExecution): Promise<void>
  /** Tenant lifecycle と Developer Platform entitlement を再評価します。 */
  assertTenantEnabled(execution: WorkItemImportExecution): Promise<void>
  /** Current RBAC/configuration で source を再検証します。 */
  validate(
    execution: WorkItemImportExecution,
    sourceContent: string,
  ): Promise<WorkItemImportValidationResult>
  /** Deterministic identity で canonical Work Item を作成します。 */
  createWorkItem(request: CreateImportedWorkItemRequest): Promise<void>
  /** 作成済みの Work Item 間に link を付けます。既にある link はそのままにします。 */
  applyLink(request: ApplyImportedWorkItemLinkRequest): Promise<void>
  /** Lease/receipt timestamp を決める clock です。 */
  now(): Date
  /** Invocation ごとに一意な lease owner を作ります。 */
  createLeaseOwner(): string
  /** Queue that receives the next slice of a job that ran out of its slice time. */
  queue: WorkItemImportQueue
}

/** Durable import API staging の dependencies です。 */
export type StageWorkItemImportDependencies = {
  /** Durable execution store です。 */
  executions: WorkItemImportExecutionStore
  /** Immutable encrypted source storage です。 */
  sources: WorkItemImportSourceStore
  /** Secret-free SQS queue です。 */
  queue: WorkItemImportQueue
  /** Source retention timestamp を決める clock です。 */
  now(): Date
}

/** Import source/job mismatch などの stable domain error です。 */
export class WorkItemImportError extends Error {
  /** API/worker が分岐する stable code です。 */
  readonly code: string
  /** Retry で回復する可能性があるかどうかです。 */
  readonly retryable: boolean

  /** Stable import error を作成します。 */
  constructor(code: string, message: string, retryable = false, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorkItemImportError'
    this.code = code
    this.retryable = retryable
  }
}

/** Retryable failure と、その時点で所有していた worker lease です。 */
class ClaimedWorkItemImportError extends Error {
  /** Claim 済み execution です。 */
  readonly execution: WorkItemImportExecution
  /** Failure 発生時の lease owner です。 */
  readonly leaseOwner: string

  /** Retryable failure を current claim に束縛します。 */
  constructor(execution: WorkItemImportExecution, leaseOwner: string, options: ErrorOptions) {
    super('Claimed Work Item import processing failed.', options)
    this.name = 'ClaimedWorkItemImportError'
    this.execution = execution
    this.leaseOwner = leaseOwner
  }
}

/** API idempotency key から tenant/actor-scoped deterministic job ID を作成します。 */
export function createWorkItemImportJobId(
  workspaceId: string,
  createdByUserId: string,
  idempotencyKey: string,
) {
  const digest = createHash('sha256')
    .update(`work-item-import-v1\n${workspaceId}\n${createdByUserId}\n${idempotencyKey}`)
    .digest('hex')
  return `import_${digest.slice(0, 48)}`
}

/** Validated source を immutable storage/DynamoDB/SQS に stage します。 */
export async function stageWorkItemImport(
  request: StageWorkItemImportRequest,
  dependencies: StageWorkItemImportDependencies,
): Promise<WorkItemImportExecution> {
  const sourceBytes = new TextEncoder().encode(request.sourceContent)
  if (sourceBytes.byteLength > WORK_ITEM_IMPORT_MAX_BYTES) {
    throw new WorkItemImportError(
      'ImportPayloadTooLarge',
      `Import data cannot exceed ${WORK_ITEM_IMPORT_MAX_BYTES} bytes.`,
    )
  }
  const now = dependencies.now()
  const sha256 = createHash('sha256').update(sourceBytes).digest('hex')
  const expiresAtDate = new Date(
    now.getTime() + WORK_ITEM_IMPORT_SOURCE_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
  )
  const requestDigest = createHash('sha256')
    .update(stableStringify({
      workspaceId: request.workspaceId,
      createdByUserId: request.createdByUserId,
      teamId: request.teamId,
      assignedProjectId: request.assignedProjectId,
      format: request.format,
      mapping: request.mapping,
      sourceSha256: sha256,
      requestFingerprint: request.requestFingerprint,
    }))
    .digest('hex')
  let existing: WorkItemImportExecution | undefined
  try {
    existing = await dependencies.executions.get(request.workspaceId, request.jobId)
  } catch (error) {
    throw asRetryableStagingError(error, 'ImportExecutionStoreUnavailable')
  }
  if (existing) {
    if (existing.requestDigest !== requestDigest) {
      throw new WorkItemImportError(
        'ImportIdempotencyConflict',
        'The import job ID is already bound to different source or metadata.',
      )
    }
    if (existing.status === 'queued' || existing.status === 'running') {
      await enqueueImportBestEffort(existing, dependencies.queue)
    }
    return existing
  }
  let source: WorkItemImportSourceLocator
  try {
    source = await dependencies.sources.putImmutable({
      workspaceId: request.workspaceId,
      jobId: request.jobId,
      content: request.sourceContent,
      sha256,
      byteLength: sourceBytes.byteLength,
      expiresAt: expiresAtDate.toISOString(),
    })
  } catch (error) {
    throw asRetryableStagingError(error, 'ImportSourceStoreUnavailable')
  }
  const sourceExpiry = Date.parse(source.expiresAt)
  const minimumSourceExpiry = now.getTime() +
    WORK_ITEM_IMPORT_DLQ_RETENTION_DAYS * 24 * 60 * 60 * 1_000
  if (!Number.isFinite(sourceExpiry) || sourceExpiry < minimumSourceExpiry) {
    throw new WorkItemImportError(
      'ImportSourceRetentionInvalid',
      'Import source storage did not provide the required durable retention window.',
      true,
    )
  }
  let execution: WorkItemImportExecution
  try {
    execution = await dependencies.executions.createOrGet({
      jobId: request.jobId,
      workspaceId: request.workspaceId,
      createdByUserId: request.createdByUserId,
      teamId: request.teamId,
      ...(request.assignedProjectId ? { assignedProjectId: request.assignedProjectId } : {}),
      format: request.format,
      mapping: structuredClone(request.mapping),
      ...(request.defaultCalendarPolicy
        ? { defaultCalendarPolicy: structuredClone(request.defaultCalendarPolicy) }
        : {}),
      requestDigest,
      source,
      status: 'queued',
      checkpointRow: 0,
      cancelRequested: false,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: Math.floor(sourceExpiry / 1_000),
    })
  } catch (error) {
    throw asRetryableStagingError(error, 'ImportExecutionStoreUnavailable')
  }
  if (execution.requestDigest !== requestDigest) {
    throw new WorkItemImportError(
      'ImportIdempotencyConflict',
      'The import job ID is already bound to different source or metadata.',
    )
  }
  if (execution.status === 'queued' || execution.status === 'running') {
    await enqueueImportBestEffort(execution, dependencies.queue)
  }
  return execution
}

/** Import queue batch を処理し、失敗した message だけを再試行します。 */
export async function processWorkItemImportBatch(
  event: WorkItemImportSqsEvent,
  dependencies: WorkItemImportWorkerDependencies,
): Promise<WorkItemImportBatchResponse> {
  const results = await Promise.all((event.Records ?? []).map(async (record) => {
    try {
      await processQueueRecord(record, dependencies)
      return undefined
    } catch (error) {
      const receiveCount = readReceiveCount(record)
      if (error instanceof ClaimedWorkItemImportError) {
        if (receiveCount >= WORK_ITEM_IMPORT_MAX_RECEIVE_COUNT) {
          await markRetryExhausted(error, dependencies)
        } else {
          await dependencies.executions.releaseClaim(
            error.execution.workspaceId,
            error.execution.jobId,
            error.leaseOwner,
          )
        }
      }
      return { itemIdentifier: readMessageId(record) }
    }
  }))
  return { batchItemFailures: results.filter(isDefined) }
}

/** Durable/public job に保存できる bounded report へ明示的に投影します。 */
export function createStoredWorkItemImportReport(report: ImportReport): ImportReport {
  return {
    totalRows: report.totalRows,
    validRows: report.validRows,
    invalidRows: report.invalidRows,
    errors: report.errors.slice(0, storedImportErrorLimit).map((error) => ({
      row: error.row,
      code: error.code.slice(0, storedImportErrorCodeLength),
      message: error.message.slice(0, storedImportErrorMessageLength),
      ...(error.field
        ? { field: error.field.slice(0, storedImportErrorFieldLength) }
        : {}),
    })),
  }
}

/** Cooperative cancel marker を設定し、未開始 job の source を cleanup します。 */
export async function requestWorkItemImportCancellation(
  workspaceId: string,
  jobId: string,
  dependencies: Pick<WorkItemImportWorkerDependencies, 'executions' | 'sources' | 'jobs' | 'now'>,
) {
  const execution = await dependencies.executions.requestCancellation(
    workspaceId,
    jobId,
    dependencies.now().toISOString(),
  )
  await reconcileTerminalExecution(execution, dependencies.jobs)
  await deleteSourceBestEffort(execution, dependencies.sources)
  return execution
}

async function processQueueRecord(
  record: WorkItemImportSqsRecord,
  dependencies: WorkItemImportWorkerDependencies,
) {
  const message = readQueueMessage(record.body)
  const existing = await dependencies.executions.get(message.workspaceId, message.jobId)
  if (!existing) return
  if (isTerminal(existing.status)) {
    await reconcileTerminalExecution(existing, dependencies.jobs)
    await deleteSourceBestEffort(existing, dependencies.sources)
    return
  }
  if (existing.cancelRequested) {
    const cancelled = await dependencies.executions.requestCancellation(
      existing.workspaceId,
      existing.jobId,
      dependencies.now().toISOString(),
    )
    await reconcileTerminalExecution(cancelled, dependencies.jobs)
    await deleteSourceBestEffort(cancelled, dependencies.sources)
    return
  }

  const leaseOwner = dependencies.createLeaseOwner()
  const claimedAt = dependencies.now()
  const leaseExpiresAt = addSeconds(claimedAt, WORK_ITEM_IMPORT_LEASE_SECONDS).toISOString()
  const execution = await dependencies.executions.claim(
    message.workspaceId,
    message.jobId,
    leaseOwner,
    leaseExpiresAt,
    claimedAt.toISOString(),
  )
  if (!execution) return

  let validation: WorkItemImportValidationResult | undefined
  let checkpointRow = execution.checkpointRow
  let processingRow: number | undefined
  // A link step reports the source row it belongs to, not its receipt number.
  let processingReportRow: number | undefined
  try {
    await dependencies.assertTenantEnabled(execution)
    await dependencies.jobs.markRunning(execution)
    await dependencies.authorize(execution)
    const sourceContent = await dependencies.sources.getVerified(execution.source, execution)
    validation = await dependencies.validate(execution, sourceContent)
    if (!validation.report.valid) {
      await failExecution(
        execution,
        dependencies,
        createProblem(
          execution.jobId,
          'validation_failed',
          'Import source no longer passes current permission or configuration validation.',
          false,
        ),
        leaseOwner,
        createStoredWorkItemImportReport(validation.report),
      )
      return
    }
    assertValidationRows(validation)
    const plannedSteps = {
      rows: validation.report.totalRows,
      links: validation.links?.length ?? 0,
    }
    if (
      execution.plannedSteps?.rows !== plannedSteps.rows ||
      execution.plannedSteps.links !== plannedSteps.links
    ) {
      await dependencies.executions.recordPlannedSteps(
        execution.workspaceId,
        execution.jobId,
        leaseOwner,
        plannedSteps,
      )
    }
    const sliceDeadline = addSeconds(claimedAt, WORK_ITEM_IMPORT_SLICE_SECONDS).getTime()
    const sliceStartCheckpoint = checkpointRow
    /**
     * Hands the rest of the job to a new queue message once this invocation's slice time is used.
     * The lease is released first, so the next invocation can claim the job at once. An invocation
     * that has not recorded a step yet keeps going, so every slice moves the job forward. When the
     * next message cannot be queued, the lease is claimed again so this message's retry, or its
     * retry exhaustion, still owns the job.
     *
     * @returns Whether this invocation stops here.
     */
    const yieldWhenSliceEnds = async () => {
      if (checkpointRow === sliceStartCheckpoint) return false
      if (dependencies.now().getTime() < sliceDeadline) return false
      await dependencies.executions.releaseClaim(execution.workspaceId, execution.jobId, leaseOwner)
      try {
        await dependencies.queue.enqueue({
          workspaceId: execution.workspaceId,
          jobId: execution.jobId,
        })
      } catch (error) {
        const reclaimedAt = dependencies.now()
        const reclaimed = await dependencies.executions.claim(
          execution.workspaceId,
          execution.jobId,
          leaseOwner,
          addSeconds(reclaimedAt, WORK_ITEM_IMPORT_LEASE_SECONDS).toISOString(),
          reclaimedAt.toISOString(),
        )
        // Another invocation already holds the job, so it continues the import.
        if (!reclaimed) return true
        throw error
      }
      return true
    }

    /** Records one finished step and renews the lease. */
    const recordStep = async (
      current: WorkItemImportExecution,
      row: number,
      requestDigest: string,
      idempotencyKey: string,
    ) => {
      const renewedLease = addSeconds(
        dependencies.now(),
        WORK_ITEM_IMPORT_LEASE_SECONDS,
      ).toISOString()
      await dependencies.executions.recordRowReceipt(
        current.workspaceId,
        current.jobId,
        leaseOwner,
        {
          jobId: current.jobId,
          row,
          requestDigest,
          idempotencyKey,
          completedAt: dependencies.now().toISOString(),
        },
        renewedLease,
      )
      checkpointRow = row
      processingRow = undefined
      processingReportRow = undefined
    }

    for (const item of validation.rows) {
      if (item.row <= checkpointRow) continue
      if (await yieldWhenSliceEnds()) return
      processingRow = item.row
      processingReportRow = item.row
      const current = await readRunnableExecution(execution, dependencies)
      if (!current) return
      const rowIdentity = createRowIdentity(current, item.row, item.input)
      await dependencies.createWorkItem({
        execution: current,
        row: item.row,
        input: item.input,
        idempotencyKey: rowIdentity.idempotencyKey,
        workItemId: rowIdentity.workItemId,
        requestDigest: rowIdentity.requestDigest,
      })
      await recordStep(current, item.row, rowIdentity.requestDigest, rowIdentity.idempotencyKey)
    }
    // Links are applied after every row exists. Their receipts continue the row numbering so the
    // same monotonic checkpoint resumes them after a retry.
    const links = validation.links ?? []
    for (const [index, link] of links.entries()) {
      const step = validation.report.totalRows + index + 1
      if (step <= checkpointRow) continue
      if (await yieldWhenSliceEnds()) return
      processingRow = step
      processingReportRow = readLinkRow(link)
      const current = await readRunnableExecution(execution, dependencies)
      if (!current) return
      const linkIdentity = createLinkIdentity(current, index, link)
      await dependencies.applyLink({
        execution: current,
        link,
        linkIdentity: linkIdentity.identity,
        workItemIdForRow: (row) => createRowWorkItemId(current, row),
      })
      await recordStep(current, step, linkIdentity.requestDigest, linkIdentity.idempotencyKey)
    }
    const completed = await dependencies.executions.markCompletedIfClaimed(
      execution.workspaceId,
      execution.jobId,
      leaseOwner,
      createStoredWorkItemImportReport(validation.report),
      dependencies.now().toISOString(),
    )
    if (!completed) return
    const terminal = await dependencies.executions.get(execution.workspaceId, execution.jobId)
    if (!terminal) throw new Error('Completed import execution could not be reloaded.')
    await reconcileTerminalExecution(terminal, dependencies.jobs)
    await deleteSourceBestEffort(terminal, dependencies.sources)
  } catch (error) {
    if (error instanceof WorkItemImportError && !error.retryable) {
      await failExecution(
        execution,
        dependencies,
        createProblem(
          execution.jobId,
          'validation_failed',
          'Import processing rejected the source or current authorization state.',
          false,
        ),
        leaseOwner,
        createRuntimeFailureReport(
          validation,
          checkpointRow,
          processingRow === undefined ? undefined : processingReportRow ?? processingRow,
          error.code,
        ),
      )
      return
    }
    throw new ClaimedWorkItemImportError(execution, leaseOwner, { cause: error })
  }
}

/**
 * Builds the report of an import that stopped on a row or link.
 *
 * Rows before the checkpoint count as valid. Once every row exists, the checkpoint counts links,
 * so a row whose link was not applied counts as invalid although its Work Item was created.
 *
 * @param validation - Validation the execution ran with, if it got that far.
 * @param checkpointRow - Last recorded step, rows first and then links.
 * @param failedRow - Source row of the step that failed, if any.
 * @param errorCode - Code of the failure.
 * @returns The stored report, or undefined when no step was running.
 */
function createRuntimeFailureReport(
  validation: WorkItemImportValidationResult | undefined,
  checkpointRow: number,
  failedRow: number | undefined,
  errorCode: string,
) {
  if (!validation || failedRow === undefined) return undefined
  const totalRows = validation.report.totalRows
  const rowsWithUnappliedLinks = new Set(
    (validation.links ?? [])
      .filter((_, index) => totalRows + index + 1 > checkpointRow)
      .map(readLinkRow),
  )
  const validRows = checkpointRow < totalRows
    ? Math.max(0, checkpointRow)
    : Math.max(0, totalRows - rowsWithUnappliedLinks.size)
  return createStoredWorkItemImportReport({
    totalRows,
    validRows,
    invalidRows: Math.max(0, totalRows - validRows),
    errors: [
      ...validation.report.errors,
      {
        row: failedRow,
        code: errorCode,
        message: 'The row could not be imported after current access or configuration changed.',
      },
    ],
  })
}

function createRowIdentity(
  execution: WorkItemImportExecution,
  row: number,
  input: CreateWorkItemInput,
) {
  const identity = createRowIdentityDigest(execution, row)
  const requestDigest = createHash('sha256')
    .update(`${identity}\n${stableStringify(input)}`)
    .digest('hex')
  return {
    idempotencyKey: `import-${identity.slice(0, 48)}`,
    workItemId: `import-${identity.slice(0, 48)}`,
    requestDigest,
  }
}

/**
 * Hashes the retry-stable identity of one source row.
 *
 * @param execution - Durable execution.
 * @param row - One-based source row.
 * @returns The hex digest.
 */
function createRowIdentityDigest(execution: WorkItemImportExecution, row: number) {
  return createHash('sha256')
    .update(`work-item-import-row-v1\n${execution.workspaceId}\n${execution.jobId}\n${row}`)
    .digest('hex')
}

/**
 * Returns the Work Item ID that the import creates for one source row.
 *
 * @param execution - Durable execution.
 * @param row - One-based source row.
 * @returns The deterministic Work Item ID.
 */
function createRowWorkItemId(execution: WorkItemImportExecution, row: number) {
  return `import-${createRowIdentityDigest(execution, row).slice(0, 48)}`
}

/**
 * Creates the retry-stable identity of one link.
 *
 * @param execution - Durable execution.
 * @param index - Zero-based position of the link.
 * @param link - Link to apply.
 * @returns The identity, its receipt digest, and its idempotency key.
 */
function createLinkIdentity(execution: WorkItemImportExecution, index: number, link: WorkItemImportLink) {
  const identity = createHash('sha256')
    .update(`work-item-import-link-v1\n${execution.workspaceId}\n${execution.jobId}\n${index}`)
    .digest('hex')
  return {
    identity,
    idempotencyKey: `import-link-${identity.slice(0, 48)}`,
    requestDigest: createHash('sha256').update(`${identity}\n${stableStringify(link)}`).digest('hex'),
  }
}

/**
 * Re-reads the execution before the next step and stops on a terminal state or cancellation.
 *
 * @param execution - Claimed execution.
 * @param dependencies - Worker dependencies.
 * @returns The current execution, or undefined when processing must stop.
 */
async function readRunnableExecution(
  execution: WorkItemImportExecution,
  dependencies: WorkItemImportWorkerDependencies,
) {
  const current = await dependencies.executions.get(execution.workspaceId, execution.jobId)
  if (!current) {
    throw new WorkItemImportError(
      'ImportExecutionUnavailable',
      'Import execution is temporarily unavailable.',
      true,
    )
  }
  if (isTerminal(current.status)) {
    await reconcileTerminalExecution(current, dependencies.jobs)
    await deleteSourceBestEffort(current, dependencies.sources)
    return undefined
  }
  if (current.cancelRequested) {
    const cancelled = await dependencies.executions.requestCancellation(
      current.workspaceId,
      current.jobId,
      dependencies.now().toISOString(),
    )
    await reconcileTerminalExecution(cancelled, dependencies.jobs)
    await deleteSourceBestEffort(cancelled, dependencies.sources)
    return undefined
  }
  await dependencies.assertTenantEnabled(current)
  await dependencies.authorize(current)
  return current
}

/**
 * Returns the source row a link is reported on.
 *
 * @param link - Link being applied.
 * @returns The child, successor, source, or criteria row.
 */
function readLinkRow(link: WorkItemImportLink) {
  if (link.kind === 'parent') return link.childRow
  if (link.kind === 'dependency') return link.successorRow
  if (link.kind === 'relation') return link.sourceRow
  return link.row
}

function assertValidationRows(validation: WorkItemImportValidationResult) {
  if (validation.rows.length !== validation.report.validRows) {
    throw new WorkItemImportError(
      'ImportValidationInvariantInvalid',
      'Import validation row count is inconsistent.',
    )
  }
  let previous = 0
  for (const row of validation.rows) {
    if (!Number.isSafeInteger(row.row) || row.row <= previous) {
      throw new WorkItemImportError(
        'ImportValidationInvariantInvalid',
        'Import validation rows must be unique and ordered.',
      )
    }
    previous = row.row
  }
}

async function reconcileTerminalExecution(
  execution: WorkItemImportExecution,
  jobs: WorkItemImportJobLifecycle,
) {
  if (execution.status === 'completed') {
    if (!execution.terminalReport) {
      throw new WorkItemImportError(
        'ImportTerminalStateInvalid',
        'Completed import execution has no durable report.',
        true,
      )
    }
    await jobs.markCompleted(execution, execution.terminalReport)
    return
  }
  if (execution.status === 'failed') {
    if (!execution.terminalProblem) {
      throw new WorkItemImportError(
        'ImportTerminalStateInvalid',
        'Failed import execution has no durable problem.',
        true,
      )
    }
    await jobs.markFailed(
      execution,
      execution.terminalProblem,
      execution.terminalReport,
    )
    return
  }
  if (execution.status === 'cancelled') await jobs.markCancelled(execution)
}

async function failExecution(
  execution: WorkItemImportExecution,
  dependencies: Pick<WorkItemImportWorkerDependencies, 'executions' | 'sources' | 'jobs' | 'now'>,
  problem: ApiProblem,
  leaseOwner: string,
  report?: ImportReport,
) {
  const failed = await dependencies.executions.markFailedIfClaimed(
    execution.workspaceId,
    execution.jobId,
    leaseOwner,
    problem,
    report,
    dependencies.now().toISOString(),
  )
  if (!failed) return
  await dependencies.jobs.markFailed(execution, problem, report)
  await deleteSourceBestEffort(execution, dependencies.sources)
}

async function markRetryExhausted(
  failure: ClaimedWorkItemImportError,
  dependencies: WorkItemImportWorkerDependencies,
) {
  const execution = failure.execution
  const problem = createRetryExhaustedProblem(execution)
  const terminalized = await dependencies.executions.markFailedIfClaimed(
    execution.workspaceId,
    execution.jobId,
    failure.leaseOwner,
    problem,
    undefined,
    dependencies.now().toISOString(),
  )
  if (!terminalized) return
  await dependencies.jobs.markFailed(execution, problem)
  await deleteSourceBestEffort(execution, dependencies.sources)
}

function createRetryExhaustedProblem(execution: WorkItemImportExecution) {
  return createProblem(
    execution.jobId,
    'temporarily_unavailable',
    'Import processing failed after all retry attempts.',
    false,
  )
}

function createProblem(
  jobId: string,
  code: 'validation_failed' | 'temporarily_unavailable',
  detail: string,
  retryable: boolean,
): ApiProblem {
  return {
    type: `https://docs.mukuroji.app/problems/${code}`,
    title: code,
    status: code === 'validation_failed' ? 422 : 503,
    code,
    detail,
    requestId: `import-job-${createHash('sha256').update(jobId).digest('hex').slice(0, 16)}`,
    retryable,
  }
}

async function deleteSourceBestEffort(
  execution: WorkItemImportExecution,
  sources: WorkItemImportSourceStore,
) {
  try {
    await sources.deleteVersion(execution.source, execution)
  } catch {
    // Bucket lifecycle is the durable fallback; never surface source identifiers in logs.
  }
}

async function enqueueImportBestEffort(
  execution: WorkItemImportExecution,
  queue: WorkItemImportQueue,
) {
  try {
    await queue.enqueue({ workspaceId: execution.workspaceId, jobId: execution.jobId })
  } catch (error) {
    throw asRetryableStagingError(error, 'ImportQueueUnavailable')
  }
}

function asRetryableStagingError(error: unknown, code: string) {
  if (error instanceof WorkItemImportError) return error
  return new WorkItemImportError(
    code,
    'Import could not be queued because a durable dependency is temporarily unavailable.',
    true,
  )
}

function readQueueMessage(body: string | undefined): WorkItemImportQueueMessage {
  const message = tryReadQueueMessage(body)
  if (!message) {
    throw new WorkItemImportError(
      'ImportQueueMessageInvalid',
      'Import queue message is invalid.',
      true,
    )
  }
  return message
}

function tryReadQueueMessage(body: string | undefined) {
  if (!body) return undefined
  try {
    const value: unknown = JSON.parse(body)
    if (
      !isRecord(value) ||
      !isIdentifier(value.workspaceId) ||
      !isIdentifier(value.jobId) ||
      Object.keys(value).some((key) => key !== 'workspaceId' && key !== 'jobId')
    ) {
      return undefined
    }
    return { workspaceId: value.workspaceId, jobId: value.jobId }
  } catch {
    return undefined
  }
}

function readReceiveCount(record: WorkItemImportSqsRecord) {
  const value = Number(record.attributes?.ApproximateReceiveCount ?? '1')
  return Number.isSafeInteger(value) && value > 0 ? value : 1
}

function readMessageId(record: WorkItemImportSqsRecord) {
  return isIdentifier(record.messageId)
    ? record.messageId
    : `invalid-${createHash('sha256').update(record.body ?? randomUUID()).digest('hex').slice(0, 24)}`
}

function isTerminal(status: WorkItemImportExecutionStatus) {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function addSeconds(value: Date, seconds: number) {
  return new Date(value.getTime() + seconds * 1_000)
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 512
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}
