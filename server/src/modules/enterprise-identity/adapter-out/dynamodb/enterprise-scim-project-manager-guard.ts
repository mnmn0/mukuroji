import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb'
import type {
  EnterpriseScimGroupJobProjectManagerGuard,
} from '../../application/ports/scim-group-job-worker-dependencies'
import { WorkspaceAccessError } from '../../../workspace-access'

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
