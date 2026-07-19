import {
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb'
import { createEnterpriseIdentityClient } from './enterprise-identity'
import { DynamoDbDocumentsClient } from './documents'
import {
  processEnterpriseScimGroupJobBatch,
  type EnterpriseScimGroupJobProcessor,
  type EnterpriseScimGroupJobStreamEvent,
} from './enterprise-scim-group-job-handler'
import {
  createEnterpriseScimGroupJobProcessor,
  type EnterpriseScimGroupJobCognitoClient,
  type EnterpriseScimGroupJobProjectManagerGuard,
} from './enterprise-scim-group-job-worker'
import { DynamoDbPlanningClient } from './planning'
import {
  DynamoDbWorkspaceAccessClient,
  WorkspaceAccessError,
} from './workspace-access'

/**
 * Enterprise SCIM group job 専用 Lambda handler の契約です。
 */
export type EnterpriseScimGroupJobWorkerHandler = (
  event: EnterpriseScimGroupJobStreamEvent,
) => ReturnType<typeof processEnterpriseScimGroupJobBatch>

/**
 * Project directory を直接読む SCIM deprovisioning guard です。
 */
export class DynamoDbEnterpriseScimProjectManagerGuard
  implements EnterpriseScimGroupJobProjectManagerGuard
{
  /** Project directory table 名です。 */
  private readonly tableName: string
  /** Project directory を読む DynamoDB document client です。 */
  private readonly documentClient: DynamoDBDocumentClient

  /**
   * Project manager guard を作成します。
   */
  constructor(
    tableName = readRequiredEnvironment('PROJECT_DIRECTORY_TABLE_NAME'),
    documentClient = createDocumentClient(),
  ) {
    this.tableName = tableName
    this.documentClient = documentClient
  }

  /**
   * Active project に対象 member の manager role があるかを返します。
   */
  async hasManagedProject(workspaceId: string, memberKey: string) {
    const normalizedMemberKey = normalizeProjectMemberKey(memberKey)
    const items: Record<string, unknown>[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'directoryId = :directoryId',
        ExpressionAttributeValues: {
          ':directoryId': workspaceId,
        },
        ExpressionAttributeNames: {
          '#entryType': 'entryType',
          '#name': 'name',
          '#role': 'role',
        },
        ProjectionExpression:
          'directoryId, entryKey, #entryType, workspaceId, teamId, projectId, ' +
          'memberKey, email, username, #name, #role, archivedAt, teamSortOrder, ' +
          'nameJa, nameEn, expanded, projectSortOrder, tone, createdAt, updatedAt',
        ExclusiveStartKey: exclusiveStartKey,
        ConsistentRead: true,
      }))
      items.push(...(response.Items ?? []))
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)

    assertValidProjectGuardItems(items, workspaceId)
    const activeTeamIds = new Set(
      items
        .filter((item) =>
          item.entryType === 'team' &&
          item.archivedAt === undefined
        )
        .map((item) => item.teamId as string),
    )
    const activeProjectIds = new Set(
      items
        .filter((item) =>
          item.entryType === 'project' &&
          item.archivedAt === undefined &&
          activeTeamIds.has(item.teamId as string)
        )
        .map((item) => item.projectId as string),
    )
    return items.some((item) =>
      item.entryType === 'project-member' &&
      normalizeProjectMemberKey(item.memberKey as string) ===
        normalizedMemberKey &&
      item.role === 'manager' &&
      activeProjectIds.has(item.projectId as string)
    )
  }
}

/**
 * Cognito SDK を利用する SCIM user lifecycle client です。
 */
export class AwsEnterpriseScimGroupJobCognitoClient
  implements EnterpriseScimGroupJobCognitoClient
{
  /** Cognito user pool ID です。 */
  private readonly userPoolId: string
  /** Cognito Identity Provider SDK client です。 */
  private readonly client: CognitoIdentityProviderClient

  /**
   * Cognito user lifecycle client を作成します。
   */
  constructor(
    userPoolId = readRequiredEnvironment('COGNITO_USER_POOL_ID'),
    client = new CognitoIdentityProviderClient({}),
  ) {
    this.userPoolId = userPoolId
    this.client = client
  }

  /** Directory deprovisioning 後に新規認証を停止します。 */
  async disableWorkspaceUser(userId: string) {
    await this.client.send(new AdminDisableUserCommand({
      UserPoolId: this.userPoolId,
      Username: normalizeCognitoUserId(userId),
    }))
  }

  /** Directory reactivation 後に認証を再開します。 */
  async enableWorkspaceUser(userId: string) {
    await this.client.send(new AdminEnableUserCommand({
      UserPoolId: this.userPoolId,
      Username: normalizeCognitoUserId(userId),
    }))
  }

  /** Directory deprovisioning 後に refresh token を全失効させます。 */
  async globallySignOutWorkspaceUser(userId: string) {
    await this.client.send(new AdminUserGlobalSignOutCommand({
      UserPoolId: this.userPoolId,
      Username: normalizeCognitoUserId(userId),
    }))
  }
}

/**
 * Production environment から SCIM group job processor を作成します。
 */
export function createDefaultEnterpriseScimGroupJobProcessor() {
  return createEnterpriseScimGroupJobProcessor({
    enterpriseIdentity: createEnterpriseIdentityClient(),
    workspaceAccess: new DynamoDbWorkspaceAccessClient(),
    documents: new DynamoDbDocumentsClient(),
    planning: new DynamoDbPlanningClient(),
    projectManagerGuard: new DynamoDbEnterpriseScimProjectManagerGuard(),
    cognito: new AwsEnterpriseScimGroupJobCognitoClient(),
  })
}

/**
 * 専用 processor をDynamoDB Streams partial batch handlerへ接続します。
 */
export function createEnterpriseScimGroupJobWorkerHandler(
  processor: EnterpriseScimGroupJobProcessor,
): EnterpriseScimGroupJobWorkerHandler {
  return async (event) => await processEnterpriseScimGroupJobBatch(event, processor)
}

let defaultProcessor: EnterpriseScimGroupJobProcessor | undefined

/**
 * AWS Lambda にデプロイする Enterprise SCIM group job 専用 handler です。
 */
export const handler: EnterpriseScimGroupJobWorkerHandler = async (event) => {
  defaultProcessor ??= createDefaultEnterpriseScimGroupJobProcessor()
  return await processEnterpriseScimGroupJobBatch(event, defaultProcessor)
}

function createDocumentClient() {
  return DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  })
}

function readRequiredEnvironment(name: string) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new WorkspaceAccessError(
      503,
      'EnterpriseScimGroupJobConfigurationMissing',
      `${name} is required by the Enterprise SCIM group job worker.`,
    )
  }
  return value
}

function normalizeCognitoUserId(value: string) {
  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    throw new WorkspaceAccessError(
      503,
      'EnterpriseScimGroupJobUserInvalid',
      'SCIM group job Cognito user ID is invalid.',
    )
  }
  return normalized
}

function normalizeProjectMemberKey(value: string) {
  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    throwInvalidProjectDirectory()
  }
  return normalized
}

function assertValidProjectGuardItems(
  items: readonly Record<string, unknown>[],
  workspaceId: string,
) {
  for (const item of items) {
    if (
      item.directoryId !== workspaceId ||
      typeof item.entryKey !== 'string'
    ) throwInvalidProjectDirectory()
    if (item.entryType === 'team') {
      if (
        typeof item.teamId !== 'string' ||
        typeof item.teamSortOrder !== 'number' ||
        typeof item.nameJa !== 'string' ||
        typeof item.nameEn !== 'string' ||
        item.expanded !== undefined && typeof item.expanded !== 'boolean' ||
        item.archivedAt !== undefined && typeof item.archivedAt !== 'string'
      ) throwInvalidProjectDirectory()
      continue
    }
    if (item.entryType === 'project') {
      if (
        typeof item.teamId !== 'string' ||
        typeof item.projectId !== 'string' ||
        typeof item.teamSortOrder !== 'number' ||
        typeof item.projectSortOrder !== 'number' ||
        typeof item.nameJa !== 'string' ||
        typeof item.nameEn !== 'string' ||
        item.tone !== 'blue' &&
          item.tone !== 'purple' &&
          item.tone !== 'green' &&
          item.tone !== 'yellow' ||
        item.archivedAt !== undefined && typeof item.archivedAt !== 'string'
      ) throwInvalidProjectDirectory()
      continue
    }
    if (item.entryType === 'project-member') {
      if (
        typeof item.projectId !== 'string' ||
        typeof item.memberKey !== 'string' ||
        item.email !== undefined && typeof item.email !== 'string' ||
        item.name !== undefined && typeof item.name !== 'string' ||
        item.role !== 'manager' &&
          item.role !== 'member' &&
          item.role !== 'viewer' ||
        typeof item.createdAt !== 'string' ||
        typeof item.updatedAt !== 'string'
      ) throwInvalidProjectDirectory()
      continue
    }
    if (item.entryType === 'workspace-metadata') {
      if (
        item.workspaceId !== workspaceId ||
        item.entryKey !== 'WORKSPACE#METADATA'
      ) throwInvalidProjectDirectory()
      continue
    }
    if (item.entryType === 'workspace-member') {
      if (
        item.workspaceId !== workspaceId ||
        typeof item.memberKey !== 'string' ||
        item.email !== item.memberKey ||
        typeof item.username !== 'string' ||
        item.role !== 'owner' ||
        item.entryKey !== `WORKSPACE_MEMBER#${item.memberKey}`
      ) throwInvalidProjectDirectory()
      continue
    }
    if (item.entryType === 'email-alias') {
      if (
        item.workspaceId !== workspaceId ||
        typeof item.memberKey !== 'string' ||
        item.email !== item.memberKey ||
        typeof item.username !== 'string' ||
        item.entryKey !== `EMAIL_ALIAS#${item.email}`
      ) throwInvalidProjectDirectory()
      continue
    }
    throwInvalidProjectDirectory()
  }
}

function throwInvalidProjectDirectory(): never {
  throw new WorkspaceAccessError(
    503,
    'InvalidProjectDirectory',
    'Project directory item is missing or invalid.',
  )
}
