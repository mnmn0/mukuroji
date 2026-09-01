import { randomUUID } from 'node:crypto'
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb'
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import type {
  CreateCustomerContactInput,
  CreateCustomerInput,
  CreateCustomerRequestInput,
  CreateCustomerSavedViewInput,
  Customer,
  CustomerCompletionNotification,
  CustomerContact,
  CustomerDetail,
  CustomerImpactSignal,
  CustomerListInput,
  CustomerPage,
  LinkCustomerRequestProjectInput,
  CustomerRequest,
  CustomerRequestListInput,
  CustomerRequestPage,
  CustomerRetentionResult,
  CustomerSavedView,
  CustomerWorkspaceExport,
  CustomerWorkItemSummary,
  LinkCustomerRequestWorkItemInput,
  MergeCustomerContactInput,
  MergeCustomerInput,
  MergeCustomerRequestInput,
  UpdateCustomerContactInput,
  UpdateCustomerInput,
  UpdateCustomerRequestInput,
  UpdateCustomerSavedViewInput,
} from '@mukuroji/contracts'
import {
  CustomerError,
} from '../../domain/customer'
import {
  InMemoryCustomerClient,
  type CustomerClient,
  type CustomerWorkspaceState,
} from '../../customers'
import { loadServerConfig } from '../../../../infrastructure/config/server-config'

/** Maximum number of Customer records written alongside one metadata fence. */
const CUSTOMER_TRANSACTION_RECORD_LIMIT = 99

/** Physical prefixes used to select one Customer record category. */
const CUSTOMER_RECORD_PREFIX = 'CUSTOMER#'
const CONTACT_RECORD_PREFIX = 'CONTACT#'
const REQUEST_RECORD_PREFIX = 'REQUEST#'
const VIEW_RECORD_PREFIX = 'VIEW#'
const NOTIFICATION_RECORD_PREFIX = 'NOTIFICATION#'

/** DynamoDB construction options for the Customer adapter. */
export type DynamoDbCustomerClientOptions = {
  /** Customer table name. */
  tableName?: string
  /** Caller-owned DocumentClient. */
  documentClient?: DynamoDBDocumentClient
  /** Low-level client used when no DocumentClient is supplied. */
  dynamoDbClient?: DynamoDBClient
  /** Whether a missing table may be created against an explicit local endpoint. */
  bootstrapLocalTable?: boolean
  /** Test-replaceable clock. */
  now?: () => Date
  /** Test-replaceable ID generator. */
  id?: () => string
}

/** DynamoDB-backed Customer, Contact, and Customer Request client. */
export class DynamoDbCustomerClient implements CustomerClient {
  /** Durable Customer table name. */
  private readonly tableName: string

  /** Document client used for reads and transactions. */
  private readonly documentClient: DynamoDBDocumentClient

  /** Low-level client used for optional local table bootstrap. */
  private readonly dynamoDbClient: DynamoDBClient

  /** Whether local table bootstrap is enabled. */
  private readonly bootstrapLocalTable: boolean

  /** Test-replaceable clock. */
  private readonly now: () => Date

  /** Test-replaceable ID generator. */
  private readonly id: () => string

  /** In-flight local table initialization. */
  private tableReady?: Promise<void>

  /** Creates a DynamoDB-backed Customer client. */
  constructor(options: DynamoDbCustomerClientOptions = {}) {
    const serverConfig = loadServerConfig()
    const endpoint = serverConfig.dynamoDbEndpoint
    this.dynamoDbClient = options.dynamoDbClient ?? new DynamoDBClient({
      region: serverConfig.awsRegion,
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
    this.documentClient = options.documentClient ?? DynamoDBDocumentClient.from(this.dynamoDbClient, {
      marshallOptions: { removeUndefinedValues: true },
    })
    const configuredTableName = options.tableName?.trim() || serverConfig.environment.CUSTOMERS_TABLE_NAME?.trim()
    const localEndpoint = !serverConfig.production && isLocalEndpoint(endpoint)
    const tableName = configuredTableName ?? (localEndpoint ? 'mukuroji-customers-local' : undefined)
    if (!tableName) {
      throw new CustomerError(500, 'CustomerConfigurationMissing', 'CUSTOMERS_TABLE_NAME must be set for durable Customer storage.')
    }
    this.tableName = requireText(tableName, 'Customer table name')
    this.bootstrapLocalTable = options.bootstrapLocalTable ?? localEndpoint
    this.now = options.now ?? (() => new Date())
    this.id = options.id ?? randomUUID
  }

  /** Lists customers within one Workspace boundary. */
  async listCustomers(workspaceId: string, input?: CustomerListInput): Promise<CustomerPage> {
    const { memory } = await this.readMemoryForRead(workspaceId, [
      CUSTOMER_RECORD_PREFIX,
      CONTACT_RECORD_PREFIX,
      REQUEST_RECORD_PREFIX,
    ])
    return await memory.listCustomers(workspaceId, input)
  }

  /** Reads a customer and its related graph. */
  async getCustomer(workspaceId: string, customerId: string): Promise<CustomerDetail> {
    const { memory } = await this.readMemoryForRead(workspaceId, [
      CUSTOMER_RECORD_PREFIX,
      CONTACT_RECORD_PREFIX,
      REQUEST_RECORD_PREFIX,
    ])
    return await memory.getCustomer(workspaceId, customerId)
  }

  /** Creates a customer. */
  async createCustomer(workspaceId: string, actorId: string, input: CreateCustomerInput): Promise<Customer> {
    return await this.mutate(workspaceId, (memory) => memory.createCustomer(workspaceId, actorId, input), [CUSTOMER_RECORD_PREFIX])
  }

  /** Updates a customer under an optimistic revision fence. */
  async updateCustomer(workspaceId: string, customerId: string, actorId: string, input: UpdateCustomerInput): Promise<Customer> {
    return await this.mutate(workspaceId, (memory) => memory.updateCustomer(workspaceId, customerId, actorId, input), [CUSTOMER_RECORD_PREFIX])
  }

  /** Deletes a customer and its owned contacts and requests. */
  async deleteCustomer(workspaceId: string, customerId: string, actorId: string, expectedRevision: number): Promise<void> {
    await this.mutate(workspaceId, async (memory) => await memory.deleteCustomer(workspaceId, customerId, actorId, expectedRevision), [
      CUSTOMER_RECORD_PREFIX,
      CONTACT_RECORD_PREFIX,
      REQUEST_RECORD_PREFIX,
      NOTIFICATION_RECORD_PREFIX,
    ])
  }

  /** Merges a source customer into a retained customer. */
  async mergeCustomer(workspaceId: string, sourceCustomerId: string, actorId: string, input: MergeCustomerInput): Promise<CustomerDetail> {
    return await this.mutate(workspaceId, (memory) => memory.mergeCustomer(workspaceId, sourceCustomerId, actorId, input), [
      CUSTOMER_RECORD_PREFIX,
      CONTACT_RECORD_PREFIX,
      REQUEST_RECORD_PREFIX,
      NOTIFICATION_RECORD_PREFIX,
    ])
  }

  /** Lists contacts belonging to a customer. */
  async listContacts(workspaceId: string, customerId: string): Promise<CustomerContact[]> {
    const { memory } = await this.readMemoryForRead(workspaceId, [CUSTOMER_RECORD_PREFIX, CONTACT_RECORD_PREFIX])
    return await memory.listContacts(workspaceId, customerId)
  }

  /** Reads one contact under its customer boundary. */
  async getContact(workspaceId: string, customerId: string, contactId: string): Promise<CustomerContact> {
    const { memory } = await this.readMemoryForRead(workspaceId, [CUSTOMER_RECORD_PREFIX, CONTACT_RECORD_PREFIX])
    return await memory.getContact(workspaceId, customerId, contactId)
  }

  /** Creates a customer contact. */
  async createContact(workspaceId: string, customerId: string, actorId: string, input: CreateCustomerContactInput): Promise<CustomerContact> {
    return await this.mutate(workspaceId, (memory) => memory.createContact(workspaceId, customerId, actorId, input), [CUSTOMER_RECORD_PREFIX, CONTACT_RECORD_PREFIX])
  }

  /** Updates a customer contact under an optimistic revision fence. */
  async updateContact(workspaceId: string, customerId: string, contactId: string, actorId: string, input: UpdateCustomerContactInput): Promise<CustomerContact> {
    return await this.mutate(workspaceId, (memory) => memory.updateContact(workspaceId, customerId, contactId, actorId, input), [CUSTOMER_RECORD_PREFIX, CONTACT_RECORD_PREFIX])
  }

  /** Deletes a customer contact. */
  async deleteContact(workspaceId: string, customerId: string, contactId: string, actorId: string, expectedRevision: number): Promise<void> {
    await this.mutate(workspaceId, async (memory) => await memory.deleteContact(workspaceId, customerId, contactId, actorId, expectedRevision), [
      CUSTOMER_RECORD_PREFIX,
      CONTACT_RECORD_PREFIX,
      REQUEST_RECORD_PREFIX,
    ])
  }

  /** Merges a source contact into a retained contact. */
  async mergeContact(workspaceId: string, sourceContactId: string, actorId: string, input: MergeCustomerContactInput): Promise<CustomerContact> {
    return await this.mutate(workspaceId, (memory) => memory.mergeContact(workspaceId, sourceContactId, actorId, input), [CONTACT_RECORD_PREFIX, REQUEST_RECORD_PREFIX])
  }

  /** Lists customer requests within a Workspace boundary. */
  async listRequests(workspaceId: string, input?: CustomerRequestListInput): Promise<CustomerRequestPage> {
    const { memory } = await this.readMemoryForRead(workspaceId, [REQUEST_RECORD_PREFIX])
    return await memory.listRequests(workspaceId, input)
  }

  /** Reads one Customer Request. */
  async getRequest(workspaceId: string, requestId: string): Promise<CustomerRequest> {
    const { memory } = await this.readMemoryForRead(workspaceId, [REQUEST_RECORD_PREFIX])
    return await memory.getRequest(workspaceId, requestId)
  }

  /** Creates a Customer Request. */
  async createRequest(workspaceId: string, actorId: string, input: CreateCustomerRequestInput): Promise<CustomerRequest> {
    return await this.mutate(workspaceId, (memory) => memory.createRequest(workspaceId, actorId, input), [
      CUSTOMER_RECORD_PREFIX,
      CONTACT_RECORD_PREFIX,
      REQUEST_RECORD_PREFIX,
    ])
  }

  /** Updates a Customer Request under an optimistic revision fence. */
  async updateRequest(workspaceId: string, requestId: string, actorId: string, input: UpdateCustomerRequestInput): Promise<CustomerRequest> {
    return await this.mutate(workspaceId, (memory) => memory.updateRequest(workspaceId, requestId, actorId, input), [REQUEST_RECORD_PREFIX, CONTACT_RECORD_PREFIX])
  }

  /** Deletes a Customer Request. */
  async deleteRequest(workspaceId: string, requestId: string, actorId: string, expectedRevision: number): Promise<void> {
    await this.mutate(workspaceId, async (memory) => await memory.deleteRequest(workspaceId, requestId, actorId, expectedRevision), [REQUEST_RECORD_PREFIX, NOTIFICATION_RECORD_PREFIX])
  }

  /** Merges a source request into a retained request. */
  async mergeRequest(workspaceId: string, sourceRequestId: string, actorId: string, input: MergeCustomerRequestInput): Promise<CustomerRequest> {
    return await this.mutate(workspaceId, (memory) => memory.mergeRequest(workspaceId, sourceRequestId, actorId, input), [REQUEST_RECORD_PREFIX, NOTIFICATION_RECORD_PREFIX])
  }

  /** Links a request to a Work Item, allowing many requests per Work Item. */
  async linkRequestToWorkItem(workspaceId: string, requestId: string, actorId: string, input: LinkCustomerRequestWorkItemInput): Promise<CustomerRequest> {
    return await this.mutate(workspaceId, (memory) => memory.linkRequestToWorkItem(workspaceId, requestId, actorId, input), [REQUEST_RECORD_PREFIX])
  }

  /** Removes a request-to-Work-Item link under a revision fence. */
  async unlinkRequestFromWorkItem(workspaceId: string, requestId: string, actorId: string, input: LinkCustomerRequestWorkItemInput & { expectedRevision: number }): Promise<CustomerRequest> {
    return await this.mutate(workspaceId, (memory) => memory.unlinkRequestFromWorkItem(workspaceId, requestId, actorId, input), [REQUEST_RECORD_PREFIX])
  }

  /** Links a request directly to a Project, idempotently. */
  async linkRequestToProject(workspaceId: string, requestId: string, actorId: string, input: LinkCustomerRequestProjectInput): Promise<CustomerRequest> {
    return await this.mutate(workspaceId, (memory) => memory.linkRequestToProject(workspaceId, requestId, actorId, input), [REQUEST_RECORD_PREFIX])
  }

  /** Removes a request-to-Project link under a revision fence. */
  async unlinkRequestFromProject(workspaceId: string, requestId: string, actorId: string, input: LinkCustomerRequestProjectInput & { expectedRevision: number }): Promise<CustomerRequest> {
    return await this.mutate(workspaceId, (memory) => memory.unlinkRequestFromProject(workspaceId, requestId, actorId, input), [REQUEST_RECORD_PREFIX])
  }

  /** Returns customer impact for one canonical Work Item. */
  async getWorkItemImpact(workspaceId: string, teamId: string, workItemId: string): Promise<CustomerImpactSignal> {
    const { memory } = await this.readMemoryForRead(workspaceId, [CUSTOMER_RECORD_PREFIX, REQUEST_RECORD_PREFIX])
    return await memory.getWorkItemImpact(workspaceId, teamId, workItemId)
  }

  /** Returns customer impact for one Project. */
  async getProjectImpact(workspaceId: string, projectId: string): Promise<CustomerImpactSignal> {
    const { memory } = await this.readMemoryForRead(workspaceId, [CUSTOMER_RECORD_PREFIX, REQUEST_RECORD_PREFIX])
    return await memory.getProjectImpact(workspaceId, projectId)
  }

  /** Returns Work Items associated with a Customer. */
  async listCustomerWorkItems(workspaceId: string, customerId: string): Promise<CustomerWorkItemSummary[]> {
    const { memory } = await this.readMemoryForRead(workspaceId, [CUSTOMER_RECORD_PREFIX, CONTACT_RECORD_PREFIX, REQUEST_RECORD_PREFIX])
    return await memory.listCustomerWorkItems(workspaceId, customerId)
  }

  /** Lists saved customer directory views. */
  async listSavedViews(workspaceId: string): Promise<CustomerSavedView[]> {
    const { memory } = await this.readMemoryForRead(workspaceId, [VIEW_RECORD_PREFIX])
    return await memory.listSavedViews(workspaceId)
  }

  /** Creates a saved customer directory view. */
  async createSavedView(workspaceId: string, actorId: string, input: CreateCustomerSavedViewInput): Promise<CustomerSavedView> {
    return await this.mutate(workspaceId, (memory) => memory.createSavedView(workspaceId, actorId, input), [VIEW_RECORD_PREFIX])
  }

  /** Updates a saved customer directory view. */
  async updateSavedView(workspaceId: string, viewId: string, actorId: string, input: UpdateCustomerSavedViewInput): Promise<CustomerSavedView> {
    return await this.mutate(workspaceId, (memory) => memory.updateSavedView(workspaceId, viewId, actorId, input), [VIEW_RECORD_PREFIX])
  }

  /** Deletes a saved customer directory view. */
  async deleteSavedView(workspaceId: string, viewId: string, actorId: string, expectedRevision: number): Promise<void> {
    await this.mutate(workspaceId, async (memory) => await memory.deleteSavedView(workspaceId, viewId, actorId, expectedRevision), [VIEW_RECORD_PREFIX])
  }

  /** Exports all Customer-owned records for one Workspace. */
  async exportWorkspace(workspaceId: string): Promise<CustomerWorkspaceExport> {
    const { memory } = await this.readMemoryForRead(workspaceId)
    return await memory.exportWorkspace(workspaceId)
  }

  /** Applies retention redaction to expired Customer-owned records. */
  async redactExpired(workspaceId: string, now = this.now().toISOString()): Promise<CustomerRetentionResult> {
    return await this.mutate(workspaceId, (memory) => memory.redactExpired(workspaceId, now), [
      CUSTOMER_RECORD_PREFIX,
      CONTACT_RECORD_PREFIX,
      REQUEST_RECORD_PREFIX,
    ])
  }

  /** Prepares idempotent completion notification candidates for a Work Item. */
  async prepareCompletionNotifications(workspaceId: string, teamId: string, workItemId: string, actorId: string, now = this.now().toISOString()): Promise<CustomerCompletionNotification[]> {
    return await this.mutate(workspaceId, (memory) => memory.prepareCompletionNotifications(workspaceId, teamId, workItemId, actorId, now), [REQUEST_RECORD_PREFIX, NOTIFICATION_RECORD_PREFIX])
  }

  /** Lists previously prepared completion notification candidates. */
  async listCompletionNotifications(workspaceId: string, teamId: string, workItemId: string): Promise<CustomerCompletionNotification[]> {
    const { memory } = await this.readMemoryForRead(workspaceId, [NOTIFICATION_RECORD_PREFIX])
    return await memory.listCompletionNotifications(workspaceId, teamId, workItemId)
  }

  /** Queries one Customer record category, including all DynamoDB pages.
   *
   * @param workspaceId Workspace partition to query.
   * @param recordPrefix Optional physical record prefix to keep the read focused.
   * @returns Untrusted DynamoDB rows for the selected scope.
   */
  private async queryRows(workspaceId: string, recordPrefix?: string): Promise<unknown[]> {
    const rows: unknown[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: recordPrefix === undefined
          ? 'workspaceId = :workspaceId'
          : 'workspaceId = :workspaceId AND begins_with(recordKey, :recordPrefix)',
        ExpressionAttributeValues: {
          ':workspaceId': workspaceId,
          ...(recordPrefix === undefined ? {} : { ':recordPrefix': recordPrefix }),
        },
        ConsistentRead: true,
        Limit: 250,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))
      rows.push(...response.Items ?? [])
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)
    return rows
  }

  /** Reads the optimistic Workspace revision without loading unrelated records.
   *
   * @param workspaceId Workspace partition containing the META row.
   * @returns The current Workspace graph revision, or zero before the first write.
   */
  private async readWorkspaceRevision(workspaceId: string): Promise<number> {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: 'META' },
      ConsistentRead: true,
    }))
    if (response.Item === undefined) return 0
    const decoded = decodeStoredRow(response.Item, workspaceId)
    if (!decoded || decoded.kind !== 'meta') {
      throw new CustomerError(503, 'CustomerPersistenceCorrupt', 'The Customer metadata row is malformed.')
    }
    return decoded.revision
  }

  /** Loads selected Workspace records and its optimistic control revision.
   *
   * @param workspaceId Workspace partition to load.
   * @param recordPrefixes Optional physical prefixes; omitted loads the full graph.
   * @returns The selected state and its Workspace revision.
   */
  private async load(
    workspaceId: string,
    recordPrefixes?: readonly string[],
  ): Promise<LoadedCustomerWorkspace> {
    await this.ensureTable()
    const state = createEmptyState()
    const revision = await this.readWorkspaceRevision(workspaceId)
    const rows = recordPrefixes === undefined
      ? await this.queryRows(workspaceId)
      : (await Promise.all(recordPrefixes.map((prefix) => this.queryRows(workspaceId, prefix)))).flat()
    for (const row of rows) {
      const decoded = decodeStoredRow(row, workspaceId)
      if (!decoded) throw new CustomerError(503, 'CustomerPersistenceCorrupt', 'A Customer record is malformed.')
      if (decoded.kind === 'meta') {
        if (recordPrefixes === undefined) continue
      } else if (decoded.kind === 'customer') {
        state.customers.set(decoded.value.id, decoded.value)
      } else if (decoded.kind === 'contact') {
        state.contacts.set(decoded.value.id, decoded.value)
      } else if (decoded.kind === 'request') {
        state.requests.set(decoded.value.id, decoded.value)
      } else if (decoded.kind === 'view') {
        state.views.set(decoded.value.id, decoded.value)
      } else {
        state.notifications.set(decoded.value.id, decoded.value)
      }
    }
    return { state, revision }
  }

  /** Loads selected Workspace records into the shared in-memory application implementation.
   *
   * @param workspaceId Workspace partition to load.
   * @param recordPrefixes Optional physical prefixes for a focused load.
   * @returns The in-memory client, loaded revision, and retention changes.
   */
  private async readMemory(
    workspaceId: string,
    recordPrefixes?: readonly string[],
  ): Promise<{
    memory: InMemoryCustomerClient
    loaded: LoadedCustomerWorkspace
    retentionResult: CustomerRetentionResult
  }> {
    const loaded = await this.load(workspaceId, recordPrefixes)
    const memory = new InMemoryCustomerClient({ now: this.now, id: this.id })
    memory.replaceWorkspaceState(workspaceId, loaded.state)
    const retentionResult = await memory.redactExpired(workspaceId, this.now().toISOString())
    return { memory, loaded, retentionResult }
  }

  /** Loads selected Workspace records and persists any retention redaction before returning it.
   *
   * @param workspaceId Workspace partition to load.
   * @param recordPrefixes Optional physical prefixes for a focused load.
   * @returns The in-memory client and loaded revision.
   */
  private async readMemoryForRead(
    workspaceId: string,
    recordPrefixes?: readonly string[],
  ): Promise<{
    memory: InMemoryCustomerClient
    loaded: LoadedCustomerWorkspace
  }> {
    const result = await this.readMemory(workspaceId, recordPrefixes)
    if (
      result.retentionResult.customersRedacted > 0 ||
      result.retentionResult.contactsRedacted > 0 ||
      result.retentionResult.requestsRedacted > 0
    ) {
      await this.persist(workspaceId, result.loaded, result.memory.readWorkspaceState(workspaceId))
    }
    return result
  }

  /** Applies one in-memory operation and durably commits its graph diff.
   *
   * @param workspaceId Workspace partition to mutate.
   * @param operation Application operation executed against the selected state.
   * @param recordPrefixes Physical prefixes required by the operation.
   * @returns The operation result after the durable commit.
   */
  private async mutate<T>(
    workspaceId: string,
    operation: (memory: InMemoryCustomerClient) => Promise<T>,
    recordPrefixes: readonly string[],
  ): Promise<T> {
    const { memory, loaded } = await this.readMemory(workspaceId, recordPrefixes)
    const result = await operation(memory)
    const nextState = memory.readWorkspaceState(workspaceId)
    await this.persist(workspaceId, loaded, nextState)
    return result
  }

  /** Commits one graph diff behind a Workspace-level optimistic fence. */
  private async persist(
    workspaceId: string,
    loaded: LoadedCustomerWorkspace,
    nextState: CustomerWorkspaceState,
  ): Promise<void> {
    const previousRows = new Map(serializeState(workspaceId, loaded.state).map((row) => [row.recordKey, row]))
    const nextRows = new Map(serializeState(workspaceId, nextState).map((row) => [row.recordKey, row]))
    const putItems: NonNullable<TransactWriteCommandInput['TransactItems']> = []
    for (const [recordKey, row] of nextRows) {
      const previous = previousRows.get(recordKey)
      if (!previous || JSON.stringify(previous) !== JSON.stringify(row)) putItems.push({ Put: { TableName: this.tableName, Item: row } })
    }
    const deleteRecordKeys = [...previousRows.keys()]
      .filter((recordKey) => !nextRows.has(recordKey))
      .sort((left, right) => Number(left.startsWith('CUSTOMER#')) - Number(right.startsWith('CUSTOMER#')))
    const deleteItems: NonNullable<TransactWriteCommandInput['TransactItems']> = deleteRecordKeys.map((recordKey) => ({
      Delete: { TableName: this.tableName, Key: { workspaceId, recordKey } },
    }))
    const recordItems = [...putItems, ...deleteItems]
    if (recordItems.length === 0) return
    for (const [batchIndex, batch] of chunk(recordItems, CUSTOMER_TRANSACTION_RECORD_LIMIT).entries()) {
      const expectedRevision = loaded.revision + batchIndex
      const nextRevision = expectedRevision + 1
      const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
        ...batch,
        {
          Put: {
            TableName: this.tableName,
            Item: { workspaceId, recordKey: 'META', entityType: 'meta', revision: nextRevision },
            ConditionExpression: expectedRevision === 0
              ? 'attribute_not_exists(recordKey)'
              : '#revision = :revision',
            ...(expectedRevision === 0
              ? {}
              : {
                  ExpressionAttributeNames: { '#revision': 'revision' },
                  ExpressionAttributeValues: { ':revision': expectedRevision },
                }),
          },
        },
      ]
      try {
        await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactItems }))
      } catch (error) {
        if (isConditionalConflict(error)) throw new CustomerError(409, 'CustomerRevisionConflict', 'Customer data changed. Reload and try again.', { cause: error })
        throw error
      }
    }
  }

  /** Ensures the local development table exists before a read or write. */
  private async ensureTable(): Promise<void> {
    if (!this.bootstrapLocalTable) return
    this.tableReady ??= this.createLocalTableIfMissing()
    await this.tableReady
  }

  /** Creates the minimal local table required by the adapter. */
  private async createLocalTableIfMissing(): Promise<void> {
    try {
      await this.dynamoDbClient.send(new DescribeTableCommand({ TableName: this.tableName }))
      return
    } catch (error) {
      if (!isAwsNamedError(error, 'ResourceNotFoundException')) throw error
    }
    try {
      await this.dynamoDbClient.send(new CreateTableCommand({
        TableName: this.tableName,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'workspaceId', AttributeType: 'S' },
          { AttributeName: 'recordKey', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'workspaceId', KeyType: 'HASH' },
          { AttributeName: 'recordKey', KeyType: 'RANGE' },
        ],
      }))
    } catch (error) {
      if (!isAwsNamedError(error, 'ResourceInUseException')) throw error
    }
    await waitUntilTableExists({ client: this.dynamoDbClient, maxWaitTime: 30 }, { TableName: this.tableName })
  }
}

/** A loaded Customer state and its Workspace mutation fence. */
type LoadedCustomerWorkspace = {
  /** All graph records loaded from DynamoDB. */
  state: CustomerWorkspaceState
  /** Revision stored by the Workspace control row. */
  revision: number
}

/** Stored row variants used by the Customer single-table adapter. */
type StoredCustomerRow =
  | {
      /** Workspace partition key. */
      workspaceId: string
      /** Metadata sort key. */
      recordKey: string
      /** Row discriminator. */
      entityType: 'meta'
      /** Workspace graph revision. */
      revision: number
    }
  | {
      /** Workspace partition key. */
      workspaceId: string
      /** Customer sort key. */
      recordKey: string
      /** Row discriminator. */
      entityType: 'customer'
      /** Persisted Customer value. */
      customer: Customer
    }
  | {
      /** Workspace partition key. */
      workspaceId: string
      /** Contact sort key. */
      recordKey: string
      /** Row discriminator. */
      entityType: 'contact'
      /** Persisted Contact value. */
      contact: CustomerContact
    }
  | {
      /** Workspace partition key. */
      workspaceId: string
      /** Customer Request sort key. */
      recordKey: string
      /** Row discriminator. */
      entityType: 'request'
      /** Persisted Customer Request value. */
      request: CustomerRequest
    }
  | {
      /** Workspace partition key. */
      workspaceId: string
      /** Saved view sort key. */
      recordKey: string
      /** Row discriminator. */
      entityType: 'view'
      /** Persisted saved view value. */
      view: CustomerSavedView
    }
  | {
      /** Workspace partition key. */
      workspaceId: string
      /** Notification sort key. */
      recordKey: string
      /** Row discriminator. */
      entityType: 'completion-notification'
      /** Persisted completion notification value. */
      notification: CustomerCompletionNotification
    }

/** Decoded Customer row variants with a narrowed value. */
type DecodedCustomerRow =
  | {
      /** Narrowed row discriminator. */
      kind: 'meta'
      /** Workspace graph revision. */
      revision: number
    }
  | {
      /** Narrowed row discriminator. */
      kind: 'customer'
      /** Decoded Customer value. */
      value: Customer
    }
  | {
      /** Narrowed row discriminator. */
      kind: 'contact'
      /** Decoded Contact value. */
      value: CustomerContact
    }
  | {
      /** Narrowed row discriminator. */
      kind: 'request'
      /** Decoded Customer Request value. */
      value: CustomerRequest
    }
  | {
      /** Narrowed row discriminator. */
      kind: 'view'
      /** Decoded saved view value. */
      value: CustomerSavedView
    }
  | {
      /** Narrowed row discriminator. */
      kind: 'notification'
      /** Decoded completion notification value. */
      value: CustomerCompletionNotification
    }

/** Creates an empty graph state. */
function createEmptyState(): CustomerWorkspaceState {
  return {
    customers: new Map(),
    contacts: new Map(),
    requests: new Map(),
    views: new Map(),
    notifications: new Map(),
  }
}

/** Serializes all graph records into deterministic Customer rows. */
function serializeState(workspaceId: string, state: CustomerWorkspaceState): StoredCustomerRow[] {
  return [
    ...[...state.customers.values()].map((customer): StoredCustomerRow => ({ workspaceId, recordKey: `CUSTOMER#${customer.id}`, entityType: 'customer', customer })),
    ...[...state.contacts.values()].map((contact): StoredCustomerRow => ({ workspaceId, recordKey: `CONTACT#${contact.id}`, entityType: 'contact', contact })),
    ...[...state.requests.values()].map((request): StoredCustomerRow => ({ workspaceId, recordKey: `REQUEST#${request.id}`, entityType: 'request', request })),
    ...[...state.views.values()].map((view): StoredCustomerRow => ({ workspaceId, recordKey: `VIEW#${view.id}`, entityType: 'view', view })),
    ...[...state.notifications.values()].map((notification): StoredCustomerRow => ({ workspaceId, recordKey: `NOTIFICATION#${notification.id}`, entityType: 'completion-notification', notification })),
  ]
}

/** Strictly decodes one untrusted DynamoDB row. */
function decodeStoredRow(value: unknown, workspaceId: string): DecodedCustomerRow | undefined {
  if (!isRecord(value) || value.workspaceId !== workspaceId || typeof value.recordKey !== 'string') return undefined
  if (value.entityType === 'meta' && value.recordKey === 'META' && isSafeRevision(value.revision)) return { kind: 'meta', revision: value.revision }
  if (value.entityType === 'customer' && isCustomer(value.customer) && value.customer.workspaceId === workspaceId && value.recordKey === `CUSTOMER#${value.customer.id}`) return { kind: 'customer', value: value.customer }
  if (value.entityType === 'contact' && isContact(value.contact) && value.contact.workspaceId === workspaceId && value.recordKey === `CONTACT#${value.contact.id}`) return { kind: 'contact', value: value.contact }
  if (value.entityType === 'request' && isRequest(value.request) && value.request.workspaceId === workspaceId && value.recordKey === `REQUEST#${value.request.id}`) return { kind: 'request', value: value.request }
  if (value.entityType === 'view' && isSavedView(value.view) && value.view.workspaceId === workspaceId && value.recordKey === `VIEW#${value.view.id}`) return { kind: 'view', value: value.view }
  if (value.entityType === 'completion-notification' && isNotification(value.notification) && value.notification.workspaceId === workspaceId && value.recordKey === `NOTIFICATION#${value.notification.id}`) return { kind: 'notification', value: value.notification }
  return undefined
}

/** Performs a small structural Customer validation at the persistence boundary. */
function isCustomer(value: unknown): value is Customer {
  return isRecord(value) && value.schemaVersion === 1 && isString(value.id) && isString(value.workspaceId) && isString(value.name) &&
    isOneOf(value.tier, ['strategic', 'enterprise', 'growth', 'standard', 'trial']) &&
    isOneOf(value.size, ['startup', 'small', 'mid-market', 'enterprise']) &&
    isOneOf(value.status, ['prospect', 'active', 'inactive', 'churned']) &&
    isOneOf(value.health, ['healthy', 'watch', 'at-risk', 'critical', 'unknown']) &&
    isOptionalString(value.domain) && isOptionalString(value.ownerUserId) &&
    (value.businessValue === undefined || isNonnegativeNumber(value.businessValue) && value.businessValue <= 100) &&
    isOptionalString(value.notes) && isOptionalRetention(value.retention) &&
    isSafeNonnegativeInteger(value.contactCount) && isSafeNonnegativeInteger(value.requestCount) &&
    isSafeNonnegativeInteger(value.openRequestCount) && isSafeRevision(value.revision) &&
    isIsoInstant(value.createdAt) && isIsoInstant(value.updatedAt)
}

/** Performs a small structural Contact validation at the persistence boundary. */
function isContact(value: unknown): value is CustomerContact {
  return isRecord(value) && isString(value.id) && isString(value.workspaceId) && isString(value.customerId) && isString(value.name) &&
    isOptionalString(value.email) && isOptionalString(value.role) && isOptionalString(value.phone) &&
    typeof value.primary === 'boolean' && (value.status === 'active' || value.status === 'inactive') &&
    isOptionalRetention(value.retention) && isSafeRevision(value.revision) &&
    isIsoInstant(value.createdAt) && isIsoInstant(value.updatedAt)
}

/** Performs a small structural Customer Request validation at the persistence boundary. */
function isRequest(value: unknown): value is CustomerRequest {
  return isRecord(value) && value.schemaVersion === 1 && isString(value.id) && isString(value.workspaceId) && isString(value.customerId) &&
    isOptionalString(value.contactId) && isOptionalString(value.triageEntryId) && isRequestSource(value.source) &&
    isString(value.originalMessage) && isIsoInstant(value.receivedAt) &&
    isOneOf(value.importance, ['low', 'normal', 'high', 'urgent']) &&
    isOneOf(value.status, ['requested', 'in-progress', 'completed', 'closed', 'merged']) &&
    isOptionalString(value.mergedIntoRequestId) &&
    (value.mergedAt === undefined || isIsoInstant(value.mergedAt)) && isOptionalString(value.mergedBy) &&
    isOptionalExternalReference(value.externalReference) &&
    Array.isArray(value.workItemLinks) && value.workItemLinks.every(isWorkItemLink) &&
    Array.isArray(value.projectLinks) && value.projectLinks.every(isProjectLink) &&
    isOptionalRetention(value.retention) && isSafeRevision(value.revision) &&
    isIsoInstant(value.createdAt) && isIsoInstant(value.updatedAt)
}

/** Performs a small structural saved-view validation at the persistence boundary. */
function isSavedView(value: unknown): value is CustomerSavedView {
  return isRecord(value) && isString(value.id) && isString(value.workspaceId) && isString(value.name) &&
    isCustomerListInput(value.filters) && isOptionalOneOf(value.groupBy, ['tier', 'size', 'status', 'health', 'owner']) &&
    isSafeRevision(value.revision) && isIsoInstant(value.createdAt) && isIsoInstant(value.updatedAt)
}

/** Performs a small structural notification validation at the persistence boundary. */
function isNotification(value: unknown): value is CustomerCompletionNotification {
  return isRecord(value) && isString(value.id) && isString(value.workspaceId) && isString(value.requestId) &&
    isString(value.customerId) && isString(value.teamId) && isString(value.workItemId) &&
    typeof value.canNotify === 'boolean' && isOptionalOneOf(value.skipReason, ['source-not-capable', 'permission-restricted', 'retention-redacted']) &&
    isIsoInstant(value.preparedAt)
}

/** Validates the provider-neutral source metadata on a Customer Request. */
function isRequestSource(value: unknown): boolean {
  return isRecord(value) && isOneOf(value.kind, [
    'form',
    'chat',
    'email',
    'webhook',
    'manual-handoff',
    'portal',
    'phone',
    'manual',
  ]) && isOptionalString(value.provider) && isOptionalString(value.referenceId) &&
    isOptionalString(value.permalink) && typeof value.canNotify === 'boolean'
}

/** Validates an optional Customer Request external reference. */
function isOptionalExternalReference(value: unknown): boolean {
  return value === undefined || isRecord(value) && isString(value.provider) && isString(value.id) && isOptionalString(value.permalink)
}

/** Validates a Work Item link retained on a Customer Request. */
function isWorkItemLink(value: unknown): boolean {
  return isRecord(value) && isString(value.teamId) && isString(value.workItemId) &&
    isOptionalString(value.projectId) && isIsoInstant(value.linkedAt) && isString(value.linkedBy)
}

/** Validates a Project link retained on a Customer Request. */
function isProjectLink(value: unknown): boolean {
  return isRecord(value) && isString(value.projectId) && isIsoInstant(value.linkedAt) && isString(value.linkedBy)
}

/** Validates the filter fields persisted in a saved Customer directory view. */
function isCustomerListInput(value: unknown): boolean {
  return isRecord(value) && isOptionalString(value.search) &&
    isOptionalOneOf(value.tier, ['strategic', 'enterprise', 'growth', 'standard', 'trial']) &&
    isOptionalOneOf(value.size, ['startup', 'small', 'mid-market', 'enterprise']) &&
    isOptionalOneOf(value.status, ['prospect', 'active', 'inactive', 'churned']) &&
    isOptionalOneOf(value.health, ['healthy', 'watch', 'at-risk', 'critical', 'unknown']) &&
    (value.minBusinessValue === undefined || isNonnegativeNumber(value.minBusinessValue) && value.minBusinessValue <= 100) &&
    (value.minRequestCount === undefined || isSafeNonnegativeInteger(value.minRequestCount)) &&
    isOptionalOneOf(value.sortBy, ['name', 'tier', 'size', 'status', 'health', 'businessValue', 'requestCount', 'openRequestCount', 'updatedAt']) &&
    isOptionalOneOf(value.sortDirection, ['ascending', 'descending']) && isOptionalString(value.cursor)
}

/** Validates optional retention metadata. */
function isOptionalRetention(value: unknown): boolean {
  return value === undefined || isRecord(value) &&
    (value.expiresAt === undefined || isIsoInstant(value.expiresAt)) &&
    (value.redactedAt === undefined || isIsoInstant(value.redactedAt))
}

/** Validates an optional member of a finite string union. */
function isOptionalOneOf<const Expected extends string>(value: unknown, values: readonly Expected[]): boolean {
  return value === undefined || isOneOf(value, values)
}

/** Validates a nonnegative safe integer. */
function isSafeNonnegativeInteger(value: unknown): value is number {
  return isSafeRevision(value)
}

/** Validates an ISO instant stored at a persistence boundary. */
function isIsoInstant(value: unknown): value is string {
  return isString(value) && Number.isFinite(Date.parse(value))
}

/** Checks whether a stored revision is safe. */
function isSafeRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Checks whether a value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Checks whether an untrusted value is a string. */
function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** Checks whether an untrusted optional value is a string. */
function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value)
}

/** Checks whether an untrusted value is a finite nonnegative number. */
function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Checks whether an untrusted value belongs to a finite string union. */
function isOneOf<const Expected extends string>(value: unknown, values: readonly Expected[]): value is Expected {
  return isString(value) && values.some((candidate) => candidate === value)
}

/** Reads a bounded non-empty string. */
function requireText(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 1_000) throw new CustomerError(500, 'InvalidCustomerConfiguration', `${label} is invalid.`)
  return normalized
}

/** Returns whether a configured endpoint is an explicitly local origin. */
function isLocalEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return false
  try {
    const url = new URL(endpoint)
    return url.protocol === 'http:' && !url.username && !url.password && ['localhost', '127.0.0.1', 'floci', 'localstack'].includes(url.hostname)
  } catch {
    return false
  }
}

/** Classifies a conditional DynamoDB failure.
 *
 * @param error Untrusted DynamoDB failure.
 * @returns Whether the failure contains a failed conditional check and can be mapped to a revision conflict.
 */
function isConditionalConflict(error: unknown): boolean {
  if (isAwsNamedError(error, 'ConditionalCheckFailedException')) return true
  if (!isAwsNamedError(error, 'TransactionCanceledException') || !isRecord(error) || !Array.isArray(error.CancellationReasons)) {
    return false
  }
  let hasConditionalFailure = false
  for (const reason of error.CancellationReasons) {
    if (!isRecord(reason) || typeof reason.Code !== 'string') return false
    if (reason.Code === 'ConditionalCheckFailed') {
      hasConditionalFailure = true
    } else if (reason.Code !== 'None') {
      return false
    }
  }
  return hasConditionalFailure
}

/** Checks an AWS error name without trusting an unknown value. */
function isAwsNamedError(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name
}

/** Splits a Customer mutation into DynamoDB-sized, revision-fenced batches.
 *
 * @param values Transaction items to split.
 * @param size Maximum number of record items per batch.
 * @returns Ordered batches that preserve the input order.
 */
function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}
