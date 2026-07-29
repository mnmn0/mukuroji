import {
  loadServerConfig,
} from '../../../../infrastructure/config/server-config'
import {
  createDynamoDbClient as createConfiguredDynamoDbClient,
  createWorkspaceSearchWriterDynamoDbDocumentClient,
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
  MutationAuditEventInput,
} from '../../../audit'
import {
  createWebhookGrantCleanupDirectoryId,
  createWebhookGrantCleanupEntryKey,
  createWebhookGrantCleanupItem,
  createWebhookMemberAuthorizationKey,
  createWebhookProjectAuthorizationSortKey,
  createWebhookResourceAuthorizationKey,
  createWebhookTeamAuthorizationSortKey,
  createWebhookTeamGrantDirectoryId,
  createWebhookTeamGrantEntryKey,
  createWebhookTeamGrantItem,
} from '../../../developer-platform'
import type {
  WorkspaceMemberStatus,
} from '../../../workspace-access'
import {
  ProjectDataError,
} from '../../project-data-error'
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
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
  PLANNING_SCHEMA_VERSION,
} from '@mukuroji/contracts'

/**
 * プロジェクトごとの権限ロールです。
 */
export type ProjectRole = 'manager' | 'member' | 'viewer'

/**
 * active project と現在ユーザーの role を 1 directory read で返す行です。
 */
export type ProjectAccessEntry = {
  /**
   * active project ID です。
   */
  projectId: string
  /**
   * 現在ユーザーに割り当てられた project role です。
   */
  role?: ProjectRole
}

/**
 * project 作成者を manager として登録するための context です。
 */
export type ProjectCreatorContext = {
  /**
   * Cognito user を正規化した member key です。
   */
  userKey: string
  /**
   * project manager row 作成と競合させる Workspace member version です。
   */
  workspaceMemberVersion: number
}

/** Project role mutation と直列化する Workspace member generation です。 */
export type WorkspaceMemberAuthorizationGeneration =
  | {
    /** 読み込み時点で Workspace member row が存在することを表します。 */
    exists: true
    /** 読み込み時点の member version です。 */
    version: number
    /** 読み込み時点の lifecycle status です。 */
    status: WorkspaceMemberStatus
  }
  | {
    /** 読み込み時点で Workspace member row が存在しないことを表します。 */
    exists: false
  }

/**
 * サイドバー上のプロジェクトを識別しやすくする表示色です。
 */
type ProjectTone = 'blue' | 'purple' | 'green' | 'yellow'

/**
 * DynamoDB に保存する team directory item です。
 */
type ProjectDirectoryTeamItem = {
  /**
   * ユーザーごとの directory partition key です。
   */
  directoryId: string
  /**
   * チームとプロジェクトを並べ替える sort key です。
   */
  entryKey: string
  /**
   * item 種別です。
   */
  entryType: 'team'
  /**
   * Webhook authorization GSI の resource partition key です。
   */
  webhookAuthorizationKey?: string
  /**
   * Webhook authorization GSI の Team sort key です。
   */
  webhookAuthorizationSortKey?: string
  /**
   * 所属チーム ID です。
   */
  teamId: string
  /**
   * チームの表示順です。
   */
  teamSortOrder: number
  /**
   * 日本語表示名です。
   */
  nameJa: string
  /**
   * 英語表示名です。
   */
  nameEn: string
  /**
   * チーム配下を初期展開するかどうかです。
   */
  expanded?: boolean
  /**
   * アーカイブ済みの場合に設定する ISO 8601 timestamp です。
   */
  archivedAt?: string
}

/**
 * DynamoDB に保存する project directory item です。
 */
type ProjectDirectoryProjectItem = {
  /**
   * ユーザーごとの directory partition key です。
   */
  directoryId: string
  /**
   * チームとプロジェクトを並べ替える sort key です。
   */
  entryKey: string
  /**
   * item 種別です。
   */
  entryType: 'project'
  /**
   * Webhook authorization GSI の resource partition key です。
   */
  webhookAuthorizationKey?: string
  /**
   * Webhook authorization GSI の Project sort key です。
   */
  webhookAuthorizationSortKey?: string
  /**
   * 所属チーム ID です。
   */
  teamId: string
  /**
   * チームの表示順です。
   */
  teamSortOrder: number
  /**
   * 日本語表示名です。
   */
  nameJa: string
  /**
   * 英語表示名です。
   */
  nameEn: string
  /**
   * プロジェクト ID です。
   */
  projectId: string
  /**
   * チーム内のプロジェクト表示順です。
   */
  projectSortOrder: number
  /**
   * サイドバー上のプロジェクト表示色です。
   */
  tone?: ProjectTone
  /**
   * アーカイブ済みの場合に設定する ISO 8601 timestamp です。
   */
  archivedAt?: string
}

/**
 * DynamoDB に保存する project member item です。
 */
type ProjectMemberItem = {
  /**
   * ユーザーごとの directory partition key です。
   */
  directoryId: string
  /**
   * project/member を識別する sort key です。
   */
  entryKey: string
  /**
   * item 種別です。
   */
  entryType: 'project-member'
  /**
   * Webhook authorization GSI の member partition key です。
   */
  webhookAuthorizationKey?: string
  /**
   * Webhook authorization GSI の Project sort key です。
   */
  webhookAuthorizationSortKey?: string
  /**
   * 所属プロジェクト ID です。
   */
  projectId: string
  /**
   * Cognito user を識別する正規化済み member key です。
   */
  memberKey: string
  /**
   * Cognito user のメールアドレスです。旧 item 互換の cache としてのみ利用します。
   */
  email?: string
  /**
   * 画面に表示するメンバー名です。旧 item 互換の cache としてのみ利用します。
   */
  name?: string
  /**
   * プロジェクト内の権限ロールです。
   */
  role: ProjectRole
  /**
   * member item の作成日時です。
   */
  createdAt: string
  /**
   * member item の更新日時です。
   */
  updatedAt: string
  /**
   * Retain 済み旧 row が論理削除されている場合の timestamp です。
   */
  archivedAt?: string
}

/**
 * DynamoDB に保存する team/project/member directory item です。
 */
type ProjectDirectoryItem = ProjectDirectoryTeamItem | ProjectDirectoryProjectItem | ProjectMemberItem

/** Webhook grant から強整合確認する Team / Project source locator です。 */
type ProjectWebhookGrantSource = {
  /** Grant が対象にする Team ID です。 */
  teamId: string
  /** Team source row の base-table sort key です。 */
  teamSourceEntryKey: string
  /** Project source row の base-table sort key です。 */
  projectSourceEntryKey: string
}

/**
 * サイドバーに表示するプロジェクト行です。
 */
export type ProjectDirectoryProjectResponse = {
  /**
   * タスク一覧の projectId として使う一意な ID です。
   */
  id: string
  /**
   * サイドバーと画面タイトルに表示するプロジェクト名です。
   */
  name: string
  /**
   * サイドバー上のプロジェクトアイコン色です。
   */
  tone?: ProjectTone
}

/**
 * サイドバーに表示するチーム行です。
 */
export type ProjectDirectoryTeamResponse = {
  /**
   * チームを識別する一意な ID です。
   */
  id: string
  /**
   * サイドバーに表示するチーム名です。
   */
  name: string
  /**
   * 初期表示時にチーム配下を展開するかどうかです。
   */
  expanded: boolean
  /**
   * チームに紐づくプロジェクト一覧です。
   */
  projects: ProjectDirectoryProjectResponse[]
}

/**
 * チーム/プロジェクト一覧 API が返す response body です。
 */
export type ProjectDirectoryResponse = {
  /**
   * DB に登録されているチームとプロジェクトの階層です。
   */
  teams: ProjectDirectoryTeamResponse[]
}

/**
 * チーム作成 API が受け取る request body です。
 */
export type CreateTeamRequestBody = {
  /**
   * locale 非依存で扱うチーム名です。
   */
  name?: unknown
  /**
   * 日本語表示名です。
   */
  nameJa?: unknown
  /**
   * 英語表示名です。
   */
  nameEn?: unknown
  /**
   * 初期表示時にチーム配下を展開するかどうかです。
   */
  expanded?: unknown
}

/**
 * チーム作成 API が返す response body です。
 */
export type CreateTeamResponse = {
  /**
   * 作成したチーム行です。
   */
  team: ProjectDirectoryTeamResponse
}

/**
 * プロジェクト作成 API が受け取る request body です。
 */
export type CreateProjectRequestBody = {
  /** Internal template application が response-loss retry 間で固定する Project ID です。 */
  idempotencyResourceId?: unknown
  /**
   * locale 非依存で扱うプロジェクト名です。
   */
  name?: unknown
  /**
   * 日本語表示名です。
   */
  nameJa?: unknown
  /**
   * 英語表示名です。
   */
  nameEn?: unknown
  /**
   * サイドバー上のプロジェクト表示色です。
   */
  tone?: unknown
}

/**
 * プロジェクト作成 API が返す response body です。
 */
export type CreateProjectResponse = {
  /**
   * 作成したプロジェクト行です。
   */
  project: ProjectDirectoryProjectResponse
}

/**
 * チームアーカイブ API が返す response body です。
 */
export type ArchiveTeamResponse = {
  /**
   * アーカイブしたチーム ID です。
   */
  teamId: string
  /**
   * アーカイブ日時の ISO 8601 timestamp です。
   */
  archivedAt: string
}

/**
 * プロジェクトアーカイブ API が返す response body です。
 */
export type ArchiveProjectResponse = {
  /**
   * プロジェクトが所属していたチーム ID です。
   */
  teamId: string
  /**
   * アーカイブしたプロジェクト ID です。
   */
  projectId: string
  /**
   * アーカイブ日時の ISO 8601 timestamp です。
   */
  archivedAt: string
}

/**
 * プロジェクト権限管理画面に表示する member 行です。
 */
export type ProjectMemberResponseItem = {
  /**
   * 正規化済み member key です。
   */
  id: string
  /**
   * Cognito user のメールアドレスです。
   */
  email: string
  /**
   * Cognito user pool 内の username です。
   */
  username?: string
  /**
   * 画面に表示するメンバー名です。
   */
  name?: string
  /**
   * Cognito user が有効かどうかです。
   */
  enabled?: boolean
  /**
   * Cognito user status です。
   */
  status?: string
  /**
   * Workspace membership の利用状態です。
   */
  workspaceStatus?: WorkspaceMemberStatus
  /**
   * プロジェクト内の権限ロールです。
   */
  role: ProjectRole
  /**
   * member item の更新日時です。
   */
  updatedAt: string
}

/**
 * プロジェクトメンバー一覧 API が返す response body です。
 */
export type ProjectMembersResponse = {
  /**
   * 取得対象の project ID です。
   */
  projectId: string
  /**
   * DynamoDB から取得した member 一覧です。
   */
  members: ProjectMemberResponseItem[]
}

/**
 * プロジェクトメンバー更新 API が受け取る request body です。
 */
export type UpdateProjectMemberRequestBody = {
  /**
   * Cognito user を参照する ID です。
   */
  userId?: unknown
  /**
   * Cognito user のメールアドレスです。旧 client 互換で userId と同義に扱います。
   */
  email?: unknown
  /**
   * 表示名です。Cognito master 化後は保存せず無視します。
   */
  name?: unknown
  /**
   * 付与するプロジェクトロールです。
   */
  role?: unknown
}

/**
 * プロジェクトメンバー更新 API が返す response body です。
 */
export type UpdateProjectMemberResponse = {
  /**
   * 更新した member 行です。
   */
  member: ProjectMemberResponseItem
}

/**
 * プロジェクトメンバー削除 API が返す response body です。
 */
export type RemoveProjectMemberResponse = {
  /**
   * 取得対象の project ID です。
   */
  projectId: string
  /**
   * 削除した member key です。
   */
  memberId: string
}

/**
 * API handler から利用する team/project directory client の最小 interface です。
 */
export type ProjectDirectoryClient = {
  /**
   * DynamoDB から sidebar 用の team/project 階層を取得します。
   */
  getProjectDirectory(
    directoryId: string,
    locale: Locale,
    consistentRead?: boolean,
  ): Promise<ProjectDirectoryResponse>
  /**
   * active project と指定 member の role を 1 directory read で取得します。
   */
  getProjectAccess(
    directoryId: string,
    projectId: string,
    memberKey: string,
  ): Promise<ProjectAccessEntry | undefined>
  /**
   * active project と指定 member の role を 1 directory read で取得します。
   */
  getProjectAccessList(directoryId: string, memberKey: string): Promise<ProjectAccessEntry[]>
  /**
   * ユーザーの directory に指定 project ID が含まれるかどうかを判定します。
   */
  hasProjectAccess(directoryId: string, projectId: string): Promise<boolean>
  /**
   * 指定ユーザーが持つ project role を DynamoDB から取得します。
   */
  getProjectRole(
    directoryId: string,
    projectId: string,
    memberKey: string,
  ): Promise<ProjectRole | undefined>
  /**
   * DynamoDB から project member 一覧を取得します。
   */
  getProjectMembers(directoryId: string, projectId: string): Promise<ProjectMembersResponse>
  /**
   * DynamoDB の project member role を作成または更新します。
   */
  updateProjectMember(
    directoryId: string,
    projectId: string,
    memberKey: string,
    input: UpdateProjectMemberRequestBody,
    expectedWorkspaceMemberVersion: number,
    auditContext?: MutationAuditContext,
  ): Promise<UpdateProjectMemberResponse>
  /**
   * DynamoDB から project member role を削除します。
   */
  removeProjectMember(
    directoryId: string,
    projectId: string,
    memberKey: string,
    auditContext?: MutationAuditContext,
    expectedWorkspaceMemberGeneration?: WorkspaceMemberAuthorizationGeneration,
  ): Promise<RemoveProjectMemberResponse>
  /**
   * DynamoDB にチームを作成します。
   */
  createTeam(
    directoryId: string,
    input: CreateTeamRequestBody,
    auditContext?: MutationAuditContext,
  ): Promise<CreateTeamResponse>
  /**
   * DynamoDB に指定チーム配下のプロジェクトを作成します。
   */
  createProject(
    directoryId: string,
    teamId: string,
    input: CreateProjectRequestBody,
    creator: ProjectCreatorContext,
    auditContext?: MutationAuditContext,
    completionTransactItems?: NonNullable<TransactWriteCommandInput['TransactItems']>,
  ): Promise<CreateProjectResponse>
  /**
   * DynamoDB 上のチームをアーカイブします。
   */
  archiveTeam(
    directoryId: string,
    teamId: string,
    auditContext: MutationAuditContext | undefined,
    expectedPlanningRevision: number,
  ): Promise<ArchiveTeamResponse>
  /**
   * DynamoDB 上のチーム配下プロジェクトをアーカイブします。
   */
  archiveProject(
    directoryId: string,
    teamId: string,
    projectId: string,
    auditContext: MutationAuditContext | undefined,
    expectedPlanningRevision: number,
  ): Promise<ArchiveProjectResponse>
}

/**
 * チーム/プロジェクト階層の表示 locale です。
 */
export type Locale = 'ja' | 'en'

/** Numeric ordering used when comparing effective Project roles. */
export const projectRoleWeights = {
  viewer: 1,
  member: 2,
  manager: 3,
} as const satisfies Record<ProjectRole, number>

/** Writer-fence ConditionCheck を除く application action 数の上限です。 */
const DYNAMODB_TRANSACTION_MAX_ACTIONS = 99

function createOptionalAuditTransactItems(
  tableName: string | undefined,
  context: MutationAuditContext | undefined,
  input: MutationAuditEventInput,
) {
  const item = createMutationAuditEventPut(tableName, context, input)

  return item ? [item] : []
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

/**
 * DynamoDB の team/project directory item を読み取る client です。
 */
export class DynamoDbProjectDirectoryClient {
  /**
   * team/project directory item を保存する DynamoDB table 名です。
   */
  private readonly tableName: string
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
  /**
   * project member mutation と競合させる Workspace access table 名です。
   */
  private readonly workspaceAccessTableName: string
  /**
   * Team / Project archive と直列化する Planning table 名です。
   */
  private readonly planningTableName: string

  constructor(
    tableName =
      getEnv('MUKUROJI_PROJECT_DIRECTORY_TABLE') ??
      getEnv('PROJECT_DIRECTORY_TABLE_NAME') ??
      'mukuroji-project-directory-local',
    documentClient = createDynamoDbDocumentClient(),
    dynamoDbClient?: DynamoDBClient,
    bootstrapLocalTables = dynamoDbClient === undefined && shouldBootstrapLocalDynamoDb(),
    auditTableName = getConfiguredAuditTableName(),
    workspaceAccessTableName =
      getEnv('MUKUROJI_WORKSPACE_ACCESS_TABLE') ??
      getEnv('WORKSPACE_ACCESS_TABLE_NAME') ??
      'mukuroji-workspace-access-local',
    planningTableName = getEnv('PLANNING_TABLE_NAME') ?? 'mukuroji-planning-local',
  ) {
    this.tableName = tableName
    this.documentClient = documentClient
    this.dynamoDbClient = dynamoDbClient ?? createDynamoDbClient()
    this.bootstrapLocalTables = bootstrapLocalTables
    this.auditTableName = auditTableName
    this.workspaceAccessTableName = workspaceAccessTableName
    this.planningTableName = planningTableName
  }

  /**
   * DynamoDB から sidebar 用の team/project 階層を取得します。
   */
  async getProjectDirectory(
    directoryId: string,
    locale: Locale,
    consistentRead = false,
  ) {
    try {
      const items = await this.queryDirectoryItems(directoryId, true, consistentRead)

      return {
        teams: toProjectDirectoryResponse(items, locale, directoryId),
      } satisfies ProjectDirectoryResponse
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * active project と指定 member の role を 1 directory read で取得します。
   */
  async getProjectAccess(directoryId: string, projectId: string, memberKey: string) {
    try {
      const normalizedMemberKey = normalizeProjectMemberKey(memberKey)
      const items = await this.readValidDirectoryItems(directoryId, true)

      return toProjectAccessEntries(items, normalizedMemberKey).find((access) => {
        return access.projectId === projectId
      })
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * active project と指定 member の role を 1 directory read で取得します。
   */
  async getProjectAccessList(directoryId: string, memberKey: string) {
    try {
      const normalizedMemberKey = normalizeProjectMemberKey(memberKey)
      const items = await this.readValidDirectoryItems(directoryId, true)

      return toProjectAccessEntries(items, normalizedMemberKey)
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * ユーザーの directory に指定 project ID が含まれるかどうかを判定します。
   */
  async hasProjectAccess(directoryId: string, projectId: string) {
    try {
      return await this.getProjectAccess(
        directoryId,
        projectId,
        'project-access-check@example.invalid',
      ) !== undefined
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * ユーザーの project role を取得します。
   */
  async getProjectRole(directoryId: string, projectId: string, memberKey: string) {
    try {
      return (await this.getProjectAccess(directoryId, projectId, memberKey))?.role
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB から project member 一覧を取得します。
   */
  async getProjectMembers(directoryId: string, projectId: string) {
    try {
      const items = await this.readValidDirectoryItems(directoryId)
      this.requireActiveProject(items, projectId)
      const members = items
        .filter((item): item is ProjectMemberItem =>
          item.entryType === 'project-member' &&
          item.projectId === projectId &&
          isActiveDirectoryItem(item)
        )
        .sort(compareProjectMemberItems)
        .map(toProjectMemberResponseItem)

      return {
        projectId,
        members,
      } satisfies ProjectMembersResponse
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB の project member role を作成または更新します。
   */
  async updateProjectMember(
    directoryId: string,
    projectId: string,
    memberKey: string,
    input: UpdateProjectMemberRequestBody,
    expectedWorkspaceMemberVersion: number,
    auditContext?: MutationAuditContext,
  ) {
    await this.ensureLocalAuditTable()
    const normalizedMemberKey = normalizeProjectMemberKey(memberKey)
    const email = readProjectMemberEmail(input.email, normalizedMemberKey)
    const name = readOptionalProjectMemberName(input.name)
    const role = readProjectRole(input.role)
    let existingMemberExpected = false
    let managerGuarded = false

    try {
      const items = await this.readValidDirectoryItems(directoryId, true)
      this.requireActiveProject(items, projectId)
      const projectGrantSources = getActiveProjectGrantSources(items, projectId)
      const existingMember = items.find((item): item is ProjectMemberItem =>
        item.entryType === 'project-member' &&
        item.projectId === projectId &&
        item.memberKey === normalizedMemberKey &&
        isActiveDirectoryItem(item),
      )
      existingMemberExpected = existingMember !== undefined

      const guardManager = (
        existingMember?.role === 'manager' &&
        role !== 'manager'
      )
        ? this.requireAnotherProjectManager(items, projectId, normalizedMemberKey)
        : undefined
      managerGuarded = guardManager !== undefined

      const updatedAt = new Date().toISOString()
      const item: ProjectMemberItem = {
        directoryId,
        entryKey: createProjectMemberEntryKey(projectId, normalizedMemberKey),
        entryType: 'project-member',
        webhookAuthorizationKey: createWebhookMemberAuthorizationKey(
          directoryId,
          normalizedMemberKey,
        ),
        webhookAuthorizationSortKey: createWebhookProjectAuthorizationSortKey(projectId),
        projectId,
        memberKey: normalizedMemberKey,
        email,
        name,
        role,
        createdAt: existingMember?.createdAt ?? updatedAt,
        updatedAt,
      }
      const auditPut = createMutationAuditEventPut(this.auditTableName, auditContext, {
        directoryId,
        eventType: existingMember ? 'member.updated' : 'member.added',
        entityType: 'member',
        entityId: `${projectId}/${normalizedMemberKey}`,
        action: existingMember ? 'updated' : 'created',
        occurredAt: updatedAt,
        changes: createAuditFieldChanges(existingMember, item, ['email', 'name', 'role']),
        metadata: { projectId, memberKey: normalizedMemberKey },
      })
      const memberPut = {
        TableName: this.tableName,
        Item: item,
        ConditionExpression: existingMember
          ? '#updatedAt = :expectedUpdatedAt'
          : 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
        ...(existingMember
          ? {
              ExpressionAttributeNames: { '#updatedAt': 'updatedAt' },
              ExpressionAttributeValues: { ':expectedUpdatedAt': existingMember.updatedAt },
            }
          : {}),
      }

      const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = []

      if (guardManager) {
        transactItems.push({
          ConditionCheck: this.createProjectManagerConditionCheck(directoryId, guardManager.entryKey),
        })
      }

      transactItems.push(
        {
          Put: memberPut,
        },
        {
          Update: this.createActiveWorkspaceMemberVersionUpdate(
            directoryId,
            normalizedMemberKey,
            expectedWorkspaceMemberVersion,
            updatedAt,
          ),
        },
        ...projectGrantSources.flatMap((source) =>
          createWebhookTeamGrantTransactItems(
            this.tableName,
            directoryId,
            projectId,
            normalizedMemberKey,
            source,
          )
        ),
        ...(auditPut ? [auditPut] : []),
      )
      requireDynamoDbTransactionCapacity(transactItems)
      const workspaceUpdateIndex = guardManager ? 2 : 1

      try {
        await this.documentClient.send(
          new TransactWriteCommand({ TransactItems: transactItems }),
        )
      } catch (error) {
        if (isTransactionConditionalFailureAt(error, workspaceUpdateIndex)) {
          await this.requireUnchangedActiveWorkspaceMember(
            directoryId,
            normalizedMemberKey,
            expectedWorkspaceMemberVersion,
          )
        }

        if (
          guardManager &&
          (
            isTransactionConditionalFailureAt(error, 0) ||
            isTransactionConditionalFailureAt(error, 1)
          )
        ) {
          await this.throwProjectManagerTransactionCancellationResult(
            directoryId,
            projectId,
            normalizedMemberKey,
            error,
          )
        }

        throw error
      }

      return {
        member: toProjectMemberResponseItem(item),
      } satisfies UpdateProjectMemberResponse
    } catch (error) {
      if (!managerGuarded && isTransactionConditionalFailureAt(error, 0)) {
        await this.throwUpdateProjectMemberTransactionCancellationResult(
          directoryId,
          projectId,
          normalizedMemberKey,
          existingMemberExpected,
          error,
        )
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
   * DynamoDB から project member role を削除します。
   */
  async removeProjectMember(
    directoryId: string,
    projectId: string,
    memberKey: string,
    auditContext?: MutationAuditContext,
    expectedWorkspaceMemberGeneration?: WorkspaceMemberAuthorizationGeneration,
  ) {
    await this.ensureLocalAuditTable()
    const normalizedMemberKey = normalizeProjectMemberKey(memberKey)
    let managerGuarded = false
    let workspaceAuthorizationGuardIndex: number | undefined

    try {
      const items = await this.readValidDirectoryItems(directoryId, true)
      this.requireActiveProject(items, projectId)
      const projectTeamIds = getProjectTeamIds(items, projectId)
      const member = items.find((item): item is ProjectMemberItem =>
        item.entryType === 'project-member' &&
        item.projectId === projectId &&
        item.memberKey === normalizedMemberKey &&
        isActiveDirectoryItem(item),
      )

      if (!member) {
        throw new ProjectDataError(
          404,
          'ProjectMemberNotFound',
          `Project member "${normalizedMemberKey}" was not found in project "${projectId}".`,
        )
      }

      const guardManager = member.role === 'manager'
        ? this.requireAnotherProjectManager(items, projectId, normalizedMemberKey)
        : undefined
      managerGuarded = guardManager !== undefined
      const removedAt = new Date().toISOString()
      const auditPut = createMutationAuditEventPut(this.auditTableName, auditContext, {
        directoryId,
        eventType: 'member.removed',
        entityType: 'member',
        entityId: `${projectId}/${normalizedMemberKey}`,
        action: 'deleted',
        occurredAt: removedAt,
        changes: createAuditFieldChanges(member, undefined, ['email', 'name', 'role']),
        metadata: { projectId, memberKey: normalizedMemberKey },
      })
      const memberDelete = {
        TableName: this.tableName,
        Key: {
          directoryId,
          entryKey: member.entryKey,
        },
        ConditionExpression:
          'attribute_exists(directoryId) AND attribute_exists(entryKey) AND #updatedAt = :expectedUpdatedAt AND #role = :expectedRole',
        ExpressionAttributeNames: {
          '#updatedAt': 'updatedAt',
          '#role': 'role',
        },
        ExpressionAttributeValues: {
          ':expectedUpdatedAt': member.updatedAt,
          ':expectedRole': member.role,
        },
      }
      const grantDeletes = projectTeamIds.map((teamId) => {
        return {
          Delete: {
            TableName: this.tableName,
            Key: {
              directoryId: createWebhookTeamGrantDirectoryId(
                directoryId,
                normalizedMemberKey,
              ),
              entryKey: createWebhookTeamGrantEntryKey(teamId, projectId),
            },
          },
        }
      })
      const workspaceAuthorizationItem = expectedWorkspaceMemberGeneration === undefined
        ? undefined
        : this.createWorkspaceMemberAuthorizationTransactionItem(
            directoryId,
            normalizedMemberKey,
            expectedWorkspaceMemberGeneration,
            removedAt,
          )
      const cleanupLocatorDeletes = projectTeamIds.map((teamId) => ({
        Delete: {
          TableName: this.tableName,
          Key: {
            directoryId: createWebhookGrantCleanupDirectoryId(
              directoryId,
              teamId,
            ),
            entryKey: createWebhookGrantCleanupEntryKey(
              projectId,
              normalizedMemberKey,
            ),
          },
        },
      }))

      const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
        ...(guardManager
          ? [{
              ConditionCheck: this.createProjectManagerConditionCheck(
                directoryId,
                guardManager.entryKey,
              ),
            }]
          : []),
        {
          Delete: memberDelete,
        },
        ...(workspaceAuthorizationItem === undefined ? [] : [workspaceAuthorizationItem]),
        ...grantDeletes,
        ...cleanupLocatorDeletes,
        ...(auditPut ? [auditPut] : []),
      ]
      workspaceAuthorizationGuardIndex = workspaceAuthorizationItem === undefined
        ? undefined
        : guardManager
          ? 2
          : 1
      requireDynamoDbTransactionCapacity(transactItems)
      await this.documentClient.send(
        new TransactWriteCommand({ TransactItems: transactItems }),
      )

      return {
        projectId,
        memberId: normalizedMemberKey,
      } satisfies RemoveProjectMemberResponse
    } catch (error) {
      if (
        workspaceAuthorizationGuardIndex !== undefined &&
        expectedWorkspaceMemberGeneration !== undefined &&
        isTransactionConditionalFailureAt(error, workspaceAuthorizationGuardIndex)
      ) {
        await this.requireUnchangedWorkspaceMemberGeneration(
          directoryId,
          normalizedMemberKey,
          expectedWorkspaceMemberGeneration,
        )
      }
      if (
        (managerGuarded && (
          isTransactionConditionalFailureAt(error, 0) ||
          isTransactionConditionalFailureAt(error, 1)
        )) ||
        (!managerGuarded && isTransactionConditionalFailureAt(error, 0))
      ) {
        await this.throwProjectManagerTransactionCancellationResult(
          directoryId,
          projectId,
          normalizedMemberKey,
          error,
        )
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
   * DynamoDB にチームを作成します。
   */
  async createTeam(
    directoryId: string,
    input: CreateTeamRequestBody,
    auditContext?: MutationAuditContext,
  ) {
    await this.ensureLocalAuditTable()
    const names = readLocalizedNames(input)

    try {
      const items = await this.readValidDirectoryItems(directoryId)
      const teamId = createUniqueResourceId(
        names.nameJa,
        items
          .filter((item) => item.entryType === 'team')
          .map((item) => item.teamId),
      )
      const teamSortOrder =
        Math.max(0, ...items.filter((item) => item.entryType === 'team').map((item) => item.teamSortOrder)) +
        10
      const item: ProjectDirectoryItem = {
        directoryId,
        entryKey: createTeamEntryKey(teamSortOrder, teamId),
        entryType: 'team',
        webhookAuthorizationKey: createWebhookResourceAuthorizationKey(directoryId),
        webhookAuthorizationSortKey: createWebhookTeamAuthorizationSortKey(teamId),
        teamId,
        teamSortOrder,
        nameJa: names.nameJa,
        nameEn: names.nameEn,
        expanded: typeof input.expanded === 'boolean' ? input.expanded : true,
      }

      const statePut = {
        Put: {
          TableName: this.tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
        },
      }
      const auditPut = createMutationAuditEventPut(this.auditTableName, auditContext, {
        directoryId,
        eventType: 'project.created',
        entityType: 'project',
        entityId: `team/${teamId}`,
        action: 'created',
        changes: createAuditFieldChanges(undefined, {
          kind: 'team',
          teamId,
          name: names.nameJa,
          expanded: item.expanded ?? false,
        }),
        metadata: { kind: 'team', teamId },
      })

      await this.documentClient.send(
        new TransactWriteCommand({
          TransactItems: [statePut, ...(auditPut ? [auditPut] : [])],
        }),
      )

      return {
        team: {
          id: item.teamId,
          name: item.nameJa,
          expanded: item.expanded ?? false,
          projects: [],
        },
      } satisfies CreateTeamResponse
    } catch (error) {
      if (
        isAwsNamedError(error, 'TransactionCanceledException') &&
        hasTransactionConditionalFailure(error)
      ) {
        throw createProjectDataConflictError()
      }

      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB にチーム配下のプロジェクトを作成します。
   */
  async createProject(
    directoryId: string,
    teamId: string,
    input: CreateProjectRequestBody,
    creator: ProjectCreatorContext,
    auditContext?: MutationAuditContext,
    completionTransactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [],
  ) {
    await this.ensureLocalAuditTable()
    const names = readLocalizedNames(input)
    const tone = readProjectTone(input.tone)
    const idempotencyResourceId = readIdempotencyResourceId(input.idempotencyResourceId)
    const creatorMemberKey = normalizeProjectMemberKey(creator.userKey)

    if (!creatorMemberKey) {
      throw new ProjectDataError(
        400,
        'ProjectCreatorInvalid',
        'Project creator member key is required.',
      )
    }

    try {
      const items = await this.readValidDirectoryItems(directoryId, Boolean(idempotencyResourceId))
      const team = items.find((item): item is ProjectDirectoryTeamItem =>
        item.entryType === 'team' && item.teamId === teamId && isActiveDirectoryItem(item),
      )

      if (!team) {
        throw new ProjectDataError(404, 'TeamNotFound', `Team "${teamId}" was not found.`)
      }

      if (idempotencyResourceId) {
        const existingProject = items.find((item): item is ProjectDirectoryProjectItem =>
          item.entryType === 'project' && item.projectId === idempotencyResourceId,
        )
        if (existingProject) {
          if (
            existingProject.teamId !== teamId ||
            existingProject.nameJa !== names.nameJa ||
            existingProject.nameEn !== names.nameEn ||
            (existingProject.tone ?? 'blue') !== tone ||
            existingProject.archivedAt
          ) {
            throw createProjectDataConflictError()
          }
          if (completionTransactItems.length > 0) {
            try {
              await this.documentClient.send(new TransactWriteCommand({
                TransactItems: [
                  {
                    ConditionCheck: {
                      TableName: this.tableName,
                      Key: { directoryId, entryKey: existingProject.entryKey },
                      ConditionExpression:
                        '#entryType = :entryType AND #projectId = :projectId AND #teamId = :teamId AND #nameJa = :nameJa AND #nameEn = :nameEn AND #tone = :tone AND attribute_not_exists(#archivedAt)',
                      ExpressionAttributeNames: {
                        '#archivedAt': 'archivedAt',
                        '#entryType': 'entryType',
                        '#nameEn': 'nameEn',
                        '#nameJa': 'nameJa',
                        '#projectId': 'projectId',
                        '#teamId': 'teamId',
                        '#tone': 'tone',
                      },
                      ExpressionAttributeValues: {
                        ':entryType': 'project',
                        ':nameEn': names.nameEn,
                        ':nameJa': names.nameJa,
                        ':projectId': idempotencyResourceId,
                        ':teamId': teamId,
                        ':tone': tone,
                      },
                    },
                  },
                  ...completionTransactItems,
                ],
              }))
            } catch (error) {
              if (hasTransactionConditionalFailure(error)) {
                throw createProjectDataConflictError()
              }
              throw error
            }
          }
          return {
            project: {
              id: existingProject.projectId,
              name: existingProject.nameJa,
              tone: existingProject.tone,
            },
          } satisfies CreateProjectResponse
        }
      }

      const projectId = idempotencyResourceId ?? createUniqueResourceId(
        names.nameJa,
        items
          .filter((item): item is ProjectDirectoryProjectItem =>
            item.entryType === 'project'
          )
          .flatMap((item) => (item.projectId ? [item.projectId] : [])),
      )
      const projectSortOrder =
        Math.max(
          0,
          ...items
            .filter((item): item is ProjectDirectoryProjectItem =>
              item.entryType === 'project' && item.teamId === teamId
            )
            .map((item) => item.projectSortOrder ?? 0),
        ) + 10
      const item: ProjectDirectoryItem = {
        directoryId,
        entryKey: createProjectEntryKey(team.teamSortOrder, projectSortOrder, projectId),
        entryType: 'project',
        webhookAuthorizationKey: createWebhookResourceAuthorizationKey(directoryId),
        webhookAuthorizationSortKey: createWebhookProjectAuthorizationSortKey(projectId),
        teamId,
        teamSortOrder: team.teamSortOrder,
        nameJa: names.nameJa,
        nameEn: names.nameEn,
        projectId,
        projectSortOrder,
        tone,
      }
      const updatedAt = new Date().toISOString()
      const creatorMemberItem: ProjectMemberItem = {
        directoryId,
        entryKey: createProjectMemberEntryKey(projectId, creatorMemberKey),
        entryType: 'project-member',
        webhookAuthorizationKey: createWebhookMemberAuthorizationKey(
          directoryId,
          creatorMemberKey,
        ),
        webhookAuthorizationSortKey: createWebhookProjectAuthorizationSortKey(projectId),
        projectId,
        memberKey: creatorMemberKey,
        email: creatorMemberKey,
        role: 'manager',
        createdAt: updatedAt,
        updatedAt,
      }

      try {
        const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
          {
            ConditionCheck: this.createActiveTeamConditionCheck(directoryId, team.entryKey),
          },
          {
            Put: {
              TableName: this.tableName,
              Item: item,
              ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: creatorMemberItem,
              ConditionExpression: 'attribute_not_exists(directoryId) AND attribute_not_exists(entryKey)',
            },
          },
          {
            Update: this.createActiveWorkspaceMemberVersionUpdate(
              directoryId,
              creatorMemberKey,
              creator.workspaceMemberVersion,
              updatedAt,
            ),
          },
          {
            Put: {
              TableName: this.tableName,
              Item: createWebhookTeamGrantItem({
                workspaceId: directoryId,
                teamId,
                projectId,
                memberKey: creatorMemberKey,
                teamSourceEntryKey: team.entryKey,
                projectSourceEntryKey: item.entryKey,
              }),
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: createWebhookGrantCleanupItem({
                workspaceId: directoryId,
                teamId,
                projectId,
                memberKey: creatorMemberKey,
              }),
            },
          },
          ...createOptionalAuditTransactItems(this.auditTableName, auditContext, {
            directoryId,
            eventType: 'project.created',
            entityType: 'project',
            entityId: projectId,
            action: 'created',
            occurredAt: updatedAt,
            changes: createAuditFieldChanges(undefined, {
              projectId,
              teamId,
              name: names.nameJa,
              tone,
              creatorMemberKey,
              creatorRole: 'manager',
            }),
            metadata: { kind: 'project', projectId, teamId },
          }),
          ...completionTransactItems,
        ]
        requireDynamoDbTransactionCapacity(transactItems)
        await this.documentClient.send(
          new TransactWriteCommand({ TransactItems: transactItems }),
        )
      } catch (error) {
        if (isTransactionConditionalFailureAt(error, 3)) {
          await this.requireUnchangedActiveWorkspaceMember(
            directoryId,
            creatorMemberKey,
            creator.workspaceMemberVersion,
          )
        }

        if (isTransactionConditionalFailureAt(error, 0)) {
          await this.throwCreateProjectTransactionCancellationResult(directoryId, teamId, error)
        }

        if (hasTransactionConditionalFailure(error)) {
          throw createProjectDataConflictError()
        }

        throw error
      }

      return {
        project: {
          id: item.projectId,
          name: item.nameJa,
          tone: item.tone,
        },
      } satisfies CreateProjectResponse
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * DynamoDB 上のチームをアーカイブします。
   */
  async archiveTeam(
    directoryId: string,
    teamId: string,
    auditContext: MutationAuditContext | undefined,
    expectedPlanningRevision: number,
  ) {
    await this.ensureLocalAuditTable()
    let planningRevisionItemIndex: number | undefined
    try {
      const items = await this.readValidDirectoryItems(directoryId)
      const team = items.find((item) =>
        item.entryType === 'team' && item.teamId === teamId && isActiveDirectoryItem(item),
      )

      if (!team) {
        throw new ProjectDataError(404, 'TeamNotFound', `Team "${teamId}" was not found.`)
      }

      const archivedAt = new Date().toISOString()

      const stateUpdate = {
        Update: {
          TableName: this.tableName,
          Key: { directoryId, entryKey: team.entryKey },
          UpdateExpression: 'SET archivedAt = :archivedAt',
          ConditionExpression:
            'attribute_exists(directoryId) AND attribute_exists(entryKey) AND attribute_not_exists(archivedAt)',
          ExpressionAttributeValues: { ':archivedAt': archivedAt },
        },
      }
      const auditItems = createOptionalAuditTransactItems(this.auditTableName, auditContext, {
        directoryId,
        eventType: 'project.archived',
        entityType: 'project',
        entityId: `team/${teamId}`,
        action: 'archived',
        occurredAt: archivedAt,
        changes: createAuditFieldChanges(team, { ...team, archivedAt }, ['archivedAt']),
        metadata: { kind: 'team', teamId },
      })
      const planningRevisionMutation = createPlanningRevisionBump(
        this.planningTableName,
        directoryId,
        expectedPlanningRevision,
        archivedAt,
      )
      planningRevisionItemIndex = 1 + auditItems.length

      await this.documentClient.send(
        new TransactWriteCommand({
          TransactItems: [stateUpdate, ...auditItems, planningRevisionMutation],
        }),
      )

      return {
        teamId,
        archivedAt,
      } satisfies ArchiveTeamResponse
    } catch (error) {
      if (isTransactionConditionalFailureAt(error, 0)) {
        await this.throwArchiveTeamTransactionCancellationResult(directoryId, teamId, error)
      }

      if (
        planningRevisionItemIndex !== undefined &&
        isTransactionConditionalFailureAt(error, planningRevisionItemIndex)
      ) {
        throw new ProjectDataError(
          409,
          'PlanningRevisionConflict',
          'Planning changed. Reload and try again.',
        )
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
   * DynamoDB 上のチーム配下プロジェクトをアーカイブします。
   */
  async archiveProject(
    directoryId: string,
    teamId: string,
    projectId: string,
    auditContext: MutationAuditContext | undefined,
    expectedPlanningRevision: number,
  ) {
    await this.ensureLocalAuditTable()
    let planningRevisionItemIndex: number | undefined
    try {
      const items = await this.readValidDirectoryItems(directoryId)
      const team = items.find((item) =>
        item.entryType === 'team' && item.teamId === teamId && isActiveDirectoryItem(item),
      )

      if (!team) {
        throw new ProjectDataError(404, 'TeamNotFound', `Team "${teamId}" was not found.`)
      }

      const project = items.find((item) =>
        item.entryType === 'project' &&
        item.teamId === teamId &&
        item.projectId === projectId &&
        isActiveDirectoryItem(item),
      )

      if (!project) {
        throw new ProjectDataError(
          404,
          'ProjectNotFound',
          `Project "${projectId}" was not found in team "${teamId}".`,
        )
      }

      const archivedAt = new Date().toISOString()

      const stateUpdate = {
        Update: {
          TableName: this.tableName,
          Key: { directoryId, entryKey: project.entryKey },
          UpdateExpression: 'SET archivedAt = :archivedAt',
          ConditionExpression:
            'attribute_exists(directoryId) AND attribute_exists(entryKey) AND attribute_not_exists(archivedAt)',
          ExpressionAttributeValues: { ':archivedAt': archivedAt },
        },
      }
      const auditItems = createOptionalAuditTransactItems(this.auditTableName, auditContext, {
        directoryId,
        eventType: 'project.archived',
        entityType: 'project',
        entityId: projectId,
        action: 'archived',
        occurredAt: archivedAt,
        changes: createAuditFieldChanges(project, { ...project, archivedAt }, ['archivedAt']),
        metadata: { kind: 'project', projectId, teamId },
      })
      const planningRevisionMutation = createPlanningRevisionBump(
        this.planningTableName,
        directoryId,
        expectedPlanningRevision,
        archivedAt,
      )
      planningRevisionItemIndex = 1 + auditItems.length

      await this.documentClient.send(
        new TransactWriteCommand({
          TransactItems: [stateUpdate, ...auditItems, planningRevisionMutation],
        }),
      )

      return {
        teamId,
        projectId,
        archivedAt,
      } satisfies ArchiveProjectResponse
    } catch (error) {
      if (isTransactionConditionalFailureAt(error, 0)) {
        await this.throwArchiveProjectTransactionCancellationResult(
          directoryId,
          teamId,
          projectId,
          error,
        )
      }


      if (
        planningRevisionItemIndex !== undefined &&
        isTransactionConditionalFailureAt(error, planningRevisionItemIndex)
      ) {
        throw new ProjectDataError(
          409,
          'PlanningRevisionConflict',
          'Planning changed. Reload and try again.',
        )
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
   * local runtime で audit table が未作成なら mutation 前に初期化します。
   */
  private async ensureLocalAuditTable() {
    await ensureConfiguredAuditTable(
      this.auditTableName,
      this.dynamoDbClient,
      this.bootstrapLocalTables,
    )
  }

  /**
   * directory partition 内の全 item を検証済み item として取得します。
   */
  private async readValidDirectoryItems(directoryId: string, consistentRead = false) {
    try {
      const items = await this.queryDirectoryItems(directoryId, true, consistentRead)

      return readProjectDirectoryItems(items, directoryId)
    } catch (error) {
      if (error instanceof ProjectDataError) {
        throw error
      }

      throw toProjectDataError(error)
    }
  }

  /**
   * 指定 project ID が active な project として存在することを検証します。
   */
  private requireActiveProject(items: ProjectDirectoryItem[], projectId: string) {
    const activeTeamIds = new Set(
      items
        .filter((item): item is ProjectDirectoryTeamItem =>
          item.entryType === 'team' && isActiveDirectoryItem(item)
        )
        .map((item) => item.teamId),
    )
    const project = items.find((item) =>
      item.entryType === 'project' &&
      item.projectId === projectId &&
      activeTeamIds.has(item.teamId) &&
      isActiveDirectoryItem(item),
    )

    if (!project) {
      throw new ProjectDataError(404, 'ProjectNotFound', `Project "${projectId}" was not found.`)
    }
  }

  /**
   * 対象 member 以外に残る manager item を取得します。
   */
  private requireAnotherProjectManager(
    items: ProjectDirectoryItem[],
    projectId: string,
    memberKey: string,
  ) {
    const manager = this.findAnotherProjectManager(items, projectId, memberKey)

    if (!manager) {
      throw this.createProjectLastManagerError()
    }

    return manager
  }

  /**
   * 対象 member 以外に残る manager item を検索します。
   */
  private findAnotherProjectManager(
    items: ProjectDirectoryItem[],
    projectId: string,
    memberKey: string,
  ) {
    return items.find((item) =>
      item.entryType === 'project-member' &&
      item.projectId === projectId &&
      item.memberKey !== memberKey &&
      item.role === 'manager' &&
      isActiveDirectoryItem(item),
    )
  }

  /**
   * project 作成 transaction 失敗後の最新状態から team archive と重複を切り分けます。
   */
  private async throwCreateProjectTransactionCancellationResult(
    directoryId: string,
    teamId: string,
    originalError: unknown,
  ): Promise<never> {
    const items = await this.readValidDirectoryItems(directoryId, true)
    const activeTeam = items.find((item) =>
      item.entryType === 'team' &&
      item.teamId === teamId &&
      isActiveDirectoryItem(item),
    )

    if (!activeTeam) {
      throw new ProjectDataError(404, 'TeamNotFound', `Team "${teamId}" was not found.`)
    }

    if (hasTransactionConditionalFailure(originalError)) {
      throw createProjectDataConflictError()
    }

    throw toProjectDataError(originalError)
  }

  /**
   * team archive transaction 失敗後の最新状態から not-found と競合を切り分けます。
   */
  private async throwArchiveTeamTransactionCancellationResult(
    directoryId: string,
    teamId: string,
    originalError: unknown,
  ): Promise<never> {
    const items = await this.readValidDirectoryItems(directoryId, true)
    const activeTeam = items.find((item) =>
      item.entryType === 'team' &&
      item.teamId === teamId &&
      isActiveDirectoryItem(item),
    )

    if (!activeTeam) {
      throw new ProjectDataError(404, 'TeamNotFound', `Team "${teamId}" was not found.`)
    }

    if (hasTransactionConditionalFailure(originalError)) {
      throw createProjectDataConflictError()
    }

    throw toProjectDataError(originalError)
  }

  /**
   * project archive transaction 失敗後の最新状態から not-found と競合を切り分けます。
   */
  private async throwArchiveProjectTransactionCancellationResult(
    directoryId: string,
    teamId: string,
    projectId: string,
    originalError: unknown,
  ): Promise<never> {
    const items = await this.readValidDirectoryItems(directoryId, true)
    const activeTeam = items.find((item) =>
      item.entryType === 'team' &&
      item.teamId === teamId &&
      isActiveDirectoryItem(item),
    )

    if (!activeTeam) {
      throw new ProjectDataError(404, 'TeamNotFound', `Team "${teamId}" was not found.`)
    }

    const activeProject = items.find((item) =>
      item.entryType === 'project' &&
      item.teamId === teamId &&
      item.projectId === projectId &&
      isActiveDirectoryItem(item),
    )

    if (!activeProject) {
      throw new ProjectDataError(
        404,
        'ProjectNotFound',
        `Project "${projectId}" was not found in team "${teamId}".`,
      )
    }

    if (hasTransactionConditionalFailure(originalError)) {
      throw createProjectDataConflictError()
    }

    throw toProjectDataError(originalError)
  }

  /**
   * project member upsert transaction 失敗後の最新状態から not-found と競合を切り分けます。
   */
  private async throwUpdateProjectMemberTransactionCancellationResult(
    directoryId: string,
    projectId: string,
    memberKey: string,
    existingMemberExpected: boolean,
    originalError: unknown,
  ): Promise<never> {
    const items = await this.readValidDirectoryItems(directoryId, true)
    this.requireActiveProject(items, projectId)
    const member = items.find((item): item is ProjectMemberItem =>
      item.entryType === 'project-member' &&
      item.projectId === projectId &&
      item.memberKey === memberKey &&
      isActiveDirectoryItem(item),
    )

    if (existingMemberExpected && !member) {
      throw new ProjectDataError(
        404,
        'ProjectMemberNotFound',
        `Project member "${memberKey}" was not found in project "${projectId}".`,
      )
    }

    if (hasTransactionConditionalFailure(originalError)) {
      throw createProjectDataConflictError()
    }

    throw toProjectDataError(originalError)
  }

  /**
   * project member transaction 失敗後の最新状態から 404 と last-manager conflict を切り分けます。
   */
  private async throwProjectManagerTransactionCancellationResult(
    directoryId: string,
    projectId: string,
    memberKey: string,
    originalError: unknown,
  ): Promise<never> {
    const items = await this.readValidDirectoryItems(directoryId, true)
    this.requireActiveProject(items, projectId)
    const member = items.find((item): item is ProjectMemberItem =>
      item.entryType === 'project-member' &&
      item.projectId === projectId &&
      item.memberKey === memberKey &&
      isActiveDirectoryItem(item),
    )

    if (!member) {
      throw new ProjectDataError(
        404,
        'ProjectMemberNotFound',
        `Project member "${memberKey}" was not found in project "${projectId}".`,
      )
    }

    if (member.role === 'manager' && !this.findAnotherProjectManager(items, projectId, memberKey)) {
      throw this.createProjectLastManagerError()
    }

    if (hasTransactionConditionalFailure(originalError)) {
      throw createProjectDataConflictError()
    }

    throw toProjectDataError(originalError)
  }

  /**
   * project 作成時点でも team が active であることを検証する condition check を作ります。
   */
  private createActiveTeamConditionCheck(directoryId: string, entryKey: string) {
    return {
      TableName: this.tableName,
      Key: {
        directoryId,
        entryKey,
      },
      ConditionExpression: 'attribute_exists(directoryId) AND attribute_exists(entryKey) AND attribute_not_exists(archivedAt)',
    }
  }

  /**
   * 他 manager が transaction 時点でも manager のままか検証する condition check を作ります。
   */
  private createProjectManagerConditionCheck(directoryId: string, entryKey: string) {
    return {
      TableName: this.tableName,
      Key: {
        directoryId,
        entryKey,
      },
      ConditionExpression: '#role = :manager',
      ExpressionAttributeNames: {
        '#role': 'role',
      },
      ExpressionAttributeValues: {
        ':manager': 'manager',
      },
    }
  }

  /**
   * project member 書き込みと同時に active Workspace member の version を進めます。
   */
  private createActiveWorkspaceMemberVersionUpdate(
    workspaceId: string,
    memberKey: string,
    expectedVersion: number,
    updatedAt: string,
  ) {
    return {
      TableName: this.workspaceAccessTableName,
      Key: {
        workspaceId,
        recordKey: `MEMBER#${normalizeProjectMemberKey(memberKey)}`,
      },
      UpdateExpression: 'SET updatedAt = :updatedAt ADD #version :one',
      ConditionExpression:
        '#entryType = :memberEntryType AND #status = :active AND #version = :expectedVersion',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#status': 'status',
        '#version': 'version',
      },
      ExpressionAttributeValues: {
        ':memberEntryType': 'workspace-member',
        ':active': 'active',
        ':expectedVersion': expectedVersion,
        ':updatedAt': updatedAt,
        ':one': 1,
      },
    }
  }

  /**
   * Project role 削除を Workspace member row の存在世代と直列化します。
   */
  private createWorkspaceMemberAuthorizationTransactionItem(
    workspaceId: string,
    memberKey: string,
    expected: WorkspaceMemberAuthorizationGeneration,
    updatedAt: string,
  ) {
    if (!expected.exists) {
      return {
        ConditionCheck: {
          TableName: this.workspaceAccessTableName,
          Key: {
            workspaceId,
            recordKey: `MEMBER#${normalizeProjectMemberKey(memberKey)}`,
          },
          ConditionExpression: 'attribute_not_exists(workspaceId)',
        },
      }
    }

    return {
      Update: this.createWorkspaceMemberVersionUpdate(
        workspaceId,
        memberKey,
        expected,
        updatedAt,
      ),
    }
  }

  /**
   * Project role 削除と同時に現在 lifecycle の Workspace member version を進めます。
   */
  private createWorkspaceMemberVersionUpdate(
    workspaceId: string,
    memberKey: string,
    expected: Extract<WorkspaceMemberAuthorizationGeneration, { exists: true }>,
    updatedAt: string,
  ) {
    return {
      TableName: this.workspaceAccessTableName,
      Key: {
        workspaceId,
        recordKey: `MEMBER#${normalizeProjectMemberKey(memberKey)}`,
      },
      UpdateExpression: 'SET updatedAt = :updatedAt ADD #version :one',
      ConditionExpression:
        '#entryType = :memberEntryType AND #status = :expectedStatus AND #version = :expectedVersion',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#status': 'status',
        '#version': 'version',
      },
      ExpressionAttributeValues: {
        ':memberEntryType': 'workspace-member',
        ':expectedStatus': expected.status,
        ':expectedVersion': expected.version,
        ':updatedAt': updatedAt,
        ':one': 1,
      },
    }
  }

  /** transaction cancel 後に対象 Workspace member の active/version を再確認します。 */
  private async requireUnchangedActiveWorkspaceMember(
    workspaceId: string,
    memberKey: string,
    expectedVersion: number,
  ) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.workspaceAccessTableName,
      Key: {
        workspaceId,
        recordKey: `MEMBER#${normalizeProjectMemberKey(memberKey)}`,
      },
      ConsistentRead: true,
    }))
    const item = response.Item

    if (item?.entryType !== 'workspace-member' || item.status !== 'active') {
      throw new ProjectDataError(
        409,
        'WorkspaceMemberInactive',
        'Only active Workspace members can be assigned to a project.',
      )
    }

    if (item.version !== expectedVersion) {
      throw new ProjectDataError(
        409,
        'WorkspaceMemberVersionConflict',
        'Workspace member changed. Reload and try again.',
      )
    }
  }

  /** transaction cancel 後に対象 Workspace member generation を再確認します。 */
  private async requireUnchangedWorkspaceMemberGeneration(
    workspaceId: string,
    memberKey: string,
    expected: WorkspaceMemberAuthorizationGeneration,
  ) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.workspaceAccessTableName,
      Key: {
        workspaceId,
        recordKey: `MEMBER#${normalizeProjectMemberKey(memberKey)}`,
      },
      ConsistentRead: true,
    }))
    const item = response.Item

    if (!expected.exists) {
      if (item !== undefined) {
        throw new ProjectDataError(
          409,
          'WorkspaceMemberVersionConflict',
          'Workspace member changed. Reload and try again.',
        )
      }

      return
    }

    if (
      item?.entryType !== 'workspace-member' ||
      item.status !== expected.status ||
      item.version !== expected.version
    ) {
      throw new ProjectDataError(
        409,
        'WorkspaceMemberVersionConflict',
        'Workspace member changed. Reload and try again.',
      )
    }
  }

  /**
   * project に manager が残らなくなる操作を表す domain error を作ります。
   */
  private createProjectLastManagerError() {
    return new ProjectDataError(
      409,
      'ProjectLastManager',
      'At least one project manager is required.',
    )
  }

  /**
   * directory partition 内の全 item を LastEvaluatedKey がなくなるまで取得します。
   */
  private async queryDirectoryItems(
    directoryId: string,
    canBootstrapLocalTable = true,
    consistentRead = false,
  ): Promise<unknown[]> {
    try {
      const items: unknown[] = []
      let exclusiveStartKey: Record<string, unknown> | undefined

      do {
        const response = await this.documentClient.send(
          new QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression: 'directoryId = :directoryId',
            ExpressionAttributeValues: {
              ':directoryId': directoryId,
            },
            ExclusiveStartKey: exclusiveStartKey,
            ScanIndexForward: true,
            ...(consistentRead ? { ConsistentRead: true } : {}),
          }),
        )

        items.push(...(response.Items ?? []))
        exclusiveStartKey = response.LastEvaluatedKey
      } while (exclusiveStartKey)

      return items
    } catch (error) {
      if (
        canBootstrapLocalTable &&
        this.bootstrapLocalTables &&
        isResourceNotFoundError(error) &&
        await ensureLocalProjectDirectoryTable(this.tableName, this.dynamoDbClient)
      ) {
        return this.queryDirectoryItems(directoryId, false, consistentRead)
      }

      throw error
    }
  }
}

function createDynamoDbClient() {
  return createConfiguredDynamoDbClient()
}

function createDynamoDbDocumentClient(dynamoDbClient = createDynamoDbClient()) {
  return createWorkspaceSearchWriterDynamoDbDocumentClient(dynamoDbClient)
}

const localDynamoDbTableInitializers = new Map<string, Promise<void>>()

async function ensureLocalProjectDirectoryTable(
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
          { AttributeName: 'directoryId', AttributeType: 'S' },
          { AttributeName: 'entryKey', AttributeType: 'S' },
          { AttributeName: 'webhookAuthorizationKey', AttributeType: 'S' },
          { AttributeName: 'webhookAuthorizationSortKey', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'directoryId', KeyType: 'HASH' },
          { AttributeName: 'entryKey', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [{
          IndexName: 'WebhookAuthorizationIndex',
          KeySchema: [
            { AttributeName: 'webhookAuthorizationKey', KeyType: 'HASH' },
            { AttributeName: 'webhookAuthorizationSortKey', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'KEYS_ONLY' },
        }],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    isProjectDirectoryTableDescription,
  )
}

async function ensureLocalDynamoDbTable(
  tableName: string,
  dynamoDbClient: DynamoDBClient,
  createCommand: () => CreateTableCommand,
  validateTable: (table: TableDescription | undefined) => boolean,
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

  const initializer = createLocalDynamoDbTable(tableName, dynamoDbClient, createCommand, validateTable)
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
) {
  try {
    await dynamoDbClient.send(createCommand())
  } catch (error) {
    if (!isResourceInUseError(error)) {
      throw error
    }
  }

  await waitForLocalDynamoDbTable(tableName, dynamoDbClient, validateTable)
}

async function waitForLocalDynamoDbTable(
  tableName: string,
  dynamoDbClient: DynamoDBClient,
  validateTable: (table: TableDescription | undefined) => boolean,
) {
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
      throw new Error(`Local DynamoDB table "${tableName}" does not match the expected schema.`)
    }

    await sleep(100)
  }

  throw new Error(`Local DynamoDB table "${tableName}" did not become active.`)
}

function isProjectDirectoryTableDescription(table: TableDescription | undefined) {
  return hasKeySchema(table, [
    ['directoryId', 'HASH'],
    ['entryKey', 'RANGE'],
  ]) && table?.GlobalSecondaryIndexes?.some((index) =>
    index.IndexName === 'WebhookAuthorizationIndex' &&
    hasKeySchema(index, [
      ['webhookAuthorizationKey', 'HASH'],
      ['webhookAuthorizationSortKey', 'RANGE'],
    ])
  ) === true
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

function requireDynamoDbTransactionCapacity(
  transactItems: NonNullable<TransactWriteCommandInput['TransactItems']>,
) {
  if (transactItems.length > DYNAMODB_TRANSACTION_MAX_ACTIONS) {
    throw new ProjectDataError(
      409,
      'ProjectMembershipTransactionTooLarge',
      `Project membership would require ${transactItems.length} atomic writes; ` +
        `the supported maximum is ${DYNAMODB_TRANSACTION_MAX_ACTIONS}.`,
    )
  }
}

function createProjectDataConflictError() {
  return new ProjectDataError(
    409,
    'ConditionalCheckFailedException',
    'The transaction condition failed.',
  )
}

function createPlanningRevisionBump(
  tableName: string,
  workspaceId: string,
  expectedRevision: number,
  updatedAt: string,
) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new ProjectDataError(
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
        updatedAt,
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

function readProjectDirectoryItems(values: unknown[], directoryId: string) {
  const directoryItems: ProjectDirectoryItem[] = []

  for (const value of values) {
    if (isProjectDirectoryItem(value, directoryId)) {
      directoryItems.push(value)
      continue
    }

    if (isWorkspaceBootstrapItem(value, directoryId)) {
      continue
    }

    throw new ProjectDataError(
      503,
      'InvalidProjectDirectory',
      'Project directory item is missing or invalid.',
    )
  }

  return directoryItems
}

function toProjectDirectoryResponse(
  values: unknown[],
  locale: Locale,
  directoryId: string,
): ProjectDirectoryTeamResponse[] {
  const teams: ProjectDirectoryTeamResponse[] = []
  const teamById = new Map<string, ProjectDirectoryTeamResponse>()
  const projectItems: ProjectDirectoryProjectItem[] = []

  for (const value of readProjectDirectoryItems(values, directoryId)) {
    if (value.entryType === 'project-member') {
      continue
    }

    if (!isActiveDirectoryItem(value)) {
      continue
    }

    if (value.entryType === 'team') {
      const team = {
        id: value.teamId,
        name: localizedName(value, locale),
        expanded: value.expanded ?? false,
        projects: [],
      }

      teamById.set(team.id, team)
      teams.push(team)
      continue
    }

    projectItems.push(value)
  }

  for (const item of projectItems) {
    const team = teamById.get(item.teamId)

    if (!team || !item.projectId) {
      continue
    }

    team.projects.push({
      id: item.projectId,
      name: localizedName(item, locale),
      tone: item.tone,
    })
  }

  return teams
}

function toProjectMemberResponseItem(item: ProjectMemberItem): ProjectMemberResponseItem {
  const member: ProjectMemberResponseItem = {
    id: item.memberKey,
    email: item.email ?? item.memberKey,
    role: item.role,
    updatedAt: item.updatedAt,
  }

  if (item.name) {
    member.name = item.name
  }

  return member
}

function toProjectAccessEntries(items: ProjectDirectoryItem[], memberKey: string) {
  const activeTeamIds = new Set(
    items
      .filter((item): item is ProjectDirectoryTeamItem =>
        item.entryType === 'team' && isActiveDirectoryItem(item)
      )
      .map((item) => item.teamId),
  )
  const roleByProjectId = new Map(
    items
      .filter((item): item is ProjectMemberItem => {
        return item.entryType === 'project-member' &&
          item.memberKey === memberKey &&
          item.archivedAt === undefined
      })
      .map((item) => [item.projectId, item.role] as const),
  )
  const seenProjectIds = new Set<string>()
  const accessEntries: ProjectAccessEntry[] = []

  for (const item of items) {
    if (
      item.entryType !== 'project' ||
      seenProjectIds.has(item.projectId) ||
      !isActiveDirectoryItem(item) ||
      !activeTeamIds.has(item.teamId)
    ) {
      continue
    }

    seenProjectIds.add(item.projectId)
    accessEntries.push({
      projectId: item.projectId,
      role: roleByProjectId.get(item.projectId),
    })
  }

  return accessEntries
}

function getProjectTeamIds(
  items: ProjectDirectoryItem[],
  projectId: string,
) {
  return [...new Set(items
    .filter((item): item is ProjectDirectoryProjectItem =>
      item.entryType === 'project' &&
      item.projectId === projectId
    )
    .map((item) => item.teamId))]
}

function getActiveProjectGrantSources(
  items: ProjectDirectoryItem[],
  projectId: string,
) {
  const activeTeams = new Map(
    items
      .filter((item): item is ProjectDirectoryTeamItem =>
        item.entryType === 'team' && isActiveDirectoryItem(item)
      )
      .map((item) => [item.teamId, item] as const),
  )
  const sourcesByTeamId = new Map<string, ProjectWebhookGrantSource>()
  for (const item of items) {
    if (
      item.entryType !== 'project' ||
      item.projectId !== projectId ||
      !isActiveDirectoryItem(item)
    ) {
      continue
    }
    const team = activeTeams.get(item.teamId)
    if (!team || sourcesByTeamId.has(item.teamId)) continue
    sourcesByTeamId.set(item.teamId, {
      teamId: item.teamId,
      teamSourceEntryKey: team.entryKey,
      projectSourceEntryKey: item.entryKey,
    })
  }
  return [...sourcesByTeamId.values()]
}

function createWebhookTeamGrantTransactItems(
  tableName: string,
  workspaceId: string,
  projectId: string,
  memberKey: string,
  source: ProjectWebhookGrantSource,
): NonNullable<TransactWriteCommandInput['TransactItems']> {
  return [
    {
      ConditionCheck: {
        TableName: tableName,
        Key: {
          directoryId: workspaceId,
          entryKey: source.teamSourceEntryKey,
        },
        ConditionExpression:
          '#entryType = :teamEntryType AND attribute_not_exists(archivedAt)',
        ExpressionAttributeNames: { '#entryType': 'entryType' },
        ExpressionAttributeValues: { ':teamEntryType': 'team' },
      },
    },
    {
      ConditionCheck: {
        TableName: tableName,
        Key: {
          directoryId: workspaceId,
          entryKey: source.projectSourceEntryKey,
        },
        ConditionExpression:
          '#entryType = :projectEntryType AND attribute_not_exists(archivedAt)',
        ExpressionAttributeNames: { '#entryType': 'entryType' },
        ExpressionAttributeValues: { ':projectEntryType': 'project' },
      },
    },
    {
      Put: {
        TableName: tableName,
        Item: createWebhookTeamGrantItem({
          workspaceId,
          teamId: source.teamId,
          projectId,
          memberKey,
          teamSourceEntryKey: source.teamSourceEntryKey,
          projectSourceEntryKey: source.projectSourceEntryKey,
        }),
      },
    },
    {
      Put: {
        TableName: tableName,
        Item: createWebhookGrantCleanupItem({
          workspaceId,
          teamId: source.teamId,
          projectId,
          memberKey,
        }),
      },
    },
  ]
}

function compareProjectMemberItems(first: ProjectMemberItem, second: ProjectMemberItem) {
  const roleDelta = projectRoleWeights[second.role] - projectRoleWeights[first.role]

  if (roleDelta !== 0) {
    return roleDelta
  }

  return (first.name ?? first.email ?? first.memberKey).localeCompare(
    second.name ?? second.email ?? second.memberKey,
    'ja',
  )
}

function localizedName(item: ProjectDirectoryTeamItem | ProjectDirectoryProjectItem, locale: Locale) {
  return locale === 'en' ? item.nameEn || item.nameJa : item.nameJa || item.nameEn
}

function isActiveDirectoryItem(item: { archivedAt?: string }) {
  return item.archivedAt === undefined
}

function isWorkspaceBootstrapItem(value: unknown, directoryId: string) {
  if (
    !isRecord(value) ||
    value.directoryId !== directoryId ||
    value.workspaceId !== directoryId ||
    typeof value.entryKey !== 'string'
  ) {
    return false
  }

  if (value.entryType === 'workspace-metadata') {
    return value.entryKey === 'WORKSPACE#METADATA'
  }

  if (value.entryType === 'workspace-member') {
    return (
      typeof value.memberKey === 'string' &&
      typeof value.email === 'string' &&
      value.email === value.memberKey &&
      typeof value.username === 'string' &&
      value.role === 'owner' &&
      value.entryKey === `WORKSPACE_MEMBER#${value.memberKey}`
    )
  }

  if (value.entryType === 'email-alias') {
    return (
      typeof value.memberKey === 'string' &&
      typeof value.email === 'string' &&
      value.email === value.memberKey &&
      typeof value.username === 'string' &&
      value.entryKey === `EMAIL_ALIAS#${value.email}`
    )
  }

  return false
}

function isProjectDirectoryItem(value: unknown, directoryId: string): value is ProjectDirectoryItem {
  if (!isRecord(value)) {
    return false
  }

  if (
    value.directoryId !== directoryId ||
    typeof value.entryKey !== 'string' ||
    (
      value.entryType !== 'team' &&
      value.entryType !== 'project' &&
      value.entryType !== 'project-member'
    )
  ) {
    return false
  }

  if (value.entryType === 'project-member') {
    return (
      typeof value.projectId === 'string' &&
      typeof value.memberKey === 'string' &&
      (value.email === undefined || typeof value.email === 'string') &&
      (value.name === undefined || typeof value.name === 'string') &&
      isProjectRole(value.role) &&
      typeof value.createdAt === 'string' &&
      typeof value.updatedAt === 'string' &&
      (value.archivedAt === undefined || typeof value.archivedAt === 'string')
    )
  }

  if (
    typeof value.teamId !== 'string' ||
    typeof value.teamSortOrder !== 'number' ||
    typeof value.nameJa !== 'string' ||
    typeof value.nameEn !== 'string' ||
    (value.archivedAt !== undefined && typeof value.archivedAt !== 'string')
  ) {
    return false
  }

  if (value.entryType === 'team') {
    return value.expanded === undefined || typeof value.expanded === 'boolean'
  }

  return (
    typeof value.projectId === 'string' &&
    typeof value.projectSortOrder === 'number' &&
    isProjectTone(value.tone)
  )
}

function isProjectRole(value: unknown): value is ProjectRole {
  return value === 'manager' || value === 'member' || value === 'viewer'
}

function isProjectTone(value: unknown): value is ProjectTone {
  return value === 'blue' || value === 'purple' || value === 'green' || value === 'yellow'
}

/**
 * Reads and validates localized names from a Team or Project create request.
 *
 * @param input - Create request containing either a shared name or localized names.
 * @returns Normalized Japanese and English names.
 */
export function readLocalizedNames(input: CreateTeamRequestBody | CreateProjectRequestBody) {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const nameJa = typeof input.nameJa === 'string' ? input.nameJa.trim() : ''
  const nameEn = typeof input.nameEn === 'string' ? input.nameEn.trim() : ''
  const primaryName = nameJa || name || nameEn

  if (!primaryName) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Name is required.')
  }

  return {
    nameJa: primaryName,
    nameEn: nameEn || name || primaryName,
  }
}

function readProjectTone(value: unknown): ProjectTone {
  if (value === undefined) {
    return 'blue'
  }

  if (!isProjectTone(value)) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Project tone is invalid.')
  }

  return value
}

function readProjectRole(value: unknown): ProjectRole {
  if (!isProjectRole(value)) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Project role is invalid.')
  }

  return value
}

function readProjectMemberEmail(value: unknown, fallbackMemberKey: string) {
  if (value === undefined) {
    return fallbackMemberKey
  }

  if (typeof value !== 'string' || !value.trim()) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Project member email is required.')
  }

  return normalizeProjectMemberKey(value)
}

function readOptionalProjectMemberName(value: unknown) {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string') {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Project member name is invalid.')
  }

  const name = value.trim()

  return name || undefined
}

/**
 * Normalizes a Project member key for stable identity comparisons and storage keys.
 *
 * @param value - Untrusted member identifier.
 * @returns A trimmed lowercase member key.
 */
export function normalizeProjectMemberKey(value: string) {
  const memberKey = value.trim().toLowerCase()

  if (!memberKey) {
    throw new ProjectDataError(400, 'InvalidProjectWrite', 'Project member key is required.')
  }

  return memberKey
}

/**
 * Validates an optional deterministic Project identifier.
 *
 * @param value - Untrusted identifier value.
 * @returns The validated identifier, or undefined when omitted.
 */
function readIdempotencyResourceId(value: unknown): string | undefined {
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

/**
 * Converts display text into a stable resource identifier stem.
 *
 * @param value - Untrusted display text.
 * @returns A normalized identifier or a timestamp-based fallback.
 */
function createResourceId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')

  return normalized || `item-${Date.now()}`
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

function createTeamEntryKey(teamSortOrder: number, teamId: string) {
  return `${padSortOrder(teamSortOrder)}#000000#TEAM#${teamId}`
}

function createProjectEntryKey(
  teamSortOrder: number,
  projectSortOrder: number,
  projectId: string,
) {
  return `${padSortOrder(teamSortOrder)}#${padSortOrder(projectSortOrder)}#PROJECT#${projectId}`
}

function createProjectMemberEntryKey(projectId: string, memberKey: string) {
  return `PROJECT_MEMBER#${projectId}#${memberKey}`
}

function padSortOrder(value: number) {
  return String(value).padStart(6, '0')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getDynamoDbEndpoint() {
  return loadServerConfig().dynamoDbEndpoint
}

function getEnv(name: string) {
  return loadServerConfig().environment[name]
}
