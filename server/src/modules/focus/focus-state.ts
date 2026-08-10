import {
  CreateTableCommand,
  DescribeTableCommand,
  type DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  FOCUS_SCHEMA_VERSION,
  type FocusPolicy,
  type FocusPolicyOverrides,
  type FocusPolicyTarget,
  type UpdateFocusPolicyInput,
} from '@mukuroji/contracts'
import {
  createDynamoDbClient,
  createDynamoDbDocumentClient,
  shouldBootstrapLocalDynamoDb,
} from '../../infrastructure/aws/dynamodb-client'

/** Durable recipient-specific snooze state for one Focus Work Item. */
export type FocusSnoozeRecord = {
  /** Team that owns the snoozed Work Item. */
  teamId: string
  /** Team-local Work Item identifier. */
  workItemId: string
  /** Optimistic concurrency version retained across unsnooze operations. */
  version: number
  /** Fingerprint of the exact active causes hidden by this snooze. */
  causeFingerprint: string
  /** ISO 8601 wake time, omitted by an unsnooze tombstone. */
  snoozedUntil?: string
  /** ISO 8601 timestamp of the latest state change. */
  updatedAt: string
  /** Opaque identity of the mutation that produced this exact state. */
  mutationIdentity?: string
}

/** Policy and snooze rows required to project one recipient's Focus queue. */
export type FocusStateSnapshot = {
  /** Current user's personal policy override when one has been stored. */
  userPolicy?: FocusPolicy
  /** Opaque identity of the mutation that produced the personal policy. */
  userPolicyMutationIdentity?: string
  /** Accessible Team policy overrides in stable Team order. */
  teamPolicies: FocusPolicy[]
  /** Opaque mutation identities keyed by accessible Team identifier. */
  teamPolicyMutationIdentities: Readonly<Record<string, string>>
  /** Recipient-specific snooze records, including version-preserving tombstones. */
  snoozes: FocusSnoozeRecord[]
}

/** Input for loading policy and snooze state used by one Focus projection. */
export type GetFocusStateInput = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Authenticated Workspace member key. */
  memberKey: string
  /** Team identifiers whose policy rows may contribute to the response. */
  teamIds: readonly string[]
}

/** Input for a version-checked user or Team policy replacement. */
export type SaveFocusPolicyInput = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Authenticated member whose personal target is implied. */
  memberKey: string
  /** Policy replacement received at the authorized application boundary. */
  update: UpdateFocusPolicyInput
  /** Stable mutation clock. */
  now: Date
  /** Opaque identity used to recover a committed mutation after response loss. */
  mutationIdentity?: string
}

/** Input for a version-checked Focus snooze replacement. */
export type SaveFocusSnoozeInput = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Authenticated Workspace member key. */
  memberKey: string
  /** Team that owns the Focus Work Item. */
  teamId: string
  /** Team-local Work Item identifier. */
  workItemId: string
  /** Current snooze-record version observed in the Focus item. */
  expectedVersion: number
  /** Fingerprint of the signal causes currently being changed. */
  causeFingerprint: string
  /** ISO 8601 wake time, or null to preserve an unsnooze tombstone. */
  snoozedUntil: string | null
  /** Stable mutation clock. */
  now: Date
  /** Opaque identity used to recover a committed mutation after response loss. */
  mutationIdentity?: string
}

/** Durable port owned by the Focus module. */
export interface FocusStateClient {
  /**
   * Loads personal/Team policies and recipient snoozes.
   *
   * @param input - Authorized Workspace, member, and Team scope.
   * @returns Current durable Focus state.
   */
  getState(input: GetFocusStateInput): Promise<FocusStateSnapshot>
  /**
   * Replaces one policy layer with optimistic concurrency.
   *
   * @param input - Authorized policy replacement.
   * @returns Stored policy after the update.
   */
  savePolicy(input: SaveFocusPolicyInput): Promise<FocusPolicy>
  /**
   * Replaces one recipient-specific snooze with optimistic concurrency.
   *
   * @param input - Authorized snooze replacement.
   * @returns Stored snooze or unsnooze tombstone.
   */
  saveSnooze(input: SaveFocusSnoozeInput): Promise<FocusSnoozeRecord>
}

/** Stable Focus persistence error exposed to the API boundary. */
export class FocusStateError extends Error {
  /** HTTP status associated with this failure. */
  readonly status: number
  /** Stable machine-readable error code. */
  readonly code: string

  /**
   * Creates one Focus state error.
   *
   * @param status - HTTP response status.
   * @param code - Stable machine-readable code.
   * @param message - Safe failure description.
   */
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'FocusStateError'
    this.status = status
    this.code = code
  }
}

const userPolicyRecordKey = 'POLICY'
const snoozeRecordPrefix = 'SNOOZE#'
const stateRetentionSeconds = 90 * 24 * 60 * 60
const snoozeMaximumMilliseconds = 365 * 24 * 60 * 60 * 1_000
const snoozeReadPageLimit = 250
const snoozeReadMaximumPages = 4
const snoozeReadMaximumRows = snoozeReadPageLimit * snoozeReadMaximumPages
const mutationIdentityMaximumLength = 256

/** Validated policy payload and mutation identity read from one persistence envelope. */
type StoredFocusPolicy = {
  /** Public policy payload. */
  policy: FocusPolicy
  /** Opaque identity of the mutation that produced the payload. */
  mutationIdentity?: string
}

/** In-memory Focus state adapter used by tests and isolated app composition. */
export class InMemoryFocusStateClient implements FocusStateClient {
  /** Stored policy rows keyed by their physical identity. */
  private readonly policies = new Map<string, FocusPolicy>()
  /** Latest policy mutation identities keyed by their physical identity. */
  private readonly policyMutationIdentities = new Map<string, string>()
  /** Stored snooze rows keyed by their physical identity. */
  private readonly snoozes = new Map<string, FocusSnoozeRecord>()

  /** Loads one recipient's current Focus state. */
  async getState(input: GetFocusStateInput): Promise<FocusStateSnapshot> {
    const workspaceId = requireText(input.workspaceId, 'Focus Workspace ID')
    const memberKey = normalizeMemberKey(input.memberKey)
    const userPolicyKey = createPolicyStorageKey(
      createUserScopeKey(workspaceId, memberKey),
    )
    const userPolicy = this.policies.get(userPolicyKey)
    const teamPolicyMutationIdentities: Record<string, string> = {}
    const teamPolicies = uniqueSorted(input.teamIds).flatMap((teamId) => {
      const policyKey = createPolicyStorageKey(
        createTeamScopeKey(workspaceId, teamId),
      )
      const policy = this.policies.get(policyKey)
      const mutationIdentity = this.policyMutationIdentities.get(policyKey)
      if (policy && mutationIdentity) {
        teamPolicyMutationIdentities[teamId] = mutationIdentity
      }
      return policy ? [cloneFocusPolicy(policy)] : []
    })
    const userScope = createUserScopeKey(workspaceId, memberKey)
    const snoozes = [...this.snoozes.entries()]
      .filter(([key]) => key.startsWith(`${userScope}\u0000${snoozeRecordPrefix}`))
      .map(([, record]) => cloneSnoozeRecord(record))
      .sort(compareSnoozeRecords)
    if (snoozes.length > snoozeReadMaximumRows) {
      throw createSnoozeReadLimitError()
    }

    const userPolicyMutationIdentity = this.policyMutationIdentities.get(userPolicyKey)
    return {
      ...(userPolicy ? { userPolicy: cloneFocusPolicy(userPolicy) } : {}),
      ...(userPolicyMutationIdentity === undefined
        ? {}
        : { userPolicyMutationIdentity }),
      teamPolicies,
      teamPolicyMutationIdentities,
      snoozes,
    }
  }

  /** Stores one policy replacement with optimistic concurrency. */
  async savePolicy(input: SaveFocusPolicyInput): Promise<FocusPolicy> {
    const policy = createFocusPolicyMutationPreview(input)
    const mutationIdentity = normalizeMutationIdentity(input.mutationIdentity)
    const key = createPolicyStorageKey(createPolicyScopeKey(
      input.workspaceId,
      input.memberKey,
      input.update.target,
    ))
    const current = this.policies.get(key)
    if ((current?.version ?? 0) !== input.update.expectedVersion) {
      throw createConflictError('Focus policy changed after it was read.')
    }
    this.policies.set(key, cloneFocusPolicy(policy))
    if (mutationIdentity === undefined) {
      this.policyMutationIdentities.delete(key)
    } else {
      this.policyMutationIdentities.set(key, mutationIdentity)
    }
    return cloneFocusPolicy(policy)
  }

  /** Stores one snooze replacement with optimistic concurrency. */
  async saveSnooze(input: SaveFocusSnoozeInput): Promise<FocusSnoozeRecord> {
    const record = createStoredSnooze(input)
    const workspaceId = requireText(input.workspaceId, 'Focus Workspace ID')
    const memberKey = normalizeMemberKey(input.memberKey)
    const teamId = requireText(input.teamId, 'Focus Team ID')
    const workItemId = requireText(input.workItemId, 'Focus Work Item ID')
    const key = createSnoozeStorageKey(
      createUserScopeKey(workspaceId, memberKey),
      teamId,
      workItemId,
    )
    const current = this.snoozes.get(key)
    if ((current?.version ?? 0) !== requireVersion(input.expectedVersion)) {
      throw createConflictError('Focus snooze changed after it was read.')
    }
    this.snoozes.set(key, cloneSnoozeRecord(record))
    return cloneSnoozeRecord(record)
  }
}

/** DynamoDB-backed Focus policy and snooze adapter. */
export class DynamoDbFocusStateClient implements FocusStateClient {
  /** Physical Focus table name. */
  private readonly tableName: string
  /** DynamoDB document transport. */
  private readonly documentClient: DynamoDBDocumentClient
  /** Low-level transport used only for explicit local table bootstrap. */
  private readonly dynamoDbClient: DynamoDBClient
  /** Whether a missing local table may be created. */
  private readonly bootstrapLocalTable: boolean
  /** Process-local table initialization promise. */
  private tableReady?: Promise<void>

  /**
   * Creates a Focus state adapter.
   *
   * @param tableName - Physical Focus table name.
   * @param documentClient - Optional injected document transport.
   * @param dynamoDbClient - Optional injected low-level transport.
   * @param bootstrapLocalTable - Whether a missing local table may be created.
   */
  constructor(
    tableName = getConfiguredFocusTableName(),
    documentClient?: DynamoDBDocumentClient,
    dynamoDbClient = createDynamoDbClient(),
    bootstrapLocalTable = documentClient === undefined && shouldBootstrapLocalDynamoDb(),
  ) {
    this.tableName = requireText(tableName, 'Focus table name')
    this.dynamoDbClient = dynamoDbClient
    this.documentClient = documentClient ?? createDynamoDbDocumentClient(dynamoDbClient)
    this.bootstrapLocalTable = bootstrapLocalTable
  }

  /** Loads one recipient's current Focus state. */
  async getState(input: GetFocusStateInput): Promise<FocusStateSnapshot> {
    await this.ensureTable()
    const workspaceId = requireText(input.workspaceId, 'Focus Workspace ID')
    const memberKey = normalizeMemberKey(input.memberKey)
    const userScope = createUserScopeKey(workspaceId, memberKey)
    const userPolicyPromise = this.readPolicy(
      workspaceId,
      memberKey,
      { type: 'user' },
    )
    const teamPoliciesPromise = Promise.all(
      uniqueSorted(input.teamIds).map((teamId) =>
        this.readPolicy(
          workspaceId,
          memberKey,
          { type: 'team', teamId },
        ),
      ),
    )
    const snoozesPromise = this.readSnoozes(userScope)
    const [userPolicy, candidateTeamPolicies, snoozes] = await Promise.all([
      userPolicyPromise,
      teamPoliciesPromise,
      snoozesPromise,
    ])
    const teamPolicies: FocusPolicy[] = []
    const teamPolicyMutationIdentities: Record<string, string> = {}
    for (const stored of candidateTeamPolicies) {
      if (stored === undefined) continue
      teamPolicies.push(stored.policy)
      if (
        stored.mutationIdentity !== undefined &&
        stored.policy.target.type === 'team'
      ) {
        teamPolicyMutationIdentities[stored.policy.target.teamId] = stored.mutationIdentity
      }
    }

    return {
      ...(userPolicy ? { userPolicy: userPolicy.policy } : {}),
      ...(userPolicy?.mutationIdentity === undefined
        ? {}
        : { userPolicyMutationIdentity: userPolicy.mutationIdentity }),
      teamPolicies,
      teamPolicyMutationIdentities,
      snoozes,
    }
  }

  /** Stores one policy replacement with optimistic concurrency. */
  async savePolicy(input: SaveFocusPolicyInput): Promise<FocusPolicy> {
    await this.ensureTable()
    const scopeKey = createPolicyScopeKey(
      input.workspaceId,
      input.memberKey,
      input.update.target,
    )
    const policy = createFocusPolicyMutationPreview(input)
    const mutationIdentity = normalizeMutationIdentity(input.mutationIdentity)
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          scopeKey,
          recordKey: userPolicyRecordKey,
          entryType: 'policy',
          version: policy.version,
          policy,
          updatedAt: policy.updatedAt,
          ...(mutationIdentity === undefined ? {} : { mutationIdentity }),
        },
        ...createVersionCondition(input.update.expectedVersion),
      }))
      return cloneFocusPolicy(policy)
    } catch (error) {
      throw mapConditionalError(error, 'Focus policy changed after it was read.')
    }
  }

  /** Stores one snooze replacement with optimistic concurrency. */
  async saveSnooze(input: SaveFocusSnoozeInput): Promise<FocusSnoozeRecord> {
    await this.ensureTable()
    const workspaceId = requireText(input.workspaceId, 'Focus Workspace ID')
    const memberKey = normalizeMemberKey(input.memberKey)
    const teamId = requireText(input.teamId, 'Focus Team ID')
    const workItemId = requireText(input.workItemId, 'Focus Work Item ID')
    const record = createStoredSnooze(input)
    const expiresAt = createStateExpiry(record, input.now)
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          scopeKey: createUserScopeKey(workspaceId, memberKey),
          recordKey: createSnoozeRecordKey(teamId, workItemId),
          entryType: 'snooze',
          version: record.version,
          teamId,
          workItemId,
          causeFingerprint: record.causeFingerprint,
          ...(record.snoozedUntil === undefined
            ? {}
            : { snoozedUntil: record.snoozedUntil }),
          updatedAt: record.updatedAt,
          ...(record.mutationIdentity === undefined
            ? {}
            : { mutationIdentity: record.mutationIdentity }),
          expiresAt,
        },
        ...createVersionCondition(input.expectedVersion),
      }))
      return cloneSnoozeRecord(record)
    } catch (error) {
      throw mapConditionalError(error, 'Focus snooze changed after it was read.')
    }
  }

  /**
   * Reads and validates one policy row against its requested physical scope.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param memberKey - Authenticated member implied by a personal policy target.
   * @param expectedTarget - Policy target implied by the requested partition.
   * @returns Stored policy when the exact requested row exists.
   */
  private async readPolicy(
    workspaceId: string,
    memberKey: string,
    expectedTarget: FocusPolicyTarget,
  ): Promise<StoredFocusPolicy | undefined> {
    const target = normalizePolicyTarget(expectedTarget)
    const scopeKey = createPolicyScopeKey(workspaceId, memberKey, target)
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { scopeKey, recordKey: userPolicyRecordKey },
      ConsistentRead: true,
    }))
    if (!response.Item) return undefined
    return parseStoredPolicy(
      response.Item,
      scopeKey,
      createFocusPolicyId(workspaceId, memberKey, target),
      target,
    )
  }

  /** Reads all snooze/tombstone rows in one recipient partition. */
  private async readSnoozes(scopeKey: string): Promise<FocusSnoozeRecord[]> {
    const snoozes: FocusSnoozeRecord[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    let pagesRead = 0
    const visitedCursors = new Set<string>()
    do {
      const remainingRows = snoozeReadMaximumRows - snoozes.length
      if (remainingRows <= 0 || pagesRead >= snoozeReadMaximumPages) {
        throw createSnoozeReadLimitError()
      }
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'scopeKey = :scopeKey AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: {
          ':scopeKey': scopeKey,
          ':prefix': snoozeRecordPrefix,
        },
        ConsistentRead: true,
        Limit: Math.min(snoozeReadPageLimit, remainingRows),
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))
      pagesRead += 1
      const items = response.Items ?? []
      if (items.length > remainingRows) {
        throw createSnoozeReadLimitError()
      }
      for (const item of items) {
        snoozes.push(parseStoredSnooze(item))
      }
      exclusiveStartKey = response.LastEvaluatedKey
      if (exclusiveStartKey !== undefined) {
        const cursor = createQueryCursorFingerprint(exclusiveStartKey)
        if (visitedCursors.has(cursor)) {
          throw new FocusStateError(
            503,
            'FocusStateCursorStalled',
            'Focus state could not advance to the next page.',
          )
        }
        visitedCursors.add(cursor)
        if (
          snoozes.length >= snoozeReadMaximumRows ||
          pagesRead >= snoozeReadMaximumPages
        ) {
          throw createSnoozeReadLimitError()
        }
      }
    } while (exclusiveStartKey)
    return snoozes.sort(compareSnoozeRecords)
  }

  /** Ensures the explicitly configured local table exists. */
  private async ensureTable(): Promise<void> {
    if (!this.bootstrapLocalTable) return
    this.tableReady ??= this.createLocalTable()
    await this.tableReady
  }

  /** Creates a missing local Focus table without changing production infrastructure. */
  private async createLocalTable(): Promise<void> {
    try {
      await this.dynamoDbClient.send(new DescribeTableCommand({ TableName: this.tableName }))
      return
    } catch (error) {
      if (!isAwsNamedError(error, 'ResourceNotFoundException')) throw error
    }
    try {
      await this.dynamoDbClient.send(new CreateTableCommand({
        TableName: this.tableName,
        AttributeDefinitions: [
          { AttributeName: 'scopeKey', AttributeType: 'S' },
          { AttributeName: 'recordKey', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'scopeKey', KeyType: 'HASH' },
          { AttributeName: 'recordKey', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }))
    } catch (error) {
      if (!isAwsNamedError(error, 'ResourceInUseException')) throw error
    }
    await waitUntilTableExists(
      { client: this.dynamoDbClient, maxWaitTime: 30 },
      { TableName: this.tableName },
    )
  }
}

/** Resolves the physical Focus table name for the current runtime. */
export function getConfiguredFocusTableName(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return environment.FOCUS_TABLE_NAME?.trim() || 'mukuroji-focus-local'
}

/** Creates the default production Focus state adapter. */
export function createFocusStateClient(): FocusStateClient {
  return new DynamoDbFocusStateClient()
}

/**
 * Creates the exact normalized policy that a mutation would persist.
 *
 * @param input - Authorized policy replacement and stable mutation clock.
 * @returns Deterministic next policy without performing persistence.
 */
export function createFocusPolicyMutationPreview(
  input: SaveFocusPolicyInput,
): FocusPolicy {
  const workspaceId = requireText(input.workspaceId, 'Focus Workspace ID')
  const memberKey = normalizeMemberKey(input.memberKey)
  const nextVersion = incrementVersion(input.update.expectedVersion)
  const now = requireDate(input.now, 'Focus policy mutation time')
  const target = normalizePolicyTarget(input.update.target)
  const overrides = normalizePolicyOverrides(input.update.overrides)
  return {
    schemaVersion: FOCUS_SCHEMA_VERSION,
    id: createFocusPolicyId(workspaceId, memberKey, target),
    target,
    version: nextVersion,
    overrides,
    updatedAt: now.toISOString(),
  }
}

/** Creates one stored snooze or unsnooze tombstone. */
function createStoredSnooze(input: SaveFocusSnoozeInput): FocusSnoozeRecord {
  const snoozedUntil = input.snoozedUntil === null
    ? undefined
    : requireFutureTimestamp(input.snoozedUntil, input.now)
  const mutationIdentity = normalizeMutationIdentity(input.mutationIdentity)
  return {
    teamId: requireText(input.teamId, 'Focus Team ID'),
    workItemId: requireText(input.workItemId, 'Focus Work Item ID'),
    version: incrementVersion(input.expectedVersion),
    causeFingerprint: requireText(input.causeFingerprint, 'Focus cause fingerprint'),
    ...(snoozedUntil ? { snoozedUntil } : {}),
    updatedAt: requireDate(input.now, 'Focus snooze mutation time').toISOString(),
    ...(mutationIdentity === undefined ? {} : { mutationIdentity }),
  }
}

/** Builds the physical policy scope for a user or Team target. */
function createPolicyScopeKey(
  workspaceId: string,
  memberKey: string,
  target: FocusPolicyTarget,
): string {
  return target.type === 'user'
    ? createUserScopeKey(workspaceId, memberKey)
    : createTeamScopeKey(workspaceId, target.teamId)
}

/** Creates the canonical public identifier for one physically scoped policy row. */
function createFocusPolicyId(
  workspaceId: string,
  memberKey: string,
  target: FocusPolicyTarget,
): string {
  return target.type === 'user'
    ? `focus-policy:${requireText(workspaceId, 'Focus Workspace ID')}:user:${normalizeMemberKey(memberKey)}`
    : `focus-policy:${requireText(workspaceId, 'Focus Workspace ID')}:team:${requireText(target.teamId, 'Focus Team ID')}`
}

/** Builds one Workspace/member Focus partition key. */
function createUserScopeKey(workspaceId: string, memberKey: string): string {
  return `WORKSPACE#${encodeFocusWorkspaceSegment(workspaceId)}#USER#${normalizeMemberKey(memberKey)}`
}

/** Builds one Workspace/Team Focus partition key. */
function createTeamScopeKey(workspaceId: string, teamId: string): string {
  return `WORKSPACE#${encodeFocusWorkspaceSegment(workspaceId)}#TEAM#${requireText(teamId, 'Focus Team ID')}`
}

/** Encodes one validated Workspace ID as a delimiter-safe Focus key segment. */
function encodeFocusWorkspaceSegment(workspaceId: string): string {
  return encodeURIComponent(requireText(workspaceId, 'Focus Workspace ID'))
}

/** Builds one encoded snooze sort key. */
function createSnoozeRecordKey(teamId: string, workItemId: string): string {
  return `${snoozeRecordPrefix}${encodeURIComponent(requireText(teamId, 'Focus Team ID'))}#${encodeURIComponent(requireText(workItemId, 'Focus Work Item ID'))}`
}

/** Builds one in-memory physical policy key. */
function createPolicyStorageKey(scopeKey: string): string {
  return `${scopeKey}\u0000${userPolicyRecordKey}`
}

/** Builds one in-memory physical snooze key. */
function createSnoozeStorageKey(
  scopeKey: string,
  teamId: string,
  workItemId: string,
): string {
  return `${scopeKey}\u0000${createSnoozeRecordKey(teamId, workItemId)}`
}

/** Creates a DynamoDB version condition for a create or replacement. */
function createVersionCondition(expectedVersion: number): {
  ConditionExpression: string
  ExpressionAttributeNames?: Record<string, string>
  ExpressionAttributeValues?: Record<string, number>
} {
  const version = requireVersion(expectedVersion)
  return version === 0
    ? { ConditionExpression: 'attribute_not_exists(scopeKey) AND attribute_not_exists(recordKey)' }
    : {
        ConditionExpression: '#version = :expectedVersion',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':expectedVersion': version },
      }
}

/**
 * Parses and validates one stored Focus policy row and its physical identity.
 *
 * @param value - Untrusted DynamoDB row.
 * @param expectedScopeKey - Exact partition key used for the consistent read.
 * @param expectedPolicyId - Canonical policy identifier implied by that partition.
 * @param expectedTarget - Canonical target implied by that partition.
 * @returns Validated policy detached from the persistence envelope.
 */
function parseStoredPolicy(
  value: Record<string, unknown>,
  expectedScopeKey: string,
  expectedPolicyId: string,
  expectedTarget: FocusPolicyTarget,
): StoredFocusPolicy {
  if (
    value.scopeKey !== expectedScopeKey ||
    value.recordKey !== userPolicyRecordKey ||
    value.entryType !== 'policy' ||
    !isRecord(value.policy)
  ) {
    throw createCorruptStateError('A Focus policy row is malformed.')
  }
  const policy = value.policy
  if (
    policy.schemaVersion !== FOCUS_SCHEMA_VERSION ||
    typeof policy.id !== 'string' ||
    !Number.isSafeInteger(policy.version) ||
    typeof policy.updatedAt !== 'string' ||
    !isRecord(policy.target) ||
    !isRecord(policy.overrides)
  ) {
    throw createCorruptStateError('A Focus policy row is malformed.')
  }
  try {
    const parsed: FocusPolicy = {
      schemaVersion: FOCUS_SCHEMA_VERSION,
      id: requireText(policy.id, 'Focus policy ID'),
      target: normalizePolicyTarget(policy.target),
      version: requireVersion(policy.version),
      overrides: normalizePolicyOverrides(policy.overrides),
      updatedAt: requireTimestamp(policy.updatedAt, 'Focus policy updated time'),
    }
    if (
      parsed.id !== expectedPolicyId ||
      parsed.version !== value.version ||
      parsed.updatedAt !== value.updatedAt ||
      !arePolicyTargetsEqual(parsed.target, expectedTarget)
    ) {
      throw new TypeError('Focus policy identity does not match its physical scope.')
    }
    const mutationIdentity = requireStoredMutationIdentity(value.mutationIdentity)
    return {
      policy: parsed,
      ...(mutationIdentity === undefined ? {} : { mutationIdentity }),
    }
  } catch (error) {
    throw createCorruptStateError('A Focus policy row is malformed.', error)
  }
}

/** Returns whether two normalized Focus policy targets identify the same scope. */
function arePolicyTargetsEqual(
  left: FocusPolicyTarget,
  right: FocusPolicyTarget,
): boolean {
  return left.type === 'user'
    ? right.type === 'user'
    : right.type === 'team' && left.teamId === right.teamId
}

/** Parses and validates one stored Focus snooze row. */
function parseStoredSnooze(value: Record<string, unknown>): FocusSnoozeRecord {
  if (value.entryType !== 'snooze') {
    throw createCorruptStateError('A Focus snooze row is malformed.')
  }
  try {
    const mutationIdentity = requireStoredMutationIdentity(value.mutationIdentity)
    return {
      teamId: requireText(value.teamId, 'Focus Team ID'),
      workItemId: requireText(value.workItemId, 'Focus Work Item ID'),
      version: requireVersion(value.version),
      causeFingerprint: requireText(value.causeFingerprint, 'Focus cause fingerprint'),
      ...(value.snoozedUntil === undefined
        ? {}
        : { snoozedUntil: requireTimestamp(value.snoozedUntil, 'Focus snooze wake time') }),
      updatedAt: requireTimestamp(value.updatedAt, 'Focus snooze updated time'),
      ...(mutationIdentity === undefined ? {} : { mutationIdentity }),
    }
  } catch (error) {
    throw createCorruptStateError('A Focus snooze row is malformed.', error)
  }
}

/** Normalizes one policy target without accepting an arbitrary user identity. */
function normalizePolicyTarget(value: unknown): FocusPolicyTarget {
  if (!isRecord(value)) throw new TypeError('Focus policy target is required.')
  if (value.type === 'user') return { type: 'user' }
  if (value.type === 'team') {
    return { type: 'team', teamId: requireText(value.teamId, 'Focus Team ID') }
  }
  throw new TypeError('Focus policy target is invalid.')
}

/** Normalizes bounded Focus policy overrides. */
function normalizePolicyOverrides(value: unknown): FocusPolicyOverrides {
  if (!isRecord(value)) throw new TypeError('Focus policy overrides are required.')
  const weights = value.weights === undefined
    ? undefined
    : normalizeWeightOverrides(value.weights)
  return {
    ...(weights && Object.keys(weights).length > 0 ? { weights } : {}),
    ...readOptionalPolicyNumber(value, 'dueSoonDays', 0, 365),
    ...readOptionalPolicyNumber(value, 'cycleDueSoonDays', 0, 365),
    ...readOptionalPolicyNumber(value, 'slaHours', 1, 24 * 365),
    ...readOptionalPolicyNumber(value, 'nowScoreThreshold', 0, 100_000),
  }
}

/** Normalizes optional signal weight replacements. */
function normalizeWeightOverrides(value: unknown): FocusPolicyOverrides['weights'] {
  if (!isRecord(value)) throw new TypeError('Focus signal weights are invalid.')
  return {
    ...readOptionalPolicyNumber(value, 'blocker', 0, 10_000),
    ...readOptionalPolicyNumber(value, 'urgent', 0, 10_000),
    ...readOptionalPolicyNumber(value, 'overdue', 0, 10_000),
    ...readOptionalPolicyNumber(value, 'dueSoon', 0, 10_000),
    ...readOptionalPolicyNumber(value, 'approval', 0, 10_000),
    ...readOptionalPolicyNumber(value, 'reviewRequest', 0, 10_000),
    ...readOptionalPolicyNumber(value, 'mention', 0, 10_000),
    ...readOptionalPolicyNumber(value, 'sla', 0, 10_000),
    ...readOptionalPolicyNumber(value, 'cycle', 0, 10_000),
  }
}

/** Reads one optional bounded numeric policy field. */
function readOptionalPolicyNumber(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): Record<string, number> {
  const candidate = value[key]
  if (candidate === undefined) return {}
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < minimum || candidate > maximum) {
    throw new TypeError(`Focus policy ${key} is outside its supported range.`)
  }
  return { [key]: candidate }
}

/** Creates the TTL retained after the wake time to preserve concurrency history. */
function createStateExpiry(record: FocusSnoozeRecord, now: Date): number {
  const nowTime = requireDate(now, 'Focus snooze mutation time').getTime()
  const wakeTime = record.snoozedUntil ? Date.parse(record.snoozedUntil) : nowTime
  return Math.floor(Math.max(nowTime, wakeTime) / 1000) + stateRetentionSeconds
}

/** Creates a stable failure when recipient state exceeds the supported read window. */
function createSnoozeReadLimitError(): FocusStateError {
  return new FocusStateError(
    503,
    'FocusStateReadLimitExceeded',
    `Focus state cannot exceed ${snoozeReadMaximumRows} snooze records.`,
  )
}

/** Creates a deterministic identity for one DynamoDB pagination key. */
function createQueryCursorFingerprint(key: Record<string, unknown>): string {
  return JSON.stringify(
    Object.entries(key).sort(([left], [right]) => left.localeCompare(right)),
  )
}

/** Maps a conditional write failure while preserving unexpected infrastructure errors. */
function mapConditionalError(error: unknown, message: string): unknown {
  return isAwsNamedError(error, 'ConditionalCheckFailedException')
    ? createConflictError(message)
    : error
}

/** Creates one stable optimistic concurrency error. */
function createConflictError(message: string): FocusStateError {
  return new FocusStateError(409, 'FocusStateConflict', message)
}

/** Creates one stable corrupt-row error. */
function createCorruptStateError(message: string, cause?: unknown): FocusStateError {
  return new FocusStateError(
    503,
    'FocusStateCorrupt',
    cause instanceof Error ? `${message} ${cause.message}` : message,
  )
}

/** Returns whether an unknown value is a record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Returns whether an unknown error has one AWS error name. */
function isAwsNamedError(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name
}

/** Requires one non-empty identifier-like string. */
function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} is required.`)
  }
  return value.trim()
}

/** Normalizes an optional bounded mutation identity supplied by the application layer. */
function normalizeMutationIdentity(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new FocusStateError(
      400,
      'InvalidFocusMutationIdentity',
      'Focus mutation identity must be a non-empty string.',
    )
  }
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > mutationIdentityMaximumLength) {
    throw new FocusStateError(
      400,
      'InvalidFocusMutationIdentity',
      `Focus mutation identity must be ${mutationIdentityMaximumLength} characters or fewer.`,
    )
  }
  return normalized
}

/** Reads an optional canonical mutation identity from an untrusted persistence row. */
function requireStoredMutationIdentity(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > mutationIdentityMaximumLength
  ) {
    throw new TypeError('Stored Focus mutation identity is invalid.')
  }
  return value
}

/** Normalizes a Workspace member key for durable recipient identity. */
function normalizeMemberKey(value: string): string {
  return requireText(value, 'Focus member key').toLowerCase()
}

/** Requires one non-negative safe integer version. */
function requireVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) {
    throw new TypeError('Focus version must be a non-negative safe integer.')
  }
  return value
}

/** Advances one Focus state version without leaving the safe-integer domain. */
function incrementVersion(value: unknown): number {
  const version = requireVersion(value)
  if (version === Number.MAX_SAFE_INTEGER) {
    throw new FocusStateError(
      409,
      'FocusStateVersionExhausted',
      'Focus state version can no longer be incremented.',
    )
  }
  return version + 1
}

/** Requires one valid Date and returns a defensive copy. */
function requireDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${label} must be a valid Date.`)
  }
  return new Date(value.getTime())
}

/** Requires and canonicalizes one ISO 8601 timestamp. */
function requireTimestamp(value: unknown, label: string): string {
  const text = requireText(value, label)
  const time = Date.parse(text)
  if (!Number.isFinite(time)) throw new TypeError(`${label} is invalid.`)
  return new Date(time).toISOString()
}

/** Requires a wake timestamp that is later than the mutation clock. */
function requireFutureTimestamp(value: string, now: Date): string {
  const timestamp = requireTimestamp(value, 'Focus snooze wake time')
  const nowTime = requireDate(now, 'Focus snooze mutation time').getTime()
  const wakeTime = Date.parse(timestamp)
  if (wakeTime <= nowTime || wakeTime > nowTime + snoozeMaximumMilliseconds) {
    throw new FocusStateError(
      400,
      'InvalidFocusSnoozeTime',
      'Focus snooze time must be in the next 365 days.',
    )
  }
  return timestamp
}

/** Returns stable unique non-empty identifiers. */
function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => requireText(value, 'Focus Team ID')))].sort()
}

/** Creates a defensive policy copy. */
function cloneFocusPolicy(policy: FocusPolicy): FocusPolicy {
  return {
    ...policy,
    target: policy.target.type === 'user'
      ? { type: 'user' }
      : { type: 'team', teamId: policy.target.teamId },
    overrides: {
      ...policy.overrides,
      ...(policy.overrides.weights ? { weights: { ...policy.overrides.weights } } : {}),
    },
  }
}

/** Creates a defensive snooze copy. */
function cloneSnoozeRecord(record: FocusSnoozeRecord): FocusSnoozeRecord {
  return { ...record }
}

/** Orders snoozes by stable Work Item identity. */
function compareSnoozeRecords(
  left: FocusSnoozeRecord,
  right: FocusSnoozeRecord,
): number {
  return left.teamId.localeCompare(right.teamId) ||
    left.workItemId.localeCompare(right.workItemId)
}
