import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  GITHUB_PULL_REQUEST_CHECK_STATES,
  GITHUB_PULL_REQUEST_MERGEABLE_STATES,
  GITHUB_PULL_REQUEST_REVIEW_DECISIONS,
  GITHUB_PULL_REQUEST_REVIEW_STATES,
  GITHUB_PULL_REQUEST_STATES,
  GITHUB_REPOSITORY_ID_PATTERN,
  isGitHubLogin,
  type GitHubPullRequestReview,
} from '@mukuroji/contracts'
import {
  createMutationAuditEventPut,
  createWorkspaceMemberAuditEntityId,
  type MutationAuditContext,
} from '../../../audit'
import { GitHubIntegrationError } from '../../domain/github-integration-error'
import type { GitHubPullRequestSnapshot } from '../../domain/pull-request-snapshot'
import type {
  DeleteMemberLoginInput,
  DeleteRepositoryLinkInput,
  GitHubIntegrationStore,
  GitHubPullRequestSnapshotPage,
  GitHubRepositoryLinkRecord,
  SaveMemberLoginInput,
  SaveRepositoryLinkInput,
} from '../../application/ports'

/** Record types in the Planning table. */
const LINK_TYPE = 'github-repository-link'
const LOGIN_TYPE = 'github-login'
const MEMBER_LOGIN_TYPE = 'github-member-login'
const PULL_REQUEST_TYPE = 'github-pull-request'

/** Schema version of every row this store writes. */
const SCHEMA_VERSION = 1

/** Record key prefixes. */
const LINK_PREFIX = 'GITHUB_REPOSITORY#'
const LOGIN_PREFIX = 'GITHUB_LOGIN#'
const MEMBER_LOGIN_PREFIX = 'GITHUB_MEMBER#'
const PULL_REQUEST_PREFIX = 'GITHUB_PULL_REQUEST#'

/** Query pages read when listing snapshots; each page is at most 1 MB. */
const SNAPSHOT_PAGES_MAX = 10

/** Transaction item of a DynamoDB write. */
type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number]

/**
 * Builds the record key of a pull request snapshot. The number is zero-padded so the rows of a
 * repository sort by number.
 *
 * @param repositoryId - Repository ID.
 * @param number - Pull request number.
 * @returns The record key.
 */
function pullRequestKey(repositoryId: string, number: number): string {
  return `${PULL_REQUEST_PREFIX}${repositoryId}#${String(number).padStart(10, '0')}`
}

/**
 * Builds the record key of a login's holder row; logins are matched without regard to case.
 *
 * @param login - GitHub login.
 * @returns The record key.
 */
function loginKey(login: string): string {
  return `${LOGIN_PREFIX}${login.toLowerCase()}`
}

/**
 * Builds the record key of a member's login row.
 *
 * @param memberKey - Member key.
 * @returns The record key.
 */
function memberLoginKey(memberKey: string): string {
  return `${MEMBER_LOGIN_PREFIX}${encodeURIComponent(memberKey)}`
}

/**
 * Stores GitHub repository links, member logins, and pull request snapshots in the Workspace
 * partition of the Planning table (ADR 0079), so the Workspace export and deletion find them with
 * the other Planning rows.
 *
 * A login is held by one member at a time: the member row and the login row are written together
 * and the login row is created only while absent.
 */
export class DynamoDbGitHubIntegrationStore implements GitHubIntegrationStore<MutationAuditContext> {
  /** Planning table. */
  private readonly tableName: string

  /** Document client. */
  private readonly client: DynamoDBDocumentClient

  /** Audit event table, when audit is configured. */
  private readonly auditTableName: string | undefined

  /** Workspace Audit pseudonym key, which keeps member keys out of Audit entity IDs. */
  private readonly auditPseudonymKey: string | undefined

  /**
   * Creates the store.
   *
   * @param tableName - Planning table.
   * @param client - Document client.
   * @param auditTableName - Audit event table, when configured.
   * @param auditPseudonymKey - Workspace Audit pseudonym key; required while audit is on.
   */
  constructor(tableName: string, client: DynamoDBDocumentClient, auditTableName?: string, auditPseudonymKey?: string) {
    this.tableName = tableName
    this.client = client
    this.auditTableName = auditTableName
    this.auditPseudonymKey = auditPseudonymKey
  }

  /**
   * Lists the repository links.
   *
   * @param workspaceId - Workspace.
   * @returns The links.
   */
  async listRepositoryLinks(workspaceId: string): Promise<GitHubRepositoryLinkRecord[]> {
    const rows = await this.queryPrefix(workspaceId, LINK_PREFIX, Number.POSITIVE_INFINITY, true)
    return rows.items.map((row) => parseLinkRow(row, workspaceId))
  }

  /**
   * Reads one repository link.
   *
   * @param workspaceId - Workspace.
   * @param repositoryId - Repository ID.
   * @returns The link, or `null`.
   */
  async getRepositoryLink(workspaceId: string, repositoryId: string): Promise<GitHubRepositoryLinkRecord | null> {
    const row = await this.readItem(workspaceId, `${LINK_PREFIX}${repositoryId}`)
    return row ? parseLinkRow(row, workspaceId) : null
  }

  /**
   * Creates or replaces a link.
   *
   * @param input - Link, expected revision, and audit context.
   */
  async saveRepositoryLink(input: SaveRepositoryLinkInput<MutationAuditContext>): Promise<void> {
    const { record } = input
    const audit = createMutationAuditEventPut(this.auditTableName, input.auditContext, {
      directoryId: input.workspaceId,
      eventType: 'workspace.github_repository_linked',
      entityType: 'workspace',
      entityId: input.workspaceId,
      target: { type: LINK_TYPE, id: record.repositoryId },
      action: 'github_repository_linked',
      occurredAt: record.linkedAt,
      changes: [],
      metadata: { repositoryId: record.repositoryId, repository: record.repository, teamId: record.teamId, revision: record.revision },
    })
    const items: TransactItem[] = [
      {
        Put: {
          TableName: this.tableName,
          Item: {
            workspaceId: input.workspaceId,
            recordKey: `${LINK_PREFIX}${record.repositoryId}`,
            entryType: LINK_TYPE,
            schemaVersion: SCHEMA_VERSION,
            ...record,
          },
          ...(input.expectedRevision === undefined
            ? { ConditionExpression: 'attribute_not_exists(recordKey)' }
            : {
              ConditionExpression: '#revision = :expectedRevision',
              ExpressionAttributeNames: { '#revision': 'revision' },
              ExpressionAttributeValues: { ':expectedRevision': input.expectedRevision },
            }),
        },
      },
      ...(audit ? [audit] : []),
    ]
    await this.transact(items)
  }

  /**
   * Deletes a link.
   *
   * @param input - Link and audit context.
   */
  async deleteRepositoryLink(input: DeleteRepositoryLinkInput<MutationAuditContext>): Promise<void> {
    const { record } = input
    const audit = createMutationAuditEventPut(this.auditTableName, input.auditContext, {
      directoryId: input.workspaceId,
      eventType: 'workspace.github_repository_unlinked',
      entityType: 'workspace',
      entityId: input.workspaceId,
      target: { type: LINK_TYPE, id: record.repositoryId },
      action: 'github_repository_unlinked',
      occurredAt: input.now,
      changes: [],
      metadata: { repositoryId: record.repositoryId, repository: record.repository, teamId: record.teamId },
    })
    await this.transact([
      {
        Delete: {
          TableName: this.tableName,
          Key: { workspaceId: input.workspaceId, recordKey: `${LINK_PREFIX}${record.repositoryId}` },
          ConditionExpression: '#revision = :revision',
          ExpressionAttributeNames: { '#revision': 'revision' },
          ExpressionAttributeValues: { ':revision': record.revision },
        },
      },
      ...(audit ? [audit] : []),
    ])
  }

  /**
   * Reads a member's login.
   *
   * @param workspaceId - Workspace.
   * @param memberKey - Member key.
   * @returns The login, or `null`.
   */
  async getMemberLogin(workspaceId: string, memberKey: string): Promise<string | null> {
    const row = await this.readItem(workspaceId, memberLoginKey(memberKey))
    if (!row) return null
    if (row.entryType !== MEMBER_LOGIN_TYPE || row.schemaVersion !== SCHEMA_VERSION || row.memberKey !== memberKey || !isGitHubLogin(row.login)) {
      throw corrupt()
    }
    return row.login
  }

  /**
   * Finds the holder of a login.
   *
   * @param workspaceId - Workspace.
   * @param login - Login.
   * @returns The member key, or `null`.
   */
  async findMemberByLogin(workspaceId: string, login: string): Promise<string | null> {
    const row = await this.readItem(workspaceId, loginKey(login))
    if (!row) return null
    if (row.entryType !== LOGIN_TYPE || row.schemaVersion !== SCHEMA_VERSION || typeof row.memberKey !== 'string' || row.memberKey.length === 0) {
      throw corrupt()
    }
    return row.memberKey
  }

  /**
   * Registers a member's login.
   *
   * @param input - Member, login, previous login, and audit context.
   */
  async saveMemberLogin(input: SaveMemberLoginInput<MutationAuditContext>): Promise<void> {
    const audit = createMutationAuditEventPut(this.auditTableName, input.auditContext, {
      directoryId: input.workspaceId,
      eventType: 'member.github_login_saved',
      entityType: 'member',
      entityId: this.auditEntityId(input.workspaceId, input.memberKey),
      target: { type: MEMBER_LOGIN_TYPE, id: input.login.toLowerCase() },
      action: 'github_login_saved',
      occurredAt: input.now,
      changes: [],
    })
    const sameHolderRow = input.previousLogin !== undefined && input.previousLogin.toLowerCase() === input.login.toLowerCase()
    await this.transact([
      {
        Put: {
          TableName: this.tableName,
          Item: {
            workspaceId: input.workspaceId,
            recordKey: memberLoginKey(input.memberKey),
            entryType: MEMBER_LOGIN_TYPE,
            schemaVersion: SCHEMA_VERSION,
            memberKey: input.memberKey,
            login: input.login,
            updatedAt: input.now,
          },
          ...(input.previousLogin === undefined
            ? { ConditionExpression: 'attribute_not_exists(recordKey)' }
            : {
              ConditionExpression: '#login = :previousLogin',
              ExpressionAttributeNames: { '#login': 'login' },
              ExpressionAttributeValues: { ':previousLogin': input.previousLogin },
            }),
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: {
            workspaceId: input.workspaceId,
            recordKey: loginKey(input.login),
            entryType: LOGIN_TYPE,
            schemaVersion: SCHEMA_VERSION,
            memberKey: input.memberKey,
            updatedAt: input.now,
          },
          // A case-only change keeps the member's own login row.
          ConditionExpression: sameHolderRow ? '#memberKey = :memberKey' : 'attribute_not_exists(recordKey)',
          ...(sameHolderRow
            ? { ExpressionAttributeNames: { '#memberKey': 'memberKey' }, ExpressionAttributeValues: { ':memberKey': input.memberKey } }
            : {}),
        },
      },
      ...(input.previousLogin !== undefined && !sameHolderRow
        ? [{
          Delete: {
            TableName: this.tableName,
            Key: { workspaceId: input.workspaceId, recordKey: loginKey(input.previousLogin) },
            ConditionExpression: '#memberKey = :memberKey',
            ExpressionAttributeNames: { '#memberKey': 'memberKey' },
            ExpressionAttributeValues: { ':memberKey': input.memberKey },
          },
        } satisfies TransactItem]
        : []),
      ...(audit ? [audit] : []),
    ])
  }

  /**
   * Removes a member's login.
   *
   * @param input - Member, login, and audit context.
   */
  async deleteMemberLogin(input: DeleteMemberLoginInput<MutationAuditContext>): Promise<void> {
    const audit = createMutationAuditEventPut(this.auditTableName, input.auditContext, {
      directoryId: input.workspaceId,
      eventType: 'member.github_login_removed',
      entityType: 'member',
      entityId: this.auditEntityId(input.workspaceId, input.memberKey),
      target: { type: MEMBER_LOGIN_TYPE, id: input.login.toLowerCase() },
      action: 'github_login_removed',
      occurredAt: input.now,
      changes: [],
    })
    await this.transact([
      {
        Delete: {
          TableName: this.tableName,
          Key: { workspaceId: input.workspaceId, recordKey: memberLoginKey(input.memberKey) },
          ConditionExpression: '#login = :login',
          ExpressionAttributeNames: { '#login': 'login' },
          ExpressionAttributeValues: { ':login': input.login },
        },
      },
      {
        Delete: {
          TableName: this.tableName,
          Key: { workspaceId: input.workspaceId, recordKey: loginKey(input.login) },
          ConditionExpression: '#memberKey = :memberKey',
          ExpressionAttributeNames: { '#memberKey': 'memberKey' },
          ExpressionAttributeValues: { ':memberKey': input.memberKey },
        },
      },
      ...(audit ? [audit] : []),
    ])
  }

  /**
   * Lists the snapshots.
   *
   * @param workspaceId - Workspace.
   * @returns Snapshots and whether the read stopped at its bound.
   */
  async listPullRequestSnapshots(workspaceId: string): Promise<GitHubPullRequestSnapshotPage> {
    const rows = await this.queryPrefix(workspaceId, PULL_REQUEST_PREFIX, SNAPSHOT_PAGES_MAX, false)
    return { snapshots: rows.items.map(parseSnapshotRow), incomplete: rows.incomplete }
  }

  /**
   * Reads one snapshot with a consistent read.
   *
   * @param workspaceId - Workspace.
   * @param repositoryId - Repository ID.
   * @param number - Pull request number.
   * @returns The snapshot, or `null` when none is stored or the row cannot be read.
   */
  async getPullRequestSnapshot(workspaceId: string, repositoryId: string, number: number): Promise<GitHubPullRequestSnapshot | null> {
    const row = await this.readItem(workspaceId, pullRequestKey(repositoryId, number))
    if (!row) return null
    try {
      return parseSnapshotRow(row)
    } catch {
      // The row is rewritten by this read; an unreadable one only means no change is detected.
      return null
    }
  }

  /**
   * Writes a snapshot unless a later read is stored.
   *
   * @param workspaceId - Workspace.
   * @param snapshot - Snapshot.
   * @returns `written` or `stale`.
   */
  async putPullRequestSnapshot(workspaceId: string, snapshot: GitHubPullRequestSnapshot): Promise<'written' | 'stale'> {
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          workspaceId,
          recordKey: pullRequestKey(snapshot.repositoryId, snapshot.number),
          entryType: PULL_REQUEST_TYPE,
          schemaVersion: SCHEMA_VERSION,
          ...snapshot,
        },
        ConditionExpression: 'attribute_not_exists(recordKey) OR #syncedAt < :syncedAt',
        ExpressionAttributeNames: { '#syncedAt': 'syncedAt' },
        ExpressionAttributeValues: { ':syncedAt': snapshot.syncedAt },
      }))
      return 'written'
    } catch (error) {
      if (isConditionalCheckFailure(error)) return 'stale'
      return storageFailure(error)
    }
  }

  /**
   * Deletes a snapshot.
   *
   * @param workspaceId - Workspace.
   * @param repositoryId - Repository ID.
   * @param number - Pull request number.
   */
  async deletePullRequestSnapshot(workspaceId: string, repositoryId: string, number: number): Promise<void> {
    await this.client.send(new DeleteCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: pullRequestKey(repositoryId, number) },
    })).catch((error: unknown) => storageFailure(error))
  }

  /**
   * Builds the Audit entity ID of a member without the member key, which may be an email.
   *
   * @param workspaceId - Workspace.
   * @param memberKey - Member key.
   * @returns The pseudonym, or a placeholder while audit is off.
   */
  private auditEntityId(workspaceId: string, memberKey: string): string {
    if (!this.auditTableName) return 'audit-disabled'
    try {
      if (!this.auditPseudonymKey) throw new TypeError('missing')
      return createWorkspaceMemberAuditEntityId(workspaceId, memberKey, this.auditPseudonymKey)
    } catch (error) {
      throw new GitHubIntegrationError('unavailable', 'GitHubIntegrationAuditUnavailable', 'GitHub integration audit is not configured.', { cause: error })
    }
  }

  /**
   * Queries the rows of a record key prefix.
   *
   * @param workspaceId - Workspace.
   * @param prefix - Record key prefix.
   * @param maxPages - Pages read before stopping.
   * @param consistent - Whether to read strongly.
   * @returns Rows and whether the read stopped early.
   */
  private async queryPrefix(
    workspaceId: string,
    prefix: string,
    maxPages: number,
    consistent: boolean,
  ): Promise<{ items: Record<string, unknown>[], incomplete: boolean }> {
    const items: Record<string, unknown>[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    let pages = 0
    do {
      const page = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: '#workspaceId = :workspaceId AND begins_with(#recordKey, :prefix)',
        ExpressionAttributeNames: { '#workspaceId': 'workspaceId', '#recordKey': 'recordKey' },
        ExpressionAttributeValues: { ':workspaceId': workspaceId, ':prefix': prefix },
        ConsistentRead: consistent,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      })).catch((error: unknown) => storageFailure(error))
      items.push(...page.Items ?? [])
      exclusiveStartKey = page.LastEvaluatedKey
      pages += 1
    } while (exclusiveStartKey && pages < maxPages)
    return { items, incomplete: exclusiveStartKey !== undefined }
  }

  /**
   * Reads one row strongly.
   *
   * @param workspaceId - Workspace.
   * @param recordKey - Record key.
   * @returns The row, or `undefined`.
   */
  private async readItem(workspaceId: string, recordKey: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey },
      ConsistentRead: true,
    })).catch((error: unknown) => storageFailure(error))
    return result.Item
  }

  /**
   * Runs a transaction, mapping a failed condition to a conflict.
   *
   * @param items - Transaction items.
   */
  private async transact(items: TransactItem[]): Promise<void> {
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: items }))
    } catch (error) {
      const codes = readCancellationCodes(error)
      if (codes?.includes('ConditionalCheckFailed') && codes.every((code) => code === 'None' || code === 'ConditionalCheckFailed')) {
        throw new GitHubIntegrationError('conflict', 'GitHubIntegrationConflict', 'The GitHub setting changed. Reload and try again.')
      }
      storageFailure(error)
    }
  }
}

/**
 * Keeps the same rows in memory, for tests and local runs.
 */
export class InMemoryGitHubIntegrationStore implements GitHubIntegrationStore<unknown> {
  /** Links by Workspace and repository ID. */
  readonly links = new Map<string, GitHubRepositoryLinkRecord>()

  /** Logins by Workspace and member key. */
  readonly memberLogins = new Map<string, string>()

  /** Member keys by Workspace and lowercase login. */
  readonly loginHolders = new Map<string, string>()

  /** Snapshots by Workspace, repository ID, and number. */
  readonly snapshots = new Map<string, GitHubPullRequestSnapshot>()

  /**
   * Lists links.
   *
   * @param workspaceId - Workspace.
   * @returns Copies of the links.
   */
  async listRepositoryLinks(workspaceId: string): Promise<GitHubRepositoryLinkRecord[]> {
    return [...this.links].filter(([key]) => key.startsWith(`${workspaceId}\0`)).map(([, link]) => ({ ...link }))
  }

  /**
   * Reads a link.
   *
   * @param workspaceId - Workspace.
   * @param repositoryId - Repository ID.
   * @returns A copy, or `null`.
   */
  async getRepositoryLink(workspaceId: string, repositoryId: string): Promise<GitHubRepositoryLinkRecord | null> {
    const link = this.links.get(`${workspaceId}\0${repositoryId}`)
    return link ? { ...link } : null
  }

  /**
   * Saves a link.
   *
   * @param input - Link and expected revision.
   */
  async saveRepositoryLink(input: SaveRepositoryLinkInput<unknown>): Promise<void> {
    const key = `${input.workspaceId}\0${input.record.repositoryId}`
    if (this.links.get(key)?.revision !== input.expectedRevision) throw conflict()
    this.links.set(key, { ...input.record })
  }

  /**
   * Deletes a link.
   *
   * @param input - Link.
   */
  async deleteRepositoryLink(input: DeleteRepositoryLinkInput<unknown>): Promise<void> {
    const key = `${input.workspaceId}\0${input.record.repositoryId}`
    if (this.links.get(key)?.revision !== input.record.revision) throw conflict()
    this.links.delete(key)
  }

  /**
   * Reads a member's login.
   *
   * @param workspaceId - Workspace.
   * @param memberKey - Member key.
   * @returns The login, or `null`.
   */
  async getMemberLogin(workspaceId: string, memberKey: string): Promise<string | null> {
    return this.memberLogins.get(`${workspaceId}\0${memberKey}`) ?? null
  }

  /**
   * Finds a login's holder.
   *
   * @param workspaceId - Workspace.
   * @param login - Login.
   * @returns The member key, or `null`.
   */
  async findMemberByLogin(workspaceId: string, login: string): Promise<string | null> {
    return this.loginHolders.get(`${workspaceId}\0${login.toLowerCase()}`) ?? null
  }

  /**
   * Saves a member's login.
   *
   * @param input - Member and login.
   */
  async saveMemberLogin(input: SaveMemberLoginInput<unknown>): Promise<void> {
    const memberKey = `${input.workspaceId}\0${input.memberKey}`
    const holderKey = `${input.workspaceId}\0${input.login.toLowerCase()}`
    const holder = this.loginHolders.get(holderKey)
    if ((this.memberLogins.get(memberKey) ?? undefined) !== input.previousLogin || (holder !== undefined && holder !== input.memberKey)) {
      throw conflict()
    }
    if (input.previousLogin !== undefined) this.loginHolders.delete(`${input.workspaceId}\0${input.previousLogin.toLowerCase()}`)
    this.memberLogins.set(memberKey, input.login)
    this.loginHolders.set(holderKey, input.memberKey)
  }

  /**
   * Deletes a member's login.
   *
   * @param input - Member and login.
   */
  async deleteMemberLogin(input: DeleteMemberLoginInput<unknown>): Promise<void> {
    const memberKey = `${input.workspaceId}\0${input.memberKey}`
    if (this.memberLogins.get(memberKey) !== input.login) throw conflict()
    this.memberLogins.delete(memberKey)
    this.loginHolders.delete(`${input.workspaceId}\0${input.login.toLowerCase()}`)
  }

  /**
   * Reads one snapshot.
   *
   * @param workspaceId - Workspace.
   * @param repositoryId - Repository ID.
   * @param number - Pull request number.
   * @returns A copy of the snapshot, or `null`.
   */
  async getPullRequestSnapshot(workspaceId: string, repositoryId: string, number: number): Promise<GitHubPullRequestSnapshot | null> {
    const snapshot = this.snapshots.get(`${workspaceId}\0${pullRequestKey(repositoryId, number)}`)
    return snapshot ? structuredClone(snapshot) : null
  }

  /**
   * Lists snapshots.
   *
   * @param workspaceId - Workspace.
   * @returns Copies of the snapshots.
   */
  async listPullRequestSnapshots(workspaceId: string): Promise<GitHubPullRequestSnapshotPage> {
    const snapshots = [...this.snapshots]
      .filter(([key]) => key.startsWith(`${workspaceId}\0`))
      .map(([, snapshot]) => structuredClone(snapshot))
    return { snapshots, incomplete: false }
  }

  /**
   * Writes a snapshot unless a later read is stored.
   *
   * @param workspaceId - Workspace.
   * @param snapshot - Snapshot.
   * @returns `written` or `stale`.
   */
  async putPullRequestSnapshot(workspaceId: string, snapshot: GitHubPullRequestSnapshot): Promise<'written' | 'stale'> {
    const key = `${workspaceId}\0${pullRequestKey(snapshot.repositoryId, snapshot.number)}`
    const current = this.snapshots.get(key)
    if (current && current.syncedAt >= snapshot.syncedAt) return 'stale'
    this.snapshots.set(key, structuredClone(snapshot))
    return 'written'
  }

  /**
   * Deletes a snapshot.
   *
   * @param workspaceId - Workspace.
   * @param repositoryId - Repository ID.
   * @param number - Number.
   */
  async deletePullRequestSnapshot(workspaceId: string, repositoryId: string, number: number): Promise<void> {
    this.snapshots.delete(`${workspaceId}\0${pullRequestKey(repositoryId, number)}`)
  }
}

/**
 * Parses a link row.
 *
 * @param row - Stored row.
 * @param workspaceId - Partition it was read from.
 * @returns The link.
 */
function parseLinkRow(row: Record<string, unknown>, workspaceId: string): GitHubRepositoryLinkRecord {
  const { repositoryId, repository, installationId, teamId, revision, linkedAt } = row
  if (
    row.workspaceId !== workspaceId ||
    row.entryType !== LINK_TYPE ||
    row.schemaVersion !== SCHEMA_VERSION ||
    typeof repositoryId !== 'string' || !GITHUB_REPOSITORY_ID_PATTERN.test(repositoryId) ||
    row.recordKey !== `${LINK_PREFIX}${repositoryId}` ||
    typeof repository !== 'string' || repository.length === 0 ||
    typeof installationId !== 'string' || !GITHUB_REPOSITORY_ID_PATTERN.test(installationId) ||
    typeof teamId !== 'string' || teamId.length === 0 ||
    typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1 ||
    typeof linkedAt !== 'string'
  ) {
    throw corrupt()
  }
  return { repositoryId, repository, installationId, private: row.private === true, teamId, revision, linkedAt }
}

/**
 * Parses a snapshot row.
 *
 * @param row - Stored row.
 * @returns The snapshot.
 */
function parseSnapshotRow(row: Record<string, unknown>): GitHubPullRequestSnapshot {
  const checks = isRecord(row.checks) ? row.checks : undefined
  const reviews = Array.isArray(row.reviews) ? row.reviews : undefined
  if (
    row.entryType !== PULL_REQUEST_TYPE ||
    row.schemaVersion !== SCHEMA_VERSION ||
    typeof row.repositoryId !== 'string' ||
    typeof row.number !== 'number' ||
    row.recordKey !== pullRequestKey(row.repositoryId, row.number) ||
    !allStrings([row.repository, row.title, row.url, row.headRef, row.baseRef, row.headSha, row.createdAt, row.updatedAt, row.syncedAt]) ||
    !isOneOf(row.state, GITHUB_PULL_REQUEST_STATES) ||
    !isOneOf(row.mergeable, GITHUB_PULL_REQUEST_MERGEABLE_STATES) ||
    !isOneOf(row.reviewDecision, GITHUB_PULL_REQUEST_REVIEW_DECISIONS) ||
    !isStringArray(row.requestedReviewerLogins) ||
    !isStringArray(row.requestedTeamSlugs) ||
    !checks || !isOneOf(checks.state, GITHUB_PULL_REQUEST_CHECK_STATES) || !isStringArray(checks.failedNames) ||
    typeof checks.total !== 'number' ||
    !reviews ||
    (row.authorLogin !== undefined && typeof row.authorLogin !== 'string') ||
    (row.mergedAt !== undefined && typeof row.mergedAt !== 'string') ||
    (row.closedAt !== undefined && typeof row.closedAt !== 'string')
  ) {
    throw corrupt()
  }
  const parsedReviews: GitHubPullRequestReview[] = reviews.map((review) => {
    if (!isRecord(review) || typeof review.login !== 'string' || !isOneOf(review.state, GITHUB_PULL_REQUEST_REVIEW_STATES)) throw corrupt()
    return { login: review.login, state: review.state }
  })
  return {
    repositoryId: row.repositoryId,
    repository: String(row.repository),
    number: row.number,
    title: String(row.title),
    url: String(row.url),
    state: row.state,
    draft: row.draft === true,
    ...(typeof row.authorLogin === 'string' ? { authorLogin: row.authorLogin } : {}),
    headRef: String(row.headRef),
    baseRef: String(row.baseRef),
    headSha: String(row.headSha),
    mergeable: row.mergeable,
    reviewDecision: row.reviewDecision,
    requestedReviewerLogins: row.requestedReviewerLogins,
    requestedTeamSlugs: row.requestedTeamSlugs,
    reviews: parsedReviews,
    checks: { state: checks.state, failedNames: checks.failedNames, total: checks.total },
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    ...(typeof row.mergedAt === 'string' ? { mergedAt: row.mergedAt } : {}),
    ...(typeof row.closedAt === 'string' ? { closedAt: row.closedAt } : {}),
    syncedAt: String(row.syncedAt),
  }
}

/**
 * Checks that a value is one of a list of literals.
 *
 * @param value - Value.
 * @param values - Allowed literals.
 * @returns True when the value is listed.
 */
function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return values.some((candidate) => candidate === value)
}

/**
 * Checks that every value is a string.
 *
 * @param values - Values.
 * @returns True when all are strings.
 */
function allStrings(values: readonly unknown[]): boolean {
  return values.every((value) => typeof value === 'string')
}

/**
 * Checks that a value is an array of strings.
 *
 * @param value - Value.
 * @returns True for a string array.
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

/**
 * Checks whether a value is a plain object.
 *
 * @param value - Value.
 * @returns True for a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Checks whether a DynamoDB error is a failed condition.
 *
 * @param error - Thrown error.
 * @returns True for `ConditionalCheckFailedException`.
 */
function isConditionalCheckFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'ConditionalCheckFailedException'
}

/**
 * Reads the cancellation reason codes of a cancelled transaction.
 *
 * @param error - Thrown error.
 * @returns The codes, or `undefined` for another error.
 */
function readCancellationCodes(error: unknown): (string | undefined)[] | undefined {
  if (
    typeof error !== 'object' || error === null ||
    !('name' in error) || error.name !== 'TransactionCanceledException' ||
    !('CancellationReasons' in error) || !Array.isArray(error.CancellationReasons)
  ) {
    return undefined
  }
  return error.CancellationReasons.map((reason: unknown) =>
    isRecord(reason) && typeof reason.Code === 'string' ? reason.Code : undefined)
}

/**
 * Builds the error of a malformed stored row.
 *
 * @returns The error.
 */
function corrupt(): GitHubIntegrationError {
  return new GitHubIntegrationError('unavailable', 'GitHubIntegrationCorrupt', 'GitHub integration data is unavailable.', { retryable: false })
}

/**
 * Builds the error of a concurrent change.
 *
 * @returns The error.
 */
function conflict(): GitHubIntegrationError {
  return new GitHubIntegrationError('conflict', 'GitHubIntegrationConflict', 'The GitHub setting changed. Reload and try again.')
}

/**
 * Maps a storage failure to an `unavailable` error.
 *
 * @param error - Thrown error.
 * @returns Never.
 */
function storageFailure(error: unknown): never {
  if (error instanceof GitHubIntegrationError) throw error
  throw new GitHubIntegrationError('unavailable', 'GitHubIntegrationStorageFailure', 'GitHub integration storage request failed.', { cause: error })
}
