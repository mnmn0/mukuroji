import {
  loadServerConfig,
} from '../../../../infrastructure/config/server-config'
import {
  createDynamoDbClient as createConfiguredDynamoDbClient,
  createPlanningRevisionFenceWriterDynamoDbDocumentClient,
  shouldBootstrapLocalDynamoDb as shouldBootstrapConfiguredLocalDynamoDb,
} from '../../../../infrastructure/aws/dynamodb-client'
import {
  throwIfWorkspaceSearchWriterFenceTerminalError,
} from '../../../../infrastructure/runtime/workspace-search-writer-fence-document-client'
import {
  createAuditFieldChanges,
  createMutationAuditEventPut,
  ensureLocalAuditEventsTable,
  getConfiguredAuditTableName,
} from '../../../audit'
import type {
  MutationAuditContext,
} from '../../../audit'
import {
  normalizeCognitoUserId,
} from '../../../authentication'
import {
  PUBLIC_API_MAX_PAGE_SIZE,
} from '../../../developer-platform'
import type {
  IdempotencyCompletionTransactWrite,
} from '../../../developer-platform'
import {
  createDirectoryProjectId,
  normalizeProjectMemberKey,
  ProjectDataError,
} from '../../../directory'
import {
  createRequestSubmissionEventProjection,
} from '../../../request-intake'
import {
  isCanonicalWorkItemArchiveWindow,
  isCanonicalWorkItemRecord,
} from '../../canonical-work-item'
import { createResourceId } from '../../domain/resource-id'
import {
  deriveWorkItemScheduleDueDate,
  normalizeWorkItemSchedule,
  WorkItemScheduleError,
} from '../../domain/work-item-schedule'
import {
  WORK_ITEM_SCHEDULE_CASCADE_LIMIT,
} from '../../domain/work-item-schedule-dependencies'
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  UpdateTableCommand,
} from '@aws-sdk/client-dynamodb'
import type {
  TableDescription,
} from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb'
import type {
  TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
} from '@mukuroji/contracts'
import { PLANNING_STORAGE_SCHEMA_VERSION } from '../../../planning'
import type {
  CanonicalWorkItem,
  ConfirmedWorkItemSchedule,
  CustomFieldValue,
  RequestSubmissionEvent,
  ResolvedWorkItemConfiguration,
  TriageEntry,
  TriageEntryEvent,
  TeamIssueCommentResponseItem,
  WorkflowStatusCategory,
  WorkItemPriority,
  WorkItemRelation,
  WorkItemSchedule,
  WorkItemTriageContextEventSnapshot,
  WorkItemTriageContextSnapshot,
} from '@mukuroji/contracts'

/** Physical Planning META key that serializes canonical Work Item projections. */
const PLANNING_META_RECORD_KEY = 'META'

/**
 * Creates the Planning META update shared by canonical Work Item mutations.
 *
 * The Planning revision is also the bounded source-version fence for roll-ups. Updating it
 * in the same transaction as every canonical Work Item mutation lets a Planning publish use
 * one condition instead of one condition per source Work Item.
 *
 * @param planningTableName - Optional Planning table configured for the runtime.
 * @param workspaceId - Workspace whose canonical Work Item projection changes.
 * @param updatedAt - Mutation timestamp written to Planning META.
 * @returns A transaction update, or undefined when Planning storage is not configured.
 */
function createPlanningRevisionIncrementTransactionItem(
  planningTableName: string | undefined,
  workspaceId: string,
  updatedAt: string,
): NonNullable<TransactWriteCommandInput['TransactItems']>[number] | undefined {
  if (!planningTableName) return undefined
  return {
    Update: {
      TableName: planningTableName,
      Key: { workspaceId: `FENCE#${workspaceId}`, recordKey: PLANNING_META_RECORD_KEY },
      UpdateExpression:
        'SET #entryType = if_not_exists(#entryType, :entryType), ' +
        '#schemaVersion = if_not_exists(#schemaVersion, :schemaVersion), ' +
        '#updatedAt = :updatedAt ADD #revision :increment',
      ConditionExpression:
        '(attribute_not_exists(#entryType) AND ' +
        'attribute_not_exists(#schemaVersion) AND attribute_not_exists(#revision)) OR (' +
        '#entryType = :entryType AND #schemaVersion = :schemaVersion AND ' +
        'attribute_exists(#revision))',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#schemaVersion': 'schemaVersion',
        '#updatedAt': 'updatedAt',
        '#revision': 'revision',
      },
      ExpressionAttributeValues: {
        ':entryType': 'planning-meta',
        ':schemaVersion': PLANNING_STORAGE_SCHEMA_VERSION,
        ':updatedAt': updatedAt,
        ':increment': 1,
      },
    },
  }
}

/** Authorization generations observed before a canonical Work Item mutation. */
export type WorkItemAuthorizationSnapshot = {
  /** Owning Workspace identifier. */
  workspaceId: string
  /** Authenticated Workspace member key. */
  memberKey: string
  /** Workspace membership version observed during authorization. */
  workspaceMemberVersion: number
  /** Planning authorization revision observed during authorization. */
  planningRevision: number
  /** Enterprise Identity control revision observed during authorization. */
  enterpriseControlRevision?: number
}

/** Source-of-truth row converted only inside the DynamoDB adapter. */
type WorkItemAuthorizationGenerationGuard = {
  /** Stable semantic purpose used to classify transaction cancellations safely. */
  kind: 'workspace-member' | 'planning' | 'enterprise-control'
  /** DynamoDB table containing the authorization row. */
  tableName: string
  /** Complete primary key of the authorization row. */
  key: Readonly<Record<string, string | undefined>>
  /** Attribute containing the monotonic authorization generation. */
  generationAttribute: string
  /** Generation observed while authorizing the operation. */
  expectedGeneration: string | number
  /** Allows an absent row when the expected generation is zero. */
  allowMissingWhenExpectedZero?: boolean
  /** Additional scalar attributes that must remain unchanged. */
  requiredAttributes?: Readonly<Record<string, string | number | boolean>>
}

/**
 * Converts authorization generation guards into DynamoDB transaction checks.
 *
 * @param guards - Source-of-truth rows observed during authorization.
 * @returns Condition checks ready to prepend to a Work Item transaction.
 */
function createDynamoDbWorkItemAuthorizationConditionChecks(
  guards: readonly WorkItemAuthorizationGenerationGuard[],
): NonNullable<TransactWriteCommandInput['TransactItems']> {
  return guards.map((guard) => {
    const expectedAttributes = {
      [guard.generationAttribute]: guard.expectedGeneration,
      ...guard.requiredAttributes,
    }
    const entries = Object.entries(expectedAttributes)
      .sort(([left], [right]) => left.localeCompare(right))
    const expressionAttributeNames = Object.fromEntries(
      entries.map(([attribute], index) => [`#authorization${index}`, attribute]),
    )
    const expressionAttributeValues = Object.fromEntries(
      entries.map(([, value], index) => [`:authorization${index}`, value]),
    )
    const expectedExpression = entries
      .map((_, index) => `#authorization${index} = :authorization${index}`)
      .join(' AND ')
    const missingKeyAttribute = Object.keys(guard.key).sort()[0]
    if (guard.allowMissingWhenExpectedZero && missingKeyAttribute) {
      expressionAttributeNames['#authorizationKey'] = missingKeyAttribute
    }
    return {
      ConditionCheck: {
        TableName: guard.tableName,
        Key: { ...guard.key },
        ConditionExpression: guard.allowMissingWhenExpectedZero
          ? `(attribute_not_exists(#authorizationKey) OR (${expectedExpression}))`
          : expectedExpression,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
      },
    }
  })
}

/**
 * Creates physical authorization checks from an application-level snapshot.
 *
 * @param snapshot - Authorization generations observed by the application layer.
 * @returns DynamoDB condition checks for the canonical mutation transaction.
 */
function createAuthorizationSnapshotConditionChecks(
  snapshot: WorkItemAuthorizationSnapshot | undefined,
): NonNullable<TransactWriteCommandInput['TransactItems']> {
  return createAuthorizationSnapshotConditionEntries(snapshot)
    .map((entry) => entry.transactWriteItem)
}

/**
 * Creates the app-owned Planning META fence used by Automation schedule updates.
 *
 * @param workspaceId - Workspace whose Planning state was checked.
 * @param fence - Exact Planning revision observed before the mutation.
 * @returns A single Planning META condition check, or no check when absent.
 */
function createPlanningRevisionFenceConditionEntries(
  workspaceId: string,
  fence: UpdateTeamIssueRequestBody['planningRevisionFence'],
): WorkItemAuthorizationConditionEntry[] {
  if (!fence) return []
  if (!Number.isSafeInteger(fence.expectedRevision) || fence.expectedRevision < 0) {
    throw new ProjectDataError(
      500,
      'InvalidWorkItemAuthorizationFence',
      'Planning revision fence is invalid.',
    )
  }
  const environment = loadServerConfig().environment
  const guard: WorkItemAuthorizationGenerationGuard = {
    kind: 'planning',
    tableName: environment.PLANNING_TABLE_NAME ?? 'mukuroji-planning-local',
    key: {
      workspaceId: `FENCE#${workspaceId}`,
      recordKey: 'META',
    },
    generationAttribute: 'revision',
    expectedGeneration: fence.expectedRevision,
    requiredAttributes: {
      entryType: 'planning-meta',
      schemaVersion: PLANNING_STORAGE_SCHEMA_VERSION,
    },
    ...(fence.expectedRevision === 0
      ? { allowMissingWhenExpectedZero: true }
      : {}),
  }
  const [transactWriteItem] = createDynamoDbWorkItemAuthorizationConditionChecks([guard])
  return transactWriteItem
    ? [{ kind: guard.kind, transactWriteItem }]
    : []
}

/** One named authorization check in a canonical Work Item transaction. */
type WorkItemAuthorizationConditionEntry = {
  /** Authorization source guarded by this transaction item. */
  kind: WorkItemAuthorizationGenerationGuard['kind']
  /** DynamoDB condition check for the source-of-truth authorization row. */
  transactWriteItem: NonNullable<TransactWriteCommandInput['TransactItems']>[number]
}

/**
 * Creates named physical authorization checks from an application-level snapshot.
 *
 * @param snapshot - Authorization generations observed by the application layer.
 * @returns Ordered checks whose semantic kinds remain available for error classification.
 */
function createAuthorizationSnapshotConditionEntries(
  snapshot: WorkItemAuthorizationSnapshot | undefined,
): WorkItemAuthorizationConditionEntry[] {
  if (!snapshot) return []
  const environment = loadServerConfig().environment
  const enterpriseTableName = environment.ENTERPRISE_IDENTITY_TABLE_NAME?.trim()
  const guards: WorkItemAuthorizationGenerationGuard[] = [
    {
      kind: 'workspace-member',
      tableName:
        environment.MUKUROJI_WORKSPACE_ACCESS_TABLE ??
        environment.WORKSPACE_ACCESS_TABLE_NAME ??
        'mukuroji-workspace-access-local',
      key: {
        workspaceId: snapshot.workspaceId,
        recordKey: `MEMBER#${normalizeProjectMemberKey(snapshot.memberKey)}`,
      },
      generationAttribute: 'version',
      expectedGeneration: snapshot.workspaceMemberVersion,
      requiredAttributes: {
        entryType: 'workspace-member',
        status: 'active',
      },
    },
    {
      kind: 'planning',
      tableName: environment.PLANNING_TABLE_NAME ?? 'mukuroji-planning-local',
      key: {
        workspaceId: `FENCE#${snapshot.workspaceId}`,
        recordKey: 'META',
      },
      generationAttribute: 'revision',
      expectedGeneration: snapshot.planningRevision,
      requiredAttributes: {
        entryType: 'planning-meta',
        schemaVersion: PLANNING_STORAGE_SCHEMA_VERSION,
      },
      ...(snapshot.planningRevision === 0
        ? { allowMissingWhenExpectedZero: true }
        : {}),
    },
    ...(enterpriseTableName &&
        snapshot.enterpriseControlRevision !== undefined &&
        Number.isSafeInteger(snapshot.enterpriseControlRevision) &&
        snapshot.enterpriseControlRevision >= 0
      ? [{
          kind: 'enterprise-control',
          tableName: enterpriseTableName,
          key: {
            scopeKey: `WORKSPACE#${snapshot.workspaceId}`,
            recordKey: 'CONTROL',
          },
          generationAttribute: 'controlRevision',
          expectedGeneration: snapshot.enterpriseControlRevision,
          requiredAttributes: {
            entryType: 'enterprise-identity-control',
          },
          ...(snapshot.enterpriseControlRevision === 0
            ? { allowMissingWhenExpectedZero: true }
            : {}),
        } satisfies WorkItemAuthorizationGenerationGuard]
      : []),
  ]
  const transactWriteItems = createDynamoDbWorkItemAuthorizationConditionChecks(guards)
  return guards.flatMap((guard, index) => {
    const transactWriteItem = transactWriteItems[index]
    return transactWriteItem
      ? [{ kind: guard.kind, transactWriteItem }]
      : []
  })
}

/**
 * Names caller-provided authorization checks so transaction failures remain classifiable.
 *
 * @param checks - Existing authorization checks supplied by a trusted application caller.
 * @returns Named authorization entries preserving their transaction order.
 */
function createCallerAuthorizationConditionEntries(
  checks: NonNullable<TransactWriteCommandInput['TransactItems']> | undefined,
): WorkItemAuthorizationConditionEntry[] {
  return (checks ?? []).map((transactWriteItem) => ({
    kind: 'workspace-member',
    transactWriteItem,
  }))
}

/**
 * Raises a stable domain error for a failed named authorization transaction check.
 *
 * @param error - DynamoDB transaction failure candidate.
 * @param startIndex - Index of the first authorization check in the transaction.
 * @param entries - Ordered named authorization checks included in the transaction.
 */
function throwAuthorizationConditionFailureIfPresent(
  error: unknown,
  startIndex: number,
  entries: readonly WorkItemAuthorizationConditionEntry[],
): void {
  const failureKinds = new Set(entries.flatMap((entry, index) =>
    isTransactionConditionalFailureAt(error, startIndex + index)
      ? [entry.kind]
      : []
  ))
  if (
    failureKinds.has('workspace-member') ||
    failureKinds.has('enterprise-control')
  ) {
    throw createWorkItemAuthorizationChangedError()
  }
  if (failureKinds.has('planning')) {
    throw new ProjectDataError(
      409,
      'PlanningRevisionConflict',
      'Planning changed. Reload and try again.',
    )
  }
}

/**
 * チーム所有 Issue の活動種別です。
 */
type TeamIssueActivityType =
  | 'created'
  | 'updated'
  | 'commented'
  | 'triage-context-merged'

/**
 * DynamoDB に保存する team issue item です。
 */
type TeamIssueItem = {
  /**
   * canonical Work Item contract の schema version です。
   */
  schemaVersion: typeof WORK_ITEM_SCHEMA_VERSION
  /**
   * optimistic concurrency に使う単調増加 revision です。
   */
  revision: number
  /**
   * Workflow / custom-field 拡張値の schema version です。
   */
  workflowSchemaVersion: typeof WORK_ITEM_CONFIGURATION_SCHEMA_VERSION
  /**
   * ユーザーごとの directory partition key です。
   */
  directoryId: string
  /**
   * Issue 一覧 query に使う directory/team 複合 partition key です。
   */
  directoryTeamId: string
  /**
   * アサイン先 project 一覧 query に使う directory/project 複合 key です。
   */
  directoryProjectId?: string
  /**
   * Issue 所有元チーム ID です。
   */
  teamId: string
  /**
   * 遂行先 project ID です。未アサイン Issue では未設定です。
   */
  assignedProjectId?: string
  /**
   * チーム内の Issue ID です。
   */
  issueId: string
  /**
   * 冪等作成時に payload 一致を検証する digest です。
   */
  importRequestDigest?: string
  /**
   * チーム内の表示順です。
   */
  sortOrder: number
  /**
   * Issue タイトルです。
   */
  title: string
  /**
   * Issue 詳細説明です。
   */
  description?: string
  /**
   * Cognito user を参照する担当者 ID です。
   */
  assigneeUserId: string
  /**
   * Issue 作成者の Workspace member key です。
   */
  creatorMemberKey: string
  /** Request intake から作成された場合の source submission ID です。 */
  sourceRequestId?: string
  /** Team Triage から作成された場合の source Entry ID です。 */
  sourceTriageEntryId?: string
  /** Relation Graph から同期する search/backfill 用の派生 relation ID 一覧です。 */
  relationIds: string[]
  /**
   * 設定済み workflow 内の status ID です。
   */
  workflowStatusId: string
  /**
   * 横断集計に使う workflow status category です。
   */
  statusCategory: WorkflowStatusCategory
  /**
   * Custom field ID ごとの型付き値です。
   */
  customFieldValues: Record<string, CustomFieldValue>
  /**
   * 期限日として表示する文字列です。
   */
  dueDate: string
  /** Canonical schedule shared by every Work Item planning surface. */
  schedule: WorkItemSchedule
  /**
   * 優先度です。
   */
  priority: WorkItemPriority
  /** Priority value の直近変更時刻です。 */
  priorityUpdatedAt?: string
  /** Derived due date の直近変更時刻です。 */
  dueDateUpdatedAt?: string
  /**
   * 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
  /**
   * 更新日時の ISO 8601 timestamp です。
   */
  updatedAt: string
  /** Reversible archive を適用した ISO 8601 timestamp です。 */
  archivedAt?: string
  /** Archive mutation を実行した Workspace member key です。 */
  archivedBy?: string
}

/**
 * DynamoDB に保存する team issue event item です。
 */
type TeamIssueEventItem = {
  /**
   * Issue event 一覧 query に使う directory/team/issue 複合 partition key です。
   */
  directoryTeamIssueId: string
  /**
   * event ID です。
   */
  eventId: string
  /**
   * ユーザーごとの directory partition key です。
   */
  directoryId: string
  /**
   * Issue 所有元チーム ID です。
   */
  teamId: string
  /**
   * チーム内の Issue ID です。
   */
  issueId: string
  /**
   * event 種別です。
   */
  eventType: TeamIssueActivityType
  /**
   * event を起こした actor user key です。
   */
  actorUserId: string
  /**
   * コメント本文です。comment event のみ設定します。
   */
  body?: string
  /** Permission-safe source provenance retained by a duplicate Triage merge event. */
  triageContextSnapshot?: WorkItemTriageContextSnapshot
  /**
   * 活動履歴に表示する概要です。
   */
  summary: string
  /**
   * 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
  /** Canonical UTC timestamp plus event ID used by the bounded comment index. */
  commentCreatedAtOrder?: string
}

/**
 * チーム Issue 一覧と詳細で表示する Issue 行です。
 */
export type TeamIssueResponseItem = CanonicalWorkItem & {
  /**
   * チーム内の Issue ID です。
   */
  id: string
  /**
   * Issue 所有元チーム ID です。
   */
  teamId: string
  /**
   * 遂行先 project ID です。未アサイン Issue では未設定です。
   */
  assignedProjectId?: string
  /**
   * Issue 作成者の Workspace member key です。
   */
  creatorMemberKey: string
}

/** Work Item 一覧 client の読み込み量を制御します。 */
export type WorkItemListReadOptions = {
  /** DynamoDB から読み込む最大 item 数です。 */
  limit?: number
  /** Base table から強整合 read するかどうかです。 */
  consistentRead?: boolean
  /** Archive 済み Work Item を内部管理 read に含めます。 */
  includeArchived?: boolean
}

/** Public Work Item の DynamoDB-backed bounded page read options です。 */
export type PublicWorkItemPageReadOptions = {
  /** DynamoDB が一度の Query で評価する最大 item 数です。 */
  limit: number
  /** 前 page の LastEvaluatedKey を表す opaque cursor です。 */
  cursor?: string
  /** 指定 Project に割り当てられた Work Item だけを返します。 */
  assignedProjectId?: string
  /** 指定 assignee の Work Item だけを返します。 */
  assigneeUserId?: string
  /** 指定 workflow status の Work Item だけを返します。 */
  workflowStatusId?: string
  /** この timestamp より新しく更新された Work Item だけを返します。 */
  updatedAfter?: string
  /** Current RBAC で参照できる assigned Project IDs です。 */
  accessibleProjectIds?: readonly string[]
}

/** TeamIssueUpdatedAtIndex の page cursor payload です。 */
type PublicWorkItemPageCursor = {
  /** Cursor schema version です。 */
  version: 1
  /** Cursor を束縛する Team partition key です。 */
  directoryTeamId: string
  /** GSI sort key の更新 timestamp です。 */
  updatedAt: string
  /** Base table sort key の Work Item ID です。 */
  issueId: string
}

/**
 * チーム Issue 活動履歴レスポンスです。
 */
type TeamIssueActivityResponseItem = {
  /**
   * 活動履歴 ID です。
   */
  id: string
  /**
   * 活動種別です。
   */
  type: TeamIssueActivityType
  /**
   * actor user key です。
   */
  actorUserId: string
  /**
   * 活動概要です。
   */
  summary: string
  /**
   * 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
}

/**
 * チーム Issue 一覧 API が返す response body です。
 */
export type TeamIssuesResponse = {
  /**
   * 取得対象の team ID です。
   */
  teamId: string
  /**
   * チームに紐づく Issue 一覧です。
   */
  issues: TeamIssueResponseItem[]
}

/**
 * プロジェクトにアサインされた Issue 一覧 API が返す response body です。
 */
export type ProjectIssuesResponse = {
  /**
   * 取得対象の project ID です。
   */
  projectId: string
  /**
   * プロジェクトにアサインされた Issue 一覧です。
   */
  issues: TeamIssueResponseItem[]
}

/**
 * チーム Issue 詳細 API が返す response body です。
 */
export type TeamIssueDetailResponse = {
  /**
   * Issue 本体です。
   */
  issue: TeamIssueResponseItem
  /**
   * Canonical Collaboration comments projected into the stable detail shape,
   * or legacy comments loaded for a marker-gated migration fallback.
   */
  comments?: TeamIssueCommentResponseItem[]
  /**
   * Issue 活動履歴一覧です。
   */
  activity: TeamIssueActivityResponseItem[]
  /** De-identified duplicate-source context committed with this canonical Work Item. */
  triageContextSnapshots?: WorkItemTriageContextSnapshot[]
  /** Bounded legacy event read の次 page を指す opaque cursor です。 */
  nextEventCursor?: string
  /** Work Item に適用される解決済み workflow/custom field 定義です。 */
  resolvedConfiguration?: ResolvedWorkItemConfiguration
  /** Work Item から見た reciprocal relation 一覧です。 */
  relations?: WorkItemRelation[]
  /** Relation mutation の optimistic concurrency に使う graph revision です。 */
  relationGraphRevision?: number
}

/**
 * チーム Issue 作成 API が受け取る request body です。
 */
export type CreateTeamIssueRequestBody = {
  /** Internal automation create action が再配送間で固定する resource ID です。 */
  idempotencyResourceId?: unknown
  /**
   * Issue タイトルです。
   */
  title?: unknown
  /**
   * Issue 詳細説明です。
   */
  description?: unknown
  /**
   * 遂行先 project ID です。空文字または null で未アサインです。
   */
  assignedProjectId?: unknown
  /**
   * Cognito user を参照する担当者 ID です。
   */
  assigneeUserId?: unknown
  /** Explicit canonical schedule required for every new Work Item. */
  schedule: unknown
  /**
   * 優先度です。
   */
  priority?: unknown
  /**
   * 設定済み workflow 内の status ID です。
   */
  workflowStatusId?: unknown
  /**
   * Custom field ID ごとの型付き値です。
   */
  customFieldValues?: unknown
  /** Quick capture では required custom field の入力を後回しにします。 */
  quickCapture?: unknown
  /** API handler が検証後に付与する workflow extension schema version です。 */
  workflowSchemaVersion?: unknown
  /** API handler が検証後に付与する workflow status category です。 */
  statusCategory?: unknown
  /** API handler が definition の同時変更を検出するために付与する ConditionCheck です。 */
  configurationConditionChecks?: NonNullable<TransactWriteCommandInput['TransactItems']>
  /** API handler が認可 snapshot の同時変更を検出するために付与する ConditionCheck です。 */
  authorizationConditionChecks?: NonNullable<TransactWriteCommandInput['TransactItems']>
  /** Application layer が認可時に読み込んだ source-of-truth generations です。 */
  authorizationSnapshot?: WorkItemAuthorizationSnapshot
  /** Import worker または public API の冪等作成で固定する Work Item ID です。 */
  idempotentIssueId?: string
  /** 既存 row と同一 request か検証する SHA-256 digest です。 */
  idempotentRequestDigest?: string
}

/** Creates a revision fence for an existing canonical Work Item reference.
 *
 * @param tableName - Canonical Work Item table name.
 * @param directoryId - Owning Workspace directory identifier.
 * @param teamId - Work Item Team identifier.
 * @param workItemId - Canonical Work Item identifier.
 * @param expectedRevision - Revision observed by the caller's strong read.
 * @returns A DynamoDB condition check composable with a larger transaction.
 */
export function createWorkItemRevisionConditionCheck(
  tableName: string,
  directoryId: string,
  teamId: string,
  workItemId: string,
  expectedRevision: number,
): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
  const normalizedTableName = readRequiredString(tableName, 'Work Item table name is required.')
  const normalizedDirectoryId = readRequiredString(directoryId, 'Workspace ID is required.')
  const normalizedTeamId = readRequiredString(teamId, 'Team ID is required.')
  const normalizedWorkItemId = readRequiredString(workItemId, 'Work Item ID is required.')
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new ProjectDataError(
      400,
      'InvalidProjectWrite',
      'Work Item revision is invalid.',
    )
  }
  return {
    ConditionCheck: {
      TableName: normalizedTableName,
      Key: {
        directoryTeamId: createDirectoryTeamId(normalizedDirectoryId, normalizedTeamId),
        issueId: normalizedWorkItemId,
      },
      ConditionExpression: 'revision = :expectedRevision',
      ExpressionAttributeValues: { ':expectedRevision': expectedRevision },
    },
  }
}

/** Trusted request conversion handler が Work Item transactionへ追加する narrow projection です。 */
export type RequestConversionTransactionInput = {
  /** Request intake table 名です。 */
  tableName: string
  /** Submission の Workspace partition key です。 */
  scopeKey: string
  /** Submission row sort key です。 */
  recordKey: string
  /** 読み込み時点の submission revision です。 */
  expectedRevision: number
  /** Conversion event の actor member ID です。 */
  actorId: string
  /** Work Item に保存する source submission ID です。 */
  submissionId: string
  /** Mutation 前に読み込んだ append-only event 履歴です。 */
  events: readonly RequestSubmissionEvent[]
}

/** Triage compositionが Work Item 作成 transaction へ追加する受入更新です。 */
export type TriageAcceptanceTransactionInput = {
  /** Work Item から追跡する source Triage Entry ID です。 */
  entryId: string
  /** Triage Entry、Work Item、audit で共有する canonical mutation instant です。 */
  occurredAt: string
  /** Revision guard、association、event、receipt を含む transaction item です。 */
  transactItems: NonNullable<TransactWriteCommandInput['TransactItems']>
}

/** Input used to prepare canonical Work Item provenance for a duplicate Triage merge. */
export type CreateTriageDuplicateContextTransactionItemsInput = {
  /** Owning Workspace directory identifier. */
  directoryId: string
  /** Team that owns the canonical Work Item. */
  teamId: string
  /** Canonical Work Item receiving the duplicate context. */
  workItemId: string
  /** Strongly read Work Item revision guarded by the combined transaction. */
  expectedWorkItemRevision: number
  /** Workspace member performing the duplicate merge. */
  actorUserId: string
  /** Strongly read Triage Entry supplying permission and retained metadata. */
  entry: TriageEntry
  /** Canonical ISO 8601 instant shared with the Triage mutation. */
  mergedAt: string
}

/** Prepared Work Item provenance and unexecuted transaction actions. */
export type TriageDuplicateContextTransactionContribution = {
  /** De-identified context snapshot written to the Work Item event partition. */
  snapshot: WorkItemTriageContextSnapshot
  /** Work Item revision guard and immutable context event Put. */
  transactItems: NonNullable<TransactWriteCommandInput['TransactItems']>
}

/**
 * 公開チーム Issue 更新 API が受け取る request body です。
 */
export type PublicUpdateTeamIssueRequestBody = {
  /**
   * optimistic concurrency に使う読み込み時点の revision です。
   */
  expectedRevision?: unknown
  /**
   * Issue タイトルです。
   */
  title?: unknown
  /**
   * Issue 詳細説明です。
   */
  description?: unknown
  /**
   * 遂行先 project ID です。空文字または null で未アサインへ戻します。
   */
  assignedProjectId?: unknown
  /**
   * Cognito user を参照する担当者 ID です。
   */
  assigneeUserId?: unknown
  /** Complete replacement schedule shared by every task view. */
  schedule?: unknown
  /**
   * 優先度です。
   */
  priority?: unknown
  /**
   * 設定済み workflow 内の status ID です。
   */
  workflowStatusId?: unknown
  /**
   * Custom field ID ごとの型付き値です。null は保存済み値の削除を表します。
   */
  customFieldValues?: unknown
}

/**
 * 検証済みの設定値と内部 adapter 専用フィールドを含むチーム Issue 更新入力です。
 */
export type UpdateTeamIssueRequestBody = PublicUpdateTeamIssueRequestBody & {
  /** API handler が検証後に付与する workflow extension schema version です。 */
  workflowSchemaVersion?: unknown
  /** API handler が検証後に付与する workflow status category です。 */
  statusCategory?: unknown
  /** API handler が definition の同時変更を検出するために付与する ConditionCheck です。 */
  configurationConditionChecks?: NonNullable<TransactWriteCommandInput['TransactItems']>
  /** API handler が認可 snapshot の同時変更を検出するために付与する ConditionCheck です。 */
  authorizationConditionChecks?: NonNullable<TransactWriteCommandInput['TransactItems']>
  /** Application layer が認可時に読み込んだ source-of-truth generations です。 */
  authorizationSnapshot?: WorkItemAuthorizationSnapshot
  /** App-owned Automation が schedule 検証時に読み込んだ Planning META revision です。 */
  planningRevisionFence?: {
    /** Mutation transaction が一致を要求する Planning revision です。 */
    expectedRevision: number
  }
  /** Internal bulk operation が設定または解除する archive timestamp です。 */
  archivedAt?: unknown
  /** Internal bulk operation が記録する archive actor member key です。 */
  archivedBy?: unknown
}

/**
 * チーム Issue コメント作成 API が受け取る request body です。
 */
export type CreateTeamIssueCommentRequestBody = {
  /**
   * Markdown source として保存するコメント本文です。
   */
  bodyMarkdown?: unknown
  /**
   * 旧クライアントが送信するコメント本文です。保存時は canonical bodyMarkdown へ変換します。
   */
  body?: unknown
  /**
   * reply 先の comment ID です。
   */
  parentCommentId?: unknown
  /**
   * Composer が解決した安定した Workspace member key です。
   */
  mentionMemberKeys?: unknown
}

/**
 * チーム Issue 作成 API が返す response body です。
 */
export type CreateTeamIssueResponse = {
  /**
   * 作成した Issue 行です。
   */
  issue: TeamIssueResponseItem
}

/**
 * チーム Issue 更新 API が返す response body です。
 */
export type UpdateTeamIssueResponse = {
  /**
   * 更新した Issue 行です。
   */
  issue: TeamIssueResponseItem
}

/** One revision-bound schedule write in an atomic dependency cascade. */
export type WorkItemScheduleCascadeUpdate = {
  /** Team that owns the affected Work Item. */
  teamId: string
  /** Team-local Work Item identifier. */
  workItemId: string
  /** Revision observed while recomputing the confirmed preview. */
  expectedRevision: number
  /** Complete canonical replacement schedule. */
  schedule: WorkItemSchedule
}

/** One non-mutated Work Item revision that contributed to cascade recomputation. */
export type WorkItemScheduleCascadeGuard = {
  /** Team that owns the guarded Work Item. */
  teamId: string
  /** Team-local Work Item identifier. */
  workItemId: string
  /** Revision used by dependency schedule arithmetic. */
  expectedRevision: number
}

/** Result of atomically persisting a Work Item schedule cascade. */
export type WorkItemScheduleCascadeResponse = {
  /** Updated canonical Work Items in the requested deterministic order. */
  issues: TeamIssueResponseItem[]
  /** Compact schedule results safe to persist in the atomic replay receipt. */
  confirmedSchedules: ConfirmedWorkItemSchedule[]
}

/**
 * チーム Issue コメント作成 API が返す response body です。
 */
export type CreateTeamIssueCommentResponse = {
  /**
   * 作成したコメントです。
   */
  comment: TeamIssueCommentResponseItem
  /**
   * コメント追加に対応する活動履歴です。
   */
  activity: TeamIssueActivityResponseItem
}

/** Work Item domain write と public response receipt を同じ transaction に追加する境界です。 */
export type WorkItemIdempotencyTransaction = {
  /** Exact HTTP response を encrypted receipt transaction item に変換します。 */
  prepare(
    response: { /** HTTP status です。 */ status: 200 | 204; /** Replay body です。 */ body: unknown },
  ): Promise<IdempotencyCompletionTransactWrite | undefined>
}

/** Canonical Work Item delete transaction に含める参照整合性 fence の種別です。 */
type WorkItemDeletionFenceKind = 'external-links' | 'document-backlinks'

/** Cancellation reason を安定した domain conflict に分類する名前付き fence です。 */
export type NamedWorkItemDeletionFence = {
  /** Fence が保護する参照種別です。 */
  kind: WorkItemDeletionFenceKind
  /** Canonical delete と同じ DynamoDB transaction に追加する write です。 */
  transactWriteItem: NonNullable<TransactWriteCommandInput['TransactItems']>[number]
}

/**
 * API handler から利用する team issue client の最小 interface です。
 */
export type TeamIssuesClient = {
  /** Prepares de-identified duplicate-source context for an atomic Triage merge.
   *
   * @param input - Strongly read Work Item and permission-safe Triage context.
   * @returns The snapshot and unexecuted Work Item transaction actions.
   */
  createTriageDuplicateContextTransactionItems?(
    input: CreateTriageDuplicateContextTransactionItemsInput,
  ): TriageDuplicateContextTransactionContribution
  /**
   * DynamoDB から指定 team ID の Issue 一覧を取得します。
   */
  getTeamIssues(
    directoryId: string,
    teamId: string,
    options?: WorkItemListReadOptions,
  ): Promise<TeamIssuesResponse>
  /** Public API 用の bounded canonical Work Item page を取得します。 */
  getPublicWorkItemPage(
    directoryId: string,
    teamId: string,
    options: PublicWorkItemPageReadOptions,
  ): Promise<{
    /** Current page の canonical Work Items です。 */
    issues: TeamIssueResponseItem[]
    /** 次 page の opaque cursor です。 */
    nextCursor?: string
  }>
  /**
   * DynamoDB から指定 project ID にアサインされた Issue 一覧を取得します。
   */
  getProjectIssues(
    directoryId: string,
    projectId: string,
    options?: WorkItemListReadOptions,
  ): Promise<ProjectIssuesResponse>
  /**
   * DynamoDB から Issue 詳細、コメント、活動履歴を取得します。
   */
  getTeamIssueDetail(
    directoryId: string,
    teamId: string,
    issueId: string,
    options?: TeamIssueDetailReadOptions,
  ): Promise<TeamIssueDetailResponse>
  /**
   * Reads a pre-cutover Automation comment by its deterministic legacy action identity.
   *
   * @param directoryId - Workspace directory identifier.
   * @param teamId - Owning Team identifier.
   * @param issueId - Team-local Work Item identifier.
   * @param eventId - Deterministic comment action event identifier.
   * @param actorUserId - Expected Automation actor identifier.
   * @param body - Expected comment body.
   * @returns Whether a matching pre-cutover comment event already exists.
   */
  getAutomationCommentReplay?(
    directoryId: string,
    teamId: string,
    issueId: string,
    eventId: string,
    actorUserId: string,
    body: string,
  ): Promise<boolean>
  /**
   * DynamoDB に team issue を作成します。
   */
  createTeamIssue(
    directoryId: string,
    teamId: string,
    input: CreateTeamIssueRequestBody,
    actorUserId: string,
    auditContext?: MutationAuditContext,
    requestConversion?: RequestConversionTransactionInput,
    triageAcceptance?: TriageAcceptanceTransactionInput,
  ): Promise<CreateTeamIssueResponse>
  /**
   * DynamoDB の team issue を更新します。
   */
  updateTeamIssue(
    directoryId: string,
    teamId: string,
    issueId: string,
    input: UpdateTeamIssueRequestBody,
    actorUserId: string,
    auditContext?: MutationAuditContext,
    idempotency?: WorkItemIdempotencyTransaction,
  ): Promise<UpdateTeamIssueResponse>
  /**
   * Atomically updates every revision-bound Work Item schedule in one dependency cascade.
   */
  updateTeamIssueSchedules?(
    directoryId: string,
    updates: readonly WorkItemScheduleCascadeUpdate[],
    guardedRevisions: readonly WorkItemScheduleCascadeGuard[],
    actorUserId: string,
    auditContext?: MutationAuditContext,
    relationGraphConditionChecks?: NonNullable<TransactWriteCommandInput['TransactItems']>,
    authorizationSnapshot?: WorkItemAuthorizationSnapshot,
    idempotency?: WorkItemIdempotencyTransaction,
  ): Promise<WorkItemScheduleCascadeResponse>
  /**
   * DynamoDB の canonical Work Item を revision 条件付きで削除します。
   */
  deleteTeamIssue?(
    directoryId: string,
    teamId: string,
    issueId: string,
    expectedRevision: number,
    actorUserId: string,
    auditContext?: MutationAuditContext,
    idempotency?: WorkItemIdempotencyTransaction,
    deletionFences?: readonly NamedWorkItemDeletionFence[],
    authorizationConditionChecks?: NonNullable<TransactWriteCommandInput['TransactItems']>,
    authorizationSnapshot?: WorkItemAuthorizationSnapshot,
  ): Promise<{ issue: TeamIssueResponseItem }>
}

/** Team Issue detail の event 読み込み量と順序を制御します。 */
export type TeamIssueDetailReadOptions = {
  /** Issue 本体を strongly consistent read で認可へ使う場合は true です。 */
  consistentIssueRead?: boolean
  /** Whether to materialize comment events in addition to the complete activity page. */
  includeComments?: boolean
  /** 読み込む event の最大件数です。0 の場合は event partition を読みません。 */
  eventLimit?: number
  /** 移行未完了の環境で新しい event から読み込む場合は true です。 */
  newestEventsFirst?: boolean
  /** 移行未完了の環境で指定 event 種別だけを返す DynamoDB filter です。 */
  eventType?: TeamIssueActivityType
  /** 移行未完了の環境で前 page が返した event cursor です。 */
  eventCursor?: string
  /** Reads the pre-migration comment index without relying on the staged canonical index. */
  legacyCommentIndexOnly?: boolean
}

/** Team Issue event page cursor の署名対象 payload です。 */
type TeamIssueEventCursor =
  | {
      /** Cursor schema version です。 */
      version: 1
      /** Cursor を別 Issue へ流用できないよう束縛する partition key です。 */
      directoryTeamIssueId: string
      /** DynamoDB event sort key です。 */
      eventId: string
    }
  | {
      /** Cursor schema version です。 */
      version: 2
      /** Cursor が使用する DynamoDB index です。 */
      index: 'createdAt'
      /** Cursor を別 Issue へ流用できないよう束縛する partition key です。 */
      directoryTeamIssueId: string
      /** DynamoDB base-table event sort key です。 */
      eventId: string
      /** Event timestamp retained as the raw sparse-index continuation key. */
      createdAt: string
    }
  | {
      /** Cursor schema version. */
      version: 3
      /** Cursor が使用する DynamoDB index です。 */
      index: 'commentCreatedAt'
      /** Cursor を別 Issue へ流用できないよう束縛する partition key です。 */
      directoryTeamIssueId: string
      /** DynamoDB event sort key です。 */
      eventId: string
      /** Canonical timestamp-and-ID index sort key. */
      commentCreatedAtOrder: string
    }

function createRequestConversionTransactionItems(
  input: RequestConversionTransactionInput,
  teamId: string,
  workItemId: string,
  projectId: string | undefined,
  now: string,
): NonNullable<TransactWriteCommandInput['TransactItems']> {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new ProjectDataError(
      400,
      'InvalidProjectWrite',
      'Request conversion revision is invalid.',
    )
  }
  const workItem = {
    teamId,
    workItemId,
    ...(projectId ? { projectId } : {}),
  }
  const event = {
    id: `event_${now.replace(/[-:.TZ]/gu, '')}_${workItemId}`,
    type: 'converted',
    actorId: input.actorId,
    summary: 'Request was converted to a Work Item.',
    createdAt: now,
  } satisfies RequestSubmissionEvent
  return [
    {
      Update: {
        TableName: input.tableName,
        Key: { scopeKey: input.scopeKey, recordKey: input.recordKey },
        UpdateExpression:
          'SET #status = :converted, #revision = :nextRevision, workItem = :workItem, updatedAt = :updatedAt, capabilities = :capabilities, events = :events',
        ConditionExpression:
          '#revision = :expectedRevision AND (#status = :received OR #status = :triaging OR #status = :needsMoreInfo)',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#revision': 'revision',
        },
        ExpressionAttributeValues: {
          ':converted': 'converted',
          ':nextRevision': input.expectedRevision + 1,
          ':workItem': workItem,
          ':updatedAt': now,
          ':capabilities': {
            canAssign: false,
            canRequestMoreInfo: false,
            canReject: false,
            canMarkDuplicate: false,
            canConvert: false,
          },
          ':events': createRequestSubmissionEventProjection(input.events, event),
          ':expectedRevision': input.expectedRevision,
          ':received': 'received',
          ':triaging': 'triaging',
          ':needsMoreInfo': 'needs-more-info',
        },
      },
    },
    createRequestConversionEventTransactionPut(input, event),
  ]
}

/**
 * Creates the immutable Request Intake event row owned by a conversion transaction.
 *
 * @param input - Request submission storage identity already validated by Request Intake.
 * @param event - Canonical conversion event written with the Work Item mutation.
 * @returns A DynamoDB transaction item that inserts the immutable event once.
 */
function createRequestConversionEventTransactionPut(
  input: RequestConversionTransactionInput,
  event: RequestSubmissionEvent,
): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
  return {
    Put: {
      TableName: input.tableName,
      Item: {
        entryType: 'submission-event',
        scopeKey: input.scopeKey,
        recordKey:
          `SUBMISSION_EVENT#${input.submissionId}#${event.createdAt}#${event.id}`,
        submissionId: input.submissionId,
        ...event,
      },
      ConditionExpression:
        'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)',
    },
  }
}

async function ensureConfiguredAuditTable(
  tableName: string | undefined,
  dynamoDbClient: DynamoDBClient,
  bootstrapLocalTables: boolean,
) {
  if (tableName && bootstrapLocalTables) {
    await ensureLocalAuditEventsTable(tableName, dynamoDbClient)
  }
}

function normalizeWorkItemListReadLimit(value: number | undefined) {
  if (value === undefined) {
    return undefined
  }

  return Math.max(0, Math.floor(value))
}

function normalizePublicWorkItemPageLimit(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > PUBLIC_API_MAX_PAGE_SIZE) {
    throw new ProjectDataError(
      400,
      'InvalidWorkItemPageLimit',
      `Work Item page limit must be between 1 and ${PUBLIC_API_MAX_PAGE_SIZE}.`,
    )
  }
  return value
}

/**
 * DynamoDB の team issue item と event item を読み書きする client です。
 */
export class DynamoDbTeamIssuesClient {
  /**
   * team issue item を保存する DynamoDB table 名です。
   */
  private readonly issueTableName: string
  /**
   * team issue event item を保存する DynamoDB table 名です。
   */
  private readonly eventTableName: string
  /**
   * DynamoDB DocumentClient です。
   */
  private readonly documentClient: DynamoDBDocumentClient
  /**
   * table 初期化に使う低レベル DynamoDB client です。
   */
  private readonly dynamoDbClient: DynamoDBClient
  /**
   * ローカル DynamoDB の table 欠落を自動復旧するかどうかです。
   */
  private readonly bootstrapLocalTables: boolean
  /**
   * immutable audit event を保存する DynamoDB table 名です。
   */
  private readonly auditTableName?: string
  /** Planning table whose META revision fences canonical Work Item roll-ups. */
  private readonly planningTableName?: string
  constructor(
    issueTableName =
      getEnv('MUKUROJI_WORK_ITEMS_TABLE') ??
      getEnv('WORK_ITEMS_TABLE_NAME') ??
      getEnv('MUKUROJI_TEAM_ISSUES_TABLE') ??
      getEnv('TEAM_ISSUES_TABLE_NAME') ??
      'mukuroji-team-issues-local',
    eventTableName =
      getEnv('MUKUROJI_TEAM_ISSUE_EVENTS_TABLE') ??
      getEnv('TEAM_ISSUE_EVENTS_TABLE_NAME') ??
      'mukuroji-team-issue-events-local',
    documentClient = createDynamoDbDocumentClient(),
    dynamoDbClient?: DynamoDBClient,
    bootstrapLocalTables = dynamoDbClient === undefined && shouldBootstrapLocalDynamoDb(),
    auditTableName = getConfiguredAuditTableName(),
    planningTableName = getEnv('PLANNING_TABLE_NAME'),
  ) {
    this.issueTableName = issueTableName
    this.eventTableName = eventTableName
    this.documentClient = documentClient
    this.dynamoDbClient = dynamoDbClient ?? createDynamoDbClient()
    this.bootstrapLocalTables = bootstrapLocalTables
    this.auditTableName = auditTableName
    this.planningTableName = planningTableName?.trim() || undefined
  }

  /**
   * Prepares permission-safe duplicate-source provenance for a combined Triage transaction.
   *
   * The immutable event lives in the canonical Work Item event partition and deliberately omits
   * source bodies, requester identity, provider IDs, attachment names, and watcher identities.
   * A revision guard prevents the provenance from being attached to a stale or replaced target.
   *
   * @param input - Strongly read Work Item and Triage source context.
   * @returns The retained snapshot and unexecuted Work Item transaction actions.
   */
  createTriageDuplicateContextTransactionItems(
    input: CreateTriageDuplicateContextTransactionItemsInput,
  ): TriageDuplicateContextTransactionContribution {
    const directoryId = readRequiredString(
      input.directoryId,
      'Triage context Workspace ID is required.',
    )
    const teamId = readRequiredString(
      input.teamId,
      'Triage context Team ID is required.',
    )
    const workItemId = readRequiredString(
      input.workItemId,
      'Triage context Work Item ID is required.',
    )
    const actorUserId = readRequiredString(
      input.actorUserId,
      'Triage context actor ID is required.',
    )
    const mergedAt = readTriageAcceptanceInstant(input.mergedAt)
    if (
      !Number.isSafeInteger(input.expectedWorkItemRevision) ||
      input.expectedWorkItemRevision < 1
    ) {
      throw new ProjectDataError(
        400,
        'InvalidProjectWrite',
        'Triage context Work Item revision is invalid.',
      )
    }
    if (input.entry.workspaceId !== directoryId || input.entry.teamId !== teamId) {
      throw new ProjectDataError(
        409,
        'TriageContextScopeMismatch',
        'Triage context does not belong to the canonical Work Item scope.',
      )
    }
    const snapshot = createPermissionSafeTriageContextSnapshot(input.entry, mergedAt)
    const eventItem = this.createIssueEventItem({
      directoryId,
      teamId,
      issueId: workItemId,
      eventId: `${mergedAt}#triage-context-merged#${snapshot.triageEntryId}`,
      eventType: 'triage-context-merged',
      actorUserId,
      summary: 'Duplicate Team Triage context was retained.',
      triageContextSnapshot: snapshot,
      createdAt: mergedAt,
    })

    return {
      snapshot,
      transactItems: [
        {
          ConditionCheck: {
            TableName: this.issueTableName,
            Key: {
              directoryTeamId: createDirectoryTeamId(directoryId, teamId),
              issueId: workItemId,
            },
            ConditionExpression: 'revision = :expectedRevision',
            ExpressionAttributeValues: {
              ':expectedRevision': input.expectedWorkItemRevision,
            },
          },
        },
        {
          Put: {
            TableName: this.eventTableName,
            Item: eventItem,
            ConditionExpression:
              'attribute_not_exists(directoryTeamIssueId) AND attribute_not_exists(eventId)',
          },
        },
      ],
    }
  }

  /**
   * DynamoDB から指定 team ID の Issue 一覧を取得します。
   */
  async getTeamIssues(
    directoryId: string,
    teamId: string,
    options: WorkItemListReadOptions = {},
  ) {
    await this.ensureLocalTables()

    try {
      const items = await this.queryTeamIssueItems(directoryId, teamId, options)
      const visibleItems = options.includeArchived
        ? items
        : items.filter((item) => item.archivedAt === undefined)

      return {
        teamId,
        issues: visibleItems.map(toTeamIssueResponseItem),
      } satisfies TeamIssuesResponse
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * UpdatedAt GSI を一度だけ Query し、Public API 用の bounded Work Item page を返します。
   */
  async getPublicWorkItemPage(
    directoryId: string,
    teamId: string,
    options: PublicWorkItemPageReadOptions,
  ) {
    await this.ensureLocalTables()
    const directoryTeamId = createDirectoryTeamId(directoryId, teamId)
    const limit = normalizePublicWorkItemPageLimit(options.limit)
    const exclusiveStartKey = decodePublicWorkItemPageCursor(
      options.cursor,
      directoryTeamId,
    )
    const expressionAttributeNames: Record<string, string> = {
      '#directoryTeamId': 'directoryTeamId',
      '#archivedAt': 'archivedAt',
    }
    const expressionAttributeValues: Record<string, unknown> = {
      ':directoryTeamId': directoryTeamId,
    }
    const filterExpressions = ['attribute_not_exists(#archivedAt)']

    if (options.assignedProjectId) {
      expressionAttributeNames['#assignedProjectId'] = 'assignedProjectId'
      expressionAttributeValues[':assignedProjectId'] = options.assignedProjectId
      filterExpressions.push('#assignedProjectId = :assignedProjectId')
    } else if (
      options.accessibleProjectIds &&
      options.accessibleProjectIds.length <= 90
    ) {
      expressionAttributeNames['#assignedProjectId'] = 'assignedProjectId'
      const accessiblePlaceholders = options.accessibleProjectIds.map((projectId, index) => {
        const placeholder = `:accessibleProject${index}`
        expressionAttributeValues[placeholder] = projectId
        return placeholder
      })
      filterExpressions.push(
        accessiblePlaceholders.length > 0
          ? `(attribute_not_exists(#assignedProjectId) OR #assignedProjectId IN (${accessiblePlaceholders.join(', ')}))`
          : 'attribute_not_exists(#assignedProjectId)',
      )
    }
    if (options.assigneeUserId) {
      expressionAttributeNames['#assigneeUserId'] = 'assigneeUserId'
      expressionAttributeValues[':assigneeUserId'] = options.assigneeUserId
      filterExpressions.push('#assigneeUserId = :assigneeUserId')
    }
    if (options.workflowStatusId) {
      expressionAttributeNames['#workflowStatusId'] = 'workflowStatusId'
      expressionAttributeValues[':workflowStatusId'] = options.workflowStatusId
      filterExpressions.push('#workflowStatusId = :workflowStatusId')
    }
    if (options.updatedAfter) {
      expressionAttributeNames['#updatedAt'] = 'updatedAt'
      expressionAttributeValues[':updatedAfter'] = options.updatedAfter
    }

    try {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.issueTableName,
        IndexName: 'TeamIssueUpdatedAtIndex',
        KeyConditionExpression: options.updatedAfter
          ? '#directoryTeamId = :directoryTeamId AND #updatedAt > :updatedAfter'
          : '#directoryTeamId = :directoryTeamId',
        FilterExpression: filterExpressions.join(' AND '),
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ExclusiveStartKey: exclusiveStartKey,
        ScanIndexForward: false,
        Limit: limit,
      }))
      const accessibleProjectIds = options.accessibleProjectIds &&
          options.accessibleProjectIds.length > 90
        ? new Set(options.accessibleProjectIds)
        : undefined
      const issues = (response.Items ?? [])
        .map(toTeamIssueItem)
        .filter((item) =>
          !accessibleProjectIds ||
          !item.assignedProjectId ||
          accessibleProjectIds.has(item.assignedProjectId)
        )
        .map(toTeamIssueResponseItem)
      return {
        issues,
        ...(response.LastEvaluatedKey
          ? {
              nextCursor: encodePublicWorkItemPageCursor(
                response.LastEvaluatedKey,
                directoryTeamId,
              ),
            }
          : {}),
      }
    } catch (error) {
      if (error instanceof ProjectDataError) throw error
      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB から指定 project ID にアサインされた Issue 一覧を取得します。
   */
  async getProjectIssues(
    directoryId: string,
    projectId: string,
    options: WorkItemListReadOptions = {},
  ) {
    await this.ensureLocalTables()

    try {
      const items = await this.queryProjectIssueItems(directoryId, projectId, options)
      const visibleItems = options.includeArchived
        ? items
        : items.filter((item) => item.archivedAt === undefined)

      return {
        projectId,
        issues: visibleItems.map(toTeamIssueResponseItem),
      } satisfies ProjectIssuesResponse
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB から Issue 詳細、コメント、活動履歴を取得します。
   */
  async getTeamIssueDetail(
    directoryId: string,
    teamId: string,
    issueId: string,
    options: TeamIssueDetailReadOptions = {},
  ) {
    await this.ensureLocalTables()

    try {
      const issue = await this.getRequiredTeamIssueItem(
        directoryId,
        teamId,
        issueId,
        options.consistentIssueRead === true,
      )
      const eventPage = options.eventLimit === 0
        ? { items: [] as TeamIssueEventItem[] }
        : await this.queryTeamIssueEventItems(directoryId, teamId, issueId, options)
      const events = eventPage.items
      const triageContextSnapshots = events
        .map((event) => event.triageContextSnapshot)
        .filter(isDefined)

      return {
        issue: toTeamIssueResponseItem(issue),
        comments: options.includeComments === false
          ? []
          : events
              .filter((event) => event.eventType === 'commented')
              .map(toTeamIssueCommentResponseItem),
        activity: events.map(toTeamIssueActivityResponseItem),
        ...(triageContextSnapshots.length > 0 ? { triageContextSnapshots } : {}),
        ...(eventPage.nextCursor ? { nextEventCursor: eventPage.nextCursor } : {}),
      } satisfies TeamIssueDetailResponse
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * Reads one pre-cutover Automation comment event for response-loss replay.
   *
   * @param directoryId - Workspace directory identifier.
   * @param teamId - Owning Team identifier.
   * @param issueId - Team-local Work Item identifier.
   * @param eventId - Deterministic comment action event identifier.
   * @param actorUserId - Expected Automation actor identifier.
   * @param body - Expected comment body.
   * @returns Whether the matching event is already durable.
   */
  async getAutomationCommentReplay(
    directoryId: string,
    teamId: string,
    issueId: string,
    eventId: string,
    actorUserId: string,
    body: string,
  ) {
    await this.ensureLocalTables()
    const normalizedEventId = readIdempotencyResourceId(eventId)
    if (!normalizedEventId) {
      throw new ProjectDataError(
        400,
        'InvalidProjectWrite',
        'Automation comment replay event ID is invalid.',
      )
    }
    try {
      const response = await this.documentClient.send(new GetCommand({
        TableName: this.eventTableName,
        Key: {
          directoryTeamIssueId: createDirectoryTeamIssueId(directoryId, teamId, issueId),
          eventId: normalizedEventId,
        },
        ConsistentRead: true,
      }))
      if (response.Item === undefined) return false

      if (!isTeamIssueEventItem(response.Item) || response.Item.eventType !== 'commented') {
        throw new ProjectDataError(
          503,
          'AutomationCommentReplayUnavailable',
          'The pre-cutover comment replay record is invalid.',
        )
      }
      if (response.Item.actorUserId !== actorUserId || response.Item.body !== body) {
        throw new ProjectDataError(
          409,
          'AutomationCommentIdempotencyConflict',
          'The Automation comment action was reused with different input.',
        )
      }

      return true
    } catch (error) {
      if (error instanceof ProjectDataError) throw error
      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB に team issue を作成します。
   */
  async createTeamIssue(
    directoryId: string,
    teamId: string,
    input: CreateTeamIssueRequestBody,
    actorUserId: string,
    auditContext?: MutationAuditContext,
    requestConversion?: RequestConversionTransactionInput,
    triageAcceptance?: TriageAcceptanceTransactionInput,
  ) {
    await this.ensureLocalTables()
    let auditPut: ReturnType<typeof createMutationAuditEventPut> = undefined

    const title = readRequiredString(input.title, 'Issue title is required.')
    const description = readOptionalString(input.description, 'Issue description is invalid.')
    const assigneeUserId = readTeamIssueAssigneeUserId(input)
    const schedule = readWorkItemScheduleInput(input.schedule)
    const dueDate = deriveWorkItemScheduleDueDate(schedule)
    const priority = readWorkItemPriority(input.priority)
    const assignedProjectId = readAssignedProjectId(input.assignedProjectId)
    const workflowSchemaVersion = readWorkflowSchemaVersion(input.workflowSchemaVersion)
    const workflowStatusId = readWorkflowStatusId(input.workflowStatusId)
    const statusCategory = readWorkflowStatusCategory(input.statusCategory)
    const customFieldValues = readCustomFieldValues(input.customFieldValues)
    const idempotentIssueId = input.idempotentIssueId === undefined
      ? undefined
      : readRequiredString(
          input.idempotentIssueId,
          'Idempotent Work Item ID is required.',
        )
    const idempotentRequestDigest = input.idempotentRequestDigest === undefined
      ? undefined
      : readRequiredString(
          input.idempotentRequestDigest,
          'Idempotent request digest is required.',
        )
    if (
      (idempotentIssueId === undefined) !==
        (idempotentRequestDigest === undefined) ||
      (idempotentIssueId !== undefined &&
      !/^(?:api|import|triage)-[a-f0-9]{48}$/u.test(idempotentIssueId)) ||
      (idempotentRequestDigest !== undefined &&
        !/^[a-f0-9]{64}$/u.test(idempotentRequestDigest))
    ) {
      throw new ProjectDataError(
        400,
        'InvalidIdempotentWorkItemCreate',
        'Idempotent Work Item create metadata is invalid.',
      )
    }
    const sourceRequestId = requestConversion
      ? readSourceRequestId(requestConversion.submissionId)
      : undefined
    const sourceTriageEntryId = triageAcceptance
      ? readSourceTriageEntryId(triageAcceptance.entryId)
      : undefined
    if (
      triageAcceptance &&
      (idempotentIssueId === undefined || idempotentRequestDigest === undefined)
    ) {
      throw new ProjectDataError(
        400,
        'InvalidIdempotentWorkItemCreate',
        'Triage acceptance requires deterministic Work Item create metadata.',
      )
    }
    const idempotencyResourceId = readIdempotencyResourceId(input.idempotencyResourceId)
    if (idempotentIssueId !== undefined && idempotencyResourceId !== undefined) {
      throw new ProjectDataError(
        400,
        'InvalidIdempotentWorkItemCreate',
        'Only one Work Item create idempotency mechanism may be used.',
      )
    }
    const directoryTeamId = createDirectoryTeamId(directoryId, teamId)
    const now = triageAcceptance
      ? readTriageAcceptanceInstant(triageAcceptance.occurredAt)
      : new Date().toISOString()
    const configurationConditionChecks = input.configurationConditionChecks ?? []
    const authorizationConditionEntries = [
      ...createCallerAuthorizationConditionEntries(input.authorizationConditionChecks),
      ...createAuthorizationSnapshotConditionEntries(input.authorizationSnapshot),
    ]
    const authorizationConditionChecks = authorizationConditionEntries.map((entry) =>
      entry.transactWriteItem
    )

    try {
      const currentIssues = await this.getTeamIssues(
        directoryId,
        teamId,
        { includeArchived: true },
      )
      const existingSourceIssue = sourceRequestId
        ? currentIssues.issues.find((issue) => issue.sourceRequestId === sourceRequestId)
        : undefined

      if (existingSourceIssue) {
        return { issue: existingSourceIssue } satisfies CreateTeamIssueResponse
      }

      const issueId = idempotentIssueId ?? idempotencyResourceId ?? (
        sourceRequestId
          ? createUniqueResourceId(
              `request-${sourceRequestId}`,
              currentIssues.issues.map((issue) => issue.id),
            )
          : createUniqueResourceId(
              title,
              currentIssues.issues.map((issue) => issue.id),
            )
      )
      const item: TeamIssueItem = {
        schemaVersion: WORK_ITEM_SCHEMA_VERSION,
        revision: 1,
        directoryId,
        directoryTeamId,
        teamId,
        issueId,
        ...(idempotentRequestDigest ? { importRequestDigest: idempotentRequestDigest } : {}),
        sortOrder: (currentIssues.issues.length + 1) * 10,
        title,
        assigneeUserId,
        creatorMemberKey: actorUserId,
        ...(sourceRequestId ? { sourceRequestId } : {}),
        ...(sourceTriageEntryId ? { sourceTriageEntryId } : {}),
        workflowSchemaVersion,
        workflowStatusId,
        statusCategory,
        customFieldValues,
        relationIds: [],
        dueDate,
        schedule,
        priority,
        priorityUpdatedAt: now,
        dueDateUpdatedAt: now,
        createdAt: now,
        updatedAt: now,
      }

      if (description) {
        item.description = description
      }

      if (assignedProjectId) {
        item.assignedProjectId = assignedProjectId
        item.directoryProjectId = createDirectoryProjectId(directoryId, assignedProjectId)
      }

      const eventItem = this.createIssueEventItem({
        directoryId,
        teamId,
        issueId,
        eventType: 'created',
        actorUserId,
        summary: 'Issue was created.',
        createdAt: now,
      })
      auditPut = createMutationAuditEventPut(this.auditTableName, auditContext, {
        directoryId,
        eventType: 'work-item.created',
        entityType: 'work-item',
        entityId: createTeamIssueAuditEntityId(teamId, issueId),
        action: 'created',
        occurredAt: now,
        summary: 'Work Item was created and assigned.',
        changes: createAuditFieldChanges(undefined, item, [
          'title',
          'description',
          'assignedProjectId',
          'assigneeUserId',
          'workflowStatusId',
          'statusCategory',
          'customFieldValues',
          'dueDate',
          'schedule',
          'priority',
          'sourceRequestId',
          'sourceTriageEntryId',
        ]),
        metadata: {
          adapter: 'canonical-work-item',
          actorMemberKey: actorUserId,
          teamId,
          issueId,
          projectId: assignedProjectId,
          sourceRequestId,
          sourceTriageEntryId,
          deepLink: createTeamIssueDeepLink(teamId, issueId),
          notificationTitle: title,
          notificationCandidates: [
            { memberKey: assigneeUserId, reason: 'assignment' },
          ],
          afterRevision: item.revision,
        },
      })
      const requestConversionItems = requestConversion
        ? createRequestConversionTransactionItems(
            requestConversion,
            teamId,
            issueId,
            assignedProjectId ?? undefined,
            now,
          )
        : []
      const planningRevisionMutation = createPlanningRevisionIncrementTransactionItem(
        this.planningTableName,
        directoryId,
        now,
      )
      await this.documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.issueTableName,
                Item: item,
                ConditionExpression: 'attribute_not_exists(directoryTeamId) AND attribute_not_exists(issueId)',
              },
            },
            {
              Put: {
                TableName: this.eventTableName,
                Item: eventItem,
                ConditionExpression: 'attribute_not_exists(directoryTeamIssueId) AND attribute_not_exists(eventId)',
              },
            },
            ...(auditPut ? [auditPut] : []),
            ...configurationConditionChecks,
            ...authorizationConditionChecks,
            ...requestConversionItems,
            ...(planningRevisionMutation ? [planningRevisionMutation] : []),
            ...(triageAcceptance?.transactItems ?? []),
          ],
        }),
      )

      return {
        issue: toTeamIssueResponseItem(item),
      } satisfies CreateTeamIssueResponse
    } catch (error) {
      const configurationConditionStartIndex = resolveConfigurationConditionStartIndex(
        2,
        auditPut,
      )
      const authorizationConditionStartIndex =
        configurationConditionStartIndex + configurationConditionChecks.length
      throwAuthorizationConditionFailureIfPresent(
        error,
        authorizationConditionStartIndex,
        authorizationConditionEntries,
      )
      if (configurationConditionChecks.some((_, index) =>
        isTransactionConditionalFailureAt(error, configurationConditionStartIndex + index)
      )) {
        throw createWorkItemConfigurationRevisionConflictError()
      }
      if (
        isAwsNamedError(error, 'TransactionCanceledException') &&
        hasTransactionConditionalFailure(error)
      ) {
        if (idempotentIssueId && idempotentRequestDigest) {
          try {
            const existing = await this.getRequiredTeamIssueItem(
              directoryId,
              teamId,
              idempotentIssueId,
              true,
            )
            if (existing.importRequestDigest === idempotentRequestDigest) {
              return {
                issue: toTeamIssueResponseItem(existing),
              } satisfies CreateTeamIssueResponse
            }
            throw new ProjectDataError(
              409,
              'IdempotentWorkItemCreateConflict',
              'The deterministic Work Item ID belongs to another request.',
            )
          } catch (readError) {
            if (!isTeamIssueNotFoundError(readError)) throw readError
          }
        }
        if (sourceRequestId) {
          const currentIssues = await this.getTeamIssues(
            directoryId,
            teamId,
            { includeArchived: true },
          )
          const existingSourceIssue = currentIssues.issues.find(
            (issue) => issue.sourceRequestId === sourceRequestId,
          )
          if (existingSourceIssue) {
            return { issue: existingSourceIssue } satisfies CreateTeamIssueResponse
          }
        }
        if (idempotencyResourceId) {
          const existing = await this.getTeamIssueDetail(
            directoryId,
            teamId,
            idempotencyResourceId,
            { consistentIssueRead: true, eventLimit: 0 },
          ).catch(() => undefined)
          if (existing && isMatchingIdempotentWorkItemCreate(existing.issue, {
            actorUserId,
            assigneeUserId,
            assignedProjectId,
            customFieldValues,
            description,
            dueDate,
            schedule,
            priority,
            statusCategory,
            title,
            workflowSchemaVersion,
            workflowStatusId,
          })) {
            return { issue: existing.issue } satisfies CreateTeamIssueResponse
          }
        }
        throw createProjectDataConflictError()
      }

      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * Persists a bounded schedule cascade in one revision- and graph-guarded transaction.
   *
   * @param directoryId - Owning Workspace directory identifier.
   * @param updates - Deterministically ordered replacement schedules.
   * @param guardedRevisions - Non-mutated endpoint revisions used during recomputation.
   * @param actorUserId - Workspace member that confirmed the cascade.
   * @param auditContext - Optional immutable audit context shared by every impact.
   * @param relationGraphConditionChecks - Semantic relation revision guards.
   * @param authorizationSnapshot - Workspace and Planning generations observed at confirmation.
   * @param idempotency - Optional completion receipt committed with the cascade.
   * @returns Every updated canonical Work Item in input order.
   */
  async updateTeamIssueSchedules(
    directoryId: string,
    updates: readonly WorkItemScheduleCascadeUpdate[],
    guardedRevisions: readonly WorkItemScheduleCascadeGuard[],
    actorUserId: string,
    auditContext?: MutationAuditContext,
    relationGraphConditionChecks:
      NonNullable<TransactWriteCommandInput['TransactItems']> = [],
    authorizationSnapshot?: WorkItemAuthorizationSnapshot,
    idempotency?: WorkItemIdempotencyTransaction,
  ): Promise<WorkItemScheduleCascadeResponse> {
    await this.ensureLocalTables()
    if (updates.length === 0) {
      throw new ProjectDataError(
        400,
        'InvalidWorkItemScheduleCascade',
        'A schedule cascade must contain at least one Work Item.',
      )
    }
    if (updates.length > WORK_ITEM_SCHEDULE_CASCADE_LIMIT) {
      throw new ProjectDataError(
        413,
        'WorkItemScheduleCascadeLimitExceeded',
        `A schedule cascade cannot exceed ${WORK_ITEM_SCHEDULE_CASCADE_LIMIT} Work Items.`,
      )
    }
    const duplicateKeys = new Set<string>()
    for (const update of updates) {
      const key = `${update.teamId}\0${update.workItemId}`
      if (duplicateKeys.has(key)) {
        throw new ProjectDataError(
          400,
          'InvalidWorkItemScheduleCascade',
          'A schedule cascade cannot update the same Work Item twice.',
        )
      }
      duplicateKeys.add(key)
    }
    const guardedKeys = new Set<string>()
    for (const guard of guardedRevisions) {
      const key = `${guard.teamId}\0${guard.workItemId}`
      readWorkItemExpectedRevision(guard.expectedRevision)
      if (duplicateKeys.has(key) || guardedKeys.has(key)) {
        throw new ProjectDataError(
          400,
          'InvalidWorkItemScheduleCascade',
          'Cascade revision guards must be unique and cannot duplicate updated Work Items.',
        )
      }
      guardedKeys.add(key)
    }

    const occurredAt = new Date().toISOString()
    const prepared = await Promise.all(updates.map(async (update, sequence) => {
      const expectedRevision = readWorkItemExpectedRevision(update.expectedRevision)
      const beforeIssue = await this.getRequiredTeamIssueItem(
        directoryId,
        update.teamId,
        update.workItemId,
        true,
      )
      if (beforeIssue.revision !== expectedRevision) {
        throw createWorkItemRevisionConflictError()
      }
      const schedule = readWorkItemScheduleInput(update.schedule)
      const dueDate = deriveWorkItemScheduleDueDate(schedule)
      const dueDateChanged = dueDate !== beforeIssue.dueDate
      const afterIssue: TeamIssueItem = {
        ...beforeIssue,
        schemaVersion: WORK_ITEM_SCHEMA_VERSION,
        revision: expectedRevision + 1,
        schedule,
        dueDate,
        ...(dueDateChanged ? { dueDateUpdatedAt: occurredAt } : {}),
        updatedAt: occurredAt,
      }
      const eventItem = this.createIssueEventItem({
        directoryId,
        teamId: update.teamId,
        issueId: update.workItemId,
        eventType: 'updated',
        actorUserId,
        summary: 'Issue schedule was updated by a dependency cascade.',
        createdAt: occurredAt,
      })
      const auditPut = createMutationAuditEventPut(this.auditTableName, auditContext, {
        directoryId,
        eventType: 'work-item.schedule-cascade-updated',
        entityType: 'work-item',
        entityId: createTeamIssueAuditEntityId(update.teamId, update.workItemId),
        action: 'schedule-cascade-updated',
        sequence,
        occurredAt,
        summary: createWorkItemNotificationSummary(beforeIssue, afterIssue),
        changes: createAuditFieldChanges(beforeIssue, afterIssue, ['dueDate', 'schedule']),
        metadata: {
          adapter: 'canonical-work-item',
          actorMemberKey: actorUserId,
          teamId: update.teamId,
          issueId: update.workItemId,
          projectId: afterIssue.assignedProjectId,
          deepLink: createTeamIssueDeepLink(update.teamId, update.workItemId),
          notificationTitle: afterIssue.title,
          notificationCandidates: createWorkItemNotificationCandidates(beforeIssue, afterIssue),
          beforeRevision: expectedRevision,
          afterRevision: expectedRevision + 1,
          cascadeSize: updates.length,
        },
      })
      return { update, expectedRevision, afterIssue, eventItem, auditPut, dueDateChanged }
    }))
    const authorizationConditionEntries = createAuthorizationSnapshotConditionEntries(
      authorizationSnapshot,
    )
    const authorizationConditionChecks = authorizationConditionEntries.map((entry) =>
      entry.transactWriteItem
    )
    const issues = prepared.map((entry) => toTeamIssueResponseItem(entry.afterIssue))
    const response: WorkItemScheduleCascadeResponse = {
      issues,
      confirmedSchedules: issues.map((issue) => ({
        id: issue.id,
        teamId: issue.teamId,
        revision: issue.revision,
        schedule: issue.schedule,
        dueDate: issue.dueDate,
        ...(issue.assignedProjectId
          ? { assignedProjectId: issue.assignedProjectId }
          : {}),
      } satisfies ConfirmedWorkItemSchedule)),
    }
    let idempotencyCompletion: IdempotencyCompletionTransactWrite | undefined
    try {
      idempotencyCompletion = await idempotency?.prepare({
        status: 200,
        body: { workItems: response.confirmedSchedules },
      })
    } catch (error) {
      if (error instanceof ProjectDataError) throw error
      throw new ProjectDataError(
        503,
        'WorkItemScheduleCascadeTransactionUnavailable',
        'The durable schedule confirmation receipt could not be prepared.',
      )
    }
    if (idempotency && !idempotencyCompletion) {
      throw new ProjectDataError(
        503,
        'WorkItemScheduleCascadeTransactionUnavailable',
        'The durable schedule confirmation receipt is not configured.',
      )
    }
    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = []
    const updateConditionIndexes: number[] = []
    for (const entry of prepared) {
      updateConditionIndexes.push(transactItems.length)
      transactItems.push({
        Update: {
          TableName: this.issueTableName,
          Key: {
            directoryTeamId: createDirectoryTeamId(directoryId, entry.update.teamId),
            issueId: entry.update.workItemId,
          },
          UpdateExpression:
            'SET #schemaVersion = :schemaVersion, #revision = :nextRevision, ' +
            '#schedule = :schedule, #dueDate = :dueDate, #updatedAt = :updatedAt' +
            (entry.dueDateChanged ? ', #dueDateUpdatedAt = :dueDateUpdatedAt' : ''),
          ExpressionAttributeNames: {
            '#schemaVersion': 'schemaVersion',
            '#revision': 'revision',
            '#schedule': 'schedule',
            '#dueDate': 'dueDate',
            '#updatedAt': 'updatedAt',
            ...(entry.dueDateChanged
              ? { '#dueDateUpdatedAt': 'dueDateUpdatedAt' }
              : {}),
          },
          ExpressionAttributeValues: {
            ':schemaVersion': WORK_ITEM_SCHEMA_VERSION,
            ':expectedRevision': entry.expectedRevision,
            ':nextRevision': entry.expectedRevision + 1,
            ':schedule': entry.afterIssue.schedule,
            ':dueDate': entry.afterIssue.dueDate,
            ':updatedAt': occurredAt,
            ...(entry.dueDateChanged ? { ':dueDateUpdatedAt': occurredAt } : {}),
          },
          ConditionExpression:
            'attribute_exists(directoryTeamId) AND attribute_exists(issueId) AND ' +
            '#revision = :expectedRevision',
        },
      })
      transactItems.push({
        Put: {
          TableName: this.eventTableName,
          Item: entry.eventItem,
          ConditionExpression:
            'attribute_not_exists(directoryTeamIssueId) AND attribute_not_exists(eventId)',
        },
      })
      if (entry.auditPut) transactItems.push(entry.auditPut)
    }
    const guardedRevisionStartIndex = transactItems.length
    for (const guard of guardedRevisions) {
      transactItems.push({
        ConditionCheck: {
          TableName: this.issueTableName,
          Key: {
            directoryTeamId: createDirectoryTeamId(directoryId, guard.teamId),
            issueId: guard.workItemId,
          },
          ConditionExpression:
            'attribute_exists(directoryTeamId) AND attribute_exists(issueId) AND ' +
            '#revision = :expectedRevision',
          ExpressionAttributeNames: { '#revision': 'revision' },
          ExpressionAttributeValues: { ':expectedRevision': guard.expectedRevision },
        },
      })
    }
    const relationConditionStartIndex = transactItems.length
    transactItems.push(...relationGraphConditionChecks)
    const authorizationConditionStartIndex = transactItems.length
    transactItems.push(...authorizationConditionChecks)
    if (idempotencyCompletion) {
      transactItems.push(idempotencyCompletion.transactWriteItem)
    }
    const planningRevisionMutation = createPlanningRevisionIncrementTransactionItem(
      this.planningTableName,
      directoryId,
      occurredAt,
    )
    if (planningRevisionMutation) transactItems.push(planningRevisionMutation)
    const planningRevisionFenceBarrierItems = planningRevisionMutation === undefined ? 0 : 1
    if (transactItems.length + planningRevisionFenceBarrierItems > 100) {
      throw new ProjectDataError(
        413,
        'WorkItemScheduleCascadeLimitExceeded',
        'The schedule cascade exceeds the DynamoDB transaction item limit.',
      )
    }

    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactItems }))
    } catch (error) {
      throwAuthorizationConditionFailureIfPresent(
        error,
        authorizationConditionStartIndex,
        authorizationConditionEntries,
      )
      if (updateConditionIndexes.some((index) => isTransactionConditionalFailureAt(error, index))) {
        throw createWorkItemRevisionConflictError()
      }
      if (guardedRevisions.some((_, index) =>
        isTransactionConditionalFailureAt(error, guardedRevisionStartIndex + index)
      )) {
        throw createWorkItemRevisionConflictError()
      }
      if (relationGraphConditionChecks.some((_, index) =>
        isTransactionConditionalFailureAt(error, relationConditionStartIndex + index)
      )) {
        throw new ProjectDataError(
          409,
          'WorkItemRelationGraphConflict',
          'Work Item relations changed. Reload and try again.',
        )
      }
      if (hasTransactionConditionalFailure(error)) {
        throw new ProjectDataError(
          409,
          'WorkItemScheduleCascadeConflict',
          'The schedule cascade changed during confirmation. Reload and try again.',
        )
      }
      if (isAwsNamedError(error, 'TransactionCanceledException')) {
        throw new ProjectDataError(
          503,
          'WorkItemScheduleCascadeTransactionUnavailable',
          'The schedule cascade transaction could not be classified safely. Retry the request.',
        )
      }
      if (error instanceof ProjectDataError) throw error
      throw toProjectDataError(error)
    }

    return response
  }

  /**
   * DynamoDB の team issue を更新します。
   */
  async updateTeamIssue(
    directoryId: string,
    teamId: string,
    issueId: string,
    input: UpdateTeamIssueRequestBody,
    actorUserId: string,
    auditContext?: MutationAuditContext,
    idempotency?: WorkItemIdempotencyTransaction,
  ) {
    await this.ensureLocalTables()
    let auditPut: ReturnType<typeof createMutationAuditEventPut> = undefined
    const expectedRevision = readWorkItemExpectedRevision(input.expectedRevision)
    const nextRevision = expectedRevision + 1
    if (input.authorizationSnapshot && input.planningRevisionFence) {
      throw new ProjectDataError(
        500,
        'InvalidWorkItemAuthorizationFence',
        'A Work Item update cannot contain overlapping authorization fences.',
      )
    }
    const configurationConditionChecks = input.configurationConditionChecks ?? []
    const authorizationConditionEntries = [
      ...createCallerAuthorizationConditionEntries(input.authorizationConditionChecks),
      ...createAuthorizationSnapshotConditionEntries(input.authorizationSnapshot),
      ...createPlanningRevisionFenceConditionEntries(directoryId, input.planningRevisionFence),
    ]
    const authorizationConditionChecks = authorizationConditionEntries.map((entry) =>
      entry.transactWriteItem
    )
    if ('schedule' in input) readWorkItemScheduleInput(input.schedule)
    const directoryTeamId = createDirectoryTeamId(directoryId, teamId)
    const expressionAttributeNames: Record<string, string> = {
      '#schemaVersion': 'schemaVersion',
      '#revision': 'revision',
      '#updatedAt': 'updatedAt',
    }
    const updatedAt = new Date().toISOString()
    const expressionAttributeValues: Record<string, unknown> = {
      ':schemaVersion': WORK_ITEM_SCHEMA_VERSION,
      ':expectedRevision': expectedRevision,
      ':nextRevision': nextRevision,
      ':updatedAt': updatedAt,
    }
    const setExpressions = [
      '#schemaVersion = :schemaVersion',
      '#revision = :nextRevision',
      '#updatedAt = :updatedAt',
    ]
    const removeExpressions: string[] = []

    if ('title' in input) {
      expressionAttributeNames['#title'] = 'title'
      expressionAttributeValues[':title'] = readRequiredString(input.title, 'Issue title is required.')
      setExpressions.push('#title = :title')
    }

    if ('description' in input) {
      const description = readOptionalString(input.description, 'Issue description is invalid.')
      expressionAttributeNames['#description'] = 'description'

      if (description) {
        expressionAttributeValues[':description'] = description
        setExpressions.push('#description = :description')
      } else {
        removeExpressions.push('#description')
      }
    }

    if ('assignedProjectId' in input) {
      const assignedProjectId = readAssignedProjectId(input.assignedProjectId)
      expressionAttributeNames['#assignedProjectId'] = 'assignedProjectId'
      expressionAttributeNames['#directoryProjectId'] = 'directoryProjectId'

      if (assignedProjectId) {
        expressionAttributeValues[':assignedProjectId'] = assignedProjectId
        expressionAttributeValues[':directoryProjectId'] = createDirectoryProjectId(directoryId, assignedProjectId)
        setExpressions.push('#assignedProjectId = :assignedProjectId')
        setExpressions.push('#directoryProjectId = :directoryProjectId')
      } else {
        removeExpressions.push('#assignedProjectId')
        removeExpressions.push('#directoryProjectId')
      }
    }

    if ('assigneeUserId' in input) {
      expressionAttributeNames['#assigneeUserId'] = 'assigneeUserId'
      expressionAttributeValues[':assigneeUserId'] = readTeamIssueAssigneeUserId(input)
      setExpressions.push('#assigneeUserId = :assigneeUserId')
    }

    if ('workflowStatusId' in input) {
      expressionAttributeNames['#workflowStatusId'] = 'workflowStatusId'
      expressionAttributeValues[':workflowStatusId'] = readWorkflowStatusId(input.workflowStatusId)
      setExpressions.push('#workflowStatusId = :workflowStatusId')
    }

    if ('statusCategory' in input) {
      expressionAttributeNames['#statusCategory'] = 'statusCategory'
      expressionAttributeValues[':statusCategory'] = readWorkflowStatusCategory(input.statusCategory)
      setExpressions.push('#statusCategory = :statusCategory')
    }

    if ('workflowSchemaVersion' in input || 'workflowStatusId' in input || 'customFieldValues' in input) {
      expressionAttributeNames['#workflowSchemaVersion'] = 'workflowSchemaVersion'
      expressionAttributeValues[':workflowSchemaVersion'] = readWorkflowSchemaVersion(
        input.workflowSchemaVersion,
      )
      setExpressions.push('#workflowSchemaVersion = :workflowSchemaVersion')
    }

    if ('customFieldValues' in input) {
      expressionAttributeNames['#customFieldValues'] = 'customFieldValues'
      expressionAttributeValues[':customFieldValues'] = readCustomFieldValues(input.customFieldValues)
      setExpressions.push('#customFieldValues = :customFieldValues')
    }

    if ('priority' in input) {
      expressionAttributeNames['#priority'] = 'priority'
      expressionAttributeValues[':priority'] = readWorkItemPriority(input.priority)
      setExpressions.push('#priority = :priority')
    }

    if ('archivedAt' in input) {
      const archivedAt = readOptionalString(input.archivedAt, 'Issue archive timestamp is invalid.')
      expressionAttributeNames['#archivedAt'] = 'archivedAt'
      expressionAttributeNames['#archivedBy'] = 'archivedBy'

      if (archivedAt) {
        if (!Number.isFinite(Date.parse(archivedAt))) {
          throw new ProjectDataError(400, 'InvalidProjectWrite', 'Issue archive timestamp is invalid.')
        }
        expressionAttributeValues[':archivedAt'] = new Date(archivedAt).toISOString()
        expressionAttributeValues[':archivedBy'] = readRequiredString(
          input.archivedBy ?? actorUserId,
          'Issue archive actor is required.',
        )
        setExpressions.push('#archivedAt = :archivedAt')
        setExpressions.push('#archivedBy = :archivedBy')
      } else {
        removeExpressions.push('#archivedAt')
        removeExpressions.push('#archivedBy')
      }
    }

    try {
      const beforeIssue = await this.getRequiredTeamIssueItem(directoryId, teamId, issueId, true)
      if (beforeIssue.revision !== expectedRevision) {
        throw createWorkItemRevisionConflictError()
      }
      const schedule = 'schedule' in input
        ? readWorkItemScheduleInput(input.schedule)
        : beforeIssue.schedule
      expressionAttributeNames['#dueDate'] = 'dueDate'
      expressionAttributeNames['#schedule'] = 'schedule'
      expressionAttributeValues[':dueDate'] = deriveWorkItemScheduleDueDate(schedule)
      expressionAttributeValues[':schedule'] = schedule
      setExpressions.push('#dueDate = :dueDate')
      setExpressions.push('#schedule = :schedule')
      if (expressionAttributeValues[':dueDate'] !== beforeIssue.dueDate) {
        expressionAttributeNames['#dueDateUpdatedAt'] = 'dueDateUpdatedAt'
        expressionAttributeValues[':dueDateUpdatedAt'] = expressionAttributeValues[':updatedAt']
        setExpressions.push('#dueDateUpdatedAt = :dueDateUpdatedAt')
      }
      if (
        'priority' in input &&
        expressionAttributeValues[':priority'] !== beforeIssue.priority
      ) {
        expressionAttributeNames['#priorityUpdatedAt'] = 'priorityUpdatedAt'
        expressionAttributeValues[':priorityUpdatedAt'] = expressionAttributeValues[':updatedAt']
        setExpressions.push('#priorityUpdatedAt = :priorityUpdatedAt')
      }
      const updateExpression = [
        `SET ${setExpressions.join(', ')}`,
        removeExpressions.length > 0 ? `REMOVE ${removeExpressions.join(', ')}` : undefined,
      ].filter(isDefined).join(' ')
      const archivedAt = expressionAttributeValues[':archivedAt']
      if (
        archivedAt !== undefined &&
        !isCanonicalWorkItemArchiveWindow(
          beforeIssue.createdAt,
          archivedAt,
          expressionAttributeValues[':updatedAt'],
        )
      ) {
        throw new ProjectDataError(
          400,
          'InvalidProjectWrite',
          'Issue archive timestamp is invalid.',
        )
      }
      const afterIssue = {
        ...beforeIssue,
        schemaVersion: WORK_ITEM_SCHEMA_VERSION,
        revision: nextRevision,
        updatedAt: expressionAttributeValues[':updatedAt'] as string,
      }
      for (const [placeholder, field] of Object.entries(expressionAttributeNames)) {
        if (field === 'schemaVersion' || field === 'revision' || field === 'updatedAt') {
          continue
        }

        const value = expressionAttributeValues[`:${field}`]
        if (value !== undefined) {
          ;(afterIssue as unknown as Record<string, unknown>)[field] = value
        } else if (removeExpressions.includes(placeholder)) {
          delete (afterIssue as unknown as Record<string, unknown>)[field]
        }
      }
      const eventItem = this.createIssueEventItem({
        directoryId,
        teamId,
        issueId,
        eventType: 'updated',
        actorUserId,
        summary: 'Issue was updated.',
        createdAt: expressionAttributeValues[':updatedAt'] as string,
      })
      auditPut = createMutationAuditEventPut(this.auditTableName, auditContext, {
        directoryId,
        eventType: 'work-item.updated',
        entityType: 'work-item',
        entityId: createTeamIssueAuditEntityId(teamId, issueId),
        action: 'updated',
        occurredAt: expressionAttributeValues[':updatedAt'] as string,
        summary: createWorkItemNotificationSummary(beforeIssue, afterIssue),
        changes: createAuditFieldChanges(beforeIssue, afterIssue, [
          'title',
          'description',
          'assignedProjectId',
          'assigneeUserId',
          'workflowStatusId',
          'statusCategory',
          'customFieldValues',
          'dueDate',
          'schedule',
          'priority',
          'archivedAt',
          'archivedBy',
        ]),
        metadata: {
          adapter: 'canonical-work-item',
          actorMemberKey: actorUserId,
          teamId,
          issueId,
          projectId: afterIssue.assignedProjectId,
          deepLink: createTeamIssueDeepLink(teamId, issueId),
          notificationTitle: afterIssue.title,
          notificationCandidates: createWorkItemNotificationCandidates(beforeIssue, afterIssue),
          beforeRevision: expectedRevision,
          afterRevision: nextRevision,
        },
      })
      const idempotencyCompletion = await idempotency?.prepare({
        status: 200,
        body: toTeamIssueResponseItem(afterIssue),
      })
      const planningRevisionMutation = createPlanningRevisionIncrementTransactionItem(
        this.planningTableName,
        directoryId,
        updatedAt,
      )
      await this.documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.issueTableName,
                Key: {
                  directoryTeamId,
                  issueId,
                },
                UpdateExpression: updateExpression,
                ExpressionAttributeNames: expressionAttributeNames,
                ExpressionAttributeValues: expressionAttributeValues,
                ConditionExpression:
                  'attribute_exists(directoryTeamId) AND attribute_exists(issueId) AND ' +
                  '#revision = :expectedRevision',
              },
            },
            {
              Put: {
                TableName: this.eventTableName,
                Item: eventItem,
                ConditionExpression: 'attribute_not_exists(directoryTeamIssueId) AND attribute_not_exists(eventId)',
              },
            },
            ...(auditPut ? [auditPut] : []),
            ...configurationConditionChecks,
            ...authorizationConditionChecks,
            ...(idempotencyCompletion
              ? [idempotencyCompletion.transactWriteItem]
              : []),
            ...(planningRevisionMutation ? [planningRevisionMutation] : []),
          ],
        }),
      )

      return {
        issue: toTeamIssueResponseItem(afterIssue),
      } satisfies UpdateTeamIssueResponse
    } catch (error) {
      if (isAwsNamedError(error, 'ConditionalCheckFailedException')) {
        throw new ProjectDataError(404, 'TeamIssueNotFound', 'Issue was not found.')
      }

      const cancellationReasonsMissing =
        isAwsNamedError(error, 'TransactionCanceledException') &&
        (
          !isRecord(error) ||
          !Array.isArray(error.CancellationReasons) ||
          error.CancellationReasons.length === 0
        )

      const configurationConditionStartIndex = resolveConfigurationConditionStartIndex(
        2,
        auditPut,
      )
      const authorizationConditionStartIndex =
        configurationConditionStartIndex + configurationConditionChecks.length
      throwAuthorizationConditionFailureIfPresent(
        error,
        authorizationConditionStartIndex,
        authorizationConditionEntries,
      )
      if (configurationConditionChecks.some((_, index) =>
        isTransactionConditionalFailureAt(error, configurationConditionStartIndex + index)
      )) {
        throw createWorkItemConfigurationRevisionConflictError()
      }

      if (isTransactionConditionalFailureAt(error, 0) || cancellationReasonsMissing) {
        let latestIssue: TeamIssueItem

        try {
          latestIssue = await this.getRequiredTeamIssueItem(directoryId, teamId, issueId, true)
        } catch (readError) {
          if (readError instanceof ProjectDataError && readError.code === 'TeamIssueNotFound') {
            throw readError
          }

          if (readError instanceof ProjectDataError) {
            throw readError
          }

          throw toProjectDataError(readError)
        }

        if (latestIssue.revision !== expectedRevision) {
          throw createWorkItemRevisionConflictError()
        }

        if (isTransactionConditionalFailureAt(error, 0)) {
          throw createProjectDataConflictError()
        }
      }

      if (hasTransactionConditionalFailure(error)) {
        throw createProjectDataConflictError()
      }

      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB の canonical Work Item を revision 条件付きで削除し、同じ transaction に
   * immutable audit event を保存します。
   */
  async deleteTeamIssue(
    directoryId: string,
    teamId: string,
    issueId: string,
    expectedRevision: number,
    actorUserId: string,
    auditContext?: MutationAuditContext,
    idempotency?: WorkItemIdempotencyTransaction,
    deletionFences: readonly NamedWorkItemDeletionFence[] = [],
    authorizationConditionChecks:
      NonNullable<TransactWriteCommandInput['TransactItems']> = [],
    authorizationSnapshot?: WorkItemAuthorizationSnapshot,
  ) {
    await this.ensureLocalTables()
    const directoryTeamId = createDirectoryTeamId(directoryId, teamId)
    const beforeIssue = await this.getRequiredTeamIssueItem(directoryId, teamId, issueId, true)

    if (beforeIssue.revision !== expectedRevision) {
      throw createWorkItemRevisionConflictError()
    }

    const occurredAt = new Date().toISOString()
    const auditPut = createMutationAuditEventPut(this.auditTableName, auditContext, {
      directoryId,
      eventType: 'work-item.deleted',
      entityType: 'work-item',
      entityId: createTeamIssueAuditEntityId(teamId, issueId),
      action: 'deleted',
      occurredAt,
      summary: 'Work Item was deleted.',
      changes: createAuditFieldChanges(beforeIssue, undefined, [
        'title',
        'description',
        'assignedProjectId',
        'assigneeUserId',
        'workflowStatusId',
        'statusCategory',
        'customFieldValues',
        'dueDate',
        'schedule',
        'priority',
      ]),
      metadata: {
        adapter: 'canonical-work-item',
        actorMemberKey: actorUserId,
        teamId,
        issueId,
        projectId: beforeIssue.assignedProjectId,
        notificationTitle: beforeIssue.title,
        beforeRevision: expectedRevision,
      },
    })
    const idempotencyCompletion = await idempotency?.prepare({
      status: 204,
      body: null,
    })
    const planningRevisionMutation = createPlanningRevisionIncrementTransactionItem(
      this.planningTableName,
      directoryId,
      occurredAt,
    )
    const effectiveAuthorizationConditionChecks = [
      ...authorizationConditionChecks,
      ...createAuthorizationSnapshotConditionChecks(authorizationSnapshot),
    ]

    try {
      await this.documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: this.issueTableName,
                Key: { directoryTeamId, issueId },
                ConditionExpression:
                  'attribute_exists(directoryTeamId) AND attribute_exists(issueId) AND #revision = :expectedRevision',
                ExpressionAttributeNames: { '#revision': 'revision' },
                ExpressionAttributeValues: { ':expectedRevision': expectedRevision },
              },
            },
            ...deletionFences.map((fence) => fence.transactWriteItem),
            ...(auditPut ? [auditPut] : []),
            ...effectiveAuthorizationConditionChecks,
            ...(idempotencyCompletion
              ? [idempotencyCompletion.transactWriteItem]
              : []),
            ...(planningRevisionMutation ? [planningRevisionMutation] : []),
          ],
        }),
      )

      return { issue: toTeamIssueResponseItem(beforeIssue) }
    } catch (error) {
      const authorizationConditionStartIndex =
        1 + deletionFences.length + (auditPut === undefined ? 0 : 1)
      if (effectiveAuthorizationConditionChecks.some((_, index) =>
        isTransactionConditionalFailureAt(error, authorizationConditionStartIndex + index)
      )) {
        throw createWorkItemAuthorizationChangedError()
      }

      const canonicalIssueConditionFailed = isTransactionConditionalFailureAt(error, 0)
      const cancellationReasonsMissing =
        isAwsNamedError(error, 'TransactionCanceledException') &&
        (
          !isRecord(error) ||
          !Array.isArray(error.CancellationReasons) ||
          error.CancellationReasons.length === 0
        )
      if (canonicalIssueConditionFailed || cancellationReasonsMissing) {
        try {
          const latestIssue = await this.getRequiredTeamIssueItem(
            directoryId,
            teamId,
            issueId,
            true,
          )
          if (latestIssue.revision !== expectedRevision) {
            throw createWorkItemRevisionConflictError()
          }
        } catch (readError) {
          if (readError instanceof ProjectDataError) {
            throw readError
          }
          throw toProjectDataError(readError)
        }
      }

      for (const [index, fence] of deletionFences.entries()) {
        if (isTransactionConditionalFailureAt(error, 1 + index)) {
          throw createWorkItemDeletionFenceConflictError(fence.kind)
        }
      }

      if (isAwsNamedError(error, 'TransactionCanceledException')) {
        throw createWorkItemDeletionTransactionUnavailableError()
      }

      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  private async hasTeamIssueItem(directoryId: string, teamId: string, issueId: string) {
    try {
      await this.getRequiredTeamIssueItem(directoryId, teamId, issueId, true)

      return true
    } catch (error) {
      if (error instanceof ProjectDataError && error.code === 'TeamIssueNotFound') {
        return false
      }

      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }
  private async getRequiredTeamIssueItem(
    directoryId: string,
    teamId: string,
    issueId: string,
    consistentRead = false,
  ) {
    const response = await this.documentClient.send(
      new GetCommand({
        TableName: this.issueTableName,
        Key: {
          directoryTeamId: createDirectoryTeamId(directoryId, teamId),
          issueId,
        },
        ConsistentRead: consistentRead,
      }),
    )

    if (!response.Item) {
      throw new ProjectDataError(404, 'TeamIssueNotFound', 'Issue was not found.')
    }

    return toTeamIssueItem(response.Item)
  }

  private async queryTeamIssueItems(
    directoryId: string,
    teamId: string,
    options: WorkItemListReadOptions = {},
  ) {
    const items: TeamIssueItem[] = []
    const limit = normalizeWorkItemListReadLimit(options.limit)
    let exclusiveStartKey: Record<string, unknown> | undefined

    if (limit === 0) {
      return []
    }

    do {
      const remaining = limit === undefined ? undefined : limit - items.length
      const response = await this.documentClient.send(
        new QueryCommand({
          TableName: this.issueTableName,
          ...(options.consistentRead
            ? { ConsistentRead: true }
            : { IndexName: 'TeamIssueSortOrderIndex', ScanIndexForward: true }),
          KeyConditionExpression: 'directoryTeamId = :directoryTeamId',
          ExpressionAttributeValues: {
            ':directoryTeamId': createDirectoryTeamId(directoryId, teamId),
          },
          ExclusiveStartKey: exclusiveStartKey,
          ...(remaining === undefined ? {} : { Limit: remaining }),
        }),
      )

      const pageItems = (response.Items ?? [])
        .map(toTeamIssueItem)
        .filter((item) => options.includeArchived || item.archivedAt === undefined)
      items.push(...(remaining === undefined ? pageItems : pageItems.slice(0, remaining)))
      if (limit !== undefined && items.length >= limit) {
        break
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)

    return items
  }

  private async queryProjectIssueItems(
    directoryId: string,
    projectId: string,
    options: WorkItemListReadOptions = {},
  ) {
    const items: TeamIssueItem[] = []
    const limit = normalizeWorkItemListReadLimit(options.limit)
    let exclusiveStartKey: Record<string, unknown> | undefined

    if (limit === 0) {
      return []
    }

    do {
      const remaining = limit === undefined ? undefined : limit - items.length
      const response = await this.documentClient.send(
        new QueryCommand({
          TableName: this.issueTableName,
          IndexName: 'AssignedProjectIssueIndex',
          KeyConditionExpression: 'directoryProjectId = :directoryProjectId',
          ExpressionAttributeValues: {
            ':directoryProjectId': createDirectoryProjectId(directoryId, projectId),
          },
          ExclusiveStartKey: exclusiveStartKey,
          ScanIndexForward: true,
          ...(remaining === undefined ? {} : { Limit: remaining }),
        }),
      )

      const pageItems = (response.Items ?? [])
        .map(toTeamIssueItem)
        .filter((item) => options.includeArchived || item.archivedAt === undefined)
      items.push(...(remaining === undefined ? pageItems : pageItems.slice(0, remaining)))
      if (limit !== undefined && items.length >= limit) {
        break
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)

    return items
  }

  private async queryTeamIssueEventItems(
    directoryId: string,
    teamId: string,
    issueId: string,
    options: TeamIssueDetailReadOptions = {},
  ) {
    const items: unknown[] = []
    const eventLimit = options.eventLimit === undefined
      ? undefined
      : Math.max(1, Math.floor(options.eventLimit))
    const directoryTeamIssueId = createDirectoryTeamIssueId(directoryId, teamId, issueId)
    const eventCursor = decodeTeamIssueEventCursor(
      options.eventCursor,
      directoryTeamIssueId,
    )
    if ((eventCursor?.version === 2 || eventCursor?.version === 3) &&
        options.eventType !== 'commented') {
      throw new ProjectDataError(
        400,
        'InvalidTeamIssueCursor',
        'Team Issue event cursor is invalid for this event query.',
      )
    }
    if (options.eventType === 'commented' &&
        (eventCursor === undefined || eventCursor.version === 2 || eventCursor.version === 3)) {
      return this.queryCommentEventsWithNormalizedOrdering(
        directoryTeamIssueId,
        options,
        eventCursor,
      )
    }
    let exclusiveStartKey: Record<string, unknown> | undefined = eventCursor
      ? {
          directoryTeamIssueId: eventCursor.directoryTeamIssueId,
          eventId: eventCursor.eventId,
        }
      : undefined

    do {
      const remaining = eventLimit === undefined ? undefined : eventLimit - items.length
      const response = await this.documentClient.send(
        new QueryCommand({
          TableName: this.eventTableName,
          KeyConditionExpression: 'directoryTeamIssueId = :directoryTeamIssueId',
          ExpressionAttributeValues: {
            ':directoryTeamIssueId': directoryTeamIssueId,
            ...(options.eventType ? { ':eventType': options.eventType } : {}),
          },
          ...(options.eventType ? { FilterExpression: 'eventType = :eventType' } : {}),
          ExclusiveStartKey: exclusiveStartKey,
          ScanIndexForward: options.newestEventsFirst !== true,
          ...(remaining === undefined ? {} : { Limit: remaining }),
        }),
      )

      items.push(...(response.Items ?? []))
      exclusiveStartKey = response.LastEvaluatedKey
      if (eventLimit !== undefined && items.length >= eventLimit) {
        break
      }
    } while (exclusiveStartKey)

    return {
      items: items.map(toTeamIssueEventItem),
      ...(exclusiveStartKey
        ? {
            nextCursor: encodeTeamIssueEventCursor(
              directoryTeamIssueId,
              exclusiveStartKey,
              false,
            ),
          }
        : {}),
    }
  }

  /**
   * Reads bounded comment pages from the canonical time index and keeps the
   * full sparse-index validation path for unbounded transitional reads.
   *
   * @param directoryTeamIssueId - Work Item event partition key.
   * @param options - Comment event page options.
   * @param eventCursor - Previously emitted comment cursor.
   * @returns A chronologically ordered comment page.
   */
  private async queryCommentEventsWithNormalizedOrdering(
    directoryTeamIssueId: string,
    options: TeamIssueDetailReadOptions,
    eventCursor: Extract<TeamIssueEventCursor, { version: 2 | 3 }> | undefined,
  ) {
    const eventLimit = options.eventLimit === undefined
      ? undefined
      : Math.max(1, Math.floor(options.eventLimit))
    if (eventCursor?.version === 3) {
      const chronologicalPage = await this.queryChronologicalCommentEvents(
        directoryTeamIssueId,
        eventCursor,
        eventLimit,
        options.newestEventsFirst === true,
      )
      const chronologicalItems = eventLimit === undefined
        ? chronologicalPage.items
        : chronologicalPage.items.slice(0, eventLimit)
      const lastItem = chronologicalItems.at(-1)
      const lastCommentCreatedAtOrder = lastItem === undefined
        ? undefined
        : requireCommentCreatedAtOrder(lastItem)
      return {
        items: chronologicalItems,
        ...(chronologicalPage.lastEvaluatedKey !== undefined && lastItem && lastCommentCreatedAtOrder
          ? {
              nextCursor: encodeTeamIssueCommentCursor(
                directoryTeamIssueId,
                {
                  eventId: lastItem.eventId,
                  commentCreatedAtOrder: lastCommentCreatedAtOrder,
                },
              ),
            }
          : {}),
      }
    }
    if (eventLimit !== undefined) {
      if (eventCursor === undefined && options.legacyCommentIndexOnly !== true) {
        try {
          const chronologicalPage = await this.queryChronologicalCommentEvents(
            directoryTeamIssueId,
            eventCursor,
            eventLimit,
            options.newestEventsFirst === true,
          )
          const chronologicalItems = chronologicalPage.items.slice(0, eventLimit)
          if (chronologicalItems.length > 0) {
            const lastItem = chronologicalItems.at(-1)
            const lastCommentCreatedAtOrder = lastItem === undefined
              ? undefined
              : requireCommentCreatedAtOrder(lastItem)
            return {
              items: chronologicalItems,
              ...(chronologicalPage.lastEvaluatedKey !== undefined && lastItem && lastCommentCreatedAtOrder
                ? {
                    nextCursor: encodeTeamIssueCommentCursor(
                      directoryTeamIssueId,
                      {
                        eventId: lastItem.eventId,
                        commentCreatedAtOrder: lastCommentCreatedAtOrder,
                      },
                    ),
                  }
                : {}),
            }
          }
        } catch (error) {
          if (!isResourceNotFoundError(error)) {
            throw error
          }
        }
      }
      const indexedPage = await this.queryIndexedCommentEvents(directoryTeamIssueId)
      const baseCommentIds = await this.readCommentEventIndexCoverage(directoryTeamIssueId)
      const indexedCommentIds = new Set(indexedPage.items.map((item) => item.eventId))
      const items = setsEqual(indexedCommentIds, baseCommentIds)
        ? indexedPage.items
        : (await this.queryBaseCommentEvents(directoryTeamIssueId)).items
      const orderedItems = [...items].sort((left, right) =>
        compareTeamIssueEvents(left, right, options.newestEventsFirst === true)
      )
      const startIndex = findTeamIssueEventCursorStartIndex(
        orderedItems,
        eventCursor,
        options.newestEventsFirst === true,
      )
      const pageItems = orderedItems.slice(startIndex, startIndex + eventLimit)
      const hasMore = startIndex + pageItems.length < orderedItems.length
      const lastItem = pageItems.at(-1)
      return {
        items: pageItems,
        ...(hasMore && lastItem
          ? {
              nextCursor: encodeTeamIssueEventCursor(
                directoryTeamIssueId,
                {
                  eventId: lastItem.eventId,
                  createdAt: lastItem.createdAt,
                },
                true,
              ),
            }
          : {}),
      }
    }

    const [indexedItems, baseCommentIds] = await Promise.all([
      this.queryIndexedCommentEvents(directoryTeamIssueId),
      this.readCommentEventIndexCoverage(directoryTeamIssueId),
    ])
    const indexedCommentIds = new Set(indexedItems.items.map((item) => item.eventId))
    const items = setsEqual(indexedCommentIds, baseCommentIds)
      ? indexedItems.items
      : (await this.queryBaseCommentEvents(directoryTeamIssueId)).items
    const orderedItems = [...items].sort((left, right) =>
      compareTeamIssueEvents(left, right, options.newestEventsFirst === true)
    )
    const startIndex = findTeamIssueEventCursorStartIndex(
      orderedItems,
      eventCursor,
      options.newestEventsFirst === true,
    )
    const pageItems = eventLimit === undefined
      ? orderedItems.slice(startIndex)
      : orderedItems.slice(startIndex, startIndex + eventLimit)
    const lastItem = pageItems.at(-1)
    const hasMore = lastItem !== undefined && startIndex + pageItems.length < orderedItems.length
    return {
      items: pageItems,
      ...(hasMore && lastItem
        ? {
            nextCursor: encodeTeamIssueEventCursor(
              directoryTeamIssueId,
              {
                eventId: lastItem.eventId,
                createdAt: lastItem.createdAt,
              },
              true,
            ),
          }
        : {}),
    }
  }

  /** Reads a bounded page from the canonical comment-time index. */
  private async queryChronologicalCommentEvents(
    directoryTeamIssueId: string,
    eventCursor: Extract<TeamIssueEventCursor, { version: 3 }> | undefined,
    eventLimit: number | undefined,
    newestEventsFirst: boolean,
  ) {
    const items: TeamIssueEventItem[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined = eventCursor
      ? {
          directoryTeamIssueId: eventCursor.directoryTeamIssueId,
          eventId: eventCursor.eventId,
          commentCreatedAtOrder: eventCursor.commentCreatedAtOrder,
        }
      : undefined
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.eventTableName,
        IndexName: 'TeamIssueCommentCreatedAtIndex',
        KeyConditionExpression: 'directoryTeamIssueId = :directoryTeamIssueId',
        ExpressionAttributeValues: {
          ':directoryTeamIssueId': directoryTeamIssueId,
        },
        ExclusiveStartKey: exclusiveStartKey,
        ScanIndexForward: !newestEventsFirst,
        ...(eventLimit === undefined ? {} : { Limit: eventLimit - items.length }),
      }))
      const pageItems = (response.Items ?? []).map(toTeamIssueEventItem)
      for (const item of pageItems) {
        if (item.eventType !== 'commented') {
          throw new ProjectDataError(
            503,
            'InvalidTeamIssue',
            'Team Issue comment index contains a non-comment event.',
          )
        }
        requireCommentCreatedAtOrder(item)
      }
      items.push(...pageItems)
      exclusiveStartKey = response.LastEvaluatedKey
      if (eventLimit !== undefined && items.length >= eventLimit) break
    } while (exclusiveStartKey)
    return { items, lastEvaluatedKey: exclusiveStartKey }
  }

  /** Reads and validates every comment candidate from the sparse createdAt index. */
  private async queryIndexedCommentEvents(directoryTeamIssueId: string) {
    const items: TeamIssueEventItem[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.eventTableName,
        IndexName: 'TeamIssueEventCreatedAtIndex',
        KeyConditionExpression: 'directoryTeamIssueId = :directoryTeamIssueId',
        ExpressionAttributeValues: {
          ':directoryTeamIssueId': directoryTeamIssueId,
          ':eventType': 'commented',
        },
        FilterExpression: 'eventType = :eventType',
        ExclusiveStartKey: exclusiveStartKey,
        ScanIndexForward: false,
      }))
      items.push(...(response.Items ?? []).map(toTeamIssueEventItem))
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)
    return {
      items: items.filter((item) => item.eventType === 'commented'),
      lastEvaluatedKey: exclusiveStartKey,
    }
  }

  /**
   * Validates all comment rows that the sparse createdAt index should contain.
   *
   * @param directoryTeamIssueId - Work Item event partition key.
   * @returns Event IDs present in the strongly consistent base-table query.
   */
  private async readCommentEventIndexCoverage(directoryTeamIssueId: string) {
    const eventIds = new Set<string>()
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.eventTableName,
        KeyConditionExpression: 'directoryTeamIssueId = :directoryTeamIssueId',
        ExpressionAttributeNames: {
          '#createdAt': 'createdAt',
          '#eventId': 'eventId',
          '#eventType': 'eventType',
        },
        ExpressionAttributeValues: {
          ':directoryTeamIssueId': directoryTeamIssueId,
          ':eventType': 'commented',
        },
        FilterExpression: '#eventType = :eventType',
        ProjectionExpression: '#createdAt, #eventId, #eventType',
        ExclusiveStartKey: exclusiveStartKey,
        ConsistentRead: true,
      }))
      for (const item of response.Items ?? []) {
        eventIds.add(readCommentEventIndexCoverageId(item))
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)
    return eventIds
  }

  /** Reads and fully validates comment rows from the base table after index drift. */
  private async queryBaseCommentEvents(
    directoryTeamIssueId: string,
    options: { eventLimit?: number } = {},
  ) {
    const items: TeamIssueEventItem[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.eventTableName,
        KeyConditionExpression: 'directoryTeamIssueId = :directoryTeamIssueId',
        ExpressionAttributeValues: {
          ':directoryTeamIssueId': directoryTeamIssueId,
          ':eventType': 'commented',
        },
        FilterExpression: 'eventType = :eventType',
        ExclusiveStartKey: exclusiveStartKey,
        ConsistentRead: true,
        ...(options.eventLimit === undefined
          ? {}
          : { Limit: Math.max(1, options.eventLimit - items.length) }),
      }))
      items.push(...(response.Items ?? []).map(toTeamIssueEventItem))
      exclusiveStartKey = response.LastEvaluatedKey
      if (options.eventLimit !== undefined && items.length >= options.eventLimit) {
        break
      }
    } while (exclusiveStartKey)
    return {
      items: items.filter((item) => item.eventType === 'commented'),
      lastEvaluatedKey: exclusiveStartKey,
    }
  }

  private createIssueEventItem(
    input: Omit<TeamIssueEventItem, 'directoryTeamIssueId' | 'eventId'> & { eventId?: string },
  ) {
    const createdAt = normalizeTeamIssueEventTimestamp(input.createdAt)
    const eventId = input.eventId ?? createTeamIssueEventId(createdAt, input.eventType)
    return {
      ...input,
      directoryTeamIssueId: createDirectoryTeamIssueId(input.directoryId, input.teamId, input.issueId),
      eventId,
      createdAt,
      ...(input.eventType === 'commented'
        ? { commentCreatedAtOrder: createTeamIssueCommentEventOrder(createdAt, eventId) }
        : {}),
    } satisfies TeamIssueEventItem
  }

  private async ensureLocalTables() {
    if (!this.bootstrapLocalTables) {
      return
    }

    await ensureLocalTeamIssuesTable(this.issueTableName, this.dynamoDbClient)
    await ensureLocalTeamIssueEventsTable(this.eventTableName, this.dynamoDbClient)
    await ensureConfiguredAuditTable(
      this.auditTableName,
      this.dynamoDbClient,
      this.bootstrapLocalTables,
    )
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function createDynamoDbClient() {
  return createConfiguredDynamoDbClient()
}

function createDynamoDbDocumentClient(dynamoDbClient = createDynamoDbClient()) {
  return createPlanningRevisionFenceWriterDynamoDbDocumentClient(dynamoDbClient)
}

const localDynamoDbTableInitializers = new Map<string, Promise<void>>()

async function ensureLocalTeamIssuesTable(
  tableName: string,
  dynamoDbClient: DynamoDBClient,
) {
  return ensureLocalDynamoDbTable(
    tableName,
    dynamoDbClient,
    () =>
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [
          { AttributeName: 'directoryTeamId', AttributeType: 'S' },
          { AttributeName: 'issueId', AttributeType: 'S' },
          { AttributeName: 'sortOrder', AttributeType: 'N' },
          { AttributeName: 'directoryProjectId', AttributeType: 'S' },
          { AttributeName: 'updatedAt', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'directoryTeamId', KeyType: 'HASH' },
          { AttributeName: 'issueId', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'TeamIssueSortOrderIndex',
            KeySchema: [
              { AttributeName: 'directoryTeamId', KeyType: 'HASH' },
              { AttributeName: 'sortOrder', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
          {
            IndexName: 'AssignedProjectIssueIndex',
            KeySchema: [
              { AttributeName: 'directoryProjectId', KeyType: 'HASH' },
              { AttributeName: 'sortOrder', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
          {
            IndexName: 'TeamIssueUpdatedAtIndex',
            KeySchema: [
              { AttributeName: 'directoryTeamId', KeyType: 'HASH' },
              { AttributeName: 'updatedAt', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    isTeamIssuesTableDescription,
  )
}

async function ensureLocalTeamIssueEventsTable(
  tableName: string,
  dynamoDbClient: DynamoDBClient,
) {
  return ensureLocalDynamoDbTable(
    tableName,
    dynamoDbClient,
    () =>
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [
          { AttributeName: 'directoryTeamIssueId', AttributeType: 'S' },
          { AttributeName: 'eventId', AttributeType: 'S' },
          { AttributeName: 'createdAt', AttributeType: 'S' },
          { AttributeName: 'commentCreatedAtOrder', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'directoryTeamIssueId', KeyType: 'HASH' },
          { AttributeName: 'eventId', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'TeamIssueEventCreatedAtIndex',
            KeySchema: [
              { AttributeName: 'directoryTeamIssueId', KeyType: 'HASH' },
              { AttributeName: 'createdAt', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
          {
            IndexName: 'TeamIssueCommentCreatedAtIndex',
            KeySchema: [
              { AttributeName: 'directoryTeamIssueId', KeyType: 'HASH' },
              { AttributeName: 'commentCreatedAtOrder', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    isTeamIssueEventsTableDescription,
    async (table) => {
      if (!hasKeySchema(table, [
        ['directoryTeamIssueId', 'HASH'],
        ['eventId', 'RANGE'],
      ])) {
        throw new Error(`Local DynamoDB table "${tableName}" does not match the expected schema.`)
      }
      const hasCreatedAtIndex = table?.GlobalSecondaryIndexes?.some((index) =>
        index.IndexName === 'TeamIssueEventCreatedAtIndex') ?? false
      const hasCommentCreatedAtIndex = table?.GlobalSecondaryIndexes?.some((index) =>
        index.IndexName === 'TeamIssueCommentCreatedAtIndex') ?? false
      if (hasCreatedAtIndex && hasCommentCreatedAtIndex) {
        return
      }
      if (!hasCreatedAtIndex) {
        await dynamoDbClient.send(new UpdateTableCommand({
          TableName: tableName,
          AttributeDefinitions: [
            { AttributeName: 'directoryTeamIssueId', AttributeType: 'S' },
            { AttributeName: 'createdAt', AttributeType: 'S' },
          ],
          GlobalSecondaryIndexUpdates: [{
            Create: {
              IndexName: 'TeamIssueEventCreatedAtIndex',
              KeySchema: [
                { AttributeName: 'directoryTeamIssueId', KeyType: 'HASH' },
                { AttributeName: 'createdAt', KeyType: 'RANGE' },
              ],
              Projection: { ProjectionType: 'ALL' },
            },
          }],
        }))
        return
      }
      await dynamoDbClient.send(new UpdateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [
          { AttributeName: 'directoryTeamIssueId', AttributeType: 'S' },
          { AttributeName: 'commentCreatedAtOrder', AttributeType: 'S' },
        ],
        GlobalSecondaryIndexUpdates: [{
          Create: {
            IndexName: 'TeamIssueCommentCreatedAtIndex',
            KeySchema: [
              { AttributeName: 'directoryTeamIssueId', KeyType: 'HASH' },
              { AttributeName: 'commentCreatedAtOrder', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        }],
      }))
    },
  )
}

async function ensureLocalDynamoDbTable(
  tableName: string,
  dynamoDbClient: DynamoDBClient,
  createCommand: () => CreateTableCommand,
  validateTable: (table: TableDescription | undefined) => boolean,
  migrateTable?: (table: TableDescription | undefined) => Promise<void>,
) {
  if (!shouldBootstrapLocalDynamoDb()) {
    return false
  }

  const initializerKey = `${getDynamoDbEndpoint()}#${tableName}`
  const existingInitializer = localDynamoDbTableInitializers.get(initializerKey)

  if (existingInitializer) {
    await existingInitializer
    return true
  }

  const initializer = createLocalDynamoDbTable(
    tableName,
    dynamoDbClient,
    createCommand,
    validateTable,
    migrateTable,
  )
    .finally(() => {
      localDynamoDbTableInitializers.delete(initializerKey)
    })

  localDynamoDbTableInitializers.set(initializerKey, initializer)
  await initializer

  return true
}

async function createLocalDynamoDbTable(
  tableName: string,
  dynamoDbClient: DynamoDBClient,
  createCommand: () => CreateTableCommand,
  validateTable: (table: TableDescription | undefined) => boolean,
  migrateTable?: (table: TableDescription | undefined) => Promise<void>,
) {
  try {
    await dynamoDbClient.send(createCommand())
  } catch (error) {
    if (!isResourceInUseError(error)) {
      throw error
    }
  }

  await waitForLocalDynamoDbTable(tableName, dynamoDbClient, validateTable, migrateTable)
}

async function waitForLocalDynamoDbTable(
  tableName: string,
  dynamoDbClient: DynamoDBClient,
  validateTable: (table: TableDescription | undefined) => boolean,
  migrateTable?: (table: TableDescription | undefined) => Promise<void>,
) {
  let migrationStarted = false
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await dynamoDbClient.send(
      new DescribeTableCommand({
        TableName: tableName,
      }),
    )

    if (response.Table?.TableStatus === 'ACTIVE' && validateTable(response.Table)) {
      return
    }

    if (response.Table?.TableStatus === 'ACTIVE') {
      if (migrateTable && !migrationStarted) {
        migrationStarted = true
        await migrateTable(response.Table)
        continue
      }
      throw new Error(`Local DynamoDB table "${tableName}" does not match the expected schema.`)
    }

    await sleep(100)
  }

  throw new Error(`Local DynamoDB table "${tableName}" did not become active.`)
}

function isTeamIssuesTableDescription(table: TableDescription | undefined) {
  return (
    hasKeySchema(table, [
      ['directoryTeamId', 'HASH'],
      ['issueId', 'RANGE'],
    ]) &&
    Boolean(
      table?.GlobalSecondaryIndexes?.some((index) =>
        index.IndexName === 'TeamIssueSortOrderIndex' &&
        hasKeySchema(index, [
          ['directoryTeamId', 'HASH'],
          ['sortOrder', 'RANGE'],
        ]),
      ),
    ) &&
    Boolean(
      table?.GlobalSecondaryIndexes?.some((index) =>
        index.IndexName === 'AssignedProjectIssueIndex' &&
        hasKeySchema(index, [
          ['directoryProjectId', 'HASH'],
          ['sortOrder', 'RANGE'],
        ]),
      ),
    ) &&
    Boolean(
      table?.GlobalSecondaryIndexes?.some((index) =>
        index.IndexName === 'TeamIssueUpdatedAtIndex' &&
        hasKeySchema(index, [
          ['directoryTeamId', 'HASH'],
          ['updatedAt', 'RANGE'],
        ]),
      ),
    )
  )
}

function isTeamIssueEventsTableDescription(table: TableDescription | undefined) {
  return hasKeySchema(table, [
    ['directoryTeamIssueId', 'HASH'],
    ['eventId', 'RANGE'],
  ]) && Boolean(
    table?.GlobalSecondaryIndexes?.some((index) =>
      index.IndexName === 'TeamIssueEventCreatedAtIndex' &&
      hasKeySchema(index, [
        ['directoryTeamIssueId', 'HASH'],
        ['createdAt', 'RANGE'],
      ]),
    ),
  ) && Boolean(
    table?.GlobalSecondaryIndexes?.some((index) =>
      index.IndexName === 'TeamIssueCommentCreatedAtIndex' &&
      hasKeySchema(index, [
        ['directoryTeamIssueId', 'HASH'],
        ['commentCreatedAtOrder', 'RANGE'],
      ]),
    ),
  )
}

function hasKeySchema(
  value: { KeySchema?: TableDescription['KeySchema'] } | undefined,
  expected: Array<[string, 'HASH' | 'RANGE']>,
) {
  return expected.every(([attributeName, keyType]) =>
    value?.KeySchema?.some((schema) =>
      schema.AttributeName === attributeName && schema.KeyType === keyType,
    ),
  )
}

function shouldBootstrapLocalDynamoDb() {
  return shouldBootstrapConfiguredLocalDynamoDb()
}

/** Returns whether an unknown AWS error indicates a missing resource. */
function isResourceNotFoundError(error: unknown) {
  return isAwsNamedError(error, 'ResourceNotFoundException')
}

function isResourceInUseError(error: unknown) {
  return isAwsNamedError(error, 'ResourceInUseException')
}

function isAwsNamedError(error: unknown, name: string) {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === name
}

function hasTransactionConditionalFailure(error: unknown) {
  if (!isAwsNamedError(error, 'TransactionCanceledException') || !isRecord(error)) {
    return false
  }

  const reasons = error.CancellationReasons

  if (!Array.isArray(reasons)) {
    return false
  }

  const reasonCodes = reasons.map((reason) => isRecord(reason) ? reason.Code : undefined)

  if (!reasonCodes.every((code) => code === 'None' || code === 'ConditionalCheckFailed')) {
    return false
  }

  return reasonCodes.includes('ConditionalCheckFailed')
}

function isTransactionConditionalFailureAt(error: unknown, index: number) {
  if (!hasTransactionConditionalFailure(error) || !isRecord(error)) {
    return false
  }

  const reasons = error.CancellationReasons

  return Array.isArray(reasons) &&
    isRecord(reasons[index]) &&
    reasons[index].Code === 'ConditionalCheckFailed'
}

/** Configuration ConditionCheck の transaction 内開始位置を返します。 */
function resolveConfigurationConditionStartIndex(
  precedingItemCount: number,
  auditPut: ReturnType<typeof createMutationAuditEventPut>,
) {
  return precedingItemCount + (auditPut === undefined ? 0 : 1)
}

function createProjectDataConflictError() {
  return new ProjectDataError(
    409,
    'ConditionalCheckFailedException',
    'The transaction condition failed.',
  )
}

function createWorkItemRevisionConflictError() {
  return new ProjectDataError(
    409,
    'WorkItemRevisionConflict',
    'Work Item revision does not match the expected revision.',
  )
}

function createWorkItemConfigurationRevisionConflictError() {
  return new ProjectDataError(
    409,
    'WorkItemConfigurationRevisionConflict',
    'Work Item configuration changed during the mutation.',
  )
}

/**
 * Creates the stable conflict returned when authorization changes during a mutation.
 *
 * @returns A Project Data conflict for a stale authorization snapshot.
 */
export function createWorkItemAuthorizationChangedError() {
  return new ProjectDataError(
    409,
    'WorkItemAuthorizationChanged',
    'Work Item authorization changed during the mutation.',
  )
}

function createWorkItemDeletionFenceConflictError(kind: WorkItemDeletionFenceKind) {
  return kind === 'external-links'
    ? new ProjectDataError(
        409,
        'ExternalWorkItemLinkConflict',
        'Unlink all external resources before deleting this Work Item.',
      )
    : new ProjectDataError(
        409,
        'WorkItemDocumentBacklinkConflict',
        'Unlink all Documents before deleting this Work Item.',
      )
}

function createWorkItemDeletionTransactionUnavailableError() {
  return new ProjectDataError(
    503,
    'WorkItemDeletionTransactionUnavailable',
    'The Work Item deletion transaction could not be classified safely. Retry the request.',
  )
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function toProjectDataError(error: unknown) {
  throwIfWorkspaceSearchWriterFenceTerminalError(error)
  const awsError = error as {
    $metadata?: {
      httpStatusCode?: number
    }
    message?: string
    name?: string
  }

  return new ProjectDataError(
    awsError.$metadata?.httpStatusCode ?? 502,
    awsError.name ?? 'DynamoDbUnavailable',
    awsError.message ?? 'DynamoDB request failed.',
  )
}

/**
 * Determines whether an unknown error represents a missing canonical Work Item.
 *
 * @param error - Error value caught at an application boundary.
 * @returns Whether the value has the stable Team Issue not-found status and code.
 */
export function isTeamIssueNotFoundError(error: unknown) {
  if (error instanceof ProjectDataError) {
    return error.status === 404 && error.code === 'TeamIssueNotFound'
  }

  return isRecord(error) && error.status === 404 && error.code === 'TeamIssueNotFound'
}

/**
 * Creates a de-identified Work Item-owned snapshot from a strongly read Triage Entry.
 *
 * Full source visibility permits only provider-secret-free lifecycle summaries. Metadata-only
 * visibility retains counts but no history summaries, while restricted or already-redacted
 * sources retain provenance timestamps with zero context counts.
 *
 * @param entry - Canonical Triage Entry observed immediately before duplicate resolution.
 * @param mergedAt - Canonical instant shared with the atomic duplicate transaction.
 * @returns A bounded snapshot safe to expose under canonical Work Item authorization.
 */
function createPermissionSafeTriageContextSnapshot(
  entry: TriageEntry,
  mergedAt: string,
): WorkItemTriageContextSnapshot {
  const retentionDeadline = Date.parse(entry.retention.expiresAt)
  const mergedAtTimestamp = Date.parse(mergedAt)
  const retentionElapsed = Number.isFinite(retentionDeadline) &&
    Number.isFinite(mergedAtTimestamp) &&
    retentionDeadline <= mergedAtTimestamp
  const redacted = entry.retention.redactedAt !== undefined || retentionElapsed
  const retainCounts = !redacted && entry.permission.visibility !== 'denied'
  const retainSummaries = !redacted && entry.permission.visibility === 'full'
  const events = retainSummaries
    ? createPermissionSafeTriageContextEvents(entry.events)
    : []
  const availability = redacted
    ? 'redacted'
    : entry.permission.visibility === 'denied'
      ? 'restricted'
      : retainSummaries
        ? 'summary-metadata'
        : 'counts-only'

  const effectiveRedactedAt = entry.retention.redactedAt ??
    (retentionElapsed ? entry.retention.expiresAt : undefined)
  const snapshot: WorkItemTriageContextSnapshot = {
    triageEntryId: readTriageContextEntryId(entry.id),
    sourceKind: entry.source.kind,
    visibilityAtMerge: entry.permission.visibility,
    availability,
    receivedAt: readTriageAcceptanceInstant(entry.receivedAt),
    lastActivityAt: readTriageAcceptanceInstant(entry.lastActivityAt),
    sourceRetentionExpiresAt: readTriageAcceptanceInstant(entry.retention.expiresAt),
    ...(effectiveRedactedAt
      ? { sourceRedactedAt: readTriageAcceptanceInstant(effectiveRedactedAt) }
      : {}),
    commentMetadataCount: retainCounts ? entry.sourcePreview.commentCount : 0,
    attachmentMetadataCount: retainCounts ? entry.sourcePreview.attachmentCount : 0,
    watcherMetadataCount: retainCounts ? entry.sourcePreview.watcherCount : 0,
    events,
    mergedAt,
  }
  if (!isWorkItemTriageContextSnapshot(snapshot)) {
    throw new ProjectDataError(
      409,
      'InvalidTriageDuplicateContext',
      'The permission-safe Triage context snapshot is invalid.',
    )
  }
  return snapshot
}

/** Fixed provider-neutral summaries retained for each allowed Triage lifecycle event type. */
const TRIAGE_CONTEXT_EVENT_SUMMARIES = {
  created: 'Triage entry was created.',
  assigned: 'Triage assignment changed.',
  accepted: 'Triage entry was accepted.',
  linked: 'Triage entry was linked to a Work Item.',
  duplicate: 'Triage entry was marked as duplicate.',
  declined: 'Triage entry was declined.',
  snoozed: 'Triage entry was snoozed.',
  'information-requested': 'More information was requested.',
  'activity-received': 'New source activity was received.',
  resurfaced: 'Triage entry resurfaced.',
  'sla-breached': 'Triage response SLA was breached.',
  escalated: 'Triage entry was escalated.',
  'retention-redacted': 'Triage source content was redacted.',
} satisfies Record<TriageEntryEvent['type'], string>

/** Creates only fixed-summary lifecycle snapshots without copying source-controlled text.
 *
 * @param events Canonical Triage lifecycle events observed before duplicate resolution.
 * @returns Provider-neutral history snapshots safe for canonical Work Item storage.
 */
function createPermissionSafeTriageContextEvents(
  events: readonly TriageEntryEvent[],
): WorkItemTriageContextEventSnapshot[] {
  return events.map((event) => ({
    eventId: event.id,
    type: event.type,
    summary: TRIAGE_CONTEXT_EVENT_SUMMARIES[event.type],
    createdAt: event.createdAt,
  }))
}

/**
 * Validates the broader provider-neutral Triage Entry identifier used by duplicate provenance.
 *
 * @param value - Strongly read Triage Entry identifier.
 * @returns The normalized identifier.
 */
function readTriageContextEntryId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)
  ) {
    throw new ProjectDataError(
      400,
      'InvalidProjectWrite',
      'Triage context Entry ID is invalid.',
    )
  }
  return value
}

/**
 * Parses a stored canonical Work Item into its public response representation.
 *
 * @param value - Untrusted DynamoDB item or replay payload.
 * @returns A validated Team Issue response item.
 */
export function toTeamIssueResponseItem(value: unknown): TeamIssueResponseItem {
  const item = toTeamIssueItem(value)
  const issue: TeamIssueResponseItem = {
    schemaVersion: item.schemaVersion,
    revision: item.revision,
    id: item.issueId,
    teamId: item.teamId,
    title: item.title,
    assigneeUserId: item.assigneeUserId,
    creatorMemberKey: item.creatorMemberKey,
    workflowSchemaVersion: item.workflowSchemaVersion,
    workflowStatusId: item.workflowStatusId,
    statusCategory: item.statusCategory,
    customFieldValues: item.customFieldValues,
    relationIds: item.relationIds,
    dueDate: item.dueDate,
    schedule: item.schedule,
    priority: item.priority,
    priorityUpdatedAt: item.priorityUpdatedAt ?? item.createdAt,
    dueDateUpdatedAt: item.dueDateUpdatedAt ?? item.createdAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    source: 'dynamodb',
  }

  if (item.sourceRequestId) {
    issue.sourceRequestId = item.sourceRequestId
  }

  if (item.sourceTriageEntryId) {
    issue.sourceTriageEntryId = item.sourceTriageEntryId
  }

  if (item.assignedProjectId) {
    issue.assignedProjectId = item.assignedProjectId
  }

  if (item.description) {
    issue.description = item.description
  }

  if (item.archivedAt) {
    issue.archivedAt = item.archivedAt
    issue.archivedBy = item.archivedBy
  }

  return issue
}

function toTeamIssueActivityResponseItem(value: TeamIssueEventItem): TeamIssueActivityResponseItem {
  return {
    id: value.eventId,
    type: value.eventType,
    actorUserId: value.actorUserId,
    summary: value.summary,
    createdAt: value.createdAt,
  }
}

/** Projects a legacy commented event into the stable Work Item detail comment shape. */
function toTeamIssueCommentResponseItem(value: TeamIssueEventItem): TeamIssueCommentResponseItem {
  return {
    id: value.eventId,
    actorUserId: value.actorUserId,
    body: value.body ?? '',
    createdAt: value.createdAt,
  }
}

function toTeamIssueItem(value: unknown): TeamIssueItem {
  if (!isCanonicalWorkItemRecord(value)) {
    throw new ProjectDataError(
      503,
      'InvalidTeamIssue',
      'Team issue item is missing or invalid.',
    )
  }

  return value
}

function toTeamIssueEventItem(value: unknown): TeamIssueEventItem {
  if (!isTeamIssueEventItem(value)) {
    throw new ProjectDataError(
      503,
      'InvalidTeamIssue',
      'Team issue event item is missing or invalid.',
    )
  }

  return value
}

function isTeamIssueEventItem(value: unknown): value is TeamIssueEventItem {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.directoryId === 'string' &&
    typeof value.teamId === 'string' &&
    typeof value.issueId === 'string' &&
    value.directoryTeamIssueId === createDirectoryTeamIssueId(
      value.directoryId,
      value.teamId,
      value.issueId,
    ) &&
    typeof value.eventId === 'string' &&
    isTeamIssueActivityType(value.eventType) &&
    typeof value.actorUserId === 'string' &&
    (value.body === undefined || typeof value.body === 'string') &&
    (value.eventType !== 'commented' ||
      (typeof value.body === 'string' && value.body.trim().length > 0)) &&
    hasCanonicalTriageContextSnapshot(value.eventType, value.triageContextSnapshot) &&
    typeof value.summary === 'string' &&
    typeof value.createdAt === 'string' &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    (value.commentCreatedAtOrder === undefined ||
      value.commentCreatedAtOrder === createTeamIssueCommentEventOrder(value.createdAt, value.eventId))
  )
}

/** Normalizes one newly stored Team Issue event timestamp for indexed ordering. */
function normalizeTeamIssueEventTimestamp(value: string): string {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    throw new ProjectDataError(
      500,
      'InvalidTeamIssue',
      'Team Issue event timestamp is invalid.',
    )
  }
  return new Date(parsed).toISOString()
}

/** Validates a persisted event timestamp without changing its index key representation. */
function validateTeamIssueEventTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new ProjectDataError(
      503,
      'InvalidTeamIssue',
      'Team Issue event timestamp is invalid.',
    )
  }
  return value
}

/** Requires the canonical sort key projected by the bounded comment index. */
function requireCommentCreatedAtOrder(value: TeamIssueEventItem): string {
  if (typeof value.commentCreatedAtOrder !== 'string' || value.commentCreatedAtOrder.length === 0) {
    throw new ProjectDataError(
      503,
      'InvalidTeamIssue',
      'Team Issue comment event item is missing its canonical index key.',
    )
  }
  return value.commentCreatedAtOrder
}

/** Validates one strongly read row that should be present in the sparse comment index. */
function readCommentEventIndexCoverageId(value: unknown): string {
  if (!isRecord(value) ||
      value.eventType !== 'commented' ||
      typeof value.eventId !== 'string' ||
      value.eventId.length === 0 ||
      typeof value.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(value.createdAt))) {
    throw new ProjectDataError(
      503,
      'InvalidTeamIssue',
      'Team Issue comment event item is missing or invalid.',
    )
  }
  return value.eventId
}

/** Compares two validated events by their actual timestamp and stable ID. */
function compareTeamIssueEvents(
  left: TeamIssueEventItem,
  right: TeamIssueEventItem,
  newestFirst: boolean,
): number {
  const leftTime = Date.parse(left.createdAt)
  const rightTime = Date.parse(right.createdAt)
  if (leftTime !== rightTime) {
    return newestFirst ? rightTime - leftTime : leftTime - rightTime
  }
  return newestFirst
    ? right.eventId.localeCompare(left.eventId)
    : left.eventId.localeCompare(right.eventId)
}

/** Compares two event ID sets without depending on their insertion order. */
function setsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false
  for (const value of left) {
    if (!right.has(value)) return false
  }
  return true
}

/** Finds the first item after a canonical-time event cursor. */
function findTeamIssueEventCursorStartIndex(
  items: TeamIssueEventItem[],
  cursor: Extract<TeamIssueEventCursor, { version: 2 }> | undefined,
  newestFirst: boolean,
): number {
  if (!cursor) return 0
  const exactIndex = items.findIndex((item) => item.eventId === cursor.eventId)
  if (exactIndex >= 0) return exactIndex + 1

  const cursorTime = Date.parse(cursor.createdAt)
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (!item) continue
    const itemTime = Date.parse(item.createdAt)
    const isAfterCursor = newestFirst
      ? itemTime < cursorTime ||
        (itemTime === cursorTime && item.eventId < cursor.eventId)
      : itemTime > cursorTime ||
        (itemTime === cursorTime && item.eventId > cursor.eventId)
    if (isAfterCursor) return index
  }
  return items.length
}

/**
 * Validates the optional duplicate-context payload and binds it to its dedicated event type.
 *
 * @param eventType - Stored Work Item event discriminator.
 * @param snapshot - Optional source-context payload.
 * @returns Whether the payload is absent for normal events or canonical for merge events.
 */
function hasCanonicalTriageContextSnapshot(
  eventType: TeamIssueActivityType,
  snapshot: unknown,
): snapshot is WorkItemTriageContextSnapshot | undefined {
  return eventType === 'triage-context-merged'
    ? isWorkItemTriageContextSnapshot(snapshot)
    : snapshot === undefined
}

/**
 * Validates a de-identified duplicate-context snapshot before returning it from a Work Item read.
 *
 * Exact key allowlists prevent unknown persisted fields from becoming an accidental data leak.
 *
 * @param value - Untrusted event payload read from DynamoDB.
 * @returns Whether the payload is a canonical permission-safe snapshot.
 */
function isWorkItemTriageContextSnapshot(value: unknown): value is WorkItemTriageContextSnapshot {
  if (!isRecord(value) || !Object.keys(value).every((key) =>
    key === 'triageEntryId' ||
    key === 'sourceKind' ||
    key === 'visibilityAtMerge' ||
    key === 'availability' ||
    key === 'receivedAt' ||
    key === 'lastActivityAt' ||
    key === 'sourceRetentionExpiresAt' ||
    key === 'sourceRedactedAt' ||
    key === 'commentMetadataCount' ||
    key === 'attachmentMetadataCount' ||
    key === 'watcherMetadataCount' ||
    key === 'events' ||
    key === 'mergedAt'
  )) {
    return false
  }
  const receivedAt = readCanonicalContextInstant(value.receivedAt)
  const lastActivityAt = readCanonicalContextInstant(value.lastActivityAt)
  const mergedAt = readCanonicalContextInstant(value.mergedAt)
  const sourceRedactedAt = value.sourceRedactedAt === undefined
    ? undefined
    : readCanonicalContextInstant(value.sourceRedactedAt)
  if (!receivedAt || !lastActivityAt || !mergedAt) return false
  if (Date.parse(receivedAt) > Date.parse(lastActivityAt) ||
      Date.parse(lastActivityAt) > Date.parse(mergedAt)) return false
  if (
    (value.sourceRedactedAt !== undefined && !sourceRedactedAt) ||
    (sourceRedactedAt !== undefined && Date.parse(sourceRedactedAt) > Date.parse(mergedAt))
  ) {
    return false
  }
  if (
    typeof value.triageEntryId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value.triageEntryId) ||
    !isTriageContextSourceKind(value.sourceKind) ||
    !isTriageContextVisibility(value.visibilityAtMerge) ||
    !isTriageContextAvailability(value.availability) ||
    !readCanonicalContextInstant(value.sourceRetentionExpiresAt) ||
    !isNonnegativeSafeInteger(value.commentMetadataCount) ||
    !isNonnegativeSafeInteger(value.attachmentMetadataCount) ||
    !isNonnegativeSafeInteger(value.watcherMetadataCount) ||
    !Array.isArray(value.events) ||
    value.events.length > 100 ||
    !value.events.every(isWorkItemTriageContextEventSnapshot) ||
    value.events.some((event) => Date.parse(event.createdAt) > Date.parse(mergedAt))
  ) {
    return false
  }
  if (value.availability === 'summary-metadata') {
    return value.visibilityAtMerge === 'full' && sourceRedactedAt === undefined
  }
  if (value.events.length > 0) return false
  if (value.availability === 'counts-only') {
    return value.visibilityAtMerge === 'metadata-only' && sourceRedactedAt === undefined
  }
  if (value.availability === 'restricted') {
    return value.visibilityAtMerge === 'denied' && sourceRedactedAt === undefined &&
      hasNoTriageContextCounts(value)
  }
  return sourceRedactedAt !== undefined && hasNoTriageContextCounts(value)
}

/**
 * Validates one allowlisted lifecycle summary embedded in a duplicate-context snapshot.
 *
 * @param value - Untrusted nested event payload.
 * @returns Whether the event contains only the provider-secret-free summary contract.
 */
function isWorkItemTriageContextEventSnapshot(
  value: unknown,
): value is WorkItemTriageContextEventSnapshot {
  return isRecord(value) &&
    Object.keys(value).every((key) =>
      key === 'eventId' || key === 'type' || key === 'summary' || key === 'createdAt'
    ) &&
    typeof value.eventId === 'string' && value.eventId.length > 0 && value.eventId.length <= 200 &&
    isTriageContextEventType(value.type) &&
    typeof value.summary === 'string' && value.summary.length > 0 && value.summary.length <= 2_000 &&
    readCanonicalContextInstant(value.createdAt) !== undefined
}

/** Returns whether all de-identified context counts are zero. */
function hasNoTriageContextCounts(
  value: Record<string, unknown>,
): boolean {
  return value.commentMetadataCount === 0 &&
    value.attachmentMetadataCount === 0 &&
    value.watcherMetadataCount === 0
}

/** Returns a canonical ISO instant or undefined for malformed input. */
function readCanonicalContextInstant(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const instant = new Date(value)
  return Number.isFinite(instant.getTime()) && instant.toISOString() === value
    ? value
    : undefined
}

/** Returns whether an unknown value is a supported Triage source kind. */
function isTriageContextSourceKind(value: unknown): boolean {
  return value === 'form' || value === 'chat' || value === 'email' ||
    value === 'webhook' || value === 'manual-handoff'
}

/** Returns whether an unknown value is a source visibility state. */
function isTriageContextVisibility(value: unknown): boolean {
  return value === 'full' || value === 'metadata-only' || value === 'denied'
}

/** Returns whether an unknown value is a retained-context availability state. */
function isTriageContextAvailability(value: unknown): boolean {
  return value === 'summary-metadata' || value === 'counts-only' ||
    value === 'restricted' || value === 'redacted'
}

/** Returns whether an unknown value is a provider-neutral Triage lifecycle event type. */
function isTriageContextEventType(value: unknown): boolean {
  return value === 'created' || value === 'assigned' || value === 'accepted' ||
    value === 'linked' || value === 'duplicate' || value === 'declined' ||
    value === 'snoozed' || value === 'information-requested' ||
    value === 'activity-received' || value === 'resurfaced' ||
    value === 'sla-breached' || value === 'escalated' ||
    value === 'retention-redacted'
}

/** Returns whether an unknown value is a nonnegative integer safe for JSON and DynamoDB. */
function isNonnegativeSafeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isWorkflowStatusCategory(value: unknown): value is WorkflowStatusCategory {
  return value === 'backlog' ||
    value === 'unstarted' ||
    value === 'started' ||
    value === 'completed' ||
    value === 'canceled'
}

function isCustomFieldValueRecord(value: unknown): value is Record<string, CustomFieldValue> {
  return isRecord(value) && Object.values(value).every((fieldValue) =>
    typeof fieldValue === 'string' ||
    typeof fieldValue === 'number' ||
    typeof fieldValue === 'boolean' ||
    (
      Array.isArray(fieldValue) &&
      fieldValue.every((entry) => typeof entry === 'string')
    )
  )
}

/** Returns whether an unknown value is a supported canonical Work Item priority. */
function isWorkItemPriority(value: unknown): value is WorkItemPriority {
  return value === 'high' || value === 'medium' || value === 'low'
}

function isTeamIssueActivityType(value: unknown): value is TeamIssueActivityType {
  return value === 'created' || value === 'updated' || value === 'commented' ||
    value === 'triage-context-merged'
}

/**
 * Reads a required trimmed string from an untrusted Work Item input.
 *
 * @param value - Untrusted input value.
 * @param message - Validation message returned when the value is invalid.
 * @returns The normalized non-empty string.
 */
export function readRequiredString(value: unknown, message: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', message)
  }

  return value.trim()
}

/**
 * Reads and normalizes an explicit canonical schedule.
 *
 * @param scheduleValue - Untrusted canonical schedule candidate.
 * @returns A normalized canonical schedule whose dates use `YYYY-MM-DD`.
 */
function readWorkItemScheduleInput(
  scheduleValue: unknown,
): WorkItemSchedule {
  try {
    return normalizeWorkItemSchedule(scheduleValue)
  } catch (error) {
    if (error instanceof WorkItemScheduleError) {
      throw new ProjectDataError(400, error.code, error.message)
    }
    throw error
  }
}

/**
 * Reads a positive expected Work Item revision used for optimistic concurrency.
 *
 * @param value - Untrusted revision value.
 * @returns A validated positive safe integer revision.
 */
export function readWorkItemExpectedRevision(value: unknown) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value >= Number.MAX_SAFE_INTEGER
  ) {
    throw new ProjectDataError(
      400,
      'InvalidWorkItemRevision',
      'Work Item expected revision is required.',
    )
  }

  return value
}

/** Reads and validates the optional canonical Work Item priority input. */
function readWorkItemPriority(value: unknown): WorkItemPriority {
  if (value === undefined) {
    return 'medium'
  }

  if (!isWorkItemPriority(value)) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Work Item priority is invalid.')
  }

  return value
}

function readWorkflowSchemaVersion(value: unknown) {
  if (value === WORK_ITEM_CONFIGURATION_SCHEMA_VERSION) {
    return WORK_ITEM_CONFIGURATION_SCHEMA_VERSION
  }

  throw new ProjectDataError(
    400,
    'InvalidWorkItemConfiguration',
    'Workflow schema version is invalid.',
  )
}

function readWorkflowStatusId(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) {
    throw new ProjectDataError(
      400,
      'InvalidWorkItemConfiguration',
      'Workflow status ID is invalid.',
    )
  }

  return value.trim()
}

function readWorkflowStatusCategory(value: unknown) {
  if (!isWorkflowStatusCategory(value)) {
    throw new ProjectDataError(
      400,
      'InvalidWorkItemConfiguration',
      'Workflow status category is invalid.',
    )
  }

  return value
}

function readCustomFieldValues(value: unknown): Record<string, CustomFieldValue> {
  if (!isCustomFieldValueRecord(value)) {
    throw new ProjectDataError(
      400,
      'InvalidCustomFieldValue',
      'Custom field values are invalid.',
    )
  }

  return { ...value }
}

/**
 * Compares two canonical custom-field records without relying on key insertion order.
 *
 * @param first - First custom-field record.
 * @param second - Second custom-field record.
 * @returns Whether both records contain identical scalar and array values.
 */
export function customFieldValueRecordsEqual(
  first: Readonly<Record<string, CustomFieldValue>>,
  second: Readonly<Record<string, CustomFieldValue>>,
) {
  const firstKeys = Object.keys(first).sort()
  const secondKeys = Object.keys(second).sort()
  if (firstKeys.length !== secondKeys.length) {
    return false
  }
  return firstKeys.every((key, index) => {
    if (key !== secondKeys[index]) {
      return false
    }
    const firstValue = first[key]
    const secondValue = second[key]
    return Array.isArray(firstValue) && Array.isArray(secondValue)
      ? firstValue.length === secondValue.length &&
        firstValue.every((value, valueIndex) => value === secondValue[valueIndex])
      : firstValue === secondValue
  })
}

/**
 * Reads the optional Project assignment from an untrusted mutation body.
 *
 * @param value - Untrusted assignment value.
 * @returns A normalized Project ID, null for removal, or undefined when omitted.
 */
export function readAssignedProjectId(value: unknown) {
  if (value === undefined) {
    return undefined
  }

  if (value === null) {
    return null
  }

  if (typeof value !== 'string') {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Assigned project is invalid.')
  }

  const assignedProjectId = value.trim()

  return assignedProjectId || null
}

function readSourceRequestId(value: unknown) {
  if (value === undefined) {
    return undefined
  }

  if (
    typeof value !== 'string' ||
    !/^req_[A-Za-z0-9_-]{12,160}$/u.test(value.trim())
  ) {
    throw new ProjectDataError(
      400,
      'InvalidProjectWrite',
      'Source request ID is invalid.',
    )
  }

  return value.trim()
}

/**
 * Validates the source Triage Entry identifier persisted on a canonical Work Item.
 *
 * @param value - Candidate Entry identifier supplied by trusted Triage composition.
 * @returns The normalized identifier.
 */
function readSourceTriageEntryId(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]{12,200}$/u.test(value.trim())
  ) {
    throw new ProjectDataError(
      400,
      'InvalidProjectWrite',
      'Source Triage Entry ID is invalid.',
    )
  }

  return value.trim()
}

/**
 * Validates the mutation instant shared by Triage and canonical Work Item writes.
 *
 * @param value - Candidate ISO 8601 instant supplied by trusted composition.
 * @returns The exact canonical UTC instant.
 */
function readTriageAcceptanceInstant(value: unknown) {
  if (typeof value !== 'string') {
    throw new ProjectDataError(
      400,
      'InvalidProjectWrite',
      'Triage acceptance time is invalid.',
    )
  }
  const instant = new Date(value)
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== value) {
    throw new ProjectDataError(
      400,
      'InvalidProjectWrite',
      'Triage acceptance time is invalid.',
    )
  }
  return value
}

/**
 * Reads an optional client-selected resource ID used by idempotent creation.
 *
 * @param value - Untrusted resource identifier.
 * @returns The validated identifier or undefined when omitted.
 */
export function readIdempotencyResourceId(value: unknown) {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
  ) {
    throw new ProjectDataError(
      400,
      'InvalidProjectWrite',
      'Idempotency resource ID is invalid.',
    )
  }
  return value
}

function isMatchingIdempotentWorkItemCreate(
  issue: TeamIssueResponseItem,
  expected: {
    actorUserId: string
    assigneeUserId: string
    assignedProjectId: string | null | undefined
    customFieldValues: Record<string, CustomFieldValue>
    description: string | undefined
    dueDate: string
    schedule: WorkItemSchedule
    priority: WorkItemPriority
    statusCategory: WorkflowStatusCategory
    title: string
    workflowSchemaVersion: typeof WORK_ITEM_CONFIGURATION_SCHEMA_VERSION
    workflowStatusId: string
  },
) {
  return issue.creatorMemberKey === expected.actorUserId &&
    issue.assigneeUserId === expected.assigneeUserId &&
    issue.assignedProjectId === (expected.assignedProjectId ?? undefined) &&
    customFieldValueRecordsEqual(issue.customFieldValues, expected.customFieldValues) &&
    issue.description === expected.description &&
    issue.dueDate === expected.dueDate &&
    workItemSchedulesEqual(issue.schedule, expected.schedule) &&
    issue.priority === expected.priority &&
    issue.statusCategory === expected.statusCategory &&
    issue.title === expected.title &&
    issue.workflowSchemaVersion === expected.workflowSchemaVersion &&
    issue.workflowStatusId === expected.workflowStatusId
}

/**
 * Compares schedule values after rebuilding their deterministic canonical representation.
 *
 * @param left - First normalized schedule.
 * @param right - Second normalized schedule.
 * @returns Whether both schedules serialize to the same canonical JSON value.
 */
function workItemSchedulesEqual(
  left: WorkItemSchedule,
  right: WorkItemSchedule,
): boolean {
  return JSON.stringify(normalizeWorkItemSchedule(left)) ===
    JSON.stringify(normalizeWorkItemSchedule(right))
}

function readOptionalString(value: unknown, message: string) {
  if (value === undefined) {
    return undefined
  }

  if (value === null) {
    return ''
  }

  if (typeof value !== 'string') {
    throw new ProjectDataError(400, 'InvalidProjectWrite', message)
  }

  return value.trim()
}

/**
 * Reads and normalizes the required assignee identity from a Work Item mutation.
 *
 * @param input - Create or update mutation body.
 * @returns The canonical Cognito user identifier.
 */
export function readTeamIssueAssigneeUserId(input: CreateTeamIssueRequestBody | UpdateTeamIssueRequestBody) {
  const value = input.assigneeUserId

  if (typeof value !== 'string' || !value.trim()) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Issue assignee is required.')
  }

  return normalizeCognitoUserId(value)
}

/**
 * Reads a required trimmed Work Item comment body.
 *
 * @param value - Untrusted comment body value.
 * @returns The normalized non-empty comment body.
 */
export function readRequiredCommentBody(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Issue comment body is required.')
  }

  return value.trim()
}

function createUniqueResourceId(value: string, existingIds: Iterable<string>) {
  const baseId = createResourceId(value)
  const usedIds = new Set(existingIds)

  if (!usedIds.has(baseId)) {
    return baseId
  }

  let suffix = 2

  while (usedIds.has(`${baseId}-${suffix}`)) {
    suffix += 1
  }

  return `${baseId}-${suffix}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function createDirectoryTeamId(directoryId: string, teamId: string) {
  return `${directoryId}#team#${teamId}`
}

function createDirectoryTeamIssueId(directoryId: string, teamId: string, issueId: string) {
  return `${createDirectoryTeamId(directoryId, teamId)}#issue#${issueId}`
}

/** Public Work Item page の DynamoDB key を store-local cursor に変換します。 */
function encodePublicWorkItemPageCursor(
  key: Record<string, unknown>,
  directoryTeamId: string,
) {
  const updatedAt = typeof key.updatedAt === 'string' ? key.updatedAt : undefined
  const issueId = typeof key.issueId === 'string' ? key.issueId : undefined
  if (key.directoryTeamId !== directoryTeamId || !updatedAt || !issueId) {
    throw new ProjectDataError(
      503,
      'InvalidWorkItemPageCursor',
      'Work Item page did not include a valid continuation key.',
    )
  }
  const cursor: PublicWorkItemPageCursor = {
    version: 1,
    directoryTeamId,
    updatedAt,
    issueId,
  }
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/** Public Work Item store cursor を検証し DynamoDB key に戻します。 */
function decodePublicWorkItemPageCursor(
  value: string | undefined,
  directoryTeamId: string,
) {
  if (!value) return undefined
  try {
    const cursor = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<PublicWorkItemPageCursor>
    if (
      cursor.version !== 1 ||
      cursor.directoryTeamId !== directoryTeamId ||
      typeof cursor.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(cursor.updatedAt)) ||
      typeof cursor.issueId !== 'string' ||
      !cursor.issueId
    ) {
      throw new TypeError('Invalid cursor payload.')
    }
    return {
      directoryTeamId,
      updatedAt: cursor.updatedAt,
      issueId: cursor.issueId,
    }
  } catch {
    throw new ProjectDataError(
      400,
      'InvalidWorkItemPageCursor',
      'Work Item page cursor is invalid.',
    )
  }
}

/** Team Issue event の DynamoDB key を scope-bound opaque cursor に変換します。 */
function encodeTeamIssueEventCursor(
  directoryTeamIssueId: string,
  key: Record<string, unknown>,
  useCreatedAtIndex: boolean,
) {
  const eventId = typeof key.eventId === 'string' ? key.eventId : undefined
  if (!eventId) {
    throw new ProjectDataError(
      503,
      'InvalidTeamIssue',
      'Team Issue event page did not include a valid continuation key.',
    )
  }

  const createdAt = typeof key.createdAt === 'string'
    ? validateTeamIssueEventTimestamp(key.createdAt)
    : undefined
  let cursor: TeamIssueEventCursor
  if (useCreatedAtIndex) {
    if (createdAt === undefined) {
      throw new ProjectDataError(
        503,
        'InvalidTeamIssue',
        'Team Issue event createdAt index page did not include a valid continuation key.',
      )
    }
    cursor = {
      version: 2,
      index: 'createdAt',
      directoryTeamIssueId,
      eventId,
      createdAt,
    }
  } else {
    cursor = {
      version: 1,
      directoryTeamIssueId,
      eventId,
    }
  }
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/** Encodes a scope-bound cursor for the canonical comment-time index. */
function encodeTeamIssueCommentCursor(
  directoryTeamIssueId: string,
  key: { eventId: string; commentCreatedAtOrder: string },
) {
  if (!key.eventId || !key.commentCreatedAtOrder) {
    throw new ProjectDataError(
      503,
      'InvalidTeamIssue',
      'Team Issue comment index page did not include a valid continuation key.',
    )
  }
  const cursor: Extract<TeamIssueEventCursor, { version: 3 }> = {
    version: 3,
    index: 'commentCreatedAt',
    directoryTeamIssueId,
    eventId: key.eventId,
    commentCreatedAtOrder: key.commentCreatedAtOrder,
  }
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/** Team Issue event cursor を検証し DynamoDB key に戻します。 */
function decodeTeamIssueEventCursor(
  value: string | undefined,
  directoryTeamIssueId: string,
) {
  if (!value) return undefined

  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    )
    if (!isTeamIssueEventCursor(parsed) || parsed.directoryTeamIssueId !== directoryTeamIssueId) {
      throw new TypeError('Invalid cursor payload.')
    }
    return parsed
  } catch {
    throw new ProjectDataError(
      400,
      'InvalidTeamIssueCursor',
      'Team Issue event cursor is invalid.',
    )
  }
}

/** Validates the untrusted payload embedded in a Team Issue event cursor. */
function isTeamIssueEventCursor(value: unknown): value is TeamIssueEventCursor {
  if (!isRecord(value) ||
    typeof value.directoryTeamIssueId !== 'string' ||
    typeof value.eventId !== 'string' ||
    value.eventId.length === 0) {
    return false
  }
  if (value.version === 1) {
    return true
  }
  if (value.version === 2) {
    return value.index === 'createdAt' &&
      typeof value.createdAt === 'string' &&
      Number.isFinite(Date.parse(value.createdAt))
  }
  return value.version === 3 &&
    value.index === 'commentCreatedAt' &&
    typeof value.commentCreatedAtOrder === 'string' &&
    value.commentCreatedAtOrder.length > 0
}
/**
 * Team-local Issue ID を Workspace 内で一意な audit Work Item ID に変換します。
 */
export function createTeamIssueAuditEntityId(teamId: string, issueId: string) {
  return `team/${teamId}/issue/${issueId}`
}

/**
 * Team Issue 一覧 route で指定 Work Item を直接開く deep link を作成します。
 */
export function createTeamIssueDeepLink(teamId: string, issueId: string) {
  return `/teams/${encodeURIComponent(teamId)}/issues?${new URLSearchParams({ issueId }).toString()}`
}

/**
 * Work Item の担当・状態・期限変更から通知対象と理由を組み立てます。
 */
function createWorkItemNotificationCandidates(
  before: TeamIssueItem,
  after: TeamIssueItem,
) {
  const candidates: Array<{ memberKey: string; reason: string }> = []

  if (before.assigneeUserId !== after.assigneeUserId) {
    candidates.push({ memberKey: after.assigneeUserId, reason: 'assignment' })
  }

  if (before.workflowStatusId !== after.workflowStatusId) {
    candidates.push({ memberKey: after.assigneeUserId, reason: 'status-change' })
  }

  if (!workItemSchedulesEqual(before.schedule, after.schedule)) {
    candidates.push({ memberKey: after.assigneeUserId, reason: 'schedule-change' })
  }

  if (before.archivedAt !== after.archivedAt) {
    candidates.push({ memberKey: after.assigneeUserId, reason: 'archive-change' })
  }

  return candidates
}

/**
 * Work Item 更新通知と activity に使う最も具体的な概要を選びます。
 */
function createWorkItemNotificationSummary(before: TeamIssueItem, after: TeamIssueItem) {
  if (before.archivedAt !== after.archivedAt) {
    return after.archivedAt ? 'Work Item was archived.' : 'Work Item was restored.'
  }

  if (before.assigneeUserId !== after.assigneeUserId) {
    return 'Work Item assignment changed.'
  }

  if (before.workflowStatusId !== after.workflowStatusId) {
    return 'Work Item status changed.'
  }

  if (!workItemSchedulesEqual(before.schedule, after.schedule)) {
    return 'Work Item schedule changed.'
  }

  return 'Work Item was updated.'
}

function createTeamIssueEventId(createdAt: string, eventType: TeamIssueActivityType) {
  return `${createdAt}#${eventType}#${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Creates the canonical chronological sort key for one legacy or new comment event.
 *
 * @param createdAt - Event timestamp accepted by the Work Item event schema.
 * @param eventId - Stable event identifier used to break timestamp ties.
 * @returns UTC timestamp and event ID in lexicographically chronological order.
 */
export function createTeamIssueCommentEventOrder(createdAt: string, eventId: string): string {
  return `${normalizeTeamIssueEventTimestamp(createdAt)}#${eventId}`
}

/**
 * Creates a v2 cursor after one legacy comment event.
 *
 * @param directoryId - Workspace directory identifier.
 * @param teamId - Owning Team identifier.
 * @param issueId - Team-local Work Item identifier.
 * @param eventId - Stable legacy event identifier.
 * @param createdAt - Event timestamp used for chronological continuation.
 * @returns Scope-bound opaque comment cursor.
 */
export function createTeamIssueCommentEventCursor(
  directoryId: string,
  teamId: string,
  issueId: string,
  eventId: string,
  createdAt: string,
) {
  return encodeTeamIssueEventCursor(
    createDirectoryTeamIssueId(directoryId, teamId, issueId),
    { eventId, createdAt },
    true,
  )
}

function getDynamoDbEndpoint() {
  return loadServerConfig().dynamoDbEndpoint
}

function getEnv(name: string) {
  return loadServerConfig().environment[name]
}
