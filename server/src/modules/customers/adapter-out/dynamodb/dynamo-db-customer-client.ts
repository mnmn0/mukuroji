import { randomUUID } from 'node:crypto'
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
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
    const endpoint = process.env.DYNAMODB_ENDPOINT?.trim() || process.env.MUKUROJI_DYNAMODB_ENDPOINT?.trim()
    this.dynamoDbClient = options.dynamoDbClient ?? new DynamoDBClient({
      region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
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
    this.tableName = requireText(
      options.tableName ?? process.env.CUSTOMERS_TABLE_NAME ?? 'mukuroji-customers-local',
      'Customer table name',
    )
    this.bootstrapLocalTable = options.bootstrapLocalTable ?? isLocalEndpoint(endpoint)
    this.now = options.now ?? (() => new Date())
    this.id = options.id ?? randomUUID
  }

  /** Lists customers within one Workspace boundary. */
  async listCustomers(workspaceId: string, input?: CustomerListInput): Promise<CustomerPage> {
    const { memory } = await this.readMemoryForRead(workspaceId)
    return await memory.listCustomers(workspaceId, input)
  }

  /** Reads a customer and its related graph. */
  async getCustomer(workspaceId: string, customerId: string): Promise<CustomerDetail> {
    const { memory } = await this.readMemoryForRead(workspaceId)
    return await memory.getCustomer(workspaceId, customerId)
  }

  /** Creates a customer. */
  async createCustomer(workspaceId: string, actorId: string, input: CreateCustomerInput): Promise<Customer> {
    return await this.mutate(workspaceId, (memory) => memory.createCustomer(workspaceId, actorId, input))
  }

  /** Updates a customer under an optimistic revision fence. */
  async updateCustomer(workspaceId: string, customerId: string, actorId: string, input: UpdateCustomerInput): Promise<Customer> {
    return await this.mutate(workspaceId, (memory) => memory.updateCustomer(workspaceId, customerId, actorId, input))
  }

  /** Deletes a customer and its owned contacts and requests. */
  async deleteCustomer(workspaceId: string, customerId: string, actorId: string, expectedRevision: number): Promise<void> {
    await this.mutate(workspaceId, async (memory) => await memory.deleteCustomer(workspaceId, customerId, actorId, expectedRevision))
  }

  /** Merges a source customer into a retained customer. */
  async mergeCustomer(workspaceId: string, sourceCustomerId: string, actorId: string, input: MergeCustomerInput): Promise<CustomerDetail> {
    return await this.mutate(workspaceId, (memory) => memory.mergeCustomer(workspaceId, sourceCustomerId, actorId, input))
  }

  /** Lists contacts belonging to a customer. */
  async listContacts(workspaceId: string, customerId: string): Promise<CustomerContact[]> {
    const { memory } = await this.readMemoryForRead(workspaceId)
    return await memory.listContacts(workspaceId, customerId)
  }

  /** Reads one contact under its customer boundary. */
  async getContact(workspaceId: string, customerId: string, contactId: string): Promise<CustomerContact> {
    const { memory } = await this.readMemoryForRead(workspaceId)
    return await memory.getContact(workspaceId, customerId, contactId)
  }

  /** Creates a customer contact. */
  async createContact(workspaceId: string, customerId: string, actorId: string, input: CreateCustomerContactInput): Promise<CustomerContact> {
    return await this.mutate(workspaceId, (memory) => memory.createContact(workspaceId, customerId, actorId, input))
  }

  /** Updates a customer contact under an optimistic revision fence. */
  async updateContact(workspaceId: string, customerId: string, contactId: string, actorId: string, input: UpdateCustomerContactInput): Promise<CustomerContact> {
    return await this.mutate(workspaceId, (memory) => memory.updateContact(workspaceId, customerId, contactId, actorId, input))
  }

  /** Deletes a customer contact. */
  async deleteContact(workspaceId: string, customerId: string, contactId: string, actorId: string, expectedRevision: number): Promise<void> {
    await this.mutate(workspaceId, async (memory) => await memory.deleteContact(workspaceId, customerId, contactId, actorId, expectedRevision))
  }

  /** Merges a source contact into a retained contact. */
  async mergeContact(workspaceId: string, sourceContactId: string, actorId: string, input: MergeCustomerContactInput): Promise<CustomerContact> {
    return await this.mutate(workspaceId, (memory) => memory.mergeContact(workspaceId, sourceContactId, actorId, input))
  }

  /** Lists customer requests within a Workspace boundary. */
  async listRequests(workspaceId: string, input?: CustomerRequestListInput): Promise<CustomerRequestPage> {
    const { memory } = await this.readMemoryForRead(workspaceId)
    return await memory.listRequests(workspaceId, input)
  }

  /** Reads one Customer Request. */
  async getRequest(workspaceId: string, requestId: string): Promise<CustomerRequest> {
    const { memory } = await this.readMemoryForRead(workspaceId)
    return await memory.getRequest(workspaceId, requestId)
  }

  /** Creates a Customer Request. */
  async createRequest(workspaceId: string, actorId: string, input: CreateCustomerRequestInput): Promise<CustomerRequest> {
    return await this.mutate(workspaceId, (memory) => memory.createRequest(workspaceId, actorId, input))
  }

  /** Updates a Customer Request under an optimistic revision fence. */
  async updateRequest(workspaceId: string, requestId: string, actorId: string, input: UpdateCustomerRequestInput): Promise<CustomerRequest> {
    return await this.mutate(workspaceId, (memory) => memory.updateRequest(workspaceId, requestId, actorId, input))
  }

  /** Deletes a Customer Request. */
  async deleteRequest(workspaceId: string, requestId: string, actorId: string, expectedRevision: number): Promise<void> {
    await this.mutate(workspaceId, async (memory) => await memory.deleteRequest(workspaceId, requestId, actorId, expectedRevision))
  }

  /** Merges a source request into a retained request. */
  async mergeRequest(workspaceId: string, sourceRequestId: string, actorId: string, input: MergeCustomerRequestInput): Promise<CustomerRequest> {
    return await this.mutate(workspaceId, (memory) => memory.mergeRequest(workspaceId, sourceRequestId, actorId, input))
  }

  /** Links a request to a Work Item, allowing many requests per Work Item. */
  async linkRequestToWorkItem(workspaceId: string, requestId: string, actorId: string, input: LinkCustomerRequestWorkItemInput): Promise<CustomerRequest> {
    return await this.mutate(workspaceId, (memory) => memory.linkRequestToWorkItem(workspaceId, requestId, actorId, input))
  }

  /** Removes a request-to-Work-Item link under a revision fence. */
  async unlinkRequestFromWorkItem(workspaceId: string, requestId: string, actorId: string, input: LinkCustomerRequestWorkItemInput & { expectedRevision: number }): Promise<CustomerRequest> {
    return await this.mutate(workspaceId, (memory) => memory.unlinkRequestFromWorkItem(workspaceId, requestId, actorId, input))
  }

  /** Links a request directly to a Project, idempotently. */
  async linkRequestToProject(workspaceId: string, requestId: string, actorId: string, input: LinkCustomerRequestProjectInput): Promise<CustomerRequest> {
    return await this.mutate(workspaceId, (memory) => memory.linkRequestToProject(workspaceId, requestId, actorId, input))
  }

  /** Removes a request-to-Project link under a revision fence. */
  async unlinkRequestFromProject(workspaceId: string, requestId: string, actorId: string, input: LinkCustomerRequestProjectInput & { expectedRevision: number }): Promise<CustomerRequest> {
    return await this.mutate(workspaceId, (memory) => memory.unlinkRequestFromProject(workspaceId, requestId, actorId, input))
  }

  /** Returns customer impact for one canonical Work Item. */
  async getWorkItemImpact(workspaceId: string, teamId: string, workItemId: string): Promise<CustomerImpactSignal> {
    const { memory } = await this.readMemoryForRead(workspaceId)
    return await memory.getWorkItemImpact(workspaceId, teamId, workItemId)
  }

  /** Returns customer impact for one Project. */
  async getProjectImpact(workspaceId: string, projectId: string): Promise<CustomerImpactSignal> {
    const { memory } = await this.readMemoryForRead(workspaceId)
    return await memory.getProjectImpact(workspaceId, projectId)
  }

  /** Returns Work Items associated with a Customer. */
  async listCustomerWorkItems(workspaceId: string, customerId: string): Promise<CustomerWorkItemSummary[]> {
    const { memory } = await this.readMemoryForRead(workspaceId)
    return await memory.listCustomerWorkItems(workspaceId, customerId)
  }

  /** Lists saved customer directory views. */
  async listSavedViews(workspaceId: string): Promise<CustomerSavedView[]> {
    const { memory } = await this.readMemoryForRead(workspaceId)
    return await memory.listSavedViews(workspaceId)
  }

  /** Creates a saved customer directory view. */
  async createSavedView(workspaceId: string, actorId: string, input: CreateCustomerSavedViewInput): Promise<CustomerSavedView> {
    return await this.mutate(workspaceId, (memory) => memory.createSavedView(workspaceId, actorId, input))
  }

  /** Updates a saved customer directory view. */
  async updateSavedView(workspaceId: string, viewId: string, actorId: string, input: UpdateCustomerSavedViewInput): Promise<CustomerSavedView> {
    return await this.mutate(workspaceId, (memory) => memory.updateSavedView(workspaceId, viewId, actorId, input))
  }

  /** Deletes a saved customer directory view. */
  async deleteSavedView(workspaceId: string, viewId: string, actorId: string, expectedRevision: number): Promise<void> {
    await this.mutate(workspaceId, async (memory) => await memory.deleteSavedView(workspaceId, viewId, actorId, expectedRevision))
  }

  /** Exports all Customer-owned records for one Workspace. */
  async exportWorkspace(workspaceId: string): Promise<CustomerWorkspaceExport> {
    const { memory } = await this.readMemoryForRead(workspaceId)
    return await memory.exportWorkspace(workspaceId)
  }

  /** Applies retention redaction to expired Customer-owned records. */
  async redactExpired(workspaceId: string, now = this.now().toISOString()): Promise<CustomerRetentionResult> {
    return await this.mutate(workspaceId, (memory) => memory.redactExpired(workspaceId, now))
  }

  /** Prepares idempotent completion notification candidates for a Work Item. */
  async prepareCompletionNotifications(workspaceId: string, teamId: string, workItemId: string, actorId: string, now = this.now().toISOString()): Promise<CustomerCompletionNotification[]> {
    return await this.mutate(workspaceId, (memory) => memory.prepareCompletionNotifications(workspaceId, teamId, workItemId, actorId, now))
  }

  /** Lists previously prepared completion notification candidates. */
  async listCompletionNotifications(workspaceId: string, teamId: string, workItemId: string): Promise<CustomerCompletionNotification[]> {
    const { memory } = await this.readMemoryForRead(workspaceId)
    return await memory.listCompletionNotifications(workspaceId, teamId, workItemId)
  }

  /** Loads one Workspace graph and its optimistic control revision. */
  private async load(workspaceId: string): Promise<LoadedCustomerWorkspace> {
    await this.ensureTable()
    const state = createEmptyState()
    let revision = 0
    let exclusiveStartKey: Record<string, unknown> | undefined
    let rowsRead = 0
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'workspaceId = :workspaceId',
        ExpressionAttributeValues: { ':workspaceId': workspaceId },
        ConsistentRead: true,
        Limit: 250,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))
      for (const row of response.Items ?? []) {
        rowsRead += 1
        if (rowsRead > 10_000) throw new CustomerError(503, 'CustomerWorkspaceTooLarge', 'The Customer workspace graph is too large for one operation.')
        const decoded = decodeStoredRow(row, workspaceId)
        if (!decoded) throw new CustomerError(503, 'CustomerPersistenceCorrupt', 'A Customer record is malformed.')
        if (decoded.kind === 'meta') {
          revision = decoded.revision
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
      exclusiveStartKey = response.LastEvaluatedKey
    } while (exclusiveStartKey)
    return { state, revision }
  }

  /** Loads a Workspace graph into the shared in-memory application implementation. */
  private async readMemory(workspaceId: string): Promise<{
    memory: InMemoryCustomerClient
    loaded: LoadedCustomerWorkspace
    retentionResult: CustomerRetentionResult
  }> {
    const loaded = await this.load(workspaceId)
    const memory = new InMemoryCustomerClient({ now: this.now, id: this.id })
    memory.replaceWorkspaceState(workspaceId, loaded.state)
    const retentionResult = await memory.redactExpired(workspaceId, this.now().toISOString())
    return { memory, loaded, retentionResult }
  }

  /** Loads a Workspace graph and persists any retention redaction before returning it. */
  private async readMemoryForRead(workspaceId: string): Promise<{
    memory: InMemoryCustomerClient
    loaded: LoadedCustomerWorkspace
  }> {
    const result = await this.readMemory(workspaceId)
    if (
      result.retentionResult.customersRedacted > 0 ||
      result.retentionResult.contactsRedacted > 0 ||
      result.retentionResult.requestsRedacted > 0
    ) {
      await this.persist(workspaceId, result.loaded, result.memory.readWorkspaceState(workspaceId))
    }
    return result
  }

  /** Applies one in-memory operation and durably commits its graph diff. */
  private async mutate<T>(
    workspaceId: string,
    operation: (memory: InMemoryCustomerClient) => Promise<T>,
  ): Promise<T> {
    const { memory, loaded } = await this.readMemory(workspaceId)
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
    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = []
    for (const [recordKey, row] of nextRows) {
      const previous = previousRows.get(recordKey)
      if (!previous || JSON.stringify(previous) !== JSON.stringify(row)) transactItems.push({ Put: { TableName: this.tableName, Item: row } })
    }
    for (const recordKey of previousRows.keys()) {
      if (!nextRows.has(recordKey)) transactItems.push({ Delete: { TableName: this.tableName, Key: { workspaceId, recordKey } } })
    }
    if (transactItems.length === 0) return
    const nextRevision = loaded.revision + 1
    transactItems.push({
      Put: {
        TableName: this.tableName,
        Item: { workspaceId, recordKey: 'META', entityType: 'meta', revision: nextRevision },
        ConditionExpression: loaded.revision === 0
          ? 'attribute_not_exists(recordKey)'
          : '#revision = :revision',
        ...(loaded.revision === 0
          ? {}
          : {
              ExpressionAttributeNames: { '#revision': 'revision' },
              ExpressionAttributeValues: { ':revision': loaded.revision },
            }),
      },
    })
    if (transactItems.length > 100) throw new CustomerError(409, 'CustomerTransactionTooLarge', 'The Customer mutation is too large; split the operation and retry.')
    if (transactItems.length === 1) return
    try {
      await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactItems }))
    } catch (error) {
      if (isConditionalConflict(error)) throw new CustomerError(409, 'CustomerRevisionConflict', 'Customer data changed. Reload and try again.', { cause: error })
      throw error
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
  | { workspaceId: string; recordKey: string; entityType: 'meta'; revision: number }
  | { workspaceId: string; recordKey: string; entityType: 'customer'; customer: Customer }
  | { workspaceId: string; recordKey: string; entityType: 'contact'; contact: CustomerContact }
  | { workspaceId: string; recordKey: string; entityType: 'request'; request: CustomerRequest }
  | { workspaceId: string; recordKey: string; entityType: 'view'; view: CustomerSavedView }
  | { workspaceId: string; recordKey: string; entityType: 'completion-notification'; notification: CustomerCompletionNotification }

/** Decoded Customer row variants with a narrowed value. */
type DecodedCustomerRow =
  | { kind: 'meta'; revision: number }
  | { kind: 'customer'; value: Customer }
  | { kind: 'contact'; value: CustomerContact }
  | { kind: 'request'; value: CustomerRequest }
  | { kind: 'view'; value: CustomerSavedView }
  | { kind: 'notification'; value: CustomerCompletionNotification }

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

/** Classifies a conditional DynamoDB failure. */
function isConditionalConflict(error: unknown): boolean {
  return isAwsNamedError(error, 'ConditionalCheckFailedException') || isAwsNamedError(error, 'TransactionCanceledException')
}

/** Checks an AWS error name without trusting an unknown value. */
function isAwsNamedError(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name
}
