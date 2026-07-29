import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import type {
  AttributeValue,
  TransactWriteItem,
} from '@aws-sdk/client-dynamodb'
import {
  serializeWorkspaceSearchPlanSeal,
} from './migration-artifacts'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  type MigrationKeyAttribute,
  type MigrationTableIdentity,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchOperationReceipt,
  type WorkspaceSearchPlanSeal,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationApplyRunBindingDigest,
} from './migration-applied-root-aws'
import {
  createWorkspaceSearchMigrationApplyReceiptAwsBinding,
  type WorkspaceSearchMigrationApplyMarkerReceiptAwsProjection,
  type WorkspaceSearchMigrationApplyReceiptAwsBindingInput,
  type WorkspaceSearchMigrationApplySequenceReceiptAwsProjection,
} from './migration-apply-receipt-aws'
import {
  parseWorkspaceSearchMigrationExecutionRun,
  serializeWorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRunBinding,
} from './migration-execution-run'
import {
  serializeWorkspaceSearchMigrationOperationMarker,
  WORKSPACE_SEARCH_MIGRATION_EXECUTION_STATE_MAX_BYTES,
} from './migration-execution-state'
import {
  WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
} from './migration-plan-artifact'
import {
  createWorkspaceSearchMigrationRunState,
} from './migration-state-machine'

const runId = 'apply-receipt-aws-test'
const ownerId = 'apply-receipt-owner'
const planCreatedAt = '2026-07-29T01:17:00.000Z'
const createdAt = '2026-07-29T01:20:00.000Z'
const committedAt = '2026-07-29T01:20:10.000Z'
const retainUntil = '2026-08-30T01:20:00.000Z'
const applyReceiptRecordVersion = 1
const operationMarkerRecordKind =
  'workspace-search-migration-apply-operation-marker'
const journalSequenceRecordKind =
  'workspace-search-migration-apply-journal-sequence'

/**
 * Complete correlated apply-receipt persistence fixture.
 */
type ApplyReceiptAwsFixture = {
  /** Complete measured migration configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed digest of the measured configuration. */
  readonly configurationHash: string
  /** Exact immutable execution admission. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun
  /** First canonical mutating operation receipt. */
  readonly receipt: WorkspaceSearchOperationReceipt
  /** Second independently valid mutating operation receipt. */
  readonly otherReceipt: WorkspaceSearchOperationReceipt
  /** Strict metadata shared by both rows for the first receipt. */
  readonly sequenceProjection:
    WorkspaceSearchMigrationApplySequenceReceiptAwsProjection
  /** Strict metadata shared by both rows for the first receipt. */
  readonly markerProjection:
    WorkspaceSearchMigrationApplyMarkerReceiptAwsProjection
}

/**
 * Existing apply-adapter schema rows built independently of the new boundary.
 */
type CurrentApplyReceiptRows = {
  /** Existing version-one journal-sequence row. */
  readonly sequence: Readonly<Record<string, AttributeValue>>
  /** Existing version-one operation-marker row. */
  readonly marker: Readonly<Record<string, AttributeValue>>
}

describe('Workspace Search apply-receipt AWS boundary', () => {
  test(
    'returns a fresh frozen binding identity using the official apply namespace formula',
    () => {
      const fixture = createFixture()
      const input = createBindingInput(fixture)
      const binding =
        createWorkspaceSearchMigrationApplyReceiptAwsBinding(input)
      const first = binding.readBindingIdentity()
      const second = binding.readBindingIdentity()
      const expected = {
        stateTableId: input.stateTable.tableId,
        configurationHash: input.configurationHash,
        runId: input.executionRun.runId,
        executionRunDigest:
          input.executionRun.executionRunDigest,
        bindingDigest:
          createWorkspaceSearchMigrationApplyRunBindingDigest(input),
      }

      expect(first).toEqual(expected)
      expect(second).toEqual(expected)
      expect(first).not.toBe(second)
      expect(Object.isFrozen(first)).toBe(true)
      expect(Object.isFrozen(second)).toBe(true)
      expect(Reflect.set(first, 'runId', 'foreign-run')).toBe(false)
      expect(first).toEqual(expected)
      expect(binding.readBindingIdentity()).toEqual(expected)
    },
  )

  test(
    'reads and correlates the current apply schema and deterministic keys',
    () => {
      const fixture = createFixture()
      const input = createBindingInput(fixture)
      const binding =
        createWorkspaceSearchMigrationApplyReceiptAwsBinding(input)
      const rows = createCurrentApplyReceiptRows(
        fixture,
        fixture.sequenceProjection,
      )
      const expectedKeys = createCurrentApplyReceiptKeys(
        fixture,
        fixture.receipt,
      )

      expect(
        binding.createJournalSequenceStrongReadCommand(1).input,
      ).toEqual({
        TableName:
          fixture.configuration.tables['migration-state']
            .tableName,
        ConsistentRead: true,
        Key: expectedKeys.sequence,
      })
      expect(
        binding.createOperationMarkerStrongReadCommand(
          fixture.receipt.operationId,
        ).input,
      ).toEqual({
        TableName:
          fixture.configuration.tables['migration-state']
            .tableName,
        ConsistentRead: true,
        Key: expectedKeys.marker,
      })
      expect(
        readRecordKey(expectedKeys.sequence),
      ).toMatch(
        /^apply-journal-sequence\/v1\/[0-9a-f]{64}\/receipt$/u,
      )
      expect(
        readRecordKey(expectedKeys.marker),
      ).toMatch(
        /^apply-operation\/v1\/[0-9a-f]{64}\/marker$/u,
      )

      const sequence =
        binding.parseJournalSequenceStrongReadOutput(
          1,
          { Item: rows.sequence },
        )
      const marker =
        binding.parseOperationMarkerStrongReadOutput(
          fixture.receipt.operationId,
          { Item: rows.marker },
        )
      expect(sequence).toEqual(fixture.sequenceProjection)
      expect(marker).toEqual(fixture.markerProjection)
      if (sequence === undefined || marker === undefined) {
        throw new Error('Expected both immutable apply rows.')
      }
      expect(binding.correlateRows(sequence, marker)).toEqual(
        fixture.sequenceProjection,
      )
      expect(
        binding.parseJournalSequenceStrongReadOutput(1, {}),
      ).toBeUndefined()
      expect(
        binding.parseOperationMarkerStrongReadOutput(
          fixture.receipt.operationId,
          {},
        ),
      ).toBeUndefined()
    },
  )

  test(
    'pairs every controlled sequence and marker field in strict conditions',
    () => {
      const fixture = createFixture()
      const binding =
        createWorkspaceSearchMigrationApplyReceiptAwsBinding(
          createBindingInput(fixture),
        )
      const rows = createCurrentApplyReceiptRows(
        fixture,
        fixture.sequenceProjection,
      )

      expectFullRowCondition(
        binding.createJournalSequenceConditionCheck(
          fixture.sequenceProjection,
        ),
        rows.sequence,
        fixture.configuration.tables['migration-state']
          .tableName,
      )
      expectFullRowCondition(
        binding.createOperationMarkerConditionCheck(
          fixture.markerProjection,
        ),
        rows.marker,
        fixture.configuration.tables['migration-state']
          .tableName,
      )
    },
  )

  test(
    'rejects foreign table, configuration, run, execution, sequence, and operation identities',
    () => {
      const fixture = createFixture()
      const input = createBindingInput(fixture)
      const binding =
        createWorkspaceSearchMigrationApplyReceiptAwsBinding(input)
      const rows = createCurrentApplyReceiptRows(
        fixture,
        fixture.sequenceProjection,
      )
      const cases: readonly {
        /** Secret-free case label. */
        readonly label: string
        /** Substituted current-schema row. */
        readonly row: Readonly<Record<string, AttributeValue>>
        /** Whether the row is a sequence row. */
        readonly sequence: boolean
      }[] = [
        {
          label: 'stateTable',
          row: {
            ...rows.sequence,
            stateTableId: { S: 'foreign-state-table-id' },
          },
          sequence: true,
        },
        {
          label: 'configuration',
          row: {
            ...rows.sequence,
            configurationHash: {
              S: digest('foreign-configuration'),
            },
          },
          sequence: true,
        },
        {
          label: 'run',
          row: {
            ...rows.sequence,
            runId: { S: 'foreign-run' },
          },
          sequence: true,
        },
        {
          label: 'executionRun',
          row: {
            ...rows.sequence,
            executionRunDigest: {
              S: digest('foreign-execution-run'),
            },
          },
          sequence: true,
        },
        {
          label: 'sequence',
          row: {
            ...rows.sequence,
            sequence: { N: '2' },
          },
          sequence: true,
        },
        {
          label: 'operationId',
          row: {
            ...rows.marker,
            operationId: {
              S: fixture.otherReceipt.operationId,
            },
          },
          sequence: false,
        },
      ]
      for (const entry of cases) {
        const failure = entry.sequence
          ? captureFailure(() =>
              binding.parseJournalSequenceStrongReadOutput(
                1,
                { Item: entry.row },
              )
            )
          : captureFailure(() =>
              binding.parseOperationMarkerStrongReadOutput(
                fixture.receipt.operationId,
                { Item: entry.row },
              )
            )
        expect(
          failure.code,
          `Expected ${entry.label} substitution to fail.`,
        ).toBe('INVALID_STATE')
      }

      expect(
        captureFailure(() =>
          createWorkspaceSearchMigrationApplyReceiptAwsBinding({
            ...input,
            configurationHash: digest('foreign-binding-config'),
          })
        ).code,
      ).toBe('CONFIGURATION_DRIFT')
      expect(
        captureFailure(() =>
          createWorkspaceSearchMigrationApplyReceiptAwsBinding({
            ...input,
            stateTable: {
              ...input.stateTable,
              tableId: 'foreign-binding-state-table',
            },
          })
        ).code,
      ).toBe('CONFIGURATION_DRIFT')

      const foreignExecutionRun = createExecutionRun(
        fixture.configuration,
        fixture.configurationHash,
        'foreign-apply-receipt-run',
      )
      const foreignBinding =
        createWorkspaceSearchMigrationApplyReceiptAwsBinding({
          ...input,
          executionRun: foreignExecutionRun,
        })
      expect(
        captureFailure(() =>
          foreignBinding.parseJournalSequenceStrongReadOutput(
            1,
            { Item: rows.sequence },
          )
        ).code,
      ).toBe('INVALID_STATE')
    },
  )

  test(
    'rejects row substitution and cross-row mismatch fail closed',
    () => {
      const fixture = createFixture()
      const binding =
        createWorkspaceSearchMigrationApplyReceiptAwsBinding(
          createBindingInput(fixture),
        )
      const rows = createCurrentApplyReceiptRows(
        fixture,
        fixture.sequenceProjection,
      )
      const substitutions: readonly Readonly<
        Record<string, AttributeValue>
      >[] = [
        {
          ...rows.sequence,
          operationMarkerRecordKey: {
            S: 'apply-operation/v1/foreign/marker',
          },
        },
        {
          ...rows.sequence,
          planOperationDigest: {
            S: digest('foreign-plan-operation'),
          },
        },
        {
          ...rows.sequence,
          markerDigest: { S: digest('foreign-marker') },
        },
        {
          ...rows.sequence,
          successorRevision: { N: '4' },
        },
        {
          ...rows.sequence,
          markerBytes: {
            B: serializeWorkspaceSearchMigrationOperationMarker(
              fixture.otherReceipt,
            ),
          },
        },
      ]
      for (const row of substitutions) {
        expect(
          captureFailure(() =>
            binding.parseJournalSequenceStrongReadOutput(
              1,
              { Item: row },
            )
          ).code,
        ).toBe('INVALID_STATE')
      }

      const substitutedSequence =
        binding.parseJournalSequenceStrongReadOutput(
          1,
          {
            Item: {
              ...rows.sequence,
              successorExecutionStateDigest: {
                S: digest('foreign-successor-state'),
              },
            },
          },
        )
      const originalMarker =
        binding.parseOperationMarkerStrongReadOutput(
          fixture.receipt.operationId,
          { Item: rows.marker },
        )
      if (
        substitutedSequence === undefined ||
        originalMarker === undefined
      ) {
        throw new Error('Expected strict substituted rows.')
      }
      expect(
        captureFailure(() =>
          binding.correlateRows(
            substitutedSequence,
            originalMarker,
          )
        ).code,
      ).toBe('INVALID_STATE')

      const otherProjection = createSequenceProjection(
        fixture.otherReceipt,
        2,
        3,
      )
      const otherRows = createCurrentApplyReceiptRows(
        fixture,
        otherProjection,
      )
      const sequence =
        binding.parseJournalSequenceStrongReadOutput(
          1,
          { Item: rows.sequence },
        )
      const otherMarker =
        binding.parseOperationMarkerStrongReadOutput(
          fixture.otherReceipt.operationId,
          { Item: otherRows.marker },
        )
      if (sequence === undefined || otherMarker === undefined) {
        throw new Error('Expected strict mismatched rows.')
      }
      expect(
        captureFailure(() =>
          binding.correlateRows(sequence, otherMarker)
        ).code,
      ).toBe('INVALID_STATE')
    },
  )

  test(
    'rejects extra attributes, operationId mismatches, Proxies, and accessors without reading them',
    () => {
      const fixture = createFixture()
      const binding =
        createWorkspaceSearchMigrationApplyReceiptAwsBinding(
          createBindingInput(fixture),
        )
      const rows = createCurrentApplyReceiptRows(
        fixture,
        fixture.sequenceProjection,
      )
      expect(
        captureFailure(() =>
          binding.parseJournalSequenceStrongReadOutput(
            1,
            {
              Item: {
                ...rows.sequence,
                unexpected: { S: 'not-controlled' },
              },
            },
          )
        ).code,
      ).toBe('INVALID_STATE')
      expect(
        captureFailure(() =>
          binding.parseJournalSequenceStrongReadOutput(
            1,
            {
              Item: {
                ...rows.sequence,
                operationId: { S: 'x'.repeat(400 * 1024) },
              },
            },
          )
        ).code,
      ).toBe('INVALID_STATE')

      let proxyReads = 0
      const proxyOutput = new Proxy({}, {
        get: () => {
          proxyReads += 1
          return undefined
        },
      })
      expect(
        captureFailure(() =>
          binding.parseJournalSequenceStrongReadOutput(
            1,
            proxyOutput,
          )
        ).code,
      ).toBe('INVALID_STATE')
      expect(proxyReads).toBe(0)

      let outputAccessorReads = 0
      const accessorOutput = {}
      Object.defineProperty(accessorOutput, 'Item', {
        configurable: true,
        enumerable: true,
        get: () => {
          outputAccessorReads += 1
          return rows.sequence
        },
      })
      expect(
        captureFailure(() =>
          binding.parseJournalSequenceStrongReadOutput(
            1,
            accessorOutput,
          )
        ).code,
      ).toBe('INVALID_STATE')
      expect(outputAccessorReads).toBe(0)

      let rowAccessorReads = 0
      const accessorRow = { ...rows.sequence }
      Object.defineProperty(accessorRow, 'markerDigest', {
        configurable: true,
        enumerable: true,
        get: () => {
          rowAccessorReads += 1
          return rows.sequence.markerDigest
        },
      })
      expect(
        captureFailure(() =>
          binding.parseJournalSequenceStrongReadOutput(
            1,
            { Item: accessorRow },
          )
        ).code,
      ).toBe('INVALID_STATE')
      expect(rowAccessorReads).toBe(0)
    },
  )

  test(
    'rejects hostile binding and projection shapes with stable secret-free errors',
    () => {
      const fixture = createFixture()
      const input = createBindingInput(fixture)
      let bindingAccessorReads = 0
      const hostileBinding = { ...input }
      Object.defineProperty(hostileBinding, 'configurationHash', {
        configurable: true,
        enumerable: true,
        get: () => {
          bindingAccessorReads += 1
          return fixture.configurationHash
        },
      })
      const bindingFailure = captureFailure(() =>
        Reflect.apply(
          createWorkspaceSearchMigrationApplyReceiptAwsBinding,
          undefined,
          [hostileBinding],
        )
      )
      expect(bindingFailure.code).toBe('INVALID_ARGUMENT')
      expect(bindingFailure.message).toBe(
        'Workspace Search migration apply receipt persistence failed.',
      )
      expect(bindingAccessorReads).toBe(0)

      const binding =
        createWorkspaceSearchMigrationApplyReceiptAwsBinding(input)
      const hostileProjection = {
        ...fixture.sequenceProjection,
        leaked: 'must-not-be-accepted',
      }
      const projectionFailure = captureFailure(() =>
        Reflect.apply(
          binding.createJournalSequenceConditionCheck,
          binding,
          [hostileProjection],
        )
      )
      expect(projectionFailure.code).toBe('INVALID_ARGUMENT')
      expect(projectionFailure.message).not.toContain(
        fixture.receipt.operationId,
      )
    },
  )

  test(
    'rejects aliased, deep, over-budget, and wide JSON graphs before codec traversal',
    () => {
      const fixture = createFixture()
      const input = createBindingInput(fixture)
      let sharedDag: unknown = { leaf: true }
      for (let depth = 0; depth < 40; depth += 1) {
        sharedDag = {
          left: sharedDag,
          right: sharedDag,
        }
      }
      let tooDeep: unknown = null
      for (let depth = 0; depth < 66; depth += 1) {
        tooDeep = { child: tooDeep }
      }
      const overBudgetNodes = Array.from(
        { length: 1_000 },
        () => Array.from({ length: 10 }, () => 0),
      )
      const wideArray = Array.from(
        { length: 4_097 },
        () => null,
      )
      const wideObject: Record<string, null> = {}
      for (let index = 0; index < 1_025; index += 1) {
        wideObject[`field${index}`] = null
      }

      for (const hostileGraph of [
        sharedDag,
        tooDeep,
        overBudgetNodes,
        wideArray,
        wideObject,
      ]) {
        const failure = captureFailure(() =>
          Reflect.apply(
            createWorkspaceSearchMigrationApplyReceiptAwsBinding,
            undefined,
            [{
              ...input,
              executionRun: {
                ...input.executionRun,
                binding: {
                  ...input.executionRun.binding,
                  hostileGraph,
                },
              },
            }],
          )
        )
        expect(failure.code).toBe('INVALID_ARGUMENT')
        expect(failure.message).toBe(
          'Workspace Search migration apply receipt persistence failed.',
        )
      }
    },
  )

  test(
    'rejects marker binary larger than the execution-state byte limit',
    () => {
      const fixture = createFixture()
      const binding =
        createWorkspaceSearchMigrationApplyReceiptAwsBinding(
          createBindingInput(fixture),
        )
      const rows = createCurrentApplyReceiptRows(
        fixture,
        fixture.sequenceProjection,
      )
      const oversizedMarkerBytes = new Uint8Array(
        WORKSPACE_SEARCH_MIGRATION_EXECUTION_STATE_MAX_BYTES + 1,
      )

      expect(
        captureFailure(() =>
          binding.parseJournalSequenceStrongReadOutput(
            fixture.receipt.sequence,
            {
              Item: {
                ...rows.sequence,
                markerBytes: { B: oversizedMarkerBytes },
              },
            },
          )
        ).code,
      ).toBe('INVALID_STATE')
    },
  )
})

/**
 * Creates one complete correlated fixture with two planned mutations.
 *
 * @returns Exact execution binding and two strict operation receipts.
 */
function createFixture(): ApplyReceiptAwsFixture {
  const configuration = createConfiguration()
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  const executionRun = createExecutionRun(
    configuration,
    configurationHash,
    runId,
  )
  const receipt = createReceipt(
    executionRun,
    configurationHash,
    1,
  )
  const otherReceipt = createReceipt(
    executionRun,
    configurationHash,
    2,
  )
  const sequenceProjection = createSequenceProjection(
    receipt,
    1,
    2,
  )
  return {
    configuration,
    configurationHash,
    executionRun,
    receipt,
    otherReceipt,
    sequenceProjection,
    markerProjection: sequenceProjection,
  }
}

/**
 * Creates the exact public binding input used by the tests.
 *
 * @param fixture - Complete correlated apply-receipt fixture.
 * @returns Exact measured table, configuration, and execution admission.
 */
function createBindingInput(
  fixture: ApplyReceiptAwsFixture,
): WorkspaceSearchMigrationApplyReceiptAwsBindingInput {
  return {
    stateTable:
      fixture.configuration.tables['migration-state'],
    configurationHash: fixture.configurationHash,
    executionRun: fixture.executionRun,
  }
}

/**
 * Creates strict row metadata for one canonical mutating receipt.
 *
 * @param receipt - Exact canonical mutating apply receipt.
 * @param predecessorRevision - Revision condition-checked by apply.
 * @param successorRevision - Revision committed by apply.
 * @returns Detached strict sequence receipt projection.
 */
function createSequenceProjection(
  receipt: WorkspaceSearchOperationReceipt,
  predecessorRevision: number,
  successorRevision: number,
): WorkspaceSearchMigrationApplySequenceReceiptAwsProjection {
  return {
    receipt,
    predecessorRevision,
    successorRevision,
    successorExecutionStateDigest: digest(
      `successor-state:${receipt.sequence}`,
    ),
    markerDigest: createMigrationDigest(receipt),
  }
}

/**
 * Independently recreates the current private apply-adapter row schema.
 *
 * @param fixture - Exact admitted-run fixture.
 * @param projection - Exact mutating receipt and revision metadata.
 * @returns Current version-one marker and sequence rows.
 */
function createCurrentApplyReceiptRows(
  fixture: ApplyReceiptAwsFixture,
  projection: WorkspaceSearchMigrationApplySequenceReceiptAwsProjection,
): CurrentApplyReceiptRows {
  const receipt = projection.receipt
  const markerBytes =
    serializeWorkspaceSearchMigrationOperationMarker(receipt)
  const keys = createCurrentApplyReceiptKeys(fixture, receipt)
  const common = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordVersion: { N: String(applyReceiptRecordVersion) },
    stateTableId: {
      S: fixture.configuration.tables['migration-state'].tableId,
    },
    configurationHash: { S: fixture.configurationHash },
    runId: { S: fixture.executionRun.runId },
    executionRunDigest: {
      S: fixture.executionRun.executionRunDigest,
    },
    operationId: { S: receipt.operationId },
    planSequence: { N: String(receipt.planSequence) },
    planOperationDigest: { S: receipt.planOperationDigest },
    predecessorRevision: {
      N: String(projection.predecessorRevision),
    },
    successorRevision: {
      N: String(projection.successorRevision),
    },
    successorExecutionStateDigest: {
      S: projection.successorExecutionStateDigest,
    },
    markerDigest: { S: projection.markerDigest },
    markerBytes: { B: markerBytes },
  } satisfies Readonly<Record<string, AttributeValue>>
  return {
    marker: {
      migrationId: common.migrationId,
      recordKey: keys.marker.recordKey,
      kind: { S: operationMarkerRecordKind },
      recordVersion: common.recordVersion,
      stateTableId: common.stateTableId,
      configurationHash: common.configurationHash,
      runId: common.runId,
      executionRunDigest: common.executionRunDigest,
      operationId: common.operationId,
      planSequence: common.planSequence,
      planOperationDigest: common.planOperationDigest,
      predecessorRevision: common.predecessorRevision,
      successorRevision: common.successorRevision,
      successorExecutionStateDigest:
        common.successorExecutionStateDigest,
      markerDigest: common.markerDigest,
      markerBytes: common.markerBytes,
    },
    sequence: {
      migrationId: common.migrationId,
      recordKey: keys.sequence.recordKey,
      kind: { S: journalSequenceRecordKind },
      recordVersion: common.recordVersion,
      stateTableId: common.stateTableId,
      configurationHash: common.configurationHash,
      runId: common.runId,
      executionRunDigest: common.executionRunDigest,
      sequence: { N: String(receipt.sequence) },
      operationId: common.operationId,
      operationMarkerRecordKey: keys.marker.recordKey,
      planSequence: common.planSequence,
      planOperationDigest: common.planOperationDigest,
      predecessorRevision: common.predecessorRevision,
      successorRevision: common.successorRevision,
      successorExecutionStateDigest:
        common.successorExecutionStateDigest,
      markerDigest: common.markerDigest,
      markerBytes: common.markerBytes,
    },
  }
}

/**
 * Independently recreates current digest-addressed apply receipt keys.
 *
 * @param fixture - Exact admitted-run fixture.
 * @param receipt - Canonical mutating receipt.
 * @returns Exact current marker and sequence primary keys.
 */
function createCurrentApplyReceiptKeys(
  fixture: ApplyReceiptAwsFixture,
  receipt: WorkspaceSearchOperationReceipt,
): {
  /** Exact current journal-sequence primary key. */
  readonly sequence: Readonly<Record<string, AttributeValue>>
  /** Exact current operation-marker primary key. */
  readonly marker: Readonly<Record<string, AttributeValue>>
} {
  const bindingDigest =
    createWorkspaceSearchMigrationApplyRunBindingDigest(
      createBindingInput(fixture),
    )
  const markerDigest = createMigrationDigest({
    kind: 'workspace-search-apply-operation-key',
    version: applyReceiptRecordVersion,
    bindingDigest,
    operationId: receipt.operationId,
  })
  const sequenceDigest = createMigrationDigest({
    kind: 'workspace-search-apply-journal-sequence-key',
    version: applyReceiptRecordVersion,
    bindingDigest,
    sequence: receipt.sequence,
  })
  return {
    marker: {
      migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
      recordKey: {
        S: `apply-operation/v1/${markerDigest}/marker`,
      },
    },
    sequence: {
      migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
      recordKey: {
        S: `apply-journal-sequence/v1/${sequenceDigest}/receipt`,
      },
    },
  }
}

/**
 * Verifies that a condition pairs every canonical controlled field.
 *
 * @param item - Candidate DynamoDB transaction item.
 * @param record - Exact current-schema row.
 * @param tableName - Exact physical migration-state table name.
 */
function expectFullRowCondition(
  item: TransactWriteItem,
  record: Readonly<Record<string, AttributeValue>>,
  tableName: string,
): void {
  const condition = item.ConditionCheck
  if (
    condition === undefined ||
    condition.ExpressionAttributeNames === undefined ||
    condition.ExpressionAttributeValues === undefined ||
    condition.ConditionExpression === undefined
  ) {
    throw new Error('Expected one complete condition check.')
  }
  expect(condition.TableName).toBe(tableName)
  expect(condition.Key).toEqual({
    migrationId: record.migrationId,
    recordKey: record.recordKey,
  })
  expect(condition.ReturnValuesOnConditionCheckFailure).toBe('NONE')
  const controlledNames = Object.keys(record)
    .filter(
      (name) => name !== 'migrationId' && name !== 'recordKey',
    )
    .sort(compareUtf8Ordinal)
  expect(
    Object.values(condition.ExpressionAttributeNames)
      .sort(compareUtf8Ordinal),
  ).toEqual(controlledNames)
  expect(
    condition.ConditionExpression.split(' AND '),
  ).toHaveLength(controlledNames.length)
  for (const [token, name] of Object.entries(
    condition.ExpressionAttributeNames,
  )) {
    const index = token.replace('#field', '')
    expect(
      condition.ExpressionAttributeValues[`:value${index}`],
    ).toEqual(record[name])
  }
}

/**
 * Reads the exact string sort key from one test primary key.
 *
 * @param key - Exact low-level DynamoDB key.
 * @returns Exact string sort-key value.
 */
function readRecordKey(
  key: Readonly<Record<string, AttributeValue>>,
): string {
  const value = key.recordKey?.S
  if (value === undefined) {
    throw new Error('Expected one string record key.')
  }
  return value
}

/**
 * Creates one strict mutating apply receipt.
 *
 * @param executionRun - Exact immutable execution admission.
 * @param configurationHash - Reviewed configuration digest.
 * @param sequence - One-based plan and journal sequence.
 * @returns Canonical version-one mutating operation receipt.
 */
function createReceipt(
  executionRun: WorkspaceSearchMigrationExecutionRun,
  configurationHash: string,
  sequence: 1 | 2,
): WorkspaceSearchOperationReceipt {
  return {
    kind: 'workspace-search-operation-applied',
    markerVersion: 1,
    runId: executionRun.runId,
    configurationHash,
    operationId: digest(`operation:${sequence}`),
    planSequence: sequence,
    planOperationDigest: digest(`plan-operation:${sequence}`),
    sequence,
    targetKeyDigest: digest(`target-key:${sequence}`),
    sourceDigest: digest(`source:${sequence}`),
    beforeDigest: digest(`before:${sequence}`),
    afterDigest: digest(`after:${sequence}`),
    fenceToken: 7,
    maintenanceEvidenceReceiptDigest:
      executionRun.binding.currentAuthority
        .maintenanceEvidenceReceiptDigest,
    journal: {
      objectKey:
        `workspace-search/v1/journal/${sequence}.segment`,
      versionId: `journal-version-${sequence}`,
      contentDigest: digest(`journal-content:${sequence}`),
      byteLength: 512,
      retainUntil,
      headDigest: digest(`journal-head:${sequence}`),
    },
    committedAt:
      sequence === 1
        ? committedAt
        : '2026-07-29T01:20:20.000Z',
  }
}

/**
 * Creates one internally consistent revision-one execution admission.
 *
 * @param configuration - Exact measured configuration.
 * @param configurationHash - Reviewed configuration digest.
 * @param selectedRunId - Operator-selected run identifier.
 * @returns Detached strict execution-run envelope.
 */
function createExecutionRun(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  selectedRunId: string,
): WorkspaceSearchMigrationExecutionRun {
  const planSeal = createPlanSeal(
    selectedRunId,
    configurationHash,
  )
  const planSealBytes = serializeWorkspaceSearchPlanSeal(planSeal)
  const planSealDigest = digestBytes(planSealBytes)
  const planSealReference = {
    objectKey:
      `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/plan-seals/${planSealDigest}.artifact`,
    versionId: 'plan-seal-version',
    contentDigest: planSealDigest,
    byteLength: planSealBytes.byteLength,
    retainUntil,
  }
  const receipt = createMaintenanceReceipt(selectedRunId)
  const lease = {
    runId: selectedRunId,
    ownerId,
    fenceToken: 7,
    heartbeatAt: '2026-07-29T01:19:30.000Z',
    expiresAt: '2026-07-29T01:20:30.000Z',
  }
  const runState = createWorkspaceSearchMigrationRunState({
    runId: selectedRunId,
    lease,
    ownerId,
    configurationHash,
    configuration,
    maintenanceEvidenceReceipt: receipt,
    dryRunEvidenceDigest: planSeal.dryRunEvidenceDigest,
    planDigest: planSeal.planDigest,
    planOperationCount: planSeal.planOperationCount,
    planSeal,
    planSealReference: {
      objectKey: planSealReference.objectKey,
      versionId: planSealReference.versionId,
      contentDigest: planSealReference.contentDigest,
    },
    createdAt,
  })
  const bindingFields = {
    kind: 'workspace-search-migration-execution-run-binding',
    bindingVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: selectedRunId,
    configurationHash,
    tableIds: createTableIds(configuration),
    executionBoundaryDigest: digest(
      `execution-boundary:${selectedRunId}`,
    ),
    closedWriterFenceRecordDigest: digest(
      `closed-fence:${selectedRunId}`,
    ),
    sealedPlanningAuthorityDigest: digest(
      `sealed-authority:${selectedRunId}`,
    ),
    planDigest: planSeal.planDigest,
    planOperationCount: planSeal.planOperationCount,
    planSealReference,
    currentAuthority: {
      ownerId,
      fenceToken: lease.fenceToken,
      maintenanceEvidencePointerRevision: 12,
      maintenanceEvidenceReceiptDigest:
        createMigrationDigest(receipt),
      evaluatedAt: '2026-07-29T01:19:45.000Z',
    },
    planningAdmittedAt: '2026-07-29T01:18:00.000Z',
    sealedAt: '2026-07-29T01:19:00.000Z',
    createdAt,
  } satisfies Omit<
    WorkspaceSearchMigrationExecutionRunBinding,
    'bindingDigest'
  >
  const executionBinding: WorkspaceSearchMigrationExecutionRunBinding = {
    ...bindingFields,
    bindingDigest: createMigrationDigest(bindingFields),
  }
  const envelopeFields = {
    kind: 'workspace-search-migration-execution-run',
    executionRunVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: selectedRunId,
    configurationHash,
    revision: 1,
    status: 'applying',
    binding: executionBinding,
    runState,
    stateDigest: createMigrationDigest(runState),
  } satisfies Omit<
    WorkspaceSearchMigrationExecutionRun,
    'executionRunDigest'
  >
  const executionRun: WorkspaceSearchMigrationExecutionRun = {
    ...envelopeFields,
    executionRunDigest: createMigrationDigest(envelopeFields),
  }
  return parseWorkspaceSearchMigrationExecutionRun(
    serializeWorkspaceSearchMigrationExecutionRun(executionRun),
  )
}

/**
 * Creates one strict two-operation plan seal.
 *
 * @param selectedRunId - Operator-selected run identifier.
 * @param configurationHash - Reviewed configuration digest.
 * @returns Exact canonical two-operation plan seal.
 */
function createPlanSeal(
  selectedRunId: string,
  configurationHash: string,
): WorkspaceSearchPlanSeal {
  return {
    kind: 'workspace-search-plan-seal',
    sealVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: selectedRunId,
    configurationHash,
    dryRunEvidenceDigest: digest('dry-run'),
    planningSnapshotDigest: digest('planning-snapshot'),
    planDigest: digest('two-operation-plan'),
    planOperationCount: 2,
    sourceOperationCount: 2,
    orphanOperationCount: 0,
    createdAt: planCreatedAt,
  }
}

/**
 * Creates one exact-window maintenance receipt.
 *
 * @param selectedRunId - Operator-selected run identifier.
 * @returns Exact maintenance receipt bound to fence seven.
 */
function createMaintenanceReceipt(
  selectedRunId: string,
): WorkspaceSearchMaintenanceEvidenceReceipt {
  return {
    runId: selectedRunId,
    evidenceDigest: digest('maintenance-evidence'),
    evidenceLocator:
      'workspace-search/v1/maintenance/current.json',
    runtimeRevision: 41,
    fenceToken: 7,
    validatedAt: '2026-07-29T01:19:00.000Z',
    oldestObservationAt: '2026-07-29T01:16:00.000Z',
    validUntil: '2026-07-29T01:21:00.001Z',
  }
}

/**
 * Creates one complete measured migration configuration.
 *
 * @returns Stable measured configuration.
 */
function createConfiguration():
WorkspaceSearchMigrationConfiguration {
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
      'project-directory':
        createSourceTable('project-directory'),
      'work-items': createSourceTable('work-items'),
      collaboration: createSourceTable('collaboration'),
      documents: createSourceTable('documents'),
      'workspace-search':
        createSupportingTable('workspace-search'),
      'migration-state':
        createSupportingTable('migration-state'),
    },
    journal: {
      bucketName:
        'mukuroji-workspace-search-migration-journal',
      keyArn:
        'arn:aws:kms:ap-northeast-1:123456789012:key/00000000-0000-0000-0000-000000000001',
      keyCreationTime: '2026-01-01T00:00:00.000Z',
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
 * Creates one measured source table.
 *
 * @param role - Logical source role.
 * @returns Complete source table identity.
 */
function createSourceTable(
  role: WorkspaceSearchMigrationSourceName,
): MigrationTableIdentity {
  return createTable(role, sourceKeyDescriptors(role), false)
}

/**
 * Creates one measured target or migration-state table.
 *
 * @param role - Supporting table role.
 * @returns Complete supporting table identity.
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
 * @param role - Logical table role.
 * @param key - Exact base-table key schema.
 * @param deletionProtection - Measured deletion-protection status.
 * @returns Complete immutable table identity.
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
 * Returns the source primary-key schema for one role.
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
      { name: 'projectId', role: 'HASH', type: 'S' },
      { name: 'workItemId', role: 'RANGE', type: 'S' },
    ]
  }
  if (role === 'collaboration') {
    return [
      { name: 'workspaceId', role: 'HASH', type: 'S' },
      { name: 'collaborationKey', role: 'RANGE', type: 'S' },
    ]
  }
  return [
    { name: 'workspaceId', role: 'HASH', type: 'S' },
    { name: 'documentId', role: 'RANGE', type: 'S' },
  ]
}

/**
 * Projects all six exact measured TableIds.
 *
 * @param configuration - Complete measured configuration.
 * @returns Role-indexed immutable table identifiers.
 */
function createTableIds(
  configuration: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchMigrationExecutionRunBinding['tableIds'] {
  return {
    'project-directory':
      configuration.tables['project-directory'].tableId,
    'work-items': configuration.tables['work-items'].tableId,
    collaboration: configuration.tables.collaboration.tableId,
    documents: configuration.tables.documents.tableId,
    'workspace-search':
      configuration.tables['workspace-search'].tableId,
    'migration-state':
      configuration.tables['migration-state'].tableId,
  }
}

/**
 * Captures one public migration failure.
 *
 * @param operation - Expected failing synchronous operation.
 * @returns Stable public migration failure.
 */
function captureFailure(
  operation: () => unknown,
): WorkspaceSearchMigrationFailure {
  try {
    operation()
  } catch (error: unknown) {
    if (error instanceof WorkspaceSearchMigrationFailure) {
      return error
    }
    throw error
  }
  throw new Error('Expected WorkspaceSearchMigrationFailure.')
}

/**
 * Creates a deterministic test digest.
 *
 * @param value - Stable test label.
 * @returns Lowercase SHA-256 digest.
 */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Creates a SHA-256 digest of exact bytes.
 *
 * @param bytes - Exact canonical bytes.
 * @returns Lowercase SHA-256 digest.
 */
function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Orders strings by exact UTF-8 bytes.
 *
 * @param left - Left operand.
 * @param right - Right operand.
 * @returns Negative, zero, or positive ordering value.
 */
function compareUtf8Ordinal(
  left: string,
  right: string,
): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}
