import {
  AdminListGroupsForUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb'
import type {
  EnterpriseIdentitySnapshot,
  EnterprisePermissionId,
  WebhookSubscription,
} from '@mukuroji/contracts'
import {
  evaluateEnterpriseAccess,
  resolveEnterpriseDirectoryPrincipal,
  type EnterpriseIdentityReadClient,
  type EnterprisePrincipalContext,
} from '../enterprise-identity'
import {
  createWebhookProjectAuthorizationSortKey,
  createWebhookResourceAuthorizationKey,
  createWebhookTeamGrantDirectoryId,
  createWebhookTeamGrantEntryKey,
  createWebhookTeamGrantEntryKeyPrefix,
  createWebhookTeamGrantItem,
  createWebhookTeamAuthorizationSortKey,
} from './webhook-authorization-projection'
import {
  type WorkspaceAccessClient,
  type WorkspaceRole,
} from '../workspace-access'

/** Webhook subscription 作成者の現在 Team access を検証する境界です。 */
export interface WebhookSubscriptionAuthorizer {
  /** 作成者が現在も対象 Team を参照できる場合だけ true を返します。 */
  canDeliver(
    workspaceId: string,
    subscription: WebhookSubscription,
    teamId: string,
    projectId?: string,
  ): Promise<boolean>
  /** 1 Lambda batch 内だけ ACL snapshot を共有する authorizer を返します。 */
  createBatch?(): WebhookSubscriptionAuthorizer
}

/** Webhook の Team selector に必要な current ACL state です。 */
export type WebhookTeamAuthorizationState = {
  /** Subscription creator が active Workspace member かどうかです。 */
  activeWorkspaceMember: boolean
  /** 対象 Team が active かどうかです。 */
  activeTeam: boolean
  /** 対象 Team の active Project に creator の viewer 以上の role があるかどうかです。 */
  hasActiveProjectRole: boolean
}

/**
 * DynamoDB Webhook authorizer の infrastructure dependencies と設定です。
 */
export type DynamoDbWebhookSubscriptionAuthorizerOptions = {
  /** Workspace membership を強整合確認する client です。 */
  workspaceAccess: WorkspaceAccessClient
  /** Current Enterprise CONTROL snapshot を読む client です。 */
  enterpriseIdentity: EnterpriseIdentityReadClient
  /** Team / Project membership を読む DocumentClient です。 */
  documentClient?: DynamoDBDocumentClient
  /** Project directory table 名です。 */
  projectDirectoryTableName?: string
  /** Current Cognito groups を全ページ取得する provider です。 */
  cognitoGroups?: WebhookCognitoGroupsProvider
  /** Project directory resource locator GSI 名です。 */
  authorizationIndexName?: string
  /** Current system administrator とみなす Cognito group names です。 */
  systemAdminGroups?: readonly string[]
}

/** Management API と delivery worker が共有する Team Webhook ACL predicate です。 */
export function allowsWebhookTeamAccess(state: WebhookTeamAuthorizationState) {
  return state.activeWorkspaceMember &&
    state.activeTeam &&
    state.hasActiveProjectRole
}

/** Webhook Enterprise Team access 評価の入力です。 */
export type EvaluateWebhookEnterpriseTeamAccessInput = {
  /** Current Enterprise CONTROL snapshot です。 */
  snapshot: EnterpriseIdentitySnapshot
  /** Subscription creator の current member key です。 */
  memberKey: string
  /** Subscription creator の current email です。 */
  memberEmail: string
  /** Subscription creator の current Workspace role です。 */
  workspaceRole: WorkspaceRole
  /** Cognito から全ページ取得した current group names です。 */
  cognitoGroupIds: string[]
  /** Current Cognito group で system administrator と確認できたかどうかです。 */
  currentSystemAdministrator: boolean
  /** Subscription creator が active Workspace member かどうかです。 */
  activeWorkspaceMember: boolean
  /** 対象 Team の authoritative row が active かどうかです。 */
  activeTeam: boolean
  /** Project 指定時に authoritative Project row が active かどうかです。 */
  activeProject: boolean
  /** Pure legacy Workspace で利用する current Project viewer ACL です。 */
  legacyReadAllowed: boolean
  /** 評価対象 Team ID です。 */
  teamId: string
  /** Project event の場合の評価対象 Project ID です。 */
  projectId?: string
  /** Team ID uniquely resolved from the current Project Directory for a legacy Project scope. */
  projectScopeOwnerTeamId?: string
}

/** Webhook Enterprise Team access 評価結果です。 */
export type WebhookEnterpriseTeamAccess = {
  /** Webhook payload を配信してよいかどうかです。 */
  allowed: boolean
  /** Enterprise RBAC が legacy Project ACL より優先されたかどうかです。 */
  enterpriseAuthoritative: boolean
  /** Current Cognito/SCIM directory group ID 一覧です。 */
  directoryGroupIds: string[]
  /** Guest または verified domain 外の member かどうかです。 */
  external: boolean
  /** Directory/custom assignment により legacy Workspace role を抑制したかどうかです。 */
  workspaceRoleSuppressed: boolean
}

/** Webhook delivery 用に current Cognito group を全ページ取得する境界です。 */
export interface WebhookCognitoGroupsProvider {
  /** Cognito user が現在所属する全 group names を返します。 */
  getGroups(username: string): Promise<string[]>
}

/** Cognito AdminListGroupsForUser を使う production group provider です。 */
export class AwsWebhookCognitoGroupsProvider implements WebhookCognitoGroupsProvider {
  /** Cognito User Pool ID です。 */
  private readonly userPoolId: string
  /** Cognito API client です。 */
  private readonly client: CognitoIdentityProviderClient

  /** Production Cognito group provider を作成します。 */
  constructor(
    userPoolId = process.env.COGNITO_USER_POOL_ID,
    client = createCognitoClient(),
  ) {
    this.userPoolId = readRequiredEnvironment(
      userPoolId,
      'COGNITO_USER_POOL_ID',
    )
    this.client = client
  }

  /** Pagination token を検証しながら current group names を全ページ取得します。 */
  async getGroups(usernameValue: string) {
    const username = readIdentifier(usernameValue, 'Webhook creator username')
    const groupNames = new Set<string>()
    const visitedTokens = new Set<string>()
    let nextToken: string | undefined

    for (let page = 0; page < WEBHOOK_COGNITO_GROUP_PAGE_LIMIT; page += 1) {
      const response = await this.client.send(new AdminListGroupsForUserCommand({
        UserPoolId: this.userPoolId,
        Username: username,
        ...(nextToken ? { NextToken: nextToken } : {}),
      }))
      for (const group of response.Groups ?? []) {
        const groupName = group.GroupName?.trim()
        if (groupName) groupNames.add(groupName)
      }
      const returnedToken = response.NextToken?.trim() || undefined
      if (!returnedToken) return [...groupNames]
      if (visitedTokens.has(returnedToken)) {
        throw new Error('Cognito group pagination token repeated.')
      }
      visitedTokens.add(returnedToken)
      nextToken = returnedToken
    }

    throw new Error('Cognito group pagination exceeded its safe limit.')
  }
}

/**
 * Current SCIM/Cognito groups、custom roles、external policy と legacy ACL を統合します。
 *
 * @remarks
 * Team/Project の存在と Workspace membership は caller が強整合 read した結果を渡します。
 * Enterprise authority が存在する場合、legacy ACL は stale grant として無視します。
 */
export function evaluateWebhookEnterpriseTeamAccess(
  input: EvaluateWebhookEnterpriseTeamAccessInput,
): WebhookEnterpriseTeamAccess {
  const memberKey = readIdentifier(input.memberKey, 'Webhook creator member key')
  const memberDomain = normalizeEmailDomain(input.memberEmail)
  const directoryPrincipal = resolveEnterpriseDirectoryPrincipal(
    input.snapshot,
    memberKey,
    input.cognitoGroupIds,
  )
  const {
    compatibleGroupMappings,
    compatibleRoleAssignments,
    directoryGroupIds,
    directoryGroupMemberships,
  } = directoryPrincipal
  const verifiedDomains = input.snapshot.domains.filter((domain) =>
    domain.status === 'verified'
  )
  const managedDomain = verifiedDomains.length === 0 || verifiedDomains.some((domain) =>
    domain.domain.trim().toLowerCase() === memberDomain
  )
  const external = input.workspaceRole === 'guest' || !managedDomain
  const recoveryAccount = input.snapshot.breakGlassAccounts.some((account) =>
    account.status === 'active' &&
    account.linkedMemberKey === memberKey
  )
  const externalPolicy = input.snapshot.policy?.externalAccess
  const guestDenied = input.workspaceRole === 'guest' && externalPolicy !== undefined &&
    (
      !externalPolicy.allowGuests ||
      externalPolicy.allowedGuestDomains.length > 0 &&
        !externalPolicy.allowedGuestDomains.some((domain) =>
          domain.trim().toLowerCase() === memberDomain
        )
    )
  const collaboratorDenied =
    input.workspaceRole !== 'guest' &&
    !managedDomain &&
    externalPolicy?.allowExternalCollaborators === false &&
    !recoveryAccount
  const workspaceRoleSuppressed = directoryPrincipal.directoryManaged ||
    compatibleRoleAssignments.some((assignment) =>
      assignment.principalKind === 'member' &&
        assignment.principalId === memberKey ||
      assignment.principalKind === 'directory-group' &&
        (
          assignment.source === 'directory-mapping' ||
          directoryGroupIds.includes(assignment.principalId)
        )
    ) ||
    compatibleGroupMappings.some((mapping) => mapping.enabled)
  const permissionCeiling = external
    ? input.snapshot.policy?.externalAccess.permissionCeiling ??
      DEFAULT_EXTERNAL_PERMISSION_CEILING
    : undefined
  const principal = {
    kind: 'member',
    principalId: memberKey,
    directoryGroupIds,
    directoryGroupMemberships,
    workspaceRole: input.workspaceRole,
    includeWorkspaceRolePermissions: !workspaceRoleSuppressed,
    ...(workspaceRoleSuppressed
      ? { directPermissions: ['workspace.read' as const] }
      : {}),
    systemAdministrator: input.currentSystemAdministrator,
    ...(permissionCeiling ? { permissionCeiling } : {}),
  } satisfies EnterprisePrincipalContext
  const resource = input.projectId
    ? {
        workspaceId: input.snapshot.workspaceId,
        kind: 'project' as const,
        targetId: input.projectId,
        parentTeamId: input.teamId,
      }
    : {
        workspaceId: input.snapshot.workspaceId,
        kind: 'team' as const,
        targetId: input.teamId,
      }
  const enterpriseAccess = evaluateEnterpriseAccess({
    permission: 'work-items.read',
    principal,
    assignments: compatibleRoleAssignments,
    customRoles: input.snapshot.customRoles,
    groupMappings: compatibleGroupMappings,
    resource,
    ...(input.projectScopeOwnerTeamId !== undefined
      ? { projectScopeOwnerTeamId: input.projectScopeOwnerTeamId }
      : {}),
  })
  const enterpriseAuthoritative = workspaceRoleSuppressed ||
    external && input.snapshot.policy !== undefined ||
    input.currentSystemAdministrator
  const enterpriseBoundaryDenied =
    guestDenied || collaboratorDenied || directoryPrincipal.deprovisioned
  const resourcesActive = input.activeWorkspaceMember &&
    input.activeTeam &&
    input.activeProject

  return {
    allowed:
      resourcesActive &&
      !enterpriseBoundaryDenied &&
      (
        enterpriseAuthoritative
          ? enterpriseAccess.allowed
          : input.legacyReadAllowed
      ),
    enterpriseAuthoritative,
    directoryGroupIds,
    external,
    workspaceRoleSuppressed,
  }
}

/** 1 Lambda batch 内でのみ共有する ACL/Enterprise read-through cache です。 */
type WebhookAuthorizationBatchCache = {
  /** Base table locator ごとの強整合 ACL row です。 */
  authoritativeRows: Map<string, Promise<ProjectDirectoryAuthorizationRow>>
  /** Workspace user ごとの active membership snapshot です。 */
  activeMembers: Map<string, ReturnType<WorkspaceAccessClient['getActiveMember']>>
  /** Workspace ごとの current Enterprise CONTROL snapshot です。 */
  enterpriseSnapshots: Map<string, ReturnType<EnterpriseIdentityReadClient['getSnapshot']>>
  /** Workspace member ごとの current Cognito group names です。 */
  cognitoGroups: Map<string, ReturnType<WebhookCognitoGroupsProvider['getGroups']>>
  /** Team/Project ごとの active authoritative resource 判定です。 */
  activeResources: Map<string, Promise<boolean>>
  /** Team/member ごとの pagewise legacy grant 検証結果です。 */
  teamGrantAccess: Map<string, Promise<boolean>>
  /** Member/resource ごとの統合 Enterprise 評価です。 */
  enterpriseEvaluations: Map<string, Promise<WebhookEnterpriseTeamAccess>>
}

/** Team grant を1回の Query で検証する page size です。 */
const WEBHOOK_TEAM_GRANT_QUERY_PAGE_SIZE = 25
/** Resource locator を1回の GSI Query で検証する page size です。 */
const WEBHOOK_RESOURCE_QUERY_PAGE_SIZE = 25
/** DynamoDB authorization pagination cycle を fail-closed にする最大 page 数です。 */
const WEBHOOK_AUTHORIZATION_QUERY_PAGE_LIMIT = 100
/** Cognito pagination cycle を fail-closed にする最大 page 数です。 */
const WEBHOOK_COGNITO_GROUP_PAGE_LIMIT = 100
/** Webhook worker が使う既定の resource authorization GSI 名です。 */
const DEFAULT_WEBHOOK_AUTHORIZATION_INDEX_NAME = 'WebhookAuthorizationIndex'
/** External principal に policy 未設定時も適用する既定 permission ceiling です。 */
const DEFAULT_EXTERNAL_PERMISSION_CEILING = [
  'workspace.read',
  'members.read',
  'teams.read',
  'projects.read',
  'work-items.read',
  'documents.read',
  'files.read',
  'planning.read',
] satisfies EnterprisePermissionId[]
/** System administrator の既定 Cognito group です。 */
const DEFAULT_SYSTEM_ADMIN_GROUPS = ['mukuroji-system-admins']

/** Project directory と Enterprise CONTROL の current state を使う production authorizer です。 */
export class DynamoDbWebhookSubscriptionAuthorizer
implements WebhookSubscriptionAuthorizer {
  /** Workspace membership を強整合確認する client です。 */
  private readonly workspaceAccess: WorkspaceAccessClient
  /** Team / Project membership を読む DocumentClient です。 */
  private readonly documentClient: DynamoDBDocumentClient
  /** Project directory table 名です。 */
  private readonly projectDirectoryTableName: string
  /** Current Enterprise CONTROL snapshot を読む client です。 */
  private readonly enterpriseIdentity: EnterpriseIdentityReadClient
  /** Current Cognito groups を全ページ取得する provider です。 */
  private readonly cognitoGroups: WebhookCognitoGroupsProvider
  /** Project directory resource locator GSI 名です。 */
  private readonly authorizationIndexName: string
  /** Current system administrator とみなす Cognito group names です。 */
  private readonly systemAdminGroups: ReadonlySet<string>

  /** Production Webhook subscription authorizer を作成します。 */
  constructor(options: DynamoDbWebhookSubscriptionAuthorizerOptions) {
    const documentClient = options.documentClient ?? createDocumentClient()
    const projectDirectoryTableName = options.projectDirectoryTableName ??
      process.env.PROJECT_DIRECTORY_TABLE_NAME ??
      process.env.MUKUROJI_PROJECT_DIRECTORY_TABLE ??
      'mukuroji-project-directory-local'
    const cognitoGroups = options.cognitoGroups ??
      new AwsWebhookCognitoGroupsProvider()
    const authorizationIndexName = options.authorizationIndexName ??
      process.env.PROJECT_DIRECTORY_WEBHOOK_AUTHORIZATION_INDEX_NAME ??
        DEFAULT_WEBHOOK_AUTHORIZATION_INDEX_NAME
    const systemAdminGroups = options.systemAdminGroups ??
      readConfiguredSystemAdminGroups()
    this.workspaceAccess = options.workspaceAccess
    this.documentClient = documentClient
    this.projectDirectoryTableName = readIdentifier(
      projectDirectoryTableName,
      'Project directory table name',
    )
    this.enterpriseIdentity = options.enterpriseIdentity
    this.cognitoGroups = cognitoGroups
    this.authorizationIndexName = readIdentifier(
      authorizationIndexName,
      'Webhook authorization index name',
    )
    this.systemAdminGroups = new Set(
      systemAdminGroups.map((group) =>
        readIdentifier(group, 'System administrator group')
      ),
    )
  }

  /** Active creator、resource、Enterprise permission を delivery ごとに再評価します。 */
  async canDeliver(
    workspaceIdValue: string,
    subscription: WebhookSubscription,
    teamIdValue: string,
    projectIdValue?: string,
  ) {
    try {
      return await this.canDeliverWithCache(
        workspaceIdValue,
        subscription,
        teamIdValue,
        projectIdValue,
      )
    } catch {
      return false
    }
  }

  /** 同じ Lambda batch の subscription 判定で current snapshot read を再利用します。 */
  createBatch(): WebhookSubscriptionAuthorizer {
    const cache: WebhookAuthorizationBatchCache = {
      authoritativeRows: new Map(),
      activeMembers: new Map(),
      enterpriseSnapshots: new Map(),
      cognitoGroups: new Map(),
      activeResources: new Map(),
      teamGrantAccess: new Map(),
      enterpriseEvaluations: new Map(),
    }
    return {
      canDeliver: async (workspaceId, subscription, teamId, projectId) => {
        try {
          return await this.canDeliverWithCache(
            workspaceId,
            subscription,
            teamId,
            projectId,
            cache,
          )
        } catch {
          return false
        }
      },
    }
  }

  private async canDeliverWithCache(
    workspaceIdValue: string,
    subscription: WebhookSubscription,
    teamIdValue: string,
    projectIdValue?: string,
    cache?: WebhookAuthorizationBatchCache,
  ) {
    const workspaceId = readIdentifier(workspaceIdValue, 'Webhook Workspace ID')
    const teamId = readIdentifier(teamIdValue, 'Webhook Team ID')
    if (!subscription.teamIds.includes(teamId)) return false
    const createdByUserId = readIdentifier(
      subscription.createdByUserId,
      'Webhook creator user ID',
    )
    const memberCacheKey = `${workspaceId}\0${createdByUserId}`
    const memberPromise = cache?.activeMembers.get(memberCacheKey) ??
      this.workspaceAccess.getActiveMember(workspaceId, createdByUserId)
    cache?.activeMembers.set(memberCacheKey, memberPromise)
    const member = await memberPromise
    if (!member) {
      return false
    }
    const projectId = projectIdValue === undefined
      ? undefined
      : readIdentifier(projectIdValue, 'Webhook Project ID')
    const evaluationCacheKey = [
      workspaceId,
      member.memberKey,
      String(member.version),
      member.role,
      member.email,
      teamId,
      projectId ?? '',
    ].join('\0')
    const cachedEvaluation = cache?.enterpriseEvaluations.get(evaluationCacheKey)
    if (cachedEvaluation) return (await cachedEvaluation).allowed
    const pendingEvaluation = this.evaluateCurrentAccess(
      workspaceId,
      member,
      teamId,
      projectId,
      cache,
    )
    cache?.enterpriseEvaluations.set(evaluationCacheKey, pendingEvaluation)
    return (await pendingEvaluation).allowed
  }

  private async evaluateCurrentAccess(
    workspaceId: string,
    member: NonNullable<Awaited<ReturnType<WorkspaceAccessClient['getActiveMember']>>>,
    teamId: string,
    projectId?: string,
    cache?: WebhookAuthorizationBatchCache,
  ) {
    const snapshotPromise = cache?.enterpriseSnapshots.get(workspaceId) ??
      this.enterpriseIdentity.getSnapshot(workspaceId)
    cache?.enterpriseSnapshots.set(workspaceId, snapshotPromise)
    const groupCacheKey = `${workspaceId}\0${member.memberKey}`
    const groupsPromise = cache?.cognitoGroups.get(groupCacheKey) ??
      this.cognitoGroups.getGroups(member.memberKey)
    cache?.cognitoGroups.set(groupCacheKey, groupsPromise)
    const [snapshot, groups, activeTeam, activeProject, legacyReadAllowed] =
      await Promise.all([
        snapshotPromise,
        groupsPromise,
        this.hasActiveResource(workspaceId, teamId, undefined, cache),
        projectId === undefined
          ? Promise.resolve(true)
          : this.hasActiveResource(workspaceId, teamId, projectId, cache),
        this.hasActiveTeamGrant(
          workspaceId,
          teamId,
          member.memberKey,
          projectId,
          cache,
        ),
      ])
    if (snapshot.workspaceId !== workspaceId) {
      throw new Error('Enterprise snapshot Workspace does not match delivery scope.')
    }
    return evaluateWebhookEnterpriseTeamAccess({
      snapshot,
      memberKey: member.memberKey,
      memberEmail: member.email,
      workspaceRole: member.role,
      cognitoGroupIds: groups,
      currentSystemAdministrator: groups.some((group) =>
        this.systemAdminGroups.has(group)
      ),
      activeWorkspaceMember: true,
      activeTeam,
      activeProject,
      legacyReadAllowed,
      teamId,
      ...(projectId ? { projectId } : {}),
      ...(projectId !== undefined && activeProject
        ? { projectScopeOwnerTeamId: teamId }
        : {}),
    })
  }

  private async hasActiveTeamGrant(
    workspaceId: string,
    teamId: string,
    memberKey: string,
    projectId?: string,
    cache?: WebhookAuthorizationBatchCache,
  ) {
    const cacheKey = `${workspaceId}\0${teamId}\0${memberKey}\0${projectId ?? ''}`
    const cached = cache?.teamGrantAccess.get(cacheKey)
    if (cached) return await cached
    const pending = this.queryActiveTeamGrant(
      workspaceId,
      teamId,
      memberKey,
      projectId,
      cache,
    )
    cache?.teamGrantAccess.set(cacheKey, pending)
    return await pending
  }

  private async hasActiveResource(
    workspaceId: string,
    teamId: string,
    projectId?: string,
    cache?: WebhookAuthorizationBatchCache,
  ) {
    const cacheKey = `${workspaceId}\0${teamId}\0${projectId ?? ''}`
    const cached = cache?.activeResources.get(cacheKey)
    if (cached) return await cached
    const pending = this.queryActiveResource(
      workspaceId,
      teamId,
      projectId,
      cache,
    )
    cache?.activeResources.set(cacheKey, pending)
    return await pending
  }

  private async queryActiveResource(
    workspaceId: string,
    teamId: string,
    projectId?: string,
    cache?: WebhookAuthorizationBatchCache,
  ) {
    const authorizationKey = createWebhookResourceAuthorizationKey(workspaceId)
    const authorizationSortKey = projectId
      ? createWebhookProjectAuthorizationSortKey(projectId)
      : createWebhookTeamAuthorizationSortKey(teamId)
    const locators: Array<{ directoryId: string; entryKey: string }> = []
    const visitedPaginationKeys = new Set<string>()
    let exclusiveStartKey: Record<string, unknown> | undefined

    for (
      let page = 0;
      page < WEBHOOK_AUTHORIZATION_QUERY_PAGE_LIMIT;
      page += 1
    ) {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.projectDirectoryTableName,
        IndexName: this.authorizationIndexName,
        KeyConditionExpression:
          '#authorizationKey = :authorizationKey AND ' +
          '#authorizationSortKey = :authorizationSortKey',
        ExpressionAttributeNames: {
          '#authorizationKey': 'webhookAuthorizationKey',
          '#authorizationSortKey': 'webhookAuthorizationSortKey',
        },
        ExpressionAttributeValues: {
          ':authorizationKey': authorizationKey,
          ':authorizationSortKey': authorizationSortKey,
        },
        ProjectionExpression: 'directoryId, entryKey',
        Limit: WEBHOOK_RESOURCE_QUERY_PAGE_SIZE,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))
      for (const item of response.Items ?? []) {
        if (
          typeof item.directoryId !== 'string' ||
          typeof item.entryKey !== 'string'
        ) {
          throw new Error('Webhook resource locator is malformed.')
        }
        locators.push({
          directoryId: item.directoryId,
          entryKey: item.entryKey,
        })
        if (locators.length > 1) return false
      }
      if (!response.LastEvaluatedKey) break
      const paginationKey = serializePaginationKey(response.LastEvaluatedKey)
      if (visitedPaginationKeys.has(paginationKey)) {
        throw new Error('Webhook resource pagination key repeated.')
      }
      visitedPaginationKeys.add(paginationKey)
      exclusiveStartKey = response.LastEvaluatedKey
      if (page === WEBHOOK_AUTHORIZATION_QUERY_PAGE_LIMIT - 1) {
        throw new Error('Webhook resource pagination exceeded its safe limit.')
      }
    }
    const locator = locators[0]
    if (!locator || locator.directoryId !== workspaceId) return false
    const row = await this.readAuthoritativeRow(
      locator.directoryId,
      locator.entryKey,
      cache,
    )
    return projectId
      ? hasActiveProject([row], teamId, projectId)
      : hasActiveTeam([row], teamId)
  }

  private async queryActiveTeamGrant(
    workspaceId: string,
    teamId: string,
    memberKey: string,
    projectId?: string,
    cache?: WebhookAuthorizationBatchCache,
  ) {
    const grantDirectoryId =
      createWebhookTeamGrantDirectoryId(workspaceId, memberKey)
    if (projectId !== undefined) {
      const response = await this.documentClient.send(new GetCommand({
        TableName: this.projectDirectoryTableName,
        Key: {
          directoryId: grantDirectoryId,
          entryKey: createWebhookTeamGrantEntryKey(teamId, projectId),
        },
        ConsistentRead: true,
      }))
      const grant = readAuthorizationRow(response.Item ?? {})
      return isWebhookTeamGrant(grant, workspaceId, teamId, memberKey) &&
        await this.hasCurrentGrantSources(grant, memberKey, cache)
    }
    const grantEntryKeyPrefix = createWebhookTeamGrantEntryKeyPrefix(teamId)
    const visitedPaginationKeys = new Set<string>()
    let exclusiveStartKey: Record<string, unknown> | undefined

    for (
      let page = 0;
      page < WEBHOOK_AUTHORIZATION_QUERY_PAGE_LIMIT;
      page += 1
    ) {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.projectDirectoryTableName,
        KeyConditionExpression:
          'directoryId = :grantDirectoryId AND ' +
          'begins_with(entryKey, :grantEntryKeyPrefix)',
        ExpressionAttributeValues: {
          ':grantDirectoryId': grantDirectoryId,
          ':grantEntryKeyPrefix': grantEntryKeyPrefix,
        },
        ConsistentRead: true,
        Limit: WEBHOOK_TEAM_GRANT_QUERY_PAGE_SIZE,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))
      const grantRows = (response.Items ?? []).map(readAuthorizationRow)
      const grants = grantRows.filter((row) =>
        isWebhookTeamGrant(row, workspaceId, teamId, memberKey)
      )
      const checks = await Promise.all(grants.map(async (grant) =>
        await this.hasCurrentGrantSources(grant, memberKey, cache)
      ))
      if (checks.some(Boolean)) return true
      if (!response.LastEvaluatedKey) break
      const paginationKey = serializePaginationKey(response.LastEvaluatedKey)
      if (visitedPaginationKeys.has(paginationKey)) {
        throw new Error('Webhook Team grant pagination key repeated.')
      }
      visitedPaginationKeys.add(paginationKey)
      exclusiveStartKey = response.LastEvaluatedKey
      if (page === WEBHOOK_AUTHORIZATION_QUERY_PAGE_LIMIT - 1) {
        throw new Error('Webhook Team grant pagination exceeded its safe limit.')
      }
    }
    return false
  }

  private async hasCurrentGrantSources(
    grant: ProjectDirectoryAuthorizationRow,
    memberKey: string,
    cache?: WebhookAuthorizationBatchCache,
  ) {
    const workspaceId = grant.workspaceId!
    const teamId = grant.teamId!
    const projectId = grant.projectId!
    const [memberRow, teamRow, projectRow] = await Promise.all([
      this.readAuthoritativeRow(workspaceId, grant.sourceEntryKey!, cache),
      this.readAuthoritativeRow(workspaceId, grant.teamSourceEntryKey!, cache),
      this.readAuthoritativeRow(workspaceId, grant.projectSourceEntryKey!, cache),
    ])
    return hasProjectRole([memberRow], memberKey, projectId) &&
      hasActiveTeam([teamRow], teamId) &&
      hasActiveProject([projectRow], teamId, projectId)
  }

  private async readAuthoritativeRow(
    directoryId: string,
    entryKey: string,
    cache?: WebhookAuthorizationBatchCache,
  ) {
    const cacheKey = `${directoryId}\0${entryKey}`
    const cached = cache?.authoritativeRows.get(cacheKey)
    if (cached) return await cached
    const pending = this.documentClient.send(new GetCommand({
      TableName: this.projectDirectoryTableName,
      Key: { directoryId, entryKey },
      ConsistentRead: true,
    })).then((response) => readAuthorizationRow(response.Item ?? {}))
    cache?.authoritativeRows.set(cacheKey, pending)
    return await pending
  }

}

/** ACL 判定に必要な Project directory row の最小 shape です。 */
type ProjectDirectoryAuthorizationRow = {
  /** Workspace ID です。 */
  directoryId?: string
  /** Projection row が参照する Workspace ID です。 */
  workspaceId?: string
  /** Base table sort key です。 */
  entryKey?: string
  /** Row discriminator です。 */
  entryType: string
  /** Sparse GSI partition key です。 */
  webhookAuthorizationKey?: string
  /** Sparse GSI sort key です。 */
  webhookAuthorizationSortKey?: string
  /** Team ID です。 */
  teamId?: string
  /** Project ID です。 */
  projectId?: string
  /** Project member key です。 */
  memberKey?: string
  /** Project role です。 */
  role?: string
  /** Materialized grant が参照する authoritative member sort key です。 */
  sourceEntryKey?: string
  /** Materialized grant が参照する authoritative Team sort key です。 */
  teamSourceEntryKey?: string
  /** Materialized grant が参照する authoritative Project sort key です。 */
  projectSourceEntryKey?: string
  /** Archive timestamp です。 */
  archivedAt?: string
}

function readAuthorizationRow(value: Record<string, unknown>) {
  return {
    ...(typeof value.directoryId === 'string' ? { directoryId: value.directoryId } : {}),
    ...(typeof value.workspaceId === 'string' ? { workspaceId: value.workspaceId } : {}),
    ...(typeof value.entryKey === 'string' ? { entryKey: value.entryKey } : {}),
    entryType: typeof value.entryType === 'string' ? value.entryType : '',
    ...(typeof value.webhookAuthorizationKey === 'string'
      ? { webhookAuthorizationKey: value.webhookAuthorizationKey }
      : {}),
    ...(typeof value.webhookAuthorizationSortKey === 'string'
      ? { webhookAuthorizationSortKey: value.webhookAuthorizationSortKey }
      : {}),
    ...(typeof value.teamId === 'string' ? { teamId: value.teamId } : {}),
    ...(typeof value.projectId === 'string' ? { projectId: value.projectId } : {}),
    ...(typeof value.memberKey === 'string' ? { memberKey: value.memberKey } : {}),
    ...(typeof value.role === 'string' ? { role: value.role } : {}),
    ...(typeof value.sourceEntryKey === 'string'
      ? { sourceEntryKey: value.sourceEntryKey }
      : {}),
    ...(typeof value.teamSourceEntryKey === 'string'
      ? { teamSourceEntryKey: value.teamSourceEntryKey }
      : {}),
    ...(typeof value.projectSourceEntryKey === 'string'
      ? { projectSourceEntryKey: value.projectSourceEntryKey }
      : {}),
    ...(typeof value.archivedAt === 'string' ? { archivedAt: value.archivedAt } : {}),
  } satisfies ProjectDirectoryAuthorizationRow
}

function hasActiveTeam(rows: ProjectDirectoryAuthorizationRow[], teamId: string) {
  return rows.some((row) =>
    row.entryType === 'team' &&
    row.teamId === teamId &&
    row.archivedAt === undefined
  )
}

function hasActiveProject(
  rows: ProjectDirectoryAuthorizationRow[],
  teamId: string,
  projectId: string,
) {
  return rows.some((row) =>
    row.entryType === 'project' &&
    row.teamId === teamId &&
    row.projectId === projectId &&
    row.archivedAt === undefined
  )
}

function hasProjectRole(
  rows: ProjectDirectoryAuthorizationRow[],
  memberKey: string,
  projectId?: string,
) {
  return rows.some((row) =>
    row.entryType === 'project-member' &&
    row.memberKey === memberKey &&
    row.archivedAt === undefined &&
    (projectId === undefined || row.projectId === projectId) &&
    (row.role === 'viewer' || row.role === 'member' || row.role === 'manager')
  )
}

function isWebhookTeamGrant(
  row: ProjectDirectoryAuthorizationRow,
  workspaceId: string,
  teamId: string,
  memberKey: string,
) {
  if (
    row.entryType !== 'webhook-team-grant' ||
    row.workspaceId !== workspaceId ||
    row.teamId !== teamId ||
    row.memberKey !== memberKey ||
    typeof row.projectId !== 'string' ||
    typeof row.teamSourceEntryKey !== 'string' ||
    typeof row.projectSourceEntryKey !== 'string'
  ) {
    return false
  }
  const expected = createWebhookTeamGrantItem({
    workspaceId,
    teamId,
    projectId: row.projectId,
    memberKey,
    teamSourceEntryKey: row.teamSourceEntryKey,
    projectSourceEntryKey: row.projectSourceEntryKey,
  })
  return row.directoryId === expected.directoryId &&
    row.entryKey === expected.entryKey &&
    row.sourceEntryKey === expected.sourceEntryKey &&
    row.teamSourceEntryKey === expected.teamSourceEntryKey &&
    row.projectSourceEntryKey === expected.projectSourceEntryKey &&
    row.webhookAuthorizationKey === expected.webhookAuthorizationKey &&
    row.webhookAuthorizationSortKey === expected.webhookAuthorizationSortKey
}

function createDocumentClient() {
  const endpoint = process.env.DYNAMODB_ENDPOINT ??
    process.env.AWS_ENDPOINT_URL_DYNAMODB ??
    process.env.AWS_ENDPOINT_URL
  const client = new DynamoDBClient({
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'ap-northeast-1',
    ...(endpoint
      ? {
          endpoint,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }
      : {}),
  })
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  })
}

function createCognitoClient() {
  return new CognitoIdentityProviderClient({
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'ap-northeast-1',
  })
}

function readConfiguredSystemAdminGroups() {
  const configured = (
    process.env.MUKUROJI_SYSTEM_ADMIN_GROUPS ??
    process.env.SYSTEM_ADMIN_GROUPS ??
    ''
  )
    .split(',')
    .map((group) => group.trim())
    .filter(Boolean)
  return configured.length > 0 ? configured : DEFAULT_SYSTEM_ADMIN_GROUPS
}

function normalizeEmailDomain(email: string) {
  const atIndex = email.lastIndexOf('@')
  return atIndex > 0 ? email.slice(atIndex + 1).trim().toLowerCase() : ''
}

function serializePaginationKey(key: Record<string, unknown>) {
  return JSON.stringify(
    Object.entries(key).sort(([left], [right]) => left.localeCompare(right)),
  )
}

function readRequiredEnvironment(value: string | undefined, name: string) {
  const normalized = value?.trim()
  if (!normalized) {
    throw new TypeError(`${name} is required.`)
  }
  return normalized
}

function readIdentifier(value: string, label: string) {
  const normalized = value.trim()
  if (!normalized || normalized.length > 255 || /\p{Cc}/u.test(normalized)) {
    throw new TypeError(`${label} is invalid.`)
  }
  return normalized
}
