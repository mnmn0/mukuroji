import {
  createDefaultDeletedFileCleanupDependencies,
  processCollaborationProjectionBatch,
  type CuratedContextSearchProjectionDependencies,
  type CuratedContextSearchProjectionInput,
  type DynamoStreamEvent,
} from '../modules/collaboration/adapter-in/events/collaboration-projection'
import {
  createWorkItemCollaborationEntityKey,
  DynamoDbCollaborationClient,
} from '../modules/collaboration/collaboration'
import {
  listScopeConnections,
  postRealtimeMessage,
} from '../modules/realtime/adapter-in/events/realtime'
import {
  createCuratedContextItemWorkspaceSearchDocument,
  DynamoDbWorkspaceSearchClient,
} from '../modules/workspace-search/workspace-search'

const deletedFileCleanup = createDefaultDeletedFileCleanupDependencies()
const workspaceSearchTableName = readOptionalEnvironment('WORKSPACE_SEARCH_TABLE_NAME') ??
  readOptionalEnvironment('MUKUROJI_WORKSPACE_SEARCH_TABLE')
const collaboration = workspaceSearchTableName
  ? new DynamoDbCollaborationClient()
  : undefined
const workspaceSearch = workspaceSearchTableName
  ? new DynamoDbWorkspaceSearchClient(workspaceSearchTableName)
  : undefined

const curatedContextSearch = {
  /** Upserts the latest canonical non-superseded context item into Workspace search. */
  async upsertCurrent(input: CuratedContextSearchProjectionInput) {
    if (!workspaceSearch) return
    const item = await readMatchingCuratedContextItem(input)
    const writeOptions = input.sourceRevision === undefined
      ? undefined
      : { sourceRevision: input.sourceRevision }
    if (item.state === 'superseded') {
      await workspaceSearch.deleteDocument(
        input.workspaceId,
        'context-item',
        createCuratedContextSearchEntityId(input),
        writeOptions,
      )
      return
    }
    await workspaceSearch.upsertDocument(
      createCuratedContextItemWorkspaceSearchDocument({
        workspaceId: input.workspaceId,
        item,
        ...(input.projectId ? { projectId: input.projectId } : {}),
      }),
      writeOptions,
    )
  },
  /** Deletes a superseded or orphaned context item from Workspace search idempotently. */
  async deleteCurrent(input: CuratedContextSearchProjectionInput) {
    if (!workspaceSearch) return
    const writeOptions = input.sourceRevision === undefined
      ? undefined
      : { sourceRevision: input.sourceRevision }
    await workspaceSearch.deleteDocument(
      input.workspaceId,
      'context-item',
      createCuratedContextSearchEntityId(input),
      writeOptions,
    )
  },
} satisfies CuratedContextSearchProjectionDependencies

/**
 * Reads and verifies the strongly consistent curated-context snapshot for one audit event.
 *
 * @param input - Canonical event scope parsed by the stream adapter.
 * @returns The matching current curated-context snapshot.
 */
async function readMatchingCuratedContextItem(input: CuratedContextSearchProjectionInput) {
  if (!collaboration) {
    throw new Error('Curated context search projection is not configured.')
  }
  const entityKey = createWorkItemCollaborationEntityKey(
    input.workspaceId,
    input.teamId,
    input.issueId,
  )
  const item = await collaboration.getCuratedContextItemSnapshot({
    entityKey,
    itemId: input.contextItemId,
  })
  if (
    !item ||
    item.id !== input.contextItemId ||
    item.teamId !== input.teamId ||
    item.workItemId !== input.issueId
  ) {
    throw new Error('Curated context search projection item is missing or out of scope.')
  }
  return item
}

/**
 * Reads one optional environment value without constructing the broad API
 * dependency graph inside the Audit projection Lambda.
 *
 * @param name - Exact environment variable name.
 * @returns Trimmed configured value, or undefined when absent.
 */
function readOptionalEnvironment(name: string) {
  const value = process.env[name]?.trim()
  return value || undefined
}

/**
 * Creates the stable Workspace search entity identity for one context item.
 *
 * @param input - Canonical context item scope.
 * @returns The context-item search entity ID.
 */
function createCuratedContextSearchEntityId(input: CuratedContextSearchProjectionInput) {
  return `team/${input.teamId}/issue/${input.issueId}/context-item/${input.contextItemId}`
}

const realtime = {
  async publish(scopeKey: string, payload: Readonly<Record<string, unknown>>) {
    const callbackEndpoint = process.env.WEBSOCKET_CALLBACK_ENDPOINT?.trim()
    if (!callbackEndpoint) return
    const connections = await listScopeConnections(scopeKey)
    await Promise.all(connections.map((connection) =>
      postRealtimeMessage(callbackEndpoint, connection.connectionId, payload)
    ))
  },
}

/** AuditEvents stream を notification と realtime invalidation に投影します。 */
export async function handler(event: DynamoStreamEvent) {
  return await processCollaborationProjectionBatch(event, {
    deletedFileCleanup,
    curatedContextSearch,
    realtime,
  })
}

export * from '../modules/collaboration/adapter-in/events/collaboration-projection'
