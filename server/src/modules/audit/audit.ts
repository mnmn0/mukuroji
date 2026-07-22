import { createHash, createHmac } from 'node:crypto'
import {
  CreateTableCommand,
  DescribeTableCommand,
  type DynamoDBClient,
  type TableDescription,
} from '@aws-sdk/client-dynamodb'
import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'

/**
 * 現行の audit event schema version です。
 */
export const AUDIT_SCHEMA_VERSION = 1 as const

/**
 * workspace timeline 用 GSI 名です。
 */
export const AUDIT_WORKSPACE_INDEX_NAME = 'WorkspaceOccurredAtIndex'

/**
 * actor timeline 用 GSI 名です。
 */
export const AUDIT_ACTOR_INDEX_NAME = 'ActorOccurredAtIndex'

/**
 * entity activity 用 GSI 名です。
 */
export const AUDIT_ENTITY_INDEX_NAME = 'EntityOccurredAtIndex'

/**
 * mutation target timeline 用 GSI 名です。
 */
export const AUDIT_TARGET_INDEX_NAME = 'TargetOccurredAtIndex'

/**
 * audit payload で機密値を置き換える固定値です。
 */
export const AUDIT_REDACTED_VALUE = '[REDACTED]'

/**
 * audit payload に保存できる文字列の最大長です。
 */
export const AUDIT_MAX_TEXT_LENGTH = 4096

/**
 * 発生時刻を復元できない backfill event にだけ使う sentinel です。
 */
export const AUDIT_UNKNOWN_OCCURRED_AT = '1970-01-01T00:00:00.000Z'

/**
 * Workspace access の公開 audit ID に使う HMAC key の環境変数名です。
 */
export const WORKSPACE_AUDIT_PSEUDONYM_KEY_ENV =
  'MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY'

/**
 * Workspace access の公開 audit entity ID contract version です。
 */
export const WORKSPACE_ACCESS_AUDIT_ENTITY_ID_CONTRACT_VERSION = 'v2'

const workspaceAuditPseudonymKeyPattern = /^[0-9a-f]{64}$/u
const workspaceAccessEntityIdNamespace =
  `workspace-access-entity-${WORKSPACE_ACCESS_AUDIT_ENTITY_ID_CONTRACT_VERSION}`

/**
 * audit event に保存できる JSON object です。
 */
export type AuditObject = {
  /**
   * JSON 化できる audit field value です。
   */
  [key: string]: AuditValue
}

/**
 * audit event に保存できる JSON value です。
 */
export type AuditValue = null | boolean | number | string | AuditObject | AuditValue[]

/**
 * mutation を行った主体の種別です。
 */
export type AuditActorKind = 'user' | 'system' | 'service' | 'break-glass'

/**
 * audit event が扱う entity type です。
 *
 * Issue #22 の canonical 種別を列挙しつつ、将来の entity 追加も schema migration なしで許可します。
 */
export type AuditEventEntityType =
  | 'work-item'
  | 'comment'
  | 'member'
  | 'invitation'
  | 'project'
  | 'workflow'
  | 'file'
  | 'approval'
  | (string & {})

/**
 * mutation を行った主体です。
 */
export type AuditActor = {
  /**
   * Cognito sub などの変更されない主体 ID です。
   */
  id: string
  /**
   * 主体の種別です。
   */
  kind: AuditActorKind
  /**
   * event 発生時点の表示用識別子です。
   */
  displayName?: string
}

/**
 * audit event が属する entity または直接の mutation target です。
 */
export type AuditEntity = {
  /**
   * work-item、project、member などの entity 種別です。
   */
  type: AuditEventEntityType
  /**
   * workspace 内で entity を識別する ID です。
   */
  id: string
}

/**
 * mutation が発生した経路です。
 */
export type AuditSourceKind = 'api' | 'backfill' | 'migration' | 'system'

/**
 * outbox consumer が扱う audit event の配送状態です。
 */
export type AuditOutboxStatus = 'pending' | 'suppressed'

/**
 * mutation 発生元の追跡情報です。
 */
export type AuditSource = {
  /**
   * mutation が発生した経路です。
   */
  kind: AuditSourceKind
  /**
   * API gateway または application request ID です。
   */
  requestId?: string
  /**
   * mutation を受け付けた HTTP method です。
   */
  method?: string
  /**
   * mutation を受け付けた route です。
   */
  route?: string
  /**
   * request 元 IP address です。
   */
  ipAddress?: string
  /**
   * request の user agent です。
   */
  userAgent?: string
}

/**
 * 一つの field に対する変更内容です。
 */
export type AuditFieldChange = {
  /**
   * root からの dot 区切り field path です。
   */
  field: string
  /**
   * mutation 前の値です。field が新規作成された場合は省略します。
   */
  before?: AuditValue
  /**
   * mutation 後の値です。field が削除された場合は省略します。
   */
  after?: AuditValue
  /**
   * 値が機密情報として置換されたかどうかです。
   */
  redacted?: boolean
}

/**
 * append-only audit event schema v1 です。
 */
export type AuditEventV1 = {
  /**
   * event payload の schema version です。
   */
  schemaVersion: typeof AUDIT_SCHEMA_VERSION
  /**
   * idempotency key から決定的に生成した event ID です。
   */
  eventId: string
  /**
   * DynamoDB base partition key で、workspaceId と同じ値です。
   */
  directoryId: string
  /**
   * event が属する canonical workspace ID です。
   */
  workspaceId: string
  /**
   * workspace timeline GSI の partition key です。
   */
  workspaceKey: string
  /**
   * `work-item.updated` などの event 種別です。
   */
  eventType: string
  /**
   * event が発生した ISO 8601 timestamp です。
   */
  occurredAt: string
  /**
   * timeline GSI の安定した sort key です。
   */
  occurredAtEventId: string
  /**
   * workspace timeline GSI の sort key です。
   */
  workspaceEventKey: string
  /**
   * mutation を行った主体です。
   */
  actor: AuditActor
  /**
   * CDK inline Lambda と共有する actor user ID です。
   */
  actorUserId: string
  /**
   * actor timeline GSI の partition key です。
   */
  actorKey: string
  /**
   * actor timeline GSI の sort key です。
   */
  actorEventKey: string
  /**
   * activity を集約する entity です。
   */
  entity: AuditEntity
  /**
   * CDK inline Lambda と共有する entity type です。
   */
  entityType: AuditEventEntityType
  /**
   * CDK inline Lambda と共有する entity ID です。
   */
  entityId: string
  /**
   * entity timeline GSI の partition key です。
   */
  entityKey: string
  /**
   * entity timeline GSI の sort key です。
   */
  entityEventKey: string
  /**
   * mutation が直接変更した target です。
   */
  target: AuditEntity
  /**
   * CDK inline Lambda と共有する target type です。
   */
  targetType: AuditEventEntityType
  /**
   * CDK inline Lambda と共有する target ID です。
   */
  targetId: string
  /**
   * target timeline GSI の partition key です。
   */
  targetKey: string
  /**
   * target timeline GSI の sort key です。
   */
  targetEventKey: string
  /**
   * field 単位の before / after diff です。
   */
  changes: AuditFieldChange[]
  /**
   * mutation action の短い識別子です。
   */
  action: string
  /**
   * 同一 mutation による複数 event を束ねる correlation ID です。
   */
  correlationId: string
  /**
   * 生の idempotency key を残さない SHA-256 hash です。
   */
  idempotencyKeyHash: string
  /**
   * 同一 idempotency key の request 内容差異を検出する hash です。
   */
  requestFingerprint: string
  /**
   * mutation 発生元の追跡情報です。
   */
  source: AuditSourceKind
  /**
   * API route などを含む詳細な source snapshot です。
   */
  sourceDetails?: AuditSource
  /**
   * activity 表示用の短い説明です。
   */
  summary?: string
  /**
   * DynamoDB TTL に渡す epoch seconds です。時刻不明の backfill event だけ省略できます。
   */
  expiresAt?: number
  /**
   * schema の必須項目に含めない付加情報です。
   */
  metadata?: AuditObject
  /**
   * outbox consumer が未処理 event を識別する初期状態です。
   */
  outboxStatus: AuditOutboxStatus
}

/**
 * 旧 TeamIssueEventsTable で使われていた schema v0 です。
 */
export type AuditEventV0 = {
  /**
   * 旧 event に明示される場合の schema version です。
   */
  schemaVersion?: 0
  /**
   * issue partition と event を結ぶ旧 partition key です。
   */
  directoryTeamIssueId?: string
  /**
   * 旧 event ID です。
   */
  eventId: string
  /**
   * canonical workspace 移行前の directory ID です。
   */
  directoryId: string
  /**
   * issue 所属 team ID です。
   */
  teamId?: string
  /**
   * 旧 event の issue ID です。
   */
  issueId: string
  /**
   * `created`、`updated`、`commented` の旧 event 種別です。
   */
  eventType: string
  /**
   * 旧 event に保存された actor user ID です。
   */
  actorUserId: string
  /**
   * 旧 activity summary です。
   */
  summary?: string
  /**
   * 旧 comment event に保存された本文です。
   */
  body?: string
  /**
   * 旧 event の作成 timestamp です。
   */
  createdAt: string
}

/**
 * request fingerprint の入力です。
 */
export type AuditRequestFingerprintInput = {
  /**
   * HTTP method または同等の operation verb です。
   */
  method: string
  /**
   * HTTP path または同等の operation path です。
   */
  path: string
  /**
   * request body です。
   */
  body?: unknown
  /**
   * query parameter です。
   */
  query?: unknown
}

/**
 * mutation 共通の audit context 作成入力です。
 */
export type MutationAuditContextInput = {
  /**
   * mutation 対象の canonical workspace ID です。
   */
  workspaceId: string
  /**
   * mutation を行った主体です。
   */
  actor: AuditActor
  /**
   * client または呼び出し元が発行した idempotency key です。
   */
  idempotencyKey: string
  /**
   * fingerprint 対象の request です。
   */
  request: AuditRequestFingerprintInput
  /**
   * mutation 発生元の追跡情報です。
   */
  source: AuditSource
  /**
   * mutation 発生 timestamp です。省略時は現在時刻を使います。
   */
  occurredAt?: string
  /**
   * 呼び出し元で採番済みの correlation ID です。
   */
  correlationId?: string
}

/**
 * 一つの mutation で共有する audit context です。
 */
export type MutationAuditContext = {
  /**
   * mutation 対象の canonical workspace ID です。
   */
  workspaceId: string
  /**
   * mutation を行った主体です。
   */
  actor: AuditActor
  /**
   * mutation 発生 timestamp です。
   */
  occurredAt: string
  /**
   * 同一 mutation の event を束ねる correlation ID です。
   */
  correlationId: string
  /**
   * 生の key を保存しない idempotency key hash です。
   */
  idempotencyKeyHash: string
  /**
   * request 内容を比較する fingerprint です。
   */
  requestFingerprint: string
  /**
   * mutation 発生元の追跡情報です。
   */
  source: AuditSource
}

/**
 * field diff の抽出・redaction 設定です。
 */
export type AuditDiffOptions = {
  /**
   * diff に含める field path です。省略時は全 field を対象にします。
   */
  includeFields?: readonly string[]
  /**
   * 標準の機密 field に追加して値を置換する field path です。
   */
  redactFields?: readonly string[]
}

/**
 * mutation から audit event を組み立てる入力です。
 */
export type CreateAuditEventInput = {
  /**
   * mutation 共通の audit context です。
   */
  context: MutationAuditContext
  /**
   * `project.created` などの event 種別です。
   */
  eventType: string
  /**
   * activity を集約する entity です。
   */
  entity: AuditEntity
  /**
   * mutation が直接変更した target です。省略時は entity を使います。
   */
  target?: AuditEntity
  /**
   * mutation action の短い識別子です。省略時は eventType の末尾を使います。
   */
  action?: string
  /**
   * mutation 前の field snapshot です。
   */
  before?: Readonly<Record<string, unknown>> | null
  /**
   * mutation 後の field snapshot です。
   */
  after?: Readonly<Record<string, unknown>> | null
  /**
   * field diff の抽出・redaction 設定です。
   */
  diff?: AuditDiffOptions
  /**
   * 呼び出し元で作成済みの field changes です。
   */
  changes?: AuditFieldChange[]
  /**
   * 同一 request で同じ entity/eventType を複数回記録する際の連番です。
   */
  sequence?: number
  /**
   * activity 表示用の短い説明です。
   */
  summary?: string
  /**
   * DynamoDB TTL に渡す epoch seconds です。
   */
  expiresAt?: number
  /**
   * schema の必須項目に含めない付加情報です。
   */
  metadata?: Readonly<Record<string, unknown>>
  /**
   * notification/automation へ配送するかどうかを示す outbox 状態です。
   */
  outboxStatus?: AuditOutboxStatus
}

/**
 * DocumentClient の transaction に追加できる audit event Put です。
 */
export type AuditTransactWriteItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number]

/**
 * at-least-once consumer の重複処理を防ぐ receipt 入力です。
 */
export type AuditConsumerReceiptInput = {
  /**
   * notification や automation などの consumer 名です。
   */
  consumerName: string
  /**
   * 処理対象の deterministic audit event ID です。
   */
  eventId: string
  /**
   * consumer が処理を確定した ISO 8601 timestamp です。
   */
  processedAt?: string
  /**
   * receipt を削除する DynamoDB TTL epoch seconds です。
   */
  expiresAt?: number
}

/**
 * 既存 mutation client から条件付き audit Put を作成する入力です。
 */
export type MutationAuditEventInput = {
  /**
   * mutation 対象の directory/workspace ID です。
   */
  directoryId: string
  /**
   * `work-item.updated` などの event 種別です。
   */
  eventType: string
  /**
   * activity を集約する entity type です。
   */
  entityType: AuditEventEntityType
  /**
   * activity を集約する entity ID です。
   */
  entityId: string
  /**
   * mutation が直接変更した target です。
   */
  target?: AuditEntity
  /**
   * mutation action の短い識別子です。
   */
  action: string
  /**
   * mutation 発生 timestamp です。
   */
  occurredAt?: string
  /**
   * 呼び出し元で作成済みの field changes です。
   */
  changes?: AuditFieldChange[]
  /**
   * Activity と notification に表示できる短い概要です。
   */
  summary?: string
  /**
   * schema の必須項目に含めない付加情報です。
   */
  metadata?: Readonly<Record<string, unknown>>
  /**
   * 同じ mutation context から複数 event を作る場合の決定的な連番です。
   */
  sequence?: number
}

/**
 * audit timeline の検索条件です。
 */
export type AuditEventQuery = {
  /**
   * 検索対象の canonical workspace ID です。
   */
  workspaceId: string
  /**
   * actor ID による絞り込みです。
   */
  actorId?: string
  /**
   * actor kind による絞り込みです。
   */
  actorKind?: AuditActorKind
  /**
   * activity entity type による絞り込みです。
   */
  entityType?: string
  /**
   * activity entity ID による絞り込みです。entityType と組で指定します。
   */
  entityId?: string
  /**
   * mutation target type による絞り込みです。
   */
  targetType?: string
  /**
   * mutation target ID による絞り込みです。targetType と組で指定します。
   */
  targetId?: string
  /**
   * event type の許可一覧です。
   */
  eventTypes?: readonly string[]
  /**
   * 検索期間の開始 ISO 8601 timestamp です。
   */
  from?: string
  /**
   * 検索期間の終了 ISO 8601 timestamp です。
   */
  to?: string
  /**
   * 一度に評価する最大件数です。
   */
  limit?: number
  /**
   * 前回のレスポンスで返された opaque cursor です。
   */
  cursor?: string
  /**
   * timeline の並び順です。
   */
  direction?: 'ascending' | 'descending'
}

/**
 * audit timeline の1 pageです。
 */
export type AuditEventPage = {
  /**
   * schema v1 に正規化された event 一覧です。
   */
  events: AuditEventV1[]
  /**
   * 次 page がある場合の opaque cursor です。
   */
  nextCursor?: string
}

/**
 * environment ごとに差し替え可能な audit GSI 名です。
 */
export type AuditIndexNames = {
  /**
   * workspace timeline 用 GSI 名です。
   */
  workspace: string
  /**
   * actor timeline 用 GSI 名です。
   */
  actor: string
  /**
   * entity activity 用 GSI 名です。
   */
  entity: string
  /**
   * mutation target timeline 用 GSI 名です。
   */
  target: string
}

/**
 * local audit table bootstrap の待機設定です。
 */
export type LocalAuditTableBootstrapOptions = {
  /**
   * ACTIVE になるまで DescribeTable を行う最大回数です。
   */
  maxAttempts?: number
  /**
   * DescribeTable 間の待機 milliseconds です。
   */
  retryDelayMs?: number
  /**
   * 作成する local table で DynamoDB Stream を有効にするかどうかです。
   */
  streamEnabled?: boolean
}

/**
 * request の正規化内容から deterministic fingerprint を作成します。
 */
export function createRequestFingerprint(input: AuditRequestFingerprintInput) {
  return hashCanonical({
    body: input.body,
    method: requireText(input.method, 'Audit request method').toUpperCase(),
    path: requireText(input.path, 'Audit request path'),
    query: input.query,
  })
}

/**
 * 一つの mutation で共有する audit context を作成します。
 */
export function createMutationAuditContext(input: MutationAuditContextInput): MutationAuditContext {
  const workspaceId = requireText(input.workspaceId, 'Audit workspace ID')
  const actor = normalizeActor(input.actor)
  const idempotencyKey = requireText(input.idempotencyKey, 'Audit idempotency key')

  if (idempotencyKey.length > 256) {
    throw new RangeError('Audit idempotency key must be 256 characters or fewer.')
  }

  const occurredAt = normalizeTimestamp(input.occurredAt ?? new Date().toISOString(), 'Audit occurredAt')
  const idempotencyKeyHash = hashText(
    `audit-idempotency-v1\0${workspaceId}\0${actor.id}\0${idempotencyKey}`,
  )
  const requestFingerprint = createRequestFingerprint(input.request)
  const correlationId = input.correlationId
    ? requireText(input.correlationId, 'Audit correlation ID')
    : `corr_${hashText(`${workspaceId}\0${idempotencyKeyHash}`).slice(0, 32)}`

  if (correlationId.length > 256) {
    throw new RangeError('Audit correlation ID must be 256 characters or fewer.')
  }

  return {
    workspaceId,
    actor,
    occurredAt,
    correlationId,
    idempotencyKeyHash,
    requestFingerprint,
    source: normalizeSource(input.source),
  }
}

/**
 * mutation-scoped idempotency key hash と event sequence から deterministic event ID を作成します。
 *
 * @remarks
 * 同じ logical event の retry は同じ sequence を再利用します。生成後の resource ID や
 * event type に左右されないよう、entity と event type は digest に含めません。後続の
 * 正当な state transition は caller が別の sequence slot を割り当てます。
 */
export function createAuditEventId(
  context: MutationAuditContext,
  eventType: string,
  entity: AuditEntity,
  sequence = 0,
) {
  const normalizedSequence = normalizeSequence(sequence)
  normalizeEntity(entity, 'Audit entity')
  requireText(eventType, 'Audit event type')
  const digest = hashCanonical({
    idempotencyKeyHash: context.idempotencyKeyHash,
    schemaVersion: AUDIT_SCHEMA_VERSION,
    sequence: normalizedSequence,
    workspaceId: requireText(context.workspaceId, 'Audit workspace ID'),
  })

  return `evt_${digest.slice(0, 48)}`
}

/**
 * workspace 内の actor を GSI 用 key に変換します。
 */
export function createAuditActorKey(workspaceId: string, actorId: string) {
  return `${requireText(workspaceId, 'Audit workspace ID')}#actor#${requireText(actorId, 'Audit actor ID')}`
}

/**
 * workspace 内の entity を GSI 用 key に変換します。
 */
export function createAuditEntityKey(workspaceId: string, entity: AuditEntity) {
  const normalizedEntity = normalizeEntity(entity, 'Audit entity')

  return `${requireText(workspaceId, 'Audit workspace ID')}#${normalizedEntity.type}#${normalizedEntity.id}`
}

/**
 * Workspace member lifecycle 用の PII を含まない scoped entity ID を作成します。
 */
export function createWorkspaceMemberAuditEntityId(
  workspaceId: string,
  memberId: string,
  pseudonymKey: string,
) {
  const normalizedWorkspaceId = requireText(workspaceId, 'Audit workspace ID')
  const normalizedMemberId = requireText(memberId, 'Audit member ID')
  const workspacePseudonym = createWorkspaceAccessPseudonym(
    pseudonymKey,
    'workspace',
    normalizedWorkspaceId,
  )
  const memberPseudonym = createWorkspaceAccessPseudonym(
    pseudonymKey,
    'member',
    normalizedWorkspaceId,
    normalizedMemberId,
  )

  return `workspace/wsp_${WORKSPACE_ACCESS_AUDIT_ENTITY_ID_CONTRACT_VERSION}_${workspacePseudonym}` +
    `/member/mbr_${WORKSPACE_ACCESS_AUDIT_ENTITY_ID_CONTRACT_VERSION}_${memberPseudonym}`
}

/**
 * Workspace invitation lifecycle 用の PII を含まない scoped entity ID を作成します。
 */
export function createWorkspaceInvitationAuditEntityId(
  workspaceId: string,
  invitationId: string,
  pseudonymKey: string,
) {
  const normalizedWorkspaceId = requireText(workspaceId, 'Audit workspace ID')
  const normalizedInvitationId = requireText(invitationId, 'Audit invitation ID')
  const workspacePseudonym = createWorkspaceAccessPseudonym(
    pseudonymKey,
    'workspace',
    normalizedWorkspaceId,
  )
  const invitationPseudonym = createWorkspaceAccessPseudonym(
    pseudonymKey,
    'invitation',
    normalizedWorkspaceId,
    normalizedInvitationId,
  )

  return `workspace/wsp_${WORKSPACE_ACCESS_AUDIT_ENTITY_ID_CONTRACT_VERSION}_${workspacePseudonym}` +
    `/invitation/inv_${WORKSPACE_ACCESS_AUDIT_ENTITY_ID_CONTRACT_VERSION}_${invitationPseudonym}`
}

/**
 * Workspace access audit pseudonym key を環境変数から読み、64桁小文字hex形式を検証します。
 *
 * @param environment key を読む環境変数 map です。
 * @returns live writer と backfill で固定して共有する32-byte random値のhex表現です。
 */
export function readWorkspaceAuditPseudonymKey(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const key = environment[WORKSPACE_AUDIT_PSEUDONYM_KEY_ENV]

  if (!key) {
    throw new TypeError(`${WORKSPACE_AUDIT_PSEUDONYM_KEY_ENV} is required.`)
  }

  if (!workspaceAuditPseudonymKeyPattern.test(key)) {
    throw new TypeError(
      `${WORKSPACE_AUDIT_PSEUDONYM_KEY_ENV} must be exactly 64 lowercase hexadecimal characters.`,
    )
  }

  return key
}

/**
 * before / after snapshot から redaction 済み field diff を作成します。
 */
export function createAuditFieldDiff(
  before: Readonly<Record<string, unknown>> | null | undefined,
  after: Readonly<Record<string, unknown>> | null | undefined,
  options: AuditDiffOptions = {},
) {
  const beforeFields = flattenAuditRecord(before)
  const afterFields = flattenAuditRecord(after)
  const fieldNames = [...new Set([...beforeFields.keys(), ...afterFields.keys()])].sort()
  const changes: AuditFieldChange[] = []

  for (const field of fieldNames) {
    if (!isIncludedField(field, options.includeFields)) {
      continue
    }

    const beforeValue = beforeFields.get(field)
    const afterValue = afterFields.get(field)
    const hasBeforeValue = beforeFields.has(field)
    const hasAfterValue = afterFields.has(field)

    if (
      hasBeforeValue === hasAfterValue &&
      canonicalString(beforeValue) === canonicalString(afterValue)
    ) {
      continue
    }

    const redacted = isRedactedField(field, options.redactFields)
    changes.push({
      field,
      ...(hasBeforeValue
        ? { before: redacted ? AUDIT_REDACTED_VALUE : toAuditValue(beforeValue) }
        : {}),
      ...(hasAfterValue
        ? { after: redacted ? AUDIT_REDACTED_VALUE : toAuditValue(afterValue) }
        : {}),
      ...(redacted ? { redacted: true } : {}),
    })
  }

  return changes
}

/**
 * mutation context と before / after snapshot から schema v1 event を作成します。
 */
export function createAuditEvent(input: CreateAuditEventInput): AuditEventV1 {
  const workspaceId = requireText(input.context.workspaceId, 'Audit workspace ID')
  const eventType = requireText(input.eventType, 'Audit event type')
  const entity = normalizeEntity(input.entity, 'Audit entity')
  const target = normalizeEntity(input.target ?? entity, 'Audit target')
  const actor = normalizeActor(input.context.actor)
  const occurredAt = normalizeTimestamp(input.context.occurredAt, 'Audit occurredAt')
  const eventId = createAuditEventId(input.context, eventType, entity, input.sequence)
  const occurredAtEventId = `${occurredAt}#${eventId}`
  const action = input.action
    ? requireText(input.action, 'Audit action')
    : eventType.split('.').at(-1) ?? eventType
  const metadata = input.metadata ? toAuditObject(input.metadata) : undefined
  const changes = readChanges(
    input.changes ?? createAuditFieldDiff(input.before, input.after, input.diff),
  )
  const outboxStatus = input.outboxStatus ?? 'pending'

  if (outboxStatus !== 'pending' && outboxStatus !== 'suppressed') {
    throw new TypeError('Audit outbox status is invalid.')
  }

  if (input.expiresAt !== undefined && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0)) {
    throw new RangeError('Audit expiresAt must be a positive integer epoch timestamp.')
  }

  if (
    input.expiresAt === undefined &&
    !(
      input.context.source.kind === 'backfill' &&
      occurredAt === AUDIT_UNKNOWN_OCCURRED_AT &&
      outboxStatus === 'suppressed'
    )
  ) {
    throw new TypeError(
      'Audit expiresAt may be omitted only for a backfill event with an unknown occurredAt.',
    )
  }

  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    eventId,
    directoryId: workspaceId,
    workspaceId,
    workspaceKey: workspaceId,
    eventType,
    occurredAt,
    occurredAtEventId,
    workspaceEventKey: occurredAtEventId,
    actor,
    actorUserId: actor.id,
    actorKey: createAuditActorKey(workspaceId, actor.id),
    actorEventKey: occurredAtEventId,
    entity,
    entityType: entity.type,
    entityId: entity.id,
    entityKey: createAuditEntityKey(workspaceId, entity),
    entityEventKey: occurredAtEventId,
    target,
    targetType: target.type,
    targetId: target.id,
    targetKey: createAuditEntityKey(workspaceId, target),
    targetEventKey: occurredAtEventId,
    changes,
    action,
    correlationId: requireText(input.context.correlationId, 'Audit correlation ID'),
    idempotencyKeyHash: requireText(input.context.idempotencyKeyHash, 'Audit idempotency key hash'),
    requestFingerprint: requireText(input.context.requestFingerprint, 'Audit request fingerprint'),
    source: input.context.source.kind,
    sourceDetails: normalizeSource(input.context.source),
    ...(input.summary
      ? { summary: limitAuditText(requireText(input.summary, 'Audit summary')) }
      : {}),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    ...(metadata ? { metadata } : {}),
    outboxStatus,
  }
}

/**
 * state write と同じ TransactWriteCommand に追加する条件付き event Put を作成します。
 */
export function createAuditTransactPut(tableName: string, event: AuditEventV1): AuditTransactWriteItem {
  return {
    Put: {
      TableName: requireText(tableName, 'Audit table name'),
      Item: event,
      ConditionExpression: 'attribute_not_exists(#directoryId) AND attribute_not_exists(#eventId)',
      ExpressionAttributeNames: {
        '#directoryId': 'directoryId',
        '#eventId': 'eventId',
      },
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    },
  }
}

/**
 * consumer projection と同じ transaction に入れる重複防止 receipt Put を作成します。
 */
export function createAuditConsumerReceiptTransactPut(
  tableName: string,
  input: AuditConsumerReceiptInput,
): AuditTransactWriteItem {
  const processedAt = normalizeTimestamp(
    input.processedAt ?? new Date().toISOString(),
    'Audit consumer processedAt',
  )

  if (input.expiresAt !== undefined && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= 0)) {
    throw new RangeError('Audit consumer receipt expiresAt must be a positive integer epoch timestamp.')
  }

  return {
    Put: {
      TableName: requireText(tableName, 'Audit consumer receipt table name'),
      Item: {
        consumerName: requireText(input.consumerName, 'Audit consumer name'),
        eventId: requireText(input.eventId, 'Audit event ID'),
        processedAt,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      },
      ConditionExpression: 'attribute_not_exists(#consumerName) AND attribute_not_exists(#eventId)',
      ExpressionAttributeNames: {
        '#consumerName': 'consumerName',
        '#eventId': 'eventId',
      },
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    },
  }
}

/**
 * DynamoDB の audit timeline を GSI と opaque cursor で検索します。
 */
export class DynamoDbAuditEventsClient {
  /**
   * audit table を操作する DocumentClient です。
   */
  private readonly documentClient: DynamoDBDocumentClient

  /**
   * audit event table 名です。
   */
  private readonly tableName: string

  /**
   * query に使う GSI 名です。
   */
  private readonly indexNames: AuditIndexNames

  /**
   * local table bootstrap に使う low-level DynamoDB client です。
   */
  private readonly dynamoDbClient?: DynamoDBClient

  /**
   * query 前に local audit table を作成・検証するかどうかです。
   */
  private readonly bootstrapLocalTables: boolean

  /**
   * DynamoDB audit query client を作成します。
   */
  constructor(
    documentClient: DynamoDBDocumentClient,
    tableName: string,
    indexNames: Partial<AuditIndexNames> = {},
    dynamoDbClient?: DynamoDBClient,
    bootstrapLocalTables = false,
  ) {
    this.documentClient = documentClient
    this.tableName = requireText(tableName, 'Audit table name')
    this.indexNames = {
      workspace: indexNames.workspace ?? AUDIT_WORKSPACE_INDEX_NAME,
      actor: indexNames.actor ?? AUDIT_ACTOR_INDEX_NAME,
      entity: indexNames.entity ?? AUDIT_ENTITY_INDEX_NAME,
      target: indexNames.target ?? AUDIT_TARGET_INDEX_NAME,
    }
    this.dynamoDbClient = dynamoDbClient
    this.bootstrapLocalTables = bootstrapLocalTables
  }

  /**
   * Immutable audit event を idempotent に append します。
   */
  async putEvent(event: AuditEventV1) {
    if (this.bootstrapLocalTables && this.dynamoDbClient) {
      await ensureLocalAuditEventsTable(this.tableName, this.dynamoDbClient)
    }
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: event,
        ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(eventId)',
      }))
    } catch (error) {
      if (!isAwsNamedError(error, 'ConditionalCheckFailedException')) throw error
      const existing = await this.getEvent(event.workspaceId, event.eventId)
      if (
        existing?.eventType !== event.eventType ||
        existing?.requestFingerprint !== event.requestFingerprint ||
        existing?.actor.id !== event.actor.id ||
        existing?.actor.kind !== event.actor.kind ||
        existing?.entity.type !== event.entity.type ||
        existing?.entity.id !== event.entity.id
      ) {
        throw new TypeError('Audit event idempotency key conflicts with an existing event.')
      }
    }
  }

  /**
   * Deterministic ID の audit event を強整合読みで返します。
   */
  async getEvent(workspaceId: string, eventId: string) {
    if (this.bootstrapLocalTables && this.dynamoDbClient) {
      await ensureLocalAuditEventsTable(this.tableName, this.dynamoDbClient)
    }
    const normalizedWorkspaceId = requireText(workspaceId, 'Audit workspace ID')
    const normalizedEventId = requireText(eventId, 'Audit event ID')
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        directoryId: normalizedWorkspaceId,
        eventId: normalizedEventId,
      },
      ConsistentRead: true,
    }))
    if (!response.Item) return undefined
    const event = upcastAuditEvent(response.Item)
    return event.workspaceId === normalizedWorkspaceId && event.eventId === normalizedEventId
      ? event
      : undefined
  }

  /**
   * workspace、actor、entity、target、期間で audit event を1 page取得します。
   */
  async query(input: AuditEventQuery): Promise<AuditEventPage> {
    if (this.bootstrapLocalTables && this.dynamoDbClient) {
      await ensureLocalAuditEventsTable(this.tableName, this.dynamoDbClient)
    }

    const normalizedInput = normalizeAuditQuery(input)
    const plan = createAuditQueryPlan(normalizedInput, this.indexNames)
    const scopeHash = hashCanonical({
      ...normalizedInput,
      cursor: undefined,
      limit: undefined,
      indexName: plan.indexName,
    })
    const exclusiveStartKey = input.cursor
      ? decodeAuditCursor(
          input.cursor,
          plan.indexName,
          scopeHash,
          plan.partitionName,
          plan.partitionValue,
          normalizedInput.workspaceId,
        )
      : undefined
    const expressionAttributeNames: Record<string, string> = {
      '#partitionKey': plan.partitionName,
      '#timelineKey': plan.sortName,
      '#directoryId': 'directoryId',
    }
    const expressionAttributeValues: Record<string, unknown> = {
      ':partitionValue': plan.partitionValue,
      ':workspaceId': normalizedInput.workspaceId,
    }
    const keyConditions = ['#partitionKey = :partitionValue']

    addTimeKeyCondition(
      keyConditions,
      expressionAttributeValues,
      normalizedInput.from,
      normalizedInput.to,
    )

    const filters = ['#directoryId = :workspaceId']
    addAuditQueryFilters(
      filters,
      expressionAttributeNames,
      expressionAttributeValues,
      normalizedInput,
      plan,
    )

    const commandInput: QueryCommandInput = {
      TableName: this.tableName,
      IndexName: plan.indexName,
      KeyConditionExpression: keyConditions.join(' AND '),
      FilterExpression: filters.join(' AND '),
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ExclusiveStartKey: exclusiveStartKey,
      Limit: normalizedInput.limit,
      ScanIndexForward: normalizedInput.direction === 'ascending',
    }
    const response = await this.documentClient.send(new QueryCommand(commandInput))
    const events = (response.Items ?? [])
      .map((item) => upcastAuditEvent(item))
      .filter((event) => event.workspaceId === normalizedInput.workspaceId)

    return {
      events,
      ...(response.LastEvaluatedKey
        ? { nextCursor: encodeAuditCursor(plan.indexName, scopeHash, response.LastEvaluatedKey) }
        : {}),
    }
  }
}

/**
 * before / after snapshot から指定 field の redaction 済み changes を作成します。
 */
export function createAuditFieldChanges(
  before: Readonly<Record<string, unknown>> | null | undefined,
  after: Readonly<Record<string, unknown>> | null | undefined,
  includeFields?: readonly string[],
  redactFields?: readonly string[],
) {
  return createAuditFieldDiff(before, after, { includeFields, redactFields })
}

/**
 * state write と同じ transaction に追加する audit event Put を作成します。
 */
export const createAuditEventTransactPut = createAuditTransactPut

/**
 * event 発生時刻と保持日数から DynamoDB TTL の epoch seconds を計算します。
 *
 * @param occurredAt event が発生した ISO 8601 timestamp です。
 * @param retentionDays event 発生時刻から保持する日数です。
 * @returns DynamoDB TTL に使用する epoch seconds です。
 */
export function calculateAuditExpiresAt(occurredAt: string, retentionDays: number) {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new RangeError('Audit retention days must be a positive number.')
  }

  const normalizedOccurredAt = normalizeTimestamp(occurredAt, 'Audit occurredAt')

  return Math.floor(Date.parse(normalizedOccurredAt) / 1000) +
    Math.max(1, Math.floor(retentionDays)) * 86_400
}

/**
 * Environment で構成した共通 audit retention 日数を返します。
 */
export function getConfiguredAuditRetentionDays() {
  const configuredRetentionDays = [
    process.env.MUKUROJI_AUDIT_RETENTION_DAYS,
    process.env.AUDIT_RETENTION_DAYS,
  ].find((value) => value !== undefined && value.trim() !== '')
  const retentionDays = Number(configuredRetentionDays ?? 2555)
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new RangeError('Audit retention days must be a positive number.')
  }
  return Math.floor(retentionDays)
}

/**
 * optional audit 設定を扱う既存 mutation client 用の条件付き event Put を作成します。
 */
export function createMutationAuditEventPut(
  tableName: string | undefined,
  context: MutationAuditContext | undefined,
  input: MutationAuditEventInput,
) {
  if (!tableName || !context) {
    return undefined
  }

  const retentionDays = getConfiguredAuditRetentionDays()
  const occurredAt = normalizeTimestamp(input.occurredAt ?? context.occurredAt, 'Audit occurredAt')
  const expiresAt = calculateAuditExpiresAt(occurredAt, retentionDays)
  const event = createAuditEvent({
    context: { ...context, workspaceId: input.directoryId, occurredAt },
    eventType: input.eventType,
    entity: { type: input.entityType, id: input.entityId },
    target: input.target,
    action: input.action,
    changes: input.changes,
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
    expiresAt,
  })

  return createAuditTransactPut(tableName, event)
}

/**
 * process environment から明示設定された DynamoDB endpoint を取得します。
 *
 * @param environment endpoint 設定を読む environment です。
 * @returns 最初に見つかった空でない DynamoDB endpoint です。
 */
export function getConfiguredDynamoDbEndpoint(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  return [
    environment.DYNAMODB_ENDPOINT,
    environment.AWS_ENDPOINT_URL_DYNAMODB,
    environment.AWS_ENDPOINT_URL,
  ].map((value) => value?.trim()).find(Boolean)
}

/**
 * process environment から audit event table 名を取得します。
 */
export function getConfiguredAuditTableName(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const configuredName = (
    environment.MUKUROJI_AUDIT_EVENTS_TABLE ?? environment.AUDIT_EVENTS_TABLE_NAME
  )?.trim()

  if (configuredName) {
    return configuredName
  }

  const endpoint = getConfiguredDynamoDbEndpoint(environment)

  if (endpoint && /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|floci)(?::|\/|$)/.test(endpoint)) {
    return 'mukuroji-audit-events'
  }

  return undefined
}

/**
 * schema v0 / v1 の保存値を schema v1 event に正規化します。
 */
export function upcastAuditEvent(value: unknown): AuditEventV1 {
  const record = requireRecord(value, 'Audit event')

  if (record.schemaVersion === AUDIT_SCHEMA_VERSION) {
    return normalizeV1Event(record)
  }

  if (record.schemaVersion !== undefined && record.schemaVersion !== 0) {
    throw new TypeError(`Unsupported audit schema version: ${String(record.schemaVersion)}`)
  }

  return upcastV0Event(record)
}

/**
 * 保存用 audit event を activity/audit/export 共通の公開 view に射影します。
 *
 * @remarks
 * DynamoDB key、request fingerprint、idempotency hash、TTL、outbox 状態、IP/User-Agent を
 * 含む source details は公開しません。
 */
export function toAuditEventView(value: unknown) {
  const event = upcastAuditEvent(value)
  const metadata = createAuditMetadataView(event.metadata)

  return {
    eventId: event.eventId,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    actor: event.actor,
    entity: event.entity,
    target: event.target,
    changes: event.changes,
    action: event.action,
    correlationId: event.correlationId,
    source: event.source,
    ...(event.summary ? { summary: event.summary } : {}),
    ...(metadata ? { metadata } : {}),
  }
}

const publicAuditMetadataFields = new Set([
  'adapter',
  'backfilled',
  'commentId',
  'diffUnavailable',
  'kind',
  'legacyEventId',
  'legacyEventType',
  'legacySource',
  'memberKey',
  'projectId',
  'teamId',
])

function createAuditMetadataView(metadata: AuditObject | undefined) {
  if (!metadata) {
    return undefined
  }

  const entries = Object.entries(metadata)
    .filter(([field]) => publicAuditMetadataFields.has(field))

  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

/**
 * audit event の公開 view を1行1 JSON objectのNDJSON streamへ変換します。
 */
export async function* streamAuditEventsAsNdjson(
  events: Iterable<unknown> | AsyncIterable<unknown>,
): AsyncGenerator<string> {
  for await (const event of events) {
    yield `${JSON.stringify(toAuditEventView(event))}\n`
  }
}

/**
 * 小規模な audit event collection を一つのNDJSON文字列へ変換します。
 */
export async function auditEventsToNdjson(events: Iterable<unknown> | AsyncIterable<unknown>) {
  const lines: string[] = []

  for await (const line of streamAuditEventsAsNdjson(events)) {
    lines.push(line)
  }

  return lines.join('')
}

const localAuditTableInitializers = new WeakMap<DynamoDBClient, Map<string, Promise<void>>>()

/**
 * local DynamoDB に本番と同じ key / GSI を持つ audit table を作成します。
 */
export async function ensureLocalAuditEventsTable(
  tableName: string,
  dynamoDbClient: DynamoDBClient,
  options: LocalAuditTableBootstrapOptions = {},
) {
  const normalizedTableName = requireText(tableName, 'Audit table name')
  let clientInitializers = localAuditTableInitializers.get(dynamoDbClient)

  if (!clientInitializers) {
    clientInitializers = new Map<string, Promise<void>>()
    localAuditTableInitializers.set(dynamoDbClient, clientInitializers)
  }

  const existingInitializer = clientInitializers.get(normalizedTableName)

  if (existingInitializer) {
    return existingInitializer
  }

  const initializer = createLocalAuditTable(normalizedTableName, dynamoDbClient, options)
    .finally(() => {
      clientInitializers?.delete(normalizedTableName)
    })

  clientInitializers.set(normalizedTableName, initializer)
  return initializer
}

/**
 * 検証・正規化済みの audit event query 条件です。
 */
type NormalizedAuditQuery = {
  /**
   * canonical workspace ID です。
   */
  workspaceId: string
  /**
   * actor ID filter です。
   */
  actorId?: string
  /**
   * actor kind filter です。
   */
  actorKind?: AuditActorKind
  /**
   * entity type filter です。
   */
  entityType?: string
  /**
   * entity ID filter です。
   */
  entityId?: string
  /**
   * target type filter です。
   */
  targetType?: string
  /**
   * target ID filter です。
   */
  targetId?: string
  /**
   * event type filter です。
   */
  eventTypes?: string[]
  /**
   * 期間開始 timestamp です。
   */
  from?: string
  /**
   * 期間終了 timestamp です。
   */
  to?: string
  /**
   * page size です。
   */
  limit: number
  /**
   * opaque cursor です。
   */
  cursor?: string
  /**
   * timeline の並び順です。
   */
  direction: 'ascending' | 'descending'
}

/**
 * audit event query が使用する DynamoDB index と partition の計画です。
 */
type AuditQueryPlan = {
  /**
   * query 対象 GSI 名です。
   */
  indexName: string
  /**
   * GSI partition key attribute 名です。
   */
  partitionName: string
  /**
   * GSI partition key value です。
   */
  partitionValue: string
  /**
   * GSI sort key attribute 名です。
   */
  sortName: string
  /**
   * query が直接利用する filter axis です。
   */
  axis: 'workspace' | 'actor' | 'entity' | 'target'
}

/**
 * audit event query の継続位置を保持する opaque cursor の payload です。
 */
type AuditCursorPayload = {
  /**
   * cursor schema version です。
   */
  version: 1
  /**
   * cursor を発行した GSI 名です。
   */
  indexName: string
  /**
   * query 条件の hash です。
   */
  scopeHash: string
  /**
   * DynamoDB LastEvaluatedKey です。
   */
  lastEvaluatedKey: NonNullable<QueryCommandInput['ExclusiveStartKey']>
}

function normalizeAuditQuery(input: AuditEventQuery): NormalizedAuditQuery {
  const workspaceId = requireText(input.workspaceId, 'Audit workspace ID')
  const actorId = optionalText(input.actorId, 'Audit actor ID')
  const entityType = optionalText(input.entityType, 'Audit entity type')
  const entityId = optionalText(input.entityId, 'Audit entity ID')
  const targetType = optionalText(input.targetType, 'Audit target type')
  const targetId = optionalText(input.targetId, 'Audit target ID')

  if (entityId && !entityType) {
    throw new TypeError('Audit entityId requires entityType.')
  }

  if (targetId && !targetType) {
    throw new TypeError('Audit targetId requires targetType.')
  }

  const eventTypes = input.eventTypes
    ? [...new Set(input.eventTypes.map((eventType) => requireText(eventType, 'Audit event type')))]
    : undefined

  if (eventTypes && eventTypes.length > 20) {
    throw new RangeError('Audit eventTypes supports at most 20 values.')
  }

  const from = input.from ? normalizeTimestamp(input.from, 'Audit from') : undefined
  const to = input.to ? normalizeTimestamp(input.to, 'Audit to') : undefined

  if (from && to && from > to) {
    throw new RangeError('Audit from must be before or equal to to.')
  }

  return {
    workspaceId,
    ...(actorId ? { actorId } : {}),
    ...(input.actorKind ? { actorKind: input.actorKind } : {}),
    ...(entityType ? { entityType } : {}),
    ...(entityId ? { entityId } : {}),
    ...(targetType ? { targetType } : {}),
    ...(targetId ? { targetId } : {}),
    ...(eventTypes && eventTypes.length > 0 ? { eventTypes } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    limit: clampPageLimit(input.limit),
    ...(input.cursor ? { cursor: requireText(input.cursor, 'Audit cursor') } : {}),
    direction: input.direction ?? 'descending',
  }
}

function createAuditQueryPlan(
  input: NormalizedAuditQuery,
  indexNames: AuditIndexNames,
): AuditQueryPlan {
  if (input.targetType && input.targetId) {
    return {
      indexName: indexNames.target,
      partitionName: 'targetKey',
      partitionValue: createAuditEntityKey(input.workspaceId, {
        type: input.targetType,
        id: input.targetId,
      }),
      sortName: 'targetEventKey',
      axis: 'target',
    }
  }

  if (input.entityType && input.entityId) {
    return {
      indexName: indexNames.entity,
      partitionName: 'entityKey',
      partitionValue: createAuditEntityKey(input.workspaceId, {
        type: input.entityType,
        id: input.entityId,
      }),
      sortName: 'entityEventKey',
      axis: 'entity',
    }
  }

  if (input.actorId) {
    return {
      indexName: indexNames.actor,
      partitionName: 'actorKey',
      partitionValue: createAuditActorKey(input.workspaceId, input.actorId),
      sortName: 'actorEventKey',
      axis: 'actor',
    }
  }

  return {
    indexName: indexNames.workspace,
    partitionName: 'workspaceKey',
    partitionValue: input.workspaceId,
    sortName: 'workspaceEventKey',
    axis: 'workspace',
  }
}

function addTimeKeyCondition(
  keyConditions: string[],
  values: Record<string, unknown>,
  from: string | undefined,
  to: string | undefined,
) {
  if (from && to) {
    keyConditions.push('#timelineKey BETWEEN :fromKey AND :toKey')
    values[':fromKey'] = `${from}#`
    values[':toKey'] = `${to}#\uffff`
    return
  }

  if (from) {
    keyConditions.push('#timelineKey >= :fromKey')
    values[':fromKey'] = `${from}#`
  }

  if (to) {
    keyConditions.push('#timelineKey <= :toKey')
    values[':toKey'] = `${to}#\uffff`
  }
}

function addAuditQueryFilters(
  filters: string[],
  names: Record<string, string>,
  values: Record<string, unknown>,
  input: NormalizedAuditQuery,
  plan: AuditQueryPlan,
) {
  if (input.actorId && plan.axis !== 'actor') {
    names['#actorKey'] = 'actorKey'
    values[':actorKey'] = createAuditActorKey(input.workspaceId, input.actorId)
    filters.push('#actorKey = :actorKey')
  }

  if (input.actorKind) {
    names['#actor'] = 'actor'
    names['#actorKind'] = 'kind'
    values[':actorKind'] = input.actorKind
    filters.push('#actor.#actorKind = :actorKind')
  }

  if (input.entityType && plan.axis !== 'entity') {
    names['#entity'] = 'entity'
    names['#entityType'] = 'type'
    values[':entityType'] = input.entityType
    filters.push('#entity.#entityType = :entityType')
  }

  if (input.entityId && plan.axis !== 'entity') {
    names['#entity'] = 'entity'
    names['#entityId'] = 'id'
    values[':entityId'] = input.entityId
    filters.push('#entity.#entityId = :entityId')
  }

  if (input.targetType && plan.axis !== 'target') {
    names['#target'] = 'target'
    names['#targetType'] = 'type'
    values[':targetType'] = input.targetType
    filters.push('#target.#targetType = :targetType')
  }

  if (input.targetId && plan.axis !== 'target') {
    names['#target'] = 'target'
    names['#targetId'] = 'id'
    values[':targetId'] = input.targetId
    filters.push('#target.#targetId = :targetId')
  }

  if (input.eventTypes) {
    names['#eventType'] = 'eventType'
    const placeholders = input.eventTypes.map((eventType, index) => {
      const placeholder = `:eventType${index}`
      values[placeholder] = eventType
      return placeholder
    })
    filters.push(`#eventType IN (${placeholders.join(', ')})`)
  }
}

function encodeAuditCursor(
  indexName: string,
  scopeHash: string,
  lastEvaluatedKey: NonNullable<QueryCommandInput['ExclusiveStartKey']>,
) {
  const payload: AuditCursorPayload = {
    version: 1,
    indexName,
    scopeHash,
    lastEvaluatedKey,
  }

  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function decodeAuditCursor(
  cursor: string,
  indexName: string,
  scopeHash: string,
  partitionName: string,
  partitionValue: string,
  workspaceId: string,
) {
  let value: unknown

  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new TypeError('Audit cursor is invalid.')
  }

  const payload = requireRecord(value, 'Audit cursor')

  if (
    payload.version !== 1 ||
    payload.indexName !== indexName ||
    payload.scopeHash !== scopeHash ||
    !isRecord(payload.lastEvaluatedKey)
  ) {
    throw new TypeError('Audit cursor does not match the query.')
  }

  if (
    payload.lastEvaluatedKey[partitionName] !== partitionValue ||
    payload.lastEvaluatedKey.directoryId !== workspaceId ||
    typeof payload.lastEvaluatedKey.eventId !== 'string'
  ) {
    throw new TypeError('Audit cursor does not match the query partition.')
  }

  return payload.lastEvaluatedKey as NonNullable<QueryCommandInput['ExclusiveStartKey']>
}

function upcastV0Event(record: Record<string, unknown>): AuditEventV1 {
  const legacyEventId = requireTextValue(record.eventId, 'Legacy audit event ID')
  const workspaceId = requireTextValue(record.directoryId, 'Legacy audit directory ID')
  const issueId = requireTextValue(record.issueId, 'Legacy audit issue ID')
  const legacyEventType = requireTextValue(record.eventType, 'Legacy audit event type')
  const actorUserId = requireTextValue(record.actorUserId, 'Legacy audit actor ID')
  const teamId = typeof record.teamId === 'string' && record.teamId.trim()
    ? record.teamId.trim()
    : undefined
  const occurredAt = normalizeTimestamp(
    requireTextValue(record.createdAt, 'Legacy audit createdAt'),
    'Legacy audit createdAt',
  )
  const eventType = mapLegacyEventType(legacyEventType)
  const eventId = `evt_${hashCanonical({
    directoryTeamIssueId: record.directoryTeamIssueId,
    legacyEventId,
    workspaceId,
  }).slice(0, 48)}`
  const entity = {
    type: 'work-item',
    id: teamId ? `team/${teamId}/issue/${issueId}` : issueId,
  }
  const target = legacyEventType === 'commented'
    ? { type: 'comment', id: `${entity.id}/comment/${legacyEventId}` }
    : entity
  const occurredAtEventId = `${occurredAt}#${eventId}`
  const actor = { kind: 'user' as const, id: actorUserId }
  const body = typeof record.body === 'string' ? record.body : undefined

  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    eventId,
    directoryId: workspaceId,
    workspaceId,
    workspaceKey: workspaceId,
    eventType,
    occurredAt,
    occurredAtEventId,
    workspaceEventKey: occurredAtEventId,
    actor,
    actorUserId: actor.id,
    actorKey: createAuditActorKey(workspaceId, actor.id),
    actorEventKey: occurredAtEventId,
    entity,
    entityType: entity.type,
    entityId: entity.id,
    entityKey: createAuditEntityKey(workspaceId, entity),
    entityEventKey: occurredAtEventId,
    target,
    targetType: target.type,
    targetId: target.id,
    targetKey: createAuditEntityKey(workspaceId, target),
    targetEventKey: occurredAtEventId,
    changes: readChanges(body === undefined ? [] : [{ field: 'body', after: body }]),
    action: legacyEventType,
    correlationId: `corr_${hashText(`legacy\0${workspaceId}\0${legacyEventId}`).slice(0, 32)}`,
    idempotencyKeyHash: hashText(`legacy\0${workspaceId}\0${legacyEventId}`),
    requestFingerprint: hashCanonical(record),
    source: 'backfill',
    sourceDetails: { kind: 'backfill' },
    ...(typeof record.summary === 'string' && record.summary.trim()
      ? { summary: record.summary.trim() }
      : {}),
    metadata: {
      backfilled: true,
      diffUnavailable: legacyEventType === 'updated',
      legacyEventId,
      legacyEventType,
      ...(teamId ? { teamId } : {}),
    },
    outboxStatus: 'suppressed',
  }
}

function normalizeV1Event(record: Record<string, unknown>): AuditEventV1 {
  const eventId = requireTextValue(record.eventId, 'Audit event ID')
  const workspaceId = requireTextValue(record.workspaceId ?? record.directoryId, 'Audit workspace ID')
  const occurredAt = normalizeTimestamp(
    requireTextValue(record.occurredAt, 'Audit occurredAt'),
    'Audit occurredAt',
  )
  const occurredAtEventId = requireTextValue(
    record.occurredAtEventId ?? record.workspaceEventKey ?? record.entityEventKey,
    'Audit occurredAtEventId',
  )
  const actor = record.actor === undefined
    ? normalizeActor({
        kind: 'user',
        id: requireTextValue(record.actorUserId, 'Audit actor ID'),
      })
    : readActor(record.actor)
  const entity = record.entity === undefined
    ? normalizeEntity({
        type: requireTextValue(record.entityType, 'Audit entity type'),
        id: requireTextValue(record.entityId, 'Audit entity ID'),
      }, 'Audit entity')
    : readEntity(record.entity, 'Audit entity')
  const target = record.target === undefined
    ? normalizeEntity({
        type: typeof record.targetType === 'string' ? record.targetType : entity.type,
        id: typeof record.targetId === 'string' ? record.targetId : entity.id,
      }, 'Audit target')
    : readEntity(record.target, 'Audit target')
  const sourceDetails = isRecord(record.source)
    ? readSource(record.source)
    : readSource(record.sourceDetails ?? {
        kind: normalizeSourceKind(record.source),
      })
  const changes = readChanges(record.changes)
  const expiresAt = record.expiresAt
  const outboxStatus = record.outboxStatus ?? 'pending'

  if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || Number(expiresAt) <= 0)) {
    throw new TypeError('Audit expiresAt is invalid.')
  }

  if (outboxStatus !== 'pending' && outboxStatus !== 'suppressed') {
    throw new TypeError('Audit outbox status is invalid.')
  }

  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    eventId,
    directoryId: workspaceId,
    workspaceId,
    workspaceKey: typeof record.workspaceKey === 'string' ? record.workspaceKey : workspaceId,
    eventType: requireTextValue(record.eventType, 'Audit event type'),
    occurredAt,
    occurredAtEventId,
    workspaceEventKey: typeof record.workspaceEventKey === 'string'
      ? record.workspaceEventKey
      : occurredAtEventId,
    actor,
    actorUserId: typeof record.actorUserId === 'string' ? record.actorUserId : actor.id,
    actorKey: typeof record.actorKey === 'string'
      ? record.actorKey
      : createAuditActorKey(workspaceId, actor.id),
    actorEventKey: typeof record.actorEventKey === 'string'
      ? record.actorEventKey
      : occurredAtEventId,
    entity,
    entityType: entity.type,
    entityId: entity.id,
    entityKey: typeof record.entityKey === 'string'
      ? record.entityKey
      : createAuditEntityKey(workspaceId, entity),
    entityEventKey: typeof record.entityEventKey === 'string'
      ? record.entityEventKey
      : occurredAtEventId,
    target,
    targetType: target.type,
    targetId: target.id,
    targetKey: typeof record.targetKey === 'string'
      ? record.targetKey
      : createAuditEntityKey(workspaceId, target),
    targetEventKey: typeof record.targetEventKey === 'string'
      ? record.targetEventKey
      : occurredAtEventId,
    changes,
    action: typeof record.action === 'string'
      ? requireText(record.action, 'Audit action')
      : requireTextValue(record.eventType, 'Audit event type').split('.').at(-1) ?? 'changed',
    correlationId: requireTextValue(record.correlationId, 'Audit correlation ID'),
    idempotencyKeyHash: requireTextValue(
      record.idempotencyKeyHash ?? record.idempotencyKey,
      'Audit idempotency key hash',
    ),
    requestFingerprint: requireTextValue(record.requestFingerprint, 'Audit request fingerprint'),
    source: sourceDetails.kind,
    sourceDetails,
    ...(typeof record.summary === 'string' && record.summary.trim()
      ? { summary: record.summary.trim() }
      : {}),
    ...(expiresAt === undefined ? {} : { expiresAt: Number(expiresAt) }),
    ...(record.metadata === undefined
      ? {}
      : { metadata: toAuditObject(requireRecord(record.metadata, 'Audit metadata')) }),
    outboxStatus,
  }
}

function readActor(value: unknown): AuditActor {
  const record = requireRecord(value, 'Audit actor')
  const kind = record.kind

  if (
    kind !== 'user' &&
    kind !== 'system' &&
    kind !== 'service' &&
    kind !== 'break-glass'
  ) {
    throw new TypeError('Audit actor kind is invalid.')
  }

  return {
    id: requireTextValue(record.id, 'Audit actor ID'),
    kind,
    ...(typeof record.displayName === 'string' && record.displayName.trim()
      ? { displayName: record.displayName.trim() }
      : {}),
  }
}

function readEntity(value: unknown, label: string): AuditEntity {
  const record = requireRecord(value, label)

  return normalizeEntity({
    type: requireTextValue(record.type, `${label} type`),
    id: requireTextValue(record.id, `${label} ID`),
  }, label)
}

function readSource(value: unknown): AuditSource {
  const record = requireRecord(value, 'Audit source')
  const kind = record.kind

  if (kind !== 'api' && kind !== 'backfill' && kind !== 'migration' && kind !== 'system') {
    throw new TypeError('Audit source kind is invalid.')
  }

  return normalizeSource({
    kind,
    ...(typeof record.requestId === 'string' ? { requestId: record.requestId } : {}),
    ...(typeof record.method === 'string' ? { method: record.method } : {}),
    ...(typeof record.route === 'string' ? { route: record.route } : {}),
    ...(typeof record.ipAddress === 'string' ? { ipAddress: record.ipAddress } : {}),
    ...(typeof record.userAgent === 'string' ? { userAgent: record.userAgent } : {}),
  })
}

function readChanges(value: unknown): AuditFieldChange[] {
  if (!Array.isArray(value)) {
    throw new TypeError('Audit changes must be an array.')
  }

  return value.map((change, index) => {
    const record = requireRecord(change, `Audit change ${index}`)
    const field = requireTextValue(record.field, `Audit change ${index} field`)
    const redacted = record.redacted === true || isRedactedField(field, undefined)

    return {
      field,
      ...('before' in record
        ? { before: redacted ? AUDIT_REDACTED_VALUE : toAuditValue(record.before) }
        : {}),
      ...('after' in record
        ? { after: redacted ? AUDIT_REDACTED_VALUE : toAuditValue(record.after) }
        : {}),
      ...(redacted ? { redacted: true } : {}),
    }
  })
}

async function createLocalAuditTable(
  tableName: string,
  client: DynamoDBClient,
  options: LocalAuditTableBootstrapOptions,
) {
  try {
    await client.send(new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [
        { AttributeName: 'directoryId', AttributeType: 'S' },
        { AttributeName: 'eventId', AttributeType: 'S' },
        { AttributeName: 'workspaceKey', AttributeType: 'S' },
        { AttributeName: 'workspaceEventKey', AttributeType: 'S' },
        { AttributeName: 'actorKey', AttributeType: 'S' },
        { AttributeName: 'actorEventKey', AttributeType: 'S' },
        { AttributeName: 'entityKey', AttributeType: 'S' },
        { AttributeName: 'entityEventKey', AttributeType: 'S' },
        { AttributeName: 'targetKey', AttributeType: 'S' },
        { AttributeName: 'targetEventKey', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'directoryId', KeyType: 'HASH' },
        { AttributeName: 'eventId', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        createGlobalSecondaryIndex(AUDIT_WORKSPACE_INDEX_NAME, 'workspaceKey', 'workspaceEventKey'),
        createGlobalSecondaryIndex(AUDIT_ACTOR_INDEX_NAME, 'actorKey', 'actorEventKey'),
        createGlobalSecondaryIndex(AUDIT_ENTITY_INDEX_NAME, 'entityKey', 'entityEventKey'),
        createGlobalSecondaryIndex(AUDIT_TARGET_INDEX_NAME, 'targetKey', 'targetEventKey'),
      ],
      BillingMode: 'PAY_PER_REQUEST',
      ...(options.streamEnabled === false
        ? {}
        : {
            StreamSpecification: {
              StreamEnabled: true,
              StreamViewType: 'NEW_IMAGE',
            },
          }),
    }))
  } catch (error) {
    if (!isAwsNamedError(error, 'ResourceInUseException')) {
      throw error
    }
  }

  const maxAttempts = normalizePositiveInteger(options.maxAttempts ?? 20, 'Audit bootstrap maxAttempts')
  const retryDelayMs = normalizeNonNegativeInteger(options.retryDelayMs ?? 100, 'Audit bootstrap retryDelayMs')

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await client.send(new DescribeTableCommand({ TableName: tableName }))

      if (response.Table?.TableStatus === 'ACTIVE') {
        if (!isAuditTableDescription(response.Table)) {
          throw new Error(`Local audit table "${tableName}" does not match the expected schema.`)
        }

        return
      }
    } catch (error) {
      if (!isAwsNamedError(error, 'ResourceNotFoundException')) {
        throw error
      }
    }

    await sleep(retryDelayMs)
  }

  throw new Error(`Local audit table "${tableName}" did not become active.`)
}

function createGlobalSecondaryIndex(indexName: string, partitionKey: string, sortKey: string) {
  return {
    IndexName: indexName,
    KeySchema: [
      { AttributeName: partitionKey, KeyType: 'HASH' as const },
      { AttributeName: sortKey, KeyType: 'RANGE' as const },
    ],
    Projection: { ProjectionType: 'ALL' as const },
  }
}

function isAuditTableDescription(table: TableDescription) {
  return (
    hasKeySchema(table, [
      ['directoryId', 'HASH'],
      ['eventId', 'RANGE'],
    ]) &&
    hasIndexSchema(table, AUDIT_WORKSPACE_INDEX_NAME, 'workspaceKey', 'workspaceEventKey') &&
    hasIndexSchema(table, AUDIT_ACTOR_INDEX_NAME, 'actorKey', 'actorEventKey') &&
    hasIndexSchema(table, AUDIT_ENTITY_INDEX_NAME, 'entityKey', 'entityEventKey') &&
    hasIndexSchema(table, AUDIT_TARGET_INDEX_NAME, 'targetKey', 'targetEventKey')
  )
}

function hasIndexSchema(
  table: TableDescription,
  indexName: string,
  partitionKey: string,
  sortKey: string,
) {
  return Boolean(table.GlobalSecondaryIndexes?.some((index) =>
    index.IndexName === indexName &&
    hasKeySchema(index, [
      [partitionKey, 'HASH'],
      [sortKey, 'RANGE'],
    ]),
  ))
}

function hasKeySchema(
  value: { KeySchema?: TableDescription['KeySchema'] },
  expected: Array<[string, 'HASH' | 'RANGE']>,
) {
  return expected.every(([attributeName, keyType]) =>
    value.KeySchema?.some((key) => key.AttributeName === attributeName && key.KeyType === keyType),
  )
}

function flattenAuditRecord(value: Readonly<Record<string, unknown>> | null | undefined) {
  const fields = new Map<string, unknown>()

  if (!value) {
    return fields
  }

  flattenAuditValue(value, '', fields, new Set<object>())
  return fields
}

function flattenAuditValue(
  value: unknown,
  path: string,
  fields: Map<string, unknown>,
  ancestors: Set<object>,
) {
  if (isPlainRecord(value)) {
    if (ancestors.has(value)) {
      throw new TypeError('Audit snapshots must not contain circular references.')
    }

    const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)

    if (entries.length === 0 && path) {
      fields.set(path, {})
      return
    }

    ancestors.add(value)
    for (const [key, entryValue] of entries) {
      flattenAuditValue(entryValue, path ? `${path}.${key}` : key, fields, ancestors)
    }
    ancestors.delete(value)
    return
  }

  if (path && value !== undefined) {
    fields.set(path, value)
  }
}

function isIncludedField(field: string, includes: readonly string[] | undefined) {
  if (!includes || includes.length === 0) {
    return true
  }

  return includes.some((includedField) => {
    const normalized = includedField.trim()
    return normalized === field || field.startsWith(`${normalized}.`)
  })
}

function isRedactedField(field: string, extraFields: readonly string[] | undefined) {
  const sensitiveSegment = /^(?:access[-_]?(?:key|token)|api[-_]?key|authorization|cookie|credential|id[-_]?token|password|private[-_]?key|refresh[-_]?token|secret|signed[-_]?url|token)$/i

  if (field.split('.').some((segment) => sensitiveSegment.test(segment))) {
    return true
  }

  return extraFields?.some((extraField) => {
    const normalized = extraField.trim()
    return normalized === field || field.startsWith(`${normalized}.`)
  }) ?? false
}

function toAuditObject(value: Readonly<Record<string, unknown>>): AuditObject {
  const converted = sanitizeAuditMetadataValue(value, '', new Set<object>())

  if (!isRecord(converted) || Array.isArray(converted)) {
    throw new TypeError('Audit metadata must be an object.')
  }

  return converted as AuditObject
}

function sanitizeAuditMetadataValue(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): AuditValue {
  if (path && isRedactedField(path, undefined)) {
    return AUDIT_REDACTED_VALUE
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new TypeError('Audit metadata must not contain circular references.')
    }

    ancestors.add(value)
    const result = value.map((entry) => sanitizeAuditMetadataValue(entry, path, ancestors))
    ancestors.delete(value)
    return result
  }

  if (isPlainRecord(value)) {
    if (ancestors.has(value)) {
      throw new TypeError('Audit metadata must not contain circular references.')
    }

    ancestors.add(value)
    const result: AuditObject = {}

    for (const [key, entryValue] of Object.entries(value)) {
      if (entryValue !== undefined) {
        const childPath = path ? `${path}.${key}` : key
        result[key] = sanitizeAuditMetadataValue(entryValue, childPath, ancestors)
      }
    }

    ancestors.delete(value)
    return result
  }

  return toAuditValue(value)
}

function toAuditValue(
  value: unknown,
  ancestors = new Set<object>(),
  truncateText = true,
): AuditValue {
  if (value === null || typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'string') {
    return truncateText ? limitAuditText(value) : value
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value)
  }

  if (typeof value === 'bigint') {
    return value.toString()
  }

  if (typeof value === 'undefined') {
    return null
  }

  if (typeof value === 'symbol' || typeof value === 'function') {
    return truncateText ? limitAuditText(String(value)) : String(value)
  }

  if (value instanceof Date) {
    return normalizeTimestamp(value.toISOString(), 'Audit date')
  }

  if (value instanceof Uint8Array) {
    const encoded = Buffer.from(value).toString('base64')
    return truncateText ? limitAuditText(encoded) : encoded
  }

  if (typeof value === 'object') {
    if (ancestors.has(value)) {
      throw new TypeError('Audit values must not contain circular references.')
    }

    ancestors.add(value)
    if (Array.isArray(value)) {
      const result = value.map((item) => toAuditValue(item, ancestors, truncateText))
      ancestors.delete(value)
      return result
    }

    const result: AuditObject = {}
    for (const [key, entryValue] of Object.entries(value).sort(([first], [second]) => first.localeCompare(second))) {
      if (entryValue !== undefined) {
        result[key] = toAuditValue(entryValue, ancestors, truncateText)
      }
    }
    ancestors.delete(value)
    return result
  }

  return truncateText ? limitAuditText(String(value)) : String(value)
}

function limitAuditText(value: string) {
  return value.length <= AUDIT_MAX_TEXT_LENGTH
    ? value
    : `${value.slice(0, AUDIT_MAX_TEXT_LENGTH - 1)}…`
}

function canonicalString(value: unknown) {
  return JSON.stringify(toAuditValue(value, new Set<object>(), false))
}

function hashCanonical(value: unknown) {
  return hashText(JSON.stringify(toAuditValue(value, new Set<object>(), false)))
}

function hashText(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function createWorkspaceAccessPseudonym(
  pseudonymKey: string,
  kind: 'workspace' | 'member' | 'invitation',
  workspaceId: string,
  privateId?: string,
) {
  const encodedKey = readWorkspaceAuditPseudonymKey({
    [WORKSPACE_AUDIT_PSEUDONYM_KEY_ENV]: pseudonymKey,
  })
  const key = Buffer.from(encodedKey, 'hex')
  const payload = [
    workspaceAccessEntityIdNamespace,
    kind,
    workspaceId,
    ...(privateId === undefined ? [] : [privateId]),
  ].join('\0')

  return createHmac('sha256', key).update(payload).digest('hex').slice(0, 48)
}

function normalizeActor(actor: AuditActor): AuditActor {
  if (
    actor.kind !== 'user' &&
    actor.kind !== 'system' &&
    actor.kind !== 'service' &&
    actor.kind !== 'break-glass'
  ) {
    throw new TypeError('Audit actor kind is invalid.')
  }

  return {
    id: requireText(actor.id, 'Audit actor ID'),
    kind: actor.kind,
    ...(actor.displayName
      ? { displayName: limitAuditText(requireText(actor.displayName, 'Audit actor displayName')) }
      : {}),
  }
}

function normalizeEntity(entity: AuditEntity, label: string): AuditEntity {
  return {
    type: requireText(entity.type, `${label} type`),
    id: requireText(entity.id, `${label} ID`),
  }
}

function normalizeSource(source: AuditSource): AuditSource {
  if (
    source.kind !== 'api' &&
    source.kind !== 'backfill' &&
    source.kind !== 'migration' &&
    source.kind !== 'system'
  ) {
    throw new TypeError('Audit source kind is invalid.')
  }

  return {
    kind: source.kind,
    ...(source.requestId
      ? { requestId: limitAuditText(requireText(source.requestId, 'Audit source requestId')) }
      : {}),
    ...(source.method
      ? { method: limitAuditText(requireText(source.method, 'Audit source method').toUpperCase()) }
      : {}),
    ...(source.route
      ? { route: limitAuditText(requireText(source.route, 'Audit source route')) }
      : {}),
    ...(source.ipAddress
      ? { ipAddress: limitAuditText(requireText(source.ipAddress, 'Audit source IP address')) }
      : {}),
    ...(source.userAgent
      ? { userAgent: limitAuditText(requireText(source.userAgent, 'Audit source user agent')) }
      : {}),
  }
}

function normalizeSourceKind(value: unknown): AuditSourceKind {
  if (value === 'api' || value === 'backfill' || value === 'migration' || value === 'system') {
    return value
  }

  return 'system'
}

function mapLegacyEventType(eventType: string) {
  if (eventType === 'created') {
    return 'work-item.created'
  }

  if (eventType === 'updated') {
    return 'work-item.updated'
  }

  if (eventType === 'commented') {
    return 'comment.created'
  }

  return `legacy.${eventType}`
}

function normalizeTimestamp(value: string, label: string) {
  const timestamp = requireText(value, label)
  const date = new Date(timestamp)

  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`${label} must be a valid ISO 8601 timestamp.`)
  }

  return date.toISOString()
}

function clampPageLimit(value: number | undefined) {
  if (value === undefined) {
    return 50
  }

  if (!Number.isFinite(value)) {
    throw new RangeError('Audit query limit must be finite.')
  }

  return Math.max(1, Math.min(100, Math.floor(value)))
}

function normalizeSequence(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Audit event sequence must be a non-negative integer.')
  }

  return value
}

function normalizePositiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer.`)
  }

  return value
}

function normalizeNonNegativeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer.`)
  }

  return value
}

function optionalText(value: string | undefined, label: string) {
  return value === undefined ? undefined : requireText(value, label)
}

function requireTextValue(value: unknown, label: string) {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} is required.`)
  }

  return requireText(value, label)
}

function requireText(value: string, label: string) {
  const normalized = value.trim()

  if (!normalized) {
    throw new TypeError(`${label} is required.`)
  }

  return normalized
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object.`)
  }

  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isAwsNamedError(error: unknown, name: string) {
  return isRecord(error) && error.name === name
}

async function sleep(milliseconds: number) {
  if (milliseconds === 0) {
    return
  }

  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}
