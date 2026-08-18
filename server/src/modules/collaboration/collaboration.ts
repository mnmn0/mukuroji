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
  COLLABORATION_CONTEXT_SCHEMA_VERSION,
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  type AcceptedResolution,
  type AcceptedResolutionPage,
  type CreateCuratedContextItemRequest,
  type CuratedContextActorSnapshot,
  type CuratedContextCapabilities,
  type CuratedContextItem,
  type CuratedContextItemKind,
  type CuratedContextItemState,
  type CuratedContextPage,
  type CuratedContextQuote,
  type CuratedContextRevisionPage,
  type CuratedContextSource,
  type CuratedContextSourceAvailability,
  type CuratedContextSourceKind,
  type SetAcceptedResolutionRequest,
  type UpdateCuratedContextItemRequest,
} from '@mukuroji/contracts'
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
import {
  isCanonicalWorkItemRecord,
  type CanonicalWorkItemRecord,
} from '../work-items'

/** Comment 本文に保存できる文字数です。 */
export const COLLABORATION_COMMENT_MAX_LENGTH = 20_000

/** 一つの comment で解決できる mention 数です。 */
export const COLLABORATION_MENTION_MAX_COUNT = 20

/** Curated context title に保存できる文字数です。 */
export const COLLABORATION_CONTEXT_TITLE_MAX_LENGTH = 200

/** Curated context body と accepted resolution summary に保存できる文字数です。 */
export const COLLABORATION_CONTEXT_BODY_MAX_LENGTH = 20_000

/** Version of the Team Issue legacy-comment migration contract. */
export const TEAM_ISSUE_COMMENT_BACKFILL_VERSION = 1

/** Record key for a completed Team Issue comment backfill marker. */
export const TEAM_ISSUE_COMMENT_BACKFILL_MARKER_RECORD_KEY =
  `TEAM_ISSUE_COMMENTS#v${TEAM_ISSUE_COMMENT_BACKFILL_VERSION}`

/** Scope identifier for an environment-wide completed Team Issue comment backfill marker. */
export const TEAM_ISSUE_COMMENT_BACKFILL_ALL_WORKSPACES = '__all-workspaces__'

/** Record key for the per-entity curated-context pagination generation. */
const CURATED_CONTEXT_LEDGER_RECORD_KEY = 'CONTEXT_LEDGER'
/** Maximum length of one opaque watcher mutation identity. */
const watcherMutationIdentityMaximumLength = 256

/** UI と API が受け付ける reaction emoji です。 */
export const COLLABORATION_REACTIONS = ['👍', '❤️', '🎉', '👀', '✅'] as const

/** Minimum retention headroom required before an Activity source can be committed. */
const curatedContextActivityMinimumRemainingSeconds = 5

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
  /** Root thread の current accepted resolution です。全履歴は専用 cursor page で取得します。 */
  acceptedResolutions: AcceptedResolution[]
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

/** Bounded watcher state for one exact Workspace member. */
export type CollaborationMemberWatcherState = {
  /** Whether the member currently watches the requested entity. */
  subscribed: boolean
  /** Whether a manual subscribe or unsubscribe decision is stored. */
  explicit: boolean
  /** Whether at least one automatic watcher reason is stored. */
  automatic: boolean
  /** Current manual and automatic watcher reasons for the member. */
  reasons: string[]
  /** Opaque identity of the mutation that produced the current row. */
  mutationIdentity?: string
  /** Canonical timestamp of the persisted watcher row. */
  updatedAt?: string
  /** Whether the member currently watches the assigned Project, when requested. */
  projectSubscribed?: boolean
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

/** Authorization generation observed before a curated context mutation. */
export type CuratedContextAuthorizationSnapshot = {
  /** Workspace member whose authorization was checked. */
  memberKey: string
  /** Membership generation observed during authorization. */
  workspaceMemberVersion: number
  /** Enterprise Identity authorization generation observed during authorization. */
  enterpriseControlRevision?: number
}

/**
 * Authorization and source revisions captured while reading a Document source.
 *
 * This is intentionally a server-side mutation input rather than part of the
 * public provenance contract.  The Documents adapter owns the rows and the
 * collaboration adapter turns this semantic snapshot into transaction
 * conditions.
 */
export type CuratedContextDocumentSourceAuthorizationSnapshot = {
  /** Canonical Document identifier that was read. */
  sourceId: string
  /** Document content/metadata revision observed during the read. */
  documentRevision: number
  /** Workspace-wide Documents authorization generation observed during the read. */
  documentAuthorizationRevision: number
  /** Workspace member whose access was checked, when applicable. */
  workspaceMemberKey?: string
  /** Workspace membership generation observed during the read, when applicable. */
  workspaceMemberVersion?: number
  /** Planning authorization generation observed during the read, when applicable. */
  planningRevision?: number
  /** Enterprise Identity authorization generation observed during the read, when applicable. */
  enterpriseControlRevision?: number
}

/**
 * Retention snapshot captured while reading an Activity source.
 *
 * This server-only snapshot is converted into an audit-row condition so a
 * source cannot cross its retention boundary between the API read and the
 * context-item transaction.
 */
export type CuratedContextActivitySourceAuthorizationSnapshot = {
  /** Immutable audit event identifier that was read. */
  sourceId: string
  /** Audit retention deadline in epoch seconds, when the event has one. */
  expiresAt?: number
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
  /** Authorization generation observed before the context mutation. */
  authorizationSnapshot?: CuratedContextAuthorizationSnapshot
}

/** Input used to copy one legacy Team Issue comment into Collaboration. */
export type BackfillCollaborationCommentInput = WorkItemCollaborationScope & {
  /** Stable event identifier reused as the canonical comment identifier. */
  commentId: string
  /** Legacy event actor preserved as the canonical comment author. */
  actorMemberKey: string
  /** Legacy Markdown/plain-text body. */
  bodyMarkdown: string
  /** Original legacy event timestamp. */
  occurredAt: string
}

/** Read-only authorization row guard appended to a watcher mutation transaction. */
export type CollaborationAuthorizationConditionCheck = {
  /** Condition check against one current authorization source-of-truth row. */
  ConditionCheck: NonNullable<
    NonNullable<TransactWriteCommandInput['TransactItems']>[number]['ConditionCheck']
  >
}

/** Thread page 取得入力です。 */
export type GetCollaborationThreadInput = {
  /** Collaboration entity key です。 */
  entityKey: string
  /** Reaction と watcher を現在 user 用に射影する member key です。 */
  viewerMemberKey: string
  /** Reply page を取得する root comment ID です。 */
  rootCommentId?: string
  /** Whether to read root comments and replies through one bounded page stream. */
  includeReplies?: boolean
  /** Whether a rolling compatibility deployment requires a cursor readable by pre-migration servers. */
  legacyCursorCompatible?: boolean
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

/** Deterministic comment mutation replay lookup input. */
export type GetCollaborationCommentMutationReplayInput = {
  /** Work Item collaboration entity key that owns the comment. */
  entityKey: string
  /** Request identity used to derive the committed comment identifier. */
  auditContext: MutationAuditContext
  /** Optional explicit identifier used by trusted service mutations with legacy IDs. */
  commentId?: string
}

/** Curated context page 取得入力です。 */
export type GetCuratedContextInput = {
  /** Work Item の collaboration entity key です。 */
  entityKey: string
  /** 一 page の最大件数です。 */
  limit?: number
  /** 前 page が返した scope-bound opaque cursor です。 */
  cursor?: string
  /** Caller が認可結果から組み立てた操作 capability です。 */
  capabilities: CuratedContextCapabilities
}

/** Curated context snapshot 取得入力です。 */
export type GetCuratedContextItemSnapshotInput = {
  /** Work Item の collaboration entity key です。 */
  entityKey: string
  /** 読み込む curated context item ID です。 */
  itemId: string
}

/** Curated context revision page 取得入力です。 */
export type GetCuratedContextRevisionsInput = {
  /** Work Item の collaboration entity key です。 */
  entityKey: string
  /** 履歴を所有する curated context item ID です。 */
  itemId: string
  /** 一 page の最大件数です。 */
  limit?: number
  /** 前 page が返した item-bound opaque cursor です。 */
  cursor?: string
}

/** Durable curated-context mutation replay preflight input. */
export type GetCuratedContextMutationReplayInput = {
  /** Work Item collaboration entity key that owns the mutation receipt. */
  entityKey: string
  /** Curated-context mutation kind bound to the idempotency key. */
  operation: 'create' | 'update'
  /** Updated item identifier. It is required only for update mutations. */
  itemId?: string
  /** Request identity and fingerprint used to locate and validate the receipt. */
  auditContext: MutationAuditContext
}

/** Curated context mutation で共通する caller 解決済み入力です。 */
export type CuratedContextMutationInput = WorkItemCollaborationScope & {
  /** Mutation actor の display-safe snapshot です。 */
  actor: CuratedContextActorSnapshot
  /** Caller が追加する notification 候補です。 */
  notificationCandidates?: CollaborationNotificationCandidate[]
  /** Work Item creator/assignee など caller が解決した自動 watcher 候補です。 */
  automaticWatcherCandidates?: CollaborationAutomaticWatcherCandidate[]
  /** Notification から戻る Web path です。 */
  deepLink?: string
  /** State と同じ transaction に保存する audit context です。 */
  auditContext?: MutationAuditContext
  /** Document source authorization snapshot fenced by the create transaction. */
  sourceAuthorizationSnapshot?: CuratedContextDocumentSourceAuthorizationSnapshot
  /** Activity retention snapshot fenced by the create transaction. */
  activitySourceAuthorizationSnapshot?: CuratedContextActivitySourceAuthorizationSnapshot
}

/** Common actor-bearing input accepted by authorization-fenced context mutations. */
type CuratedContextAuthorizationInput = WorkItemCollaborationScope & {
  /** Mutation actor whose membership generation is fenced. */
  actor: CuratedContextActorSnapshot
}

/** Curated context item 作成入力です。 */
export type CreateCuratedContextItemInput = CuratedContextMutationInput &
  CreateCuratedContextItemRequest

/** Curated context item 更新入力です。 */
export type UpdateCuratedContextItemInput = CuratedContextMutationInput &
  UpdateCuratedContextItemRequest & {
    /** 更新対象の curated context item ID です。 */
    itemId: string
  }

/** Accepted resolution 選択・要約更新入力です。 */
export type SetAcceptedResolutionInput = WorkItemCollaborationScope &
  SetAcceptedResolutionRequest & {
    /** Accepted resolution を所有する root comment ID です。 */
    rootCommentId: string
    /** Mutation actor の display-safe snapshot です。 */
    actor: CuratedContextActorSnapshot
    /** Root author 以外による mutation を許可するかどうかです。 */
    canModerate: boolean
    /** Notification から戻る Web path です。 */
    deepLink?: string
    /** State と同じ transaction に保存する audit context です。 */
    auditContext?: MutationAuditContext
    /** Authorization generations observed before the mutation. */
    authorizationSnapshot?: CuratedContextAuthorizationSnapshot
  }

/** Accepted resolution history page 取得入力です。 */
export type GetAcceptedResolutionHistoryInput = {
  /** Work Item の collaboration entity key です。 */
  entityKey: string
  /** 履歴を所有する root comment ID です。 */
  rootCommentId: string
  /** 一 page の最大件数です。 */
  limit?: number
  /** 前 page が返した thread-bound opaque cursor です。 */
  cursor?: string
}

/** Comment 作成入力です。 */
export type CreateCollaborationCommentInput = WorkItemCollaborationScope & {
  /** Comment を作成する Workspace member key です。 */
  actorMemberKey: string
  /** Markdown source の本文です。 */
  bodyMarkdown: string
  /** Optional deterministic identifier reserved for trusted service writers. */
  commentId?: string
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
  /** Caller authorization rows guarded in the same transaction as the comment write. */
  authorizationConditionChecks?: readonly CollaborationAuthorizationConditionCheck[]
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

/**
 * Represents watcher mutation input for subscribe and unsubscribe operations.
 */
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
  /** Expected current manual watcher state used for optional compare-and-set. */
  expectedSubscribed?: boolean
  /** Opaque identity used to recover a committed mutation after response loss. */
  mutationIdentity?: string
  /** Caller authorization rows guarded in the same transaction as the watcher write. */
  authorizationConditionChecks?: readonly CollaborationAuthorizationConditionCheck[]
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
  /** Returns whether the environment marker allows canonical-only Team Issue comment reads. */
  isTeamIssueCommentBackfillComplete(workspaceId: string): Promise<boolean>
  /** Validates one legacy Team Issue comment without writing migration state. */
  validateBackfillTeamIssueComment(input: BackfillCollaborationCommentInput): Promise<void>
  /** Root comments または replies を page 取得します。 */
  getThread(input: GetCollaborationThreadInput): Promise<CollaborationThreadPage>
  /** File 添付先として保存済み・未削除の comment が存在するか確認します。 */
  hasAttachableComment(entityKey: string, commentId: string): Promise<boolean>
  /** Comment の current snapshot を consistent read します。 */
  getCommentSnapshot(
    input: GetCollaborationCommentSnapshotInput,
  ): Promise<CollaborationComment | undefined>
  /** Returns a previously committed comment for a deterministic mutation identity. */
  getCommentMutationReplay(
    input: GetCollaborationCommentMutationReplayInput,
  ): Promise<CollaborationComment | undefined>
  /** Work Item の curated context items を page 取得します。 */
  getCuratedContext(input: GetCuratedContextInput): Promise<CuratedContextPage>
  /** Curated context item の current snapshot を consistent read します。 */
  getCuratedContextItemSnapshot(
    input: GetCuratedContextItemSnapshotInput,
  ): Promise<CuratedContextItem | undefined>
  /** Curated context item の immutable revision history を新しい順に page 取得します。 */
  getCuratedContextRevisions(
    input: GetCuratedContextRevisionsInput,
  ): Promise<CuratedContextRevisionPage>
  /** Returns the immutable response for a previously committed idempotent context mutation. */
  getCuratedContextMutationReplay(
    input: GetCuratedContextMutationReplayInput,
  ): Promise<CuratedContextItem | undefined>
  /** Curated context item を作成し、任意の既存 item を atomically supersede します。 */
  createCuratedContextItem(input: CreateCuratedContextItemInput): Promise<CuratedContextItem>
  /** Curated context item を revision 条件付きで更新します。 */
  updateCuratedContextItem(input: UpdateCuratedContextItemInput): Promise<CuratedContextItem>
  /** Root thread の accepted resolution を version 条件付きで保存します。 */
  setAcceptedResolution(input: SetAcceptedResolutionInput): Promise<CollaborationComment>
  /** Root thread の accepted resolution history を新しい順に page 取得します。 */
  getAcceptedResolutionHistory(
    input: GetAcceptedResolutionHistoryInput,
  ): Promise<AcceptedResolutionPage>
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
  /** Reads one exact member watcher row without scanning the watcher scope. */
  getMemberWatcherState(input: GetWatcherStateInput): Promise<CollaborationMemberWatcherState>
  /** 手動または自動 watcher を保存します。 */
  subscribe(
    input: UpdateWatcherInput & { expectedSubscribed: boolean },
  ): Promise<CollaborationMemberWatcherState>
  /** Saves a watcher while preserving scope-wide counts for compatibility callers. */
  subscribe(
    input: Omit<UpdateWatcherInput, 'expectedSubscribed'> & { expectedSubscribed?: undefined },
  ): Promise<CollaborationWatcherState>
  /** Saves a watcher when the optional compare-and-set shape is not statically narrowed. */
  subscribe(
    input: UpdateWatcherInput,
  ): Promise<CollaborationMemberWatcherState | CollaborationWatcherState>
  /** 明示的な unsubscribe tombstone を保存します。 */
  unsubscribe(
    input: UpdateWatcherInput & { expectedSubscribed: boolean },
  ): Promise<CollaborationMemberWatcherState>
  /** Saves an unsubscribe tombstone while preserving counts for compatibility callers. */
  unsubscribe(
    input: Omit<UpdateWatcherInput, 'expectedSubscribed'> & { expectedSubscribed?: undefined },
  ): Promise<CollaborationWatcherState>
  /** Saves an unsubscribe tombstone when the optional compare-and-set shape is not narrowed. */
  unsubscribe(
    input: UpdateWatcherInput,
  ): Promise<CollaborationMemberWatcherState | CollaborationWatcherState>
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

/**
 * Normalizes permission-derived curated context capabilities.
 *
 * @param value - Caller-supplied capability object.
 * @returns A complete capability snapshot.
 */
function normalizeContextCapabilities(value: CuratedContextCapabilities) {
  if (!isRecord(value) ||
      typeof value.canCreate !== 'boolean' ||
      typeof value.canEdit !== 'boolean' ||
      typeof value.canReplace !== 'boolean' ||
      typeof value.canAcceptResolution !== 'boolean') {
    throw new CollaborationError(
      400,
      'InvalidContextCapabilities',
      'Curated context capabilities are invalid.',
    )
  }
  return {
    canCreate: value.canCreate,
    canEdit: value.canEdit,
    canReplace: value.canReplace,
    canAcceptResolution: value.canAcceptResolution,
  } satisfies CuratedContextCapabilities
}

/**
 * Converts a stored context item into its public contract without physical keys.
 *
 * @param value - Stored current snapshot.
 * @returns Public curated context item.
 */
function toCuratedContextItem(value: StoredCuratedContextItem): CuratedContextItem {
  return {
    schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
    id: value.id,
    teamId: value.teamId,
    workItemId: value.workItemId,
    kind: value.kind,
    state: value.state,
    title: value.title,
    body: value.body,
    ...(value.source ? { source: value.source } : {}),
    mentionMemberKeys: [...value.mentionMemberKeys],
    createdBy: value.createdBy,
    createdAt: value.createdAt,
    updatedBy: value.updatedBy,
    updatedAt: value.updatedAt,
    revision: value.revision,
    ...(value.supersededByItemId
      ? { supersededByItemId: value.supersededByItemId }
      : {}),
  }
}

/**
 * Parses and validates a curated context current snapshot row.
 *
 * @param value - DynamoDB document value.
 * @returns Validated stored item.
 */
function toStoredCuratedContextItem(value: Record<string, unknown>): StoredCuratedContextItem {
  try {
    if (value.entryType !== 'context' ||
        typeof value.entityKey !== 'string' ||
        typeof value.recordKey !== 'string' ||
        value.schemaVersion !== COLLABORATION_CONTEXT_SCHEMA_VERSION ||
        typeof value.id !== 'string' ||
        typeof value.teamId !== 'string' ||
        typeof value.workItemId !== 'string' ||
        !isPositiveSafeInteger(value.revision) ||
        (value.lastMutationKey !== undefined &&
          typeof value.lastMutationKey !== 'string') ||
        !Array.isArray(value.mentionMemberKeys)) {
      throw new Error('invalid context row')
    }
    const id = requireIdentifier(value.id, 'Curated context item ID')
    if (value.recordKey !== contextItemRecordKey(id)) {
      throw new Error('invalid context record key')
    }
    const entityOwner = parseWorkItemEntityOwner(value.entityKey)
    if (entityOwner.teamId !== value.teamId || entityOwner.issueId !== value.workItemId) {
      throw new Error('curated context owner does not match entity key')
    }
    const mentionMemberKeys = normalizeMentionMemberKeys(
      value.mentionMemberKeys.filter((entry): entry is string => typeof entry === 'string'),
    )
    if (mentionMemberKeys.length !== value.mentionMemberKeys.length) {
      throw new Error('invalid context mentions')
    }
    const source = value.source === undefined
      ? undefined
      : normalizeCuratedContextSource(value.source)
    return {
      entityKey: requireIdentifier(value.entityKey, 'Collaboration entity key'),
      recordKey: value.recordKey,
      entryType: 'context',
      schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
      id,
      teamId: requireText(value.teamId, 'Team ID'),
      workItemId: requireText(value.workItemId, 'Work Item ID'),
      kind: requireCuratedContextKind(value.kind),
      state: requireCuratedContextState(value.state),
      title: normalizeContextTitle(value.title),
      body: normalizeContextBody(value.body, 'Curated context body'),
      ...(source ? { source } : {}),
      mentionMemberKeys,
      createdBy: normalizeContextActor(value.createdBy, 'Curated context creator'),
      createdAt: normalizeIsoTimestamp(value.createdAt, 'Curated context createdAt'),
      updatedBy: normalizeContextActor(value.updatedBy, 'Curated context updater'),
      updatedAt: normalizeIsoTimestamp(value.updatedAt, 'Curated context updatedAt'),
      revision: value.revision,
      ...(typeof value.lastMutationKey === 'string'
        ? {
            lastMutationKey: requireTextValue(
              value.lastMutationKey,
              'Curated context mutation key',
              64,
            ),
          }
        : {}),
      ...(typeof value.supersededByItemId === 'string'
        ? {
            supersededByItemId: requireIdentifier(
              value.supersededByItemId,
              'Superseding curated context item ID',
            ),
          }
        : {}),
    }
  } catch (error) {
    throw new CollaborationError(
      503,
      'InvalidCollaborationRecord',
      'Curated context record is invalid.',
      { cause: error },
    )
  }
}

/**
 * Parses a persisted curated-context current snapshot for maintenance tooling.
 *
 * @param value - Untrusted DynamoDB document row.
 * @returns Validated public curated-context snapshot without physical keys.
 */
export function parseCuratedContextItemRow(
  value: Record<string, unknown>,
): CuratedContextItem {
  return toCuratedContextItem(toStoredCuratedContextItem(value))
}

/**
 * Parses the canonical Team and Work Item owner embedded in a collaboration entity key.
 *
 * @param entityKey - Persisted collaboration entity key.
 * @returns Canonical owner identifiers encoded by the key.
 */
function parseWorkItemEntityOwner(entityKey: string): { teamId: string; issueId: string } {
  const marker = '#work-item#team/'
  const markerIndex = entityKey.indexOf(marker)
  const issueMarker = '/issue/'
  const issueMarkerIndex = markerIndex < 0
    ? -1
    : entityKey.indexOf(issueMarker, markerIndex + marker.length)
  if (markerIndex < 0 || issueMarkerIndex < 0) {
    throw new Error('invalid work item entity key')
  }
  const teamId = entityKey.slice(markerIndex + marker.length, issueMarkerIndex)
  const issueId = entityKey.slice(issueMarkerIndex + issueMarker.length)
  if (!teamId || !issueId) {
    throw new Error('invalid work item entity owner')
  }
  return { teamId, issueId }
}

/**
 * Parses and validates a curated context order projection row.
 *
 * @param value - DynamoDB document value.
 * @returns Validated order row.
 */
function toStoredCuratedContextOrder(value: Record<string, unknown>): StoredCuratedContextOrder {
  try {
    if (value.entryType !== 'context-order' ||
        typeof value.entityKey !== 'string' ||
        typeof value.recordKey !== 'string' ||
        typeof value.itemId !== 'string' ||
        typeof value.createdAt !== 'string') {
      throw new Error('invalid context order row')
    }
    const row: StoredCuratedContextOrder = {
      entityKey: requireIdentifier(value.entityKey, 'Collaboration entity key'),
      recordKey: value.recordKey,
      entryType: 'context-order',
      itemId: requireIdentifier(value.itemId, 'Curated context item ID'),
      createdAt: normalizeIsoTimestamp(value.createdAt, 'Curated context createdAt'),
    }
    if (row.recordKey !== contextOrderRecordKey(row.createdAt, row.itemId)) {
      throw new Error('invalid context order record key')
    }
    return row
  } catch (error) {
    throw new CollaborationError(
      503,
      'InvalidCollaborationRecord',
      'Curated context order record is invalid.',
      { cause: error },
    )
  }
}

/**
 * Parses and strictly validates an append-only curated context revision row.
 *
 * @param value - DynamoDB document value.
 * @param expectedEntityKey - Collaboration scope requested by the caller.
 * @param expectedItemId - Curated context item requested by the caller.
 * @returns Validated immutable revision row.
 */
function toStoredCuratedContextRevision(
  value: Record<string, unknown>,
  expectedEntityKey: string,
  expectedItemId: string,
): StoredCuratedContextRevision {
  try {
    if (value.entryType !== 'context-revision' ||
        value.entityKey !== expectedEntityKey ||
        typeof value.recordKey !== 'string' ||
        value.itemId !== expectedItemId ||
        !isPositiveSafeInteger(value.revision) ||
        typeof value.createdAt !== 'string' ||
        !isRecord(value.snapshot)) {
      throw new Error('invalid context revision row')
    }
    const itemId = requireIdentifier(expectedItemId, 'Curated context item ID')
    if (value.recordKey !== contextRevisionRecordKey(itemId, value.revision)) {
      throw new Error('invalid context revision record key')
    }
    const snapshot = toCuratedContextItem(toStoredCuratedContextItem({
      ...value.snapshot,
      entityKey: expectedEntityKey,
      recordKey: contextItemRecordKey(itemId),
      entryType: 'context',
    }))
    const createdAt = normalizeIsoTimestamp(value.createdAt, 'Curated context revision createdAt')
    if (snapshot.id !== itemId ||
        snapshot.revision !== value.revision ||
        snapshot.updatedAt !== createdAt) {
      throw new Error('context revision snapshot mismatch')
    }
    return {
      entityKey: expectedEntityKey,
      recordKey: value.recordKey,
      entryType: 'context-revision',
      itemId,
      revision: value.revision,
      snapshot,
      createdAt,
    }
  } catch (error) {
    throw new CollaborationError(
      503,
      'InvalidCollaborationRecord',
      'Curated context revision record is invalid.',
      { cause: error },
    )
  }
}

/**
 * Parses and strictly validates a durable curated-context mutation receipt.
 *
 * @param value - DynamoDB document value.
 * @param expectedEntityKey - Collaboration scope requested by the caller.
 * @param expectedRecordKey - Receipt key derived from the caller's idempotency identity.
 * @returns Validated mutation receipt.
 */
function toStoredCuratedContextMutationReceipt(
  value: Record<string, unknown>,
  expectedEntityKey: string,
  expectedRecordKey: string,
): StoredCuratedContextMutationReceipt {
  try {
    if (value.entryType !== 'context-mutation-receipt' ||
        value.entityKey !== expectedEntityKey ||
        value.recordKey !== expectedRecordKey ||
        (value.operation !== 'create' && value.operation !== 'update') ||
        typeof value.requestFingerprint !== 'string' ||
        typeof value.itemId !== 'string' ||
        !isPositiveSafeInteger(value.responseRevision)) {
      throw new Error('invalid context mutation receipt')
    }
    return {
      entityKey: expectedEntityKey,
      recordKey: expectedRecordKey,
      entryType: 'context-mutation-receipt',
      operation: value.operation,
      requestFingerprint: requireTextValue(
        value.requestFingerprint,
        'Curated context request fingerprint',
        256,
      ),
      itemId: requireIdentifier(value.itemId, 'Curated context item ID'),
      responseRevision: value.responseRevision,
    }
  } catch (error) {
    throw new CollaborationError(
      503,
      'InvalidCollaborationRecord',
      'Curated context mutation receipt is invalid.',
      { cause: error },
    )
  }
}

/**
 * Builds a deterministic context current-snapshot write with a revision fence.
 *
 * @param tableName - Collaboration table name.
 * @param item - New current snapshot.
 * @param expectedRevision - Revision expected in the current row.
 * @returns DynamoDB transaction item.
 */
function contextSnapshotPut(
  tableName: string,
  item: StoredCuratedContextItem,
  expectedRevision: number,
) {
  return {
    Put: {
      TableName: tableName,
      Item: item,
      ConditionExpression: 'attribute_exists(entityKey) AND attribute_exists(recordKey) AND #revision = :expectedRevision',
      ExpressionAttributeNames: { '#revision': 'revision' },
      ExpressionAttributeValues: { ':expectedRevision': expectedRevision },
    },
  }
}

/**
 * Builds an append-only context revision transaction row.
 *
 * @param tableName - Collaboration table name.
 * @param item - Snapshot represented by the revision.
 * @returns DynamoDB transaction item.
 */
function contextRevisionPut(tableName: string, item: StoredCuratedContextItem) {
  return {
    Put: {
      TableName: tableName,
      Item: {
        entityKey: item.entityKey,
        recordKey: contextRevisionRecordKey(item.id, item.revision),
        entryType: 'context-revision',
        itemId: item.id,
        revision: item.revision,
        snapshot: toCuratedContextItem(item),
        createdAt: item.updatedAt,
      },
      ConditionExpression: 'attribute_not_exists(entityKey) AND attribute_not_exists(recordKey)',
    },
  }
}

/**
 * Builds the atomic generation increment for one curated-context ledger.
 *
 * @param tableName - Collaboration table name.
 * @param entityKey - Work Item collaboration entity key.
 * @returns DynamoDB transaction item that increments the ledger generation.
 */
function contextLedgerIncrement(tableName: string, entityKey: string) {
  return {
    Update: {
      TableName: tableName,
      Key: { entityKey, recordKey: CURATED_CONTEXT_LEDGER_RECORD_KEY },
      UpdateExpression:
        'SET #entryType = :entryType, #generation = if_not_exists(#generation, :zero) + :one',
      ConditionExpression:
        'attribute_not_exists(#entityKey) OR ' +
        '(#entryType = :entryType AND #generation >= :zero)',
      ExpressionAttributeNames: {
        '#entityKey': 'entityKey',
        '#entryType': 'entryType',
        '#generation': 'generation',
      },
      ExpressionAttributeValues: {
        ':entryType': 'context-ledger',
        ':zero': 0,
        ':one': 1,
      },
    },
  }
}

/**
 * Builds an append-only receipt that points to an immutable mutation response revision.
 *
 * @param tableName - Collaboration table name.
 * @param context - Request identity and fingerprint.
 * @param operation - Curated-context mutation kind.
 * @param item - Successful response snapshot stored in the same transaction.
 * @returns DynamoDB transaction item.
 */
function contextMutationReceiptPut(
  tableName: string,
  context: MutationAuditContext,
  operation: StoredCuratedContextMutationReceipt['operation'],
  item: StoredCuratedContextItem,
) {
  return {
    Put: {
      TableName: tableName,
      Item: {
        entityKey: item.entityKey,
        recordKey: contextMutationReceiptRecordKey(context),
        entryType: 'context-mutation-receipt',
        operation,
        requestFingerprint: context.requestFingerprint,
        itemId: item.id,
        responseRevision: item.revision,
      } satisfies StoredCuratedContextMutationReceipt,
      ConditionExpression: 'attribute_not_exists(entityKey) AND attribute_not_exists(recordKey)',
    },
  }
}

/**
 * Creates the immutable order projection for a new context item.
 *
 * @param item - Stored current snapshot.
 * @returns Order projection row.
 */
function createContextOrderRow(item: StoredCuratedContextItem): StoredCuratedContextOrder {
  return {
    entityKey: item.entityKey,
    recordKey: contextOrderRecordKey(item.createdAt, item.id),
    entryType: 'context-order',
    itemId: item.id,
    createdAt: item.createdAt,
  }
}

/**
 * Creates a non-public marker for replaying one curated-context mutation.
 *
 * @param context - Optional request idempotency and fingerprint context.
 * @returns A deterministic marker, or undefined for non-idempotent internal calls.
 */
function createCuratedContextMutationKey(
  context: MutationAuditContext | undefined,
): string | undefined {
  if (!context) return undefined

  return createHash('sha256')
    .update(`${context.idempotencyKeyHash}\0${context.requestFingerprint}`)
    .digest('hex')
}

/**
 * Creates a receipt key from the idempotency identity without the request fingerprint.
 *
 * Keeping the fingerprint out of the physical key lets a reused idempotency key be
 * detected and rejected instead of silently creating a second receipt.
 *
 * @param context - Request identity whose raw idempotency key has already been hashed.
 * @returns DynamoDB record key for the mutation receipt.
 */
function contextMutationReceiptRecordKey(context: MutationAuditContext) {
  const idempotencyKeyHash = requireTextValue(
    context.idempotencyKeyHash,
    'Curated context idempotency key hash',
    256,
  )
  const digest = createHash('sha256')
    .update(`curated-context-receipt-v1\0${idempotencyKeyHash}`)
    .digest('hex')
  return `CONTEXT_RECEIPT#${digest}`
}

/**
 * Creates a deterministic curated context item identifier.
 *
 * @param occurredAt - Mutation timestamp.
 * @param context - Optional idempotent audit context.
 * @param entityKey - Collaboration entity key.
 * @returns Stable context item identifier.
 */
function createContextItemId(
  occurredAt: string,
  context: MutationAuditContext | undefined,
  entityKey: string,
) {
  if (context) {
    const digest = createHash('sha256')
      .update(`${entityKey}\0context\0${context.idempotencyKeyHash}\0${context.requestFingerprint}`)
      .digest('hex')
      .slice(0, 40)
    return `ctx_${digest}`
  }
  const digest = createHash('sha256')
    .update(`${entityKey}\0${occurredAt}\0${randomUUID()}`)
    .digest('hex')
    .slice(0, 24)
  return `ctx_${occurredAt.replace(/[^0-9]/g, '').slice(0, 17)}_${digest}`
}

/**
 * Creates a deterministic accepted resolution identifier.
 *
 * @param occurredAt - Mutation timestamp.
 * @param context - Optional idempotent audit context.
 * @param entityKey - Collaboration entity key.
 * @param rootCommentId - Owning root comment identifier.
 * @param sourceCommentId - Accepted source comment identifier.
 * @param rootVersion - Root version before the mutation.
 * @returns Stable accepted resolution identifier.
 */
function createAcceptedResolutionId(
  occurredAt: string,
  context: MutationAuditContext | undefined,
  entityKey: string,
  rootCommentId: string,
  sourceCommentId: string,
  rootVersion: number,
) {
  const seed = context
    ? `${context.idempotencyKeyHash}\0${context.requestFingerprint}`
    : `${occurredAt}\0${randomUUID()}`
  const digest = createHash('sha256')
    .update(`${entityKey}\0${rootCommentId}\0${sourceCommentId}\0${rootVersion}\0${seed}`)
    .digest('hex')
    .slice(0, 40)
  return `res_${digest}`
}

/**
 * Creates the current-snapshot record key for a context item.
 *
 * @param itemId - Curated context item identifier.
 * @returns DynamoDB record key.
 */
function contextItemRecordKey(itemId: string) {
  return `CONTEXT#${encodeURIComponent(requireIdentifier(itemId, 'Curated context item ID'))}`
}

/**
 * Creates the deterministic order projection key for a context item.
 *
 * @param createdAt - Item creation timestamp.
 * @param itemId - Curated context item identifier.
 * @returns DynamoDB record key.
 */
function contextOrderRecordKey(createdAt: string, itemId: string) {
  return `CONTEXT_ORDER#${createdAt}#${encodeURIComponent(itemId)}`
}

/**
 * Creates the append-only revision key for a context item.
 *
 * @param itemId - Curated context item identifier.
 * @param revision - Positive item revision.
 * @returns DynamoDB record key.
 */
function contextRevisionRecordKey(itemId: string, revision: number) {
  return `CONTEXT_REVISION#${encodeURIComponent(itemId)}#${String(revision).padStart(12, '0')}`
}

/**
 * Encodes a scope-bound curated context cursor.
 *
 * @param cursor - Validated cursor payload.
 * @returns Opaque cursor string.
 */
function encodeCuratedContextCursor(cursor: CuratedContextCursor) {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/**
 * Decodes and validates a scope-bound curated context cursor.
 *
 * @param value - Opaque cursor string.
 * @param entityKey - Expected collaboration scope.
 * @returns DynamoDB exclusive-start key when supplied.
 */
function decodeCuratedContextCursor(value: string | undefined, entityKey: string) {
  if (!value) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!isRecord(parsed) ||
        parsed.version !== 2 ||
        parsed.entityKey !== entityKey ||
        parsed.prefix !== 'CONTEXT_ORDER#' ||
        typeof parsed.recordKey !== 'string' ||
        !parsed.recordKey.startsWith('CONTEXT_ORDER#') ||
        !isNonNegativeSafeInteger(parsed.generation)) {
      throw new Error('cursor mismatch')
    }
    return {
      key: { entityKey, recordKey: parsed.recordKey },
      generation: parsed.generation,
    }
  } catch (error) {
    throw new CollaborationError(
      400,
      'InvalidCollaborationCursor',
      'Curated context cursor is invalid.',
      { cause: error },
    )
  }
}

/**
 * Encodes a scope- and thread-bound accepted resolution history cursor.
 *
 * @param cursor - Validated cursor payload.
 * @returns Opaque cursor string.
 */
function encodeAcceptedResolutionCursor(cursor: AcceptedResolutionCursor) {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/**
 * Captures the root snapshot that an accepted-resolution cursor must continue from.
 *
 * @param root - Current root comment snapshot.
 * @returns Version and accepted-resolution pointer bound to the cursor.
 */
function acceptedResolutionCursorSnapshot(
  root: Pick<StoredComment, 'version' | 'acceptedResolutionId'>,
): Pick<AcceptedResolutionCursor, 'rootVersion' | 'acceptedResolutionId'> {
  return {
    rootVersion: root.version,
    acceptedResolutionId: root.acceptedResolutionId ?? null,
  }
}

/**
 * Decodes and validates an accepted resolution history cursor.
 *
 * @param value - Opaque cursor string.
 * @param entityKey - Expected collaboration scope.
 * @param rootCommentId - Expected owning root comment.
 * @returns Validated cursor, or undefined for the first page.
 */
function decodeAcceptedResolutionCursor(
  value: string | undefined,
  entityKey: string,
  rootCommentId: string,
): AcceptedResolutionCursor | undefined {
  if (!value) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!isRecord(parsed) ||
        parsed.version !== 2 ||
        parsed.entityKey !== entityKey ||
        parsed.rootCommentId !== rootCommentId ||
        (parsed.phase !== 'append' && parsed.phase !== 'legacy')) {
      throw new Error('cursor mismatch')
    }
    const rawAcceptedResolutionId = parsed.acceptedResolutionId
    if (!isPositiveSafeInteger(parsed.rootVersion) ||
        !(rawAcceptedResolutionId === null || typeof rawAcceptedResolutionId === 'string')) {
      throw new Error('root snapshot mismatch')
    }
    const acceptedResolutionId = rawAcceptedResolutionId === null
      ? null
      : requireIdentifier(rawAcceptedResolutionId, 'Accepted resolution pointer')
    if (parsed.phase === 'append') {
      if (typeof parsed.recordKey !== 'string' ||
          !parsed.recordKey.startsWith(acceptedResolutionRecordPrefix(rootCommentId))) {
        throw new Error('append cursor mismatch')
      }
      return {
        version: 2,
        entityKey,
        rootCommentId,
        rootVersion: parsed.rootVersion,
        acceptedResolutionId,
        phase: 'append',
        recordKey: parsed.recordKey,
      }
    }
    if (!isNonNegativeSafeInteger(parsed.legacyOffset)) {
      throw new Error('legacy cursor mismatch')
    }
    return {
      version: 2,
      entityKey,
      rootCommentId,
      rootVersion: parsed.rootVersion,
      acceptedResolutionId,
      phase: 'legacy',
      legacyOffset: parsed.legacyOffset,
    }
  } catch (error) {
    throw new CollaborationError(
      400,
      'InvalidCollaborationCursor',
      'Accepted resolution cursor is invalid.',
      { cause: error },
    )
  }
}

/**
 * Builds context mention notification candidates with actor suppression.
 *
 * @param input - Context mutation input.
 * @returns Deduplicated notification candidates.
 */
function buildContextNotificationCandidates(input: CuratedContextMutationInput & {
  /** Mention member keys present in the mutation payload. */
  mentionMemberKeys?: string[]
}) {
  const candidates: CollaborationNotificationCandidate[] = [
    ...(input.notificationCandidates ?? []),
    ...normalizeMentionMemberKeys(input.mentionMemberKeys).map((memberKey) => ({
      memberKey,
      reason: 'mention',
    })),
  ]
  return dedupeNotificationCandidates(candidates, input.actor.id)
}

/**
 * Creates notification and activity metadata for a context mutation.
 *
 * @param input - Context mutation scope.
 * @param actorMemberKey - Normalized actor member key.
 * @param contextItemId - Mutated context item identifier.
 * @param sourceRevision - Canonical revision represented by the audit event.
 * @param notificationCandidates - Deduplicated recipient candidates.
 * @returns Audit metadata.
 */
function createContextAuditMetadata(
  input: CuratedContextMutationInput,
  actorMemberKey: string,
  contextItemId: string,
  sourceRevision: number,
  notificationCandidates: CollaborationNotificationCandidate[],
) {
  return {
    actorMemberKey: normalizeMemberKey(actorMemberKey),
    contextItemId,
    sourceRevision,
    teamId: input.teamId,
    issueId: input.issueId,
    projectId: input.projectId,
    notificationTitle: input.workItemTitle,
    deepLink: appendContextDeepLink(input.deepLink, contextItemId),
    notificationCandidates,
  }
}

/**
 * Adds context focus to an optional collaboration deep link.
 *
 * @param deepLink - Base Web path.
 * @param contextItemId - Context item to focus.
 * @returns Focused deep link when a base path exists.
 */
function appendContextDeepLink(deepLink: string | undefined, contextItemId: string) {
  if (!deepLink) {
    return undefined
  }
  const [pathAndQuery, fragment] = deepLink.split('#', 2)
  const separator = pathAndQuery.includes('?') ? '&' : '?'
  const focusedPath = `${pathAndQuery}${separator}${new URLSearchParams({ contextItemId }).toString()}`
  return fragment ? `${focusedPath}#${fragment}` : focusedPath
}

/**
 * Creates audit metadata for accepted resolution mutations.
 *
 * @param input - Accepted resolution mutation input.
 * @param actorMemberKey - Normalized actor member key.
 * @param acceptedCommentId - Accepted or superseded source comment identifier.
 * @returns Audit metadata.
 */
function createAcceptedResolutionAuditMetadata(
  input: SetAcceptedResolutionInput,
  actorMemberKey: string,
  acceptedCommentId: string,
) {
  return {
    actorMemberKey: normalizeMemberKey(actorMemberKey),
    acceptedCommentId,
    rootCommentId: input.rootCommentId,
    teamId: input.teamId,
    issueId: input.issueId,
    projectId: input.projectId,
    notificationTitle: input.workItemTitle,
    deepLink: appendCommentDeepLink(
      input.deepLink,
      acceptedCommentId,
      input.rootCommentId,
    ),
    notificationCandidates: [],
  }
}

/**
 * Validates a display-safe actor snapshot.
 *
 * @param value - Untrusted actor snapshot.
 * @param label - Validation label.
 * @returns Normalized actor snapshot.
 */
function normalizeContextActor(value: unknown, label: string): CuratedContextActorSnapshot {
  if (!isRecord(value)) {
    throw new CollaborationError(400, 'InvalidContextActor', `${label} is invalid.`)
  }
  const id = requireTextValue(value.id, `${label} ID`, 512)
  const displayName = requireTextValue(value.displayName, `${label} display name`, 200)
  const avatarUrl = value.avatarUrl === undefined
    ? undefined
    : requireSafeUrl(value.avatarUrl, `${label} avatar URL`)
  return {
    id,
    displayName,
    ...(avatarUrl ? { avatarUrl } : {}),
  }
}

/**
 * Validates a curated context provenance snapshot.
 *
 * @param value - Untrusted provenance value.
 * @returns Normalized provenance.
 */
function normalizeCuratedContextSource(value: unknown): CuratedContextSource {
  if (!isRecord(value)) {
    throw new CollaborationError(400, 'InvalidContextSource', 'Curated context source is invalid.')
  }
  const kind = requireCuratedContextSourceKind(value.kind)
  const sourceId = requireTextValue(value.sourceId, 'Curated context source ID', 1_024)
  const containerId = value.containerId === undefined
    ? undefined
    : requireTextValue(value.containerId, 'Curated context source container ID', 1_024)
  const originalBody = value.originalBody === undefined
    ? undefined
    : requireBoundedExactText(
        value.originalBody,
        'Curated context source original body',
        COLLABORATION_CONTEXT_BODY_MAX_LENGTH,
      )
  const quote = value.quote === undefined
    ? undefined
    : normalizeCuratedContextQuote(value.quote, originalBody)
  const permalink = value.permalink === undefined
    ? undefined
    : requireSafeUrl(value.permalink, 'Curated context source permalink', true)
  const actor = value.actor === undefined
    ? undefined
    : normalizeContextActor(value.actor, 'Curated context source actor')
  const occurredAt = normalizeIsoTimestamp(value.occurredAt, 'Curated context source occurredAt')
  const capturedRevision = normalizeSourceRevision(
    value.capturedRevision,
    'Curated context captured source revision',
  )
  const currentRevision = normalizeSourceRevision(
    value.currentRevision,
    'Curated context current source revision',
  )
  const availability = requireCuratedContextSourceAvailability(value.availability)
  const availabilityReason = value.availabilityReason === undefined
    ? undefined
    : requireTextValue(
        value.availabilityReason,
        'Curated context source availability reason',
        1_000,
      )
  return {
    kind,
    sourceId,
    ...(containerId ? { containerId } : {}),
    ...(originalBody !== undefined ? { originalBody } : {}),
    ...(quote ? { quote } : {}),
    ...(permalink ? { permalink } : {}),
    ...(actor ? { actor } : {}),
    occurredAt,
    ...(capturedRevision !== undefined ? { capturedRevision } : {}),
    ...(currentRevision !== undefined ? { currentRevision } : {}),
    availability,
    ...(availabilityReason ? { availabilityReason } : {}),
  }
}

/**
 * Validates a quote and its optional UTF-16 range against an original body.
 *
 * @param value - Untrusted quote value.
 * @param originalBody - Capture-time original body when available.
 * @returns Normalized quote.
 */
function normalizeCuratedContextQuote(
  value: unknown,
  originalBody: string | undefined,
): CuratedContextQuote {
  if (!isRecord(value)) {
    throw new CollaborationError(400, 'InvalidContextQuote', 'Curated context quote is invalid.')
  }
  const text = requireTextValue(
    value.text,
    'Curated context quote text',
    COLLABORATION_CONTEXT_BODY_MAX_LENGTH,
    false,
    true,
    true,
  )
  const hasStart = value.startOffset !== undefined
  const hasEnd = value.endOffset !== undefined
  if (hasStart !== hasEnd) {
    throw new CollaborationError(
      400,
      'InvalidContextQuote',
      'Quote startOffset and endOffset must be supplied together.',
    )
  }
  if (!hasStart || !hasEnd) {
    if (originalBody !== undefined && !originalBody.includes(text)) {
      throw new CollaborationError(
        400,
        'InvalidContextQuote',
        'Quote text is not present in the captured source body.',
      )
    }
    return { text }
  }
  if (!isNonNegativeSafeInteger(value.startOffset) ||
      !isNonNegativeSafeInteger(value.endOffset) ||
      value.startOffset >= value.endOffset ||
      (originalBody !== undefined && value.endOffset > originalBody.length) ||
      (originalBody !== undefined &&
        originalBody.slice(value.startOffset, value.endOffset) !== text)) {
    throw new CollaborationError(
      400,
      'InvalidContextQuote',
      'Curated context quote range is invalid.',
    )
  }
  return { text, startOffset: value.startOffset, endOffset: value.endOffset }
}

/**
 * Validates a source-native revision value.
 *
 * @param value - Untrusted revision.
 * @param label - Validation label.
 * @returns Normalized optional revision.
 */
function normalizeSourceRevision(value: unknown, label: string) {
  if (value === undefined) {
    return undefined
  }
  if (typeof value === 'string') {
    return requireTextValue(value, label, 512)
  }
  if (isNonNegativeSafeInteger(value)) {
    return value
  }
  throw new CollaborationError(400, 'InvalidContextSource', `${label} is invalid.`)
}

/**
 * Validates a curated context semantic kind.
 *
 * @param value - Untrusted kind.
 * @returns Supported semantic kind.
 */
function requireCuratedContextKind(value: unknown): CuratedContextItemKind {
  if (value === 'decision' || value === 'action' || value === 'risk' || value === 'context') {
    return value
  }
  throw new CollaborationError(400, 'InvalidContextKind', 'Curated context kind is invalid.')
}

/**
 * Validates any persisted curated context state.
 *
 * @param value - Untrusted state.
 * @returns Supported state.
 */
function requireCuratedContextState(value: unknown): CuratedContextItemState {
  if (value === 'active' || value === 'accepted' || value === 'completed' || value === 'superseded') {
    return value
  }
  throw new CollaborationError(400, 'InvalidContextState', 'Curated context state is invalid.')
}

/**
 * Validates a state available to in-place context updates.
 *
 * @param value - Untrusted state.
 * @returns Mutable state.
 */
function requireMutableCuratedContextState(value: unknown): Exclude<CuratedContextItemState, 'superseded'> {
  const state = requireCuratedContextState(value)
  if (state === 'superseded') {
    throw new CollaborationError(
      400,
      'InvalidContextState',
      'Use atomic replacement to supersede a curated context item.',
    )
  }
  return state
}

/**
 * Validates a curated context source kind.
 *
 * @param value - Untrusted source kind.
 * @returns Supported source kind.
 */
function requireCuratedContextSourceKind(value: unknown): CuratedContextSourceKind {
  if (value === 'comment' || value === 'external-chat' || value === 'document' || value === 'activity') {
    return value
  }
  throw new CollaborationError(400, 'InvalidContextSource', 'Curated context source kind is invalid.')
}

/**
 * Validates a curated context source availability state.
 *
 * @param value - Untrusted availability state.
 * @returns Supported availability state.
 */
function requireCuratedContextSourceAvailability(
  value: unknown,
): CuratedContextSourceAvailability {
  if (value === 'available' ||
      value === 'edited' ||
      value === 'deleted' ||
      value === 'permission-lost' ||
      value === 'retention-expired') {
    return value
  }
  throw new CollaborationError(
    400,
    'InvalidContextSource',
    'Curated context source availability is invalid.',
  )
}

/**
 * Normalizes a curated context title.
 *
 * @param value - Untrusted title.
 * @returns Normalized title.
 */
function normalizeContextTitle(value: unknown) {
  return requireTextValue(
    value,
    'Curated context title',
    COLLABORATION_CONTEXT_TITLE_MAX_LENGTH,
  )
}

/**
 * Normalizes a curated context Markdown body or accepted-resolution summary.
 *
 * @param value - Untrusted text.
 * @param label - Validation label.
 * @returns Normalized text.
 */
function normalizeContextBody(value: unknown, label: string) {
  return requireTextValue(value, label, COLLABORATION_CONTEXT_BODY_MAX_LENGTH, false)
}

/**
 * Validates a positive context revision.
 *
 * @param value - Untrusted expected revision.
 */
function assertExpectedContextRevision(value: number) {
  if (!isPositiveSafeInteger(value)) {
    throw new CollaborationError(
      400,
      'InvalidContextRevision',
      'A positive expectedRevision is required.',
    )
  }
}

/**
 * Validates and canonicalizes an ISO 8601 timestamp.
 *
 * @param value - Untrusted timestamp.
 * @param label - Validation label.
 * @returns Canonical timestamp.
 */
function normalizeIsoTimestamp(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CollaborationError(400, 'InvalidContextTimestamp', `${label} is required.`)
  }
  const timestamp = new Date(value)
  if (!Number.isFinite(timestamp.getTime())) {
    throw new CollaborationError(400, 'InvalidContextTimestamp', `${label} is invalid.`)
  }
  return timestamp.toISOString()
}

/**
 * Validates bounded, non-empty text and optionally trims surrounding whitespace.
 *
 * @param value - Untrusted text.
 * @param label - Validation label.
 * @param maxLength - Maximum UTF-16 length.
 * @param trim - Whether to trim surrounding whitespace.
 * @param allowCarriageReturn - Whether carriage returns are valid in exact text.
 * @param preserveLineEndings - Whether line endings must remain byte-for-byte unchanged.
 * @returns Validated text.
 */
function requireTextValue(
  value: unknown,
  label: string,
  maxLength: number,
  trim = true,
  allowCarriageReturn = false,
  preserveLineEndings = false,
) {
  if (typeof value !== 'string') {
    throw new CollaborationError(400, 'InvalidCollaborationInput', `${label} must be text.`)
  }
  const normalized = preserveLineEndings
    ? value
    : trim
      ? value.replace(/\r\n?/g, '\n').trim()
      : value.replace(/\r\n?/g, '\n')
  if (!normalized.trim()) {
    throw new CollaborationError(400, 'InvalidCollaborationInput', `${label} is required.`)
  }
  if (normalized.length > maxLength) {
    throw new CollaborationError(400, 'InvalidCollaborationInput', `${label} is too long.`)
  }
  if (hasUnsafeControlCharacter(normalized, allowCarriageReturn)) {
    throw new CollaborationError(
      400,
      'InvalidCollaborationInput',
      `${label} contains control characters.`,
    )
  }
  return normalized
}

/**
 * Validates bounded exact text while preserving whitespace.
 *
 * @param value - Untrusted text.
 * @param label - Validation label.
 * @param maxLength - Maximum UTF-16 length.
 * @returns Validated exact text.
 */
function requireBoundedExactText(value: unknown, label: string, maxLength: number) {
  if (
    typeof value !== 'string' ||
    value.length > maxLength ||
    hasUnsafeControlCharacter(value, true)
  ) {
    throw new CollaborationError(400, 'InvalidContextSource', `${label} is invalid.`)
  }
  return value
}

/**
 * Validates a retained URL or application-relative permalink.
 *
 * @param value - Untrusted URL.
 * @param label - Validation label.
 * @param allowRelative - Whether an application-relative path is accepted.
 * @returns Validated URL.
 */
function requireSafeUrl(value: unknown, label: string, allowRelative = false) {
  const url = requireTextValue(value, label, 2_048)
  if (allowRelative && url.startsWith('/') && !url.startsWith('//')) {
    return url
  }
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('unsupported protocol')
    }
    return parsed.toString()
  } catch (error) {
    throw new CollaborationError(400, 'InvalidContextSource', `${label} is invalid.`, {
      cause: error,
    })
  }
}

/**
 * Tests whether a value is a plain object-like record.
 *
 * @param value - Unknown value.
 * @returns Whether record property access is safe.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Tests whether a value is a positive safe integer.
 *
 * @param value - Unknown value.
 * @returns Whether the value is a positive safe integer.
 */
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/**
 * Tests whether a value is a non-negative safe integer.
 *
 * @param value - Unknown value.
 * @returns Whether the value is a non-negative safe integer.
 */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Parses accepted resolution history from a stored root comment.
 *
 * @param value - Untrusted stored history.
 * @param rootCommentId - Root comment owning the history.
 * @returns Validated accepted and superseded resolution entries.
 */
function normalizeAcceptedResolutions(value: unknown, rootCommentId: string) {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value)) {
    throw new CollaborationError(
      503,
      'InvalidCollaborationRecord',
      'Accepted resolution history is invalid.',
    )
  }
  const resolutions = value.map((entry): AcceptedResolution => {
    if (!isRecord(entry) ||
        !isPositiveSafeInteger(entry.capturedCommentRevision) ||
        (entry.state !== 'accepted' && entry.state !== 'superseded')) {
      throw new CollaborationError(
        503,
        'InvalidCollaborationRecord',
        'Accepted resolution history is invalid.',
      )
    }
    try {
      const id = requireIdentifierValue(entry.id, 'Accepted resolution ID')
      const sourceCommentId = requireIdentifierValue(
        entry.sourceCommentId,
        'Accepted resolution source comment ID',
      )
      const sourceRootCommentId = requireIdentifierValue(
        entry.sourceRootCommentId,
        'Accepted resolution source root comment ID',
      )
      if (sourceRootCommentId !== rootCommentId) {
        throw new Error('accepted resolution root mismatch')
      }
      const capturedCommentAuthorMemberKey = entry.capturedCommentAuthorMemberKey === undefined
        ? undefined
        : requireIdentifierValue(
            entry.capturedCommentAuthorMemberKey,
            'Accepted resolution captured comment author member key',
          )
      const base = {
        id,
        sourceCommentId,
        sourceRootCommentId,
        capturedCommentRevision: entry.capturedCommentRevision,
        capturedCommentBody: requireTextValue(
          entry.capturedCommentBody,
          'Accepted resolution captured comment body',
          COLLABORATION_COMMENT_MAX_LENGTH,
          false,
        ),
        ...(capturedCommentAuthorMemberKey
          ? { capturedCommentAuthorMemberKey }
          : {}),
        summary: normalizeContextBody(entry.summary, 'Accepted resolution summary'),
        acceptedBy: normalizeContextActor(entry.acceptedBy, 'Accepted resolution actor'),
        acceptedAt: normalizeIsoTimestamp(entry.acceptedAt, 'Accepted resolution acceptedAt'),
      }
      if (entry.state === 'accepted') {
        return { ...base, state: 'accepted' }
      }
      return {
        ...base,
        state: 'superseded',
        supersededByResolutionId: requireIdentifierValue(
          entry.supersededByResolutionId,
          'Superseding accepted resolution ID',
        ),
        supersededBy: normalizeContextActor(
          entry.supersededBy,
          'Accepted resolution superseding actor',
        ),
        supersededAt: normalizeIsoTimestamp(
          entry.supersededAt,
          'Accepted resolution supersededAt',
        ),
      }
    } catch (error) {
      throw new CollaborationError(
        503,
        'InvalidCollaborationRecord',
        'Accepted resolution history is invalid.',
        { cause: error },
      )
    }
  })
  if (new Set(resolutions.map((resolution) => resolution.id)).size !== resolutions.length ||
      resolutions.filter((resolution) => resolution.state === 'accepted').length > 1) {
    throw new CollaborationError(
      503,
      'InvalidCollaborationRecord',
      'Accepted resolution history is invalid.',
    )
  }
  return resolutions
}

/**
 * Validates a required identifier from an unknown stored value.
 *
 * @param value - Untrusted identifier.
 * @param label - Validation label.
 * @returns Validated identifier.
 */
function requireIdentifierValue(value: unknown, label: string) {
  if (typeof value !== 'string') {
    throw new CollaborationError(400, 'InvalidCollaborationIdentifier', `${label} is required.`)
  }
  return requireIdentifier(value, label)
}

/**
 * Serializes a hydrated comment without derived reactions or resolution history.
 *
 * @param comment - Hydrated stored comment.
 * @returns Bounded physical comment row.
 */
function toStoredCommentStorageItem(comment: StoredComment) {
  const currentResolution = comment.acceptedResolutions.find(
    (resolution) => resolution.state === 'accepted',
  )
  return {
    entityKey: comment.entityKey,
    recordKey: comment.recordKey,
    entryType: 'comment',
    id: comment.id,
    rootCommentId: comment.rootCommentId,
    ...(comment.parentCommentId ? { parentCommentId: comment.parentCommentId } : {}),
    authorMemberKey: comment.authorMemberKey,
    bodyMarkdown: comment.bodyMarkdown,
    version: comment.version,
    mentionMemberKeys: comment.mentionMemberKeys,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    ...(comment.editedAt ? { editedAt: comment.editedAt } : {}),
    ...(comment.deletedAt ? { deletedAt: comment.deletedAt } : {}),
    ...(comment.resolvedAt ? { resolvedAt: comment.resolvedAt } : {}),
    ...(comment.resolvedByMemberKey
      ? { resolvedByMemberKey: comment.resolvedByMemberKey }
      : {}),
    ...(comment.acceptedResolutionId
      ? { acceptedResolutionId: comment.acceptedResolutionId }
      : {}),
    ...(currentResolution ? { acceptedResolution: currentResolution } : {}),
    ...(comment.legacyAcceptedResolutions.length > 0
      ? { acceptedResolutions: comment.legacyAcceptedResolutions }
      : {}),
  }
}

/**
 * Serializes the original successful accepted-resolution response for a receipt.
 *
 * @param comment - Successful bounded root response.
 * @returns Physical comment-shaped snapshot without legacy inline history.
 */
function toAcceptedResolutionReceiptStorageResponse(comment: StoredComment) {
  return toStoredCommentStorageItem({
    ...comment,
    bodyMarkdown: '',
    mentionMemberKeys: [],
    legacyAcceptedResolutions: [],
  })
}

/**
 * Builds an append-only accepted resolution transaction row.
 *
 * @param tableName - Collaboration table name.
 * @param entityKey - Collaboration entity key.
 * @param rootCommentId - Owning root comment identifier.
 * @param resolution - Accepted or superseded resolution snapshot.
 * @param recordedAt - Mutation timestamp for the append-only row.
 * @returns DynamoDB transaction item.
 */
function acceptedResolutionPut(
  tableName: string,
  entityKey: string,
  rootCommentId: string,
  resolution: AcceptedResolution,
  recordedAt: string,
) {
  const item: StoredAcceptedResolution = {
    entityKey,
    recordKey: acceptedResolutionRecordKey(
      rootCommentId,
      recordedAt,
      resolution.id,
      resolution.state,
    ),
    entryType: 'accepted-resolution',
    rootCommentId,
    resolution,
    recordedAt,
  }
  return {
    Put: {
      TableName: tableName,
      Item: item,
      ConditionExpression: 'attribute_not_exists(entityKey) AND attribute_not_exists(recordKey)',
    },
  }
}

/**
 * Builds a durable accepted-resolution idempotency receipt transaction row.
 *
 * @param tableName - Collaboration table name.
 * @param entityKey - Collaboration entity key.
 * @param rootCommentId - Owning root comment identifier.
 * @param resolutionId - Deterministic resolution identifier.
 * @param context - Request identity and fingerprint bound to the receipt.
 * @param response - Original successful bounded root response.
 * @returns DynamoDB transaction item.
 */
function acceptedResolutionReceiptPut(
  tableName: string,
  entityKey: string,
  rootCommentId: string,
  resolutionId: string,
  context: MutationAuditContext,
  response: StoredComment,
) {
  const item = {
    entityKey,
    recordKey: acceptedResolutionReceiptRecordKey(context),
    entryType: 'accepted-resolution-receipt',
    rootCommentId,
    resolutionId,
    requestFingerprint: context.requestFingerprint,
    response: toAcceptedResolutionReceiptStorageResponse(response),
  } satisfies StoredAcceptedResolutionReceipt
  return {
    Put: {
      TableName: tableName,
      Item: item,
      ConditionExpression: 'attribute_not_exists(entityKey) AND attribute_not_exists(recordKey)',
    },
  }
}

/**
 * Parses an append-only accepted resolution row.
 *
 * @param value - DynamoDB document value.
 * @param expectedRootCommentId - Root comment being hydrated.
 * @returns Validated append-only row.
 */
function toStoredAcceptedResolution(
  value: Record<string, unknown>,
  expectedRootCommentId: string,
): StoredAcceptedResolution {
  try {
    if (value.entryType !== 'accepted-resolution' ||
        typeof value.entityKey !== 'string' ||
        typeof value.recordKey !== 'string' ||
        value.rootCommentId !== expectedRootCommentId ||
        typeof value.recordedAt !== 'string') {
      throw new Error('invalid accepted resolution row')
    }
    const [resolution] = normalizeAcceptedResolutions([value.resolution], expectedRootCommentId)
    if (!resolution) {
      throw new Error('missing accepted resolution snapshot')
    }
    const recordedAt = normalizeIsoTimestamp(value.recordedAt, 'Accepted resolution recordedAt')
    const currentRecordKey = acceptedResolutionRecordKey(
      expectedRootCommentId,
      recordedAt,
      resolution.id,
      resolution.state,
    )
    const legacyRecordKey = legacyAcceptedResolutionRecordKey(
      expectedRootCommentId,
      recordedAt,
      resolution.id,
      resolution.state,
    )
    if (value.recordKey !== currentRecordKey && value.recordKey !== legacyRecordKey) {
      throw new Error('invalid accepted resolution record key')
    }
    return {
      entityKey: requireIdentifier(value.entityKey, 'Collaboration entity key'),
      recordKey: value.recordKey,
      entryType: 'accepted-resolution',
      rootCommentId: expectedRootCommentId,
      resolution,
      recordedAt,
    }
  } catch (error) {
    throw new CollaborationError(
      503,
      'InvalidCollaborationRecord',
      'Accepted resolution row is invalid.',
      { cause: error },
    )
  }
}

/**
 * Parses a durable accepted-resolution idempotency receipt.
 *
 * @param value - DynamoDB document value.
 * @param expectedEntityKey - Collaboration scope expected by the caller.
 * @param expectedRecordKey - Receipt key derived from the idempotency identity.
 * @returns Validated receipt and original successful response snapshot.
 */
function toStoredAcceptedResolutionReceipt(
  value: Record<string, unknown>,
  expectedEntityKey: string,
  expectedRecordKey: string,
) {
  try {
    if (value.entryType !== 'accepted-resolution-receipt' ||
        value.entityKey !== expectedEntityKey ||
        value.recordKey !== expectedRecordKey ||
        typeof value.rootCommentId !== 'string' ||
        typeof value.resolutionId !== 'string' ||
        typeof value.requestFingerprint !== 'string' ||
        !isRecord(value.response)) {
      throw new Error('invalid accepted resolution receipt')
    }
    const rootCommentId = requireIdentifier(value.rootCommentId, 'Root comment ID')
    const resolutionId = requireIdentifier(value.resolutionId, 'Accepted resolution ID')
    const requestFingerprint = requireTextValue(
      value.requestFingerprint,
      'Accepted resolution request fingerprint',
      256,
    )
    const response = toStoredComment(value.response)
    if (response.entityKey !== expectedEntityKey ||
        response.id !== rootCommentId ||
        response.acceptedResolutionId !== resolutionId ||
        response.acceptedResolutions[0]?.id !== resolutionId) {
      throw new Error('accepted resolution receipt response mismatch')
    }
    return {
      entityKey: expectedEntityKey,
      recordKey: expectedRecordKey,
      entryType: 'accepted-resolution-receipt',
      rootCommentId,
      resolutionId,
      requestFingerprint,
      response,
    }
  } catch (error) {
    throw new CollaborationError(
      503,
      'InvalidCollaborationRecord',
      'Accepted resolution receipt is invalid.',
      { cause: error },
    )
  }
}

/**
 * Creates the query prefix for one root's append-only resolution history.
 *
 * @param rootCommentId - Root comment identifier.
 * @returns DynamoDB record-key prefix.
 */
function acceptedResolutionRecordPrefix(rootCommentId: string) {
  return `RESOLUTION#${encodeURIComponent(rootCommentId)}#`
}

/**
 * Creates a deterministic receipt key for one accepted-resolution mutation.
 *
 * @param context - Request identity whose raw idempotency key has already been hashed.
 * @returns DynamoDB record key.
 */
function acceptedResolutionReceiptRecordKey(context: MutationAuditContext) {
  const idempotencyKeyHash = requireTextValue(
    context.idempotencyKeyHash,
    'Accepted resolution idempotency key hash',
    256,
  )
  const digest = createHash('sha256')
    .update(`accepted-resolution-receipt-v2\0${idempotencyKeyHash}`)
    .digest('hex')
  return `RESOLUTION_RECEIPT#${digest}`
}

/**
 * Creates an append-only resolution history record key.
 *
 * @param rootCommentId - Root comment identifier.
 * @param recordedAt - Mutation timestamp.
 * @param resolutionId - Resolution identifier.
 * @param state - Snapshot state.
 * @returns DynamoDB record key.
 */
function acceptedResolutionRecordKey(
  rootCommentId: string,
  recordedAt: string,
  resolutionId: string,
  state: AcceptedResolution['state'],
) {
  const stateRank = state === 'accepted' ? '1' : '0'
  return `${acceptedResolutionRecordPrefix(rootCommentId)}${recordedAt}#${stateRank}#${encodeURIComponent(resolutionId)}#${state}`
}

/**
 * Creates the pre-rank history key retained for read compatibility.
 *
 * @param rootCommentId - Root comment identifier.
 * @param recordedAt - Mutation timestamp.
 * @param resolutionId - Resolution identifier.
 * @param state - Snapshot state.
 * @returns Legacy DynamoDB record key.
 */
function legacyAcceptedResolutionRecordKey(
  rootCommentId: string,
  recordedAt: string,
  resolutionId: string,
  state: AcceptedResolution['state'],
) {
  return `${acceptedResolutionRecordPrefix(rootCommentId)}${recordedAt}#${encodeURIComponent(resolutionId)}#${state}`
}

/** Physical comment row with the current accepted-resolution pointer. */
type StoredComment = CollaborationComment & {
  /** DynamoDB partition key です。 */
  entityKey: string
  /** DynamoDB sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'comment'
  /** Physical current snapshot と一致する accepted resolution ID です。 */
  acceptedResolutionId?: string
  /** 旧 schema の physical root row に残る inline history です。 */
  legacyAcceptedResolutions: AcceptedResolution[]
}

/** Durable provenance receipt for one successfully copied legacy comment. */
type StoredBackfillReceipt = {
  /** DynamoDB partition key shared with the copied comment. */
  entityKey: string
  /** DynamoDB sort key for the immutable migration receipt. */
  recordKey: string
  /** Row discriminator. */
  entryType: 'team-issue-comment-backfill-receipt'
  /** Stable legacy event identifier. */
  commentId: string
  /** Normalized actor copied from the legacy event. */
  sourceActorMemberKey: string
  /** Normalized timestamp copied from the legacy event. */
  sourceOccurredAt: string
  /** Digest of the legacy source identity and body. */
  sourceBodyFingerprint: string
}

/** Accepted resolution history の append-only row です。 */
type StoredAcceptedResolution = {
  /** DynamoDB partition key です。 */
  entityKey: string
  /** DynamoDB sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'accepted-resolution'
  /** Resolution を所有する root comment ID です。 */
  rootCommentId: string
  /** Append-only snapshot です。 */
  resolution: AcceptedResolution
  /** Snapshot を記録した日時です。 */
  recordedAt: string
}

/** Accepted resolution mutation の durable idempotency receipt です。 */
type StoredAcceptedResolutionReceipt = {
  /** DynamoDB partition key です。 */
  entityKey: string
  /** DynamoDB sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'accepted-resolution-receipt'
  /** Resolution を所有する root comment ID です。 */
  rootCommentId: string
  /** Deterministic accepted resolution ID です。 */
  resolutionId: string
  /** Canonical request fingerprint bound to the idempotency identity. */
  requestFingerprint: string
  /** Original successful mutation response の bounded snapshot です。 */
  response: ReturnType<typeof toAcceptedResolutionReceiptStorageResponse>
}

/** DynamoDB に保存する curated context current snapshot です。 */
type StoredCuratedContextItem = CuratedContextItem & {
  /** DynamoDB partition key です。 */
  entityKey: string
  /** DynamoDB sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'context'
  /** 最後に commit した API mutation を response-loss retry と照合する marker です。 */
  lastMutationKey?: string
}

/** Canonical source capture and the optional comment snapshot fenced at commit time. */
type CapturedCuratedContextSource = {
  /** Permission-checked immutable provenance stored on the context item. */
  source: CuratedContextSource
  /** Comment snapshot whose version and deletion state must still match at commit time. */
  comment?: StoredComment
}

/** Curated context 一覧の作成日時順 projection row です。 */
type StoredCuratedContextOrder = {
  /** DynamoDB partition key です。 */
  entityKey: string
  /** DynamoDB sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'context-order'
  /** Current snapshot を参照する item ID です。 */
  itemId: string
  /** Item の作成日時です。 */
  createdAt: string
}

/** Curated context item の append-only revision row です。 */
type StoredCuratedContextRevision = {
  /** DynamoDB partition key です。 */
  entityKey: string
  /** DynamoDB sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'context-revision'
  /** Revision history を所有する item ID です。 */
  itemId: string
  /** Snapshot と一致する positive revision です。 */
  revision: number
  /** Immutable public item snapshot です。 */
  snapshot: CuratedContextItem
  /** Snapshot を保存した ISO 8601 timestamp です。 */
  createdAt: string
}

/** Append-only receipt for one idempotent curated-context mutation. */
type StoredCuratedContextMutationReceipt = {
  /** DynamoDB partition key. */
  entityKey: string
  /** DynamoDB sort key derived from the idempotency identity. */
  recordKey: string
  /** Row discriminator. */
  entryType: 'context-mutation-receipt'
  /** Mutation kind bound to the receipt. */
  operation: 'create' | 'update'
  /** Canonical request fingerprint bound to the idempotency identity. */
  requestFingerprint: string
  /** Curated-context item returned by the original successful mutation. */
  itemId: string
  /** Immutable item revision returned by the original successful mutation. */
  responseRevision: number
}

/** Curated context cursor payload です。 */
type CuratedContextCursor = {
  /** Cursor schema version です。 */
  version: 2
  /** Cursor を発行した entity key です。 */
  entityKey: string
  /** Cursor を発行した row prefix です。 */
  prefix: 'CONTEXT_ORDER#'
  /** DynamoDB last evaluated sort key です。 */
  recordKey: string
  /** Context-ledger generation observed when the cursor was issued. */
  generation: number
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
  /** Opaque identity of the mutation that produced the row, when one was supplied. */
  mutationIdentity?: string
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

/** Cursor used to continue reading the migration-aware discussion indexes. */
type DiscussionCursor = {
  /** Cursor schema version. */
  version: 2
  /** Entity key that owns the cursor. */
  entityKey: string
  /** Current discussion index prefix bound to the cursor. */
  currentPrefix: string
  /** Legacy discussion index prefix bound to the cursor. */
  legacyPrefix: string
  /** Index phase used by the next page. */
  phase: 'current' | 'legacy'
  /** DynamoDB last evaluated sort key for the current phase. */
  recordKey?: string
}

/** Cursor shape emitted by the pre-timeline discussion index. */
type LegacyDiscussionCursor = {
  /** Cursor schema version. */
  version: 1
  /** Entity key that owns the cursor. */
  entityKey: string
  /** Legacy discussion prefix bound to the cursor. */
  prefix: string
  /** DynamoDB last evaluated sort key. */
  recordKey: string
}

/** Generic version-one cursor used by older single-prefix Collaboration readers. */
type PrefixCursor = {
  /** Cursor schema version. */
  version: 1
  /** Entity key that owns the cursor. */
  entityKey: string
  /** Physical row prefix bound to the cursor. */
  prefix: string
  /** DynamoDB last evaluated sort key. */
  recordKey: string
}

/** Two physical discussion indexes that make a read migration-safe. */
type DiscussionReadPlan = {
  /** Chronologically ordered index prefix introduced by the migration. */
  currentPrefix: string
  /** Pre-migration discussion index prefix. */
  legacyPrefix: string
  /** Exclusive upper bound that keeps a legacy aggregate query before the current index. */
  legacyUpperBound?: string
  /** Whether compatibility callers should read the pre-migration index before the current index. */
  legacyFirst: boolean
}

/** Decoded cursor variant used by the discussion page reader. */
type DecodedDiscussionCursor =
  | {
      /** Identifies the pre-migration cursor shape. */
      kind: 'legacy'
      /** Last legacy sort key. */
      recordKey: string
    }
  | {
      /** Identifies the current migration-aware cursor shape. */
      kind: 'current'
      /** Index phase used by the next page. */
      phase: DiscussionCursor['phase']
      /** Last sort key in the current phase, when pagination has started. */
      recordKey?: string
    }

/** One query page returned by the discussion index reader. */
type DiscussionQueryPage = {
  /** Physical discussion index rows returned by DynamoDB. */
  items: Record<string, unknown>[]
  /** Last evaluated sort key, when more rows remain. */
  lastRecordKey?: string
}

/** Accepted resolution history cursor payload です。 */
type AcceptedResolutionCursor = {
  /** Cursor schema version です。 */
  version: 2
  /** Cursor を発行した entity key です。 */
  entityKey: string
  /** Cursor を発行した root comment ID です。 */
  rootCommentId: string
  /** Root comment revision observed when the cursor was issued. */
  rootVersion: number
  /** Accepted-resolution pointer observed when the cursor was issued. */
  acceptedResolutionId: string | null
  /** Append-only rows または legacy inline history の pagination phase です。 */
  phase: 'append' | 'legacy'
  /** Append phase の直前 page で最後に処理した physical row key です。 */
  recordKey?: string
  /** Legacy phase の直前 page までに返した item 数です。 */
  legacyOffset?: number
}

const defaultPresenceTtlSeconds = 45
const acceptedResolutionHistoryDefaultLimit = 10
const acceptedResolutionHistoryMaxLimit = 10
const curatedContextPageLimit = 10
const discussionTimelinePrefix = 'DISCUSSION#V2#'
const discussionScopedPrefix = 'DISCUSSION#V2S#'
const discussionLegacyUpperBound = discussionTimelinePrefix
/** Marker used to exclude new compatibility rows from migration fallback reads. */
const discussionLegacyIndexVersion = 2
const localTableInitializers = new WeakMap<DynamoDBClient, Map<string, Promise<void>>>()

/** Work Item scope の canonical collaboration entity key を作成します。 */
export function createWorkItemCollaborationEntityKey(
  workspaceId: string,
  teamId: string,
  issueId: string,
) {
  return `${requireText(workspaceId, 'Workspace ID')}#work-item#team/${requireText(teamId, 'Team ID')}/issue/${requireText(issueId, 'Issue ID')}`
}

/**
 * Creates the environment/workspace scope used by the legacy comment migration marker.
 *
 * @param workspaceId - Workspace whose legacy comment rows were backfilled.
 * @returns Stable migration-marker entity key.
 */
export function createTeamIssueCommentBackfillMarkerEntityKey(workspaceId: string) {
  return `${requireText(workspaceId, 'Workspace ID')}#collaboration-migration`
}

/** Project scope の canonical collaboration entity key を作成します。 */
export function createProjectCollaborationEntityKey(workspaceId: string, projectId: string) {
  return `${requireText(workspaceId, 'Workspace ID')}#project#${requireText(projectId, 'Project ID')}`
}

/**
 * Creates the collaboration entity key for one Planning update target scope.
 *
 * @param workspaceId - Workspace that owns the target.
 * @param targetKey - Percent-encoded public target key.
 * @returns Stable collaboration entity key.
 */
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

/**
 * Creates the shared public key used to store and query Planning update watchers.
 *
 * @param target - Canonical Project or Initiative target.
 * @returns Percent-encoded public target key.
 */
export function createPlanningUpdatePublicTargetKey(
  target: PlanningUpdateTargetKeyInput,
): string {
  return target.type === 'project'
    ? `project/${encodeURIComponent(requireText(target.teamId, 'Team ID'))}/${encodeURIComponent(requireText(target.projectId, 'Project ID'))}`
    : `initiative/${encodeURIComponent(requireText(target.entityId, 'Initiative ID'))}`
}

/**
 * Builds the current and pre-migration discussion prefixes for one read scope.
 *
 * @param input - Thread read input whose scope determines the prefixes.
 * @returns Prefixes used to read the current and legacy discussion indexes.
 */
function createDiscussionReadPlan(input: GetCollaborationThreadInput): DiscussionReadPlan {
  if (input.rootCommentId) {
    const rootCommentId = requireIdentifier(input.rootCommentId, 'Root comment ID')
    return {
      currentPrefix: `${discussionScopedPrefix}THREAD#${rootCommentId}#`,
      legacyPrefix: `DISCUSSION#THREAD#${rootCommentId}#`,
      legacyFirst: input.legacyCursorCompatible === true,
    }
  }

  if (input.includeReplies === true) {
    return {
      currentPrefix: discussionTimelinePrefix,
      legacyPrefix: 'DISCUSSION#',
      legacyUpperBound: discussionLegacyUpperBound,
      legacyFirst: false,
    }
  }

  return {
    currentPrefix: `${discussionScopedPrefix}ROOT#`,
    legacyPrefix: 'DISCUSSION#ROOT#',
    legacyFirst: input.legacyCursorCompatible === true,
  }
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
  /** Legacy Team Issue event table bound into the migration marker. */
  private readonly teamIssueEventsTableName: string

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
    teamIssueEventsTableName = readEnvironment('MUKUROJI_TEAM_ISSUE_EVENTS_TABLE') ??
      readEnvironment('TEAM_ISSUE_EVENTS_TABLE_NAME') ??
      'mukuroji-team-issue-events-local',
  ) {
    this.tableName = requireText(tableName, 'Collaboration table name')
    this.parentIssueTableName = requireText(parentIssueTableName, 'Team issues table name')
    this.auditTableName = auditTableName
    this.dynamoDbClient = dynamoDbClient
    this.documentClient = documentClient ??
      createWorkspaceSearchWriterDynamoDbDocumentClient(dynamoDbClient)
    this.bootstrapLocalTable = bootstrapLocalTable
    this.teamIssueEventsTableName = requireText(
      teamIssueEventsTableName,
      'Team issue events table name',
    )
  }

  /** Returns whether the environment marker allows canonical-only Team Issue comment reads. */
  async isTeamIssueCommentBackfillComplete(workspaceId: string): Promise<boolean> {
    await this.ensureLocalTable()
    const workspaceMarker = await this.readTeamIssueCommentBackfillMarker(workspaceId)
    if (isCompletedTeamIssueCommentBackfillMarker(
      workspaceMarker,
      this.tableName,
      this.teamIssueEventsTableName,
    )) {
      return true
    }
    if (workspaceId === TEAM_ISSUE_COMMENT_BACKFILL_ALL_WORKSPACES) {
      return false
    }
    const environmentMarker = await this.readTeamIssueCommentBackfillMarker(
      TEAM_ISSUE_COMMENT_BACKFILL_ALL_WORKSPACES,
    )
    return isCompletedTeamIssueCommentBackfillMarker(
      environmentMarker,
      this.tableName,
      this.teamIssueEventsTableName,
    )
  }

  /** Reads one migration marker with strong consistency. */
  private async readTeamIssueCommentBackfillMarker(workspaceId: string) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        entityKey: createTeamIssueCommentBackfillMarkerEntityKey(workspaceId),
        recordKey: TEAM_ISSUE_COMMENT_BACKFILL_MARKER_RECORD_KEY,
      },
      ConsistentRead: true,
    }))
    return response.Item
  }

  /**
   * Validates one legacy comment and its parent Work Item without writing data.
   *
   * @param input - Legacy comment and Work Item scope to validate.
   */
  async validateBackfillTeamIssueComment(
    input: BackfillCollaborationCommentInput,
  ): Promise<void> {
    await this.ensureLocalTable()
    const normalizedInput = normalizeBackfillCollaborationCommentInput(input)
    await this.assertCanonicalBackfillParent(normalizedInput)
  }

  /**
   * Copies one legacy comment into Collaboration without notifications or audit delivery.
   *
   * @param input - Validated legacy comment and Work Item scope.
   * @returns The idempotently persisted canonical comment.
   */
  async backfillTeamIssueComment(
    input: BackfillCollaborationCommentInput,
  ): Promise<CollaborationComment> {
    await this.ensureLocalTable()
    const normalizedInput = normalizeBackfillCollaborationCommentInput(input)
    const parent = await this.assertCanonicalBackfillParent(normalizedInput)
    const commentId = normalizedInput.commentId
    const actorMemberKey = normalizedInput.actorMemberKey
    const bodyMarkdown = normalizedInput.bodyMarkdown
    const occurredAt = normalizedInput.occurredAt
    const comment: StoredComment = {
      entityKey: normalizedInput.entityKey,
      recordKey: commentRecordKey(commentId),
      entryType: 'comment',
      id: commentId,
      rootCommentId: commentId,
      authorMemberKey: actorMemberKey,
      bodyMarkdown,
      version: 1,
      mentionMemberKeys: [],
      createdAt: occurredAt,
      updatedAt: occurredAt,
      reactions: [],
      acceptedResolutions: [],
      legacyAcceptedResolutions: [],
    }
    const discussionRecords = [
      createBackfillDiscussionRecord(
        normalizedInput.entityKey,
        discussionTimelineRecordKey(occurredAt, commentId, undefined),
        commentId,
        occurredAt,
      ),
      createBackfillDiscussionRecord(
        normalizedInput.entityKey,
        discussionScopedRecordKey(occurredAt, commentId, undefined),
        commentId,
        occurredAt,
      ),
      createBackfillDiscussionRecord(
        normalizedInput.entityKey,
        discussionLegacyRecordKey(occurredAt, commentId, undefined),
        commentId,
        occurredAt,
        discussionLegacyIndexVersion,
      ),
    ]

    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          parentIssueBackfillCondition(
            this.parentIssueTableName,
            normalizedInput,
            parent.revision,
          ),
          {
            Put: {
              TableName: this.tableName,
              Item: toStoredCommentStorageItem(comment),
              ConditionExpression: 'attribute_not_exists(entityKey) AND attribute_not_exists(recordKey)',
            },
          },
          ...discussionRecords.map((Item) => ({
            Put: {
              TableName: this.tableName,
              Item,
              ConditionExpression: 'attribute_not_exists(entityKey) AND attribute_not_exists(recordKey)',
            },
          })),
          {
            Put: {
              TableName: this.tableName,
              Item: createBackfillReceiptRecord(normalizedInput),
              ConditionExpression: 'attribute_not_exists(entityKey) AND attribute_not_exists(recordKey)',
            },
          },
        ],
      }))
      return comment
    } catch (error) {
      if (!isBackfillConditionalFailure(error)) {
        throw toCollaborationStoreError(error)
      }
      const existing = await this.getStoredComment(normalizedInput.entityKey, commentId)
      const receipt = await this.getBackfillReceipt(normalizedInput.entityKey, commentId)
      if (
        existing &&
        receipt &&
        isSameBackfillReceipt(receipt, normalizedInput) &&
        isBackfilledCommentIdentity(existing, normalizedInput)
      ) {
        await this.repairBackfilledDiscussion(normalizedInput, existing)
        return existing
      }
      if (isTransactionConditionalFailureAt(error, 1) &&
          existing &&
          isSameBackfilledComment(existing, comment)) {
        await this.ensureBackfillReceipt(normalizedInput)
        await this.repairBackfilledDiscussion(normalizedInput, existing)
        return existing
      }
      throw new CollaborationError(
        409,
        'CollaborationBackfillConflict',
        'The legacy comment could not be copied into Collaboration.',
        { cause: error },
      )
    }
  }

  /** Reads and validates the canonical parent before a backfill is planned or written. */
  private async assertCanonicalBackfillParent(
    input: BackfillCollaborationCommentInput,
  ): Promise<CanonicalWorkItemRecord> {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.parentIssueTableName,
      Key: {
        directoryTeamId: `${input.workspaceId}#team#${input.teamId}`,
        issueId: input.issueId,
      },
      ConsistentRead: true,
    }))
    if (!isCanonicalBackfillParent(response.Item, input)) {
      throw new CollaborationError(
        409,
        'CollaborationBackfillConflict',
        'The parent Work Item is missing or invalid.',
      )
    }
    return response.Item
  }

  /** Reads one immutable backfill provenance receipt with strong consistency. */
  private async getBackfillReceipt(entityKey: string, commentId: string) {
    const recordKey = backfillReceiptRecordKey(commentId)
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { entityKey, recordKey },
      ConsistentRead: true,
    }))
    return response.Item
      ? toStoredBackfillReceipt(response.Item, entityKey, recordKey)
      : undefined
  }

  /** Persists one immutable backfill provenance receipt idempotently. */
  private async ensureBackfillReceipt(input: BackfillCollaborationCommentInput): Promise<void> {
    const expected = createBackfillReceiptRecord(input)
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [{
          Put: {
            TableName: this.tableName,
            Item: expected,
            ConditionExpression: 'attribute_not_exists(entityKey) AND attribute_not_exists(recordKey)',
          },
        }],
      }))
    } catch (error) {
      if (!isBackfillConditionalFailure(error)) {
        throw toCollaborationStoreError(error)
      }
      const existing = await this.getBackfillReceipt(input.entityKey, input.commentId)
      if (!existing || !isSameBackfillReceipt(existing, input)) {
        throw new CollaborationError(
          409,
          'CollaborationBackfillConflict',
          'The legacy comment backfill receipt already exists with different data.',
          { cause: error },
        )
      }
    }
  }

  /** Repairs all discussion projections for an already copied comment. */
  private async repairBackfilledDiscussion(
    input: BackfillCollaborationCommentInput,
    existing: StoredComment,
  ): Promise<void> {
    const existingDiscussionRecords = [
      createBackfillDiscussionRecord(
        input.entityKey,
        discussionTimelineRecordKey(existing.createdAt, input.commentId, undefined),
        input.commentId,
        existing.createdAt,
      ),
      createBackfillDiscussionRecord(
        input.entityKey,
        discussionScopedRecordKey(existing.createdAt, input.commentId, undefined),
        input.commentId,
        existing.createdAt,
      ),
      createBackfillDiscussionRecord(
        input.entityKey,
        discussionLegacyRecordKey(existing.createdAt, input.commentId, undefined),
        input.commentId,
        existing.createdAt,
        discussionLegacyIndexVersion,
      ),
    ]
    for (const record of existingDiscussionRecords) {
      await this.ensureBackfilledDiscussionRecord(
        input.entityKey,
        record.recordKey,
        input.commentId,
        existing.createdAt,
        record.discussionIndexVersion,
      )
    }
  }

  /** Repairs the discussion projection when a backfill comment already exists. */
  private async ensureBackfilledDiscussionRecord(
    entityKey: string,
    recordKey: string,
    commentId: string,
    occurredAt: string,
    discussionIndexVersion?: number,
  ): Promise<void> {
    const expected = createBackfillDiscussionRecord(
      entityKey,
      recordKey,
      commentId,
      occurredAt,
      discussionIndexVersion,
    )
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [{
          Put: {
            TableName: this.tableName,
            Item: expected,
            ConditionExpression: 'attribute_not_exists(entityKey) AND attribute_not_exists(recordKey)',
          },
        }],
      }))
    } catch (error) {
      if (!isTransactionConditionalFailureAt(error, 0)) throw error
      const existing = await this.documentClient.send(new GetCommand({
        TableName: this.tableName,
        Key: { entityKey, recordKey },
        ConsistentRead: true,
      }))
      if (isSameBackfilledDiscussion(
        existing.Item,
        entityKey,
        recordKey,
        commentId,
        occurredAt,
        discussionIndexVersion,
      )) {
        return
      }
      if (
        discussionIndexVersion === discussionLegacyIndexVersion &&
        isSameBackfilledDiscussion(existing.Item, entityKey, recordKey, commentId, occurredAt)
      ) {
        try {
          await this.documentClient.send(new TransactWriteCommand({
            TransactItems: [{
              Put: {
                TableName: this.tableName,
                Item: expected,
                ConditionExpression:
                  'entryType = :entryType AND commentId = :commentId AND rootCommentId = :rootCommentId AND createdAt = :createdAt AND attribute_not_exists(discussionIndexVersion)',
                ExpressionAttributeValues: {
                  ':entryType': 'discussion',
                  ':commentId': commentId,
                  ':rootCommentId': commentId,
                  ':createdAt': occurredAt,
                },
              },
            }],
          }))
          return
        } catch (upgradeError) {
          if (!isTransactionConditionalFailureAt(upgradeError, 0)) throw upgradeError
          const upgraded = await this.documentClient.send(new GetCommand({
            TableName: this.tableName,
            Key: { entityKey, recordKey },
            ConsistentRead: true,
          }))
          if (isSameBackfilledDiscussion(
            upgraded.Item,
            entityKey,
            recordKey,
            commentId,
            occurredAt,
            discussionIndexVersion,
          )) {
            return
          }
        }
      }
      throw new CollaborationError(
        409,
        'CollaborationBackfillConflict',
        'The discussion projection already exists with different data.',
        { cause: error },
      )
    }
  }

  /**
   * Publishes the completion marker after the legacy source scan reaches its end.
   *
   * @param workspaceId - Workspace whose source rows were fully processed.
   * @param completedAt - Completion timestamp, primarily supplied by a checkpointed runner.
   */
  async markTeamIssueCommentBackfillComplete(
    workspaceId: string,
    completedAt = new Date().toISOString(),
  ): Promise<void> {
    await this.ensureLocalTable()
    const entityKey = createTeamIssueCommentBackfillMarkerEntityKey(workspaceId)
    const marker = {
      entityKey,
      recordKey: TEAM_ISSUE_COMMENT_BACKFILL_MARKER_RECORD_KEY,
      entryType: 'migration-marker',
      migration: 'team-issue-comments',
      version: TEAM_ISSUE_COMMENT_BACKFILL_VERSION,
      state: 'complete',
      sourceTableName: this.teamIssueEventsTableName,
      targetTableName: this.tableName,
      completedAt: normalizeBackfillTimestamp(completedAt),
    }
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [{
          Put: {
            TableName: this.tableName,
            Item: marker,
            ConditionExpression: 'attribute_not_exists(entityKey) AND attribute_not_exists(recordKey)',
          },
        }],
      }))
    } catch (error) {
      if (
        isTransactionConditionalFailureAt(error, 0) &&
        await this.isTeamIssueCommentBackfillComplete(workspaceId)
      ) {
        return
      }
      throw new CollaborationError(
        409,
        'CollaborationBackfillMarkerConflict',
        'The Team Issue comment backfill marker already exists with different data.',
        { cause: error },
      )
    }
  }

  /** Root comments または replies を page 取得します。 */
  async getThread(input: GetCollaborationThreadInput) {
    await this.ensureLocalTable()
    const entityKey = requireText(input.entityKey, 'Collaboration entity key')
    const viewerMemberKey = normalizeMemberKey(input.viewerMemberKey)
    const plan = createDiscussionReadPlan(input)
    const limit = clampLimit(input.limit)
    const cursor = decodeDiscussionCursor(input.cursor, entityKey, plan)
    const page = await this.readDiscussionPage(plan, entityKey, cursor, limit)
    const commentIds = page.items.flatMap((item) =>
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
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      watch,
      presence,
      ...(replyRoot?.resolvedAt ? { threadResolved: true } : {}),
    } satisfies CollaborationThreadPage
  }

  /**
   * Reads one bounded page from the current discussion index and then the legacy index.
   * Compatibility callers start at the legacy index so their first cursor remains readable by
   * pre-migration servers during a rolling deployment.
   *
   * @param plan - Current and legacy prefixes for the requested scope.
   * @param entityKey - Collaboration entity key being read.
   * @param cursor - Validated cursor from the previous page, when supplied.
   * @param limit - Maximum number of index rows to return.
   * @returns Discussion rows and an opaque cursor when another page exists.
   */
  private async readDiscussionPage(
    plan: DiscussionReadPlan,
    entityKey: string,
    cursor: DecodedDiscussionCursor | undefined,
    limit: number,
  ) {
    if (cursor?.kind === 'legacy') {
      const legacyPage = await this.queryDiscussionPage(
        plan,
        entityKey,
        'legacy',
        cursor.recordKey,
        limit,
      )
      return {
        items: legacyPage.items,
        ...(legacyPage.lastRecordKey
          ? {
              nextCursor: encodeLegacyDiscussionCursor({
                version: 1,
                entityKey,
                prefix: plan.legacyPrefix,
                recordKey: legacyPage.lastRecordKey,
              }),
            }
          : {}),
      }
    }

    if (plan.legacyFirst && cursor === undefined) {
      const legacyPage = await this.queryDiscussionPage(
        plan,
        entityKey,
        'legacy',
        undefined,
        limit,
      )
      if (legacyPage.items.length > 0 || legacyPage.lastRecordKey) {
        return {
          items: legacyPage.items,
          ...(legacyPage.lastRecordKey
            ? {
                nextCursor: encodeLegacyDiscussionCursor({
                  version: 1,
                  entityKey,
                  prefix: plan.legacyPrefix,
                  recordKey: legacyPage.lastRecordKey,
                }),
              }
            : {}),
        }
      }
    }

    const phase = cursor?.kind === 'current' ? cursor.phase : 'current'
    if (phase === 'legacy') {
      const legacyPage = await this.queryDiscussionPage(
        plan,
        entityKey,
        'legacy',
        cursor?.kind === 'current' ? cursor.recordKey : undefined,
        limit,
      )
      return {
        items: legacyPage.items,
        ...(legacyPage.lastRecordKey
          ? {
              nextCursor: encodeDiscussionCursor({
                version: 2,
                entityKey,
                currentPrefix: plan.currentPrefix,
                legacyPrefix: plan.legacyPrefix,
                phase: 'legacy',
                recordKey: legacyPage.lastRecordKey,
              }),
            }
          : {}),
      }
    }

    const currentPage = await this.queryDiscussionPage(
      plan,
      entityKey,
      'current',
      cursor?.kind === 'current' ? cursor.recordKey : undefined,
      limit,
    )
    if (currentPage.lastRecordKey) {
      return {
        items: currentPage.items,
        nextCursor: encodeDiscussionCursor({
          version: 2,
          entityKey,
          currentPrefix: plan.currentPrefix,
          legacyPrefix: plan.legacyPrefix,
          phase: 'current',
          recordKey: currentPage.lastRecordKey,
        }),
      }
    }

    if (currentPage.items.length >= limit) {
      const legacyProbe = await this.queryDiscussionPage(plan, entityKey, 'legacy', undefined, 1)
      return {
        items: currentPage.items,
        ...(legacyProbe.items.length > 0 || legacyProbe.lastRecordKey
          ? {
              nextCursor: encodeDiscussionCursor({
                version: 2,
                entityKey,
                currentPrefix: plan.currentPrefix,
                legacyPrefix: plan.legacyPrefix,
                phase: 'legacy',
              }),
            }
          : {}),
      }
    }

    const legacyPage = await this.queryDiscussionPage(
      plan,
      entityKey,
      'legacy',
      undefined,
      limit - currentPage.items.length,
    )
    return {
      items: [...currentPage.items, ...legacyPage.items],
      ...(legacyPage.lastRecordKey
        ? {
            nextCursor: encodeDiscussionCursor({
              version: 2,
              entityKey,
              currentPrefix: plan.currentPrefix,
              legacyPrefix: plan.legacyPrefix,
              phase: 'legacy',
              recordKey: legacyPage.lastRecordKey,
            }),
          }
        : {}),
    }
  }

  /**
   * Queries one physical discussion index within its migration-safe key range.
   *
   * @param plan - Current and legacy prefixes for the requested scope.
   * @param entityKey - Collaboration entity key being read.
   * @param phase - Physical index phase to query.
   * @param recordKey - Exclusive start key from the previous query page.
   * @param limit - Maximum number of matching rows to return.
   * @returns Matching rows and the last evaluated sort key.
   */
  private async queryDiscussionPage(
    plan: DiscussionReadPlan,
    entityKey: string,
    phase: DiscussionCursor['phase'],
    recordKey: string | undefined,
    limit: number,
  ): Promise<DiscussionQueryPage> {
    const prefix = phase === 'current' ? plan.currentPrefix : plan.legacyPrefix
    const expressionAttributeValues: Record<string, string> = { ':entityKey': entityKey }
    let keyConditionExpression = 'entityKey = :entityKey AND begins_with(recordKey, :prefix)'
    if (phase === 'legacy' && plan.legacyUpperBound !== undefined) {
      expressionAttributeValues[':legacyLowerBound'] = plan.legacyPrefix
      expressionAttributeValues[':legacyUpperBound'] = plan.legacyUpperBound
      keyConditionExpression =
        'entityKey = :entityKey AND recordKey BETWEEN :legacyLowerBound AND :legacyUpperBound'
    } else {
      expressionAttributeValues[':prefix'] = prefix
    }
    const response = await this.documentClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: keyConditionExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      ExclusiveStartKey: recordKey ? { entityKey, recordKey } : undefined,
      ConsistentRead: true,
      ScanIndexForward: false,
      Limit: limit,
      ...(phase === 'legacy' && !plan.legacyFirst
        ? { FilterExpression: 'attribute_not_exists(discussionIndexVersion)' }
        : {}),
    }))
    const lastRecordKey = readDiscussionLastRecordKey(response.LastEvaluatedKey)
    return {
      items: (response.Items ?? []).filter(isRecord).slice(0, limit),
      ...(lastRecordKey ? { lastRecordKey } : {}),
    }
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

  /** Returns a previously committed comment for a deterministic mutation identity. */
  async getCommentMutationReplay(input: GetCollaborationCommentMutationReplayInput) {
    await this.ensureLocalTable()
    const entityKey = requireIdentifier(input.entityKey, 'Collaboration entity key')
    const commentId = input.commentId === undefined
      ? createCommentId('', input.auditContext, entityKey)
      : createTrustedCommentId(input.commentId, input.auditContext)
    return this.getStoredComment(entityKey, commentId)
  }

  /** Root thread の accepted resolution history を新しい順に page 取得します。 */
  async getAcceptedResolutionHistory(
    input: GetAcceptedResolutionHistoryInput,
  ): Promise<AcceptedResolutionPage> {
    await this.ensureLocalTable()
    return this.readAcceptedResolutionHistoryPage(input, 0)
  }

  /** Reads one history page and retries once when the root pointer changes mid-read. */
  private async readAcceptedResolutionHistoryPage(
    input: GetAcceptedResolutionHistoryInput,
    attempt: number,
  ): Promise<AcceptedResolutionPage> {
    const entityKey = requireIdentifier(input.entityKey, 'Collaboration entity key')
    const rootCommentId = requireIdentifier(input.rootCommentId, 'Root comment ID')
    const limit = clampAcceptedResolutionHistoryLimit(input.limit)
    const cursor = decodeAcceptedResolutionCursor(input.cursor, entityKey, rootCommentId)
    const root = await this.getRequiredStoredComment(entityKey, rootCommentId)
    if (root.parentCommentId || root.rootCommentId !== root.id) {
      throw new CollaborationError(400, 'CommentNotRoot', 'Only root comments own accepted resolutions.')
    }
    if (
      cursor &&
      (cursor.rootVersion !== root.version ||
        cursor.acceptedResolutionId !== (root.acceptedResolutionId ?? null))
    ) {
      throw new CollaborationError(
        409,
        'AcceptedResolutionHistoryConflict',
        'Accepted resolution history changed before the next page was read.',
      )
    }

    const legacyHistory = [...root.legacyAcceptedResolutions].sort((left, right) => {
      const leftAt = left.supersededAt ?? left.acceptedAt
      const rightAt = right.supersededAt ?? right.acceptedAt
      return rightAt.localeCompare(leftAt) || right.id.localeCompare(left.id)
    })
    if (cursor?.phase === 'legacy') {
      const offset = cursor.legacyOffset ?? 0
      const items = legacyHistory.slice(offset, offset + limit)
      const nextOffset = offset + items.length
      return {
        items,
        ...(nextOffset < legacyHistory.length
          ? {
              nextCursor: encodeAcceptedResolutionCursor({
                version: 2,
                entityKey,
                rootCommentId,
                ...acceptedResolutionCursorSnapshot(root),
                phase: 'legacy',
                legacyOffset: nextOffset,
              }),
            }
          : {}),
      }
    }

    const prefix = acceptedResolutionRecordPrefix(rootCommentId)
    const exclusiveStartKey = cursor?.recordKey
      ? { entityKey, recordKey: cursor.recordKey }
      : undefined
    const response = await this.documentClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'entityKey = :entityKey AND begins_with(recordKey, :prefix)',
      ExpressionAttributeValues: { ':entityKey': entityKey, ':prefix': prefix },
      ExclusiveStartKey: exclusiveStartKey,
      ConsistentRead: true,
      ScanIndexForward: false,
      // One logical resolution produces at most an accepted and a superseded snapshot.
      Limit: limit * 2,
    }))
    const latestRoot = await this.getRequiredStoredComment(entityKey, rootCommentId)
    if (
      latestRoot.version !== root.version ||
      latestRoot.acceptedResolutionId !== root.acceptedResolutionId
    ) {
      if (attempt < 1) {
        return this.readAcceptedResolutionHistoryPage(input, attempt + 1)
      }
      throw new CollaborationError(
        409,
        'AcceptedResolutionHistoryConflict',
        'Accepted resolution history changed while it was being read.',
      )
    }
    const physicalRows = response.Items ?? []
    const items: AcceptedResolution[] = []
    let lastProcessedRecordKey: string | undefined
    let stoppedBeforeBatchEnd = false
    for (const [index, physicalRow] of physicalRows.entries()) {
      const stored = toStoredAcceptedResolution(physicalRow, rootCommentId)
      lastProcessedRecordKey = stored.recordKey
      if (stored.resolution.state === 'superseded' ||
          stored.resolution.id === root.acceptedResolutionId) {
        items.push(stored.resolution)
      }
      if (items.length === limit) {
        stoppedBeforeBatchEnd = index < physicalRows.length - 1
        break
      }
    }

    const hasMoreAppendRows = stoppedBeforeBatchEnd || Boolean(response.LastEvaluatedKey)
    if (hasMoreAppendRows && lastProcessedRecordKey) {
      return {
        items,
        nextCursor: encodeAcceptedResolutionCursor({
          version: 2,
          entityKey,
          rootCommentId,
          ...acceptedResolutionCursorSnapshot(root),
          phase: 'append',
          recordKey: lastProcessedRecordKey,
        }),
      }
    }

    const remaining = limit - items.length
    const legacyItems = legacyHistory.slice(0, remaining)
    items.push(...legacyItems)
    return {
      items,
      ...(legacyItems.length < legacyHistory.length
        ? {
            nextCursor: encodeAcceptedResolutionCursor({
              version: 2,
              entityKey,
              rootCommentId,
              ...acceptedResolutionCursorSnapshot(root),
              phase: 'legacy',
              legacyOffset: legacyItems.length,
            }),
          }
        : {}),
    }
  }

  /** Work Item の curated context items を page 取得します。 */
  async getCuratedContext(input: GetCuratedContextInput) {
    await this.ensureLocalTable()
    const entityKey = requireIdentifier(input.entityKey, 'Collaboration entity key')
    const prefix: CuratedContextCursor['prefix'] = 'CONTEXT_ORDER#'
    const limit = clampCuratedContextLimit(input.limit)
    const capabilities = normalizeContextCapabilities(input.capabilities)
    const generation = await this.getCuratedContextLedgerGeneration(entityKey)
    const decodedCursor = decodeCuratedContextCursor(input.cursor, entityKey)
    if (decodedCursor && decodedCursor.generation !== generation) {
      throw new CollaborationError(
        409,
        'CollaborationCursorExpired',
        'Curated context changed while paging. Restart from the first page.',
      )
    }

    try {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'entityKey = :entityKey AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: { ':entityKey': entityKey, ':prefix': prefix },
        ExclusiveStartKey: decodedCursor?.key,
        ConsistentRead: true,
        ScanIndexForward: false,
        Limit: limit,
      }))
      const orderRows = (response.Items ?? []).map(toStoredCuratedContextOrder)
      const items = await Promise.all(orderRows.map(async (row) => {
        const item = await this.getStoredCuratedContextItem(entityKey, row.itemId)
        if (!item || item.createdAt !== row.createdAt) {
          throw new CollaborationError(
            503,
            'InvalidCollaborationRecord',
            'Curated context order record is invalid.',
          )
        }
        return this.reconcileCuratedContextItemSource(item)
      }))
      const currentGeneration = await this.getCuratedContextLedgerGeneration(entityKey)
      if (currentGeneration !== generation) {
        throw new CollaborationError(
          409,
          'CollaborationCursorExpired',
          'Curated context changed while paging. Restart from the first page.',
        )
      }

      return {
        schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
        items,
        ...(response.LastEvaluatedKey?.recordKey &&
            typeof response.LastEvaluatedKey.recordKey === 'string'
          ? {
              nextCursor: encodeCuratedContextCursor({
                version: 2,
                entityKey,
                prefix,
                recordKey: response.LastEvaluatedKey.recordKey,
                generation,
              }),
            }
          : {}),
        capabilities,
      } satisfies CuratedContextPage
    } catch (error) {
      throw toCollaborationStoreError(error)
    }
  }

  /** Curated context item の current snapshot を consistent read します。 */
  async getCuratedContextItemSnapshot(input: GetCuratedContextItemSnapshotInput) {
    await this.ensureLocalTable()
    const entityKey = requireIdentifier(input.entityKey, 'Collaboration entity key')
    const item = await this.getStoredCuratedContextItem(
      entityKey,
      requireIdentifier(input.itemId, 'Curated context item ID'),
    )
    return item ? this.reconcileCuratedContextItemSource(item) : undefined
  }

  /** Curated context item の immutable revision history を新しい順に page 取得します。 */
  async getCuratedContextRevisions(
    input: GetCuratedContextRevisionsInput,
  ): Promise<CuratedContextRevisionPage> {
    await this.ensureLocalTable()
    const entityKey = requireIdentifier(input.entityKey, 'Collaboration entity key')
    const itemId = requireIdentifier(input.itemId, 'Curated context item ID')
    const prefix = `CONTEXT_REVISION#${encodeURIComponent(itemId)}#`
    const limit = clampCuratedContextLimit(input.limit)
    const exclusiveStartKey = decodeCursor(input.cursor, entityKey, prefix)
    await this.getRequiredStoredCuratedContextItem(entityKey, itemId)

    try {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'entityKey = :entityKey AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: { ':entityKey': entityKey, ':prefix': prefix },
        ExclusiveStartKey: exclusiveStartKey,
        ConsistentRead: true,
        ScanIndexForward: false,
        Limit: limit,
      }))
      const items = (response.Items ?? []).map((row) =>
        toStoredCuratedContextRevision(row, entityKey, itemId).snapshot
      )
      return {
        items,
        ...(response.LastEvaluatedKey?.recordKey &&
            typeof response.LastEvaluatedKey.recordKey === 'string'
          ? {
              nextCursor: encodeCursor({
                version: 1,
                entityKey,
                prefix,
                recordKey: response.LastEvaluatedKey.recordKey,
              }),
            }
          : {}),
      }
    } catch (error) {
      throw toCollaborationStoreError(error)
    }
  }

  /** Returns the immutable response for a previously committed idempotent context mutation. */
  async getCuratedContextMutationReplay(
    input: GetCuratedContextMutationReplayInput,
  ): Promise<CuratedContextItem | undefined> {
    await this.ensureLocalTable()
    const entityKey = requireIdentifier(input.entityKey, 'Collaboration entity key')
    const workspaceId = requireIdentifier(
      input.auditContext.workspaceId,
      'Curated context workspace ID',
    )
    if (!entityKey.startsWith(`${workspaceId}#`)) {
      throw new CollaborationError(
        400,
        'InvalidCollaborationScope',
        'Curated context mutation receipt scope is invalid.',
      )
    }
    if (input.operation !== 'create' && input.operation !== 'update') {
      throw new CollaborationError(
        400,
        'InvalidCollaborationInput',
        'Curated context mutation operation is invalid.',
      )
    }
    const requestedItemId = input.operation === 'update'
      ? requireIdentifier(input.itemId ?? '', 'Curated context item ID')
      : undefined
    const receipt = await this.getStoredCuratedContextMutationReceipt(
      entityKey,
      input.auditContext,
    )
    if (!receipt) return undefined

    if (receipt.operation !== input.operation ||
        receipt.requestFingerprint !== input.auditContext.requestFingerprint ||
        (requestedItemId !== undefined && receipt.itemId !== requestedItemId)) {
      throw new CollaborationError(
        409,
        'CollaborationIdempotencyConflict',
        'Curated context idempotency key was reused with different input.',
      )
    }
    const revision = await this.getStoredCuratedContextRevision(
      entityKey,
      receipt.itemId,
      receipt.responseRevision,
    )
    if (!revision) {
      throw new CollaborationError(
        503,
        'InvalidCollaborationRecord',
        'Curated context mutation receipt response is missing.',
      )
    }
    return revision.snapshot
  }

  /** Curated context item を作成し、任意の既存 item を atomically supersede します。 */
  async createCuratedContextItem(input: CreateCuratedContextItemInput) {
    await this.ensureLocalTable()
    assertWorkItemScope(input)
    assertCuratedContextAuthorizationSnapshot(input)
    assertCuratedContextDocumentSourceAuthorizationSnapshot(input)
    assertCuratedContextActivitySourceAuthorizationSnapshot(input)
    if (input.auditContext) {
      const replayed = await this.getCuratedContextMutationReplay({
        entityKey: input.entityKey,
        operation: 'create',
        auditContext: input.auditContext,
      })
      if (replayed) return replayed
    }
    const actor = normalizeContextActor(input.actor, 'Curated context actor')
    const occurredAt = normalizeIsoTimestamp(
      input.auditContext?.occurredAt ?? new Date().toISOString(),
      'Curated context createdAt',
    )
    const id = createContextItemId(occurredAt, input.auditContext, input.entityKey)
    const lastMutationKey = createCuratedContextMutationKey(input.auditContext)
    if (lastMutationKey) {
      const existing = await this.getStoredCuratedContextItem(input.entityKey, id)
      if (existing?.lastMutationKey === lastMutationKey) {
        return this.reconcileCuratedContextItemSource(existing)
      }
    }

    const mentionMemberKeys = normalizeMentionMemberKeys(input.mentionMemberKeys)
    const superseded = input.supersedesItemId
      ? await this.getRequiredStoredCuratedContextItem(input.entityKey, input.supersedesItemId)
      : undefined
    const capturedSource = input.source
      ? await this.captureCuratedContextSource(input.entityKey, input.source)
      : undefined
    const source = capturedSource?.source ?? superseded?.source
    const item: StoredCuratedContextItem = {
      entityKey: input.entityKey,
      recordKey: contextItemRecordKey(id),
      entryType: 'context',
      schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
      id,
      teamId: requireText(input.teamId, 'Team ID'),
      workItemId: requireText(input.issueId, 'Work Item ID'),
      kind: requireCuratedContextKind(input.kind),
      state: 'active',
      title: normalizeContextTitle(input.title),
      body: normalizeContextBody(input.body, 'Curated context body'),
      ...(source ? { source } : {}),
      mentionMemberKeys,
      createdBy: actor,
      createdAt: occurredAt,
      updatedBy: actor,
      updatedAt: occurredAt,
      revision: 1,
      ...(lastMutationKey ? { lastMutationKey } : {}),
    }

    if (superseded?.state === 'superseded' || superseded?.supersededByItemId) {
      throw new CollaborationError(
        409,
        'ContextAlreadySuperseded',
        'A superseded curated context item cannot be replaced again.',
      )
    }
    if (superseded?.id === item.id) {
      throw new CollaborationError(400, 'InvalidContextReplacement', 'An item cannot replace itself.')
    }

    const supersededAfter: StoredCuratedContextItem | undefined = superseded
      ? {
          ...superseded,
          state: 'superseded',
          supersededByItemId: item.id,
          updatedBy: actor,
          updatedAt: occurredAt,
          revision: superseded.revision + 1,
          ...(lastMutationKey ? { lastMutationKey } : {}),
        }
      : undefined
    const notificationCandidates = buildContextNotificationCandidates(input)
    const automaticWatchers = buildAutomaticWatcherCandidates(
      actor.id,
      mentionMemberKeys,
      undefined,
      input.automaticWatcherCandidates,
      input.auditContext?.actor.kind === 'service',
    )
    const createdAuditPut = createMutationAuditEventPut(this.auditTableName, input.auditContext, {
      directoryId: input.workspaceId,
      eventType: 'context-item.created',
      entityType: 'work-item',
      entityId: workItemEntityId(input.teamId, input.issueId),
      target: {
        type: 'context-item',
        id: `${workItemEntityId(input.teamId, input.issueId)}/context-item/${item.id}`,
      },
      action: 'created',
      occurredAt,
      summary: `Curated ${item.kind} “${item.title}” was created.`,
      changes: createAuditFieldChanges(
        undefined,
        { kind: item.kind, state: item.state, title: item.title, body: item.body },
        ['kind', 'state', 'title', 'body'],
        ['body'],
      ),
      metadata: createContextAuditMetadata(
        input,
        actor.id,
        item.id,
        item.revision,
        notificationCandidates,
      ),
      sequence: 0,
    })
    const supersededAuditPut = supersededAfter
      ? createMutationAuditEventPut(this.auditTableName, input.auditContext, {
          directoryId: input.workspaceId,
          eventType: 'context-item.superseded',
          entityType: 'work-item',
          entityId: workItemEntityId(input.teamId, input.issueId),
          target: {
            type: 'context-item',
            id: `${workItemEntityId(input.teamId, input.issueId)}/context-item/${supersededAfter.id}`,
          },
          action: 'superseded',
          occurredAt,
          summary: `Curated ${supersededAfter.kind} “${supersededAfter.title}” was superseded.`,
          changes: createAuditFieldChanges(
            { state: superseded?.state, supersededByItemId: superseded?.supersededByItemId },
            { state: 'superseded', supersededByItemId: item.id },
            ['state', 'supersededByItemId'],
          ),
          metadata: createContextAuditMetadata(
            input,
            actor.id,
            supersededAfter.id,
            supersededAfter.revision,
            [],
          ),
          sequence: 1,
        })
      : undefined
    const transactionItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      parentIssueCondition(this.parentIssueTableName, input),
      ...curatedContextAuthorizationConditions(input),
      contextLedgerIncrement(this.tableName, input.entityKey),
      ...(input.sourceAuthorizationSnapshot
        ? curatedContextDocumentSourceConditions(input, input.sourceAuthorizationSnapshot)
        : []),
      ...(input.activitySourceAuthorizationSnapshot
        ? curatedContextActivitySourceConditions(input, input.activitySourceAuthorizationSnapshot)
        : []),
      ...(capturedSource?.comment
        ? [commentVersionCondition(this.tableName, input.entityKey, capturedSource.comment)]
        : []),
      ...(supersededAfter && superseded
        ? [contextSnapshotPut(this.tableName, supersededAfter, superseded.revision)]
        : []),
      ...(supersededAfter ? [contextRevisionPut(this.tableName, supersededAfter)] : []),
      {
        Put: {
          TableName: this.tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(entityKey) AND attribute_not_exists(recordKey)',
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: createContextOrderRow(item),
          ConditionExpression: 'attribute_not_exists(entityKey) AND attribute_not_exists(recordKey)',
        },
      },
      contextRevisionPut(this.tableName, item),
      ...(input.auditContext
        ? [contextMutationReceiptPut(this.tableName, input.auditContext, 'create', item)]
        : []),
      ...automaticWatchers.map(({ memberKey, reasons }) =>
        autoWatcherUpdate(this.tableName, input.entityKey, memberKey, reasons, occurredAt)
      ),
      ...(createdAuditPut ? [createdAuditPut] : []),
      ...(supersededAuditPut ? [supersededAuditPut] : []),
    ]

    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactionItems }))
      return toCuratedContextItem(item)
    } catch (error) {
      if (isConditionalFailure(error) && input.auditContext) {
        const replayed = await this.getCuratedContextMutationReplay({
          entityKey: input.entityKey,
          operation: 'create',
          auditContext: input.auditContext,
        })
        if (replayed) return replayed
        const existing = await this.getStoredCuratedContextItem(input.entityKey, item.id)
        if (existing && lastMutationKey && existing.lastMutationKey === lastMutationKey) {
          return this.reconcileCuratedContextItemSource(existing)
        }
      }
      throw await this.classifyContextWriteError(
        error,
        input.entityKey,
        superseded?.id ?? item.id,
        superseded?.revision,
        capturedSource?.comment,
      )
    }
  }

  /** Curated context item を revision 条件付きで更新します。 */
  async updateCuratedContextItem(input: UpdateCuratedContextItemInput) {
    await this.ensureLocalTable()
    assertWorkItemScope(input)
    assertExpectedContextRevision(input.expectedRevision)
    assertCuratedContextAuthorizationSnapshot(input)
    if (input.auditContext) {
      const replayed = await this.getCuratedContextMutationReplay({
        entityKey: input.entityKey,
        operation: 'update',
        itemId: input.itemId,
        auditContext: input.auditContext,
      })
      if (replayed) return replayed
    }
    const before = await this.getRequiredStoredCuratedContextItem(input.entityKey, input.itemId)
    const lastMutationKey = createCuratedContextMutationKey(input.auditContext)
    if (
      lastMutationKey &&
      before.lastMutationKey === lastMutationKey &&
      before.revision === input.expectedRevision + 1
    ) {
      return this.reconcileCuratedContextItemSource(before)
    }
    if (before.state === 'superseded' || before.supersededByItemId) {
      throw new CollaborationError(
        409,
        'ContextAlreadySuperseded',
        'Superseded curated context items are immutable.',
      )
    }

    const actor = normalizeContextActor(input.actor, 'Curated context actor')
    const occurredAt = normalizeIsoTimestamp(
      input.auditContext?.occurredAt ?? new Date().toISOString(),
      'Curated context updatedAt',
    )
    const kind = input.kind === undefined ? before.kind : requireCuratedContextKind(input.kind)
    const state = input.state === undefined ? before.state : requireMutableCuratedContextState(input.state)
    const title = input.title === undefined ? before.title : normalizeContextTitle(input.title)
    const body = input.body === undefined
      ? before.body
      : normalizeContextBody(input.body, 'Curated context body')
    const mentionMemberKeys = input.mentionMemberKeys === undefined
      ? before.mentionMemberKeys
      : normalizeMentionMemberKeys(input.mentionMemberKeys)
    const after: StoredCuratedContextItem = {
      entityKey: before.entityKey,
      recordKey: before.recordKey,
      entryType: 'context',
      schemaVersion: COLLABORATION_CONTEXT_SCHEMA_VERSION,
      id: before.id,
      teamId: before.teamId,
      workItemId: before.workItemId,
      kind,
      state,
      title,
      body,
      ...(before.source ? { source: before.source } : {}),
      mentionMemberKeys,
      createdBy: before.createdBy,
      createdAt: before.createdAt,
      updatedBy: actor,
      updatedAt: occurredAt,
      revision: before.revision + 1,
      ...(lastMutationKey ? { lastMutationKey } : {}),
      ...(before.supersededByItemId
        ? { supersededByItemId: before.supersededByItemId }
        : {}),
    }
    const notificationCandidates = buildContextNotificationCandidates(input)
    const automaticWatchers = buildAutomaticWatcherCandidates(
      actor.id,
      mentionMemberKeys,
      undefined,
      input.automaticWatcherCandidates,
      input.auditContext?.actor.kind === 'service',
    )
    const auditPut = createMutationAuditEventPut(this.auditTableName, input.auditContext, {
      directoryId: input.workspaceId,
      eventType: 'context-item.updated',
      entityType: 'work-item',
      entityId: workItemEntityId(input.teamId, input.issueId),
      target: {
        type: 'context-item',
        id: `${workItemEntityId(input.teamId, input.issueId)}/context-item/${after.id}`,
      },
      action: 'updated',
      occurredAt,
      summary: `Curated ${after.kind} “${after.title}” was updated.`,
      changes: createAuditFieldChanges(
        { kind: before.kind, state: before.state, title: before.title, body: before.body },
        { kind: after.kind, state: after.state, title: after.title, body: after.body },
        ['kind', 'state', 'title', 'body'],
        ['body'],
      ),
      metadata: createContextAuditMetadata(
        input,
        actor.id,
        after.id,
        after.revision,
        notificationCandidates,
      ),
    })

    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          parentIssueCondition(this.parentIssueTableName, input),
          ...curatedContextAuthorizationConditions(input),
          contextLedgerIncrement(this.tableName, input.entityKey),
          contextSnapshotPut(this.tableName, after, input.expectedRevision),
          contextRevisionPut(this.tableName, after),
          ...(input.auditContext
            ? [contextMutationReceiptPut(this.tableName, input.auditContext, 'update', after)]
            : []),
          ...automaticWatchers.map(({ memberKey, reasons }) =>
            autoWatcherUpdate(this.tableName, input.entityKey, memberKey, reasons, occurredAt)
          ),
          ...(auditPut ? [auditPut] : []),
        ],
      }))
      return toCuratedContextItem(after)
    } catch (error) {
      if (isConditionalFailure(error) && input.auditContext) {
        const durableReplay = await this.getCuratedContextMutationReplay({
          entityKey: input.entityKey,
          operation: 'update',
          itemId: input.itemId,
          auditContext: input.auditContext,
        })
        if (durableReplay) return durableReplay
      }
      if (isConditionalFailure(error) && lastMutationKey) {
        const replayed = await this.getStoredCuratedContextItem(input.entityKey, before.id)
        if (
          replayed?.lastMutationKey === lastMutationKey &&
          replayed.revision === input.expectedRevision + 1
        ) {
          return this.reconcileCuratedContextItemSource(replayed)
        }
      }
      throw await this.classifyContextWriteError(
        error,
        input.entityKey,
        before.id,
        input.expectedRevision,
      )
    }
  }

  /** Root thread の accepted resolution を version 条件付きで保存します。 */
  async setAcceptedResolution(input: SetAcceptedResolutionInput) {
    await this.ensureLocalTable()
    assertWorkItemScope(input)
    assertExpectedVersion(input.expectedThreadVersion)
    assertCuratedContextAuthorizationSnapshot(input)
    const rootCommentId = requireIdentifier(input.rootCommentId, 'Root comment ID')
    const sourceCommentId = requireIdentifier(input.commentId, 'Comment ID')
    const actor = normalizeContextActor(input.actor, 'Accepted resolution actor')
    const summary = normalizeContextBody(input.summary, 'Accepted resolution summary')
    const occurredAt = normalizeIsoTimestamp(
      input.auditContext?.occurredAt ?? new Date().toISOString(),
      'Accepted resolution timestamp',
    )
    const resolutionId = createAcceptedResolutionId(
      occurredAt,
      input.auditContext,
      input.entityKey,
      rootCommentId,
      sourceCommentId,
      input.expectedThreadVersion,
    )
    if (input.auditContext) {
      const receipt = await this.getAcceptedResolutionReceipt(
        input.entityKey,
        input.auditContext,
      )
      if (receipt) {
        if (receipt.rootCommentId === rootCommentId &&
            receipt.requestFingerprint === input.auditContext.requestFingerprint &&
            receipt.response.version === input.expectedThreadVersion + 1 &&
            isSameAcceptedResolutionReplay(
              receipt.response,
              sourceCommentId,
              summary,
              actor.id,
            )) {
          return await this.reconcileAcceptedResolutionReceiptResponse(
            input.entityKey,
            receipt.response,
          )
        }
        throw new CollaborationError(
          409,
          'CollaborationIdempotencyConflict',
          'Accepted resolution idempotency key was reused with different input.',
        )
      }
    }

    const root = await this.getRequiredStoredComment(input.entityKey, rootCommentId)
    if (sourceCommentId === root.id) {
      throw new CollaborationError(
        400,
        'AcceptedResolutionNotReply',
        'Accepted resolution source must be a reply in the thread.',
      )
    }
    if (root.parentCommentId || root.rootCommentId !== root.id) {
      throw new CollaborationError(400, 'CommentNotRoot', 'Only root comments can own accepted resolutions.')
    }
    if (root.deletedAt) {
      throw new CollaborationError(409, 'CommentDeleted', 'Deleted threads cannot accept resolutions.')
    }
    if (root.authorMemberKey !== normalizeMemberKey(actor.id) && !input.canModerate) {
      throw new CollaborationError(
        403,
        'AcceptedResolutionDenied',
        'Thread ownership or moderation permission is required.',
      )
    }
    const replayed = input.auditContext
      ? root.acceptedResolutions.find((resolution) => resolution.id === resolutionId)
      : undefined
    if (replayed) {
      if (isSameAcceptedResolutionReplay(root, sourceCommentId, summary, actor.id)) {
        return root
      }
      throw new CollaborationError(
        409,
        'CollaborationIdempotencyConflict',
        'Accepted resolution idempotency key was reused with different input.',
      )
    }

    const current = root.acceptedResolutions.find((resolution) => resolution.state === 'accepted')
    const editingCurrent = current?.sourceCommentId === sourceCommentId
    let selected: StoredComment | undefined
    let capturedCommentRevision: number
    let capturedCommentBody: string
    let capturedCommentAuthorMemberKey: string | undefined
    if (editingCurrent && current) {
      selected = await this.getStoredComment(input.entityKey, sourceCommentId)
      capturedCommentRevision = current.capturedCommentRevision
      capturedCommentBody = current.capturedCommentBody
      capturedCommentAuthorMemberKey = current.capturedCommentAuthorMemberKey
    } else {
      selected = await this.getRequiredStoredComment(input.entityKey, sourceCommentId)
      if (selected.rootCommentId !== root.id) {
        throw new CollaborationError(
          400,
          'AcceptedResolutionCrossThread',
          'Accepted resolution source must belong to the same thread.',
        )
      }
      if (selected.deletedAt) {
        throw new CollaborationError(
          409,
          'AcceptedResolutionSourceDeleted',
          'Deleted comments cannot be accepted as resolutions.',
        )
      }
      capturedCommentRevision = selected.version
      capturedCommentBody = selected.bodyMarkdown
      capturedCommentAuthorMemberKey = selected.authorMemberKey
    }
    const accepted: AcceptedResolution = {
      id: resolutionId,
      sourceCommentId,
      sourceRootCommentId: root.id,
      capturedCommentRevision,
      capturedCommentBody,
      ...(capturedCommentAuthorMemberKey
        ? { capturedCommentAuthorMemberKey }
        : {}),
      summary,
      acceptedBy: actor,
      acceptedAt: occurredAt,
      state: 'accepted',
    }
    const superseded = current
      ? {
          ...current,
          state: 'superseded',
          supersededByResolutionId: accepted.id,
          supersededBy: actor,
          supersededAt: occurredAt,
        } satisfies AcceptedResolution
      : undefined
    const currentWasLegacy = Boolean(
      current && root.legacyAcceptedResolutions.some((resolution) => resolution.id === current.id),
    )
    const legacyAcceptedResolutions = superseded && currentWasLegacy
      ? root.legacyAcceptedResolutions.map((resolution) =>
          resolution.id === superseded.id ? superseded : resolution
        )
      : root.legacyAcceptedResolutions
    const after: StoredComment = {
      ...root,
      acceptedResolutions: [accepted],
      legacyAcceptedResolutions,
      acceptedResolutionId: accepted.id,
      version: root.version + 1,
      updatedAt: occurredAt,
    }
    const acceptedAuditPut = createMutationAuditEventPut(this.auditTableName, input.auditContext, {
      directoryId: input.workspaceId,
      eventType: !current
        ? 'accepted-resolution.selected'
        : editingCurrent
        ? 'accepted-resolution.edited'
        : 'accepted-resolution.replaced',
      entityType: 'work-item',
      entityId: workItemEntityId(input.teamId, input.issueId),
      target: {
        type: 'comment',
        id: `${workItemEntityId(input.teamId, input.issueId)}/comment/${root.id}`,
      },
      action: !current ? 'selected' : editingCurrent ? 'edited' : 'replaced',
      occurredAt,
      summary: !current
        ? 'An accepted resolution was selected.'
        : editingCurrent
          ? 'An accepted resolution summary was edited.'
          : 'An accepted resolution was replaced.',
      changes: createAuditFieldChanges(
        current ? { summary: current.summary } : undefined,
        { summary },
        ['summary'],
        ['summary'],
      ),
      metadata: createAcceptedResolutionAuditMetadata(input, actor.id, sourceCommentId),
      sequence: 0,
    })
    const automaticWatchers = buildAutomaticWatcherCandidates(
      actor.id,
      [],
      selected,
      undefined,
      input.auditContext?.actor.kind === 'service',
    )

    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          parentIssueCondition(this.parentIssueTableName, input),
          ...curatedContextAuthorizationConditions(input),
          ...(!editingCurrent && selected
            ? [commentVersionCondition(this.tableName, input.entityKey, selected)]
            : []),
          {
            Put: {
              TableName: this.tableName,
              Item: toStoredCommentStorageItem(after),
              ConditionExpression: 'attribute_exists(entityKey) AND attribute_exists(recordKey) AND #version = :expectedVersion AND attribute_not_exists(deletedAt)',
              ExpressionAttributeNames: { '#version': 'version' },
              ExpressionAttributeValues: { ':expectedVersion': input.expectedThreadVersion },
            },
          },
          ...(superseded && !currentWasLegacy
            ? [acceptedResolutionPut(this.tableName, input.entityKey, root.id, superseded, occurredAt)]
            : []),
          acceptedResolutionPut(this.tableName, input.entityKey, root.id, accepted, occurredAt),
          ...(input.auditContext
            ? [acceptedResolutionReceiptPut(
                this.tableName,
                input.entityKey,
                root.id,
                resolutionId,
                input.auditContext,
                after,
              )]
            : []),
          ...automaticWatchers.map(({ memberKey, reasons }) =>
            autoWatcherUpdate(this.tableName, input.entityKey, memberKey, reasons, occurredAt)
          ),
          ...(acceptedAuditPut ? [acceptedAuditPut] : []),
        ],
      }))
      return after
    } catch (error) {
      if (isConditionalFailure(error) && input.auditContext) {
        const receipt = await this.getAcceptedResolutionReceipt(
          input.entityKey,
          input.auditContext,
        )
        if (receipt) {
          if (receipt.rootCommentId === root.id &&
              receipt.requestFingerprint === input.auditContext.requestFingerprint &&
              receipt.response.version === input.expectedThreadVersion + 1 &&
              isSameAcceptedResolutionReplay(
                receipt.response,
                sourceCommentId,
                summary,
                actor.id,
              )) {
            return await this.reconcileAcceptedResolutionReceiptResponse(
              input.entityKey,
              receipt.response,
            )
          }
          throw new CollaborationError(
            409,
            'CollaborationIdempotencyConflict',
            'Accepted resolution idempotency key was reused with different input.',
          )
        }
      }
      throw await this.classifyAcceptedResolutionWriteError(
        error,
        input.entityKey,
        root.id,
        input.expectedThreadVersion,
        editingCurrent ? undefined : selected?.id,
        editingCurrent ? undefined : selected?.version,
      )
    }
  }

  /** Root comment または reply を作成します。 */
  async createComment(input: CreateCollaborationCommentInput) {
    await this.ensureLocalTable()
    assertWorkItemScope(input)
    const actorMemberKey = normalizeMemberKey(input.actorMemberKey)
    const bodyMarkdown = normalizeCommentBody(input.bodyMarkdown)
    const mentionMemberKeys = normalizeMentionMemberKeys(input.mentionMemberKeys)
    const occurredAt = input.auditContext?.occurredAt ?? new Date().toISOString()
    const commentId = input.commentId === undefined
      ? createCommentId(occurredAt, input.auditContext, input.entityKey)
      : createTrustedCommentId(input.commentId, input.auditContext)
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
      acceptedResolutions: [],
      legacyAcceptedResolutions: [],
    }
    const discussionTimelineKey = discussionTimelineRecordKey(
      occurredAt,
      commentId,
      parent ? rootCommentId : undefined,
    )
    const discussionScopedKey = discussionScopedRecordKey(
      occurredAt,
      commentId,
      parent ? rootCommentId : undefined,
    )
    const discussionLegacyKey = discussionLegacyRecordKey(
      occurredAt,
      commentId,
      parent ? rootCommentId : undefined,
    )
    const notificationCandidates = await this.buildNotificationCandidates(input, parent)
    const automaticWatchers = buildAutomaticWatcherCandidates(
      actorMemberKey,
      mentionMemberKeys,
      parent,
      input.automaticWatcherCandidates,
      input.auditContext?.actor.kind === 'service',
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
          Item: toStoredCommentStorageItem(comment),
          ConditionExpression: 'attribute_not_exists(entityKey) AND attribute_not_exists(recordKey)',
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: {
            entityKey: input.entityKey,
            recordKey: discussionTimelineKey,
            entryType: 'discussion',
            commentId,
            rootCommentId,
            ...(parent ? { parentCommentId: parent.id } : {}),
            createdAt: occurredAt,
          },
          ConditionExpression: 'attribute_not_exists(entityKey) AND attribute_not_exists(recordKey)',
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: {
            entityKey: input.entityKey,
            recordKey: discussionScopedKey,
            entryType: 'discussion',
            commentId,
            rootCommentId,
            ...(parent ? { parentCommentId: parent.id } : {}),
            createdAt: occurredAt,
          },
          ConditionExpression: 'attribute_not_exists(entityKey) AND attribute_not_exists(recordKey)',
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: {
            entityKey: input.entityKey,
            recordKey: discussionLegacyKey,
            entryType: 'discussion',
            discussionIndexVersion: discussionLegacyIndexVersion,
            commentId,
            rootCommentId,
            ...(parent ? { parentCommentId: parent.id } : {}),
            createdAt: occurredAt,
          },
          ConditionExpression: 'attribute_not_exists(entityKey) AND attribute_not_exists(recordKey)',
        },
      },
      ...(input.authorizationConditionChecks ?? []),
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
      input.auditContext?.actor.kind === 'service',
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

  /** Reads one exact member watcher row without calculating scope-wide counts. */
  async getMemberWatcherState(input: GetWatcherStateInput) {
    await this.ensureLocalTable()
    const entityKey = requireText(input.entityKey, 'Collaboration entity key')
    const memberKey = normalizeMemberKey(input.memberKey)
    const projectEntityKey = input.projectEntityKey === undefined
      ? undefined
      : requireText(input.projectEntityKey, 'Project collaboration entity key')
    const [current, projectCurrent] = await Promise.all([
      this.readMemberWatcher(entityKey, memberKey),
      projectEntityKey === undefined
        ? undefined
        : this.readMemberWatcher(projectEntityKey, memberKey),
    ])
    const reasons = current ? normalizeWatcherReasons(current.reasons) : []

    return {
      subscribed: current?.state === 'subscribed',
      explicit: current?.explicit === true,
      automatic: reasons.some((reason) => reason !== 'manual'),
      reasons,
      ...(current?.mutationIdentity === undefined
        ? {}
        : { mutationIdentity: current.mutationIdentity }),
      ...(current === undefined ? {} : { updatedAt: current.updatedAt }),
      ...(projectEntityKey === undefined
        ? {}
        : { projectSubscribed: projectCurrent?.state === 'subscribed' }),
    } satisfies CollaborationMemberWatcherState
  }

  /** 手動または自動 watcher を保存します。 */
  async subscribe(
    input: UpdateWatcherInput & { expectedSubscribed: boolean },
  ): Promise<CollaborationMemberWatcherState>
  /** Saves a watcher while preserving scope-wide counts for compatibility callers. */
  async subscribe(
    input: Omit<UpdateWatcherInput, 'expectedSubscribed'> & { expectedSubscribed?: undefined },
  ): Promise<CollaborationWatcherState>
  /** Saves a watcher when the optional compare-and-set shape is not statically narrowed. */
  async subscribe(
    input: UpdateWatcherInput,
  ): Promise<CollaborationMemberWatcherState | CollaborationWatcherState>
  /** Saves a manual or automatic watcher and returns the requested projection shape. */
  async subscribe(input: UpdateWatcherInput) {
    validateWatcherUpdateMode(input, 'subscribe')
    const mutationIdentity = normalizeWatcherMutationIdentity(input.mutationIdentity)
    await this.ensureLocalTable()
    const { entityKey, entityType, entityId } = validateWatcherScope(input)
    const parentConditions = watcherParentIssueConditions(this.parentIssueTableName, input)
    const memberKey = normalizeMemberKey(input.memberKey)
    const occurredAt = input.auditContext?.occurredAt ?? new Date().toISOString()
    const reason = input.automatic ? input.reason ?? 'comment' : 'manual'
    const update = input.automatic
      ? autoWatcherUpdate(
          this.tableName,
          entityKey,
          memberKey,
          reason,
          occurredAt,
          mutationIdentity,
        )
      : manualWatcherUpdate(
          this.tableName,
          entityKey,
          memberKey,
          'subscribed',
          occurredAt,
          input.expectedSubscribed,
          mutationIdentity,
        )
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
        TransactItems: [
          ...parentConditions,
          ...(input.authorizationConditionChecks ?? []),
          update,
          ...(auditPut ? [auditPut] : []),
        ],
      }))
    } catch (error) {
      if (!isConditionalFailure(error)) {
        throw toCollaborationStoreError(error)
      }
      if (isAuthorizationConditionFailure(
        error,
        parentConditions.length,
        input.authorizationConditionChecks?.length ?? 0,
      )) {
        throw new CollaborationError(
          409,
          'CollaborationAuthorizationChanged',
          'Watcher authorization changed. Reload and retry the request.',
        )
      }
      if (input.expectedSubscribed !== undefined) {
        throw new CollaborationError(409, 'CollaborationConflict', 'Watcher subscription conflicted.')
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
    const watcherInput = {
      entityKey,
      memberKey,
      projectEntityKey: input.projectEntityKey,
    }
    return input.expectedSubscribed === undefined
      ? this.getWatcherState(watcherInput)
      : this.getMemberWatcherState(watcherInput)
  }

  /** 明示的な unsubscribe tombstone を保存します。 */
  async unsubscribe(
    input: UpdateWatcherInput & { expectedSubscribed: boolean },
  ): Promise<CollaborationMemberWatcherState>
  /** Saves an unsubscribe tombstone while preserving counts for compatibility callers. */
  async unsubscribe(
    input: Omit<UpdateWatcherInput, 'expectedSubscribed'> & { expectedSubscribed?: undefined },
  ): Promise<CollaborationWatcherState>
  /** Saves an unsubscribe tombstone when the optional compare-and-set shape is not narrowed. */
  async unsubscribe(
    input: UpdateWatcherInput,
  ): Promise<CollaborationMemberWatcherState | CollaborationWatcherState>
  /** Saves an explicit unsubscribe tombstone and returns the requested projection shape. */
  async unsubscribe(input: UpdateWatcherInput) {
    validateWatcherUpdateMode(input, 'unsubscribe')
    const mutationIdentity = normalizeWatcherMutationIdentity(input.mutationIdentity)
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
          ...(input.authorizationConditionChecks ?? []),
          manualWatcherUpdate(
            this.tableName,
            entityKey,
            memberKey,
            'unsubscribed',
            occurredAt,
            input.expectedSubscribed,
            mutationIdentity,
          ),
          ...(auditPut ? [auditPut] : []),
        ],
      }))
    } catch (error) {
      if (!isConditionalFailure(error)) {
        throw toCollaborationStoreError(error)
      }
      if (isAuthorizationConditionFailure(
        error,
        parentConditions.length,
        input.authorizationConditionChecks?.length ?? 0,
      )) {
        throw new CollaborationError(
          409,
          'CollaborationAuthorizationChanged',
          'Watcher authorization changed. Reload and retry the request.',
        )
      }
      if (input.expectedSubscribed !== undefined) {
        throw new CollaborationError(409, 'CollaborationConflict', 'Watcher unsubscription conflicted.')
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
    const watcherInput = {
      entityKey,
      memberKey,
      projectEntityKey: input.projectEntityKey,
    }
    return input.expectedSubscribed === undefined
      ? this.getWatcherState(watcherInput)
      : this.getMemberWatcherState(watcherInput)
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
              Item: toStoredCommentStorageItem(after),
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
    if (!response.Item) {
      return undefined
    }
    return toStoredComment(response.Item)
  }

  private async getRequiredStoredComment(entityKey: string, commentId: string) {
    const comment = await this.getStoredComment(entityKey, requireIdentifier(commentId, 'Comment ID'))

    if (!comment) {
      throw new CollaborationError(404, 'CommentNotFound', 'Comment was not found.')
    }

    return comment
  }

  /**
   * Reads one deterministic accepted-resolution receipt directly.
   *
   * @param entityKey - Collaboration scope key.
   * @param context - Request identity used to derive and validate the receipt key.
   * @returns Validated receipt, or undefined when no receipt exists.
   */
  private async getAcceptedResolutionReceipt(
    entityKey: string,
    context: MutationAuditContext,
  ) {
    const recordKey = acceptedResolutionReceiptRecordKey(context)
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        entityKey,
        recordKey,
      },
      ConsistentRead: true,
    }))
    return response.Item
      ? toStoredAcceptedResolutionReceipt(
          response.Item,
          entityKey,
          recordKey,
        )
      : undefined
  }

  /**
   * Rehydrates non-resolution root fields without replaying text removed by a
   * later edit or soft deletion.
   *
   * @param entityKey - Collaboration scope key.
   * @param response - Bounded accepted-resolution response retained by the receipt.
   * @returns Receipt resolution evidence with current permission-safe root text.
   */
  private async reconcileAcceptedResolutionReceiptResponse(
    entityKey: string,
    response: StoredComment,
  ) {
    const current = await this.getStoredComment(entityKey, response.id)
    if (!current) {
      return {
        ...response,
        bodyMarkdown: '',
        mentionMemberKeys: [],
        deletedAt: response.deletedAt ?? response.updatedAt,
      } satisfies StoredComment
    }
    return {
      ...response,
      bodyMarkdown: current.bodyMarkdown,
      mentionMemberKeys: current.mentionMemberKeys,
      editedAt: current.editedAt,
      deletedAt: current.deletedAt,
    } satisfies StoredComment
  }

  /**
   * Validates and captures immutable provenance for a context mutation.
   *
   * @param entityKey - Collaboration entity containing any referenced comment.
   * @param source - Caller-supplied source provenance.
   * @returns Canonical capture-time provenance.
   */
  private async captureCuratedContextSource(
    entityKey: string,
    source: CuratedContextSource,
  ): Promise<CapturedCuratedContextSource> {
    const normalized = normalizeCuratedContextSource(source)
    if (normalized.availability !== 'available') {
      throw new CollaborationError(
        409,
        'ContextSourceUnavailable',
        'Only currently available sources can be captured.',
      )
    }
    if (normalized.kind !== 'comment') {
      return { source: normalized }
    }

    const comment = await this.getRequiredStoredComment(entityKey, normalized.sourceId)
    if (comment.deletedAt) {
      throw new CollaborationError(
        409,
        'ContextSourceDeleted',
        'Deleted comments cannot be captured as context sources.',
      )
    }
    if (normalized.containerId && normalized.containerId !== comment.rootCommentId) {
      throw new CollaborationError(
        400,
        'InvalidContextSource',
        'Comment source container does not match its thread.',
      )
    }
    if (normalized.originalBody !== undefined && normalized.originalBody !== comment.bodyMarkdown) {
      throw new CollaborationError(
        409,
        'ContextSourceRevisionConflict',
        'Comment source changed before it could be captured.',
      )
    }
    if (normalized.capturedRevision !== undefined &&
        normalized.capturedRevision !== comment.version) {
      throw new CollaborationError(
        409,
        'ContextSourceRevisionConflict',
        'Comment source changed before it could be captured.',
      )
    }
    if (normalized.actor && normalizeMemberKey(normalized.actor.id) !== comment.authorMemberKey) {
      throw new CollaborationError(
        400,
        'InvalidContextSource',
        'Comment source actor does not match the comment author.',
      )
    }
    const quote = normalized.quote
      ? normalizeCuratedContextQuote(normalized.quote, comment.bodyMarkdown)
      : undefined

    return {
      comment,
      source: {
        ...normalized,
        containerId: comment.rootCommentId,
        originalBody: comment.bodyMarkdown,
        ...(quote ? { quote } : {}),
        occurredAt: comment.createdAt,
        capturedRevision: comment.version,
        currentRevision: comment.version,
        availability: 'available',
        availabilityReason: undefined,
      },
    }
  }

  /**
   * Reconciles a stored comment source with the current comment without mutating capture evidence.
   *
   * @param stored - Stored curated context current snapshot.
   * @returns Public item with current source availability.
   */
  private async reconcileCuratedContextItemSource(stored: StoredCuratedContextItem) {
    const item = toCuratedContextItem(stored)
    if (item.source?.kind !== 'comment') {
      return item
    }

    const current = await this.getStoredComment(stored.entityKey, item.source.sourceId)
    const source = item.source
    if (!current) {
      return {
        ...item,
        source: {
          ...source,
          availability: 'deleted',
          currentRevision: undefined,
          availabilityReason: 'The source comment is no longer available.',
        },
      } satisfies CuratedContextItem
    }
    if (current.deletedAt) {
      return {
        ...item,
        source: {
          ...source,
          availability: 'deleted',
          currentRevision: current.version,
          availabilityReason: 'The source comment was deleted after capture.',
        },
      } satisfies CuratedContextItem
    }
    const bodyWasEdited = source.originalBody === undefined
      ? source.capturedRevision !== current.version
      : source.originalBody !== current.bodyMarkdown
    if (bodyWasEdited) {
      return {
        ...item,
        source: {
          ...source,
          availability: 'edited',
          currentRevision: current.version,
          availabilityReason: 'The source comment was edited after capture.',
        },
      } satisfies CuratedContextItem
    }
    return {
      ...item,
      source: {
        ...source,
        availability: 'available',
        currentRevision: current.version,
        availabilityReason: undefined,
      },
    } satisfies CuratedContextItem
  }

  /**
   * Reads a curated context current snapshot consistently.
   *
   * @param entityKey - Collaboration entity key.
   * @param itemId - Curated context item identifier.
   * @returns Stored item when present.
   */
  private async getStoredCuratedContextItem(entityKey: string, itemId: string) {
    try {
      const response = await this.documentClient.send(new GetCommand({
        TableName: this.tableName,
        Key: { entityKey, recordKey: contextItemRecordKey(itemId) },
        ConsistentRead: true,
      }))
      return response.Item ? toStoredCuratedContextItem(response.Item) : undefined
    } catch (error) {
      throw toCollaborationStoreError(error)
    }
  }

  /**
   * Reads the current curated-context ledger generation consistently.
   *
   * @param entityKey - Work Item collaboration entity key.
   * @returns The current generation, or zero for a legacy scope without a ledger row.
   */
  private async getCuratedContextLedgerGeneration(entityKey: string): Promise<number> {
    try {
      const response = await this.documentClient.send(new GetCommand({
        TableName: this.tableName,
        Key: { entityKey, recordKey: CURATED_CONTEXT_LEDGER_RECORD_KEY },
        ConsistentRead: true,
      }))
      const item = response.Item
      if (item === undefined) return 0
      if (
        item.entryType !== 'context-ledger' ||
        item.entityKey !== entityKey ||
        item.recordKey !== CURATED_CONTEXT_LEDGER_RECORD_KEY ||
        !isNonNegativeSafeInteger(item.generation)
      ) {
        throw new CollaborationError(
          503,
          'InvalidCollaborationRecord',
          'Curated context ledger record is invalid.',
        )
      }
      return item.generation
    } catch (error) {
      throw toCollaborationStoreError(error)
    }
  }

  /**
   * Reads a curated-context mutation receipt consistently.
   *
   * @param entityKey - Collaboration entity key.
   * @param context - Request identity used to derive and validate the receipt key.
   * @returns Stored receipt when present.
   */
  private async getStoredCuratedContextMutationReceipt(
    entityKey: string,
    context: MutationAuditContext,
  ) {
    const recordKey = contextMutationReceiptRecordKey(context)
    try {
      const response = await this.documentClient.send(new GetCommand({
        TableName: this.tableName,
        Key: { entityKey, recordKey },
        ConsistentRead: true,
      }))
      return response.Item
        ? toStoredCuratedContextMutationReceipt(response.Item, entityKey, recordKey)
        : undefined
    } catch (error) {
      throw toCollaborationStoreError(error)
    }
  }

  /**
   * Reads one immutable curated-context revision consistently.
   *
   * @param entityKey - Collaboration entity key.
   * @param itemId - Curated-context item identifier.
   * @param revision - Positive immutable revision number.
   * @returns Stored revision when present.
   */
  private async getStoredCuratedContextRevision(
    entityKey: string,
    itemId: string,
    revision: number,
  ) {
    try {
      const response = await this.documentClient.send(new GetCommand({
        TableName: this.tableName,
        Key: { entityKey, recordKey: contextRevisionRecordKey(itemId, revision) },
        ConsistentRead: true,
      }))
      return response.Item
        ? toStoredCuratedContextRevision(response.Item, entityKey, itemId)
        : undefined
    } catch (error) {
      throw toCollaborationStoreError(error)
    }
  }

  /**
   * Reads a required curated context current snapshot.
   *
   * @param entityKey - Collaboration entity key.
   * @param itemId - Curated context item identifier.
   * @returns Stored item.
   */
  private async getRequiredStoredCuratedContextItem(entityKey: string, itemId: string) {
    const item = await this.getStoredCuratedContextItem(
      entityKey,
      requireIdentifier(itemId, 'Curated context item ID'),
    )
    if (!item) {
      throw new CollaborationError(404, 'ContextNotFound', 'Curated context item was not found.')
    }
    return item
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

  /**
   * Reads and validates one exact watcher row with a consistent point read.
   *
   * @param entityKey - Collaboration entity partition key.
   * @param memberKey - Normalized Workspace member key.
   * @returns The stored watcher row, or undefined when no row exists.
   */
  private async readMemberWatcher(entityKey: string, memberKey: string) {
    const recordKey = watcherRecordKey(memberKey)
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { entityKey, recordKey },
      ConsistentRead: true,
    }))
    if (response.Item === undefined) return undefined

    const watcher = toStoredWatcher(response.Item)
    if (
      watcher.entityKey !== entityKey ||
      watcher.recordKey !== recordKey ||
      watcher.memberKey !== memberKey
    ) {
      throw new CollaborationError(
        503,
        'InvalidCollaborationRecord',
        'Watcher record identity is invalid.',
      )
    }
    return watcher
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

  /**
   * Classifies a conditional context mutation failure using a consistent current read.
   *
   * @param error - DynamoDB mutation error.
   * @param entityKey - Collaboration entity key.
   * @param itemId - Curated context item identifier.
   * @param expectedRevision - Revision fenced by the mutation.
   * @param sourceComment - Optional comment snapshot fenced as newly captured evidence.
   * @returns Stable collaboration error.
   */
  private async classifyContextWriteError(
    error: unknown,
    entityKey: string,
    itemId: string,
    expectedRevision?: number,
    sourceComment?: StoredComment,
  ) {
    if (!isConditionalFailure(error)) {
      return toCollaborationStoreError(error)
    }
    const current = await this.getStoredCuratedContextItem(entityKey, itemId)
    if (!current && expectedRevision !== undefined) {
      return new CollaborationError(404, 'ContextNotFound', 'Curated context item was not found.')
    }
    if (expectedRevision !== undefined && current?.revision !== expectedRevision) {
      return new CollaborationError(
        409,
        'ContextRevisionConflict',
        'Curated context changed after it was loaded.',
      )
    }
    if (sourceComment) {
      const currentSource = await this.getStoredComment(entityKey, sourceComment.id)
      if (
        !currentSource ||
        currentSource.deletedAt ||
        currentSource.version !== sourceComment.version
      ) {
        return new CollaborationError(
          409,
          'ContextSourceRevisionConflict',
          'Curated context source changed before the item could be saved.',
        )
      }
    }
    return new CollaborationError(409, 'CollaborationConflict', 'Collaboration mutation conflicted.')
  }

  /**
   * Classifies a conditional accepted-resolution mutation failure.
   *
   * @param error - DynamoDB mutation error.
   * @param entityKey - Collaboration entity key.
   * @param rootCommentId - Root comment identifier.
   * @param expectedVersion - Root version fenced by the mutation.
   * @param sourceCommentId - Accepted reply identifier when the source is transaction-fenced.
   * @param capturedSourceVersion - Reply version captured before a source-fenced transaction.
   * @returns Stable collaboration error.
   */
  private async classifyAcceptedResolutionWriteError(
    error: unknown,
    entityKey: string,
    rootCommentId: string,
    expectedVersion: number,
    sourceCommentId?: string,
    capturedSourceVersion?: number,
  ) {
    if (!isConditionalFailure(error)) {
      return toCollaborationStoreError(error)
    }
    const current = await this.getStoredComment(entityKey, rootCommentId)
    if (!current) {
      return new CollaborationError(404, 'CommentNotFound', 'Root comment was not found.')
    }
    if (current.version !== expectedVersion) {
      return new CollaborationError(
        409,
        'ThreadVersionConflict',
        'Thread changed after it was loaded.',
      )
    }
    if (sourceCommentId !== undefined && capturedSourceVersion !== undefined) {
      const source = await this.getStoredComment(entityKey, sourceCommentId)
      if (!source || source.deletedAt || source.version !== capturedSourceVersion) {
        return new CollaborationError(
          409,
          'AcceptedResolutionSourceConflict',
          'Accepted resolution source changed after it was loaded.',
        )
      }
    }
    return new CollaborationError(409, 'CollaborationConflict', 'Accepted resolution mutation conflicted.')
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

/**
 * Rejects watcher update modes whose optional controls would otherwise be ignored.
 *
 * @param input - Untrusted watcher update request.
 * @param operation - Requested watcher transition.
 */
function validateWatcherUpdateMode(
  input: UpdateWatcherInput,
  operation: 'subscribe' | 'unsubscribe',
): void {
  if (
    input.automatic === true &&
    (input.expectedSubscribed !== undefined || operation === 'unsubscribe')
  ) {
    throw new CollaborationError(
      400,
      'InvalidWatcherUpdate',
      'Automatic watcher updates cannot use manual watcher transition controls.',
    )
  }
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

/**
 * Builds the canonical parent condition used while copying a legacy comment.
 *
 * Legacy events do not retain the assigned-project snapshot required by a live
 * collaboration mutation, so migration fences the immutable Work Item identity
 * and schema plus the observed revision while leaving mutable assignment values
 * unconstrained.
 *
 * @param tableName - Canonical Work Item table name.
 * @param input - Legacy comment scope.
 * @param parentRevision - Revision observed by the preceding canonical read.
 * @returns A DynamoDB condition check for the parent Work Item.
 */
function parentIssueBackfillCondition(
  tableName: string,
  input: WorkItemCollaborationScope,
  parentRevision: number,
) {
  const directoryTeamId = `${input.workspaceId}#team#${input.teamId}`
  const requiredAttributes = [
    'schemaVersion',
    'revision',
    'workflowSchemaVersion',
    'directoryId',
    'directoryTeamId',
    'teamId',
    'issueId',
    'sortOrder',
    'title',
    'assigneeUserId',
    'creatorMemberKey',
    'workflowStatusId',
    'statusCategory',
    'customFieldValues',
    'relationIds',
    'dueDate',
    'schedule',
    'priority',
    'createdAt',
    'updatedAt',
  ]
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: {
        directoryTeamId,
        issueId: input.issueId,
      },
      ConditionExpression: [
        ...requiredAttributes.map((attribute) => `attribute_exists(${attribute})`),
        'schemaVersion = :schemaVersion',
        'revision = :revision',
        'workflowSchemaVersion = :workflowSchemaVersion',
        'directoryId = :directoryId',
        'directoryTeamId = :directoryTeamId',
        'teamId = :teamId',
        'issueId = :issueId',
      ].join(' AND '),
      ExpressionAttributeValues: {
        ':schemaVersion': WORK_ITEM_SCHEMA_VERSION,
        ':revision': parentRevision,
        ':workflowSchemaVersion': WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
        ':directoryId': input.workspaceId,
        ':directoryTeamId': directoryTeamId,
        ':teamId': input.teamId,
        ':issueId': input.issueId,
      },
    },
  }
}

/** Checks that a parent row is the canonical Work Item for the requested scope. */
function isCanonicalBackfillParent(
  value: unknown,
  input: Pick<WorkItemCollaborationScope, 'workspaceId' | 'teamId' | 'issueId'>,
): value is CanonicalWorkItemRecord {
  return isCanonicalWorkItemRecord(value) &&
    value.directoryId === input.workspaceId &&
    value.teamId === input.teamId &&
    value.issueId === input.issueId
}

/** Validates the immutable timestamp copied from a legacy event. */
function normalizeBackfillTimestamp(value: string) {
  const normalized = requireText(value, 'Backfill timestamp')
  const parsed = Date.parse(normalized)
  if (!Number.isFinite(parsed)) {
    throw new CollaborationError(400, 'InvalidCollaborationInput', 'Backfill timestamp is invalid.')
  }
  return new Date(parsed).toISOString()
}

/**
 * Normalizes and validates one legacy comment before dry-run or write processing.
 *
 * @param input - Untrusted legacy comment and Work Item scope.
 * @returns The input with canonical identifier, body, and timestamp values.
 */
function normalizeBackfillCollaborationCommentInput(
  input: BackfillCollaborationCommentInput,
): BackfillCollaborationCommentInput {
  assertWorkItemScope(input)
  return {
    ...input,
    commentId: requireIdentifier(input.commentId, 'Comment ID'),
    actorMemberKey: normalizeMemberKey(input.actorMemberKey),
    bodyMarkdown: normalizeBackfillCommentBody(input.bodyMarkdown),
    occurredAt: normalizeBackfillTimestamp(input.occurredAt),
  }
}

/** Creates the stable record key for one immutable backfill provenance receipt. */
function backfillReceiptRecordKey(commentId: string) {
  return `BACKFILL#${requireIdentifier(commentId, 'Comment ID')}`
}

/** Creates a digest that binds a receipt to the original legacy comment payload. */
function createBackfillSourceBodyFingerprint(input: BackfillCollaborationCommentInput) {
  return createHash('sha256')
    .update(`${input.commentId}\0${input.actorMemberKey}\0${input.occurredAt}\0${input.bodyMarkdown}`)
    .digest('hex')
}

/** Creates the immutable provenance row written with a canonical backfill comment. */
function createBackfillReceiptRecord(
  input: BackfillCollaborationCommentInput,
): StoredBackfillReceipt {
  return {
    entityKey: input.entityKey,
    recordKey: backfillReceiptRecordKey(input.commentId),
    entryType: 'team-issue-comment-backfill-receipt',
    commentId: input.commentId,
    sourceActorMemberKey: input.actorMemberKey,
    sourceOccurredAt: input.occurredAt,
    sourceBodyFingerprint: createBackfillSourceBodyFingerprint(input),
  }
}

/** Validates one immutable backfill provenance row read from DynamoDB. */
function toStoredBackfillReceipt(
  value: Record<string, unknown>,
  entityKey: string,
  recordKey: string,
): StoredBackfillReceipt {
  if (
    value.entryType !== 'team-issue-comment-backfill-receipt' ||
    value.entityKey !== entityKey ||
    value.recordKey !== recordKey ||
    typeof value.commentId !== 'string' ||
    typeof value.sourceActorMemberKey !== 'string' ||
    typeof value.sourceOccurredAt !== 'string' ||
    typeof value.sourceBodyFingerprint !== 'string'
  ) {
    throw new CollaborationError(
      503,
      'InvalidCollaborationRecord',
      'Backfill provenance receipt is invalid.',
    )
  }
  return {
    entityKey,
    recordKey,
    entryType: 'team-issue-comment-backfill-receipt',
    commentId: requireIdentifier(value.commentId, 'Backfill receipt comment ID'),
    sourceActorMemberKey: normalizeMemberKey(value.sourceActorMemberKey),
    sourceOccurredAt: normalizeBackfillTimestamp(value.sourceOccurredAt),
    sourceBodyFingerprint: value.sourceBodyFingerprint,
  }
}

/** Checks whether a receipt belongs to the currently scanned legacy comment. */
function isSameBackfillReceipt(
  receipt: StoredBackfillReceipt,
  input: BackfillCollaborationCommentInput,
) {
  return receipt.entityKey === input.entityKey &&
    receipt.recordKey === backfillReceiptRecordKey(input.commentId) &&
    receipt.commentId === input.commentId &&
    receipt.sourceActorMemberKey === input.actorMemberKey &&
    receipt.sourceOccurredAt === input.occurredAt &&
    receipt.sourceBodyFingerprint === createBackfillSourceBodyFingerprint(input)
}

/** Checks immutable comment identity while allowing later body and lifecycle mutations. */
function isBackfilledCommentIdentity(
  existing: StoredComment,
  input: BackfillCollaborationCommentInput,
) {
  return existing.id === input.commentId &&
    existing.rootCommentId === input.commentId &&
    existing.authorMemberKey === input.actorMemberKey &&
    existing.createdAt === input.occurredAt
}

/** Validates one persisted Team Issue comment backfill marker. */
function isCompletedTeamIssueCommentBackfillMarker(
  value: unknown,
  targetTableName: string,
  sourceTableName: string,
): boolean {
  return isRecord(value) &&
    value.entryType === 'migration-marker' &&
    value.migration === 'team-issue-comments' &&
    value.version === TEAM_ISSUE_COMMENT_BACKFILL_VERSION &&
    value.state === 'complete' &&
    value.targetTableName === targetTableName &&
    value.sourceTableName === sourceTableName &&
    typeof value.completedAt === 'string' &&
    Number.isFinite(Date.parse(value.completedAt))
}

/**
 * Validates the caller authorization generation carried into a context mutation.
 *
 * @param input - Context mutation scope and actor.
 * @returns Nothing when the snapshot is valid or omitted for trusted internal callers.
 * @throws CollaborationError when the snapshot does not identify the actor.
 */
function assertCuratedContextAuthorizationSnapshot(
  input: CuratedContextAuthorizationInput,
): void {
  const snapshot = input.authorizationSnapshot
  if (!snapshot) return
  if (
    typeof snapshot.memberKey !== 'string' ||
    snapshot.memberKey.trim().length === 0 ||
    snapshot.memberKey !== input.actor.id ||
    !Number.isSafeInteger(snapshot.workspaceMemberVersion) ||
    snapshot.workspaceMemberVersion < 0 ||
    (snapshot.enterpriseControlRevision !== undefined &&
      (!Number.isSafeInteger(snapshot.enterpriseControlRevision) ||
        snapshot.enterpriseControlRevision < 0))
  ) {
    throw new CollaborationError(
      400,
      'InvalidAuthorizationSnapshot',
      'Curated context authorization snapshot is invalid.',
    )
  }
}

/**
 * Validates a Document source snapshot before it is converted into DynamoDB
 * conditions.  The source snapshot is required whenever a mutation captures
 * a fresh Document; replacements that inherit an existing source do not need
 * to re-fence the source.
 *
 * @param input - Curated-context mutation carrying an optional Document source.
 * @returns Nothing when the snapshot is valid.
 * @throws CollaborationError when the source and authorization snapshots do not match.
 */
function assertCuratedContextDocumentSourceAuthorizationSnapshot(
  input: CreateCuratedContextItemInput,
): void {
  const source = input.source
  const snapshot = input.sourceAuthorizationSnapshot
  if (source?.kind !== 'document') {
    if (snapshot !== undefined) {
      throw new CollaborationError(
        400,
        'InvalidDocumentSourceAuthorizationSnapshot',
        'A Document authorization snapshot requires a Document source.',
      )
    }
    return
  }
  if (snapshot === undefined || snapshot.sourceId !== source.sourceId) {
    throw new CollaborationError(
      400,
      'InvalidDocumentSourceAuthorizationSnapshot',
      'A Document source must carry the authorization snapshot used to read it.',
    )
  }
  if (
    !Number.isSafeInteger(snapshot.documentRevision) ||
    snapshot.documentRevision < 1 ||
    source.capturedRevision !== snapshot.documentRevision ||
    !Number.isSafeInteger(snapshot.documentAuthorizationRevision) ||
    snapshot.documentAuthorizationRevision < 0
  ) {
    throw new CollaborationError(
      400,
      'InvalidDocumentSourceAuthorizationSnapshot',
      'The Document source revision snapshot is invalid.',
    )
  }
  if (
    snapshot.workspaceMemberKey !== undefined &&
    (
      snapshot.workspaceMemberVersion === undefined ||
      snapshot.workspaceMemberKey !== input.authorizationSnapshot?.memberKey ||
      snapshot.workspaceMemberVersion !== input.authorizationSnapshot.workspaceMemberVersion
    )
  ) {
    throw new CollaborationError(
      400,
      'InvalidDocumentSourceAuthorizationSnapshot',
      'The Document source membership snapshot does not match the mutation actor.',
    )
  }
  if (
    snapshot.enterpriseControlRevision !== undefined &&
    input.authorizationSnapshot?.enterpriseControlRevision !== undefined &&
    snapshot.enterpriseControlRevision !==
      input.authorizationSnapshot.enterpriseControlRevision
  ) {
    throw new CollaborationError(
      409,
      'CuratedContextSourceAuthorizationChanged',
      'Enterprise authorization changed while the Document source was being read.',
    )
  }
  if (
    snapshot.workspaceMemberKey === undefined &&
    snapshot.workspaceMemberVersion !== undefined
  ) {
    throw new CollaborationError(
      400,
      'InvalidDocumentSourceAuthorizationSnapshot',
      'The Document source membership snapshot must include a member key.',
    )
  }
  for (const generation of [
    snapshot.workspaceMemberVersion,
    snapshot.planningRevision,
    snapshot.enterpriseControlRevision,
  ]) {
    if (
      generation !== undefined &&
      (!Number.isSafeInteger(generation) || generation < 0)
    ) {
      throw new CollaborationError(
        400,
        'InvalidDocumentSourceAuthorizationSnapshot',
        'The Document source authorization generation is invalid.',
      )
    }
  }
}

/**
 * Validates an Activity retention snapshot before it is converted into a
 * DynamoDB condition.
 *
 * @param input - Curated-context create input carrying an optional activity source.
 * @returns Nothing when the snapshot is valid.
 * @throws CollaborationError when the snapshot does not identify the source.
 */
function assertCuratedContextActivitySourceAuthorizationSnapshot(
  input: CreateCuratedContextItemInput,
): void {
  const source = input.source
  const snapshot = input.activitySourceAuthorizationSnapshot
  if (source?.kind !== 'activity') {
    if (snapshot !== undefined) {
      throw new CollaborationError(
        400,
        'InvalidActivitySourceAuthorizationSnapshot',
        'An Activity authorization snapshot requires an Activity source.',
      )
    }
    return
  }
  if (snapshot === undefined) {
    throw new CollaborationError(
      400,
      'InvalidActivitySourceAuthorizationSnapshot',
      'An Activity source must carry the retention snapshot used to read it.',
    )
  }
  if (
    snapshot.sourceId !== source.sourceId ||
    snapshot.sourceId.trim().length === 0 ||
    (snapshot.expiresAt !== undefined &&
      (!Number.isSafeInteger(snapshot.expiresAt) ||
        snapshot.expiresAt <= Math.floor(Date.now() / 1_000) +
          curatedContextActivityMinimumRemainingSeconds))
  ) {
    throw new CollaborationError(
      400,
      'InvalidActivitySourceAuthorizationSnapshot',
      'The Activity source retention snapshot is invalid.',
    )
  }
}

/**
 * Creates the membership generation condition used by curated-context writes.
 *
 * @param input - Context mutation scope containing the authorization snapshot.
 * @returns DynamoDB transaction conditions for the current membership row.
 */
function curatedContextAuthorizationConditions(
  input: CuratedContextAuthorizationInput,
): NonNullable<TransactWriteCommandInput['TransactItems']> {
  const snapshot = input.authorizationSnapshot
  if (!snapshot) return []
  const tableName =
    readEnvironment('MUKUROJI_WORKSPACE_ACCESS_TABLE') ??
    readEnvironment('WORKSPACE_ACCESS_TABLE_NAME') ??
    'mukuroji-workspace-access-local'
  const conditions: NonNullable<TransactWriteCommandInput['TransactItems']> = [{
    ConditionCheck: {
      TableName: tableName,
      Key: {
        workspaceId: input.workspaceId,
        recordKey: `MEMBER#${normalizeMemberKey(snapshot.memberKey)}`,
      },
      ConditionExpression:
        'entryType = :workspaceMemberEntryType AND #status = :activeStatus AND #version = :workspaceMemberVersion',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#version': 'version',
      },
      ExpressionAttributeValues: {
        ':workspaceMemberEntryType': 'workspace-member',
        ':activeStatus': 'active',
        ':workspaceMemberVersion': snapshot.workspaceMemberVersion,
      },
    },
  }]
  const enterpriseTableName = readEnvironment('ENTERPRISE_IDENTITY_TABLE_NAME')
  if (enterpriseTableName && snapshot.enterpriseControlRevision !== undefined) {
    const controlRevision = snapshot.enterpriseControlRevision
    conditions.push({
      ConditionCheck: {
        TableName: enterpriseTableName,
        Key: {
          scopeKey: `WORKSPACE#${input.workspaceId}`,
          recordKey: 'CONTROL',
        },
        ConditionExpression: controlRevision === 0
          ? '(attribute_not_exists(#scopeKey) OR ' +
            '(#entryType = :controlEntryType AND #controlRevision = :expectedControlRevision))'
          : '#entryType = :controlEntryType AND #controlRevision = :expectedControlRevision',
        ExpressionAttributeNames: {
          '#scopeKey': 'scopeKey',
          '#entryType': 'entryType',
          '#controlRevision': 'controlRevision',
        },
        ExpressionAttributeValues: {
          ':controlEntryType': 'enterprise-identity-control',
          ':expectedControlRevision': controlRevision,
        },
      },
    })
  }
  return conditions
}

/**
 * Creates transaction conditions for the Document source and its authorization
 * generations.  These conditions are intentionally built in the collaboration
 * adapter so source access cannot change between permission-checked read and
 * context-item commit.
 *
 * @param input - Curated-context mutation scope.
 * @param snapshot - Document source snapshot captured by the API adapter.
 * @returns DynamoDB transaction conditions for the source rows.
 */
function curatedContextDocumentSourceConditions(
  input: CuratedContextMutationInput,
  snapshot: CuratedContextDocumentSourceAuthorizationSnapshot,
): NonNullable<TransactWriteCommandInput['TransactItems']> {
  const documentsTableName =
    readEnvironment('DOCUMENTS_TABLE_NAME') ??
    readEnvironment('MUKUROJI_DOCUMENTS_TABLE') ??
    'mukuroji-documents-local'
  const conditions: NonNullable<TransactWriteCommandInput['TransactItems']> = [
    {
      ConditionCheck: {
        TableName: documentsTableName,
        Key: {
          workspaceId: input.workspaceId,
          recordKey: `DOCUMENT#${snapshot.sourceId}`,
        },
        ConditionExpression:
          'entryType = :documentEntryType AND documentId = :documentId AND #revision = :documentRevision',
        ExpressionAttributeNames: { '#revision': 'revision' },
        ExpressionAttributeValues: {
          ':documentEntryType': 'document',
          ':documentId': snapshot.sourceId,
          ':documentRevision': snapshot.documentRevision,
        },
      },
    },
    {
      ConditionCheck: {
        TableName: documentsTableName,
        Key: {
          workspaceId: input.workspaceId,
          recordKey: 'DOCUMENT_AUTHORIZATION_REVISION',
        },
        ConditionExpression:
          snapshot.documentAuthorizationRevision === 0
            ? 'attribute_not_exists(workspaceId)'
            : 'entryType = :authorizationEntryType AND #revision = :documentAuthorizationRevision',
        ...(snapshot.documentAuthorizationRevision === 0
          ? {}
          : {
              ExpressionAttributeNames: { '#revision': 'revision' },
              ExpressionAttributeValues: {
                ':authorizationEntryType': 'document-authorization-revision',
                ':documentAuthorizationRevision': snapshot.documentAuthorizationRevision,
              },
            }),
      },
    },
  ]

  const mutationAuthorizationSnapshot = input.authorizationSnapshot
  if (
    snapshot.workspaceMemberKey !== undefined &&
    mutationAuthorizationSnapshot === undefined
  ) {
    conditions.push({
      ConditionCheck: {
        TableName:
          readEnvironment('MUKUROJI_WORKSPACE_ACCESS_TABLE') ??
          readEnvironment('WORKSPACE_ACCESS_TABLE_NAME') ??
          'mukuroji-workspace-access-local',
        Key: {
          workspaceId: input.workspaceId,
          recordKey: `MEMBER#${normalizeMemberKey(snapshot.workspaceMemberKey)}`,
        },
        ConditionExpression:
          'entryType = :workspaceMemberEntryType AND #status = :activeStatus AND #version = :workspaceMemberVersion',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#version': 'version',
        },
        ExpressionAttributeValues: {
          ':workspaceMemberEntryType': 'workspace-member',
          ':activeStatus': 'active',
          ':workspaceMemberVersion': snapshot.workspaceMemberVersion,
        },
      },
    })
  }

  if (snapshot.planningRevision !== undefined) {
    conditions.push({
      ConditionCheck: {
        TableName: readEnvironment('PLANNING_TABLE_NAME') ?? 'mukuroji-planning-local',
        Key: {
          workspaceId: `FENCE#${input.workspaceId}`,
          recordKey: 'META',
        },
        ConditionExpression: snapshot.planningRevision === 0
          ? 'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)'
          : 'entryType = :planningEntryType AND #revision = :planningRevision',
        ...(snapshot.planningRevision === 0
          ? {}
          : {
              ExpressionAttributeNames: { '#revision': 'revision' },
              ExpressionAttributeValues: {
                ':planningEntryType': 'planning-meta',
                ':planningRevision': snapshot.planningRevision,
              },
            }),
      },
    })
  }

  const enterpriseTableName = readEnvironment('ENTERPRISE_IDENTITY_TABLE_NAME')
  if (
    enterpriseTableName &&
    snapshot.enterpriseControlRevision !== undefined &&
    mutationAuthorizationSnapshot?.enterpriseControlRevision === undefined
  ) {
    conditions.push({
      ConditionCheck: {
        TableName: enterpriseTableName,
        Key: {
          scopeKey: `WORKSPACE#${input.workspaceId}`,
          recordKey: 'CONTROL',
        },
        ConditionExpression: snapshot.enterpriseControlRevision === 0
          ? 'attribute_not_exists(scopeKey)'
          : 'entryType = :enterpriseEntryType AND #controlRevision = :enterpriseControlRevision',
        ...(snapshot.enterpriseControlRevision === 0
          ? {}
          : {
              ExpressionAttributeNames: { '#controlRevision': 'controlRevision' },
              ExpressionAttributeValues: {
                ':enterpriseEntryType': 'enterprise-identity-control',
                ':enterpriseControlRevision': snapshot.enterpriseControlRevision,
              },
            }),
      },
    })
  }
  return conditions
}

/**
 * Creates the audit-row retention condition for an Activity source capture.
 *
 * @param input - Curated-context mutation scope.
 * @param snapshot - Retention deadline captured from the audit source read.
 * @returns DynamoDB transaction conditions for the source row.
 */
function curatedContextActivitySourceConditions(
  input: CuratedContextMutationInput,
  snapshot: CuratedContextActivitySourceAuthorizationSnapshot,
): NonNullable<TransactWriteCommandInput['TransactItems']> {
  const auditTableName =
    readEnvironment('MUKUROJI_AUDIT_EVENTS_TABLE') ??
    readEnvironment('AUDIT_EVENTS_TABLE_NAME') ??
    'mukuroji-audit-events'
  const hasRetentionDeadline = snapshot.expiresAt !== undefined
  return [{
    ConditionCheck: {
      TableName: auditTableName,
      Key: {
        directoryId: input.workspaceId,
        eventId: snapshot.sourceId,
      },
      ConditionExpression: hasRetentionDeadline
        ? 'attribute_exists(directoryId) AND attribute_exists(eventId) AND #expiresAt = :capturedExpiresAt AND #expiresAt > :nowEpoch'
        : 'attribute_exists(directoryId) AND attribute_exists(eventId)',
      ...(hasRetentionDeadline
        ? {
            ExpressionAttributeNames: { '#expiresAt': 'expiresAt' },
            ExpressionAttributeValues: {
              ':capturedExpiresAt': snapshot.expiresAt,
              ':nowEpoch': Math.floor(Date.now() / 1_000),
            },
          }
        : {}),
    },
  }]
}

function watcherParentIssueConditions(tableName: string, input: UpdateWatcherInput) {
  const parentConditions = input.issueId === undefined
    ? []
    : [parentIssueCondition(tableName, {
        workspaceId: requireText(input.workspaceId, 'Workspace ID'),
        teamId: requireText(input.teamId ?? '', 'Team ID'),
        issueId: requireText(input.issueId, 'Issue ID'),
        entityKey: requireText(input.entityKey, 'Collaboration entity key'),
        projectId: input.projectId,
        projectEntityKey: input.projectEntityKey,
      })]
  return [...(input.authorizationConditionChecks ?? []), ...parentConditions]
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

/**
 * Builds a non-deleted comment condition fenced to captured source evidence.
 *
 * @param tableName - Collaboration table name.
 * @param entityKey - Collaboration entity key.
 * @param comment - Comment snapshot captured before the transaction.
 * @returns DynamoDB transaction condition.
 */
function commentVersionCondition(
  tableName: string,
  entityKey: string,
  comment: StoredComment,
) {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { entityKey, recordKey: commentRecordKey(comment.id) },
      ConditionExpression: 'attribute_exists(entityKey) AND attribute_exists(recordKey) AND attribute_not_exists(deletedAt) AND #version = :capturedVersion',
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: { ':capturedVersion': comment.version },
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
  mutationIdentity?: string,
) {
  return {
    Update: {
      TableName: tableName,
      Key: { entityKey, recordKey: watcherRecordKey(memberKey) },
      UpdateExpression: `SET entryType = :entryType, memberKey = :memberKey, #state = if_not_exists(#state, :subscribed), explicit = if_not_exists(explicit, :false), createdAt = if_not_exists(createdAt, :createdAt), updatedAt = :updatedAt${mutationIdentity === undefined ? ' REMOVE mutationIdentity' : ', mutationIdentity = :mutationIdentity'} ADD reasons :reasons`,
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':entryType': 'watcher',
        ':memberKey': memberKey,
        ':subscribed': 'subscribed',
        ':false': false,
        ':createdAt': occurredAt,
        ':updatedAt': occurredAt,
        ':reasons': new Set(Array.isArray(reasons) ? reasons : [reasons]),
        ...(mutationIdentity === undefined ? {} : { ':mutationIdentity': mutationIdentity }),
      },
    },
  }
}

/**
 * Builds deduplicated automatic watcher updates for a collaboration mutation.
 *
 * @param actorMemberKey - Member key of the mutation actor.
 * @param mentionMemberKeys - Member keys mentioned by the mutation.
 * @param parent - Parent comment, when the mutation is a reply.
 * @param supplied - Additional watcher candidates supplied by the caller.
 * @param actorIsService - Whether the actor is a non-member service identity.
 * @returns Deduplicated watcher members with their accumulated reasons.
 */
function buildAutomaticWatcherCandidates(
  actorMemberKey: string,
  mentionMemberKeys: string[],
  parent: StoredComment | undefined,
  supplied: CollaborationAutomaticWatcherCandidate[] | undefined,
  actorIsService: boolean,
) {
  const grouped = new Map<string, Set<CollaborationWatcherReason>>()
  const serviceActorMemberKey = actorIsService ? normalizeMemberKey(actorMemberKey) : undefined
  const add = (memberKey: string, reason: CollaborationWatcherReason) => {
    const normalizedMemberKey = normalizeMemberKey(memberKey)
    if (normalizedMemberKey === serviceActorMemberKey) {
      return
    }
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
  expectedSubscribed?: boolean,
  mutationIdentity?: string,
) {
  return {
    Update: {
      TableName: tableName,
      Key: { entityKey, recordKey: watcherRecordKey(memberKey) },
      UpdateExpression: `SET entryType = :entryType, memberKey = :memberKey, #state = :state, explicit = :true, createdAt = if_not_exists(createdAt, :createdAt), updatedAt = :updatedAt${mutationIdentity === undefined ? ' REMOVE mutationIdentity' : ', mutationIdentity = :mutationIdentity'} ADD reasons :reasons`,
      ...(expectedSubscribed === undefined
        ? {}
        : {
            ConditionExpression: expectedSubscribed
              ? '#state = :expectedState'
              : 'attribute_not_exists(entityKey) OR #state = :expectedState',
          }),
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: {
        ':entryType': 'watcher',
        ':memberKey': memberKey,
        ':state': state,
        ':true': true,
        ':createdAt': occurredAt,
        ':updatedAt': occurredAt,
        ':reasons': new Set(['manual']),
        ...(mutationIdentity === undefined ? {} : { ':mutationIdentity': mutationIdentity }),
        ...(expectedSubscribed === undefined
          ? {}
          : { ':expectedState': expectedSubscribed ? 'subscribed' : 'unsubscribed' }),
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

/**
 * Normalizes a comment body for a user-facing Collaboration mutation.
 *
 * @param value - Untrusted comment body.
 * @param maxLength - Maximum normalized body length, or null for migration input.
 * @returns A trimmed, newline-normalized comment body.
 */
function normalizeCommentBody(value: string, maxLength: number | null = COLLABORATION_COMMENT_MAX_LENGTH) {
  if (typeof value !== 'string') {
    throw new CollaborationError(400, 'InvalidCommentBody', 'Comment body must be text.')
  }

  const normalized = value.replace(/\r\n?/g, '\n').trim()
  if (!normalized) {
    throw new CollaborationError(400, 'InvalidCommentBody', 'Comment body is required.')
  }

  if (maxLength !== null && normalized.length > maxLength) {
    throw new CollaborationError(400, 'InvalidCommentBody', 'Comment body is too long.')
  }

  if (hasUnsafeControlCharacter(normalized)) {
    throw new CollaborationError(400, 'InvalidCommentBody', 'Comment body contains control characters.')
  }

  return normalized
}

/**
 * Normalizes a historical comment body without applying the current composer limit.
 *
 * @param value - Legacy comment body copied during migration.
 * @returns A trimmed, newline-normalized body that preserves historically accepted length.
 */
function normalizeBackfillCommentBody(value: string) {
  return normalizeCommentBody(value, null)
}

/**
 * Detects control characters that are unsafe for persisted collaboration text.
 *
 * @param value - Text to inspect.
 * @param allowCarriageReturn - Whether carriage returns are preserved as source evidence.
 * @returns Whether the text contains an unsafe control character.
 */
function hasUnsafeControlCharacter(value: string, allowCarriageReturn = false) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint === 127 || (
      codePoint < 32 &&
      codePoint !== 9 &&
      codePoint !== 10 &&
      !(allowCarriageReturn && codePoint === 13)
    )
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
    !isPositiveSafeInteger(value.version) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    throw new CollaborationError(503, 'InvalidCollaborationRecord', 'Comment record is invalid.')
  }

  const legacyAcceptedResolutions = normalizeAcceptedResolutions(
    value.acceptedResolutions,
    value.rootCommentId,
  )
  const storedCurrentResolution = value.acceptedResolution === undefined
    ? undefined
    : normalizeAcceptedResolutions([value.acceptedResolution], value.rootCommentId)[0]
  if (storedCurrentResolution?.state === 'superseded') {
    throw new CollaborationError(
      503,
      'InvalidCollaborationRecord',
      'Accepted resolution current snapshot is invalid.',
    )
  }
  const acceptedResolutionId = value.acceptedResolutionId === undefined
    ? undefined
    : requireIdentifierValue(value.acceptedResolutionId, 'Accepted resolution ID')
  if (acceptedResolutionId !== undefined && !storedCurrentResolution) {
    throw new CollaborationError(
      503,
      'InvalidCollaborationRecord',
      'Accepted resolution pointer requires a current snapshot.',
    )
  }
  if (storedCurrentResolution && acceptedResolutionId === undefined) {
    throw new CollaborationError(
      503,
      'InvalidCollaborationRecord',
      'Accepted resolution current snapshot requires a root pointer.',
    )
  }
  const legacyCurrentResolution = legacyAcceptedResolutions.find(
    (resolution) => resolution.state === 'accepted',
  )
  const currentResolution = storedCurrentResolution ?? legacyCurrentResolution
  const normalizedAcceptedResolutionId = acceptedResolutionId ?? currentResolution?.id
  if (storedCurrentResolution && acceptedResolutionId !== storedCurrentResolution.id) {
    throw new CollaborationError(
      503,
      'InvalidCollaborationRecord',
      'Accepted resolution current snapshot does not match the root pointer.',
    )
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
    version: value.version,
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
    ...(normalizedAcceptedResolutionId
      ? { acceptedResolutionId: normalizedAcceptedResolutionId }
      : {}),
    reactions: [],
    acceptedResolutions: currentResolution ? [currentResolution] : [],
    legacyAcceptedResolutions,
  } satisfies StoredComment
}

function toStoredWatcher(value: Record<string, unknown>): StoredWatcher {
  if (
    value.entryType !== 'watcher' ||
    typeof value.entityKey !== 'string' ||
    typeof value.recordKey !== 'string' ||
    typeof value.memberKey !== 'string' ||
    (value.state !== 'subscribed' && value.state !== 'unsubscribed') ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    throw new CollaborationError(503, 'InvalidCollaborationRecord', 'Watcher record is invalid.')
  }
  const mutationIdentity = requireStoredWatcherMutationIdentity(value.mutationIdentity)

  return {
    entityKey: value.entityKey,
    recordKey: value.recordKey,
    entryType: 'watcher',
    memberKey: normalizeMemberKey(value.memberKey),
    state: value.state,
    explicit: value.explicit === true,
    reasons: value.reasons instanceof Set || Array.isArray(value.reasons) ? value.reasons : [],
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    updatedAt: value.updatedAt,
    ...(mutationIdentity === undefined ? {} : { mutationIdentity }),
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

/**
 * Validates a caller-supplied comment identifier for a trusted service mutation.
 *
 * @param commentId - Candidate deterministic comment identifier.
 * @param context - Audit context proving that the caller is a service actor.
 * @returns A validated comment identifier.
 */
function createTrustedCommentId(
  commentId: string,
  context: MutationAuditContext | undefined,
) {
  if (context?.actor.kind !== 'service') {
    throw new CollaborationError(
      400,
      'InvalidCommentIdentifier',
      'Explicit comment identifiers require a service audit context.',
    )
  }
  return requireIdentifier(commentId, 'Comment ID')
}

function isSameCreatedComment(existing: StoredComment, expected: StoredComment) {
  return existing.authorMemberKey === expected.authorMemberKey &&
    existing.bodyMarkdown === expected.bodyMarkdown &&
    existing.parentCommentId === expected.parentCommentId &&
    existing.rootCommentId === expected.rootCommentId &&
    existing.mentionMemberKeys.length === expected.mentionMemberKeys.length &&
    existing.mentionMemberKeys.every((memberKey, index) => memberKey === expected.mentionMemberKeys[index])
}

/**
 * Tests whether a canonical comment is the exact result expected from a legacy row.
 *
 * @param existing - Current canonical comment.
 * @param expected - Comment reconstructed from the legacy event.
 * @returns Whether the existing row can be treated as an idempotent replay.
 */
function isSameBackfilledComment(existing: StoredComment, expected: StoredComment) {
  return existing.id === expected.id &&
    existing.rootCommentId === expected.rootCommentId &&
    existing.authorMemberKey === expected.authorMemberKey &&
    existing.bodyMarkdown === expected.bodyMarkdown &&
    existing.version === expected.version &&
    existing.parentCommentId === expected.parentCommentId &&
    existing.createdAt === expected.createdAt &&
    existing.updatedAt === expected.updatedAt
}

/**
 * Validates an existing discussion projection after an idempotent repair conflict.
 *
 * @param value - Untrusted persisted discussion row.
 * @param entityKey - Expected collaboration partition key.
 * @param recordKey - Expected discussion record key.
 * @param commentId - Expected canonical comment identifier.
 * @param occurredAt - Expected comment creation timestamp.
 * @param discussionIndexVersion - Expected compatibility-index version, when applicable.
 * @returns Whether the persisted row is the exact repair target.
 */
function isSameBackfilledDiscussion(
  value: unknown,
  entityKey: string,
  recordKey: string,
  commentId: string,
  occurredAt: string,
  discussionIndexVersion?: number,
) {
  return isRecord(value) &&
    value.entityKey === entityKey &&
    value.recordKey === recordKey &&
    value.entryType === 'discussion' &&
    value.commentId === commentId &&
    value.rootCommentId === commentId &&
    value.createdAt === occurredAt &&
    (discussionIndexVersion === undefined
      ? value.discussionIndexVersion === undefined
      : value.discussionIndexVersion === discussionIndexVersion)
}

/**
 * Tests whether a bounded root response matches an accepted-resolution retry.
 *
 * @param response - Current or receipt-backed root response.
 * @param sourceCommentId - Requested source reply identifier.
 * @param summary - Normalized manual summary.
 * @param actorId - Mutation actor identifier.
 * @returns Whether the successful response belongs to the same logical mutation.
 */
function isSameAcceptedResolutionReplay(
  response: CollaborationComment,
  sourceCommentId: string,
  summary: string,
  actorId: string,
) {
  const resolution = response.acceptedResolutions[0]
  return resolution?.state === 'accepted' &&
    resolution.sourceCommentId === sourceCommentId &&
    resolution.summary === summary &&
    normalizeMemberKey(resolution.acceptedBy.id) === normalizeMemberKey(actorId)
}

function workItemEntityId(teamId: string, issueId: string) {
  return `team/${requireText(teamId, 'Team ID')}/issue/${requireText(issueId, 'Issue ID')}`
}

function commentRecordKey(commentId: string) {
  return `COMMENT#${requireIdentifier(commentId, 'Comment ID')}`
}

/**
 * Creates one deterministic discussion projection row for a legacy comment.
 *
 * @param entityKey - Collaboration partition key.
 * @param recordKey - Physical discussion index key.
 * @param commentId - Canonical comment identifier.
 * @param occurredAt - Canonical comment creation timestamp.
 * @param discussionIndexVersion - Compatibility-index version, when applicable.
 * @returns A discussion row suitable for a guarded DynamoDB transaction.
 */
function createBackfillDiscussionRecord(
  entityKey: string,
  recordKey: string,
  commentId: string,
  occurredAt: string,
  discussionIndexVersion?: number,
) {
  return {
    entityKey,
    recordKey,
    entryType: 'discussion',
    commentId,
    rootCommentId: commentId,
    createdAt: occurredAt,
    ...(discussionIndexVersion === undefined ? {} : { discussionIndexVersion }),
  }
}

/**
 * Creates the chronological discussion index key used for aggregate reads.
 *
 * @param occurredAt - Canonical comment creation timestamp.
 * @param commentId - Comment identifier.
 * @param rootCommentId - Root identifier for a reply, or undefined for a root.
 * @returns Chronologically sortable discussion record key.
 */
function discussionTimelineRecordKey(
  occurredAt: string,
  commentId: string,
  rootCommentId: string | undefined,
) {
  const kind = rootCommentId ? `THREAD#${requireIdentifier(rootCommentId, 'Root comment ID')}` : 'ROOT'
  return `${discussionTimelinePrefix}${occurredAt}#${kind}#${requireIdentifier(commentId, 'Comment ID')}`
}

/**
 * Creates the scoped discussion index key used for root and reply reads.
 *
 * @param occurredAt - Canonical comment creation timestamp.
 * @param commentId - Comment identifier.
 * @param rootCommentId - Root identifier for a reply, or undefined for a root.
 * @returns Chronologically sortable scoped discussion record key.
 */
function discussionScopedRecordKey(
  occurredAt: string,
  commentId: string,
  rootCommentId: string | undefined,
) {
  const scope = rootCommentId
    ? `THREAD#${requireIdentifier(rootCommentId, 'Root comment ID')}#`
    : 'ROOT#'
  return `${discussionScopedPrefix}${scope}${occurredAt}#${requireIdentifier(commentId, 'Comment ID')}`
}

/**
 * Creates the pre-migration discussion index key retained for rollback compatibility.
 *
 * @param occurredAt - Canonical comment creation timestamp.
 * @param commentId - Comment identifier.
 * @param rootCommentId - Root identifier for a reply, or undefined for a root.
 * @returns Legacy discussion record key understood by the previous reader.
 */
function discussionLegacyRecordKey(
  occurredAt: string,
  commentId: string,
  rootCommentId: string | undefined,
) {
  const scope = rootCommentId
    ? `THREAD#${requireIdentifier(rootCommentId, 'Root comment ID')}#`
    : 'ROOT#'
  return `DISCUSSION#${scope}${occurredAt}#${requireIdentifier(commentId, 'Comment ID')}`
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

/** Normalizes one optional bounded mutation identity supplied by the application layer. */
function normalizeWatcherMutationIdentity(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new CollaborationError(
      400,
      'InvalidWatcherMutationIdentity',
      'Watcher mutation identity must be a non-empty string.',
    )
  }
  const normalized = value.trim()
  if (
    normalized.length === 0 ||
    normalized.length > watcherMutationIdentityMaximumLength
  ) {
    throw new CollaborationError(
      400,
      'InvalidWatcherMutationIdentity',
      `Watcher mutation identity must be ${watcherMutationIdentityMaximumLength} characters or fewer.`,
    )
  }
  return normalized
}

/** Reads one optional canonical mutation identity from an untrusted watcher row. */
function requireStoredWatcherMutationIdentity(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > watcherMutationIdentityMaximumLength
  ) {
    throw new CollaborationError(
      503,
      'InvalidCollaborationRecord',
      'Watcher record mutation identity is invalid.',
    )
  }
  return value
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

/**
 * Clamps curated context pages below the generic collaboration limit.
 *
 * Each item can contain multiple bounded Markdown/evidence fields, so ten items
 * keeps the serialized API response below the service payload ceiling even for
 * worst-case UTF-8 and JSON escaping.
 *
 * @param value - Requested page size.
 * @returns Validated page size capped at ten items.
 */
function clampCuratedContextLimit(value: number | undefined) {
  if (value === undefined) {
    return curatedContextPageLimit
  }
  if (!Number.isFinite(value)) {
    throw new CollaborationError(400, 'InvalidCollaborationCursor', 'Page limit is invalid.')
  }
  return Math.max(1, Math.min(curatedContextPageLimit, Math.floor(value)))
}

/**
 * Clamps accepted resolution history pages to a hard payload-safe maximum.
 *
 * @param value - Requested page size.
 * @returns Validated accepted resolution page size.
 */
function clampAcceptedResolutionHistoryLimit(value: number | undefined) {
  if (value === undefined) {
    return acceptedResolutionHistoryDefaultLimit
  }
  if (!Number.isFinite(value)) {
    throw new CollaborationError(400, 'InvalidCollaborationCursor', 'Page limit is invalid.')
  }
  return Math.max(1, Math.min(acceptedResolutionHistoryMaxLimit, Math.floor(value)))
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

/** Encodes a migration-aware discussion cursor. */
function encodeDiscussionCursor(cursor: DiscussionCursor) {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/** Encodes a pre-migration discussion cursor for compatibility callers. */
function encodeLegacyDiscussionCursor(cursor: LegacyDiscussionCursor) {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/** Encodes a version-one cursor used by other single-prefix Collaboration readers. */
function encodeCursor(cursor: PrefixCursor) {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

/** Decodes a version-one cursor used by other single-prefix Collaboration readers. */
function decodeCursor(value: string | undefined, entityKey: string, prefix: string) {
  if (!value) {
    return undefined
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!isRecord(parsed) ||
        parsed.version !== 1 ||
        parsed.entityKey !== entityKey ||
        parsed.prefix !== prefix ||
        typeof parsed.recordKey !== 'string' ||
        !parsed.recordKey.startsWith(prefix)) {
      throw new Error('cursor mismatch')
    }
    return { entityKey, recordKey: parsed.recordKey }
  } catch (error) {
    throw new CollaborationError(400, 'InvalidCollaborationCursor', 'Collaboration cursor is invalid.', { cause: error })
  }
}

/** Reads a DynamoDB last-evaluated discussion sort key without trusting its shape. */
function readDiscussionLastRecordKey(value: unknown) {
  if (!isRecord(value) || typeof value.recordKey !== 'string') {
    return undefined
  }
  return value.recordKey
}

/** Validates that a discussion cursor key belongs to the requested physical range. */
function isDiscussionCursorRecordKey(
  recordKey: string,
  phase: DiscussionCursor['phase'],
  plan: DiscussionReadPlan,
) {
  const prefix = phase === 'current' ? plan.currentPrefix : plan.legacyPrefix
  return recordKey.startsWith(prefix) &&
    (phase !== 'legacy' || plan.legacyUpperBound === undefined || recordKey < plan.legacyUpperBound)
}

/**
 * Decodes a discussion cursor and accepts both the current and pre-migration shapes.
 *
 * @param value - Opaque cursor supplied by the caller.
 * @param entityKey - Expected collaboration entity key.
 * @param plan - Prefix plan for the requested scope.
 * @returns Validated cursor, or undefined for the first page.
 */
function decodeDiscussionCursor(
  value: string | undefined,
  entityKey: string,
  plan: DiscussionReadPlan,
): DecodedDiscussionCursor | undefined {
  if (!value) {
    return undefined
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!isRecord(parsed) || parsed.entityKey !== entityKey) {
      throw new Error('cursor mismatch')
    }

    if (parsed.version === 1) {
      if (
        parsed.prefix !== plan.legacyPrefix ||
        typeof parsed.recordKey !== 'string' ||
        !isDiscussionCursorRecordKey(parsed.recordKey, 'legacy', plan)
      ) {
        throw new Error('legacy cursor mismatch')
      }
      return { kind: 'legacy', recordKey: parsed.recordKey }
    }

    if (
      parsed.version !== 2 ||
      parsed.currentPrefix !== plan.currentPrefix ||
      parsed.legacyPrefix !== plan.legacyPrefix ||
      (parsed.phase !== 'current' && parsed.phase !== 'legacy')
    ) {
      throw new Error('cursor mismatch')
    }
    if (parsed.recordKey !== undefined) {
      if (
        typeof parsed.recordKey !== 'string' ||
        !isDiscussionCursorRecordKey(parsed.recordKey, parsed.phase, plan)
      ) {
        throw new Error('record key mismatch')
      }
    }
    return {
      kind: 'current',
      phase: parsed.phase,
      ...(typeof parsed.recordKey === 'string' ? { recordKey: parsed.recordKey } : {}),
    }
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

/** Returns whether a transaction failed only because of conditional guards. */
function isBackfillConditionalFailure(error: unknown) {
  if (isAwsNamedError(error, 'ConditionalCheckFailedException')) {
    return true
  }
  if (!isAwsNamedError(error, 'TransactionCanceledException') || !isRecord(error)) {
    return false
  }
  const reasons = error.CancellationReasons
  if (!Array.isArray(reasons) || reasons.length === 0) {
    return false
  }
  const codes = reasons.map((reason) => isRecord(reason) ? reason.Code : undefined)
  return codes.includes('ConditionalCheckFailed') &&
    codes.every((code) => code === 'None' || code === 'ConditionalCheckFailed')
}

/** Returns whether a transaction cancellation failed at one known item index. */
function isTransactionConditionalFailureAt(error: unknown, index: number) {
  if (!isAwsNamedError(error, 'TransactionCanceledException') || !isRecord(error)) {
    return false
  }
  const reasons = error.CancellationReasons
  if (!Array.isArray(reasons)) return false
  const reason = reasons[index]
  return isRecord(reason) && reason.Code === 'ConditionalCheckFailed'
}

/**
 * Checks whether one DynamoDB transaction failed in the caller-authorization slice.
 *
 * Direct conditional failures have no per-item reason and therefore remain on the
 * idempotent replay path; only an indexed authorization condition is authoritative here.
 *
 * @param error - DynamoDB transaction error.
 * @param startIndex - First authorization condition index in the transaction.
 * @param count - Number of authorization conditions.
 * @returns Whether an authorization condition failed.
 */
function isAuthorizationConditionFailure(
  error: unknown,
  startIndex: number,
  count: number,
): boolean {
  if (
    count === 0 ||
    typeof error !== 'object' ||
    error === null ||
    !('name' in error) ||
    error.name !== 'TransactionCanceledException' ||
    !('CancellationReasons' in error) ||
    !Array.isArray(error.CancellationReasons)
  ) {
    return false
  }
  const reasons = error.CancellationReasons
  if (reasons.length < startIndex + count) return false
  const authorizationReasons = reasons.slice(startIndex, startIndex + count)
  return authorizationReasons.some((reason) =>
    typeof reason === 'object' && reason !== null &&
    'Code' in reason && reason.Code === 'ConditionalCheckFailed'
  )
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
