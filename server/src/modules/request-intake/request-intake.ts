import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb'
import { S3Client } from '@aws-sdk/client-s3'
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  REQUEST_FORM_SCHEMA_VERSION,
  REQUEST_SUBMISSION_SCHEMA_VERSION,
  TRIAGE_ENTRY_SCHEMA_VERSION,
  type CreateRequestFormInput,
  type MarkDuplicateRequestSubmissionAction,
  type PublicRequestForm,
  type PublishRequestFormInput,
  type RequestAnswerValue,
  type RequestAttachment,
  type RequestAttachmentUploadInput,
  type RequestAttachmentUploadSession,
  type RequestEmailEnvelope,
  type RequestForm,
  type RequestFormAccessMode,
  type RequestFormCondition,
  type RequestFormConditionGroup,
  type RequestFormDefinition,
  type RequestFormDraft,
  type RequestFormField,
  type RequestFormFieldType,
  type RequestFormRoutingConfiguration,
  type RequestFormRoutingTarget,
  type RequestFormScope,
  type RequestFormVersion,
  type RequestLocale,
  type RequestRequesterReplyInput,
  type RequestRequesterReplyReceipt,
  type RequestRequesterThread,
  type RequestSubmission,
  type RequestSubmissionActionInput,
  type RequestSubmissionEvent,
  type RequestSubmissionMessage,
  type RequestSubmissionPage,
  type RequestSubmissionReceipt,
  type RequestSubmissionStatus,
  type RequestWorkItemReference,
  type SubmitRequestInput,
  type TriageEntry,
  type UpdateRequestFormInput,
  type WorkItemPriority,
} from '@mukuroji/contracts'
import { getConfiguredDynamoDbEndpoint } from '../audit'
import {
  S3FileObjectClient,
  type FileObjectClient,
  type FileVersionAccess,
} from '../files'
import {
  createFormTriageEntryTransactionItems,
  createTriageCapabilities,
  createTriageEntryKey,
  createTriageSourceActivityTransactionItems,
  decodeTriageEntryRow,
  TRIAGE_OWNER_ACTIVITY_INDEX_NAME,
  TRIAGE_TEAM_ACTIVITY_INDEX_NAME,
  TRIAGE_WAKE_INDEX_NAME,
  type TriageAdmissionTransactionContribution,
} from '../triage'

/** Request intake queue GSI の既定名です。 */
export const REQUEST_QUEUE_INDEX_NAME = 'RequestQueueIndex'

/** Form 一つに保存できる section 数です。 */
export const REQUEST_FORM_SECTION_LIMIT = 20

/** Form 一つに保存できる field 数です。 */
export const REQUEST_FORM_FIELD_LIMIT = 100

/** Submission 一つの plain text answer 最大文字数です。 */
export const REQUEST_ANSWER_TEXT_LIMIT = 20_000

/** Request thread に保持する bounded message 数です。 */
export const REQUEST_THREAD_MESSAGE_LIMIT = 100

const REQUEST_FORM_DRAFT_BYTE_LIMIT = 128 * 1024
const REQUEST_ANSWER_TOTAL_BYTE_LIMIT = 96 * 1024
const REQUEST_THREAD_TOTAL_BYTE_LIMIT = 64 * 1024
const REQUEST_EVENT_TOTAL_BYTE_LIMIT = 32 * 1024
const REQUEST_PATTERN_FIXED_QUANTIFIER_LIMIT = 1_000
const REQUEST_STORED_ITEM_BYTE_LIMIT = 360 * 1024
const REQUEST_SUBMISSION_REPLAY_GRACE_MS = 15 * 60_000
const REQUEST_SUBMISSION_REPLAY_LIMIT = 5

/** Request domain の安定した application error です。 */
export class RequestIntakeError extends Error {
  /** HTTP response に対応する status です。 */
  readonly status: number

  /** Client が分岐に利用できる error code です。 */
  readonly code: string

  /** Request intake error を作成します。 */
  constructor(status: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RequestIntakeError'
    this.status = status
    this.code = code
  }
}

/** Link token から解決した内部 capability scope です。 */
export type RequestLinkResolution = {
  /** Capability が属する Workspace ID です。 */
  workspaceId: string
  /** Capability が参照する form ID です。 */
  formId: string
  /** Link access 境界です。 */
  accessMode: RequestFormAccessMode
  /** Link token を保存せず参照する digest です。 */
  tokenDigest: string
}

/** Request mutation を行う内部 actor です。 */
export type RequestIntakeActor = {
  /** Workspace member または service の安定 ID です。 */
  id: string
}

/** Anonymous submit/upload の abuse 制御 context です。 */
export type RequestExternalContext = {
  /** Trusted transport 情報から server が組み立てる client key です。 */
  clientKey: string
  /** Retry で同じ payload を識別する任意 idempotency key です。 */
  idempotencyKey?: string
}

/** Queue list の bounded query option です。 */
export type RequestSubmissionListOptions = {
  /** 取得対象 status です。 */
  status?: RequestSubmissionStatus
  /** 一 page の最大件数です。 */
  limit?: number
  /** 次 page を指す scope-bound cursor です。 */
  cursor?: string
}

/** Work Item conversion の private projection input です。 */
export type RequestConversionProjection = {
  /** 読み込み時点の submission revision です。 */
  expectedRevision: number
  /** 作成済み canonical Work Item 参照です。 */
  workItem: RequestWorkItemReference
}

/** Request attachment の internal clean-file access です。 */
export type RequestAttachmentAccess = FileVersionAccess

/** Request intake persistence/domain client です。 */
export interface RequestIntakeClient {
  /** Workspace の form 一覧を返します。 */
  listForms(workspaceId: string): Promise<{ forms: RequestForm[] }>
  /** Workspace 内の form を取得します。 */
  getForm(workspaceId: string, formId: string): Promise<RequestForm>
  /** Workspace に form draft と capability link を作成します。 */
  createForm(
    workspaceId: string,
    actor: RequestIntakeActor,
    input: CreateRequestFormInput,
  ): Promise<RequestForm>
  /** Form draft/link を revision 条件付きで更新します。 */
  updateForm(
    workspaceId: string,
    formId: string,
    actor: RequestIntakeActor,
    input: UpdateRequestFormInput,
  ): Promise<RequestForm>
  /** Current draft を immutable version として公開します。 */
  publishForm(
    workspaceId: string,
    formId: string,
    actor: RequestIntakeActor,
    input: PublishRequestFormInput,
  ): Promise<RequestForm>
  /** Opaque link token を内部 form scope へ解決します。 */
  resolveLink(token: string): Promise<RequestLinkResolution>
  /** 認可済み link から allowlist 済み public DTO と one-time session を返します。 */
  getPublicForm(
    resolution: RequestLinkResolution,
    context: RequestExternalContext,
  ): Promise<PublicRequestForm>
  /** Request 専用 direct attachment upload session を作成します。 */
  createAttachmentUpload(
    resolution: RequestLinkResolution,
    input: RequestAttachmentUploadInput,
    context: RequestExternalContext,
  ): Promise<RequestAttachmentUploadSession>
  /** One-time session を consume して submission を保存します。 */
  submit(
    resolution: RequestLinkResolution,
    input: SubmitRequestInput,
    context: RequestExternalContext,
  ): Promise<RequestSubmissionReceipt>
  /** Workspace intake queue を cursor pagination します。 */
  listSubmissions(
    workspaceId: string,
    options?: RequestSubmissionListOptions,
  ): Promise<RequestSubmissionPage>
  /** Submission detail を strong read します。 */
  getSubmission(workspaceId: string, submissionId: string): Promise<RequestSubmission>
  /** Applies one non-conversion Request action and optional caller-owned atomic contributions.
   *
   * @param workspaceId - Owning Workspace identifier.
   * @param submissionId - Target Request submission identifier.
   * @param actor - Authenticated Request actor.
   * @param input - Revision-fenced non-conversion action.
   * @param additionalTransactionItems - Narrow cross-domain items committed with the Request.
   * @returns The resulting Request submission view.
   */
  applyAction(
    workspaceId: string,
    submissionId: string,
    actor: RequestIntakeActor,
    input: Exclude<RequestSubmissionActionInput, { action: 'convert' }>,
    additionalTransactionItems?: NonNullable<TransactWriteCommandInput['TransactItems']>,
  ): Promise<RequestSubmission>
  /** Stores a revision-fenced Work Item trace projection and optional atomic contributions.
   *
   * @param workspaceId - Owning Workspace identifier.
   * @param submissionId - Source Request submission identifier.
   * @param actor - Authenticated Request actor.
   * @param input - Canonical Work Item projection and expected revision.
   * @param additionalTransactionItems - Narrow cross-domain items committed with the projection.
   * @returns The resulting terminal Request submission.
   */
  completeConversion(
    workspaceId: string,
    submissionId: string,
    actor: RequestIntakeActor,
    input: RequestConversionProjection,
    additionalTransactionItems?: NonNullable<TransactWriteCommandInput['TransactItems']>,
  ): Promise<RequestSubmission>
  /** External capability thread の allowlist 済み message view を返します。 */
  getRequesterThread(
    threadToken: string,
    context: RequestExternalContext,
  ): Promise<RequestRequesterThread>
  /** External capability thread へ requester reply を保存します。 */
  replyToThread(
    threadToken: string,
    input: RequestRequesterReplyInput,
    context: RequestExternalContext,
  ): Promise<RequestRequesterReplyReceipt>
  /** 署名検証済み email envelope を requester reply として保存します。 */
  ingestEmail(envelope: RequestEmailEnvelope): Promise<RequestRequesterReplyReceipt>
  /** Scan 済み request attachment の短命 download URL を発行します。 */
  createAttachmentAccess(
    workspaceId: string,
    submissionId: string,
    attachmentId: string,
  ): Promise<RequestAttachmentAccess>
}

/** Tenant lifecycle boundary used by public Request Intake operations. */
export interface RequestIntakeTenantAvailability {
  /** Returns whether the tenant may serve public reads and writes. */
  isActive(workspaceId: string): Promise<boolean>
  /** Returns an atomic guard for a tenant-owned DynamoDB write when available. */
  createActiveWriteCondition?(
    workspaceId: string,
  ): NonNullable<TransactWriteCommandInput['TransactItems']>[number]
}

/** Applies current Team Triage configuration before a Form entry is committed.
 *
 * @param entry - Normalized Form entry before Team configuration is applied.
 * @returns The configured entry and optional Triage-owned transaction items.
 */
export type FormTriageAdmissionPreparer = (
  entry: TriageEntry,
) => Promise<TriageAdmissionTransactionContribution>

/** DynamoDB/S3 client の差し替え option です。 */
export type DynamoDbRequestIntakeClientOptions = {
  /** Request intake table 名です。 */
  tableName?: string
  /** Queue GSI 名です。 */
  queueIndexName?: string
  /** DynamoDB DocumentClient です。 */
  documentClient?: DynamoDBDocumentClient
  /** Local table bootstrap 用 low-level client です。 */
  dynamoDbClient?: DynamoDBClient
  /** Attachment object storage adapter です。 */
  objectClient?: FileObjectClient
  /** Capability digest に使う secret です。 */
  tokenHashSecret?: string
  /** Link/client/hour ごとの submit 上限です。 */
  rateLimitPerHour?: number
  /** Test で固定できる clock です。 */
  now?: () => Date
  /** Test で固定できる token generator です。 */
  token?: () => string
  /** Local DynamoDB table 欠落を作成するかどうかです。 */
  bootstrapLocalTable?: boolean
  /** Public traffic を tenant closure と直列化する lifecycle boundary です。 */
  tenantAvailability?: RequestIntakeTenantAvailability
  /** Production callback that applies current Team Triage configuration. */
  prepareFormTriageAdmission?: FormTriageAdmissionPreparer
}

/** Raw capability token を除いた form root row です。 */
type StoredRequestForm = Omit<RequestForm, 'link'> & {
  /** Token を保存しない link metadata です。 */
  link: Omit<RequestForm['link'], 'token'>
  /** DynamoDB row discriminator です。 */
  entryType: 'form'
  /** Workspace partition key です。 */
  scopeKey: string
  /** Form root sort key です。 */
  recordKey: string
}

/** Immutable published form version row です。 */
type StoredRequestFormVersion = RequestFormVersion & {
  /** DynamoDB row discriminator です。 */
  entryType: 'form-version'
  /** Workspace partition key です。 */
  scopeKey: string
  /** Version sort key です。 */
  recordKey: string
}

/** Hashed public link capability の lookup row です。 */
type StoredLinkLookup = {
  /** DynamoDB row discriminator です。 */
  entryType: 'link-lookup'
  /** Token digest partition key です。 */
  scopeKey: string
  /** Lookup 固定 sort key です。 */
  recordKey: 'LOOKUP'
  /** Capability が属する Workspace ID です。 */
  workspaceId: string
  /** Capability が参照する form ID です。 */
  formId: string
  /** Rotation を検証する link ID です。 */
  linkId: string
  /** Link の認証境界です。 */
  accessMode: RequestFormAccessMode
  /** DynamoDB TTL 用 epoch seconds です。 */
  expiresAt?: number
  /** 即時 expiry 判定用 ISO timestamp です。 */
  expiresAtIso?: string
  /** 明示失効時刻です。 */
  revokedAt?: string
}

/** Published version に固定した one-time submission session row です。 */
type StoredSubmissionSession = {
  /** DynamoDB row discriminator です。 */
  entryType: 'submission-session'
  /** Session token digest partition key です。 */
  scopeKey: string
  /** Lookup 固定 sort key です。 */
  recordKey: 'LOOKUP'
  /** Session が属する Workspace ID です。 */
  workspaceId: string
  /** Session が属する form ID です。 */
  formId: string
  /** 回答を固定する published version です。 */
  formVersion: number
  /** 発行元 link digest です。 */
  linkDigest: string
  /** Bot 対策の最短 submit timestamp です。 */
  minimumSubmitAt: string
  /** 即時 expiry 判定用 ISO timestamp です。 */
  expiresAtIso: string
  /** DynamoDB TTL 用 epoch seconds です。 */
  expiresAt: number
  /** Session consume timestamp です。 */
  usedAt?: string
  /** Session で発行済みの upload 件数です。 */
  uploadCount?: number
  /** Session で発行済みの upload 累積 byte 数です。 */
  uploadBytes?: number
  /** Response-loss replay を検証する input digest です。 */
  inputFingerprint?: string
  /** Raw thread token を除いた replay receipt です。 */
  receipt?: StoredSubmissionReceipt
}

/** Session replay 用の private submission receipt です。 */
type StoredSubmissionReceipt = Omit<RequestSubmissionReceipt, 'threadToken'> & {
  /** Thread token を再導出する submission ID です。 */
  submissionId: string
}

/** Presigned upload と submission を結ぶ attachment row です。 */
type StoredAttachmentUpload = {
  /** DynamoDB row discriminator です。 */
  entryType: 'attachment-upload'
  /** Workspace partition key です。 */
  scopeKey: string
  /** Attachment sort key です。 */
  recordKey: string
  /** Public answer が参照する attachment ID です。 */
  attachmentId: string
  /** Upload を許可した form ID です。 */
  formId: string
  /** Upload を許可した form version です。 */
  formVersion: number
  /** Upload を許可した attachment field ID です。 */
  fieldId: string
  /** Upload session token digest です。 */
  sessionDigest: string
  /** Browser が submit 時に提示する attachment claim token digest です。 */
  claimDigest: string
  /** Normalized file 名です。 */
  fileName: string
  /** 許可済み MIME type です。 */
  contentType: string
  /** 許可済み byte 数です。 */
  sizeBytes: number
  /** Private S3 object key です。 */
  objectKey: string
  /** Verification 後の immutable S3 version ID です。 */
  objectVersionId?: string
  /** GuardDuty scan 状態です。 */
  scanStatus: RequestAttachment['scanStatus']
  /** Consume 後に紐づく submission ID です。 */
  submissionId?: string
  /** Upload row 作成 timestamp です。 */
  createdAt: string
  /** 未使用 upload row の TTL epoch seconds です。 */
  expiresAt: number
}

/** Queue と detail の canonical submission row です。 */
type StoredRequestSubmission = RequestSubmission & {
  /** DynamoDB row discriminator です。 */
  entryType: 'submission'
  /** Workspace partition key です。 */
  scopeKey: string
  /** Submission sort key です。 */
  recordKey: string
  /** Queue GSI partition key です。 */
  queueKey: string
  /** Queue GSI chronological sort key です。 */
  queueRecordKey: string
  /** Email reply sender binding 用 address です。 */
  requesterEmail?: string
  /** Raw token を保存しない thread capability digest です。 */
  threadDigest: string
  /** Duplicate candidate lookup 用 keyed digest です。 */
  duplicateFingerprint: string
  /** Attachment ID ごとの private S3 object key です。 */
  attachmentObjectKeys: Record<string, string>
  /** Attachment ID ごとの immutable S3 version ID です。 */
  attachmentObjectVersionIds: Record<string, string | undefined>
  /** Clean attachment の completion tag をすべて永続化した時刻です。 */
  attachmentFinalizedAt?: string
}

/** Submission activity を immutable に保存する append-only row です。 */
type StoredRequestSubmissionEvent = RequestSubmissionEvent & {
  /** DynamoDB row discriminator です。 */
  entryType: 'submission-event'
  /** Workspace partition key です。 */
  scopeKey: string
  /** Submission、時刻、event ID を含む sort key です。 */
  recordKey: string
  /** Event が属する submission ID です。 */
  submissionId: string
}

/** Request Intake が所有する immutable submission event transaction item です。 */
type RequestSubmissionEventTransactionItem = {
  /** Submission event row を条件付きで追加する Put operation です。 */
  Put: {
    /** Request Intake table name です。 */
    TableName: string
    /** 永続化する canonical submission event row です。 */
    Item: StoredRequestSubmissionEvent
    /** Immutable event の重複作成を拒否する condition です。 */
    ConditionExpression: string
  }
}

/** Hashed requester reply capability の lookup row です。 */
type StoredThreadLookup = {
  /** DynamoDB row discriminator です。 */
  entryType: 'thread-lookup'
  /** Thread token digest partition key です。 */
  scopeKey: string
  /** Lookup 固定 sort key です。 */
  recordKey: 'LOOKUP'
  /** Thread が属する Workspace ID です。 */
  workspaceId: string
  /** Thread が参照する submission ID です。 */
  submissionId: string
  /** Email reply を元 submitter に限定する address です。 */
  requesterEmail?: string
  /** Thread capability の TTL epoch seconds です。 */
  expiresAt: number
}

/** Email Message-ID または HTTP idempotency key の reply receipt row です。 */
type StoredReplyReceipt = {
  /** Reply channel を示す row discriminator です。 */
  entryType: 'email-receipt' | 'reply-receipt'
  /** Dedupe digest partition key です。 */
  scopeKey: string
  /** Receipt 固定 sort key です。 */
  recordKey: 'RECEIPT'
  /** Reply が属する Workspace ID です。 */
  workspaceId: string
  /** Reply が属する submission ID です。 */
  submissionId: string
  /** Idempotency key の payload binding digest です。 */
  inputFingerprint: string
  /** Replay 時に返す reply receipt です。 */
  receipt: RequestRequesterReplyReceipt
  /** Dedupe row の TTL epoch seconds です。 */
  expiresAt: number
}

/** Form draft を strict normalize し、conditional forward reference も検証します。 */
export function validateRequestFormDraft(value: unknown): RequestFormDraft {
  const record = requireRecord(value, 'Request form draft')
  const definition = validateRequestFormDefinition(record.definition)
  const routing = validateRequestFormRouting(record.routing, definition)
  const draft = { definition, routing }
  assertJsonByteLimit(draft, REQUEST_FORM_DRAFT_BYTE_LIMIT, 'Request form draft')
  return draft
}

/** Public form definition を strict normalize します。 */
export function validateRequestFormDefinition(value: unknown): RequestFormDefinition {
  const record = requireRecord(value, 'Request form definition')
  const defaultLocale = requireRequestLocale(record.defaultLocale)
  const supportedLocales = requireArray(record.supportedLocales, 'Supported locales')
    .map(requireRequestLocale)
  if (!supportedLocales.includes(defaultLocale)) {
    throw invalidInput('Default locale must be included in supported locales.')
  }
  if (new Set(supportedLocales).size !== supportedLocales.length || supportedLocales.length < 1) {
    throw invalidInput('Supported locales must be a non-empty unique list.')
  }
  const sections = requireArray(record.sections, 'Request form sections')
  if (sections.length < 1 || sections.length > REQUEST_FORM_SECTION_LIMIT) {
    throw invalidInput(`Request form must contain 1-${REQUEST_FORM_SECTION_LIMIT} sections.`)
  }
  const knownFieldIds = new Set<string>()
  const knownSectionIds = new Set<string>()
  let fieldCount = 0
  const normalizedSections = sections.map((sectionValue) => {
    const section = requireRecord(sectionValue, 'Request form section')
    const id = requireIdentifier(section.id, 'Section ID')
    if (knownSectionIds.has(id)) throw invalidInput(`Duplicate section ID "${id}".`)
    knownSectionIds.add(id)
    const visibleWhen = section.visibleWhen === undefined
      ? undefined
      : validateConditionGroup(section.visibleWhen, knownFieldIds, `Section "${id}" visibility`)
    const fields = requireArray(section.fields, 'Request form fields').map((fieldValue) => {
      const field = validateRequestFormField(fieldValue, knownFieldIds)
      knownFieldIds.add(field.id)
      fieldCount += 1
      return field
    })
    if (fields.length < 1) throw invalidInput(`Section "${id}" must contain a field.`)
    return {
      id,
      title: requireLocalizedText(section.title, defaultLocale, `Section "${id}" title`),
      ...(section.description === undefined
        ? {}
        : { description: requireLocalizedText(section.description, defaultLocale, `Section "${id}" description`) }),
      ...(visibleWhen ? { visibleWhen } : {}),
      fields,
    }
  })
  if (fieldCount > REQUEST_FORM_FIELD_LIMIT) {
    throw invalidInput(`Request form must contain at most ${REQUEST_FORM_FIELD_LIMIT} fields.`)
  }
  const attachments = record.attachments === undefined
    ? undefined
    : validateAttachmentPolicy(record.attachments)
  const hasAttachmentField = normalizedSections.some((section) =>
    section.fields.some((field) => field.type === 'attachment')
  )
  if (hasAttachmentField && !attachments?.enabled) {
    throw invalidInput('Attachment fields require an enabled attachment policy.')
  }
  const consent = record.consent === undefined
    ? undefined
    : validateConsent(record.consent, defaultLocale)
  const confirmation = requireRecord(record.confirmation, 'Request confirmation')
  const redirectUrl = confirmation.redirectUrl === undefined
    ? undefined
    : requireSafeNavigationUrl(confirmation.redirectUrl, 'Confirmation redirect URL')
  return {
    defaultLocale,
    supportedLocales,
    title: requireLocalizedText(record.title, defaultLocale, 'Request form title'),
    ...(record.description === undefined
      ? {}
      : { description: requireLocalizedText(record.description, defaultLocale, 'Request form description') }),
    sections: normalizedSections,
    ...(consent ? { consent } : {}),
    ...(attachments ? { attachments } : {}),
    confirmation: {
      message: requireLocalizedText(confirmation.message, defaultLocale, 'Confirmation message'),
      ...(redirectUrl ? { redirectUrl } : {}),
    },
  }
}

/** Answer map に対して conditional visibility を field 順で評価します。 */
export function isRequestFieldVisible(
  field: RequestFormField,
  answers: Readonly<Record<string, RequestAnswerValue>>,
) {
  return field.visibleWhen ? evaluateRequestConditionGroup(field.visibleWhen, answers) : true
}

/** Conditional group を typed answer map に対して評価します。 */
export function evaluateRequestConditionGroup(
  group: RequestFormConditionGroup,
  answers: Readonly<Record<string, RequestAnswerValue>>,
) {
  const results = group.conditions.map((condition) =>
    evaluateRequestCondition(condition, answers[condition.fieldId])
  )
  return group.mode === 'all' ? results.every(Boolean) : results.some(Boolean)
}

/** Versioned definition に対して visible answer だけを検証・normalize します。 */
export function validateRequestAnswers(
  definition: RequestFormDefinition,
  locale: RequestLocale,
  value: unknown,
) {
  if (!definition.supportedLocales.includes(locale)) {
    throw invalidInput('Submission locale is not supported by this form version.')
  }
  const answers = requireRecord(value, 'Request answers')
  const normalized: Record<string, RequestAnswerValue> = {}
  const allFieldIds = new Set(definition.sections.flatMap((section) => section.fields.map((field) => field.id)))
  for (const fieldId of Object.keys(answers)) {
    if (!allFieldIds.has(fieldId)) throw invalidInput(`Unknown answer field "${fieldId}".`)
  }
  for (const field of definition.sections.flatMap((section) => section.fields)) {
    const section = definition.sections.find((candidate) => candidate.fields.includes(field))
    if (section?.visibleWhen && !evaluateRequestConditionGroup(section.visibleWhen, normalized)) {
      const raw = answers[field.id]
      if (raw !== undefined && !isEmptyAnswer(raw)) {
        throw invalidInput(`Hidden section field "${field.id}" must not be submitted.`)
      }
      continue
    }
    const visible = isRequestFieldVisible(field, normalized)
    const raw = answers[field.id]
    if (!visible) {
      if (raw !== undefined && !isEmptyAnswer(raw)) {
        throw invalidInput(`Hidden field "${field.id}" must not be submitted.`)
      }
      continue
    }
    const answer = validateAnswerValue(field, raw)
    if (answer !== undefined) normalized[field.id] = answer
  }
  assertJsonByteLimit(normalized, REQUEST_ANSWER_TOTAL_BYTE_LIMIT, 'Request answers')
  return normalized
}

/** Submission の回答から first-match routing target を解決します。 */
export function resolveRequestRouting(
  configuration: RequestFormRoutingConfiguration,
  answers: Readonly<Record<string, RequestAnswerValue>>,
) {
  return configuration.rules.find((rule) => evaluateRequestConditionGroup(rule.when, answers))?.target ??
    configuration.defaultTarget
}

/** Submission snapshot と convert override から canonical Work Item input を作成します。 */
export function createRequestWorkItemInput(
  submission: RequestSubmission,
  overrides: Extract<RequestSubmissionActionInput, { action: 'convert' }>,
) {
  const target = validateRoutingTarget({
    ...submission.routingTarget,
    ...removeUndefined(overrides.target ?? {}),
  })
  const title = overrides.title?.trim() || answerToText(
    submission.answers[submission.workItemMapping.titleFieldId],
  ).trim()
  if (!title) throw invalidInput('Mapped Work Item title is empty.')
  const description = overrides.description?.trim() || (submission.workItemMapping.descriptionFieldIds ?? [])
    .map((fieldId) => answerToText(submission.answers[fieldId]).trim())
    .filter(Boolean)
    .join('\n\n')
  const customFieldValues = Object.fromEntries(
    Object.entries(submission.workItemMapping.customFieldMappings ?? {}).flatMap(
      ([fieldId, customFieldId]) => {
        const value = submission.answers[fieldId]
        return value === undefined ? [] : [[customFieldId, value]]
      },
    ),
  )
  const dueDate = new Date(`${submission.createdAt.slice(0, 10)}T00:00:00.000Z`)
  dueDate.setUTCDate(dueDate.getUTCDate() + target.dueDateOffsetDays)
  const scheduleDueDate = dueDate.toISOString().slice(0, 10)
  return {
    target,
    input: {
      title: title.slice(0, 500),
      ...(description ? { description } : {}),
      ...(target.projectId ? { assignedProjectId: target.projectId } : {}),
      assigneeUserId: target.assigneeUserId,
      ...(target.workflowStatusId ? { workflowStatusId: target.workflowStatusId } : {}),
      customFieldValues,
      schedule: {
        calendarPolicy: {
          holidays: [],
          timeZone: 'UTC',
          workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
        },
        dueDate: scheduleDueDate,
        mode: 'due-date',
      },
      priority: target.priority,
    },
  }
}

function validateRequestFormField(value: unknown, knownFieldIds: ReadonlySet<string>): RequestFormField {
  const record = requireRecord(value, 'Request form field')
  const id = requireIdentifier(record.id, 'Field ID')
  if (knownFieldIds.has(id)) throw invalidInput(`Duplicate field ID "${id}".`)
  const type = requireFieldType(record.type)
  const options = record.options === undefined ? undefined : validateFieldOptions(record.options)
  if ((type === 'single-select' || type === 'multi-select') && (!options || options.length < 1)) {
    throw invalidInput(`Select field "${id}" requires options.`)
  }
  if (type !== 'single-select' && type !== 'multi-select' && options !== undefined) {
    throw invalidInput(`Field "${id}" does not support options.`)
  }
  const validation = record.validation === undefined
    ? undefined
    : validateFieldValidation(record.validation, type)
  const visibleWhen = record.visibleWhen === undefined
    ? undefined
    : validateConditionGroup(record.visibleWhen, knownFieldIds, `Field "${id}" visibility`)
  return {
    id,
    type,
    label: requireAnyLocalizedText(record.label, `Field "${id}" label`),
    ...(record.helpText === undefined ? {} : { helpText: requireAnyLocalizedText(record.helpText, `Field "${id}" help`) }),
    ...(record.placeholder === undefined ? {} : { placeholder: requireAnyLocalizedText(record.placeholder, `Field "${id}" placeholder`) }),
    ...(options ? { options } : {}),
    ...(validation ? { validation } : {}),
    ...(visibleWhen ? { visibleWhen } : {}),
  }
}

function validateRequestFormRouting(
  value: unknown,
  definition: RequestFormDefinition,
): RequestFormRoutingConfiguration {
  const record = requireRecord(value, 'Request form routing')
  const fields = definition.sections.flatMap((section) => section.fields)
  const fieldIds = new Set(fields.map((field) => field.id))
  const defaultTarget = validateRoutingTarget(record.defaultTarget)
  const rules = requireArray(record.rules, 'Request routing rules')
  if (rules.length > 50) throw invalidInput('Request routing supports at most 50 rules.')
  const ruleIds = new Set<string>()
  const normalizedRules = rules.map((ruleValue) => {
    const rule = requireRecord(ruleValue, 'Request routing rule')
    const id = requireIdentifier(rule.id, 'Routing rule ID')
    if (ruleIds.has(id)) throw invalidInput(`Duplicate routing rule ID "${id}".`)
    ruleIds.add(id)
    return {
      id,
      name: requireText(rule.name, 'Routing rule name', 200),
      when: validateConditionGroup(rule.when, fieldIds, `Routing rule "${id}"`),
      target: validateRoutingTarget(rule.target),
    }
  })
  const mappingRecord = requireRecord(record.mapping, 'Request Work Item mapping')
  const titleFieldId = requireIdentifier(mappingRecord.titleFieldId, 'Title field ID')
  const titleField = fields.find((field) => field.id === titleFieldId)
  if (!titleField || titleField.type === 'attachment' || titleField.type === 'boolean') {
    throw invalidInput('Title mapping must reference a text-like form field.')
  }
  const descriptionFieldIds = mappingRecord.descriptionFieldIds === undefined
    ? undefined
    : requireArray(mappingRecord.descriptionFieldIds, 'Description field IDs')
      .map((fieldId) => requireIdentifier(fieldId, 'Description field ID'))
  for (const fieldId of descriptionFieldIds ?? []) {
    if (!fieldIds.has(fieldId)) throw invalidInput(`Description mapping field "${fieldId}" was not found.`)
  }
  const customFieldMappings = mappingRecord.customFieldMappings === undefined
    ? undefined
    : Object.fromEntries(Object.entries(requireRecord(
        mappingRecord.customFieldMappings,
        'Custom field mappings',
      )).map(([fieldId, customFieldId]) => {
        if (!fieldIds.has(fieldId)) throw invalidInput(`Custom mapping field "${fieldId}" was not found.`)
        return [fieldId, requireIdentifier(customFieldId, 'Custom field ID')]
      }))
  if (
    customFieldMappings &&
    new Set(Object.values(customFieldMappings)).size !== Object.keys(customFieldMappings).length
  ) {
    throw invalidInput('Each Work Item custom field may be mapped from only one request field.')
  }
  return {
    defaultTarget,
    rules: normalizedRules,
    mapping: {
      titleFieldId,
      ...(descriptionFieldIds ? { descriptionFieldIds } : {}),
      ...(customFieldMappings ? { customFieldMappings } : {}),
    },
  }
}

function validateRoutingTarget(value: unknown): RequestFormRoutingTarget {
  const record = requireRecord(value, 'Request routing target')
  const priority = requirePriority(record.priority)
  const dueDateOffsetDays = requireInteger(record.dueDateOffsetDays, 'Due date offset', 0, 3650)
  return {
    teamId: requireIdentifier(record.teamId, 'Routing Team ID'),
    ...(record.projectId === undefined ? {} : { projectId: requireIdentifier(record.projectId, 'Routing Project ID') }),
    ...(record.workflowStatusId === undefined
      ? {}
      : { workflowStatusId: requireIdentifier(record.workflowStatusId, 'Routing workflow status ID') }),
    assigneeUserId: requireText(record.assigneeUserId, 'Routing assignee', 320).toLowerCase(),
    priority,
    dueDateOffsetDays,
  }
}

function validateConditionGroup(
  value: unknown,
  allowedFieldIds: ReadonlySet<string>,
  label: string,
): RequestFormConditionGroup {
  const record = requireRecord(value, label)
  if (record.mode !== 'all' && record.mode !== 'any') throw invalidInput(`${label} mode is invalid.`)
  const conditions = requireArray(record.conditions, `${label} conditions`)
  if (conditions.length < 1 || conditions.length > 20) {
    throw invalidInput(`${label} must contain 1-20 conditions.`)
  }
  return {
    mode: record.mode,
    conditions: conditions.map((conditionValue) => {
      const condition = requireRecord(conditionValue, `${label} condition`)
      const fieldId = requireIdentifier(condition.fieldId, 'Condition field ID')
      if (!allowedFieldIds.has(fieldId)) {
        throw invalidInput(`${label} references unknown or forward field "${fieldId}".`)
      }
      const operator = requireConditionOperator(condition.operator)
      if (operator !== 'is-empty' && operator !== 'is-not-empty' && !isScalar(condition.value)) {
        throw invalidInput(`${label} comparison value is invalid.`)
      }
      return {
        fieldId,
        operator,
        ...(operator === 'is-empty' || operator === 'is-not-empty' ? {} : { value: condition.value }),
      } as RequestFormCondition
    }),
  }
}

function evaluateRequestCondition(condition: RequestFormCondition, value: RequestAnswerValue | undefined) {
  if (condition.operator === 'is-empty') return isEmptyAnswer(value)
  if (condition.operator === 'is-not-empty') return !isEmptyAnswer(value)
  if (condition.operator === 'contains') {
    return Array.isArray(value)
      ? value.includes(String(condition.value))
      : typeof value === 'string' && value.includes(String(condition.value))
  }
  const equals = Array.isArray(value)
    ? value.includes(String(condition.value))
    : value === condition.value
  return condition.operator === 'equals' ? equals : !equals
}

function validateAnswerValue(field: RequestFormField, raw: unknown): RequestAnswerValue | undefined {
  if (raw === undefined || raw === null || raw === '') {
    if (field.validation?.required) throw invalidInput(`Field "${field.id}" is required.`)
    return undefined
  }
  if (field.type === 'boolean') {
    if (typeof raw !== 'boolean') throw invalidInput(`Field "${field.id}" must be boolean.`)
    return raw
  }
  if (field.type === 'number') {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) throw invalidInput(`Field "${field.id}" must be numeric.`)
    if (field.validation?.min !== undefined && raw < field.validation.min) throw invalidInput(`Field "${field.id}" is below its minimum.`)
    if (field.validation?.max !== undefined && raw > field.validation.max) throw invalidInput(`Field "${field.id}" exceeds its maximum.`)
    return raw
  }
  if (field.type === 'multi-select' || field.type === 'attachment') {
    if (!Array.isArray(raw) || !raw.every((entry) => typeof entry === 'string')) {
      throw invalidInput(`Field "${field.id}" must be a string list.`)
    }
    if (field.validation?.required && raw.length === 0) throw invalidInput(`Field "${field.id}" is required.`)
    if (field.type === 'multi-select') {
      const allowed = new Set(field.options?.map((option) => option.id) ?? [])
      if (raw.some((entry) => !allowed.has(entry))) throw invalidInput(`Field "${field.id}" contains an invalid option.`)
    }
    return [...new Set(raw)]
  }
  if (typeof raw !== 'string' || raw.length > REQUEST_ANSWER_TEXT_LIMIT) {
    throw invalidInput(`Field "${field.id}" must be a bounded string.`)
  }
  const value = raw.trim()
  if (!value && field.validation?.required) throw invalidInput(`Field "${field.id}" is required.`)
  if (!value) return undefined
  if (field.type === 'single-select' && !field.options?.some((option) => option.id === value)) {
    throw invalidInput(`Field "${field.id}" contains an invalid option.`)
  }
  if (field.type === 'email' && !/^[^\s@]+@[^\s@]+$/u.test(value)) throw invalidInput(`Field "${field.id}" must be an email address.`)
  if (field.type === 'url') requireHttpsUrl(value, `Field "${field.id}"`)
  if (field.type === 'date' && !isValidIsoDate(value)) throw invalidInput(`Field "${field.id}" must be an ISO date.`)
  if (field.validation?.minLength !== undefined && value.length < field.validation.minLength) throw invalidInput(`Field "${field.id}" is too short.`)
  if (field.validation?.maxLength !== undefined && value.length > field.validation.maxLength) throw invalidInput(`Field "${field.id}" is too long.`)
  if (field.validation?.pattern && !matchesRequestPattern(field.validation.pattern, value)) {
    throw invalidInput(`Field "${field.id}" has an invalid format.`)
  }
  return value
}

function validateFieldOptions(value: unknown) {
  const values = requireArray(value, 'Field options')
  if (values.length > 100) throw invalidInput('Field supports at most 100 options.')
  const ids = new Set<string>()
  return values.map((optionValue) => {
    const option = requireRecord(optionValue, 'Field option')
    const id = requireIdentifier(option.id, 'Option ID')
    if (ids.has(id)) throw invalidInput(`Duplicate option ID "${id}".`)
    ids.add(id)
    return { id, label: requireAnyLocalizedText(option.label, `Option "${id}" label`) }
  })
}

function validateFieldValidation(value: unknown, type: RequestFormFieldType) {
  const record = requireRecord(value, 'Field validation')
  const required = record.required === undefined ? undefined : requireBoolean(record.required, 'Field required')
  const textType = ['short-text', 'long-text', 'email', 'url', 'date'].includes(type)
  const minLength = record.minLength === undefined ? undefined : requireInteger(record.minLength, 'Minimum length', 0, REQUEST_ANSWER_TEXT_LIMIT)
  const maxLength = record.maxLength === undefined ? undefined : requireInteger(record.maxLength, 'Maximum length', 1, REQUEST_ANSWER_TEXT_LIMIT)
  if ((!textType && (minLength !== undefined || maxLength !== undefined)) || (minLength !== undefined && maxLength !== undefined && minLength > maxLength)) {
    throw invalidInput('Field length validation is invalid for its type.')
  }
  const pattern = record.pattern === undefined ? undefined : requireSafePattern(record.pattern)
  if (!textType && pattern !== undefined) throw invalidInput('Only text-like fields support patterns.')
  const min = record.min === undefined ? undefined : requireFiniteNumber(record.min, 'Minimum number')
  const max = record.max === undefined ? undefined : requireFiniteNumber(record.max, 'Maximum number')
  if (type !== 'number' && (min !== undefined || max !== undefined)) throw invalidInput('Only number fields support numeric bounds.')
  if (min !== undefined && max !== undefined && min > max) throw invalidInput('Numeric minimum must not exceed maximum.')
  return removeUndefined({ required, minLength, maxLength, pattern, min, max })
}

function validateAttachmentPolicy(value: unknown) {
  const record = requireRecord(value, 'Attachment policy')
  const allowedMediaTypes = requireArray(record.allowedMediaTypes, 'Allowed media types')
    .map((entry) => requireText(entry, 'Allowed media type', 200).toLowerCase())
  return {
    enabled: requireBoolean(record.enabled, 'Attachment enabled'),
    maxFiles: requireInteger(record.maxFiles, 'Attachment max files', 1, 20),
    maxSizeBytes: requireInteger(record.maxSizeBytes, 'Attachment max bytes', 1, 50 * 1024 * 1024),
    allowedMediaTypes: [...new Set(allowedMediaTypes)],
  }
}

function validateConsent(value: unknown, defaultLocale: RequestLocale) {
  const record = requireRecord(value, 'Request consent')
  return {
    required: requireBoolean(record.required, 'Consent required'),
    label: requireLocalizedText(record.label, defaultLocale, 'Consent label'),
    ...(record.privacyUrl === undefined ? {} : { privacyUrl: requireSafeNavigationUrl(record.privacyUrl, 'Consent privacy URL') }),
  }
}

function requireLocalizedText(value: unknown, locale: RequestLocale, label: string) {
  const text = requireAnyLocalizedText(value, label)
  if (!text[locale]) throw invalidInput(`${label} requires the default locale.`)
  return text
}

function requireAnyLocalizedText(value: unknown, label: string) {
  const record = requireRecord(value, label)
  const ja = record.ja === undefined ? undefined : requireText(record.ja, `${label} ja`, 10_000)
  const en = record.en === undefined ? undefined : requireText(record.en, `${label} en`, 10_000)
  if (!ja && !en) throw invalidInput(`${label} requires ja or en text.`)
  return { ...(ja ? { ja } : {}), ...(en ? { en } : {}) }
}

function requireSafePattern(value: unknown) {
  const pattern = requireText(value, 'Validation pattern', 256)
  if (!isSafeRequestPattern(pattern)) {
    throw invalidInput('Validation pattern must use the restricted anchored syntax.')
  }
  try {
    new RegExp(pattern, 'u')
  } catch {
    throw invalidInput('Validation pattern is invalid.')
  }
  return pattern
}

function isSafeRequestPattern(pattern: string) {
  if (pattern.length < 2 || !pattern.startsWith('^') || !pattern.endsWith('$')) return false
  let escaped = false
  let insideCharacterClass = false
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!
    if (escaped) {
      if (/[1-9]/u.test(character) || character === 'k' && pattern[index + 1] === '<') return false
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === '[') {
      insideCharacterClass = true
      continue
    }
    if (character === ']' && insideCharacterClass) {
      insideCharacterClass = false
      continue
    }
    if (insideCharacterClass) continue
    if (character === '(' || character === ')' || character === '|' ||
      character === '*' || character === '+' || character === '?') return false
    if (character === '^' && index !== 0 || character === '$' && index !== pattern.length - 1) {
      return false
    }
    if (character === '}') return false
    if (character !== '{') continue
    const quantifier = pattern.slice(index).match(/^\{(\d+)\}/u)
    if (!quantifier) return false
    const count = Number(quantifier[1])
    if (
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > REQUEST_PATTERN_FIXED_QUANTIFIER_LIMIT
    ) return false
    index += quantifier[0].length - 1
  }
  return !escaped && !insideCharacterClass
}

function matchesRequestPattern(pattern: string, value: string) {
  const match = new RegExp(pattern, 'u').exec(value)
  return match?.[0] === value
}

function requireScope(value: unknown): RequestFormScope {
  const record = requireRecord(value, 'Request form scope')
  if (record.type === 'workspace' && record.teamId === undefined) return { type: 'workspace' }
  if (record.type === 'team') return { type: 'team', teamId: requireIdentifier(record.teamId, 'Scope Team ID') }
  throw invalidInput('Request form scope is invalid.')
}

function requireAccessMode(value: unknown): RequestFormAccessMode {
  if (value === 'public' || value === 'auth-required' || value === 'internal') return value
  throw invalidInput('Request form access mode is invalid.')
}

function requireRequestFormUpdateStatus(value: unknown): 'draft' | 'archived' {
  if (value === 'draft' || value === 'archived') return value
  throw invalidInput('Request form status is invalid.')
}

function requireRequestLocale(value: unknown): RequestLocale {
  if (value === 'ja' || value === 'en') return value
  throw invalidInput('Request locale is invalid.')
}

function requireFieldType(value: unknown): RequestFormFieldType {
  if (
    value === 'short-text' || value === 'long-text' || value === 'email' || value === 'url' ||
    value === 'number' || value === 'boolean' || value === 'date' || value === 'single-select' ||
    value === 'multi-select' || value === 'attachment'
  ) return value
  throw invalidInput('Request field type is invalid.')
}

function requireConditionOperator(value: unknown): RequestFormCondition['operator'] {
  if (value === 'equals' || value === 'not-equals' || value === 'contains' || value === 'is-empty' || value === 'is-not-empty') return value
  throw invalidInput('Request condition operator is invalid.')
}

function requirePriority(value: unknown): WorkItemPriority {
  if (value === 'high' || value === 'medium' || value === 'low') return value
  throw invalidInput('Routing priority is invalid.')
}

function requireHttpsUrl(value: unknown, label: string) {
  const text = requireText(value, label, 2_000)
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:') throw new Error('not https')
    return url.toString()
  } catch {
    throw invalidInput(`${label} must be a valid HTTPS URL.`)
  }
}

function requireSafeNavigationUrl(value: unknown, label: string) {
  const text = requireText(value, label, 2_000)
  if (text.startsWith('/') && !text.startsWith('//') && !text.includes('\\')) return text
  return requireHttpsUrl(text, label)
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidInput(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function requireArray(value: unknown, label: string) {
  if (!Array.isArray(value)) throw invalidInput(`${label} must be an array.`)
  return value
}

function requireIdentifier(value: unknown, label: string) {
  const text = requireText(value, label, 160)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(text)) throw invalidInput(`${label} is invalid.`)
  return text
}

function requireText(value: unknown, label: string, maxLength: number) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) throw invalidInput(`${label} is invalid.`)
  return value.trim()
}

function requireBoolean(value: unknown, label: string) {
  if (typeof value !== 'boolean') throw invalidInput(`${label} must be boolean.`)
  return value
}

function requireInteger(value: unknown, label: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw invalidInput(`${label} is invalid.`)
  return value as number
}

function requireFiniteNumber(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidInput(`${label} is invalid.`)
  return value
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
}

function isEmptyAnswer(value: unknown) {
  return value === undefined || value === null || value === '' || Array.isArray(value) && value.length === 0
}

function isValidIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function jsonByteLength(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function assertJsonByteLimit(value: unknown, maximum: number, label: string) {
  if (jsonByteLength(value) > maximum) {
    throw new RequestIntakeError(413, 'RequestPayloadTooLarge', `${label} is too large.`)
  }
}

function appendBoundedRequestHistory<T>(
  current: readonly T[],
  entry: T,
  maximumCount: number,
  maximumBytes: number,
) {
  const entries = [...current, entry].slice(-maximumCount)
  while (entries.length > 1 && jsonByteLength(entries) > maximumBytes) entries.shift()
  assertJsonByteLimit(entries, maximumBytes, 'Request history')
  return entries
}

function appendRequestMessage(
  current: readonly RequestSubmissionMessage[],
  message: RequestSubmissionMessage,
) {
  return appendBoundedRequestHistory(
    current,
    message,
    REQUEST_THREAD_MESSAGE_LIMIT,
    REQUEST_THREAD_TOTAL_BYTE_LIMIT,
  )
}

/** Submission root に保持する bounded event projection を作成します。 */
export function createRequestSubmissionEventProjection(
  current: readonly RequestSubmissionEvent[],
  event: RequestSubmissionEvent,
) {
  return appendBoundedRequestHistory(
    current,
    normalizeRequestSubmissionEvent(event),
    200,
    REQUEST_EVENT_TOTAL_BYTE_LIMIT,
  )
}

/**
 * Creates an immutable event Put for the owning Request submission transaction.
 *
 * @param tableName - Request Intake DynamoDB table name.
 * @param scopeKey - Submission Workspace partition key.
 * @param submissionId - Canonical submission identifier.
 * @param event - Event to append atomically.
 * @returns A DynamoDB transaction item for the immutable event row.
 */
function createRequestSubmissionEventTransactionPut(
  tableName: string,
  scopeKey: string,
  submissionId: string,
  event: RequestSubmissionEvent,
): RequestSubmissionEventTransactionItem {
  const normalizedSubmissionId = requireIdentifier(submissionId, 'Request submission ID')
  const normalizedEvent = normalizeRequestSubmissionEvent(event)
  const item: StoredRequestSubmissionEvent = {
    entryType: 'submission-event',
    scopeKey: requireText(scopeKey, 'Request submission event scope', 1_000),
    recordKey: createSubmissionEventRecordKey(normalizedSubmissionId, normalizedEvent),
    submissionId: normalizedSubmissionId,
    ...normalizedEvent,
  }
  assertStoredRequestItemSize(item)
  return {
    Put: {
      TableName: requireText(tableName, 'Request intake table name', 1_000),
      Item: item,
      ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
    },
  }
}

function assertStoredRequestItemSize(value: unknown) {
  assertJsonByteLimit(value, REQUEST_STORED_ITEM_BYTE_LIMIT, 'Request storage item')
}

function answerToText(value: RequestAnswerValue | undefined) {
  if (value === undefined) return ''
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

function removeUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>
}

function invalidInput(message: string) {
  return new RequestIntakeError(400, 'InvalidRequestIntakeInput', message)
}

function requestRateLimited() {
  return new RequestIntakeError(429, 'RequestRateLimited', 'Too many request attempts.')
}

/** DynamoDB と private S3 object を使う Request intake client です。 */
export class DynamoDbRequestIntakeClient implements RequestIntakeClient {
  /** Request intake table 名です。 */
  private readonly tableName: string
  /** Queue GSI 名です。 */
  private readonly queueIndexName: string
  /** DynamoDB document client です。 */
  private readonly documentClient: DynamoDBDocumentClient
  /** Local bootstrap 用 low-level DynamoDB client です。 */
  private readonly dynamoDbClient: DynamoDBClient
  /** Private/versioned object storage client です。 */
  private readonly objectClient: FileObjectClient
  /** Capability と abuse-control key の HMAC secret です。 */
  private readonly tokenHashSecret: string
  /** Link/client/hour ごとの基準 rate limit です。 */
  private readonly rateLimitPerHour: number
  /** Test で固定可能な clock です。 */
  private readonly now: () => Date
  /** High-entropy token generator です。 */
  private readonly token: () => string
  /** Local table を自動作成するかどうかです。 */
  private readonly bootstrapLocalTable: boolean
  /** Public Request Intake traffic の tenant lifecycle boundary です。 */
  private readonly tenantAvailability: RequestIntakeTenantAvailability
  /** Current Team configuration callback for Form Triage admission. */
  private readonly prepareFormTriageAdmission?: FormTriageAdmissionPreparer
  /** In-flight local table bootstrap promise です。 */
  private tableReady?: Promise<void>

  /** Production/local dependencies から Request intake client を作成します。 */
  constructor(options: DynamoDbRequestIntakeClientOptions = {}) {
    const endpoint = getConfiguredDynamoDbEndpoint()
    this.dynamoDbClient = options.dynamoDbClient ?? new DynamoDBClient(createAwsConfiguration(endpoint))
    this.documentClient = options.documentClient ?? DynamoDBDocumentClient.from(this.dynamoDbClient, {
      marshallOptions: { removeUndefinedValues: true },
    })
    this.tableName = options.tableName ?? readEnvironment('REQUEST_INTAKE_TABLE_NAME') ??
      'mukuroji-request-intake-local'
    this.queueIndexName = options.queueIndexName ?? readEnvironment('REQUEST_QUEUE_INDEX_NAME') ??
      REQUEST_QUEUE_INDEX_NAME
    this.objectClient = options.objectClient ?? createDefaultRequestObjectClient()
    this.tokenHashSecret = options.tokenHashSecret ?? readCapabilitySecret()
    this.rateLimitPerHour = requirePositiveInteger(
      options.rateLimitPerHour ?? Number(readEnvironment('REQUEST_RATE_LIMIT_PER_HOUR') ?? 10),
      'Request rate limit',
    )
    this.now = options.now ?? (() => new Date())
    this.token = options.token ?? (() => randomBytes(32).toString('base64url'))
    this.bootstrapLocalTable = options.bootstrapLocalTable ?? Boolean(endpoint)
    this.tenantAvailability = options.tenantAvailability ?? ALLOW_ACTIVE_TENANT
    this.prepareFormTriageAdmission = options.prepareFormTriageAdmission
  }

  /** Workspace の form 一覧を返します。 */
  async listForms(workspaceId: string) {
    await this.ensureReady()
    const scopeKey = createWorkspaceScopeKey(workspaceId)
    const items: Record<string, unknown>[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'scopeKey = :scopeKey AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: {
          ':scopeKey': scopeKey,
          ':prefix': 'FORM_ROOT#',
        },
        ConsistentRead: true,
        ExclusiveStartKey: exclusiveStartKey,
      }))
      items.push(...(response.Items ?? []))
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)
    const forms = items.map(readStoredForm)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((form) => this.toFormView(form))
    return { forms }
  }

  /** Workspace 内の form を strong read します。 */
  async getForm(workspaceId: string, formId: string) {
    return this.toFormView(await this.getStoredForm(workspaceId, formId))
  }

  private async getStoredForm(workspaceId: string, formId: string) {
    await this.ensureReady()
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        scopeKey: createWorkspaceScopeKey(workspaceId),
        recordKey: createFormRecordKey(formId),
      },
      ConsistentRead: true,
    }))
    if (!response.Item) throw new RequestIntakeError(404, 'RequestFormNotFound', 'Request form was not found.')
    return readStoredForm(response.Item)
  }

  /** Workspace に form draft と capability link を作成します。 */
  async createForm(
    workspaceId: string,
    actor: RequestIntakeActor,
    input: CreateRequestFormInput,
  ) {
    await this.ensureReady()
    const now = this.now().toISOString()
    const formId = createSortableId('form', this.now(), randomUUID())
    const linkId = createSortableId('link', this.now(), randomUUID())
    const scopeKey = createWorkspaceScopeKey(workspaceId)
    const accessMode = requireAccessMode(input.accessMode)
    const expiresAt = readOptionalFutureTimestamp(input.expiresAt, this.now(), 'Request link expiry')
    const form: StoredRequestForm = {
      entryType: 'form',
      scopeKey,
      recordKey: createFormRecordKey(formId),
      id: formId,
      name: requireText(input.name, 'Request form name', 200),
      scope: requireScope(input.scope),
      status: 'draft',
      revision: 1,
      draft: validateRequestFormDraft(input.draft),
      publishedVersions: [],
      link: {
        linkId,
        accessMode,
        ...(expiresAt ? { expiresAt } : {}),
      },
      createdAt: now,
      updatedAt: now,
      capabilities: editableFormCapabilities,
    }
    assertFormScopeMatchesRouting(form.scope, form.draft.routing)
    assertStoredRequestItemSize(form)
    const lookup = this.createLinkLookup(form)
    assertStoredRequestItemSize(lookup)
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: form,
              ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: lookup,
              ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
            },
          },
        ],
      }))
      return this.toFormView(form)
    } catch (error) {
      throw toRequestStoreError(error)
    }
  }

  /** Form draft/link を revision 条件付きで更新します。 */
  async updateForm(
    workspaceId: string,
    formId: string,
    _actor: RequestIntakeActor,
    input: UpdateRequestFormInput,
  ) {
    const current = await this.getStoredForm(workspaceId, formId)
    requireExpectedRevision(input.expectedRevision, current.revision)
    const nowDate = this.now()
    const now = nowDate.toISOString()
    const nextScope = input.scope === undefined ? current.scope : requireScope(input.scope)
    const nextDraft = input.draft === undefined ? current.draft : validateRequestFormDraft(input.draft)
    assertFormScopeMatchesRouting(nextScope, nextDraft.routing)
    const accessMode = input.accessMode === undefined
      ? current.link.accessMode
      : requireAccessMode(input.accessMode)
    const expiresAt = input.expiresAt === undefined
      ? current.link.expiresAt
      : input.expiresAt === null
        ? undefined
        : readOptionalFutureTimestamp(input.expiresAt, nowDate, 'Request link expiry')
    const status = input.status === undefined
      ? current.status
      : requireRequestFormUpdateStatus(input.status)
    const rotate = input.rotateLinkToken === true ||
      current.status === 'archived' && status !== 'archived'
    const link = {
      linkId: rotate ? createSortableId('link', nowDate, randomUUID()) : current.link.linkId,
      accessMode,
      ...(expiresAt ? { expiresAt } : {}),
      ...(status === 'archived' ? { revokedAt: now } : {}),
    }
    const next: StoredRequestForm = {
      ...current,
      entryType: 'form',
      scopeKey: createWorkspaceScopeKey(workspaceId),
      recordKey: createFormRecordKey(formId),
      name: input.name === undefined ? current.name : requireText(input.name, 'Request form name', 200),
      scope: nextScope,
      status,
      revision: current.revision + 1,
      draft: nextDraft,
      link,
      updatedAt: now,
      capabilities: editableFormCapabilities,
    }
    assertStoredRequestItemSize(next)
    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Put: {
          TableName: this.tableName,
          Item: next,
          ConditionExpression: 'revision = :expectedRevision AND entryType = :entryType',
          ExpressionAttributeValues: {
            ':expectedRevision': input.expectedRevision,
            ':entryType': 'form',
          },
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: this.createLinkLookup(next),
        },
      },
    ]
    if (rotate) {
      transactItems.push({
        Update: {
          TableName: this.tableName,
          Key: {
            scopeKey: createLookupScopeKey('LINK', this.hashToken('link', this.deriveLinkToken(current))),
            recordKey: 'LOOKUP',
          },
          UpdateExpression: 'SET revokedAt = :revokedAt',
          ExpressionAttributeValues: { ':revokedAt': now },
        },
      })
    }
    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactItems }))
      return this.toFormView(next)
    } catch (error) {
      if (isConditionalFailure(error)) throw revisionConflict('Request form')
      throw toRequestStoreError(error)
    }
  }

  /** Current draft を immutable version として公開します。 */
  async publishForm(
    workspaceId: string,
    formId: string,
    actor: RequestIntakeActor,
    input: PublishRequestFormInput,
  ) {
    const current = await this.getStoredForm(workspaceId, formId)
    requireExpectedRevision(input.expectedRevision, current.revision)
    if (current.status === 'archived') {
      throw new RequestIntakeError(409, 'RequestFormArchived', 'Archived request form cannot be published.')
    }
    const snapshot = validateRequestFormDraft(current.draft)
    assertFormScopeMatchesRouting(current.scope, snapshot.routing)
    const versionNumber = (current.currentPublishedVersion ?? 0) + 1
    const now = this.now().toISOString()
    const scopeKey = createWorkspaceScopeKey(workspaceId)
    const version: StoredRequestFormVersion = {
      entryType: 'form-version',
      scopeKey,
      recordKey: createFormVersionRecordKey(formId, versionNumber),
      schemaVersion: REQUEST_FORM_SCHEMA_VERSION,
      formId,
      version: versionNumber,
      snapshot,
      createdBy: requireText(actor.id, 'Request form publisher', 320),
      createdAt: now,
    }
    const next: StoredRequestForm = {
      ...current,
      entryType: 'form',
      scopeKey,
      recordKey: createFormRecordKey(formId),
      status: 'published',
      revision: current.revision + 1,
      currentPublishedVersion: versionNumber,
      publishedVersions: [...current.publishedVersions, versionNumber],
      updatedAt: now,
      capabilities: editableFormCapabilities,
    }
    assertStoredRequestItemSize(version)
    assertStoredRequestItemSize(next)
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: version,
              ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: next,
              ConditionExpression: 'revision = :expectedRevision AND entryType = :entryType',
              ExpressionAttributeValues: {
                ':expectedRevision': input.expectedRevision,
                ':entryType': 'form',
              },
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: this.createLinkLookup(next),
            },
          },
        ],
      }))
      return this.toFormView(next)
    } catch (error) {
      if (isConditionalFailure(error)) throw revisionConflict('Request form')
      throw toRequestStoreError(error)
    }
  }

  /** Opaque link token を内部 form scope へ strong lookup します。 */
  async resolveLink(token: string) {
    await this.ensureReady()
    const normalizedToken = requireCapabilityToken(token, 'Request link token')
    const tokenDigest = this.hashToken('link', normalizedToken)
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        scopeKey: createLookupScopeKey('LINK', tokenDigest),
        recordKey: 'LOOKUP',
      },
      ConsistentRead: true,
    }))
    const lookup = readLinkLookup(response.Item)
    const now = this.now()
    if (
      lookup.revokedAt ||
      lookup.expiresAtIso && Date.parse(lookup.expiresAtIso) <= now.getTime()
    ) throw unavailableForm()
    await this.requireTenantActive(lookup.workspaceId)
    const form = await this.getStoredForm(lookup.workspaceId, lookup.formId)
    if (
      form.status !== 'published' ||
      !form.currentPublishedVersion ||
      form.link.linkId !== lookup.linkId ||
      this.deriveLinkToken(form) !== normalizedToken
    ) throw unavailableForm()
    return {
      workspaceId: lookup.workspaceId,
      formId: lookup.formId,
      accessMode: lookup.accessMode,
      tokenDigest,
    }
  }

  /** 認可済み link から public DTO と one-time session を返します。 */
  async getPublicForm(
    resolution: RequestLinkResolution,
    context: RequestExternalContext,
  ) {
    await this.ensureReady()
    await this.requireTenantActive(resolution.workspaceId)
    await this.consumeLinkRateLimits(
      resolution,
      context,
      'form',
      this.rateLimitPerHour * 5,
      this.rateLimitPerHour * 100,
    )
    const form = await this.getStoredForm(resolution.workspaceId, resolution.formId)
    if (form.status !== 'published' || !form.currentPublishedVersion) throw unavailableForm()
    const version = await this.getFormVersion(
      resolution.workspaceId,
      resolution.formId,
      form.currentPublishedVersion,
    )
    const now = this.now()
    const sessionToken = this.token()
    const sessionDigest = this.hashToken('session', sessionToken)
    const minimumSubmitAt = new Date(now.getTime() + 1_000).toISOString()
    const expiresAtDate = new Date(now.getTime() + 15 * 60_000)
    const session: StoredSubmissionSession = {
      entryType: 'submission-session',
      scopeKey: createLookupScopeKey('SESSION', sessionDigest),
      recordKey: 'LOOKUP',
      workspaceId: resolution.workspaceId,
      formId: resolution.formId,
      formVersion: version.version,
      linkDigest: resolution.tokenDigest,
      minimumSubmitAt,
      expiresAtIso: expiresAtDate.toISOString(),
      expiresAt: Math.floor(expiresAtDate.getTime() / 1_000),
    }
    assertStoredRequestItemSize(session)
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          ...this.createTenantWriteGuard(resolution.workspaceId),
          {
            Put: {
              TableName: this.tableName,
              Item: session,
              ConditionExpression:
                'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
            },
          },
        ],
      }))
    } catch (error) {
      if (isConditionalFailure(error)) throw unavailableForm()
      throw toRequestStoreError(error)
    }
    return {
      schemaVersion: REQUEST_FORM_SCHEMA_VERSION,
      formId: version.formId,
      version: version.version,
      accessMode: resolution.accessMode,
      definition: version.snapshot.definition,
      submissionSession: {
        token: sessionToken,
        expiresAt: session.expiresAtIso,
        minimumSubmitAt,
      },
    } satisfies PublicRequestForm
  }

  /** Request 専用 direct attachment upload session を作成します。 */
  async createAttachmentUpload(
    resolution: RequestLinkResolution,
    input: RequestAttachmentUploadInput,
    context: RequestExternalContext,
  ) {
    await this.requireTenantActive(resolution.workspaceId)
    const session = await this.getActiveSession(resolution, input.sessionToken, false)
    if (session.usedAt) {
      throw new RequestIntakeError(409, 'RequestSessionConsumed', 'Submission session was already used.')
    }
    await this.consumeLinkRateLimits(
      resolution,
      context,
      'upload',
      this.rateLimitPerHour * 3,
      this.rateLimitPerHour * 20,
    )
    const version = await this.getFormVersion(session.workspaceId, session.formId, session.formVersion)
    const fieldId = requireIdentifier(input.fieldId, 'Attachment field ID')
    const field = findFormField(version.snapshot.definition, fieldId)
    const policy = version.snapshot.definition.attachments
    if (field?.type !== 'attachment' || !policy?.enabled) {
      throw invalidInput('Attachment field is not enabled for this form version.')
    }
    const fileName = normalizeFileName(input.fileName)
    const contentType = requireText(input.contentType, 'Attachment content type', 200).toLowerCase()
    const sizeBytes = requireInteger(input.sizeBytes, 'Attachment size', 1, policy.maxSizeBytes)
    if (!policy.allowedMediaTypes.includes(contentType)) {
      throw invalidInput('Attachment media type is not allowed.')
    }
    await this.reserveAttachmentUpload(session, policy.maxFiles, policy.maxSizeBytes, sizeBytes)
    const attachmentId = createSortableId('attachment', this.now(), randomUUID())
    const claimToken = this.token()
    const objectKey = createRequestObjectKey(session.workspaceId, attachmentId)
    const upload = await this.objectClient.createUpload({ objectKey, contentType, sizeBytes })
    const now = this.now()
    const stored: StoredAttachmentUpload = {
      entryType: 'attachment-upload',
      scopeKey: createWorkspaceScopeKey(session.workspaceId),
      recordKey: createUploadRecordKey(attachmentId),
      attachmentId,
      formId: session.formId,
      formVersion: session.formVersion,
      fieldId,
      sessionDigest: this.hashToken('session', input.sessionToken),
      claimDigest: this.hashToken('attachment-claim', claimToken),
      fileName,
      contentType,
      sizeBytes,
      objectKey,
      scanStatus: 'pending',
      createdAt: now.toISOString(),
      expiresAt: Math.floor((now.getTime() + 24 * 60 * 60_000) / 1_000),
    }
    assertStoredRequestItemSize(stored)
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          ...this.createTenantWriteGuard(session.workspaceId),
          {
            Put: {
              TableName: this.tableName,
              Item: stored,
              ConditionExpression:
                'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
            },
          },
        ],
      }))
    } catch (error) {
      if (isConditionalFailure(error)) throw unavailableForm()
      throw toRequestStoreError(error)
    }
    return {
      attachmentId,
      fieldId,
      claimToken,
      upload: {
        url: upload.url,
        method: 'PUT',
        headers: upload.headers,
        expiresAt: upload.expiresAt,
        maxSizeBytes: Math.min(upload.maxSizeBytes, policy.maxSizeBytes),
      },
    } satisfies RequestAttachmentUploadSession
  }

  /** One-time session を consume して submission を保存します。 */
  async submit(
    resolution: RequestLinkResolution,
    input: SubmitRequestInput,
    context: RequestExternalContext,
  ) {
    await this.requireTenantActive(resolution.workspaceId)
    if (typeof input.honeypot === 'string' && input.honeypot.trim()) {
      throw invalidInput('Request submission is invalid.')
    }
    const session = await this.getActiveSession(resolution, input.sessionToken, true)
    if (!session.usedAt) {
      await this.consumeLinkRateLimits(
        resolution,
        context,
        'submit',
        this.rateLimitPerHour,
        this.rateLimitPerHour * 20,
      )
    }
    const version = await this.getFormVersion(session.workspaceId, session.formId, session.formVersion)
    const locale = requireRequestLocale(input.locale)
    const answers = validateRequestAnswers(version.snapshot.definition, locale, input.answers)
    const consent = version.snapshot.definition.consent
    if (consent?.required && input.consentAccepted !== true) {
      throw invalidInput('Consent is required for this form version.')
    }
    if (input.consentAccepted !== undefined && typeof input.consentAccepted !== 'boolean') {
      throw invalidInput('Consent state is invalid.')
    }
    const inputFingerprint = stableHash({
      formId: session.formId,
      version: session.formVersion,
      locale,
      answers,
      consentAccepted: input.consentAccepted === true,
    })
    if (session.usedAt) {
      if (session.inputFingerprint === inputFingerprint && session.receipt) {
        await this.consumeReplayRateLimit(
          { ...resolution, tokenDigest: session.scopeKey },
        )
        const replayedSubmission = await this.getStoredSubmission(
          session.workspaceId,
          session.receipt.submissionId,
        )
        await this.finalizeSubmissionAttachments(replayedSubmission)
        return this.toSubmissionReceipt(session.workspaceId, session.receipt)
      }
      throw new RequestIntakeError(409, 'RequestSessionConsumed', 'Submission session was already used.')
    }
    const attachmentReferences = version.snapshot.definition.sections.flatMap((section) =>
      section.fields.filter((field) => field.type === 'attachment').flatMap((field) => {
        const value = answers[field.id]
        return Array.isArray(value)
          ? value.map((attachmentId) => ({ attachmentId, fieldId: field.id }))
          : []
      })
    )
    const policy = version.snapshot.definition.attachments
    if (attachmentReferences.length > (policy?.maxFiles ?? 0)) {
      throw invalidInput('Submission contains too many attachments.')
    }
    if (new Set(attachmentReferences.map(({ attachmentId }) => attachmentId)).size !== attachmentReferences.length) {
      throw invalidInput('An attachment cannot be submitted more than once.')
    }
    const attachmentClaims = validateAttachmentClaims(
      input.attachmentClaims,
      attachmentReferences.map(({ attachmentId }) => attachmentId),
    )
    const uploads = await Promise.all(attachmentReferences.map(({ attachmentId, fieldId }) =>
      this.getVerifiedUpload(
        session,
        requireIdentifier(attachmentId, 'Attachment ID'),
        fieldId,
        attachmentClaims[attachmentId],
      )
    ))
    const nowDate = this.now()
    const now = nowDate.toISOString()
    const submissionId = createSortableId('req', nowDate, randomUUID())
    const receiptId = createSortableId('rcpt', nowDate, randomUUID())
    const threadToken = this.deriveThreadToken(session.workspaceId, submissionId, receiptId)
    const threadDigest = this.hashToken('thread', threadToken)
    const routingTarget = resolveRequestRouting(version.snapshot.routing, answers)
    const requesterEmail = findRequesterEmail(version.snapshot.definition, answers)
    const duplicateFingerprint = this.hashToken(
      'duplicate',
      stableStringify({ formId: session.formId, answers }),
    )
    const duplicatePointerKey = createLookupScopeKey(
      'DUPLICATE',
      this.hashToken('duplicate-scope', `${session.workspaceId}\0${session.formId}\0${duplicateFingerprint}`),
    )
    const duplicateResponse = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { scopeKey: duplicatePointerKey, recordKey: 'LATEST' },
      ConsistentRead: true,
    }))
    const duplicateCandidate = readDuplicatePointer(duplicateResponse.Item, nowDate)
    const event: RequestSubmissionEvent = {
      id: createSortableId('event', nowDate, randomUUID()),
      type: 'submitted',
      actorId: 'requester',
      summary: 'Request was submitted.',
      createdAt: now,
    }
    const attachments: RequestAttachment[] = uploads.map(({ stored, verified }) => ({
      id: stored.attachmentId,
      fieldId: stored.fieldId,
      fileName: stored.fileName,
      contentType: stored.contentType,
      sizeBytes: verified.sizeBytes,
      scanStatus: verified.scanStatus,
    }))
    const submission: StoredRequestSubmission = {
      entryType: 'submission',
      scopeKey: createWorkspaceScopeKey(session.workspaceId),
      recordKey: createSubmissionRecordKey(submissionId),
      queueKey: createWorkspaceScopeKey(session.workspaceId),
      queueRecordKey: `${now}#${submissionId}`,
      schemaVersion: REQUEST_SUBMISSION_SCHEMA_VERSION,
      id: submissionId,
      receiptId,
      formId: session.formId,
      formVersion: session.formVersion,
      formSnapshot: toRequestFormVersion(version),
      status: 'received',
      source: 'web',
      revision: 1,
      locale,
      answers,
      ...(consent
        ? {
            consent: {
              accepted: input.consentAccepted === true,
              label: consent.label,
              ...(input.consentAccepted === true ? { acceptedAt: now } : {}),
            },
          }
        : {}),
      attachments,
      routingTarget,
      triageAssigneeUserId: routingTarget.assigneeUserId,
      workItemMapping: version.snapshot.routing.mapping,
      duplicateCandidateIds: duplicateCandidate ? [duplicateCandidate.submissionId] : [],
      messages: [],
      events: [event],
      createdAt: now,
      updatedAt: now,
      capabilities: activeSubmissionCapabilities,
      ...(requesterEmail ? { requesterEmail } : {}),
      threadDigest,
      duplicateFingerprint,
      attachmentObjectKeys: Object.fromEntries(uploads.map(({ stored }) => [stored.attachmentId, stored.objectKey])),
      attachmentObjectVersionIds: Object.fromEntries(uploads.map(({ stored, verified }) => [stored.attachmentId, verified.objectVersionId])),
    }
    const baseTriageEntry = createFormTriageEntry(
      session.workspaceId,
      submission,
      resolution.accessMode,
    )
    const confirmationMessage = resolveLocalizedText(
      version.snapshot.definition.confirmation.message,
      locale,
      version.snapshot.definition.defaultLocale,
    )
    const storedReceipt: StoredSubmissionReceipt = {
      receiptId,
      submissionId,
      submittedAt: now,
      confirmationMessage,
    }
    const receipt: RequestSubmissionReceipt = {
      receiptId,
      submittedAt: now,
      confirmationMessage,
      threadToken,
    }
    const threadLookup: StoredThreadLookup = {
      entryType: 'thread-lookup',
      scopeKey: createLookupScopeKey('THREAD', threadDigest),
      recordKey: 'LOOKUP',
      workspaceId: session.workspaceId,
      submissionId,
      ...(requesterEmail ? { requesterEmail } : {}),
      expiresAt: Math.floor((nowDate.getTime() + 365 * 24 * 60 * 60_000) / 1_000),
    }
    assertStoredRequestItemSize(submission)
    assertStoredRequestItemSize(threadLookup)
    const baseTransactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      ...this.createTenantWriteGuard(session.workspaceId),
      {
        Put: {
          TableName: this.tableName,
          Item: submission,
          ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
        },
      },
      {
        Update: {
          TableName: this.tableName,
          Key: { scopeKey: session.scopeKey, recordKey: 'LOOKUP' },
          UpdateExpression: 'SET usedAt = :usedAt, inputFingerprint = :fingerprint, receipt = :receipt',
          ConditionExpression: 'attribute_not_exists(usedAt) AND expiresAt >= :nowEpoch',
          ExpressionAttributeValues: {
            ':usedAt': now,
            ':fingerprint': inputFingerprint,
            ':receipt': storedReceipt,
            ':nowEpoch': Math.floor(nowDate.getTime() / 1_000),
          },
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: threadLookup,
          ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: {
            entryType: 'duplicate-pointer',
            scopeKey: duplicatePointerKey,
            recordKey: 'LATEST',
            workspaceId: session.workspaceId,
            formId: session.formId,
            submissionId,
            createdAt: now,
            expiresAt: Math.floor((nowDate.getTime() + 30 * 24 * 60 * 60_000) / 1_000),
          },
        },
      },
      ...uploads.map(({ stored, verified }) => ({
        Update: {
          TableName: this.tableName,
          Key: { scopeKey: stored.scopeKey, recordKey: stored.recordKey },
          UpdateExpression: 'SET submissionId = :submissionId, objectVersionId = :versionId, scanStatus = :scanStatus REMOVE expiresAt',
          ConditionExpression: 'claimDigest = :claimDigest AND attribute_not_exists(submissionId)',
          ExpressionAttributeValues: {
            ':submissionId': submissionId,
            ':versionId': verified.objectVersionId,
            ':scanStatus': verified.scanStatus,
            ':claimDigest': stored.claimDigest,
          },
        },
      })),
      createRequestSubmissionEventTransactionPut(
        this.tableName,
        submission.scopeKey,
        submissionId,
        event,
      ),
    ]
    let commitError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let admission: TriageAdmissionTransactionContribution
      try {
        admission = this.prepareFormTriageAdmission
          ? await this.prepareFormTriageAdmission(baseTriageEntry)
          : { entry: baseTriageEntry, transactItems: [] }
      } catch (error) {
        commitError = error
        break
      }
      requireSameFormTriageAdmission(baseTriageEntry, admission.entry)
      const triageTransactItems = createFormTriageEntryTransactionItems({
        tableName: this.tableName,
        entry: admission.entry,
        inputFingerprint,
      })
      const retryableConflictItemIndexes = admission.retryableConflictItemIndexes?.map(
        (itemIndex) => baseTransactItems.length + triageTransactItems.length + itemIndex,
      ) ?? []
      const transactItems = [
        ...baseTransactItems,
        ...triageTransactItems,
        ...admission.transactItems,
      ]
      try {
        await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactItems }))
        await this.finalizeSubmissionAttachments(submission)
        return receipt
      } catch (error) {
        if (
          retryableConflictItemIndexes.length > 0 &&
          isOnlyConditionalFailureAtAny(error, retryableConflictItemIndexes)
        ) {
          if (attempt < 2) continue
          commitError = new RequestIntakeError(
            409,
            'TriageAdmissionConflict',
            'Triage routing changed while the request was submitted. Retry the submission.',
            { cause: error },
          )
          break
        }
        commitError = error
        break
      }
    }
    if (isConditionalFailure(commitError)) {
      if (!await this.tenantAvailability.isActive(resolution.workspaceId)) {
        throw unavailableForm()
      }
      const replay = await this.getSessionByDigest(this.hashToken('session', input.sessionToken))
      if (replay.inputFingerprint === inputFingerprint && replay.receipt) {
        await this.consumeReplayRateLimit(
          { ...resolution, tokenDigest: replay.scopeKey },
        )
        const replayedSubmission = await this.getStoredSubmission(
          replay.workspaceId,
          replay.receipt.submissionId,
        )
        await this.finalizeSubmissionAttachments(replayedSubmission)
        return this.toSubmissionReceipt(replay.workspaceId, replay.receipt)
      }
      throw new RequestIntakeError(409, 'RequestSessionConsumed', 'Submission session was already used.')
    }
    throw toRequestStoreError(commitError)
  }

  /** Workspace intake queue を cursor pagination します。 */
  async listSubmissions(workspaceId: string, options: RequestSubmissionListOptions = {}) {
    await this.ensureReady()
    const limit = options.limit === undefined
      ? 50
      : requireInteger(options.limit, 'Request queue limit', 1, 100)
    const queueKey = createWorkspaceScopeKey(workspaceId)
    let exclusiveStartKey = options.cursor
      ? decodeQueueCursor(options.cursor, queueKey, options.status)
      : undefined
    const storedSubmissions: StoredRequestSubmission[] = []
    let nextCursorKey: Record<string, unknown> | undefined
    const evaluatedCursors = new Set<string>()
    do {
      if (exclusiveStartKey) {
        const cursorFingerprint = stableStringify(exclusiveStartKey)
        if (evaluatedCursors.has(cursorFingerprint)) throw requestStoreUnavailable()
        evaluatedCursors.add(cursorFingerprint)
      }
      const remaining = limit - storedSubmissions.length
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        IndexName: this.queueIndexName,
        KeyConditionExpression: 'queueKey = :queueKey',
        ...(options.status ? { FilterExpression: '#status = :status' } : {}),
        ExpressionAttributeNames: options.status ? { '#status': 'status' } : undefined,
        ExpressionAttributeValues: {
          ':queueKey': queueKey,
          ...(options.status ? { ':status': options.status } : {}),
        },
        ScanIndexForward: false,
        Limit: options.status ? 100 : remaining,
        ExclusiveStartKey: exclusiveStartKey,
      }))
      const matched = (response.Items ?? []).map(readStoredSubmission)
      storedSubmissions.push(...matched.slice(0, remaining))
      if (matched.length > remaining) {
        nextCursorKey = createQueueCursorKey(matched[remaining - 1]!)
        if (evaluatedCursors.has(stableStringify(nextCursorKey))) throw requestStoreUnavailable()
        break
      }
      if (storedSubmissions.length >= limit) {
        nextCursorKey = response.LastEvaluatedKey
        if (
          nextCursorKey &&
          evaluatedCursors.has(stableStringify(nextCursorKey))
        ) throw requestStoreUnavailable()
        break
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (storedSubmissions.length < limit && exclusiveStartKey)
    const submissions = storedSubmissions.map((stored) => toRequestSubmissionView(stored))
    return {
      submissions,
      ...(nextCursorKey
        ? { nextCursor: encodeQueueCursor(queueKey, options.status, nextCursorKey) }
        : {}),
    }
  }

  /** Submission detail を strong read し scan status を refresh します。 */
  async getSubmission(workspaceId: string, submissionId: string) {
    const stored = await this.getStoredSubmission(workspaceId, submissionId)
    const attachments = await Promise.all(stored.attachments.map(async (attachment) => {
      const objectKey = stored.attachmentObjectKeys[attachment.id]
      if (!objectKey) return attachment
      if (attachment.scanStatus === 'available') return attachment
      if (attachment.scanStatus !== 'pending' && attachment.scanStatus !== 'scanning') return attachment
      const scanStatus = await this.objectClient.getScanStatus(
        objectKey,
        stored.attachmentObjectVersionIds[attachment.id],
      )
        .catch(() => attachment.scanStatus)
      return { ...attachment, scanStatus }
    }))
    const refreshed = { ...stored, attachments }
    if (
      !stored.attachmentFinalizedAt &&
      attachments.every((attachment) => attachment.scanStatus === 'available')
    ) {
      await this.finalizeSubmissionAttachments(refreshed)
    }
    const events = await this.getSubmissionEvents(workspaceId, submissionId)
    return toRequestSubmissionView(refreshed, events)
  }

  /** Convert 以外の explicit triage action を適用します。 */
  async applyAction(
    workspaceId: string,
    submissionId: string,
    actor: RequestIntakeActor,
    input: Exclude<RequestSubmissionActionInput, { action: 'convert' }>,
    additionalTransactionItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [],
  ) {
    const current = await this.getStoredSubmission(workspaceId, submissionId)
    requireExpectedRevision(input.expectedRevision, current.revision)
    assertSubmissionMutable(current)
    const nowDate = this.now()
    const now = nowDate.toISOString()
    let nextStatus = current.status
    let triageAssigneeUserId = current.triageAssigneeUserId
    let duplicateOfSubmissionId = current.duplicateOfSubmissionId
    const messages = [...current.messages]
    let eventType: RequestSubmissionEvent['type']
    let summary: string
    if (input.action === 'assign') {
      triageAssigneeUserId = input.assigneeUserId === null
        ? undefined
        : requireText(input.assigneeUserId, 'Request assignee', 320).toLowerCase()
      nextStatus = 'triaging'
      eventType = 'assigned'
      summary = triageAssigneeUserId
        ? 'Request was assigned for triage.'
        : 'Request was left unowned in triage.'
    } else if (input.action === 'request-more-info') {
      const body = requireText(input.message, 'More information message', 10_000)
      nextStatus = 'needs-more-info'
      messages.push({
        id: createSortableId('message', nowDate, randomUUID()),
        direction: 'internal',
        source: 'internal',
        body,
        createdAt: now,
      })
      eventType = 'more-info-requested'
      summary = 'More information was requested.'
    } else if (input.action === 'reject') {
      const reason = requireText(input.reason, 'Request rejection reason', 2_000)
      nextStatus = 'rejected'
      eventType = 'rejected'
      summary = `Request was rejected: ${reason}`
    } else if (input.action === 'mark-duplicate') {
      const duplicateAction: MarkDuplicateRequestSubmissionAction = input
      duplicateOfSubmissionId = requireIdentifier(
        duplicateAction.duplicateOfSubmissionId,
        'Duplicate submission ID',
      )
      if (duplicateOfSubmissionId === current.id) throw invalidInput('Submission cannot duplicate itself.')
      const duplicateTarget = await this.getSubmission(workspaceId, duplicateOfSubmissionId)
      if (duplicateTarget.status === 'duplicate') {
        throw invalidInput('Submission cannot target another duplicate request.')
      }
      nextStatus = 'duplicate'
      eventType = 'duplicate-marked'
      summary = 'Request was marked as a duplicate.'
    } else {
      throw invalidInput('Request action is invalid.')
    }
    const event: RequestSubmissionEvent = {
      id: createSortableId('event', nowDate, randomUUID()),
      type: eventType,
      actorId: requireText(actor.id, 'Request actor', 320),
      summary,
      createdAt: now,
    }
    const persistedEvents = await this.getSubmissionEvents(workspaceId, submissionId)
    const assignmentBase = triageAssigneeUserId
      ? { ...current, triageAssigneeUserId }
      : removeRequestTriageAssignee(current)
    const next = {
      ...assignmentBase,
      status: nextStatus,
      revision: current.revision + 1,
      ...(duplicateOfSubmissionId ? { duplicateOfSubmissionId } : {}),
      messages: messages.reduce<RequestSubmissionMessage[]>((history, message) =>
        appendRequestMessage(history, message), []),
      events: createRequestSubmissionEventProjection(current.events, event),
      updatedAt: now,
      capabilities: terminalSubmissionStatuses.has(nextStatus)
        ? terminalSubmissionCapabilities
        : activeSubmissionCapabilities,
    } satisfies StoredRequestSubmission
    await this.putSubmissionWithRevision(
      next,
      current.revision,
      event,
      additionalTransactionItems,
    )
    return toRequestSubmissionView(
      next,
      appendCompleteRequestSubmissionEventHistory(current, persistedEvents, event),
    )
  }

  /** Stores the Work Item trace projection with optional cross-domain transaction items.
   *
   * @param workspaceId - Owning Workspace identifier.
   * @param submissionId - Source Request submission identifier.
   * @param actor - Authenticated Request actor.
   * @param input - Canonical Work Item projection and expected revision.
   * @param additionalTransactionItems - Narrow atomic contributions owned by another domain.
   * @returns The resulting terminal Request submission.
   */
  async completeConversion(
    workspaceId: string,
    submissionId: string,
    actor: RequestIntakeActor,
    input: RequestConversionProjection,
    additionalTransactionItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [],
  ) {
    const current = await this.getStoredSubmission(workspaceId, submissionId)
    if (current.status === 'converted' && current.workItem && sameWorkItem(current.workItem, input.workItem)) {
      const events = await this.getSubmissionEvents(workspaceId, submissionId)
      return toRequestSubmissionView(current, events)
    }
    requireExpectedRevision(input.expectedRevision, current.revision)
    assertSubmissionMutable(current)
    const nowDate = this.now()
    const now = nowDate.toISOString()
    const event: RequestSubmissionEvent = {
      id: createSortableId('event', nowDate, randomUUID()),
      type: 'converted',
      actorId: requireText(actor.id, 'Request actor', 320),
      summary: 'Request was converted to a Work Item.',
      createdAt: now,
    }
    const persistedEvents = await this.getSubmissionEvents(workspaceId, submissionId)
    const next: StoredRequestSubmission = {
      ...current,
      status: 'converted',
      revision: current.revision + 1,
      workItem: validateWorkItemReference(input.workItem),
      events: createRequestSubmissionEventProjection(current.events, event),
      updatedAt: now,
      capabilities: terminalSubmissionCapabilities,
    }
    await this.putSubmissionWithRevision(
      next,
      current.revision,
      event,
      additionalTransactionItems,
    )
    return toRequestSubmissionView(
      next,
      appendCompleteRequestSubmissionEventHistory(current, persistedEvents, event),
    )
  }

  /** External capability thread の allowlist 済み message view を返します。 */
  async getRequesterThread(
    threadToken: string,
    context: RequestExternalContext,
  ): Promise<RequestRequesterThread> {
    await this.ensureReady()
    const threadDigest = this.hashToken(
      'thread',
      requireCapabilityToken(threadToken, 'Request thread token'),
    )
    const lookup = await this.getThreadLookup(threadDigest)
    await this.requireTenantActive(lookup.workspaceId)
    await this.consumeThreadReadRateLimit(lookup.workspaceId, threadDigest, context)
    const submission = await this.getStoredSubmission(lookup.workspaceId, lookup.submissionId)
    return {
      status: terminalSubmissionStatuses.has(submission.status) ? 'closed' : 'open',
      messages: submission.messages.map((message) => ({
        id: message.id,
        direction: message.direction === 'requester' ? 'requester' : 'staff',
        body: message.body,
        createdAt: message.createdAt,
      })),
      updatedAt: submission.updatedAt,
    }
  }

  /** External capability thread へ requester reply を保存します。 */
  async replyToThread(
    threadToken: string,
    input: RequestRequesterReplyInput,
    context: RequestExternalContext,
  ) {
    await this.ensureReady()
    const threadDigest = this.hashToken('thread', requireCapabilityToken(threadToken, 'Request thread token'))
    const lookup = await this.getThreadLookup(threadDigest)
    await this.requireTenantActive(lookup.workspaceId)
    const body = requireText(input.body, 'Requester reply', 20_000)
    const inputFingerprint = stableHash({ body, threadDigest })
    const idempotencyKey = context.idempotencyKey === undefined
      ? undefined
      : requireText(context.idempotencyKey, 'Reply idempotency key', 320)
    const replyDigest = idempotencyKey
      ? this.hashToken('reply-idempotency', `${threadDigest}\0${idempotencyKey}`)
      : undefined
    await this.consumeThreadRateLimit(lookup.workspaceId, threadDigest, context)
    if (replyDigest) {
      const existing = await this.documentClient.send(new GetCommand({
        TableName: this.tableName,
        Key: { scopeKey: createLookupScopeKey('REPLY', replyDigest), recordKey: 'RECEIPT' },
        ConsistentRead: true,
      }))
      if (existing.Item) {
        const stored = readReplyReceipt(existing.Item)
        if (stored.inputFingerprint !== inputFingerprint) {
          throw new RequestIntakeError(409, 'RequestIdempotencyConflict', 'Reply idempotency key was reused.')
        }
        return stored.receipt
      }
    }
    return this.appendRequesterReply(
      lookup,
      body,
      'web',
      replyDigest
        ? { digest: replyDigest, inputFingerprint, scope: 'REPLY', entryType: 'reply-receipt' }
        : undefined,
    )
  }

  /** 署名検証済み email envelope を requester reply として保存します。 */
  async ingestEmail(envelope: RequestEmailEnvelope) {
    await this.ensureReady()
    const threadToken = requireCapabilityToken(envelope.threadToken, 'Request email thread token')
    const threadDigest = this.hashToken('thread', threadToken)
    const lookup = await this.getThreadLookup(threadDigest)
    await this.requireTenantActive(lookup.workspaceId)
    const fromAddress = normalizeEmail(envelope.fromAddress)
    if (!lookup.requesterEmail || lookup.requesterEmail !== fromAddress) {
      throw new RequestIntakeError(403, 'RequestEmailSenderDenied', 'Email sender does not match the request thread.')
    }
    const messageId = requireText(envelope.messageId, 'Email Message-ID', 1_000)
    const emailDigest = this.hashToken(
      'email',
      `${lookup.workspaceId}\0${threadDigest}\0${messageId}`,
    )
    const existingResponse = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { scopeKey: createLookupScopeKey('EMAIL', emailDigest), recordKey: 'RECEIPT' },
      ConsistentRead: true,
    }))
    if (existingResponse.Item) return readReplyReceipt(existingResponse.Item).receipt
    const body = requireText(envelope.textBody, 'Email plain text body', 20_000)
    return this.appendRequesterReply(lookup, body, 'email', {
      digest: emailDigest,
      entryType: 'email-receipt',
      inputFingerprint: stableHash({ body, fromAddress, messageId, threadDigest }),
      scope: 'EMAIL',
    })
  }

  /** Scan 済み request attachment の短命 URL を発行します。 */
  async createAttachmentAccess(
    workspaceId: string,
    submissionId: string,
    attachmentId: string,
  ) {
    const submission = await this.getStoredSubmission(workspaceId, submissionId)
    const attachment = submission.attachments.find((candidate) => candidate.id === attachmentId)
    const objectKey = submission.attachmentObjectKeys[attachmentId]
    if (!attachment || !objectKey) {
      throw new RequestIntakeError(404, 'RequestAttachmentNotFound', 'Request attachment was not found.')
    }
    const objectVersionId = submission.attachmentObjectVersionIds[attachmentId]
    const scanStatus = await this.objectClient.getScanStatus(objectKey, objectVersionId)
    if (scanStatus !== 'available') {
      throw new RequestIntakeError(409, 'RequestAttachmentUnavailable', 'Request attachment is not available.')
    }
    await this.objectClient.markCompleted(objectKey, objectVersionId)
    return this.objectClient.createAccess({
      objectKey,
      objectVersionId,
      fileName: attachment.fileName,
      disposition: 'attachment',
    })
  }

  private async getFormVersion(workspaceId: string, formId: string, version: number) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        scopeKey: createWorkspaceScopeKey(workspaceId),
        recordKey: createFormVersionRecordKey(formId, version),
      },
      ConsistentRead: true,
    }))
    if (!response.Item) throw unavailableForm()
    return readStoredFormVersion(response.Item)
  }

  private createLinkLookup(form: StoredRequestForm): StoredLinkLookup {
    const linkToken = this.deriveLinkToken(form)
    return {
      entryType: 'link-lookup',
      scopeKey: createLookupScopeKey('LINK', this.hashToken('link', linkToken)),
      recordKey: 'LOOKUP',
      workspaceId: readWorkspaceIdFromFormStorage(form),
      formId: form.id,
      linkId: form.link.linkId,
      accessMode: form.link.accessMode,
      ...(form.link.expiresAt
        ? {
            expiresAt: Math.floor(Date.parse(form.link.expiresAt) / 1_000),
            expiresAtIso: form.link.expiresAt,
          }
        : {}),
      ...(form.link.revokedAt ? { revokedAt: form.link.revokedAt } : {}),
    }
  }

  private deriveLinkToken(form: StoredRequestForm) {
    return this.hashToken(
      'link-value',
      `${readWorkspaceIdFromFormStorage(form)}\0${form.id}\0${form.link.linkId}`,
    )
  }

  private deriveThreadToken(workspaceId: string, submissionId: string, receiptId: string) {
    return this.hashToken('thread-value', `${workspaceId}\0${submissionId}\0${receiptId}`)
  }

  private toSubmissionReceipt(workspaceId: string, receipt: StoredSubmissionReceipt) {
    return {
      receiptId: receipt.receiptId,
      submittedAt: receipt.submittedAt,
      confirmationMessage: receipt.confirmationMessage,
      threadToken: this.deriveThreadToken(workspaceId, receipt.submissionId, receipt.receiptId),
    } satisfies RequestSubmissionReceipt
  }

  private toFormView(form: StoredRequestForm) {
    return toRequestFormView(form, this.deriveLinkToken(form))
  }

  private async getActiveSession(
    resolution: RequestLinkResolution,
    sessionToken: string,
    enforceMinimumSubmitAt: boolean,
  ) {
    const digest = this.hashToken('session', requireCapabilityToken(sessionToken, 'Submission session token'))
    const session = await this.getSessionByDigest(digest)
    const now = this.now()
    const usedAt = session.usedAt === undefined ? undefined : Date.parse(session.usedAt)
    if (
      session.workspaceId !== resolution.workspaceId ||
      session.formId !== resolution.formId ||
      session.linkDigest !== resolution.tokenDigest ||
      !session.usedAt && Date.parse(session.expiresAtIso) <= now.getTime() ||
      usedAt !== undefined && (
        !Number.isFinite(usedAt) ||
        now.getTime() - usedAt > REQUEST_SUBMISSION_REPLAY_GRACE_MS
      ) ||
      !session.usedAt && enforceMinimumSubmitAt && Date.parse(session.minimumSubmitAt) > now.getTime()
    ) {
      throw new RequestIntakeError(409, 'RequestSessionUnavailable', 'Submission session is unavailable.')
    }
    return session
  }

  private async getSessionByDigest(digest: string) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { scopeKey: createLookupScopeKey('SESSION', digest), recordKey: 'LOOKUP' },
      ConsistentRead: true,
    }))
    return readSubmissionSession(response.Item)
  }

  private async getVerifiedUpload(
    session: StoredSubmissionSession,
    attachmentId: string,
    fieldId: string,
    claimToken: string | undefined,
  ) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        scopeKey: createWorkspaceScopeKey(session.workspaceId),
        recordKey: createUploadRecordKey(attachmentId),
      },
      ConsistentRead: true,
    }))
    const stored = readStoredUpload(response.Item)
    const claimDigest = this.hashToken(
      'attachment-claim',
      requireCapabilityToken(claimToken, 'Attachment claim token'),
    )
    if (
      stored.formId !== session.formId ||
      stored.formVersion !== session.formVersion ||
      stored.fieldId !== fieldId ||
      stored.claimDigest !== claimDigest ||
      stored.submissionId
    ) throw invalidInput('Attachment upload does not belong to this submission.')
    const verified = await this.objectClient.verifyUpload(stored.objectKey, {
      contentType: stored.contentType,
      sizeBytes: stored.sizeBytes,
    })
    if (verified.sizeBytes !== stored.sizeBytes) throw invalidInput('Uploaded attachment size does not match its session.')
    if (verified.scanStatus === 'blocked' || verified.scanStatus === 'failed') {
      throw new RequestIntakeError(422, 'RequestAttachmentBlocked', 'Attachment did not pass malware scanning.')
    }
    if (verified.scanStatus !== 'available') {
      throw new RequestIntakeError(409, 'RequestAttachmentScanning', 'Attachment malware scanning is not complete.')
    }
    return { stored, verified }
  }

  private async reserveAttachmentUpload(
    session: StoredSubmissionSession,
    maxFiles: number,
    maxFileSizeBytes: number,
    sizeBytes: number,
  ) {
    const maximumBytesBeforeUpload = maxFiles * maxFileSizeBytes - sizeBytes
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          ...this.createTenantWriteGuard(session.workspaceId),
          {
            Update: {
              TableName: this.tableName,
              Key: { scopeKey: session.scopeKey, recordKey: session.recordKey },
              UpdateExpression: 'ADD uploadCount :one, uploadBytes :sizeBytes',
              ConditionExpression:
                'attribute_not_exists(usedAt) AND expiresAt >= :nowEpoch AND (attribute_not_exists(uploadCount) OR uploadCount < :maxFiles) AND (attribute_not_exists(uploadBytes) OR uploadBytes <= :maximumBytesBeforeUpload)',
              ExpressionAttributeValues: {
                ':one': 1,
                ':sizeBytes': sizeBytes,
                ':nowEpoch': Math.floor(this.now().getTime() / 1_000),
                ':maxFiles': maxFiles,
                ':maximumBytesBeforeUpload': maximumBytesBeforeUpload,
              },
            },
          },
        ],
      }))
    } catch (error) {
      if (isConditionalFailure(error)) {
        if (!await this.tenantAvailability.isActive(session.workspaceId)) {
          throw unavailableForm()
        }
        throw new RequestIntakeError(409, 'RequestAttachmentLimitExceeded', 'Attachment upload limit was reached.')
      }
      throw toRequestStoreError(error)
    }
  }

  private async getStoredSubmission(workspaceId: string, submissionId: string) {
    await this.ensureReady()
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        scopeKey: createWorkspaceScopeKey(workspaceId),
        recordKey: createSubmissionRecordKey(submissionId),
      },
      ConsistentRead: true,
    }))
    if (!response.Item) throw new RequestIntakeError(404, 'RequestSubmissionNotFound', 'Request submission was not found.')
    return readStoredSubmission(response.Item)
  }

  private async getSubmissionEvents(workspaceId: string, submissionId: string) {
    const scopeKey = createWorkspaceScopeKey(workspaceId)
    const prefix = createSubmissionEventRecordKeyPrefix(submissionId)
    const events: RequestSubmissionEvent[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    const evaluatedCursors = new Set<string>()
    do {
      if (exclusiveStartKey) {
        const cursorFingerprint = stableStringify(exclusiveStartKey)
        if (evaluatedCursors.has(cursorFingerprint)) throw requestStoreUnavailable()
        evaluatedCursors.add(cursorFingerprint)
      }
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'scopeKey = :scopeKey AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: { ':scopeKey': scopeKey, ':prefix': prefix },
        ConsistentRead: true,
        ExclusiveStartKey: exclusiveStartKey,
      }))
      events.push(...(response.Items ?? []).map((item) => {
        const stored = readStoredSubmissionEvent(item)
        if (stored.submissionId !== submissionId) {
          throw new RequestIntakeError(
            503,
            'InvalidRequestSubmissionEvent',
            'Stored request submission event is invalid.',
          )
        }
        return toRequestSubmissionEvent(stored)
      }))
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)
    return events.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    )
  }

  private async finalizeAvailableAttachments(submission: StoredRequestSubmission) {
    await Promise.all(submission.attachments.map(async (attachment) => {
      if (attachment.scanStatus !== 'available') return
      const objectKey = submission.attachmentObjectKeys[attachment.id]
      if (!objectKey) return
      await this.objectClient.markCompleted(
        objectKey,
        submission.attachmentObjectVersionIds[attachment.id],
      )
    }))
  }

  private async finalizeSubmissionAttachments(submission: StoredRequestSubmission) {
    if (submission.attachmentFinalizedAt) return
    await this.finalizeAvailableAttachments(submission)
    try {
      await this.documentClient.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { scopeKey: submission.scopeKey, recordKey: submission.recordKey },
        UpdateExpression: 'SET attachmentFinalizedAt = if_not_exists(attachmentFinalizedAt, :finalizedAt)',
        ConditionExpression: 'entryType = :entryType',
        ExpressionAttributeValues: {
          ':entryType': 'submission',
          ':finalizedAt': this.now().toISOString(),
        },
      }))
    } catch (error) {
      throw toRequestStoreError(error)
    }
  }

  private async putSubmissionWithRevision(
    next: StoredRequestSubmission,
    expectedRevision: number,
    event: RequestSubmissionEvent,
    additionalTransactionItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [],
  ) {
    assertStoredRequestItemSize(next)
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: next,
              ConditionExpression: 'revision = :expectedRevision AND entryType = :entryType',
              ExpressionAttributeValues: {
                ':expectedRevision': expectedRevision,
                ':entryType': 'submission',
              },
            },
          },
          createRequestSubmissionEventTransactionPut(
            this.tableName,
            next.scopeKey,
            next.id,
            event,
          ),
          ...additionalTransactionItems,
        ],
      }))
    } catch (error) {
      if (isConditionalFailure(error)) throw revisionConflict('Request submission')
      throw toRequestStoreError(error)
    }
  }

  private async getThreadLookup(threadDigest: string) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { scopeKey: createLookupScopeKey('THREAD', threadDigest), recordKey: 'LOOKUP' },
      ConsistentRead: true,
    }))
    const lookup = readThreadLookup(response.Item)
    if (lookup.expiresAt <= Math.floor(this.now().getTime() / 1_000)) {
      throw new RequestIntakeError(404, 'RequestThreadUnavailable', 'Request thread is unavailable.')
    }
    return lookup
  }

  private async appendRequesterReply(
    lookup: StoredThreadLookup,
    body: string,
    source: 'web' | 'email',
    dedupe?: {
      digest: string
      entryType: StoredReplyReceipt['entryType']
      inputFingerprint: string
      scope: 'EMAIL' | 'REPLY'
    },
  ) {
    const current = await this.getStoredSubmission(lookup.workspaceId, lookup.submissionId)
    const terminal = terminalSubmissionStatuses.has(current.status)
    if (terminal && source === 'web') {
      throw new RequestIntakeError(409, 'RequestThreadClosed', 'Request thread is closed.')
    }
    const triageEntry = await this.getFormTriageEntry(
      lookup.workspaceId,
      lookup.submissionId,
    )
    const nowDate = this.now()
    const now = nowDate.toISOString()
    const replyId = createSortableId('reply', nowDate, randomUUID())
    const receipt: RequestRequesterReplyReceipt = { replyId, receivedAt: now }
    const event: RequestSubmissionEvent = {
      id: createSortableId('event', nowDate, randomUUID()),
      type: 'requester-replied',
      actorId: 'requester',
      summary: source === 'email' ? 'Requester replied by email.' : 'Requester replied on the request form.',
      createdAt: now,
    }
    const next: StoredRequestSubmission = {
      ...current,
      status: terminal ? current.status : 'triaging',
      revision: current.revision + 1,
      messages: appendRequestMessage(current.messages, {
        id: replyId,
        direction: 'requester' as const,
        source,
        body,
        createdAt: now,
      }),
      events: createRequestSubmissionEventProjection(current.events, event),
      updatedAt: now,
      capabilities: terminal ? current.capabilities : activeSubmissionCapabilities,
    }
    assertStoredRequestItemSize(next)
    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      ...this.createTenantWriteGuard(lookup.workspaceId),
      {
        Put: {
          TableName: this.tableName,
          Item: next,
          ConditionExpression: 'revision = :expectedRevision AND entryType = :entryType',
          ExpressionAttributeValues: {
            ':expectedRevision': current.revision,
            ':entryType': 'submission',
          },
        },
      },
      createRequestSubmissionEventTransactionPut(
        this.tableName,
        next.scopeKey,
        next.id,
        event,
      ),
    ]
    if (triageEntry) {
      const triageContribution = createTriageSourceActivityTransactionItems({
        tableName: this.tableName,
        entry: triageEntry,
        activity: {
          activityId: event.id,
          occurredAt: now,
          summary: event.summary,
          actorId: 'requester',
        },
        idempotency: {
          key: dedupe?.digest ?? replyId,
          fingerprint: dedupe?.inputFingerprint ?? stableHash({
            workspaceId: lookup.workspaceId,
            submissionId: lookup.submissionId,
            source,
            body,
          }),
        },
      })
      transactItems.push(...triageContribution.transactItems)
    }
    if (dedupe) {
      const replyReceipt: StoredReplyReceipt = {
        entryType: dedupe.entryType,
        scopeKey: createLookupScopeKey(dedupe.scope, dedupe.digest),
        recordKey: 'RECEIPT',
        workspaceId: lookup.workspaceId,
        submissionId: lookup.submissionId,
        inputFingerprint: dedupe.inputFingerprint,
        receipt,
        expiresAt: Math.floor((nowDate.getTime() + 90 * 24 * 60 * 60_000) / 1_000),
      }
      transactItems.push({
        Put: {
          TableName: this.tableName,
          Item: replyReceipt,
          ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
        },
      })
    }
    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactItems }))
      return receipt
    } catch (error) {
      if (dedupe && isConditionalFailure(error)) {
        if (!await this.tenantAvailability.isActive(lookup.workspaceId)) {
          throw unavailableForm()
        }
        const existing = await this.documentClient.send(new GetCommand({
          TableName: this.tableName,
          Key: { scopeKey: createLookupScopeKey(dedupe.scope, dedupe.digest), recordKey: 'RECEIPT' },
          ConsistentRead: true,
        }))
        if (existing.Item) {
          const stored = readReplyReceipt(existing.Item)
          if (stored.inputFingerprint !== dedupe.inputFingerprint) {
            throw new RequestIntakeError(409, 'RequestIdempotencyConflict', 'Reply idempotency key was reused.')
          }
          return stored.receipt
        }
      }
      if (isConditionalFailure(error)) throw revisionConflict('Request submission')
      throw toRequestStoreError(error)
    }
  }

  /**
   * Reads the deterministic Triage projection for a Form submission when it exists.
   *
   * @param workspaceId - Workspace that owns the Form submission.
   * @param submissionId - Canonical Request submission identifier.
   * @returns The canonical Triage Entry, or undefined for a pre-Triage legacy submission.
   */
  private async getFormTriageEntry(
    workspaceId: string,
    submissionId: string,
  ): Promise<TriageEntry | undefined> {
    const key = createTriageEntryKey(workspaceId, createFormTriageEntryId(submissionId))
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: key,
      ConsistentRead: true,
    }))
    if (response.Item === undefined) return undefined
    const entry = decodeTriageEntryRow(response.Item, key)
    if (!entry) {
      throw new RequestIntakeError(
        503,
        'InvalidRequestTriageEntry',
        'Stored request Triage entry is invalid.',
      )
    }
    return entry
  }

  private createRateLimitUpdate(
    resolution: RequestLinkResolution,
    operation: 'form' | 'replay' | 'submit' | 'thread' | 'upload',
    namespace: 'client' | 'link-global' | 'replay' | 'thread-global',
    subject: string,
    maximum: number,
    now: Date,
  ) {
    const hour = now.toISOString().slice(0, 13)
    const subjectDigest = this.hashToken(
      `rate-${namespace}`,
      requireText(subject, 'Request rate-limit subject', 2_000),
    )
    const scopeKey = createLookupScopeKey(
      'RATE',
      this.hashToken(
        'rate',
        `${resolution.tokenDigest}\0${operation}\0${namespace}\0${subjectDigest}\0${hour}`,
      ),
    )
    return {
      Update: {
        TableName: this.tableName,
        Key: { scopeKey, recordKey: 'COUNTER' },
        UpdateExpression: 'SET entryType = if_not_exists(entryType, :entryType), expiresAt = :expiresAt ADD #count :one',
        ConditionExpression: 'attribute_not_exists(#count) OR #count < :maximum',
        ExpressionAttributeNames: { '#count': 'count' },
        ExpressionAttributeValues: {
          ':entryType': 'rate-limit',
          ':expiresAt': Math.floor((now.getTime() + 2 * 60 * 60_000) / 1_000),
          ':maximum': maximum,
          ':one': 1,
        },
      },
    }
  }

  private async consumePairedRateLimits(
    resolution: RequestLinkResolution,
    context: RequestExternalContext,
    operation: 'form' | 'submit' | 'thread' | 'upload',
    clientMaximum: number,
    globalNamespace: 'link-global' | 'thread-global',
    globalMaximum: number,
  ) {
    const now = this.now()
    const clientKey = requireText(context.clientKey, 'Request client key', 2_000)
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          ...this.createTenantWriteGuard(resolution.workspaceId),
          this.createRateLimitUpdate(
            resolution,
            operation,
            'client',
            clientKey,
            clientMaximum,
            now,
          ),
          this.createRateLimitUpdate(
            resolution,
            operation,
            globalNamespace,
            globalNamespace,
            globalMaximum,
            now,
          ),
        ],
      }))
    } catch (error) {
      if (isConditionalFailure(error)) {
        if (!await this.tenantAvailability.isActive(resolution.workspaceId)) {
          throw unavailableForm()
        }
        throw requestRateLimited()
      }
      throw toRequestStoreError(error)
    }
  }

  private async consumeLinkRateLimits(
    resolution: RequestLinkResolution,
    context: RequestExternalContext,
    operation: 'form' | 'submit' | 'upload',
    clientMaximum: number,
    globalMaximum: number,
  ) {
    await this.consumePairedRateLimits(
      resolution,
      context,
      operation,
      clientMaximum,
      'link-global',
      globalMaximum,
    )
  }

  private async consumeThreadRateLimit(
    workspaceId: string,
    threadDigest: string,
    context: RequestExternalContext,
  ) {
    const resolution: RequestLinkResolution = {
      workspaceId,
      formId: 'thread',
      accessMode: 'public',
      tokenDigest: threadDigest,
    }
    const clientMaximum = Math.max(5, this.rateLimitPerHour)
    await this.consumePairedRateLimits(
      resolution,
      context,
      'submit',
      clientMaximum,
      'thread-global',
      clientMaximum * 20,
    )
  }

  private async consumeThreadReadRateLimit(
    workspaceId: string,
    threadDigest: string,
    context: RequestExternalContext,
  ) {
    const resolution: RequestLinkResolution = {
      workspaceId,
      formId: 'thread',
      accessMode: 'public',
      tokenDigest: threadDigest,
    }
    const clientMaximum = this.rateLimitPerHour * 10
    await this.consumePairedRateLimits(
      resolution,
      context,
      'thread',
      clientMaximum,
      'thread-global',
      clientMaximum * 10,
    )
  }

  private async consumeReplayRateLimit(resolution: RequestLinkResolution) {
    const update = this.createRateLimitUpdate(
      resolution,
      'replay',
      'replay',
      'submission-replay',
      REQUEST_SUBMISSION_REPLAY_LIMIT,
      this.now(),
    )
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          ...this.createTenantWriteGuard(resolution.workspaceId),
          update,
        ],
      }))
    } catch (error) {
      if (isConditionalFailure(error)) {
        if (!await this.tenantAvailability.isActive(resolution.workspaceId)) {
          throw unavailableForm()
        }
        throw requestRateLimited()
      }
      throw toRequestStoreError(error)
    }
  }

  private hashToken(kind: string, value: string) {
    return createHmac('sha256', this.tokenHashSecret).update(`${kind}\0${value}`).digest('hex')
  }

  /** Rejects public traffic after a tenant closure transition. */
  private async requireTenantActive(workspaceId: string): Promise<void> {
    if (!await this.tenantAvailability.isActive(workspaceId)) throw unavailableForm()
  }

  /** Returns a transaction guard when the configured lifecycle adapter supports one. */
  private createTenantWriteGuard(
    workspaceId: string,
  ): NonNullable<TransactWriteCommandInput['TransactItems']> {
    const condition = this.tenantAvailability.createActiveWriteCondition?.(workspaceId)
    return condition ? [condition] : []
  }

  private async ensureReady() {
    if (!this.bootstrapLocalTable) return
    this.tableReady ??= ensureLocalRequestIntakeTable(
      this.dynamoDbClient,
      this.tableName,
      this.queueIndexName,
      readEnvironment('TRIAGE_TEAM_ACTIVITY_INDEX_NAME') ?? TRIAGE_TEAM_ACTIVITY_INDEX_NAME,
      readEnvironment('TRIAGE_OWNER_ACTIVITY_INDEX_NAME') ?? TRIAGE_OWNER_ACTIVITY_INDEX_NAME,
      readEnvironment('TRIAGE_WAKE_INDEX_NAME') ?? TRIAGE_WAKE_INDEX_NAME,
    )
    await this.tableReady
  }
}

/**
 * Creates the production Request Intake client with a mandatory tenant lifecycle guard.
 *
 * @param tenantAvailability - Active-tenant read and atomic write boundary.
 * @param prepareFormTriageAdmission - Optional current Team configuration callback.
 * @returns A configured Request Intake client.
 */
export function createDefaultRequestIntakeClient(
  tenantAvailability: RequestIntakeTenantAvailability,
  prepareFormTriageAdmission?: FormTriageAdmissionPreparer,
): RequestIntakeClient {
  return new DynamoDbRequestIntakeClient({
    tenantAvailability,
    ...(prepareFormTriageAdmission ? { prepareFormTriageAdmission } : {}),
  })
}

/** Explicit compatibility boundary used only by directly constructed test/local clients. */
const ALLOW_ACTIVE_TENANT: RequestIntakeTenantAvailability = {
  async isActive() {
    return true
  },
}

const editableFormCapabilities = {
  canEdit: true,
  canPublish: true,
  canManageLink: true,
} as const

const activeSubmissionCapabilities = {
  canAssign: true,
  canRequestMoreInfo: true,
  canReject: true,
  canMarkDuplicate: true,
  canConvert: true,
} as const

const terminalSubmissionCapabilities = {
  canAssign: false,
  canRequestMoreInfo: false,
  canReject: false,
  canMarkDuplicate: false,
  canConvert: false,
} as const

const terminalSubmissionStatuses = new Set<RequestSubmissionStatus>([
  'rejected',
  'duplicate',
  'converted',
])

function normalizeRequestSubmissionEvent(value: unknown): RequestSubmissionEvent {
  const record = requireRecord(value, 'Request submission event')
  if (!isSubmissionEventType(record.type)) {
    throw invalidInput('Request submission event type is invalid.')
  }
  return {
    id: requireIdentifier(record.id, 'Request submission event ID'),
    type: record.type,
    actorId: requireText(record.actorId, 'Request submission event actor', 320),
    summary: requireText(record.summary, 'Request submission event summary', 10_000),
    createdAt: requireIsoTimestamp(record.createdAt, 'Request submission event timestamp'),
  }
}

function readStoredForm(value: unknown): StoredRequestForm {
  const record = requireRecord(value, 'Stored request form')
  if (
    record.entryType !== 'form' ||
    typeof record.scopeKey !== 'string' ||
    typeof record.recordKey !== 'string' ||
    typeof record.id !== 'string' ||
    typeof record.name !== 'string' ||
    (record.status !== 'draft' && record.status !== 'published' && record.status !== 'archived') ||
    !Number.isSafeInteger(record.revision) ||
    !Array.isArray(record.publishedVersions) ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string'
  ) throw new RequestIntakeError(503, 'InvalidRequestFormRecord', 'Stored request form is invalid.')
  const scope = requireScope(record.scope)
  const draft = validateRequestFormDraft(record.draft)
  const linkRecord = requireRecord(record.link, 'Stored request form link')
  const link = {
    linkId: requireIdentifier(linkRecord.linkId, 'Stored link ID'),
    accessMode: requireAccessMode(linkRecord.accessMode),
    ...(linkRecord.expiresAt === undefined ? {} : { expiresAt: requireIsoTimestamp(linkRecord.expiresAt, 'Stored link expiry') }),
    ...(linkRecord.revokedAt === undefined ? {} : { revokedAt: requireIsoTimestamp(linkRecord.revokedAt, 'Stored link revocation') }),
  }
  return {
    ...(record as unknown as StoredRequestForm),
    scope,
    draft,
    link,
    capabilities: editableFormCapabilities,
  }
}

function toRequestFormView(stored: StoredRequestForm, token: string): RequestForm {
  const {
    entryType: _entryType,
    scopeKey: _scopeKey,
    recordKey: _recordKey,
    ...view
  } = stored
  return {
    ...view,
    link: {
      ...view.link,
      token,
    },
  }
}

function toRequestFormVersion(stored: RequestFormVersion): RequestFormVersion {
  const {
    entryType: _entryType,
    scopeKey: _scopeKey,
    recordKey: _recordKey,
    ...version
  } = stored as RequestFormVersion & Partial<Pick<
    StoredRequestFormVersion,
    'entryType' | 'scopeKey' | 'recordKey'
  >>
  return version
}

function readStoredFormVersion(value: unknown): StoredRequestFormVersion {
  const record = requireRecord(value, 'Stored request form version')
  if (
    record.entryType !== 'form-version' ||
    record.schemaVersion !== REQUEST_FORM_SCHEMA_VERSION ||
    typeof record.scopeKey !== 'string' ||
    typeof record.recordKey !== 'string' ||
    typeof record.formId !== 'string' ||
    !Number.isSafeInteger(record.version) ||
    (record.version as number) < 1 ||
    typeof record.createdBy !== 'string' ||
    typeof record.createdAt !== 'string'
  ) throw new RequestIntakeError(503, 'InvalidRequestFormVersion', 'Stored request form version is invalid.')
  return {
    ...(record as unknown as StoredRequestFormVersion),
    snapshot: validateRequestFormDraft(record.snapshot),
  }
}

function readLinkLookup(value: unknown): StoredLinkLookup {
  if (!value) throw unavailableForm()
  const record = requireRecord(value, 'Request link lookup')
  if (
    record.entryType !== 'link-lookup' ||
    typeof record.scopeKey !== 'string' ||
    record.recordKey !== 'LOOKUP' ||
    typeof record.workspaceId !== 'string' ||
    typeof record.formId !== 'string' ||
    typeof record.linkId !== 'string' ||
    record.expiresAt !== undefined && typeof record.expiresAt !== 'number' ||
    record.expiresAtIso !== undefined && typeof record.expiresAtIso !== 'string'
  ) throw unavailableForm()
  return {
    ...(record as unknown as StoredLinkLookup),
    accessMode: requireAccessMode(record.accessMode),
  }
}

function readSubmissionSession(value: unknown): StoredSubmissionSession {
  if (!value) throw new RequestIntakeError(409, 'RequestSessionUnavailable', 'Submission session is unavailable.')
  const record = requireRecord(value, 'Submission session')
  if (
    record.entryType !== 'submission-session' ||
    typeof record.scopeKey !== 'string' ||
    record.recordKey !== 'LOOKUP' ||
    typeof record.workspaceId !== 'string' ||
    typeof record.formId !== 'string' ||
    !Number.isSafeInteger(record.formVersion) ||
    typeof record.linkDigest !== 'string' ||
    typeof record.minimumSubmitAt !== 'string' ||
    typeof record.expiresAtIso !== 'string' ||
    typeof record.expiresAt !== 'number'
  ) throw new RequestIntakeError(503, 'InvalidRequestSession', 'Stored submission session is invalid.')
  return record as unknown as StoredSubmissionSession
}

function readStoredUpload(value: unknown): StoredAttachmentUpload {
  if (!value) throw new RequestIntakeError(400, 'RequestAttachmentUnavailable', 'Attachment upload was not found.')
  const record = requireRecord(value, 'Stored attachment upload')
  if (
    record.entryType !== 'attachment-upload' ||
    typeof record.scopeKey !== 'string' ||
    typeof record.recordKey !== 'string' ||
    typeof record.attachmentId !== 'string' ||
    typeof record.formId !== 'string' ||
    !Number.isSafeInteger(record.formVersion) ||
    typeof record.fieldId !== 'string' ||
    typeof record.sessionDigest !== 'string' ||
    typeof record.claimDigest !== 'string' ||
    typeof record.fileName !== 'string' ||
    typeof record.contentType !== 'string' ||
    typeof record.sizeBytes !== 'number' ||
    typeof record.objectKey !== 'string'
  ) throw new RequestIntakeError(503, 'InvalidRequestAttachment', 'Stored request attachment is invalid.')
  return record as unknown as StoredAttachmentUpload
}

function readStoredSubmission(value: unknown): StoredRequestSubmission {
  const record = requireRecord(value, 'Stored request submission')
  if (
    record.entryType !== 'submission' ||
    record.schemaVersion !== REQUEST_SUBMISSION_SCHEMA_VERSION ||
    typeof record.scopeKey !== 'string' ||
    typeof record.recordKey !== 'string' ||
    typeof record.queueKey !== 'string' ||
    typeof record.queueRecordKey !== 'string' ||
    typeof record.id !== 'string' ||
    typeof record.formId !== 'string' ||
    !Number.isSafeInteger(record.formVersion) ||
    !Number.isSafeInteger(record.revision) ||
    !isSubmissionStatus(record.status) ||
    !Array.isArray(record.attachments) ||
    !Array.isArray(record.messages) ||
    !Array.isArray(record.events) ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string' ||
    typeof record.threadDigest !== 'string' ||
    typeof record.duplicateFingerprint !== 'string'
  ) throw new RequestIntakeError(503, 'InvalidRequestSubmission', 'Stored request submission is invalid.')
  return {
    ...(record as unknown as StoredRequestSubmission),
    capabilities: terminalSubmissionStatuses.has(record.status)
      ? terminalSubmissionCapabilities
      : activeSubmissionCapabilities,
  }
}

function readStoredSubmissionEvent(value: unknown): StoredRequestSubmissionEvent {
  const record = requireRecord(value, 'Stored request submission event')
  if (
    record.entryType !== 'submission-event' ||
    typeof record.scopeKey !== 'string' ||
    typeof record.recordKey !== 'string' ||
    typeof record.submissionId !== 'string' ||
    typeof record.id !== 'string' ||
    !isSubmissionEventType(record.type) ||
    typeof record.actorId !== 'string' ||
    typeof record.summary !== 'string' ||
    typeof record.createdAt !== 'string'
  ) {
    throw invalidStoredSubmissionEvent()
  }
  try {
    const event = normalizeRequestSubmissionEvent(record)
    const submissionId = requireIdentifier(record.submissionId, 'Stored request submission ID')
    if (record.recordKey !== createSubmissionEventRecordKey(submissionId, event)) {
      throw new Error('event key mismatch')
    }
    return {
      entryType: 'submission-event',
      scopeKey: record.scopeKey,
      recordKey: record.recordKey,
      submissionId,
      ...event,
    }
  } catch {
    throw invalidStoredSubmissionEvent()
  }
}

function invalidStoredSubmissionEvent() {
  return new RequestIntakeError(
    503,
    'InvalidRequestSubmissionEvent',
    'Stored request submission event is invalid.',
  )
}

function toRequestSubmissionEvent(stored: StoredRequestSubmissionEvent): RequestSubmissionEvent {
  const {
    entryType: _entryType,
    scopeKey: _scopeKey,
    recordKey: _recordKey,
    submissionId: _submissionId,
    ...event
  } = stored
  return event
}

function appendCompleteRequestSubmissionEventHistory(
  stored: StoredRequestSubmission,
  persistedEvents: readonly RequestSubmissionEvent[],
  event: RequestSubmissionEvent,
) {
  const history = persistedEvents.length > 0 ? persistedEvents : stored.events
  return [...history, event].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  )
}

function toRequestSubmissionView(
  stored: StoredRequestSubmission,
  events: readonly RequestSubmissionEvent[] = stored.events,
): RequestSubmission {
  const {
    entryType: _entryType,
    scopeKey: _scopeKey,
    recordKey: _recordKey,
    queueKey: _queueKey,
    queueRecordKey: _queueRecordKey,
    requesterEmail: _requesterEmail,
    threadDigest: _threadDigest,
    duplicateFingerprint: _duplicateFingerprint,
    attachmentObjectKeys: _attachmentObjectKeys,
    attachmentObjectVersionIds: _attachmentObjectVersionIds,
    attachmentFinalizedAt: _attachmentFinalizedAt,
    ...view
  } = stored
  return {
    ...view,
    formSnapshot: toRequestFormVersion(view.formSnapshot),
    events: events.length > 0 ? [...events] : view.events,
  }
}

function readThreadLookup(value: unknown): StoredThreadLookup {
  if (!value) throw new RequestIntakeError(404, 'RequestThreadUnavailable', 'Request thread is unavailable.')
  const record = requireRecord(value, 'Request thread lookup')
  if (
    record.entryType !== 'thread-lookup' ||
    typeof record.scopeKey !== 'string' ||
    record.recordKey !== 'LOOKUP' ||
    typeof record.workspaceId !== 'string' ||
    typeof record.submissionId !== 'string' ||
    typeof record.expiresAt !== 'number'
  ) throw new RequestIntakeError(404, 'RequestThreadUnavailable', 'Request thread is unavailable.')
  return record as unknown as StoredThreadLookup
}

function readReplyReceipt(value: unknown): StoredReplyReceipt {
  const record = requireRecord(value, 'Request email receipt')
  if (
    record.entryType !== 'email-receipt' && record.entryType !== 'reply-receipt' ||
    typeof record.inputFingerprint !== 'string' ||
    !record.receipt
  ) {
    throw new RequestIntakeError(503, 'InvalidRequestEmailReceipt', 'Stored email receipt is invalid.')
  }
  return record as unknown as StoredReplyReceipt
}

function readDuplicatePointer(value: unknown, now: Date) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (
    record.entryType !== 'duplicate-pointer' ||
    typeof record.submissionId !== 'string' ||
    typeof record.expiresAt !== 'number' ||
    record.expiresAt <= Math.floor(now.getTime() / 1_000)
  ) return undefined
  return { submissionId: record.submissionId }
}

function isSubmissionStatus(value: unknown): value is RequestSubmissionStatus {
  return value === 'received' || value === 'triaging' || value === 'needs-more-info' ||
    value === 'rejected' || value === 'duplicate' || value === 'converted'
}

function isSubmissionEventType(value: unknown): value is RequestSubmissionEvent['type'] {
  return value === 'submitted' || value === 'assigned' || value === 'more-info-requested' ||
    value === 'requester-replied' || value === 'rejected' || value === 'duplicate-marked' ||
    value === 'converted'
}

function assertSubmissionMutable(submission: RequestSubmission) {
  if (terminalSubmissionStatuses.has(submission.status)) {
    throw new RequestIntakeError(409, 'RequestSubmissionTerminal', 'Request submission is already terminal.')
  }
}

function validateWorkItemReference(value: unknown): RequestWorkItemReference {
  const record = requireRecord(value, 'Request Work Item reference')
  return {
    teamId: requireIdentifier(record.teamId, 'Work Item Team ID'),
    workItemId: requireIdentifier(record.workItemId, 'Work Item ID'),
    ...(record.projectId === undefined ? {} : { projectId: requireIdentifier(record.projectId, 'Work Item Project ID') }),
  }
}

function sameWorkItem(left: RequestWorkItemReference, right: RequestWorkItemReference) {
  return left.teamId === right.teamId && left.workItemId === right.workItemId &&
    left.projectId === right.projectId
}

function assertFormScopeMatchesRouting(
  scope: RequestFormScope,
  routing: RequestFormRoutingConfiguration,
) {
  if (scope.type !== 'team') return
  const targets = [routing.defaultTarget, ...routing.rules.map((rule) => rule.target)]
  if (targets.some((target) => target.teamId !== scope.teamId)) {
    throw invalidInput('Team-scoped request form cannot route outside its Team.')
  }
}

function findFormField(definition: RequestFormDefinition, fieldId: string) {
  return definition.sections.flatMap((section) => section.fields)
    .find((field) => field.id === fieldId)
}

function findRequesterEmail(
  definition: RequestFormDefinition,
  answers: Readonly<Record<string, RequestAnswerValue>>,
) {
  const emailField = definition.sections.flatMap((section) => section.fields)
    .find((field) => field.type === 'email' && typeof answers[field.id] === 'string')
  const value = emailField ? answers[emailField.id] : undefined
  return typeof value === 'string' ? normalizeEmail(value) : undefined
}

function normalizeEmail(value: unknown) {
  const email = requireText(value, 'Requester email', 320).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+$/u.test(email)) throw invalidInput('Requester email is invalid.')
  return email
}

function normalizeFileName(value: unknown) {
  const normalized = requireText(value, 'Attachment file name', 255)
    .normalize('NFKC')
    .replaceAll('\\', '_')
    .replaceAll('/', '_')
  const name = Array.from(normalized, (character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint < 32 || codePoint === 127 ? '_' : character
  }).join('')
  if (name === '.' || name === '..') throw invalidInput('Attachment file name is invalid.')
  return name
}

function validateAttachmentClaims(
  value: unknown,
  attachmentIds: string[],
) {
  const claims = value === undefined
    ? {}
    : requireRecord(value, 'Attachment claims')
  const expectedIds = new Set(attachmentIds)
  const claimIds = Object.keys(claims)
  if (
    claimIds.length !== expectedIds.size ||
    claimIds.some((attachmentId) => !expectedIds.has(attachmentId))
  ) throw invalidInput('Attachment claims must match the submitted attachments.')
  return Object.fromEntries(Array.from(expectedIds, (attachmentId) => [
    attachmentId,
    requireCapabilityToken(claims[attachmentId], 'Attachment claim token'),
  ]))
}

function resolveLocalizedText(
  value: { ja?: string; en?: string },
  locale: RequestLocale,
  fallback: RequestLocale,
) {
  return value[locale] ?? value[fallback] ?? value.ja ?? value.en ?? ''
}

/**
 * Creates the deterministic Team Triage projection committed with a Form submission.
 *
 * @param workspaceId - Workspace that owns the submission and target Team.
 * @param submission - Canonical Request submission and immutable Form snapshot.
 * @param accessMode - Capability mode used to classify the external requester.
 * @returns A normalized pending Triage Entry owned by the saved routing Team.
 */
function createFormTriageEntry(
  workspaceId: string,
  submission: StoredRequestSubmission,
  accessMode: RequestFormAccessMode,
): TriageEntry {
  const preview = createFormTriagePreview(submission)
  const permission: TriageEntry['permission'] = {
    visibility: 'full',
    canReply: true,
    guestVisible: false,
    checkedAt: submission.createdAt,
  }
  const routingCandidate = {
    teamId: submission.routingTarget.teamId,
    ...(submission.routingTarget.projectId
      ? { projectId: submission.routingTarget.projectId }
      : {}),
    reason: 'Published Request Form routing selected this destination.',
    score: 1,
    permitted: true,
  }
  const retentionDate = new Date(submission.createdAt)
  retentionDate.setUTCDate(retentionDate.getUTCDate() + 365)
  const entry: TriageEntry = {
    schemaVersion: TRIAGE_ENTRY_SCHEMA_VERSION,
    id: createFormTriageEntryId(submission.id),
    workspaceId,
    source: {
      kind: 'form',
      sourceId: submission.id,
      formId: submission.formId,
      submissionId: submission.id,
    },
    sourcePreview: {
      title: resolveLocalizedText(
        submission.formSnapshot.snapshot.definition.title,
        submission.locale,
        submission.formSnapshot.snapshot.definition.defaultLocale,
      ),
      body: preview.body,
      channelLabel: 'Request Form',
      attachmentCount: submission.attachments.length,
      commentCount: submission.messages.length,
      watcherCount: 0,
      sanitized: true,
      truncated: preview.truncated,
    },
    requester: {
      displayName: submission.requesterEmail ?? 'Request Form requester',
      ...(submission.requesterEmail ? { email: submission.requesterEmail } : {}),
      guest: accessMode === 'public',
    },
    receivedAt: submission.createdAt,
    lastActivityAt: submission.createdAt,
    state: 'pending',
    routing: {
      reason: 'The published Request Form routing snapshot selected this Team.',
      candidates: [routingCandidate],
    },
    teamId: submission.routingTarget.teamId,
    ...(submission.routingTarget.projectId
      ? { projectId: submission.routingTarget.projectId }
      : {}),
    ...(submission.triageAssigneeUserId
      ? { ownerUserId: submission.triageAssigneeUserId }
      : {}),
    permission,
    retention: { expiresAt: retentionDate.toISOString() },
    capabilities: createTriageCapabilities({ state: 'pending', permission }),
    events: [{
      id: `triage-created-${submission.id}`,
      type: 'created',
      actorId: 'requester',
      summary: 'A Request Form submission entered Team triage.',
      createdAt: submission.createdAt,
    }],
    revision: 1,
    createdAt: submission.createdAt,
    updatedAt: submission.createdAt,
  }
  return entry
}

/**
 * Removes a legacy queue assignee without retaining an undefined DynamoDB attribute.
 *
 * @param submission - Stored Request submission to copy.
 * @returns A copy with no Triage assignee projection.
 */
function removeRequestTriageAssignee(
  submission: StoredRequestSubmission,
): StoredRequestSubmission {
  const next = { ...submission }
  delete next.triageAssigneeUserId
  return next
}

/**
 * Creates a bounded plain-text Form answer preview without attachment identifiers.
 *
 * @param submission - Canonical Request submission and immutable field definitions.
 * @returns The bounded preview and whether content was truncated.
 */
function createFormTriagePreview(
  submission: StoredRequestSubmission,
): { body: string; truncated: boolean } {
  const lines = submission.formSnapshot.snapshot.definition.sections.flatMap((section) =>
    section.fields.flatMap((field) => {
      if (field.type === 'attachment') return []
      const value = submission.answers[field.id]
      if (value === undefined) return []
      const rendered = Array.isArray(value)
        ? value.join(', ')
        : String(value)
      if (!rendered.trim()) return []
      const label = resolveLocalizedText(
        field.label,
        submission.locale,
        submission.formSnapshot.snapshot.definition.defaultLocale,
      )
      return [`${label}: ${rendered.replaceAll(/\s+/gu, ' ').trim()}`]
    }),
  )
  const complete = lines.join('\n')
  return {
    body: complete.slice(0, 8_000),
    truncated: complete.length > 8_000,
  }
}

/**
 * Derives the stable Triage Entry identifier for one Form submission.
 *
 * @param submissionId - Canonical Request submission identifier.
 * @returns A conservative identifier reused by replies and conversion.
 */
export function createFormTriageEntryId(submissionId: string): string {
  return `triage_${requireIdentifier(submissionId, 'Request submission ID')}`
}

/** Ensures a trusted admission callback changed only configurable Triage fields. */
function requireSameFormTriageAdmission(
  original: TriageEntry,
  configured: TriageEntry,
): void {
  if (
    original.id !== configured.id ||
    original.workspaceId !== configured.workspaceId ||
    original.teamId !== configured.teamId ||
    original.source.kind !== 'form' ||
    configured.source.kind !== 'form' ||
    original.source.sourceId !== configured.source.sourceId ||
    original.source.formId !== configured.source.formId ||
    original.source.submissionId !== configured.source.submissionId ||
    original.createdAt !== configured.createdAt ||
    original.receivedAt !== configured.receivedAt ||
    original.revision !== configured.revision ||
    configured.state !== 'pending'
  ) {
    throw new RequestIntakeError(
      500,
      'InvalidTriageAdmission',
      'The configured Triage admission changed immutable source identity.',
    )
  }
}

function readOptionalFutureTimestamp(value: unknown, now: Date, label: string) {
  if (value === undefined) return undefined
  const timestamp = requireIsoTimestamp(value, label)
  if (Date.parse(timestamp) <= now.getTime()) throw invalidInput(`${label} must be in the future.`)
  return timestamp
}

function requireIsoTimestamp(value: unknown, label: string) {
  const text = requireText(value, label, 100)
  const milliseconds = Date.parse(text)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text) {
    throw invalidInput(`${label} must be an ISO 8601 timestamp.`)
  }
  return text
}

function requireExpectedRevision(value: unknown, currentRevision: number) {
  if (!Number.isSafeInteger(value) || value !== currentRevision) throw revisionConflict('Request resource')
}

function revisionConflict(resource: string) {
  return new RequestIntakeError(409, 'RequestRevisionConflict', `${resource} revision changed.`)
}

function unavailableForm() {
  return new RequestIntakeError(404, 'RequestFormUnavailable', 'Request form is unavailable.')
}

function requireCapabilityToken(value: unknown, label: string) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/u.test(value)) {
    throw new RequestIntakeError(404, 'RequestCapabilityUnavailable', `${label} is unavailable.`)
  }
  return value
}

function createWorkspaceScopeKey(workspaceId: string) {
  return `WORKSPACE#${requireText(workspaceId, 'Workspace ID', 512)}`
}

function createLookupScopeKey(kind: string, digest: string) {
  return `${kind}#${digest}`
}

function createFormRecordKey(formId: string) {
  return `FORM_ROOT#${requireIdentifier(formId, 'Request form ID')}`
}

function createFormVersionRecordKey(formId: string, version: number) {
  return `FORM_VERSION#${requireIdentifier(formId, 'Request form ID')}#VERSION#${String(requireInteger(version, 'Request form version', 1, 999_999)).padStart(6, '0')}`
}

function createSubmissionRecordKey(submissionId: string) {
  return `SUBMISSION#${requireIdentifier(submissionId, 'Request submission ID')}`
}

function createSubmissionEventRecordKeyPrefix(submissionId: string) {
  return `SUBMISSION_EVENT#${requireIdentifier(submissionId, 'Request submission ID')}#`
}

function createSubmissionEventRecordKey(
  submissionId: string,
  event: RequestSubmissionEvent,
) {
  return `${createSubmissionEventRecordKeyPrefix(submissionId)}${event.createdAt}#${event.id}`
}

function createUploadRecordKey(attachmentId: string) {
  return `UPLOAD#${requireIdentifier(attachmentId, 'Request attachment ID')}`
}

function createSortableId(prefix: string, date: Date, entropy: string) {
  const timestamp = date.toISOString().replace(/[-:.TZ]/gu, '')
  const suffix = createHash('sha256').update(entropy).digest('base64url').slice(0, 16)
  return `${prefix}_${timestamp}_${suffix}`
}

function createRequestObjectKey(workspaceId: string, attachmentId: string) {
  const workspaceDigest = createHash('sha256').update(workspaceId).digest('hex').slice(0, 32)
  return `workspaces/${workspaceDigest}/request-submissions/${attachmentId}/content`
}

function readWorkspaceIdFromFormStorage(form: StoredRequestForm) {
  const prefix = 'WORKSPACE#'
  if (!form.scopeKey.startsWith(prefix) || form.scopeKey.length === prefix.length) {
    throw new RequestIntakeError(503, 'InvalidRequestFormRecord', 'Stored form Workspace scope is invalid.')
  }
  return form.scopeKey.slice(prefix.length)
}

function createQueueCursorKey(submission: StoredRequestSubmission) {
  return {
    scopeKey: submission.scopeKey,
    recordKey: submission.recordKey,
    queueKey: submission.queueKey,
    queueRecordKey: submission.queueRecordKey,
  }
}

function encodeQueueCursor(
  queueKey: string,
  status: RequestSubmissionStatus | undefined,
  key: Record<string, unknown>,
) {
  return Buffer.from(JSON.stringify({ version: 1, queueKey, status: status ?? null, key }), 'utf8')
    .toString('base64url')
}

function decodeQueueCursor(
  cursor: string,
  queueKey: string,
  status: RequestSubmissionStatus | undefined,
) {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    const record = requireRecord(decoded, 'Request queue cursor')
    if (
      record.version !== 1 ||
      record.queueKey !== queueKey ||
      record.status !== (status ?? null)
    ) throw new Error('scope mismatch')
    return requireRecord(record.key, 'Request queue cursor key')
  } catch {
    throw invalidInput('Request queue cursor is invalid for this scope.')
  }
}

function stableHash(value: unknown) {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function isConditionalFailure(error: unknown) {
  const name = typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name?: unknown }).name)
    : ''
  if (name === 'ConditionalCheckFailedException') return true
  if (name !== 'TransactionCanceledException') return false
  const cancellationReasons = (
    error as { CancellationReasons?: Array<{ Code?: unknown }> }
  ).CancellationReasons
  return Array.isArray(cancellationReasons) &&
    cancellationReasons.some((reason) => reason.Code === 'ConditionalCheckFailed') &&
    cancellationReasons.every((reason) =>
      reason.Code === 'ConditionalCheckFailed' || reason.Code === 'None'
    )
}

/** Detects a transaction cancellation caused only by retryable admission guards.
 *
 * @param error Untrusted DynamoDB transaction failure.
 * @param itemIndexes Transaction positions owned by the admission snapshot.
 * @returns Whether at least one expected guard failed and every other item was unaffected.
 */
function isOnlyConditionalFailureAtAny(
  error: unknown,
  itemIndexes: readonly number[],
): boolean {
  const expectedIndexes = new Set(itemIndexes)
  if (expectedIndexes.size < 1 || [...expectedIndexes].some((itemIndex) =>
    !Number.isSafeInteger(itemIndex) || itemIndex < 0
  ) ||
    typeof error !== 'object' || error === null ||
    Reflect.get(error, 'name') !== 'TransactionCanceledException') {
    return false
  }
  const cancellationReasons = Reflect.get(error, 'CancellationReasons')
  if (!Array.isArray(cancellationReasons) ||
    [...expectedIndexes].some((itemIndex) => itemIndex >= cancellationReasons.length)) {
    return false
  }
  let hasExpectedConditionalFailure = false
  return cancellationReasons.every((reason, index) => {
    const code = typeof reason === 'object' && reason !== null
      ? Reflect.get(reason, 'Code')
      : undefined
    if (code === 'ConditionalCheckFailed' && expectedIndexes.has(index)) {
      hasExpectedConditionalFailure = true
      return true
    }
    return code === 'None'
  }) && hasExpectedConditionalFailure
}

function toRequestStoreError(error: unknown) {
  if (error instanceof RequestIntakeError) return error
  return requestStoreUnavailable(error)
}

function requestStoreUnavailable(cause?: unknown) {
  return new RequestIntakeError(
    503,
    'RequestIntakeUnavailable',
    'Request intake storage is unavailable.',
    { cause },
  )
}

function sameKeyDefinition(
  actual: Array<{ AttributeName?: string; KeyType?: string }> | undefined,
  expected: Array<{ AttributeName: string; KeyType: string }>,
) {
  return actual?.length === expected.length && expected.every((expectedKey, index) =>
    actual[index]?.AttributeName === expectedKey.AttributeName &&
    actual[index]?.KeyType === expectedKey.KeyType
  )
}

async function ensureLocalRequestIntakeTable(
  client: DynamoDBClient,
  tableName: string,
  queueIndexName: string,
  triageTeamIndexName: string,
  triageOwnerIndexName: string,
  triageWakeIndexName: string,
) {
  try {
    const response = await client.send(new DescribeTableCommand({ TableName: tableName }))
    const table = response.Table
    const indexes = table?.GlobalSecondaryIndexes ?? []
    const queueIndex = indexes.find((candidate) => candidate.IndexName === queueIndexName)
    const triageTeamIndex = indexes.find((candidate) =>
      candidate.IndexName === triageTeamIndexName
    )
    const triageOwnerIndex = indexes.find((candidate) =>
      candidate.IndexName === triageOwnerIndexName
    )
    const triageWakeIndex = indexes.find((candidate) =>
      candidate.IndexName === triageWakeIndexName
    )
    if (
      !sameKeyDefinition(table?.KeySchema, [
        { AttributeName: 'scopeKey', KeyType: 'HASH' },
        { AttributeName: 'recordKey', KeyType: 'RANGE' },
      ]) ||
      !sameKeyDefinition(queueIndex?.KeySchema, [
        { AttributeName: 'queueKey', KeyType: 'HASH' },
        { AttributeName: 'queueRecordKey', KeyType: 'RANGE' },
      ]) ||
      !sameKeyDefinition(triageTeamIndex?.KeySchema, [
        { AttributeName: 'triageTeamKey', KeyType: 'HASH' },
        { AttributeName: 'triageActivityKey', KeyType: 'RANGE' },
      ]) ||
      !sameKeyDefinition(triageOwnerIndex?.KeySchema, [
        { AttributeName: 'triageOwnerKey', KeyType: 'HASH' },
        { AttributeName: 'triageActivityKey', KeyType: 'RANGE' },
      ]) ||
      !sameKeyDefinition(triageWakeIndex?.KeySchema, [
        { AttributeName: 'triageWakeShard', KeyType: 'HASH' },
        { AttributeName: 'triageNextWakeAt', KeyType: 'RANGE' },
      ])
    ) {
      throw new RequestIntakeError(
        503,
        'InvalidRequestIntakeTable',
        'Local request intake table schema is invalid.',
      )
    }
    return
  } catch (error) {
    if (!isAwsResourceNotFound(error)) throw error
  }
  await client.send(new CreateTableCommand({
    TableName: tableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'scopeKey', AttributeType: 'S' },
      { AttributeName: 'recordKey', AttributeType: 'S' },
      { AttributeName: 'queueKey', AttributeType: 'S' },
      { AttributeName: 'queueRecordKey', AttributeType: 'S' },
      { AttributeName: 'triageTeamKey', AttributeType: 'S' },
      { AttributeName: 'triageOwnerKey', AttributeType: 'S' },
      { AttributeName: 'triageActivityKey', AttributeType: 'S' },
      { AttributeName: 'triageWakeShard', AttributeType: 'S' },
      { AttributeName: 'triageNextWakeAt', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'scopeKey', KeyType: 'HASH' },
      { AttributeName: 'recordKey', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: queueIndexName,
        KeySchema: [
          { AttributeName: 'queueKey', KeyType: 'HASH' },
          { AttributeName: 'queueRecordKey', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: triageTeamIndexName,
        KeySchema: [
          { AttributeName: 'triageTeamKey', KeyType: 'HASH' },
          { AttributeName: 'triageActivityKey', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: triageOwnerIndexName,
        KeySchema: [
          { AttributeName: 'triageOwnerKey', KeyType: 'HASH' },
          { AttributeName: 'triageActivityKey', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: triageWakeIndexName,
        KeySchema: [
          { AttributeName: 'triageWakeShard', KeyType: 'HASH' },
          { AttributeName: 'triageNextWakeAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'KEYS_ONLY' },
      },
    ],
  }))
  try {
    await client.send(new UpdateTimeToLiveCommand({
      TableName: tableName,
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    }))
  } catch (error) {
    if (!isAwsNamedError(error, 'ValidationException')) throw error
  }
}

function createDefaultRequestObjectClient() {
  const endpoint = readEnvironment('AWS_ENDPOINT_URL_S3') ?? readEnvironment('AWS_ENDPOINT_URL')
  const client = new S3Client({
    ...createAwsConfiguration(endpoint),
    forcePathStyle: Boolean(endpoint),
    requestChecksumCalculation: 'WHEN_REQUIRED',
  })
  return new S3FileObjectClient(
    client,
    readEnvironment('FILE_BUCKET_NAME') ?? 'mukuroji-files-local',
    Number(readEnvironment('FILE_UPLOAD_URL_TTL_SECONDS') ?? 600),
    Number(readEnvironment('FILE_DOWNLOAD_URL_TTL_SECONDS') ?? 300),
  )
}

function readCapabilitySecret() {
  const configured = readEnvironment('REQUEST_TOKEN_HASH_SECRET')
  if (configured && configured.length >= 32) return configured
  if (readEnvironment('AWS_LAMBDA_FUNCTION_NAME')) {
    throw new Error('REQUEST_TOKEN_HASH_SECRET with at least 32 characters is required in Lambda.')
  }
  return 'mukuroji-local-request-token-secret-0000000000000000'
}

function createAwsConfiguration(endpoint: string | undefined) {
  return endpoint
    ? {
        endpoint,
        region: readEnvironment('AWS_REGION') ?? 'ap-northeast-1',
        credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      }
    : { region: readEnvironment('AWS_REGION') ?? 'ap-northeast-1' }
}

function readEnvironment(name: string) {
  if (typeof Bun !== 'undefined') return Bun.env[name]
  return typeof process !== 'undefined' ? process.env[name] : undefined
}

function requirePositiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer.`)
  return value
}

function isAwsResourceNotFound(error: unknown) {
  return isAwsNamedError(error, 'ResourceNotFoundException')
}

function isAwsNamedError(error: unknown, name: string) {
  return typeof error === 'object' && error !== null && 'name' in error &&
    (error as { name?: unknown }).name === name
}
