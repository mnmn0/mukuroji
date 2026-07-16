import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  type TableDescription,
} from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import { PLANNING_SCHEMA_VERSION } from '@mukuroji/contracts'
import {
  createAuditFieldChanges,
  createMutationAuditEventPut,
  createWorkspaceInvitationAuditEntityId,
  createWorkspaceMemberAuditEntityId,
  ensureLocalAuditEventsTable,
  getConfiguredAuditTableName,
  type MutationAuditContext,
  type MutationAuditEventInput,
} from './audit'

const INVITATION_ACCEPTANCE_LOCK_MS = 5 * 60_000
const INVITATION_PROVISIONING_LEASE_MS = 5 * 60_000
const WORKSPACE_IDENTITY_LIFECYCLE_VERSION = 2
const MANUAL_COGNITO_CLEANUP_MESSAGE =
  'Manual Cognito cleanup is required. After removing the user or Workspace claims in Cognito, retry revocation to verify completion.'
const WORKSPACE_INVITATION_AUDIT_FIELDS = [
  'email',
  'name',
  'role',
  'status',
  'deliveryStatus',
  'identityOwnership',
  'directoryClaimCleanupRequired',
  'identityCleanupCompleted',
  'identityCleanupManualRequired',
  'identityMutationAttempted',
  'acceptanceLockExpiresAt',
  'expiresAt',
  'lastSentAt',
  'acceptedAt',
  'failureMessage',
] as const
const WORKSPACE_MEMBER_AUDIT_FIELDS = [
  'email',
  'name',
  'role',
  'status',
  'deactivatedAt',
] as const
const WORKSPACE_AUDIT_REDACT_FIELDS = ['email', 'name', 'failureMessage'] as const

/** Workspace 全体で付与する member role です。 */
export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'guest'

/** Workspace member の利用状態です。 */
export type WorkspaceMemberStatus = 'active' | 'deactivated'

/** Workspace invitation の lifecycle 状態です。 */
export type WorkspaceInvitationStatus =
  | 'provisioning'
  | 'pending'
  | 'delivery-failed'
  | 'expired'
  | 'revoked'
  | 'accepted'

/** Workspace invitation のメール配信状態です。 */
export type WorkspaceInvitationDeliveryStatus = 'pending' | 'sent' | 'failed' | 'not-required'

/** 招待対象の Cognito identity を誰が作成したかを表します。 */
export type WorkspaceIdentityOwnership = 'workspace-created' | 'pre-existing' | 'ambiguous'

/** Workspace access API が返す member です。 */
export type WorkspaceMember = {
  /** membership の一意な ID です。 */
  id: string
  /** member mutation に使用する安定した key です。 */
  memberKey: string
  /** member のメールアドレスです。 */
  email: string
  /** member の任意の表示名です。 */
  name?: string
  /** Workspace 全体での role です。 */
  role: WorkspaceRole
  /** Workspace へのアクセス状態です。 */
  status: WorkspaceMemberStatus
  /** 同時更新検知に使用する version です。 */
  version: number
  /** membership 作成日時の ISO 8601 timestamp です。 */
  createdAt: string
  /** membership 最終更新日時の ISO 8601 timestamp です。 */
  updatedAt: string
  /** 利用停止日時の ISO 8601 timestamp です。 */
  deactivatedAt?: string
}

/** Workspace access API が返す invitation です。 */
export type WorkspaceInvitation = {
  /** invitation の一意な ID です。 */
  id: string
  /** 招待先メールアドレスです。 */
  email: string
  /** 招待対象の任意の表示名です。 */
  name?: string
  /** 招待受諾後に付与する role です。 */
  role: WorkspaceRole
  /** invitation lifecycle の現在状態です。 */
  status: WorkspaceInvitationStatus
  /** 招待メールの配信状態です。 */
  deliveryStatus: WorkspaceInvitationDeliveryStatus
  /** Cognito identity の provisioning ownership です。 */
  identityOwnership: WorkspaceIdentityOwnership
  /** Cognito identity cleanup provenance schema の version です。 */
  identityLifecycleVersion?: number
  /** cleanup 対象を同じ Cognito identity に限定する安定 ID です。 */
  cognitoIdentityId?: string
  /** cleanup API に渡す大文字小文字を保持した Cognito username です。 */
  cognitoUsername?: string
  /** この invitation が Cognito の Workspace directory claim を追加したかどうかです。 */
  directoryClaimCleanupRequired?: boolean
  /** revoke に伴う Cognito cleanup が完了したかどうかです。 */
  identityCleanupCompleted?: boolean
  /** stable identity 情報がない旧 invitation で手動 Cognito cleanup が必要かどうかです。 */
  identityCleanupManualRequired?: boolean
  /** stable pair を得る前に Cognito identity mutation を開始したかどうかです。 */
  identityMutationAttempted?: boolean
  /** password challenge と revoke を直列化する acceptance lock の期限です。 */
  acceptanceLockExpiresAt?: string
  /** invitation の同時更新検知に使用する version です。 */
  version: number
  /** invitation の有効期限を表す ISO 8601 timestamp です。 */
  expiresAt: string
  /** invitation 作成日時の ISO 8601 timestamp です。 */
  createdAt: string
  /** invitation 最終更新日時の ISO 8601 timestamp です。 */
  updatedAt: string
  /** 招待メール最終送信日時の ISO 8601 timestamp です。 */
  lastSentAt?: string
  /** Invitation を membership へ収束させた日時です。 */
  acceptedAt?: string
  /** 配信または provisioning 失敗時の安全な表示メッセージです。 */
  failureMessage?: string
}

/** ログイン中 member が実行できる Workspace 管理操作です。 */
export type WorkspaceAccessCapabilities = {
  /** invitation を作成できるかどうかです。 */
  canInvite: boolean
  /** member / guest を管理できるかどうかです。 */
  canManageMembers: boolean
  /** admin を含む member を管理できるかどうかです。 */
  canManageAdmins: boolean
}

/** Workspace access 画面用の snapshot response です。 */
export type WorkspaceAccessResponse = {
  /** ログイン中ユーザーの active membership です。 */
  currentMember: WorkspaceMember
  /** Workspace の member 一覧です。 */
  members: WorkspaceMember[]
  /** Workspace の invitation 一覧です。 */
  invitations: WorkspaceInvitation[]
  /** ログイン中 member の操作権限です。 */
  capabilities: WorkspaceAccessCapabilities
}

/** Invitation mutation response です。 */
export type WorkspaceInvitationResponse = {
  /** 作成または更新された invitation です。 */
  invitation: WorkspaceInvitation
}

/** Member mutation response です。 */
export type WorkspaceMemberResponse = {
  /** 更新された member です。 */
  member: WorkspaceMember
}

/** Workspace invitation 作成入力です。 */
export type CreateWorkspaceInvitationInput = {
  /** 招待先メールアドレスです。 */
  email: string
  /** 招待対象の任意の表示名です。 */
  name?: string
  /** 招待受諾後に付与する role です。 */
  role: WorkspaceRole
}

/** Invitation 配信結果の記録入力です。 */
export type MarkWorkspaceInvitationDeliveryInput = {
  /** 記録する配信状態です。 */
  deliveryStatus: WorkspaceInvitationDeliveryStatus
  /** Cognito identity の ownership 判定です。 */
  identityOwnership: WorkspaceIdentityOwnership
  /** provisioning した Cognito identity の安定 ID です。 */
  cognitoIdentityId?: string
  /** provisioning した Cognito identity の大文字小文字を保持した username です。 */
  cognitoUsername?: string
  /** revoke 時にこの invitation が追加した directory claim を削除するかどうかです。 */
  directoryClaimCleanupRequired?: boolean
  /** 読み込み時点の invitation version です。 */
  expectedVersion: number
  /** 外部へ安全に表示できる失敗理由です。 */
  failureMessage?: string
}

/** Revoked invitation の Cognito cleanup 失敗を記録する入力です。 */
export type MarkWorkspaceInvitationCleanupFailureInput = {
  /** 読み込み時点の invitation version です。 */
  expectedVersion: number
  /** 管理画面に表示できる cleanup 失敗理由です。 */
  failureMessage: string
}

/** 認証済み identity と invitation を membership に収束させる入力です。 */
export type ReconcileAuthenticatedWorkspaceMemberInput = {
  /** 認証済み identity に対応する member key です。 */
  memberKey: string
  /** 認証済みかつ検証済みのメールアドレスです。 */
  email: string
  /** 認証済み identity の任意の表示名です。 */
  name?: string
}

/** Workspace member 更新入力です。 */
export type UpdateWorkspaceMemberInput = {
  /** 更新後の role です。 */
  role?: WorkspaceRole
  /** 更新後の利用状態です。 */
  status?: WorkspaceMemberStatus
  /** 読み込み時点の member version です。 */
  expectedVersion: number
  /** Planning 認可 snapshot と直列化する Workspace graph revision です。 */
  expectedPlanningRevision: number
}

/** Workspace access domain error です。 */
export class WorkspaceAccessError extends Error {
  /** API response に対応する HTTP status code です。 */
  readonly status: number
  /** 呼び出し側が分岐に使用できる安定した error code です。 */
  readonly code: string

  constructor(status: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorkspaceAccessError'
    this.status = status
    this.code = code
  }
}

/** Workspace access data store の公開契約です。 */
export interface WorkspaceAccessClient {
  /** 指定 member を取得します。 */
  getMember(workspaceId: string, memberKey: string): Promise<WorkspaceMember | undefined>
  /** 指定 member が active な場合だけ返します。 */
  getActiveMember(workspaceId: string, memberKey: string): Promise<WorkspaceMember | undefined>
  /** 管理画面用の member / invitation snapshot を取得します。 */
  getAccessSnapshot(workspaceId: string, actorMemberKey: string): Promise<WorkspaceAccessResponse>
  /** Project assignment 候補に利用できる active member を取得します。 */
  listActiveMembers(workspaceId: string): Promise<WorkspaceMember[]>
  /** 新しい invitation を provisioning 状態で作成します。 */
  createInvitation(
    workspaceId: string,
    actorMemberKey: string,
    input: CreateWorkspaceInvitationInput,
    expiresInDays?: number,
    auditContext?: MutationAuditContext,
  ): Promise<WorkspaceInvitation>
  /** 指定 invitation を取得します。 */
  getInvitation(workspaceId: string, invitationId: string): Promise<WorkspaceInvitation | undefined>
  /** password challenge 前に invitation acceptance lock を取得します。 */
  acquireInvitationAcceptanceLock(
    workspaceId: string,
    invitationId: string,
    auditContext?: MutationAuditContext,
  ): Promise<WorkspaceInvitation | undefined>
  /** password challenge 終了後に invitation acceptance lock を解除します。 */
  releaseInvitationAcceptanceLock(
    workspaceId: string,
    invitationId: string,
    expectedVersion: number,
    auditContext?: MutationAuditContext,
  ): Promise<WorkspaceInvitation>
  /** Cognito mutation の開始を stable identity pair とともに write-ahead 記録します。 */
  markInvitationIdentityMutationStarted(
    workspaceId: string,
    invitationId: string,
    expectedVersion: number,
    cognitoIdentityId?: string,
    cognitoUsername?: string,
    auditContext?: MutationAuditContext,
  ): Promise<WorkspaceInvitation>
  /** Cognito 更新前に directory claim の補償責務を version 条件付きで記録します。 */
  markInvitationDirectoryClaimCleanupRequired(
    workspaceId: string,
    invitationId: string,
    expectedVersion: number,
    cognitoIdentityId: string,
    cognitoUsername: string,
    auditContext?: MutationAuditContext,
  ): Promise<WorkspaceInvitation>
  /** Cognito provisioning と invitation 配信の結果を記録します。 */
  markInvitationDelivery(
    workspaceId: string,
    invitationId: string,
    input: MarkWorkspaceInvitationDeliveryInput,
    auditContext?: MutationAuditContext,
  ): Promise<WorkspaceInvitation>
  /** revoked invitation の Cognito cleanup 失敗を version 条件付きで記録します。 */
  markInvitationCleanupFailure(
    workspaceId: string,
    invitationId: string,
    input: MarkWorkspaceInvitationCleanupFailureInput,
    auditContext?: MutationAuditContext,
  ): Promise<WorkspaceInvitation>
  /** 自動 cleanup できない revoked invitation を手動確認待ちとして記録します。 */
  markInvitationManualCleanupRequired(
    workspaceId: string,
    invitationId: string,
    expectedVersion: number,
    auditContext?: MutationAuditContext,
  ): Promise<WorkspaceInvitation>
  /** Cognito cleanup 成功後に retry marker と directory claim の補償責務を消します。 */
  clearInvitationCleanupFailure(
    workspaceId: string,
    invitationId: string,
    expectedVersion: number,
    auditContext?: MutationAuditContext,
  ): Promise<WorkspaceInvitation>
  /** 手動 Cognito cleanup の完了を管理権限と version 付きで確認します。 */
  acknowledgeInvitationManualCleanup(
    workspaceId: string,
    actorMemberKey: string,
    invitationId: string,
    expectedVersion: number,
    auditContext?: MutationAuditContext,
  ): Promise<WorkspaceInvitation>
  /** invitation を再送処理前の provisioning 状態へ遷移させます。 */
  prepareResend(
    workspaceId: string,
    actorMemberKey: string,
    invitationId: string,
    expiresInDays?: number,
    auditContext?: MutationAuditContext,
  ): Promise<WorkspaceInvitation>
  /** invitation を取り消します。 */
  revokeInvitation(
    workspaceId: string,
    actorMemberKey: string,
    invitationId: string,
    auditContext?: MutationAuditContext,
  ): Promise<WorkspaceInvitation>
  /** expired / revoked invitation を新しい招待処理へ遷移させます。 */
  prepareReinvite(
    workspaceId: string,
    actorMemberKey: string,
    invitationId: string,
    expiresInDays?: number,
    auditContext?: MutationAuditContext,
  ): Promise<WorkspaceInvitation>
  /** 認証済み identity の invitation 受諾と active membership 作成を原子的に行います。 */
  reconcileAuthenticatedMember(
    workspaceId: string,
    input: ReconcileAuthenticatedWorkspaceMemberInput,
    auditContext?: MutationAuditContext,
  ): Promise<WorkspaceMember>
  /** actor の権限を検証し、target member を version 付きで更新します。 */
  updateMember(
    workspaceId: string,
    actorMemberKey: string,
    targetMemberKey: string,
    input: UpdateWorkspaceMemberInput,
    auditContext?: MutationAuditContext,
  ): Promise<WorkspaceMember>
}

/** `workspace-created` identity だけが補償処理で安全に削除できることを判定します。 */
export function isWorkspaceIdentitySafeToDelete(ownership: WorkspaceIdentityOwnership) {
  return ownership === 'workspace-created'
}

/** DynamoDB の Workspace access table を読み書きする client です。 */
export class DynamoDbWorkspaceAccessClient implements WorkspaceAccessClient {
  /** Workspace access item を保存する DynamoDB table 名です。 */
  private readonly tableName: string
  /** DynamoDB DocumentClient です。 */
  private readonly documentClient: DynamoDBDocumentClient
  /** 任意のローカル table bootstrap に使用する低レベル client です。 */
  private readonly dynamoDbClient: DynamoDBClient
  /** ローカル table を自動作成するかどうかです。 */
  private readonly bootstrapLocalTable: boolean
  /** timestamp を生成する clock です。 */
  private readonly clock: () => Date
  /** Member の role / status 更新と直列化する Planning table 名です。 */
  private readonly planningTableName: string
  /** immutable audit event を保存する DynamoDB table 名です。 */
  private readonly auditTableName?: string
  /** Workspace/member/invitation の公開 audit ID を導出する固定 HMAC key です。 */
  private readonly auditPseudonymKey?: string
  /** 進行中または完了済みの local table 初期化です。 */
  private localTableInitializer?: Promise<void>

  constructor(
    tableName = readEnvironment('MUKUROJI_WORKSPACE_ACCESS_TABLE') ??
      readEnvironment('WORKSPACE_ACCESS_TABLE_NAME') ??
      'mukuroji-workspace-access-local',
    documentClient?: DynamoDBDocumentClient,
    dynamoDbClient = createDynamoDbClient(),
    bootstrapLocalTable = false,
    clock: () => Date = () => new Date(),
    planningTableName = readEnvironment('PLANNING_TABLE_NAME') ?? 'mukuroji-planning-local',
    auditTableName: string | null | undefined = documentClient === undefined
      ? getConfiguredAuditTableName() ?? 'mukuroji-audit-events'
      : undefined,
    auditPseudonymKey: string | undefined = readEnvironment(
      'MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY',
    ),
  ) {
    this.tableName = tableName
    this.dynamoDbClient = dynamoDbClient
    this.documentClient = documentClient ?? DynamoDBDocumentClient.from(dynamoDbClient, {
      marshallOptions: { removeUndefinedValues: true },
    })
    this.bootstrapLocalTable = bootstrapLocalTable
    this.clock = clock
    this.planningTableName = planningTableName
    this.auditTableName = auditTableName ?? undefined
    this.auditPseudonymKey = auditPseudonymKey || undefined
  }

  /** 指定 member を consistent read で取得します。 */
  async getMember(workspaceId: string, memberKey: string) {
    await this.ensureLocalTable()
    const normalizedWorkspaceId = normalizeRequired(workspaceId, 'Workspace ID')
    const normalizedMemberKey = normalizeMemberKey(memberKey)
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId: normalizedWorkspaceId, recordKey: createMemberRecordKey(normalizedMemberKey) },
      ConsistentRead: true,
    }))

    return response.Item ? toWorkspaceMember(response.Item) : undefined
  }

  /** 指定 member が active な場合だけ返します。 */
  async getActiveMember(workspaceId: string, memberKey: string) {
    const member = await this.getMember(workspaceId, memberKey)
    return member?.status === 'active' ? member : undefined
  }

  /** 管理画面用の Workspace access snapshot を取得します。 */
  async getAccessSnapshot(workspaceId: string, actorMemberKey: string) {
    const items = await this.queryItems(workspaceId)
    const members = items
      .filter((item) => isRecord(item) && item.entryType === 'workspace-member')
      .map(toWorkspaceMember)
    const invitations = items
      .filter((item) => isRecord(item) && item.entryType === 'workspace-invitation')
      .map((item) => toWorkspaceInvitation(item, this.clock()))
    const actorKey = normalizeMemberKey(actorMemberKey)
    const currentMember = members.find((member) => member.memberKey === actorKey && member.status === 'active')

    if (!currentMember) {
      throw new WorkspaceAccessError(403, 'WorkspaceAccessDenied', 'Workspace access is denied.')
    }

    return {
      currentMember,
      members: members.sort(compareWorkspaceMembers),
      invitations: invitations.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      capabilities: capabilitiesForRole(currentMember.role),
    } satisfies WorkspaceAccessResponse
  }

  /** active member だけを取得します。 */
  async listActiveMembers(workspaceId: string) {
    const items = await this.queryItems(workspaceId, 'MEMBER#')
    return items.map(toWorkspaceMember).filter((member) => member.status === 'active').sort(compareWorkspaceMembers)
  }

  /** invitation を 7 日間有効な provisioning item として作成します。 */
  async createInvitation(
    workspaceId: string,
    actorMemberKey: string,
    input: CreateWorkspaceInvitationInput,
    expiresInDays = 7,
    auditContext?: MutationAuditContext,
  ) {
    const normalizedWorkspaceId = normalizeRequired(workspaceId, 'Workspace ID')
    const actor = await this.requireActiveActor(normalizedWorkspaceId, actorMemberKey)
    const email = normalizeEmail(input.email)
    const role = requireWorkspaceRole(input.role)
    assertCanManageRole(actor, role)

    if (email === actor.memberKey) {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceMemberAlreadyExists',
        'The invited user is already a Workspace member.',
      )
    }

    const now = this.clock()
    const nowIso = now.toISOString()
    const invitation: WorkspaceInvitation = {
      id: email,
      email,
      name: normalizeOptional(input.name),
      role,
      status: 'provisioning',
      deliveryStatus: 'pending',
      identityOwnership: 'ambiguous',
      identityLifecycleVersion: WORKSPACE_IDENTITY_LIFECYCLE_VERSION,
      version: 1,
      expiresAt: addDays(now, expiresInDays).toISOString(),
      createdAt: nowIso,
      updatedAt: nowIso,
    }

    const auditPut = this.createInvitationAuditPut(
      normalizedWorkspaceId,
      undefined,
      invitation,
      auditContext,
      'invitation.created',
      'created',
      0,
    )

    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: [
        this.actorCondition(normalizedWorkspaceId, actor),
        {
          ConditionCheck: {
            TableName: this.tableName,
            Key: { workspaceId: normalizedWorkspaceId, recordKey: createMemberRecordKey(email) },
            ConditionExpression: 'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
          },
        },
        {
          Put: {
            TableName: this.tableName,
            Item: toInvitationItem(normalizedWorkspaceId, invitation),
            ConditionExpression: 'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
          },
        },
        ...(auditPut ? [auditPut] : []),
      ] }))
    } catch (error) {
      if (
        isConditionalTransactionCancellation(error) &&
        [0, 1, 2].some((index) => isTransactionConditionalFailureAt(error, index))
      ) {
        await this.classifyCreateInvitationConflict(normalizedWorkspaceId, actor.memberKey, invitation)
      }
      throw toWorkspaceAccessError(error)
    }

    return invitation
  }

  /** 指定 invitation を consistent read で取得します。 */
  async getInvitation(workspaceId: string, invitationId: string) {
    await this.ensureLocalTable()
    const normalizedWorkspaceId = normalizeRequired(workspaceId, 'Workspace ID')
    const email = normalizeEmail(invitationId)
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId: normalizedWorkspaceId, recordKey: createInvitationRecordKey(email) },
      ConsistentRead: true,
    }))

    return response.Item ? toWorkspaceInvitation(response.Item, this.clock()) : undefined
  }

  /** password challenge 前に invitation acceptance lock を取得します。 */
  async acquireInvitationAcceptanceLock(
    workspaceId: string,
    invitationId: string,
    auditContext?: MutationAuditContext,
  ) {
    const invitation = await this.getInvitation(workspaceId, invitationId)

    if (!invitation) {
      return undefined
    }

    if (!isInvitationAcceptable(invitation)) {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceInvitationNotAcceptable',
        'The Workspace invitation cannot be accepted in its current state.',
      )
    }

    const now = this.clock()

    if (hasActiveInvitationAcceptanceLock(invitation, now)) {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceInvitationAcceptanceInProgress',
        'Workspace invitation acceptance is already in progress.',
      )
    }

    return this.updateInvitation(
      workspaceId,
      invitation,
      invitation.version,
      {
        acceptanceLockExpiresAt: new Date(
          now.getTime() + INVITATION_ACCEPTANCE_LOCK_MS,
        ).toISOString(),
      },
      ['pending', 'provisioning', 'delivery-failed'],
      auditContext,
      'invitation.acceptance-lock-acquired',
      'acceptance-lock-acquired',
      0,
    )
  }

  /** password challenge 終了後に invitation acceptance lock を解除します。 */
  async releaseInvitationAcceptanceLock(
    workspaceId: string,
    invitationId: string,
    expectedVersion: number,
    auditContext?: MutationAuditContext,
  ) {
    const invitation = await this.requireInvitation(workspaceId, invitationId)

    if (invitation.status === 'accepted') {
      return invitation
    }

    return this.updateInvitation(
      workspaceId,
      invitation,
      expectedVersion,
      { acceptanceLockExpiresAt: undefined },
      ['pending', 'provisioning', 'delivery-failed'],
      auditContext,
      'invitation.acceptance-lock-released',
      'acceptance-lock-released',
      3,
    )
  }

  /** Cognito mutation の開始を stable identity pair とともに write-ahead 記録します。 */
  async markInvitationIdentityMutationStarted(
    workspaceId: string,
    invitationId: string,
    expectedVersion: number,
    cognitoIdentityId?: string,
    cognitoUsername?: string,
    auditContext?: MutationAuditContext,
  ) {
    const invitation = await this.requireInvitation(workspaceId, invitationId)
    const normalizedCognitoIdentityId = cognitoIdentityId?.trim() || undefined
    const normalizedCognitoUsername = cognitoUsername?.trim() || undefined

    if (Boolean(normalizedCognitoIdentityId) !== Boolean(normalizedCognitoUsername)) {
      throw new WorkspaceAccessError(
        503,
        'WorkspaceIdentityUnavailable',
        'Cognito identity metadata is unavailable.',
      )
    }

    const preservesInvitationIdentity = normalizedCognitoIdentityId !== undefined &&
      normalizedCognitoIdentityId === invitation.cognitoIdentityId

    return this.updateInvitation(
      workspaceId,
      invitation,
      expectedVersion,
      {
        identityOwnership: preservesInvitationIdentity
          ? invitation.identityOwnership
          : 'ambiguous',
        cognitoIdentityId: normalizedCognitoIdentityId,
        cognitoUsername: normalizedCognitoUsername,
        directoryClaimCleanupRequired: preservesInvitationIdentity
          ? invitation.directoryClaimCleanupRequired
          : undefined,
        identityMutationAttempted: true,
      },
      ['provisioning'],
      auditContext,
      'invitation.identity-mutation-started',
      'identity-mutation-started',
      1,
    )
  }

  /** Cognito 更新前に directory claim の補償責務を version 条件付きで記録します。 */
  async markInvitationDirectoryClaimCleanupRequired(
    workspaceId: string,
    invitationId: string,
    expectedVersion: number,
    cognitoIdentityId: string,
    cognitoUsername: string,
    auditContext?: MutationAuditContext,
  ) {
    const invitation = await this.requireInvitation(workspaceId, invitationId)
    const normalizedCognitoIdentityId = normalizeRequired(
      cognitoIdentityId,
      'Cognito identity ID',
    )
    const normalizedCognitoUsername = normalizeRequired(cognitoUsername, 'Cognito username')

    if (invitation.status !== 'provisioning' || invitation.version !== expectedVersion) {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceVersionConflict',
        'Workspace invitation changed. Reload and try again.',
      )
    }

    if (
      invitation.directoryClaimCleanupRequired &&
      invitation.cognitoIdentityId === normalizedCognitoIdentityId &&
      invitation.cognitoUsername === normalizedCognitoUsername
    ) {
      return invitation
    }

    return this.updateInvitation(
      workspaceId,
      invitation,
      expectedVersion,
      {
        cognitoIdentityId: normalizedCognitoIdentityId,
        cognitoUsername: normalizedCognitoUsername,
        directoryClaimCleanupRequired: true,
        identityOwnership: invitation.cognitoIdentityId === normalizedCognitoIdentityId
          ? invitation.identityOwnership
          : 'ambiguous',
      },
      ['provisioning'],
      auditContext,
      'invitation.directory-claim-cleanup-required',
      'directory-claim-cleanup-required',
      2,
    )
  }

  /** Cognito provisioning と invitation 配信の結果を記録します。 */
  async markInvitationDelivery(
    workspaceId: string,
    invitationId: string,
    input: MarkWorkspaceInvitationDeliveryInput,
    auditContext?: MutationAuditContext,
  ) {
    const invitation = await this.requireInvitation(workspaceId, invitationId)
    const succeeded = input.deliveryStatus === 'sent' || input.deliveryStatus === 'not-required'
    const now = this.clock()
    const preservesInvitationIdentity = input.cognitoIdentityId === undefined ||
      input.cognitoIdentityId === invitation.cognitoIdentityId
    const cognitoIdentityId = input.cognitoIdentityId ?? invitation.cognitoIdentityId
    const cognitoUsername = input.cognitoUsername ?? (
      preservesInvitationIdentity ? invitation.cognitoUsername : undefined
    )

    if (Boolean(cognitoIdentityId) !== Boolean(cognitoUsername)) {
      throw new WorkspaceAccessError(
        503,
        'WorkspaceIdentityUnavailable',
        'Cognito identity metadata is unavailable.',
      )
    }

    return this.updateInvitation(
      workspaceId,
      invitation,
      input.expectedVersion,
      {
        status: succeeded ? 'pending' : 'delivery-failed',
        deliveryStatus: input.deliveryStatus,
        identityOwnership: input.identityOwnership,
        cognitoIdentityId,
        cognitoUsername,
        directoryClaimCleanupRequired: (
          (preservesInvitationIdentity && invitation.directoryClaimCleanupRequired === true) ||
          input.directoryClaimCleanupRequired === true
        )
          ? true
          : undefined,
        identityCleanupManualRequired: undefined,
        identityMutationAttempted: succeeded
          ? undefined
          : invitation.identityMutationAttempted,
        failureMessage: succeeded ? undefined : input.failureMessage ?? 'Invitation delivery failed.',
        lastSentAt: input.deliveryStatus === 'sent' ? now.toISOString() : invitation.lastSentAt,
        expiresAt: addDays(now, 7).toISOString(),
      },
      ['provisioning', 'delivery-failed', 'pending'],
      auditContext,
      'invitation.delivery-updated',
      'delivery-updated',
      3,
    )
  }

  /** revoked invitation の Cognito cleanup 失敗を version 条件付きで記録します。 */
  async markInvitationCleanupFailure(
    workspaceId: string,
    invitationId: string,
    input: MarkWorkspaceInvitationCleanupFailureInput,
    auditContext?: MutationAuditContext,
  ) {
    const invitation = await this.requireInvitation(workspaceId, invitationId)

    if (invitation.status !== 'revoked') {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceInvitationNotRevoked',
        'Only a revoked invitation can record Cognito cleanup failure.',
      )
    }

    return this.updateInvitation(
      workspaceId,
      invitation,
      input.expectedVersion,
      {
        status: 'revoked',
        deliveryStatus: 'not-required',
        failureMessage: input.failureMessage,
      },
      ['revoked'],
      auditContext,
      'invitation.cleanup-failed',
      'cleanup-failed',
      1,
    )
  }

  /** 自動 cleanup できない revoked invitation を手動確認待ちとして記録します。 */
  async markInvitationManualCleanupRequired(
    workspaceId: string,
    invitationId: string,
    expectedVersion: number,
    auditContext?: MutationAuditContext,
  ) {
    const invitation = await this.requireInvitation(workspaceId, invitationId)

    if (invitation.status !== 'revoked') {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceInvitationNotRevoked',
        'Only a revoked invitation can require manual Cognito cleanup.',
      )
    }

    if (
      invitation.identityCleanupManualRequired === true &&
      invitation.failureMessage === MANUAL_COGNITO_CLEANUP_MESSAGE
    ) {
      return invitation
    }

    return this.updateInvitation(
      workspaceId,
      invitation,
      expectedVersion,
      {
        status: 'revoked',
        deliveryStatus: 'not-required',
        identityCleanupCompleted: undefined,
        identityCleanupManualRequired: true,
        failureMessage: MANUAL_COGNITO_CLEANUP_MESSAGE,
      },
      ['revoked'],
      auditContext,
      'invitation.cleanup-manual-required',
      'cleanup-manual-required',
      2,
    )
  }

  /** Cognito cleanup 成功後に retry marker と directory claim の補償責務を消します。 */
  async clearInvitationCleanupFailure(
    workspaceId: string,
    invitationId: string,
    expectedVersion: number,
    auditContext?: MutationAuditContext,
  ) {
    const invitation = await this.requireInvitation(workspaceId, invitationId)

    if (invitation.status !== 'revoked') {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceInvitationNotRevoked',
        'Only a revoked invitation can complete Cognito cleanup.',
      )
    }

    return this.updateInvitation(
      workspaceId,
      invitation,
      expectedVersion,
      {
        status: 'revoked',
        deliveryStatus: 'not-required',
        directoryClaimCleanupRequired: undefined,
        identityCleanupCompleted: true,
        identityCleanupManualRequired: undefined,
        identityMutationAttempted: undefined,
        failureMessage: undefined,
      },
      ['revoked'],
      auditContext,
      'invitation.cleanup-completed',
      'cleanup-completed',
      3,
    )
  }

  /** 手動 Cognito cleanup の完了を管理権限と version 付きで確認します。 */
  async acknowledgeInvitationManualCleanup(
    workspaceId: string,
    actorMemberKey: string,
    invitationId: string,
    expectedVersion: number,
    auditContext?: MutationAuditContext,
  ) {
    const actor = await this.requireActiveActor(workspaceId, actorMemberKey)
    const invitation = await this.requireInvitation(workspaceId, invitationId)
    assertCanManageRole(actor, invitation.role)

    if (
      invitation.status !== 'revoked' ||
      invitation.identityCleanupManualRequired !== true
    ) {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceInvitationManualCleanupNotRequired',
        'This invitation is not waiting for manual Cognito cleanup.',
      )
    }

    if (invitation.version !== expectedVersion) {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceVersionConflict',
        'Workspace invitation changed. Reload and try again.',
      )
    }

    return this.updateInvitationWithActor(
      workspaceId,
      actor,
      invitation,
      {
        status: 'revoked',
        deliveryStatus: 'not-required',
        directoryClaimCleanupRequired: undefined,
        identityCleanupCompleted: true,
        identityCleanupManualRequired: undefined,
        identityMutationAttempted: undefined,
        failureMessage: undefined,
      },
      auditContext,
      'invitation.cleanup-acknowledged',
      'cleanup-acknowledged',
      0,
    )
  }

  /** invitation を再送処理前の provisioning 状態へ遷移させます。 */
  async prepareResend(
    workspaceId: string,
    actorMemberKey: string,
    invitationId: string,
    expiresInDays = 7,
    auditContext?: MutationAuditContext,
  ) {
    const actor = await this.requireActiveActor(workspaceId, actorMemberKey)
    const invitation = await this.requireInvitation(workspaceId, invitationId)
    assertCanManageRole(actor, invitation.role)

    if (hasActiveInvitationAcceptanceLock(invitation, this.clock())) {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceInvitationAcceptanceInProgress',
        'An invitation cannot be resent while acceptance is in progress.',
      )
    }

    if (
      invitation.identityCleanupManualRequired === true ||
      requiresManualLegacyIdentityCleanup(invitation)
    ) {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceInvitationManualCleanupRequired',
        'Manual Cognito cleanup must complete before this invitation can be resent.',
      )
    }

    if (invitation.status !== 'pending' && invitation.status !== 'delivery-failed') {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceInvitationNotResendable',
        'The invitation cannot be resent in its current state.',
      )
    }

    return this.updateInvitationWithActor(
      workspaceId,
      actor,
      invitation,
      {
        status: 'provisioning',
        deliveryStatus: 'pending',
        failureMessage: undefined,
        acceptanceLockExpiresAt: undefined,
        identityMutationAttempted: undefined,
        expiresAt: addDays(this.clock(), expiresInDays).toISOString(),
      },
      auditContext,
      'invitation.resend-started',
      'resend-started',
      0,
    )
  }

  /** invitation を取り消します。 */
  async revokeInvitation(
    workspaceId: string,
    actorMemberKey: string,
    invitationId: string,
    auditContext?: MutationAuditContext,
  ) {
    const actor = await this.requireActiveActor(workspaceId, actorMemberKey)
    const invitation = await this.requireInvitation(workspaceId, invitationId)
    assertCanManageRole(actor, invitation.role)

    if (hasActiveInvitationAcceptanceLock(invitation, this.clock())) {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceInvitationAcceptanceInProgress',
        'An invitation cannot be revoked while acceptance is in progress.',
      )
    }

    if (
      invitation.status === 'provisioning' &&
      hasActiveInvitationProvisioningLease(invitation, this.clock())
    ) {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceInvitationProvisioning',
        'An invitation cannot be revoked while Cognito provisioning is in progress.',
      )
    }

    if (invitation.status === 'accepted') {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceInvitationAccepted',
        'An accepted invitation cannot be revoked.',
      )
    }

    if (invitation.status === 'revoked' && invitation.identityCleanupCompleted) {
      return invitation
    }

    if (invitation.status === 'revoked' && invitation.identityCleanupManualRequired === true) {
      return invitation
    }

    const identityCleanupManualRequired = invitation.identityCleanupManualRequired === true ||
      requiresManualLegacyIdentityCleanup(invitation)

    if (
      invitation.status === 'revoked' &&
      !invitation.failureMessage &&
      !identityCleanupManualRequired
    ) {
      return invitation
    }
    const cleanupPendingMessage = identityCleanupManualRequired
      ? MANUAL_COGNITO_CLEANUP_MESSAGE
      : (
          invitation.identityOwnership === 'workspace-created' ||
          invitation.directoryClaimCleanupRequired === true
        )
        ? invitation.failureMessage ?? 'Cognito cleanup is pending and can be retried safely.'
        : undefined
    const nextIdentityCleanupManualRequired = identityCleanupManualRequired || undefined

    if (
      invitation.status === 'revoked' &&
      invitation.identityCleanupManualRequired === nextIdentityCleanupManualRequired &&
      invitation.failureMessage === cleanupPendingMessage
    ) {
      return invitation
    }

    if (invitation.status === 'revoked') {
      return this.updateInvitationWithActor(
        workspaceId,
        actor,
        invitation,
        {
          identityCleanupManualRequired: nextIdentityCleanupManualRequired,
          failureMessage: cleanupPendingMessage,
        },
        auditContext,
        'invitation.revoked',
        'revoked',
        0,
      )
    }

    return this.updateInvitationWithActor(
      workspaceId,
      actor,
      invitation,
      {
        status: 'revoked',
        deliveryStatus: 'not-required',
        acceptanceLockExpiresAt: undefined,
        identityCleanupManualRequired: nextIdentityCleanupManualRequired,
        failureMessage: cleanupPendingMessage,
      },
      auditContext,
      'invitation.revoked',
      'revoked',
      0,
    )
  }

  /** expired / revoked invitation を新しい招待処理へ遷移させます。 */
  async prepareReinvite(
    workspaceId: string,
    actorMemberKey: string,
    invitationId: string,
    expiresInDays = 7,
    auditContext?: MutationAuditContext,
  ) {
    const actor = await this.requireActiveActor(workspaceId, actorMemberKey)
    const invitation = await this.requireInvitation(workspaceId, invitationId)
    assertCanManageRole(actor, invitation.role)

    if (hasActiveInvitationAcceptanceLock(invitation, this.clock())) {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceInvitationAcceptanceInProgress',
        'An invitation cannot be recreated while acceptance is in progress.',
      )
    }

    if (invitation.status !== 'expired' && invitation.status !== 'revoked') {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceInvitationNotReinvitable',
        'Only expired or revoked invitations can be reinvited.',
      )
    }

    if (
      invitation.identityCleanupManualRequired === true ||
      requiresManualLegacyIdentityCleanup(invitation)
    ) {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceInvitationManualCleanupRequired',
        'Manual Cognito cleanup must complete before this invitation can be recreated.',
      )
    }

    if (
      invitation.status === 'revoked' &&
      (
        invitation.identityOwnership === 'workspace-created' ||
        invitation.directoryClaimCleanupRequired === true
      ) &&
      invitation.failureMessage
    ) {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceInvitationCleanupPending',
        'Cognito cleanup must complete before this invitation can be recreated.',
      )
    }

    return this.updateInvitationWithActor(
      workspaceId,
      actor,
      invitation,
      {
        status: 'provisioning',
        deliveryStatus: 'pending',
        identityOwnership: invitation.status === 'revoked'
          ? 'ambiguous'
          : invitation.identityOwnership,
        cognitoIdentityId: invitation.status === 'revoked'
          ? undefined
          : invitation.cognitoIdentityId,
        cognitoUsername: invitation.status === 'revoked'
          ? undefined
          : invitation.cognitoUsername,
        directoryClaimCleanupRequired: invitation.status === 'revoked'
          ? undefined
          : invitation.directoryClaimCleanupRequired,
        identityCleanupCompleted: undefined,
        identityCleanupManualRequired: undefined,
        identityMutationAttempted: undefined,
        acceptanceLockExpiresAt: undefined,
        failureMessage: undefined,
        expiresAt: addDays(this.clock(), expiresInDays).toISOString(),
      },
      auditContext,
      'invitation.reinvite-started',
      'reinvite-started',
      0,
    )
  }

  /** 認証済み identity の invitation 受諾と active membership 作成を原子的に行います。 */
  async reconcileAuthenticatedMember(
    workspaceId: string,
    input: ReconcileAuthenticatedWorkspaceMemberInput,
    auditContext?: MutationAuditContext,
  ) {
    const normalizedWorkspaceId = normalizeRequired(workspaceId, 'Workspace ID')
    const memberKey = normalizeMemberKey(input.memberKey)
    const email = normalizeEmail(input.email)
    const existingMember = await this.getMember(normalizedWorkspaceId, memberKey)

    if (existingMember?.status === 'active') {
      return existingMember
    }

    if (existingMember) {
      throw new WorkspaceAccessError(403, 'WorkspaceMemberDeactivated', 'Workspace access is deactivated.')
    }

    const invitation = await this.requireInvitation(normalizedWorkspaceId, email)

    if (!isInvitationAcceptable(invitation)) {
      throw new WorkspaceAccessError(
        403,
        'WorkspaceInvitationRequired',
        'An active Workspace invitation is required.',
      )
    }

    const nowIso = this.clock().toISOString()
    const member: WorkspaceMember = {
      id: memberKey,
      memberKey,
      email,
      name: normalizeOptional(input.name) ?? invitation.name,
      role: invitation.role,
      status: 'active',
      version: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
    }
    const acceptedInvitation: WorkspaceInvitation = {
      ...invitation,
      status: 'accepted',
      deliveryStatus: 'not-required',
      acceptanceLockExpiresAt: undefined,
      acceptedAt: nowIso,
      failureMessage: undefined,
      version: invitation.version + 1,
      updatedAt: nowIso,
    }
    const memberAuditPut = this.createWorkspaceAuditPut(auditContext, {
      directoryId: normalizedWorkspaceId,
      eventType: 'member.created',
      entityType: 'member',
      entityId: this.createMemberAuditEntityId(normalizedWorkspaceId, member.memberKey),
      action: 'created',
      occurredAt: nowIso,
      changes: createAuditFieldChanges(
        undefined,
        member,
        WORKSPACE_MEMBER_AUDIT_FIELDS,
        WORKSPACE_AUDIT_REDACT_FIELDS,
      ),
      metadata: { kind: 'workspace-member' },
      sequence: 1,
    })
    const invitationAuditPut = this.createInvitationAuditPut(
      normalizedWorkspaceId,
      invitation,
      acceptedInvitation,
      auditContext,
      'invitation.accepted',
      'accepted',
      2,
    )
    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Put: {
          TableName: this.tableName,
          Item: toMemberItem(normalizedWorkspaceId, member, invitation.identityOwnership),
          ConditionExpression: 'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
        },
      },
      {
        Update: {
          TableName: this.tableName,
          Key: {
            workspaceId: normalizedWorkspaceId,
            recordKey: createInvitationRecordKey(invitation.id),
          },
          UpdateExpression:
            'SET #status = :accepted, deliveryStatus = :notRequired, acceptedAt = :now, updatedAt = :now, version = version + :one REMOVE failureMessage, acceptanceLockExpiresAt',
          ConditionExpression:
            'version = :expectedVersion AND #status IN (:pending, :provisioning, :deliveryFailed) AND expiresAt > :now',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':accepted': 'accepted',
            ':notRequired': 'not-required',
            ':now': nowIso,
            ':one': 1,
            ':expectedVersion': invitation.version,
            ':pending': 'pending',
            ':provisioning': 'provisioning',
            ':deliveryFailed': 'delivery-failed',
          },
        },
      },
    ]

    if (member.role === 'owner') {
      transactItems.push({ Update: createOwnerCountUpdate(this.tableName, normalizedWorkspaceId, 1, nowIso) })
    }
    const aggregateItemCount = transactItems.length

    transactItems.push(
      ...(memberAuditPut ? [memberAuditPut] : []),
      ...(invitationAuditPut ? [invitationAuditPut] : []),
    )

    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactItems }))
      return member
    } catch (error) {
      if (
        isConditionalTransactionCancellation(error) &&
        Array.from({ length: aggregateItemCount }, (_, index) => index)
          .some((index) => isTransactionConditionalFailureAt(error, index))
      ) {
        const reconciledMember = await this.getActiveMember(normalizedWorkspaceId, memberKey)

        if (reconciledMember) {
          return reconciledMember
        }

        throw new WorkspaceAccessError(
          409,
          'WorkspaceReconcileConflict',
          'Workspace membership changed while authentication was being completed.',
          { cause: error },
        )
      }

      throw toWorkspaceAccessError(error)
    }
  }

  /** actor の権限を検証し、target member を version 付きで更新します。 */
  async updateMember(
    workspaceId: string,
    actorMemberKey: string,
    targetMemberKey: string,
    input: UpdateWorkspaceMemberInput,
    auditContext?: MutationAuditContext,
  ) {
    const normalizedWorkspaceId = normalizeRequired(workspaceId, 'Workspace ID')
    const actor = await this.requireActiveActor(normalizedWorkspaceId, actorMemberKey)
    const target = await this.getMember(normalizedWorkspaceId, targetMemberKey)

    if (!target) {
      throw new WorkspaceAccessError(404, 'WorkspaceMemberNotFound', 'Workspace member was not found.')
    }

    if (input.role === undefined && input.status === undefined) {
      throw new WorkspaceAccessError(400, 'InvalidWorkspaceMemberUpdate', 'Role or status is required.')
    }

    const nextRole = input.role === undefined ? target.role : requireWorkspaceRole(input.role)
    const nextStatus = input.status === undefined ? target.status : requireMemberStatus(input.status)
    assertCanUpdateMember(actor, target, nextRole)

    if (actor.memberKey === target.memberKey && nextStatus === 'deactivated') {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceSelfDeactivation',
        'You cannot deactivate your own Workspace membership.',
      )
    }

    const wasActiveOwner = target.role === 'owner' && target.status === 'active'
    const willBeActiveOwner = nextRole === 'owner' && nextStatus === 'active'
    const ownerCountDelta = Number(willBeActiveOwner) - Number(wasActiveOwner)
    const nowIso = this.clock().toISOString()
    const becameDeactivated = target.status !== 'deactivated' && nextStatus === 'deactivated'
    const nextMember = {
      ...target,
      role: nextRole,
      status: nextStatus,
      version: target.version + 1,
      updatedAt: nowIso,
      deactivatedAt: becameDeactivated
        ? nowIso
        : nextStatus === 'deactivated'
          ? target.deactivatedAt
          : undefined,
    } satisfies WorkspaceMember
    const roleChanged = nextRole !== target.role
    const statusChanged = nextStatus !== target.status

    if (!roleChanged && !statusChanged) {
      if (target.version !== input.expectedVersion) {
        throw new WorkspaceAccessError(
          409,
          'WorkspaceVersionConflict',
          'Workspace member changed. Reload and try again.',
        )
      }

      return target
    }

    const memberEventType = roleChanged && !statusChanged
      ? 'member.role-changed'
      : statusChanged && !roleChanged
        ? nextStatus === 'deactivated' ? 'member.deactivated' : 'member.reactivated'
        : 'member.updated'
    const memberAction = memberEventType.slice('member.'.length)
    const memberAuditPut = this.createWorkspaceAuditPut(auditContext, {
      directoryId: normalizedWorkspaceId,
      eventType: memberEventType,
      entityType: 'member',
      entityId: this.createMemberAuditEntityId(normalizedWorkspaceId, target.memberKey),
      action: memberAction,
      occurredAt: nowIso,
      changes: createAuditFieldChanges(
        target,
        nextMember,
        WORKSPACE_MEMBER_AUDIT_FIELDS,
        WORKSPACE_AUDIT_REDACT_FIELDS,
      ),
      metadata: { kind: 'workspace-member' },
      sequence: 0,
    })
    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = []
    const actorConditionIndex = actor.memberKey !== target.memberKey ? 0 : undefined

    if (actor.memberKey !== target.memberKey) {
      transactItems.push(this.actorCondition(normalizedWorkspaceId, actor))
    }

    const memberUpdateIndex = transactItems.length
    transactItems.push({
      Update: {
        TableName: this.tableName,
        Key: {
          workspaceId: normalizedWorkspaceId,
          recordKey: createMemberRecordKey(target.memberKey),
        },
        UpdateExpression: becameDeactivated
          ? 'SET #role = :role, #status = :status, updatedAt = :now, deactivatedAt = :now, version = version + :one'
          : nextStatus === 'deactivated'
            ? 'SET #role = :role, #status = :status, updatedAt = :now, version = version + :one'
            : 'SET #role = :role, #status = :status, updatedAt = :now, version = version + :one REMOVE deactivatedAt',
        ConditionExpression: 'attribute_exists(workspaceId) AND version = :expectedVersion',
        ExpressionAttributeNames: { '#role': 'role', '#status': 'status' },
        ExpressionAttributeValues: {
          ':role': nextRole,
          ':status': nextStatus,
          ':now': nowIso,
          ':one': 1,
          ':expectedVersion': input.expectedVersion,
        },
      },
    })

    const ownerGuardIndex = ownerCountDelta !== 0 ? transactItems.length : undefined
    if (ownerGuardIndex !== undefined) {
      transactItems.push({
        Update: createOwnerCountUpdate(
          this.tableName,
          normalizedWorkspaceId,
          ownerCountDelta,
          nowIso,
        ),
      })
    }

    const planningRevisionItemIndex = transactItems.length
    transactItems.push(createPlanningRevisionMutation(
      this.planningTableName,
      normalizedWorkspaceId,
      input.expectedPlanningRevision,
      nowIso,
    ))

    if (memberAuditPut) {
      transactItems.push(memberAuditPut)
    }

    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactItems }))
      return nextMember
    } catch (error) {
      if (isAwsError(error, 'TransactionCanceledException')) {
        if (!isConditionalTransactionCancellation(error)) {
          throw toWorkspaceAccessError(error)
        }

        if (isTransactionConditionalFailureAt(error, planningRevisionItemIndex)) {
          throw new WorkspaceAccessError(
            409,
            'PlanningRevisionConflict',
            'Planning changed. Reload and try again.',
            { cause: error },
          )
        }

        const aggregateConditionFailed =
          (actorConditionIndex !== undefined &&
            isTransactionConditionalFailureAt(error, actorConditionIndex)) ||
          isTransactionConditionalFailureAt(error, memberUpdateIndex) ||
          (ownerGuardIndex !== undefined &&
            isTransactionConditionalFailureAt(error, ownerGuardIndex))

        if (aggregateConditionFailed) {
          await this.classifyMemberUpdateConflict(
            normalizedWorkspaceId,
            actor,
            target,
            input.expectedVersion,
            ownerCountDelta < 0 && ownerGuardIndex !== undefined &&
              isTransactionConditionalFailureAt(error, ownerGuardIndex),
          )
        }
      }
      throw toWorkspaceAccessError(error)
    }
  }

  /** active actor を取得し、存在しない場合は拒否します。 */
  private async requireActiveActor(workspaceId: string, memberKey: string) {
    const actor = await this.getActiveMember(workspaceId, memberKey)

    if (!actor) {
      throw new WorkspaceAccessError(403, 'WorkspaceAccessDenied', 'Workspace access is denied.')
    }

    return actor
  }

  /** invitation を取得し、存在しない場合は 404 を返します。 */
  private async requireInvitation(workspaceId: string, invitationId: string) {
    const invitation = await this.getInvitation(workspaceId, invitationId)

    if (!invitation) {
      throw new WorkspaceAccessError(404, 'WorkspaceInvitationNotFound', 'Workspace invitation was not found.')
    }

    return invitation
  }

  /** actor membership が transaction 中も active か検証する condition です。 */
  private actorCondition(workspaceId: string, actor: WorkspaceMember) {
    return {
      ConditionCheck: {
        TableName: this.tableName,
        Key: {
          workspaceId,
          recordKey: createMemberRecordKey(actor.memberKey),
        },
        ConditionExpression: '#status = :active AND #role = :role AND version = :version',
        ExpressionAttributeNames: { '#status': 'status', '#role': 'role' },
        ExpressionAttributeValues: {
          ':active': 'active',
          ':role': actor.role,
          ':version': actor.version,
        },
      },
    }
  }

  /** invitation の before/after から allowlist 済み audit Put を作成します。 */
  private createInvitationAuditPut(
    workspaceId: string,
    before: WorkspaceInvitation | undefined,
    after: WorkspaceInvitation,
    auditContext: MutationAuditContext | undefined,
    eventType: string,
    action: string,
    sequence: number,
  ) {
    return this.createWorkspaceAuditPut(auditContext, {
      directoryId: workspaceId,
      eventType,
      entityType: 'invitation',
      entityId: this.createInvitationAuditEntityId(workspaceId, after.id),
      action,
      occurredAt: after.updatedAt,
      changes: createAuditFieldChanges(
        before,
        after,
        WORKSPACE_INVITATION_AUDIT_FIELDS,
        WORKSPACE_AUDIT_REDACT_FIELDS,
      ),
      metadata: { kind: 'workspace-invitation' },
      sequence,
    })
  }

  /** Audit 設定時に context を必須化し、条件付き event Put を作成します。 */
  private createWorkspaceAuditPut(
    auditContext: MutationAuditContext | undefined,
    input: MutationAuditEventInput,
  ) {
    if (!this.auditTableName) {
      return undefined
    }

    if (!auditContext) {
      throw new WorkspaceAccessError(
        500,
        'WorkspaceAuditContextMissing',
        'Workspace mutation audit context is required.',
      )
    }

    if (auditContext.workspaceId !== input.directoryId) {
      throw new WorkspaceAccessError(
        500,
        'WorkspaceAuditContextMismatch',
        'Workspace mutation audit context does not match the target Workspace.',
      )
    }

    return createMutationAuditEventPut(this.auditTableName, auditContext, input)
  }

  /** Workspace member の公開 audit ID を固定 HMAC key から導出します。 */
  private createMemberAuditEntityId(workspaceId: string, memberId: string) {
    return this.createAuditEntityId((pseudonymKey) =>
      createWorkspaceMemberAuditEntityId(workspaceId, memberId, pseudonymKey)
    )
  }

  /** Workspace invitation の公開 audit ID を固定 HMAC key から導出します。 */
  private createInvitationAuditEntityId(workspaceId: string, invitationId: string) {
    return this.createAuditEntityId((pseudonymKey) =>
      createWorkspaceInvitationAuditEntityId(workspaceId, invitationId, pseudonymKey)
    )
  }

  /** Audit 無効時は未使用 placeholder を返し、有効時は key 設定を fail-closed で検証します。 */
  private createAuditEntityId(createId: (pseudonymKey: string) => string) {
    if (!this.auditTableName) {
      return 'audit-disabled'
    }

    if (!this.auditPseudonymKey) {
      throw new WorkspaceAccessError(
        500,
        'WorkspaceAuditPseudonymKeyMissing',
        'Workspace audit pseudonym key is required.',
      )
    }

    try {
      return createId(this.auditPseudonymKey)
    } catch (error) {
      throw new WorkspaceAccessError(
        500,
        'WorkspaceAuditPseudonymKeyInvalid',
        'Workspace audit pseudonym key is invalid.',
        { cause: error },
      )
    }
  }

  /** actor guard と invitation update を同一 transaction で実行します。 */
  private async updateInvitationWithActor(
    workspaceId: string,
    actor: WorkspaceMember,
    invitation: WorkspaceInvitation,
    changes: Partial<WorkspaceInvitation>,
    auditContext: MutationAuditContext | undefined,
    eventType: string,
    action: string,
    sequence: number,
  ) {
    const normalizedWorkspaceId = normalizeRequired(workspaceId, 'Workspace ID')
    const nextInvitation = applyInvitationChanges(invitation, changes, this.clock())
    const auditPut = this.createInvitationAuditPut(
      normalizedWorkspaceId,
      invitation,
      nextInvitation,
      auditContext,
      eventType,
      action,
      sequence,
    )

    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          this.actorCondition(normalizedWorkspaceId, actor),
          {
            Put: {
              TableName: this.tableName,
              Item: toInvitationItem(normalizedWorkspaceId, nextInvitation),
              ConditionExpression: 'version = :expectedVersion',
              ExpressionAttributeValues: { ':expectedVersion': invitation.version },
            },
          },
          ...(auditPut ? [auditPut] : []),
        ],
      }))
      return nextInvitation
    } catch (error) {
      if (isConditionalTransactionCancellation(error)) {
        if (isTransactionConditionalFailureAt(error, 0)) {
          const latestActor = await this.getActiveMember(normalizedWorkspaceId, actor.memberKey)

          if (!latestActor || latestActor.version !== actor.version || latestActor.role !== actor.role) {
            throw new WorkspaceAccessError(
              403,
              'WorkspaceRoleDenied',
              'Workspace management permission changed.',
              { cause: error },
            )
          }
        }

        if (isTransactionConditionalFailureAt(error, 1)) {
          const latestInvitation = await this.getInvitation(
            normalizedWorkspaceId,
            invitation.id,
          )

          if (!latestInvitation) {
            throw new WorkspaceAccessError(
              404,
              'WorkspaceInvitationNotFound',
              'Workspace invitation was not found.',
              { cause: error },
            )
          }

          throw new WorkspaceAccessError(
            409,
            'WorkspaceVersionConflict',
            'Workspace invitation changed. Reload and try again.',
            { cause: error },
          )
        }
      }

      throw toWorkspaceAccessError(error)
    }
  }

  /** invitation を version 条件付きで更新します。 */
  private async updateInvitation(
    workspaceId: string,
    invitation: WorkspaceInvitation,
    expectedVersion: number,
    changes: Partial<WorkspaceInvitation>,
    allowedStatuses?: WorkspaceInvitationStatus[],
    auditContext?: MutationAuditContext,
    eventType = 'invitation.updated',
    action = 'updated',
    sequence = 0,
  ) {
    const nextInvitation = applyInvitationChanges(invitation, changes, this.clock())
    const normalizedWorkspaceId = normalizeRequired(workspaceId, 'Workspace ID')
    const expressionAttributeValues: Record<string, unknown> = {
      ':expectedVersion': expectedVersion,
    }
    let conditionExpression = 'version = :expectedVersion'

    if (allowedStatuses?.length) {
      const placeholders = allowedStatuses.map((status, index) => {
        const key = `:status${index}`
        expressionAttributeValues[key] = status
        return key
      })
      conditionExpression += ` AND #status IN (${placeholders.join(', ')})`
    }

    const statePut = {
      TableName: this.tableName,
      Item: toInvitationItem(normalizedWorkspaceId, nextInvitation),
      ConditionExpression: conditionExpression,
      ...(allowedStatuses?.length ? { ExpressionAttributeNames: { '#status': 'status' } } : {}),
      ExpressionAttributeValues: expressionAttributeValues,
    }
    const auditPut = this.createInvitationAuditPut(
      normalizedWorkspaceId,
      invitation,
      nextInvitation,
      auditContext,
      eventType,
      action,
      sequence,
    )

    try {
      if (auditPut) {
        await this.documentClient.send(new TransactWriteCommand({
          TransactItems: [{ Put: statePut }, auditPut],
        }))
      } else {
        await this.documentClient.send(new PutCommand(statePut))
      }
      return nextInvitation
    } catch (error) {
      if (
        isAwsError(error, 'ConditionalCheckFailedException') ||
        (
          isConditionalTransactionCancellation(error) &&
          isTransactionConditionalFailureAt(error, 0)
        )
      ) {
        const latest = await this.getInvitation(workspaceId, invitation.id)

        if (!latest) {
          throw new WorkspaceAccessError(404, 'WorkspaceInvitationNotFound', 'Workspace invitation was not found.')
        }

        throw new WorkspaceAccessError(
          409,
          'WorkspaceVersionConflict',
          'Workspace invitation changed. Reload and try again.',
          { cause: error },
        )
      }

      throw toWorkspaceAccessError(error)
    }
  }

  /** create invitation transaction cancellation を最新状態から分類します。 */
  private async classifyCreateInvitationConflict(
    workspaceId: string,
    actorMemberKey: string,
    invitation: WorkspaceInvitation,
  ): Promise<never> {
    if (!await this.getActiveMember(workspaceId, actorMemberKey)) {
      throw new WorkspaceAccessError(403, 'WorkspaceAccessDenied', 'Workspace access is denied.')
    }

    if (await this.getMember(workspaceId, invitation.email)) {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceMemberAlreadyExists',
        'The invited user is already a Workspace member.',
      )
    }

    if (await this.getInvitation(workspaceId, invitation.id)) {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceInvitationAlreadyExists',
        'An invitation for this email already exists.',
      )
    }

    throw new WorkspaceAccessError(
      409,
      'WorkspaceTransactionConflict',
      'Workspace access data changed concurrently.',
    )
  }

  /** member update transaction cancellation を最新状態から分類します。 */
  private async classifyMemberUpdateConflict(
    workspaceId: string,
    actor: WorkspaceMember,
    target: WorkspaceMember,
    expectedVersion: number,
    ownerGuardFailed: boolean,
  ): Promise<never> {
    if (actor.memberKey === target.memberKey) {
      const latestSelf = await this.getMember(workspaceId, target.memberKey)

      if (!latestSelf) {
        throw new WorkspaceAccessError(404, 'WorkspaceMemberNotFound', 'Workspace member was not found.')
      }

      if (latestSelf.version !== expectedVersion) {
        throw new WorkspaceAccessError(
          409,
          'WorkspaceVersionConflict',
          'Workspace member changed. Reload and try again.',
        )
      }

      if (ownerGuardFailed) {
        throw new WorkspaceAccessError(
          409,
          'WorkspaceLastOwner',
          'At least one active Workspace owner is required.',
        )
      }

      throw new WorkspaceAccessError(
        409,
        'WorkspaceTransactionConflict',
        'Workspace member changed concurrently. Reload and try again.',
      )
    }

    const latestActor = await this.getActiveMember(workspaceId, actor.memberKey)

    if (!latestActor || latestActor.version !== actor.version || latestActor.role !== actor.role) {
      throw new WorkspaceAccessError(403, 'WorkspaceRoleDenied', 'Workspace management permission changed.')
    }

    const latestTarget = await this.getMember(workspaceId, target.memberKey)

    if (!latestTarget) {
      throw new WorkspaceAccessError(404, 'WorkspaceMemberNotFound', 'Workspace member was not found.')
    }

    if (latestTarget.version !== expectedVersion) {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceVersionConflict',
        'Workspace member changed. Reload and try again.',
      )
    }

    if (ownerGuardFailed) {
      throw new WorkspaceAccessError(
        409,
        'WorkspaceLastOwner',
        'At least one active Workspace owner is required.',
      )
    }

    throw new WorkspaceAccessError(
      409,
      'WorkspaceTransactionConflict',
      'Workspace member changed concurrently. Reload and try again.',
    )
  }

  /** Workspace partition を全 page 読み取ります。 */
  private async queryItems(workspaceId: string, recordKeyPrefix?: string) {
    await this.ensureLocalTable()
    const normalizedWorkspaceId = normalizeRequired(workspaceId, 'Workspace ID')
    const items: Record<string, unknown>[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined

    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: recordKeyPrefix
          ? 'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)'
          : 'workspaceId = :workspaceId',
        ExpressionAttributeValues: {
          ':workspaceId': normalizedWorkspaceId,
          ...(recordKeyPrefix ? { ':prefix': recordKeyPrefix } : {}),
        },
        ExclusiveStartKey: exclusiveStartKey,
        ConsistentRead: true,
      }))
      items.push(...(response.Items ?? []))
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)

    return items
  }

  /** ローカル実行時に Workspace access と audit table を任意で作成します。 */
  private async ensureLocalTable() {
    if (!this.bootstrapLocalTable) {
      return
    }

    this.localTableInitializer ??= Promise.all([
      ensureWorkspaceAccessTable(this.tableName, this.dynamoDbClient),
      ...(this.auditTableName
        ? [ensureLocalAuditEventsTable(this.auditTableName, this.dynamoDbClient)]
        : []),
    ]).then(() => undefined)
    await this.localTableInitializer
  }
}

function readEnvironment(name: string) {
  return process.env[name]
}

function createDynamoDbClient() {
  const endpoint = readEnvironment('DYNAMODB_ENDPOINT') ?? readEnvironment('AWS_ENDPOINT_URL')

  return new DynamoDBClient({
    region: readEnvironment('AWS_REGION') ?? readEnvironment('AWS_DEFAULT_REGION') ?? 'us-east-1',
    endpoint,
    ...(endpoint
      ? {
          credentials: {
            accessKeyId: readEnvironment('AWS_ACCESS_KEY_ID') ?? 'test',
            secretAccessKey: readEnvironment('AWS_SECRET_ACCESS_KEY') ?? 'test',
          },
        }
      : {}),
  })
}

function normalizeRequired(value: string, label: string) {
  const normalized = value.trim()

  if (!normalized) {
    throw new WorkspaceAccessError(400, 'InvalidWorkspaceInput', `${label} is required.`)
  }

  return normalized
}

function normalizeMemberKey(value: string) {
  return normalizeEmail(value)
}

function normalizeEmail(value: string) {
  const normalized = value.trim().toLowerCase()

  if (!normalized || !normalized.includes('@')) {
    throw new WorkspaceAccessError(400, 'InvalidWorkspaceEmail', 'A valid email address is required.')
  }

  return normalized
}

function normalizeOptional(value: string | undefined) {
  const normalized = value?.trim()
  return normalized || undefined
}

function addDays(value: Date, days: number) {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1000)
}

function createMemberRecordKey(memberKey: string) {
  return `MEMBER#${normalizeMemberKey(memberKey)}`
}

function createInvitationRecordKey(invitationId: string) {
  return `INVITATION#${normalizeEmail(invitationId)}`
}

function requireWorkspaceRole(value: unknown): WorkspaceRole {
  if (value === 'owner' || value === 'admin' || value === 'member' || value === 'guest') {
    return value
  }

  throw new WorkspaceAccessError(400, 'InvalidWorkspaceRole', 'Workspace role is invalid.')
}

function requireMemberStatus(value: unknown): WorkspaceMemberStatus {
  if (value === 'active' || value === 'deactivated') {
    return value
  }

  throw new WorkspaceAccessError(400, 'InvalidWorkspaceMemberStatus', 'Workspace member status is invalid.')
}

function capabilitiesForRole(role: WorkspaceRole): WorkspaceAccessCapabilities {
  return {
    canInvite: role === 'owner' || role === 'admin',
    canManageMembers: role === 'owner' || role === 'admin',
    canManageAdmins: role === 'owner',
  }
}

function assertCanManageRole(actor: WorkspaceMember, managedRole: WorkspaceRole) {
  if (actor.role === 'owner') {
    return
  }

  if (actor.role === 'admin' && (managedRole === 'member' || managedRole === 'guest')) {
    return
  }

  throw new WorkspaceAccessError(
    403,
    'WorkspaceRoleDenied',
    'The Workspace role cannot manage this invitation.',
  )
}

function assertCanUpdateMember(
  actor: WorkspaceMember,
  target: WorkspaceMember,
  nextRole: WorkspaceRole,
) {
  if (actor.role === 'owner') {
    return
  }

  if (
    actor.role === 'admin' &&
    (target.role === 'member' || target.role === 'guest') &&
    (nextRole === 'member' || nextRole === 'guest')
  ) {
    return
  }

  throw new WorkspaceAccessError(
    403,
    'WorkspaceRoleDenied',
    'The Workspace role cannot manage this member.',
  )
}

function isInvitationAcceptable(invitation: WorkspaceInvitation) {
  return invitation.status === 'pending' ||
    invitation.status === 'provisioning' ||
    invitation.status === 'delivery-failed'
}

function hasActiveInvitationAcceptanceLock(invitation: WorkspaceInvitation, now: Date) {
  return typeof invitation.acceptanceLockExpiresAt === 'string' &&
    Date.parse(invitation.acceptanceLockExpiresAt) > now.getTime()
}

function hasActiveInvitationProvisioningLease(invitation: WorkspaceInvitation, now: Date) {
  const updatedAt = Date.parse(invitation.updatedAt)
  return Number.isFinite(updatedAt) &&
    updatedAt + INVITATION_PROVISIONING_LEASE_MS > now.getTime()
}

function requiresManualLegacyIdentityCleanup(invitation: WorkspaceInvitation) {
  const stablePairMissing = !invitation.cognitoIdentityId || !invitation.cognitoUsername
  return stablePairMissing && (
    invitation.identityLifecycleVersion !== WORKSPACE_IDENTITY_LIFECYCLE_VERSION ||
    invitation.identityMutationAttempted === true
  )
}

function compareWorkspaceMembers(left: WorkspaceMember, right: WorkspaceMember) {
  const roleDelta = workspaceRoleWeight(right.role) - workspaceRoleWeight(left.role)
  return roleDelta || (left.name ?? left.email).localeCompare(right.name ?? right.email, 'ja')
}

function workspaceRoleWeight(role: WorkspaceRole) {
  if (role === 'owner') {
    return 4
  }
  if (role === 'admin') {
    return 3
  }
  if (role === 'member') {
    return 2
  }
  return 1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toWorkspaceMember(value: unknown): WorkspaceMember {
  if (!isRecord(value)) {
    throw invalidWorkspaceDataError()
  }

  const memberKey = typeof value.memberKey === 'string' ? normalizeMemberKey(value.memberKey) : ''
  const email = typeof value.email === 'string' ? normalizeEmail(value.email) : memberKey
  const role = requireWorkspaceRole(value.role)
  const status = requireMemberStatus(value.status)

  if (
    !memberKey ||
    typeof value.version !== 'number' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    throw invalidWorkspaceDataError()
  }

  return {
    id: memberKey,
    memberKey,
    email,
    name: typeof value.name === 'string' ? value.name : undefined,
    role,
    status,
    version: value.version,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    deactivatedAt: typeof value.deactivatedAt === 'string' ? value.deactivatedAt : undefined,
  }
}

function toWorkspaceInvitation(value: unknown, now: Date): WorkspaceInvitation {
  if (!isRecord(value)) {
    throw invalidWorkspaceDataError()
  }

  const email = typeof value.email === 'string' ? normalizeEmail(value.email) : ''
  const role = requireWorkspaceRole(value.role)
  const status = requireInvitationStatus(value.status)
  const deliveryStatus = requireInvitationDeliveryStatus(value.deliveryStatus)
  const identityOwnership = requireIdentityOwnership(value.identityOwnership)

  if (
    !email ||
    typeof value.version !== 'number' ||
    typeof value.expiresAt !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    throw invalidWorkspaceDataError()
  }

  const effectiveStatus = (
    status === 'pending' || status === 'provisioning' || status === 'delivery-failed'
  ) && Date.parse(value.expiresAt) <= now.getTime()
    ? 'expired'
    : status

  return {
    id: typeof value.id === 'string' ? value.id : email,
    email,
    name: typeof value.name === 'string' ? value.name : undefined,
    role,
    status: effectiveStatus,
    deliveryStatus,
    identityOwnership,
    ...(value.identityLifecycleVersion === WORKSPACE_IDENTITY_LIFECYCLE_VERSION
      ? { identityLifecycleVersion: WORKSPACE_IDENTITY_LIFECYCLE_VERSION }
      : {}),
    ...(typeof value.cognitoIdentityId === 'string' && value.cognitoIdentityId.trim()
      ? { cognitoIdentityId: value.cognitoIdentityId.trim() }
      : {}),
    ...(typeof value.cognitoUsername === 'string' && value.cognitoUsername.trim()
      ? { cognitoUsername: value.cognitoUsername.trim() }
      : {}),
    ...(value.directoryClaimCleanupRequired === true
      ? { directoryClaimCleanupRequired: true }
      : {}),
    ...(value.identityCleanupCompleted === true
      ? { identityCleanupCompleted: true }
      : {}),
    ...(value.identityCleanupManualRequired === true
      ? { identityCleanupManualRequired: true }
      : {}),
    ...(value.identityMutationAttempted === true
      ? { identityMutationAttempted: true }
      : {}),
    ...(typeof value.acceptanceLockExpiresAt === 'string'
      ? { acceptanceLockExpiresAt: value.acceptanceLockExpiresAt }
      : {}),
    version: value.version,
    expiresAt: value.expiresAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    lastSentAt: typeof value.lastSentAt === 'string' ? value.lastSentAt : undefined,
    acceptedAt: typeof value.acceptedAt === 'string' ? value.acceptedAt : undefined,
    failureMessage: typeof value.failureMessage === 'string' ? value.failureMessage : undefined,
  }
}

function requireInvitationStatus(value: unknown): WorkspaceInvitationStatus {
  if (
    value === 'provisioning' ||
    value === 'pending' ||
    value === 'delivery-failed' ||
    value === 'expired' ||
    value === 'revoked' ||
    value === 'accepted'
  ) {
    return value
  }

  throw invalidWorkspaceDataError()
}

function requireInvitationDeliveryStatus(value: unknown): WorkspaceInvitationDeliveryStatus {
  if (value === 'pending' || value === 'sent' || value === 'failed' || value === 'not-required') {
    return value
  }

  throw invalidWorkspaceDataError()
}

function requireIdentityOwnership(value: unknown): WorkspaceIdentityOwnership {
  if (value === 'workspace-created' || value === 'pre-existing' || value === 'ambiguous') {
    return value
  }

  throw invalidWorkspaceDataError()
}

function toMemberItem(
  workspaceId: string,
  member: WorkspaceMember,
  identityOwnership?: WorkspaceIdentityOwnership,
) {
  return {
    workspaceId,
    recordKey: createMemberRecordKey(member.memberKey),
    entryType: 'workspace-member',
    id: member.memberKey,
    memberKey: member.memberKey,
    email: member.email,
    ...(member.name ? { name: member.name } : {}),
    role: member.role,
    status: member.status,
    version: member.version,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
    ...(member.deactivatedAt ? { deactivatedAt: member.deactivatedAt } : {}),
    ...(identityOwnership ? { identityOwnership } : {}),
  }
}

function toInvitationItem(workspaceId: string, invitation: WorkspaceInvitation) {
  return {
    workspaceId,
    recordKey: createInvitationRecordKey(invitation.id),
    entryType: 'workspace-invitation',
    id: invitation.id,
    email: invitation.email,
    ...(invitation.name ? { name: invitation.name } : {}),
    role: invitation.role,
    status: invitation.status,
    deliveryStatus: invitation.deliveryStatus,
    identityOwnership: invitation.identityOwnership,
    ...(invitation.identityLifecycleVersion === WORKSPACE_IDENTITY_LIFECYCLE_VERSION
      ? { identityLifecycleVersion: WORKSPACE_IDENTITY_LIFECYCLE_VERSION }
      : {}),
    ...(invitation.cognitoIdentityId ? { cognitoIdentityId: invitation.cognitoIdentityId } : {}),
    ...(invitation.cognitoUsername ? { cognitoUsername: invitation.cognitoUsername } : {}),
    ...(invitation.directoryClaimCleanupRequired
      ? { directoryClaimCleanupRequired: true }
      : {}),
    ...(invitation.identityCleanupCompleted
      ? { identityCleanupCompleted: true }
      : {}),
    ...(invitation.identityCleanupManualRequired
      ? { identityCleanupManualRequired: true }
      : {}),
    ...(invitation.identityMutationAttempted
      ? { identityMutationAttempted: true }
      : {}),
    ...(invitation.acceptanceLockExpiresAt
      ? { acceptanceLockExpiresAt: invitation.acceptanceLockExpiresAt }
      : {}),
    version: invitation.version,
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt,
    updatedAt: invitation.updatedAt,
    ...(invitation.lastSentAt ? { lastSentAt: invitation.lastSentAt } : {}),
    ...(invitation.acceptedAt ? { acceptedAt: invitation.acceptedAt } : {}),
    ...(invitation.failureMessage ? { failureMessage: invitation.failureMessage } : {}),
  }
}

function applyInvitationChanges(
  invitation: WorkspaceInvitation,
  changes: Partial<WorkspaceInvitation>,
  now: Date,
): WorkspaceInvitation {
  return {
    ...invitation,
    ...changes,
    id: invitation.id,
    email: invitation.email,
    version: invitation.version + 1,
    createdAt: invitation.createdAt,
    updatedAt: now.toISOString(),
  }
}

function createOwnerCountUpdate(
  tableName: string,
  workspaceId: string,
  delta: number,
  nowIso: string,
) {
  return {
    TableName: tableName,
    Key: { workspaceId, recordKey: 'WORKSPACE' },
    UpdateExpression:
      'SET activeOwnerCount = activeOwnerCount + :delta, updatedAt = :now, version = version + :one',
    ConditionExpression: delta < 0
      ? 'attribute_exists(workspaceId) AND activeOwnerCount > :one'
      : 'attribute_exists(workspaceId)',
    ExpressionAttributeValues: {
      ':delta': delta,
      ':now': nowIso,
      ':one': 1,
    },
  }
}

function createPlanningRevisionMutation(
  tableName: string,
  workspaceId: string,
  expectedRevision: number,
  nowIso: string,
) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new WorkspaceAccessError(
      400,
      'InvalidPlanningRevision',
      'Planning revision must be a non-negative safe integer.',
    )
  }
  return {
    Put: {
      TableName: tableName,
      Item: {
        workspaceId,
        recordKey: 'META',
        entryType: 'planning-meta',
        schemaVersion: PLANNING_SCHEMA_VERSION,
        revision: expectedRevision + 1,
        updatedAt: nowIso,
      },
      ...(expectedRevision === 0
        ? {
            ConditionExpression:
              'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
          }
        : {
            ConditionExpression: '#revision = :expectedPlanningRevision',
            ExpressionAttributeNames: { '#revision': 'revision' },
            ExpressionAttributeValues: { ':expectedPlanningRevision': expectedRevision },
          }),
    },
  }
}

function isTransactionConditionalFailureAt(error: unknown, index: number) {
  if (!isRecord(error) || !Array.isArray(error.CancellationReasons)) return false
  const reason = error.CancellationReasons[index]
  return isRecord(reason) && reason.Code === 'ConditionalCheckFailed'
}

function invalidWorkspaceDataError() {
  return new WorkspaceAccessError(503, 'InvalidWorkspaceAccessData', 'Workspace access data is invalid.')
}

function isAwsError(error: unknown, name: string) {
  return error instanceof Error && error.name === name
}

function isConditionalTransactionCancellation(error: unknown) {
  if (!isAwsError(error, 'TransactionCanceledException')) {
    return false
  }

  const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons

  if (!Array.isArray(reasons) || reasons.length === 0) {
    return false
  }

  const reasonCodes = reasons.map((reason) => reason.Code)
  const failureCodes = reasonCodes.filter((code) => code !== 'None')

  return reasonCodes.every((code) => typeof code === 'string') &&
    failureCodes.length > 0 &&
    failureCodes.every((code) => code === 'ConditionalCheckFailed')
}

function toWorkspaceAccessError(error: unknown) {
  if (error instanceof WorkspaceAccessError) {
    return error
  }

  if (isAwsError(error, 'ResourceNotFoundException')) {
    return new WorkspaceAccessError(
      503,
      'WorkspaceAccessNotInitialized',
      'Workspace access data is not initialized.',
      { cause: error },
    )
  }

  if (isAwsError(error, 'ConditionalCheckFailedException') || isConditionalTransactionCancellation(error)) {
    return new WorkspaceAccessError(
      409,
      'WorkspaceTransactionConflict',
      'Workspace access data changed concurrently.',
      { cause: error },
    )
  }

  return new WorkspaceAccessError(
    502,
    'WorkspaceAccessUnavailable',
    error instanceof Error ? error.message : 'Workspace access data is unavailable.',
    { cause: error },
  )
}

async function ensureWorkspaceAccessTable(tableName: string, dynamoDbClient: DynamoDBClient) {
  try {
    const response = await dynamoDbClient.send(new DescribeTableCommand({ TableName: tableName }))

    if (!isWorkspaceAccessTable(response.Table)) {
      throw new WorkspaceAccessError(
        503,
        'InvalidWorkspaceAccessTable',
        'Workspace access table has an invalid key schema.',
      )
    }
  } catch (error) {
    if (!isAwsError(error, 'ResourceNotFoundException')) {
      throw toWorkspaceAccessError(error)
    }

    await dynamoDbClient.send(new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [
        { AttributeName: 'workspaceId', AttributeType: 'S' },
        { AttributeName: 'recordKey', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'workspaceId', KeyType: 'HASH' },
        { AttributeName: 'recordKey', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }))
  }
}

function isWorkspaceAccessTable(table: TableDescription | undefined) {
  const hashKey = table?.KeySchema?.find((key) => key.KeyType === 'HASH')?.AttributeName
  const rangeKey = table?.KeySchema?.find((key) => key.KeyType === 'RANGE')?.AttributeName
  return hashKey === 'workspaceId' && rangeKey === 'recordKey'
}
