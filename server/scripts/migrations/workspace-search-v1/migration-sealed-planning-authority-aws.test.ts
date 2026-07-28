import { createHash } from 'node:crypto'
import {
  ResourceNotFoundException,
  TransactionCanceledException,
  TransactWriteItemsCommand,
  type AttributeValue,
  type GetItemCommand,
  type GetItemCommandOutput,
  type TransactWriteItem,
  type TransactWriteItemsCommandOutput,
} from '@aws-sdk/client-dynamodb'
import { describe, expect, test } from 'bun:test'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  type MigrationKeyAttribute,
  type MigrationTableIdentity,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchPlanSeal,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  serializeWorkspaceSearchPlanSeal,
} from './migration-artifacts'
import {
  serializeWorkspaceSearchMigrationPlanManifestHead,
  WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
} from './migration-plan-artifact'
import {
  WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_ARTIFACT_OBJECT_KEY_PREFIX,
} from './migration-planning-artifact-aws'
import {
  createWorkspaceSearchMigrationPlanningProvenanceManifestHead,
  createWorkspaceSearchMigrationPlanningProvenanceManifestPageBuilder,
  createWorkspaceSearchMigrationPlanningProvenanceObjectKey,
  createWorkspaceSearchMigrationPlanningProvenanceSegments,
  serializeWorkspaceSearchMigrationPlanningProvenanceManifestHead,
  type WorkspaceSearchMigrationPlanningProvenanceStoredManifestPage,
  type WorkspaceSearchMigrationPlanningProvenanceStoredSegment,
} from './migration-planning-provenance-manifest'
import type {
  WorkspaceSearchMigrationHistoricalMaintenanceEvidenceBinding,
  WorkspaceSearchMigrationPrePlanAuthority,
} from './migration-pre-plan-authority-aws'
import {
  createWorkspaceSearchMigrationPlanningProvenanceArtifact,
} from './migration-sealed-planning-authority'
import {
  createAwsWorkspaceSearchMigrationSealedPlanningAuthorityV2Port,
  type PublishWorkspaceSearchMigrationSealedPlanningAuthorityV2Input,
  type WorkspaceSearchMigrationSealedPlanningAuthorityV2AwsTransport,
  workspaceSearchMigrationSealedPlanningAuthorityV2TransactionIndex,
} from './migration-sealed-planning-authority-aws'
import {
  type CreateWorkspaceSearchMigrationSealedPlanningAuthorityV2Input,
  createWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  parseWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import {
  advanceWorkspaceSearchMigrationSourceEvidenceProgress,
  createInitialWorkspaceSearchMigrationSourceEvidenceProgress,
  createWorkspaceSearchMigrationSourceEvidencePage,
  serializeWorkspaceSearchMigrationSourceEvidencePage,
  type WorkspaceSearchMigrationPlanningAuthorityBinding,
} from './migration-source-evidence'
import {
  createWorkspaceSearchMigrationPlanningSourceArtifactObjectKey,
} from './migration-source-artifact'
import {
  createEmptyWorkspaceSearchPlanDigest,
} from './migration-state-machine'
import {
  advanceWorkspaceSearchMigrationTargetEvidenceProgress,
  createInitialWorkspaceSearchMigrationTargetEvidenceProgress,
  createWorkspaceSearchMigrationTargetEvidencePage,
  serializeWorkspaceSearchMigrationTargetEvidencePage,
} from './migration-target-evidence'
import {
  createWorkspaceSearchMigrationPlanningTargetArtifactObjectKey,
} from './migration-target-artifact'

const runId = 'sealed-planning-authority-v2-run'
const ownerId = 'sealed-planning-authority-v2-owner'
const fenceToken = 7
const pointerRevision = 11
const preflightTime = '2026-07-29T01:01:45.000Z'
const commitTime = '2026-07-29T01:02:00.000Z'
const retainUntil = '2026-08-29T00:00:00.000Z'

describe('Workspace Search sealed planning authority v2 AWS adapter', () => {
  test('builds the fixed nine-item transaction after preparation', async () => {
    const fixture = createPublicationFixture()
    const events: string[] = []
    const transport = new RecordingPublicationTransport(events)
    const clock = createSequencedClock(events, [
      preflightTime,
      commitTime,
    ])
    const port =
      createAwsWorkspaceSearchMigrationSealedPlanningAuthorityV2Port(
        fixture.stateTable,
        fixture.configurationHash,
        transport,
        clock,
      )

    const published = await port.publish(fixture.publishInput)
    const command = requireTransaction(transport.transactions[0])
    const items = command.input.TransactItems
    if (items === undefined) {
      throw new Error('Expected publication transaction items.')
    }

    expect(events).toEqual([
      'clock',
      'prepare',
      'clock',
      'transact',
    ])
    expect(items).toHaveLength(9)
    for (let index = 0; index < 8; index += 1) {
      expect(items[index]?.ConditionCheck).toBeDefined()
      expect(items[index]?.Put).toBeUndefined()
    }
    const put = requireRootPut(items[8])
    expect(put.ConditionExpression).toBe(
      'attribute_not_exists(#migrationId) AND attribute_not_exists(#recordKey)',
    )
    expect(command.input.ClientRequestToken).toHaveLength(36)
    expect(published.sealedAt).toBe(commitTime)
    const putItem = requirePutItem(put)
    expect(
      requireStringAttribute(putItem, 'authorityDigest'),
    ).toBe(published.authorityDigest)
    expect(
      requireBinaryAttribute(putItem, 'rootBytes'),
    ).toEqual(
      serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2(
        published,
      ),
    )
    expect(
      items[
        workspaceSearchMigrationSealedPlanningAuthorityV2TransactionIndex
          .lease
      ]?.ConditionCheck?.ExpressionAttributeValues?.[':minimumExpiry'],
    ).toEqual({
      N: String(Date.parse(commitTime) + 10_000),
    })
    expect(
      items[
        workspaceSearchMigrationSealedPlanningAuthorityV2TransactionIndex
          .root
      ]?.Put,
    ).toBeDefined()
    expect(
      workspaceSearchMigrationSealedPlanningAuthorityV2TransactionIndex.count,
    ).toBe(9)
  })

  test('maps every fixed conditional cancellation position', async () => {
    const fixture = createPublicationFixture()
    const cases: readonly {
      readonly index: number
      readonly code:
        | 'LEASE_LOST'
        | 'INVALID_MAINTENANCE_EVIDENCE'
        | 'INVALID_STATE'
    }[] = [
      { index: 0, code: 'LEASE_LOST' },
      { index: 1, code: 'INVALID_MAINTENANCE_EVIDENCE' },
      { index: 2, code: 'INVALID_MAINTENANCE_EVIDENCE' },
      { index: 3, code: 'INVALID_STATE' },
      { index: 4, code: 'INVALID_STATE' },
      { index: 5, code: 'INVALID_STATE' },
      { index: 6, code: 'INVALID_STATE' },
      { index: 7, code: 'INVALID_STATE' },
      { index: 8, code: 'INVALID_STATE' },
    ]

    for (const candidate of cases) {
      const transport = new RecordingPublicationTransport()
      transport.nextTransactionError =
        createCancellation(candidate.index, 'ConditionalCheckFailed')
      const port =
        createAwsWorkspaceSearchMigrationSealedPlanningAuthorityV2Port(
          fixture.stateTable,
          fixture.configurationHash,
          transport,
          createFixedClock(commitTime),
        )

      const failure = await captureMigrationFailure(
        () => port.publish(fixture.publishInput),
      )

      expect({
        index: candidate.index,
        code: failure.code,
      }).toEqual(candidate)
    }
  })

  test('recovers byte-identical committed response loss', async () => {
    const fixture = createPublicationFixture()
    const transport = new RecordingPublicationTransport()
    transport.commitBeforeTransactionError = true
    transport.nextTransactionError =
      createNamedError('TimeoutError')
    const port =
      createAwsWorkspaceSearchMigrationSealedPlanningAuthorityV2Port(
        fixture.stateTable,
        fixture.configurationHash,
        transport,
        createFixedClock(commitTime),
      )

    const published = await port.publish(fixture.publishInput)
    const reread = await port.read(runId)

    expect(reread).toEqual(published)
    expect(transport.reads).toHaveLength(3)
    expect(
      transport.reads.every(({ input }) =>
        input.ConsistentRead === true
      ),
    ).toBe(true)
  })

  test('recovers the durable logical publication across retry timestamps', async () => {
    const fixture = createPublicationFixture()
    const cases: readonly ('absent' | 'timeout')[] = [
      'absent',
      'timeout',
    ]

    for (const reconciliation of cases) {
      const events: string[] = []
      const transport = new RecordingPublicationTransport(events)
      transport.commitBeforeTransactionError = true
      transport.nextTransactionError =
        createNamedError('TimeoutError')
      if (reconciliation === 'timeout') {
        transport.nextReadErrorAfterTransaction =
          createNamedError('TimeoutError')
      } else {
        transport.nextReadOutputAfterTransaction = { $metadata: {} }
      }
      const clock = createSequencedClock(events, [
        preflightTime,
        commitTime,
      ])
      const firstPort =
        createAwsWorkspaceSearchMigrationSealedPlanningAuthorityV2Port(
          fixture.stateTable,
          fixture.configurationHash,
          transport,
          clock,
        )

      const firstFailure = await captureMigrationFailure(
        () => firstPort.publish(fixture.publishInput),
      )
      expect(firstFailure.code).toBe(
        'AMBIGUOUS_OPERATION_UNRESOLVED',
      )
      const firstCommand = requireTransaction(
        transport.transactions[0],
      )
      const firstRootItem = requirePutItem(
        requireRootPut(
          firstCommand.input.TransactItems?.[
            workspaceSearchMigrationSealedPlanningAuthorityV2TransactionIndex
              .root
          ],
        ),
      )
      const firstRootBytes = requireBinaryAttribute(
        firstRootItem,
        'rootBytes',
      )
      const firstRoot =
        parseWorkspaceSearchMigrationSealedPlanningAuthorityV2(
          firstRootBytes,
        )
      transport.commitBeforeTransactionError = false
      transport.nextTransactionError = createCancellation(
        workspaceSearchMigrationSealedPlanningAuthorityV2TransactionIndex
          .root,
        'ConditionalCheckFailed',
      )
      let retryClockCalls = 0
      const retryPort =
        createAwsWorkspaceSearchMigrationSealedPlanningAuthorityV2Port(
          fixture.stateTable,
          fixture.configurationHash,
          transport,
          () => {
            retryClockCalls += 1
            return new Date('2026-07-29T02:00:00.000Z')
          },
        )

      const recovered = await retryPort.publish(fixture.publishInput)

      expect(recovered).toEqual(firstRoot)
      expect(recovered.sealedAt).toBe(commitTime)
      expect(
        serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2(
          recovered,
        ),
      ).toEqual(firstRootBytes)
      expect(transport.transactions).toHaveLength(1)
      expect(transport.reads).toHaveLength(3)
      expect(retryClockCalls).toBe(0)
      expect(
        transport.reads.every(({ input }) =>
          input.ConsistentRead === true
        ),
      ).toBe(true)
      expect(events).toEqual([
        'clock',
        'prepare',
        'clock',
        'transact',
        'prepare',
      ])
    }
  })

  test('rejects a durable publication for different stable input', async () => {
    const fixture = createPublicationFixture()
    const transport = new RecordingPublicationTransport()
    const port =
      createAwsWorkspaceSearchMigrationSealedPlanningAuthorityV2Port(
        fixture.stateTable,
        fixture.configurationHash,
        transport,
        createFixedClock(commitTime),
      )
    await port.publish(fixture.publishInput)
    const conflictingInput = {
      ...fixture.publishInput,
      planSealReference: {
        ...fixture.publishInput.planSealReference,
        versionId: 'different-plan-seal-version',
      },
    }

    const failure = await captureMigrationFailure(
      () => port.publish(conflictingInput),
    )

    expect(failure.code).toBe('INVALID_STATE')
    expect(transport.transactions).toHaveLength(1)
  })

  test('recovers a same-input root won by a concurrent timestamp', async () => {
    const fixture = createPublicationFixture()
    const concurrentRoot =
      createWorkspaceSearchMigrationSealedPlanningAuthorityV2({
        ...fixture.publishInput,
        sealedAt: '2026-07-29T01:01:55.000Z',
      })
    const concurrentRootBytes =
      serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2(
        concurrentRoot,
      )
    const transport = new RecordingPublicationTransport()
    transport.commitBeforeTransactionError = true
    transport.nextTransactionError =
      createNamedError('TimeoutError')
    transport.transformCommittedItem = (item) => ({
      ...item,
      authorityDigest: { S: concurrentRoot.authorityDigest },
      sealedAt: { S: concurrentRoot.sealedAt },
      rootBytes: { B: concurrentRootBytes },
    })
    const port =
      createAwsWorkspaceSearchMigrationSealedPlanningAuthorityV2Port(
        fixture.stateTable,
        fixture.configurationHash,
        transport,
        createSequencedClock([], [
          preflightTime,
          commitTime,
        ]),
      )

    const recovered = await port.publish(fixture.publishInput)

    expect(recovered).toEqual(concurrentRoot)
    expect(
      serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2(
        recovered,
      ),
    ).toEqual(concurrentRootBytes)
  })

  test('keeps absent ambiguous outcomes unresolved and explicit rejection transient', async () => {
    const fixture = createPublicationFixture()
    const cases: readonly {
      readonly error: unknown
      readonly code:
        | 'AMBIGUOUS_OPERATION_UNRESOLVED'
        | 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    }[] = [
      {
        error: createNamedError('TransactionInProgressException'),
        code: 'AMBIGUOUS_OPERATION_UNRESOLVED',
      },
      {
        error: createNamedError('TimeoutError'),
        code: 'AMBIGUOUS_OPERATION_UNRESOLVED',
      },
      {
        error: createCodedError('ECONNRESET'),
        code: 'AMBIGUOUS_OPERATION_UNRESOLVED',
      },
      {
        error: createCancellation(4, 'TransactionConflict'),
        code: 'TRANSIENT_INFRASTRUCTURE_FAILURE',
      },
      {
        error: createNamedError('ThrottlingException'),
        code: 'TRANSIENT_INFRASTRUCTURE_FAILURE',
      },
    ]

    for (const candidate of cases) {
      const transport = new RecordingPublicationTransport()
      transport.nextTransactionError = candidate.error
      const port =
        createAwsWorkspaceSearchMigrationSealedPlanningAuthorityV2Port(
          fixture.stateTable,
          fixture.configurationHash,
          transport,
          createFixedClock(commitTime),
        )

      const failure = await captureMigrationFailure(
        () => port.publish(fixture.publishInput),
      )

      expect(failure.code).toBe(candidate.code)
    }
  })

  test('does not let a durable root hide managed post-commit guard failure', async () => {
    const fixture = createPublicationFixture()
    const cases: readonly {
      readonly transportCode:
        | 'SOURCE_DRIFT'
        | 'TARGET_DRIFT'
        | 'TRANSIENT_INFRASTRUCTURE_FAILURE'
      readonly expectedCode:
        | 'SOURCE_DRIFT'
        | 'TARGET_DRIFT'
        | 'AMBIGUOUS_OPERATION_UNRESOLVED'
    }[] = [
      {
        transportCode: 'SOURCE_DRIFT',
        expectedCode: 'SOURCE_DRIFT',
      },
      {
        transportCode: 'TARGET_DRIFT',
        expectedCode: 'TARGET_DRIFT',
      },
      {
        transportCode: 'TRANSIENT_INFRASTRUCTURE_FAILURE',
        expectedCode: 'AMBIGUOUS_OPERATION_UNRESOLVED',
      },
    ]

    for (const candidate of cases) {
      const transport = new RecordingPublicationTransport()
      transport.commitBeforeTransactionError = true
      transport.nextTransactionError =
        new WorkspaceSearchMigrationFailure(
          candidate.transportCode,
          'managed post-commit guard failed',
        )
      const port =
        createAwsWorkspaceSearchMigrationSealedPlanningAuthorityV2Port(
          fixture.stateTable,
          fixture.configurationHash,
          transport,
          createFixedClock(commitTime),
        )

      const failure = await captureMigrationFailure(
        () => port.publish(fixture.publishInput),
      )

      expect(failure.code).toBe(candidate.expectedCode)
      expect(transport.reads).toHaveLength(1)
    }
  })

  test('fails closed for foreign rows and reports missing state-table drift', async () => {
    const fixture = createPublicationFixture()
    const foreignTransport = new RecordingPublicationTransport()
    foreignTransport.commitBeforeTransactionError = true
    foreignTransport.nextTransactionError =
      createNamedError('TimeoutError')
    foreignTransport.transformCommittedItem = (item) => ({
      ...item,
      authorityDigest: { S: digest('foreign-authority') },
    })
    const foreignPort =
      createAwsWorkspaceSearchMigrationSealedPlanningAuthorityV2Port(
        fixture.stateTable,
        fixture.configurationHash,
        foreignTransport,
        createFixedClock(commitTime),
      )

    const foreignFailure = await captureMigrationFailure(
      () => foreignPort.publish(fixture.publishInput),
    )
    expect(foreignFailure.code).toBe('INVALID_STATE')

    const missingTransport = new RecordingPublicationTransport()
    missingTransport.nextTransactionError =
      createNamedError('TimeoutError')
    missingTransport.nextReadErrorAfterTransaction =
      new ResourceNotFoundException({
        $metadata: {},
        message: 'redacted fixture',
      })
    const missingPort =
      createAwsWorkspaceSearchMigrationSealedPlanningAuthorityV2Port(
        fixture.stateTable,
        fixture.configurationHash,
        missingTransport,
        createFixedClock(commitTime),
      )

    const missingFailure = await captureMigrationFailure(
      () => missingPort.publish(fixture.publishInput),
    )
    expect(missingFailure.code).toBe('CONFIGURATION_DRIFT')

    const guardedDriftTransport =
      new RecordingPublicationTransport()
    guardedDriftTransport.nextTransactionError =
      createNamedError('TimeoutError')
    guardedDriftTransport.nextReadErrorAfterTransaction =
      new WorkspaceSearchMigrationFailure(
        'CONFIGURATION_DRIFT',
        'redacted managed drift',
      )
    const guardedDriftPort =
      createAwsWorkspaceSearchMigrationSealedPlanningAuthorityV2Port(
        fixture.stateTable,
        fixture.configurationHash,
        guardedDriftTransport,
        createFixedClock(commitTime),
      )

    const guardedDriftFailure = await captureMigrationFailure(
      () => guardedDriftPort.publish(fixture.publishInput),
    )
    expect(guardedDriftFailure.code).toBe('CONFIGURATION_DRIFT')
  })

  test('rejects accessors before invocation or preparation', async () => {
    const fixture = createPublicationFixture()
    const events: string[] = []
    const transport = new RecordingPublicationTransport(events)
    let getterCalls = 0
    Object.defineProperty(fixture.publishInput, 'runId', {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1
        return runId
      },
    })
    const port =
      createAwsWorkspaceSearchMigrationSealedPlanningAuthorityV2Port(
        fixture.stateTable,
        fixture.configurationHash,
        transport,
        createFixedClock(commitTime),
      )

    const failure = await captureMigrationFailure(
      () => port.publish(fixture.publishInput),
    )

    expect(failure.code).toBe('INVALID_ARGUMENT')
    expect(getterCalls).toBe(0)
    expect(events).toEqual([])
  })

  test('rejects mismatched state wiring before preparation', async () => {
    const fixture = createPublicationFixture()
    const events: string[] = []
    const transport = new RecordingPublicationTransport(events)
    const port =
      createAwsWorkspaceSearchMigrationSealedPlanningAuthorityV2Port(
        {
          ...fixture.stateTable,
          tableName: 'different-migration-state',
        },
        fixture.configurationHash,
        transport,
        createFixedClock(commitTime),
      )

    const failure = await captureMigrationFailure(
      () => port.publish(fixture.publishInput),
    )

    expect(failure.code).toBe('CONFIGURATION_DRIFT')
    expect(events).toEqual([])
    expect(transport.transactions).toEqual([])
  })

  test('rejects hostile strong-read accessors without invoking them', async () => {
    const fixture = createPublicationFixture()
    const transport = new RecordingPublicationTransport()
    let outputGetterCalls = 0
    const hostileOutput: GetItemCommandOutput = { $metadata: {} }
    Object.defineProperty(hostileOutput, 'Item', {
      enumerable: true,
      get: () => {
        outputGetterCalls += 1
        return {}
      },
    })
    transport.nextReadOutput = hostileOutput
    const port =
      createAwsWorkspaceSearchMigrationSealedPlanningAuthorityV2Port(
        fixture.stateTable,
        fixture.configurationHash,
        transport,
        createFixedClock(commitTime),
      )

    const outputFailure = await captureMigrationFailure(
      () => port.read(runId),
    )

    expect(outputFailure.code).toBe('INVALID_STATE')
    expect(outputGetterCalls).toBe(0)

    let attributeGetterCalls = 0
    transport.commitBeforeTransactionError = true
    transport.cloneReadItem = false
    transport.nextTransactionError =
      createNamedError('TimeoutError')
    transport.transformCommittedItem = (item) => {
      const hostileItem = structuredClone(item)
      const hostileAttribute: AttributeValue = { S: 'placeholder' }
      Object.defineProperty(hostileAttribute, 'S', {
        enumerable: true,
        get: () => {
          attributeGetterCalls += 1
          return 'secret'
        },
      })
      Reflect.set(
        hostileItem,
        'authorityDigest',
        hostileAttribute,
      )
      return hostileItem
    }

    const attributeFailure = await captureMigrationFailure(
      () => port.publish(fixture.publishInput),
    )

    expect(attributeFailure.code).toBe('INVALID_STATE')
    expect(attributeGetterCalls).toBe(0)
  })
})

/**
 * In-memory narrow transport recording exact publication commands.
 */
class RecordingPublicationTransport
implements WorkspaceSearchMigrationSealedPlanningAuthorityV2AwsTransport {
  /** Optional shared lifecycle trace. */
  private readonly events: string[]

  /** Strong read commands received by the transport. */
  readonly reads: GetItemCommand[] = []

  /** Transaction commands received by the transport. */
  readonly transactions: TransactWriteItemsCommand[] = []

  /** Optional one-shot transaction error. */
  nextTransactionError: unknown

  /** Optional one-shot reconciliation read error. */
  nextReadError: unknown

  /** Optional one-shot read error armed after transaction failure. */
  nextReadErrorAfterTransaction: unknown

  /** Optional one-shot raw strong-read response. */
  nextReadOutput: GetItemCommandOutput | undefined

  /** Optional one-shot read response armed after transaction failure. */
  nextReadOutputAfterTransaction: GetItemCommandOutput | undefined

  /** Whether the next transaction installs its root before throwing. */
  commitBeforeTransactionError = false

  /** Whether strong reads clone the in-memory item like the SDK normally does. */
  cloneReadItem = true

  /** Optional committed-item mutation used to model a foreign row. */
  transformCommittedItem:
    (
      (
        item: Readonly<Record<string, AttributeValue>>,
      ) => Readonly<Record<string, AttributeValue>>
    ) | undefined

  /** Currently durable immutable publication item. */
  private item:
    Readonly<Record<string, AttributeValue>> | undefined

  /**
   * Creates one recording transport.
   *
   * @param events - Optional shared lifecycle trace.
   */
  constructor(events: string[] = []) {
    this.events = events
  }

  /**
   * Strongly reads the currently durable publication item.
   *
   * @param command - Adapter-owned GetItem command.
   * @returns Current item or absence.
   */
  readonly getSealedPlanningAuthority = async (
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput> => {
    this.reads.push(command)
    if (this.nextReadError !== undefined) {
      const error = this.nextReadError
      this.nextReadError = undefined
      throw error
    }
    if (this.nextReadOutput !== undefined) {
      const output = this.nextReadOutput
      this.nextReadOutput = undefined
      return output
    }
    return this.item === undefined
      ? { $metadata: {} }
      : {
          $metadata: {},
          Item: this.cloneReadItem
            ? structuredClone(this.item)
            : this.item,
        }
  }

  /**
   * Records final write preparation.
   *
   * @returns Immediate completion.
   */
  readonly prepareSealedPlanningAuthorityWrite =
    (): Promise<void> => {
      this.events.push('prepare')
      return Promise.resolve()
    }

  /**
   * Installs or rejects one atomic publication transaction.
   *
   * @param command - Adapter-owned transaction command.
   * @returns Empty successful low-level response.
   */
  readonly transactWriteSealedPlanningAuthority = async (
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput> => {
    this.events.push('transact')
    this.transactions.push(command)
    const transactionError = this.nextTransactionError
    const shouldCommit =
      transactionError === undefined ||
      this.commitBeforeTransactionError
    if (shouldCommit) {
      const rootPut = requireRootPut(
        command.input.TransactItems?.[
          workspaceSearchMigrationSealedPlanningAuthorityV2TransactionIndex
            .root
        ],
      )
      const candidate = structuredClone(requirePutItem(rootPut))
      this.item = this.transformCommittedItem === undefined
        ? candidate
        : this.transformCommittedItem(candidate)
    }
    this.nextTransactionError = undefined
    if (transactionError !== undefined) {
      this.nextReadError = this.nextReadErrorAfterTransaction
      this.nextReadErrorAfterTransaction = undefined
      this.nextReadOutput = this.nextReadOutputAfterTransaction
      this.nextReadOutputAfterTransaction = undefined
      throw transactionError
    }
    return { $metadata: {} }
  }
}

/**
 * Complete valid input used by focused adapter tests.
 */
type PublicationFixture = {
  /** Complete measured configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Measured migration-state table. */
  readonly stateTable: MigrationTableIdentity
  /** Complete publication input without adapter-owned time. */
  readonly publishInput:
    PublishWorkspaceSearchMigrationSealedPlanningAuthorityV2Input
}

/**
 * Creates one internally consistent empty-plan publication fixture.
 *
 * @returns Complete valid adapter input.
 */
function createPublicationFixture(): PublicationFixture {
  const configuration = createConfiguration()
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  const receipt = createMaintenanceReceipt()
  const receiptDigest = createMigrationDigest(receipt)
  const planningAuthority:
    WorkspaceSearchMigrationPlanningAuthorityBinding = {
      ownerId,
      fenceToken,
      maintenanceEvidencePointerRevision: pointerRevision,
      maintenanceEvidenceReceiptDigest: receiptDigest,
    }
  const sourceEvidence = {
    'project-directory': createTerminalSourceEvidence(
      configuration,
      configurationHash,
      'project-directory',
      planningAuthority,
    ),
    'work-items': createTerminalSourceEvidence(
      configuration,
      configurationHash,
      'work-items',
      planningAuthority,
    ),
    collaboration: createTerminalSourceEvidence(
      configuration,
      configurationHash,
      'collaboration',
      planningAuthority,
    ),
    documents: createTerminalSourceEvidence(
      configuration,
      configurationHash,
      'documents',
      planningAuthority,
    ),
  }
  const sourceProgress = {
    'project-directory':
      sourceEvidence['project-directory'].progress,
    'work-items': sourceEvidence['work-items'].progress,
    collaboration: sourceEvidence.collaboration.progress,
    documents: sourceEvidence.documents.progress,
  }
  const sourceEvidencePageBytes = {
    'project-directory':
      sourceEvidence['project-directory'].pageBytes,
    'work-items': sourceEvidence['work-items'].pageBytes,
    collaboration: sourceEvidence.collaboration.pageBytes,
    documents: sourceEvidence.documents.pageBytes,
  }
  const targetEvidence = createTerminalTargetEvidence(
    configuration,
    configurationHash,
    planningAuthority,
  )
  const historicalBinding:
    WorkspaceSearchMigrationHistoricalMaintenanceEvidenceBinding = {
      configurationHash,
      stateTableId:
        configuration.tables['migration-state'].tableId,
      ownerId,
      receiptDigest,
      receipt,
    }
  const provenanceObjectKeyPrefix =
    `${WORKSPACE_SEARCH_MIGRATION_PLANNING_PROVENANCE_ARTIFACT_OBJECT_KEY_PREFIX}/${runId}/${configurationHash}`
  const provenanceArtifact =
    createWorkspaceSearchMigrationPlanningProvenanceArtifact({
      sourceEvidencePageBytes,
      targetEvidencePageBytes: [targetEvidence.pageBytes],
      historicalReceiptBindings: [historicalBinding],
    })
  const encodedSegments =
    createWorkspaceSearchMigrationPlanningProvenanceSegments({
      artifact: provenanceArtifact,
      objectKeyPrefix: provenanceObjectKeyPrefix,
    })
  const storedSegments:
    WorkspaceSearchMigrationPlanningProvenanceStoredSegment[] =
      encodedSegments.map((encoded, index) => ({
        encoded,
        reference: {
          objectKey:
            createWorkspaceSearchMigrationPlanningProvenanceObjectKey(
              provenanceObjectKeyPrefix,
              'segments',
              encoded.contentDigest,
            ),
          versionId: `segment-version-${index}`,
          contentDigest: encoded.contentDigest,
          byteLength: encoded.byteLength,
          retainUntil,
        },
      }))
  const manifestPageBuilder =
    createWorkspaceSearchMigrationPlanningProvenanceManifestPageBuilder({
      artifact: provenanceArtifact,
      objectKeyPrefix: provenanceObjectKeyPrefix,
      storedSegments,
    })
  const storedManifestPages:
    WorkspaceSearchMigrationPlanningProvenanceStoredManifestPage[] = []
  let previous:
    WorkspaceSearchMigrationPlanningProvenanceStoredManifestPage | null =
      null
  for (
    let pageIndex = 0;
    pageIndex < manifestPageBuilder.pageCount;
    pageIndex += 1
  ) {
    const encoded = manifestPageBuilder.createNextPage(previous)
    const stored = {
      encoded,
      reference: {
        objectKey:
          createWorkspaceSearchMigrationPlanningProvenanceObjectKey(
            provenanceObjectKeyPrefix,
            'manifest-pages',
            encoded.contentDigest,
          ),
        versionId: `manifest-page-version-${pageIndex}`,
        contentDigest: encoded.contentDigest,
        byteLength: encoded.byteLength,
        retainUntil,
      },
    }
    storedManifestPages.push(stored)
    previous = stored
  }
  const planningProvenanceManifestHead =
    createWorkspaceSearchMigrationPlanningProvenanceManifestHead({
      artifact: provenanceArtifact,
      objectKeyPrefix: provenanceObjectKeyPrefix,
      storedManifestPages,
    })
  const provenanceHeadBytes =
    serializeWorkspaceSearchMigrationPlanningProvenanceManifestHead(
      planningProvenanceManifestHead,
    )
  const planSeal = createPlanSeal(
    configurationHash,
    provenanceArtifact.planningSnapshotDigest,
  )
  const planSealBytes = serializeWorkspaceSearchPlanSeal(planSeal)
  const planSealContentDigest = digestBytes(planSealBytes)
  const encodedPlanHead =
    serializeWorkspaceSearchMigrationPlanManifestHead({
      planSeal,
      manifestPages: [],
      segments: [],
    })
  const currentAuthority = createCurrentAuthority(
    configurationHash,
    configuration.tables['migration-state'].tableId,
    receipt,
  )
  const timedInput = {
    runId,
    configuration,
    configurationHash,
    planSeal,
    planSealReference: {
      objectKey:
        `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/plan-seals/${planSealContentDigest}.artifact`,
      versionId: 'plan-seal-version',
      contentDigest: planSealContentDigest,
      byteLength: planSealBytes.byteLength,
      retainUntil,
    },
    planManifestHead: encodedPlanHead.head,
    planManifestHeadReference: {
      objectKey: encodedPlanHead.objectKey,
      versionId: 'plan-head-version',
      contentDigest: encodedPlanHead.contentDigest,
      byteLength: encodedPlanHead.byteLength,
      retainUntil,
    },
    planningProvenanceManifestHead,
    planningProvenanceManifestHeadReference: {
      objectKey:
        createWorkspaceSearchMigrationPlanningProvenanceObjectKey(
          provenanceObjectKeyPrefix,
          'manifest-heads',
          digestBytes(provenanceHeadBytes),
        ),
      versionId: 'provenance-head-version',
      contentDigest: digestBytes(provenanceHeadBytes),
      byteLength: provenanceHeadBytes.byteLength,
      retainUntil,
    },
    planningAuthorityProvenance:
      provenanceArtifact.provenance,
    sourceProgress,
    targetProgress: targetEvidence.progress,
    currentAuthority,
    sealedAt: commitTime,
  } satisfies CreateWorkspaceSearchMigrationSealedPlanningAuthorityV2Input
  return {
    configuration,
    configurationHash,
    stateTable: configuration.tables['migration-state'],
    publishInput: omitSealedAt(timedInput),
  }
}

/**
 * Creates one complete single-page empty source evidence chain.
 *
 * @param configuration - Complete measured configuration.
 * @param configurationHash - Reviewed configuration digest.
 * @param source - Exact source-chain role.
 * @param authority - Authority tuple bound to the page.
 * @returns Canonical page bytes and terminal progress.
 */
function createTerminalSourceEvidence(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  source: WorkspaceSearchMigrationSourceName,
  authority: WorkspaceSearchMigrationPlanningAuthorityBinding,
) {
  const identity = {
    purpose: 'planning',
    runId,
    configurationHash,
    source,
    sourceTableId: configuration.tables[source].tableId,
    stateTableId:
      configuration.tables['migration-state'].tableId,
  } satisfies Parameters<
    typeof createInitialWorkspaceSearchMigrationSourceEvidenceProgress
  >[0]
  const initial =
    createInitialWorkspaceSearchMigrationSourceEvidenceProgress(
      identity,
    )
  const artifactDigest = digest(`source-artifact:${source}`)
  const page = createWorkspaceSearchMigrationSourceEvidencePage({
    identity,
    planningAuthority: authority,
    sourceArtifacts: [{
      objectKey:
        createWorkspaceSearchMigrationPlanningSourceArtifactObjectKey(
          artifactDigest,
        ),
      versionId: `source-version-${source}`,
      contentDigest: artifactDigest,
    }],
    previousProgress: initial,
    pageResult: {
      checkpoint: {
        ...initial.checkpoint,
        completed: true,
        aggregate: {
          ...initial.checkpoint.aggregate,
          pageCount: 1,
        },
      },
      sourceRows: [],
      invalidRows: [],
      sourceBindings: [],
    },
  })
  return {
    pageBytes: [
      serializeWorkspaceSearchMigrationSourceEvidencePage(page),
    ],
    progress:
      advanceWorkspaceSearchMigrationSourceEvidenceProgress(
        initial,
        page,
      ),
  }
}

/**
 * Creates one complete single-page empty target evidence chain.
 *
 * @param configuration - Complete measured configuration.
 * @param configurationHash - Reviewed configuration digest.
 * @param authority - Authority tuple bound to the page.
 * @returns Canonical page bytes and terminal progress.
 */
function createTerminalTargetEvidence(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  authority: WorkspaceSearchMigrationPlanningAuthorityBinding,
) {
  const identity = {
    purpose: 'planning',
    runId,
    configurationHash,
    targetTableId:
      configuration.tables['workspace-search'].tableId,
    stateTableId:
      configuration.tables['migration-state'].tableId,
  } satisfies Parameters<
    typeof createInitialWorkspaceSearchMigrationTargetEvidenceProgress
  >[0]
  const initial =
    createInitialWorkspaceSearchMigrationTargetEvidenceProgress(
      identity,
    )
  const artifactDigest = digest('target-artifact')
  const page = createWorkspaceSearchMigrationTargetEvidencePage({
    identity,
    planningAuthority: authority,
    targetArtifacts: [{
      objectKey:
        createWorkspaceSearchMigrationPlanningTargetArtifactObjectKey(
          artifactDigest,
        ),
      versionId: 'target-version',
      contentDigest: artifactDigest,
    }],
    previousProgress: initial,
    pageResult: {
      checkpoint: {
        ...initial.checkpoint,
        completed: true,
        aggregate: {
          ...initial.checkpoint.aggregate,
          pageCount: 1,
        },
      },
      targetRows: [],
      invalidRows: [],
      observedTargetBindings: [],
    },
  })
  return {
    pageBytes:
      serializeWorkspaceSearchMigrationTargetEvidencePage(page),
    progress:
      advanceWorkspaceSearchMigrationTargetEvidenceProgress(
        initial,
        page,
      ),
  }
}

/**
 * Creates one fresh immutable maintenance receipt.
 *
 * @returns Canonical receipt fixture.
 */
function createMaintenanceReceipt():
  WorkspaceSearchMaintenanceEvidenceReceipt {
  return {
    runId,
    evidenceDigest: digest('maintenance-evidence'),
    evidenceLocator:
      'workspace-search/v1/maintenance/publication.json',
    runtimeRevision: 7,
    fenceToken,
    validatedAt: '2026-07-29T00:59:00.000Z',
    oldestObservationAt: '2026-07-29T00:58:00.000Z',
    validUntil: '2026-07-29T01:03:00.001Z',
  }
}

/**
 * Creates current authority around one exact receipt.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @param stateTableId - Immutable migration-state TableId.
 * @param receipt - Exact current immutable receipt.
 * @returns Complete fresh pre-plan authority.
 */
function createCurrentAuthority(
  configurationHash: string,
  stateTableId: string,
  receipt: WorkspaceSearchMaintenanceEvidenceReceipt,
): WorkspaceSearchMigrationPrePlanAuthority {
  return {
    configurationHash,
    stateTableId,
    lease: {
      runId,
      ownerId,
      fenceToken,
      heartbeatAt: '2026-07-29T01:01:15.000Z',
      expiresAt: '2026-07-29T01:02:15.000Z',
    },
    maintenanceEvidenceReceiptDigest:
      createMigrationDigest(receipt),
    maintenanceEvidencePointerRevision: pointerRevision,
    maintenanceEvidenceReceipt: receipt,
    evaluatedAt: '2026-07-29T01:01:30.000Z',
  }
}

/**
 * Creates the strict empty plan seal correlated to provenance.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @param planningSnapshotDigest - Replayed five-chain snapshot digest.
 * @returns Strict plan-seal v2 fixture.
 */
function createPlanSeal(
  configurationHash: string,
  planningSnapshotDigest: string,
): WorkspaceSearchPlanSeal {
  return {
    kind: 'workspace-search-plan-seal',
    sealVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    dryRunEvidenceDigest: digest('dry-run-evidence'),
    planningSnapshotDigest,
    planDigest: createEmptyWorkspaceSearchPlanDigest(),
    planOperationCount: 0,
    sourceOperationCount: 0,
    orphanOperationCount: 0,
    createdAt: '2026-07-29T01:00:00.000Z',
  }
}

/**
 * Creates one complete measured migration configuration.
 *
 * @returns Stable measured configuration.
 */
function createConfiguration(): WorkspaceSearchMigrationConfiguration {
  return {
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    account: '123456789012',
    region: 'ap-northeast-1',
    profile: 'production-operator',
    commit: 'a'.repeat(40),
    callerArn:
      'arn:aws:sts::123456789012:assumed-role/migration-operator/session',
    callerRoleId: 'AROA1234567890ABCDEFG',
    tables: {
      'project-directory': createSourceTable('project-directory'),
      'work-items': createSourceTable('work-items'),
      collaboration: createSourceTable('collaboration'),
      documents: createSourceTable('documents'),
      'workspace-search':
        createSupportingTable('workspace-search'),
      'migration-state': createSupportingTable('migration-state'),
    },
    journal: {
      bucketName: 'mukuroji-workspace-search-migration-journal',
      keyArn:
        'arn:aws:kms:ap-northeast-1:123456789012:key/00000000-0000-0000-0000-000000000001',
      keyCreationTime: '2026-07-01T00:00:00.000Z',
      keyManager: 'CUSTOMER',
      keyState: 'Enabled',
      keySpec: 'SYMMETRIC_DEFAULT',
      keyUsage: 'ENCRYPT_DECRYPT',
      keyOrigin: 'AWS_KMS',
      keyMultiRegion: false,
      versioning: 'Enabled',
      objectLockMode: 'COMPLIANCE',
      defaultRetentionDays: 30,
      encryption: 'aws:kms',
      bucketKeyEnabled: true,
      accessLogBucket: 'mukuroji-access-logs',
      accessLogPrefix: 'workspace-search-migration/',
    },
    journalPrefix: 'workspace-search/v1',
  }
}

/**
 * Creates one measured source-table identity.
 *
 * @param role - Logical source role.
 * @returns Stable source identity.
 */
function createSourceTable(
  role: WorkspaceSearchMigrationSourceName,
): MigrationTableIdentity {
  return createTable(role, sourceKeyDescriptors(role), false)
}

/**
 * Creates one measured supporting-table identity.
 *
 * @param role - Logical supporting-table role.
 * @returns Stable supporting identity.
 */
function createSupportingTable(
  role: 'migration-state' | 'workspace-search',
): MigrationTableIdentity {
  return createTable(
    role,
    role === 'workspace-search'
      ? [
          { name: 'workspaceId', role: 'HASH', type: 'S' },
          { name: 'recordKey', role: 'RANGE', type: 'S' },
        ]
      : [
          { name: 'migrationId', role: 'HASH', type: 'S' },
          { name: 'recordKey', role: 'RANGE', type: 'S' },
        ],
    true,
  )
}

/**
 * Creates one complete measured table identity.
 *
 * @param role - Logical migration table role.
 * @param key - Exact base-table key descriptor.
 * @param deletionProtection - Measured deletion-protection state.
 * @returns Complete table identity.
 */
function createTable(
  role: MigrationTableIdentity['role'],
  key: readonly MigrationKeyAttribute[],
  deletionProtection: boolean,
): MigrationTableIdentity {
  return {
    role,
    tableName: `table-${role}`,
    tableArn:
      `arn:aws:dynamodb:ap-northeast-1:123456789012:table/table-${role}`,
    tableId: `table-id-${role}`,
    creationTime: '2026-01-01T00:00:00.000Z',
    account: '123456789012',
    region: 'ap-northeast-1',
    key,
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection,
    encryption: role === 'documents' ? 'KMS' : 'AWS_OWNED',
    kmsKeyDigest: role === 'documents'
      ? digest('documents-key')
      : null,
    ttl: role === 'collaboration'
      ? { status: 'ENABLED', attribute: 'expiresAt' }
      : role === 'documents'
        ? { status: 'ENABLED', attribute: 'expiresAtEpoch' }
        : { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime: '2026-07-01T00:00:00.000Z',
      latestRestorableTime: '2026-07-26T00:00:00.000Z',
    },
  }
}

/**
 * Returns the measured primary-key schema for one source role.
 *
 * @param role - Logical source role.
 * @returns Ordered key descriptors.
 */
function sourceKeyDescriptors(
  role: WorkspaceSearchMigrationSourceName,
): readonly MigrationKeyAttribute[] {
  if (role === 'project-directory') {
    return [
      { name: 'directoryId', role: 'HASH', type: 'S' },
      { name: 'entryKey', role: 'RANGE', type: 'S' },
    ]
  }
  if (role === 'work-items') {
    return [
      { name: 'directoryTeamId', role: 'HASH', type: 'S' },
      { name: 'issueId', role: 'RANGE', type: 'S' },
    ]
  }
  if (role === 'collaboration') {
    return [
      { name: 'entityKey', role: 'HASH', type: 'S' },
      { name: 'recordKey', role: 'RANGE', type: 'S' },
    ]
  }
  return [
    { name: 'workspaceId', role: 'HASH', type: 'S' },
    { name: 'recordKey', role: 'RANGE', type: 'S' },
  ]
}

/**
 * Removes adapter-owned time from one complete v2 pure input.
 *
 * @param input - Complete validated fixture input.
 * @returns Publication input without sealedAt.
 */
function omitSealedAt(
  input: CreateWorkspaceSearchMigrationSealedPlanningAuthorityV2Input,
): PublishWorkspaceSearchMigrationSealedPlanningAuthorityV2Input {
  return {
    runId: input.runId,
    configuration: input.configuration,
    configurationHash: input.configurationHash,
    planSeal: input.planSeal,
    planSealReference: input.planSealReference,
    planManifestHead: input.planManifestHead,
    planManifestHeadReference: input.planManifestHeadReference,
    planningProvenanceManifestHead:
      input.planningProvenanceManifestHead,
    planningProvenanceManifestHeadReference:
      input.planningProvenanceManifestHeadReference,
    planningAuthorityProvenance:
      input.planningAuthorityProvenance,
    sourceProgress: input.sourceProgress,
    targetProgress: input.targetProgress,
    currentAuthority: input.currentAuthority,
  }
}

/**
 * Creates one fixed clock.
 *
 * @param timestamp - Canonical time returned for every sample.
 * @returns Trusted fixed clock.
 */
function createFixedClock(timestamp: string): () => Date {
  return () => new Date(timestamp)
}

/**
 * Creates one finite sequence clock and records every sample.
 *
 * @param events - Shared lifecycle trace.
 * @param timestamps - Exact sample sequence.
 * @returns Trusted finite clock.
 */
function createSequencedClock(
  events: string[],
  timestamps: readonly string[],
): () => Date {
  let index = 0
  return () => {
    events.push('clock')
    const timestamp = timestamps[index]
    index += 1
    if (timestamp === undefined) {
      throw new Error('Clock fixture exhausted.')
    }
    return new Date(timestamp)
  }
}

/**
 * Creates one cancellation with a reason at a fixed transaction index.
 *
 * @param index - Fixed transaction item index.
 * @param code - Stable DynamoDB cancellation reason.
 * @returns Raw SDK cancellation fixture.
 */
function createCancellation(
  index: number,
  code: string,
): TransactionCanceledException {
  const reasons = Array.from(
    {
      length:
        workspaceSearchMigrationSealedPlanningAuthorityV2TransactionIndex
          .count,
    },
    () => ({ Code: 'None' }),
  )
  const reason = reasons[index]
  if (reason === undefined) {
    throw new Error('Cancellation fixture index is out of range.')
  }
  reason.Code = code
  return new TransactionCanceledException({
    $metadata: {},
    CancellationReasons: reasons,
    message: 'redacted fixture',
  })
}

/**
 * Creates one Error with a stable adapter-classified name.
 *
 * @param name - Stable error name.
 * @returns Named error fixture.
 */
function createNamedError(name: string): Error {
  const error = new Error('redacted fixture')
  error.name = name
  return error
}

/**
 * Creates one Node.js transport error with a stable network code.
 *
 * @param code - Stable Node.js transport code.
 * @returns Coded error fixture.
 */
function createCodedError(code: string): Error {
  const error = new Error('redacted fixture')
  Reflect.set(error, 'code', code)
  return error
}

/**
 * Captures one public stable migration failure.
 *
 * @param operation - Expected failing operation.
 * @returns Public migration failure.
 */
async function captureMigrationFailure(
  operation: () => Promise<unknown>,
): Promise<WorkspaceSearchMigrationFailure> {
  try {
    await operation()
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationFailure) return error
    throw error
  }
  throw new Error('Expected migration failure.')
}

/**
 * Requires one recorded transaction command.
 *
 * @param command - Candidate command.
 * @returns Complete transaction command.
 */
function requireTransaction(
  command: TransactWriteItemsCommand | undefined,
): TransactWriteItemsCommand {
  if (command === undefined) {
    throw new Error('Expected one publication transaction.')
  }
  return command
}

/**
 * Requires one complete immutable root Put.
 *
 * @param item - Candidate transaction item.
 * @returns Complete low-level Put action.
 */
function requireRootPut(
  item: TransactWriteItem | undefined,
): NonNullable<TransactWriteItem['Put']> {
  if (item?.Put === undefined) {
    throw new Error('Expected immutable root Put.')
  }
  return item.Put
}

/**
 * Requires the complete attribute map carried by a root Put.
 *
 * @param put - Complete low-level Put action.
 * @returns Exact immutable publication item.
 */
function requirePutItem(
  put: NonNullable<TransactWriteItem['Put']>,
): Readonly<Record<string, AttributeValue>> {
  if (put.Item === undefined) {
    throw new Error('Expected immutable root item.')
  }
  return put.Item
}

/**
 * Reads one strict low-level string attribute.
 *
 * @param item - Complete low-level item.
 * @param name - Attribute name.
 * @returns Exact string value.
 */
function requireStringAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): string {
  const value = item[name]?.S
  if (value === undefined) {
    throw new Error('Expected string attribute.')
  }
  return value
}

/**
 * Reads one strict low-level binary attribute.
 *
 * @param item - Complete low-level item.
 * @param name - Attribute name.
 * @returns Exact binary value.
 */
function requireBinaryAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): Uint8Array {
  const value = item[name]?.B
  if (value === undefined) {
    throw new Error('Expected binary attribute.')
  }
  return new Uint8Array(value)
}

/**
 * Creates one deterministic lowercase SHA-256 fixture digest.
 *
 * @param label - Stable fixture label.
 * @returns Lowercase SHA-256 digest.
 */
function digest(label: string): string {
  return createMigrationDigest(label)
}

/**
 * Digests exact bytes without JSON reinterpretation.
 *
 * @param bytes - Exact canonical bytes.
 * @returns Lowercase SHA-256 digest.
 */
function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
