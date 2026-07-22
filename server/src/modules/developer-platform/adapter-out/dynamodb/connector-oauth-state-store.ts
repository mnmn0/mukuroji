import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb'
import { ConnectorRuntimeError } from '../../connector-oauth'
import type {
  ConnectorOAuthStateStore,
  StoredConnectorOAuthState,
} from '../../connector-oauth-state'

/** Options used to construct the DynamoDB connector OAuth state adapter. */
export type DynamoDbConnectorOAuthStateStoreOptions = {
  /** Developer Platform compatible table name. */
  tableName: string
  /** Document client injected by tests or the production composition root. */
  documentClient?: DynamoDBDocumentClient
}

/** DynamoDB adapter for encrypted, single-use connector OAuth state. */
export class DynamoDbConnectorOAuthStateStore implements ConnectorOAuthStateStore {
  /** DynamoDB table name. */
  private readonly tableName: string
  /** DynamoDB document client. */
  private readonly documentClient: DynamoDBDocumentClient

  /** Creates a DynamoDB-backed OAuth state store. */
  constructor(options: DynamoDbConnectorOAuthStateStoreOptions) {
    if (!options.tableName.trim()) {
      throw new ConnectorRuntimeError(
        'ConnectorOAuthStateStoreInvalid',
        'Connector OAuth state table name is required.',
      )
    }
    this.tableName = options.tableName
    this.documentClient = options.documentClient ??
      DynamoDBDocumentClient.from(new DynamoDBClient({}))
  }

  /** Stores encrypted state while rejecting state identifier collisions. */
  async put(state: StoredConnectorOAuthState) {
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          workspaceId: statePartitionKey(state.stateId),
          recordKey: stateRecordKey(state.stateId),
          entryType: 'connector-oauth-state',
          protectedPayload: state.protectedPayload,
          expiresAt: state.expiresAtEpochSeconds,
          version: 1,
        },
        ConditionExpression:
          'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
      }))
    } catch (error) {
      if (isConditionalCheckFailure(error)) {
        throw new ConnectorRuntimeError(
          'ConnectorOAuthStateCollision',
          'Connector OAuth state ID already exists.',
        )
      }
      throw error
    }
  }

  /** Reads encrypted state without consuming it. */
  async get(stateId: string) {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        workspaceId: statePartitionKey(stateId),
        recordKey: stateRecordKey(stateId),
      },
      ConsistentRead: true,
    }))
    return response.Item ? readStoredState(response.Item, stateId) : undefined
  }

  /** Atomically consumes encrypted state through DeleteItem return values. */
  async consume(stateId: string) {
    const response = await this.documentClient.send(new DeleteCommand({
      TableName: this.tableName,
      Key: {
        workspaceId: statePartitionKey(stateId),
        recordKey: stateRecordKey(stateId),
      },
      ReturnValues: 'ALL_OLD',
    }))
    if (!response.Attributes) return undefined
    return readStoredState(response.Attributes, stateId)
  }
}

/**
 * Creates the DynamoDB OAuth state adapter from runtime configuration.
 *
 * @param environment - Environment containing the Developer Platform table name.
 * @param documentClient - Optional injected DynamoDB document client.
 * @returns A configured DynamoDB OAuth state adapter.
 */
export function createDynamoDbConnectorOAuthStateStoreFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  documentClient?: DynamoDBDocumentClient,
) {
  const tableName = environment.DEVELOPER_PLATFORM_TABLE_NAME
  if (!tableName) {
    throw new ConnectorRuntimeError(
      'ConnectorOAuthStateStoreInvalid',
      'DEVELOPER_PLATFORM_TABLE_NAME is required for connector OAuth state.',
    )
  }
  return new DynamoDbConnectorOAuthStateStore({
    tableName,
    ...(documentClient ? { documentClient } : {}),
  })
}

/** Reads one persisted OAuth state row and rejects unknown schema. */
function readStoredState(
  value: Record<string, unknown>,
  expectedStateId: string,
): StoredConnectorOAuthState {
  if (
    value.entryType !== 'connector-oauth-state' ||
    typeof value.protectedPayload !== 'string' ||
    !value.protectedPayload ||
    typeof value.expiresAt !== 'number' ||
    !Number.isSafeInteger(value.expiresAt)
  ) {
    throw new ConnectorRuntimeError(
      'ConnectorOAuthStateInvalid',
      'Stored connector OAuth state is malformed.',
    )
  }
  return {
    stateId: expectedStateId,
    protectedPayload: value.protectedPayload,
    expiresAtEpochSeconds: value.expiresAt,
  }
}

/** Creates the sharded partition key for an OAuth state identifier. */
function statePartitionKey(stateId: string) {
  const safeStateId = requireIdentifier(stateId)
  return `CONNECTOR-OAUTH-STATE#${safeStateId.slice(0, 2)}`
}

/** Creates the sort key for an OAuth state identifier. */
function stateRecordKey(stateId: string) {
  return `STATE#${requireIdentifier(stateId)}`
}

/** Validates a state identifier at the persistence boundary. */
function requireIdentifier(value: unknown) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 512 ||
    value !== value.trim() ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)
    })
  ) {
    throw new ConnectorRuntimeError(
      'ConnectorOAuthFlowInvalid',
      'OAuth state ID is invalid.',
    )
  }
  return value
}

/** Returns whether DynamoDB rejected a conditional write. */
function isConditionalCheckFailure(error: unknown) {
  return isRecord(error) && error.name === 'ConditionalCheckFailedException'
}

/** Narrows an unknown value to a string-keyed object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
