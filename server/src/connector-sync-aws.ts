import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb'
import type { ExternalWorkItemLink } from '@mukuroji/contracts'
import {
  createDefaultSecretProtector,
  type SecretProtector,
} from './developer-platform'
import { ConnectorRuntimeError } from './connector-oauth'
import type {
  CommitConnectorPollCheckpointInput,
  ConnectorPollCheckpointStore,
  ConnectorPollInventory,
  ConnectorPollInventoryPage,
  ConnectorPollInventoryTarget,
  ConnectorWorkItemResourceType,
} from './connector-sync-worker'

/** External link の sparse global inventory partition です。 */
export const CONNECTOR_SYNC_LINK_INVENTORY_KEY = 'CONNECTOR_SYNC_LINK'

/** DynamoDB poll adapter の共通 options です。 */
export type DynamoDbConnectorPollOptions = {
  /** Developer platform single-table 名です。 */
  tableName?: string
  /** External-link inventory に使う GSI 名です。 */
  lookupIndexName?: string
  /** Test または shared runtime が注入する DocumentClient です。 */
  documentClient?: DynamoDBDocumentClient
}

/** Encrypted provider cursor checkpoint store の options です。 */
export type DynamoDbConnectorPollCheckpointStoreOptions =
  DynamoDbConnectorPollOptions & {
    /** Cursor ciphertext を KMS envelope encryption する境界です。 */
    secretProtector?: SecretProtector
  }

/** Poll checkpoint の storage row です。 */
type ConnectorPollCheckpointRow = {
  /** Workspace partition key です。 */
  workspaceId: string
  /** Installation/resource-scoped sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'connector-poll-checkpoint'
  /** Secret-free checkpoint identity です。 */
  value: {
    /** Connector installation ID です。 */
    installationId: string
    /** Provider resource type です。 */
    resourceType: ConnectorWorkItemResourceType
  }
  /** Compare-and-set revision です。 */
  version: number
  /** Optional encrypted provider continuation cursor です。 */
  cursorCiphertext?: string
}

/** GSI locator から読み直す external-link row の必要部分です。 */
type ExternalLinkInventoryRow = {
  /** Workspace partition key です。 */
  workspaceId: string
  /** External link sort key です。 */
  recordKey: string
  /** Row discriminator です。 */
  entryType: 'external-link'
  /** Secret を含まない external-link snapshot です。 */
  value: ExternalWorkItemLink
}

/** Provider cursor を KMS-encrypted single-table row へ CAS 保存します。 */
export class DynamoDbConnectorPollCheckpointStore
implements ConnectorPollCheckpointStore {
  /** Developer platform single-table 名です。 */
  private readonly tableName: string
  /** DynamoDB document client です。 */
  private readonly documentClient: DynamoDBDocumentClient
  /** Provider cursor encryption boundary です。 */
  private readonly secretProtector: SecretProtector

  /** Environment または明示 options から checkpoint store を作成します。 */
  constructor(options: DynamoDbConnectorPollCheckpointStoreOptions = {}) {
    this.tableName = readText(
      options.tableName ?? process.env.DEVELOPER_PLATFORM_TABLE_NAME ??
        'mukuroji-developer-platform-local',
      'Developer platform table name',
    )
    this.documentClient = options.documentClient ?? createDocumentClient()
    this.secretProtector = options.secretProtector ?? createDefaultSecretProtector()
  }

  /** Current checkpoint を consistent read し、cursor を worker 内だけで復号します。 */
  async get(keyValue: Parameters<ConnectorPollCheckpointStore['get']>[0]) {
    const key = normalizeCheckpointKey(keyValue)
    try {
      const response = await this.documentClient.send(new GetCommand({
        TableName: this.tableName,
        Key: {
          workspaceId: key.workspaceId,
          recordKey: checkpointRecordKey(key.installationId, key.resourceType),
        },
        ConsistentRead: true,
      }))
      if (!response.Item) return undefined
      const row = readCheckpointRow(response.Item, key)
      const cursor = row.cursorCiphertext === undefined
        ? undefined
        : await this.secretProtector.unprotect(
            row.cursorCiphertext,
            checkpointProtectionContext(key),
          )
      return {
        revision: row.version,
        ...(cursor === undefined ? {} : { cursor: readCursor(cursor) }),
      }
    } catch (error) {
      if (error instanceof ConnectorRuntimeError) throw error
      throw persistenceUnavailable(error)
    }
  }

  /** Expected revision と一致する場合だけ encrypted next cursor を保存します。 */
  async compareAndSet(inputValue: CommitConnectorPollCheckpointInput) {
    const key = normalizeCheckpointKey(inputValue)
    const expectedRevision = inputValue.expectedRevision
    if (
      expectedRevision !== undefined &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
    ) throw new TypeError('Connector poll checkpoint revision is invalid.')
    const nextCursor = inputValue.nextCursor === undefined
      ? undefined
      : readCursor(inputValue.nextCursor)
    const cursorCiphertext = nextCursor === undefined
      ? undefined
      : await this.secretProtector.protect(
          nextCursor,
          checkpointProtectionContext(key),
        )
    const row: ConnectorPollCheckpointRow = {
      workspaceId: key.workspaceId,
      recordKey: checkpointRecordKey(key.installationId, key.resourceType),
      entryType: 'connector-poll-checkpoint',
      value: {
        installationId: key.installationId,
        resourceType: key.resourceType,
      },
      version: (expectedRevision ?? 0) + 1,
      ...(cursorCiphertext ? { cursorCiphertext } : {}),
    }
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: row,
        ...(expectedRevision === undefined
          ? {
              ConditionExpression:
                'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
            }
          : {
              ConditionExpression: '#version = :expectedVersion',
              ExpressionAttributeNames: { '#version': 'version' },
              ExpressionAttributeValues: { ':expectedVersion': expectedRevision },
            }),
      }))
      return true
    } catch (error) {
      if (isConditionalFailure(error)) return false
      throw persistenceUnavailable(error)
    }
  }
}

/** Sparse external-link GSI を secret-free scheduled poll targets へ射影します。 */
export class DynamoDbConnectorPollInventory implements ConnectorPollInventory {
  /** Developer platform single-table 名です。 */
  private readonly tableName: string
  /** External link inventory GSI 名です。 */
  private readonly lookupIndexName: string
  /** DynamoDB document client です。 */
  private readonly documentClient: DynamoDBDocumentClient

  /** Environment または明示 options から global inventory を作成します。 */
  constructor(options: DynamoDbConnectorPollOptions = {}) {
    this.tableName = readText(
      options.tableName ?? process.env.DEVELOPER_PLATFORM_TABLE_NAME ??
        'mukuroji-developer-platform-local',
      'Developer platform table name',
    )
    this.lookupIndexName = readText(
      options.lookupIndexName ?? process.env.DEVELOPER_PLATFORM_LOOKUP_INDEX_NAME ??
        'LookupKeyIndex',
      'Developer platform lookup index name',
    )
    this.documentClient = options.documentClient ?? createDocumentClient()
  }

  /** One GSI page を読み、current inbound/bidirectional links だけを返します。 */
  async listPollTargets(cursor?: string): Promise<ConnectorPollInventoryPage> {
    const exclusiveStartKey = cursor === undefined
      ? undefined
      : decodeInventoryCursor(cursor)
    try {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        IndexName: this.lookupIndexName,
        KeyConditionExpression: 'lookupKey = :lookupKey',
        ExpressionAttributeValues: {
          ':lookupKey': CONNECTOR_SYNC_LINK_INVENTORY_KEY,
        },
        Limit: 50,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))
      const targets = new Map<string, ConnectorPollInventoryTarget>()
      await Promise.all((response.Items ?? []).map(async (locator) => {
        const workspaceId = readIdentifier(locator.workspaceId, 'Workspace ID')
        const recordKey = readIdentifier(locator.recordKey, 'External link record key')
        const item = await this.documentClient.send(new GetCommand({
          TableName: this.tableName,
          Key: { workspaceId, recordKey },
          ConsistentRead: true,
        }))
        if (!item.Item) return
        const row = readExternalLinkRow(item.Item, workspaceId, recordKey)
        const link = row.value
        if (
          link.syncStatus === 'paused' ||
          link.syncStatus === 'conflict' ||
          (link.syncDirection !== 'inbound' && link.syncDirection !== 'bidirectional')
        ) return
        const target: ConnectorPollInventoryTarget = {
          workspaceId,
          installationId: readIdentifier(
            link.installationId,
            'Connector installation ID',
          ),
          resourceType: readResourceType(link.resourceType),
        }
        targets.set(
          `${target.workspaceId}\0${target.installationId}\0${target.resourceType}`,
          target,
        )
      }))
      return {
        targets: [...targets.values()],
        ...(response.LastEvaluatedKey
          ? { nextCursor: encodeInventoryCursor(response.LastEvaluatedKey) }
          : {}),
      }
    } catch (error) {
      if (error instanceof ConnectorRuntimeError) throw error
      throw persistenceUnavailable(error)
    }
  }
}

function createDocumentClient() {
  const endpoint = process.env.DYNAMODB_ENDPOINT ?? process.env.AWS_ENDPOINT_URL_DYNAMODB ??
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

function normalizeCheckpointKey(
  value: Parameters<ConnectorPollCheckpointStore['get']>[0],
) {
  return {
    workspaceId: readIdentifier(value.workspaceId, 'Workspace ID'),
    installationId: readIdentifier(value.installationId, 'Connector installation ID'),
    resourceType: readResourceType(value.resourceType),
  }
}

function readCheckpointRow(
  value: Record<string, unknown>,
  key: ReturnType<typeof normalizeCheckpointKey>,
): ConnectorPollCheckpointRow {
  if (
    value.workspaceId !== key.workspaceId ||
    value.recordKey !== checkpointRecordKey(key.installationId, key.resourceType) ||
    value.entryType !== 'connector-poll-checkpoint' ||
    !isRecord(value.value) ||
    value.value.installationId !== key.installationId ||
    value.value.resourceType !== key.resourceType ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 1 ||
    (value.cursorCiphertext !== undefined && typeof value.cursorCiphertext !== 'string')
  ) throw storedRowInvalid()
  return value as ConnectorPollCheckpointRow
}

function readExternalLinkRow(
  value: Record<string, unknown>,
  workspaceId: string,
  recordKey: string,
): ExternalLinkInventoryRow {
  if (
    value.workspaceId !== workspaceId ||
    value.recordKey !== recordKey ||
    value.entryType !== 'external-link' ||
    !isRecord(value.value)
  ) throw storedRowInvalid()
  return value as ExternalLinkInventoryRow
}

function checkpointRecordKey(
  installationId: string,
  resourceType: ConnectorWorkItemResourceType,
) {
  return `CONNECTORPOLL#${installationId}#${resourceType}`
}

function checkpointProtectionContext(
  key: ReturnType<typeof normalizeCheckpointKey>,
) {
  return `mukuroji:platform-state:connector-poll:v1\0${key.workspaceId}\0` +
    `${key.installationId}\0${key.resourceType}`
}

function encodeInventoryCursor(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeInventoryCursor(value: string) {
  if (!value || value.length > 8_192) throw new TypeError('Poll inventory cursor is invalid.')
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (!isRecord(decoded)) throw new TypeError('Poll inventory cursor is invalid.')
    return decoded
  } catch (error) {
    if (error instanceof TypeError) throw error
    throw new TypeError('Poll inventory cursor is invalid.')
  }
}

function readResourceType(value: unknown): ConnectorWorkItemResourceType {
  if (
    value === 'issue' ||
    value === 'merge-request' ||
    value === 'commit' ||
    value === 'deploy'
  ) return value
  throw storedRowInvalid()
}

function readCursor(value: string) {
  if (!value || value.length > 8_192 || hasControlCharacter(value)) {
    throw new TypeError('Connector poll cursor is invalid.')
  }
  return value
}

function readText(value: string, label: string) {
  const normalized = value.trim()
  if (!normalized || normalized.length > 2_048) throw new TypeError(`${label} is invalid.`)
  return normalized
}

function readIdentifier(value: unknown, label: string) {
  if (typeof value !== 'string') throw new TypeError(`${label} is required.`)
  const normalized = value.trim()
  if (!normalized || normalized.length > 256 || hasControlCharacter(normalized)) {
    throw new TypeError(`${label} is invalid.`)
  }
  return normalized
}

function isConditionalFailure(error: unknown) {
  return isRecord(error) && error.name === 'ConditionalCheckFailedException'
}

function storedRowInvalid() {
  return new ConnectorRuntimeError(
    'ConnectorPollStateInvalid',
    'Stored connector poll state is invalid.',
  )
}

function persistenceUnavailable(_error: unknown) {
  return new ConnectorRuntimeError(
    'ConnectorPollPersistenceUnavailable',
    'Connector poll persistence is temporarily unavailable.',
    { retryable: true },
  )
}

function hasControlCharacter(value: string) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
