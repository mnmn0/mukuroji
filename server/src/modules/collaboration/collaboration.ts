import { createHash, randomUUID } from 'node:crypto'
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  type TableDescription,
} from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  createDynamoDbClient as createConfiguredDynamoDbClient,
  createWorkspaceSearchWriterDynamoDbDocumentClient,
  shouldBootstrapLocalDynamoDb as shouldBootstrapConfiguredLocalDynamoDb,
} from '../../infrastructure/aws/dynamodb-client'
import {
  throwIfWorkspaceSearchWriterFenceTerminalError,
} from '../../infrastructure/runtime/workspace-search-writer-fence-document-client'
import {
  createAuditFieldChanges,
  createMutationAuditEventPut,
  getConfiguredAuditTableName,
  type MutationAuditContext,
} from '../audit'

/** Comment 本文に保存できる文字数です。 */
export const COLLABORATION_COMMENT_MAX_LENGTH = 20_000

/** 一つの comment で解決できる mention 数です。 */
export const COLLABORATION_MENTION_MAX_COUNT = 20

/** UI と API が受け付ける reaction emoji です。 */
export const COLLABORATION_REACTIONS = ['👍', '❤️', '🎉', '👀', '✅'] as const

/** 保存できる reaction emoji です。 */
export type CollaborationReactionEmoji = typeof COLLABORATION_REACTIONS[number]

/** 自動または手動で watcher になった理由です。 */
export type CollaborationWatcherReason =
  | 'manual'
  | 'creator'
  | 'assignee'
  | 'comment'
  | 'mention'
  | 'reply'

/** Notification projection に渡す recipient 候補です。 */
export type CollaborationNotificationCandidate = {
  /** Workspace member の安定した key です。 */
  memberKey: string
  /** mention、watcher、reply などの通知理由です。 */
  reason: string
}

/** Comment mutation と同時に保存する自動 watcher 候補です。 */
export type CollaborationAutomaticWatcherCandidate = {
  /** Workspace member の安定した key です。 */
  memberKey: string
  /** creator、assignee、mention などの自動購読理由です。 */
  reason: CollaborationWatcherReason
}

/** Comment に付いた reaction の集計です。 */
export type CollaborationReactionSummary = {
  /** 集計対象の emoji です。 */
  emoji: CollaborationReactionEmoji
  /** 同じ emoji を付けた member 数です。 */
  count: number
  /** 現在の viewer が reaction 済みかどうかです。 */
  reactedByMe: boolean
}

/** API へ返す collaboration comment snapshot です。 */
export type CollaborationComment = {
  /** Comment ID です。 */
  id: string
  /** Thread の root comment ID です。 */
  rootCommentId: string
  /** Reply 先 comment ID です。 */
  parentCommentId?: string
  /** Comment 作成者の Workspace member key です。 */
  authorMemberKey: string
  /** Markdown source の本文です。 */
  bodyMarkdown: string
  /** Optimistic concurrency に使う version です。 */
  version: number
  /** 本文中で mention された member key です。 */
  mentionMemberKeys: string[]
  /** Comment の作成日時です。 */
  createdAt: string
  /** Comment の最終更新日時です。 */
  updatedAt: string
  /** 本文が編集された日時です。 */
  editedAt?: string
  /** Soft delete された日時です。 */
  deletedAt?: string
  /** Thread が resolve された日時です。 */
  resolvedAt?: string
  /** Thread を resolve した member key です。 */
  resolvedByMemberKey?: string
  /** Reaction の集計です。 */
  reactions: CollaborationReactionSummary[]
}

/** 現在 user の watcher 状態です。 */
export type CollaborationWatcherState = {
  /** 現在有効な watcher かどうかです。 */
  subscribed: boolean
  /** 手動 subscribe/unsubscribe が保存されているかどうかです。 */
  explicit: boolean
  /** 自動 watch 理由があるかどうかです。 */
  automatic: boolean
  /** 現在 user の watch 理由です。 */
  reasons: string[]
  /** Scope を watch している一意 user 数です。 */
  watcherCount: number
  /** Assigned project を現在 user が watch しているかどうかです。 */
  projectSubscribed?: boolean
  /** Assigned project の watcher 数です。 */
  projectWatcherCount?: number
}

/** Work Item を開いている browser session の集約です。 */
export type CollaborationPresence = {
  /** Workspace member key です。 */
  memberKey: string
  /** Comment を入力中かどうかです。 */
  typing: boolean
  /** 最新 heartbeat の日時です。 */
  lastSeenAt: string
}

/** Cursor 付き comment thread page です。 */
export type CollaborationThreadPage = {
  /** Root comments または一つの root に属する replies です。 */
  comments: CollaborationComment[]
  /** 次 page 取得用の opaque cursor です。 */
  nextCursor?: string
  /** 現在 user の watcher 状態です。 */
  watch: CollaborationWatcherState
  /** 有効な presence 一覧です。 */
  presence: CollaborationPresence[]
  /** Reply page の root thread が解決済みかどうかです。 */
  threadResolved?: boolean
}

/** Team-owned Work Item scope の共通入力です。 */
export type WorkItemCollaborationScope = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** Team ID です。 */
  teamId: string
  /** Issue ID です。 */
  issueId: string
  /** Notification の件名に使う Work Item title です。 */
  workItemTitle?: string
  /** Work Item の collaboration entity key です。 */
  entityKey: string
  /** Assigned project ID です。 */
  projectId?: string
  /** Assigned project の collaboration entity key です。 */
  projectEntityKey?: string
  /** Resolve/reopen 認可時に読み込んだ Work Item assignee key です。 */
  assigneeMemberKey?: string
}

/** Thread page 取得入力です。 */
export type GetCollaborationThreadInput = {
  /** Collaboration entity key です。 */
  entityKey: string
  /** Reaction と watcher を現在 user 用に射影する member key です。 */
  viewerMemberKey: string
  /** Reply page を取得する root comment ID です。 */
  rootCommentId?: string
  /** 一 page の最大件数です。 */
  limit?: number
  /** 前 page が返した opaque cursor です。 */
  cursor?: string
  /** Assigned project の watcher scope です。 */
  projectEntityKey?: string
  /** Watcher/presence を同時に返すかどうかです。内部 preview 取得では false にします。 */
  includeScopeState?: boolean
}

/** Search projection の再検証に使う comment snapshot 読み込み入力です。 */
export type GetCollaborationCommentSnapshotInput = {
  /** Work Item の collaboration entity key です。 */
  entityKey: string
  /** 読み込む Comment ID です。 */
  commentId: string
}

/** Comment 作成入力です。 */
export type CreateCollaborationCommentInput = WorkItemCollaborationScope & {
  /** Comment を作成する Workspace member key です。 */
  actorMemberKey: string
  /** Markdown source の本文です。 */
  bodyMarkdown: string
  /** Reply 先 comment ID です。 */
  parentCommentId?: string
  /** 解決済み mention member keys です。 */
  mentionMemberKeys?: string[]
  /** Caller が追加する notification 候補です。 */
  notificationCandidates?: CollaborationNotificationCandidate[]
  /** Work Item creator/assignee など caller が解決した自動 watcher 候補です。 */
  automaticWatcherCandidates?: CollaborationAutomaticWatcherCandidate[]
  /** Notification から戻る Web path です。 */
  deepLink?: string
  /** State と同じ transaction に保存する audit context です。 */
  auditContext?: MutationAuditContext
}

/** Comment 本文更新入力です。 */
export type UpdateCollaborationCommentInput = WorkItemCollaborationScope & {
  /** Mutation actor の Workspace member key です。 */
  actorMemberKey: string
  /** 更新対象 comment ID です。 */
  commentId: string
  /** 更新後の Markdown source です。 */
  bodyMarkdown: string
  /** 更新後の mention member keys です。 */
  mentionMemberKeys?: string[]
  /** 読み込み時点の comment version です。 */
  expectedVersion: number
  /** Caller が追加する notification 候補です。 */
  notificationCandidates?: CollaborationNotificationCandidate[]
  /** Work Item creator/assignee など caller が解決した自動 watcher 候補です。 */
  automaticWatcherCandidates?: CollaborationAutomaticWatcherCandidate[]
  /** Notification から戻る Web path です。 */
  deepLink?: string
  /** State と同じ transaction に保存する audit context です。 */
  auditContext?: MutationAuditContext
}

/** Comment delete 入力です。 */
export type DeleteCollaborationCommentInput = WorkItemCollaborationScope & {
  /** Mutation actor の Workspace member key です。 */
  actorMemberKey: string
  /** Soft delete 対象 comment ID です。 */
  commentId: string
  /** 読み込み時点の comment version です。 */
  expectedVersion: number
  /** Author 以外の moderation delete を許可するかどうかです。 */
  canModerate?: boolean
  /** State と同じ transaction に保存する audit context です。 */
  auditContext?: MutationAuditContext
}

/** Comment resolve/reopen 入力です。 */
export type ResolveCollaborationCommentInput = WorkItemCollaborationScope & {
  /** Mutation actor の Workspace member key です。 */
  actorMemberKey: string
  /** Root comment ID です。 */
  commentId: string
  /** 読み込み時点の comment version です。 */
  expectedVersion: number
  /** Author 以外の resolve/reopen を許可するかどうかです。 */
  canModerate?: boolean
  /** State と同じ transaction に保存する audit context です。 */
  auditContext?: MutationAuditContext
}

/** Reaction mutation 入力です。 */
export type CollaborationReactionInput = WorkItemCollaborationScope & {
  /** Reaction を変更する member key です。 */
  actorMemberKey: string
  /** Reaction 対象 comment ID です。 */
  commentId: string
  /** 追加または削除する emoji です。 */
  emoji: string
  /** State と同じ transaction に保存する audit context です。 */
  auditContext?: MutationAuditContext
}

/** Watcher state 取得入力です。 */
export type GetWatcherStateInput = {
  /** Work Item、Project、または Planning update target の entity key です。 */
  entityKey: string
  /** 現在 user の member key です。 */
  memberKey: string
  /** Assigned project entity key です。 */
  projectEntityKey?: string
}

/** Watcher 更新入力です。 */
export type UpdateWatcherInput = {
  /** Canonical Workspace ID です。 */
  workspaceId: string
  /** Watch 対象の collaboration entity key です。 */
  entityKey: string
  /** Work Item の所有 team ID です。 */
  teamId?: string
  /** Work Item ID です。Project watch では未設定です。 */
  issueId?: string
  /** Assigned project または watch 対象 project ID です。 */
  projectId?: string
  /** Project/Initiative を一意に表す Planning update target key です。 */
  planningUpdateTargetKey?: string
  /** Work Item 取得時に併記する assigned project entity key です。 */
  projectEntityKey?: string
  /** Subscribe/unsubscribe 対象 member key です。 */
  memberKey: string
  /** 自動 watch mutation かどうかです。 */
  automatic?: boolean
  /** 自動 watch の理由です。 */
  reason?: CollaborationWatcherReason
  /** State と同じ transaction に保存する audit context です。 */
  auditContext?: MutationAuditContext
}

/** Presence heartbeat 入力です。 */
export type PresenceHeartbeatInput = {
  /** Collaboration entity key です。 */
  entityKey: string
  /** Workspace member key です。 */
  memberKey: string
  /** Browser tab ごとの client ID です。 */
  clientId: string
  /** Comment composer に入力中かどうかです。 */
  typing?: boolean
  /** Presence lease の有効秒数です。 */
  ttlSeconds?: number
}

/** Presence 削除入力です。 */
export type PresenceLeaveInput = {
  /** Collaboration entity key です。 */
  entityKey: string
  /** Workspace member key です。 */
  memberKey: string
  /** Browser tab ごとの client ID です。 */
  clientId: string
}

/** Collaboration data store の公開契約です。 */
export interface CollaborationClient {
  /** Root comments または replies を page 取得します。 */
  getThread(input: GetCollaborationThreadInput): Promise<CollaborationThreadPage>
  /** File 添付先として保存済み・未削除の comment が存在するか確認します。 */
  hasAttachableComment(entityKey: string, commentId: string): Promise<boolean>
  /** Comment の current snapshot を consistent read します。 */
  getCommentSnapshot(
    input: GetCollaborationCommentSnapshotInput,
  ): Promise<CollaborationComment | undefined>
  /** Root comment または reply を作成します。 */
  createComment(input: CreateCollaborationCommentInput): Promise<CollaborationComment>
  /** Comment 本文と mention を version 条件付きで更新します。 */
  updateComment(input: UpdateCollaborationCommentInput): Promise<CollaborationComment>
  /** Comment を version 条件付きで soft delete します。 */
  deleteComment(input: DeleteCollaborationCommentInput): Promise<CollaborationComment>
  /** Root comment thread を resolve します。 */
  resolveComment(input: ResolveCollaborationCommentInput): Promise<CollaborationComment>
  /** Root comment thread を reopen します。 */
  reopenComment(input: ResolveCollaborationCommentInput): Promise<CollaborationComment>
  /** Comment に reaction を重複なく追加します。 */
  addReaction(input: CollaborationReactionInput): Promise<void>
  /** 現在 user の reaction を削除します。 */
  removeReaction(input: CollaborationReactionInput): Promise<void>
  /** 現在 user と assigned project の watcher 状態を取得します。 */
  getWatcherState(input: GetWatcherStateInput): Promise<CollaborationWatcherState>
  /** 手動または自動 watcher を保存します。 */
  subscribe(input: UpdateWatcherInput): Promise<CollaborationWatcherState>
  /** 明示的な unsubscribe tombstone を保存します。 */
  unsubscribe(input: UpdateWatcherInput): Promise<CollaborationWatcherState>
  /** Presence/typing lease を更新します。 */
  heartbeatPresence(input: PresenceHeartbeatInput): Promise<void>
  /** Browser tab の presence を削除します。 */
  leavePresence(input: PresenceLeaveInput): Promise<void>
}

/** Collaboration API が安定して返す domain error です。 */
export class CollaborationError extends Error {
  /** HTTP response に対応する status code です。 */
  readonly status: number
  /** Client が分岐できる error code です。 */
  readonly code: string

  constructor(status: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CollaborationError'
    this.status = status
    this.code = code
  }
}

/** Persisted collaboration comment row with its DynamoDB key metadata. */
type StoredComment = CollaborationComment & {
  /** DynamoDB partition key です。 */
  entityKey: string
  /** DynamoDB sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'comment'
}

/** Persisted watcher row with its current subscription state. */
type StoredWatcher = {
  /** DynamoDB partition key です。 */
  entityKey: string
  /** DynamoDB sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'watcher'
  /** Watcher の member key です。 */
  memberKey: string
  /** 現在の明示状態です。 */
  state: 'subscribed' | 'unsubscribed'
  /** Manual mutation が保存されたかどうかです。 */
  explicit: boolean
  /** Manual/automatic watch reasons です。 */
  reasons: string[] | Set<string>
  /** 作成日時です。 */
  createdAt: string
  /** 更新日時です。 */
  updatedAt: string
}

/** Persisted browser presence lease row. */
type StoredPresence = {
  /** DynamoDB partition key です。 */
  entityKey: string
  /** DynamoDB sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'presence'
  /** Workspace member key です。 */
  memberKey: string
  /** Browser client ID です。 */
  clientId: string
  /** 入力中かどうかです。 */
  typing: boolean
  /** 最新 heartbeat 日時です。 */
  lastSeenAt: string
  /** DynamoDB TTL epoch seconds です。 */
  expiresAt: number
}

/** Cursor used to continue reading one collaboration discussion prefix. */
type DiscussionCursor = {
  /** Cursor schema version です。 */
  version: 1
  /** Cursor を発行した entity key です。 */
  entityKey: string
  /** Cursor を発行した discussion prefix です。 */
  prefix: string
  /** DynamoDB last evaluated sort key です。 */
  recordKey: string
}

const defaultPresenceTtlSeconds = 45
const localTableInitializers = new WeakMap<DynamoDBClient, Map<string, Promise<void>>>()

/** Work Item scope の canonical collaboration entity key を作成します。 */
export function createWorkItemCollaborationEntityKey(
  workspaceId: string,
  teamId: string,
  issueId: string,
) {
  return `${requireText(workspaceId, 'Workspace ID')}#work-item#team/${requireText(teamId, 'Team ID')}/issue/${requireText(issueId, 'Issue ID')}`
}

/** Project scope の canonical collaboration entity key を作成します。 */
export function createProjectCollaborationEntityKey(workspaceId: string, projectId: string) {
  return `${requireText(workspaceId, 'Workspace ID')}#project#${requireText(projectId, 'Project ID')}`
}

/** Planning update target scope の canonical collaboration entity key を作成します。 */
export function createPlanningUpdateCollaborationEntityKey(
  workspaceId: string,
  targetKey: string,
) {
  return `${requireText(workspaceId, 'Workspace ID')}#planning-update#${requireText(targetKey, 'Planning update target key')}`
}

/** Canonical target identity used by Planning update APIs, watchers, and notifications. */
export type PlanningUpdateTargetKeyInput =
  | {
      /** Target discriminator for a Team-qualified Project. */
      type: 'project'
      /** Team that owns the Project. */
      teamId: string
      /** Team-local Project identifier. */
      projectId: string
    }
  | {
      /** Target discriminator for an Initiative. */
      type: 'initiative'
      /** Workspace-local Initiative identifier. */
      entityId: string
    }

/** Creates the shared public key used to store and query Planning update watchers. */
export function createPlanningUpdatePublicTargetKey(
  target: PlanningUpdateTargetKeyInput,
): string {
  return target.type === 'project'
    ? `project/${encodeURIComponent(requireText(target.teamId, 'Team ID'))}/${encodeURIComponent(requireText(target.projectId, 'Project ID'))}`
    : `initiative/${encodeURIComponent(requireText(target.entityId, 'Initiative ID'))}`
}

/** DynamoDB collaboration table を操作する client です。 */
export class DynamoDbCollaborationClient implements CollaborationClient {
  /** Collaboration rows を保存する table 名です。 */
  private readonly tableName: string
  /** Parent Team Issue を condition-check する table 名です。 */
  private readonly parentIssueTableName: string
  /** Append-only audit event table 名です。 */
  private readonly auditTableName?: string
  /** DynamoDB document client です。 */
  private readonly documentClient: DynamoDBDocumentClient
  /** Local table bootstrap に使う low-level client です。 */
  private readonly dynamoDbClient: DynamoDBClient
  /** Local table がない場合に自動作成するかどうかです。 */
  private readonly bootstrapLocalTable: boolean

  constructor(
    tableName = readEnvironment('MUKUROJI_COLLABORATION_TABLE') ??
      readEnvironment('COLLABORATION_TABLE_NAME') ??
      'mukuroji-collaboration-local',
    parentIssueTableName = readEnvironment('WORK_ITEMS_TABLE_NAME') ??
      readEnvironment('MUKUROJI_WORK_ITEMS_TABLE') ??
      readEnvironment('MUKUROJI_TEAM_ISSUES_TABLE') ??
      readEnvironment('TEAM_ISSUES_TABLE_NAME') ??
      'mukuroji-team-issues-local',
    auditTableName = getConfiguredAuditTableName(),
    documentClient?: DynamoDBDocumentClient,
    dynamoDbClient = createDynamoDbClient(),
    bootstrapLocalTable = documentClient === undefined && shouldBootstrapLocalTable(),
  ) {
    this.tableName = requireText(tableName, 'Collaboration table name')
    this.parentIssueTableName = requireText(parentIssueTableName, 'Team issues table name')
    this.auditTableName = auditTableName
    this.dynamoDbClient = dynamoDbClient
    this.documentClient = documentClient ??
      createWorkspaceSearchWriterDynamoDbDocumentClient(dynamoDbClient)
    this.bootstrapLocalTable = bootstrapLocalTable
  }

  /** Root comments または replies を page 取得します。 */
  async getThread(input: GetCollaborationThreadInput) {
    await this.ensureLocalTable()
    const entityKey = requireText(input.entityKey, 'Collaboration entity key')
    const viewerMemberKey = normalizeMemberKey(input.viewerMemberKey)
    const prefix = input.rootCommentId
      ? `DISCUSSION#THREAD#${requireIdentifier(input.rootCommentId, 'Root comment ID')}#`
      : 'DISCUSSION#ROOT#'
    const limit = clampLimit(input.limit)
    const exclusiveStartKey = decodeCursor(input.cursor, entityKey, prefix)
    const response = await this.documentClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'entityKey = :entityKey AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: { ':entityKey': entityKey, ':prefix': prefix },
        ExclusiveStartKey: exclusiveStartKey,
        ConsistentRead: true,
        // Root/reply とも新着が常に先頭 page へ入るよう新しい順で取得する。
        ScanIndexForward: false,
        Limit: limit,
      }),
    )
    const commentIds = (response.Items ?? []).flatMap((item) =>
      typeof item.commentId === 'string' ? [item.commentId] : [],
    )
    const comments = (
      await Promise.all(commentIds.map((commentId) => this.getComment(entityKey, commentId, viewerMemberKey)))
    ).filter(isDefined)
    const replyRoot = input.rootCommentId
      ? await this.getStoredComment(entityKey, input.rootCommentId)
      : undefined
    const [watch, presence] = input.includeScopeState === false
      ? [
          {
            subscribed: false,
            explicit: false,
            automatic: false,
            reasons: [],
            watcherCount: 0,
          } satisfies CollaborationWatcherState,
          [],
        ]
      : await Promise.all([
          this.getWatcherState({
            entityKey,
            memberKey: viewerMemberKey,
            projectEntityKey: input.projectEntityKey,
          }),
          this.listPresence(entityKey),
        ])

    return {
      comments,
      ...(response.LastEvaluatedKey?.recordKey && typeof response.LastEvaluatedKey.recordKey === 'string'
        ? { nextCursor: encodeCursor({
            version: 1,
            entityKey,
            prefix,
            recordKey: response.LastEvaluatedKey.recordKey,
          }) }
        : {}),
      watch,
      presence,
      ...(replyRoot?.resolvedAt ? { threadResolved: true } : {}),
    } satisfies CollaborationThreadPage
  }

  /** File 添付先として保存済み・未削除の comment が存在するか確認します。 */
  async hasAttachableComment(entityKey: string, commentId: string) {
    const comment = await this.getCommentSnapshot({ entityKey, commentId })
    return Boolean(comment && !comment.deletedAt)
  }

  /** Comment の current snapshot を consistent read します。 */
  async getCommentSnapshot(input: GetCollaborationCommentSnapshotInput) {
    await this.ensureLocalTable()
    return this.getStoredComment(
      requireIdentifier(input.entityKey, 'Collaboration entity key'),
      requireIdentifier(input.commentId, 'Comment ID'),
    )
  }

  /** Root comment または reply を作成します。 */
  async createComment(input: CreateCollaborationCommentInput) {
    await this.ensureLocalTable()
    assertWorkItemScope(input)
    const actorMemberKey = normalizeMemberKey(input.actorMemberKey)
    const bodyMarkdown = normalizeCommentBody(input.bodyMarkdown)
    const mentionMemberKeys = normalizeMentionMemberKeys(input.mentionMemberKeys)
    const occurredAt = input.auditContext?.occurredAt ?? new Date().toISOString()
    const commentId = createCommentId(occurredAt, input.auditContext, input.entityKey)
    const parent = input.parentCommentId
      ? await this.getRequiredStoredComment(input.entityKey, input.parentCommentId)
      : undefined
    const root = parent && parent.rootCommentId !== parent.id
      ? await this.getRequiredStoredComment(input.entityKey, parent.rootCommentId)
      : parent

    if (parent?.deletedAt || root?.deletedAt) {
      throw new CollaborationError(409, 'CommentDeleted', 'Deleted comments cannot receive replies.')
    }
    if (root?.resolvedAt) {
      throw new CollaborationError(409, 'CommentResolved', 'Resolved threads must be reopened before replying.')
    }

    const rootCommentId = parent?.rootCommentId ?? commentId
    const comment: StoredComment = {
      entityKey: input.entityKey,
      recordKey: commentRecordKey(commentId),
      entryType: 'comment',
      id: commentId,
      rootCommentId,
      ...(parent ? { parentCommentId: parent.id } : {}),
      authorMemberKey: actorMemberKey,
      bodyMarkdown,
      version: 1,
      mentionMemberKeys,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      reactions: [],
    }
    const discussionRecordKey = parent
      ? `DISCUSSION#THREAD#${rootCommentId}#${occurredAt}#${commentId}`
      : `DISCUSSION#ROOT#${occurredAt}#${commentId}`
    const notificationCandidates = await this.buildNotificationCandidates(input, parent)
    const automaticWatchers = buildAutomaticWatcherCandidates(
      actorMemberKey,
      mentionMemberKeys,
      parent,
      input.automaticWatcherCandidates,
    )
    const auditPut = createMutationAuditEventPut(this.auditTableName, input.auditContext, {
      directoryId: input.workspaceId,
      eventType: parent ? 'comment.replied' : 'comment.created',
      entityType: 'work-item',
      entityId: workItemEntityId(input.teamId, input.issueId),
      target: { type: 'comment', id: `${workItemEntityId(input.teamId, input.issueId)}/comment/${commentId}` },
      action: parent ? 'replied' : 'created',
      occurredAt,
      changes: createAuditFieldChanges(undefined, { body: bodyMarkdown }, ['body'], ['body']),
      metadata: createAuditMetadata(
        input,
        actorMemberKey,
        commentId,
        notificationCandidates,
        rootCommentId,
      ),
    })
    const items: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      parentIssueCondition(this.parentIssueTableName, input),
      ...(parent && root ? replyConditions(this.tableName, input.entityKey, parent, root) : []),
      {
        Put: {
          TableName: this.tableName,
          Item: comment,
          ConditionExpression: 'attribute_not_exists(entityKey) AND attribute_not_exists(recordKey)',
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: {
            entityKey: input.entityKey,
            recordKey: discussionRecordKey,
            entryType: 'discussion',
            commentId,
            rootCommentId,
            ...(parent ? { parentCommentId: parent.id } : {}),
            createdAt: occurredAt,
          },
          ConditionExpression: 'attribute_not_exists(entityKey) AND attribute_not_exists(recordKey)',
        },
      },
      ...automaticWatchers.map(({ memberKey, reasons }) =>
        autoWatcherUpdate(this.tableName, input.entityKey, memberKey, reasons, occurredAt)
      ),
      ...(auditPut ? [auditPut] : []),
    ]

    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: items }))
      return comment
    } catch (error) {
      if (isConditionalFailure(error) && input.auditContext) {
        const existing = await this.getStoredComment(input.entityKey, commentId)
        if (existing && isSameCreatedComment(existing, comment)) {
          return existing
        }
      }
      throw await this.classifyWriteError(error, input.entityKey, commentId)
    }
  }

  /** Comment 本文と mention を version 条件付きで更新します。 */
  async updateComment(input: UpdateCollaborationCommentInput) {
    await this.ensureLocalTable()
    assertWorkItemScope(input)
    const before = await this.getRequiredStoredComment(input.entityKey, input.commentId)
    const actorMemberKey = normalizeMemberKey(input.actorMemberKey)

    if (before.authorMemberKey !== actorMemberKey) {
      throw new CollaborationError(403, 'CommentEditDenied', 'Only the comment author can edit it.')
    }

    if (before.deletedAt) {
      throw new CollaborationError(409, 'CommentDeleted', 'Deleted comments cannot be edited.')
    }

    const bodyMarkdown = normalizeCommentBody(input.bodyMarkdown)
    const mentionMemberKeys = normalizeMentionMemberKeys(input.mentionMemberKeys)
    const occurredAt = input.auditContext?.occurredAt ?? new Date().toISOString()
    const after: StoredComment = {
      ...before,
      bodyMarkdown,
      mentionMemberKeys,
      version: before.version + 1,
      updatedAt: occurredAt,
      editedAt: occurredAt,
    }
    const notificationCandidates = await this.buildNotificationCandidates(input)
    const automaticWatchers = buildAutomaticWatcherCandidates(
      actorMemberKey,
      mentionMemberKeys,
      undefined,
      input.automaticWatcherCandidates,
    )
    await this.updateCommentSnapshot(
      input,
      before,
      after,
      'comment.edited',
      'edited',
      createAuditFieldChanges(
        { body: before.bodyMarkdown },
        { body: bodyMarkdown },
        ['body'],
        ['body'],
      ),
      notificationCandidates,
      automaticWatchers,
    )
    return after
  }

  /** Comment を version 条件付きで soft delete します。 */
  async deleteComment(input: DeleteCollaborationCommentInput) {
    await this.ensureLocalTable()
    assertWorkItemScope(input)
    const before = await this.getRequiredStoredComment(input.entityKey, input.commentId)
    const actorMemberKey = normalizeMemberKey(input.actorMemberKey)

    if (before.authorMemberKey !== actorMemberKey && !input.canModerate) {
      throw new CollaborationError(403, 'CommentDeleteDenied', 'Comment delete permission is required.')
    }

    if (before.deletedAt) {
      return before
    }

    const occurredAt = input.auditContext?.occurredAt ?? new Date().toISOString()
    const after: StoredComment = {
      ...before,
      bodyMarkdown: '',
      mentionMemberKeys: [],
      version: before.version + 1,
      updatedAt: occurredAt,
      deletedAt: occurredAt,
    }
    await this.updateCommentSnapshot(
      input,
      before,
      after,
      'comment.deleted',
      'deleted',
      createAuditFieldChanges(
        { body: before.bodyMarkdown, deletedAt: before.deletedAt },
        { body: '', deletedAt: after.deletedAt },
        ['body', 'deletedAt'],
        ['body'],
      ),
      [],
    )
    return after
  }

  /** Root comment thread を resolve します。 */
  async resolveComment(input: ResolveCollaborationCommentInput) {
    return this.changeResolution(input, true)
  }

  /** Root comment thread を reopen します。 */
  async reopenComment(input: ResolveCollaborationCommentInput) {
    return this.changeResolution(input, false)
  }

  /** Comment に reaction を重複なく追加します。 */
  async addReaction(input: CollaborationReactionInput) {
    await this.changeReaction(input, true)
  }

  /** 現在 user の reaction を削除します。 */
  async removeReaction(input: CollaborationReactionInput) {
    await this.changeReaction(input, false)
  }

  /** 現在 user と assigned project の watcher 状態を取得します。 */
  async getWatcherState(input: GetWatcherStateInput) {
    await this.ensureLocalTable()
    const [scope, project] = await Promise.all([
      this.readWatcherScope(requireText(input.entityKey, 'Collaboration entity key')),
      input.projectEntityKey ? this.readWatcherScope(input.projectEntityKey) : undefined,
    ])
    const memberKey = normalizeMemberKey(input.memberKey)
    const current = scope.watchers.find((watcher) => watcher.memberKey === memberKey)
    const projectCurrent = project?.watchers.find((watcher) => watcher.memberKey === memberKey)
    const reasons = current ? normalizeWatcherReasons(current.reasons) : []

    return {
      subscribed: current?.state === 'subscribed',
      explicit: current?.explicit === true,
      automatic: reasons.some((reason) => reason !== 'manual'),
      reasons,
      watcherCount: scope.watcherCount,
      ...(project
        ? {
            projectSubscribed: projectCurrent?.state === 'subscribed',
            projectWatcherCount: project.watcherCount,
          }
        : {}),
    } satisfies CollaborationWatcherState
  }

  /** 手動または自動 watcher を保存します。 */
  async subscribe(input: UpdateWatcherInput) {
    await this.ensureLocalTable()
    const { entityKey, entityType, entityId } = validateWatcherScope(input)
    const parentConditions = watcherParentIssueConditions(this.parentIssueTableName, input)
    const memberKey = normalizeMemberKey(input.memberKey)
    const occurredAt = input.auditContext?.occurredAt ?? new Date().toISOString()
    const reason = input.automatic ? input.reason ?? 'comment' : 'manual'
    const update = input.automatic
      ? autoWatcherUpdate(this.tableName, entityKey, memberKey, reason, occurredAt)
      : manualWatcherUpdate(this.tableName, entityKey, memberKey, 'subscribed', occurredAt)
    const auditPut = createMutationAuditEventPut(this.auditTableName, input.auditContext, {
      directoryId: input.workspaceId,
      eventType: 'watcher.subscribed',
      entityType,
      entityId,
      action: 'subscribed',
      occurredAt,
      metadata: {
        actorMemberKey: memberKey,
        teamId: input.teamId,
        issueId: input.issueId,
        projectId: input.projectId,
        planningUpdateTargetKey: input.planningUpdateTargetKey,
        kind: reason,
      },
    })

    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [...parentConditions, update, ...(auditPut ? [auditPut] : [])],
      }))
    } catch (error) {
      if (!isConditionalFailure(error)) {
        throw toCollaborationStoreError(error)
      }

      const current = await this.getWatcherState({
        entityKey,
        memberKey,
        projectEntityKey: input.projectEntityKey,
      })
      if (!current.subscribed || !current.explicit) {
        throw new CollaborationError(409, 'CollaborationConflict', 'Watcher subscription conflicted.')
      }
      return current
    }
    return this.getWatcherState({
      entityKey,
      memberKey,
      projectEntityKey: input.projectEntityKey,
    })
  }

  /** 明示的な unsubscribe tombstone を保存します。 */
  async unsubscribe(input: UpdateWatcherInput) {
    await this.ensureLocalTable()
    const { entityKey, entityType, entityId } = validateWatcherScope(input)
    const parentConditions = watcherParentIssueConditions(this.parentIssueTableName, input)
    const memberKey = normalizeMemberKey(input.memberKey)
    const occurredAt = input.auditContext?.occurredAt ?? new Date().toISOString()
    const auditPut = createMutationAuditEventPut(this.auditTableName, input.auditContext, {
      directoryId: input.workspaceId,
      eventType: 'watcher.unsubscribed',
      entityType,
      entityId,
      action: 'unsubscribed',
      occurredAt,
      metadata: {
        actorMemberKey: memberKey,
        teamId: input.teamId,
        issueId: input.issueId,
        projectId: input.projectId,
        planningUpdateTargetKey: input.planningUpdateTargetKey,
      },
    })
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          ...parentConditions,
          manualWatcherUpdate(this.tableName, entityKey, memberKey, 'unsubscribed', occurredAt),
          ...(auditPut ? [auditPut] : []),
        ],
      }))
    } catch (error) {
      if (!isConditionalFailure(error)) {
        throw toCollaborationStoreError(error)
      }

      const current = await this.getWatcherState({
        entityKey,
        memberKey,
        projectEntityKey: input.projectEntityKey,
      })
      if (current.subscribed || !current.explicit) {
        throw new CollaborationError(409, 'CollaborationConflict', 'Watcher unsubscription conflicted.')
      }
      return current
    }
    return this.getWatcherState({
      entityKey,
      memberKey,
      projectEntityKey: input.projectEntityKey,
    })
  }

  /** Presence/typing lease を更新します。 */
  async heartbeatPresence(input: PresenceHeartbeatInput) {
    await this.ensureLocalTable()
    const entityKey = requireText(input.entityKey, 'Collaboration entity key')
    const memberKey = normalizeMemberKey(input.memberKey)
    const clientId = requireClientId(input.clientId)
    const now = new Date()
    const ttlSeconds = clampPresenceTtl(input.ttlSeconds)
    const item: StoredPresence = {
      entityKey,
      recordKey: presenceRecordKey(memberKey, clientId),
      entryType: 'presence',
      memberKey,
      clientId,
      typing: input.typing === true,
      lastSeenAt: now.toISOString(),
      expiresAt: Math.floor(now.getTime() / 1_000) + ttlSeconds,
    }
    await this.documentClient.send(new TransactWriteCommand({
      TransactItems: [{
        Put: {
          TableName: this.tableName,
          Item: item,
        },
      }],
    }))
  }

  /** Browser tab の presence を削除します。 */
  async leavePresence(input: PresenceLeaveInput) {
    await this.ensureLocalTable()
    await this.documentClient.send(new TransactWriteCommand({
      TransactItems: [{
        Delete: {
          TableName: this.tableName,
          Key: {
            entityKey: requireText(
              input.entityKey,
              'Collaboration entity key',
            ),
            recordKey: presenceRecordKey(
              normalizeMemberKey(input.memberKey),
              requireClientId(input.clientId),
            ),
          },
        },
      }],
    }))
  }

  private async changeResolution(input: ResolveCollaborationCommentInput, resolved: boolean) {
    await this.ensureLocalTable()
    assertWorkItemScope(input)
    const before = await this.getRequiredStoredComment(input.entityKey, input.commentId)
    const actorMemberKey = normalizeMemberKey(input.actorMemberKey)

    if (before.parentCommentId || before.rootCommentId !== before.id) {
      throw new CollaborationError(400, 'CommentNotRoot', 'Only root comments can change thread state.')
    }

    if (before.deletedAt) {
      throw new CollaborationError(409, 'CommentDeleted', 'Deleted comments cannot change thread state.')
    }

    if (before.authorMemberKey !== actorMemberKey && !input.canModerate) {
      throw new CollaborationError(403, 'CommentResolveDenied', 'Thread resolve permission is required.')
    }

    if (resolved === Boolean(before.resolvedAt)) {
      return before
    }

    const occurredAt = input.auditContext?.occurredAt ?? new Date().toISOString()
    const after: StoredComment = {
      ...before,
      version: before.version + 1,
      updatedAt: occurredAt,
      ...(resolved
        ? { resolvedAt: occurredAt, resolvedByMemberKey: actorMemberKey }
        : { resolvedAt: undefined, resolvedByMemberKey: undefined }),
    }
    await this.updateCommentSnapshot(
      input,
      before,
      after,
      resolved ? 'comment.resolved' : 'comment.reopened',
      resolved ? 'resolved' : 'reopened',
      createAuditFieldChanges(
        { resolvedAt: before.resolvedAt },
        { resolvedAt: after.resolvedAt },
        ['resolvedAt'],
      ),
      [],
    )
    return after
  }

  private async changeReaction(input: CollaborationReactionInput, adding: boolean) {
    await this.ensureLocalTable()
    assertWorkItemScope(input)
    const comment = await this.getRequiredStoredComment(input.entityKey, input.commentId)

    if (comment.deletedAt) {
      throw new CollaborationError(409, 'CommentDeleted', 'Deleted comments cannot receive reactions.')
    }

    const actorMemberKey = normalizeMemberKey(input.actorMemberKey)
    const emoji = requireReaction(input.emoji)
    const recordKey = reactionRecordKey(input.commentId, emoji, actorMemberKey)
    const existing = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { entityKey: input.entityKey, recordKey },
      ConsistentRead: true,
    }))

    if (adding === Boolean(existing.Item)) {
      return
    }

    const occurredAt = input.auditContext?.occurredAt ?? new Date().toISOString()
    const auditPut = createMutationAuditEventPut(this.auditTableName, input.auditContext, {
      directoryId: input.workspaceId,
      eventType: adding ? 'reaction.added' : 'reaction.removed',
      entityType: 'work-item',
      entityId: workItemEntityId(input.teamId, input.issueId),
      target: { type: 'comment', id: `${workItemEntityId(input.teamId, input.issueId)}/comment/${input.commentId}` },
      action: adding ? 'added' : 'removed',
      occurredAt,
      metadata: createAuditMetadata(
        input,
        actorMemberKey,
        input.commentId,
        [],
        comment.rootCommentId,
      ),
    })
    const reactionMutation = adding
      ? {
          Put: {
            TableName: this.tableName,
            Item: {
              entityKey: input.entityKey,
              recordKey,
              entryType: 'reaction',
              commentId: input.commentId,
              emoji,
              memberKey: actorMemberKey,
              createdAt: occurredAt,
            },
            ConditionExpression: 'attribute_not_exists(entityKey) AND attribute_not_exists(recordKey)',
          },
        }
      : {
          Delete: {
            TableName: this.tableName,
            Key: { entityKey: input.entityKey, recordKey },
            ConditionExpression: 'attribute_exists(entityKey) AND attribute_exists(recordKey)',
          },
        }

    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          parentIssueCondition(this.parentIssueTableName, input),
          commentCondition(this.tableName, input.entityKey, input.commentId),
          reactionMutation,
          ...(auditPut ? [auditPut] : []),
        ],
      }))
    } catch (error) {
      if (!isConditionalFailure(error)) {
        throw toCollaborationStoreError(error)
      }

      const current = await this.documentClient.send(new GetCommand({
        TableName: this.tableName,
        Key: { entityKey: input.entityKey, recordKey },
        ConsistentRead: true,
      }))
      if (adding === Boolean(current.Item)) {
        return
      }

      throw await this.classifyWriteError(error, input.entityKey, input.commentId)
    }
  }

  private async updateCommentSnapshot(
    input: UpdateCollaborationCommentInput | DeleteCollaborationCommentInput | ResolveCollaborationCommentInput,
    before: StoredComment,
    after: StoredComment,
    eventType: string,
    action: string,
    changes: ReturnType<typeof createAuditFieldChanges>,
    notificationCandidates: CollaborationNotificationCandidate[],
    automaticWatchers: Array<{ memberKey: string; reasons: CollaborationWatcherReason[] }> = [],
  ) {
    assertExpectedVersion(input.expectedVersion)
    const auditPut = createMutationAuditEventPut(this.auditTableName, input.auditContext, {
      directoryId: input.workspaceId,
      eventType,
      entityType: 'work-item',
      entityId: workItemEntityId(input.teamId, input.issueId),
      target: { type: 'comment', id: `${workItemEntityId(input.teamId, input.issueId)}/comment/${before.id}` },
      action,
      occurredAt: after.updatedAt,
      changes,
      metadata: createAuditMetadata(
        input,
        input.actorMemberKey,
        before.id,
        notificationCandidates,
        before.rootCommentId,
      ),
    })

    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          parentIssueCondition(this.parentIssueTableName, input),
          {
            Put: {
              TableName: this.tableName,
              Item: after,
              ConditionExpression: 'attribute_exists(entityKey) AND attribute_exists(recordKey) AND #version = :expectedVersion',
              ExpressionAttributeNames: { '#version': 'version' },
              ExpressionAttributeValues: { ':expectedVersion': input.expectedVersion },
            },
          },
          ...automaticWatchers.map(({ memberKey, reasons }) =>
            autoWatcherUpdate(this.tableName, input.entityKey, memberKey, reasons, after.updatedAt)
          ),
          ...(auditPut ? [auditPut] : []),
        ],
      }))
    } catch (error) {
      throw await this.classifyWriteError(error, input.entityKey, before.id, input.expectedVersion)
    }
  }

  private async getComment(entityKey: string, commentId: string, viewerMemberKey: string) {
    const stored = await this.getStoredComment(entityKey, commentId)

    if (!stored) {
      return undefined
    }

    return {
      ...stored,
      reactions: await this.readReactionSummaries(entityKey, commentId, viewerMemberKey),
    } satisfies CollaborationComment
  }

  private async getStoredComment(entityKey: string, commentId: string) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { entityKey, recordKey: commentRecordKey(commentId) },
      ConsistentRead: true,
    }))
    return response.Item ? toStoredComment(response.Item) : undefined
  }

  private async getRequiredStoredComment(entityKey: string, commentId: string) {
    const comment = await this.getStoredComment(entityKey, requireIdentifier(commentId, 'Comment ID'))

    if (!comment) {
      throw new CollaborationError(404, 'CommentNotFound', 'Comment was not found.')
    }

    return comment
  }

  private async readReactionSummaries(entityKey: string, commentId: string, viewerMemberKey: string) {
    const summaries = new Map<CollaborationReactionEmoji, { count: number; reactedByMe: boolean }>()
    let exclusiveStartKey: Record<string, unknown> | undefined

    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'entityKey = :entityKey AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: {
          ':entityKey': entityKey,
          ':prefix': `REACTION#${commentId}#`,
        },
        ConsistentRead: true,
        ExclusiveStartKey: exclusiveStartKey,
      }))

      for (const item of response.Items ?? []) {
        const emoji = isReaction(item.emoji) ? item.emoji : undefined
        const memberKey = typeof item.memberKey === 'string' ? normalizeMemberKey(item.memberKey) : undefined

        if (!emoji || !memberKey) {
          continue
        }

        const current = summaries.get(emoji) ?? { count: 0, reactedByMe: false }
        current.count += 1
        current.reactedByMe ||= memberKey === viewerMemberKey
        summaries.set(emoji, current)
      }

      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)

    return [...summaries].map(([emoji, summary]) => ({ emoji, ...summary }))
  }

  private async readWatcherScope(entityKey: string) {
    const watchers: StoredWatcher[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined

    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'entityKey = :entityKey AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: { ':entityKey': entityKey, ':prefix': 'WATCHER#' },
        ConsistentRead: true,
        ExclusiveStartKey: exclusiveStartKey,
      }))
      for (const item of response.Items ?? []) {
        try {
          watchers.push(toStoredWatcher(item))
        } catch {
          // A malformed watcher row must not hide otherwise valid subscribers.
        }
      }
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)

    return {
      watchers,
      watcherCount: new Set(
        watchers.filter((watcher) => watcher.state === 'subscribed').map((watcher) => watcher.memberKey),
      ).size,
    }
  }

  private async listPresence(entityKey: string) {
    const now = Math.floor(Date.now() / 1_000)
    const latestByMember = new Map<string, StoredPresence>()
    let exclusiveStartKey: Record<string, unknown> | undefined

    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'entityKey = :entityKey AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: { ':entityKey': entityKey, ':prefix': 'PRESENCE#' },
        ConsistentRead: true,
        ExclusiveStartKey: exclusiveStartKey,
      }))

      for (const item of response.Items ?? []) {
        const presence = toStoredPresence(item)

        if (!presence || presence.expiresAt <= now) {
          continue
        }

        const current = latestByMember.get(presence.memberKey)
        if (!current || current.lastSeenAt < presence.lastSeenAt) {
          latestByMember.set(presence.memberKey, presence)
        }
      }

      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)

    return [...latestByMember.values()].map(({ memberKey, typing, lastSeenAt }) => ({
      memberKey,
      typing,
      lastSeenAt,
    }))
  }

  private async buildNotificationCandidates(
    input: CreateCollaborationCommentInput | UpdateCollaborationCommentInput,
    parent?: StoredComment,
  ) {
    const candidates: CollaborationNotificationCandidate[] = [
      ...(input.notificationCandidates ?? []),
      ...normalizeMentionMemberKeys(input.mentionMemberKeys).map((memberKey) => ({ memberKey, reason: 'mention' })),
      ...(parent ? [{ memberKey: parent.authorMemberKey, reason: 'reply' }] : []),
    ]
    return dedupeNotificationCandidates(candidates, input.actorMemberKey)
  }

  private async classifyWriteError(
    error: unknown,
    entityKey: string,
    commentId: string,
    expectedVersion?: number,
  ) {
    if (!isConditionalFailure(error)) {
      return toCollaborationStoreError(error)
    }

    const current = await this.getStoredComment(entityKey, commentId)
    if (!current && expectedVersion !== undefined) {
      return new CollaborationError(404, 'CommentNotFound', 'Comment was not found.')
    }

    if (expectedVersion !== undefined && current?.version !== expectedVersion) {
      return new CollaborationError(409, 'CommentVersionConflict', 'Comment changed after it was loaded.')
    }

    return new CollaborationError(409, 'CollaborationConflict', 'Collaboration mutation conflicted.')
  }

  private async ensureLocalTable() {
    if (!this.bootstrapLocalTable) {
      return
    }

    let clientInitializers = localTableInitializers.get(this.dynamoDbClient)
    if (!clientInitializers) {
      clientInitializers = new Map<string, Promise<void>>()
      localTableInitializers.set(this.dynamoDbClient, clientInitializers)
    }

    const existing = clientInitializers.get(this.tableName)
    if (existing) {
      await existing
      return
    }

    const initializer = ensureCollaborationTable(this.tableName, this.dynamoDbClient)
      .finally(() => clientInitializers?.delete(this.tableName))
    clientInitializers.set(this.tableName, initializer)
    await initializer
  }
}

function assertWorkItemScope(input: WorkItemCollaborationScope) {
  const expected = createWorkItemCollaborationEntityKey(input.workspaceId, input.teamId, input.issueId)
  if (input.entityKey !== expected) {
    throw new CollaborationError(400, 'InvalidCollaborationScope', 'Work Item collaboration scope is invalid.')
  }

  if (input.projectId) {
    const projectEntityKey = createProjectCollaborationEntityKey(input.workspaceId, input.projectId)
    if (input.projectEntityKey !== projectEntityKey) {
      throw new CollaborationError(400, 'InvalidCollaborationScope', 'Project collaboration scope is invalid.')
    }
  }
}

function validateWatcherScope(input: UpdateWatcherInput) {
  const workspaceId = requireText(input.workspaceId, 'Workspace ID')
  const entityKey = requireText(input.entityKey, 'Collaboration entity key')

  if (input.issueId) {
    const teamId = requireText(input.teamId ?? '', 'Team ID')
    const issueId = requireText(input.issueId, 'Issue ID')
    const expected = createWorkItemCollaborationEntityKey(workspaceId, teamId, issueId)
    if (entityKey !== expected) {
      throw new CollaborationError(400, 'InvalidCollaborationScope', 'Work Item watcher scope is invalid.')
    }
    return {
      entityKey,
      entityType: 'work-item' as const,
      entityId: workItemEntityId(teamId, issueId),
    }
  }

  if (input.planningUpdateTargetKey) {
    const targetKey = requireText(
      input.planningUpdateTargetKey,
      'Planning update target key',
    )
    if (
      entityKey !== createPlanningUpdateCollaborationEntityKey(workspaceId, targetKey)
    ) {
      throw new CollaborationError(
        400,
        'InvalidCollaborationScope',
        'Planning update watcher scope is invalid.',
      )
    }
    return {
      entityKey,
      entityType: 'planning-update-target' as const,
      entityId: targetKey,
    }
  }

  const projectId = requireText(input.projectId ?? '', 'Project ID')
  if (entityKey !== createProjectCollaborationEntityKey(workspaceId, projectId)) {
    throw new CollaborationError(400, 'InvalidCollaborationScope', 'Project watcher scope is invalid.')
  }
  return { entityKey, entityType: 'project' as const, entityId: projectId }
}

function parentIssueCondition(tableName: string, input: WorkItemCollaborationScope) {
  const assignmentCondition = input.projectId
    ? 'assignedProjectId = :assignedProjectId'
    : 'attribute_not_exists(assignedProjectId)'
  const assigneeCondition = input.assigneeMemberKey
    ? ' AND assigneeUserId = :assigneeMemberKey'
    : ''

  return {
    ConditionCheck: {
      TableName: tableName,
      Key: {
        directoryTeamId: `${input.workspaceId}#team#${input.teamId}`,
        issueId: input.issueId,
      },
      ConditionExpression:
        `attribute_exists(directoryTeamId) AND attribute_exists(issueId) AND ${assignmentCondition}${assigneeCondition}`,
      ...((input.projectId || input.assigneeMemberKey)
        ? {
            ExpressionAttributeValues: {
              ...(input.projectId ? { ':assignedProjectId': input.projectId } : {}),
              ...(input.assigneeMemberKey
                ? { ':assigneeMemberKey': normalizeMemberKey(input.assigneeMemberKey) }
                : {}),
            },
          }
        : {}),
    },
  }
}

function watcherParentIssueConditions(tableName: string, input: UpdateWatcherInput) {
  if (!input.issueId) {
    return []
  }

  return [parentIssueCondition(tableName, {
    workspaceId: requireText(input.workspaceId, 'Workspace ID'),
    teamId: requireText(input.teamId ?? '', 'Team ID'),
    issueId: requireText(input.issueId, 'Issue ID'),
    entityKey: requireText(input.entityKey, 'Collaboration entity key'),
    projectId: input.projectId,
    projectEntityKey: input.projectEntityKey,
  })]
}

function commentCondition(tableName: string, entityKey: string, commentId: string) {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { entityKey, recordKey: commentRecordKey(commentId) },
      ConditionExpression: 'attribute_exists(entityKey) AND attribute_exists(recordKey) AND attribute_not_exists(deletedAt)',
    },
  }
}

function replyConditions(
  tableName: string,
  entityKey: string,
  parent: StoredComment,
  root: StoredComment,
) {
  const rootCondition = {
    ConditionCheck: {
      TableName: tableName,
      Key: { entityKey, recordKey: commentRecordKey(root.id) },
      ConditionExpression: 'attribute_exists(entityKey) AND attribute_exists(recordKey) AND attribute_not_exists(deletedAt) AND attribute_not_exists(resolvedAt)',
    },
  }

  return parent.id === root.id
    ? [rootCondition]
    : [commentCondition(tableName, entityKey, parent.id), rootCondition]
}

function autoWatcherUpdate(
  tableName: string,
  entityKey: string,
  memberKey: string,
  reasons: string | string[],
  occurredAt: string,
) {
  return {
    Update: {
      TableName: tableName,
      Key: { entityKey, recordKey: watcherRecordKey(memberKey) },
      UpdateExpression: 'SET entryType = :entryType, memberKey = :memberKey, #state = if_not_exists(#state, :subscribed), explicit = if_not_exists(explicit, :false), createdAt = if_not_exists(createdAt, :createdAt), updatedAt = :updatedAt ADD reasons :reasons',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':entryType': 'watcher',
        ':memberKey': memberKey,
        ':subscribed': 'subscribed',
        ':false': false,
        ':createdAt': occurredAt,
        ':updatedAt': occurredAt,
        ':reasons': new Set(Array.isArray(reasons) ? reasons : [reasons]),
      },
    },
  }
}

function buildAutomaticWatcherCandidates(
  actorMemberKey: string,
  mentionMemberKeys: string[],
  parent: StoredComment | undefined,
  supplied: CollaborationAutomaticWatcherCandidate[] | undefined,
) {
  const grouped = new Map<string, Set<CollaborationWatcherReason>>()
  const add = (memberKey: string, reason: CollaborationWatcherReason) => {
    const normalizedMemberKey = normalizeMemberKey(memberKey)
    const reasons = grouped.get(normalizedMemberKey) ?? new Set<CollaborationWatcherReason>()
    reasons.add(reason)
    grouped.set(normalizedMemberKey, reasons)
  }

  add(actorMemberKey, 'comment')
  for (const memberKey of mentionMemberKeys) {
    add(memberKey, 'mention')
  }
  if (parent) {
    add(parent.authorMemberKey, 'reply')
  }
  for (const candidate of supplied ?? []) {
    add(candidate.memberKey, requireWatcherReason(candidate.reason))
  }

  return [...grouped].map(([memberKey, reasons]) => ({
    memberKey,
    reasons: [...reasons].sort(),
  }))
}

function requireWatcherReason(value: string): CollaborationWatcherReason {
  if (value === 'manual' ||
    value === 'creator' ||
    value === 'assignee' ||
    value === 'comment' ||
    value === 'mention' ||
    value === 'reply') {
    return value
  }
  throw new CollaborationError(400, 'InvalidWatcherReason', 'Automatic watcher reason is invalid.')
}

function manualWatcherUpdate(
  tableName: string,
  entityKey: string,
  memberKey: string,
  state: 'subscribed' | 'unsubscribed',
  occurredAt: string,
) {
  return {
    Update: {
      TableName: tableName,
      Key: { entityKey, recordKey: watcherRecordKey(memberKey) },
      UpdateExpression: 'SET entryType = :entryType, memberKey = :memberKey, #state = :state, explicit = :true, createdAt = if_not_exists(createdAt, :createdAt), updatedAt = :updatedAt ADD reasons :reasons',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':entryType': 'watcher',
        ':memberKey': memberKey,
        ':state': state,
        ':true': true,
        ':createdAt': occurredAt,
        ':updatedAt': occurredAt,
        ':reasons': new Set(['manual']),
      },
    },
  }
}

function createAuditMetadata(
  input: WorkItemCollaborationScope & { deepLink?: string },
  actorMemberKey: string,
  commentId: string,
  notificationCandidates: CollaborationNotificationCandidate[],
  rootCommentId?: string,
) {
  return {
    actorMemberKey: normalizeMemberKey(actorMemberKey),
    commentId,
    rootCommentId,
    teamId: input.teamId,
    issueId: input.issueId,
    projectId: input.projectId,
    notificationTitle: input.workItemTitle,
    deepLink: appendCommentDeepLink(input.deepLink, commentId, rootCommentId),
    notificationCandidates,
  }
}

function appendCommentDeepLink(
  deepLink: string | undefined,
  commentId: string,
  rootCommentId: string | undefined,
) {
  if (!deepLink) {
    return undefined
  }

  const [pathAndQuery, fragment] = deepLink.split('#', 2)
  const separator = pathAndQuery.includes('?') ? '&' : '?'
  const search = new URLSearchParams({
    commentId,
    ...(rootCommentId ? { rootCommentId } : {}),
  })
  const focusedPath = `${pathAndQuery}${separator}${search.toString()}`

  return fragment ? `${focusedPath}#${fragment}` : focusedPath
}

function dedupeNotificationCandidates(
  candidates: CollaborationNotificationCandidate[],
  actorMemberKey: string,
) {
  const actor = normalizeMemberKey(actorMemberKey)
  const grouped = new Map<string, Set<string>>()

  for (const candidate of candidates) {
    const memberKey = normalizeMemberKey(candidate.memberKey)
    const reason = requireText(candidate.reason, 'Notification reason')

    if (memberKey === actor) {
      continue
    }

    const reasons = grouped.get(memberKey) ?? new Set<string>()
    reasons.add(reason)
    grouped.set(memberKey, reasons)
  }

  return [...grouped].flatMap(([memberKey, reasons]) =>
    [...reasons].sort().map((reason) => ({ memberKey, reason })),
  )
}

function normalizeCommentBody(value: string) {
  if (typeof value !== 'string') {
    throw new CollaborationError(400, 'InvalidCommentBody', 'Comment body must be text.')
  }

  const normalized = value.replace(/\r\n?/g, '\n').trim()
  if (!normalized) {
    throw new CollaborationError(400, 'InvalidCommentBody', 'Comment body is required.')
  }

  if (normalized.length > COLLABORATION_COMMENT_MAX_LENGTH) {
    throw new CollaborationError(400, 'InvalidCommentBody', 'Comment body is too long.')
  }

  if (hasUnsafeControlCharacter(normalized)) {
    throw new CollaborationError(400, 'InvalidCommentBody', 'Comment body contains control characters.')
  }

  return normalized
}

function hasUnsafeControlCharacter(value: string) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint === 127 || (codePoint < 32 && codePoint !== 9 && codePoint !== 10)
  })
}

function normalizeMentionMemberKeys(values: string[] | undefined) {
  if (!values) {
    return []
  }

  if (!Array.isArray(values) || values.length > COLLABORATION_MENTION_MAX_COUNT) {
    throw new CollaborationError(400, 'InvalidCommentMention', 'Comment has too many mentions.')
  }

  return [...new Set(values.map(normalizeMemberKey))]
}

function toStoredComment(value: Record<string, unknown>) {
  if (
    value.entryType !== 'comment' ||
    typeof value.entityKey !== 'string' ||
    typeof value.recordKey !== 'string' ||
    typeof value.id !== 'string' ||
    typeof value.rootCommentId !== 'string' ||
    typeof value.authorMemberKey !== 'string' ||
    typeof value.bodyMarkdown !== 'string' ||
    !Number.isSafeInteger(value.version) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    throw new CollaborationError(503, 'InvalidCollaborationRecord', 'Comment record is invalid.')
  }

  return {
    entityKey: value.entityKey,
    recordKey: value.recordKey,
    entryType: 'comment',
    id: value.id,
    rootCommentId: value.rootCommentId,
    ...(typeof value.parentCommentId === 'string' ? { parentCommentId: value.parentCommentId } : {}),
    authorMemberKey: normalizeMemberKey(value.authorMemberKey),
    bodyMarkdown: value.bodyMarkdown,
    version: value.version as number,
    mentionMemberKeys: Array.isArray(value.mentionMemberKeys)
      ? value.mentionMemberKeys.filter((entry): entry is string => typeof entry === 'string')
      : [],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(typeof value.editedAt === 'string' ? { editedAt: value.editedAt } : {}),
    ...(typeof value.deletedAt === 'string' ? { deletedAt: value.deletedAt } : {}),
    ...(typeof value.resolvedAt === 'string' ? { resolvedAt: value.resolvedAt } : {}),
    ...(typeof value.resolvedByMemberKey === 'string'
      ? { resolvedByMemberKey: normalizeMemberKey(value.resolvedByMemberKey) }
      : {}),
    reactions: [],
  } satisfies StoredComment
}

function toStoredWatcher(value: Record<string, unknown>): StoredWatcher {
  if (
    value.entryType !== 'watcher' ||
    typeof value.entityKey !== 'string' ||
    typeof value.recordKey !== 'string' ||
    typeof value.memberKey !== 'string' ||
    (value.state !== 'subscribed' && value.state !== 'unsubscribed')
  ) {
    throw new CollaborationError(503, 'InvalidCollaborationRecord', 'Watcher record is invalid.')
  }

  return {
    entityKey: value.entityKey,
    recordKey: value.recordKey,
    entryType: 'watcher',
    memberKey: normalizeMemberKey(value.memberKey),
    state: value.state,
    explicit: value.explicit === true,
    reasons: value.reasons instanceof Set || Array.isArray(value.reasons) ? value.reasons : [],
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
  }
}

function toStoredPresence(value: Record<string, unknown>) {
  if (
    value.entryType !== 'presence' ||
    typeof value.entityKey !== 'string' ||
    typeof value.recordKey !== 'string' ||
    typeof value.memberKey !== 'string' ||
    typeof value.clientId !== 'string' ||
    typeof value.lastSeenAt !== 'string' ||
    typeof value.expiresAt !== 'number'
  ) {
    return undefined
  }

  return {
    entityKey: value.entityKey,
    recordKey: value.recordKey,
    entryType: 'presence',
    memberKey: normalizeMemberKey(value.memberKey),
    clientId: value.clientId,
    typing: value.typing === true,
    lastSeenAt: value.lastSeenAt,
    expiresAt: value.expiresAt,
  } satisfies StoredPresence
}

function normalizeWatcherReasons(value: string[] | Set<string>) {
  return [...value].filter((reason): reason is string => typeof reason === 'string').sort()
}

function createCommentId(
  occurredAt: string,
  context: MutationAuditContext | undefined,
  entityKey: string,
) {
  if (context) {
    const digest = createHash('sha256')
      .update(`${entityKey}\0${context.idempotencyKeyHash}\0${context.requestFingerprint}`)
      .digest('hex')
      .slice(0, 40)
    return `cmt_${digest}`
  }

  const digest = createHash('sha256').update(`${occurredAt}\0${randomUUID()}`).digest('hex').slice(0, 24)
  return `cmt_${occurredAt.replace(/[^0-9]/g, '').slice(0, 17)}_${digest}`
}

function isSameCreatedComment(existing: StoredComment, expected: StoredComment) {
  return existing.authorMemberKey === expected.authorMemberKey &&
    existing.bodyMarkdown === expected.bodyMarkdown &&
    existing.parentCommentId === expected.parentCommentId &&
    existing.rootCommentId === expected.rootCommentId &&
    existing.mentionMemberKeys.length === expected.mentionMemberKeys.length &&
    existing.mentionMemberKeys.every((memberKey, index) => memberKey === expected.mentionMemberKeys[index])
}

function workItemEntityId(teamId: string, issueId: string) {
  return `team/${requireText(teamId, 'Team ID')}/issue/${requireText(issueId, 'Issue ID')}`
}

function commentRecordKey(commentId: string) {
  return `COMMENT#${requireIdentifier(commentId, 'Comment ID')}`
}

function watcherRecordKey(memberKey: string) {
  return `WATCHER#${normalizeMemberKey(memberKey)}`
}

function presenceRecordKey(memberKey: string, clientId: string) {
  return `PRESENCE#${normalizeMemberKey(memberKey)}#${requireClientId(clientId)}`
}

function reactionRecordKey(commentId: string, emoji: string, memberKey: string) {
  return `REACTION#${requireIdentifier(commentId, 'Comment ID')}#${encodeURIComponent(emoji)}#${normalizeMemberKey(memberKey)}`
}

function requireReaction(value: string): CollaborationReactionEmoji {
  if (isReaction(value)) {
    return value
  }

  throw new CollaborationError(400, 'InvalidReaction', 'Reaction emoji is not supported.')
}

function isReaction(value: unknown): value is CollaborationReactionEmoji {
  return typeof value === 'string' && (COLLABORATION_REACTIONS as readonly string[]).includes(value)
}

function assertExpectedVersion(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CollaborationError(400, 'InvalidCommentVersion', 'A positive expectedVersion is required.')
  }
}

function requireClientId(value: string) {
  const normalized = requireText(value, 'Presence client ID')
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(normalized)) {
    throw new CollaborationError(400, 'InvalidPresenceClient', 'Presence client ID is invalid.')
  }
  return normalized
}

function requireIdentifier(value: string, label: string) {
  const normalized = requireText(value, label)
  if (normalized.length > 512) {
    throw new CollaborationError(400, 'InvalidCollaborationIdentifier', `${label} is too long.`)
  }
  return normalized
}

function normalizeMemberKey(value: string) {
  return requireText(value, 'Workspace member key').toLowerCase()
}

function requireText(value: string, label: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CollaborationError(400, 'InvalidCollaborationInput', `${label} is required.`)
  }
  return value.trim()
}

function clampLimit(value: number | undefined) {
  if (value === undefined) {
    return 30
  }
  if (!Number.isFinite(value)) {
    throw new CollaborationError(400, 'InvalidCollaborationCursor', 'Page limit is invalid.')
  }
  return Math.max(1, Math.min(100, Math.floor(value)))
}

function clampPresenceTtl(value: number | undefined) {
  if (value === undefined) {
    return defaultPresenceTtlSeconds
  }
  if (!Number.isSafeInteger(value) || value < 15 || value > 300) {
    throw new CollaborationError(400, 'InvalidPresenceTtl', 'Presence TTL must be 15-300 seconds.')
  }
  return value
}

function encodeCursor(cursor: DiscussionCursor) {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeCursor(value: string | undefined, entityKey: string, prefix: string) {
  if (!value) {
    return undefined
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<DiscussionCursor>
    if (
      parsed.version !== 1 ||
      parsed.entityKey !== entityKey ||
      parsed.prefix !== prefix ||
      typeof parsed.recordKey !== 'string' ||
      !parsed.recordKey.startsWith(prefix)
    ) {
      throw new Error('cursor mismatch')
    }
    return { entityKey, recordKey: parsed.recordKey }
  } catch (error) {
    throw new CollaborationError(400, 'InvalidCollaborationCursor', 'Collaboration cursor is invalid.', { cause: error })
  }
}

function isConditionalFailure(error: unknown) {
  if (isAwsNamedError(error, 'ConditionalCheckFailedException')) {
    return true
  }
  if (!isAwsNamedError(error, 'TransactionCanceledException') || typeof error !== 'object' || error === null) {
    return false
  }

  const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons
  return Array.isArray(reasons) && reasons.some((reason) => reason.Code === 'ConditionalCheckFailed')
}

function toCollaborationStoreError(error: unknown) {
  throwIfWorkspaceSearchWriterFenceTerminalError(error)
  if (error instanceof CollaborationError) {
    return error
  }
  return new CollaborationError(503, 'CollaborationUnavailable', 'Collaboration store is unavailable.', { cause: error })
}

function isAwsNamedError(error: unknown, name: string) {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === name
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function createDynamoDbClient() {
  return createConfiguredDynamoDbClient()
}

function shouldBootstrapLocalTable() {
  return shouldBootstrapConfiguredLocalDynamoDb()
}

function readEnvironment(name: string) {
  if (typeof Bun !== 'undefined') {
    return Bun.env[name]
  }
  return process.env[name]
}

async function ensureCollaborationTable(tableName: string, client: DynamoDBClient) {
  try {
    const existing = await client.send(new DescribeTableCommand({ TableName: tableName }))
    if (!isCollaborationTable(existing.Table)) {
      throw new CollaborationError(503, 'InvalidCollaborationTable', 'Collaboration table schema is invalid.')
    }
    if (existing.Table?.TableStatus !== 'ACTIVE') {
      await waitForCollaborationTable(tableName, client)
    }
    return
  } catch (error) {
    if (!isAwsNamedError(error, 'ResourceNotFoundException')) {
      throw error
    }
  }

  try {
    await client.send(new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [
        { AttributeName: 'entityKey', AttributeType: 'S' },
        { AttributeName: 'recordKey', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'entityKey', KeyType: 'HASH' },
        { AttributeName: 'recordKey', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }))
  } catch (error) {
    if (!isAwsNamedError(error, 'ResourceInUseException')) {
      throw error
    }
  }

  await waitForCollaborationTable(tableName, client)
}

async function waitForCollaborationTable(tableName: string, client: DynamoDBClient) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await client.send(new DescribeTableCommand({ TableName: tableName }))
    if (response.Table?.TableStatus === 'ACTIVE') {
      if (!isCollaborationTable(response.Table)) {
        throw new CollaborationError(503, 'InvalidCollaborationTable', 'Collaboration table schema is invalid.')
      }
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new CollaborationError(503, 'CollaborationUnavailable', 'Collaboration table did not become active.')
}

function isCollaborationTable(table: TableDescription | undefined) {
  return Boolean(
    table?.KeySchema?.some((key) => key.AttributeName === 'entityKey' && key.KeyType === 'HASH') &&
    table.KeySchema.some((key) => key.AttributeName === 'recordKey' && key.KeyType === 'RANGE'),
  )
}
