import { createHash } from 'node:crypto'
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb'
import type {
  ExternalChatCanonicalRedirect,
  ExternalChatProvider,
  ExternalChatSourceAvailability,
  ExternalChatSourceState,
  ExternalChatSyncCursor,
  ExternalChatSyncOutcome,
  ExternalChatWorkItemLink,
} from '@mukuroji/contracts'
import type {
  AcknowledgeExternalChatThreadLifecycleInput,
  AcquireExternalChatOutboundRetryPermitInput,
  CheckpointExternalChatInboundEventInput,
  ClaimExternalChatInboundEventInput,
  ClaimExternalChatInboundEventResult,
  ClaimExternalChatOutboundOperationInput,
  ClaimExternalChatOutboundOperationResult,
  ClaimExternalChatThreadLifecycleInput,
  ClaimExternalChatThreadLifecycleResult,
  CompleteExternalChatInboundEventInput,
  CompleteExternalChatOutboundOperationInput,
  CompleteExternalChatThreadLifecycleInput,
  CreateExternalChatLinkInput,
  CreateExternalChatLinkResult,
  DeadLetterExternalChatOutboundOperationInput,
  DeferredExternalChatEvent,
  DeferredExternalChatOutboundEvent,
  ExternalChatInboundReceipt,
  ExternalChatOutboundDeadLetterReason,
  ExternalChatParentLifecycleFence,
  ExternalChatParentLifecycleFenceSnapshot,
  ExternalChatOutboundReceipt,
  ExternalChatOutboundRetryPermit,
  ExternalChatSourceIdentity,
  ExternalChatStore,
  ExternalChatWorkItemLinkManifest,
  FenceExternalChatParentLifecycleInput,
  FenceExternalChatParentLifecycleResult,
  ListExternalChatParentLinksInput,
  ListExternalChatParentLinksResult,
  MergeExternalChatLinksStoreInput,
  MergeExternalChatLinksStoreResult,
  PrepareExternalChatOutboundDeadLetterResult,
  PutExternalChatMessageBindingInput,
  PutExternalChatMessageBindingResult,
  ReleaseExternalChatOutboundRetryPermitInput,
  RenewExternalChatOutboundRetryPermitInput,
  StoredExternalChatLink,
  StoredExternalChatMessageBinding,
  StoredExternalChatThreadLifecycle,
  UnlinkExternalChatLinkInput,
  UnlinkExternalChatLinkResult,
  UpdateExternalChatLinkInput,
  UpdateExternalChatLinkResult,
  ValidateExternalChatOutboundRetryPermitInput,
} from '../../external-chat'
import {
  createExternalChatFingerprint,
  createExternalChatSourceDigest,
  createInitialExternalChatLinkLifecycleState,
  externalChatLifecycleBlocksSynchronization,
  ExternalChatError,
  isExternalChatParentLifecycleState,
} from '../../external-chat'
import {
  decodeDeferredExternalChatEvent,
  decodeDeferredExternalChatOutboundEvent,
  decodeExternalChatCanonicalRedirect,
  decodeExternalChatInboundReceipt,
  decodeExternalChatOutboundReceipt,
  decodeExternalChatOutboundRetryPermit,
  decodeExternalChatSyncCursor,
  decodeExternalChatSyncOutcome,
  decodeStoredExternalChatLink,
  decodeStoredExternalChatMessageBinding,
  decodeStoredExternalChatThreadLifecycle,
} from './external-chat-codec'

/** Maximum conditional retries used to classify a concurrent receipt mutation. */
const MAX_CONDITIONAL_RETRIES = 5

/** DynamoDB currently accepts at most one hundred actions in one transaction. */
const MAX_TRANSACTION_ACTIONS = 100

/** Fixed duplicate/canonical membership-manifest actions in one link merge transaction. */
const MERGE_MANIFEST_ACTIONS = 2

/** Link, lifecycle, and redirect actions required for each moved link. */
const MERGE_ACTIONS_PER_LINK = 3

/** Maximum links whose complete state fits one DynamoDB merge transaction. */
const MAX_MERGE_LINKS = Math.floor(
  (MAX_TRANSACTION_ACTIONS - MERGE_MANIFEST_ACTIONS) / MERGE_ACTIONS_PER_LINK,
)

/** Exact link and parent authority that must remain current during a destructive queue purge. */
type ExternalChatDeferredPurgeAuthority = {
  /** Strongly read active link persistence row. */
  ownerRow: ExternalChatPersistenceRow
  /** Decoded active link whose public revision authorizes the purge. */
  owner: StoredExternalChatLink
  /** Exact workspace and conversation parent authorities authorizing the purge. */
  parentLifecycleFences: ExternalChatParentLifecycleFenceSnapshot
}

/** DynamoDB adapter construction options. */
export type DynamoDbExternalChatStoreOptions = {
  /** Single-table name that stores external chat durable state. */
  tableName: string
  /** Caller-owned DocumentClient configured by the application composition root. */
  documentClient: DynamoDBDocumentClient
}

/** Validated common envelope for every external chat persistence row. */
type ExternalChatPersistenceRow = {
  /** Tenant partition key. */
  workspaceId: string
  /** Server-generated physical sort key. */
  recordKey: string
  /** Stable row discriminator. */
  entryType: ExternalChatPersistenceEntryType
  /** Untrusted domain value decoded by a row-specific decoder. */
  value: unknown
  /** Optimistic storage revision. */
  storageRevision: number
  /** Optional sparse lookup partition key. */
  lookupKey?: string
  /** Optional sparse lookup sort key. */
  lookupSortKey?: string
}

/** Row discriminators owned by the external chat DynamoDB adapter. */
type ExternalChatPersistenceEntryType =
  | 'external-chat-link'
  | 'external-chat-source-claim'
  | 'external-chat-link-receipt'
  | 'external-chat-work-item-link-manifest'
  | 'external-chat-parent-lifecycle'
  | 'external-chat-inbound-receipt'
  | 'external-chat-outbound-receipt'
  | 'external-chat-outbound-retry-permit'
  | 'external-chat-thread-lifecycle'
  | 'external-chat-binding-external'
  | 'external-chat-binding-internal'
  | 'external-chat-sync-cursor'
  | 'external-chat-deferred-event'
  | 'external-chat-deferred-outbound-event'
  | 'external-chat-canonical-redirect'

/** Value retained by a unique active source claim. */
type ExternalChatSourceClaimValue = {
  /** Digest of the canonical provider thread identity. */
  sourceDigest: string
  /** Active link that owns the provider thread. */
  linkId: string
}

/** Value retained by a link command idempotency receipt. */
type ExternalChatLinkReceiptValue = {
  /** Digest of the original normalized command. */
  requestFingerprint: string
  /** Link created by the original command. */
  linkId: string
}

/** Decoded pagination key accepted by a subsequent DynamoDB query. */
type ExternalChatExclusiveStartKey = {
  /** Tenant partition key. */
  workspaceId: string
  /** Physical table sort key. */
  recordKey: string
  /** Sparse index partition key when the query uses the lookup index. */
  lookupKey?: string
  /** Sparse index sort key when the query uses the lookup index. */
  lookupSortKey?: string
}

/** One DynamoDB transaction action owned by the external chat adapter. */
type ExternalChatTransactWriteItem =
  NonNullable<TransactWriteCommandInput['TransactItems']>[number]

/** Strongly read link row validated for a lifecycle claim or completion. */
type SelectedThreadLifecycleLink = {
  /** Validated logical link record. */
  record: StoredExternalChatLink
  /** Current physical row used by the transactional storage fence. */
  row: ExternalChatPersistenceRow
}

/**
 * Durable DynamoDB implementation of the external chat synchronization store.
 *
 * The adapter uses one tenant partition, server-derived hashed record keys,
 * strongly consistent claim reads, and conditional or transactional writes.
 */
export class DynamoDbExternalChatStore implements ExternalChatStore {
  /** Single-table name that owns the durable rows. */
  private readonly tableName: string

  /** Caller-owned DynamoDB DocumentClient. */
  private readonly documentClient: DynamoDBDocumentClient

  /**
   * Creates a DynamoDB-backed external chat store.
   *
   * @param options - Explicit table, client, and optional lookup index configuration.
   */
  constructor(options: DynamoDbExternalChatStoreOptions) {
    this.tableName = requireIdentifier(options.tableName, 'external chat table name')
    this.documentClient = options.documentClient
  }

  /** Creates one link, source claim, receipt, and incremented owner manifest atomically. */
  async createLink(input: CreateExternalChatLinkInput): Promise<CreateExternalChatLinkResult> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(input.workspaceId, 'Workspace ID')
      const idempotencyKeyHash = requireDigest(
        input.idempotencyKeyHash,
        'link idempotency key digest',
      )
      const requestFingerprint = requireDigest(
        input.requestFingerprint,
        'link request fingerprint',
      )
      const authorizationRevision = requirePositiveInteger(
        input.authorizationRevision,
        'provider authorization revision',
      )
      validateSourceIdentity(input.source)
      const sourceDigest = createExternalChatSourceDigest(input.source)
      const record = decodeStoredExternalChatLink({
        workspaceId,
        link: input.link,
        sourceDigest,
        sourceAuthorizationRevision: authorizationRevision,
        lifecycleState: createInitialExternalChatLinkLifecycleState(
          input.link,
          authorizationRevision,
        ),
        active: true,
      })
      validateLinkMatchesSource(record.link, input.source)
      const linkKey = externalChatLinkRecordKey(record.link.id)
      const sourceKey = externalChatSourceClaimRecordKey(sourceDigest)
      const receiptKey = externalChatLinkReceiptRecordKey(idempotencyKeyHash)
      const ownerManifestKey = externalChatWorkItemLinkManifestRecordKey(
        record.link.teamId,
        record.link.workItemId,
      )
      const ownerManifestRow = await this.getRow(
        workspaceId,
        ownerManifestKey,
        'external-chat-work-item-link-manifest',
      )
      const ownerManifest = ownerManifestRow === undefined
        ? undefined
        : decodeScopedWorkItemLinkManifestRow(
            ownerManifestRow,
            workspaceId,
            record.link.teamId,
            record.link.workItemId,
          )
      const nextOwnerManifest = incrementWorkItemLinkManifest(
        ownerManifest,
        workspaceId,
        record.link.teamId,
        record.link.workItemId,
      )
      try {
        await this.documentClient.send(new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: createActiveLinkRow(record, 1),
                ConditionExpression: 'attribute_not_exists(#workspaceId)',
                ExpressionAttributeNames: { '#workspaceId': 'workspaceId' },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: createRow(
                  workspaceId,
                  sourceKey,
                  'external-chat-source-claim',
                  { sourceDigest, linkId: record.link.id },
                  1,
                ),
                ConditionExpression: 'attribute_not_exists(#workspaceId)',
                ExpressionAttributeNames: { '#workspaceId': 'workspaceId' },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: createRow(
                  workspaceId,
                  receiptKey,
                  'external-chat-link-receipt',
                  { requestFingerprint, linkId: record.link.id },
                  1,
                ),
                ConditionExpression: 'attribute_not_exists(#workspaceId)',
                ExpressionAttributeNames: { '#workspaceId': 'workspaceId' },
              },
            },
            ...createParentLifecycleLinkConditions(
              this.tableName,
              record,
              authorizationRevision,
            ),
            createWorkItemLinkManifestPut(
              this.tableName,
              nextOwnerManifest,
              ownerManifestRow,
            ),
          ],
        }))
        return { kind: 'created', record }
      } catch (error) {
        if (!isConditionalWriteFailure(error)) throw error
        return await this.classifyCreateLinkConflict(
          workspaceId,
          linkKey,
          sourceKey,
          receiptKey,
          requestFingerprint,
          record,
          authorizationRevision,
        )
      }
    })
  }

  /** Reads one tenant-scoped link with strong consistency. */
  async getLink(
    workspaceIdValue: string,
    linkIdValue: string,
  ): Promise<StoredExternalChatLink | undefined> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(workspaceIdValue, 'Workspace ID')
      const linkId = requireIdentifier(linkIdValue, 'external chat link ID')
      return await this.readLink(workspaceId, externalChatLinkRecordKey(linkId), linkId)
    })
  }

  /** Resolves the active link that uniquely claims one provider thread. */
  async getLinkBySource(
    workspaceIdValue: string,
    source: ExternalChatSourceIdentity,
  ): Promise<StoredExternalChatLink | undefined> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(workspaceIdValue, 'Workspace ID')
      validateSourceIdentity(source)
      const sourceDigest = createExternalChatSourceDigest(source)
      const claimRow = await this.getRow(
        workspaceId,
        externalChatSourceClaimRecordKey(sourceDigest),
        'external-chat-source-claim',
      )
      if (!claimRow) return undefined
      const claim = decodeSourceClaim(claimRow.value)
      if (claim.sourceDigest !== sourceDigest) invalidStoredRow('external chat source claim scope')
      const link = await this.readLink(
        workspaceId,
        externalChatLinkRecordKey(claim.linkId),
        claim.linkId,
      )
      if (!link || !link.active || link.sourceDigest !== sourceDigest) {
        invalidStoredRow('external chat source claim target')
      }
      return link
    })
  }

  /** Reads one strongly consistent Work Item link-membership manifest. */
  async getWorkItemLinkManifest(
    workspaceIdValue: string,
    teamIdValue: string,
    workItemIdValue: string,
  ): Promise<ExternalChatWorkItemLinkManifest | undefined> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(workspaceIdValue, 'Workspace ID')
      const teamId = requireIdentifier(teamIdValue, 'Team ID')
      const workItemId = requireIdentifier(workItemIdValue, 'Work Item ID')
      const row = await this.getRow(
        workspaceId,
        externalChatWorkItemLinkManifestRecordKey(teamId, workItemId),
        'external-chat-work-item-link-manifest',
      )
      return row === undefined
        ? undefined
        : decodeScopedWorkItemLinkManifestRow(row, workspaceId, teamId, workItemId)
    })
  }

  /** Publishes one authoritative provider-parent lifecycle generation before child fan-out. */
  async fenceParentLifecycle(
    input: FenceExternalChatParentLifecycleInput,
  ): Promise<FenceExternalChatParentLifecycleResult> {
    return await this.withPersistenceBoundary(async () => {
      const normalized = normalizeParentLifecycleFenceInput(input)
      const recordKey = externalChatParentLifecycleRecordKey(
        normalized.provider,
        normalized.installationId,
        normalized.externalWorkspaceId,
        normalized.conversationExternalId,
      )
      for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
        const row = await this.getRow(
          normalized.workspaceId,
          recordKey,
          'external-chat-parent-lifecycle',
        )
        if (row) {
          const current = decodeExternalChatParentLifecycleFence(row.value)
          validateParentLifecycleFenceScope(current, normalized, recordKey)
          if (parentLifecycleFenceReplays(current, normalized)) {
            return { kind: 'replayed', fence: current }
          }
          if (normalized.authorizationRevision === undefined) {
            return { kind: 'stale', fence: current }
          }
          const candidate = createParentLifecycleFence(
            normalized,
            normalized.authorizationRevision,
          )
          if (compareParentLifecycleFences(candidate, current) <= 0) {
            return { kind: 'stale', fence: current }
          }
          try {
            await this.putRowConditionally(
              createRow(
                normalized.workspaceId,
                recordKey,
                'external-chat-parent-lifecycle',
                candidate,
                row.storageRevision + 1,
              ),
              row.storageRevision,
            )
            return { kind: 'applied', fence: candidate }
          } catch (error) {
            if (!isConditionalWriteFailure(error)) throw error
            continue
          }
        }
        if (normalized.authorizationRevision === undefined) {
          invalidInput(
            'A new parent lifecycle fence requires its verified authorization revision.',
          )
        }
        const candidate = createParentLifecycleFence(
          normalized,
          normalized.authorizationRevision,
        )
        try {
          await this.documentClient.send(new PutCommand({
            TableName: this.tableName,
            Item: createRow(
              normalized.workspaceId,
              recordKey,
              'external-chat-parent-lifecycle',
              candidate,
              1,
            ),
            ConditionExpression: 'attribute_not_exists(#workspaceId)',
            ExpressionAttributeNames: { '#workspaceId': 'workspaceId' },
          }))
          return { kind: 'applied', fence: candidate }
        } catch (error) {
          if (!isConditionalWriteFailure(error)) throw error
        }
      }
      throw concurrentPersistenceFailure('provider parent lifecycle fence')
    })
  }

  /** Strongly reads both present-or-absent parent lifecycle authorities governing one link. */
  async getParentLifecycleFences(
    workspaceIdValue: string,
    linkIdValue: string,
  ): Promise<ExternalChatParentLifecycleFenceSnapshot | undefined> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(workspaceIdValue, 'Workspace ID')
      const linkId = requireIdentifier(linkIdValue, 'external chat link ID')
      const record = await this.readLink(
        workspaceId,
        externalChatLinkRecordKey(linkId),
        linkId,
      )
      if (!record) return undefined
      const [workspaceRow, conversationRow] = await Promise.all(
        externalChatParentLifecycleRecordKeys(record).map((recordKey) =>
          this.getRow(workspaceId, recordKey, 'external-chat-parent-lifecycle')
        ),
      )
      const workspace = workspaceRow === undefined
        ? undefined
        : decodeExternalChatParentLifecycleFence(workspaceRow.value)
      const conversation = conversationRow === undefined
        ? undefined
        : decodeExternalChatParentLifecycleFence(conversationRow.value)
      if (workspace !== undefined && workspaceRow !== undefined) {
        validateParentLifecycleFenceForLink(workspace, record, workspaceRow.recordKey)
      }
      if (conversation !== undefined && conversationRow !== undefined) {
        validateParentLifecycleFenceForLink(conversation, record, conversationRow.recordKey)
      }
      return { workspace, conversation }
    })
  }

  /** Lists one strongly consistent base-table page of links under a provider parent resource. */
  async listParentLinks(
    input: ListExternalChatParentLinksInput,
  ): Promise<ListExternalChatParentLinksResult> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(input.workspaceId, 'Workspace ID')
      const provider = requireProvider(input.provider)
      const installationId = requireIdentifier(
        input.installationId,
        'connector installation ID',
      )
      const externalWorkspaceId = requireIdentifier(
        input.externalWorkspaceId,
        'external Workspace ID',
      )
      const conversationExternalId = input.conversationExternalId === undefined
        ? undefined
        : requireIdentifier(input.conversationExternalId, 'external conversation ID')
      const maximumSourceAuthorizationRevision = requirePositiveInteger(
        input.maximumSourceAuthorizationRevision,
        'maximum source authorization revision',
      )
      const limit = requireListLimit(input.limit)
      if (limit === 0) return { links: [] }
      const cursorScope = externalChatParentLinkCursorScope(
        workspaceId,
        provider,
        installationId,
        externalWorkspaceId,
        conversationExternalId,
        maximumSourceAuthorizationRevision,
      )
      const recordPrefix = externalChatLinkRecordPrefix()
      const exclusiveStartKey = input.cursor === undefined
        ? undefined
        : decodeParentLinkCursor(input.cursor, workspaceId, recordPrefix, cursorScope)
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression:
          '#workspaceId = :workspaceId AND begins_with(#recordKey, :recordPrefix)',
        ExpressionAttributeNames: {
          '#workspaceId': 'workspaceId',
          '#recordKey': 'recordKey',
        },
        ExpressionAttributeValues: {
          ':workspaceId': workspaceId,
          ':recordPrefix': recordPrefix,
        },
        Limit: limit,
        ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
        ConsistentRead: true,
        ScanIndexForward: true,
      }))
      const links: StoredExternalChatLink[] = []
      for (const item of response.Items ?? []) {
        const row = decodePersistenceRow(item, workspaceId, undefined, 'external-chat-link')
        const record = decodeStoredExternalChatLink(row.value)
        if (!record.active) continue
        if (
          record.workspaceId !== workspaceId ||
          row.recordKey !== externalChatLinkRecordKey(record.link.id) ||
          row.lookupKey !== externalChatParentLinkLookupKey(
            workspaceId,
            record.link.provider,
            record.link.installationId,
            record.link.source.externalWorkspaceId,
          ) ||
          row.lookupSortKey !== externalChatParentLinkLookupSortKey(record.link)
        ) invalidStoredRow('external chat parent link lookup projection')
        if (
          record.sourceAuthorizationRevision > maximumSourceAuthorizationRevision ||
          record.link.provider !== provider ||
          record.link.installationId !== installationId ||
          record.link.source.externalWorkspaceId !== externalWorkspaceId ||
          (
            conversationExternalId !== undefined &&
            record.link.source.conversationExternalId !== conversationExternalId
          )
        ) continue
        links.push(record)
      }
      const nextKey = decodeExclusiveStartKey(response.LastEvaluatedKey)
      return {
        links,
        ...(nextKey === undefined
          ? {}
          : { nextCursor: encodeParentLinkCursor(nextKey, cursorScope) }),
      }
    })
  }

  /** Replaces one link when its public and storage revisions still match. */
  async updateLink(input: UpdateExternalChatLinkInput): Promise<UpdateExternalChatLinkResult> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(input.workspaceId, 'Workspace ID')
      const linkId = requireIdentifier(input.link.id, 'external chat link ID')
      const expectedRevision = requirePositiveInteger(
        input.expectedRevision,
        'expected external chat link revision',
      )
      const lifecycleOperationId = input.lifecycleOperationId === undefined
        ? undefined
        : requireIdentifier(input.lifecycleOperationId, 'thread lifecycle operation ID')
      if (input.link.revision !== expectedRevision + 1) {
        invalidInput('The replacement external chat link revision must advance exactly once.')
      }
      const recordKey = externalChatLinkRecordKey(linkId)
      const currentRow = await this.getRow(
        workspaceId,
        recordKey,
        'external-chat-link',
      )
      if (!currentRow) return { kind: 'not-found' }
      const current = decodeScopedLinkRow(currentRow, workspaceId, linkId)
      if (
        input.expectedParentLifecycleFence !== undefined &&
        input.expectedParentLifecycleFences !== undefined
      ) {
        invalidInput(
          'A link update cannot provide both singular and complete parent lifecycle expectations.',
        )
      }
      const expectedParentLifecycleFence = input.expectedParentLifecycleFence === undefined
        ? undefined
        : normalizeExpectedParentLifecycleFenceForLink(
          input.expectedParentLifecycleFence,
          current,
        )
      const expectedParentLifecycleFences = input.expectedParentLifecycleFences === undefined
        ? undefined
        : normalizeExpectedParentLifecycleFenceSnapshotForLink(
          input.expectedParentLifecycleFences,
          current,
        )
      if (current.link.revision !== expectedRevision) {
        return { kind: 'conflict', record: current }
      }
      const replacement = decodeStoredExternalChatLink({
        ...current,
        link: input.link,
        sourceAuthorizationRevision: input.sourceAuthorizationRevision === undefined
          ? current.sourceAuthorizationRevision
          : requireNondecreasingSourceAuthorizationRevision(
            input.sourceAuthorizationRevision,
            current.sourceAuthorizationRevision,
          ),
        lifecycleState: input.lifecycleState ?? current.lifecycleState,
      })
      validateLinkReplacement(current, replacement)
      const lifecycleKey = externalChatThreadLifecycleRecordKey(linkId, current.link.provider)
      const lifecycleRow = await this.getRow(
        workspaceId,
        lifecycleKey,
        'external-chat-thread-lifecycle',
      )
      const lifecycleRecord = lifecycleRow === undefined
        ? undefined
        : decodeStoredExternalChatThreadLifecycle(lifecycleRow.value)
      if (lifecycleRecord) {
        validateThreadLifecycleScope(
          lifecycleRecord,
          workspaceId,
          linkId,
          current.link.provider,
        )
        if (!threadLifecycleAllowsLinkMutation(lifecycleRecord, lifecycleOperationId)) {
          return { kind: 'conflict', record: current }
        }
      }
      const lifecycleAction: ExternalChatTransactWriteItem = lifecycleRow && lifecycleRecord
        ? createThreadLifecyclePut(
            this.tableName,
            createRow(
              workspaceId,
              lifecycleKey,
              'external-chat-thread-lifecycle',
              decodeStoredExternalChatThreadLifecycle({
                ...lifecycleRecord,
                ownerLinkRevision: replacement.link.revision,
              }),
              lifecycleRow.storageRevision + 1,
            ),
            lifecycleRow.storageRevision,
          )
        : createAbsentThreadLifecycleCondition(this.tableName, workspaceId, lifecycleKey)
      try {
        await this.documentClient.send(new TransactWriteCommand({
          TransactItems: [
            createConditionalRowPut(
              this.tableName,
              createActiveLinkRow(replacement, currentRow.storageRevision + 1),
              currentRow.storageRevision,
            ),
            lifecycleAction,
            ...(expectedParentLifecycleFence === undefined
              ? []
              : [createExpectedParentLifecycleFenceCondition(
                this.tableName,
                expectedParentLifecycleFence,
              )]),
            ...(expectedParentLifecycleFences === undefined
              ? []
              : createExpectedParentLifecycleFenceSnapshotConditions(
                this.tableName,
                current,
                expectedParentLifecycleFences,
              )),
          ],
        }))
        return { kind: 'updated', record: replacement }
      } catch (error) {
        if (!isConditionalWriteFailure(error)) throw error
        if (
          expectedParentLifecycleFence !== undefined &&
          !await this.isParentLifecycleFenceCurrent(expectedParentLifecycleFence)
        ) return { kind: 'parent-stale' }
        if (
          expectedParentLifecycleFences !== undefined &&
          !await this.isParentLifecycleFenceSnapshotCurrent(
            current,
            expectedParentLifecycleFences,
          )
        ) return { kind: 'parent-stale' }
        const concurrent = await this.readLink(workspaceId, recordKey, linkId)
        return concurrent
          ? { kind: 'conflict', record: concurrent }
          : { kind: 'not-found' }
      }
    })
  }

  /** Detaches one link while releasing its source claim and decrementing its owner manifest. */
  async unlinkLink(input: UnlinkExternalChatLinkInput): Promise<UnlinkExternalChatLinkResult> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(input.workspaceId, 'Workspace ID')
      const linkId = requireIdentifier(input.linkId, 'external chat link ID')
      const expectedRevision = requirePositiveInteger(
        input.expectedRevision,
        'expected external chat link revision',
      )
      const lifecycleOperationId = input.lifecycleOperationId === undefined
        ? undefined
        : requireIdentifier(input.lifecycleOperationId, 'thread lifecycle operation ID')
      const unlinkedAt = requireTimestamp(input.unlinkedAt, 'external chat unlink timestamp')
      const recordKey = externalChatLinkRecordKey(linkId)
      const currentRow = await this.getRow(
        workspaceId,
        recordKey,
        'external-chat-link',
      )
      if (!currentRow) return { kind: 'not-found' }
      const current = decodeScopedLinkRow(currentRow, workspaceId, linkId)
      if (!current.active) {
        await this.purgeDeferredOutboundEventsForLink(workspaceId, linkId)
        return { kind: 'replayed', record: current }
      }
      if (current.link.revision !== expectedRevision) {
        return { kind: 'conflict', record: current }
      }
      const lifecycleKey = externalChatThreadLifecycleRecordKey(linkId, current.link.provider)
      const lifecycleRow = await this.getRow(
        workspaceId,
        lifecycleKey,
        'external-chat-thread-lifecycle',
      )
      const lifecycleRecord = lifecycleRow === undefined
        ? undefined
        : decodeStoredExternalChatThreadLifecycle(lifecycleRow.value)
      if (lifecycleRecord) {
        validateThreadLifecycleScope(
          lifecycleRecord,
          workspaceId,
          linkId,
          current.link.provider,
        )
        if (!threadLifecycleAllowsLinkMutation(lifecycleRecord, lifecycleOperationId)) {
          return { kind: 'conflict', record: current }
        }
      }
      const unlinked = decodeStoredExternalChatLink({
        ...current,
        active: false,
        unlinkedAt,
      })
      const ownerManifestKey = externalChatWorkItemLinkManifestRecordKey(
        current.link.teamId,
        current.link.workItemId,
      )
      const ownerManifestRow = await this.getRow(
        workspaceId,
        ownerManifestKey,
        'external-chat-work-item-link-manifest',
      )
      if (!ownerManifestRow) invalidStoredRow('external chat Work Item link manifest')
      const ownerManifest = decodeScopedWorkItemLinkManifestRow(
        ownerManifestRow,
        workspaceId,
        current.link.teamId,
        current.link.workItemId,
      )
      const nextOwnerManifest = decrementWorkItemLinkManifest(ownerManifest)
      try {
        await this.documentClient.send(new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: createRow(
                  workspaceId,
                  recordKey,
                  'external-chat-link',
                  unlinked,
                  currentRow.storageRevision + 1,
                ),
                ConditionExpression:
                  '#entryType = :entryType AND #storageRevision = :storageRevision',
                ExpressionAttributeNames: {
                  '#entryType': 'entryType',
                  '#storageRevision': 'storageRevision',
                },
                ExpressionAttributeValues: {
                  ':entryType': 'external-chat-link',
                  ':storageRevision': currentRow.storageRevision,
                },
              },
            },
            {
              Delete: {
                TableName: this.tableName,
                Key: {
                  workspaceId,
                  recordKey: externalChatSourceClaimRecordKey(current.sourceDigest),
                },
                ConditionExpression:
                  '#entryType = :entryType AND #value.#linkId = :linkId',
                ExpressionAttributeNames: {
                  '#entryType': 'entryType',
                  '#value': 'value',
                  '#linkId': 'linkId',
                },
                ExpressionAttributeValues: {
                  ':entryType': 'external-chat-source-claim',
                  ':linkId': linkId,
                },
              },
            },
            lifecycleRow === undefined
              ? createAbsentThreadLifecycleCondition(
                  this.tableName,
                  workspaceId,
                  lifecycleKey,
                )
              : createThreadLifecycleStorageCondition(
                  this.tableName,
                  workspaceId,
                  lifecycleKey,
                  lifecycleRow.storageRevision,
                ),
            createWorkItemLinkManifestPut(
              this.tableName,
              nextOwnerManifest,
              ownerManifestRow,
            ),
          ],
        }))
        await this.purgeDeferredOutboundEventsForLink(workspaceId, linkId)
        return { kind: 'unlinked', record: unlinked }
      } catch (error) {
        if (!isConditionalWriteFailure(error)) throw error
        const concurrent = await this.readLink(workspaceId, recordKey, linkId)
        if (!concurrent) return { kind: 'not-found' }
        if (!concurrent.active) {
          await this.purgeDeferredOutboundEventsForLink(workspaceId, linkId)
          return { kind: 'replayed', record: concurrent }
        }
        if (
          concurrent.link.revision === expectedRevision &&
          concurrent.sourceDigest === current.sourceDigest
        ) {
          const sourceRow = await this.getRow(
            workspaceId,
            externalChatSourceClaimRecordKey(current.sourceDigest),
            'external-chat-source-claim',
          )
          if (!sourceRow) invalidStoredRow('external chat source claim')
          const sourceClaim = decodeSourceClaim(sourceRow.value)
          if (
            sourceClaim.sourceDigest !== current.sourceDigest ||
            sourceClaim.linkId !== linkId
          ) invalidStoredRow('external chat source claim')
        }
        return { kind: 'conflict', record: concurrent }
      }
    })
  }

  /** Claims, resumes, deduplicates, or rejects one inbound provider event. */
  async claimInboundEvent(
    input: ClaimExternalChatInboundEventInput,
  ): Promise<ClaimExternalChatInboundEventResult> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(input.workspaceId, 'Workspace ID')
      const eventId = requireIdentifier(input.eventId, 'provider event ID')
      const fingerprint = requireDigest(input.fingerprint, 'inbound event fingerprint')
      const claimedAt = requireTimestamp(input.claimedAt, 'inbound claim timestamp')
      const leaseExpiresAt = requireFutureTimestamp(
        input.leaseExpiresAt,
        claimedAt,
        'inbound receipt lease expiry',
      )
      const operationId = requireIdentifier(input.operationId, 'inbound operation ID')
      const provider = requireProvider(input.provider)
      const installationId = requireIdentifier(
        input.installationId,
        'connector installation ID',
      )
      const recordKey = externalChatInboundReceiptRecordKey(
        provider,
        installationId,
        eventId,
      )
      const initial: ExternalChatInboundReceipt = {
        workspaceId,
        installationId,
        provider,
        eventId,
        fingerprint,
        operationId,
        state: 'processing',
        attempt: 1,
        leaseExpiresAt,
        createdAt: claimedAt,
        updatedAt: claimedAt,
      }
      return await this.claimInboundReceipt(recordKey, initial, claimedAt, leaseExpiresAt)
    })
  }

  /** Commits an inbound outcome only for the current receipt owner. */
  async completeInboundEvent(input: CompleteExternalChatInboundEventInput): Promise<boolean> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(input.workspaceId, 'Workspace ID')
      const eventId = requireIdentifier(input.eventId, 'provider event ID')
      const installationId = requireIdentifier(
        input.installationId,
        'connector installation ID',
      )
      const provider = requireProvider(input.provider)
      const operationId = requireIdentifier(input.operationId, 'inbound operation ID')
      const expectedAttempt = requirePositiveInteger(
        input.expectedAttempt,
        'expected inbound receipt attempt',
      )
      const completedAt = requireTimestamp(input.completedAt, 'inbound completion timestamp')
      const outcome = decodeExternalChatSyncOutcome(input.outcome)
      if (!matchesInboundOutcomeScope(outcome, operationId, eventId)) return false
      return await this.completeReceipt(
        workspaceId,
        externalChatInboundReceiptRecordKey(provider, installationId, eventId),
        'external-chat-inbound-receipt',
        operationId,
        expectedAttempt,
        outcome,
        completedAt,
        (value) => {
          const receipt = decodeExternalChatInboundReceipt(value)
          if (
            receipt.eventId !== eventId ||
            receipt.installationId !== installationId ||
            receipt.provider !== provider
          ) invalidStoredRow('external chat inbound receipt scope')
          return receipt
        },
      )
    })
  }

  /** Checkpoints and renews one claimed parent lifecycle fan-out receipt. */
  async checkpointInboundEvent(
    input: CheckpointExternalChatInboundEventInput,
  ): Promise<boolean> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(input.workspaceId, 'Workspace ID')
      const installationId = requireIdentifier(
        input.installationId,
        'connector installation ID',
      )
      const provider = requireProvider(input.provider)
      const eventId = requireIdentifier(input.eventId, 'provider event ID')
      const operationId = requireIdentifier(input.operationId, 'inbound operation ID')
      const expectedAttempt = requirePositiveInteger(
        input.expectedAttempt,
        'expected inbound receipt attempt',
      )
      const expectedCursor = input.expectedCursor === undefined
        ? undefined
        : requireIdentifier(input.expectedCursor, 'expected parent lifecycle cursor')
      const nextCursor = requireIdentifier(input.nextCursor, 'next parent lifecycle cursor')
      if (
        input.parentLifecycleApplied !== undefined &&
        typeof input.parentLifecycleApplied !== 'boolean'
      ) {
        throw new ExternalChatError(
          'ExternalChatValidationFailed',
          'Parent lifecycle applied marker must be boolean.',
          false,
        )
      }
      const parentLifecycleFailureCode = input.parentLifecycleFailureCode === undefined
        ? undefined
        : requireIdentifier(input.parentLifecycleFailureCode, 'parent lifecycle failure code')
      const checkpointedAt = requireTimestamp(
        input.checkpointedAt,
        'parent lifecycle checkpoint timestamp',
      )
      const leaseExpiresAt = requireFutureTimestamp(
        input.leaseExpiresAt,
        checkpointedAt,
        'inbound receipt lease expiry',
      )
      const recordKey = externalChatInboundReceiptRecordKey(
        provider,
        installationId,
        eventId,
      )
      for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
        const row = await this.getRow(
          workspaceId,
          recordKey,
          'external-chat-inbound-receipt',
        )
        if (!row) return false
        const current = decodeExternalChatInboundReceipt(row.value)
        if (
          current.workspaceId !== workspaceId ||
          current.installationId !== installationId ||
          current.provider !== provider ||
          current.eventId !== eventId ||
          current.operationId !== operationId ||
          current.attempt !== expectedAttempt ||
          current.state !== 'processing'
        ) return false
        if (
          current.parentLifecycleCursor === nextCursor &&
          (input.parentLifecycleApplied === undefined ||
            current.parentLifecycleApplied === input.parentLifecycleApplied) &&
          (parentLifecycleFailureCode === undefined ||
            current.parentLifecycleFailureCode === parentLifecycleFailureCode)
        ) return true
        if (current.parentLifecycleCursor !== expectedCursor) return false
        const replacement = decodeExternalChatInboundReceipt({
          ...current,
          parentLifecycleCursor: nextCursor,
          ...(input.parentLifecycleApplied === undefined
            ? {}
            : { parentLifecycleApplied: input.parentLifecycleApplied }),
          ...(parentLifecycleFailureCode === undefined
            ? {}
            : { parentLifecycleFailureCode }),
          leaseExpiresAt,
          updatedAt: checkpointedAt,
        })
        try {
          await this.putRowConditionally(
            createRow(
              workspaceId,
              recordKey,
              'external-chat-inbound-receipt',
              replacement,
              row.storageRevision + 1,
            ),
            row.storageRevision,
          )
          return true
        } catch (error) {
          if (!isConditionalWriteFailure(error)) throw error
        }
      }
      throw concurrentPersistenceFailure('parent lifecycle checkpoint')
    })
  }

  /** Claims, resumes, deduplicates, or rejects one outbound operation. */
  async claimOutboundOperation(
    input: ClaimExternalChatOutboundOperationInput,
  ): Promise<ClaimExternalChatOutboundOperationResult> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(input.workspaceId, 'Workspace ID')
      const linkId = requireIdentifier(input.linkId, 'external chat link ID')
      const operationId = requireIdentifier(input.operationId, 'outbound operation ID')
      const fingerprint = requireDigest(input.fingerprint, 'outbound operation fingerprint')
      const claimedAt = requireTimestamp(input.claimedAt, 'outbound claim timestamp')
      const leaseExpiresAt = requireFutureTimestamp(
        input.leaseExpiresAt,
        claimedAt,
        'outbound receipt lease expiry',
      )
      const recordKey = externalChatOutboundReceiptRecordKey(linkId, operationId)
      const initial: ExternalChatOutboundReceipt = {
        workspaceId,
        linkId,
        operationId,
        fingerprint,
        state: 'processing',
        attempt: 1,
        leaseExpiresAt,
        createdAt: claimedAt,
        updatedAt: claimedAt,
      }
      return await this.claimOutboundReceipt(recordKey, initial, claimedAt, leaseExpiresAt)
    })
  }

  /** Commits an outbound outcome only for the current receipt owner. */
  async completeOutboundOperation(
    input: CompleteExternalChatOutboundOperationInput,
  ): Promise<boolean> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(input.workspaceId, 'Workspace ID')
      const linkId = requireIdentifier(input.linkId, 'external chat link ID')
      const operationId = requireIdentifier(input.operationId, 'outbound operation ID')
      const expectedAttempt = requirePositiveInteger(
        input.expectedAttempt,
        'expected outbound receipt attempt',
      )
      const completedAt = requireTimestamp(input.completedAt, 'outbound completion timestamp')
      const outcome = decodeExternalChatSyncOutcome(input.outcome)
      if (!matchesOutboundOutcomeScope(outcome, operationId)) return false
      return await this.completeReceipt(
        workspaceId,
        externalChatOutboundReceiptRecordKey(linkId, operationId),
        'external-chat-outbound-receipt',
        operationId,
        expectedAttempt,
        outcome,
        completedAt,
        decodeExternalChatOutboundReceipt,
      )
    })
  }

  /** Durably fences one exhausted receipt before its payload is delivered to the external DLQ. */
  async prepareOutboundDeadLetterOperation(
    input: DeadLetterExternalChatOutboundOperationInput,
  ): Promise<PrepareExternalChatOutboundDeadLetterResult> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(input.workspaceId, 'Workspace ID')
      const linkId = requireIdentifier(input.linkId, 'external chat link ID')
      const operationId = requireIdentifier(input.operationId, 'outbound operation ID')
      requirePositiveInteger(input.expectedAttempt, 'expected outbound receipt attempt')
      const requestedAt = requireTimestamp(
        input.deadLetteredAt,
        'outbound dead-letter preparation timestamp',
      )
      const requestedReason = requireOutboundDeadLetterReason(input.reason)
      const receiptKey = externalChatOutboundReceiptRecordKey(linkId, operationId)
      const queueKey = externalChatDeferredOutboundEventRecordKey(linkId, operationId)
      for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
        const [receiptRow, queueRow] = await Promise.all([
          this.getRow(workspaceId, receiptKey, 'external-chat-outbound-receipt'),
          this.getRow(workspaceId, queueKey, 'external-chat-deferred-outbound-event'),
        ])
        if (!receiptRow) invalidStoredRow('exhausted outbound receipt')
        const receipt = decodeExternalChatOutboundReceipt(receiptRow.value)
        validateOutboundReceiptScope(receipt, workspaceId, linkId, operationId)
        if (!queueRow) {
          if (receipt.state === 'dead-lettered') return { kind: 'terminal' }
          invalidStoredRow('exhausted outbound active queue')
        }
        const deferred = decodeDeferredExternalChatOutboundEvent(queueRow.value)
        validateDeferredOutboundEventScope(deferred, workspaceId, linkId, operationId)
        const fifoKey = externalChatDeferredOutboundEventFifoRecordKey(deferred)
        const fifoRow = await this.getRow(
          workspaceId,
          fifoKey,
          'external-chat-deferred-outbound-event',
        )
        if (!fifoRow) invalidStoredRow('deferred outbound FIFO pair')
        const fifoDeferred = decodeDeferredExternalChatOutboundEvent(fifoRow.value)
        validateDeferredOutboundEventScope(fifoDeferred, workspaceId, linkId, operationId)
        if (
          fifoRow.recordKey !== fifoKey ||
          fifoDeferred.fingerprint !== deferred.fingerprint ||
          fifoDeferred.attempt !== deferred.attempt
        ) invalidStoredRow('deferred outbound FIFO pair')

        if (receipt.state === 'dead-lettering') {
          if (receipt.deadLetterReason === undefined || receipt.deadLetteredAt === undefined) {
            invalidStoredRow('prepared outbound dead-letter receipt')
          }
          return {
            kind: 'prepared',
            deferred,
            reason: receipt.deadLetterReason,
            deadLetteredAt: receipt.deadLetteredAt,
          }
        }
        if (
          receipt.state === 'dead-lettered' ||
          receipt.state === 'completed' && !isRetryableSyncOutcome(receipt.outcome)
        ) {
          try {
            await this.documentClient.send(new TransactWriteCommand({
              TransactItems: [
                createConditionalRowDelete(this.tableName, queueRow),
                createConditionalRowDelete(this.tableName, fifoRow),
              ],
            }))
            return { kind: 'terminal' }
          } catch (error) {
            if (!isConditionalWriteFailure(error)) throw error
            continue
          }
        }
        if (receipt.state === 'processing' && receipt.leaseExpiresAt > requestedAt) {
          return { kind: 'busy' }
        }

        const preparedAttempt = Math.max(deferred.attempt, receipt.attempt)
        const preparedDeferred = decodeDeferredExternalChatOutboundEvent({
          ...deferred,
          attempt: preparedAttempt,
          updatedAt: requestedAt,
        })
        const preparedReceipt = decodeExternalChatOutboundReceipt({
          ...receipt,
          state: 'dead-lettering',
          attempt: preparedAttempt,
          deadLetterReason: requestedReason,
          deadLetteredAt: requestedAt,
          updatedAt: requestedAt,
        })
        try {
          await this.documentClient.send(new TransactWriteCommand({
            TransactItems: [
              createConditionalRowPut(
                this.tableName,
                createRow(
                  workspaceId,
                  receiptKey,
                  'external-chat-outbound-receipt',
                  preparedReceipt,
                  receiptRow.storageRevision + 1,
                ),
                receiptRow.storageRevision,
              ),
              createConditionalRowPut(
                this.tableName,
                createDeferredOutboundEventRow(
                  preparedDeferred,
                  queueKey,
                  queueRow.storageRevision + 1,
                ),
                queueRow.storageRevision,
              ),
              createConditionalRowPut(
                this.tableName,
                createDeferredOutboundEventRow(
                  preparedDeferred,
                  fifoKey,
                  fifoRow.storageRevision + 1,
                ),
                fifoRow.storageRevision,
              ),
            ],
          }))
          return {
            kind: 'prepared',
            deferred: preparedDeferred,
            reason: requestedReason,
            deadLetteredAt: requestedAt,
          }
        } catch (error) {
          if (!isConditionalWriteFailure(error)) throw error
        }
      }
      throw concurrentPersistenceFailure('outbound dead-letter preparation')
    })
  }

  /** Atomically terminalizes a prepared receipt and removes both active queue rows. */
  async deadLetterOutboundOperation(
    input: DeadLetterExternalChatOutboundOperationInput,
  ): Promise<boolean> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(input.workspaceId, 'Workspace ID')
      const linkId = requireIdentifier(input.linkId, 'external chat link ID')
      const operationId = requireIdentifier(input.operationId, 'outbound operation ID')
      const expectedAttempt = requirePositiveInteger(
        input.expectedAttempt,
        'expected outbound receipt attempt',
      )
      const deadLetteredAt = requireTimestamp(
        input.deadLetteredAt,
        'outbound dead-letter timestamp',
      )
      const reason = requireOutboundDeadLetterReason(input.reason)
      const receiptKey = externalChatOutboundReceiptRecordKey(linkId, operationId)
      const queueKey = externalChatDeferredOutboundEventRecordKey(linkId, operationId)
      for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
        const [receiptRow, queueRow] = await Promise.all([
          this.getRow(workspaceId, receiptKey, 'external-chat-outbound-receipt'),
          this.getRow(workspaceId, queueKey, 'external-chat-deferred-outbound-event'),
        ])
        if (!receiptRow) return false
        const receipt = decodeExternalChatOutboundReceipt(receiptRow.value)
        validateOutboundReceiptScope(receipt, workspaceId, linkId, operationId)
        if (receipt.state === 'dead-lettered') {
          if (queueRow) invalidStoredRow('dead-lettered outbound active queue')
          return receipt.deadLetterReason === reason &&
            receipt.deadLetteredAt === deadLetteredAt
        }
        if (
          receipt.state !== 'dead-lettering' ||
          receipt.attempt !== expectedAttempt ||
          receipt.deadLetterReason !== reason ||
          receipt.deadLetteredAt !== deadLetteredAt ||
          !queueRow
        ) return false
        const deferred = decodeDeferredExternalChatOutboundEvent(queueRow.value)
        validateDeferredOutboundEventScope(deferred, workspaceId, linkId, operationId)
        if (deferred.attempt !== expectedAttempt) return false
        const fifoKey = externalChatDeferredOutboundEventFifoRecordKey(deferred)
        const fifoRow = await this.getRow(
          workspaceId,
          fifoKey,
          'external-chat-deferred-outbound-event',
        )
        if (!fifoRow) invalidStoredRow('deferred outbound FIFO pair')
        const fifoDeferred = decodeDeferredExternalChatOutboundEvent(fifoRow.value)
        validateDeferredOutboundEventScope(fifoDeferred, workspaceId, linkId, operationId)
        if (
          fifoRow.recordKey !== fifoKey ||
          fifoDeferred.fingerprint !== deferred.fingerprint ||
          fifoDeferred.attempt !== deferred.attempt
        ) {
          invalidStoredRow('deferred outbound FIFO pair')
        }
        const terminalReceipt = decodeExternalChatOutboundReceipt({
          ...receipt,
          state: 'dead-lettered',
          outcome: {
            kind: 'failed',
            operationId,
            errorCode: 'ExternalChatRetryExhausted',
            retryable: false,
            occurredAt: deadLetteredAt,
          },
          deadLetterReason: reason,
          deadLetteredAt,
          updatedAt: deadLetteredAt,
        })
        try {
          await this.documentClient.send(new TransactWriteCommand({
            TransactItems: [
              createConditionalRowPut(
                this.tableName,
                createRow(
                  workspaceId,
                  receiptKey,
                  'external-chat-outbound-receipt',
                  terminalReceipt,
                  receiptRow.storageRevision + 1,
                ),
                receiptRow.storageRevision,
              ),
              createConditionalRowDelete(this.tableName, queueRow),
              createConditionalRowDelete(this.tableName, fifoRow),
            ],
          }))
          return true
        } catch (error) {
          if (!isConditionalWriteFailure(error)) throw error
        }
      }
      throw concurrentPersistenceFailure('outbound dead-letter transition')
    })
  }

  /** Acquires one installation-scoped permit and advances its monotonic fence. */
  async acquireOutboundRetryPermit(
    input: AcquireExternalChatOutboundRetryPermitInput,
  ): Promise<ExternalChatOutboundRetryPermit | undefined> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(input.workspaceId, 'Workspace ID')
      const provider = requireProvider(input.provider)
      const installationId = requireIdentifier(
        input.installationId,
        'connector installation ID',
      )
      const ownerId = requireIdentifier(input.ownerId, 'outbound retry permit owner ID')
      const acquiredAt = requireTimestamp(input.acquiredAt, 'outbound retry acquisition')
      const leaseExpiresAt = requireFutureTimestamp(
        input.leaseExpiresAt,
        acquiredAt,
        'outbound retry permit expiry',
      )
      const recordKey = externalChatOutboundRetryPermitRecordKey(provider, installationId)
      for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
        const row = await this.getRow(
          workspaceId,
          recordKey,
          'external-chat-outbound-retry-permit',
        )
        const current = row === undefined
          ? undefined
          : decodeExternalChatOutboundRetryPermit(row.value)
        if (current) {
          validateOutboundRetryPermitScope(current, workspaceId, provider, installationId)
          if (current.leaseExpiresAt > acquiredAt) return undefined
        }
        const permit = decodeExternalChatOutboundRetryPermit({
          workspaceId,
          provider,
          installationId,
          ownerId,
          fenceToken: (current?.fenceToken ?? 0) + 1,
          acquiredAt,
          leaseExpiresAt,
          updatedAt: acquiredAt,
        })
        try {
          const permitRow = createRow(
            workspaceId,
            recordKey,
            'external-chat-outbound-retry-permit',
            permit,
            (row?.storageRevision ?? 0) + 1,
          )
          if (row) {
            await this.putRowConditionally(permitRow, row.storageRevision)
          } else {
            await this.documentClient.send(new PutCommand({
              TableName: this.tableName,
              Item: permitRow,
              ConditionExpression: 'attribute_not_exists(#workspaceId)',
              ExpressionAttributeNames: { '#workspaceId': 'workspaceId' },
            }))
          }
          return permit
        } catch (error) {
          if (!isConditionalWriteFailure(error)) throw error
        }
      }
      throw concurrentPersistenceFailure('outbound retry permit acquisition')
    })
  }

  /** Renews one exact unexpired installation-scoped permit. */
  async renewOutboundRetryPermit(
    input: RenewExternalChatOutboundRetryPermitInput,
  ): Promise<ExternalChatOutboundRetryPermit | undefined> {
    return await this.withPersistenceBoundary(async () => {
      const permit = decodeExternalChatOutboundRetryPermit(input.permit)
      const renewedAt = requireTimestamp(input.renewedAt, 'outbound retry renewal')
      const leaseExpiresAt = requireFutureTimestamp(
        input.leaseExpiresAt,
        renewedAt,
        'outbound retry renewed expiry',
      )
      const recordKey = externalChatOutboundRetryPermitRecordKey(
        permit.provider,
        permit.installationId,
      )
      for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
        const row = await this.getRow(
          permit.workspaceId,
          recordKey,
          'external-chat-outbound-retry-permit',
        )
        if (!row) return undefined
        const current = decodeExternalChatOutboundRetryPermit(row.value)
        if (
          !outboundRetryPermitsMatch(current, permit) ||
          current.leaseExpiresAt <= renewedAt
        ) return undefined
        const renewed = decodeExternalChatOutboundRetryPermit({
          ...current,
          leaseExpiresAt,
          updatedAt: renewedAt,
        })
        try {
          await this.putRowConditionally(
            createRow(
              permit.workspaceId,
              recordKey,
              'external-chat-outbound-retry-permit',
              renewed,
              row.storageRevision + 1,
            ),
            row.storageRevision,
          )
          return renewed
        } catch (error) {
          if (!isConditionalWriteFailure(error)) throw error
        }
      }
      throw concurrentPersistenceFailure('outbound retry permit renewal')
    })
  }

  /** Validates exact permit ownership, fencing token, lease revision, and expiry. */
  async validateOutboundRetryPermit(
    input: ValidateExternalChatOutboundRetryPermitInput,
  ): Promise<boolean> {
    return await this.withPersistenceBoundary(async () => {
      const permit = decodeExternalChatOutboundRetryPermit(input.permit)
      const checkedAt = requireTimestamp(input.checkedAt, 'outbound retry permit check')
      const row = await this.getRow(
        permit.workspaceId,
        externalChatOutboundRetryPermitRecordKey(
          permit.provider,
          permit.installationId,
        ),
        'external-chat-outbound-retry-permit',
      )
      if (!row) return false
      const current = decodeExternalChatOutboundRetryPermit(row.value)
      return outboundRetryPermitsMatch(current, permit) && current.leaseExpiresAt > checkedAt
    })
  }

  /** Releases one exact permit while retaining its latest monotonic fencing token. */
  async releaseOutboundRetryPermit(
    input: ReleaseExternalChatOutboundRetryPermitInput,
  ): Promise<boolean> {
    return await this.withPersistenceBoundary(async () => {
      const permit = decodeExternalChatOutboundRetryPermit(input.permit)
      const releasedAt = requireTimestamp(input.releasedAt, 'outbound retry permit release')
      const recordKey = externalChatOutboundRetryPermitRecordKey(
        permit.provider,
        permit.installationId,
      )
      for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
        const row = await this.getRow(
          permit.workspaceId,
          recordKey,
          'external-chat-outbound-retry-permit',
        )
        if (!row) return false
        const current = decodeExternalChatOutboundRetryPermit(row.value)
        if (!outboundRetryPermitsMatch(current, permit)) return false
        const released = decodeExternalChatOutboundRetryPermit({
          ...current,
          leaseExpiresAt: releasedAt,
          updatedAt: releasedAt,
        })
        try {
          await this.putRowConditionally(
            createRow(
              permit.workspaceId,
              recordKey,
              'external-chat-outbound-retry-permit',
              released,
              row.storageRevision + 1,
            ),
            row.storageRevision,
          )
          return true
        } catch (error) {
          if (!isConditionalWriteFailure(error)) throw error
        }
      }
      throw concurrentPersistenceFailure('outbound retry permit release')
    })
  }

  /** Checks whether one authenticated outbound operation has completed. */
  async hasCompletedOutboundOperation(
    workspaceIdValue: string,
    linkIdValue: string,
    operationIdValue: string,
  ): Promise<boolean> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(workspaceIdValue, 'Workspace ID')
      const linkId = requireIdentifier(linkIdValue, 'external chat link ID')
      const operationId = requireIdentifier(operationIdValue, 'outbound operation ID')
      const row = await this.getRow(
        workspaceId,
        externalChatOutboundReceiptRecordKey(linkId, operationId),
        'external-chat-outbound-receipt',
      )
      if (!row) return false
      const receipt = decodeExternalChatOutboundReceipt(row.value)
      validateOutboundReceiptScope(receipt, workspaceId, linkId, operationId)
      return receipt.state === 'completed'
    })
  }

  /** Reads one provider- and link-scoped lifecycle row with strong consistency. */
  async getThreadLifecycle(
    workspaceIdValue: string,
    linkIdValue: string,
    providerValue: ExternalChatProvider,
  ): Promise<StoredExternalChatThreadLifecycle | undefined> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(workspaceIdValue, 'Workspace ID')
      const linkId = requireIdentifier(linkIdValue, 'external chat link ID')
      const provider = requireProvider(providerValue)
      const row = await this.getRow(
        workspaceId,
        externalChatThreadLifecycleRecordKey(linkId, provider),
        'external-chat-thread-lifecycle',
      )
      if (!row) return undefined
      const record = decodeStoredExternalChatThreadLifecycle(row.value)
      validateThreadLifecycleScope(record, workspaceId, linkId, provider)
      return record
    })
  }

  /** Claims or recovers an exclusive linked-thread lifecycle lease. */
  async claimThreadLifecycle(
    input: ClaimExternalChatThreadLifecycleInput,
  ): Promise<ClaimExternalChatThreadLifecycleResult> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(input.workspaceId, 'Workspace ID')
      const linkId = requireIdentifier(input.linkId, 'external chat link ID')
      const provider = requireProvider(input.provider)
      const expectedLinkRevision = requirePositiveInteger(
        input.expectedLinkRevision,
        'expected external chat link revision',
      )
      const operationId = requireIdentifier(
        input.operationId,
        'thread lifecycle operation ID',
      )
      const claimedAt = requireTimestamp(input.claimedAt, 'thread lifecycle claim timestamp')
      const leaseExpiresAt = requireFutureTimestamp(
        input.leaseExpiresAt,
        claimedAt,
        'thread lifecycle lease expiry',
      )
      const linkKey = externalChatLinkRecordKey(linkId)
      const lifecycleKey = externalChatThreadLifecycleRecordKey(linkId, provider)
      for (let retry = 0; retry < MAX_CONDITIONAL_RETRIES; retry += 1) {
        const [linkRow, lifecycleRow] = await Promise.all([
          this.getRow(workspaceId, linkKey, 'external-chat-link'),
          this.getRow(
            workspaceId,
            lifecycleKey,
            'external-chat-thread-lifecycle',
          ),
        ])
        const selectedLink = requireActiveThreadLifecycleLink(
          linkRow,
          workspaceId,
          linkId,
          provider,
          expectedLinkRevision,
        )
        let kind: 'claimed' | 'resumed' = 'claimed'
        let record: StoredExternalChatThreadLifecycle
        if (!lifecycleRow) {
          record = decodeStoredExternalChatThreadLifecycle({
            workspaceId,
            linkId,
            provider,
            ownerLinkRevision: selectedLink.record.link.revision,
            state: {
              completed: false,
              revision: 0,
              updatedAt: claimedAt,
            },
            lease: {
              operationId,
              attempt: 1,
              status: 'processing',
              leaseExpiresAt,
            },
          })
        } else {
          const current = decodeStoredExternalChatThreadLifecycle(lifecycleRow.value)
          validateThreadLifecycleScope(current, workspaceId, linkId, provider)
          if (current.lease.status === 'completed') {
            return current.lease.operationId === operationId
              ? { kind: 'completed', record: current }
              : { kind: 'busy', record: current }
          }
          if (
            current.lease.status === 'processing' &&
            Date.parse(current.lease.leaseExpiresAt) > Date.parse(claimedAt)
          ) return { kind: 'busy', record: current }
          kind = current.lease.operationId === operationId ? 'resumed' : 'claimed'
          record = decodeStoredExternalChatThreadLifecycle({
            ...current,
            ownerLinkRevision: selectedLink.record.link.revision,
            lease: {
              operationId,
              attempt: incrementStoredLifecycleAttempt(current.lease.attempt),
              status: 'processing',
              leaseExpiresAt,
            },
          })
        }
        try {
          await this.documentClient.send(new TransactWriteCommand({
            TransactItems: [
              createThreadLifecycleLinkCondition(
                this.tableName,
                workspaceId,
                linkKey,
                selectedLink.row,
                provider,
                expectedLinkRevision,
              ),
              createThreadLifecyclePut(
                this.tableName,
                createRow(
                  workspaceId,
                  lifecycleKey,
                  'external-chat-thread-lifecycle',
                  record,
                  (lifecycleRow?.storageRevision ?? 0) + 1,
                ),
                lifecycleRow?.storageRevision,
              ),
            ],
          }))
          return { kind, record }
        } catch (error) {
          if (!isConditionalWriteFailure(error)) throw error
        }
      }
      throw concurrentPersistenceFailure('thread lifecycle lease')
    })
  }

  /** Commits a lifecycle state only for the exact current operation and lease attempt. */
  async completeThreadLifecycle(
    input: CompleteExternalChatThreadLifecycleInput,
  ): Promise<boolean> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(input.workspaceId, 'Workspace ID')
      const linkId = requireIdentifier(input.linkId, 'external chat link ID')
      const provider = requireProvider(input.provider)
      const expectedLinkRevision = requirePositiveInteger(
        input.expectedLinkRevision,
        'expected external chat link revision',
      )
      const operationId = requireIdentifier(
        input.operationId,
        'thread lifecycle operation ID',
      )
      const expectedAttempt = requirePositiveInteger(
        input.expectedAttempt,
        'expected thread lifecycle attempt',
      )
      const completedAt = requireTimestamp(
        input.completedAt,
        'thread lifecycle completion timestamp',
      )
      const outcome = decodeExternalChatSyncOutcome(input.outcome)
      if (outcome.operationId !== operationId) {
        invalidInput('The thread lifecycle outcome does not match its operation.')
      }
      const linkKey = externalChatLinkRecordKey(linkId)
      const lifecycleKey = externalChatThreadLifecycleRecordKey(linkId, provider)
      for (let retry = 0; retry < MAX_CONDITIONAL_RETRIES; retry += 1) {
        const [linkRow, lifecycleRow] = await Promise.all([
          this.getRow(workspaceId, linkKey, 'external-chat-link'),
          this.getRow(
            workspaceId,
            lifecycleKey,
            'external-chat-thread-lifecycle',
          ),
        ])
        const selectedLink = requireActiveThreadLifecycleLink(
          linkRow,
          workspaceId,
          linkId,
          provider,
          expectedLinkRevision,
        )
        if (!lifecycleRow) return false
        const current = decodeStoredExternalChatThreadLifecycle(lifecycleRow.value)
        validateThreadLifecycleScope(current, workspaceId, linkId, provider)
        if (
          current.lease.operationId !== operationId ||
          current.lease.attempt !== expectedAttempt ||
          current.ownerLinkRevision !== expectedLinkRevision
        ) return false
        if (current.lease.status === 'acknowledged') return false
        const expectedStateRevision = current.lease.status === 'completed'
          ? current.state.revision
          : current.state.revision + 1
        validateThreadLifecycleStateInput(
          input.nextState,
          expectedStateRevision,
          completedAt,
        )
        const replacement = decodeStoredExternalChatThreadLifecycle({
          ...current,
          state: input.nextState,
          lease: {
            ...current.lease,
            status: 'completed',
            completedAt,
            completedOutcome: outcome,
          },
        })
        if (current.lease.status === 'completed') {
          return sameThreadLifecycleState(current.state, replacement.state) &&
            current.lease.completedAt === completedAt &&
            syncOutcomesEqual(current.lease.completedOutcome, outcome)
        }
        try {
          await this.documentClient.send(new TransactWriteCommand({
            TransactItems: [
              createThreadLifecycleLinkCondition(
                this.tableName,
                workspaceId,
                linkKey,
                selectedLink.row,
                provider,
                expectedLinkRevision,
              ),
              createThreadLifecyclePut(
                this.tableName,
                createRow(
                  workspaceId,
                  lifecycleKey,
                  'external-chat-thread-lifecycle',
                  replacement,
                  lifecycleRow.storageRevision + 1,
                ),
                lifecycleRow.storageRevision,
              ),
            ],
          }))
          return true
        } catch (error) {
          if (!isConditionalWriteFailure(error)) throw error
        }
      }
      throw concurrentPersistenceFailure('thread lifecycle completion')
    })
  }

  /** Releases a completed lifecycle result after its outer receipt is durable. */
  async acknowledgeThreadLifecycle(
    input: AcknowledgeExternalChatThreadLifecycleInput,
  ): Promise<boolean> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(input.workspaceId, 'Workspace ID')
      const linkId = requireIdentifier(input.linkId, 'external chat link ID')
      const provider = requireProvider(input.provider)
      const operationId = requireIdentifier(
        input.operationId,
        'thread lifecycle operation ID',
      )
      const expectedAttempt = requirePositiveInteger(
        input.expectedAttempt,
        'expected thread lifecycle attempt',
      )
      const lifecycleKey = externalChatThreadLifecycleRecordKey(linkId, provider)
      for (let retry = 0; retry < MAX_CONDITIONAL_RETRIES; retry += 1) {
        const row = await this.getRow(
          workspaceId,
          lifecycleKey,
          'external-chat-thread-lifecycle',
        )
        if (!row) return false
        const current = decodeStoredExternalChatThreadLifecycle(row.value)
        validateThreadLifecycleScope(current, workspaceId, linkId, provider)
        if (
          current.lease.operationId !== operationId ||
          current.lease.attempt !== expectedAttempt
        ) return false
        if (current.lease.status === 'acknowledged') return true
        if (current.lease.status !== 'completed') return false
        const acknowledged = decodeStoredExternalChatThreadLifecycle({
          ...current,
          lease: {
            operationId,
            attempt: expectedAttempt,
            status: 'acknowledged',
            leaseExpiresAt: current.lease.leaseExpiresAt,
          },
        })
        try {
          await this.putRowConditionally(
            createRow(
              workspaceId,
              lifecycleKey,
              'external-chat-thread-lifecycle',
              acknowledged,
              row.storageRevision + 1,
            ),
            row.storageRevision,
          )
          return true
        } catch (error) {
          if (!isConditionalWriteFailure(error)) throw error
        }
      }
      throw concurrentPersistenceFailure('thread lifecycle acknowledgement')
    })
  }

  /** Reads one message binding by its provider message identity. */
  async getMessageBindingByExternalId(
    workspaceIdValue: string,
    linkIdValue: string,
    externalMessageIdValue: string,
  ): Promise<StoredExternalChatMessageBinding | undefined> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(workspaceIdValue, 'Workspace ID')
      const linkId = requireIdentifier(linkIdValue, 'external chat link ID')
      const externalMessageId = requireIdentifier(
        externalMessageIdValue,
        'external message ID',
      )
      const row = await this.getRow(
        workspaceId,
        externalChatBindingExternalRecordKey(linkId, externalMessageId),
        'external-chat-binding-external',
      )
      if (!row) return undefined
      const binding = decodeStoredExternalChatMessageBinding(row.value)
      validateBindingScope(binding, workspaceId, linkId, externalMessageId, undefined)
      return binding
    })
  }

  /** Reads one message binding by its internal collaboration comment identity. */
  async getMessageBindingByInternalId(
    workspaceIdValue: string,
    linkIdValue: string,
    internalCommentIdValue: string,
  ): Promise<StoredExternalChatMessageBinding | undefined> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(workspaceIdValue, 'Workspace ID')
      const linkId = requireIdentifier(linkIdValue, 'external chat link ID')
      const internalCommentId = requireIdentifier(
        internalCommentIdValue,
        'internal comment ID',
      )
      const row = await this.getRow(
        workspaceId,
        externalChatBindingInternalRecordKey(linkId, internalCommentId),
        'external-chat-binding-internal',
      )
      if (!row) return undefined
      const binding = decodeStoredExternalChatMessageBinding(row.value)
      validateBindingScope(binding, workspaceId, linkId, undefined, internalCommentId)
      return binding
    })
  }

  /** Creates or replaces both identity projections of one message binding atomically. */
  async putMessageBinding(
    input: PutExternalChatMessageBindingInput,
  ): Promise<PutExternalChatMessageBindingResult> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(input.workspaceId, 'Workspace ID')
      const record = decodeStoredExternalChatMessageBinding({
        workspaceId,
        binding: input.binding,
        storageRevision: (input.expectedStorageRevision ?? 0) + 1,
      })
      const expectedTeamId = requireIdentifier(input.expectedTeamId, 'expected Team ID')
      const expectedWorkItemId = requireIdentifier(
        input.expectedWorkItemId,
        'expected Work Item ID',
      )
      const expectedLinkRevision = requirePositiveInteger(
        input.expectedLinkRevision,
        'expected external chat link revision',
      )
      const expected = input.expectedStorageRevision === undefined
        ? undefined
        : requirePositiveInteger(
            input.expectedStorageRevision,
            'expected message binding storage revision',
          )
      const externalKey = externalChatBindingExternalRecordKey(
        record.binding.linkId,
        record.binding.externalMessageId,
      )
      const internalKey = externalChatBindingInternalRecordKey(
        record.binding.linkId,
        record.binding.internalCommentId,
      )
      for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
        const ownerRow = await this.getRow(
          workspaceId,
          externalChatLinkRecordKey(record.binding.linkId),
          'external-chat-link',
        )
        if (!ownerRow) return { kind: 'owner-conflict' }
        const owner = decodeScopedLinkRow(ownerRow, workspaceId, record.binding.linkId)
        if (
          !owner.active ||
          owner.link.teamId !== expectedTeamId ||
          owner.link.workItemId !== expectedWorkItemId ||
          owner.link.revision !== expectedLinkRevision
        ) return { kind: 'owner-conflict', record: owner }
        const expectedParentFences = normalizeExpectedParentLifecycleFenceSnapshotForLink(
          input.expectedParentLifecycleFences,
          owner,
        )
        if (!await this.isParentLifecycleFenceSnapshotCurrent(owner, expectedParentFences)) {
          return { kind: 'owner-conflict', record: owner }
        }
        const classification = await this.classifyBindingWrite(
          workspaceId,
          record,
          externalKey,
          internalKey,
          expected,
        )
        if (classification) return classification
        try {
          await this.documentClient.send(new TransactWriteCommand({
            TransactItems: [
              createBindingPut(
                this.tableName,
                createRow(
                  workspaceId,
                  externalKey,
                  'external-chat-binding-external',
                  record,
                  record.storageRevision,
                ),
                expected,
              ),
              createBindingPut(
                this.tableName,
                createRow(
                  workspaceId,
                  internalKey,
                  'external-chat-binding-internal',
                  record,
                  record.storageRevision,
                ),
                expected,
              ),
              createMessageBindingOwnerFence(
                this.tableName,
                ownerRow,
                expectedTeamId,
                expectedWorkItemId,
                expectedLinkRevision,
              ),
              ...createExpectedParentLifecycleFenceSnapshotConditions(
                this.tableName,
                owner,
                expectedParentFences,
              ),
            ],
          }))
          return { kind: 'stored', record }
        } catch (error) {
          if (!isConditionalWriteFailure(error)) throw error
        }
      }
      throw concurrentPersistenceFailure('message binding')
    })
  }

  /** Reads one private provider traversal cursor with strong consistency. */
  async getSyncCursor(
    workspaceIdValue: string,
    linkIdValue: string,
  ): Promise<ExternalChatSyncCursor | undefined> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(workspaceIdValue, 'Workspace ID')
      const linkId = requireIdentifier(linkIdValue, 'external chat link ID')
      const row = await this.getRow(
        workspaceId,
        externalChatSyncCursorRecordKey(linkId),
        'external-chat-sync-cursor',
      )
      if (!row) return undefined
      const cursor = decodeExternalChatSyncCursor(row.value)
      if (cursor.linkId !== linkId) invalidStoredRow('external chat sync cursor scope')
      return cursor
    })
  }

  /** Advances one private cursor through a revision-fenced conditional write. */
  async putSyncCursor(
    workspaceIdValue: string,
    cursorValue: ExternalChatSyncCursor,
    expectedRevision?: number,
  ): Promise<boolean> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(workspaceIdValue, 'Workspace ID')
      const cursor = decodeExternalChatSyncCursor(cursorValue)
      const expected = expectedRevision === undefined
        ? undefined
        : requirePositiveInteger(expectedRevision, 'expected sync cursor revision')
      if (
        expected === undefined
          ? cursor.revision !== 1
          : cursor.revision !== expected + 1
      ) return false
      const recordKey = externalChatSyncCursorRecordKey(cursor.linkId)
      const row = createRow(
        workspaceId,
        recordKey,
        'external-chat-sync-cursor',
        cursor,
        cursor.revision,
      )
      try {
        if (expected === undefined) {
          await this.documentClient.send(new PutCommand({
            TableName: this.tableName,
            Item: row,
            ConditionExpression: 'attribute_not_exists(#workspaceId)',
            ExpressionAttributeNames: { '#workspaceId': 'workspaceId' },
          }))
        } else {
          await this.putRowConditionally(row, expected)
        }
        return true
      } catch (error) {
        if (isConditionalWriteFailure(error)) return false
        throw error
      }
    })
  }

  /** Idempotently stores one deferred event and its strongly ordered link FIFO row. */
  async deferEvent(eventValue: DeferredExternalChatEvent): Promise<void> {
    await this.withPersistenceBoundary(async () => {
      const event = decodeDeferredExternalChatEvent(eventValue)
      validateDeferredEventScope(event, event.workspaceId, event.event.eventId)
      const recordKey = externalChatDeferredEventRecordKey(
        event.event.provider,
        event.event.installationId,
        event.event.eventId,
      )
      const fifoRecordKey = externalChatDeferredEventFifoRecordKey(event)
      for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
        const contentEvent = !isParentLifecycleDeferredEvent(event.event)
        const linkRow = contentEvent
          ? await this.getRow(
            event.workspaceId,
            externalChatLinkRecordKey(event.linkId),
            'external-chat-link',
          )
          : undefined
        if (contentEvent && !linkRow) return
        const ownerRow = linkRow
        let owner: StoredExternalChatLink | undefined
        let expectedParentFences: ExternalChatParentLifecycleFenceSnapshot | undefined
        if (linkRow) {
          owner = decodeScopedLinkRow(linkRow, event.workspaceId, event.linkId)
          if (
            !owner.active ||
            linkRejectsDeferredContent(owner.link)
          ) return
          if (event.expectedParentLifecycleFences === undefined) {
            invalidInput('A thread-scoped deferred event requires exact parent authorities.')
          }
          expectedParentFences = requireDeferredParentLifecycleFences(event, owner)
          if (
            !await this.isParentLifecycleFenceSnapshotCurrent(owner, expectedParentFences) ||
            parentLifecycleFencesRejectDeferredContent(
              expectedParentFences,
              owner.sourceAuthorizationRevision,
            )
          ) {
            throw new ExternalChatError(
              'ExternalChatOperationConflict',
              'The external chat parent authority changed before inbound retry persistence.',
              true,
            )
          }
        }
        const [currentRow, currentFifoRow] = await Promise.all([
          this.getRow(
            event.workspaceId,
            recordKey,
            'external-chat-deferred-event',
          ),
          this.getRow(
            event.workspaceId,
            fifoRecordKey,
            'external-chat-deferred-event',
          ),
        ])
        if ((currentRow === undefined) !== (currentFifoRow === undefined)) {
          invalidStoredRow('deferred event FIFO pair')
        }
        if (currentRow) {
          if (!currentFifoRow) invalidStoredRow('deferred event FIFO pair')
          const current = decodeDeferredExternalChatEvent(currentRow.value)
          const currentFifo = decodeDeferredExternalChatEvent(currentFifoRow.value)
          validateDeferredEventScope(current, event.workspaceId, event.event.eventId)
          validateDeferredEventScope(currentFifo, event.workspaceId, event.event.eventId)
          if (
            current.fingerprint !== event.fingerprint ||
            currentFifo.fingerprint !== current.fingerprint ||
            current.linkId !== event.linkId ||
            currentFifo.linkId !== event.linkId ||
            currentFifoRow.recordKey !== externalChatDeferredEventFifoRecordKey(current)
          ) {
            throw new ExternalChatError(
              'ExternalChatEventConflict',
              'A deferred event ID was reused with another normalized payload.',
            )
          }
          const replacement = decodeDeferredExternalChatEvent({
            ...event,
            ...(current.authorizationRevision === undefined
              ? {}
              : { authorizationRevision: current.authorizationRevision }),
            attempt: Math.max(current.attempt, event.attempt),
            createdAt: current.createdAt,
          })
          try {
            await this.documentClient.send(new TransactWriteCommand({
              TransactItems: [
                createConditionalRowPut(
                  this.tableName,
                  createDeferredEventRow(
                    replacement,
                    recordKey,
                    currentRow.storageRevision + 1,
                  ),
                  currentRow.storageRevision,
                ),
                createConditionalRowPut(
                  this.tableName,
                  createDeferredEventRow(
                    replacement,
                    fifoRecordKey,
                    currentFifoRow.storageRevision + 1,
                  ),
                  currentFifoRow.storageRevision,
                ),
                ...(owner === undefined || ownerRow === undefined || expectedParentFences === undefined
                  ? []
                  : [
                      createDeferredContentLinkCondition(this.tableName, ownerRow),
                      ...createExpectedParentLifecycleFenceSnapshotConditions(
                        this.tableName,
                        owner,
                        expectedParentFences,
                      ),
                    ]),
              ],
            }))
            return
          } catch (error) {
            if (!isConditionalWriteFailure(error)) throw error
            continue
          }
        }
        try {
          await this.documentClient.send(new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: this.tableName,
                  Item: createDeferredEventRow(event, recordKey, 1),
                  ConditionExpression: 'attribute_not_exists(#workspaceId)',
                  ExpressionAttributeNames: { '#workspaceId': 'workspaceId' },
                },
              },
              {
                Put: {
                  TableName: this.tableName,
                  Item: createDeferredEventRow(event, fifoRecordKey, 1),
                  ConditionExpression: 'attribute_not_exists(#workspaceId)',
                  ExpressionAttributeNames: { '#workspaceId': 'workspaceId' },
                },
              },
              ...(owner === undefined || ownerRow === undefined || expectedParentFences === undefined
                ? []
                : [
                    createDeferredContentLinkCondition(this.tableName, ownerRow),
                    ...createExpectedParentLifecycleFenceSnapshotConditions(
                      this.tableName,
                      owner,
                      expectedParentFences,
                    ),
                  ]),
            ],
          }))
          return
        } catch (error) {
          if (!isConditionalWriteFailure(error)) throw error
        }
      }
      throw concurrentPersistenceFailure('deferred event')
    })
  }

  /** Lists one bounded strict FIFO page through a strongly consistent ordered base-key query. */
  async listDeferredEvents(
    workspaceIdValue: string,
    linkIdValue: string,
    limitValue: number,
  ): Promise<DeferredExternalChatEvent[]> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(workspaceIdValue, 'Workspace ID')
      const linkId = requireIdentifier(linkIdValue, 'external chat link ID')
      const limit = requireListLimit(limitValue)
      if (limit === 0) return []
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression:
          '#workspaceId = :workspaceId AND begins_with(#recordKey, :recordPrefix)',
        ExpressionAttributeNames: {
          '#workspaceId': 'workspaceId',
          '#recordKey': 'recordKey',
        },
        ExpressionAttributeValues: {
          ':workspaceId': workspaceId,
          ':recordPrefix': externalChatDeferredEventFifoRecordKeyPrefix(linkId),
        },
        Limit: limit,
        ConsistentRead: true,
        ScanIndexForward: true,
      }))
      const events: DeferredExternalChatEvent[] = []
      for (const item of response.Items ?? []) {
        const row = decodePersistenceRow(
          item,
          workspaceId,
          undefined,
          'external-chat-deferred-event',
        )
        const event = decodeDeferredExternalChatEvent(row.value)
        validateDeferredEventScope(event, workspaceId, event.event.eventId)
        if (
          event.linkId !== linkId ||
          row.recordKey !== externalChatDeferredEventFifoRecordKey(event)
        ) invalidStoredRow('deferred event FIFO row')
        events.push(event)
      }
      return events
    })
  }

  /** Removes one deferred event after the caller commits its terminal outcome. */
  async deleteDeferredEvent(
    workspaceIdValue: string,
    providerValue: 'slack' | 'microsoft-teams',
    installationIdValue: string,
    eventIdValue: string,
  ): Promise<void> {
    await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(workspaceIdValue, 'Workspace ID')
      const provider = requireProvider(providerValue)
      const installationId = requireIdentifier(
        installationIdValue,
        'connector installation ID',
      )
      const eventId = requireIdentifier(eventIdValue, 'provider event ID')
      const recordKey = externalChatDeferredEventRecordKey(provider, installationId, eventId)
      for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
        const currentRow = await this.getRow(
          workspaceId,
          recordKey,
          'external-chat-deferred-event',
        )
        if (!currentRow) return
        const current = decodeDeferredExternalChatEvent(currentRow.value)
        validateDeferredEventScope(current, workspaceId, eventId)
        if (
          current.event.provider !== provider ||
          current.event.installationId !== installationId
        ) invalidStoredRow('deferred event identity row')
        const fifoRecordKey = externalChatDeferredEventFifoRecordKey(current)
        const fifoRow = await this.getRow(
          workspaceId,
          fifoRecordKey,
          'external-chat-deferred-event',
        )
        if (!fifoRow) invalidStoredRow('deferred event FIFO pair')
        const fifoEvent = decodeDeferredExternalChatEvent(fifoRow.value)
        if (fifoEvent.fingerprint !== current.fingerprint) {
          invalidStoredRow('deferred event FIFO pair')
        }
        try {
          await this.documentClient.send(new TransactWriteCommand({
            TransactItems: [
              createConditionalRowDelete(this.tableName, currentRow),
              createConditionalRowDelete(this.tableName, fifoRow),
            ],
          }))
          return
        } catch (error) {
          if (!isConditionalWriteFailure(error)) throw error
        }
      }
      throw concurrentPersistenceFailure('deferred event deletion')
    })
  }

  /**
   * Idempotently stores one deferred internal mutation in its link-scoped FIFO queue.
   *
   * @param eventValue - Complete deferred outbound event to retain.
   * @returns A promise that resolves after the queue entry is durable.
   */
  async deferOutboundEvent(eventValue: DeferredExternalChatOutboundEvent): Promise<void> {
    await this.withPersistenceBoundary(async () => {
      const event = decodeDeferredExternalChatOutboundEvent(eventValue)
      validateDeferredOutboundEventScope(
        event,
        event.workspaceId,
        event.linkId,
        event.operationId,
      )
      const recordKey = externalChatDeferredOutboundEventRecordKey(
        event.linkId,
        event.operationId,
      )
      const fifoRecordKey = externalChatDeferredOutboundEventFifoRecordKey(event)
      for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
        const [linkRow, currentRow, currentFifoRow] = await Promise.all([
          this.getRow(
            event.workspaceId,
            externalChatLinkRecordKey(event.linkId),
            'external-chat-link',
          ),
          this.getRow(
            event.workspaceId,
            recordKey,
            'external-chat-deferred-outbound-event',
          ),
          this.getRow(
            event.workspaceId,
            fifoRecordKey,
            'external-chat-deferred-outbound-event',
          ),
        ])
        if (!linkRow) {
          throw new ExternalChatError(
            'ExternalChatOperationConflict',
            'The external chat link changed before outbound retry persistence.',
            true,
          )
        }
        const owner = decodeScopedLinkRow(linkRow, event.workspaceId, event.linkId)
        if (
          !owner.active ||
          owner.link.teamId !== event.ownerTeamId ||
          owner.link.workItemId !== event.ownerWorkItemId ||
          owner.link.revision !== event.ownerLinkRevision ||
          linkRejectsDeferredContent(owner.link)
        ) {
          throw new ExternalChatError(
            'ExternalChatOperationConflict',
            'The external chat link changed before outbound retry persistence.',
            true,
          )
        }
        const expectedParentFences = normalizeExpectedParentLifecycleFenceSnapshotForLink(
          event.expectedParentLifecycleFences,
          owner,
        )
        if (
          !await this.isParentLifecycleFenceSnapshotCurrent(owner, expectedParentFences) ||
          parentLifecycleFencesRejectDeferredContent(
            expectedParentFences,
            owner.sourceAuthorizationRevision,
          )
        ) {
          throw new ExternalChatError(
            'ExternalChatOperationConflict',
            'The external chat parent authority changed before outbound retry persistence.',
            true,
          )
        }
        if ((currentRow === undefined) !== (currentFifoRow === undefined)) {
          invalidStoredRow('deferred outbound FIFO pair')
        }
        if (currentRow) {
          if (!currentFifoRow) invalidStoredRow('deferred outbound FIFO pair')
          const current = decodeDeferredExternalChatOutboundEvent(currentRow.value)
          const currentFifo = decodeDeferredExternalChatOutboundEvent(currentFifoRow.value)
          validateDeferredOutboundEventScope(
            current,
            event.workspaceId,
            event.linkId,
            event.operationId,
          )
          if (
            current.fingerprint !== event.fingerprint ||
            currentFifo.fingerprint !== current.fingerprint ||
            currentFifoRow.recordKey !== externalChatDeferredOutboundEventFifoRecordKey(current)
          ) {
            throw new ExternalChatError(
              'ExternalChatOperationConflict',
              'A deferred outbound operation ID was reused with another normalized payload.',
            )
          }
          const replacement = decodeDeferredExternalChatOutboundEvent({
            ...event,
            attempt: Math.max(current.attempt, event.attempt),
            createdAt: current.createdAt,
          })
          try {
            await this.documentClient.send(new TransactWriteCommand({
              TransactItems: [
                createConditionalRowPut(
                  this.tableName,
                  createDeferredOutboundEventRow(
                    replacement,
                    recordKey,
                    currentRow.storageRevision + 1,
                  ),
                  currentRow.storageRevision,
                ),
                createConditionalRowPut(
                  this.tableName,
                  createDeferredOutboundEventRow(
                    replacement,
                    fifoRecordKey,
                    currentFifoRow.storageRevision + 1,
                  ),
                  currentFifoRow.storageRevision,
                ),
                createDeferredContentLinkCondition(this.tableName, linkRow),
                ...createExpectedParentLifecycleFenceSnapshotConditions(
                  this.tableName,
                  owner,
                  expectedParentFences,
                ),
              ],
            }))
            return
          } catch (error) {
            if (!isConditionalWriteFailure(error)) throw error
            continue
          }
        }
        try {
          await this.documentClient.send(new TransactWriteCommand({
            TransactItems: [
              createNewRowPut(this.tableName, createDeferredOutboundEventRow(event, recordKey, 1)),
              createNewRowPut(
                this.tableName,
                createDeferredOutboundEventRow(event, fifoRecordKey, 1),
              ),
              createDeferredContentLinkCondition(this.tableName, linkRow),
              ...createExpectedParentLifecycleFenceSnapshotConditions(
                this.tableName,
                owner,
                expectedParentFences,
              ),
            ],
          }))
          return
        } catch (error) {
          if (!isConditionalWriteFailure(error)) throw error
        }
      }
      throw concurrentPersistenceFailure('deferred outbound event')
    })
  }

  /**
   * Lists deferred outbound mutations in exact link occurrence order.
   *
   * @param workspaceIdValue - Canonical tenant identifier.
   * @param linkIdValue - Link whose FIFO should be read.
   * @param limitValue - Maximum number of queue entries to return.
   * @returns Deferred outbound entries from the head of the exact link FIFO.
   */
  async listDeferredOutboundEvents(
    workspaceIdValue: string,
    linkIdValue: string,
    limitValue: number,
  ): Promise<DeferredExternalChatOutboundEvent[]> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(workspaceIdValue, 'Workspace ID')
      const linkId = requireIdentifier(linkIdValue, 'external chat link ID')
      const limit = requireListLimit(limitValue)
      if (limit === 0) return []
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression:
          '#workspaceId = :workspaceId AND begins_with(#recordKey, :recordPrefix)',
        ExpressionAttributeNames: {
          '#workspaceId': 'workspaceId',
          '#recordKey': 'recordKey',
        },
        ExpressionAttributeValues: {
          ':workspaceId': workspaceId,
          ':recordPrefix': externalChatDeferredOutboundEventFifoRecordKeyPrefix(linkId),
        },
        Limit: limit,
        ConsistentRead: true,
        ScanIndexForward: true,
      }))
      const events: DeferredExternalChatOutboundEvent[] = []
      for (const item of response.Items ?? []) {
        const row = decodePersistenceRow(
          item,
          workspaceId,
          undefined,
          'external-chat-deferred-outbound-event',
        )
        const event = decodeDeferredExternalChatOutboundEvent(row.value)
        validateDeferredOutboundEventScope(event, workspaceId, linkId, event.operationId)
        if (row.recordKey !== externalChatDeferredOutboundEventFifoRecordKey(event)) {
          invalidStoredRow('deferred outbound FIFO row')
        }
        events.push(event)
      }
      return events
    })
  }

  /**
   * Removes one exact tenant-, link-, and operation-scoped deferred outbound mutation.
   *
   * @param workspaceIdValue - Canonical tenant identifier.
   * @param linkIdValue - Link that owns the deferred mutation.
   * @param operationIdValue - Stable outbound operation identifier.
   * @returns A promise that resolves after the exact queue row is absent.
   */
  async deleteDeferredOutboundEvent(
    workspaceIdValue: string,
    linkIdValue: string,
    operationIdValue: string,
  ): Promise<void> {
    await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(workspaceIdValue, 'Workspace ID')
      const linkId = requireIdentifier(linkIdValue, 'external chat link ID')
      const operationId = requireIdentifier(operationIdValue, 'outbound operation ID')
      await this.deleteDeferredOutboundRows(workspaceId, linkId, operationId)
    })
  }

  /**
   * Strongly purges every deferred outbound payload owned by one restrictive or inactive link.
   *
   * @param workspaceIdValue - Canonical tenant identifier.
   * @param linkIdValue - Link whose outbound FIFO must be erased.
   * @param expectedLinkRevisionValue - Optional exact link revision authorizing restriction.
   * @param expectedParentLifecycleFences - Optional exact parent authorities authorizing purge.
   * @returns Removed mutation count, or undefined when supplied authority became stale.
   */
  async purgeDeferredOutboundEventsForLink(
    workspaceIdValue: string,
    linkIdValue: string,
    expectedLinkRevisionValue?: number,
    expectedParentLifecycleFences?: ExternalChatParentLifecycleFenceSnapshot,
  ): Promise<number | undefined> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(workspaceIdValue, 'Workspace ID')
      const linkId = requireIdentifier(linkIdValue, 'external chat link ID')
      const authority = await this.resolveDeferredPurgeAuthority(
        workspaceId,
        linkId,
        expectedLinkRevisionValue,
        expectedParentLifecycleFences,
      )
      if (authority === null) return undefined
      let deleted = 0
      let exclusiveStartKey: ExternalChatExclusiveStartKey | undefined
      do {
        const response = await this.documentClient.send(new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression:
            '#workspaceId = :workspaceId AND begins_with(#recordKey, :recordPrefix)',
          ExpressionAttributeNames: {
            '#workspaceId': 'workspaceId',
            '#recordKey': 'recordKey',
          },
          ExpressionAttributeValues: {
            ':workspaceId': workspaceId,
            ':recordPrefix': externalChatDeferredOutboundEventFifoRecordKeyPrefix(linkId),
          },
          ConsistentRead: true,
          ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
        }))
        for (const item of response.Items ?? []) {
          const row = decodePersistenceRow(
            item,
            workspaceId,
            undefined,
            'external-chat-deferred-outbound-event',
          )
          const event = decodeDeferredExternalChatOutboundEvent(row.value)
          validateDeferredOutboundEventScope(event, workspaceId, linkId, event.operationId)
          if (row.recordKey !== externalChatDeferredOutboundEventFifoRecordKey(event)) {
            invalidStoredRow('deferred outbound purge FIFO row')
          }
          const removed = await this.deleteDeferredOutboundRows(
            workspaceId,
            linkId,
            event.operationId,
            authority,
          )
          if (!removed) return undefined
          deleted += 1
        }
        exclusiveStartKey = decodeExclusiveStartKey(response.LastEvaluatedKey)
      } while (exclusiveStartKey !== undefined)
      return deleted
    })
  }

  /**
   * Strongly purges deferred content under an optional exact link and parent authority.
   *
   * @param workspaceIdValue - Canonical tenant identifier.
   * @param linkIdValue - Link whose inbound FIFO must be erased.
   * @param excludedEventIdValue - Optional active retry event retained until receipt completion.
   * @param expectedLinkRevisionValue - Optional exact link revision authorizing restriction.
   * @param expectedParentLifecycleFences - Optional exact parent authorities authorizing purge.
   * @returns Removed event count, or undefined when supplied authority became stale.
   */
  async purgeDeferredEventsForLink(
    workspaceIdValue: string,
    linkIdValue: string,
    excludedEventIdValue?: string,
    expectedLinkRevisionValue?: number,
    expectedParentLifecycleFences?: ExternalChatParentLifecycleFenceSnapshot,
  ): Promise<number | undefined> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(workspaceIdValue, 'Workspace ID')
      const linkId = requireIdentifier(linkIdValue, 'external chat link ID')
      const excludedEventId = excludedEventIdValue === undefined
        ? undefined
        : requireIdentifier(excludedEventIdValue, 'excluded provider event ID')
      const authority = await this.resolveDeferredPurgeAuthority(
        workspaceId,
        linkId,
        expectedLinkRevisionValue,
        expectedParentLifecycleFences,
      )
      if (authority === null) return undefined
      let deleted = 0
      let exclusiveStartKey: ExternalChatExclusiveStartKey | undefined
      do {
        const response = await this.documentClient.send(new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression:
            '#workspaceId = :workspaceId AND begins_with(#recordKey, :recordPrefix)',
          ExpressionAttributeNames: {
            '#workspaceId': 'workspaceId',
            '#recordKey': 'recordKey',
          },
          ExpressionAttributeValues: {
            ':workspaceId': workspaceId,
            ':recordPrefix': externalChatDeferredEventFifoRecordKeyPrefix(linkId),
          },
          ConsistentRead: true,
          ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
        }))
        for (const item of response.Items ?? []) {
          const row = decodePersistenceRow(
            item,
            workspaceId,
            undefined,
            'external-chat-deferred-event',
          )
          const event = decodeDeferredExternalChatEvent(row.value)
          validateDeferredEventScope(event, workspaceId, event.event.eventId)
          if (event.linkId !== linkId) invalidStoredRow('deferred event purge scope')
          if (event.event.type === 'source.lifecycle-changed') continue
          if (event.event.eventId === excludedEventId) continue
          if (row.recordKey !== externalChatDeferredEventFifoRecordKey(event)) {
            invalidStoredRow('deferred event purge FIFO row')
          }
          const removed = await this.deleteDeferredEventRowsForPurge(
            workspaceId,
            event,
            authority,
          )
          if (!removed) return undefined
          deleted += 1
        }
        exclusiveStartKey = decodeExclusiveStartKey(response.LastEvaluatedKey)
      } while (exclusiveStartKey !== undefined)
      return deleted
    })
  }

  /** Atomically retargets the complete fenced owner set and advances both owner manifests. */
  async mergeLinks(
    input: MergeExternalChatLinksStoreInput,
  ): Promise<MergeExternalChatLinksStoreResult> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(input.workspaceId, 'Workspace ID')
      const canonicalTeamId = requireIdentifier(input.canonicalTeamId, 'canonical Team ID')
      const canonicalWorkItemId = requireIdentifier(
        input.canonicalWorkItemId,
        'canonical Work Item ID',
      )
      const duplicateTeamId = requireIdentifier(input.duplicateTeamId, 'duplicate Team ID')
      const duplicateWorkItemId = requireIdentifier(
        input.duplicateWorkItemId,
        'duplicate Work Item ID',
      )
      const mergedAt = requireTimestamp(input.mergedAt, 'external chat merge timestamp')
      const expectedDuplicateLinkGeneration = requireNonnegativeInteger(
        input.expectedDuplicateLinkGeneration,
        'expected duplicate external chat link generation',
      )
      const expectedDuplicateLinkCount = requireNonnegativeInteger(
        input.expectedDuplicateLinkCount,
        'expected duplicate external chat link count',
      )
      if (
        canonicalTeamId === duplicateTeamId &&
        canonicalWorkItemId === duplicateWorkItemId
      ) invalidInput('Canonical and duplicate Work Items must differ.')
      if (input.links.length > MAX_MERGE_LINKS) {
        return { kind: 'too-large', maximumLinks: MAX_MERGE_LINKS }
      }
      const selected: Array<{
        /** Current validated link record. */
        record: StoredExternalChatLink
        /** Current storage envelope. */
        row: ExternalChatPersistenceRow
        /** Completed lifecycle value that must move with the link. */
        lifecycleRecord?: StoredExternalChatThreadLifecycle
        /** Current lifecycle storage envelope, omitted when the row is absent. */
        lifecycleRow?: ExternalChatPersistenceRow
      }> = []
      const seenLinkIds = new Set<string>()
      for (const candidate of input.links) {
        const linkId = requireIdentifier(candidate.linkId, 'external chat link ID')
        const expectedRevision = requirePositiveInteger(
          candidate.expectedRevision,
          'expected external chat link revision',
        )
        if (seenLinkIds.has(linkId)) invalidInput('External chat merge links must be unique.')
        seenLinkIds.add(linkId)
        const row = await this.getRow(
          workspaceId,
          externalChatLinkRecordKey(linkId),
          'external-chat-link',
        )
        if (!row) return { kind: 'conflict' }
        const record = decodeScopedLinkRow(row, workspaceId, linkId)
        if (
          !record.active ||
          record.link.teamId !== duplicateTeamId ||
          record.link.workItemId !== duplicateWorkItemId ||
          record.link.revision !== expectedRevision
        ) return { kind: 'conflict' }
        const lifecycleRow = await this.getRow(
          workspaceId,
          externalChatThreadLifecycleRecordKey(linkId, record.link.provider),
          'external-chat-thread-lifecycle',
        )
        if (!lifecycleRow) {
          selected.push({ record, row })
          continue
        }
        const lifecycleRecord = decodeStoredExternalChatThreadLifecycle(lifecycleRow.value)
        validateThreadLifecycleScope(
          lifecycleRecord,
          workspaceId,
          linkId,
          record.link.provider,
        )
        if (lifecycleRecord.lease.status !== 'acknowledged') return { kind: 'conflict' }
        selected.push({ record, row, lifecycleRecord, lifecycleRow })
      }
      const duplicateManifestKey = externalChatWorkItemLinkManifestRecordKey(
        duplicateTeamId,
        duplicateWorkItemId,
      )
      const duplicateManifestRow = await this.getRow(
        workspaceId,
        duplicateManifestKey,
        'external-chat-work-item-link-manifest',
      )
      if (!duplicateManifestRow) return { kind: 'conflict' }
      const duplicateManifest = decodeScopedWorkItemLinkManifestRow(
        duplicateManifestRow,
        workspaceId,
        duplicateTeamId,
        duplicateWorkItemId,
      )
      const completeDuplicateLinks = await this.listActiveWorkItemLinks(
        workspaceId,
        duplicateTeamId,
        duplicateWorkItemId,
      )
      if (completeDuplicateLinks.length > MAX_MERGE_LINKS) {
        return { kind: 'too-large', maximumLinks: MAX_MERGE_LINKS }
      }
      if (
        duplicateManifest.generation !== expectedDuplicateLinkGeneration ||
        duplicateManifest.activeLinkCount !== expectedDuplicateLinkCount ||
        duplicateManifest.activeLinkCount !== completeDuplicateLinks.length ||
        !sameLinkIdSet(
          completeDuplicateLinks.map((record) => record.link.id),
          input.links.map((candidate) => candidate.linkId),
        )
      ) return { kind: 'conflict' }

      const canonicalManifestKey = externalChatWorkItemLinkManifestRecordKey(
        canonicalTeamId,
        canonicalWorkItemId,
      )
      const canonicalManifestRow = await this.getRow(
        workspaceId,
        canonicalManifestKey,
        'external-chat-work-item-link-manifest',
      )
      const canonicalManifest = canonicalManifestRow === undefined
        ? undefined
        : decodeScopedWorkItemLinkManifestRow(
            canonicalManifestRow,
            workspaceId,
            canonicalTeamId,
            canonicalWorkItemId,
          )
      if (
        duplicateManifest.generation >= Number.MAX_SAFE_INTEGER ||
        (canonicalManifest?.generation ?? 0) >= Number.MAX_SAFE_INTEGER ||
        (canonicalManifest?.activeLinkCount ?? 0) >
          Number.MAX_SAFE_INTEGER - duplicateManifest.activeLinkCount
      ) invalidStoredRow('external chat Work Item link manifest capacity')
      const movedLinks: ExternalChatWorkItemLink[] = []
      const redirects: ExternalChatCanonicalRedirect[] = []
      const movedFileIds = new Set<string>()
      let movedMessageBindingCount = 0
      for (const selectedLink of selected) {
        const moved = decodeStoredExternalChatLink({
          ...selectedLink.record,
          link: {
            ...selectedLink.record.link,
            teamId: canonicalTeamId,
            workItemId: canonicalWorkItemId,
            revision: selectedLink.record.link.revision + 1,
            updatedAt: mergedAt,
          },
        }).link
        const redirect = decodeExternalChatCanonicalRedirect({
          linkId: moved.id,
          provider: moved.provider,
          threadExternalId: moved.source.threadExternalId,
          fromTeamId: duplicateTeamId,
          fromWorkItemId: duplicateWorkItemId,
          canonicalTeamId,
          canonicalWorkItemId,
          createdAt: mergedAt,
        })
        const bindings = await this.listBindingsForLink(workspaceId, moved.id)
        movedMessageBindingCount += bindings.length
        for (const binding of bindings) {
          for (const fileId of binding.binding.importedFileIds) movedFileIds.add(fileId)
        }
        movedLinks.push(moved)
        redirects.push(redirect)
      }
      if (redirects.length === 0) {
        invalidInput('At least one external chat link is required for a redirect.')
      }
      const currentRedirectRows: Array<ExternalChatPersistenceRow | undefined> = []
      for (const redirect of redirects) {
        const currentRedirectRow = await this.getRow(
          workspaceId,
          externalChatRedirectRecordKey(
            duplicateTeamId,
            duplicateWorkItemId,
            redirect.linkId,
          ),
          'external-chat-canonical-redirect',
        )
        if (currentRedirectRow) {
          const currentRedirect = decodeExternalChatCanonicalRedirect(currentRedirectRow.value)
          if (!sameExternalChatRedirect(currentRedirect, redirect)) return { kind: 'conflict' }
        }
        currentRedirectRows.push(currentRedirectRow)
      }
      const transactItems: ExternalChatTransactWriteItem[] = []
      for (const [index, selectedLink] of selected.entries()) {
        const movedLink = movedLinks[index]
        if (!movedLink) invalidStoredRow('external chat merge link projection')
        transactItems.push({
          Put: {
            TableName: this.tableName,
            Item: createActiveLinkRow(
              {
                ...selectedLink.record,
                link: movedLink,
              },
              selectedLink.row.storageRevision + 1,
            ),
            ConditionExpression:
              '#entryType = :entryType AND #storageRevision = :storageRevision',
            ExpressionAttributeNames: {
              '#entryType': 'entryType',
              '#storageRevision': 'storageRevision',
            },
            ExpressionAttributeValues: {
              ':entryType': 'external-chat-link',
              ':storageRevision': selectedLink.row.storageRevision,
            },
          },
        })
        const lifecycleKey = externalChatThreadLifecycleRecordKey(
          selectedLink.record.link.id,
          selectedLink.record.link.provider,
        )
        if (!selectedLink.lifecycleRow || !selectedLink.lifecycleRecord) {
          transactItems.push({
            ConditionCheck: {
              TableName: this.tableName,
              Key: { workspaceId, recordKey: lifecycleKey },
              ConditionExpression: 'attribute_not_exists(#workspaceId)',
              ExpressionAttributeNames: { '#workspaceId': 'workspaceId' },
            },
          })
          continue
        }
        const movedLifecycle = decodeStoredExternalChatThreadLifecycle({
          ...selectedLink.lifecycleRecord,
          ownerLinkRevision: movedLink.revision,
        })
        transactItems.push(createThreadLifecyclePut(
          this.tableName,
          createRow(
            workspaceId,
            lifecycleKey,
            'external-chat-thread-lifecycle',
            movedLifecycle,
            selectedLink.lifecycleRow.storageRevision + 1,
          ),
          selectedLink.lifecycleRow.storageRevision,
        ))
      }
      for (const [index, redirect] of redirects.entries()) {
        const redirectKey = externalChatRedirectRecordKey(
          duplicateTeamId,
          duplicateWorkItemId,
          redirect.linkId,
        )
        const currentRedirectRow = currentRedirectRows[index]
        if (!currentRedirectRow) {
          transactItems.push({
            Put: {
              TableName: this.tableName,
              Item: createRow(
                workspaceId,
                redirectKey,
                'external-chat-canonical-redirect',
                redirect,
                1,
              ),
              ConditionExpression: 'attribute_not_exists(#workspaceId)',
              ExpressionAttributeNames: { '#workspaceId': 'workspaceId' },
            },
          })
        } else {
          transactItems.push({
            ConditionCheck: {
              TableName: this.tableName,
              Key: { workspaceId, recordKey: redirectKey },
              ConditionExpression:
                '#entryType = :entryType AND #storageRevision = :storageRevision',
              ExpressionAttributeNames: {
                '#entryType': 'entryType',
                '#storageRevision': 'storageRevision',
              },
              ExpressionAttributeValues: {
                ':entryType': 'external-chat-canonical-redirect',
                ':storageRevision': currentRedirectRow.storageRevision,
              },
            },
          })
        }
      }
      transactItems.push(
        createWorkItemLinkManifestPut(
          this.tableName,
          {
            ...duplicateManifest,
            activeLinkCount: 0,
            generation: duplicateManifest.generation + 1,
          },
          duplicateManifestRow,
        ),
        createWorkItemLinkManifestPut(
          this.tableName,
          {
            workspaceId,
            teamId: canonicalTeamId,
            workItemId: canonicalWorkItemId,
            activeLinkCount:
              (canonicalManifest?.activeLinkCount ?? 0) + duplicateManifest.activeLinkCount,
            generation: (canonicalManifest?.generation ?? 0) + 1,
          },
          canonicalManifestRow,
        ),
      )
      if (transactItems.length > MAX_TRANSACTION_ACTIONS) {
        return { kind: 'too-large', maximumLinks: MAX_MERGE_LINKS }
      }
      try {
        await this.documentClient.send(new TransactWriteCommand({ TransactItems: transactItems }))
      } catch (error) {
        if (isConditionalWriteFailure(error)) return { kind: 'conflict' }
        throw error
      }
      return {
        kind: 'merged',
        movedLinks,
        redirects,
        movedFileIds: [...movedFileIds].sort(),
        movedMessageBindingCount,
      }
    })
  }

  /** Resolves a former duplicate Work Item to its canonical target. */
  async getCanonicalRedirect(
    workspaceIdValue: string,
    teamIdValue: string,
    workItemIdValue: string,
    linkIdValue?: string,
  ): Promise<ExternalChatCanonicalRedirect | undefined> {
    return await this.withPersistenceBoundary(async () => {
      const workspaceId = requireIdentifier(workspaceIdValue, 'Workspace ID')
      const teamId = requireIdentifier(teamIdValue, 'Team ID')
      const workItemId = requireIdentifier(workItemIdValue, 'Work Item ID')
      const linkId = linkIdValue === undefined
        ? undefined
        : requireIdentifier(linkIdValue, 'external chat link ID')
      const row = linkId === undefined
        ? await this.readFirstCanonicalRedirect(workspaceId, teamId, workItemId)
        : await this.getRow(
          workspaceId,
          externalChatRedirectRecordKey(teamId, workItemId, linkId),
          'external-chat-canonical-redirect',
        )
      if (!row) return undefined
      const redirect = decodeExternalChatCanonicalRedirect(row.value)
      if (
        redirect.fromTeamId !== teamId ||
        redirect.fromWorkItemId !== workItemId ||
        (linkId !== undefined && redirect.linkId !== linkId)
      ) {
        invalidStoredRow('external chat canonical redirect scope')
      }
      return redirect
    })
  }

  /**
   * Strongly enumerates every active link owned by one Work Item across complete base-table pages.
   *
   * @param workspaceId - Canonical tenant identifier.
   * @param teamId - Owning Team identifier.
   * @param workItemId - Owning Work Item identifier.
   * @returns Complete active owner set in stable link-ID order.
   */
  private async listActiveWorkItemLinks(
    workspaceId: string,
    teamId: string,
    workItemId: string,
  ): Promise<StoredExternalChatLink[]> {
    const records: StoredExternalChatLink[] = []
    let exclusiveStartKey: ExternalChatExclusiveStartKey | undefined
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression:
          '#workspaceId = :workspaceId AND begins_with(#recordKey, :recordPrefix)',
        ExpressionAttributeNames: {
          '#workspaceId': 'workspaceId',
          '#recordKey': 'recordKey',
        },
        ExpressionAttributeValues: {
          ':workspaceId': workspaceId,
          ':recordPrefix': externalChatLinkRecordPrefix(),
        },
        ConsistentRead: true,
        Limit: MAX_MERGE_LINKS + 1,
        ExclusiveStartKey: exclusiveStartKey,
      }))
      for (const item of response.Items ?? []) {
        const row = decodePersistenceRow(
          item,
          workspaceId,
          undefined,
          'external-chat-link',
        )
        const unscoped = decodeStoredExternalChatLink(row.value)
        const record = decodeScopedLinkRow(row, workspaceId, unscoped.link.id)
        if (
          record.active &&
          record.link.teamId === teamId &&
          record.link.workItemId === workItemId
        ) {
          records.push(record)
          if (records.length > MAX_MERGE_LINKS) return records
        }
      }
      exclusiveStartKey = decodeExclusiveStartKey(response.LastEvaluatedKey)
    } while (exclusiveStartKey !== undefined)
    return records.sort((left, right) => compareOrdinal(left.link.id, right.link.id))
  }

  /**
   * Reads the deterministic first moved-link redirect for an old Work Item route.
   *
   * @param workspaceId - Canonical tenant identifier.
   * @param teamId - Team that owned the duplicate Work Item.
   * @param workItemId - Former duplicate Work Item identifier.
   * @returns First strongly read redirect, when the old route exists.
   */
  private async readFirstCanonicalRedirect(
    workspaceId: string,
    teamId: string,
    workItemId: string,
  ): Promise<ExternalChatPersistenceRow | undefined> {
    const response = await this.documentClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression:
        '#workspaceId = :workspaceId AND begins_with(#recordKey, :recordPrefix)',
      ExpressionAttributeNames: {
        '#workspaceId': 'workspaceId',
        '#recordKey': 'recordKey',
      },
      ExpressionAttributeValues: {
        ':workspaceId': workspaceId,
        ':recordPrefix': externalChatRedirectRecordPrefix(teamId, workItemId),
      },
      ConsistentRead: true,
      Limit: 1,
      ScanIndexForward: true,
    }))
    const item = response.Items?.[0]
    return item === undefined
      ? undefined
      : decodePersistenceRow(
        item,
        workspaceId,
        undefined,
        'external-chat-canonical-redirect',
      )
  }

  /** Classifies a failed atomic link creation through strongly consistent reads. */
  private async classifyCreateLinkConflict(
    workspaceId: string,
    linkKey: string,
    sourceKey: string,
    receiptKey: string,
    requestFingerprint: string,
    record: StoredExternalChatLink,
    authorizationRevision: number,
  ): Promise<CreateExternalChatLinkResult> {
    const receiptRow = await this.getRow(
      workspaceId,
      receiptKey,
      'external-chat-link-receipt',
    )
    if (receiptRow) {
      const receipt = decodeLinkReceipt(receiptRow.value)
      if (receipt.requestFingerprint !== requestFingerprint) {
        return { kind: 'idempotency-conflict' }
      }
      const replayed = await this.readLink(
        workspaceId,
        externalChatLinkRecordKey(receipt.linkId),
        receipt.linkId,
      )
      if (!replayed) invalidStoredRow('external chat link receipt target')
      return { kind: 'replayed', record: replayed }
    }
    const sourceRow = await this.getRow(
      workspaceId,
      sourceKey,
      'external-chat-source-claim',
    )
    if (sourceRow) {
      const claim = decodeSourceClaim(sourceRow.value)
      if (externalChatSourceClaimRecordKey(claim.sourceDigest) !== sourceKey) {
        invalidStoredRow('external chat source claim identity')
      }
      const claimed = await this.readLink(
        workspaceId,
        externalChatLinkRecordKey(claim.linkId),
        claim.linkId,
      )
      if (!claimed || !claimed.active) invalidStoredRow('external chat source claim target')
      return { kind: 'source-conflict', record: claimed }
    }
    const collidingLink = await this.getRow(
      workspaceId,
      linkKey,
      'external-chat-link',
    )
    if (collidingLink) {
      throw new ExternalChatError(
        'ExternalChatOperationConflict',
        'The external chat link identifier is already in use.',
      )
    }
    if (await this.isParentLifecycleRestricted(record, authorizationRevision)) {
      return { kind: 'parent-restricted' }
    }
    throw concurrentPersistenceFailure('link creation')
  }

  /**
   * Strongly reads both parent scopes after a failed create transaction.
   *
   * @param record - Candidate link rejected by the transaction.
   * @param authorizationRevision - Provider generation used to resolve its source.
   * @returns Whether a newer or restrictive parent lifecycle fence caused the rejection.
   */
  private async isParentLifecycleRestricted(
    record: StoredExternalChatLink,
    authorizationRevision: number,
  ): Promise<boolean> {
    for (const recordKey of externalChatParentLifecycleRecordKeys(record)) {
      const row = await this.getRow(
        record.workspaceId,
        recordKey,
        'external-chat-parent-lifecycle',
      )
      if (!row) continue
      const fence = decodeExternalChatParentLifecycleFence(row.value)
      validateParentLifecycleFenceForLink(fence, record, recordKey)
      if (parentLifecycleFenceBlocks(fence, authorizationRevision)) return true
    }
    return false
  }

  /**
   * Strongly verifies that one exact parent lifecycle authority still owns its fence row.
   *
   * @param expected - Parent fence used by an atomic child projection.
   * @returns Whether no later parent lifecycle event has superseded the expected authority.
   */
  private async isParentLifecycleFenceCurrent(
    expected: ExternalChatParentLifecycleFence,
  ): Promise<boolean> {
    const recordKey = externalChatParentLifecycleRecordKey(
      expected.provider,
      expected.installationId,
      expected.externalWorkspaceId,
      expected.conversationExternalId,
    )
    const row = await this.getRow(
      expected.workspaceId,
      recordKey,
      'external-chat-parent-lifecycle',
    )
    if (!row) return false
    const current = decodeExternalChatParentLifecycleFence(row.value)
    validateParentLifecycleFenceScope(current, expected, recordKey)
    return sameParentLifecycleFence(current, expected)
  }

  /**
   * Strongly verifies both exact present-or-absent parent authorities for one link.
   *
   * @param record - Link whose immutable provider scope owns the expectations.
   * @param expected - Workspace and conversation snapshot used by an atomic projection.
   * @returns Whether neither governing parent row changed since the snapshot read.
   */
  private async isParentLifecycleFenceSnapshotCurrent(
    record: StoredExternalChatLink,
    expected: ExternalChatParentLifecycleFenceSnapshot,
  ): Promise<boolean> {
    const [workspaceRow, conversationRow] = await Promise.all(
      externalChatParentLifecycleRecordKeys(record).map((recordKey) =>
        this.getRow(record.workspaceId, recordKey, 'external-chat-parent-lifecycle')
      ),
    )
    const current: ExternalChatParentLifecycleFenceSnapshot = {
      workspace: workspaceRow === undefined
        ? undefined
        : decodeExternalChatParentLifecycleFence(workspaceRow.value),
      conversation: conversationRow === undefined
        ? undefined
        : decodeExternalChatParentLifecycleFence(conversationRow.value),
    }
    if (current.workspace !== undefined && workspaceRow !== undefined) {
      validateParentLifecycleFenceForLink(current.workspace, record, workspaceRow.recordKey)
    }
    if (current.conversation !== undefined && conversationRow !== undefined) {
      validateParentLifecycleFenceForLink(
        current.conversation,
        record,
        conversationRow.recordKey,
      )
    }
    return sameParentLifecycleFenceSnapshot(current, expected)
  }

  /** Claims an inbound receipt with bounded conditional retries. */
  private async claimInboundReceipt(
    recordKey: string,
    initial: ExternalChatInboundReceipt,
    claimedAt: string,
    leaseExpiresAt: string,
  ): Promise<ClaimExternalChatInboundEventResult> {
    for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
      const row = await this.getRow(
        initial.workspaceId,
        recordKey,
        'external-chat-inbound-receipt',
      )
      if (!row) {
        try {
          await this.putNewReceipt(
            createRow(
              initial.workspaceId,
              recordKey,
              'external-chat-inbound-receipt',
              initial,
              1,
            ),
          )
          return { kind: 'claimed', receipt: initial }
        } catch (error) {
          if (!isConditionalWriteFailure(error)) throw error
          continue
        }
      }
      const current = decodeExternalChatInboundReceipt(row.value)
      validateInboundReceiptScope(current, initial)
      if (current.fingerprint !== initial.fingerprint) {
        return { kind: 'conflict', receipt: current }
      }
      const resumed = resumeInboundReceipt(current, initial.operationId, claimedAt, leaseExpiresAt)
      if (!resumed) return { kind: 'duplicate', receipt: current }
      if (current.state === 'processing' && current.leaseExpiresAt > claimedAt) {
        return { kind: 'busy', receipt: current }
      }
      try {
        await this.putRowConditionally(
          createRow(
            initial.workspaceId,
            recordKey,
            'external-chat-inbound-receipt',
            resumed,
            row.storageRevision + 1,
          ),
          row.storageRevision,
        )
        return { kind: 'resumed', receipt: resumed }
      } catch (error) {
        if (!isConditionalWriteFailure(error)) throw error
      }
    }
    throw concurrentPersistenceFailure('inbound event receipt')
  }

  /** Claims an outbound receipt with bounded conditional retries. */
  private async claimOutboundReceipt(
    recordKey: string,
    initial: ExternalChatOutboundReceipt,
    claimedAt: string,
    leaseExpiresAt: string,
  ): Promise<ClaimExternalChatOutboundOperationResult> {
    for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
      const row = await this.getRow(
        initial.workspaceId,
        recordKey,
        'external-chat-outbound-receipt',
      )
      if (!row) {
        try {
          await this.putNewReceipt(
            createRow(
              initial.workspaceId,
              recordKey,
              'external-chat-outbound-receipt',
              initial,
              1,
            ),
          )
          return { kind: 'claimed', receipt: initial }
        } catch (error) {
          if (!isConditionalWriteFailure(error)) throw error
          continue
        }
      }
      const current = decodeExternalChatOutboundReceipt(row.value)
      validateOutboundReceiptScope(
        current,
        initial.workspaceId,
        initial.linkId,
        initial.operationId,
      )
      if (current.fingerprint !== initial.fingerprint) {
        return { kind: 'conflict', receipt: current }
      }
      if (current.state === 'dead-lettering') {
        return { kind: 'busy', receipt: current }
      }
      const resumed = resumeOutboundReceipt(current, claimedAt, leaseExpiresAt)
      if (!resumed) return { kind: 'duplicate', receipt: current }
      if (current.state === 'processing' && current.leaseExpiresAt > claimedAt) {
        return { kind: 'busy', receipt: current }
      }
      try {
        await this.putRowConditionally(
          createRow(
            initial.workspaceId,
            recordKey,
            'external-chat-outbound-receipt',
            resumed,
            row.storageRevision + 1,
          ),
          row.storageRevision,
        )
        return { kind: 'resumed', receipt: resumed }
      } catch (error) {
        if (!isConditionalWriteFailure(error)) throw error
      }
    }
    throw concurrentPersistenceFailure('outbound operation receipt')
  }

  /** Completes either receipt kind through the same revision-fenced state machine. */
  private async completeReceipt<TReceipt extends {
    /** Tenant partition that owns the receipt. */
    workspaceId: string
    /** Operation that currently owns the receipt. */
    operationId: string
    /** Current lease attempt number. */
    attempt: number
    /** Current processing state. */
    state: 'processing' | 'completed' | 'dead-lettering' | 'dead-lettered'
    /** Optional terminal or deferred outcome. */
    outcome?: ExternalChatSyncOutcome
  }>(
    workspaceId: string,
    recordKey: string,
    entryType: 'external-chat-inbound-receipt' | 'external-chat-outbound-receipt',
    operationId: string,
    expectedAttempt: number,
    outcome: ExternalChatSyncOutcome,
    completedAt: string,
    decodeReceipt: (value: unknown) => TReceipt,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
      const row = await this.getRow(workspaceId, recordKey, entryType)
      if (!row) return false
      const current = decodeReceipt(row.value)
      if (current.workspaceId !== workspaceId) {
        invalidStoredRow('external chat receipt tenant scope')
      }
      if (
        current.operationId !== operationId ||
        current.attempt !== expectedAttempt
      ) return false
      if (current.state === 'completed') {
        return syncOutcomesEqual(current.outcome, outcome)
      }
      if (current.state === 'dead-lettering' || current.state === 'dead-lettered') return false
      try {
        await this.putRowConditionally(
          createRow(
            workspaceId,
            recordKey,
            entryType,
            {
              ...current,
              state: 'completed',
              outcome,
              updatedAt: completedAt,
            },
            row.storageRevision + 1,
          ),
          row.storageRevision,
        )
        return true
      } catch (error) {
        if (!isConditionalWriteFailure(error)) throw error
      }
    }
    return false
  }

  /** Determines whether a binding write can proceed from current identity rows. */
  private async classifyBindingWrite(
    workspaceId: string,
    replacement: StoredExternalChatMessageBinding,
    externalKey: string,
    internalKey: string,
    expectedStorageRevision: number | undefined,
  ): Promise<PutExternalChatMessageBindingResult | undefined> {
    const [externalRow, internalRow] = await Promise.all([
      this.getRow(
        workspaceId,
        externalKey,
        'external-chat-binding-external',
      ),
      this.getRow(
        workspaceId,
        internalKey,
        'external-chat-binding-internal',
      ),
    ])
    const external = externalRow
      ? decodeStoredExternalChatMessageBinding(externalRow.value)
      : undefined
    const internal = internalRow
      ? decodeStoredExternalChatMessageBinding(internalRow.value)
      : undefined
    if (external) {
      validateBindingScope(
        external,
        workspaceId,
        replacement.binding.linkId,
        replacement.binding.externalMessageId,
        undefined,
      )
    }
    if (internal) {
      validateBindingScope(
        internal,
        workspaceId,
        replacement.binding.linkId,
        undefined,
        replacement.binding.internalCommentId,
      )
    }
    if (
      external &&
      external.binding.internalCommentId !== replacement.binding.internalCommentId
    ) return { kind: 'identity-conflict', record: external }
    if (
      internal &&
      internal.binding.externalMessageId !== replacement.binding.externalMessageId
    ) return { kind: 'identity-conflict', record: internal }
    if ((external === undefined) !== (internal === undefined)) {
      invalidStoredRow('external chat message binding identity projection')
    }
    const current = external ?? internal
    if (current && external && internal && !sameStoredBinding(external, internal)) {
      invalidStoredRow('external chat message binding projection parity')
    }
    if (
      expectedStorageRevision === undefined
        ? current !== undefined
        : current?.storageRevision !== expectedStorageRevision
    ) {
      return current
        ? { kind: 'revision-conflict', record: current }
        : { kind: 'revision-conflict' }
    }
    return undefined
  }

  /** Reads every external binding projection owned by one link across all pages. */
  private async listBindingsForLink(
    workspaceId: string,
    linkId: string,
  ): Promise<StoredExternalChatMessageBinding[]> {
    const records: StoredExternalChatMessageBinding[] = []
    let exclusiveStartKey: ExternalChatExclusiveStartKey | undefined
    do {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression:
          '#workspaceId = :workspaceId AND begins_with(#recordKey, :recordPrefix)',
        ExpressionAttributeNames: {
          '#workspaceId': 'workspaceId',
          '#recordKey': 'recordKey',
        },
        ExpressionAttributeValues: {
          ':workspaceId': workspaceId,
          ':recordPrefix': externalChatBindingExternalPrefix(linkId),
        },
        ConsistentRead: true,
        ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
      }))
      for (const item of response.Items ?? []) {
        const row = decodePersistenceRow(
          item,
          workspaceId,
          undefined,
          'external-chat-binding-external',
        )
        const record = decodeStoredExternalChatMessageBinding(row.value)
        validateBindingScope(record, workspaceId, linkId, undefined, undefined)
        records.push(record)
      }
      exclusiveStartKey = decodeExclusiveStartKey(response.LastEvaluatedKey)
    } while (exclusiveStartKey !== undefined)
    return records
  }

  /** Atomically removes the identity and ordered FIFO rows for one outbound retry. */
  private async deleteDeferredOutboundRows(
    workspaceId: string,
    linkId: string,
    operationId: string,
    authority?: ExternalChatDeferredPurgeAuthority,
  ): Promise<boolean> {
    const recordKey = externalChatDeferredOutboundEventRecordKey(linkId, operationId)
    for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
      const currentRow = await this.getRow(
        workspaceId,
        recordKey,
        'external-chat-deferred-outbound-event',
      )
      if (!currentRow) return true
      const current = decodeDeferredExternalChatOutboundEvent(currentRow.value)
      validateDeferredOutboundEventScope(current, workspaceId, linkId, operationId)
      const fifoRecordKey = externalChatDeferredOutboundEventFifoRecordKey(current)
      const fifoRow = await this.getRow(
        workspaceId,
        fifoRecordKey,
        'external-chat-deferred-outbound-event',
      )
      if (!fifoRow) invalidStoredRow('deferred outbound FIFO pair')
      const fifoEvent = decodeDeferredExternalChatOutboundEvent(fifoRow.value)
      if (fifoEvent.fingerprint !== current.fingerprint) {
        invalidStoredRow('deferred outbound FIFO pair')
      }
      try {
        await this.documentClient.send(new TransactWriteCommand({
          TransactItems: [
            createConditionalRowDelete(this.tableName, currentRow),
            createConditionalRowDelete(this.tableName, fifoRow),
            ...(authority === undefined
              ? []
              : [
                  createExpectedLinkPurgeAuthorityCondition(this.tableName, authority),
                  ...createExpectedParentLifecycleFenceSnapshotConditions(
                    this.tableName,
                    authority.owner,
                    authority.parentLifecycleFences,
                  ),
                ]),
          ],
        }))
        return true
      } catch (error) {
        if (!isConditionalWriteFailure(error)) throw error
        if (authority && !await this.isDeferredPurgeAuthorityCurrent(authority)) return false
      }
    }
    throw concurrentPersistenceFailure('deferred outbound event deletion')
  }

  /**
   * Atomically removes one inbound identity/FIFO pair under optional exact purge authority.
   *
   * @param workspaceId - Canonical tenant identifier.
   * @param event - Validated deferred event identifying both physical rows.
   * @param authority - Optional lifecycle-bound destructive capability.
   * @returns Whether the rows are absent while the supplied authority remains current.
   */
  private async deleteDeferredEventRowsForPurge(
    workspaceId: string,
    event: DeferredExternalChatEvent,
    authority: ExternalChatDeferredPurgeAuthority | undefined,
  ): Promise<boolean> {
    const recordKey = externalChatDeferredEventRecordKey(
      event.event.provider,
      event.event.installationId,
      event.event.eventId,
    )
    const fifoRecordKey = externalChatDeferredEventFifoRecordKey(event)
    for (let attempt = 0; attempt < MAX_CONDITIONAL_RETRIES; attempt += 1) {
      const [currentRow, fifoRow] = await Promise.all([
        this.getRow(workspaceId, recordKey, 'external-chat-deferred-event'),
        this.getRow(workspaceId, fifoRecordKey, 'external-chat-deferred-event'),
      ])
      if (!currentRow && !fifoRow) return true
      if (!currentRow || !fifoRow) invalidStoredRow('deferred event FIFO pair')
      const current = decodeDeferredExternalChatEvent(currentRow.value)
      const fifoEvent = decodeDeferredExternalChatEvent(fifoRow.value)
      validateDeferredEventScope(current, workspaceId, event.event.eventId)
      validateDeferredEventScope(fifoEvent, workspaceId, event.event.eventId)
      if (
        current.fingerprint !== event.fingerprint ||
        fifoEvent.fingerprint !== event.fingerprint
      ) invalidStoredRow('deferred event FIFO pair')
      try {
        await this.documentClient.send(new TransactWriteCommand({
          TransactItems: [
            createConditionalRowDelete(this.tableName, currentRow),
            createConditionalRowDelete(this.tableName, fifoRow),
            ...(authority === undefined
              ? []
              : [
                  createExpectedLinkPurgeAuthorityCondition(this.tableName, authority),
                  ...createExpectedParentLifecycleFenceSnapshotConditions(
                    this.tableName,
                    authority.owner,
                    authority.parentLifecycleFences,
                  ),
                ]),
          ],
        }))
        return true
      } catch (error) {
        if (!isConditionalWriteFailure(error)) throw error
        if (authority && !await this.isDeferredPurgeAuthorityCurrent(authority)) return false
      }
    }
    throw concurrentPersistenceFailure('deferred event purge deletion')
  }

  /**
   * Resolves optional exact authority for a destructive deferred-content purge.
   *
   * `undefined` means the caller intentionally requested an unconditional unlink cleanup, while
   * `null` means a supplied link or parent authority is already stale.
   *
   * @param workspaceId - Canonical tenant identifier.
   * @param linkId - Link whose queue is being purged.
   * @param expectedLinkRevision - Exact public link revision, when the purge is lifecycle-bound.
   * @param expectedParentLifecycleFences - Exact parent snapshot paired with the link revision.
   * @returns Current purge authority, no authority for unconditional cleanup, or stale authority.
   */
  private async resolveDeferredPurgeAuthority(
    workspaceId: string,
    linkId: string,
    expectedLinkRevision: number | undefined,
    expectedParentLifecycleFences: ExternalChatParentLifecycleFenceSnapshot | undefined,
  ): Promise<ExternalChatDeferredPurgeAuthority | null | undefined> {
    if ((expectedLinkRevision === undefined) !== (expectedParentLifecycleFences === undefined)) {
      invalidInput('A deferred purge must provide both link and parent authority expectations.')
    }
    if (expectedLinkRevision === undefined || expectedParentLifecycleFences === undefined) {
      return undefined
    }
    const revision = requirePositiveInteger(expectedLinkRevision, 'expected purge link revision')
    const ownerRow = await this.getRow(
      workspaceId,
      externalChatLinkRecordKey(linkId),
      'external-chat-link',
    )
    if (!ownerRow) return null
    const owner = decodeScopedLinkRow(ownerRow, workspaceId, linkId)
    if (!owner.active || owner.link.revision !== revision) return null
    const parentLifecycleFences = normalizeExpectedParentLifecycleFenceSnapshotForLink(
      expectedParentLifecycleFences,
      owner,
    )
    if (!await this.isParentLifecycleFenceSnapshotCurrent(owner, parentLifecycleFences)) {
      return null
    }
    return { ownerRow, owner, parentLifecycleFences }
  }

  /**
   * Rechecks a destructive purge capability after a conditional transaction is rejected.
   *
   * @param authority - Previously resolved exact link and parent authority.
   * @returns Whether every authoritative row remains byte-for-byte current.
   */
  private async isDeferredPurgeAuthorityCurrent(
    authority: ExternalChatDeferredPurgeAuthority,
  ): Promise<boolean> {
    const currentRow = await this.getRow(
      authority.owner.workspaceId,
      authority.ownerRow.recordKey,
      'external-chat-link',
    )
    if (
      !currentRow ||
      currentRow.storageRevision !== authority.ownerRow.storageRevision
    ) return false
    const current = decodeScopedLinkRow(
      currentRow,
      authority.owner.workspaceId,
      authority.owner.link.id,
    )
    return current.active &&
      current.link.revision === authority.owner.link.revision &&
      await this.isParentLifecycleFenceSnapshotCurrent(
        current,
        authority.parentLifecycleFences,
      )
  }

  /** Reads one strongly consistent row and verifies its tenant, key, and discriminator. */
  private async getRow(
    workspaceId: string,
    recordKey: string,
    entryType: ExternalChatPersistenceEntryType,
  ): Promise<ExternalChatPersistenceRow | undefined> {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey },
      ConsistentRead: true,
    }))
    return response.Item === undefined
      ? undefined
      : decodePersistenceRow(response.Item, workspaceId, recordKey, entryType)
  }

  /** Reads and validates one stored external chat link. */
  private async readLink(
    workspaceId: string,
    recordKey: string,
    expectedLinkId: string,
  ): Promise<StoredExternalChatLink | undefined> {
    const row = await this.getRow(
      workspaceId,
      recordKey,
      'external-chat-link',
    )
    return row
      ? decodeScopedLinkRow(row, workspaceId, expectedLinkId)
      : undefined
  }

  /** Writes a new receipt only when no physical row exists. */
  private async putNewReceipt(row: ExternalChatPersistenceRow): Promise<void> {
    await this.documentClient.send(new PutCommand({
      TableName: this.tableName,
      Item: row,
      ConditionExpression: 'attribute_not_exists(#workspaceId)',
      ExpressionAttributeNames: { '#workspaceId': 'workspaceId' },
    }))
  }

  /** Replaces one row only when its storage revision remains unchanged. */
  private async putRowConditionally(
    row: ExternalChatPersistenceRow,
    expectedStorageRevision: number,
  ): Promise<void> {
    await this.documentClient.send(new PutCommand({
      TableName: this.tableName,
      Item: row,
      ConditionExpression:
        '#entryType = :entryType AND #storageRevision = :storageRevision',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#storageRevision': 'storageRevision',
      },
      ExpressionAttributeValues: {
        ':entryType': row.entryType,
        ':storageRevision': expectedStorageRevision,
      },
    }))
  }

  /** Converts raw infrastructure failures to the stable application error boundary. */
  private async withPersistenceBoundary<TResult>(
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof ExternalChatError) throw error
      throw new ExternalChatError(
        'ExternalChatPersistenceFailed',
        'External chat persistence is temporarily unavailable.',
        true,
      )
    }
  }
}

/** Creates one common persistence row. */
function createRow(
  workspaceId: string,
  recordKey: string,
  entryType: ExternalChatPersistenceEntryType,
  value: unknown,
  storageRevision: number,
): ExternalChatPersistenceRow {
  return {
    workspaceId,
    recordKey,
    entryType,
    value,
    storageRevision,
  }
}

/**
 * Creates one active link row with its provider-parent sparse lookup projection.
 *
 * @param record - Active tenant-scoped link.
 * @param storageRevision - Physical row revision.
 * @returns Link row projected into the provider-parent lookup index.
 */
function createActiveLinkRow(
  record: StoredExternalChatLink,
  storageRevision: number,
): ExternalChatPersistenceRow {
  if (!record.active) invalidInput('Only active links may have a parent lookup projection.')
  return {
    ...createRow(
      record.workspaceId,
      externalChatLinkRecordKey(record.link.id),
      'external-chat-link',
      record,
      storageRevision,
    ),
    lookupKey: externalChatParentLinkLookupKey(
      record.workspaceId,
      record.link.provider,
      record.link.installationId,
      record.link.source.externalWorkspaceId,
    ),
    lookupSortKey: externalChatParentLinkLookupSortKey(record.link),
  }
}

/**
 * Creates a conditionally fenced Work Item link-membership manifest write.
 *
 * @param tableName - External chat table name.
 * @param manifest - Complete next owner generation and active-link count.
 * @param currentRow - Strongly read current manifest row, when one exists.
 * @returns One DynamoDB transaction Put action.
 */
function createWorkItemLinkManifestPut(
  tableName: string,
  manifest: ExternalChatWorkItemLinkManifest,
  currentRow: ExternalChatPersistenceRow | undefined,
): ExternalChatTransactWriteItem {
  const row = createRow(
    manifest.workspaceId,
    externalChatWorkItemLinkManifestRecordKey(manifest.teamId, manifest.workItemId),
    'external-chat-work-item-link-manifest',
    manifest,
    manifest.generation,
  )
  return {
    Put: {
      TableName: tableName,
      Item: row,
      ...(currentRow === undefined
        ? {
            ConditionExpression: 'attribute_not_exists(#workspaceId)',
            ExpressionAttributeNames: { '#workspaceId': 'workspaceId' },
          }
        : {
            ConditionExpression:
              '#entryType = :entryType AND #storageRevision = :storageRevision',
            ExpressionAttributeNames: {
              '#entryType': 'entryType',
              '#storageRevision': 'storageRevision',
            },
            ExpressionAttributeValues: {
              ':entryType': 'external-chat-work-item-link-manifest',
              ':storageRevision': currentRow.storageRevision,
            },
          }),
    },
  }
}

/** Creates one deferred event identity or occurrence-ordered FIFO row. */
function createDeferredEventRow(
  event: DeferredExternalChatEvent,
  recordKey: string,
  storageRevision: number,
): ExternalChatPersistenceRow {
  return createRow(
    event.workspaceId,
    recordKey,
    'external-chat-deferred-event',
    event,
    storageRevision,
  )
}

/**
 * Creates one deferred outbound identity or occurrence-ordered FIFO row.
 *
 * @param event - Validated outbound event queue entry.
 * @param recordKey - Server-derived physical row key.
 * @param storageRevision - Optimistic physical row revision.
 * @returns Deferred outbound event persistence row.
 */
function createDeferredOutboundEventRow(
  event: DeferredExternalChatOutboundEvent,
  recordKey: string,
  storageRevision: number,
): ExternalChatPersistenceRow {
  return createRow(
    event.workspaceId,
    recordKey,
    'external-chat-deferred-outbound-event',
    event,
    storageRevision,
  )
}

/** Decodes the common persistence envelope and rejects unexpected physical fields. */
function decodePersistenceRow(
  value: unknown,
  expectedWorkspaceId: string,
  expectedRecordKey: string | undefined,
  expectedEntryType: ExternalChatPersistenceEntryType,
): ExternalChatPersistenceRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidStoredRow('external chat persistence row')
  }
  const record = Object.fromEntries(Object.entries(value))
  const allowed = new Set([
    'workspaceId',
    'recordKey',
    'entryType',
    'value',
    'storageRevision',
    'lookupKey',
    'lookupSortKey',
  ])
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    invalidStoredRow('external chat persistence row properties')
  }
  const workspaceId = readStoredIdentifier(record.workspaceId, 'Workspace ID')
  const recordKey = readStoredIdentifier(record.recordKey, 'external chat record key')
  const entryType = requireEntryType(record.entryType)
  const storageRevision = readStoredPositiveInteger(
    record.storageRevision,
    'external chat storage revision',
  )
  if (
    workspaceId !== expectedWorkspaceId ||
    (expectedRecordKey !== undefined && recordKey !== expectedRecordKey) ||
    entryType !== expectedEntryType
  ) invalidStoredRow('external chat persistence row scope')
  const lookupKey = record.lookupKey === undefined
    ? undefined
    : readStoredIdentifier(record.lookupKey, 'external chat lookup key')
  const lookupSortKey = record.lookupSortKey === undefined
    ? undefined
    : readStoredIdentifier(record.lookupSortKey, 'external chat lookup sort key')
  if ((lookupKey === undefined) !== (lookupSortKey === undefined)) {
    invalidStoredRow('external chat sparse lookup projection')
  }
  return {
    workspaceId,
    recordKey,
    entryType,
    value: record.value,
    storageRevision,
    ...(lookupKey === undefined ? {} : { lookupKey }),
    ...(lookupSortKey === undefined ? {} : { lookupSortKey }),
  }
}

/** Decodes a source claim value. */
function decodeSourceClaim(value: unknown): ExternalChatSourceClaimValue {
  const record = readExactRecord(value, ['sourceDigest', 'linkId'], 'external chat source claim')
  return {
    sourceDigest: readStoredDigest(record.sourceDigest, 'external chat source digest'),
    linkId: readStoredIdentifier(record.linkId, 'external chat link ID'),
  }
}

/** Decodes a link command receipt value. */
function decodeLinkReceipt(value: unknown): ExternalChatLinkReceiptValue {
  const record = readExactRecord(
    value,
    ['requestFingerprint', 'linkId'],
    'external chat link receipt',
  )
  return {
    requestFingerprint: readStoredDigest(record.requestFingerprint, 'link request fingerprint'),
    linkId: readStoredIdentifier(record.linkId, 'external chat link ID'),
  }
}

/**
 * Decodes and scope-checks one Work Item link-membership manifest row.
 *
 * @param row - Strongly read persistence row.
 * @param workspaceId - Expected tenant identifier.
 * @param teamId - Expected Team identifier.
 * @param workItemId - Expected Work Item identifier.
 * @returns Exact validated membership manifest.
 */
function decodeScopedWorkItemLinkManifestRow(
  row: ExternalChatPersistenceRow,
  workspaceId: string,
  teamId: string,
  workItemId: string,
): ExternalChatWorkItemLinkManifest {
  const record = readExactRecord(
    row.value,
    ['workspaceId', 'teamId', 'workItemId', 'activeLinkCount', 'generation'],
    'external chat Work Item link manifest',
  )
  const manifest: ExternalChatWorkItemLinkManifest = {
    workspaceId: readStoredIdentifier(record.workspaceId, 'manifest Workspace ID'),
    teamId: readStoredIdentifier(record.teamId, 'manifest Team ID'),
    workItemId: readStoredIdentifier(record.workItemId, 'manifest Work Item ID'),
    activeLinkCount: readStoredNonnegativeInteger(
      record.activeLinkCount,
      'manifest active link count',
    ),
    generation: readStoredPositiveInteger(record.generation, 'manifest generation'),
  }
  if (
    manifest.workspaceId !== workspaceId ||
    manifest.teamId !== teamId ||
    manifest.workItemId !== workItemId ||
    row.storageRevision !== manifest.generation ||
    row.recordKey !== externalChatWorkItemLinkManifestRecordKey(teamId, workItemId)
  ) invalidStoredRow('external chat Work Item link manifest scope')
  return manifest
}

/**
 * Advances one Work Item membership manifest after a link is created.
 *
 * @param current - Current manifest, when one exists.
 * @param workspaceId - Canonical tenant identifier.
 * @param teamId - Owning Team identifier.
 * @param workItemId - Owning Work Item identifier.
 * @returns Next membership generation and active-link count.
 */
function incrementWorkItemLinkManifest(
  current: ExternalChatWorkItemLinkManifest | undefined,
  workspaceId: string,
  teamId: string,
  workItemId: string,
): ExternalChatWorkItemLinkManifest {
  if (
    current &&
    (current.workspaceId !== workspaceId ||
      current.teamId !== teamId ||
      current.workItemId !== workItemId)
  ) invalidStoredRow('external chat Work Item link manifest scope')
  if (
    current &&
    (current.activeLinkCount >= Number.MAX_SAFE_INTEGER ||
      current.generation >= Number.MAX_SAFE_INTEGER)
  ) invalidStoredRow('external chat Work Item link manifest capacity')
  return {
    workspaceId,
    teamId,
    workItemId,
    activeLinkCount: (current?.activeLinkCount ?? 0) + 1,
    generation: (current?.generation ?? 0) + 1,
  }
}

/**
 * Advances one Work Item membership manifest after an active link is removed.
 *
 * @param current - Current nonempty membership manifest.
 * @returns Next membership generation and active-link count.
 */
function decrementWorkItemLinkManifest(
  current: ExternalChatWorkItemLinkManifest,
): ExternalChatWorkItemLinkManifest {
  if (current.activeLinkCount < 1 || current.generation >= Number.MAX_SAFE_INTEGER) {
    invalidStoredRow('external chat Work Item link manifest count')
  }
  return {
    ...current,
    activeLinkCount: current.activeLinkCount - 1,
    generation: current.generation + 1,
  }
}

/**
 * Compares two link-ID collections as exact unique sets.
 *
 * @param left - First link-ID collection.
 * @param right - Second link-ID collection.
 * @returns Whether both collections contain exactly the same unique IDs.
 */
function sameLinkIdSet(left: readonly string[], right: readonly string[]): boolean {
  if (
    left.length !== right.length ||
    new Set(left).size !== left.length ||
    new Set(right).size !== right.length
  ) return false
  const sortedLeft = [...left].sort(compareOrdinal)
  const sortedRight = [...right].sort(compareOrdinal)
  return sortedLeft.every((linkId, index) => linkId === sortedRight[index])
}

/**
 * Decodes one authoritative provider-parent lifecycle fence from durable state.
 *
 * @param value - Untrusted persisted fence value.
 * @returns Exact validated parent lifecycle fence.
 */
function decodeExternalChatParentLifecycleFence(
  value: unknown,
): ExternalChatParentLifecycleFence {
  const record = readExactRecord(value, [
    'workspaceId',
    'provider',
    'installationId',
    'externalWorkspaceId',
    'conversationExternalId',
    'authorizationRevision',
    'availability',
    'state',
    'restrictive',
    'eventId',
    'operationId',
    'occurredAt',
  ], 'external chat parent lifecycle fence')
  const provider = record.provider === 'slack' || record.provider === 'microsoft-teams'
    ? record.provider
    : undefined
  const availability = readStoredSourceAvailability(record.availability)
  const state = readStoredParentSourceState(record.state)
  if (
    !provider ||
    typeof record.restrictive !== 'boolean' ||
    record.restrictive !== externalChatLifecycleBlocksSynchronization(availability, state)
  ) {
    invalidStoredRow('external chat parent lifecycle fence')
  }
  const occurredAt = readStoredIdentifier(
    record.occurredAt,
    'parent lifecycle occurrence timestamp',
  )
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(occurredAt) || !Number.isFinite(Date.parse(occurredAt))) {
    invalidStoredRow('parent lifecycle occurrence timestamp')
  }
  return {
    workspaceId: readStoredIdentifier(record.workspaceId, 'parent lifecycle Workspace ID'),
    provider,
    installationId: readStoredIdentifier(
      record.installationId,
      'parent lifecycle installation ID',
    ),
    externalWorkspaceId: readStoredIdentifier(
      record.externalWorkspaceId,
      'parent lifecycle external Workspace ID',
    ),
    ...(record.conversationExternalId === undefined
      ? {}
      : {
        conversationExternalId: readStoredIdentifier(
          record.conversationExternalId,
          'parent lifecycle conversation ID',
        ),
      }),
    authorizationRevision: readStoredPositiveInteger(
      record.authorizationRevision,
      'parent lifecycle authorization revision',
    ),
    availability,
    state,
    restrictive: record.restrictive,
    eventId: readStoredIdentifier(record.eventId, 'parent lifecycle event ID'),
    operationId: readStoredIdentifier(record.operationId, 'parent lifecycle operation ID'),
    occurredAt,
  }
}

/** Decodes a safe DynamoDB continuation key without forwarding arbitrary attributes. */
function decodeExclusiveStartKey(value: unknown): ExternalChatExclusiveStartKey | undefined {
  if (value === undefined) return undefined
  const record = readExactRecord(
    value,
    ['workspaceId', 'recordKey', 'lookupKey', 'lookupSortKey'],
    'external chat pagination key',
  )
  const workspaceId = readStoredIdentifier(record.workspaceId, 'pagination Workspace ID')
  const recordKey = readStoredIdentifier(record.recordKey, 'pagination record key')
  const lookupKey = record.lookupKey === undefined
    ? undefined
    : readStoredIdentifier(record.lookupKey, 'pagination lookup key')
  const lookupSortKey = record.lookupSortKey === undefined
    ? undefined
    : readStoredIdentifier(record.lookupSortKey, 'pagination lookup sort key')
  if ((lookupKey === undefined) !== (lookupSortKey === undefined)) {
    invalidStoredRow('external chat pagination index key')
  }
  return {
    workspaceId,
    recordKey,
    ...(lookupKey === undefined ? {} : { lookupKey }),
    ...(lookupSortKey === undefined ? {} : { lookupSortKey }),
  }
}

/**
 * Encodes a validated parent-link continuation for durable receipt checkpointing.
 *
 * @param key - DynamoDB exclusive start key returned by the base-table lookup.
 * @param scopeDigest - Digest binding the cursor to its exact provider parent lookup.
 * @returns Opaque bounded parent-link cursor.
 */
function encodeParentLinkCursor(
  key: ExternalChatExclusiveStartKey,
  scopeDigest: string,
): string {
  if (key.lookupKey !== undefined || key.lookupSortKey !== undefined) {
    invalidStoredRow('external chat parent link pagination key')
  }
  return Buffer.from(JSON.stringify({
    scopeDigest,
    exclusiveStartKey: {
      workspaceId: key.workspaceId,
      recordKey: key.recordKey,
    },
  }), 'utf8').toString('base64url')
}

/**
 * Decodes and binds a durable parent-link cursor to its exact lookup scope.
 *
 * @param cursor - Opaque cursor retained by the inbound receipt.
 * @param workspaceId - Expected tenant partition.
 * @param recordPrefix - Expected strongly consistent base-table record prefix.
 * @param scopeDigest - Digest binding the cursor to its exact provider parent lookup.
 * @returns Validated DynamoDB exclusive start key.
 */
function decodeParentLinkCursor(
  cursor: string,
  workspaceId: string,
  recordPrefix: string,
  scopeDigest: string,
): ExternalChatExclusiveStartKey {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    invalidInput('The parent lifecycle fan-out cursor is invalid.')
  }
  const record = readExactRecord(
    parsed,
    ['scopeDigest', 'exclusiveStartKey'],
    'external chat parent link cursor',
  )
  if (readStoredDigest(record.scopeDigest, 'parent link cursor scope') !== scopeDigest) {
    invalidInput('The parent lifecycle fan-out cursor scope is invalid.')
  }
  const key = decodeExclusiveStartKey(record.exclusiveStartKey)
  if (
    key === undefined ||
    key.workspaceId !== workspaceId ||
    key.lookupKey !== undefined ||
    key.lookupSortKey !== undefined ||
    !key.recordKey.startsWith(recordPrefix)
  ) invalidInput('The parent lifecycle fan-out cursor scope is invalid.')
  return key
}

/**
 * Creates the link-side transaction condition for a lifecycle claim or completion.
 *
 * @param tableName - External chat table name.
 * @param workspaceId - Tenant partition key.
 * @param recordKey - Server-derived link row key.
 * @param row - Strongly read link row being fenced.
 * @param provider - Expected provider stored on the link.
 * @param expectedLinkRevision - Expected public link revision.
 * @returns One DynamoDB transaction condition action.
 */
function createThreadLifecycleLinkCondition(
  tableName: string,
  workspaceId: string,
  recordKey: string,
  row: ExternalChatPersistenceRow,
  provider: ExternalChatProvider,
  expectedLinkRevision: number,
): ExternalChatTransactWriteItem {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { workspaceId, recordKey },
      ConditionExpression:
        '#entryType = :entryType AND #storageRevision = :storageRevision AND ' +
        '#value.#active = :active AND #value.#link.#provider = :provider AND ' +
        '#value.#link.#revision = :linkRevision',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#storageRevision': 'storageRevision',
        '#value': 'value',
        '#active': 'active',
        '#link': 'link',
        '#provider': 'provider',
        '#revision': 'revision',
      },
      ExpressionAttributeValues: {
        ':entryType': 'external-chat-link',
        ':storageRevision': row.storageRevision,
        ':active': true,
        ':provider': provider,
        ':linkRevision': expectedLinkRevision,
      },
    },
  }
}

/**
 * Creates the link-owner write fence that serializes a message binding with duplicate merge.
 *
 * The collaboration or provider mutation must use the same expected owner. If a merge, unlink,
 * or settings projection wins first, this condition rejects the stale binding so the operation
 * can resume against the canonical link owner. Advancing the private storage revision also makes
 * a binding committed after a merge scan invalidate that merge's final transaction.
 *
 * @param tableName - External chat table name.
 * @param row - Strongly read link row being fenced.
 * @param expectedTeamId - Team expected to own the link.
 * @param expectedWorkItemId - Work Item expected to own the link.
 * @param expectedLinkRevision - Public link revision observed before the side effect.
 * @returns One DynamoDB transaction write fence.
 */
function createMessageBindingOwnerFence(
  tableName: string,
  row: ExternalChatPersistenceRow,
  expectedTeamId: string,
  expectedWorkItemId: string,
  expectedLinkRevision: number,
): ExternalChatTransactWriteItem {
  return {
    Put: {
      TableName: tableName,
      Item: {
        ...row,
        storageRevision: row.storageRevision + 1,
      },
      ConditionExpression:
        '#entryType = :entryType AND #storageRevision = :storageRevision AND ' +
        '#value.#active = :active AND #value.#link.#teamId = :teamId AND ' +
        '#value.#link.#workItemId = :workItemId AND #value.#link.#revision = :linkRevision',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#storageRevision': 'storageRevision',
        '#value': 'value',
        '#active': 'active',
        '#link': 'link',
        '#teamId': 'teamId',
        '#workItemId': 'workItemId',
        '#revision': 'revision',
      },
      ExpressionAttributeValues: {
        ':entryType': 'external-chat-link',
        ':storageRevision': row.storageRevision,
        ':active': true,
        ':teamId': expectedTeamId,
        ':workItemId': expectedWorkItemId,
        ':linkRevision': expectedLinkRevision,
      },
    },
  }
}

/** Creates an absence condition for a server-derived lifecycle row key. */
function createAbsentThreadLifecycleCondition(
  tableName: string,
  workspaceId: string,
  recordKey: string,
): ExternalChatTransactWriteItem {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { workspaceId, recordKey },
      ConditionExpression: 'attribute_not_exists(#workspaceId)',
      ExpressionAttributeNames: { '#workspaceId': 'workspaceId' },
    },
  }
}

/** Creates a storage-revision condition for an existing lifecycle row. */
function createThreadLifecycleStorageCondition(
  tableName: string,
  workspaceId: string,
  recordKey: string,
  expectedStorageRevision: number,
): ExternalChatTransactWriteItem {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { workspaceId, recordKey },
      ConditionExpression:
        '#entryType = :entryType AND #storageRevision = :storageRevision',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#storageRevision': 'storageRevision',
      },
      ExpressionAttributeValues: {
        ':entryType': 'external-chat-thread-lifecycle',
        ':storageRevision': expectedStorageRevision,
      },
    },
  }
}

/** Creates a transaction Put fenced by an existing row's storage revision. */
function createConditionalRowPut(
  tableName: string,
  row: ExternalChatPersistenceRow,
  expectedStorageRevision: number,
): ExternalChatTransactWriteItem {
  return {
    Put: {
      TableName: tableName,
      Item: row,
      ConditionExpression:
        '#entryType = :entryType AND #storageRevision = :storageRevision',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#storageRevision': 'storageRevision',
      },
      ExpressionAttributeValues: {
        ':entryType': row.entryType,
        ':storageRevision': expectedStorageRevision,
      },
    },
  }
}

/** Creates a transaction Put that succeeds only when the physical row is absent. */
function createNewRowPut(
  tableName: string,
  row: ExternalChatPersistenceRow,
): ExternalChatTransactWriteItem {
  return {
    Put: {
      TableName: tableName,
      Item: row,
      ConditionExpression: 'attribute_not_exists(#workspaceId)',
      ExpressionAttributeNames: { '#workspaceId': 'workspaceId' },
    },
  }
}

/** Creates a transaction Delete fenced by the row discriminator and storage revision. */
function createConditionalRowDelete(
  tableName: string,
  row: ExternalChatPersistenceRow,
): ExternalChatTransactWriteItem {
  return {
    Delete: {
      TableName: tableName,
      Key: {
        workspaceId: row.workspaceId,
        recordKey: row.recordKey,
      },
      ConditionExpression:
        '#entryType = :entryType AND #storageRevision = :storageRevision',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#storageRevision': 'storageRevision',
      },
      ExpressionAttributeValues: {
        ':entryType': row.entryType,
        ':storageRevision': row.storageRevision,
      },
    },
  }
}

/**
 * Creates the link-state condition that prevents deferred content after restrictive redaction.
 *
 * @param tableName - External chat table name.
 * @param linkRow - Strongly read active link row.
 * @returns Transaction condition bound to the exact link revision and nonrestrictive state.
 */
function createDeferredContentLinkCondition(
  tableName: string,
  linkRow: ExternalChatPersistenceRow,
): ExternalChatTransactWriteItem {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { workspaceId: linkRow.workspaceId, recordKey: linkRow.recordKey },
      ConditionExpression:
        '#entryType = :entryType AND #storageRevision = :storageRevision AND ' +
        '#value.#active = :active AND ' +
        '#value.#link.#sourceAvailability <> :permissionLost AND ' +
        '#value.#link.#sourceAvailability <> :scopeChanged AND ' +
        '#value.#link.#sourceState <> :retainedMetadata AND ' +
        '#value.#link.#sourceState <> :deleted AND ' +
        '#value.#link.#sourceState <> :retentionExpired',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#storageRevision': 'storageRevision',
        '#value': 'value',
        '#active': 'active',
        '#link': 'link',
        '#sourceAvailability': 'sourceAvailability',
        '#sourceState': 'sourceState',
      },
      ExpressionAttributeValues: {
        ':entryType': 'external-chat-link',
        ':storageRevision': linkRow.storageRevision,
        ':active': true,
        ':permissionLost': 'permission-lost',
        ':scopeChanged': 'scope-changed',
        ':retainedMetadata': 'retained-metadata',
        ':deleted': 'deleted',
        ':retentionExpired': 'retention-expired',
      },
    },
  }
}

/**
 * Creates the exact active-link condition authorizing a destructive deferred-content purge.
 *
 * @param tableName - External chat table name.
 * @param authority - Strongly read link and parent capability owning the purge.
 * @returns Transaction condition rejected after recovery, settings change, merge, or unlink.
 */
function createExpectedLinkPurgeAuthorityCondition(
  tableName: string,
  authority: ExternalChatDeferredPurgeAuthority,
): ExternalChatTransactWriteItem {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: {
        workspaceId: authority.ownerRow.workspaceId,
        recordKey: authority.ownerRow.recordKey,
      },
      ConditionExpression:
        '#entryType = :entryType AND #storageRevision = :storageRevision AND ' +
        '#value.#active = :active AND #value.#link.#teamId = :teamId AND ' +
        '#value.#link.#workItemId = :workItemId AND #value.#link.#revision = :linkRevision',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#storageRevision': 'storageRevision',
        '#value': 'value',
        '#active': 'active',
        '#link': 'link',
        '#teamId': 'teamId',
        '#workItemId': 'workItemId',
        '#revision': 'revision',
      },
      ExpressionAttributeValues: {
        ':entryType': 'external-chat-link',
        ':storageRevision': authority.ownerRow.storageRevision,
        ':active': true,
        ':teamId': authority.owner.link.teamId,
        ':workItemId': authority.owner.link.workItemId,
        ':linkRevision': authority.owner.link.revision,
      },
    },
  }
}

/**
 * Creates a conditional lifecycle row Put for either creation or replacement.
 *
 * @param tableName - External chat table name.
 * @param row - Complete lifecycle persistence row.
 * @param expectedStorageRevision - Strongly read prior revision, omitted for creation.
 * @returns One DynamoDB transaction Put action.
 */
function createThreadLifecyclePut(
  tableName: string,
  row: ExternalChatPersistenceRow,
  expectedStorageRevision: number | undefined,
): ExternalChatTransactWriteItem {
  return {
    Put: {
      TableName: tableName,
      Item: row,
      ...(expectedStorageRevision === undefined
        ? {
            ConditionExpression: 'attribute_not_exists(#workspaceId)',
            ExpressionAttributeNames: { '#workspaceId': 'workspaceId' },
          }
        : {
            ConditionExpression:
              '#entryType = :entryType AND #storageRevision = :storageRevision',
            ExpressionAttributeNames: {
              '#entryType': 'entryType',
              '#storageRevision': 'storageRevision',
            },
            ExpressionAttributeValues: {
              ':entryType': 'external-chat-thread-lifecycle',
              ':storageRevision': expectedStorageRevision,
            },
          }),
    },
  }
}

/** Creates a transaction Put for one identity projection. */
function createBindingPut(
  tableName: string,
  row: ExternalChatPersistenceRow,
  expectedStorageRevision: number | undefined,
): ExternalChatTransactWriteItem {
  return {
    Put: {
      TableName: tableName,
      Item: row,
      ...(expectedStorageRevision === undefined
        ? {
            ConditionExpression: 'attribute_not_exists(#workspaceId)',
            ExpressionAttributeNames: { '#workspaceId': 'workspaceId' },
          }
        : {
            ConditionExpression:
              '#entryType = :entryType AND #storageRevision = :storageRevision',
            ExpressionAttributeNames: {
              '#entryType': 'entryType',
              '#storageRevision': 'storageRevision',
            },
            ExpressionAttributeValues: {
              ':entryType': row.entryType,
              ':storageRevision': expectedStorageRevision,
            },
          }),
    },
  }
}

/** Validates a link row against its tenant and logical identifier. */
function decodeScopedLinkRow(
  row: ExternalChatPersistenceRow,
  workspaceId: string,
  linkId: string,
): StoredExternalChatLink {
  const record = decodeStoredExternalChatLink(row.value)
  const expectedSourceDigest = createExternalChatSourceDigest({
    provider: record.link.provider,
    externalWorkspaceId: record.link.source.externalWorkspaceId,
    conversationExternalId: record.link.source.conversationExternalId,
    threadExternalId: record.link.source.threadExternalId,
  })
  if (
    record.workspaceId !== workspaceId ||
    record.link.id !== linkId ||
    record.sourceDigest !== expectedSourceDigest
  ) {
    invalidStoredRow('external chat link scope')
  }
  return record
}

/**
 * Requires one active strongly read link at the expected provider and public revision.
 *
 * @param row - Strongly read tenant-scoped link row.
 * @param workspaceId - Expected Workspace identifier.
 * @param linkId - Expected link identifier.
 * @param provider - Expected provider.
 * @param expectedRevision - Previously observed public link revision.
 * @returns Validated logical record and its physical storage row.
 */
function requireActiveThreadLifecycleLink(
  row: ExternalChatPersistenceRow | undefined,
  workspaceId: string,
  linkId: string,
  provider: ExternalChatProvider,
  expectedRevision: number,
): SelectedThreadLifecycleLink {
  if (!row) {
    throw new ExternalChatError(
      'ExternalChatNotFound',
      'The active external chat link does not exist.',
    )
  }
  const record = decodeScopedLinkRow(row, workspaceId, linkId)
  if (!record.active) {
    throw new ExternalChatError(
      'ExternalChatNotFound',
      'The active external chat link does not exist.',
    )
  }
  if (record.link.provider !== provider) {
    invalidInput('The thread lifecycle provider does not match the external chat link.')
  }
  if (record.link.revision !== expectedRevision) {
    throw new ExternalChatError(
      'ExternalChatRevisionConflict',
      'The external chat link revision changed before lifecycle processing.',
    )
  }
  return { record, row }
}

/** Validates a lifecycle value against the server-derived tenant, link, and provider key. */
function validateThreadLifecycleScope(
  record: StoredExternalChatThreadLifecycle,
  workspaceId: string,
  linkId: string,
  provider: ExternalChatProvider,
): void {
  if (
    record.workspaceId !== workspaceId ||
    record.linkId !== linkId ||
    record.provider !== provider
  ) invalidStoredRow('external chat thread lifecycle scope')
}

/** Checks whether a link mutation is idle or belongs to a completed lifecycle owner. */
function threadLifecycleAllowsLinkMutation(
  record: StoredExternalChatThreadLifecycle,
  operationId: string | undefined,
): boolean {
  if (record.lease.status === 'acknowledged') return true
  return record.lease.status === 'completed' && record.lease.operationId === operationId
}

/** Validates caller-owned lifecycle state shape without interpreting provider ordering. */
function validateThreadLifecycleStateInput(
  state: StoredExternalChatThreadLifecycle['state'],
  expectedRevision: number,
  completedAt: string,
): void {
  if (typeof state.completed !== 'boolean') {
    invalidInput('The thread lifecycle completion state is invalid.')
  }
  const revision = requireNonnegativeInteger(
    state.revision,
    'thread lifecycle state revision',
  )
  if (revision !== expectedRevision) {
    invalidInput('The thread lifecycle state revision must advance exactly once.')
  }
  const updatedAt = requireTimestamp(
    state.updatedAt,
    'thread lifecycle state update timestamp',
  )
  if (updatedAt !== completedAt) {
    invalidInput('The thread lifecycle state timestamp must match its completion timestamp.')
  }
  if (state.lastExternalVersion !== undefined) {
    requireIdentifier(state.lastExternalVersion, 'last external thread version')
  }
  if (state.lastInternalWorkItemRevision !== undefined) {
    requirePositiveInteger(
      state.lastInternalWorkItemRevision,
      'last internal Work Item revision',
    )
  }
}

/** Increments a durable lifecycle lease attempt within the safe integer range. */
function incrementStoredLifecycleAttempt(current: number): number {
  if (current === Number.MAX_SAFE_INTEGER) {
    invalidStoredRow('external chat thread lifecycle attempt')
  }
  return current + 1
}

/** Compares complete lifecycle states through their canonical normalized fingerprint. */
function sameThreadLifecycleState(
  left: StoredExternalChatThreadLifecycle['state'],
  right: StoredExternalChatThreadLifecycle['state'],
): boolean {
  return createExternalChatFingerprint(left) === createExternalChatFingerprint(right)
}

/** Validates that a caller source is complete and provider-neutral. */
function validateSourceIdentity(source: ExternalChatSourceIdentity): void {
  requireProvider(source.provider)
  requireIdentifier(source.externalWorkspaceId, 'external workspace ID')
  requireIdentifier(source.conversationExternalId, 'external conversation ID')
  requireIdentifier(source.threadExternalId, 'external thread ID')
}

/**
 * Validates one provider-parent lifecycle fence at the persistence boundary.
 *
 * @param input - Untrusted parent lifecycle fence input.
 * @returns Exact normalized input safe for key derivation and persistence.
 */
function normalizeParentLifecycleFenceInput(
  input: FenceExternalChatParentLifecycleInput,
): FenceExternalChatParentLifecycleInput {
  const conversationExternalId = input.conversationExternalId === undefined
    ? undefined
    : requireIdentifier(input.conversationExternalId, 'parent conversation ID')
  const availability = requireSourceAvailability(input.availability)
  const state = requireParentSourceState(input.state)
  if (
    typeof input.restrictive !== 'boolean' ||
    input.restrictive !== externalChatLifecycleBlocksSynchronization(availability, state)
  ) {
    invalidInput('The provider parent lifecycle fence is invalid.')
  }
  return {
    workspaceId: requireIdentifier(input.workspaceId, 'Workspace ID'),
    provider: requireProvider(input.provider),
    installationId: requireIdentifier(input.installationId, 'installation ID'),
    externalWorkspaceId: requireIdentifier(
      input.externalWorkspaceId,
      'external Workspace ID',
    ),
    ...(conversationExternalId === undefined ? {} : { conversationExternalId }),
    ...(input.authorizationRevision === undefined
      ? {}
      : {
        authorizationRevision: requirePositiveInteger(
          input.authorizationRevision,
          'provider authorization revision',
        ),
      }),
    availability,
    state,
    restrictive: input.restrictive,
    eventId: requireIdentifier(input.eventId, 'provider event ID'),
    operationId: requireIdentifier(input.operationId, 'operation ID'),
    occurredAt: requireTimestamp(input.occurredAt, 'parent occurrence timestamp'),
  }
}

/**
 * Constructs one complete durable provider-parent lifecycle fence.
 *
 * @param input - Normalized fence input.
 * @param authorizationRevision - Verified provider authorization generation.
 * @returns Exact durable lifecycle fence.
 */
function createParentLifecycleFence(
  input: FenceExternalChatParentLifecycleInput,
  authorizationRevision: number,
): ExternalChatParentLifecycleFence {
  return {
    workspaceId: input.workspaceId,
    provider: input.provider,
    installationId: input.installationId,
    externalWorkspaceId: input.externalWorkspaceId,
    ...(input.conversationExternalId === undefined
      ? {}
      : { conversationExternalId: input.conversationExternalId }),
    authorizationRevision,
    availability: input.availability,
    state: input.state,
    restrictive: input.restrictive,
    eventId: input.eventId,
    operationId: input.operationId,
    occurredAt: input.occurredAt,
  }
}

/**
 * Normalizes and scope-checks one atomic parent fence expected by a link projection.
 *
 * @param fence - Candidate full parent lifecycle authority.
 * @param record - Link whose projection will be conditionally updated.
 * @returns Exact validated parent fence matching the link's workspace or conversation.
 */
function normalizeExpectedParentLifecycleFenceForLink(
  fence: ExternalChatParentLifecycleFence,
  record: StoredExternalChatLink,
): ExternalChatParentLifecycleFence {
  const normalizedInput = normalizeParentLifecycleFenceInput(fence)
  const authorizationRevision = normalizedInput.authorizationRevision
  if (authorizationRevision === undefined) {
    invalidInput('The expected parent lifecycle fence requires its authorization revision.')
  }
  const normalized = createParentLifecycleFence(normalizedInput, authorizationRevision)
  const recordKey = externalChatParentLifecycleRecordKey(
    normalized.provider,
    normalized.installationId,
    normalized.externalWorkspaceId,
    normalized.conversationExternalId,
  )
  validateParentLifecycleFenceForLink(normalized, record, recordKey)
  return normalized
}

/**
 * Normalizes both exact present-or-absent parent authorities expected by one link update.
 *
 * @param snapshot - Candidate workspace and conversation parent snapshot.
 * @param record - Link whose immutable provider scope owns both expectations.
 * @returns Exact validated parent fence snapshot.
 */
function normalizeExpectedParentLifecycleFenceSnapshotForLink(
  snapshot: ExternalChatParentLifecycleFenceSnapshot,
  record: StoredExternalChatLink,
): ExternalChatParentLifecycleFenceSnapshot {
  const workspace = snapshot.workspace === undefined
    ? undefined
    : normalizeExpectedParentLifecycleFenceForLink(snapshot.workspace, record)
  const conversation = snapshot.conversation === undefined
    ? undefined
    : normalizeExpectedParentLifecycleFenceForLink(snapshot.conversation, record)
  if (workspace?.conversationExternalId !== undefined) {
    invalidInput('The expected workspace lifecycle fence must be workspace-scoped.')
  }
  if (
    conversation !== undefined &&
    conversation.conversationExternalId !== record.link.source.conversationExternalId
  ) {
    invalidInput('The expected conversation lifecycle fence must be conversation-scoped.')
  }
  return { workspace, conversation }
}

/**
 * Detects an exact replay of one already committed parent lifecycle operation.
 *
 * @param current - Current authoritative parent fence.
 * @param input - Normalized incoming fence update.
 * @returns Whether the same operation already committed the same payload.
 */
function parentLifecycleFenceReplays(
  current: ExternalChatParentLifecycleFence,
  input: FenceExternalChatParentLifecycleInput,
): boolean {
  if (current.operationId !== input.operationId || current.eventId !== input.eventId) return false
  const candidate = createParentLifecycleFence(
    input,
    input.authorizationRevision ?? current.authorizationRevision,
  )
  if (!sameParentLifecycleFence(current, candidate)) {
    throw new ExternalChatError(
      'ExternalChatEventConflict',
      'The parent lifecycle operation was reused with another payload.',
    )
  }
  return true
}

/**
 * Compares every persisted field of two parent lifecycle fences.
 *
 * @param left - First durable fence.
 * @param right - Second durable fence.
 * @returns Whether both fences represent the same authoritative update.
 */
function sameParentLifecycleFence(
  left: ExternalChatParentLifecycleFence,
  right: ExternalChatParentLifecycleFence,
): boolean {
  return left.workspaceId === right.workspaceId &&
    left.provider === right.provider &&
    left.installationId === right.installationId &&
    left.externalWorkspaceId === right.externalWorkspaceId &&
    left.conversationExternalId === right.conversationExternalId &&
    left.authorizationRevision === right.authorizationRevision &&
    left.availability === right.availability &&
    left.state === right.state &&
    left.restrictive === right.restrictive &&
    left.eventId === right.eventId &&
    left.operationId === right.operationId &&
    left.occurredAt === right.occurredAt
}

/**
 * Compares exact workspace and conversation parent lifecycle snapshot authority.
 *
 * @param left - Current present-or-absent snapshot.
 * @param right - Expected present-or-absent snapshot.
 * @returns Whether both parent rows are exactly equal, including absence.
 */
function sameParentLifecycleFenceSnapshot(
  left: ExternalChatParentLifecycleFenceSnapshot,
  right: ExternalChatParentLifecycleFenceSnapshot,
): boolean {
  return (
    left.workspace === undefined
      ? right.workspace === undefined
      : right.workspace !== undefined && sameParentLifecycleFence(left.workspace, right.workspace)
  ) && (
    left.conversation === undefined
      ? right.conversation === undefined
      : right.conversation !== undefined &&
        sameParentLifecycleFence(left.conversation, right.conversation)
  )
}

/**
 * Orders parent lifecycle fences by provider authorization generation and event identity.
 *
 * @param left - Incoming candidate fence.
 * @param right - Current authoritative fence.
 * @returns Standard sort comparator result.
 */
function compareParentLifecycleFences(
  left: ExternalChatParentLifecycleFence,
  right: ExternalChatParentLifecycleFence,
): number {
  return left.authorizationRevision - right.authorizationRevision ||
    compareOrdinal(left.occurredAt, right.occurredAt) ||
    compareOrdinal(left.eventId, right.eventId)
}

/**
 * Checks whether one parent fence invalidates a source resolved at a provider generation.
 *
 * @param fence - Current authoritative parent lifecycle fence.
 * @param authorizationRevision - Generation used to resolve the candidate link source.
 * @returns Whether link creation must fail closed.
 */
function parentLifecycleFenceBlocks(
  fence: ExternalChatParentLifecycleFence,
  authorizationRevision: number,
): boolean {
  return fence.authorizationRevision > authorizationRevision ||
    (fence.authorizationRevision === authorizationRevision && fence.restrictive)
}

/**
 * Validates a decoded parent fence against its requested scope and physical address.
 *
 * @param fence - Decoded durable fence.
 * @param input - Normalized requested scope.
 * @param recordKey - Physical row key used to load the fence.
 */
function validateParentLifecycleFenceScope(
  fence: ExternalChatParentLifecycleFence,
  input: FenceExternalChatParentLifecycleInput,
  recordKey: string,
): void {
  if (
    fence.workspaceId !== input.workspaceId ||
    fence.provider !== input.provider ||
    fence.installationId !== input.installationId ||
    fence.externalWorkspaceId !== input.externalWorkspaceId ||
    fence.conversationExternalId !== input.conversationExternalId ||
    externalChatParentLifecycleRecordKey(
      fence.provider,
      fence.installationId,
      fence.externalWorkspaceId,
      fence.conversationExternalId,
    ) !== recordKey
  ) invalidStoredRow('external chat parent lifecycle fence scope')
}

/**
 * Validates a decoded parent fence against one candidate link and its physical address.
 *
 * @param fence - Decoded durable fence.
 * @param record - Candidate link whose parent condition failed.
 * @param recordKey - Physical row key used to load the fence.
 */
function validateParentLifecycleFenceForLink(
  fence: ExternalChatParentLifecycleFence,
  record: StoredExternalChatLink,
  recordKey: string,
): void {
  const expectedConversationExternalId = recordKey === externalChatParentLifecycleRecordKey(
    record.link.provider,
    record.link.installationId,
    record.link.source.externalWorkspaceId,
    undefined,
  )
    ? undefined
    : record.link.source.conversationExternalId
  if (
    fence.workspaceId !== record.workspaceId ||
    fence.provider !== record.link.provider ||
    fence.installationId !== record.link.installationId ||
    fence.externalWorkspaceId !== record.link.source.externalWorkspaceId ||
    fence.conversationExternalId !== expectedConversationExternalId ||
    externalChatParentLifecycleRecordKey(
      fence.provider,
      fence.installationId,
      fence.externalWorkspaceId,
      fence.conversationExternalId,
    ) !== recordKey
  ) invalidStoredRow('external chat parent lifecycle fence link scope')
}

/** Validates that a link snapshot claims the exact requested source identity. */
function validateLinkMatchesSource(
  link: ExternalChatWorkItemLink,
  source: ExternalChatSourceIdentity,
): void {
  if (
    link.provider !== source.provider ||
    link.workspace.externalId !== source.externalWorkspaceId ||
    link.conversation.externalId !== source.conversationExternalId ||
    link.source.threadExternalId !== source.threadExternalId
  ) invalidInput('The external chat link does not match its source claim.')
}

/** Validates immutable fields across a link replacement. */
function validateLinkReplacement(
  current: StoredExternalChatLink,
  replacement: StoredExternalChatLink,
): void {
  if (
    replacement.workspaceId !== current.workspaceId ||
    replacement.link.id !== current.link.id ||
    replacement.link.teamId !== current.link.teamId ||
    replacement.link.workItemId !== current.link.workItemId ||
    replacement.sourceDigest !== current.sourceDigest ||
    replacement.sourceAuthorizationRevision < current.sourceAuthorizationRevision ||
    replacement.active !== current.active ||
    replacement.unlinkedAt !== current.unlinkedAt ||
    replacement.link.provider !== current.link.provider ||
    replacement.link.installationId !== current.link.installationId ||
    replacement.link.source.externalWorkspaceId !==
      current.link.source.externalWorkspaceId ||
    replacement.link.source.conversationExternalId !==
      current.link.source.conversationExternalId ||
    replacement.link.source.threadExternalId !== current.link.source.threadExternalId
  ) invalidInput('Immutable external chat link identity fields cannot change.')
}

/** Validates an inbound receipt against the event scope used to address it. */
function validateInboundReceiptScope(
  current: ExternalChatInboundReceipt,
  requested: ExternalChatInboundReceipt,
): void {
  if (
    current.workspaceId !== requested.workspaceId ||
    current.eventId !== requested.eventId ||
    current.provider !== requested.provider ||
    current.installationId !== requested.installationId
  ) invalidStoredRow('external chat inbound receipt scope')
}

/** Validates an outbound receipt against its physical address. */
function validateOutboundReceiptScope(
  receipt: ExternalChatOutboundReceipt,
  workspaceId: string,
  linkId: string,
  operationId: string,
): void {
  if (
    receipt.workspaceId !== workspaceId ||
    receipt.linkId !== linkId ||
    receipt.operationId !== operationId
  ) invalidStoredRow('external chat outbound receipt scope')
}

/** Validates a durable retry permit against the base-table address used to load it. */
function validateOutboundRetryPermitScope(
  permit: ExternalChatOutboundRetryPermit,
  workspaceId: string,
  provider: ExternalChatProvider,
  installationId: string,
): void {
  if (
    permit.workspaceId !== workspaceId ||
    permit.provider !== provider ||
    permit.installationId !== installationId
  ) invalidStoredRow('external chat outbound retry permit scope')
}

/** Compares exact permit ownership and the monotonic fencing generation. */
function outboundRetryPermitsMatch(
  current: ExternalChatOutboundRetryPermit,
  requested: ExternalChatOutboundRetryPermit,
): boolean {
  return current.workspaceId === requested.workspaceId &&
    current.provider === requested.provider &&
    current.installationId === requested.installationId &&
    current.ownerId === requested.ownerId &&
    current.fenceToken === requested.fenceToken &&
    current.acquiredAt === requested.acquiredAt &&
    current.leaseExpiresAt === requested.leaseExpiresAt &&
    current.updatedAt === requested.updatedAt
}

/** Validates a binding against the requested tenant and optional identity. */
function validateBindingScope(
  record: StoredExternalChatMessageBinding,
  workspaceId: string,
  linkId: string,
  externalMessageId: string | undefined,
  internalCommentId: string | undefined,
): void {
  if (
    record.workspaceId !== workspaceId ||
    record.binding.linkId !== linkId ||
    (externalMessageId !== undefined &&
      record.binding.externalMessageId !== externalMessageId) ||
    (internalCommentId !== undefined &&
      record.binding.internalCommentId !== internalCommentId)
  ) invalidStoredRow('external chat message binding scope')
}

/** Validates a deferred event against its tenant-wide stable provider event ID. */
function validateDeferredEventScope(
  event: DeferredExternalChatEvent,
  workspaceId: string,
  eventId: string,
): void {
  if (
    event.workspaceId !== workspaceId ||
    event.event.eventId !== eventId ||
    event.fingerprint !== createExternalChatFingerprint(event.event)
  ) {
    invalidStoredRow('deferred external chat event scope')
  }
}

/**
 * Identifies a parent lifecycle control event that may be queued without a child snapshot.
 *
 * @param event - Validated deferred inbound event.
 * @returns Whether the event publishes workspace or conversation parent authority.
 */
function isParentLifecycleDeferredEvent(event: DeferredExternalChatEvent['event']): boolean {
  return event.type === 'source.lifecycle-changed' &&
    (event.resourceType === 'workspace' || event.resourceType === 'conversation')
}

/**
 * Requires and scope-normalizes the parent authority carried by thread-scoped deferred work.
 *
 * @param event - Deferred event whose payload is being retained.
 * @param owner - Current active link owner.
 * @returns Exact normalized workspace and conversation authorities.
 */
function requireDeferredParentLifecycleFences(
  event: DeferredExternalChatEvent,
  owner: StoredExternalChatLink,
): ExternalChatParentLifecycleFenceSnapshot {
  if (event.expectedParentLifecycleFences === undefined) {
    invalidInput('A thread-scoped deferred event requires exact parent lifecycle authorities.')
  }
  return normalizeExpectedParentLifecycleFenceSnapshotForLink(
    event.expectedParentLifecycleFences,
    owner,
  )
}

/**
 * Validates a deferred outbound event against its exact tenant, link, and operation scope.
 *
 * @param event - Decoded deferred outbound event.
 * @param workspaceId - Expected tenant identifier.
 * @param linkId - Expected link identifier.
 * @param operationId - Expected outbound operation identifier.
 * @returns Nothing when every durable identity and fingerprint matches.
 */
function validateDeferredOutboundEventScope(
  event: DeferredExternalChatOutboundEvent,
  workspaceId: string,
  linkId: string,
  operationId: string,
): void {
  if (
    event.workspaceId !== workspaceId ||
    event.linkId !== linkId ||
    event.operationId !== operationId ||
    event.event.workspaceId !== workspaceId ||
    event.event.linkId !== linkId ||
    event.fingerprint !== createExternalChatFingerprint(event.event)
  ) {
    invalidStoredRow('deferred outbound external chat event scope')
  }
}

/**
 * Checks whether a link state forbids retaining deferred provider content.
 *
 * @param link - Current provider-neutral link snapshot.
 * @returns Whether deferred message payloads must be rejected.
 */
function linkRejectsDeferredContent(link: ExternalChatWorkItemLink): boolean {
  return link.sourceAvailability === 'permission-lost' ||
    link.sourceAvailability === 'scope-changed' ||
    link.sourceState === 'retained-metadata' ||
    link.sourceState === 'deleted' ||
    link.sourceState === 'retention-expired'
}

/**
 * Checks whether exact parent authorities permanently forbid retaining content payloads.
 *
 * @param snapshot - Current workspace and conversation parent authorities.
 * @param sourceAuthorizationRevision - Authorization generation that resolved the link source.
 * @returns Whether an applicable parent requires payload erasure rather than retry.
 */
function parentLifecycleFencesRejectDeferredContent(
  snapshot: ExternalChatParentLifecycleFenceSnapshot,
  sourceAuthorizationRevision: number,
): boolean {
  return [snapshot.workspace, snapshot.conversation].some((fence) =>
    fence !== undefined &&
    fence.authorizationRevision >= sourceAuthorizationRevision &&
    (
      fence.availability === 'permission-lost' ||
      fence.availability === 'scope-changed' ||
      fence.state === 'retained-metadata' ||
      fence.state === 'deleted' ||
      fence.state === 'retention-expired'
    )
  )
}

/** Resumes an inbound receipt when its deferred retry or lease is eligible. */
function resumeInboundReceipt(
  current: ExternalChatInboundReceipt,
  operationId: string,
  claimedAt: string,
  leaseExpiresAt: string,
): ExternalChatInboundReceipt | undefined {
  if (current.state === 'completed') {
    if (
      current.outcome?.kind !== 'deferred' ||
      current.outcome.retryAt === undefined ||
      current.outcome.retryAt > claimedAt
    ) return undefined
    const { outcome: ignoredOutcome, ...checkpointed } = current
    void ignoredOutcome
    return {
      ...checkpointed,
      operationId,
      state: 'processing',
      attempt: current.attempt + 1,
      leaseExpiresAt,
      updatedAt: claimedAt,
    }
  }
  return {
    ...current,
    operationId,
    attempt: current.attempt + 1,
    leaseExpiresAt,
    updatedAt: claimedAt,
  }
}

/** Resumes an outbound receipt when its deferred retry, retryable failure, or lease is eligible. */
function resumeOutboundReceipt(
  current: ExternalChatOutboundReceipt,
  claimedAt: string,
  leaseExpiresAt: string,
): ExternalChatOutboundReceipt | undefined {
  if (current.state === 'dead-lettering' || current.state === 'dead-lettered') return undefined
  if (current.state === 'completed') {
    const outcome = current.outcome
    const dueDeferred = outcome?.kind === 'deferred' &&
      outcome.retryAt !== undefined &&
      outcome.retryAt <= claimedAt
    const retryableFailure = outcome?.kind === 'failed' && outcome.retryable
    if (!dueDeferred && !retryableFailure) return undefined
    return {
      workspaceId: current.workspaceId,
      linkId: current.linkId,
      operationId: current.operationId,
      fingerprint: current.fingerprint,
      state: 'processing',
      attempt: current.attempt + 1,
      leaseExpiresAt,
      createdAt: current.createdAt,
      updatedAt: claimedAt,
    }
  }
  return {
    ...current,
    attempt: current.attempt + 1,
    leaseExpiresAt,
    updatedAt: claimedAt,
  }
}

/**
 * Checks whether a completed receipt outcome still owns active retry work.
 *
 * @param outcome - Previously committed synchronization result.
 * @returns Whether the result is deferred or retryably failed.
 */
function isRetryableSyncOutcome(outcome: ExternalChatSyncOutcome | undefined): boolean {
  return outcome?.kind === 'deferred' ||
    (outcome?.kind === 'failed' && outcome.retryable)
}

/** Compares complete binding projections through their stable fingerprint. */
function sameStoredBinding(
  left: StoredExternalChatMessageBinding,
  right: StoredExternalChatMessageBinding,
): boolean {
  return createExternalChatFingerprint(left) === createExternalChatFingerprint(right)
}

/** Compares optional outcomes through their canonical normalized fingerprint. */
function syncOutcomesEqual(
  left: ExternalChatSyncOutcome | undefined,
  right: ExternalChatSyncOutcome,
): boolean {
  return left !== undefined &&
    createExternalChatFingerprint(left) === createExternalChatFingerprint(right)
}

/** Validates an inbound outcome against its exact receipt scope. */
function matchesInboundOutcomeScope(
  outcome: ExternalChatSyncOutcome,
  operationId: string,
  eventId: string,
): boolean {
  return outcome.operationId === operationId && outcome.eventId === eventId
}

/** Validates an outbound outcome and rejects provider event identity. */
function matchesOutboundOutcomeScope(
  outcome: ExternalChatSyncOutcome,
  operationId: string,
): boolean {
  return outcome.operationId === operationId && outcome.eventId === undefined
}

/** Reads one exact object while rejecting unknown properties. */
function readExactRecord(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidStoredRow(label)
  }
  const record = Object.fromEntries(Object.entries(value))
  const allowed = new Set(allowedKeys)
  if (Object.keys(record).some((key) => !allowed.has(key))) invalidStoredRow(label)
  return record
}

/** Reads one supported external chat provider. */
function requireProvider(value: unknown): 'slack' | 'microsoft-teams' {
  if (value === 'slack' || value === 'microsoft-teams') return value
  invalidInput('The external chat provider is invalid.')
}

/** Reads one supported source availability at an application input boundary. */
function requireSourceAvailability(value: unknown): ExternalChatSourceAvailability {
  if (
    value === 'available' ||
    value === 'temporarily-unavailable' ||
    value === 'needs-reauth' ||
    value === 'installation-disconnected' ||
    value === 'scope-changed' ||
    value === 'permission-lost'
  ) return value
  invalidInput('The external chat source availability is invalid.')
}

/** Reads one non-thread parent source state at an application input boundary. */
function requireParentSourceState(value: unknown): Exclude<ExternalChatSourceState, 'completed'> {
  if (isExternalChatParentLifecycleState(value)) return value
  invalidInput('The external chat parent source state is invalid.')
}

/** Reads one supported source availability from untrusted durable state. */
function readStoredSourceAvailability(value: unknown): ExternalChatSourceAvailability {
  if (
    value === 'available' ||
    value === 'temporarily-unavailable' ||
    value === 'needs-reauth' ||
    value === 'installation-disconnected' ||
    value === 'scope-changed' ||
    value === 'permission-lost'
  ) return value
  invalidStoredRow('external chat source availability')
}

/** Reads one non-thread parent source state from untrusted durable state. */
function readStoredParentSourceState(
  value: unknown,
): Exclude<ExternalChatSourceState, 'completed'> {
  if (isExternalChatParentLifecycleState(value)) return value
  invalidStoredRow('external chat parent source state')
}

/** Reads one supported terminal outbound retry exhaustion reason. */
function requireOutboundDeadLetterReason(
  value: unknown,
): ExternalChatOutboundDeadLetterReason {
  if (value === 'max-attempts' || value === 'max-age') return value
  invalidInput('The external chat outbound dead-letter reason is invalid.')
}

/** Reads a bounded nonempty canonical identifier. */
function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value, 'utf8') > 64 * 1024
  ) invalidInput(`The ${label} is invalid.`)
  return value
}

/** Reads a bounded nonempty identifier from untrusted durable state. */
function readStoredIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value, 'utf8') > 64 * 1024
  ) invalidStoredRow(label)
  return value
}

/** Reads one lowercase SHA-256 digest. */
function requireDigest(value: unknown, label: string): string {
  const digest = requireIdentifier(value, label)
  if (!/^[a-f0-9]{64}$/u.test(digest)) invalidInput(`The ${label} is invalid.`)
  return digest
}

/** Reads one lowercase SHA-256 digest from untrusted durable state. */
function readStoredDigest(value: unknown, label: string): string {
  const digest = readStoredIdentifier(value, label)
  if (!/^[a-f0-9]{64}$/u.test(digest)) invalidStoredRow(label)
  return digest
}

/** Reads a positive safe integer. */
function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    invalidInput(`The ${label} is invalid.`)
  }
  return value
}

/**
 * Reads a provider authorization generation that cannot roll a durable link backward.
 *
 * @param value - Candidate verified authorization generation.
 * @param current - Generation already retained by the link.
 * @returns Validated nondecreasing authorization generation.
 */
function requireNondecreasingSourceAuthorizationRevision(
  value: unknown,
  current: number,
): number {
  const revision = requirePositiveInteger(value, 'source authorization revision')
  if (revision < current) {
    invalidInput('The source authorization revision cannot decrease.')
  }
  return revision
}

/** Reads a nonnegative safe integer. */
function requireNonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalidInput(`The ${label} is invalid.`)
  }
  return value
}

/** Reads a positive safe integer from untrusted durable state. */
function readStoredPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    invalidStoredRow(label)
  }
  return value
}

/** Reads a nonnegative safe integer from untrusted durable state. */
function readStoredNonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalidStoredRow(label)
  }
  return value
}

/** Reads a bounded list limit, including zero. */
function requireListLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1_000) {
    invalidInput('The deferred event list limit must be between zero and one thousand.')
  }
  return value
}

/** Reads one parseable ISO 8601 timestamp. */
function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireIdentifier(value, label)
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
    invalidInput(`The ${label} is invalid.`)
  }
  return timestamp
}

/** Reads a lease timestamp that is strictly after its claim timestamp. */
function requireFutureTimestamp(
  value: unknown,
  claimedAt: string,
  label: string,
): string {
  const timestamp = requireTimestamp(value, label)
  if (Date.parse(timestamp) <= Date.parse(claimedAt)) {
    invalidInput(`The ${label} must be after the claim timestamp.`)
  }
  return timestamp
}

/** Reads a known persistence row discriminator. */
function requireEntryType(value: unknown): ExternalChatPersistenceEntryType {
  const entryTypes: ExternalChatPersistenceEntryType[] = [
    'external-chat-link',
    'external-chat-source-claim',
    'external-chat-link-receipt',
    'external-chat-work-item-link-manifest',
    'external-chat-parent-lifecycle',
    'external-chat-inbound-receipt',
    'external-chat-outbound-receipt',
    'external-chat-outbound-retry-permit',
    'external-chat-thread-lifecycle',
    'external-chat-binding-external',
    'external-chat-binding-internal',
    'external-chat-sync-cursor',
    'external-chat-deferred-event',
    'external-chat-deferred-outbound-event',
    'external-chat-canonical-redirect',
  ]
  if (typeof value === 'string') {
    for (const entryType of entryTypes) {
      if (value === entryType) return entryType
    }
  }
  invalidStoredRow('external chat persistence entry type')
}

/** Creates a stable hashed key component from a canonical internal identifier. */
function digestKeyComponent(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Creates the physical link sort key. */
function externalChatLinkRecordKey(linkId: string): string {
  return `${externalChatLinkRecordPrefix()}${digestKeyComponent(linkId)}`
}

/**
 * Creates the base-table prefix containing every external chat link in one Workspace partition.
 *
 * @returns Stable link-row record prefix.
 */
function externalChatLinkRecordPrefix(): string {
  return 'CHAT_LINK#'
}

/**
 * Creates one server-derived Work Item membership-manifest sort key.
 *
 * @param teamId - Owning Team identifier.
 * @param workItemId - Owning Work Item identifier.
 * @returns Stable key without raw internal identifiers.
 */
function externalChatWorkItemLinkManifestRecordKey(
  teamId: string,
  workItemId: string,
): string {
  return `CHAT_WORK_ITEM_LINKS#${digestKeyComponent(teamId)}#${digestKeyComponent(workItemId)}`
}

/**
 * Creates one durable provider-parent lifecycle fence sort key.
 *
 * @param provider - Provider that owns the parent resource.
 * @param installationId - Connector installation identifier.
 * @param externalWorkspaceId - Provider-scoped workspace identifier.
 * @param conversationExternalId - Optional conversation restriction.
 * @returns Server-derived physical fence key with no raw provider identifiers.
 */
function externalChatParentLifecycleRecordKey(
  provider: ExternalChatProvider,
  installationId: string,
  externalWorkspaceId: string,
  conversationExternalId: string | undefined,
): string {
  const parent = conversationExternalId === undefined
    ? 'WORKSPACE'
    : `CONVERSATION#${digestKeyComponent(conversationExternalId)}`
  return `CHAT_PARENT_STATE#${provider}#${digestKeyComponent(installationId)}#${digestKeyComponent(externalWorkspaceId)}#${parent}`
}

/**
 * Creates both parent lifecycle fence addresses that govern one candidate link.
 *
 * @param record - Candidate active link.
 * @returns Workspace and conversation parent fence keys in deterministic order.
 */
function externalChatParentLifecycleRecordKeys(
  record: StoredExternalChatLink,
): string[] {
  return [
    externalChatParentLifecycleRecordKey(
      record.link.provider,
      record.link.installationId,
      record.link.source.externalWorkspaceId,
      undefined,
    ),
    externalChatParentLifecycleRecordKey(
      record.link.provider,
      record.link.installationId,
      record.link.source.externalWorkspaceId,
      record.link.source.conversationExternalId,
    ),
  ]
}

/**
 * Creates atomic parent fence conditions for a new link transaction.
 *
 * Each condition allows an absent fence, an older provider generation, or an explicitly
 * nonrestrictive fence at the same generation. A concurrent restrictive fence therefore wins
 * before fan-out, while a link resolved from a newer reauthorization generation may proceed.
 *
 * @param tableName - External chat table name.
 * @param record - Candidate active link.
 * @param authorizationRevision - Provider generation used to resolve the source.
 * @returns Workspace and conversation transaction condition actions.
 */
function createParentLifecycleLinkConditions(
  tableName: string,
  record: StoredExternalChatLink,
  authorizationRevision: number,
): ExternalChatTransactWriteItem[] {
  return externalChatParentLifecycleRecordKeys(record).map((recordKey) => ({
    ConditionCheck: {
      TableName: tableName,
      Key: { workspaceId: record.workspaceId, recordKey },
      ConditionExpression:
        'attribute_not_exists(#workspaceId) OR ' +
        '(#entryType = :entryType AND ' +
        '(#value.#authorizationRevision < :authorizationRevision OR ' +
        '(#value.#authorizationRevision = :authorizationRevision AND ' +
        '#value.#restrictive = :notRestrictive)))',
      ExpressionAttributeNames: {
        '#workspaceId': 'workspaceId',
        '#entryType': 'entryType',
        '#value': 'value',
        '#authorizationRevision': 'authorizationRevision',
        '#restrictive': 'restrictive',
      },
      ExpressionAttributeValues: {
        ':entryType': 'external-chat-parent-lifecycle',
        ':authorizationRevision': authorizationRevision,
        ':notRestrictive': false,
      },
    },
  }))
}

/**
 * Creates exact workspace and conversation parent snapshot checks for one link update.
 *
 * Present fences are matched field-for-field, while absent fences require their physical rows
 * to remain absent. A parent publication racing after the strong read therefore aborts the link
 * projection in the same transaction.
 *
 * @param tableName - External chat table name.
 * @param record - Link whose immutable provider scope determines both parent addresses.
 * @param expected - Exact present-or-absent parent snapshot.
 * @returns Two transaction conditions in workspace then conversation order.
 */
function createExpectedParentLifecycleFenceSnapshotConditions(
  tableName: string,
  record: StoredExternalChatLink,
  expected: ExternalChatParentLifecycleFenceSnapshot,
): ExternalChatTransactWriteItem[] {
  const recordKeys = externalChatParentLifecycleRecordKeys(record)
  const workspaceRecordKey = recordKeys[0]
  const conversationRecordKey = recordKeys[1]
  if (workspaceRecordKey === undefined || conversationRecordKey === undefined) {
    invalidInput('The external chat link parent lifecycle addresses are incomplete.')
  }
  return [
    expected.workspace === undefined
      ? createAbsentParentLifecycleFenceCondition(
        tableName,
        record.workspaceId,
        workspaceRecordKey,
      )
      : createExpectedParentLifecycleFenceCondition(tableName, expected.workspace),
    expected.conversation === undefined
      ? createAbsentParentLifecycleFenceCondition(
        tableName,
        record.workspaceId,
        conversationRecordKey,
      )
      : createExpectedParentLifecycleFenceCondition(tableName, expected.conversation),
  ]
}

/**
 * Creates a condition requiring one governing parent lifecycle row to remain absent.
 *
 * @param tableName - External chat table name.
 * @param workspaceId - Canonical tenant partition identifier.
 * @param recordKey - Server-derived exact parent lifecycle record key.
 * @returns Transaction condition that fails when a concurrent fence is published.
 */
function createAbsentParentLifecycleFenceCondition(
  tableName: string,
  workspaceId: string,
  recordKey: string,
): ExternalChatTransactWriteItem {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { workspaceId, recordKey },
      ConditionExpression: 'attribute_not_exists(#workspaceId)',
      ExpressionAttributeNames: { '#workspaceId': 'workspaceId' },
    },
  }
}

/**
 * Creates the exact parent-authority condition for one atomic fan-out child projection.
 *
 * @param tableName - External chat table name.
 * @param expected - Parent fence that authorized the child mutation.
 * @returns Transaction condition that fails after any newer parent event wins.
 */
function createExpectedParentLifecycleFenceCondition(
  tableName: string,
  expected: ExternalChatParentLifecycleFence,
): ExternalChatTransactWriteItem {
  const conversationCondition = expected.conversationExternalId === undefined
    ? 'attribute_not_exists(#value.#conversationExternalId)'
    : '#value.#conversationExternalId = :conversationExternalId'
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: {
        workspaceId: expected.workspaceId,
        recordKey: externalChatParentLifecycleRecordKey(
          expected.provider,
          expected.installationId,
          expected.externalWorkspaceId,
          expected.conversationExternalId,
        ),
      },
      ConditionExpression:
        '#entryType = :entryType AND #value.#workspaceId = :workspaceId AND ' +
        '#value.#provider = :provider AND #value.#installationId = :installationId AND ' +
        '#value.#externalWorkspaceId = :externalWorkspaceId AND ' +
        `${conversationCondition} AND ` +
        '#value.#authorizationRevision = :authorizationRevision AND ' +
        '#value.#availability = :availability AND #value.#state = :state AND ' +
        '#value.#restrictive = :restrictive AND #value.#eventId = :eventId AND ' +
        '#value.#operationId = :operationId AND #value.#occurredAt = :occurredAt',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#value': 'value',
        '#workspaceId': 'workspaceId',
        '#provider': 'provider',
        '#installationId': 'installationId',
        '#externalWorkspaceId': 'externalWorkspaceId',
        '#conversationExternalId': 'conversationExternalId',
        '#authorizationRevision': 'authorizationRevision',
        '#availability': 'availability',
        '#state': 'state',
        '#restrictive': 'restrictive',
        '#eventId': 'eventId',
        '#operationId': 'operationId',
        '#occurredAt': 'occurredAt',
      },
      ExpressionAttributeValues: {
        ':entryType': 'external-chat-parent-lifecycle',
        ':workspaceId': expected.workspaceId,
        ':provider': expected.provider,
        ':installationId': expected.installationId,
        ':externalWorkspaceId': expected.externalWorkspaceId,
        ...(expected.conversationExternalId === undefined
          ? {}
          : { ':conversationExternalId': expected.conversationExternalId }),
        ':authorizationRevision': expected.authorizationRevision,
        ':availability': expected.availability,
        ':state': expected.state,
        ':restrictive': expected.restrictive,
        ':eventId': expected.eventId,
        ':operationId': expected.operationId,
        ':occurredAt': expected.occurredAt,
      },
    },
  }
}

/**
 * Binds a parent fan-out cursor to the exact provider resource scope being traversed.
 *
 * @param workspaceId - Canonical tenant identifier.
 * @param provider - Provider that owns the links.
 * @param installationId - Connector installation that owns the consent generation.
 * @param externalWorkspaceId - Provider-scoped workspace identifier.
 * @param conversationExternalId - Optional provider conversation restriction.
 * @param maximumSourceAuthorizationRevision - Latest eligible source-resolution generation.
 * @returns Stable secret-free cursor scope digest.
 */
function externalChatParentLinkCursorScope(
  workspaceId: string,
  provider: ExternalChatProvider,
  installationId: string,
  externalWorkspaceId: string,
  conversationExternalId: string | undefined,
  maximumSourceAuthorizationRevision: number,
): string {
  return createHash('sha256').update(JSON.stringify([
    workspaceId,
    provider,
    installationId,
    externalWorkspaceId,
    conversationExternalId ?? null,
    maximumSourceAuthorizationRevision,
  ])).digest('hex')
}

/**
 * Creates the sparse provider workspace partition for active parent lifecycle fan-out.
 *
 * @param workspaceId - Canonical tenant identifier.
 * @param provider - Provider that owns the links.
 * @param installationId - Connector installation that owns the consent generation.
 * @param externalWorkspaceId - Provider-scoped workspace identifier.
 * @returns Sparse parent lookup partition key.
 */
function externalChatParentLinkLookupKey(
  workspaceId: string,
  provider: ExternalChatProvider,
  installationId: string,
  externalWorkspaceId: string,
): string {
  return `CHAT_PARENT_LINK#${digestKeyComponent(workspaceId)}#${provider}#${digestKeyComponent(installationId)}#${digestKeyComponent(externalWorkspaceId)}`
}

/**
 * Creates the stable conversation/link order within one provider workspace partition.
 *
 * @param link - Active provider-neutral link.
 * @returns Sparse lookup sort key.
 */
function externalChatParentLinkLookupSortKey(link: ExternalChatWorkItemLink): string {
  return `${digestKeyComponent(link.source.conversationExternalId)}\0${digestKeyComponent(link.id)}`
}

/** Creates the physical source-claim sort key. */
function externalChatSourceClaimRecordKey(sourceDigest: string): string {
  return `CHAT_SOURCE#${sourceDigest}`
}

/** Creates the physical link idempotency receipt sort key. */
function externalChatLinkReceiptRecordKey(idempotencyKeyHash: string): string {
  return `CHAT_LINK_RECEIPT#${idempotencyKeyHash}`
}

/** Creates the provider-installation-scoped inbound event receipt sort key. */
function externalChatInboundReceiptRecordKey(
  provider: 'slack' | 'microsoft-teams',
  installationId: string,
  eventId: string,
): string {
  return `CHAT_INBOUND#${provider}#${digestKeyComponent(installationId)}#${digestKeyComponent(eventId)}`
}

/** Creates the link-scoped outbound operation receipt sort key. */
function externalChatOutboundReceiptRecordKey(linkId: string, operationId: string): string {
  return `CHAT_OUTBOUND#${digestKeyComponent(linkId)}#${digestKeyComponent(operationId)}`
}

/** Creates the installation-scoped outbound retry permit sort key. */
function externalChatOutboundRetryPermitRecordKey(
  provider: ExternalChatProvider,
  installationId: string,
): string {
  return `CHAT_OUTBOUND_RETRY_PERMIT#${provider}#${digestKeyComponent(installationId)}`
}

/** Creates the provider- and link-scoped thread lifecycle sort key. */
function externalChatThreadLifecycleRecordKey(
  linkId: string,
  provider: ExternalChatProvider,
): string {
  return `CHAT_THREAD_LIFECYCLE#${digestKeyComponent(linkId)}#${provider}`
}

/** Creates the external binding row prefix for one link. */
function externalChatBindingExternalPrefix(linkId: string): string {
  return `CHAT_BINDING_EXT#${digestKeyComponent(linkId)}#`
}

/** Creates the physical external-message binding sort key. */
function externalChatBindingExternalRecordKey(
  linkId: string,
  externalMessageId: string,
): string {
  return `${externalChatBindingExternalPrefix(linkId)}${digestKeyComponent(externalMessageId)}`
}

/** Creates the physical internal-comment binding sort key. */
function externalChatBindingInternalRecordKey(
  linkId: string,
  internalCommentId: string,
): string {
  return `CHAT_BINDING_INT#${digestKeyComponent(linkId)}#${digestKeyComponent(internalCommentId)}`
}

/** Creates the physical synchronization cursor sort key. */
function externalChatSyncCursorRecordKey(linkId: string): string {
  return `CHAT_CURSOR#${digestKeyComponent(linkId)}`
}

/** Creates the provider-installation-scoped deferred event sort key. */
function externalChatDeferredEventRecordKey(
  provider: 'slack' | 'microsoft-teams',
  installationId: string,
  eventId: string,
): string {
  return `CHAT_DEFERRED#${provider}#${digestKeyComponent(installationId)}#${digestKeyComponent(eventId)}`
}

/** Creates the ordered base-table prefix for one link's inbound retry FIFO. */
function externalChatDeferredEventFifoRecordKeyPrefix(linkId: string): string {
  return `CHAT_DEFERRED_FIFO#${digestKeyComponent(linkId)}#`
}

/** Creates one occurrence-ordered physical row key for an inbound retry. */
function externalChatDeferredEventFifoRecordKey(event: DeferredExternalChatEvent): string {
  return `${externalChatDeferredEventFifoRecordKeyPrefix(event.linkId)}${event.event.occurredAt}#${digestKeyComponent(event.event.eventId)}`
}

/**
 * Creates the exact link- and operation-scoped deferred outbound event sort key.
 *
 * @param linkId - Link that owns the queue entry.
 * @param operationId - Stable outbound operation identifier.
 * @returns Server-derived physical row key.
 */
function externalChatDeferredOutboundEventRecordKey(
  linkId: string,
  operationId: string,
): string {
  return `CHAT_DEFERRED_OUTBOUND#${digestKeyComponent(linkId)}#${digestKeyComponent(operationId)}`
}

/**
 * Creates the strong base-table prefix for every deferred outbound operation owned by one link.
 *
 * @param linkId - Link that owns the FIFO queue.
 * @returns Server-derived base-table record prefix.
 */
function externalChatDeferredOutboundEventFifoRecordKeyPrefix(linkId: string): string {
  return `CHAT_DEFERRED_OUTBOUND_FIFO#${digestKeyComponent(linkId)}#`
}

/**
 * Creates one occurrence-ordered physical row key for an outbound retry.
 *
 * @param event - Validated outbound retry queue entry.
 * @returns Server-derived occurrence-ordered FIFO record key.
 */
function externalChatDeferredOutboundEventFifoRecordKey(
  event: DeferredExternalChatOutboundEvent,
): string {
  return `${externalChatDeferredOutboundEventFifoRecordKeyPrefix(event.linkId)}${event.event.occurredAt}#${digestKeyComponent(event.operationId)}`
}

/**
 * Creates the base-table prefix for every moved link from one duplicate Work Item.
 *
 * @param teamId - Team that owned the duplicate Work Item.
 * @param workItemId - Former duplicate Work Item identifier.
 * @returns Server-derived redirect record prefix.
 */
function externalChatRedirectRecordPrefix(teamId: string, workItemId: string): string {
  return `CHAT_REDIRECT#${digestKeyComponent(teamId)}#${digestKeyComponent(workItemId)}#`
}

/**
 * Creates one link-scoped duplicate Work Item redirect sort key.
 *
 * @param teamId - Team that owned the duplicate Work Item.
 * @param workItemId - Former duplicate Work Item identifier.
 * @param linkId - Moved external chat link identifier.
 * @returns Server-derived physical redirect key.
 */
function externalChatRedirectRecordKey(
  teamId: string,
  workItemId: string,
  linkId: string,
): string {
  return `${externalChatRedirectRecordPrefix(teamId, workItemId)}${digestKeyComponent(linkId)}`
}

/**
 * Compares every immutable field of two decoded canonical redirects.
 *
 * @param left - Existing durable redirect.
 * @param right - Redirect requested by the merge transaction.
 * @returns Whether both redirects describe the exact same moved-link lineage.
 */
function sameExternalChatRedirect(
  left: ExternalChatCanonicalRedirect,
  right: ExternalChatCanonicalRedirect,
): boolean {
  return left.linkId === right.linkId &&
    left.provider === right.provider &&
    left.threadExternalId === right.threadExternalId &&
    left.fromTeamId === right.fromTeamId &&
    left.fromWorkItemId === right.fromWorkItemId &&
    left.canonicalTeamId === right.canonicalTeamId &&
    left.canonicalWorkItemId === right.canonicalWorkItemId &&
    left.createdAt === right.createdAt
}

/** Compares normalized strings by UTF-16 code units without host locale variance. */
function compareOrdinal(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/** Detects conditional failures from single or transactional DynamoDB writes. */
function isConditionalWriteFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'ConditionalCheckFailedException') return true
  if (error.name !== 'TransactionCanceledException') return false
  const record = Object.fromEntries(Object.entries(error))
  if (!Array.isArray(record.CancellationReasons)) return false
  let foundConditionalFailure = false
  for (const reason of record.CancellationReasons) {
    if (typeof reason !== 'object' || reason === null || Array.isArray(reason)) return false
    const code = Object.fromEntries(Object.entries(reason)).Code
    if (code === 'ConditionalCheckFailed') {
      foundConditionalFailure = true
      continue
    }
    if (code !== undefined && code !== 'None') return false
  }
  return foundConditionalFailure
}

/** Creates a retryable conflict after bounded conditional retries are exhausted. */
function concurrentPersistenceFailure(entity: string): ExternalChatError {
  return new ExternalChatError(
    'ExternalChatPersistenceFailed',
    `The external chat ${entity} changed concurrently.`,
    true,
  )
}

/** Throws a stable validation error for caller-owned invalid data. */
function invalidInput(message: string): never {
  throw new ExternalChatError('ExternalChatValidationFailed', message)
}

/** Throws a stable fail-closed error for malformed or cross-scope durable data. */
function invalidStoredRow(label: string): never {
  throw new ExternalChatError(
    'ExternalChatPersistenceFailed',
    `Stored ${label} is invalid.`,
  )
}
